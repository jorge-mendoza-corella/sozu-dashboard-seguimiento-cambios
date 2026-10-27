import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CheckCircle2, ChevronRight, EyeOff, ExternalLink, Loader2, RotateCcw, Ticket, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { mensajeDeError } from "@/lib/agenteRepos";
import {
  cambiarEstadoIssue, crearTicketIssue, getDetalleIssue, promptClaude,
  type DetalleIssue as Detalle, type EstadoIssue, type FrameIssue,
} from "@/lib/sentry";

// ---------------------------------------------------------------------------
// Panel lateral con el detalle de un issue de Sentry: datos, último evento,
// stack trace y tags, más resolver / ignorar / reabrir, copiarlo como prompt
// para Claude y levantar un ticket de Soporte técnico. Todo pasa por las
// funciones `sentryDetalleIssue`, `sentryCambiarIssue` y `sentryCrearTicket`,
// que revisan el permiso del repo en el servidor.
// ---------------------------------------------------------------------------

const fecha = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

const ESTADO: Record<string, string> = { unresolved: "Sin resolver", resolved: "Resuelto", ignored: "Ignorado" };

// Las URLs vienen del servidor y terminan en un href: solo se aceptan de Sentry.
const deSentry = (url: string) => (/^https:\/\/[\w-]+\.sentry\.io\//.test(url) ? url : undefined);

export function DetalleIssue({ issueId, repo, puedeResolver, onCerrar }: {
  issueId: string;
  /** owner/repo, para el prompt de Claude. */
  repo: string;
  puedeResolver: boolean;
  onCerrar: () => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["sentry-issue", issueId],
    queryFn: () => getDetalleIssue(issueId),
    staleTime: 60_000,
  });
  const cambio = useMutation({
    mutationFn: (estado: EstadoIssue) => cambiarEstadoIssue(issueId, estado),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["sentry"] });
      await qc.invalidateQueries({ queryKey: ["sentry-issue", issueId] });
      if (r.estado !== "unresolved") onCerrar();
    },
  });
  const ticket = useMutation({
    mutationFn: () => crearTicketIssue(issueId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sentry-issue", issueId] }),
  });
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    if (!data) return;
    await navigator.clipboard.writeText(promptClaude(data, repo)).catch(() => undefined);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  };

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onCerrar]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 bg-black/40" aria-label="Cerrar" onClick={onCerrar} />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l bg-background shadow-xl">
        <header className="flex items-start gap-3 border-b p-4">
          <div className="min-w-0 flex-1">
            {data && (
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{data.shortId}</span>
                <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-700 dark:bg-red-950/50 dark:text-red-300">{data.nivel}</span>
                <span className="rounded-full bg-muted px-2 py-0.5">{ESTADO[data.estado] ?? data.estado}</span>
                <span>{data.slug}</span>
              </p>
            )}
            <h2 className="mt-1 break-words text-base font-semibold leading-snug">{data?.titulo ?? "Cargando…"}</h2>
            {data?.culprit && <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{data.culprit}</p>}
          </div>
          <button type="button" onClick={onCerrar} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Cerrar">
            <X className="h-4 w-4" />
          </button>
        </header>

        {data && (
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
            {puedeResolver && data.estado === "unresolved" && (
              <>
                <Accion onClick={() => cambio.mutate("resolved")} cargando={cambio.isPending && cambio.variables === "resolved"} principal>
                  <CheckCircle2 className="h-3.5 w-3.5" /> Resolver
                </Accion>
                <Accion onClick={() => cambio.mutate("ignored")} cargando={cambio.isPending && cambio.variables === "ignored"}>
                  <EyeOff className="h-3.5 w-3.5" /> Ignorar
                </Accion>
              </>
            )}
            {puedeResolver && data.estado !== "unresolved" && (
              <Accion onClick={() => cambio.mutate("unresolved")} cargando={cambio.isPending}>
                <RotateCcw className="h-3.5 w-3.5" /> Reabrir
              </Accion>
            )}
            <Accion onClick={() => void copiar()} titulo="Copia el error con su stack trace como prompt para Claude Code">
              {copiado ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <Bot className="h-3.5 w-3.5" />}
              {copiado ? "Copiado" : "Copiar para Claude"}
            </Accion>
            {data.ticket ? (
              <a
                href={data.ticket.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-violet-400/60 px-2.5 text-xs font-semibold text-violet-700 hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-950/30"
                title={`Levantado por ${data.ticket.creadoPor}`}
              >
                <Ticket className="h-3.5 w-3.5" /> Ticket SOZU-{data.ticket.numero}
              </a>
            ) : (
              puedeResolver && (
                <Accion
                  onClick={() => ticket.mutate()}
                  cargando={ticket.isPending}
                  titulo="Levanta un ticket en Sistemas Soporte técnico con todo el detalle del error"
                >
                  <Ticket className="h-3.5 w-3.5" /> Crear ticket
                </Accion>
              )
            )}
            <a
              href={deSentry(data.url)}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Abrir en Sentry <ExternalLink className="h-3 w-3" />
            </a>
            {cambio.error && <p className="w-full text-xs text-red-600">{mensajeDeError(cambio.error)}</p>}
            {ticket.error && <p className="w-full text-xs text-red-600">{mensajeDeError(ticket.error)}</p>}
          </div>
        )}

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
          {error && <p className="text-sm text-red-600">{mensajeDeError(error)}</p>}
          {data && <Contenido d={data} />}
        </div>
      </aside>
    </div>
  );
}

