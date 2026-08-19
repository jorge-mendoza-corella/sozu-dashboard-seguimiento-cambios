import { useQueries, useQuery } from "@tanstack/react-query";
import {
  getClientWhatsapp, getGlobalWhatsapp, resolveWhatsapp,
  EMPTY_WHATSAPP, type ResolvedWhatsapp, type WhatsappConfig,
} from "@/lib/notificationSettings";
import type { AppUser } from "@/lib/firestoreUsers";
import { useClients } from "./useClients";

export function useGlobalWhatsapp() {
  return useQuery({
    queryKey: ["whatsapp", "global"],
    queryFn: getGlobalWhatsapp,
    staleTime: 60 * 1000,
  });
}

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
  /** Lo que la empresa tiene puesto (null = no ha configurado nada propio). */
  propia: WhatsappConfig | null;
  /** Lo que realmente se usaría al mandar: lo suyo, o el default global. */
  efectiva: ResolvedWhatsapp;
}

/**
 * Config de WhatsApp de todas las empresas visibles, resuelta contra el default
 * global. Es un doc por cliente, así que se piden en paralelo con `useQueries`
 * en lugar de una consulta de colección (los docs cuelgan de cada cliente).
 */
export function useWhatsappByClient(appUser: AppUser | null): {
  global: WhatsappConfig;
  rows: ClientNotificationRow[];
  isLoading: boolean;
} {
  const { data: clients = [], isLoading: cargandoClientes } = useClients(appUser);
  const { data: global = EMPTY_WHATSAPP, isLoading: cargandoGlobal } = useGlobalWhatsapp();

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
    return { clientId: c.id, propia, efectiva: resolveWhatsapp(global, propia) };
  });

  return { global, rows, isLoading: cargandoClientes || cargandoGlobal || cargandoPropias };
}
