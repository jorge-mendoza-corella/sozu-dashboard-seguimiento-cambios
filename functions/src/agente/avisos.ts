/**
 * Avisos (antes «Megáfono»): quien tiene el permiso abre una conversación con
 * una o varias personas; a cada una le llega por su lado (un hilo 1 a 1 en
 * `agente_avisos/{id}`, con los mensajes en `mensajes/`). El avatar de quien
 * manda entra a la pantalla del otro y lo grita. Cualquiera de los dos puede
 * contestar (texto y/o audio) o dar la conversación por terminada; mientras
 * siga abierta y le toque contestar a alguien, se le vuelve a aparecer.
 *
 * Todo se escribe aquí con permisos de servidor; las reglas solo dejan leer a
 * los dos participantes.
 */
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { SUPERUSER_EMAIL } from "./acceso.js";

const MAX_TEXTO = 500;
/** ~30 s de audio opus en data URL. El doc de Firestore aguanta 1 MB. */
const MAX_AUDIO = 700_000;
const MAX_DESTINOS = 60;
const AVISOS = "agente_avisos";

const lista = (v: unknown): string[] => (Array.isArray(v) ? v.map((e) => String(e).toLowerCase()) : []);

/** Quiénes tienen GeorgIA (los que pueden recibir el mensaje), con su nombre. */
export async function destinatarios(): Promise<{ email: string; nombre: string }[]> {
  const fs = getFirestore();
  const cfg = (await fs.doc("agente_config/acceso").get()).data() ?? {};
  const emails = [...new Set([SUPERUSER_EMAIL, ...lista(cfg.emails)])].filter((e) => !lista(cfg.sinAgente).includes(e));
  const docs = await Promise.all(emails.map((e) => fs.doc(`users/${e}`).get().catch(() => null)));
  return emails
    .map((email, i) => {
      const d = docs[i]?.data();
      const nombre = String(d?.displayName ?? d?.nombre ?? d?.name ?? "").trim()
        || email.split("@")[0].split(/[._-]/).map((p) => p[0]?.toUpperCase() + p.slice(1)).join(" ");
      return { email, nombre };
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

type Datos = { texto?: unknown; audio?: unknown; para?: unknown; skin?: unknown; voz?: unknown; id?: unknown; msgId?: unknown };

/** Texto, audio, voz y avatar de un mensaje, validados. */
function mensajeDe(de: string, deNombre: string, datos: Datos) {
  const texto = typeof datos.texto === "string" ? datos.texto.trim().slice(0, MAX_TEXTO) : "";
  const audio = typeof datos.audio === "string" ? datos.audio : "";
  if (!texto && !audio) throw new HttpsError("invalid-argument", "Escribe el mensaje o graba un audio.");
  if (audio && (!/^data:audio\/[\w.+-]+(;codecs=[\w.]+)?;base64,/.test(audio) || audio.length > MAX_AUDIO)) {
    throw new HttpsError("invalid-argument", "El audio no es válido o es muy largo (máximo ~30 s).");
  }
  const skin = typeof datos.skin === "string" ? datos.skin.slice(0, 20) : null;
  // El avatar lo dice en voz alta (si no trae audio: entonces suena la grabación).
  const voz = datos.voz === true && !!texto && !audio;
  return {
    completo: { de, deNombre, skin, texto, voz, ...(audio ? { audio } : {}), creadoEn: FieldValue.serverTimestamp() },
    resumen: { de, deNombre, skin, texto, voz, conAudio: !!audio },
  };
}

const nombreDe = async (email: string) =>
  (await destinatarios()).find((d) => d.email === email)?.nombre ?? email.split("@")[0];

/**
 * Abre una conversación con cada destinatario (comparten `lote`, para verlas
 * juntas del lado de quien las mandó).
 */
export async function iniciarAviso(de: string, datos: Datos): Promise<{ enviados: number; lote: string }> {
  const gente = await destinatarios();
  const validos = new Set(gente.map((d) => d.email));
  const pedidos = lista(datos.para);
  const para = pedidos.includes("todos") ? [...validos].filter((e) => e !== de) : pedidos.filter((e) => validos.has(e));
  if (!para.length) throw new HttpsError("invalid-argument", "Elige a quién se lo mandas.");
  if (para.length > MAX_DESTINOS) throw new HttpsError("invalid-argument", "Son demasiados destinatarios.");
  const remitente = gente.find((d) => d.email === de)?.nombre ?? de.split("@")[0];
  const { completo, resumen } = mensajeDe(de, remitente, datos);

  const fs = getFirestore();
  const lote = fs.collection(AVISOS).doc().id;
  const batch = fs.batch();
  for (const email of para) {
    const conv = fs.collection(AVISOS).doc();
    const msg = conv.collection("mensajes").doc();
    batch.set(msg, completo);
    batch.set(conv, {
      lote,
      de, deNombre: remitente, deSkin: resumen.skin,
      para: email, paraNombre: gente.find((d) => d.email === email)?.nombre ?? email.split("@")[0],
      participantes: [...new Set([de, email])],
      creadoEn: FieldValue.serverTimestamp(),
      actualizadoEn: FieldValue.serverTimestamp(),
      cerrada: false,
      // A quién le toca: el último mensaje es para él (y se le sigue apareciendo).
      pendientePara: email,
      ultimo: { id: msg.id, ...resumen, creadoEn: FieldValue.serverTimestamp() },
      entregadoId: null,
      entregadoEn: null,
      mensajes: 1,
    });
  }
  await batch.commit();
  return { enviados: para.length, lote };
}

async function conversacionDe(email: string, id: unknown) {
  if (typeof id !== "string" || !/^[\w-]{10,40}$/.test(id)) throw new HttpsError("invalid-argument", "Conversación inválida.");
  const ref = getFirestore().collection(AVISOS).doc(id);
  const snap = await ref.get();
  const d = snap.data();
  if (!d || !lista(d.participantes).includes(email)) throw new HttpsError("not-found", "No encontré esa conversación.");
  return { ref, d };
}

/** Contesta en la conversación: ahora le toca al otro. */
export async function responderAviso(email: string, datos: Datos): Promise<{ ok: true }> {
  const { ref, d } = await conversacionDe(email, datos.id);
  if (d.cerrada) throw new HttpsError("failed-precondition", "La conversación ya terminó.");
  const { completo, resumen } = mensajeDe(email, await nombreDe(email), datos);
  const otro = lista(d.participantes).find((e) => e !== email) ?? email;
  const msg = ref.collection("mensajes").doc();
  const batch = getFirestore().batch();
  batch.set(msg, completo);
  batch.update(ref, {
    ultimo: { id: msg.id, ...resumen, creadoEn: FieldValue.serverTimestamp() },
    pendientePara: otro,
    entregadoId: null,
    entregadoEn: null,
    actualizadoEn: FieldValue.serverTimestamp(),
    mensajes: FieldValue.increment(1),
  });
  await batch.commit();
  return { ok: true };
}

/** El avatar de quien le tocaba ya se lo gritó (o lo leyó en el panel). */
export async function marcarEntregado(email: string, datos: Datos): Promise<{ ok: true }> {
  const { ref, d } = await conversacionDe(email, datos.id);
  const msgId = typeof datos.msgId === "string" ? datos.msgId : "";
  if (d.pendientePara === email && d.ultimo?.id === msgId && d.entregadoId !== msgId) {
    await ref.update({ entregadoId: msgId, entregadoEn: FieldValue.serverTimestamp() });
  }
  return { ok: true };
}

/** Cualquiera de los dos da la conversación por terminada: deja de aparecer. */
export async function terminarAviso(email: string, datos: Datos): Promise<{ ok: true }> {
  const { ref, d } = await conversacionDe(email, datos.id);
  if (!d.cerrada) {
    await ref.update({
      cerrada: true, cerradaPor: email, cerradaEn: FieldValue.serverTimestamp(),
      pendientePara: null, actualizadoEn: FieldValue.serverTimestamp(),
    });
  }
  return { ok: true };
}
