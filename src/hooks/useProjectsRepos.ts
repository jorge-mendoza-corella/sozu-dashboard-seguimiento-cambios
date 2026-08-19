import { useQuery } from "@tanstack/react-query";
import { getProjects, getRepos, type MonitoredRepo } from "@/lib/firestoreProjects";
import { checkRepoAccess, type RepoAccessCheck } from "@/lib/githubAuth";

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: getProjects, staleTime: 60 * 1000 });
}

export function useRepos() {
  return useQuery({ queryKey: ["repos"], queryFn: getRepos, staleTime: 60 * 1000 });
}

/** Lo que GitHub contestó sobre UN repo, atado al id de su doc en Firestore. */
type RepoCheck = RepoAccessCheck & { id: string };

/** Nombre canónico por id de repo (solo los que GitHub reporta renombrados). */
export type RepoRenames = Map<string, { owner: string; repo: string }>;

const selectAccessibleIds = (checks: RepoCheck[]): string[] =>
  checks.filter((c) => c.ok).map((c) => c.id);

const selectRenames = (checks: RepoCheck[]): RepoRenames =>
  new Map(checks.flatMap((c) => (c.renamedTo ? [[c.id, c.renamedTo] as const] : [])));

/**
 * Query base: UNA pasada por GitHub que deja el resultado COMPLETO de cada repo
 * (acceso + renombre) en cache. Los hooks públicos de abajo comparten esta misma
 * queryKey y queryFn y solo cambian el `select`, así que TanStack Query resuelve
 * los dos con una sola tanda de llamadas — el punto de haberlo partido así es
 * justamente no duplicar el fan-out contra la API de GitHub.
 */
function useRepoChecks<T>(
  repos: MonitoredRepo[],
  token: string | null,
  login: string | null,
  select: (checks: RepoCheck[]) => T,
) {
  return useQuery({
    // login (no el token) en la key para no filtrar el PAT a la cache-key. Sin
    // token la key es "all" aunque haya login: ese resultado no salió de GitHub
    // (ve todo, sin renombres) y no debe compartir entrada con el que sí.
    queryKey: [
      "repo-checks",
      token ? login ?? "token" : "all",
      repos.map((r) => r.id).sort().join("|"),
    ],
    enabled: repos.length > 0,
    staleTime: 10 * 60 * 1000,
    queryFn: async (): Promise<RepoCheck[]> => {
      // Sin token (root/legacy) no se le pregunta nada a GitHub: ve todo y no
      // hay renombres que reportar, porque nadie hizo el GET.
      if (!token) return repos.map((r) => ({ id: r.id, ok: true }));
      return Promise.all(
        repos.map(async (r) => ({ id: r.id, ...(await checkRepoAccess(token, r.owner, r.repo)) })),
      );
    },
    select,
  });
}

/**
 * Ids de repos donde la cuenta de GitHub del usuario es COLABORADORA con
 * permiso de escritura (push). Leer no basta: la mayoría de los repos son
 * públicos y cualquiera los lee — el criterio es ser colaborador real.
 * token null (root/legacy) = ve todos.
 */
export function useAccessibleRepoIds(
  repos: MonitoredRepo[],
  token: string | null,
  login: string | null,
) {
  return useRepoChecks(repos, token, login, selectAccessibleIds);
}

/**
 * Repos que en GitHub ya se llaman de otra forma. El dashboard los tiene dados
 * de alta con el nombre viejo: hoy GitHub redirige, pero el repo puede
 * desaparecer de las tarjetas sin ninguna pista de por qué, así que hay que
 * avisarlo.
 */
export function useRepoRenames(
  repos: MonitoredRepo[],
  token: string | null,
  login: string | null,
) {
  return useRepoChecks(repos, token, login, selectRenames);
}
