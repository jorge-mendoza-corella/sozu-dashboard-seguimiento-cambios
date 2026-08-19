#!/usr/bin/env python3
"""
Configuración y envío de WhatsApp (n8n) para los scripts de CI.

La MISMA resolución que ya vive en bash en `ci-templates/notify-pr-dev.yml`
(bloque `RESOLVER_WA`), reescrita en Python para los syncs que corren aquí. Se
extrajo a su propio módulo porque el aviso de fin de build ya no lo manda el
`codemagic.yaml` de cada repo de app —ese aviso se perdía cuando el build
reventaba antes de llegar al paso de notificar— sino un sync programado, y no
tiene sentido duplicar esta lógica una tercera vez.

TODO ES POR EMPRESA O NO SE MANDA NADA. Ya no existe configuración global
(`settings/notifications`, `secrets/whatsapp`) ni cascada que herede de ella,
por dos razones concretas:

  · Con un default global, la empresa que TODAVÍA NO configuró sus avisos los
    recibía por el número de OTRA empresa.
  · Y si esa empresa alcanzaba a poner su propio `webhookUrl`, la llave global
    terminaba viajando a una URL ajena: con ella podía mandar mensajes a
    nombre de cualquiera.

Sin nada que heredar, los dos problemas desaparecen de raíz. Por eso también se
borró la vieja comprobación de "webhook propio sin apikey propia": ya no hay
llave global que se pueda filtrar, el webhook y la apikey siempre salen del
mismo documento de la misma empresa.

De dónde sale la configuración (`resolve_for_project`):

  projects/{projectId}.clientId               → empresa dueña del proyecto
  clients/{clientId}/private/notifications    → instance, webhookUrl, enabled
  clients/{clientId}/private/whatsappSecret   → apiKey

Un proyecto sin empresa asignada simplemente no notifica, y el log lo dice: no
es un error de CI, es una empresa sin configurar.

A QUIÉN SE LE AVISA "de parte de la empresa" (`approver_phone`):

  projects/{projectId}.approverEmail          → quién aprueba los PRs
  users/{email}.githubLogin                   → su login de GitHub
  contributors/{login}.telefonoWhatsapp       → su teléfono

Ese segundo destinatario ERA un `adminPhone` capturado a mano en la
configuración de la empresa, y se eliminó: era un número suelto que había que
mantener a mano y que se quedaba viejo en cuanto cambiaba el responsable —el
aviso seguía llegándole a quien ya no revisaba nada—. Ahora le llega al
APROBADOR del proyecto, que es justamente quien tiene que revisar el PR, ya está
configurado en el dashboard (Proyectos y repos) y su teléfono sale de
Contribuidores, igual que el de los autores: un solo lugar donde mantenerlo.

La apikey nunca se imprime, ni siquiera enmascarada; los teléfonos solo salen
al log por `enmascarar()`, con los últimos 4 dígitos.

No es un script ejecutable: lo importa ci/codemagic_builds_notify.py.
"""
from __future__ import annotations

import os

import re
import time
from urllib.parse import quote

import requests

TIMEOUT = 20
# Tres intentos, como el resto de los envíos: si n8n no contesta a la primera,
# el aviso se pierde sin dejar rastro y nadie se entera de que se perdió.
INTENTOS = 3

# Un sync recorre decenas de builds y varios caen en el mismo proyecto: sin
# caché se releerían los mismos documentos de Firestore una vez por build.
_cache_config: dict[str, dict] = {}
# Lo mismo para el aprobador, que además cuesta TRES lecturas encadenadas
# (proyecto → usuario → contribuidor) por cada build del mismo proyecto.
_cache_aprobador: dict[str, tuple[str | None, str]] = {}


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


# --- Configuración de la empresa ----------------------------------------------

