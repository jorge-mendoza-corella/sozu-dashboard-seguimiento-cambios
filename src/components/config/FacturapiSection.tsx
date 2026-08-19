import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, KeyRound, ExternalLink, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { useBillingSettings } from "@/hooks/useClients";
import { SUPERUSER_EMAIL } from "@/lib/firestoreUsers";
import {
  setFacturapiKey, setBillingSettings, DEFAULT_BILLING_SETTINGS, type FacturapiEnv,
} from "@/lib/billingSettings";

// ---------------------------------------------------------------------------
// Facturación (Facturapi). Esta pantalla solo deja la llave configurada: la
// emisión de CFDI llega en la fase 2.
//
// La API key es un secreto write-only, igual que las credenciales de tienda:
// se escribe en `secrets/facturapi`, colección cuyas reglas prohíben leer desde
// el navegador. Lo único que se puede mostrar aquí son los metadatos que viven
// en `settings/billing`: entorno detectado, cuándo se guardó y quién lo hizo.
// ---------------------------------------------------------------------------

/** Cómo se nombra cada entorno en la UI (el prefijo lo pone Facturapi). */
const ENV_LABEL: Record<FacturapiEnv, string> = {
  test: "pruebas (sk_test_…)",
  live: "producción (sk_live_…)",
};

const fechaLarga = (iso: string) =>
  new Date(iso).toLocaleString("es-MX", { dateStyle: "long", timeStyle: "short" });

export function FacturapiSection() {
  const { appUser } = useAuth();
  const qc = useQueryClient();
  const { data: settings = DEFAULT_BILLING_SETTINGS } = useBillingSettings();

  // Solo el root escribe: la llave puede timbrar facturas reales en producción.
  const esRoot = appUser?.email === SUPERUSER_EMAIL;

  const [apiKey, setApiKey] = useState("");
  const [envDetectado, setEnvDetectado] = useState<FacturapiEnv | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refreshSettings = () => qc.invalidateQueries({ queryKey: ["billing-settings"] });

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

  const guardarKey = async () => {
    try {
      await run(
        "key",
        async () => {
          // El entorno lo deduce del prefijo la propia capa de datos.
          const env = await setFacturapiKey(apiKey, appUser!.email);
          setEnvDetectado(env);
        },
        refreshSettings,
      );
    } finally {
      // La llave se limpia aunque el guardado falle: si se queda como `value`
      // del input, el secreto sigue en memoria del navegador el resto de la
      // sesión. Si hubo error, se vuelve a pegar.
      setApiKey("");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="h-4 w-4 text-primary" /> API key de Facturapi
          </h3>

          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            La Secret Key se guarda en texto plano en la colección{" "}
            <code className="rounded bg-muted px-1 font-mono">secrets/facturapi</code>, que las reglas
            marcan como <code className="rounded bg-muted px-1 font-mono">allow read: if false</code>. Eso
            impide leerla desde el navegador — aquí solo se puede sobrescribir, nunca se muestra de
            vuelta —, pero no la cifra: quien tenga acceso al proyecto de Firebase (consola) o a una
            cuenta de servicio sí puede leerla. Por eso en la fase 2 debería moverse a Secret Manager.
            Esa fase es también la que emitirá los CFDI; esta pantalla únicamente deja la llave
            configurada para que el backend pueda timbrar después.
          </p>

          {/* Estado actual (metadatos, no la llave) */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {settings.facturapiKeySetAt === null ? (
              <Badge variant="warning">Sin configurar</Badge>
            ) : (
              <>
                <Badge variant="success">Entorno: {ENV_LABEL[settings.facturapiEnv]}</Badge>
                <span className="text-[11px] text-muted-foreground">
                  Guardada el {fechaLarga(settings.facturapiKeySetAt)}
                  {settings.facturapiKeySetBy ? ` por ${settings.facturapiKeySetBy}` : ""}
                </span>
              </>
            )}
          </div>

          {/* Captura de la llave */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="password"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs"
              placeholder="sk_test_… o sk_live_…"
              title="Secret Key completa de Facturapi: sk_test_ o sk_live_ seguido de 24 a 64 caracteres. Una llave cortada al copiar se rechaza."
              value={apiKey}
              disabled={!esRoot || busy === "key"}
              onKeyDown={(e) => { if (e.key === "Enter" && apiKey.trim()) guardarKey(); }}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <Button size="sm" variant="outline" disabled={!esRoot || !apiKey.trim() || busy === "key"} onClick={guardarKey}>
              {busy === "key" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Guardar
            </Button>
          </div>

          {envDetectado && (
            <p className="mt-2 text-sm text-green-700 dark:text-green-400">
              Llave guardada. Entorno detectado: {ENV_LABEL[envDetectado]}
            </p>
          )}

          {/* Serie de los CFDI */}
          <label className="mt-4 block max-w-xs">
            <span className="text-[11px] font-medium text-muted-foreground">Serie de los CFDI</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                key={`serie-${settings.facturapiSeries ?? "none"}`}
                type="text"
                spellCheck={false}
                autoCapitalize="characters"
                autoCorrect="off"
                className="h-9 w-full rounded-md border bg-background px-2 font-mono text-sm uppercase"
                placeholder="A"
                defaultValue={settings.facturapiSeries ?? ""}
                disabled={!esRoot || busy === "serie"}
                title="Prefijo de folio con el que se emitirán las facturas. Se guarda en mayúsculas."
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                onBlur={(e) => {
                  const serie = e.target.value.trim().toUpperCase();
                  if (serie === (settings.facturapiSeries ?? "")) return;
                  run("serie", () => setBillingSettings({ facturapiSeries: serie }, appUser!.email), refreshSettings);
                }}
              />
              {busy === "serie" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
          </label>

          {/* El IVA global se configura en precios: aquí solo se informa para no
              tener dos campos que escriban el mismo `taxRatePct`. */}
          <p className="mt-3 text-xs text-muted-foreground">
            IVA con el que se timbrará: <span className="font-semibold text-foreground">{settings.taxRatePct}%</span>.
            Se cambia en la pestaña{" "}
            <span className="font-medium text-foreground underline decoration-dotted">Precios y features</span>,
            junto con las tarifas por defecto.
          </p>

          <a
            href="https://docs.facturapi.io/"
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
          >
            Documentación de Facturapi <ExternalLink className="h-3 w-3" />
          </a>

          {!esRoot && (
            <p className="mt-3 text-xs text-muted-foreground">
              Solo el administrador raíz puede cambiar esto.
            </p>
          )}

          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
