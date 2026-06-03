import { Loader2, CalendarDays, Trophy, FolderGit2, TrendingUp } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { useCommitActivity } from "@/hooks/useCommitActivity";
import { BAR_COLORS } from "@/lib/colors";
import type { CommitActivity } from "@/lib/github";

const TOP_AUTHORS = 8;

const fmtDay = (date: string) => {
  // date = YYYY-MM-DD -> "DD MMM"
  const [, m, d] = date.split("-");
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${Number(d)} ${meses[Number(m) - 1] ?? ""}`;
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
        <div className="mt-4 h-72 w-full">{children}</div>
      </CardContent>
    </Card>
  );
}

function DailyChangesSection({ data }: { data: CommitActivity }) {
  const { daily, totalCommits, windowDays } = data;
  const avg = totalCommits / windowDays;
  const peak = daily.reduce((max, d) => (d.count > max.count ? d : max), daily[0] ?? { date: "", count: 0 });

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
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={daily} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
          <defs>
            <linearGradient id="dailyFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity={0.4} />
              <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={fmtDay}
            tick={{ fontSize: 11 }}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
          <Tooltip
            labelFormatter={(l) => fmtDay(String(l))}
            formatter={(v: unknown) => [Number(v), "commits"]}
            contentStyle={{ fontSize: 12, borderRadius: 8 }}
          />
          <Area type="monotone" dataKey="count" stroke="#6366f1" strokeWidth={2} fill="url(#dailyFill)" />
        </AreaChart>
      </ResponsiveContainer>
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
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={top} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="login" tick={{ fontSize: 11 }} width={110} />
          <Tooltip
            formatter={(v: unknown, _n: unknown, p: { payload?: { perDay?: number } }) => [
              `${Number(v)} commits · ${(p.payload?.perDay ?? 0).toFixed(1)}/día`,
              "Actividad",
            ]}
            contentStyle={{ fontSize: 12, borderRadius: 8 }}
          />
          <Bar dataKey="total" radius={[0, 4, 4, 0]}>
            {top.map((a, i) => (
              <Cell key={a.login} fill={BAR_COLORS[i % BAR_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
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
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={byRepo} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="repo" tick={{ fontSize: 10 }} interval={0} angle={-12} textAnchor="end" height={50} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
          <Tooltip formatter={(v: unknown) => [Number(v), "commits"]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
          <Bar dataKey="total" radius={[4, 4, 0, 0]}>
            {byRepo.map((r, i) => (
              <Cell key={r.repo} fill={BAR_COLORS[i % BAR_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
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
