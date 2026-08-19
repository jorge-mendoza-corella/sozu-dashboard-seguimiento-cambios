import { db } from "./firebase";
import {
  doc, getDoc, setDoc, deleteDoc, updateDoc, collection, getDocs, serverTimestamp,
  query, where, deleteField,
} from "firebase/firestore";
import { SUPERUSER_EMAIL, type AppUser } from "./firestoreUsers";
import type { ClientBranding } from "./branding";

/** Admin global: el root y cualquier `superuser`. Son los que ven todo. */
const esAdminGlobalUser = (u: AppUser | null) =>
  !!u && (u.email === SUPERUSER_EMAIL || u.role === "superuser");

// ---------------------------------------------------------------------------
// Clientes del SaaS: la empresa o persona que paga el servicio. Un cliente
// tiene varios proyectos (`projects/{id}.clientId`) y cada proyecto varios
// repos. Lo que se cobra es el repo: el precio sale del repo, si no del
// cliente, y si no del default global (`settings/billing`).
//
// El documento se parte en dos por privacidad:
//   `clients/{id}`                  identidad y features — lo lee cualquier
//                                   usuario registrado, porque la navegación
//                                   necesita el nombre y el link de avances.
//   `clients/{id}/private/billing`  datos fiscales y tarifas — solo superusers.
//
// Importa: `AppLayout` carga la lista de clientes en CADA página, así que dejar
// el RFC y los precios en el doc raíz los mandaba al navegador de todos los
// usuarios. Por eso `getClients()` trae solo lo público y `getClientsWithBilling()`
// —el que usan las pantallas de administración— es el que baja lo privado.
// ---------------------------------------------------------------------------

/** Persona moral (empresa, tiene razón social) o física (una persona). */
export type PersonaType = "moral" | "fisica";

export type ClientStatus = "activo" | "suspendido" | "prospecto";

export type Currency = "MXN" | "USD";

/**
 * Datos fiscales para facturar. Los nombres de los campos siguen el payload de
 * Facturapi (customer: legal_name, tax_id, tax_system, address.zip…) para que
 * la integración de la fase 2 sea un mapeo directo, sin migración de datos.
 */
export interface FiscalData {
  taxId?: string;         // RFC
  taxSystem?: string;     // régimen fiscal SAT (601, 612, 616…)
  usoCfdi?: string;       // uso del CFDI (G03 = gastos en general)
  billingEmail?: string;  // a dónde llega la factura
  phone?: string;
  // Domicilio fiscal. El CP es el único obligatorio para timbrar en el SAT.
  zip?: string;
  street?: string;
  exterior?: string;
  interior?: string;
  neighborhood?: string;
  city?: string;
  municipality?: string;
  state?: string;
  country?: string; // ISO-3 ("MEX"), default MEX
}

/** Régimenes fiscales SAT más usados (catálogo c_RegimenFiscal recortado). */
export const REGIMENES_FISCALES: Array<{ code: string; label: string; persona: PersonaType[] }> = [
  { code: "601", label: "601 — General de Ley Personas Morales", persona: ["moral"] },
  { code: "603", label: "603 — Personas Morales con Fines no Lucrativos", persona: ["moral"] },
  { code: "605", label: "605 — Sueldos y Salarios e Ingresos Asimilados", persona: ["fisica"] },
  { code: "606", label: "606 — Arrendamiento", persona: ["fisica"] },
  { code: "612", label: "612 — Actividades Empresariales y Profesionales", persona: ["fisica"] },
  { code: "616", label: "616 — Sin obligaciones fiscales", persona: ["fisica"] },
  { code: "621", label: "621 — Incorporación Fiscal", persona: ["fisica"] },
  { code: "626", label: "626 — RESICO", persona: ["fisica", "moral"] },
];

/** Usos de CFDI habituales para un servicio de software. */
export const USOS_CFDI: Array<{ code: string; label: string }> = [
  { code: "G03", label: "G03 — Gastos en general" },
  { code: "G01", label: "G01 — Adquisición de mercancías" },
  { code: "I01", label: "I01 — Construcciones" },
  { code: "I04", label: "I04 — Equipo de cómputo y accesorios" },
  { code: "S01", label: "S01 — Sin efectos fiscales" },
  { code: "P01", label: "P01 — Por definir" },
];

