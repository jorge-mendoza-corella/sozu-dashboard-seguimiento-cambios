/**
 * Chips de "Permisos de IA" en la ficha de cada usuario (pantalla Usuarios):
 * usar el agente de repos y ver la documentación que cita. Escriben en
 * `agente_config/acceso`, que solo el root puede tocar; la misma lista se
 * edita en Configuración → Agente IA.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, FileText, Loader2 } from "lucide-react";
import { useState } from "react";
import { cambiarVerDocs, darAccesoAgente, leerAccesoAgente, quitarAccesoAgente } from "@/lib/agenteRepos";

const CLAVE_ACCESO_AGENTE = ["agente-acceso"];

const claseChip = (on: boolean) =>
  `flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
    on
      ? "border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/30 dark:text-emerald-300"
      : "border-border text-muted-foreground hover:bg-muted"
  }`;

export function PermisosIaChips({ email, disabled }: { email: string; disabled?: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: CLAVE_ACCESO_AGENTE, queryFn: leerAccesoAgente });
  const [busy, setBusy] = useState<"agente" | "docs" | null>(null);
  const [error, setError] = useState("");

  const agente = !!data?.emails.includes(email);
  const docs = !!data?.docs.includes(email);

  const run = async (k: "agente" | "docs", fn: () => Promise<void>) => {
    setBusy(k);
    setError("");
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: CLAVE_ACCESO_AGENTE });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled || busy !== null}
          className={claseChip(agente)}
          onClick={() => void run("agente", () => (agente ? quitarAccesoAgente(email) : darAccesoAgente(email)))}
          title={agente ? "Quitar el agente (también quita ver documentación)" : "Dar acceso al agente de repos"}
        >
          {busy === "agente" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bot className="h-3 w-3" />}
          Agente de repos
        </button>
        <button
          type="button"
          // Sin agente no hay dónde ver los documentos: primero el agente.
          disabled={disabled || busy !== null || !agente}
          className={claseChip(docs)}
          onClick={() => void run("docs", () => cambiarVerDocs(email, !docs))}
          title={!agente ? "Primero dale acceso al agente" : docs ? "Quitar permiso para abrir documentación" : "Dejarle abrir la documentación que cita el agente"}
        >
          {busy === "docs" ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
          Ver documentación
        </button>
      </div>
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
    </>
  );
}
