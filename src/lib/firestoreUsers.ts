import { db } from "./firebase";
import {
  doc, getDoc, setDoc, deleteDoc, collection, getDocs, serverTimestamp,
} from "firebase/firestore";

export const SUPERUSER_EMAIL = "jorge.mendoza@sozu.com";

export type UserRole = "superuser" | "viewer";

/** Permisos granulares de acciones CI/CD por usuario. */
export interface CicdPermissions {
  createPR: boolean; // generar (y cerrar) PRs
  approve: boolean; // aprobar / solicitar cambios / comentar reviews
  mergeDev: boolean; // hacer merge de PRs hacia dev
  mergeMain: boolean; // hacer merge de PRs hacia main (PRD)
  buildApp: boolean; // disparar/cancelar builds de apps en Codemagic
}

export const NO_PERMISSIONS: CicdPermissions = { createPR: false, approve: false, mergeDev: false, mergeMain: false, buildApp: false };
export const ALL_PERMISSIONS: CicdPermissions = { createPR: true, approve: true, mergeDev: true, mergeMain: true, buildApp: true };

export interface AppUser {
  email: string;
  role: UserRole;
  addedBy: string;
  createdAt: unknown;
  projectIds?: string[]; // proyectos a los que tiene acceso (vacío/undefined = legacy: todos)
  permissions?: CicdPermissions; // undefined = legacy: admins todo, viewers nada
  githubToken?: string; // PAT personal de GitHub (obligatorio para operar; root exento)
  githubLogin?: string; // login de GitHub derivado del token (GET /user)
  githubTokenUpdatedAt?: unknown;
}

/**
 * Permisos efectivos: el root siempre tiene todo; usuarios sin campo `permissions`
 * conservan el comportamiento previo (Administrador = todo, Viewer = nada).
 */
export function resolvePermissions(user: AppUser | null): CicdPermissions {
  if (!user) return NO_PERMISSIONS;
  if (user.email === SUPERUSER_EMAIL) return ALL_PERMISSIONS;
  if (user.permissions) return { ...NO_PERMISSIONS, ...user.permissions };
  return user.role === "superuser" ? ALL_PERMISSIONS : NO_PERMISSIONS;
}

export async function getUserByEmail(email: string): Promise<AppUser | null> {
  const snap = await getDoc(doc(db, "users", email));
  return snap.exists() ? (snap.data() as AppUser) : null;
}

export async function getAllUsers(): Promise<AppUser[]> {
  const snap = await getDocs(collection(db, "users"));
  return snap.docs.map((d) => d.data() as AppUser);
}

export async function addUser(
  email: string,
  addedBy: string,
  role: UserRole = "viewer",
  projectIds: string[] = [],
  permissions: CicdPermissions = NO_PERMISSIONS,
  githubToken?: string,
  githubLogin?: string,
) {
  await setDoc(doc(db, "users", email), {
    email,
    role,
    addedBy,
    projectIds,
    permissions,
    ...(githubToken && githubLogin
      ? { githubToken, githubLogin, githubTokenUpdatedAt: serverTimestamp() }
      : {}),
    createdAt: serverTimestamp(),
  });
}

/**
 * Guarda el PAT de GitHub del usuario (y su login derivado). Lo puede hacer
 * el propio usuario (gate de entrada) o el root desde Gestión de Accesos.
 */
export async function setUserGithubToken(email: string, token: string, login: string) {
  await setDoc(
    doc(db, "users", email),
    { githubToken: token, githubLogin: login, githubTokenUpdatedAt: serverTimestamp() },
    { merge: true },
  );
}

/** Actualiza los permisos CI/CD de un usuario. */
export async function setUserPermissions(email: string, permissions: CicdPermissions) {
  if (email === SUPERUSER_EMAIL) throw new Error("El superusuario raíz siempre tiene todos los permisos");
  await setDoc(doc(db, "users", email), { permissions }, { merge: true });
}

export async function removeUser(email: string) {
  if (email === SUPERUSER_EMAIL) throw new Error("El superusuario raíz no puede eliminarse");
  await deleteDoc(doc(db, "users", email));
}

/** Cambia el rol de un usuario existente (promover a Administrador o degradar a Viewer). */
export async function setUserRole(email: string, role: UserRole) {
  if (email === SUPERUSER_EMAIL) throw new Error("No se puede cambiar el rol del superusuario raíz");
  await setDoc(doc(db, "users", email), { role }, { merge: true });
}

/** Define a qué proyectos tiene acceso un usuario (mínimo 1). */
export async function setUserProjects(email: string, projectIds: string[]) {
  if (projectIds.length === 0) throw new Error("El usuario debe tener al menos un proyecto.");
  await setDoc(doc(db, "users", email), { projectIds }, { merge: true });
}

export async function seedSuperuser() {
  const existing = await getUserByEmail(SUPERUSER_EMAIL);
  if (!existing) {
    await setDoc(doc(db, "users", SUPERUSER_EMAIL), {
      email: SUPERUSER_EMAIL,
      role: "superuser",
      addedBy: "system",
      createdAt: serverTimestamp(),
    });
  }
}
