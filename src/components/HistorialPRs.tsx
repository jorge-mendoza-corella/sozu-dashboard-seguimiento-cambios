import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink, GitMerge, GitPullRequestClosed, History, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/timeUtils";
import { DIAS_HISTORIAL_PRS, getContenidoPR, getHistorialPRs, getMergedDevPRsForRelease, type PRWithCommits, type PrHistorial } from "@/lib/github";

// ---------------------------------------------------------------------------
// Historial de PRs del repo (cerrados en los últimos DIAS_HISTORIAL_PRS días):
// contraído de entrada y sin consultar GitHub hasta abrirlo. Cada PR se abre
// para ver su descripción y sus commits, con enlace directo a GitHub.
// ---------------------------------------------------------------------------

export function HistorialPRs({ owner, repo, soloDe = null, esMio }: {
  owner: string;
  repo: string;
  /** null = los de todos; si no, solo los de este login ("" = ninguno). */
  soloDe?: string | null;
  esMio: (login?: string | null) => boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  // Hacia dev (ramas de trabajo), hacia main (releases y hotfixes) o todos.
  const [hacia, setHacia] = useState<"todos" | "dev" | "main">("todos");
  const { data, isLoading, error } = useQuery({
    queryKey: ["historial-prs", owner, repo],
    queryFn: () => getHistorialPRs(owner, repo),
    enabled: abierto,
    staleTime: 5 * 60_000,
  });
  const propios = (data ?? []).filter((p) => soloDe === null || p.author.toLowerCase() === soloDe.toLowerCase());
  const prs = propios.filter((p) => hacia === "todos" || p.base === hacia);
  const cuantos = (h: typeof hacia) => (h === "todos" ? propios.length : propios.filter((p) => p.base === h).length);

  return (
    <div>
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <History className="h-3.5 w-3.5" /> Historial de PRs {data && `(${prs.length})`}
        <span className="font-normal normal-case tracking-normal">· últimos {DIAS_HISTORIAL_PRS} días como máximo</span>
        {abierto ? <ChevronDown className="ml-auto h-3.5 w-3.5" /> : <ChevronRight className="ml-auto h-3.5 w-3.5" />}
      </button>
      {abierto && (
        <div className="mt-2 space-y-1">
          {data && (
            <div className="mb-1.5 inline-flex rounded-md border p-0.5 text-[11px]">
              {(["todos", "dev", "main"] as const).map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHacia(h)}
                  className={cn(
                    "rounded px-2 py-0.5 font-medium",
                    hacia === h ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {h === "todos" ? "Todos" : `Hacia ${h}`} ({cuantos(h)})
                </button>
              ))}
            </div>
          )}
          {isLoading && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Leyendo GitHub…</p>}
          {error && <p className="text-xs text-destructive">No se pudo leer el historial de GitHub.</p>}
          {data && prs.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Sin PRs cerrados{hacia === "todos" ? "" : ` hacia ${hacia}`} en los últimos {DIAS_HISTORIAL_PRS} días.
            </p>
          )}
          {prs.map((p) => <FilaPR key={p.number} owner={owner} repo={repo} pr={p} esMio={esMio} />)}
        </div>
      )}
    </div>
  );
}

