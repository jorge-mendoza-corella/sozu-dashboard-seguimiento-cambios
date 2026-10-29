/**
 * Megáfono: mandar un mensaje (texto y/o audio) que el avatar de GeorgIA de los
 * destinatarios aterriza a gritar. Se manda por la función `agenteMegafono`
 * (revisa el permiso) y llega al buzón `agente_buzon/{email}/mensajes` de cada
 * quien; el panel lo escucha y lo borra en cuanto lo pasa al avatar.
 */
import { getFunctions, httpsCallable } from "firebase/functions";
import { collection, deleteDoc, doc, onSnapshot, orderBy, query, Timestamp, where } from "firebase/firestore";
import { app, db } from "./firebase";

export type Destinatario = { email: string; nombre: string };
export type MensajeMegafono = { id: string; de: string; deNombre: string; texto: string; audio?: string; voz?: boolean };

/** Lo despacha el panel; lo escucha el avatar (AgenteVolador). */
export const EVENTO_MEGAFONO = "agente:megafono";

const llamar = httpsCallable<
  { accion?: "destinatarios"; texto?: string; audio?: string; para?: string[]; skin?: string; voz?: boolean },
  { destinatarios?: Destinatario[]; enviados?: number }
>(getFunctions(app, "us-central1"), "agenteMegafono", { timeout: 30_000 });

export async function destinatariosMegafono(): Promise<Destinatario[]> {
  return (await llamar({ accion: "destinatarios" })).data.destinatarios ?? [];
}

/** `para`: correos, o ["todos"]. `voz`: el avatar lo dice en voz alta (sin audio). */
export async function mandarMegafono(texto: string, para: string[], audio?: string, skin?: string, voz = false): Promise<number> {
  return (await llamar({ texto, para, voz, ...(audio ? { audio } : {}), ...(skin ? { skin } : {}) })).data.enviados ?? 0;
}

/**
 * Escucha el buzón propio: cada mensaje nuevo (de los últimos 10 min, por si se
 * abrió el dashboard un poco después) se entrega una vez y se borra.
 */
export function escucharBuzon(email: string, alLlegar: (m: MensajeMegafono) => void): () => void {
  const desde = Timestamp.fromMillis(Date.now() - 10 * 60_000);
  const q = query(collection(db, `agente_buzon/${email}/mensajes`), where("creadoEn", ">=", desde), orderBy("creadoEn"));
  return onSnapshot(q, (snap) => {
    for (const c of snap.docChanges()) {
      if (c.type !== "added") continue;
      const d = c.doc.data();
      alLlegar({ id: c.doc.id, de: String(d.de ?? ""), deNombre: String(d.deNombre ?? ""), texto: String(d.texto ?? ""), audio: typeof d.audio === "string" ? d.audio : undefined, voz: d.voz === true });
      void deleteDoc(doc(db, `agente_buzon/${email}/mensajes/${c.doc.id}`)).catch(() => {});
    }
  }, () => {});
}
