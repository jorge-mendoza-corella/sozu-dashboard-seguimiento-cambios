/**
 * Pestaña "Tickets" del panel de GeorgIA: los tickets pendientes del portal de
 * sozu-admin asignados a quien está logueado (pipelines de Sistemas; Nuevo, En
 * revisión, En lista de espera; por prioridad y antigüedad).
 *
 * A la izquierda la lista con filtros; a la derecha el detalle: datos, evidencias,
 * la investigación de GeorgIA (en qué repos y dónde trabajar), el .md para
 * Claude Code (editable, se copia con un botón y registra el ticket como enviado)
 * y el botón para cerrar el ticket en el portal.
 */
import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle, Check, CheckCircle2, Copy, ExternalLink, FileAudio, FileText, FolderGit2, Image as ImageIcon, Inbox, Loader2,
  Paperclip, RefreshCw, RotateCcw, Search, Sparkles, User, Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { mensajeDeError } from "@/lib/agenteRepos";
import {
  analizarTicket, cerrarTicketPortal, marcarEnviado, misEnviados, notaDeCierre, promptDeTicket,
  type AnalisisTicket, type TicketAgente, type TicketEnviado,
} from "@/lib/agenteTickets";

interface Props {
  email: string;
  tickets: TicketAgente[] | null;
  cargando: boolean;
  error: string | null;
  revisado: string | null;
  onRefrescar: () => void;
  /** Ticket cuyo diálogo de cierre hay que abrir (GeorgIA avisó que ya está en PRD). */
  cerrarAhora: string | null;
  onCerrarAtendido: () => void;
}

const fecha = (iso: string) =>
  new Date(iso).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Mexico_City" });

const COLOR_PRIORIDAD: Record<string, string> = {
  alta: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
  media: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  baja: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
};

const sinAcentos = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const unicos = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();

