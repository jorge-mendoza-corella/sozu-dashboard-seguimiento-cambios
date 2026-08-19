import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, DollarSign, Eye, Store, Receipt } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useClientsBilling, useBillingSettings, useBillingOverview } from "@/hooks/useClients";
import {
  setBillingSettings, DEFAULT_BILLING_SETTINGS, type BillingSettingsPatch,
} from "@/lib/billingSettings";
import {
  setClientBilling, setClientFeatures, clientDisplayName, type Currency,
} from "@/lib/firestoreClients";
import { formatMoney, type ClientBillingSummary } from "@/lib/billing";

// ---------------------------------------------------------------------------
// Precios y features contratadas.
//
// Arriba las tarifas por defecto (`settings/billing`), que aplican a todo
// cliente que no tenga precio propio. Abajo una card por cliente donde se
// sobreescribe la tarifa, se prenden los extras (avances, publicar apps) y se
// ve, ya calculado, lo que se le cobra al mes.
//
// Todo guarda al salir del campo (blur) o al cambiar el select: no hay botón de
// "guardar" ni estado local que se pueda desincronizar de Firestore. Las
// validaciones (montos negativos, día de corte, descuento, URL) viven en la
// capa de datos; aquí solo se muestra el error que lanzan.
// ---------------------------------------------------------------------------

/**
 * Resultado de leer un input de monto. `ok: false` = el texto no es un número.
 * Hace falta distinguirlo: un campo que quedó vacío significa "hereda" (se
 * borra el campo), pero un pegado inválido NO, y devolver `null` en ese caso
 * borraba en silencio el precio propio del cliente.
 */
type MontoLeido = { ok: true; valor: number | null } | { ok: false };

/** Vacío = hereda el default global (`null` borra el campo en Firestore). */
const heredaOMonto = (raw: string): MontoLeido => {
  const v = raw.trim();
  if (v === "") return { ok: true, valor: null };
  const n = Number(v);
  return Number.isFinite(n) ? { ok: true, valor: n } : { ok: false };
};

const ERROR_MONTO = "El monto debe ser un número (usa punto para los decimales).";

