import { useState, useEffect } from "react";
import { UserPlus, Trash2, Shield, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { getAllUsers, addUser, removeUser, SUPERUSER_EMAIL, type AppUser } from "@/lib/firestoreUsers";

export function UsersPage() {
  const { appUser } = useAuth();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isSuperuser = appUser?.role === "superuser";

  useEffect(() => {
    getAllUsers().then(setUsers);
  }, []);

  const handleAdd = async () => {
    if (!newEmail.trim()) return;
    setLoading(true);
    setError("");
    try {
      await addUser(newEmail.trim(), appUser!.email);
      setUsers(await getAllUsers());
      setNewEmail("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al agregar");
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (email: string) => {
    if (!confirm(`¿Eliminar acceso a ${email}?`)) return;
    try {
      await removeUser(email);
      setUsers(await getAllUsers());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al eliminar");
    }
  };

  if (!isSuperuser) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Solo el superusuario puede gestionar accesos.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Gestión de Accesos</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Administra quién puede acceder al dashboard</p>
      </div>

      {/* Add user */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <UserPlus className="h-4 w-4" /> Invitar usuario
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <input
              type="email"
              className="flex-1 px-3 py-2 text-sm border rounded-md bg-background"
              placeholder="email@ejemplo.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
            <Button onClick={handleAdd} disabled={loading || !newEmail.trim()} size="sm">
              Agregar
            </Button>
          </div>
          {error && <p className="text-xs text-destructive mt-2">{error}</p>}
        </CardContent>
      </Card>

      {/* User list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Usuarios con acceso ({users.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {users.map((u) => (
            <div key={u.email} className="flex items-center gap-3 px-6 py-3 border-b last:border-0">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{u.email}</p>
                <p className="text-xs text-muted-foreground">
                  {u.email === SUPERUSER_EMAIL ? "Superusuario del sistema" : `Invitado por ${u.addedBy}`}
                </p>
              </div>
              <Badge variant={u.role === "superuser" ? "default" : "secondary"} className="shrink-0">
                {u.role === "superuser"
                  ? <><Shield className="h-3 w-3 mr-1" />Superusuario</>
                  : <><Eye className="h-3 w-3 mr-1" />Viewer</>}
              </Badge>
              {u.email !== SUPERUSER_EMAIL && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => handleRemove(u.email)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
