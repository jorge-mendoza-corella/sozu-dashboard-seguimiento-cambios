import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, Siren } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useProjects, useRepos } from "@/hooks/useProjectsRepos";
import {
  dispararSyncSentry, estaViejo, getSentryProyectos, pideRevision,
  type Entorno, type SentryIssue, type SentryProyecto,
} from "@/lib/sentry";

const Tendencia = lazy(() => import("@/components/monitoreo/Tendencia"));

/**
 * Errores de Sentry de los repos de Sozu, agrupados por proyecto del dashboard.
 *
 * Producción por defecto: es lo que le pega a usuarios reales. "Todos" suma dev
 * y cualquier otro entorno, útil mientras un repo no tenga el SDK en producción.
 */
export function MonitoreoPage() {
  const [entorno, setEntorno] = useState<Entorno>("produccion");
  const { data: projects } = useProjects();
  const { data: repos } = useRepos();
  const { data, isLoading, error } = useQuery({
    queryKey: ["sentry"],
    queryFn: getSentryProyectos,
    refetchInterval: 60_000,
  });

  // El cron de GitHub casi nunca corre en este repo: la pestaña abierta pide la
  // corrida cuando el dato envejece, y el refetch de cada minuto la recoge.
  const hayQueRevisar = !!data && pideRevision(data);
  useEffect(() => {
    if (hayQueRevisar) void dispararSyncSentry();
  }, [hayQueRevisar]);

  // slug de Sentry = nombre del repo → proyecto del dashboard.
  const grupos = useMemo(() => {
    const nombreProyecto = new Map((projects ?? []).map((p) => [p.id, p.name]));
    const proyectoDeRepo = new Map((repos ?? []).map((r) => [r.repo, r.projectId]));
    const porGrupo = new Map<string, SentryProyecto[]>();
    for (const p of data ?? []) {
      const pid = proyectoDeRepo.get(p.slug);
      const grupo = (pid && nombreProyecto.get(pid)) || "Sin proyecto";
      porGrupo.set(grupo, [...(porGrupo.get(grupo) ?? []), p]);
    }
    return [...porGrupo.entries()].sort(([a], [b]) => a.localeCompare(b, "es"));
  }, [data, projects, repos]);

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Siren className="h-5 w-5 text-red-600 dark:text-red-400" />
            <h1 className="text-xl font-bold tracking-tight">Monitoreo</h1>
          </div>
          <p className="text-sm text-muted-foreground">Errores de Sentry por repo, últimos 14 días.</p>
        </div>
        <div className="flex rounded-md border p-0.5 text-xs">
          {(["produccion", "todos"] as const).map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setEntorno(e)}
              className={cn(
                "rounded px-3 py-1 transition-colors",
                entorno === e ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {e === "produccion" ? "Producción" : "Todos los entornos"}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
      {error && <p className="text-sm text-red-600">No se pudo leer el monitoreo: {(error as Error).message}</p>}
      {data && data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Todavía no hay datos de Sentry. El sync ya se pidió; en un par de minutos aparecen aquí.
        </p>
      )}

      <div className="space-y-6">
        {grupos.map(([grupo, proyectos]) => (
          <section key={grupo}>
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{grupo}</h2>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {proyectos.map((p) => <TarjetaProyecto key={p.slug} p={p} entorno={entorno} />)}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

const hace = (iso: string | null) => {
  if (!iso) return "—";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 60) return `hace ${min} min`;
  if (min < 48 * 60) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 1440)} d`;
};

function TarjetaProyecto({ p, entorno }: { p: SentryProyecto; entorno: Entorno }) {
  const r = p.entornos[entorno];
  const total14d = r.serie14d.reduce((a, b) => a + b, 0);
  const viejo = estaViejo(p);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <a
              href={deSentry(p.url)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 font-semibold hover:underline"
            >
              {p.slug} <ExternalLink className="h-3 w-3 opacity-60" />
            </a>
            <p className={cn("text-xs", viejo ? "text-amber-600" : "text-muted-foreground")}>
              {viejo ? "Sin revisar " : "Revisado "}
              {hace(p.revisadoAt)}
            </p>
          </div>
          {r.crashFree !== null && (
            <Badge
              variant="outline"
              className={cn(r.crashFree < 0.99 ? "border-red-500 text-red-600" : "border-emerald-500 text-emerald-600")}
            >
              crash-free {(r.crashFree * 100).toFixed(2)}%
            </Badge>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <Cifra valor={r.sinResolver} etiqueta="sin resolver" alerta={r.sinResolver > 0} />
          <Cifra valor={r.nuevos24h} etiqueta="nuevos 24 h" alerta={r.nuevos24h > 0} />
          <Cifra valor={total14d} etiqueta="eventos 14 d" />
        </div>

        {total14d > 0 && (
          <Suspense fallback={<div className="h-12" />}>
            <Tendencia serie={r.serie14d} />
          </Suspense>
        )}

        {r.top.length > 0 ? (
          <ul className="space-y-1.5">
            {r.top.map((i) => <FilaIssue key={i.id} i={i} />)}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">Sin issues abiertos.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Cifra({ valor, etiqueta, alerta }: { valor: number; etiqueta: string; alerta?: boolean }) {
  return (
    <div className="rounded-md border px-2 py-1.5">
      <div className={cn("text-lg font-bold tabular-nums", alerta && "text-red-600 dark:text-red-400")}>
        {valor.toLocaleString("es-MX")}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{etiqueta}</div>
    </div>
  );
}

// Las URLs vienen de Firestore y terminan en un href: solo se aceptan de Sentry.
const deSentry = (url: string) => (/^https:\/\/[\w-]+\.sentry\.io\//.test(url) ? url : undefined);

function FilaIssue({ i }: { i: SentryIssue }) {
  return (
    <li>
      <a
        href={deSentry(i.url)}
        target="_blank"
        rel="noreferrer"
        className="block rounded px-1.5 py-1 text-xs hover:bg-muted"
        title={i.culprit}
      >
        <span className="font-mono text-[10px] text-muted-foreground">{i.shortId}</span>{" "}
        <span className="line-clamp-1 inline">{i.titulo}</span>
        <span className="ml-1 text-muted-foreground">
          · {i.eventos.toLocaleString("es-MX")} ev · {hace(i.ultimaVez)}
        </span>
      </a>
    </li>
  );
}
