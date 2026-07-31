import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, HardHat, ExternalLink } from "lucide-react";
import { getHostingChannels, pendingDraft } from "@/lib/hostingChannels";
import { triggerPlayTracksSync } from "@/lib/playTracks";
import { getAvancesSettings, setAvancesDraftUrl } from "@/lib/avancesSettings";
import { formatDistanceToNow } from "@/lib/timeUtils";

const SITE = "sozu-avances";
const AVANCES_URL = "https://avances.sozu.com";
// Con más de esto, el dato no sirve para decidir: se pide una revisión al abrir.
const FRESCO_MS = 2 * 60_000;
const ESPERA_MAX_MS = 3 * 60_000;

/**
 * Badge del borrador del sitio de avances (solo root).
 *
 * Quién decide es el workflow: consulta /api/estado del sitio y compara el
 * contenido del canal contra producción. Aquí, además de leer ese veredicto,
 * se pide una revisión cuando el dato está viejo — el cron solo corre cada 15
 * min y crear un borrador y publicarlo suele pasar dentro de esa ventana.
 */
export function AvancesDraftBadge({ email }: { email: string }) {
  const qc = useQueryClient();
  const [revisando, setRevisando] = useState(false);
  const pedidoEn = useRef<string | null>(null);

  const { data } = useQuery({
    queryKey: ["hosting-channels", SITE],
    queryFn: () => getHostingChannels(SITE),
    // Mientras se espera una revisión se sondea seguido; si no, tranquilo.
    refetchInterval: revisando ? 6_000 : 60_000,
  });
  const { data: settings } = useQuery({
    queryKey: ["avances-settings"],
    queryFn: getAvancesSettings,
    refetchInterval: 5 * 60_000,
  });

  const draft = pendingDraft(data);
  const edadMs = data?.updatedAt ? Date.now() - new Date(data.updatedAt).getTime() : Infinity;

  const revisar = async () => {
    if (revisando) return;
    pedidoEn.current = data?.updatedAt ?? "";
    setRevisando(true);
    try {
      await triggerPlayTracksSync();
    } catch {
      setRevisando(false);
    }
  };

  // Al abrir el dashboard con el dato viejo, revisar una vez.
  useEffect(() => {
    if (data === undefined) return; // aún cargando
    if (edadMs <= FRESCO_MS) return;
    if (sessionStorage.getItem("avances-revisado")) return;
    sessionStorage.setItem("avances-revisado", "1");
    void revisar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Termina la espera cuando el workflow escribe un dato nuevo (o se agota).
  useEffect(() => {
    if (!revisando) return;
    if (data?.updatedAt && data.updatedAt !== pedidoEn.current) {
      setRevisando(false);
      return;
    }
    const t = window.setTimeout(() => setRevisando(false), ESPERA_MAX_MS);
    return () => window.clearTimeout(t);
  }, [revisando, data?.updatedAt]);

  const editarUrl = async () => {
    const url = window.prompt(
      "URL del canal draft de avances\n\nVacío = quitarla:",
      settings?.draftUrl ?? "",
    );
    if (url === null) return;
    const limpia = url.trim();
    if (limpia && !/^https:\/\//.test(limpia)) {
      window.alert("La URL debe empezar con https://");
      return;
    }
    await setAvancesDraftUrl(limpia || null, email);
    await qc.invalidateQueries({ queryKey: ["avances-settings"] });
    void revisar();
  };

  const cuando = data?.updatedAt ? `revisado ${formatDistanceToNow(data.updatedAt)}` : "sin revisar aún";
  // Qué vio la última revisión: sin esto un "no hay borrador" es indistinguible
  // de una comprobación que falló.
  const detalle = [
    data?.error ? `Error: ${data.error}` : null,
    data?.comparedPaths?.length
      ? `Comparadas ${data.comparedPaths.length} páginas contra producción` +
        (data.diffPaths?.length ? `: distintas ${data.diffPaths.join(", ")}` : ": todas iguales")
      : null,
    data?.estado
      ? `/api/estado: pendiente_aprobacion=${String(data.estado.pendiente_aprobacion)}` +
        (data.estado.titulo ? ` (${data.estado.titulo})` : "")
      : null,
  ].filter(Boolean).join("\n");

  const link = (
    <a
      href={AVANCES_URL}
      target="_blank"
      rel="noreferrer"
      onContextMenu={(e) => { e.preventDefault(); void editarUrl(); }}
      className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-foreground"
      title={
        `Avance de obra (versión publicada) — avances.sozu.com\n${cuando}` +
        (detalle ? `\n${detalle}` : "") +
        "\nClic derecho: cambiar la URL del canal draft."
      }
    >
      <HardHat className="h-4 w-4" />
      Avances
      <ExternalLink className="h-3 w-3 opacity-60" />
    </a>
  );

  if (draft) {
    return (
      <span className="flex items-center">
      {link}
      <a
        href={draft.url}
        target="_blank"
        rel="noreferrer"
        onContextMenu={(e) => { e.preventDefault(); void editarUrl(); }}
        className="-ml-1.5 rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-amber-700 no-underline transition-colors hover:bg-amber-200 dark:border-amber-700/60 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60"
        title={
          (draft.title ? `Borrador pendiente: ${draft.title}` : "Borrador pendiente de aprobar") +
          `\n${cuando}\nClic derecho para cambiar la URL del canal.`
        }
      >
        DRAFT
      </a>
      </span>
    );
  }

  // Sin borrador pendiente no se pinta nada: el nav no debe cargar con un
  // control permanente. La revisión ya ocurre sola al abrir y cada 15 min; el
  // ajuste manual de la URL vive en el clic derecho sobre "Avances".
  return (
    <span className="flex items-center">
      {link}
      {revisando && (
        <Loader2
          className="-ml-1.5 h-2.5 w-2.5 animate-spin text-muted-foreground/40"
          aria-label="Revisando si hay borrador pendiente"
        />
      )}
    </span>
  );
}
