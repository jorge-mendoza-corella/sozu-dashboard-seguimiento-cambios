import { db } from "./firebase";
import {
  doc, getDoc, setDoc, deleteDoc, updateDoc, collection, getDocs, serverTimestamp, query, where,
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
}

export interface MonitoredRepo {
  id: string; // `${owner}__${repo}`
  owner: string;
  repo: string;
  label: string;
  projectId: string;
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
  });
  return ref.id;
}

export async function renameProject(id: string, name: string) {
  await updateDoc(doc(db, "projects", id), { name: name.trim() });
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
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function addRepo(
  input: { owner: string; repo: string; label: string; projectId: string },
  addedBy: string,
): Promise<void> {
  const id = repoDocId(input.owner, input.repo);
  const ref = doc(db, "repos", id);
  const exists = await getDoc(ref);
  if (exists.exists()) throw new Error("Ese repositorio ya está dado de alta.");
  await setDoc(ref, {
    owner: input.owner,
    repo: input.repo,
    label: input.label.trim() || input.repo,
    projectId: input.projectId,
    addedBy,
    createdAt: serverTimestamp(),
  });
}

export async function moveRepoToProject(id: string, projectId: string) {
  await updateDoc(doc(db, "repos", id), { projectId });
}

export async function removeRepo(id: string) {
  await deleteDoc(doc(db, "repos", id));
}

// --- Seeding (migración inicial) --------------------------------------------

/**
 * Si no hay proyectos, crea el proyecto "SOZU" con los repos por defecto
 * (los 5 históricos hardcodeados). Solo lo puede ejecutar un superuser.
 */
export async function seedDefaultProject(addedBy: string): Promise<boolean> {
  const projects = await getProjects();
  if (projects.length > 0) return false;
  const projectId = await addProject("SOZU", addedBy);
  await Promise.all(
    REPOS.map((r) =>
      addRepo({ owner: r.owner, repo: r.repo, label: r.label, projectId }, addedBy).catch(() => {}),
    ),
  );
  return true;
}
