import { useEffect, useMemo, useState } from "react";
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
  formatBuildDate, uploadAndroidKeystore, PLATFORMS, WORKFLOW_LABELS, SYNC_TESTERS_WORKFLOW,
  type CodemagicBuild, type PlatformDef,
} from "@/lib/codemagic";
import { useAuth } from "@/hooks/useAuth";
import { SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import { setProjectKeystoreUploaded, setProjectDeployMode } from "@/lib/firestoreProjects";
import { cn } from "@/lib/utils";
import type { CicdPermissions } from "@/lib/firestoreUsers";
import { setProjectTesters, setProjectTestLinks, type Project } from "@/lib/firestoreProjects";
import { PlayTracksCard } from "./PlayTracksCard";
import { triggerPlayTracksSync } from "@/lib/playTracks";
import { formatDistanceToNow } from "@/lib/timeUtils";

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
// Tracks de prueba con link de invitación configurable. Google/Apple NO
// exponen estos links por API — se copian una sola vez desde la consola.
// ---------------------------------------------------------------------------
type TestLinkKind = "playInternalUrl" | "playClosedUrl" | "playOpenUrl" | "testflightPublicUrl";
const TEST_LINKS: Record<TestLinkKind, { label: string; help: string }> = {
  playInternalUrl: {
    label: "Play interno",
    help: "link de invitación del track interno de Play\n(Play Console → Testing → Internal testing → Testers → Copy link)",
  },
  playClosedUrl: {
    label: "Play cerrada",
    help: "link de invitación de la prueba cerrada (Alpha)\n(Play Console → Testing → Closed testing → tu track → Testers → Copy link)",
  },
  playOpenUrl: {
    label: "Play abierta",
    help: "link de la prueba abierta (Beta pública)\n(Play Console → Testing → Open testing → Testers → Copy link)",
  },
  testflightPublicUrl: {
    label: "TestFlight público",
    help: "link público de TestFlight\n(App Store Connect → TestFlight → grupo externo → Public link)",
  },
};

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

// Fases del build según el status que reporta la API de Codemagic.
const BUILD_PHASES = [
  { key: "queued", label: "En cola" },
  { key: "preparing", label: "Preparando" },
  { key: "fetching", label: "Clonando" },
  { key: "building", label: "Construyendo" },
  { key: "testing", label: "Probando" },
  { key: "publishing", label: "Publicando" },
  { key: "finishing", label: "Finalizando" },
] as const;

/** Card destacada de un build en curso: fases, cronómetro y progreso estimado. */
function ActiveBuildCard({
  b, wfName, avgMs, appId, canCancel, busy, onCancel,
}: {
  b: CodemagicBuild;
  wfName: string;
  avgMs: number | null;
  appId: string;
  canCancel: boolean;
  busy: string | null;
  onCancel: (id: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const startedIso = b.startedAt ?? b.createdAt;
  const elapsedMs = startedIso ? Math.max(0, now - new Date(startedIso).getTime()) : 0;
  const mm = Math.floor(elapsedMs / 60000);
  const ss = String(Math.floor(elapsedMs / 1000) % 60).padStart(2, "0");
  // Progreso estimado contra el promedio de builds exitosos del mismo workflow.
  const pct = avgMs ? Math.min(96, Math.round((elapsedMs / avgMs) * 100)) : null;

  // "initializing" ocurre antes de "queued"; otros estados intermedios
  // desconocidos se asumen en plena construcción.
  const statusKey = b.status === "initializing" ? "queued" : b.status;
  const rawIdx = BUILD_PHASES.findIndex((p) => p.key === statusKey);
  const phaseIdx = rawIdx === -1 ? 3 : rawIdx;
  const plat = platformOfBuild(b);

  // Tema de la card según plataforma: Android verde-lima, iOS azul-cielo,
  // Web violeta, desconocida azul.
  const theme = {
    android: {
      card: "border-lime-400/70 from-lime-50/80 dark:border-lime-700/50 dark:from-lime-950/30",
      dot: "bg-lime-500", ping: "bg-lime-400", timer: "text-lime-700 dark:text-lime-300",
      bar: "from-lime-500 to-lime-400", track: "bg-lime-100 dark:bg-lime-950/60",
      step: "border-lime-500 bg-lime-500", stepText: "text-lime-700 dark:text-lime-300",
    },
    ios: {
      card: "border-sky-400/70 from-sky-50/80 dark:border-sky-700/50 dark:from-sky-950/30",
      dot: "bg-sky-500", ping: "bg-sky-400", timer: "text-sky-700 dark:text-sky-300",
      bar: "from-sky-500 to-sky-400", track: "bg-sky-100 dark:bg-sky-950/60",
      step: "border-sky-500 bg-sky-500", stepText: "text-sky-700 dark:text-sky-300",
    },
    web: {
      card: "border-violet-400/70 from-violet-50/80 dark:border-violet-700/50 dark:from-violet-950/30",
      dot: "bg-violet-500", ping: "bg-violet-400", timer: "text-violet-700 dark:text-violet-300",
      bar: "from-violet-500 to-violet-400", track: "bg-violet-100 dark:bg-violet-950/60",
      step: "border-violet-500 bg-violet-500", stepText: "text-violet-700 dark:text-violet-300",
    },
    otro: {
      card: "border-blue-300/70 from-blue-50/80 dark:border-blue-800/50 dark:from-blue-950/30",
      dot: "bg-blue-500", ping: "bg-blue-400", timer: "text-blue-700 dark:text-blue-300",
      bar: "from-blue-500 to-blue-400", track: "bg-blue-100 dark:bg-blue-950/60",
      step: "border-blue-500 bg-blue-500", stepText: "text-blue-700 dark:text-blue-300",
    },
  }[plat];

  return (
    <div className={cn(
      "relative overflow-hidden rounded-lg border bg-gradient-to-br via-background to-background p-3.5",
      theme.card,
    )}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-75", theme.ping)} />
          <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", theme.dot)} />
        </span>
        {plat !== "otro" && (
          <span className={cn("flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-bold uppercase tracking-wide", PLAT_META[plat].cls)}>
            <Smartphone className="h-3.5 w-3.5" />
            {PLAT_META[plat].label}
          </span>
        )}
        <span className="text-sm font-semibold">{wfName}</span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <GitBranch className="h-3 w-3" />{b.branch}
        </span>
        <span className="flex-1" />
        <span className={cn("font-mono text-sm font-semibold tabular-nums", theme.timer)}>
          {mm}:{ss}
        </span>
        {avgMs && (
          <span className="text-[10px] text-muted-foreground">
            / ~{Math.round(avgMs / 60000)}m típico
          </span>
        )}
        <a
          href={buildUrl(appId, b._id)}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          title="Ver log en vivo en Codemagic"
        >
          Log <ExternalLink className="h-3 w-3" />
        </a>
        {canCancel && (
          <button
            type="button"
            disabled={busy === b._id}
            onClick={() => onCancel(b._id)}
            className="flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 text-xs text-destructive hover:bg-red-50 disabled:opacity-50 dark:border-red-900/50 dark:hover:bg-red-950/30"
          >
            {busy === b._id ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
            Cancelar
          </button>
        )}
      </div>

      {/* Stepper de fases */}
      <div className="mt-3 flex items-center gap-1">
        {BUILD_PHASES.map((p, i) => (
          <div key={p.key} className="flex flex-1 flex-col items-center gap-1">
            <div
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full border text-[9px] font-bold transition-colors",
                i < phaseIdx && "border-emerald-400 bg-emerald-100 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
                i === phaseIdx && cn("animate-pulse text-white", theme.step),
                i > phaseIdx && "border-border bg-muted text-muted-foreground",
              )}
            >
              {i < phaseIdx ? "✓" : i + 1}
            </div>
            <span
              className={cn(
                "text-center text-[9px] leading-tight",
                i === phaseIdx ? cn("font-semibold", theme.stepText) : "text-muted-foreground",
              )}
            >
              {p.label}
            </span>
          </div>
        ))}
      </div>

      {/* Barra de progreso: estimada si hay historial, indeterminada si no */}
      <div className={cn("mt-2.5 h-1.5 overflow-hidden rounded-full", theme.track)}>
        {pct !== null ? (
          <div
            className={cn("h-full rounded-full bg-gradient-to-r transition-[width] duration-1000", theme.bar)}
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className={cn("h-full w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-gradient-to-r", theme.bar)} />
        )}
      </div>
      {pct !== null && (
        <p className="mt-1 text-right text-[10px] text-muted-foreground">{pct}% estimado</p>
      )}
    </div>
  );
}

const PLAT_META: Record<Plat, { label: string; cls: string }> = {
  android: { label: "Android", cls: "bg-lime-50 text-lime-700 border-lime-200 dark:bg-lime-950/30 dark:text-lime-300 dark:border-lime-900/50" },
  ios: { label: "iOS", cls: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-900/50" },
  web: { label: "Web", cls: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:border-violet-900/50" },
  otro: { label: "—", cls: "bg-muted text-muted-foreground border-border" },
};

/** Fila de una plataforma: construir artefacto y, si ya existe, enviarlo a la store. */
function PlatformRow({
  platform, branch, builds, headSha, deployActive, perms, busy, pendingWorkflows, onRequestStart, simple,
}: {
  platform: PlatformDef;
  branch: string;
  builds: CodemagicBuild[];
  headSha: string | null | undefined;
  deployActive: boolean;
  perms: CicdPermissions;
  busy: string | null;
  pendingWorkflows: Record<string, { id: string; t: number }>;
  onRequestStart: (workflowId: string, key: string, opts?: { askNotes?: boolean; label?: string }) => void;
  /** Modo simple: Construir + un solo botón que publica directo en la tienda. */
  simple: boolean;
}) {
  const forBranch = (wf: string) => builds.filter((b) => b.workflowId === wf && b.branch === branch);
  const buildRuns = forBranch(platform.buildWorkflowId);
  const publishRuns = forBranch(platform.publishWorkflowId);
  const promoteRuns = forBranch(platform.promoteWorkflowId);
  // "pendiente" = build recién disparado que Codemagic aún no reporta en la API.
  const isPending = (wf: string) => pendingWorkflows[wf] !== undefined;

  const sameShaBuilt = !!headSha && buildRuns.some(
    (b) => buildCommitSha(b) === headSha && (isSuccess(b) || isRunning(b)),
  );
  const buildInProgress = buildRuns.some(isRunning) || isPending(platform.buildWorkflowId);
  const lastGoodBuild = buildRuns.find(isSuccess);
  const canPublish = !!lastGoodBuild && (!headSha || buildCommitSha(lastGoodBuild) === headSha);
  const publishedCurrent = publishRuns.some(
    (b) => isSuccess(b) && (!headSha || buildCommitSha(b) === headSha),
  );
  const publishInProgress = publishRuns.some(isRunning) || isPending(platform.publishWorkflowId);
  const promotedCurrent = promoteRuns.some(
    (b) => (isSuccess(b) || isRunning(b)) && (!headSha || buildCommitSha(b) === headSha),
  );
  const promoteInProgress = promoteRuns.some(isRunning) || isPending(platform.promoteWorkflowId);

  const buildDisabledReason =
    buildInProgress ? "Ya hay un build en curso" :
    deployActive ? "Espera: hay un deploy web en curso" :
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

  // Modo simple: un workflow que construye y publica directo en la tienda
  // (sin Play interno / TestFlight de por medio).
  const storeKey = `${platform.key}-store`;
  const storeRuns = forBranch(platform.storeDirectWorkflowId);
  const storeInProgress = storeRuns.some(isRunning) || isPending(platform.storeDirectWorkflowId);
  const storeSentCurrent = storeRuns.some(
    (b) => (isSuccess(b) || isRunning(b)) && !!headSha && buildCommitSha(b) === headSha,
  );
  // Aunque el workflow directo reconstruye por su cuenta, no se habilita hasta
  // que el código actual tenga un artefacto exitoso: publicar a la tienda algo
  // que nunca compiló aquí sería mandar a revisión a ciegas.
  const storeDisabledReason =
    storeInProgress ? "Envío a la tienda en curso" :
    buildInProgress ? "Espera a que termine la construcción" :
    deployActive ? "Espera: hay un deploy web en curso" :
    !canPublish ? `Primero construye el artefacto ${platform.label} del código actual` :
    storeSentCurrent ? "Este código ya se envió a la tienda" : null;

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
            onClick={() => onRequestStart(platform.buildWorkflowId, buildKey, { label: `Construir ${platform.label}` })}
          >
            {buildInProgress || busy === buildKey ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : (
              <Play className="h-3.5 w-3.5 mr-1.5" />
            )}
            {buildInProgress ? "Construyendo…" : "Construir"}
          </Button>
          {simple ? (
            // Un solo clic: construye y publica en la tienda pública.
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              title={storeDisabledReason ?? `Publicar directo en ${platform.promoteLabel} (pide comentario de la versión)`}
              disabled={!!storeDisabledReason || busy === storeKey}
              onClick={() => onRequestStart(platform.storeDirectWorkflowId, storeKey, {
                askNotes: true, label: `Publicar en ${platform.promoteLabel}`,
              })}
            >
              {storeInProgress || busy === storeKey ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <Rocket className="h-3.5 w-3.5 mr-1.5" />
              )}
              {storeInProgress ? "Publicando…" : platform.promoteLabel}
            </Button>
          ) : !publishedCurrent ? (
            <Button
              size="sm"
              title={publishDisabledReason ?? `Construir y enviar a ${platform.storeLabel}`}
              disabled={!!publishDisabledReason || busy === publishKey}
              onClick={() => onRequestStart(platform.publishWorkflowId, publishKey, { label: `Enviar a ${platform.storeLabel}` })}
            >
              {publishInProgress || busy === publishKey ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <Upload className="h-3.5 w-3.5 mr-1.5" />
              )}
              {publishInProgress ? "Publicando…" : platform.storeLabel}
            </Button>
          ) : (
            // Ya pasó por la store de pruebas: paso final hacia la store pública.
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              title={promoteDisabledReason ?? `Enviar a ${platform.promoteLabel} (pide comentario de la versión)`}
              disabled={!!promoteDisabledReason || busy === promoteKey}
              onClick={() => onRequestStart(platform.promoteWorkflowId, promoteKey, { askNotes: true, label: `Enviar a ${platform.promoteLabel}` })}
            >
              {promoteInProgress || busy === promoteKey ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <Rocket className="h-3.5 w-3.5 mr-1.5" />
              )}
              {promoteInProgress ? "Enviando…" : platform.promoteLabel}
            </Button>
          )}
        </>
      )}
      {(buildDisabledReason || (simple && storeDisabledReason)) && (
        <span className="w-full text-[10px] text-muted-foreground sm:w-auto">
          {buildDisabledReason ?? storeDisabledReason}
        </span>
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

  // Al terminar bien una publicación a Play, pedir de inmediato el refresco de
  // tracks (el cron tardaría hasta 30 min en reflejar la nueva versión).
  useEffect(() => {
    if (!project?.androidPackage) return;
    const done = builds.find(
      (b) =>
        (b.workflowId === "android-publish" || b.workflowId === "android-production") &&
        buildStatusInfo(b.status).tone === "success",
    );
    if (!done) return;
    const key = `play-sync:${done._id}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    triggerPlayTracksSync().catch(() => sessionStorage.removeItem(key));
  }, [builds, project?.androidPackage]);

  const branches = app?.branches ?? [];
  const [branch, setBranch] = useState("");
  const effectiveBranch = branch || (branches.includes("main") ? "main" : branches[0]) || "main";

  const { data: headSha } = useBranchHead(repo?.owner, repo?.repo, effectiveBranch);
  const { data: deployActive = false } = useActiveDeploy(repo?.owner, repo?.repo);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  // Modo simple (default): Construir + publicar directo a la tienda. El modo
  // avanzado reexpone el flujo por etapas (Play interno / TestFlight y testers).
  const simple = (project?.deployMode ?? "simple") === "simple";
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

  const [syncState, setSyncState] = useState<"idle" | "syncing" | "error">("idle");

  const saveTesters = async (emails: string[]) => {
    if (!project) return;
    setSavingTesters(true);
    setError("");
    try {
      await setProjectTesters(project.id, emails);
      await qc.invalidateQueries({ queryKey: ["projects"] });
      // Sincronización automática a TestFlight (iOS). Google Play no tiene
      // API para correos individuales — ese alta es manual.
      setSyncState("syncing");
      try {
        await startBuild(appId, SYNC_TESTERS_WORKFLOW, "main", {
          TESTER_EMAILS: emails.join(","),
        });
        setSyncState("idle");
        refresh();
      } catch {
        setSyncState("error");
      }
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

  // Subida del keystore Android (solo root): se guarda como variables
  // seguras en Codemagic (grupo android_signing_custom) — cifradas, solo
  // los builds las leen. Nunca pasa por Firestore ni queda legible.
  const { appUser } = useAuth();
  const isRoot = appUser?.email === SUPERUSER_EMAIL;
  const [ksOpen, setKsOpen] = useState(false);
  const [ksBusy, setKsBusy] = useState(false);
  const [ksError, setKsError] = useState("");
  const [ksForm, setKsForm] = useState({ storePassword: "", keyAlias: "", keyPassword: "" });
  const [ksFile, setKsFile] = useState<File | null>(null);

  const handleUploadKeystore = async () => {
    if (!ksFile || !ksForm.storePassword || !ksForm.keyAlias || !ksForm.keyPassword) return;
    setKsBusy(true);
    setKsError("");
    try {
      const buf = await ksFile.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b64 = btoa(bin);
      await uploadAndroidKeystore(appId, {
        fileBase64: b64,
        storePassword: ksForm.storePassword,
        keyAlias: ksForm.keyAlias,
        keyPassword: ksForm.keyPassword,
      });
      if (project) {
        await setProjectKeystoreUploaded(project.id);
        await qc.invalidateQueries({ queryKey: ["projects"] });
      }
      setKsOpen(false);
      setKsForm({ storePassword: "", keyAlias: "", keyPassword: "" });
      setKsFile(null);
    } catch (e) {
      setKsError(e instanceof Error ? e.message : "Error al subir el keystore");
    } finally {
      setKsBusy(false);
    }
  };

  // Links de invitación (fijos por app; se configuran una sola vez).
  // Google/Apple no exponen estos links por API → se pegan una vez desde la consola.
  const editTestLink = (kind: TestLinkKind) => {
    if (!project) return;
    const label = TEST_LINKS[kind].help;
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
      PLATFORMS.some((p) =>
        b.workflowId === p.publishWorkflowId ||
        b.workflowId === p.promoteWorkflowId ||
        b.workflowId === p.storeDirectWorkflowId);
    for (const p of PLATFORMS) {
      add(
        builds.find((b) => platformOfBuild(b) === p.key && !isPublishOrPromote(b) && isSuccess(b))?._id,
        `último build ${p.label}`,
      );
      add(builds.find((b) => b.workflowId === p.publishWorkflowId && isSuccess(b))?._id, `en ${p.storeLabel}`);
      add(builds.find((b) => b.workflowId === p.promoteWorkflowId && isSuccess(b))?._id, `en ${p.promoteLabel}`);
      // Publicación directa (modo simple): también marca la tienda pública.
      add(builds.find((b) => b.workflowId === p.storeDirectWorkflowId && isSuccess(b))?._id, `en ${p.promoteLabel}`);
    }
    add(
      builds.find((b) => platformOfBuild(b) === "web" && isSuccess(b))?._id,
      "último build Web",
    );
    return m;
  }, [builds]);

  // Builds en curso: se muestran como card destacada, no como fila de historial.
  const runningBuilds = useMemo(() => builds.filter(isRunning), [builds]);

  // Duración promedio por workflow (builds exitosos) para estimar progreso.
  const avgDurationByWorkflow = useMemo(() => {
    const acc = new Map<string, number[]>();
    for (const b of builds) {
      if (!isSuccess(b) || !b.startedAt || !b.finishedAt) continue;
      const ms = new Date(b.finishedAt).getTime() - new Date(b.startedAt).getTime();
      if (ms > 0) acc.set(b.workflowId, [...(acc.get(b.workflowId) ?? []), ms]);
    }
    const m = new Map<string, number>();
    for (const [wf, arr] of acc) m.set(wf, arr.reduce((a, x) => a + x, 0) / arr.length);
    return m;
  }, [builds]);

  const filteredBuilds = useMemo(() => {
    return builds.filter((b) => {
      if (isRunning(b)) return false; // en curso → card destacada arriba
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

  // Builds recién disparados que Codemagic aún no reporta en GET /builds:
  // mantienen el botón bloqueado y muestran card "Iniciando…" de inmediato.
  // Se rastrea por buildId EXACTO (lo devuelve POST /builds) — nada de
  // heurísticas por fecha que se limpien antes de tiempo.
  const [pendingWorkflows, setPendingWorkflows] = useState<Record<string, { id: string; t: number }>>({});

  // Limpiar un pendiente solo cuando SU build ya aparece en la API (o tras 3 min).
  useEffect(() => {
    setPendingWorkflows((prev) => {
      const entries = Object.entries(prev);
      if (entries.length === 0) return prev;
      const next: Record<string, { id: string; t: number }> = {};
      for (const [wf, p] of entries) {
        const visible = builds.some((b) => b._id === p.id);
        if (!visible && Date.now() - p.t < 180_000) next[wf] = p;
      }
      return Object.keys(next).length === entries.length ? prev : next;
    });
  }, [builds]);

  // Mientras haya pendientes, refrescar seguido para que la card real aparezca pronto.
  useEffect(() => {
    if (Object.keys(pendingWorkflows).length === 0) return;
    const t = setInterval(() => qc.invalidateQueries({ queryKey: ["codemagic-builds", appId] }), 6000);
    return () => clearInterval(t);
  }, [pendingWorkflows, qc, appId]);

  // Modal de confirmación (reemplaza a window.confirm / window.prompt).
  // mode "start" = iniciar workflow · mode "cancel" = cancelar build en curso.
  const [confirmData, setConfirmData] = useState<
    | { mode: "start"; workflowId: string; key: string; label: string; askNotes: boolean }
    | { mode: "cancel"; buildId: string; label: string }
    | null
  >(null);
  const [notes, setNotes] = useState("");
  const [notesError, setNotesError] = useState("");

  const requestStart = (workflowId: string, key: string, opts?: { askNotes?: boolean; label?: string }) => {
    setNotes("");
    setNotesError("");
    setConfirmData({
      mode: "start",
      workflowId,
      key,
      label: opts?.label ?? WORKFLOW_LABELS[workflowId] ?? workflowId,
      askNotes: !!opts?.askNotes,
    });
  };

  const requestCancel = (buildId: string, label: string) => {
    setConfirmData({ mode: "cancel", buildId, label });
  };

  const doStart = async (workflowId: string, key: string, envVars?: Record<string, string>) => {
    setBusy(key);
    setError("");
    // Bloqueo optimista INMEDIATO (id temporal); se sustituye por el buildId
    // real cuando la API responde, o se revierte si el POST falla.
    setPendingWorkflows((p) => ({ ...p, [workflowId]: { id: `pending-${Date.now()}`, t: Date.now() } }));
    try {
      // Package Android configurado en el dashboard → env var del build/promote.
      // Se pasa solo si tiene valor; el gradle/codemagic.yaml tienen fallback.
      const pkg = project?.androidPackage?.trim();
      const mergedEnv = pkg ? { ANDROID_PACKAGE_NAME: pkg, ...envVars } : envVars;
      const buildId = await startBuild(appId, workflowId, effectiveBranch, mergedEnv);
      setPendingWorkflows((p) => ({ ...p, [workflowId]: { id: buildId, t: Date.now() } }));
      await refresh();
    } catch (e) {
      setPendingWorkflows((p) => {
        const next = { ...p };
        delete next[workflowId];
        return next;
      });
      setError(e instanceof Error ? e.message : "Error al iniciar el build");
    } finally {
      setBusy(null);
    }
  };

  const confirmModal = () => {
    if (!confirmData) return;
    if (confirmData.mode === "cancel") {
      const { buildId } = confirmData;
      setConfirmData(null);
      void doCancel(buildId);
      return;
    }
    if (confirmData.askNotes && !notes.trim()) {
      setNotesError("El comentario de la actualización es obligatorio.");
      return;
    }
    const { workflowId, key, askNotes } = confirmData;
    setConfirmData(null);
    void doStart(workflowId, key, askNotes ? { RELEASE_NOTES: notes.trim() } : undefined);
  };

  const doCancel = async (buildId: string) => {
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
            {project?.androidPackage && (
              <span
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground"
                title="Package Android (applicationId) que recibe el build"
              >
                {project.androidPackage}
              </span>
            )}
          </h3>
          {deployActive && (
            <span className="flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
              <Clock className="h-3 w-3" /> deploy web en curso
            </span>
          )}
          <span className="flex-1" />
          {project && perms.buildApp && (
            <button
              type="button"
              onClick={() => {
                setProjectDeployMode(project.id, simple ? "avanzado" : "simple")
                  .then(() => qc.invalidateQueries({ queryKey: ["projects"] }))
                  .catch((e) => setError(e instanceof Error ? e.message : "Error al cambiar el modo"));
              }}
              className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
              title={
                simple
                  ? "Modo simple: construir y publicar directo en la tienda. Clic para mostrar el flujo por etapas (Play interno / TestFlight y testers)."
                  : "Modo avanzado: flujo por etapas con canales de prueba. Clic para volver al flujo de un solo paso."
              }
            >
              modo: <span className="font-semibold">{simple ? "simple" : "avanzado"}</span>
            </button>
          )}
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
          <span className="text-[9px] text-muted-foreground/50" title="Versión del bundle en tu navegador">
            v{__APP_BUILD__}
          </span>
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
              pendingWorkflows={pendingWorkflows}
              onRequestStart={requestStart}
              simple={simple}
            />
          ))}
        </div>

        {/* Builds en curso: card destacada con fases, cronómetro y progreso */}
        {(runningBuilds.length > 0 || Object.keys(pendingWorkflows).length > 0) && (
          <div className="mt-3 space-y-2">
            {/* Recién disparados, aún no visibles en la API de Codemagic */}
            {Object.keys(pendingWorkflows)
              .filter((wf) => !builds.some((b) => b._id === pendingWorkflows[wf].id))
              .map((wf) => (
                <div
                  key={wf}
                  className="rounded-lg border border-blue-300/70 bg-gradient-to-br from-blue-50/80 via-background to-background p-3.5 dark:border-blue-800/50 dark:from-blue-950/30"
                >
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                    <span className="text-sm font-semibold">
                      Iniciando {WORKFLOW_LABELS[wf] ?? wf}…
                    </span>
                    <span className="text-xs text-muted-foreground">esperando a Codemagic</span>
                  </div>
                  <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-950/60">
                    <div className="h-full w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-blue-500 to-blue-400" />
                  </div>
                </div>
              ))}
            {runningBuilds.map((b) => {
              const wfName = WORKFLOW_LABELS[b.workflowId] ?? app?.workflows?.[b.workflowId]?.name ?? "Build";
              return (
                <ActiveBuildCard
                  key={b._id}
                  b={b}
                  wfName={wfName}
                  avgMs={avgDurationByWorkflow.get(b.workflowId) ?? null}
                  appId={appId}
                  canCancel={perms.buildApp}
                  busy={busy}
                  onCancel={(id) => requestCancel(id, wfName)}
                />
              );
            })}
          </div>
        )}

        {/* Estado de los tracks de Google Play (lo alimenta el workflow programado) */}
        {project?.androidPackage && <PlayTracksCard project={project} canRefresh={perms.buildApp} />}

        {/* Testers y canales de prueba: solo en modo avanzado */}
        {project && !simple && (
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
              {/* Links de invitación fijos por app (tracks de Play + TestFlight) */}
              {(Object.keys(TEST_LINKS) as TestLinkKind[]).map((kind) => {
                const url = project[kind];
                const label = TEST_LINKS[kind].label;
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
              {/* Keystore Android (solo root): se guarda cifrado en Codemagic */}
              {isRoot && (
                <span className="flex items-center gap-1">
                  <span className="text-[10px] text-muted-foreground/70">
                    Keystore Android:{" "}
                    {project?.androidKeystoreUploadedAt
                      ? `subido hace ${formatDistanceToNow(project.androidKeystoreUploadedAt)}`
                      : "sin subir"}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setKsError(""); setKsOpen(true); }}
                    className="text-[10px] text-muted-foreground underline hover:text-foreground"
                    title="Subir/actualizar el .jks — se guarda como variables cifradas en Codemagic"
                  >
                    {project?.androidKeystoreUploadedAt ? "actualizar" : "subir"}
                  </button>
                </span>
              )}
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
              {syncState === "syncing" && (
                <span className="flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400">
                  <Loader2 className="h-3 w-3 animate-spin" /> sincronizando a TestFlight…
                </span>
              )}
              {syncState === "error" && (
                <span className="text-[11px] text-amber-600 dark:text-amber-400">
                  ⚠ no se pudo disparar la sincronización a TestFlight (¿workflow sync-testflight-testers en main?)
                </span>
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
            {/* Notas de sincronización — qué es automático y qué es manual */}
            <div className="mt-2 space-y-1 rounded-md border border-amber-200/70 bg-amber-50/60 px-3 py-2 text-[11px] leading-relaxed dark:border-amber-900/40 dark:bg-amber-950/20">
              <p className="text-emerald-700 dark:text-emerald-400">
                ✅ <span className="font-semibold">iOS:</span> al agregar o quitar correos, la lista se
                sincroniza sola con TestFlight (grupo "SOZU Testers") — los nuevos reciben la invitación por correo.
              </p>
              <p className="text-amber-700 dark:text-amber-300">
                ⚠️ <span className="font-semibold">Android (Google Play):</span> Google no tiene API para esto —
                usa <span className="font-semibold">"copiar lista"</span> y pégala manualmente en Play Console →
                Testing → Internal testing → Testers, cada vez que cambie.
              </p>
              <p className="text-amber-700 dark:text-amber-300">
                ⚠️ <span className="font-semibold">Links de invitación:</span> ambos se configuran manualmente
                <span className="font-semibold"> una sola vez por app</span> (botón "configurar" aquí arriba) —
                Google/Apple no permiten leerlos por API.
              </p>
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
                (b.workflowId === "ios-publish" || b.workflowId === "ios-appstore" || b.workflowId === "ios-store");
              const isAndroidCloud = plat === "android" && info.tone === "success" &&
                (b.workflowId === "android-publish" || b.workflowId === "android-production" || b.workflowId === "android-store");
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
                      onClick={() => requestCancel(b._id, wfName || "build")}
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

        {/* Modal de subida del keystore Android (solo root) */}
        {ksOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
            onClick={() => !ksBusy && setKsOpen(false)}
          >
            <div
              className="w-full max-w-md rounded-xl border bg-background p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="flex items-center gap-2 text-base font-bold">
                <Upload className="h-5 w-5 text-primary" />
                Keystore Android (.jks)
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Se guarda como <span className="font-medium text-foreground">variables cifradas en Codemagic</span>{" "}
                (grupo android_signing_custom) — nunca queda legible ni pasa por Firestore.
                Los builds lo reconstruyen para firmar el release.
              </p>
              <div className="mt-3 space-y-2.5">
                <div>
                  <label className="text-xs font-medium">Archivo .jks / .keystore <span className="text-destructive">*</span></label>
                  <input
                    type="file"
                    accept=".jks,.keystore"
                    className="mt-1 w-full text-xs"
                    onChange={(e) => setKsFile(e.target.files?.[0] ?? null)}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium">Keystore password <span className="text-destructive">*</span></label>
                  <input
                    type="password"
                    className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 font-mono text-sm"
                    value={ksForm.storePassword}
                    onChange={(e) => setKsForm((f) => ({ ...f, storePassword: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium">Key alias <span className="text-destructive">*</span></label>
                  <input
                    type="text"
                    className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 font-mono text-sm"
                    placeholder="sozu"
                    value={ksForm.keyAlias}
                    onChange={(e) => setKsForm((f) => ({ ...f, keyAlias: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium">Key password <span className="text-destructive">*</span></label>
                  <input
                    type="password"
                    className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 font-mono text-sm"
                    value={ksForm.keyPassword}
                    onChange={(e) => setKsForm((f) => ({ ...f, keyPassword: e.target.value }))}
                  />
                </div>
                {ksError && <p className="text-xs text-destructive">{ksError}</p>}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline" size="sm" disabled={ksBusy} onClick={() => setKsOpen(false)}>
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  disabled={ksBusy || !ksFile || !ksForm.storePassword || !ksForm.keyAlias || !ksForm.keyPassword}
                  onClick={handleUploadKeystore}
                >
                  {ksBusy ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Upload className="h-4 w-4 mr-1.5" />}
                  Subir cifrado
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Modal de confirmación de build/publicación */}
        {confirmData && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
            onClick={() => setConfirmData(null)}
          >
            <div
              className="w-full max-w-md rounded-xl border bg-background p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {confirmData.mode === "cancel" ? (
                <>
                  <h3 className="flex items-center gap-2 text-base font-bold">
                    <XCircle className="h-5 w-5 text-destructive" />
                    Cancelar build
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Se detendrá el build en curso de{" "}
                    <span className="font-medium text-foreground">{confirmData.label}</span>.
                    El progreso se perderá y quedará marcado como cancelado.
                  </p>
                  <div className="mt-4 flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setConfirmData(null)}>
                      Volver
                    </Button>
                    <Button
                      size="sm"
                      className="bg-red-600 hover:bg-red-700 text-white"
                      onClick={confirmModal}
                    >
                      <XCircle className="h-4 w-4 mr-1.5" />
                      Cancelar build
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="flex items-center gap-2 text-base font-bold">
                    {confirmData.askNotes ? (
                      <Rocket className="h-5 w-5 text-emerald-600" />
                    ) : (
                      <Play className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                    )}
                    {confirmData.label}
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Se ejecutará en la rama{" "}
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      {effectiveBranch}
                    </code>{" "}
                    de <span className="font-medium text-foreground">{app?.appName ?? "la app"}</span>.
                  </p>
                  {confirmData.askNotes && (
                    <div className="mt-3">
                      <label className="text-xs font-medium">
                        ¿Qué se actualiza en esta versión? <span className="text-destructive">*</span>
                      </label>
                      <textarea
                        autoFocus
                        rows={3}
                        className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                        placeholder="Ej. Corrección del mapa de cómo llegar y mejoras de rendimiento"
                        value={notes}
                        onChange={(e) => {
                          setNotes(e.target.value);
                          if (notesError) setNotesError("");
                        }}
                      />
                      {notesError && <p className="mt-1 text-xs text-destructive">{notesError}</p>}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Este comentario se envía a la store como notas de la versión.
                      </p>
                    </div>
                  )}
                  <div className="mt-4 flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setConfirmData(null)}>
                      Cancelar
                    </Button>
                    <Button
                      size="sm"
                      className={confirmData.askNotes ? "bg-emerald-600 hover:bg-emerald-700 text-white" : undefined}
                      onClick={confirmModal}
                    >
                      {confirmData.askNotes ? (
                        <Rocket className="h-4 w-4 mr-1.5" />
                      ) : (
                        <Play className="h-4 w-4 mr-1.5" />
                      )}
                      Iniciar
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
