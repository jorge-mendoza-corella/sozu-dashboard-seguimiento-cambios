import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { adminClientIds, canAdminister, type AppUser } from "@/lib/firestoreUsers";
import { estaViejo, getWhatsappStatuses, type WhatsappStatus } from "@/lib/whatsappStatus";

// ---------------------------------------------------------------------------
// Conexión de WhatsApp (Evolution API), en la barra de arriba.
//
// Verde parpadeando = todas las instancias conectadas. Rojo = alguna se cayó, y
// lo dice con texto: cuando la sesión se cierra los avisos dejan de llegar sin
// error visible en ningún otro lado. Solo lo ven los administradores; el admin
// de empresa, solo sus empresas.
// ---------------------------------------------------------------------------

type Tono = "verde" | "ambar" | "rojo" | "gris";

const hora = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
    : "—";

function tonoDe(s: WhatsappStatus): Tono {
  if (s.estado === "desconectado" || s.estado === "error") return "rojo";
  if (s.estado === "sinConfigurar") return "gris";
  if (estaViejo(s) || s.estado === "conectando") return "ambar";
  return "verde";
}

const ORDEN: Record<Tono, number> = { rojo: 3, ambar: 2, gris: 1, verde: 0 };

const COLOR_PUNTO: Record<Tono, string> = {
  verde: "bg-emerald-500",
  ambar: "bg-amber-500",
  rojo: "bg-red-600",
  gris: "bg-muted-foreground/50",
};

function lineaDe(s: WhatsappStatus): string {
  const quien = `${s.empresa || s.clientId} · "${s.instancia}"`;
  const viejo = estaViejo(s) ? ` (sin revisar desde ${hora(s.revisadoAt)})` : "";
  switch (s.estado) {
    case "conectado":
      return `✓ ${quien}: conectado desde ${hora(s.desde)}${viejo}`;
    case "desconectado":
    case "error":
      return `✗ ${quien}: ${s.estado === "error" ? "sin respuesta" : "DESCONECTADO"} desde ${hora(s.desde)}. ${s.detalle}`
        + (s.ultimaConexion ? ` Última vez conectado: ${hora(s.ultimaConexion)}.` : "");
    case "conectando":
      return `… ${quien}: reconectando desde ${hora(s.desde)}. ${s.detalle}`;
    default:
      return `· ${quien}: ${s.detalle}`;
  }
}

export function WhatsappStatusBadge({ appUser }: { appUser: AppUser | null }) {
  const esAdmin = canAdminister(appUser);

  const { data } = useQuery({
    queryKey: ["whatsapp-status"],
    queryFn: getWhatsappStatuses,
    enabled: esAdmin,
    // El monitor escribe cada ~5 min; mirar cada minuto basta para que el rojo
    // aparezca poco después de que se detecte.
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });

  if (!esAdmin || !data) return null;

  const suyas = adminClientIds(appUser);
  const visibles = data.filter(
    (s) => s.estado !== "apagado" && (suyas === null || suyas.includes(s.clientId)),
  );
  if (visibles.length === 0) return null;

  const peor = visibles.reduce<Tono>((acc, s) => {
    const t = tonoDe(s);
    return ORDEN[t] > ORDEN[acc] ? t : acc;
  }, "verde");

  const caidas = visibles.filter((s) => tonoDe(s) === "rojo");
  const texto =
    peor === "rojo"
      ? caidas.length === 1
        ? `WhatsApp desconectado · ${caidas[0].instancia}`
        : `WhatsApp: ${caidas.length} desconectadas`
      : peor === "ambar"
        ? visibles.some((s) => s.estado === "conectando") ? "WhatsApp reconectando" : "WhatsApp sin revisar"
        : peor === "gris"
          ? "WhatsApp: monitor sin configurar"
          : "WhatsApp";

  const titulo = [
    "Conexión de WhatsApp (Evolution API)",
    ...visibles.map(lineaDe),
    peor === "rojo" && "Mientras siga desconectado, los avisos por WhatsApp NO llegan.",
    "Se revisa cada ~5 minutos.",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium",
        peor === "rojo"
          ? "border border-red-400 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/50 dark:text-red-300"
          : peor === "ambar"
            ? "text-amber-700 dark:text-amber-300"
            : "text-muted-foreground",
      )}
      title={titulo}
      role="status"
    >
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        {(peor === "verde" || peor === "rojo") && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping motion-reduce:animate-none",
              COLOR_PUNTO[peor],
            )}
          />
        )}
        <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", COLOR_PUNTO[peor])} />
      </span>
      {/* En verde basta el punto en pantallas chicas; el rojo siempre se lee. */}
      <span className={cn(peor === "verde" && "hidden lg:inline")}>{texto}</span>
    </span>
  );
}
