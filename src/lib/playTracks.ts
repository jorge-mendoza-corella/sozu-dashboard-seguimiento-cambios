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
  const d = snap.data() as { package?: string; updatedAt?: { toDate?: () => Date }; raw?: string; error?: string | null };
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
    error: d.error ?? null,
  };
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
