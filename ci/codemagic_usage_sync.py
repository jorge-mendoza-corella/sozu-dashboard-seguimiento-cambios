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

Se escribe en dos sitios, porque son dos tableros sobre bases distintas:
  · Firestore `codemagicConsumo/{appId}` — el dashboard de CI/CD.
  · Supabase `app_costos_codemagic` y `app_costos_codemagic_pase` — el Portal
    Alta Dirección, que vive sobre Postgres y no ve Firestore.

Variables de entorno:
  FIRESTORE_TOKEN            access token de GCP para Firestore REST
  CODEMAGIC_TOKEN            token de la API de Codemagic
  SUPABASE_URL               base del portal; sin ella ese lado se salta
  SUPABASE_SERVICE_ROLE_KEY  llave de servicio (salta RLS)
  GCP_PROJECT                id del proyecto Firebase (default: sozu-admin-dev)
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


def analizar_cobrado(builds: list[dict]) -> tuple[dict, dict]:
    """(costo de un pase, merma) a partir de los minutos COBRADOS de la app.

    Regla de la que sale todo: lo que se factura es merma o es pase. Nada más.

        minutos cobrados = merma + (pases x lo que cuesta un pase)

    Así las dos cifras de la tarjeta no pueden contradecirse, que es justo lo
    que pasaba antes: el pase se promediaba sobre el historial de 120 días y el
    total sobre el periodo facturado, así que un pase (39 min) salía más caro
    que todo lo cobrado a la app (23 min) — imposible, porque ese pase está
    dentro de ese cobro.

    Merma es lo que se pagó sin llevar una versión a la tienda, y son dos casos
    inequívocos: builds que reventaron y workflows ajenos al pase (web, sync de
    testers). Se cuenta aparte; no se reparte entre los pases.

    Cuántos pases hubo es el mínimo de veces que corrió cada uno de los tres
    pasos de esa plataforma: con dos construcciones, dos TestFlight y un envío
    a revisión hubo UN pase, no dos. Con varios, el importe es su promedio.
    """
    minutos_de = lambda b: b.get("minutosCobrados", b["minutos"])
    pasos_del_pase = {wf for pasos in PASE_A_PRODUCCION.values() for wf, _ in pasos}

    merma = {"minutos": 0.0, "fallidos": 0.0, "otros": 0.0, "usd": 0.0}
    exitosos: dict[str, list[dict]] = {}
    for b in sorted(builds, key=lambda x: x["inicio"], reverse=True):
        exitoso = b["status"] in ("finished", "success")
        if exitoso and b["workflow"] in pasos_del_pase:
            exitosos.setdefault(b["workflow"], []).append(b)
            continue
        minutos = minutos_de(b)
        merma["fallidos" if not exitoso else "otros"] += minutos
        merma["minutos"] += minutos
        merma["usd"] += minutos * PRECIO_POR_MINUTO.get(b["maquina"], PRECIO_POR_DEFECTO)

    por_pase: dict[str, dict] = {}
    for plataforma, pasos in PASE_A_PRODUCCION.items():
        cuentas = [len(exitosos.get(wf, [])) for wf, _ in pasos]
        # Un pase necesita los tres pasos; si alguno no corrió dentro de lo
        # cobrado, lo que hay se reporta como un pase en vez de dividir por 0.
        pases = max(1, min(cuentas) if cuentas else 0)

        detalle = []
        for wf, etiqueta in pasos:
            corridas = exitosos.get(wf, [])
            if not corridas:
                continue
            # TODO lo cobrado de ese paso, repartido entre los pases: así la
            # suma de los pasos es exactamente lo que se pagó por ellos.
            minutos = sum(minutos_de(b) for b in corridas) / pases
            tarifa = PRECIO_POR_MINUTO.get(corridas[0]["maquina"], PRECIO_POR_DEFECTO)
            detalle.append({
                "paso": etiqueta,
                "workflow": wf,
                "minutos": round(minutos, 2),
                "usd": round(minutos * tarifa, 4),
                "muestras": len(corridas),
            })
        if not detalle:
            continue
        por_pase[plataforma] = {
            "pasos": detalle,
            "completo": len(detalle) == len(pasos),
            "pases": pases,
            "minutos": round(sum(d["minutos"] for d in detalle), 2),
            "usd": round(sum(d["usd"] for d in detalle), 4),
        }

    return por_pase, {k: round(v, 4) for k, v in merma.items()}


# Ids de `public.apps` en Supabase. Son catálogo: 1 = clientes, 2 = agentes.
APPS_SUPABASE = {"clientes": 1, "agentes": 2}


