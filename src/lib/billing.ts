import type { BillingSettings } from "./billingSettings";
import { clientDisplayName, type Client, type Currency } from "./firestoreClients";
import type { MonitoredRepo, Project } from "./firestoreProjects";

// ---------------------------------------------------------------------------
// Motor de cobro. Funciones puras: reciben clientes, proyectos, repos y la
// configuración global, y devuelven el desglose mensual. Nada de Firestore aquí,
// para poder recalcular en el cliente sin pedir nada y probarlo directo.
//
// Lo que se cobra es el REPO. El precio se resuelve en cascada:
//   1. `repos/{id}.monthlyPrice`  — precio fijado a ese repo en particular
//   2. `clients/{id}.billing.pricePerRepo` — tarifa del cliente
//   3. `settings/billing.defaultPricePerRepo` — default global
// Encima se suman los extras contratados (avances, publicar apps), se aplica el
// descuento del cliente y al final el IVA.
// ---------------------------------------------------------------------------

/**
 * De dónde salió el precio de un repo (se muestra en la UI para explicarlo).
 * `sin-precio` = el cliente cobra en otra moneda que la global, así que heredar
 * el default lo cobraría en la moneda equivocada: hay que fijarle tarifa propia.
 */
export type PriceSource = "repo" | "cliente" | "default" | "sin-precio";

export interface RepoCharge {
  repoId: string;
  label: string;
  slug: string; // owner/repo
  projectId: string;
  projectName: string;
  price: number;
  source: PriceSource;
}

export interface ExtraCharge {
  key: "avances" | "apps";
  label: string;
  amount: number;
  /** true = el monto salió del default global, no del precio propio del cliente. */
  fromDefault: boolean;
}

export interface ClientBillingSummary {
  clientId: string;
  clientName: string;
  color: string;
  status: Client["status"];
  currency: Currency;
  billingDay: number;
  projectCount: number;
  repoCount: number;
  repoCharges: RepoCharge[];
  reposSubtotal: number;
  extras: ExtraCharge[];
  extrasSubtotal: number;
  discountPct: number;
  discountAmount: number;
  /** Base gravable: repos + extras − descuento. */
  subtotal: number;
  taxRatePct: number;
  taxAmount: number;
  total: number;
  /** Datos fiscales completos para poder timbrar (RFC, régimen y CP). */
  facturable: boolean;
  /**
   * Cobra en una moneda distinta a la global, así que no puede heredar los
   * montos default: hay repos o extras en cero esperando tarifa propia.
   */
  currencyMismatch: boolean;
  /** Repos que quedaron en 0 (sin precio propio ni default aplicable). */
  reposSinPrecio: number;
}

/** Redondeo a centavos: evita los 0.30000000000000004 en los totales. */
const money = (n: number) => Math.round(n * 100) / 100;

/** Moneda en la que factura el cliente (la suya, o la global si no fijó una). */
export const clientCurrency = (client: Client | undefined, settings: BillingSettings): Currency =>
  client?.billing?.currency ?? settings.currency;

/**
 * Los montos default de `settings/billing` están expresados en la moneda global.
 * Un cliente que factura en otra moneda NO puede heredarlos: serían pesos
 * cobrados como dólares. Para ese caso el default no aplica y el precio se
 * queda en cero hasta que se le fije tarifa propia (la UI lo marca).
 */
const puedeHeredar = (client: Client | undefined, settings: BillingSettings) =>
  clientCurrency(client, settings) === settings.currency;

/** Precio mensual de un repo, con su origen. */
export function resolveRepoPrice(
  repo: MonitoredRepo,
  client: Client | undefined,
  settings: BillingSettings,
): { price: number; source: PriceSource } {
  if (typeof repo.monthlyPrice === "number") return { price: repo.monthlyPrice, source: "repo" };
  const delCliente = client?.billing?.pricePerRepo;
  if (typeof delCliente === "number") return { price: delCliente, source: "cliente" };
  if (!puedeHeredar(client, settings)) return { price: 0, source: "sin-precio" };
  return { price: settings.defaultPricePerRepo, source: "default" };
}

