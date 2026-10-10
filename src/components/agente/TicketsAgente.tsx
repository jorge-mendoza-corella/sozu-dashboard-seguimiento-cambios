/**
 * Pestaña "Tickets" del panel del agente: los tickets pendientes del portal de
 * sozu-admin asignados a quien está logueado.
 *
 * A la izquierda la lista; a la derecha el detalle (descripción, evidencias,
 * quién lo abrió, cuándo, a quién va) y un prompt en Markdown para pasárselo a
 * Claude Code en el repo que toca: editable, se guarda en este navegador y se
 * copia con un botón.
 */
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle, Check, Copy, ExternalLink, FileAudio, FileText, Image as ImageIcon, Inbox, Loader2, Paperclip,
  RefreshCw, RotateCcw, User, Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useRepos } from "@/hooks/useProjectsRepos";
import { promptDeTicket, type TicketAgente } from "@/lib/agenteTickets";

interface Props {
  tickets: TicketAgente[] | null;
  cargando: boolean;
  error: string | null;
  revisado: string | null;
  onRefrescar: () => void;
}

const fecha = (iso: string) =>
  new Date(iso).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Mexico_City" });

const COLOR_PRIORIDAD: Record<string, string> = {
  alta: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
  media: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  baja: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
};

export function TicketsAgente({ tickets, cargando, error, revisado, onRefrescar }: Props) {
  const [elegido, setElegido] = useState<string | null>(null);
  const actual = tickets?.find((t) => t.id === elegido) ?? tickets?.[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex max-h-56 shrink-0 flex-col border-b md:max-h-none md:w-80 md:border-b-0 md:border-r">
        <div className="flex h-11 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
          <span className="flex-1">
            {tickets ? `${tickets.length} pendiente${tickets.length === 1 ? "" : "s"}` : "Tickets"}
            {revisado && ` · revisado ${new Date(revisado).toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit" })}`}
          </span>
          <button type="button" onClick={onRefrescar} disabled={cargando} className="rounded p-1 hover:bg-muted disabled:opacity-50" title="Revisar ahora">
            <RefreshCw className={cn("h-3.5 w-3.5", cargando && "animate-spin")} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && (
            <p className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}
            </p>
          )}
          {!tickets && cargando && <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}
          {tickets?.length === 0 && (
            <p className="flex flex-col items-center gap-2 py-8 text-center text-xs text-muted-foreground">
              <Inbox className="h-6 w-6" /> No tienes tickets pendientes.
            </p>
          )}
          {tickets?.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setElegido(t.id)}
              className={cn(
                "mb-1 w-full rounded-md px-2.5 py-2 text-left text-xs transition-colors",
                actual?.id === t.id ? "bg-primary/10" : "hover:bg-muted",
              )}
            >
              <span className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-muted-foreground">{t.folio}</span>
                {t.prioridad && <span className={cn("rounded px-1 text-[9px] font-semibold uppercase", COLOR_PRIORIDAD[t.prioridad])}>{t.prioridad}</span>}
                <span className="ml-auto text-[10px] text-muted-foreground">{t.etapa}</span>
              </span>
              <span className={cn("mt-0.5 block truncate font-medium", actual?.id === t.id && "text-primary")}>{t.titulo}</span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {t.abiertoPor ?? "—"} · {new Date(t.abiertoEn).toLocaleDateString("es-MX", { day: "numeric", month: "short" })}
              </span>
            </button>
          ))}
        </div>
      </aside>
      <section className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        {actual ? <DetalleTicket key={actual.id} t={actual} /> : !cargando && !error && (
          <p className="py-10 text-center text-sm text-muted-foreground">Elige un ticket.</p>
        )}
      </section>
    </div>
  );
}

