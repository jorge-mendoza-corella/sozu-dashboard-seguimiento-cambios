import { useEffect, useState } from "react";
import { BellRing, Bot, FileText, Loader2, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import { cambiarTickets, cambiarVerDocs, darAccesoAgente, leerAccesoAgente, quitarAccesoAgente } from "@/lib/agenteRepos";

// ---------------------------------------------------------------------------
// Acceso al agente de repos. Cada pregunta consume la API de Anthropic y el
// agente lee el código de todos los repos de la persona, así que se reparte a
// mano: solo el root edita `agente_config/acceso` (ver firestore.rules) y las
// Cloud Functions vuelven a validar las listas en cada llamada.
//
// Dos permisos por persona:
//   · Agente: ve el botón y pregunta (lista `emails`).
//   · Ver documentación: puede abrir los documentos de sozu-docs que el agente
//     cita (lista `docs`). Apagado, los ve listados pero sin poder abrirlos.
//
// El agente solo ve los repos que la persona ya ve en el dashboard (sus
// proyectos y repos asignados en Usuarios); el root, todos.
// ---------------------------------------------------------------------------

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Interruptor({ activo, deshabilitado, onCambiar, etiqueta }: {
  activo: boolean;
  deshabilitado?: boolean;
  onCambiar?: () => void;
  etiqueta: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      aria-label={etiqueta}
      title={etiqueta}
      disabled={deshabilitado}
      onClick={onCambiar}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        activo ? "bg-primary" : "bg-muted-foreground/30",
      )}
    >
      <span className={cn("inline-block h-4 w-4 rounded-full bg-background shadow transition-transform", activo ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function AgenteAccesoSection() {
  const [acceso, setAcceso] = useState<{ emails: string[]; docs: string[]; tickets: string[] } | null>(null);
  const [nuevo, setNuevo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const recargar = () => leerAccesoAgente().then(setAcceso).catch(() => setAcceso({ emails: [], docs: [], tickets: [] }));
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
              Quién puede usar el agente (botón flotante, Alt+K) y quién puede además abrir la documentación que cita.
              Responde con sozu-docs y el código de los repos que cada persona ya tiene asignados. Tope: 40 preguntas por
              hora por persona.
            </p>
          </div>
        </div>

        <div className="overflow-hidden rounded-md border text-sm">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="flex-1">Persona</span>
            <span className="flex w-28 items-center justify-center gap-1"><FileText className="h-3 w-3" /> Ver docs</span>
            <span className="flex w-28 items-center justify-center gap-1"><BellRing className="h-3 w-3" /> Tickets</span>
            <span className="w-9" />
          </div>
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <span className="flex-1">{SUPERUSER_EMAIL}</span>
            <span className="flex w-28 justify-center"><Interruptor activo deshabilitado etiqueta="Root: siempre ve la documentación" /></span>
            <span className="flex w-28 justify-center">
              {busy === `tickets:${SUPERUSER_EMAIL}` ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <Interruptor
                  activo={!!acceso?.tickets.includes(SUPERUSER_EMAIL)}
                  deshabilitado={busy !== null || acceso === null}
                  onCambiar={() => void run(`tickets:${SUPERUSER_EMAIL}`, () => cambiarTickets(SUPERUSER_EMAIL, !acceso?.tickets.includes(SUPERUSER_EMAIL)))}
                  etiqueta="Revisar mis tickets cada 15 min"
                />
              )}
            </span>
            <Badge variant="secondary" className="w-9 justify-center px-0">Root</Badge>
          </div>
          {acceso === null ? (
            <div className="flex justify-center px-3 py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : (
            acceso.emails.filter((e) => e !== SUPERUSER_EMAIL).map((e) => {
              const verDocs = acceso.docs.includes(e);
              const revisaTickets = acceso.tickets.includes(e);
              return (
                <div key={e} className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
                  <span className="flex-1 truncate">{e}</span>
                  <span className="flex w-28 justify-center">
                    {busy === `docs:${e}` ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Interruptor
                        activo={verDocs}
                        deshabilitado={busy !== null}
                        onCambiar={() => void run(`docs:${e}`, () => cambiarVerDocs(e, !verDocs))}
                        etiqueta={verDocs ? "Quitar permiso para ver documentación" : "Dar permiso para ver documentación"}
                      />
                    )}
                  </span>
                  <span className="flex w-28 justify-center">
                    {busy === `tickets:${e}` ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Interruptor
                        activo={revisaTickets}
                        deshabilitado={busy !== null}
                        onCambiar={() => void run(`tickets:${e}`, () => cambiarTickets(e, !revisaTickets))}
                        etiqueta={revisaTickets ? "Dejar de revisar sus tickets" : "Revisar sus tickets cada 15 min"}
                      />
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-9 px-0"
                    disabled={busy !== null}
                    onClick={() => void run(e, () => quitarAccesoAgente(e))}
                    title="Quitar acceso al agente"
                  >
                    {busy === e ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </Button>
                </div>
              );
            })
          )}
        </div>

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
        <p className="text-[11px] text-muted-foreground">
          Al dar acceso, la persona entra sin «Ver docs»: verá qué documentos consultó el agente, pero no podrá abrirlos
          hasta que prendas el interruptor.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