function FilaPR({ owner, repo, pr, esMio }: { owner: string; repo: string; pr: PrHistorial; esMio: (login?: string | null) => boolean }) {
  const [abierto, setAbierto] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["contenido-pr", owner, repo, pr.number],
    queryFn: () => getContenidoPR(owner, repo, pr.number),
    enabled: abierto,
    staleTime: Infinity,
  });
  const aMain = pr.base === "main";
  // Un PR a main (release dev → main) trae PRs de dev: se listan con sus commits.
  const deDev = useQuery({
    queryKey: ["release-prs-dev", owner, repo, pr.number],
    queryFn: () => getMergedDevPRsForRelease(owner, repo, pr.number),
    enabled: abierto && aMain,
    staleTime: Infinity,
  });
  const conDev = aMain && !!deDev.data?.length;
  const shaDeDev = new Set((deDev.data ?? []).flatMap((d) => d.commits.map((c) => c.sha)));
  return (
    <div className="rounded-md border bg-muted/20 text-xs">
      <div className="flex items-start gap-1.5 px-2 py-1.5">
        <button type="button" onClick={() => setAbierto((v) => !v)} className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground" title="Ver qué contenía">
          {abierto ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        {pr.merged
          ? <GitMerge className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-600" />
          : <GitPullRequestClosed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />}
        <button type="button" onClick={() => setAbierto((v) => !v)} className="min-w-0 flex-1 text-left">
          <span className="font-mono text-muted-foreground">#{pr.number}</span>{" "}
          <span className="font-medium">{pr.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
            <span className="font-mono">{pr.head} → <span className={cn(aMain ? "text-emerald-700 dark:text-emerald-400" : "text-sky-600 dark:text-sky-400")}>{pr.base}</span></span>
            <span>·</span>
            <span className={cn("font-mono", esMio(pr.author) && "rounded bg-fuchsia-100 px-1 font-semibold text-fuchsia-700 dark:bg-fuchsia-900/50 dark:text-fuchsia-300")}>{pr.author}</span>
            <span>·</span>
            <span title={new Date(pr.closedAt).toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}>
              {pr.merged ? "fusionado" : "cerrado sin fusionar"} hace {formatDistanceToNow(pr.closedAt)}
            </span>
          </span>
        </button>
        <a href={pr.url} target="_blank" rel="noreferrer" className="shrink-0 text-muted-foreground hover:text-primary" title="Abrir en GitHub">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      {abierto && (
        <div className="space-y-2 border-t px-3 py-2">
          {(isLoading || (aMain && deDev.isLoading)) && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {data && (
            <>
              {data.descripcion && <p className="line-clamp-6 whitespace-pre-wrap text-[11px] text-muted-foreground">{data.descripcion}</p>}
              {aMain && !!deDev.data?.length && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {deDev.data.length} PR{deDev.data.length === 1 ? "" : "s"} hacia dev que incluye
                  </p>
                  {deDev.data.map((d) => <PrDeDev key={d.number} owner={owner} repo={repo} pr={d} esMio={esMio} />)}
                </div>
              )}
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {conDev ? "En total: " : ""}{data.commits.length} commit{data.commits.length === 1 ? "" : "s"} · {data.archivos} archivo{data.archivos === 1 ? "" : "s"}
              </p>
              {/* En un release los commits ya van dentro de cada PR de dev; aquí solo
                  los que no vinieron por uno (hechos directo sobre dev). */}
              <ul className="space-y-0.5">
                {data.commits.filter((c) => !conDev || (!/^Merge (pull request|branch)/.test(c.message) && !shaDeDev.has(c.sha))).map((c) => (
                  <li key={c.sha} className="flex items-baseline gap-1.5">
                    <a href={c.url} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-[10px] text-primary hover:underline">{c.sha}</a>
                    <span className="min-w-0 flex-1 truncate" title={c.message}>{c.message}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{c.author}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** PR hacia dev dentro de un release: se abre para ver sus commits. */
function PrDeDev({ owner, repo, pr, esMio }: { owner: string; repo: string; pr: PRWithCommits; esMio: (login?: string | null) => boolean }) {
  const [abierto, setAbierto] = useState(false);
  return (
    <div className="rounded border bg-background">
      <div className="flex items-start gap-1.5 px-2 py-1">
        <button type="button" onClick={() => setAbierto((v) => !v)} className="flex min-w-0 flex-1 items-start gap-1.5 text-left">
          {abierto ? <ChevronDown className="mt-0.5 h-3 w-3 shrink-0" /> : <ChevronRight className="mt-0.5 h-3 w-3 shrink-0" />}
          <span className="min-w-0">
            <span className="font-mono text-muted-foreground">#{pr.number}</span>{" "}
            <span className="font-medium">{pr.title}</span>
            <span className="block text-[10px] text-muted-foreground">
              <span className={cn("font-mono", esMio(pr.author) && "rounded bg-fuchsia-100 px-1 font-semibold text-fuchsia-700 dark:bg-fuchsia-900/50 dark:text-fuchsia-300")}>{pr.author}</span>
              {" · "}{pr.commits.length} commit{pr.commits.length === 1 ? "" : "s"}
            </span>
          </span>
        </button>
        <a href={pr.url} target="_blank" rel="noreferrer" className="shrink-0 text-muted-foreground hover:text-primary" title="Abrir en GitHub">
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {abierto && (
        <ul className="space-y-0.5 border-t px-3 py-1.5">
          {pr.commits.map((c) => (
            <li key={c.sha} className="flex items-baseline gap-1.5">
              <a href={`https://github.com/${owner}/${repo}/commit/${c.sha}`} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-[10px] text-primary hover:underline">{c.sha}</a>
              <span className="min-w-0 flex-1 truncate" title={c.message}>{c.message}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{c.author}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
