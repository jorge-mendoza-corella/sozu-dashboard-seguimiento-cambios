/**
 * Tickets del portal de sozu-admin asignados a quien está logueado.
 *
 * Los entrega la Cloud Function `agenteTickets` (lee Supabase del lado del
 * servidor, valida el permiso "Revisar tickets" y filtra por el email de la
 * sesión). Solo pipelines de Sistemas y etapas Nuevo / En revisión / En lista
 * de espera, ordenados por prioridad y antigüedad.
 *
 * Flujo completo:
 *   1. GeorgIA investiga en qué repos hay que trabajar (`agenteAnalizarTicket`).
 *   2. Se copia el .md para Claude Code; eso registra el ticket como "enviado"
 *      (`agente_tickets_enviados/{email}__{id}`).
 *   3. Los commits llevan el trailer `Ticket-SOZU: #<folio>`. Cuando un deploy a
 *      PRD trae un PR con ese trailer, se anota el PR en el registro y GeorgIA
 *      avisa que ya se puede cerrar.
 *   4. Cerrar (`agenteCerrarTicket`) pasa el ticket a Resuelto con la nota.
 */
import { getFunctions, httpsCallable } from "firebase/functions";
import { arrayUnion, collection, doc, getDocs, query, setDoc, where } from "firebase/firestore";
import { app, db } from "./firebase";
import { prDeMergeConCommits } from "./github";

export const INTERVALO_TICKETS_MS = 15 * 60_000;
/** Trailer que identifica un commit con su ticket (lo pide el .md). */
export const TRAILER_TICKET = "Ticket-SOZU";

export interface PersonaTicket {
  nombre: string;
  email: string | null;
  /** Es quien está logueado. */
  soyYo: boolean;
}

export interface EvidenciaTicket {
  nombre: string;
  tipo: "imagen" | "audio" | "documento" | "otro";
  /** URL pública del archivo en Storage (bucket `documentos`). */
  url: string | null;
}

export interface TicketAgente {
  id: string;
  numero: number;
  folio: string;
  pipelineId: string;
  etapaId: string;
  titulo: string;
  descripcion: string;
  etapa: string | null;
  pipeline: string | null;
  categoria: string | null;
  proyecto: string | null;
  prioridad: string | null;
  abiertoPor: string | null;
  abiertoEn: string;
  asignados: PersonaTicket[];
  evidencias: EvidenciaTicket[];
  /** Enlace directo al ticket en el portal (requiere sesión en el admin). */
  url: string | null;
}

export interface AnalisisTicket {
  resumen: string;
  repos: { repo: string; motivo: string; rutas: string[] }[];
  pasos: string[];
}

export interface RespuestaTickets {
  tickets: TicketAgente[];
  revisado: string;
}

const functions = getFunctions(app, "us-central1");
const llamarTickets = httpsCallable<Record<string, never>, RespuestaTickets>(functions, "agenteTickets", { timeout: 60_000 });
const llamarAnalisis = httpsCallable<{ ticketId: string; forzar?: boolean }, { analisis: AnalisisTicket; analizadoEn: string; desdeCache: boolean }>(
  functions, "agenteAnalizarTicket", { timeout: 300_000 },
);
const llamarCerrar = httpsCallable<{ ticketId: string; nota: string }, { ok: true; etapa: string }>(functions, "agenteCerrarTicket", { timeout: 60_000 });

export async function misTickets(): Promise<RespuestaTickets> {
  return (await llamarTickets({})).data;
}

export async function analizarTicket(ticketId: string, forzar = false) {
  return (await llamarAnalisis({ ticketId, forzar })).data;
}

export async function cerrarTicketPortal(ticketId: string, nota: string) {
  return (await llamarCerrar({ ticketId, nota })).data;
}

/** "jorge.mendoza@sozu.com" → "Jorge". */
export function nombreDeEmail(email: string | null | undefined): string {
  const base = (email ?? "").split("@")[0].split(/[._-]/)[0];
  return base ? base[0].toUpperCase() + base.slice(1) : "Oye";
}

export function gritosDeTickets(n: number, nombre: string): string[] {
  const t = n === 1 ? "1 ticket" : `${n} tickets`;
  return [
    `¡${nombre}! Tienes ${t} por checar`,
    `¡Ey, ${nombre}! ¡Hay ${t} esperándote!`,
    `¡No mames, ${nombre}, ${t} sin atender!`,
    "¡Dame clic y te los enseño!",
    `¡${nombre}, aguas con los tickets!`,
  ];
}

