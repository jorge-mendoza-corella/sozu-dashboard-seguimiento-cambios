#!/usr/bin/env python3
"""
Empuja a Supabase lo que Codemagic factura por app, para que el Portal Alta
Dirección lo muestre junto a las descargas.

Hermano de `supabase_installs_push.py`, y por la misma razón: el portal es un
navegador contra Supabase y el desglose de facturación de Codemagic vive en
`/user`, que no manda cabeceras CORS. Eso ya lo resuelve `codemagic_usage_sync.py`
—corre en Actions, sin esa restricción— y deja el resultado en
`codemagicConsumo/{codemagicAppId}`. Esto solo lo copia a donde el portal puede
leerlo.

Escribe en dos tablas:

  public.app_costos_codemagic       una fila por app: su parte de la factura
                                    del periodo y la merma.
  public.app_costos_codemagic_pase  una fila por app y plataforma: lo que cuesta
                                    mandar una versión a esa tienda.

Ambas con UPSERT: el sync reescribe el estado del periodo vigente en cada
corrida, no lleva histórico.

Variables de entorno (las mismas del puente de descargas):
  FIRESTORE_TOKEN             access token de GCP para Firestore REST
  SUPABASE_URL                base a la que escribir (secreto DASHBOARD_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY   llave de servicio de ESA base (salta RLS)
  GCP_PROJECT                 id del proyecto Firebase (default: sozu-admin-dev)
"""
from __future__ import annotations

import json
import os
import sys
from urllib.parse import quote

import requests

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"

# Ids de `public.apps` en Supabase. Es catálogo: 1 = clientes, 2 = agentes.
APPS_SUPABASE = {"clientes": 1, "agentes": 2}


def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _str(f: dict, key: str) -> str:
    return (f.get(key) or {}).get("stringValue", "").strip()


def raw_de(token: str, coleccion: str, doc_id: str) -> dict:
    """`raw` de un documento del sync, o {} si no existe."""
    r = requests.get(
        f"{FS_BASE}/{coleccion}/{quote(doc_id, safe='')}",
        headers=fs_headers(token), timeout=30,
    )
    if r.status_code != 200:
        return {}
    crudo = ((r.json().get("fields") or {}).get("raw") or {}).get("stringValue")
    try:
        cargado = json.loads(crudo) if crudo else {}
    except json.JSONDecodeError:
        return {}
    return cargado if isinstance(cargado, dict) else {}


def list_apps(token: str) -> list[dict]:
    """Proyectos app del dashboard que además tienen app en Codemagic.

    Sin `codemagicAppId` no hay consumo que copiar: el documento de facturación
    se guarda con ESE id, no con el del proyecto.
    """
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
            cm_app = _str(f, "codemagicAppId")
            # El id de Supabase se deduce del package, igual que en el puente de
            # descargas: un mapa fijo por projectId se rompería en cuanto alguien
            # recreara el proyecto en el dashboard.
            clave = next((k for k in APPS_SUPABASE if k in (pkg or bundle).lower()), None)
            if not clave:
                print(f"· {pkg or bundle}: no corresponde a ninguna app de Supabase, se omite")
                continue
            if not cm_app:
                print(f"· {pkg or bundle}: sin app de Codemagic vinculada, no hay costo que copiar")
                continue
            out.append({
                "projectId": doc["name"].rsplit("/", 1)[-1],
                "package": pkg or bundle,
                "codemagicAppId": cm_app,
                "idApp": APPS_SUPABASE[clave],
            })
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def num(v, default: float = 0.0) -> float:
    return float(v) if isinstance(v, (int, float)) else default


def fila_costo(app: dict, consumo: dict) -> dict:
    """El documento de Firestore, en la forma de `app_costos_codemagic`."""
    actual = consumo.get("actual") or {}
    reparto = consumo.get("reparto") or {}
    merma = consumo.get("merma") or {}
    return {
        "id_app": app["idApp"],
        "codemagic_app_id": app["codemagicAppId"],
        "ambito": consumo.get("ambito") or "sin ámbito",
        "periodo_usd": round(num(actual.get("usd")), 4),
        "periodo_minutos_pagados": round(num(actual.get("minutosPagados")), 2),
        "periodo_minutos_gratis": round(num(actual.get("minutosGratis")), 2),
        "periodo_minutos_totales": round(num(actual.get("minutosTotales")), 2),
        "reparto_usd": round(num(reparto.get("usd")), 4),
        "reparto_minutos_app": round(num(reparto.get("minutosApp")), 2),
        "reparto_minutos_cuenta": round(num(reparto.get("minutosCuenta")), 2),
        "reparto_parte": round(num(reparto.get("parte")), 6),
        "reparto_apps": int(num(reparto.get("apps"))),
        "merma_usd": round(num(merma.get("usd")), 4),
        "merma_minutos": round(num(merma.get("minutos")), 2),
        "merma_fallidos": round(num(merma.get("fallidos")), 2),
        "merma_otros": round(num(merma.get("otros")), 2),
        # El documento entero: permite explicar un número raro sin abrir
        # Codemagic, y que el sync calcule desgloses nuevos sin migrar la tabla.
        "raw": consumo,
    }


