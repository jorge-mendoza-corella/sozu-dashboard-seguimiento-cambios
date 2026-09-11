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
import { getInstallsDiarias, ultimosDias, type DiaInstalaciones } from "@/lib/installsDiarias";
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

function Dato({ label, valor, hint }: { label: string; valor: string; hint?: string }) {
  return (
    <div className="flex-1 rounded-xl border bg-muted/30 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums">{valor}</p>
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

  // El total solo se anuncia si las dos plataformas tienen el recorrido
  // completo: con un paso ausente sería un número bajo que se leería como el
  // costo real de publicar.
  const ambas = useMemo(
    () =>
      pases.length === 2 && pases.every(([, p]) => p.completo)
        ? pases.reduce((s, [, p]) => s + p.usd, 0)
        : null,
    [pases],
  );


  const datasets = useMemo(() => {
    const series: { key: "android" | "ios"; label: string }[] =
      plataforma === "todas"
        ? [{ key: "android", label: "Android" }, { key: "ios", label: "iOS" }]
        : [{ key: plataforma, label: plataforma === "ios" ? "iOS" : "Android" }];
    return series.map((s) => ({
      label: s.label,
      data: puntos.map((p) => p[s.key]),
      borderColor: COLOR[s.key],
      backgroundColor: `${COLOR[s.key]}22`,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 3,
      tension: 0.35,
      fill: true,
      // Apiladas cuando se ven las dos: la altura total es la suma, que es el
      // número que se está mirando. Con una sola serie, apilar no significa
      // nada y `fill: true` basta.
      stack: "apps",
    }));
  }, [puntos, plataforma]);

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
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border bg-background p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Download className="h-4 w-4 text-violet-500" />
            Descargas de {nombre}
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
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" />
            </button>
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
              <Dato label={`Últimos ${dias} días`} valor={N(totales.enRango)} />
              <Dato label="Android" valor={N(totales.android)} hint="histórico" />
              <Dato label="iOS" valor={N(totales.ios)} hint="histórico" />
            </div>

            <div style={{ height: 240 }}>
              <Line
                data={{ labels: puntos.map((p) => fmtFecha(p.fecha)), datasets }}
                options={opciones}
              />
            </div>

            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              Primeras aperturas tras instalar, medidas dentro de la app.
              {totales.estimado > 0 && (
                <>
                  {" "}
                  {N(totales.estimado)} están repartidas por estimación: son los totales que
                  reportaban las consolas antes de que las apps midieran, y el día exacto de cada
                  una no se conserva.
                </>
              )}
              {serie.updatedAt && ` · actualizado ${formatDistanceToNow(serie.updatedAt)}`}
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
                <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                  Costo de un pase a producción
                </p>
                <div className="flex flex-wrap gap-2">
                  {pases.map(([plataforma, p]) => (
                    <div key={plataforma} className="flex-1 rounded-xl border bg-muted/30 px-3 py-2">
                      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        {plataforma === "ios" ? <Apple className="h-3 w-3" /> : <Smartphone className="h-3 w-3" />}
                        {plataforma === "ios" ? "iOS" : "Android"}
                        {!p.completo && <span className="text-[10px]">· parcial</span>}
                      </p>
                      <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums">
                        {USD(p.usd)}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {p.pasos.map((x) => `${x.paso} ${Math.round(x.minutos)}m`).join(" · ")}
                      </p>
                    </div>
                  ))}
                  {ambas !== null && (
                    <div className="flex-1 rounded-xl border border-foreground/25 bg-muted/60 px-3 py-2">
                      <p className="text-[11px] text-muted-foreground">Las dos tiendas</p>
                      <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums">
                        {USD(ambas)}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">por versión publicada</p>
                    </div>
                  )}
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                  Promedio de los builds exitosos de cada paso: construir, subir al canal de pruebas
                  y mandarla a la tienda. Un reintento o un build que falla se cobran aparte, así
                  que es el costo del camino limpio.
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
