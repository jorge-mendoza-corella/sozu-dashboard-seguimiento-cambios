/**
 * Seguimiento de un ticket mandado a Claude Code (issue del repo orquestador):
 * en qué va, la conversación y responderle desde el dashboard.
 *
 * Todo sale de GitHub. Los comentarios de Claude y los de quien responde salen
 * con la misma cuenta, así que se distinguen por marcas:
 *   - comentario de seguimiento de claude-code-action: trae "View job" y el
 *     checklist (`- [x]`/`- [ ]`) que se usa como barra de avance;
 *   - comentarios de Claude: `<!-- georgia-claude -->`; si además traen
 *     `<!-- georgia-pregunta -->`, Claude se detuvo a esperar respuesta;
 *   - respuestas desde el dashboard: `<!-- georgia-humano:<email> -->`.
 */
import type { Octokit } from "@octokit/rest";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { ORQUESTADOR } from "./mandar.js";
import { estadoPrsTicket, type PrClaude } from "./prsTicket.js";

export type EstadoClaude = "en_cola" | "trabajando" | "esperando_respuesta" | "terminado" | "error";

export interface MensajeClaude {
  id: number;
  autor: "claude" | "persona";
  /** Correo de quien respondió desde el dashboard, o el login de GitHub. */
  quien: string | null;
  cuerpo: string;
  fecha: string;
  esPregunta: boolean;
  /** El comentario de avance (checklist) de claude-code-action. */
  esSeguimiento: boolean;
}

export interface SeguimientoClaude {
  estado: EstadoClaude;
  progreso: { hechos: number; total: number } | null;
  runUrl: string | null;
  issueUrl: string;
  mensajes: MensajeClaude[];
  /** PRs que Claude abrió, con en qué van (abierto, en dev, en main, en PRD). */
  prs: PrClaude[];
  /** Todos los PRs vigentes ya están en PRD: se puede cerrar el ticket. */
  listoParaCerrar: boolean;
  revisado: string;
}

const MARCA_CLAUDE = "<!-- georgia-claude -->";
const MARCA_PREGUNTA = "<!-- georgia-pregunta -->";
const MARCA_HUMANO = /<!-- georgia-humano:([^\s>]+) -->/;
const MAX_RESPUESTA = 4_000;

const esSeguimiento = (b: string) => b.includes("View job") && /Claude (Code is working|finished|encountered)/i.test(b);

const limpiar = (b: string) =>
  b.replace(/<!-- georgia-[^>]*-->/g, "").replace(/^@claude\s*/i, "").trim();

/** El issue que este ticket abrió (si lo mandó esta persona). */
export async function issueDelTicket(email: string, ticketId: string): Promise<{ numero: number; url: string }> {
  const x = (await getFirestore().doc(`agente_tickets_enviados/${email}__${ticketId}`).get()).data();
  if (!x?.issue?.numero) throw new HttpsError("not-found", "Este ticket no se ha mandado a Claude.");
  return { numero: Number(x.issue.numero), url: String(x.issue.url) };
}

export async function seguimientoClaude(
  gh: Octokit,
  issue: { numero: number; url: string },
  quien: { email: string; ticketId: string; forzarPrs?: boolean },
): Promise<SeguimientoClaude> {
  const [{ data: datosIssue }, comentarios, { data: runs }] = await Promise.all([
    gh.issues.get({ ...ORQUESTADOR, issue_number: issue.numero }),
    gh.paginate(gh.issues.listComments, { ...ORQUESTADOR, issue_number: issue.numero, per_page: 100 }),
    gh.actions.listWorkflowRunsForRepo({ ...ORQUESTADOR, per_page: 40 }),
  ]);

  const mensajes: MensajeClaude[] = comentarios.map((c) => {
    const b = c.body ?? "";
    const humano = b.match(MARCA_HUMANO);
    const deClaude = !humano && (esSeguimiento(b) || b.includes(MARCA_CLAUDE));
    return {
      id: c.id,
      autor: deClaude ? "claude" : "persona",
      quien: humano?.[1] ?? (deClaude ? null : c.user?.login ?? null),
      cuerpo: limpiar(b),
      fecha: c.updated_at ?? c.created_at,
      esPregunta: deClaude && b.includes(MARCA_PREGUNTA),
      esSeguimiento: deClaude && esSeguimiento(b),
    };
  });

  // Corridas de este issue: issues y issue_comment llevan el título del issue.
  const run = runs.workflow_runs.find((r) => r.display_title === datosIssue.title) ?? null;
  const corriendo = run && (run.status === "queued" || run.status === "in_progress" || run.status === "waiting" || run.status === "pending");
  const seguimiento = [...mensajes].reverse().find((m) => m.esSeguimiento) ?? null;
  const ultimoHumano = [...mensajes].reverse().find((m) => m.autor === "persona") ?? null;
  const ultimaPregunta = [...mensajes].reverse().find((m) => m.esPregunta) ?? null;

  let estado: EstadoClaude;
  if (corriendo) {
    estado = run.status === "in_progress" ? "trabajando" : "en_cola";
  } else if (!run && !seguimiento) {
    estado = "en_cola";
  } else if (ultimaPregunta && (!ultimoHumano || ultimoHumano.fecha < ultimaPregunta.fecha)) {
    estado = "esperando_respuesta";
  } else if (run?.conclusion && run.conclusion !== "success" && run.conclusion !== "skipped") {
    estado = "error";
  } else if (seguimiento && /Claude encountered/i.test(seguimiento.cuerpo)) {
    estado = "error";
  } else {
    estado = "terminado";
  }

  let progreso: SeguimientoClaude["progreso"] = null;
  if (seguimiento) {
    const hechos = (seguimiento.cuerpo.match(/^\s*- \[x\]/gim) ?? []).length;
    const total = hechos + (seguimiento.cuerpo.match(/^\s*- \[ \]/gm) ?? []).length;
    if (total) progreso = { hechos, total };
  }

  const urls = [...new Set(
    mensajes.filter((m) => m.autor === "claude")
      .flatMap((m) => m.cuerpo.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? []),
  )];
  // Mientras Claude trabaja los PRs cambian a cada rato: se revisan al terminar.
  const prsEstado = estado === "trabajando" || estado === "en_cola"
    ? { prs: urls.map((url) => prDeUrl(url)).filter((p): p is PrClaude => !!p), listo: false }
    : await estadoPrsTicket(gh, quien.email, quien.ticketId, urls, quien.forzarPrs);

  return {
    estado,
    progreso,
    runUrl: run?.html_url ?? null,
    issueUrl: issue.url,
    mensajes,
    prs: prsEstado.prs,
    listoParaCerrar: prsEstado.listo,
    revisado: new Date().toISOString(),
  };
}

/** PR sin consultar a GitHub (mientras Claude sigue trabajando). */
function prDeUrl(url: string): PrClaude | null {
  const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  return m ? { url, owner: m[1], repo: m[2], numero: Number(m[3]), titulo: "", estado: "abierto", prMain: null } : null;
}

/** Comenta en el issue con @claude: dispara otra corrida con la respuesta. */
export async function responderAClaude(gh: Octokit, email: string, numero: number, texto: string): Promise<void> {
  const t = texto.trim();
  if (!t) throw new HttpsError("invalid-argument", "La respuesta viene vacía.");
  if (t.length > MAX_RESPUESTA) throw new HttpsError("invalid-argument", "La respuesta es demasiado larga.");
  await gh.issues.createComment({
    ...ORQUESTADOR,
    issue_number: numero,
    body: `@claude ${t}\n\n— ${email}, desde el dashboard <!-- georgia-humano:${email} -->`,
  });
}