export function TicketsAgente({ email, tickets, cargando, error, revisado, onRefrescar, cerrarAhora, onCerrarAtendido }: Props) {
  const [elegido, setElegido] = useState<string | null>(null);
  const [fPipeline, setFPipeline] = useState("");
  const [fEtapa, setFEtapa] = useState("");
  const [fPrioridad, setFPrioridad] = useState("");
  const [fTexto, setFTexto] = useState("");
  const [enviados, setEnviados] = useState<TicketEnviado[]>([]);
  const [cerrando, setCerrando] = useState<TicketAgente | null>(null);

  useEffect(() => {
    misEnviados(email).then(setEnviados).catch(() => setEnviados([]));
  }, [email, tickets]);

  // GeorgIA avisó que un ticket ya llegó a PRD: queda seleccionado y con el cierre abierto.
  const pedido = cerrarAhora && tickets ? tickets.find((x) => x.id === cerrarAhora) ?? null : null;
  const dialogoCierre = cerrando ?? pedido;
  const terminarCierre = () => {
    setCerrando(null);
    if (cerrarAhora) onCerrarAtendido();
  };

  const filtrados = useMemo(() => {
    const q = sinAcentos(fTexto.trim());
    return (tickets ?? []).filter((t) =>
      (!fPipeline || t.pipeline === fPipeline) &&
      (!fEtapa || t.etapa === fEtapa) &&
      (!fPrioridad || (fPrioridad === "sin" ? !t.prioridad : t.prioridad === fPrioridad)) &&
      (!q || sinAcentos(`${t.folio} ${t.titulo} ${t.abiertoPor ?? ""} ${t.descripcion}`).includes(q)));
  }, [tickets, fPipeline, fEtapa, fPrioridad, fTexto]);

  const actual = filtrados.find((t) => t.id === (elegido ?? cerrarAhora)) ?? filtrados[0] ?? null;
  const enviadoDe = (t: TicketAgente) => enviados.find((e) => e.ticketId === t.id) ?? null;
  const claseSelect = "h-7 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-[11px]";

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex max-h-72 shrink-0 flex-col border-b md:max-h-none md:w-80 md:border-b-0 md:border-r">
        <div className="flex h-11 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
          <span className="flex-1">
            {tickets ? `${filtrados.length} de ${tickets.length} pendiente${tickets.length === 1 ? "" : "s"}` : "Tickets"}
            {revisado && ` · ${new Date(revisado).toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit" })}`}
          </span>
          <button type="button" onClick={onRefrescar} disabled={cargando} className="rounded p-1 hover:bg-muted disabled:opacity-50" title="Revisar ahora">
            <RefreshCw className={cn("h-3.5 w-3.5", cargando && "animate-spin")} />
          </button>
        </div>
        {/* Filtros */}
        <div className="space-y-1.5 border-b p-2">
          <div className="flex items-center gap-1.5 rounded-md border bg-background px-2">
            <Search className="h-3 w-3 text-muted-foreground" />
            <input value={fTexto} onChange={(e) => setFTexto(e.target.value)} placeholder="Folio, asunto, quién lo abrió…" className="h-7 w-full bg-transparent text-[11px] outline-none" />
          </div>
          <div className="flex gap-1.5">
            <select value={fPipeline} onChange={(e) => setFPipeline(e.target.value)} className={claseSelect} title="Pipeline">
              <option value="">Pipeline: todos</option>
              {unicos((tickets ?? []).map((t) => t.pipeline)).map((p) => <option key={p} value={p}>{p.replace(/^SOZU - Sistemas\s*/i, "")}</option>)}
            </select>
            <select value={fEtapa} onChange={(e) => setFEtapa(e.target.value)} className={claseSelect} title="Etapa">
              <option value="">Etapa: todas</option>
              {unicos((tickets ?? []).map((t) => t.etapa)).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={fPrioridad} onChange={(e) => setFPrioridad(e.target.value)} className={claseSelect} title="Prioridad">
              <option value="">Prioridad</option>
              <option value="alta">Alta</option>
              <option value="media">Media</option>
              <option value="baja">Baja</option>
              <option value="sin">Sin prioridad</option>
            </select>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && (
            <p className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}
            </p>
          )}
          {!tickets && cargando && <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}
          {tickets && filtrados.length === 0 && (
            <p className="flex flex-col items-center gap-2 py-8 text-center text-xs text-muted-foreground">
              <Inbox className="h-6 w-6" /> {tickets.length ? "Ningún ticket con esos filtros." : "No tienes tickets pendientes."}
            </p>
          )}
          {filtrados.map((t) => {
            const env = enviadoDe(t);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setElegido(t.id)}
                className={cn("mb-1 w-full rounded-md px-2.5 py-2 text-left text-xs transition-colors", actual?.id === t.id ? "bg-primary/10" : "hover:bg-muted")}
              >
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-[10px] text-muted-foreground">{t.folio}</span>
                  {t.prioridad && <span className={cn("rounded px-1 text-[9px] font-semibold uppercase", COLOR_PRIORIDAD[t.prioridad])}>{t.prioridad}</span>}
                  {env && <span className="rounded bg-violet-100 px-1 text-[9px] font-semibold text-violet-700 dark:bg-violet-950/40 dark:text-violet-300" title="Ya se pasó a Claude">{env.prs.length ? "en PRD" : "en Claude"}</span>}
                  <span className="ml-auto text-[10px] text-muted-foreground">{t.etapa}</span>
                </span>
                <span className={cn("mt-0.5 block truncate font-medium", actual?.id === t.id && "text-primary")}>{t.titulo}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {t.abiertoPor ?? "—"} · {new Date(t.abiertoEn).toLocaleDateString("es-MX", { day: "numeric", month: "short" })}
                </span>
              </button>
            );
          })}
        </div>
      </aside>
      <section className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        {actual ? (
          <DetalleTicket
            key={actual.id}
            t={actual}
            email={email}
            enviado={enviadoDe(actual)}
            onEnviado={() => misEnviados(email).then(setEnviados).catch(() => {})}
            onCerrar={() => setCerrando(actual)}
          />
        ) : !cargando && !error && <p className="py-10 text-center text-sm text-muted-foreground">Elige un ticket.</p>}
      </section>
      {dialogoCierre && (
        <CerrarTicketDialog
          key={dialogoCierre.id}
          t={dialogoCierre}
          enviado={enviadoDe(dialogoCierre)}
          onCancelar={terminarCierre}
          onCerrado={() => { terminarCierre(); onRefrescar(); }}
        />
      )}
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

