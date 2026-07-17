import { useEffect, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { RepoCard, RepoCardSkeleton } from "@/components/RepoCard";
import { cn } from "@/lib/utils";
import type { RepoStatus, ApproverAuth } from "@/lib/github";
import type { MonitoredRepo } from "@/lib/firestoreProjects";
import type { CicdPermissions } from "@/lib/firestoreUsers";

interface Props {
  repos: MonitoredRepo[]; // ya ordenados, de un solo proyecto
  statusByKey: Map<string, RepoStatus>;
  isLoading: boolean;
  isViewer: boolean;
  perms: CicdPermissions;
  canReorder: boolean;
  approver?: ApproverAuth | null;
  selfLogin?: string | null;
  notifyAuthors?: string[];
  onRefetch: () => void;
  onReorder: (ids: string[]) => void;
}

const keyOf = (r: MonitoredRepo) => `${r.owner}/${r.repo}`;

export function RepoGrid({ repos, statusByKey, isLoading, isViewer, perms, canReorder, approver = null, selfLogin = null, notifyAuthors = [], onRefetch, onReorder }: Props) {
  const [items, setItems] = useState<MonitoredRepo[]>(repos);
  const dragFrom = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  // Re-sincronizar cuando cambian los repos del proyecto (alta/baja/orden remoto).
  useEffect(() => {
    setItems(repos);
  }, [repos.map((r) => r.id).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDrop = (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    setOverIdx(null);
    if (from === null || from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setItems(next);
    onReorder(next.map((r) => r.id));
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
      {items.map((r, i) => {
        const status = statusByKey.get(keyOf(r));
        if (isLoading && !status) return <RepoCardSkeleton key={r.id} />;
        if (!status) return null;
        return (
          <div
            key={r.id}
            draggable={canReorder}
            onDragStart={() => (dragFrom.current = i)}
            onDragOver={(e) => {
              if (!canReorder) return;
              e.preventDefault();
              if (overIdx !== i) setOverIdx(i);
            }}
            onDrop={() => handleDrop(i)}
            onDragEnd={() => {
              dragFrom.current = null;
              setOverIdx(null);
            }}
            className={cn(
              "group relative transition-all",
              canReorder && "cursor-move",
              overIdx === i && "ring-2 ring-primary ring-offset-2 rounded-lg",
            )}
          >
            {canReorder && (
              <div
                className="absolute -left-1 top-1/2 z-10 -translate-y-1/2 rounded bg-background/80 p-0.5 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover:opacity-100"
                title="Arrastra para reordenar"
              >
                <GripVertical className="h-4 w-4" />
              </div>
            )}
            <RepoCard status={status} onRefetch={onRefetch} readOnly={isViewer} perms={perms} approver={approver} selfLogin={selfLogin} notifyAuthors={notifyAuthors} />
          </div>
        );
      })}
    </div>
  );
}
