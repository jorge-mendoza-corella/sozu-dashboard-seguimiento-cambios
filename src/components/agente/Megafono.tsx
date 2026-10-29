/**
 * Pestaña «Megáfono» del panel de GeorgIA: escribir un mensaje (y si se quiere
 * grabar un audio) y elegir a quién le llega. El avatar de cada destinatario
 * aterriza y lo grita, con el audio. Solo con el permiso «Megáfono».
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Megaphone, Mic, Square, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { mensajeDeError } from "@/lib/agenteRepos";
import { destinatariosMegafono, mandarMegafono } from "@/lib/megafono";
import { useSkinGeorgIA } from "./skinsDatos";

const MAX_TEXTO = 200;
const MAX_SEG = 30;

const aDataUrl = (b: Blob) =>
  new Promise<string>((ok, mal) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => mal(r.error);
    r.readAsDataURL(b);
  });

export function Megafono({ email }: { email: string }) {
  const skin = useSkinGeorgIA();
  const { data: gente, isLoading, error: errorGente } = useQuery({ queryKey: ["megafono-destinatarios"], queryFn: destinatariosMegafono, staleTime: 5 * 60_000 });
  const [texto, setTexto] = useState("");
  const [todos, setTodos] = useState(true);
  const [para, setPara] = useState<Set<string>>(new Set());
  const [audio, setAudio] = useState<string | null>(null);
  const [grabando, setGrabando] = useState(0);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<number | null>(null);
  const grabadora = useRef<MediaRecorder | null>(null);
  const reloj = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => () => {
    clearInterval(reloj.current);
    grabadora.current?.stream.getTracks().forEach((t) => t.stop());
  }, []);

  const detener = () => {
    clearInterval(reloj.current);
    if (grabadora.current?.state === "recording") grabadora.current.stop();
  };

  const grabar = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tipo = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
      // 32 kbps: 30 s caben de sobra en el mensaje.
      const rec = new MediaRecorder(stream, { ...(tipo ? { mimeType: tipo } : {}), audioBitsPerSecond: 32_000 });
      const partes: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && partes.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setGrabando(0);
        const blob = new Blob(partes, { type: rec.mimeType || "audio/webm" });
        if (blob.size) setAudio(await aDataUrl(blob));
      };
      grabadora.current = rec;
      rec.start();
      setGrabando(1);
      reloj.current = setInterval(() => {
        setGrabando((s) => {
          if (s >= MAX_SEG) detener();
          return s + 1;
        });
      }, 1000);
    } catch {
      setError("No se pudo usar el micrófono: revisa el permiso del navegador.");
    }
  };

  const alternar = (e: string) =>
    setPara((xs) => {
      const n = new Set(xs);
      if (n.has(e)) n.delete(e);
      else n.add(e);
      return n;
    });

  const destinos = todos ? ["todos"] : [...para];
  const listo = (texto.trim() || audio) && destinos.length > 0 && !grabando && !enviando;

  const mandar = async () => {
    setEnviando(true);
    setError(null);
    setHecho(null);
    try {
      const n = await mandarMegafono(texto.trim(), destinos, audio ?? undefined, skin);
      setHecho(n);
      setTexto("");
      setAudio(null);
    } catch (e) {
      setError(mensajeDeError(e));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <h2 className="flex items-center gap-2 font-semibold"><Megaphone className="h-4 w-4" /> Megáfono</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Escribe un mensaje o graba un audio: el avatar de quien elijas aterriza y lo grita (con tu audio).
      </p>

      <label className="mt-4 block text-xs font-medium">Mensaje</label>
      <textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value.slice(0, MAX_TEXTO))}
        rows={3}
        placeholder="¡Ya salió el release! 🎉"
        className="mt-1 w-full resize-y rounded-lg border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <p className="text-right text-[11px] text-muted-foreground">{texto.length}/{MAX_TEXTO}</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {grabando ? (
          <button type="button" onClick={detener} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-xs font-semibold text-white">
            <Square className="h-3.5 w-3.5" /> Detener ({grabando - 1}s / {MAX_SEG}s)
          </button>
        ) : (
          <button type="button" onClick={() => void grabar()} className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted">
            <Mic className="h-3.5 w-3.5" /> {audio ? "Grabar otro audio" : "Grabar audio"}
          </button>
        )}
        {audio && !grabando && (
          <>
            <audio src={audio} controls className="h-8" />
            <button type="button" onClick={() => setAudio(null)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Quitar el audio">
              <Trash2 className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      <p className="mt-5 text-xs font-medium">¿A quién le llega?</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setTodos(true)}
          className={cn("rounded-full border px-2.5 py-1 text-xs", todos ? "border-primary bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted")}
        >
          Todos
        </button>
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {(gente ?? []).map((g) => {
          const on = !todos && para.has(g.email);
          return (
            <button
              key={g.email}
              type="button"
              onClick={() => { setTodos(false); alternar(g.email); }}
              title={g.email}
              className={cn("rounded-full border px-2.5 py-1 text-xs", on ? "border-primary bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted")}
            >
              {g.nombre}{g.email === email ? " (tú)" : ""}
            </button>
          );
        })}
      </div>
      {errorGente && <p className="mt-2 text-xs text-destructive">{mensajeDeError(errorGente)}</p>}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void mandar()}
          disabled={!listo}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Megaphone className="h-4 w-4" />} Mandar
        </button>
        {hecho !== null && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
            <Check className="h-3.5 w-3.5" /> Le llegó a {hecho} persona{hecho === 1 ? "" : "s"}.
          </span>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <p className="mt-4 text-[11px] text-muted-foreground">
        Le llega a quien tenga el dashboard abierto ahora o lo abra en los próximos 10 minutos.
      </p>
    </div>
  );
}
