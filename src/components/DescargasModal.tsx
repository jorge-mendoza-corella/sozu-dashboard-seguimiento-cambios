import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement,
  Tooltip as ChartTooltip, Filler, type ChartOptions,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { Apple, Smartphone, Download, X, Loader2, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/timeUtils";
import { corteDe, getInstallsDiarias, isoLocal, sinLectura, ultimosDias, type DiaInstalaciones } from "@/lib/installsDiarias";
import { getGa4Installs } from "@/lib/ga4Installs";
import { getPortalOnline } from "@/lib/portalOnline";
import { getConsumoCodemagic } from "@/lib/codemagicConsumo";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip, Filler);

// ---------------------------------------------------------------------------
// El detalle de descargas de UNA app, en modal.
//
// Es la misma gráfica del Portal Alta Dirección, con una diferencia: allá se
// comparan las dos apps y aquí ya se sabe de cuál se habla —se abre desde su
// tarjeta—, así que el filtro de app sobra y queda el de plataforma.
//
// Lleva además el costo de Codemagic de esa app, que es la otra mitad de la
// misma pregunta: cuánto se está gastando en publicar algo que se baja tanto.
// ---------------------------------------------------------------------------

const RANGOS = [30, 90] as const;
type Plataforma = "todas" | "android" | "ios";

