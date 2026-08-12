import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Estado de la app en App Store Connect. Apple sí expone el estado de revisión
// por API (a diferencia de Google Play), pero firmar el JWT ES256 exige la
// llave privada .p8, así que lo consulta el workflow programado y aquí se lee
// de Firestore `appStoreStatus/{bundleId}`.
// ---------------------------------------------------------------------------

export interface AppStoreVersion {
  version?: string;
  state?: string;
  platform?: string;
  createdDate?: string;
}

export interface AppStoreBuild {
  version?: string;
  processingState?: string;
  uploadedDate?: string;
  expired?: boolean;
}

export interface AppStoreStatusDoc {
  bundleId: string;
  updatedAt: string | null;
  appName: string | null;
  versions: AppStoreVersion[];
  builds: AppStoreBuild[];
  reviewSubmissions: { state?: string; submittedDate?: string }[];
  error: string | null;
}

/** Estado de una versión en español + tono del badge. */
export function versionStateInfo(state?: string): {
  label: string;
  tone: "success" | "running" | "draft" | "halted";
} {
  switch (state) {
    case "READY_FOR_SALE":
    case "READY_FOR_DISTRIBUTION":
      return { label: "publicada", tone: "success" };
    case "IN_REVIEW":
      return { label: "en revisión", tone: "running" };
    case "WAITING_FOR_REVIEW":
      return { label: "esperando revisión", tone: "running" };
    case "PENDING_APPLE_RELEASE":
      return { label: "aprobada, la libera Apple", tone: "running" };
    case "PENDING_DEVELOPER_RELEASE":
      return { label: "aprobada — falta que la publiques", tone: "running" };
    case "PROCESSING_FOR_DISTRIBUTION":
    case "PROCESSING_FOR_APP_STORE":
      return { label: "procesando", tone: "running" };
    case "PREPARE_FOR_SUBMISSION":
      return { label: "sin enviar", tone: "draft" };
    case "WAITING_FOR_EXPORT_COMPLIANCE":
      return { label: "falta cumplimiento de exportación", tone: "draft" };
    case "REJECTED":
    case "DEVELOPER_REJECTED":
      return { label: "rechazada", tone: "halted" };
    case "METADATA_REJECTED":
      return { label: "metadatos rechazados", tone: "halted" };
    case "INVALID_BINARY":
      return { label: "binario inválido", tone: "halted" };
    case "DEVELOPER_REMOVED_FROM_SALE":
    case "REMOVED_FROM_SALE":
      return { label: "retirada", tone: "draft" };
    case "REPLACED_WITH_NEW_VERSION":
      return { label: "reemplazada", tone: "draft" };
    default:
      return { label: state ? state.toLowerCase().replace(/_/g, " ") : "—", tone: "draft" };
  }
}

/** Estado de procesamiento de un build subido. */
export function buildStateLabel(state?: string): string {
  switch (state) {
    case "VALID": return "listo";
    case "PROCESSING": return "procesando";
    case "FAILED": return "falló";
    case "INVALID": return "inválido";
    default: return state ?? "—";
  }
}

/**
 * Versión que hoy está a la venta en el App Store: la que quedó
 * `READY_FOR_SALE`. Las que están en revisión o preparándose no cuentan, así
 * que si no hay ninguna a la venta devuelve null (aún no se ha publicado nada).
 */
export function appStoreLiveVersion(doc: AppStoreStatusDoc | null | undefined): string | null {
  const live = doc?.versions.find((v) => v.state === "READY_FOR_SALE");
  return live?.version?.trim() || null;
}

export async function getAppStoreStatus(bundleId: string): Promise<AppStoreStatusDoc | null> {
  const snap = await getDoc(doc(db, "appStoreStatus", bundleId));
  if (!snap.exists()) return null;
  const d = snap.data() as {
    bundleId?: string;
    updatedAt?: { toDate?: () => Date };
    raw?: string;
    error?: string | null;
  };
  let raw: {
    appName?: string;
    versions?: AppStoreVersion[];
    builds?: AppStoreBuild[];
    reviewSubmissions?: { state?: string; submittedDate?: string }[];
  } = {};
  try {
    raw = d.raw ? JSON.parse(d.raw) : {};
  } catch {
    raw = {};
  }
  return {
    bundleId: d.bundleId ?? bundleId,
    updatedAt: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : null,
    appName: raw.appName ?? null,
    versions: raw.versions ?? [],
    builds: raw.builds ?? [],
    reviewSubmissions: raw.reviewSubmissions ?? [],
    error: d.error ?? null,
  };
}
