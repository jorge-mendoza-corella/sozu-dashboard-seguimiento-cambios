/**
 * Pestaña "Tickets" del panel de GeorgIA: los tickets pendientes del portal de
 * sozu-admin asignados a quien está logueado (pipelines con «Mostrar el asistente»
 * prendido; Nuevo, En revisión, En lista de espera; por prioridad y antigüedad).
 *
 * A la izquierda la lista con filtros; a la derecha el detalle: datos, evidencias,
 * el .md para Claude Code (editable) con "Mandar a Claude" (abre un issue en el
 * repo orquestador y Claude Code abre los PRs hacia dev) o copiarlo a mano, y el
 * botón para cerrar el ticket en el portal. La investigación por API ya no corre;
 * la que algún ticket ya tenga se muestra como solo lectura.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle, Bot, ChevronDown, Check, CheckCircle2, Copy, ExternalLink, FileAudio, FileText, FileVideo, FolderGit2, Image as ImageIcon, Inbox, Loader2,
  Link2, Paperclip, Plus, RefreshCw, RotateCcw, Search, Send, Siren, Sparkles, User, Users, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { mensajeDeError } from "@/lib/agenteRepos";
import { GeorgIAPensando } from "./GeorgIAPensando";
import { AvisoTokenClaude, ConectarClaude, EstadoTokenClaude } from "./AvisoTokenClaude";
import { useTokenClaude } from "@/hooks/useTokenClaude";
import { BarraClaudeMini, EstadoClaudeMini, SeguimientoClaude } from "./SeguimientoClaude";
import {
  analisisGuardado, avancePrs, buscarPrsTicket, cerrarTicketPortal, COLOR_PR, consultaSeguimiento, convencionPrs, desligarTicket, esSoloFecha, ETIQUETA_PR, fechaTicket, guardarBorradorMd, leerBorradorMd, mandarAClaude, marcarEnviado, misEnviados, notaDeCierre, promptDeTicket, relacionarTicket,
  type AnalisisTicket, type PrExterno, type RazonMatch, type TicketAgente, type TicketEnviado,
} from "@/lib/agenteTickets";

interface Props {
  email: string;
  tickets: TicketAgente[] | null;
  cargando: boolean;
  error: string | null;
  revisado: string | null;
  onRefrescar: () => void;
  /** Ticket donde Claude espera respuesta: se abre y se enfoca el cuadro para contestar. */
  responderAhora: string | null;
  onResponderAtendido: () => void;
  /** Ticket cuyo diálogo de cierre hay que abrir (GeorgIA avisó que ya está en PRD). */
  cerrarAhora: string | null;
  onCerrarAtendido: () => void;
  /** El ticket que se está viendo (para poner el avatar de quien lo levantó). */
  onTicketVisto?: (t: TicketAgente | null) => void;
  /** Permiso "Mandar a Claude": sin él, el .md se puede copiar pero no mandar. */
  puedeMandarClaude: boolean;
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

/**
 * Sin ticket abierto: si quien entra aún no conecta su cuenta de Claude, aquí
 * mismo puede hacerlo (no tiene que esperar a tener un ticket para eso).
 */
function SinTicketElegido({ puedeMandarClaude }: { puedeMandarClaude: boolean }) {
  const token = useTokenClaude();
  if (puedeMandarClaude && token.data && !token.data.conectado) return <ConectarClaude className="m-1" />;
  return <p className="py-10 text-center text-sm text-muted-foreground">Elige un ticket.</p>;
}

