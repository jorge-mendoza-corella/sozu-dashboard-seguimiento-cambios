/** Apariencia general de GeorgIA (Configuración → GeorgIA): la que ve quien no eligió la suya. */
import { useState } from "react";
import { Check, Loader2, Mail, Palette } from "lucide-react";
import { cn } from "@/lib/utils";
import { Personaje } from "@/components/agente/AgenteVolador";
import { SKINS, useCorreosAvatar, useSkinGeneral, type Skin } from "@/components/agente/skinsDatos";
import { cambiarCorreoAvatar, cambiarSkin } from "@/lib/agenteRepos";

export function SelectorSkin() {
  const actual = useSkinGeneral();
  const [guardando, setGuardando] = useState<Skin | null>(null);
  const [error, setError] = useState("");
  const correos = useCorreosAvatar();
  const [editando, setEditando] = useState<Partial<Record<Skin, string>>>({});
  const [guardandoCorreo, setGuardandoCorreo] = useState<Skin | null>(null);

  const guardarCorreo = async (s: Skin) => {
    const v = editando[s];
    if (v === undefined) return;
    const limpio = v.trim().toLowerCase();
    if (limpio && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(limpio)) { setError("Correo inválido."); return; }
    if (limpio === (correos[s] ?? "")) { setEditando((e) => ({ ...e, [s]: undefined })); return; }
    setGuardandoCorreo(s);
    setError("");
    try {
      await cambiarCorreoAvatar(s, limpio);
      setEditando((e) => ({ ...e, [s]: undefined }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setGuardandoCorreo(null);
    }
  };

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
        <Palette className="h-3.5 w-3.5" /> Apariencia general
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-5">
        {SKINS.map((s) => {
          const sel = s.id === actual;
          return (
            <div key={s.id} className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => void elegir(s.id)}
                disabled={guardando !== null}
                className={cn(
                  "relative flex flex-1 flex-col items-center rounded-xl border p-2 text-left transition-colors disabled:opacity-60",
                  sel ? "border-primary bg-primary/5 ring-2 ring-primary/30" : "hover:bg-muted",
                )}
              >
                {sel && <Check className="absolute right-2 top-2 h-4 w-4 text-primary" />}
                {guardando === s.id && <Loader2 className="absolute right-2 top-2 h-4 w-4 animate-spin text-muted-foreground" />}
                <div className="h-24 w-24"><Personaje pose="quieto" animo="feliz" skin={s.id} /></div>
                <span className="mt-1 text-xs font-semibold">{s.nombre}</span>
                <span className="text-center text-[10px] leading-tight text-muted-foreground">{s.desc}</span>
              </button>
              {/* Correo de la persona que es este avatar (titular de categorías de tickets). */}
              <label className="flex items-center gap-1 rounded-md border px-1.5 focus-within:ring-2 focus-within:ring-ring">
                {guardandoCorreo === s.id
                  ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                  : <Mail className="h-3 w-3 shrink-0 text-muted-foreground" />}
                <input
                  type="email"
                  value={editando[s.id] ?? correos[s.id] ?? ""}
                  onChange={(e) => setEditando((x) => ({ ...x, [s.id]: e.target.value }))}
                  onBlur={() => void guardarCorreo(s.id)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  placeholder="correo (opcional)"
                  aria-label={`Correo de ${s.nombre}`}
                  className="h-6 min-w-0 flex-1 bg-transparent text-[10px] outline-none"
                />
              </label>
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">Es la que ve quien no eligió la suya en la pestaña Avatar del panel de GeorgIA. El correo dice qué persona es cada avatar: si es titular de la categoría de un ticket, ese avatar avisa y trabaja el ticket.</p>
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
