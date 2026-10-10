/**
 * Chip "Mostrar a GeorgIA" para el renglón propio en Usuarios. Es preferencia de
 * cada quien (`users/{email}.agenteVolador`); apagarlo pide confirmación con la
 * súplica de GeorgIA. El chat sigue en Alt+K.
 */
import { useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { setUserAgenteVolador } from "@/lib/firestoreUsers";
import { ConfirmarApagarAgentito } from "./ConfirmarApagarAgentito";

export function MostrarGeorgIA() {
  const { realUser } = useAuth();
  const [visibleLocal, setVisibleLocal] = useState<boolean | null>(null);
  const visible = visibleLocal ?? realUser?.agenteVolador !== false;
  const [confirmando, setConfirmando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  const cambiar = async (v: boolean) => {
    if (!realUser?.email) return;
    setGuardando(true);
    setError("");
    try {
      await setUserAgenteVolador(realUser.email, v);
      setVisibleLocal(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="mb-4">
      <p className="mb-2 flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Bot className="h-3.5 w-3.5" /> GeorgIA
      </p>
      <button
        type="button"
        disabled={guardando}
        onClick={() => (visible ? setConfirmando(true) : void cambiar(true))}
        title={visible ? "GeorgIA vuela por la pantalla — click para esconderla" : "GeorgIA está escondida — click para que vuelva"}
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50",
          visible
            ? "border-emerald-400 bg-emerald-100 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-900/40 dark:text-emerald-300"
            : "border-border text-muted-foreground hover:bg-muted",
        )}
      >
        {guardando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bot className="h-3 w-3" />}
        Mostrar a GeorgIA
      </button>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {visible
          ? "Vuela por la pantalla, festeja los deploys y te grita por los tickets."
          : "Escondida: no vuela ni grita. El chat sigue en Alt+K."}
      </p>
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
      {confirmando && (
        <ConfirmarApagarAgentito
          abierto
          onCancelar={() => setConfirmando(false)}
          onConfirmar={() => { setConfirmando(false); void cambiar(false); }}
        />
      )}
    </div>
  );
}
