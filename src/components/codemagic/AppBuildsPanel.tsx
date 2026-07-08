import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Smartphone, Play, Loader2, ExternalLink, XCircle, Download, AlertCircle,
  GitBranch, Upload, Clock, CheckCircle2, Rocket, Cloud,
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
import { setProjectTesters, setProjectTestLinks, type Project } from "@/lib/firestoreProjects";

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

// ---------------------------------------------------------------------------
// Plataforma de un build: por prefijo del workflow, o por sus artefactos
// (builds viejos disparados desde la UI de Codemagic no traen workflow id
// legible).
// ---------------------------------------------------------------------------
type Plat = "android" | "ios" | "web" | "otro";

function platformOfBuild(b: CodemagicBuild): Plat {
  const wf = b.workflowId ?? "";
  if (wf.startsWith("android")) return "android";
  if (wf.startsWith("ios")) return "ios";
  if (wf.startsWith("web")) return "web";
  const arts = b.artefacts ?? [];
  if (arts.some((a) => /\.(apk|aab)$/i.test(a.name))) return "android";
  if (arts.some((a) => /\.ipa$/i.test(a.name))) return "ios";
  if (arts.some((a) => /\.zip$/i.test(a.name))) return "web";
  return "otro";
}

const PLAT_META: Record<Plat, { label: string; cls: string }> = {
  android: { label: "Android", cls: "bg-lime-50 text-lime-700 border-lime-200 dark:bg-lime-950/30 dark:text-lime-300 dark:border-lime-900/50" },
  ios: { label: "iOS", cls: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-900/50" },
  web: { label: "Web", cls: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:border-violet-900/50" },
  otro: { label: "—", cls: "bg-muted text-muted-foreground border-border" },
};

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
  onStart: (workflowId: string, label: string, envVars?: Record<string, string>) => void;
}) {
  const forBranch = (wf: string) => builds.filter((b) => b.workflowId === wf && b.branch === branch);
  const buildRuns = forBranch(platform.buildWorkflowId);
  const publishRuns = forBranch(platform.publishWorkflowId);
  const promoteRuns = forBranch(platform.promoteWorkflowId);

  const sameShaBuilt = !!headSha && buildRuns.some(
    (b) => buildCommitSha(b) === headSha && (isSuccess(b) || isRunning(b)),
  );
  const buildInProgress = buildRuns.some(isRunning);
  const lastGoodBuild = buildRuns.find(isSuccess);
  const canPublish = !!lastGoodBuild && (!headSha || buildCommitSha(lastGoodBuild) === headSha);
  const publishedCurrent = publishRuns.some(
    (b) => isSuccess(b) && (!headSha || buildCommitSha(b) === headSha),
  );
  const publishInProgress = publishRuns.some(isRunning);
  const promotedCurrent = promoteRuns.some(
    (b) => (isSuccess(b) || isRunning(b)) && (!headSha || buildCommitSha(b) === headSha),
  );
  const promoteInProgress = promoteRuns.some(isRunning);

  const buildDisabledReason =
    deployActive ? "Espera: hay un deploy web en curso" :
    buildInProgress ? "Ya hay un build en curso" :
    sameShaBuilt ? "Este código ya fue construido" : null;

  const publishDisabledReason =
    publishInProgress ? "Publicación en curso" :
    !canPublish ? `Primero construye el artefacto ${platform.label} del código actual` : null;

  const promoteDisabledReason =
    promoteInProgress ? "Envío a la store en curso" :
    promotedCurrent ? "Este código ya fue enviado a la store" : null;

  const buildKey = `${platform.key}-build`;
  const publishKey = `${platform.key}-publish`;
  const promoteKey = `${platform.key}-promote`;

  // Paso final: pedir comentario OBLIGATORIO de lo que se actualiza.
  const handlePromote = () => {
    const notes = window.prompt(
      `¿Qué se actualiza en esta versión?\n\nComentario obligatorio para enviar a ${platform.promoteLabel}:`,
    );
    if (notes === null) return; // canceló
    if (!notes.trim()) {
      alert("El comentario de la actualización es obligatorio.");
      return;
    }
    onStart(platform.promoteWorkflowId, promoteKey, { RELEASE_NOTES: notes.trim() });
  };

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
          {!publishedCurrent ? (
            <Button
              size="sm"
              title={publishDisabledReason ?? `Construir y enviar a ${platform.storeLabel}`}
              disabled={!!publishDisabledReason || busy === publishKey}
              onClick={() => onStart(platform.publishWorkflowId, publishKey)}
            >
              {busy === publishKey ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}
              {platform.storeLabel}
            </Button>
          ) : (
            // Ya pasó por la store de pruebas: paso final hacia la store pública.
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              title={promoteDisabledReason ?? `Enviar a ${platform.promoteLabel} (pide comentario de la versión)`}
              disabled={!!promoteDisabledReason || busy === promoteKey}
              onClick={handlePromote}
            >
              {busy === promoteKey ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Rocket className="h-3.5 w-3.5 mr-1.5" />}
              {platform.promoteLabel}
            </Button>
          )}
        </>
      )}
      {buildDisabledReason && (
        <span className="w-full text-[10px] text-muted-foreground sm:w-auto">{buildDisabledReason}</span>
      )}
    </div>
  );
}

