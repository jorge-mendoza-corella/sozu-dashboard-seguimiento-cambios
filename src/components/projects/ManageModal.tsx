import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X, Loader2, Trash2, Plus, FolderGit2, Pencil, Check, Smartphone } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import {
  addProject, renameProject, removeProject, moveRepoToProject, removeRepo, setRepoLabel, setProjectIsApp,
} from "@/lib/firestoreProjects";
import { useProjects, useRepos } from "@/hooks/useProjectsRepos";
import { useAuth } from "@/hooks/useAuth";

export function ManageModal({ onClose }: { onClose: () => void }) {
  const { appUser } = useAuth();
  const qc = useQueryClient();
  const { data: projects = [] } = useProjects();
  const { data: repos = [] } = useRepos();

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
                <div key={p.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
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
