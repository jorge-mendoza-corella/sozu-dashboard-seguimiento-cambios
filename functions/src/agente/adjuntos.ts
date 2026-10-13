/**
 * Adjuntos (imagen, video, audio) para responderle a Claude desde el dashboard.
 *
 * El bucket es el de sozu-admin-dev, que comparte con SOZU Admin: aquí no se
 * tocan sus reglas. La función abre una subida reanudable con el admin SDK (no
 * pasa por reglas) y el navegador manda el archivo directo a esa sesión, sin el
 * tope de tamaño de un callable. El archivo lleva un token de descarga de
 * Firebase: la URL resultante se lee sin sesión, que es lo que necesita el
 * runner de GitHub para bajarlo (y transcribirlo si es audio o video).
 */
import { randomUUID } from "node:crypto";
import { getStorage } from "firebase-admin/storage";
import { HttpsError } from "firebase-functions/v2/https";

export const MAX_ADJUNTO = 200 * 1024 * 1024;
const TIPOS = /^(image|video|audio)\//;

export interface SubidaAdjunto {
  /** Sesión de subida reanudable: el navegador hace PUT del archivo aquí. */
  sesion: string;
  /** URL pública (con token) para el comentario. */
  url: string;
}

const limpiarNombre = (n: string) =>
  n.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").slice(-80) || "archivo";

/**
 * `carpeta`: el id del ticket (respuesta a Claude) o "chat" (adjunto para
 * GeorgIA).
 */
export async function abrirSubida(
  email: string,
  carpeta: string,
  nombre: string,
  tipo: string,
  tamano: number,
  origen: string | undefined,
): Promise<SubidaAdjunto> {
  if (!TIPOS.test(tipo)) throw new HttpsError("invalid-argument", "Solo imágenes, videos o audios.");
  if (!Number.isFinite(tamano) || tamano <= 0 || tamano > MAX_ADJUNTO) {
    throw new HttpsError("invalid-argument", `El archivo pasa de ${MAX_ADJUNTO >> 20} MB.`);
  }
  const bucket = getStorage().bucket();
  const ruta = `georgia-adjuntos/${email}/${carpeta}/${Date.now()}-${limpiarNombre(nombre)}`;
  const token = randomUUID();
  let sesion: string;
  try {
    [sesion] = await bucket.file(ruta).createResumableUpload({
      origin: origen,
      metadata: {
        contentType: tipo,
        metadata: { firebaseStorageDownloadTokens: token, subidoPor: email, carpeta },
      },
    });
  } catch (e) {
    if ((e as { code?: number }).code === 404) {
      throw new HttpsError("failed-precondition", "Firebase Storage no está activado en el proyecto: hay que activarlo para subir adjuntos.");
    }
    throw e;
  }
  return { sesion, url: urlPublica(bucket.name, ruta, token) };
}

const urlPublica = (bucket: string, ruta: string, token: string) =>
  `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(ruta)}?alt=media&token=${token}`;

/**
 * Ruta en el bucket de un adjunto que subió `email`, a partir de su URL; null
 * si la URL no es de un adjunto suyo (no se baja nada que no sea de la persona).
 */
export function rutaPropia(url: string, email: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const bucket = getStorage().bucket().name;
  const prefijo = `/v0/b/${bucket}/o/`;
  if (u.origin !== "https://firebasestorage.googleapis.com" || !u.pathname.startsWith(prefijo)) return null;
  const ruta = decodeURIComponent(u.pathname.slice(prefijo.length));
  return ruta.startsWith(`georgia-adjuntos/${email}/`) && !ruta.includes("..") ? ruta : null;
}

/** Sube un archivo generado aquí (p. ej. cuadros de un video) y da su URL con token. */
export async function subirGenerado(ruta: string, datos: Buffer, tipo: string): Promise<string> {
  const bucket = getStorage().bucket();
  const token = randomUUID();
  await bucket.file(ruta).save(datos, {
    contentType: tipo,
    resumable: false,
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  });
  return urlPublica(bucket.name, ruta, token);
}
