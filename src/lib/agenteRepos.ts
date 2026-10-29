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
import { esSkin, setCorreosAvatar, setNombresAvatar, setSkinGeorgIA, setSkinPropio, SKIN_DEFAULT, type Skin } from "@/components/agente/skinsDatos";
import type { PartidoSeleccion } from "@/components/agente/escenasDatos";

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
  /** Imágenes, audios y videos que la persona mandó con la pregunta. */
  adjuntos?: AdjuntoChat[];
  error?: boolean;
}

/** Adjunto de una pregunta: audio y video llegan ya transcritos (y el video con cuadros). */
export interface AdjuntoChat {
  tipo: "imagen" | "audio" | "video" | "documento";
  nombre: string;
  url: string;
  transcripcion?: string | null;
  cuadros?: string[];
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

const llamar = httpsCallable<{ conversacionId: string | null; mensaje: string; adjuntos?: AdjuntoChat[] }, RespuestaAgente, ChunkAgente>(
  functions,
  "agenteRepos",
  { timeout: 540_000 },
);

const llamarDoc = httpsCallable<{ ruta: string }, DocumentoAgente>(functions, "agenteDoc");
const llamarProcesar = httpsCallable<{ url: string; tipo: "audio" | "video" }, { transcripcion: string | null; cuadros: string[] }>(
  functions, "agenteProcesarAdjunto", { timeout: 540_000 },
);

/** Transcribe un audio/video ya subido (y saca cuadros del video) para GeorgIA. */
export async function procesarAdjunto(url: string, tipo: "audio" | "video") {
  return (await llamarProcesar({ url, tipo })).data;
}

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
  adjuntos: AdjuntoChat[] = [],
): Promise<RespuestaAgente> {
  const { stream, data } = await llamar.stream({ conversacionId, mensaje, ...(adjuntos.length ? { adjuntos } : {}) }, { signal });
  for await (const c of stream) alTrozo(c);
  return data;
}

/** Mensaje entendible a partir del error del callable (`functions/<código>`). */
export function mensajeDeError(e: unknown): string {
  const code = (e as { code?: string }).code ?? "";
  const msg = (e as { message?: string }).message ?? "";
  if (code.endsWith("permission-denied")) return msg || "No tienes acceso a GeorgIA.";
  if (code.endsWith("resource-exhausted")) return msg || "Llegaste al límite de preguntas por hora.";
  if (code.endsWith("invalid-argument")) return msg;
  if (code.endsWith("unauthenticated")) return "Tu sesión expiró. Vuelve a iniciar sesión.";
  if (code.endsWith("deadline-exceeded")) return "La respuesta tardó demasiado. Intenta con una pregunta más acotada.";
  if (code.endsWith("unavailable") || code.endsWith("failed-precondition")) return msg || "No se pudo completar. Intenta de nuevo.";
  if (!code && msg) return msg;
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
  /** Manda tickets a Claude Code y le contesta (requiere tickets). */
  claude: boolean;
  /** Manda mensajes que gritan los avatares de los demás (requiere agente). */
  megafono?: boolean;
  /** Su avatar habla en voz alta (requiere agente). */
  voz?: boolean;
}

const listaDe = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];

/**
 * Permisos de quien está logueado. El root tiene los dos; el resto, lo que
 * digan las listas (las reglas solo le dejan leer el doc si está en alguna,
 * así que un error = sin nada).
 */
