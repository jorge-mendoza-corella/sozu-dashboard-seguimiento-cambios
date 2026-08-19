import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  UserPlus, Trash2, Shield, Eye, Loader2, FolderGit2, ChevronDown, ChevronUp,
  GitPullRequest, UserCheck, GitMerge, Rocket, Smartphone, KeyRound, ExternalLink, Building2,
} from "lucide-react";
import { validateGithubToken } from "@/lib/githubAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import { useAuth } from "@/hooks/useAuth";
import { useClients, useClientScope } from "@/hooks/useClients";
import { clientDisplayName, type Client } from "@/lib/firestoreClients";
import {
  getVisibleUsers,
  addUser,
  removeUser,
  setUserRole,
  setUserClients,
  setUserProjects,
  setUserPermissions,
  setUserGithubToken,
  resolvePermissions,
  canAdminister,
  ROLE_LABEL,
  NO_PERMISSIONS,
  SUPERUSER_EMAIL,
  type AppUser,
  type UserRole,
  type CicdPermissions,
} from "@/lib/firestoreUsers";

const PERMISSION_DEFS: { key: keyof CicdPermissions; label: string; icon: React.ReactNode }[] = [
  { key: "createPR", label: "Generar PRs", icon: <GitPullRequest className="h-3 w-3" /> },
  { key: "approve", label: "Aprobar", icon: <UserCheck className="h-3 w-3" /> },
  { key: "mergeDev", label: "Merge a dev", icon: <GitMerge className="h-3 w-3" /> },
  { key: "mergeMain", label: "Merge a main", icon: <Rocket className="h-3 w-3" /> },
  { key: "buildApp", label: "Builds App", icon: <Smartphone className="h-3 w-3" /> },
  { key: "viewOthers", label: "Ver cambios de otros", icon: <Eye className="h-3 w-3" /> },
];

function PermissionChips({
  value,
  disabled,
  onToggle,
}: {
  value: CicdPermissions;
  disabled?: boolean;
  onToggle: (key: keyof CicdPermissions) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {PERMISSION_DEFS.map((d) => {
        const on = value[d.key];
        return (
          <button
            key={d.key}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(d.key)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
              on
                ? "border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/30 dark:text-emerald-300"
                : "border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            {d.icon}
            {d.label}
          </button>
        );
      })}
    </div>
  );
}

/** Icono por rol, para que la fila se lea de un vistazo. */
const ROLE_ICON: Record<UserRole, React.ReactNode> = {
  superuser: <Shield className="h-3 w-3 mr-1" />,
  client_admin: <Building2 className="h-3 w-3 mr-1" />,
  viewer: <Eye className="h-3 w-3 mr-1" />,
};

/** Multiselector de empresas (mismo lenguaje visual que los chips de permisos). */
function ClientPills({
  clients,
  selected,
  disabled,
  onToggle,
}: {
  clients: Client[];
  selected: (id: string) => boolean;
  disabled?: boolean;
  onToggle: (id: string) => void;
}) {
  if (clients.length === 0) {
    return <p className="text-xs text-muted-foreground">No hay empresas disponibles.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {clients.map((c) => {
        const on = selected(c.id);
        return (
          <button
            key={c.id}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(c.id)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
              on
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c.color }} />
            {clientDisplayName(c)}
          </button>
        );
      })}
    </div>
  );
}

