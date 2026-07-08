import { useQuery } from "@tanstack/react-query";
import {
  getCodemagicApps, getRecentBuilds, buildStatusInfo, isCodemagicConfigured,
} from "@/lib/codemagic";
import { getBranchHeadSha, hasActiveDeployRun } from "@/lib/github";

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

/** HEAD actual de la rama del repo de la app (para no reconstruir el mismo código). */
export function useBranchHead(owner?: string, repo?: string, branch?: string) {
  return useQuery({
    queryKey: ["branch-head", owner, repo, branch],
    queryFn: () => getBranchHeadSha(owner!, repo!, branch!),
    enabled: !!owner && !!repo && !!branch,
    staleTime: 45 * 1000,
    refetchInterval: 60 * 1000,
  });
}

/** ¿Hay un deploy (web) corriendo en el repo de la app? Bloquea el build. */
export function useActiveDeploy(owner?: string, repo?: string) {
  return useQuery({
    queryKey: ["active-deploy", owner, repo],
    queryFn: () => hasActiveDeployRun(owner!, repo!),
    enabled: !!owner && !!repo,
    staleTime: 20 * 1000,
    refetchInterval: 30 * 1000,
  });
}
