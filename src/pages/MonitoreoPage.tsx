import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ExternalLink, Loader2, RefreshCw, Siren, Ticket } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProjects } from "@/hooks/useProjectsRepos";
import { useAuth } from "@/hooks/useAuth";
import { useReposMonitoreo } from "@/hooks/useMonitoreo";
import { DetalleIssue } from "@/components/monitoreo/DetalleIssue";
import { EstadoRepos } from "@/components/monitoreo/EstadoRepos";
import { SelectNative } from "@/components/ui/select-native";
import {
  dispararSyncSentry, estaViejo, getSentryEstado, getSentryProyectos, permisoMonitoreoDe, pideRevision,
  type SentryIssue, type SentryProyecto, type SentryResumen,
} from "@/lib/sentry";

const Tendencia = lazy(() => import("@/components/monitoreo/Tendencia"));
const GraficaErrores = lazy(() => import("@/components/monitoreo/GraficaErrores"));

type Vista = "issues" | "estado";
const RANGOS = [14, 30, 90] as const;

/**
 * Errores de Sentry de los repos que le tocan al usuario, en dos pestañas:
 *
 *   Issues  qué hay que atender: cifras, gráfica de errores por día (apilada
 *           por repo), los repos con issues abiertos y lo resuelto reciente.
 *   Estado  página de estado: 90 días por repo y el % de días sin errores.
 *
 * Los filtros (proyecto y repo) aplican a las dos. Solo producción: es lo que
 * le pega a usuarios reales. Qué repos salen lo decide `monitoreoSentry` del
 * repo (Proyectos → Gestionar) y, por usuario, su alcance más `verMonitoreo`.
 */
