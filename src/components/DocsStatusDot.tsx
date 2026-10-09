import { BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DocsStatus, EstadoDocs } from "@/lib/github";
import { formatDistanceToNow } from "@/lib/timeUtils";

/**
 * Punto de la documentación automática (sozu-docs) de un repo.
 *
 * Verde: al día con main. Azul: regenerándose. Rojo: el último run falló o main
 * avanzó sin que se regenerara. Los tres parpadean a propósito: el verde dice
 * "está viva", no solo "alguna vez funcionó".
 */
const TEMA: Record<EstadoDocs, { punto: string; halo: string; texto: string; etiqueta: string }> = {
  ok: {
    punto: "bg-emerald-500",
    halo: "bg-emerald-400 [animation-duration:2.5s]",
    texto: "text-emerald-700 dark:text-emerald-300",
    etiqueta: "Docs al día",
  },
  actualizando: {
    punto: "bg-sky-500",
    halo: "bg-sky-400 [animation-duration:1s]",
    texto: "text-sky-700 dark:text-sky-300",
    etiqueta: "Docs actualizando",
  },
  fallo: {
    punto: "bg-red-500",
    halo: "bg-red-400 [animation-duration:1.2s]",
    texto: "text-red-700 dark:text-red-300",
    etiqueta: "Docs fallaron",
  },
  desactualizada: {
    punto: "bg-red-500",
    halo: "bg-red-400 [animation-duration:1.2s]",
    texto: "text-red-700 dark:text-red-300",
    etiqueta: "Docs desactualizadas",
  },
};

function titulo({ estado, run }: DocsStatus): string {
  const cuando = formatDistanceToNow(run.updatedAt ?? run.createdAt);
  switch (estado) {
    case "ok":
      return `Documentación generada del último commit de main (${cuando}).`;
    case "actualizando":
      return `Regenerando la documentación (empezó ${formatDistanceToNow(run.runStartedAt ?? run.createdAt)}). Tarda varios minutos.`;
    case "fallo":
      return `El último intento de generar la documentación terminó en «${run.conclusion ?? "?"}» (${cuando}). Si es un 401, la ANTHROPIC_API_KEY del repo está vencida. Clic para ver el log.`;
    case "desactualizada":
      return `main avanzó después de la última documentación generada (${cuando}) y no hay run para el commit nuevo.`;
  }
}

export function DocsStatusDot({ docs }: { docs: DocsStatus }) {
  const tema = TEMA[docs.estado];
  return (
    <a
      href={docs.run.url}
      target="_blank"
      rel="noopener noreferrer"
      title={titulo(docs)}
      className={cn(
        "ml-auto inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal no-underline hover:bg-muted transition-colors",
        tema.texto,
      )}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping motion-reduce:animate-none", tema.halo)} />
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", tema.punto)} />
      </span>
      <BookOpen className="h-3 w-3 shrink-0" />
      {tema.etiqueta}
    </a>
  );
}
