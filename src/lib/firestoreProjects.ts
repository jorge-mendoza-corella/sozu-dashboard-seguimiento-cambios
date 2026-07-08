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
  seeded?: boolean; // ya se sembraron los repos por defecto (no volver a auto-agregar)
  isApp?: boolean;  // marca el proyecto como una app móvil/app
  codemagicAppId?: string; // app de Codemagic vinculada (builds desde el dashboard)
  testerEmails?: string[]; // correos con acceso a builds de prueba (TestFlight / Play interno)
  playInternalUrl?: string; // link de invitación del track interno (Play Console → Testers → Copy link)
  testflightPublicUrl?: string; // link público de TestFlight (App Store Connect → grupo externo → Public link)
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

export async function setProjectIsApp(id: string, isApp: boolean) {
  await updateDoc(doc(db, "projects", id), { isApp });
}

/** Vincula (o desvincula con null) la app de Codemagic del proyecto. */
export async function setProjectCodemagicApp(id: string, appId: string | null) {
  await updateDoc(doc(db, "projects", id), {
    codemagicAppId: appId ?? deleteField(),
  });
}

/** Lista de correos de testers con acceso a los builds de prueba de la app. */
export async function setProjectTesters(id: string, emails: string[]) {
  await updateDoc(doc(db, "projects", id), { testerEmails: emails });
}

/** Links de invitación de los canales de prueba (se setean una sola vez por app). */
export async function setProjectTestLinks(
  id: string,
  links: { playInternalUrl?: string; testflightPublicUrl?: string },
) {
  const patch: Record<string, unknown> = {};
  if (links.playInternalUrl !== undefined)
    patch.playInternalUrl = links.playInternalUrl || deleteField();
  if (links.testflightPublicUrl !== undefined)
    patch.testflightPublicUrl = links.testflightPublicUrl || deleteField();
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
  input: { owner: string; repo: string; label: string; projectId: string },
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
