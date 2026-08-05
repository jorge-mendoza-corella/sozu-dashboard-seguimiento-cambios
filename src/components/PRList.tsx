import { useState, useRef, useEffect } from "react";
import {
  GitPullRequest, GitMerge, Rocket, ArrowRight,
  Clock, CheckCircle, CheckCircle2, XCircle, MessageCircle, Loader2, GitMerge as MergeIcon,
  User, UserCheck, AlertTriangle, GitCommit, ChevronDown, ChevronRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PullRequest, PRWithCommits } from "@/lib/github";
import { submitReview, mergePR, mergeWithBypass, closePR, getMergedDevPRsForRelease, type ApproverAuth } from "@/lib/github";
import { NO_PERMISSIONS, type CicdPermissions } from "@/lib/firestoreUsers";
import { formatDistanceToNow } from "@/lib/timeUtils";

type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
type PanelMode = "review" | "merge" | "close" | "content";

interface Props {
  prs: PullRequest[];
  owner: string;
  repo: string;
  onRefetch?: () => void;
  /** Permisos granulares: crear/cerrar PRs, aprobar, merge a dev/main. */
  perms?: CicdPermissions;
  /** Aprobador configurado del proyecto (firma reviews con SU token). */
  approver?: ApproverAuth | null;
  /** Credenciales de todos los usuarios: firman como CODEOWNER si les toca. */
  codeOwnerAuths?: ApproverAuth[];
  /** Con valor: sin permiso "ver cambios de otros" — detalle ajeno oculto. */
  selfLogin?: string | null;
}

