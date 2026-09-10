import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Estado de los tracks de Google Play.
//
// La Play Developer API no se puede llamar desde el navegador (requiere firmar
// un JWT con la llave privada del service account), así que un workflow
// programado — .github/workflows/play-tracks-sync.yml — la consulta cada 30 min
// y deja el resultado en Firestore `playTracks/{package}`. Aquí solo se lee.
// ---------------------------------------------------------------------------

export interface PlayRelease {
  name?: string;
  status?: "completed" | "inProgress" | "draft" | "halted" | string;
  versionCodes?: string[];
  userFraction?: number;
  releaseNotes?: { language: string; text: string }[];
}

export interface PlayTrack {
  track: string;
  releases?: PlayRelease[];
}

export interface PlayTracksDoc {
  package: string;
  updatedAt: string | null;
  tracks: PlayTrack[];
  /**
   * Versión que la ficha pública de Play sirve HOY. No sale de la API —Google
   * no dice si terminó de revisar un envío— sino de leer la página de la app.
   * `null` cuando no se pudo leer o Play la oculta ("varía según el
   * dispositivo").
   */
  storeVersion: string | null;
  /**
   * Rango de descargas que Play enseña en la ficha ("10+", "1 K+"). No es el
   * número exacto de los informes, pero es lo único legible sin permisos.
   */
  storeDownloads: string | null;
  error: string | null;
}

/** Etiqueta y link configurable asociados a cada track de Play. */
export function trackMeta(track: string): {
  label: string;
  linkKind: "playInternalUrl" | "playClosedUrl" | "playOpenUrl" | null;
  order: number;
} {
  const t = track.toLowerCase();
  if (t === "internal") return { label: "Prueba interna", linkKind: "playInternalUrl", order: 1 };
  if (t === "alpha") return { label: "Prueba cerrada (Alpha)", linkKind: "playClosedUrl", order: 2 };
  if (t === "beta") return { label: "Prueba abierta (Beta)", linkKind: "playOpenUrl", order: 3 };
  if (t === "production") return { label: "Producción", linkKind: null, order: 5 };
  // Tracks cerrados personalizados (Play permite crear varios con nombre libre).
  return { label: `Prueba cerrada · ${track}`, linkKind: "playClosedUrl", order: 4 };
}

/** Estado de un release en español + tono para el badge. */
export function releaseStatusInfo(status?: string): { label: string; tone: "success" | "running" | "draft" | "halted" } {
  switch (status) {
    case "completed": return { label: "publicado", tone: "success" };
    case "inProgress": return { label: "en despliegue", tone: "running" };
    case "draft": return { label: "borrador", tone: "draft" };
    case "halted": return { label: "detenido", tone: "halted" };
    default: return { label: status ?? "—", tone: "draft" };
  }
}

export async function getPlayTracks(pkg: string): Promise<PlayTracksDoc | null> {
  const snap = await getDoc(doc(db, "playTracks", pkg));
  if (!snap.exists()) return null;
  const d = snap.data() as {
    package?: string;
    updatedAt?: { toDate?: () => Date };
    raw?: string;
    storeVersion?: string | null;
    storeDownloads?: string | null;
    error?: string | null;
  };
  let tracks: PlayTrack[] = [];
  try {
    tracks = d.raw ? (JSON.parse(d.raw) as PlayTrack[]) : [];
  } catch {
    tracks = [];
  }
  return {
    package: d.package ?? pkg,
    updatedAt: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : null,
    tracks: tracks.sort((a, b) => trackMeta(a.track).order - trackMeta(b.track).order),
    storeVersion: d.storeVersion ?? null,
    storeDownloads: d.storeDownloads ?? null,
    error: d.error ?? null,
  };
}

/** Nombre de la versión de un release; si Play no lo trae, su versionCode. */
const versionDeRelease = (rel: PlayRelease): string | null => {
  if (rel.name?.trim()) return rel.name.trim();
  const codes = (rel.versionCodes ?? []).map(Number).filter((n) => !Number.isNaN(n));
  return codes.length ? String(Math.max(...codes)) : null;
};

