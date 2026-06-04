import { useQuery } from "@tanstack/react-query";
import { fetchRepoStatus, type RepoRef } from "@/lib/github";

export function useGitHubStatus(repos: RepoRef[]) {
  const key = repos.map((r) => `${r.owner}/${r.repo}`).sort();
  return useQuery({
    queryKey: ["github-status", key],
    queryFn: () => Promise.all(repos.map((r) => fetchRepoStatus(r.owner, r.repo, r.label))),
    enabled: repos.length > 0,
    refetchInterval: 2 * 60 * 1000,
    staleTime: 90 * 1000,
  });
}
