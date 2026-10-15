/**
 * Pestaña Avatar del panel de GeorgIA: cada persona elige cómo se ve SU
 * GeorgIA. Sin elegir, ve la general (la que pone el root en Configuración →
 * GeorgIA). Se guarda en `agente_skins/{email}`.
 */
import { useState } from "react";
import { Check, Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Personaje } from "./AgenteVolador";
import { SKINS, useNombresAvatar, useSkinGeneral, useSkinPropio, type Skin } from "./skinsDatos";
import { cambiarSkinPropio } from "@/lib/agenteRepos";

export function ElegirAvatar({ email }: { email: string }) {
  const general = useSkinGeneral();
  const propio = useSkinPropio();
  const [guardando, setGuardando] = useState<Skin | "general" | null>(null);
  const [error, setError] = useState("");

  const elegir = async (s: Skin | null) => {
    if (s === propio) return;
    setGuardando(s ?? "general");
    setError("");
    try {
      await cambiarSkinPropio(email, s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setGuardando(null);
    }
  };

  const nombreDe = useNombresAvatar();
  const nombreGeneral = nombreDe(general);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <h2 className="font-semibold">Tu avatar de GeorgIA</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Solo lo ves tú. Si no eliges uno, ves el general: <span className="font-medium text-foreground">{nombreGeneral}</span>.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <Opcion
          sel={propio === null}
          ocupado={guardando === "general"}
          deshabilitado={guardando !== null}
          onClick={() => void elegir(null)}
          skin={general}
          nombre="General"
          desc={`El que pone el admin (hoy: ${nombreGeneral})`}
          icono={<RotateCcw className="h-3 w-3" />}
        />
        {SKINS.map((s) => (
          <Opcion
            key={s.id}
            sel={propio === s.id}
            ocupado={guardando === s.id}
            deshabilitado={guardando !== null}
            onClick={() => void elegir(s.id)}
            skin={s.id}
            nombre={nombreDe(s.id)}
            desc={s.desc}
          />
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">Cambia al momento, sin recargar.</p>
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

function Opcion({ sel, ocupado, deshabilitado, onClick, skin, nombre, desc, icono }: {
  sel: boolean;
  ocupado: boolean;
  deshabilitado: boolean;
  onClick: () => void;
  skin: Skin;
  nombre: string;
  desc: string;
  icono?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={deshabilitado}
      aria-pressed={sel}
      className={cn(
        "relative flex flex-col items-center rounded-xl border p-2 text-left transition-colors disabled:opacity-60",
        sel ? "border-primary bg-primary/5 ring-2 ring-primary/30" : "hover:bg-muted",
      )}
    >
      {sel && <Check className="absolute right-2 top-2 h-4 w-4 text-primary" />}
      {ocupado && <Loader2 className="absolute right-2 top-2 h-4 w-4 animate-spin text-muted-foreground" />}
      <div className="h-24 w-24"><Personaje pose="quieto" animo="feliz" skin={skin} /></div>
      <span className="mt-1 inline-flex items-center gap-1 text-xs font-semibold">{icono}{nombre}</span>
      <span className="text-center text-[10px] leading-tight text-muted-foreground">{desc}</span>
    </button>
  );
}