function Accion({ children, onClick, cargando, principal, titulo }: {
  children: React.ReactNode;
  onClick: () => void;
  cargando?: boolean;
  principal?: boolean;
  titulo?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={cargando}
      title={titulo}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold disabled:opacity-60",
        principal ? "bg-emerald-600 text-white hover:bg-emerald-700" : "border hover:bg-muted",
      )}
    >
      {cargando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </button>
  );
}

function Contenido({ d }: { d: Detalle }) {
  const e = d.evento;
  const entorno = [
    ["URL", e.url ? `${e.metodo ? `${e.metodo} ` : ""}${e.url}` : null],
    ["Navegador", e.navegador],
    ["Sistema", e.sistema],
    ["Dispositivo", e.dispositivo],
    ["Runtime", e.runtime],
    ["Release", e.release],
  ].filter((x): x is [string, string] => !!x[1]);

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Dato etiqueta="Eventos" valor={d.eventos.toLocaleString("es-MX")} />
        <Dato etiqueta="Usuarios" valor={d.usuarios.toLocaleString("es-MX")} />
        <Dato etiqueta="Primera vez" valor={fecha(d.primeraVez)} />
        <Dato etiqueta="Última vez" valor={fecha(d.ultimaVez)} />
      </div>

      <section>
        <h3 className="mb-1.5 text-sm font-semibold">Último evento <span className="font-normal text-muted-foreground">· {fecha(e.fecha)}</span></h3>
        {entorno.length > 0 ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {entorno.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-all font-mono">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">Sin datos del entorno.</p>
        )}
        {e.mensaje && !e.excepciones.length && <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{e.mensaje}</pre>}
      </section>

      {e.excepciones.map((x, i) => <Excepcion key={i} x={x} />)}

      {e.tags.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-sm font-semibold">Tags</h3>
          <div className="flex flex-wrap gap-1.5">
            {e.tags.map((t) => (
              <span key={t.clave} className="inline-flex max-w-full rounded-md border text-[11px]">
                <span className="border-r bg-muted px-1.5 py-0.5 text-muted-foreground">{t.clave}</span>
                <span className="truncate px-1.5 py-0.5 font-mono">{t.valor}</span>
              </span>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-sm font-semibold tabular-nums">{valor}</div>
      <div className="text-[11px] text-muted-foreground">{etiqueta}</div>
    </div>
  );
}

function Excepcion({ x }: { x: Detalle["evento"]["excepciones"][number] }) {
  // Por defecto solo el código del repo: los frames de librerías y del runtime
  // casi nunca dicen dónde está el problema.
  const propios = x.frames.filter((f) => f.propio);
  const [todos, setTodos] = useState(propios.length === 0);
  const frames = todos ? x.frames : propios;
  return (
    <section>
      <h3 className="text-sm font-semibold">Stack trace</h3>
      <p className="mt-1 break-words font-mono text-sm">
        <span className="font-semibold text-red-600 dark:text-red-400">{x.tipo}</span>
        {x.valor && <>: {x.valor}</>}
      </p>
      <p className="mb-2 text-[11px] text-muted-foreground">
        {x.manejado ? "Capturado por el código" : "No capturado"}
        {x.mecanismo && <> · {x.mecanismo}</>}
      </p>
      {frames.length > 0 ? (
        <ol className="divide-y overflow-hidden rounded-md border">
          {frames.map((f, i) => <Frame key={i} f={f} abierto={i === 0} />)}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">Sentry no recibió stack trace de este evento.</p>
      )}
      {propios.length > 0 && propios.length < x.frames.length && (
        <button type="button" onClick={() => setTodos(!todos)} className="mt-1.5 text-xs text-primary hover:underline">
          {todos ? "Solo el código del repo" : `Ver también ${x.frames.length - propios.length} frames de librerías`}
        </button>
      )}
    </section>
  );
}

function Frame({ f, abierto: inicial }: { f: FrameIssue; abierto: boolean }) {
  const [abierto, setAbierto] = useState(inicial && f.contexto.length > 0);
  const lugar = [f.linea, f.columna].filter((n) => n !== null).join(":");
  return (
    <li className={cn(!f.propio && "bg-muted/40 text-muted-foreground")}>
      <button
        type="button"
        onClick={() => setAbierto(!abierto)}
        disabled={!f.contexto.length}
        className="flex w-full items-start gap-1.5 px-3 py-1.5 text-left font-mono text-xs disabled:cursor-default"
      >
        <ChevronRight className={cn("mt-0.5 h-3 w-3 shrink-0 transition-transform", abierto && "rotate-90", !f.contexto.length && "invisible")} />
        <span className="min-w-0 break-all">
          <span className={cn(f.propio && "font-semibold")}>{f.archivo || "?"}</span>
          {lugar && <span className="text-muted-foreground">:{lugar}</span>}
          {f.funcion && <span className="text-muted-foreground"> en </span>}
          {f.funcion && <span className="text-sky-700 dark:text-sky-400">{f.funcion}</span>}
        </span>
      </button>
      {abierto && (
        <pre className="overflow-x-auto border-t bg-muted/60 py-1 text-[11px] leading-5">
          {f.contexto.map((c) => (
            <div key={c.n} className={cn("px-3", c.n === f.linea && "bg-red-100 font-semibold dark:bg-red-950/50")}>
              <span className="mr-3 inline-block w-8 select-none text-right text-muted-foreground">{c.n}</span>
              {c.l}
            </div>
          ))}
        </pre>
      )}
    </li>
  );
}
