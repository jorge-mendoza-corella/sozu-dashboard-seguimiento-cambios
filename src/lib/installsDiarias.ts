import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Serie diaria de instalaciones de una app.
//
// Es una copia de lectura: la fuente es la tabla de Supabase que alimenta el
// Portal Alta Dirección, y ahí es donde se mezcla lo medido (GA4, App Store)
// con la siembra de arranque. El sync la deja aquí porque este dashboard vive
// sobre Firestore y no tiene cliente de Supabase — y sin la copia, los dos
// tableros enseñarían números distintos de lo mismo, que es peor que no
// enseñarlos.
// ---------------------------------------------------------------------------

export interface DiaInstalaciones {
  /** ISO corto, `2026-09-09`. */
  fecha: string;
  android: number;
  ios: number;
  /** Cuántas de ese día son reparto estimado, no medición. */
  estimado: number;
}

export interface InstallsDiarias {
  dias: DiaInstalaciones[];
  total: number;
  /** Cuándo corrió el sync que la escribió. */
  updatedAt: string | null;
}

export async function getInstallsDiarias(projectId: string): Promise<InstallsDiarias | null> {
  const snap = await getDoc(doc(db, "installsDiarias", projectId));
  if (!snap.exists()) return null;
  const d = snap.data() as { updatedAt?: { toDate?: () => Date }; raw?: string };
  try {
    const raw = d.raw ? (JSON.parse(d.raw) as { dias?: DiaInstalaciones[]; total?: number }) : null;
    if (!raw?.dias?.length) return null;
    return {
      dias: raw.dias,
      total: raw.total ?? raw.dias.reduce((s, x) => s + x.android + x.ios, 0),
      updatedAt: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : null,
    };
  } catch {
    return null;
  }
}

/**
 * Hasta qué día llega la medición. `null` si la serie viene vacía.
 *
 * Suele ser ayer: la tienda publica el reporte de un día al día siguiente y
 * Analytics tarda unas horas en consolidar el día en curso. No recorta la
 * gráfica —hoy se dibuja igual, porque un día de hoy que falta también es una
 * respuesta— pero sí es lo que el pie usa para decir hasta dónde hay lectura.
 */
export function corteDe(dias: DiaInstalaciones[]): string | null {
  let max: string | null = null;
  for (const d of dias) if (!max || d.fecha > max) max = d.fecha;
  return max;
}

/**
 * Los últimos `n` días, hasta HOY, rellenando los que no tienen registro.
 *
 * Un día sin instalaciones no viene en la serie, y sin rellenarlo la curva
 * uniría dos fechas separadas por semanas como si fueran consecutivas: mentiría
 * sobre el ritmo, que es justo lo que se está mirando.
 *
 * Hoy se dibuja aunque vaya en cero. Cortar la serie en el último día medido
 * escondía el día que más se mira, y "hoy no llevamos ninguna" es una respuesta
 * tan buena como cualquier otra: lo que hacía falta no era quitar el punto,
 * sino que el pie de la gráfica diga hasta dónde hay lectura de verdad.
 */
export function ultimosDias(dias: DiaInstalaciones[], n: number): DiaInstalaciones[] {
  const porFecha = new Map(dias.map((d) => [d.fecha, d]));
  const salida: DiaInstalaciones[] = [];
  const hoy = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const f = new Date(hoy);
    f.setUTCDate(f.getUTCDate() - i);
    const fecha = f.toISOString().slice(0, 10);
    salida.push(porFecha.get(fecha) ?? { fecha, android: 0, ios: 0, estimado: 0 });
  }
  return salida;
}
