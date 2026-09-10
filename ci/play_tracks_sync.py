#!/usr/bin/env python3
"""
Vuelca el estado de los tracks de Google Play a Firestore para que el dashboard
los muestre sin entrar a Play Console.

Corre en GitHub Actions (ver .github/workflows/play-tracks-sync.yml):
  1. Lee de Firestore los proyectos marcados como app con `androidPackage`.
  2. Por cada package consulta la Play Developer API (edits.tracks.list).
  3. Escribe el resultado en Firestore `playTracks/{package}`.

El service account se resuelve POR PROYECTO: cada app puede vivir en la cuenta
de Play de otra empresa, así que una credencial única para todas devolvía 403 y
dejaba las tiendas vacías. Orden: el doc privado del proyecto, luego el entorno,
luego el global heredado (ver store_credentials.py).

Variables de entorno:
  FIRESTORE_TOKEN   access token de GCP (cuenta de Firebase) para Firestore REST
  PLAY_SA_JSON      JSON del service account con acceso a Play Console. Solo es
                    el respaldo de los proyectos que todavía no tienen el suyo
                    guardado desde el dashboard.
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

import re

import jwt  # PyJWT
import requests

from store_credentials import play_service_account_for

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"
PLAY_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications"
PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher"


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


# --- Auth Play ---------------------------------------------------------------

def play_access_token(sa: dict) -> tuple[str | None, str | None]:
    """(token OAuth para la Play Developer API, error).

    Flujo JWT bearer del service account. Devuelve el error en vez de cortar el
    script: ahora cada app puede traer su propia credencial, y una mal pegada
    solo debe romper esa app.
    """
    now = int(time.time())
    try:
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
    except (KeyError, TypeError, ValueError, jwt.PyJWTError) as e:
        # PyJWT levanta InvalidKeyError con un private_key que no es una llave RSA.
        return None, (
            f"El service account no sirve para firmar ({type(e).__name__}: {e}). "
            "Vuelve a subir el JSON completo del service account."
        )
    r = requests.post(
        sa["token_uri"],
        data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
        timeout=30,
    )
    if r.status_code != 200:
        return None, f"No se pudo obtener token de Play: {r.status_code} {r.text[:300]}"
    return r.json()["access_token"], None


def token_de(sa: dict, cache: dict[str, tuple[str | None, str | None]]) -> tuple[str | None, str | None]:
    """Token de Play cacheado por `client_email`.

    Varias apps suelen compartir el mismo service account (la misma cuenta de
    Play): sin caché se pediría un token por app, y el resultado sería idéntico.
    """
    email = sa.get("client_email") or "?"
    if email not in cache:
        cache[email] = play_access_token(sa)
    return cache[email]


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


def write_tracks_doc(
    token: str,
    pkg: str,
    project_id: str,
    tracks: list | None,
    error: str | None,
    version_publica: str | None = None,
    descargas_publicas: str | None = None,
) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    # `raw` guarda el JSON tal cual: el front lo parsea. Evita mapear estructuras
    # anidadas al formato tipado de Firestore (y sobrevive cambios de la API).
    body = {
        "fields": {
            "package": {"stringValue": pkg},
            "projectId": {"stringValue": project_id},
            "updatedAt": {"timestampValue": now},
            "raw": {"stringValue": json.dumps(tracks or [], ensure_ascii=False)},
            # Lo que sirve la tienda AHORA, leído de la ficha pública. Sin esto
            # no hay forma de distinguir "enviado a producción" de "publicado".
            "storeVersion": {"stringValue": version_publica} if version_publica else {"nullValue": None},
            # Rango de descargas de la ficha ("10+"): respaldo mientras los
            # informes exactos no estén disponibles.
            "storeDownloads": {"stringValue": descargas_publicas} if descargas_publicas else {"nullValue": None},
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


# --- Versión que la gente puede bajar hoy --------------------------------------
#
# La Play Developer API dice qué release hay en cada track, pero NO si Google ya
# terminó de revisarlo: un envío a producción aparece como `completed` mientras
# lo revisan, y la card anunciaba como publicada una versión que nadie tenía. La
# ficha pública sí muestra la versión servida, así que se lee de ahí y ese es el
# dato de "producción"; el release del track queda como "lo enviado".

FICHA = "https://play.google.com/store/apps/details"
# La versión viene dentro de los datos embebidos de la página, no en el HTML
# visible. Play también puede decir "Varía según el dispositivo": entonces no
# hay match y se devuelve None en vez de inventar un número.
VERSION_EN_FICHA = re.compile(r'\[\[\["(\d+(?:\.\d+)+)"\]\]')


# Play también publica el rango de descargas en la ficha ("10+", "1 K+"). No es
# el número exacto que dan los informes, pero es lo único que se puede leer sin
# permisos y sirve mientras Google no abre el bucket de reportes. Se busca por
# la etiqueta, no por la clase CSS: las clases de Play son ofuscadas y cambian.
DESCARGAS_EN_FICHA = re.compile(r">([\d.,]+\s?[KMkm]?\+?)</div><div[^>]*>Descargas<")


def store_version(pkg: str) -> tuple[str | None, str | None, str | None]:
    """(versión visible en la ficha pública, rango de descargas, error)."""
    try:
        r = requests.get(
            FICHA,
            params={"id": pkg, "hl": "es_MX", "gl": "MX"},
            headers={"User-Agent": "Mozilla/5.0 (compatible; sozu-dashboard/1.0)"},
            timeout=30,
        )
    except requests.RequestException as e:
        return None, None, f"No se pudo leer la ficha pública de Play: {e}"
    if r.status_code == 404:
        return None, None, None  # app aún no publicada: no es un error que reportar
    if r.status_code != 200:
        return None, None, f"La ficha pública de Play respondió {r.status_code}"
    version = VERSION_EN_FICHA.search(r.text)
    descargas = DESCARGAS_EN_FICHA.search(r.text)
    return (
        version.group(1) if version else None,
        descargas.group(1).strip() if descargas else None,
        None,
    )


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not fs_token:
        fail("Falta FIRESTORE_TOKEN.")

    packages = list_android_packages(fs_token)
    if not packages:
        print("Ningún proyecto tiene Package Android configurado. Nada que sincronizar.")
        return

    tokens: dict[str, tuple[str | None, str | None]] = {}
    for pkg, project_id in packages:
        # La credencial es de ESTA app: la de su proyecto, o el respaldo del
        # entorno / global mientras no la haya migrado nadie.
        raw_sa, origen = play_service_account_for(FS_BASE, fs_token, project_id)
        if not raw_sa:
            error = (
                f"El proyecto '{project_id}' no tiene service account de Play. Súbelo en el "
                "dashboard (panel de la app > Cuenta de servicio de Play) con una cuenta "
                "invitada en la Play Console de esa empresa."
            )
            write_tracks_doc(fs_token, pkg, project_id, None, error)
            print(f"⚠ {pkg}: {error}")
            continue

        sa = None
        try:
            cargado = json.loads(raw_sa)
            sa = cargado if isinstance(cargado, dict) else None
        except json.JSONDecodeError:
            pass
        if sa is None:
            error = (
                f"El service account de Play del proyecto '{project_id}' no es un JSON de "
                "service account. Debe ser el archivo completo, desde '{' hasta '}'."
            )
            write_tracks_doc(fs_token, pkg, project_id, None, error)
            print(f"⚠ {pkg}: {error}")
            continue

        play_token, error = token_de(sa, tokens)
        if error:
            write_tracks_doc(fs_token, pkg, project_id, None, error)
            print(f"⚠ {pkg}: {error}")
            continue

        print(f"· {pkg}: service account del {origen} ({sa.get('client_email', '?')})")
        tracks, error = fetch_tracks(play_token, pkg, sa.get("client_email", "?"))
        publica, descargas, aviso = store_version(pkg)
        if aviso:
            print(f"· {pkg}: {aviso}")
        print(f"· {pkg}: la ficha pública sirve {publica or '—'} · descargas {descargas or '—'}")
        write_tracks_doc(fs_token, pkg, project_id, tracks, error, publica, descargas)
        if error:
            print(f"⚠ {pkg}: {error}")
        else:
            resumen = ", ".join(
                f"{t.get('track')}={len(t.get('releases') or [])} release(s)" for t in (tracks or [])
            ) or "sin tracks"
            print(f"✓ {pkg}: {resumen}")


if __name__ == "__main__":
    main()
