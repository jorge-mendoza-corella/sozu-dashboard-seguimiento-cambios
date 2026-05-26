import { RefreshCw, Clock, GitBranch, AlertCircle, CheckCircle2, GitPullRequest } from "lucide-react";
import { useGitHubStatus } from "@/hooks/useGitHubStatus";
import { RepoCard, RepoCardSkeleton } from "@/components/RepoCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "@/lib/timeUtils";

export function DashboardPage() {
  const { data, isLoading, isFetching, dataUpdatedAt, refetch } = useGitHubStatus();

  const summary = data
    ? {
        total: data.length,
        ok: data.filter((r) => !r.error && r.latestRuns.every((x) => x.conclusion !== "failure") && r.openPRs.length === 0).length,
        withPRs: data.filter((r) => r.openPRs.length > 0).length,
        failing: data.filter((r) => r.latestRuns.some((x) => x.conclusion === "failure")).length,
      }
    : null;

  return (
    <div className="flex flex-col gap-0">
      {/* ── Header con gradiente ── */}
      <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-slate-50 via-white to-slate-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 px-6 py-5">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-blue-100/40 via-transparent to-transparent dark:from-blue-900/10 pointer-events-none" />
        <div className="relative flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <GitBranch className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
              <h1 className="text-xl font-bold tracking-tight">Estado de Repositorios</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              CI/CD · Ramas · PRs · Workflows — se actualiza cada 2 min
            </p>
            {/* Summary chips */}
            {summary && !isLoading && (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <Badge variant="outline" className="gap-1 text-[11px] bg-white/80 dark:bg-slate-900/80">
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-400 inline-block" />
                  {summary.total} repos
                </Badge>
                {summary.ok > 0 && (
                  <Badge variant="outline" className="gap-1 text-[11px] bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/50 text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="h-3 w-3" />
                    {summary.ok} en orden
                  </Badge>
                )}
                {summary.withPRs > 0 && (
                  <Badge variant="outline" className="gap-1 text-[11px] bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/50 text-amber-700 dark:text-amber-300">
                    <GitPullRequest className="h-3 w-3" />
                    {summary.withPRs} con PRs
                  </Badge>
                )}
                {summary.failing > 0 && (
                  <Badge variant="outline" className="gap-1 text-[11px] bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300">
                    <AlertCircle className="h-3 w-3" />
                    {summary.failing} fallando
                  </Badge>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 mt-0.5">
            {dataUpdatedAt > 0 && (
              <span className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                {formatDistanceToNow(new Date(dataUpdatedAt).toISOString())}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="bg-white/80 dark:bg-slate-900/80">
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""} mr-1.5`} />
              {isFetching ? "Actualizando…" : "Actualizar"}
            </Button>
          </div>
        </div>
      </div>

      {/* ── Grid de cards ── */}
      <div className="p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
          {isLoading
            ? Array.from({ length: 5 }).map((_, i) => <RepoCardSkeleton key={i} />)
            : data?.map((repo) => <RepoCard key={repo.repo} status={repo} onRefetch={() => refetch()} />)}
        </div>
      </div>
    </div>
  );
}
