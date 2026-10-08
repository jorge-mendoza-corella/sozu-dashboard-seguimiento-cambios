import { collection, getDocs } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Si la instancia de WhatsApp (Evolution API) de cada empresa sigue conectada.
//
// Todos los avisos salen por n8n hacia Evolution, y cuando la sesión de WhatsApp
// se cae n8n sigue aceptando las peticiones: los mensajes dejan de llegar sin
// que nada lo diga. `ci/whatsapp_status_sync.py` le pregunta a Evolution cada
// cinco minutos y lo deja en `whatsappStatus/{clientId}`; aquí solo se lee.
// ---------------------------------------------------------------------------

export type EstadoWhatsapp =
  | "conectado"
  | "conectando"
  | "desconectado"
  | "error"
  | "sinConfigurar"
  | "apagado";

export interface WhatsappStatus {
  clientId: string;
  empresa: string;
  instancia: string;
  estado: EstadoWhatsapp;
  /** Explicación de lo que no sea "conectado". */
  detalle: string;
  /** Desde cuándo está en el estado actual. */
  desde: string | null;
  /** Última vez que el monitor revisó. */
  revisadoAt: string | null;
  /** Última vez que se vio conectada. */
  ultimaConexion: string | null;
}

/**
 * A partir de aquí se pide una revisión nueva. El cron dice "cada 5 min", pero
 * GitHub descarta casi todos esos disparos en este repo (las corridas reales
 * llegan cada varias horas), así que quien mantiene el dato fresco es la propia
 * pestaña: si lo que hay es más viejo que esto, dispara el workflow.
 */
export const REFRESCAR_MS = 6 * 60_000;

/**
 * Pasado este tiempo el estado guardado ya no se presenta como actual: ni
 * verde ni rojo, "sin revisar". Con la pestaña disparando la revisión, llegar
 * aquí quiere decir que el workflow no está corriendo.
 */
export const VIEJO_MS = 60 * 60_000;

const iso = (v: unknown): string | null => {
  const conFecha = v as { toDate?: () => Date } | undefined;
  return conFecha?.toDate ? conFecha.toDate().toISOString() : typeof v === "string" ? v : null;
};

export async function getWhatsappStatuses(): Promise<WhatsappStatus[]> {
  const snap = await getDocs(collection(db, "whatsappStatus"));
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      clientId: d.id,
      empresa: typeof x.empresa === "string" ? x.empresa : "",
      instancia: typeof x.instancia === "string" ? x.instancia : "",
      estado: (x.estado ?? "error") as EstadoWhatsapp,
      detalle: typeof x.detalle === "string" ? x.detalle : "",
      desde: iso(x.desde),
      revisadoAt: iso(x.revisadoAt),
      ultimaConexion: iso(x.ultimaConexion),
    };
  });
}

/** Revisado hace demasiado: el estado guardado ya no es de fiar. */
export const estaViejo = (s: WhatsappStatus) =>
  !s.revisadoAt || Date.now() - new Date(s.revisadoAt).getTime() > VIEJO_MS;

/** Algún estado necesita revisión nueva. */
export const pideRevision = (ss: WhatsappStatus[]) =>
  ss.some((s) => !s.revisadoAt || Date.now() - new Date(s.revisadoAt).getTime() > REFRESCAR_MS);

const SYNC_URL =
  "https://api.github.com/repos/jorge-mendoza-corella/sozu-dashboard-seguimiento-cambios/actions/workflows/whatsapp-status-sync.yml/dispatches";
const MARCA_DISPARO = "whatsappStatus:ultimoDisparo";

/**
 * Dispara el monitor (workflow_dispatch). Como mucho una vez cada
 * REFRESCAR_MS entre TODAS las pestañas: la marca va en localStorage para que
 * cinco pestañas abiertas no lancen cinco corridas.
 */
export async function dispararRevisionWhatsapp(): Promise<void> {
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