export function AppBuildsPanel({ appId, perms, project }: {
  appId: string;
  perms: CicdPermissions;
  project?: Project;
}) {
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
  // Filtros del historial
  const [platFilter, setPlatFilter] = useState<"all" | Plat>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Testers: correos con acceso a los builds de prueba (fuente de verdad en
  // Firestore; copiar/pegar en Play Console / TestFlight al darlos de alta).
  const testers = project?.testerEmails ?? [];
  const [newTester, setNewTester] = useState("");
  const [savingTesters, setSavingTesters] = useState(false);
  const [copied, setCopied] = useState(false);

  const saveTesters = async (emails: string[]) => {
    if (!project) return;
    setSavingTesters(true);
    setError("");
    try {
      await setProjectTesters(project.id, emails);
      await qc.invalidateQueries({ queryKey: ["projects"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar testers");
    } finally {
      setSavingTesters(false);
    }
  };

  const addTester = () => {
    const email = newTester.trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Correo inválido");
      return;
    }
    if (testers.includes(email)) {
      setNewTester("");
      return;
    }
    saveTesters([...testers, email]).then(() => setNewTester(""));
  };

  const copyTesters = async () => {
    await navigator.clipboard.writeText(testers.join(", "));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Links de invitación (fijos por app; se configuran una sola vez).
  const editTestLink = (kind: "playInternalUrl" | "testflightPublicUrl") => {
    if (!project) return;
    const label = kind === "playInternalUrl"
      ? "link de invitación del track interno de Play\n(Play Console → Testing → Internal testing → Testers → Copy link)"
      : "link público de TestFlight\n(App Store Connect → TestFlight → grupo externo → Public link)";
    const current = project[kind] ?? "";
    const url = window.prompt(`Pega el ${label}\n\nVacío = quitar el link:`, current);
    if (url === null) return;
    const trimmed = url.trim();
    if (trimmed && !/^https:\/\//.test(trimmed)) {
      alert("El link debe empezar con https://");
      return;
    }
    setProjectTestLinks(project.id, { [kind]: trimmed })
      .then(() => qc.invalidateQueries({ queryKey: ["projects"] }))
      .catch((e) => setError(e instanceof Error ? e.message : "Error al guardar el link"));
  };

  // Marcadores (3 por plataforma): último build construido, lo último en el
  // canal de pruebas (TestFlight/Play interno) y lo último en la store.
  // El rol se decide por workflowId; builds lanzados desde la UI de Codemagic
  // traen un id interno → cuentan como "build" y la plataforma sale de sus
  // artefactos (platformOfBuild).
  const markers = useMemo(() => {
    const m = new Map<string, string[]>();
    const add = (id: string | undefined, tag: string) => {
      if (id) m.set(id, [...(m.get(id) ?? []), tag]);
    };
    const isPublishOrPromote = (b: CodemagicBuild) =>
      PLATFORMS.some((p) => b.workflowId === p.publishWorkflowId || b.workflowId === p.promoteWorkflowId);
    for (const p of PLATFORMS) {
      add(
        builds.find((b) => platformOfBuild(b) === p.key && !isPublishOrPromote(b) && isSuccess(b))?._id,
        `último build ${p.label}`,
      );
      add(builds.find((b) => b.workflowId === p.publishWorkflowId && isSuccess(b))?._id, `en ${p.storeLabel}`);
      add(builds.find((b) => b.workflowId === p.promoteWorkflowId && isSuccess(b))?._id, `en ${p.promoteLabel}`);
    }
    add(
      builds.find((b) => platformOfBuild(b) === "web" && isSuccess(b))?._id,
      "último build Web",
    );
    return m;
  }, [builds]);

  const filteredBuilds = useMemo(() => {
    return builds.filter((b) => {
      if (platFilter !== "all" && platformOfBuild(b) !== platFilter) return false;
      const when = b.startedAt ?? b.createdAt;
      if (!when) return true;
      const d = when.slice(0, 10); // YYYY-MM-DD
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      return true;
    });
  }, [builds, platFilter, dateFrom, dateTo]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["codemagic-builds", appId] });

  const handleStart = async (workflowId: string, key: string, envVars?: Record<string, string>) => {
    const label = WORKFLOW_LABELS[workflowId] ?? workflowId;
    if (!confirm(`¿Iniciar "${label}" en la rama ${effectiveBranch}?`)) return;
    setBusy(key);
    setError("");
    try {
      await startBuild(appId, workflowId, effectiveBranch, envVars);
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
  const visibleBuilds = showAll ? filteredBuilds : filteredBuilds.slice(0, 5);

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

        {/* Testers con acceso a builds de prueba */}
        {project && (
          <div className="mt-4">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <h4 className="text-xs font-semibold text-muted-foreground">
                Testers con acceso ({testers.length})
              </h4>
              {testers.length > 0 && (
                <button
                  type="button"
                  onClick={copyTesters}
                  className="text-[10px] text-muted-foreground underline hover:text-foreground"
                  title="Copia la lista para pegarla en Play Console (Internal testing → Testers) o App Store Connect (TestFlight → grupo)"
                >
                  {copied ? "¡copiado!" : "copiar lista"}
                </button>
              )}
              <span className="flex-1" />
              {/* Links de invitación fijos por app */}
              {(["playInternalUrl", "testflightPublicUrl"] as const).map((kind) => {
                const url = project[kind];
                const label = kind === "playInternalUrl" ? "Play interno" : "TestFlight público";
                return (
                  <span key={kind} className="flex items-center gap-1">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                        title={url}
                      >
                        <Cloud className="h-3 w-3" /> {label}
                      </a>
                    ) : (
                      <span className="text-[10px] text-muted-foreground/70">{label}: sin link</span>
                    )}
                    {perms.buildApp && (
                      <button
                        type="button"
                        onClick={() => editTestLink(kind)}
                        className="text-[10px] text-muted-foreground underline hover:text-foreground"
                        title={`Configurar link de ${label} (una sola vez por app)`}
                      >
                        {url ? "editar" : "configurar"}
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {testers.map((email) => (
                <span
                  key={email}
                  className="flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[11px]"
                >
                  {email}
                  {perms.buildApp && (
                    <button
                      type="button"
                      disabled={savingTesters}
                      onClick={() => saveTesters(testers.filter((t) => t !== email))}
                      className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                      title="Quitar acceso"
                    >
                      <XCircle className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
              {testers.length === 0 && (
                <span className="text-[11px] text-muted-foreground">Sin testers registrados.</span>
              )}
              {perms.buildApp && (
                <span className="flex items-center gap-1">
                  <input
                    type="email"
                    className="h-6 w-52 rounded-md border bg-background px-2 text-[11px]"
                    placeholder="correo@ejemplo.com"
                    value={newTester}
                    disabled={savingTesters}
                    onChange={(e) => setNewTester(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addTester()}
                  />
                  <button
                    type="button"
                    disabled={savingTesters || !newTester.trim()}
                    onClick={addTester}
                    className="flex h-6 items-center rounded-md border px-2 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
                  >
                    {savingTesters ? <Loader2 className="h-3 w-3 animate-spin" /> : "Agregar"}
                  </button>
                </span>
              )}
            </div>
          </div>
        )}

        {/* Historial */}
        <div className="mb-1.5 mt-4 flex flex-wrap items-center gap-2">
          <h4 className="text-xs font-semibold text-muted-foreground">Historial de builds</h4>
          <span className="flex-1" />
          <SelectNative
            className="h-7 w-28 text-xs"
            value={platFilter}
            onChange={(e) => setPlatFilter(e.target.value as "all" | Plat)}
            title="Filtrar por plataforma"
          >
            <option value="all">Todas</option>
            <option value="android">Android</option>
            <option value="ios">iOS</option>
            <option value="web">Web</option>
          </SelectNative>
          <input
            type="date"
            className="h-7 rounded-md border bg-background px-2 text-xs text-muted-foreground"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            title="Desde"
          />
          <span className="text-[10px] text-muted-foreground">a</span>
          <input
            type="date"
            className="h-7 rounded-md border bg-background px-2 text-xs text-muted-foreground"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            title="Hasta"
          />
          {(platFilter !== "all" || dateFrom || dateTo) && (
            <button
              type="button"
              className="text-[10px] text-muted-foreground underline hover:text-foreground"
              onClick={() => { setPlatFilter("all"); setDateFrom(""); setDateTo(""); }}
            >
              limpiar
            </button>
          )}
        </div>
        {loadingBuilds ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando builds…
          </div>
        ) : filteredBuilds.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            {builds.length === 0 ? "Sin builds todavía." : "Sin builds con esos filtros."}
          </p>
        ) : (
          <div className="space-y-1.5">
            {visibleBuilds.map((b) => {
              const info = buildStatusInfo(b.status);
              const plat = platformOfBuild(b);
              const wfName = WORKFLOW_LABELS[b.workflowId] ?? app?.workflows?.[b.workflowId]?.name ?? "";
              const dur = duration(b);
              const when = b.startedAt ?? b.createdAt;
              const tags = markers.get(b._id) ?? [];
              const isIosCloud = plat === "ios" && info.tone === "success" &&
                (b.workflowId === "ios-publish" || b.workflowId === "ios-appstore");
              const isAndroidCloud = plat === "android" && info.tone === "success" &&
                (b.workflowId === "android-publish" || b.workflowId === "android-production");
              return (
                <div key={b._id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs">
                  <span className={cn("shrink-0 rounded-full border px-2 py-0.5 font-medium", TONE_CLASSES[info.tone])}>
                    {info.label}
                  </span>
                  <span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold", PLAT_META[plat].cls)}>
                    {PLAT_META[plat].label}
                  </span>
                  {wfName && <span className="font-medium">{wfName}</span>}
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <GitBranch className="h-3 w-3" />{b.branch}
                  </span>
                  {when && <span className="text-muted-foreground">{formatBuildDate(when)}</span>}
                  {dur && <span className="text-muted-foreground">· {dur}</span>}
                  {tags.map((t) => (
                    <span
                      key={t}
                      className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300"
                    >
                      ★ {t}
                    </span>
                  ))}
                  <span className="flex-1" />
                  {/* Android/Web: instaladores descargables. iOS: el .ipa firmado para
                      App Store no se puede instalar directo — se distribuye por TestFlight. */}
                  {info.tone === "success" && plat !== "ios" &&
                    (b.artefacts ?? [])
                      .filter((a) => /\.(apk|aab|zip)$/i.test(a.name))
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
                  {isIosCloud && (
                    <a
                      href={
                        b.workflowId === "ios-publish" && project?.testflightPublicUrl
                          ? project.testflightPublicUrl
                          : "https://appstoreconnect.apple.com/apps"
                      }
                      target="_blank"
                      rel="noreferrer"
                      title="El build vive en la nube de Apple: instálalo desde la app TestFlight o revisa App Store Connect"
                      className="flex items-center gap-1 rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-sky-700 hover:bg-sky-100 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300"
                    >
                      <Cloud className="h-3 w-3" />
                      {b.workflowId === "ios-appstore" ? "App Store Connect" : "TestFlight"}
                    </a>
                  )}
                  {isAndroidCloud && (
                    <a
                      href={
                        b.workflowId === "android-publish" && project?.playInternalUrl
                          ? project.playInternalUrl
                          : "https://play.google.com/console"
                      }
                      target="_blank"
                      rel="noreferrer"
                      title="El build está en Google Play. Link de invitación para testers: Play Console → Testing → Internal testing → Testers → Copy link"
                      className="flex items-center gap-1 rounded border border-lime-200 bg-lime-50 px-1.5 py-0.5 text-lime-700 hover:bg-lime-100 dark:border-lime-900/50 dark:bg-lime-950/30 dark:text-lime-300"
                    >
                      <Cloud className="h-3 w-3" />
                      {b.workflowId === "android-production" ? "Play Store" : "Play interno"}
                    </a>
                  )}
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
            {filteredBuilds.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="w-full rounded-md border border-dashed px-3 py-1.5 text-center text-xs text-muted-foreground hover:bg-muted"
              >
                {showAll ? "Ver menos" : `Ver más (${filteredBuilds.length - 5} builds anteriores)`}
              </button>
            )}
          </div>
        )}

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
