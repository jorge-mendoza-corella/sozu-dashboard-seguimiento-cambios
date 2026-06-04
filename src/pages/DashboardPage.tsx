import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw, Clock, GitBranch, AlertCircle, GitPullRequest, ArrowUpCircle, Rocket, Plus, Settings, FolderGit2, Loader2,
} from "lucide-react";
import { useGitHubStatus } from "@/hooks/useGitHubStatus";
import { useProjects, useRepos } from "@/hooks/useProjectsRepos";
import { useAuth } from "@/hooks/useAuth";
import { RepoCard, RepoCardSkeleton } from "@/components/RepoCard";
import { hasFailingDeploy, type RepoRef, type RepoStatus } from "@/lib/github";
import { seedDefaultProject } from "@/lib/firestoreProjects";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AddRepoModal } from "@/components/projects/AddRepoModal";
import { ManageModal } from "@/components/projects/ManageModal";
import { formatDistanceToNow } from "@/lib/timeUtils";

function computeSummary(data: RepoStatus[]) {
  const getDev = (r: RepoStatus) => r.branches.find((b) => b.name === "dev");
  return {
    total: data.length,
    prdSynced: data.filter(
      (r) => !r.error && (getDev(r)?.aheadOfMain ?? 0) === 0 && r.openPRs.length === 0 && !hasFailingDeploy(r.latestRuns),
    ).length,
    devPending: data.filter((r) => (getDev(r)?.aheadOfMain ?? 0) > 0).length,
    withPRs: data.filter((r) => r.openPRs.length > 0).length,
    failing: data.filter((r) => hasFailingDeploy(r.latestRuns)).length,
  };
}

