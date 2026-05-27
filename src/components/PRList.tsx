import { useState, useRef, useEffect } from "react";
import {
  GitPullRequest, GitMerge, Rocket, ArrowRight,
  Clock, CheckCircle, CheckCircle2, XCircle, MessageCircle, Loader2, GitMerge as MergeIcon,
  User, UserCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PullRequest } from "@/lib/github";
import { submitReview, mergePR, mergeWithBypass } from "@/lib/github";
import { formatDistanceToNow } from "@/lib/timeUtils";

type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
type PanelMode = "review" | "merge";

interface Props {
  prs: PullRequest[];
  owner: string;
  repo: string;
  onRefetch?: () => void;
}

export function PRList({ prs, owner, repo, onRefetch }: Props) {
  const [openPanel, setOpenPanel] = useState<{ prNumber: number; mode: PanelMode } | null>(null);
  const [activeEvent, setActiveEvent] = useState<ReviewEvent | null>(null);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ prNumber: number; ok: boolean; msg: string } | null>(null);
  const [mergedPRs, setMergedPRs] = useState<Set<number>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        closePanel();
      }
    };
    if (openPanel !== null) document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [openPanel]);

  const closePanel = () => {
    setOpenPanel(null);
    setActiveEvent(null);
    setComment("");
    setResult(null);
  };

  const togglePanel = (prNumber: number, mode: PanelMode) => {
    if (openPanel?.prNumber === prNumber && openPanel.mode === mode) {
      closePanel();
    } else {
      setOpenPanel({ prNumber, mode });
      setActiveEvent(null);
      setComment("");
      setResult(null);
    }
  };

  const handleReview = async (pr: PullRequest, event: ReviewEvent) => {
    if ((event === "REQUEST_CHANGES" || event === "COMMENT") && !comment.trim()) return;
    setLoading(true);
    try {
      await submitReview(owner, repo, pr.number, event, comment.trim());
      setResult({
        prNumber: pr.number,
        ok: true,
        msg: event === "APPROVE" ? "¡Aprobado!" : "Enviado correctamente",
      });
      setTimeout(() => { closePanel(); onRefetch?.(); }, 2000);
    } catch (e) {
      setResult({
        prNumber: pr.number,
        ok: false,
        msg: e instanceof Error ? e.message : "Error al enviar la revisión",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleMerge = async (pr: PullRequest) => {
    setLoading(true);
    try {
      // PRs a main requieren aprobación real previa — merge directo.
      // PRs a otras ramas usan bypass: auto-aprueba (reviewer token) + merge.
      if (pr.base === "main") {
        await mergePR(owner, repo, pr.number, "merge");
      } else {
        await mergeWithBypass(owner, repo, pr.number, pr.author);
      }
      setMergedPRs((prev) => new Set([...prev, pr.number]));
      setResult({ prNumber: pr.number, ok: true, msg: `Merge completado · ${pr.head} → ${pr.base}` });
      setTimeout(() => { closePanel(); onRefetch?.(); }, 2000);
    } catch (e) {
      setResult({
        prNumber: pr.number,
        ok: false,
        msg: e instanceof Error ? e.message : "Error al hacer merge",
      });
    } finally {
      setLoading(false);
    }
  };

  if (prs.length === 0) return <p className="text-xs text-muted-foreground py-2">Sin PRs abiertos</p>;

  const toMain = prs.filter((p) => p.base === "main");
  const rest   = prs.filter((p) => p.base !== "main");
  const sorted = [...toMain, ...rest];

  return (
    <div className="space-y-1.5">
      {sorted.map((pr) => {
        const isToMain = pr.base === "main";
        const isDev    = pr.base === "dev";
        const rd = pr.reviewDecision;
        const hasPendingReview = rd === "REVIEW_REQUIRED";
        const isApproved       = rd === "APPROVED";
        const hasChangesReq    = rd === "CHANGES_REQUESTED";
        const hasAnyReviewBadge = hasPendingReview || isApproved || hasChangesReq;

        // main: merge solo si aprobado | non-main: merge solo si aún no aprobado
        // mergedPRs oculta el botón de inmediato tras confirmar el merge
        const canMerge = !mergedPRs.has(pr.number) && (isToMain ? isApproved : !isApproved);

        const isPanelOpen  = openPanel?.prNumber === pr.number;
        const isReviewOpen = isPanelOpen && openPanel?.mode === "review";
        const isMergeOpen  = isPanelOpen && openPanel?.mode === "merge";

        return (
          <div key={pr.number} className="relative">
            <div
              className={cn(
                "flex items-start gap-2 p-2 rounded-md transition-colors",
                isToMain
                  ? "bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-700/60"
                  : isDev
                    ? "bg-sky-50/60 dark:bg-sky-950/20 border border-sky-200 dark:border-sky-800/40"
                    : "border border-transparent hover:bg-muted/50",
                hasPendingReview && "ring-1 ring-amber-300 dark:ring-amber-700/60",
                isApproved && "ring-1 ring-green-300 dark:ring-green-700/60",
                hasChangesReq && "ring-1 ring-red-300 dark:ring-red-700/60",
              )}
            >
              {/* Área principal → abre GitHub */}
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2 flex-1 min-w-0 no-underline group"
              >
                {isToMain ? (
                  <Rocket className="h-3.5 w-3.5 mt-0.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                ) : pr.draft ? (
                  <GitPullRequest className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                ) : (
                  <GitMerge className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", isDev ? "text-sky-600 dark:text-sky-400" : "text-violet-600")} />
                )}

                <div className="flex-1 min-w-0">
                  <p className={cn(
                    "text-sm truncate group-hover:text-primary",
                    isToMain ? "font-semibold text-emerald-900 dark:text-emerald-100" : "font-medium",
                  )}>
                    {pr.title}
                  </p>
                  <div className="flex items-center gap-1 text-xs mt-0.5 flex-wrap">
                    <span className={cn("font-mono", isToMain ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
                      {pr.head}
                    </span>
                    <ArrowRight className={cn("h-2.5 w-2.5 shrink-0", isToMain ? "text-emerald-500" : "text-muted-foreground")} />
                    <span className={cn(
                      "font-mono font-semibold",
                      isToMain ? "text-emerald-700 dark:text-emerald-300" : isDev ? "text-sky-600 dark:text-sky-400" : "text-muted-foreground",
                    )}>
                      {pr.base}
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{formatDistanceToNow(pr.createdAt)}</span>
                  </div>
                  {/* Autor y reviewers */}
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {pr.author && (
                      <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                        <User className="h-2.5 w-2.5" />
                        <span className="font-mono">{pr.author}</span>
                      </span>
                    )}
                    {pr.requestedReviewers.length > 0 && (
                      <span className="flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                        <UserCheck className="h-2.5 w-2.5" />
                        {pr.requestedReviewers.map((r) => (
                          <span key={r} className="font-mono">{r}</span>
                        ))}
                      </span>
                    )}
                    {pr.reviewDecision === "APPROVED" && (
                      <span className="flex items-center gap-0.5 text-[10px] text-green-600 dark:text-green-400">
                        <UserCheck className="h-2.5 w-2.5" />
                        <span>aprobado</span>
                      </span>
                    )}
                  </div>
                </div>
              </a>

              {/* Badges — fuera del enlace */}
              <div className="flex items-center gap-1 shrink-0">
                {isToMain && (
                  <Badge className="text-[9px] py-0 px-1.5 bg-emerald-600 text-white border-emerald-700 dark:bg-emerald-700 dark:border-emerald-600 font-bold tracking-wide">
                    → PRD
                  </Badge>
                )}
                {isDev && !pr.draft && (
                  <Badge className="text-[9px] py-0 px-1.5 bg-sky-100 text-sky-700 border-sky-300 dark:bg-sky-900/50 dark:text-sky-300 dark:border-sky-700/50">
                    → DEV
                  </Badge>
                )}
                {pr.draft && <Badge variant="outline" className="text-[10px]">Draft</Badge>}

                {/* Badge de estado de review */}
                {hasAnyReviewBadge && (
                  isApproved ? (
                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border bg-green-100 text-green-700 border-green-300 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/60">
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      Aprobado
                    </span>
                  ) : (
                    <button
                      onClick={() => togglePanel(pr.number, "review")}
                      title={hasPendingReview ? `Review solicitada a: ${pr.requestedReviewers.join(", ")}` : "Cambios solicitados"}
                      className={cn(
                        "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border",
                        hasPendingReview && "bg-amber-100 text-amber-700 border-amber-300 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60",
                        hasChangesReq && "bg-red-100 text-red-700 border-red-300 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700/60",
                        isReviewOpen && "ring-1 ring-current",
                      )}
                    >
                      {hasPendingReview && <Clock className="h-2.5 w-2.5" />}
                      {hasChangesReq && <XCircle className="h-2.5 w-2.5" />}
                      {hasPendingReview ? "Review" : "Cambios"}
                    </button>
                  )
                )}

                {/* Botón de merge */}
                {canMerge && (
                  <button
                    onClick={() => togglePanel(pr.number, "merge")}
                    title={`Hacer merge de PR #${pr.number}`}
                    className={cn(
                      "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border",
                      "bg-violet-100 text-violet-700 border-violet-300 hover:bg-violet-200",
                      "dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-700/60 dark:hover:bg-violet-900/60",
                      isMergeOpen && "ring-1 ring-violet-500 dark:ring-violet-400",
                    )}
                  >
                    <MergeIcon className="h-2.5 w-2.5" />
                    Merge
                  </button>
                )}
              </div>
            </div>

            {/* Panel de review */}
            {isReviewOpen && (
              <div
                ref={panelRef}
                className="absolute right-0 top-full mt-1 z-50 w-72 rounded-lg border bg-background shadow-xl p-3"
              >
                <div className="flex items-center gap-2 mb-2">
                  {hasPendingReview && <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
                  {isApproved && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />}
                  {hasChangesReq && <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                  <span className="text-xs font-semibold">
                    {hasPendingReview ? "Revisión pendiente" : isApproved ? "PR aprobado" : "Cambios solicitados"} · PR #{pr.number}
                  </span>
                </div>

                {pr.requestedReviewers.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {pr.requestedReviewers.map((r) => (
                      <span key={r} className="inline-flex items-center gap-0.5 text-[11px] bg-muted rounded px-1.5 py-0.5 font-mono">
                        <span className="text-muted-foreground">@</span>{r}
                      </span>
                    ))}
                  </div>
                )}

                {result?.prNumber === pr.number ? (
                  <div className={cn(
                    "flex items-center gap-2 p-2 rounded text-sm font-medium",
                    result.ok ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                              : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
                  )}>
                    {result.ok ? <CheckCircle className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                    {result.msg}
                  </div>
                ) : activeEvent === "REQUEST_CHANGES" || activeEvent === "COMMENT" ? (
                  <div className="space-y-2">
                    <textarea
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder={activeEvent === "REQUEST_CHANGES" ? "Describe qué cambios se necesitan..." : "Escribe tu comentario..."}
                      className="w-full text-xs rounded border bg-muted/30 p-2 resize-none h-20 focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleReview(pr, activeEvent)}
                        disabled={loading || !comment.trim()}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded transition-colors",
                          activeEvent === "REQUEST_CHANGES"
                            ? "bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300"
                            : "bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-900/40 dark:text-sky-300",
                          "disabled:opacity-50 disabled:cursor-not-allowed",
                        )}
                      >
                        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                        {activeEvent === "REQUEST_CHANGES" ? "Solicitar cambios" : "Comentar"}
                      </button>
                      <button
                        onClick={() => { setActiveEvent(null); setComment(""); }}
                        disabled={loading}
                        className="px-3 text-xs text-muted-foreground hover:text-foreground py-1.5 rounded hover:bg-muted transition-colors"
                      >
                        Atrás
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-[11px] text-muted-foreground mb-2">
                      Actuar como <span className="font-mono font-semibold text-foreground">jorge-mendoza-corella</span>:
                    </p>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => handleReview(pr, "APPROVE")}
                        disabled={loading}
                        className="flex-1 flex items-center justify-center gap-1 text-xs font-medium py-1.5 rounded bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/40 dark:text-green-300 disabled:opacity-50 transition-colors"
                      >
                        {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                        Aprobar
                      </button>
                      <button
                        onClick={() => setActiveEvent("REQUEST_CHANGES")}
                        disabled={loading}
                        className="flex-1 flex items-center justify-center gap-1 text-xs font-medium py-1.5 rounded bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300 disabled:opacity-50 transition-colors"
                      >
                        <XCircle className="h-3 w-3" />
                        Cambios
                      </button>
                      <button
                        onClick={() => setActiveEvent("COMMENT")}
                        disabled={loading}
                        className="flex-1 flex items-center justify-center gap-1 text-xs font-medium py-1.5 rounded bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-900/40 dark:text-sky-300 disabled:opacity-50 transition-colors"
                      >
                        <MessageCircle className="h-3 w-3" />
                        Comentar
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Panel de merge con confirmación */}
            {isMergeOpen && (
              <div
                ref={panelRef}
                className="absolute right-0 top-full mt-1 z-50 w-60 rounded-lg border bg-background shadow-xl p-3"
              >
                <div className="flex items-center gap-2 mb-2">
                  <MergeIcon className="h-3.5 w-3.5 text-violet-500 shrink-0" />
                  <span className="text-xs font-semibold">Confirmar merge · PR #{pr.number}</span>
                </div>

                <p className="text-[11px] text-muted-foreground mb-3">
                  <span className="font-mono font-semibold text-foreground">{pr.head}</span>
                  {" → "}
                  <span className="font-mono font-semibold text-foreground">{pr.base}</span>
                </p>

                {result?.prNumber === pr.number ? (
                  <div className={cn(
                    "flex items-center gap-2 p-2 rounded text-xs font-medium",
                    result.ok ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                              : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
                  )}>
                    {result.ok ? <CheckCircle className="h-3.5 w-3.5 shrink-0" /> : <XCircle className="h-3.5 w-3.5 shrink-0" />}
                    {result.msg}
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleMerge(pr)}
                      disabled={loading}
                      className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-colors"
                    >
                      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <MergeIcon className="h-3 w-3" />}
                      Hacer merge
                    </button>
                    <button
                      onClick={closePanel}
                      disabled={loading}
                      className="px-3 text-xs text-muted-foreground hover:text-foreground py-1.5 rounded hover:bg-muted transition-colors"
                    >
                      Cancelar
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