export function PricingFeaturesSection() {
  const { appUser } = useAuth();
  const qc = useQueryClient();
  // Las tarifas viven en el doc privado del cliente: esta pantalla necesita la
  // lectura de administración, no la pública de la navegación.
  const { data: clients = [], isLoading: cargandoClientes } = useClientsBilling(appUser);
  const { data: settings = DEFAULT_BILLING_SETTINGS } = useBillingSettings();
  const { overview } = useBillingOverview(appUser);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refreshSettings = () => qc.invalidateQueries({ queryKey: ["billing-settings"] });
  const refreshClients = () => qc.invalidateQueries({ queryKey: ["clients"] });

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

  const guardarDefault = (key: string, patch: BillingSettingsPatch) =>
    run(key, () => setBillingSettings(patch, appUser!.email), refreshSettings);

  /**
   * Guarda un monto default. Un campo vacío no significa nada arriba (no hay de
   * quién heredar), así que se repone el valor actual y no se toca Firestore.
   * Un texto que no es número tampoco se guarda: se repone y se avisa.
   */
  const guardarMontoDefault = (
    key: string,
    campo: "defaultPricePerRepo" | "defaultAvancesPrice" | "defaultPublishAppsPrice",
    input: HTMLInputElement,
  ) => {
    const raw = input.value.trim();
    const leido = heredaOMonto(raw);
    if (!leido.ok) {
      setError(ERROR_MONTO);
      input.value = String(settings[campo]);
      return;
    }
    if (leido.valor === null) {
      input.value = String(settings[campo]);
      return;
    }
    if (leido.valor === settings[campo]) return;
    return guardarDefault(key, { [campo]: leido.valor });
  };

  /**
   * Guarda un monto por cliente que admite "vacío = hereda". Si el texto no es
   * un número no se escribe nada: guardar `null` ahí borraba el precio propio
   * del cliente por un pegado malo.
   */
  const guardarMontoCliente = (
    key: string,
    input: HTMLInputElement,
    actual: number | null,
    guardar: (valor: number | null) => Promise<unknown>,
  ) => {
    const leido = heredaOMonto(input.value);
    if (!leido.ok) {
      setError(ERROR_MONTO);
      input.value = actual === null ? "" : String(actual);
      return;
    }
    if (leido.valor === actual) return;
    run(key, () => guardar(leido.valor), refreshClients);
  };

  return (
    <div className="space-y-4">
      {/* --- Tarifas por defecto ------------------------------------------- */}
      <Card>
        <CardContent className="p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <DollarSign className="h-4 w-4 text-primary" /> Tarifas por defecto
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Aplican a todo cliente que no tenga precio propio. Lo que se cobra es el repositorio:
            si el repo no trae precio se usa la tarifa del cliente, y si el cliente tampoco, estas.
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block">
              <span className="text-[11px] font-medium text-muted-foreground">Costo mensual por repo</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  key={`repo-${settings.defaultPricePerRepo}`}
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  defaultValue={settings.defaultPricePerRepo}
                  disabled={busy === "def-repo"}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  onBlur={(e) => guardarMontoDefault("def-repo", "defaultPricePerRepo", e.target)}
                />
                {busy === "def-repo" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
            </label>

            <label className="block">
              <span className="text-[11px] font-medium text-muted-foreground">Extra por ver avances</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  key={`av-${settings.defaultAvancesPrice}`}
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  defaultValue={settings.defaultAvancesPrice}
                  disabled={busy === "def-av"}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  onBlur={(e) => guardarMontoDefault("def-av", "defaultAvancesPrice", e.target)}
                />
                {busy === "def-av" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
            </label>

            <label className="block">
              <span className="text-[11px] font-medium text-muted-foreground">Extra por publicar apps</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  key={`apps-${settings.defaultPublishAppsPrice}`}
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  defaultValue={settings.defaultPublishAppsPrice}
                  disabled={busy === "def-apps"}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  onBlur={(e) => guardarMontoDefault("def-apps", "defaultPublishAppsPrice", e.target)}
                />
                {busy === "def-apps" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
            </label>

            <label className="block">
              <span className="text-[11px] font-medium text-muted-foreground">Día de corte (1-28)</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  key={`dia-${settings.defaultBillingDay}`}
                  type="number"
                  min={1}
                  max={28}
                  step={1}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  defaultValue={settings.defaultBillingDay}
                  disabled={busy === "def-dia"}
                  title="Del 1 al 28 para que exista en todos los meses (incluido febrero)."
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    if (raw === "") { e.target.value = String(settings.defaultBillingDay); return; }
                    const dia = Number(raw);
                    if (dia === settings.defaultBillingDay) return;
                    guardarDefault("def-dia", { defaultBillingDay: dia });
                  }}
                />
                {busy === "def-dia" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
            </label>

            <label className="block">
              <span className="text-[11px] font-medium text-muted-foreground">Moneda</span>
              <div className="mt-1 flex items-center gap-2">
                <SelectNative
                  className="w-full"
                  value={settings.currency}
                  disabled={busy === "def-cur"}
                  onChange={(e) => guardarDefault("def-cur", { currency: e.target.value as Currency })}
                >
                  <option value="MXN">MXN — pesos mexicanos</option>
                  <option value="USD">USD — dólares</option>
                </SelectNative>
                {busy === "def-cur" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
            </label>

            <label className="block">
              <span className="text-[11px] font-medium text-muted-foreground">IVA</span>
              <div className="mt-1 flex items-center gap-2">
                <SelectNative
                  className="w-full"
                  value={settings.taxRatePct}
                  disabled={busy === "def-iva"}
                  onChange={(e) => guardarDefault("def-iva", { taxRatePct: Number(e.target.value) })}
                >
                  <option value={16}>16% — IVA general</option>
                  <option value={0}>0% — sin impuesto</option>
                </SelectNative>
                {busy === "def-iva" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* --- Precios y features por cliente ------------------------------- */}
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Receipt className="h-4 w-4 text-primary" /> Por cliente ({clients.length})
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Deja un monto vacío para que el cliente herede la tarifa por defecto.
        </p>
      </div>

      {cargandoClientes && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> cargando clientes…
        </p>
      )}
      {!cargandoClientes && clients.length === 0 && (
        <p className="text-xs text-muted-foreground">Aún no hay clientes registrados.</p>
      )}

      <div className="space-y-3">
        {clients.map((c) => {
          const billing = c.billing;
          const features = c.features;
          const avancesOn = features?.showAvances ?? false;
          const appsOn = features?.publishApps ?? false;
          // Desglose ya calculado por el motor de cobro (repos × precios × extras).
          const summary: ClientBillingSummary | undefined = overview.byClient.find((s) => s.clientId === c.id);
          const moneda: Currency = summary?.currency ?? billing?.currency ?? settings.currency;

          return (
            <Card key={c.id}>
              <CardContent className="p-4">
                <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
                  {/* Configuración */}
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                      <span className="text-sm font-semibold">{clientDisplayName(c)}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {c.status}
                        {summary ? ` · ${summary.projectCount} proyecto${summary.projectCount === 1 ? "" : "s"}` : ""}
                      </span>
                    </div>

                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="text-[11px] font-medium text-muted-foreground">Tarifa por repo</span>
                        <div className="mt-1 flex items-center gap-2">
                          <input
                            key={`pr-${c.id}-${billing?.pricePerRepo ?? "hereda"}`}
                            type="number"
                            min={0}
                            step="0.01"
                            inputMode="decimal"
                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                            placeholder={formatMoney(settings.defaultPricePerRepo, settings.currency)}
                            defaultValue={billing?.pricePerRepo ?? ""}
                            disabled={busy === `pr-${c.id}`}
                            title="Vacío = hereda la tarifa por defecto."
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                            onBlur={(e) =>
                              guardarMontoCliente(
                                `pr-${c.id}`,
                                e.target,
                                billing?.pricePerRepo ?? null,
                                (valor) => setClientBilling(c.id, { pricePerRepo: valor }),
                              )
                            }
                          />
                          {busy === `pr-${c.id}` && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                        </div>
                      </label>

                      <label className="block">
                        <span className="text-[11px] font-medium text-muted-foreground">Moneda</span>
                        <div className="mt-1 flex items-center gap-2">
                          <SelectNative
                            className="w-full"
                            value={billing?.currency ?? settings.currency}
                            disabled={busy === `cur-${c.id}`}
                            onChange={(e) =>
                              run(`cur-${c.id}`, () => setClientBilling(c.id, { currency: e.target.value as Currency }), refreshClients)
                            }
                          >
                            <option value="MXN">MXN</option>
                            <option value="USD">USD</option>
                          </SelectNative>
                          {busy === `cur-${c.id}` && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                        </div>
                      </label>

                      <label className="block">
                        <span className="text-[11px] font-medium text-muted-foreground">Día de corte</span>
                        <div className="mt-1 flex items-center gap-2">
                          <input
                            key={`dia-${c.id}-${billing?.billingDay ?? "hereda"}`}
                            type="number"
                            min={1}
                            max={28}
                            step={1}
                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                            placeholder={String(settings.defaultBillingDay)}
                            defaultValue={billing?.billingDay ?? ""}
                            disabled={busy === `dia-${c.id}`}
                            title="Vacío = hereda el día de corte por defecto."
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                            onBlur={(e) => {
                              const raw = e.target.value.trim();
                              // Vacío = volver a heredar el día de corte global: `null` borra el
                              // campo. Antes solo se repintaba el input y el día fijado a mano
                              // se quedaba en Firestore para siempre.
                              if (raw === "") {
                                if (billing?.billingDay == null) return;
                                run(`dia-${c.id}`, () => setClientBilling(c.id, { billingDay: null }), refreshClients);
                                return;
                              }
                              const dia = Number(raw);
                              if (dia === billing?.billingDay) return;
                              run(`dia-${c.id}`, () => setClientBilling(c.id, { billingDay: dia }), refreshClients);
                            }}
                          />
                          {busy === `dia-${c.id}` && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                        </div>
                      </label>

                      <label className="block">
                        <span className="text-[11px] font-medium text-muted-foreground">Descuento (%)</span>
                        <div className="mt-1 flex items-center gap-2">
                          <input
                            key={`desc-${c.id}-${billing?.discountPct ?? 0}`}
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            inputMode="decimal"
                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                            placeholder="0"
                            defaultValue={billing?.discountPct ?? ""}
                            disabled={busy === `desc-${c.id}`}
                            title="Se aplica sobre repos + extras, antes del IVA."
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                            onBlur={(e) => {
                              // Vacío = sin descuento (0), no "hereda": no hay descuento global.
                              const pct = e.target.value.trim() === "" ? 0 : Number(e.target.value);
                              if (pct === (billing?.discountPct ?? 0)) return;
                              run(`desc-${c.id}`, () => setClientBilling(c.id, { discountPct: pct }), refreshClients);
                            }}
                          />
                          {busy === `desc-${c.id}` && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                        </div>
                      </label>
                    </div>

                    {/* Exento de IVA */}
                    <div className="mt-3">
                      <button
                        type="button"
                        disabled={busy === `iva-${c.id}`}
                        title={
                          billing?.taxExempt
                            ? "No se le suma IVA — click para volver a cobrarlo"
                            : `Se le suma el ${settings.taxRatePct}% de IVA — click para eximirlo`
                        }
                        onClick={() =>
                          run(`iva-${c.id}`, () => setClientBilling(c.id, { taxExempt: !billing?.taxExempt }), refreshClients)
                        }
                        className={cn(
                          "flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50",
                          billing?.taxExempt
                            ? "border-amber-400 bg-amber-100 text-amber-800 dark:border-amber-700/60 dark:bg-amber-900/40 dark:text-amber-300"
                            : "border-border text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {busy === `iva-${c.id}` && <Loader2 className="h-3 w-3 animate-spin" />}
                        Exento de IVA
                      </button>
                    </div>

                    {/* Features contratadas */}
                    <div className="mt-4 space-y-3 border-t pt-3">
                      {/* Avances */}
                      <div>
                        <button
                          type="button"
                          disabled={busy === `av-${c.id}`}
                          onClick={() =>
                            run(`av-${c.id}`, () => setClientFeatures(c.id, { showAvances: !avancesOn }), refreshClients)
                          }
                          className={cn(
                            "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50",
                            avancesOn
                              ? "border-violet-400 bg-violet-100 text-violet-700 dark:border-violet-700/60 dark:bg-violet-900/40 dark:text-violet-300"
                              : "border-border text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {busy === `av-${c.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
                          Puede ver sus avances
                        </button>
                        {avancesOn && (
                          <div className="mt-2 grid gap-2 pl-1 sm:grid-cols-[1fr_140px]">
                            <label className="block">
                              <span className="text-[11px] text-muted-foreground">Link de avances</span>
                              <div className="mt-1 flex items-center gap-2">
                                <input
                                  key={`avu-${c.id}-${features?.avancesUrl ?? "none"}`}
                                  type="url"
                                  spellCheck={false}
                                  autoCapitalize="none"
                                  autoCorrect="off"
                                  className="h-9 w-full rounded-md border bg-background px-2 font-mono text-xs"
                                  placeholder="https://avances.cliente.com"
                                  defaultValue={features?.avancesUrl ?? ""}
                                  disabled={busy === `avu-${c.id}`}
                                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                  onBlur={(e) => {
                                    const url = e.target.value.trim();
                                    if (url === (features?.avancesUrl ?? "")) return;
                                    // La validación de que empiece con http la hace setClientFeatures:
                                    // si no pasa, su error se pinta abajo y el campo queda como está.
                                    run(`avu-${c.id}`, () => setClientFeatures(c.id, { avancesUrl: url }), refreshClients);
                                  }}
                                />
                                {busy === `avu-${c.id}` && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                              </div>
                            </label>
                            <label className="block">
                              <span className="text-[11px] text-muted-foreground">Costo extra</span>
                              <div className="mt-1 flex items-center gap-2">
                                <input
                                  key={`avp-${c.id}-${features?.avancesPrice ?? "hereda"}`}
                                  type="number"
                                  min={0}
                                  step="0.01"
                                  inputMode="decimal"
                                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                                  placeholder={formatMoney(settings.defaultAvancesPrice, settings.currency)}
                                  defaultValue={features?.avancesPrice ?? ""}
                                  disabled={busy === `avp-${c.id}`}
                                  title="Vacío = hereda el extra por defecto."
                                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                  onBlur={(e) =>
                                    guardarMontoCliente(
                                      `avp-${c.id}`,
                                      e.target,
                                      features?.avancesPrice ?? null,
                                      (valor) => setClientFeatures(c.id, { avancesPrice: valor }),
                                    )
                                  }
                                />
                                {busy === `avp-${c.id}` && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                              </div>
                            </label>
                          </div>
                        )}
                      </div>

                      {/* Publicación de apps */}
                      <div>
                        <button
                          type="button"
                          disabled={busy === `ap-${c.id}`}
                          onClick={() =>
                            run(`ap-${c.id}`, () => setClientFeatures(c.id, { publishApps: !appsOn }), refreshClients)
                          }
                          className={cn(
                            "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50",
                            appsOn
                              ? "border-blue-400 bg-blue-100 text-blue-700 dark:border-blue-700/60 dark:bg-blue-900/40 dark:text-blue-300"
                              : "border-border text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {busy === `ap-${c.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Store className="h-3 w-3" />}
                          Puede publicar apps en tiendas
                        </button>
                        <p className="mt-1 pl-1 text-[11px] text-muted-foreground">
                          Publicar en App Store y Google Play es un costo extra: al prenderlo se suma al cobro
                          mensual del cliente, además de lo que pague por sus repos.
                        </p>
                        {appsOn && (
                          <label className="mt-2 block w-full pl-1 sm:w-[140px]">
                            <span className="text-[11px] text-muted-foreground">Costo extra</span>
                            <div className="mt-1 flex items-center gap-2">
                              <input
                                key={`app-${c.id}-${features?.publishAppsPrice ?? "hereda"}`}
                                type="number"
                                min={0}
                                step="0.01"
                                inputMode="decimal"
                                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                                placeholder={formatMoney(settings.defaultPublishAppsPrice, settings.currency)}
                                defaultValue={features?.publishAppsPrice ?? ""}
                                disabled={busy === `app-${c.id}`}
                                title="Vacío = hereda el extra por defecto."
                                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                onBlur={(e) =>
                                  guardarMontoCliente(
                                    `app-${c.id}`,
                                    e.target,
                                    features?.publishAppsPrice ?? null,
                                    (valor) => setClientFeatures(c.id, { publishAppsPrice: valor }),
                                  )
                                }
                              />
                              {busy === `app-${c.id}` && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                            </div>
                          </label>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Resumen del cobro mensual */}
                  <div className="rounded-md border bg-muted/30 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Cobro mensual
                    </p>
                    {!summary ? (
                      <p className="mt-2 text-xs text-muted-foreground">Calculando…</p>
                    ) : (
                      <div className="mt-2 space-y-1 text-xs">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-muted-foreground">
                            {summary.repoCount} repo{summary.repoCount === 1 ? "" : "s"}
                          </span>
                          <span className="font-medium">{formatMoney(summary.reposSubtotal, summary.currency)}</span>
                        </div>
                        {summary.extras.map((extra) => (
                          <div key={extra.key} className="flex items-baseline justify-between gap-2">
                            <span className="text-muted-foreground">
                              {extra.label}
                              {extra.fromDefault ? " (default)" : ""}
                            </span>
                            <span className="font-medium">{formatMoney(extra.amount, summary.currency)}</span>
                          </div>
                        ))}
                        {summary.extras.length === 0 && (
                          <p className="text-[11px] text-muted-foreground">Sin extras contratados.</p>
                        )}
                        {summary.discountAmount > 0 && (
                          <div className="flex items-baseline justify-between gap-2 text-emerald-700 dark:text-emerald-400">
                            <span>Descuento {summary.discountPct}%</span>
                            <span className="font-medium">−{formatMoney(summary.discountAmount, summary.currency)}</span>
                          </div>
                        )}
                        <div className="flex items-baseline justify-between gap-2 border-t pt-1">
                          <span className="text-muted-foreground">Subtotal</span>
                          <span className="font-medium">{formatMoney(summary.subtotal, summary.currency)}</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-muted-foreground">
                            IVA {summary.taxRatePct}%{summary.taxRatePct === 0 ? " (exento)" : ""}
                          </span>
                          <span className="font-medium">{formatMoney(summary.taxAmount, summary.currency)}</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2 border-t pt-1.5">
                          <span className="font-semibold">Total</span>
                          <span className="text-sm font-bold">
                            {formatMoney(summary.total, summary.currency)} {summary.currency}
                          </span>
                        </div>
                        <p className="pt-1 text-[10px] text-muted-foreground">
                          Corte el día {summary.billingDay} de cada mes · {moneda}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
