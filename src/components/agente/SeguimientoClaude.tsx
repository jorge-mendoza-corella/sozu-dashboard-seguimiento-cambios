/**
 * Avance de Claude Code con un ticket ya mandado: estado, barra con el checklist
 * que Claude va palomeando, la conversación del issue y un cuadro para
 * responderle cuando pregunta (o para pedirle ajustes) sin salir del dashboard.
 *
 * Se consulta cada 15 s mientras trabaja y cada minuto en lo demás, solo con el
 * ticket abierto.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, ExternalLink, GitPullRequest, Loader2, MessageCircleQuestion, Mic, Paperclip, Send, Square, User, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConsolaClaude } from "./ConsolaClaude";
import { mensajeDeError } from "@/lib/agenteRepos";
import {
  avancePrs, duracion, MAX_ADJUNTO_MB, responderAClaude, seguimientoClaude, subirAdjunto, tipoAdjunto,
  type AdjuntoRespuesta, type EstadoClaude, type EstadoPr, type MensajeClaude,
} from "@/lib/agenteTickets";

const ETIQUETA: Record<EstadoClaude, string> = {
  en_cola: "En cola",
  trabajando: "Trabajando",
  esperando_respuesta: "Esperando tu respuesta",
  terminado: "Terminado",
  error: "Falló",
};

const COLOR: Record<EstadoClaude, string> = {
  en_cola: "bg-muted text-muted-foreground",
  trabajando: "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300",
  esperando_respuesta: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  terminado: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  error: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
};

const ETIQUETA_PR: Record<EstadoPr, string> = {
  abierto: "por revisar",
  en_dev: "en dev",
  en_main: "en main, falta deploy",
  en_prd: "en PRD",
  cerrado: "cerrado sin merge",
};

const COLOR_PR: Record<EstadoPr, string> = {
  abierto: "text-muted-foreground",
  en_dev: "text-sky-700 dark:text-sky-300",
  en_main: "text-amber-700 dark:text-amber-300",
  en_prd: "text-emerald-700 dark:text-emerald-300",
  cerrado: "text-muted-foreground line-through",
};

const hora = (iso: string) =>
  new Date(iso).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const activo = (e: EstadoClaude | undefined) => e === "en_cola" || e === "trabajando";

/**
 * Saca del texto la sección "Adjuntos:" ("- audio: nombre — url") que manda el
 * dashboard: en GitHub va con la URL completa (el orquestador la necesita para
 * bajar y transcribir), pero aquí se muestra como reproductor o miniatura.
 */
const LINEA_ADJUNTO = /^\s*-\s*(imagen|video|audio)\s*:\s*(.+?)\s+—\s+(https:\/\/\S+)\s*$/i;

function separarAdjuntos(cuerpo: string): { texto: string; adjuntos: { tipo: string; nombre: string; url: string }[] } {
  const adjuntos: { tipo: string; nombre: string; url: string }[] = [];
  const lineas = cuerpo.split("\n").filter((l) => {
    const m = l.match(LINEA_ADJUNTO);
    if (m) adjuntos.push({ tipo: m[1].toLowerCase(), nombre: m[2], url: m[3] });
    return !m;
  });
  const texto = (adjuntos.length ? lineas.filter((l) => !/^\s*Adjuntos:\s*$/i.test(l)) : lineas).join("\n").trim();
  return { texto, adjuntos };
}

