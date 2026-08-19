import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getClientsFor, getClientsWithBilling, type Client } from "@/lib/firestoreClients";
import { getBillingSettings, DEFAULT_BILLING_SETTINGS } from "@/lib/billingSettings";
import { computeBillingOverview, type BillingOverview } from "@/lib/billing";
import { isRootAdmin, adminClientIds, type AppUser } from "@/lib/firestoreUsers";
import { useProjects, useRepos } from "./useProjectsRepos";

/**
 * Identidad y features de los clientes que ESE usuario puede leer: todos si es
 * admin global, sus empresas si no. Va con el usuario por parámetro y no con un
 * `useAuth()` interno para no montar un listener de auth (y sus lecturas) en
 * cada componente que solo quería la lista.
 */
export function useClients(appUser: AppUser | null) {
  return useQuery({
    queryKey: ["clients", appUser?.email ?? "anon"],
    queryFn: () => getClientsFor(appUser),
    enabled: !!appUser,
    staleTime: 60 * 1000,
  });
}

/**
 * Clientes CON sus datos fiscales y tarifas (una lectura extra por cliente, y
 * las reglas solo se lo permiten a superusers). Solo para las pantallas de
 * administración: Negocio y Configuración.
 */
export function useClientsBilling(appUser: AppUser | null) {
  return useQuery({
    queryKey: ["clients", appUser?.email ?? "anon", "billing"],
    queryFn: () => getClientsWithBilling(appUser),
    enabled: !!appUser,
    staleTime: 60 * 1000,
  });
}

export function useBillingSettings() {
  return useQuery({ queryKey: ["billing-settings"], queryFn: getBillingSettings, staleTime: 60 * 1000 });
}

/**
 * Desglose de cobro completo (clientes × proyectos × repos × configuración).
 * Se recalcula en memoria: no pega a Firestore más que por los cuatro queries
 * que ya usa el resto del dashboard. Necesita las tarifas, así que va por
 * `useClientsBilling` (solo superusers).
 */
export function useBillingOverview(
  appUser: AppUser | null = null,
): { overview: BillingOverview; isLoading: boolean } {
  const { data: clients = [], isLoading: l1 } = useClientsBilling(appUser);
  const { data: projects = [], isLoading: l2 } = useProjects();
  const { data: repos = [], isLoading: l3 } = useRepos();
  const { data: settings = DEFAULT_BILLING_SETTINGS, isLoading: l4 } = useBillingSettings();

  const overview = useMemo(() => {
    // Con usuario, el desglose se recorta a sus empresas: un administrador de
    // empresa ve su propia cuenta, no la cartera completa del servicio. Sin
    // usuario (o siendo admin global) se calcula todo.
    const empresas = adminClientIds(appUser);
    const propios = empresas === null ? clients : clients.filter((c) => empresas.includes(c.id));
    const susProyectos =
      empresas === null
        ? projects
        : projects.filter((p) => p.clientId && empresas.includes(p.clientId));
    const susRepos =
      empresas === null
        ? repos
        : repos.filter((r) => susProyectos.some((p) => p.id === r.projectId));
    return computeBillingOverview(propios, susProyectos, susRepos, settings);
  }, [appUser, clients, projects, repos, settings]);

  return { overview, isLoading: l1 || l2 || l3 || l4 };
}

/**
 * Empresas y proyectos que el usuario tiene derecho a ver.
 *
 * Es el corazón del rol "administrador de empresa": manda dentro de sus
 * clientes y no se entera del resto. Para el admin global y el root no filtra
 * nada, y para un viewer el criterio sigue siendo el de siempre —`projectIds`—,
 * que no se toca para no cambiarle el acceso a las cuentas que ya existen.
 */
export function useClientScope(appUser: AppUser | null) {
  const { data: clients = [] } = useClients(appUser);
  const { data: projects = [] } = useProjects();

  return useMemo(() => {
    const empresas = adminClientIds(appUser); // null = ve todas
    const esAdminGlobal = empresas === null;
    const esAdminDeEmpresa = !esAdminGlobal && (empresas?.length ?? 0) > 0;

    const visibleClients = esAdminGlobal
      ? clients
      : clients.filter((c) => empresas!.includes(c.id));

    // Los proyectos se acotan en dos pasos, y los dos importan:
    //   1. la EMPRESA — nadie ve proyectos de una empresa que no es suya;
    //   2. la asignación — `projectIds` marca cuáles de esa empresa le tocan.
    //
    // El paso 2 aplica también al administrador de empresa: tener a Sozu no es
    // lo mismo que trabajar en sus cuatro proyectos, y marcarle uno solo tiene
    // que significar uno solo. `projectIds` vacío = todos los de sus empresas,
    // que es lo que conserva a las cuentas que nunca lo configuraron.
    const suyas = appUser?.clientIds ?? [];
    const asignados = appUser?.projectIds ?? [];
    const visibleProjects = esAdminGlobal
      ? projects
      : (() => {
          const deSusEmpresas =
            suyas.length === 0
              ? projects // legacy sin empresa: se conserva el criterio de siempre
              : projects.filter((p) => p.clientId && suyas.includes(p.clientId));
          return asignados.length === 0
            ? deSusEmpresas
            : deSusEmpresas.filter((p) => asignados.includes(p.id));
        })();

    return {
      esAdminGlobal,
      esAdminDeEmpresa,
      /**
       * Repos asignados. `null` = todos los de sus proyectos visibles; es el
       * default y el que conserva a quien nunca bajó a ese detalle.
       */
      repoIds: (appUser?.repoIds?.length ?? 0) > 0 ? new Set(appUser!.repoIds) : null,
      /** Ids de las empresas que administra; null = todas. */
      clientIds: empresas,
      visibleClients,
      visibleProjects,
      visibleProjectIds: new Set(visibleProjects.map((p) => p.id)),
    };
  }, [appUser, clients, projects]);
}

