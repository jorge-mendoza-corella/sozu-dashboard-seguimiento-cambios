import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getClients, getClientsWithBilling, type Client } from "@/lib/firestoreClients";
import { getBillingSettings, DEFAULT_BILLING_SETTINGS } from "@/lib/billingSettings";
import { computeBillingOverview, type BillingOverview } from "@/lib/billing";
import { SUPERUSER_EMAIL, type AppUser } from "@/lib/firestoreUsers";
import { useProjects, useRepos } from "./useProjectsRepos";

/**
 * Identidad y features de los clientes. Es la lectura barata y sin datos
 * sensibles: la usa la navegación, que se monta en todas las páginas.
 */
export function useClients() {
  return useQuery({ queryKey: ["clients"], queryFn: getClients, staleTime: 60 * 1000 });
}

/**
 * Clientes CON sus datos fiscales y tarifas (una lectura extra por cliente, y
 * las reglas solo se lo permiten a superusers). Solo para las pantallas de
 * administración: Negocio y Configuración.
 */
export function useClientsBilling() {
  return useQuery({ queryKey: ["clients", "billing"], queryFn: getClientsWithBilling, staleTime: 60 * 1000 });
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
export function useBillingOverview(): { overview: BillingOverview; isLoading: boolean } {
  const { data: clients = [], isLoading: l1 } = useClientsBilling();
  const { data: projects = [], isLoading: l2 } = useProjects();
  const { data: repos = [], isLoading: l3 } = useRepos();
  const { data: settings = DEFAULT_BILLING_SETTINGS, isLoading: l4 } = useBillingSettings();

  const overview = useMemo(
    () => computeBillingOverview(clients, projects, repos, settings),
    [clients, projects, repos, settings],
  );

  return { overview, isLoading: l1 || l2 || l3 || l4 };
}

/**
 * Publicar apps en las tiendas es una feature de pago por cliente. Devuelve un
 * predicado por `clientId`.
 *
 * Un proyecto SIN cliente asignado sigue pudiendo publicar: si no, al migrar a
 * SaaS todos los proyectos actuales se quedarían sin deploy hasta terminar de
 * asignarlos. En cuanto tiene cliente, manda la feature contratada.
 */
export interface PublishAppsFeature {
  /** ¿El cliente de ese proyecto tiene la publicación contratada? */
  contratada: (clientId: string | undefined) => boolean;
  /** ¿Este usuario puede publicar ese proyecto? (el root siempre puede) */
  puedePublicar: (clientId: string | undefined) => boolean;
}

export function useCanPublishApps(appUser: AppUser | null): PublishAppsFeature {
  const { data: clients, isLoading } = useClients();
  const esRoot = appUser?.email === SUPERUSER_EMAIL;
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
  const { data: clients, isLoading } = useClients();
  const { data: projects = [] } = useProjects();

  return useMemo(() => {
    if (!appUser) return { allowed: false, url: AVANCES_URL_DEFAULT, clients: [] };
    // Sin la lista cargada no se decide nada: se conserva el acceso previo.
    if (isLoading || !clients) return { allowed: true, url: AVANCES_URL_DEFAULT, clients: [] };

    const conAvances = clients.filter((c) => c.features?.showAvances);
    if (appUser.email === SUPERUSER_EMAIL) {
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
