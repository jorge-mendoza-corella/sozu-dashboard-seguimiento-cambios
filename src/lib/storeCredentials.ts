import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Credenciales de tienda POR PROYECTO APP (service account de Play, llave de
// App Store Connect). Las usan los syncs programados para leer el estado de las
// tiendas, y Codemagic para publicar.
//
// Antes eran una sola para todo el dashboard (`storeCredentials/{play,asc}`), lo
// que con varias apps —de empresas distintas, en cuentas de tienda distintas—
// significaba que la credencial de una servía para todas. Ahora cada proyecto
// tiene las suyas:
//
//   `projects/{id}/private/playSecret`  { serviceAccountJson }
//   `projects/{id}/private/ascSecret`   { keyId, issuerId, privateKey }
//
// Las reglas prohíben LEER esa subcolección desde el navegador (ni el root
// puede): solo escribirla. Lo único que se puede saber desde aquí es cuándo y
// quién las guardó, y eso vive en campos visibles del propio doc del proyecto.
// Quien las consume es la cuenta de servicio de los syncs, que ignora las reglas.
//
// Los docs globales siguen existiendo como respaldo heredado: los syncs los usan
// cuando un proyecto todavía no tiene los suyos, así que la migración no deja a
// ninguna app sin publicar (ver `ci/migrate_store_credentials.py`).
// ---------------------------------------------------------------------------

const SECRETO_PLAY = (projectId: string) => doc(db, "projects", projectId, "private", "playSecret");
const SECRETO_ASC = (projectId: string) => doc(db, "projects", projectId, "private", "ascSecret");
const PROYECTO = (projectId: string) => doc(db, "projects", projectId);

export interface ProjectCredentialsMeta {
  playUpdatedAt: string | null;
  playUpdatedBy: string | null;
  ascUpdatedAt: string | null;
  ascUpdatedBy: string | null;
}

const iso = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  const conFecha = v as { toDate?: () => Date } | undefined;
  return conFecha?.toDate ? conFecha.toDate().toISOString() : null;
};

const texto = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * Cuándo y quién dejó las credenciales de ese proyecto. Sale del doc del
 * proyecto, no de los secretos: esos no se pueden leer.
 */
export async function getProjectCredentialsMeta(projectId: string): Promise<ProjectCredentialsMeta> {
  const snap = await getDoc(PROYECTO(projectId));
  const d = (snap.exists() ? snap.data() : {}) as Record<string, unknown>;
  return {
    playUpdatedAt: iso(d.playCredentialsUpdatedAt),
    playUpdatedBy: texto(d.playCredentialsUpdatedBy),
    ascUpdatedAt: iso(d.ascCredentialsUpdatedAt),
    ascUpdatedBy: texto(d.ascCredentialsUpdatedBy),
  };
}

/** Guarda el service account de Play que usan el sync y Codemagic de ESE proyecto. */
export async function setPlayServiceAccountForProject(
  projectId: string,
  json: string,
  email: string,
): Promise<void> {
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
  await setDoc(SECRETO_PLAY(projectId), {
    serviceAccountJson: limpio,
    // El correo del service account no es secreto y ayuda a depurar accesos en
    // Play Console; se guarda aparte para poder mostrarlo sin abrir el JSON.
    clientEmail: parsed.client_email,
    updatedBy: email,
    updatedAt: new Date(),
  });
  await setDoc(
    PROYECTO(projectId),
    { playCredentialsUpdatedAt: new Date(), playCredentialsUpdatedBy: email },
    { merge: true },
  );
}

/** Guarda la llave de App Store Connect de ESE proyecto. */
export async function setAppStoreConnectForProject(
  projectId: string,
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
  await setDoc(SECRETO_ASC(projectId), {
    keyId,
    issuerId,
    privateKey,
    updatedBy: email,
    updatedAt: new Date(),
  });
  await setDoc(
    PROYECTO(projectId),
    { ascCredentialsUpdatedAt: new Date(), ascCredentialsUpdatedBy: email },
    { merge: true },
  );
}
