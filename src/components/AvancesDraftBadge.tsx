import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { getHostingChannels, pendingDraft } from "@/lib/hostingChannels";
import { triggerPlayTracksSync } from "@/lib/playTracks";
import { getAvancesSettings, setAvancesDraftUrl } from "@/lib/avancesSettings";
import { formatDistanceToNow } from "@/lib/timeUtils";

const SITE = "sozu-avances";
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
  const [reciente, setReciente] = useState(false); // acaba de terminar una revisión
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
      setReciente(true);
      return;
    }
    const t = window.setTimeout(() => { setRevisando(false); setReciente(true); }, ESPERA_MAX_MS);
    return () => window.clearTimeout(t);
  }, [revisando, data?.updatedAt]);

  // Anunciar el resultado un momento: sin esto la revisión termina en silencio
  // y no se distingue de haberse quedado colgada.
  useEffect(() => {
    if (!reciente) return;
    const t = window.setTimeout(() => setReciente(false), 8_000);
    return () => window.clearTimeout(t);
  }, [reciente]);

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

  if (draft) {
    return (
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
    );
  }

  return (
    <button
      type="button"
      onClick={() => void revisar()}
      onContextMenu={(e) => { e.preventDefault(); void editarUrl(); }}
      disabled={revisando}
      className="-ml-1.5 flex items-center gap-1 rounded border border-transparent px-1 py-0.5 text-[10px] text-muted-foreground/50 transition-colors hover:border-border hover:text-foreground disabled:opacity-70"
      title={
        (revisando ? "Revisando si hay borrador pendiente…" : "Sin borrador pendiente.") +
        `\n${cuando}` +
        (detalle ? `\n${detalle}` : "") +
        (settings?.draftUrl ? `\nCanal: ${settings.draftUrl}` : "") +
        "\n\nClic para revisar ahora · clic derecho para cambiar la URL del canal."
      }
    >
      {revisando && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {revisando ? "revisando…" : reciente ? "sin borrador" : "draft?"}
    </button>
  );
}
