/**
 * Datos de las apariencias de GeorgIA (ver skins.tsx): catálogo, paleta y el
 * store global de la elegida. Aparte de los componentes por Fast Refresh.
 */
import { useSyncExternalStore } from "react";

export type Skin = "cyborg" | "abuelo" | "heroe" | "chibi" | "cientifico";

export const SKINS: { id: Skin; nombre: string; desc: string }[] = [
  { id: "abuelo", nombre: "Abuelo inventor", desc: "Canas, bigote blanco y sonrisa pícara" },
  { id: "heroe", nombre: "Superhéroe", desc: "Joven, copete y mandíbula marcada" },
  { id: "chibi", nombre: "Chibi", desc: "Cabezota y ojos enormes" },
  { id: "cientifico", nombre: "Científico loco", desc: "Greña blanca, goggles puestos y bata" },
  { id: "cyborg", nombre: "Cyborg (original)", desc: "Media cara de acero y brazo robótico" },
];
export const SKIN_DEFAULT: Skin = "abuelo";
export const esSkin = (v: unknown): v is Skin => SKINS.some((s) => s.id === v);

// ── Store global de la apariencia ──────────────────────────────────────────
let skinActual: Skin = SKIN_DEFAULT;
const oyentes = new Set<() => void>();
export function setSkinGeorgIA(s: Skin) {
  if (s === skinActual) return;
  skinActual = s;
  oyentes.forEach((f) => f());
}
export function useSkinGeorgIA(): Skin {
  return useSyncExternalStore(
    (f) => { oyentes.add(f); return () => oyentes.delete(f); },
    () => skinActual,
    () => skinActual,
  );
}

/** Colores por skin (los usan los gradientes, con id por skin para no chocar). */
export const PALETA: Record<Skin, { piel: [string, string]; camisa: [string, string, string]; iris: string; ceja: string; pielSolida: string }> = {
  cyborg: { piel: ["#f0c4a0", "#c98c65"], camisa: ["#7d8591", "#9aa1ab", "#5c636e"], iris: "#3b5240", ceja: "#111827", pielSolida: "#d9a07a" },
  abuelo: { piel: ["#ffd9bd", "#e09b74"], camisa: ["#8b95a5", "#b8c1cd", "#717c8c"], iris: "#3f6212", ceja: "#e5e7eb", pielSolida: "#f2b993" },
  heroe: { piel: ["#ffd9bd", "#e09b74"], camisa: ["#64748b", "#94a3b8", "#475569"], iris: "#1d4ed8", ceja: "#111827", pielSolida: "#f2b993" },
  chibi: { piel: ["#ffe1c9", "#eaa983"], camisa: ["#8b95a5", "#b8c1cd", "#717c8c"], iris: "#7c3aed", ceja: "#111827", pielSolida: "#f6c4a2" },
  cientifico: { piel: ["#f7c9a3", "#c98458"], camisa: ["#8b95a5", "#b8c1cd", "#717c8c"], iris: "#0f172a", ceja: "#e5e7eb", pielSolida: "#e2a77d" },
};

