import { useQuery } from "@tanstack/react-query";
import { fetchRepoStatus, REPOS } from "@/lib/github";

export function useGitHubStatus() {
  return useQuery({
    queryKey: ["github-status"],
    queryFn: () => Promise.all(REPOS.map((r) => fetchRepoStatus(r.owner, r.repo, r.label))),
    refetchInterval: 2 * 60 * 1000,
    staleTime: 90 * 1000,
  });
}
