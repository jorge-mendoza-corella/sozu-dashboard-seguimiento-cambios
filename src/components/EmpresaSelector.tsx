import { Building2 } from "lucide-react";
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
}

export function EmpresaSelector({ empresas, activa, onChange, totalProyectos }: Props) {
  if (empresas.length < 2) return null;

  const chip = (activo: boolean, color?: string) =>
    cn(
      "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
      activo
        ? "border-primary bg-primary/10 text-primary"
        : "border-border text-muted-foreground hover:bg-muted",
      color && "pl-2",
    );

  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <span className="mr-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Building2 className="h-3.5 w-3.5" /> Empresa
      </span>
      <button type="button" className={chip(activa === null)} onClick={() => onChange(null)}>
        Todas
        <span className="text-[10px] opacity-70">({totalProyectos})</span>
      </button>
      {empresas.map((e) => (
        <button
          key={e.id || "sin-empresa"}
          type="button"
          className={chip(activa === e.id, e.color)}
          onClick={() => onChange(e.id)}
          title={`Ver solo los proyectos de ${e.nombre}`}
        >
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: e.color }} />
          {e.nombre}
          <span className="text-[10px] opacity-70">({e.proyectos})</span>
        </button>
      ))}
    </div>
  );
}
