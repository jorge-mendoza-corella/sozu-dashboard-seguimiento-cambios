#!/usr/bin/env python3
"""
Vuelca a Firestore cuántas descargas lleva cada app, para verlo en la tarjeta
del repo sin entrar a Play Console ni a App Store Connect.

  · Google Play  → Play Developer Reporting API (installsOverviewMetricSet).
                   Da instalaciones por día: descargas, desinstalaciones y
                   cuántos dispositivos activos la tienen ahora mismo.
                   Escribe `playInstalls/{package}`.
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

from store_credentials import app_store_connect_for, play_service_account_for

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"
REPORTING_BASE = "https://playdeveloperreporting.googleapis.com/v1beta1"
ASC_BASE = "https://api.appstoreconnect.apple.com/v1"
PLAY_SCOPE = "https://www.googleapis.com/auth/playdeveloperreporting"

# Nombre del reporte de Apple con las descargas. Es el "estándar": el detallado
# trae las mismas cuentas partidas en más dimensiones, y aquí solo se suman.
ASC_REPORT = "App Downloads Standard"
# Etiqueta con la que Apple identifica los pedidos de reporte de este dashboard.
ASC_REQUEST_NAME = "sozu-dashboard-descargas"


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

def play_access_token(sa: dict) -> tuple[str | None, str | None]:
    """(token OAuth para la Reporting API, error).

    Es otro scope que el de play_tracks_sync.py: la Reporting API no entra en
    `androidpublisher`, así que hay que firmar un JWT propio aunque la cuenta
    de servicio sea la misma.
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
        return None, f"No se pudo obtener token de la Reporting API: {r.status_code} {r.text[:300]}"
    return r.json()["access_token"], None


def _fecha(d: dict) -> str:
    return f"{d.get('year', 0):04d}-{d.get('month', 0):02d}-{d.get('day', 0):02d}"