/** Precios del cliente. Campo vacío = hereda el default global. */
export interface ClientBilling {
  pricePerRepo?: number | null; // costo mensual por repo de este cliente
  currency?: Currency;
  billingDay?: number | null;   // día del mes en que se corta (1-28)
  discountPct?: number;  // descuento sobre el subtotal
  taxExempt?: boolean;   // no se le suma IVA
}

/**
 * Lo que el cliente tiene contratado. `showAvances` y `publishApps` son costo
 * extra: cuando están prendidos se suman al cobro mensual con su precio (el
 * del cliente, o el default global si no se fijó uno).
 */
export interface ClientFeatures {
  showAvances: boolean;      // puede ver su sitio de avances
  avancesUrl?: string;       // link de avances propio del cliente
  avancesPrice?: number | null;
  publishApps: boolean;      // puede publicar apps en las tiendas
  publishAppsPrice?: number | null;
}

export interface Client {
  id: string;
  legalName: string;   // razón social (o nombre completo, si es persona física)
  tradeName?: string;  // nombre comercial / cómo se le conoce
  personaType: PersonaType;
  status: ClientStatus;
  color: string;
  order: number;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
  fiscal?: FiscalData;
  billing?: ClientBilling;
  features?: ClientFeatures;
  facturapiCustomerId?: string; // se llena cuando se sincroniza con Facturapi (fase 2)
  // Marca con la que esa empresa ve la herramienta (white label). Vive en el doc
  // raíz porque la necesita cualquiera que pertenezca a la empresa, y no hay
  // nada secreto en un logo.
  branding?: ClientBranding;
  createdBy: string;
  createdAt: unknown;
  updatedAt?: unknown;
}

const CLIENT_COLORS = [
  "#0ea5e9", "#f97316", "#14b8a6", "#d946ef", "#eab308",
  "#6366f1", "#22c55e", "#f43f5e", "#8b5cf6", "#64748b",
];

export const DEFAULT_FEATURES: ClientFeatures = { showAvances: false, publishApps: false };

/** Nombre a mostrar: el comercial si lo tiene, si no la razón social. */
export const clientDisplayName = (c: Client) => c.tradeName?.trim() || c.legalName;

/** Doc privado del cliente: datos fiscales y tarifas. Solo lo leen superusers. */
const PRIVADO = (id: string) => doc(db, "clients", id, "private", "billing");

/** Lo que guarda el doc privado. Se fusiona en `Client` al leerlo. */
interface ClientPrivate {
  fiscal?: FiscalData;
  billing?: ClientBilling;
}

// --- CRUD -------------------------------------------------------------------

const ordenar = (cs: Client[]) =>
  cs.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.legalName.localeCompare(b.legalName));

/**
 * Identidad y features de TODOS los clientes. Barrer la colección solo se lo
 * permiten las reglas a un admin global; el resto usa `getClientsFor`.
 */
export async function getClients(): Promise<Client[]> {
  const snap = await getDocs(collection(db, "clients"));
  return ordenar(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Client, "id">) })));
}

/**
 * Los clientes que este usuario puede leer.
 *
 * Un admin global barre la colección. Los demás solo pueden leer las empresas a
 * las que pertenecen, y además **de una en una**: las reglas acotan la lectura
 * por documento, y una consulta de colección que el motor no puede demostrar se
 * deniega entera. Por eso aquí se piden por id en lugar de filtrar en memoria.
 */
export async function getClientsFor(user: AppUser | null): Promise<Client[]> {
  if (esAdminGlobalUser(user)) return getClients();
  const ids = user?.clientIds ?? [];
  if (ids.length === 0) return []; // legacy sin empresa: no puede leer ninguna
  const docs = await Promise.all(
    ids.map((id) => getDoc(doc(db, "clients", id)).catch(() => null)),
  );
  return ordenar(
    docs
      .filter((d): d is NonNullable<typeof d> => !!d && d.exists())
      .map((d) => ({ id: d.id, ...(d.data() as Omit<Client, "id">) })),
  );
}

