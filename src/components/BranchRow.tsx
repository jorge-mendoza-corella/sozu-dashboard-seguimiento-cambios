import { GitBranch, ArrowUpCircle, EyeOff, Eye, GitPullRequest, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { BranchInfo } from "@/lib/github";

interface Props {
  branch: BranchInfo;
  hasPR?: boolean;
  onHide?: () => void;
  onUnhide?: () => void;
  onCreatePR?: () => void;
  alwaysShowCreatePR?: boolean;
}

export function BranchRow({ branch, hasPR, onHide, onUnhide, onCreatePR, alwaysShowCreatePR }: Props) {
  const isMain = branch.name === "main";
  const isDev = branch.name === "dev";
  const isHidden = !!onUnhide;

  const aheadOfDev = !isDev && !isMain ? branch.aheadOfDev : 0;
  const aheadOfMain = !isMain ? branch.aheadOfMain : 0;

  return (
    <div
      className={cn(
        "group flex items-center gap-2 py-1.5 border-b last:border-0 rounded-sm px-1 -mx-1 transition-colors",
        hasPR && !isHidden && "bg-amber-50 dark:bg-amber-950/20",
        isHidden && "opacity-50",
      )}
    >
      <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span
        className={cn(
          "text-sm font-mono flex-1 truncate",
          isMain && "text-green-700 dark:text-green-500 font-semibold",
          isDev && "text-blue-700 dark:text-blue-400 font-semibold",
        )}
      >
        {branch.name}
      </span>
      <span className="text-xs font-mono text-muted-foreground">{branch.lastCommitSha}</span>

      {/* Etiquetas de identidad */}
      {isMain && <Badge variant="success" className="text-[10px]">PRD</Badge>}
      {isDev && <Badge variant="info" className="text-[10px]">DEV</Badge>}

      {/* PR abierto en esta rama */}
      {hasPR && (
        <Badge variant="warning" className="flex items-center gap-0.5 text-[10px]">
          <GitPullRequest className="h-2.5 w-2.5" />
          PR
        </Badge>
      )}

      {/* Commits por delante — informacional, color neutro */}
      {aheadOfDev > 0 && (
        <Badge variant="outline" className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
          <ArrowUpCircle className="h-2.5 w-2.5" />
          {aheadOfDev} vs dev
        </Badge>
      )}
      {aheadOfMain > 0 && (
        <Badge variant="outline" className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
          <ArrowUpCircle className="h-2.5 w-2.5" />
          {aheadOfMain} vs main
        </Badge>
      )}

      {/* Crear PR */}
      {onCreatePR && (
        <button
          onClick={onCreatePR}
          className={cn(
            "flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium border transition-all",
            "bg-violet-50 text-violet-600 border-violet-200 hover:bg-violet-100",
            "dark:bg-violet-900/20 dark:text-violet-400 dark:border-violet-800/50 dark:hover:bg-violet-900/40",
            alwaysShowCreatePR ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          title={`Crear PR desde ${branch.name} → ${isDev ? "main" : "dev"}`}
        >
          <Plus className="h-2.5 w-2.5" />
          {isDev ? "PR → main" : "PR"}
        </button>
      )}

      {onHide && (
        <button
          onClick={onHide}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-all"
          title="Ocultar rama"
        >
          <EyeOff className="h-3.5 w-3.5" />
        </button>
      )}
      {onUnhide && (
        <button
          onClick={onUnhide}
          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-all"
          title="Mostrar rama"
        >
          <Eye className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
