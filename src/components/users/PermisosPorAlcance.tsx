/**
 * Excepciones de los permisos CI/CD por empresa y por repo (Usuarios).
 *
 * Los generales son la base; encima, lo de la empresa del proyecto y luego lo
 * del repo (gana el más específico: ver `resolvePermissions`). Cada chip tiene
 * tres estados: hereda (gris punteado, enseña lo que hereda), sí (verde) y no
 * (rojo). Un clic avanza hereda → sí → no → hereda.
 *
 * De momento solo esconden botones del dashboard: lo que deja hacer el token
 * personal lo decide GitHub.
 */
import { useState } from "react";
import { Building2, Check, FolderGit2, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { SelectNative } from "@/components/ui/select-native";
import { clientDisplayName, type Client } from "@/lib/firestoreClients";
import type { MonitoredRepo, Project } from "@/lib/firestoreProjects";
import {
  resolvePermissions, setUserPermissionOverride, type AppUser, type CicdPermissions,
} from "@/lib/firestoreUsers";

export interface DefPermiso {
  key: keyof CicdPermissions;
  label: string;
  icon: React.ReactNode;
}

type Alcance = { nivel: "general" } | { nivel: "client"; id: string } | { nivel: "repo"; id: string };

const tieneExcepciones = (o: Partial<CicdPermissions> | undefined) => !!o && Object.keys(o).length > 0;

export function PermisosPorAlcance({ user, defs, clients, projects, repos, disabled, general, onCambio }: {
  user: AppUser;
  defs: DefPermiso[];
  /** Empresas del usuario. */
  clients: Client[];
  /** Proyectos a los que tiene acceso. */
  projects: Project[];
  repos: MonitoredRepo[];
  disabled?: boolean;
  /** Chips de los permisos generales (los de siempre). */
  general: React.ReactNode;
  onCambio: () => Promise<void>;
}) {
  const [alcance, setAlcance] = useState<Alcance>({ nivel: "general" });
  const [ocupado, setOcupado] = useState<keyof CicdPermissions | null>(null);
  const [error, setError] = useState("");

  const proyectoIds = new Set(projects.map((p) => p.id));
  // Los repos que ve: en cada proyecto, los marcados; sin ninguno marcado, todos.
  const marcados = new Set(user.repoIds ?? []);
  const conMarcados = new Set(repos.filter((r) => marcados.has(r.id)).map((r) => r.projectId));
  const susRepos = repos
    .filter((r) => proyectoIds.has(r.projectId) && (!conMarcados.has(r.projectId) || marcados.has(r.id)))
    .sort((a, b) => a.label.localeCompare(b.label));
  const clientDeRepo = (repoId: string) => {
    const r = repos.find((x) => x.id === repoId);
    return projects.find((p) => p.id === r?.projectId)?.clientId ?? null;
  };

  const porClient = user.permissionsByClient ?? {};
  const porRepo = user.permissionsByRepo ?? {};
  const reposConExcepcion = susRepos.filter((r) => tieneExcepciones(porRepo[r.id]));

  // Lo propio del alcance elegido y lo que heredaría sin él.
  const propio: Partial<CicdPermissions> =
    alcance.nivel === "client" ? porClient[alcance.id] ?? {} : alcance.nivel === "repo" ? porRepo[alcance.id] ?? {} : {};
  const heredado: CicdPermissions =
    alcance.nivel === "repo"
      ? resolvePermissions(user, { clientId: clientDeRepo(alcance.id) })
      : resolvePermissions(user);

  const ciclar = async (key: keyof CicdPermissions) => {
    if (alcance.nivel === "general") return;
    const actual = propio[key];
    const siguiente = actual === undefined ? true : actual ? false : null;
    setOcupado(key);
    setError("");
    try {
      await setUserPermissionOverride(user.email, alcance.nivel, alcance.id, key, siguiente);
      await onCambio();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setOcupado(null);
    }
  };

  const chipAlcance = (a: Alcance, etiqueta: React.ReactNode, conExcepciones: boolean) => {
    const sel = a.nivel === alcance.nivel && (a.nivel === "general" || (alcance.nivel !== "general" && a.id === alcance.id));
    return (
      <button
        key={a.nivel === "general" ? "general" : `${a.nivel}:${a.id}`}
        type="button"
        onClick={() => setAlcance(a)}
        className={cn(
          "flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors",
          sel ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted",
        )}
      >
        {etiqueta}
        {conExcepciones && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="Tiene excepciones" />}
      </button>
    );
  };

  const repoElegido = alcance.nivel === "repo" ? alcance.id : "";

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">Aplica a:</span>
        {chipAlcance({ nivel: "general" }, "General", false)}
        {clients.map((c) => chipAlcance(
          { nivel: "client", id: c.id },
          <><Building2 className="h-3 w-3" />{clientDisplayName(c)}</>,
          tieneExcepciones(porClient[c.id]),
        ))}
        {susRepos.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <FolderGit2 className="h-3 w-3 text-muted-foreground" />
            <SelectNative
              className={cn("h-6 py-0 pl-2 pr-7 text-[11px]", repoElegido && "border-primary text-primary")}
              value={repoElegido}
              onChange={(e) => setAlcance(e.target.value ? { nivel: "repo", id: e.target.value } : { nivel: "general" })}
            >
              <option value="">Un repo…</option>
              {susRepos.map((r) => (
                <option key={r.id} value={r.id}>{r.label}{tieneExcepciones(porRepo[r.id]) ? " •" : ""}</option>
              ))}
            </SelectNative>
          </span>
        )}
      </div>

      {alcance.nivel === "general" ? (
        <>
          {general}
          {reposConExcepcion.length > 0 && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Repos con excepciones: {reposConExcepcion.map((r) => r.label).join(", ")}.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {defs.map((d) => {
              const v = propio[d.key];
              const hereda = v === undefined;
              const efectivo = hereda ? heredado[d.key] : v;
              return (
                <button
                  key={d.key}
                  type="button"
                  disabled={disabled || ocupado !== null}
                  onClick={() => void ciclar(d.key)}
                  title={hereda ? `Hereda: ${efectivo ? "sí" : "no"}. Clic para fijar.` : v ? "Sí (excepción). Clic: no." : "No (excepción). Clic: heredar."}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
                    hereda && "border-dashed border-border text-muted-foreground hover:bg-muted",
                    v === true && "border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/30 dark:text-emerald-300",
                    v === false && "border-red-300 bg-red-50 text-red-700 line-through dark:border-red-800/60 dark:bg-red-950/30 dark:text-red-300",
                  )}
                >
                  {ocupado === d.key ? <Loader2 className="h-3 w-3 animate-spin" /> : d.icon}
                  {d.label}
                  {hereda && (efectivo
                    ? <Check className="h-3 w-3 opacity-60" />
                    : <X className="h-3 w-3 opacity-60" />)}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Punteado = hereda {alcance.nivel === "repo" ? "de la empresa / general" : "de los generales"} (✓ sí, ✗ no). Clic: sí → no → hereda.
            {" "}Solo esconde botones del dashboard; lo que deja hacer su token lo decide GitHub.
          </p>
        </>
      )}
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
