import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Credenciales de tienda para los syncs programados (estado de Google Play y de
// App Store Connect).
//
// El workflow las saca de Secret Manager, lo que obliga a crearlas con gcloud a
// mano; mientras faltan, los syncs no consultan nada y las versiones de tienda
// salen vacías en las cards. Dejándolas aquí, el root las configura desde la
// propia interfaz y el sync las lee con su cuenta de servicio.
//
// Las reglas prohíben LEER `storeCredentials` desde el navegador (ni el root
// puede), así que lo único que se puede saber desde aquí es cuándo se guardaron:
// eso vive aparte, en `settings/storeCredentials`.
// ---------------------------------------------------------------------------

const SECRETO = (id: string) => doc(db, "storeCredentials", id);
const META = () => doc(db, "settings", "storeCredentials");

export interface StoreCredentialsMeta {
  playUpdatedAt: string | null;
  playUpdatedBy: string | null;
  ascUpdatedAt: string | null;
  ascUpdatedBy: string | null;
}

export async function getStoreCredentialsMeta(): Promise<StoreCredentialsMeta> {
  const snap = await getDoc(META());
  const d = (snap.exists() ? snap.data() : {}) as Record<string, { toDate?: () => Date } | string | undefined>;
  const iso = (v: unknown): string | null => {
    if (typeof v === "string") return v;
    const conFecha = v as { toDate?: () => Date } | undefined;
    return conFecha?.toDate ? conFecha.toDate().toISOString() : null;
  };
  return {
    playUpdatedAt: iso(d.playUpdatedAt),
    playUpdatedBy: typeof d.playUpdatedBy === "string" ? d.playUpdatedBy : null,
    ascUpdatedAt: iso(d.ascUpdatedAt),
    ascUpdatedBy: typeof d.ascUpdatedBy === "string" ? d.ascUpdatedBy : null,
  };
}

/** Guarda el service account de Play que usa el sync de tracks. */
export async function setPlayServiceAccountForSync(json: string, email: string): Promise<void> {
  const limpio = json.trim();
  let parsed: { type?: string; client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(limpio);
  } catch {
    throw new Error("Eso no es un JSON válido. Pega el archivo completo del service account.");
  }
  if (parsed.type !== "service_account" || !parsed.client_email || !parsed.private_key) {
    throw new Error('El JSON no parece de un service account (falta "type", client_email o private_key).');
  }
  await setDoc(SECRETO("play"), { serviceAccountJson: limpio, updatedBy: email, updatedAt: new Date() });
  await setDoc(META(), { playUpdatedAt: new Date(), playUpdatedBy: email }, { merge: true });
}

/** Guarda la llave de App Store Connect que usa el sync de estado en iOS. */
export async function setAppStoreConnectForSync(
  input: { keyId: string; issuerId: string; privateKey: string },
  email: string,
): Promise<void> {
  const keyId = input.keyId.trim();
  const issuerId = input.issuerId.trim();
  const privateKey = input.privateKey.trim();
  if (!keyId || !issuerId || !privateKey) {
    throw new Error("Faltan datos: Key ID, Issuer ID y el contenido del .p8 son obligatorios.");
  }
  if (!privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error("El .p8 debe pegarse completo, incluyendo las líneas BEGIN/END PRIVATE KEY.");
  }
  await setDoc(SECRETO("appStoreConnect"), {
    keyId, issuerId, privateKey, updatedBy: email, updatedAt: new Date(),
  });
  await setDoc(META(), { ascUpdatedAt: new Date(), ascUpdatedBy: email }, { merge: true });
}
