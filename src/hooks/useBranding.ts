import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  brandTriplet, esUrlDeImagen, foregroundForHex, getPublicBranding, resolveBranding,
  VENDOR_RESOLVED, type ResolvedBranding,
} from "@/lib/branding";
import { adminClientIds, type AppUser } from "@/lib/firestoreUsers";
import { useClients } from "./useClients";

/**
 * Marca activa para este usuario: la de su empresa si tiene una sola con marca,
 * y la del proveedor en cualquier otro caso (equipo interno, o alguien que
 * administra varias empresas).
 */
export function useBranding(appUser: AppUser | null): ResolvedBranding {
  const { data: clients } = useClients(appUser);
  // El admin global ve todas las empresas: si hubiera una sola con marca, se
  // habría llevado la marca de ese cliente por todo el dashboard.
  const esAdminGlobal = adminClientIds(appUser) === null;
  return clients ? resolveBranding(clients, esAdminGlobal) : VENDOR_RESOLVED;
}

/**
 * Marca del dominio por el que se entró. Sirve para pintar el login, donde
 * todavía no hay sesión y por lo tanto no se sabe de qué empresa es quien entra.
 * Sin doc para ese host, devuelve null y el login se queda con la del proveedor.
 */
export function usePublicBranding() {
  const hostname = typeof window === "undefined" ? "" : window.location.hostname;
  return useQuery({
    queryKey: ["public-branding", hostname],
    queryFn: () => getPublicBranding(hostname),
    enabled: !!hostname,
    staleTime: 10 * 60 * 1000,
  });
}

// Título y favicon con los que arrancó el documento. Se capturan UNA vez, a
// nivel de módulo: si cada efecto guardara "el anterior", al encadenar pantallas
// con marca el cleanup restauraría la marca previa —la del tenant del que se
// acaba de salir— en lugar de la del proveedor.
const TITULO_ORIGINAL = typeof document === "undefined" ? "" : document.title;
const FAVICON_ORIGINAL =
  typeof document === "undefined"
    ? null
    : document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.getAttribute("href") ?? null;

/**
 * Aplica la marca al documento: color, título de la pestaña y favicon.
 *
 * El color se mete pisando las variables de shadcn en el elemento raíz, que es
 * de donde cuelgan TODAS las clases de Tailwind (`bg-primary`, `text-primary`,
 * `ring-ring`…). Así la marca tiñe la interfaz completa sin tocar un solo
 * componente. Al desmontar se quitan las propiedades en línea, para que el tema
 * vuelva al de la hoja de estilos sin dejar rastro.
 */
export function useApplyBranding(branding: {
  appName?: string;
  primaryColor?: string;
  faviconUrl?: string;
}) {
  const { appName, primaryColor, faviconUrl } = branding;

  useEffect(() => {
    const raiz = document.documentElement;
    // `brandTriplet` acota la luminosidad: `--primary` también se usa como color
    // de TEXTO, y una marca casi blanca dejaba el header ilegible.
    const triplete = primaryColor ? brandTriplet(primaryColor) : null;
    if (!triplete) return;
    raiz.style.setProperty("--primary", triplete);
    raiz.style.setProperty("--ring", triplete);
    raiz.style.setProperty("--primary-foreground", foregroundForHex(primaryColor!));
    return () => {
      raiz.style.removeProperty("--primary");
      raiz.style.removeProperty("--ring");
      raiz.style.removeProperty("--primary-foreground");
    };
  }, [primaryColor]);

  useEffect(() => {
    if (!appName) return;
    document.title = appName;
    // Al salir se vuelve al título original, no al que hubiera antes: cerrar
    // sesión no debe dejar el nombre del tenant anterior en la pestaña.
    return () => {
      document.title = TITULO_ORIGINAL;
    };
  }, [appName]);

  useEffect(() => {
    // El favicon sale de datos: se revalida el esquema aquí también, porque el
    // valor pudo escribirse por fuera del dashboard.
    if (!faviconUrl || !esUrlDeImagen(faviconUrl)) return;
    const existente = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const link = existente ?? document.createElement("link");
    link.rel = "icon";
    link.href = faviconUrl;
    if (!existente) document.head.appendChild(link);
    return () => {
      if (!existente) link.remove();
      else if (FAVICON_ORIGINAL) link.setAttribute("href", FAVICON_ORIGINAL);
      else link.removeAttribute("href");
    };
  }, [faviconUrl]);
}
