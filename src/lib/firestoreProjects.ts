import { db } from "./firebase";
import {
  doc, getDoc, setDoc, deleteDoc, updateDoc, collection, getDocs, serverTimestamp, query, where, writeBatch, deleteField,
} from "firebase/firestore";
import { REPOS } from "./github";

// ---------------------------------------------------------------------------
// Proyectos y repositorios monitoreados (dinámicos, en Firestore)
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  color: string;
  order: number;
  createdBy: string;
  createdAt: unknown;
  // Cliente (empresa/persona) dueño del proyecto. Sin él el proyecto no se le
  // cobra a nadie: la configuración lo marca como "sin cliente".
  clientId?: string;
  seeded?: boolean; // ya se sembraron los repos por defecto (no volver a auto-agregar)
  isApp?: boolean;  // marca el proyecto como una app móvil/app
  codemagicAppId?: string; // app de Codemagic vinculada (builds desde el dashboard)
  testerEmails?: string[]; // correos con acceso a builds de prueba (TestFlight / Play interno)
  playInternalUrl?: string; // link de invitación del track interno (Play Console → Testers → Copy link)
  playClosedUrl?: string; // link de invitación de prueba cerrada (Alpha)
  playOpenUrl?: string; // link de prueba abierta (Beta pública)
  testflightPublicUrl?: string; // link público de TestFlight (App Store Connect → grupo externo → Public link)
  approverEmail?: string; // usuario del dashboard que aprueba los PRs del proyecto (usa SU token de GitHub)
  notifyAuthors?: string[]; // logins de GitHub seleccionables como autor extra al crear PR (por proyecto)
  androidKeystoreUploadedAt?: string; // ISO — última subida del keystore Android vía dashboard
  playCredentialsUploadedAt?: string; // ISO — última subida del service account de Play a Codemagic
  // Credenciales de tienda PROPIAS de este proyecto (los secretos viven en
  // `projects/{id}/private/*`, que el navegador no puede leer). Aquí solo queda
  // el rastro visible de cuándo y quién las dejó.
  playCredentialsUpdatedAt?: unknown;
  playCredentialsUpdatedBy?: string;
  ascCredentialsUpdatedAt?: unknown;
  ascCredentialsUpdatedBy?: string;
  androidPackage?: string; // applicationId de Android (ej. com.sozu.clientes_app); se inyecta al build de Codemagic
  iosBundleId?: string; // bundle id de iOS (ej. com.sozu.sozuClienteApp); para leer el estado en App Store Connect
  // "simple" (default): construir y publicar directo en la tienda, en un clic.
  // "avanzado": flujo por etapas (Play interno / TestFlight → tienda) + testers.
  deployMode?: "simple" | "avanzado";
}

export interface MonitoredRepo {
  id: string; // `${owner}__${repo}`
  owner: string;
  repo: string;
  label: string;
  projectId: string;
  order?: number; // orden manual dentro del proyecto (drag & drop)
  addedBy: string;
  createdAt: unknown;
  // URL pública del front que publica este repo. Tenerla es lo que marca al
  // repo como front: la card muestra el link, el botón de copiar y la versión
  // que sirve ese sitio (la lee el sync en `frontVersions/{id}`).
  frontUrl?: string;
  // Precio mensual fijado a ESTE repo. Es lo primero que mira el cobro; si no
  // está, se usa la tarifa del cliente y luego el default global.
  monthlyPrice?: number;
}

const PROJECT_COLORS = [
  "#6366f1", "#10b981", "#f59e0b", "#ec4899", "#06b6d4",
  "#8b5cf6", "#ef4444", "#84cc16", "#3b82f6", "#a855f7",
];

export const repoDocId = (owner: string, repo: string) => `${owner}__${repo}`;

// --- Proyectos ---------------------------------------------------------------

export async function getProjects(): Promise<Project[]> {
  const snap = await getDocs(collection(db, "projects"));
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<Project, "id">) }))
    .sort((a, b) => a.order - b.order);
}

export async function addProject(name: string, addedBy: string): Promise<string> {
  const existing = await getProjects();
  const ref = doc(collection(db, "projects"));
  const color = PROJECT_COLORS[existing.length % PROJECT_COLORS.length];
  await setDoc(ref, {
    name: name.trim(),
    color,
    order: existing.length,
    createdBy: addedBy,
    createdAt: serverTimestamp(),
    isApp: false,
  });
  return ref.id;
}

export async function renameProject(id: string, name: string) {
  await updateDoc(doc(db, "projects", id), { name: name.trim() });
}

