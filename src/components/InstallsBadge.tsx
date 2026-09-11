import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, Smartphone, Apple, TrendingUp, Clock, AlertTriangle, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/timeUtils";
import { getPlayTracks } from "@/lib/playTracks";
import { getGa4Installs, ultimosDias, type DiaInstalls } from "@/lib/ga4Installs";
import { DescargasModal } from "./DescargasModal";
import { compacto, exacto, fechaCorta, getAppStoreInstalls, getPlayInstalls } from "@/lib/storeInstalls";

interface Props {
  androidPackage?: string;
  iosBundleId?: string;
  /** Proyecto del dashboard: con él se leen las instalaciones diarias de GA4. */
  projectId?: string;
  /** Descargas leídas a mano de las consolas, como piso del número. */
  installsManual?: { android?: number; ios?: number; fecha?: string };
  /** App de Codemagic, para el consumo que se enseña en el modal. */
  codemagicAppId?: string;
  /** Nombre de la app, para el título del modal. */
  nombre?: string;
}

/**
 * Instalaciones día a día, en barras apiladas: abajo Android, arriba iOS.
 *
 * Es lo único que responde "¿cuántas se bajaron ayer?", que es la pregunta que
 * ninguna tienda contesta a tiempo —Play publica por mes cerrado— y por eso
 * vive aquí aunque la fuente sea GA4 y no la tienda.
 */