def fetch_play_installs(token: str, pkg: str, sa_email: str, desde: date) -> tuple[dict | None, str | None]:
    """Descargas, desinstalaciones e instalaciones activas de Play, por día."""
    h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    url = f"{REPORTING_BASE}/apps/{pkg}/installsOverviewMetricSet:query"
    hasta = hoy() - timedelta(days=1)  # el día en curso todavía no está cerrado
    cuerpo = {
        "timelineSpec": {
            "aggregationPeriod": "DAILY",
            "startTime": {"year": desde.year, "month": desde.month, "day": desde.day},
            "endTime": {"year": hasta.year, "month": hasta.month, "day": hasta.day},
        },
        "metrics": ["installEvents", "uninstallEvents", "activeDeviceInstalls"],
        "pageSize": 1000,
    }

    filas: list[dict] = []
    pagina = None
    while True:
        if pagina:
            cuerpo["pageToken"] = pagina
        r = requests.post(url, headers=h, json=cuerpo, timeout=60)
        if r.status_code != 200:
            try:
                detalle = r.json().get("error", {}).get("message", r.text[:300])
            except ValueError:
                # Cuando la API no está habilitada en el proyecto del service
                # account, Google no contesta JSON: manda su página 404 de
                # siempre. Guardar ese HTML en Firestore llenaría el tooltip de
                # basura, así que se traduce a lo único que hay que hacer.
                if "<html" in r.text[:200].lower():
                    return None, (
                        f"La Play Developer Reporting API no está habilitada en el proyecto de "
                        f"Google Cloud del service account ({sa_email.split('@')[-1].split('.')[0]}). "
                        "Habilítala ahí (playdeveloperreporting.googleapis.com) y dale al service "
                        "account, en Play Console, el permiso 'View app information and download "
                        "bulk reports'."
                    )
                detalle = r.text[:300]
            if r.status_code in (401, 403):
                return None, (
                    f"El service account {sa_email} no puede leer las descargas de '{pkg}'. "
                    "En Play Console → Users and permissions dale 'View app information and "
                    "download bulk reports', y habilita la Play Developer Reporting API en su "
                    f"proyecto de Google Cloud. Detalle: {detalle}"
                )
            if r.status_code == 404:
                return None, f"La Reporting API no conoce el package '{pkg}'. Detalle: {detalle}"
            return None, f"Reporting API {r.status_code}: {detalle}"
        data = r.json()
        filas.extend(data.get("rows", []))
        pagina = data.get("nextPageToken")
        if not pagina:
            break

    if not filas:
        return None, (
            "Play todavía no reporta instalaciones de esta app (o la Reporting API no tiene "
            "datos en el rango consultado)."
        )

    def valor(fila: dict, metrica: str) -> int:
        for m in fila.get("metrics", []):
            if m.get("metric") == metrica:
                v = m.get("decimalValue", {}).get("value")
                return int(float(v)) if v is not None else 0
        return 0

    dias = sorted(
        (
            {
                "fecha": _fecha(fila.get("startTime", {})),
                "installs": valor(fila, "installEvents"),
                "uninstalls": valor(fila, "uninstallEvents"),
                "activos": valor(fila, "activeDeviceInstalls"),
            }
            for fila in filas
        ),
        key=lambda d: d["fecha"],
    )
    corte = (hoy() - timedelta(days=30)).isoformat()
    ultimos = [d for d in dias if d["fecha"] >= corte]
    return {
        "descargas": sum(d["installs"] for d in dias),
        "desinstalaciones": sum(d["uninstalls"] for d in dias),
        # `activeDeviceInstalls` es un total del día, no un incremento: el dato
        # útil es el último, no la suma.
        "activos": dias[-1]["activos"],
        "descargas30d": sum(d["installs"] for d in ultimos),
        "desinstalaciones30d": sum(d["uninstalls"] for d in ultimos),
        "desde": dias[0]["fecha"],
        "hasta": dias[-1]["fecha"],
        # La Reporting API no guarda toda la vida de la app: se dice desde
        # cuándo se está contando para no vender el número como histórico.
        "parcial": True,
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
                "attributes": {"accessType": tipo, "name": ASC_REQUEST_NAME},
                "relationships": {"app": {"data": {"type": "apps", "id": app_id}}},
            }
        },
        timeout=30,
    )
    if r.status_code in (200, 201):
        return None
    try:
        detalle = r.json()["errors"][0].get("detail", r.text[:200])
    except Exception:
        detalle = r.text[:200]
    # 409 = ya existe un pedido de ese tipo: no es un problema.
    if r.status_code == 409:
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
        # Mensual: un reporte diario de dos años son cientos de descargas para
        # un número que solo se mira sumado.
        inst, err = asc_get(
            token, f"analyticsReports/{rep['id']}/instances",
            {"filter[granularity]": "MONTHLY", "limit": 200},
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


def sumar_descargas(texto: str) -> dict[str, int]:
    """Suma las cuentas del TSV de Apple por tipo de descarga."""
    total = {"primera": 0, "redescarga": 0, "otras": 0}
    lector = csv.DictReader(io.StringIO(texto), delimiter="\t")
    for fila in lector:
        try:
            n = int(float(fila.get("Counts") or 0))
        except ValueError:
            continue
        tipo = (fila.get("Download Type") or "").strip().lower()
        if tipo == PRIMERA_VEZ:
            total["primera"] += n
        elif tipo == REDESCARGA:
            total["redescarga"] += n
        else:
            total["otras"] += n
    return total


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
    instancias: list[dict] = []
    for p in usables:
        inst, err = asc_instancias(token, p["id"])
        if err:
            return None, err
        instancias.extend(inst)

    if not instancias:
        # Sin instancias no hay nada nuevo que sumar; si ya se había contado
        # antes, se conserva ese total en vez de borrarlo.
        return (previo or {"pendiente": True}), None

    # Meses ya sumados en la corrida anterior: solo se vuelven a bajar el mes en
    # curso y el anterior (Apple los sigue corrigiendo unos días).
    meses: dict[str, dict] = dict(previo.get("meses") or {})
    mes_actual = hoy().strftime("%Y-%m")
    mes_previo = (hoy().replace(day=1) - timedelta(days=1)).strftime("%Y-%m")

    for inst in instancias:
        attrs = inst.get("attributes") or {}
        periodo = (attrs.get("processingDate") or "")[:7]
        if not periodo:
            continue
        if periodo in meses and periodo not in (mes_actual, mes_previo):
            continue
        textos, err = asc_descargar_segmentos(token, inst["id"])
        if err:
            return None, err
        acumulado = {"primera": 0, "redescarga": 0, "otras": 0}
        for t in textos:
            parcial = sumar_descargas(t)
            for k in acumulado:
                acumulado[k] += parcial[k]
        meses[periodo] = acumulado

    if not meses:
        return {"pendiente": True}, None

    ordenados = sorted(meses)
    primera = sum(m["primera"] for m in meses.values())
    redes = sum(m["redescarga"] for m in meses.values())
    ultimo = meses[ordenados[-1]]
    return {
        "descargas": primera + redes,
        "primeraVez": primera,
        "redescargas": redes,
        "descargasUltimoMes": ultimo["primera"] + ultimo["redescarga"],
        "ultimoMes": ordenados[-1],
        "desde": ordenados[0],
        "hasta": ordenados[-1],
        "meses": meses,
        "parcial": True,
        "pendiente": False,
    }, None


# --- Main --------------------------------------------------------------------

# Desde dónde se le pide historia a Play. La Reporting API no guarda toda la
# vida de la app; se prueban rangos de más a menos hasta que uno conteste.
INICIOS_PLAY = [date(2021, 1, 1), date(hoy().year - 2, 1, 1), hoy() - timedelta(days=365)]


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

    print(f"· {pkg}: service account del {origen} ({email})")
    payload = ultimo_error = None
    for inicio in INICIOS_PLAY:
        payload, ultimo_error = fetch_play_installs(token, pkg, email, inicio)
        if payload:
            break
    write_doc(fs_token, "playInstalls", pkg, "package", project_id, payload, ultimo_error)
    if payload:
        print(
            f"✓ {pkg}: {payload['descargas']} descargas desde {payload['desde']} "
            f"({payload['descargas30d']} en 30 días, {payload['activos']} activas)"
        )
    else:
        print(f"⚠ {pkg}: {ultimo_error}")


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
