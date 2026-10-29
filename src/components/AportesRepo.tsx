import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, GitCommit, GitPullRequest, Loader2, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { getAportesPorAutor } from "@/lib/github";

/** "hoy" = desde la medianoche local. */
const PERIODOS = ["hoy", 7, 30] as const;
type Periodo = (typeof PERIODOS)[number];
const desdeDe = (p: Periodo) => {
  const d = new Date();
  if (p === "hoy") d.setHours(0, 0, 0, 0);
  else d.setTime(d.getTime() - p * 86_400_000);
  return d;
};
/** Llave estable del periodo (el "hoy" cambia de día a medianoche). */
const llaveDe = (p: Periodo) => (p === "hoy" ? new Date().toDateString() : p);
const nombreDe = (p: Periodo) => (p === "hoy" ? "hoy" : `los últimos ${p} días`);

/**
 * Arriba de la tarjeta del repo: quién lleva más commits HOY, contando solo lo
 * que ya llegó a PRD (sin commits de test), con sus PRs. Al darle clic se
 * despliega cuántos PRs y commits lleva cada quien: hoy, 7 o 30 días. Sin el
 * permiso "ver cambios de otros" solo se ven los números propios.
 */
export function AportesRepo({ owner, repo, selfLogin, myLogin }: {
  owner: string;
  repo: string;
  /** Con valor: solo puede ver lo suyo. */
  selfLogin?: string | null;
  /** Quien está logueado (se resalta en la lista). */
  myLogin?: string | null;
}) {
  const [abierto, setAbierto] = useState(false);
  const [dias, setDias] = useState<Periodo>("hoy");
  const { data, isLoading, error } = useQuery({
    queryKey: ["aportes", owner, repo, llaveDe(dias)],
    queryFn: () => getAportesPorAutor(owner, repo, desdeDe(dias)),
    staleTime: 10 * 60_000,
  });
  const esYo = (login: string) => !!myLogin && login.toLowerCase() === myLogin.toLowerCase();
  const visibles = (data ?? []).filter((a) => !selfLogin || a.login.toLowerCase() === selfLogin.toLowerCase());
  // El que va arriba sale siempre de hoy, aunque se esté viendo otro periodo.
  const { data: hoy } = useQuery({
    queryKey: ["aportes", owner, repo, llaveDe("hoy")],
    queryFn: () => getAportesPorAutor(owner, repo, desdeDe("hoy")),
    staleTime: 10 * 60_000,
    enabled: dias !== "hoy",
  });
  const lider = (dias === "hoy" ? data : hoy)?.find((a) => a.commits > 0);

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        title="Quién lleva cuántos PRs y commits que ya llegaron a PRD (sin commits de test)"
        className="flex w-full items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50/70 px-2 py-1 text-left text-[11px] text-amber-900 transition-colors hover:bg-amber-100 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200 dark:hover:bg-amber-900/40"
      >
        <Trophy className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        {lider && !selfLogin ? (
          <span className="min-w-0 truncate">
            Más commits hoy en PRD: <b className={cn("font-mono", esYo(lider.login) && "text-fuchsia-700 dark:text-fuchsia-300")}>{lider.login}</b>
            {" · "}{lider.prs} PR{lider.prs !== 1 ? "s" : ""}
            {" · "}{lider.commits} commit{lider.commits !== 1 ? "s" : ""}
          </span>
        ) : (
          <span className="min-w-0 truncate">{isLoading ? "Contando commits…" : selfLogin ? "Tus PRs y commits en PRD" : "Hoy no ha llegado nada a PRD"}</span>
        )}
        {abierto ? <ChevronDown className="ml-auto h-3 w-3 shrink-0" /> : <ChevronRight className="ml-auto h-3 w-3 shrink-0" />}
      </button>

      {abierto && (
        <div className="mt-1 rounded-md border bg-background p-2 shadow-sm">
          <div className="mb-1.5 flex items-center gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Llegó a PRD</span>
            <div className="ml-auto flex gap-0.5">
              {PERIODOS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setDias(p)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium",
                    dias === p ? "bg-amber-500 text-white" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {p === "hoy" ? "hoy" : `${p} d`}
                </button>
              ))}
            </div>
          </div>
          {isLoading ? (
            <div className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Contando…
            </div>
          ) : error ? (
            <p className="text-[11px] text-destructive">No se pudo leer GitHub.</p>
          ) : visibles.length === 0 ? (
            <p className="text-[11px] italic text-muted-foreground">No ha llegado nada a PRD {nombreDe(dias)}.</p>
          ) : (
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[10px] text-muted-foreground">
                  <th className="pb-1 text-left font-medium">Quién</th>
                  <th className="pb-1 text-right font-medium" title="PRs que llegaron a PRD en el periodo (los de dev dentro de cada release, y los directos a main)">
                    <GitPullRequest className="ml-auto h-3 w-3" />
                  </th>
                  <th className="pb-1 text-right font-medium" title="Commits que llegaron a PRD en el periodo (sin merges ni commits de test)">
                    <GitCommit className="ml-auto h-3 w-3" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((a, i) => (
                  <tr key={a.login} className="border-t border-border/40">
                    <td className={cn("py-0.5 font-mono", esYo(a.login) && "font-semibold text-fuchsia-700 dark:text-fuchsia-300")}>
                      {i === 0 && !selfLogin && a.commits > 0 ? "🏆 " : ""}{a.login}
                    </td>
                    <td className="py-0.5 text-right tabular-nums">{a.prs}</td>
                    <td className="py-0.5 text-right tabular-nums">{a.commits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
