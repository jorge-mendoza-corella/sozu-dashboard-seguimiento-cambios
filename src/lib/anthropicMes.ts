import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";
import { computeResultCost } from "./anthropicAdmin";

// ---------------------------------------------------------------------------
// Gasto del mes en la API de Anthropic, para el badge de costos de la barra.
//
// Lo escribe scripts/sync-anthropic-costs.py (cada 15 min) en
// anthropic_costs_cache/mes: el total sale de cost_report (lo que factura
// Anthropic, sin estimar) y el reparto por llave de usage_report, que es lo
// único que desglosa por llave. Ese reparto se valora con la tabla de precios
// y se escala al total real: la suma por llave cuadra con la factura aunque la
// tabla esté desactualizada.
// ---------------------------------------------------------------------------

interface TokensModelo {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

interface Crudo {
  anio: number;
  mes: number;
  totalUsd: number | null;
  porConcepto: Record<string, number>;
  porLlave: Record<string, { nombre: string; modelos: Record<string, TokensModelo> }>;
  error: string | null;
}

export interface CostoLlave {
  id: string;
  nombre: string;
  usd: number;
  modelos: string[];
}

export interface AnthropicMes {
  anio: number;
  mes: number;
  totalUsd: number;
  porLlave: CostoLlave[];
  /** Lo más caro por concepto de factura ("Claude Opus 5 - Output Tokens"…). */
  porConcepto: { concepto: string; usd: number }[];
  updatedAt: string | null;
  error: string | null;
}

/** Nombres de llave conocidos → para qué se usan. */
const USO_LLAVE: Record<string, string> = {
  "anthropic-api-key-documentacion": "Docs automáticos (sozu-docs)",
};

export async function getAnthropicMes(): Promise<AnthropicMes | null> {
  const snap = await getDoc(doc(db, "anthropic_costs_cache", "mes"));
  if (!snap.exists()) return null;
  const d = snap.data() as { json?: string; updatedAt?: string };
  let c: Crudo;
  try {
    c = JSON.parse(d.json ?? "null") as Crudo;
  } catch {
    return null;
  }
  if (!c) return null;

  const estimadas = Object.entries(c.porLlave ?? {}).map(([id, l]) => ({
    id,
    nombre: USO_LLAVE[l.nombre] ? `${USO_LLAVE[l.nombre]} · ${l.nombre}` : l.nombre,
    modelos: Object.keys(l.modelos),
    est: Object.entries(l.modelos).reduce(
      (s, [model, t]) =>
        s + computeResultCost({
          account_id: null,
          model,
          uncached_input_tokens: t.input,
          output_tokens: t.output,
          cache_read_input_tokens: t.cacheRead,
          cache_creation: { ephemeral_5m_input_tokens: t.cacheCreate },
        }),
      0,
    ),
  }));
  const sumaEst = estimadas.reduce((s, x) => s + x.est, 0);
  const total = c.totalUsd ?? sumaEst;
  const factor = sumaEst > 0 ? total / sumaEst : 0;

  return {
    anio: c.anio,
    mes: c.mes,
    totalUsd: total,
    porLlave: estimadas
      .map(({ id, nombre, modelos, est }) => ({ id, nombre, modelos, usd: est * factor }))
      .filter((x) => x.usd >= 0.005)
      .sort((a, b) => b.usd - a.usd),
    porConcepto: Object.entries(c.porConcepto ?? {})
      .map(([concepto, usd]) => ({ concepto, usd }))
      .sort((a, b) => b.usd - a.usd),
    updatedAt: d.updatedAt ?? null,
    error: c.error,
  };
}
