#!/usr/bin/env python3
"""
Credenciales de tienda para los syncs, con Firestore como respaldo del env.

El workflow saca estos valores de Secret Manager, lo que obliga a crearlos con
gcloud a mano; si faltan, los syncs no consultan nada y las tiendas salen vacías
en el dashboard. Para que se puedan dejar desde la propia interfaz, se leen
también de `storeCredentials/{id}` en Firestore, escrito solo por el root (las
reglas prohíben leerlo desde el navegador; la cuenta de servicio del sync las
ignora, como con el resto de las colecciones que vuelca).

Precedencia: lo que venga en el entorno gana, porque Secret Manager sigue siendo
el sitio recomendado y así un valor puesto ahí no queda tapado por otro viejo
guardado desde la interfaz.

No es un script ejecutable: lo importan play_tracks_sync.py y
appstore_status_sync.py.
"""
from __future__ import annotations

import os

import requests

TIMEOUT = 30


def _doc_fields(fs_base: str, token: str, doc_id: str) -> dict:
    """Campos de storeCredentials/{doc_id}, o {} si no existe."""
    try:
        r = requests.get(
            f"{fs_base}/storeCredentials/{doc_id}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=TIMEOUT,
        )
    except requests.RequestException as e:
        print(f"· no se pudo leer storeCredentials/{doc_id}: {e}")
        return {}
    if r.status_code == 404:
        return {}
    if r.status_code != 200:
        print(f"· storeCredentials/{doc_id} respondió {r.status_code}")
        return {}
    return r.json().get("fields", {}) or {}


def _string(fields: dict, key: str) -> str:
    return (fields.get(key) or {}).get("stringValue", "").strip()


def play_service_account(fs_base: str, token: str) -> tuple[str, str]:
    """(JSON del service account de Play, de dónde salió). Vacío si no hay."""
    env = os.environ.get("PLAY_SA_JSON", "").strip()
    if env:
        return env, "entorno"
    valor = _string(_doc_fields(fs_base, token, "play"), "serviceAccountJson")
    return (valor, "dashboard") if valor else ("", "-")


def app_store_connect(fs_base: str, token: str) -> tuple[dict, str]:
    """({key_id, issuer_id, private_key}, origen). Dict vacío si falta algo."""
    env = {
        "key_id": os.environ.get("ASC_KEY_ID", "").strip(),
        "issuer_id": os.environ.get("ASC_ISSUER_ID", "").strip(),
        "private_key": os.environ.get("ASC_PRIVATE_KEY", "").strip(),
    }
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