def resolve_for_project(fs_base: str, token: str, project_id: str) -> dict:
    """Configuración de WhatsApp de la EMPRESA dueña del proyecto `project_id`.

    Sin empresa no hay configuración: no se hereda nada de ningún default
    global, porque ese default mandaba los avisos de una empresa por el número
    de otra (ver el encabezado del módulo). Devuelve siempre un dict (nunca
    levanta), con:
      enabled      bool  — False si la empresa apagó sus avisos
      puedeEnviar  bool  — False si falta algo para mandar, o está apagado
      motivo       str   — qué falta exactamente (vacío si sí se puede mandar)
      instance     str   — instancia de WhatsApp (`instanciaWA` del payload)
      webhook      str   — URL de n8n de la empresa
      apikey       str   — llave de ese webhook (NO imprimir)
      clientId     str   — empresa dueña del proyecto ('' si no tiene)

    Ya NO devuelve `adminPhone`: ese campo desapareció del modelo. El segundo
    destinatario de los avisos es ahora el aprobador del proyecto, que se
    resuelve aparte con `approver_phone()` — ver el encabezado del módulo.
    """
    if project_id in _cache_config:
        return _cache_config[project_id]

    # --- Empresa dueña del proyecto ---
    client_id = _texto(_campos(fs_base, token, f"projects/{project_id}"), "clientId")
    c_doc: dict = {}
    c_key = ""
    if client_id:
        c_doc = _campos(fs_base, token, f"clients/{client_id}/private/notifications")
        c_key = _texto(
            _campos(fs_base, token, f"clients/{client_id}/private/whatsappSecret"), "apiKey"
        )

    cfg = {
        "clientId": client_id,
        "instance": _texto(c_doc, "instance"),
        "webhook": _texto(c_doc, "webhookUrl"),
        "apikey": c_key,
        "enabled": True,
        "puedeEnviar": False,
        "motivo": "",
    }

    if not client_id:
        # No es un error de CI: es un proyecto que nadie asignó a una empresa.
        cfg["motivo"] = (
            f"El proyecto '{project_id}' no tiene empresa asignada, y sin empresa no hay "
            "a quién ni por dónde notificar. Asígnale una en el dashboard → Proyectos."
        )
    elif not _prendido(c_doc):
        cfg["enabled"] = False
        cfg["motivo"] = f"La empresa '{client_id}' tiene apagadas las notificaciones de WhatsApp."
    else:
        # Se enumera lo que falta en lugar de un genérico: quien lee el log
        # tiene que saber exactamente qué campo ir a capturar.
        faltantes = [
            nombre
            for nombre, valor in (
                ("instancia", cfg["instance"]),
                ("webhook", cfg["webhook"]),
                ("apikey", cfg["apikey"]),
            )
            if not valor
        ]
        if faltantes:
            cfg["motivo"] = (
                f"La empresa '{client_id}' no tiene {' ni '.join(faltantes)} de WhatsApp. "
                "Captúralo en el dashboard → Configuración → Notificaciones."
            )
        else:
            cfg["puedeEnviar"] = True

    _cache_config[project_id] = cfg
    return cfg


# --- Aprobador del proyecto ---------------------------------------------------

def approver_phone(fs_base: str, token: str, project_id: str) -> tuple[str | None, str]:
    """Teléfono del APROBADOR del proyecto: `(telefono_normalizado, motivo)`.

    Sustituye al viejo `adminPhone` que se capturaba a mano por empresa. El
    aviso le llega así a quien tiene que revisar el PR, y no a un número suelto
    que hay que mantener aparte y que se queda viejo en cuanto cambia el
    responsable. Además el teléfono sale del MISMO lugar que el de los autores
    (Contribuidores), así que solo hay un sitio donde mantenerlo.

    La cadena, leída por REST con el token del service account (que ignora las
    reglas de seguridad):

      projects/{projectId}.approverEmail    → correo del aprobador
      users/{email}.githubLogin             → su login de GitHub
      contributors/{login}.telefonoWhatsapp → su teléfono (10 dígitos → +521)

    Si falta cualquiera de los tres eslabones se devuelve `(None, motivo)` con
    el texto exacto de qué falta y dónde configurarlo: no es un error de CI, es
    un pendiente de captura en el dashboard, y quien lea el log tiene que poder
    resolverlo sin adivinar. Nunca levanta.
    """
    if project_id in _cache_aprobador:
        return _cache_aprobador[project_id]

    def _resolver() -> tuple[str | None, str]:
        correo = _texto(_campos(fs_base, token, f"projects/{project_id}"), "approverEmail")
        if not correo:
            return None, (
                f"el proyecto '{project_id}' no tiene aprobador configurado. "
                "Asígnalo en el dashboard → Proyectos y repos."
            )

        # El id del documento es el propio correo: lleva '@' y '.', así que se
        # escapa antes de meterlo en la ruta REST.
        login = _texto(
            _campos(fs_base, token, f"users/{quote(correo, safe='')}"), "githubLogin"
        )
        if not login:
            return None, (
                f"el aprobador {correo} no tiene login de GitHub. Que capture su token "
                "personal de GitHub en el dashboard (de ahí se deriva su login)."
            )

        crudo = _texto(
            _campos(fs_base, token, f"contributors/{quote(login, safe='')}"),
            "telefonoWhatsapp",
        )
        if not crudo:
            return None, (
                f"el contribuidor {login} no tiene teléfono. Captúralo en el dashboard "
                "→ Contribuidores."
            )
        telefono = normalizar_telefono(crudo)
        if not telefono:
            return None, (
                f"el teléfono del contribuidor {login} ({enmascarar(crudo)}) no tiene un "
                "formato válido: deben ser 10 dígitos o un número internacional con '+'. "
                "Corrígelo en el dashboard → Contribuidores."
            )
        return telefono, ""

    resultado = _resolver()
    _cache_aprobador[project_id] = resultado
    return resultado


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
