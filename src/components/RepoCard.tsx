import { AlertCircle, CheckCircle2, RefreshCw, GitBranch, GitPullRequest, Zap } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BranchRow } from "./BranchRow";
import { PRList } from "./PRList";
import { WorkflowBadge } from "./WorkflowBadge";
import type { RepoStatus } from "@/lib/github";

interface Props { status: RepoStatus }

function getOverallState(status: RepoStatus): "ok" | "pending" | "failing" | "error" {
  if (status.error) return "error";
  const failing = status.latestRuns.some((r) => r.conclusion === "failure");
  if (failing) return "failing";
  const pending = status.openPRs.length > 0 || status.branches.some((b) => b.aheadOfMain > 0);
  if (pending) return "pending";
  return "ok";
}

export function RepoCard({ status }: Props) {
  const state = getOverallState(status);
  const stateConfig = {
    ok: { icon: CheckCircle2, color: "text-green-600", label: "Todo en orden", badge: "success" as const },
    pending: { icon: GitPullRequest, color: "text-amber-600", label: "Cambios pendientes", badge: "warning" as const },
    failing: { icon: AlertCircle, color: "text-red-600", label: "CI fallando", badge: "destructive" as const },
    error: { icon: AlertCircle, color: "text-muted-foreground", label: "Error al cargar", badge: "outline" as const },
  }[state];

  const StateIcon = stateConfig.icon;

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <StateIcon className={`h-5 w-5 shrink-0 ${stateConfig.color}`} />
            <CardTitle className="text-base truncate">{status.label}</CardTitle>
          </div>
          <Badge variant={stateConfig.badge} className="shrink-0 text-[10px]">{stateConfig.label}</Badge>
        </div>
        {status.error && <p className="text-xs text-destructive mt-1">{status.error}</p>}
      </CardHeader>

      <CardContent className="flex flex-col gap-4 flex-1">
        {/* Branches */}
        <div>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            <GitBranch className="h-3.5 w-3.5" /> Ramas ({status.branches.length})
          </h4>
          <div className="space-y-0">
            {status.branches.slice(0, 8).map((b) => <BranchRow key={b.name} branch={b} />)}
          </div>
        </div>

        {/* Open PRs */}
        <div>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            <GitPullRequest className="h-3.5 w-3.5" /> PRs abiertos ({status.openPRs.length})
          </h4>
          <PRList prs={status.openPRs} />
        </div>

        {/* Latest Workflow Runs */}
        <div>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            <Zap className="h-3.5 w-3.5" /> Últimos workflows
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {status.latestRuns.length === 0
              ? <p className="text-xs text-muted-foreground">Sin ejecuciones recientes</p>
              : status.latestRuns.map((r, i) => <WorkflowBadge key={i} run={r} />)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function RepoCardSkeleton() {
  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin" />
          <div className="h-5 bg-muted rounded w-40 animate-pulse" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {[1,2,3].map((i) => <div key={i} className="h-4 bg-muted rounded animate-pulse" />)}
        </div>
      </CardContent>
    </Card>
  );
}
