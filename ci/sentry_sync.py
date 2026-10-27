#!/usr/bin/env python3
"""
Errores de cada proyecto de Sentry, para la pestaña Monitoreo del dashboard.

Por qué un sync y no el navegador: el token de Sentry lee los errores de TODA la
organización (stack traces, datos de usuarios) y no puede viajar al front. Este
script lo usa en CI y deja en Firestore solo el resumen que la pestaña pinta.

Qué repos se monitorean lo decide el dashboard: `repos/{id}.monitoreoSentry`
(lo prende el root en Proyectos → Gestionar). Para cada repo prendido:
  - si no tiene proyecto en Sentry, se crea (slug = nombre del repo);
  - su detector de issues se liga a las alertas de WhatsApp (ALERTAS);
  - se escribe el resumen y el DSN, que el modal muestra para instalar el SDK.
El repo que se apaga pierde su doc `sentry/{slug}` (el proyecto de Sentry se
queda: borrarlo tiraría su historial).

Endpoints de Sentry (org `sozu-lh`, región US):
  GET  /organizations/{org}/projects/                     id y slug de cada proyecto
  POST /teams/{org}/{team}/projects/                      crear proyecto
  GET  /projects/{org}/{slug}/keys/                       DSN
  GET/PUT sentry.io/.../detectors|workflows/              ligar alertas (solo sentry.io)
  GET /organizations/{org}/issues/?project=..&query=..    issues (total en el header X-Hits)
  GET /organizations/{org}/events-stats/?project=..       eventos por día (14 días)
  GET /organizations/{org}/sessions/?project=..           crash-free rate (solo apps)

Solo `production`: es lo que le pega a usuarios reales (dev y preview reportan
a Sentry, pero la pestaña no los mide).

Firestore:
  escribe sentry/{projectSlug}

Variables de entorno:
  FIRESTORE_TOKEN     access token de GCP para Firestore REST
  SENTRY_AUTH_TOKEN   token de Sentry con org:read, project:read, event:read
  SENTRY_ORG          slug de la organización (default: sozu-lh)
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
SENTRY_ORG = os.environ.get("SENTRY_ORG", "sozu-lh")
SENTRY_API = f"https://us.sentry.io/api/0/organizations/{SENTRY_ORG}"
SENTRY_US = "https://us.sentry.io/api/0"
# Detectores y workflows (alertas) solo responden en el host global.
SENTRY_GLOBAL = f"https://sentry.io/api/0/organizations/{SENTRY_ORG}"
SENTRY_TEAM = os.environ.get("SENTRY_TEAM", "sozu")
# Alertas que mandan el WhatsApp (issue nuevo o regresión; pico de errores).
ALERTAS = [w for w in os.environ.get("SENTRY_ALERTAS", "6234467,6234468").split(",") if w]

# El slug de cada proyecto de Sentry es el MISMO nombre del repo en Firestore
# `repos`: así la pestaña cruza cada tarjeta con su repo sin tabla aparte.
ENTORNOS = {"produccion": "production"}
TOP_ISSUES = 5
TIMEOUT = 30


def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


class Sentry:
    def __init__(self, token: str):
        self.s = requests.Session()
        self.s.headers["Authorization"] = f"Bearer {token}"

    def get(self, ruta: str, params: dict) -> requests.Response:
        r = self.s.get(f"{SENTRY_API}/{ruta}", params=params, timeout=TIMEOUT)
        r.raise_for_status()
        return r

    def ids(self) -> dict[str, str]:
        proyectos = self.get("projects/", {}).json()
        # Desde cuándo existe cada proyecto: antes de eso la barra de estado no
        # tiene datos (no es "sin errores").
        self.creados = {p["slug"]: p.get("dateCreated") for p in proyectos}
        return {p["slug"]: p["id"] for p in proyectos}

    def crear(self, slug: str) -> str:
        r = self.s.post(f"{SENTRY_US}/teams/{SENTRY_ORG}/{SENTRY_TEAM}/projects/",
                        json={"name": slug, "slug": slug}, timeout=TIMEOUT)
        r.raise_for_status()
        return str(r.json()["id"])

    def dsn(self, slug: str) -> str:
        r = self.s.get(f"{SENTRY_US}/projects/{SENTRY_ORG}/{slug}/keys/", timeout=TIMEOUT)
        r.raise_for_status()
        llaves = [k for k in r.json() if k.get("isActive", True)]
        return llaves[0]["dsn"]["public"] if llaves else ""

    def ligar_alertas(self, pid: str) -> None:
        """Agrega el detector de issues del proyecto a cada alerta de WhatsApp."""
        r = self.s.get(f"{SENTRY_GLOBAL}/detectors/", params={"project": pid}, timeout=TIMEOUT)
        r.raise_for_status()
        detector = next((d for d in r.json() if d.get("type") == "issue_stream"), None)
        if not detector or set(ALERTAS) <= set(map(str, detector.get("workflowIds") or [])):
            return
        for wid in ALERTAS:
            w = self.s.get(f"{SENTRY_GLOBAL}/workflows/{wid}/", timeout=TIMEOUT)
            w.raise_for_status()
            w = w.json()
            if str(detector["id"]) in map(str, w["detectorIds"]):
                continue
            cuerpo = {k: w[k] for k in ("name", "triggers", "actionFilters", "config", "enabled", "environment")}
            cuerpo["detectorIds"] = [*w["detectorIds"], str(detector["id"])]
            self.s.put(f"{SENTRY_GLOBAL}/workflows/{wid}/", json=cuerpo, timeout=TIMEOUT).raise_for_status()
            print(f"  ligado a la alerta {wid}")

    def contar(self, pid: str, query: str, env: str | None) -> int:
        """Cuántos issues cumplen `query`. Sentry da el total en X-Hits sin paginar."""
        params = {"project": pid, "query": query, "statsPeriod": "14d", "limit": 1}
        if env:
            params["environment"] = env
        r = self.get("issues/", params)
        try:
            return int(r.headers.get("X-Hits", "0"))
        except ValueError:
            return len(r.json())

    def top(self, pid: str, env: str | None, query: str = "is:unresolved", sort: str = "freq") -> list[dict]:
        params = {"project": pid, "query": query, "statsPeriod": "14d",
                  "sort": sort, "limit": TOP_ISSUES}
        if env:
            params["environment"] = env
        out = []
        for i in self.get("issues/", params).json():
            out.append({
                "id": str(i.get("id", "")),
                "shortId": i.get("shortId", ""),
                "titulo": (i.get("title") or "")[:200],
                "culprit": (i.get("culprit") or "")[:200],
                "nivel": i.get("level", "error"),
                "estado": i.get("status", "unresolved"),
                "eventos": int(i.get("count") or 0),
                "usuarios": int(i.get("userCount") or 0),
                "primeraVez": i.get("firstSeen"),
                "ultimaVez": i.get("lastSeen"),
                "url": i.get("permalink", ""),
            })
        return out

    def serie(self, pid: str, env: str | None, dias: int = 14) -> list[int]:
        """Eventos de error por día, últimos `dias` días (el más viejo primero, hoy al final)."""
        # `partial=1`: sin él Sentry corta en el último día COMPLETO y lo de hoy
        # no sale en la serie (la tarjeta decía 0 eventos con issues de hoy).
        params = {"project": pid, "statsPeriod": f"{dias}d", "interval": "1d",
                  "yAxis": "count()", "dataset": "errors", "partial": "1"}
        if env:
            params["environment"] = env
        datos = self.get("events-stats/", params).json().get("data", [])
        return [int((punto[1] or [{}])[0].get("count", 0)) for punto in datos][-dias:]

    def crash_free(self, pid: str, env: str | None) -> float | None:
        params = {"project": pid, "statsPeriod": "14d", "interval": "1d",
                  "field": "crash_free_rate(session)"}
        if env:
            params["environment"] = env
        grupos = self.get("sessions/", params).json().get("groups", [])
        if not grupos:
            return None
        valor = grupos[0].get("totals", {}).get("crash_free_rate(session)")
        return float(valor) if valor is not None else None


def _valor(v):
    """Python -> valor de Firestore REST."""
    if v is None:
        return {"nullValue": None}
    if isinstance(v, datetime):
        return {"timestampValue": v.isoformat().replace("+00:00", "Z")}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, list):
        return {"arrayValue": {"values": [_valor(x) for x in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: _valor(x) for k, x in v.items()}}}
    return {"stringValue": str(v)}


def _texto(doc: dict, campo: str) -> str:
    return doc.get("fields", {}).get(campo, {}).get("stringValue", "")


def alcances(token: str) -> dict[str, dict]:
    """slug (= nombre del repo) -> alcance, de los repos con `monitoreoSentry`.

    Las reglas de `sentry/*` deciden con esto quién lee cada doc: el permiso
    `verMonitoreo` va por empresa, proyecto y repo, igual que los de CI/CD.
    """
    def listar(coleccion: str) -> list[dict]:
        docs, page = [], None
        while True:
            params = {"pageSize": 300, **({"pageToken": page} if page else {})}
            r = requests.get(f"{FS_BASE}/{coleccion}", headers=fs_headers(token), params=params, timeout=TIMEOUT)
            r.raise_for_status()
            j = r.json()
            docs += j.get("documents", [])
            page = j.get("nextPageToken")
            if not page:
                return docs

    empresa = {d["name"].rsplit("/", 1)[-1]: _texto(d, "clientId") for d in listar("projects")}
    repos = listar("repos")
    # Todos los repos de cada proyecto: las reglas los necesitan para leer
    # `repoIds` por proyecto (sin marcar ninguno de ESTE proyecto = ve todos).
    del_proyecto: dict[str, list[str]] = {}
    for d in repos:
        del_proyecto.setdefault(_texto(d, "projectId"), []).append(d["name"].rsplit("/", 1)[-1])
    salida = {}
    for d in repos:
        nombre, proyecto = _texto(d, "repo"), _texto(d, "projectId")
        if not d.get("fields", {}).get("monitoreoSentry", {}).get("booleanValue"):
            continue
        if nombre in salida:
            # El slug de Sentry es el nombre del repo: dos repos homónimos de
            # distinto dueño chocarían. Se queda el primero.
            print(f"::warning::{nombre}: hay dos repos con ese nombre; se monitorea solo uno.")
            continue
        salida[nombre] = {
            "repoId": d["name"].rsplit("/", 1)[-1],
            "projectId": proyecto,
            "clientId": empresa.get(proyecto, ""),
            "reposDelProyecto": del_proyecto.get(proyecto, []),
        }
    return salida


def docs_existentes(token: str) -> list[str]:
    r = requests.get(f"{FS_BASE}/sentry", headers=fs_headers(token),
                     params={"pageSize": 300, "mask.fieldPaths": "slug"}, timeout=TIMEOUT)
    r.raise_for_status()
    return [d["name"].rsplit("/", 1)[-1] for d in r.json().get("documents", [])]


def tickets(token: str) -> dict[str, dict]:
    """issueId -> {numero, url} de `sentryTickets` (los levanta Monitoreo en el portal)."""
    salida, page = {}, None
    while True:
        params = {"pageSize": 300, **({"pageToken": page} if page else {})}
        r = requests.get(f"{FS_BASE}/sentryTickets", headers=fs_headers(token), params=params, timeout=TIMEOUT)
        r.raise_for_status()
        j = r.json()
        for d in j.get("documents", []):
            f = d.get("fields", {})
            numero = f.get("numero", {}).get("integerValue")
            if numero:
                salida[d["name"].rsplit("/", 1)[-1]] = {"numero": int(numero), "url": f.get("url", {}).get("stringValue", "")}
        page = j.get("nextPageToken")
        if not page:
            return salida


def con_ticket(issues: list[dict], por_issue: dict[str, dict]) -> list[dict]:
    return [{**i, "ticket": por_issue[i["id"]]} if i["id"] in por_issue else i for i in issues]


def borrar(token: str, slug: str) -> None:
    r = requests.delete(f"{FS_BASE}/sentry/{quote(slug, safe='')}", headers=fs_headers(token), timeout=TIMEOUT)
    if r.status_code not in (200, 204):
        print(f"::error::Firestore delete {slug}: {r.status_code} {r.text[:200]}")


def escribir(token: str, slug: str, datos: dict) -> None:
    campos = {k: _valor(v) for k, v in datos.items()}
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in campos)
    r = requests.patch(
        f"{FS_BASE}/sentry/{quote(slug, safe='')}?{mask}",
        headers=fs_headers(token), json={"fields": campos}, timeout=TIMEOUT,
    )
    if r.status_code not in (200, 201):
        print(f"::error::Firestore write {slug}: {r.status_code} {r.text[:200]}")


def vacio() -> dict:
    return {"sinResolver": 0, "nuevos24h": 0, "serie14d": [0] * 14, "serie90d": [0] * 90, "top": [], "resueltos": [], "crashFree": None}


def resumen(api: Sentry, slug: str, pid: str, env: str | None) -> dict:
    if env:
        # Sentry contesta 404 a cualquier consulta con un entorno que el proyecto
        # todavía no ha visto (un repo que solo ha mandado errores de dev). No es
        # un fallo: es un proyecto sin errores de ese entorno.
        try:
            api.get("issues/", {"project": pid, "environment": env, "limit": 1})
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 404:
                return vacio()
            raise
    datos = {
        "sinResolver": api.contar(pid, "is:unresolved", env),
        "nuevos24h": api.contar(pid, "is:unresolved firstSeen:-24h", env),
        "serie14d": api.serie(pid, env),
        # Barra de estado de la pestaña: 90 días es lo que guarda Sentry.
        "serie90d": api.serie(pid, env, 90),
        "top": api.top(pid, env),
        # Resueltos o ignorados con actividad en los 14 días, los más recientes
        # primero: la pestaña los lista para saber qué ya se atendió.
        "resueltos": api.top(pid, env, "!is:unresolved", "date"),
        "crashFree": None,
    }
    # Solo las apps mandan sesiones; a las demás Sentry les contesta vacío o error.
    try:
        datos["crashFree"] = api.crash_free(pid, env)
    except requests.RequestException:
        pass
    return datos


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    sentry_token = os.environ.get("SENTRY_AUTH_TOKEN", "").strip()
    if not fs_token:
        print("::error::Falta FIRESTORE_TOKEN.")
        sys.exit(1)
    if not sentry_token:
        print("::error::Falta SENTRY_AUTH_TOKEN (Secret Manager o secreto del repo).")
        sys.exit(1)

    api = Sentry(sentry_token)
    ids = api.ids()
    donde = alcances(fs_token)
    ligados = tickets(fs_token)
    ahora = datetime.now(timezone.utc)
    fallos = 0

    # Repos apagados: su doc sale de la pestaña (el proyecto de Sentry se queda).
    for slug in set(docs_existentes(fs_token)) - set(donde):
        print(f"- {slug}: monitoreo apagado; se quita de la pestaña.")
        borrar(fs_token, slug)

    for slug, alcance in sorted(donde.items()):
        try:
            pid = ids.get(slug)
            if not pid:
                pid = api.crear(slug)
                print(f"+ {slug}: proyecto creado en Sentry ({pid}).")
            api.ligar_alertas(pid)
            dsn = api.dsn(slug)
            entornos = {nombre: resumen(api, slug, pid, env) for nombre, env in ENTORNOS.items()}
            for r in entornos.values():
                r["top"] = con_ticket(r["top"], ligados)
                r["resueltos"] = con_ticket(r["resueltos"], ligados)
        except requests.RequestException as e:
            # Un proyecto que falla no se lleva a los demás; el dato anterior
            # se queda en Firestore y la pestaña lo marca como viejo.
            fallos += 1
            print(f"::warning::{slug}: Sentry falló ({e})")
            continue
        prod = entornos["produccion"]
        print(f"✓ {slug}: {prod['sinResolver']} sin resolver, {prod['nuevos24h']} nuevos 24h (producción)")
        escribir(fs_token, slug, {
            "slug": slug,
            "sentryProjectId": pid,
            **alcance,
            "dsn": dsn,
            "sentryCreadoEn": getattr(api, "creados", {}).get(slug),
            "url": f"https://{SENTRY_ORG}.sentry.io/issues/?project={pid}",
            "entornos": entornos,
            "revisadoAt": ahora,
        })

    if donde and fallos == len(donde):
        sys.exit(1)


if __name__ == "__main__":
    main()
