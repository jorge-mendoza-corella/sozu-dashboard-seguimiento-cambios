import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import { getGithubActionsUso } from "@/lib/githubBilling";
import { esRolOperativo, type AppUser } from "@/lib/firestoreUsers";

// ---------------------------------------------------------------------------
// Cuánto llevamos gastado de GitHub Actions, en la barra de arriba.
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

/** "sep", para la barra: ahí cada carácter compite con la navegación. */
function mesCorto(p: { mes: number } | null): string {
  if (!p) return "";
  return (MESES[p.mes - 1] ?? "").slice(0, 3);
}

const N = (v: number) => v.toLocaleString("es-MX");
const USD = (v: number) =>
  v.toLocaleString("es-MX", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function ActionsUsoBadge({ appUser }: { appUser: AppUser | null }) {
  const esAdmin = !!appUser && !esRolOperativo(appUser.role);

  const { data } = useQuery({
    queryKey: ["github-actions-uso"],
    queryFn: getGithubActionsUso,
    // Solo se consulta si quien mira puede verlo: sin esto, un viewer pediría
    // el documento igual y se llevaría un error de permisos en consola.
    enabled: esAdmin,
    staleTime: 30 * 60_000,
  });

  if (!esAdmin || !data) return null;

  // Con error se calla en la barra pero lo deja en el título: un badge en rojo
  // ahí arriba alarma sobre algo que casi siempre es una credencial caducada.
  if (data.error) {
    return (
      <span
        className="hidden items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground/60 lg:flex"
        title={`Consumo de Actions no disponible. ${data.error}`}
      >
        <Gauge className="h-3.5 w-3.5" />
        <span>Actions</span>
      </span>
    );
  }

  const pct = data.pctCupo;
  const tono =
    pct === null ? "text-muted-foreground"
    : pct >= ALERTA_PCT ? "text-rose-600 dark:text-rose-400"
    : pct >= AVISO_PCT ? "text-amber-600 dark:text-amber-400"
    : "text-muted-foreground";

  const porMaquina = Object.entries(data.minutosPorMaquina)
    .filter(([, min]) => min > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([maquina, min]) => `${maquina.toLowerCase()}: ${N(min)} min`)
    .join(" · ");

  const periodo = etiquetaPeriodo(data.periodo);

  const titulo = [
    `Gasto de GitHub Actions${periodo ? ` — ${periodo}` : ""}`,
    `Cuenta: ${data.usuario}`,
    periodo &&
      (data.periodo?.desde
        ? `Consumo de ${periodo} (del ${data.periodo.desde} al ${data.periodo.hasta})`
        : `Consumo de ${periodo}`),
    data.minutosIncluidos
      ? `${N(data.minutosUsados)} de ${N(data.minutosIncluidos)} minutos de presupuesto${pct !== null ? ` (${pct}%)` : ""}` +
        (data.plataforma === "nueva"
          ? " — el presupuesto es un objetivo de la casa, no un límite de GitHub: pasarse no corta nada."
          : "")
      : `${N(data.minutosUsados)} minutos usados`,
    // En la facturación nueva el importe lo da GitHub calculado, así que no se
    // presenta como estimación; en la vieja sí lo era, porque solo daba minutos.
    data.plataforma === "nueva"
      ? data.costoBruto > data.costoAproximado
        ? `${USD(data.costoAproximado)} a pagar — de ${USD(data.costoBruto)} brutos, el plan absorbe ${USD(data.descuento)}`
        : `${USD(data.costoAproximado)} a pagar`
      : data.minutosPagados
        ? `${N(data.minutosPagados)} minutos por encima del cupo ≈ ${USD(data.costoAproximado)} (estimado: GitHub da minutos, no importes)`
        : "Nada por encima del cupo: sin cargo",
    porMaquina && `Por máquina — ${porMaquina}. Un minuto de macOS cuesta diez veces uno de Linux.`,
    "Los repos públicos no consumen cuota; lo que se factura son los privados.",
    pct !== null && pct >= AVISO_PCT
      ? `Va en ${pct}% del presupuesto del mes: por eso el importe aparece resaltado.`
      : null,
    data.ciclo !== null && `El ciclo reinicia en ${data.ciclo} días.`,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span
      className={cn(
        "hidden items-center gap-1.5 rounded-md px-2 py-1 text-xs lg:flex",
        tono,
      )}
      title={titulo}
    >
      <Gauge className="h-3.5 w-3.5 shrink-0" />
      <span className="tabular-nums font-medium">{USD(data.costoAproximado)}</span>
      {/* De qué mes es el gasto. Sin eso, un importe en la barra se lee como
          "lo que llevamos" sin más, que puede ser el mes o el año. */}
      {mesCorto(data.periodo) && (
        <span className="opacity-60">{mesCorto(data.periodo)}</span>
      )}
    </span>
  );
}
