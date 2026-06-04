import { db } from "./firebase";
import {
  doc, getDoc, setDoc, deleteDoc, collection, getDocs, serverTimestamp,
} from "firebase/firestore";

export const SUPERUSER_EMAIL = "jorge.mendoza@sozu.com";

export type UserRole = "superuser" | "viewer";

export interface AppUser {
  email: string;
  role: UserRole;
  addedBy: string;
  createdAt: unknown;
  projectIds?: string[]; // proyectos a los que tiene acceso (vacío/undefined = legacy: todos)
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
) {
  await setDoc(doc(db, "users", email), {
    email,
    role,
    addedBy,
    projectIds,
    createdAt: serverTimestamp(),
  });
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
