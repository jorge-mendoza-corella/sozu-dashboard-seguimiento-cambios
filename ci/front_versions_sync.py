#!/usr/bin/env python3
"""
Vuelca a Firestore la versión que sirve cada front, para mostrarla en su card.

Un repo cuenta como front cuando tiene `frontUrl` en `repos/{owner__repo}`. El
dashboard no puede leer esos sitios por su cuenta: no mandan cabeceras CORS, así
que un fetch desde el navegador muere antes de empezar. Aquí sí, es HTTP normal.

La versión se busca en cascada, de lo explícito a lo heurístico:

  1. `<url>/version.json` — campo `version` (o `build`/`appVersion`). Es la vía
     recomendada: si un front la publica, esto no falla nunca.
  2. `<meta name="app-version">` (también `version` o `build`) en el HTML.
  3. Un patrón de versión en el propio HTML.
  4. Un patrón de versión en los primeros bundles JS que referencia el HTML —
     así se lee la de los fronts hechos con Vite, donde la versión se inyecta en
     el bundle (`__APP_BUILD__`) y no aparece en el HTML.

Si nada da resultado se guarda `version: null` con el motivo, y la card muestra
un guión en lugar de inventar un dato.

Corre en .github/workflows/play-tracks-sync.yml.

Variables de entorno:
  FIRESTORE_TOKEN   access token de GCP con acceso a Firestore
  GCP_PROJECT       proyecto Firebase (default: sozu-admin-dev)
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from urllib.parse import quote, urljoin

import requests

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"

TIMEOUT = 30
# Versiones inequívocas, que se pueden buscar a pelo en el HTML o en el bundle:
#   · 1.0.2026.0807.1521   — fronts Vite (dashboard, admin)
#   · 1.0.3-260812.1018    — apps Flutter: X.Y.Z del tag + hora del build
# La `v` de "v1.0.2026…" va fuera del grupo: pegada al número no hay \b que la
# separe, y sin esto un `<div>v1.0.2026.0807.1521</div>` no casaba.
DATED_VERSION = re.compile(
    r"v?(\d+\.\d+\.\d+-\d{6}\.\d{4}|\d+\.\d+\.20\d{2}\.\d{4}\.\d{4})\b"
)
# Un semver suelto NO sirve: `avances.sozu.com` importa el SDK de Firebase
# desde gstatic y el primer "1.2.3" del HTML era la versión de esa librería.
# Solo se acepta si algo lo declara como la versión del sitio.
LABELED_VERSION = [
    re.compile(r"""data-(?:app-)?version=["']([^"']+)["']""", re.IGNORECASE),
    re.compile(r"""(?:app_?version|__APP_BUILD__|APP_VERSION)["']?\s*[:=]\s*["']([^"']+)["']""", re.IGNORECASE),
    re.compile(r"""(?:versi[oó]n|version|build)\s*:?\s*v?(\d+\.\d+(?:\.\d+)*)\b""", re.IGNORECASE),
]
META_VERSION = re.compile(
    r"""<meta[^>]+name=["'](?:app-version|version|build)["'][^>]+content=["']([^"']+)["']""",
    re.IGNORECASE,
)
SCRIPT_SRC = re.compile(r"""<script[^>]+src=["']([^"']+\.js)["']""", re.IGNORECASE)
# Referencias a otros .js DENTRO de un bundle. Las apps Flutter cargan
# `flutter_bootstrap.js` desde el HTML y este a su vez `main.dart.js`, que es
# donde vive la versión que se ve en pantalla: sin seguir ese salto no se
# encuentra nunca.
JS_REF = re.compile(r"""["']([\w./-]+\.js)(?:\?[^"']*)?["']""")
MAX_BUNDLES = 3
MAX_NESTED = 2


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


def headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def fetch_text(url: str) -> tuple[str | None, str | None]:
    try:
        r = requests.get(url, timeout=TIMEOUT, headers={"Cache-Control": "no-cache"})
    except requests.RequestException as e:
        return None, f"no se pudo leer {url}: {e}"
    if r.status_code != 200:
        return None, f"{url} respondió {r.status_code}"
    return r.text, None


def first_version(text: str, *, allow_labeled: bool = True) -> str | None:
    """Versión del sitio, o None. Nunca devuelve un semver sin etiqueta."""
    m = DATED_VERSION.search(text)
    if m:
        return m.group(1)
    if allow_labeled:
        for pat in LABELED_VERSION:
            m = pat.search(text)
            if m and m.group(1).strip():
                return m.group(1).strip()
    return None


def front_repos(token: str) -> list[dict]:
    """Repos con frontUrl, leídos de la colección `repos`."""
    out: list[dict] = []
    page = None
    while True:
        params = {"pageSize": 300}
        if page:
            params["pageToken"] = page
        r = requests.get(f"{FS_BASE}/repos", headers=headers(token), params=params, timeout=TIMEOUT)
        if r.status_code != 200:
            fail(f"Firestore read repos: {r.status_code} {r.text[:300]}")
        body = r.json()
        for d in body.get("documents", []):
            fields = d.get("fields", {})
            url = (fields.get("frontUrl") or {}).get("stringValue", "").strip()
            if not url:
                continue
            out.append({
                "id": d["name"].rsplit("/", 1)[-1],
                "url": url.rstrip("/"),
                "label": (fields.get("label") or {}).get("stringValue") or "",
            })
        page = body.get("nextPageToken")
        if not page:
            return out


