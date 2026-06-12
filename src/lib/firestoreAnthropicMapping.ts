import { db } from "./firebase";
import { collection, doc, getDocs, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import type { Mapping } from "./anthropicAdmin";

const COL = "anthropic_account_mapping";

export async function getMappings(): Promise<Mapping[]> {
  const snap = await getDocs(collection(db, COL));
  return snap.docs.map((d) => ({
    accountId: d.id,
    githubLogin: (d.data() as { githubLogin: string; email?: string }).githubLogin,
    email: (d.data() as { email?: string }).email,
  }));
}

export async function setMapping(
  accountId: string,
  githubLogin: string,
  email: string | undefined,
  updatedBy: string,
): Promise<void> {
  await setDoc(doc(db, COL, accountId), {
    githubLogin,
    email: email ?? null,
    updatedBy,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteMapping(accountId: string): Promise<void> {
  await deleteDoc(doc(db, COL, accountId));
}
