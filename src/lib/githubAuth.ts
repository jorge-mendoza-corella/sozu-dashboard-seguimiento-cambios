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

export interface RepoAccessCheck {
  ok: boolean;
  /** Explicación accionable cuando ok=false. */
  reason?: string;
}

/**
 * ¿El token tiene acceso (push) al repo? Para validar aprobadores por proyecto.
 * OJO: en repos privados GitHub responde 404 (no 403) cuando la cuenta no es
 * colaboradora — se traduce a un mensaje accionable.
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
    if (!data.permissions?.push) {
      return {
        ok: false,
        reason: "tiene acceso de SOLO LECTURA — súbele el rol a Write en GitHub: repo → Settings → Collaborators",
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "no se pudo contactar a GitHub" };
  }
}
