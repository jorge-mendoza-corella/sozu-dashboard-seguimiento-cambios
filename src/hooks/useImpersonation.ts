import { createContext, useContext } from "react";
import { SUPERUSER_EMAIL, type AppUser } from "@/lib/firestoreUsers";

// ---------------------------------------------------------------------------
// "Ver como" un usuario. Solo el superusuario raíz.
//
// Es por usuario y no por empresa a propósito: lo que alguien ve no sale solo de
// su empresa, también de su rol, de `projectIds` y de sus permisos de CI/CD.
// Mirar la empresa entera no reproduce el "yo no veo nada" de una persona, que
// es justo para lo que sirve esto.
//
// La implementación es deliberadamente barata: en vez de duplicar el recorte de
// cada pantalla, se sustituye el perfil en memoria. Todo lo que ya sabe acotarse
// —`useClientScope`, la marca, las pestañas, la lista de usuarios— se acota
// solo, porque no distingue de dónde salió el perfil.
//
// Dos cosas que NO cambia, a propósito:
//   · el correo, así que cualquier escritura se sigue atribuyendo al root; y
//   · las reglas de Firestore, que ven al root de verdad. Es una simulación de
//     LO QUE SE VE, no de lo que se puede hacer. Un permiso que esa persona no
//     tendría aquí no da error, y por eso el banner está siempre a la vista: sin
//     él sería fácil creer que algo funciona para el cliente cuando en realidad
//     funcionó porque lo hizo el root.
//
// Vive en `sessionStorage`: sobrevive a un F5 —perderlo en cada recarga hace la
// función inútil— pero no se queda pegado para la próxima sesión.
// ---------------------------------------------------------------------------

export const CLAVE_IMPERSONACION = "impersonando";

interface Impersonacion {
  /** Correo del usuario que se está viendo, o null. */
  email: string | null;
  /** Ver como ese usuario (solo root). */
  ver: (email: string) => void;
  /** Volver a ser uno mismo. */
  salir: () => void;
}

const Ctx = createContext<Impersonacion>({ email: null, ver: () => {}, salir: () => {} });

export const ImpersonacionCtx = Ctx;

export const useImpersonation = () => useContext(Ctx);

/**
 * Perfil con el que trabajan las pantallas: el real, o el del usuario que se
 * está viendo.
 *
 * Solo el root puede impersonar. Si el perfil no es el suyo se devuelve tal
 * cual: así, aunque alguien escriba la clave a mano en `sessionStorage`, no
 * consigue ver nada distinto de lo suyo.
 *
 * `suplantado` es el doc del usuario a imitar, que el llamador ya cargó. Sin él
 * —mientras carga— se sigue viendo como uno mismo: un parpadeo es mejor que un
 * recorte a medias. De ese doc
 * se toma TODO lo que define lo que ve —rol, empresas, proyectos, permisos— y
 * nada de lo que define quién es: el correo y el token de GitHub siguen siendo
 * los del root, porque las escrituras se hacen de verdad.
 */
export function applyImpersonation(
  user: AppUser | null,
  suplantado: AppUser | null | undefined,
): AppUser | null {
  if (!user || !suplantado) return user;
  if (user.email !== SUPERUSER_EMAIL) return user;
  return {
    ...user,
    role: suplantado.role,
    clientIds: suplantado.clientIds ?? [],
    projectIds: suplantado.projectIds ?? [],
    permissions: suplantado.permissions,
  };
}
