import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageCircle, KeyRound, ShieldCheck, AlertTriangle, Building2, RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import { useClientScope } from "@/hooks/useClients";
import { useWhatsappByClient } from "@/hooks/useNotifications";
import { clientDisplayName } from "@/lib/firestoreClients";
import {
  setGlobalWhatsapp, setClientWhatsapp, setWhatsappApiKey, clearClientWhatsappApiKey,
  type ClientWhatsappConfig, type ResolvedWhatsapp, type WhatsappConfig,
} from "@/lib/notificationSettings";

// ---------------------------------------------------------------------------
// Notificaciones de WhatsApp por empresa.
//
// Hoy los workflows de CI mandan TODOS los avisos por una sola instancia de n8n
// con una sola apikey, escritas a mano en el YAML: todas las empresas comparten
// el mismo número. Esta pantalla es lo que lo vuelve configuración por empresa.
//
// Arriba el default global (solo para el admin global) y abajo una card por
// empresa, con los mismos campos pero heredables: lo que la empresa deja vacío
// se toma del global. Junto a cada campo se muestra el valor que se usaría de
// verdad (`row.efectiva`), que es lo único que le importa al workflow.
//
// La apikey es write-only: las reglas prohíben leer `secrets/` y el
// `whatsappSecret` del cliente desde el navegador, así que aquí solo se puede
// sobrescribir. Nunca se muestra, ni se guarda en un queryKey, ni se repite en
// un mensaje de error; lo único visible es cuándo y quién la guardó.
//
// Todo lo demás guarda al salir del campo (blur) o al picarle al pill: las
// validaciones (webhook https, teléfono E.164, apikey completa) viven en la
// capa de datos y aquí solo se pinta el error que lanzan.
// ---------------------------------------------------------------------------

const fechaLarga = (iso: string) =>
  new Date(iso).toLocaleString("es-MX", { dateStyle: "long", timeStyle: "short" });

/**
 * Texto chiquito debajo de un campo heredable: qué valor se usaría realmente y
 * de dónde salió. `vacio` es lo que se dice cuando no hay valor en ningún lado.
 */
const pistaEfectiva = (valor: string, heredado: boolean, vacio: string) => {
  if (!valor) return vacio;
  return heredado ? `heredado del global: ${valor}` : `propio: ${valor}`;
};

/** Placeholder de un campo de empresa: el default global, o un aviso si no hay. */
const placeholderGlobal = (valor: string) =>
  valor ? `${valor} (del global)` : "sin default global";

/** Los cuatro campos que se pueden configurar, con su etiqueta y su ayuda. */
const CAMPOS = {
  instance: {
    label: "Instancia de WhatsApp",
    placeholder: "sozu-avisos",
    ayuda: "Nombre de la instancia en n8n (el `instanciaWA` del payload).",
  },
  webhookUrl: {
    label: "Webhook de n8n",
    placeholder: "https://n8n.sozu.com/webhook/whatsapp",
    ayuda: "Tiene que ser https://: la apikey viaja en el header.",
  },
  adminPhone: {
    label: "Teléfono administrativo",
    placeholder: "+5217221514185",
    ayuda: "Formato internacional con lada: +5217221514185.",
  },
} as const;

type CampoTexto = keyof typeof CAMPOS;

