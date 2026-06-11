import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { DailyMetrics, RepoMetrics } from "@/lib/github";
import type { EntityMetrics } from "@/components/analytics/ContributorsAnalytics";

export interface GroupDetail {
  name: string;
  members: string[];
  dev: number;
  main: number;
  prs: number;
  visible: boolean;
}

interface ExportInput {
  windowDays: number;
  filterLabel: string;
  kpis: { dev: number; main: number; prs: number; total: number; peak: DailyMetrics; activeDays: number };
  leader?: EntityMetrics;
  leaderRepo?: RepoMetrics;
  byEntity: EntityMetrics[];
  byRepo: RepoMetrics[];
  groupsDetail: GroupDetail[];
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
  const { windowDays, filterLabel, kpis, leader, leaderRepo, byEntity, byRepo, groupsDetail, images } = input;
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

  // --- Resumen ejecutivo ---
  doc.setTextColor(30, 41, 59);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Resumen ejecutivo", margin, y);
  y += 8;
  doc.setDrawColor(...INDIGO);
  doc.setLineWidth(1.5);
  doc.line(margin, y, margin + 120, y);
  y += 18;

  const gap = Math.max(kpis.dev - kpis.main, 0);
  const narrative = [
    `En los últimos ${windowDays} días se registraron ${kpis.dev.toLocaleString()} commits en la rama dev, ${kpis.main.toLocaleString()} en main y ${kpis.prs.toLocaleString()} pull requests creados, con actividad en ${kpis.activeDays} días distintos.`,
    `Promedios diarios: ${(kpis.dev / windowDays).toFixed(1)} commits en dev, ${(kpis.main / windowDays).toFixed(1)} en main y ${(kpis.prs / windowDays).toFixed(1)} PRs por día.`,
    gap > 0
      ? `La brecha entre dev y main es de ${gap.toLocaleString()} commits, que representan trabajo aún no integrado a producción.`
      : "Dev y main están alineados: todo el trabajo del periodo está integrado a producción.",
    kpis.peak.dev > 0
      ? `El día de mayor actividad en dev fue el ${fmtDay(kpis.peak.date)} con ${kpis.peak.dev} commits.`
      : "",
    leader
      ? `${leader.label.replace("👥 ", "")}${leader.isGroup ? " (grupo)" : ""} es el contribuidor más activo, con ${leader.dev.toLocaleString()} commits en dev, ${leader.main.toLocaleString()} en main y ${leader.prs.toLocaleString()} PRs.`
      : "",
    leaderRepo
      ? `El repositorio con más movimiento es ${leaderRepo.repo} (${leaderRepo.dev.toLocaleString()} dev / ${leaderRepo.main.toLocaleString()} main / ${leaderRepo.prs.toLocaleString()} PRs).`
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
    { label: `Commits dev · ${(kpis.dev / windowDays).toFixed(1)}/día`, value: kpis.dev.toLocaleString() },
    { label: `Commits main · ${(kpis.main / windowDays).toFixed(1)}/día`, value: kpis.main.toLocaleString() },
    { label: `PRs creados · ${(kpis.prs / windowDays).toFixed(1)}/día`, value: kpis.prs.toLocaleString() },
    { label: "Días activos", value: `${kpis.activeDays}` },
  ];
  const cardGap = 12;
  const cardW = (contentW - cardGap * (kpiCards.length - 1)) / kpiCards.length;
  kpiCards.forEach((k, i) => {
    const x = margin + i * (cardW + cardGap);
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

  // --- Gráficas ---
  if (images.daily) {
    y = addChart(doc, "Cambios diarios (dev / main / PRs)", images.daily, margin, y, contentW, 150);
  }
  if (images.authors || images.repos) {
    if (y > 600) {
      doc.addPage();
      y = margin;
    }
    const halfW = (contentW - cardGap) / 2;
    const startY = y;
    if (images.authors) addChart(doc, "Por contribuidor / grupo", images.authors, margin, startY, halfW, 150);
    if (images.repos) addChart(doc, "Por repositorio", images.repos, margin + halfW + cardGap, startY, halfW, 150);
    y = startY + 150 + 26;
  }

  // --- Tablas ---
  const withAvg = (n: number) => `${n.toLocaleString()} (${(n / windowDays).toFixed(1)}/día)`;

  if (byEntity.length) {
    autoTable(doc, {
      startY: y + 4,
      head: [["Contribuidor / Grupo", "Dev (prom/día)", "Main (prom/día)", "PRs (prom/día)"]],
      body: byEntity.map((e) => [
        `${e.label.replace("👥 ", "")}${e.isGroup ? " (grupo)" : ""}`,
        withAvg(e.dev),
        withAvg(e.main),
        withAvg(e.prs),
      ]),
      theme: "striped",
      headStyles: { fillColor: INDIGO },
      styles: { fontSize: 9, cellPadding: 4 },
      margin: { left: margin, right: margin },
    });
    // @ts-expect-error lastAutoTable lo agrega el plugin en runtime
    y = doc.lastAutoTable.finalY + 16;
  }

  if (byRepo.length) {
    if (y > 700) {
      doc.addPage();
      y = margin;
    }
    autoTable(doc, {
      startY: y,
      head: [["Repositorio", "Dev (prom/día)", "Main (prom/día)", "PRs (prom/día)"]],
      body: byRepo.map((r) => [r.repo, withAvg(r.dev), withAvg(r.main), withAvg(r.prs)]),
      theme: "striped",
      headStyles: { fillColor: INDIGO },
      styles: { fontSize: 9, cellPadding: 4 },
      margin: { left: margin, right: margin },
    });
    // @ts-expect-error lastAutoTable lo agrega el plugin en runtime
    y = doc.lastAutoTable.finalY + 16;
  }

  if (groupsDetail.length) {
    if (y > 680) {
      doc.addPage();
      y = margin;
    }
    autoTable(doc, {
      startY: y,
      head: [["Grupo", "Miembros", "Dev (prom/día)", "Main (prom/día)", "PRs (prom/día)", "En analítica"]],
      body: groupsDetail.map((g) => [
        g.name,
        g.members.join(", "),
        withAvg(g.dev),
        withAvg(g.main),
        withAvg(g.prs),
        g.visible ? "Sí" : "No",
      ]),
      theme: "striped",
      headStyles: { fillColor: INDIGO },
      styles: { fontSize: 8.5, cellPadding: 4 },
      columnStyles: { 1: { cellWidth: 170 } },
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
