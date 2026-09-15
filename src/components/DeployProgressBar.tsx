import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { progresoDe, textoTipico } from "@/lib/deployProgress";
import type { WorkflowRun } from "@/lib/github";

// ---------------------------------------------------------------------------
// La barra de un deploy en curso.
//
// Sustituye al spinner de siempre, que solo decía "algo pasa". Aquí se ve
// cuánto lleva, cuánto suele tardar y a qué altura va — que es lo que decide
// si uno se queda mirando o se va a hacer otra cosa.
//
// Se usa igual para dev y para producción; cambia el color, no el mecanismo.
// ---------------------------------------------------------------------------

/** Un reloj para toda la pantalla: una barra por tarjeta sería un timer por tarjeta. */
function useSegundero(activo: boolean): number {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    if (!activo) return;
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activo]);
  return ahora;
}

const TEMA = {
  prd: {
    track: "bg-emerald-500/15",
    bar: "from-emerald-500 to-emerald-400",
    texto: "text-emerald-700 dark:text-emerald-300",
  },
  dev: {
    track: "bg-sky-500/15",
    bar: "from-sky-500 to-sky-400",
    texto: "text-sky-700 dark:text-sky-300",
  },
  // Encima del banner verde de PRD: cualquier color de marca se pierde, el
  // blanco es lo único que contrasta.
  banner: {
    track: "bg-white/20",
    bar: "from-white to-white/80",
    texto: "text-white",
  },
} as const;

/** El cronómetro suelto, para cuando la barra va en otro sitio de la tarjeta. */
export function RelojDeploy({ run, className }: { run: WorkflowRun; className?: string }) {
  const ahora = useSegundero(true);
  const p = progresoDe(run, undefined, ahora);
  return (
    <span className={cn("shrink-0 font-mono text-sm font-semibold tabular-nums text-white", className)}>
      {p.enCola ? "en cola" : p.reloj}
    </span>
  );
}

export function DeployProgressBar({
  run,
  terminados,
  destino,
  compacto = false,
  enBannerOscuro = false,
  className,
}: {
  run: WorkflowRun;
  /** Deploys buenos anteriores, para saber cuánto suele tardar. */
  terminados?: WorkflowRun[];
  destino: "prd" | "dev";
  /** Solo la barra, sin textos: para donde no hay sitio. */
  compacto?: boolean;
  /** Sobre el banner de color, donde el único color legible es el blanco. */
  enBannerOscuro?: boolean;
  className?: string;
}) {
  const ahora = useSegundero(true);
  const p = progresoDe(run, terminados, ahora);
  const tema = enBannerOscuro ? TEMA.banner : TEMA[destino];

  return (
    <div className={cn("w-full", className)}>
      <div className={cn("h-1.5 overflow-hidden rounded-full", tema.track)}>
        {p.pct !== null ? (
          <div
            className={cn(
              "h-full rounded-full bg-gradient-to-r transition-[width] duration-1000",
              tema.bar,
            )}
            style={{ width: `${p.pct}%` }}
          />
        ) : (
          // Sin historial con qué comparar, o todavía en cola: se mueve para
          // decir que sigue vivo, pero no finge saber cuánto falta.
          <div
            className={cn(
              "h-full w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-gradient-to-r",
              tema.bar,
            )}
          />
        )}
      </div>

      {!compacto && (
        <div
          className={cn(
            "mt-1 flex items-center justify-between gap-2 text-[10px]",
            enBannerOscuro ? "text-white/80" : "text-muted-foreground",
          )}
        >
          <span className="tabular-nums">
            {p.enCola ? "esperando runner" : p.reloj}
            {p.tipicoMs && !p.enCola && <> · {textoTipico(p.tipicoMs)}</>}
          </span>
          {p.tarde ? (
            <span className={cn("font-medium", tema.texto)}>tardando más de lo normal</span>
          ) : (
            p.pct !== null && <span className="tabular-nums">{p.pct}%</span>
          )}
        </div>
      )}
    </div>
  );
}
