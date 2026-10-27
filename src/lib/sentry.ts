import { doc, getDoc } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { app, db } from "./firebase";
import { isRootAdmin, resolvePermissions, type AppUser } from "./firestoreUsers";

// ---------------------------------------------------------------------------
// Errores de Sentry por proyecto (pestaña Monitoreo).
//
// El token de Sentry lee los errores de toda la organización y no viaja al
// navegador: `ci/sentry_sync.py` los resume en `sentry/{projectSlug}` y aquí
// solo se lee eso. El slug de cada proyecto de Sentry es el nombre del repo.
// ---------------------------------------------------------------------------

export const SENTRY_ORG = "sozu-lh";
/**
 * ¿Ve los errores de ESTE repo? `verMonitoreo` resuelto como los permisos de
 * CI/CD (repo > empresa > general). Que el repo esté entre los suyos lo decide
 * quien llama, con el mismo alcance de empresa/proyecto/repo del resto del
 * dashboard. Mismo corte que las reglas de `sentry/*`.
 */
export function veMonitoreoDe(user: AppUser | null, clientId: string | null | undefined, repoId: string): boolean {
  if (!user) return false;
  if (isRootAdmin(user)) return true;
  return resolvePermissions(user, { clientId, repoId }).verMonitoreo;
}

/** ¿Puede resolver, ignorar o reabrir issues de ESTE repo? Mismo corte que `sentryCambiarIssue`. */
export function resuelveMonitoreoDe(user: AppUser | null, clientId: string | null | undefined, repoId: string): boolean {
  if (!user) return false;
  if (isRootAdmin(user)) return true;
  const p = resolvePermissions(user, { clientId, repoId });
  return p.verMonitoreo && p.resolverMonitoreo;
}

export interface SentryIssue {
  id: string;
  shortId: string;
  titulo: string;
  culprit: string;
  nivel: string;
  /** unresolved | resolved | ignored. Los docs viejos no lo traen. */
  estado?: string;
  /** Ticket del portal levantado para este issue, si hay. */
  ticket?: { numero: number; url: string };
  eventos: number;
  usuarios: number;
  primeraVez: string | null;
  ultimaVez: string | null;
  url: string;
}

export interface SentryResumen {
  sinResolver: number;
  nuevos24h: number;
  /** Eventos de error por día, 14 días, el más viejo primero. */
  serie14d: number[];
  /** Igual, 90 días: la barra de estado. Los docs de antes del cambio no la traen. */
  serie90d: number[];
  top: SentryIssue[];
  /** Resueltos o ignorados con actividad en 14 días, los más recientes primero. */
  resueltos: SentryIssue[];
  /** 0–1. Solo las apps reportan sesiones; el resto, null. */
  crashFree: number | null;
}

export interface SentryProyecto {
  slug: string;
  url: string;
  /** Solo producción: es lo que le pega a usuarios reales. */
  produccion: SentryResumen;
  revisadoAt: string | null;
  /** Alta del proyecto en Sentry: antes de eso no hay datos, no "cero errores". */
  creadoEn: string | null;
}

/** A partir de aquí la pestaña abierta pide otra corrida del sync. */
export const REFRESCAR_MS = 10 * 60_000;
/** Pasado esto el dato se marca como viejo: el sync no está corriendo. */
export const VIEJO_MS = 60 * 60_000;

