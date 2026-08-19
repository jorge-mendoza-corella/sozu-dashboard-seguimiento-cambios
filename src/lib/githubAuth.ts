// ---------------------------------------------------------------------------
// Validación de PATs de GitHub por usuario. Cada usuario del dashboard opera
// con SU propio token (nada fixeado): las acciones CI/CD salen a nombre de su
// cuenta de GitHub real.
//
// Dónde se obtiene el token (instrucciones que muestra la UI):
//   github.com → Settings → Developer settings → Personal access tokens →
//   Tokens (classic) → Generate new token → scope `repo` → Generate.
// ---------------------------------------------------------------------------

export interface TokenValidation {
  ok: boolean;
  login?: string;
  error?: string;
}

/** Verifica el token contra GitHub y devuelve el login de la cuenta. */
export async function validateGithubToken(token: string): Promise<TokenValidation> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (res.status === 401) return { ok: false, error: "Token inválido o expirado." };
    if (!res.ok) return { ok: false, error: `GitHub respondió ${res.status}.` };
    const data = await res.json();
    // El token debe tener scope repo para crear PRs/mergear (tokens classic
    // exponen sus scopes en el header x-oauth-scopes; fine-grained no).
    const scopes = res.headers.get("x-oauth-scopes") ?? "";
    if (scopes && !scopes.split(",").map((s) => s.trim()).includes("repo")) {
      return { ok: false, login: data.login, error: `El token de @${data.login} no tiene el scope "repo".` };
    }
    return { ok: true, login: data.login };
  } catch {
    return { ok: false, error: "No se pudo contactar a GitHub." };
  }
}

/** ¿La cuenta del token puede VER el repo? (lectura basta — gate de visibilidad). */
export async function canReadRepo(token: string, owner: string, repo: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface RepoAccessCheck {
  ok: boolean;
  /** Explicación accionable cuando ok=false. */
  reason?: string;
  /**
   * Nombre canónico del repo cuando el que se pidió ya NO es el suyo (alguien
   * lo renombró en GitHub). Solo viene si difiere de lo pedido.
   */
  renamedTo?: { owner: string; repo: string };
}

/**
 * Nombre real que devolvió GitHub, si no es el que se pidió. GitHub sigue los
 * renombres: el GET al nombre viejo responde 200 pero con el `full_name` NUEVO.
 * Comparación sin distinguir mayúsculas porque GitHub tampoco las distingue.
 */
function detectarRenombre(
  fullName: unknown,
  owner: string,
  repo: string,
): { owner: string; repo: string } | undefined {
  if (typeof fullName !== "string") return undefined;
  const [ownerReal, repoReal] = fullName.split("/");
  if (!ownerReal || !repoReal) return undefined;
  const igual =
    ownerReal.toLowerCase() === owner.toLowerCase() &&
    repoReal.toLowerCase() === repo.toLowerCase();
  return igual ? undefined : { owner: ownerReal, repo: repoReal };
}

/**
 * ¿El token tiene acceso (push) al repo? Para validar aprobadores por proyecto.
 * OJO: en repos privados GitHub responde 404 (no 403) cuando la cuenta no es
 * colaboradora — se traduce a un mensaje accionable.
 *
 * De paso reporta el renombre: es el único lugar donde ya se le pregunta a
 * GitHub por el repo, así que detectarlo aquí no cuesta ni una llamada extra.
 */
export async function checkRepoAccess(token: string, owner: string, repo: string): Promise<RepoAccessCheck> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (res.status === 404) {
      return {
        ok: false,
        reason: "su cuenta NO es colaboradora del repo — invítala en GitHub: repo → Settings → Collaborators → Add people, con rol Write",
      };
    }
    if (res.status === 401) {
      return { ok: false, reason: "su API key es inválida o expiró — pídele actualizarla" };
    }
    if (!res.ok) {
      return { ok: false, reason: `GitHub respondió ${res.status}` };
    }
    const data = await res.json();
    // El renombre viaja igual en las dos salidas: el repo existe y responde,
    // solo cambió de nombre — eso hay que decirlo aunque el acceso no alcance.
    const renamedTo = detectarRenombre(data.full_name, owner, repo);
    if (!data.permissions?.push) {
      return {
        ok: false,
        reason: "tiene acceso de SOLO LECTURA — súbele el rol a Write en GitHub: repo → Settings → Collaborators",
        ...(renamedTo ? { renamedTo } : {}),
      };
    }
    return { ok: true, ...(renamedTo ? { renamedTo } : {}) };
  } catch {
    return { ok: false, reason: "no se pudo contactar a GitHub" };
  }
}
