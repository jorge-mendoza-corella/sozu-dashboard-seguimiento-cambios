#!/usr/bin/env python3
"""
Empuja a Supabase qué versión de cada app está publicada en cada tienda y cuál
sigue en revisión, para que el Portal Alta Dirección pinte los mismos chips que
este dashboard.

Tercer puente del mismo tipo: las descargas viajan por `supabase_installs_push.py`
y el costo de publicar por `supabase_costos_push.py`. Todos por la misma razón:
el portal es un navegador contra Supabase y ninguna de estas fuentes se puede
consultar desde ahí.

Lee lo que ya dejaron los syncs en Firestore:

  playTracks/{androidPackage}   ← ci/play_tracks_sync.py
  appStoreStatus/{iosBundleId}  ← ci/appstore_status_sync.py

y escribe en `public.app_versiones_tienda` (UPSERT por id_app + plataforma).

IMPORTANTE — este script decide cuál es "la versión publicada", y ese criterio es
un espejo de `src/lib/playTracks.ts` (`playChannels`) y `src/lib/appStoreStatus.ts`
(`appStoreLiveVersion` / `appStoreEnCamino`). Si allá cambia, aquí también:

  · Play: la API marca `completed` un envío que Google todavía revisa, así que la
    publicada sale de la ficha pública (`storeVersion`) y el release del track
    queda como lo ENVIADO. Si los dos números no coinciden, lo enviado sigue en
    camino. Sin ficha pública no se afirma que está publicada.
  · Apple: solo cuenta como "en revisión" lo que está en manos de Apple. Un
    `PREPARE_FOR_SUBMISSION` es un borrador que nadie mandó y tratarlo como envío
    anunciaba "en revisión" de algo que Apple ni ha visto.

Variables de entorno (las mismas de los otros puentes):
  FIRESTORE_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GCP_PROJECT
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

# Orden en el que se busca una versión cuando la ficha pública no dice nada.
ORDEN_TRACKS = ["production", "beta", "alpha", "internal"]

# iOS: versiones que la gente ya puede bajar.
A_LA_VENTA = {"READY_FOR_SALE", "READY_FOR_DISTRIBUTION"}

# iOS: versiones EN MANOS DE APPLE — se enviaron y falta que conteste. Los
# rechazos cuentan: hubo envío y hay que reaccionar.
ENVIADAS = {
    "WAITING_FOR_REVIEW",
    "IN_REVIEW",
    "PENDING_APPLE_RELEASE",
    "PENDING_DEVELOPER_RELEASE",
    "PROCESSING_FOR_DISTRIBUTION",
    "PROCESSING_FOR_APP_STORE",
    "WAITING_FOR_EXPORT_COMPLIANCE",
    "REJECTED",
    "METADATA_REJECTED",
    "INVALID_BINARY",
}

# Mismo vocabulario que `versionStateInfo` en el dashboard.
ESTADOS_IOS = {
    "READY_FOR_SALE": "publicada",
    "READY_FOR_DISTRIBUTION": "publicada",
    "IN_REVIEW": "en revisión",
    "WAITING_FOR_REVIEW": "esperando revisión",
    "PENDING_APPLE_RELEASE": "aprobada, la libera Apple",
    "PENDING_DEVELOPER_RELEASE": "aprobada — falta publicarla",
    "PROCESSING_FOR_DISTRIBUTION": "procesando",
    "PROCESSING_FOR_APP_STORE": "procesando",
    "PREPARE_FOR_SUBMISSION": "sin enviar",
    "READY_FOR_REVIEW": "lista para enviar",
    "WAITING_FOR_EXPORT_COMPLIANCE": "falta cumplimiento de exportación",
    "REJECTED": "rechazada",
    "DEVELOPER_REJECTED": "rechazada",
    "METADATA_REJECTED": "metadatos rechazados",
    "INVALID_BINARY": "binario inválido",
    "REMOVED_FROM_SALE": "retirada",
    "DEVELOPER_REMOVED_FROM_SALE": "retirada",
}


def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _str(f: dict, key: str) -> str:
    return (f.get(key) or {}).get("stringValue", "").strip()


def doc_de(token: str, coleccion: str, doc_id: str) -> dict:
    """Campos de un documento del sync (crudos, como los da Firestore REST)."""
    r = requests.get(
        f"{FS_BASE}/{coleccion}/{quote(doc_id, safe='')}",
        headers=fs_headers(token), timeout=30,
    )
    if r.status_code != 200:
        return {}
    return (r.json().get("fields") or {})


def raw_json(campos: dict):
    """El campo `raw` del documento, ya parseado. `{}`/`[]` si no se puede."""
    crudo = (campos.get("raw") or {}).get("stringValue")
    if not crudo:
        return None
    try:
        return json.loads(crudo)
    except json.JSONDecodeError:
        return None


def list_apps(token: str) -> list[dict]:
    """Proyectos app del dashboard, con su package y bundle id."""
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
            clave = next((k for k in APPS_SUPABASE if k in (pkg or bundle).lower()), None)
            if not clave:
                print(f"· {pkg or bundle}: no corresponde a ninguna app de Supabase, se omite")
                continue
            out.append({
                "package": pkg,
                "bundleId": bundle,
                "idApp": APPS_SUPABASE[clave],
                "nombre": pkg or bundle,
            })
        page = data.get("nextPageToken")
        if not page:
            break
    return out


# ── Android ──────────────────────────────────────────────────────────────────

def version_de_release(rel: dict) -> str | None:
    """Nombre de la versión de un release; si Play no lo trae, su versionCode."""
    nombre = (rel.get("name") or "").strip()
    if nombre:
        return nombre
    codes = [int(c) for c in (rel.get("versionCodes") or []) if str(c).isdigit()]
    return str(max(codes)) if codes else None


def release_vigente(track: dict | None) -> dict | None:
    releases = (track or {}).get("releases") or []
    for estado in ("completed", "inProgress"):
        for r in releases:
            if r.get("status") == estado:
                return r
    return releases[0] if releases else None


def fila_android(app: dict, campos: dict) -> dict | None:
    tracks = raw_json(campos) or []
    if not isinstance(tracks, list):
        tracks = []
    store_version = (campos.get("storeVersion") or {}).get("stringValue") or None

    por_nombre = {str(t.get("track", "")).lower(): t for t in tracks}
    rel_prod = release_vigente(por_nombre.get("production"))
    enviada = version_de_release(rel_prod) if rel_prod else None
    build_prod = next(iter((rel_prod or {}).get("versionCodes") or []), None)

    # Sin ficha pública no hay con qué comparar: se dice lo único seguro —que se
    # envió— en vez de afirmar que está publicada.
    ya_salio = bool(store_version) and bool(enviada) and enviada == store_version

    publicada = store_version or enviada
    if not publicada:
        # Nada en producción: se cae al primer track con algo, para no dejar el
        # chip vacío cuando la app solo está en pruebas.
        for nombre in ORDEN_TRACKS:
            rel = release_vigente(por_nombre.get(nombre))
            v = version_de_release(rel) if rel else None
            if v:
                return {
                    "id_app": app["idApp"],
                    "plataforma": "android",
                    "version_publicada": v,
                    "build_publicado": str(next(iter(rel.get("versionCodes") or []), "")) or None,
                    "estado_publicada": f"solo en {nombre}",
                    "a_la_venta": False,
                    "canal": nombre,
                    "version_en_revision": None,
                    "estado_en_revision": None,
                    "raw": {"tracks": tracks, "storeVersion": store_version},
                }
        return None

    return {
        "id_app": app["idApp"],
        "plataforma": "android",
        "version_publicada": publicada,
        "build_publicado": str(build_prod) if ya_salio and build_prod else None,
        "estado_publicada": "disponible en Play" if store_version else "enviada · Play no confirma",
        "a_la_venta": bool(store_version),
        "canal": "production",
        "version_en_revision": None if ya_salio else enviada,
        "estado_en_revision": (
            None
            if ya_salio or not enviada
            else ("en revisión de Google" if store_version else "enviada a producción")
        ),
        "raw": {"tracks": tracks, "storeVersion": store_version},
    }


# ── iOS ──────────────────────────────────────────────────────────────────────

def fila_ios(app: dict, campos: dict) -> dict | None:
    raw = raw_json(campos) or {}
    versiones = [v for v in (raw.get("versions") or []) if (v.get("version") or "").strip()]
    if not versiones:
        return None

    viva = next((v for v in versiones if v.get("state") in A_LA_VENTA), None)
    publicada = viva or versiones[0]
    en_camino = next((v for v in versiones if v.get("state") in ENVIADAS), None)
    # Si la única enviada ES la publicada, no hay nada en camino.
    if en_camino and en_camino is publicada:
        en_camino = None

    estado_pub = publicada.get("state")
    return {
        "id_app": app["idApp"],
        "plataforma": "ios",
        "version_publicada": (publicada.get("version") or "").strip(),
        "build_publicado": None,
        "estado_publicada": ESTADOS_IOS.get(estado_pub, estado_pub or None),
        "a_la_venta": estado_pub in A_LA_VENTA,
        "canal": None,
        "version_en_revision": (en_camino.get("version") or "").strip() if en_camino else None,
        "estado_en_revision": (
            ESTADOS_IOS.get(en_camino.get("state"), en_camino.get("state")) if en_camino else None
        ),
        "raw": {"versions": versiones},
    }


# ── Supabase ─────────────────────────────────────────────────────────────────

def upsert(url: str, key: str, filas: list[dict]) -> str | None:
    if not filas:
        return None
    r = requests.post(
        f"{url.rstrip('/')}/rest/v1/app_versiones_tienda",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        params={"on_conflict": "id_app,plataforma"},
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
        print("· Sin SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: no se empujan las versiones.")
        return

    for app in list_apps(fs_token):
        filas: list[dict] = []

        if app["package"]:
            fila = fila_android(app, doc_de(fs_token, "playTracks", app["package"]))
            if fila:
                filas.append(fila)
        if app["bundleId"]:
            fila = fila_ios(app, doc_de(fs_token, "appStoreStatus", app["bundleId"]))
            if fila:
                filas.append(fila)

        if not filas:
            print(f"· {app['nombre']}: todavía sin versiones sincronizadas.")
            continue

        error = upsert(url, key, filas)
        if error:
            print(f"⚠ {app['nombre']}: {error}")
            continue

        detalle = " · ".join(
            f"{f['plataforma']} {f['version_publicada']}"
            + (f" (en revisión {f['version_en_revision']})" if f["version_en_revision"] else "")
            for f in filas
        )
        print(f"✓ {app['nombre']}: {detalle}")


if __name__ == "__main__":
    main()
