import { CheckCircle2, XCircle, Clock, HelpCircle, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkflowRun } from "@/lib/github";
import { formatDistanceToNow } from "@/lib/timeUtils";

interface Props { run: WorkflowRun }

function getBranchTier(branch: string | null): "main" | "dev" | "other" {
  if (!branch) return "other";
  if (branch === "main") return "main";
  if (branch === "dev") return "dev";
  return "other";
}

export function WorkflowBadge({ run }: Props) {
  const isSuccess = run.conclusion === "success";
  const isFailure = run.conclusion === "failure" || run.conclusion === "cancelled";
  const isPending = run.status === "in_progress" || run.status === "queued";
  const tier = getBranchTier(run.headBranch);

  const stateColors = {
    main: {
      success: "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700/60 text-emerald-800 dark:text-emerald-200",
      failure: "bg-red-50 dark:bg-red-950/40 border-red-300 dark:border-red-700/60 text-red-800 dark:text-red-200",
      pending: "bg-blue-50 dark:bg-blue-950/40 border-blue-300 dark:border-blue-700/60 text-blue-800 dark:text-blue-200",
      unknown: "bg-slate-50 dark:bg-slate-900/40 border-slate-300 dark:border-slate-700/60 text-slate-700 dark:text-slate-300",
    },
    dev: {
      success: "bg-sky-50 dark:bg-sky-950/40 border-sky-300 dark:border-sky-700/60 text-sky-800 dark:text-sky-200",
      failure: "bg-orange-50 dark:bg-orange-950/40 border-orange-300 dark:border-orange-700/60 text-orange-800 dark:text-orange-200",
      pending: "bg-violet-50 dark:bg-violet-950/40 border-violet-300 dark:border-violet-700/60 text-violet-800 dark:text-violet-200",
      unknown: "bg-slate-50 dark:bg-slate-900/40 border-slate-300 dark:border-slate-700/60 text-slate-600 dark:text-slate-400",
    },
    other: {
      success: "bg-zinc-50 dark:bg-zinc-900/40 border-zinc-300 dark:border-zinc-700/60 text-zinc-700 dark:text-zinc-300",
      failure: "bg-zinc-50 dark:bg-zinc-900/40 border-zinc-300 dark:border-zinc-700/60 text-zinc-700 dark:text-zinc-300",
      pending: "bg-zinc-50 dark:bg-zinc-900/40 border-zinc-300 dark:border-zinc-700/60 text-zinc-700 dark:text-zinc-300",
      unknown: "bg-zinc-50 dark:bg-zinc-900/40 border-zinc-300 dark:border-zinc-700/60 text-zinc-500 dark:text-zinc-500",
    },
  };

  const stateKey = isSuccess ? "success" : isFailure ? "failure" : isPending ? "pending" : "unknown";
  const colorClass = stateColors[tier][stateKey];

  const branchLabel = {
    main: "PRD",
    dev: "DEV",
    other: run.headBranch ?? "?",
  }[tier];

  const branchChipClass = {
    main: "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300",
    dev: "bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300",
    other: "bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400",
  }[tier];

  return (
    <a href={run.url} target="_blank" rel="noopener noreferrer" className="no-underline group">
      <div
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-opacity group-hover:opacity-80",
          colorClass,
          tier === "main" && "shadow-sm",
        )}
      >
        {/* Ícono de estado */}
        {isSuccess && <CheckCircle2 className="h-3 w-3 shrink-0" />}
        {isFailure && <XCircle className="h-3 w-3 shrink-0" />}
        {isPending && <Clock className="h-3 w-3 shrink-0 animate-spin" />}
        {!isSuccess && !isFailure && !isPending && <HelpCircle className="h-3 w-3 shrink-0" />}

        {/* Nombre del workflow */}
        <span className="max-w-[110px] truncate">{run.name}</span>

        {/* Chip de rama */}
        {run.headBranch && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded px-1 py-0 text-[9px] font-semibold uppercase tracking-wide shrink-0",
              branchChipClass,
            )}
          >
            <GitBranch className="h-2 w-2" />
            {branchLabel}
          </span>
        )}

        {/* Tiempo */}
        <span className="text-[10px] opacity-60 shrink-0">{formatDistanceToNow(run.createdAt)}</span>
      </div>
    </a>
  );
}
