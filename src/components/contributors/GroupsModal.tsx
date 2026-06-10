import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X, Loader2, Trash2, Plus, Users, Eye, EyeOff, Check, Pencil } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { addGroup, updateGroup, removeGroup } from "@/lib/firestoreGroups";
import { setContributorHidden } from "@/lib/firestoreContributors";
import { useContributorGroups, useHiddenContributors } from "@/hooks/useContributorGroups";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

interface Props {
  logins: string[]; // contribuidores conocidos (para asignar)
  onClose: () => void;
}

export function GroupsModal({ logins, onClose }: Props) {
  const { appUser } = useAuth();
  const qc = useQueryClient();
  const { data: groups = [] } = useContributorGroups();
  const { data: hidden = new Set<string>() } = useHiddenContributors();

  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState("");

  const refreshGroups = () => qc.invalidateQueries({ queryKey: ["contributor-groups"] });
  const refreshHidden = () => qc.invalidateQueries({ queryKey: ["hidden-contributors"] });

  const run = async (key: string, fn: () => Promise<unknown>, after: () => unknown) => {
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
          <div className="mb-1 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Users className="h-5 w-5 text-primary" /> Grupos de contribuidores
            </h2>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            Un contribuidor puede estar en varios grupos. El ojo controla si el grupo o el contribuidor
            (como individuo) aparece en la pestaña Analítica ejecutiva. Un contribuidor oculto sigue
            contando dentro de los grupos visibles a los que pertenezca.
          </p>

          {/* Grupos */}
          <div className="space-y-3">
            {groups.map((g) => {
              const isEditing = editing?.id === g.id;
              const candidates = logins.filter((l) => !g.members.includes(l));
              return (
                <div key={g.id} className="rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: g.color }} />
                    {isEditing ? (
                      <input
                        autoFocus
                        className="flex-1 rounded border bg-background px-2 py-1 text-sm"
                        value={editing.name}
                        onChange={(e) => setEditing({ id: g.id, name: e.target.value })}
                        onKeyDown={(e) =>
                          e.key === "Enter" &&
                          run(`rn-${g.id}`, () => updateGroup(g.id, { name: editing.name }), refreshGroups).then(() =>
                            setEditing(null),
                          )
                        }
                      />
                    ) : (
                      <span className="flex-1 text-sm font-semibold">{g.name}</span>
                    )}
                    <span className="text-xs text-muted-foreground">{g.members.length} miembro{g.members.length === 1 ? "" : "s"}</span>
                    {isEditing ? (
                      <Button
                        size="icon" variant="ghost" className="h-7 w-7"
                        onClick={() =>
                          run(`rn-${g.id}`, () => updateGroup(g.id, { name: editing.name }), refreshGroups).then(() =>
                            setEditing(null),
                          )
                        }
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing({ id: g.id, name: g.name })}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      size="icon" variant="ghost" className="h-7 w-7"
                      title={g.showInAnalytics ? "Visible en Analítica (clic para ocultar)" : "Oculto en Analítica (clic para mostrar)"}
                      disabled={busy === `vis-${g.id}`}
                      onClick={() => run(`vis-${g.id}`, () => updateGroup(g.id, { showInAnalytics: !g.showInAnalytics }), refreshGroups)}
                    >
                      {g.showInAnalytics ? <Eye className="h-3.5 w-3.5 text-emerald-600" /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
                    </Button>
                    <Button
                      size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive"
                      disabled={busy === `del-${g.id}`}
                      onClick={() => run(`del-${g.id}`, () => removeGroup(g.id), refreshGroups)}
                    >
                      {busy === `del-${g.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </div>

                  {/* Miembros */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {g.members.map((m) => (
                      <button
                        key={m}
                        title="Quitar del grupo"
                        disabled={busy === `m-${g.id}`}
                        onClick={() =>
                          run(`m-${g.id}`, () => updateGroup(g.id, { members: g.members.filter((x) => x !== m) }), refreshGroups)
                        }
                        className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary hover:bg-primary/20"
                      >
                        {m} <X className="h-3 w-3" />
                      </button>
                    ))}
                    {candidates.length > 0 && (
                      <SelectNative
                        className="h-7 w-44 text-xs"
                        value=""
                        disabled={busy === `m-${g.id}`}
                        onChange={(e) => {
                          const login = e.target.value;
                          if (!login) return;
                          run(`m-${g.id}`, () => updateGroup(g.id, { members: [...g.members, login] }), refreshGroups);
                        }}
                      >
                        <option value="">+ agregar miembro…</option>
                        {candidates.map((l) => (
                          <option key={l} value={l}>{l}</option>
                        ))}
                      </SelectNative>
                    )}
                  </div>
                </div>
              );
            })}
            {groups.length === 0 && <p className="text-xs text-muted-foreground">Aún no hay grupos.</p>}
          </div>

          {/* Nuevo grupo */}
          <div className="mt-3 flex gap-2">
            <input
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="Nuevo grupo (ej. SOZU, Jorge)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) =>
                e.key === "Enter" && newName.trim() &&
                run("add", () => addGroup(newName, appUser!.email), refreshGroups).then(() => setNewName(""))
              }
            />
            <Button
              size="sm" variant="outline"
              disabled={!newName.trim() || busy === "add"}
              onClick={() => run("add", () => addGroup(newName, appUser!.email), refreshGroups).then(() => setNewName(""))}
            >
              {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </Button>
          </div>

          {/* Visibilidad individual */}
          <h3 className="mt-6 text-sm font-semibold text-muted-foreground">
            Visibilidad individual en Analítica
          </h3>
          <p className="mb-2 text-[11px] text-muted-foreground">
            Oculto = no aparece como barra/opción individual, pero sigue sumando en sus grupos visibles.
          </p>
          <div className="flex flex-wrap gap-2">
            {logins.map((l) => {
              const isHidden = hidden.has(l);
              return (
                <button
                  key={l}
                  disabled={busy === `h-${l}`}
                  onClick={() =>
                    run(`h-${l}`, () => setContributorHidden(l, !isHidden, appUser!.email), refreshHidden)
                  }
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
                    isHidden
                      ? "border-border text-muted-foreground line-through hover:bg-muted"
                      : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300",
                  )}
                  title={isHidden ? "Clic para mostrar en Analítica" : "Clic para ocultar en Analítica"}
                >
                  {isHidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  {l}
                </button>
              );
            })}
          </div>

          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
