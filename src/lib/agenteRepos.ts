/**
 * Agente de repos: cliente de la Cloud Function `agenteRepos` y lectura del
 * historial en Firestore.
 *
 * La función es la que manda: valida la sesión y el permiso, llama al modelo,
 * guarda pregunta y respuesta. Desde aquí solo se leen las conversaciones
 * propias (las reglas no dejan ver otras), se renombran, fijan o borran.
 *
 * Acceso: `agente_config/acceso.emails` (usar el agente) y `.docs` (abrir los
 * documentos que cita) + el root, que tiene los dos. Ver functions/src/agente/acceso.ts.
 */
import { getFunctions, httpsCallable } from "firebase/functions";
import {
  arrayRemove, arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, orderBy, query,
  setDoc, updateDoc, where, type Unsubscribe,
} from "firebase/firestore";
import { app, db } from "./firebase";
import { SUPERUSER_EMAIL } from "./firestoreUsers";

const functions = getFunctions(app, "us-central1");

export const MAX_MENSAJE = 4_000;
export const MAX_TITULO = 80;

export const SUGERENCIAS: readonly string[] = [
  "¿Cómo se registra un pago en el admin y qué tablas toca?",
  "¿Qué hace la edge function ia-guia-portal?",
  "Explícame el flujo de conciliación STP",
  "¿Qué cambió esta semana en sozu-admin?",
];

export interface HerramientaUsada {
  nombre: string;
  etiqueta: string;
}

export interface ConversacionAgente {
  id: string;
  titulo: string;
  fijada: boolean;
  actualizado: Date;
}

export interface MensajeAgente {
  id: string;
  rol: "usuario" | "asistente";
  texto: string;
  herramientas: HerramientaUsada[];
  /** Documentos de sozu-docs que el agente leyó para responder. */
  docs: string[];
  error?: boolean;
}

export type ChunkAgente =
  | { tipo: "texto"; delta: string }
  | { tipo: "herramienta"; nombre: string; etiqueta: string };

export interface RespuestaAgente {
  conversacionId: string;
  mensajeId: string;
  texto: string;
  herramientas: HerramientaUsada[];
  docs: string[];
  restantes: number;
}

export interface DocumentoAgente {
  ruta: string;
  titulo: string;
  texto: string;
  sha: string;
}

const llamar = httpsCallable<{ conversacionId: string | null; mensaje: string }, RespuestaAgente, ChunkAgente>(
  functions,
  "agenteRepos",
  { timeout: 540_000 },
);

const llamarDoc = httpsCallable<{ ruta: string }, DocumentoAgente>(functions, "agenteDoc");

/** Documento completo de sozu-docs (requiere el permiso "Ver documentación"). */
export async function leerDocumento(ruta: string): Promise<DocumentoAgente> {
  return (await llamarDoc({ ruta })).data;
}

/** ¿Parece ruta de sozu-docs? (`user-manual/x.md`, `edge-functions/y.md`). */
export const esRutaDoc = (t: string) => /^(docs\/)?[a-z0-9-]+\/[\w./-]+\.md$/i.test(t.trim());

/** Manda la pregunta y va avisando con cada trozo; resuelve con la respuesta guardada. */
export async function preguntar(
  conversacionId: string | null,
  mensaje: string,
  alTrozo: (c: ChunkAgente) => void,
  signal?: AbortSignal,
): Promise<RespuestaAgente> {
  const { stream, data } = await llamar.stream({ conversacionId, mensaje }, { signal });
  for await (const c of stream) alTrozo(c);
  return data;
}

/** Mensaje entendible a partir del error del callable (`functions/<código>`). */
export function mensajeDeError(e: unknown): string {
  const code = (e as { code?: string }).code ?? "";
  const msg = (e as { message?: string }).message ?? "";
  if (code.endsWith("permission-denied")) return msg || "No tienes acceso al agente.";
  if (code.endsWith("resource-exhausted")) return msg || "Llegaste al límite de preguntas por hora.";
  if (code.endsWith("invalid-argument")) return msg;
  if (code.endsWith("unauthenticated")) return "Tu sesión expiró. Vuelve a iniciar sesión.";
  if (code.endsWith("deadline-exceeded")) return "La respuesta tardó demasiado. Intenta con una pregunta más acotada.";
  return "No se pudo completar la respuesta. Intenta de nuevo.";
}

// ── Acceso ─────────────────────────────────────────────────────────────────

const ACCESO = () => doc(db, "agente_config", "acceso");

export interface PermisosAgente {
  /** Usa el agente (ve el botón). */
  agente: boolean;
  /** Abre los documentos que el agente cita. */
  docs: boolean;
  /** Revisa sus tickets del portal cada 15 min (requiere agente). */
  tickets: boolean;
}

const listaDe = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];

