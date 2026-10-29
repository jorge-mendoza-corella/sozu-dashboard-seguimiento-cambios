/**
 * Datos de las apariencias de GeorgIA (ver skins.tsx): catálogo, paleta y el
 * store global de la elegida. Aparte de los componentes por Fast Refresh.
 */
import { useSyncExternalStore } from "react";

export type Skin = "cyborg" | "abuelo" | "heroe" | "chibi" | "cientifico" | "raton" | "travieso" | "ramon" | "tomaso" | "licesita"
  | "keity" | "abel" | "pablo" | "rodrigo" | "manuel"
  | "cotorrisa" | "cantinflas" | "pantera" | "dino" | "homero" | "stitch" | "linguini" | "ryu"
  // Solo de pareja (salen junto al principal, no se eligen solos): ver PAREJA.
  | "ricardo" | "lilo" | "ken";

export const SKINS: { id: Skin; nombre: string; desc: string }[] = [
  { id: "abuelo", nombre: "Abuelo inventor", desc: "Canas, bigote blanco y sonrisa pícara" },
  { id: "heroe", nombre: "Superhéroe", desc: "Joven, copete y mandíbula marcada" },
  { id: "chibi", nombre: "Chibi", desc: "Cabezota y ojos enormes" },
  { id: "cientifico", nombre: "Científico loco", desc: "Greña blanca, goggles puestos y bata" },
  { id: "raton", nombre: "Ratón clásico", desc: "Orejotas redondas, guantes blancos y short rojo" },
  { id: "travieso", nombre: "Niño travieso", desc: "Pelo en picos, piel amarilla y playera naranja" },
  { id: "ramon", nombre: "Ramón", desc: "Barba corta, pelo hacia atrás y saco oscuro" },
  { id: "tomaso", nombre: "Tomaso", desc: "Lentes al aire, sienes canosas y traje gris" },
  { id: "licesita", nombre: "Licesita", desc: "Pelo lacio oscuro, collar y vestido verde azulado" },
  { id: "keity", nombre: "Keity", desc: "Pelo largo, lentes y blusa de lunares" },
  { id: "abel", nombre: "Abel", desc: "Pelo hacia atrás, barba corta y camisa blanca" },
  { id: "pablo", nombre: "Pablo", desc: "Barba entrecana y saco gris de cuadros" },
  { id: "rodrigo", nombre: "Rodrigo", desc: "Copete, candado, traje azul y corbata" },
  { id: "manuel", nombre: "Manuel", desc: "Pelo al ras, barba de días y todo de negro" },
  { id: "cyborg", nombre: "Cyborg (original)", desc: "Media cara de acero y brazo robótico" },
  { id: "cotorrisa", nombre: "La Cotorrisa", desc: "Slobotzky y Ricardo, con audífonos y risa contagiosa" },
  { id: "cantinflas", nombre: "Cantinflas", desc: "Bigotito, sombrerito y pantalón con mecate" },
  { id: "pantera", nombre: "Pantera Rosa", desc: "Rosa, flaca y muy sigilosa" },
  { id: "dino", nombre: "Dinosaurio", desc: "T-rex verde de bracitos cortos" },
  { id: "homero", nombre: "Homero", desc: "Dos pelos, barba de días y camisa blanca" },
  { id: "stitch", nombre: "Lilo & Stitch", desc: "Experimento 626 con Lilo a un lado" },
  { id: "linguini", nombre: "Ratatouille", desc: "Linguini de cocinero con Remy en el gorro" },
  { id: "ryu", nombre: "Ryu y Ken", desc: "Karategis, cinta roja y hadoukens" },
];
/**
 * Avatares de dos: el compañero sale junto al principal, con la misma pose, y
 * en los chistes se contestan. No se eligen solos.
 */
export const PAREJA: Partial<Record<Skin, Skin>> = { cotorrisa: "ricardo", stitch: "lilo", ryu: "ken" };
export const SKIN_DEFAULT: Skin = "abuelo";
export const esSkin = (v: unknown): v is Skin => SKINS.some((s) => s.id === v);

