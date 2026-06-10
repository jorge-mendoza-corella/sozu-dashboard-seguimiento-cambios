import { db } from "./firebase";
import { doc, getDocs, setDoc, collection, serverTimestamp } from "firebase/firestore";

export interface ContributorPhone {
  login: string;
  telefonoWhatsapp: string;
  updatedBy: string;
  updatedAt: unknown;
  hiddenInAnalytics?: boolean;
}

/** Mapa login -> teléfono guardado en Firestore (colección `contributors`). */
export async function getAllContributorPhones(): Promise<Record<string, string>> {
  const snap = await getDocs(collection(db, "contributors"));
  const map: Record<string, string> = {};
  snap.docs.forEach((d) => {
    const data = d.data() as ContributorPhone;
    if (data.telefonoWhatsapp) map[d.id] = data.telefonoWhatsapp;
  });
  return map;
}

/** Logins marcados como ocultos en la pestaña de Analítica (como individuos). */
export async function getHiddenContributors(): Promise<Set<string>> {
  const snap = await getDocs(collection(db, "contributors"));
  const hidden = new Set<string>();
  snap.docs.forEach((d) => {
    if ((d.data() as ContributorPhone).hiddenInAnalytics) hidden.add(d.id);
  });
  return hidden;
}

/** Marca/desmarca a un contribuidor como oculto (individualmente) en Analítica. */
export async function setContributorHidden(login: string, hidden: boolean, updatedBy: string) {
  await setDoc(
    doc(db, "contributors", login),
    { login, hiddenInAnalytics: hidden, updatedBy, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

/** Guarda (upsert) el teléfono de WhatsApp de un contribuidor. */
export async function saveContributorPhone(login: string, telefono: string, updatedBy: string) {
  await setDoc(
    doc(db, "contributors", login),
    { login, telefonoWhatsapp: telefono, updatedBy, updatedAt: serverTimestamp() },
    { merge: true },
  );
}
