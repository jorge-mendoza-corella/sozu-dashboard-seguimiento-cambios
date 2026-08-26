import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Users, GitCommit, GitBranch, Phone, ExternalLink, X, Loader2, Check,
  GitPullRequest, Layers, LayoutGrid, Settings2, ChevronDown, ChevronUp, Mail, Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { fetchContributors, getGithubDisplayName, type Contributor } from "@/lib/github";
import { useDirectorio } from "@/hooks/useAvisos";
import { getAllContributorPhones, saveContributorPhone } from "@/lib/firestoreContributors";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ContributorsAnalytics } from "@/components/analytics/ContributorsAnalytics";
import { GroupsModal } from "@/components/contributors/GroupsModal";
import { useRepos } from "@/hooks/useProjectsRepos";
import { useCommitActivity } from "@/hooks/useCommitActivity";
import { useContributorGroups } from "@/hooks/useContributorGroups";
import { useClients, useClientScope } from "@/hooks/useClients";
import { clientDisplayName } from "@/lib/firestoreClients";
import { isRootAdmin } from "@/lib/firestoreUsers";
import { BAR_COLORS } from "@/lib/colors";

const TEL_REGEX = /^\d{10}$/;

/** Color de los proyectos sin empresa asignada (el mismo de `empresas.ts`). */
const COLOR_SIN_EMPRESA = "#94a3b8";

/** Empresa dueña de alguno de los repos en los que aparece un contribuidor. */
interface EmpresaTag {
  id: string;
  nombre: string;
  color: string;
}

export interface RepoMetrics30 {
  repo: string;
  dev: number;
  main: number;
  prs: number;
}

/** Punto de color + nombre de la empresa, como en el selector de empresas. */
function EmpresaChip({ empresa }: { empresa: EmpresaTag }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground"
      title={`Aparece en repos de ${empresa.nombre}`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: empresa.color }} />
      {empresa.nombre}
    </span>
  );
}

