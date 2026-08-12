import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw, Clock, GitBranch, AlertCircle, GitPullRequest, ArrowUpCircle, Rocket, Plus, Settings, FolderGit2, Loader2, Smartphone,
} from "lucide-react";
import { AppBuildsPanel } from "@/components/codemagic/AppBuildsPanel";
import { ActiveBuildChips } from "@/components/codemagic/ActiveBuildChips";
import { isCodemagicConfigured } from "@/lib/codemagic";
import { useGitHubStatus } from "@/hooks/useGitHubStatus";
import { useProjects, useRepos, useAccessibleRepoIds } from "@/hooks/useProjectsRepos";
import { useAuth } from "@/hooks/useAuth";
import { hasFailingDeploy, type RepoRef, type RepoStatus, type ApproverAuth } from "@/lib/github";
import { seedDefaultProject, setReposOrder, type MonitoredRepo } from "@/lib/firestoreProjects";
import { getFrontVersions } from "@/lib/frontVersions";
import { SUPERUSER_EMAIL, resolvePermissions, getAllUsers } from "@/lib/firestoreUsers";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AddRepoModal } from "@/components/projects/AddRepoModal";
import { ManageModal } from "@/components/projects/ManageModal";
import { RepoGrid } from "@/components/projects/RepoGrid";
import { formatDistanceToNow } from "@/lib/timeUtils";
import { cn } from "@/lib/utils";

