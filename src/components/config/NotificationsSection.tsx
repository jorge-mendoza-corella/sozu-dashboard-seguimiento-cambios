import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageCircle, KeyRound, ShieldCheck, AlertTriangle, Building2, Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useClientScope } from "@/hooks/useClients";
import { ChevronPlegar } from "./Collapsible";
import { useAbiertos } from "@/hooks/useAbiertos";
import { useWhatsappByClient } from "@/hooks/useNotifications";
import { clientDisplayName } from "@/lib/firestoreClients";
import {
  setClientWhatsapp, setWhatsappApiKey, maskApiKey,
  type ClientWhatsappConfig, type ResolvedWhatsapp, type WhatsappConfig,
} from "@/lib/notificationSettings";

// ---------------------------------------------------------------------------
// Notificaciones de WhatsApp, una tarjeta por empresa.
//
// Ya no hay default global, y esa ausencia es deliberada: heredar significaba
// que una empresa sin configurar mandara por el número —y con la llave— de
// otra. Aquí cada empresa trae lo suyo o no recibe nada.
//
// La apikey es write-only: las reglas prohíben leer el `whatsappSecret` del
// cliente desde el navegador, así que aquí solo se puede sobrescribir. Nunca se
// muestra, ni se guarda en un queryKey, ni se repite en un mensaje de error; lo
// único visible es cuándo y quién la guardó.
//
// Todo lo demás guarda al salir del campo (blur) o al picarle al pill: las
// validaciones (webhook https, teléfono E.164, apikey completa) viven en la
// capa de datos y aquí solo se pinta el error que lanzan.
//
// Pertenecer a una empresa y administrarla son cosas distintas: alguien puede
// ver lo de Sozu y mandar solo en Vectis. Las empresas que el usuario ve pero no
// administra SÍ se muestran, con sus valores, pero en solo lectura. No se
// esconden a propósito: ver la configuración de una empresa a la que perteneces
// es legítimo, y esconderla haría creer que está sin configurar —y a alguien
// intentando configurarla dos veces—. Además `firestore.rules` rechazaría
// cualquier escritura desde aquí, así que la interfaz tiene que evitar llegar
// a ese error en vez de provocarlo.
// ---------------------------------------------------------------------------

const fechaLarga = (iso: string) =>
  new Date(iso).toLocaleString("es-MX", { dateStyle: "long", timeStyle: "short" });

/**
 * Los campos de texto que se configuran por empresa.
 *
 * Ya no hay teléfono que capturar: los avisos van a quien disparó el cambio y
 * al aprobador del proyecto, y sus números salen de Contribuidores. Un número
 * suelto aquí se quedaba viejo en cuanto cambiaba el responsable.
 */
const CAMPOS = {
  instance: {
    label: "Instancia de WhatsApp (desde dónde sale)",
    placeholder: "sozu-avisos",
    ayuda: "Nombre de la instancia en n8n: es el número que aparece como remitente.",
  },
  webhookUrl: {
    label: "Webhook de n8n",
    placeholder: "https://n8n.sozu.com/webhook/whatsapp",
    ayuda: "Tiene que ser https://: la apikey viaja en el header.",
  },
} as const;

type CampoTexto = keyof typeof CAMPOS;

/**
 * Qué le falta a una empresa para poder mandar, con los nombres que se ven en
 * pantalla. Es la misma cuenta que hace `incompleta` en la capa de datos, pero
 * detallada: decirle al administrador "le falta algo" lo obliga a adivinar cuál
 * de los tres es.
 *
 * El teléfono administrativo no entra: sin él el aviso igual sale, nada más que
 * únicamente a quien disparó el cambio.
 */
const loQueFalta = (efectiva: ResolvedWhatsapp): string[] => {
  const falta: string[] = [];
  if (!efectiva.instance) falta.push("instancia");
  if (!efectiva.webhookUrl) falta.push("webhook");
  if (!efectiva.apiKeyPropia) falta.push("apikey");
  return falta;
};