def filas_pase(app: dict, consumo: dict) -> list[dict]:
    """Una fila por plataforma con costo de pase conocido."""
    filas = []
    for plataforma, p in (consumo.get("porPase") or {}).items():
        if plataforma not in ("ios", "android") or not isinstance(p, dict):
            continue
        filas.append({
            "id_app": app["idApp"],
            "plataforma": plataforma,
            "usd": round(num(p.get("usd")), 4),
            "minutos": round(num(p.get("minutos")), 2),
            "pases": int(num(p.get("pases"))),
            "completo": bool(p.get("completo")),
            "pasos": p.get("pasos") or [],
        })
    return filas


def upsert(url: str, key: str, tabla: str, filas: list[dict], on_conflict: str) -> str | None:
    """UPSERT por lotes. Devuelve el error, si lo hubo."""
    if not filas:
        return None
    r = requests.post(
        f"{url.rstrip('/')}/rest/v1/{tabla}",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        params={"on_conflict": on_conflict},
        json=filas,
        timeout=60,
    )
    if r.status_code not in (200, 201, 204):
        return f"Supabase {r.status_code}: {r.text[:300]}"
    return None


def borrar_pases_viejos(url: str, key: str, id_app: int, vigentes: list[str]) -> str | None:
    """Quita las plataformas que ya no tienen costo de pase.

    Sin esto, una plataforma que deja de publicarse —o cuyo historial ya no
    alcanza para un pase completo— seguiría mostrando para siempre el último
    importe conocido, que se leería como vigente.
    """
    params = {"id_app": f"eq.{id_app}"}
    if vigentes:
        lista = ",".join(vigentes)
        params["plataforma"] = f"not.in.({lista})"
    r = requests.delete(
        f"{url.rstrip('/')}/rest/v1/app_costos_codemagic_pase",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Prefer": "return=minimal"},
        params=params,
        timeout=30,
    )
    if r.status_code not in (200, 204):
        return f"Supabase {r.status_code}: {r.text[:200]}"
    return None


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

    if not fs_token:
        print("::error::Falta FIRESTORE_TOKEN.")
        sys.exit(1)
    if not url or not key:
        # A propósito no es un error: el portal es un consumidor extra y el
        # resto del sync ya hizo su trabajo.
        print("· Sin SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: no se empuja el costo al portal.")
        return

    apps = list_apps(fs_token)
    if not apps:
        print("· Ninguna app con Codemagic vinculada; nada que empujar.")
        return

    for app in apps:
        consumo = raw_de(fs_token, "codemagicConsumo", app["codemagicAppId"])
        if not consumo.get("actual"):
            print(f"· {app['package']}: todavía sin facturación sincronizada.")
            continue

        error = upsert(url, key, "app_costos_codemagic", [fila_costo(app, consumo)], "id_app")
        if error:
            print(f"⚠ {app['package']}: {error}")
            continue

        pases = filas_pase(app, consumo)
        if pases:
            error = upsert(
                url, key, "app_costos_codemagic_pase", pases, "id_app,plataforma",
            )
            if error:
                print(f"⚠ {app['package']} (pases): {error}")
                continue
        error = borrar_pases_viejos(url, key, app["idApp"], [p["plataforma"] for p in pases])
        if error:
            print(f"⚠ {app['package']} (limpieza de pases): {error}")

        reparto = consumo.get("reparto") or {}
        detalle = " · ".join(f"{p['plataforma']} {p['usd']:.2f} USD" for p in pases) or "sin pases"
        print(
            f"✓ {app['package']}: {num(reparto.get('usd')):.2f} USD de su parte "
            f"({num(reparto.get('minutosApp')):.0f} min) · {detalle}"
        )


if __name__ == "__main__":
    main()
