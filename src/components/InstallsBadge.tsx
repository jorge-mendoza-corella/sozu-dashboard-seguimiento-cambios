import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, Smartphone, Apple, TrendingUp, Users, Clock, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/timeUtils";
import { getPlayTracks } from "@/lib/playTracks";
import { compacto, exacto, fechaCorta, getAppStoreInstalls, getPlayInstalls } from "@/lib/storeInstalls";

interface Props {
  androidPackage?: string;
  iosBundleId?: string;
}

/** Fila del tooltip: icono, etiqueta y número alineado a la derecha. */
function Fila({ icon, label, valor, tenue }: {
  icon?: React.ReactNode;
  label: string;
  valor: string;
  tenue?: boolean;
}) {
  return (
    <p className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className={tenue ? "font-mono text-muted-foreground" : "font-mono font-semibold"}>{valor}</span>
    </p>
  );
}

/**
 * Descargas acumuladas de la app, junto a las versiones: la versión dice QUÉ
 * hay publicado y este número, cuánta gente se lo llevó. Suma Play y App Store
 * en un solo chip —que es la pregunta de un vistazo— y deja el desglose por
 * tienda, el mes reciente y las instalaciones activas para el tooltip.
 *
 * Si ninguna tienda tiene dato, no se pinta nada: un "—" más en la fila de
 * versiones sería ruido sin información.
 */
