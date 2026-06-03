import { useMemo, useRef, useState } from "react";
import {
  Loader2,
  CalendarDays,
  Trophy,
  FolderGit2,
  TrendingUp,
  FileDown,
  Users,
  GitCommit,
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
import { BAR_COLORS } from "@/lib/colors";
import { aggregateByAuthor, aggregateByRepo, buildDailySeries } from "@/lib/github";
import { exportAnalyticsPdf } from "@/lib/exportAnalyticsPdf";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler);

const TOP_AUTHORS = 8;
const INDIGO = "#6366f1";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fmtDay = (date: string) => {
  const [, m, d] = date.split("-");
  return `${Number(d)} ${MESES[Number(m) - 1] ?? ""}`;
};

const ALL = "__all__";

function SectionCard({
  icon,
  title,
  summary,
  children,
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
  displayColors: false,
};

export function ContributorsAnalytics() {
  const { data, isLoading, error } = useCommitActivity(30);
  const [author, setAuthor] = useState<string>(ALL);
  const [repo, setRepo] = useState<string>(ALL);
  const [exporting, setExporting] = useState(false);

  const dailyRef = useRef<ChartJS<"line"> | null>(null);
  const authorsRef = useRef<ChartJS<"bar"> | null>(null);
  const reposRef = useRef<ChartJS<"bar"> | null>(null);

  const view = useMemo(() => {
    if (!data) return null;
    const filtered = data.commits.filter(
      (c) => (author === ALL || c.login === author) && (repo === ALL || c.repo === repo),
    );
    const daily = buildDailySeries(filtered, data.since, data.windowDays);
    const byAuthor = aggregateByAuthor(data.commits.filter((c) => repo === ALL || c.repo === repo));
    const byRepo = aggregateByRepo(data.commits.filter((c) => author === ALL || c.login === author));
    const total = filtered.length;
    const peak = daily.reduce((m, d) => (d.count > m.count ? d : m), daily[0] ?? { date: "", count: 0 });
    const activeDays = daily.filter((d) => d.count > 0).length;
    return { filtered, daily, byAuthor, byRepo, total, peak, activeDays };
  }, [data, author, repo]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-6 w-6 animate-spin" /> Analizando actividad de commits…
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

  const { daily, byAuthor, byRepo, total, peak, activeDays } = view;
  const avg = total / data.windowDays;
  const topAuthors = byAuthor.slice(0, TOP_AUTHORS);
  const leaderAuthor = byAuthor[0];
  const leaderRepo = byRepo[0];
  const filterLabel =
    author === ALL && repo === ALL
      ? "Todos los contribuidores y repos"
      : [author !== ALL ? `Contribuidor: ${author}` : null, repo !== ALL ? `Repo: ${repo}` : null]
          .filter(Boolean)
          .join(" · ");

  // ---- Datasets Chart.js -----------------------------------------------------
  const labels = daily.map((d) => fmtDay(d.date));

  const lineData = {
    labels,
    datasets: [
      {
        label: "Commits",
        data: daily.map((d) => d.count),
        borderColor: INDIGO,
        backgroundColor: (ctx: { chart: ChartJS }) => {
          const { ctx: c, chartArea } = ctx.chart;
          if (!chartArea) return "rgba(99,102,241,0.15)";
          const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          g.addColorStop(0, "rgba(99,102,241,0.35)");
          g.addColorStop(1, "rgba(99,102,241,0)");
          return g;
        },
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: INDIGO,
        pointHoverBorderColor: "#fff",
        pointHoverBorderWidth: 2,
        borderWidth: 2,
      },
    ],
  };

  const lineOpts: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...baseTooltip,
        callbacks: {
          title: (items) => fmtDay(daily[items[0].dataIndex].date),
          label: (item) => `${item.parsed.y} commit${item.parsed.y === 1 ? "" : "s"}`,
        },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { size: 10 } } },
      y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: "rgba(148,163,184,0.15)" } },
    },
  };

  const authorsData = {
    labels: topAuthors.map((a) => a.login),
    datasets: [
      {
        label: "Commits",
        data: topAuthors.map((a) => a.total),
        backgroundColor: topAuthors.map((_, i) => BAR_COLORS[i % BAR_COLORS.length]),
        borderRadius: 6,
        maxBarThickness: 26,
      },
    ],
  };

  const authorsOpts: ChartOptions<"bar"> = {
    indexAxis: "y",
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        ...baseTooltip,
        callbacks: {
          label: (item) => {
            const a = topAuthors[item.dataIndex];
            return `${a.total} commits · ${a.perDay.toFixed(1)}/día activo`;
          },
        },
      },
    },
    scales: {
      x: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: "rgba(148,163,184,0.15)" } },
      y: { grid: { display: false }, ticks: { font: { size: 11 } } },
    },
  };

  const reposData = {
    labels: byRepo.map((r) => r.repo),
    datasets: [
      {
        label: "Commits",
        data: byRepo.map((r) => r.total),
        backgroundColor: byRepo.map((_, i) => BAR_COLORS[i % BAR_COLORS.length]),
        borderRadius: 6,
        maxBarThickness: 48,
      },
    ],
  };

  const reposOpts: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        ...baseTooltip,
        callbacks: {
          label: (item) => {
            const v = item.parsed.y ?? 0;
            const pct = total > 0 ? ((v / total) * 100).toFixed(0) : "0";
            return `${v} commits · ${pct}% del total`;
          },
        },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 10 } } },
      y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: "rgba(148,163,184,0.15)" } },
    },
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportAnalyticsPdf({
        windowDays: data.windowDays,
        filterLabel,
        kpis: { total, avg, peak, activeDays },
        leaderAuthor,
        leaderRepo,
        byAuthor,
        byRepo,
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

  return (
    <div className="space-y-6">
      {/* Barra de filtros + export */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Users className="h-3.5 w-3.5" /> Contribuidor
            </label>
            <SelectNative className="w-52" value={author} onChange={(e) => setAuthor(e.target.value)}>
              <option value={ALL}>Todos</option>
              {data.authors.map((a) => (
                <option key={a.login} value={a.login}>
                  {a.login}
                </option>
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
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </SelectNative>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline-flex sm:items-center sm:gap-1">
              <GitCommit className="h-3.5 w-3.5" />
              {total.toLocaleString()} commits en {data.windowDays} días
            </span>
            <Button onClick={handleExport} disabled={exporting} size="sm">
              {exporting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileDown className="mr-1 h-4 w-4" />}
              Exportar PDF
            </Button>
          </div>
        </CardContent>
      </Card>

      {total === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
          <TrendingUp className="h-8 w-8" />
          <p>Sin commits para el filtro seleccionado en los últimos {data.windowDays} días.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="xl:col-span-2">
            <SectionCard
              icon={<CalendarDays className="h-5 w-5 text-primary" />}
              title="Cambios diarios"
              summary={
                <>
                  <strong className="text-foreground">{total.toLocaleString()}</strong> commits ·
                  promedio de <strong className="text-foreground">{avg.toFixed(1)}</strong>/día
                  {peak.count > 0 && (
                    <>
                      {" "}· día pico <strong className="text-foreground">{fmtDay(peak.date)}</strong> (
                      {peak.count})
                    </>
                  )}{" "}
                  · {activeDays} días activos.
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
            title="Quién hace más cambios diarios"
            summary={
              leaderAuthor ? (
                <>
                  <strong className="text-foreground">{leaderAuthor.login}</strong> lidera con{" "}
                  <strong className="text-foreground">{leaderAuthor.total.toLocaleString()}</strong> commits (
                  {leaderAuthor.perDay.toFixed(1)}/día activo).
                </>
              ) : (
                "Sin actividad."
              )
            }
          >
            <div className="h-72">
              <Bar ref={authorsRef} data={authorsData} options={authorsOpts} />
            </div>
          </SectionCard>

          <SectionCard
            icon={<FolderGit2 className="h-5 w-5 text-emerald-500" />}
            title="Repositorio con más cambios"
            summary={
              leaderRepo ? (
                <>
                  <strong className="text-foreground">{leaderRepo.repo}</strong> concentra{" "}
                  <strong className="text-foreground">{leaderRepo.total.toLocaleString()}</strong> commits (
                  {total > 0 ? ((leaderRepo.total / total) * 100).toFixed(0) : 0}% del total).
                </>
              ) : (
                "Sin actividad."
              )
            }
          >
            <div className="h-72">
              <Bar ref={reposRef} data={reposData} options={reposOpts} />
            </div>
          </SectionCard>
        </div>
      )}
    </div>
  );
}