function DetailModal({
  contributor,
  telefonoActual,
  metrics30,
  empresas,
  onClose,
  onSaved,
}: {
  contributor: Contributor;
  telefonoActual?: string;
  metrics30: RepoMetrics30[] | null; // null = aún cargando
  /** Empresas del contribuidor; vacío cuando el usuario solo ve una. */
  empresas: EmpresaTag[];
  onClose: () => void;
  onSaved: (login: string, telefono: string) => void;
}) {
  const { appUser } = useAuth();
  // Quién es esta cuenta, más allá del login. Un `@t-lara` o un
  // `@oscarcabral-investimento` no dicen a quién estás mirando, y esta pantalla
  // se usa justo para decidir a quién le llegan los avisos.
  const directorio = useDirectorio(appUser);
  const ficha = directorio.get(contributor.login);
  // El nombre real vive en el perfil de GitHub, y eso es UNA petición por
  // contribuidor: se pide solo al abrir su ficha, no al pintar la lista de
  // treinta tarjetas. La cuota de la API es una sola para todo el dashboard y ya
  // se agotó una vez por pedir de más.
  const [nombreGitHub, setNombreGitHub] = useState<string | null>(null);
  useEffect(() => {
    let vivo = true;
    getGithubDisplayName(contributor.login)
      .then((n) => { if (vivo) setNombreGitHub(n); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [contributor.login]);

  const [telefono, setTelefono] = useState(telefonoActual ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);

  // Las reglas de Firestore solo dejan ESCRIBIR `contributors/{login}` al root.
  // Un administrador de empresa puede leer el teléfono, pero si lo dejáramos
  // intentar guardarlo la única respuesta sería un permission-denied.
  const puedeEditarTelefono = isRootAdmin(appUser);

  const maxCommits = Math.max(...contributor.repos.map((r) => r.contributions), 1);

  const handleSave = async () => {
    const tel = telefono.trim();
    if (!TEL_REGEX.test(tel)) {
      setError("El teléfono debe tener exactamente 10 dígitos");
      return;
    }
    setError("");
    setSaving(true);
    try {
      await saveContributorPhone(contributor.login, tel, appUser?.email ?? "desconocido");
      onSaved(contributor.login, tel);
      setOk(true);
      setTimeout(() => setOk(false), 2000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-6">
          {/* Header */}
          <div className="flex items-start gap-4">
            <img
              src={contributor.avatarUrl}
              alt={contributor.login}
              className="h-14 w-14 rounded-full border"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold truncate">{contributor.login}</h2>
                <a
                  href={contributor.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
              {nombreGitHub && (
                <p className="text-sm font-medium">{nombreGitHub}</p>
              )}
              {ficha?.email && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Mail className="h-3 w-3 shrink-0" />
                  <a href={`mailto:${ficha.email}`} className="underline decoration-dotted">
                    {ficha.email}
                  </a>
                  {ficha.rol && <span className="opacity-70">· {ficha.rol}</span>}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                {contributor.totalContributions.toLocaleString()} commits ·{" "}
                {contributor.repos.length} repos
              </p>
              {empresas.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {empresas.map((e) => (
                    <EmpresaChip key={e.id || "sin-empresa"} empresa={e} />
                  ))}
                </div>
              )}
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Gráfica de barras (CSS) */}
          <div className="mt-6 space-y-2">
            <p className="text-sm font-medium">Histórico · commits en rama main (todo el tiempo)</p>
            <p className="text-[11px] text-muted-foreground">
              Conteo total desde el inicio del repo, solo rama main (fuente: GitHub, con caché).
              La tabla de abajo es la ventana de 30 días e incluye dev y PRs — por eso difieren.
            </p>
            {contributor.repos.map((r, i) => (
              <div key={r.repo} className="flex items-center gap-3">
                <span className="w-44 shrink-0 truncate text-xs text-muted-foreground" title={r.repo}>
                  {r.repo}
                </span>
                <div className="flex-1 h-5 rounded bg-muted overflow-hidden">
                  <div
                    className="h-full rounded flex items-center justify-end pr-2 text-[10px] font-medium text-white"
                    style={{
                      width: `${Math.max((r.contributions / maxCommits) * 100, 8)}%`,
                      backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
                    }}
                  >
                    {r.contributions.toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Actividad 30 días: dev / main / PRs por repo */}
          <div className="mt-6 border-t pt-4">
            <p className="text-sm font-medium">Últimos 30 días · dev / main / PRs</p>
            {metrics30 === null ? (
              <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Calculando actividad…
              </p>
            ) : metrics30.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">Sin actividad en los últimos 30 días.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-1.5 pr-2 font-medium">Repositorio</th>
                      <th className="py-1.5 px-2 text-right font-medium">
                        <span className="inline-flex items-center gap-1"><GitBranch className="h-3 w-3 text-sky-500" />dev</span>
                      </th>
                      <th className="py-1.5 px-2 text-right font-medium">
                        <span className="inline-flex items-center gap-1"><GitCommit className="h-3 w-3 text-indigo-500" />main</span>
                      </th>
                      <th className="py-1.5 pl-2 text-right font-medium">
                        <span className="inline-flex items-center gap-1"><GitPullRequest className="h-3 w-3 text-amber-500" />PRs</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics30.map((m) => (
                      <tr key={m.repo} className="border-b last:border-0">
                        <td className="py-1.5 pr-2 truncate max-w-[180px]" title={m.repo}>{m.repo}</td>
                        <td className="py-1.5 px-2 text-right font-mono">{m.dev}</td>
                        <td className="py-1.5 px-2 text-right font-mono">{m.main}</td>
                        <td className="py-1.5 pl-2 text-right font-mono">{m.prs}</td>
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td className="py-1.5 pr-2">Total</td>
                      <td className="py-1.5 px-2 text-right font-mono">{metrics30.reduce((s, m) => s + m.dev, 0)}</td>
                      <td className="py-1.5 px-2 text-right font-mono">{metrics30.reduce((s, m) => s + m.main, 0)}</td>
                      <td className="py-1.5 pl-2 text-right font-mono">{metrics30.reduce((s, m) => s + m.prs, 0)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Teléfono WhatsApp */}
          <div className="mt-6 border-t pt-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Phone className="h-4 w-4" /> Teléfono de WhatsApp
            </label>
            <div className="mt-2 flex gap-2">
              <input
                inputMode="numeric"
                maxLength={10}
                disabled={!puedeEditarTelefono}
                className="flex-1 px-3 py-2 text-sm border rounded-md bg-background disabled:cursor-not-allowed disabled:opacity-60"
                placeholder={puedeEditarTelefono ? "10 dígitos" : "Sin teléfono registrado"}
                value={telefono}
                onChange={(e) => setTelefono(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
              />
              <Button onClick={handleSave} disabled={saving || !puedeEditarTelefono} size="sm">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : ok ? <Check className="h-4 w-4" /> : "Guardar"}
              </Button>
            </div>
            {!puedeEditarTelefono && (
              <p className="mt-2 text-xs text-muted-foreground">
                El teléfono lo actualiza el administrador global.
              </p>
            )}
            {error && <p className="text-xs text-destructive mt-2">{error}</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function ContributorsPage() {
  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Contributor | null>(null);
  const [view, setView] = useState<"flat" | "grouped">("flat");
  const [showGroups, setShowGroups] = useState(false);
  const [filtro, setFiltro] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleGroupExpand = (id: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const { appUser } = useAuth();
  // Correo y rol por cuenta de GitHub: alimentan el buscador y la ficha.
  const directorio = useDirectorio(appUser);
  const { esAdminGlobal, visibleProjects, visibleProjectIds, repoIds } = useClientScope(appUser);
  const { data: clients = [] } = useClients(appUser);
  const { data: allRepos = [] } = useRepos();

  // Repos que este usuario tiene derecho a ver. Acotar AQUÍ es lo que acota la
  // pantalla entera: de estos repos salen los contribuidores, la actividad de
  // 30 días y los logins que se ofrecen para agrupar. El admin global sigue
  // viendo todos, tal cual antes.
  const repos = useMemo(() => {
    if (esAdminGlobal) return allRepos;
    const deSusProyectos = allRepos.filter((r) => visibleProjectIds.has(r.projectId));
    return repoIds ? deSusProyectos.filter((r) => repoIds.has(r.id)) : deSusProyectos;
  }, [allRepos, esAdminGlobal, visibleProjectIds, repoIds]);

  const repoRefs = useMemo(() => repos.map((r) => ({ owner: r.owner, repo: r.repo, label: r.label })), [repos]);
  const { data: activity } = useCommitActivity(repoRefs, 30);
  const { data: groups = [] } = useContributorGroups();

  // Los grupos y la analítica ejecutiva se calculan sobre TODOS los repos del
  // servicio, así que solo tienen sentido para el admin global. Para un
  // administrador de empresa se esconden en vez de mostrarle números ajenos.
  const verHerramientasGlobales = esAdminGlobal;
  // Sin la barra de vistas no hay forma de cambiarla: la lista se queda plana.
  const vista = verHerramientasGlobales ? view : "flat";

  // Empresa(s) dueñas de cada repo, por LABEL: es lo que guarda `Contributor`
  // (no el id del doc), y es el puente contribuidor → repo → proyecto → empresa.
  const empresasPorRepoLabel = useMemo(() => {
    const empresaDelProyecto = new Map(visibleProjects.map((p) => [p.id, p.clientId ?? ""]));
    const m = new Map<string, Set<string>>();
    for (const r of repos) {
      const empresa = empresaDelProyecto.get(r.projectId);
      if (empresa === undefined) continue; // repo de un proyecto que no ve
      const set = m.get(r.label) ?? new Set<string>();
      set.add(empresa);
      m.set(r.label, set);
    }
    return m;
  }, [repos, visibleProjects]);

  // Con una sola empresa a la vista, etiquetarla en cada fila sería repetir lo
  // mismo tantas veces como contribuidores haya.
  const mostrarEmpresas = useMemo(() => {
    const ids = new Set<string>();
    for (const set of empresasPorRepoLabel.values()) for (const id of set) ids.add(id);
    return ids.size > 1;
  }, [empresasPorRepoLabel]);

  const empresaPorId = useMemo(
    () => new Map(clients.map((c) => [c.id, { nombre: clientDisplayName(c), color: c.color }])),
    [clients],
  );

  /** Empresas en cuyos repos aparece ese contribuidor. */
  const empresasDe = useCallback(
    (c: Contributor): EmpresaTag[] => {
      if (!mostrarEmpresas) return [];
      const ids = new Set<string>();
      for (const r of c.repos) for (const id of empresasPorRepoLabel.get(r.repo) ?? []) ids.add(id);
      return [...ids]
        .map((id) => ({
          id,
          nombre: empresaPorId.get(id)?.nombre ?? "Sin empresa",
          color: empresaPorId.get(id)?.color ?? COLOR_SIN_EMPRESA,
        }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre));
    },
    [mostrarEmpresas, empresasPorRepoLabel, empresaPorId],
  );

  /**
   * Los contribuidores que pasan el buscador.
   *
   * El nombre de GitHub no se busca aquí a propósito: traerlo costaría una
   * petición por persona y la cuota de la API es una sola para todo el
   * dashboard —ya se agotó una vez—. Se busca por lo que ya está en memoria:
   * cuenta, correo y empresa. El nombre real se ve al abrir la ficha.
   */
  const visibles = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return contributors;
    return contributors.filter((c) =>
      c.login.toLowerCase().includes(q)
      || (directorio.get(c.login)?.email ?? "").toLowerCase().includes(q)
      || empresasDe(c).some((e) => e.nombre.toLowerCase().includes(q)),
    );
  }, [contributors, filtro, directorio, empresasDe]);


  // Métricas 30d (dev/main/PRs por repo) del contribuidor seleccionado.
  const metrics30 = useMemo<RepoMetrics30[] | null>(() => {
    if (!selected) return null;
    if (!activity) return null;
    const map = new Map<string, RepoMetrics30>();
    const get = (repo: string) => {
      let e = map.get(repo);
      if (!e) {
        e = { repo, dev: 0, main: 0, prs: 0 };
        map.set(repo, e);
      }
      return e;
    };
    for (const c of activity.commits) {
      if (c.login !== selected.login) continue;
      const e = get(c.repo);
      if (c.inDev) e.dev += 1;
      if (c.inMain) e.main += 1;
    }
    for (const p of activity.prs) {
      if (p.login !== selected.login) continue;
      get(p.repo).prs += 1;
    }
    return [...map.values()].sort((a, b) => b.dev + b.main + b.prs - (a.dev + a.main + a.prs));
  }, [activity, selected]);

  // login -> grupos a los que pertenece (para chips en las cards)
  const groupsByLogin = useMemo(() => {
    const m = new Map<string, { name: string; color: string }[]>();
    for (const g of groups) {
      for (const member of g.members) {
        if (!m.has(member)) m.set(member, []);
        m.get(member)!.push({ name: g.name, color: g.color });
      }
    }
    return m;
  }, [groups]);

  const load = useCallback(async () => {
    if (repoRefs.length === 0) {
      setContributors([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [contribs, phoneMap] = await Promise.all([
        fetchContributors(repoRefs),
        getAllContributorPhones().catch(() => ({})),
      ]);
      setContributors(contribs);
      setPhones(phoneMap);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al cargar contribuidores");
    } finally {
      setLoading(false);
    }
  }, [repoRefs]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSaved = (login: string, telefono: string) => {
    setPhones((prev) => ({ ...prev, [login]: telefono }));
  };

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center gap-2">
        <GitBranch className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Contribuidores</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {esAdminGlobal
              ? "Contribuidores de GitHub agregados de todos los repositorios monitoreados"
              : "Contribuidores de GitHub que participan en los repositorios de tus empresas"}
          </p>
        </div>
      </div>

      <Tabs defaultValue="lista">
        <TabsList>
          <TabsTrigger value="lista">Contribuidores</TabsTrigger>
          {verHerramientasGlobales && <TabsTrigger value="analitica">Analítica ejecutiva</TabsTrigger>}
        </TabsList>

        <TabsContent value="lista">
          {error && (
            <Card className="mb-6 border-destructive">
              <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
            </Card>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin mr-2" /> Cargando contribuidores…
            </div>
          ) : (
            <>
              {/* Buscador. Con treinta y pico de tarjetas en una grilla de tres
                  columnas, encontrar a alguien era pasar la vista por todas. Se
                  busca por login, nombre de GitHub, correo y empresa: son las
                  cuatro cosas con las que uno se acuerda de una persona, y el
                  login rara vez es la primera. */}
              <div className="relative mb-4 w-full sm:w-96">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="h-9 w-full rounded-md border bg-background pl-9 pr-9 text-sm"
                  placeholder="Buscar por cuenta, nombre, correo o empresa"
                  value={filtro}
                  onChange={(e) => setFiltro(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") setFiltro(""); }}
                />
                {filtro && (
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    title="Limpiar la búsqueda"
                    onClick={() => setFiltro("")}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              {/* Toolbar: vista + gestión de grupos (solo admin global) */}
              {verHerramientasGlobales && (
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <Button variant={vista === "flat" ? "default" : "outline"} size="sm" onClick={() => setView("flat")}>
                    <LayoutGrid className="mr-1.5 h-4 w-4" /> Individual
                  </Button>
                  <Button variant={vista === "grouped" ? "default" : "outline"} size="sm" onClick={() => setView("grouped")}>
                    <Layers className="mr-1.5 h-4 w-4" /> Agrupado
                  </Button>
                  <Button variant="outline" size="sm" className="ml-auto" onClick={() => setShowGroups(true)}>
                    <Settings2 className="mr-1.5 h-4 w-4" /> Gestionar grupos
                  </Button>
                </div>
              )}

              {vista === "grouped" && (
                <div className="mb-6 space-y-4">
                  {groups.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No hay grupos. Crea uno con "Gestionar grupos".
                    </p>
                  )}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {groups.map((g) => {
                      const members = contributors.filter((c) => g.members.includes(c.login));
                      const total = members.reduce((s, m) => s + m.totalContributions, 0);
                      const repoSet = new Set(members.flatMap((m) => m.repos.map((r) => r.repo)));
                      const isOpen = expandedGroups.has(g.id);
                      return (
                        <Card key={g.id} className="border-2" style={{ borderColor: g.color }}>
                          <CardContent className="p-4">
                            <button
                              className="flex w-full items-center gap-2 text-left"
                              onClick={() => toggleGroupExpand(g.id)}
                              title={isOpen ? "Contraer" : "Ver integrantes"}
                            >
                              <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: g.color }} />
                              <p className="flex-1 truncate font-semibold">{g.name}</p>
                              <Badge variant="secondary" className="gap-1">
                                <GitCommit className="h-3 w-3" />
                                {total.toLocaleString()}
                              </Badge>
                              {isOpen ? (
                                <ChevronUp className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                <ChevronDown className="h-4 w-4 text-muted-foreground" />
                              )}
                            </button>
                            <div className="mt-1 flex items-center gap-2">
                              <p className="text-xs text-muted-foreground">
                                {members.length} miembro{members.length === 1 ? "" : "s"} · {repoSet.size} repos
                              </p>
                              {!isOpen && (
                                <div className="flex -space-x-1.5">
                                  {members.slice(0, 6).map((m) => (
                                    <img
                                      key={m.login}
                                      src={m.avatarUrl}
                                      alt={m.login}
                                      title={m.login}
                                      className="h-5 w-5 rounded-full border-2 border-background"
                                    />
                                  ))}
                                  {members.length > 6 && (
                                    <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-background bg-muted text-[9px] text-muted-foreground">
                                      +{members.length - 6}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                            {isOpen && (
                              <div className="mt-3 space-y-1.5">
                                {members.map((m) => (
                                  <button
                                    key={m.login}
                                    onClick={() => setSelected(m)}
                                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted"
                                  >
                                    <img src={m.avatarUrl} alt={m.login} className="h-6 w-6 rounded-full border" />
                                    <span className="flex-1 truncate text-xs font-medium">{m.login}</span>
                                    <span className="font-mono text-[11px] text-muted-foreground">
                                      {m.totalContributions.toLocaleString()}
                                    </span>
                                  </button>
                                ))}
                                {members.length === 0 && (
                                  <p className="text-xs text-muted-foreground">Sin miembros con actividad.</p>
                                )}
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                  {(() => {
                    const groupedLogins = new Set(groups.flatMap((g) => g.members));
                    const ungrouped = contributors.filter((c) => !groupedLogins.has(c.login));
                    if (ungrouped.length === 0) return null;
                    return (
                      <>
                        <p className="text-sm font-semibold text-muted-foreground">
                          Sin grupo ({ungrouped.length})
                        </p>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                          {ungrouped.map((c) => (
                            <Card
                              key={c.login}
                              className="cursor-pointer transition-shadow hover:shadow-md"
                              onClick={() => setSelected(c)}
                            >
                              <CardContent className="flex items-center gap-4 p-4">
                                <img src={c.avatarUrl} alt={c.login} className="h-12 w-12 rounded-full border" />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate font-semibold">{c.login}</p>
                                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                                    <span className="inline-flex items-center gap-1">
                                      <GitCommit className="h-3 w-3" />
                                      {c.totalContributions.toLocaleString()} commits
                                    </span>
                                    <span className="inline-flex items-center gap-1">
                                      <Users className="h-3 w-3" />
                                      {c.repos.length} repos
                                    </span>
                                  </div>
                                  {empresasDe(c).length > 0 && (
                                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                      {empresasDe(c).map((e) => (
                                        <EmpresaChip key={e.id || "sin-empresa"} empresa={e} />
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </CardContent>
                            </Card>
                          ))}
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}

              {/* Al acotar por empresa la lista puede quedar vacía; decirlo es
                  mejor que dejar la pantalla en blanco sin explicación. */}
              {!esAdminGlobal && contributors.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No hay contribuidores en los repositorios de tus empresas.
                </p>
              )}

              {vista === "flat" && visibles.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Nadie coincide con “{filtro.trim()}”.
                </p>
              )}

              {vista === "flat" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {visibles.map((c) => (
                    <Card
                      key={c.login}
                      className="cursor-pointer transition-shadow hover:shadow-md"
                      onClick={() => setSelected(c)}
                    >
                      <CardContent className="flex items-center gap-4 p-4">
                        <img src={c.avatarUrl} alt={c.login} className="h-12 w-12 rounded-full border" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold">{c.login}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <GitCommit className="h-3 w-3" />
                              {c.totalContributions.toLocaleString()} commits
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Users className="h-3 w-3" />
                              {c.repos.length} repos
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {phones[c.login] && (
                              <Badge variant="secondary" className="gap-1">
                                <Phone className="h-3 w-3" />
                                {phones[c.login]}
                              </Badge>
                            )}
                            {empresasDe(c).map((e) => (
                              <EmpresaChip key={e.id || "sin-empresa"} empresa={e} />
                            ))}
                            {(groupsByLogin.get(c.login) ?? []).map((g) => (
                              <span
                                key={g.name}
                                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]"
                                style={{ borderColor: g.color, color: g.color }}
                              >
                                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: g.color }} />
                                {g.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </>
          )}
        </TabsContent>

        {verHerramientasGlobales && (
          <TabsContent value="analitica">
            <ContributorsAnalytics />
          </TabsContent>
        )}

      </Tabs>

      {selected && (
        <DetailModal
          contributor={selected}
          telefonoActual={phones[selected.login]}
          metrics30={metrics30}
          empresas={empresasDe(selected)}
          onClose={() => setSelected(null)}
          onSaved={handleSaved}
        />
      )}

      {showGroups && (
        <GroupsModal
          logins={[...new Set([
            ...contributors.map((c) => c.login),
            // autores vistos en la actividad de 30 días (incluye commits sin cuenta GitHub vinculada,
            // p.ej. "Yorch Agente"), para poder agruparlos también
            ...(activity?.authors.map((a) => a.login) ?? []),
          ])].sort((a, b) => a.localeCompare(b))}
          onClose={() => setShowGroups(false)}
        />
      )}
    </div>
  );
}
