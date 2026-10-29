import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, GitMerge, GitPullRequestClosed, History, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/timeUtils";
import { DIAS_HISTORIAL_PRS, getHistorialMain, type CommitHistorial, type PrDevHistorial, type PrMainHistorial } from "@/lib/github";

// ---------------------------------------------------------------------------
// Historial de lo que llegó a main en los últimos DIAS_HISTORIAL_PRS días: cada
// PR a main con los PRs de dev que trajo y los commits de cada uno. Todo sale de
// una búsqueda y unas pocas consultas GraphQL al abrirlo (se adelanta al pasar
// el mouse); abrir un PR ya no consulta nada. Se puede filtrar por persona.
// ---------------------------------------------------------------------------

const MIO = "rounded bg-fuchsia-100 px-1 font-semibold text-fuchsia-700 dark:bg-fuchsia-900/50 dark:text-fuchsia-300";

export function HistorialPRs({ owner, repo, soloDe = null, esMio }: {
  owner: string;
  repo: string;
  /** null = los cambios de todos; si no, solo los de este login ("" = ninguno). */
  soloDe?: string | null;
  esMio: (login?: string | null) => boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const [persona, setPersona] = useState("");
  const qc = useQueryClient();
  const consulta = { queryKey: ["historial-main", owner, repo], queryFn: () => getHistorialMain(owner, repo), staleTime: 5 * 60_000 };
  const { data, isLoading, error } = useQuery({ ...consulta, enabled: abierto });

  // Sin «ver cambios de otros» la persona es siempre quien entra.
  const quien = soloDe ?? persona;
  const personas = useMemo(() => [...new Set((data ?? []).flatMap((p) => p.autores))].sort((a, b) => a.localeCompare(b)), [data]);
  const prs = useMemo(() => (data ?? []).map((p) => (quien === "" && soloDe === null ? p : soloDeAutor(p, quien))).filter((p): p is PrMainHistorial => !!p), [data, quien, soloDe]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        onMouseEnter={() => void qc.prefetchQuery(consulta)}
        className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <History className="h-3.5 w-3.5" /> Historial a main {data && `(${prs.length})`}
        <span className="font-normal normal-case tracking-normal">· últimos {DIAS_HISTORIAL_PRS} días como máximo</span>
        {abierto ? <ChevronDown className="ml-auto h-3.5 w-3.5" /> : <ChevronRight className="ml-auto h-3.5 w-3.5" />}
      </button>
      {abierto && (
        <div className="mt-2 space-y-1">
          {data && (
            soloDe === null ? (
              <label className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                Cambios de
                <select value={persona} onChange={(e) => setPersona(e.target.value)} className="h-6 rounded-md border bg-background px-1.5 text-[11px] text-foreground">
                  <option value="">todas las personas</option>
                  {personas.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
            ) : (
              <p className="mb-1.5 text-[11px] text-muted-foreground">Solo tus cambios.</p>
            )
          )}
          {isLoading && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Leyendo GitHub…</p>}
          {error && <p className="text-xs text-destructive">No se pudo leer el historial de GitHub.</p>}
          {data && prs.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Nada llegó a main{quien ? ` con cambios de ${quien}` : ""} en los últimos {DIAS_HISTORIAL_PRS} días.
            </p>
          )}
          {prs.map((p) => <FilaMain key={p.number} pr={p} owner={owner} repo={repo} esMio={esMio} />)}
        </div>
      )}
    </div>
  );
}

/** El PR con solo lo de `autor` (sus PRs de dev y commits); null si no trae nada suyo. */
function soloDeAutor(pr: PrMainHistorial, autor: string): PrMainHistorial | null {
  const suyo = (c: CommitHistorial) => c.author.toLowerCase() === autor.toLowerCase();
  const devPrs = pr.devPrs.map((d) => ({ ...d, commits: d.commits.filter(suyo) })).filter((d) => d.commits.length);
  const directos = pr.directos.filter(suyo);
  return devPrs.length || directos.length ? { ...pr, devPrs, directos } : null;
}

const commitsDe = (pr: PrMainHistorial) => pr.devPrs.reduce((n, d) => n + d.commits.length, 0) + pr.directos.length;

function FilaMain({ owner, repo, pr, esMio }: { owner: string; repo: string; pr: PrMainHistorial; esMio: (login?: string | null) => boolean }) {
  const [abierto, setAbierto] = useState(false);
  // Los releases se titulan con la rama ("dev"): se dice qué es.
  const titulo = pr.title.trim() === pr.head ? `Release ${pr.head} → main` : pr.title;
  const n = commitsDe(pr);
  return (
    <div className="rounded-md border bg-muted/20 text-xs">
      <div className="flex items-start gap-1.5 px-2 py-1.5">
        <button type="button" onClick={() => setAbierto((v) => !v)} className="flex min-w-0 flex-1 items-start gap-1.5 text-left">
          {abierto ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          {pr.merged
            ? <GitMerge className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-600" />
            : <GitPullRequestClosed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />}
          <span className="min-w-0">
            <span className="font-mono text-muted-foreground">#{pr.number}</span>{" "}
            <span className="font-medium">{titulo}</span>
            <span className="mt-0.5 block text-[10px] text-muted-foreground">
              <span title={new Date(pr.closedAt).toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}>
                {pr.merged ? "Llegó a main" : "Se cerró sin fusionar"} hace {formatDistanceToNow(pr.closedAt)}
              </span>
              {" · "}{pr.devPrs.length > 0 && `${pr.devPrs.length} PR${pr.devPrs.length === 1 ? "" : "s"} de dev · `}
              {n} commit{n === 1 ? "" : "s"}
            </span>
            {pr.autores.length > 0 && (
              <span className="block text-[10px] text-muted-foreground">
                Cambios de{" "}
                {pr.autores.map((a, i) => (
                  <span key={a} className="font-mono">
                    <span className={cn(esMio(a) && MIO)}>{a}</span>{i < pr.autores.length - 1 && ", "}
                  </span>
                ))}
                {" · "}abrió el PR <span className={cn("font-mono", esMio(pr.abrio) && MIO)}>{pr.abrio}</span>
              </span>
            )}
          </span>
        </button>
        <CopiarLink url={pr.url} />
        <a href={pr.url} target="_blank" rel="noreferrer" className="shrink-0 text-muted-foreground hover:text-primary" title="Abrir en GitHub">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      {abierto && (
        <div className="space-y-1 border-t px-2 py-2">
          {pr.devPrs.map((d) => <FilaDev key={d.number} owner={owner} repo={repo} pr={d} esMio={esMio} />)}
          {pr.directos.length > 0 && (
            <div>
              <p className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {pr.devPrs.length ? "Commits directos (sin PR de dev)" : "Commits"}
              </p>
              <Commits owner={owner} repo={repo} commits={pr.directos} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** PR hacia dev dentro de un PR a main: se abre para ver sus commits. */
function FilaDev({ owner, repo, pr, esMio }: { owner: string; repo: string; pr: PrDevHistorial; esMio: (login?: string | null) => boolean }) {
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
              hacia dev · de <span className={cn("font-mono", esMio(pr.author) && MIO)}>{pr.author}</span>
              {" · "}{pr.commits.length} commit{pr.commits.length === 1 ? "" : "s"}
            </span>
          </span>
        </button>
        <CopiarLink url={pr.url} chico />
        <a href={pr.url} target="_blank" rel="noreferrer" className="shrink-0 text-muted-foreground hover:text-primary" title="Abrir en GitHub">
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {abierto && <div className="border-t px-1 py-1"><Commits owner={owner} repo={repo} commits={pr.commits} /></div>}
    </div>
  );
}

/** Copia el link del PR (para pegarlo en un ticket o en el chat). */
function CopiarLink({ url, chico = false }: { url: string; chico?: boolean }) {
  const [copiado, setCopiado] = useState(false);
  const icono = chico ? "h-3 w-3" : "h-3.5 w-3.5";
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(url).then(() => {
          setCopiado(true);
          setTimeout(() => setCopiado(false), 1500);
        }).catch(() => {});
      }}
      className="shrink-0 text-muted-foreground hover:text-primary"
      title={copiado ? "Copiado" : "Copiar link del PR"}
    >
      {copiado ? <Check className={cn(icono, "text-emerald-600")} /> : <Copy className={icono} />}
    </button>
  );
}

function Commits({ owner, repo, commits }: { owner: string; repo: string; commits: CommitHistorial[] }) {
  return (
    <ul className="space-y-0.5 px-2">
      {commits.map((c) => (
        <li key={c.sha} className="flex items-baseline gap-1.5">
          <a href={`https://github.com/${owner}/${repo}/commit/${c.sha}`} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-[10px] text-primary hover:underline">{c.sha}</a>
          <span className="min-w-0 flex-1 truncate" title={c.message}>{c.message}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{c.author}</span>
        </li>
      ))}
    </ul>
  );
}
