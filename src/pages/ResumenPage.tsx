import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  LayoutDashboard, GitBranch, GitPullRequest, Rocket, ArrowUpCircle,
  AlertCircle, Loader2, RefreshCw, Smartphone, FolderGit2, ChevronRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useProjects, useRepos, useAccessibleRepoIds } from "@/hooks/useProjectsRepos";
import { useGitHubStatus } from "@/hooks/useGitHubStatus";
import { hasFailingDeploy, type RepoRef, type RepoStatus } from "@/lib/github";
import { SUPERUSER_EMAIL, resolvePermissions } from "@/lib/firestoreUsers";
import { cn } from "@/lib/utils";

interface ProjectMetrics {
  repos: number;
  enPRD: number;        // dev == main, sin PRs, sin fallos
  devPendiente: number; // repos con dev adelantado de main (falta merge a PRD)
  commitsPendientes: number; // total de commits de dev que main no tiene
  prsAbiertos: number;
  fallando: number;
  deployando: number;
}

export function ResumenPage() {
  const { appUser } = useAuth();
  const isRoot = appUser?.email === SUPERUSER_EMAIL;
  const perms = resolvePermissions(appUser);
  const navigate = useNavigate();

  const { data: allProjects = [], isLoading: loadingProjects } = useProjects();
  const { data: allRepos = [], isLoading: loadingRepos } = useRepos();

  // Misma visibilidad que CI/CD: repos donde su cuenta GitHub es colaboradora.
  const { data: accessibleIds } = useAccessibleRepoIds(
    allRepos,
    isRoot ? null : appUser?.githubToken ?? null,
    appUser?.githubLogin ?? null,
  );
  const repos = useMemo(() => {
    if (isRoot || !appUser?.githubToken) return allRepos;
    if (!accessibleIds) return [];
    const ok = new Set(accessibleIds);
    return allRepos.filter((r) => ok.has(r.id));
  }, [allRepos, accessibleIds, isRoot, appUser?.githubToken]);

  // Proyectos visibles según acceso del usuario.
  const projects = useMemo(() => {
    if (isRoot) return allProjects;
    const ids = appUser?.projectIds;
    if (!ids || ids.length === 0) return allProjects;
    return allProjects.filter((p) => ids.includes(p.id));
  }, [allProjects, isRoot, appUser?.projectIds]);

  const repoRefs: RepoRef[] = useMemo(
    () => repos.map((r) => ({ owner: r.owner, repo: r.repo, label: r.label })),
    [repos],
  );
  const { data: statuses, isLoading, isFetching, refetch } = useGitHubStatus(repoRefs);

  const statusByKey = useMemo(() => {
    const m = new Map<string, RepoStatus>();
    for (const s of statuses ?? []) m.set(`${s.owner}/${s.repo}`, s);
    return m;
  }, [statuses]);

  const metricsByProject = useMemo(() => {
    const m = new Map<string, ProjectMetrics>();
    for (const p of projects) {
      const projRepos = repos.filter((r) => r.projectId === p.id);
      const sts = projRepos
        .map((r) => statusByKey.get(`${r.owner}/${r.repo}`))
        .filter((s): s is RepoStatus => !!s);
      const scopedPRs = (s: RepoStatus) =>
        perms.viewOthers || !appUser?.githubLogin || isRoot
          ? s.openPRs
          : s.openPRs.filter((pr) => pr.author === appUser.githubLogin);
      const devAhead = (s: RepoStatus) => s.branches.find((b) => b.name === "dev")?.aheadOfMain ?? 0;
      m.set(p.id, {
        repos: projRepos.length,
        enPRD: sts.filter((s) => !s.error && devAhead(s) === 0 && s.openPRs.length === 0 && !hasFailingDeploy(s.latestRuns)).length,
        devPendiente: sts.filter((s) => devAhead(s) > 0).length,
        commitsPendientes: sts.reduce((acc, s) => acc + devAhead(s), 0),
        prsAbiertos: sts.reduce((acc, s) => acc + scopedPRs(s).length, 0),
        fallando: sts.filter((s) => hasFailingDeploy(s.latestRuns)).length,
        deployando: sts.filter((s) =>
          s.latestRuns.some((r) => r.status === "in_progress" || r.status === "queued"),
        ).length,
      });
    }
    return m;
  }, [projects, repos, statusByKey, perms.viewOthers, appUser?.githubLogin, isRoot]);

  const busy = loadingProjects || loadingRepos;

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <LayoutDashboard className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            <h1 className="text-xl font-bold tracking-tight">Resumen de Proyectos</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Estado global por proyecto — click en uno para ir a su CI/CD.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn("h-4 w-4 mr-1.5", isFetching && "animate-spin")} />
          {isFetching ? "Actualizando…" : "Actualizar"}
        </Button>
      </div>

      {busy ? (
        <div className="flex h-48 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Cargando proyectos…
        </div>
      ) : projects.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
          <FolderGit2 className="h-8 w-8" />
          <p>No hay proyectos visibles.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => {
            const mt = metricsByProject.get(p.id);
            const ok = mt && mt.fallando === 0 && mt.devPendiente === 0 && mt.prsAbiertos === 0;
            return (
              <Card
                key={p.id}
                onClick={() => navigate(`/?project=${p.id}`)}
                className={cn(
                  "cursor-pointer overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-lg",
                  mt && mt.fallando > 0 && "border-red-300 dark:border-red-900/60",
                )}
              >
                {/* Acento superior según salud */}
                <div
                  className={cn(
                    "h-1 w-full bg-gradient-to-r",
                    mt && mt.fallando > 0
                      ? "from-red-500 to-red-400"
                      : mt && (mt.devPendiente > 0 || mt.prsAbiertos > 0)
                        ? "from-amber-500 to-amber-400"
                        : "from-emerald-500 to-emerald-400",
                  )}
                />
                <CardContent className="p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                    <h2 className="flex-1 truncate text-base font-bold">{p.name}</h2>
                    {p.isApp && (
                      <span className="flex items-center gap-0.5 rounded bg-blue-100 px-1.5 py-0.5 text-[9px] font-bold text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                        <Smartphone className="h-2.5 w-2.5" /> APP
                      </span>
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>

                  {!mt || isLoading ? (
                    <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> calculando…
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <div className="flex items-center gap-2">
                        <GitBranch className="h-4 w-4 text-slate-400" />
                        <span className="font-semibold tabular-nums">{mt.repos}</span>
                        <span className="text-xs text-muted-foreground">repos</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Rocket className="h-4 w-4 text-emerald-500" />
                        <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{mt.enPRD}</span>
                        <span className="text-xs text-muted-foreground">al día en PRD</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <ArrowUpCircle className="h-4 w-4 text-blue-500" />
                        <span className={cn("font-semibold tabular-nums", mt.devPendiente > 0 ? "text-blue-600 dark:text-blue-400" : "")}>
                          {mt.devPendiente}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          por pasar a PRD{mt.commitsPendientes > 0 ? ` (${mt.commitsPendientes} commits)` : ""}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <GitPullRequest className="h-4 w-4 text-amber-500" />
                        <span className={cn("font-semibold tabular-nums", mt.prsAbiertos > 0 ? "text-amber-600 dark:text-amber-400" : "")}>
                          {mt.prsAbiertos}
                        </span>
                        <span className="text-xs text-muted-foreground">PRs abiertos</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <AlertCircle className={cn("h-4 w-4", mt.fallando > 0 ? "text-red-500" : "text-slate-300 dark:text-slate-600")} />
                        <span className={cn("font-semibold tabular-nums", mt.fallando > 0 ? "text-red-600 dark:text-red-400" : "")}>
                          {mt.fallando}
                        </span>
                        <span className="text-xs text-muted-foreground">deploys fallando</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Loader2 className={cn("h-4 w-4", mt.deployando > 0 ? "animate-spin text-blue-500" : "text-slate-300 dark:text-slate-600")} />
                        <span className={cn("font-semibold tabular-nums", mt.deployando > 0 ? "text-blue-600 dark:text-blue-400" : "")}>
                          {mt.deployando}
                        </span>
                        <span className="text-xs text-muted-foreground">deployando</span>
                      </div>
                    </div>
                  )}

                  {mt && !isLoading && (
                    <p className={cn(
                      "mt-3 rounded-md px-2 py-1 text-center text-[11px] font-medium",
                      mt.fallando > 0
                        ? "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300"
                        : ok
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
                          : "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
                    )}>
                      {mt.fallando > 0
                        ? "Atención: hay deploys fallando"
                        : ok
                          ? "Todo en orden"
                          : "Hay trabajo pendiente de pasar a PRD"}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
