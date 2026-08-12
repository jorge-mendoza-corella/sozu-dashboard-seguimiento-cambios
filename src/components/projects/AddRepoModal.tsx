import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  X, Loader2, CheckCircle2, XCircle, AlertTriangle, ShieldCheck, GitBranch, Rocket, Plus, ExternalLink,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { parseRepoUrl, validateRepoAccess, getTokenAccounts, type RepoAccess } from "@/lib/github";
import { addProject, addRepo } from "@/lib/firestoreProjects";
import { useProjects } from "@/hooks/useProjectsRepos";
import { useAuth } from "@/hooks/useAuth";

export function AddRepoModal({ onClose, defaultProjectId }: { onClose: () => void; defaultProjectId?: string }) {
  const { appUser } = useAuth();
  const qc = useQueryClient();
  const { data: projects = [] } = useProjects();
  const { data: accounts } = useQuery({ queryKey: ["token-accounts"], queryFn: getTokenAccounts, staleTime: Infinity });

  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [frontUrl, setFrontUrl] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [newProject, setNewProject] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [access, setAccess] = useState<RepoAccess | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const parsed = parseRepoUrl(url);

  useEffect(() => {
    if (projects.length && !projectId) setProjectId(projects[0].id);
  }, [projects, projectId]);

  // Reset validación al cambiar el link
  useEffect(() => {
    setAccess(null);
    if (parsed && !label) setLabel(parsed.repo);
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  const validate = async () => {
    if (!parsed) return;
    setValidating(true);
    setError("");
    try {
      const res = await validateRepoAccess(parsed.owner, parsed.repo);
      setAccess(res);
    } finally {
      setValidating(false);
    }
  };

  const handleCreateProject = async () => {
    if (!newProject.trim()) return;
    setCreatingProject(true);
    try {
      const id = await addProject(newProject.trim(), appUser!.email);
      await qc.invalidateQueries({ queryKey: ["projects"] });
      setProjectId(id);
      setNewProject("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al crear proyecto");
    } finally {
      setCreatingProject(false);
    }
  };

  const handleSave = async () => {
    if (!parsed || !projectId) return;
    setSaving(true);
    setError("");
    const front = frontUrl.trim();
    if (front && !/^https?:\/\//.test(front)) {
      setError("La URL del front debe empezar con http:// o https://");
      setSaving(false);
      return;
    }
    try {
      await addRepo({ owner: parsed.owner, repo: parsed.repo, label, projectId, frontUrl: front }, appUser!.email);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["repos"] }),
        qc.invalidateQueries({ queryKey: ["github-status"] }),
      ]);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar");
      setSaving(false);
    }
  };

  const repoUrl = parsed ? `https://github.com/${parsed.owner}/${parsed.repo}` : "#";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <Card className="w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <GitBranch className="h-5 w-5 text-primary" /> Agregar repositorio
            </h2>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* 1. Link */}
          <label className="text-sm font-medium">1 · Link del repositorio</label>
          <div className="mt-1 flex gap-2">
            <input
              autoFocus
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="https://github.com/owner/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button onClick={validate} disabled={!parsed || validating} size="sm" variant="outline">
              {validating ? <Loader2 className="h-4 w-4 animate-spin" /> : "Validar acceso"}
            </Button>
          </div>
          {url && !parsed && (
            <p className="mt-1 text-xs text-destructive">No se reconoce. Usa una URL de GitHub o "owner/repo".</p>
          )}
          {parsed && (
            <p className="mt-1 text-xs text-muted-foreground">
              Detectado: <span className="font-mono text-foreground">{parsed.owner}/{parsed.repo}</span>
            </p>
          )}

          {/* Resultado de validación */}
          {access && (
            <div
              className={`mt-3 rounded-md border p-3 text-sm ${
                access.ok && access.canPush
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-200"
                  : access.ok
                    ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200"
                    : "border-red-300 bg-red-50 text-red-800 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-200"
              }`}
            >
              <div className="flex items-center gap-2 font-medium">
                {access.ok && access.canPush ? (
                  <><CheckCircle2 className="h-4 w-4" /> Acceso correcto con permiso de escritura.</>
                ) : access.ok ? (
                  <><AlertTriangle className="h-4 w-4" /> El token lee el repo pero SIN permiso de escritura (no podrá crear/mergear PRs).</>
                ) : (
                  <><XCircle className="h-4 w-4" /> Sin acceso: {access.error}</>
                )}
              </div>
            </div>
          )}

          {/* 2. Permisos manuales */}
          <div className="mt-5 rounded-lg border bg-muted/40 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="h-4 w-4 text-primary" /> 2 · Permisos que debes dar tú (manual, en GitHub)
            </div>
            <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
              <li className="flex gap-2">
                <span className="mt-0.5 text-primary">●</span>
                <span>
                  En <a href={`${repoUrl}/settings/access`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-foreground underline">
                    Settings → Collaborators <ExternalLink className="h-3 w-3" />
                  </a>, agrega como colaborador con rol <strong>Write</strong> (o Admin) a:
                  <span className="ml-1 font-mono text-foreground">{accounts?.primary ?? "token principal"}</span>
                  {" "}— para leer estado, ramas, PRs y crear PRs.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 text-primary">●</span>
                <span>
                  Agrega también a <span className="font-mono text-foreground">{accounts?.reviewer ?? "token revisor"}</span> con rol <strong>Write</strong>
                  {" "}— para aprobar PRs y hacer merge con bypass.
                </span>
              </li>
              <li className="flex gap-2">
                <Rocket className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <span>
                  Para ver "deploys" en el dashboard, el repo necesita un workflow de GitHub Actions cuyo
                  nombre contenga <span className="font-mono text-foreground">deploy</span> (corriendo en <span className="font-mono">main</span>/<span className="font-mono">dev</span>).
                  Puedes copiar las plantillas de <span className="font-mono text-foreground">ci-templates/</span>.
                </span>
              </li>
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Tras dar los permisos, vuelve a pulsar <strong>Validar acceso</strong> para confirmar en verde.
            </p>
          </div>

          {/* 3. Proyecto + nombre */}
          <div className="mt-5">
            <label className="text-sm font-medium">3 · Proyecto</label>
            <div className="mt-1 flex gap-2">
              <SelectNative className="flex-1" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.length === 0 && <option value="">— sin proyectos —</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </SelectNative>
            </div>
            <div className="mt-2 flex gap-2">
              <input
                className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="…o crea un proyecto nuevo"
                value={newProject}
                onChange={(e) => setNewProject(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
              />
              <Button onClick={handleCreateProject} disabled={!newProject.trim() || creatingProject} size="sm" variant="outline">
                {creatingProject ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Button>
            </div>

            <label className="mt-3 block text-sm font-medium">Nombre a mostrar</label>
            <input
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="nombre del repo"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />

            {/* Con URL, el repo cuenta como front: su card muestra el link, el
                botón de copiar y la versión que sirve el sitio. */}
            <label className="mt-3 block text-sm font-medium">
              URL del front <span className="font-normal text-muted-foreground">(opcional)</span>
            </label>
            <input
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
              placeholder="https://mi-sitio.com"
              value={frontUrl}
              onChange={(e) => setFrontUrl(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Si la pones, la card mostrará el link, un botón para copiarlo y la versión publicada.
            </p>
          </div>

          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button onClick={handleSave} disabled={!parsed || !projectId || saving}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Agregar repositorio
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