function BarrasDiarias({ dias }: { dias: DiaInstalls[] }) {
  const max = Math.max(1, ...dias.map((d) => d.android + d.ios));
  return (
    <div className="flex h-10 items-end gap-px">
      {dias.map((d) => {
        const total = d.android + d.ios;
        const alto = total === 0 ? 2 : Math.max(3, Math.round((total / max) * 40));
        const fecha = new Date(`${d.fecha}T12:00:00Z`).toLocaleDateString("es-MX", {
          day: "numeric", month: "short", timeZone: "UTC",
        });
        return (
          <span
            key={d.fecha}
            title={`${fecha}: ${total} (${d.android} Android · ${d.ios} iOS)`}
            className="flex flex-1 cursor-help flex-col-reverse justify-start"
            style={{ height: `${alto}px` }}
          >
            {/* Un día sin instalaciones deja una raya gris: sin ella, el hueco
                se lee como "no hay dato" en vez de "ese día nadie la bajó". */}
            {total === 0 ? (
              <span className="h-[2px] w-full rounded-sm bg-muted-foreground/25" />
            ) : (
              <>
                <span
                  className="w-full rounded-b-sm bg-lime-500/80"
                  style={{ flexGrow: d.android || 0.001 }}
                />
                <span
                  className="w-full rounded-t-sm bg-sky-500/80"
                  style={{ flexGrow: d.ios || 0.001 }}
                />
              </>
            )}
          </span>
        );
      })}
    </div>
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
export function InstallsBadge({
  androidPackage, iosBundleId, projectId, installsManual, codemagicAppId, nombre,
}: Props) {
  const [detalle, setDetalle] = useState(false);
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
  // Instalaciones diarias (GA4). Es la única fuente con día a día de las dos
  // plataformas: las tiendas publican por mes cerrado o con un día de retraso.
  const { data: ga4 } = useQuery({
    queryKey: ["ga4-installs", projectId],
    queryFn: () => getGa4Installs(projectId!),
    enabled: !!projectId,
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
  // Por plataforma gana el número más alto entre lo automático y lo leído a
  // mano en la consola: las fuentes automáticas van por detrás —Play publica
  // por mes cerrado— y enseñar 10 cuando la consola dice 17 es contradecir a
  // la fuente oficial. Nunca se suman: serían los mismos usuarios dos veces.
  const manualAndroid = installsManual?.android ?? 0;
  const manualIos = installsManual?.ios ?? 0;
  const androidTotal = Math.max(dPlay?.descargas ?? 0, manualAndroid);
  const iosTotal = Math.max(dIos?.descargas ?? 0, manualIos);
  const total = androidTotal + iosTotal;
  const mes30 = (dPlay?.descargas30d ?? 0) + (dIos?.descargas30d ?? 0);
  const dGa4 = ga4?.data && !ga4.data.pendiente ? ga4.data : null;
  // De dónde salen las barras: GA4 trae las dos plataformas, y sin él queda la
  // serie diaria de Apple, que es la única tienda que publica por día.
  const serieDiaria: DiaInstalls[] | null = dGa4
    ? ultimosDias(dGa4.dias, 21)
    : dIos?.serie?.length
      ? ultimosDias(dIos.serie.map((d) => ({ fecha: d.fecha, android: 0, ios: d.descargas })), 21)
      : null;
  const rangoPlay = !dPlay ? playTracks?.storeDownloads ?? null : null;
  const hayDato = !!dPlay || (!!dIos && !dIos.pendiente) || total > 0;
  // Sin dato PERO con algo que contar (un error de la tienda, o Apple todavía
  // generando el reporte), el chip se queda en pantalla con un guión: esconderlo
  // hacía que "no hay descargas" y "no se pudieron leer" se vieran igual, o sea
  // igual que no haber puesto nada.
  const pendiente = !hayDato && (!!play?.error || !!ios?.error || !!dIos?.pendiente);
  if (!hayDato && !pendiente && !rangoPlay && !dGa4) return null;

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
      <button
        type="button"
        onClick={() => projectId && setDetalle(true)}
        disabled={!projectId}
        title={projectId ? "Ver el detalle diario y el consumo en Codemagic" : undefined}
        className={cn(
          "flex items-center gap-1 rounded-md border px-1.5 py-1 font-mono transition-colors",
          projectId ? "cursor-pointer" : "cursor-default",
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
      </button>

      {detalle && projectId && (
        <DescargasModal
          projectId={projectId}
          codemagicAppId={codemagicAppId}
          nombre={nombre ?? "la app"}
          onClose={() => setDetalle(false)}
        />
      )}

      {open && pos && createPortal(
        <div
          style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 9999 }}
          className="w-64 rounded-lg border bg-background p-2.5 text-xs shadow-xl"
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          {/* El panel enseña NÚMEROS; el porqué de cada uno vive en su `title`.
              Con las explicaciones a la vista —de dónde sale el dato, cuándo
              publica Play su informe, qué está generando Apple— el tooltip
              eran seis renglones de prosa para tres cifras, y encima cuentan
              una situación temporal: en cuanto Analytics reporte a diario, esos
              avisos sobran. */}
          <p className="mb-1.5 flex items-center justify-between gap-2 font-semibold">
            <span className="flex items-center gap-1">
              <Download className={cn("h-3 w-3", pendiente ? "text-muted-foreground" : "text-violet-500")} />
              descargas
            </span>
            <span className="font-mono">
              {hayDato ? exacto(total) : rangoPlay ?? "—"}
            </span>
          </p>

          <div className="space-y-1 text-[11px]">
            {(dPlay || manualAndroid > 0) && (
              <p
                className="flex items-center justify-between gap-2"
                title={
                  dPlay
                    ? `Informe de Play Console, hasta ${fechaCorta(dPlay.hasta)}. ` +
                      `${exacto(dPlay.activos)} aparatos la tienen hoy · ${exacto(dPlay.desinstalaciones)} desinstalaciones. ` +
                      "Play publica un informe por mes cerrado, así que lo posterior a esa fecha no está aquí."
                    : `Leído en Play Console${installsManual?.fecha ? ` el ${fechaCorta(installsManual.fecha)}` : ""}: ` +
                      "usuarios con la app instalada. El informe automático llega al cierre del mes."
                }
              >
                <span className="flex cursor-help items-center gap-1.5 text-muted-foreground">
                  <Smartphone className="h-3 w-3" /> Google Play
                </span>
                <span className="font-mono">{exacto(androidTotal)}</span>
              </p>
            )}

            {((dIos && !dIos.pendiente) || manualIos > 0) && (
              <p
                className="flex items-center justify-between gap-2"
                title={
                  dIos && !dIos.pendiente
                    ? `Reportes de App Store Connect desde ${fechaCorta(dIos.desde)}. ` +
                      `${exacto(dIos.primeraVez)} de primera vez · ${exacto(dIos.redescargas)} redescargas.`
                    : `Leído en App Store Connect${installsManual?.fecha ? ` el ${fechaCorta(installsManual.fecha)}` : ""}: ` +
                      "primeras descargas. Apple todavía está generando el reporte automático."
                }
              >
                <span className="flex cursor-help items-center gap-1.5 text-muted-foreground">
                  <Apple className="h-3 w-3" /> App Store
                </span>
                <span className="font-mono">{exacto(iosTotal)}</span>
              </p>
            )}

            {mes30 > 0 && (
              <p
                className="flex items-center justify-between gap-2"
                title="Descargas nuevas en los últimos 30 días, según los informes de las tiendas"
              >
                <span className="flex cursor-help items-center gap-1.5 text-muted-foreground">
                  <TrendingUp className="h-3 w-3" /> últimos 30 días
                </span>
                <span className="font-mono">+{exacto(mes30)}</span>
              </p>
            )}

            {serieDiaria && (
              <div className="mt-1.5 border-t pt-1.5">
                <p className="mb-1 flex items-center justify-between gap-2">
                  <span
                    className="flex cursor-help items-center gap-1.5 text-muted-foreground"
                    title={
                      dGa4
                        ? "Primeras aperturas por día, medidas dentro de la app (Analytics). Quien descarga y no abre no cuenta."
                        : "Descargas por día del App Store. Google Play no publica día a día: su informe sale al cierre del mes."
                    }
                  >
                    <BarChart3 className="h-3 w-3" /> día a día
                  </span>
                  <span className="flex items-center gap-2 font-mono">
                    {dGa4 && (
                      <span className="flex items-center gap-1" title="Android · últimos 30 días">
                        <span className="h-2 w-2 rounded-sm bg-lime-500/80" />
                        {exacto(dGa4.android30d)}
                      </span>
                    )}
                    <span className="flex items-center gap-1" title="iOS · últimos 30 días">
                      <span className="h-2 w-2 rounded-sm bg-sky-500/80" />
                      {exacto(dGa4 ? dGa4.ios30d : dIos?.descargas30d ?? 0)}
                    </span>
                  </span>
                </p>
                <BarrasDiarias dias={serieDiaria} />
              </div>
            )}

            {/* Lo que sigue solo sale cuando hay algo roto o a medias: son
                estados que se resuelven y no deben ocupar sitio el resto del
                tiempo. */}
            {!hayDato && rangoPlay && (
              <p
                className="cursor-help text-[10px] text-muted-foreground"
                title="El número exacto sale de los informes de Play Console, que se publican al cierre del mes siguiente al lanzamiento."
              >
                Rango de la ficha pública de Play.
              </p>
            )}

            {dIos?.pendiente && !manualIos && (
              <p className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
                <Clock className="mt-px h-3 w-3 shrink-0" />
                App Store: Apple está generando el reporte.
              </p>
            )}

            {errores.map((e) => (
              <p
                key={e}
                title={e}
                className="flex cursor-help items-start gap-1.5 text-[10px] text-amber-600 dark:text-amber-400"
              >
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                <span className="line-clamp-2">{e}</span>
              </p>
            ))}

            {revisado && (
              <p className="mt-1.5 border-t pt-1.5 text-[10px] text-muted-foreground">
                actualizado {formatDistanceToNow(revisado)}
              </p>
            )}
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
