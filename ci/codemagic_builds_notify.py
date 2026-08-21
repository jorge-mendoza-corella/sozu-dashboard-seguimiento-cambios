#!/usr/bin/env python3
"""
Avisa por WhatsApp cuando un build de app termina, salga bien o salga mal.

Antes el aviso lo mandaba el `codemagic.yaml` de cada repo de app: el dashboard
le inyectaba `WA_PHONE`/`WA_ACTOR` al disparar el build y el propio workflow
notificaba al final. Ese diseño solo avisa cuando el build llega hasta el final:
si revienta antes —o si el yaml de ese repo solo notifica en éxito— no se manda
nada. Pasó de verdad: un build de Mac falló y no se enteró nadie, que es justo
el caso en el que el aviso importa.

Aquí el aviso deja de depender del build. Este sync corre programado
(.github/workflows/codemagic-builds-notify.yml), le pregunta a Codemagic cómo
terminó cada build reciente y manda el mensaje él mismo. Si Codemagic dice que
terminó, se avisa; el yaml del repo de app ya no tiene voto.

Qué hace, por proyecto:
  1. Lee de Firestore los proyectos con `codemagicAppId`.
  2. Pide a Codemagic los builds recientes de esa app.
  3. De los builds TERMINADOS dentro de la ventana, avisa a quien lo disparó
     desde el dashboard y al APROBADOR del proyecto.
  4. Marca el build como avisado en `buildNotifications/{buildId}`.

Idempotencia — `buildNotifications/{buildId}`:
  El dashboard crea ese doc al disparar el build (ver src/lib/buildNotifications.ts)
  con { projectId, appId, workflowId, actorLogin, actorPhone, actorEmail,
  startedAt, notified: false }; algunos campos pueden faltar. Este sync lo cierra
  con `notified: true`. Si el doc NO existe —build lanzado desde Codemagic
  directo, sin pasar por el dashboard— se crea aquí con `origen: "codemagic"` y
  se avisa igual: un build que nadie lanzó desde el dashboard también puede
  romper la app.

Variables de entorno:
  CODEMAGIC_TOKEN  token de la API de Codemagic (header x-auth-token). Si viene
                   vacío el script no hace nada y termina bien: el workflow no
                   debe salir rojo cada 5 minutos por un secret que aún no existe.
  FIRESTORE_TOKEN  access token de GCP para Firestore REST
  GCP_PROJECT      proyecto Firebase (default: sozu-admin-dev)
  LOOKBACK_MIN     minutos hacia atrás que se miran (default: 180)

Ningún secreto sale al log, y los teléfonos solo aparecen enmascarados a los
últimos 4 dígitos (ver whatsapp.enmascarar).
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests

from whatsapp import (
    approver_phone,
    global_admin_phones,
    enmascarar,
    normalizar_telefono,
    resolve_for_project,
    send,
)

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"
CM_BASE = "https://api.codemagic.io"
TIMEOUT = 30

# Estados terminales de Codemagic. La lista viene de src/lib/codemagic.ts, que
# es la que usa la UI para pintar el resultado.
EXITO = {"finished", "success"}
FRACASO = {"failed", "canceled", "cancelled", "timeout", "skipped"}
# Estados que Codemagic reporta mientras el build sigue vivo. No es una lista
# cerrada (hay intermedios sin documentar), por eso la terminalidad se decide
# también por `finishedAt`.
EN_CURSO = {
    "queued", "initializing", "preparing", "fetching", "building",
    "testing", "publishing", "running", "started", "warning",
}


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


# --- Firestore ----------------------------------------------------------------

def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _texto(fields: dict, key: str) -> str:
    return ((fields.get(key) or {}).get("stringValue") or "").strip()


def list_codemagic_projects(token: str) -> list[dict]:
    """Proyectos con app de Codemagic vinculada: {id, name, appId}."""
    out: list[dict] = []
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
            f = doc.get("fields", {})
            app_id = _texto(f, "codemagicAppId")
            if not app_id:
                continue
            project_id = doc["name"].rsplit("/", 1)[-1]
            out.append({
                "id": project_id,
                "name": _texto(f, "name") or project_id,
                "appId": app_id,
            })
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def leer_registro(token: str, build_id: str) -> dict | None:
    """Campos de buildNotifications/{buildId}, o None si el doc no existe.

    Distinguir "no existe" de "existe vacío" importa: el doc ausente significa
    que el build no salió del dashboard, y eso se marca como `origen: codemagic`.
    """
    r = requests.get(
        f"{FS_BASE}/buildNotifications/{quote(build_id, safe='')}",
        headers=fs_headers(token),
        timeout=TIMEOUT,
    )
    if r.status_code == 404:
        return None
    if r.status_code != 200:
        raise RuntimeError(f"Firestore buildNotifications/{build_id}: {r.status_code} {r.text[:200]}")
    return r.json().get("fields", {}) or {}


def cerrar_registro(
    token: str,
    build_id: str,
    *,
    status: str,
    telefonos: list[str],
    nuevo: bool,
    extra: dict | None = None,
) -> None:
    """Marca el build como avisado para que la próxima corrida no lo repita.

    `notifiedTo` guarda los teléfonos ENMASCARADOS: el doc lo puede leer el
    dashboard desde el navegador, y para saber "sí se avisó" bastan los últimos
    4 dígitos.
    """
    ahora = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    campos: dict = {
        "notified": {"booleanValue": True},
        "notifiedAt": {"timestampValue": ahora},
        "status": {"stringValue": status},
        "notifiedTo": {"arrayValue": {"values": [{"stringValue": t} for t in telefonos]}},
    }
    campos.update(extra or {})
    if nuevo:
        # El build no pasó por el dashboard: queda dicho de dónde salió.
        campos["origen"] = {"stringValue": "codemagic"}
    mask = "".join(f"&updateMask.fieldPaths={k}" for k in campos)
    url = f"{FS_BASE}/buildNotifications/{quote(build_id, safe='')}?{mask.lstrip('&')}"
    r = requests.patch(url, headers=fs_headers(token), json={"fields": campos}, timeout=TIMEOUT)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Firestore write {build_id}: {r.status_code} {r.text[:200]}")


# --- Codemagic ----------------------------------------------------------------

def builds_de(app_id: str, cm_token: str) -> list[dict]:
    """Builds recientes de la app, con el workflowId ya normalizado.

    Los builds definidos en `codemagic.yaml` traen el id en `fileWorkflowId` y
    `workflowId` en null (mismo ajuste que hace src/lib/codemagic.ts).
    """
    r = requests.get(
        f"{CM_BASE}/builds",
        headers={"x-auth-token": cm_token},
        params={"appId": app_id},
        timeout=TIMEOUT,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Codemagic {r.status_code}: {r.text[:200]}")
    builds = r.json().get("builds") or []
    for b in builds:
        b["workflowId"] = b.get("fileWorkflowId") or b.get("workflowId") or ""
    return builds


def _fecha(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def clasificar(build: dict) -> tuple[str, bool]:
    """(resultado, terminó) del build: resultado es 'exito' o 'fracaso'.

    Se considera terminado si el estado es uno de los conocidos o si Codemagic
    ya puso `finishedAt`. Un estado terminal DESCONOCIDO cuenta como fracaso, y
    se dice en el log: avisar de más es preferible a callar un fallo, que es
    exactamente el bug que este sync arregla.
    """
    status = (build.get("status") or "").strip().lower()
    if status in EXITO:
        return "exito", True
    if status in FRACASO:
        return "fracaso", True
    if status in EN_CURSO:
        return "", False
    if build.get("finishedAt"):
        print(f"⚠ Estado terminal desconocido '{status}'; se trata como fallo para no callarlo.")
        return "fracaso", True
    return "", False


def plataforma_de(workflow_id: str) -> str:
    """Plataforma deducida del workflow (android-* / ios-*). '' si no se sabe."""
    w = (workflow_id or "").lower()
    if w.startswith("android"):
        return "Android"
    if w.startswith("ios"):
        return "iOS"
    return ""


def redactar(resultado: str, *, proyecto: str, workflow: str, rama: str, url: str, status: str) -> str:
    """Mensaje de WhatsApp, distinto según cómo terminó el build."""
    plataforma = plataforma_de(workflow)
    quien = f"{workflow} ({plataforma})" if plataforma else (workflow or "el build")
    donde = f" (rama {rama})" if rama else ""
    if resultado == "exito":
        return f"✅ Terminó bien el build {quien} de {proyecto}{donde}. Detalle: {url}"
    raro = "" if status in FRACASO else f" [estado '{status}']"
    return f"❌ Falló el build {quien} de {proyecto}{donde}{raro}. Revisa el log: {url}"


# --- Proceso ------------------------------------------------------------------

def procesar_build(fs_token: str, cm_build: dict, proyecto: dict, resultado: str) -> None:
    """Avisa (o explica por qué no) de un build ya terminado.

    `resultado` ('exito'/'fracaso') lo trae quien llama, que ya clasificó el
    build: volver a clasificarlo aquí duplicaría el aviso de estado desconocido.
    """
    build_id = cm_build.get("_id") or ""
    status = (cm_build.get("status") or "").strip().lower()

    registro = leer_registro(fs_token, build_id)
    nuevo = registro is None
    campos = registro or {}
    if (campos.get("notified") or {}).get("booleanValue"):
        return

    # El proyecto del doc manda sobre el del recorrido: si el dashboard lo
    # registró, sabe mejor que nadie a qué proyecto pertenece ese build.
    project_id = _texto(campos, "projectId") or proyecto["id"]
    cfg = resolve_for_project(FS_BASE, fs_token, project_id)

    app_id = _texto(campos, "appId") or cm_build.get("appId") or proyecto["appId"]
    workflow = cm_build.get("workflowId") or _texto(campos, "workflowId")
    rama = cm_build.get("branch") or ""
    url = f"https://codemagic.io/app/{app_id}/build/{build_id}"
    etiqueta = f"{proyecto['name']} · {workflow or '?'} · build {build_id[-6:]}"

    if not cfg["enabled"]:
        # No se marca como avisado: si la empresa vuelve a prender las
        # notificaciones dentro de la ventana, el aviso todavía puede salir.
        print(f"· {etiqueta}: {cfg['motivo']} No se envía nada.")
        return
    if not cfg["puedeEnviar"]:
        # Aviso normal, no `::error::`: una empresa que todavía no capturó sus
        # datos de WhatsApp es un pendiente de configuración, no una falla del
        # CI. Con anotación roja, cada corrida marcaba el workflow en rojo por
        # algo que el dashboard resuelve en un minuto.
        print(f"⚠ {etiqueta}: {cfg['motivo']} No se envía nada.")
        return

    # Destinatarios: quien lo disparó desde el dashboard y el APROBADOR del
    # proyecto. Si son el mismo número, un solo mensaje.
    #
    # El segundo destinatario era el teléfono administrativo de la empresa, un
    # número suelto que se capturaba a mano y se quedaba viejo en cuanto
    # cambiaba el responsable. Ahora el aviso le llega a quien de verdad tiene
    # que revisar ese proyecto, con el teléfono que ya vive en Contribuidores.
    destinos: list[str] = []
    actor = normalizar_telefono(_texto(campos, "actorPhone"))
    actor_crudo = _texto(campos, "actorPhone")
    if actor_crudo and not actor:
        print(f"⚠ {etiqueta}: el teléfono de quien disparó el build no tiene formato válido; se omite.")

    aprobador, falta = approver_phone(FS_BASE, fs_token, project_id)
    if not aprobador:
        # No se manda ese aviso, pero el de quien disparó el build sigue en pie:
        # un aprobador sin capturar no puede dejar mudo al resto.
        print(f"⚠ {etiqueta}: no se avisa al aprobador porque {falta}")

    for tel in (actor, aprobador):
        if tel and tel not in destinos:
            destinos.append(tel)

    # Y los admins globales suscritos a todos los repos. Van al final y sin
    # duplicar: si el suscrito es además quien disparó el build o el aprobador,
    # ya está en la lista y no se le manda dos veces el mismo mensaje.
    for login, tel in global_admin_phones(FS_BASE, fs_token):
        if tel not in destinos:
            destinos.append(tel)
            print(f"· {etiqueta}: se copia a @{login} (suscrito a todos los repos)")

    if not destinos:
        print(
            f"⚠ {etiqueta}: nadie a quien avisar (ni teléfono de quien lo disparó ni "
            "aprobador del proyecto). Se marca como avisado para no reintentarlo cada corrida."
        )
        cerrar_registro(
            fs_token, build_id, status=status, telefonos=[], nuevo=nuevo,
            extra={"sinDestinatario": {"booleanValue": True}},
        )
        return

    mensaje = redactar(
        resultado, proyecto=proyecto["name"], workflow=workflow, rama=rama, url=url, status=status
    )
    avisados: list[str] = []
    for tel in destinos:
        ok, detalle = send(cfg, tel, mensaje)
        if ok:
            avisados.append(enmascarar(tel))
            print(f"✓ {etiqueta}: avisado {enmascarar(tel)} ({resultado})")
        else:
            print(f"::error::{etiqueta}: no se pudo avisar a {enmascarar(tel)} — {detalle}")

    if not avisados:
        # Ni uno solo entró: NO se marca como avisado, para que la próxima
        # corrida lo reintente en vez de dar el fallo por comunicado.
        return
    cerrar_registro(fs_token, build_id, status=status, telefonos=avisados, nuevo=nuevo)


def main() -> None:
    cm_token = os.environ.get("CODEMAGIC_TOKEN", "").strip()
    if not cm_token:
        # A propósito NO es un error: mientras no exista el secret
        # DASHBOARD_CODEMAGIC_TOKEN el workflow no debe salir rojo cada 5 minutos.
        print(
            "Sin CODEMAGIC_TOKEN: no se pueden consultar los builds. Crea el secret "
            "DASHBOARD_CODEMAGIC_TOKEN en Secret Manager para que empiecen a salir los avisos."
        )
        return

    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not fs_token:
        fail("Falta FIRESTORE_TOKEN.")

    try:
        lookback = int(os.environ.get("LOOKBACK_MIN", "180"))
    except ValueError:
        lookback = 180
    desde = datetime.now(timezone.utc) - timedelta(minutes=max(lookback, 1))

    proyectos = list_codemagic_projects(fs_token)
    if not proyectos:
        print("Ningún proyecto tiene app de Codemagic vinculada. Nada que revisar.")
        return
    print(f"· {len(proyectos)} proyecto(s) con app de Codemagic; ventana de {lookback} min.")

    for proyecto in proyectos:
        # Un proyecto que truene (Codemagic caído, configuración a medias) no
        # puede llevarse a los demás: el aviso de otra app sigue saliendo.
        try:
            builds = builds_de(proyecto["appId"], cm_token)
        except (requests.RequestException, RuntimeError, ValueError) as e:
            print(f"::error::{proyecto['name']}: no se pudieron leer los builds — {e}")
            continue

        revisados = 0
        for build in builds:
            if not build.get("_id"):
                continue
            resultado, termino = clasificar(build)
            if not termino:
                continue
            cuando = _fecha(build.get("finishedAt")) or _fecha(build.get("startedAt"))
            # Sin fecha legible se procesa igual: el registro de idempotencia
            # evita que se repita, y callar un fallo es peor que mirar de más.
            if cuando and cuando < desde:
                continue
            revisados += 1
            try:
                procesar_build(fs_token, build, proyecto, resultado)
            except (requests.RequestException, RuntimeError, ValueError) as e:
                print(f"::error::{proyecto['name']} build {build['_id'][-6:]}: {e}")
        print(f"· {proyecto['name']}: {revisados} build(s) terminado(s) en la ventana.")


if __name__ == "__main__":
    main()
