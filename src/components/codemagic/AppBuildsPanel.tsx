import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  formatBuildDate, uploadAndroidKeystore, uploadPlayServiceAccount, PLAY_CREDENTIALS_VAR,
  PLATFORMS, WORKFLOW_LABELS, SYNC_TESTERS_WORKFLOW, getBuild, failedStepName,
  type CodemagicBuild, type PlatformDef,
} from "@/lib/codemagic";
import { getAppStoreStatus, buildStateLabel } from "@/lib/appStoreStatus";
import { useAuth } from "@/hooks/useAuth";
import { getAllContributorPhones } from "@/lib/firestoreContributors";
import { registerBuildForNotification } from "@/lib/buildNotifications";
import {
  getProjectCredentialsMeta, setPlayServiceAccountForProject, setAppStoreConnectForProject,
} from "@/lib/storeCredentials";
import { isRootAdmin } from "@/lib/firestoreUsers";
import {
  setProjectKeystoreUploaded, setProjectDeployMode, setProjectPlayCredentialsUploaded,
} from "@/lib/firestoreProjects";
import { cn } from "@/lib/utils";
import type { CicdPermissions } from "@/lib/firestoreUsers";
import { setProjectTesters, setProjectTestLinks, type Project } from "@/lib/firestoreProjects";
import { PlayTracksCard } from "./PlayTracksCard";
import { AppStoreStatusCard } from "./AppStoreStatusCard";
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

/**
 * Paso que tumbó un build fallido. La lista de `/builds` no trae los pasos, así
 * que se pide el detalle: "falló" a secas no distingue un test roto de un envío
 * a revisión rechazado, y son problemas de dueños distintos.
 */
function PasoQueFallo({ buildId }: { buildId: string }) {
  const { data } = useQuery({
    queryKey: ["codemagic-build", buildId],
    queryFn: () => getBuild(buildId),
    // Un build terminado ya no cambia: se pide una vez y se queda en caché.
    staleTime: 60 * 60_000,
    retry: false,
  });
  const paso = failedStepName(data);
  if (!paso) return null;
  return (
    <span
      className="font-medium text-red-700 dark:text-red-300"
      title={`El build murió en el paso "${paso}". Abre el build para ver el log de ese paso.`}
    >
      en: {paso}
    </span>
  );
}

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

