import { useState } from "react";
import { KeyRound, Loader2, ExternalLink, LogOut, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { validateGithubToken } from "@/lib/githubAuth";
import { setUserGithubToken } from "@/lib/firestoreUsers";
import { setSessionGithubAuth } from "@/lib/github";

/**
 * Pantalla bloqueante: el usuario NO puede usar el dashboard hasta registrar
 * su API key (PAT) de GitHub. Las acciones CI/CD (PRs, merges, aprobaciones)
 * salen a nombre de su propia cuenta — nada de tokens fijos compartidos.
 * El superusuario raíz está exento (App.tsx no monta este gate para él).
 */
export function GithubTokenGate({ email, onUnlocked, logout }: {
  email: string;
  onUnlocked: () => void;
  logout: () => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    const t = token.trim();
    if (!t) return;
    setBusy(true);
    setError("");
    const v = await validateGithubToken(t);
    if (!v.ok || !v.login) {
      setError(v.error ?? "Token inválido.");
      setBusy(false);
      return;
    }
    try {
      await setUserGithubToken(email, t, v.login);
      setSessionGithubAuth(t, v.login);
      onUnlocked();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar el token.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="p-6">
          <h1 className="flex items-center gap-2 text-lg font-bold">
            <KeyRound className="h-5 w-5 text-primary" />
            Configura tu API key de GitHub
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Para usar el dashboard necesitas registrar tu <span className="font-medium text-foreground">Personal
            Access Token</span> de GitHub. Los PRs, aprobaciones y merges que hagas
            saldrán a nombre de <span className="font-medium text-foreground">tu propia cuenta</span>.
            Sin este paso no es posible continuar.
          </p>

          <div className="mt-4 rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">
            <p className="font-semibold">¿Dónde la obtengo?</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-muted-foreground">
              <li>
                Entra a{" "}
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo&description=SOZU%20Tracker"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 font-medium text-primary underline"
                >
                  github.com/settings/tokens/new <ExternalLink className="h-3 w-3" />
                </a>{" "}
                (Settings → Developer settings → Personal access tokens → Tokens classic)
              </li>
              <li>Ponle un nombre (ej. "SOZU Tracker") y marca el scope <code className="rounded bg-muted px-1">repo</code></li>
              <li>Click en <span className="font-medium">Generate token</span> y copia el valor <code className="rounded bg-muted px-1">ghp_…</code></li>
            </ol>
          </div>

          <div className="mt-4">
            <label className="text-xs font-medium">API key (PAT) <span className="text-destructive">*</span></label>
            <input
              type="password"
              autoFocus
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
              placeholder="ghp_…"
              value={token}
              onChange={(e) => { setToken(e.target.value); if (error) setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
            {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
            <p className="mt-1 text-[11px] text-muted-foreground">
              Se valida contra GitHub antes de guardarse. Tu cuenta de GitHub debe tener acceso a los repos de tus proyectos.
            </p>
          </div>

          <div className="mt-5 flex items-center justify-between">
            <Button variant="ghost" size="sm" onClick={logout} className="text-muted-foreground">
              <LogOut className="h-4 w-4 mr-1.5" /> Salir
            </Button>
            <Button onClick={handleSave} disabled={busy || !token.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <CheckCircle2 className="h-4 w-4 mr-1.5" />}
              Validar y guardar
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