function Dato({ icono: Icono, etiqueta, children }: { icono: typeof User; etiqueta: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <Icono className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="w-24 shrink-0 text-muted-foreground">{etiqueta}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

const claveBorrador = (id: string) => `agente-ticket-prompt:${id}`;
const leerBorrador = (id: string) => {
  try { return localStorage.getItem(claveBorrador(id)); } catch { return null; }
};
const guardarBorrador = (id: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(claveBorrador(id));
    else localStorage.setItem(claveBorrador(id), v);
  } catch { /* sin storage: el borrador vive solo en memoria */ }
};

function DetalleTicket({ t }: { t: TicketAgente }) {
  const { data: repos = [] } = useRepos();
  const [repoId, setRepoId] = useState("");
  const repo = repos.find((r) => r.id === repoId) ?? null;
  const generado = useMemo(() => promptDeTicket(t, repo), [t, repo]);
  const [prompt, setPrompt] = useState<string>(() => leerBorrador(t.id) ?? "");
  const editado = prompt !== "" && prompt !== generado;
  const valor = prompt || generado;
  const [copiado, setCopiado] = useState(false);

  // Cambiar de repo regenera el prompt si no se había editado a mano.
  useEffect(() => {
    if (!editado) guardarBorrador(t.id, null);
  }, [editado, t.id]);

  const copiar = async () => {
    await navigator.clipboard.writeText(valor);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 1600);
  };

  const otros = t.asignados.filter((a) => !a.soyYo);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <header>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{t.folio}</span>
          {t.pipeline && <span>{t.pipeline}</span>}
          {t.etapa && <span className="rounded-full bg-muted px-2 py-0.5">{t.etapa}</span>}
          {t.prioridad && <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", COLOR_PRIORIDAD[t.prioridad])}>{t.prioridad}</span>}
        </p>
        <h2 className="mt-1 text-lg font-semibold leading-snug">{t.titulo}</h2>
      </header>

      <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
        <Dato icono={User} etiqueta="Abierto por">{t.abiertoPor ?? "—"}</Dato>
        <Dato icono={FileText} etiqueta="Fecha">{fecha(t.abiertoEn)}</Dato>
        <Dato icono={Users} etiqueta="Para">
          <span className="flex flex-wrap gap-1">
            {t.asignados.map((a) => (
              <span
                key={a.email ?? a.nombre}
                className={cn("rounded-full px-2 py-0.5 text-[11px]", a.soyYo ? "bg-primary/15 font-semibold text-primary" : "bg-muted")}
                title={a.email ?? undefined}
              >
                {a.soyYo ? `${a.nombre} (tú)` : a.nombre}
              </span>
            ))}
          </span>
          {otros.length > 0 && (
            <span className="mt-1 block text-[11px] text-muted-foreground">
              También va para: {otros.map((o) => o.nombre).join(", ")}
            </span>
          )}
        </Dato>
        {(t.categoria || t.proyecto) && (
          <Dato icono={Inbox} etiqueta="Categoría">{[t.categoria, t.proyecto].filter(Boolean).join(" · ")}</Dato>
        )}
        {t.url && (
          <Dato icono={ExternalLink} etiqueta="Portal">
            <a href={t.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">Abrir "Mis tickets" en sozu-admin</a>
          </Dato>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Descripción</h3>
        {t.descripcion.trim() ? (
          <div className="prose prose-sm max-w-none dark:prose-invert prose-a:text-primary">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
              {t.descripcion}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Sin descripción.</p>
        )}
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Paperclip className="h-3.5 w-3.5" /> Evidencias ({t.evidencias.length})
        </h3>
        {t.evidencias.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin evidencias adjuntas.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {t.evidencias.map((e, i) => (
              <Evidencia key={`${e.url}${i}`} e={e} />
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Prompt para Claude (.md)</h3>
          <select
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
            className="h-7 rounded-md border bg-background px-2 text-xs"
            title="Repositorio donde se debe trabajar el ticket"
          >
            <option value="">Repo: elegir…</option>
            {repos.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          {editado && (
            <button
              type="button"
              onClick={() => { setPrompt(""); guardarBorrador(t.id, null); }}
              className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground hover:bg-muted"
              title="Volver al prompt generado"
            >
              <RotateCcw className="h-3 w-3" /> Restaurar
            </button>
          )}
          <button
            type="button"
            onClick={() => void copiar()}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground"
          >
            {copiado ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copiado ? "Copiado" : "Copiar .md"}
          </button>
        </div>
        <textarea
          value={valor}
          onChange={(e) => { setPrompt(e.target.value); guardarBorrador(t.id, e.target.value); }}
          spellCheck={false}
          rows={16}
          className="w-full resize-y rounded-lg border bg-muted/30 p-3 font-mono text-[12px] leading-relaxed outline-none focus:ring-2 focus:ring-ring"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          {editado ? "Editado: tus cambios se guardan en este navegador." : "Generado del ticket; edítalo libremente antes de copiarlo."} Pégalo en Claude Code
          dentro del repo{repo ? ` ${repo.label}` : ""}.
        </p>
      </div>
    </div>
  );
}

function Evidencia({ e }: { e: TicketAgente["evidencias"][number] }) {
  if (!e.url) return <div className="rounded-md border p-2 text-xs text-muted-foreground">{e.nombre}</div>;
  if (e.tipo === "imagen") {
    return (
      <a href={e.url} target="_blank" rel="noreferrer" className="group block overflow-hidden rounded-md border" title={e.nombre}>
        <img src={e.url} alt={e.nombre} loading="lazy" className="aspect-video w-full object-cover transition-opacity group-hover:opacity-90" />
        <span className="flex items-center gap-1 truncate px-2 py-1 text-[10px] text-muted-foreground"><ImageIcon className="h-3 w-3 shrink-0" />{e.nombre}</span>
      </a>
    );
  }
  if (e.tipo === "audio") {
    return (
      <div className="col-span-2 rounded-md border p-2">
        <p className="mb-1 flex items-center gap-1 truncate text-[10px] text-muted-foreground"><FileAudio className="h-3 w-3" />{e.nombre}</p>
        <audio controls src={e.url} className="h-8 w-full" />
      </div>
    );
  }
  return (
    <a href={e.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md border p-2 text-xs hover:bg-muted">
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate">{e.nombre}</span>
    </a>
  );
}
