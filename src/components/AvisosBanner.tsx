import { Link } from "react-router-dom";
import { MessageCircle, MessageCircleOff, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AvisosDelProyecto } from "@/hooks/useAvisos";

// ---------------------------------------------------------------------------
// Quién recibe los avisos de WhatsApp de este proyecto, dicho en CI/CD.
//
// Esto vivía solo en Configuración, escondido tras dos pestañas, así que desde
// donde de verdad se trabaja no había forma de saber si un merge iba a avisarle
// a alguien: se descubría cuando el mensaje no llegaba. Y el único rastro en
// esta pantalla era un icono de 12px en el chip de la empresa, que no alcanza
// para algo que decide si el equipo se entera o no.
//
// Los AUTORES del PR no se enumeran: dependen de los commits de cada PR y la
// tarjeta ya los muestra al crearlo. Aquí va lo fijo —el aprobador del proyecto
// y los suscritos a toda la cartera—, que es justo lo que no se veía.
// ---------------------------------------------------------------------------

export function AvisosBanner({ avisos }: { avisos: AvisosDelProyecto | undefined }) {
  // Sin permiso para leer la configuración no se pinta nada: un "no avisa" que
  // en realidad significa "no puedo saberlo" manda a arreglar algo que no está
  // roto.
  if (!avisos || avisos.desconocido) return null;

  const sinTelefono = avisos.destinatarios.filter((d) => !d.tieneTelefono);
  const conTelefono = avisos.destinatarios.filter((d) => d.tieneTelefono);

  return (
    <div
      className={cn(
        "mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-xs",
        avisos.empresaAvisa
          ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300"
          : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300",
      )}
    >
      {avisos.empresaAvisa ? (
        <MessageCircle className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <MessageCircleOff className="h-3.5 w-3.5 shrink-0" />
      )}

      {!avisos.empresaAvisa ? (
        <>
          <span className="font-semibold">Sin avisos de WhatsApp.</span>
          <span>{avisos.motivoEmpresa}</span>
          <Link to="/configuracion" className="underline underline-offset-2">
            Configurar
          </Link>
        </>
      ) : (
        <>
          <span className="font-semibold">Avisa por WhatsApp</span>
          <span className="opacity-80">a los autores del PR</span>
          {conTelefono.length > 0 && (
            <>
              <span className="opacity-60">·</span>
              {conTelefono.map((d) => (
                <span
                  key={d.login}
                  className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium dark:bg-emerald-900/40"
                  title={
                    d.motivo === "aprobador"
                      ? `@${d.login} aprueba los PRs de este proyecto, así que recibe todos sus avisos.`
                      : `@${d.login} está suscrito a los avisos de todos los repos.`
                  }
                >
                  @{d.login}
                  <span className="ml-1 font-normal opacity-70">
                    {d.motivo === "aprobador" ? "aprobador" : "todos los repos"}
                  </span>
                </span>
              ))}
            </>
          )}
          {avisos.destinatarios.length === 0 && (
            <span className="opacity-80">
              y a nadie más: este proyecto no tiene aprobador asignado.
            </span>
          )}
          {/* Estar en la lista sin teléfono es peor que no estar: se cree que
              esa persona se entera y nunca le llega nada. */}
          {sinTelefono.map((d) => (
            <span
              key={d.login}
              className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              title={`@${d.login} debería recibir estos avisos, pero no tiene teléfono en Contribuidores: no le va a llegar nada.`}
            >
              <AlertTriangle className="h-3 w-3" />
              @{d.login} sin teléfono
            </span>
          ))}
        </>
      )}
    </div>
  );
}
