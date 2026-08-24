import { Link } from "react-router-dom";
import { MessageCircle, MessageCircleOff, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AvisosDelProyecto } from "@/hooks/useAvisos";

// ---------------------------------------------------------------------------
// Si este proyecto avisa por WhatsApp y a quién, en un chip.
//
// Era una franja de ancho completo con los nombres desplegados. Decía lo
// correcto pero se comía una fila entera arriba de las tarjetas, todo el tiempo,
// para una información que se consulta de vez en cuando: cuando algo no llegó, o
// al configurar un proyecto nuevo. Ahora es un chip, y el detalle —cada
// destinatario y por qué está— vive en su tooltip.
//
// Se queda visible aunque esté todo bien: saber que SÍ avisa es la mitad del
// valor, y un indicador que solo aparece cuando algo falla enseña a no mirarlo.
//
// Los autores del PR no se enumeran: salen de los commits de cada PR, no del
// proyecto. Lo que se lista aquí es lo fijo —el aprobador y los suscritos a
// todos los repos—, que es lo que no se ve en ninguna otra parte.
// ---------------------------------------------------------------------------

export function AvisosBanner({ avisos }: { avisos: AvisosDelProyecto | undefined }) {
  // Sin permiso para leer la configuración no se pinta nada: un "no avisa" que
  // en realidad significa "no puedo saberlo" manda a arreglar algo que no está
  // roto.
  if (!avisos || avisos.desconocido) return null;

  const sinTelefono = avisos.destinatarios.filter((d) => !d.tieneTelefono);
  const conTelefono = avisos.destinatarios.filter((d) => d.tieneTelefono);

  if (!avisos.empresaAvisa) {
    return (
      <Link
        to="/configuracion"
        title={`${avisos.motivoEmpresa} Click para configurarlo.`}
        className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 no-underline hover:bg-amber-100 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300"
      >
        <MessageCircleOff className="h-3 w-3" />
        Sin avisos de WhatsApp
      </Link>
    );
  }

  const detalle = [
    "Al abrir o cerrar un PR, y al terminar un deploy, se avisa por WhatsApp:",
    "· a los autores del PR (salen de los commits de cada uno)",
    ...conTelefono.map((d) => `· @${d.login} — ${d.motivo === "aprobador" ? "aprobador del proyecto" : "suscrito a todos los repos"}`),
    ...sinTelefono.map((d) => `· @${d.login} — ${d.motivo === "aprobador" ? "aprobador del proyecto" : "suscrito a todos los repos"}: SIN TELÉFONO en Contribuidores, no le llega nada`),
    ...(avisos.destinatarios.length === 0
      ? ["· y a nadie más: este proyecto no tiene aprobador asignado"]
      : []),
  ].join("\n");

  return (
    <span
      title={detalle}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        sinTelefono.length > 0
          ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300"
          : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300",
      )}
    >
      {sinTelefono.length > 0
        ? <AlertTriangle className="h-3 w-3" />
        : <MessageCircle className="h-3 w-3" />}
      Avisa por WhatsApp
      {conTelefono.length > 0 && (
        <span className="font-mono font-normal opacity-80">
          · @{conTelefono[0].login}{conTelefono.length > 1 ? ` +${conTelefono.length - 1}` : ""}
        </span>
      )}
      {sinTelefono.length > 0 && (
        <span className="font-normal">· {sinTelefono.length} sin teléfono</span>
      )}
    </span>
  );
}
