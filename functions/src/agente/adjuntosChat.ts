/**
 * Adjuntos de una pregunta a GeorgIA: imágenes que Claude ve directo (por URL)
 * y audios/videos ya convertidos por `agenteProcesarAdjunto` (transcripción y
 * cuadros). Se guardan con el mensaje para reconstruir el historial.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { HttpsError } from "firebase-functions/v2/https";
import { rutaPropia } from "./adjuntos.js";

export interface AdjuntoChat {
  tipo: "imagen" | "audio" | "video";
  nombre: string;
  url: string;
  transcripcion?: string | null;
  cuadros?: string[];
}

const MAX_ADJUNTOS = 6;
const MAX_TRANSCRIPCION = 30_000;
/** Imágenes (incluidos cuadros de video) que viajan en la conversación. */
const MAX_IMAGENES = 20;

export function validarAdjuntosChat(v: unknown, email: string): AdjuntoChat[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_ADJUNTOS) {
    throw new HttpsError("invalid-argument", `Hasta ${MAX_ADJUNTOS} adjuntos por mensaje.`);
  }
  return v.map((x): AdjuntoChat => {
    const a = (x ?? {}) as Record<string, unknown>;
    const tipo = a.tipo;
    const url = String(a.url ?? "");
    if ((tipo !== "imagen" && tipo !== "audio" && tipo !== "video") || !rutaPropia(url, email)) {
      throw new HttpsError("invalid-argument", "Adjunto inválido.");
    }
    const cuadros = Array.isArray(a.cuadros) ? a.cuadros.map(String).filter((c) => rutaPropia(c, email)).slice(0, 12) : [];
    return {
      tipo,
      nombre: String(a.nombre ?? "archivo").slice(0, 120),
      url,
      ...(tipo !== "imagen" ? { transcripcion: typeof a.transcripcion === "string" ? a.transcripcion.slice(0, MAX_TRANSCRIPCION) : null } : {}),
      ...(tipo === "video" ? { cuadros } : {}),
    };
  });
}

/** El turno del usuario: su texto, las transcripciones y las imágenes. */
export function contenidoUsuario(texto: string, adjuntos: AdjuntoChat[]): string | Anthropic.Beta.BetaContentBlockParam[] {
  if (adjuntos.length === 0) return texto;
  const bloques: Anthropic.Beta.BetaContentBlockParam[] = [];
  const notas: string[] = [];
  for (const a of adjuntos) {
    if (a.tipo === "imagen") {
      bloques.push({ type: "text", text: `Imagen adjunta: ${a.nombre}` });
      bloques.push({ type: "image", source: { type: "url", url: a.url } });
      continue;
    }
    const etiqueta = a.tipo === "audio" ? "Audio" : "Video";
    notas.push(
      a.transcripcion
        ? `${etiqueta} adjunto "${a.nombre}" — transcripción automática (puede tener errores):\n${a.transcripcion}`
        : `${etiqueta} adjunto "${a.nombre}" — sin voz que transcribir.`,
    );
    if (a.tipo === "video" && a.cuadros?.length) {
      bloques.push({ type: "text", text: `Cuadros del video "${a.nombre}", en orden:` });
      for (const c of a.cuadros) bloques.push({ type: "image", source: { type: "url", url: c } });
    }
  }
  const cuerpo = [texto.trim() || "(Sin texto: revisa los adjuntos.)", ...notas].join("\n\n");
  return [{ type: "text", text: cuerpo }, ...bloques];
}

/** Deja solo las últimas MAX_IMAGENES imágenes; las anteriores pasan a texto. */
export function recortarImagenes(messages: Anthropic.Beta.BetaMessageParam[]): void {
  let vistas = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    if (typeof c === "string") continue;
    for (let j = c.length - 1; j >= 0; j--) {
      const b = c[j];
      if (b.type !== "image") continue;
      if (++vistas > MAX_IMAGENES) c[j] = { type: "text", text: "(imagen anterior omitida)" };
    }
  }
}
