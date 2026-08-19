import { clientDisplayName, type Client } from "./firestoreClients";
import type { Project } from "./firestoreProjects";

// ---------------------------------------------------------------------------
// Empresas presentes en un conjunto de proyectos. Vive aparte del componente
// que las pinta porque lo usan dos pantallas (Resumen y CI/CD) y porque una
// función exportada junto a un componente rompe el fast refresh de Vite.
// ---------------------------------------------------------------------------

export interface EmpresaOption {
  id: string;
  nombre: string;
  color: string;
  proyectos: number;
}

/**
 * Empresas presentes en esos proyectos, con cuántos tiene cada una. Los
 * proyectos sin empresa se agrupan aparte: no se le cobran a nadie y conviene
 * que se vean, no que desaparezcan de la navegación.
 */
export function empresasDeProyectos(projects: Project[], clients: Client[]): EmpresaOption[] {
  const conteo = new Map<string, number>();
  for (const p of projects) conteo.set(p.clientId ?? "", (conteo.get(p.clientId ?? "") ?? 0) + 1);

  return [...conteo.entries()]
    .map(([id, proyectos]) => {
      const c = clients.find((x) => x.id === id);
      return {
        id,
        nombre: c ? clientDisplayName(c) : "Sin empresa",
        color: c?.color ?? "#94a3b8",
        proyectos,
      };
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}
