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
import { falloDocs, type FalloDocs } from "../docsFallo.js";

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
  /**
   * Claude terminó sin abrir PRs (el arreglo ya estaba, o no hacía falta
   * cambio): también se puede cerrar, eligiendo si acaso los PRs que ya lo
   * habían resuelto. Queda en el registro para que el cierre lo valide.
   */
  sinCambios: boolean;
  /** Arranque de la corrida activa (o en cola) y, si ya terminó, cuándo. */
  corrida: { inicio: string; fin: string | null } | null;
  /** Por qué falló la última corrida (token vencido, límite de la ventana…), si falló. */
  fallo: FalloDocs | null;
  revisado: string;
}

const MARCA_CLAUDE = "<!-- georgia-claude -->";
const MARCA_PREGUNTA = "<!-- georgia-pregunta -->";
const MARCA_HUMANO = /<!-- georgia-humano:([^\s>]+) -->/;
const MAX_RESPUESTA = 4_000;

/**
 * Comentario de avance de claude-code-action: siempre termina con el enlace
 * "View job". El encabezado ("Claude Code is working…") no sirve para
 * reconocerlo: Claude lo reescribe con su propio título.
 */
const esSeguimiento = (b: string) => /\[View job( run)?\]\(https:\/\/github\.com\//i.test(b);
/** Mientras trabaja, el comentario de avance trae el spinner (un <img>) o "is working". */
const avanceTerminado = (b: string) => !/user-attachments\/assets\/5ac382c7|Claude Code is working/i.test(b);

/**
 * Claude a veces deja las preguntas en su comentario de avance (con track_progress
 * la respuesta final va ahí) sin la marca. Se reconoce igual: un paso sin palomear
 * que habla de esperar respuesta/confirmación, o al menos una línea que termina
 * en "?" al final del mensaje.
 */
function pidePregunta(b: string): boolean {
  if (b.includes(MARCA_PREGUNTA)) return true;
  if (/^\s*- \[ \].*(respuest|confirm|decid|defin|esperar)/im.test(b)) return true;
  const cola = b.slice(-2500);
  return cola.split("\n").some((l) => /\?\**\s*$/.test(l.trim()) && l.trim().length > 12);
}

// Sin el HTML que mete claude-code-action (el spinner es un <img>): el panel no
// interpreta HTML y se veía como texto.
const limpiar = (b: string) =>
  b.replace(/<!-- georgia-[^>]*-->/g, "").replace(/<img\b[^>]*>/gi, "").replace(/^@claude\s*/i, "").trim();

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
      // En el de avance solo cuenta cuando ya terminó: mientras trabaja, el
      // checklist tiene pasos sin palomear que no son preguntas.
      esPregunta: deClaude && (esSeguimiento(b) ? avanceTerminado(b) && pidePregunta(b) : pidePregunta(b)),
      esSeguimiento: deClaude && esSeguimiento(b),
    };
  });

  // Corridas de este issue: issues y issue_comment llevan el título del issue.
  // El comentario de avance que crea Claude dispara otra corrida que se queda
  // pendiente detrás de la actual (y luego se salta): la más nueva no es la que
  // trabaja. Manda la que está en curso; si no hay, la pendiente; si no, la
  // última que terminó sin saltarse.
  const delIssue = runs.workflow_runs.filter((r) => r.display_title === datosIssue.title);
  const enEspera = (st: string | null) => st === "queued" || st === "waiting" || st === "pending" || st === "requested";
  const enCurso = delIssue.find((r) => r.status === "in_progress") ?? null;
  const pendiente = delIssue.find((r) => enEspera(r.status)) ?? null;
  const terminada = delIssue.find((r) => r.status === "completed" && r.conclusion !== "skipped") ?? null;
  const run = enCurso ?? pendiente ?? terminada;
  const corriendo = !!(enCurso || pendiente);
  const seguimiento = [...mensajes].reverse().find((m) => m.esSeguimiento) ?? null;
  const ultimoHumano = [...mensajes].reverse().find((m) => m.autor === "persona") ?? null;
  const ultimaPregunta = [...mensajes].reverse().find((m) => m.esPregunta) ?? null;

  let estado: EstadoClaude;
  if (corriendo) {
    estado = enCurso ? "trabajando" : "en_cola";
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
  // Con una corrida activa, el checklist solo cuenta si es de ESA corrida (uno
  // de la anterior está completo y pintaría 100% mientras sigue trabajando).
  const checklistVigente = !seguimiento || !corriendo || !run?.created_at || seguimiento.fecha >= run.created_at;
  if (seguimiento && checklistVigente) {
    const hechos = (seguimiento.cuerpo.match(/^\s*- \[x\]/gim) ?? []).length;
    const total = hechos + (seguimiento.cuerpo.match(/^\s*- \[ \]/gm) ?? []).length;
    if (total) progreso = { hechos, total };
  }

  const urls = [...new Set(
    mensajes.filter((m) => m.autor === "claude")
      .flatMap((m) => m.cuerpo.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? []),
  )];
  // También mientras trabaja: un PR de una corrida anterior puede estar ya en
  // dev o en main. `estadoPrsTicket` reusa lo revisado hace < 10 min (y rehace
  // en cuanto aparece un PR nuevo), así que no se gasta una consulta por sondeo.
  const prsEstado = await estadoPrsTicket(gh, quien.email, quien.ticketId, urls, quien.forzarPrs).catch(() => ({
    prs: urls.map((url) => prDeUrl(url)).filter((p): p is PrClaude => !!p),
    listo: false,
  }));

  const sinCambios = estado === "terminado" && prsEstado.prs.filter((p) => p.estado !== "cerrado").length === 0;
  await getFirestore()
    .doc(`agente_tickets_enviados/${quien.email}__${quien.ticketId}`)
    .set({ sinCambios }, { merge: true })
    .catch(() => undefined);

  // Solo cuando la corrida falló: el log se baja una vez y queda en caché.
  const fallo = estado === "error" && run?.conclusion === "failure"
    ? await falloDocs(gh, ORQUESTADOR.owner, ORQUESTADOR.repo, run.id).catch(() => null)
    : null;

  return {
    estado,
    progreso,
    fallo,
    runUrl: run?.html_url ?? null,
    issueUrl: issue.url,
    mensajes,
    prs: prsEstado.prs,
    listoParaCerrar: prsEstado.listo,
    sinCambios,
    corrida: run
      ? {
          inicio: run.run_started_at ?? run.created_at,
          fin: corriendo ? null : run.updated_at ?? null,
        }
      : null,
    revisado: new Date().toISOString(),
  };
}

