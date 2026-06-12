import { useQuery } from "@tanstack/react-query";
import {
  fetchOrgUsers,
  fetchUsageBuckets,
  processCosts,
  hasAdminKey,
} from "@/lib/anthropicAdmin";
import { getMappings } from "@/lib/firestoreAnthropicMapping";

export function useAnthropicCosts(windowDays: number) {
  return useQuery({
    queryKey: ["anthropic-costs", windowDays],
    queryFn: async () => {
      const [buckets, orgUsers, mappings] = await Promise.all([
        fetchUsageBuckets(windowDays),
        fetchOrgUsers(),
        getMappings(),
      ]);
      return processCosts(buckets, orgUsers, mappings, windowDays);
    },
    enabled: hasAdminKey(),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
