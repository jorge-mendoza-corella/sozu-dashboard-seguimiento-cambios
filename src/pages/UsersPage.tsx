import { useState, useEffect } from "react";
import { UserPlus, Trash2, Shield, Eye, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import { useAuth } from "@/hooks/useAuth";
import {
  getAllUsers,
  addUser,
  removeUser,
  setUserRole,
  SUPERUSER_EMAIL,
  type AppUser,
  type UserRole,
} from "@/lib/firestoreUsers";

export function UsersPage() {
  const { appUser } = useAuth();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("viewer");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // email en proceso
  const [error, setError] = useState("");

  const isSuperuser = appUser?.role === "superuser";

  useEffect(() => {
    getAllUsers().then(setUsers);
  }, []);

  const refresh = async () => setUsers(await getAllUsers());

  const handleAdd = async () => {
    if (!newEmail.trim()) return;
    setLoading(true);
    setError("");
    try {
      await addUser(newEmail.trim().toLowerCase(), appUser!.email, newRole);
      await refresh();
      setNewEmail("");
      setNewRole("viewer");
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
          Administra quién puede acceder al dashboard. Los <strong>Administradores</strong> tienen los mismos
          privilegios: pueden invitar usuarios, cambiar roles y operar CI/CD.
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
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
            <SelectNative
              className="w-44"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as UserRole)}
            >
              <option value="viewer">Viewer</option>
              <option value="superuser">Administrador</option>
            </SelectNative>
            <Button onClick={handleAdd} disabled={loading || !newEmail.trim()} size="sm">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Agregar"}
            </Button>
          </div>
          {newRole === "superuser" && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              Un Administrador tiene los mismos privilegios que tú (excepto eliminar al superusuario raíz).
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
            const editable = !isRoot && !isSelf; // raíz y uno mismo no se editan (evita lockout)
            return (
              <div key={u.email} className="flex items-center gap-3 px-6 py-3 border-b last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {u.email}
                    {isSelf && <span className="ml-1 text-xs text-muted-foreground">(tú)</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {isRoot ? "Superusuario raíz del sistema" : `Invitado por ${u.addedBy}`}
                  </p>
                </div>

                {editable ? (
                  <SelectNative
                    className="w-40"
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
                      <>
                        <Shield className="h-3 w-3 mr-1" />
                        Administrador
                      </>
                    ) : (
                      <>
                        <Eye className="h-3 w-3 mr-1" />
                        Viewer
                      </>
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
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
