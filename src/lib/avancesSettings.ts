import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Ajustes del sitio de avances. La URL del canal draft cambia cada vez que se
// crea uno nuevo (Firebase le pone un hash aleatorio) y solo la Hosting API
// puede descubrirla — permiso que la cuenta del sync todavía no tiene. Mientras
// tanto el root la pega aquí y el sync la usa para comparar contra producción.
// ---------------------------------------------------------------------------

export interface AvancesSettings {
  draftUrl: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

const REF = () => doc(db, "settings", "avances");

export async function getAvancesSettings(): Promise<AvancesSettings | null> {
  const snap = await getDoc(REF());
  if (!snap.exists()) return null;
  const d = snap.data() as { draftUrl?: string; updatedAt?: { toDate?: () => Date }; updatedBy?: string };
  return {
    draftUrl: d.draftUrl ?? null,
    updatedAt: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : null,
    updatedBy: d.updatedBy ?? null,
  };
}

export async function setAvancesDraftUrl(url: string | null, email: string) {
  await setDoc(
    REF(),
    { draftUrl: url ?? "", updatedAt: new Date(), updatedBy: email },
    { merge: true },
  );
}
