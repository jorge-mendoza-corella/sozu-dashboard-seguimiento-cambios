import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// La fila de canales de una tienda, con el color contando el camino.
//
// Las tres tarjetas eran grises y todas se leían igual: había que comparar los
// números a ojo para saber si lo que se probó ya está en la calle o si sigue
// atorado en revisión. Ahora el color lo dice de un vistazo — pruebas en ámbar,
// revisión en azul, producción en verde— y, cuando lo que se probó es lo mismo
// que está publicado y no queda nada en camino, la fila ENTERA se pinta de
// verde: no hay nada pendiente en esa tienda.
//
// La usan Google Play y App Store, que tienen canales distintos pero el mismo
// camino: se prueba, la tienda revisa, sale. Un solo componente evita que cada
// una invente su propio código de color.
// ---------------------------------------------------------------------------

export type EtapaCanal = "pruebas" | "revision" | "produccion";
export type TonoEstado = "success" | "running" | "draft" | "halted";

export interface CanalTienda {
  key: string;
  label: string;
  etapa: EtapaCanal;
  version: string | null;
  /** Número de build/versionCode, cuando la tienda lo da. */
  build?: string | null;
  estado: { label: string; tone: TonoEstado };
  /** Dato suelto de la derecha: fecha de subida, hace cuánto… */
  detalle?: string | null;
  /** Qué decir cuando el canal está vacío. */
  vacio?: string;
  link?: string | null;
  linkTitle?: string;
}

const ETAPA_CLASSES: Record<EtapaCanal, string> = {
  pruebas: "border-amber-200 bg-amber-50/70 dark:border-amber-900/50 dark:bg-amber-950/25",
  revision: "border-blue-200 bg-blue-50/70 dark:border-blue-900/50 dark:bg-blue-950/25",
  produccion: "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900/50 dark:bg-emerald-950/25",
};

const PUBLICADO = "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900/50 dark:bg-emerald-950/25";
const VACIO = "border-border bg-muted/30";

const BADGE_CLASSES: Record<TonoEstado, string> = {
  success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  running: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  draft: "bg-muted text-muted-foreground",
  halted: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
};

/**
 * Nada pendiente en esta tienda: lo que está publicado es lo mismo que se
 * probó, y no hay ningún envío esperando revisión.
 */
function todoPublicado(canales: CanalTienda[]): boolean {
  const pruebas = canales.find((c) => c.etapa === "pruebas");
  const revision = canales.find((c) => c.etapa === "revision");
  const produccion = canales.find((c) => c.etapa === "produccion");
  return (
    !!produccion?.version &&
    !revision?.version &&
    !!pruebas?.version &&
    pruebas.version === produccion.version
  );
}

export function CanalesTienda({ canales }: { canales: CanalTienda[] }) {
  const alDia = todoPublicado(canales);

  return (
    <div className="grid gap-1.5 sm:grid-cols-3">
      {canales.map((c) => (
        <div
          key={c.key}
          className={cn(
            "rounded-lg border p-2 transition-colors",
            !c.version ? VACIO : alDia ? PUBLICADO : ETAPA_CLASSES[c.etapa],
          )}
          title={
            alDia
              ? "Esta tienda no tiene nada pendiente: lo probado es lo que está publicado."
              : undefined
          }
        >
          <div className="mb-1 flex items-center gap-1.5">
            <span className="text-[11px] font-semibold">{c.label}</span>
            {c.link && (
              <a
                href={c.link}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-0.5 text-[10px] text-primary underline"
                title={c.linkTitle ?? "Link de invitación de este canal"}
              >
                invitación <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
          </div>
          {c.version || c.build ? (
            <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
              <span className={cn("rounded px-1.5 py-0.5 font-semibold", BADGE_CLASSES[c.estado.tone])}>
                {c.estado.label}
              </span>
              {c.version && <span className="font-mono">{c.version}</span>}
              {c.build && <span className="text-muted-foreground">build {c.build}</span>}
              {c.detalle && <span className="text-muted-foreground">{c.detalle}</span>}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground">{c.vacio ?? "—"}</p>
          )}
        </div>
      ))}
    </div>
  );
}
