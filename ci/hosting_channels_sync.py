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
import re
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
    if r.status_code == 404:
        # Ruta que existe en el draft pero todavía no en producción.
        return "404", None
    if r.status_code != 200:
        return None, f"{url} respondió {r.status_code}"
    return hashlib.sha256(r.content).hexdigest(), None


# Rutas de cada reporte publicado dentro del índice: /r/YYYY-MM-DD/
REPORT_PATH = re.compile(r'href="(/r/\d{4}-\d{2}-\d{2}/)"')


def compare_by_content(site: str, live_url: str, draft_url: str) -> tuple[dict | None, str | None]:
    """Respaldo sin permisos: el draft ya está publicado si sirve lo mismo que producción.

    No basta comparar la portada: cuando el draft reemplaza el reporte del día
    en curso, el índice queda idéntico y solo cambia la página de esa fecha. Se
    comparan la portada y cada reporte que el draft lista.
    """
    try:
        r = requests.get(draft_url, timeout=30, headers={"Cache-Control": "no-cache"})
    except requests.RequestException as e:
        return None, f"no se pudo leer {draft_url}: {e}"
    if r.status_code != 200:
        return None, f"{draft_url} respondió {r.status_code}"

    paths = ["/"] + sorted(set(REPORT_PATH.findall(r.text)), reverse=True)[:6]
    diffs: list[str] = []
    draft_digest: list[str] = []
    for path in paths:
        hd, e1 = page_hash(draft_url.rstrip("/") + path)
        hl, e2 = page_hash(live_url.rstrip("/") + path)
        if e1 or e2:
            return None, e1 or e2
        draft_digest.append(f"{path}:{hd[:12]}")
        if hd != hl:
            diffs.append(path)

    return {
        "site": site,
        "liveVersion": None,
        "source": "contenido",
        "comparedPaths": paths,
        "diffPaths": diffs,
        "channels": [{
            "id": "draft",
            "url": draft_url,
            "version": hashlib.sha256("|".join(draft_digest).encode()).hexdigest(),
            "published": not diffs,
        }],
    }, None


def fetch_estado(api_base: str, token: str) -> tuple[dict | None, str | None]:
    """Modo resumen de /api/estado: la fuente oficial del sitio de avances."""
    try:
        r = requests.get(
            f"{api_base.rstrip('/')}/api/estado",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
    except requests.RequestException as e:
        return None, f"no se pudo leer /api/estado: {e}"
    if r.status_code == 401:
        return None, "/api/estado rechazó el token (401). Revisa DASHBOARD_AVANCES_ESTADO_TOKEN."
    if r.status_code == 503:
        return None, "/api/estado responde 503: falta configurar ESTADO_TOKEN en el sitio de avances."
    if r.status_code != 200:
        return None, f"/api/estado respondió {r.status_code}"
    return r.json(), None


def merge_estado(payload: dict, estado: dict) -> dict:
    """Combina el veredicto del endpoint con la comparación de contenido.

    El propio endpoint documenta su límite: mide la publicación por la
    existencia de /r/<fecha>/, así que un reporte regenerado el mismo día que
    ya se aprobó le sale como publicado. La comparación de contenido cubre ese
    hueco, y `pendiente_aprobacion` cubre el caso contrario (borrador de una
    fecha que todavía no existe en producción).
    """
    ch = payload["channels"][0]
    pendiente_api = estado.get("pendiente_aprobacion")
    hay_cambios = not ch["published"]

    if pendiente_api is True:
        ch["published"] = False
    elif pendiente_api is False and hay_cambios:
        # El endpoint no lo ve, el contenido sí: gana el contenido.
        ch["published"] = False
    # pendiente_api None → se queda con lo que dijo la comparación.

    if estado.get("url_draft_indice"):
        ch["url"] = estado["url_draft_indice"]
    ch["title"] = estado.get("titulo")
    ch["date"] = estado.get("fecha")
    if estado.get("expira"):
        ch["expireTime"] = estado["expira"]
    if estado.get("vencido") is True:
        ch["published"] = True  # vencido = no hay nada que aprobar

    payload["source"] = "api/estado + contenido"
    payload["estado"] = {
        "pendiente_aprobacion": pendiente_api,
        "publicada": estado.get("publicada"),
        "titulo": estado.get("titulo"),
        "fecha": estado.get("fecha"),
    }
    return payload


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
        # La Hosting API compara IDS de version, y un redespliegue sin cambios
        # crea una version nueva: el canal draft de sozu-avances sirve HOY lo
        # mismo que live con otro id. Fiarse solo de eso pinta un borrador
        # pendiente que no existe, asi que cuando la API dice "pendiente" se
        # confirma por contenido (y por /api/estado, que es la fuente oficial).
        api_dice_pendiente = bool(
            payload and any(not c["published"] for c in payload["channels"])
        )
        if (error or api_dice_pendiente) and site in compare:
            # Sin permisos sobre el sitio, o para confirmar lo que dijo la API:
            # decidir por el contenido servido.
            live_url, draft_url = compare[site]
            if site == "sozu-avances":
                draft_url = draft_url_from_settings(token) or draft_url
            if error:
                print(f"· {site}: sin acceso a la Hosting API, comparando contenido ({error.split('Detalle:')[0].strip()})")
            else:
                print(f"· {site}: la Hosting API ve el canal sin publicar; se confirma por contenido")
            payload_api, payload = payload, None
            payload, error = compare_by_content(site, live_url, draft_url)
            if error and payload_api:
                # La comprobacion por contenido no salio: mejor el dato de la
                # API que ninguno, pero se deja dicho por que.
                print(f"· {site}: no se pudo confirmar por contenido ({error}); se usa la Hosting API")
                payload, error = payload_api, None
            # El sitio de avances publica su propio estado; es la fuente oficial.
            estado_token = os.environ.get("AVANCES_ESTADO_TOKEN", "").strip()
            if payload and estado_token:
                estado, err_estado = fetch_estado(live_url, estado_token)
                if estado:
                    payload = merge_estado(payload, estado)
                    print(
                        f"· {site}: /api/estado dice pendiente_aprobacion="
                        f"{estado.get('pendiente_aprobacion')} ({estado.get('titulo') or 'sin título'})"
                    )
                else:
                    print(f"· {site}: {err_estado}; se usa solo la comparación de contenido")
            elif payload and not estado_token:
                print(f"· {site}: sin AVANCES_ESTADO_TOKEN; solo comparación de contenido")
        write_doc(token, site, payload, error)
        if error:
            print(f"⚠ {site}: {error}")
        else:
            pend = [c["id"] for c in payload["channels"] if not c["published"]]
            via = payload.get("source", "hosting api")
            detalle = ""
            if payload.get("diffPaths"):
                detalle = f" · difieren: {', '.join(payload['diffPaths'])}"
            elif payload.get("comparedPaths"):
                detalle = f" · {len(payload['comparedPaths'])} ruta(s) comparadas, todas iguales"
            print(f"✓ {site} (via {via}): {len(payload['channels'])} canal(es); sin publicar: {pend or 'ninguno'}{detalle}")


if __name__ == "__main__":
    main()
