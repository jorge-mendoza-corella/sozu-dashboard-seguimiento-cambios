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
}

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
}

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
export async function getRecentBuilds(appId: string, limit = 10): Promise<CodemagicBuild[]> {
  const data = await request<{ builds: CodemagicBuild[] }>(`/builds?appId=${appId}`);
  return (data.builds ?? []).slice(0, limit);
}

/** Dispara un workflow. La publicación a stores la hace el propio workflow. */
export async function startBuild(appId: string, workflowId: string, branch: string): Promise<string> {
  const data = await request<{ buildId: string }>("/builds", {
    method: "POST",
    body: JSON.stringify({ appId, workflowId, branch }),
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