const iso = (v: unknown): string | null => {
  const conFecha = v as { toDate?: () => Date } | undefined;
  return conFecha?.toDate ? conFecha.toDate().toISOString() : typeof v === "string" ? v : null;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function resumenDe(x: unknown): SentryResumen {
  const r = (x ?? {}) as Record<string, unknown>;
  return {
    sinResolver: num(r.sinResolver),
    nuevos24h: num(r.nuevos24h),
    serie14d: Array.isArray(r.serie14d) ? r.serie14d.map(num) : [],
    serie90d: Array.isArray(r.serie90d) ? r.serie90d.map(num) : [],
    top: Array.isArray(r.top) ? (r.top as SentryIssue[]) : [],
    resueltos: Array.isArray(r.resueltos) ? (r.resueltos as SentryIssue[]) : [],
    crashFree: typeof r.crashFree === "number" ? r.crashFree : null,
  };
}

/**
 * Un doc por repo permitido, no la colección entera: las reglas deciden doc por
 * doc, y una consulta que incluyera uno ajeno se negaría completa. El repo que
 * no tiene proyecto en Sentry (o que las reglas niegan) simplemente no sale.
 */
export async function getSentryProyectos(slugs: string[]): Promise<SentryProyecto[]> {
  const docs = await Promise.all(
    slugs.map((slug) => getDoc(doc(db, "sentry", slug)).catch(() => null)),
  );
  return docs.flatMap((d) => {
    if (!d?.exists()) return [];
    const x = d.data();
    const entornos = (x.entornos ?? {}) as Record<string, unknown>;
    return [{
      slug: d.id,
      url: typeof x.url === "string" ? x.url : `https://${SENTRY_ORG}.sentry.io/issues/`,
      produccion: resumenDe(entornos.produccion),
      revisadoAt: iso(x.revisadoAt),
      creadoEn: iso(x.sentryCreadoEn),
    }];
  });
}

/**
 * DSN del proyecto de Sentry del repo, para instalar el SDK. Lo escribe el sync
 * al prender el monitoreo; null mientras no corra (o si las reglas no dejan).
 */
export async function getSentryDsn(slug: string): Promise<string | null> {
  const d = await getDoc(doc(db, "sentry", slug)).catch(() => null);
  const dsn = d?.exists() ? d.data().dsn : null;
  return typeof dsn === "string" && dsn ? dsn : null;
}

export const estaViejo = (p: SentryProyecto) =>
  !p.revisadoAt || Date.now() - new Date(p.revisadoAt).getTime() > VIEJO_MS;

export const pideRevision = (ps: SentryProyecto[]) =>
  ps.length === 0 || ps.some((p) => !p.revisadoAt || Date.now() - new Date(p.revisadoAt).getTime() > REFRESCAR_MS);

const SYNC_URL =
  "https://api.github.com/repos/jorge-mendoza-corella/sozu-dashboard-seguimiento-cambios/actions/workflows/sentry-sync.yml/dispatches";
const MARCA_DISPARO = "sentry:ultimoDisparo";

/**
 * Dispara el sync (workflow_dispatch), como mucho una vez cada REFRESCAR_MS
 * entre todas las pestañas. Mismo esquema que el monitor de WhatsApp: el cron
 * de GitHub casi nunca corre en este repo.
 */
export async function dispararSyncSentry(forzar = false): Promise<boolean> {
  const token = import.meta.env.VITE_GITHUB_REVIEWER_TOKEN || import.meta.env.VITE_GITHUB_TOKEN;
  if (!token) return false;
  try {
    const ultimo = Number(localStorage.getItem(MARCA_DISPARO) ?? 0);
    // El botón "Actualizar" se salta el tope, pero no dos veces en el mismo minuto.
    if (Date.now() - ultimo < (forzar ? 60_000 : REFRESCAR_MS)) return false;
    localStorage.setItem(MARCA_DISPARO, String(Date.now()));
  } catch {
    // Sin localStorage se dispara igual: peor una corrida de más que un dato viejo.
  }
  return fetch(SYNC_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  }).then((r) => r.ok).catch(() => false);
}

// --- Detalle y estado de un issue (Cloud Functions: el token no sale de ahí) --

export type EstadoIssue = "resolved" | "ignored" | "unresolved";

export interface FrameIssue {
  archivo: string;
  funcion: string;
  linea: number | null;
  columna: number | null;
  /** Código del repo (no de una librería ni del runtime). */
  propio: boolean;
  contexto: { n: number; l: string }[];
}

export interface DetalleIssue {
  id: string;
  slug: string;
  shortId: string;
  titulo: string;
  culprit: string;
  nivel: string;
  estado: string;
  eventos: number;
  usuarios: number;
  primeraVez: string | null;
  ultimaVez: string | null;
  url: string;
  evento: {
    id: string;
    fecha: string | null;
    release: string | null;
    mensaje: string;
    url: string | null;
    metodo: string | null;
    navegador: string | null;
    sistema: string | null;
    dispositivo: string | null;
    runtime: string | null;
    excepciones: { tipo: string; valor: string; mecanismo: string; manejado: boolean; frames: FrameIssue[] }[];
    tags: { clave: string; valor: string }[];
  };
  /** Ticket del portal ya levantado para este issue (uno por issue), con su etapa. */
  ticket: (TicketIssue & { etapa: string | null; resuelto: boolean }) | null;
}

