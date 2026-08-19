import { createContext, useContext } from "react";
import { SUPERUSER_EMAIL, type AppUser } from "@/lib/firestoreUsers";

// ---------------------------------------------------------------------------
// "Ver como" una empresa. Solo el superusuario raíz.
//
// La implementación es deliberadamente barata: en vez de duplicar el recorte de
// cada pantalla, al usuario en memoria se le cambia el rol a `client_admin` con
// esa única empresa. Todo lo que ya sabe acotarse —`useClientScope`, la marca,
// las pestañas de Configuración, la lista de usuarios— se acota solo, porque no
// distingue de dónde salió el perfil.
//
// Dos cosas que NO cambia, a propósito:
//   · el correo, así que cualquier escritura se sigue atribuyendo al root; y
//   · las reglas de Firestore, que ven al root de verdad. Es una simulación de
//     LO QUE SE VE, no de lo que se puede hacer. Un permiso que la empresa no
//     tendría aquí no da error, y por eso el banner está siempre a la vista: sin
//     él sería fácil creer que algo funciona para el cliente cuando en realidad
//     funcionó porque lo hizo el root.
//
// Vive en `sessionStorage`: sobrevive a un F5 —perderlo en cada recarga hace la
// función inútil— pero no se queda pegado para la próxima sesión.
// ---------------------------------------------------------------------------

export const CLAVE_IMPERSONACION = "impersonando-cliente";

interface Impersonacion {
  /** Empresa que se está viendo, o null. */
  clientId: string | null;
  /** Empieza a ver como esa empresa (solo root). */
  ver: (clientId: string) => void;
  /** Vuelve a ser uno mismo. */
  salir: () => void;
}

const Ctx = createContext<Impersonacion>({ clientId: null, ver: () => {}, salir: () => {} });

export const ImpersonacionCtx = Ctx;

export const useImpersonation = () => useContext(Ctx);

/**
 * Perfil con el que trabajan las pantallas: el real, o el del administrador de
 * la empresa que se está viendo.
 *
 * Solo el root puede impersonar. Si el perfil no es el suyo, se devuelve tal
 * cual: así, aunque alguien escriba la clave a mano en `sessionStorage`, no
 * consigue ver nada distinto de lo suyo.
 */
export function applyImpersonation(user: AppUser | null, clientId: string | null): AppUser | null {
  if (!user || !clientId) return user;
  if (user.email !== SUPERUSER_EMAIL) return user;
  return { ...user, role: "client_admin", clientIds: [clientId] };
}
