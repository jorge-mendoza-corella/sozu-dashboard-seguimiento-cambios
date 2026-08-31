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
  /** Modo simple: construye y publica directo en la tienda, en un solo paso. */
  storeDirectWorkflowId: string;
  /**
   * Muestra los tres pasos a la vez en vez de sustituir el de pruebas por el
   * final.
   *
   * Las dos plataformas: el flujo es el mismo —construir, probar, publicar— y
   * verlo distinto en cada fila hacia dudar de si en Android faltaba algo.
   * Android alternaba los botones (aparecia "Play interno" y, una vez hecho,
   * lo REEMPLAZABA "Play Store"), asi que el ultimo paso no existia en pantalla
   * hasta que ya se podia dar: no se veia el camino, solo el escalon siguiente.
   * Con los tres a la vista, un boton gris dice "todavia no" en vez de callar.
   */
  tresEtapas: boolean;
}

export const PLATFORMS: PlatformDef[] = [
  {
    key: "android", label: "Android",
    buildWorkflowId: "android-release",
    publishWorkflowId: "android-publish", storeLabel: "Play interno",
    promoteWorkflowId: "android-production", promoteLabel: "Play Store",
    storeDirectWorkflowId: "android-store",
    tresEtapas: true,
  },
  {
    key: "ios", label: "iOS",
    buildWorkflowId: "ios-release",
    publishWorkflowId: "ios-publish", storeLabel: "TestFlight",
    promoteWorkflowId: "ios-appstore", promoteLabel: "App Store",
    storeDirectWorkflowId: "ios-store",
    tresEtapas: true,
  },
];

export const WORKFLOW_LABELS: Record<string, string> = {
  "android-release": "Android build",
  "ios-release": "iOS build",
  "android-publish": "Android → Play interno",
  "ios-publish": "iOS → TestFlight",
  "android-production": "Android → Play Store",
  "ios-appstore": "iOS → App Store",
  "android-store": "Android → Play Store (directo)",
  "ios-store": "iOS → App Store (directo)",
  "web-release": "Web build",
  "sync-testflight-testers": "Sync testers → TestFlight",
};

/** Workflow que sincroniza la lista de testers del dashboard a TestFlight. */
export const SYNC_TESTERS_WORKFLOW = "sync-testflight-testers";

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
  /** Builds de codemagic.yaml traen el id del yaml aquí y workflowId=null. */
  fileWorkflowId?: string | null;
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
  /** Pasos del build. Solo viene en el detalle (`/builds/{id}`), no en la lista. */
  buildActions?: CodemagicBuildAction[];
}