/**
 * Igual que `getClients()` pero además baja el doc privado de cada cliente
 * (fiscal + tarifas). Es una lectura extra por cliente, así que se usa SOLO en
 * las pantallas de administración (Negocio y Configuración), no en la navegación.
 * Si las reglas niegan el doc privado, ese cliente queda sin fiscal ni billing
 * en lugar de tumbar la pantalla completa.
 */
export async function getClientsWithBilling(user: AppUser | null = null): Promise<Client[]> {
  const base = user ? await getClientsFor(user) : await getClients();
  return Promise.all(
    base.map(async (c) => {
      try {
        const snap = await getDoc(PRIVADO(c.id));
        if (!snap.exists()) return c;
        const priv = snap.data() as ClientPrivate;
        return { ...c, fiscal: priv.fiscal, billing: priv.billing };
      } catch {
        return c;
      }
    }),
  );
}

export async function getClient(id: string): Promise<Client | null> {
  const snap = await getDoc(doc(db, "clients", id));
  if (!snap.exists()) return null;
  const base = { id: snap.id, ...(snap.data() as Omit<Client, "id">) };
  try {
    const priv = await getDoc(PRIVADO(id));
    if (!priv.exists()) return base;
    const d = priv.data() as ClientPrivate;
    return { ...base, fiscal: d.fiscal, billing: d.billing };
  } catch {
    return base;
  }
}

export interface NewClientInput {
  legalName: string;
  tradeName?: string;
  personaType?: PersonaType;
  status?: ClientStatus;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
}

export async function addClient(input: NewClientInput, addedBy: string): Promise<string> {
  const legalName = input.legalName.trim();
  if (!legalName) throw new Error("La razón social (o nombre) es obligatoria.");
  const existing = await getClients();
  if (existing.some((c) => c.legalName.toLowerCase() === legalName.toLowerCase())) {
    throw new Error("Ya existe un cliente con esa razón social.");
  }
  const ref = doc(collection(db, "clients"));
  await setDoc(ref, {
    legalName,
    ...(input.tradeName?.trim() ? { tradeName: input.tradeName.trim() } : {}),
    personaType: input.personaType ?? "moral",
    status: input.status ?? "activo",
    color: CLIENT_COLORS[existing.length % CLIENT_COLORS.length],
    order: existing.length,
    ...(input.contactName?.trim() ? { contactName: input.contactName.trim() } : {}),
    ...(input.contactEmail?.trim() ? { contactEmail: input.contactEmail.trim() } : {}),
    ...(input.contactPhone?.trim() ? { contactPhone: input.contactPhone.trim() } : {}),
    features: DEFAULT_FEATURES,
    createdBy: addedBy,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/** Patch libre de los campos "planos" del cliente (nombre, contacto, estatus…). */
export async function updateClient(
  id: string,
  patch: Partial<Pick<Client, "legalName" | "tradeName" | "personaType" | "status" | "contactName" | "contactEmail" | "contactPhone" | "notes">>,
) {
  const clean: Record<string, unknown> = { updatedAt: serverTimestamp() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    clean[k] = typeof v === "string" && v.trim() === "" ? deleteField() : v;
  }
  if (patch.legalName !== undefined && !patch.legalName.trim()) {
    throw new Error("La razón social (o nombre) es obligatoria.");
  }
  await updateDoc(doc(db, "clients", id), clean);
}

/**
 * Datos fiscales, en el doc privado del cliente. Un campo vacío se BORRA en vez
 * de guardarse como "": estos campos se mandan tal cual a Facturapi en la fase
 * 2 y un string vacío es un CFDI rechazado.
 */
export async function setClientFiscal(id: string, fiscal: FiscalData) {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fiscal)) {
    if (v === undefined) continue;
    const valor = typeof v === "string" ? v.trim() : v;
    clean[k] = valor === "" ? deleteField() : valor;
  }

  const texto = (k: string) => (typeof clean[k] === "string" ? (clean[k] as string) : "");

  if (texto("taxId")) {
    clean.taxId = texto("taxId").toUpperCase();
    if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/.test(clean.taxId as string)) {
      throw new Error("RFC inválido. Formato esperado: XAXX010101000.");
    }
  }
  if (texto("zip") && !/^\d{5}$/.test(texto("zip"))) {
    throw new Error("El código postal debe tener 5 dígitos.");
  }
  if (texto("billingEmail") && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(texto("billingEmail"))) {
    throw new Error("El email de facturación no es válido.");
  }
  // Facturapi espera el país en ISO-3166 alfa-3 ("MEX", "USA").
  if (texto("country")) {
    clean.country = texto("country").toUpperCase();
    if (!/^[A-Z]{3}$/.test(clean.country as string)) {
      throw new Error("El país debe ser el código de 3 letras (MEX, USA…).");
    }
  }

  await setDoc(PRIVADO(id), { fiscal: clean, updatedAt: serverTimestamp() }, { merge: true });
}

