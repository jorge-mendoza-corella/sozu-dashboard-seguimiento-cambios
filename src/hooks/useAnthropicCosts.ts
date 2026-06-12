import { useQuery } from "@tanstack/react-query";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { processCosts } from "@/lib/anthropicAdmin";
import { getMappings } from "@/lib/firestoreAnthropicMapping";
import type { RawUsageBucket, AnthropicOrgUser } from "@/lib/anthropicAdmin";

export interface CostsCache {
  bucketsJson: string;
  orgUsersJson: string;
  updatedAt: string;
}

export function useAnthropicCosts(windowDays: number) {
  return useQuery({
    queryKey: ["anthropic-costs", windowDays],
    queryFn: async () => {
      const [cacheSnap, mappings] = await Promise.all([
        getDoc(doc(db, "anthropic_costs_cache", "latest")),
        getMappings(),
      ]);

      if (!cacheSnap.exists()) {
        throw new Error(
          "Sin datos de costos. Ejecuta el workflow 'Sync Anthropic Costs → Firestore' en GitHub Actions.",
        );
      }

      const cache = cacheSnap.data() as CostsCache;
      const allBuckets: RawUsageBucket[] = JSON.parse(cache.bucketsJson ?? "[]");
      const orgUsers: AnthropicOrgUser[] = JSON.parse(cache.orgUsersJson ?? "[]");

      // Filter to windowDays window
      const sinceStr = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const filtered = allBuckets.filter((b) => b.starting_at.slice(0, 10) >= sinceStr);

      return {
        ...processCosts(filtered, orgUsers, mappings, windowDays),
        orgUsers,
        updatedAt: cache.updatedAt,
      };
    },
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
}