export function InstallsBadge({ androidPackage, iosBundleId }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<number | null>(null);

  const { data: play } = useQuery({
    queryKey: ["play-installs", androidPackage],
    queryFn: () => getPlayInstalls(androidPackage!),
    enabled: !!androidPackage,
    staleTime: 30 * 60_000,
  });
  // Respaldo de Android: el rango que Play enseña en su propia ficha ("10+").
  // Los informes exactos viven en un bucket que Google tarda en abrir —y
  // mientras tanto la tarjeta no tenía NADA que decir de una app que sí se está
  // bajando—. Es aproximado y se dice que lo es.
  const { data: playTracks } = useQuery({
    queryKey: ["play-tracks", androidPackage],
    queryFn: () => getPlayTracks(androidPackage!),
    enabled: !!androidPackage,
    staleTime: 30 * 60_000,
  });
  const { data: ios } = useQuery({
    queryKey: ["appstore-installs", iosBundleId],
    queryFn: () => getAppStoreInstalls(iosBundleId!),
    enabled: !!iosBundleId,
    staleTime: 30 * 60_000,
  });

  // Con `pendiente` hay documento pero no números: Play aún no publica
  // informes de esa app. Se trata como si no hubiera dato, no como error.
  const dPlay = play?.data && !play.data.pendiente ? play.data : null;
  const dIos = ios?.data ?? null;
  const total = (dPlay?.descargas ?? 0) + (dIos?.descargas ?? 0);
  const mes30 = (dPlay?.descargas30d ?? 0) + (dIos?.descargasUltimoMes ?? 0);
  const rangoPlay = !dPlay ? playTracks?.storeDownloads ?? null : null;
  const hayDato = !!dPlay || (!!dIos && !dIos.pendiente);
  // Sin dato PERO con algo que contar (un error de la tienda, o Apple todavía
  // generando el reporte), el chip se queda en pantalla con un guión: esconderlo
  // hacía que "no hay descargas" y "no se pudieron leer" se vieran igual, o sea
  // igual que no haber puesto nada.
  const pendiente = !hayDato && (!!play?.error || !!ios?.error || !!dIos?.pendiente);
  if (!hayDato && !pendiente && !rangoPlay) return null;

  const show = () => {
    if (hideTimer.current) { window.clearTimeout(hideTimer.current); hideTimer.current = null; }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 6, left: Math.max(8, rect.left) });
    setOpen(true);
  };
  const hide = () => { hideTimer.current = window.setTimeout(() => setOpen(false), 120); };

  // De cuándo es el dato: el más reciente de los dos syncs.
  const revisado = [play?.updatedAt, ios?.updatedAt].filter(Boolean).sort().at(-1) as string | undefined;
  // Solo se avisa del error de la tienda que quedó SIN dato: con el número ya
  // en pantalla, un aviso de la corrida anterior solo confunde.
  const errores = [
    !dPlay ? play?.error : null,
    !dIos ? ios?.error : null,
  ].filter(Boolean) as string[];

  return (
    <span ref={anchorRef} onMouseEnter={show} onMouseLeave={hide} className="inline-flex">
      <span
        className={cn(
          "flex cursor-default items-center gap-1 rounded-md border px-1.5 py-1 font-mono transition-colors",
          !hayDato && !rangoPlay
            ? "border-dashed border-muted-foreground/40 text-muted-foreground"
            : "border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-800/60 dark:bg-violet-950/40 dark:text-violet-300 dark:hover:bg-violet-900/50",
        )}
        aria-label={
          hayDato ? `${exacto(total)} descargas` : rangoPlay ? `${rangoPlay} descargas` : "Descargas: todavía sin dato"
        }
      >
        <Download className="h-3 w-3 shrink-0 opacity-80" />
        {hayDato ? compacto(total) : rangoPlay ?? "—"}
      </span>

      {open && pos && createPortal(
        <div
          style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 9999 }}
          className="w-64 rounded-lg border bg-background p-2.5 text-xs shadow-xl"
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <p className="mb-1.5 flex items-center gap-1 font-semibold">
            <Download className={cn("h-3 w-3", pendiente ? "text-muted-foreground" : "text-violet-500")} />
            {hayDato
              ? `${exacto(total)} descargas`
              : rangoPlay
                ? `${rangoPlay} descargas en Google Play`
                : "Descargas: todavía sin dato"}
          </p>

          <div className="space-y-1 text-[11px]">
            {mes30 > 0 && (
              <Fila
                icon={<TrendingUp className="h-3 w-3" />}
                label={dIos && !dPlay ? `en ${fechaCorta(dIos.ultimoMes)}` : "últimos 30 días"}
                valor={`+${exacto(mes30)}`}
              />
            )}

            {/* De dónde sale el rango, para que no se lea como número exacto. */}
            {!dPlay && rangoPlay && (
              <p className="text-[10px] text-muted-foreground">
                Es el rango que Play enseña en la ficha pública de la app. El número exacto sale de
                los informes de Play Console, que se publican al cierre del mes siguiente al
                lanzamiento{play?.data?.pendiente ? " — esta app todavía no tiene ninguno" : ""}.
              </p>
            )}
            {dPlay && (
              <div className="mt-1.5 border-t pt-1.5">
                <p className="mb-1 flex items-center gap-1.5 font-medium">
                  <Smartphone className="h-3 w-3 text-muted-foreground" /> Google Play
                </p>
                <Fila label="descargas" valor={exacto(dPlay.descargas)} />
                <Fila
                  icon={<Users className="h-3 w-3" />}
                  label="instaladas hoy"
                  valor={exacto(dPlay.activos)}
                />
                {/* Sin las desinstalaciones, "descargas" se lee como usuarios
                    que la tienen, y suele haber bastante diferencia. */}
                <Fila label="desinstalaciones" valor={exacto(dPlay.desinstalaciones)} tenue />
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {dPlay.historico
                    ? `total histórico · desglose desde ${fechaCorta(dPlay.desde)}`
                    : `contadas desde ${fechaCorta(dPlay.desde)}`}
                </p>
              </div>
            )}

            {dIos && !dIos.pendiente && (
              <div className="mt-1.5 border-t pt-1.5">
                <p className="mb-1 flex items-center gap-1.5 font-medium">
                  <Apple className="h-3 w-3 text-muted-foreground" /> App Store
                </p>
                <Fila label="primera vez" valor={exacto(dIos.primeraVez)} />
                <Fila label="redescargas" valor={exacto(dIos.redescargas)} tenue />
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  contadas desde {fechaCorta(dIos.desde)}
                </p>
              </div>
            )}

            {/* Apple no entrega analíticas hasta que alguien las pide y tarda
                ~1 día en generarlas: mientras tanto el total es solo de Play. */}
            {dIos?.pendiente && (
              <p className="mt-1.5 flex items-start gap-1.5 border-t pt-1.5 text-[10px] text-muted-foreground">
                <Clock className="mt-px h-3 w-3 shrink-0" />
                App Store: Apple está generando el reporte de descargas (~1 día).
              </p>
            )}

            {errores.map((e) => (
              <p key={e} className="mt-1.5 flex items-start gap-1.5 border-t pt-1.5 text-[10px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                {e}
              </p>
            ))}

            {revisado && (
              <p className="mt-1.5 border-t pt-1.5 text-[10px] text-muted-foreground">
                actualizado {formatDistanceToNow(revisado)} · se revisa una vez al día
              </p>
            )}
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
