import { useMemo } from "react";
import { Smartphone, Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useProjects } from "@/hooks/useProjectsRepos";
import { SUPERUSER_EMAIL, resolvePermissions } from "@/lib/firestoreUsers";
import { isCodemagicConfigured } from "@/lib/codemagic";
import { AppBuildsPanel } from "@/components/codemagic/AppBuildsPanel";

export function DeployAppsPage() {
  const { appUser } = useAuth();
  const isRoot = appUser?.email === SUPERUSER_EMAIL;
  const perms = resolvePermissions(appUser);
  const { data: allProjects = [], isLoading } = useProjects();

  // Mismos criterios de visibilidad que el dashboard + solo proyectos APP vinculados.
  const appProjects = useMemo(() => {
    const ids = appUser?.projectIds;
    const visible = isRoot || !ids || ids.length === 0
      ? allProjects
      : allProjects.filter((p) => ids.includes(p.id));
    return visible.filter((p) => p.isApp && p.codemagicAppId);
  }, [allProjects, isRoot, appUser?.projectIds]);

  return (
    <div className="p-6 max-w-4xl">
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-1">
          <Smartphone className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          <h1 className="text-xl font-bold tracking-tight">Deploy Apps</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Construye artefactos (Android/iOS) y envíalos a las stores vía Codemagic.
          Los builds se habilitan cuando el deploy web del repo terminó.
        </p>
      </div>

      {!isCodemagicConfigured ? (
        <p className="text-sm text-muted-foreground">
          Falta configurar el token de Codemagic (VITE_CODEMAGIC_TOKEN).
        </p>
      ) : isLoading ? (
        <div className="flex h-40 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Cargando…
        </div>
      ) : appProjects.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Smartphone className="h-8 w-8" />
          <p className="text-sm">No hay apps vinculadas.</p>
          <p className="text-xs">
            En CI/CD → Gestionar, marca un proyecto como APP y vincúlale su app de Codemagic.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {appProjects.map((p) => (
            <section key={p.id}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: p.color }} />
                {p.name}
              </h2>
              <AppBuildsPanel appId={p.codemagicAppId!} perms={perms} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
