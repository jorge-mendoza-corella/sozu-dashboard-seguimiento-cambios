/**
 * Token de la suscripción de Claude con el que corren los tickets mandados a
 * Claude Code. Con Claude Team cada persona conecta el suyo (su ventana de 5 h);
 * el root usa el compartido `CLAUDE_CODE_OAUTH_TOKEN`, que además usan los docs.
 *
 *  - `ConectarClaude`: instrucciones paso a paso y el campo para pegar el token.
 *    Se cifra en el navegador (ver `conectarClaude`): nunca viaja en claro.
 *  - `AvisoTokenClaude`: una corrida falló por el token, o vence en menos de
 *    21 días. Al root le da el comando para renovar el compartido en los 9
 *    repos; a los demás, reconectar el suyo.
 *
 * El token es opaco: no se puede preguntar cuándo vence. `claude setup-token` lo
 * emite por un año y se cuenta desde que se conectó (ver `agenteClaudeToken`).
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, KeyRound, Loader2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { conectarClaude, desconectarClaude, marcarTokenRenovado, type TokenClaude } from "@/lib/agenteTickets";
import { CLAVE_TOKEN_CLAUDE as CLAVE, useTokenClaude } from "@/hooks/useTokenClaude";
import { mensajeDeError } from "@/lib/agenteRepos";

/** Desde cuántos días antes del vencimiento se avisa. */
const AVISO_DIAS = 21;

/** Repos con el secret compartido: el orquestador de tickets y los 8 que generan docs. */
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
    <div className="relative mt-1">
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

/** Pasos y campo para que cada persona conecte (o reconecte) su cuenta de Claude. */
export function ConectarClaude({ reconectar = false, className }: { reconectar?: boolean; className?: string }) {
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const conectar = useMutation({
    mutationFn: () => conectarClaude(token),
    onSuccess: (t) => { setToken(""); qc.setQueryData(CLAVE, t); },
  });
  return (
    <div className={cn("space-y-3 rounded-lg border border-violet-300/60 bg-violet-50/60 p-3 text-xs dark:border-violet-800/60 dark:bg-violet-950/20", className)}>
      <div>
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <KeyRound className="h-4 w-4 text-violet-600 dark:text-violet-300" />
          {reconectar ? "Vuelve a conectar tu cuenta de Claude" : "Conecta tu cuenta de Claude para mandar tickets"}
        </p>
        <p className="mt-1 text-muted-foreground">
          Claude Code trabaja tus tickets con <strong>tu</strong> suscripción (plan Team de Sozu) y gasta tu ventana de 5 horas, no la de
          alguien más. Se hace una vez al año y toma unos 3 minutos.
        </p>
      </div>

      <ol className="list-decimal space-y-3 pl-4">
        <li>
          <strong>Revisa que tengas acceso.</strong> Entra a <a href="https://claude.ai" target="_blank" rel="noreferrer" className="text-primary underline">claude.ai</a> con
          tu correo de Sozu. Arriba a la izquierda debe aparecer la organización <strong>Sozu</strong>. Si no aparece, o tu plan no incluye Claude
          Code, pídele acceso a Jorge Mendoza antes de seguir.
        </li>
        <li>
          <strong>Instala Claude Code</strong> (solo la primera vez; si ya lo usas, sáltate este paso).
          <span className="mt-1 block text-muted-foreground">En Mac: abre la app <em>Terminal</em> y pega:</span>
          <Copiable texto="curl -fsSL https://claude.ai/install.sh | bash" />
          <span className="mt-1 block text-muted-foreground">En Windows: abre <em>PowerShell</em> y pega:</span>
          <Copiable texto="irm https://claude.ai/install.ps1 | iex" />
          <span className="mt-1 block text-muted-foreground">Cierra y vuelve a abrir la terminal. Para comprobar, <code>claude --version</code> debe mostrar un número de versión.</span>
        </li>
        <li>
          <strong>Genera tu token.</strong> En la terminal corre:
          <Copiable texto="claude setup-token" />
          <span className="mt-1 block text-muted-foreground">
            Se abre el navegador. Inicia sesión con tu correo de Sozu y, si te pregunta, elige la organización <strong>Sozu</strong> (no una
            cuenta personal). Da clic en <strong>Authorize</strong>.
          </span>
        </li>
        <li>
          <strong>Copia el token.</strong> De regreso en la terminal aparece un texto largo que empieza con <code>sk-ant-oat01-</code>.
          Cópialo completo. Si la terminal lo parte en varias líneas, cópialas todas: aquí se juntan solas.
        </li>
        <li>
          <strong>Pégalo aquí y da Conectar.</strong>
          <form
            className="mt-1.5 flex flex-wrap items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); if (token.trim()) conectar.mutate(); }}
          >
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="sk-ant-oat01-…"
              autoComplete="off"
              spellCheck={false}
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-[11px] outline-none focus:ring-2 focus:ring-ring"
              aria-label="Token de Claude"
            />
            <button
              type="submit"
              disabled={!token.trim() || conectar.isPending}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {conectar.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />} Conectar
            </button>
          </form>
          {conectar.error && <p className="mt-1 text-destructive">{mensajeDeError(conectar.error)}</p>}
          <p className="mt-1 text-[11px] text-muted-foreground">
            Se cifra en tu navegador antes de salir y solo GitHub Actions lo puede abrir para trabajar tus tickets. Ni el dashboard ni
            nadie puede leerlo después.
          </p>
        </li>
      </ol>

      <p className="text-[11px] text-muted-foreground">
        El token dura un año; te avisamos aquí 21 días antes. No lo compartas ni lo pegues en chats o correos. Si crees que alguien lo vio,
        genera otro con <code>claude setup-token</code>, conéctalo aquí (reemplaza al anterior) y avísale a Jorge.
      </p>
    </div>
  );
}

