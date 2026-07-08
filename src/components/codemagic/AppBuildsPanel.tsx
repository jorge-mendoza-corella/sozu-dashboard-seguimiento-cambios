import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Smartphone, Play, Loader2, ExternalLink, XCircle, Download, AlertCircle,
  GitBranch, Upload, Clock, CheckCircle2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { useCodemagicApps, useCodemagicBuilds, useBranchHead, useActiveDeploy } from "@/hooks/useCodemagic";
import {
  startBuild, cancelBuild, buildStatusInfo, buildUrl, buildCommitSha, appRepo,
  formatBuildDate, PLATFORMS, WORKFLOW_LABELS,
  type CodemagicBuild, type PlatformDef,
} from "@/lib/codemagic";
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

const isSuccess = (b: CodemagicBuild) => buildStatusInfo(b.status).tone === "success";
const isRunning = (b: CodemagicBuild) => buildStatusInfo(b.status).isRunning;

/** Fila de una plataforma: construir artefacto y, si ya existe, enviarlo a la store. */
function PlatformRow({
  platform, branch, builds, headSha, deployActive, perms, busy, onStart,
}: {
  platform: PlatformDef;
  branch: string;
  builds: CodemagicBuild[];
  headSha: string | null | undefined;
  deployActive: boolean;
  perms: CicdPermissions;
  busy: string | null;
  onStart: (workflowId: string, label: string) => void;
}) {
  const forBranch = (wf: string) => builds.filter((b) => b.workflowId === wf && b.branch === branch);
  const buildRuns = forBranch(platform.buildWorkflowId);
  const publishRuns = forBranch(platform.publishWorkflowId);

  const sameShaBuilt = !!headSha && buildRuns.some(
    (b) => buildCommitSha(b) === headSha && (isSuccess(b) || isRunning(b)),
  );
  const buildInProgress = buildRuns.some(isRunning);
  const lastGoodBuild = buildRuns.find(isSuccess);
  const canPublish = !!lastGoodBuild && (!headSha || buildCommitSha(lastGoodBuild) === headSha);
  const sameShaPublished = !!headSha && publishRuns.some(
    (b) => buildCommitSha(b) === headSha && (isSuccess(b) || isRunning(b)),
  );
  const publishInProgress = publishRuns.some(isRunning);

  const buildDisabledReason =
    deployActive ? "Espera: hay un deploy web en curso" :
    buildInProgress ? "Ya hay un build en curso" :
    sameShaBuilt ? "Este código ya fue construido" : null;

  const publishDisabledReason =
    publishInProgress ? "Publicación en curso" :
    sameShaPublished ? "Este código ya fue enviado a la store" :
    !canPublish ? `Primero construye el artefacto ${platform.label} del código actual` : null;

  const buildKey = `${platform.key}-build`;
  const publishKey = `${platform.key}-publish`;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2.5">
      <span className="flex w-20 items-center gap-1.5 text-sm font-semibold">
        <Smartphone className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
        {platform.label}
      </span>
      {lastGoodBuild ? (
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
          último artefacto: {formatBuildDate(lastGoodBuild.finishedAt ?? lastGoodBuild.startedAt)}
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground">sin artefactos aún</span>
      )}
      <span className="flex-1" />
      {perms.buildApp && (
        <>
          <Button
            size="sm"
            variant="outline"
            title={buildDisabledReason ?? `Construir artefacto ${platform.label} (${branch})`}
            disabled={!!buildDisabledReason || busy === buildKey}
            onClick={() => onStart(platform.buildWorkflowId, buildKey)}
          >
            {busy === buildKey ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}
            Construir
          </Button>
          <Button
            size="sm"
            title={publishDisabledReason ?? `Construir y enviar a ${platform.storeLabel}`}
            disabled={!!publishDisabledReason || busy === publishKey}
            onClick={() => onStart(platform.publishWorkflowId, publishKey)}
          >
            {busy === publishKey ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}
            {platform.storeLabel}
          </Button>
        </>
      )}
      {buildDisabledReason && (
        <span className="w-full text-[10px] text-muted-foreground sm:w-auto">{buildDisabledReason}</span>
      )}
    </div>
  );
}

export function AppBuildsPanel({ appId, perms }: { appId: string; perms: CicdPermissions }) {
  const qc = useQueryClient();
  const { data: apps = [], isLoading: loadingApps, error: appsError } = useCodemagicApps();
  const { data: builds = [], isLoading: loadingBuilds, error: buildsError } = useCodemagicBuilds(appId);

  const app = useMemo(() => apps.find((a) => a._id === appId), [apps, appId]);
  const repo = useMemo(() => appRepo(app), [app]);

  const branches = app?.branches ?? [];
  const [branch, setBranch] = useState("");
  const effectiveBranch = branch || (branches.includes("main") ? "main" : branches[0]) || "main";

  const { data: headSha } = useBranchHead(repo?.owner, repo?.repo, effectiveBranch);
  const { data: deployActive = false } = useActiveDeploy(repo?.owner, repo?.repo);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["codemagic-builds", appId] });

  const handleStart = async (workflowId: string, key: string) => {
    const label = WORKFLOW_LABELS[workflowId] ?? workflowId;
    if (!confirm(`¿Iniciar "${label}" en la rama ${effectiveBranch}?`)) return;
    setBusy(key);
    setError("");
    try {
      await startBuild(appId, workflowId, effectiveBranch);
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
  const visibleBuilds = showAll ? builds : builds.slice(0, 5);

  return (
    <Card>
      <CardContent className="p-4">
        {/* Header */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Smartphone className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            {app?.appName ?? "App"}
            <span className="text-[10px] font-normal text-muted-foreground">via Codemagic</span>
          </h3>
          {deployActive && (
            <span className="flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
              <Clock className="h-3 w-3" /> deploy web en curso
            </span>
          )}
          <span className="flex-1" />
          <SelectNative
            className="h-7 w-32 text-xs"
            value={effectiveBranch}
            disabled={loadingApps || branches.length === 0}
            onChange={(e) => setBranch(e.target.value)}
            title="Rama a construir"
          >
            {branches.length === 0 && <option value={effectiveBranch}>{effectiveBranch}</option>}
            {branches.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </SelectNative>
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

        {/* Plataformas */}
        <div className="space-y-2">
          {PLATFORMS.map((p) => (
            <PlatformRow
              key={p.key}
              platform={p}
              branch={effectiveBranch}
              builds={builds}
              headSha={headSha}
              deployActive={deployActive}
              perms={perms}
              busy={busy}
              onStart={handleStart}
            />
          ))}
        </div>

        {/* Historial */}
        <h4 className="mb-1.5 mt-4 text-xs font-semibold text-muted-foreground">
          Historial de builds
        </h4>
        {loadingBuilds ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando builds…
          </div>
        ) : builds.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">Sin builds todavía.</p>
        ) : (
          <div className="space-y-1.5">
            {visibleBuilds.map((b) => {
              const info = buildStatusInfo(b.status);
              const wfName = WORKFLOW_LABELS[b.workflowId] ?? app?.workflows?.[b.workflowId]?.name ?? b.workflowId;
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
                  {when && <span className="text-muted-foreground">{formatBuildDate(when)}</span>}
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
            {builds.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="w-full rounded-md border border-dashed px-3 py-1.5 text-center text-xs text-muted-foreground hover:bg-muted"
              >
                {showAll ? "Ver menos" : `Ver más (${builds.length - 5} builds anteriores)`}
              </button>
            )}
          </div>
        )}

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
