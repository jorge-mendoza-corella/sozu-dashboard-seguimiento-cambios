#!/usr/bin/env python3
"""
Vuelca a Firestore el estado de la app en App Store Connect (revisión, build en
proceso, versión publicada) para verlo en el dashboard.

A diferencia de Google Play, Apple SÍ expone el estado de revisión por API:
appStoreVersions.appVersionState y reviewSubmissions.state.

Corre junto a play_tracks_sync.py en .github/workflows/play-tracks-sync.yml.

Variables de entorno:
  FIRESTORE_TOKEN   access token de GCP (cuenta de Firebase) para Firestore REST
  ASC_KEY_ID        Key ID de la App Store Connect API
  ASC_ISSUER_ID     Issuer ID de la App Store Connect API
  ASC_PRIVATE_KEY   contenido del .p8 (incluye BEGIN/END PRIVATE KEY)
  GCP_PROJECT       id del proyecto Firebase (default: sozu-admin-dev)
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

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"
ASC_BASE = "https://api.appstoreconnect.apple.com/v1"


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


def asc_token() -> str:
    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"},
        os.environ["ASC_PRIVATE_KEY"].replace("\\n", "\n"),
        algorithm="ES256",
        headers={"kid": os.environ["ASC_KEY_ID"], "typ": "JWT"},
    )


def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def list_ios_bundles(token: str) -> list[tuple[str, str]]:
    """(bundleId, projectId) de los proyectos marcados como app con bundle iOS."""
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
            bundle = f.get("iosBundleId", {}).get("stringValue")
            if f.get("isApp", {}).get("booleanValue") and bundle:
                out.append((bundle, doc["name"].rsplit("/", 1)[-1]))
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def asc_get(token: str, path: str, params: dict | None = None) -> tuple[dict | None, str | None]:
    r = requests.get(
        f"{ASC_BASE}/{path}", headers={"Authorization": f"Bearer {token}"}, params=params or {}, timeout=30
    )
    if r.status_code != 200:
        try:
            detail = r.json()["errors"][0].get("detail", r.text[:200])
        except Exception:
            detail = r.text[:200]
        return None, f"App Store Connect {r.status_code}: {detail}"
    return r.json(), None


def fetch_status(token: str, bundle: str) -> tuple[dict | None, str | None]:
    apps, err = asc_get(token, "apps", {"filter[bundleId]": bundle, "limit": 1})
    if err:
        return None, err
    items = apps.get("data", [])
    if not items:
        return None, (
            f"App Store Connect no tiene ninguna app con bundle id '{bundle}'. "
            "Revisa el Bundle ID iOS del proyecto."
        )
    app = items[0]
    app_id = app["id"]

    versions, err = asc_get(token, f"apps/{app_id}/appStoreVersions", {"limit": 3})
    if err:
        return None, err
    builds, _ = asc_get(token, "builds", {"filter[app]": app_id, "limit": 3})
    reviews, _ = asc_get(token, "reviewSubmissions", {"filter[app]": app_id, "limit": 3})

    def attrs(node: dict) -> dict:
        return node.get("attributes", {}) or {}

    return {
        "appName": attrs(app).get("name"),
        "appId": app_id,
        "versions": [
            {
                "version": attrs(v).get("versionString"),
                # appVersionState es el campo vigente; appStoreState es el
                # heredado. Se guardan ambos y el front usa el que venga.
                "state": attrs(v).get("appVersionState") or attrs(v).get("appStoreState"),
                "platform": attrs(v).get("platform"),
                "createdDate": attrs(v).get("createdDate"),
            }
            for v in (versions.get("data") or [])
        ],
        "builds": [
            {
                "version": attrs(b).get("version"),
                "processingState": attrs(b).get("processingState"),
                "uploadedDate": attrs(b).get("uploadedDate"),
                "expired": attrs(b).get("expired"),
            }
            for b in ((builds or {}).get("data") or [])
        ],
        "reviewSubmissions": [
            {
                "state": attrs(s).get("state"),
                "submittedDate": attrs(s).get("submittedDate"),
            }
            for s in ((reviews or {}).get("data") or [])
        ],
    }, None


def write_doc(token: str, bundle: str, project_id: str, payload: dict | None, error: str | None) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    body = {
        "fields": {
            "bundleId": {"stringValue": bundle},
            "projectId": {"stringValue": project_id},
            "updatedAt": {"timestampValue": now},
            "raw": {"stringValue": json.dumps(payload or {}, ensure_ascii=False)},
            "error": {"stringValue": error} if error else {"nullValue": None},
        }
    }
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in body["fields"])
    r = requests.patch(
        f"{FS_BASE}/appStoreStatus/{quote(bundle, safe='')}?{mask}",
        headers=fs_headers(token), json=body, timeout=30,
    )
    if r.status_code not in (200, 201):
        fail(f"Firestore write {bundle}: {r.status_code} {r.text[:300]}")


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not fs_token:
        fail("Falta FIRESTORE_TOKEN.")
    if not all(os.environ.get(k, "").strip() for k in ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_PRIVATE_KEY")):
        print("Sin credenciales de App Store Connect: no hay nada que consultar en iOS.")
        return

    bundles = list_ios_bundles(fs_token)
    if not bundles:
        print("Ningún proyecto tiene Bundle ID iOS configurado. Nada que sincronizar.")
        return

    token = asc_token()
    for bundle, project_id in bundles:
        payload, error = fetch_status(token, bundle)
        write_doc(fs_token, bundle, project_id, payload, error)
        if error:
            print(f"⚠ {bundle}: {error}")
        else:
            v = (payload.get("versions") or [{}])[0]
            print(f"✓ {bundle}: versión {v.get('version')} · {v.get('state')}")


if __name__ == "__main__":
    main()
