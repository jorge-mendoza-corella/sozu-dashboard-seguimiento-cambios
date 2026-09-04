import { Loader2 } from "lucide-react";
import { useCodemagicBuilds } from "@/hooks/useCodemagic";
import { buildStatusInfo, isCodemagicConfigured } from "@/lib/codemagic";
import { describeActiveBuild } from "./ActiveBuildChips";

/**
 * Chip para la pestaña de un proyecto app: dice que hay algo corriendo en
 * Codemagic (construcción, pase a Play interno / TestFlight, o publicación en
 * la tienda) sin tener que abrir la pestaña.
 *
 * Los deploys web ya se avisan desde la página con los datos de GitHub, pero
 * los builds de apps viven en otra API y solo se veían dentro de "Deploy App":
 * una construcción de 20 minutos no se notaba desde fuera.
 *
 * Es un componente aparte porque cada app necesita su propia consulta, y el
 * número de apps es variable: hacerlo en la página obligaría a un hook por
 * proyecto.
 */
export function TabBuildChip({ appId }: { appId: string }) {
  const { data: builds = [] } = useCodemagicBuilds(isCodemagicConfigured ? appId : undefined);
  const corriendo = builds.filter((b) => buildStatusInfo(b.status).isRunning);
  if (corriendo.length === 0) return null;

  const d = describeActiveBuild(corriendo[0]);
  const detalle = corriendo
    .map((b) => { const x = describeActiveBuild(b); return `${x.plat} · ${x.etapa}`; })
    .join(" · ");

  return (
    <span
      title={detalle}
      className="inline-flex items-center gap-0.5 rounded bg-blue-100 px-1 py-0.5 text-[9px] font-bold text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
    >
      <Loader2 className="h-2.5 w-2.5 animate-spin" />
      {corriendo.length > 1 ? `${corriendo.length} builds` : d.plat.toUpperCase()}
    </span>
  );
}