/** PR sin consultar a GitHub (mientras Claude sigue trabajando). */
function prDeUrl(url: string): PrClaude | null {
  const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  return m ? { url, owner: m[1], repo: m[2], numero: Number(m[3]), titulo: "", estado: "abierto", prMain: null } : null;
}

export interface AdjuntoRespuesta {
  nombre: string;
  tipo: "imagen" | "video" | "audio";
  url: string;
}

/** Solo URLs de Storage de este proyecto (las que abre `agenteSubirAdjunto`). */
const URL_ADJUNTO = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[\w.-]+\/o\/georgia-adjuntos%2F[^\s]+$/;

/**
 * Comenta en el issue con @claude: dispara otra corrida con la respuesta. Los
 * adjuntos van en el formato que lee el orquestador ("- audio: nombre — url"):
 * los audios y videos se transcriben antes de que arranque Claude.
 */
export async function responderAClaude(
  gh: Octokit,
  email: string,
  numero: number,
  texto: string,
  adjuntos: AdjuntoRespuesta[] = [],
): Promise<void> {
  const validos = adjuntos
    .filter((a) => ["imagen", "video", "audio"].includes(a?.tipo) && typeof a.url === "string" && URL_ADJUNTO.test(a.url))
    .slice(0, 10);
  const lista = validos.length
    ? `\n\nAdjuntos:\n${validos.map((a) => `- ${a.tipo}: ${String(a.nombre).replace(/\s+/g, " ").slice(0, 80)} — ${a.url}`).join("\n")}`
    : "";
  const t = texto.trim() || (validos.length ? "Te mando adjuntos." : "");
  if (!t) throw new HttpsError("invalid-argument", "La respuesta viene vacía.");
  if (t.length > MAX_RESPUESTA) throw new HttpsError("invalid-argument", "La respuesta es demasiado larga.");
  await gh.issues.createComment({
    ...ORQUESTADOR,
    issue_number: numero,
    body: `@claude ${t}${lista}\n\n— ${email}, desde el dashboard <!-- georgia-humano:${email} -->`,
  });
}
