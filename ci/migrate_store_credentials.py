#!/usr/bin/env python3
"""
Copia las credenciales de tienda GLOBALES a cada proyecto APP.

Hasta ahora el dashboard tenía UNA credencial de Play y UNA de App Store Connect
para todas las apps (`storeCredentials/play` y `storeCredentials/appStoreConnect`,
más los secrets de entorno). Con apps de empresas distintas eso está mal: la
credencial identifica la cuenta de tienda, no el dashboard. Los syncs ya buscan
primero `projects/{projectId}/private/{playSecret,ascSecret}`, así que este
script rellena esos docs con lo que hoy es global: sin él cada app tendría que
esperar a que alguien vuelva a pegar sus llaves a mano, y entre tanto seguiría
publicando por el respaldo heredado (que algún día se borrará).

Es idempotente y no destructivo: un proyecto que ya tiene su credencial no se
toca (para eso está `--force`). Nunca imprime el contenido de una credencial,
solo su longitud o el `client_email` del service account, que no es secreto.

Cómo correrlo (el token es de la cuenta de servicio y salta las reglas):
    export FIRESTORE_TOKEN="$(gcloud auth print-access-token)"
    export GCP_PROJECT=sozu-admin-dev
    python ci/migrate_store_credentials.py --dry-run          # solo dice qué haría
    python ci/migrate_store_credentials.py                    # escribe en todas las apps
    python ci/migrate_store_credentials.py sozu-app otra-app  # solo esos proyectos
    python ci/migrate_store_credentials.py --force sozu-app   # pisa lo que ya haya
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

import requests

from store_credentials import app_store_connect, play_service_account

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"
TIMEOUT = 30

# El autor que verá el dashboard en "credenciales actualizadas por": no fue una
# persona pegándolas, fue esta migración, y conviene que se distinga.
AUTOR = "migración"


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def ahora() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# --- Lectura -----------------------------------------------------------------

def app_project_ids(token: str) -> list[str]:
    """Ids de los proyectos con `isApp: true`: son los únicos que publican."""
    out: list[str] = []
    page = None
    while True:
        params = {"pageSize": 200}
        if page:
            params["pageToken"] = page
        r = requests.get(f"{FS_BASE}/projects", headers=fs_headers(token), params=params, timeout=TIMEOUT)
        if r.status_code != 200:
            fail(f"Firestore projects: {r.status_code} {r.text[:300]}")
        data = r.json()
        for doc in data.get("documents", []):
            if doc.get("fields", {}).get("isApp", {}).get("booleanValue"):
                out.append(doc["name"].rsplit("/", 1)[-1])
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def ya_tiene(token: str, project_id: str, doc_id: str, campos: list[str]) -> bool:
    """True si el proyecto ya tiene ese secreto con valor en todos sus campos."""
    r = requests.get(
        f"{FS_BASE}/projects/{project_id}/private/{doc_id}",
        headers=fs_headers(token),
        timeout=TIMEOUT,
    )
    if r.status_code == 404:
        return False
    if r.status_code != 200:
        # Ante la duda no se pisa nada: mejor dejarlo para una segunda corrida que
        # sobrescribir una credencial buena por un 500 pasajero.
        print(f"  · no se pudo leer private/{doc_id} ({r.status_code}); se deja como está")
        return True
    fields = r.json().get("fields", {}) or {}
    return all((fields.get(c) or {}).get("stringValue", "").strip() for c in campos)


# --- Escritura ---------------------------------------------------------------

def escribir_secreto(token: str, project_id: str, doc_id: str, valores: dict[str, str]) -> None:
    """Deja projects/{project_id}/private/{doc_id} con esos campos (merge)."""
    fields: dict[str, dict] = {k: {"stringValue": v} for k, v in valores.items()}
    fields["updatedBy"] = {"stringValue": AUTOR}
    fields["updatedAt"] = {"timestampValue": ahora()}
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in fields)
    r = requests.patch(
        f"{FS_BASE}/projects/{project_id}/private/{doc_id}?{mask}",
        headers=fs_headers(token),
        json={"fields": fields},
        timeout=TIMEOUT,
    )
    if r.status_code not in (200, 201):
        fail(f"Firestore write {project_id}/private/{doc_id}: {r.status_code} {r.text[:300]}")


def escribir_metadatos(token: str, project_id: str, prefijos: list[str]) -> None:
    """Marca en el doc del proyecto cuándo y quién dejó las credenciales.

    Los secretos no se pueden leer desde el navegador (ni el root), así que estos
    campos son la única forma que tiene el dashboard de mostrar que ya están
    puestas. `prefijos` es "play" y/o "asc".
    """
    fields: dict[str, dict] = {}
    for p in prefijos:
        fields[f"{p}CredentialsUpdatedAt"] = {"timestampValue": ahora()}
        fields[f"{p}CredentialsUpdatedBy"] = {"stringValue": AUTOR}
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in fields)
    r = requests.patch(
        f"{FS_BASE}/projects/{project_id}?{mask}",
        headers=fs_headers(token),
        json={"fields": fields},
        timeout=TIMEOUT,
    )
    if r.status_code not in (200, 201):
        fail(f"Firestore write projects/{project_id}: {r.status_code} {r.text[:300]}")


# --- Migración ---------------------------------------------------------------

def migrar(
    token: str,
    project_id: str,
    play_json: str,
    play_email: str,
    asc: dict,
    dry_run: bool,
    force: bool,
) -> list[str]:
    """Copia a un proyecto lo que le falte. Devuelve qué tiendas se escribieron."""
    print(f"· {project_id}")
    escritos: list[str] = []

    if play_json:
        if not force and ya_tiene(token, project_id, "playSecret", ["serviceAccountJson"]):
            print("  ✓ Play: ya tiene su service account, no se toca")
        else:
            valores = {"serviceAccountJson": play_json}
            # El correo del service account no es secreto y es lo primero que se
            # busca al depurar un 403 en Play Console.
            if play_email:
                valores["clientEmail"] = play_email
            detalle = f"{len(play_json)} caracteres" + (f", {play_email}" if play_email else "")
            if dry_run:
                print(f"  → Play: escribiría private/playSecret ({detalle})")
            else:
                escribir_secreto(token, project_id, "playSecret", valores)
                print(f"  ✓ Play: service account copiado ({detalle})")
            escritos.append("play")
    else:
        print("  ⚠ Play: no hay credencial global que copiar")

    if asc:
        if not force and ya_tiene(token, project_id, "ascSecret", ["keyId", "issuerId", "privateKey"]):
            print("  ✓ App Store Connect: ya tiene su llave, no se toca")
        else:
            detalle = (
                f"key {len(asc['key_id'])} car., issuer {len(asc['issuer_id'])} car., "
                f".p8 {len(asc['private_key'])} car."
            )
            if dry_run:
                print(f"  → App Store Connect: escribiría private/ascSecret ({detalle})")
            else:
                escribir_secreto(
                    token,
                    project_id,
                    "ascSecret",
                    {
                        "keyId": asc["key_id"],
                        "issuerId": asc["issuer_id"],
                        "privateKey": asc["private_key"],
                    },
                )
                print(f"  ✓ App Store Connect: llave copiada ({detalle})")
            escritos.append("asc")
    else:
        print("  ⚠ App Store Connect: no hay credencial global que copiar")

    if escritos and not dry_run:
        escribir_metadatos(token, project_id, escritos)
    return escritos


def main() -> None:
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    force = "--force" in args
    desconocidas = [a for a in args if a.startswith("--") and a not in ("--dry-run", "--force")]
    if desconocidas:
        fail(f"Opción desconocida: {' '.join(desconocidas)}. Solo hay --dry-run y --force.")
    ids = [a for a in args if not a.startswith("--")]

    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not fs_token:
        fail('Falta FIRESTORE_TOKEN. Sácalo con: export FIRESTORE_TOKEN="$(gcloud auth print-access-token)"')

    # Las globales incluyen lo que venga del entorno: si la migración corre dentro
    # del workflow, el secret de Secret Manager es justo lo que hay que copiar.
    play_json, origen_play = play_service_account(FS_BASE, fs_token)
    asc, origen_asc = app_store_connect(FS_BASE, fs_token)
    play_email = ""
    if play_json:
        try:
            cargado = json.loads(play_json)
        except json.JSONDecodeError as e:
            fail(f"El service account global no es JSON válido ({e}). Arréglalo antes de copiarlo a las apps.")
        play_email = cargado.get("client_email", "") if isinstance(cargado, dict) else ""
    if not play_json and not asc:
        print("No hay credenciales globales que migrar: nada que hacer.")
        return
    print(f"Play global: {'sí' if play_json else 'no'} ({origen_play}, {play_email or 'sin client_email'})")
    print(f"App Store Connect global: {'sí' if asc else 'no'} ({origen_asc})")

    if ids:
        print(f"Proyectos indicados: {', '.join(ids)}")
    else:
        ids = app_project_ids(fs_token)
        if not ids:
            print("Ningún proyecto está marcado como app. Nada que hacer.")
            return
        print(f"Proyectos con isApp: {len(ids)}")
    if dry_run:
        print("--dry-run: no se escribe nada.")
    if force:
        print("--force: se pisan las credenciales que ya tengan los proyectos.")

    tocados = 0
    for project_id in ids:
        if migrar(fs_token, project_id, play_json, play_email, asc, dry_run, force):
            tocados += 1
    verbo = "recibirían" if dry_run else "recibieron"
    print(f"Listo: {tocados} de {len(ids)} proyecto(s) {verbo} credenciales.")


if __name__ == "__main__":
    main()
