/**
 * Agente de repos: botón flotante + panel lateral de chat.
 *
 * Mismo esquema que los asistentes de sozu-admin (BotonFlotanteIA + historial
 * agrupado + composer), adaptado al dashboard: el backend es la Cloud Function
 * `agenteRepos` (streaming) y el historial vive en `agente_conversaciones`.
 *
 * Solo se monta si el usuario REAL (no el impersonado) tiene acceso: la función
 * valida con el token de quien está logueado, así que "ver como" no cambia nada.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft, BellRing, Bot, Palette, Check, MessageSquare, Copy, FileText, History, Loader2, Lock, MessageSquarePlus, Pencil, Pin, PinOff, Search, Send,
  Square, Trash2, Wrench, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  borrarConversacion, escucharConversaciones, esRutaDoc, fijarConversacion, leerDocumento, leerMensajes, MAX_MENSAJE,
  MAX_TITULO, mensajeDeError, permisosAgente, preguntar, renombrarConversacion, SUGERENCIAS,
  type ConversacionAgente, type DocumentoAgente, type HerramientaUsada, type MensajeAgente, type PermisosAgente,
  type AdjuntoChat,
} from "@/lib/agenteRepos";
import { ElegirAvatar } from "./ElegirAvatar";
import { AdjuntoEnMensaje, AdjuntosPendientes, BotonesAdjuntar } from "./Adjuntos";
import { useAdjuntos } from "@/hooks/useAdjuntos";
import { AgenteVolador, EVENTO_ALERTA_TICKETS, EVENTO_CLAUDE, type DetalleAlerta, type DetalleClaude } from "./AgenteVolador";
import { TicketsAgente } from "./TicketsAgente";
import {
  gritosDeCierre, gritosDeTickets, INTERVALO_TICKETS_MS, misEnviados, misTickets, nombreDeEmail, seguimientoClaude,
  type EstadoClaude, type SeguimientoClaude, type TicketAgente, type TicketEnviado,
} from "@/lib/agenteTickets";
import { pitido } from "@/lib/sonido";
import { useQueryClient } from "@tanstack/react-query";
import { EVENTO_TICKETS_LISTOS } from "@/lib/festejoDeploy";
import { useVigiaDeploys } from "@/hooks/useVigiaDeploys";
import { useAuth } from "@/hooks/useAuth";

/**
 * Documentos citados: con el permiso "Ver documentación" son enlaces que abren
 * el visor; sin él se ven igual pero no se pueden abrir (y `agenteDoc` tampoco
 * los entregaría).
 */
const DocsCtx = createContext<{ puede: boolean; abrir: (ruta: string) => void }>({ puede: false, abrir: () => {} });

interface Props {
  email: string | null | undefined;
  /** Preferencia guardada en el perfil (`users/{email}.agenteVolador`). */
  personajeVisible?: boolean;
}

/** Cada cuánto se revisa si Claude Code espera respuesta en algún ticket mandado. */
const INTERVALO_PREGUNTAS_MS = 2 * 60_000;
/** Con Claude trabajando en algún ticket: para avisar en cuanto termine. */
const INTERVALO_ACTIVO_MS = 20_000;
const CLAVE_AVISADAS = "georgia:preguntas-avisadas";
/** Preguntas de Claude por las que ya se gritó ("<ticketId>:<idComentario>"). */
const leerAvisadas = (): string[] => {
  try { return JSON.parse(localStorage.getItem(CLAVE_AVISADAS) ?? "[]") as string[]; } catch { return []; }
};
const guardarAvisadas = (v: string[]) => {
  try { localStorage.setItem(CLAVE_AVISADAS, JSON.stringify(v.slice(-100))); } catch { /* sin storage: puede repetir el grito */ }
};

