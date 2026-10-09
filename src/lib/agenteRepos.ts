/**
 * Agente de repos: cliente de la Cloud Function `agenteRepos` y lectura del
 * historial en Firestore.
 *
 * La función es la que manda: valida la sesión y el permiso, llama al modelo,
 * guarda pregunta y respuesta. Desde aquí solo se leen las conversaciones
 * propias (las reglas no dejan ver otras), se renombran, fijan o borran.
 *
 * Acceso: `agente_config/acceso.emails` + el root. Ver functions/src/agente/acceso.ts.
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
  restantes: number;
}

const llamar = httpsCallable<{ conversacionId: string | null; mensaje: string }, RespuestaAgente, ChunkAgente>(
  functions,
  "agenteRepos",
  { timeout: 540_000 },
);

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

/**
 * ¿Pinta el botón? El root siempre; el resto si está en la lista (las reglas
 * solo le dejan leer el doc en ese caso, así que un error = sin acceso).
 */
export async function tieneAccesoAgente(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  if (email === SUPERUSER_EMAIL) return true;
  try {
    const snap = await getDoc(ACCESO());
    const emails = snap.data()?.emails;
    return Array.isArray(emails) && emails.includes(email);
  } catch {
    return false;
  }
}

/** Lista de correos con acceso (solo el root puede leerla completa). */
export async function leerAccesoAgente(): Promise<string[]> {
  const snap = await getDoc(ACCESO());
  const emails = snap.data()?.emails;
  return Array.isArray(emails) ? emails.filter((e): e is string => typeof e === "string").sort() : [];
}

export async function darAccesoAgente(email: string): Promise<void> {
  await setDoc(ACCESO(), { emails: arrayUnion(email.trim().toLowerCase()) }, { merge: true });
}

export async function quitarAccesoAgente(email: string): Promise<void> {
  await updateDoc(ACCESO(), { emails: arrayRemove(email) });
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
