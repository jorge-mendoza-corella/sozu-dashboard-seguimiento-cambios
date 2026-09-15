#!/usr/bin/env python3
"""
Quién está conectado AHORA en las apps, leído de Supabase y dejado en Firestore.

Por qué este puente: la verdad de "conectado" vive en `portal_sesiones`, una
tabla de Supabase que las dos apps Flutter alimentan con un latido cada cinco
minutos (`register_portal_session` / `touch_portal_session`, los mismos RPCs que
usan los portales web). Este dashboard corre sobre Firestore y no tiene sesión
de Supabase con la que pedir esa RPC desde el navegador, así que la lee el CI y
deja el resultado donde el tablero sí puede verlo.

Qué sustituye: la píldora del modal de descargas venía de GA4 Realtime
(`activeUsers`). Eso cuenta dispositivos anónimos que Analytics ve en su ventana
de 30 minutos, que no es lo mismo que sesiones de usuarios con nombre y apellido
—y por eso nunca cuadraba con lo que enseña el Portal Alta Dirección—. Con esto
los dos tableros cuentan lo mismo, de la misma tabla, con la misma ventana.

Firestore:
  lee     projects/{id}.isApp, .androidPackage, .iosBundleId
  escribe portalOnline/{projectId}

Variables de entorno:
  FIRESTORE_TOKEN             access token de GCP para Firestore REST
  SUPABASE_URL                base de PRODUCCIÓN (secreto DASHBOARD_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY   llave de servicio de ESA base
  GCP_PROJECT                 id del proyecto Firebase (default: sozu-admin-dev)
  ONLINE_MINUTOS              ventana de inactividad (default: 30)
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from urllib.parse import quote

import requests

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"

# La ventana. Mediciones usa 15 minutos, que va bien para el web —ahí el latido
# es cada 60 s—, pero las apps laten cada 5 minutos y iOS y Android congelan sus
# timers en cuanto la app pasa a segundo plano: con 15 minutos, quien usa la app
# a ratos aparece y desaparece. 30 cubre ese hueco sin contar a quien ya cerró.
MINUTOS = int(os.environ.get("ONLINE_MINUTOS", "30"))

# Qué portal de `portal_sesiones` le toca a cada app del dashboard. La clave se
# busca dentro del package: un mapa por projectId se rompería en cuanto alguien
# recreara el proyecto.
PORTAL_POR_APP = {"clientes": "clientes", "agentes": "agentes"}

# Lo que la RPC pone en `tipo_dispositivo` cuando el user_agent trae el token de
# una app nativa (`SozuClienteApp` / `SozuAgenteApp` / `Despia`).
ES_APP = "app"


def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _str(f: dict, key: str) -> str:
    return (f.get(key) or {}).get("stringValue", "").strip()


def list_apps(token: str) -> list[dict]:
    """Proyectos app del dashboard, con el portal de Supabase que les toca."""
    out: list[dict] = []
    page = None
    while True:
        params = {"pageSize": 200}
        if page:
            params["pageToken"] = page
        r = requests.get(f"{FS_BASE}/projects", headers=fs_headers(token), params=params, timeout=30)
        if r.status_code != 200:
            print(f"::error::Firestore projects: {r.status_code} {r.text[:200]}")
            sys.exit(1)
        data = r.json()
        for doc in data.get("documents", []):
            f = doc.get("fields", {})
            if not f.get("isApp", {}).get("booleanValue"):
                continue
            pkg = _str(f, "androidPackage")
            bundle = _str(f, "iosBundleId")
            clave = next((k for k in PORTAL_POR_APP if k in (pkg or bundle).lower()), None)
            if not clave:
                continue
            out.append({
                "projectId": doc["name"].rsplit("/", 1)[-1],
                "etiqueta": pkg or bundle,
                "portal": PORTAL_POR_APP[clave],
            })
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def sesiones_activas(url: str, key: str, portal: str) -> tuple[list[dict] | None, str | None]:
    """Las sesiones vivas de ese portal, vía la misma RPC que usa el portal web."""
    r = requests.post(
        f"{url.rstrip('/')}/rest/v1/rpc/sesiones_activas_por_portal",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        json={"p_portal": portal, "p_minutos_inactividad": MINUTOS},
        timeout=30,
    )
    if r.status_code != 200:
        return None, f"Supabase {r.status_code}: {r.text[:200]}"
    return r.json(), None


def del_mes(url: str, key: str, portal: str) -> dict | None:
    """Uso del mes en curso de ese portal: gente, sesiones y cuánto dura una.

    Misma RPC que el Portal Alta Dirección usa para su resumen mensual, así que
    los dos tableros enseñan el mismo número y no hay que explicar por qué
    difieren. Devuelve None si la RPC falla: es un extra al lado del "ahora".
    """
    ahora = datetime.now(timezone.utc)
    desde = ahora.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    r = requests.post(
        f"{url.rstrip('/')}/rest/v1/rpc/visitas_historicas_por_portal",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={"p_desde": desde.isoformat(), "p_hasta": None},
        timeout=30,
    )
    if r.status_code != 200:
        print(f"  · sin resumen del mes: Supabase {r.status_code} {r.text[:120]}")
        return None
    for fila in r.json():
        if fila.get("portal") == portal:
            return {
                "usuarios": fila.get("usuarios_unicos") or 0,
                "sesiones": fila.get("total_sesiones") or 0,
                "duracionPromedioMin": float(fila.get("duracion_promedio_min") or 0),
            }
    # El portal existe pero nadie entró este mes: eso es un cero, no un fallo.
    return {"usuarios": 0, "sesiones": 0, "duracionPromedioMin": 0.0}


def cerrar_abandonadas(url: str, key: str) -> None:
    """Cierra las sesiones que nadie cerró.

    `close_portal_session` solo corre al cerrar sesión a propósito; quien mata
    la app o cierra la pestaña de golpe deja su fila con `sesion_fin` vacío para
    siempre. Ninguna cifra de hoy depende de eso —las RPC filtran por
    `ultima_actividad`— pero `sesion_fin IS NULL` LEE como "sigue dentro", y es
    el criterio que cualquiera escribiría en la siguiente consulta.

    Va aquí, en el sync que ya corre cada diez minutos, en vez de en un cron de
    base de datos: es una llamada y no hay que mantener otra pieza.
    """
    r = requests.post(
        f"{url.rstrip('/')}/rest/v1/rpc/cerrar_sesiones_abandonadas",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={"p_minutos": 120},
        timeout=30,
    )
    if r.status_code != 200:
        # Mientras la migración no esté aplicada la función no existe. Es
        # higiene: se avisa y se sigue.
        print(f"· no se pudieron cerrar sesiones abandonadas: {r.status_code} {r.text[:120]}")
        return
    try:
        n = int(r.json())
    except (ValueError, TypeError):
        return
    if n:
        print(f"· {n} sesiones abandonadas cerradas")


def resumir(filas: list[dict]) -> dict:
    """Personas, sesiones y de dónde entran."""
    personas: set[str] = set()
    desde_app = 0
    ultima: str | None = None

    for f in filas:
        # Sin correo no hay a quién contar como persona, pero la sesión existe:
        # se cuenta con su propio id para no perderla del total.
        personas.add(f.get("email_usuario") or f"sesion:{f.get('session_id')}")
        if (f.get("tipo_dispositivo") or "").lower() == ES_APP:
            desde_app += 1
        act = f.get("ultima_actividad")
        if act and (ultima is None or act > ultima):
            ultima = act

    return {
        "usuarios": len(personas),
        "sesiones": len(filas),
        "desdeApp": desde_app,
        "desdeWeb": len(filas) - desde_app,
        "ultimaActividad": ultima,
        "ventanaMinutos": MINUTOS,
    }


def write_doc(token: str, project_id: str, payload: dict, error: str | None) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    body = {
        "fields": {
            "projectId": {"stringValue": project_id},
            "updatedAt": {"timestampValue": now},
            "raw": {"stringValue": json.dumps(payload or {}, ensure_ascii=False)},
            "error": {"stringValue": error} if error else {"nullValue": None},
        }
    }
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in body["fields"])
    r = requests.patch(
        f"{FS_BASE}/portalOnline/{quote(project_id, safe='')}?{mask}",
        headers=fs_headers(token), json=body, timeout=30,
    )
    if r.status_code not in (200, 201):
        print(f"::error::Firestore write {project_id}: {r.status_code} {r.text[:200]}")
        sys.exit(1)


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not fs_token:
        print("::error::Falta FIRESTORE_TOKEN.")
        sys.exit(1)

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        # Igual que el resto de puentes a Supabase: es un consumidor extra y no
        # debe tumbar el workflow si le falta la credencial.
        print("· Sin SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: no se puede leer quién está en línea.")
        return

    cerrar_abandonadas(url, key)

    for app in list_apps(fs_token):
        filas, error = sesiones_activas(url, key, app["portal"])
        if error:
            print(f"⚠ {app['etiqueta']}: {error}")
            write_doc(fs_token, app["projectId"], {}, error)
            continue
        datos = resumir(filas or [])
        datos["mes"] = del_mes(url, key, app["portal"])
        write_doc(fs_token, app["projectId"], datos, None)
        print(
            f"✓ {app['etiqueta']}: {datos['usuarios']} en línea "
            f"({datos['desdeApp']} app · {datos['desdeWeb']} web) "
            f"en los últimos {MINUTOS} min"
        )


if __name__ == "__main__":
    main()
