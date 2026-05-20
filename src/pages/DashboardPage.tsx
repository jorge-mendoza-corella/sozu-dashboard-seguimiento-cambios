import { RefreshCw, Clock } from "lucide-react";
import { useGitHubStatus } from "@/hooks/useGitHubStatus";
import { RepoCard, RepoCardSkeleton } from "@/components/RepoCard";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "@/lib/timeUtils";

export function DashboardPage() {
  const { data, isLoading, isFetching, dataUpdatedAt, refetch } = useGitHubStatus();

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Estado de Repositorios</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            CI/CD · Ramas · PRs · Workflows — se actualiza cada 2 min
          </p>
        </div>
        <div className="flex items-center gap-3">
          {dataUpdatedAt > 0 && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              Actualizado {formatDistanceToNow(new Date(dataUpdatedAt).toISOString())}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            Actualizar
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
        {isLoading
          ? Array.from({ length: 5 }).map((_, i) => <RepoCardSkeleton key={i} />)
          : data?.map((repo) => <RepoCard key={repo.repo} status={repo} />)}
      </div>
    </div>
  );
}
