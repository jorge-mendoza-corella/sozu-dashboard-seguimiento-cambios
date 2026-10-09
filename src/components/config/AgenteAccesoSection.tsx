import { useEffect, useState } from "react";
import { Bot, Loader2, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import { darAccesoAgente, leerAccesoAgente, quitarAccesoAgente } from "@/lib/agenteRepos";

// ---------------------------------------------------------------------------
// Acceso al agente de repos. Cada pregunta consume la API de Anthropic y el
// agente lee el código de todos los repos de la persona, así que se reparte a
// mano: solo el root edita `agente_config/acceso` (ver firestore.rules) y la
// Cloud Function vuelve a validar la lista en cada llamada.
//
// El agente solo ve los repos que la persona ya ve en el dashboard (sus
// proyectos y repos asignados en Usuarios); el root, todos.
// ---------------------------------------------------------------------------

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AgenteAccesoSection() {
  const [emails, setEmails] = useState<string[] | null>(null);
  const [nuevo, setNuevo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const recargar = () => leerAccesoAgente().then(setEmails).catch(() => setEmails([]));
  useEffect(() => { void recargar(); }, []);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(null);
    }
  };

  const agregar = () => {
    const e = nuevo.trim().toLowerCase();
    if (!EMAIL_VALIDO.test(e)) { setError("Correo inválido."); return; }
    void run("agregar", async () => { await darAccesoAgente(e); setNuevo(""); });
  };

  return (
    <Card className="mt-4">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <Bot className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <h2 className="font-semibold">Agente de repos</h2>
            <p className="text-sm text-muted-foreground">
              Quién puede usar el agente (botón flotante, Alt+K). Responde con la documentación de sozu-docs y el
              código de los repos que cada persona ya tiene asignados. Tope: 40 preguntas por hora por persona.
            </p>
          </div>
        </div>

        <ul className="divide-y rounded-md border text-sm">
          <li className="flex items-center gap-2 px-3 py-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <span className="flex-1">{SUPERUSER_EMAIL}</span>
            <Badge variant="secondary">Root · siempre</Badge>
          </li>
          {emails === null ? (
            <li className="flex justify-center px-3 py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></li>
          ) : (
            emails.filter((e) => e !== SUPERUSER_EMAIL).map((e) => (
              <li key={e} className="flex items-center gap-2 px-3 py-2">
                <span className="flex-1">{e}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void run(e, () => quitarAccesoAgente(e))}
                  title="Quitar acceso"
                >
                  {busy === e ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                </Button>
              </li>
            ))
          )}
        </ul>

        <div className="flex gap-2">
          <input
            value={nuevo}
            onChange={(e) => setNuevo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && agregar()}
            placeholder="correo@sozu.com"
            className="h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <Button onClick={agregar} disabled={busy !== null || !nuevo.trim()}>
            {busy === "agregar" ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            Dar acceso
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
