/**
 * Consola en vivo de Claude Code de un issue (`agente_claude_log/{issue}`), en
 * tiempo real. Una sola suscripción para la vista en línea y la flotante.
 */
import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";

export interface LineaConsola {
  t: number;
  tipo: string;
  texto: string;
  /** Sigla del repo (BD, BE, FE…), si la acción toca uno. */
  repo?: string;
}

export interface Consola {
  lineas: LineaConsola[];
  activo: boolean;
  /** Id de la sesión de Claude Code de la última corrida (llega al terminar). */
  sesion: string | null;
}

export function useConsola(issue: number): Consola {
  const [c, setC] = useState<Consola>({ lineas: [], activo: false, sesion: null });
  useEffect(
    () =>
      onSnapshot(
        doc(db, "agente_claude_log", String(issue)),
        (snap) => {
          const d = snap.data();
          setC({
            lineas: Array.isArray(d?.lineas) ? (d.lineas as LineaConsola[]) : [],
            activo: d?.activo === true,
            sesion: typeof d?.sesion === "string" ? d.sesion : null,
          });
        },
        () => setC({ lineas: [], activo: false, sesion: null }),
      ),
    [issue],
  );
  return c;
}

