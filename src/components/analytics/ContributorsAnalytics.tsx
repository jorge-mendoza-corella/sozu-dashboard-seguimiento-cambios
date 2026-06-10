import { useMemo, useRef, useState } from "react";
import {
  Loader2, CalendarDays, Trophy, FolderGit2, TrendingUp, FileDown, Users as UsersIcon,
  GitBranch, GitCommit, GitPullRequest,
} from "lucide-react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
} from "chart.js";
import { Line, Bar } from "react-chartjs-2";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { useCommitActivity } from "@/hooks/useCommitActivity";
import { useRepos } from "@/hooks/useProjectsRepos";
import { useContributorGroups, useHiddenContributors } from "@/hooks/useContributorGroups";
import { cn } from "@/lib/utils";
import type { CommitRecord, PRRecord } from "@/lib/github";
import { buildDailySeries, aggregateByRepo } from "@/lib/github";
import { exportAnalyticsPdf } from "@/lib/exportAnalyticsPdf";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler);

const TOP_ENTITIES = 8;
const COLOR_DEV = "#0ea5e9"; // sky
const COLOR_MAIN = "#6366f1"; // indigo
const COLOR_PRS = "#f59e0b"; // amber

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fmtDay = (date: string) => {
  const [, m, d] = date.split("-");
  return `${Number(d)} ${MESES[Number(m) - 1] ?? ""}`;
};

const ALL = "__all__";

/** Entidad medible en analítica: un grupo (suma de miembros) o un contribuidor individual. */
export interface Entity {
  key: string;
  label: string;
  logins: string[];
  isGroup: boolean;
}

export interface EntityMetrics {
  label: string;
  isGroup: boolean;
  dev: number;
  main: number;
  prs: number;
  total: number;
}

function aggregateByEntity(commits: CommitRecord[], prs: PRRecord[], entities: Entity[]): EntityMetrics[] {
  return entities
    .map((e) => {
      const set = new Set(e.logins);
      let dev = 0, main = 0, total = 0, prCount = 0;
      for (const c of commits) {
        if (!set.has(c.login)) continue;
        if (c.inDev) dev += 1;
        if (c.inMain) main += 1;
        total += 1;
      }
      for (const p of prs) if (set.has(p.login)) prCount += 1;
      return { label: e.label, isGroup: e.isGroup, dev, main, prs: prCount, total };
    })
    .filter((e) => e.total > 0 || e.prs > 0)
    .sort((a, b) => b.total - a.total || b.prs - a.prs);
}

function SectionCard({
  icon, title, summary, children,
}: {
  icon: React.ReactNode;
  title: string;
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>
        <div className="mt-2 rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">{summary}</div>
        <div className="mt-4">{children}</div>
      </CardContent>
    </Card>
  );
}

const baseTooltip = {
  backgroundColor: "rgba(17,24,39,0.92)",
  padding: 10,
  cornerRadius: 8,
  titleFont: { size: 12, weight: "bold" as const },
  bodyFont: { size: 12 },
  displayColors: true,
  boxWidth: 8,
  boxHeight: 8,
};

const legendOpts = {
  display: true,
  position: "top" as const,
  labels: { usePointStyle: true, pointStyle: "circle" as const, boxWidth: 8, font: { size: 11 } },
};

