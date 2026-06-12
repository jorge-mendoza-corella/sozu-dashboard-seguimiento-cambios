import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Users, GitCommit, GitBranch, Phone, ExternalLink, X, Loader2, Check,
  GitPullRequest, Layers, LayoutGrid, Settings2, ChevronDown, ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { fetchContributors, type Contributor } from "@/lib/github";
import { getAllContributorPhones, saveContributorPhone } from "@/lib/firestoreContributors";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ContributorsAnalytics } from "@/components/analytics/ContributorsAnalytics";
import { CostsAnalytics, fmtUsd, fmtTokens, shortModel, modelColor } from "@/components/analytics/CostsAnalytics";
import { GroupsModal } from "@/components/contributors/GroupsModal";
import { useRepos } from "@/hooks/useProjectsRepos";
import { useCommitActivity } from "@/hooks/useCommitActivity";
import { useContributorGroups } from "@/hooks/useContributorGroups";
import { useAnthropicCosts } from "@/hooks/useAnthropicCosts";
import type { ContributorCostEntry } from "@/lib/anthropicAdmin";
import { BAR_COLORS } from "@/lib/colors";

const TEL_REGEX = /^\d{10}$/;

export interface RepoMetrics30 {
  repo: string;
  dev: number;
  main: number;
  prs: number;
}

function DetailModal({
  contributor,
  telefonoActual,
  metrics30,
  costEntry,
  onClose,
  onSaved,
}: {
  contributor: Contributor;
  telefonoActual?: string;
  metrics30: RepoMetrics30[] | null; // null = aún cargando
  costEntry?: ContributorCostEntry | null;
  onClose: () => void;
  onSaved: (login: string, telefono: string) => void;
}) {
  const { appUser } = useAuth();
  const [telefono, setTelefono] = useState(telefonoActual ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);

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
              <p className="text-sm text-muted-foreground">
                {contributor.totalContributions.toLocaleString()} commits ·{" "}
                {contributor.repos.length} repos
              </p>
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

          {/* Costos Claude (últimos 30 días) */}
          {costEntry !== undefined && (
            <div className="mt-6 border-t pt-4">
              <p className="text-sm font-medium flex items-center gap-2 mb-2">
                <span className="text-emerald-600">$</span> Costos Claude · últimos 30 días
              </p>
              {costEntry === null ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando costos…
                </p>
              ) : !costEntry ? (
                <p className="text-xs text-muted-foreground">Sin datos de costo en los últimos 30 días.</p>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-4 text-sm">
                    <span className="font-bold text-emerald-600">{fmtUsd(costEntry.totalUsd)}</span>
                    <span className="text-xs text-muted-foreground">{fmtUsd(costEntry.totalUsd / 30)}/día</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="pb-1.5 pr-3 font-medium">Modelo</th>
                          <th className="pb-1.5 px-2 text-right font-medium">Input</th>
                          <th className="pb-1.5 px-2 text-right font-medium">Output</th>
                          <th className="pb-1.5 pl-2 text-right font-medium">Costo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {costEntry.byModel.map((m) => (
                          <tr key={m.model} className="border-b last:border-0">
                            <td className="py-1.5 pr-3">
                              <span className="inline-flex items-center gap-1.5">
                                <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: modelColor(m.model) }} />
                                {shortModel(m.model)}
                              </span>
                            </td>
                            <td className="py-1.5 px-2 text-right font-mono text-muted-foreground">{fmtTokens(m.inputTokens)}</td>
                            <td className="py-1.5 px-2 text-right font-mono text-muted-foreground">{fmtTokens(m.outputTokens)}</td>
                            <td className="py-1.5 pl-2 text-right font-mono font-semibold">{fmtUsd(m.usd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Teléfono WhatsApp */}
          <div className="mt-6 border-t pt-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Phone className="h-4 w-4" /> Teléfono de WhatsApp
            </label>
            <div className="mt-2 flex gap-2">
              <input
                inputMode="numeric"
                maxLength={10}
                className="flex-1 px-3 py-2 text-sm border rounded-md bg-background"
                placeholder="10 dígitos"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
              />
              <Button onClick={handleSave} disabled={saving} size="sm">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : ok ? <Check className="h-4 w-4" /> : "Guardar"}
              </Button>
            </div>
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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleGroupExpand = (id: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const { data: repos = [] } = useRepos();
  const repoRefs = useMemo(() => repos.map((r) => ({ owner: r.owner, repo: r.repo, label: r.label })), [repos]);
  const { data: activity } = useCommitActivity(repoRefs, 30);
  const { data: groups = [] } = useContributorGroups();
  const { data: costsData, isLoading: costsLoading } = useAnthropicCosts(30);

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

  // Costo del contribuidor seleccionado (últimos 30 días)
  const selectedCostEntry = useMemo<ContributorCostEntry | null | undefined>(() => {
    if (costsLoading || !costsData) return null; // cargando o sin datos
    const allEntries = [...costsData.byContributor, ...costsData.unmapped];
    return allEntries.find((e) => e.githubLogin === selected?.login) ?? null;
  }, [costsData, costsLoading, selected]);

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
            Contribuidores de GitHub agregados de todos los repositorios monitoreados
          </p>
        </div>
      </div>

      <Tabs defaultValue="lista">
        <TabsList>
          <TabsTrigger value="lista">Contribuidores</TabsTrigger>
          <TabsTrigger value="analitica">Analítica ejecutiva</TabsTrigger>
          <TabsTrigger value="costos">Costos Claude</TabsTrigger>
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
              {/* Toolbar: vista + gestión de grupos */}
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <Button variant={view === "flat" ? "default" : "outline"} size="sm" onClick={() => setView("flat")}>
                  <LayoutGrid className="mr-1.5 h-4 w-4" /> Individual
                </Button>
                <Button variant={view === "grouped" ? "default" : "outline"} size="sm" onClick={() => setView("grouped")}>
                  <Layers className="mr-1.5 h-4 w-4" /> Agrupado
                </Button>
                <Button variant="outline" size="sm" className="ml-auto" onClick={() => setShowGroups(true)}>
                  <Settings2 className="mr-1.5 h-4 w-4" /> Gestionar grupos
                </Button>
              </div>

              {view === "grouped" && (
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

              {view === "flat" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {contributors.map((c) => (
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

        <TabsContent value="analitica">
          <ContributorsAnalytics />
        </TabsContent>

        <TabsContent value="costos">
          <CostsAnalytics />
        </TabsContent>
      </Tabs>

      {selected && (
        <DetailModal
          contributor={selected}
          telefonoActual={phones[selected.login]}
          metrics30={metrics30}
          costEntry={selectedCostEntry}
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