/** Asigna el proyecto a un cliente (null = dejarlo sin cliente, no se cobra). */
export async function setProjectClient(id: string, clientId: string | null) {
  await updateDoc(doc(db, "projects", id), {
    clientId: clientId ?? deleteField(),
  });
}

export async function setProjectIsApp(id: string, isApp: boolean) {
  await updateDoc(doc(db, "projects", id), { isApp });
}

/** Vincula (o desvincula con null) la app de Codemagic del proyecto. */
export async function setProjectCodemagicApp(id: string, appId: string | null) {
  await updateDoc(doc(db, "projects", id), {
    codemagicAppId: appId ?? deleteField(),
  });
}

/**
 * Package de Android (applicationId) de la app. Se inyecta como variable de
 * entorno ANDROID_PACKAGE_NAME al disparar el build en Codemagic. null = quitar.
 */
export async function setProjectAndroidPackage(id: string, pkg: string | null) {
  await updateDoc(doc(db, "projects", id), {
    androidPackage: pkg ?? deleteField(),
  });
}

/** Bundle id de iOS: con él se consulta el estado de revisión en App Store Connect. */
export async function setProjectIosBundleId(id: string, bundleId: string | null) {
  await updateDoc(doc(db, "projects", id), {
    iosBundleId: bundleId ?? deleteField(),
  });
}

/** Alterna entre el flujo de un clic ("simple") y el flujo por etapas ("avanzado"). */
export async function setProjectDeployMode(id: string, mode: "simple" | "avanzado") {
  await updateDoc(doc(db, "projects", id), { deployMode: mode });
}

/** Marca cuándo se subió el keystore Android desde el dashboard (solo informativo). */
export async function setProjectKeystoreUploaded(id: string) {
  await updateDoc(doc(db, "projects", id), { androidKeystoreUploadedAt: new Date().toISOString() });
}

/** Marca cuándo se subió el service account de Google Play (solo informativo). */
export async function setProjectPlayCredentialsUploaded(id: string) {
  await updateDoc(doc(db, "projects", id), { playCredentialsUploadedAt: new Date().toISOString() });
}

/** Logins de GitHub que aparecen como seleccionables al crear PR en el proyecto. */
export async function setProjectNotifyAuthors(id: string, logins: string[]) {
  await updateDoc(doc(db, "projects", id), { notifyAuthors: logins });
}

/** Define el aprobador default de PRs del proyecto (null = quitar). */
export async function setProjectApprover(id: string, email: string | null) {
  await updateDoc(doc(db, "projects", id), {
    approverEmail: email ?? deleteField(),
  });
}

/** Lista de correos de testers con acceso a los builds de prueba de la app. */
export async function setProjectTesters(id: string, emails: string[]) {
  await updateDoc(doc(db, "projects", id), { testerEmails: emails });
}

/** Links de invitación de los canales de prueba (se setean una sola vez por app). */
export async function setProjectTestLinks(
  id: string,
  links: { playInternalUrl?: string; playClosedUrl?: string; playOpenUrl?: string; testflightPublicUrl?: string },
) {
  const patch: Record<string, unknown> = {};
  for (const key of ["playInternalUrl", "playClosedUrl", "playOpenUrl", "testflightPublicUrl"] as const) {
    if (links[key] !== undefined) patch[key] = links[key] || deleteField();
  }
  await updateDoc(doc(db, "projects", id), patch);
}

export async function removeProject(id: string) {
  // No permitir borrar un proyecto con repos asignados.
  const q = query(collection(db, "repos"), where("projectId", "==", id));
  const repos = await getDocs(q);
  if (!repos.empty) {
    throw new Error(`El proyecto tiene ${repos.size} repo(s). Muévelos o elimínalos primero.`);
  }
  await deleteDoc(doc(db, "projects", id));
}

// --- Repositorios ------------------------------------------------------------

export async function getRepos(): Promise<MonitoredRepo[]> {
  const snap = await getDocs(collection(db, "repos"));
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<MonitoredRepo, "id">) }))
    .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.label.localeCompare(b.label));
}

export async function addRepo(
  input: { owner: string; repo: string; label: string; projectId: string; frontUrl?: string },
  addedBy: string,
): Promise<void> {
  const id = repoDocId(input.owner, input.repo);
  const ref = doc(db, "repos", id);
  const exists = await getDoc(ref);
  if (exists.exists()) throw new Error("Ese repositorio ya está dado de alta.");
  const all = await getRepos();
  await setDoc(ref, {
    owner: input.owner,
    repo: input.repo,
    label: input.label.trim() || input.repo,
    projectId: input.projectId,
    order: all.length, // al final
    addedBy,
    createdAt: serverTimestamp(),
    // Solo si se dio: tenerla es lo que marca al repo como front.
    ...(input.frontUrl?.trim()
      ? { frontUrl: input.frontUrl.trim().replace(/\/+$/, "") }
      : {}),
  });
}

