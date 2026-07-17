import { useQuery } from "@tanstack/react-query";
import { getProjects, getRepos, type MonitoredRepo } from "@/lib/firestoreProjects";
import { checkRepoAccess } from "@/lib/githubAuth";

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: getProjects, staleTime: 60 * 1000 });
}

export function useRepos() {
  return useQuery({ queryKey: ["repos"], queryFn: getRepos, staleTime: 60 * 1000 });
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
  return useQuery({
    // login (no el token) en la key para no filtrar el PAT a la cache-key.
    queryKey: ["repo-access", login ?? "all", repos.map((r) => r.id).sort().join("|")],
    enabled: repos.length > 0,
    staleTime: 10 * 60 * 1000,
    queryFn: async (): Promise<string[]> => {
      if (!token) return repos.map((r) => r.id);
      const checks = await Promise.all(
        repos.map(async (r) => ((await checkRepoAccess(token, r.owner, r.repo)).ok ? r.id : null)),
      );
      return checks.filter((id): id is string => id !== null);
    },
  });
}
