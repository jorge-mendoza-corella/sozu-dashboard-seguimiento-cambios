import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { DailyMetrics, RepoMetrics } from "@/lib/github";
import type { EntityMetrics } from "@/components/analytics/ContributorsAnalytics";
import type { CostsData } from "@/lib/anthropicAdmin";

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
  costsData?: CostsData | null;
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

const fmtUsdPdf = (n: number) => n >= 1 ? `$${n.toFixed(2)}` : n >= 0.001 ? `$${n.toFixed(3)}` : "<$0.001";
const fmtTokensPdf = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}K` : String(n);
const shortModelPdf = (m: string) => {
  const l = m.toLowerCase();
  if (l.includes("opus-4")) return "Opus 4";
  if (l.includes("opus-3")) return "Opus 3";
  if (l.includes("sonnet-4")) return "Sonnet 4";
  if (l.includes("sonnet-3")) return "Sonnet 3";
  if (l.includes("haiku-4")) return "Haiku 4";
  if (l.includes("haiku-3")) return "Haiku 3";
  return m.replace("claude-", "").slice(0, 20);
};

/** Genera y descarga un PDF con el reporte ejecutivo de contribuidores. */
export async function exportAnalyticsPdf(input: ExportInput): Promise<void> {
  const { windowDays, filterLabel, kpis, leader, leaderRepo, byEntity, byRepo, groupsDetail, costsData, images } = input;
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

  // --- Costos Claude ---
  if (costsData && (costsData.byContributor.length > 0 || costsData.unmapped.length > 0)) {
    doc.addPage();
    let cy = margin;

    doc.setFillColor(...INDIGO);
    doc.rect(0, 0, pageW, 50, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("Costos de Claude AI", margin, 30);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(`Últimos ${costsData.windowDays} días — datos de Anthropic API`, margin, 42);
    cy = 70;

    // Summary
    const topModel = costsData.byModel[0];
    const topSpender = costsData.byContributor[0];
    const avgPerDay = costsData.totalUsd / costsData.windowDays;
    const summaryCards = [
      { label: "Total gastado", value: fmtUsdPdf(costsData.totalUsd) },
      { label: "Promedio diario", value: fmtUsdPdf(avgPerDay) },
      { label: "Top spender", value: topSpender ? `${topSpender.githubLogin} (${fmtUsdPdf(topSpender.totalUsd)})` : "—" },
      { label: "Modelo mayor gasto", value: topModel ? `${shortModelPdf(topModel.model)} (${fmtUsdPdf(topModel.usd)})` : "—" },
    ];
    const cCardW = (contentW - 12 * 3) / 4;
    summaryCards.forEach((k, i) => {
      const x = margin + i * (cCardW + 12);
      doc.setFillColor(241, 245, 249);
      doc.roundedRect(x, cy, cCardW, 44, 4, 4, "F");
      doc.setTextColor(...INDIGO);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text(k.value, x + 8, cy + 18, { maxWidth: cCardW - 10 });
      doc.setTextColor(...SLATE);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.text(k.label.toUpperCase(), x + 8, cy + 34);
    });
    cy += 60;

    // Por modelo
    doc.setTextColor(30, 41, 59);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("Desglose por modelo", margin, cy);
    cy += 6;
    autoTable(doc, {
      startY: cy,
      head: [["Modelo", "Input tokens", "Output tokens", "Cache read", "Costo USD"]],
      body: costsData.byModel.map((m) => [
        shortModelPdf(m.model),
        fmtTokensPdf(m.inputTokens),
        fmtTokensPdf(m.outputTokens),
        fmtTokensPdf(m.cacheReadTokens),
        fmtUsdPdf(m.usd),
      ]),
      theme: "striped",
      headStyles: { fillColor: INDIGO },
      styles: { fontSize: 9, cellPadding: 4 },
      margin: { left: margin, right: margin },
    });
    // @ts-expect-error lastAutoTable added at runtime
    cy = doc.lastAutoTable.finalY + 16;

    // Por contribuidor
    if (cy > 650) { doc.addPage(); cy = margin; }
    doc.setTextColor(30, 41, 59);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("Costo por contribuidor", margin, cy);
    cy += 6;
    const allEntries = [...costsData.byContributor, ...costsData.unmapped];
    autoTable(doc, {
      startY: cy,
      head: [["Contribuidor", "Email", "Top modelo", "Input", "Output", "$/día", "Total USD"]],
      body: allEntries.map((e) => {
        const topM = e.byModel[0];
        return [
          e.githubLogin,
          e.email || "—",
          topM ? shortModelPdf(topM.model) : "—",
          fmtTokensPdf(e.byModel.reduce((s, m) => s + m.inputTokens, 0)),
          fmtTokensPdf(e.byModel.reduce((s, m) => s + m.outputTokens, 0)),
          fmtUsdPdf(e.totalUsd / costsData.windowDays),
          fmtUsdPdf(e.totalUsd),
        ];
      }),
      theme: "striped",
      headStyles: { fillColor: INDIGO },
      styles: { fontSize: 8.5, cellPadding: 4 },
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