export async function permisosAgente(email: string | null | undefined): Promise<PermisosAgente> {
  const nada = { agente: false, docs: false, tickets: false, claude: false };
  if (!email) return nada;
  const esRoot = email === SUPERUSER_EMAIL;
  try {
    // El avatar propio no depende del acceso: se lee aparte y sin bloquear.
    void leerSkinPropio(email);
    const d = (await getDoc(ACCESO())).data();
    // Apariencia general de Configuración → GeorgIA (el default de todos).
    setSkinGeorgIA(esSkin(d?.skin) ? d.skin : SKIN_DEFAULT);
    // Correo de cada avatar (quien levanta el ticket).
    setCorreosAvatar(d?.correosAvatar);
    setNombresAvatar(d?.nombresAvatar);
    const agente = esRoot || listaDe(d?.emails).includes(email);
    const p = {
      agente,
      docs: esRoot || listaDe(d?.docs).includes(email),
      // El root lo tiene prendido salvo que lo haya apagado.
      tickets: esRoot ? !listaDe(d?.ticketsApagados).includes(email) : agente && listaDe(d?.tickets).includes(email),
    };
    return {
      ...p,
      claude: esRoot || (p.tickets && listaDe(d?.claude).includes(email)),
      megafono: esRoot || (agente && listaDe(d?.megafono).includes(email)),
      // Sin el root de regalo: la voz se prende a mano, también para él.
      voz: agente && listaDe(d?.voz).includes(email),
    };
  } catch {
    // Sin doc (o sin poder leerlo) el root conserva todo por default.
    return esRoot ? { agente: true, docs: true, tickets: true, claude: true, megafono: true } : nada;
  }
}

export interface AccesoAgente {
  emails: string[];
  /** Personas dadas de alta con GeorgIA apagada: siguen en la tabla, sin usarla. */
  sinAgente: string[];
  docs: string[];
  tickets: string[];
  /** Mandan tickets a Claude Code. */
  claude: string[];
  /** Mandan mensajes con el megáfono. */
  megafono: string[];
  /** Su avatar habla en voz alta. */
  voz: string[];
  ticketsApagados: string[];
}

/** Listas completas (solo el root puede leerlas). */
export async function leerAccesoAgente(): Promise<AccesoAgente> {
  const d = (await getDoc(ACCESO())).data();
  return {
    emails: listaDe(d?.emails).sort(),
    sinAgente: listaDe(d?.sinAgente),
    docs: listaDe(d?.docs),
    tickets: listaDe(d?.tickets),
    claude: listaDe(d?.claude),
    megafono: listaDe(d?.megafono),
    voz: listaDe(d?.voz),
    ticketsApagados: listaDe(d?.ticketsApagados),
  };
}

export async function darAccesoAgente(email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  await setDoc(ACCESO(), { emails: arrayUnion(e), sinAgente: arrayRemove(e) }, { merge: true });
}

/** Quitar a la persona de la tabla: se va de todas las listas. */
export async function quitarAccesoAgente(email: string): Promise<void> {
  await updateDoc(ACCESO(), {
    emails: arrayRemove(email), sinAgente: arrayRemove(email), docs: arrayRemove(email), tickets: arrayRemove(email),
    claude: arrayRemove(email),
  });
}

/**
 * Prende o apaga GeorgIA sin sacar a la persona de la tabla. Ver docs y
 * Tickets se conservan, pero sin GeorgIA no aplican (ni el avatar se ve).
 */
export async function cambiarAgente(email: string, activar: boolean): Promise<void> {
  await setDoc(ACCESO(), activar
    ? { emails: arrayUnion(email), sinAgente: arrayRemove(email) }
    : { emails: arrayRemove(email), sinAgente: arrayUnion(email) }, { merge: true });
}

/** Cambia la apariencia de GeorgIA para todos (solo el root puede escribir el doc). */
export async function cambiarSkin(skin: Skin): Promise<void> {
  await setDoc(ACCESO(), { skin }, { merge: true });
  setSkinGeorgIA(skin);
}

// ── Avatar propio (agente_skins/{email}) ────────────────────────────────────
const SKIN_PROPIO = (email: string) => doc(db, "agente_skins", email);

async function leerSkinPropio(email: string): Promise<void> {
  try {
    const s = (await getDoc(SKIN_PROPIO(email))).data()?.skin;
    setSkinPropio(esSkin(s) ? s : null);
  } catch {
    setSkinPropio(null);
  }
}