/** ¿Tiene lo mínimo para timbrar un CFDI? (RFC + régimen + CP) */
export function isFacturable(client: Client): boolean {
  const f = client.fiscal;
  return !!(f?.taxId && f.taxSystem && f.zip);
}

export function computeClientBilling(
  client: Client,
  projects: Project[],
  repos: MonitoredRepo[],
  settings: BillingSettings,
): ClientBillingSummary {
  const propios = projects.filter((p) => p.clientId === client.id);
  const nombrePorProyecto = new Map(propios.map((p) => [p.id, p.name]));
  const idsProyecto = new Set(propios.map((p) => p.id));

  const repoCharges: RepoCharge[] = repos
    .filter((r) => idsProyecto.has(r.projectId))
    .map((r) => {
      const { price, source } = resolveRepoPrice(r, client, settings);
      return {
        repoId: r.id,
        label: r.label,
        slug: `${r.owner}/${r.repo}`,
        projectId: r.projectId,
        projectName: nombrePorProyecto.get(r.projectId) ?? "—",
        price,
        source,
      };
    });

  const reposSubtotal = money(repoCharges.reduce((acc, c) => acc + c.price, 0));

  const features = client.features;
  const hereda = puedeHeredar(client, settings);
  const extras: ExtraCharge[] = [];
  // Si el cliente cobra en otra moneda, el default global no aplica (está en la
  // moneda global): el extra se queda en 0 hasta que se le fije precio propio.
  if (features?.showAvances) {
    const propio = features.avancesPrice;
    const amount = typeof propio === "number" ? propio : hereda ? settings.defaultAvancesPrice : 0;
    if (amount > 0) extras.push({ key: "avances", label: "Visualización de avances", amount, fromDefault: typeof propio !== "number" });
  }
  if (features?.publishApps) {
    const propio = features.publishAppsPrice;
    const amount = typeof propio === "number" ? propio : hereda ? settings.defaultPublishAppsPrice : 0;
    if (amount > 0) extras.push({ key: "apps", label: "Publicación de apps en tiendas", amount, fromDefault: typeof propio !== "number" });
  }
  const extrasSubtotal = money(extras.reduce((acc, e) => acc + e.amount, 0));

  const bruto = money(reposSubtotal + extrasSubtotal);
  const discountPct = client.billing?.discountPct ?? 0;
  const discountAmount = money((bruto * discountPct) / 100);
  const subtotal = money(bruto - discountAmount);
  const taxRatePct = client.billing?.taxExempt ? 0 : settings.taxRatePct;
  const taxAmount = money((subtotal * taxRatePct) / 100);

  return {
    clientId: client.id,
    clientName: clientDisplayName(client),
    color: client.color,
    status: client.status,
    currency: clientCurrency(client, settings),
    billingDay: client.billing?.billingDay ?? settings.defaultBillingDay,
    projectCount: propios.length,
    repoCount: repoCharges.length,
    repoCharges,
    reposSubtotal,
    extras,
    extrasSubtotal,
    discountPct,
    discountAmount,
    subtotal,
    taxRatePct,
    taxAmount,
    total: money(subtotal + taxAmount),
    facturable: isFacturable(client),
    currencyMismatch: !hereda,
    reposSinPrecio: repoCharges.filter((c) => c.price === 0).length,
  };
}

export interface BillingOverview {
  byClient: ClientBillingSummary[];
  /** Ingreso mensual recurrente por moneda (no se mezclan MXN y USD). */
  mrrByCurrency: Record<Currency, number>;
  /** Solo lo de clientes activos: lo suspendido no factura. */
  activeMrrByCurrency: Record<Currency, number>;
  totalClients: number;
  activeClients: number;
  totalProjects: number;
  totalRepos: number;
  /** Repos cobrables (los de proyectos con cliente asignado). */
  billedRepos: number;
  /** Proyectos sin cliente: no se le cobran a nadie, hay que asignarlos. */
  unassignedProjects: Project[];
  /**
   * Repos que no se le cobran a nadie: los de proyectos sin cliente y los que
   * apuntan a un proyecto que ya no existe. `billedRepos + unassignedRepos`
   * siempre suma `totalRepos`, para que las pantallas no se contradigan.
   */
  unassignedRepos: number;
  /** Clientes activos a los que les falta RFC/régimen/CP para poder facturar. */
  missingFiscal: ClientBillingSummary[];
  /**
   * Clientes que cobran en otra moneda que la global: sus repos y extras no
   * pueden heredar los defaults y quedan en cero hasta fijarles tarifa propia.
   */
  currencyMismatch: ClientBillingSummary[];
  /** Repos con precio 0 dentro de clientes activos: alguien no cobra. */
  reposSinPrecio: number;
  /** Se está heredando el default global y ese default es 0: nadie cobra nada. */
  defaultPriceMissing: boolean;
}

