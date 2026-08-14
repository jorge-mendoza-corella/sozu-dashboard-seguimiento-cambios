import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe, ExternalLink, Copy, Check, Smartphone, Apple } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/timeUtils";
import type { FrontVersion } from "@/lib/frontVersions";
import { getPlayTracks, playPublishedVersion, releaseStatusInfo } from "@/lib/playTracks";
import { getAppStoreStatus, appStoreLiveVersion, versionStateInfo } from "@/lib/appStoreStatus";

interface Props {
  /** URL del front. Sin ella no se pinta nada: el repo no es front. */
  frontUrl?: string;
  /** Versión que sirve el sitio, según el último barrido del sync. */
  frontVersion?: FrontVersion | null;
  /** Solo apps: paquete de Android, para la versión publicada en Play. */
  androidPackage?: string;
  /** Solo apps: bundle id de iOS, para la versión a la venta en el App Store. */
  iosBundleId?: string;
}

/**
 * Barra del front de un repo: abrir el sitio, copiar la URL y qué versión está
 * sirviendo. En las apps se añaden las versiones publicadas en las tiendas, para
 * ver de un golpe si la web va por delante de lo que tiene la gente instalado.
 */
export function FrontInfoBar({ frontUrl, frontVersion, androidPackage, iosBundleId }: Props) {
  const [copiado, setCopiado] = useState(false);

  const { data: play } = useQuery({
    queryKey: ["play-tracks", androidPackage],
    queryFn: () => getPlayTracks(androidPackage!),
    enabled: !!androidPackage,
    staleTime: 5 * 60_000,
  });
  const { data: appStore } = useQuery({
    queryKey: ["appstore-status", iosBundleId],
    queryFn: () => getAppStoreStatus(iosBundleId!),
    enabled: !!iosBundleId,
    staleTime: 5 * 60_000,
  });

  if (!frontUrl) return null;

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(frontUrl);
    } catch {
      // Sin permiso de portapapeles (o http): respaldo con un input temporal.
      const tmp = document.createElement("input");
      tmp.value = frontUrl;
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand("copy");
      tmp.remove();
    }
    setCopiado(true);
    window.setTimeout(() => setCopiado(false), 1500);
  };

  const bonito = frontUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const version = frontVersion?.version ?? null;
  const revisado = frontVersion?.checkedAt ? `revisado ${formatDistanceToNow(frontVersion.checkedAt)}` : "sin revisar aún";
  const versionTitle = version
    ? `Versión que sirve ${bonito}: ${version}\n${revisado}` +
      (frontVersion?.source ? ` · leída de ${frontVersion.source}` : "")
    : `No se pudo leer la versión de ${bonito}\n${revisado}` +
      (frontVersion?.error ? `\n${frontVersion.error}` : "");

  const playPub = playPublishedVersion(play);
  const iosVersion = appStoreLiveVersion(appStore);
  const esApp = !!androidPackage || !!iosBundleId;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <a
        href={frontUrl}
        target="_blank"
        rel="noreferrer"
        title={`Abrir ${bonito} en otra ventana`}
        className="flex min-w-0 items-center gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-2 py-1 font-medium text-sky-700 no-underline transition-colors hover:bg-sky-100 dark:border-sky-800/60 dark:bg-sky-950/40 dark:text-sky-300 dark:hover:bg-sky-900/50"
      >
        <Globe className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{bonito}</span>
        <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
      </a>

      <button
        type="button"
        onClick={copiar}
        title={copiado ? "URL copiada" : "Copiar la URL"}
        aria-label="Copiar la URL del front"
        className={cn(
          "rounded-md border p-1 transition-colors",
          copiado
            ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        {copiado ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>

      {/* Versión del sitio, pegada al link: es la pregunta que sigue a "¿cuál es la URL?" */}
      <span
        title={versionTitle}
        className={cn(
          "rounded-md border px-1.5 py-1 font-mono",
          version
            ? "border-transparent bg-muted text-foreground/80"
            : "border-dashed border-muted-foreground/40 text-muted-foreground",
        )}
      >
        {esApp && <span className="mr-1 font-sans text-[10px] uppercase text-muted-foreground">web</span>}
        {version ?? "—"}
      </span>

      {esApp && (
        <>
          {androidPackage && (
            <span
              title={
                play?.error
                  ? `No se pudo leer Google Play: ${play.error}`
                  : playPub
                    ? `Google Play · track ${playPub.track}` +
                      (playPub.status ? ` · ${releaseStatusInfo(playPub.status).label}` : "") +
                      (playPub.esProduccion ? "" : " (aún no está en producción)")
                    : "Aún no hay ninguna versión subida a Google Play, o falta la cuenta de servicio para leerlo"
              }
              className={cn(
                "flex items-center gap-1 rounded-md border border-transparent bg-muted px-1.5 py-1 font-mono text-foreground/80",
                // Lo que no está en producción no es lo que la gente tiene
                // instalado: se distingue en lugar de darlo por publicado.
                playPub && !playPub.esProduccion && "border-dashed border-muted-foreground/40",
              )}
            >
              <Smartphone className="h-3 w-3 text-muted-foreground" />
              {playPub?.version ?? "—"}
              {playPub && !playPub.esProduccion && (
                <span className="font-sans text-[10px] text-muted-foreground">{playPub.track}</span>
              )}
            </span>
          )}
          {iosBundleId && (
            <span
              title={
                appStore?.error
                  ? `No se pudo leer App Store Connect: ${appStore.error}`
                  : iosVersion
                    ? (iosVersion.aLaVenta ? "A la venta en el App Store" : "Enviada al App Store, aún no a la venta") +
                      `: ${iosVersion.version}` +
                      (iosVersion.state ? ` · ${versionStateInfo(iosVersion.state).label}` : "")
                    : "Aún no hay ninguna versión en App Store Connect, o falta la llave para leerlo"
              }
              className={cn(
                "flex items-center gap-1 rounded-md border border-transparent bg-muted px-1.5 py-1 font-mono text-foreground/80",
                iosVersion && !iosVersion.aLaVenta && "border-dashed border-muted-foreground/40",
              )}
            >
              <Apple className="h-3 w-3 text-muted-foreground" />
              {iosVersion?.version ?? "—"}
            </span>
          )}
        </>
      )}
    </div>
  );
}
