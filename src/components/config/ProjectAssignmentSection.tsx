import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Plus, Building2, FolderGit2, GitBranch, Smartphone,
  AlertTriangle, Users, DollarSign, Unlink,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useClientsBilling, useBillingSettings, useBillingOverview } from "@/hooks/useClients";
import { useProjects, useRepos } from "@/hooks/useProjectsRepos";
import {
  addProject, setProjectClient, moveRepoToProject, setRepoMonthlyPrice,
  type MonitoredRepo, type Project,
} from "@/lib/firestoreProjects";
import { clientDisplayName, type Client, type Currency } from "@/lib/firestoreClients";
import { resolveRepoPrice, formatMoney, type PriceSource } from "@/lib/billing";
import { DEFAULT_BILLING_SETTINGS, type BillingSettings } from "@/lib/billingSettings";

// ---------------------------------------------------------------------------
// Amarre de la jerarquía Cliente → Proyectos → Repos, que es lo que define a
// quién se le cobra qué. El repo es la unidad cobrable: su precio sale de él
// mismo, si no de la tarifa del cliente y si no del default global. Aquí se ve
// esa cascada resuelta al lado de cada input, para no adivinar de dónde salió
// el monto.
//
// Un proyecto sin cliente (o apuntando a un cliente borrado) NO se le cobra a
// nadie: por eso vive en su propio bloque destacado al final, en vez de
// esconderse entre los demás.
// ---------------------------------------------------------------------------

/** Etiqueta legible del origen del precio efectivo (`resolveRepoPrice`). */
const ETIQUETA_ORIGEN: Record<PriceSource, string> = {
  repo: "propio del repo",
  cliente: "tarifa del cliente",
  default: "default global",
  "sin-precio": "sin tarifa (otra moneda)",
};

/**
 * Color del origen: verde = fijado a mano, azul = heredado, ámbar = default.
 * `sin-precio` va en rojo porque no es un precio heredado sino un cero: el
 * cliente cobra en otra moneda y hay que fijarle tarifa propia.
 */
const COLOR_ORIGEN: Record<PriceSource, string> = {
  repo: "text-emerald-600 dark:text-emerald-400",
  cliente: "text-sky-600 dark:text-sky-400",
  default: "text-amber-600 dark:text-amber-400",
  "sin-precio": "text-rose-600 dark:text-rose-400",
};

/** Firma del helper `run` de ManageModal, compartida con las filas hijas. */
type RunFn = (
  key: string,
  fn: () => Promise<unknown>,
  after: () => Promise<unknown> | void,
) => Promise<void>;

/** Proyectos agrupados por cliente para los `<optgroup>` del selector de mover. */
interface GrupoProyectos {
  label: string;
  projects: Project[];
}

const plural = (n: number, singular: string, plural_: string) =>
  `${n} ${n === 1 ? singular : plural_}`;

// --- Fila de repo -----------------------------------------------------------

interface RepoRowProps {
  repo: MonitoredRepo;
  /** Cliente dueño del proyecto del repo; undefined = proyecto sin cliente. */
  client: Client | undefined;
  settings: BillingSettings;
  currency: Currency;
  grupos: GrupoProyectos[];
  busy: string | null;
  run: RunFn;
  onError: (msg: string) => void;
  refreshRepos: () => Promise<unknown>;
}

