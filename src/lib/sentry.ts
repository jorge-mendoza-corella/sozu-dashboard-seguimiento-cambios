import { collection, getDocs } from "firebase/firestore";
import { db } from "./firebase";
import { resolvePermissions, type AppUser } from "./firestoreUsers";

// ---------------------------------------------------------------------------
// Errores de Sentry por proyecto (pestaña Monitoreo).
//
// El token de Sentry lee los errores de toda la organización y no viaja al
// navegador: `ci/sentry_sync.py` los resume en `sentry/{projectSlug}` y aquí
// solo se lee eso. El slug de cada proyecto de Sentry es el nombre del repo.
// ---------------------------------------------------------------------------

export const SENTRY_ORG = "sozu-lh";
/** Empresa dueña de los repos que se monitorean (Sozu). */
export const SENTRY_CLIENT_ID = "kX60JlcDL2p2EFlsi9HT";

/**
 * ¿Abre la pestaña? Permiso general `verMonitoreo` y ser de Sozu (o admin
 * global): el admin de otra empresa trae todos los permisos por default y no
 * tiene por qué ver los errores de los repos de Sozu. Mismo corte que las
 * reglas de `sentry/*`.
 */
export function veMonitoreo(user: AppUser | null): boolean {
  if (!user) return false;
  if (user.role === "superuser") return true;
  return (user.clientIds ?? []).includes(SENTRY_CLIENT_ID) && resolvePermissions(user).verMonitoreo;
}

export interface SentryIssue {
  id: string;
  shortId: string;
  titulo: string;
  culprit: string;
  nivel: string;
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
  top: SentryIssue[];
  /** 0–1. Solo las apps reportan sesiones; el resto, null. */
  crashFree: number | null;
}

export type Entorno = "produccion" | "todos";

export interface SentryProyecto {
  slug: string;
  url: string;
  entornos: Record<Entorno, SentryResumen>;
  revisadoAt: string | null;
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
    top: Array.isArray(r.top) ? (r.top as SentryIssue[]) : [],
    crashFree: typeof r.crashFree === "number" ? r.crashFree : null,
  };
}

export async function getSentryProyectos(): Promise<SentryProyecto[]> {
  const snap = await getDocs(collection(db, "sentry"));
  return snap.docs.map((d) => {
    const x = d.data();
    const entornos = (x.entornos ?? {}) as Record<string, unknown>;
    return {
      slug: d.id,
      url: typeof x.url === "string" ? x.url : `https://${SENTRY_ORG}.sentry.io/issues/`,
      entornos: { produccion: resumenDe(entornos.produccion), todos: resumenDe(entornos.todos) },
      revisadoAt: iso(x.revisadoAt),
    };
  });
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
export async function dispararSyncSentry(): Promise<void> {
  const token = import.meta.env.VITE_GITHUB_REVIEWER_TOKEN || import.meta.env.VITE_GITHUB_TOKEN;
  if (!token) return;
  try {
    const ultimo = Number(localStorage.getItem(MARCA_DISPARO) ?? 0);
    if (Date.now() - ultimo < REFRESCAR_MS) return;
    localStorage.setItem(MARCA_DISPARO, String(Date.now()));
  } catch {
    // Sin localStorage se dispara igual: peor una corrida de más que un dato viejo.
  }
  await fetch(SYNC_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  }).catch(() => undefined);
}
