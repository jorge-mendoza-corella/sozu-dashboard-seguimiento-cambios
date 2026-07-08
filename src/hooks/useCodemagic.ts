import { useQuery } from "@tanstack/react-query";
import {
  getCodemagicApps, getRecentBuilds, buildStatusInfo, isCodemagicConfigured,
} from "@/lib/codemagic";

export function useCodemagicApps() {
  return useQuery({
    queryKey: ["codemagic-apps"],
    queryFn: getCodemagicApps,
    enabled: isCodemagicConfigured,
    staleTime: 10 * 60 * 1000,
  });
}

export function useCodemagicBuilds(appId: string | undefined) {
  return useQuery({
    queryKey: ["codemagic-builds", appId],
    queryFn: () => getRecentBuilds(appId!),
    enabled: isCodemagicConfigured && !!appId,
    staleTime: 10 * 1000,
    // Polling agresivo solo mientras hay un build en curso.
    refetchInterval: (query) => {
      const builds = query.state.data;
      const active = builds?.some((b) => buildStatusInfo(b.status).isRunning);
      return active ? 15 * 1000 : 60 * 1000;
    },
  });
}
