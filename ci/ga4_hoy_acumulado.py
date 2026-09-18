#!/usr/bin/env python3
"""
Las instalaciones de HOY, sumadas de a poco con GA4 Realtime.

El problema que resuelve: ninguna fuente sabe decir cuántas instalaciones lleva
el día en curso. Las tiendas publican el reporte de un día durante el siguiente,
y el reporte diario de GA4 tampoco trae el día de hoy —comprobado pidiéndoselo
con sus propios literales: `today` devuelve cero filas a media mañana mientras
`yesterday` devuelve cuatro—. Analytics tarda alrededor de un día en consolidar.

Lo único que sí es inmediato es GA4 Realtime, pero su ventana son 30 minutos:
sirve para "qué está pasando ahora", no para "cuánto llevamos hoy". Este script
convierte lo uno en lo otro, sumando cada pasada.

Cómo evita contar doble: corre cada 10 minutos y pregunta por los últimos 10,
sin solape. Si una corrida falla, ese hueco se pierde y el número queda corto —
por eso el dato va marcado como estimado y lo sustituye el definitivo en cuanto
llega.

Firestore:
  lee/escribe  ga4HoyAcumulado/{projectId}   (el acumulador y su día)
Supabase:
  escribe      app_instalaciones_diarias con fuente `ga4_realtime`

Variables de entorno: las mismas del resto de puentes (FIRESTORE_TOKEN,
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GCP_PROJECT) más el service account de
Google, que es con el que se firma el token de Analytics.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ga4_installs_sync import GA4_BASE, fs_headers, ga4_token, list_apps_ga4  # noqa: E402
from supabase_installs_push import list_apps as list_apps_supabase  # noqa: E402

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"

# Cada cuántos minutos corre esto. La ventana que se le pide a GA4 es la misma,
# para que dos corridas seguidas no cuenten dos veces al mismo. Si se cambia el
# cron del workflow, hay que cambiar esto o el número empieza a inflarse.
VENTANA_MIN = int(os.environ.get("GA4_ACUMULADO_MINUTOS", "10"))

# La zona de las propiedades de GA4 (`Etc/GMT+6`, verificado en la respuesta de
# la API). El "hoy" del acumulador tiene que ser el mismo día que usa Analytics,
# o a las 18:00 se estaría sumando lo de hoy encima de lo de mañana.
TZ_GA4 = timezone(timedelta(hours=-6))


def hoy_ga4() -> str:
    return datetime.now(TZ_GA4).date().isoformat()


def leer_acumulado(token: str, project_id: str) -> dict:
    r = requests.get(
        f"{FS_BASE}/ga4HoyAcumulado/{quote(project_id, safe='')}",
        headers=fs_headers(token), timeout=30,
    )
    if r.status_code != 200:
        return {}
    try:
        return json.loads((r.json().get("fields") or {}).get("raw", {}).get("stringValue") or "{}")
    except (ValueError, AttributeError):
        return {}


def guardar_acumulado(token: str, project_id: str, datos: dict) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    body = {
        "fields": {
            "projectId": {"stringValue": project_id},
            "updatedAt": {"timestampValue": now},
            "raw": {"stringValue": json.dumps(datos, ensure_ascii=False)},
        }
    }
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in body["fields"])
    r = requests.patch(
        f"{FS_BASE}/ga4HoyAcumulado/{quote(project_id, safe='')}?{mask}",
        headers=fs_headers(token), json=body, timeout=30,
    )
    if r.status_code not in (200, 201):
        print(f"::error::Firestore write {project_id}: {r.status_code} {r.text[:200]}")


def aperturas_de_la_ventana(token: str, prop: str, streams: dict) -> dict[str, int] | None:
    """Primeras aperturas en los últimos `VENTANA_MIN` minutos, por plataforma."""
    por_stream = {v: k for k, v in (streams or {}).items() if v}
    r = requests.post(
        f"{GA4_BASE}/properties/{prop}:runRealtimeReport",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "dimensions": [{"name": "streamId"}],
            "metrics": [{"name": "eventCount"}],
            "minuteRanges": [{"startMinutesAgo": VENTANA_MIN - 1, "endMinutesAgo": 0}],
            "dimensionFilter": {
                "filter": {
                    "fieldName": "eventName",
                    "stringFilter": {"matchType": "EXACT", "value": "first_open"},
                }
            },
            "limit": 100,
        },
        timeout=30,
    )
    if r.status_code != 200:
        print(f"  · sin lectura en vivo: GA4 {r.status_code} {r.text[:160]}")
        return None

    salida = {"android": 0, "ios": 0}
    for fila in r.json().get("rows", []):
        plataforma = por_stream.get((fila.get("dimensionValues") or [{}])[0].get("value"))
        if not plataforma:
            continue
        try:
            salida[plataforma] += int(float((fila.get("metricValues") or [{}])[0].get("value", "0")))
        except ValueError:
            continue
    return salida


def escribir_supabase(url: str, key: str, id_app: int, fecha: str, acum: dict) -> None:
    """Deja el acumulado como el día de hoy, marcado como lo que es.

    `estimado = true` y `fuente = ga4_realtime`: los dos tableros ya saben que un
    día cuya fuente no es de tienda todavía no ha cerrado, así que lo pintan
    punteado sin necesidad de nada más. Y cuando mañana llegue el dato bueno,
    el UPSERT lo pisa por la llave (id_app, fecha, plataforma).
    """
    filas = [
        {
            "id_app": id_app,
            "fecha": fecha,
            "plataforma": plat,
            "instalaciones": n,
            "estimado": True,
            "fuente": "ga4_realtime",
        }
        for plat, n in (("android", acum.get("android", 0)), ("ios", acum.get("ios", 0)))
        if n > 0
    ]
    if not filas:
        return
    r = requests.post(
        f"{url.rstrip('/')}/rest/v1/app_instalaciones_diarias",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        params={"on_conflict": "id_app,fecha,plataforma"},
        json=filas,
        timeout=30,
    )
    if r.status_code not in (200, 201, 204):
        print(f"::error::Supabase {r.status_code}: {r.text[:200]}")


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not fs_token:
        print("::error::Falta FIRESTORE_TOKEN.")
        sys.exit(1)

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

    token, error = ga4_token()
    if error:
        print(f"· {error}")
        return

    fecha = hoy_ga4()
    ids_supabase = {a["projectId"]: a["idApp"] for a in list_apps_supabase(fs_token)}

    for app in list_apps_ga4(fs_token):
        nuevas = aperturas_de_la_ventana(token, app["property"], app["streams"])
        if nuevas is None:
            continue

        previo = leer_acumulado(fs_token, app["projectId"])
        # Día nuevo, cuenta desde cero. Sin esto, el acumulado de ayer se
        # quedaría sumando sobre el de hoy para siempre.
        if previo.get("fecha") != fecha:
            previo = {"fecha": fecha, "android": 0, "ios": 0, "ventanas": 0}

        previo["android"] += nuevas["android"]
        previo["ios"] += nuevas["ios"]
        previo["ventanas"] = previo.get("ventanas", 0) + 1
        guardar_acumulado(fs_token, app["projectId"], previo)

        total = previo["android"] + previo["ios"]
        # Se informa siempre, también con cero. Un silencio no distingue "no
        # hubo instalaciones" de "el paso no llegó a correr", y es justo lo que
        # hay que poder distinguir cuando alguien pregunte por qué no ve su
        # descarga.
        nuevo = nuevas["android"] + nuevas["ios"]
        print(
            f"✓ {app['projectId']}: +{nuevo} en los últimos {VENTANA_MIN} min · "
            f"hoy ({fecha}) van {total} ({previo['android']} Android, {previo['ios']} iOS) "
            f"en {previo['ventanas']} lecturas"
        )

        # El projectId de Firestore es opaco y no dice de qué app es. El mapeo
        # projectId -> id de Supabase ya lo resuelve el puente de la serie
        # diaria, mirando el package; se reusa en vez de repetirlo aquí.
        id_app = ids_supabase.get(app["projectId"])
        if url and key and id_app and total > 0:
            escribir_supabase(url, key, id_app, fecha, previo)


if __name__ == "__main__":
    main()
