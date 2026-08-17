import { deleteField, doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import type { Currency } from "./firestoreClients";

// ---------------------------------------------------------------------------
// Configuración administrativa de cobro. Vive en `settings/billing` y la lee
// cualquier usuario registrado; solo el root la cambia.
//
// La API key de Facturapi NO vive aquí: es un secreto y se guarda en
// `secrets/facturapi`, colección que las reglas prohíben leer desde el
// navegador (igual que las credenciales de tienda). Lo único visible desde el
// dashboard es cuándo y quién la guardó, y en qué entorno (test/live).
// ---------------------------------------------------------------------------

const REF = () => doc(db, "settings", "billing");
const SECRETO = () => doc(db, "secrets", "facturapi");

export type FacturapiEnv = "test" | "live";

export interface BillingSettings {
  /** Costo mensual por repo cuando el cliente no tiene precio propio. */
  defaultPricePerRepo: number;
  currency: Currency;
  /** IVA en porcentaje (16 en México). 0 = no calcular impuesto. */
  taxRatePct: number;
  /** Costo extra por prender "ver avances" a un cliente. */
  defaultAvancesPrice: number;
  /** Costo extra por habilitarle publicación de apps en tiendas. */
  defaultPublishAppsPrice: number;
  /** Día de corte default (1-28). */
  defaultBillingDay: number;
  // --- Facturapi (solo metadatos; la key es secreta) ---
  facturapiEnv: FacturapiEnv;
  facturapiKeySetAt: string | null;
  facturapiKeySetBy: string | null;
  /** Serie y folio para los CFDI que se emitirán en la fase 2. */
  facturapiSeries?: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  defaultPricePerRepo: 0,
  currency: "MXN",
  taxRatePct: 16,
  defaultAvancesPrice: 0,
  defaultPublishAppsPrice: 0,
  defaultBillingDay: 1,
  facturapiEnv: "test",
  facturapiKeySetAt: null,
  facturapiKeySetBy: null,
  updatedAt: null,
  updatedBy: null,
};

const iso = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  const conFecha = v as { toDate?: () => Date } | undefined;
  return conFecha?.toDate ? conFecha.toDate().toISOString() : null;
};

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export async function getBillingSettings(): Promise<BillingSettings> {
  const snap = await getDoc(REF());
  if (!snap.exists()) return DEFAULT_BILLING_SETTINGS;
  const d = snap.data() as Record<string, unknown>;
  return {
    defaultPricePerRepo: num(d.defaultPricePerRepo, DEFAULT_BILLING_SETTINGS.defaultPricePerRepo),
    currency: d.currency === "USD" ? "USD" : "MXN",
    taxRatePct: num(d.taxRatePct, DEFAULT_BILLING_SETTINGS.taxRatePct),
    defaultAvancesPrice: num(d.defaultAvancesPrice, 0),
    defaultPublishAppsPrice: num(d.defaultPublishAppsPrice, 0),
    defaultBillingDay: num(d.defaultBillingDay, 1),
    facturapiEnv: d.facturapiEnv === "live" ? "live" : "test",
    facturapiKeySetAt: iso(d.facturapiKeySetAt),
    facturapiKeySetBy: typeof d.facturapiKeySetBy === "string" ? d.facturapiKeySetBy : null,
    facturapiSeries: typeof d.facturapiSeries === "string" ? d.facturapiSeries : undefined,
    updatedAt: iso(d.updatedAt),
    updatedBy: typeof d.updatedBy === "string" ? d.updatedBy : null,
  };
}

export type BillingSettingsPatch = Partial<
  Pick<BillingSettings,
    "defaultPricePerRepo" | "currency" | "taxRatePct" | "defaultAvancesPrice" |
    "defaultPublishAppsPrice" | "defaultBillingDay" | "facturapiEnv" | "facturapiSeries">
>;

export async function setBillingSettings(patch: BillingSettingsPatch, email: string) {
  const clean: Record<string, unknown> = { updatedAt: new Date(), updatedBy: email };
  for (const key of ["defaultPricePerRepo", "taxRatePct", "defaultAvancesPrice", "defaultPublishAppsPrice"] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v < 0) throw new Error("Los montos deben ser números mayores o iguales a 0.");
    clean[key] = v;
  }
  if (patch.taxRatePct !== undefined && patch.taxRatePct > 100) {
    throw new Error("El IVA no puede pasar de 100%.");
  }
  if (patch.defaultBillingDay !== undefined) {
    if (patch.defaultBillingDay < 1 || patch.defaultBillingDay > 28) {
      throw new Error("El día de corte debe estar entre 1 y 28.");
    }
    clean.defaultBillingDay = patch.defaultBillingDay;
  }
  if (patch.currency !== undefined) clean.currency = patch.currency;
  if (patch.facturapiEnv !== undefined) clean.facturapiEnv = patch.facturapiEnv;
  // Serie vacía = borrar el campo, para que la UI vuelva a mostrar su default.
  if (patch.facturapiSeries !== undefined) {
    const serie = patch.facturapiSeries.trim().toUpperCase();
    clean.facturapiSeries = serie || deleteField();
  }
  await setDoc(REF(), clean, { merge: true });
}

/**
 * Guarda la API key secreta de Facturapi. Solo se escribe: las reglas prohíben
 * leer `secrets/` desde el navegador. Las keys son `sk_test_…` / `sk_live_…`; el
 * entorno se deduce del prefijo y se deja en los metadatos para la UI.
 *
 * La validación de longitud es a propósito estricta: una key truncada al copiar
 * pasaba el formato, se guardaba como buena y la pantalla decía "configurado"
 * mientras el timbrado de la fase 2 iba a fallar. Lo único que confirma de
 * verdad la key es una llamada a Facturapi, que solo puede hacer el backend.
 */
export async function setFacturapiKey(key: string, email: string): Promise<FacturapiEnv> {
  const limpia = key.trim();
  if (!limpia) throw new Error("Pega la API key de Facturapi.");
  const m = /^sk_(test|live)_[A-Za-z0-9]{24,64}$/.exec(limpia);
  if (!m) {
    throw new Error(
      'API key inválida. Debe ser la Secret Key completa de Facturapi ("sk_test_…" o "sk_live_…"); ' +
        "revisa que se haya copiado entera.",
    );
  }
  const env = m[1] as FacturapiEnv;
  await setDoc(SECRETO(), { apiKey: limpia, env, updatedBy: email, updatedAt: new Date() });
  await setDoc(
    REF(),
    { facturapiEnv: env, facturapiKeySetAt: new Date(), facturapiKeySetBy: email, updatedAt: new Date(), updatedBy: email },
    { merge: true },
  );
  return env;
}
