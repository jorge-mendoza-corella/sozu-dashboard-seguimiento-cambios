import { useState } from "react";
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
  type ChartOptions,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Costos del mes día por día, dentro del badge de costos. Va en su propio
// archivo para cargarlo con lazy(): el badge vive en la barra de todas las
// páginas y chart.js no tiene por qué entrar en el bundle principal.
// ---------------------------------------------------------------------------

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

// Slate-400: se lee en claro y en oscuro (el canvas no ve las clases del tema).
const AXIS_COLOR = "rgba(148,163,184,0.95)";
const GRID_COLOR = "rgba(148,163,184,0.15)";
const COLOR = { total: "#10b981", github: "#0ea5e9", anthropic: "#8b5cf6" };

const USD = (v: number) =>
  v.toLocaleString("es-MX", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/**
 * Serie del día 1 a hoy (UTC, como facturan GitHub y Anthropic). Los días que
 * la fuente todavía no consolidó —después del último que trae— quedan en null
 * y la línea se corta ahí, en vez de caer a cero y parecer que no se gastó.
 */
function serie(porDia: Record<string, number> | null, dias: string[]): (number | null)[] {
  if (!porDia) return dias.map(() => null);
  const ultimo = Object.keys(porDia).sort().pop() ?? "";
  return dias.map((d) => (d <= ultimo ? porDia[d] ?? 0 : null));
}

function acumular(xs: (number | null)[]): (number | null)[] {
  let s = 0;
  return xs.map((x) => (x === null ? null : (s += x)));
}

export default function CostosGrafica({ github, anthropic }: {
  github: Record<string, number> | null;
  anthropic: Record<string, number> | null;
}) {
  const [acumulado, setAcumulado] = useState(false);

  const hoy = new Date();
  const pref = `${hoy.getUTCFullYear()}-${String(hoy.getUTCMonth() + 1).padStart(2, "0")}-`;
  const dias = Array.from({ length: hoy.getUTCDate() }, (_, i) => `${pref}${String(i + 1).padStart(2, "0")}`);

  const gh = serie(github, dias);
  const an = serie(anthropic, dias);
  // El total solo existe donde hay dato de las dos: sumar uno solo lo haría
  // desplomarse el último día, que es justo el que más se mira.
  const total = dias.map((_, i) => {
    const g = github ? gh[i] : 0;
    const a = anthropic ? an[i] : 0;
    return g === null || a === null ? null : g + a;
  });

  const conv = acumulado ? acumular : (x: (number | null)[]) => x;
  const linea = (label: string, data: (number | null)[], color: string, relleno = false) => ({
    label,
    data: conv(data),
    borderColor: color,
    backgroundColor: relleno ? `${color}22` : "transparent",
    fill: relleno,
    tension: 0.25,
    borderWidth: relleno ? 2 : 1.5,
    pointRadius: 0,
    pointHoverRadius: 4,
    spanGaps: false,
  });

  const opciones: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        position: "bottom",
        labels: { color: AXIS_COLOR, boxWidth: 10, boxHeight: 2, font: { size: 10 } },
      },
      tooltip: {
        backgroundColor: "rgba(17,24,39,0.92)",
        padding: 8,
        titleFont: { size: 11 },
        bodyFont: { size: 11 },
        callbacks: {
          title: (items) => `${Number(items[0]?.label)} de ${hoy.toLocaleDateString("es-MX", { month: "long", timeZone: "UTC" })}`,
          label: (c) => ` ${c.dataset.label}: ${USD(c.parsed.y ?? 0)}`,
        },
      },
    },
    scales: {
      x: {
        ticks: { color: AXIS_COLOR, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 6 },
        grid: { display: false },
      },
      y: {
        beginAtZero: true,
        ticks: { color: AXIS_COLOR, font: { size: 10 }, callback: (v) => `$${Number(v).toLocaleString("es-MX")}` },
        grid: { color: GRID_COLOR },
      },
    },
  };

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <div className="inline-flex rounded-md border p-0.5 text-[10px]">
          {([["Por día", false], ["Acumulado", true]] as const).map(([txt, v]) => (
            <button
              key={txt}
              type="button"
              onClick={() => setAcumulado(v)}
              className={cn("rounded px-1.5 py-0.5", acumulado === v ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}
            >
              {txt}
            </button>
          ))}
        </div>
      </div>
      <div className="h-48">
        <Line
          data={{
            labels: dias.map((d) => String(Number(d.slice(8)))),
            datasets: [
              linea("Total", total, COLOR.total, true),
              linea("GitHub", gh, COLOR.github),
              linea("Anthropic", an, COLOR.anthropic),
            ],
          }}
          options={opciones}
        />
      </div>
      <p className="text-[10px] text-muted-foreground">
        Días en UTC. GitHub cuenta solo lo que se paga: los días que absorbe el plan salen en cero.
      </p>
    </div>
  );
}