export interface PlayPublished {
  version: string;
  track: string;
  status?: string;
  /** false = está en un track de prueba, no en producción. */
  esProduccion: boolean;
}

const ORDEN_TRACKS = ["production", "beta", "alpha", "internal"];

/**
 * Última versión subida a Play, empezando por producción y bajando a los tracks
 * de prueba. No se exige `completed`: un release recién enviado queda en
 * `inProgress` o `draft` mientras Google lo revisa, y con esa exigencia la card
 * mostraba un guión justo después de publicar, que es cuando más se mira.
 * `esProduccion` y `status` quedan a la vista para no confundir un envío a
 * pruebas internas con lo que tiene instalado la gente.
 */
export function playPublishedVersion(doc: PlayTracksDoc | null | undefined): PlayPublished | null {
  if (!doc) return null;
  // Lo primero es lo que la tienda sirve de verdad. La API llama `completed` a
  // un envío que Google todavía revisa, así que preferirla anunciaba como
  // publicada una versión que nadie podía bajar.
  if (doc.storeVersion) {
    const prod = doc.tracks.find((t) => t.track.toLowerCase() === "production");
    const rel = prod?.releases?.find((r) => versionDeRelease(r) === doc.storeVersion);
    return {
      version: doc.storeVersion,
      track: "production",
      status: rel?.status,
      esProduccion: true,
    };
  }
  const candidatos = [...doc.tracks].sort((a, b) => {
    const ia = ORDEN_TRACKS.indexOf(a.track.toLowerCase());
    const ib = ORDEN_TRACKS.indexOf(b.track.toLowerCase());
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const t of candidatos) {
    const rel =
      t.releases?.find((r) => r.status === "completed") ??
      t.releases?.find((r) => r.status === "inProgress") ??
      t.releases?.[0];
    const version = rel ? versionDeRelease(rel) : null;
    if (version) {
      return {
        version,
        track: t.track,
        status: rel?.status,
        esProduccion: t.track.toLowerCase() === "production",
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Los tres canales de Android, leídos como los de iOS.
//
// La card enseñaba un track por tarjeta y trataba el release de producción como
// "publicado", que es lo que dice la API… mientras Google todavía revisa. La
// app de clientes anunciaba 1.1.5 en producción teniendo 1.0.9 en la tienda.
// Google no expone el estado de revisión, así que la versión publicada se lee
// de la ficha pública (`storeVersion`) y el release del track queda como lo
// ENVIADO: si los dos números no coinciden, lo enviado sigue en camino.
// ---------------------------------------------------------------------------

export type TonoPlay = "success" | "running" | "draft" | "halted";

export interface PlayChannel {
  key: "interna" | "revision" | "produccion";
  label: string;
  version: string | null;
  /** Código de versión (build) del release, cuando lo hay. */
  build?: string | null;
  estado: { label: string; tone: TonoPlay };
  /** Link de invitación configurable del canal (solo el de pruebas). */
  linkKind?: "playInternalUrl";
  /** Qué decir cuando el canal está vacío. */
  vacio?: string;
}

const releaseVigente = (t: PlayTrack | undefined): PlayRelease | null =>
  t?.releases?.find((r) => r.status === "completed") ??
  t?.releases?.find((r) => r.status === "inProgress") ??
  t?.releases?.[0] ??
  null;

const trackDe = (doc: PlayTracksDoc | null | undefined, nombre: string): PlayTrack | undefined =>
  doc?.tracks.find((t) => t.track.toLowerCase() === nombre);

const buildDe = (rel: PlayRelease | null): string | null => (rel?.versionCodes ?? [])[0] ?? null;

/**
 * Qué hay en prueba interna, en revisión y en producción. Cada canal se
 * resuelve por separado, igual que en iOS: que un envío esté en revisión no
 * borra la versión que la gente sigue teniendo.
 */
export function playChannels(doc: PlayTracksDoc | null | undefined): PlayChannel[] {
  const relInterna = releaseVigente(trackDe(doc, "internal"));
  const interna: PlayChannel = relInterna
    ? {
        key: "interna",
        label: "Prueba interna",
        version: versionDeRelease(relInterna),
        build: buildDe(relInterna),
        estado: releaseStatusInfo(relInterna.status),
        linkKind: "playInternalUrl",
      }
    : {
        key: "interna",
        label: "Prueba interna",
        version: null,
        estado: { label: "—", tone: "draft" },
        linkKind: "playInternalUrl",
        vacio: "Nada subido al track interno todavía.",
      };

  const relProd = releaseVigente(trackDe(doc, "production"));
  const enviada = relProd ? versionDeRelease(relProd) : null;
  const publica = doc?.storeVersion ?? null;
  // Sin la ficha pública no hay con qué comparar: entonces se dice lo único
  // seguro —que se envió— en vez de afirmar que está publicada.
  const seSabePublica = !!publica;
  const yaSalio = seSabePublica && !!enviada && enviada === publica;

  const revision: PlayChannel =
    enviada && !yaSalio
      ? {
          key: "revision",
          label: "En camino (revisión)",
          version: enviada,
          build: buildDe(relProd),
          estado: seSabePublica
            ? { label: "en revisión de Google", tone: "running" }
            : { label: "enviada a producción", tone: "running" },
        }
      : {
          key: "revision",
          label: "En camino (revisión)",
          version: null,
          estado: { label: "—", tone: "draft" },
          vacio: enviada
            ? "Nada en camino: lo enviado ya está publicado."
            : "Ningún envío a producción todavía.",
        };

  const produccion: PlayChannel = publica
    ? {
        key: "produccion",
        label: "Producción (Play Store)",
        version: publica,
        // El código de versión solo se conoce si la publicada es la enviada:
        // la ficha pública no lo dice.
        build: yaSalio ? buildDe(relProd) : null,
        estado: { label: "disponible en Play", tone: "success" },
      }
    : {
        key: "produccion",
        label: "Producción (Play Store)",
        version: enviada,
        build: buildDe(relProd),
        estado: enviada
          ? { label: "enviada · Play no confirma", tone: "draft" }
          : { label: "—", tone: "draft" },
        vacio: enviada ? undefined : "Ninguna versión en producción todavía.",
      };

  return [interna, revision, produccion];
}

/**
 * Versión enviada a producción que Play todavía no sirve. Es lo que falta para
 * leer la card sin abrir el panel: el número que se ve es el de la tienda, y
 * este dice qué viene detrás.
 */
export function playEnCamino(doc: PlayTracksDoc | null | undefined): string | null {
  const [, revision] = playChannels(doc);
  return revision.version;
}

const SYNC_REPO = { owner: "jorge-mendoza-corella", repo: "sozu-dashboard-seguimiento-cambios" };
const SYNC_WORKFLOW = "play-tracks-sync.yml";

/**
 * Dispara el workflow de sincronización (workflow_dispatch) para refrescar el
 * estado sin esperar al cron. Requiere un token con scope `repo` sobre el
 * repositorio del dashboard.
 */
export async function triggerPlayTracksSync(): Promise<void> {
  const token = import.meta.env.VITE_GITHUB_REVIEWER_TOKEN || import.meta.env.VITE_GITHUB_TOKEN;
  if (!token) throw new Error("Sin token de GitHub para disparar la sincronización.");
  const res = await fetch(
    `https://api.github.com/repos/${SYNC_REPO.owner}/${SYNC_REPO.repo}/actions/workflows/${SYNC_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  if (!res.ok && res.status !== 204) {
    const body = await res.text();
    throw new Error(
      res.status === 404
        ? "El workflow de sincronización aún no existe en main (o el token no tiene acceso al repo del dashboard)."
        : `GitHub ${res.status}: ${body.slice(0, 200)}`,
    );
  }
}
