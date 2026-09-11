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
  /**
   * Lo que el botón HACE, que no es lo mismo que el sitio a donde va.
   *
   * En iOS el botón decía "App Store" y eso se lee como "publicar ahora",
   * cuando lo que dispara es un envío a revisión de Apple. El destino sigue
   * siendo "App Store" —así se marcan las versiones ya publicadas—, pero el
   * botón dice la acción.
   */
  promoteAccion: string;
  /** Qué pasa de verdad al pulsarlo. Se muestra en el modal de confirmación. */
  promoteAviso: string;
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
    promoteAccion: "Play Store",
    promoteAviso:
      "Promueve a producción el release que ya está en el track interno: no reconstruye. " +
      "Google no revisa cada actualización como Apple, así que en cuestión de horas queda " +
      "disponible para todos los usuarios.",
    storeDirectWorkflowId: "android-store",
    tresEtapas: true,
  },
  {
    key: "ios", label: "iOS",
    buildWorkflowId: "ios-release",
    publishWorkflowId: "ios-publish", storeLabel: "TestFlight",
    promoteWorkflowId: "ios-appstore", promoteLabel: "App Store",
    promoteAccion: "Enviar a revisión",
    promoteAviso:
      "No reconstruye: manda a revisión de Apple el último build que ya está en TestFlight. " +
      "En App Store Connect no tienes que preparar nada a mano: crea la versión con el número " +
      "del propio build, le ata esa compilación y escribe tu comentario como \"Novedades\". " +
      "Si ya creaste una versión a mano y sigue editable, no hace otra: reutiliza esa, le cambia " +
      "el número al del build, le ata la compilación nueva y le reescribe las novedades. El " +
      "número sale SIEMPRE del build, nunca de lo que escribiste en la consola. " +
      "Apple tarda de unas horas a un par de días y, si lo aprueba, la versión sale a la venta " +
      "AUTOMÁTICAMENTE (release AFTER_APPROVAL) — no hay un paso manual después. " +
      "Lo único que NO crea es la ficha de la app: capturas, descripción, categoría, política de " +
      "privacidad, clasificación por edad y export compliance. En una actualización eso se hereda " +
      "de la versión anterior; en la PRIMERA versión hay que llenarlo antes o Apple rechaza el " +
      "envío y este build falla.",
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
  /**
   * En un build FALLIDO, el motivo que da Codemagic ("No provisioning profile
   * with reference 'x' were found…"). En los que terminan bien llega vacío.
   * Viene ya en la lista de builds, no hace falta pedir el detalle.
   */
  message?: string;
  version?: string;
  index?: number; // número de build
  /** Máquina en la que corrió (`mac_mini_m2`…). De aquí sale el costo. */
  instanceType?: string;
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

/**
 * Por qué murió el build, según Codemagic.
 *
 * Hace falta aparte del paso que falló: cuando el build se cae ANTES de
 * arrancar —firma de iOS que no existe, credencial que falta— `buildActions`
 * llega vacío y el dashboard no podía decir nada, así que había que abrir
 * Codemagic para leer una línea.
 */
export function buildFailureMessage(build?: CodemagicBuild | null): string | null {
  if (!build || build.status === "finished" || build.status === "success") return null;
  return build.message?.trim() || null;
}

// ---------------------------------------------------------------------------
// Cuánto ha costado en Codemagic.
//
// La primera versión de esto multiplicaba la duración de TODOS los builds por
// la tarifa de su máquina y daba $18.26 donde Codemagic facturó $5.23. El
// error no era la tarifa: era contar como pagado lo que no lo es. Codemagic
// reparte el tiempo en tres cubos —`_free` (los 500 min del mes), `_personal`
// (crédito incluido) y `_paid` (lo que de verdad se cobra)— y solo el tercero
// cuesta dinero.
//
// Ese desglose SÍ está en la API, en `/user`, aunque no esté documentado: por
// cuenta y por team, del periodo en curso y del anterior, en SEGUNDOS. Es el
// importe real, no una estimación, así que es el que se enseña.
// ---------------------------------------------------------------------------

/** USD por minuto de cada máquina (codemagic.io/pricing, revisado 2026-09-11). */
const PRECIO_POR_MINUTO: Record<string, number> = {
  mac_mini_m2: 0.095,
  mac_mini_m4: 0.114,
  linux_x2: 0.045,
  windows_x2: 0.045,
};

/** Tarifa de la máquina más cara: lo desconocido no se cobra de menos. */
const PRECIO_POR_DEFECTO = 0.114;

/** Minutos gratis de macOS M2 al mes. */
export const MINUTOS_GRATIS_MES = 500;

export interface ConsumoPeriodo {
  /** Minutos que de verdad se facturan. */
  minutosPagados: number;
  /** Minutos consumidos del cupo gratis del mes. */
  minutosGratis: number;
  /** Todo el tiempo de máquina, se cobre o no. */
  minutosTotales: number;
  /** USD del periodo: solo los minutos pagados, a la tarifa de su máquina. */
  usd: number;
}

export interface ConsumoCodemagic {
  /** Dueño de la app: el team, o la cuenta personal. */
  ambito: string;
  actual: ConsumoPeriodo;
  anterior: ConsumoPeriodo;
  /** Cuánto de lo facturado le toca a esta app. Null si no se pudo repartir. */
  reparto: RepartoApp | null;
}

export interface RepartoApp {
  /** Minutos de máquina de ESTA app en la ventana medida. */
  minutosApp: number;
  /** Minutos de TODAS las apps de la cuenta en la misma ventana. */
  minutosCuenta: number;
  /** Fracción 0..1 que le toca a esta app. */
  parte: number;
  /** USD que le corresponden de lo facturado. */
  usd: number;
  /** Cuántas apps comparten la factura. */
  apps: number;
  /** Días de la ventana con la que se midió el peso. */
  dias: number;
}

/** `{ mac_mini_m2_paid: 3300, … }` en segundos → minutos y dinero. */
function periodoDe(buildTime: Record<string, number> | undefined): ConsumoPeriodo {
  const r: ConsumoPeriodo = { minutosPagados: 0, minutosGratis: 0, minutosTotales: 0, usd: 0 };
  for (const [clave, segundos] of Object.entries(buildTime ?? {})) {
    if (!segundos) continue;
    const min = segundos / 60;
    r.minutosTotales += min;
    // La clave es `<maquina>_<cubo>`: el cubo es el último tramo.
    const corte = clave.lastIndexOf("_");
    const maquina = clave.slice(0, corte);
    const cubo = clave.slice(corte + 1);
    if (cubo === "paid") {
      r.minutosPagados += min;
      r.usd += min * (PRECIO_POR_MINUTO[maquina] ?? PRECIO_POR_DEFECTO);
    } else if (cubo === "free") {
      r.minutosGratis += min;
    }
  }
  return r;
}

/**
 * Días hacia atrás con los que se mide el peso de cada app.
 *
 * Codemagic NO publica las fechas de su periodo de facturación, así que no se
 * puede recortar exactamente. No hace falta: mientras el numerador y el
 * denominador usen la MISMA ventana, la proporción entre apps se sostiene
 * aunque la ventana no coincida con la del recibo. Lo que no se puede es
 * comparar minutos de una ventana contra el total de otra, que es lo que hacía
 * la primera versión.
 */
const DIAS_REPARTO = 30;

interface UserResponse {
  user?: {
    billing?: { usage?: { currentPeriod?: { buildTime?: Record<string, number> }; previousPeriod?: { buildTime?: Record<string, number> } } };
    teams?: {
      name?: string;
      applicationIds?: string[];
      billing?: { usage?: { currentPeriod?: { buildTime?: Record<string, number> }; previousPeriod?: { buildTime?: Record<string, number> } } };
    }[];
  };
}

/**
 * Consumo facturado de la cuenta que es dueña de esa app.
 *
 * Se busca el appId en los `applicationIds` de cada team; si no está en
 * ninguno, la app es de la cuenta personal. Importa acertar: al mover una app
 * a un team, su gasto deja de contar en la personal y empieza en el team, y
 * enseñar el cubo equivocado daría cero justo cuando más se mira.
 */
export async function getConsumoCodemagic(appId: string): Promise<ConsumoCodemagic | null> {
  const d = await request<UserResponse>("/user");
  const u = d.user;
  if (!u) return null;
  const team = u.teams?.find((t) => t.applicationIds?.includes(appId));
  const uso = (team ?? u).billing?.usage;
  const actual = periodoDe(uso?.currentPeriod?.buildTime);

  return {
    ambito: team?.name ? `equipo ${team.name}` : "cuenta personal",
    actual,
    anterior: periodoDe(uso?.previousPeriod?.buildTime),
    reparto: await repartoDe(appId, team?.applicationIds, actual.usd),
  };
}

/**
 * Qué parte de la factura le toca a esta app, por minutos de máquina.
 *
 * Codemagic cobra por CUENTA y no desglosa por aplicación, así que el reparto
 * es una cuenta nuestra. Se mide el peso de cada app sobre la misma ventana de
 * días —numerador y denominador— y esa fracción se aplica al importe real.
 *
 * Se cuentan los builds fallidos: también ocuparon máquina y también se pagan.
 */
async function repartoDe(
  appId: string,
  appsDelTeam: string[] | undefined,
  usdFacturado: number,
): Promise<RepartoApp | null> {
  // Las apps que comparten la factura. En un team las da el propio team; en la
  // cuenta personal son todas las que el token ve y no pertenecen a ninguno.
  let hermanas = appsDelTeam;
  if (!hermanas) {
    try {
      hermanas = (await getCodemagicApps()).map((a) => a._id);
    } catch {
      return null;
    }
  }
  if (!hermanas?.length) return null;

  const desde = new Date();
  desde.setDate(desde.getDate() - DIAS_REPARTO);

  const minutos = await Promise.all(
    hermanas.map(async (id) => {
      try {
        return { id, min: minutosDelPeriodo(await getRecentBuilds(id), desde) };
      } catch {
        // Una app que no se puede leer no invalida el reparto: se queda en
        // cero y la fracción de las demás sube. Devolver null perdería el
        // dato completo por una app.
        return { id, min: 0 };
      }
    }),
  );

  const minutosCuenta = minutos.reduce((s, m) => s + m.min, 0);
  if (minutosCuenta <= 0) return null;
  const minutosApp = minutos.find((m) => m.id === appId)?.min ?? 0;
  const parte = minutosApp / minutosCuenta;

  return {
    minutosApp,
    minutosCuenta,
    parte,
    usd: usdFacturado * parte,
    apps: hermanas.length,
    dias: DIAS_REPARTO,
  };
}

/** Minutos que duró un build. 0 si todavía corre o si la API no fecha el fin. */
export function buildMinutos(b: CodemagicBuild): number {
  if (!b.startedAt || !b.finishedAt) return 0;
  const ms = new Date(b.finishedAt).getTime() - new Date(b.startedAt).getTime();
  return ms > 0 ? ms / 60_000 : 0;
}

/**
 * Minutos de máquina de esos builds dentro del periodo de facturación en curso.
 *
 * Sirve para repartir: el importe que cobra Codemagic es de la CUENTA, no de
 * cada app, así que la parte de una app se estima por su peso en minutos. Se
 * cuentan los fallidos, que también ocupan máquina.
 */
export function minutosDelPeriodo(builds: CodemagicBuild[], desde: Date): number {
  return builds
    .filter((b) => b.startedAt && new Date(b.startedAt) >= desde)
    .reduce((s, b) => s + buildMinutos(b), 0);
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
  const data = await request<CodemagicVariable[] | { variables?: CodemagicVariable[] }>(
    `/apps/${appId}/variables`,
  );
  // Tolerante a la forma de la respuesta: un array pelado que un dia venga
  // envuelto haria fallar el `.find` de abajo a mitad de una subida, o sea
  // despues de haber borrado la variable anterior.
  return Array.isArray(data) ? data : (data.variables ?? []);
}

/**
 * Claves que Codemagic tiene HOY en ese grupo. Los valores son secretos y no se
 * pueden leer; las claves si, y es lo unico que permite saber si una credencial
 * esta puesta de verdad.
 */
export async function listSecureVariableKeys(appId: string, group: string): Promise<string[]> {
  return (await listAppVariables(appId)).filter((v) => v.group === group).map((v) => v.key);
}

async function upsertSecureVariable(appId: string, group: string, key: string, value: string) {
  // La API no tiene update por key: borrar la existente y crearla de nuevo.
  const existing = (await listAppVariables(appId)).find((v) => v.key === key && v.group === group);
  if (existing) {
    await request(`/apps/${appId}/variables/${existing.id}`, { method: "DELETE" }).catch(() => {});
  }
  let fallo: unknown = null;
  try {
    await request(`/apps/${appId}/variables`, {
      method: "POST",
      body: JSON.stringify({ key, value, group, secure: true }),
    });
  } catch (e) {
    fallo = e;
  }
  // Manda la lista, no el 2xx: un POST correcto que no devuelva JSON tambien
  // hace throw en `request`, y al reves un 2xx no prueba que la variable quedo.
  if ((await listSecureVariableKeys(appId, group)).includes(key)) return;
  const causa = fallo instanceof Error ? `: ${fallo.message}` : "";
  throw new Error(
    `${key} no quedo en el grupo ${group} de Codemagic${causa}. La anterior ya se ` +
      "borro, asi que ahora esa variable NO existe y la publicacion fallara: vuelve a subirla.",
  );
}

export const ANDROID_SIGNING_GROUP = "android_signing_custom";

/** Nombre que espera el workflow para el .jks en base64. */
export const KEYSTORE_VAR = "ANDROID_KEYSTORE_B64";

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
  await upsertSecureVariable(appId, ANDROID_SIGNING_GROUP, KEYSTORE_VAR, params.fileBase64);
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
  // `warning` TERMINA el build: es el resultado de un paso con `ignore_failure`
  // en el codemagic.yaml, no un estado intermedio. Caía en el default de abajo,
  // así que un build que acababa así se quedaba "en curso" para siempre: no
  // llegaba el aviso de que había terminado, la etapa siguiente (TestFlight,
  // Play interno) seguía en gris y el propio workflow quedaba bloqueado para
  // relanzarlo. Cuenta como éxito —el artefacto salió— con el aviso a la vista.
  if (status === "warning") return { label: "exitoso (con avisos)", isRunning: false, tone: "success" };
  if (status === "failed" || status === "timeout") return { label: "falló", isRunning: false, tone: "failed" };
  if (status === "canceled" || status === "cancelled" || status === "skipped")
    return { label: "cancelado", isRunning: false, tone: "neutral" };
  return { label: status, isRunning: true, tone: "running" };
}
