#!/usr/bin/env python3
"""
Configuración y envío de WhatsApp (n8n) para los scripts de CI.

La MISMA cascada que ya vive en bash en `ci-templates/notify-pr-dev.yml`
(bloque `RESOLVER_WA`), reescrita en Python para los syncs que corren aquí. Se
extrajo a su propio módulo porque el aviso de fin de build ya no lo manda el
`codemagic.yaml` de cada repo de app —ese aviso se perdía cuando el build
reventaba antes de llegar al paso de notificar— sino un sync programado, y no
tiene sentido duplicar la cascada una tercera vez.

Cascada de configuración (`resolve_for_project`): gana el campo que la EMPRESA
tenga con valor; lo vacío o ausente se hereda del global.

  global   settings/notifications          → instance, webhookUrl, adminPhone, enabled
           secrets/whatsapp                → apiKey
  empresa  projects/{projectId}.clientId   → clientId de la empresa dueña
           clients/{clientId}/private/notifications    → mismos campos
           clients/{clientId}/private/whatsappSecret   → apiKey

Dos reglas que no son negociables:

  · `enabled: false` en CUALQUIERA de los dos (global o empresa) apaga los
    avisos de esa empresa. Apagar manda sobre heredar.
  · El webhook y la apikey van EN PAREJA. Una empresa con webhook propio y sin
    apikey propia NO recibe nada: mandarle la llave global a una URL que
    capturó el administrador de esa empresa sería entregársela, y con ella
    podría mandar mensajes a nombre de cualquier otra empresa.

La apikey nunca se imprime, ni siquiera enmascarada; los teléfonos solo salen
al log por `enmascarar()`, con los últimos 4 dígitos.

No es un script ejecutable: lo importa ci/codemagic_builds_notify.py.
"""
from __future__ import annotations

import os

import re
import time

import requests

TIMEOUT = 20
# Tres intentos, como el resto de los envíos: si n8n no contesta a la primera,
# el aviso se pierde sin dejar rastro y nadie se entera de que se perdió.
INTENTOS = 3

# Un sync recorre decenas de builds y varios caen en el mismo proyecto: sin
# caché se releerían los mismos cuatro documentos de Firestore una vez por build.
_cache_config: dict[str, dict] = {}


# --- Lectura de Firestore -----------------------------------------------------

def _campos(fs_base: str, token: str, path: str) -> dict:
    """Campos del documento en `path`, o {} si no existe o no se pudo leer."""
    try:
        r = requests.get(
            f"{fs_base}/{path}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=TIMEOUT,
        )
    except requests.RequestException as e:
        print(f"· no se pudo leer {path}: {e}")
        return {}
    if r.status_code == 404:
        return {}
    if r.status_code != 200:
        print(f"· {path} respondió {r.status_code}")
        return {}
    return r.json().get("fields", {}) or {}


def _texto(fields: dict, key: str) -> str:
    return ((fields.get(key) or {}).get("stringValue") or "").strip()


def _prendido(fields: dict) -> bool:
    """`enabled` del documento. Ausente = prendido (nadie lo apagó nunca)."""
    campo = fields.get("enabled")
    if not isinstance(campo, dict) or "booleanValue" not in campo:
        return True
    return bool(campo["booleanValue"])


def _gana(propio: str, global_: str) -> str:
    """Lo de la empresa si tiene valor; si no, lo heredado del global."""
    return propio or global_


# --- Teléfonos ----------------------------------------------------------------

def normalizar_telefono(valor: str | None) -> str | None:
    """Teléfono en E.164, o None si no cuadra (y entonces se salta, sin tumbar nada).

    Se aceptan las dos formas con las que llegan los números al dashboard:
      · 10 dígitos, como se guardan en `contributors` → se le antepone +521
      · formato internacional ya completo, empezando con '+'
    Cualquier otra cosa (extensiones, números a medias, texto) devuelve None:
    mandársela a n8n solo produce un error silencioso del lado del webhook.
    """
    if not valor:
        return None
    limpio = re.sub(r"[\s()\-.]", "", str(valor).strip())
    if limpio.startswith("+"):
        digitos = limpio[1:]
        return f"+{digitos}" if digitos.isdigit() and 8 <= len(digitos) <= 15 else None
    if limpio.isdigit() and len(limpio) == 10:
        return f"+521{limpio}"
    return None


def enmascarar(telefono: str | None) -> str:
    """Teléfono listo para el log: solo los últimos 4 dígitos."""
    digitos = re.sub(r"\D", "", telefono or "")
    return f"···{digitos[-4:]}" if len(digitos) >= 4 else "···"


# --- Cascada de configuración -------------------------------------------------

