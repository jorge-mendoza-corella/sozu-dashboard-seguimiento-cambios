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
    since = (datetime.datetime.utcnow() - datetime.timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")
    path = (
        "/organizations/usage_report/messages"
        f"?starting_at={urllib.parse.quote(since)}"
        "&bucket_width=1d&limit=100"
        "&group_by[]=account_id&group_by[]=model"
    )
    buckets = fetch_all_pages(path, key)
    total_results = sum(len(b.get("results", [])) for b in buckets)
    print(f"  → {len(buckets)} day buckets, {total_results} usage records")
    return buckets


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

    updated_at = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

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

    print(f"\nDone. {len(buckets)} buckets, {len(org_users)} org users → Firestore at {updated_at}")


main()
