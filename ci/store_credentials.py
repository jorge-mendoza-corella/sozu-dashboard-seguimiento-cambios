#!/usr/bin/env python3
"""
Credenciales de tienda para los syncs, resueltas POR PROYECTO APP.

Al principio había UNA sola credencial para todo el dashboard: el service
account de Play y la llave de App Store Connect vivían en `storeCredentials/*`
(o en el entorno, sacado de Secret Manager). Con varias apps —de empresas
distintas, en cuentas de tienda distintas— eso es incorrecto: la credencial de
una empresa terminaba usándose para consultar la app de otra, y como Play y
Apple contestan 403 cuando el service account no está invitado en esa cuenta,
las tiendas salían vacías sin explicación.

Ahora cada proyecto guarda las suyas, escritas desde el dashboard:
  `projects/{projectId}/private/playSecret` { serviceAccountJson }
  `projects/{projectId}/private/ascSecret`  { keyId, issuerId, privateKey }
Las reglas prohíben leer esa subcolección desde el navegador; la cuenta de
servicio del sync las ignora, como con el resto de lo que vuelca.

Precedencia por proyecto (ver `play_service_account_for`):
  1. el doc privado del proyecto,
  2. el entorno (`PLAY_SA_JSON`, `ASC_*`),
  3. el global heredado de `storeCredentials/*`.
El entorno bajó al segundo lugar a propósito: la credencial del proyecto es la
que identifica a ESA app, y si un secret de entorno la tapara volveríamos justo
al problema que se está arreglando —una sola credencial para todos—.

Las funciones globales (`play_service_account`, `app_store_connect`) se quedan
porque son el último respaldo: mientras no todos los proyectos tengan las suyas,
son lo único que evita que una app se quede sin publicar.

No es un script ejecutable: lo importan play_tracks_sync.py y
appstore_status_sync.py.
"""
from __future__ import annotations

import os

import requests

TIMEOUT = 30

# Los syncs recorren decenas de apps y varias comparten proyecto o credencial:
# sin caché se pediría el mismo documento a Firestore una vez por app.
_cache_global: dict[str, dict] = {}
_cache_proyecto: dict[tuple[str, str], dict] = {}


def _get_fields(fs_base: str, token: str, path: str, etiqueta: str) -> dict:
    """Campos del documento en `path`, o {} si no existe o no se pudo leer."""
    try:
        r = requests.get(
            f"{fs_base}/{path}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=TIMEOUT,
        )
    except requests.RequestException as e:
        print(f"· no se pudo leer {etiqueta}: {e}")
        return {}
    if r.status_code == 404:
        return {}
    if r.status_code != 200:
        print(f"· {etiqueta} respondió {r.status_code}")
        return {}
    return r.json().get("fields", {}) or {}


def _doc_fields(fs_base: str, token: str, doc_id: str) -> dict:
    """Campos de storeCredentials/{doc_id} (el global heredado), o {}."""
    if doc_id not in _cache_global:
        _cache_global[doc_id] = _get_fields(
            fs_base, token, f"storeCredentials/{doc_id}", f"storeCredentials/{doc_id}"
        )
    return _cache_global[doc_id]


def _project_fields(fs_base: str, token: str, project_id: str, doc_id: str) -> dict:
    """Campos de projects/{project_id}/private/{doc_id}, o {}."""
    clave = (project_id, doc_id)
    if clave not in _cache_proyecto:
        _cache_proyecto[clave] = _get_fields(
            fs_base,
            token,
            f"projects/{project_id}/private/{doc_id}",
            f"projects/{project_id}/private/{doc_id}",
        )
    return _cache_proyecto[clave]


def _string(fields: dict, key: str) -> str:
    return (fields.get(key) or {}).get("stringValue", "").strip()


def _play_env() -> str:
    return os.environ.get("PLAY_SA_JSON", "").strip()


def _asc_env() -> dict:
    return {
        "key_id": os.environ.get("ASC_KEY_ID", "").strip(),
        "issuer_id": os.environ.get("ASC_ISSUER_ID", "").strip(),
        "private_key": os.environ.get("ASC_PRIVATE_KEY", "").strip(),
    }


# --- Por proyecto (lo que usan los syncs) ------------------------------------

def play_service_account_for(fs_base: str, token: str, project_id: str) -> tuple[str, str]:
    """(JSON del service account de Play de ESE proyecto, de dónde salió).

    Vacío si no hay por ninguna de las tres vías; entonces el sync deja el aviso
    en el documento de la app en vez de morirse, para no arrastrar a las demás.
    """
    propio = _string(_project_fields(fs_base, token, project_id, "playSecret"), "serviceAccountJson")
    if propio:
        return propio, "proyecto"
    env = _play_env()
    if env:
        return env, "entorno"
    heredado = _string(_doc_fields(fs_base, token, "play"), "serviceAccountJson")
    return (heredado, "global") if heredado else ("", "-")


def app_store_connect_for(fs_base: str, token: str, project_id: str) -> tuple[dict, str]:
    """({key_id, issuer_id, private_key} de ESE proyecto, origen). {} si falta algo."""
    fields = _project_fields(fs_base, token, project_id, "ascSecret")
    propio = {
        "key_id": _string(fields, "keyId"),
        "issuer_id": _string(fields, "issuerId"),
        "private_key": _string(fields, "privateKey"),
    }
    if all(propio.values()):
        return propio, "proyecto"
    # Media credencial no sirve para firmar, pero callarla haría creer que nadie
    # configuró nada y que el respaldo global es lo correcto.
    faltan = [k for k, v in propio.items() if not v]
    if any(propio.values()):
        print(f"· {project_id}: App Store Connect incompleto en el proyecto, falta {', '.join(faltan)}")

    env = _asc_env()
    if all(env.values()):
        return env, "entorno"

    heredado, _ = app_store_connect(fs_base, token)
    return (heredado, "global") if heredado else ({}, "-")


# --- Globales heredadas (respaldo mientras se migra) -------------------------

def play_service_account(fs_base: str, token: str) -> tuple[str, str]:
    """(JSON del service account de Play, de dónde salió). Vacío si no hay."""
    env = _play_env()
    if env:
        return env, "entorno"
    valor = _string(_doc_fields(fs_base, token, "play"), "serviceAccountJson")
    return (valor, "dashboard") if valor else ("", "-")


def app_store_connect(fs_base: str, token: str) -> tuple[dict, str]:
    """({key_id, issuer_id, private_key}, origen). Dict vacío si falta algo."""
    env = _asc_env()
    if all(env.values()):
        return env, "entorno"

    fields = _doc_fields(fs_base, token, "appStoreConnect")
    guardado = {
        "key_id": _string(fields, "keyId"),
        "issuer_id": _string(fields, "issuerId"),
        "private_key": _string(fields, "privateKey"),
    }
    if all(guardado.values()):
        return guardado, "dashboard"
    # Con algo a medias conviene decir qué falta: si no, el sync calla y parece
    # que nadie configuró nada.
    presentes = [k for k, v in guardado.items() if v]
    if presentes:
        faltan = [k for k, v in guardado.items() if not v]
        print(f"· App Store Connect incompleto en el dashboard: falta {', '.join(faltan)}")
    return {}, "-"
