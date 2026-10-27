import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SentryProyecto, SentryResumen } from "@/lib/sentry";

// ---------------------------------------------------------------------------
// Página de estado al estilo status.supabase.com: una barra por repo con un
// cuadro por día (90 días, hoy a la derecha) coloreado por los errores de ese
// día en producción, el % de días sin errores y desde cuándo no hay errores.
//
// No es "uptime": Sentry cuenta errores, no caídas. Por eso se dice "días sin
// errores". Los días antes de dar de alta el proyecto en Sentry salen grises y
// no cuentan para el %: no hay datos, no es que no hubiera errores.
// ---------------------------------------------------------------------------

const DIAS = 90;
const DIA_MS = 86_400_000;

export interface FilaEstado {
  p: SentryProyecto;
  r: SentryResumen;
  proyecto: string;
}

type Tono = "ok" | "pocos" | "muchos" | "sin";

const tono = (n: number | null): Tono => (n === null ? "sin" : n === 0 ? "ok" : n < 10 ? "pocos" : "muchos");

const COLOR: Record<Tono, string> = {
  ok: "bg-emerald-500",
  pocos: "bg-amber-400",
  muchos: "bg-red-500",
  sin: "bg-muted",
};

const inicioDelDia = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Los 90 días con su conteo, o null si el proyecto todavía no existía. */
function dias(f: FilaEstado): { fecha: Date; n: number | null }[] {
  const serie = f.r.serie90d.length ? f.r.serie90d : f.r.serie14d;
  const hoy = inicioDelDia(Date.now());
  const alta = f.p.creadoEn ? inicioDelDia(new Date(f.p.creadoEn).getTime()) : null;
  return Array.from({ length: DIAS }, (_, i) => {
    const atras = DIAS - 1 - i;
    const t = hoy - atras * DIA_MS;
    const idx = serie.length - 1 - atras;
    const antesDeAlta = alta !== null && t < alta;
    return { fecha: new Date(t), n: antesDeAlta || idx < 0 ? null : serie[idx] };
  });
}

function resumen(ds: { fecha: Date; n: number | null }[]) {
  const medidos = ds.filter((d) => d.n !== null);
  const limpios = medidos.filter((d) => d.n === 0).length;
  const pct = medidos.length ? (limpios / medidos.length) * 100 : null;
  const ultimo = [...medidos].reverse().find((d) => (d.n ?? 0) > 0);
  const desde = ultimo ? Math.round((inicioDelDia(Date.now()) - ultimo.fecha.getTime()) / DIA_MS) : null;
  return { pct, desde, medidos: medidos.length };
}

const fechaCorta = (d: Date) => d.toLocaleDateString("es-MX", { day: "numeric", month: "short" });

export function EstadoRepos({ filas }: { filas: FilaEstado[] }) {
  const conAbiertos = filas.filter((f) => f.r.sinResolver > 0);
  const conNuevos = conAbiertos.filter((f) => f.r.nuevos24h > 0);
  const estado = conNuevos.length ? "rojo" : conAbiertos.length ? "ambar" : "ok";
  const ordenadas = [...filas].sort((a, b) => a.p.slug.localeCompare(b.p.slug));

  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div
        className={cn(
          "flex items-start gap-3 border-b p-4",
          estado === "ok" && "bg-emerald-50 dark:bg-emerald-950/30",
          estado === "ambar" && "bg-amber-50 dark:bg-amber-950/30",
          estado === "rojo" && "bg-red-50 dark:bg-red-950/30",
        )}
      >
        {estado === "ok" ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : estado === "ambar" ? (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        ) : (
          <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
        )}
        <div>
          <p className="font-semibold">
            {estado === "ok"
              ? "Todo operando sin errores abiertos"
              : estado === "ambar"
                ? `${conAbiertos.length} ${conAbiertos.length === 1 ? "repo tiene" : "repos tienen"} errores abiertos`
                : `${conNuevos.length} ${conNuevos.length === 1 ? "repo tiene" : "repos tienen"} errores nuevos hoy`}
          </p>
          <p className="text-sm text-muted-foreground">
            {estado === "ok"
              ? "Ningún repo tiene issues sin resolver en producción."
              : conAbiertos.map((f) => f.p.slug).join(", ")}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-semibold">Estado de los repos</h2>
        <span className="text-xs text-muted-foreground">Últimos {DIAS} días · producción</span>
      </div>

      <ul className="divide-y">
        {ordenadas.map((f) => <FilaRepo key={f.p.slug} f={f} />)}
      </ul>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-[11px] text-muted-foreground">
        {(["ok", "pocos", "muchos", "sin"] as const).map((t) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <span className={cn("h-2.5 w-2.5 rounded-sm", COLOR[t])} />
            {t === "ok" ? "Sin errores" : t === "pocos" ? "1 a 9 errores" : t === "muchos" ? "10 o más" : "Sin datos (antes del alta en Sentry)"}
          </span>
        ))}
      </div>
    </section>
  );
}

function FilaRepo({ f }: { f: FilaEstado }) {
  const ds = dias(f);
  const { pct, desde, medidos } = resumen(ds);
  const abierto = f.r.sinResolver > 0;
  return (
    <li className="px-4 py-3">
      <div className="mb-1.5 flex items-center gap-2">
        {abierto ? (
          <AlertTriangle className={cn("h-4 w-4 shrink-0", f.r.nuevos24h ? "text-red-500" : "text-amber-500")} />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
        )}
        <span className="truncate text-sm font-medium">{f.p.slug}</span>
        <span className="hidden truncate text-xs text-muted-foreground sm:inline">{f.proyecto}</span>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
          {pct === null ? "sin datos" : `${pct.toFixed(pct === 100 ? 0 : 1)}% días sin errores`}
        </span>
      </div>
      <div className="flex h-7 gap-px sm:gap-[2px]" role="img" aria-label={`Errores por día de ${f.p.slug}`}>
        {ds.map((d) => (
          <span
            key={d.fecha.getTime()}
            className={cn("min-w-0 flex-1 rounded-[2px] transition-opacity hover:opacity-70", COLOR[tono(d.n)])}
            title={`${fechaCorta(d.fecha)}: ${d.n === null ? "sin datos" : d.n === 0 ? "sin errores" : `${d.n} ${d.n === 1 ? "error" : "errores"}`}`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>hace {DIAS} días</span>
        <span>
          {medidos === 0
            ? "todavía sin datos"
            : desde === null
              ? `sin errores en ${medidos} ${medidos === 1 ? "día medido" : "días medidos"}`
              : desde === 0
                ? "último error: hoy"
                : `sin errores desde hace ${desde} ${desde === 1 ? "día" : "días"}`}
        </span>
        <span>hoy</span>
      </div>
    </li>
  );
}
