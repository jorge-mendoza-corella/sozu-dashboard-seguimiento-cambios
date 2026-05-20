import { GitPullRequest, GitMerge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { PullRequest } from "@/lib/github";
import { formatDistanceToNow } from "@/lib/timeUtils";

interface Props { prs: PullRequest[] }

export function PRList({ prs }: Props) {
  if (prs.length === 0) return <p className="text-xs text-muted-foreground py-2">Sin PRs abiertos</p>;
  return (
    <div className="space-y-1.5">
      {prs.map((pr) => (
        <a
          key={pr.number}
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 no-underline group"
        >
          {pr.draft
            ? <GitPullRequest className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
            : <GitMerge className="h-3.5 w-3.5 mt-0.5 text-violet-600 shrink-0" />}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate group-hover:text-primary">{pr.title}</p>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{pr.head}</span>
              {" → "}
              <span className="font-mono">{pr.base}</span>
              {" · "}
              {formatDistanceToNow(pr.createdAt)}
            </p>
          </div>
          {pr.draft && <Badge variant="outline" className="text-[10px] shrink-0">Draft</Badge>}
        </a>
      ))}
    </div>
  );
}
