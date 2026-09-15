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

    datos, error = leer_billing(gh_token)
    if error:
        print(f"⚠ {error}")
        write_doc(fs_token, None, error)
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