function Mensaje({ m }: { m: MensajeClaude }) {
  const deClaude = m.autor === "claude";
  const { texto, adjuntos } = separarAdjuntos(m.cuerpo);
  return (
    <div className={cn("flex gap-2", !deClaude && "flex-row-reverse")} data-pregunta={m.esPregunta || undefined}>
      <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", deClaude ? "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300" : "bg-primary/15 text-primary")}>
        {deClaude ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
      </span>
      <div
        className={cn(
          "min-w-0 max-w-[88%] rounded-lg border px-3 py-2",
          m.esPregunta ? "border-amber-400/70 bg-amber-50 dark:bg-amber-950/30" : deClaude ? "bg-background" : "bg-primary/5",
        )}
      >
        <p className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {m.esPregunta && <MessageCircleQuestion className="h-3 w-3 text-amber-600" />}
          {deClaude ? (m.esSeguimiento ? "Claude · avance" : m.esPregunta ? "Claude pregunta" : "Claude") : m.quien ?? "Tú"}
          <span>· {hora(m.fecha)}</span>
        </p>
        <div className="prose prose-xs max-w-none break-words text-xs dark:prose-invert prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-a:text-primary prose-pre:text-[11px]">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
            {texto}
          </ReactMarkdown>
        </div>
        {adjuntos.length > 0 && (
          <div className="mt-1.5 space-y-1.5">
            {adjuntos.map((a) => (
              <div key={a.url} className="rounded-md border bg-background/60 p-1.5">
                <p className="mb-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                  {a.tipo === "imagen" ? "🖼" : a.tipo === "video" ? "🎬" : "🎙"}
                  <a href={a.url} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline" title={a.nombre}>{a.nombre}</a>
                </p>
                {a.tipo === "audio" && <audio controls preload="metadata" src={a.url} className="h-8 w-full" />}
                {a.tipo === "video" && <video controls preload="metadata" src={a.url} className="max-h-48 w-full rounded bg-black" />}
                {a.tipo === "imagen" && (
                  <a href={a.url} target="_blank" rel="noreferrer">
                    <img src={a.url} alt={a.nombre} loading="lazy" className="max-h-40 rounded object-contain" />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Misma consulta en la lista y en el detalle: comparten caché y sondeo. */
function useSeguimiento(ticketId: string) {
  return useQuery({
    queryKey: ["claude-seguimiento", ticketId],
    queryFn: () => seguimientoClaude(ticketId),
    refetchInterval: (query) => (activo(query.state.data?.estado) ? 15_000 : 60_000),
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

/**
 * Avance de la barra. Mientras la corrida sigue activa nunca llega a 100: con
 * todo palomeado aún falta cerrarla (commits, PRs, comentario final).
 */
const porcentaje = (p: { hechos: number; total: number } | null, estado?: EstadoClaude) => {
  if (!p) return null;
  const pct = Math.round((p.hechos / p.total) * 100);
  return activo(estado) ? Math.min(pct, 95) : pct;
};

/** Barra delgada: con checklist, el avance; sin él y trabajando, indeterminada. */
function Barra({ estado, pct, alto = "h-1.5" }: { estado: EstadoClaude; pct: number | null; alto?: string }) {
  // <span> y no <div>: también va dentro del <button> de cada ticket en la lista.
  return (
    <span className={cn("block w-full overflow-hidden rounded-full bg-muted", alto)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-500 ease-out",
          estado === "error" ? "bg-red-500" : estado === "terminado" ? "bg-emerald-500" : estado === "esperando_respuesta" ? "bg-amber-500" : "bg-violet-500",
          pct === null && "w-1/3 animate-pulse motion-reduce:animate-none",
        )}
        style={pct !== null ? { width: `${Math.max(pct, activo(estado) ? 5 : 0)}%` } : undefined}
      />
    </span>
  );
}

/** Re-render cada `ms` mientras `activo`: para que el tiempo transcurrido avance solo. */
function useReloj(activo: boolean, ms = 15_000) {
  const [, setTic] = useState(0);
  useEffect(() => {
    if (!activo) return;
    const id = setInterval(() => setTic((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [activo, ms]);
}

/** Tiempo de la corrida: corriendo, desde que arrancó; terminada, lo que duró. */
const tiempoCorrida = (c: { inicio: string; fin: string | null } | null | undefined) =>
  c ? duracion(c.inicio, c.fin ? Date.parse(c.fin) : Date.now()) : null;

/** Para la lista de tickets: chip con el estado y barra de avance mientras trabaja. */
export function EstadoClaudeMini({ ticketId }: { ticketId: string }) {
  const { data: s } = useSeguimiento(ticketId);
  const avance = avancePrs(s?.prs ?? []);
  useReloj(activo(s?.estado));
  if (!s) {
    return <span className="rounded bg-violet-100 px-1 text-[9px] font-semibold text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">en Claude</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded px-1 text-[9px] font-semibold",
        COLOR[s.estado],
        // Esperando respuesta es lo único que pide algo de ti: que se note.
        s.estado === "esperando_respuesta" && "animate-pulse ring-1 ring-amber-400 motion-reduce:animate-none",
      )}
      title={`Claude Code: ${ETIQUETA[s.estado]}`}
    >
      {activo(s.estado) && <Loader2 className="h-2.5 w-2.5 animate-spin motion-reduce:animate-none" />}
      {s.estado === "esperando_respuesta" ? "te pregunta" : s.estado === "terminado" && avance.total ? `${avance.enPrd}/${avance.total} en PRD` : ETIQUETA[s.estado].toLowerCase()}
      {s.progreso && activo(s.estado) && ` ${porcentaje(s.progreso, s.estado)}%`}
      {activo(s.estado) && s.corrida && <span className="font-normal opacity-80">· {tiempoCorrida(s.corrida)}</span>}
    </span>
  );
}

/** Barra bajo el renglón de la lista; solo mientras hay algo en curso o esperando. */
export function BarraClaudeMini({ ticketId }: { ticketId: string }) {
  const { data: s } = useSeguimiento(ticketId);
  if (!s || !(activo(s.estado) || s.estado === "esperando_respuesta")) return null;
  return <span className="mt-1 block"><Barra estado={s.estado} pct={porcentaje(s.progreso, s.estado)} alto="h-1" /></span>;
}

export function SeguimientoClaude({ ticketId, issue, enfocar = false, onEnfocado, onListo }: {
  ticketId: string;
  issue: { numero: number; url: string };
  /** Llegó desde el grito de GeorgIA: bajar al cuadro de respuesta y dejar el cursor ahí. */
  enfocar?: boolean;
  onEnfocado?: () => void;
  /** Todos los PRs llegaron a PRD: el registro ya cambió, hay que releerlo. */
  onListo?: () => void;
}) {
  const qc = useQueryClient();
  const clave = ["claude-seguimiento", ticketId];
  const q = useSeguimiento(ticketId);
  const [texto, setTexto] = useState("");
  const cuadro = useRef<HTMLDivElement>(null);
  const campo = useRef<HTMLTextAreaElement>(null);
  const conversacion = useRef<HTMLDivElement>(null);
  const cargado = !!q.data;
  const listo = !!q.data?.listoParaCerrar;
  const esperandoAhora = q.data?.estado === "esperando_respuesta";
  useEffect(() => {
    if (listo) onListo?.();
    // Solo al pasar a listo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listo]);

  // Al abrir un ticket que espera respuesta (desde la lista o desde GeorgIA):
  // la conversación se recorre hasta las preguntas de Claude y el cuadro de
  // respuesta queda a la vista, con el cursor. Una vez por apertura.
  const yaEnfocado = useRef(false);
  useEffect(() => {
    if (yaEnfocado.current || !cargado || !(enfocar || esperandoAhora)) return;
    yaEnfocado.current = true;
    // Un respiro para que el panel termine de entrar antes de desplazar.
    const t = setTimeout(() => {
      const caja = conversacion.current;
      const pregunta = caja?.querySelectorAll<HTMLElement>("[data-pregunta]");
      const ultima = pregunta?.[pregunta.length - 1];
      if (caja && ultima) {
        // Dentro del mensaje, el título "Preguntas" si lo hay; si no, la última lista.
        const titulo = [...ultima.querySelectorAll<HTMLElement>("h1,h2,h3,h4,strong,p")].find((el) => /^\s*preguntas?\b/i.test(el.textContent ?? ""));
        const destino = titulo ?? [...ultima.querySelectorAll<HTMLElement>("ol,ul")].pop() ?? ultima;
        caja.scrollTop += destino.getBoundingClientRect().top - caja.getBoundingClientRect().top - 8;
      }
      cuadro.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      campo.current?.focus({ preventScroll: true });
      onEnfocado?.();
    }, 350);
    return () => clearTimeout(t);
  }, [enfocar, esperandoAhora, cargado, onEnfocado]);

  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Adjuntos: se suben en cuanto se eligen; la respuesta lleva sus URLs ──
  // `local`: URL del archivo en el navegador, para oírlo o verlo antes de mandarlo.
  type Adjunto = { id: string; nombre: string; tipo: AdjuntoRespuesta["tipo"]; avance: number; local: string; listo?: AdjuntoRespuesta; error?: string };
  const [adjuntos, setAdjuntos] = useState<Adjunto[]>([]);
  const selector = useRef<HTMLInputElement>(null);
  const subiendo = adjuntos.some((x) => !x.listo && !x.error);

  const agregar = (archivos: File[]) => {
    for (const f of archivos) {
      const tipo = tipoAdjunto(f.type);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (!tipo) {
        setError(`"${f.name}" no es imagen, video ni audio.`);
        continue;
      }
      setAdjuntos((xs) => [...xs, { id, nombre: f.name, tipo, avance: 0, local: URL.createObjectURL(f) }]);
      subirAdjunto(ticketId, f, (p) => setAdjuntos((xs) => xs.map((x) => (x.id === id ? { ...x, avance: p } : x))))
        .then((r) => setAdjuntos((xs) => xs.map((x) => (x.id === id ? { ...x, avance: 1, listo: r } : x))))
        .catch((e) => setAdjuntos((xs) => xs.map((x) => (x.id === id ? { ...x, error: mensajeDeError(e) } : x))));
    }
  };

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

  const responder = async () => {
    setEnviando(true);
    setError(null);
    try {
      await responderAClaude(ticketId, texto, adjuntos.flatMap((x) => (x.listo ? [x.listo] : [])));
      setTexto("");
      setAdjuntos([]);
      // La corrida tarda unos segundos en aparecer en GitHub.
      setTimeout(() => void qc.invalidateQueries({ queryKey: clave }), 4_000);
    } catch (e) {
      setError(mensajeDeError(e));
    } finally {
      setEnviando(false);
    }
  };

  const s = q.data;
  useReloj(activo(s?.estado), 5_000);
  const pct = porcentaje(s?.progreso ?? null, s?.estado);
  const esperando = s?.estado === "esperando_respuesta";
  // La conversación sin el comentario de avance viejo: solo el último checklist.
  const ultimoSeguimiento = s ? [...s.mensajes].reverse().find((m) => m.esSeguimiento)?.id : undefined;
  const mensajes = (s?.mensajes ?? []).filter((m) => !m.esSeguimiento || m.id === ultimoSeguimiento);

  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {s ? (
          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold", COLOR[s.estado])}>
            {activo(s.estado) && <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />}
            {ETIQUETA[s.estado]}
            {s.corrida && (
              <span className="font-normal opacity-80" title={activo(s.estado) ? "Tiempo desde que arrancó la corrida" : "Lo que duró la última corrida"}>
                · {activo(s.estado) ? tiempoCorrida(s.corrida) : `duró ${tiempoCorrida(s.corrida)}`}
              </span>
            )}
          </span>
        ) : q.isLoading ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Revisando…</span>
        ) : null}
        <a href={issue.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
          issue #{issue.numero} <ExternalLink className="h-3 w-3" />
        </a>
        {s?.runUrl && (
          <a href={s.runUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline">
            corrida <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {s && <span className="ml-auto text-[10px] text-muted-foreground">revisado {hora(s.revisado)}</span>}
      </div>

      {s && (activo(s.estado) || pct !== null) && (
        <div>
          <Barra estado={s.estado} pct={pct} />
          <p className="mt-1 text-[10px] text-muted-foreground">
            {s.progreso
              ? `${s.progreso.hechos} de ${s.progreso.total} pasos${activo(s.estado) && s.progreso.hechos === s.progreso.total ? " · cerrando la corrida…" : ""}`
              : s.estado === "en_cola" ? "Esperando a que arranque la corrida…" : "Arrancando…"}
          </p>
        </div>
      )}

      {s && s.prs.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            {s.prs.map((p) => (
              <a
                key={p.url}
                href={p.url}
                target="_blank"
                rel="noreferrer"
                title={p.titulo || undefined}
                className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] font-medium text-primary hover:bg-muted"
              >
                <GitPullRequest className="h-3 w-3" /> {p.repo}#{p.numero}
                <span className={cn("font-normal", COLOR_PR[p.estado])}>· {ETIQUETA_PR[p.estado]}</span>
              </a>
            ))}
          </div>
          {s.estado !== "trabajando" && s.estado !== "en_cola" && (() => {
            const a = avancePrs(s.prs);
            return a.total > 0 && (
              <p className={cn("text-[11px]", s.listoParaCerrar ? "font-medium text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
                {s.listoParaCerrar
                  ? "Todo en PRD: ya puedes cerrar el ticket."
                  : `${a.enPrd} de ${a.total} PR${a.total === 1 ? "" : "s"} en PRD. El cierre se habilita cuando estén todos.`}
              </p>
            );
          })()}
        </div>
      )}

      {q.error && <p className="text-xs text-destructive">{mensajeDeError(q.error)}</p>}

      <ConsolaClaude issue={issue.numero} trabajando={activo(s?.estado)} />

      {mensajes.length > 0 && (
        <div ref={conversacion} className="max-h-96 space-y-2 overflow-y-auto rounded-lg border bg-muted/20 p-2">
          {mensajes.map((m) => <Mensaje key={m.id} m={m} />)}
        </div>
      )}

      <div ref={cuadro} className={cn("scroll-mt-4 rounded-lg border p-2", esperando && "border-amber-400 ring-2 ring-amber-300/50 dark:ring-amber-700/40")}>
        {esperando && <p className="mb-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">Claude se detuvo a preguntarte algo. Contéstale aquí:</p>}
        <textarea
          ref={campo}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onPaste={(e) => {
            // Pegar una captura de pantalla la adjunta.
            const archivos = [...e.clipboardData.files].filter((f) => tipoAdjunto(f.type));
            if (archivos.length) {
              e.preventDefault();
              agregar(archivos);
            }
          }}
          rows={esperando ? 3 : 2}
          maxLength={4000}
          placeholder={esperando ? "Tu respuesta para Claude…" : "Pídele un ajuste o dale más contexto…"}
          className="w-full resize-y bg-transparent text-xs outline-none"
        />
        {adjuntos.length > 0 && (
          <ul className="mb-2 space-y-1.5">
            {adjuntos.map((x) => (
              <li key={x.id} className={cn("rounded-md border bg-background p-1.5 text-[11px]", x.error && "border-destructive/50")}>
                <div className="relative flex items-center gap-1.5 overflow-hidden">
                  <span className="text-muted-foreground">{x.tipo === "imagen" ? "🖼" : x.tipo === "video" ? "🎬" : "🎙"}</span>
                  <span className={cn("min-w-0 flex-1 truncate", x.error && "text-destructive")} title={x.nombre}>{x.nombre}</span>
                  {x.listo ? (
                    <span className="shrink-0 text-emerald-600 dark:text-emerald-400">listo</span>
                  ) : !x.error && (
                    <span className="shrink-0 tabular-nums text-muted-foreground">{Math.round(x.avance * 100)}%</span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      URL.revokeObjectURL(x.local);
                      setAdjuntos((xs) => xs.filter((y) => y.id !== x.id));
                    }}
                    className="shrink-0 rounded p-0.5 hover:bg-muted"
                    title="Quitar"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {!x.listo && !x.error && (
                  <span className="mt-1 block h-0.5 w-full overflow-hidden rounded bg-muted">
                    <span className="block h-full bg-violet-500 transition-[width] duration-200 ease-out" style={{ width: `${x.avance * 100}%` }} />
                  </span>
                )}
                {/* Para oírlo / verlo antes de mandarlo. */}
                {x.tipo === "audio" && <audio controls src={x.local} className="mt-1 h-8 w-full" />}
                {x.tipo === "video" && <video controls src={x.local} className="mt-1 max-h-40 w-full rounded bg-black" />}
                {x.tipo === "imagen" && <img src={x.local} alt={x.nombre} className="mt-1 max-h-32 rounded object-contain" />}
                {x.error && <p className="mt-1 text-[11px] text-destructive">No se subió: {x.error}</p>}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <input
            ref={selector}
            type="file"
            multiple
            accept="image/*,video/*,audio/*"
            className="hidden"
            onChange={(e) => { agregar([...(e.target.files ?? [])]); e.target.value = ""; }}
          />
          <button type="button" onClick={() => selector.current?.click()} className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] text-muted-foreground hover:bg-muted" title={`Imagen, video o audio (hasta ${MAX_ADJUNTO_MB} MB). También puedes pegar una captura.`}>
            <Paperclip className="h-3 w-3" /> Adjuntar
          </button>
          <button
            type="button"
            onClick={() => void grabar()}
            className={cn("inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] hover:bg-muted", grabando ? "border-red-400 text-red-600" : "text-muted-foreground")}
            title={grabando ? "Detener y adjuntar" : "Grabar una nota de voz"}
          >
            {grabando ? <><Square className="h-3 w-3 fill-current" /> Detener</> : <><Mic className="h-3 w-3" /> Nota de voz</>}
          </button>
          {error && <p className="flex-1 text-[11px] text-destructive">{error}</p>}
          {!error && <span className="flex-1 text-[10px] text-muted-foreground">{activo(s?.estado) ? "Si sigue trabajando, tu mensaje entra al terminar la corrida actual." : "Audios y videos se transcriben para Claude."}</span>}
          <button
            type="button"
            onClick={() => void responder()}
            disabled={enviando || subiendo || grabando || (!texto.trim() && !adjuntos.some((x) => x.listo))}
            title={subiendo ? "Espera a que terminen de subir los adjuntos" : undefined}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-violet-600 px-2.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {enviando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} {esperando ? "Responder" : "Mandar"}
          </button>
        </div>
      </div>
    </div>
  );
}
