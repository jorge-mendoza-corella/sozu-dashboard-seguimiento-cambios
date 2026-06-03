import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { AuthorActivity, RepoActivity, DailyCount } from "@/lib/github";

interface ExportInput {
  windowDays: number;
  filterLabel: string;
  kpis: { total: number; avg: number; peak: DailyCount; activeDays: number };
  leaderAuthor?: AuthorActivity;
  leaderRepo?: RepoActivity;
  byAuthor: AuthorActivity[];
  byRepo: RepoActivity[];
  images: { daily?: string; authors?: string; repos?: string };
}

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fmtDay = (date: string) => {
  if (!date) return "—";
  const [, m, d] = date.split("-");
  return `${Number(d)} ${MESES[Number(m) - 1] ?? ""}`;
};

const INDIGO: [number, number, number] = [99, 102, 241];
const SLATE: [number, number, number] = [100, 116, 139];

/** Genera y descarga un PDF con el reporte ejecutivo de contribuidores. */
export async function exportAnalyticsPdf(input: ExportInput): Promise<void> {
  const { windowDays, filterLabel, kpis, leaderAuthor, leaderRepo, byAuthor, byRepo, images } = input;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  const contentW = pageW - margin * 2;
  const now = new Date();
  const stamp = now.toLocaleString("es-MX", { dateStyle: "long", timeStyle: "short" });

  // --- Encabezado ---
  doc.setFillColor(...INDIGO);
  doc.rect(0, 0, pageW, 70, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Reporte ejecutivo de contribuidores", margin, 34);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(`SOZU Tracker · Generado ${stamp}`, margin, 52);

  let y = 92;
  doc.setTextColor(30, 41, 59);
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text(`Periodo: últimos ${windowDays} días`, margin, y);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...SLATE);
  doc.text(`Filtro: ${filterLabel}`, margin, y + 16);
  y += 40;

  // --- Resumen ejecutivo (narrativa) ---
  doc.setTextColor(30, 41, 59);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Resumen ejecutivo", margin, y);
  y += 8;
  doc.setDrawColor(...INDIGO);
  doc.setLineWidth(1.5);
  doc.line(margin, y, margin + 120, y);
  y += 18;

  const narrative = [
    `En los últimos ${windowDays} días se registraron ${kpis.total.toLocaleString()} commits, con un promedio de ${kpis.avg.toFixed(
      1,
    )} por día y actividad en ${kpis.activeDays} días distintos.`,
    kpis.peak.count > 0
      ? `El día de mayor actividad fue el ${fmtDay(kpis.peak.date)} con ${kpis.peak.count} commits.`
      : "",
    leaderAuthor
      ? `${leaderAuthor.login} es el contribuidor más activo, con ${leaderAuthor.total.toLocaleString()} commits (${leaderAuthor.perDay.toFixed(
          1,
        )} por día activo).`
      : "",
    leaderRepo
      ? `El repositorio con más movimiento es ${leaderRepo.repo}, que concentra ${leaderRepo.total.toLocaleString()} commits (${
          kpis.total > 0 ? ((leaderRepo.total / kpis.total) * 100).toFixed(0) : 0
        }% del total del periodo).`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10.5);
  doc.setTextColor(51, 65, 85);
  const lines = doc.splitTextToSize(narrative, contentW);
  doc.text(lines, margin, y);
  y += lines.length * 14 + 12;

  // --- Tarjetas KPI ---
  const kpiCards = [
    { label: "Total commits", value: kpis.total.toLocaleString() },
    { label: "Promedio / día", value: kpis.avg.toFixed(1) },
    { label: "Día pico", value: kpis.peak.count > 0 ? `${kpis.peak.count}` : "—" },
    { label: "Días activos", value: `${kpis.activeDays}` },
  ];
  const gap = 12;
  const cardW = (contentW - gap * (kpiCards.length - 1)) / kpiCards.length;
  kpiCards.forEach((k, i) => {
    const x = margin + i * (cardW + gap);
    doc.setFillColor(241, 245, 249);
    doc.roundedRect(x, y, cardW, 52, 6, 6, "F");
    doc.setTextColor(...INDIGO);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(17);
    doc.text(k.value, x + 12, y + 26);
    doc.setTextColor(...SLATE);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.text(k.label.toUpperCase(), x + 12, y + 42);
  });
  y += 72;

  // --- Gráfica diaria ---
  if (images.daily) {
    y = addChart(doc, "Cambios diarios", images.daily, margin, y, contentW, 150);
  }

  // --- Gráficas autores / repos lado a lado ---
  if (images.authors || images.repos) {
    if (y > 620) {
      doc.addPage();
      y = margin;
    }
    const halfW = (contentW - gap) / 2;
    const startY = y;
    if (images.authors) addChart(doc, "Top contribuidores", images.authors, margin, startY, halfW, 150);
    if (images.repos) addChart(doc, "Commits por repositorio", images.repos, margin + halfW + gap, startY, halfW, 150);
    y = startY + 150 + 26;
  }

  // --- Tablas ---
  if (byAuthor.length) {
    autoTable(doc, {
      startY: y + 4,
      head: [["Contribuidor", "Commits", "Por día activo"]],
      body: byAuthor.map((a) => [a.login, a.total.toLocaleString(), a.perDay.toFixed(1)]),
      theme: "striped",
      headStyles: { fillColor: INDIGO },
      styles: { fontSize: 9, cellPadding: 4 },
      margin: { left: margin, right: margin },
    });
    // @ts-expect-error lastAutoTable lo agrega el plugin en runtime
    y = doc.lastAutoTable.finalY + 16;
  }

  if (byRepo.length) {
    if (y > 720) {
      doc.addPage();
      y = margin;
    }
    autoTable(doc, {
      startY: y,
      head: [["Repositorio", "Commits", "% del total"]],
      body: byRepo.map((r) => [
        r.repo,
        r.total.toLocaleString(),
        `${kpis.total > 0 ? ((r.total / kpis.total) * 100).toFixed(0) : 0}%`,
      ]),
      theme: "striped",
      headStyles: { fillColor: INDIGO },
      styles: { fontSize: 9, cellPadding: 4 },
      margin: { left: margin, right: margin },
    });
  }

  const fileStamp = now.toISOString().slice(0, 10);
  doc.save(`reporte-contribuidores-${fileStamp}.pdf`);
}

function addChart(
  doc: jsPDF,
  title: string,
  img: string,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  doc.setTextColor(30, 41, 59);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(title, x, y);
  try {
    doc.addImage(img, "PNG", x, y + 8, w, h);
  } catch {
    /* imagen no disponible: se omite */
  }
  return y + h + 26;
}
