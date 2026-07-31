import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Canales de Firebase Hosting de un sitio (los "preview channels" tipo draft).
// Los vuelca el workflow programado en `hostingChannels/{site}`; aquí solo se
// leen para saber si un draft trae contenido que aún no se publica.
// ---------------------------------------------------------------------------

export interface HostingChannel {
  id: string;
  url?: string;
  version?: string | null;
  updateTime?: string;
  expireTime?: string;
  /** true = su contenido ya es el mismo que está en vivo. */
  published: boolean;
}

export interface HostingChannelsDoc {
  site: string;
  updatedAt: string | null;
  liveVersion: string | null;
  channels: HostingChannel[];
  error: string | null;
}

export async function getHostingChannels(site: string): Promise<HostingChannelsDoc | null> {
  const snap = await getDoc(doc(db, "hostingChannels", site));
  if (!snap.exists()) return null;
  const d = snap.data() as {
    site?: string;
    updatedAt?: { toDate?: () => Date };
    raw?: string;
    error?: string | null;
  };
  let raw: { liveVersion?: string | null; channels?: HostingChannel[] } = {};
  try {
    raw = d.raw ? JSON.parse(d.raw) : {};
  } catch {
    raw = {};
  }
  return {
    site: d.site ?? site,
    updatedAt: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : null,
    liveVersion: raw.liveVersion ?? null,
    channels: raw.channels ?? [],
    error: d.error ?? null,
  };
}

/**
 * Canal con cambios sin publicar (el más reciente si hay varios). Devuelve
 * null cuando todo lo del draft ya está en vivo o el canal expiró.
 */
export function pendingDraft(data: HostingChannelsDoc | null | undefined): HostingChannel | null {
  if (!data) return null;
  const now = Date.now();
  const pend = data.channels
    .filter((c) => !c.published && c.url)
    .filter((c) => !c.expireTime || new Date(c.expireTime).getTime() > now)
    .sort((a, b) => (b.updateTime ?? "").localeCompare(a.updateTime ?? ""));
  return pend[0] ?? null;
}
