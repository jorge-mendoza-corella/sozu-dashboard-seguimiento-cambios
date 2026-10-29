/**
 * Adjuntos (imagen, video, audio y nota de voz) para lo que se le manda a
 * Claude: la respuesta en un ticket y las preguntas a GeorgIA. En la respuesta
 * de un ticket también documentos (.md, .pdf, .doc, .docx, .csv, .json, .xls, .xlsx).
 *
 * Se suben en cuanto se eligen (directo a Storage, ver `subirAdjunto`). Con
 * `transcribir`, los audios y videos además pasan por `agenteProcesarAdjunto`
 * (transcripción y cuadros) antes de quedar listos: GeorgIA responde en el
 * momento y no tiene un runner que lo haga después, como los tickets.
 */
import { useRef } from "react";
import { Loader2, Mic, Paperclip, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ACCEPT_DOCUMENTOS, MAX_ADJUNTO_MB, type AdjuntoRespuesta } from "@/lib/agenteTickets";
import type { Adjuntos } from "@/hooks/useAdjuntos";

const ICONO: Record<AdjuntoRespuesta["tipo"], string> = { imagen: "🖼", video: "🎬", audio: "🎙", documento: "📄" };

/** Lo que se va a mandar, con vista previa y avance. */
export function AdjuntosPendientes({ a, className }: { a: Adjuntos; className?: string }) {
  if (a.adjuntos.length === 0) return null;
  return (
    <ul className={cn("space-y-1.5", className)}>
      {a.adjuntos.map((x) => (
        <li key={x.id} className={cn("rounded-md border bg-background p-1.5 text-[11px]", x.error && "border-destructive/50")}>
          <div className="relative flex items-center gap-1.5 overflow-hidden">
            <span className="text-muted-foreground">{ICONO[x.tipo]}</span>
            <span className={cn("min-w-0 flex-1 truncate", x.error && "text-destructive")} title={x.nombre}>{x.nombre}</span>
            {x.listo ? (
              <span className="shrink-0 text-emerald-600 dark:text-emerald-400">listo</span>
            ) : x.procesando ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-violet-600 dark:text-violet-300">
                <Loader2 className="h-3 w-3 animate-spin" /> {x.tipo === "video" ? "transcribiendo y viendo…" : "transcribiendo…"}
              </span>
            ) : !x.error && (
              <span className="shrink-0 tabular-nums text-muted-foreground">{Math.round(x.avance * 100)}%</span>
            )}
            <button type="button" onClick={() => a.quitar(x.id)} className="shrink-0 rounded p-0.5 hover:bg-muted" title="Quitar">
              <X className="h-3 w-3" />
            </button>
          </div>
          {!x.listo && !x.error && !x.procesando && (
            <span className="mt-1 block h-0.5 w-full overflow-hidden rounded bg-muted">
              <span className="block h-full bg-violet-500 transition-[width] duration-200 ease-out" style={{ width: `${x.avance * 100}%` }} />
            </span>
          )}
          {x.tipo === "audio" && <audio controls src={x.local} className="mt-1 h-8 w-full" />}
          {x.tipo === "video" && <video controls src={x.local} className="mt-1 max-h-40 w-full rounded bg-black" />}
          {x.tipo === "imagen" && <img src={x.local} alt={x.nombre} className="mt-1 max-h-32 rounded object-contain" />}
          {x.listo?.transcripcion && (
            <p className="mt-1 line-clamp-3 text-[11px] italic text-muted-foreground" title={x.listo.transcripcion}>“{x.listo.transcripcion}”</p>
          )}
          {x.error && <p className="mt-1 text-[11px] text-destructive">No se subió: {x.error}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Aviso encima de la caja mientras se arrastran archivos (la caja va `relative`). */
export function CapaSoltar({ a }: { a: Adjuntos }) {
  if (!a.arrastrando) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] border-2 border-dashed border-violet-500 bg-violet-50/90 text-xs font-semibold text-violet-700 dark:bg-violet-950/80 dark:text-violet-200">
      <Paperclip className="mr-1.5 h-4 w-4" /> Suelta aquí para adjuntar
    </div>
  );
}

/** Botones "Adjuntar" y "Nota de voz". */
export function BotonesAdjuntar({ a, compacto = false }: { a: Adjuntos; compacto?: boolean }) {
  const selector = useRef<HTMLInputElement>(null);
  const boton = compacto
    ? "inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
    : "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] text-muted-foreground hover:bg-muted";
  return (
    <>
      <input
        ref={selector}
        type="file"
        multiple
        accept={`image/*,video/*,audio/*${a.documentos ? `,${ACCEPT_DOCUMENTOS}` : ""}`}
        className="hidden"
        onChange={(e) => { a.agregar([...(e.target.files ?? [])]); e.target.value = ""; }}
      />
      <button
        type="button"
        onClick={() => selector.current?.click()}
        className={boton}
        title={`${a.documentos ? "Imagen, video, audio o documento (.md, .pdf, .doc, .docx, .csv, .json, .xls, .xlsx)" : "Imagen, video o audio"} (hasta ${MAX_ADJUNTO_MB} MB). También puedes pegar una captura o arrastrar archivos.`}
        aria-label="Adjuntar"
      >
        <Paperclip className={compacto ? "h-4 w-4" : "h-3 w-3"} />{!compacto && " Adjuntar"}
      </button>
      <button
        type="button"
        onClick={() => void a.grabar()}
        className={cn(boton, a.grabando && "border-red-400 text-red-600")}
        title={a.grabando ? "Detener y adjuntar" : "Grabar una nota de voz"}
        aria-label={a.grabando ? "Detener grabación" : "Nota de voz"}
      >
        {a.grabando
          ? <><Square className={cn("fill-current", compacto ? "h-4 w-4 animate-pulse motion-reduce:animate-none" : "h-3 w-3")} />{!compacto && " Detener"}</>
          : <><Mic className={compacto ? "h-4 w-4" : "h-3 w-3"} />{!compacto && " Nota de voz"}</>}
      </button>
    </>
  );
}

/** Un adjunto ya mandado: reproductor o miniatura con su nombre. */
export function AdjuntoEnMensaje({ a, sobreColor = false }: { a: { tipo: string; nombre: string; url: string; transcripcion?: string | null }; sobreColor?: boolean }) {
  return (
    <div className={cn("rounded-md border p-1.5", sobreColor ? "border-white/20 bg-white/10" : "bg-background/60")}>
      <p className={cn("mb-1 flex items-center gap-1 text-[10px]", sobreColor ? "text-white/80" : "text-muted-foreground")}>
        {ICONO[a.tipo as AdjuntoRespuesta["tipo"]] ?? "📎"}
        <a href={a.url} target="_blank" rel="noreferrer" className={cn("truncate hover:underline", sobreColor ? "text-white" : "text-primary")} title={a.nombre}>{a.nombre}</a>
      </p>
      {a.tipo === "audio" && <audio controls preload="metadata" src={a.url} className="h-8 w-full" />}
      {a.tipo === "video" && <video controls preload="metadata" src={a.url} className="max-h-48 w-full rounded bg-black" />}
      {a.tipo === "imagen" && (
        <a href={a.url} target="_blank" rel="noreferrer">
          <img src={a.url} alt={a.nombre} loading="lazy" className="max-h-40 rounded object-contain" />
        </a>
      )}
      {a.transcripcion && (
        <details className={cn("mt-1 text-[11px]", sobreColor ? "text-white/85" : "text-muted-foreground")}>
          <summary className="cursor-pointer select-none">Transcripción</summary>
          <p className="mt-0.5 whitespace-pre-wrap italic">{a.transcripcion}</p>
        </details>
      )}
    </div>
  );
}
