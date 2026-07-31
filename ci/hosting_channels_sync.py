#!/usr/bin/env python3
"""
Vuelca a Firestore el estado de los canales de Firebase Hosting (preview) de
los sitios configurados, para que el dashboard sepa si un draft trae algo
distinto de lo que ya está publicado.

Un canal "draft" cuyo release apunta a la MISMA versión que el canal `live`
ya fue publicado: el dashboard entonces no muestra el badge DRAFT.

Corre en .github/workflows/play-tracks-sync.yml.

Dos formas de averiguarlo, en orden:

  1. Hosting API — exacta, pero exige que la cuenta de servicio tenga permiso
     sobre el sitio (rol "Firebase Hosting Viewer" en el proyecto dueño).
  2. Comparar el contenido servido por el canal contra el del sitio en vivo.
     El banner de borrador de estos sitios se activa por hostname en el
     navegador, así que el HTML servido es idéntico byte a byte una vez que el
     draft se publicó. No requiere permisos: es HTTP público.

Variables de entorno:
  FIRESTORE_TOKEN   access token de GCP (sirve también para Hosting API)
  GCP_PROJECT       proyecto Firebase (default: sozu-admin-dev)
  HOSTING_SITES     sitios a revisar, separados por coma (default: sozu-avances)
  HOSTING_COMPARE   respaldo sin permisos, uno por línea o separados por ';':
                    "sitio|https://url-en-vivo|https://url-del-draft"
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from urllib.parse import quote

import requests

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"
HOSTING_BASE = "https://firebasehosting.googleapis.com/v1beta1"


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


def headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def version_of(channel: dict) -> str | None:
    """Nombre de la versión desplegada en el canal (identifica el contenido)."""
    return (((channel.get("release") or {}).get("version") or {}).get("name")) or None


def fetch_channels(token: str, site: str) -> tuple[dict | None, str | None]:
    r = requests.get(
        f"{HOSTING_BASE}/sites/{site}/channels",
        headers={"Authorization": f"Bearer {token}"},
        params={"pageSize": 50},
        timeout=30,
    )
    if r.status_code != 200:
        try:
            detail = r.json()["error"]["message"]
        except Exception:
            detail = r.text[:200]
        if r.status_code in (401, 403):
            return None, (
                f"La cuenta de servicio del dashboard no tiene acceso al sitio de Hosting '{site}'. "
                "Dale el rol 'Firebase Hosting Viewer' en el proyecto dueño del sitio. "
                f"Detalle: {detail}"
            )
        if r.status_code == 404:
            return None, f"No existe el sitio de Hosting '{site}' (o no es visible). Detalle: {detail}"
        return None, f"Hosting API {r.status_code}: {detail}"

    channels = r.json().get("channels", [])
    live_version = None
    others = []
    for c in channels:
        cid = c["name"].rsplit("/", 1)[-1]
        entry = {
            "id": cid,
            "url": c.get("url"),
            "version": version_of(c),
            "updateTime": c.get("updateTime"),
            "expireTime": c.get("expireTime"),
        }
        if cid == "live":
            live_version = entry["version"]
        else:
            others.append(entry)

    # Un canal cuenta como "pendiente de publicar" si su contenido difiere del
    # que está en vivo. Sin versión en el canal no hay nada que mostrar.
    for c in others:
        c["published"] = bool(c["version"]) and c["version"] == live_version

    return {"site": site, "liveVersion": live_version, "channels": others}, None


def write_doc(token: str, site: str, payload: dict | None, error: str | None) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    body = {
        "fields": {
            "site": {"stringValue": site},
            "updatedAt": {"timestampValue": now},
            "raw": {"stringValue": json.dumps(payload or {}, ensure_ascii=False)},
            "error": {"stringValue": error} if error else {"nullValue": None},
        }
    }
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in body["fields"])
    r = requests.patch(
        f"{FS_BASE}/hostingChannels/{quote(site, safe='')}?{mask}",
        headers=headers(token), json=body, timeout=30,
    )
    if r.status_code not in (200, 201):
        fail(f"Firestore write {site}: {r.status_code} {r.text[:300]}")


def page_hash(url: str) -> tuple[str | None, str | None]:
    try:
        r = requests.get(url, timeout=30, headers={"Cache-Control": "no-cache"})
    except requests.RequestException as e:
        return None, f"no se pudo leer {url}: {e}"
    if r.status_code != 200:
        return None, f"{url} respondió {r.status_code}"
    return hashlib.sha256(r.content).hexdigest(), None


def compare_by_content(site: str, live_url: str, draft_url: str) -> tuple[dict | None, str | None]:
    """Respaldo sin permisos: el draft ya está publicado si sirve lo mismo que producción."""
    live, err1 = page_hash(live_url)
    draft, err2 = page_hash(draft_url)
    if err1 or err2:
        return None, err1 or err2
    return {
        "site": site,
        "liveVersion": live,
        "source": "contenido",
        "channels": [{
            "id": "draft",
            "url": draft_url,
            "version": draft,
            "published": draft == live,
        }],
    }, None


def parse_compare_config() -> dict[str, tuple[str, str]]:
    raw = os.environ.get("HOSTING_COMPARE", "").replace("\n", ";")
    out: dict[str, tuple[str, str]] = {}
    for item in raw.split(";"):
        parts = [p.strip() for p in item.split("|")]
        if len(parts) == 3 and all(parts):
            out[parts[0]] = (parts[1], parts[2])
    return out


def draft_url_from_settings(token: str) -> str | None:
    """URL del canal draft que el root dejó en el dashboard (settings/avances).

    Tiene prioridad sobre la del workflow: el canal cambia de URL cada vez que
    se crea uno nuevo, y así se actualiza sin tocar el repositorio.
    """
    r = requests.get(f"{FS_BASE}/settings/avances", headers=headers(token), timeout=30)
    if r.status_code != 200:
        return None
    url = (r.json().get("fields", {}).get("draftUrl", {}) or {}).get("stringValue")
    return url.strip() if url and url.strip() else None


def main() -> None:
    token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not token:
        fail("Falta FIRESTORE_TOKEN.")
    sites = [s.strip() for s in os.environ.get("HOSTING_SITES", "sozu-avances").split(",") if s.strip()]
    compare = parse_compare_config()

    for site in sites:
        payload, error = fetch_channels(token, site)
        if error and site in compare:
            # Sin permisos sobre el sitio: decidir por el contenido servido.
            live_url, draft_url = compare[site]
            if site == "sozu-avances":
                draft_url = draft_url_from_settings(token) or draft_url
            print(f"· {site}: sin acceso a la Hosting API, comparando contenido ({error.split('Detalle:')[0].strip()})")
            payload, error = compare_by_content(site, live_url, draft_url)
        write_doc(token, site, payload, error)
        if error:
            print(f"⚠ {site}: {error}")
        else:
            pend = [c["id"] for c in payload["channels"] if not c["published"]]
            via = payload.get("source", "hosting api")
            print(f"✓ {site} (via {via}): {len(payload['channels'])} canal(es); sin publicar: {pend or 'ninguno'}")


if __name__ == "__main__":
    main()