export function gritosDeCierre(folios: string[], nombre: string): string[] {
  const f = folios.join(", ");
  return [
    `¡${nombre}! ${f} ya está en PRD`,
    `¡Hay que cerrar ${f}!`,
    "¡Dame clic para cerrarlo!",
    `¡A huevo, ${nombre}! ${f} ya quedó`,
  ];
}

const fechaCorta = (iso: string) =>
  new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Mexico_City" });
const fechaLarga = (iso: string) =>
  new Date(iso).toLocaleString("es-MX", { dateStyle: "long", timeStyle: "short", timeZone: "America/Mexico_City" });

/** La línea que cada commit del cambio debe llevar al final (git trailer). */
export function trailerDeTicket(t: TicketAgente): string {
  return `${TRAILER_TICKET}: ${t.folio} | ${t.titulo} | abierto por ${t.abiertoPor ?? "—"} | ${fechaCorta(t.abiertoEn)}`;
}

/**
 * Prompt en Markdown para pasarle el ticket a Claude Code. Incluye lo que GeorgIA
 * investigó (repos, rutas, pasos), la convención de commits y cómo van las
 * imágenes. Es un punto de partida: el panel deja editarlo antes de copiarlo.
 */
export function promptDeTicket(t: TicketAgente, a: AnalisisTicket | null): string {
  const asignados = t.asignados.map((p) => `${p.nombre}${p.email ? ` <${p.email}>` : ""}`).join(", ") || "—";
  const imagenes = t.evidencias.filter((e) => e.tipo === "imagen");
  const otras = t.evidencias.filter((e) => e.tipo !== "imagen");
  const repos = a?.repos.length
    ? a.repos.map((r) => `- **${r.repo}**: ${r.motivo}${r.rutas.length ? `\n${r.rutas.map((p) => `  - \`${p}\``).join("\n")}` : ""}`).join("\n")
    : "- (GeorgIA no identificó repos: investiga tú dónde está el cambio antes de tocar código)";
  const pasos = a?.pasos.length ? a.pasos.map((p, i) => `${i + 1}. ${p}`).join("\n") : "";
  return `# Ticket ${t.folio}: ${t.titulo}

**Abierto por:** ${t.abiertoPor ?? "—"} · **Fecha:** ${fechaLarga(t.abiertoEn)}
**Asignado a:** ${asignados}
**Pipeline:** ${t.pipeline ?? "—"} · **Etapa:** ${t.etapa ?? "—"}${t.categoria ? ` · **Categoría:** ${t.categoria}` : ""}${t.prioridad ? ` · **Prioridad:** ${t.prioridad}` : ""}

## Descripción del problema

${t.descripcion.trim() || "(sin descripción)"}

## Dónde trabajar (investigación previa de GeorgIA)

${a?.resumen ? `${a.resumen}\n\n` : ""}${repos}
${pasos ? `\n### Pasos sugeridos\n\n${pasos}\n` : ""}
## Evidencias

${imagenes.length ? `Hay ${imagenes.length} imagen(es) adjunta(s); te las pego después de este mensaje (Ctrl/Cmd+V), en este orden:\n${imagenes.map((e, i) => `${i + 1}. ${e.nombre}${e.url ? ` — ${e.url}` : ""}`).join("\n")}` : "- Sin imágenes adjuntas."}
${otras.length ? `\nOtros adjuntos:\n${otras.map((e) => `- ${e.tipo}: ${e.nombre}${e.url ? ` — ${e.url}` : ""}`).join("\n")}` : ""}

## Qué necesito

1. Confirma en el código lo que dice la investigación previa (puede estar incompleta) y ubica la causa raíz con referencias \`archivo:línea\`.
2. Aplica el arreglo mínimo en una rama nueva por repo (\`fix/ticket-${t.numero}\`), con pruebas que cubran el caso.
3. **Cada commit de este cambio** debe terminar con esta línea (trailer), tal cual:

   \`\`\`
   ${trailerDeTicket(t)}
   \`\`\`

   El dashboard la usa para saber que el deploy a producción resolvió este ticket.
4. Abre el PR hacia \`dev\` siguiendo el flujo del repo y resume qué cambiaste, en puntos cortos.
`;
}

// ── Registro de tickets enviados a Claude ──────────────────────────────────

