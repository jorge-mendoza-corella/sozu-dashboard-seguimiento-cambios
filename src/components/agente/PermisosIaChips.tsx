/**
 * Chips de "Permisos de IA" en la ficha de cada usuario (pantalla Usuarios):
 * usar el agente de repos y ver la documentación que cita. Escriben en
 * `agente_config/acceso`, que solo el root puede tocar; la misma lista se
 * edita en Configuración → Agente IA.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Bot, FileText, Loader2, Megaphone, Send } from "lucide-react";
import { useState } from "react";
import { AyudaTooltip } from "@/components/ui/ayuda-tooltip";
import { cambiarClaude, cambiarMegafono, cambiarTickets, cambiarVerDocs, darAccesoAgente, leerAccesoAgente, quitarAccesoAgente } from "@/lib/agenteRepos";

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
  const [busy, setBusy] = useState<"agente" | "docs" | "tickets" | "claude" | "megafono" | null>(null);
  const [error, setError] = useState("");

  const agente = !!data?.emails.includes(email);
  const docs = !!data?.docs.includes(email);
  const tickets = !!data?.tickets.includes(email);
  const claude = !!data?.claude.includes(email);
  const megafono = !!data?.megafono.includes(email);

  const run = async (k: "agente" | "docs" | "tickets" | "claude" | "megafono", fn: () => Promise<void>) => {
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
        <AyudaTooltip texto={"Usar a GeorgIA, el agente que contesta dudas de los repos de Sozu (técnicas y de cómo se usa la plataforma)." + (agente ? " Quitarlo quita también documentación y tickets." : "")}>
          <button
            type="button"
            disabled={disabled || busy !== null}
            className={claseChip(agente)}
            onClick={() => void run("agente", () => (agente ? quitarAccesoAgente(email) : darAccesoAgente(email)))}
          >
            {busy === "agente" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bot className="h-3 w-3" />}
            GeorgIA
          </button>
        </AyudaTooltip>
        <AyudaTooltip texto={"Abrir los documentos de sozu-docs que GeorgIA cita en sus respuestas." + (!agente ? " Primero dale acceso a GeorgIA." : "")}>
          <button
            type="button"
            // Sin agente no hay dónde ver los documentos: primero el agente.
            disabled={disabled || busy !== null || !agente}
            className={claseChip(docs)}
            onClick={() => void run("docs", () => cambiarVerDocs(email, !docs))}
          >
            {busy === "docs" ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
            Ver documentación
          </button>
        </AyudaTooltip>
        <AyudaTooltip texto={"Pestaña Tickets: sus tickets pendientes del portal, cerrarlos con sus PRs; GeorgIA los revisa cada 15 min y le avisa." + (!agente ? " Primero dale acceso a GeorgIA." : "")}>
          <button
            type="button"
            disabled={disabled || busy !== null || !agente}
            className={claseChip(tickets)}
            onClick={() => void run("tickets", () => cambiarTickets(email, !tickets))}
          >
            {busy === "tickets" ? <Loader2 className="h-3 w-3 animate-spin" /> : <BellRing className="h-3 w-3" />}
            Revisar tickets
          </button>
        </AyudaTooltip>
        <AyudaTooltip texto={"Mandar sus tickets a Claude Code, que los trabaja y abre los PRs hacia dev." + (!tickets ? " Primero prende «Revisar tickets»." : "")}>
          <button
            type="button"
            disabled={disabled || busy !== null || !agente || !tickets}
            className={claseChip(claude && tickets)}
            onClick={() => void run("claude", () => cambiarClaude(email, !claude))}
          >
            {busy === "claude" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            Mandar a Claude
          </button>
        </AyudaTooltip>
        <AyudaTooltip texto={"Megáfono: escribir un mensaje (o grabar un audio) para que el avatar de los demás aterrice y lo grite. Elige a quién le llega." + (!agente ? " Primero dale acceso a GeorgIA." : "")}>
          <button
            type="button"
            disabled={disabled || busy !== null || !agente}
            className={claseChip(megafono && agente)}
            onClick={() => void run("megafono", () => cambiarMegafono(email, !megafono))}
          >
            {busy === "megafono" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Megaphone className="h-3 w-3" />}
            Megáfono
          </button>
        </AyudaTooltip>
      </div>
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
    </>
  );
}