function RepoRow({
  repo, client, settings, currency, grupos, busy, run, onError, refreshRepos,
}: RepoRowProps) {
  const { price, source } = resolveRepoPrice(repo, client, settings);
  // Vacío = el repo no tiene precio propio y hereda (cliente → default global).
  const valorActual = typeof repo.monthlyPrice === "number" ? String(repo.monthlyPrice) : "";

  const guardarPrecio = (valor: string, input: HTMLInputElement) => {
    const limpio = valor.trim();
    if (limpio === valorActual) return; // blur sin cambios: no escribir Firestore
    // El type=number ya filtra basura, pero un pegado raro puede dejar NaN.
    if (limpio !== "" && !Number.isFinite(Number(limpio))) {
      onError("El precio del repo debe ser un número (usa punto para los decimales).");
      input.value = valorActual;
      return;
    }
    void run(
      `precio-${repo.id}`,
      () => setRepoMonthlyPrice(repo.id, limpio === "" ? null : Number(limpio)),
      refreshRepos,
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{repo.label}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {repo.owner}/{repo.repo}
        </p>
      </div>

      {/* Precio mensual propio del repo. Vacío = hereda. */}
      <div className="flex items-center gap-2">
        <div className="flex flex-col">
          <input
            // La key resincroniza el defaultValue cuando el dato vuelve de Firestore.
            key={valorActual || "hereda"}
            type="number"
            min={0}
            step="1"
            inputMode="decimal"
            className="h-8 w-28 rounded border bg-background px-2 text-right text-sm"
            placeholder="hereda"
            title="Precio mensual de este repo. Vacío = hereda la tarifa del cliente o el default global."
            defaultValue={valorActual}
            disabled={busy === `precio-${repo.id}`}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => guardarPrecio(e.target.value, e.target)}
          />
          {/*
            De dónde sale el monto que realmente se cobra. Sin cliente no hay a
            quién cobrarle: pintar el monto ahí se leía como ingreso real.
          */}
          <span
            className={cn(
              "mt-0.5 text-right text-[10px]",
              client ? COLOR_ORIGEN[source] : "text-amber-600 dark:text-amber-400",
            )}
          >
            {client
              ? `${formatMoney(price, currency)} · ${ETIQUETA_ORIGEN[source]}`
              : "no se cobra"}
          </span>
        </div>
        {busy === `precio-${repo.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      {/* Mover el repo a otro proyecto (agrupados por cliente para no perderse). */}
      <SelectNative
        className="h-8 w-52 text-xs"
        value={repo.projectId}
        title="Mover este repo a otro proyecto"
        disabled={busy === `mover-${repo.id}`}
        onChange={(e) => {
          const destino = e.target.value;
          if (!destino || destino === repo.projectId) return;
          void run(`mover-${repo.id}`, () => moveRepoToProject(repo.id, destino), refreshRepos);
        }}
      >
        {grupos.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </optgroup>
        ))}
      </SelectNative>
      {busy === `mover-${repo.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
    </div>
  );
}

// --- Bloque de proyecto -----------------------------------------------------

interface ProjectBlockProps {
  project: Project;
  repos: MonitoredRepo[];
  clients: Client[];
  /** Cliente dueño (undefined si el proyecto está huérfano). */
  client: Client | undefined;
  settings: BillingSettings;
  currency: Currency;
  grupos: GrupoProyectos[];
  busy: string | null;
  run: RunFn;
  onError: (msg: string) => void;
  refreshProjects: () => Promise<unknown>;
  refreshRepos: () => Promise<unknown>;
}

function ProjectBlock({
  project, repos, clients, client, settings, currency, grupos, busy, run, onError,
  refreshProjects, refreshRepos,
}: ProjectBlockProps) {
  const propios = repos.filter((r) => r.projectId === project.id);

  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: project.color }} />
        <span className="text-sm font-medium">{project.name}</span>
        {project.isApp && (
          <span className="flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
            <Smartphone className="h-3 w-3" /> APP
          </span>
        )}
        <span className="text-xs text-muted-foreground">{plural(propios.length, "repo", "repos")}</span>

        {/* Reasignar el proyecto a otro cliente (vacío = dejarlo sin cobrar). */}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Cliente:</span>
          <SelectNative
            className="h-8 w-56 text-xs"
            value={client?.id ?? ""}
            disabled={busy === `cli-${project.id}`}
            onChange={(e) =>
              void run(
                `cli-${project.id}`,
                () => setProjectClient(project.id, e.target.value || null),
                refreshProjects,
              )
            }
          >
            <option value="">— sin cliente —</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{clientDisplayName(c)}</option>
            ))}
          </SelectNative>
          {busy === `cli-${project.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
      </div>

      {/* Repos del proyecto: lo que de verdad se cobra. */}
      <div className="mt-2 space-y-1.5 pl-4">
        {propios.length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <GitBranch className="h-3.5 w-3.5" /> Este proyecto todavía no tiene repositorios: no genera cobro.
          </p>
        ) : (
          propios.map((r) => (
            <RepoRow
              key={r.id}
              repo={r}
              client={client}
              settings={settings}
              currency={currency}
              grupos={grupos}
              busy={busy}
              run={run}
              onError={onError}
              refreshRepos={refreshRepos}
            />
          ))
        )}
      </div>
    </div>
  );
}

// --- Sección ----------------------------------------------------------------

export function ProjectAssignmentSection() {
  const { appUser } = useAuth();
  const qc = useQueryClient();
  // Las tarifas viven en el doc privado del cliente, así que aquí hace falta la
  // lectura de administración y no la pública de la navegación.
  const { data: clients = [], isLoading: cargandoClientes } = useClientsBilling();
  const { data: projects = [], isLoading: cargandoProyectos } = useProjects();
  const { data: repos = [], isLoading: cargandoRepos } = useRepos();
  const { data: settings = DEFAULT_BILLING_SETTINGS, isLoading: cargandoSettings } = useBillingSettings();
  const { overview } = useBillingOverview();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Cliente sobre el que está abierto el input de "nuevo proyecto".
  const [nuevoPara, setNuevoPara] = useState<string | null>(null);
  const [nuevoNombre, setNuevoNombre] = useState("");

  const refreshProjects = () => qc.invalidateQueries({ queryKey: ["projects"] });
  // El grid de repos y el estado de GitHub también dependen del reparto de repos.
  const refreshRepos = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["repos"] }),
      qc.invalidateQueries({ queryKey: ["github-status"] }),
    ]);

  const run: RunFn = async (key, fn, after) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await after();
    } catch (e) {
      // Los errores de la capa de datos (precio negativo, permisos…) se muestran:
      // tragarlos deja al usuario creyendo que guardó.
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(null);
    }
  };

  const idsCliente = useMemo(() => new Set(clients.map((c) => c.id)), [clients]);

  // Huérfanos: sin `clientId` o apuntando a un cliente que ya se borró. Mismo
  // criterio que `computeBillingOverview`, para que los conteos cuadren.
  const huerfanos = useMemo(
    () => projects.filter((p) => !p.clientId || !idsCliente.has(p.clientId)),
    [projects, idsCliente],
  );

  const idsProyectoHuerfano = useMemo(() => new Set(huerfanos.map((p) => p.id)), [huerfanos]);
  const reposSinCliente = repos.filter((r) => idsProyectoHuerfano.has(r.projectId));

  // Opciones del selector de "mover repo", agrupadas por cliente.
  const grupos = useMemo<GrupoProyectos[]>(() => {
    const lista: GrupoProyectos[] = clients
      .map((c) => ({
        label: clientDisplayName(c),
        projects: projects.filter((p) => p.clientId === c.id),
      }))
      .filter((g) => g.projects.length > 0);
    if (huerfanos.length > 0) lista.push({ label: "Sin cliente asignado", projects: huerfanos });
    return lista;
  }, [clients, projects, huerfanos]);

  /** Crea el proyecto y lo deja ya colgado del cliente, en una sola pasada. */
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
    ).then(() => {
      setNuevoNombre("");
      setNuevoPara(null);
    });
  };

  if (cargandoClientes || cargandoProyectos || cargandoRepos || cargandoSettings) {
    return (
      <div className="flex h-40 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Cargando clientes, proyectos y repositorios…
      </div>
    );
  }

  // Los totales salen del motor de cobro: es el que garantiza que
  // `billedRepos + unassignedRepos === totalRepos` y el único que cuenta los
  // repos cuyo proyecto ya se borró. Recalcularlos aquí contradecía a Negocio.
  const totales = [
    {
      label: "Clientes",
      value: String(overview.totalClients),
      icon: <Users className="h-4 w-4 text-sky-500" />,
    },
    {
      label: "Proyectos",
      value: String(overview.totalProjects),
      icon: <FolderGit2 className="h-4 w-4 text-indigo-500" />,
    },
    {
      label: "Repos cobrables",
      value: String(overview.billedRepos),
      icon: <DollarSign className="h-4 w-4 text-emerald-500" />,
    },
    {
      label: "Repos sin cliente",
      value: String(overview.unassignedRepos),
      icon: <Unlink className="h-4 w-4 text-amber-500" />,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Fila de totales: de un vistazo, cuánto del inventario sí se cobra. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {totales.map((t) => (
          <Card key={t.label}>
            <CardContent className="p-4">
              <div className="mb-1 flex items-center gap-2">
                {t.icon}
                <span className="text-xs text-muted-foreground">{t.label}</span>
              </div>
              <p className="text-lg font-bold">{t.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Un bloque por cliente con sus proyectos y, dentro, sus repos. */}
      {clients.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
            <Building2 className="h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium">Aún no hay clientes registrados.</p>
            <p className="text-xs text-muted-foreground">
              Da de alta un cliente para poder asignarle proyectos y empezar a cobrar sus repositorios.
            </p>
          </CardContent>
        </Card>
      ) : (
        clients.map((c) => {
          const propios = projects.filter((p) => p.clientId === c.id);
          const idsPropios = new Set(propios.map((p) => p.id));
          const reposDelCliente = repos.filter((r) => idsPropios.has(r.projectId));
          const currency = c.billing?.currency ?? settings.currency;
          // Subtotal mensual = suma de los precios efectivos de sus repos (sin
          // extras ni descuento: aquí solo se muestra el reparto de repos).
          const subtotal = reposDelCliente.reduce(
            (acc, r) => acc + resolveRepoPrice(r, c, settings).price,
            0,
          );

          return (
            <Card key={c.id}>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                  <h3 className="text-sm font-bold">{clientDisplayName(c)}</h3>
                  <span className="text-xs text-muted-foreground">
                    {plural(propios.length, "proyecto", "proyectos")} · {plural(reposDelCliente.length, "repo", "repos")}
                  </span>
                  <span className="ml-auto text-sm font-semibold">
                    {formatMoney(subtotal, currency)}
                    <span className="ml-1 text-[11px] font-normal text-muted-foreground">/ mes en repos</span>
                  </span>
                </div>

                <div className="mt-3 space-y-2">
                  {propios.length === 0 ? (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <FolderGit2 className="h-3.5 w-3.5" /> Este cliente todavía no tiene proyectos asignados.
                    </p>
                  ) : (
                    propios.map((p) => (
                      <ProjectBlock
                        key={p.id}
                        project={p}
                        repos={repos}
                        clients={clients}
                        client={c}
                        settings={settings}
                        currency={currency}
                        grupos={grupos}
                        busy={busy}
                        run={run}
                        onError={setError}
                        refreshProjects={refreshProjects}
                        refreshRepos={refreshRepos}
                      />
                    ))
                  )}
                </div>

                {/* Crear un proyecto ya dentro de este cliente (sin reasignar después). */}
                <div className="mt-2">
                  {nuevoPara === c.id ? (
                    <div className="flex gap-2">
                      <input
                        autoFocus
                        className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
                        placeholder={`Nuevo proyecto de ${clientDisplayName(c)}`}
                        value={nuevoNombre}
                        onChange={(e) => setNuevoNombre(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") crearEnCliente(c.id);
                          if (e.key === "Escape") { setNuevoNombre(""); setNuevoPara(null); }
                        }}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!nuevoNombre.trim() || busy === `nuevo-${c.id}`}
                        onClick={() => crearEnCliente(c.id)}
                      >
                        {busy === `nuevo-${c.id}`
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Plus className="h-4 w-4" />}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setNuevoNombre(""); setNuevoPara(null); }}
                      >
                        Cancelar
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => { setNuevoNombre(""); setNuevoPara(c.id); }}
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" /> Nuevo proyecto en este cliente
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })
      )}

      {/* Huérfanos: se destacan porque son dinero que nadie está pagando. */}
      {huerfanos.length > 0 && (
        <Card className="border-amber-300 bg-amber-50/40 dark:border-amber-700/60 dark:bg-amber-950/10">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
              <h3 className="text-sm font-bold text-amber-800 dark:text-amber-300">Sin cliente asignado</h3>
              <span className="text-xs text-amber-700/80 dark:text-amber-400/80">
                {plural(huerfanos.length, "proyecto", "proyectos")} · {plural(reposSinCliente.length, "repo", "repos")}
              </span>
            </div>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              Estos proyectos no se le cobran a nadie: sus repositorios quedan fuera del cobro mensual
              hasta que les asignes un cliente. Incluye los que apuntaban a un cliente que ya se eliminó.
            </p>

            <div className="mt-3 space-y-2">
              {huerfanos.map((p) => (
                <ProjectBlock
                  key={p.id}
                  project={p}
                  repos={repos}
                  clients={clients}
                  client={undefined}
                  settings={settings}
                  currency={settings.currency}
                  grupos={grupos}
                  busy={busy}
                  run={run}
                  onError={setError}
                  refreshProjects={refreshProjects}
                  refreshRepos={refreshRepos}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Nada dado de alta todavía: ni clientes ni proyectos. */}
      {clients.length > 0 && projects.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
            <FolderGit2 className="h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium">Todavía no hay proyectos.</p>
            <p className="text-xs text-muted-foreground">
              Crea el primero dentro de un cliente para empezar a repartir los repositorios.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
