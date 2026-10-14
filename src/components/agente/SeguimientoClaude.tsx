/**
 * Avance de Claude Code con un ticket ya mandado: estado, barra con el checklist
 * que Claude va palomeando, la conversación del issue y un cuadro para
 * responderle cuando pregunta (o para pedirle ajustes) sin salir del dashboard.
 *
 * Se consulta cada 15 s mientras trabaja y cada minuto en lo demás, solo con el
 * ticket abierto.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, ChevronDown, Terminal, ExternalLink, GitPullRequest, Loader2, MessageCircleQuestion, Send, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConsolaFlotante } from "./ConsolaClaude";
import { AvisoTokenClaude } from "./AvisoTokenClaude";
import { AdjuntoEnMensaje, AdjuntosPendientes, BotonesAdjuntar } from "./Adjuntos";
import { useAdjuntos } from "@/hooks/useAdjuntos";
import { useConsola, type Consola } from "@/hooks/useConsolaClaude";
import { mensajeDeError } from "@/lib/agenteRepos";
import {
  avancePrs, duracion, siglaRepo, type PrClaude, responderAClaude, seguimientoClaude,
  type EstadoClaude, type EstadoPr, type MensajeClaude,
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

/** Quita la firma que lleva el comentario en GitHub ("— correo, desde el dashboard"): ya va en el encabezado. */
const sinFirma = (t: string) => t.replace(/\n*\s*—\s*\S+@\S+,\s*desde el dashboard\s*$/i, "").trimEnd();

/** Texto tal cual (con sus saltos de línea) y las URLs como enlace. */
function TextoPlano({ texto }: { texto: string }) {
  const partes = texto.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
      {partes.map((p, i) =>
        /^https?:\/\//.test(p)
          ? <a key={i} href={p} target="_blank" rel="noreferrer" className="underline underline-offset-2 opacity-90 hover:opacity-100">{p}</a>
          : p,
      )}
    </p>
  );
}