export function MonitoreoPage() {
  const [params, setParams] = useSearchParams();
  const pideEstado = params.get("vista") === "estado";
  const [proyecto, setProyecto] = useState<string | null>(null);
  const [repoFiltro, setRepoFiltro] = useState<string | null>(null);
  const [rango, setRango] = useState<(typeof RANGOS)[number]>(14);
  const [abierto, setAbierto] = useState<{ issueId: string; repo: string; puedeResolver: boolean; puedeTicket: boolean } | null>(null);
  const { appUser } = useAuth();
  const { data: projects } = useProjects();
  // Solo los repos que le tocan: el permiso va por empresa, proyecto y repo.
  const { repos } = useReposMonitoreo(appUser);
  const slugs = useMemo(() => [...new Set(repos.map((r) => r.repo))].sort(), [repos]);
  const queryKey = ["sentry", slugs.join("|")];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => getSentryProyectos(slugs),
    enabled: slugs.length > 0,
    refetchInterval: 60_000,
  });

  // El cron de GitHub casi nunca corre en este repo: la pestaña abierta pide la
  // corrida cuando el dato envejece, y el refetch de cada minuto la recoge.
  const hayQueRevisar = !!data && pideRevision(data);
  useEffect(() => {
    if (hayQueRevisar) void dispararSyncSentry();
  }, [hayQueRevisar]);

  // slug de Sentry = nombre del repo → nombre del proyecto del dashboard.
  const filas = useMemo(() => {
    const proyectoPorId = new Map((projects ?? []).map((p) => [p.id, p]));
    const repoPorSlug = new Map(repos.map((r) => [r.repo, r]));
    return (data ?? [])
      .map((p) => {
        const repo = repoPorSlug.get(p.slug);
        const proy = repo ? proyectoPorId.get(repo.projectId) : undefined;
        return {
          p,
          r: p.produccion,
          proyecto: proy?.name || "Sin proyecto",
          repoCompleto: repo ? `${repo.owner}/${repo.repo}` : p.slug,
          puedeResolver: !!repo && permisoMonitoreoDe(appUser, proy?.clientId, repo.id, "resolverMonitoreo"),
          puedeTicket: !!repo && permisoMonitoreoDe(appUser, proy?.clientId, repo.id, "crearTicketMonitoreo"),
          veEstado: !!repo && permisoMonitoreoDe(appUser, proy?.clientId, repo.id, "verEstadoRepos"),
        };
      })
      .sort((a, b) => a.p.slug.localeCompare(b.p.slug));
  }, [data, projects, repos, appUser]);

  const nombresProyecto = useMemo(() => [...new Set(filas.map((f) => f.proyecto))].sort((a, b) => a.localeCompare(b, "es")), [filas]);
  const delProyecto = proyecto ? filas.filter((f) => f.proyecto === proyecto) : filas;
  const visibles = repoFiltro ? delProyecto.filter((f) => f.p.slug === repoFiltro) : delProyecto;
  // Estado de los repos: solo con `verEstadoRepos`, y solo de los repos donde lo tiene.
  const slugsEstado = filas.filter((f) => f.veEstado).map((f) => f.p.slug);
  const hayEstado = slugsEstado.length > 0;
  const { data: estados } = useQuery({
    queryKey: ["sentry-estado", slugsEstado.join("|")],
    queryFn: () => getSentryEstado(slugsEstado),
    enabled: hayEstado,
    refetchInterval: 60_000,
  });
  const estadoDe = new Map((estados ?? []).map((e) => [e.slug, e]));
  const conEstado = visibles.filter((f) => f.veEstado).map((f) => ({ ...f, e: estadoDe.get(f.p.slug) }));
  // Más de 14 días sale de `sentryEstado`: solo si se tiene para TODOS los repos a la vista.
  const rangosVisibles = visibles.every((f) => estadoDe.has(f.p.slug)) ? RANGOS : ([14] as const);
  const rangoEf = (rangosVisibles as readonly number[]).includes(rango) ? rango : 14;
  const vista: Vista = pideEstado && hayEstado ? "estado" : "issues";
  const conErrores = visibles
    .filter((f) => f.r.sinResolver > 0)
    .sort((a, b) => b.r.nuevos24h - a.r.nuevos24h || b.r.sinResolver - a.r.sinResolver || a.p.slug.localeCompare(b.p.slug));
  const resueltos = visibles
    .flatMap((f) => f.r.resueltos.map((i) => ({ i, slug: f.p.slug, repo: f.repoCompleto, puedeResolver: f.puedeResolver, puedeTicket: f.puedeTicket })))
    .sort((a, b) => (b.i.ultimaVez ?? "").localeCompare(a.i.ultimaVez ?? ""));

  const total = (k: (r: SentryResumen) => number) => visibles.reduce((s, f) => s + k(f.r), 0);
  const serieDe = (f: (typeof filas)[number]) => (rangoEf > 14 ? estadoDe.get(f.p.slug)?.serie90d ?? f.r.serie14d : f.r.serie14d);
  const eventosDe = (f: (typeof filas)[number]) => serieDe(f).slice(-rangoEf).reduce((a, b) => a + b, 0);
  const eventosRango = visibles.reduce((s, f) => s + eventosDe(f), 0);
  const revisado = (data ?? []).map((p) => p.revisadoAt).filter((x): x is string => !!x).sort()[0] ?? null;
  const viejo = (data ?? []).some(estaViejo);
  const cambiarVista = (v: Vista) => setParams(v === "issues" ? {} : { vista: v }, { replace: true });

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Siren className="h-5 w-5 text-red-600 dark:text-red-400" />
            <h1 className="text-xl font-bold tracking-tight">Monitoreo</h1>
          </div>
          <p className="text-sm text-muted-foreground">Errores de Sentry en producción.</p>
        </div>
        <Actualizar revisado={revisado} viejo={viejo} queryKey={queryKey} />
      </header>

      {isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
      {error && <p className="text-sm text-red-600">No se pudo leer el monitoreo: {(error as Error).message}</p>}
      {data && data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Todavía no hay datos de Sentry. El sync ya se pidió; en un par de minutos aparecen aquí.
        </p>
      )}

      {filas.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b">
            <nav className="-mb-px flex gap-1" aria-label="Vistas de monitoreo">
              {([["issues", "Issues", total((r) => r.sinResolver)], ...(hayEstado ? [["estado", "Estado de los repos", null] as const] : [])] as const).map(([v, nombre, cuenta]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => cambiarVista(v)}
                  className={cn(
                    "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
                    vista === v ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {nombre}
                  {cuenta ? <span className="rounded-full bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">{cuenta}</span> : null}
                </button>
              ))}
            </nav>
            <div className="flex flex-wrap items-center gap-2 pb-2">
              {nombresProyecto.length > 1 && (
                <SelectNative
                  className="h-8 w-auto text-xs"
                  value={proyecto ?? ""}
                  onChange={(e) => { setProyecto(e.target.value || null); setRepoFiltro(null); }}
                  aria-label="Filtrar por proyecto"
                >
                  <option value="">Todos los proyectos</option>
                  {nombresProyecto.map((n) => <option key={n} value={n}>{n}</option>)}
                </SelectNative>
              )}
              <SelectNative
                className="h-8 w-auto text-xs"
                value={repoFiltro ?? ""}
                onChange={(e) => setRepoFiltro(e.target.value || null)}
                aria-label="Filtrar por repo"
              >
                <option value="">Todos los repos</option>
                {delProyecto.map((f) => <option key={f.p.slug} value={f.p.slug}>{f.p.slug}</option>)}
              </SelectNative>
            </div>
          </div>

          {vista === "estado" ? (
            conEstado.length > 0 ? (
              <EstadoRepos filas={conEstado} />
            ) : (
              <p className="text-sm text-muted-foreground">No tienes permiso para ver el estado de {repoFiltro ?? "estos repos"}.</p>
            )
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Kpi valor={total((r) => r.sinResolver)} etiqueta="Issues sin resolver" tono={total((r) => r.sinResolver) > 0 ? "ambar" : "ok"} />
                <Kpi valor={total((r) => r.nuevos24h)} etiqueta="Nuevos en 24 h" tono={total((r) => r.nuevos24h) > 0 ? "rojo" : "ok"} />
                <Kpi valor={eventosRango} etiqueta={`Eventos en ${rangoEf} días`} />
                <Kpi valor={`${conErrores.length} / ${visibles.length}`} etiqueta="Repos con errores" tono={conErrores.length > 0 ? "ambar" : "ok"} />
              </div>

              <section className="rounded-lg border bg-card p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">Errores por día{repoFiltro ? ` · ${repoFiltro}` : ""}</h2>
                  {rangosVisibles.length > 1 && <div className="flex rounded-md border p-0.5 text-xs">
                    {rangosVisibles.map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setRango(d)}
                        className={cn("rounded px-2.5 py-0.5", rangoEf === d ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                      >
                        {d} d
                      </button>
                    ))}
                  </div>}
                </div>
                {eventosRango > 0 ? (
                  <Suspense fallback={<div className="h-56" />}>
                    <GraficaErrores
                      dias={rangoEf}
                      series={visibles.filter((f) => eventosDe(f) > 0).map((f) => ({ slug: f.p.slug, serie: serieDe(f) }))}
                    />
                  </Suspense>
                ) : (
                  <div className="flex h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Sin errores en los últimos {rangoEf} días.
                  </div>
                )}
              </section>

              <section className="space-y-3">
                <h2 className="text-sm font-semibold">Requieren atención</h2>
                {conErrores.length > 0 ? (
                  conErrores.map((f) => (
                    <RepoConErrores
                      key={f.p.slug}
                      p={f.p}
                      r={f.r}
                      proyecto={f.proyecto}
                      onAbrir={(issueId) => setAbierto({ issueId, repo: f.repoCompleto, puedeResolver: f.puedeResolver, puedeTicket: f.puedeTicket })}
                    />
                  ))
                ) : (
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
                    <CheckCircle2 className="h-4 w-4 shrink-0" /> Sin issues abiertos{repoFiltro ? ` en ${repoFiltro}` : ""}.
                  </div>
                )}
              </section>

              {resueltos.length > 0 && (
                <section className="space-y-2">
                  <h2 className="text-sm font-semibold text-muted-foreground">Resueltos recientemente</h2>
                  <ul className="divide-y overflow-hidden rounded-lg border bg-card">
                    {resueltos.map(({ i, slug, repo, puedeResolver, puedeTicket }) => (
                      <FilaIssue key={i.id} i={i} repo={slug} onAbrir={() => setAbierto({ issueId: i.id, repo, puedeResolver, puedeTicket })} />
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </>
      )}

      {abierto && (
        <DetalleIssue
          issueId={abierto.issueId}
          repo={abierto.repo}
          puedeResolver={abierto.puedeResolver}
          puedeTicket={abierto.puedeTicket}
          onCerrar={() => setAbierto(null)}
        />
      )}
    </div>
  );
}

const hace = (iso: string | null) => {
  if (!iso) return "—";
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  if (min < 48 * 60) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 1440)} d`;
};

const es24h = (iso: string | null) => !!iso && Date.now() - new Date(iso).getTime() < 86_400_000;

// Las URLs vienen de Firestore y terminan en un href: solo se aceptan de Sentry.
const deSentry = (url: string) => (/^https:\/\/[\w-]+\.sentry\.io\//.test(url) ? url : undefined);

/** "Actualizado hace X" de la corrida más vieja, con botón para pedir otra. */
function Actualizar({ revisado, viejo, queryKey }: { revisado: string | null; viejo: boolean; queryKey: string[] }) {
  const qc = useQueryClient();
  const [pidiendo, setPidiendo] = useState(false);
  const pedir = async () => {
    setPidiendo(true);
    await dispararSyncSentry(true);
    // El sync tarda alrededor de un minuto; el refetch de cada minuto lo recoge,
    // esto solo adelanta la primera lectura.
    setTimeout(() => {
      void qc.invalidateQueries({ queryKey });
      setPidiendo(false);
    }, 75_000);
  };
  return (
    <button
      type="button"
      onClick={() => void pedir()}
      disabled={pidiendo}
      title="Pide a Sentry los datos más recientes (tarda alrededor de un minuto)"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-60",
        viejo && !pidiendo ? "border-amber-500/60 text-amber-700 dark:text-amber-400" : "text-muted-foreground",
      )}
    >
      <RefreshCw className={cn("h-3.5 w-3.5", pidiendo && "animate-spin")} />
      {pidiendo ? "Actualizando…" : `Actualizado ${hace(revisado)}`}
    </button>
  );
}

function Kpi({ valor, etiqueta, tono }: { valor: number | string; etiqueta: string; tono?: "rojo" | "ambar" | "ok" }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div
        className={cn(
          "text-2xl font-bold tabular-nums",
          tono === "rojo" && "text-red-600 dark:text-red-400",
          tono === "ambar" && "text-amber-600 dark:text-amber-400",
          tono === "ok" && "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {typeof valor === "number" ? valor.toLocaleString("es-MX") : valor}
      </div>
      <div className="text-xs text-muted-foreground">{etiqueta}</div>
    </div>
  );
}

function NombreRepo({ p, proyecto }: { p: SentryProyecto; proyecto: string }) {
  return (
    <div className="min-w-0">
      <a href={deSentry(p.url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold hover:underline">
        {p.slug} <ExternalLink className="h-3 w-3 opacity-60" />
      </a>
      <p className="truncate text-xs text-muted-foreground">{proyecto}</p>
    </div>
  );
}

function CrashFree({ r }: { r: SentryResumen }) {
  if (r.crashFree === null) return null;
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums",
        r.crashFree < 0.99 ? "border-red-500/60 text-red-600 dark:text-red-400" : "border-emerald-500/60 text-emerald-600 dark:text-emerald-400",
      )}
      title="Sesiones sin crash, 14 días"
    >
      crash-free {(r.crashFree * 100).toFixed(2)}%
    </span>
  );
}

function RepoConErrores({ p, r, proyecto, onAbrir }: {
  p: SentryProyecto;
  r: SentryResumen;
  proyecto: string;
  onAbrir: (issueId: string) => void;
}) {
  const [abierto, setAbierto] = useState(true);
  const urgente = r.nuevos24h > 0;
  const eventos = r.serie14d.reduce((a, b) => a + b, 0);
  return (
    <article className={cn("overflow-hidden rounded-lg border border-l-4 bg-card", urgente ? "border-l-red-500" : "border-l-amber-500")}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 p-4">
        <NombreRepo p={p} proyecto={proyecto} />
        <div className="flex items-center gap-4 text-sm">
          <Dato valor={r.sinResolver} etiqueta="sin resolver" clase="text-amber-600 dark:text-amber-400" />
          <Dato valor={r.nuevos24h} etiqueta="nuevos 24 h" clase={urgente ? "text-red-600 dark:text-red-400" : undefined} />
          <Dato valor={eventos} etiqueta="eventos 14 d" />
        </div>
        <CrashFree r={r} />
        <div className="ml-auto flex min-w-[140px] flex-1 items-center justify-end gap-2 sm:max-w-[220px]">
          {eventos > 0 && (
            <Suspense fallback={<div className="h-9 w-full" />}>
              <Tendencia serie={r.serie14d} alto={36} color={urgente ? "#ef4444" : "#f59e0b"} />
            </Suspense>
          )}
          <button
            type="button"
            onClick={() => setAbierto(!abierto)}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            aria-label={abierto ? "Ocultar issues" : "Ver issues"}
          >
            <ChevronDown className={cn("h-4 w-4 transition-transform", !abierto && "-rotate-90")} />
          </button>
        </div>
      </div>
      {abierto && r.top.length > 0 && (
        <ul className="divide-y border-t">
          {r.top.map((i) => <FilaIssue key={i.id} i={i} onAbrir={() => onAbrir(i.id)} />)}
          {r.sinResolver > r.top.length && (
            <li className="px-4 py-2 text-xs">
              <a href={deSentry(p.url)} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                Ver los {r.sinResolver} en Sentry
              </a>
            </li>
          )}
        </ul>
      )}
    </article>
  );
}

function Dato({ valor, etiqueta, clase }: { valor: number; etiqueta: string; clase?: string }) {
  return (
    <div className="leading-tight">
      <span className={cn("font-bold tabular-nums", clase)}>{valor.toLocaleString("es-MX")}</span>{" "}
      <span className="text-xs text-muted-foreground">{etiqueta}</span>
    </div>
  );
}

const COLOR_NIVEL: Record<string, string> = {
  fatal: "bg-red-700",
  error: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
};

function FilaIssue({ i, onAbrir, repo }: { i: SentryIssue; onAbrir: () => void; repo?: string }) {
  const cerrado = i.estado === "resolved" || i.estado === "ignored";
  return (
    <li>
      <button type="button" onClick={onAbrir} className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-muted/60" title="Ver detalle">
        {cerrado ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
        ) : (
          <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", COLOR_NIVEL[i.nivel] ?? "bg-muted-foreground")} title={i.nivel} />
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm">
            <span className={cn("truncate font-medium", cerrado && "text-muted-foreground line-through decoration-muted-foreground/40")}>{i.titulo}</span>
            {cerrado && (
              <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                {i.estado === "ignored" ? "ignorado" : "resuelto"}
              </span>
            )}
            {i.ticket && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:bg-violet-950/50 dark:text-violet-300" title="Ticket del portal ligado a este issue">
                <Ticket className="h-3 w-3" /> SOZU-{i.ticket.numero}
              </span>
            )}
            {!cerrado && es24h(i.primeraVez) && (
              <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-700 dark:bg-red-950/50 dark:text-red-300">
                nuevo
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {repo && <>{repo} · </>}
            <span className="font-mono">{i.shortId}</span>
            {i.culprit && <> · {i.culprit}</>}
          </p>
        </div>
        <div className="hidden shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
          <div><span className="font-semibold text-foreground">{i.eventos.toLocaleString("es-MX")}</span> eventos · {i.usuarios} usuarios</div>
          <div>último {hace(i.ultimaVez)}</div>
        </div>
      </button>
    </li>
  );
}
