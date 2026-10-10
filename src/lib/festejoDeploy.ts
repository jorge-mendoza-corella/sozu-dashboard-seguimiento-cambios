/**
 * Reacciones de GeorgIA a los deploys: el vigía (useVigiaDeploys) revisa los
 * estados de TODOS los repos que el dashboard consultó —estén o no en la
 * pestaña que se ve— y, cuando un deploy acaba de terminar, avisa:
 *
 *   · PRD (main) exitoso → festejo (huracán + confeti)
 *   · PRD fallido        → llanto
 *   · dev exitoso        → brinco de gusto
 *   · dev fallido        → queja corta
 *
 * En todos los casos dice repo, proyecto y empresa, y la tarjeta del repo
 * brilla unos segundos (EVENTO_BRILLO) si está en pantalla.
 *
 * Solo reacciona a lo que termina MIENTRAS la pantalla está abierta: lo que ya
 * estaba terminado al cargar se toma como punto de partida, no como novedad.
 */
import type { WorkflowRun } from "./github";

export const EVENTO_FESTEJO = "agente:festejo-deploy";
export const EVENTO_FALLO = "agente:fallo-deploy";
export const EVENTO_DEV_OK = "agente:dev-ok";
export const EVENTO_DEV_FALLO = "agente:dev-fallo";
/** La tarjeta del repo brilla: `{ owner, repo, tipo: "exito" | "fallo" }`. */
export const EVENTO_BRILLO = "agente:brillo-repo";
/** Un deploy a PRD trajo commits de tickets pasados a Claude: ya se pueden cerrar. */
export const EVENTO_TICKETS_LISTOS = "agente:tickets-listos";

export interface DetalleFestejo {
  repo: string;
  proyecto?: string | null;
  empresa?: string | null;
}

export interface DetalleBrillo {
  owner: string;
  repo: string;
  tipo: "exito" | "fallo";
}

/** "server-stp · Sozu (Admin)" — lo que dice el letrero. */
export function dondeFue(d: DetalleFestejo): string {
  const contexto = d.empresa && d.proyecto ? `${d.empresa} (${d.proyecto})` : d.empresa ?? d.proyecto ?? null;
  return contexto ? `${d.repo} · ${contexto}` : d.repo;
}

/** Último deploy terminado visto por repo y rama (`owner/repo:rama` → runId). Vive la sesión. */
const vistos = new Map<string, number>();
/** Un deploy que terminó hace más de esto no es noticia (pestaña dormida, etc.). */
const FRESCO_MS = 15 * 60_000;

export type ReaccionDeploy = { rama: "main" | "dev"; resultado: "exito" | "fallo"; sha: string | null };

/**
 * Revisa los runs de un repo. Por cada rama (main = PRD, dev) con un deploy
 * nuevo y reciente, avisa a GeorgIA y hace brillar la tarjeta. Los cancelados y
 * saltados no cuentan. Devuelve lo que anunció.
 */
export function revisarDeploys(owner: string, repo: string, runs: WorkflowRun[], detalle: DetalleFestejo): ReaccionDeploy[] {
  const out: ReaccionDeploy[] = [];
  for (const rama of ["main", "dev"] as const) {
    const clave = `${owner}/${repo}:${rama}`;
    const ultimo = runs.find((r) => r.headBranch === rama && r.status === "completed");
    if (!ultimo?.runId) continue;
    const previo = vistos.get(clave);
    vistos.set(clave, ultimo.runId);
    if (previo === undefined || previo === ultimo.runId) continue;
    const termino = Date.parse(ultimo.updatedAt ?? ultimo.createdAt);
    if (Number.isFinite(termino) && Date.now() - termino > FRESCO_MS) continue;
    const resultado =
      ultimo.conclusion === "success" ? "exito" : ultimo.conclusion === "failure" || ultimo.conclusion === "timed_out" ? "fallo" : null;
    if (!resultado) continue;
    const evento =
      rama === "main"
        ? resultado === "exito" ? EVENTO_FESTEJO : EVENTO_FALLO
        : resultado === "exito" ? EVENTO_DEV_OK : EVENTO_DEV_FALLO;
    window.dispatchEvent(new CustomEvent<DetalleFestejo>(evento, { detail: detalle }));
    window.dispatchEvent(new CustomEvent<DetalleBrillo>(EVENTO_BRILLO, { detail: { owner, repo, tipo: resultado } }));
    out.push({ rama, resultado, sha: ultimo.headSha ?? null });
  }
  return out;
}
