import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAllContributorPhones } from "@/lib/firestoreContributors";
import { getVisibleUsers, scopeKeyOf, type AppUser } from "@/lib/firestoreUsers";
import { useProjects } from "./useProjectsRepos";
import { useWhatsappByClient } from "./useNotifications";

// ---------------------------------------------------------------------------
// A quién le llega el aviso de WhatsApp de cada proyecto.
//
// La configuración de notificaciones vivía solo en Configuración, así que desde
// CI/CD —donde de verdad pasan las cosas— no había forma de saber si un merge
// iba a avisarle a alguien, ni a quién. Se descubría cuando el mensaje no
// llegaba.
//
// Esto arma la misma lista que arman los workflows, con las mismas fuentes:
//
//   projects/{id}.approverEmail            → users/{email}.githubLogin
//   users/{email}.avisaDeTodosLosRepos     → los suscritos a toda la cartera
//   contributors/{login}.telefonoWhatsapp  → el teléfono de cada uno
//   clients/{id}/private/notifications     → si esa empresa manda algo
//
// Los AUTORES del PR no salen aquí a propósito: dependen de los commits de cada
// PR, no del proyecto, y la tarjeta ya los muestra al crearlo. Aquí va lo fijo,
// que es justo lo que no se ve en ninguna parte.
// ---------------------------------------------------------------------------

export interface Destinatario {
  login: string;
  /** Por qué recibe el aviso, para explicarlo sin que haya que deducirlo. */
  motivo: "aprobador" | "suscrito";
  /** Sin teléfono en Contribuidores no se le puede avisar aunque esté puesto. */
  tieneTelefono: boolean;
}

export interface AvisosDelProyecto {
  /** `false` = la empresa tiene los avisos apagados o le falta configuración. */
  empresaAvisa: boolean;
  /** Qué le falta a la empresa, si es que le falta algo. */
  motivoEmpresa: string;
  destinatarios: Destinatario[];
  /** La configuración no es legible para este usuario: no se pinta nada. */
  desconocido: boolean;
}

/**
 * Destinatarios por proyecto.
 *
 * Solo resuelve para quien PUEDE leer la configuración —superuser o admin de esa
 * empresa—; para el resto devuelve `desconocido` y la interfaz se calla. Pintar
 * "no avisa" cuando en realidad es "no tengo permiso de saberlo" mandaría a
 * alguien a arreglar algo que no está roto.
 */
export function useAvisosPorProyecto(appUser: AppUser | null): Map<string, AvisosDelProyecto> {
  const puedeLeer = appUser?.role === "superuser" || appUser?.role === "client_admin";
  const { data: projects = [] } = useProjects();
  const { rows } = useWhatsappByClient(puedeLeer ? appUser : null);

  const { data: usuarios = [] } = useQuery({
    queryKey: ["users-all", scopeKeyOf(appUser)],
    queryFn: () => getVisibleUsers(appUser),
    enabled: !!appUser && puedeLeer,
  });
  const { data: telefonos = {} } = useQuery({
    queryKey: ["contributor-phones"],
    queryFn: getAllContributorPhones,
    enabled: !!appUser && puedeLeer,
    staleTime: 5 * 60 * 1000,
  });

  return useMemo(() => {
    const mapa = new Map<string, AvisosDelProyecto>();
    if (!puedeLeer) return mapa;

    const wa = new Map(rows.map((r) => [r.clientId, r.efectiva]));
    const suscritos = usuarios.filter((u) => u.role === "superuser" && u.avisaDeTodosLosRepos);

    for (const p of projects) {
      const cfg = p.clientId ? wa.get(p.clientId) : undefined;
      // Sin empresa no hay por dónde mandar: no hay instancia global de la que
      // tirar, y eso es deliberado.
      const motivoEmpresa = !p.clientId
        ? "El proyecto no tiene empresa asignada, y los avisos salen por la instancia de la empresa."
        : !cfg
          ? "No se pudo leer la configuración de esta empresa."
          : cfg.incompleta
            ? "A la empresa le falta configuración de WhatsApp (instancia, webhook o apikey)."
            : !cfg.enabled
              ? "La empresa tiene los avisos de WhatsApp apagados."
              : "";

      const destinatarios: Destinatario[] = [];
      const aprobador = p.approverEmail
        ? usuarios.find((u) => u.email === p.approverEmail)
        : undefined;
      if (aprobador?.githubLogin) {
        destinatarios.push({
          login: aprobador.githubLogin,
          motivo: "aprobador",
          tieneTelefono: !!telefonos[aprobador.githubLogin],
        });
      }
      for (const s of suscritos) {
        if (!s.githubLogin) continue;
        if (destinatarios.some((d) => d.login === s.githubLogin)) continue;
        destinatarios.push({
          login: s.githubLogin,
          motivo: "suscrito",
          tieneTelefono: !!telefonos[s.githubLogin],
        });
      }

      mapa.set(p.id, {
        empresaAvisa: motivoEmpresa === "",
        motivoEmpresa,
        destinatarios,
        desconocido: false,
      });
    }
    return mapa;
  }, [puedeLeer, projects, rows, usuarios, telefonos]);
}

/** Texto de una línea con quién recibe el aviso; para tooltips y resúmenes. */
export function resumenDestinatarios(a: AvisosDelProyecto | undefined): string {
  if (!a || a.desconocido) return "";
  if (!a.empresaAvisa) return a.motivoEmpresa;
  if (a.destinatarios.length === 0) {
    return "Nadie fijo: solo se avisará a los autores del PR. Asigna un aprobador al proyecto para que alguien más se entere.";
  }
  const parte = (d: Destinatario) =>
    `@${d.login} (${d.motivo === "aprobador" ? "aprobador" : "suscrito a todos los repos"})`
    + (d.tieneTelefono ? "" : " — SIN TELÉFONO en Contribuidores");
  return `Avisa a los autores del PR y a ${a.destinatarios.map(parte).join(", ")}.`;
}
