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
 * Pasado este tiempo sin revisión, el dato ya no dice nada del presente. El
 * cron pide cada 5 min pero GitHub a veces se atrasa: 20 min deja margen sin
 * pintar de verde algo que lleva una hora sin mirarse.
 */
export const VIEJO_MS = 20 * 60_000;

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
