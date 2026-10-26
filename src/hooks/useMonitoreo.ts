import { useMemo } from "react";
import type { AppUser } from "@/lib/firestoreUsers";
import { veMonitoreoDe } from "@/lib/sentry";
import { useProjects, useRepos } from "@/hooks/useProjectsRepos";
import { reposAsignadosAlUsuario, useClientScope } from "@/hooks/useClients";

/**
 * Repos cuyos errores de Sentry puede ver el usuario.
 *
 * Dos cortes, los mismos que en el resto del dashboard: el ALCANCE (sus
 * empresas, sus proyectos asignados y, dentro de ellos, sus repos) y el
 * PERMISO `verMonitoreo` resuelto para cada repo (repo > empresa > general).
 * Si la lista sale vacía, la pestaña no aparece.
 *
 * `cargando` existe para la ruta: mientras llegan proyectos y repos la lista
 * está vacía, y sin esto un refresh en /monitoreo rebotaba a la portada.
 */
export function useReposMonitoreo(appUser: AppUser | null) {
  const { data: repos, isLoading: l1 } = useRepos();
  const { data: projects, isLoading: l2 } = useProjects();
  const { visibleProjectIds, repoIds } = useClientScope(appUser);

  const permitidos = useMemo(() => {
    const empresaDe = new Map((projects ?? []).map((p) => [p.id, p.clientId ?? null]));
    const enAlcance = reposAsignadosAlUsuario(
      (repos ?? []).filter((r) => visibleProjectIds.has(r.projectId)),
      repoIds,
    );
    return enAlcance.filter((r) => veMonitoreoDe(appUser, empresaDe.get(r.projectId), r.id));
  }, [appUser, projects, repos, visibleProjectIds, repoIds]);

  return { repos: permitidos, cargando: !!appUser && (l1 || l2) };
}