export function TicketsAgente({
  email, tickets, cargando, error, revisado, onRefrescar, cerrarAhora, onCerrarAtendido, responderAhora, onResponderAtendido,
  onTicketVisto, puedeMandarClaude,
}: Props) {
  const [elegido, setElegido] = useState<string | null>(null);
  const [fPipeline, setFPipeline] = useState("");
  const [fEtapa, setFEtapa] = useState("");
  const [fPrioridad, setFPrioridad] = useState("");
  const [fTexto, setFTexto] = useState("");
  const [enviados, setEnviados] = useState<TicketEnviado[]>([]);
  const [cerrando, setCerrando] = useState<TicketAgente | null>(null);
  // Celular: primero la lista sola; al tocar un ticket, su detalle a pantalla completa.
  const [detalleMovil, setDetalleMovil] = useState(false);

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

  // Mismo seguimiento que leen los renglones (misma caché): no agrega llamadas.
  const conIssue = useMemo(
    () => (tickets ?? []).filter((t) => enviados.some((e) => e.ticketId === t.id && e.issue && !e.listo)),
    [tickets, enviados],
  );
  const seguimientos = useQueries({ queries: conIssue.map((t) => consultaSeguimiento(t.id)) });
  const clavePrs = seguimientos
    .map((q, i) => (q.data?.estado === "terminado" && avancePrs(q.data.prs).total > 0 ? conIssue[i].id : ""))
    .join(",");
  const conPrs = useMemo(() => {
    const ids = new Set(clavePrs.split(",").filter(Boolean));
    for (const e of enviados) if (e.listo) ids.add(e.ticketId);
    return ids;
  }, [clavePrs, enviados]);

  const filtrados = useMemo(() => {
    const q = sinAcentos(fTexto.trim());
    return (tickets ?? []).filter((t) =>
      (!fPipeline || t.pipeline === fPipeline) &&
      (!fEtapa || t.etapa === fEtapa) &&
      (!fPrioridad || (fPrioridad === "sin" ? !t.prioridad : t.prioridad === fPrioridad)) &&
      (!q || sinAcentos(`${t.folio} ${t.titulo} ${t.abiertoPor ?? ""} ${t.descripcion}`).includes(q)))
      // Arriba queda siempre trabajo: los que ya tienen sus PRs (Claude terminó y
      // solo falta revisarlos/desplegarlos, o ya están en PRD) bajan al final.
      // sort es estable: dentro de cada grupo se respeta el orden que trae la lista.
      .sort((a, b) => Number(conPrs.has(a.id)) - Number(conPrs.has(b.id)));
  }, [tickets, fPipeline, fEtapa, fPrioridad, fTexto, conPrs]);

  // Lo que pide GeorgIA (contestar o cerrar) manda sobre lo elegido a mano. Se
  // busca en todos los tickets, no solo en los filtrados: un filtro no lo esconde.
  const pedidoPorGeorgia = responderAhora ?? cerrarAhora;
  const actual = (pedidoPorGeorgia && (tickets ?? []).find((t) => t.id === pedidoPorGeorgia))
    || filtrados.find((t) => t.id === elegido) || filtrados[0] || null;
  useEffect(() => { onTicketVisto?.(actual); }, [actual, onTicketVisto]);
  const respuestaAtendida = useCallback(() => {
    if (responderAhora) setElegido(responderAhora);
    onResponderAtendido();
  }, [responderAhora, onResponderAtendido]);
  const enviadoDe = (t: TicketAgente) => enviados.find((e) => e.ticketId === t.id) ?? null;
  const claseSelect = "h-7 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-[11px]";

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside
        className={cn(
          "min-h-0 flex-1 flex-col md:flex md:w-80 md:flex-none md:border-r",
          detalleMovil || pedidoPorGeorgia ? "hidden" : "flex",
        )}
      >
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
                onClick={() => { setElegido(t.id); setDetalleMovil(true); }}
                className={cn("mb-1 w-full rounded-md px-2.5 py-2 text-left text-xs transition-colors", actual?.id === t.id ? "bg-primary/10" : "hover:bg-muted")}
              >
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-[10px] text-muted-foreground">{t.folio}</span>
                  {t.prioridad && <span className={cn("rounded px-1 text-[9px] font-semibold uppercase", COLOR_PRIORIDAD[t.prioridad])}>{t.prioridad}</span>}
                  {env && (env.listo
                    ? <span className="rounded bg-emerald-100 px-1 text-[9px] font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" title="Todo en PRD: ya se puede cerrar">en PRD</span>
                    : env.issue
                      ? <EstadoClaudeMini ticketId={t.id} />
                      : <span className="rounded bg-violet-100 px-1 text-[9px] font-semibold text-violet-700 dark:bg-violet-950/40 dark:text-violet-300" title="Se copió el .md para Claude">en Claude</span>)}
                  {t.sentry && (
                    <span
                      className="inline-flex items-center gap-0.5 rounded bg-red-100 px-1 text-[9px] font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-300"
                      title={`Ligado al issue ${t.sentry.shortId} de Sentry: al cerrar el ticket se resuelve también`}
                    >
                      <Siren className="h-2.5 w-2.5" /> Sentry
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-muted-foreground">{t.etapa}</span>
                </span>
                <span className={cn("mt-0.5 block truncate font-medium", actual?.id === t.id && "text-primary")}>{t.titulo}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {t.abiertoPor ?? "—"} · {fechaTicket(t.abiertoEn, "dia")}
                </span>
                {env?.issue && !env.listo && <BarraClaudeMini ticketId={t.id} />}
              </button>
            );
          })}
        </div>
        <GeorgIAPensando pendientes={tickets?.length ?? 0} />
      </aside>
      <section
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 md:block md:py-5",
          detalleMovil || pedidoPorGeorgia ? "block" : "hidden",
        )}
      >
        {/* Regresar a la lista (solo celular). */}
        <button
          type="button"
          onClick={() => { setDetalleMovil(false); if (cerrarAhora) onCerrarAtendido(); }}
          className="mb-3 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium text-primary hover:bg-primary/10 md:hidden"
        >
          ← Tickets
        </button>
        {actual ? (
          <DetalleTicket
            key={actual.id}
            t={actual}
            email={email}
            enviado={enviadoDe(actual)}
            onEnviado={() => misEnviados(email).then(setEnviados).catch(() => {})}
            onCerrar={() => setCerrando(actual)}
            enfocarRespuesta={actual.id === responderAhora}
            onRespuestaEnfocada={respuestaAtendida}
            puedeMandarClaude={puedeMandarClaude}
            onRelacionCambiada={onRefrescar}
          />
        ) : !cargando && !error && (
          <SinTicketElegido puedeMandarClaude={puedeMandarClaude} />
        )}
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
/** Copia local: aparece al instante mientras llega la de Firestore, y cubre si no hay red. */
const leerBorrador = (id: string) => {
  try { return localStorage.getItem(claveBorrador(id)); } catch { return null; }
};
const guardarBorrador = (id: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(claveBorrador(id));
    else localStorage.setItem(claveBorrador(id), v);
  } catch { /* sin storage: queda la copia de Firestore */ }
};
/** Se guarda en Firestore cuando dejas de escribir por este tiempo. */
const GUARDAR_MS = 1_000;

