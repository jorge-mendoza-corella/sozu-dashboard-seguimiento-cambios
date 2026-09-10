#!/usr/bin/env python3
"""
Empuja a Supabase las instalaciones diarias que los otros syncs dejaron en
Firestore, para que el Portal Alta Dirección las grafique.

Por qué un puente y no que el portal lea la fuente directa: el portal es un
navegador contra Supabase, y ni GA4 ni las tiendas se pueden consultar desde
ahí —Play exige firmar un JWT con llave privada, Apple entrega reportes
comprimidos, GA4 pide un scope propio—. Todo eso ya lo resuelve este workflow;
lo único que faltaba era dejar el resultado donde el portal sí puede leerlo.

Fuentes, por orden de preferencia para cada día:
  1. `ga4Installs/{projectId}` — Analytics, las dos plataformas al día.
  2. `appStoreInstalls/{bundleId}.serie` — Apple, sólo iOS, mientras GA4 no
     reporte (las apps acaban de estrenar el SDK y no hay histórico).

Play no aporta serie: publica un informe por mes cerrado, sin día a día.

Escribe en `public.app_instalaciones_diarias` con UPSERT sobre
(id_app, fecha, plataforma): reescribir un día ya escrito es lo normal, porque
las tiendas corrigen sus cifras unos días. Nunca toca las filas `estimado`
sembradas al arranque… salvo que llegue un dato real para ese mismo día, que es
justo cuando deben ceder.

Variables de entorno:
  FIRESTORE_TOKEN             access token de GCP para Firestore REST
  SUPABASE_URL                https://<proyecto>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY   llave de servicio (salta RLS). Sin ella el script
                              no hace nada y lo dice: es un extra, no debe
                              tumbar el resto del sync.
  GCP_PROJECT                 id del proyecto Firebase (default: sozu-admin-dev)
"""
from __future__ import annotations

import json
import os
import sys
from urllib.parse import quote

import requests

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"

# Ids de `public.apps` en Supabase. Es catálogo: 1 = clientes, 2 = agentes.
APPS_SUPABASE = {"clientes": 1, "agentes": 2}


def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _str(f: dict, key: str) -> str:
    return (f.get(key) or {}).get("stringValue", "").strip()


def raw_de(token: str, coleccion: str, doc_id: str) -> dict:
    """`raw` de un documento del sync, o {} si no existe."""
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


def list_apps(token: str) -> list[dict]:
    """Proyectos app del dashboard, con lo necesario para ubicarlos en Supabase."""
    out: list[dict] = []
    page = None
    while True:
        params = {"pageSize": 200}
        if page:
            params["pageToken"] = page
        r = requests.get(f"{FS_BASE}/projects", headers=fs_headers(token), params=params, timeout=30)
        if r.status_code != 200:
            print(f"::error::Firestore projects: {r.status_code} {r.text[:200]}")
            sys.exit(1)
        data = r.json()
        for doc in data.get("documents", []):
            f = doc.get("fields", {})
            if not f.get("isApp", {}).get("booleanValue"):
                continue
            pkg = _str(f, "androidPackage")
            bundle = _str(f, "iosBundleId")
            # El id de Supabase se deduce del package: 'clientes' o 'agentes'
            # aparecen en él. Un mapa fijo por projectId se rompería en cuanto
            # alguien recreara el proyecto en el dashboard.
            clave = next((k for k in APPS_SUPABASE if k in (pkg or bundle).lower()), None)
            if not clave:
                print(f"· {pkg or bundle}: no corresponde a ninguna app de Supabase, se omite")
                continue
            out.append({
                "projectId": doc["name"].rsplit("/", 1)[-1],
                "package": pkg,
                "bundleId": bundle,
                "idApp": APPS_SUPABASE[clave],
            })
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def filas_de(token: str, app: dict) -> list[dict]:
    """Las filas diarias de esa app, ya en la forma de la tabla de Supabase."""
    filas: list[dict] = []

    ga4 = raw_de(token, "ga4Installs", app["projectId"])
    for dia in ga4.get("dias") or []:
        for plat in ("android", "ios"):
            if dia.get(plat):
                filas.append({
                    "id_app": app["idApp"],
                    "fecha": dia["fecha"],
                    "plataforma": plat,
                    "instalaciones": dia[plat],
                    "estimado": False,
                    "fuente": "ga4",
                })

    # Apple sólo si GA4 todavía no cubre iOS: si los dos hablan del mismo día,
    # el de Analytics es el que mide las dos plataformas con el mismo criterio.
    if not any(f["plataforma"] == "ios" for f in filas) and app["bundleId"]:
        ios = raw_de(token, "appStoreInstalls", app["bundleId"])
        for punto in ios.get("serie") or []:
            if punto.get("descargas"):
                filas.append({
                    "id_app": app["idApp"],
                    "fecha": punto["fecha"],
                    "plataforma": "ios",
                    "instalaciones": punto["descargas"],
                    "estimado": False,
                    "fuente": "app_store",
                })

    return filas


def upsert(url: str, key: str, filas: list[dict]) -> str | None:
    """UPSERT por lotes. Devuelve el error, si lo hubo."""
    if not filas:
        return None
    r = requests.post(
        f"{url.rstrip('/')}/rest/v1/app_instalaciones_diarias",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # Sin esto PostgREST inserta y choca con la única; con esto pisa el
            # día, que es lo que se quiere cuando la tienda corrige su cifra.
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        params={"on_conflict": "id_app,fecha,plataforma"},
        json=filas,
        timeout=60,
    )
    if r.status_code not in (200, 201, 204):
        return f"Supabase {r.status_code}: {r.text[:300]}"
    return None


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

    if not fs_token:
        print("::error::Falta FIRESTORE_TOKEN.")
        sys.exit(1)
    if not url or not key:
        # A propósito no es un error: el portal es un consumidor extra y el
        # resto del sync ya hizo su trabajo. Fallar aquí dejaría en rojo un
        # workflow que sí actualizó las tarjetas del dashboard.
        print("· Sin SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: no se empuja al portal.")
        return

    total = 0
    for app in list_apps(fs_token):
        filas = filas_de(fs_token, app)
        if not filas:
            print(f"· {app['package'] or app['bundleId']}: todavía sin serie diaria que empujar.")
            continue
        error = upsert(url, key, filas)
        if error:
            print(f"⚠ {app['package'] or app['bundleId']}: {error}")
            continue
        total += len(filas)
        fechas = sorted({f["fecha"] for f in filas})
        print(
            f"✓ {app['package'] or app['bundleId']}: {len(filas)} filas "
            f"({fechas[0]} → {fechas[-1]}) al portal"
        )
    print(f"· Total empujado: {total} filas.")


if __name__ == "__main__":
    main()