type Alert = "failing" | "pending" | "devPending" | null;

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
  const isRoot = appUser?.email === SUPERUSER_EMAIL; // solo jorge gestiona proyectos/repos
  const perms = resolvePermissions(appUser); // permisos CI/CD granulares del usuario
  const qc = useQueryClient();

  const { data: allProjects = [], isLoading: loadingProjects } = useProjects();
  const { data: allRepos = [], isLoading: loadingRepos } = useRepos();

  // Visibilidad por repo según la cuenta de GitHub del usuario (su API key):
  // si su cuenta no puede ver un repo en GitHub, tampoco lo ve aquí.
  // Root/legacy (sin token de sesión) ve todos.
  const { data: accessibleIds, isLoading: loadingAccess } = useAccessibleRepoIds(
    allRepos,
    appUser?.email === SUPERUSER_EMAIL ? null : appUser?.githubToken ?? null,
    appUser?.githubLogin ?? null,
  );
  const repos = useMemo(() => {
    if (appUser?.email === SUPERUSER_EMAIL || !appUser?.githubToken) return allRepos;
    if (!accessibleIds) return []; // aún verificando accesos: no mostrar de más
    const ok = new Set(accessibleIds);
    return allRepos.filter((r) => ok.has(r.id));
  }, [allRepos, accessibleIds, appUser?.email, appUser?.githubToken]);

  // Aprobadores por proyecto: el token del usuario configurado como aprobador
  // firma las reviews. Solo los admins pueden leer la colección users (rules);
  // para viewers el catch deja el mapa vacío y se usa el fallback legacy.
  const { data: allUsers = [] } = useQuery({
    queryKey: ["users-all"],
    queryFn: () => getAllUsers().catch(() => []),
    staleTime: 60 * 1000,
  });
  const approverByProject = useMemo(() => {
    const m = new Map<string, ApproverAuth>();
    for (const p of allProjects) {
      if (!p.approverEmail) continue;
      const u = allUsers.find((x) => x.email === p.approverEmail);
      if (u?.githubToken && u.githubLogin) m.set(p.id, { token: u.githubToken, login: u.githubLogin });
    }
    return m;
  }, [allProjects, allUsers]);

  // Versión que sirve cada front (repos con frontUrl). La escribe el sync
  // programado: el navegador no puede leer esos sitios por CORS.
  const { data: frontVersions = {} } = useQuery({
    queryKey: ["front-versions"],
    queryFn: () => getFrontVersions().catch(() => ({})),
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  // Credenciales de todos los usuarios con token: si alguno es CODEOWNER del
  // repo, el dashboard firma la review también con su cuenta — sin eso, en
  // repos con CODEOWNERS el approve del aprobador no satisface la protección
  // de rama y GitHub sigue pidiendo la revisión del dueño del código.
  const codeOwnerAuths = useMemo<ApproverAuth[]>(
    () => allUsers
      .filter((u) => !!u.githubToken && !!u.githubLogin)
      .map((u) => ({ token: u.githubToken as string, login: u.githubLogin as string })),
    [allUsers],
  );

  // Proyectos visibles según el acceso del usuario (root ve todos; legacy sin
  // projectIds = todos por compatibilidad).
  const projects = useMemo(() => {
    if (isRoot) return allProjects;
    const ids = appUser?.projectIds;
    if (!ids || ids.length === 0) return allProjects;
    return allProjects.filter((p) => ids.includes(p.id));
  }, [allProjects, isRoot, appUser?.projectIds]);

  const allRepoRefs: RepoRef[] = useMemo(
    () => repos.map((r) => ({ owner: r.owner, repo: r.repo, label: r.label })),
    [repos],
  );
  const { data, isLoading, isFetching, dataUpdatedAt, refetch } = useGitHubStatus(allRepoRefs);

  const [activeProject, setActiveProject] = useState<string>("");
  const [showAdd, setShowAdd] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [seeding, setSeeding] = useState(false);
  // Vista interna del tab de proyecto: repos (default) o deploy de la app.
  const [projectView, setProjectView] = useState<"repos" | "deploy">("repos");

  // Seed/repair inicial: solo el root y aún ningún proyecto marcado como sembrado.
  // Crea "SOZU" con los repos por defecto o completa los que falten (una vez).
  useEffect(() => {
    if (!isRoot || loadingProjects || loadingRepos || seeding) return;
    if (allProjects.some((p) => p.seeded)) return;
    setSeeding(true);
    seedDefaultProject(appUser!.email)
      .then(() =>
        Promise.all([
          qc.invalidateQueries({ queryKey: ["projects"] }),
          qc.invalidateQueries({ queryKey: ["repos"] }),
        ]),
      )
      .finally(() => setSeeding(false));
  }, [isRoot, loadingProjects, loadingRepos, allProjects, seeding, appUser, qc]);

  // Deep-link desde Resumen: /?project=<id> abre ese proyecto en CI/CD.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const pid = searchParams.get("project");
    if (pid && projects.some((p) => p.id === pid)) {
      setActiveProject(pid);
      setProjectView("repos");
      setSearchParams({}, { replace: true });
    }
  }, [projects, searchParams, setSearchParams]);

  // Tab activo por defecto = primer proyecto visible.
  // Si hay deep-link (?project=) pendiente, ese efecto manda — no pisarlo.
  useEffect(() => {
    if (searchParams.get("project")) return;
    if (projects.length && !projects.some((p) => p.id === activeProject)) {
      setActiveProject(projects[0].id);
    }
  }, [projects, activeProject, searchParams]);

  // Repos por proyecto (preserva el orden manual de getRepos) + índice de estado.
  const reposByProject = useMemo(() => {
    const m = new Map<string, MonitoredRepo[]>();
    for (const r of repos) {
      if (!m.has(r.projectId)) m.set(r.projectId, []);
      m.get(r.projectId)!.push(r);
    }
    return m;
  }, [repos]);

  const statusByKey = useMemo(() => {
    const m = new Map<string, RepoStatus>();
    for (const s of data ?? []) m.set(`${s.owner}/${s.repo}`, s);
    return m;
  }, [data]);

  // Alerta por proyecto (para marcar el tab aunque no estés en él):
  // rojo = algún deploy fallando · ámbar = PRs abiertos · azul = dev por pasar a PRD.
  const projectAlert = useMemo(() => {
    const m = new Map<string, Alert>();
    for (const [pid, list] of reposByProject) {
      const statuses = list
        .map((r) => statusByKey.get(`${r.owner}/${r.repo}`))
        .filter((s): s is RepoStatus => !!s);
      let sev: Alert = null;
      if (statuses.some((s) => hasFailingDeploy(s.latestRuns))) sev = "failing";
      else if (statuses.some((s) => s.openPRs.length > 0)) sev = "pending";
      else if (statuses.some((s) => (s.branches.find((b) => b.name === "dev")?.aheadOfMain ?? 0) > 0))
        sev = "devPending";
      m.set(pid, sev);
    }
    return m;
  }, [reposByProject, statusByKey]);

  const handleReorder = useCallback(
    async (ids: string[]) => {
      await setReposOrder(ids);
      qc.invalidateQueries({ queryKey: ["repos"] });
    },
    [qc],
  );

  const activeRepos = reposByProject.get(activeProject) ?? [];
  const activeStatus = (data ?? []).filter((s) =>
    activeRepos.some((r) => r.owner === s.owner && r.repo === s.repo),
  );
  const summary = data ? computeSummary(activeStatus) : null;

  const busy = loadingProjects || loadingRepos || loadingAccess || seeding;

  return (
    <div className="flex flex-col gap-0">
      {/* Header */}
      <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-slate-50 via-white to-slate-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 px-6 py-5">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-blue-100/40 via-transparent to-transparent dark:from-blue-900/10 pointer-events-none" />
        <div className="relative flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-4">
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
          <div className="flex flex-wrap items-center gap-2 md:shrink-0 md:mt-0.5">
            {dataUpdatedAt > 0 && (
              <span className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                {formatDistanceToNow(new Date(dataUpdatedAt).toISOString())}
              </span>
            )}
            {isRoot && (
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
            {isRoot && (
              <Button size="sm" onClick={() => setShowAdd(true)}>
                <Plus className="h-4 w-4 mr-1.5" /> Agregar el primer repositorio
              </Button>
            )}
          </div>
        ) : (
          <Tabs
            value={activeProject}
            onValueChange={(v) => {
              setActiveProject(v);
              setProjectView("repos"); // al cambiar de proyecto, volver a la vista de repos
            }}
          >
            <TabsList className="mt-3 h-auto flex-wrap overflow-visible">
              {projects.map((p) => {
                const count = reposByProject.get(p.id)?.length ?? 0;
                const alert = projectAlert.get(p.id) ?? null;
                const alertTitle =
                  alert === "failing" ? "Deploy fallando" :
                  alert === "pending" ? "PRs abiertos" :
                  alert === "devPending" ? "Dev por pasar a PRD" : "";
                return (
                  <div key={p.id} className="relative">
                    {/* Flecha sobre el proyecto activo — fuera del trigger para
                        que el overflow del efecto tab-alert no la recorte */}
                    {activeProject === p.id && (
                      <span className="pointer-events-none absolute -top-3 left-1/2 z-20 -translate-x-1/2 text-[10px] leading-none text-primary">
                        ▼
                      </span>
                    )}
                  <TabsTrigger
                    value={p.id}
                    title={alertTitle || undefined}
                    className={cn(
                      "gap-1.5",
                      "data-[state=active]:font-bold data-[state=active]:text-primary",
                      alert && `tab-alert tab-alert-${alert}`,
                    )}
                  >
                    <span className="relative z-10 flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                      {p.name}
                      {(p.isApp ?? false) && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-blue-100 px-1 py-0.5 text-[9px] font-bold text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                          <Smartphone className="h-2.5 w-2.5" />APP
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground">({count})</span>
                    </span>
                  </TabsTrigger>
                  </div>
                );
              })}
            </TabsList>

            {projects.map((p) => {
              const projectRepos = reposByProject.get(p.id) ?? [];
              // Sub-pestaña "Deploy App": solo proyectos APP vinculados a Codemagic
              // y usuarios con el permiso buildApp.
              const showDeployTab = !!p.isApp && !!p.codemagicAppId && isCodemagicConfigured && perms.buildApp;
              const view = showDeployTab ? projectView : "repos";
              return (
                <TabsContent key={p.id} value={p.id}>
                  {showDeployTab && (
                    <div className="mb-4 flex gap-1 border-b">
                      {([
                        { key: "repos", label: "Repositorios", icon: GitBranch },
                        { key: "deploy", label: "Deploy App", icon: Smartphone },
                      ] as const).map(({ key, label, icon: Icon }) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setProjectView(key)}
                          className={cn(
                            "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors -mb-px",
                            view === key
                              ? "border-primary text-primary"
                              : "border-transparent text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Icon className="h-4 w-4" />
                          {label}
                          {key === "deploy" && p.codemagicAppId && (
                            <ActiveBuildChips appId={p.codemagicAppId} compact />
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {view === "deploy" && showDeployTab ? (
                    <AppBuildsPanel appId={p.codemagicAppId!} perms={perms} project={p} />
                  ) : projectRepos.length === 0 ? (
                    <div className="flex h-40 flex-col items-center justify-center gap-3 text-muted-foreground">
                      <p>Este proyecto no tiene repositorios.</p>
                      {isRoot && (
                        <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
                          <Plus className="h-4 w-4 mr-1.5" /> Agregar repo
                        </Button>
                      )}
                    </div>
                  ) : (
                    <>
                      {isRoot && (
                        <p className="mb-3 text-xs text-muted-foreground">
                          Arrastra las tarjetas para reordenarlas. El orden se guarda automáticamente.
                        </p>
                      )}
                      <RepoGrid
                        repos={projectRepos}
                        statusByKey={statusByKey}
                        isLoading={isLoading}
                        isViewer={isViewer}
                        perms={perms}
                        canReorder={isRoot}
                        approver={approverByProject.get(p.id) ?? null}
                        codeOwnerAuths={codeOwnerAuths}
                        selfLogin={isRoot ? null : appUser?.githubLogin ?? null}
                        notifyAuthors={p.notifyAuthors ?? []}
                        frontVersions={frontVersions}
                        androidPackage={p.isApp ? p.androidPackage : undefined}
                        iosBundleId={p.isApp ? p.iosBundleId : undefined}
                        onRefetch={() => refetch()}
                        onReorder={handleReorder}
                      />
                    </>
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
