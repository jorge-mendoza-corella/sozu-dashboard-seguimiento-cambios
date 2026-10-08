#!/usr/bin/env python3
"""
Si la instancia de WhatsApp (Evolution API) de cada empresa sigue conectada.

Por qué: todos los avisos -deploys, PRs, builds- salen por n8n hacia Evolution.
Cuando la sesion de WhatsApp se cae, n8n sigue contestando 200 y los mensajes
simplemente dejan de llegar; nadie se entera hasta que alguien pregunta por un
aviso que nunca vio. Este sync le pregunta a Evolution directamente por el
estado de cada instancia y lo deja en Firestore, donde la barra del dashboard lo
pinta en verde o en rojo.

Endpoint de Evolution (v1 y v2):
  GET {EVOLUTION_URL}/instance/connectionState/{instancia}   header apikey
  -> {"instance": {"instanceName": "...", "state": "open" | "connecting" | "close"}}

Firestore:
  lee     clients/{id}                              (nombre de la empresa)
          clients/{id}/private/notifications        instance, enabled, evolutionUrl
          clients/{id}/private/whatsappSecret       apiKey (respaldo de la llave)
  escribe whatsappStatus/{clientId}

Variables de entorno:
  FIRESTORE_TOKEN     access token de GCP para Firestore REST
  EVOLUTION_URL       base de Evolution API (p. ej. https://evolution.midominio.com)
  EVOLUTION_API_KEY   llave global de Evolution. Sin ella se usa la de la empresa.
  GCP_PROJECT         id del proyecto Firebase (default: sozu-admin-dev)
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from urllib.parse import quote

import requests

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"

# Lo que contesta Evolution -> lo que pinta el dashboard.
ESTADOS = {"open": "conectado", "connecting": "conectando", "close": "desconectado"}


def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _str(f: dict, key: str) -> str:
    return (f.get(key) or {}).get("stringValue", "").strip()


def leer(token: str, path: str) -> dict:
    """Campos de un documento; {} si no existe o no se pudo leer."""
    r = requests.get(f"{FS_BASE}/{path}", headers=fs_headers(token), timeout=30)
    return r.json().get("fields", {}) if r.status_code == 200 else {}


def empresas(token: str) -> list[dict]:
    out: list[dict] = []
    page = None
    while True:
        params = {"pageSize": 200}
        if page:
            params["pageToken"] = page
        r = requests.get(f"{FS_BASE}/clients", headers=fs_headers(token), params=params, timeout=30)
        if r.status_code != 200:
            print(f"::error::Firestore clients: {r.status_code} {r.text[:200]}")
            sys.exit(1)
        data = r.json()
        for doc in data.get("documents", []):
            f = doc.get("fields", {})
            out.append({
                "id": doc["name"].rsplit("/", 1)[-1],
                "nombre": _str(f, "tradeName") or _str(f, "legalName"),
            })
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def consultar(url: str, key: str, instancia: str) -> tuple[str, str]:
    """(estado, detalle). El detalle explica en espanol lo que no sea 'conectado'."""
    try:
        r = requests.get(
            f"{url.rstrip('/')}/instance/connectionState/{quote(instancia, safe='')}",
            headers={"apikey": key}, timeout=20,
        )
    except requests.RequestException as e:
        return "error", f"No se pudo contactar a Evolution API: {e.__class__.__name__}"
    if r.status_code in (401, 403):
        return "error", "Evolution API rechazo la llave (apikey invalida)."
    if r.status_code == 404:
        return "error", f"La instancia '{instancia}' no existe en Evolution API."
    if r.status_code != 200:
        return "error", f"Evolution API respondio {r.status_code}: {r.text[:150]}"
    try:
        j = r.json()
    except ValueError:
        return "error", "Evolution API devolvio una respuesta que no es JSON."
    crudo = ((j.get("instance") or {}).get("state") or j.get("state") or "").lower()
    estado = ESTADOS.get(crudo)
    if not estado:
        return "error", f"Estado desconocido de Evolution: '{crudo or 'vacio'}'."
    detalle = {
        "conectado": "",
        "conectando": "La instancia esta intentando reconectar: los mensajes pueden no salir.",
        "desconectado": "La sesion de WhatsApp se cerro. Hay que volver a escanear el QR en Evolution.",
    }[estado]
    return estado, detalle


def escribir(token: str, cid: str, datos: dict) -> None:
    ahora = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    previo = leer(token, f"whatsappStatus/{quote(cid, safe='')}")
    estado_previo = _str(previo, "estado")
    # `desde` = cuando entro al estado actual. Es lo que permite decir
    # "desconectado desde las 7:26" en vez de solo "desconectado".
    desde = (previo.get("desde") or {}).get("timestampValue") if estado_previo == datos["estado"] else None
    ultima_conexion = ahora if datos["estado"] == "conectado" else (previo.get("ultimaConexion") or {}).get("timestampValue")

    campos = {
        "clientId": {"stringValue": cid},
        "empresa": {"stringValue": datos["empresa"]},
        "instancia": {"stringValue": datos["instancia"]},
        "estado": {"stringValue": datos["estado"]},
        "detalle": {"stringValue": datos["detalle"]},
        "desde": {"timestampValue": desde or ahora},
        "revisadoAt": {"timestampValue": ahora},
        "ultimaConexion": {"timestampValue": ultima_conexion} if ultima_conexion else {"nullValue": None},
    }
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in campos)
    r = requests.patch(
        f"{FS_BASE}/whatsappStatus/{quote(cid, safe='')}?{mask}",
        headers=fs_headers(token), json={"fields": campos}, timeout=30,
    )
    if r.status_code not in (200, 201):
        print(f"::error::Firestore write {cid}: {r.status_code} {r.text[:200]}")
    elif estado_previo and estado_previo != datos["estado"]:
        print(f"  cambio de estado: {estado_previo} -> {datos['estado']}")


def main() -> None:
    token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not token:
        print("::error::Falta FIRESTORE_TOKEN.")
        sys.exit(1)
    url_global = os.environ.get("EVOLUTION_URL", "").strip()
    key_global = os.environ.get("EVOLUTION_API_KEY", "").strip()

    for emp in empresas(token):
        cfg = leer(token, f"clients/{emp['id']}/private/notifications")
        instancia = _str(cfg, "instance")
        if not instancia:
            continue  # la empresa no manda WhatsApp: no hay nada que vigilar
        apagado = (cfg.get("enabled") or {}).get("booleanValue") is False

        url = _str(cfg, "evolutionUrl") or url_global
        key = key_global or _str(leer(token, f"clients/{emp['id']}/private/whatsappSecret"), "apiKey")

        if apagado:
            estado, detalle = "apagado", "La empresa tiene los avisos de WhatsApp apagados."
        elif not url or not key:
            estado, detalle = "sinConfigurar", (
                "Falta configurar el monitor: "
                + ("la URL de Evolution API (secreto EVOLUTION_URL)" if not url else "la apikey de Evolution API")
                + "."
            )
        else:
            estado, detalle = consultar(url, key, instancia)

        print(f"{'✓' if estado == 'conectado' else '⚠'} {emp['nombre'] or emp['id']} · '{instancia}': {estado}"
              + (f" — {detalle}" if detalle else ""))
        escribir(token, emp["id"], {
            "empresa": emp["nombre"], "instancia": instancia, "estado": estado, "detalle": detalle,
        })


if __name__ == "__main__":
    main()
