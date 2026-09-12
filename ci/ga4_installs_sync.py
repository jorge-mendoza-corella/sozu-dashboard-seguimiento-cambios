#!/usr/bin/env python3
"""
Instalaciones DIARIAS de cada app, leídas de Google Analytics 4.

Las tiendas no sirven para esto: Play publica un informe por mes cerrado —en
septiembre lo más nuevo que existe es agosto— y Apple entrega reportes que
tarda un día en generar. Para ver el día a día de las dos plataformas juntas la
única fuente es GA4: cada app manda `first_open` la primera vez que alguien la
abre tras instalarla.

No es lo mismo que "descargas de la tienda" y no se presenta como tal: quien
descarga y no abre no cuenta aquí, y quien reinstala en otro aparato sí. Va al
lado del número de tienda, no en su lugar.

Firestore:
  lee    projects/{id}.ga4Property, .ga4StreamAndroid, .ga4StreamIos
  escribe ga4Installs/{projectId}

Variables de entorno:
  FIRESTORE_TOKEN               access token de GCP para Firestore REST
  GOOGLE_APPLICATION_CREDENTIALS  JSON del service account (lo deja la action de
                                auth). Debe estar dado de alta como Lector en la
                                propiedad de GA4.
  GCP_PROJECT                   id del proyecto Firebase (default: sozu-admin-dev)
  GA4_DIAS                      cuántos días traer (default: 90)
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import jwt  # PyJWT
import requests

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"
GA4_BASE = "https://analyticsdata.googleapis.com/v1beta"
GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly"
DIAS = int(os.environ.get("GA4_DIAS", "90"))


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# --- Auth --------------------------------------------------------------------

def ga4_token() -> tuple[str | None, str | None]:
    """(access token para la Data API, error).

    Se firma con el service account del workflow, el mismo que ya escribe en
    Firestore. El scope es propio de Analytics: `cloud-platform` no sirve aquí,
    la API contesta "insufficient authentication scopes".
    """
    ruta = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if not ruta or not os.path.exists(ruta):
        return None, "Falta GOOGLE_APPLICATION_CREDENTIALS: sin service account no se puede leer GA4."
    try:
        sa = json.load(open(ruta, encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return None, f"No se pudo leer el service account: {e}"

    now = int(time.time())
    try:
        assertion = jwt.encode(
            {
                "iss": sa["client_email"],
                "scope": GA4_SCOPE,
                "aud": sa["token_uri"],
                "iat": now,
                "exp": now + 3600,
            },
            sa["private_key"],
            algorithm="RS256",
        )
    except (KeyError, TypeError, ValueError, jwt.PyJWTError) as e:
        return None, f"El service account no sirve para firmar ({type(e).__name__}: {e})."
    r = requests.post(
        sa["token_uri"],
        data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
        timeout=30,
    )
    if r.status_code != 200:
        return None, f"No se pudo obtener token de Analytics: {r.status_code} {r.text[:200]}"
    return r.json()["access_token"], None


# --- Firestore ---------------------------------------------------------------

def _str(f: dict, key: str) -> str:
    return (f.get(key) or {}).get("stringValue", "").strip()


def list_apps_ga4(token: str) -> list[dict]:
    """Proyectos app con propiedad de GA4 configurada."""
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
            prop = _str(f, "ga4Property")
            if not (f.get("isApp", {}).get("booleanValue") and prop):
                continue
            out.append({
                "projectId": doc["name"].rsplit("/", 1)[-1],
                "property": prop,
                "streams": {
                    "android": _str(f, "ga4StreamAndroid"),
                    "ios": _str(f, "ga4StreamIos"),
                },
            })
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def write_doc(token: str, project_id: str, payload: dict | None, error: str | None) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    body = {
        "fields": {
            "projectId": {"stringValue": project_id},
            "updatedAt": {"timestampValue": now},
            "raw": {"stringValue": json.dumps(payload or {}, ensure_ascii=False)},
            "error": {"stringValue": error} if error else {"nullValue": None},
        }
    }
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in body["fields"])
    r = requests.patch(
        f"{FS_BASE}/ga4Installs/{quote(project_id, safe='')}?{mask}",
        headers=fs_headers(token), json=body, timeout=30,
    )
    if r.status_code not in (200, 201):
        fail(f"Firestore write {project_id}: {r.status_code} {r.text[:300]}")


# --- GA4 ---------------------------------------------------------------------

def run_report(token: str, prop: str, desde: str, hasta: str) -> tuple[list[dict], str | None]:
    """Primeras aperturas por día y por stream."""
    r = requests.post(
        f"{GA4_BASE}/properties/{prop}:runReport",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "dateRanges": [{"startDate": desde, "endDate": hasta}],
            "dimensions": [{"name": "date"}, {"name": "streamId"}],
            "metrics": [{"name": "eventCount"}],
            # `first_open` es el evento que GA4 registra en la primera apertura
            # tras instalar. La métrica `newUsers` contaría también web.
            "dimensionFilter": {
                "filter": {
                    "fieldName": "eventName",
                    "stringFilter": {"matchType": "EXACT", "value": "first_open"},
                }
            },
            "orderBys": [{"dimension": {"dimensionName": "date"}}],
            "limit": 100000,
        },
        timeout=60,
    )
    if r.status_code != 200:
        try:
            detalle = r.json().get("error", {}).get("message", r.text[:300])
        except ValueError:
            detalle = r.text[:300]
        if r.status_code == 403:
            return [], (
                "El service account no tiene acceso a la propiedad de GA4. Agrégalo como Lector "
                f"en Analytics → Administrar → Gestión de acceso a la propiedad. Detalle: {detalle}"
            )
        return [], f"GA4 Data API {r.status_code}: {detalle}"
    filas = []
    for fila in r.json().get("rows", []):
        dims = [d.get("value") for d in fila.get("dimensionValues", [])]
        val = (fila.get("metricValues") or [{}])[0].get("value", "0")
        try:
            n = int(float(val))
        except ValueError:
            n = 0
        filas.append({"fecha": dims[0], "stream": dims[1], "n": n})
    return filas, None


def run_realtime(token: str, prop: str, streams: dict) -> dict | None:
    """Lo que está pasando AHORA: últimos 30 minutos, por plataforma.

    Es la única lectura de GA4 que merece llamarse en vivo. El reporte normal
    —el que arma la serie diaria— no publica el día en curso hasta que Analytics
    lo consolida, y eso tarda horas: preguntándole a media mañana por el día de
    hoy contesta que no hay nada, que no es lo mismo que un cero.

    No entra en la serie ni se suma a nada: son dos métricas distintas leídas en
    ventanas distintas. Se enseña aparte, como el pulso de la app.
    """
    por_stream = {v: k for k, v in (streams or {}).items() if v}
    salida = {
        "ventanaMinutos": 30,
        "aperturas": {"android": 0, "ios": 0},
        "activos": {"android": 0, "ios": 0},
    }

    consultas = (
        ("aperturas", "eventCount", {
            "filter": {
                "fieldName": "eventName",
                "stringFilter": {"matchType": "EXACT", "value": "first_open"},
            }
        }),
        ("activos", "activeUsers", None),
    )
    for clave, metrica, filtro in consultas:
        cuerpo: dict = {
            "dimensions": [{"name": "streamId"}],
            "metrics": [{"name": metrica}],
            "minuteRanges": [{"startMinutesAgo": 29, "endMinutesAgo": 0}],
            "limit": 100,
        }
        if filtro:
            cuerpo["dimensionFilter"] = filtro
        r = requests.post(
            f"{GA4_BASE}/properties/{prop}:runRealtimeReport",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=cuerpo,
            timeout=30,
        )
        # El pulso es un extra: si falla, la serie diaria —que es el dato -- sigue
        # subiendo igual. Callarlo es peor que no tenerlo, así que se avisa.
        if r.status_code != 200:
            print(f"  · sin lectura en vivo de {metrica}: GA4 {r.status_code} {r.text[:160]}")
            continue
        for fila in r.json().get("rows", []):
            stream = (fila.get("dimensionValues") or [{}])[0].get("value")
            plataforma = por_stream.get(stream)
            if not plataforma:
                continue
            try:
                salida[clave][plataforma] += int(float((fila.get("metricValues") or [{}])[0].get("value", "0")))
            except ValueError:
                continue

    salida["medidoEn"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return salida


def serie_diaria(filas: list[dict], streams: dict) -> list[dict]:
    """Una fila por día con lo de cada plataforma, en orden."""
    por_stream = {v: k for k, v in streams.items() if v}
    dias: dict[str, dict] = {}
    for f in filas:
        plataforma = por_stream.get(f["stream"])
        if not plataforma:
            continue  # otro stream de la misma propiedad (web, otra app)
        iso = f"{f['fecha'][:4]}-{f['fecha'][4:6]}-{f['fecha'][6:]}"
        dia = dias.setdefault(iso, {"fecha": iso, "android": 0, "ios": 0})
        dia[plataforma] += f["n"]
    return [dias[k] for k in sorted(dias)]


def diagnostico(token: str, prop: str, desde: str, hasta: str) -> None:
    """Qué está recibiendo esa propiedad, cuando no hay ninguna `first_open`.

    Sin esto, "GA4 no reporta nada" tapa tres casos muy distintos: que la app
    no lleve el SDK de Analytics, que los streams configurados no sean los que
    reportan, o que sí haya datos pero con otro nombre de evento.
    """
    r = requests.post(
        f"{GA4_BASE}/properties/{prop}:runReport",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "dateRanges": [{"startDate": desde, "endDate": hasta}],
            "dimensions": [{"name": "streamId"}, {"name": "eventName"}],
            "metrics": [{"name": "eventCount"}],
            "orderBys": [{"metric": {"metricName": "eventCount"}, "desc": True}],
            "limit": 15,
        },
        timeout=60,
    )
    if r.status_code != 200:
        print(f"  · el diagnóstico tampoco pudo leer GA4: {r.status_code} {r.text[:200]}")
        return
    filas = r.json().get("rows", [])
    if not filas:
        print("  · la propiedad no registró NINGÚN evento en el rango: las apps no están mandando datos a GA4.")
        return
    print("  · eventos que sí llegan a esta propiedad:")
    for fila in filas:
        dims = [d.get("value") for d in fila.get("dimensionValues", [])]
        val = (fila.get("metricValues") or [{}])[0].get("value")
        print(f"    stream {dims[0]} · {dims[1]}: {val}")


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not fs_token:
        fail("Falta FIRESTORE_TOKEN.")

    apps = list_apps_ga4(fs_token)
    if not apps:
        print("Ningún proyecto tiene propiedad de GA4 configurada. Nada que sincronizar.")
        return

    token, error = ga4_token()
    if error:
        fail(error)

    hasta = datetime.now(timezone.utc).date()
    desde = hasta - timedelta(days=DIAS)
    for app in apps:
        filas, error = run_report(token, app["property"], desde.isoformat(), hasta.isoformat())
        if error:
            write_doc(fs_token, app["projectId"], None, error)
            print(f"⚠ {app['projectId']}: {error}")
            continue

        # El pulso se lee siempre, aunque la serie venga vacía: el día que las
        # apps empiecen a mandar datos, esto lo enseña antes que nada.
        en_vivo = run_realtime(token, app["property"], app["streams"])

        dias = serie_diaria(filas, app["streams"])
        if not dias:
            write_doc(fs_token, app["projectId"], {"pendiente": True, "enVivo": en_vivo}, None)
            print(f"· {app['projectId']}: GA4 todavía no reporta ninguna primera apertura.")
            print(f"  · streams configurados: {app['streams']}")
            diagnostico(token, app["property"], desde.isoformat(), hasta.isoformat())
            continue

        corte30 = (hasta - timedelta(days=30)).isoformat()
        recientes = [d for d in dias if d["fecha"] >= corte30]
        payload = {
            "property": app["property"],
            "dias": dias,
            "android": sum(d["android"] for d in dias),
            "ios": sum(d["ios"] for d in dias),
            "android30d": sum(d["android"] for d in recientes),
            "ios30d": sum(d["ios"] for d in recientes),
            "desde": dias[0]["fecha"],
            "hasta": dias[-1]["fecha"],
            "enVivo": en_vivo,
        }
        write_doc(fs_token, app["projectId"], payload, None)
        print(
            f"✓ {app['projectId']}: {payload['android'] + payload['ios']} primeras aperturas "
            f"({payload['android']} Android, {payload['ios']} iOS) del {payload['desde']} al {payload['hasta']}"
        )
        if en_vivo:
            v = en_vivo
            print(
                f"  · ahora mismo: {v['activos']['android'] + v['activos']['ios']} activos, "
                f"{v['aperturas']['android'] + v['aperturas']['ios']} aperturas nuevas "
                f"(últimos {v['ventanaMinutos']} min)"
            )


if __name__ == "__main__":
    main()
