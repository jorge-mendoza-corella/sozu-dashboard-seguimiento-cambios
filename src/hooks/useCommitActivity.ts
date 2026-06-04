import { useQuery } from "@tanstack/react-query";
import { fetchCommitActivity, type RepoRef } from "@/lib/github";

export function useCommitActivity(repos: RepoRef[], windowDays = 30) {
  const key = repos.map((r) => `${r.owner}/${r.repo}`).sort();
  return useQuery({
    queryKey: ["commit-activity", windowDays, key],
    queryFn: () => fetchCommitActivity(repos, windowDays),
    enabled: repos.length > 0,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
}
