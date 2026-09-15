#!/usr/bin/env python3
"""
Lo que lleva consumido la cuenta de GitHub Actions, para verlo en el dashboard.

Por qué por el CI y no desde el navegador: leer el billing exige un token con
scope `user`, que es un permiso amplio sobre la cuenta personal de quien entra.
Pedirle eso al token de CADA usuario del dashboard —por un número de gasto— es
desproporcionado. Aquí lo lee un token dedicado y solo viaja el resultado.

Dónde está el gasto de verdad: los repos públicos no consumen cuota, Actions es
gratis en ellos. Lo que se factura son los privados, que en este workspace son
los de `jorgeIMendoza` (sozu-admin, las dos apps, edge functions…).

Firestore:
  escribe githubActionsUso/global

Variables de entorno:
  FIRESTORE_TOKEN     access token de GCP para Firestore REST
  GH_BILLING_TOKEN    PAT con scope `user` de la cuenta que paga
  GH_BILLING_USER     login de esa cuenta (default: jorgeIMendoza)
  GCP_PROJECT         id del proyecto Firebase (default: sozu-admin-dev)
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

import requests

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"
USUARIO = os.environ.get("GH_BILLING_USER", "jorgeIMendoza").strip()

# Lo que cuesta un minuto según la máquina, en USD. GitHub no publica el importe
# en la respuesta: solo minutos. Sin estas tarifas el número sería "305 minutos",
# que no dice si eso es mucho o poco — un minuto de macOS cuesta diez veces uno
# de Linux, y es justo donde se va el presupuesto sin que nadie lo note.
# https://docs.github.com/billing/managing-billing-for-github-actions
TARIFA_USD = {
    "UBUNTU": 0.008,
    "MACOS": 0.08,
    "WINDOWS": 0.016,
}


def fs_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def scopes_del_token(token: str) -> str:
    """Qué permisos trae el token, según GitHub.

    Va en el diagnóstico porque un 404 de billing tiene dos causas muy
    distintas —falta de permiso o endpoint retirado— y se arreglan en sitios
    opuestos. Preguntárselo a GitHub cuesta una llamada y ahorra adivinar.
    """
    r = requests.get(
        "https://api.github.com/user",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
        timeout=20,
    )
    if r.status_code != 200:
        return f"no se pudo consultar ({r.status_code})"
    # Un PAT clásico declara sus scopes en la cabecera; uno fine-grained no trae
    # ninguna, y ahí la ausencia también es información.
    scopes = r.headers.get("x-oauth-scopes")
    if scopes is None:
        return "token fine-grained (sin cabecera de scopes)"
    return scopes or "(ninguno)"


def leer_billing_nuevo(token: str) -> tuple[dict | None, str | None]:
    """Plataforma de facturación NUEVA: `/settings/billing/usage`.

    GitHub está migrando las cuentas a este endpoint, y el viejo desaparece con
    la migración. Devuelve líneas de consumo con importe ya calculado —no hay
    que estimar tarifas—, así que cuando existe es mejor dato que el legacy.
    """
    r = requests.get(
        f"https://api.github.com/users/{USUARIO}/settings/billing/usage",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=30,
    )
    if r.status_code != 200:
        return None, f"{r.status_code}"
    return r.json(), None


def analizar_nuevo(datos: dict) -> dict:
    """Resume las líneas de consumo de Actions de la plataforma nueva."""
    lineas = [
        u for u in (datos.get("usageItems") or [])
        if (u.get("product") or "").lower() == "actions"
    ]
    minutos = sum(float(u.get("quantity") or 0) for u in lineas)
    bruto = sum(float(u.get("grossAmount") or 0) for u in lineas)
    neto = sum(float(u.get("netAmount") or 0) for u in lineas)
    descuento = sum(float(u.get("discountAmount") or 0) for u in lineas)

    por_maquina: dict[str, int] = {}
    for u in lineas:
        # `sku` trae cosas como "Actions Linux" o "Actions macOS": basta con
        # mirar qué máquina nombra para armar el desglose.
        sku = (u.get("sku") or "").upper()
        clave = next((m for m in ("MACOS", "WINDOWS", "UBUNTU", "LINUX") if m in sku), "OTRO")
        if clave == "LINUX":
            clave = "UBUNTU"
        por_maquina[clave] = por_maquina.get(clave, 0) + int(float(u.get("quantity") or 0))

    # De qué mes es todo esto. `/settings/billing/usage` sin parámetros
    # devuelve el ciclo EN CURSO, pero no dice cuál es: el tablero enseñaba
    # 25,199 min sin decir de cuándo, y un número así se lee como acumulado
    # histórico. Cada línea trae su `date` (YYYY-MM-DD), así que el mes sale de
    # ahí; si alguna viniera sin fecha, se cae al mes UTC de hoy, que es el que
    # la API estaba devolviendo de todos modos.
    fechas = sorted(str(u.get("date") or "") for u in lineas if u.get("date"))
    periodo = fechas[-1][:7] if fechas else datetime.now(timezone.utc).strftime("%Y-%m")

    return {
        "usuario": USUARIO,
        # La plataforma nueva no habla de cupo incluido: habla de lo descontado.
        # Se deja en 0 y el tablero, que ya lo contempla, no dibuja barra.
        "minutosIncluidos": 0,
        # "2026-09": el mes al que corresponde el consumo.
        "periodo": periodo,
        # Primer y último día con consumo registrado en el ciclo. Sirve para
        # decir "del 1 al 15" cuando el mes va a medias.
        "periodoDesde": fechas[0] if fechas else None,
        "periodoHasta": fechas[-1] if fechas else None,
        "minutosUsados": int(minutos),
        "minutosPagados": int(minutos) if neto > 0 else 0,
        "pctCupo": None,
        "minutosPorMaquina": por_maquina,
        # Aquí el importe NO se estima: lo da GitHub.
        "costoAproximado": round(neto, 2),
        "costoBruto": round(bruto, 2),
        "descuento": round(descuento, 2),
        "ciclo": None,
        "plataforma": "nueva",
    }


def leer_billing(token: str) -> tuple[dict | None, str | None]:
    r = requests.get(
        f"https://api.github.com/users/{USUARIO}/settings/billing/actions",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=30,
    )
    if r.status_code == 404:
        return None, (
            f"GitHub no devuelve el billing de '{USUARIO}' (404). O al token le falta el scope "
            "`user`, o la cuenta ya migró a la plataforma de facturación nueva, donde este "
            "endpoint dejó de existir."
        )
    if r.status_code == 403:
        return None, "GitHub rechazó la lectura del billing (403): el token no tiene permiso."
    if r.status_code != 200:
        return None, f"GitHub billing {r.status_code}: {r.text[:200]}"
    return r.json(), None


def analizar(datos: dict) -> dict:
    """Minutos, cuánto queda del cupo y a cuánto equivale lo gastado."""
    incluidos = int(datos.get("included_minutes") or 0)
    usados = int(datos.get("total_minutes_used") or 0)
    pagados = int(datos.get("total_paid_minutes_used") or 0)
    desglose = {k.upper(): int(v or 0) for k, v in (datos.get("minutes_used_breakdown") or {}).items()}

    # El costo se calcula sobre los minutos PAGADOS, no sobre el total: los que
    # caen dentro del cupo incluido no se cobran, y sumarlos daría un importe
    # que no aparece en ninguna factura.
    #
    # El reparto por máquina se hace en proporción a lo que cada una consumió,
    # porque GitHub no dice cuáles de los minutos pagados fueron de macOS. Es
    # una aproximación, y por eso la respuesta lleva `costoAproximado`.
    total_desglose = sum(desglose.values()) or 1
    costo = sum(
        TARIFA_USD.get(maquina, TARIFA_USD["UBUNTU"]) * pagados * (minutos / total_desglose)
        for maquina, minutos in desglose.items()
    )

    return {
        "usuario": USUARIO,
        "minutosIncluidos": incluidos,
        "minutosUsados": usados,
        "minutosPagados": pagados,
        # Porcentaje del cupo. Sin cupo (cuentas con facturación distinta) queda
        # en null en vez de en 0, que se leería como "no has gastado nada".
        "pctCupo": round(usados / incluidos * 100, 1) if incluidos else None,
        "minutosPorMaquina": desglose,
        "costoAproximado": round(costo, 2),
        "ciclo": datos.get("days_left_in_billing_cycle"),
        # La plataforma vieja tampoco nombra el ciclo; solo dice cuántos días le
        # quedan. El mes de hoy es la mejor aproximación y evita que el tablero
        # tenga dos formas de no decir de cuándo es el número.
        "periodo": datetime.now(timezone.utc).strftime("%Y-%m"),
        "periodoDesde": None,
        "periodoHasta": None,
    }


def write_doc(token: str, payload: dict | None, error: str | None) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    body = {
        "fields": {
            "updatedAt": {"timestampValue": now},
            "raw": {"stringValue": json.dumps(payload or {}, ensure_ascii=False)},
            "error": {"stringValue": error} if error else {"nullValue": None},
        }
    }
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in body["fields"])
    r = requests.patch(
        f"{FS_BASE}/githubActionsUso/global?{mask}",
        headers=fs_headers(token), json=body, timeout=30,
    )
    if r.status_code not in (200, 201):
        print(f"::error::Firestore write: {r.status_code} {r.text[:200]}")
        sys.exit(1)


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    if not fs_token:
        print("::error::Falta FIRESTORE_TOKEN.")
        sys.exit(1)

    gh_token = os.environ.get("GH_BILLING_TOKEN", "").strip()
    if not gh_token:
        # Es un extra del tablero: sin la credencial se avisa y se sigue, igual
        # que el resto de puentes. No debe tumbar nada.
        print("· Sin GH_BILLING_TOKEN: no se puede leer el consumo de Actions.")
        return

    # Primero la plataforma nueva: si la cuenta ya migró, el endpoint legacy
    # contesta 404 y su mensaje de error no distingue eso de un token sin
    # permisos. Probando en este orden, el caso bueno ni siquiera llega al 404.
    datos_nuevo, err_nuevo = leer_billing_nuevo(gh_token)
    if datos_nuevo is not None:
        resumen = analizar_nuevo(datos_nuevo)
        write_doc(fs_token, resumen, None)
        maquinas = " · ".join(f"{k.lower()} {v}" for k, v in resumen["minutosPorMaquina"].items() if v)
        print(
            f"✓ {resumen['usuario']} (facturación nueva): {resumen['minutosUsados']} min"
            + (f" · {resumen['costoAproximado']} USD netos" if resumen["costoAproximado"] else " · sin cargo")
            + (f" · {maquinas}" if maquinas else "")
        )
        return

    datos, error = leer_billing(gh_token)
    if error:
        # Los dos fallaron: se dice qué contestó cada uno y qué permisos trae
        # el token, que es lo que hace falta para saber dónde está el problema.
        detalle = (
            f"{error} · /settings/billing/usage contestó {err_nuevo}"
            f" · scopes del token: {scopes_del_token(gh_token)}"
        )
        print(f"⚠ {detalle}")
        write_doc(fs_token, None, detalle)
        return

    resumen = analizar(datos or {})
    write_doc(fs_token, resumen, None)
    maquinas = " · ".join(f"{k.lower()} {v}" for k, v in resumen["minutosPorMaquina"].items() if v)
    print(
        f"✓ {resumen['usuario']}: {resumen['minutosUsados']} min usados"
        + (f" de {resumen['minutosIncluidos']} incluidos ({resumen['pctCupo']}%)" if resumen["minutosIncluidos"] else "")
        + (f" · {resumen['minutosPagados']} pagados ≈ {resumen['costoAproximado']} USD" if resumen["minutosPagados"] else "")
        + (f" · {maquinas}" if maquinas else "")
    )


if __name__ == "__main__":
    main()