export function AgenteRepos({ email, personajeVisible = true }: Props) {
  // El perfil se lee una vez al entrar; el cambio desde Configuración llega por evento.
  const [visibleLocal, setVisibleLocal] = useState<boolean | null>(null);
  const visible = visibleLocal ?? personajeVisible;
  useEffect(() => {
    const alCambiar = (e: Event) => {
      const d = (e as CustomEvent<{ email: string; visible: boolean }>).detail;
      if (d?.email === email) setVisibleLocal(d.visible);
    };
    window.addEventListener("agente:visibilidad", alCambiar);
    return () => window.removeEventListener("agente:visibilidad", alCambiar);
  }, [email]);
  const [permisos, setPermisos] = useState<PermisosAgente>({ agente: false, docs: false, tickets: false });
  const [abierto, setAbierto] = useState(false);
  const [pestana, setPestana] = useState<"chat" | "tickets" | "avatar">("chat");
  const acceso = permisos.agente;
  // Vigía global: reacciona a los deploys de todos los repos, estén o no en pantalla.
  const { realUser } = useAuth();
  useVigiaDeploys(acceso ? realUser : null, permisos.tickets);

  // ── Tickets: revisión cada 15 min mientras el dashboard está abierto ──────
  const [tickets, setTickets] = useState<TicketAgente[] | null>(null);
  const [revisado, setRevisado] = useState<string | null>(null);
  const [cargandoTickets, setCargandoTickets] = useState(false);
  const [errorTickets, setErrorTickets] = useState<string | null>(null);
  const abiertoRef = useRef(abierto);
  useEffect(() => { abiertoRef.current = abierto; }, [abierto]);

  const revisarTickets = useCallback(async (alertar: boolean) => {
    setCargandoTickets(true);
    try {
      const r = await misTickets();
      setTickets(r.tickets);
      setRevisado(r.revisado);
      setErrorTickets(null);
      // Con pendientes, el personaje aterriza y grita (si el panel no está abierto).
      if (alertar && r.tickets.length > 0 && !abiertoRef.current) {
        window.dispatchEvent(new CustomEvent<DetalleAlerta>(EVENTO_ALERTA_TICKETS, {
          detail: { gritos: gritosDeTickets(r.tickets.length, nombreDeEmail(email)) },
        }));
      }
    } catch (e) {
      setErrorTickets(mensajeDeError(e));
    } finally {
      setCargandoTickets(false);
    }
  }, [email]);

  useEffect(() => {
    if (!permisos.tickets) return;
    // La primera revisión espera unos segundos: que el dashboard cargue antes del grito.
    const primera = setTimeout(() => void revisarTickets(true), 8_000);
    const cada = setInterval(() => void revisarTickets(true), INTERVALO_TICKETS_MS);
    return () => { clearTimeout(primera); clearInterval(cada); };
  }, [permisos.tickets, revisarTickets]);

  // Un deploy a PRD trajo commits de tickets pasados a Claude: GeorgIA se detiene y
  // grita que ya se pueden cerrar; su clic abre el cierre del primero.
  const [porCerrar, setPorCerrar] = useState<TicketEnviado[]>([]);
  const [cerrarAhora, setCerrarAhora] = useState<string | null>(null);
  useEffect(() => {
    if (!permisos.tickets) return;
    const alListos = (e: Event) => {
      const listos = (e as CustomEvent<{ tickets: TicketEnviado[] }>).detail?.tickets ?? [];
      if (!listos.length) return;
      setPorCerrar(listos);
      window.dispatchEvent(new CustomEvent<DetalleAlerta>(EVENTO_ALERTA_TICKETS, {
        detail: { gritos: gritosDeCierre(listos.map((t) => t.folio), nombreDeEmail(email)) },
      }));
    };
    window.addEventListener(EVENTO_TICKETS_LISTOS, alListos);
    return () => window.removeEventListener(EVENTO_TICKETS_LISTOS, alListos);
  }, [permisos.tickets, email]);
  const atenderCierre = useCallback(() => setCerrarAhora(null), []);

  // Claude Code se detuvo a preguntar algo en un ticket mandado: GeorgIA grita
  // (una vez por pregunta) y su clic lleva directo al cuadro para contestar.
  const qc = useQueryClient();
  const [porResponder, setPorResponder] = useState<{ ticketId: string; folio: string }[]>([]);
  const [responderAhora, setResponderAhora] = useState<string | null>(null);
  const foliosRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (!permisos.tickets || !email) return;
    let hayActivo = false;
    const revisar = async () => {
      if (document.hidden) return;
      const enviados = (await misEnviados(email).catch(() => [])).filter((e) => e.issue && !e.listo && !e.cerrado);
      for (const e of enviados) foliosRef.current.set(e.ticketId, e.folio);
      hayActivo = false;
      const esperando: { ticketId: string; folio: string; pregunta: number }[] = [];
      // También detecta lo que llegó a PRD con el dashboard cerrado u oculto.
      const listos: TicketEnviado[] = [];
      for (const e of enviados) {
        const s = await qc.fetchQuery({
          queryKey: ["claude-seguimiento", e.ticketId],
          queryFn: () => seguimientoClaude(e.ticketId),
          staleTime: 15_000,
        }).catch(() => null);
        if (s?.estado === "trabajando" || s?.estado === "en_cola") hayActivo = true;
        if (s?.listoParaCerrar) {
          listos.push({ ...e, listo: true });
          continue;
        }
        if (s?.estado !== "esperando_respuesta") continue;
        const pregunta = [...s.mensajes].reverse().find((m) => m.esPregunta)?.id ?? 0;
        esperando.push({ ticketId: e.ticketId, folio: e.folio, pregunta });
      }
      setPorResponder(esperando);
      if (listos.length) window.dispatchEvent(new CustomEvent(EVENTO_TICKETS_LISTOS, { detail: { tickets: listos } }));
      const avisadas = leerAvisadas();
      const nuevas = esperando.filter((x) => !avisadas.includes(`${x.ticketId}:${x.pregunta}`));
      if (nuevas.length && !abiertoRef.current) {
        guardarAvisadas([...avisadas, ...nuevas.map((x) => `${x.ticketId}:${x.pregunta}`)]);
        // Escena de pregunta: GeorgIA baja con el "?" y se queda hasta el clic.
        window.dispatchEvent(new CustomEvent<DetalleClaude>(EVENTO_CLAUDE, {
          detail: { resultado: "pregunta", folio: nuevas.map((x) => x.folio).join(", "), nombre: nombreDeEmail(email) },
        }));
      }
    };
    // Mientras Claude trabaja en algún ticket se revisa cada 20 s (para avisar
    // en cuanto termine); si no, cada 2 min. Con la pestaña oculta no se revisa:
    // al volver a ella se revisa en ese momento.
    let siguiente = setTimeout(function ciclo() {
      void revisar().finally(() => {
        siguiente = setTimeout(ciclo, hayActivo ? INTERVALO_ACTIVO_MS : INTERVALO_PREGUNTAS_MS);
      });
    }, 12_000);
    const alVolver = () => {
      if (!document.hidden) void revisar();
    };
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      clearTimeout(siguiente);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [permisos.tickets, email, qc]);

  // Pitido (y grito de GeorgIA) cuando una corrida de Claude termina. Se mira el
  // caché, que alimentan el panel abierto y la revisión de arriba: suena una
  // sola vez por corrida, venga de donde venga el dato.
  useEffect(() => {
    if (!permisos.tickets || !email) return;
    const previo = new Map<string, EstadoClaude>();
    return qc.getQueryCache().subscribe((ev) => {
      if (ev.type !== "updated" || ev.query.queryKey[0] !== "claude-seguimiento") return;
      const id = String(ev.query.queryKey[1]);
      const s = ev.query.state.data as SeguimientoClaude | undefined;
      if (!s) return;
      const antes = previo.get(id);
      previo.set(id, s.estado);
      const estabaActivo = antes === "trabajando" || antes === "en_cola";
      if (!estabaActivo || s.estado === "trabajando" || s.estado === "en_cola") return;
      const folio = foliosRef.current.get(id) ?? "el ticket";
      const nombre = nombreDeEmail(email);
      pitido(s.estado === "terminado" ? "listo" : s.estado === "error" ? "error" : "pregunta");
      // Escena de GeorgIA: celebra o se sacude. La pregunta la actúa la revisión
      // de arriba (una vez por pregunta).
      if (s.estado === "terminado" || s.estado === "error") {
        window.dispatchEvent(new CustomEvent<DetalleClaude>(EVENTO_CLAUDE, {
          detail: { resultado: s.estado === "terminado" ? "ok" : "fallo", folio, nombre },
        }));
      }
    });
  }, [permisos.tickets, email, qc]);
  const atenderRespuesta = useCallback(() => setResponderAhora(null), []);

  // Ir a Tickets antes de la primera revisión: se revisa en ese momento.
  const irATickets = () => {
    setPestana("tickets");
    if (tickets === null && !cargandoTickets) void revisarTickets(false);
  };

  const abrir = (motivo: "chat" | "tickets") => {
    if (motivo === "tickets" && permisos.tickets) {
      irATickets();
      // Si Claude espera respuesta, eso va primero: directo al cuadro para contestar.
      if (porResponder.length) {
        setResponderAhora(porResponder[0].ticketId);
        setPorResponder((p) => p.slice(1));
      } else if (porCerrar.length) {
        // Si el grito era de "ya se puede cerrar", se abre directo el cierre.
        setCerrarAhora(porCerrar[0].ticketId);
        setPorCerrar((p) => p.slice(1));
      }
    }
    else setPestana("chat");
    setAbierto(true);
  };

  useEffect(() => {
    let vivo = true;
    permisosAgente(email).then((p) => vivo && setPermisos(p));
    return () => { vivo = false; };
  }, [email]);

  // Alt+K abre/cierra desde cualquier pantalla.
  useEffect(() => {
    if (!acceso) return;
    const alTeclear = (e: globalThis.KeyboardEvent) => {
      if (e.altKey && (e.key === "k" || e.key === "K" || e.code === "KeyK")) {
        e.preventDefault();
        // Alt+K siempre abre directo en el chat.
        setPestana("chat");
        setAbierto((v) => !v);
      }
    };
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [acceso]);

  if (!acceso || !email) return null;

  return (
    <Dialog.Root open={abierto} onOpenChange={setAbierto}>
      {/* El personaje vuela por la pantalla; clic abre el chat. Va en z-30,
          debajo de los botones flotantes del dashboard (Actualizar, z-40). */}
      {/* Escondido por preferencia: el chat sigue en Alt+K (y los tickets se siguen revisando). */}
      {visible && <AgenteVolador pausado={abierto} onClick={abrir} />}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-background shadow-2xl sm:w-[min(980px,92vw)]",
            "data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=open]:duration-300",
          )}
          aria-describedby={undefined}
        >
          <div className="flex h-10 shrink-0 items-center gap-1 border-b bg-muted/30 px-3" role="tablist">
            {([
              ["chat", "Chat", MessageSquare],
              ...(permisos.tickets ? [["tickets", `Tickets${tickets ? ` (${tickets.length})` : ""}`, BellRing] as const] : []),
              ["avatar", "Avatar", Palette],
            ] as const).map(([v, etiqueta, Icono]) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={pestana === v}
                onClick={() => (v === "tickets" ? irATickets() : setPestana(v))}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
                  pestana === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  v === "tickets" && !!tickets?.length && pestana !== v && "text-amber-700 dark:text-amber-300",
                )}
              >
                <Icono className="h-3.5 w-3.5" />
                {etiqueta}
              </button>
            ))}
          </div>
          {/* El chat se queda montado al cambiar de pestaña: no pierde el hilo. */}
          <div className={cn("flex min-h-0 flex-1 flex-col", pestana !== "chat" && "hidden")}>
            <PanelAgente email={email} verDocs={permisos.docs} />
          </div>
          {pestana === "avatar" && (
            <>
              <Dialog.Title className="sr-only">Tu avatar de GeorgIA</Dialog.Title>
              <ElegirAvatar email={email} />
            </>
          )}
          {pestana === "tickets" && permisos.tickets && (
            <>
              <Dialog.Title className="sr-only">Tickets asignados</Dialog.Title>
              <TicketsAgente
                email={email}
                cerrarAhora={cerrarAhora}
                onCerrarAtendido={atenderCierre}
                responderAhora={responderAhora}
                onResponderAtendido={atenderRespuesta}
                tickets={tickets}
                cargando={cargandoTickets}
                error={errorTickets}
                revisado={revisado}
                onRefrescar={() => void revisarTickets(false)}
              />
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────

interface EnCurso {
  pregunta: string;
  adjuntos: AdjuntoChat[];
  texto: string;
  herramientas: HerramientaUsada[];
}

function PanelAgente({ email, verDocs }: { email: string; verDocs: boolean }) {
  const [docAbierto, setDocAbierto] = useState<string | null>(null);
  const docsCtx = useMemo(() => ({ puede: verDocs, abrir: setDocAbierto }), [verDocs]);
  const [conversaciones, setConversaciones] = useState<ConversacionAgente[]>([]);
  const [activa, setActiva] = useState<string | null>(null);
  const [mensajes, setMensajes] = useState<MensajeAgente[]>([]);
  const [cargandoHilo, setCargandoHilo] = useState(false);
  const [enCurso, setEnCurso] = useState<EnCurso | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restantes, setRestantes] = useState<number | null>(null);
  const [verHistorial, setVerHistorial] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const finRef = useRef<HTMLDivElement>(null);

  useEffect(() => escucharConversaciones(email, setConversaciones), [email]);

  const abrir = useCallback(async (id: string | null) => {
    abortRef.current?.abort();
    setActiva(id);
    setError(null);
    setEnCurso(null);
    setVerHistorial(false);
    if (!id) { setMensajes([]); return; }
    setCargandoHilo(true);
    try {
      setMensajes(await leerMensajes(id));
    } catch {
      setError("No se pudo cargar la conversación.");
    } finally {
      setCargandoHilo(false);
    }
  }, []);

  useEffect(() => {
    finRef.current?.scrollIntoView({ block: "end" });
  }, [mensajes, enCurso?.texto, enCurso?.herramientas.length]);

  const enviar = async (texto: string, adjuntos: AdjuntoChat[] = []) => {
    const pregunta = texto.trim();
    if ((!pregunta && adjuntos.length === 0) || enCurso) return;
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setEnCurso({ pregunta, adjuntos, texto: "", herramientas: [] });
    try {
      const r = await preguntar(activa, pregunta, (c) => {
        setEnCurso((p) =>
          !p ? p
            : c.tipo === "texto" ? { ...p, texto: p.texto + c.delta }
            : { ...p, herramientas: [...p.herramientas, { nombre: c.nombre, etiqueta: c.etiqueta }] },
        );
      }, ctrl.signal, adjuntos);
      setMensajes((m) => [
        ...m,
        { id: `u-${r.mensajeId}`, rol: "usuario", texto: pregunta, herramientas: [], docs: [], adjuntos },
        { id: r.mensajeId, rol: "asistente", texto: r.texto, herramientas: r.herramientas, docs: r.docs ?? [] },
      ]);
      setActiva(r.conversacionId);
      setRestantes(r.restantes);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError(mensajeDeError(e));
      // La pregunta queda en el hilo, como la guarda la función.
      setMensajes((m) => [...m, { id: `u-${Date.now()}`, rol: "usuario", texto: pregunta, herramientas: [], docs: [], adjuntos }]);
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setEnCurso(null);
    }
  };

  const detener = () => {
    abortRef.current?.abort();
    setEnCurso(null);
  };

  const titulo = conversaciones.find((c) => c.id === activa)?.titulo ?? "Nueva conversación";
  const vacio = !activa && mensajes.length === 0 && !enCurso;

  return (
    <DocsCtx.Provider value={docsCtx}>
    <div className="relative flex min-h-0 flex-1">
      {docAbierto && <VisorDoc key={docAbierto} ruta={docAbierto} onCerrar={() => setDocAbierto(null)} />}
      <aside
        className={cn(
          "w-72 shrink-0 flex-col border-r bg-muted/30",
          verHistorial ? "absolute inset-y-0 left-0 z-10 flex bg-background md:static" : "hidden md:flex",
        )}
      >
        <Historial
          conversaciones={conversaciones}
          activa={activa}
          onAbrir={abrir}
          onBorrada={(id) => id === activa && abrir(null)}
        />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted md:hidden"
            onClick={() => setVerHistorial((v) => !v)}
            aria-label="Historial"
          >
            <History className="h-4 w-4" />
          </button>
          <Bot className="h-5 w-5 shrink-0 text-primary" />
          <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-semibold">{titulo}</Dialog.Title>
          <button
            type="button"
            onClick={() => abrir(null)}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <MessageSquarePlus className="h-4 w-4" />
            <span className="hidden sm:inline">Nueva</span>
          </button>
          <Dialog.Close className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Cerrar">
            <X className="h-4 w-4" />
          </Dialog.Close>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8">
          {vacio ? (
            <Bienvenida onElegir={enviar} />
          ) : cargandoHilo ? (
            <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-6">
              {mensajes.map((m) => <Burbuja key={m.id} mensaje={m} />)}
              {enCurso && (
                <>
                  <Burbuja mensaje={{ id: "p", rol: "usuario", texto: enCurso.pregunta, herramientas: [], docs: [], adjuntos: enCurso.adjuntos }} />
                  <RespuestaEnCurso enCurso={enCurso} />
                </>
              )}
              {error && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
              )}
              <div ref={finRef} />
            </div>
          )}
        </div>

        <Composer enviando={!!enCurso} onEnviar={enviar} onDetener={detener} restantes={restantes} />
      </section>
    </div>
    </DocsCtx.Provider>
  );
}

