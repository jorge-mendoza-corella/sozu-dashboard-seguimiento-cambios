import { Smartphone, Hammer } from "lucide-react";
import { cn } from "@/lib/utils";
import { ActiveBuildChips } from "./ActiveBuildChips";
import { useRezagoTiendas } from "@/hooks/useRezagoTiendas";

// ---------------------------------------------------------------------------
// La pestaña de Deploy App, que además avisa cuando toca usarla.
//
// La web se publica el mismo día que se mergea; las tiendas van por detrás
// hasta que alguien lanza un build. Ese hueco no se veía sin entrar a la
// pestaña, así que la pestaña lo dice desde fuera: en ámbar y con la versión
// que falta subir.
// ---------------------------------------------------------------------------

export function DeployAppTabButton({
  activo,
  onClick,
  codemagicAppId,
  versionWeb,
  androidPackage,
  iosBundleId,
}: {
  activo: boolean;
  onClick: () => void;
  codemagicAppId?: string;
  /** La que sirve el front del proyecto ahora mismo. */
  versionWeb: string | null;
  androidPackage?: string;
  iosBundleId?: string;
}) {
  const rezago = useRezagoTiendas({ versionWeb, androidPackage, iosBundleId });

  const atrasadas = [
    rezago.android?.pendiente ? "Google Play" : null,
    rezago.ios?.pendiente ? "App Store" : null,
  ].filter(Boolean);

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        atrasadas.length
          ? `La web va en ${rezago.versionWeb} y ${atrasadas.join(" y ")} ${
              atrasadas.length > 1 ? "siguen" : "sigue"
            } detrás. Aquí se construye y se sube.`
          : undefined
      }
      className={cn(
        "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors -mb-px",
        activo
          ? "border-primary text-primary"
          // Con algo que construir, la pestaña deja de ser gris: es la única
          // señal de que hay trabajo esperando en una pantalla que no se ve.
          : atrasadas.length
            ? "border-amber-400 text-amber-700 hover:text-amber-800 dark:text-amber-400"
            : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      <Smartphone className="h-4 w-4" />
      Deploy App
      {!!atrasadas.length && (
        <span className="respira-ambar flex items-center gap-1 rounded-full border border-amber-400 bg-amber-50 px-1.5 py-px text-[10px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <Hammer className="h-2.5 w-2.5" />
          {rezago.versionWeb}
        </span>
      )}
      {codemagicAppId && <ActiveBuildChips appId={codemagicAppId} compact />}
    </button>
  );
}
