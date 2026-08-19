import { deleteDoc, deleteField, doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import type { Client } from "./firestoreClients";

// ---------------------------------------------------------------------------
// White label: cada empresa ve la herramienta con SU marca.
//
// La marca vive en el doc RAÍZ del cliente (`clients/{id}.branding`), no en el
// privado: la lee cualquiera que pertenezca a esa empresa, que es justo quien
// necesita ver su logo en la barra. Nada de aquí es secreto.
//
// El color de marca se aplica pisando las variables CSS de shadcn (`--primary`,
// `--ring`), que están en HSL: por eso se convierte el hex a triplete y el
// foreground se calcula por luminancia, para que el texto encima del botón siga
// siendo legible cuando la marca es un color claro.
//
// La pantalla de login es el caso especial: ahí todavía no hay usuario, así que
// no se sabe de qué empresa es quien entra. Para eso el root publica la marca
// por dominio en `public_branding/{hostname}`, la única colección con lectura
// abierta — y por eso solo lleva nombre, logo y color.
// ---------------------------------------------------------------------------

export interface ClientBranding {
  /** Nombre del producto para esa empresa ("Vectis Tracker"). */
  appName?: string;
  /** Logo: URL https pública, o data URI para quien no tiene dónde subirlo. */
  logoUrl?: string;
  /** Icono de la pestaña. Si no hay, se usa el logo. */
  faviconUrl?: string;
  /** Color de marca en hex (#0ea5e9). Pisa el primario de toda la interfaz. */
  primaryColor?: string;
  /** Frase corta bajo el nombre, en el login. */
  tagline?: string;
  /** Esconder la firma del proveedor en el pie. */
  hideVendorBrand?: boolean;
}

/** Marca del proveedor: la que ve el equipo interno y quien no tiene propia. */
export const VENDOR_BRANDING: ClientBranding & { appName: string } = {
  appName: "Tracker Cambios",
  tagline: "Seguimiento de cambios y despliegues",
};

/**
 * Firma que se deja al pie cuando la herramienta va con la marca de un cliente.
 * Es una frase aparte del nombre del producto a propósito: el cliente ve su
 * propia marca arriba, y abajo quién la construyó, no otro nombre de producto
 * que compita con el suyo.
 */
export const VENDOR_SIGNATURE = "Powered by Yorch";

/** Tope del logo embebido: un doc de Firestore no puede pasar de 1 MB. */
const MAX_LOGO_BYTES = 200 * 1024;

/**
 * Fuentes de imagen aceptadas para logo y favicon. Se usa al guardar Y al
 * renderizar: un valor escrito por fuera del dashboard (consola, REST, Admin
 * SDK) no debe llegar nunca a un `src` sin pasar por aquí.
 */
export const esUrlDeImagen = (v: string) =>
  /^https:\/\//i.test(v) || /^data:image\/(png|jpeg|webp|svg\+xml);base64,/i.test(v);

// --- Color -------------------------------------------------------------------

/** "#0ea" → "00eeaa". null si no es un hex de 3 o 6 dígitos. */
function expandirHex(hex: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  return m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
}

/** #0ea5e9 → "199 89% 48%", el formato que esperan las variables de shadcn. */
export function hexToHslTriplet(hex: string): string | null {
  const crudo = expandirHex(hex);
  if (!crudo) return null;
  const r = parseInt(crudo.slice(0, 2), 16) / 255;
  const g = parseInt(crudo.slice(2, 4), 16) / 255;
  const b = parseInt(crudo.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const redondo = (n: number) => Math.round(n * 10) / 10;
  return `${redondo(h)} ${redondo(s * 100)}% ${redondo(l * 100)}%`;
}

/** Luminancia relativa WCAG de un hex ya expandido a 6 dígitos. */
function luminancia(crudo: string): number {
  const canal = (i: number) => {
    const v = parseInt(crudo.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * canal(0) + 0.7152 * canal(2) + 0.0722 * canal(4);
}

const contraste = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Luminancia del token oscuro de shadcn (hsl(222.2 47.4% 11.2%)). */
const L_OSCURO = 0.0097;
const FG_CLARO = "0 0% 100%";
const FG_OSCURO = "222.2 47.4% 11.2%";

/**
 * Color de texto que se lee encima de la marca.
 *
 * Se comparan los DOS candidatos por razón de contraste y gana el mayor. Antes
 * se comparaba la luminancia contra un umbral fijo, y todo color medio —un verde
 * #22c55e, por ejemplo— se quedaba con texto blanco a 2.4:1, muy por debajo del
 * 4.5:1 que exige WCAG.
 */
export function foregroundForHex(hex: string): string {
  const crudo = expandirHex(hex);
  if (!crudo) return FG_CLARO;
  const L = luminancia(crudo);
  return contraste(L, 1) >= contraste(L, L_OSCURO) ? FG_CLARO : FG_OSCURO;
}

/**
 * Triplete del color de marca **acotado para usarse en la interfaz**.
 *
 * `--primary` no solo pinta fondos de botón: Tailwind también lo usa como color
 * de TEXTO (`text-primary` en el nombre del header, los links del nav). Una marca
 * casi blanca dejaría esos textos invisibles sobre el fondo, y ahí
 * `foregroundForHex` no interviene porque no hay fondo de marca que corregir.
 * Por eso la luminosidad se recorta a un rango legible; el tono y la saturación
 * de la marca se conservan intactos.
 */
export function brandTriplet(hex: string): string | null {
  const base = hexToHslTriplet(hex);
  if (!base) return null;
  const [h, s, l] = base.split(" ");
  const lNum = parseFloat(l);
  const acotada = Math.min(62, Math.max(25, lNum));
  return `${h} ${s} ${acotada}%`;
}

// --- Resolución --------------------------------------------------------------

export interface ResolvedBranding {
  appName: string;
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor?: string;
  tagline?: string;
  hideVendorBrand: boolean;
  /** Empresa de la que salió la marca; null = la del proveedor. */
  clientId: string | null;
  clientName: string | null;
}

export const VENDOR_RESOLVED: ResolvedBranding = {
  appName: VENDOR_BRANDING.appName,
  tagline: VENDOR_BRANDING.tagline,
  hideVendorBrand: false,
  clientId: null,
  clientName: null,
};

/**
 * Lee un campo de texto del documento sin confiar en su tipo.
 *
 * El tipo de TypeScript describe lo que el dashboard escribe, no lo que hay en
 * Firestore: el doc lo puede escribir cualquiera con consola o REST, y un
 * `appName: 5` reventaba el render con un TypeError —pantalla en blanco para
 * todos los usuarios de ese tenant, y también para el admin global, que pinta
 * todas las empresas juntas en Configuración—.
 */
const texto = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const limpio = v.trim();
  return limpio ? limpio.slice(0, max) : undefined;
};

/** Imagen del documento, solo si además es una fuente aceptada. */
const imagen = (v: unknown): string | undefined => {
  const t = texto(v, MAX_LOGO_BYTES);
  return t && esUrlDeImagen(t) ? t : undefined;
};

/**
 * Marca a aplicar.
 *
 * Manda la EMPRESA SELECCIONADA en la barra de Resumen/CI/CD: elegir una empresa
 * es decir "estoy trabajando en esta", y la marca la sigue. Sin selección, la
 * marca es la del proveedor salvo que el usuario vea una sola empresa, donde no
 * hay ambigüedad posible.
 *
 * Antes bastaba con que UNA de sus empresas tuviera marca configurada para
 * pintarla: alguien con Vectis y Sozu veía la marca de Sozu por el solo hecho de
 * que Vectis todavía no tenía la suya, y eso se lee como "estoy en Sozu".
 *
 * `esAdminGlobal` no cambia nada por sí solo: el equipo interno ve la marca del
 * proveedor hasta que elige una empresa a propósito.
 */
export function resolveBranding(
  clients: Client[],
  esAdminGlobal = false,
  empresaSeleccionada: string | null = null,
): ResolvedBranding {
  const elegida = empresaSeleccionada
    ? clients.find((x) => x.id === empresaSeleccionada)
    : undefined;
  // Sin selección: solo se adopta una marca cuando el usuario ve exactamente una
  // empresa; con varias, cuál sería es una adivinanza.
  const unica = !esAdminGlobal && clients.length === 1 ? clients[0] : undefined;
  const c = elegida ?? unica;
  if (!c?.branding || Object.keys(c.branding).length === 0) return VENDOR_RESOLVED;
  const b = c.branding as Record<string, unknown>;
  const logoUrl = imagen(b.logoUrl);
  const color = texto(b.primaryColor, 9);
  return {
    appName: texto(b.appName, 40) ?? VENDOR_BRANDING.appName,
    logoUrl,
    faviconUrl: imagen(b.faviconUrl) ?? logoUrl,
    // Un color inválido se descarta aquí: si llegara al CSS, dejaría la interfaz
    // con el primario a medio aplicar.
    primaryColor: color && hexToHslTriplet(color) ? color : undefined,
    tagline: texto(b.tagline, 90),
    hideVendorBrand: b.hideVendorBrand === true,
    clientId: c.id,
    clientName: c.tradeName?.trim() || c.legalName,
  };
}

// --- Escritura ---------------------------------------------------------------

/**
 * Guarda la marca de una empresa. Escribe SOLO la llave `branding` del doc: las
 * reglas dejan que el administrador de esa empresa toque su marca, y nada más
 * de su documento.
 */
export async function setClientBranding(clientId: string, branding: ClientBranding) {
  const clean: Record<string, unknown> = {};

  if (branding.appName !== undefined) {
    const v = branding.appName.trim();
    if (v.length > 40) throw new Error("El nombre no puede pasar de 40 caracteres.");
    clean.appName = v || deleteField();
  }
  if (branding.tagline !== undefined) {
    const v = branding.tagline.trim();
    if (v.length > 90) throw new Error("La frase no puede pasar de 90 caracteres.");
    clean.tagline = v || deleteField();
  }
  for (const campo of ["logoUrl", "faviconUrl"] as const) {
    const valor = branding[campo];
    if (valor === undefined) continue;
    const v = valor.trim();
    if (!v) {
      clean[campo] = deleteField();
      continue;
    }
    if (!esUrlDeImagen(v)) {
      throw new Error(
        "El logo debe ser una URL https:// de imagen, o un archivo PNG/JPG/WebP/SVG cargado aquí.",
      );
    }
    if (v.length > MAX_LOGO_BYTES) {
      throw new Error("La imagen pesa demasiado (máximo 200 KB). Súbela a un hosting y pega su URL.");
    }
    clean[campo] = v;
  }
  if (branding.primaryColor !== undefined) {
    const v = branding.primaryColor.trim();
    if (!v) clean.primaryColor = deleteField();
    else {
      if (!hexToHslTriplet(v)) throw new Error("El color debe ir en hex, por ejemplo #0ea5e9.");
      clean.primaryColor = (v.startsWith("#") ? v : `#${v}`).toLowerCase();
    }
  }
  if (branding.hideVendorBrand !== undefined) clean.hideVendorBrand = branding.hideVendorBrand;

  await setDoc(doc(db, "clients", clientId), { branding: clean }, { merge: true });
}

// --- Marca por dominio (pantalla de login) -----------------------------------

export interface PublicBranding {
  appName: string;
  logoUrl?: string;
  primaryColor?: string;
  tagline?: string;
  clientId?: string;
}

/**
 * Marca del dominio por el que se entra, para pintar el login antes de que haya
 * sesión. Es lectura pública, así que solo trae nombre, logo y color. Cualquier
 * fallo devuelve null y el login se queda con la marca del proveedor.
 */
export async function getPublicBranding(hostname: string): Promise<PublicBranding | null> {
  const id = hostname.trim().toLowerCase();
  if (!id) return null;
  try {
    const snap = await getDoc(doc(db, "public_branding", id));
    if (!snap.exists()) return null;
    const d = snap.data() as Record<string, unknown>;
    const texto = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return {
      appName: texto(d.appName) ?? VENDOR_BRANDING.appName,
      logoUrl: texto(d.logoUrl),
      primaryColor: texto(d.primaryColor),
      tagline: texto(d.tagline),
      clientId: texto(d.clientId),
    };
  } catch {
    return null;
  }
}

/**
 * Publica la marca de un dominio (o la borra, con `branding` null). Solo el
 * root: es quien sabe qué dominio es de qué empresa, y este doc lo lee
 * cualquiera sin autenticarse.
 */
export async function setPublicBranding(
  hostname: string,
  branding: PublicBranding | null,
  email: string,
) {
  const id = hostname.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(id)) {
    throw new Error("Dominio inválido. Usa solo el host, por ejemplo tracker.vectis.mx.");
  }
  const ref = doc(db, "public_branding", id);
  if (!branding) {
    // Borrado de verdad: si solo se vaciaran los campos, el doc seguiría
    // existiendo y `getPublicBranding` devolvería un objeto con el nombre del
    // proveedor, así que el login se quedaba sin su frase y la configuración
    // seguía diciendo que el dominio tenía marca publicada.
    await deleteDoc(ref);
    return;
  }
  await setDoc(ref, { ...branding, updatedBy: email, updatedAt: new Date() }, { merge: true });
}