def resolve_for_project(fs_base: str, token: str, project_id: str) -> dict:
    """Configuración de WhatsApp que le toca al proyecto `project_id`.

    Devuelve siempre un dict (nunca levanta), con:
      enabled      bool  — False si el global o la empresa apagaron los avisos
      puedeEnviar  bool  — False si falta algo para mandar, o está apagado
      motivo       str   — por qué no se puede mandar (vacío si sí se puede)
      instance     str   — instancia de WhatsApp (`instanciaWA` del payload)
      webhook      str   — URL de n8n
      apikey       str   — llave del webhook (NO imprimir)
      adminPhone   str   — teléfono administrativo de esa empresa, ya normalizado
      clientId     str   — empresa dueña del proyecto ('' si no tiene)
    """
    if project_id in _cache_config:
        return _cache_config[project_id]

    # --- Global (el default de todo el dashboard) ---
    g_doc = _campos(fs_base, token, "settings/notifications")
    g_key = _texto(_campos(fs_base, token, "secrets/whatsapp"), "apiKey")

    # Respaldo por entorno para el global. Los avisos vivieron años con la
    # instancia y la apikey escritas en el YAML; mientras nadie las captura en el
    # dashboard, esto deja que se pongan como secret y los avisos no se caigan en
    # el intervalo. Lo del dashboard SIEMPRE gana: si no, un secret viejo taparía
    # lo que alguien acaba de configurar.
    for campo, var in (("instance", "WA_INSTANCE"), ("webhookUrl", "WA_WEBHOOK"), ("adminPhone", "WA_ADMIN")):
        if not _texto(g_doc, campo):
            del_entorno = os.environ.get(var, "").strip()
            if del_entorno:
                g_doc[campo] = {"stringValue": del_entorno}
    if not g_key:
        g_key = os.environ.get("WA_APIKEY", "").strip()

    # --- Empresa dueña del proyecto ---
    client_id = _texto(_campos(fs_base, token, f"projects/{project_id}"), "clientId")
    c_doc: dict = {}
    c_key = ""
    if client_id:
        c_doc = _campos(fs_base, token, f"clients/{client_id}/private/notifications")
        c_key = _texto(_campos(fs_base, token, f"clients/{client_id}/private/whatsappSecret"), "apiKey")

    c_webhook = _texto(c_doc, "webhookUrl")
    admin_crudo = _gana(_texto(c_doc, "adminPhone"), _texto(g_doc, "adminPhone"))
    admin = normalizar_telefono(admin_crudo)
    if admin_crudo and not admin:
        # Se dice, pero no se tumba nada: el aviso puede seguir llegándole a
        # quien disparó el build aunque el administrativo esté mal capturado.
        print(
            f"⚠ El teléfono administrativo configurado ({enmascarar(admin_crudo)}) no tiene un "
            "formato válido: deben ser 10 dígitos o un número internacional con '+'."
        )

    cfg = {
        "clientId": client_id,
        "instance": _gana(_texto(c_doc, "instance"), _texto(g_doc, "instance")),
        "webhook": _gana(c_webhook, _texto(g_doc, "webhookUrl")),
        "apikey": _gana(c_key, g_key),
        "adminPhone": admin or "",
        "enabled": True,
        "puedeEnviar": False,
        "motivo": "",
    }

    # Apagar manda: basta con que uno de los dos esté apagado.
    if not _prendido(g_doc):
        cfg["enabled"] = False
        cfg["motivo"] = "Las notificaciones de WhatsApp están apagadas en la configuración global."
    elif not _prendido(c_doc):
        cfg["enabled"] = False
        cfg["motivo"] = f"La empresa '{client_id}' tiene apagadas las notificaciones de WhatsApp."

    # El par webhook/apikey: o se hereda todo del global, o la empresa pone los dos.
    elif c_webhook and not c_key:
        cfg["motivo"] = (
            f"La empresa '{client_id}' tiene webhook propio pero no apikey propia. No se manda "
            "nada: la llave global no viaja a un webhook de cliente. Captura su apikey en el "
            "dashboard → Configuración → Notificaciones."
        )
    elif not cfg["webhook"] or not cfg["apikey"]:
        cfg["motivo"] = (
            "Falta el webhook o la apikey de WhatsApp (ni la de la empresa ni la global). "
            "Configúralos en el dashboard → Configuración → Notificaciones."
        )
    else:
        cfg["puedeEnviar"] = True
        if not cfg["instance"]:
            # No impide el envío, pero n8n puede rechazarlo: mejor decirlo.
            print("⚠ Sin instancia de WhatsApp configurada; n8n puede rechazar el envío.")

    _cache_config[project_id] = cfg
    return cfg


# --- Envío --------------------------------------------------------------------

def send(cfg: dict, telefono: str, mensaje: str) -> tuple[bool, str]:
    """Manda un WhatsApp por el webhook de n8n. Devuelve (ok, detalle).

    Nunca levanta: quien llama está recorriendo builds y un webhook caído no
    puede llevarse por delante el resto de los avisos. La apikey viaja en el
    header y no aparece en ningún print, ni en el detalle del error.
    """
    if not cfg.get("puedeEnviar"):
        return False, cfg.get("motivo") or "Configuración de WhatsApp incompleta."

    payload = {
        "tipo": "wa",
        "telefono": telefono,
        "mensajeWA": mensaje,
        "instanciaWA": cfg.get("instance", ""),
    }
    ultimo = ""
    for intento in range(1, INTENTOS + 1):
        try:
            r = requests.post(
                cfg["webhook"],
                headers={"apikey": cfg["apikey"], "Content-Type": "application/json"},
                json=payload,
                timeout=TIMEOUT,
            )
        except requests.RequestException as e:
            ultimo = f"{type(e).__name__}: {e}"
        else:
            if 200 <= r.status_code < 300:
                return True, f"HTTP {r.status_code}"
            ultimo = f"HTTP {r.status_code} {r.text[:200]}"
        if intento < INTENTOS:
            print(f"· intento {intento} para {enmascarar(telefono)} falló ({ultimo})")
            time.sleep(intento * 5)
    return False, f"tras {INTENTOS} intentos: {ultimo}"