// ── Historial ───────────────────────────────────────────────────────────────

function grupoDe(c: ConversacionAgente, ahora: Date): string {
  if (c.fijada) return "Fijadas";
  const dia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dias = Math.round((dia(ahora) - dia(c.actualizado)) / 86_400_000);
  if (dias <= 0) return "Hoy";
  if (dias === 1) return "Ayer";
  if (dias < 7) return "Últimos 7 días";
  if (c.actualizado.getMonth() === ahora.getMonth() && c.actualizado.getFullYear() === ahora.getFullYear()) return "Este mes";
  return "Anteriores";
}

const ORDEN_GRUPOS = ["Fijadas", "Hoy", "Ayer", "Últimos 7 días", "Este mes", "Anteriores"];
const sinAcentos = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function Historial({
  conversaciones, activa, onAbrir, onBorrada,
}: {
  conversaciones: ConversacionAgente[];
  activa: string | null;
  onAbrir: (id: string | null) => void;
  onBorrada: (id: string) => void;
}) {
  const [filtro, setFiltro] = useState("");
  const grupos = useMemo(() => {
    const q = sinAcentos(filtro.trim());
    const ahora = new Date();
    const mapa = new Map<string, ConversacionAgente[]>();
    for (const c of conversaciones) {
      if (q && !sinAcentos(c.titulo).includes(q)) continue;
      const g = grupoDe(c, ahora);
      mapa.set(g, [...(mapa.get(g) ?? []), c]);
    }
    return ORDEN_GRUPOS.filter((g) => mapa.has(g)).map((g) => ({ titulo: g, items: mapa.get(g)! }));
  }, [conversaciones, filtro]);

  return (
    <>
      <div className="flex h-14 items-center border-b px-3">
        <div className="flex w-full items-center gap-2 rounded-md border bg-background px-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            placeholder="Buscar conversaciones"
            className="h-8 w-full bg-transparent text-xs outline-none"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {grupos.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {conversaciones.length ? "Sin coincidencias." : "Aún no hay conversaciones."}
          </p>
        )}
        {grupos.map((g) => (
          <div key={g.titulo} className="mb-3">
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{g.titulo}</p>
            {g.items.map((c) => (
              <FilaConversacion key={c.id} c={c} activa={c.id === activa} onAbrir={onAbrir} onBorrada={onBorrada} />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

function FilaConversacion({
  c, activa, onAbrir, onBorrada,
}: {
  c: ConversacionAgente;
  activa: boolean;
  onAbrir: (id: string) => void;
  onBorrada: (id: string) => void;
}) {
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(c.titulo);
  const [confirmar, setConfirmar] = useState(false);

  const guardar = async () => {
    setEditando(false);
    await renombrarConversacion(c, valor).catch(() => setValor(c.titulo));
  };

  if (editando) {
    return (
      <input
        autoFocus
        value={valor}
        maxLength={MAX_TITULO}
        onChange={(e) => setValor(e.target.value)}
        onBlur={guardar}
        onKeyDown={(e) => {
          if (e.key === "Enter") void guardar();
          if (e.key === "Escape") { setValor(c.titulo); setEditando(false); }
        }}
        className="mb-0.5 h-8 w-full rounded-md border bg-background px-2 text-xs outline-none ring-1 ring-ring"
      />
    );
  }

  return (
    <div
      className={cn(
        "group mb-0.5 flex items-center gap-1 rounded-md px-2 py-1.5 text-xs",
        activa ? "bg-primary/10 text-primary" : "hover:bg-muted",
      )}
    >
      <button type="button" onClick={() => onAbrir(c.id)} className="min-w-0 flex-1 truncate text-left" title={c.titulo}>
        {c.titulo}
      </button>
      {confirmar ? (
        <>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-destructive hover:bg-destructive/10"
            onClick={async () => { await borrarConversacion(c.id); onBorrada(c.id); }}
          >
            Borrar
          </button>
          <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-muted" onClick={() => setConfirmar(false)} aria-label="Cancelar">
            <X className="h-3 w-3" />
          </button>
        </>
      ) : (
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <button type="button" className="rounded p-0.5 hover:bg-background" onClick={() => void fijarConversacion(c)} aria-label={c.fijada ? "Desfijar" : "Fijar"} title={c.fijada ? "Desfijar" : "Fijar"}>
            {c.fijada ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
          </button>
          <button type="button" className="rounded p-0.5 hover:bg-background" onClick={() => setEditando(true)} aria-label="Renombrar" title="Renombrar">
            <Pencil className="h-3 w-3" />
          </button>
          <button type="button" className="rounded p-0.5 hover:bg-background" onClick={() => setConfirmar(true)} aria-label="Borrar" title="Borrar">
            <Trash2 className="h-3 w-3" />
          </button>
        </span>
      )}
    </div>
  );
}

// ── Mensajes ────────────────────────────────────────────────────────────────

function Bienvenida({ onElegir }: { onElegir: (t: string) => void }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-10 text-center">
      <div className="rounded-full bg-primary/10 p-3"><Bot className="h-7 w-7 text-primary" /></div>
      <div>
        <h2 className="text-lg font-semibold">GeorgIA</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pregunta cómo funciona cualquier parte del ecosistema SOZU: el código, la base de datos, las edge
          functions o cómo se usa cada pantalla. Responde con la documentación de sozu-docs y el código de los repos.
        </p>
      </div>
      <div className="grid w-full gap-2 sm:grid-cols-2">
        {SUGERENCIAS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onElegir(s)}
            className="rounded-lg border px-3 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Markdown({ texto }: { texto: string }) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none dark:prose-invert",
        "prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none",
        "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal",
        "prose-table:text-xs prose-a:text-primary",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
          // Una ruta de sozu-docs en `código` (p. ej. en "Fuentes:") se vuelve enlace al visor.
          code: ({ className, children }) => {
            const t = String(children ?? "");
            if (!className && esRutaDoc(t.replace(/^doc:\s*/, ""))) return <RefDoc ruta={t.replace(/^doc:\s*/, "")} enLinea />;
            return <code className={className}>{children}</code>;
          },
        }}
      >
        {texto}
      </ReactMarkdown>
    </div>
  );
}

function Pasos({ herramientas, enVivo }: { herramientas: HerramientaUsada[]; enVivo?: boolean }) {
  const [abierto, setAbierto] = useState(false);
  if (herramientas.length === 0) return null;
  const visibles = enVivo || abierto ? herramientas : [];
  return (
    <div className="mb-2 text-[11px] text-muted-foreground">
      {!enVivo && (
        <button type="button" onClick={() => setAbierto((v) => !v)} className="inline-flex items-center gap-1 hover:text-foreground">
          <Wrench className="h-3 w-3" />
          {herramientas.length} consulta{herramientas.length === 1 ? "" : "s"} {abierto ? "▾" : "▸"}
        </button>
      )}
      {visibles.length > 0 && (
        <ul className="mt-1 space-y-0.5 border-l pl-3">
          {visibles.map((h, i) => (
            <li key={i} className="flex items-center gap-1.5 truncate">
              {enVivo && i === visibles.length - 1 ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : <Check className="h-3 w-3 shrink-0" />}
              <span className="truncate">{h.etiqueta}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Burbuja({ mensaje }: { mensaje: MensajeAgente }) {
  const [copiado, setCopiado] = useState(false);
  if (mensaje.rol === "usuario") {
    return (
      <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">
        {mensaje.texto}
        {!!mensaje.adjuntos?.length && (
          <div className={cn("space-y-1.5 whitespace-normal", mensaje.texto && "mt-2")}>
            {mensaje.adjuntos.map((a) => <AdjuntoEnMensaje key={a.url} a={a} sobreColor />)}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="group">
      <Pasos herramientas={mensaje.herramientas} />
      <Markdown texto={mensaje.texto} />
      {mensaje.docs.length > 0 && <DocsConsultados docs={mensaje.docs} />}
      <button
        type="button"
        onClick={() => { void navigator.clipboard.writeText(mensaje.texto); setCopiado(true); setTimeout(() => setCopiado(false), 1500); }}
        className="mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
      >
        {copiado ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copiado ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}

function RespuestaEnCurso({ enCurso }: { enCurso: EnCurso }) {
  return (
    <div>
      <Pasos herramientas={enCurso.herramientas} enVivo={!enCurso.texto} />
      {enCurso.texto ? (
        <Markdown texto={enCurso.texto} />
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {enCurso.herramientas.length ? "Investigando…" : "Pensando…"}
        </p>
      )}
    </div>
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

function Composer({
  enviando, onEnviar, onDetener, restantes,
}: {
  enviando: boolean;
  onEnviar: (t: string, adjuntos: AdjuntoChat[]) => void;
  onDetener: () => void;
  restantes: number | null;
}) {
  const [texto, setTexto] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const adj = useAdjuntos({ carpeta: "chat", transcribir: true });

  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
  }, [texto]);

  const hayAlgo = !!texto.trim() || adj.listos.length > 0;
  const puedeMandar = hayAlgo && !enviando && !adj.ocupado && !adj.grabando;

  const mandar = () => {
    if (!puedeMandar) return;
    onEnviar(texto, adj.listos);
    setTexto("");
    adj.limpiar();
    adj.setError(null);
  };

  const alTeclear = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      mandar();
    }
  };

  return (
    <div className="border-t px-4 py-3 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <AdjuntosPendientes a={adj} className="mb-2 max-h-64 overflow-y-auto" />
        <div className="flex items-end gap-1 rounded-xl border bg-background px-2 py-2 focus-within:ring-2 focus-within:ring-ring">
          <BotonesAdjuntar a={adj} compacto />
          <textarea
            ref={ref}
            rows={1}
            value={texto}
            maxLength={MAX_MENSAJE}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={alTeclear}
            onPaste={adj.alPegar}
            placeholder="Pregunta sobre los repos, la base de datos o cómo se usa una pantalla…"
            className="max-h-[200px] flex-1 resize-none bg-transparent px-1 py-1 text-sm outline-none"
            autoFocus
          />
          {enviando ? (
            <button type="button" onClick={onDetener} className="rounded-lg bg-muted p-2 text-foreground hover:bg-muted/70" aria-label="Detener">
              <Square className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={mandar}
              disabled={!puedeMandar}
              title={adj.ocupado ? "Espera a que terminen de subir (o transcribirse) los adjuntos" : undefined}
              className="rounded-lg bg-primary p-2 text-primary-foreground transition-opacity disabled:opacity-40"
              aria-label="Enviar"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
        <p className="mt-1.5 flex justify-between gap-2 text-[10px] text-muted-foreground">
          {adj.error
            ? <span className="text-destructive">{adj.error}</span>
            : <span>Enter envía · Shift+Enter salto de línea · Alt+K abre/cierra · Imágenes, audios y videos (se transcriben)</span>}
          <span className="shrink-0">
            {texto.length >= MAX_MENSAJE * 0.8 && `${texto.length}/${MAX_MENSAJE} · `}
            {restantes !== null && restantes <= 10 && `${restantes} preguntas restantes esta hora`}
          </span>
        </p>
      </div>
    </div>
  );
}

// ── Documentación ───────────────────────────────────────────────────────────

const nombreDoc = (ruta: string) => ruta.replace(/^docs\//, "");

function RefDoc({ ruta, enLinea }: { ruta: string; enLinea?: boolean }) {
  const { puede, abrir } = useContext(DocsCtx);
  const r = nombreDoc(ruta.trim());
  const base = enLinea
    ? "inline-flex items-center gap-1 rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
    : "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]";
  if (!puede) {
    return (
      <span className={cn(base, "cursor-default text-muted-foreground")} title="No tienes el permiso «Ver documentación»">
        {!enLinea && <Lock className="h-3 w-3" />}
        {r}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => abrir(r)}
      className={cn(base, "text-primary transition-colors hover:bg-primary/10", !enLinea && "hover:border-primary/40")}
      title="Abrir documento"
    >
      {!enLinea && <FileText className="h-3 w-3" />}
      {r}
    </button>
  );
}

function DocsConsultados({ docs }: { docs: string[] }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">Documentación consultada:</span>
      {docs.map((d) => <RefDoc key={d} ruta={d} />)}
    </div>
  );
}

function VisorDoc({ ruta, onCerrar }: { ruta: string; onCerrar: () => void }) {
  const [doc, setDoc] = useState<DocumentoAgente | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Se monta con `key={ruta}`: cada documento arranca con estado limpio.
    let vivo = true;
    leerDocumento(ruta)
      .then((d) => vivo && setDoc(d))
      .catch((e) => vivo && setError(mensajeDeError(e)));
    return () => { vivo = false; };
  }, [ruta]);

  // Esc cierra el visor sin cerrar el panel entero.
  useEffect(() => {
    const alTeclear = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onCerrar(); }
    };
    window.addEventListener("keydown", alTeclear, true);
    return () => window.removeEventListener("keydown", alTeclear, true);
  }, [onCerrar]);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background" role="region" aria-label={`Documento ${ruta}`}>
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <button type="button" onClick={onCerrar} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Volver al chat">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <FileText className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{doc?.titulo ?? ruta}</p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            sozu-docs/docs/{ruta}{doc ? ` · ${doc.sha}` : ""}
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8">
        {error ? (
          <p className="mx-auto max-w-3xl rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        ) : !doc ? (
          <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="mx-auto max-w-3xl"><Markdown texto={doc.texto} /></div>
        )}
      </div>
    </div>
  );
}

