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
}

export interface Consola {
  lineas: LineaConsola[];
  activo: boolean;
}

export function useConsola(issue: number): Consola {
  const [c, setC] = useState<Consola>({ lineas: [], activo: false });
  useEffect(
    () =>
      onSnapshot(
        doc(db, "agente_claude_log", String(issue)),
        (snap) => {
          const d = snap.data();
          setC({ lineas: Array.isArray(d?.lineas) ? (d.lineas as LineaConsola[]) : [], activo: d?.activo === true });
        },
        () => setC({ lineas: [], activo: false }),
      ),
    [issue],
  );
  return c;
}

