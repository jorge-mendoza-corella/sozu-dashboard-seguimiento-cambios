import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Descargas acumuladas de cada app.
//
// Ni Play ni Apple dejan preguntarlo desde el navegador (una exige firmar un
// JWT con la llave privada, la otra entrega reportes comprimidos), así que un
// workflow diario —.github/workflows/store-installs-sync.yml— los consulta y
// deja el resultado en Firestore. Aquí solo se lee.
// ---------------------------------------------------------------------------

export interface PlayInstalls {
  /** Descargas contadas en el rango que la Reporting API conserva. */
  descargas: number;
  desinstalaciones: number;
  /** Dispositivos activos que la tienen instalada hoy. */
  activos: number;
  descargas30d: number;
  desinstalaciones30d: number;
  desde: string;
  hasta: string;
  /** El total no cubre toda la vida de la app: Play no guarda tanto atrás. */
  parcial?: boolean;
}

export interface AppStoreInstalls {
  descargas: number;
  primeraVez: number;
  redescargas: number;
  descargasUltimoMes: number;
  ultimoMes: string;
  desde: string;
  hasta: string;
  parcial?: boolean;
  /** Apple aún está generando el reporte (lo pide el sync, tarda ~1 día). */
  pendiente?: boolean;
}

export interface InstallsDoc<T> {
  updatedAt: string | null;
  data: T | null;
  error: string | null;
}

async function leer<T>(coleccion: string, id: string): Promise<InstallsDoc<T> | null> {
  const snap = await getDoc(doc(db, coleccion, id));
  if (!snap.exists()) return null;
  const d = snap.data() as { updatedAt?: { toDate?: () => Date }; raw?: string; error?: string | null };
  let data: T | null;
  try {
    const raw = d.raw ? JSON.parse(d.raw) : null;
    data = raw && Object.keys(raw).length ? (raw as T) : null;
  } catch {
    data = null;
  }
  return {
    updatedAt: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : null,
    data,
    error: d.error ?? null,
  };
}

export const getPlayInstalls = (pkg: string) => leer<PlayInstalls>("playInstalls", pkg);
export const getAppStoreInstalls = (bundleId: string) => leer<AppStoreInstalls>("appStoreInstalls", bundleId);

/** 1234 → "1.2k". El badge vive entre versiones: el número largo lo rompería. */
export function compacto(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 1234 → "1,234", para el tooltip, donde sí cabe el número exacto. */
export const exacto = (n: number) => n.toLocaleString("es-MX");

/** "2026-09" o "2026-09-01" → "sep 2026" / "1 sep 2026". */
export function fechaCorta(iso: string): string {
  const partes = iso.split("-").map(Number);
  if (partes.length < 2 || partes.some(Number.isNaN)) return iso;
  const [y, m, d] = partes;
  const mes = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("es-MX", { month: "short", timeZone: "UTC" });
  return d ? `${d} ${mes} ${y}` : `${mes} ${y}`;
}