export function NotificationsSection() {
  const { appUser } = useAuth();
  const qc = useQueryClient();
  const { visibleClients } = useClientScope(appUser);
  // El default global vive en `settings/notifications` y `secrets/whatsapp`, y
  // esas escrituras las reglas se las reservan al root: mostrárselo a otro
  // administrador solo le daría un permission-denied al guardar.
  const esAdminGlobal = appUser?.email === SUPERUSER_EMAIL;
  const { global, rows, isLoading } = useWhatsappByClient(appUser);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Apikeys en captura, por destino ("global" o el id de la empresa). Nunca
  // salen de aquí: se limpian en cuanto se intenta guardar.
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});

  // Una sola invalidación para todo: las keys son ["whatsapp","global"] y
  // ["whatsapp","client",id], así que el prefijo las cubre a las dos.
  const refresh = () => qc.invalidateQueries({ queryKey: ["whatsapp"] });

  const run = async (key: string, fn: () => Promise<unknown>, after: () => Promise<unknown> | void) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await after();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(null);
    }
  };

  const setApiKey = (destino: string, valor: string) =>
    setApiKeys((prev) => ({ ...prev, [destino]: valor }));

  /** Guarda la apikey del global (`clientId` undefined) o la de una empresa. */
  const guardarApiKey = async (destino: string, clientId?: string) => {
    const valor = apiKeys[destino] ?? "";
    try {
      await run(`key-${destino}`, () => setWhatsappApiKey(valor, appUser!.email, clientId), refresh);
    } finally {
      // Se limpia aunque falle: si se queda como `value` del input, el secreto
      // sigue en memoria del navegador el resto de la sesión. Si hubo error, se
      // vuelve a pegar.
      setApiKey(destino, "");
    }
  };

  const guardarGlobal = (key: string, patch: ClientWhatsappConfig) =>
    run(key, () => setGlobalWhatsapp(patch, appUser!.email), refresh);

  const guardarCliente = (key: string, clientId: string, patch: ClientWhatsappConfig) =>
    run(key, () => setClientWhatsapp(clientId, patch, appUser!.email), refresh);

  /** Badge de estado de una apikey (nunca su valor: no se puede leer). */
  const badgeApiKey = (cfg: WhatsappConfig | null, textoSinApiKey: string) =>
    !cfg?.apiKeySetAt ? (
      <Badge variant="warning">{textoSinApiKey}</Badge>
    ) : (
      <>
        <Badge variant="success">Apikey guardada</Badge>
        <span className="text-[11px] text-muted-foreground">
          el {fechaLarga(cfg.apiKeySetAt)}
          {cfg.apiKeySetBy ? ` por ${cfg.apiKeySetBy}` : ""}
        </span>
      </>
    );

  /** Input de apikey + botón de guardar. Comparte forma entre global y empresa. */
  const capturaApiKey = (destino: string, clientId?: string) => {
    const key = `key-${destino}`;
    const valor = apiKeys[destino] ?? "";
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs"
          placeholder="apikey del webhook de n8n"
          title="Se escribe y ya: las reglas prohíben leerla desde el navegador, así que no se puede mostrar de vuelta."
          value={valor}
          disabled={busy === key}
          onKeyDown={(e) => { if (e.key === "Enter" && valor.trim()) guardarApiKey(destino, clientId); }}
          onChange={(e) => setApiKey(destino, e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!valor.trim() || busy === key}
          onClick={() => guardarApiKey(destino, clientId)}
        >
          {busy === key ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Guardar
        </Button>
      </div>
    );
  };

  /** Campo de texto del default global. Vacío arriba = de verdad no hay valor. */
  const campoGlobal = (campo: CampoTexto) => {
    const key = `g-${campo}`;
    const meta = CAMPOS[campo];
    return (
      <label key={campo} className="block">
        <span className="text-[11px] font-medium text-muted-foreground">{meta.label}</span>
        <div className="mt-1 flex items-center gap-2">
          <input
            key={`${key}-${global[campo]}`}
            type="text"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="h-9 w-full rounded-md border bg-background px-2 font-mono text-xs"
            placeholder={meta.placeholder}
            title={meta.ayuda}
            defaultValue={global[campo]}
            disabled={busy === key}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v === global[campo]) return;
              guardarGlobal(key, { [campo]: v });
            }}
          />
          {busy === key && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        <span className="mt-1 block text-[11px] text-muted-foreground">{meta.ayuda}</span>
      </label>
    );
  };

  /** Campo de texto de una empresa: vacío = hereda el global. */
  const campoCliente = (clientId: string, campo: CampoTexto, propia: WhatsappConfig | null, efectiva: ResolvedWhatsapp) => {
    const key = `${campo}-${clientId}`;
    const meta = CAMPOS[campo];
    const actual = propia?.[campo] ?? "";
    const vacio =
      campo === "adminPhone"
        ? "sin definir — no se mandan avisos administrativos"
        : "sin definir — a esta empresa no se le puede notificar";
    return (
      <label key={campo} className="block">
        <span className="text-[11px] font-medium text-muted-foreground">{meta.label}</span>
        <div className="mt-1 flex items-center gap-2">
          <input
            key={`${key}-${actual || "hereda"}`}
            type="text"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="h-9 w-full rounded-md border bg-background px-2 font-mono text-xs"
            placeholder={placeholderGlobal(global[campo])}
            title={`${meta.ayuda} Vacío = usa el default global.`}
            defaultValue={actual}
            disabled={busy === key}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v === actual) return;
              guardarCliente(key, clientId, { [campo]: v });
            }}
          />
          {busy === key && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        <span
          className={cn(
            "mt-1 block text-[11px]",
            efectiva[campo] ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400",
          )}
        >
          {pistaEfectiva(efectiva[campo], efectiva.heredado[campo], vacio)}
        </span>
      </label>
    );
  };

  const rowsPorCliente = new Map(rows.map((r) => [r.clientId, r] as const));

  return (
    <div className="space-y-4">
      {/* --- De qué va esta pantalla -------------------------------------- */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Hoy los workflows de CI mandan todos los avisos por una sola instancia de n8n con una sola
        apikey, escritas a mano en el YAML: todas las empresas comparten el mismo número de WhatsApp.
        Aquí se vuelve configuración por empresa — cada una con su instancia, su webhook y su apikey —,
        y lo que se deje vacío sigue heredando el default global.
      </p>

      {isLoading && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> cargando la configuración de notificaciones…
        </p>
      )}

      {/* --- Default global (solo el admin global) ------------------------- */}
      {esAdminGlobal && (
        <Card>
          <CardContent className="p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <MessageCircle className="h-4 w-4 text-primary" /> Default global
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Lo que se usa para toda empresa que no tenga configuración propia. Cambiarlo aquí le
              cambia el número a todas las que estén heredando.
            </p>

            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(Object.keys(CAMPOS) as CampoTexto[]).map((campo) => campoGlobal(campo))}
            </div>

            {/* Interruptor general */}
            <div className="mt-3">
              <button
                type="button"
                disabled={busy === "g-enabled"}
                title={
                  global.enabled
                    ? "Se están mandando avisos — click para apagar TODAS las notificaciones"
                    : "No se manda ningún aviso a nadie — click para prenderlas"
                }
                onClick={() => guardarGlobal("g-enabled", { enabled: !global.enabled })}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50",
                  global.enabled
                    ? "border-emerald-400 bg-emerald-100 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {busy === "g-enabled" ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageCircle className="h-3 w-3" />}
                Notificaciones de WhatsApp prendidas
              </button>
              {!global.enabled && (
                <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                  Apagado: ninguna empresa recibe avisos, aunque tenga su propia configuración.
                </p>
              )}
            </div>

            {/* Apikey default */}
            <div className="mt-4 border-t pt-3">
              <h4 className="flex items-center gap-2 text-xs font-semibold">
                <KeyRound className="h-3.5 w-3.5 text-primary" /> Apikey del webhook (default)
              </h4>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Se guarda en <code className="rounded bg-muted px-1 font-mono">secrets/whatsapp</code>, que
                las reglas marcan como <code className="rounded bg-muted px-1 font-mono">allow read: if false</code>.
                Eso impide leerla desde el navegador — aquí solo se puede sobrescribir, nunca se muestra
                de vuelta —, pero no la cifra: quien tenga acceso a la consola de Firebase o a una cuenta
                de servicio sí puede leerla. Quien la consume son los workflows, que entran con cuenta de
                servicio y se saltan las reglas.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {badgeApiKey(global, "Sin configurar")}
              </div>
              <div className="mt-2">{capturaApiKey("global")}</div>
            </div>

            {global.updatedAt && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                Última modificación el {fechaLarga(global.updatedAt)}
                {global.updatedBy ? ` por ${global.updatedBy}` : ""}.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* --- Una card por empresa ------------------------------------------ */}
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Building2 className="h-4 w-4 text-primary" /> Por empresa ({visibleClients.length})
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Deja un campo vacío para que la empresa siga usando el default global.
        </p>
      </div>

      {!isLoading && visibleClients.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No hay empresas que puedas configurar.
        </p>
      )}

      <div className="space-y-3">
        {visibleClients.map((c) => {
          const row = rowsPorCliente.get(c.id);
          if (!row) return null;
          const { propia, efectiva } = row;
          const encendidaPropia = propia?.enabled !== false;

          return (
            <Card key={c.id}>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                  <span className="text-sm font-semibold">{clientDisplayName(c)}</span>
                  {efectiva.incompleta && (
                    <Badge variant="destructive" className="gap-1">
                      <AlertTriangle className="h-3 w-3" /> No se le va a notificar nada
                    </Badge>
                  )}
                  {!efectiva.incompleta && !efectiva.enabled && (
                    <Badge variant="warning">Avisos apagados</Badge>
                  )}
                  <Badge variant={efectiva.apiKeyPropia ? "success" : "secondary"}>
                    {efectiva.apiKeyPropia ? "Apikey propia" : "Usa la apikey global"}
                  </Badge>
                </div>

                {efectiva.webhookSinLlave ? (
                  <p className="mt-2 text-xs text-destructive">
                    Tiene webhook propio pero no apikey propia. No se le manda nada a propósito:
                    la apikey global no viaja a un webhook capturado por la empresa, porque quien
                    controle esa URL se quedaría con la llave de todas las demás. Captúrale su
                    apikey, o deja el webhook vacío para heredar el global completo.
                  </p>
                ) : efectiva.incompleta ? (
                  <p className="mt-2 text-xs text-destructive">
                    Le falta instancia, webhook o apikey (propia o global), así que a esta empresa no se
                    le manda ningún aviso: los workflows la van a saltar en silencio.
                  </p>
                ) : null}

                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {(Object.keys(CAMPOS) as CampoTexto[]).map((campo) =>
                    campoCliente(c.id, campo, propia, efectiva),
                  )}
                </div>

                {/* Interruptor de la empresa */}
                <div className="mt-3">
                  <button
                    type="button"
                    disabled={busy === `en-${c.id}`}
                    title={
                      encendidaPropia
                        ? "Recibe avisos — click para apagárselos"
                        : "No recibe avisos — click para prendérselos"
                    }
                    onClick={() =>
                      guardarCliente(`en-${c.id}`, c.id, { enabled: !encendidaPropia })
                    }
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50",
                      encendidaPropia
                        ? "border-emerald-400 bg-emerald-100 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {busy === `en-${c.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageCircle className="h-3 w-3" />}
                    Recibe avisos de WhatsApp
                  </button>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Apagado = esta empresa no recibe ningún aviso, aunque tenga instancia, webhook y
                    apikey bien puestos.
                    {encendidaPropia && !efectiva.enabled
                      ? " Ahorita está apagada de todos modos porque el default global está apagado."
                      : ""}
                  </p>
                </div>

                {/* Apikey propia */}
                <div className="mt-4 border-t pt-3">
                  <h4 className="flex items-center gap-2 text-xs font-semibold">
                    <KeyRound className="h-3.5 w-3.5 text-primary" /> Apikey propia
                  </h4>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    Se guarda en el doc privado de la empresa y tampoco se puede leer desde el navegador:
                    solo se sobrescribe. Sin apikey propia se usa la global.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {badgeApiKey(propia, "Sin apikey propia — usa la global")}
                    {efectiva.apiKeyPropia && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === `clr-${c.id}`}
                        title="Borra la apikey propia para que esta empresa vuelva a mandar con la global."
                        onClick={() => {
                          const ok = window.confirm(
                            `¿Quitar la apikey propia de ${clientDisplayName(c)}? A partir de ese momento sus avisos se mandan con la apikey global.`,
                          );
                          if (!ok) return;
                          run(`clr-${c.id}`, () => clearClientWhatsappApiKey(c.id, appUser!.email), refresh);
                        }}
                      >
                        {busy === `clr-${c.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                        Usar la global
                      </Button>
                    )}
                  </div>
                  <div className="mt-2">{capturaApiKey(c.id, c.id)}</div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* --- Lo que NO se configura aquí ----------------------------------- */}
      <p className="border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">
        Los teléfonos de los contribuidores no se configuran aquí: siguen en la pestaña{" "}
        <span className="font-medium text-foreground underline decoration-dotted">Contribuidores</span>,
        campo <code className="rounded bg-muted px-1 font-mono">contributors/{"{login}"}.telefonoWhatsapp</code>.
        El teléfono de esta pantalla es únicamente el que recibe los avisos administrativos de los PRs
        (abierto, cerrado), no el de cada persona del equipo.
      </p>
    </div>
  );
}
