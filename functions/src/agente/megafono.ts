/**
 * Megáfono: quien tiene el permiso escribe un mensaje (y si quiere graba un
 * audio) y el avatar de GeorgIA de los destinatarios aterriza y lo grita (con
 * su audio). Cada destinatario lo recibe en su buzón
 * `agente_buzon/{email}/mensajes`, que solo él lee (y borra al verlo); aquí se
 * escribe con permisos de servidor.
 */
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { SUPERUSER_EMAIL } from "./acceso.js";

const MAX_TEXTO = 200;
/** ~30 s de audio opus en data URL. El doc de Firestore aguanta 1 MB. */
const MAX_AUDIO = 700_000;
const MAX_DESTINOS = 60;

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

export async function mandarMegafono(
  de: string,
  datos: { texto?: unknown; audio?: unknown; para?: unknown; skin?: unknown; voz?: unknown },
): Promise<{ enviados: number }> {
  const texto = typeof datos.texto === "string" ? datos.texto.trim().slice(0, MAX_TEXTO) : "";
  const audio = typeof datos.audio === "string" ? datos.audio : "";
  if (!texto && !audio) throw new HttpsError("invalid-argument", "Escribe el mensaje o graba un audio.");
  if (audio && (!/^data:audio\/[\w.+-]+(;codecs=[\w.]+)?;base64,/.test(audio) || audio.length > MAX_AUDIO)) {
    throw new HttpsError("invalid-argument", "El audio no es válido o es muy largo (máximo ~30 s).");
  }
  const validos = new Set((await destinatarios()).map((d) => d.email));
  const pedidos = lista(datos.para);
  const para = pedidos.includes("todos") ? [...validos] : pedidos.filter((e) => validos.has(e));
  if (!para.length) throw new HttpsError("invalid-argument", "Elige a quién se lo mandas.");
  if (para.length > MAX_DESTINOS) throw new HttpsError("invalid-argument", "Son demasiados destinatarios.");

  const remitente = (await destinatarios()).find((d) => d.email === de)?.nombre ?? de.split("@")[0];
  const fs = getFirestore();
  const lote = fs.batch();
  for (const email of para) {
    lote.set(fs.collection(`agente_buzon/${email}/mensajes`).doc(), {
      de, deNombre: remitente, texto, ...(audio ? { audio } : {}),
      // El avatar lo dice en voz alta (si no trae audio).
      voz: datos.voz === true && !!texto && !audio,
      skin: typeof datos.skin === "string" ? datos.skin.slice(0, 20) : null,
      creadoEn: FieldValue.serverTimestamp(),
    });
  }
  await lote.commit();
  return { enviados: para.length };
}
