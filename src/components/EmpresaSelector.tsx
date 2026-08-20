import { Building2, MessageCircle, MessageCircleOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EmpresaOption } from "@/lib/empresas";

// ---------------------------------------------------------------------------
// Barra para moverse entre empresas. Solo aparece cuando el usuario ve más de
// una: con una sola sería una fila que no decide nada.
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
}

export function EmpresaSelector({ empresas, activa, onChange, totalProyectos, avisos }: Props) {
  if (empresas.length < 2) return null;

  // Control segmentado: es UN eje con opciones excluyentes, no una lista de
  // filtros sueltos. Antes eran chips independientes y competían visualmente con
  // las pestañas de proyecto, que están un nivel más abajo.
  const opcion = (activo: boolean) =>
    cn(
      "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
      activo
        ? "bg-background text-foreground shadow-sm"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Building2 className="h-4 w-4" /> Empresa
      </span>
      <div className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
        <button type="button" className={opcion(activa === null)} onClick={() => onChange(null)}>
          Todas
          <span className="text-[11px] opacity-60">{totalProyectos}</span>
        </button>
        {empresas.map((e) => (
          <button
            key={e.id || "sin-empresa"}
            type="button"
            className={opcion(activa === e.id)}
            onClick={() => onChange(e.id)}
            title={
              avisos?.has(e.id)
                ? `Ver solo lo de ${e.nombre} · ${avisos.get(e.id) ? "manda avisos de WhatsApp" : "NO manda avisos de WhatsApp"}`
                : `Ver solo lo de ${e.nombre}`
            }
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: e.color }} />
            {e.nombre}
            <span className="text-[11px] opacity-60">{e.proyectos}</span>
            {avisos?.has(e.id) && (avisos.get(e.id)
              ? <MessageCircle className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              : <MessageCircleOff className="h-3 w-3 text-muted-foreground" />)}
          </button>
        ))}
      </div>
    </div>
  );
}