function Mensaje({ m }: { m: MensajeClaude }) {
  const deClaude = m.autor === "claude";
  const separado = separarAdjuntos(m.cuerpo);
  const adjuntos = separado.adjuntos;
  // Lo tuyo se muestra como lo escribiste: sin Markdown (que junta los
  // renglones) y sin la firma de GitHub. Lo de Claude sí es Markdown.
  const texto = deClaude ? separado.texto : sinFirma(separado.texto);
  return (
    <div className={cn("flex gap-2", !deClaude && "flex-row-reverse")} data-pregunta={m.esPregunta || undefined}>
      <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", deClaude ? "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300" : "bg-primary/15 text-primary")}>
        {deClaude ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
      </span>
      <div
        className={cn(
          "min-w-0 max-w-[88%] px-3 py-2 shadow-sm",
          deClaude
            ? cn("rounded-2xl rounded-tl-sm border", m.esPregunta ? "border-amber-400/70 bg-amber-50 dark:bg-amber-950/30" : "bg-background")
            : "rounded-2xl rounded-tr-sm bg-violet-600 text-white dark:bg-violet-700",
        )}
      >
        <p className={cn("mb-1 flex items-center gap-1.5 text-[10px]", deClaude ? "text-muted-foreground" : "justify-end text-violet-100")}>
          {m.esPregunta && <MessageCircleQuestion className="h-3 w-3 text-amber-600" />}
          {deClaude ? (m.esSeguimiento ? "Claude · avance" : m.esPregunta ? "Claude pregunta" : "Claude") : m.quien ?? "Tú"}
          <span>· {hora(m.fecha)}</span>
        </p>
        {deClaude ? (
          <div className="prose prose-xs max-w-none break-words text-xs dark:prose-invert prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-a:text-primary prose-pre:text-[11px]">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
              {texto}
            </ReactMarkdown>
          </div>
        ) : texto && <TextoPlano texto={texto} />}
        {adjuntos.length > 0 && (
          <div className="mt-1.5 space-y-1.5">
            {adjuntos.map((a) => <AdjuntoEnMensaje key={a.url} a={a} sobreColor={!deClaude} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Qué sesión de Claude Code trabaja este ticket. Corre en GitHub Actions (no en
 * tu Mac), así que no sale en `claude --resume`; el chip dice cuál es (ticket,
 * asunto, repos, id) y copia un comando para retomarlo desde la terminal en su
 * misma rama. La transcripción completa queda como artefacto de la corrida.
 */
function SesionClaude({ folio, titulo, issue, sesion, runUrl, repos }: {
  folio: string;
  titulo: string;
  issue: { numero: number; url: string };
  sesion: string | null;
  runUrl: string | null;
  repos: string[];
}) {
  const [copiado, setCopiado] = useState(false);
  const numero = folio.replace(/^#/, "");
  const siglas = [...new Set(repos.map(siglaRepo))];
  const corto = titulo.length > 38 ? `${titulo.slice(0, 37)}…` : titulo;
  const comando = [
    `# Ticket ${folio} · ${titulo}`,
    `# issue jorgeIMendoza/sozu-georgia-tareas#${issue.numero}${sesion ? ` · sesión ${sesion}` : ""}${siglas.length ? ` · repos ${siglas.join(" ")}` : ""}`,
    `gh issue view ${issue.numero} -R jorgeIMendoza/sozu-georgia-tareas --comments`,
    `claude "Retoma el ticket ${folio} (${titulo}). Contexto: issue jorgeIMendoza/sozu-georgia-tareas#${issue.numero} y sus comentarios (léelos con gh). Rama fix/ticket-${numero} en ${repos.length ? repos.join(", ") : "los repos de sus PRs"}."`,
  ].join("\n");
  const copiar = async () => {
    await navigator.clipboard.writeText(comando);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 1600);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => void copiar()}
        className="inline-flex max-w-[22rem] items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
        title={[
          `Sesión de Claude Code · ticket ${folio}`,
          titulo,
          sesion ? `Id de sesión: ${sesion}` : "El id de sesión llega al terminar la corrida.",
          siglas.length ? `Repos: ${siglas.join(", ")}` : null,
          "Corre en GitHub Actions, no en tu Mac. Clic: copia el comando para retomarlo en la terminal.",
        ].filter(Boolean).join("\n")}
      >
        <Terminal className="h-3 w-3 shrink-0" />
        <span className="font-semibold text-foreground">Sesión {numero}</span>
        <span className="truncate">· {corto}</span>
        {siglas.map((x) => <span key={x} className="rounded bg-muted px-1 font-bold">{x}</span>)}
        {sesion && <span className="font-mono opacity-70">{sesion.slice(0, 8)}</span>}
        <span className="shrink-0 text-primary">{copiado ? "copiado" : "· copiar"}</span>
      </button>
      {runUrl && (
        <a href={`${runUrl}#artifacts`} target="_blank" rel="noreferrer" className="text-[10px] text-muted-foreground hover:text-foreground hover:underline" title="Transcripción completa de la sesión (artefacto de la corrida, 14 días)">
          transcripción
        </a>
      )}
    </span>
  );
}

/**
 * PRs agrupados por repo, cada repo contraído por default: sigla, cuántos PRs
 * y en qué van. Al abrirlo, sus PRs y la sesión de Claude en ese repo (la
 * consola filtrada a lo que hizo ahí) y el comando para retomarlo.
 */
function ReposDelTicket({ trabajando, prs, consola, folio, titulo, issue, onSesion }: {
  /** Con la corrida activa, se resalta el repo de la última acción de la consola. */
  trabajando: boolean;
  prs: PrClaude[];
  consola: Consola;
  folio: string;
  titulo: string;
  issue: { numero: number; url: string };
  onSesion: (sigla: string) => void;
}) {
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());
  const [copiado, setCopiado] = useState<string | null>(null);
  const grupos = [...prs.reduce((m, p) => m.set(p.repo, [...(m.get(p.repo) ?? []), p]), new Map<string, PrClaude[]>())];
  const ultimaConRepo = trabajando ? [...consola.lineas].reverse().find((l) => l.repo) : undefined;
  const numero = folio.replace(/^#/, "");

  return (
    <ul className="space-y-1">
      {grupos.map(([repo, lista]) => {
        const sig = siglaRepo(repo);
        const abierto = abiertos.has(repo);
        const aqui = ultimaConRepo?.repo === sig;
        const acciones = consola.lineas.filter((l) => l.repo === sig).length;
        const conteo = lista.reduce<Record<string, number>>((c, p) => ({ ...c, [p.estado]: (c[p.estado] ?? 0) + 1 }), {});
        const resumen = (Object.keys(conteo) as EstadoPr[]).map((e) => `${conteo[e]} ${ETIQUETA_PR[e]}`).join(" · ");
        const comando = [
          `# Ticket ${folio} · ${titulo} · repo ${repo} (${sig})`,
          `gh issue view ${issue.numero} -R jorgeIMendoza/sozu-georgia-tareas --comments`,
          `gh repo clone ${lista[0].owner}/${repo} && cd ${repo} && git switch fix/ticket-${numero}`,
          `claude "Retoma el ticket ${folio} (${titulo}) en este repo. Contexto: issue jorgeIMendoza/sozu-georgia-tareas#${issue.numero} y sus comentarios (léelos con gh). PRs: ${lista.map((p) => `#${p.numero}`).join(", ")}."`,
        ].join("\n");
        return (
          <li
            key={repo}
            className={cn(
              "rounded-md border bg-background transition-colors duration-300",
              aqui && "border-violet-400 bg-violet-50/70 ring-1 ring-violet-300 dark:border-violet-700 dark:bg-violet-950/30 dark:ring-violet-800",
            )}
          >
            <button
              type="button"
              onClick={() => setAbiertos((a) => { const n = new Set(a); if (n.has(repo)) n.delete(repo); else n.add(repo); return n; })}
              aria-expanded={abierto}
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] hover:bg-muted/50"
            >
              <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200", !abierto && "-rotate-90")} />
              <span className="rounded bg-violet-100 px-1 text-[9px] font-bold text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">{sig}</span>
              <span className="font-medium">{repo}</span>
              <span className="text-muted-foreground">· {lista.length} PR{lista.length === 1 ? "" : "s"}</span>
              {aqui && ultimaConRepo && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-violet-600 px-1.5 py-px text-[9px] font-semibold text-white"
                  title={ultimaConRepo.texto}
                >
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none" />
                  trabajando aquí · hace {duracion(new Date(ultimaConRepo.t).toISOString())}
                </span>
              )}
              <span className="ml-auto truncate text-[10px] text-muted-foreground">{resumen}</span>
            </button>
            {abierto && (
              <div className="space-y-1.5 border-t px-2 py-1.5">
                <div className="flex flex-wrap gap-1.5">
                  {lista.map((p) => (
                    <a
                      key={p.url}
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      title={p.titulo || undefined}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-muted"
                    >
                      <GitPullRequest className="h-3 w-3" /> #{p.numero}
                      {p.titulo && <span className="max-w-[14rem] truncate font-normal text-foreground">{p.titulo}</span>}
                      <span className={cn("font-normal", COLOR_PR[p.estado])}>· {ETIQUETA_PR[p.estado]}</span>
                    </a>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                  <button
                    type="button"
                    onClick={() => onSesion(sig)}
                    className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-2 py-0.5 font-medium text-zinc-200 hover:bg-zinc-800"
                    title={`Lo que hizo Claude en ${repo} (consola filtrada)`}
                  >
                    <Terminal className="h-3 w-3" /> Sesión en {sig}
                    <span className="opacity-70">· {acciones} acciones</span>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(comando);
                      setCopiado(repo);
                      setTimeout(() => setCopiado(null), 1600);
                    }}
                    className="rounded-md border px-2 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Copia los comandos para retomar este repo en la terminal (rama del ticket)"
                  >
                    {copiado === repo ? "copiado" : "Seguir en terminal"}
                  </button>
                  {consola.sesion && <span className="font-mono text-muted-foreground" title={`Id de sesión: ${consola.sesion}`}>{consola.sesion.slice(0, 8)}</span>}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
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

export function SeguimientoClaude({ ticketId, folio, titulo, issue, enfocar = false, onEnfocado, onListo }: {
  ticketId: string;
  /** Para ubicar la sesión: "#1274" y el asunto. */
  folio: string;
  titulo: string;
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
  const zonaAvance = useRef<HTMLDivElement>(null);
  const consola = useConsola(issue.numero);
  // Ventana flotante de la consola; con `repo` (sigla), solo lo de ese repo.
  const [ventanaConsola, setVentanaConsola] = useState<{ repo: string | null } | null>(null);
  const cerrarVentana = useCallback(() => setVentanaConsola(null), []);
  const cargado = !!q.data;
  const listo = !!q.data?.listoParaCerrar;
  const esperandoAhora = q.data?.estado === "esperando_respuesta";
  useEffect(() => {
    if (listo) onListo?.();
    // Solo al pasar a listo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listo]);

  // Al abrir el ticket, una vez por apertura, se lleva la vista a lo vigente:
  //  - espera respuesta (desde la lista o desde GeorgIA): las preguntas de Claude
  //    y el cuadro de respuesta, con el cursor;
  //  - trabajando: el avance (barra y consola) y la conversación en lo último.
  const yaEnfocado = useRef(false);
  const trabajandoAhora = activo(q.data?.estado);
  useEffect(() => {
    if (yaEnfocado.current || !cargado) return;
    if (!(enfocar || esperandoAhora) && trabajandoAhora) {
      yaEnfocado.current = true;
      const t = setTimeout(() => {
        const caja = conversacion.current;
        if (caja) caja.scrollTop = caja.scrollHeight;
        zonaAvance.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 350);
      return () => clearTimeout(t);
    }
    if (!(enfocar || esperandoAhora)) return;
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
  }, [enfocar, esperandoAhora, trabajandoAhora, cargado, onEnfocado]);

  const [enviando, setEnviando] = useState(false);

  // Adjuntos: se suben en cuanto se eligen; la respuesta lleva sus URLs (el
  // orquestador transcribe audios y videos en la corrida).
  const adj = useAdjuntos({ carpeta: ticketId });
  const subiendo = adj.ocupado;
  const error = adj.error;
  const setError = adj.setError;

  const responder = async () => {
    setEnviando(true);
    setError(null);
    try {
      await responderAClaude(ticketId, texto, adj.listos.map(({ nombre, tipo, url }) => ({ nombre, tipo, url })));
      setTexto("");
      adj.limpiar();
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
  const ultimaAccion = consola.lineas.at(-1) ?? null;
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
        <SesionClaude folio={folio} titulo={titulo} issue={issue} sesion={consola.sesion} runUrl={s?.runUrl ?? null} repos={(s?.prs ?? []).map((p) => p.repo)} />
        {s && <span className="ml-auto text-[10px] text-muted-foreground">revisado {hora(s.revisado)}</span>}
      </div>

      {s?.estado === "error" && s.fallo?.causa === "token_vencido" && <AvisoTokenClaude fallo={s.fallo} />}
      {s?.estado === "error" && s.fallo?.causa === "limite_suscripcion" && (
        <p className="rounded-lg border border-amber-300 bg-amber-50/70 p-2.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          <strong>Falló porque se acabó la ventana de 5 horas de Claude.</strong> Cuando se reinicie, contéstale "reintenta" y sigue donde se quedó.
          {s.fallo.detalle && <span className="mt-1 block break-all font-mono text-[10.5px] opacity-75">{s.fallo.detalle}</span>}
        </p>
      )}
      {s?.estado === "error" && s.fallo && !["token_vencido", "limite_suscripcion"].includes(s.fallo.causa) && s.fallo.detalle && (
        <p className="break-all rounded-lg border border-red-300/60 bg-red-50/50 p-2.5 font-mono text-[10.5px] text-red-900 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-200">
          {s.fallo.detalle}
        </p>
      )}
      {s && !(activo(s.estado) || pct !== null) && consola.lineas.length > 0 && (
        <button
          type="button"
          onClick={() => setVentanaConsola({ repo: null })}
          className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-2 py-0.5 text-[10px] font-medium text-zinc-200 hover:bg-zinc-800"
          title="Ver la consola de la última corrida"
        >
          <Terminal className="h-3 w-3" /> Consola
        </button>
      )}
      {s && (activo(s.estado) || pct !== null) && (
        <div ref={zonaAvance} className="scroll-mt-4">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1"><Barra estado={s.estado} pct={pct} /></div>
            {/* Acceso rápido a la consola, en ventana flotante. */}
            {(consola.lineas.length > 0 || activo(s.estado)) && (
              <button
                type="button"
                onClick={() => setVentanaConsola({ repo: null })}
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-zinc-900 px-2 py-0.5 text-[10px] font-medium text-zinc-200 hover:bg-zinc-800"
                title="Ver la consola de Claude en una ventana"
              >
                <Terminal className="h-3 w-3" />
                Consola
                {(consola.activo || activo(s.estado)) && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 motion-reduce:animate-none" />}
              </button>
            )}
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {s.progreso
              ? `${s.progreso.hechos} de ${s.progreso.total} pasos${activo(s.estado) && s.progreso.hechos === s.progreso.total ? " · cerrando la corrida…" : ""}`
              : s.estado === "en_cola" ? "Esperando a que arranque la corrida…" : "Arrancando…"}
            {/* La lista de pasos la actualiza Claude cuando se acuerda; la consola
                dice si de verdad sigue haciendo algo. */}
            {activo(s.estado) && ultimaAccion && (
              <span title={ultimaAccion.texto}> · última acción hace {duracion(new Date(ultimaAccion.t).toISOString())}: {ultimaAccion.texto.slice(0, 70)}{ultimaAccion.texto.length > 70 ? "…" : ""}</span>
            )}
          </p>
        </div>
      )}

      {s && s.prs.length > 0 && (
        <div className="space-y-1.5">
          <ReposDelTicket
            trabajando={activo(s.estado)}
            prs={s.prs}
            consola={consola}
            folio={folio}
            titulo={titulo}
            issue={issue}
            onSesion={(repo) => setVentanaConsola({ repo })}
          />
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

      {ventanaConsola && (
        <ConsolaFlotante
          consola={consola}
          trabajando={activo(s?.estado)}
          titulo={ventanaConsola.repo ? `${ventanaConsola.repo} · ${folio}` : `${folio} · issue #${issue.numero}`}
          filtro={ventanaConsola.repo}
          onCerrar={cerrarVentana}
        />
      )}

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
          onPaste={adj.alPegar}
          rows={esperando ? 3 : 2}
          maxLength={4000}
          placeholder={esperando ? "Tu respuesta para Claude…" : "Pídele un ajuste o dale más contexto…"}
          className="w-full resize-y bg-transparent text-xs outline-none"
        />
        <AdjuntosPendientes a={adj} className="mb-2" />
        <div className="flex items-center gap-2">
          <BotonesAdjuntar a={adj} />
          {error && <p className="flex-1 text-[11px] text-destructive">{error}</p>}
          {!error && <span className="flex-1 text-[10px] text-muted-foreground">{activo(s?.estado) ? "Si sigue trabajando, tu mensaje entra al terminar la corrida actual." : "Audios y videos se transcriben para Claude."}</span>}
          <button
            type="button"
            onClick={() => void responder()}
            disabled={enviando || subiendo || adj.grabando || (!texto.trim() && adj.listos.length === 0)}
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