/**
 * Permisos de quien está logueado. El root tiene los dos; el resto, lo que
 * digan las listas (las reglas solo le dejan leer el doc si está en alguna,
 * así que un error = sin nada).
 */
export async function permisosAgente(email: string | null | undefined): Promise<PermisosAgente> {
  const nada = { agente: false, docs: false, tickets: false };
  if (!email) return nada;
  const esRoot = email === SUPERUSER_EMAIL;
  try {
    const d = (await getDoc(ACCESO())).data();
    const agente = esRoot || listaDe(d?.emails).includes(email);
    return {
      agente,
      docs: esRoot || listaDe(d?.docs).includes(email),
      tickets: agente && listaDe(d?.tickets).includes(email),
    };
  } catch {
    // El root siempre puede leer; si falla, al menos el agente y los docs.
    return esRoot ? { agente: true, docs: true, tickets: false } : nada;
  }
}

/** Listas completas (solo el root puede leerlas). */
export async function leerAccesoAgente(): Promise<{ emails: string[]; docs: string[]; tickets: string[] }> {
  const d = (await getDoc(ACCESO())).data();
  return { emails: listaDe(d?.emails).sort(), docs: listaDe(d?.docs), tickets: listaDe(d?.tickets) };
}

export async function darAccesoAgente(email: string): Promise<void> {
  await setDoc(ACCESO(), { emails: arrayUnion(email.trim().toLowerCase()) }, { merge: true });
}

/** Quitar el agente quita también docs y tickets: sin agente no hay dónde verlos. */
export async function quitarAccesoAgente(email: string): Promise<void> {
  await updateDoc(ACCESO(), { emails: arrayRemove(email), docs: arrayRemove(email), tickets: arrayRemove(email) });
}

export async function cambiarTickets(email: string, activar: boolean): Promise<void> {
  await setDoc(ACCESO(), { tickets: activar ? arrayUnion(email) : arrayRemove(email) }, { merge: true });
}

export async function cambiarVerDocs(email: string, permitir: boolean): Promise<void> {
  await setDoc(ACCESO(), { docs: permitir ? arrayUnion(email) : arrayRemove(email) }, { merge: true });
}

// ── Historial ──────────────────────────────────────────────────────────────

const CONVERSACIONES = () => collection(db, "agente_conversaciones");

const fecha = (v: unknown) =>
  v && typeof (v as { toDate?: () => Date }).toDate === "function" ? (v as { toDate: () => Date }).toDate() : new Date();

export function escucharConversaciones(email: string, alCambiar: (c: ConversacionAgente[]) => void): Unsubscribe {
  // Sin `orderBy` en la query: owner + actualizado pediría un índice compuesto
  // y este repo no despliega índices. Son pocas por persona; se ordena aquí.
  const q = query(CONVERSACIONES(), where("owner", "==", email));
  return onSnapshot(
    q,
    (snap) =>
      alCambiar(
        snap.docs.map((d) => ({
          id: d.id,
          titulo: String(d.data().titulo ?? "Conversación"),
          fijada: d.data().fijada === true,
          actualizado: fecha(d.data().actualizado),
        })).sort((a, b) => b.actualizado.getTime() - a.actualizado.getTime()),
      ),
    () => alCambiar([]),
  );
}

export async function leerMensajes(conversacionId: string): Promise<MensajeAgente[]> {
  const snap = await getDocs(query(collection(db, "agente_conversaciones", conversacionId, "mensajes"), orderBy("creado")));
  const out: MensajeAgente[] = [];
  for (const d of snap.docs) {
    const m = d.data();
    if (m.rol !== "usuario" && m.rol !== "asistente") continue;
    // Las respuestas fallidas no se pintan; la pregunta sí se queda.
    if (m.error) continue;
    out.push({
      id: d.id,
      rol: m.rol,
      texto: String(m.texto ?? ""),
      herramientas: Array.isArray(m.herramientas) ? m.herramientas : [],
      docs: listaDe(m.docs),
    });
  }
  return out;
}

export async function renombrarConversacion(c: ConversacionAgente, titulo: string): Promise<void> {
  const t = titulo.trim().slice(0, MAX_TITULO);
  if (!t || t === c.titulo) return;
  await updateDoc(doc(CONVERSACIONES(), c.id), { titulo: t, fijada: c.fijada });
}

export async function fijarConversacion(c: ConversacionAgente): Promise<void> {
  await updateDoc(doc(CONVERSACIONES(), c.id), { titulo: c.titulo, fijada: !c.fijada });
}

/** Borra los mensajes y luego la conversación (Firestore no borra en cascada). */
export async function borrarConversacion(id: string): Promise<void> {
  const mensajes = await getDocs(collection(db, "agente_conversaciones", id, "mensajes"));
  await Promise.all(mensajes.docs.map((m) => deleteDoc(m.ref)));
  await deleteDoc(doc(CONVERSACIONES(), id));
}