// ── Correo de cada avatar ───────────────────────────────────────────────────
// Un avatar puede "ser" una persona: si esa persona levantó un ticket, ese
// avatar es el que avisa y trabaja el ticket. Lo configura el root
// en Configuración → GeorgIA (`agente_config/acceso.correosAvatar`); estos son
// los de arranque. "" = sin correo.
export const CORREOS_AVATAR_DEFAULT: Partial<Record<Skin, string>> = {
  ramon: "joseramon.escobar@sozu.com",
  tomaso: "tomas.peterson@sozu.com",
  licesita: "luz.ochoa@sozu.com",
  keity: "keity.galindo@sozu.com",
  abel: "abel.salazar@sozu.com",
  pablo: "pablo.espinosa@sozu.com",
  rodrigo: "rodrigo.terveen@sozu.com",
  manuel: "manuel.nava@sozu.com",
};
let correosAvatar: Partial<Record<Skin, string>> = { ...CORREOS_AVATAR_DEFAULT };

// ── Store global de la apariencia ──────────────────────────────────────────
// Tres capas, gana la primera que haya:
//   1. la del ticket (el avatar de quien lo levantó, mientras toca),
//   2. la propia de quien está logueado (pestaña Avatar del panel),
//   3. la general (la elige el root, es el default de todos).
let skinGeneral: Skin = SKIN_DEFAULT;
let skinPropio: Skin | null = null;
let skinTicket: Skin | null = null;
let version = 0;
const oyentes = new Set<() => void>();
const avisar = () => { version++; oyentes.forEach((f) => f()); };
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
/** Avatar del ticket que toca; `null` = vuelve al propio o al general. */
export function setSkinTicket(s: Skin | null) {
  if (s === skinTicket) return;
  skinTicket = s;
  avisar();
}
/** Correos guardados (encima de los de arranque). */
export function setCorreosAvatar(guardados: Record<string, unknown> | undefined) {
  const n: Partial<Record<Skin, string>> = { ...CORREOS_AVATAR_DEFAULT };
  for (const [k, v] of Object.entries(guardados ?? {})) if (esSkin(k) && typeof v === "string") n[k] = v.trim().toLowerCase();
  correosAvatar = n;
  avisar();
}

// Nombre visible de cada avatar (lo cambia el root; `acceso.nombresAvatar`).
let nombresAvatar: Partial<Record<Skin, string>> = {};
export function setNombresAvatar(guardados: Record<string, unknown> | undefined) {
  const n: Partial<Record<Skin, string>> = {};
  for (const [k, v] of Object.entries(guardados ?? {})) if (esSkin(k) && typeof v === "string" && v.trim()) n[k] = v.trim();
  nombresAvatar = n;
  avisar();
}
/** Nombre del avatar: el que puso el root o el del catálogo. */
export const nombreAvatar = (s: Skin) => nombresAvatar[s] ?? SKINS.find((x) => x.id === s)?.nombre ?? s;
/** Para que el componente se repinte cuando cambian nombres o correos. */
export function useNombresAvatar(): (s: Skin) => string {
  useSyncExternalStore(suscribir, () => version, () => version);
  return nombreAvatar;
}

const local = (e: string) => e.split("@")[0];
/**
 * Avatar de la persona con ese correo. Mismo correo o mismo usuario antes de
 * la @ (en el portal hay quien está con @investimento.mx y aquí con @sozu.com).
 */
export function avatarDeCorreo(correo: string | null | undefined): Skin | null {
  if (!correo) return null;
  const e = correo.trim().toLowerCase();
  const conCorreo = SKINS.filter((s) => correosAvatar[s.id]);
  const s = conCorreo.find((x) => correosAvatar[x.id] === e)
    ?? conCorreo.find((x) => local(correosAvatar[x.id]!) === local(e));
  return s?.id ?? null;
}

