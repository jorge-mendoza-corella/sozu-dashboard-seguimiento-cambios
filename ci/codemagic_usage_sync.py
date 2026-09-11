#!/usr/bin/env python3
"""
Vuelca a Firestore lo que Codemagic factura, para verlo en el dashboard.

El navegador no puede pedirlo: `/user` —el único endpoint con el desglose de
facturación— no manda cabeceras CORS, así que desde el dashboard contesta
"Failed to fetch". `/apps` y `/builds` sí las mandan, que es por lo que el
resto del panel funciona y este dato no. Aquí no hay navegador, así que se lee
sin problema y se deja en `codemagicConsumo/{appId}`.

Qué se guarda por app:
  · lo FACTURADO de la cuenta que la paga (team o personal), del periodo en
    curso y del anterior. Es un importe real, no una estimación: Codemagic
    reparte el tiempo en `_free` / `_personal` / `_paid` y solo el último se
    cobra.
  · el REPARTO que le toca a esa app, por minutos de máquina. Eso sí es un
    cálculo nuestro: Codemagic factura por cuenta y no desglosa por aplicación.

Variables de entorno:
  FIRESTORE_TOKEN    access token de GCP para Firestore REST
  CODEMAGIC_TOKEN    token de la API de Codemagic
  GCP_PROJECT        id del proyecto Firebase (default: sozu-admin-dev)
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"
CM_API = "https://api.codemagic.io"

# USD por minuto de cada máquina (codemagic.io/pricing, revisado 2026-09-11).
PRECIO_POR_MINUTO = {
    "mac_mini_m2": 0.095,
    "mac_mini_m4": 0.114,
    "linux_x2": 0.045,
    "windows_x2": 0.045,
}
# Lo desconocido no se cobra de menos: se usa la tarifa más cara.
PRECIO_POR_DEFECTO = 0.114

# Ventana con la que se mide el peso de cada app. Codemagic no publica las
# fechas de su periodo de facturación, pero mientras el numerador y el
# denominador usen la MISMA ventana, la proporción entre apps se sostiene.
DIAS_REPARTO = 30


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def cm(token: str, path: str, params: dict | None = None) -> dict:
    r = requests.get(
        f"{CM_API}{path}", headers={"x-auth-token": token}, params=params or {}, timeout=60
    )
    if r.status_code != 200:
        fail(f"Codemagic {path}: {r.status_code} {r.text[:200]}")
    return r.json()


def periodo_de(build_time: dict | None) -> dict:
    """`{mac_mini_m2_paid: 3300, …}` en SEGUNDOS → minutos y dinero."""
    r = {"minutosPagados": 0.0, "minutosGratis": 0.0, "minutosTotales": 0.0, "usd": 0.0}
    for clave, segundos in (build_time or {}).items():
        if not segundos:
            continue
        minutos = segundos / 60
        r["minutosTotales"] += minutos
        # La clave es `<maquina>_<cubo>`: el cubo es el último tramo.
        maquina, _, cubo = clave.rpartition("_")
        if cubo == "paid":
            r["minutosPagados"] += minutos
            r["usd"] += minutos * PRECIO_POR_MINUTO.get(maquina, PRECIO_POR_DEFECTO)
        elif cubo == "free":
            r["minutosGratis"] += minutos
    return {k: round(v, 4) for k, v in r.items()}


def minutos_de_app(token: str, app_id: str, desde: datetime) -> float:
    """Minutos de máquina de esa app desde `desde`.

    Cuenta los builds fallidos: también ocuparon máquina y también se pagan.
    """
    data = cm(token, "/builds", {"appId": app_id, "limit": 100})
    total = 0.0
    for b in data.get("builds") or []:
        ini, fin = b.get("startedAt"), b.get("finishedAt")
        if not ini or not fin:
            continue
        try:
            t0 = datetime.fromisoformat(ini.replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(fin.replace("Z", "+00:00"))
        except ValueError:
            continue
        if t0 < desde:
            continue
        total += max(0.0, (t1 - t0).total_seconds() / 60)
    return total


def write_doc(token: str, app_id: str, payload: dict) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    body = {
        "fields": {
            "appId": {"stringValue": app_id},
            "updatedAt": {"timestampValue": now},
            "raw": {"stringValue": json.dumps(payload, ensure_ascii=False)},
        }
    }
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in body["fields"])
    r = requests.patch(
        f"{FS_BASE}/codemagicConsumo/{quote(app_id, safe='')}?{mask}",
        headers=fs_headers(token), json=body, timeout=30,
    )
    if r.status_code not in (200, 201):
        fail(f"Firestore write {app_id}: {r.status_code} {r.text[:200]}")


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    cm_token = os.environ.get("CODEMAGIC_TOKEN", "").strip()
    if not fs_token:
        fail("Falta FIRESTORE_TOKEN.")
    if not cm_token:
        # No es un error: el dashboard sigue funcionando sin el dato de costos.
        print("· Sin CODEMAGIC_TOKEN: no se sincroniza la facturación.")
        return

    usuario = cm(cm_token, "/user").get("user") or {}
    teams = usuario.get("teams") or []

    # Ámbitos que pueden facturar: cada team y la cuenta personal. De cada uno
    # se saca su factura y qué apps la comparten, que es lo que hace falta para
    # repartirla.
    ambitos = [
        {
            "nombre": f"equipo {t.get('name')}" if t.get("name") else "equipo",
            "apps": t.get("applicationIds") or [],
            "billing": t.get("billing") or {},
        }
        for t in teams
    ]
    en_teams = {a for amb in ambitos for a in amb["apps"]}
    personales = [
        a["_id"] for a in (cm(cm_token, "/apps").get("applications") or [])
        if a["_id"] not in en_teams
    ]
    if personales:
        ambitos.append(
            {"nombre": "cuenta personal", "apps": personales, "billing": usuario.get("billing") or {}}
        )

    desde = datetime.now(timezone.utc) - timedelta(days=DIAS_REPARTO)

    for amb in ambitos:
        uso = (amb["billing"] or {}).get("usage") or {}
        actual = periodo_de((uso.get("currentPeriod") or {}).get("buildTime"))
        anterior = periodo_de((uso.get("previousPeriod") or {}).get("buildTime"))

        minutos = {app_id: minutos_de_app(cm_token, app_id, desde) for app_id in amb["apps"]}
        total_min = sum(minutos.values())
        print(
            f"· {amb['nombre']}: {actual['usd']:.2f} USD facturados · "
            f"{len(amb['apps'])} app(s) · {total_min:.0f} min en {DIAS_REPARTO} días"
        )

        for app_id in amb["apps"]:
            parte = (minutos[app_id] / total_min) if total_min > 0 else 0
            write_doc(fs_token, app_id, {
                "ambito": amb["nombre"],
                "actual": actual,
                "anterior": anterior,
                "reparto": {
                    "minutosApp": round(minutos[app_id], 2),
                    "minutosCuenta": round(total_min, 2),
                    "parte": round(parte, 6),
                    "usd": round(actual["usd"] * parte, 4),
                    "apps": len(amb["apps"]),
                    "dias": DIAS_REPARTO,
                } if total_min > 0 else None,
            })
            print(
                f"  ✓ {app_id}: {minutos[app_id]:.0f} min · "
                f"{parte * 100:.0f}% · {actual['usd'] * parte:.2f} USD"
            )


if __name__ == "__main__":
    main()
