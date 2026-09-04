import { Building2, MessageCircle, MessageCircleOff, Rocket, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EmpresaOption } from "@/lib/empresas";

// ---------------------------------------------------------------------------
// Barra para moverse entre empresas. Solo aparece cuando el usuario ve más de
// una: con una sola sería una fila que no decide nada.
//
// Cuál está elegida tiene que verse de un golpe. Antes la única diferencia era
// un fondo blanco sobre gris claro —el mismo peso de letra, el mismo color—, y
// con cuatro empresas de nombre corto había que leerlas todas para saber en
// cuál estabas. Ahora la activa lleva el COLOR DE LA EMPRESA: borde, un punto
// grande, la letra en ese tono y una barra abajo que la ancla a las pestañas de
// proyecto que dependen de ella. Ese color ya identifica a la empresa en todo
// el dashboard, así que no hay que aprenderse nada nuevo.
//
// El filtro vive en la pantalla que lo usa, no aquí, porque cada una lo aplica
// a lo suyo (las pestañas de CI/CD, las tarjetas del Resumen). Este componente
// solo muestra las opciones y avisa cuál se eligió.
// ---------------------------------------------------------------------------

interface Props {
  empresas: EmpresaOption[];
  /** Empresa elegida; null = todas. */
  activa: string | null;
  onChange: (id: string | null) => void;
  totalProyectos: number;
  /**
   * `clientId → manda avisos de WhatsApp`. Vacío = quien mira no puede leer esa
   * configuración, y entonces no se pinta nada: un badge "apagada" que en
   * realidad significa "no tengo permiso de saberlo" haría perseguir un
   * problema que no existe.
   */
  avisos?: Map<string, boolean>;
  /**
   * `clientId → deploy en curso`. Con varias empresas, uno corriendo en la que
   * no estás mirando no se ve por ningún lado: ni sus pestañas de proyecto
   * están en pantalla.
   */
  deploys?: Map<string, "prd" | "dev">;
}

export function EmpresaSelector({ empresas, activa, onChange, totalProyectos, avisos, deploys }: Props) {
  if (empresas.length < 2) return null;

  const elegida = empresas.find((e) => e.id === activa);

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Building2 className="h-4 w-4" /> Empresa
          <span className="font-normal normal-case tracking-normal opacity-70">(proyectos)</span>
        </span>

        {/* Control segmentado: es UN eje con opciones excluyentes, no una lista
            de filtros sueltos. Antes eran chips independientes y competían
            visualmente con las pestañas de proyecto, que están un nivel abajo. */}
        <div className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            onClick={() => onChange(null)}
            title={`Ver todo: ${totalProyectos} proyecto${totalProyectos === 1 ? "" : "s"}`}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
              activa === null
                ? "bg-background font-bold text-foreground shadow-sm ring-1 ring-border"
                : "font-medium text-muted-foreground hover:text-foreground",
            )}
          >
            Todas
            {/* El número cuenta PROYECTOS, no repos: es el mismo eje que las
                pestañas de abajo. Sin decirlo, se lee como "repos" y no cuadra
                con el conteo de cada pestaña (Admin son 6 repos en 1 proyecto). */}
            <span className="text-[11px] opacity-60" title="proyectos">{totalProyectos}</span>
          </button>

          {empresas.map((e) => {
            const activo = activa === e.id;
            return (
              <button
                key={e.id || "sin-empresa"}
                type="button"
                onClick={() => onChange(e.id)}
                aria-current={activo ? "true" : undefined}
                title={[
                  activo ? `Estás viendo ${e.nombre}` : `Ver solo lo de ${e.nombre}`,
                  `${e.proyectos} proyecto${e.proyectos === 1 ? "" : "s"}`,
                  ...(avisos?.has(e.id)
                    ? [avisos.get(e.id) ? "manda avisos de WhatsApp" : "NO manda avisos de WhatsApp"]
                    : []),
                ].join(" · ")}
                className={cn(
                  "relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                  activo
                    ? "bg-background font-bold shadow-sm"
                    : "font-medium text-muted-foreground hover:text-foreground",
                )}
                // El color de la empresa, no el primario de la marca: es lo que
                // la identifica en las tarjetas y en las pestañas de proyecto.
                style={activo ? { color: e.color, boxShadow: `inset 0 0 0 1.5px ${e.color}` } : undefined}
              >
                <span
                  className={cn("shrink-0 rounded-full transition-all", activo ? "h-3 w-3" : "h-2.5 w-2.5")}
                  style={{ backgroundColor: e.color }}
                />
                {e.nombre}
                <span className={cn("text-[11px]", activo ? "opacity-80" : "opacity-60")} title="proyectos">
                  {e.proyectos}
                </span>
                {avisos?.has(e.id) && (avisos.get(e.id)
                  ? <MessageCircle className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  : <MessageCircleOff className="h-3 w-3 text-muted-foreground" />)}
                {/* Solo cuando no es la empresa abierta: dentro ya se ve en la
                    pestaña del proyecto que está desplegando. */}
                {!activo && deploys?.get(e.id) === "prd" && (
                  <Rocket className="h-3 w-3 animate-pulse text-emerald-600 dark:text-emerald-400" aria-label="Deploy a PRD en curso" />
                )}
                {!activo && deploys?.get(e.id) === "dev" && (
                  <Loader2 className="h-3 w-3 animate-spin text-sky-600 dark:text-sky-400" aria-label="Deploy a DEV en curso" />
                )}
                {/* Barra al pie de la activa: ata visualmente la empresa con la
                    fila de pestañas de proyecto que cuelga de ella. */}
                {activo && (
                  <span
                    aria-hidden
                    className="absolute -bottom-1 left-2 right-2 h-0.5 rounded-full"
                    style={{ backgroundColor: e.color }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Y dicho con palabras, no solo con color: en un vistazo periférico el
          color se registra, pero al volver a la pestaña hay que releer los
          chips para recordar dónde estabas. */}
      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {elegida ? (
          <>
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: elegida.color }}
            />
            <span>
              Viendo <span className="font-semibold" style={{ color: elegida.color }}>{elegida.nombre}</span>
              {" · "}
              {elegida.proyectos} proyecto{elegida.proyectos === 1 ? "" : "s"} de {totalProyectos}
            </span>
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => onChange(null)}
            >
              ver todas
            </button>
          </>
        ) : (
          <span>
            Viendo <span className="font-semibold text-foreground">todas las empresas</span>
            {" · "}{totalProyectos} proyecto{totalProyectos === 1 ? "" : "s"}
          </span>
        )}
      </p>
    </div>
  );
}
