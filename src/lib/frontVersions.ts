import { collection, getDocs } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Versión que sirve cada front (los repos con `frontUrl`).
//
// No se puede leer desde el navegador: los sitios no mandan cabeceras CORS, así
// que un `fetch` a otro dominio muere antes de empezar. Lo resuelve el workflow
// programado (ci/front_versions_sync.py), que descarga el sitio y deja aquí lo
// que encontró: `frontVersions/{owner__repo}`.
// ---------------------------------------------------------------------------

export interface FrontVersion {
  /** Versión servida, o null si el sitio no la publica de forma reconocible. */
  version: string | null;
  /** De dónde salió: version.json, meta, html o bundle. */
  source: string | null;
  url: string | null;
  checkedAt: string | null;
  error: string | null;
}

/** Versiones por id de repo (`owner__repo`). */
export async function getFrontVersions(): Promise<Record<string, FrontVersion>> {
  const snap = await getDocs(collection(db, "frontVersions"));
  const out: Record<string, FrontVersion> = {};
  for (const d of snap.docs) {
    const data = d.data() as {
      version?: string | null;
      source?: string | null;
      url?: string | null;
      checkedAt?: { toDate?: () => Date } | string | null;
      error?: string | null;
    };
    const checked = data.checkedAt;
    out[d.id] = {
      version: data.version ?? null,
      source: data.source ?? null,
      url: data.url ?? null,
      checkedAt:
        typeof checked === "string"
          ? checked
          : checked?.toDate
            ? checked.toDate().toISOString()
            : null,
      error: data.error ?? null,
    };
  }
  return out;
}