export function PRList({ prs, owner, repo, onRefetch, perms = NO_PERMISSIONS, approver = null, codeOwnerAuths = [], selfLogin = null }: Props) {
  const [openPanel, setOpenPanel] = useState<{ prNumber: number; mode: PanelMode } | null>(null);
  const [activeEvent, setActiveEvent] = useState<ReviewEvent | null>(null);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ prNumber: number; ok: boolean; msg: string } | null>(null);
  const [mergedPRs, setMergedPRs] = useState<Set<number>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);

  // PR chain: PRs de dev incluidos en el PR a main
  const [prChain, setPrChain] = useState<{ prNumber: number; data: PRWithCommits[] | null; loading: boolean } | null>(null);
  const [expandedPRs, setExpandedPRs] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!openPanel || (openPanel.mode !== "review" && openPanel.mode !== "content")) { setPrChain(null); return; }
    const pr = prs.find((p) => p.number === openPanel.prNumber);
    if (!pr || pr.base !== "main") { setPrChain(null); return; }
    setPrChain({ prNumber: pr.number, data: null, loading: true });
    getMergedDevPRsForRelease(owner, repo, pr.number)
      .then((data) => setPrChain({ prNumber: pr.number, data, loading: false }))
      .catch(() => setPrChain({ prNumber: pr.number, data: [], loading: false }));
  }, [openPanel, owner, repo, prs]);

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
      await submitReview(
        owner, repo, pr.number, event, comment.trim(), approver ?? undefined,
        codeOwnerAuths, pr.author,
      );
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

  const handleClose = async (pr: PullRequest) => {
    setLoading(true);
    try {
      await closePR(owner, repo, pr.number);
      setMergedPRs((prev) => new Set([...prev, pr.number])); // oculta botones de inmediato
      setResult({ prNumber: pr.number, ok: true, msg: `PR #${pr.number} cerrado sin merge` });
      setTimeout(() => { closePanel(); onRefetch?.(); }, 2000);
    } catch (e) {
      setResult({
        prNumber: pr.number,
        ok: false,
        msg: e instanceof Error ? e.message : "Error al cerrar el PR",
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
        await mergeWithBypass(
          owner, repo, pr.number, pr.author, approver ?? undefined,
          pr.reviewDecision === "APPROVED",
          codeOwnerAuths,
        );
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
        // Sin aprobación vigente y sin reviewer solicitado (rd === null) antes
        // no se pintaba nada: pasa siempre que main/dev tienen
        // "dismiss stale approvals" y un merge a la base descarta la
        // aprobación del PR, dejándolo sin forma de volver a aprobarse.
        const needsApproval = rd === null && !pr.draft;
        const hasAnyReviewBadge = hasPendingReview || isApproved || hasChangesReq || needsApproval;
        const hasConflict = pr.hasConflict;

        // main: merge solo si aprobado | non-main: merge solo si aún no aprobado
        // mergedPRs oculta el botón de inmediato tras confirmar el merge
        // Permiso por rama destino: main requiere mergeMain; el resto, mergeDev.
        const hasMergePerm = isToMain ? perms.mergeMain : perms.mergeDev;
        // A main solo se mergea con aprobación. A las demás ramas siempre se
        // puede: antes se exigía que NO estuviera aprobado y el botón
        // desaparecía justo al aprobar el PR, dejándolo sin salida.
        const canMerge = hasMergePerm && !mergedPRs.has(pr.number) && (!isToMain || isApproved);
        const canClose = perms.createPR && !mergedPRs.has(pr.number);

        const isPanelOpen  = openPanel?.prNumber === pr.number;
        const isReviewOpen = isPanelOpen && openPanel?.mode === "review";
        const isMergeOpen  = isPanelOpen && openPanel?.mode === "merge";
        const isCloseOpen  = isPanelOpen && openPanel?.mode === "close";
        const isContentOpen = isPanelOpen && openPanel?.mode === "content";

        return (
          <div key={pr.number} className="relative">
            <div
              className={cn(
                "flex flex-wrap items-start gap-2 p-2 rounded-md transition-colors",
                hasConflict
                  ? "bg-orange-50 dark:bg-orange-950/30 border border-orange-400 dark:border-orange-600/60"
                  : isToMain
                    ? "bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-700/60"
                    : isDev
                      ? "bg-sky-50/60 dark:bg-sky-950/20 border border-sky-200 dark:border-sky-800/40"
                      : "border border-transparent hover:bg-muted/50",
                !hasConflict && hasPendingReview && "ring-1 ring-amber-300 dark:ring-amber-700/60",
                !hasConflict && isApproved && "ring-1 ring-green-300 dark:ring-green-700/60",
                !hasConflict && hasChangesReq && "ring-1 ring-red-300 dark:ring-red-700/60",
                hasConflict && "ring-2 ring-orange-400 dark:ring-orange-500/70",
              )}
            >
              {/* Área principal → abre GitHub */}
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2 flex-1 basis-full sm:basis-40 min-w-0 no-underline group"
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
              <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto">
                {hasConflict && (
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border bg-orange-100 text-orange-700 border-orange-300 hover:bg-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-700/60"
                    title="Este PR tiene conflictos — resuélvelos en GitHub"
                  >
                    <AlertTriangle className="h-2.5 w-2.5" />
                    Resolver conflictos
                  </a>
                )}
                {isToMain && (
                  <Badge className="text-[9px] py-0 px-1.5 bg-emerald-600 text-white border-emerald-700 dark:bg-emerald-700 dark:border-emerald-600 font-bold tracking-wide">
                    → PRD
                  </Badge>
                )}
                {isToMain && (
                  <button
                    onClick={() => togglePanel(pr.number, "content")}
                    title="Ver qué PRs y commits incluye este release"
                    className={cn(
                      "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border",
                      "bg-indigo-100 text-indigo-700 border-indigo-300 hover:bg-indigo-200",
                      "dark:bg-indigo-900/40 dark:text-indigo-300 dark:border-indigo-700/60 dark:hover:bg-indigo-900/60",
                      isContentOpen && "ring-1 ring-current",
                    )}
                  >
                    <GitCommit className="h-2.5 w-2.5" />
                    Contenido
                  </button>
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
                  ) : !perms.approve ? (
                    needsApproval ? null : (
                    <span
                      className={cn(
                        "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border",
                        hasPendingReview && "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60",
                        hasChangesReq && "bg-red-100 text-red-700 border-red-300 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700/60",
                      )}
                    >
                      {hasPendingReview && <Clock className="h-2.5 w-2.5" />}
                      {hasChangesReq && <XCircle className="h-2.5 w-2.5" />}
                      {hasPendingReview ? "Review" : "Cambios"}
                    </span>
                    )
                  ) : (
                    <button
                      onClick={() => togglePanel(pr.number, "review")}
                      title={
                        hasPendingReview
                          ? `Review solicitada a: ${pr.requestedReviewers.join(", ")}`
                          : hasChangesReq
                            ? "Cambios solicitados"
                            : "Sin aprobación vigente. Si ya lo habías aprobado, un merge a la rama destino la descartó (dismiss stale approvals)."
                      }
                      className={cn(
                        "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border",
                        hasPendingReview && "bg-amber-100 text-amber-700 border-amber-300 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60",
                        hasChangesReq && "bg-red-100 text-red-700 border-red-300 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700/60",
                        needsApproval && "bg-muted text-muted-foreground border-border hover:bg-muted/70",
                        isReviewOpen && "ring-1 ring-current",
                      )}
                    >
                      {hasPendingReview && <Clock className="h-2.5 w-2.5" />}
                      {hasChangesReq && <XCircle className="h-2.5 w-2.5" />}
                      {needsApproval && <CheckCircle className="h-2.5 w-2.5" />}
                      {hasPendingReview ? "Review" : hasChangesReq ? "Cambios" : "Aprobar"}
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

                {/* Botón de cerrar sin merge */}
                {canClose && (
                  <button
                    onClick={() => togglePanel(pr.number, "close")}
                    title={`Cerrar PR #${pr.number} sin merge`}
                    className={cn(
                      "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border",
                      "bg-red-50 text-red-600 border-red-200 hover:bg-red-100",
                      "dark:bg-red-900/30 dark:text-red-300 dark:border-red-800/60 dark:hover:bg-red-900/50",
                      isCloseOpen && "ring-1 ring-red-500 dark:ring-red-400",
                    )}
                  >
                    <XCircle className="h-2.5 w-2.5" />
                    Cerrar
                  </button>
                )}
              </div>
            </div>

            {/* Panel de review */}
            {isReviewOpen && (
              <div
                ref={panelRef}
                className={cn("absolute right-0 top-full mt-1 z-50 rounded-lg border bg-background shadow-xl p-3", isToMain ? "w-80" : "w-72")}
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

                    {/* PR chain: PRs de dev incluidos en este release */}
                    {isToMain && prChain?.prNumber === pr.number && (
                      <div className="mt-3 pt-3 border-t border-border/60">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1">
                          <GitMerge className="h-3 w-3" />
                          PRs en este release
                        </p>

                        {prChain.loading ? (
                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-1">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Cargando cambios...
                          </div>
                        ) : prChain.data && prChain.data.length > 0 ? (
                          <div className="space-y-1.5 max-h-60 overflow-y-auto pr-0.5">
                            {prChain.data.map((devPR) => {
                              if (selfLogin && devPR.author !== selfLogin) {
                                return (
                                  <div key={devPR.number} className="rounded border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px] italic text-muted-foreground">
                                    <span className="font-medium not-italic">#{devPR.number}</span> — cambios de otro usuario
                                  </div>
                                );
                              }
                              const isExpanded = expandedPRs.has(devPR.number);
                              return (
                                <div key={devPR.number} className="rounded border border-border/60 bg-muted/30 overflow-hidden">
                                  <button
                                    onClick={() => setExpandedPRs((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(devPR.number)) next.delete(devPR.number);
                                      else next.add(devPR.number);
                                      return next;
                                    })}
                                    className="w-full flex items-start gap-1.5 px-2 py-1.5 text-left hover:bg-muted/60 transition-colors"
                                  >
                                    {isExpanded
                                      ? <ChevronDown className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
                                      : <ChevronRight className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />}
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-1 flex-wrap">
                                        <a
                                          href={devPR.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          onClick={(e) => e.stopPropagation()}
                                          className="text-[11px] font-semibold text-foreground hover:underline truncate"
                                        >
                                          #{devPR.number}
                                        </a>
                                        <span className="text-[11px] text-foreground truncate">{devPR.title}</span>
                                      </div>
                                      <div className="flex items-center gap-1 mt-0.5">
                                        <User className="h-2.5 w-2.5 text-muted-foreground" />
                                        <span className="text-[10px] text-muted-foreground font-mono">{devPR.author}</span>
                                        <span className="text-[10px] text-muted-foreground">·</span>
                                        <GitCommit className="h-2.5 w-2.5 text-muted-foreground" />
                                        <span className="text-[10px] text-muted-foreground">{devPR.commits.length} commit{devPR.commits.length !== 1 ? "s" : ""}</span>
                                      </div>
                                    </div>
                                  </button>

                                  {isExpanded && (
                                    <div className="border-t border-border/40 bg-muted/20 px-2 py-1.5 space-y-1">
                                      {devPR.commits.map((c) => (
                                        <div key={c.sha} className="flex items-start gap-1.5">
                                          <span className="font-mono text-[10px] text-violet-600 dark:text-violet-400 shrink-0 mt-0.5">{c.sha}</span>
                                          <span className="text-[10px] text-foreground/80 leading-snug break-words">{c.message}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-[11px] text-muted-foreground italic">
                            No se detectaron PRs de dev (commits directos o squash).
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Panel de contenido del release (dev→main): PRs incluidos + commits */}
            {isContentOpen && (
              <div
                ref={panelRef}
                className="absolute right-0 top-full mt-1 z-50 w-80 rounded-lg border bg-background shadow-xl p-3"
              >
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1">
                  <GitMerge className="h-3 w-3" />
                  Contenido del release · PR #{pr.number}
                </p>
                {prChain?.prNumber !== pr.number || prChain.loading ? (
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Cargando cambios...
                  </div>
                ) : prChain.data && prChain.data.length > 0 ? (
                  <div className="space-y-1.5 max-h-72 overflow-y-auto pr-0.5">
                    {prChain.data.map((devPR) => {
                      if (selfLogin && devPR.author !== selfLogin) {
                        return (
                          <div key={devPR.number} className="rounded border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px] italic text-muted-foreground">
                            <span className="font-medium not-italic">#{devPR.number}</span> — cambios de otro usuario
                          </div>
                        );
                      }
                      const isExpanded = expandedPRs.has(devPR.number);
                      return (
                        <div key={devPR.number} className="rounded border border-border/60 bg-muted/30 overflow-hidden">
                          <button
                            onClick={() => setExpandedPRs((prev) => {
                              const next = new Set(prev);
                              if (next.has(devPR.number)) next.delete(devPR.number);
                              else next.add(devPR.number);
                              return next;
                            })}
                            className="w-full flex items-start gap-1.5 px-2 py-1.5 text-left hover:bg-muted/60 transition-colors"
                          >
                            {isExpanded
                              ? <ChevronDown className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
                              : <ChevronRight className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1 flex-wrap">
                                <a
                                  href={devPR.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-[11px] font-semibold text-foreground hover:underline truncate"
                                >
                                  #{devPR.number}
                                </a>
                                <span className="text-[11px] text-foreground truncate">{devPR.title}</span>
                              </div>
                              <div className="flex items-center gap-1 mt-0.5">
                                <User className="h-2.5 w-2.5 text-muted-foreground" />
                                <span className="text-[10px] text-muted-foreground font-mono">{devPR.author}</span>
                                <span className="text-[10px] text-muted-foreground">·</span>
                                <GitCommit className="h-2.5 w-2.5 text-muted-foreground" />
                                <span className="text-[10px] text-muted-foreground">{devPR.commits.length} commit{devPR.commits.length !== 1 ? "s" : ""}</span>
                              </div>
                            </div>
                          </button>
                          {isExpanded && (
                            <div className="border-t border-border/40 bg-muted/20 px-2 py-1.5 space-y-1">
                              {devPR.commits.map((c) => (
                                <div key={c.sha} className="flex items-start gap-1.5">
                                  <span className="font-mono text-[10px] text-violet-600 dark:text-violet-400 shrink-0 mt-0.5">{c.sha}</span>
                                  <span className="text-[10px] text-foreground/80 leading-snug break-words">{c.message}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground italic">
                    No se detectaron PRs de dev (commits directos o squash).
                  </p>
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
            {/* Panel de cierre sin merge con confirmación */}
            {isCloseOpen && (
              <div
                ref={panelRef}
                className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg border bg-background shadow-xl p-3"
              >
                <div className="flex items-center gap-2 mb-2">
                  <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                  <span className="text-xs font-semibold">Cerrar sin merge · PR #{pr.number}</span>
                </div>

                <p className="text-[11px] text-muted-foreground mb-3">
                  <span className="font-mono font-semibold text-foreground">{pr.head}</span>
                  {" → "}
                  <span className="font-mono font-semibold text-foreground">{pr.base}</span>
                  {" "}· los cambios NO se integrarán.
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
                      onClick={() => handleClose(pr)}
                      disabled={loading}
                      className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                    >
                      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                      Cerrar PR
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
