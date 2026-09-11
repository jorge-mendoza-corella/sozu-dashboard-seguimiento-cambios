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

# Hasta dónde se mira hacia atrás buscando los builds del periodo. No es la
# ventana del reparto: es solo un tope para no pedir builds de hace un año.
DIAS_MAXIMOS = 120

# Los pasos por los que pasa UNA versión hasta estar en la tienda. Son los
# workflows del `codemagic.yaml` de las apps, en el orden en que ocurren.
# Sumar su duración media da lo que cuesta un pase completo a producción.
PASE_A_PRODUCCION = {
    "ios": [
        ("ios-release", "construir"),
        ("ios-publish", "TestFlight"),
        ("ios-appstore", "enviar a revisión"),
    ],
    "android": [
        ("android-release", "construir"),
        ("android-publish", "Play interno"),
        ("android-production", "Play Store"),
    ],
}


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


def builds_de_app(token: str, app_id: str, desde: datetime) -> list[dict]:
    """Builds de esa app con su duración, del más nuevo al más viejo.

    Se cuentan también los fallidos: ocuparon máquina y se pagan igual.
    """
    data = cm(token, "/builds", {"appId": app_id, "limit": 100})
    salida = []
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
        salida.append({
            "appId": app_id,
            "inicio": t0,
            "minutos": max(0.0, (t1 - t0).total_seconds() / 60),
            "maquina": b.get("instanceType") or "",
            "workflow": b.get("fileWorkflowId") or b.get("workflowId") or "",
            "status": b.get("status") or "",
        })
    return salida


def builds_del_periodo(builds: list[dict], minutos_facturados: float) -> list[dict]:
    """Los builds que componen el recibo, con los minutos que se les cobraron.

    Codemagic no dice qué builds forman el periodo ni cuándo empieza, pero sí
    cuántos minutos de máquina lleva cobrados. Se recorren del más nuevo al más
    viejo hasta juntar esa cantidad: eso reconstruye el periodo sin adivinar
    ninguna ventana.

    Devolver los BUILDS y no solo la suma es lo que mantiene coherentes las dos
    cifras de la tarjeta. Antes el costo de la app salía de aquí y el costo de
    un pase a producción de un promedio sobre 120 días de historial, así que un
    pase (41 min) podía salir más caro que todo lo cobrado a esa app (32 min),
    que es imposible si solo hubo un pase.
    """
    salida: list[dict] = []
    acumulado = 0.0
    for b in sorted(builds, key=lambda x: x["inicio"], reverse=True):
        if acumulado >= minutos_facturados:
            break
        # El build que cruza el corte entra solo por la parte que cabe: el
        # periodo empezó a mitad de ese build, no antes.
        cabe = min(b["minutos"], minutos_facturados - acumulado)
        salida.append({**b, "minutosCobrados": cabe})
        acumulado += cabe
    return salida


