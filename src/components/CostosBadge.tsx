import { useQuery } from "@tanstack/react-query";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Bot, ChevronDown, Gauge, Github } from "lucide-react";
import { cn } from "@/lib/utils";
import { getGithubActionsUso, type GithubActionsUso } from "@/lib/githubBilling";
import { getAnthropicMes, type AnthropicMes } from "@/lib/anthropicMes";
import { esRolOperativo, type AppUser } from "@/lib/firestoreUsers";
import { formatDistanceToNow } from "@/lib/timeUtils";

// ---------------------------------------------------------------------------
// Cuánto llevamos gastado en el mes, en la barra de arriba: GitHub Actions +
// API de Anthropic. El número es la suma; al dar clic, el detalle de cada uno.
//
// Solo lo ven los administradores —global y de empresa—: es información de
// administración, no de operación, y a quien viene a mirar un deploy no le sirve
// de nada. El filtro vive aquí y no en el layout para que no haya dos sitios
// donde acordarse de aplicarlo.
// ---------------------------------------------------------------------------

/** A partir de aquí el cupo empieza a preocupar. */
const AVISO_PCT = 75;
const ALERTA_PCT = 90;

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/**
 * "septiembre" a secas si el dato cubre el mes hasta hoy, y "septiembre, al 14"
 * si GitHub todavía no consolidó los últimos días.
 *
 * La distinción importa: un consumo "de septiembre" que en realidad va hasta el
 * 14 se compara mal contra el presupuesto del mes entero, y quien lo mire de
 * reojo sacará la conclusión contraria a la buena.
 */
function etiquetaPeriodo(p: { anio: number; mes: number; hasta: string | null } | null): string {
  if (!p) return "";
  const mes = MESES[p.mes - 1] ?? `mes ${p.mes}`;
  if (!p.hasta) return mes;
  const dia = Number(p.hasta.slice(8, 10));
  const hoy = new Date();
  const alDia = hoy.getUTCDate() - dia <= 1 && hoy.getUTCMonth() + 1 === p.mes;
  return alDia ? mes : `${mes}, al ${dia}`;
}

