import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Quién está usando la app en este momento.
//
// La fuente es `portal_sesiones` en Supabase: las dos apps Flutter abren sesión
// al entrar y la mantienen viva con un latido cada cinco minutos, con los mismos
// RPCs que usan los portales web. Es la medición que enseña el Portal Alta
// Dirección, así que los dos tableros dicen por fin el mismo número.
//
// Antes esto salía de GA4 Realtime (`activeUsers`), que cuenta dispositivos
// anónimos en su propia ventana: ni las mismas personas, ni la misma ventana, ni
// el mismo universo. Por eso no cuadraba con nada.
//
// Lo copia aquí `ci/portal_online_sync.py` cada diez minutos, porque este
// dashboard vive sobre Firestore y no tiene sesión de Supabase con la que pedir
// esa RPC desde el navegador.
// ---------------------------------------------------------------------------

export interface PortalOnline {
  /** Personas distintas, no sesiones: una misma persona puede tener dos. */
  usuarios: number;
  sesiones: number;
  /** Sesiones desde una app nativa. */
  desdeApp: number;
  /** Sesiones desde un navegador. */
  desdeWeb: number;
  /** Ventana de inactividad con la que se midió. */
  ventanaMinutos: number;
  /** El latido más reciente, ISO. */
  ultimaActividad: string | null;
  /** Cuándo corrió el sync que lo escribió. */
  updatedAt: string | null;
  /**
   * Uso del mes en curso del portal de esa app: personas, sesiones y cuánto
   * dura una sesión. Incluye web, porque la RPC agrega por portal — el "en
   * línea" de arriba sí distingue.
   */
  mes: { usuarios: number; sesiones: number; duracionPromedioMin: number } | null;
}

/**
 * A partir de aquí la lectura ya no describe el presente.
 *
 * El sync corre cada diez minutos; si la última escritura es mucho más vieja,
 * algo dejó de correr. Un "0 en línea" viejo se lee como "no hay nadie", que es
 * una afirmación que en ese momento nadie puede sostener: mejor callar.
 */
const CADUCA_MINUTOS = 35;

export async function getPortalOnline(projectId: string): Promise<PortalOnline | null> {
  const snap = await getDoc(doc(db, "portalOnline", projectId));
  if (!snap.exists()) return null;
  const d = snap.data() as { updatedAt?: { toDate?: () => Date }; raw?: string };

  const updatedAt = d.updatedAt?.toDate ? d.updatedAt.toDate() : null;
  if (!updatedAt) return null;
  if ((Date.now() - updatedAt.getTime()) / 60_000 > CADUCA_MINUTOS) return null;

  try {
    const raw = d.raw ? (JSON.parse(d.raw) as Partial<PortalOnline>) : null;
    if (!raw || typeof raw.usuarios !== "number") return null;
    return {
      usuarios: raw.usuarios,
      sesiones: raw.sesiones ?? 0,
      desdeApp: raw.desdeApp ?? 0,
      desdeWeb: raw.desdeWeb ?? 0,
      ventanaMinutos: raw.ventanaMinutos ?? 30,
      ultimaActividad: raw.ultimaActividad ?? null,
      updatedAt: updatedAt.toISOString(),
      mes: raw.mes ?? null,
    };
  } catch {
    return null;
  }
}
