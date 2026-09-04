import { Loader2 } from "lucide-react";
import { useCodemagicBuilds } from "@/hooks/useCodemagic";
import { buildStatusInfo, isCodemagicConfigured, type CodemagicBuild } from "@/lib/codemagic";
import { cn } from "@/lib/utils";

/** Plataforma + etapa de un build activo, para chips de estado. */
export function describeActiveBuild(b: CodemagicBuild): { plat: string; etapa: string } {
  const wf = b.workflowId ?? "";
  const plat = wf.startsWith("android") ? "Android"
    : wf.startsWith("ios") ? "iOS"
    : wf.startsWith("web") ? "Web"
    : "App";
  const etapa =
    wf === "android-publish" ? "pase a Play interno" :
    wf === "ios-publish" ? "pase a TestFlight" :
    wf === "android-production" ? "pase a Play Store" :
    wf === "ios-appstore" ? "pase a App Store" :
    // Modo simple: construyen Y publican en la tienda en la misma corrida. Sin
    // estas dos lineas caian en "en construccion" y el chip decia que se estaba
    // compilando algo mientras en realidad ya iba camino a la tienda.
    wf === "android-store" ? "publicacion en Play Store" :
    wf === "ios-store" ? "publicacion en App Store" :
    wf === "sync-testflight-testers" ? "sync testers" :
    "en construcción";
  return { plat, etapa };
}

/**
 * Chips pulsantes con los builds de Codemagic EN CURSO de una app:
 * "Android · en construcción", "iOS · pase a TestFlight", etc.
 * No renderiza nada si no hay actividad.
 */
export function ActiveBuildChips({ appId, compact = false }: { appId: string; compact?: boolean }) {
  const { data: builds = [] } = useCodemagicBuilds(isCodemagicConfigured ? appId : undefined);
  const running = builds.filter((b) => buildStatusInfo(b.status).isRunning);
  if (running.length === 0) return null;
  return (
    <>
      {running.map((b) => {
        const d = describeActiveBuild(b);
        return (
          <span
            key={b._id}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border border-blue-300 bg-blue-50 font-medium text-blue-700 dark:border-blue-800/60 dark:bg-blue-950/40 dark:text-blue-300",
              compact ? "px-1.5 py-0 text-[9px]" : "px-2 py-0.5 text-[11px]",
            )}
            title={`${d.plat} — ${d.etapa} (rama ${b.branch})`}
          >
            <Loader2 className={cn("animate-spin", compact ? "h-2.5 w-2.5" : "h-3 w-3")} />
            {d.plat} · {d.etapa}
          </span>
        );
      })}
    </>
  );
}
