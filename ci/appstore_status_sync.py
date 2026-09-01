#!/usr/bin/env python3
"""
Vuelca a Firestore el estado de la app en App Store Connect (revisión, build en
proceso, versión publicada) para verlo en el dashboard.

A diferencia de Google Play, Apple SÍ expone el estado de revisión por API:
appStoreVersions.appVersionState y reviewSubmissions.state.

Corre junto a play_tracks_sync.py en .github/workflows/play-tracks-sync.yml.

Las credenciales se resuelven POR PROYECTO: cada app puede estar en la cuenta de
App Store Connect de otra empresa, y una llave única para todas contestaba "no
existe ninguna app con ese bundle id". Orden: el doc privado del proyecto, luego
el entorno, luego el global heredado (ver store_credentials.py).

Variables de entorno:
  FIRESTORE_TOKEN   access token de GCP (cuenta de Firebase) para Firestore REST
  ASC_KEY_ID        Key ID de la App Store Connect API
  ASC_ISSUER_ID     Issuer ID de la App Store Connect API
  ASC_PRIVATE_KEY   contenido del .p8 (incluye BEGIN/END PRIVATE KEY)
                    Las tres son solo el respaldo de los proyectos que todavía no
                    tienen su propia llave guardada desde el dashboard.
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

from store_credentials import app_store_connect_for

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"
ASC_BASE = "https://api.appstoreconnect.apple.com/v1"


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


def asc_token(creds: dict) -> tuple[str | None, str | None]:
    """(JWT para la App Store Connect API, error).

    El error se devuelve en vez de cortar el script: con una llave por proyecto,
    un .p8 mal pegado solo debe romper la app de ese proyecto.
    """
    now = int(time.time())
    try:
        return jwt.encode(
            {"iss": creds["issuer_id"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"},
            creds["private_key"].replace("\\n", "\n"),
            algorithm="ES256",
            headers={"kid": creds["key_id"], "typ": "JWT"},
        ), None
    except (KeyError, TypeError, ValueError, jwt.PyJWTError) as e:
        # PyJWT levanta InvalidKeyError si el .p8 llegó cortado o no es EC.
        return None, (
            f"La llave de App Store Connect no sirve para firmar ({type(e).__name__}: {e}). "
            "Vuelve a pegar el .p8 completo, con las líneas BEGIN/END PRIVATE KEY."
        )


def token_de(creds: dict, cache: dict[str, tuple[str | None, str | None]]) -> tuple[str | None, str | None]:
    """JWT de ASC cacheado por `key_id`.

    Varias apps de la misma empresa comparten llave: firmar una vez por app sería
    trabajo repetido para un token idéntico.
    """
    clave = creds.get("key_id") or "?"
    if clave not in cache:
        cache[clave] = asc_token(creds)
    return cache[clave]


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

    # 10 versiones, no 3: la que está A LA VENTA puede quedar varias posiciones
    # atrás cuando hay rechazos y reenvíos, y sin ella el canal de producción se
    # queda en blanco justo en la app que sí está publicada.
    versions, err = asc_get(token, f"apps/{app_id}/appStoreVersions", {"limit": 10})
    if err:
        return None, err
    # Los builds traen el número de build ("82") pero NO la versión de mercado
    # ("1.0.8"): esa vive en `preReleaseVersion`. Y para los testers externos, un
    # build no está en TestFlight hasta que Apple aprueba su beta review, que es
    # `betaAppReviewSubmission`. Sin esos dos includes no se puede decir qué
    # versión están viendo los testers, que es justo lo que se pide.
    builds, _ = asc_get(token, "builds", {
        "filter[app]": app_id,
        "limit": 10,
        "sort": "-uploadedDate",
        "include": "preReleaseVersion,betaAppReviewSubmission",
    })
    reviews, _ = asc_get(token, "reviewSubmissions", {"filter[app]": app_id, "limit": 3})

    def attrs(node: dict) -> dict:
        return node.get("attributes", {}) or {}

    # `included` llega como una bolsa plana: se indexa por (tipo, id) para poder
    # resolver las relaciones de cada build.
    incluidos = {
        (n.get("type"), n.get("id")): attrs(n)
        for n in ((builds or {}).get("included") or [])
    }

    def relacion(build: dict, nombre: str, tipo: str) -> dict:
        ref = ((build.get("relationships") or {}).get(nombre) or {}).get("data") or {}
        return incluidos.get((tipo, ref.get("id")), {})

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
                # `version` de un build es el NÚMERO de build ("82"); la versión
                # de mercado ("1.0.8") va aparte, en shortVersion.
                "version": attrs(b).get("version"),
                "shortVersion": relacion(b, "preReleaseVersion", "preReleaseVersions").get("version"),
                "processingState": attrs(b).get("processingState"),
                "uploadedDate": attrs(b).get("uploadedDate"),
                "expirationDate": attrs(b).get("expirationDate"),
                "expired": attrs(b).get("expired"),
                # INTERNAL_ONLY = solo el equipo; APP_STORE_ELIGIBLE = puede ir a
                # testers externos y a la tienda.
                "audience": attrs(b).get("buildAudienceType"),
                "betaState": relacion(
                    b, "betaAppReviewSubmission", "betaAppReviewSubmissions"
                ).get("betaReviewState"),
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

    bundles = list_ios_bundles(fs_token)
    if not bundles:
        print("Ningún proyecto tiene Bundle ID iOS configurado. Nada que sincronizar.")
        return

    tokens: dict[str, tuple[str | None, str | None]] = {}
    for bundle, project_id in bundles:
        # La llave es de ESTA app: la de su proyecto y, mientras nadie la haya
        # migrado, el respaldo del entorno o el global.
        creds, origen = app_store_connect_for(FS_BASE, fs_token, project_id)
        if not creds:
            error = (
                f"El proyecto '{project_id}' no tiene llave de App Store Connect. Súbela en el "
                "dashboard (panel de la app > App Store Connect): Key ID, Issuer ID y el .p8 de "
                "la cuenta de Apple de esa empresa."
            )
            write_doc(fs_token, bundle, project_id, None, error)
            print(f"⚠ {bundle}: {error}")
            continue

        token, error = token_de(creds, tokens)
        if error:
            write_doc(fs_token, bundle, project_id, None, error)
            print(f"⚠ {bundle}: {error}")
            continue

        print(f"· {bundle}: credenciales de App Store Connect del {origen}")
        payload, error = fetch_status(token, bundle)
        write_doc(fs_token, bundle, project_id, payload, error)
        if error:
            print(f"⚠ {bundle}: {error}")
        else:
            v = (payload.get("versions") or [{}])[0]
            # También el build más reciente: la tarjeta de TestFlight sale de
            # ahí, y sin verlo en el log no se podía distinguir "Apple todavía no
            # registra el binario" de "el sync no lo está leyendo".
            b = (payload.get("builds") or [{}])[0]
            build = f"{b.get('shortVersion') or '?'} build {b.get('version') or '?'}"
            print(
                f"✓ {bundle}: versión {v.get('version')} · {v.get('state')} · "
                f"último build {build} ({b.get('processingState')}, subido {b.get('uploadedDate')})"
            )


if __name__ == "__main__":
    main()