const COLOR = { android: "#84cc16", ios: "#0ea5e9" } as const;

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fmtFecha = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${Number(d)} ${MESES[Number(m) - 1] ?? m}`;
};
const N = (v: number) => v.toLocaleString("es-MX");
/** "8 min" o "1 h 12 min": 72.4 minutos no se lee de un vistazo. */
const duracionCorta = (min: number) => {
  const total = Math.round(min);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const resto = total % 60;
  return resto ? `${h} h ${resto} min` : `${h} h`;
};
const USD = (v: number) =>
  v.toLocaleString("es-MX", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function Chip({ activo, onClick, children }: {
  activo: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={activo}
      className={cn(
        "flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
        activo ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function Dato({
  label,
  valor,
  hint,
  late = false,
}: {
  label: string;
  valor: string;
  hint?: string;
  /** Un punto latiendo junto a la etiqueta: este número aún se está moviendo. */
  late?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex-1 rounded-xl border bg-muted/30 px-3 py-2",
        // Respira el recuadro entero, no un puntito: es lo que hace que se note
        // sin tener que buscarlo.
        late && "respira border-emerald-500/40 bg-emerald-500/[0.06]",
      )}
    >
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {/* Late el punto, no el número: un número parpadeando cuesta leerlo. */}
        {late && (
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
        )}
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 font-mono text-lg font-semibold tabular-nums",
          late && "text-emerald-700 dark:text-emerald-300",
        )}
      >
        {valor}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function DescargasModal({
  projectId,
  codemagicAppId,
  nombre,
  onClose,
}: {
  projectId: string;
  /** App de Codemagic, para el costo. Sin ella la sección no se pinta. */
  codemagicAppId?: string;
  nombre: string;
  onClose: () => void;
}) {
  const [dias, setDias] = useState<number>(30);
  const [plataforma, setPlataforma] = useState<Plataforma>("todas");

  const { data: serie, isLoading } = useQuery({
    queryKey: ["installs-diarias", projectId],
    queryFn: () => getInstallsDiarias(projectId),
    staleTime: 30 * 60_000,
  });

  const puntos: DiaInstalaciones[] = useMemo(
    () => (serie ? ultimosDias(serie.dias, dias) : []),
    [serie, dias],
  );

  // El pulso: lo único de GA4 que es al momento. Se refresca solo, porque un
  // número que dice "ahora mismo" y lleva media hora quieto miente más que no
  // enseñarlo.
  const { data: ga4 } = useQuery({
    queryKey: ["ga4-en-vivo", projectId],
    queryFn: () => getGa4Installs(projectId),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const enVivo = ga4?.data?.enVivo ?? null;
  const aperturas = enVivo ? enVivo.aperturas.android + enVivo.aperturas.ios : 0;

  // Quién está DENTRO de la app ahora. Sale de `portal_sesiones` —la sesión que
  // la app abre al entrar y mantiene con un latido—, que es lo mismo que cuenta
  // el Portal Alta Dirección. Antes se usaba `activeUsers` de GA4: otros
  // usuarios, otra ventana, otro universo, y por eso nunca cuadraron.
  const { data: online } = useQuery({
    queryKey: ["portal-online", projectId],
    queryFn: () => getPortalOnline(projectId),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });


  // Cuánto hace que se leyó lo de "en línea". Se calla por debajo de dos
  // minutos: ahí "en línea" y "hace un momento" son lo mismo y el paréntesis
  // solo estorba.
  const antiguedadOnline = useMemo(() => {
    if (!online?.updatedAt) return null;
    const min = Math.round((Date.now() - new Date(online.updatedAt).getTime()) / 60_000);
    return min >= 2 ? `hace ${min} min` : null;
  }, [online]);

  // Hasta dónde llega la medición. La ventana termina aquí y no en la fecha de
  // hoy: el día en curso no lo ha contado nadie todavía y se dibujaba como una
  // caída a cero, que es lo contrario de lo que pasa.
  const corte = useMemo(() => (serie ? corteDe(serie.dias) : null), [serie]);

  // La gráfica llega siempre a hoy, con cero si hace falta. Lo que cambia es
  // qué se dice debajo: un cero porque nadie bajó la app y un cero porque nadie
  // la ha contado se dibujan igual, y son cosas distintas.
  const corteEsHoy = corte === isoLocal(new Date());

  // Lo que va contado hoy. Sale de la misma serie que pinta la gráfica y
  // respeta el filtro de plataforma, así que no puede discrepar con ella.
  const hoy = useMemo(() => {
    const dia = (serie?.dias ?? []).find((d) => d.fecha === isoLocal(new Date()));
    if (!dia) return 0;
    return plataforma === "android" ? dia.android
      : plataforma === "ios" ? dia.ios
      : dia.android + dia.ios;
  }, [serie, plataforma]);

  // Los días que ya tienen algo pero no han cerrado. Se nombran en el pie: un
  // punteado sin explicación es un adorno, no información.
  const parciales = useMemo(
    () => puntos.filter((p) => p.parcial && !sinLectura(p.fecha, corte)).map((p) => p.fecha),
    [puntos, corte],
  );

  const totales = useMemo(() => {
    const base = serie?.dias ?? [];
    return {
      android: base.reduce((s, d) => s + d.android, 0),
      ios: base.reduce((s, d) => s + d.ios, 0),
      estimado: base.reduce((s, d) => s + d.estimado, 0),
      enRango: puntos.reduce(
        (s, d) =>
          s + (plataforma === "android" ? d.android : plataforma === "ios" ? d.ios : d.android + d.ios),
        0,
      ),
    };
  }, [serie, puntos, plataforma]);

  // Lo facturado de verdad, de la cuenta dueña de la app. No se estima:
  // Codemagic lo publica en `/user`, separando lo pagado de lo gratis.
  const {
    data: consumo,
    isLoading: cargandoConsumo,
    error: errorConsumo,
  } = useQuery({
    queryKey: ["codemagic-consumo", codemagicAppId],
    queryFn: () => getConsumoCodemagic(codemagicAppId!),
    enabled: !!codemagicAppId,
    staleTime: 10 * 60_000,
    retry: false,
  });

  // Las plataformas con datos de pase, en orden estable.
  const pases = useMemo(() => {
    const p = consumo?.porPase ?? {};
    return (["ios", "android"] as const)
      .map((k) => [k, p[k]] as const)
      .filter((x): x is readonly ["ios" | "android", NonNullable<typeof x[1]>] => !!x[1]);
  }, [consumo]);

  const merma = consumo?.merma;


  const datasets = useMemo(() => {
    const series: { key: "android" | "ios"; label: string }[] =
      plataforma === "todas"
        ? [{ key: "android", label: "Android" }, { key: "ios", label: "iOS" }]
        : [{ key: plataforma, label: plataforma === "ios" ? "iOS" : "Android" }];
    return series.map((s) => ({
      label: s.label,
      // `null` y no 0 en los días que nadie ha contado todavía: la línea se
      // corta ahí. Un cero dibuja una caída a plomo que no ocurrió, y es lo
      // primero que se ve al abrir la gráfica por la mañana.
      data: puntos.map((p) => (sinLectura(p.fecha, corte) ? null : p[s.key])),
      borderColor: COLOR[s.key],
      backgroundColor: `${COLOR[s.key]}22`,
      borderWidth: 2,
      // Punteado desde el primer día que aún no ha cerrado. La tienda publica
      // el reporte de un día durante el siguiente, así que hay una ventana en
      // la que el día ya tiene lo de Analytics y le falta lo de Apple: dibujarlo
      // como día cerrado enseña un desplome que no ocurrió.
      segment: {
        borderDash: (ctx: { p1DataIndex: number }) =>
          puntos[ctx.p1DataIndex]?.parcial ? [4, 3] : undefined,
      },
      pointRadius: 0,
      pointHoverRadius: 3,
      tension: 0.35,
      fill: true,
      // Apiladas cuando se ven las dos: la altura total es la suma, que es el
      // número que se está mirando. Con una sola serie, apilar no significa
      // nada y `fill: true` basta.
      stack: "apps",
    }));
  }, [puntos, plataforma, corte]);

  const opciones: ChartOptions<"line"> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
        y: {
          stacked: plataforma === "todas",
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 10 } },
          grid: { color: "rgba(120,120,120,0.15)" },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            // "ese día": el número del tooltip es de un solo día y se confunde
            // con el acumulado que está arriba.
            title: (items) => `${items[0]?.label} · ese día`,
          },
        },
      },
    }),
    [plataforma],
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border bg-background p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* La X, fija en la esquina. Iba al final de la fila de chips, así que
            se movía con ellos: cuando la fila envolvía, acababa a media altura
            y en mitad del ancho. `sticky` la mantiene a la vista aunque el
            modal se haya desplazado, que es cuando más se busca. */}
        <button
          type="button"
          onClick={onClose}
          className="sticky top-0 z-10 float-right -mr-1 -mt-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Cerrar"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 pr-8">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Download className="h-4 w-4 text-violet-500" />
            Descargas de {nombre}
            {(enVivo || online) && (
              <span
                className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-normal text-muted-foreground"
                title={
                  (enVivo
                    ? `Instalaciones estrenadas en los últimos ${enVivo.ventanaMinutos} minutos ` +
                      "(no en todo el día: para eso está la gráfica de abajo). Las mide Google " +
                      "Analytics con el evento `first_open`, que cuenta cada instalación nueva que " +
                      "se ABRE por primera vez, no cada persona: quien reinstala, o instala en un " +
                      "segundo aparato, vuelve a contar. No es la descarga de la tienda —quien baja " +
                      "la app y no la abre no aparece aquí— pero es lo único que se puede saber al " +
                      "momento: Apple y Play publican sus cifras al día siguiente. "
                    : "") +
                  (online
                    ? `${online.usuarios} ${online.usuarios === 1 ? "persona con sesión abierta" : "personas con sesión abierta"} ` +
                      `en los últimos ${online.ventanaMinutos} minutos (${online.desdeApp} desde la app, ` +
                      `${online.desdeWeb} desde el navegador). Es la misma medición que enseña el ` +
                      "Portal Alta Dirección: la sesión que la app abre al entrar y mantiene con un latido."
                    : "") +
                  " Nada de esto se suma a la gráfica: son otras métricas y otras ventanas."
                }
              >
                <span className="relative flex h-1.5 w-1.5">
                  {aperturas > 0 && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  )}
                  <span
                    className={cn(
                      "relative inline-flex h-1.5 w-1.5 rounded-full",
                      aperturas > 0 ? "bg-emerald-500" : "bg-muted-foreground/40",
                    )}
                  />
                </span>
                {aperturas > 0 ? (
                  <>
                    {N(aperturas)} recién instalada{aperturas === 1 ? "" : "s"}
                    {/* La ventana, pegada al número. Sin ella se lee como "hoy"
                        —que es lo que dice la gráfica de al lado— y son dos
                        cosas distintas: esto son los últimos minutos. */}
                    <span className="opacity-60">
                      {" "}· {enVivo?.ventanaMinutos ?? 30} min
                    </span>
                  </>
                ) : (
                  <>sin instalaciones en {enVivo?.ventanaMinutos ?? 30} min</>
                )}
                {online && online.usuarios > 0 && (
                  <span className="text-muted-foreground/70">
                    {" "}· {N(online.usuarios)} en línea
                    {/* Cuándo se leyó. Este número viene de una copia que el
                        sync refresca cada diez minutos, mientras el Portal Alta
                        Dirección consulta la base en vivo: sin la antigüedad,
                        los dos parecen contradecirse cuando en realidad hablan
                        de dos instantes distintos. */}
                    {antiguedadOnline && (
                      <span className="opacity-70"> ({antiguedadOnline})</span>
                    )}
                  </span>
                )}
              </span>
            )}
          </h3>
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              <Chip activo={plataforma === "todas"} onClick={() => setPlataforma("todas")}>Todo</Chip>
              <Chip activo={plataforma === "android"} onClick={() => setPlataforma("android")}>
                <Smartphone className="h-3 w-3" /> Android
              </Chip>
              <Chip activo={plataforma === "ios"} onClick={() => setPlataforma("ios")}>
                <Apple className="h-3 w-3" /> iOS
              </Chip>
            </div>
            <span className="h-4 w-px bg-border" aria-hidden />
            <div className="flex gap-1">
              {RANGOS.map((r) => (
                <Chip key={r} activo={dias === r} onClick={() => setDias(r)}>{r} d</Chip>
              ))}
            </div>
          </div>
        </div>

        {isLoading ? (
          <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> cargando la serie…
          </p>
        ) : !serie ? (
          <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            Todavía no hay serie diaria de esta app. La escribe el sync una vez al día.
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              {/* Hoy va primero: es el único de la fila que se mueve durante el
                  día. Los demás son totales que no cambian hasta mañana. */}
              {hoy > 0 && (
                <Dato
                  label="Hoy"
                  valor={N(hoy)}
                  hint="en curso · lo sustituye la tienda mañana"
                  late
                />
              )}
              <Dato label={`Últimos ${dias} días`} valor={N(totales.enRango)} />
              <Dato label="Android" valor={N(totales.android)} hint="histórico" />
              <Dato label="iOS" valor={N(totales.ios)} hint="histórico" />
            </div>

            {/* Cuánto se USA, no cuánto se bajó. Va pegado a las descargas
                porque es la segunda mitad de la misma pregunta: una app que se
                baja mucho y no se abre nunca no es una buena noticia. Sale de
                `portal_sesiones`, lo mismo que enseña el Portal Alta Dirección,
                así que los dos tableros dicen el mismo número. */}
            {online && (
              <div className="mb-3 flex flex-wrap gap-2">
                <Dato
                  label="En línea"
                  valor={N(online.usuarios)}
                  hint={
                    online.usuarios > 0
                      ? `${N(online.desdeApp)} en app · ${N(online.desdeWeb)} en web`
                      : `sin actividad en ${online.ventanaMinutos} min`
                  }
                />
                {online.mes && (
                  <>
                    <Dato
                      label="Por sesión"
                      valor={duracionCorta(online.mes.duracionPromedioMin)}
                      hint="promedio del mes"
                    />
                    <Dato
                      label="Usuarios del mes"
                      valor={N(online.mes.usuarios)}
                      hint={`${N(online.mes.sesiones)} ${online.mes.sesiones === 1 ? "sesión" : "sesiones"}`}
                    />
                  </>
                )}
              </div>
            )}

            <div style={{ height: 240 }}>
              <Line
                data={{ labels: puntos.map((p) => fmtFecha(p.fecha)), datasets }}
                options={opciones}
              />
            </div>

            {/* La nota de "repartidas por estimación" se quitó: con los
                reportes reales de las tiendas ya llegando, explicar la siembra
                cada vez que se abre el modal cuenta algo que dejó de ser el
                caso normal. Queda el corte, que es lo que hay que saber para
                leer la curva, y cuándo se leyó. */}
            <p className="mt-2 text-[10px] text-muted-foreground">
              {corteEsHoy
                ? "Hoy va incompleto: lo que se ve es lo que Analytics lleva contado del día, y la cifra de la tienda lo sustituye mañana."
                : `Hoy todavía sin lecturas${corte ? ` — la última es del ${fmtFecha(corte)}` : ""}. Analytics tarda unas horas en consolidar el día y las tiendas publican el suyo al día siguiente.`}
              {parciales.length > 0 && (
                <>
                  {" "}El tramo punteado ({parciales.map(fmtFecha).join(", ")}) todavía no cierra:
                  falta el reporte de la tienda, así que esos días pueden subir.
                </>
              )}
              {serie.updatedAt && <> · actualizado {formatDistanceToNow(serie.updatedAt)}</>}
            </p>
          </>
        )}

        {/* Consumo de Codemagic. Va en el mismo modal porque es la otra mitad
            de la pregunta: cuánto cuesta publicar lo que se baja. */}
        {/* La sección se pinta siempre que haya app de Codemagic, aunque la
            consulta falle: escondiéndola, un error de la API se veía igual que
            "esta app no gasta nada", que es justo lo contrario. */}
        {codemagicAppId && (
          <div className="mt-4 border-t pt-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Cpu className="h-3.5 w-3.5" />
              Costo build &amp; deploy (iOS y Android)
            </h4>

            {cargandoConsumo && (
              <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> leyendo la facturación…
              </p>
            )}

            {errorConsumo && (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200">
                No se pudo leer la facturación:{" "}
                {errorConsumo instanceof Error ? errorConsumo.message : "error desconocido"}
              </p>
            )}

            {!cargandoConsumo && !errorConsumo && !consumo && (
              <p className="text-[11px] text-muted-foreground">
                Todavía sin datos de facturación de esta app. Los escribe el sync una vez al día.
              </p>
            )}

            {/* Solo lo de ESTA app: el modal es de una app, y el total de la
                cuenta y el cupo gratis son de todas. Mezclarlos obligaba a
                restar mentalmente para llegar al número que se vino a ver. */}
            {consumo?.reparto && (<><div className="flex flex-wrap gap-2">
              <Dato
                label="Costo de esta app"
                valor={USD(consumo.reparto.usd)}
                hint={`${N(Math.round(consumo.reparto.minutosApp))} min cobrados`}
              />
              <Dato
                label="Peso en la cuenta"
                valor={`${Math.round(consumo.reparto.parte * 100)}%`}
              />
            </div>
            {/* De dónde sale el número: Codemagic factura por cuenta y no
                desglosa por aplicación, así que esto es un reparto por minutos
                de máquina y conviene que se pueda comprobar. */}
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
              Reparto de lo que {consumo.ambito} paga a Codemagic, por minutos de máquina —no
              factura por aplicación—: {N(Math.round(consumo.reparto.minutosApp))} de{" "}
              {N(Math.round(consumo.reparto.minutosCuenta))} min cobrados del periodo. Solo cuenta
              los minutos que se cobran, no los del cupo gratis, e incluye los builds fallidos, que
              también ocupan máquina.
            </p></>)}

            {/* Lo que cuesta mandar UNA versión a la tienda. El total del
                periodo dice cuánto se lleva gastado; esto dice cuánto vale
                cada publicación, que es lo que se puede decidir. */}
            {pases.length > 0 && (
              <div className="mt-3 border-t pt-3">
                {/* El número que se decide es el del pase COMPLETO: publicar
                    una versión significa las dos tiendas, no una. El desglose
                    por plataforma y por paso queda debajo y en el título, que
                    es donde se mira cuando ya se quiere entender de dónde
                    sale. */}
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    Un pase a producción
                  </span>
                  <span className="font-mono text-xl font-semibold tabular-nums">
                    {USD(pases.reduce((s, [, p]) => s + p.usd, 0))}
                  </span>
                </div>

                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  {pases.map(([plataforma, p]) => (
                    <span
                      key={plataforma}
                      className="flex cursor-help items-center gap-1.5"
                      title={p.pasos
                        .map((x) => `${x.paso}: ${x.minutos.toFixed(1)} min · ${USD(x.usd)} (${x.muestras} builds)`)
                        .join("\n")}
                    >
                      {plataforma === "ios" ? <Apple className="h-3 w-3" /> : <Smartphone className="h-3 w-3" />}
                      {plataforma === "ios" ? "iOS" : "Android"}
                      <span className="font-mono text-foreground">{USD(p.usd)}</span>
                      <span>· {Math.round(p.minutos)} min</span>
                      {/* Con más de un pase el número es un promedio, y eso
                          cambia cómo se lee: conviene que se vea. */}
                      {p.pases > 1 && <span>· media de {p.pases}</span>}
                    </span>
                  ))}
                </div>

                {/* Lo cobrado que no fue el pase. Se enseña porque se paga
                    igual y hasta ahora no aparecía en ningún lado: la tarjeta
                    daba lo facturado y el costo de un pase, y la diferencia no
                    tenía nombre. */}
                {!!merma?.minutos && (
                  <p
                    className="mt-1.5 flex cursor-help flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground"
                    title={[
                      `builds fallidos: ${merma.fallidos.toFixed(1)} min`,
                      `otros workflows: ${merma.otros.toFixed(1)} min`,
                    ].join("\n")}
                  >
                    <span>Merma</span>
                    <span className="font-mono text-foreground">{USD(merma.usd)}</span>
                    <span>
                      · {Math.round(merma.minutos)} min cobrados que no publicaron nada
                      {merma.fallidos > 0 &&
                        ` (${Math.round(merma.fallidos)} de builds fallidos)`}
                    </span>
                  </p>
                )}

                <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                  Las dos tiendas: por plataforma son tres pasos —construir, subir al canal de
                  pruebas y mandarla a la tienda—, sobre los builds exitosos del mismo periodo
                  cobrado de arriba. Cuántos pases hubo es el mínimo de veces que corrió cada uno
                  de esos tres pasos; si hubo varios, el importe es su promedio. Lo que sobra
                  —reintentos y builds fallidos— va a la merma, no aquí.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
