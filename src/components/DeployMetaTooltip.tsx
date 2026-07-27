import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Rocket, CheckCircle2, GitMerge, Users } from "lucide-react";
import { getDeployMeta, type DeployMeta, type WorkflowRun } from "@/lib/github";

// Caché por sha: el hover repetido no re-consulta GitHub.
const metaCache = new Map<string, DeployMeta>();

/**
 * Envuelve un badge de deploy y muestra, al pasar el puntero, quién lo
 * generó (actor del run), los autores del PR, quién aprobó y quién mergeó.
 * La info se consulta perezosamente en el primer hover.
 */
export function DeployMetaTooltip({ owner, repo, run, children }: {
  owner: string;
  repo: string;
  run: WorkflowRun;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [meta, setMeta] = useState<DeployMeta | null>(
    run.headSha ? metaCache.get(run.headSha) ?? null : null,
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
  };

  const hide = () => {
    hideTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  const cached = run.headSha ? metaCache.get(run.headSha) ?? meta : meta;

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
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