export interface PrDeTicket {
  repo: string;
  pr: number;
  url: string;
  cambios: string[];
}

export interface TicketEnviado {
  ticketId: string;
  numero: number;
  folio: string;
  titulo: string;
  prs: PrDeTicket[];
  cerrado: boolean;
}

const ENVIADOS = () => collection(db, "agente_tickets_enviados");
const idEnviado = (email: string, ticketId: string) => `${email}__${ticketId}`;

/** Copiar el .md cuenta como "pasarlo a Claude": desde ahí se vigilan sus deploys. */
export async function marcarEnviado(email: string, t: TicketAgente): Promise<void> {
  await setDoc(
    doc(ENVIADOS(), idEnviado(email, t.id)),
    { owner: email, ticketId: t.id, numero: t.numero, folio: t.folio, titulo: t.titulo, cerrado: false, enviadoEn: new Date().toISOString() },
    { merge: true },
  );
}

export async function misEnviados(email: string): Promise<TicketEnviado[]> {
  const snap = await getDocs(query(ENVIADOS(), where("owner", "==", email)));
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      ticketId: String(x.ticketId),
      numero: Number(x.numero),
      folio: String(x.folio ?? `#${x.numero}`),
      titulo: String(x.titulo ?? ""),
      prs: Array.isArray(x.prs) ? x.prs : [],
      cerrado: x.cerrado === true,
    };
  });
}

/** Folios del trailer `Ticket-SOZU: #1255 | …` en los mensajes de commit. */
export function foliosEnCommits(mensajes: string[]): number[] {
  const re = new RegExp(`^${TRAILER_TICKET}:\\s*#(\\d+)`, "gim");
  const out = new Set<number>();
  for (const m of mensajes) for (const x of m.matchAll(re)) out.add(Number(x[1]));
  return [...out];
}

/** Primera línea del commit, sin prefijo convencional ni trailers: un "punto puntual". */
function cambioDeCommit(mensaje: string): string | null {
  const linea = mensaje.split("\n")[0].trim();
  if (!linea || /^merge (pull request|branch)/i.test(linea)) return null;
  return linea.replace(/^\w+(\([^)]*\))?!?:\s*/, "").replace(/^./, (c) => c.toUpperCase());
}

/**
 * Tras un deploy exitoso a PRD: si el PR hacia main trae commits de tickets que
 * se pasaron desde aquí y siguen abiertos, se anota el PR en su registro.
 * Devuelve los tickets que ya se pueden cerrar.
 */
export async function ticketsResueltosEnDeploy(
  email: string,
  owner: string,
  repo: string,
  repoLabel: string,
  sha: string,
): Promise<TicketEnviado[]> {
  const pr = await prDeMergeConCommits(owner, repo, sha);
  if (!pr) return [];
  const folios = foliosEnCommits(pr.commits);
  if (!folios.length) return [];
  const enviados = (await misEnviados(email)).filter((e) => !e.cerrado && folios.includes(e.numero));
  const listos: TicketEnviado[] = [];
  for (const e of enviados) {
    // Solo los commits de ESTE ticket; si no hay ninguno con mensaje útil, el título del PR.
    const propios = pr.commits.filter((m) => foliosEnCommits([m]).includes(e.numero));
    const cambios = [...new Set(propios.map(cambioDeCommit).filter((c): c is string => !!c))].slice(0, 8);
    const entrada: PrDeTicket = { repo: repoLabel, pr: pr.numero, url: pr.url, cambios: cambios.length ? cambios : [pr.titulo] };
    if (!e.prs.some((p) => p.repo === entrada.repo && p.pr === entrada.pr)) {
      await setDoc(doc(ENVIADOS(), idEnviado(email, e.ticketId)), { prs: arrayUnion(entrada) }, { merge: true });
      e.prs.push(entrada);
    }
    listos.push(e);
  }
  return listos;
}

/**
 * Nota de seguimiento del cierre:
 *   Listo, favor de validar.
 *
 *   sozu-admin — PR hacia main #123
 *   - cambio 1
 */
export function notaDeCierre(prs: PrDeTicket[]): string {
  const bloques = prs.map((p) => `${p.repo} — PR hacia main #${p.pr}\n${p.cambios.map((c) => `- ${c}`).join("\n")}`);
  return ["Listo, favor de validar.", ...bloques].join("\n\n");
}
