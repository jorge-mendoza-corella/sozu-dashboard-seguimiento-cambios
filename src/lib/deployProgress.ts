import type { WorkflowRun } from "./github";

// ---------------------------------------------------------------------------
// Cuánto lleva un deploy y cuánto suele tardar.
//
// Un spinner dice "está pasando algo" y nada más. La pregunta de quien lo mira
// es otra: ¿me espero o me voy por un café? Eso solo se responde comparando lo
// que lleva corriendo contra lo que tardó las veces anteriores.
//
// GitHub no publica un porcentaje de avance, así que se estima: mediana de los
// deploys buenos de ESE workflow. No es exacto y no pretende serlo —por eso la
// barra nunca llega al final sola, solo la cierra el run al terminar.
// ---------------------------------------------------------------------------

/** Un deploy corriendo, con lo que hace falta para pintarlo. */
export interface ProgresoDeploy {
  /** Milisegundos desde que arrancó de verdad. */
  transcurridoMs: number;
  /** Lo que suele tardar este workflow. `null` si no hay con qué comparar. */
  tipicoMs: number | null;
  /**
   * Avance estimado, 0-96. `null` mientras espera runner: ahí no hay nada que
   * estimar, y una barra avanzando durante la cola miente dos veces —dice que
   * progresa y luego cae a cero cuando el run arranca de verdad.
   */
  pct: number | null;
  /** Todavía en cola: GitHub aceptó el run pero ningún runner lo tomó. */
  enCola: boolean;
  /** `mm:ss` de lo que lleva. */
  reloj: string;
  /** Va tardando bastante más de lo normal. */
  tarde: boolean;
}

/**
 * Cuánto duró un run terminado. `null` si le faltan las marcas de tiempo.
 *
 * Se mide desde que ARRANCÓ, no desde que se creó: la cola es espera de
 * infraestructura, no trabajo del deploy, y meterla en el promedio inflaría la
 * estimación justo los días en que GitHub anda saturado.
 */
function duracionDe(run: WorkflowRun): number | null {
  const inicio = run.runStartedAt ?? run.createdAt;
  const fin = run.updatedAt;
  if (!inicio || !fin) return null;
  const ms = new Date(fin).getTime() - new Date(inicio).getTime();
  return ms > 0 ? ms : null;
}

/**
 * Lo que tarda normalmente ese workflow, en milisegundos.
 *
 * Mediana y no promedio: un deploy que se quedó colgado veinte minutos, o uno
 * que reintentó, arrastra la media a un número que no describe ninguna corrida
 * real. La mediana lo ignora sin tener que decidir qué es un caso raro.
 */
export function tipicoDe(run: WorkflowRun, terminados: WorkflowRun[] | undefined): number | null {
  if (!terminados?.length) return null;
  const mismos = terminados.filter(
    (r) =>
      r.runId !== run.runId &&
      (run.workflowId ? r.workflowId === run.workflowId : r.name === run.name),
  );
  const duraciones = mismos.map(duracionDe).filter((d): d is number => d !== null);
  // Con una sola muestra no hay "lo normal", hay una anécdota. Mejor barra
  // indeterminada que un porcentaje inventado sobre un caso.
  if (duraciones.length < 2) return null;
  duraciones.sort((a, b) => a - b);
  const medio = Math.floor(duraciones.length / 2);
  return duraciones.length % 2
    ? duraciones[medio]
    : Math.round((duraciones[medio - 1] + duraciones[medio]) / 2);
}

/**
 * El progreso de un deploy que está corriendo ahora.
 *
 * `ahora` se pasa desde fuera para que el componente mande el reloj: así todas
 * las barras de la pantalla laten al mismo tiempo y con un solo `setInterval`.
 */
export function progresoDe(
  run: WorkflowRun,
  terminados: WorkflowRun[] | undefined,
  ahora: number,
): ProgresoDeploy {
  const enCola = run.status === "queued" || !run.runStartedAt;
  const referencia = run.runStartedAt ?? run.createdAt;
  const transcurridoMs = referencia ? Math.max(0, ahora - new Date(referencia).getTime()) : 0;
  const tipicoMs = tipicoDe(run, terminados);

  const mm = Math.floor(transcurridoMs / 60000);
  const ss = String(Math.floor(transcurridoMs / 1000) % 60).padStart(2, "0");

  return {
    transcurridoMs,
    tipicoMs,
    // Tope en 96: la barra no debe llegar al final por su cuenta. Un 100% con
    // el deploy todavía corriendo es peor que no tener barra — promete algo
    // que no está en la mano de nadie cumplir.
    pct: !enCola && tipicoMs ? Math.min(96, Math.round((transcurridoMs / tipicoMs) * 100)) : null,
    enCola,
    reloj: `${mm}:${ss}`,
    // Pasado de un 50% del tiempo normal ya no es "va lento", es que algo va
    // distinto: vale la pena que quien mira lo sepa en vez de seguir esperando.
    tarde: !enCola && !!tipicoMs && transcurridoMs > tipicoMs * 1.5,
  };
}

/** `~4m típico`, o cadena vacía si no hay con qué comparar. */
export function textoTipico(tipicoMs: number | null): string {
  if (!tipicoMs) return "";
  const min = Math.round(tipicoMs / 60000);
  if (min >= 1) return `~${min}m típico`;
  return `~${Math.max(1, Math.round(tipicoMs / 1000))}s típico`;
}
