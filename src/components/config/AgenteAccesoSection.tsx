import { useEffect, useState } from "react";
import { BellRing, Bot, FileText, Palette, Send, Loader2, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getUserByEmail, setUserAgenteVolador, SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import { useAuth } from "@/hooks/useAuth";
import { ConfirmarApagarAgentito } from "@/components/agente/ConfirmarApagarAgentito";
import { SelectorSkin } from "./SelectorSkin";
import { Personaje } from "@/components/agente/AgenteVolador";
import { useNombresAvatar, useSkinGeneral, type Skin } from "@/components/agente/skinsDatos";
import { cambiarAgente, cambiarClaude, cambiarTickets, cambiarVerDocs, darAccesoAgente, leerAccesoAgente, leerSkinsPorPersona, quitarAccesoAgente, type AccesoAgente } from "@/lib/agenteRepos";

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

/**
 * Columna Avatar: el interruptor de mostrar al avatar volando en su pantalla
 * y la miniatura del que ve (el suyo o, si no eligió, el general). Sin
 * GeorgIA no hay avatar: el interruptor queda apagado y bloqueado.
 */
function AvatarDe({ skin, children, apagado }: { skin: Skin | undefined; children: React.ReactNode; apagado?: boolean }) {
  const general = useSkinGeneral();
  const s = skin ?? general;
  const nombre = useNombresAvatar()(s);
  const etiqueta = skin ? nombre : `General (${nombre})`;
  return (
    <span className={cn("flex w-44 items-center gap-1.5", apagado && "opacity-40")} title={etiqueta}>
      <span className="flex w-10 justify-center">{children}</span>
      <span className="h-8 w-8 shrink-0"><Personaje pose="quieto" animo="feliz" skin={s} /></span>
      <span className={cn("truncate text-[10px]", !skin && "text-muted-foreground")}>{skin ? nombre : "General"}</span>
    </span>
  );
}

export function AgenteAccesoSection() {
  const [acceso, setAcceso] = useState<AccesoAgente | null>(null);
  const [nuevo, setNuevo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // El personaje es preferencia propia: se guarda en el perfil de quien lo cambia.
  const { realUser } = useAuth();
  const [agentitoVisible, setAgentitoVisible] = useState<boolean | null>(null);
  const agentito = agentitoVisible ?? realUser?.agenteVolador !== false;
  const [confirmando, setConfirmando] = useState(false);
  const cambiarAgentito = (visible: boolean) =>
    void run("agentito", async () => {
      await setUserAgenteVolador(SUPERUSER_EMAIL, visible);
      setAgentitoVisible(visible);
    });

  const recargar = () => leerAccesoAgente().then(setAcceso).catch(() => setAcceso({ emails: [], sinAgente: [], docs: [], tickets: [], claude: [], megafono: [], voz: [], ticketsApagados: [] }));
  useEffect(() => { void recargar(); }, []);
  // Lo elige cada quien en su panel: aquí solo se muestra.
  const [skins, setSkins] = useState<Record<string, Skin>>({});
  useEffect(() => { leerSkinsPorPersona().then(setSkins).catch(() => setSkins({})); }, []);
  // GeorgIA volando, por persona (users/{email}.agenteVolador; el root puede
  // escribir la ficha de los demás). null = sin ficha de usuario: no se toca.
  const [voladores, setVoladores] = useState<Record<string, boolean | null>>({});
  // Filas: con GeorgIA y con GeorgIA apagada.
  const personas = acceso ? [...new Set([...acceso.emails, ...acceso.sinAgente])].filter((e) => e !== SUPERUSER_EMAIL).sort() : [];
  const emailsAcceso = personas.join(",");
  useEffect(() => {
    const otros = emailsAcceso.split(",").filter((e) => e && e !== SUPERUSER_EMAIL);
    if (!otros.length) return;
    let vivo = true;
    void Promise.all(otros.map(async (e) => {
      const u = await getUserByEmail(e).catch(() => null);
      return [e, u ? u.agenteVolador !== false : null] as const;
    })).then((pares) => vivo && setVoladores(Object.fromEntries(pares)));
    return () => { vivo = false; };
  }, [emailsAcceso]);

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
            <h2 className="font-semibold">GeorgIA</h2>
            <p className="text-sm text-muted-foreground">
              Quién puede usar a GeorgIA, el agente de repos (chat con Alt+K o con clic en su avatar), y quién puede además abrir la documentación que cita.
              «Avatar» solo muestra u oculta al personaje que vuela por la pantalla: oculto, GeorgIA sigue en Alt+K. Sin GeorgIA no hay avatar.
              Responde con sozu-docs y el código de los repos que cada persona ya tiene asignados. Tope: 40 preguntas por
              hora por persona.
            </p>
          </div>
        </div>

        <SelectorSkin />

        <div className="overflow-hidden rounded-md border text-sm">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="flex-1">Persona</span>
            <span className="flex w-28 items-center justify-center gap-1"><FileText className="h-3 w-3" /> Ver docs</span>
            <span className="flex w-28 items-center justify-center gap-1"><BellRing className="h-3 w-3" /> Tickets</span>
            <span className="flex w-28 items-center justify-center gap-1" title="Mandar tickets a Claude Code"><Send className="h-3 w-3" /> Claude</span>
            <span className="flex w-28 items-center justify-center gap-1"><Bot className="h-3 w-3" /> GeorgIA</span>
            <span className="flex w-44 items-center gap-1 pl-1"><Palette className="h-3 w-3" /> Avatar</span>
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
                  activo={!acceso?.ticketsApagados.includes(SUPERUSER_EMAIL)}
                  deshabilitado={busy !== null || acceso === null}
                  onCambiar={() => {
                    const prendido = !acceso?.ticketsApagados.includes(SUPERUSER_EMAIL);
                    void run(`tickets:${SUPERUSER_EMAIL}`, () => cambiarTickets(SUPERUSER_EMAIL, !prendido));
                  }}
                  etiqueta="Revisar mis tickets cada 15 min"
                />
              )}
            </span>
            <span className="flex w-28 justify-center"><Interruptor activo deshabilitado etiqueta="Root: siempre puede mandar a Claude" /></span>
            <span className="flex w-28 justify-center"><Interruptor activo deshabilitado etiqueta="Root: siempre usa GeorgIA" /></span>
            <AvatarDe skin={skins[SUPERUSER_EMAIL]}>
              {busy === "agentito" ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <Interruptor
                  activo={agentito}
                  deshabilitado={busy !== null}
                  // Apagarlo pide confirmación (y él ruega); prenderlo es directo.
                  onCambiar={() => (agentito ? setConfirmando(true) : cambiarAgentito(true))}
                  etiqueta={agentito ? "Esconder mi avatar (GeorgIA sigue en Alt+K)" : "Volver a mostrar mi avatar"}
                />
              )}
            </AvatarDe>
            <Badge variant="secondary" className="w-9 justify-center px-0">Root</Badge>
          </div>
          {acceso === null ? (
            <div className="flex justify-center px-3 py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : (
            personas.map((e) => {
              const conAgente = acceso.emails.includes(e);
              const verDocs = acceso.docs.includes(e);
              const revisaTickets = acceso.tickets.includes(e);
              const mandaClaude = acceso.claude.includes(e);
              return (
                <div key={e} className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
                  <span className="flex-1 truncate">{e}</span>
                  <span className="flex w-28 justify-center">
                    {busy === `docs:${e}` ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Interruptor
                        activo={verDocs && conAgente}
                        deshabilitado={busy !== null || !conAgente}
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
                        activo={revisaTickets && conAgente}
                        deshabilitado={busy !== null || !conAgente}
                        onCambiar={() => void run(`tickets:${e}`, () => cambiarTickets(e, !revisaTickets))}
                        etiqueta={revisaTickets ? "Dejar de revisar sus tickets" : "Revisar sus tickets cada 15 min"}
                      />
                    )}
                  </span>
                  <span className="flex w-28 justify-center">
                    {busy === `claude:${e}` ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Interruptor
                        activo={mandaClaude && revisaTickets && conAgente}
                        // Mandar a Claude sale de la pestaña Tickets: sin ella no hay desde dónde.
                        deshabilitado={busy !== null || !conAgente || !revisaTickets}
                        onCambiar={() => void run(`claude:${e}`, () => cambiarClaude(e, !mandaClaude))}
                        etiqueta={!revisaTickets ? "Primero prende Tickets" : mandaClaude ? "Quitar permiso de mandar tickets a Claude" : "Dejarle mandar sus tickets a Claude"}
                      />
                    )}
                  </span>
                  <span className="flex w-28 justify-center">
                    {busy === `agente:${e}` ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Interruptor
                        activo={conAgente}
                        deshabilitado={busy !== null}
                        onCambiar={() => void run(`agente:${e}`, () => cambiarAgente(e, !conAgente))}
                        etiqueta={conAgente ? "Quitarle GeorgIA (sigue en la lista)" : "Darle GeorgIA"}
                      />
                    )}
                  </span>
                  <AvatarDe skin={skins[e]} apagado={!conAgente}>
                    {busy === `volador:${e}` ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : voladores[e] === undefined ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/40" />
                    ) : voladores[e] === null ? (
                      <span className="text-[10px] text-muted-foreground" title="No tiene ficha en Usuarios">—</span>
                    ) : (
                      <Interruptor
                        activo={!!voladores[e] && conAgente}
                        deshabilitado={busy !== null || !conAgente}
                        onCambiar={() => void run(`volador:${e}`, async () => {
                          await setUserAgenteVolador(e, !voladores[e]);
                          setVoladores((v) => ({ ...v, [e]: !v[e] }));
                        })}
                        etiqueta={voladores[e] ? "Esconder su avatar (GeorgIA sigue en Alt+K)" : "Mostrar su avatar"}
                      />
                    )}
                  </AvatarDe>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-9 px-0"
                    disabled={busy !== null}
                    onClick={() => void run(e, () => quitarAccesoAgente(e))}
                    title="Quitar de la lista"
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
          Al dar acceso, la persona entra sin «Ver docs»: verá qué documentos consultó GeorgIA, pero no podrá abrirlos
          hasta que prendas el interruptor.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {confirmando && <ConfirmarApagarAgentito
          abierto={confirmando}
          onCancelar={() => setConfirmando(false)}
          onConfirmar={() => { setConfirmando(false); cambiarAgentito(false); }}
        />}
      </CardContent>
    </Card>
  );
}
