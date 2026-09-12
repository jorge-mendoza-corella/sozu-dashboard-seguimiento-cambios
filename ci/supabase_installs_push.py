#!/usr/bin/env python3
"""
Empuja a Supabase las instalaciones diarias que los otros syncs dejaron en
Firestore, para que el Portal Alta Dirección las grafique.

Por qué un puente y no que el portal lea la fuente directa: el portal es un
navegador contra Supabase, y ni GA4 ni las tiendas se pueden consultar desde
ahí —Play exige firmar un JWT con llave privada, Apple entrega reportes
comprimidos, GA4 pide un scope propio—. Todo eso ya lo resuelve este workflow;
lo único que faltaba era dejar el resultado donde el portal sí puede leerlo.

Fuentes, por orden de preferencia para cada día:
  1. `ga4Installs/{projectId}` — Analytics, las dos plataformas al día.
  2. `appStoreInstalls/{bundleId}.serie` — Apple, sólo iOS, mientras GA4 no
     reporte (las apps acaban de estrenar el SDK y no hay histórico).

Play no aporta serie: publica un informe por mes cerrado, sin día a día.

Escribe en `public.app_instalaciones_diarias` con UPSERT sobre
(id_app, fecha, plataforma): reescribir un día ya escrito es lo normal, porque
las tiendas corrigen sus cifras unos días. Nunca toca las filas `estimado`
sembradas al arranque… salvo que llegue un dato real para ese mismo día, que es
justo cuando deben ceder.

Variables de entorno:
  FIRESTORE_TOKEN             access token de GCP para Firestore REST
  SUPABASE_URL                base a la que escribir. El workflow la saca de
                              `DASHBOARD_SUPABASE_URL`, un secreto propio: los
                              `SUPABASE_*` que ya existían son la config del
                              front y apuntan a la base de DEV, así que
                              reusarlos habría escrito en el lado equivocado
                              sin que nada fallara.
  SUPABASE_SERVICE_ROLE_KEY   llave de servicio de ESA base (salta RLS). Sin
                              ella el script no hace nada y lo dice: es un
                              extra, no debe tumbar el resto del sync.
  GCP_PROJECT                 id del proyecto Firebase (default: sozu-admin-dev)
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
    """Proyectos app del dashboard, con lo necesario para ubicarlos en Supabase."""
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
            # El id de Supabase se deduce del package: 'clientes' o 'agentes'
            # aparecen en él. Un mapa fijo por projectId se rompería en cuanto
            # alguien recreara el proyecto en el dashboard.
            clave = next((k for k in APPS_SUPABASE if k in (pkg or bundle).lower()), None)
            if not clave:
                print(f"· {pkg or bundle}: no corresponde a ninguna app de Supabase, se omite")
                continue
            out.append({
                "projectId": doc["name"].rsplit("/", 1)[-1],
                "package": pkg,
                "bundleId": bundle,
                "idApp": APPS_SUPABASE[clave],
            })
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def filas_de(token: str, app: dict) -> list[dict]:
    """Las filas diarias de esa app, ya en la forma de la tabla de Supabase.

    Manda la tienda y GA4 rellena, día por día y plataforma por plataforma.

    Las dos fuentes no cuentan lo mismo: la tienda cuenta descargas y GA4 cuenta
    `first_open`, la primera vez que alguien ABRE la app. Quien la baja y no la
    abre existe para Apple y no para Analytics, así que donde hay dato de tienda
    ese es el que vale —es el que cuadra con lo que enseña la consola, que es
    contra lo que cualquiera va a comparar—. GA4 aporta lo que la tienda todavía
    no publicó y, en Android, todo: Play solo da informe al cerrar el mes.
    """
    por_clave: dict[tuple[str, str], dict] = {}

    ga4 = raw_de(token, "ga4Installs", app["projectId"])
    for dia in ga4.get("dias") or []:
        for plat in ("android", "ios"):
            if dia.get(plat):
                por_clave[(dia["fecha"], plat)] = {
                    "id_app": app["idApp"],
                    "fecha": dia["fecha"],
                    "plataforma": plat,
                    "instalaciones": dia[plat],
                    "estimado": False,
                    "fuente": "ga4",
                }

    if app["bundleId"]:
        ios = raw_de(token, "appStoreInstalls", app["bundleId"])
        for punto in ios.get("serie") or []:
            if punto.get("descargas"):
                por_clave[(punto["fecha"], "ios")] = {
                    "id_app": app["idApp"],
                    "fecha": punto["fecha"],
                    "plataforma": "ios",
                    "instalaciones": punto["descargas"],
                    "estimado": False,
                    "fuente": "app_store",
                }

    return [por_clave[k] for k in sorted(por_clave)]


def upsert(url: str, key: str, filas: list[dict]) -> str | None:
    """UPSERT por lotes. Devuelve el error, si lo hubo."""
    if not filas:
        return None
    r = requests.post(
        f"{url.rstrip('/')}/rest/v1/app_instalaciones_diarias",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # Sin esto PostgREST inserta y choca con la única; con esto pisa el
            # día, que es lo que se quiere cuando la tienda corrige su cifra.
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        params={"on_conflict": "id_app,fecha,plataforma"},
        json=filas,
        timeout=60,
    )
    if r.status_code not in (200, 201, 204):
        return f"Supabase {r.status_code}: {r.text[:300]}"
    return None


def borrar_sobrantes(url: str, key: str, id_app: int, filas: list[dict]) -> str | None:
    """Retira los días medidos que la fuente ya no reporta.

    El UPSERT pisa lo que coincide y no sabe nada de lo que sobra. Un día que se
    escribió mal —y pasó: la app de clientes tuvo un 11 de septiembre con 54
    descargas, que eran los días 9 y 10 sumados bajo la fecha en que Apple
    generó el reporte— se quedaba en la tabla para siempre, sumando, aunque el
    sync dejara de emitirlo.

    La serie que manda cada fuente es su histórico completo, así que lo que no
    venga en ella y sea posterior a su primer día no existe. El corte por abajo
    es lo único que se respeta: antes de que la fuente empezara a medir mandan
    la siembra y las consolas, y eso no le toca borrarlo.

    Solo actúa sobre lo suyo: la siembra estimada y las otras fuentes no se
    tocan.
    """
    if not filas:
        return None
    grupos: dict[tuple[str, str], list[str]] = {}
    for f in filas:
        grupos.setdefault((f["plataforma"], f["fuente"]), []).append(f["fecha"])
    for (plataforma, fuente), fechas in grupos.items():
        vigentes = sorted(set(fechas))
        r = requests.delete(
            f"{url.rstrip('/')}/rest/v1/app_instalaciones_diarias",
            headers={"apikey": key, "Authorization": f"Bearer {key}", "Prefer": "return=minimal"},
            params={
                "id_app": f"eq.{id_app}",
                "plataforma": f"eq.{plataforma}",
                "fuente": f"eq.{fuente}",
                "estimado": "is.false",
                "and": f"(fecha.gte.{vigentes[0]},fecha.not.in.({','.join(vigentes)}))",
            },
            timeout=60,
        )
        if r.status_code not in (200, 204):
            return f"Supabase {r.status_code} al limpiar días retirados: {r.text[:300]}"
    return None


def serie_de_supabase(url: str, key: str, id_app: int) -> tuple[list[dict], str | None]:
    """La serie ya mezclada que guarda Supabase: lo real y lo estimado.

    Se lee de vuelta en vez de reusar lo que se acaba de subir porque el
    documento tiene que incluir la SIEMBRA —los totales que reportaban las
    consolas antes de que las apps midieran—, que vive solo en Supabase: la
    escribió la migración, no este sync.
    """
    r = requests.get(
        f"{url.rstrip('/')}/rest/v1/app_instalaciones_diarias",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        params={
            "id_app": f"eq.{id_app}",
            "select": "fecha,plataforma,instalaciones,estimado",
            "order": "fecha.asc",
            "limit": "5000",
        },
        timeout=60,
    )
    if r.status_code != 200:
        return [], f"No se pudo releer la serie: {r.status_code} {r.text[:200]}"

    dias: dict[str, dict] = {}
    for f in r.json():
        d = dias.setdefault(f["fecha"], {"fecha": f["fecha"], "android": 0, "ios": 0, "estimado": 0})
        plat = "ios" if f["plataforma"] == "ios" else "android"
        d[plat] += f["instalaciones"]
        if f.get("estimado"):
            d["estimado"] += f["instalaciones"]
    return [dias[k] for k in sorted(dias)], None


def guardar_serie_firestore(token: str, project_id: str, dias: list[dict]) -> None:
    """Deja la serie en `installsDiarias/{projectId}` para el dashboard de CI/CD.

    Supabase es la fuente —ahí se mezcla lo medido con la siembra— y esto es
    una copia de lectura: el dashboard vive sobre Firestore y no tiene cliente
    de Supabase. Sin la copia, los dos tableros enseñarían números distintos de
    lo mismo, que es peor que no enseñarlos.
    """
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    total = sum(d["android"] + d["ios"] for d in dias)
    body = {
        "fields": {
            "projectId": {"stringValue": project_id},
            "updatedAt": {"timestampValue": now},
            "raw": {"stringValue": json.dumps({"dias": dias, "total": total}, ensure_ascii=False)},
        }
    }
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in body["fields"])
    r = requests.patch(
        f"{FS_BASE}/installsDiarias/{quote(project_id, safe='')}?{mask}",
        headers=fs_headers(token), json=body, timeout=30,
    )
    if r.status_code not in (200, 201):
        print(f"⚠ {project_id}: no se pudo guardar la serie en Firestore: {r.status_code}")


def main() -> None:
    fs_token = os.environ.get("FIRESTORE_TOKEN", "").strip()
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

    if not fs_token:
        print("::error::Falta FIRESTORE_TOKEN.")
        sys.exit(1)
    if not url or not key:
        # A propósito no es un error: el portal es un consumidor extra y el
        # resto del sync ya hizo su trabajo. Fallar aquí dejaría en rojo un
        # workflow que sí actualizó las tarjetas del dashboard.
        print("· Sin SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: no se empuja al portal.")
        return

    # La lista se guarda: la recorren DOS bucles —subir y luego copiar la serie
    # de vuelta al dashboard— y consultarla otra vez sería pedirle a Firestore
    # lo mismo dos veces en la misma corrida.
    apps = list_apps(fs_token)

    total = 0
    for app in apps:
        filas = filas_de(fs_token, app)
        if not filas:
            print(f"· {app['package'] or app['bundleId']}: todavía sin serie diaria que empujar.")
            continue
        error = upsert(url, key, filas)
        if error:
            print(f"⚠ {app['package'] or app['bundleId']}: {error}")
            continue
        # Después del UPSERT, no antes: si la limpieza corriera primero y la
        # subida fallara, la tabla se quedaría sin los días buenos.
        error = borrar_sobrantes(url, key, app["idApp"], filas)
        if error:
            print(f"⚠ {app['package'] or app['bundleId']}: {error}")
        total += len(filas)
        fechas = sorted({f["fecha"] for f in filas})
        print(
            f"✓ {app['package'] or app['bundleId']}: {len(filas)} filas "
            f"({fechas[0]} → {fechas[-1]}) al portal"
        )

    # La copia para el dashboard se hace SIEMPRE, aunque no hubiera nada nuevo
    # que subir: la siembra ya está en Supabase y el dashboard la necesita
    # igual. Fuera del bucle de arriba por eso mismo.
    for app in apps:
        dias, error = serie_de_supabase(url, key, app["idApp"])
        if error:
            print(f"⚠ {app['projectId']}: {error}")
            continue
        if dias:
            guardar_serie_firestore(fs_token, app["projectId"], dias)
            print(f"· {app['projectId']}: serie de {len(dias)} días copiada al dashboard")

    print(f"· Total empujado: {total} filas.")


if __name__ == "__main__":
    main()