/** Persiste el orden manual de repos (drag & drop). `ids` en el orden deseado. */
export async function setReposOrder(ids: string[]) {
  const batch = writeBatch(db);
  ids.forEach((id, i) => batch.update(doc(db, "repos", id), { order: i }));
  await batch.commit();
}

export async function moveRepoToProject(id: string, projectId: string) {
  await updateDoc(doc(db, "repos", id), { projectId });
}

/** Cambia el nombre a mostrar del repo (ej. "Frontend", "Backend"). */
export async function setRepoLabel(id: string, label: string) {
  await updateDoc(doc(db, "repos", id), { label: label.trim() });
}

/** URL del front que publica el repo. Vacío = el repo deja de ser front. */
export async function setRepoFrontUrl(id: string, url: string | null) {
  const limpia = url?.trim();
  await updateDoc(doc(db, "repos", id), {
    frontUrl: limpia ? limpia.replace(/\/+$/, "") : deleteField(),
  });
}

/**
 * Precio mensual propio de este repo. null = quitarlo y volver a la tarifa del
 * cliente (o al default global si el cliente tampoco tiene una).
 */
export async function setRepoMonthlyPrice(id: string, price: number | null) {
  if (price !== null && (!Number.isFinite(price) || price < 0)) {
    throw new Error("El precio del repo debe ser un número mayor o igual a 0.");
  }
  await updateDoc(doc(db, "repos", id), {
    monthlyPrice: price === null ? deleteField() : price,
  });
}

/**
 * Aplica un renombre hecho en GitHub (`owner/repo` nuevos) al repo dado de alta.
 *
 * No es un update: el id del documento ES `${owner}__${repo}`, y Firestore no
 * puede cambiarle el id a un doc ni moverlo. Por eso se crea uno nuevo con el id
 * nuevo copiando TODOS los campos (label, projectId, order, addedBy, createdAt,
 * frontUrl, monthlyPrice…) y recién después se borra el viejo: si se borrara
 * primero y algo fallara, el repo se perdería del dashboard.
 */
export async function renameRepoDoc(id: string, owner: string, repo: string): Promise<void> {
  const nuevoId = repoDocId(owner, repo);
  if (nuevoId === id) return; // ya está con el nombre nuevo
  const viejo = await getDoc(doc(db, "repos", id));
  if (!viejo.exists()) throw new Error("Ese repositorio ya no está dado de alta.");
  const nuevoRef = doc(db, "repos", nuevoId);
  // Nunca pisar un doc existente: sería borrar la configuración de OTRO repo.
  if ((await getDoc(nuevoRef)).exists()) {
    throw new Error(
      `Ya hay un repositorio dado de alta como ${owner}/${repo}. Revisa ese duplicado (o elimínalo) antes de aplicar el renombre.`,
    );
  }
  const datos = viejo.data() as Omit<MonitoredRepo, "id">;
  await setDoc(nuevoRef, { ...datos, owner, repo });
  await deleteDoc(viejo.ref);
}

export async function removeRepo(id: string) {
  await deleteDoc(doc(db, "repos", id));
}

// --- Seeding (migración inicial) --------------------------------------------

/**
 * Siembra/repara el proyecto "SOZU" con los repos por defecto (los 5 históricos).
 * Idempotente: se ejecuta una sola vez (marca `seeded` en el proyecto). Si una
 * siembra previa quedó incompleta, completa los repos faltantes. No vuelve a
 * agregar repos que el usuario haya eliminado a propósito una vez marcado `seeded`.
 * Solo lo puede ejecutar un superuser.
 */
export async function seedDefaultProject(addedBy: string): Promise<boolean> {
  const projects = await getProjects();
  // Ya sembrado: no hacer nada (respeta repos borrados por el usuario).
  if (projects.some((p) => p.seeded)) return false;

  // Reusar un proyecto "SOZU" existente (siembra previa incompleta) o crearlo.
  let projectId = projects.find((p) => p.name === "SOZU")?.id;
  if (!projectId) projectId = await addProject("SOZU", addedBy);

  const existing = await getRepos();
  const have = new Set(existing.map((r) => r.id));
  await Promise.all(
    REPOS.map((r) => {
      if (have.has(repoDocId(r.owner, r.repo))) return Promise.resolve();
      return addRepo({ owner: r.owner, repo: r.repo, label: r.label, projectId }, addedBy).catch(() => {});
    }),
  );

  await updateDoc(doc(db, "projects", projectId), { seeded: true });
  return true;
}
