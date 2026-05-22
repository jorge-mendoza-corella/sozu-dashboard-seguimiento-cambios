import { GitPullRequest, GitMerge, Rocket, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PullRequest } from "@/lib/github";
import { formatDistanceToNow } from "@/lib/timeUtils";

interface Props { prs: PullRequest[] }

export function PRList({ prs }: Props) {
  if (prs.length === 0) return <p className="text-xs text-muted-foreground py-2">Sin PRs abiertos</p>;

  const toMain = prs.filter((p) => p.base === "main");
  const rest   = prs.filter((p) => p.base !== "main");
  const sorted = [...toMain, ...rest];

  return (
    <div className="space-y-1.5">
      {sorted.map((pr) => {
        const isToMain = pr.base === "main";
        const isDev    = pr.base === "dev";

        return (
          <a
            key={pr.number}
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "flex items-start gap-2 p-2 rounded-md no-underline group transition-colors",
              isToMain
                ? "bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-700/60 hover:bg-emerald-100/70 dark:hover:bg-emerald-950/50"
                : isDev
                  ? "bg-sky-50/60 dark:bg-sky-950/20 border border-sky-200 dark:border-sky-800/40 hover:bg-sky-100/60 dark:hover:bg-sky-950/40"
                  : "hover:bg-muted/50",
            )}
          >
            {/* Ícono */}
            {isToMain ? (
              <Rocket className="h-3.5 w-3.5 mt-0.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            ) : pr.draft ? (
              <GitPullRequest className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
            ) : (
              <GitMerge className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", isDev ? "text-sky-600 dark:text-sky-400" : "text-violet-600")} />
            )}

            {/* Contenido */}
            <div className="flex-1 min-w-0">
              <p className={cn(
                "text-sm truncate group-hover:text-primary",
                isToMain ? "font-semibold text-emerald-900 dark:text-emerald-100" : "font-medium",
              )}>
                {pr.title}
              </p>
              <div className="flex items-center gap-1 text-xs mt-0.5">
                <span className={cn(
                  "font-mono",
                  isToMain ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground",
                )}>
                  {pr.head}
                </span>
                <ArrowRight className={cn(
                  "h-2.5 w-2.5 shrink-0",
                  isToMain ? "text-emerald-500" : "text-muted-foreground",
                )} />
                <span className={cn(
                  "font-mono font-semibold",
                  isToMain ? "text-emerald-700 dark:text-emerald-300" : isDev ? "text-sky-600 dark:text-sky-400" : "text-muted-foreground",
                )}>
                  {pr.base}
                </span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">{formatDistanceToNow(pr.createdAt)}</span>
              </div>
            </div>

            {/* Badges */}
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
            </div>
          </a>
        );
      })}
    </div>
  );
}
