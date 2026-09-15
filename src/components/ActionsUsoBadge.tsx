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

  const titulo = [
    `GitHub Actions de ${data.usuario}`,
    data.minutosIncluidos
      ? `${N(data.minutosUsados)} de ${N(data.minutosIncluidos)} minutos del plan${pct !== null ? ` (${pct}%)` : ""}`
      : `${N(data.minutosUsados)} minutos usados`,
    data.minutosPagados
      ? `${N(data.minutosPagados)} minutos por encima del cupo ≈ ${USD(data.costoAproximado)} (estimado: GitHub da minutos, no importes)`
      : "Nada por encima del cupo: sin cargo",
    porMaquina && `Por máquina — ${porMaquina}. Un minuto de macOS cuesta diez veces uno de Linux.`,
    "Los repos públicos no consumen cuota; lo que se factura son los privados.",
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
      <span className="tabular-nums">
        {N(data.minutosUsados)}
        {data.minutosIncluidos > 0 && <span className="opacity-60">/{N(data.minutosIncluidos)}</span>}
        <span className="ml-1 opacity-60">min</span>
      </span>

      {/* La barra solo cuando hay cupo contra el que medir: sin plan incluido,
          un "0%" diría que no se ha gastado nada, que es lo contrario. */}
      {pct !== null && (
        <span className="h-1 w-8 overflow-hidden rounded-full bg-current/20" aria-hidden>
          <span
            className="block h-full rounded-full bg-current transition-[width] duration-700"
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </span>
      )}

      {data.minutosPagados > 0 && (
        <span className="font-medium">{USD(data.costoAproximado)}</span>
      )}
    </span>
  );
}