function DetalleTicket({ t, email, enviado, onEnviado, onCerrar, enfocarRespuesta, onRespuestaEnfocada, puedeMandarClaude, onRelacionCambiada }: {
  puedeMandarClaude: boolean;
  /** Se ligó o desligó un ticket: recarga la lista para que el cierre vea los relacionados nuevos. */
  onRelacionCambiada: () => void;
  t: TicketAgente;
  email: string;
  enviado: TicketEnviado | null;
  onEnviado: () => void;
  onCerrar: () => void;
  enfocarRespuesta: boolean;
  onRespuestaEnfocada: () => void;
}) {
  const [analisis, setAnalisis] = useState<AnalisisTicket | null>(null);
  const [cargandoAnalisis, setCargandoAnalisis] = useState(true);
  const [prompt, setPrompt] = useState<string>(() => leerBorrador(t.id) ?? "");
  const [guardado, setGuardado] = useState<"guardado" | "guardando" | "error" | null>(null);
  const pendiente = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tocado = useRef(false);

  // El borrador de Firestore manda sobre el local (puede venir de otro equipo),
  // salvo que ya hayas empezado a escribir aquí.
  useEffect(() => {
    let vivo = true;
    leerBorradorMd(email, t.id).then((md) => {
      if (!vivo || tocado.current || md === null) return;
      setPrompt(md);
      guardarBorrador(t.id, md);
      setGuardado("guardado");
    });
    return () => { vivo = false; };
  }, [email, t.id]);
  useEffect(() => () => clearTimeout(pendiente.current), []);

  const editar = (v: string | null) => {
    tocado.current = true;
    setPrompt(v ?? "");
    guardarBorrador(t.id, v);
    clearTimeout(pendiente.current);
    setGuardado("guardando");
    const persistir = () =>
      guardarBorradorMd(email, t.id, v)
        .then(() => setGuardado(v === null ? null : "guardado"))
        .catch(() => setGuardado("error"));
    if (v === null) void persistir();
    else pendiente.current = setTimeout(() => void persistir(), GUARDAR_MS);
  };
  const [copiado, setCopiado] = useState(false);
  const [confirmar, setConfirmar] = useState(false);
  // Sin token de Claude conectado no se ofrece mandar: cada quien usa su ventana.
  const token = useTokenClaude();
  const [mandando, setMandando] = useState(false);
  const [errorMandar, setErrorMandar] = useState<string | null>(null);
  const [recienMandado, setRecienMandado] = useState<{ numero: number; url: string } | null>(null);
  const issue = recienMandado ?? enviado?.issue ?? null;
  // Claude terminó sin abrir PRs (el arreglo ya estaba): se puede cerrar igual.
  // Misma caché que el panel de seguimiento: no agrega llamadas.
  const seguimiento = useQuery({ ...consultaSeguimiento(t.id), enabled: !!issue });
  const sinCambios = !!issue && !enviado?.listo && seguimiento.data?.sinCambios === true;

  // Solo la investigación que haya dejado el análisis por API (ya retirado).
  useEffect(() => {
    let vivo = true;
    analisisGuardado(t.id)
      .then((a) => vivo && setAnalisis(a))
      .finally(() => vivo && setCargandoAnalisis(false));
    return () => { vivo = false; };
  }, [t.id]);

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

  const mandar = async () => {
    setMandando(true);
    setErrorMandar(null);
    try {
      const r = await mandarAClaude(t.id, valor);
      setRecienMandado({ numero: r.numero, url: r.url });
      setConfirmar(false);
      onEnviado();
    } catch (e) {
      setErrorMandar(mensajeDeError(e));
    } finally {
      setMandando(false);
    }
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
          {t.sentry && <VinculoSentry s={t.sentry} />}
          <Relacionados t={t} onCambio={onRelacionCambiada} />
        </div>
        {/* Se cierra cuando todo lo del ticket está en PRD (ver `listo`), o cuando
            Claude terminó sin cambios porque el arreglo ya estaba. */}
        <button
          type="button"
          onClick={onCerrar}
          disabled={!enviado?.listo && !sinCambios}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-emerald-500/50 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground dark:bg-emerald-950/30 dark:text-emerald-300"
          title={
            enviado?.listo
              ? "Pasar el ticket a Resuelto en el portal, con nota de seguimiento"
              : sinCambios
                ? "Claude terminó sin abrir PRs (el arreglo ya estaba): ciérralo con los PRs que lo resolvieron, si los hay"
              : enviado?.issue
                ? "Se habilita cuando TODOS los PRs que abrió Claude para este ticket estén en PRD"
                : "Se habilita cuando un PR hacia main con este ticket (trailer Ticket-SOZU) llegue a PRD"
          }
        >
          <CheckCircle2 className="h-4 w-4" /> Cerrar ticket
        </button>
        {/* Trabajado por fuera (ni Claude ni el .md): se cierra eligiendo los PRs
            que lo resolvieron. Ver `esExterno`. */}
        {esExterno(enviado) && (
          <button
            type="button"
            onClick={onCerrar}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-semibold hover:bg-muted"
            title={`Busca en los repos de Sozu los PRs ligados a ${t.folio} (${convencionPrs(t.numero).join("; ")}) para cerrarlo con ellos`}
          >
            <Search className="h-4 w-4" /> Buscar PRs que lo cerraron
          </button>
        )}
      </header>

      {/* 1. Descripción del ticket */}
      {/* Sin mandar: abierta (es lo que hay que leer para el prompt). Ya con
          trabajo de Claude: contraída, lo vigente es el trabajo. La key la
          reinicia al mandarlo. */}
      <Seccion key={issue ? "con-trabajo" : "sin-trabajo"} numero={1} titulo="Descripción del ticket" abierta={!issue}>
        <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
          <Dato icono={User} etiqueta="Abierto por">{t.abiertoPor ?? "—"}</Dato>
          <Dato icono={FileText} etiqueta="Fecha">{esSoloFecha(t.abiertoEn) ? fechaTicket(t.abiertoEn, "corta") : fecha(t.abiertoEn)}</Dato>
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
          {enviado?.listo && enviado.prs.length > 0 && (
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
                  "Mandar a Claude" las lleva por URL. Si pegas el .md a mano, pega cada imagen con <strong>Copiar imagen</strong> → Ctrl/Cmd+V, en el orden numerado.
                </p>
              )}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {t.evidencias.map((e, i) => <Evidencia key={`${e.url}${i}`} e={e} n={e.tipo === "imagen" ? imagenes.indexOf(e) + 1 : null} />)}
              </div>
            </>
          )}
        </div>
        {analisis && (
          <div>
            <h3 className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" /> Investigación previa (guardada)
            </h3>
            <div className="space-y-2 rounded-lg border bg-muted/20 p-3 text-sm">
              {analisis.resumen && <p>{analisis.resumen}</p>}
              {analisis.repos.map((r) => (
                <div key={r.repo} className="rounded-md bg-background p-2">
                  <p className="flex items-center gap-1.5 text-xs font-semibold"><FolderGit2 className="h-3.5 w-3.5 text-primary" />{r.repo}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{r.motivo}</p>
                  {r.rutas.length > 0 && (
                    <ul className="mt-1 space-y-0.5">{r.rutas.map((p) => <li key={p} className="truncate font-mono text-[11px]">{p}</li>)}</ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Seccion>

      {/* 2. Prompt para Claude: solo mientras no se ha mandado. */}
      {!issue && (
        <Seccion numero={2} titulo="Prompt para Claude">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <p className="flex-1 text-[11px] text-muted-foreground">El .md que recibe Claude: edítalo si hace falta antes de mandarlo.</p>
              {editado && (
                <button type="button" onClick={() => editar(null)} className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground hover:bg-muted" title="Volver al prompt generado">
                  <RotateCcw className="h-3 w-3" /> Restaurar
                </button>
              )}
              <button type="button" onClick={() => void copiar()} disabled={cargandoAnalisis} className="inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50" title="Para pegarlo a mano en Claude Code">
                {copiado ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copiado ? "Copiado" : "Copiar .md"}
              </button>
            </div>
            <textarea
              value={valor}
              onChange={(e) => editar(e.target.value)}
              spellCheck={false}
              rows={18}
              className="w-full resize-y rounded-lg border bg-muted/30 p-3 font-mono text-[12px] leading-relaxed outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {editado
                ? guardado === "guardando" ? "Guardando…" : guardado === "error" ? "No se pudo guardar en la nube; quedó en este navegador." : "Editado: guardado en tu cuenta (lo ves desde cualquier equipo)."
                : "Generado del ticket; edítalo libremente antes de mandarlo."}{" "}
              Los commits llevarán el trailer <code>Ticket-SOZU</code>: cuando su PR llegue a PRD, GeorgIA te avisa para cerrarlo.
            </p>
          </div>
          {puedeMandarClaude ? (
            <>
          <AvisoTokenClaude />
          {!token.data ? (
            token.isError
              ? <p className="text-xs text-destructive">No se pudo revisar tu conexión con Claude: {mensajeDeError(token.error)}</p>
              : <p className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Revisando tu conexión con Claude…</p>
          ) : !token.data.conectado ? (
            <ConectarClaude />
          ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-violet-300/60 bg-violet-50/60 p-3 dark:border-violet-800/60 dark:bg-violet-950/20">
            <Bot className="h-4 w-4 text-violet-600 dark:text-violet-300" />
            <p className="min-w-0 flex-1 text-sm">
              Claude Code investiga, arregla y abre los PRs hacia <strong>dev</strong> (con tu suscripción). Tú solo revisas y apruebas.
            </p>
            {confirmar ? (
              <span className="flex items-center gap-1.5">
                <button type="button" onClick={() => setConfirmar(false)} disabled={mandando} className="h-8 rounded-md px-2.5 text-xs font-medium hover:bg-muted">Cancelar</button>
                <button type="button" onClick={() => void mandar()} disabled={mandando || cargandoAnalisis} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-xs font-semibold text-white disabled:opacity-50">
                  {mandando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Sí, mandar
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmar(true)} disabled={cargandoAnalisis} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
                <Send className="h-3.5 w-3.5" /> Mandar a Claude
              </button>
            )}
            {confirmar && <p className="w-full text-[11px] text-muted-foreground">Se manda el .md de arriba tal como está (con tus ediciones). Usa la ventana de 5 h de tu plan.</p>}
            {errorMandar && <p className="w-full text-xs text-destructive">{errorMandar}</p>}
            <EstadoTokenClaude t={token.data!} />
          </div>
          )}
            </>
          ) : (
            <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
              No tienes permiso para mandar tickets a Claude. Puedes copiar el .md y trabajarlo a mano; pide el permiso «Mandar a Claude» al administrador.
            </p>
          )}
        </Seccion>
      )}

      {/* 3. Trabajo en Claude: aparece al mandarlo (y el prompt se oculta). */}
      {issue && (
        <Seccion numero={2} titulo="Trabajo en Claude" icono={Bot}>
          <div className="rounded-lg border border-violet-300/60 bg-violet-50/60 p-3 dark:border-violet-800/60 dark:bg-violet-950/20">
            <SeguimientoClaude
              ticketId={t.id}
              folio={t.folio}
              titulo={t.titulo}
              issue={issue}
              enfocar={enfocarRespuesta}
              onEnfocado={onRespuestaEnfocada}
              onListo={enviado?.listo ? undefined : onEnviado}
            />
          </div>
        </Seccion>
      )}
    </div>
  );
}

/**
 * Cada parte del detalle (1. descripción, 2. prompt o trabajo en Claude), con
 * su encabezado para contraerla o expandirla. `abierta` es como arranca.
 */
function Seccion({ numero, titulo, icono: Icono, abierta: abiertaInicial = true, children }: {
  numero: number;
  titulo: string;
  icono?: typeof User;
  abierta?: boolean;
  children: React.ReactNode;
}) {
  const [abierta, setAbierta] = useState(abiertaInicial);
  return (
    <section className="space-y-3">
      <h3>
        <button
          type="button"
          onClick={() => setAbierta((v) => !v)}
          aria-expanded={abierta}
          className="flex w-full items-center gap-2 border-b pb-1.5 text-left text-sm font-semibold hover:text-primary"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">{numero}</span>
          {Icono && <Icono className="h-4 w-4 text-violet-600 dark:text-violet-300" />}
          <span className="flex-1">{titulo}</span>
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform duration-200", !abierta && "-rotate-90")} />
        </button>
      </h3>
      {abierta && children}
    </section>
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
  if (e.tipo === "video") {
    return (
      <div className="col-span-2 rounded-md border p-2">
        <p className="mb-1 flex items-center gap-1 truncate text-[10px] text-muted-foreground"><FileVideo className="h-3 w-3" />{e.nombre}</p>
        <video controls preload="metadata" src={e.url} className="max-h-64 w-full rounded bg-black" />
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

/**
 * ¿Se trabajó por fuera del dashboard? Ni se mandó a Claude ni llegó a PRD un PR
 * con el trailer: para cerrarlo hay que decir qué PRs lo resolvieron.
 */
const esExterno = (e: TicketEnviado | null) => !e?.issue && !e?.listo;

const RAZON: Record<RazonMatch, string> = { trailer: "trailer en commit", titulo: "folio en el título", rama: "rama del ticket" };

/** El PR como entra a la nota y al registro: el PR hacia main cuando ya lo hay. */
const comoPrDeTicket = (p: PrExterno) => ({
  repo: p.repo,
  pr: p.prMain?.numero ?? p.numero,
  url: p.prMain?.url ?? p.url,
  cambios: [p.titulo],
});

/**
 * Lista de PRs de un ticket trabajado por fuera, para elegir cuáles lo cerraron.
 * Se pueden marcar los que ya se fusionaron (dev, main o PRD), como en el
 * portal, pero el ticket solo se cierra cuando todos los marcados están en PRD;
 * el servidor vuelve a verificar cada uno.
 */
function PrsExternos({ t, prs, buscando, error, seleccion, onAlternar, onReintentar }: {
  t: TicketAgente;
  prs: PrExterno[] | undefined;
  buscando: boolean;
  error: string | null;
  seleccion: Set<string>;
  onAlternar: (url: string) => void;
  onReintentar: () => void;
}) {
  return (
    <div className="mt-4 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">PRs que lo cerraron (trabajado fuera del dashboard):</p>
        <button type="button" onClick={onReintentar} disabled={buscando} className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline disabled:opacity-50">
          <RefreshCw className={cn("h-3 w-3", buscando && "animate-spin")} /> Volver a buscar
        </button>
      </div>
      {buscando && !prs && <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Buscando en los repos de Sozu…</p>}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {prs && prs.length === 0 && (
        <div className="mt-2 text-xs text-muted-foreground">
          <p>No encontré PRs ligados a {t.folio}. Para que aparezcan, el PR necesita alguno de:</p>
          <ul className="mt-1 list-disc pl-4">{convencionPrs(t.numero).map((c) => <li key={c}><code>{c}</code></li>)}</ul>
        </div>
      )}
      {prs && prs.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {prs.map((p) => (
            <li key={p.url}>
              <label className={cn("flex items-start gap-1.5 text-xs", p.mergeado ? "cursor-pointer" : "opacity-60")}>
                <input
                  type="checkbox"
                  checked={seleccion.has(p.url)}
                  disabled={!p.mergeado}
                  onChange={() => onAlternar(p.url)}
                  className="mt-0.5 h-3.5 w-3.5 accent-emerald-600"
                  title={p.mergeado ? undefined : "Todavía no se fusiona: no puede cerrar el ticket"}
                />
                <span className="min-w-0">
                  <a href={p.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">{p.repo} #{p.numero}</a>
                  <span className={cn("ml-1", COLOR_PR[p.estado])}>· {ETIQUETA_PR[p.estado]}</span>
                  <span className="block truncate text-muted-foreground">{p.titulo}</span>
                  <span className="block text-[10px] text-muted-foreground">Ligado por: {p.razones.map((r) => RAZON[r]).join(", ")}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Confirmación de cierre: nota de seguimiento editable (por repo y PR, en puntos). */
function CerrarTicketDialog({ t, enviado, onCancelar, onCerrado }: {
  t: TicketAgente;
  enviado: TicketEnviado | null;
  onCancelar: () => void;
  onCerrado: () => void;
}) {
  const externo = esExterno(enviado);
  // Claude terminó sin abrir PRs: se buscan los PRs que ya lo habían resuelto,
  // pero elegir alguno es opcional (Claude ya verificó que no hacía falta cambio).
  const seguimiento = useQuery({ ...consultaSeguimiento(t.id), enabled: !!enviado?.issue });
  const sinCambios = !!enviado?.issue && !enviado.listo && seguimiento.data?.sinCambios === true;
  const buscaPrs = externo || sinCambios;
  // Externo: los PRs del ticket por la convención. `intento` > 0 = "Volver a
  // buscar", que se salta lo guardado de los últimos 10 min.
  const [intento, setIntento] = useState(0);
  const busqueda = useQuery({
    queryKey: ["prs-externos", t.id, intento],
    queryFn: () => buscarPrsTicket(t.id, intento > 0),
    enabled: buscaPrs,
    staleTime: Infinity,
  });
  const encontrados = busqueda.data?.prs;
  // Sin tocar nada, van marcados los que ya están en main.
  const [marcados, setMarcados] = useState<Set<string> | null>(null);
  const seleccion = marcados ?? new Set((encontrados ?? []).filter((p) => p.mergeado).map((p) => p.url));
  const elegidos = (encontrados ?? []).filter((p) => seleccion.has(p.url));
  const alternar = (url: string) => {
    const nueva = new Set(seleccion);
    if (nueva.has(url)) nueva.delete(url); else nueva.add(url);
    setMarcados(nueva);
  };
  // La nota se arma con los PRs elegidos hasta que se edite a mano.
  const [notaEditada, setNotaEditada] = useState<string | null>(null);
  const nota = notaEditada
    ?? (enviado?.prs.length ? notaDeCierre(enviado.prs)
      : buscaPrs && elegidos.length ? notaDeCierre(elegidos.map(comoPrDeTicket))
        : sinCambios
          ? `Listo, favor de validar.\n\nSin cambios de código: Claude revisó el ticket y el arreglo ya estaba en producción (issue #${enviado?.issue?.numero ?? "?"} del orquestador).`
          : "Listo, favor de validar.\n\n- ");
  const faltaPrd = elegidos.filter((p) => p.estado !== "en_prd");
  const soloDev = faltaPrd.filter((p) => p.estado === "en_dev");
  const enMain = faltaPrd.filter((p) => p.estado !== "en_dev");
  const lista = (ps: typeof elegidos) => ps.map((p) => `${p.repo} #${p.numero}`).join(", ");
  // Puede haber cambios que no pasaron por aquí (otro PR, un ajuste a mano): se
  // pide confirmar que ya se revisó todo, viendo qué fue lo que llegó a PRD.
  const [revisado, setRevisado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);
  const [sentryResueltos, setSentryResueltos] = useState<string[]>([]);
  const [cascada, setCascada] = useState<{ cerrados: string[]; fallidos: string[] }>({ cerrados: [], fallidos: [] });
  const relAbiertos = (t.relacionados ?? []).filter((r) => !r.cerrado);

  const cerrar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const r = await cerrarTicketPortal(t.id, nota, buscaPrs ? [...seleccion] : undefined);
      setHecho(r.etapa);
      setSentryResueltos(r.sentryResueltos ?? []);
      setCascada({ cerrados: r.relacionadosCerrados ?? [], fallidos: r.relacionadosFallidos ?? [] });
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
              {sentryResueltos.length > 0 && <> También se resolvió {sentryResueltos.join(", ")} en Sentry.</>}
              {cascada.cerrados.length > 0 && <> Se cerró también {cascada.cerrados.join(", ")} (relacionado{cascada.cerrados.length === 1 ? "" : "s"}).</>}
              {cascada.fallidos.length > 0 && <span className="text-amber-700 dark:text-amber-400"> No se pudo cerrar {cascada.fallidos.join(", ")}: ciérralo{cascada.fallidos.length === 1 ? "" : "s"} en el portal.</span>}
            </p>
          ) : (
            <>
              {relAbiertos.length > 0 && (
                <div className="mt-4 rounded-md border border-violet-300/70 bg-violet-50 p-2.5 text-xs text-violet-900 dark:border-violet-800/60 dark:bg-violet-950/30 dark:text-violet-200">
                  <p className="flex items-start gap-1.5">
                    <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Al cerrar {t.folio} también se {relAbiertos.length === 1 ? "cierra el ticket relacionado" : "cierran los tickets relacionados"}:
                    </span>
                  </p>
                  <ul className="mt-1.5 space-y-0.5 pl-5">
                    {relAbiertos.map((r) => (
                      <li key={r.id}>
                        <span className="font-semibold">{r.folio}</span> {r.titulo}
                        <span className="text-violet-700/80 dark:text-violet-300/80"> · {r.etapa ?? "abierto"}</span>
                        {!r.sePuedeCerrar && <span className="text-amber-700 dark:text-amber-400"> · otro pipeline: ciérralo en el portal</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {t.sentry && (
                <p
                  className={cn(
                    "mt-4 flex items-start gap-1.5 rounded-md border p-2.5 text-xs",
                    t.sentry.estado === "unresolved"
                      ? "border-red-300/70 bg-red-50 text-red-900 dark:border-red-800/60 dark:bg-red-950/30 dark:text-red-200"
                      : "bg-muted/30 text-muted-foreground",
                  )}
                >
                  <Siren className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {t.sentry.estado === "unresolved" ? (
                      <>Al cerrar el ticket también se marca como <strong>resuelto</strong> el issue <strong>{t.sentry.shortId}</strong> de Sentry ({t.sentry.slug}), y la nota lo menciona.</>
                    ) : (
                      <>El issue {t.sentry.shortId} de Sentry ya está {t.sentry.estado === "ignored" ? "ignorado" : "resuelto"}: no se toca.</>
                    )}
                  </span>
                </p>
              )}
              {sinCambios && (
                <p className="mt-4 rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
                  Claude terminó sin abrir PRs: reportó que el arreglo ya estaba en producción. Si abajo aparecen
                  los PRs que lo resolvieron, márcalos para dejarlos en la nota; si no, se puede cerrar sin PRs.
                </p>
              )}
              {buscaPrs && (
                <PrsExternos
                  t={t}
                  prs={encontrados}
                  buscando={busqueda.isFetching}
                  error={busqueda.error ? mensajeDeError(busqueda.error) : null}
                  seleccion={seleccion}
                  onAlternar={alternar}
                  onReintentar={() => { setMarcados(null); setIntento((n) => n + 1); }}
                />
              )}
              {buscaPrs && faltaPrd.length > 0 && (
                <p className="mt-2 flex items-start gap-1.5 rounded-md bg-red-50 p-2 text-[11px] text-red-900 dark:bg-red-950/30 dark:text-red-200">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Todavía no se puede cerrar:{" "}
                    {[
                      soloDev.length > 0 && `${lista(soloDev)} ${soloDev.length === 1 ? "está" : "están"} en dev y no ha${soloDev.length === 1 ? "" : "n"} salido a main`,
                      enMain.length > 0 && `${lista(enMain)} ya ${enMain.length === 1 ? "está" : "están"} en main, pero el último deploy a PRD no ${enMain.length === 1 ? "lo" : "los"} trae`,
                    ].filter(Boolean).join("; ")}
                    . Se habilita cuando todo lo marcado llegue a PRD (o desmarca lo que no sea de este ticket).
                  </span>
                </p>
              )}
              {enviado && enviado.prs.length > 0 && (
                <div className="mt-4 rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs font-medium">Se pasó a PRD:</p>
                  <ul className="mt-1.5 space-y-1">
                    {enviado.prs.map((p) => (
                      <li key={`${p.repo}${p.pr}`} className="flex items-center gap-1.5 text-xs">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        <a href={p.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">{p.repo} #{p.pr}</a>
                        <span className="truncate text-muted-foreground">{p.cambios[0]}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md border border-amber-400/60 bg-amber-50 p-2.5 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                <input type="checkbox" checked={revisado} onChange={(e) => setRevisado(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-emerald-600" />
                <span>
                  Ya revisé que no falta nada: {enviado && enviado.prs.length > 0
                    ? <>lo de arriba ({enviado.prs.map((p) => `${p.repo} #${p.pr}`).join(", ")}) es todo lo del ticket y ya está en PRD; no hay otro PR pendiente.</>
                    : sinCambios
                      ? <>leí el reporte de Claude: no hacía falta cambio y lo que el ticket pide ya funciona en producción.</>
                    : externo
                      ? <>los PRs marcados son todo lo del ticket; no hay otro cambio pendiente.</>
                      : <>todos los cambios del ticket ya están en PRD.</>}
                </span>
              </label>
              <p className="mt-4 text-xs text-muted-foreground">
                Pasa a <strong>Resuelto</strong> en el portal y deja esta nota en el seguimiento (a tu nombre). Puntos cortos:
              </p>
              <textarea
                value={nota}
                onChange={(e) => setNotaEditada(e.target.value)}
                rows={10}
                className="mt-2 w-full resize-y rounded-lg border bg-muted/30 p-3 font-mono text-[12px] leading-relaxed outline-none focus:ring-2 focus:ring-ring"
              />
              {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={onCancelar} disabled={enviando} className="h-9 rounded-md px-3 text-sm font-medium hover:bg-muted">No, todavía no</button>
                <button type="button" onClick={() => void cerrar()} disabled={enviando || !nota.trim() || !revisado || (externo && seleccion.size === 0) || (buscaPrs && faltaPrd.length > 0)} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-sm font-medium text-white disabled:opacity-50">
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

/** Issue de Sentry ligado al ticket (levantado desde Monitoreo), con su estado y enlaces. */
function VinculoSentry({ s }: { s: NonNullable<TicketAgente["sentry"]> }) {
  const abierto = s.estado === "unresolved";
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium",
          abierto ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300" : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
        )}
      >
        <Siren className="h-3 w-3" /> Sentry {s.shortId} · {abierto ? "sin resolver" : s.estado === "ignored" ? "ignorado" : "resuelto"}
      </span>
      <span className="text-muted-foreground">{abierto ? "Se resuelve al cerrar este ticket." : ""}</span>
      <Link to="/monitoreo" className="text-primary hover:underline">Ver en Monitoreo</Link>
      {/^https:\/\/[\w-]+\.sentry\.io\//.test(s.url) && (
        <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline">
          Sentry <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </p>
  );
}

/**
 * Tickets ligados: los del portal («¿Ya lo había reportado antes?», el anterior y
 * los posteriores) y los que se ligan aquí con «Relacionar ticket» por folio.
 * Los ligados aquí y el anterior se pueden quitar; el posterior, desde su ticket.
 */
function Relacionados({ t, onCambio }: { t: TicketAgente; onCambio: () => void }) {
  const [rs, setRs] = useState(t.relacionados ?? []);
  const [abierto, setAbierto] = useState(false);
  const [folio, setFolio] = useState("");
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Al recargar la lista llega la versión del servidor y reemplaza la local.
  const [base, setBase] = useState(t.relacionados);
  if (base !== t.relacionados) {
    setBase(t.relacionados);
    setRs(t.relacionados ?? []);
  }

  const ligar = async (e: React.FormEvent) => {
    e.preventDefault();
    const numero = Number(folio.replace(/\D/g, ""));
    if (!numero) return setError("Escribe el folio del ticket.");
    setOcupado("nuevo");
    setError(null);
    try {
      const r = await relacionarTicket(t.id, numero);
      if (r.relacionado) setRs((xs) => [...xs, r.relacionado!]);
      setFolio("");
      setAbierto(false);
      onCambio();
    } catch (err) {
      setError(mensajeDeError(err));
    } finally {
      setOcupado(null);
    }
  };
  const quitar = async (id: string) => {
    setOcupado(id);
    setError(null);
    try {
      await desligarTicket(t.id, id);
      setRs((xs) => xs.filter((x) => x.id !== id));
      onCambio();
    } catch (err) {
      setError(mensajeDeError(err));
    } finally {
      setOcupado(null);
    }
  };

  return (
    <div className="mt-1.5 flex flex-col gap-1 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {rs.length > 0 && (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Link2 className="h-3 w-3" /> Relacionado con
          </span>
        )}
        {rs.map((r) => (
          <span
            key={r.id}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
              r.cerrado ? "text-muted-foreground" : "border-violet-300 text-violet-700 dark:border-violet-800 dark:text-violet-300",
            )}
          >
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer"
              title={`${r.relacion === "anterior" ? "Reporte anterior" : r.relacion === "posterior" ? "Reporte posterior" : "Ligado desde el dashboard"}: ${r.titulo}`}
              className="inline-flex items-center gap-1 hover:underline"
            >
              <span className="font-semibold">{r.folio}</span>
              <span>{r.cerrado ? "cerrado" : r.etapa ?? "abierto"}</span>
            </a>
            {r.relacion !== "posterior" && (
              <button
                type="button"
                onClick={() => quitar(r.id)}
                disabled={!!ocupado}
                title="Quitar relación"
                className="-mr-1 rounded-full p-0.5 hover:bg-muted disabled:opacity-50"
              >
                {ocupado === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
              </button>
            )}
          </span>
        ))}
        {rs.some((r) => !r.cerrado) && <span className="text-muted-foreground">Se cierran al cerrar este.</span>}
        {!abierto && (
          <button
            type="button"
            onClick={() => { setAbierto(true); setError(null); }}
            className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Plus className="h-3 w-3" /> Relacionar ticket
          </button>
        )}
      </div>
      {abierto && (
        <form onSubmit={ligar} className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">Folio</span>
          <input
            autoFocus
            value={folio}
            onChange={(e) => setFolio(e.target.value)}
            placeholder="#1234"
            inputMode="numeric"
            className="h-7 w-24 rounded-md border bg-background px-2 text-xs"
          />
          <button
            type="submit"
            disabled={ocupado === "nuevo"}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 font-semibold text-primary-foreground disabled:opacity-50"
          >
            {ocupado === "nuevo" && <Loader2 className="h-3 w-3 animate-spin" />} Relacionar
          </button>
          <button type="button" onClick={() => { setAbierto(false); setError(null); }} className="h-7 rounded-md px-2 text-muted-foreground hover:bg-muted">
            Cancelar
          </button>
          <span className="w-full text-muted-foreground">Al cerrar uno de los dos desde aquí se cierra también el otro.</span>
        </form>
      )}
      {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}
