// ---------------------------------------------------------------------------
// Cliente de la REST API de Codemagic (https://docs.codemagic.io/rest-api/)
// Llamadas directas desde el navegador: la API soporta CORS y autentica con
// el header `x-auth-token`. El token se embebe en el bundle vía VITE_*, igual
// que los PATs de GitHub (gate de permisos = solo UI).
// ---------------------------------------------------------------------------

const API = "https://api.codemagic.io";
const TOKEN = import.meta.env.VITE_CODEMAGIC_TOKEN as string | undefined;

/** Sin token configurado, toda la UI de builds se oculta. */
export const isCodemagicConfigured = !!TOKEN;

export interface CodemagicApp {
  _id: string;
  appName: string;
  workflowIds: string[];
  workflows: Record<string, { name: string }>;
  branches: string[];
  repository?: { htmlUrl?: string; defaultBranch?: string };
}

/** owner/repo de GitHub de la app (para consultar HEAD de rama y deploys). */
export function appRepo(app?: CodemagicApp): { owner: string; repo: string } | null {
  const m = app?.repository?.htmlUrl?.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// ---------------------------------------------------------------------------
// Convención de workflows por plataforma (ids = claves en codemagic.yaml):
//   <plataforma>-release  → solo construye el artefacto
//   <plataforma>-publish  → construye Y publica en la store
// ---------------------------------------------------------------------------
export interface PlatformDef {
  key: "android" | "ios";
  label: string;
  buildWorkflowId: string;
  publishWorkflowId: string;
  storeLabel: string;
  /** Paso final: promover a la store pública (exige comentario de release). */
  promoteWorkflowId: string;
  promoteLabel: string;
}

export const PLATFORMS: PlatformDef[] = [
  {
    key: "android", label: "Android",
    buildWorkflowId: "android-release",
    publishWorkflowId: "android-publish", storeLabel: "Play interno",
    promoteWorkflowId: "android-production", promoteLabel: "Play Store",
  },
  {
    key: "ios", label: "iOS",
    buildWorkflowId: "ios-release",
    publishWorkflowId: "ios-publish", storeLabel: "TestFlight",
    promoteWorkflowId: "ios-appstore", promoteLabel: "App Store",
  },
];

export const WORKFLOW_LABELS: Record<string, string> = {
  "android-release": "Android build",
  "ios-release": "iOS build",
  "android-publish": "Android → Play interno",
  "ios-publish": "iOS → TestFlight",
  "android-production": "Android → Play Store",
  "ios-appstore": "iOS → App Store",
  "web-release": "Web build",
};

export interface CodemagicArtefact {
  name: string;
  type: string;
  url: string;
  size?: number;
}

export interface CodemagicBuild {
  _id: string;
  appId: string;
  workflowId: string;
  branch: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
  artefacts?: CodemagicArtefact[];
  message?: string; // mensaje del commit
  version?: string;
  index?: number; // número de build
  commit?: { hash?: string; sha?: string; commitMessage?: string };
}

/** Hash del commit construido en el build (la API varía el nombre del campo). */
export const buildCommitSha = (b: CodemagicBuild): string | null =>
  b.commit?.hash ?? b.commit?.sha ?? null;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "x-auth-token": TOKEN ?? "",
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Codemagic ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/** Lista todas las apps de la cuenta de Codemagic. */
export async function getCodemagicApps(): Promise<CodemagicApp[]> {
  const data = await request<{ applications: CodemagicApp[] }>("/apps");
  return data.applications ?? [];
}

/** Builds recientes de una app (más nuevos primero). */
export async function getRecentBuilds(appId: string, limit = 25): Promise<CodemagicBuild[]> {
  const data = await request<{ builds: CodemagicBuild[] }>(`/builds?appId=${appId}`);
  return (data.builds ?? []).slice(0, limit);
}

/** Fecha y hora local legible, p.ej. "08 jul, 11:14". */
export function formatBuildDate(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-MX", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

/** Dispara un workflow. La publicación a stores la hace el propio workflow. */
export async function startBuild(
  appId: string,
  workflowId: string,
  branch: string,
  envVars?: Record<string, string>,
): Promise<string> {
  const data = await request<{ buildId: string }>("/builds", {
    method: "POST",
    body: JSON.stringify({
      appId,
      workflowId,
      branch,
      ...(envVars ? { environment: { variables: envVars } } : {}),
    }),
  });
  return data.buildId;
}

export async function cancelBuild(buildId: string): Promise<void> {
  await request(`/builds/${buildId}/cancel`, { method: "POST" });
}

export const buildUrl = (appId: string, buildId: string) =>
  `https://codemagic.io/app/${appId}/build/${buildId}`;

const RUNNING_STATUSES = new Set([
  "queued", "preparing", "fetching", "building", "testing", "publishing", "finishing",
]);

export interface BuildStatusInfo {
  label: string;
  isRunning: boolean;
  tone: "running" | "success" | "failed" | "neutral";
}

export function buildStatusInfo(status: string): BuildStatusInfo {
  if (RUNNING_STATUSES.has(status)) return { label: status, isRunning: true, tone: "running" };
  if (status === "finished" || status === "success") return { label: "exitoso", isRunning: false, tone: "success" };
  if (status === "failed") return { label: "falló", isRunning: false, tone: "failed" };
  if (status === "canceled" || status === "cancelled") return { label: "cancelado", isRunning: false, tone: "neutral" };
  return { label: status, isRunning: false, tone: "neutral" };
}
