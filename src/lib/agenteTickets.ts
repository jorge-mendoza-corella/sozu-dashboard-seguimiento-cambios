/**
 * Tickets del portal de sozu-admin asignados a quien está logueado.
 *
 * Los entrega la Cloud Function `agenteTickets` (lee Supabase del lado del
 * servidor, valida el permiso "Revisar tickets" y filtra por el email de la
 * sesión: nadie ve tickets de otro). El panel del agente los revisa cada 15 min
 * mientras el dashboard está abierto y, si hay, el personaje grita.
 */
import { getFunctions, httpsCallable } from "firebase/functions";
import { app } from "./firebase";
import type { RepoRef } from "./github";

export const INTERVALO_TICKETS_MS = 15 * 60_000;

export interface PersonaTicket {
  nombre: string;
  email: string | null;
  /** Es quien está logueado. */
  soyYo: boolean;
}

export interface EvidenciaTicket {
  nombre: string;
  tipo: "imagen" | "audio" | "documento" | "otro";
  /** URL pública del archivo en Storage (bucket `documentos`). */
  url: string | null;
}

export interface TicketAgente {
  id: string;
  folio: string;
  titulo: string;
  descripcion: string;
  etapa: string | null;
  pipeline: string | null;
  categoria: string | null;
  proyecto: string | null;
  prioridad: string | null;
  abiertoPor: string | null;
  abiertoEn: string;
  asignados: PersonaTicket[];
  evidencias: EvidenciaTicket[];
  /** Liga al portal de tickets ("Mis tickets"; el portal no abre un ticket por URL). */
  url: string | null;
}

export interface RespuestaTickets {
  tickets: TicketAgente[];
  revisado: string;
}

const functions = getFunctions(app, "us-central1");
const llamar = httpsCallable<Record<string, never>, RespuestaTickets>(functions, "agenteTickets", { timeout: 60_000 });

export async function misTickets(): Promise<RespuestaTickets> {
  return (await llamar({})).data;
}

/** "jorge.mendoza@sozu.com" → "Jorge". */
export function nombreDeEmail(email: string | null | undefined): string {
  const base = (email ?? "").split("@")[0].split(/[._-]/)[0];
  return base ? base[0].toUpperCase() + base.slice(1) : "Oye";
}

export function gritosDeTickets(n: number, nombre: string): string[] {
  const t = n === 1 ? "1 ticket" : `${n} tickets`;
  return [
    `¡${nombre}! Tienes ${t} por checar`,
    `¡Ey, ${nombre}! ¡Hay ${t} esperándote!`,
    `¡No mames, ${nombre}, ${t} sin atender!`,
    "¡Dame clic y te los enseño!",
    `¡${nombre}, aguas con los tickets!`,
  ];
}

const fechaLarga = (iso: string) =>
  new Date(iso).toLocaleString("es-MX", { dateStyle: "long", timeStyle: "short", timeZone: "America/Mexico_City" });

/**
 * Prompt en Markdown para pasarle el ticket a Claude Code en el repo que toca.
 * Es un punto de partida: el panel deja editarlo antes de copiarlo.
 */
export function promptDeTicket(t: TicketAgente, repo: RepoRef | null): string {
  const asignados = t.asignados.map((a) => `${a.nombre}${a.email ? ` <${a.email}>` : ""}`).join(", ") || "—";
  const evidencias = t.evidencias.length
    ? t.evidencias.map((e) => `- ${e.tipo}: ${e.nombre}${e.url ? ` — ${e.url}` : ""}`).join("\n")
    : "- (sin evidencias adjuntas)";
  return `# Ticket ${t.folio}: ${t.titulo}

${repo ? `**Repositorio:** \`${repo.owner}/${repo.repo}\`\n` : ""}**Abierto por:** ${t.abiertoPor ?? "—"} · **Fecha:** ${fechaLarga(t.abiertoEn)}
**Asignado a:** ${asignados}
**Etapa:** ${t.etapa ?? "—"}${t.categoria ? ` · **Categoría:** ${t.categoria}` : ""}${t.proyecto ? ` · **Proyecto:** ${t.proyecto}` : ""}${t.prioridad ? ` · **Prioridad:** ${t.prioridad}` : ""}
${t.url ? `**Ticket en el portal:** ${t.url}\n` : ""}
## Descripción del problema

${t.descripcion.trim() || "(sin descripción)"}

## Evidencias

${evidencias}

## Qué necesito

1. Reproduce o ubica el problema en el código${repo ? ` de \`${repo.repo}\`` : ""} a partir de la descripción y las evidencias.
2. Explica la causa raíz con referencias \`archivo:línea\`.
3. Propón el arreglo mínimo y aplícalo en una rama nueva (\`fix/ticket-${t.folio.replace(/[^\w-]/g, "")}\`).
4. Agrega o ajusta pruebas que cubran el caso.
5. Resume qué cambiaste y cómo verificarlo, para responder el ticket.
`;
}
