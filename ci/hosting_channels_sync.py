#!/usr/bin/env python3
"""
Vuelca a Firestore el estado de los canales de Firebase Hosting (preview) de
los sitios configurados, para que el dashboard sepa si un draft trae algo
distinto de lo que ya está publicado.

Un canal "draft" cuyo release apunta a la MISMA versión que el canal `live`
ya fue publicado: el dashboard entonces no muestra el badge DRAFT.

Corre en .github/workflows/play-tracks-sync.yml.

Variables de entorno:
  FIRESTORE_TOKEN   access token de GCP (sirve también para Hosting API)
  GCP_PROJECT       proyecto Firebase (default: sozu-admin-dev)
  HOSTING_SITES     sitios a revisar, separados por coma (default: sozu-avances)
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


def main() -> None:
    token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not token:
        fail("Falta FIRESTORE_TOKEN.")
    sites = [s.strip() for s in os.environ.get("HOSTING_SITES", "sozu-avances").split(",") if s.strip()]
    for site in sites:
        payload, error = fetch_channels(token, site)
        write_doc(token, site, payload, error)
        if error:
            print(f"⚠ {site}: {error}")
        else:
            pend = [c["id"] for c in payload["channels"] if not c["published"]]
            print(f"✓ {site}: {len(payload['channels'])} canal(es); sin publicar: {pend or 'ninguno'}")


if __name__ == "__main__":
    main()
