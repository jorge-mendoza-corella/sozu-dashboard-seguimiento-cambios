import {
  Chart as ChartJS, BarElement, CategoryScale, LinearScale, Legend, Tooltip,
  type ChartOptions,
} from "chart.js";
import { Bar } from "react-chartjs-2";

// ---------------------------------------------------------------------------
// Errores por día en producción, apilados por repo. En su propio archivo para
// cargarlo con lazy(), como Tendencia: chart.js no entra al bundle principal.
// ---------------------------------------------------------------------------

ChartJS.register(BarElement, CategoryScale, LinearScale, Legend, Tooltip);

const COLORES = ["#ef4444", "#f59e0b", "#6366f1", "#06b6d4", "#ec4899", "#84cc16", "#8b5cf6", "#14b8a6", "#f97316", "#3b82f6"];

const etiqueta = (diasAtras: number) =>
  new Date(Date.now() - diasAtras * 86_400_000).toLocaleDateString("es-MX", { day: "numeric", month: "short" });

export interface SerieRepo {
  slug: string;
  /** Errores por día, el más viejo primero y hoy al final; ya recortada a los días que se pintan. */
  serie: number[];
}

export default function GraficaErrores({ series, dias }: { series: SerieRepo[]; dias: number }) {
  const labels = Array.from({ length: dias }, (_, i) => etiqueta(dias - 1 - i));
  const options: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
      tooltip: {
        filter: (c) => (c.parsed.y ?? 0) > 0,
        callbacks: { label: (c) => ` ${c.dataset.label}: ${c.parsed.y} ${c.parsed.y === 1 ? "error" : "errores"}` },
      },
    },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: dias > 30 ? 9 : 14, font: { size: 10 } } },
      y: { stacked: true, beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
    },
  };
  return (
    <div className="h-56 w-full">
      <Bar
        options={options}
        data={{
          labels,
          datasets: series.map((s, i) => ({
            label: s.slug,
            data: Array.from({ length: dias }, (_, d) => s.serie[s.serie.length - dias + d] ?? 0),
            backgroundColor: COLORES[i % COLORES.length],
            borderRadius: 2,
            maxBarThickness: 28,
          })),
        }}
      />
    </div>
  );
}
