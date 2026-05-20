import { CheckCircle2, XCircle, Clock, HelpCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { WorkflowRun } from "@/lib/github";
import { formatDistanceToNow } from "@/lib/timeUtils";

interface Props { run: WorkflowRun }

export function WorkflowBadge({ run }: Props) {
  const isSuccess = run.conclusion === "success";
  const isFailure = run.conclusion === "failure" || run.conclusion === "cancelled";
  const isPending = run.status === "in_progress" || run.status === "queued";

  return (
    <a href={run.url} target="_blank" rel="noopener noreferrer" className="no-underline">
      <Badge
        variant={isSuccess ? "success" : isFailure ? "destructive" : isPending ? "warning" : "outline"}
        className="flex items-center gap-1 cursor-pointer"
      >
        {isSuccess && <CheckCircle2 className="h-3 w-3" />}
        {isFailure && <XCircle className="h-3 w-3" />}
        {isPending && <Clock className="h-3 w-3 animate-spin" />}
        {!isSuccess && !isFailure && !isPending && <HelpCircle className="h-3 w-3" />}
        <span className="max-w-[140px] truncate">{run.name}</span>
        <span className="text-[10px] opacity-70">{formatDistanceToNow(run.createdAt)}</span>
      </Badge>
    </a>
  );
}