def analizar_pases(builds: list[dict]) -> tuple[dict, dict]:
    """(costo de un pase, merma) a partir de los builds cobrados del periodo.

    Una versión no llega a la tienda con un build: pasa por tres workflows por
    plataforma —construir, canal de pruebas y tienda—. Cuántos PASES hubo es el
    mínimo de veces que corrió cada uno de esos tres: con dos construcciones,
    dos TestFlight y un envío a revisión hubo UN pase completo, no dos.

    Ese conteo es lo que separa una publicación legítima de la merma. Antes
    cualquier repetición de un paso contaba como desperdicio, así que un
    segundo pase a producción —el caso normal de seguir trabajando— se habría
    reportado como minutos tirados. Ahora los N pases entran al promedio, que
    es justo lo que se quiere saber: cuánto cuesta publicar, de media.

    Lo que sobra sí es merma, y va partida en tres porque se corrige distinto:
      · fallidos  — reventaron; se arregla la causa
      · repetidos — reintentos de un paso, por encima de los pases completos
      · otros     — workflows ajenos al pase (web, sync de testers…)
    """
    recientes = sorted(builds, key=lambda x: x["inicio"], reverse=True)
    minutos_de = lambda b: b.get("minutosCobrados", b["minutos"])

    exitosos: dict[str, list[dict]] = {}
    for b in recientes:
        if b["status"] in ("finished", "success") and b["workflow"]:
            exitosos.setdefault(b["workflow"], []).append(b)

    por_pase: dict[str, dict] = {}
    usados: set[int] = set()

    for plataforma, pasos in PASE_A_PRODUCCION.items():
        cuentas = [len(exitosos.get(wf, [])) for wf, _ in pasos]
        # Pases COMPLETOS: tantos como veces corrió el paso que menos corrió.
        pases = min(cuentas) if cuentas else 0
        # Sin pase completo se promedia lo que haya, para no dejar la card
        # vacía; se marca `completo: False` y el total sale como parcial.
        muestras_por_paso = pases if pases > 0 else 1

        detalle = []
        for wf, etiqueta in pasos:
            corridas = exitosos.get(wf, [])[:muestras_por_paso]
            if not corridas:
                continue
            for b in corridas:
                usados.add(id(b))
            promedio = sum(minutos_de(b) for b in corridas) / len(corridas)
            tarifa = PRECIO_POR_MINUTO.get(corridas[0]["maquina"], PRECIO_POR_DEFECTO)
            detalle.append({
                "paso": etiqueta,
                "workflow": wf,
                "minutos": round(promedio, 2),
                "usd": round(promedio * tarifa, 4),
                "muestras": len(corridas),
            })
        if not detalle:
            continue
        por_pase[plataforma] = {
            "pasos": detalle,
            # Solo se anuncia como completo con los tres pasos: con uno ausente
            # el total saldría bajo y parecería que publicar cuesta menos.
            "completo": len(detalle) == len(pasos) and pases > 0,
            "pases": pases,
            "minutos": round(sum(d["minutos"] for d in detalle), 2),
            "usd": round(sum(d["usd"] for d in detalle), 4),
        }

    pasos_del_pase = {wf for pasos in PASE_A_PRODUCCION.values() for wf, _ in pasos}
    merma = {"minutos": 0.0, "fallidos": 0.0, "repetidos": 0.0, "otros": 0.0, "usd": 0.0}
    for b in recientes:
        if id(b) in usados:
            continue  # forma parte de un pase: no es merma
        minutos = minutos_de(b)
        cubo = (
            "fallidos" if b["status"] not in ("finished", "success")
            else "otros" if b["workflow"] not in pasos_del_pase
            else "repetidos"
        )
        merma[cubo] += minutos
        merma["minutos"] += minutos
        merma["usd"] += minutos * PRECIO_POR_MINUTO.get(b["maquina"], PRECIO_POR_DEFECTO)

    return por_pase, {k: round(v, 4) for k, v in merma.items()}


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

    desde = datetime.now(timezone.utc) - timedelta(days=DIAS_MAXIMOS)

    for amb in ambitos:
        uso = (amb["billing"] or {}).get("usage") or {}
        actual = periodo_de((uso.get("currentPeriod") or {}).get("buildTime"))
        anterior = periodo_de((uso.get("previousPeriod") or {}).get("buildTime"))

        # El reparto va sobre los minutos QUE SE COBRAN, no sobre todo el
        # tiempo de máquina: los del cupo gratis no cuestan y meterlos diluiría
        # el importe de cada app.
        facturados = actual["minutosPagados"]
        builds = [b for app_id in amb["apps"] for b in builds_de_app(cm_token, app_id, desde)]
        del_periodo = builds_del_periodo(builds, facturados)
        minutos: dict[str, float] = {}
        for b in del_periodo:
            minutos[b["appId"]] = minutos.get(b["appId"], 0.0) + b["minutosCobrados"]
        total_min = sum(minutos.values())
        print(
            f"· {amb['nombre']}: {actual['usd']:.2f} USD · "
            f"{facturados:.0f} min cobrados repartidos entre {len(amb['apps'])} app(s)"
        )

        # Para el costo del pase se usan los MISMOS builds del periodo cobrado
        # que alimentan el reparto: si vinieran de otro conjunto, las dos
        # cifras de la tarjeta se contradirían.
        por_app_builds: dict[str, list[dict]] = {}
        for b in del_periodo:
            por_app_builds.setdefault(b["appId"], []).append(b)

        for app_id in amb["apps"]:
            min_app = minutos.get(app_id, 0.0)
            pase_app, merma_app = analizar_pases(por_app_builds.get(app_id) or [])
            parte = (min_app / total_min) if total_min > 0 else 0
            write_doc(fs_token, app_id, {
                "ambito": amb["nombre"],
                "actual": actual,
                "anterior": anterior,
                "reparto": {
                    "minutosApp": round(min_app, 2),
                    "minutosCuenta": round(total_min, 2),
                    "parte": round(parte, 6),
                    "usd": round(actual["usd"] * parte, 4),
                    "apps": len(amb["apps"]),
                } if total_min > 0 else None,
                "porPase": pase_app,
                "merma": merma_app,
            })
            print(
                f"  ✓ {app_id}: {min_app:.0f} min cobrados · "
                f"{parte * 100:.0f}% · {actual['usd'] * parte:.2f} USD"
            )


if __name__ == "__main__":
    main()
