import { useQuery } from "@tanstack/react-query";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { processCosts } from "@/lib/anthropicAdmin";
import { getMappings } from "@/lib/firestoreAnthropicMapping";
import type { RawUsageBucket, AnthropicOrgUser, Mapping } from "@/lib/anthropicAdmin";

export interface CostsCache {
  bucketsJson: string;
  orgUsersJson: string;
  updatedAt: string;
}

interface RawCostsData {
  allBuckets: RawUsageBucket[];
  orgUsers: AnthropicOrgUser[];
  mappings: Mapping[];
  updatedAt: string;
  rawMappings: Record<string, string>;
}

// Single queryKey — fetches raw 90-day data once. Changing windowDays re-transforms
// via `select` without a new Firestore read (instantaneous, no loading spinner).
export function useAnthropicCosts(windowDays: number, enabled = true) {
  return useQuery({
    queryKey: ["anthropic-costs-data"],
    enabled,
    queryFn: async (): Promise<RawCostsData> => {
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

      return {
        allBuckets,
        orgUsers,
        mappings,
        updatedAt: cache.updatedAt,
        rawMappings: Object.fromEntries(mappings.map((m) => [m.accountId, m.githubLogin])),
      };
    },
    select: (raw: RawCostsData) => {
      const sinceStr = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const filtered = raw.allBuckets.filter((b) => b.starting_at.slice(0, 10) >= sinceStr);
      return {
        ...processCosts(filtered, raw.orgUsers, raw.mappings, windowDays),
        orgUsers: raw.orgUsers,
        updatedAt: raw.updatedAt,
        rawMappings: raw.rawMappings,
      };
    },
    staleTime: 10 * 60 * 1000, // 10 min; sync runs every 15 min
    retry: false,
  });
}
