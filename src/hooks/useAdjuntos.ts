/**
 * Estado de los adjuntos (imagen, video, audio, nota de voz) de un mensaje a
 * Claude. La vista está en components/agente/Adjuntos.tsx.
 */
import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from "react";
import { mensajeDeError, procesarAdjunto, type AdjuntoChat } from "@/lib/agenteRepos";
import { subirAdjunto, tipoAdjunto, type AdjuntoRespuesta } from "@/lib/agenteTickets";

/** Formatos de imagen que Claude lee directo. */
const IMAGENES_CLAUDE = /^image\/(jpeg|png|gif|webp)$/;

export interface AdjuntoLocal {
  id: string;
  nombre: string;
  tipo: AdjuntoRespuesta["tipo"];
  avance: number;
  /** URL del archivo en el navegador, para oírlo o verlo antes de mandarlo. */
  local: string;
  listo?: AdjuntoChat;
  procesando?: boolean;
  error?: string;
}

export function useAdjuntos({ carpeta, transcribir = false }: { carpeta: string; transcribir?: boolean }) {
  const [adjuntos, setAdjuntos] = useState<AdjuntoLocal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const cambiar = (id: string, p: Partial<AdjuntoLocal>) => setAdjuntos((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const agregar = (archivos: File[]) => {
    for (const f of archivos) {
      const tipo = tipoAdjunto(f.type);
      if (!tipo) {
        setError(`"${f.name}" no es imagen, video ni audio.`);
        continue;
      }
      if (transcribir && tipo === "imagen" && !IMAGENES_CLAUDE.test(f.type)) {
        setError(`"${f.name}": usa JPG, PNG, GIF o WebP.`);
        continue;
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setAdjuntos((xs) => [...xs, { id, nombre: f.name, tipo, avance: 0, local: URL.createObjectURL(f) }]);
      subirAdjunto(carpeta, f, (p) => cambiar(id, { avance: p }))
        .then(async (r) => {
          if (!transcribir || r.tipo === "imagen") return cambiar(id, { avance: 1, listo: r });
          cambiar(id, { avance: 1, procesando: true });
          const extra = await procesarAdjunto(r.url, r.tipo);
          cambiar(id, { procesando: false, listo: { ...r, ...extra } });
        })
        .catch((e) => cambiar(id, { procesando: false, error: mensajeDeError(e) }));
    }
  };

  const quitar = (id: string) =>
    setAdjuntos((xs) => {
      const x = xs.find((y) => y.id === id);
      if (x) URL.revokeObjectURL(x.local);
      return xs.filter((y) => y.id !== id);
    });

  const limpiar = useCallback(() => setAdjuntos([]), []);

  // Nota de voz desde el navegador.
  const [grabando, setGrabando] = useState(false);
  const grabadora = useRef<MediaRecorder | null>(null);
  const grabar = async () => {
    if (grabando) {
      grabadora.current?.stop();
      return;
    }
    try {
      const flujo = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(flujo);
      const partes: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && partes.push(e.data);
      rec.onstop = () => {
        flujo.getTracks().forEach((t) => t.stop());
        setGrabando(false);
        const tipo = rec.mimeType || "audio/webm";
        const ext = tipo.includes("mp4") ? "m4a" : tipo.includes("ogg") ? "ogg" : "webm";
        const d = new Date();
        const hora = `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
        agregar([new File(partes, `nota-de-voz-${hora}.${ext}`, { type: tipo.split(";")[0] })]);
      };
      grabadora.current = rec;
      rec.start();
      setGrabando(true);
    } catch {
      setError("No se pudo usar el micrófono (revisa el permiso del navegador).");
    }
  };
  useEffect(() => () => grabadora.current?.stop(), []);

  /** Pegar una captura de pantalla la adjunta. */
  const alPegar = (e: ClipboardEvent) => {
    const archivos = [...e.clipboardData.files].filter((f) => tipoAdjunto(f.type));
    if (archivos.length) {
      e.preventDefault();
      agregar(archivos);
    }
  };

  return {
    adjuntos,
    listos: adjuntos.flatMap((x) => (x.listo ? [x.listo] : [])),
    /** Alguno se sigue subiendo o transcribiendo. */
    ocupado: adjuntos.some((x) => !x.listo && !x.error),
    agregar, quitar, limpiar, grabar, grabando, alPegar, error, setError,
  };
}

export type Adjuntos = ReturnType<typeof useAdjuntos>;

