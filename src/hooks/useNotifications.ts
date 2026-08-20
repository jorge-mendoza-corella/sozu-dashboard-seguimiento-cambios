import { useQueries, useQuery } from "@tanstack/react-query";
import {
  getClientWhatsapp, resolveWhatsapp,
  type ResolvedWhatsapp, type WhatsappConfig,
} from "@/lib/notificationSettings";
import type { AppUser } from "@/lib/firestoreUsers";
import { useClients } from "./useClients";

export function useClientWhatsapp(clientId: string | undefined) {
  return useQuery({
    queryKey: ["whatsapp", "client", clientId],
    queryFn: () => getClientWhatsapp(clientId!),
    enabled: !!clientId,
    staleTime: 60 * 1000,
  });
}

export interface ClientNotificationRow {
  clientId: string;
  /** Lo que la empresa tiene guardado (null = nunca se configuró). */
  propia: WhatsappConfig | null;
  /** Lo que se usaría al mandar, y si alcanza para mandar algo. */
  efectiva: ResolvedWhatsapp;
}

/**
 * Configuración de WhatsApp de todas las empresas visibles.
 *
 * Es un doc por cliente, así que se piden en paralelo con `useQueries` en lugar
 * de una consulta de colección: los docs cuelgan de cada cliente y las reglas
 * los acotan uno por uno.
 */
export function useWhatsappByClient(appUser: AppUser | null): {
  rows: ClientNotificationRow[];
  isLoading: boolean;
} {
  const { data: clients = [], isLoading: cargandoClientes } = useClients(appUser);

  const queries = useQueries({
    queries: clients.map((c) => ({
      queryKey: ["whatsapp", "client", c.id],
      queryFn: () => getClientWhatsapp(c.id),
      staleTime: 60 * 1000,
    })),
  });

  const cargandoPropias = queries.some((q) => q.isLoading);
  // Sin memo: son un puñado de clientes y `resolveWhatsapp` es aritmética de
  // strings. Memoizarlo obligaría a meter en las dependencias el arreglo que
  // `useQueries` rearma en cada render, que es justo lo que no se puede comparar.
  const rows: ClientNotificationRow[] = clients.map((c, i) => {
    const propia = queries[i]?.data ?? null;
    return { clientId: c.id, propia, efectiva: resolveWhatsapp(propia) };
  });

  return { rows, isLoading: cargandoClientes || cargandoPropias };
}

/**
 * ¿Cada empresa manda avisos de WhatsApp? Para el badge de Resumen y CI/CD.
 *
 * Devuelve un mapa `clientId → manda`, y solo para quien PUEDE leer esa
 * configuración: las reglas la abren al superuser y al administrador de esa
 * empresa, nadie más. Para el resto el mapa viene vacío y el badge no se pinta,
 * en vez de mostrar "apagada" —que es lo que parecería un permission-denied— y
 * hacer creer que los avisos están mal configurados.
 */
export function useAvisosPorEmpresa(appUser: AppUser | null): Map<string, boolean> {
  const puedeLeer = appUser?.role === "superuser" || appUser?.role === "client_admin";
  const { rows } = useWhatsappByClient(puedeLeer ? appUser : null);
  return new Map(rows.map((r) => [r.clientId, r.efectiva.puedeEnviar]));
}
