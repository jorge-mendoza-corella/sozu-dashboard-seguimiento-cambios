import { useMemo, useState } from "react";
import {
  Loader2, DollarSign, CalendarDays, TrendingUp, AlertTriangle,
  X, Check, Users as UsersIcon,
} from "lucide-react";
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement, BarElement,
  Tooltip, Legend, Filler, type ChartOptions,
} from "chart.js";
import { Line, Bar } from "react-chartjs-2";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import { useAuth } from "@/hooks/useAuth";
import { SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import { useAnthropicCosts } from "@/hooks/useAnthropicCosts";
import { type AnthropicOrgUser, type ContributorCostEntry } from "@/lib/anthropicAdmin";
import { setMapping, deleteMapping } from "@/lib/firestoreAnthropicMapping";
import { useQueryClient } from "@tanstack/react-query";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler);

const COLOR_COST = "#10b981";
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

const fmtDay = (date: string) => {
  const [, m, d] = date.split("-");
  return `${Number(d)} ${MESES[Number(m) - 1] ?? ""}`;
};

const fmtUsd = (n: number): string => {
  if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `<$0.001`;
};

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}K` : String(n);

const MODEL_COLORS: Record<string, string> = {
  opus:   "#6366f1",
  sonnet: "#0ea5e9",
  haiku:  "#f59e0b",
};

function modelColor(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus"))   return MODEL_COLORS.opus;
  if (lower.includes("haiku"))  return MODEL_COLORS.haiku;
  return MODEL_COLORS.sonnet;
}

function shortModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus-4"))    return "Opus 4";
  if (lower.includes("opus-3"))    return "Opus 3";
  if (lower.includes("sonnet-4"))  return "Sonnet 4";
  if (lower.includes("sonnet-3"))  return "Sonnet 3";
  if (lower.includes("haiku-4"))   return "Haiku 4";
  if (lower.includes("haiku-3"))   return "Haiku 3";
  return model.replace("claude-", "").slice(0, 20);
}

const ALL = "__all__";

const baseTooltip = {
  backgroundColor: "rgba(17,24,39,0.92)",
  padding: 10,
  cornerRadius: 8,
  titleFont: { size: 12, weight: "bold" as const },
  bodyFont: { size: 12 },
};

// ---- Mapping modal (root only) -------------------------------------------

function MappingModal({
  unmapped,
  orgUsers,
  initialMappings,
  onClose,
  updatedBy,
  onSaved,
}: {
  unmapped: ContributorCostEntry[];
  orgUsers: AnthropicOrgUser[];
  initialMappings: Record<string, string>;
  onClose: () => void;
  updatedBy: string;
  onSaved: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(initialMappings);
  const [existing, setExisting] = useState<Record<string, string>>(initialMappings);
  const [saving, setSaving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async (accountId: string, email: string | undefined) => {
    const login = (drafts[accountId] ?? "").trim();
    if (!login) return;
    setSaving(accountId);
    setSaveError(null);
    try {
      await setMapping(accountId, login, email, updatedBy);
      setExisting((prev) => ({ ...prev, [accountId]: login }));
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(`Error al guardar: ${msg}`);
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async (accountId: string) => {
    setDeleting(accountId);
    setSaveError(null);
    try {
      await deleteMapping(accountId);
      setExisting((prev) => { const n = { ...prev }; delete n[accountId]; return n; });
      setDrafts((prev) => { const n = { ...prev }; delete n[accountId]; return n; });
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(`Error al eliminar: ${msg}`);
    } finally {
      setDeleting(null);
    }
  };

  const allAccountIds = [
    ...unmapped.map((u) => u.accountId ?? u.githubLogin),
    ...Object.keys(existing).filter((id) => !unmapped.some((u) => (u.accountId ?? u.githubLogin) === id)),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <Card className="w-full max-w-xl max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold">Mapeo Anthropic → GitHub</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Asigna cada cuenta de Anthropic a su login de GitHub para ver costos por contribuidor.
              </p>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {saveError && (
            <div className="mb-3 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">
              {saveError}
            </div>
          )}

          {orgUsers.length === 0 ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Sin usuarios de Anthropic en caché todavía…
            </div>
          ) : (
            <div className="space-y-3">
              {(orgUsers ?? []).map((u) => {
                const accountId = u.id;
                const saved = existing[accountId];
                const draft = drafts[accountId] ?? "";
                const isBusy = saving === accountId || deleting === accountId;
                return (
                  <div key={accountId} className="flex items-center gap-2 rounded-md border p-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{u.email}</p>
                      <p className="text-[10px] text-muted-foreground">{u.name} · {u.role}</p>
                    </div>
                    <input
                      className="w-36 px-2 py-1 text-xs border rounded-md bg-background"
                      placeholder="github-login"
                      value={draft}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [accountId]: e.target.value }))}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                      disabled={isBusy || !draft.trim() || draft === saved}
                      onClick={() => handleSave(accountId, u.email)}
                    >
                      {saving === accountId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    </Button>
                    {saved && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-destructive hover:text-destructive"
                        disabled={isBusy}
                        onClick={() => handleDelete(accountId)}
                      >
                        {deleting === accountId ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                      </Button>
                    )}
                    {saved && (
                      <Badge variant="secondary" className="text-[10px] shrink-0">{saved}</Badge>
                    )}
                  </div>
                );
              })}
              {allAccountIds
                .filter((id) => !(orgUsers ?? []).some((u) => u.id === id))
                .map((accountId) => {
                  const entry = unmapped.find((u) => (u.accountId ?? u.githubLogin) === accountId);
                  const saved = existing[accountId];
                  const draft = drafts[accountId] ?? "";
                  const isBusy = saving === accountId || deleting === accountId;
                  return (
                    <div key={accountId} className="flex items-center gap-2 rounded-md border border-amber-200 p-2 bg-amber-50/50 dark:bg-amber-950/10">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate text-amber-700">{entry?.email || accountId}</p>
                        <p className="text-[10px] text-muted-foreground">Sin cuenta en org de Anthropic</p>
                      </div>
                      <input
                        className="w-36 px-2 py-1 text-xs border rounded-md bg-background"
                        placeholder="github-login"
                        value={draft}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [accountId]: e.target.value }))}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2"
                        disabled={isBusy || !draft.trim() || draft === saved}
                        onClick={() => handleSave(accountId, entry?.email)}
                      >
                        {saving === accountId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      </Button>
                      {saved && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-destructive hover:text-destructive"
                          disabled={isBusy}
                          onClick={() => handleDelete(accountId)}
                        >
                          {deleting === accountId ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                        </Button>
                      )}
                      {saved && <Badge variant="secondary" className="text-[10px] shrink-0">{saved}</Badge>}
                    </div>
                  );
                })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---- Main component -------------------------------------------------------

export function CostsAnalytics() {
  const { appUser } = useAuth();
  const isRoot = appUser?.email === SUPERUSER_EMAIL;
  const qc = useQueryClient();

  const [windowDays, setWindowDays] = useState(30);
  const [contributorKey, setContributorKey] = useState(ALL);
  const [showMappingModal, setShowMappingModal] = useState(false);

  const { data, isLoading, error } = useAnthropicCosts(windowDays);

  // ---- Loading / error ----------------------------------------------------

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-6 w-6 animate-spin" /> Cargando costos de Firestore…
      </div>
    );
  }

  if (error || !data) {
    const msg = error instanceof Error ? error.message : "Error al cargar costos";
    const isNoData = msg.includes("Sin datos");
    return (
      <Card className={isNoData ? "border-amber-300 bg-amber-50/40 dark:bg-amber-950/10" : "border-destructive"}>
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className={`h-5 w-5 shrink-0 mt-0.5 ${isNoData ? "text-amber-500" : "text-destructive"}`} />
            <div>
              <p className={`font-semibold text-sm ${isNoData ? "text-amber-800 dark:text-amber-300" : "text-destructive"}`}>
                {isNoData ? "Sync pendiente" : "Error"}
              </p>
              <p className="text-sm text-muted-foreground mt-1">{msg}</p>
              {isNoData && (
                <ol className="mt-3 text-sm space-y-1 text-muted-foreground list-decimal list-inside">
                  <li>Crear secret <code className="bg-muted rounded px-1 text-xs">DASHBOARD_ANTHROPIC_ADMIN_KEY</code> en GCP Secret Manager</li>
                  <li>En GitHub → Actions → <em>Sync Anthropic Costs → Firestore</em> → Run workflow</li>
                  <li>Volver aquí en ~30 segundos</li>
                </ol>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ---- Filtered view -------------------------------------------------------

  const allContributors = [...data.byContributor, ...data.unmapped];
  const selectedEntry = contributorKey === ALL
    ? null
    : allContributors.find((e) => e.githubLogin === contributorKey) ?? null;

  const displayContributors = contributorKey === ALL ? allContributors : (selectedEntry ? [selectedEntry] : []);

  const totalDisplayed = displayContributors.reduce((s, e) => s + e.totalUsd, 0);
  const avgPerDay = totalDisplayed / windowDays;

  // Daily: filter by contributor if selected
  const daily = useMemo(() => {
    if (!selectedEntry) return data.daily;
    // We don't have per-day per-account breakdown in data.daily, show aggregate (limitation)
    return data.daily;
  }, [data.daily, selectedEntry]);

  // ---- Charts dataset -------------------------------------------------------

  const labels = daily.map((d) => fmtDay(d.date));

  const allModels = Array.from(
    new Set(data.daily.flatMap((d) => Object.keys(d.byModel)))
  );

  // Single total $ line when no contributor filter; stacked-ish when filtered (just total)
  const lineDatasets = allModels.length > 1
    ? allModels.map((model) => ({
        label: shortModel(model),
        data: daily.map((d) => +(d.byModel[model] ?? 0).toFixed(4)),
        borderColor: modelColor(model),
        backgroundColor: "transparent",
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderWidth: 2,
      }))
    : [{
        label: "Costo total",
        data: daily.map((d) => +d.totalUsd.toFixed(4)),
        borderColor: COLOR_COST,
        backgroundColor: (ctx: { chart: ChartJS }) => {
          const { ctx: c, chartArea } = ctx.chart;
          if (!chartArea) return "rgba(16,185,129,0.12)";
          const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          g.addColorStop(0, "rgba(16,185,129,0.25)");
          g.addColorStop(1, "rgba(16,185,129,0)");
          return g;
        },
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderWidth: 2,
      }];

  const lineOpts: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        display: allModels.length > 1,
        position: "top",
        labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 8, font: { size: 11 } },
      },
      tooltip: {
        ...baseTooltip,
        callbacks: {
          title: (items) => fmtDay(daily[items[0].dataIndex]?.date ?? ""),
          label: (item) => ` ${item.dataset.label}: ${fmtUsd(Number(item.raw))}`,
        },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { size: 10 } } },
      y: {
        beginAtZero: true,
        ticks: { font: { size: 10 }, callback: (v) => `$${Number(v).toFixed(2)}` },
        grid: { color: "rgba(148,163,184,0.15)" },
      },
    },
  };

  // Bar chart by contributor
  const barLabels = displayContributors.map((e) => e.githubLogin);
  const barData = {
    labels: barLabels,
    datasets: [{
      label: "Costo USD",
      data: displayContributors.map((e) => +e.totalUsd.toFixed(4)),
      backgroundColor: COLOR_COST,
      borderRadius: 4,
      maxBarThickness: 18,
    }],
  };

  const barOpts: ChartOptions<"bar"> = {
    indexAxis: "y",
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        ...baseTooltip,
        callbacks: {
          label: (item) => ` ${fmtUsd(Number(item.raw))} · ${fmtUsd(Number(item.raw) / windowDays)}/día`,
        },
      },
    },
    scales: {
      x: {
        beginAtZero: true,
        ticks: { font: { size: 10 }, callback: (v) => `$${Number(v).toFixed(2)}` },
        grid: { color: "rgba(148,163,184,0.15)" },
      },
      y: { grid: { display: false }, ticks: { font: { size: 11 } } },
    },
  };

  const top = displayContributors[0];
  const topModel = data.byModel[0];

  return (
    <div className="space-y-6">
      {/* Unmapped warning (root only) */}
      {isRoot && data.unmapped.length > 0 && (
        <Card className="border-amber-300 bg-amber-50/40 dark:bg-amber-950/10">
          <CardContent className="flex items-center gap-3 p-4">
            <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
            <p className="flex-1 text-sm text-amber-800 dark:text-amber-300">
              <strong>{data.unmapped.length}</strong> cuenta{data.unmapped.length > 1 ? "s" : ""} de Anthropic sin mapear a GitHub login. Costo no atribuido: <strong>{fmtUsd(data.unmapped.reduce((s,e) => s+e.totalUsd, 0))}</strong>.
            </p>
            <Button size="sm" variant="outline" className="shrink-0" onClick={() => setShowMappingModal(true)}>
              Configurar mapeo
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Filter bar */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <UsersIcon className="h-3.5 w-3.5" /> Contribuidor
            </label>
            <SelectNative className="w-56" value={contributorKey} onChange={(e) => setContributorKey(e.target.value)}>
              <option value={ALL}>Todos</option>
              {allContributors.map((e) => (
                <option key={e.githubLogin} value={e.githubLogin}>{e.githubLogin}</option>
              ))}
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" /> Ventana
            </label>
            <SelectNative className="w-32" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
              <option value={30}>30 días</option>
              <option value={60}>60 días</option>
              <option value={90}>90 días</option>
            </SelectNative>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground lg:inline">
              Total: <strong>{fmtUsd(data.totalUsd)}</strong> · {data.byContributor.length + data.unmapped.length} cuentas
            </span>
            {isRoot && (
              <Button size="sm" variant="outline" onClick={() => setShowMappingModal(true)}>
                Configurar mapeo
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          {
            label: `Total ${windowDays}d`,
            value: fmtUsd(totalDisplayed),
            sub: `${fmtUsd(avgPerDay)}/día`,
            icon: <DollarSign className="h-4 w-4 text-emerald-500" />,
          },
          {
            label: "Top spender",
            value: top?.githubLogin ?? "—",
            sub: top ? fmtUsd(top.totalUsd) : "",
            icon: <TrendingUp className="h-4 w-4 text-blue-500" />,
          },
          {
            label: "Modelo más usado ($)",
            value: topModel ? shortModel(topModel.model) : "—",
            sub: topModel ? fmtUsd(topModel.usd) : "",
            icon: <DollarSign className="h-4 w-4 text-indigo-500" />,
          },
          {
            label: "Tokens totales",
            value: fmtTokens(
              data.byModel.reduce((s, m) => s + m.inputTokens + m.outputTokens, 0)
            ),
            sub: "input + output",
            icon: <CalendarDays className="h-4 w-4 text-amber-500" />,
          },
        ].map((k) => (
          <Card key={k.label}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">{k.icon}<span className="text-xs text-muted-foreground">{k.label}</span></div>
              <p className="text-lg font-bold truncate">{k.value}</p>
              <p className="text-xs text-muted-foreground">{k.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Daily cost chart */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="h-5 w-5 text-emerald-500" />
            <h2 className="text-base font-semibold">Costo diario Claude</h2>
          </div>
          <div className="rounded-md bg-muted/60 p-3 text-sm text-muted-foreground mb-4">
            <strong className="text-foreground">{fmtUsd(totalDisplayed)}</strong> en {windowDays} días ·
            promedio <strong className="text-foreground">{fmtUsd(avgPerDay)}/día</strong>.
            {topModel && (
              <> Modelo con mayor gasto: <strong className="text-foreground">{shortModel(topModel.model)}</strong> ({fmtUsd(topModel.usd)}).</>
            )}
          </div>
          <div className="h-64">
            <Line data={{ labels, datasets: lineDatasets }} options={lineOpts} />
          </div>
        </CardContent>
      </Card>

      {/* Bar by contributor + detail table side by side */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* Bar chart */}
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-4">
              <UsersIcon className="h-5 w-5 text-emerald-500" />
              <h2 className="text-base font-semibold">Costo por contribuidor</h2>
            </div>
            <div style={{ height: Math.max(200, displayContributors.length * 48) }}>
              <Bar data={barData} options={barOpts} />
            </div>
          </CardContent>
        </Card>

        {/* Model breakdown */}
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-4">
              <DollarSign className="h-5 w-5 text-indigo-500" />
              <h2 className="text-base font-semibold">Desglose por modelo</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">Modelo</th>
                    <th className="pb-2 px-2 text-right font-medium">Input</th>
                    <th className="pb-2 px-2 text-right font-medium">Output</th>
                    <th className="pb-2 pl-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map((m) => (
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
          </CardContent>
        </Card>
      </div>

      {/* Contributor detail table */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <UsersIcon className="h-5 w-5 text-sky-500" />
            <h2 className="text-base font-semibold">Detalle por contribuidor</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Contribuidor</th>
                  <th className="pb-2 px-2 font-medium">Top modelo</th>
                  <th className="pb-2 px-2 text-right font-medium">Input</th>
                  <th className="pb-2 px-2 text-right font-medium">Output</th>
                  <th className="pb-2 px-2 text-right font-medium">$/día</th>
                  <th className="pb-2 pl-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {displayContributors.map((e) => {
                  const topM = e.byModel[0];
                  const totalInput = e.byModel.reduce((s, m) => s + m.inputTokens, 0);
                  const totalOutput = e.byModel.reduce((s, m) => s + m.outputTokens, 0);
                  return (
                    <tr key={e.githubLogin} className="border-b last:border-0">
                      <td className="py-1.5 pr-3">
                        <p className="font-medium truncate max-w-[140px]">{e.githubLogin}</p>
                        {e.email && e.email !== e.githubLogin && (
                          <p className="text-[10px] text-muted-foreground truncate max-w-[140px]">{e.email}</p>
                        )}
                      </td>
                      <td className="py-1.5 px-2">
                        {topM ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: modelColor(topM.model) }} />
                            {shortModel(topM.model)}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono text-muted-foreground">{fmtTokens(totalInput)}</td>
                      <td className="py-1.5 px-2 text-right font-mono text-muted-foreground">{fmtTokens(totalOutput)}</td>
                      <td className="py-1.5 px-2 text-right font-mono">{fmtUsd(e.totalUsd / windowDays)}</td>
                      <td className="py-1.5 pl-2 text-right font-mono font-semibold">{fmtUsd(e.totalUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {showMappingModal && (
        <MappingModal
          unmapped={data.unmapped}
          orgUsers={data.orgUsers}
          initialMappings={data.rawMappings ?? {}}
          onClose={() => setShowMappingModal(false)}
          updatedBy={appUser?.email ?? ""}
          onSaved={() => qc.invalidateQueries({ queryKey: ["anthropic-costs"] })}
        />
      )}
    </div>
  );
}

// Export helper for use in DetailModal (contributor cost summary)
export type { ContributorCostEntry };
export { fmtUsd, fmtTokens, shortModel, modelColor };
