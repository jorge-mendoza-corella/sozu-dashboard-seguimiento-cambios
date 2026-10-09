/**
 * Festejo de deploys a PRD: las tarjetas de repo detectan un deploy a `main`
 * que acaba de terminar bien y lo anuncian; el personaje del agente lo
 * escucha y celebra (huracán + confeti + gritos con el nombre del repo).
 *
 * Solo festeja lo que termina MIENTRAS la pantalla está abierta: lo que ya
 * estaba terminado al cargar se toma como punto de partida, no como novedad.
 */
import type { WorkflowRun } from "./github";

export const EVENTO_FESTEJO = "agente:festejo-deploy";

export interface DetalleFestejo {
  repo: string;
}

/** Último deploy a main visto por repo (`owner/repo` → runId). Vive la sesión. */
const vistos = new Map<string, number>();
/** Un deploy que terminó hace más de esto no es noticia (pestaña dormida, etc.). */
const FRESCO_MS = 15 * 60_000;

/**
 * Revisa los runs de un repo; si hay un deploy a main nuevo, exitoso y
 * reciente, avisa al personaje. Devuelve `true` si festejó.
 */
export function revisarDeployPrd(owner: string, repo: string, label: string, runs: WorkflowRun[]): boolean {
  const clave = `${owner}/${repo}`;
  const ultimo = runs.find((r) => r.headBranch === "main" && r.status === "completed");
  if (!ultimo?.runId) return false;
  const previo = vistos.get(clave);
  vistos.set(clave, ultimo.runId);
  if (previo === undefined || previo === ultimo.runId) return false;
  if (ultimo.conclusion !== "success") return false;
  const termino = Date.parse(ultimo.updatedAt ?? ultimo.createdAt);
  if (Number.isFinite(termino) && Date.now() - termino > FRESCO_MS) return false;
  window.dispatchEvent(new CustomEvent<DetalleFestejo>(EVENTO_FESTEJO, { detail: { repo: label } }));
  return true;
}