export function UsersPage() {
  const { appUser } = useAuth();
  const { data: allClients = [] } = useClients(appUser);
  // El alcance manda: un administrador de empresa solo puede asignar SUS
  // empresas y SUS proyectos, así que las listas de la pantalla salen de aquí
  // (para un administrador global `visibleProjects` son todos los proyectos).
  const { esAdminDeEmpresa, visibleClients, visibleProjects: projects } = useClientScope(appUser);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("viewer");
  const [newClients, setNewClients] = useState<Set<string>>(new Set());
  const [newProjects, setNewProjects] = useState<Set<string>>(new Set());
  const [newPerms, setNewPerms] = useState<CicdPermissions>({ ...NO_PERMISSIONS });
  const [newToken, setNewToken] = useState("");
  // Edición de la API key de un usuario existente (solo root)
  const [tokenEdit, setTokenEdit] = useState<{ email: string; value: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState("");

  // La lista depende de QUIÉN pregunta: un administrador de empresa solo ve a
  // los suyos. Por eso el email va en la clave, para que dos cuentas distintas
  // no se pisen la caché de react-query.
  const { data: users = [], refetch, error: errorLista } = useQuery({
    queryKey: ["users-all", appUser?.email ?? ""],
    queryFn: () => getVisibleUsers(appUser),
    enabled: !!appUser,
  });

  const refresh = async () => { await refetch(); };

  /**
   * Roles asignables. `superuser` no está: el administrador global es uno solo
   * —el superusuario raíz— y repartir ese rol es repartir el servicio entero.
   * Quien ya lo tenga lo sigue mostrando, para poder bajarlo a otro rol.
   */
  const rolesAsignables: UserRole[] = esAdminDeEmpresa
    ? ["viewer"]
    : ["client_admin", "viewer"];

  /** Nombre comercial de la empresa; si no está a la vista, al menos su id. */
  const nombreEmpresa = (id: string) => {
    const c = allClients.find((x) => x.id === id);
    return c ? clientDisplayName(c) : id;
  };

  const toggleNew = (id: string) =>
    setNewProjects((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const toggleNewClient = (id: string) =>
    setNewClients((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const handleAdd = async () => {
    if (!newEmail.trim() || newProjects.size === 0 || !newToken.trim()) return;
    setLoading(true);
    setError("");
    try {
      // API key obligatoria: se valida contra GitHub antes de crear al usuario.
      const v = await validateGithubToken(newToken.trim());
      if (!v.ok || !v.login) {
        setError(v.error ?? "API key de GitHub inválida.");
        return;
      }
      await addUser(
        newEmail.trim().toLowerCase(), appUser!.email, newRole, [...newProjects], newPerms,
        newToken.trim(), v.login, [...newClients],
      );
      await refresh();
      setNewEmail("");
      setNewRole("viewer");
      setNewClients(new Set());
      setNewProjects(new Set());
      setNewPerms({ ...NO_PERMISSIONS });
      setNewToken("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al agregar");
    } finally {
      setLoading(false);
    }
  };

  /** Root actualiza/registra la API key de cualquier usuario (se valida antes). */
  const handleSaveToken = async () => {
    if (!tokenEdit || !tokenEdit.value.trim()) return;
    setBusy(tokenEdit.email);
    setError("");
    try {
      const v = await validateGithubToken(tokenEdit.value.trim());
      if (!v.ok || !v.login) {
        setError(v.error ?? "API key inválida.");
        return;
      }
      await setUserGithubToken(tokenEdit.email, tokenEdit.value.trim(), v.login);
      await refresh();
      setTokenEdit(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al guardar la API key");
    } finally {
      setBusy(null);
    }
  };

  const handleRole = async (u: AppUser, role: UserRole) => {
    setBusy(u.email);
    setError("");
    try {
      await setUserRole(u.email, role, role === "client_admin" ? u.clientIds ?? [] : undefined);
      await refresh();
      // Queda a medio configurar: se abre su panel para que las empresas se
      // asignen ahí mismo, en vez de dejarlo con un rol que no alcanza a nada.
      if (role === "client_admin" && (u.clientIds ?? []).length === 0) {
        setExpanded(u.email);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al cambiar el rol");
    } finally {
      setBusy(null);
    }
  };

  const handleToggleClient = async (u: AppUser, id: string) => {
    const current = new Set(u.clientIds ?? []);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    setBusy(u.email);
    setError("");
    try {
      // Dejar sin empresas a un administrador de empresa lo dejaría sin nada que
      // administrar, y las reglas tampoco lo permiten: se avisa antes de pegar.
      if (u.role === "client_admin" && current.size === 0) {
        throw new Error("Un administrador de empresa necesita al menos una empresa asignada.");
      }
      // Y un administrador de empresa no puede dejar a nadie sin empresa: las
      // reglas exigen que el usuario siga cayendo dentro de las suyas, así que
      // vaciarle la lista sería expulsarlo de su propio alcance (y fallaría).
      if (esAdminDeEmpresa && current.size === 0) {
        throw new Error("Deja al menos una de tus empresas: si lo sacas de todas, dejas de poder administrarlo.");
      }
      await setUserClients(u.email, [...current]);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al actualizar empresas");
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

  const handleTogglePermission = async (u: AppUser, key: keyof CicdPermissions) => {
    const current = resolvePermissions(u);
    const next = { ...current, [key]: !current[key] };
    setBusy(u.email);
    setError("");
    try {
      await setUserPermissions(u.email, next);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al actualizar permisos");
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

  // Entran el administrador global y el administrador de empresa; este último
  // solo verá y tocará a los viewers de sus empresas.
  if (!canAdminister(appUser)) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Solo un administrador puede gestionar accesos.</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Gestión de Accesos</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Administra quién accede al dashboard, su rol, su empresa y a qué proyectos tiene acceso (mínimo 1).
        </p>
        {esAdminDeEmpresa && (
          <p className="mt-1 text-xs text-muted-foreground">
            Como administrador de empresa solo puedes dar de alta y gestionar <span className="font-medium">viewers</span> de tus empresas.
          </p>
        )}
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
            <SelectNative className="w-56" value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)}>
              {rolesAsignables.map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
              ))}
            </SelectNative>
            <Button
              onClick={handleAdd}
              // Un administrador de empresa DEBE marcar empresa: las reglas
              // exigen que el usuario nuevo caiga dentro de las suyas, y sin
              // ella el alta moría con un permission-denied después de haber
              // validado el PAT contra GitHub.
              disabled={
                loading || !newEmail.trim() || newProjects.size === 0 || !newToken.trim() ||
                (esAdminDeEmpresa && newClients.size === 0)
              }
              size="sm"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Agregar"}
            </Button>
          </div>

          {/* API key de GitHub (obligatoria) */}
          <div className="mt-3">
            <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <KeyRound className="h-3.5 w-3.5" /> API key de GitHub (obligatoria) — sus PRs/merges saldrán a nombre de su cuenta
            </p>
            <input
              type="password"
              className="w-full max-w-md rounded-md border bg-background px-3 py-2 font-mono text-sm"
              placeholder="ghp_…"
              value={newToken}
              onChange={(e) => setNewToken(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Se obtiene en{" "}
              <a
                href="https://github.com/settings/tokens/new?scopes=repo&description=SOZU%20Tracker"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 font-medium text-primary underline"
              >
                github.com/settings/tokens/new <ExternalLink className="h-3 w-3" />
              </a>{" "}
              (token classic con scope <code className="rounded bg-muted px-1">repo</code>). Se valida contra GitHub al agregar.
            </p>
          </div>

          {/* Empresas del nuevo usuario: un viewer también pertenece a una. */}
          <div className="mt-3">
            <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Building2 className="h-3.5 w-3.5" />
              {newRole === "client_admin"
                ? "Empresas que administrará (al menos una)"
                : "Empresas a las que pertenece"}
            </p>
            <ClientPills
              clients={visibleClients}
              selected={(id) => newClients.has(id)}
              onToggle={toggleNewClient}
            />
            {newRole === "client_admin" && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Mandará dentro de esas empresas: sus proyectos, sus repos, sus viewers y sus notificaciones. No verá otras empresas, ni tarifas, ni datos fiscales.
              </p>
            )}
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

          {/* Permisos CI/CD del nuevo usuario */}
          <div className="mt-3">
            <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Shield className="h-3.5 w-3.5" /> Permisos CI/CD (acciones que podrá hacer)
            </p>
            <PermissionChips
              value={newPerms}
              onToggle={(key) => setNewPerms((prev) => ({ ...prev, [key]: !prev[key] }))}
            />
          </div>
          {error && <p className="text-xs text-destructive mt-2">{error}</p>}
        </CardContent>
      </Card>

      {/* User list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Usuarios con acceso ({users.length})</CardTitle>
          {/* Un fallo al listar se veía como "(0)": parecía que no había nadie,
              cuando en realidad la consulta no se pudo hacer. */}
          {errorLista != null && (
            <p className="mt-1 text-xs text-destructive">
              No se pudo leer la lista completa: {(errorLista as Error).message}
            </p>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {users.map((u) => {
            const isRoot = u.email === SUPERUSER_EMAIL;
            const isSelf = u.email === appUser?.email;
            // Las reglas de Firestore solo dejan a un administrador de empresa
            // crear, editar y borrar VIEWERS de sus empresas. Se bloquea aquí
            // para que no choque contra un permission-denied.
            // Y las mismas reglas reservan la gestión global de accesos al
            // superusuario RAÍZ: un administrador global entra y ve la lista,
            // pero si intentara guardar recibiría un permission-denied. Se
            // bloquea aquí con el motivo escrito, en vez de dejarlo chocar.
            // Ojo con la asimetría: la LECTURA le deja ver a quien comparta UNA
            // empresa con él (`hasAny`), pero la ESCRITURA exige que TODAS las
            // empresas del usuario sean suyas (`hasOnly`). Un viewer que también
            // pertenece a otra empresa se ve, pero no se puede tocar.
            const empresasAjenas =
              esAdminDeEmpresa &&
              (u.clientIds ?? []).some((id) => !(appUser?.clientIds ?? []).includes(id));
            const bloqueoAdminEmpresa =
              esAdminDeEmpresa && u.role !== "viewer"
                ? `Solo un administrador global puede gestionar a un ${ROLE_LABEL[u.role]}.`
                : empresasAjenas
                ? "Este usuario también pertenece a una empresa que no administras."
                : !esAdminDeEmpresa && appUser?.email !== SUPERUSER_EMAIL
                  ? "Solo el superusuario raíz puede gestionar los accesos globales."
                  : null;
            const editable = !isRoot && !isSelf && !bloqueoAdminEmpresa;
            const soloLectura = !!bloqueoAdminEmpresa;
            const userProjects = u.projectIds ?? [];
            const userClients = u.clientIds ?? [];
            const isOpen = expanded === u.email;
            return (
              <div key={u.email} className="border-b last:border-0">
                <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-6">
                  <div className="flex-1 min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-medium truncate">
                      {u.email}
                      {isSelf && <span className="text-xs text-muted-foreground">(tú)</span>}
                      {!isRoot && !u.githubToken && (
                        <span title="Sin API key de GitHub — verá el bloqueo al entrar">
                          <KeyRound className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {isRoot ? "Superusuario raíz · todos los proyectos" : `Invitado por ${u.addedBy}`}
                    </p>
                    {/* Empresas a las que pertenece, por nombre (el id no le dice nada a nadie). */}
                    {!isRoot && (
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Building2 className="h-3 w-3 shrink-0" />
                        {userClients.length === 0 ? (
                          // Un administrador de empresa sin empresas quedó a medio
                          // configurar: el rol ya está puesto pero todavía no manda
                          // en nada. Se dice qué falta, no solo que falta.
                          <span className="text-amber-600 dark:text-amber-400">
                            {u.role === "client_admin"
                              ? "Sin empresa asignada — no administra nada hasta que le marques una abajo"
                              : "Sin empresa asignada"}
                          </span>
                        ) : (
                          <span className="truncate">{userClients.map(nombreEmpresa).join(" · ")}</span>
                        )}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    {!isRoot && (
                      <button
                        onClick={() => setExpanded(isOpen ? null : u.email)}
                        className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                        title="Proyectos y permisos"
                      >
                        <FolderGit2 className="h-3.5 w-3.5" />
                        {userProjects.length || projects.length} proyectos · permisos
                        {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      </button>
                    )}

                    {editable ? (
                      <SelectNative
                        className="w-52"
                        value={u.role}
                        disabled={busy === u.email}
                        onChange={(e) => handleRole(u, e.target.value as UserRole)}
                      >
                        {/* El rol actual siempre aparece, aunque quien edita no lo pueda asignar. */}
                        {(rolesAsignables.includes(u.role) ? rolesAsignables : [...rolesAsignables, u.role]).map((r) => (
                          <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                        ))}
                      </SelectNative>
                    ) : (
                      <Badge
                        variant={u.role === "viewer" ? "secondary" : "default"}
                        className="shrink-0"
                        title={bloqueoAdminEmpresa ?? undefined}
                      >
                        {ROLE_ICON[u.role]}
                        {ROLE_LABEL[u.role]}
                      </Badge>
                    )}

                    {editable ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        disabled={busy === u.email}
                        onClick={() => handleRemove(u.email)}
                      >
                        {busy === u.email ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </Button>
                    ) : (
                      // El botón deshabilitado no muestra tooltip (pointer-events: none),
                      // así que el `title` va en el envoltorio.
                      bloqueoAdminEmpresa && (
                        <span title={bloqueoAdminEmpresa} className="inline-flex">
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" disabled>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </span>
                      )
                    )}
                  </div>
                </div>

                {/* Editor de proyectos */}
                {isOpen && !isRoot && (
                  <div className="bg-muted/30 px-4 py-3 sm:px-6" title={bloqueoAdminEmpresa ?? undefined}>
                    {bloqueoAdminEmpresa && (
                      <p className="mb-3 text-[11px] text-amber-600 dark:text-amber-400">{bloqueoAdminEmpresa}</p>
                    )}

                    {/* Empresas del usuario */}
                    <p className="mb-2 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <Building2 className="h-3.5 w-3.5" />
                      {u.role === "client_admin" ? "Empresas que administra (al menos una)" : "Empresas a las que pertenece"}
                    </p>
                    <ClientPills
                      clients={visibleClients}
                      selected={(id) => userClients.includes(id)}
                      disabled={busy === u.email || soloLectura}
                      onToggle={(id) => handleToggleClient(u, id)}
                    />

                    <p className="mb-2 mt-4 text-xs text-muted-foreground">
                      Marca los proyectos a los que <span className="font-medium">{u.email}</span> tiene acceso (mínimo 1).
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {projects.map((p) => {
                        const on = (u.projectIds ?? projects.map((x) => x.id)).includes(p.id);
                        return (
                          <button
                            key={p.id}
                            type="button"
                            disabled={busy === u.email || soloLectura}
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

                    {/* Permisos CI/CD */}
                    <p className="mb-2 mt-4 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <Shield className="h-3.5 w-3.5" /> Permisos CI/CD
                    </p>
                    <PermissionChips
                      value={resolvePermissions(u)}
                      disabled={busy === u.email || soloLectura}
                      onToggle={(key) => handleTogglePermission(u, key)}
                    />
                    {u.permissions === undefined && (
                      <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                        Sin permisos explícitos: por compatibilidad, {u.role === "viewer" ? "Viewer = nada permitido" : `${ROLE_LABEL[u.role]} = todo permitido`}. Al tocar un chip se fijan explícitos.
                      </p>
                    )}

                    {/* API key de GitHub (el root la puede registrar/actualizar) */}
                    <p className="mb-2 mt-4 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <KeyRound className="h-3.5 w-3.5" /> API key de GitHub
                    </p>
                    {tokenEdit?.email === u.email ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="password"
                          autoFocus
                          className="w-64 rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
                          placeholder="ghp_…"
                          value={tokenEdit.value}
                          onChange={(e) => setTokenEdit({ email: u.email, value: e.target.value })}
                          onKeyDown={(e) => e.key === "Enter" && handleSaveToken()}
                        />
                        <Button size="sm" variant="outline" disabled={busy === u.email || !tokenEdit.value.trim()} onClick={handleSaveToken}>
                          {busy === u.email ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Validar y guardar"}
                        </Button>
                        <button
                          type="button"
                          className="text-xs text-muted-foreground underline"
                          onClick={() => setTokenEdit(null)}
                        >
                          cancelar
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        {u.githubToken ? (
                          <span className="flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300">
                            ✓ configurada — @{u.githubLogin}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300">
                            ✗ sin configurar — verá el bloqueo al entrar
                          </span>
                        )}
                        {!soloLectura && (
                          <button
                            type="button"
                            className="text-muted-foreground underline hover:text-foreground"
                            onClick={() => setTokenEdit({ email: u.email, value: "" })}
                          >
                            {u.githubToken ? "actualizar" : "registrar"}
                          </button>
                        )}
                      </div>
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
