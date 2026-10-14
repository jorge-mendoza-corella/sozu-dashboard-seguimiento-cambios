#!/usr/bin/env python3
"""
Sync Anthropic usage data (90 days) → Firestore anthropic_costs_cache/latest
Run via GitHub Actions with gcloud already authenticated.
"""

import json
import subprocess
import urllib.request
import urllib.parse
import datetime
import sys

PROJECT = "sozu-admin-dev"
FIRESTORE_URL = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"


def run(cmd):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ERROR running {cmd}: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


def gcloud_secret(name):
    return run(["gcloud", "secrets", "versions", "access", "latest",
                f"--secret={name}", f"--project={PROJECT}"])


def gcloud_token():
    return run(["gcloud", "auth", "print-access-token"])


def anthropic_get(path, key):
    url = f"https://api.anthropic.com/v1{path}"
    req = urllib.request.Request(url, headers={
        "anthropic-version": "2023-06-01",
        "x-api-key": key,
    })
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"Anthropic API error {e.code}: {body}", file=sys.stderr)
        sys.exit(1)


def fetch_all_pages(path, key, data_key="data"):
    items = []
    page = None
    while True:
        sep = "&" if "?" in path else "?"
        url = path + (f"{sep}page={urllib.parse.quote(page)}" if page else "")
        data = anthropic_get(url, key)
        items.extend(data.get(data_key, []))
        if not data.get("has_more") or not data.get("next_page"):
            break
        page = data["next_page"]
    return items


def fetch_org_users(key):
    print("  Fetching org users...")
    users = fetch_all_pages("/organizations/users?limit=100", key)
    print(f"  → {len(users)} users")
    return users


def fetch_usage_buckets(key, days=90):
    print(f"  Fetching {days}-day usage buckets...")
    since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")
    # limit <= 31 is required by the API when bucket_width=1d; pagination handles the rest
    path = (
        "/organizations/usage_report/messages"
        f"?starting_at={urllib.parse.quote(since)}"
        "&bucket_width=1d&limit=31"
        "&group_by[]=account_id&group_by[]=model"
    )
    buckets = fetch_all_pages(path, key)
    total_results = sum(len(b.get("results", [])) for b in buckets)
    print(f"  → {len(buckets)} day buckets, {total_results} usage records")
    return buckets


def anthropic_get_soft(path, key):
    """Como anthropic_get, pero un error no tumba el sync del resto."""
    try:
        return anthropic_get_raw(path, key)
    except urllib.error.HTTPError as e:
        print(f"Anthropic API error {e.code} en {path.split('?')[0]}: {e.read().decode()[:300]}", file=sys.stderr)
        return None