/** La que se ve: la del ticket, la propia o, si no, la general. */
export function useSkinGeorgIA(): Skin {
  const v = () => skinTicket ?? skinPropio ?? skinGeneral;
  return useSyncExternalStore(suscribir, v, v);
}
export function useSkinGeneral(): Skin {
  return useSyncExternalStore(suscribir, () => skinGeneral, () => skinGeneral);
}
export function useSkinPropio(): Skin | null {
  return useSyncExternalStore(suscribir, () => skinPropio, () => skinPropio);
}
export function useCorreosAvatar(): Partial<Record<Skin, string>> {
  useSyncExternalStore(suscribir, () => version, () => version);
  return correosAvatar;
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
  /** Faja de tela en lugar del cinturón con hebilla (y sin la línea de botones). */
  faja?: string;
  /** Sin el cuello de camisa (camiseta, o el pelaje de un animal). */
  sinCuello?: boolean;
  /** Cola detrás del cuerpo. */
  cola?: "pantera" | "dino" | "stitch";
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
    piel: ["#f6d2b4", "#d29f7c"], camisa: ["#6b7280", "#9ca3af", "#4b5563"], iris: "#3f2a1d", ceja: "#4b5563", pielSolida: "#d49f7c",
    pantalon: ["#4b5563", "#6b7280", "#374151"], zapato: "#111827", sinEmblema: true,
  },
  // Vestido verde azulado sin mangas, largo (las piernas van del mismo tono).
  licesita: {
    piel: ["#f3cba9", "#cf9874"], camisa: ["#0f5e6b", "#1a7f8e", "#0b4a55"], iris: "#2b1a12", ceja: "#1c1917", pielSolida: "#dfa985",
    pantalon: ["#0f5e6b", "#1a7f8e", "#0b4a55"], zapato: "#1c1917", labios: "#b45a64", brazosDescubiertos: true, sinEmblema: true, faja: "#0b4a55",
  },
  // Blusa blanca de lunares (los pone <Blusa />), pantalón negro.
  keity: {
    piel: ["#ecbd98", "#c2875f"], camisa: ["#e5e7eb", "#ffffff", "#d1d5db"], iris: "#2b1a12", ceja: "#1c1917", pielSolida: "#d9a17b",
    pantalon: ["#111827", "#1f2937", "#030712"], zapato: "#111827", labios: "#b91c1c", sinEmblema: true, faja: "#111827",
  },
  // Camisa blanca sola (cuello abierto: <Camisa />), pantalón azul marino.
  abel: {
    piel: ["#e8b48c", "#b57d55"], camisa: ["#e5e7eb", "#ffffff", "#d1d5db"], iris: "#2b1a12", ceja: "#1f2937", pielSolida: "#cf9a72",
    pantalon: ["#1e293b", "#334155", "#0f172a"], zapato: "#3f2a1d", sinEmblema: true,
  },
  // Saco gris cálido de cuadros sobre camisa blanca.
  pablo: {
    piel: ["#f1c7a3", "#c8906b"], camisa: ["#78716c", "#a8a29e", "#57534e"], iris: "#3f2a1d", ceja: "#292524", pielSolida: "#dba27e",
    pantalon: ["#44403c", "#57534e", "#292524"], zapato: "#1c1917", sinEmblema: true,
  },
  // Traje azul marino, camisa blanca y corbata.
  rodrigo: {
    piel: ["#f2c9a6", "#c99472"], camisa: ["#1e293b", "#334155", "#0f172a"], iris: "#3f2a1d", ceja: "#111827", pielSolida: "#d9a07c",
    pantalon: ["#1e293b", "#334155", "#0f172a"], zapato: "#0c0a09", sinEmblema: true,
  },
  // Saco y camisa negros.
  manuel: {
    piel: ["#dba57d", "#a86d48"], camisa: ["#111827", "#1f2937", "#030712"], iris: "#1c1917", ceja: "#0c0a09", pielSolida: "#c28b62",
    pantalon: ["#111827", "#1f2937", "#030712"], zapato: "#0c0a09", sinEmblema: true,
  },
  // La Cotorrisa: Slobotzky (gorra blanca, barba, playera rosa) y Ricardo (playera azul).
  cotorrisa: {
    sinCuello: true, piel: ["#f1c7a3", "#c8906b"], camisa: ["#db2777", "#ec4899", "#be185d"], iris: "#3f2a1d", ceja: "#1c1917", pielSolida: "#d9a07c",
    pantalon: ["#1f2937", "#374151", "#111827"], zapato: "#f8fafc", sinEmblema: true, faja: "#1f2937",
  },
  ricardo: {
    sinCuello: true, piel: ["#f3cdb0", "#cd9a76"], camisa: ["#1d4ed8", "#3b82f6", "#1e40af"], iris: "#3f2a1d", ceja: "#3f2a1d", pielSolida: "#dda887",
    pantalon: ["#334155", "#475569", "#1e293b"], zapato: "#111827", sinEmblema: true, faja: "#334155",
  },
  // Camiseta blanca, pantalón caído amarrado con mecate.
  cantinflas: {
    sinCuello: true, piel: ["#d9a27a", "#a8704b"], camisa: ["#e7e5e4", "#fafaf9", "#d6d3d1"], iris: "#2b1a12", ceja: "#111827", pielSolida: "#bf8a63",
    pantalon: ["#78716c", "#a8a29e", "#57534e"], zapato: "#3f2a1d", sinEmblema: true, faja: "#ca8a04", brazosDescubiertos: true,
  },
  // Todo rosa: sin ropa ni cinturón (la faja es del mismo rosa).
  pantera: {
    sinCuello: true, cola: "pantera", piel: ["#f9a8d4", "#ec4899"], camisa: ["#f472b6", "#f9a8d4", "#db2777"], iris: "#ca8a04", ceja: "#be185d", pielSolida: "#ec4899",
    pantalon: ["#f472b6", "#f9a8d4", "#db2777"], mano: "#f9a8d4", cuello: "#f472b6", zapato: "#f472b6", sinEmblema: true, faja: "#f472b6",
    brazosDescubiertos: true,
  },
  dino: {
    sinCuello: true, cola: "dino", piel: ["#86efac", "#16a34a"], camisa: ["#22c55e", "#4ade80", "#15803d"], iris: "#ca8a04", ceja: "#14532d", pielSolida: "#16a34a",
    pantalon: ["#22c55e", "#4ade80", "#15803d"], mano: "#4ade80", cuello: "#22c55e", zapato: "#15803d", sinEmblema: true, faja: "#86efac",
    brazosDescubiertos: true,
  },
  // Camisa blanca de manga corta, pantalón azul.
  homero: {
    piel: ["#fde047", "#eab308"], camisa: ["#f8fafc", "#ffffff", "#e2e8f0"], iris: "#0f172a", ceja: "#a16207", pielSolida: "#d4a20a",
    pantalon: ["#1d4ed8", "#3b82f6", "#1e40af"], zapato: "#1e293b", sinEmblema: true,
  },
  stitch: {
    sinCuello: true, cola: "stitch", piel: ["#60a5fa", "#2563eb"], camisa: ["#3b82f6", "#60a5fa", "#1d4ed8"], iris: "#0f172a", ceja: "#1e3a8a", pielSolida: "#2563eb",
    pantalon: ["#3b82f6", "#60a5fa", "#1d4ed8"], mano: "#60a5fa", cuello: "#3b82f6", zapato: "#1d4ed8", sinEmblema: true, faja: "#93c5fd",
    brazosDescubiertos: true,
  },
  // Vestido rojo con hojas blancas, descalza.
  lilo: {
    sinCuello: true, piel: ["#d8a07a", "#a86f4a"], camisa: ["#dc2626", "#ef4444", "#b91c1c"], iris: "#1c1917", ceja: "#111827", pielSolida: "#bb8560",
    pantalon: ["#dc2626", "#ef4444", "#b91c1c"], zapato: "#bb8560", labios: "#9f1239", brazosDescubiertos: true, sinEmblema: true, faja: "#dc2626",
  },
  // Filipina blanca de cocinero.
  linguini: {
    piel: ["#f8d5bc", "#d9a587"], camisa: ["#f8fafc", "#ffffff", "#e2e8f0"], iris: "#3f2a1d", ceja: "#9a3412", pielSolida: "#e2b090",
    pantalon: ["#334155", "#475569", "#1e293b"], zapato: "#111827", sinEmblema: true, faja: "#e2e8f0",
  },
  // Karategi blanco con cinta negra, descalzo.
  ryu: {
    piel: ["#f0c29c", "#c48a62"], camisa: ["#f1f5f9", "#ffffff", "#e2e8f0"], iris: "#2b1a12", ceja: "#111827", pielSolida: "#d49c74",
    pantalon: ["#f1f5f9", "#ffffff", "#e2e8f0"], zapato: "#d49c74", sinEmblema: true, faja: "#111827",
  },
  ken: {
    piel: ["#f6d0b0", "#d29b76"], camisa: ["#dc2626", "#ef4444", "#b91c1c"], iris: "#1e3a8a", ceja: "#ca8a04", pielSolida: "#dfa784",
    pantalon: ["#dc2626", "#ef4444", "#b91c1c"], zapato: "#dfa784", sinEmblema: true, faja: "#111827",
  },
};

