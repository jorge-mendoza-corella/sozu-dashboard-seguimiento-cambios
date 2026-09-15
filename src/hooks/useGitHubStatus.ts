import { useQuery } from "@tanstack/react-query";
import { fetchRepoStatus, type RepoRef, type RepoStatus } from "@/lib/github";

/** Sin nada corriendo: el estado de un repo no cambia de un minuto a otro. */
const REPOSO_MS = 2 * 60 * 1000;

/**
 * Con un deploy en curso: 20s.
 *
 * La barra de progreso avanza sola con el reloj del navegador, pero quién la
 * cierra es el dato —que el run pasó a `completed`—. Con el refresco de dos
 * minutos la barra se quedaba pegada al tope un buen rato después de que el
 * deploy había terminado, que es exactamente la duda que venía a resolver.
 *
 * No baja de ahí por el rate limit: el token es compartido entre todos los
 * repos del tablero y cada corrida pide un repo completo.
 */
const DEPLOYANDO_MS = 20 * 1000;

function algunoCorriendo(datos: RepoStatus[] | undefined): boolean {
  return !!datos?.some((repo) =>
    repo.latestRuns.some((r) => r.status === "in_progress" || r.status === "queued"),
  );
}

export function useGitHubStatus(repos: RepoRef[]) {
  const key = repos.map((r) => `${r.owner}/${r.repo}`).sort();
  return useQuery({
    queryKey: ["github-status", key],
    queryFn: () => Promise.all(repos.map((r) => fetchRepoStatus(r.owner, r.repo, r.label))),
    enabled: repos.length > 0,
    // El intervalo se decide con lo último que se leyó: mientras haya un deploy
    // vivo se pregunta seguido, y en cuanto termina vuelve solo a la calma.
    refetchInterval: (query) => (algunoCorriendo(query.state.data) ? DEPLOYANDO_MS : REPOSO_MS),
    // Que la pestaña esté en segundo plano es justo cuando más se agradece:
    // se vuelve a ella para ver si ya terminó, no para esperar a que refresque.
    refetchIntervalInBackground: true,
    staleTime: 15 * 1000,
  });
}