def id_app_supabase(fs_token: str, codemagic_app_id: str) -> int | None:
    """Id de `public.apps` que corresponde a esa app de Codemagic.

    Se resuelve por el package, no por un mapa fijo de ids de Codemagic: al
    mover una app a un equipo, Codemagic le asigna un id NUEVO, y un mapa
    escrito a mano se quedaría apuntando al viejo sin que nada avisara —ya
    pasó una vez con la app de clientes—.
    """
    r = requests.get(
        f"{FS_BASE}/projects",
        headers=fs_headers(fs_token), params={"pageSize": 200}, timeout=30,
    )
    if r.status_code != 200:
        return None
    for doc in r.json().get("documents", []):
        f = doc.get("fields", {})
        if (f.get("codemagicAppId") or {}).get("stringValue") != codemagic_app_id:
            continue
        ident = ((f.get("androidPackage") or {}).get("stringValue")
                 or (f.get("iosBundleId") or {}).get("stringValue") or "").lower()
        return next((v for k, v in APPS_SUPABASE.items() if k in ident), None)
    return None


def sb_upsert(url: str, key: str, tabla: str, conflicto: str, filas: list[dict]) -> str | None:
    """UPSERT en Supabase. Devuelve el error, si lo hubo."""
    if not filas:
        return None
    r = requests.post(
        f"{url.rstrip('/')}/rest/v1/{tabla}",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # El sync reescribe el estado del periodo en cada corrida: sin esto
            # chocaría con la llave en vez de actualizar.
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        params={"on_conflict": conflicto},
        json=filas,
        timeout=60,
    )
    if r.status_code not in (200, 201, 204):
        return f"Supabase {tabla}: {r.status_code} {r.text[:200]}"
    return None


def write_supabase(url: str, key: str, id_app: int, codemagic_app_id: str, payload: dict) -> None:
    """Deja el costo de esa app donde el Portal Alta Dirección puede leerlo."""
    actual = payload.get("actual") or {}
    reparto = payload.get("reparto") or {}
    merma = payload.get("merma") or {}

    error = sb_upsert(url, key, "app_costos_codemagic", "id_app", [{
        "id_app": id_app,
        "codemagic_app_id": codemagic_app_id,
        "ambito": payload.get("ambito") or "",
        "periodo_usd": actual.get("usd", 0),
        "periodo_minutos_pagados": actual.get("minutosPagados", 0),
        "periodo_minutos_gratis": actual.get("minutosGratis", 0),
        "periodo_minutos_totales": actual.get("minutosTotales", 0),
        "reparto_usd": reparto.get("usd", 0),
        "reparto_minutos_app": reparto.get("minutosApp", 0),
        "reparto_minutos_cuenta": reparto.get("minutosCuenta", 0),
        "reparto_parte": reparto.get("parte", 0),
        "reparto_apps": reparto.get("apps", 0),
        "merma_usd": merma.get("usd", 0),
        "merma_minutos": merma.get("minutos", 0),
        "merma_fallidos": merma.get("fallidos", 0),
        "merma_otros": merma.get("otros", 0),
        "raw": payload,
        "fecha_actualizacion": datetime.now(timezone.utc).isoformat(),
    }])
    if error:
        print(f"  ⚠ {error}")
        return

    filas = [{
        "id_app": id_app,
        "plataforma": plataforma,
        "usd": p.get("usd", 0),
        "minutos": p.get("minutos", 0),
        "pases": p.get("pases", 0),
        "completo": p.get("completo", False),
        "pasos": p.get("pasos") or [],
        "fecha_actualizacion": datetime.now(timezone.utc).isoformat(),
    } for plataforma, p in (payload.get("porPase") or {}).items()]
    error = sb_upsert(url, key, "app_costos_codemagic_pase", "id_app,plataforma", filas)
    if error:
        print(f"  ⚠ {error}")


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

    sb_url = os.environ.get("SUPABASE_URL", "").strip()
    sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not (sb_url and sb_key):
        # El portal es un consumidor extra: sin llave se avisa y se sigue, en
        # vez de dejar sin datos también al dashboard de CI/CD.
        print("· Sin SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: no se empuja al portal.")

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
            # Las dos salen del MISMO conjunto: los minutos cobrados de esta
            # app. Es lo que garantiza que el pase nunca supere el total.
            pase_app, merma_app = analizar_cobrado(por_app_builds.get(app_id) or [])
            parte = (min_app / total_min) if total_min > 0 else 0
            payload = {
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
            }
            write_doc(fs_token, app_id, payload)

            if sb_url and sb_key:
                id_app = id_app_supabase(fs_token, app_id)
                if id_app:
                    write_supabase(sb_url, sb_key, id_app, app_id, payload)
                else:
                    print(f"  · {app_id}: sin app equivalente en Supabase, no se empuja al portal")
            print(
                f"  ✓ {app_id}: {min_app:.0f} min cobrados · "
                f"{parte * 100:.0f}% · {actual['usd'] * parte:.2f} USD"
            )


if __name__ == "__main__":
    main()