export function computeBillingOverview(
  clients: Client[],
  projects: Project[],
  repos: MonitoredRepo[],
  settings: BillingSettings,
): BillingOverview {
  const byClient = clients.map((c) => computeClientBilling(c, projects, repos, settings));

  const zero = (): Record<Currency, number> => ({ MXN: 0, USD: 0 });
  const mrrByCurrency = zero();
  const activeMrrByCurrency = zero();
  for (const s of byClient) {
    mrrByCurrency[s.currency] = money(mrrByCurrency[s.currency] + s.subtotal);
    if (s.status === "activo") {
      activeMrrByCurrency[s.currency] = money(activeMrrByCurrency[s.currency] + s.subtotal);
    }
  }

  const conCliente = new Set(clients.map((c) => c.id));
  const unassignedProjects = projects.filter((p) => !p.clientId || !conCliente.has(p.clientId));
  // Repos cobrables = los de proyectos CON cliente. Todo lo demás (proyecto sin
  // cliente, o repo cuyo proyecto ya se borró) es no asignado: si se restara
  // solo lo de proyectos existentes, los repos huérfanos no aparecían en ningún
  // lado y las dos pantallas daban totales distintos.
  const idsCobrables = new Set(
    projects.filter((p) => p.clientId && conCliente.has(p.clientId)).map((p) => p.id),
  );
  const billedRepos = byClient.reduce((acc, s) => acc + s.repoCount, 0);

  return {
    byClient,
    mrrByCurrency,
    activeMrrByCurrency,
    totalClients: clients.length,
    activeClients: byClient.filter((s) => s.status === "activo").length,
    totalProjects: projects.length,
    totalRepos: repos.length,
    billedRepos,
    unassignedProjects,
    unassignedRepos: repos.filter((r) => !idsCobrables.has(r.projectId)).length,
    missingFiscal: byClient.filter((s) => s.status === "activo" && !s.facturable),
    currencyMismatch: byClient.filter((s) => s.currencyMismatch),
    reposSinPrecio: byClient
      .filter((s) => s.status === "activo")
      .reduce((acc, s) => acc + s.reposSinPrecio, 0),
    defaultPriceMissing:
      settings.defaultPricePerRepo === 0 &&
      byClient.some((s) => s.repoCharges.some((c) => c.source === "default")),
  };
}

const FORMATTERS: Record<Currency, Intl.NumberFormat> = {
  MXN: new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 2 }),
  USD: new Intl.NumberFormat("es-MX", { style: "currency", currency: "USD", maximumFractionDigits: 2 }),
};

export const formatMoney = (amount: number, currency: Currency = "MXN") =>
  FORMATTERS[currency].format(amount);

/**
 * "$12,000.00 MXN + $300.00 USD" — para totales de monedas mezcladas.
 * `fallback` es la moneda con la que se pinta el cero cuando no hay nada que
 * sumar: un tenant que solo factura en dólares no debe ver "$0.00" en pesos.
 */
export function formatMixed(totals: Record<Currency, number>, fallback: Currency = "MXN"): string {
  const partes = (Object.entries(totals) as Array<[Currency, number]>)
    .filter(([, v]) => v > 0)
    .map(([cur, v]) => `${formatMoney(v, cur)} ${cur}`);
  return partes.length ? partes.join(" + ") : formatMoney(0, fallback);
}
