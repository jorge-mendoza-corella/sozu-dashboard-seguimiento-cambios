#!/usr/bin/env python3
"""
Vuelca el estado de los tracks de Google Play a Firestore para que el dashboard
los muestre sin entrar a Play Console.

Corre en GitHub Actions (ver .github/workflows/play-tracks-sync.yml):
  1. Lee de Firestore los proyectos marcados como app con `androidPackage`.
  2. Por cada package consulta la Play Developer API (edits.tracks.list).
  3. Escribe el resultado en Firestore `playTracks/{package}`.

Variables de entorno:
  FIRESTORE_TOKEN   access token de GCP (cuenta de Firebase) para Firestore REST
  PLAY_SA_JSON      JSON del service account con acceso a Play Console. Si no
                    viene, se usa el que el root haya dejado desde el dashboard
                    (Firestore storeCredentials/play).
  GCP_PROJECT       id del proyecto Firebase (default: sozu-admin-dev)

La API de Play exige abrir un "edit" (transacción) incluso para leer tracks; el
edit se descarta al terminar (nunca se hace commit, así que no toca la app).
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from urllib.parse import quote

import jwt  # PyJWT
import requests

from store_credentials import play_service_account

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"
PLAY_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications"
PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher"


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


# --- Auth Play ---------------------------------------------------------------

def play_access_token(sa: dict) -> str:
    """Token OAuth para la Play Developer API (flujo JWT bearer del service account)."""
    now = int(time.time())
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
    r = requests.post(
        sa["token_uri"],
        data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
        timeout=30,
    )
    if r.status_code != 200:
        fail(f"No se pudo obtener token de Play: {r.status_code} {r.text[:300]}")
    return r.json()["access_token"]


# --- Firestore ---------------------------------------------------------------

def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def list_android_packages(token: str) -> list[tuple[str, str]]:
    """(packageName, projectId) de los proyectos marcados como app con package."""
    out: list[tuple[str, str]] = []
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
            pkg = f.get("androidPackage", {}).get("stringValue")
            if f.get("isApp", {}).get("booleanValue") and pkg:
                out.append((pkg, doc["name"].rsplit("/", 1)[-1]))
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def write_tracks_doc(token: str, pkg: str, project_id: str, tracks: list | None, error: str | None) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    # `raw` guarda el JSON tal cual: el front lo parsea. Evita mapear estructuras
    # anidadas al formato tipado de Firestore (y sobrevive cambios de la API).
    body = {
        "fields": {
            "package": {"stringValue": pkg},
            "projectId": {"stringValue": project_id},
            "updatedAt": {"timestampValue": now},
            "raw": {"stringValue": json.dumps(tracks or [], ensure_ascii=False)},
            "error": {"stringValue": error} if error else {"nullValue": None},
        }
    }
    mask = "".join(f"&updateMask.fieldPaths={k}" for k in body["fields"])
    url = f"{FS_BASE}/playTracks/{quote(pkg, safe='')}?{mask.lstrip('&')}"
    r = requests.patch(url, headers=fs_headers(token), json=body, timeout=30)
    if r.status_code not in (200, 201):
        fail(f"Firestore write {pkg}: {r.status_code} {r.text[:300]}")


# --- Play --------------------------------------------------------------------

def fetch_tracks(token: str, pkg: str, sa_email: str) -> tuple[list | None, str | None]:
    h = {"Authorization": f"Bearer {token}"}
    r = requests.post(f"{PLAY_BASE}/{pkg}/edits", headers=h, timeout=30)
    if r.status_code != 200:
        detail = r.json().get("error", {}).get("message", r.text[:200]) if r.text else r.reason
        if r.status_code in (401, 403):
            return None, (
                f"El service account {sa_email} no tiene acceso a '{pkg}' en Play Console. "
                "Invítalo en Play Console → Users and permissions con el permiso "
                f"'View app information'. Detalle: {detail}"
            )
        if r.status_code == 404:
            return None, f"Play no conoce el package '{pkg}'. Revisa el Package Android del proyecto. Detalle: {detail}"
        return None, f"Play API {r.status_code}: {detail}"
    edit_id = r.json()["id"]
    try:
        t = requests.get(f"{PLAY_BASE}/{pkg}/edits/{edit_id}/tracks", headers=h, timeout=30)
        if t.status_code != 200:
            return None, f"Play tracks {t.status_code}: {t.text[:200]}"
        return t.json().get("tracks", []), None
    finally:
        # El edit es una transacción abierta: descartarla deja la app intacta.
        requests.delete(f"{PLAY_BASE}/{pkg}/edits/{edit_id}", headers=h, timeout=30)


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not fs_token:
        fail("Falta FIRESTORE_TOKEN.")
    # Del entorno (Secret Manager) o, si no está, de lo que el root dejó en el
    # dashboard: sin esto el sync callaba y las tiendas salían vacías.
    raw_sa, origen = play_service_account(FS_BASE, fs_token)
    if not raw_sa:
        print(
            "Sin service account de Play: créalo como secret DASHBOARD_PLAY_SERVICE_ACCOUNT "
            "o subelo desde el dashboard (panel de la app > Cuenta de servicio de Play). "
            "Nada que hacer."
        )
        return
    print(f"· service account de Play tomado del {origen}")
    try:
        sa = json.loads(raw_sa)
    except json.JSONDecodeError as e:
        fail(f"PLAY_SA_JSON no es JSON válido ({e}). Debe ser el archivo completo del service account, desde '{{' hasta '}}'.")

    packages = list_android_packages(fs_token)
    if not packages:
        print("Ningún proyecto tiene Package Android configurado. Nada que sincronizar.")
        return

    play_token = play_access_token(sa)
    for pkg, project_id in packages:
        tracks, error = fetch_tracks(play_token, pkg, sa.get("client_email", "?"))
        write_tracks_doc(fs_token, pkg, project_id, tracks, error)
        if error:
            print(f"⚠ {pkg}: {error}")
        else:
            resumen = ", ".join(
                f"{t.get('track')}={len(t.get('releases') or [])} release(s)" for t in (tracks or [])
            ) or "sin tracks"
            print(f"✓ {pkg}: {resumen}")


if __name__ == "__main__":
    main()
