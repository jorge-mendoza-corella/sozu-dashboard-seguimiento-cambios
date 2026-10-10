import { useEffect, useMemo } from "react";
import { useQueries, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { fetchRepoStatus, type RepoRef, type RepoStatus } from "@/lib/github";

/**
 * Estado de GitHub de cada repo, con una consulta POR REPO.
 *
 * Todo esto sale del mismo límite de 5,000 peticiones/hora de una cuenta, que
 * comparten todas las pestañas del dashboard. Antes era una sola consulta con
 * todos los repos: en cuanto UNO desplegaba, todos se pedían cada 20 s, en
 * todas las pestañas y aunque estuvieran en segundo plano, y el límite se
 * acababa en minutos. Ahora:
 *
 *   · solo el repo que está desplegando se pide seguido; el resto, en calma;
 *   · una pestaña oculta no pregunta (al volver a ella se refresca sola);
 *   · varias pestañas abiertas se reparten el trabajo: la que pregunta le pasa
 *     el resultado a las demás (BroadcastChannel) y esas no repiten la llamada;
 *   · CI/CD y Resumen comparten el caché de cada repo.
 *
 * La clave sigue empezando con "github-status" (el vigía de GeorgIA y las
 * invalidaciones la escuchan por prefijo); ahora el dato es un solo RepoStatus.
 */

/** Sin nada corriendo: el estado de un repo no cambia de un minuto a otro. */
const REPOSO_MS = 2 * 60 * 1000;

/**
 * Con un deploy en curso en ESE repo: 20 s, para que la barra de progreso se
 * cierre cuando el run pase a `completed` y no se quede pegada al tope.
 */
const DEPLOYANDO_MS = 20 * 1000;

const corriendo = (st: RepoStatus | undefined) =>
  !!st?.latestRuns.some((r) => r.status === "in_progress" || r.status === "queued");

const intervalo = (st: RepoStatus | undefined) => (corriendo(st) ? DEPLOYANDO_MS : REPOSO_MS);

export const claveGitHubStatus = (r: Pick<RepoRef, "owner" | "repo">) => ["github-status", `${r.owner}/${r.repo}`] as const;

// ── Reparto entre pestañas ─────────────────────────────────────────────────
type Mensaje = { clave: string; dato: RepoStatus; en: number };
const canal = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("github-status") : null;
/** Cuándo llegó de otra pestaña el último dato de cada repo. */
const recibidoDeOtra = new Map<string, number>();
/** "Actualizar" a mano: esa vez se pregunta aunque otra pestaña acabe de hacerlo. */
let forzar = false;

function escucharOtrasPestañas(qc: QueryClient): () => void {
  if (!canal) return () => {};
  const alMensaje = (ev: MessageEvent<Mensaje>) => {
    const { clave, dato, en } = ev.data;
    recibidoDeOtra.set(clave, en);
    qc.setQueryData(["github-status", clave], dato, { updatedAt: en });
  };
  canal.addEventListener("message", alMensaje);
  return () => canal.removeEventListener("message", alMensaje);
}

async function consultar(qc: QueryClient, r: RepoRef): Promise<RepoStatus> {
  const clave = `${r.owner}/${r.repo}`;
  const previo = qc.getQueryData<RepoStatus>(["github-status", clave]);
  const llegó = recibidoDeOtra.get(clave) ?? 0;
  // Otra pestaña lo trajo hace poco: se usa ese dato y no se gasta una llamada.
  if (!forzar && previo && Date.now() - llegó < intervalo(previo) * 0.8) return previo;
  const dato = await fetchRepoStatus(r.owner, r.repo, r.label);
  canal?.postMessage({ clave, dato, en: Date.now() } satisfies Mensaje);
  return dato;
}

export function useGitHubStatus(repos: RepoRef[]) {
  const qc = useQueryClient();
  useEffect(() => escucharOtrasPestañas(qc), [qc]);

  const resultados = useQueries({
    queries: repos.map((r) => ({
      queryKey: claveGitHubStatus(r),
      queryFn: () => consultar(qc, r),
      refetchInterval: (query: { state: { data?: RepoStatus } }) => intervalo(query.state.data),
      // Pestaña oculta: no pregunta. Al volver, el dato ya está viejo y
      // react-query lo refresca solo (refetchOnWindowFocus).
      refetchIntervalInBackground: false,
      staleTime: 15 * 1000,
    })),
  });

  const listos = resultados.every((q) => q.data !== undefined);
  const claveDatos = resultados.map((q) => q.dataUpdatedAt).join("|");
  const data = useMemo(
    () => (repos.length && listos ? resultados.map((q) => q.data as RepoStatus) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listos, claveDatos, repos.length],
  );

  return {
    data,
    isLoading: resultados.some((q) => q.isLoading),
    isFetching: resultados.some((q) => q.isFetching),
    dataUpdatedAt: resultados.reduce((max, q) => Math.max(max, q.dataUpdatedAt), 0),
    error: resultados.find((q) => q.error)?.error ?? null,
    refetch: async () => {
      forzar = true;
      try {
        await Promise.all(resultados.map((q) => q.refetch()));
      } finally {
        forzar = false;
      }
    },
  };
}
