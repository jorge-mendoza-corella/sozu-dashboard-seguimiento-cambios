import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Lo que Codemagic factura, por app.
//
// No se pide a Codemagic desde aquí: `/user` —el único endpoint con el
// desglose de facturación— no manda cabeceras CORS, así que el navegador
// recibe "Failed to fetch". `/apps` y `/builds` sí las mandan, que es por lo
// que el resto del panel funciona y este dato no.
//
// Lo lee el sync diario (`ci/codemagic_usage_sync.py`), que corre en Actions y
// no tiene esa restricción, y lo deja en `codemagicConsumo/{appId}`.
// ---------------------------------------------------------------------------

export interface ConsumoPeriodo {
  /** Minutos que de verdad se facturan. */
  minutosPagados: number;
  /** Minutos consumidos del cupo gratis del mes. */
  minutosGratis: number;
  /** Todo el tiempo de máquina, se cobre o no. */
  minutosTotales: number;
  usd: number;
}

export interface RepartoApp {
  minutosApp: number;
  minutosCuenta: number;
  /** Fracción 0..1 de la factura que le toca a esta app. */
  parte: number;
  usd: number;
  apps: number;
}

export interface ConsumoCodemagic {
  /** Quién paga: el equipo, o la cuenta personal. */
  ambito: string;
  actual: ConsumoPeriodo;
  anterior: ConsumoPeriodo;
  /** Null cuando no hubo minutos en la ventana y no hay nada que repartir. */
  reparto: RepartoApp | null;
  /** Cuándo corrió el sync que lo escribió. */
  updatedAt: string | null;
}

export async function getConsumoCodemagic(appId: string): Promise<ConsumoCodemagic | null> {
  const snap = await getDoc(doc(db, "codemagicConsumo", appId));
  if (!snap.exists()) return null;
  const d = snap.data() as { updatedAt?: { toDate?: () => Date }; raw?: string };
  try {
    const raw = d.raw ? (JSON.parse(d.raw) as Omit<ConsumoCodemagic, "updatedAt">) : null;
    if (!raw?.actual) return null;
    return {
      ...raw,
      updatedAt: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : null,
    };
  } catch {
    return null;
  }
}
