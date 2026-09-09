import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// La fila de canales de una tienda, con el color contando hasta dónde llegó
// esta versión.
//
// Las tres tarjetas eran grises y todas se leían igual: había que comparar los
// números a ojo para saber si lo que se probó ya está en la calle o si sigue
// atorado en revisión. Ahora el color avanza con la versión, como una barra de
// progreso, y no como una etiqueta fija por tarjeta:
//
//   solo en pruebas   → pruebas en ámbar
//   ya en revisión    → pruebas Y revisión en azul (el avance llegó hasta ahí)
//   ya publicada      → las tres en verde, incluida la de revisión aunque esté
//                       vacía: vacía es justo la señal de que no queda nada
//
// Lo que NO se pinta de verde es la tarjeta de producción mientras el avance no
// llegue ahí, aunque tenga una versión a la venta: esa versión es la anterior,
// y darle el color de "llegamos" haría creer que lo que se está siguiendo ya
// salió. El badge sí queda verde —esa versión está publicada de verdad—, que es
// la diferencia entre el dato y el avance.
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

type Color = "ambar" | "azul" | "verde" | "vacio";

const COLOR_CLASSES: Record<Color, string> = {
  ambar: "border-amber-200 bg-amber-50/70 dark:border-amber-900/50 dark:bg-amber-950/25",
  azul: "border-blue-200 bg-blue-50/70 dark:border-blue-900/50 dark:bg-blue-950/25",
  verde: "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900/50 dark:bg-emerald-950/25",
  vacio: "border-border bg-muted/30",
};

// El badge lleva el color de SU canal, no el del texto que muestre. Los estados
// que manda cada tienda son un vocabulario distinto —"publicado", "listo ·
// testers internos", "esperando revisión", "disponible en Play"— y pintarlos
// por tono hacía que dos tarjetas de la misma etapa salieran de colores
// distintos según la palabra que usara Apple o Google ese día.
const BADGE_ETAPA: Record<EtapaCanal, string> = {
  pruebas: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  revision: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  produccion: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
};

// La excepción: un rechazo o un binario inválido no son una etapa del camino,
// son algo roto. Pintarlos del color de su canal los escondería justo entre lo
// que se ve bien.
const BADGE_ROTO = "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";

/**
 * Hasta dónde llegó la versión que se está siguiendo, y de qué color queda cada
 * canal por eso. El avance es de la FILA: un canal no se pinta por lo que es,
 * sino por lo lejos que llegó lo que se probó.
 */
function coloresDe(canales: CanalTienda[]): Record<EtapaCanal, Color> {
  const pruebas = canales.find((c) => c.etapa === "pruebas");
  const revision = canales.find((c) => c.etapa === "revision");
  const produccion = canales.find((c) => c.etapa === "produccion");

  // Tienda todavía sin nada: no hay avance que pintar.
  if (!pruebas?.version && !revision?.version && !produccion?.version) {
    return { pruebas: "vacio", revision: "vacio", produccion: "vacio" };
  }

  const publicada =
    !!produccion?.version && !revision?.version && pruebas?.version === produccion.version;
  if (publicada) return { pruebas: "verde", revision: "verde", produccion: "verde" };

  if (revision?.version) return { pruebas: "azul", revision: "azul", produccion: "vacio" };
  return { pruebas: "ambar", revision: "vacio", produccion: "vacio" };
}

export function CanalesTienda({ canales }: { canales: CanalTienda[] }) {
  const colores = coloresDe(canales);
  const alDia = colores.pruebas === "verde" && colores.produccion === "verde";

  return (
    <div className="grid gap-1.5 sm:grid-cols-3">
      {canales.map((c) => (
        <div
          key={c.key}
          className={cn(
            "rounded-lg border p-2 transition-colors",
            COLOR_CLASSES[colores[c.etapa]],
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
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 font-semibold",
                  c.estado.tone === "halted" ? BADGE_ROTO : BADGE_ETAPA[c.etapa],
                )}
              >
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