export interface TicketIssue {
  numero: number;
  ticketId: number;
  url: string;
  creadoPor: string;
}

const functions = getFunctions(app, "us-central1");
const llamarDetalle = httpsCallable<{ issueId: string }, DetalleIssue>(functions, "sentryDetalleIssue", { timeout: 30_000 });
const llamarEstado = httpsCallable<{ issueId: string; estado: EstadoIssue }, { ok: true; estado: EstadoIssue }>(functions, "sentryCambiarIssue", { timeout: 30_000 });

const llamarTicket = httpsCallable<{ issueId: string }, TicketIssue & { actualizado: boolean }>(functions, "sentryCrearTicket", { timeout: 60_000 });

export const crearTicketIssue = async (issueId: string) => (await llamarTicket({ issueId })).data;

/**
 * Prompt para pegar en Claude Code dentro del repo: el error con su stack trace
 * (con las líneas de código que manda Sentry) y qué se espera que haga.
 */
export function promptClaude(d: DetalleIssue, repo: string): string {
  const e = d.evento;
  const l: string[] = [
    `# Error de producción en ${repo} (Sentry ${d.shortId})`,
    "",
    `**${d.titulo}**${d.culprit ? ` — en \`${d.culprit}\`` : ""}`,
    "",
    `- Nivel: ${d.nivel} · Eventos: ${d.eventos} · Usuarios afectados: ${d.usuarios}`,
    `- Primera vez: ${d.primeraVez ?? "—"} · Última vez: ${d.ultimaVez ?? "—"}`,
  ];
  const entorno = [
    ["URL", e.url ? `${e.metodo ? `${e.metodo} ` : ""}${e.url}` : null],
    ["Navegador", e.navegador], ["Sistema", e.sistema], ["Dispositivo", e.dispositivo],
    ["Runtime", e.runtime], ["Release", e.release],
  ].filter(([, v]) => v);
  for (const [k, v] of entorno) l.push(`- ${k}: ${v}`);
  for (const x of e.excepciones) {
    l.push("", `## Stack trace: ${x.tipo}${x.valor ? `: ${x.valor}` : ""}`, "", "Del frame donde reventó hacia afuera:", "");
    const propios = x.frames.filter((f) => f.propio);
    for (const f of (propios.length ? propios : x.frames).slice(0, 15)) {
      const lugar = `${f.archivo || "?"}${f.linea !== null ? `:${f.linea}` : ""}${f.columna !== null ? `:${f.columna}` : ""}`;
      l.push(`- \`${lugar}\`${f.funcion ? ` en \`${f.funcion}\`` : ""}`);
      if (f.contexto.length) {
        l.push("  ```");
        for (const c of f.contexto) l.push(`  ${c.n === f.linea ? ">" : " "} ${String(c.n).padStart(4)} ${c.l}`);
        l.push("  ```");
      }
    }
  }
  if (e.tags.length) l.push("", `Tags: ${e.tags.map((t) => `${t.clave}=${t.valor}`).join(", ")}`);
  l.push(
    "",
    `Sentry: ${d.url}`,
    "",
    "## Qué hacer",
    "1. Encuentra en este repo la causa del error (los archivos del stack trace pueden venir minificados: ubica el código equivalente).",
    "2. Corrígelo con el cambio mínimo y agrega una prueba que cubra el caso.",
    `3. Abre un PR hacia \`dev\`${d.ticket ? ` con \`SOZU-${d.ticket.numero}\` en el título (ticket del portal)` : ""} y menciona ${d.shortId} en la descripción.`,
  );
  return l.join("\n");
}

export const getDetalleIssue = async (issueId: string) => (await llamarDetalle({ issueId })).data;
export const cambiarEstadoIssue = async (issueId: string, estado: EstadoIssue) => (await llamarEstado({ issueId, estado })).data;
