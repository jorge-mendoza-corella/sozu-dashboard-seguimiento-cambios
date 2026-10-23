/**
 * Tickets del portal de sozu-admin asignados a quien está logueado.
 *
 * Los entrega la Cloud Function `agenteTickets` (lee Supabase del lado del
 * servidor, valida el permiso "Revisar tickets" y filtra por el email de la
 * sesión). Solo pipelines con «Mostrar el asistente al levantar un ticket»
 * prendido y etapas Nuevo / En revisión / En lista de espera (o la de entrada
 * del pipeline), ordenados por prioridad y antigüedad.
 *
 * Flujo completo:
 *   1. "Mandar a Claude" (`agenteMandarAClaude`) abre un issue con el .md en el
 *      repo orquestador; Claude Code (suscripción, en GitHub Actions) investiga,
 *      arregla y abre PRs hacia `dev`. Copiar el .md a mano sigue disponible.
 *      Cualquiera de los dos registra el ticket como "enviado"
 *      (`agente_tickets_enviados/{email}__{id}`).
 *   3. Los commits llevan el trailer `Ticket-SOZU: #<folio>`. Cuando un deploy a
 *      PRD trae un PR con ese trailer, se anota el PR en el registro y GeorgIA
 *      avisa que ya se puede cerrar.
 *   4. Cerrar (`agenteCerrarTicket`) pasa el ticket a Resuelto con la nota.
 */
