import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { CheckCircle2, XCircle, Rocket, Bell, X } from "lucide-react";
import {
  getRecentBuilds, buildStatusInfo, buildUrl, WORKFLOW_LABELS, PLATFORMS,
  isCodemagicConfigured, type CodemagicBuild,
} from "@/lib/codemagic";
import { useProjects } from "@/hooks/useProjectsRepos";
import { cn } from "@/lib/utils";

// Builds ya avisados: sobrevive a recargas para no repetir el aviso de algo
// que terminó hace rato. Se limita para que no crezca sin fin.
const VISTOS_KEY = "build-notif-vistos";

function leerVistos(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(VISTOS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function guardarVistos(ids: Set<string>) {
  const arr = [...ids].slice(-200);
  localStorage.setItem(VISTOS_KEY, JSON.stringify(arr));
}

/** ¿Este workflow publica en una tienda, o solo genera el artefacto? */
function esPublicacion(workflowId: string): boolean {
  return PLATFORMS.some(
    (p) =>
      workflowId === p.publishWorkflowId ||
      workflowId === p.promoteWorkflowId ||
      workflowId === p.storeDirectWorkflowId,
  );
}

interface Aviso {
  id: string;
  ok: boolean;
  titulo: string;
  detalle: string;
  url: string;
}

/**
 * Avisa cuando termina un build o una publicación de app: notificación del
 * sistema (si se concede el permiso) y una tarjeta en pantalla. Vive en el
 * layout para enterarse aunque no estés viendo la pestaña Deploy App.
 */
export function BuildNotifier() {
  const { data: projects = [] } = useProjects();
  const appIds = projects.map((p) => p.codemagicAppId).filter((id): id is string => !!id);

  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const vistos = useRef<Set<string> | null>(null);
  const primeraCarga = useRef(true);

  const { data: builds = [], refetch } = useQuery({
    queryKey: ["codemagic-builds-todos", appIds],
    queryFn: async () => {
      const listas = await Promise.all(appIds.map((id) => getRecentBuilds(id, 10).catch(() => [])));
      return listas.flat();
    },
    enabled: isCodemagicConfigured && appIds.length > 0,
    refetchInterval: 20_000,
    // Sin esto el aviso solo llegaría con la pestaña en primer plano, que es
    // justo cuando no hace falta.
    refetchIntervalInBackground: true,
  });

  // Al volver a la pestaña, comprobar de inmediato en vez de esperar al
  // siguiente intervalo.
  useEffect(() => {
    const alVolver = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", alVolver);
    window.addEventListener("focus", alVolver);
    return () => {
      document.removeEventListener("visibilitychange", alVolver);
      window.removeEventListener("focus", alVolver);
    };
  }, [refetch]);

  useEffect(() => {
    if (builds.length === 0) return;
    if (vistos.current === null) vistos.current = leerVistos();

    const terminados = builds.filter((b: CodemagicBuild) => {
      const info = buildStatusInfo(b.status);
      return !info.isRunning && info.tone !== "neutral";
    });

    // En la primera carga solo se registra lo que ya terminó: al abrir el
    // dashboard no deben llover avisos de builds viejos.
    if (primeraCarga.current) {
      primeraCarga.current = false;
      terminados.forEach((b) => vistos.current!.add(b._id));
      guardarVistos(vistos.current);
      return;
    }

    const nuevos = terminados.filter((b) => !vistos.current!.has(b._id));
    if (nuevos.length === 0) return;

    nuevos.forEach((b) => vistos.current!.add(b._id));
    guardarVistos(vistos.current);

    const generados: Aviso[] = nuevos.map((b) => {
      const info = buildStatusInfo(b.status);
      const ok = info.tone === "success";
      const wf = b.workflowId ?? "";
      const nombre = WORKFLOW_LABELS[wf] ?? wf;
      const publica = esPublicacion(wf);
      return {
        id: b._id,
        ok,
        titulo: publica
          ? ok ? "Publicación completada" : "Publicación fallida"
          : ok ? "Build completado" : "Build fallido",
        detalle: `${nombre}${b.branch ? ` · ${b.branch}` : ""}`,
        url: buildUrl(b.appId, b._id),
      };
    });

    setAvisos((prev) => [...generados, ...prev].slice(0, 4));

    if ("Notification" in window && Notification.permission === "granted") {
      generados.forEach((a) => {
        new Notification(a.titulo, { body: a.detalle, icon: "/favicon.ico", tag: a.id });
      });
    }
  }, [builds]);

  const pedirPermiso = () => {
    if (!("Notification" in window)) return;
    void Notification.requestPermission();
  };

  const sinPermiso =
    "Notification" in window && Notification.permission === "default" && appIds.length > 0;

  if (avisos.length === 0 && !sinPermiso) return null;

  return createPortal(
    <div className="fixed bottom-4 right-4 z-[9998] flex w-80 flex-col gap-2">
      {avisos.map((a) => (
        <div
          key={a.id}
          className={cn(
            "flex items-start gap-2 rounded-lg border p-3 shadow-lg backdrop-blur",
            a.ok
              ? "border-emerald-300 bg-emerald-50/95 dark:border-emerald-800 dark:bg-emerald-950/90"
              : "border-red-300 bg-red-50/95 dark:border-red-800 dark:bg-red-950/90",
          )}
        >
          {a.ok ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold">{a.titulo}</p>
            <p className="truncate text-[11px] text-muted-foreground">{a.detalle}</p>
            <a
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-primary underline"
            >
              <Rocket className="h-2.5 w-2.5" /> ver el build
            </a>
          </div>
          <button
            type="button"
            onClick={() => setAvisos((prev) => prev.filter((x) => x.id !== a.id))}
            className="text-muted-foreground hover:text-foreground"
            title="Descartar"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      {sinPermiso && (
        <button
          type="button"
          onClick={pedirPermiso}
          className="flex items-center gap-2 rounded-lg border bg-background/95 p-2 text-[11px] text-muted-foreground shadow-lg backdrop-blur hover:text-foreground"
          title="Permite que el navegador te avise aunque el dashboard esté en otra pestaña"
        >
          <Bell className="h-3.5 w-3.5" />
          Activar avisos de builds y publicaciones
        </button>
      )}
    </div>,
    document.body,
  );
}
