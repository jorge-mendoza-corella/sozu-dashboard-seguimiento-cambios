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

/** ¿El token tiene acceso (push) al repo? Para validar aprobadores por proyecto. */
export async function checkRepoAccess(token: string, owner: string, repo: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.permissions?.push;
  } catch {
    return false;
  }
}
