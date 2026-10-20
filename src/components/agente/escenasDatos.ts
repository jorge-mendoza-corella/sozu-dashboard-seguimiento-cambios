/**
 * Datos de la utilería de las escenas con guion (ver escenasExtra.tsx). Aparte
 * de los componentes por Fast Refresh.
 */
export type TipoUtileria = "veladora" | "elotero" | "junta" | "stack" | "wifi" | "campamento";
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
};
/** Lo que sobra arriba del personaje dentro de la caja. */
export const ARRIBA_UTILERIA = 30;
