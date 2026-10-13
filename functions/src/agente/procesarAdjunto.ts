/**
 * Audios y videos para GeorgIA: Claude no oye ni ve video, así que aquí se
 * convierten en lo que sí entiende.
 *
 * - Audio (o la pista de audio de un video): transcripción con Whisper (small,
 *   cuantizado) corriendo en la propia función con transformers.js. El modelo
 *   se baja de Hugging Face la primera vez que arranca la instancia (~260 MB).
 * - Video: un cuadro cada pocos segundos (máx. MAX_CUADROS), subidos junto al
 *   original para mandárselos como imágenes.
 *
 * transformers.js y ffmpeg se importan al usarse: el resto de las funciones
 * del mismo código no cargan nada de esto al arrancar.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getStorage } from "firebase-admin/storage";
import { HttpsError } from "firebase-functions/v2/https";
import { rutaPropia, subirGenerado } from "./adjuntos.js";

const ejecutar = promisify(execFile);
const MODELO = "onnx-community/whisper-small";
const MAX_CUADROS = 12;
const MAX_SEGUNDOS_AUDIO = 20 * 60;

export interface AdjuntoProcesado {
  transcripcion: string | null;
  cuadros: string[];
}

type Transcriptor = (audio: Float32Array, opciones: Record<string, unknown>) => Promise<{ text?: string } | { text?: string }[]>;
let transcriptor: Promise<Transcriptor> | null = null;

function cargarWhisper(): Promise<Transcriptor> {
  transcriptor ??= (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = join(tmpdir(), "hf");
    return (await pipeline("automatic-speech-recognition", MODELO, { dtype: "q8" })) as unknown as Transcriptor;
  })().catch((e) => {
    transcriptor = null;
    throw e;
  });
  return transcriptor;
}

async function rutaFfmpeg(): Promise<string> {
  const m = (await import("ffmpeg-static")) as unknown as { default: string | null };
  if (!m.default) throw new Error("ffmpeg-static sin binario");
  return m.default;
}

async function transcribir(ffmpeg: string, archivo: string): Promise<string | null> {
  let pcm: Buffer;
  try {
    ({ stdout: pcm } = (await ejecutar(
      ffmpeg,
      ["-v", "error", "-i", archivo, "-t", String(MAX_SEGUNDOS_AUDIO), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
      { encoding: "buffer", maxBuffer: 1 << 30 },
    )) as unknown as { stdout: Buffer });
  } catch {
    return null; // sin pista de audio
  }
  if (pcm.byteLength < 16000 * 4 * 0.3) return null; // menos de 0.3 s
  const audio = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
  const asr = await cargarWhisper();
  const r = await asr(audio, { language: "spanish", task: "transcribe", chunk_length_s: 30, stride_length_s: 5 });
  const texto = (Array.isArray(r) ? r.map((x) => x.text ?? "").join(" ") : r.text ?? "").replace(/\s+/g, " ").trim();
  return texto || null;
}

async function cuadros(ffmpeg: string, archivo: string, dir: string, rutaOriginal: string): Promise<string[]> {
  // Duración para repartir los cuadros a lo largo de todo el video.
  let duracion = 0;
  try {
    await ejecutar(ffmpeg, ["-i", archivo]);
  } catch (e) {
    const m = /Duration: (\d+):(\d+):(\d+\.?\d*)/.exec(String((e as { stderr?: string }).stderr ?? ""));
    if (m) duracion = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  const cada = Math.max(3, duracion / MAX_CUADROS);
  await ejecutar(ffmpeg, [
    "-v", "error", "-i", archivo,
    "-vf", `fps=1/${cada.toFixed(2)},scale='min(1280,iw)':-2`,
    "-frames:v", String(MAX_CUADROS), "-q:v", "4",
    join(dir, "cuadro-%02d.jpg"),
  ]);
  const nombres = (await readdir(dir)).filter((n) => n.startsWith("cuadro-")).sort();
  const base = rutaOriginal.replace(/\.[^/.]+$/, "");
  return Promise.all(
    nombres.map(async (n) => subirGenerado(`${base}-${n}`, await readFile(join(dir, n)), "image/jpeg")),
  );
}

export async function procesarAdjunto(email: string, url: string, tipo: "audio" | "video"): Promise<AdjuntoProcesado> {
  const ruta = rutaPropia(url, email);
  if (!ruta) throw new HttpsError("invalid-argument", "Ese adjunto no es tuyo.");
  const dir = await mkdtemp(join(tmpdir(), "adjunto-"));
  try {
    const archivo = join(dir, "original");
    await getStorage().bucket().file(ruta).download({ destination: archivo });
    const ffmpeg = await rutaFfmpeg();
    const [transcripcion, imgs] = await Promise.all([
      transcribir(ffmpeg, archivo),
      tipo === "video" ? cuadros(ffmpeg, archivo, dir, ruta) : Promise.resolve([]),
    ]);
    return { transcripcion, cuadros: imgs };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
