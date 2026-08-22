import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Loader2, Rocket, CheckCircle2, GitMerge, Users,
  MessageCircle, MessageCircleOff, AlertTriangle,
} from "lucide-react";
import { getDeployMeta, type DeployMeta, type WorkflowRun } from "@/lib/github";
import { getDeployNotification, type DeployNotification } from "@/lib/deployNotifications";
import type { AvisosDelProyecto } from "@/hooks/useAvisos";

// Caché por sha: el hover repetido no re-consulta GitHub.
const metaCache = new Map<string, DeployMeta>();
// Y por run: lo que el CI anotó sobre sus avisos. Se guarda incluso cuando no
// hay registro (`null`), para no volver a preguntar por un deploy viejo que
// nunca lo escribió.
const avisoCache = new Map<string, DeployNotification | null>();

/**
 * Envuelve un badge de deploy y muestra, al pasar el puntero, quién lo
 * generó (actor del run), los autores del PR, quién aprobó y quién mergeó.
 * La info se consulta perezosamente en el primer hover.
 */
export function DeployMetaTooltip({ owner, repo, run, avisos, children }: {
  owner: string;
  repo: string;
  run: WorkflowRun;
  /** A quién le toca el aviso según la configuración; para el caso sin registro. */
  avisos?: AvisosDelProyecto;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [meta, setMeta] = useState<DeployMeta | null>(
    run.headSha ? metaCache.get(run.headSha) ?? null : null,
  );
  const claveAviso = run.runId ? `${owner}/${repo}#${run.runId}` : null;
  const [aviso, setAviso] = useState<DeployNotification | null | undefined>(
    claveAviso ? avisoCache.get(claveAviso) : undefined,
  );
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<number | null>(null);

  const show = () => {
    if (hideTimer.current) { window.clearTimeout(hideTimer.current); hideTimer.current = null; }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 6, left: Math.max(8, rect.left) });
    setOpen(true);
    if (run.headSha && !metaCache.has(run.headSha)) {
      const sha = run.headSha;
      getDeployMeta(owner, repo, sha).then((m) => {
        metaCache.set(sha, m);
        setMeta(m);
      });
    }
    if (claveAviso && run.runId && !avisoCache.has(claveAviso)) {
      const clave = claveAviso;
      getDeployNotification(owner, repo, run.runId)
        .catch(() => null)
        .then((n) => {
          avisoCache.set(clave, n);
          setAviso(n);
        });
    }
  };

  const hide = () => {
    hideTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  const cached = run.headSha ? metaCache.get(run.headSha) ?? meta : meta;
  const avisoResuelto = claveAviso && avisoCache.has(claveAviso) ? avisoCache.get(claveAviso) : aviso;
  // Un deploy en curso todavía no notificó a nadie: el aviso sale al final del
  // workflow. Decir "se avisó a" mientras corre sería afirmar algo que aún no
  // pasó, así que se dice a quién LE VA A TOCAR.
  const corriendo = run.status !== "completed";

  return (
    <span ref={anchorRef} onMouseEnter={show} onMouseLeave={hide} className="inline-flex">
      {children}
      {open && pos && createPortal(
        <div
          style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 9999 }}
          className="w-64 rounded-lg border bg-background p-2.5 text-xs shadow-xl"
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <p className="mb-1.5 flex items-center gap-1 font-semibold">
            <Rocket className="h-3 w-3 text-emerald-500" />
            {run.name} · {run.headBranch === "main" ? "PRD" : "DEV"}
            {cached?.prNumber && <span className="text-muted-foreground font-normal">· PR #{cached.prNumber}</span>}
          </p>
          <div className="space-y-1 text-[11px]">
            <p className="flex items-start gap-1.5">
              <Rocket className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              <span><span className="text-muted-foreground">Generó:</span> <span className="font-mono">@{run.actor ?? "—"}</span></span>
            </p>
            {!cached ? (
              <p className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> consultando PR…
              </p>
            ) : (
              <>
                <p className="flex items-start gap-1.5">
                  <Users className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="text-muted-foreground">Cambios de:</span>{" "}
                    <span className="font-mono">{cached.authors.length ? cached.authors.map((a) => `@${a}`).join(", ") : "—"}</span>
                  </span>
                </p>
                <p className="flex items-start gap-1.5">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                  <span>
                    <span className="text-muted-foreground">Aprobó:</span>{" "}
                    {cached.approvedBy.length === 0 ? (
                      <span className="font-mono">—</span>
                    ) : (
                      cached.approvedBy.map((a, i) => (
                        <span key={a.login} className="font-mono">
                          {i > 0 && ", "}@{a.login}
                          {a.auto && (
                            <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 font-sans text-[9px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                              auto/bypass
                            </span>
                          )}
                        </span>
                      ))
                    )}
                  </span>
                </p>
                <p className="flex items-start gap-1.5">
                  <GitMerge className="mt-0.5 h-3 w-3 shrink-0 text-violet-500" />
                  <span>
                    <span className="text-muted-foreground">Mergeó:</span>{" "}
                    <span className="font-mono">{cached.mergedBy ? `@${cached.mergedBy}` : "—"}</span>
                  </span>
                </p>
              </>
            )}
            <AvisosDelDeploy corriendo={corriendo} registro={avisoResuelto} avisos={avisos} />
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}

/**
 * A quién se le avisó por WhatsApp, o a quién le va a tocar.
 *
 * La diferencia importa: el dashboard puede CALCULAR los destinatarios desde la
 * configuración, pero no si el mensaje salió. Un teléfono sin capturar, una
 * instancia caída o una empresa apagada cambian el resultado sin cambiar nada
 * de lo que se ve desde aquí. Por eso, cuando el deploy dejó registro se lee
 * ESE —es evidencia de lo que ocurrió—, y cuando no lo dejó se dice a quién le
 * toca, en futuro y sin prometer entrega.
 */
function AvisosDelDeploy({ corriendo, registro, avisos }: {
  corriendo: boolean;
  registro: DeployNotification | null | undefined;
  avisos?: AvisosDelProyecto;
}) {
  // `undefined` = todavía se está leyendo; `null` = ese deploy no dejó nota.
  if (registro === undefined && !corriendo) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 border-t pt-1.5 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> consultando avisos…
      </p>
    );
  }

  if (registro) {
    if (!registro.seMando) {
      return (
        <p className="mt-1.5 flex items-start gap-1.5 border-t pt-1.5 text-amber-600 dark:text-amber-400">
          <MessageCircleOff className="mt-0.5 h-3 w-3 shrink-0" />
          <span>No se avisó por WhatsApp: {registro.motivo || "la empresa no tiene los avisos activos."}</span>
        </p>
      );
    }
    return (
      <div className="mt-1.5 space-y-1 border-t pt-1.5">
        {registro.avisados.length > 0 && (
          <p className="flex items-start gap-1.5 text-emerald-600 dark:text-emerald-400">
            <MessageCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              Se avisó a{" "}
              <span className="font-mono">{registro.avisados.map((l) => `@${l}`).join(", ")}</span>
            </span>
          </p>
        )}
        {/* Un destinatario que falló es más importante que los que sí: nadie va
            a revisar el log del workflow para enterarse de que no llegó. */}
        {registro.fallidos.map((f) => (
          <p key={f.login} className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              <span className="font-mono">@{f.login}</span> no recibió el aviso: {f.motivo}
            </span>
          </p>
        ))}
        {registro.avisados.length === 0 && registro.fallidos.length === 0 && (
          <p className="flex items-start gap-1.5 text-muted-foreground">
            <MessageCircleOff className="mt-0.5 h-3 w-3 shrink-0" />
            <span>No hubo a quién avisar.</span>
          </p>
        )}
      </div>
    );
  }

  // Sin registro: o el deploy sigue corriendo, o corrió con una versión del
  // workflow que todavía no anota nada. En los dos casos se habla en futuro.
  if (!avisos || avisos.desconocido) return null;
  if (!avisos.empresaAvisa) {
    return (
      <p className="mt-1.5 flex items-start gap-1.5 border-t pt-1.5 text-amber-600 dark:text-amber-400">
        <MessageCircleOff className="mt-0.5 h-3 w-3 shrink-0" />
        <span>No se avisará por WhatsApp: {avisos.motivoEmpresa}</span>
      </p>
    );
  }
  const fijos = avisos.destinatarios.filter((d) => d.tieneTelefono).map((d) => `@${d.login}`);
  return (
    <p className="mt-1.5 flex items-start gap-1.5 border-t pt-1.5 text-muted-foreground">
      <MessageCircle className="mt-0.5 h-3 w-3 shrink-0" />
      <span>
        {corriendo ? "Al terminar se avisará a" : "Le tocaba el aviso a"}{" "}
        <span className="font-mono">
          {["quien lo disparó", ...fijos].join(", ")}
        </span>
        {!corriendo && " (este deploy no dejó registro)"}
      </span>
    </p>
  );
}