export interface CodemagicBuildAction {
  name?: string;
  status?: string;
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
  // Normalizar: los builds de codemagic.yaml reportan el id del workflow en
  // fileWorkflowId (workflowId viene null). Todo el resto del código compara
  // contra workflowId, así que se unifica aquí.
  return (data.builds ?? [])
    .slice(0, limit)
    .map((b) => ({ ...b, workflowId: b.fileWorkflowId ?? b.workflowId }));
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

/**
 * Detalle de un build. Trae `buildActions` (los pasos), que la lista de
 * `/builds?appId=` no incluye: es la unica forma de saber DONDE fallo.
 */
export async function getBuild(buildId: string): Promise<CodemagicBuild> {
  const data = await request<{ build: CodemagicBuild }>(`/builds/${buildId}`);
  const b = data.build;
  return { ...b, workflowId: b.fileWorkflowId ?? b.workflowId };
}

/**
 * Nombre del paso que tumbó el build, o null si no se puede saber.
 * Tolerante a propósito: si la API cambia la forma de `buildActions`, la UI
 * cae al "falló" de siempre en vez de romperse.
 */
export function failedStepName(build?: CodemagicBuild | null): string | null {
  const fallido = build?.buildActions?.find(
    (a) => a.status === "failed" || a.status === "timeout" || a.status === "error",
  );
  return fallido?.name?.trim() || null;
}

export const buildUrl = (appId: string, buildId: string) =>
  `https://codemagic.io/app/${appId}/build/${buildId}`;

// ---------------------------------------------------------------------------
// Variables de entorno de la app en Codemagic (para subir el keystore Android
// desde el dashboard como variables SEGURAS — cifradas, solo el build las lee).
// ---------------------------------------------------------------------------
interface CodemagicVariable {
  id: string;
  key: string;
  group: string;
}

async function listAppVariables(appId: string): Promise<CodemagicVariable[]> {
  return request<CodemagicVariable[]>(`/apps/${appId}/variables`);
}

async function upsertSecureVariable(appId: string, group: string, key: string, value: string) {
  // La API no tiene update por key: borrar la existente y crearla de nuevo.
  const existing = (await listAppVariables(appId)).find((v) => v.key === key && v.group === group);
  if (existing) {
    await request(`/apps/${appId}/variables/${existing.id}`, { method: "DELETE" }).catch(() => {});
  }
  await request(`/apps/${appId}/variables`, {
    method: "POST",
    body: JSON.stringify({ key, value, group, secure: true }),
  });
}

export const ANDROID_SIGNING_GROUP = "android_signing_custom";

/**
 * Sube el keystore de Android (.jks en base64) y sus credenciales como
 * variables seguras del grupo android_signing_custom. Los workflows lo
 * reconstruyen a archivo antes de firmar.
 */
export async function uploadAndroidKeystore(appId: string, params: {
  fileBase64: string;
  storePassword: string;
  keyAlias: string;
  keyPassword: string;
}): Promise<void> {
  await upsertSecureVariable(appId, ANDROID_SIGNING_GROUP, "ANDROID_KEYSTORE_B64", params.fileBase64);
  await upsertSecureVariable(appId, ANDROID_SIGNING_GROUP, "ANDROID_KEYSTORE_PASSWORD", params.storePassword);
  await upsertSecureVariable(appId, ANDROID_SIGNING_GROUP, "ANDROID_KEY_ALIAS", params.keyAlias);
  await upsertSecureVariable(appId, ANDROID_SIGNING_GROUP, "ANDROID_KEY_PASSWORD", params.keyPassword);
}

/** Nombre que espera el workflow para las credenciales de Google Play. */
export const PLAY_CREDENTIALS_VAR = "GCLOUD_SERVICE_ACCOUNT_CREDENTIALS";

/**
 * Guarda el JSON del service account de Play Console como variable segura, en
 * el MISMO grupo que el keystore: si queda en otro grupo el workflow no lo
 * carga y Codemagic falla con "Expecting value: line 1 column 1" (recibe una
 * cadena vacía y trata de parsearla como JSON).
 */
export async function uploadPlayServiceAccount(appId: string, json: string): Promise<void> {
  const limpio = json.trim();
  let parsed: { type?: string; client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(limpio);
  } catch {
    throw new Error(
      "Eso no es un JSON válido. Pega el archivo completo del service account, desde la primera { hasta la última }.",
    );
  }
  if (parsed.type !== "service_account" || !parsed.client_email || !parsed.private_key) {
    throw new Error(
      'El JSON no parece de un service account (falta "type": "service_account", client_email o private_key).',
    );
  }
  await upsertSecureVariable(appId, ANDROID_SIGNING_GROUP, PLAY_CREDENTIALS_VAR, limpio);
}

export interface BuildStatusInfo {
  label: string;
  isRunning: boolean;
  tone: "running" | "success" | "failed" | "neutral";
}

// Lógica invertida a propósito: cualquier status NO terminal cuenta como
// "en curso". Codemagic tiene estados intermedios no documentados (p.ej.
// "initializing" antes de "queued") y una lista blanca de estados running
// dejaba ventanas donde el build activo no bloqueaba los botones.
export function buildStatusInfo(status: string): BuildStatusInfo {
  if (status === "finished" || status === "success") return { label: "exitoso", isRunning: false, tone: "success" };
  if (status === "failed" || status === "timeout") return { label: "falló", isRunning: false, tone: "failed" };
  if (status === "canceled" || status === "cancelled" || status === "skipped")
    return { label: "cancelado", isRunning: false, tone: "neutral" };
  return { label: status, isRunning: true, tone: "running" };
}