// A qué canal fue cada publicación. Se declara workflow por workflow porque
// con un ternario por defecto un workflow nuevo se anuncia como canal de
// pruebas: `android-store` publica en producción y salía como "Play interno".
const DESTINO_PUBLICACION: Record<string, { label: string; produccion: boolean }> = {
  "android-publish": { label: "Play interno", produccion: false },
  "android-production": { label: "Play Store", produccion: true },
  "android-store": { label: "Play Store", produccion: true },
  "ios-publish": { label: "TestFlight", produccion: false },
  "ios-appstore": { label: "App Store Connect", produccion: true },
  "ios-store": { label: "App Store Connect", produccion: true },
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
  b, wfName, avgMs, appId, canCancel, estaBusy, onCancel,
}: {
  b: CodemagicBuild;
  wfName: string;
  avgMs: number | null;
  appId: string;
  canCancel: boolean;
  /** Predicado por clave: cada acción lleva su propio estado, no uno compartido. */
  estaBusy: (key: string) => boolean;
  onCancel: (id: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Un build que Codemagic todavía no arranca (espera turno de máquina) NO
  // tiene `startedAt`. Antes se caía a `createdAt`, así que el cronómetro y la
  // barra corrían durante la cola: un build encolado llegaba a "85%" sin haber
  // empezado, y al liberarse la máquina —justo cuando terminaba el build de la
  // otra plataforma— aparecía `startedAt`, el tiempo se recalculaba desde el
  // arranque real y la barra caía a cero. Parecía que el build se había
  // reiniciado solo; en realidad recién empezaba.
  const enCola = !b.startedAt;
  const referenciaIso = b.startedAt ?? b.createdAt;
  const elapsedMs = referenciaIso ? Math.max(0, now - new Date(referenciaIso).getTime()) : 0;
  const mm = Math.floor(elapsedMs / 60000);
  const ss = String(Math.floor(elapsedMs / 1000) % 60).padStart(2, "0");
  // El progreso estimado solo tiene sentido con el build corriendo: en cola no
  // se estima nada, se dice que está esperando.
  const pct = !enCola && avgMs ? Math.min(96, Math.round((elapsedMs / avgMs) * 100)) : null;

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
        <span className={cn("font-mono text-sm font-semibold tabular-nums", enCola ? "text-muted-foreground" : theme.timer)}>
          {mm}:{ss}
        </span>
        {enCola ? (
          <span
            className="text-[10px] font-medium text-amber-600 dark:text-amber-400"
            title={
              "Codemagic todavía no le asigna máquina. El cronómetro cuenta la espera, no el build: " +
              "cuando arranque de verdad, el tiempo empieza de cero. Cuántos builds corren a la vez " +
              "depende del plan de Codemagic, no del dashboard."
            }
          >
            en cola · aún no arranca
          </span>
        ) : avgMs ? (
          <span className="text-[10px] text-muted-foreground">
            / ~{Math.round(avgMs / 60000)}m típico
          </span>
        ) : null}
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
            disabled={estaBusy(b._id)}
            onClick={() => onCancel(b._id)}
            className="flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 text-xs text-destructive hover:bg-red-50 disabled:opacity-50 dark:border-red-900/50 dark:hover:bg-red-950/30"
          >
            {estaBusy(b._id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
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
  platform, branch, builds, headSha, deployActive, perms, estaBusy, pendingWorkflows, onRequestStart, simple,
  project,
}: {
  platform: PlatformDef;
  branch: string;
  builds: CodemagicBuild[];
  headSha: string | null | undefined;
  deployActive: boolean;
  perms: CicdPermissions;
  estaBusy: (key: string) => boolean;
  pendingWorkflows: Record<string, { id: string; t: number }>;
  onRequestStart: (workflowId: string, key: string, opts?: { askNotes?: boolean; label?: string }) => void;
  /** Modo simple: Construir + un solo botón que publica directo en la tienda. */
  simple: boolean;
  project?: Project;
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
    !canPublish ? `Primero construye el artefacto ${platform.label} del código actual` :
    // Con las tres etapas a la vista el botón sigue en pantalla después de
    // publicar, así que hay que decir que ya está hecho o invita a repetirlo.
    publishedCurrent ? `Este código ya está en ${platform.storeLabel}` : null;

  // ---------------------------------------------------------------------------
  // iOS: el binario que se va a promover tiene que estar PROCESADO en Apple.
  //
  // Apple tarda minutos en procesar un .ipa recien subido. Si se manda a
  // revision antes, el workflow no encuentra el build nuevo y aborta (asi esta
  // el guard en codemagic.yaml). Aqui el boton se habilita solo cuando App
  // Store Connect ya reporta ese build como VALID.
  //
  // El dato lo vuelca a Firestore un sync programado cada 15 min, asi que
  // puede venir atrasado: de ahi el "comprobar ahora", que dispara el sync.
  // Sin el, el boton podria quedarse gris un cuarto de hora despues de que
  // Apple ya termino, que seria peor que no tener gate.
  // ---------------------------------------------------------------------------
  const gateApple = platform.tresEtapas && !!project?.iosBundleId;
  const { data: appStore, isFetching: appStoreFetching } = useQuery({
    queryKey: ["appstore-status", project?.iosBundleId],
    queryFn: () => getAppStoreStatus(project!.iosBundleId!),
    enabled: gateApple,
    refetchInterval: 60_000,
  });
  const ultimoSubido = appStore?.builds?.[0];
  const binarioListo = ultimoSubido?.processingState === "VALID";
  const [pidiendoSync, setPidiendoSync] = useState(false);
  const comprobarAhora = async () => {
    setPidiendoSync(true);
    try {
      await triggerPlayTracksSync();
    } catch {
      /* best-effort: el cron llega igual, y el estado se ve en la card de abajo */
    } finally {
      setPidiendoSync(false);
    }
  };

  const promoteDisabledReason =
    promoteInProgress ? "Envío a la store en curso" :
    promotedCurrent ? "Este código ya fue enviado a la store" :
    gateApple && !appStore ? "Aún sin datos de App Store Connect: pulsa \"comprobar ahora\"" :
    gateApple && !ultimoSubido ? "App Store Connect no reporta ningún binario subido todavía" :
    gateApple && !binarioListo
      ? `Apple sigue procesando el build ${ultimoSubido?.version ?? "—"} (${buildStateLabel(ultimoSubido?.processingState)}). Suele tardar entre 10 y 30 min.`
      : null;

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

  // Los dos botones del flujo por etapas, como variables: con `tresEtapas` se
  // pintan los dos a la vez y sin él se alternan, pero el JSX es el mismo.
  const botonPruebas = (
    <Button
      size="sm"
      title={publishDisabledReason ?? `Construir y enviar a ${platform.storeLabel}`}
      disabled={!!publishDisabledReason || estaBusy(publishKey)}
      onClick={() => onRequestStart(platform.publishWorkflowId, publishKey, { label: `Enviar a ${platform.storeLabel}` })}
    >
      {publishInProgress || estaBusy(publishKey) ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
      ) : publishedCurrent ? (
        <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
      ) : (
        <Upload className="h-3.5 w-3.5 mr-1.5" />
      )}
      {publishInProgress ? "Publicando…" : platform.storeLabel}
    </Button>
  );

  const botonTienda = (
    <Button
      size="sm"
      className="bg-emerald-600 hover:bg-emerald-700 text-white"
      title={promoteDisabledReason ?? `Enviar a ${platform.promoteLabel} (pide comentario de la versión)`}
      disabled={!!promoteDisabledReason || estaBusy(promoteKey)}
      onClick={() => onRequestStart(platform.promoteWorkflowId, promoteKey, { askNotes: true, label: `Enviar a ${platform.promoteLabel}` })}
    >
      {promoteInProgress || estaBusy(promoteKey) ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
      ) : (
        <Rocket className="h-3.5 w-3.5 mr-1.5" />
      )}
      {promoteInProgress ? "Enviando…" : platform.promoteLabel}
    </Button>
  );

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
            disabled={!!buildDisabledReason || estaBusy(buildKey)}
            onClick={() => onRequestStart(platform.buildWorkflowId, buildKey, { label: `Construir ${platform.label}` })}
          >
            {buildInProgress || estaBusy(buildKey) ? (
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
              disabled={!!storeDisabledReason || estaBusy(storeKey)}
              onClick={() => onRequestStart(platform.storeDirectWorkflowId, storeKey, {
                askNotes: true, label: `Publicar en ${platform.promoteLabel}`,
              })}
            >
              {storeInProgress || estaBusy(storeKey) ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <Rocket className="h-3.5 w-3.5 mr-1.5" />
              )}
              {storeInProgress ? "Publicando…" : platform.promoteLabel}
            </Button>
          ) : platform.tresEtapas ? (
            // iOS: las tres etapas a la vista. TestFlight no es un paso que se
            // salte (es la unica forma de instalar el .ipa sin Mac), y entre
            // subirlo y poder mandarlo a revision hay una espera de Apple que
            // conviene ver en pantalla en vez de adivinar.
            <>
              {botonPruebas}
              {botonTienda}
            </>
          ) : !publishedCurrent ? (

            botonPruebas
          ) : (
            botonTienda

          )}
        </>
      )}
      {(buildDisabledReason || (simple && storeDisabledReason)) && (
        <span className="w-full text-[10px] text-muted-foreground sm:w-auto">
          {buildDisabledReason ?? storeDisabledReason}
        </span>
      )}
      {/* El motivo del gate de Apple va escrito, no solo en el tooltip: es una
          espera de minutos y el usuario necesita saber que no se rompió nada. */}
      {!simple && platform.tresEtapas && perms.buildApp && promoteDisabledReason && !promotedCurrent && (
        <span className="flex w-full items-center gap-1.5 text-[10px] text-muted-foreground">
          <Clock className="h-3 w-3 shrink-0" />
          <span>{promoteDisabledReason}</span>
          {gateApple && (
            <button
              type="button"
              onClick={comprobarAhora}
              disabled={pidiendoSync || appStoreFetching}
              className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
              title="Pide a Apple el estado ahora, sin esperar al sync de cada 15 min"
            >
              {pidiendoSync || appStoreFetching ? "comprobando…" : "comprobar ahora"}
            </button>
          )}
          {appStore?.updatedAt && (
            <span className="text-muted-foreground/70">
              · estado de {formatDistanceToNow(appStore.updatedAt)}
            </span>
          )}
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

  // Acciones en vuelo, por clave. Antes era un solo string: con Android e iOS
  // trabajando a la vez, la primera acción que terminaba ponía `busy` en null y
  // le apagaba el spinner a la otra, que seguía corriendo. Un conjunto mantiene
  // cada plataforma con su propio estado.
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set());
  const marcarBusy = (key: string, activo: boolean) =>
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (activo) next.add(key);
      else next.delete(key);
      return next;
    });
  const estaBusy = (key: string | null) => !!key && busyKeys.has(key);
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
  const isRoot = isRootAdmin(appUser);
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

  // Cuenta de servicio de Google Play: sin ella el workflow recibe una cadena
  // vacía y falla con "Expecting value: line 1 column 1 (char 0)".
  const [saOpen, setSaOpen] = useState(false);
  const [saBusy, setSaBusy] = useState(false);
  const [saError, setSaError] = useState("");
  const [saJson, setSaJson] = useState("");

  const handleUploadServiceAccount = async () => {
    if (!saJson.trim()) return;
    setSaBusy(true);
    setSaError("");
    try {
      await uploadPlayServiceAccount(appId, saJson);
      // El mismo JSON le sirve al sync que lee los tracks de Play de ESTA app:
      // sin esto había que crear el secret en Secret Manager a mano y, mientras
      // faltara, las versiones de tienda salían vacías en las cards.
      let falloElSync: string | null = null;
      if (!project) {
        // Sin proyecto no hay dónde guardar: las credenciales viven en
        // `projects/{id}/private`, así que se avisa en vez de perderlas en silencio.
        falloElSync = "esta app no está ligada a un proyecto del dashboard";
      } else if (!appUser?.email) {
        // Sin sesión identificada no hay a quién atribuir el cambio. Antes esta
        // rama no existía y el guardado se saltaba en silencio: la subida a
        // Codemagic salía bien y el estado de tiendas se quedaba vacío sin que
        // nadie supiera por qué.
        falloElSync = "no se pudo identificar tu sesión; vuelve a entrar";
      } else {
        try {
          await setPlayServiceAccountForProject(project.id, saJson, appUser.email);
          await qc.invalidateQueries({ queryKey: ["project-credentials-meta", project.id] });
        } catch (e) {
          // Que falle esto no invalida la subida a Codemagic, que es lo que
          // permite publicar. Pero el modal NO se cierra: cerrarlo dejaba el
          // aviso invisible y parecía que todo había quedado bien, mientras el
          // sync seguía diciendo que no había credenciales.
          falloElSync = e instanceof Error ? e.message : "error desconocido";
        }
      }
      if (project) {
        await setProjectPlayCredentialsUploaded(project.id);
        await qc.invalidateQueries({ queryKey: ["projects"] });
      }
      if (falloElSync) {
        setSaError(
          `Guardado en Codemagic para publicar, pero NO para el estado de tiendas de esta app: ${falloElSync}. ` +
          "Las versiones de tienda de esta app seguirán vacías hasta que esto funcione.",
        );
        return;
      }
      setSaOpen(false);
      setSaJson("");
    } catch (e) {
      setSaError(e instanceof Error ? e.message : "Error al guardar las credenciales");
    } finally {
      setSaBusy(false);
    }
  };

  // Llave de App Store Connect de esta app: la usa el sync para leer su estado
  // en iOS (versión a la venta, revisión, builds). Solo el root puede guardarla.
  const [ascOpen, setAscOpen] = useState(false);
  const [ascBusy, setAscBusy] = useState(false);
  const [ascError, setAscError] = useState("");
  const [asc, setAsc] = useState({ keyId: "", issuerId: "", privateKey: "" });
  const { data: credsMeta } = useQuery({
    queryKey: ["project-credentials-meta", project?.id],
    queryFn: () => getProjectCredentialsMeta(project!.id).catch(() => null),
    enabled: !!project,
    staleTime: 60_000,
  });

  const handleSaveAsc = async () => {
    if (!project) {
      setAscError("Esta app no está ligada a un proyecto del dashboard: no hay dónde guardar la llave.");
      return;
    }
    setAscBusy(true);
    setAscError("");
    try {
      await setAppStoreConnectForProject(project.id, asc, appUser!.email);
      await qc.invalidateQueries({ queryKey: ["project-credentials-meta", project.id] });
      setAscOpen(false);
      setAsc({ keyId: "", issuerId: "", privateKey: "" });
    } catch (e) {
      setAscError(e instanceof Error ? e.message : "Error al guardar la llave");
    } finally {
      setAscBusy(false);
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
    // Guardia contra el disparo doble: si ese workflow ya tiene un build vivo
    // —corriendo o esperando turno de máquina— lanzar otro no lo adelanta, solo
    // encola trabajo repetido y confunde cuál es cuál. Cada plataforma sigue
    // siendo independiente: esto solo mira SU workflow.
    const yaVivo = builds.some((b) => b.workflowId === workflowId && isRunning(b));
    if (yaVivo || pendingWorkflows[workflowId] !== undefined) {
      setError(
        `${WORKFLOW_LABELS[workflowId] ?? workflowId} ya tiene un build en curso o en cola. ` +
        "Espera a que termine o cancélalo antes de lanzar otro.",
      );
      return;
    }
    marcarBusy(key, true);
    setError("");
    // Bloqueo optimista INMEDIATO (id temporal); se sustituye por el buildId
    // real cuando la API responde, o se revierte si el POST falla.
    setPendingWorkflows((p) => ({ ...p, [workflowId]: { id: `pending-${Date.now()}`, t: Date.now() } }));
    try {
      // Package Android configurado en el dashboard → env var del build/promote.
      // Se pasa solo si tiene valor; el gradle/codemagic.yaml tienen fallback.
      const pkg = project?.androidPackage?.trim();
      // Teléfono de quien lanza, para avisarle por WhatsApp cuando termine: un
      // build tarda ~10 min y nadie se queda mirando la pestaña. Va por dos
      // vías: la variable de entorno que usa el propio workflow, y el registro
      // en Firestore que lee el sync — que es el que avisa aunque el build
      // reviente antes de llegar a su paso de notificación.
      const telefono = appUser?.githubLogin ? (await getAllContributorPhones())[appUser.githubLogin] : undefined;
      // Ya NO se inyecta `WA_PHONE`: el aviso lo manda el sync desde fuera del
      // build. Si se siguiera pasando, los `codemagic.yaml` que aún notifican al
      // final mandarían un segundo mensaje en cada build exitoso — y seguirían
      // sin mandar nada en los que fallan, que es lo que se vino a arreglar.
      const mergedEnv: Record<string, string> = {
        ...(pkg ? { ANDROID_PACKAGE_NAME: pkg } : {}),
        ...envVars,
      };
      const buildId = await startBuild(appId, workflowId, effectiveBranch, mergedEnv);
      setPendingWorkflows((p) => ({ ...p, [workflowId]: { id: buildId, t: Date.now() } }));
      // Deja dicho a quién avisarle cuando termine. No se espera ni se muestra
      // error: el build ya salió, y sin este registro el sync igual avisa al
      // teléfono administrativo de la empresa.
      if (project) {
        void registerBuildForNotification({
          buildId,
          projectId: project.id,
          appId,
          workflowId,
          branch: effectiveBranch,
          actorLogin: appUser?.githubLogin,
          actorPhone: telefono,
          actorEmail: appUser?.email,
        });
      }
      await refresh();
    } catch (e) {
      setPendingWorkflows((p) => {
        const next = { ...p };
        delete next[workflowId];
        return next;
      });
      setError(e instanceof Error ? e.message : "Error al iniciar el build");
    } finally {
      marcarBusy(key, false);
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
    marcarBusy(buildId, true);
    setError("");
    try {
      await cancelBuild(buildId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cancelar el build");
    } finally {
      marcarBusy(buildId, false);
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
              estaBusy={estaBusy}
              pendingWorkflows={pendingWorkflows}
              onRequestStart={requestStart}
              simple={simple}
              project={project}
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
                  estaBusy={estaBusy}
                  onCancel={(id) => requestCancel(id, wfName)}
                />
              );
            })}
          </div>
        )}

        {/* Credenciales de publicación (solo root). Fuera de la sección de
            testers: en modo simple esa sección no se muestra y estas dos cosas
            son justo las que hacen falta para poder publicar. */}
        {isRoot && project && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-dashed px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Credenciales de esta app
            </span>
            {/* El por qué de que sean por app: la cuenta de tienda es de la
                empresa dueña de cada app, no del dashboard. */}
            <span className="w-full text-[10px] text-muted-foreground/70">
              Cada app publica con su propia cuenta de tienda: estas credenciales son solo de este
              proyecto y no se comparten con las demás apps del dashboard.
            </span>
            <span className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground/70">
                Keystore:{" "}
                {project.androidKeystoreUploadedAt
                  ? `subido hace ${formatDistanceToNow(project.androidKeystoreUploadedAt)}`
                  : "sin subir"}
              </span>
              <button
                type="button"
                onClick={() => { setKsError(""); setKsOpen(true); }}
                className="text-[10px] text-muted-foreground underline hover:text-foreground"
                title="Subir/actualizar el .jks — se guarda como variables cifradas en Codemagic"
              >
                {project.androidKeystoreUploadedAt ? "actualizar" : "subir"}
              </button>
            </span>
            <span className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground/70">
                Cuenta de servicio de Play de esta app:{" "}
                {project.playCredentialsUploadedAt
                  ? `subida hace ${formatDistanceToNow(project.playCredentialsUploadedAt)}`
                  : "sin subir"}
              </span>
              <button
                type="button"
                onClick={() => { setSaError(""); setSaOpen(true); }}
                className="text-[10px] text-muted-foreground underline hover:text-foreground"
                title="JSON del service account de Play Console de esta app — sin esto Codemagic no puede publicarla en Google Play"
              >
                {project.playCredentialsUploadedAt ? "actualizar" : "subir"}
              </button>
            </span>
            {!project.playCredentialsUploadedAt && (
              <span className="text-[10px] text-amber-600 dark:text-amber-400">
                Falta la cuenta de servicio de esta app: su publicación a Play fallará.
              </span>
            )}
            {/* El mismo JSON tiene que quedar guardado para el sync, y eso es
                aparte de Codemagic: sin este aviso no había forma de ver que
                faltaba, salvo leer el log del workflow. */}
            {isRoot && project.playCredentialsUploadedAt && !credsMeta?.playUpdatedAt && (
              <span className="text-[10px] text-amber-600 dark:text-amber-400">
                La cuenta de servicio está en Codemagic pero no guardada para leer las versiones
                de tienda de esta app: vuelve a subir la de ESTA app (recarga antes la página).
              </span>
            )}
            {isRoot && credsMeta?.playUpdatedAt && (
              <span className="text-[10px] text-muted-foreground/70">
                Service account de Play de esta app · guardado el{" "}
                {formatBuildDate(credsMeta.playUpdatedAt)}
                {credsMeta.playUpdatedBy ? ` por ${credsMeta.playUpdatedBy}` : ""}
              </span>
            )}
            {/* Llave de App Store Connect: solo la usa el sync que lee el estado
                en iOS, así que se ofrece cuando el proyecto tiene bundle id. */}
            {isRoot && project.iosBundleId && (
              <span className="flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground/70">
                  Llave de App Store Connect de esta app:{" "}
                  {credsMeta?.ascUpdatedAt
                    ? `guardada el ${formatBuildDate(credsMeta.ascUpdatedAt)}` +
                      (credsMeta.ascUpdatedBy ? ` por ${credsMeta.ascUpdatedBy}` : "")
                    : "sin guardar"}
                </span>
                <button
                  type="button"
                  onClick={() => { setAscError(""); setAscOpen(true); }}
                  className="text-[10px] text-muted-foreground underline hover:text-foreground"
                  title="Key ID, Issuer ID y .p8 de la App Store Connect API de esta app — sin esto el dashboard no puede leer su estado en iOS"
                >
                  {credsMeta?.ascUpdatedAt ? "actualizar" : "guardar"}
                </button>
              </span>
            )}
            {isRoot && project.iosBundleId && !credsMeta?.ascUpdatedAt && (
              <span className="text-[10px] text-amber-600 dark:text-amber-400">
                Sin la llave de App Store Connect de esta app no se puede mostrar su versión de iOS.
              </span>
            )}
          </div>
        )}

        {/* Estado en las tiendas (lo alimenta el workflow programado) */}
        {project?.androidPackage && <PlayTracksCard project={project} canRefresh={perms.buildApp} />}
        {project?.iosBundleId && <AppStoreStatusCard project={project} />}

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
              const destino = DESTINO_PUBLICACION[b.workflowId ?? ""];
              // Publicó en la nube = está en DESTINO_PUBLICACION, así no hay
              // dos listas de workflows que mantener en sincronía.
              const isIosCloud = plat === "ios" && info.tone === "success" && !!destino;
              const isAndroidCloud = plat === "android" && info.tone === "success" && !!destino;
              return (
                <div key={b._id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs">
                  <span className={cn("shrink-0 rounded-full border px-2 py-0.5 font-medium", TONE_CLASSES[info.tone])}>
                    {info.label}
                  </span>
                  <span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold", PLAT_META[plat].cls)}>
                    {PLAT_META[plat].label}
                  </span>
                  {wfName && <span className="font-medium">{wfName}</span>}
                  {info.tone === "failed" && <PasoQueFallo buildId={b._id} />}
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
                      title={
                        destino?.produccion
                          ? "Enviado a revisión de App Store. Su estado se ve en App Store Connect."
                          : "El build vive en la nube de Apple: instálalo desde la app TestFlight."
                      }
                      className="flex items-center gap-1 rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-sky-700 hover:bg-sky-100 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300"
                    >
                      <Cloud className="h-3 w-3" />
                      {destino?.label ?? "App Store Connect"}
                    </a>
                  )}
                  {isAndroidCloud && (
                    <a
                      href={
                        !destino?.produccion && project?.playInternalUrl
                          ? project.playInternalUrl
                          : "https://play.google.com/console"
                      }
                      target="_blank"
                      rel="noreferrer"
                      title={
                        destino?.produccion
                          ? "Publicado en el canal de producción de Google Play. Su estado (revisión incluida) se ve en Play Console."
                          : "El build está en el canal interno de Google Play. Link de invitación: Play Console → Testing → Internal testing → Testers → Copy link"
                      }
                      className="flex items-center gap-1 rounded border border-lime-200 bg-lime-50 px-1.5 py-0.5 text-lime-700 hover:bg-lime-100 dark:border-lime-900/50 dark:bg-lime-950/30 dark:text-lime-300"
                    >
                      <Cloud className="h-3 w-3" />
                      {destino?.label ?? "Play Store"}
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
                      disabled={estaBusy(b._id)}
                      onClick={() => requestCancel(b._id, wfName || "build")}
                      className="flex items-center gap-1 text-destructive hover:opacity-80 disabled:opacity-50"
                      title="Cancelar build"
                    >
                      {estaBusy(b._id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
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

        {/* Cuenta de servicio de Google Play (solo root) */}
        {saOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
            onClick={() => !saBusy && setSaOpen(false)}
          >
            <div
              className="w-full max-w-lg rounded-xl border bg-background p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="flex items-center gap-2 text-base font-semibold">
                <Upload className="h-4 w-4 text-lime-600" />
                Cuenta de servicio de Google Play de esta app
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Pega el JSON completo del service account de ESTA app (Play Console → Setup →
                API access). Se guarda como la variable cifrada{" "}
                <span className="font-mono text-[11px] text-foreground">{PLAY_CREDENTIALS_VAR}</span>{" "}
                en el grupo <span className="font-mono text-[11px] text-foreground">android_signing_custom</span>,
                que es de donde la lee el build. Ponerla en otro grupo es lo que produce el error
                "Expecting value: line 1 column 1". Queda guardada solo para esta app: las demás
                usan la cuenta de tienda de su propia empresa.
              </p>
              <textarea
                className="mt-3 h-44 w-full rounded-md border bg-background px-3 py-2 font-mono text-[11px]"
                placeholder={'{\n  "type": "service_account",\n  "project_id": "…",\n  "private_key": "-----BEGIN PRIVATE KEY-----\\n…",\n  "client_email": "…@….iam.gserviceaccount.com"\n}'}
                spellCheck={false}
                value={saJson}
                onChange={(e) => setSaJson(e.target.value)}
              />
              {saError && <p className="mt-1 text-xs text-destructive">{saError}</p>}
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline" size="sm" disabled={saBusy} onClick={() => setSaOpen(false)}>
                  Cancelar
                </Button>
                <Button size="sm" disabled={saBusy || !saJson.trim()} onClick={handleUploadServiceAccount}>
                  {saBusy ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Upload className="h-4 w-4 mr-1.5" />}
                  Guardar cifrado
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Llave de App Store Connect (solo root) */}
        {ascOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
            onClick={() => !ascBusy && setAscOpen(false)}
          >
            <div
              className="w-full max-w-lg rounded-xl border bg-background p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="flex items-center gap-2 text-base font-semibold">
                <Upload className="h-4 w-4 text-sky-600" />
                Llave de App Store Connect de esta app
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                De la cuenta de App Store Connect de ESTA app → Users and Access → Integrations →
                App Store Connect API. Con permiso de lectura basta: solo se consulta su estado
                (versión a la venta, revisión y builds) para mostrarlo en el dashboard.
              </p>
              <div className="mt-3 grid gap-2">
                <input
                  className="w-full rounded-md border bg-background px-3 py-2 font-mono text-[11px]"
                  placeholder="Key ID (p. ej. 2X9ABC3DEF)"
                  value={asc.keyId}
                  onChange={(e) => setAsc({ ...asc, keyId: e.target.value })}
                />
                <input
                  className="w-full rounded-md border bg-background px-3 py-2 font-mono text-[11px]"
                  placeholder="Issuer ID (el UUID de la parte de arriba)"
                  value={asc.issuerId}
                  onChange={(e) => setAsc({ ...asc, issuerId: e.target.value })}
                />
                <textarea
                  className="h-36 w-full rounded-md border bg-background px-3 py-2 font-mono text-[11px]"
                  placeholder={"-----BEGIN PRIVATE KEY-----\n…contenido del .p8…\n-----END PRIVATE KEY-----"}
                  spellCheck={false}
                  value={asc.privateKey}
                  onChange={(e) => setAsc({ ...asc, privateKey: e.target.value })}
                />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                El .p8 solo se puede descargar una vez desde Apple: guárdalo también fuera de aquí.
                Una vez enviado, nadie puede volver a leerlo desde el dashboard — solo sustituirlo.
              </p>
              {ascError && <p className="mt-1 text-xs text-destructive">{ascError}</p>}
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline" size="sm" disabled={ascBusy} onClick={() => setAscOpen(false)}>
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  disabled={ascBusy || !asc.keyId.trim() || !asc.issuerId.trim() || !asc.privateKey.trim()}
                  onClick={handleSaveAsc}
                >
                  {ascBusy ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Upload className="h-4 w-4 mr-1.5" />}
                  Guardar
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
