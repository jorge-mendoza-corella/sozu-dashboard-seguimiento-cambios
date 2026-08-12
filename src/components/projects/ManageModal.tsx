import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X, Loader2, Trash2, Plus, FolderGit2, Pencil, Check, Smartphone, Globe } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import {
  addProject, renameProject, removeProject, moveRepoToProject, removeRepo, setRepoLabel, setProjectIsApp, setProjectCodemagicApp, setProjectApprover, setProjectNotifyAuthors, setProjectAndroidPackage,
  setProjectIosBundleId, setRepoFrontUrl,
} from "@/lib/firestoreProjects";
import { listRepoContributors } from "@/lib/github";
import { useProjects, useRepos } from "@/hooks/useProjectsRepos";
import { useCodemagicApps } from "@/hooks/useCodemagic";
import { isCodemagicConfigured } from "@/lib/codemagic";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { getAllUsers, SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import { checkRepoAccess } from "@/lib/githubAuth";
import {
  getGoogleFirebaseToken, listFirebaseProjects, listProjectPackages,
  type FirebaseAppPackage,
} from "@/lib/firebaseMgmt";

export function ManageModal({ onClose }: { onClose: () => void }) {
  const { appUser } = useAuth();
  const qc = useQueryClient();
  const { data: projects = [] } = useProjects();
  const { data: repos = [] } = useRepos();
  const { data: cmApps = [] } = useCodemagicApps();
  // Candidatos a aprobador: usuarios con API key de GitHub registrada.
  const { data: allUsers = [] } = useQuery({
    queryKey: ["users-all"],
    queryFn: getAllUsers,
    staleTime: 60 * 1000,
  });
  const approverCandidates = allUsers.filter((u) => !!u.githubToken && !!u.githubLogin);

  // Configuración de "autores notificables" por proyecto: candidatos = todos
  // los contribuidores históricos de los repos del proyecto.
  const [authorsOpenFor, setAuthorsOpenFor] = useState<string | null>(null);
  const { data: contributorOptions = [], isLoading: loadingContribs } = useQuery({
    queryKey: ["project-contributors", authorsOpenFor],
    enabled: !!authorsOpenFor,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const projRepos = repos.filter((r) => r.projectId === authorsOpenFor);
      const lists = await Promise.all(projRepos.map((r) => listRepoContributors(r.owner, r.repo)));
      return [...new Set(lists.flat())].sort((a, b) => a.localeCompare(b));
    },
  });

  const toggleNotifyAuthor = (projectId: string, current: string[], login: string) => {
    const next = current.includes(login)
      ? current.filter((l) => l !== login)
      : [...current, login];
    return run(`na-${projectId}`, () => setProjectNotifyAuthors(projectId, next), refreshProjects);
  };

  // Package Android (applicationId) por proyecto. Formato tipo com.empresa.app:
  // letras/números/_ separados por puntos, sin espacios. Vacío = quitar campo.
  const savePackage = (projectId: string, value: string) => {
    const v = value.trim();
    if (v && !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(v)) {
      setError("Package Android inválido. Usa formato com.empresa.app (letras, números, _ y puntos, sin espacios).");
      return;
    }
    return run(`pkg-${projectId}`, () => setProjectAndroidPackage(projectId, v || null), refreshProjects);
  };

  // Bundle id de iOS: mismo formato de puntos. Con él se lee el estado de
  // revisión de la app en App Store Connect. Vacío = quitar campo.
  const saveBundleId = (projectId: string, value: string) => {
    const v = value.trim();
    if (v && !/^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/.test(v)) {
      setError("Bundle ID iOS inválido. Usa formato com.empresa.App (letras, números, -, _ y puntos, sin espacios).");
      return;
    }
    return run(`bid-${projectId}`, () => setProjectIosBundleId(projectId, v || null), refreshProjects);
  };

  // Packages Android de TODOS los proyectos Firebase accesibles con la
  // cuenta Google del usuario — llenan el selector de Package. Se cargan al
  // primer click en el selector (gesto de usuario: el popup de OAuth solo
  // sale la primera vez; el token queda cacheado ~1 h).
  const [fbOptions, setFbOptions] = useState<
    Array<{ packageName: string; projectId: string; projectName: string }> | null
  >(null);
  const [fbLoading, setFbLoading] = useState(false);

  const ensureFbOptions = async () => {
    if (fbOptions !== null || fbLoading) return;
    setFbLoading(true);
    setError("");
    try {
      const token = await getGoogleFirebaseToken();
      const projs = await listFirebaseProjects(token);
      const lists = await Promise.all(
        projs.map(async (fp) => {
          const pkgs = await listProjectPackages(token, fp.projectId).catch(() => [] as FirebaseAppPackage[]);
          return pkgs
            .filter((a) => a.platform === "android")
            .map((a) => ({ packageName: a.packageName, projectId: fp.projectId, projectName: fp.displayName }));
        }),
      );
      const flat = lists.flat();
      // dedup por package+proyecto
      const seen = new Set<string>();
      setFbOptions(flat.filter((o) => {
        const k = `${o.packageName}|${o.projectId}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).sort((a, b) => a.packageName.localeCompare(b.packageName)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron leer las apps de Firebase");
      setFbOptions([]);
    } finally {
      setFbLoading(false);
    }
  };

  // Edición manual del package (fallback cuando no está en Firebase).
  const [manualPkgFor, setManualPkgFor] = useState<string | null>(null);

  const [newProject, setNewProject] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [editingRepo, setEditingRepo] = useState<{ id: string; label: string } | null>(null);
  const [error, setError] = useState("");

  const refreshProjects = () => qc.invalidateQueries({ queryKey: ["projects"] });
  const refreshRepos = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["repos"] }),
      qc.invalidateQueries({ queryKey: ["github-status"] }),
    ]);

  /** Asigna el aprobador validando que su cuenta de GitHub tenga acceso push a los repos del proyecto. */
  const setApproverValidated = async (projectId: string, email: string) => {
    if (!email) {
      await setProjectApprover(projectId, null);
      return;
    }
    const user = allUsers.find((u) => u.email === email);
    if (!user?.githubToken || !user.githubLogin) {
      throw new Error("Ese usuario no tiene API key de GitHub registrada.");
    }
    const projRepos = repos.filter((r) => r.projectId === projectId);
    const problemas: string[] = [];
    for (const r of projRepos) {
      const check = await checkRepoAccess(user.githubToken, r.owner, r.repo);
      if (!check.ok) problemas.push(`${r.owner}/${r.repo}: ${check.reason}`);
    }
    if (problemas.length > 0) {
      throw new Error(
        `No se puede asignar a @${user.githubLogin} como aprobador. ` + problemas.join(" · "),
      );
    }
    await setProjectApprover(projectId, email);
  };

  const run = async (key: string, fn: () => Promise<unknown>, after: () => Promise<unknown> | void) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await after();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <FolderGit2 className="h-5 w-5 text-primary" /> Proyectos y repositorios
            </h2>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Proyectos */}
          <h3 className="text-sm font-semibold text-muted-foreground">Proyectos ({projects.length})</h3>
          <div className="mt-2 space-y-1.5">
            {projects.map((p) => {
              const count = repos.filter((r) => r.projectId === p.id).length;
              const isEditing = editing?.id === p.id;
              const isApp = p.isApp ?? false;
              return (
                <div key={p.id} className="rounded-md border px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                  {isEditing ? (
                    <input
                      autoFocus
                      className="flex-1 rounded border bg-background px-2 py-1 text-sm"
                      value={editing.name}
                      onChange={(e) => setEditing({ id: p.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter")
                          run(`rn-${p.id}`, () => renameProject(p.id, editing.name), refreshProjects).then(() =>
                            setEditing(null),
                          );
                      }}
                    />
                  ) : (
                    <span className="flex-1 text-sm font-medium">{p.name}</span>
                  )}
                  <span className="text-xs text-muted-foreground">{count} repo{count === 1 ? "" : "s"}</span>
                  {/* Toggle APP */}
                  <button
                    type="button"
                    title={isApp ? "Es App — click para desactivar" : "No es App — click para activar"}
                    disabled={busy === `app-${p.id}`}
                    onClick={() => run(`app-${p.id}`, () => setProjectIsApp(p.id, !isApp), refreshProjects)}
                    className={cn(
                      "flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50",
                      isApp
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                        : "bg-muted text-muted-foreground hover:bg-muted/80",
                    )}
                  >
                    {busy === `app-${p.id}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Smartphone className="h-3 w-3" />
                    )}
                    APP
                  </button>
                  {isEditing ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      disabled={busy === `rn-${p.id}`}
                      onClick={() =>
                        run(`rn-${p.id}`, () => renameProject(p.id, editing.name), refreshProjects).then(() =>
                          setEditing(null),
                        )
                      }
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing({ id: p.id, name: p.name })}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    disabled={busy === `del-${p.id}` || count > 0}
                    title={count > 0 ? "Mueve o elimina sus repos primero" : "Eliminar proyecto"}
                    onClick={() => run(`del-${p.id}`, () => removeProject(p.id), refreshProjects)}
                  >
                    {busy === `del-${p.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                {/* Aprobador default de PRs del proyecto (usa SU token de GitHub) */}
                <div className="mt-2 flex flex-wrap items-center gap-2 pl-5">
                  <span className="text-[11px] text-muted-foreground">Aprobador PRs:</span>
                  <SelectNative
                    className="h-7 w-64 text-xs"
                    value={p.approverEmail ?? ""}
                    disabled={busy === `ap-${p.id}`}
                    onChange={(e) =>
                      run(`ap-${p.id}`, () => setApproverValidated(p.id, e.target.value), refreshProjects)
                    }
                  >
                    <option value="">— sin aprobador (tokens default) —</option>
                    {approverCandidates.map((u) => (
                      <option key={u.email} value={u.email}>
                        {u.email} (@{u.githubLogin}){u.email === SUPERUSER_EMAIL ? " · root" : ""}
                      </option>
                    ))}
                  </SelectNative>
                  {busy === `ap-${p.id}` && (
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> validando accesos en GitHub…
                    </span>
                  )}
                </div>

                {/* Autores notificables al crear PR (multiselección desde contribuidores) */}
                <div className="mt-2 pl-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      Autores seleccionables en PRs: {(p.notifyAuthors ?? []).length || "—"}
                    </span>
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground underline hover:text-foreground"
                      onClick={() => setAuthorsOpenFor(authorsOpenFor === p.id ? null : p.id)}
                    >
                      {authorsOpenFor === p.id ? "cerrar" : "configurar"}
                    </button>
                  </div>
                  {authorsOpenFor === p.id && (
                    <div className="mt-1.5 rounded-md border bg-muted/30 p-2">
                      <p className="mb-1.5 text-[10px] text-muted-foreground">
                        Marca los contribuidores que aparecerán para seleccionar al crear un PR en este proyecto
                        (los autores de los commits se notifican solos, no necesitan estar aquí).
                      </p>
                      {loadingContribs ? (
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" /> cargando contribuidores…
                        </span>
                      ) : contributorOptions.length === 0 ? (
                        <span className="text-[11px] text-muted-foreground">Sin contribuidores encontrados.</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {contributorOptions.map((login) => {
                            const current = p.notifyAuthors ?? [];
                            const on = current.includes(login);
                            return (
                              <button
                                key={login}
                                type="button"
                                disabled={busy === `na-${p.id}`}
                                onClick={() => toggleNotifyAuthor(p.id, current, login)}
                                className={cn(
                                  "rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50",
                                  on
                                    ? "border-violet-400 bg-violet-100 text-violet-700 dark:border-violet-700/60 dark:bg-violet-900/40 dark:text-violet-300"
                                    : "border-border text-muted-foreground hover:bg-muted",
                                )}
                              >
                                @{login}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Vincular app de Codemagic (solo proyectos APP) */}
                {isApp && isCodemagicConfigured && (
                  <div className="mt-2 flex items-center gap-2 pl-5">
                    <span className="text-[11px] text-muted-foreground">App Codemagic:</span>
                    <SelectNative
                      className="h-7 w-56 text-xs"
                      value={p.codemagicAppId ?? ""}
                      disabled={busy === `cm-${p.id}`}
                      onChange={(e) =>
                        run(`cm-${p.id}`, () => setProjectCodemagicApp(p.id, e.target.value || null), refreshProjects)
                      }
                    >
                      <option value="">— sin vincular —</option>
                      {cmApps.map((a) => (
                        <option key={a._id} value={a._id}>{a.appName}</option>
                      ))}
                    </SelectNative>
                    {busy === `cm-${p.id}` && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                  </div>
                )}

                {/* Package Android (applicationId) — selector llenado desde Firebase */}
                {isApp && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 pl-5">
                    <span className="text-[11px] text-muted-foreground">Package Android:</span>
                    {manualPkgFor === p.id ? (
                      <input
                        key={p.androidPackage ?? "none"}
                        type="text"
                        autoFocus
                        spellCheck={false}
                        autoCapitalize="none"
                        autoCorrect="off"
                        className="h-7 w-64 rounded border bg-background px-2 font-mono text-xs"
                        placeholder="com.sozu.clientes_app"
                        defaultValue={p.androidPackage ?? ""}
                        disabled={busy === `pkg-${p.id}`}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        onBlur={(e) => { savePackage(p.id, e.target.value); setManualPkgFor(null); }}
                      />
                    ) : (
                      <SelectNative
                        className="h-7 w-72 font-mono text-xs"
                        value={p.androidPackage ?? ""}
                        disabled={busy === `pkg-${p.id}`}
                        onMouseDown={() => void ensureFbOptions()}
                        onFocus={() => void ensureFbOptions()}
                        onChange={(e) => { if (e.target.value) savePackage(p.id, e.target.value); }}
                      >
                        <option value="">{fbLoading ? "cargando apps de Firebase…" : "— selecciona —"}</option>
                        {p.androidPackage && !(fbOptions ?? []).some((o) => o.packageName === p.androidPackage) && (
                          <option value={p.androidPackage}>{p.androidPackage} (actual)</option>
                        )}
                        {(fbOptions ?? []).map((o) => (
                          <option key={`${o.packageName}|${o.projectId}`} value={o.packageName}>
                            {o.packageName} — {o.projectName}
                          </option>
                        ))}
                      </SelectNative>
                    )}
                    {(busy === `pkg-${p.id}` || fbLoading) && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground underline hover:text-foreground"
                      onClick={() => setManualPkgFor(manualPkgFor === p.id ? null : p.id)}
                    >
                      {manualPkgFor === p.id ? "usar selector" : "escribir a mano"}
                    </button>
                  </div>
                )}

                {/* Bundle ID de iOS — habilita el estado de revisión de App Store */}
                {isApp && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 pl-5">
                    <span className="text-[11px] text-muted-foreground">Bundle ID iOS:</span>
                    <input
                      key={p.iosBundleId ?? "none"}
                      type="text"
                      spellCheck={false}
                      autoCapitalize="none"
                      autoCorrect="off"
                      className="h-7 w-72 rounded border bg-background px-2 font-mono text-xs"
                      placeholder="com.sozu.sozuClienteApp"
                      defaultValue={p.iosBundleId ?? ""}
                      disabled={busy === `bid-${p.id}`}
                      title="Bundle identifier de la app en App Store Connect. Con él se muestra el estado de la revisión."
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      onBlur={(e) => saveBundleId(p.id, e.target.value)}
                    />
                    {busy === `bid-${p.id}` && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                  </div>
                )}
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="Nuevo proyecto"
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              onKeyDown={(e) =>
                e.key === "Enter" &&
                newProject.trim() &&
                run("add-proj", () => addProject(newProject, appUser!.email), refreshProjects).then(() => setNewProject(""))
              }
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!newProject.trim() || busy === "add-proj"}
              onClick={() =>
                run("add-proj", () => addProject(newProject, appUser!.email), refreshProjects).then(() => setNewProject(""))
              }
            >
              {busy === "add-proj" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </Button>
          </div>

          {/* Repos */}
          <h3 className="mt-6 text-sm font-semibold text-muted-foreground">Repositorios ({repos.length})</h3>
          <div className="mt-2 space-y-1.5">
            {repos.map((r) => {
              const isEditingRepo = editingRepo?.id === r.id;
              const saveLabel = () =>
                run(`lbl-${r.id}`, () => setRepoLabel(r.id, editingRepo!.label), refreshRepos).then(() =>
                  setEditingRepo(null),
                );
              return (
              <div key={r.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                <div className="min-w-0 flex-1">
                  {isEditingRepo ? (
                    <input
                      autoFocus
                      className="w-full rounded border bg-background px-2 py-1 text-sm"
                      value={editingRepo.label}
                      onChange={(e) => setEditingRepo({ id: r.id, label: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && saveLabel()}
                    />
                  ) : (
                    <p className="truncate text-sm font-medium">{r.label}</p>
                  )}
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{r.owner}/{r.repo}</p>
                  {/* URL del front. Tenerla es lo que marca al repo como front:
                      su card pasa a mostrar el link, el copiar y la versión. */}
                  <div className="mt-1 flex items-center gap-1.5">
                    <Globe className={cn("h-3 w-3 shrink-0", r.frontUrl ? "text-sky-600 dark:text-sky-400" : "text-muted-foreground/50")} />
                    <input
                      className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 font-mono text-[11px]"
                      placeholder="URL del front (vacío = no es front)"
                      defaultValue={r.frontUrl ?? ""}
                      disabled={busy === `front-${r.id}`}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      onBlur={(e) => {
                        const nueva = e.target.value.trim();
                        if (nueva === (r.frontUrl ?? "")) return;
                        if (nueva && !/^https?:\/\//.test(nueva)) {
                          setError("La URL del front debe empezar con http:// o https://");
                          e.target.value = r.frontUrl ?? "";
                          return;
                        }
                        run(`front-${r.id}`, () => setRepoFrontUrl(r.id, nueva || null), refreshRepos);
                      }}
                    />
                    {busy === `front-${r.id}` && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                  </div>
                </div>
                {isEditingRepo ? (
                  <Button size="icon" variant="ghost" className="h-7 w-7" disabled={busy === `lbl-${r.id}`} onClick={saveLabel}>
                    {busy === `lbl-${r.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  </Button>
                ) : (
                  <Button size="icon" variant="ghost" className="h-7 w-7" title="Renombrar" onClick={() => setEditingRepo({ id: r.id, label: r.label })}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
                <SelectNative
                  className="w-44"
                  value={r.projectId}
                  disabled={busy === `mv-${r.id}`}
                  onChange={(e) => run(`mv-${r.id}`, () => moveRepoToProject(r.id, e.target.value), refreshRepos)}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </SelectNative>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  disabled={busy === `rm-${r.id}`}
                  title="Quitar repo del monitoreo"
                  onClick={() => run(`rm-${r.id}`, () => removeRepo(r.id), refreshRepos)}
                >
                  {busy === `rm-${r.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
              </div>
              );
            })}
            {repos.length === 0 && <p className="text-xs text-muted-foreground">Aún no hay repositorios.</p>}
          </div>

          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
