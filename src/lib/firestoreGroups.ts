import { db } from "./firebase";
import {
  doc, setDoc, deleteDoc, updateDoc, collection, getDocs, serverTimestamp,
} from "firebase/firestore";

// ---------------------------------------------------------------------------
// Grupos de contribuidores (colección `contributor_groups`)
// Un login puede pertenecer a varios grupos. `showInAnalytics` controla si el
// grupo aparece como entidad en la pestaña Analítica ejecutiva.
// ---------------------------------------------------------------------------

export interface ContributorGroup {
  id: string;
  name: string;
  color: string;
  members: string[]; // logins de GitHub
  showInAnalytics: boolean;
  createdBy: string;
  createdAt: unknown;
}

const GROUP_COLORS = [
  "#6366f1", "#10b981", "#f59e0b", "#ec4899", "#06b6d4",
  "#8b5cf6", "#ef4444", "#84cc16", "#3b82f6", "#a855f7",
];

export async function getGroups(): Promise<ContributorGroup[]> {
  const snap = await getDocs(collection(db, "contributor_groups"));
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<ContributorGroup, "id">) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function addGroup(name: string, createdBy: string): Promise<string> {
  const existing = await getGroups();
  const ref = doc(collection(db, "contributor_groups"));
  await setDoc(ref, {
    name: name.trim(),
    color: GROUP_COLORS[existing.length % GROUP_COLORS.length],
    members: [],
    showInAnalytics: true,
    createdBy,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateGroup(
  id: string,
  patch: Partial<Pick<ContributorGroup, "name" | "members" | "showInAnalytics">>,
) {
  await updateDoc(doc(db, "contributor_groups", id), patch);
}

export async function removeGroup(id: string) {
  await deleteDoc(doc(db, "contributor_groups", id));
}