const N = (v: number) => v.toLocaleString("es-MX");
const USD = (v: number) =>
  v.toLocaleString("es-MX", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/** Líneas de detalle de GitHub Actions (lo que antes iba en el tooltip). */
function detalleGithub(data: GithubActionsUso): string[] {
  const pct = data.pctCupo;
  const periodo = etiquetaPeriodo(data.periodo);
  const porMaquina = Object.entries(data.minutosPorMaquina)
    .filter(([, min]) => min > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([maquina, min]) => `${maquina.toLowerCase()}: ${N(min)} min`)
    .join(" · ");
  return [
    `Cuenta: ${data.usuario}`,
    periodo && data.periodo?.desde ? `Del ${data.periodo.desde} al ${data.periodo.hasta}` : null,
    data.minutosIncluidos
      ? `${N(data.minutosUsados)} de ${N(data.minutosIncluidos)} minutos de presupuesto${pct !== null ? ` (${pct}%)` : ""}` +
        (data.plataforma === "nueva" ? " — objetivo de la casa, no un límite de GitHub." : "")
      : `${N(data.minutosUsados)} minutos usados`,
    // En la facturación nueva el importe lo da GitHub calculado, así que no se
    // presenta como estimación; en la vieja sí lo era, porque solo daba minutos.
    data.plataforma === "nueva"
      ? data.costoBruto > data.costoAproximado
        ? `${USD(data.costoAproximado)} a pagar — de ${USD(data.costoBruto)} brutos, el plan absorbe ${USD(data.descuento)}`
        : null
      : data.minutosPagados
        ? `${N(data.minutosPagados)} minutos por encima del cupo ≈ ${USD(data.costoAproximado)} (estimado)`
        : "Nada por encima del cupo: sin cargo",
    porMaquina && `Por máquina — ${porMaquina}. Un minuto de macOS cuesta diez veces uno de Linux.`,
    data.ciclo !== null ? `El ciclo reinicia en ${data.ciclo} días.` : null,
  ].filter((x): x is string => !!x);
}

function Seccion({ icono, titulo, monto, children }: { icono: React.ReactNode; titulo: string; monto: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5 border-t px-3 py-2.5 first:border-t-0">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold">
        {icono}
        {titulo}
        <span className="ml-auto tabular-nums">{monto}</span>
      </h4>
      {children}
    </section>
  );
}

/** Barra proporcional al mayor de la lista. */
function Fila({ etiqueta, usd, max, sub }: { etiqueta: string; usd: number; max: number; sub?: string }) {
  return (
    <li className="text-[11px]">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate" title={etiqueta}>{etiqueta}</span>
        <span className="shrink-0 tabular-nums font-medium">{USD(usd)}</span>
      </div>
      <span className="mt-0.5 block h-1 overflow-hidden rounded bg-muted">
        <span className="block h-full rounded bg-violet-500/70" style={{ width: `${max > 0 ? Math.max(2, (usd / max) * 100) : 0}%` }} />
      </span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </li>
  );
}

function DetalleAnthropic({ a }: { a: AnthropicMes }) {
  const maxLlave = a.porLlave[0]?.usd ?? 0;
  const maxConcepto = a.porConcepto[0]?.usd ?? 0;
  return (
    <>
      {a.error && <p className="text-[11px] text-amber-700 dark:text-amber-300">{a.error}</p>}
      {a.porLlave.length > 0 && (
        <>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Por llave de API</p>
          <ul className="space-y-1.5">
            {a.porLlave.map((l) => (
              <Fila key={l.id} etiqueta={l.nombre} usd={l.usd} max={maxLlave} sub={l.modelos.join(", ")} />
            ))}
          </ul>
        </>
      )}
      {a.porConcepto.length > 0 && (
        <>
          <p className="pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Por concepto (factura)</p>
          <ul className="space-y-1.5">
            {a.porConcepto.slice(0, 6).map((c) => <Fila key={c.concepto} etiqueta={c.concepto} usd={c.usd} max={maxConcepto} />)}
          </ul>
        </>
      )}
      <p className="text-[10px] text-muted-foreground">
        Total real de Anthropic; el reparto por llave es aproximado (precio de lista por modelo).
        {a.updatedAt && ` Actualizado ${formatDistanceToNow(a.updatedAt)}.`}
      </p>
    </>
  );
}

export function CostosBadge({ appUser }: { appUser: AppUser | null }) {
  const esAdmin = !!appUser && !esRolOperativo(appUser.role);

  const gh = useQuery({
    queryKey: ["github-actions-uso"],
    queryFn: getGithubActionsUso,
    // Solo se consulta si quien mira puede verlo: sin esto, un viewer pediría
    // el documento igual y se llevaría un error de permisos en consola.
    enabled: esAdmin,
    staleTime: 30 * 60_000,
  });
  const an = useQuery({
    queryKey: ["anthropic-mes"],
    queryFn: getAnthropicMes,
    enabled: esAdmin,
    staleTime: 10 * 60_000,
  });

  if (!esAdmin || (!gh.data && !an.data)) return null;

  const ghUsd = gh.data && !gh.data.error ? gh.data.costoAproximado : 0;
  const anUsd = an.data?.totalUsd ?? 0;
  const total = ghUsd + anUsd;

  const pct = gh.data?.pctCupo ?? null;
  const tono =
    pct === null ? "text-muted-foreground"
    : pct >= ALERTA_PCT ? "text-rose-600 dark:text-rose-400"
    : pct >= AVISO_PCT ? "text-amber-600 dark:text-amber-400"
    : "text-muted-foreground";

  const ahora = new Date();
  const mes = MESES[ahora.getMonth()];

  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          type="button"
          className={cn("hidden items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-muted lg:flex", tono)}
          title={`Costos de ${mes}: GitHub Actions ${USD(ghUsd)} + API de Anthropic ${USD(anUsd)}. Clic para el detalle.`}
        >
          <Gauge className="h-3.5 w-3.5 shrink-0" />
          <span className="tabular-nums font-medium">{USD(total)}</span>
          <span className="opacity-60">{mes.slice(0, 3)}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={6}
          className="z-50 w-[22rem] max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-baseline justify-between bg-muted/40 px-3 py-2">
            <span className="text-xs font-semibold">Costos de {mes}</span>
            <span className="text-sm font-semibold tabular-nums">{USD(total)}</span>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            <Seccion icono={<Github className="h-3.5 w-3.5" />} titulo="GitHub Actions" monto={gh.data && !gh.data.error ? USD(ghUsd) : "—"}>
              {!gh.data ? (
                <p className="text-[11px] text-muted-foreground">Sin datos.</p>
              ) : gh.data.error ? (
                <p className="text-[11px] text-muted-foreground">No disponible: {gh.data.error}</p>
              ) : (
                <>
                  {gh.data.minutosIncluidos > 0 && pct !== null && (
                    <span className="block h-1.5 overflow-hidden rounded bg-muted">
                      <span
                        className={cn("block h-full rounded", pct >= ALERTA_PCT ? "bg-rose-500" : pct >= AVISO_PCT ? "bg-amber-500" : "bg-emerald-500")}
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </span>
                  )}
                  <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                    {detalleGithub(gh.data).map((l) => <li key={l}>{l}</li>)}
                  </ul>
                </>
              )}
            </Seccion>
            <Seccion icono={<Bot className="h-3.5 w-3.5" />} titulo="API de Anthropic" monto={an.data ? USD(anUsd) : "—"}>
              {an.data ? <DetalleAnthropic a={an.data} /> : <p className="text-[11px] text-muted-foreground">Sin datos todavía (el sync corre cada 15 min).</p>}
            </Seccion>
          </div>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