def anthropic_get_raw(path, key):
    req = urllib.request.Request(f"https://api.anthropic.com/v1{path}", headers={
        "anthropic-version": "2023-06-01",
        "x-api-key": key,
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def pages_soft(path, key):
    items, page = [], None
    while True:
        sep = "&" if "?" in path else "?"
        data = anthropic_get_soft(path + (f"{sep}page={urllib.parse.quote(page)}" if page else ""), key)
        if data is None:
            return None
        items.extend(data.get("data", []))
        if not data.get("has_more") or not data.get("next_page"):
            return items
        page = data["next_page"]


def resumen_mes(key):
    """
    Gasto del mes en curso (UTC) para el badge de costos del dashboard:
      - cost_report: lo que factura Anthropic, en USD (sin estimar).
      - usage_report por api_key_id + modelo: para repartir el gasto por llave
        (docs, GeorgIA, …), que cost_report no desglosa. El dashboard le pone
        precio con su tabla y lo escala al total real.
    """
    hoy = datetime.datetime.now(datetime.timezone.utc)
    inicio = hoy.strftime("%Y-%m-01T00:00:00Z")
    q = f"?starting_at={urllib.parse.quote(inicio)}&bucket_width=1d&limit=31"
    costo = pages_soft(f"/organizations/cost_report{q}&group_by[]=description", key)
    uso = pages_soft(f"/organizations/usage_report/messages{q}&group_by[]=api_key_id&group_by[]=model", key)
    llaves = pages_soft("/organizations/api_keys?limit=100", key)

    total = 0.0
    por_concepto = {}
    # Gasto por día (UTC), para la gráfica del badge. Los días sin consumo
    # vienen como bucket vacío y quedan en 0.
    por_dia = {}
    for b in costo or []:
        dia = (b.get("starting_at") or "")[:10]
        if dia:
            por_dia.setdefault(dia, 0.0)
        for r in b.get("results", []):
            # amount viene en centavos de dólar, como texto decimal.
            usd = float(r.get("amount") or 0) / 100
            total += usd
            concepto = r.get("description") or r.get("cost_type") or "otro"
            por_concepto[concepto] = por_concepto.get(concepto, 0) + usd
            if dia:
                por_dia[dia] += usd

    nombres = {k.get("id"): k.get("name") or k.get("id") for k in (llaves or [])}
    por_llave = {}
    for b in uso or []:
        for r in b.get("results", []):
            k = r.get("api_key_id") or "__sin_llave__"
            m = r.get("model") or "?"
            d = por_llave.setdefault(k, {"nombre": nombres.get(k, "Consola / sin llave" if k == "__sin_llave__" else k), "modelos": {}})
            t = d["modelos"].setdefault(m, {"input": 0, "output": 0, "cacheRead": 0, "cacheCreate": 0})
            t["input"] += r.get("uncached_input_tokens", 0)
            t["output"] += r.get("output_tokens", 0)
            t["cacheRead"] += r.get("cache_read_input_tokens", 0)
            cc = r.get("cache_creation") or {}
            t["cacheCreate"] += cc.get("ephemeral_1h_input_tokens", 0) + cc.get("ephemeral_5m_input_tokens", 0)

    print(f"  Mes: ${total:.2f} USD; conceptos={len(por_concepto)}; llaves con uso={len(por_llave)}")
    for c, v in sorted(por_concepto.items(), key=lambda x: -x[1])[:8]:
        print(f"    {c}: ${v:.2f}")
    for d in por_llave.values():
        print(f"    llave '{d['nombre']}': modelos={list(d['modelos'])}")
    return {
        "anio": hoy.year,
        "mes": hoy.month,
        "totalUsd": round(total, 4) if costo is not None else None,
        "porConcepto": {k: round(v, 4) for k, v in por_concepto.items()},
        "porDia": {k: round(v, 4) for k, v in sorted(por_dia.items())},
        "porLlave": por_llave,
        "error": None if costo is not None else "No se pudo leer cost_report (¿la admin key tiene acceso?)",
    }


def firestore_patch(doc_path, fields, token):
    url = f"{FIRESTORE_URL}/{doc_path}"
    body = json.dumps({"fields": fields}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="PATCH",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
    )
    try:
        with urllib.request.urlopen(req) as r:
            r.read()
    except urllib.error.HTTPError as e:
        body_err = e.read().decode()
        print(f"Firestore error {e.code}: {body_err}", file=sys.stderr)
        sys.exit(1)


def main():
    print("=== Anthropic Costs Sync ===")

    print("\n1. Getting Anthropic admin key from Secret Manager...")
    try:
        key = gcloud_secret("DASHBOARD_ANTHROPIC_ADMIN_KEY")
    except SystemExit:
        print("Secret DASHBOARD_ANTHROPIC_ADMIN_KEY not found. Skipping sync.", file=sys.stderr)
        sys.exit(0)  # Exit 0 so CI doesn't fail

    print("\n2. Fetching data from Anthropic API...")
    org_users = fetch_org_users(key)
    buckets = fetch_usage_buckets(key, days=90)

    updated_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    buckets_json = json.dumps(buckets)
    org_users_json = json.dumps(org_users)
    print(f"\n3. Data size: buckets={len(buckets_json)//1024}KB, users={len(org_users_json)//1024}KB")

    if len(buckets_json) > 900_000:
        print("WARNING: buckets JSON > 900KB, may approach Firestore 1MB limit", file=sys.stderr)

    print("\n4. Getting GCP access token...")
    token = gcloud_token()

    print("5. Writing to Firestore (anthropic_costs_cache/latest)...")
    firestore_patch(
        "anthropic_costs_cache/latest",
        {
            "bucketsJson":   {"stringValue": buckets_json},
            "orgUsersJson":  {"stringValue": org_users_json},
            "updatedAt":     {"stringValue": updated_at},
        },
        token
    )

    print("6. Gasto del mes → anthropic_costs_cache/mes...")
    mes = resumen_mes(key)
    firestore_patch(
        "anthropic_costs_cache/mes",
        {"json": {"stringValue": json.dumps(mes)}, "updatedAt": {"stringValue": updated_at}},
        token,
    )

    print(f"\nDone. {len(buckets)} buckets, {len(org_users)} org users → Firestore at {updated_at}")


main()