import { getFunctions, httpsCallable } from "firebase/functions";
import { arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { app, db } from "./firebase";
import { prDeMergeConCommits } from "./github";
import type { FalloDocs } from "./docsFallo";

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
  tipo: "imagen" | "audio" | "video" | "documento" | "otro";
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
  /** Correo de quien levantó el ticket (usuario del portal); puede faltar en respuestas viejas. */
  creadorEmail?: string | null;
  proyecto: string | null;
  prioridad: string | null;
  abiertoPor: string | null;
  abiertoEn: string;
  asignados: PersonaTicket[];
  /** Lo atiende quien pregunta («Yo trabajo el ticket» o «Mandar a Claude»); falta en respuestas viejas. */
  loAtiendoYo?: boolean;
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
const llamarMandar = httpsCallable<{ ticketId: string; md: string }, IssueClaude>(functions, "agenteMandarAClaude", { timeout: 60_000 });
const llamarCerrar = httpsCallable<{ ticketId: string; nota: string }, { ok: true; etapa: string }>(functions, "agenteCerrarTicket", { timeout: 60_000 });

export async function misTickets(): Promise<RespuestaTickets> {
  return (await llamarTickets({})).data;
}

export interface IssueClaude {
  numero: number;
  url: string;
  yaExistia: boolean;
}

export type EstadoClaude = "en_cola" | "trabajando" | "esperando_respuesta" | "terminado" | "error";

export interface MensajeClaude {
  id: number;
  autor: "claude" | "persona";
  quien: string | null;
  cuerpo: string;
  fecha: string;
  esPregunta: boolean;
  esSeguimiento: boolean;
}

export type EstadoPr = "abierto" | "en_dev" | "en_main" | "en_prd" | "cerrado";

export interface PrClaude {
  url: string;
  owner: string;
  repo: string;
  numero: number;
  titulo: string;
  estado: EstadoPr;
  prMain: { numero: number; url: string } | null;
}

export interface SeguimientoClaude {
  estado: EstadoClaude;
  progreso: { hechos: number; total: number } | null;
  runUrl: string | null;
  issueUrl: string;
  mensajes: MensajeClaude[];
  /** PRs que abrió Claude y en qué van. */
  prs: PrClaude[];
  /** Todos los PRs vigentes ya están en PRD: se puede cerrar. */
  listoParaCerrar: boolean;
  /** Arranque de la corrida activa (o la última) y su fin, si ya terminó. */
  corrida?: { inicio: string; fin: string | null } | null;
  /** Por qué falló la última corrida, si falló (lo saca la función del log). */
  fallo?: FalloDocs | null;
  revisado: string;
}

/**
 * Sigla de dos letras de cada repo (la misma que pone el orquestador en la
 * consola): para saber de qué repo es cada cosa cuando el ticket toca varios.
 */
const SIGLAS: Record<string, string> = {
  "sozu-supabase-migrations": "BD",
  "sozu-edge-functions": "BE",
  "sozu-admin": "FE",
  "sozu-cliente-app": "AC",
  "sozu-agente-app": "AA",
  "sozu-n8n-workflows": "N8",
  "sozu-mcp": "MC",
  "sozu-docs": "DO",
  "server-stp": "ST",
  "extraccion-avances": "EA",
};
export const siglaRepo = (repo: string) => SIGLAS[repo] ?? repo.replace(/^sozu-/, "").slice(0, 2).toUpperCase();

/** "45s", "12m", "1h 05m". */
export function duracion(desdeIso: string, hasta = Date.now()): string {
  const s = Math.max(0, Math.round((hasta - Date.parse(desdeIso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** PRs vigentes (sin los cerrados sin merge) y cuántos ya llegaron a PRD. */
export function avancePrs(prs: PrClaude[]): { enPrd: number; total: number } {
  const vigentes = prs.filter((p) => p.estado !== "cerrado");
  return { enPrd: vigentes.filter((p) => p.estado === "en_prd").length, total: vigentes.length };
}

const llamarSeguimiento = httpsCallable<{ ticketId: string; forzarPrs?: boolean }, SeguimientoClaude>(functions, "agenteClaudeSeguimiento", { timeout: 60_000 });
export interface AdjuntoRespuesta {
  nombre: string;
  tipo: "imagen" | "video" | "audio";
  url: string;
}

const llamarResponder = httpsCallable<{ ticketId: string; texto: string; adjuntos: AdjuntoRespuesta[] }, { ok: true }>(
  functions, "agenteClaudeResponder", { timeout: 60_000 },
);
const llamarSubida = httpsCallable<{ ticketId: string; nombre: string; tipo: string; tamano: number }, { sesion: string; url: string }>(
  functions, "agenteSubirAdjunto", { timeout: 60_000 },
);

export const MAX_ADJUNTO_MB = 200;

export const tipoAdjunto = (mime: string): AdjuntoRespuesta["tipo"] | null =>
  mime.startsWith("image/") ? "imagen" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : null;

/**
 * Sube una imagen, video o audio para la respuesta a Claude. La función abre la
 * subida y el archivo va directo a Storage (sin pasar por el callable, que tiene
 * tope de tamaño); `alAvanzar` recibe 0–1.
 */
export async function subirAdjunto(ticketId: string, archivo: File, alAvanzar: (p: number) => void): Promise<AdjuntoRespuesta> {
  const tipo = tipoAdjunto(archivo.type);
  if (!tipo) throw new Error("Solo imágenes, videos o audios.");
  if (archivo.size > MAX_ADJUNTO_MB * 1024 * 1024) throw new Error(`Pasa de ${MAX_ADJUNTO_MB} MB.`);
  const { sesion, url } = (await llamarSubida({ ticketId, nombre: archivo.name, tipo: archivo.type, tamano: archivo.size })).data;
  await new Promise<void>((ok, mal) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", sesion);
    xhr.setRequestHeader("Content-Type", archivo.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && alAvanzar(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? ok() : mal(new Error(`La subida respondió ${xhr.status}.`)));
    xhr.onerror = () => mal(new Error("No se pudo subir el archivo."));
    xhr.send(archivo);
  });
  return { nombre: archivo.name, tipo, url };
}

export interface TokenClaude {
  /** Hay token con el que mandar tickets. */
  conectado: boolean;
  /** Es el token compartido del root (también lo usan los docs). */
  compartido: boolean;
  renovado: string | null;
  vence: string | null;
}

const llamarToken = httpsCallable<{ accion?: string; keyId?: string; cifrado?: string }, TokenClaude & { keyId?: string; key?: string }>(
  functions, "agenteClaudeToken", { timeout: 30_000 },
);

/** Si quien entra tiene su token de Claude conectado y cuándo vence. */
export async function tokenClaude(): Promise<TokenClaude> {
  return (await llamarToken({ accion: "leer" })).data;
}

/** Root: marca el token compartido como recién renovado (vence en un año). */
export async function marcarTokenRenovado(): Promise<TokenClaude> {
  return (await llamarToken({ accion: "renovado" })).data;
}

/** Lo que imprime `claude setup-token`. */
export const FORMATO_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;

/**
 * Conecta el token de Claude de quien entra. Se cifra AQUÍ, en el navegador, con
 * la llave pública del repo orquestador (sealed box, lo que pide GitHub para
 * sus secrets): la función y Firestore solo ven el texto cifrado, y solo GitHub
 * Actions lo puede abrir.
 */
export async function conectarClaude(token: string): Promise<TokenClaude> {
  // La terminal a veces parte el token en varias líneas al copiarlo.
  const limpio = token.replace(/\s+/g, "");
  if (!FORMATO_TOKEN.test(limpio)) throw new Error("Eso no parece un token de Claude: empieza con sk-ant-oat01- y es una sola línea.");
  const { keyId, key } = (await llamarToken({ accion: "llave" })).data;
  if (!keyId || !key) throw new Error("No se pudo preparar el cifrado.");
  const sodium = (await import("libsodium-wrappers")).default;
  await sodium.ready;
  const cifrado = sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(limpio), sodium.from_base64(key, sodium.base64_variants.ORIGINAL)),
    sodium.base64_variants.ORIGINAL,
  );
  return (await llamarToken({ accion: "conectar", keyId, cifrado })).data;
}

/** Borra el token de quien entra (deja de poder mandar tickets). */
export async function desconectarClaude(): Promise<TokenClaude> {
  return (await llamarToken({ accion: "desconectar" })).data;
}

/** En qué va Claude Code con el ticket: estado, avance, conversación y PRs. */
export async function seguimientoClaude(ticketId: string, forzarPrs = false): Promise<SeguimientoClaude> {
  return (await llamarSeguimiento({ ticketId, forzarPrs })).data;
}

/**
 * Consulta de react-query del seguimiento: la usan el renglón y el detalle del
 * ticket y el orden de la lista, así que comparten caché y sondeo (más seguido
 * mientras Claude está en cola o trabajando).
 */
export const consultaSeguimiento = (ticketId: string) => ({
  queryKey: ["claude-seguimiento", ticketId],
  queryFn: () => seguimientoClaude(ticketId),
  refetchInterval: (query: { state: { data?: SeguimientoClaude } }) => {
    const e = query.state.data?.estado;
    return e === "en_cola" || e === "trabajando" ? 15_000 : 60_000;
  },
  refetchIntervalInBackground: false,
  retry: 1,
});

/** Contesta a Claude (comentario con @claude en el issue: arranca otra corrida). */
export async function responderAClaude(ticketId: string, texto: string, adjuntos: AdjuntoRespuesta[] = []): Promise<void> {
  await llamarResponder({ ticketId, texto, adjuntos });
}

/** Abre el issue para Claude Code con el .md (ya editado). Si ya se mandó, devuelve el mismo. */
export async function mandarAClaude(ticketId: string, md: string): Promise<IssueClaude> {
  return (await llamarMandar({ ticketId, md })).data;
}

/**
 * Investigación que dejó el análisis por API (ya retirado), si el ticket la
 * tiene. Solo lectura: los tickets nuevos no la llevan.
 */
export async function analisisGuardado(ticketId: string): Promise<AnalisisTicket | null> {
  try {
    const x = (await getDoc(doc(db, "agente_tickets", ticketId))).data();
    return x?.analisis ? (x.analisis as AnalisisTicket) : null;
  } catch {
    return null;
  }
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

/**
 * El portal guarda muchos tickets con solo la fecha, como medianoche UTC
 * ("2026-10-12" → 2026-10-12T00:00Z). Pasada a hora de México esa medianoche cae
 * a las 6 pm del día ANTERIOR, y el ticket del 12 se leía del 11. Una hora de
 * 00:00:00 UTC exacta se toma como fecha sin hora: se muestra ese día, sin hora.
 */
export const esSoloFecha = (iso: string) => {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
};

const zonaDe = (iso: string) => (esSoloFecha(iso) ? "UTC" : "America/Mexico_City");

/** Fecha de apertura de un ticket, con o sin hora según lo que guarde el portal. */
export function fechaTicket(iso: string, estilo: "dia" | "corta" | "larga"): string {
  const d = new Date(iso);
  const timeZone = zonaDe(iso);
  if (estilo === "dia") return d.toLocaleDateString("es-MX", { day: "numeric", month: "short", timeZone });
  if (estilo === "corta") return d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone });
  return esSoloFecha(iso)
    ? d.toLocaleDateString("es-MX", { dateStyle: "long", timeZone })
    : d.toLocaleString("es-MX", { dateStyle: "long", timeStyle: "short", timeZone });
}

const fechaCorta = (iso: string) => fechaTicket(iso, "corta");
const fechaLarga = (iso: string) => fechaTicket(iso, "larga");

/** La línea que cada commit del cambio debe llevar al final (git trailer). */
export function trailerDeTicket(t: TicketAgente): string {
  return `${TRAILER_TICKET}: ${t.folio} | ${t.titulo} | abierto por ${t.abiertoPor ?? "—"} | ${fechaCorta(t.abiertoEn)}`;
}

/**
 * Prompt en Markdown para pasarle el ticket a Claude Code: datos, evidencias (por
 * URL), la investigación previa si un análisis viejo la dejó, y la convención
 * de commits. Es un punto de partida: el panel deja editarlo antes de mandarlo.
 */
export function promptDeTicket(t: TicketAgente, a: AnalisisTicket | null): string {
  const asignados = t.asignados.map((p) => `${p.nombre}${p.email ? ` <${p.email}>` : ""}`).join(", ") || "—";
  const imagenes = t.evidencias.filter((e) => e.tipo === "imagen");
  const otras = t.evidencias.filter((e) => e.tipo !== "imagen");
  const repos = a?.repos.length
    ? a.repos.map((r) => `- **${r.repo}**: ${r.motivo}${r.rutas.length ? `\n${r.rutas.map((p) => `  - \`${p}\``).join("\n")}` : ""}`).join("\n")
    : "";
  const pasos = a?.pasos.length ? a.pasos.map((p, i) => `${i + 1}. ${p}`).join("\n") : "";
  const investigacion = a && (a.resumen || repos)
    ? `## Investigación previa (puede estar desactualizada)

${a.resumen ? `${a.resumen}\n\n` : ""}${repos}
${pasos ? `\n### Pasos sugeridos\n\n${pasos}\n` : ""}
`
    : "";
  return `# Ticket ${t.folio}: ${t.titulo}

**Abierto por:** ${t.abiertoPor ?? "—"} · **Fecha:** ${fechaLarga(t.abiertoEn)}
**Asignado a:** ${asignados}
**Pipeline:** ${t.pipeline ?? "—"} · **Etapa:** ${t.etapa ?? "—"}${t.categoria ? ` · **Categoría:** ${t.categoria}` : ""}${t.prioridad ? ` · **Prioridad:** ${t.prioridad}` : ""}

## Descripción del problema

${t.descripcion.trim() || "(sin descripción)"}

${investigacion}## Evidencias

${imagenes.length ? `Hay ${imagenes.length} imagen(es) adjunta(s), en este orden (descárgalas de su URL para verlas):\n${imagenes.map((e, i) => `${i + 1}. ${e.nombre}${e.url ? ` — ${e.url}` : ""}`).join("\n")}` : "- Sin imágenes adjuntas."}
${otras.length ? `\nOtros adjuntos:\n${otras.map((e) => `- ${e.tipo}: ${e.nombre}${e.url ? ` — ${e.url}` : ""}`).join("\n")}` : ""}${otras.some((e) => e.tipo === "audio" || e.tipo === "video") ? "\n\nLos audios y videos ya vienen transcritos (y los videos, en capturas) en la carpeta de evidencias: léelos antes de empezar; muchas veces ahí está el detalle del problema." : ""}

## Qué necesito

1. Investiga en qué repos está el cambio y ubica la causa raíz con referencias \`archivo:línea\`.
2. Aplica el arreglo mínimo en una rama nueva por repo (\`fix/ticket-${t.numero}\`), con pruebas que cubran el caso.
3. **Cada commit de este cambio** debe terminar con esta línea (trailer), tal cual:

   \`\`\`
   ${trailerDeTicket(t)}
   \`\`\`

   El dashboard la usa para saber que el deploy a producción resolvió este ticket.
4. Abre el PR hacia \`dev\` siguiendo el flujo del repo y resume qué cambiaste, en puntos cortos.
`;
}

// ── Borrador del .md ───────────────────────────────────────────────────────

/**
 * El .md editado se guarda en Firestore (por persona y ticket) para no perderlo
 * al cambiar de navegador o de equipo. `null` = no hay edición: se usa el generado.
 */
const borradorRef = (email: string, ticketId: string) => doc(db, "agente_tickets_borradores", `${email}__${ticketId}`);

export async function leerBorradorMd(email: string, ticketId: string): Promise<string | null> {
  try {
    const x = (await getDoc(borradorRef(email, ticketId))).data();
    return typeof x?.md === "string" ? x.md : null;
  } catch {
    return null;
  }
}

export async function guardarBorradorMd(email: string, ticketId: string, md: string | null): Promise<void> {
  if (md === null) await deleteDoc(borradorRef(email, ticketId));
  else await setDoc(borradorRef(email, ticketId), { owner: email, ticketId, md, editadoEn: serverTimestamp() });
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
  /**
   * Ya se puede cerrar. Mandado a Claude: TODOS sus PRs en PRD (lo decide el
   * servidor). Copiado a mano: algún PR con el trailer llegó a PRD.
   */
  listo: boolean;
  /** Issue del repo orquestador, si se mandó con "Mandar a Claude". */
  issue: { numero: number; url: string } | null;
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
      listo: x.issue?.url ? x.listoParaCerrar === true : Array.isArray(x.prs) && x.prs.length > 0,
      issue: x.issue?.url ? { numero: Number(x.issue.numero), url: String(x.issue.url) } : null,
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
    // Mandado a Claude: puede tener PRs en varios repos. Se cierra hasta que
    // TODOS estén en PRD, y eso lo revisa el servidor contra GitHub.
    if (e.issue) {
      if (e.listo) continue;
      const s = await seguimientoClaude(e.ticketId, true).catch(() => null);
      if (s?.listoParaCerrar) listos.push({ ...e, listo: true });
      continue;
    }
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