export function NotificationsSection() {
  // Arranca todo cerrado: la cabecera de cada empresa ya dice si manda avisos y
  // qué le falta, así que abrir es para editar. Con cuatro empresas abiertas de
  // golpe había que scrollear para encontrar la que se venía a tocar.
  const { abiertos, alternar, abrirTodos, cerrarTodos } = useAbiertos();
  const { appUser } = useAuth();
  const qc = useQueryClient();
  const { visibleClients, editableClientIds } = useClientScope(appUser);
  const { rows, isLoading } = useWhatsappByClient(appUser);

  /** ¿Manda en esta empresa, o solo la ve? `null` = admin global: manda en todas. */
  const puedeEditar = (clientId: string) =>
    editableClientIds === null || editableClientIds.has(clientId);

  /** Explicación del bloqueo, la misma en el badge y en cada control apagado. */
  const MOTIVO_SOLO_LECTURA =
    "Perteneces a esta empresa pero no la administras: puedes ver su configuración, no cambiarla. La administra alguien más.";

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Apikeys en captura, por empresa. Nunca salen de aquí: se limpian en cuanto
  // se intenta guardar.
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});

  // Una sola invalidación para todo: las keys son ["whatsapp","client",id], así
  // que el prefijo las cubre todas.
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

  const setApiKey = (clientId: string, valor: string) =>
    setApiKeys((prev) => ({ ...prev, [clientId]: valor }));

  const guardarApiKey = async (clientId: string) => {
    const valor = apiKeys[clientId] ?? "";
    try {
      await run(`key-${clientId}`, () => setWhatsappApiKey(valor, appUser!.email, clientId), refresh);
    } finally {
      // Se limpia aunque falle: si se queda como `value` del input, el secreto
      // sigue en memoria del navegador el resto de la sesión. Si hubo error, se
      // vuelve a pegar.
      setApiKey(clientId, "");
    }
  };

  const guardarCliente = (key: string, clientId: string, patch: ClientWhatsappConfig) =>
    run(key, () => setClientWhatsapp(clientId, patch, appUser!.email), refresh);

  /** Campo de texto de una empresa. Vacío = de verdad no hay valor: no se hereda. */
  const campoCliente = (clientId: string, campo: CampoTexto, propia: WhatsappConfig | null) => {
    const key = `${campo}-${clientId}`;
    const meta = CAMPOS[campo];
    const actual = propia?.[campo] ?? "";
    // El valor se sigue mostrando: lo que se apaga es poder cambiarlo.
    const soloLectura = !puedeEditar(clientId);
    return (
      <label key={campo} className="block">
        <span className="text-[11px] font-medium text-muted-foreground">{meta.label}</span>
        <div className="mt-1 flex items-center gap-2">
          <input
            // El valor guardado va en la key para que el input no controlado se
            // rearme cuando la capa de datos normaliza lo que se escribió.
            key={`${key}-${actual}`}
            type="text"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="h-9 w-full rounded-md border bg-background px-2 font-mono text-xs"
            placeholder={meta.placeholder}
            title={soloLectura ? MOTIVO_SOLO_LECTURA : meta.ayuda}
            defaultValue={actual}
            disabled={busy === key || soloLectura}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v === actual) return;
              guardarCliente(key, clientId, { [campo]: v });
            }}
          />
          {busy === key && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        <span className="mt-1 block text-[11px] text-muted-foreground">{meta.ayuda}</span>
      </label>
    );
  };

  const rowsPorCliente = new Map(rows.map((r) => [r.clientId, r] as const));

  return (
    <div className="space-y-4">
      {/* --- De qué va esta pantalla -------------------------------------- */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Los avisos de WhatsApp se configuran empresa por empresa: instancia, webhook y apikey propias.
        No hay default global — la empresa que no tenga su configuración completa simplemente no recibe
        avisos, y así ninguna termina mandando por el número ni con la llave de otra.
      </p>

      {isLoading && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> cargando la configuración de notificaciones…
        </p>
      )}

      {/* --- Una card por empresa ------------------------------------------ */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Building2 className="h-4 w-4 text-primary" /> Por empresa ({visibleClients.length})
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Cada empresa manda con lo suyo. Lo que quede vacío no se toma de ningún otro lado.
          </p>
        </div>
        {visibleClients.length > 1 && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline hover:text-foreground"
            onClick={() =>
              abiertos.size === 0 ? abrirTodos(visibleClients.map((c) => c.id)) : cerrarTodos()
            }
          >
            {abiertos.size === 0 ? "desplegar todas" : "contraer todas"}
          </button>
        )}
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
          const falta = loQueFalta(efectiva);
          const faltaTexto = falta.join(", ");
          const keyApiKey = `key-${c.id}`;
          const keyEnabled = `en-${c.id}`;
          const apiKeyEnCaptura = apiKeys[c.id] ?? "";
          // Lo único de la llave que se puede volver a mostrar: la pista que se
          // guardó al escribirla. Sin pista (llaves anteriores a ese campo) el
          // placeholder se queda con el texto de siempre.
          const enmascarada = maskApiKey(propia);
          // El pill solo se puede PRENDER con la configuración completa: dejar
          // prender avisos que la capa de datos va a saltarse igual sería
          // prometer algo que no pasa. Apagar nunca se bloquea — el camino de
          // desactivar tiene que estar siempre abierto, incluso a medio llenar.
          const pillBloqueado = !efectiva.enabled && efectiva.incompleta;
          // Empresa que ve pero no administra: la tarjeta se pinta completa y
          // todo lo que escribe queda apagado.
          const soloLectura = !puedeEditar(c.id);

          const abierta = abiertos.has(c.id);

          return (
            <Card key={c.id}>
              <CardContent className="p-4">
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-2 text-left"
                  title={abierta ? `Contraer ${clientDisplayName(c)}` : `Desplegar ${clientDisplayName(c)}`}
                  onClick={() => alternar(c.id)}
                >
                  <ChevronPlegar abierto={abierta} />
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                  <span className="text-sm font-semibold">{clientDisplayName(c)}</span>
                  {soloLectura && (
                    <Badge variant="outline" className="gap-1" title={MOTIVO_SOLO_LECTURA}>
                      <Lock className="h-3 w-3" /> Solo lectura
                    </Badge>
                  )}
                  {efectiva.incompleta ? (
                    <Badge variant="destructive" className="gap-1">
                      <AlertTriangle className="h-3 w-3" /> Le falta: {faltaTexto}
                    </Badge>
                  ) : efectiva.puedeEnviar ? (
                    <Badge variant="success">Avisos activos</Badge>
                  ) : (
                    <Badge variant="warning">Apagada</Badge>
                  )}
                </button>

                {abierta && (
                  <>
                {efectiva.incompleta && (
                  <p className="mt-2 text-xs text-destructive">
                    Le falta: {faltaTexto}. Mientras siga así, a esta empresa no se le manda ningún
                    aviso: los workflows la van a saltar y lo van a dejar dicho en el log.
                  </p>
                )}

                {/* Instancia → webhook → apikey → teléfono: el orden en el que se
                    llenan, con el secreto pegado al webhook al que viaja. */}
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {campoCliente(c.id, "instance", propia)}
                  {campoCliente(c.id, "webhookUrl", propia)}

                  <label className="block">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      Apikey del webhook n8n
                    </span>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="password"
                        spellCheck={false}
                        autoCapitalize="none"
                        autoCorrect="off"
                        autoComplete="off"
                        className="h-9 w-full rounded-md border bg-background px-2 font-mono text-xs"
                        // Con una guardada, el placeholder muestra sus primeros
                        // caracteres y el resto en asteriscos: alcanza para
                        // reconocer cuál está puesta sin poder reconstruirla.
                        placeholder={enmascarada ?? "apikey del webhook de n8n"}
                        title={
                          soloLectura
                            ? MOTIVO_SOLO_LECTURA
                            : enmascarada
                              ? `Guardada: ${enmascarada}. Escribe una nueva para reemplazarla; la actual no se puede leer de vuelta.`
                              : "Se escribe y ya: las reglas prohíben leerla desde el navegador, así que no se puede mostrar de vuelta."
                        }
                        value={apiKeyEnCaptura}
                        disabled={busy === keyApiKey || soloLectura}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && apiKeyEnCaptura.trim()) guardarApiKey(c.id);
                        }}
                        onChange={(e) => setApiKey(c.id, e.target.value)}
                      />
                      {busy === keyApiKey && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    </div>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      Viaja en el header del webhook. Se guarda con el botón del final de la tarjeta y
                      nunca se muestra de vuelta: solo se sobrescribe.
                    </span>
                  </label>
                </div>

                {/* Interruptor de la empresa */}
                <div className="mt-3">
                  <button
                    type="button"
                    disabled={busy === keyEnabled || pillBloqueado || soloLectura}
                    title={
                      soloLectura
                        ? MOTIVO_SOLO_LECTURA
                        : efectiva.enabled
                          ? "Recibe avisos — click para apagárselos"
                          : pillBloqueado
                            ? `No se puede prender: le falta ${faltaTexto}.`
                            : "No recibe avisos — click para prendérselos"
                    }
                    onClick={() => guardarCliente(keyEnabled, c.id, { enabled: !efectiva.enabled })}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50",
                      efectiva.enabled
                        ? "border-emerald-400 bg-emerald-100 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {busy === keyEnabled ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageCircle className="h-3 w-3" />}
                    Recibe avisos de WhatsApp
                  </button>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {pillBloqueado
                      ? `Se puede prender cuando la configuración esté completa: le falta ${faltaTexto}.`
                      : "Apagado = esta empresa no recibe ningún aviso, aunque tenga instancia, webhook y apikey bien puestos."}
                  </p>
                </div>

                {/* Guardado de la apikey, al final de la tarjeta: el input está
                    arriba junto al webhook, pero la acción y su estado viven acá. */}
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!apiKeyEnCaptura.trim() || busy === keyApiKey || soloLectura}
                    title={
                      soloLectura
                        ? MOTIVO_SOLO_LECTURA
                        : "Guarda la apikey capturada arriba en el doc privado de esta empresa."
                    }
                    onClick={() => guardarApiKey(c.id)}
                  >
                    {busy === keyApiKey ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    Guardar apikey
                  </Button>
                  {propia?.apiKeySetAt ? (
                    <Badge variant="success" className="gap-1">
                      <KeyRound className="h-3 w-3" />
                      Apikey guardada el {fechaLarga(propia.apiKeySetAt)}
                      {propia.apiKeySetBy ? ` por ${propia.apiKeySetBy}` : ""}
                    </Badge>
                  ) : (
                    <Badge variant="warning" className="gap-1">
                      <KeyRound className="h-3 w-3" /> Sin apikey
                    </Badge>
                  )}
                </div>

                {propia?.updatedAt && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Última modificación el {fechaLarga(propia.updatedAt)}
                    {propia.updatedBy ? ` por ${propia.updatedBy}` : ""}.
                  </p>
                )}
                  </>
                )}
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