def read_version(url: str) -> tuple[str | None, str, str | None]:
    """Devuelve (versión, fuente, error). La versión es None si no se encontró.

    Se recorren todas las fuentes y gana la más completa, no la primera: el
    `/version.json` de una app Flutter lo genera el propio build con la versión
    del pubspec (`1.0.0`), mientras el pie del sitio anuncia `1.0.3-260812.1018`.
    Quedarse con la primera fuente mostraba `1.0.0` en la card mientras el sitio
    decía otra cosa. Una versión con sufijo de build (o datada) siempre gana a un
    semver pelado.
    """
    # Candidatos como (rango, versión, fuente); rango 0 = inequívoca.
    candidatos: list[tuple[int, str, str]] = []

    def anota(valor: str | None, fuente: str) -> None:
        if not valor:
            return
        valor = valor.strip()
        if not valor:
            return
        # Con sufijo (-260812.1018) o datada: es la versión real del build.
        rango = 0 if DATED_VERSION.fullmatch(valor) else (1 if "-" in valor else 2)
        candidatos.append((rango, valor, fuente))

    def mejor() -> tuple[str, str] | None:
        if not candidatos:
            return None
        rango, valor, fuente = min(candidatos, key=lambda c: c[0])
        return valor, fuente

    # 1 · version.json, la vía explícita.
    try:
        r = requests.get(f"{url}/version.json", timeout=TIMEOUT, headers={"Cache-Control": "no-cache"})
        if r.status_code == 200:
            data = r.json()
            for key in ("version", "build", "appVersion"):
                val = data.get(key)
                if isinstance(val, (str, int, float)):
                    anota(str(val), "version.json")
                    break
    except (requests.RequestException, ValueError):
        pass  # no lo publica o no es JSON: se sigue con el HTML

    elegido = mejor()
    if elegido and candidatos[0][0] == 0:
        return elegido[0], elegido[1], None  # ya es inequívoca: no bajar bundles

    html, err = fetch_text(url)
    if err:
        # Sin HTML no hay más que rascar; si version.json dio algo, sirve.
        return (elegido[0], elegido[1], None) if elegido else (None, "-", err)

    m = META_VERSION.search(html)
    if m:
        anota(m.group(1), "meta")
    anota(first_version(html), "html")

    # Los bundles JS: aquí solo vale la versión inequívoca, porque un bundle
    # está lleno de versiones de librerías.
    if not any(c[0] == 0 for c in candidatos):
        for src in bundle_urls(url, html):
            js, _ = fetch_text(src)
            if not js:
                continue
            v = first_version(js, allow_labeled=False)
            if v:
                anota(v, "bundle")
                break

    elegido = mejor()
    if elegido:
        return elegido[0], elegido[1], None
    return None, "-", "el sitio no publica una versión reconocible (considera exponer /version.json)"


def bundle_urls(url: str, html: str) -> list[str]:
    """Bundles a revisar: los del HTML y los que estos referencian."""
    base = url + "/"
    propios = [urljoin(base, s) for s in SCRIPT_SRC.findall(html) if not s.startswith(("http://", "https://"))]
    salida = list(propios[:MAX_BUNDLES])
    for src in propios[:MAX_NESTED]:
        js, _ = fetch_text(src)
        if not js:
            continue
        for ref in JS_REF.findall(js)[:MAX_BUNDLES]:
            hijo = urljoin(base, ref)
            if hijo not in salida:
                salida.append(hijo)
    return salida


def write_doc(token: str, repo_id: str, url: str, version: str | None, source: str, error: str | None) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    fields = {
        "url": {"stringValue": url},
        "version": {"stringValue": version} if version else {"nullValue": None},
        "source": {"stringValue": source},
        "checkedAt": {"timestampValue": now},
        "error": {"stringValue": error} if error else {"nullValue": None},
    }
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in fields)
    r = requests.patch(
        f"{FS_BASE}/frontVersions/{quote(repo_id, safe='')}?{mask}",
        headers=headers(token), json={"fields": fields}, timeout=TIMEOUT,
    )
    if r.status_code not in (200, 201):
        fail(f"Firestore write frontVersions/{repo_id}: {r.status_code} {r.text[:300]}")


def main() -> None:
    token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not token:
        fail("Falta FIRESTORE_TOKEN.")

    repos = front_repos(token)
    if not repos:
        print("· sin repos con frontUrl configurada; nada que revisar")
        return

    for r in repos:
        version, source, error = read_version(r["url"])
        write_doc(token, r["id"], r["url"], version, source, error)
        nombre = r["label"] or r["id"]
        if version:
            print(f"✓ {nombre}: {version} (via {source}) · {r['url']}")
        else:
            print(f"⚠ {nombre}: sin versión · {r['url']} · {error}")


if __name__ == "__main__":
    main()
