import { useQuery } from "@tanstack/react-query";
import { Loader2, AlertCircle, Apple, ExternalLink } from "lucide-react";
import { getAppStoreStatus, versionStateInfo, buildStateLabel } from "@/lib/appStoreStatus";
import { formatDistanceToNow } from "@/lib/timeUtils";
import type { Project } from "@/lib/firestoreProjects";
import { cn } from "@/lib/utils";

const STATUS_CLASSES: Record<string, string> = {
  success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  running: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  draft: "bg-muted text-muted-foreground",
  halted: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
};

/**
 * Estado de la app en App Store Connect: en qué punto de la revisión va cada
 * versión y qué builds subieron. Lo alimenta el mismo workflow programado que
 * los tracks de Play.
 */
export function AppStoreStatusCard({ project }: { project: Project }) {
  const bundle = project.iosBundleId;
  const { data, isLoading } = useQuery({
    queryKey: ["appstore-status", bundle],
    queryFn: () => getAppStoreStatus(bundle!),
    enabled: !!bundle,
    refetchInterval: 5 * 60_000,
  });

  if (!bundle) return null;

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <Apple className="h-3.5 w-3.5" />
          App Store · revisión
        </h4>
        <span className="font-mono text-[10px] text-muted-foreground">{bundle}</span>
        <span className="flex-1" />
        {data?.updatedAt && (
          <span className="text-[10px] text-muted-foreground">actualizado {formatDistanceToNow(data.updatedAt)}</span>
        )}
        <a
          href="https://appstoreconnect.apple.com/apps"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-0.5 text-[10px] text-muted-foreground underline hover:text-foreground"
        >
          App Store Connect <ExternalLink className="h-2.5 w-2.5" />
        </a>
      </div>

      {data?.error && (
        <p className="mb-1.5 flex items-start gap-1.5 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{data.error}</span>
        </p>
      )}

      {isLoading ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> leyendo estado…
        </p>
      ) : !data ? (
        <p className="text-[11px] text-muted-foreground">
          Aún sin datos. La sincronización corre cada 30 min — o pulsa "actualizar" arriba.
        </p>
      ) : data.versions.length === 0 && !data.error ? (
        <p className="text-[11px] text-muted-foreground">Sin versiones en App Store Connect todavía.</p>
      ) : (
        <div className="space-y-1.5">
          {data.versions.slice(0, 2).map((v, i) => {
            const st = versionStateInfo(v.state);
            return (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2 text-[11px]">
                <span className="font-semibold">v{v.version ?? "—"}</span>
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", STATUS_CLASSES[st.tone])}>
                  {st.label}
                </span>
                {v.createdDate && (
                  <span className="text-[10px] text-muted-foreground">creada {formatDistanceToNow(v.createdDate)}</span>
                )}
              </div>
            );
          })}
          {data.builds.length > 0 && (
            <p className="text-[10px] text-muted-foreground">
              Último build subido: {data.builds[0].version ?? "—"} · {buildStateLabel(data.builds[0].processingState)}
              {data.builds[0].uploadedDate && ` · ${formatDistanceToNow(data.builds[0].uploadedDate)}`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
