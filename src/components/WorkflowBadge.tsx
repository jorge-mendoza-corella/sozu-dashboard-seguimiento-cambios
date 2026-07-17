import { useState, useRef, useEffect } from "react";
import { CheckCircle2, XCircle, Loader2, HelpCircle, GitBranch, Rocket, Info, GitCommit, ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkflowRun, PRWithCommits } from "@/lib/github";
import { getDeployPRChain } from "@/lib/github";
import { formatDistanceToNow } from "@/lib/timeUtils";
import { createPortal } from "react-dom";

interface Props {
  run: WorkflowRun;
  owner: string;
  repo: string;
  /** Con valor: el usuario NO tiene permiso "ver cambios de otros" — los PRs
   *  ajenos del deploy se muestran sin título ni commits. */
  selfLogin?: string | null;
}

function getBranchTier(branch: string | null): "main" | "dev" | "other" {
  if (!branch) return "other";
  if (branch === "main") return "main";
  if (branch === "dev") return "dev";
  return "other";
}

export function WorkflowBadge({ run, owner, repo, selfLogin = null }: Props) {
  const isSuccess = run.conclusion === "success";
  const isFailure = run.conclusion === "failure" || run.conclusion === "cancelled";
  const isPending = run.status === "in_progress" || run.status === "queued";
  const tier = getBranchTier(run.headBranch);
  const isMain = tier === "main";

  const [open, setOpen] = useState(false);
  const [prs, setPrs] = useState<PRWithCommits[] | null>(null);
  const [loadingPrs, setLoadingPrs] = useState(false);
  const [expandedPRs, setExpandedPRs] = useState<Set<number>>(new Set());
  const btnRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [popupPos, setPopupPos] = useState({ top: 0, left: 0 });

  /* ── colores por tier × estado ── */
  const stateColors = {
    main: {
      success: "bg-emerald-50 dark:bg-emerald-950/50 border-emerald-400 dark:border-emerald-600 text-emerald-800 dark:text-emerald-200",
      failure: "bg-red-50 dark:bg-red-950/40 border-red-400 dark:border-red-600 text-red-800 dark:text-red-200",
      pending: "bg-emerald-50 dark:bg-emerald-950/50 border-emerald-500 dark:border-emerald-500 text-emerald-800 dark:text-emerald-100",
      unknown: "bg-slate-50 dark:bg-slate-900/40 border-slate-300 dark:border-slate-700 text-slate-600",
    },
    dev: {
      success: "bg-sky-50 dark:bg-sky-950/40 border-sky-300 dark:border-sky-700/60 text-sky-800 dark:text-sky-200",
      failure: "bg-orange-50 dark:bg-orange-950/40 border-orange-300 dark:border-orange-700/60 text-orange-800 dark:text-orange-200",
      pending: "bg-sky-50 dark:bg-sky-950/40 border-sky-400 dark:border-sky-600 text-sky-800 dark:text-sky-200",
      unknown: "bg-slate-50 dark:bg-slate-900/40 border-slate-300 dark:border-slate-700/60 text-slate-600",
    },
    other: {
      success: "bg-zinc-50 dark:bg-zinc-900/40 border-zinc-300 dark:border-zinc-700/60 text-zinc-700 dark:text-zinc-300",
      failure: "bg-zinc-50 dark:bg-zinc-900/40 border-zinc-300 dark:border-zinc-700/60 text-zinc-700 dark:text-zinc-300",
      pending: "bg-zinc-50 dark:bg-zinc-900/40 border-zinc-300 dark:border-zinc-700/60 text-zinc-700 dark:text-zinc-300",
      unknown: "bg-zinc-50 dark:bg-zinc-900/40 border-zinc-300 dark:border-zinc-700/60 text-zinc-500",
    },
  };

  const stateKey = isSuccess ? "success" : isFailure ? "failure" : isPending ? "pending" : "unknown";
  const colorClass = stateColors[tier][stateKey];
  const branchLabel = { main: "PRD", dev: "DEV", other: run.headBranch ?? "?" }[tier];
  const branchChipClass = {
    main: "bg-emerald-600 text-white dark:bg-emerald-700",
    dev:  "bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300",
    other: "bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400",
  }[tier];

  function computePos() {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const popupWidth = 340;
    let left = rect.left;
    if (left + popupWidth > window.innerWidth - 16) {
      left = window.innerWidth - popupWidth - 16;
    }
    setPopupPos({ top: rect.bottom + 6, left });
  }

  async function handleInfoClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    computePos();
    setOpen((prev) => !prev);
    if (prs !== null) return;
    if (!run.headSha) return;
    setLoadingPrs(true);
    try {
      const data = await getDeployPRChain(owner, repo, run.headSha, run.headBranch);
      setPrs(data);
    } catch {
      setPrs([]);
    } finally {
      setLoadingPrs(false);
    }
  }

  /* cerrar al click fuera */
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        popupRef.current && !popupRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function togglePR(num: number) {
    setExpandedPRs((prev) => {
      const next = new Set(prev);
      next.has(num) ? next.delete(num) : next.add(num);
      return next;
    });
  }

  const popup = open ? createPortal(
    <div
      ref={popupRef}
      style={{ position: "fixed", top: popupPos.top, left: popupPos.left, zIndex: 9999, width: 340 }}
      className="rounded-lg border bg-white dark:bg-zinc-900 shadow-xl text-sm overflow-hidden"
    >
      {/* header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-zinc-50 dark:bg-zinc-800">
        <span className="font-semibold text-xs text-zinc-700 dark:text-zinc-200 flex items-center gap-1.5">
          <GitBranch className="h-3 w-3" />
          {run.name} — {branchLabel}
        </span>
        <a
          href={run.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-blue-500 hover:underline flex items-center gap-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          Ver en GitHub <ExternalLink className="h-2.5 w-2.5" />
        </a>
      </div>

      {/* body */}
      <div className="max-h-72 overflow-y-auto">
        {loadingPrs && (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-zinc-500">
            <Loader2 className="h-3 w-3 animate-spin" /> Cargando PRs...
          </div>
        )}
        {!loadingPrs && prs !== null && prs.length === 0 && (
          <p className="px-3 py-3 text-xs text-zinc-400 italic">Sin PRs asociados a este deploy.</p>
        )}
        {!loadingPrs && prs !== null && prs.length > 0 && (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {prs.map((pr) => {
              const expanded = expandedPRs.has(pr.number);
              // Sin permiso "ver cambios de otros": los PRs ajenos se listan
              // sin título, autor ni commits (solo constancia de que existen).
              if (selfLogin && pr.author !== selfLogin) {
                return (
                  <li key={pr.number} className="px-3 py-2">
                    <div className="flex items-center gap-1.5 text-xs text-zinc-400 italic">
                      <span className="font-medium not-italic">#{pr.number}</span>
                      cambios de otro usuario
                    </div>
                  </li>
                );
              }
              return (
                <li key={pr.number} className="px-3 py-2">
                  <button
                    className="w-full flex items-start gap-1.5 text-left group"
                    onClick={() => togglePR(pr.number)}
                  >
                    <span className="mt-0.5 text-zinc-400 dark:text-zinc-500 shrink-0">
                      {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <a
                          href={pr.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 dark:text-blue-400 font-medium hover:underline text-xs"
                          onClick={(e) => e.stopPropagation()}
                        >
                          #{pr.number}
                        </a>
                        <span className="text-xs text-zinc-700 dark:text-zinc-200 truncate">{pr.title}</span>
                      </div>
                      <span className="text-[10px] text-zinc-400">@{pr.author}</span>
                    </div>
                  </button>

                  {expanded && (
                    <ul className="mt-1.5 ml-5 space-y-1">
                      {pr.commits.map((c) => (
                        <li key={c.sha} className="flex items-start gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                          <GitCommit className="h-3 w-3 shrink-0 mt-0.5 text-zinc-400" />
                          <span className="font-mono text-[10px] text-zinc-400 shrink-0">{c.sha}</span>
                          <span className="truncate">{c.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <div className="inline-flex items-center group">
      <a href={run.url} target="_blank" rel="noopener noreferrer" className="no-underline">
        <div
          className={cn(
            "inline-flex items-center gap-1.5 rounded-l-md px-2 py-1 text-xs font-medium transition-opacity group-hover:opacity-80",
            isMain ? "border-y-2 border-l-2" : "border-y border-l",
            colorClass,
            isMain && isPending && "shadow-md shadow-emerald-300/40 dark:shadow-emerald-900/50",
            isMain && isSuccess && "shadow-sm shadow-emerald-200/60",
          )}
        >
          {isMain && isPending  && <Rocket   className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />}
          {!(isMain && isPending) && isSuccess && <CheckCircle2 className="h-3 w-3 shrink-0" />}
          {!(isMain && isPending) && isFailure && <XCircle      className="h-3 w-3 shrink-0" />}
          {!(isMain && isPending) && isPending && <Loader2      className="h-3 w-3 shrink-0 animate-spin" />}
          {!isSuccess && !isFailure && !isPending && <HelpCircle className="h-3 w-3 shrink-0" />}

          <span className="max-w-[110px] truncate">{run.name}</span>

          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded px-1 py-0 text-[9px] font-bold uppercase tracking-wide shrink-0",
              branchChipClass,
            )}
          >
            <GitBranch className="h-2 w-2" />
            {branchLabel}
          </span>

          <span className="text-[10px] opacity-60 shrink-0">{formatDistanceToNow(run.createdAt)}</span>
        </div>
      </a>

      {/* botón info separado */}
      <button
        ref={btnRef}
        onClick={handleInfoClick}
        title="Ver PRs y commits de este deploy"
        className={cn(
          "inline-flex items-center justify-center px-1.5 py-1 text-xs transition-colors",
          "rounded-r-md border",
          isMain ? "border-2" : "border",
          open
            ? "bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200"
            : "bg-zinc-50 dark:bg-zinc-800 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700",
          colorClass.includes("border-emerald") ? "border-emerald-400 dark:border-emerald-600" :
          colorClass.includes("border-red")     ? "border-red-400 dark:border-red-600" :
          colorClass.includes("border-sky")     ? "border-sky-300 dark:border-sky-700/60" :
          colorClass.includes("border-orange")  ? "border-orange-300 dark:border-orange-700/60" :
          "border-zinc-300 dark:border-zinc-700/60",
        )}
      >
        <Info className="h-3 w-3" />
      </button>

      {popup}
    </div>
  );
}
