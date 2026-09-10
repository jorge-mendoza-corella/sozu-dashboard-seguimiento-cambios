import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Download, Smartphone, Apple, TrendingUp, Users, Clock, AlertTriangle, Trash2, RotateCcw,
  BarChart3,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/timeUtils";
import { getPlayTracks } from "@/lib/playTracks";
import { getGa4Installs, ultimosDias, type DiaInstalls } from "@/lib/ga4Installs";
import { compacto, exacto, fechaCorta, getAppStoreInstalls, getPlayInstalls } from "@/lib/storeInstalls";

interface Props {
  androidPackage?: string;
  iosBundleId?: string;
  /** Proyecto del dashboard: con él se leen las instalaciones diarias de GA4. */
  projectId?: string;
}

/**
 * Una métrica del tooltip: icono y número, sin la palabra.
 *
 * Con las etiquetas escritas, cuatro renglones de texto competían por leerse y
 * la diferencia importante —descargas contra dispositivos con la app hoy— se
 * perdía entre palabras parecidas. El icono la dice sin leer, y el título
 * explica qué cuenta cada número, que es lo que de verdad se pregunta: por qué
 * "instaladas hoy" puede ser mayor que las descargas.
 */
function Metrica({ icon, valor, title, tenue }: {
  icon: React.ReactNode;
  valor: string;
  title: string;
  tenue?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn(
        "flex cursor-help items-center gap-1 rounded px-1 py-0.5",
        tenue ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {icon}
      <span className="font-mono font-semibold">{valor}</span>
    </span>
  );
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
export function InstallsBadge({ androidPackage, iosBundleId, projectId }: Props) {
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
  const total = (dPlay?.descargas ?? 0) + (dIos?.descargas ?? 0);
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
  const hayDato = !!dPlay || (!!dIos && !dIos.pendiente);
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
          className="w-72 rounded-lg border bg-background p-2.5 text-xs shadow-xl"
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
              <Metrica
                icon={<TrendingUp className="h-3 w-3" />}
                valor={`+${exacto(mes30)}`}
                title="Descargas nuevas en los últimos 30 días"
              />
            )}

            {serieDiaria && (
              <div className="mt-1.5 border-t pt-1.5">
                <p className="mb-1 flex items-center justify-between gap-2 font-medium">
                  <span className="flex items-center gap-1.5">
                    <BarChart3 className="h-3 w-3 text-muted-foreground" /> Día a día
                  </span>
                  <span className="flex items-center gap-2 font-normal">
                    {dGa4 && (
                      <span className="flex items-center gap-1" title="Android (últimos 30 días)">
                        <span className="h-2 w-2 rounded-sm bg-lime-500/80" />
                        {exacto(dGa4.android30d)}
                      </span>
                    )}
                    <span className="flex items-center gap-1" title="iOS (últimos 30 días)">
                      <span className="h-2 w-2 rounded-sm bg-sky-500/80" />
                      {exacto(dGa4 ? dGa4.ios30d : dIos?.descargas30d ?? 0)}
                    </span>
                  </span>
                </p>
                <BarrasDiarias dias={serieDiaria} />
                {/* Se dice qué cuenta: no es la descarga en la tienda, es la
                    primera vez que alguien abre la app. */}
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {dGa4
                    ? "Primeras aperturas por día (últimas 3 semanas), medidas dentro de la app. No es lo mismo que la descarga en la tienda: quien baja y no abre no cuenta."
                    : "Descargas por día del App Store (últimas 3 semanas). Google Play no publica el día a día: su informe sale al cierre del mes."}
                </p>
              </div>
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
                <div className="flex flex-wrap items-center gap-2">
                  <Metrica
                    icon={<Download className="h-3 w-3" />}
                    valor={exacto(dPlay.descargas)}
                    title="Descargas: usuarios distintos que instalaron la app por primera vez. Se cuenta por cuenta de Google, no por aparato."
                  />
                  <Metrica
                    icon={<Users className="h-3 w-3" />}
                    valor={exacto(dPlay.activos)}
                    title="Aparatos que tienen la app instalada hoy. Puede ser MAYOR que las descargas: cada usuario cuenta una vez al descargar, pero aporta un aparato por cada teléfono, tablet o emulador donde la instale — testers incluidos."
                  />
                  <Metrica
                    icon={<Trash2 className="h-3 w-3" />}
                    valor={exacto(dPlay.desinstalaciones)}
                    title="Desinstalaciones contadas en el rango leído."
                    tenue
                  />
                </div>
                {/* HASTA cuándo llega el dato, no solo desde cuándo. Play
                    publica un informe por mes CERRADO: durante septiembre lo
                    más nuevo que existe es agosto, así que el número se queda
                    quieto semanas y parece roto al compararlo con Play Console,
                    que sí enseña el día de hoy. */}
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {dPlay.historico
                    ? `total histórico · último informe de Play: ${fechaCorta(dPlay.hasta)}`
                    : `contadas desde ${fechaCorta(dPlay.desde)}`}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Play publica un informe por mes cerrado, así que lo posterior a esa fecha todavía
                  no está aquí aunque Play Console ya lo enseñe.
                </p>
              </div>
            )}

            {dIos && !dIos.pendiente && (
              <div className="mt-1.5 border-t pt-1.5">
                <p className="mb-1 flex items-center gap-1.5 font-medium">
                  <Apple className="h-3 w-3 text-muted-foreground" /> App Store
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Metrica
                    icon={<Download className="h-3 w-3" />}
                    valor={exacto(dIos.primeraVez)}
                    title="Descargas de primera vez: aparatos que no tenían la app antes."
                  />
                  <Metrica
                    icon={<RotateCcw className="h-3 w-3" />}
                    valor={exacto(dIos.redescargas)}
                    title="Redescargas: alguien que ya la había tenido y la vuelve a bajar."
                    tenue
                  />
                </div>
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
