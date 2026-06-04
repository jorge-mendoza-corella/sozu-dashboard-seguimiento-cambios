import { useState, useEffect } from "react";
import { UserPlus, Trash2, Shield, Eye, Loader2, FolderGit2, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import { useAuth } from "@/hooks/useAuth";
import { useProjects } from "@/hooks/useProjectsRepos";
import {
  getAllUsers,
  addUser,
  removeUser,
  setUserRole,
  setUserProjects,
  SUPERUSER_EMAIL,
  type AppUser,
  type UserRole,
} from "@/lib/firestoreUsers";

export function UsersPage() {
  const { appUser } = useAuth();
  const { data: projects = [] } = useProjects();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("viewer");
  const [newProjects, setNewProjects] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState("");

  const isSuperuser = appUser?.role === "superuser";

  useEffect(() => {
    getAllUsers().then(setUsers);
  }, []);

  const refresh = async () => setUsers(await getAllUsers());

  const toggleNew = (id: string) =>
    setNewProjects((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const handleAdd = async () => {
    if (!newEmail.trim() || newProjects.size === 0) return;
    setLoading(true);
    setError("");
    try {
      await addUser(newEmail.trim().toLowerCase(), appUser!.email, newRole, [...newProjects]);
      await refresh();
      setNewEmail("");
      setNewRole("viewer");
      setNewProjects(new Set());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al agregar");
    } finally {
      setLoading(false);
    }
  };

  const handleRole = async (email: string, role: UserRole) => {
    setBusy(email);
    setError("");
    try {
      await setUserRole(email, role);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al cambiar el rol");
    } finally {
      setBusy(null);
    }
  };

  const handleToggleProject = async (u: AppUser, id: string) => {
    const current = new Set(u.projectIds ?? projects.map((p) => p.id));
    current.has(id) ? current.delete(id) : current.add(id);
    if (current.size === 0) {
      setError("El usuario debe tener al menos un proyecto.");
      return;
    }
    setBusy(u.email);
    setError("");
    try {
      await setUserProjects(u.email, [...current]);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al actualizar proyectos");
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (email: string) => {
    if (!confirm(`¿Eliminar acceso a ${email}?`)) return;
    setBusy(email);
    try {
      await removeUser(email);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al eliminar");
    } finally {
      setBusy(null);
    }
  };

  if (!isSuperuser) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Solo un administrador puede gestionar accesos.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Gestión de Accesos</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Administra quién accede al dashboard, su rol y a qué proyectos tiene acceso (mínimo 1).
        </p>
      </div>

      {/* Add user */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <UserPlus className="h-4 w-4" /> Invitar usuario
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <input
              type="email"
              className="min-w-[200px] flex-1 px-3 py-2 text-sm border rounded-md bg-background"
              placeholder="email@ejemplo.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
            <SelectNative className="w-44" value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)}>
              <option value="viewer">Viewer</option>
              <option value="superuser">Administrador</option>
            </SelectNative>
            <Button onClick={handleAdd} disabled={loading || !newEmail.trim() || newProjects.size === 0} size="sm">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Agregar"}
            </Button>
          </div>

          {/* Proyectos del nuevo usuario */}
          <div className="mt-3">
            <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <FolderGit2 className="h-3.5 w-3.5" /> Proyectos (mínimo 1)
            </p>
            {projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">No hay proyectos todavía.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {projects.map((p) => {
                  const on = newProjects.has(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggleNew(p.id)}
                      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                        on
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                      {p.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {newRole === "superuser" && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              Un Administrador puede gestionar usuarios. La administración de proyectos/repos queda reservada al superusuario raíz.
            </p>
          )}
          {error && <p className="text-xs text-destructive mt-2">{error}</p>}
        </CardContent>
      </Card>

      {/* User list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Usuarios con acceso ({users.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {users.map((u) => {
            const isRoot = u.email === SUPERUSER_EMAIL;
            const isSelf = u.email === appUser?.email;
            const editable = !isRoot && !isSelf;
            const userProjects = u.projectIds ?? [];
            const isOpen = expanded === u.email;
            return (
              <div key={u.email} className="border-b last:border-0">
                <div className="flex items-center gap-3 px-6 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {u.email}
                      {isSelf && <span className="ml-1 text-xs text-muted-foreground">(tú)</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {isRoot ? "Superusuario raíz · todos los proyectos" : `Invitado por ${u.addedBy}`}
                    </p>
                  </div>

                  {!isRoot && (
                    <button
                      onClick={() => setExpanded(isOpen ? null : u.email)}
                      className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                      title="Proyectos con acceso"
                    >
                      <FolderGit2 className="h-3.5 w-3.5" />
                      {userProjects.length || projects.length} proyectos
                      {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </button>
                  )}

                  {editable ? (
                    <SelectNative
                      className="w-36"
                      value={u.role}
                      disabled={busy === u.email}
                      onChange={(e) => handleRole(u.email, e.target.value as UserRole)}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="superuser">Administrador</option>
                    </SelectNative>
                  ) : (
                    <Badge variant={u.role === "superuser" ? "default" : "secondary"} className="shrink-0">
                      {u.role === "superuser" ? (
                        <><Shield className="h-3 w-3 mr-1" />Administrador</>
                      ) : (
                        <><Eye className="h-3 w-3 mr-1" />Viewer</>
                      )}
                    </Badge>
                  )}

                  {editable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      disabled={busy === u.email}
                      onClick={() => handleRemove(u.email)}
                    >
                      {busy === u.email ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </Button>
                  )}
                </div>

                {/* Editor de proyectos */}
                {isOpen && !isRoot && (
                  <div className="bg-muted/30 px-6 py-3">
                    <p className="mb-2 text-xs text-muted-foreground">
                      Marca los proyectos a los que <span className="font-medium">{u.email}</span> tiene acceso (mínimo 1).
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {projects.map((p) => {
                        const on = (u.projectIds ?? projects.map((x) => x.id)).includes(p.id);
                        return (
                          <button
                            key={p.id}
                            type="button"
                            disabled={busy === u.email}
                            onClick={() => handleToggleProject(u, p.id)}
                            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                              on
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border text-muted-foreground hover:bg-muted"
                            }`}
                          >
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                            {p.name}
                          </button>
                        );
                      })}
                    </div>
                    {u.projectIds === undefined && (
                      <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                        Este usuario aún no tiene proyectos asignados (acceso a todos por compatibilidad). Marca al menos uno para restringirlo.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
