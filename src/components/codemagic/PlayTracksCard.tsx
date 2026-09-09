import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, AlertCircle, ExternalLink, Store } from "lucide-react";
import {
  getPlayTracks, triggerPlayTracksSync, trackMeta, releaseStatusInfo, playChannels,
} from "@/lib/playTracks";
import { formatDistanceToNow } from "@/lib/timeUtils";
import type { Project } from "@/lib/firestoreProjects";
import { CanalesTienda, type CanalTienda } from "./CanalesTienda";

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

  const canales = playChannels(data);
  // Los canales de Play en la forma que pinta la fila compartida con iOS: el
  // camino es el mismo en las dos tiendas y el color tiene que significar lo
  // mismo en las dos filas.
  const canalesUi: CanalTienda[] = canales.map((c) => ({
    key: c.key,
    label: c.label,
    etapa: c.key === "interna" ? "pruebas" : c.key === "revision" ? "revision" : "produccion",
    version: c.version,
    build: c.build ?? null,
    estado: c.estado,
    vacio: c.vacio,
    link: c.linkKind ? project[c.linkKind] ?? null : null,
    linkTitle: "Link de invitación para testers de este canal",
  }));
  // Los tracks de prueba que no son el interno (Alpha, Beta abierta): siguen
  // existiendo y tienen su link de invitación, pero no son una etapa del camino
  // a producción, así que van debajo y en pequeño.
  const otrosTracks = (data?.tracks ?? []).filter(
    (t) => t.track.toLowerCase() !== "internal" && t.track.toLowerCase() !== "production" && (t.releases ?? []).length > 0,
  );

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <Store className="h-3.5 w-3.5" />
          Google Play · canales
        </h4>
        <span className="font-mono text-[10px] text-muted-foreground">{pkg}</span>
        <span className="flex-1" />
        <a
          href="https://play.google.com/console"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-0.5 text-[10px] text-muted-foreground underline hover:text-foreground"
          title="Play Console — ahí vive el detalle de la revisión (Google no lo expone por API)"
        >
          Play Console <ExternalLink className="h-2.5 w-2.5" />
        </a>
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

      <p className="mb-1.5 text-[10px] text-muted-foreground">
        Qué versión está en cada canal de Android. Google no expone por API si terminó de revisar
        un envío —lo da por "publicado" desde que se manda—, así que la de producción se lee de la
        ficha pública de Play: es la que la gente puede bajar hoy.
      </p>

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
      ) : (
        <>
          <CanalesTienda canales={canalesUi} />

          {otrosTracks.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
              {otrosTracks.map((t) => {
                const meta = trackMeta(t.track);
                const link = meta.linkKind ? project[meta.linkKind] : null;
                const rel = t.releases?.[0];
                const st = releaseStatusInfo(rel?.status);
                return (
                  <span key={t.track} className="flex items-center gap-1">
                    {meta.label}:
                    <span className="font-mono text-foreground/80">{rel?.name ?? "—"}</span>
                    {rel?.versionCodes?.length ? <span>build {rel.versionCodes.join(", ")}</span> : null}
                    <span>· {st.label}</span>
                    {link && (
                      <a href={link} target="_blank" rel="noreferrer" className="text-primary underline">
                        invitación
                      </a>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
