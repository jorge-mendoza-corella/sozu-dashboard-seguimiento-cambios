/**
 * Avisos (antes «Megáfono»): conversaciones 1 a 1 en `agente_avisos/{id}`. Las
 * escribe la función `agenteMegafono` (revisa permisos); aquí se escuchan las
 * propias con onSnapshot (las reglas solo dejan leer a los dos participantes).
 * El panel le pasa al avatar lo que le toca a uno con `EVENTO_AVISO`.
 */
import { getFunctions, httpsCallable } from "firebase/functions";
import { collection, doc, getDoc, onSnapshot, orderBy, query, where, type Timestamp } from "firebase/firestore";
import { app, db } from "./firebase";

export type Destinatario = { email: string; nombre: string };

export interface ResumenMensaje {
  id: string;
  de: string;
  deNombre: string;
  skin: string | null;
  texto: string;
  voz: boolean;
  conAudio: boolean;
  creadoEn: Date | null;
}

export interface Conversacion {
  id: string;
  lote: string;
  de: string;
  deNombre: string;
  deSkin: string | null;
  para: string;
  paraNombre: string;
  creadoEn: Date | null;
  actualizadoEn: Date | null;
  cerrada: boolean;
  cerradaPor: string | null;
  /** A quién le toca contestar (null si ya terminó). */
  pendientePara: string | null;
  ultimo: ResumenMensaje;
  /** Id del último mensaje que el avatar del otro ya gritó (o se leyó en el panel). */
  entregadoId: string | null;
  entregadoEn: Date | null;
  mensajes: number;
}

export interface MensajeAviso extends Omit<ResumenMensaje, "conAudio"> {
  audio?: string;
}

/** Lo que el avatar va a gritar (lo despacha el panel, lo escucha AgenteVolador). */
export interface AvisoParaAvatar {
  convId: string;
  msgId: string;
  deNombre: string;
  /** Avatar de quien lo manda: es el que entra a la pantalla a gritarlo. */
  deSkin: string | null;
  texto: string;
  audio?: string;
  voz: boolean;
  /** Ya se había gritado; se repite porque sigue sin contestar. */
  recordatorio: boolean;
}

export const EVENTO_AVISO = "agente:aviso";
/** El avatar ya lo gritó: el panel lo marca como entregado. */
export const EVENTO_AVISO_ENTREGADO = "agente:aviso-entregado";

const llamar = httpsCallable<
  { accion?: string; id?: string; msgId?: string; texto?: string; audio?: string; para?: string[]; skin?: string; voz?: boolean },
  { destinatarios?: Destinatario[]; enviados?: number; ok?: true }
>(getFunctions(app, "us-central1"), "agenteMegafono", { timeout: 30_000 });

export async function destinatariosAvisos(): Promise<Destinatario[]> {
  return (await llamar({ accion: "destinatarios" })).data.destinatarios ?? [];
}

type Contenido = { texto: string; audio?: string; skin?: string; voz?: boolean };
const contenido = ({ texto, audio, skin, voz }: Contenido) => ({ texto, voz: !!voz, ...(audio ? { audio } : {}), ...(skin ? { skin } : {}) });

/** Abre una conversación con cada quien de `para` (correos, o ["todos"]). */
export async function iniciarAviso(para: string[], c: Contenido): Promise<number> {
  return (await llamar({ accion: "iniciar", para, ...contenido(c) })).data.enviados ?? 0;
}

export async function responderAviso(id: string, c: Contenido): Promise<void> {
  await llamar({ accion: "responder", id, ...contenido(c) });
}

export async function marcarEntregado(id: string, msgId: string): Promise<void> {
  await llamar({ accion: "entregado", id, msgId });
}

export async function terminarAviso(id: string): Promise<void> {
  await llamar({ accion: "terminar", id });
}

const fecha = (v: unknown) => ((v as Timestamp | null)?.toDate?.() ?? null);

function resumen(id: string, d: Record<string, unknown> | undefined): ResumenMensaje {
  return {
    id,
    de: String(d?.de ?? ""),
    deNombre: String(d?.deNombre ?? ""),
    skin: typeof d?.skin === "string" ? d.skin : null,
    texto: String(d?.texto ?? ""),
    voz: d?.voz === true,
    conAudio: d?.conAudio === true || typeof d?.audio === "string",
    creadoEn: fecha(d?.creadoEn),
  };
}

/** Mis conversaciones (mandadas y recibidas), la más reciente primero. */
export function escucharConversaciones(email: string, alCambiar: (cs: Conversacion[]) => void): () => void {
  // Sin orderBy: con array-contains pediría un índice compuesto. Se ordena aquí.
  const q = query(collection(db, "agente_avisos"), where("participantes", "array-contains", email));
  return onSnapshot(q, (snap) => {
    const cs = snap.docs.map((c): Conversacion => {
      const d = c.data();
      const u = (d.ultimo ?? {}) as Record<string, unknown>;
      return {
        id: c.id,
        lote: String(d.lote ?? c.id),
        de: String(d.de ?? ""),
        deNombre: String(d.deNombre ?? ""),
        deSkin: typeof d.deSkin === "string" ? d.deSkin : null,
        para: String(d.para ?? ""),
        paraNombre: String(d.paraNombre ?? ""),
        creadoEn: fecha(d.creadoEn),
        actualizadoEn: fecha(d.actualizadoEn),
        cerrada: d.cerrada === true,
        cerradaPor: typeof d.cerradaPor === "string" ? d.cerradaPor : null,
        pendientePara: typeof d.pendientePara === "string" ? d.pendientePara : null,
        ultimo: resumen(String(u.id ?? ""), u),
        entregadoId: typeof d.entregadoId === "string" ? d.entregadoId : null,
        entregadoEn: fecha(d.entregadoEn),
        mensajes: Number(d.mensajes ?? 1),
      };
    });
    cs.sort((a, b) => (b.actualizadoEn?.getTime() ?? Date.now()) - (a.actualizadoEn?.getTime() ?? Date.now()));
    alCambiar(cs);
  }, () => alCambiar([]));
}

/** Los mensajes de una conversación, en orden. */
export function escucharMensajes(id: string, alCambiar: (ms: MensajeAviso[]) => void): () => void {
  const q = query(collection(db, `agente_avisos/${id}/mensajes`), orderBy("creadoEn"));
  return onSnapshot(q, (snap) => alCambiar(snap.docs.map((m) => {
    const d = m.data();
    return { ...resumen(m.id, d), audio: typeof d.audio === "string" ? d.audio : undefined };
  })), () => {});
}

/** El audio de un mensaje (el resumen de la conversación no lo trae). */
export async function audioDe(convId: string, msgId: string): Promise<string | undefined> {
  const d = (await getDoc(doc(db, `agente_avisos/${convId}/mensajes/${msgId}`))).data();
  return typeof d?.audio === "string" ? d.audio : undefined;
}

/** Con quién es la conversación, visto desde `yo`. */
export const otroDe = (c: Conversacion, yo: string) =>
  c.de === yo ? { email: c.para, nombre: c.paraNombre } : { email: c.de, nombre: c.deNombre };
