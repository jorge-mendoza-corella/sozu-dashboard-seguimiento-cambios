/**
 * Avance de Claude Code con un ticket ya mandado: estado, barra con el checklist
 * que Claude va palomeando, la conversación del issue y un cuadro para
 * responderle cuando pregunta (o para pedirle ajustes) sin salir del dashboard.
 *
 * Se consulta cada 15 s mientras trabaja y cada minuto en lo demás, solo con el
 * ticket abierto.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, ExternalLink, GitPullRequest, Loader2, MessageCircleQuestion, Send, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { mensajeDeError } from "@/lib/agenteRepos";
import { responderAClaude, seguimientoClaude, type EstadoClaude, type MensajeClaude } from "@/lib/agenteTickets";

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

const hora = (iso: string) =>
  new Date(iso).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const activo = (e: EstadoClaude | undefined) => e === "en_cola" || e === "trabajando";

function Mensaje({ m }: { m: MensajeClaude }) {
  const deClaude = m.autor === "claude";
  return (
    <div className={cn("flex gap-2", !deClaude && "flex-row-reverse")}>
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
            {m.cuerpo}
          </ReactMarkdown>
        </div>
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

const porcentaje = (p: { hechos: number; total: number } | null) => (p ? Math.round((p.hechos / p.total) * 100) : null);

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

/** Para la lista de tickets: chip con el estado y barra de avance mientras trabaja. */
export function EstadoClaudeMini({ ticketId }: { ticketId: string }) {
  const { data: s } = useSeguimiento(ticketId);
  if (!s) {
    return <span className="rounded bg-violet-100 px-1 text-[9px] font-semibold text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">en Claude</span>;
  }
  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded px-1 text-[9px] font-semibold", COLOR[s.estado])} title={`Claude Code: ${ETIQUETA[s.estado]}`}>
      {activo(s.estado) && <Loader2 className="h-2.5 w-2.5 animate-spin motion-reduce:animate-none" />}
      {s.estado === "esperando_respuesta" ? "te pregunta" : ETIQUETA[s.estado].toLowerCase()}
      {s.progreso && activo(s.estado) && ` ${porcentaje(s.progreso)}%`}
    </span>
  );
}

/** Barra bajo el renglón de la lista; solo mientras hay algo en curso o esperando. */
export function BarraClaudeMini({ ticketId }: { ticketId: string }) {
  const { data: s } = useSeguimiento(ticketId);
  if (!s || !(activo(s.estado) || s.estado === "esperando_respuesta")) return null;
  return <span className="mt-1 block"><Barra estado={s.estado} pct={porcentaje(s.progreso)} alto="h-1" /></span>;
}

export function SeguimientoClaude({ ticketId, issue }: { ticketId: string; issue: { numero: number; url: string } }) {
  const qc = useQueryClient();
  const clave = ["claude-seguimiento", ticketId];
  const q = useSeguimiento(ticketId);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const responder = async () => {
    setEnviando(true);
    setError(null);
    try {
      await responderAClaude(ticketId, texto);
      setTexto("");
      // La corrida tarda unos segundos en aparecer en GitHub.
      setTimeout(() => void qc.invalidateQueries({ queryKey: clave }), 4_000);
    } catch (e) {
      setError(mensajeDeError(e));
    } finally {
      setEnviando(false);
    }
  };

  const s = q.data;
  const pct = porcentaje(s?.progreso ?? null);
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
            {s.progreso ? `${s.progreso.hechos} de ${s.progreso.total} pasos` : s.estado === "en_cola" ? "Esperando a que arranque la corrida…" : "Arrancando…"}
          </p>
        </div>
      )}

      {s && s.prs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {s.prs.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] font-medium text-primary hover:bg-muted">
              <GitPullRequest className="h-3 w-3" /> {u.replace("https://github.com/", "").replace("/pull/", "#")}
            </a>
          ))}
        </div>
      )}

      {q.error && <p className="text-xs text-destructive">{mensajeDeError(q.error)}</p>}

      {mensajes.length > 0 && (
        <div className="max-h-96 space-y-2 overflow-y-auto rounded-lg border bg-muted/20 p-2">
          {mensajes.map((m) => <Mensaje key={m.id} m={m} />)}
        </div>
      )}

      <div className={cn("rounded-lg border p-2", esperando && "border-amber-400 ring-2 ring-amber-300/50 dark:ring-amber-700/40")}>
        {esperando && <p className="mb-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">Claude se detuvo a preguntarte algo. Contéstale aquí:</p>}
        <textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={esperando ? 3 : 2}
          maxLength={4000}
          placeholder={esperando ? "Tu respuesta para Claude…" : "Pídele un ajuste o dale más contexto…"}
          className="w-full resize-y bg-transparent text-xs outline-none"
        />
        <div className="flex items-center gap-2">
          {error && <p className="flex-1 text-[11px] text-destructive">{error}</p>}
          <span className="flex-1 text-[10px] text-muted-foreground">{activo(s?.estado) ? "Si sigue trabajando, tu mensaje entra al terminar la corrida actual." : "Arranca otra corrida sobre la misma rama y PR."}</span>
          <button
            type="button"
            onClick={() => void responder()}
            disabled={enviando || !texto.trim()}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-violet-600 px-2.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {enviando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} {esperando ? "Responder" : "Mandar"}
          </button>
        </div>
      </div>
    </div>
  );
}
