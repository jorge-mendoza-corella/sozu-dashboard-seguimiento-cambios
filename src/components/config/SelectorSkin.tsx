/** Elección de la apariencia de GeorgIA (Configuración → GeorgIA). */
import { useState } from "react";
import { Check, Loader2, Palette } from "lucide-react";
import { cn } from "@/lib/utils";
import { Personaje } from "@/components/agente/AgenteVolador";
import { SKINS, useSkinGeorgIA, type Skin } from "@/components/agente/skinsDatos";
import { cambiarSkin } from "@/lib/agenteRepos";

export function SelectorSkin() {
  const actual = useSkinGeorgIA();
  const [guardando, setGuardando] = useState<Skin | null>(null);
  const [error, setError] = useState("");

  const elegir = async (s: Skin) => {
    if (s === actual) return;
    setGuardando(s);
    setError("");
    try {
      await cambiarSkin(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setGuardando(null);
    }
  };

  return (
    <div>
      <p className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Palette className="h-3.5 w-3.5" /> Apariencia
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
        {SKINS.map((s) => {
          const sel = s.id === actual;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => void elegir(s.id)}
              disabled={guardando !== null}
              className={cn(
                "relative flex flex-col items-center rounded-xl border p-2 text-left transition-colors disabled:opacity-60",
                sel ? "border-primary bg-primary/5 ring-2 ring-primary/30" : "hover:bg-muted",
              )}
            >
              {sel && <Check className="absolute right-2 top-2 h-4 w-4 text-primary" />}
              {guardando === s.id && <Loader2 className="absolute right-2 top-2 h-4 w-4 animate-spin text-muted-foreground" />}
              <div className="h-24 w-24"><Personaje pose="quieto" animo="feliz" skin={s.id} /></div>
              <span className="mt-1 text-xs font-semibold">{s.nombre}</span>
              <span className="text-center text-[10px] leading-tight text-muted-foreground">{s.desc}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">La ven igual todas las personas que usan GeorgIA. Cambia al momento, sin recargar.</p>
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