/** Línea junto al botón de mandar: con qué token va y opción de desconectarlo. */
export function EstadoTokenClaude({ t }: { t: TokenClaude }) {
  const qc = useQueryClient();
  const desconectar = useMutation({ mutationFn: desconectarClaude, onSuccess: (x) => qc.setQueryData(CLAVE, x) });
  return (
    <p className="w-full text-[11px] text-muted-foreground">
      {t.compartido ? "Usa el token compartido de Claude" : "Usa tu cuenta de Claude"}
      {t.vence && ` · vence el ${fecha(t.vence)}`}
      {!t.compartido && (
        <>
          {" · "}
          <button type="button" onClick={() => desconectar.mutate()} disabled={desconectar.isPending} className="underline underline-offset-2 hover:text-foreground">
            {desconectar.isPending ? "desconectando…" : "desconectar"}
          </button>
          {desconectar.error && <span className="text-destructive"> {mensajeDeError(desconectar.error)}</span>}
        </>
      )}
    </p>
  );
}

export function AvisoTokenClaude({ fallo = null, className }: {
  /** La corrida falló por el token (vencido, revocado o sin conectar): el aviso va en rojo. */
  fallo?: { detalle: string | null } | null;
  className?: string;
}) {
  const qc = useQueryClient();
  const q = useTokenClaude();
  const renovar = useMutation({ mutationFn: marcarTokenRenovado, onSuccess: (t) => qc.setQueryData(CLAVE, t) });
  const [abierto, setAbierto] = useState(false);
  // Al montar basta: cuenta días, no segundos.
  const [ahora] = useState(() => Date.now());

  const t = q.data;
  if (!t) return null;
  const dias = t.vence ? Math.ceil((Date.parse(t.vence) - ahora) / 86_400_000) : null;
  const vencido = !!fallo || (dias !== null && dias <= 0);
  const porVencer = dias !== null && dias > 0 && dias <= AVISO_DIAS;
  // Renovado después del fallo: el aviso rojo ya no aplica.
  const renovadoHoy = !!t.renovado && ahora - Date.parse(t.renovado) < 86_400_000;
  if (!(vencido || porVencer) || (fallo && renovadoHoy)) return null;
  // Sin conectar, quien manda ya ve la tarjeta para conectar: no se duplica.
  if (!t.compartido && !t.conectado && !fallo) return null;

  const titulo = fallo
    ? "Falló porque el token de Claude venció, se revocó o no está conectado."
    : vencido
      ? `${t.compartido ? "El token compartido" : "Tu token"} de Claude venció el ${fecha(t.vence!)}.`
      : `${t.compartido ? "El token compartido" : "Tu token"} de Claude vence en ${dias} día${dias === 1 ? "" : "s"} (${fecha(t.vence!)}).`;

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
        {titulo}
      </p>
      <p className="opacity-90">
        {t.compartido
          ? <>Lo usan los tickets que mandas a Claude y la documentación automática de los 8 repos (<code>CLAUDE_CODE_OAUTH_TOKEN</code>). </>
          : <>Con él corren los tickets que mandas a Claude. </>}
        {vencido ? "Hasta renovarlo, no se puede trabajar con Claude." : "Renuévalo antes para que nada se detenga."}
      </p>
      {fallo?.detalle && <p className="break-all font-mono text-[10.5px] opacity-75">{fallo.detalle}</p>}

      {t.compartido ? (
        <>
          <button type="button" onClick={() => setAbierto((v) => !v)} className="font-medium underline underline-offset-2">
            {abierto ? "Ocultar pasos" : "Cómo renovarlo (2 min)"}
          </button>
          {abierto && (
            <ol className="list-decimal space-y-2 pl-4">
              <li>
                En la terminal integrada de VS Code (cuenta <strong>jorge.mendoza@sozu.com</strong>), genera uno nuevo y copia el que empieza
                con <code>sk-ant-oat01-</code>:
                <Copiable texto="claude setup-token" />
              </li>
              <li>
                En esa misma terminal, ponlo en los 9 repos que lo usan (te lo pide sin mostrarlo; no lo pegues en ningún chat):
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
        <>
          <ConectarClaude reconectar className="bg-background/60" />
          {fallo && <p className="opacity-90">Ya conectado, contéstale a Claude en este ticket (por ejemplo "reintenta") y arranca otra corrida.</p>}
        </>
      )}
    </div>
  );
}