export interface PublishAppsFeature {
  /** ¿El cliente de ese proyecto tiene la publicación contratada? */
  contratada: (clientId: string | undefined) => boolean;
  /** ¿Este usuario puede publicar ese proyecto? (el root siempre puede) */
  puedePublicar: (clientId: string | undefined) => boolean;
}

export function useCanPublishApps(appUser: AppUser | null): PublishAppsFeature {
  const { data: clients, isLoading } = useClients(appUser);
  const esRoot = isRootAdmin(appUser);
  return useMemo(() => {
    // Mientras la lista no llegue (o si falló), no se apaga nada: apagar el
    // deploy de todos por un fetch lento sería peor que dejarlo pasar.
    if (isLoading || !clients) {
      return { contratada: () => true, puedePublicar: () => true };
    }
    const permitidos = new Set(clients.filter((c) => c.features?.publishApps).map((c) => c.id));
    const conocidos = new Set(clients.map((c) => c.id));
    // Un proyecto sin cliente (o con un cliente ya borrado) no se bloquea: si
    // no, la migración a SaaS apagaría el deploy de todo lo aún sin asignar.
    const contratada = (clientId: string | undefined) =>
      !clientId || !conocidos.has(clientId) ? true : permitidos.has(clientId);
    return { contratada, puedePublicar: (clientId) => esRoot || contratada(clientId) };
  }, [clients, isLoading, esRoot]);
}

/** Sitio de avances por defecto, para el root y los usuarios legacy. */
export const AVANCES_URL_DEFAULT = "https://avances.sozu.com";

export interface AvancesAccess {
  /** Si el link de avances debe aparecer en la navegación. */
  allowed: boolean;
  /** URL a abrir: la del cliente si la configuró, si no la default. */
  url: string;
  /** Clientes del usuario que tienen la visualización contratada. */
  clients: Client[];
}

/**
 * Ver avances es una feature que se contrata por cliente. Un usuario la tiene
 * si alguno de los clientes de SUS proyectos la tiene prendida.
 *
 * Falla ABIERTO igual que `useCanPublishApps`, y por la misma razón: mientras la
 * migración a SaaS no termine, hay proyectos sin cliente y clientes recién
 * creados con la feature apagada por default. Quitarle el link a alguien que hoy
 * lo tiene sería una regresión silenciosa, así que basta con que UNO de sus
 * proyectos no tenga cliente asignado para conservar el acceso. El root siempre
 * lo ve: administra el sitio.
 */
export function useAvancesAccess(appUser: AppUser | null): AvancesAccess {
  const { data: clients, isLoading } = useClients(appUser);
  const { data: projects = [] } = useProjects();

  return useMemo(() => {
    if (!appUser) return { allowed: false, url: AVANCES_URL_DEFAULT, clients: [] };
    // Sin la lista cargada no se decide nada: se conserva el acceso previo.
    if (isLoading || !clients) return { allowed: true, url: AVANCES_URL_DEFAULT, clients: [] };

    const conAvances = clients.filter((c) => c.features?.showAvances);
    if (isRootAdmin(appUser)) {
      return { allowed: true, url: AVANCES_URL_DEFAULT, clients: conAvances };
    }

    // Usuario legacy (ve todo el dashboard): conserva el acceso, y al sitio
    // default — mandarlo al de un cliente cualquiera sería filtrarle avances
    // que no son suyos.
    const ids = appUser.projectIds;
    if (!ids || ids.length === 0) {
      return { allowed: true, url: AVANCES_URL_DEFAULT, clients: [] };
    }

    const suyos = projects.filter((p) => ids.includes(p.id));
    const conocidos = new Set(clients.map((c) => c.id));
    const sinAsignar = suyos.some((p) => !p.clientId || !conocidos.has(p.clientId));
    const susClientes = new Set(
      suyos.filter((p) => p.clientId && conocidos.has(p.clientId)).map((p) => p.clientId as string),
    );
    const propios = conAvances.filter((c) => susClientes.has(c.id));

    if (propios.length === 0) {
      return { allowed: sinAsignar, url: AVANCES_URL_DEFAULT, clients: [] };
    }
    return {
      allowed: true,
      url: propios.find((c) => c.features?.avancesUrl)?.features?.avancesUrl ?? AVANCES_URL_DEFAULT,
      clients: propios,
    };
  }, [clients, isLoading, projects, appUser]);
}
