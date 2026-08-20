import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Plus, Pencil, Trash2, Users, AlertTriangle, FolderGit2,
  ChevronDown, ChevronRight, Check, Smartphone, Unlink,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useClientsBilling } from "@/hooks/useClients";
import { useProjects, useRepos } from "@/hooks/useProjectsRepos";
import { isFacturable } from "@/lib/billing";
import { updateClient, removeClient, clientDisplayName } from "@/lib/firestoreClients";
import type { Client, ClientStatus } from "@/lib/firestoreClients";
import {
  addProject, renameProject, removeProject, setProjectClient, setProjectIsApp,
} from "@/lib/firestoreProjects";
import { ClientFormModal } from "./ClientFormModal";
import { ChevronPlegar } from "./Collapsible";
import { useAbiertos } from "@/hooks/useAbiertos";

const STATUS_LABEL: Record<ClientStatus, string> = {
  activo: "Activo",
  suspendido: "Suspendido",
  prospecto: "Prospecto",
};

/** Suspendido en rojo: es el estatus que corta la facturación, tiene que saltar. */
const STATUS_VARIANT: Record<ClientStatus, "success" | "destructive" | "secondary"> = {
  activo: "success",
  suspendido: "destructive",
  prospecto: "secondary",
};

export function ClientsSection() {
  const qc = useQueryClient();
  const { appUser } = useAuth();
  // Los datos fiscales viven en el doc privado del cliente, así que el badge
  // "Sin datos fiscales" necesita la lectura con billing (solo superusers).
  const { data: clients = [], isLoading } = useClientsBilling(appUser);
  const { data: projects = [] } = useProjects();
  // Los repos deciden qué se puede borrar: un proyecto con repos no se elimina.
  const { data: repos = [] } = useRepos();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // null = cerrado. { id: null } = crear nuevo; { id: "x" } = editar ese cliente.
  const [formFor, setFormFor] = useState<{ id: string | null } | null>(null);
  // Cliente cuyo desplegable de proyectos está abierto (solo uno a la vez).
  const [abierto, setAbierto] = useState<string | null>(null);
  // Y, dentro, qué proyectos muestran sus repos. Varios a la vez: comparar qué
  // repo quedó en qué proyecto era justo lo que había que salir a buscar a la
  // otra pestaña.
  const { abiertos: reposAbiertos, alternar: alternarRepos } = useAbiertos();
  // Proyecto con el nombre en edición en línea, y el borrador de ese nombre.
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [nuevoNombre, setNuevoNombre] = useState("");

  const refresh = () => qc.invalidateQueries({ queryKey: ["clients"] });
  const refreshProjects = () => qc.invalidateQueries({ queryKey: ["projects"] });

  const run = async (key: string, fn: () => Promise<unknown>, after: () => Promise<unknown> | void) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await after();
    } catch (e) {
      // `removeClient` explica cuántos proyectos bloquean el borrado: ese texto
      // es la instrucción para el usuario, se muestra tal cual.
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(null);
    }
  };

  const eliminar = (c: Client) => {
    const proyectos = projects.filter((p) => p.clientId === c.id).length;
    const aviso = proyectos > 0
      ? `"${clientDisplayName(c)}" tiene ${proyectos} proyecto(s) asignado(s). ¿Intentar eliminarlo?`
      : `¿Eliminar a "${clientDisplayName(c)}"? No se puede deshacer.`;
    if (!window.confirm(aviso)) return;
    return run(`del-${c.id}`, () => removeClient(c.id), refresh);
  };

  /** Abre/cierra el desplegable de proyectos, tirando lo que se estaba editando. */
  const toggleProyectos = (clientId: string) => {
    setAbierto((prev) => (prev === clientId ? null : clientId));
    setEditing(null);
    setNuevoNombre("");
  };

  const guardarNombre = (projectId: string, nombre: string) => {
    if (!nombre.trim()) return;
    void run(`rn-${projectId}`, () => renameProject(projectId, nombre), refreshProjects)
      .then(() => setEditing(null));
  };

  /** Crea el proyecto y lo deja ya colgado de la empresa, en una sola pasada. */
  const crearEnCliente = (clientId: string) => {
    const nombre = nuevoNombre.trim();
    if (!nombre) return;
    const email = appUser?.email;
    if (!email) {
      setError("No se pudo identificar tu usuario para crear el proyecto.");
      return;
    }
    void run(
      `nuevo-${clientId}`,
      async () => {
        const id = await addProject(nombre, email);
        await setProjectClient(id, clientId);
      },
      refreshProjects,
    ).then(() => setNuevoNombre(""));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <Users className="h-5 w-5 text-primary" /> Clientes
          {clients.length > 0 && (
            <span className="text-sm font-normal text-muted-foreground">({clients.length})</span>
          )}
        </h2>
        <Button size="sm" onClick={() => setFormFor({ id: null })}>
          <Plus className="h-4 w-4" /> Nuevo cliente
        </Button>
      </div>

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando clientes…
        </p>
      )}

      {!isLoading && clients.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            <Users className="h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium">Aún no hay clientes</p>
            <p className="text-xs text-muted-foreground">
              Da de alta al primero para poder asignarle proyectos y facturarle.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {clients.map((c) => {
          const nombre = clientDisplayName(c);
          const susProyectos = projects.filter((p) => p.clientId === c.id);
          const proyectos = susProyectos.length;
          const faltaFiscal = !isFacturable(c);
          const desplegado = abierto === c.id;
          return (
            <Card
              key={c.id}
              className="cursor-pointer transition-colors hover:bg-accent/40"
              onClick={() => setFormFor({ id: c.id })}
            >
              <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{nombre}</p>
                  {/* La razón social solo aporta cuando el nombre visible es el comercial. */}
                  {c.legalName !== nombre && (
                    <p className="truncate text-[11px] text-muted-foreground">{c.legalName}</p>
                  )}
                </div>

                <Badge variant={STATUS_VARIANT[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                <Badge variant="outline">
                  {c.personaType === "fisica" ? "Persona física" : "Persona moral"}
                </Badge>
                {/* El conteo abre la gestión de proyectos de esta empresa, sin
                    llevarse por delante el modal de edición del cliente. */}
                <button
                  type="button"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title={desplegado ? "Ocultar los proyectos de esta empresa" : "Ver y gestionar los proyectos de esta empresa"}
                  onClick={(e) => { e.stopPropagation(); toggleProyectos(c.id); }}
                >
                  {desplegado
                    ? <ChevronDown className="h-3.5 w-3.5" />
                    : <ChevronRight className="h-3.5 w-3.5" />}
                  <FolderGit2 className="h-3.5 w-3.5" />
                  {proyectos} proyecto{proyectos === 1 ? "" : "s"}
                </button>
                {faltaFiscal && (
                  <Badge variant="warning" className="gap-1" title="Falta RFC, régimen fiscal o CP">
                    <AlertTriangle className="h-3 w-3" /> Sin datos fiscales
                  </Badge>
                )}

                {/* Controles: el click no debe abrir el modal de edición. */}
                <div
                  className="flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <SelectNative
                    className="h-7 w-32 text-xs"
                    value={c.status}
                    disabled={busy === `st-${c.id}`}
                    title="Cambiar estatus"
                    onChange={(e) =>
                      run(`st-${c.id}`, () => updateClient(c.id, { status: e.target.value as ClientStatus }), refresh)
                    }
                  >
                    {(Object.keys(STATUS_LABEL) as ClientStatus[]).map((s) => (
                      <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                    ))}
                  </SelectNative>
                  {busy === `st-${c.id}` && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="Editar cliente"
                    onClick={() => setFormFor({ id: c.id })}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    disabled={busy === `del-${c.id}`}
                    title="Eliminar cliente"
                    onClick={() => eliminar(c)}
                  >
                    {busy === `del-${c.id}`
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </CardContent>

              {/* Proyectos de la empresa. Corta el click para que gestionarlos
                  no abra el modal de edición del cliente. */}
              {desplegado && (
                <div
                  className="cursor-default space-y-2 border-t bg-muted/10 px-3 py-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  {susProyectos.length === 0 ? (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <FolderGit2 className="h-3.5 w-3.5" /> Este cliente todavía no tiene proyectos asignados.
                    </p>
                  ) : (
                    susProyectos.map((p) => {
                      const nRepos = repos.filter((r) => r.projectId === p.id).length;
                      // null = no se está renombrando este proyecto.
                      const borrador = editing && editing.id === p.id ? editing.name : null;
                      const esApp = p.isApp === true;
                      return (
                        <div key={p.id} className="rounded-md border bg-muted/20">
                          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                          {borrador !== null ? (
                            <input
                              autoFocus
                              className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm"
                              value={borrador}
                              onChange={(e) => setEditing({ id: p.id, name: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") guardarNombre(p.id, borrador);
                                if (e.key === "Escape") setEditing(null);
                              }}
                            />
                          ) : (
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                          )}
                          {nRepos === 0 ? (
                            <span className="text-xs text-muted-foreground">sin repos</span>
                          ) : (
                            <button
                              type="button"
                              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                              title={
                                reposAbiertos.has(p.id)
                                  ? `Ocultar los repos de ${p.name}`
                                  : `Ver los repos de ${p.name}`
                              }
                              onClick={() => alternarRepos(p.id)}
                            >
                              <ChevronPlegar abierto={reposAbiertos.has(p.id)} className="h-3.5 w-3.5" />
                              {nRepos} repo{nRepos === 1 ? "" : "s"}
                            </button>
                          )}

                          {/* Toggle APP */}
                          <button
                            type="button"
                            title={esApp ? "Es App — click para desactivar" : "No es App — click para activar"}
                            disabled={busy === `app-${p.id}`}
                            onClick={() => run(`app-${p.id}`, () => setProjectIsApp(p.id, !esApp), refreshProjects)}
                            className={cn(
                              "flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50",
                              esApp
                                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                                : "bg-muted text-muted-foreground hover:bg-muted/80",
                            )}
                          >
                            {busy === `app-${p.id}`
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : <Smartphone className="h-3 w-3" />}
                            APP
                          </button>

                          {borrador !== null ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              title="Guardar el nombre"
                              disabled={busy === `rn-${p.id}` || !borrador.trim()}
                              onClick={() => guardarNombre(p.id, borrador)}
                            >
                              {busy === `rn-${p.id}`
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <Check className="h-3.5 w-3.5" />}
                            </Button>
                          ) : (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              title="Renombrar proyecto"
                              onClick={() => setEditing({ id: p.id, name: p.name })}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}

                          {/* Quitarlo de la empresa (reversible) no es borrarlo. */}
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title="Quitar de esta empresa: el proyecto queda sin empresa y sus repos dejan de cobrarse. Se puede volver a asignar."
                            disabled={busy === `cli-${p.id}`}
                            onClick={() => run(`cli-${p.id}`, () => setProjectClient(p.id, null), refreshProjects)}
                          >
                            {busy === `cli-${p.id}`
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Unlink className="h-3.5 w-3.5" />}
                          </Button>

                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            disabled={busy === `delp-${p.id}` || nRepos > 0}
                            title={nRepos > 0 ? "Mueve o elimina sus repos primero" : "Eliminar proyecto"}
                            onClick={() => run(`delp-${p.id}`, () => removeProject(p.id), refreshProjects)}
                          >
                            {busy === `delp-${p.id}`
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Trash2 className="h-3.5 w-3.5" />}
                          </Button>
                          </div>

                          {/* Los repos, de solo lectura: aquí se ve qué hay en
                              cada proyecto; moverlos y ponerles precio sigue en
                              "Proyectos y repos", que es la misma estructura
                              vista desde el otro lado. */}
                          {reposAbiertos.has(p.id) && (
                            <ul className="space-y-1 border-t px-3 py-2">
                              {repos
                                .filter((r) => r.projectId === p.id)
                                .map((r) => (
                                  <li key={r.id} className="flex flex-wrap items-center gap-2 text-xs">
                                    <span className="font-medium">{r.label || r.repo}</span>
                                    <a
                                      className="font-mono text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground"
                                      href={`https://github.com/${r.owner}/${r.repo}`}
                                      target="_blank"
                                      rel="noreferrer"
                                      title="Abrir en GitHub"
                                    >
                                      {r.owner}/{r.repo}
                                    </a>
                                  </li>
                                ))}
                            </ul>
                          )}
                        </div>
                      );
                    })
                  )}

                  {/* Crear un proyecto ya dentro de esta empresa (sin reasignar después). */}
                  <div className="flex gap-2">
                    <input
                      className="min-w-0 flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
                      placeholder={`Nuevo proyecto de ${nombre}`}
                      value={nuevoNombre}
                      onChange={(e) => setNuevoNombre(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") crearEnCliente(c.id);
                        if (e.key === "Escape") setNuevoNombre("");
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      title="Crear el proyecto en esta empresa"
                      disabled={!nuevoNombre.trim() || busy === `nuevo-${c.id}`}
                      onClick={() => crearEnCliente(c.id)}
                    >
                      {busy === `nuevo-${c.id}`
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Plus className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {formFor && (
        <ClientFormModal clientId={formFor.id} onClose={() => setFormFor(null)} />
      )}
    </div>
  );
}
