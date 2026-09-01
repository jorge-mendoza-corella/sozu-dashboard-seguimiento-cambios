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
  /** Número de build de Apple ("82"). Es lo que Apple llama `version` aquí. */
  version?: string;
  /** Versión de mercado del build ("1.0.8"), de su `preReleaseVersion`. */
  shortVersion?: string;
  processingState?: string;
  uploadedDate?: string;
  expirationDate?: string;
  expired?: boolean;
  /** INTERNAL_ONLY = solo el equipo; APP_STORE_ELIGIBLE = también externos. */
  audience?: string;
  /** Beta review de Apple: sin ella el build no llega a testers externos. */
  betaState?: string;
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
    case "READY_FOR_REVIEW":
      // Estado del enum nuevo (`appVersionState`). Sin este caso caía al default
      // y la card mostraba el literal de Apple, "ready for review", en inglés.
      return { label: "lista para enviar", tone: "draft" };
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

export interface AppStorePublished {
  version: string;
  state?: string;
  /** false = enviada pero todavía no a la venta (en revisión, preparándose…). */
  aLaVenta: boolean;
}

/**
 * Versión más avanzada en el App Store: la que está a la venta y, si no hay,
 * la última enviada. Exigir `READY_FOR_SALE` dejaba un guión en la card justo
 * después de publicar, mientras Apple revisa — que es cuando más se consulta.
 * `aLaVenta` distingue una de otra.
 */
export function appStoreLiveVersion(doc: AppStoreStatusDoc | null | undefined): AppStorePublished | null {
  const live = doc?.versions.find((v) => v.state === "READY_FOR_SALE");
  if (live?.version?.trim()) {
    return { version: live.version.trim(), state: live.state, aLaVenta: true };
  }
  const enCurso = doc?.versions.find((v) => v.version?.trim());
  if (!enCurso?.version) return null;
  return { version: enCurso.version.trim(), state: enCurso.state, aLaVenta: false };
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

// ---------------------------------------------------------------------------
// Los tres canales de iOS, para leerlos igual que los tracks de Play.
//
// La card enseñaba UNA fila —la versión más reciente de App Store Connect— y con
// eso no se podía contestar ninguna de las dos preguntas que se hacen a diario:
// qué están probando los testers y qué tiene instalado la gente. Con la versión
// en revisión arriba, "producción" quedaba invisible aunque el dato ya estuviera
// en el documento.
// ---------------------------------------------------------------------------

export type Tono = "success" | "running" | "draft" | "halted";

export interface AppStoreChannel {
  key: "testflight" | "revision" | "produccion";
  label: string;
  /** Versión de mercado ("1.0.8"), o null si el canal está vacío. */
  version: string | null;
  /** Número de build de Apple; solo TestFlight lo tiene. */
  build?: string | null;
  estado: { label: string; tone: Tono };
  /** Fecha relevante del canal (subida del build, creación de la versión). */
  fecha?: string | null;
  /** Qué decir cuando el canal está vacío. */
  vacio?: string;
}

/** Estados en los que la versión ya está a la venta. */
const A_LA_VENTA = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"]);

/** Versiones que ya no van a ninguna parte: no son "lo que viene". */
const CERRADAS = new Set([
  "REPLACED_WITH_NEW_VERSION",
  "REMOVED_FROM_SALE",
  "DEVELOPER_REMOVED_FROM_SALE",
]);

/** Estado del build dentro de TestFlight, ya en español. */
function testflightEstado(b: AppStoreBuild): { label: string; tone: Tono } {
  if (b.processingState && b.processingState !== "VALID") {
    const tone: Tono = b.processingState === "PROCESSING" ? "running" : "halted";
    return { label: buildStateLabel(b.processingState), tone };
  }
  switch (b.betaState) {
    case "APPROVED":
      return { label: "en TestFlight", tone: "success" };
    case "IN_REVIEW":
      return { label: "en revisión de TestFlight", tone: "running" };
    case "WAITING_FOR_REVIEW":
      return { label: "esperando revisión de TestFlight", tone: "running" };
    case "REJECTED":
      return { label: "rechazada por TestFlight", tone: "halted" };
    default:
      // Sin beta review, el build ya lo tienen los testers INTERNOS; los
      // externos no. Decir "en TestFlight" a secas sería prometer de más.
      return b.audience === "INTERNAL_ONLY"
        ? { label: "listo · solo equipo interno", tone: "success" }
        : { label: "listo · testers internos", tone: "success" };
  }
}

/**
 * Qué hay en TestFlight, en revisión y en producción. Cada canal se resuelve por
 * separado: que una versión esté en revisión no borra la que sigue a la venta.
 */
export function appStoreChannels(doc: AppStoreStatusDoc | null | undefined): AppStoreChannel[] {
  const versions = doc?.versions ?? [];
  const builds = doc?.builds ?? [];

  // TestFlight: el build más reciente que todavía no expira. Uno expirado ya no
  // se puede instalar, así que anunciarlo como disponible sería mentira.
  const vivo = builds.find((b) => !b.expired);
  const testflight: AppStoreChannel = vivo
    ? {
        key: "testflight",
        label: "TestFlight (pruebas)",
        version: vivo.shortVersion?.trim() || null,
        build: vivo.version?.trim() || null,
        estado: testflightEstado(vivo),
        fecha: vivo.uploadedDate ?? null,
      }
    : {
        key: "testflight",
        label: "TestFlight (pruebas)",
        version: null,
        estado: { label: "—", tone: "draft" },
        vacio: builds.length
          ? "El último build subido ya expiró; sube uno nuevo."
          : "Sin builds subidos todavía.",
      };

  const enVenta = versions.find((v) => v.state && A_LA_VENTA.has(v.state) && v.version?.trim());
  const produccion: AppStoreChannel = enVenta
    ? {
        key: "produccion",
        label: "Producción (App Store)",
        version: enVenta.version!.trim(),
        estado: versionStateInfo(enVenta.state),
        fecha: enVenta.createdDate ?? null,
      }
    : {
        key: "produccion",
        label: "Producción (App Store)",
        version: null,
        estado: { label: "—", tone: "draft" },
        vacio: "Ninguna versión está a la venta todavía.",
      };

  // En camino: la versión más nueva que no está a la venta ni descartada. Es la
  // que ocupaba sola la card.
  const camino = versions.find(
    (v) => v.version?.trim() && v.state && !A_LA_VENTA.has(v.state) && !CERRADAS.has(v.state),
  );
  const revision: AppStoreChannel = camino
    ? {
        key: "revision",
        label: "En camino (revisión)",
        version: camino.version!.trim(),
        estado: versionStateInfo(camino.state),
        fecha: camino.createdDate ?? null,
      }
    : {
        key: "revision",
        label: "En camino (revisión)",
        version: null,
        estado: { label: "—", tone: "draft" },
        vacio: "Ninguna versión en camino a la tienda.",
      };

  return [testflight, revision, produccion];
}
