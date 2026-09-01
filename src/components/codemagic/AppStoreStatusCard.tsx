import { useQuery } from "@tanstack/react-query";
import { Loader2, AlertCircle, Apple, ExternalLink } from "lucide-react";
import { getAppStoreStatus, appStoreChannels, buildStateLabel } from "@/lib/appStoreStatus";
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
 * Qué versión de iOS hay en cada canal: TestFlight, revisión y producción.
 * Mismo formato que los tracks de Play, y lo alimenta el mismo workflow
 * programado.
 *
 * Antes era una sola fila con la versión más reciente de App Store Connect. Esa
 * fila contestaba la pregunta menos útil: enseñaba la que está en revisión y
 * dejaba invisibles las dos que se consultan a diario —qué prueban los testers y
 * qué tiene instalado la gente—, aunque el dato ya estuviera en el documento.
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

  const canales = appStoreChannels(data);
  const ultimo = data?.builds?.[0];

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <Apple className="h-3.5 w-3.5" />
          App Store · canales
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

      <p className="mb-1.5 text-[10px] text-muted-foreground">
        Qué versión está en cada canal de iOS. Un build recién subido lo ven los testers internos
        de inmediato; a los externos solo llega cuando Apple aprueba su revisión de TestFlight.
      </p>

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
      ) : (
        <>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {canales.map((c) => (
              <div key={c.key} className="rounded-lg border bg-muted/30 p-2">
                <div className="mb-1 text-[11px] font-semibold">{c.label}</div>
                {/* El número de build basta para pintar el canal: los documentos
                    escritos por el sync anterior no traen `shortVersion`, y hasta
                    la siguiente sincronización TestFlight se quedaría en blanco
                    teniendo el dato a la mano. */}
                {c.version || c.build ? (
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 font-semibold",
                        STATUS_CLASSES[c.estado.tone],
                      )}
                    >
                      {c.estado.label}
                    </span>
                    {c.version && <span className="font-mono">v{c.version}</span>}
                    {c.build && <span className="text-muted-foreground">build {c.build}</span>}
                    {c.fecha && (
                      <span className="text-muted-foreground">{formatDistanceToNow(c.fecha)}</span>
                    )}
                  </div>
                ) : (
                  <p className="text-[10px] text-muted-foreground">{c.vacio ?? "—"}</p>
                )}
              </div>
            ))}
          </div>

          {ultimo && (
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              Último build subido: {ultimo.shortVersion ? `v${ultimo.shortVersion} · ` : ""}
              build {ultimo.version ?? "—"} · {buildStateLabel(ultimo.processingState)}
              {ultimo.expired && " · expirado"}
              {ultimo.uploadedDate && ` · ${formatDistanceToNow(ultimo.uploadedDate)}`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
