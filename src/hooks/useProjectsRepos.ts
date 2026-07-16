import { useQuery } from "@tanstack/react-query";
import { getProjects, getRepos, type MonitoredRepo } from "@/lib/firestoreProjects";
import { canReadRepo } from "@/lib/githubAuth";

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: getProjects, staleTime: 60 * 1000 });
}

export function useRepos() {
  return useQuery({ queryKey: ["repos"], queryFn: getRepos, staleTime: 60 * 1000 });
}

/**
 * Ids de repos que la cuenta de GitHub del usuario puede VER (según su API
 * key). El gate de visibilidad real es GitHub: si su cuenta no es
 * colaboradora de un repo privado, ese repo no aparece en el dashboard.
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
        repos.map(async (r) => ((await canReadRepo(token, r.owner, r.repo)) ? r.id : null)),
      );
      return checks.filter((id): id is string => id !== null);
    },
  });
}
