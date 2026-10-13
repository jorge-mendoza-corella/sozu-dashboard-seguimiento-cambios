import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Loader2, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { reintentarDocs, type DocsStatus, type EstadoDocs } from "@/lib/github";
import { AYUDA_CAUSA, ETIQUETA_CAUSA, falloDocs, type FalloDocs } from "@/lib/docsFallo";
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

function titulo({ estado, run }: DocsStatus, fallo?: FalloDocs | null): string {
  const cuando = formatDistanceToNow(run.updatedAt ?? run.createdAt);
  switch (estado) {
    case "ok":
      return `Documentación generada del último commit de main (${cuando}).`;
    case "actualizando":
      return `Regenerando la documentación (empezó ${formatDistanceToNow(run.runStartedAt ?? run.createdAt)}). Tarda varios minutos.`;
    case "fallo":
      if (fallo && fallo.causa !== "otro") return `${AYUDA_CAUSA[fallo.causa]} (falló ${cuando}). Clic para ver el log.`;
      return `El último intento de generar la documentación terminó en «${run.conclusion ?? "?"}» (${cuando}).${fallo?.detalle ? ` ${fallo.detalle}` : ""} Clic para ver el log.`;
    case "desactualizada":
      return `main avanzó después de la última documentación generada (${cuando}) y no hay run para el commit nuevo.`;
  }
}

export function DocsStatusDot({ docs, owner, repo, onRefetch }: {
  docs: DocsStatus;
  owner: string;
  repo: string;
  onRefetch?: () => void;
}) {
  const tema = TEMA[docs.estado];
  const runId = docs.run.runId;
  // La causa sale del log del job: solo se pide en runs fallidos y no cambia.
  const { data: fallo } = useQuery({
    queryKey: ["docs-fallo", owner, repo, runId],
    queryFn: () => falloDocs(owner, repo, runId!),
    enabled: docs.estado === "fallo" && !!runId,
    staleTime: Infinity,
    retry: false,
  });
  const [reintentando, setReintentando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sin onRefetch (tarjeta de solo lectura) no se ofrece reintentar.
  const puedeReintentar = !!onRefetch && (docs.estado === "fallo" || docs.estado === "desactualizada");
  const etiqueta = (docs.estado === "fallo" && fallo && ETIQUETA_CAUSA[fallo.causa]) || tema.etiqueta;

  const reintentar = async () => {
    setReintentando(true);
    setError(null);
    try {
      await reintentarDocs(owner, repo, docs.run);
      // GitHub tarda unos segundos en crear el run nuevo.
      setTimeout(() => onRefetch?.(), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReintentando(false);
    }
  };

  return (
    <span className="ml-auto inline-flex items-center gap-1 normal-case tracking-normal">
      <a
        href={docs.run.url}
        target="_blank"
        rel="noopener noreferrer"
        title={titulo(docs, fallo)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium no-underline hover:bg-muted transition-colors",
          tema.texto,
        )}
      >
        <span className="relative flex h-2 w-2 shrink-0">
          <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping motion-reduce:animate-none", tema.halo)} />
          <span className={cn("relative inline-flex h-2 w-2 rounded-full", tema.punto)} />
        </span>
        <BookOpen className="h-3 w-3 shrink-0" />
        {etiqueta}
      </a>
      {puedeReintentar && (
        <button
          type="button"
          onClick={reintentar}
          disabled={reintentando}
          title={error ?? "Volver a generar la documentación desde main"}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-muted disabled:opacity-60",
            error ? "border-red-300 text-red-700 dark:border-red-800 dark:text-red-300" : "border-border text-muted-foreground",
          )}
        >
          {reintentando ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
          {error ? "No se pudo" : "Reintentar"}
        </button>
      )}
    </span>
  );
}