function DetalleTicket({ t, email, enviado, onEnviado, onCerrar }: {
  t: TicketAgente;
  email: string;
  enviado: TicketEnviado | null;
  onEnviado: () => void;
  onCerrar: () => void;
}) {
  const [analisis, setAnalisis] = useState<AnalisisTicket | null>(null);
  const [analizando, setAnalizando] = useState(false);
  const [errorAnalisis, setErrorAnalisis] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string>(() => leerBorrador(t.id) ?? "");
  const [copiado, setCopiado] = useState(false);

  const investigar = async (forzar: boolean) => {
    setAnalizando(true);
    setErrorAnalisis(null);
    try {
      setAnalisis((await analizarTicket(t.id, forzar)).analisis);
    } catch (e) {
      setErrorAnalisis(mensajeDeError(e));
    } finally {
      setAnalizando(false);
    }
  };
  // Se investiga al abrir el ticket (o se trae la investigación guardada).
  useEffect(() => {
    let vivo = true;
    analizarTicket(t.id, false)
      .then((r) => vivo && setAnalisis(r.analisis))
      .catch((e) => vivo && setErrorAnalisis(mensajeDeError(e)))
      .finally(() => vivo && setAnalizando(false));
    return () => { vivo = false; };
  }, [t.id]);
  const cargandoAnalisis = analizando || (!analisis && !errorAnalisis);

  const generado = useMemo(() => promptDeTicket(t, analisis), [t, analisis]);
  const editado = prompt !== "" && prompt !== generado;
  const valor = prompt || generado;

  const copiar = async () => {
    await navigator.clipboard.writeText(valor);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 1600);
    // Copiar = pasarlo a Claude: desde aquí se vigilan los deploys de este ticket.
    if (!enviado) await marcarEnviado(email, t).then(onEnviado).catch(() => {});
  };

  const otros = t.asignados.filter((a) => !a.soyYo);
  const imagenes = t.evidencias.filter((e) => e.tipo === "imagen");

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{t.folio}</span>
            {t.pipeline && <span>{t.pipeline}</span>}
            {t.etapa && <span className="rounded-full bg-muted px-2 py-0.5">{t.etapa}</span>}
            {t.prioridad && <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", COLOR_PRIORIDAD[t.prioridad])}>{t.prioridad}</span>}
          </p>
          <h2 className="mt-1 text-lg font-semibold leading-snug">{t.titulo}</h2>
        </div>
        <button
          type="button"
          onClick={onCerrar}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-emerald-500/50 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-300"
          title="Pasar el ticket a Resuelto en el portal, con nota de seguimiento"
        >
          <CheckCircle2 className="h-4 w-4" /> Cerrar ticket
        </button>
      </header>

      <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
        <Dato icono={User} etiqueta="Abierto por">{t.abiertoPor ?? "—"}</Dato>
        <Dato icono={FileText} etiqueta="Fecha">{fecha(t.abiertoEn)}</Dato>
        <Dato icono={Users} etiqueta="Para">
          <span className="flex flex-wrap gap-1">
            {t.asignados.map((a) => (
              <span key={a.email ?? a.nombre} className={cn("rounded-full px-2 py-0.5 text-[11px]", a.soyYo ? "bg-primary/15 font-semibold text-primary" : "bg-muted")} title={a.email ?? undefined}>
                {a.soyYo ? `${a.nombre} (tú)` : a.nombre}
              </span>
            ))}
          </span>
          {otros.length > 0 && <span className="mt-1 block text-[11px] text-muted-foreground">También va para: {otros.map((o) => o.nombre).join(", ")}</span>}
        </Dato>
        {(t.categoria || t.proyecto) && <Dato icono={Inbox} etiqueta="Categoría">{[t.categoria, t.proyecto].filter(Boolean).join(" · ")}</Dato>}
        {t.url && (
          <Dato icono={ExternalLink} etiqueta="Portal">
            <a href={t.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">Abrir {t.folio} en el portal de tickets</a>
            <span className="block text-[11px] text-muted-foreground">Todos → Mis tickets → folio {t.numero}. Necesitas tener sesión iniciada en el admin.</span>
          </Dato>
        )}
        {enviado && enviado.prs.length > 0 && (
          <Dato icono={FolderGit2} etiqueta="En PRD">
            {enviado.prs.map((p) => (
              <a key={`${p.repo}${p.pr}`} href={p.url} target="_blank" rel="noreferrer" className="mr-2 text-primary hover:underline">{p.repo} #{p.pr}</a>
            ))}
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
        ) : <p className="text-sm text-muted-foreground">Sin descripción.</p>}
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Paperclip className="h-3.5 w-3.5" /> Evidencias ({t.evidencias.length})
        </h3>
        {t.evidencias.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin evidencias adjuntas.</p>
        ) : (
          <>
            {imagenes.length > 0 && (
              <p className="mb-2 text-[11px] text-muted-foreground">
                Para Claude Code: pega el .md y luego cada imagen con <strong>Copiar imagen</strong> → Ctrl/Cmd+V, en el orden numerado.
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {t.evidencias.map((e, i) => <Evidencia key={`${e.url}${i}`} e={e} n={e.tipo === "imagen" ? imagenes.indexOf(e) + 1 : null} />)}
            </div>
          </>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="flex flex-1 items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5" /> Dónde trabajar (investigación de GeorgIA)
          </h3>
          <button type="button" onClick={() => void investigar(true)} disabled={analizando} className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50" title="Volver a investigar">
            <RefreshCw className={cn("h-3 w-3", analizando && "animate-spin")} /> Investigar de nuevo
          </button>
        </div>
        {cargandoAnalisis ? (
          <p className="flex items-center gap-2 rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> GeorgIA está revisando docs y código… (puede tardar un minuto)
          </p>
        ) : errorAnalisis ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{errorAnalisis}</p>
        ) : analisis && (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3 text-sm">
            {analisis.resumen && <p>{analisis.resumen}</p>}
            {analisis.repos.length ? analisis.repos.map((r) => (
              <div key={r.repo} className="rounded-md bg-background p-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold"><FolderGit2 className="h-3.5 w-3.5 text-primary" />{r.repo}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{r.motivo}</p>
                {r.rutas.length > 0 && (
                  <ul className="mt-1 space-y-0.5">{r.rutas.map((p) => <li key={p} className="truncate font-mono text-[11px]">{p}</li>)}</ul>
                )}
              </div>
            )) : <p className="text-xs text-muted-foreground">No parece un cambio de código.</p>}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Prompt para Claude (.md)</h3>
          {editado && (
            <button type="button" onClick={() => { setPrompt(""); guardarBorrador(t.id, null); }} className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground hover:bg-muted" title="Volver al prompt generado">
              <RotateCcw className="h-3 w-3" /> Restaurar
            </button>
          )}
          <button type="button" onClick={() => void copiar()} disabled={cargandoAnalisis} className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50" title={cargandoAnalisis ? "Espera a que termine la investigación" : undefined}>
            {copiado ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copiado ? "Copiado" : "Copiar .md"}
          </button>
        </div>
        <textarea
          value={valor}
          onChange={(e) => { setPrompt(e.target.value); guardarBorrador(t.id, e.target.value); }}
          spellCheck={false}
          rows={18}
          className="w-full resize-y rounded-lg border bg-muted/30 p-3 font-mono text-[12px] leading-relaxed outline-none focus:ring-2 focus:ring-ring"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          {editado ? "Editado: tus cambios se guardan en este navegador." : "Generado del ticket y la investigación; edítalo libremente."}{" "}
          Pégalo en Claude Code dentro del repo. Los commits llevarán el trailer <code>Ticket-SOZU</code>: cuando su PR llegue a PRD, GeorgIA te avisa para cerrarlo.
        </p>
      </div>
    </div>
  );
}

/** Copia una imagen al portapapeles como PNG (es el único formato que el portapapeles acepta en todos lados). */
async function copiarImagen(url: string) {
  const blob = await (await fetch(url, { mode: "cors" })).blob();
  let png = blob;
  if (blob.type !== "image/png") {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0);
    png = await new Promise<Blob>((ok, mal) => canvas.toBlob((b) => (b ? ok(b) : mal(new Error("png"))), "image/png"));
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

function Evidencia({ e, n }: { e: TicketAgente["evidencias"][number]; n: number | null }) {
  const [estado, setEstado] = useState<"idle" | "copiando" | "ok" | "error">("idle");
  if (!e.url) return <div className="rounded-md border p-2 text-xs text-muted-foreground">{e.nombre}</div>;
  if (e.tipo === "imagen") {
    return (
      <div className="overflow-hidden rounded-md border">
        <a href={e.url} target="_blank" rel="noreferrer" title={e.nombre}>
          <img src={e.url} alt={e.nombre} loading="lazy" className="aspect-video w-full object-cover transition-opacity hover:opacity-90" />
        </a>
        <div className="flex items-center gap-1 px-2 py-1">
          <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-[10px] text-muted-foreground"><ImageIcon className="h-3 w-3 shrink-0" />{n}. {e.nombre}</span>
          <button
            type="button"
            onClick={async () => {
              setEstado("copiando");
              try { await copiarImagen(e.url!); setEstado("ok"); } catch { setEstado("error"); }
              setTimeout(() => setEstado("idle"), 1800);
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10"
            title="Copiar la imagen para pegarla en Claude Code"
          >
            {estado === "copiando" ? <Loader2 className="h-3 w-3 animate-spin" /> : estado === "ok" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {estado === "ok" ? "Copiada" : estado === "error" ? "No se pudo" : "Copiar imagen"}
          </button>
        </div>
      </div>
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

/** Confirmación de cierre: nota de seguimiento editable (por repo y PR, en puntos). */
function CerrarTicketDialog({ t, enviado, onCancelar, onCerrado }: {
  t: TicketAgente;
  enviado: TicketEnviado | null;
  onCancelar: () => void;
  onCerrado: () => void;
}) {
  const [nota, setNota] = useState(() => (enviado?.prs.length ? notaDeCierre(enviado.prs) : "Listo, favor de validar.\n\n- "));
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);

  const cerrar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const r = await cerrarTicketPortal(t.id, nota);
      setHecho(r.etapa);
      setTimeout(onCerrado, 1400);
    } catch (e) {
      setError(mensajeDeError(e));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(v) => !v && !enviando && onCancelar()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          // Centrado con inset + margin auto: la animación de entrada usa transform.
          className="fixed inset-0 z-[60] m-auto h-fit max-h-[90vh] w-[min(560px,calc(100vw-32px))] overflow-y-auto rounded-2xl border bg-background p-5 shadow-2xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          aria-describedby={undefined}
        >
          <Dialog.Title className="text-base font-semibold">¿Cerrar {t.folio}?</Dialog.Title>
          <p className="mt-1 text-sm text-muted-foreground">{t.titulo}</p>
          {hecho ? (
            <p className="mt-4 flex items-center gap-2 rounded-md bg-emerald-50 p-3 text-sm font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4" /> Listo: el ticket quedó en "{hecho}" con la nota de seguimiento.
            </p>
          ) : (
            <>
              <p className="mt-4 text-xs text-muted-foreground">
                Pasa a <strong>Resuelto</strong> en el portal y deja esta nota en el seguimiento (a tu nombre). Puntos cortos:
              </p>
              <textarea
                value={nota}
                onChange={(e) => setNota(e.target.value)}
                rows={10}
                className="mt-2 w-full resize-y rounded-lg border bg-muted/30 p-3 font-mono text-[12px] leading-relaxed outline-none focus:ring-2 focus:ring-ring"
              />
              {!enviado?.prs.length && (
                <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                  No hay PRs a main ligados a este ticket todavía; escribe tú lo que se actualizó.
                </p>
              )}
              {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={onCancelar} disabled={enviando} className="h-9 rounded-md px-3 text-sm font-medium hover:bg-muted">No, todavía no</button>
                <button type="button" onClick={() => void cerrar()} disabled={enviando || !nota.trim()} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-sm font-medium text-white disabled:opacity-50">
                  {enviando && <Loader2 className="h-4 w-4 animate-spin" />} Sí, cerrar ticket
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
