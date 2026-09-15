import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Lo que lleva consumido la cuenta de GitHub Actions.
//
// Lo escribe `ci/github_billing_sync.py`, no el navegador: leer el billing exige
// un token con scope `user` —permiso amplio sobre la cuenta personal— y pedirle
// eso al token de cada persona que entra al tablero, por un número de gasto, es
// desproporcionado. Aquí solo viaja el resultado.
//
// Quién lo ve se decide en la UI: es información de administración.
// ---------------------------------------------------------------------------

export interface GithubActionsUso {
  /** Cuenta de la que se leyó. */
  usuario: string;
  /** Cupo del plan, en minutos. 0 en cuentas sin cupo incluido. */
  minutosIncluidos: number;
  minutosUsados: number;
  /** Los que se pasaron del cupo: estos son los que se cobran. */
  minutosPagados: number;
  /** Porcentaje del cupo consumido. `null` cuando no hay cupo que medir. */
  pctCupo: number | null;
  /** Minutos por tipo de máquina: UBUNTU, MACOS, WINDOWS. */
  minutosPorMaquina: Record<string, number>;
  /**
   * Importe estimado de los minutos pagados.
   *
   * Aproximado a propósito: GitHub devuelve minutos, no dinero, y no dice
   * cuáles de los pagados fueron de macOS —que cuesta diez veces Linux—, así
   * que el reparto se hace en proporción al consumo de cada máquina.
   */
  costoAproximado: number;
  /** Días que faltan para que el ciclo de facturación reinicie. */
  ciclo: number | null;
  updatedAt: string | null;
  /** Por qué no hay datos, cuando no los hay. */
  error: string | null;
}

export async function getGithubActionsUso(): Promise<GithubActionsUso | null> {
  const snap = await getDoc(doc(db, "githubActionsUso", "global"));
  if (!snap.exists()) return null;
  const d = snap.data() as {
    updatedAt?: { toDate?: () => Date };
    raw?: string;
    error?: string | null;
  };

  const updatedAt = d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : null;

  try {
    const raw = d.raw ? (JSON.parse(d.raw) as Partial<GithubActionsUso>) : null;
    // Con error y sin datos igual se devuelve algo: el tablero prefiere decir
    // por qué no sabe a comportarse como si el consumo fuera cero.
    if (!raw || typeof raw.minutosUsados !== "number") {
      return d.error
        ? {
            usuario: "",
            minutosIncluidos: 0,
            minutosUsados: 0,
            minutosPagados: 0,
            pctCupo: null,
            minutosPorMaquina: {},
            costoAproximado: 0,
            ciclo: null,
            updatedAt,
            error: d.error,
          }
        : null;
    }
    return {
      usuario: raw.usuario ?? "",
      minutosIncluidos: raw.minutosIncluidos ?? 0,
      minutosUsados: raw.minutosUsados,
      minutosPagados: raw.minutosPagados ?? 0,
      pctCupo: raw.pctCupo ?? null,
      minutosPorMaquina: raw.minutosPorMaquina ?? {},
      costoAproximado: raw.costoAproximado ?? 0,
      ciclo: raw.ciclo ?? null,
      updatedAt,
      error: d.error ?? null,
    };
  } catch {
    return null;
  }
}
