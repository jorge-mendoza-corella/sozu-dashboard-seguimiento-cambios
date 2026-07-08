import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Smartphone, Play, Loader2, ExternalLink, XCircle, Download, AlertCircle, GitBranch,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { useCodemagicApps, useCodemagicBuilds } from "@/hooks/useCodemagic";
import { startBuild, cancelBuild, buildStatusInfo, buildUrl, type CodemagicBuild } from "@/lib/codemagic";
import { formatDistanceToNow } from "@/lib/timeUtils";
import { cn } from "@/lib/utils";
import type { CicdPermissions } from "@/lib/firestoreUsers";

const TONE_CLASSES: Record<string, string> = {
  running: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-900/50 animate-pulse",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900/50",
  failed: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900/50",
  neutral: "bg-muted text-muted-foreground border-border",
};

function duration(b: CodemagicBuild): string | null {
  if (!b.startedAt || !b.finishedAt) return null;
  const secs = Math.round((new Date(b.finishedAt).getTime() - new Date(b.startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function AppBuildsPanel({ appId, perms }: { appId: string; perms: CicdPermissions }) {
  const qc = useQueryClient();
  const { data: apps = [], isLoading: loadingApps, error: appsError } = useCodemagicApps();
  const { data: builds = [], isLoading: loadingBuilds, error: buildsError } = useCodemagicBuilds(appId);

  const app = useMemo(() => apps.find((a) => a._id === appId), [apps, appId]);

  const [workflowId, setWorkflowId] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // "start" | buildId a cancelar
  const [error, setError] = useState("");

  const workflowEntries = useMemo(
    () => Object.entries(app?.workflows ?? {}).map(([id, w]) => ({ id, name: w.name || id })),
    [app],
  );
  const branches = app?.branches ?? [];
  const effectiveWorkflow = workflowId || workflowEntries[0]?.id || "";
  const effectiveBranch = branch || (branches.includes("main") ? "main" : branches[0]) || "";

  const refresh = () => qc.invalidateQueries({ queryKey: ["codemagic-builds", appId] });

  const handleStart = async () => {
    if (!effectiveWorkflow || !effectiveBranch) return;
    const wfName = workflowEntries.find((w) => w.id === effectiveWorkflow)?.name ?? effectiveWorkflow;
    if (!confirm(`¿Iniciar build "${wfName}" en la rama ${effectiveBranch}?`)) return;
    setBusy("start");
    setError("");
    try {
      await startBuild(appId, effectiveWorkflow, effectiveBranch);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al iniciar el build");
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = async (buildId: string) => {
    if (!confirm("¿Cancelar este build?")) return;
    setBusy(buildId);
    setError("");
    try {
      await cancelBuild(buildId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cancelar el build");
    } finally {
      setBusy(null);
    }
  };

  const anyError = appsError || buildsError;

  return (
    <Card className="mb-4 border-blue-200/60 dark:border-blue-900/40">
      <CardContent className="p-4">
        {/* Header */}
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Smartphone className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            Builds de App{app ? ` — ${app.appName}` : ""}
            <span className="text-[10px] font-normal text-muted-foreground">via Codemagic</span>
          </h3>
          <a
            href={`https://codemagic.io/app/${appId}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Codemagic <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        {anyError && (
          <p className="mb-3 flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {(anyError as Error).message}
          </p>
        )}

        {/* Disparar build */}
        {perms.buildApp && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <SelectNative
              className="w-48"
              value={effectiveWorkflow}
              disabled={loadingApps || workflowEntries.length === 0}
              onChange={(e) => setWorkflowId(e.target.value)}
            >
              {workflowEntries.length === 0 && <option value="">Sin workflows</option>}
              {workflowEntries.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </SelectNative>
            <SelectNative
              className="w-36"
              value={effectiveBranch}
              disabled={loadingApps || branches.length === 0}
              onChange={(e) => setBranch(e.target.value)}
            >
              {branches.length === 0 && <option value="">Sin ramas</option>}
              {branches.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </SelectNative>
            <Button
              size="sm"
              disabled={busy === "start" || !effectiveWorkflow || !effectiveBranch}
              onClick={handleStart}
            >
              {busy === "start" ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <Play className="h-4 w-4 mr-1.5" />
              )}
              Construir
            </Button>
          </div>
        )}

        {/* Builds recientes */}
        {loadingBuilds ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando builds…
          </div>
        ) : builds.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">Sin builds todavía.</p>
        ) : (
          <div className="space-y-1.5">
            {builds.slice(0, 5).map((b) => {
              const info = buildStatusInfo(b.status);
              const wfName = app?.workflows?.[b.workflowId]?.name ?? b.workflowId;
              const dur = duration(b);
              const when = b.startedAt ?? b.createdAt;
              return (
                <div key={b._id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs">
                  <span className={cn("shrink-0 rounded-full border px-2 py-0.5 font-medium", TONE_CLASSES[info.tone])}>
                    {info.label}
                  </span>
                  <span className="font-medium">{wfName}</span>
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <GitBranch className="h-3 w-3" />{b.branch}
                  </span>
                  {when && <span className="text-muted-foreground">{formatDistanceToNow(when)}</span>}
                  {dur && <span className="text-muted-foreground">· {dur}</span>}
                  <span className="flex-1" />
                  {info.tone === "success" &&
                    (b.artefacts ?? [])
                      .filter((a) => /\.(apk|aab|ipa)$/i.test(a.name))
                      .map((a) => (
                        <a
                          key={a.url}
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          title={a.name}
                          className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                        >
                          <Download className="h-3 w-3" />
                          {a.name.split(".").pop()?.toUpperCase()}
                        </a>
                      ))}
                  <a
                    href={buildUrl(appId, b._id)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    Ver <ExternalLink className="h-3 w-3" />
                  </a>
                  {info.isRunning && perms.buildApp && (
                    <button
                      type="button"
                      disabled={busy === b._id}
                      onClick={() => handleCancel(b._id)}
                      className="flex items-center gap-1 text-destructive hover:opacity-80 disabled:opacity-50"
                      title="Cancelar build"
                    >
                      {busy === b._id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
