/**
 * Datos de la utilería de las escenas con guion (ver escenasExtra.tsx). Aparte
 * de los componentes por Fast Refresh.
 */
import type { Skin } from "./skinsDatos";

export type TipoUtileria = "veladora" | "elotero" | "junta" | "stack" | "wifi" | "campamento"
  | "pato" | "review" | "tanda" | "merge" | "derrame" | "nube" | "becario" | "futbol" | "pinata";
export type Utileria = {
  id: number;
  tipo: TipoUtileria;
  /** Esquina de la caja (fija en pantalla). */
  x: number;
  y: number;
  dir: 1 | -1;
  /** Momento de la escena (lo que muestra cada dibujo). */
  fase: string;
  /** Posición inicial del actor (después lo mueve el loop). */
  actor?: { x: number; y: number; dir: 1 | -1 };
  /** Tanda: los avatares del equipo que son usuarios (y cuál se va con el dinero). */
  avatares?: { skin: Skin; nombre: string }[];
  /** Partido de la Selección que se está viendo. */
  partido?: { rival: string; bandera: string; local: boolean };
  saliendo?: boolean;
};

/** Ancho de la caja por escena (el personaje ocupa 0-80). */
export const ANCHO_UTILERIA: Record<TipoUtileria, number> = {
  veladora: 130,
  elotero: 80,
  junta: 170,
  stack: 170,
  wifi: 80,
  campamento: 190,
  pato: 130,
  review: 180,
  tanda: 290,
  merge: 150,
  derrame: 150,
  nube: 80,
  becario: 170,
  futbol: 160,
  pinata: 140,
};

export type PartidoSeleccion = { inicio: string; rival: string; bandera: string; local: boolean; torneo: string; sede?: string | null };
/**
 * Partidos de la Selección Mexicana (varonil mayor). Los llena el sync mensual
 * (ci/seleccion_partidos_sync.py → Firestore `agente_partidos/seleccion`) y el
 * panel los carga al abrir (cargarPartidosSeleccion en lib/agenteRepos.ts).
 */
let partidos: PartidoSeleccion[] = [];
export const setPartidosSeleccion = (lista: PartidoSeleccion[]) => { partidos = lista; };
export const partidosSeleccion = () => partidos;
/** El partido de hoy (en la zona del navegador), si hay. */
export function partidoDeHoy(ahora = new Date()) {
  return partidos.find((p) => new Date(p.inicio).toDateString() === ahora.toDateString()) ?? null;
}
/** Se está jugando (del silbatazo a dos horas después). */
export function partidoEnVivo(ahora = new Date()) {
  const p = partidoDeHoy(ahora);
  if (!p) return null;
  const t = ahora.getTime() - Date.parse(p.inicio);
  return t >= 0 && t <= 2 * 3600_000 ? p : null;
}
/** Lo que sobra arriba del personaje dentro de la caja. */
export const ARRIBA_UTILERIA = 30;
