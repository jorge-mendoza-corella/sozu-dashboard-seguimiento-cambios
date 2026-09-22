import { useQuery } from "@tanstack/react-query";
import { getPlayTracks } from "@/lib/playTracks";
import { getAppStoreStatus } from "@/lib/appStoreStatus";
import { rezagoDeTiendas, type RezagoTiendas } from "@/lib/versionesApp";

/**
 * Cuánto le falta a cada tienda para alcanzar a la web.
 *
 * Las mismas claves de react-query que usa la barra del front, a propósito: la
 * pestaña de Deploy App y la tarjeta preguntan lo mismo y comparten respuesta,
 * así que enseñarlo en los dos sitios no cuesta una llamada más.
 */
export function useRezagoTiendas({
  versionWeb,
  androidPackage,
  iosBundleId,
}: {
  versionWeb: string | null;
  androidPackage?: string;
  iosBundleId?: string;
}): RezagoTiendas {
  const { data: play } = useQuery({
    queryKey: ["play-tracks", androidPackage],
    queryFn: () => getPlayTracks(androidPackage!),
    enabled: !!androidPackage,
    staleTime: 5 * 60_000,
  });
  const { data: appStore } = useQuery({
    queryKey: ["appstore-status", iosBundleId],
    queryFn: () => getAppStoreStatus(iosBundleId!),
    enabled: !!iosBundleId,
    staleTime: 5 * 60_000,
  });

  return rezagoDeTiendas(versionWeb, play, appStore, {
    conAndroid: !!androidPackage,
    conIos: !!iosBundleId,
  });
}
