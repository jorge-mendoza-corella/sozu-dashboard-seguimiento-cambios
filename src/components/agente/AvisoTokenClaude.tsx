/**
 * Aviso del token de la suscripción de Claude (`CLAUDE_CODE_OAUTH_TOKEN`) con
 * el que corren los tickets mandados a Claude y la documentación automática.
 *
 * Sale en dos casos: una corrida falló porque el token venció o se revocó
 * (`fallo`), o faltan pocos días para que venza. El vencimiento se calcula de
 * la fecha en que se renovó por última vez (ver `agenteClaudeToken`): el token
 * es opaco y no se le puede preguntar. Trae los pasos para renovarlo y, para
 * el root, el botón que marca la renovación.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, KeyRound, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { auth } from "@/lib/firebase";
import { SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import { marcarTokenRenovado, tokenClaude } from "@/lib/agenteTickets";
import { mensajeDeError } from "@/lib/agenteRepos";

/** Desde cuántos días antes del vencimiento se avisa. */
const AVISO_DIAS = 21;

/** Repos con el secret: el orquestador de tickets y los 8 que generan docs. */
const REPOS = [
  "jorgeIMendoza/sozu-georgia-tareas",
  "jorgeIMendoza/sozu-supabase-migrations",
  "jorgeIMendoza/sozu-admin",
  "jorgeIMendoza/sozu-cliente-app",
  "jorgeIMendoza/sozu-edge-functions",
  "jorgeIMendoza/sozu-agente-app",
  "jorgeIMendoza/sozu-mcp",
  "jorgeIMendoza/sozu-n8n-workflows",
  "sozu-com/server-stp",
];

// El token se pide sin eco y no queda en el historial de la terminal.
const COMANDO =
  `read -rs "T?Pega el token: " && echo && for r in ${REPOS.join(" ")}; do ` +
  `printf %s "$T" | gh secret set CLAUDE_CODE_OAUTH_TOKEN -R "$r" && echo "✓ $r"; done; unset T`;

const fecha = (iso: string) => new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });

function Copiable({ texto }: { texto: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-zinc-950 p-2 pr-9 font-mono text-[10.5px] leading-relaxed text-zinc-200">{texto}</pre>
      <button
        type="button"
        onClick={() => void navigator.clipboard.writeText(texto).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); })}
        className="absolute right-1.5 top-1.5 rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        title="Copiar"
        aria-label="Copiar"
      >
        {ok ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

export function AvisoTokenClaude({ fallo = null, className }: {
  /** La corrida falló por el token (vencido o revocado): el aviso va en rojo. */
  fallo?: { detalle: string | null } | null;
  className?: string;
}) {
  // La función lo vuelve a validar; aquí solo decide qué se enseña.
  const esRoot = auth.currentUser?.email?.toLowerCase() === SUPERUSER_EMAIL;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["claude-token"], queryFn: tokenClaude, staleTime: 60 * 60_000, retry: 1 });
  const renovar = useMutation({
    mutationFn: marcarTokenRenovado,
    onSuccess: (t) => qc.setQueryData(["claude-token"], t),
  });
  const [abierto, setAbierto] = useState(false);
  // Al montar basta: cuenta días, no segundos.
  const [ahora] = useState(() => Date.now());

  const vence = q.data?.vence ?? null;
  const dias = vence ? Math.ceil((Date.parse(vence) - ahora) / 86_400_000) : null;
  const vencido = !!fallo || (dias !== null && dias <= 0);
  const porVencer = dias !== null && dias > 0 && dias <= AVISO_DIAS;
  // Renovado después del fallo: el aviso rojo ya no aplica.
  const renovadoHoy = q.data?.renovado && ahora - Date.parse(q.data.renovado) < 86_400_000;
  if (!(vencido || porVencer) || (fallo && renovadoHoy)) return null;

  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border p-3 text-xs",
        vencido
          ? "border-red-300 bg-red-50/70 text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
          : "border-amber-300 bg-amber-50/70 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200",
        className,
      )}
      role={vencido ? "alert" : "status"}
    >
      <p className="flex items-start gap-1.5 font-semibold">
        {vencido ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        {fallo
          ? "Falló porque el token de Claude venció o se revocó."
          : vencido
            ? `El token de Claude venció el ${fecha(vence!)}.`
            : `El token de Claude vence en ${dias} día${dias === 1 ? "" : "s"} (${fecha(vence!)}).`}
      </p>
      <p className="opacity-90">
        Los tickets mandados a Claude y la documentación automática usan el token de la suscripción
        (<code>CLAUDE_CODE_OAUTH_TOKEN</code>). {vencido ? "Hasta renovarlo, todo lo que use a Claude va a fallar." : "Renuévalo antes para que nada se detenga."}
      </p>
      {fallo?.detalle && <p className="break-all font-mono text-[10.5px] opacity-75">{fallo.detalle}</p>}

      {esRoot ? (
        <>
          <button type="button" onClick={() => setAbierto((v) => !v)} className="font-medium underline underline-offset-2">
            {abierto ? "Ocultar pasos" : "Cómo renovarlo (2 min)"}
          </button>
          {abierto && (
            <ol className="list-decimal space-y-2 pl-4">
              <li>
                En la terminal integrada de VS Code (cuenta <strong>jorge.mendoza@sozu.com</strong>), genera uno nuevo y copia el
                que empieza con <code>sk-ant-oat01-</code>:
                <Copiable texto="claude setup-token" />
              </li>
              <li>
                En esa misma terminal, pon el token en los 9 repos que lo usan (te lo pide sin mostrarlo; no lo pegues en ningún chat):
                <Copiable texto={COMANDO} />
              </li>
              <li>
                Marca la renovación para que el aviso cuente el año de nuevo:
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => renovar.mutate()}
                    disabled={renovar.isPending}
                    className="inline-flex h-7 items-center gap-1 rounded-md bg-foreground px-2.5 text-[11px] font-semibold text-background disabled:opacity-50"
                  >
                    {renovar.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Ya lo renové
                  </button>
                  {renovar.error && <span className="text-destructive">{mensajeDeError(renovar.error)}</span>}
                </div>
              </li>
              {fallo && <li>Reintenta: contéstale a Claude en este ticket (por ejemplo "reintenta") y arranca otra corrida.</li>}
            </ol>
          )}
        </>
      ) : (
        <p className="opacity-90">Avísale a Jorge Mendoza: él renueva el token.</p>
      )}
    </div>
  );
}
