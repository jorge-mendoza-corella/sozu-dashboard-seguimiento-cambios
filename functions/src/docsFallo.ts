/**
 * Por qué falló la documentación automática (sozu-docs) de un repo.
 *
 * El navegador no puede leer el log de un job (GitHub lo redirige a un blob sin
 * CORS), así que lo baja esta función con el token del dashboard y busca el
 * error de la API de Anthropic que tumbó la generación: sin crédito, llave
 * inválida, límite de uso, saturación. Lo demás se reporta como "otro" con la
 * línea de error que haya.
 */
import type { Octokit } from "@octokit/rest";

export type CausaDocs = "sin_credito" | "llave_invalida" | "limite" | "saturado" | "otro";

export interface FalloDocs {
  causa: CausaDocs;
  /** Línea del log que lo explica (recortada), si la hay. */
  detalle: string | null;
}

const PATRONES: [CausaDocs, RegExp][] = [
  ["sin_credito", /credit balance is too low/i],
  ["llave_invalida", /authentication_error|invalid x-api-key|\b401\b.*(api|key)/i],
  ["limite", /rate_limit_error|\b429\b/i],
  ["saturado", /overloaded_error|\b529\b/i],
];

const cache = new Map<string, FalloDocs>();

export async function falloDocs(gh: Octokit, owner: string, repo: string, runId: number): Promise<FalloDocs> {
  const clave = `${owner}/${repo}#${runId}`;
  const hit = cache.get(clave);
  if (hit) return hit;

  const { data } = await gh.actions.listJobsForWorkflowRun({ owner, repo, run_id: runId, per_page: 30 });
  const fallido = data.jobs.find((j) => j.conclusion === "failure") ?? data.jobs[0];
  if (!fallido) return { causa: "otro", detalle: null };

  const log = await gh.actions
    .downloadJobLogsForWorkflowRun({ owner, repo, job_id: fallido.id })
    .then((r) => String(r.data ?? ""))
    .catch(() => "");

  let res: FalloDocs = { causa: "otro", detalle: null };
  for (const [causa, re] of PATRONES) {
    const linea = log.split("\n").find((l) => re.test(l));
    if (linea) {
      res = { causa, detalle: limpiar(linea) };
      break;
    }
  }
  if (res.causa === "otro") {
    const linea = log.split("\n").find((l) => /\bError\b[:!]/.test(l));
    res = { causa: "otro", detalle: linea ? limpiar(linea) : null };
  }
  // Solo se cachean los runs terminados (el log ya no cambia).
  if (fallido.status === "completed") cache.set(clave, res);
  return res;
}

/** Quita el timestamp del runner y recorta. */
const limpiar = (l: string) => l.replace(/^\S+Z\s+/, "").trim().slice(0, 300);
