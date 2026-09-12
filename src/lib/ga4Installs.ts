import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Instalaciones DIARIAS por plataforma, desde Google Analytics 4.
//
// Las tiendas no dan el día a día: Play publica un informe por mes cerrado y
// Apple tarda un día en generar los suyos. GA4 sí, porque cada app manda
// `first_open` la primera vez que alguien la abre tras instalarla.
//
// No es lo mismo que "descargas de la tienda" —quien descarga y no abre no
// cuenta, quien reinstala en otro aparato sí— así que va al lado de los
// números de tienda, nunca en su lugar. Lo escribe `ci/ga4_installs_sync.py`.
// ---------------------------------------------------------------------------

export interface DiaInstalls {
  /** ISO `2026-09-10`. */
  fecha: string;
  android: number;
  ios: number;
}

/**
 * El pulso de la app: lo que Analytics ve en los últimos 30 minutos.
 *
 * Es la única lectura de GA4 que es de verdad al momento. El reporte diario no
 * publica el día en curso hasta consolidarlo, y eso tarda horas. No se suma a
 * nada: otra métrica, otra ventana.
 */
export interface Ga4EnVivo {
  ventanaMinutos: number;
  /** Primeras aperturas —instalaciones estrenadas— en la ventana. */
  aperturas: { android: number; ios: number };
  /** Gente con la app abierta en la ventana. */
  activos: { android: number; ios: number };
  /** Cuándo se leyó, ISO. */
  medidoEn: string;
}

export interface Ga4Installs {
  property: string;
  dias: DiaInstalls[];
  android: number;
  ios: number;
  android30d: number;
  ios30d: number;
  desde: string;
  hasta: string;
  /** GA4 todavía no registra ninguna primera apertura. */
  pendiente?: boolean;
  enVivo?: Ga4EnVivo;
}

export interface Ga4Doc {
  updatedAt: string | null;
  data: Ga4Installs | null;
  error: string | null;
}

export async function getGa4Installs(projectId: string): Promise<Ga4Doc | null> {
  const snap = await getDoc(doc(db, "ga4Installs", projectId));
  if (!snap.exists()) return null;
  const d = snap.data() as { updatedAt?: { toDate?: () => Date }; raw?: string; error?: string | null };
  let data: Ga4Installs | null;
  try {
    const raw = d.raw ? JSON.parse(d.raw) : null;
    // Vale con que traiga el pulso: cuando GA4 aún no tiene serie, es lo único
    // que hay, y descartarlo dejaba la pantalla igual que si no midiera nada.
    data =
      raw && (raw.dias || raw.enVivo)
        // `dias` se normaliza a lista: quien la recorre no tiene por qué saber
        // que el documento puede venir solo con el pulso.
        ? ({ ...raw, dias: raw.dias ?? [] } as Ga4Installs)
        : null;
  } catch {
    data = null;
  }
  return {
    updatedAt: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : null,
    data,
    error: d.error ?? null,
  };
}

/** Los últimos `n` días, rellenando con ceros los que GA4 no reportó. */
export function ultimosDias(dias: DiaInstalls[], n: number): DiaInstalls[] {
  const porFecha = new Map(dias.map((d) => [d.fecha, d]));
  const hoy = new Date();
  const salida: DiaInstalls[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const f = new Date(hoy);
    f.setUTCDate(f.getUTCDate() - i);
    const iso = f.toISOString().slice(0, 10);
    // Un día sin evento no viene en el reporte, y sin rellenarlo la gráfica
    // juntaría días separados por semanas como si fueran consecutivos.
    salida.push(porFecha.get(iso) ?? { fecha: iso, android: 0, ios: 0 });
  }
  return salida;
}