export function ContributorsAnalytics() {
  const { data: repos = [] } = useRepos();
  const repoRefs = useMemo(() => repos.map((r) => ({ owner: r.owner, repo: r.repo, label: r.label })), [repos]);
  const { data, isLoading, error } = useCommitActivity(repoRefs, 30);
  const { data: groups = [] } = useContributorGroups();
  const { data: hidden = new Set<string>() } = useHiddenContributors();

  const [entityKey, setEntityKey] = useState<string>(ALL);
  const [repo, setRepo] = useState<string>(ALL);
  const [showDev, setShowDev] = useState(true);
  const [showMain, setShowMain] = useState(true);
  const [showPrs, setShowPrs] = useState(true);
  const [exporting, setExporting] = useState(false);

  const dailyRef = useRef<ChartJS<"line"> | null>(null);
  const authorsRef = useRef<ChartJS<"bar"> | null>(null);
  const reposRef = useRef<ChartJS<"bar"> | null>(null);

  // Entidades visibles: grupos con showInAnalytics + individuos no ocultos.
  // Regla: un individuo oculto sigue contando dentro de sus grupos visibles.
  const entities = useMemo<Entity[]>(() => {
    const out: Entity[] = [];
    for (const g of groups.filter((g) => g.showInAnalytics && g.members.length > 0)) {
      out.push({ key: `g:${g.id}`, label: `👥 ${g.name}`, logins: g.members, isGroup: true });
    }
    for (const a of data?.authors ?? []) {
      if (!hidden.has(a.login)) out.push({ key: `u:${a.login}`, label: a.login, logins: [a.login], isGroup: false });
    }
    return out;
  }, [groups, data?.authors, hidden]);

  const view = useMemo(() => {
    if (!data) return null;
    const selected = entities.find((e) => e.key === entityKey) ?? null;
    const loginSet = selected ? new Set(selected.logins) : null;

    const byEntityFilter = (login: string) => !loginSet || loginSet.has(login);
    const byRepoFilter = (r: string) => repo === ALL || r === repo;

    const fCommits = data.commits.filter((c) => byEntityFilter(c.login) && byRepoFilter(c.repo));
    const fPrs = data.prs.filter((p) => byEntityFilter(p.login) && byRepoFilter(p.repo));

    const daily = buildDailySeries(fCommits, fPrs, data.since, data.windowDays);
    // Por entidad: respeta el filtro de repo pero muestra todas las entidades
    const byEntity = aggregateByEntity(
      data.commits.filter((c) => byRepoFilter(c.repo)),
      data.prs.filter((p) => byRepoFilter(p.repo)),
      entities,
    );
    // Por repo: respeta el filtro de entidad pero muestra todos los repos
    const byRepo = aggregateByRepo(
      data.commits.filter((c) => byEntityFilter(c.login)),
      data.prs.filter((p) => byEntityFilter(p.login)),
    );

    const devT = fCommits.filter((c) => c.inDev).length;
    const mainT = fCommits.filter((c) => c.inMain).length;
    const prsT = fPrs.length;
    const totalT = fCommits.length;
    const peak = daily.reduce((m, d) => (d.dev > m.dev ? d : m), daily[0] ?? { date: "", dev: 0, main: 0, prs: 0 });
    const activeDays = daily.filter((d) => d.dev + d.main + d.prs > 0).length;
    return { daily, byEntity, byRepo, devT, mainT, prsT, totalT, peak, activeDays, selected };
  }, [data, entities, entityKey, repo]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-6 w-6 animate-spin" /> Analizando actividad (main, dev y PRs)…
      </div>
    );
  }

  if (error || !data || !view) {
    return (
      <Card className="border-destructive">
        <CardContent className="p-4 text-sm text-destructive">
          {error instanceof Error ? error.message : "Error al cargar la actividad de commits"}
        </CardContent>
      </Card>
    );
  }

  const { daily, byEntity, byRepo, devT, mainT, prsT, totalT, peak, activeDays } = view;
  const topEntities = byEntity.slice(0, TOP_ENTITIES);
  const leader = byEntity[0];
  const leaderRepo = byRepo[0];
  const filterLabel = [
    view.selected ? `Contribuidor/Grupo: ${view.selected.label.replace("👥 ", "")}` : null,
    repo !== ALL ? `Repo: ${repo}` : null,
  ].filter(Boolean).join(" · ") || "Todos los contribuidores y repos";

  const labels = daily.map((d) => fmtDay(d.date));

  // ---- Cambios diarios: 3 series -------------------------------------------
  const lineData = {
    labels,
    datasets: [
      ...(showDev ? [{
        label: "Commits dev",
        data: daily.map((d) => d.dev),
        borderColor: COLOR_DEV,
        backgroundColor: (ctx: { chart: ChartJS }) => {
          const { ctx: c, chartArea } = ctx.chart;
          if (!chartArea) return "rgba(14,165,233,0.12)";
          const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          g.addColorStop(0, "rgba(14,165,233,0.25)");
          g.addColorStop(1, "rgba(14,165,233,0)");
          return g;
        },
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderWidth: 2,
      }] : []),
      ...(showMain ? [{
        label: "Commits main",
        data: daily.map((d) => d.main),
        borderColor: COLOR_MAIN,
        backgroundColor: "transparent",
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderWidth: 2,
      }] : []),
      ...(showPrs ? [{
        label: "PRs creados",
        data: daily.map((d) => d.prs),
        borderColor: COLOR_PRS,
        backgroundColor: "transparent",
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderWidth: 2,
        borderDash: [6, 3],
      }] : []),
    ],
  };

  const lineOpts: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: legendOpts,
      tooltip: {
        ...baseTooltip,
        callbacks: { title: (items) => fmtDay(daily[items[0].dataIndex].date) },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { size: 10 } } },
      y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: "rgba(148,163,184,0.15)" } },
    },
  };

  // ---- Por entidad: barras agrupadas horizontales ---------------------------
  const entityDatasets = [
    ...(showDev ? [{ label: "Dev", data: topEntities.map((e) => e.dev), backgroundColor: COLOR_DEV, borderRadius: 4, maxBarThickness: 14 }] : []),
    ...(showMain ? [{ label: "Main", data: topEntities.map((e) => e.main), backgroundColor: COLOR_MAIN, borderRadius: 4, maxBarThickness: 14 }] : []),
    ...(showPrs ? [{ label: "PRs", data: topEntities.map((e) => e.prs), backgroundColor: COLOR_PRS, borderRadius: 4, maxBarThickness: 14 }] : []),
  ];
  const entityData = { labels: topEntities.map((e) => e.label), datasets: entityDatasets };
  const entityOpts: ChartOptions<"bar"> = {
    indexAxis: "y",
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: legendOpts, tooltip: { ...baseTooltip } },
    scales: {
      x: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: "rgba(148,163,184,0.15)" } },
      y: { grid: { display: false }, ticks: { font: { size: 11 } } },
    },
  };

  // ---- Por repo: barras agrupadas verticales --------------------------------
  const repoDatasets = [
    ...(showDev ? [{ label: "Dev", data: byRepo.map((r) => r.dev), backgroundColor: COLOR_DEV, borderRadius: 4, maxBarThickness: 22 }] : []),
    ...(showMain ? [{ label: "Main", data: byRepo.map((r) => r.main), backgroundColor: COLOR_MAIN, borderRadius: 4, maxBarThickness: 22 }] : []),
    ...(showPrs ? [{ label: "PRs", data: byRepo.map((r) => r.prs), backgroundColor: COLOR_PRS, borderRadius: 4, maxBarThickness: 22 }] : []),
  ];
  const repoData = { labels: byRepo.map((r) => r.repo), datasets: repoDatasets };
  const repoOpts: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: legendOpts, tooltip: { ...baseTooltip } },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 10 } } },
      y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: "rgba(148,163,184,0.15)" } },
    },
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      // Detalle por grupo (respeta el filtro de repo), para la tabla del PDF.
      const groupsDetail = groups
        .filter((g) => g.members.length > 0)
        .map((g) => {
          const set = new Set(g.members);
          const cs = data.commits.filter((c) => set.has(c.login) && (repo === ALL || c.repo === repo));
          const ps = data.prs.filter((p) => set.has(p.login) && (repo === ALL || p.repo === repo));
          return {
            name: g.name,
            members: g.members,
            dev: cs.filter((c) => c.inDev).length,
            main: cs.filter((c) => c.inMain).length,
            prs: ps.length,
            visible: g.showInAnalytics,
          };
        });
      await exportAnalyticsPdf({
        windowDays: data.windowDays,
        filterLabel,
        kpis: { dev: devT, main: mainT, prs: prsT, total: totalT, peak, activeDays },
        leader,
        leaderRepo,
        byEntity,
        byRepo,
        groupsDetail,
        images: {
          daily: dailyRef.current?.toBase64Image(),
          authors: authorsRef.current?.toBase64Image(),
          repos: reposRef.current?.toBase64Image(),
        },
      });
    } finally {
      setExporting(false);
    }
  };

  const MetricChip = ({
    on, onClick, color, icon, label,
  }: { on: boolean; onClick: () => void; color: string; icon: React.ReactNode; label: string }) => (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        on ? "text-white" : "border-border text-muted-foreground hover:bg-muted",
      )}
      style={on ? { backgroundColor: color, borderColor: color } : undefined}
    >
      {icon} {label}
    </button>
  );

  return (
    <div className="space-y-6">
      {/* Barra de filtros + export */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <UsersIcon className="h-3.5 w-3.5" /> Contribuidor / Grupo
            </label>
            <SelectNative className="w-56" value={entityKey} onChange={(e) => setEntityKey(e.target.value)}>
              <option value={ALL}>Todos</option>
              {entities.map((e) => (
                <option key={e.key} value={e.key}>{e.label}</option>
              ))}
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <FolderGit2 className="h-3.5 w-3.5" /> Repositorio
            </label>
            <SelectNative className="w-56" value={repo} onChange={(e) => setRepo(e.target.value)}>
              <option value={ALL}>Todos</option>
              {data.repos.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">Métricas</label>
            <div className="flex items-center gap-1.5">
              <MetricChip on={showDev} onClick={() => setShowDev(!showDev)} color={COLOR_DEV}
                icon={<GitBranch className="h-3 w-3" />} label="Dev" />
              <MetricChip on={showMain} onClick={() => setShowMain(!showMain)} color={COLOR_MAIN}
                icon={<GitCommit className="h-3 w-3" />} label="Main" />
              <MetricChip on={showPrs} onClick={() => setShowPrs(!showPrs)} color={COLOR_PRS}
                icon={<GitPullRequest className="h-3 w-3" />} label="PRs" />
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground lg:inline">
              {devT.toLocaleString()} dev · {mainT.toLocaleString()} main · {prsT.toLocaleString()} PRs
            </span>
            <Button onClick={handleExport} disabled={exporting} size="sm">
              {exporting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileDown className="mr-1 h-4 w-4" />}
              Exportar PDF
            </Button>
          </div>
        </CardContent>
      </Card>

      {totalT === 0 && prsT === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
          <TrendingUp className="h-8 w-8" />
          <p>Sin actividad para el filtro seleccionado en los últimos {data.windowDays} días.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="xl:col-span-2">
            <SectionCard
              icon={<CalendarDays className="h-5 w-5 text-primary" />}
              title="Cambios diarios · dev vs main vs PRs"
              summary={
                <>
                  <strong className="text-foreground">{devT.toLocaleString()}</strong> commits en dev ·{" "}
                  <strong className="text-foreground">{mainT.toLocaleString()}</strong> en main ·{" "}
                  <strong className="text-foreground">{prsT.toLocaleString()}</strong> PRs creados.
                  {" "}Promedios diarios:{" "}
                  <strong style={{ color: COLOR_DEV }}>{(devT / data.windowDays).toFixed(1)} dev</strong> ·{" "}
                  <strong style={{ color: COLOR_MAIN }}>{(mainT / data.windowDays).toFixed(1)} main</strong> ·{" "}
                  <strong style={{ color: COLOR_PRS }}>{(prsT / data.windowDays).toFixed(1)} PRs</strong> por día.
                  {" "}La brecha dev−main ({Math.max(devT - mainT, 0).toLocaleString()}) es trabajo aún no
                  integrado a producción.
                  {peak.dev > 0 && (
                    <> Día pico (dev): <strong className="text-foreground">{fmtDay(peak.date)}</strong> ({peak.dev}).</>
                  )}{" "}
                  {activeDays} días activos.
                </>
              }
            >
              <div className="h-72">
                <Line ref={dailyRef} data={lineData} options={lineOpts} />
              </div>
            </SectionCard>
          </div>

          <SectionCard
            icon={<Trophy className="h-5 w-5 text-amber-500" />}
            title="Quién hace más cambios"
            summary={
              leader ? (
                <>
                  <strong className="text-foreground">{leader.label.replace("👥 ", "")}</strong>
                  {leader.isGroup ? " (grupo)" : ""} lidera con{" "}
                  <strong className="text-foreground">{leader.dev.toLocaleString()}</strong> commits en dev,{" "}
                  <strong className="text-foreground">{leader.main.toLocaleString()}</strong> en main y{" "}
                  <strong className="text-foreground">{leader.prs.toLocaleString()}</strong> PRs.
                </>
              ) : (
                "Sin actividad."
              )
            }
          >
            <div className="h-80">
              <Bar ref={authorsRef} data={entityData} options={entityOpts} />
            </div>
          </SectionCard>

          <SectionCard
            icon={<FolderGit2 className="h-5 w-5 text-emerald-500" />}
            title="Repositorio con más cambios"
            summary={
              leaderRepo ? (
                <>
                  <strong className="text-foreground">{leaderRepo.repo}</strong> concentra{" "}
                  <strong className="text-foreground">{leaderRepo.dev.toLocaleString()}</strong> commits en dev,{" "}
                  <strong className="text-foreground">{leaderRepo.main.toLocaleString()}</strong> en main y{" "}
                  <strong className="text-foreground">{leaderRepo.prs.toLocaleString()}</strong> PRs.
                </>
              ) : (
                "Sin actividad."
              )
            }
          >
            <div className="h-80">
              <Bar ref={reposRef} data={repoData} options={repoOpts} />
            </div>
          </SectionCard>
        </div>
      )}
    </div>
  );
}
