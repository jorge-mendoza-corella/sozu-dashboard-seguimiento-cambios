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
  /**
   * Mes al que corresponde el consumo, "YYYY-MM".
   *
   * El endpoint devuelve el ciclo EN CURSO pero no lo nombra, y el tablero
   * enseñaba el número a secas: 25,199 minutos sin fecha se leen como acumulado
   * histórico. Sale de la fecha de las propias líneas de consumo.
   */
  periodo: string | null;
  /** Primer y último día con consumo del ciclo. `null` en la plataforma vieja. */
  periodoDesde: string | null;
  periodoHasta: string | null;
  /**
   * Lo que costaría sin descuentos, y lo descontado. Solo en la plataforma de
   * facturación nueva; en la vieja no existen y quedan en 0.
   *
   * Vale la pena enseñarlos: la diferencia entre el bruto y el neto es lo que
   * el plan está absorbiendo, y sin verla no se entiende por qué 25,000
   * minutos se cobran como 37 dólares.
   */
  costoBruto: number;
  descuento: number;
  /** "nueva" cuando el dato viene del endpoint de usage. */
  plataforma: string | null;
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
            periodo: null,
            periodoDesde: null,
            periodoHasta: null,
            costoBruto: 0,
            descuento: 0,
            plataforma: null,
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
      periodo: raw.periodo ?? null,
      periodoDesde: raw.periodoDesde ?? null,
      periodoHasta: raw.periodoHasta ?? null,
      costoBruto: raw.costoBruto ?? 0,
      descuento: raw.descuento ?? 0,
      plataforma: raw.plataforma ?? null,
      updatedAt,
      error: d.error ?? null,
    };
  } catch {
    return null;
  }
}
