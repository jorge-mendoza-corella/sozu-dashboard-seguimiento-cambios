/**
 * Datos de las apariencias de GeorgIA (ver skins.tsx): catálogo, paleta y el
 * store global de la elegida. Aparte de los componentes por Fast Refresh.
 */
import { useSyncExternalStore } from "react";

export type Skin = "cyborg" | "abuelo" | "heroe" | "chibi" | "cientifico" | "raton" | "travieso" | "ramon" | "tomaso" | "licesita";

export const SKINS: { id: Skin; nombre: string; desc: string }[] = [
  { id: "abuelo", nombre: "Abuelo inventor", desc: "Canas, bigote blanco y sonrisa pícara" },
  { id: "heroe", nombre: "Superhéroe", desc: "Joven, copete y mandíbula marcada" },
  { id: "chibi", nombre: "Chibi", desc: "Cabezota y ojos enormes" },
  { id: "cientifico", nombre: "Científico loco", desc: "Greña blanca, goggles puestos y bata" },
  { id: "raton", nombre: "Ratón clásico", desc: "Orejotas redondas, guantes blancos y short rojo" },
  { id: "travieso", nombre: "Niño travieso", desc: "Pelo en picos, piel amarilla y playera naranja" },
  { id: "ramon", nombre: "Ramón", desc: "Barba corta, pelo hacia atrás y saco oscuro" },
  { id: "tomaso", nombre: "Tomaso", desc: "Lentes al aire, cara delgada y traje gris" },
  { id: "licesita", nombre: "Licesita", desc: "Pelo lacio oscuro, collar y vestido verde azulado" },
  { id: "cyborg", nombre: "Cyborg (original)", desc: "Media cara de acero y brazo robótico" },
];
export const SKIN_DEFAULT: Skin = "abuelo";
export const esSkin = (v: unknown): v is Skin => SKINS.some((s) => s.id === v);

// ── Store global de la apariencia ──────────────────────────────────────────
// Dos capas: la general (la elige el root, es el default de todos) y la propia
// de quien está logueado (pestaña Avatar del panel). Se ve la propia si hay.
let skinGeneral: Skin = SKIN_DEFAULT;
let skinPropio: Skin | null = null;
const oyentes = new Set<() => void>();
const avisar = () => oyentes.forEach((f) => f());
const suscribir = (f: () => void) => { oyentes.add(f); return () => { oyentes.delete(f); }; };

export function setSkinGeorgIA(s: Skin) {
  if (s === skinGeneral) return;
  skinGeneral = s;
  avisar();
}
/** `null` = sin elegir: usa la general. */
export function setSkinPropio(s: Skin | null) {
  if (s === skinPropio) return;
  skinPropio = s;
  avisar();
}
/** La que se ve: la propia o, si no eligió, la general. */
export function useSkinGeorgIA(): Skin {
  return useSyncExternalStore(suscribir, () => skinPropio ?? skinGeneral, () => skinPropio ?? skinGeneral);
}
export function useSkinGeneral(): Skin {
  return useSyncExternalStore(suscribir, () => skinGeneral, () => skinGeneral);
}
export function useSkinPropio(): Skin | null {
  return useSyncExternalStore(suscribir, () => skinPropio, () => skinPropio);
}

/** Colores por skin (los usan los gradientes, con id por skin para no chocar). */
export const PALETA: Record<Skin, {
  piel: [string, string];
  camisa: [string, string, string];
  iris: string;
  ceja: string;
  pielSolida: string;
  /** Por omisión, mezclilla. */
  pantalon?: [string, string, string];
  /** Color liso de las manos (guantes); por omisión, la piel. */
  mano?: string;
  /** Cuello; por omisión, la piel. */
  cuello?: string;
  zapato?: string;
  /** Labios; por omisión, café. */
  labios?: string;
  /** Sin mangas: brazos con la piel (vestido). */
  brazosDescubiertos?: boolean;
  /** Sin engrane ni botones de latón en el pecho (el saco o el vestido los tapan). */
  sinEmblema?: boolean;
}> = {
  cyborg: { piel: ["#f0c4a0", "#c98c65"], camisa: ["#7d8591", "#9aa1ab", "#5c636e"], iris: "#3b5240", ceja: "#111827", pielSolida: "#d9a07a" },
  abuelo: { piel: ["#ffd9bd", "#e09b74"], camisa: ["#8b95a5", "#b8c1cd", "#717c8c"], iris: "#3f6212", ceja: "#e5e7eb", pielSolida: "#f2b993" },
  heroe: { piel: ["#ffd9bd", "#e09b74"], camisa: ["#64748b", "#94a3b8", "#475569"], iris: "#1d4ed8", ceja: "#111827", pielSolida: "#f2b993" },
  chibi: { piel: ["#ffe1c9", "#eaa983"], camisa: ["#8b95a5", "#b8c1cd", "#717c8c"], iris: "#7c3aed", ceja: "#111827", pielSolida: "#f6c4a2" },
  cientifico: { piel: ["#f7c9a3", "#c98458"], camisa: ["#8b95a5", "#b8c1cd", "#717c8c"], iris: "#0f172a", ceja: "#e5e7eb", pielSolida: "#e2a77d" },
  raton: {
    piel: ["#ffe0c2", "#f0b48a"], camisa: ["#111827", "#374151", "#030712"], iris: "#0f172a", ceja: "#111827", pielSolida: "#e8a77c",
    pantalon: ["#b91c1c", "#ef4444", "#991b1b"], mano: "#f8fafc", cuello: "#111827", zapato: "#f59e0b",
  },
  travieso: {
    piel: ["#fde047", "#eab308"], camisa: ["#ea580c", "#f97316", "#c2410c"], iris: "#0f172a", ceja: "#a16207", pielSolida: "#d4a20a",
    pantalon: ["#1d4ed8", "#3b82f6", "#1e40af"], zapato: "#1e293b",
  },
  // Piel morena, saco carbón (la camisa gris clara la pone <Saco />) y pantalón de vestir.
  ramon: {
    piel: ["#dca57c", "#a86f49"], camisa: ["#1f2937", "#374151", "#111827"], iris: "#3f2a1d", ceja: "#111827", pielSolida: "#bb8058",
    pantalon: ["#1e293b", "#334155", "#0f172a"], zapato: "#0c0a09", sinEmblema: true,
  },
  // Piel clara, traje gris medio (la camisa blanca la pone <Saco />).
  tomaso: {
    piel: ["#f6d2b4", "#d29f7c"], camisa: ["#6b7280", "#9ca3af", "#4b5563"], iris: "#3f2a1d", ceja: "#1f2937", pielSolida: "#e0ae8a",
    pantalon: ["#4b5563", "#6b7280", "#374151"], zapato: "#111827", sinEmblema: true,
  },
  // Vestido verde azulado sin mangas, largo (las piernas van del mismo tono).
  licesita: {
    piel: ["#f3cba9", "#cf9874"], camisa: ["#0f5e6b", "#1a7f8e", "#0b4a55"], iris: "#2b1a12", ceja: "#1c1917", pielSolida: "#dfa985",
    pantalon: ["#0f5e6b", "#1a7f8e", "#0b4a55"], zapato: "#1c1917", labios: "#b45a64", brazosDescubiertos: true, sinEmblema: true,
  },
};

