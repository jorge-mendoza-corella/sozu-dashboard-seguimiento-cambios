import { Loader2, CalendarDays, Trophy, FolderGit2, TrendingUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useCommitActivity } from "@/hooks/useCommitActivity";
import { BAR_COLORS } from "@/lib/colors";
import type { CommitActivity } from "@/lib/github";

const TOP_AUTHORS = 8;

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fmtDay = (date: string) => {
  const [, m, d] = date.split("-");
  return `${Number(d)} ${MESES[Number(m) - 1] ?? ""}`;
};

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

/** Gráfico de área/línea en SVG puro (sin dependencias). */
function DailyAreaChart({ data }: { data: { date: string; count: number }[] }) {
  const W = 720;
  const H = 240;
  const PAD = { top: 12, right: 12, bottom: 28, left: 32 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const max = Math.max(...data.map((d) => d.count), 1);
  const n = data.length;

  const x = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

  const linePts = data.map((d, i) => `${x(i)},${y(d.count)}`).join(" ");
  const areaPts = `${PAD.left},${PAD.top + innerH} ${linePts} ${PAD.left + innerW},${PAD.top + innerH}`;

  // ~6 etiquetas de fecha en X
  const step = Math.max(1, Math.ceil(n / 6));
  const xLabels = data.filter((_, i) => i % step === 0 || i === n - 1);

  // gridlines Y (0, mitad, max)
  const yTicks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-64 w-full" preserveAspectRatio="none" role="img">
      <defs>
        <linearGradient id="dailyFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity={0.35} />
          <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
        </linearGradient>
      </defs>
      {yTicks.map((v) => (
        <g key={v}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(v)}
            y2={y(v)}
            stroke="currentColor"
            strokeOpacity={0.12}
            strokeDasharray="3 3"
          />
          <text x={4} y={y(v) + 3} fontSize={10} fill="currentColor" fillOpacity={0.5}>
            {v}
          </text>
        </g>
      ))}
      <polygon points={areaPts} fill="url(#dailyFill)" />
      <polyline points={linePts} fill="none" stroke="#6366f1" strokeWidth={2} strokeLinejoin="round" />
      {xLabels.map((d) => {
        const i = data.indexOf(d);
        return (
          <text
            key={d.date}
            x={x(i)}
            y={H - 8}
            fontSize={10}
            fill="currentColor"
            fillOpacity={0.6}
            textAnchor="middle"
          >
            {fmtDay(d.date)}
          </text>
        );
      })}
    </svg>
  );
}

/** Barras horizontales en CSS (mismo patrón que el modal de contribuidor). */
function HBars({
  items,
}: {
  items: { key: string; label: React.ReactNode; value: number; caption?: string }[];
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={it.key} className="flex items-center gap-3">
          <span className="w-36 shrink-0 truncate text-xs text-muted-foreground" title={it.key}>
            {it.label}
          </span>
          <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
            <div
              className="flex h-full items-center justify-end rounded pr-2 text-[10px] font-medium text-white"
              style={{
                width: `${Math.max((it.value / max) * 100, 8)}%`,
                backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
              }}
            >
              {it.value.toLocaleString()}
            </div>
          </div>
          {it.caption && <span className="w-16 shrink-0 text-right text-[10px] text-muted-foreground">{it.caption}</span>}
        </div>
      ))}
    </div>
  );
}

function DailyChangesSection({ data }: { data: CommitActivity }) {
  const { daily, totalCommits, windowDays } = data;
  const avg = totalCommits / windowDays;
  const peak = daily.reduce((m, d) => (d.count > m.count ? d : m), daily[0] ?? { date: "", count: 0 });

  return (
    <SectionCard
      icon={<CalendarDays className="h-5 w-5 text-primary" />}
      title="Cambios diarios"
      summary={
        <>
          <strong className="text-foreground">{totalCommits.toLocaleString()}</strong> commits en los
          últimos {windowDays} días · promedio de{" "}
          <strong className="text-foreground">{avg.toFixed(1)}</strong> commits/día.
          {peak.count > 0 && (
            <>
              {" "}Día pico: <strong className="text-foreground">{fmtDay(peak.date)}</strong> con{" "}
              <strong className="text-foreground">{peak.count}</strong> commits.
            </>
          )}
        </>
      }
    >
      <DailyAreaChart data={daily} />
    </SectionCard>
  );
}

function TopAuthorsSection({ data }: { data: CommitActivity }) {
  const top = data.byAuthor.slice(0, TOP_AUTHORS);
  const leader = top[0];

  return (
    <SectionCard
      icon={<Trophy className="h-5 w-5 text-amber-500" />}
      title="Quién hace más cambios diarios"
      summary={
        leader ? (
          <>
            <strong className="text-foreground">{leader.login}</strong> lidera con{" "}
            <strong className="text-foreground">{leader.total.toLocaleString()}</strong> commits (
            {leader.perDay.toFixed(1)}/día activo) en los últimos {data.windowDays} días.
          </>
        ) : (
          "Sin actividad en el período."
        )
      }
    >
      <HBars
        items={top.map((a) => ({
          key: a.login,
          label: a.login,
          value: a.total,
          caption: `${a.perDay.toFixed(1)}/día`,
        }))}
      />
    </SectionCard>
  );
}

function TopReposSection({ data }: { data: CommitActivity }) {
  const { byRepo, totalCommits } = data;
  const leader = byRepo[0];
  const pct = leader && totalCommits > 0 ? (leader.total / totalCommits) * 100 : 0;

  return (
    <SectionCard
      icon={<FolderGit2 className="h-5 w-5 text-emerald-500" />}
      title="Repositorio con más cambios"
      summary={
        leader ? (
          <>
            <strong className="text-foreground">{leader.repo}</strong> concentra{" "}
            <strong className="text-foreground">{leader.total.toLocaleString()}</strong> commits (
            {pct.toFixed(0)}% del total) en los últimos {data.windowDays} días.
          </>
        ) : (
          "Sin actividad en el período."
        )
      }
    >
      <HBars
        items={byRepo.map((r) => ({
          key: r.repo,
          label: r.repo,
          value: r.total,
          caption: totalCommits > 0 ? `${((r.total / totalCommits) * 100).toFixed(0)}%` : undefined,
        }))}
      />
    </SectionCard>
  );
}

export function ContributorsAnalytics() {
  const { data, isLoading, error } = useCommitActivity(30);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-6 w-6 animate-spin" /> Analizando actividad de commits…
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card className="border-destructive">
        <CardContent className="p-4 text-sm text-destructive">
          {error instanceof Error ? error.message : "Error al cargar la actividad de commits"}
        </CardContent>
      </Card>
    );
  }

  if (data.totalCommits === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted-foreground">
        <TrendingUp className="h-8 w-8" />
        <p>Sin commits en los últimos {data.windowDays} días.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <div className="xl:col-span-2">
        <DailyChangesSection data={data} />
      </div>
      <TopAuthorsSection data={data} />
      <TopReposSection data={data} />
    </div>
  );
}
