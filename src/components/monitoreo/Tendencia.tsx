import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler,
  type ChartOptions,
} from "chart.js";
import { Line } from "react-chartjs-2";

// ---------------------------------------------------------------------------
// Eventos de error por día (14 días) de un proyecto de Sentry. En su propio
// archivo para cargarlo con lazy(): chart.js no entra al bundle principal.
// ---------------------------------------------------------------------------

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

const COLOR = "#ef4444";

const etiqueta = (diasAtras: number) => {
  const d = new Date(Date.now() - diasAtras * 86_400_000);
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "short" });
};

export default function Tendencia({ serie }: { serie: number[] }) {
  const labels = serie.map((_, i) => etiqueta(serie.length - 1 - i));
  const options: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => `${c.parsed.y} eventos` } },
    },
    scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
    elements: { point: { radius: 0, hoverRadius: 3 } },
  };
  return (
    <div className="h-12 w-full">
      <Line
        options={options}
        data={{
          labels,
          datasets: [{
            data: serie, borderColor: COLOR, backgroundColor: "rgba(239,68,68,0.12)",
            borderWidth: 1.5, fill: true, tension: 0.3,
          }],
        }}
      />
    </div>
  );
}
