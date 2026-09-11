#!/usr/bin/env python3
"""
Vuelca a Firestore cuántas descargas lleva cada app, para verlo en la tarjeta
del repo sin entrar a Play Console ni a App Store Connect.

  · Google Play  → informes de Play Console (CSV mensuales en el bucket
                   `gs://pubsite_prod_…` de la cuenta de desarrollador). Las
                   instalaciones no salen por ninguna API: la Reporting API solo
                   expone vitals y la Developer API, publicación. De ahí sale el
                   acumulado histórico, el mes reciente y cuántos dispositivos la
                   tienen hoy. Escribe `playInstalls/{package}`.
  · App Store    → App Store Connect Analytics Reports ("App Downloads
                   Standard"). Apple no expone un total: entrega reportes por
                   periodo que hay que pedir, esperar y descargar. Se guardan
                   los meses ya sumados en `appStoreInstalls/{bundleId}` y en
                   cada corrida solo se bajan los que faltan.

Corre en .github/workflows/store-installs-sync.yml (una vez al día): un total de
descargas no cambia de un minuto a otro, y los reportes de Apple pesan.

Variables de entorno: las mismas que los otros syncs de tienda
(FIRESTORE_TOKEN, PLAY_SA_JSON, ASC_*, GCP_PROJECT). Las credenciales se
resuelven POR PROYECTO igual que en play_tracks_sync.py.
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

import jwt  # PyJWT
import requests

from store_credentials import app_store_connect_for, play_reports_bucket_for, play_service_account_for

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"
ASC_BASE = "https://api.appstoreconnect.apple.com/v1"
PLAY_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only"

# Cuántos informes mensuales se bajan. El total histórico sale de una columna
# acumulada del último, así que estos meses solo alimentan el desglose reciente.
MESES_PLAY = 3

# Nombre del reporte de Apple con las descargas. Es el "estándar": el detallado
# trae las mismas cuentas partidas en más dimensiones, y aquí solo se suman.
ASC_REPORT = "App Downloads Standard"


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


def hoy() -> date:
    return datetime.now(timezone.utc).date()


# --- Firestore ---------------------------------------------------------------

def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def list_apps(token: str) -> list[dict]:
    """Proyectos marcados como app, con su package Android y/o bundle iOS."""
    out: list[dict] = []
    page = None
    while True:
        params = {"pageSize": 200}
        if page:
            params["pageToken"] = page
        r = requests.get(f"{FS_BASE}/projects", headers=fs_headers(token), params=params, timeout=30)
        if r.status_code != 200:
            fail(f"Firestore projects: {r.status_code} {r.text[:300]}")
        data = r.json()
        for doc in data.get("documents", []):
            f = doc.get("fields", {})
            if not f.get("isApp", {}).get("booleanValue"):
                continue
            pkg = f.get("androidPackage", {}).get("stringValue")
            bundle = f.get("iosBundleId", {}).get("stringValue")
            if pkg or bundle:
                out.append({
                    "projectId": doc["name"].rsplit("/", 1)[-1],
                    "package": pkg,
                    "bundleId": bundle,
                })
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def read_raw(token: str, coleccion: str, doc_id: str) -> dict:
    """`raw` del documento anterior, para no volver a bajar lo ya sumado."""
    r = requests.get(
        f"{FS_BASE}/{coleccion}/{quote(doc_id, safe='')}",
        headers=fs_headers(token), timeout=30,
    )
    if r.status_code != 200:
        return {}
    crudo = ((r.json().get("fields") or {}).get("raw") or {}).get("stringValue")
    try:
        cargado = json.loads(crudo) if crudo else {}
    except json.JSONDecodeError:
        return {}
    return cargado if isinstance(cargado, dict) else {}


def write_doc(token: str, coleccion: str, doc_id: str, clave: str, project_id: str,
              payload: dict | None, error: str | None) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    body = {
        "fields": {
            clave: {"stringValue": doc_id},
            "projectId": {"stringValue": project_id},
            "updatedAt": {"timestampValue": now},
            "raw": {"stringValue": json.dumps(payload or {}, ensure_ascii=False)},
            "error": {"stringValue": error} if error else {"nullValue": None},
        }
    }
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in body["fields"])
    r = requests.patch(
        f"{FS_BASE}/{coleccion}/{quote(doc_id, safe='')}?{mask}",
        headers=fs_headers(token), json=body, timeout=30,
    )
    if r.status_code not in (200, 201):
        fail(f"Firestore write {coleccion}/{doc_id}: {r.status_code} {r.text[:300]}")


# --- Google Play -------------------------------------------------------------
#
# Las instalaciones NO están en ninguna API: la Play Developer Reporting API
# solo expone vitals (crashes, ANR…) y la Play Developer API, publicación. Lo
# único que Google entrega son los informes de Play Console, que deja como CSV
# en un bucket de Cloud Storage de la cuenta de desarrollador
# (`gs://pubsite_prod_…`). De ahí se leen, que es lo mismo que hace quien baja
# los informes a mano.

def oauth_usuario_token() -> tuple[str | None, str | None]:
    """(access token de la credencial de usuario de respaldo, error).

    Google concede el acceso al bucket de informes a quien tiene el permiso en
    Play Console… menos, por lo visto, a este service account: lleva días con
    "View app information and download bulk reports" marcado y Cloud Storage
    sigue contestando 403, incluso tras volver a invitarlo. La misma cuenta de
    Play, desde un usuario humano, lo lee sin problema.

    Así que el sync acepta unas credenciales OAuth de usuario como RESPALDO —el
    JSON de `gcloud auth application-default login`, con scope de solo lectura
    de Storage—. Se usan únicamente si el service account no puede listar el
    bucket; el día que Google lo destrabe, el service account vuelve a mandar
    sin tocar nada.
    """
    crudo = os.environ.get("PLAY_REPORTS_OAUTH", "").strip()
    if not crudo:
        return None, None
    try:
        creds = json.loads(crudo)
    except json.JSONDecodeError:
        return None, "PLAY_REPORTS_OAUTH no es un JSON válido."
    faltan = [k for k in ("client_id", "client_secret", "refresh_token") if not creds.get(k)]
    if faltan:
        return None, f"A PLAY_REPORTS_OAUTH le falta {', '.join(faltan)}."
    r = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": creds["client_id"],
            "client_secret": creds["client_secret"],
            "refresh_token": creds["refresh_token"],
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    if r.status_code != 200:
        return None, f"No se pudo renovar el token de respaldo: {r.status_code} {r.text[:200]}"
    return r.json().get("access_token"), None


def play_access_token(sa: dict) -> tuple[str | None, str | None]:
    """(token OAuth para leer el bucket de informes, error).

    Otro scope que el de play_tracks_sync.py: los informes son objetos de Cloud
    Storage, no recursos de la Play Developer API, aunque la cuenta de servicio
    sea la misma.
    """
    now = int(time.time())
    try:
        assertion = jwt.encode(
            {
                "iss": sa["client_email"],
                "scope": PLAY_SCOPE,
                "aud": sa["token_uri"],
                "iat": now,
                "exp": now + 3600,
            },
            sa["private_key"],
            algorithm="RS256",
        )
    except (KeyError, TypeError, ValueError, jwt.PyJWTError) as e:
        return None, (
            f"El service account no sirve para firmar ({type(e).__name__}: {e}). "
            "Vuelve a subir el JSON completo del service account."
        )
    r = requests.post(
        sa["token_uri"],
        data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
        timeout=30,
    )
    if r.status_code != 200:
        return None, f"No se pudo obtener token para los informes de Play: {r.status_code} {r.text[:300]}"
    return r.json()["access_token"], None


def normaliza_bucket(valor: str) -> str:
    """`gs://pubsite_prod_123/` → `pubsite_prod_123`. Se pega tal cual se copia."""
    return valor.strip().removeprefix("gs://").strip("/")


def listar_informes(token: str, bucket: str, pkg: str) -> tuple[list[str], str | None]:
    """Nombres de los CSV mensuales de instalaciones de esa app, ordenados."""
    nombres: list[str] = []
    pagina = None
    prefijo = f"stats/installs/installs_{pkg}_"
    while True:
        params = {"prefix": prefijo, "maxResults": 1000}
        if pagina:
            params["pageToken"] = pagina
        r = requests.get(
            f"https://storage.googleapis.com/storage/v1/b/{quote(bucket, safe='')}/o",
            headers={"Authorization": f"Bearer {token}"}, params=params, timeout=60,
        )
        if r.status_code != 200:
            try:
                detalle = r.json().get("error", {}).get("message", r.text[:200])
            except ValueError:
                detalle = r.text[:200]
            if r.status_code in (401, 403):
                return [], (
                    f"El service account no puede leer el bucket de informes '{bucket}'. En Play "
                    "Console → Users and permissions dale el permiso 'View app information and "
                    f"download bulk reports'. Detalle: {detalle}"
                )
            if r.status_code == 404:
                return [], (
                    f"No existe el bucket de informes '{bucket}'. Cópialo de Play Console → "
                    "Download reports → Statistics (arriba dice gs://pubsite_prod_…)."
                )
            return [], f"Cloud Storage {r.status_code}: {detalle}"
        data = r.json()
        nombres.extend(o["name"] for o in data.get("items", []) if o.get("name", "").endswith("_overview.csv"))
        pagina = data.get("nextPageToken")
        if not pagina:
            break
    return sorted(nombres), None


def bajar_informe(token: str, bucket: str, nombre: str) -> tuple[list[dict], str | None]:
    """Filas del CSV mensual. Play los escribe en UTF-16, no en UTF-8."""
    r = requests.get(
        f"https://storage.googleapis.com/storage/v1/b/{quote(bucket, safe='')}/o/{quote(nombre, safe='')}",
        headers={"Authorization": f"Bearer {token}"}, params={"alt": "media"}, timeout=120,
    )
    if r.status_code != 200:
        return [], f"No se pudo bajar {nombre}: {r.status_code}"
    crudo = r.content
    texto = crudo.decode("utf-16") if crudo[:2] in (b"\xff\xfe", b"\xfe\xff") else crudo.decode("utf-8-sig", "replace")
    return list(csv.DictReader(io.StringIO(texto))), None


def _num(fila: dict, columna: str) -> int:
    try:
        return int(float(fila.get(columna) or 0))
    except (TypeError, ValueError):
        return 0


def periodo_de(nombre: str) -> str:
    """`…/installs_com.x_202608_overview.csv` → `2026-08`."""
    crudo = nombre.rsplit("_", 2)[-2]
    return f"{crudo[:4]}-{crudo[4:]}" if len(crudo) == 6 and crudo.isdigit() else crudo


def resumen_mes(filas: list[dict], con_dias: bool) -> dict:
    """Totales del mes. `con_dias` guarda el detalle diario, para los 30 días."""
    dias = [
        {
            "fecha": (f.get("Date") or "").strip(),
            "instalaciones": _num(f, "Daily User Installs"),
            "desinstalaciones": _num(f, "Daily User Uninstalls"),
            "activos": _num(f, "Active Device Installs"),
        }
        for f in filas
        if (f.get("Date") or "").strip()
    ]
    dias.sort(key=lambda d: d["fecha"])
    resumen = {
        "instalaciones": sum(d["instalaciones"] for d in dias),
        "desinstalaciones": sum(d["desinstalaciones"] for d in dias),
        # Un total del día, no un incremento: interesa el último, no la suma.
        "activos": dias[-1]["activos"] if dias else 0,
        "ultimaFecha": dias[-1]["fecha"] if dias else "",
        "primeraFecha": dias[0]["fecha"] if dias else "",
        # `Total User Installs` sería el acumulado que publica Google, pero en
        # estos informes llega siempre en 0: se guarda por si algún día trae
        # dato, y mientras tanto el total se suma mes a mes.
        "acumuladoGoogle": max((_num(f, "Total User Installs") for f in filas), default=0),
    }
    if con_dias:
        resumen["dias"] = dias
    return resumen


def fetch_play_installs(token: str, pkg: str, bucket: str, previo: dict) -> tuple[dict | None, str | None]:
    """Descargas de Play, sumadas de los informes mensuales de Play Console.

    Los meses ya sumados se guardan en el documento: solo se vuelven a bajar el
    mes en curso y el anterior, que Play sigue completando. Así el total crece
    con la app —es el histórico— sin bajar todos los informes cada día.
    """
    nombres, error = listar_informes(token, bucket, pkg)
    if error:
        return None, error
    if not nombres:
        # No es un fallo: Play publica el primer informe mensual el mes
        # siguiente al lanzamiento, así que una app recién publicada no tiene
        # ninguno. Decirlo como error hacía sospechar del package —que está
        # bien, la ficha de esa app existe y hasta reporta descargas— y dejaba
        # la tarjeta en rojo por algo que solo es esperar al corte del mes.
        return {"pendiente": True}, None

    meses: dict[str, dict] = dict(previo.get("meses") or {})
    mes_actual = hoy().strftime("%Y-%m")
    mes_anterior = (hoy().replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
    recientes = (mes_actual, mes_anterior)

    for nombre in nombres:
        periodo = periodo_de(nombre)
        if periodo in meses and periodo not in recientes:
            continue
        filas, error = bajar_informe(token, bucket, nombre)
        if error:
            return None, error
        meses[periodo] = resumen_mes(filas, con_dias=periodo in recientes)
    # El detalle diario solo hace falta en los dos meses que se rebajan; en los
    # viejos sería peso muerto en un documento que se lee en cada tarjeta.
    for periodo, mes in meses.items():
        if periodo not in recientes:
            mes.pop("dias", None)

    if not meses:
        return None, f"Los informes de '{pkg}' llegaron vacíos: Play todavía no reporta instalaciones."

    ordenados = sorted(meses)
    ultimo = meses[ordenados[-1]]
    corte = (hoy() - timedelta(days=30)).isoformat()
    dias_recientes = [
        d for p in recientes for d in (meses.get(p, {}).get("dias") or []) if d["fecha"] >= corte
    ]
    return {
        "descargas": sum(m["instalaciones"] for m in meses.values()),
        "desinstalaciones": sum(m["desinstalaciones"] for m in meses.values()),
        "activos": ultimo["activos"],
        "descargas30d": sum(d["instalaciones"] for d in dias_recientes),
        "desinstalaciones30d": sum(d["desinstalaciones"] for d in dias_recientes),
        "desde": meses[ordenados[0]].get("primeraFecha") or ordenados[0],
        "hasta": ultimo.get("ultimaFecha") or ordenados[-1],
        "meses": meses,
        # Se cuentan todos los informes que existen, así que el total es el
        # histórico de la app, no una ventana.
        "historico": True,
    }, None


# --- App Store Connect -------------------------------------------------------

def asc_token(creds: dict) -> tuple[str | None, str | None]:
    now = int(time.time())
    try:
        return jwt.encode(
            {"iss": creds["issuer_id"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"},
            creds["private_key"].replace("\\n", "\n"),
            algorithm="ES256",
            headers={"kid": creds["key_id"], "typ": "JWT"},
        ), None
    except (KeyError, TypeError, ValueError, jwt.PyJWTError) as e:
        return None, (
            f"La llave de App Store Connect no sirve para firmar ({type(e).__name__}: {e}). "
            "Vuelve a pegar el .p8 completo, con las líneas BEGIN/END PRIVATE KEY."
        )


def asc_get(token: str, path: str, params: dict | None = None) -> tuple[dict | None, str | None]:
    r = requests.get(
        f"{ASC_BASE}/{path}", headers={"Authorization": f"Bearer {token}"}, params=params or {}, timeout=60
    )
    if r.status_code != 200:
        try:
            detalle = r.json()["errors"][0].get("detail", r.text[:200])
        except Exception:
            detalle = r.text[:200]
        return None, f"App Store Connect {r.status_code}: {detalle}"
    return r.json(), None


def asc_app_id(token: str, bundle: str) -> tuple[str | None, str | None]:
    apps, err = asc_get(token, "apps", {"filter[bundleId]": bundle, "limit": 1})
    if err:
        return None, err
    datos = apps.get("data", [])
    if not datos:
        return None, (
            f"App Store Connect no tiene ninguna app con bundle id '{bundle}'. "
            "Revisa el Bundle ID iOS del proyecto."
        )
    return datos[0]["id"], None


def asc_report_requests(token: str, app_id: str) -> tuple[list[dict], str | None]:
    """Pedidos de reporte ya existentes para la app (los crea este script)."""
    data, err = asc_get(token, f"apps/{app_id}/analyticsReportRequests", {"limit": 50})
    if err:
        return [], err
    return data.get("data", []), None


def asc_crear_pedido(token: str, app_id: str, tipo: str) -> str | None:
    """Pide a Apple que empiece a generar reportes. Devuelve el error, si hubo.

    Apple no entrega analíticas hasta que alguien las pide, y tarda ~1 día en
    tener el primer reporte listo. Por eso la primera corrida de una app deja el
    documento diciendo "Apple los está generando" en vez de un número.
    """
    r = requests.post(
        f"{ASC_BASE}/analyticsReportRequests",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "data": {
                "type": "analyticsReportRequests",
                # Solo `accessType`: `analyticsReportRequests` no tiene campo
                # `name`, y mandarlo hacía que Apple rechazara el pedido con un
                # 409 —el mismo código que usa para "ya existe"—, así que el
                # sync daba por hecho que el pedido estaba puesto y esperaba un
                # reporte que nunca se le encargó.
                "attributes": {"accessType": tipo},
                "relationships": {"app": {"data": {"type": "apps", "id": app_id}}},
            }
        },
        timeout=30,
    )
    if r.status_code in (200, 201):
        print(f"· pedido de reporte {tipo} creado en Apple")
        return None
    try:
        detalle = r.json()["errors"][0].get("detail", r.text[:300])
    except Exception:
        detalle = r.text[:300]
    # 409 = ya existe un pedido de ese tipo: no es un problema, pero se dice.
    # Callarlo hacía que "ya existe" y "Apple lo rechazó" se vieran igual —o
    # sea, no se vieran—, y el sync llevaba dos días diciendo que Apple estaba
    # generando un reporte que nunca se le llegó a pedir.
    if r.status_code == 409:
        print(f"· pedido de reporte {tipo}: Apple dice que ya existe ({detalle})")
        return None
    return f"No se pudo pedir el reporte de descargas ({tipo}): {r.status_code} {detalle}"


def asc_instancias(token: str, request_id: str) -> tuple[list[dict], str | None]:
    """Instancias del reporte de descargas: una por periodo ya generado."""
    reportes, err = asc_get(
        token, f"analyticsReportRequests/{request_id}/reports",
        {"filter[name]": ASC_REPORT, "limit": 50},
    )
    if err:
        return [], err
    salida: list[dict] = []
    for rep in reportes.get("data", []):
        # Diario, no mensual. El mensual bastaba para un total, pero la pregunta
        # que ninguna tienda contesta a tiempo es "¿cuántas se bajaron ayer?", y
        # Apple sí la responde a este nivel. Cada instancia ya bajada se guarda,
        # así que la corrida diaria solo trae la del día nuevo.
        inst, err = asc_get(
            token, f"analyticsReports/{rep['id']}/instances",
            {"filter[granularity]": "DAILY", "limit": 200},
        )
        if err:
            return [], err
        salida.extend(inst.get("data", []))
    return salida, None


def asc_descargar_segmentos(token: str, instancia_id: str) -> tuple[list[str], str | None]:
    """Contenido (ya descomprimido) de cada segmento de una instancia."""
    segs, err = asc_get(token, f"analyticsReportInstances/{instancia_id}/segments", {"limit": 50})
    if err:
        return [], err
    textos: list[str] = []
    for seg in segs.get("data", []):
        url = (seg.get("attributes") or {}).get("url")
        if not url:
            continue
        # La URL viene firmada y es de corta vida: se baja sin el token de ASC.
        r = requests.get(url, timeout=120)
        if r.status_code != 200:
            return [], f"No se pudo bajar el reporte de descargas: {r.status_code}"
        crudo = r.content
        try:
            crudo = gzip.decompress(crudo)
        except (OSError, EOFError):
            pass  # Apple a veces lo entrega sin comprimir
        textos.append(crudo.decode("utf-8", errors="replace"))
    return textos, None


# Tipos de descarga de Apple. "Total" en App Store Connect = primera vez +
# redescargas; las automáticas en otro dispositivo del mismo usuario cuentan
# aparte para no inflar el número que se enseña.
PRIMERA_VEZ = "first-time download"
REDESCARGA = "redownload"


def sumar_descargas(texto: str) -> dict[str, dict[str, int]]:
    """Cuentas del TSV de Apple POR DÍA y por tipo de descarga.

    La fecha sale de la columna `Date` del propio reporte, no de cuándo Apple
    lo generó. Usar `processingDate` metía todos los días del reporte en la
    fecha de generación: los 66 descargas de la app de clientes —repartidas
    entre el 5 y el 10 de septiembre— aparecían como un pico de 56 el día 11,
    que ni siquiera era el total. La gráfica mentía sobre cuándo pasó todo.
    """
    por_dia: dict[str, dict[str, int]] = {}
    lector = csv.DictReader(io.StringIO(texto), delimiter="\t")
    for fila in lector:
        try:
            n = int(float(fila.get("Counts") or 0))
        except ValueError:
            continue
        fecha = (fila.get("Date") or "").strip()[:10]
        if not fecha:
            continue
        dia = por_dia.setdefault(fecha, {"primera": 0, "redescarga": 0, "otras": 0})
        tipo = (fila.get("Download Type") or "").strip().lower()
        if tipo == PRIMERA_VEZ:
            dia["primera"] += n
        elif tipo == REDESCARGA:
            dia["redescarga"] += n
        else:
            dia["otras"] += n
    return por_dia


def fetch_appstore_installs(token: str, bundle: str, previo: dict) -> tuple[dict | None, str | None]:
    app_id, err = asc_app_id(token, bundle)
    if err:
        return None, err

    pedidos, err = asc_report_requests(token, app_id)
    if err:
        return None, err
    tipos = {(p.get("attributes") or {}).get("accessType") for p in pedidos}
    # ONE_TIME_SNAPSHOT trae el año anterior de golpe; ONGOING mantiene el mes a
    # mes de aquí en adelante. Se piden los dos: el primero da historia, el
    # segundo evita que el número se congele.
    for tipo in ("ONE_TIME_SNAPSHOT", "ONGOING"):
        if tipo not in tipos:
            error = asc_crear_pedido(token, app_id, tipo)
            if error:
                print(f"· {bundle}: {error}")
    if not pedidos:
        pedidos, err = asc_report_requests(token, app_id)
        if err:
            return None, err

    usables = [p for p in pedidos if not (p.get("attributes") or {}).get("stoppedDueToInactivity")]
    # Sin esto, "Apple está generando el reporte" era indistinguible de "el
    # pedido nunca se creó" o de "Apple lo paró por inactividad", que son tres
    # esperas muy distintas: una se resuelve sola y las otras dos no.
    resumen = ", ".join(
        f"{(p.get('attributes') or {}).get('accessType', '?')}"
        + (" (parado por inactividad)" if (p.get("attributes") or {}).get("stoppedDueToInactivity") else "")
        for p in pedidos
    ) or "ninguno"
    print(f"· {bundle}: pedidos de reporte en Apple: {resumen}")

    instancias: list[dict] = []
    for p in usables:
        inst, err = asc_instancias(token, p["id"])
        if err:
            return None, err
        instancias.extend(inst)
    print(f"· {bundle}: instancias mensuales listas: {len(instancias)}")

    if not instancias:
        # Sin instancias no hay nada nuevo que sumar; si ya se había contado
        # antes, se conserva ese total en vez de borrarlo.
        return (previo or {"pendiente": True}), None

    # Instancias ya leídas en corridas anteriores: no se vuelven a bajar salvo
    # las tres más recientes, que Apple sigue corrigiendo unos días.
    #
    # Se indexa por instancia y no por fecha porque una instancia trae VARIOS
    # días: la fecha de cada dato vive dentro del reporte, no en la instancia.
    dias: dict[str, dict] = dict(previo.get("dias") or {})
    leidas: set[str] = set(previo.get("instancias") or [])
    recientes_ids = {i["id"] for i in instancias[:3]}

    for inst in instancias:
        if inst["id"] in leidas and inst["id"] not in recientes_ids:
            continue
        textos, err = asc_descargar_segmentos(token, inst["id"])
        if err:
            return None, err
        for t in textos:
            # Se REEMPLAZA el día, no se suma: releer una instancia que Apple
            # corrigió tiene que dejar su cifra nueva, no el doble. Cada día
            # vive en una sola instancia, así que no hay nada que acumular.
            dias.update(sumar_descargas(t))
        leidas.add(inst["id"])

    if not dias:
        return {"pendiente": True}, None

    ordenados = sorted(dias)
    primera = sum(d["primera"] for d in dias.values())
    redes = sum(d["redescarga"] for d in dias.values())
    corte30 = (hoy() - timedelta(days=30)).isoformat()
    recientes = [d for f, d in dias.items() if f >= corte30]
    return {
        "descargas": primera + redes,
        "primeraVez": primera,
        "redescargas": redes,
        "descargas30d": sum(d["primera"] + d["redescarga"] for d in recientes),
        # La serie diaria, para pintar el día a día de iOS aunque las apps
        # todavía no manden nada a Analytics.
        "serie": [
            {"fecha": f, "descargas": dias[f]["primera"] + dias[f]["redescarga"]}
            for f in ordenados
        ],
        "desde": ordenados[0],
        "hasta": ordenados[-1],
        "dias": dias,
        "instancias": sorted(leidas),
        "parcial": True,
        "pendiente": False,
    }, None


# --- Main --------------------------------------------------------------------

def sync_play(fs_token: str, app: dict, tokens: dict) -> None:
    pkg, project_id = app["package"], app["projectId"]
    raw_sa, origen = play_service_account_for(FS_BASE, fs_token, project_id)
    if not raw_sa:
        error = (
            f"El proyecto '{project_id}' no tiene service account de Play. Súbelo en el "
            "dashboard (panel de la app > Cuenta de servicio de Play)."
        )
        write_doc(fs_token, "playInstalls", pkg, "package", project_id, None, error)
        print(f"⚠ {pkg}: {error}")
        return
    try:
        sa = json.loads(raw_sa)
    except json.JSONDecodeError:
        sa = None
    if not isinstance(sa, dict):
        error = f"El service account de Play del proyecto '{project_id}' no es un JSON válido."
        write_doc(fs_token, "playInstalls", pkg, "package", project_id, None, error)
        print(f"⚠ {pkg}: {error}")
        return

    email = sa.get("client_email") or "?"
    if email not in tokens:
        tokens[email] = play_access_token(sa)
    token, error = tokens[email]
    if error:
        write_doc(fs_token, "playInstalls", pkg, "package", project_id, None, error)
        print(f"⚠ {pkg}: {error}")
        return

    bucket, origen_bucket = play_reports_bucket_for(FS_BASE, fs_token, project_id)
    if not bucket:
        error = (
            f"El proyecto '{project_id}' no tiene bucket de informes de Play. Cópialo de Play "
            "Console → Download reports → Statistics (arriba dice gs://pubsite_prod_…) y guárdalo "
            "en el dashboard, junto a la cuenta de servicio de Play. Las instalaciones no salen "
            "por API: Google solo las publica en ese bucket."
        )
        write_doc(fs_token, "playInstalls", pkg, "package", project_id, None, error)
        print(f"⚠ {pkg}: {error}")
        return

    print(f"· {pkg}: service account del {origen} ({email}), bucket del {origen_bucket}")
    previo = read_raw(fs_token, "playInstalls", pkg)
    payload, error = fetch_play_installs(token, pkg, normaliza_bucket(bucket), previo)

    # El 403 sobre el bucket es el caso conocido: se reintenta con la credencial
    # de usuario de respaldo antes de dar la app por perdida.
    if error and "no puede leer el bucket" in error:
        respaldo, fallo = oauth_usuario_token()
        if fallo:
            print(f"· {pkg}: respaldo OAuth no utilizable — {fallo}")
        elif respaldo:
            print(f"· {pkg}: el service account no ve el bucket; se reintenta con la credencial de respaldo")
            payload, error = fetch_play_installs(respaldo, pkg, normaliza_bucket(bucket), previo)

    write_doc(fs_token, "playInstalls", pkg, "package", project_id, payload, error)
    if payload and payload.get("pendiente"):
        print(f"· {pkg}: Play todavía no publica informes de esta app (el primero sale al cierre del mes).")
    elif payload:
        print(
            f"✓ {pkg}: {payload['descargas']} descargas históricas "
            f"({payload['descargas30d']} en 30 días, {payload['activos']} instaladas hoy)"
        )
    else:
        print(f"⚠ {pkg}: {error}")


def sync_appstore(fs_token: str, app: dict, tokens: dict) -> None:
    bundle, project_id = app["bundleId"], app["projectId"]
    creds, origen = app_store_connect_for(FS_BASE, fs_token, project_id)
    if not creds:
        error = (
            f"El proyecto '{project_id}' no tiene llave de App Store Connect. Súbela en el "
            "dashboard (panel de la app > App Store Connect)."
        )
        write_doc(fs_token, "appStoreInstalls", bundle, "bundleId", project_id, None, error)
        print(f"⚠ {bundle}: {error}")
        return

    clave = creds.get("key_id") or "?"
    if clave not in tokens:
        tokens[clave] = asc_token(creds)
    token, error = tokens[clave]
    if error:
        write_doc(fs_token, "appStoreInstalls", bundle, "bundleId", project_id, None, error)
        print(f"⚠ {bundle}: {error}")
        return

    print(f"· {bundle}: credenciales de App Store Connect del {origen}")
    previo = read_raw(fs_token, "appStoreInstalls", bundle)
    payload, error = fetch_appstore_installs(token, bundle, previo)
    write_doc(fs_token, "appStoreInstalls", bundle, "bundleId", project_id, payload, error)
    if error:
        print(f"⚠ {bundle}: {error}")
    elif payload.get("pendiente"):
        print(f"· {bundle}: Apple todavía está generando el reporte de descargas (tarda ~1 día).")
    else:
        print(f"✓ {bundle}: {payload['descargas']} descargas desde {payload['desde']}")


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not fs_token:
        fail("Falta FIRESTORE_TOKEN.")

    apps = list_apps(fs_token)
    if not apps:
        print("Ningún proyecto es una app con package o bundle id. Nada que sincronizar.")
        return

    tokens_play: dict[str, tuple[str | None, str | None]] = {}
    tokens_asc: dict[str, tuple[str | None, str | None]] = {}
    for app in apps:
        if app["package"]:
            sync_play(fs_token, app, tokens_play)
        if app["bundleId"]:
            sync_appstore(fs_token, app, tokens_asc)


if __name__ == "__main__":
    main()