export function DashboardPage() {
  const { appUser } = useAuth();
  const isViewer = appUser?.role === "viewer";
  const isAdmin = appUser?.role === "superuser";
  const qc = useQueryClient();

  const { data: projects = [], isLoading: loadingProjects } = useProjects();
  const { data: repos = [], isLoading: loadingRepos } = useRepos();

  const allRepoRefs: RepoRef[] = useMemo(
    () => repos.map((r) => ({ owner: r.owner, repo: r.repo, label: r.label })),
    [repos],
  );
  const { data, isLoading, isFetching, dataUpdatedAt, refetch } = useGitHubStatus(allRepoRefs);

  const [activeProject, setActiveProject] = useState<string>("");
  const [showAdd, setShowAdd] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [seeding, setSeeding] = useState(false);

  // Seed/repair inicial: admin y aún ningún proyecto marcado como sembrado.
  // Crea "SOZU" con los repos por defecto o completa los que falten (una vez).
  useEffect(() => {
    if (!isAdmin || loadingProjects || loadingRepos || seeding) return;
    if (projects.some((p) => p.seeded)) return;
    setSeeding(true);
    seedDefaultProject(appUser!.email)
      .then(() =>
        Promise.all([
          qc.invalidateQueries({ queryKey: ["projects"] }),
          qc.invalidateQueries({ queryKey: ["repos"] }),
        ]),
      )
      .finally(() => setSeeding(false));
  }, [isAdmin, loadingProjects, loadingRepos, projects, seeding, appUser, qc]);

  // Tab activo por defecto = primer proyecto
  useEffect(() => {
    if (projects.length && !projects.some((p) => p.id === activeProject)) {
      setActiveProject(projects[0].id);
    }
  }, [projects, activeProject]);

  const repoIdsByProject = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of repos) {
      if (!m.has(r.projectId)) m.set(r.projectId, new Set());
      m.get(r.projectId)!.add(`${r.owner}/${r.repo}`);
    }
    return m;
  }, [repos]);

  const activeKeys = repoIdsByProject.get(activeProject) ?? new Set<string>();
  const activeStatus = (data ?? []).filter((s) => activeKeys.has(`${s.owner}/${s.repo}`));
  const summary = data ? computeSummary(activeStatus) : null;

  const busy = loadingProjects || loadingRepos || seeding;

  return (
    <div className="flex flex-col gap-0">
      {/* Header */}
      <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-slate-50 via-white to-slate-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 px-6 py-5">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-blue-100/40 via-transparent to-transparent dark:from-blue-900/10 pointer-events-none" />
        <div className="relative flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <GitBranch className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
              <h1 className="text-xl font-bold tracking-tight">Estado de Repositorios</h1>
            </div>
            <p className="text-sm text-muted-foreground">CI/CD · Ramas · PRs · Workflows — se actualiza cada 2 min</p>
            {summary && !isLoading && (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <Badge variant="outline" className="gap-1 text-[11px] bg-white/80 dark:bg-slate-900/80">
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-400 inline-block" />
                  {summary.total} repos
                </Badge>
                {summary.prdSynced > 0 && (
                  <Badge variant="outline" className="gap-1 text-[11px] bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/50 text-emerald-700 dark:text-emerald-300">
                    <Rocket className="h-3 w-3" />{summary.prdSynced} en PRD
                  </Badge>
                )}
                {summary.devPending > 0 && (
                  <Badge variant="outline" className="gap-1 text-[11px] bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900/50 text-blue-700 dark:text-blue-300">
                    <ArrowUpCircle className="h-3 w-3" />{summary.devPending} dev → PRD pendiente
                  </Badge>
                )}
                {summary.withPRs > 0 && (
                  <Badge variant="outline" className="gap-1 text-[11px] bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/50 text-amber-700 dark:text-amber-300">
                    <GitPullRequest className="h-3 w-3" />{summary.withPRs} con PRs
                  </Badge>
                )}
                {summary.failing > 0 && (
                  <Badge variant="outline" className="gap-1 text-[11px] bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300">
                    <AlertCircle className="h-3 w-3" />{summary.failing} fallando
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
            {isAdmin && (
              <>
                <Button variant="outline" size="sm" onClick={() => setShowManage(true)} className="bg-white/80 dark:bg-slate-900/80">
                  <Settings className="h-4 w-4 mr-1.5" /> Gestionar
                </Button>
                <Button size="sm" onClick={() => setShowAdd(true)}>
                  <Plus className="h-4 w-4 mr-1.5" /> Agregar repo
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="bg-white/80 dark:bg-slate-900/80">
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""} mr-1.5`} />
              {isFetching ? "Actualizando…" : "Actualizar"}
            </Button>
          </div>
        </div>
      </div>

      {/* Contenido */}
      <div className="p-6">
        {busy ? (
          <div className="flex h-48 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Cargando proyectos…
          </div>
        ) : projects.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <FolderGit2 className="h-8 w-8" />
            <p>No hay proyectos todavía.</p>
            {isAdmin && (
              <Button size="sm" onClick={() => setShowAdd(true)}>
                <Plus className="h-4 w-4 mr-1.5" /> Agregar el primer repositorio
              </Button>
            )}
          </div>
        ) : (
          <Tabs value={activeProject} onValueChange={setActiveProject}>
            <TabsList className="flex-wrap h-auto">
              {projects.map((p) => {
                const count = repoIdsByProject.get(p.id)?.size ?? 0;
                return (
                  <TabsTrigger key={p.id} value={p.id} className="gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                    {p.name}
                    <span className="text-[10px] text-muted-foreground">({count})</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>

            {projects.map((p) => {
              const keys = repoIdsByProject.get(p.id) ?? new Set<string>();
              const list = (data ?? []).filter((s) => keys.has(`${s.owner}/${s.repo}`));
              return (
                <TabsContent key={p.id} value={p.id}>
                  {keys.size === 0 ? (
                    <div className="flex h-40 flex-col items-center justify-center gap-3 text-muted-foreground">
                      <p>Este proyecto no tiene repositorios.</p>
                      {isAdmin && (
                        <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
                          <Plus className="h-4 w-4 mr-1.5" /> Agregar repo
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
                      {isLoading
                        ? Array.from({ length: keys.size }).map((_, i) => <RepoCardSkeleton key={i} />)
                        : list.map((repo) => (
                            <RepoCard key={repo.repo} status={repo} onRefetch={() => refetch()} readOnly={isViewer} />
                          ))}
                    </div>
                  )}
                </TabsContent>
              );
            })}
          </Tabs>
        )}
      </div>

      {showAdd && <AddRepoModal onClose={() => setShowAdd(false)} defaultProjectId={activeProject || undefined} />}
      {showManage && <ManageModal onClose={() => setShowManage(false)} />}
    </div>
  );
}
