import { useQuery } from "@tanstack/react-query";
import { fetchCommitActivity } from "@/lib/github";

export function useCommitActivity(windowDays = 30) {
  return useQuery({
    queryKey: ["commit-activity", windowDays],
    queryFn: () => fetchCommitActivity(windowDays),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
}
