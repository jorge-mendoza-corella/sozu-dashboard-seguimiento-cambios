import { GitBranch, ArrowUpCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { BranchInfo } from "@/lib/github";

interface Props { branch: BranchInfo }

export function BranchRow({ branch }: Props) {
  const isMain = branch.name === "main";
  const isDev = branch.name === "dev";
  const hasUnmergedToMain = !isMain && branch.aheadOfMain > 0;
  const hasUnmergedToDev = !isDev && !isMain && branch.aheadOfDev > 0;

  return (
    <div className="flex items-center gap-2 py-1.5 border-b last:border-0">
      <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className={`text-sm font-mono flex-1 truncate ${isMain ? "text-green-700 font-semibold" : isDev ? "text-blue-700 font-semibold" : ""}`}>
        {branch.name}
      </span>
      <span className="text-xs font-mono text-muted-foreground">{branch.lastCommitSha}</span>
      {isMain && <Badge variant="success" className="text-[10px]">PRD</Badge>}
      {isDev && <Badge variant="info" className="text-[10px]">DEV</Badge>}
      {hasUnmergedToMain && (
        <Badge variant="warning" className="flex items-center gap-0.5 text-[10px]">
          <ArrowUpCircle className="h-2.5 w-2.5" />
          {branch.aheadOfMain} → main
        </Badge>
      )}
      {hasUnmergedToDev && (
        <Badge variant="outline" className="flex items-center gap-0.5 text-[10px]">
          <ArrowUpCircle className="h-2.5 w-2.5" />
          {branch.aheadOfDev} → dev
        </Badge>
      )}
    </div>
  );
}
