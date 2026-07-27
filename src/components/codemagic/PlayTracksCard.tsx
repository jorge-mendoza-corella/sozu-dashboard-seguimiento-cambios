import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, AlertCircle, ExternalLink, Store } from "lucide-react";
import {
  getPlayTracks, triggerPlayTracksSync, trackMeta, releaseStatusInfo,
} from "@/lib/playTracks";
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
 * Estado en vivo de los tracks de Google Play (interno, cerrada, abierta,
 * producción) para no tener que entrar a Play Console. Los datos los deja un
 * workflow programado en Firestore; aquí solo se leen y se puede forzar el
 * refresco.
 */
export function PlayTracksCard({ project, canRefresh }: { project: Project; canRefresh: boolean }) {
  const pkg = project.androidPackage;
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["play-tracks", pkg],
    queryFn: () => getPlayTracks(pkg!),
    enabled: !!pkg,
    refetchInterval: 5 * 60_000,
  });

  // Mientras corre el workflow, refrescar seguido hasta que cambie updatedAt.
  useEffect(() => {
    if (!syncing) return;
    const started = data?.updatedAt ?? null;
    const iv = window.setInterval(async () => {
      const fresh = await qc.fetchQuery({ queryKey: ["play-tracks", pkg], queryFn: () => getPlayTracks(pkg!) });
      if (fresh?.updatedAt && fresh.updatedAt !== started) {
        setSyncing(false);
        setMsg(null);
      }
    }, 8000);
    const stop = window.setTimeout(() => { setSyncing(false); setMsg("La sincronización está tardando; los datos se actualizarán solos."); }, 3 * 60_000);
    return () => { window.clearInterval(iv); window.clearTimeout(stop); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing]);

  if (!pkg) return null;

  const refresh = async () => {
    setMsg(null);
    setSyncing(true);
    try {
      await triggerPlayTracksSync();
    } catch (e) {
      setSyncing(false);
      setMsg(e instanceof Error ? e.message : "No se pudo disparar la sincronización");
    }
  };

  const conRelease = (data?.tracks ?? []).filter((t) => (t.releases ?? []).length > 0);

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <Store className="h-3.5 w-3.5" />
          Google Play · tracks
        </h4>
        <span className="font-mono text-[10px] text-muted-foreground">{pkg}</span>
        <span className="flex-1" />
        {data?.updatedAt && (
          <span className="text-[10px] text-muted-foreground">
            actualizado {formatDistanceToNow(data.updatedAt)}
          </span>
        )}
        {canRefresh && (
          <button
            type="button"
            onClick={refresh}
            disabled={syncing}
            className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted disabled:opacity-50"
            title="Consulta ahora mismo el estado en Google Play (tarda ~1 min)"
          >
            {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {syncing ? "consultando Play…" : "actualizar"}
          </button>
        )}
      </div>

      {msg && <p className="mb-1.5 text-[11px] text-amber-600 dark:text-amber-400">{msg}</p>}

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
          Aún sin datos. La sincronización corre cada 30 min
          {canRefresh ? ' — o pulsa "actualizar" para consultarlo ahora.' : "."}
        </p>
      ) : conRelease.length === 0 && !data.error ? (
        <p className="text-[11px] text-muted-foreground">Ningún track tiene versiones publicadas todavía.</p>
      ) : (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {conRelease.map((t) => {
            const meta = trackMeta(t.track);
            const link = meta.linkKind ? project[meta.linkKind] : null;
            return (
              <div key={t.track} className="rounded-lg border bg-muted/30 p-2">
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold">{meta.label}</span>
                  {link && (
                    <a
                      href={link}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-0.5 text-[10px] text-primary underline"
                      title="Link de invitación para testers de este track"
                    >
                      invitación <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </div>
                <div className="space-y-1">
                  {(t.releases ?? []).map((r, i) => {
                    const st = releaseStatusInfo(r.status);
                    return (
                      <div key={i} className="flex flex-wrap items-center gap-1.5 text-[10px]">
                        <span className={cn("rounded px-1.5 py-0.5 font-semibold", STATUS_CLASSES[st.tone])}>
                          {st.label}
                        </span>
                        <span className="font-mono">{r.name ?? "—"}</span>
                        {r.versionCodes?.length ? (
                          <span className="text-muted-foreground">build {r.versionCodes.join(", ")}</span>
                        ) : null}
                        {typeof r.userFraction === "number" && (
                          <span className="text-muted-foreground">{Math.round(r.userFraction * 100)}% usuarios</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