/** Avatar de quien está logueado; `null` vuelve al general. */
export async function cambiarSkinPropio(email: string, skin: Skin | null): Promise<void> {
  if (skin) await setDoc(SKIN_PROPIO(email), { skin });
  else await deleteDoc(SKIN_PROPIO(email));
  setSkinPropio(skin);
}

/** Avatar elegido por cada persona (solo el root puede listarlos). Sin entrada = usa el general. */
export async function leerSkinsPorPersona(): Promise<Record<string, Skin>> {
  const snap = await getDocs(collection(db, "agente_skins"));
  const r: Record<string, Skin> = {};
  snap.forEach((d) => { const s = d.data().skin; if (esSkin(s)) r[d.id] = s; });
  return r;
}

/** Correo de la persona que "es" un avatar ("" = ninguno). Solo el root escribe el doc. */
export async function cambiarCorreoAvatar(skin: Skin, correo: string): Promise<void> {
  const c = correo.trim().toLowerCase();
  const d = (await getDoc(ACCESO())).data();
  const actuales = (d?.correosAvatar ?? {}) as Record<string, unknown>;
  const nuevos = { ...actuales, [skin]: c };
  await setDoc(ACCESO(), { correosAvatar: nuevos }, { merge: true });
  setCorreosAvatar(nuevos);
}

/** Nombre visible de un avatar ("" = el del catálogo). Solo el root escribe el doc. */
export async function cambiarNombreAvatar(skin: Skin, nombre: string): Promise<void> {
  const d = (await getDoc(ACCESO())).data();
  const nuevos = { ...((d?.nombresAvatar ?? {}) as Record<string, unknown>), [skin]: nombre.trim().slice(0, 40) };
  await setDoc(ACCESO(), { nombresAvatar: nuevos }, { merge: true });
  setNombresAvatar(nuevos);
}

export async function cambiarTickets(email: string, activar: boolean): Promise<void> {
  // El root va al revés: prendido por default, se guarda cuando lo APAGA.
  if (email === SUPERUSER_EMAIL) {
    await setDoc(ACCESO(), { ticketsApagados: activar ? arrayRemove(email) : arrayUnion(email) }, { merge: true });
    return;
  }
  await setDoc(ACCESO(), { tickets: activar ? arrayUnion(email) : arrayRemove(email) }, { merge: true });
}

/** Voz del avatar: que hable en voz alta para esta persona (requiere GeorgIA). */
export async function cambiarVoz(email: string, activar: boolean): Promise<void> {
  await setDoc(ACCESO(), { voz: activar ? arrayUnion(email) : arrayRemove(email) }, { merge: true });
}

/** Megáfono: mandar mensajes que gritan los avatares (requiere GeorgIA). */
export async function cambiarMegafono(email: string, permitir: boolean): Promise<void> {
  await setDoc(ACCESO(), { megafono: permitir ? arrayUnion(email) : arrayRemove(email) }, { merge: true });
}

/** Mandar tickets a Claude Code (requiere Tickets). El root lo tiene siempre. */
export async function cambiarClaude(email: string, permitir: boolean): Promise<void> {
  await setDoc(ACCESO(), { claude: permitir ? arrayUnion(email) : arrayRemove(email) }, { merge: true });
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
      ...(Array.isArray(m.adjuntos) && m.adjuntos.length ? { adjuntos: m.adjuntos as AdjuntoChat[] } : {}),
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

/** Partidos de la Selección que dejó el sync mensual (`agente_partidos/seleccion.raw`). */
export async function cargarPartidosSeleccion(): Promise<PartidoSeleccion[]> {
  const raw = (await getDoc(doc(db, "agente_partidos", "seleccion"))).data()?.raw;
  if (typeof raw !== "string") return [];
  const lista = JSON.parse(raw);
  return Array.isArray(lista) ? lista : [];
}
