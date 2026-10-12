import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { adminClientIds, canAdminister, editableClientIds, type AppUser } from "@/lib/firestoreUsers";
import {
  dispararRevisionWhatsapp, estaViejo, getWhatsappStatuses, pideRevision, qrWhatsapp, type WhatsappStatus,
} from "@/lib/whatsappStatus";

// ---------------------------------------------------------------------------
// Conexión de WhatsApp (Evolution API), en la barra de arriba.
//
// Verde parpadeando = todas las instancias conectadas. Rojo = alguna se cayó, y
// lo dice con texto: cuando la sesión se cierra los avisos dejan de llegar sin
// error visible en ningún otro lado. Solo lo ven los administradores; el admin
// de empresa, solo sus empresas.
//
// En rojo, al pasar el mouse (o tocarlo en móvil) se abre un panel con el detalle
// y el QR para volver a vincular cada instancia caída, si quien mira puede
// configurar esa empresa (función `whatsappQr`). Conectada, no hay QR.
// ---------------------------------------------------------------------------

type Tono = "verde" | "ambar" | "rojo" | "gris";

const hora = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
    : "—";

function tonoDe(s: WhatsappStatus): Tono {
  // "conectando" también es rojo (como en sozu-admin): es como se queda la
  // instancia tras pedir el QR sin escanearlo, y mientras tanto no sale nada.
  if (s.estado === "desconectado" || s.estado === "error" || s.estado === "conectando") return "rojo";
  if (s.estado === "sinConfigurar") return "gris";
  if (estaViejo(s)) return "ambar";
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

/** Cada cuánto se pide otro QR mientras el panel está abierto: Evolution los renueva ~cada 30 s. */
const QR_MS = 20_000;

function QrReconexion({ s, onConectado }: { s: WhatsappStatus; onConectado: () => void }) {
  const q = useQuery({
    queryKey: ["whatsapp-qr", s.clientId],
    queryFn: () => qrWhatsapp(s.clientId),
    refetchInterval: (query) => (query.state.data?.conectado ? false : QR_MS),
    refetchIntervalInBackground: false,
    gcTime: 0,
    retry: 1,
  });
  const conectado = !!q.data?.conectado;
  useEffect(() => {
    if (conectado) onConectado();
    // Solo al pasar a conectado; `onConectado` cambia en cada render del badge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conectado]);

  if (q.isLoading) {
    return (
      <div className="flex h-48 w-48 items-center justify-center rounded-md bg-muted/40 text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generando QR…
      </div>
    );
  }
  if (q.error) return <p className="text-xs text-red-600 dark:text-red-400">{(q.error as Error).message}</p>;
  if (conectado) return <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">✓ Conectado. Los avisos vuelven a salir.</p>;
  if (!q.data?.qr) return <p className="text-xs text-muted-foreground">{q.data?.detalle ?? "Sin QR todavía."}</p>;
  return (
    <div className="space-y-1.5">
      <img src={q.data.qr} alt={`QR para vincular WhatsApp · ${s.instancia}`} className="h-48 w-48 rounded-md bg-white p-1.5" />
      {q.data.pairingCode && (
        <p className="text-[11px] text-muted-foreground">
          O con código: <span className="font-mono font-semibold text-foreground">{q.data.pairingCode}</span>
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        WhatsApp del teléfono de avisos → Dispositivos vinculados → Vincular dispositivo. El QR se renueva solo.
      </p>
    </div>
  );
}

export function WhatsappStatusBadge({ appUser }: { appUser: AppUser | null }) {
  const qc = useQueryClient();
  const [abierto, setAbierto] = useState(false);
  const cierre = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abrir = () => {
    clearTimeout(cierre.current);
    setAbierto(true);
  };
  // Un respiro al salir para poder llevar el mouse del badge al panel.
  const cerrarPronto = () => {
    clearTimeout(cierre.current);
    cierre.current = setTimeout(() => setAbierto(false), 250);
  };
  useEffect(() => () => clearTimeout(cierre.current), []);

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

  // El cron de GitHub casi nunca corre en este repo: la pestaña abierta pide la
  // revisión cuando el dato envejece, y el refetch de cada minuto la recoge.
  const hayQueRevisar = !!data && pideRevision(data);
  useEffect(() => {
    if (esAdmin && hayQueRevisar) void dispararRevisionWhatsapp();
  }, [esAdmin, hayQueRevisar]);

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
        ? "WhatsApp sin revisar"
        : peor === "gris"
          ? "WhatsApp: monitor sin configurar"
          : "WhatsApp";

  // Solo las caídas de empresas que quien mira puede configurar (superuser: todas).
  const configurables = appUser?.role === "superuser" ? null : editableClientIds(appUser);
  const reconectables = caidas.filter(
    (s) => s.estado !== "error" && (configurables === null || configurables.includes(s.clientId)),
  );
  const alConectar = () => {
    void qc.invalidateQueries({ queryKey: ["whatsapp-status"] });
  };

  const titulo = [
    "Conexión de WhatsApp (Evolution API)",
    ...visibles.map(lineaDe),
    peor === "rojo" && "Mientras siga desconectado, los avisos por WhatsApp NO llegan.",
    "Se revisa cada ~5 minutos mientras el dashboard esté abierto.",
  ]
    .filter(Boolean)
    .join("\n");

  const badge = (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium",
        peor === "rojo"
          ? "animate-pulse border border-red-500 bg-red-100 font-semibold text-red-700 motion-reduce:animate-none dark:border-red-600 dark:bg-red-950/60 dark:text-red-300"
          : peor === "ambar"
            ? "text-amber-700 dark:text-amber-300"
            : "text-muted-foreground",
      )}
      title={peor === "rojo" ? undefined : titulo}
      role="status"
      onMouseEnter={peor === "rojo" ? abrir : undefined}
      onMouseLeave={peor === "rojo" ? cerrarPronto : undefined}
      onClick={peor === "rojo" ? () => setAbierto((a) => !a) : undefined}
    >
      <span className={cn("relative flex shrink-0", peor === "rojo" ? "h-3.5 w-3.5" : "h-2.5 w-2.5")}>
        {(peor === "verde" || peor === "rojo") && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping motion-reduce:animate-none",
              COLOR_PUNTO[peor],
            )}
          />
        )}
        <span
          className={cn(
            "relative inline-flex h-full w-full rounded-full",
            COLOR_PUNTO[peor],
            peor === "rojo" && "ring-2 ring-red-300 dark:ring-red-800",
          )}
        />
      </span>
      {/* En verde basta el punto en pantallas chicas; el rojo siempre se lee. */}
      <span className={cn(peor === "verde" && "hidden lg:inline")}>{texto}</span>
    </span>
  );

  if (peor !== "rojo") return badge;

  return (
    <div className="relative">
      {badge}
      {abierto && (
        <div
          className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] space-y-3 rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg"
          onMouseEnter={abrir}
          onMouseLeave={cerrarPronto}
        >
          <p className="font-semibold">Conexión de WhatsApp (Evolution API)</p>
          <ul className="space-y-1 whitespace-pre-line text-muted-foreground">
            {visibles.map((s) => <li key={s.clientId}>{lineaDe(s)}</li>)}
          </ul>
          <p className="font-medium text-red-600 dark:text-red-400">Mientras siga desconectado, los avisos por WhatsApp NO llegan.</p>
          {reconectables.map((s) => (
            <div key={s.clientId} className="space-y-1.5 border-t pt-3">
              <p className="font-medium">Reconectar · {s.empresa || s.clientId} · "{s.instancia}"</p>
              <QrReconexion s={s} onConectado={alConectar} />
            </div>
          ))}
          {reconectables.length === 0 && (
            <p className="text-muted-foreground">Pide a un administrador de la empresa que la reconecte.</p>
          )}
        </div>
      )}
    </div>
  );
}
