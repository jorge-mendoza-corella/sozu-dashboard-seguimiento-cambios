#!/usr/bin/env python3
"""
Calendario de la Selección Mexicana (varonil mayor) para GeorgIA: el día del
partido el personaje anda de verde (ver src/components/agente/escenasDatos.ts).

Corre en GitHub Actions el día 1 de cada mes (ver
.github/workflows/seleccion-partidos-sync.yml):
  1. Lee los próximos partidos de México de la API pública de ESPN (todos los
     torneos: amistosos, Liga de Naciones, Copa Oro, eliminatorias, Mundial).
  2. Escribe la lista en Firestore `agente_partidos/seleccion` (campo `raw`,
     JSON) para que el panel la lea.

Variables de entorno:
  FIRESTORE_TOKEN   access token de GCP (cuenta de Firebase) para Firestore REST
  GCP_PROJECT       id del proyecto Firebase (default: sozu-admin-dev)
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

import requests

GCP_PROJECT = os.environ.get("GCP_PROJECT", "sozu-admin-dev")
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{GCP_PROJECT}/databases/(default)/documents"
# 203 = México en ESPN; `all` + `fixture=true` trae los próximos de todos los torneos.
ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/203/schedule?fixture=true"

# Código FIFA de 3 letras (el `abbreviation` de ESPN) → ISO 3166 de 2 letras (para la bandera).
ISO2 = {
    "JAM": "JM", "USA": "US", "CAN": "CA", "CRC": "CR", "PAN": "PA", "HON": "HN", "SLV": "SV", "GUA": "GT",
    "HAI": "HT", "TRI": "TT", "CUB": "CU", "NCA": "NI", "SUR": "SR", "CUW": "CW", "GUY": "GY", "DOM": "DO",
    "ARG": "AR", "BRA": "BR", "COL": "CO", "URU": "UY", "CHI": "CL", "PER": "PE", "ECU": "EC", "PAR": "PY",
    "VEN": "VE", "BOL": "BO", "ESP": "ES", "POR": "PT", "FRA": "FR", "GER": "DE", "ITA": "IT", "NED": "NL",
    "BEL": "BE", "CRO": "HR", "SUI": "CH", "JPN": "JP", "KOR": "KR", "AUS": "AU", "MAR": "MA", "SEN": "SN",
    "GHA": "GH", "NGA": "NG", "EGY": "EG", "KSA": "SA", "QAT": "QA", "IRN": "IR", "NZL": "NZ", "RSA": "ZA",
    "SRB": "RS", "CZE": "CZ", "POL": "PL", "SWE": "SE", "DEN": "DK", "NOR": "NO", "AUT": "AT", "TUR": "TR",
    "UKR": "UA", "IRL": "IE", "ISL": "IS", "ALG": "DZ", "TUN": "TN", "CMR": "CM", "CIV": "CI", "GRE": "GR",
    "HUN": "HU", "ROU": "RO", "SVK": "SK", "SVN": "SI", "CHN": "CN", "IRQ": "IQ", "UZB": "UZ", "JOR": "JO",
}
# Las que no son país ISO: bandera propia.
BANDERA_ESPECIAL = {
    "ENG": "🏴\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f",
    "SCO": "🏴\U000e0067\U000e0062\U000e0073\U000e0063\U000e0074\U000e007f",
    "WAL": "🏴\U000e0067\U000e0062\U000e0077\U000e006c\U000e0073\U000e007f",
}
# Nombre en español (ESPN los da en inglés); los que falten se quedan como vienen.
NOMBRE_ES = {
    "United States": "Estados Unidos", "Canada": "Canadá", "Panama": "Panamá", "Haiti": "Haití",
    "Trinidad and Tobago": "Trinidad y Tobago", "Brazil": "Brasil", "Peru": "Perú", "Spain": "España",
    "Germany": "Alemania", "Italy": "Italia", "Netherlands": "Países Bajos", "Belgium": "Bélgica",
    "Croatia": "Croacia", "Switzerland": "Suiza", "Japan": "Japón", "South Korea": "Corea del Sur",
    "Morocco": "Marruecos", "Senegal": "Senegal", "Egypt": "Egipto", "Saudi Arabia": "Arabia Saudita",
    "Iran": "Irán", "New Zealand": "Nueva Zelanda", "South Africa": "Sudáfrica", "Serbia": "Serbia",
    "Czechia": "Chequia", "Poland": "Polonia", "Sweden": "Suecia", "Denmark": "Dinamarca", "Norway": "Noruega",
    "Turkey": "Turquía", "Türkiye": "Turquía", "Ukraine": "Ucrania", "Ireland": "Irlanda", "Iceland": "Islandia",
    "Algeria": "Argelia", "Tunisia": "Túnez", "Cameroon": "Camerún", "Ivory Coast": "Costa de Marfil",
    "England": "Inglaterra", "Scotland": "Escocia", "Wales": "Gales", "Greece": "Grecia", "Hungary": "Hungría",
    "Romania": "Rumania", "Slovakia": "Eslovaquia", "Slovenia": "Eslovenia", "Iraq": "Irak", "Jordan": "Jordania",
    "Uzbekistan": "Uzbekistán", "Dominican Republic": "República Dominicana", "Cuba": "Cuba",
}
TORNEO_ES = {
    "International Friendly": "Amistoso", "Concacaf Nations League": "Liga de Naciones",
    "Concacaf Gold Cup": "Copa Oro", "FIFA World Cup": "Mundial", "FIFA World Cup Qualifying": "Eliminatoria",
}


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


def bandera(abbr: str) -> str:
    if abbr in BANDERA_ESPECIAL:
        return BANDERA_ESPECIAL[abbr]
    iso = ISO2.get(abbr)
    if not iso:
        return "🏳️"
    return "".join(chr(0x1F1E6 + ord(c) - ord("A")) for c in iso)


def torneo(nombre: str) -> str:
    for en, es in TORNEO_ES.items():
        if en in nombre:
            return es
    return nombre


def partidos() -> list[dict]:
    r = requests.get(ESPN, timeout=30)
    if r.status_code != 200:
        fail(f"ESPN: {r.status_code} {r.text[:300]}")
    out: list[dict] = []
    ahora = datetime.now(timezone.utc)
    for e in r.json().get("events", []):
        comp = (e.get("competitions") or [{}])[0]
        mex = next((c for c in comp.get("competitors", []) if c.get("team", {}).get("abbreviation") == "MEX"), None)
        rival = next((c for c in comp.get("competitors", []) if c is not mex), None)
        if not mex or not rival:
            continue
        inicio = datetime.fromisoformat(e["date"].replace("Z", "+00:00"))
        if inicio < ahora:
            continue
        nombre = rival["team"].get("displayName", "Rival")
        out.append({
            "inicio": inicio.isoformat().replace("+00:00", "Z"),
            "rival": NOMBRE_ES.get(nombre, nombre),
            "bandera": bandera(rival["team"].get("abbreviation", "")),
            "local": mex.get("homeAway") == "home",
            "torneo": torneo(e.get("season", {}).get("displayName", "") or comp.get("type", {}).get("text", "")),
            "sede": comp.get("venue", {}).get("fullName"),
        })
    return sorted(out, key=lambda p: p["inicio"])


def guardar(token: str, lista: list[dict]) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    body = {
        "fields": {
            "raw": {"stringValue": json.dumps(lista, ensure_ascii=False)},
            "fuente": {"stringValue": "ESPN (site.api.espn.com, equipo 203)"},
            "updatedAt": {"timestampValue": now},
        }
    }
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in body["fields"])
    r = requests.patch(
        f"{FS_BASE}/agente_partidos/seleccion?{mask}",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body,
        timeout=30,
    )
    if r.status_code not in (200, 201):
        fail(f"Firestore: {r.status_code} {r.text[:300]}")


def main() -> None:
    token = os.environ.get("FIRESTORE_TOKEN")
    if not token:
        fail("Falta FIRESTORE_TOKEN")
    lista = partidos()
    for p in lista:
        print(f"{p['inicio']}  {p['bandera']} {p['rival']}  ({'local' if p['local'] else 'visita'}, {p['torneo']}, {p['sede']})")
    if not lista:
        # Sin partidos anunciados no se borra lo que hubiera: ESPN a veces responde vacío.
        print("ESPN no trae partidos próximos; se deja la lista anterior.")
        return
    guardar(token, lista)
    print(f"Guardados {len(lista)} partidos en agente_partidos/seleccion.")


if __name__ == "__main__":
    main()
