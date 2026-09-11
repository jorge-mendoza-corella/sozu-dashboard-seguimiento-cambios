#!/usr/bin/env python3
"""
Empuja a Supabase qué versión de cada app está en la calle, para que el Portal
Alta Dirección la enseñe junto a las descargas.

Mismo motivo que `supabase_installs_push.py`: el portal es un navegador contra
Supabase, y ninguna de las dos tiendas se puede consultar desde ahí —App Store
Connect exige firmar un JWT ES256 con la llave .p8, y Google Play ni siquiera
dice si terminó de revisar un envío—. Eso ya lo resuelven `play_tracks_sync.py`
y `appstore_status_sync.py`, que dejan el estado crudo en Firestore; lo único
que faltaba era llevarlo a donde el portal sí puede leerlo.

Lo que se escribe NO es el crudo, es el mismo veredicto que pinta la tarjeta del
dashboard. Cuál es "la versión publicada" no es leer un campo:

  · Play llama `completed` a un envío que Google todavía revisa, así que la
    publicada sale de la ficha pública (`storeVersion`) y el release del track
    queda como lo ENVIADO. La app de clientes llegó a anunciar 1.1.5 en
    producción teniendo 1.0.9 en la tienda.
  · En Apple, un borrador en `PREPARE_FOR_SUBMISSION` no es "lo que viene": lo
    crea la consola al preparar la siguiente entrega y puede quedarse semanas.

Por eso el criterio se replica aquí tal cual está en `src/lib/playTracks.ts` y
`src/lib/appStoreStatus.ts`, y no se reinventa: dos tableros con dos criterios
acaban diciendo cosas distintas de lo mismo, que es peor que no decir nada.

Escribe en `public.app_versiones_tienda` con UPSERT sobre (id_app, plataforma):
es una foto del ahora, una fila por tienda y app, sin histórico.

Variables de entorno:
  FIRESTORE_TOKEN             access token de GCP para Firestore REST
  SUPABASE_URL                base a la que escribir. El workflow la saca de
                              `DASHBOARD_SUPABASE_URL`, un secreto propio: los
                              `SUPABASE_*` que ya existían son la config del
                              front y apuntan a la base de DEV, así que
                              reusarlos habría escrito en el lado equivocado
                              sin que nada fallara.
  SUPABASE_SERVICE_ROLE_KEY   llave de servicio de ESA base (salta RLS). Sin
                              ella el script no hace nada y lo dice: es un
                              extra, no debe tumbar el resto del sync.
  GCP_PROJECT                 id del proyecto Firebase (default: sozu-admin-dev)
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from urllib.parse import quote

import requests

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"

# Ids de `public.apps` en Supabase. Es catálogo: 1 = clientes, 2 = agentes.
APPS_SUPABASE = {"clientes": 1, "agentes": 2}

# --- Google Play -----------------------------------------------------------

ORDEN_TRACKS = ["production", "beta", "alpha", "internal"]

ESTADO_RELEASE = {
    "completed": "publicado",
    "inProgress": "en despliegue",
    "draft": "borrador",
    "halted": "detenido",
}

# --- App Store Connect -----------------------------------------------------

A_LA_VENTA = {"READY_FOR_SALE", "READY_FOR_DISTRIBUTION"}

# Versiones que están EN MANOS DE APPLE: se enviaron y falta que conteste. Un
# borrador sin enviar no entra; los rechazos sí, porque hubo envío y hay que
# reaccionar.
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

ESTADO_VERSION = {
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
    "DEVELOPER_REMOVED_FROM_SALE": "retirada",
    "REMOVED_FROM_SALE": "retirada",
    "REPLACED_WITH_NEW_VERSION": "reemplazada",
}


def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _str(f: dict, key: str) -> str:
    return (f.get(key) or {}).get("stringValue", "").strip()


def fields_de(token: str, coleccion: str, doc_id: str) -> dict:
    """`fields` de un documento del sync, o {} si no existe."""
    r = requests.get(
        f"{FS_BASE}/{coleccion}/{quote(doc_id, safe='')}",
        headers=fs_headers(token), timeout=30,
    )
    if r.status_code != 200:
        return {}
    return r.json().get("fields") or {}


def raw_json(fields: dict):
    """El campo `raw` del documento, ya parseado. `None` si no se puede leer."""
    crudo = (fields.get("raw") or {}).get("stringValue")
    if not crudo:
        return None
    try:
        return json.loads(crudo)
    except json.JSONDecodeError:
        return None


def estado_version(state: str | None) -> str | None:
    if not state:
        return None
    return ESTADO_VERSION.get(state, state.lower().replace("_", " "))


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
            if not pkg and not bundle:
                continue
            # El id de Supabase se deduce del package, igual que en el puente de
            # descargas: un mapa fijo por projectId se rompería en cuanto alguien
            # recreara el proyecto en el dashboard.
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


def version_de_release(rel: dict) -> str | None:
    """Nombre de la versión de un release; si Play no lo trae, su versionCode."""
    nombre = (rel.get("name") or "").strip()
    if nombre:
        return nombre
    codigos = [int(c) for c in (rel.get("versionCodes") or []) if str(c).isdigit()]
    return str(max(codigos)) if codigos else None


def release_vigente(track: dict | None) -> dict | None:
    """El release que manda en un track: publicado, si no en despliegue, si no el primero."""
    releases = (track or {}).get("releases") or []
    for estado in ("completed", "inProgress"):
        for rel in releases:
            if rel.get("status") == estado:
                return rel
    return releases[0] if releases else None


def track_de(tracks: list[dict], nombre: str) -> dict | None:
    return next((t for t in tracks if (t.get("track") or "").lower() == nombre), None)


def fila_play(app: dict, fields: dict) -> dict | None:
    """La fila de Android: lo que Play sirve hoy y lo que sigue en camino."""
    tracks = raw_json(fields)
    if not isinstance(tracks, list):
        tracks = []
    store_version = _str(fields, "storeVersion") or None

    rel_prod = release_vigente(track_de(tracks, "production"))
    enviada = version_de_release(rel_prod) if rel_prod else None

    # Lo primero es lo que la tienda sirve de verdad: la API llama `completed` a
    # un envío que Google todavía revisa.
    if store_version:
        publicada, canal, a_la_venta = store_version, "production", True
        estado = "disponible en Play"
        build = (rel_prod.get("versionCodes") or [None])[0] if rel_prod and enviada == store_version else None
    else:
        publicada = canal = estado = build = None
        a_la_venta = False
        propios = [(t.get("track") or "").lower() for t in tracks if (t.get("track") or "").strip()]
        for nombre in ORDEN_TRACKS + [t for t in propios if t not in ORDEN_TRACKS]:
            rel = release_vigente(track_de(tracks, nombre))
            version = version_de_release(rel) if rel else None
            if version:
                publicada, canal = version, nombre
                # Sin ficha pública que lo confirme, "a la venta" solo puede
                # afirmarse de producción; un track de prueba no es lo que la
                # gente tiene instalado.
                a_la_venta = canal == "production"
                estado = ESTADO_RELEASE.get(rel.get("status"), rel.get("status"))
                build = (rel.get("versionCodes") or [None])[0]
                break

    if not publicada and not enviada:
        return None

    # Lo enviado a producción que la ficha pública todavía no confirma.
    ya_salio = bool(store_version) and enviada == store_version
    en_revision = enviada if enviada and not ya_salio else None

    return {
        "id_app": app["idApp"],
        "plataforma": "android",
        "version_publicada": publicada,
        "build_publicado": str(build) if build else None,
        "estado_publicada": estado,
        "a_la_venta": a_la_venta,
        "canal": canal,
        "version_en_revision": en_revision,
        "estado_en_revision": (
            None if not en_revision
            else "en revisión de Google" if store_version
            else "enviada a producción"
        ),
        "raw": {"tracks": tracks, "storeVersion": store_version},
    }


def fila_appstore(app: dict, fields: dict) -> dict | None:
    """La fila de iOS: lo que se puede bajar hoy y lo que Apple tiene en manos."""
    crudo = raw_json(fields)
    if not isinstance(crudo, dict):
        return None
    versiones = [v for v in (crudo.get("versions") or []) if (v.get("version") or "").strip()]
    if not versiones:
        return None

    viva = next((v for v in versiones if v.get("state") in A_LA_VENTA), None)
    # Exigir una a la venta dejaba un guión justo después de publicar la
    # primera, mientras Apple revisa: se cae a la última enviada y se distingue
    # con `a_la_venta`.
    publicada = viva or versiones[0]
    a_la_venta = viva is not None

    # Lo que viene detrás solo tiene sentido cuando hay otra a la venta: sin
    # ella, la que está en manos de Apple ES la que se está mostrando.
    en_camino = (
        next((v for v in versiones if v.get("state") in ENVIADAS), None) if a_la_venta else None
    )

    version = (publicada.get("version") or "").strip()
    build = next(
        (
            (b.get("version") or "").strip()
            for b in (crudo.get("builds") or [])
            if (b.get("shortVersion") or "").strip() == version
        ),
        None,
    )

    return {
        "id_app": app["idApp"],
        "plataforma": "ios",
        "version_publicada": version,
        "build_publicado": build or None,
        "estado_publicada": estado_version(publicada.get("state")),
        "a_la_venta": a_la_venta,
        # Apple no tiene tracks: la columna es de Play.
        "canal": None,
        "version_en_revision": (en_camino.get("version") or "").strip() if en_camino else None,
        "estado_en_revision": estado_version(en_camino.get("state")) if en_camino else None,
        "raw": {"versions": versiones, "builds": crudo.get("builds") or []},
    }


def upsert(url: str, key: str, filas: list[dict]) -> str | None:
    """UPSERT de la foto completa. Devuelve el error, si lo hubo."""
    if not filas:
        return None
    # El sello lo pone el script y no un `now()` en el JSON: PostgREST no evalúa
    # SQL dentro del cuerpo, lo mandaría como el texto "now()" y el cast a
    # timestamptz reventaría el lote entero.
    ahora = datetime.now(timezone.utc).isoformat()
    r = requests.post(
        f"{url.rstrip('/')}/rest/v1/app_versiones_tienda",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # Una fila por app y tienda: cada corrida pisa la anterior, que es
            # justo lo que se quiere de una foto del ahora.
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        params={"on_conflict": "id_app,plataforma"},
        json=[{**f, "fecha_actualizacion": ahora} for f in filas],
        timeout=60,
    )
    if r.status_code not in (200, 201, 204):
        return f"Supabase {r.status_code}: {r.text[:300]}"
    return None


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not fs_token:
        print("::error::Falta FIRESTORE_TOKEN.")
        sys.exit(1)

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        # Consumidor extra: sin llave se salta y lo dice, no tumba el sync de
        # las tarjetas, que es lo que de verdad depende de este workflow.
        print("Sin SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: no se empujan las versiones.")
        return

    apps = list_apps(fs_token)
    if not apps:
        print("Ningún proyecto app con package o bundle id. Nada que empujar.")
        return

    filas: list[dict] = []
    for app in apps:
        etiqueta = app["package"] or app["bundleId"]
        if app["package"]:
            fila = fila_play(app, fields_de(fs_token, "playTracks", app["package"]))
            if fila:
                filas.append(fila)
                print(
                    f"· {etiqueta} android: {fila['version_publicada']}"
                    + (f" (+{fila['version_en_revision']} en camino)" if fila["version_en_revision"] else "")
                )
            else:
                print(f"· {etiqueta} android: sin versión que reportar")
        if app["bundleId"]:
            fila = fila_appstore(app, fields_de(fs_token, "appStoreStatus", app["bundleId"]))
            if fila:
                filas.append(fila)
                print(
                    f"· {etiqueta} ios: {fila['version_publicada']}"
                    + (f" (+{fila['version_en_revision']} en camino)" if fila["version_en_revision"] else "")
                )
            else:
                print(f"· {etiqueta} ios: sin versión que reportar")

    error = upsert(url, key, filas)
    if error:
        # Igual que el puente de descargas: se avisa sin romper el workflow.
        print(f"::warning::{error}")
        return
    print(f"{len(filas)} fila(s) escritas en app_versiones_tienda.")


if __name__ == "__main__":
    main()
