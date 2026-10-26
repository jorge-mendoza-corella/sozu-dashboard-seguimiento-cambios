#!/usr/bin/env python3
"""
Errores de cada proyecto de Sentry, para la pestaña Monitoreo del dashboard.

Por qué un sync y no el navegador: el token de Sentry lee los errores de TODA la
organización (stack traces, datos de usuarios) y no puede viajar al front. Este
script lo usa en CI y deja en Firestore solo el resumen que la pestaña pinta.

Endpoints de Sentry (org `sozu-lh`, región US):
  GET /organizations/{org}/projects/                      id y slug de cada proyecto
  GET /organizations/{org}/issues/?project=..&query=..    issues (total en el header X-Hits)
  GET /organizations/{org}/events-stats/?project=..       eventos por día (14 días)
  GET /organizations/{org}/sessions/?project=..           crash-free rate (solo apps)

Cada métrica se calcula dos veces: solo `production` y todos los entornos. La
pestaña enseña producción por defecto —es lo que le pega a usuarios reales—,
pero mientras un repo no tenga deploy a producción con el SDK, lo único que hay
es lo de dev, y sin la segunda vista el proyecto se vería vacío.

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

# Proyectos de Sentry que se monitorean. El slug es el MISMO nombre del repo en
# Firestore `repos`: así la pestaña cruza cada tarjeta con su proyecto del
# dashboard sin una tabla de equivalencias aparte.
PROYECTOS = [
    "sozu-admin", "server-stp", "sozu-edge-functions", "sozu-mcp",
    "sozu-cliente-app", "sozu-agente-app", "sozu-web",
]
# Las apps Flutter reportan sesiones; el resto no, y pedírselas solo regresa vacío.
APPS = {"sozu-cliente-app", "sozu-agente-app"}

ENTORNOS = {"produccion": "production", "todos": None}
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
        return {p["slug"]: p["id"] for p in self.get("projects/", {}).json()}

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

    def top(self, pid: str, env: str | None) -> list[dict]:
        params = {"project": pid, "query": "is:unresolved", "statsPeriod": "14d",
                  "sort": "freq", "limit": TOP_ISSUES}
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
                "eventos": int(i.get("count") or 0),
                "usuarios": int(i.get("userCount") or 0),
                "primeraVez": i.get("firstSeen"),
                "ultimaVez": i.get("lastSeen"),
                "url": i.get("permalink", ""),
            })
        return out

    def serie(self, pid: str, env: str | None) -> list[int]:
        """Eventos de error por día, últimos 14 días (el más viejo primero)."""
        params = {"project": pid, "statsPeriod": "14d", "interval": "1d",
                  "yAxis": "count()", "dataset": "errors"}
        if env:
            params["environment"] = env
        datos = self.get("events-stats/", params).json().get("data", [])
        return [int((punto[1] or [{}])[0].get("count", 0)) for punto in datos][-14:]

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
    return {"sinResolver": 0, "nuevos24h": 0, "serie14d": [0] * 14, "top": [], "crashFree": None}


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
        "top": api.top(pid, env),
        "crashFree": None,
    }
    if slug in APPS:
        datos["crashFree"] = api.crash_free(pid, env)
    return datos


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    sentry_token = os.environ.get("SENTRY_AUTH_TOKEN", "").strip()
    escribe = os.environ.get("SENTRY_SYNC_DRY_RUN") != "1"
    if escribe and not fs_token:
        print("::error::Falta FIRESTORE_TOKEN.")
        sys.exit(1)
    if not sentry_token:
        print("::error::Falta SENTRY_AUTH_TOKEN (Secret Manager o secreto del repo).")
        sys.exit(1)

    api = Sentry(sentry_token)
    ids = api.ids()
    ahora = datetime.now(timezone.utc)
    fallos = 0

    for slug in PROYECTOS:
        pid = ids.get(slug)
        if not pid:
            print(f"⚠ {slug}: no existe en Sentry ({SENTRY_ORG}); se salta.")
            continue
        try:
            entornos = {nombre: resumen(api, slug, pid, env) for nombre, env in ENTORNOS.items()}
        except requests.RequestException as e:
            # Un proyecto que falla no se lleva a los demás; el dato anterior
            # se queda en Firestore y la pestaña lo marca como viejo.
            fallos += 1
            print(f"::warning::{slug}: Sentry falló ({e})")
            continue
        prod = entornos["produccion"]
        print(f"✓ {slug}: {prod['sinResolver']} sin resolver, {prod['nuevos24h']} nuevos 24h (producción)")
        if escribe:
            escribir(fs_token, slug, {
                "slug": slug,
                "projectId": pid,
                "url": f"https://{SENTRY_ORG}.sentry.io/issues/?project={pid}",
                "entornos": entornos,
                "revisadoAt": ahora,
            })

    if fallos == len(PROYECTOS):
        sys.exit(1)


if __name__ == "__main__":
    main()
