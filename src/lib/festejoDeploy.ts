/**
 * Reacciones del personaje a los deploys a PRD: las tarjetas de repo detectan
 * un deploy a `main` que acaba de terminar y lo anuncian; el personaje festeja
 * (huracán + confeti) si salió bien, o llora si falló. En los dos casos dice en
 * qué repo, de qué proyecto y de qué empresa fue.
 *
 * Solo reacciona a lo que termina MIENTRAS la pantalla está abierta: lo que ya
 * estaba terminado al cargar se toma como punto de partida, no como novedad.
 */
import type { WorkflowRun } from "./github";

export const EVENTO_FESTEJO = "agente:festejo-deploy";
export const EVENTO_FALLO = "agente:fallo-deploy";

export interface DetalleFestejo {
  repo: string;
  proyecto?: string | null;
  empresa?: string | null;
}

/** "server-stp · Sozu (Admin)" — lo que dice el letrero. */
export function dondeFue(d: DetalleFestejo): string {
  const contexto = d.empresa && d.proyecto ? `${d.empresa} (${d.proyecto})` : d.empresa ?? d.proyecto ?? null;
  return contexto ? `${d.repo} · ${contexto}` : d.repo;
}

/** Último deploy a main visto por repo (`owner/repo` → runId). Vive la sesión. */
const vistos = new Map<string, number>();
/** Un deploy que terminó hace más de esto no es noticia (pestaña dormida, etc.). */
const FRESCO_MS = 15 * 60_000;

/**
 * Revisa los runs de un repo; si hay un deploy a main nuevo y reciente, avisa
 * al personaje (festejo si salió bien, llanto si falló; los cancelados y
 * saltados no cuentan). Devuelve qué anunció.
 */
export function revisarDeployPrd(
  owner: string,
  repo: string,
  runs: WorkflowRun[],
  detalle: DetalleFestejo,
): "festejo" | "fallo" | null {
  const clave = `${owner}/${repo}`;
  const ultimo = runs.find((r) => r.headBranch === "main" && r.status === "completed");
  if (!ultimo?.runId) return null;
  const previo = vistos.get(clave);
  vistos.set(clave, ultimo.runId);
  if (previo === undefined || previo === ultimo.runId) return null;
  const termino = Date.parse(ultimo.updatedAt ?? ultimo.createdAt);
  if (Number.isFinite(termino) && Date.now() - termino > FRESCO_MS) return null;
  const tipo =
    ultimo.conclusion === "success" ? "festejo" : ultimo.conclusion === "failure" || ultimo.conclusion === "timed_out" ? "fallo" : null;
  if (!tipo) return null;
  window.dispatchEvent(new CustomEvent<DetalleFestejo>(tipo === "festejo" ? EVENTO_FESTEJO : EVENTO_FALLO, { detail: detalle }));
  return tipo;
}
