import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Plus, Pencil, Trash2, Users, AlertTriangle, FolderGit2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import { useClientsBilling } from "@/hooks/useClients";
import { useProjects } from "@/hooks/useProjectsRepos";
import { isFacturable } from "@/lib/billing";
import { updateClient, removeClient, clientDisplayName } from "@/lib/firestoreClients";
import type { Client, ClientStatus } from "@/lib/firestoreClients";
import { ClientFormModal } from "./ClientFormModal";

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
  // Los datos fiscales viven en el doc privado del cliente, así que el badge
  // "Sin datos fiscales" necesita la lectura con billing (solo superusers).
  const { data: clients = [], isLoading } = useClientsBilling();
  const { data: projects = [] } = useProjects();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // null = cerrado. { id: null } = crear nuevo; { id: "x" } = editar ese cliente.
  const [formFor, setFormFor] = useState<{ id: string | null } | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["clients"] });

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
          const proyectos = projects.filter((p) => p.clientId === c.id).length;
          const faltaFiscal = !isFacturable(c);
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
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <FolderGit2 className="h-3.5 w-3.5" />
                  {proyectos} proyecto{proyectos === 1 ? "" : "s"}
                </span>
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