/** Precios del cliente. `pricePerRepo: null` = volver al default global. */
export async function setClientBilling(id: string, billing: ClientBilling) {
  const clean: Record<string, unknown> = {};
  if (billing.pricePerRepo !== undefined) {
    if (billing.pricePerRepo === null) clean.pricePerRepo = deleteField();
    else {
      if (!Number.isFinite(billing.pricePerRepo) || billing.pricePerRepo < 0) {
        throw new Error("El costo por repo debe ser un número mayor o igual a 0.");
      }
      clean.pricePerRepo = billing.pricePerRepo;
    }
  }
  if (billing.currency !== undefined) clean.currency = billing.currency;
  // `null` = volver a heredar el día de corte global (antes no había forma de
  // deshacer un día fijado a mano).
  if (billing.billingDay !== undefined) {
    if (billing.billingDay === null) clean.billingDay = deleteField();
    else {
      if (!Number.isInteger(billing.billingDay) || billing.billingDay < 1 || billing.billingDay > 28) {
        throw new Error("El día de corte debe ser un número entero entre 1 y 28.");
      }
      clean.billingDay = billing.billingDay;
    }
  }
  if (billing.discountPct !== undefined) {
    if (billing.discountPct < 0 || billing.discountPct > 100) {
      throw new Error("El descuento debe estar entre 0 y 100.");
    }
    clean.discountPct = billing.discountPct;
  }
  if (billing.taxExempt !== undefined) clean.taxExempt = billing.taxExempt;
  await setDoc(PRIVADO(id), { billing: clean, updatedAt: serverTimestamp() }, { merge: true });
}

/** Features contratadas (avances, publicación de apps) y sus precios extra. */
export async function setClientFeatures(id: string, features: Partial<ClientFeatures>) {
  const clean: Record<string, unknown> = {};
  if (features.showAvances !== undefined) clean.showAvances = features.showAvances;
  if (features.publishApps !== undefined) clean.publishApps = features.publishApps;
  if (features.avancesUrl !== undefined) {
    const url = features.avancesUrl.trim();
    if (url && !/^https?:\/\//.test(url)) {
      throw new Error("El link de avances debe empezar con http:// o https://");
    }
    clean.avancesUrl = url ? url.replace(/\/+$/, "") : deleteField();
  }
  for (const key of ["avancesPrice", "publishAppsPrice"] as const) {
    const v = features[key];
    if (v === undefined) continue;
    if (v === null) clean[key] = deleteField();
    else {
      if (!Number.isFinite(v) || v < 0) throw new Error("Los costos extra deben ser números mayores o iguales a 0.");
      clean[key] = v;
    }
  }
  await setDoc(doc(db, "clients", id), { features: clean, updatedAt: serverTimestamp() }, { merge: true });
}

/** No se borra un cliente con proyectos: primero hay que reasignarlos. */
export async function removeClient(id: string) {
  const asignados = await getDocs(query(collection(db, "projects"), where("clientId", "==", id)));
  if (!asignados.empty) {
    throw new Error(`El cliente tiene ${asignados.size} proyecto(s). Reasígnalos o elimínalos primero.`);
  }
  // Borrar el doc padre no arrastra sus subcolecciones: los datos fiscales
  // quedarían huérfanos en Firestore para siempre. Primero el privado.
  await deleteDoc(PRIVADO(id)).catch(() => {});
  await deleteDoc(doc(db, "clients", id));
}
