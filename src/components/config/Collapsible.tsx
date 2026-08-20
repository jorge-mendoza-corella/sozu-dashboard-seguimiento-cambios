import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Flechita de plegado; decorativa — el `title` va en el botón que la contiene.
 * El estado vive en `useAbiertos` (src/hooks), no aquí: un archivo que exporta
 * componente y hook a la vez rompe el fast refresh de Vite.
 */
export function ChevronPlegar({ abierto, className }: { abierto: boolean; className?: string }) {
  const Icono = abierto ? ChevronDown : ChevronRight;
  return <Icono className={cn("h-4 w-4 shrink-0 text-muted-foreground", className)} aria-hidden />;
}
