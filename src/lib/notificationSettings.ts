import { deleteField, doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Notificaciones de WhatsApp. Hoy los workflows de CI mandan todo por una sola
// instancia de n8n con una sola apikey, hardcodeadas en el YAML: todas las
// empresas comparten el mismo número. Esto lo vuelve configuración por cliente.
//
// Dónde vive cada cosa y por qué:
//   `settings/notifications`                default global (no secreto)
//   `secrets/whatsapp`                      apikey default            (read: false)
//   `clients/{id}/private/notifications`    config de la empresa
//   `clients/{id}/private/whatsappSecret`   apikey de la empresa      (read: false)
//
// La apikey de la empresa cuelga del propio cliente para que la regla la acote
// sola: quien administra ese cliente la puede escribir, sin tener que derivar
// permisos de un id de documento en la colección global de secretos.
//
// La apikey nunca se lee desde el navegador: se escribe y ya. Quien la consume
// son los workflows, que entran a Firestore con cuenta de servicio y se saltan
// las reglas. Lo único visible en el dashboard es cuándo y quién la guardó.
//
// Resolución en cascada, igual que los precios: lo que el cliente tenga puesto
// gana; lo que deje vacío se hereda del default global.
// ---------------------------------------------------------------------------

const GLOBAL = () => doc(db, "settings", "notifications");
const DEL_CLIENTE = (clientId: string) => doc(db, "clients", clientId, "private", "notifications");

/** Doc con la apikey: el del cliente, o el global si no se pasa cliente. */
const SECRETO = (clientId?: string) =>
  clientId
    ? doc(db, "clients", clientId, "private", "whatsappSecret")
    : doc(db, "secrets", "whatsapp");

/** Configuración de WhatsApp, tanto la global como la de una empresa. */
export interface WhatsappConfig {
  /** Nombre de la instancia de WhatsApp en n8n (el `instanciaWA` del payload). */
  instance: string;
  /** Webhook de n8n al que se postea. */
  webhookUrl: string;
  /**
   * Número que recibe los avisos administrativos (PR abierto, PR cerrado).
   * En E.164, con lada: `+5217221514185`. Los teléfonos de los contribuidores
   * NO viven aquí: siguen en `contributors/{login}.telefonoWhatsapp`.
   */
  adminPhone: string;
  /** Apagado = no se manda nada para esa empresa. */
  enabled: boolean;
  apiKeySetAt: string | null;
  apiKeySetBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Lo que una empresa puede sobrescribir. Vacío = hereda el global. */
export type ClientWhatsappConfig = Partial<Pick<WhatsappConfig, "instance" | "webhookUrl" | "adminPhone" | "enabled">>;

export const EMPTY_WHATSAPP: WhatsappConfig = {
  instance: "",
  webhookUrl: "",
  adminPhone: "",
  enabled: true,
  apiKeySetAt: null,
  apiKeySetBy: null,
  updatedAt: null,
  updatedBy: null,
};

const iso = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  const conFecha = v as { toDate?: () => Date } | undefined;
  return conFecha?.toDate ? conFecha.toDate().toISOString() : null;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

function parse(d: Record<string, unknown> | undefined): WhatsappConfig {
  if (!d) return EMPTY_WHATSAPP;
  return {
    instance: str(d.instance),
    webhookUrl: str(d.webhookUrl),
    adminPhone: str(d.adminPhone),
    enabled: d.enabled !== false, // ausente = prendido
    apiKeySetAt: iso(d.apiKeySetAt),
    apiKeySetBy: typeof d.apiKeySetBy === "string" ? d.apiKeySetBy : null,
    updatedAt: iso(d.updatedAt),
    updatedBy: typeof d.updatedBy === "string" ? d.updatedBy : null,
  };
}

// --- Lectura ----------------------------------------------------------------

export async function getGlobalWhatsapp(): Promise<WhatsappConfig> {
  const snap = await getDoc(GLOBAL());
  return parse(snap.exists() ? (snap.data() as Record<string, unknown>) : undefined);
}

/**
 * Config propia de una empresa. Devuelve `null` si nunca se configuró (hereda
 * todo) o si las reglas no dejan leerla.
 */
export async function getClientWhatsapp(clientId: string): Promise<WhatsappConfig | null> {
  try {
    const snap = await getDoc(DEL_CLIENTE(clientId));
    return snap.exists() ? parse(snap.data() as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface ResolvedWhatsapp {
  instance: string;
  webhookUrl: string;
  adminPhone: string;
  enabled: boolean;
  /** Qué campos salieron del default global en lugar de la empresa. */
  heredado: { instance: boolean; webhookUrl: boolean; adminPhone: boolean };
  /** La empresa tiene apikey propia; si no, se usa la global. */
  apiKeyPropia: boolean;
  /** Le falta algo para poder mandar (instancia, webhook o apikey). */
  incompleta: boolean;
  /**
   * Puso webhook propio pero no apikey propia. No se manda nada: sería la llave
   * global viajando a una URL que puso el administrador de esa empresa.
   */
  webhookSinLlave: boolean;
}

/**
 * Config efectiva de una empresa: lo suyo gana, lo vacío se hereda.
 *
 * El webhook y la apikey van EN PAREJA. Si una empresa pone webhook propio y no
 * apikey propia, el envío se bloquea: mandar ahí la llave global la entregaría
 * al dueño de esa URL, que podría usarla para escribir a nombre de cualquier
 * otra empresa. Heredar las dos del global sí es válido.
 */
export function resolveWhatsapp(
  global: WhatsappConfig,
  propia: WhatsappConfig | null,
): ResolvedWhatsapp {
  const pick = (campo: "instance" | "webhookUrl" | "adminPhone") => {
    const mio = propia?.[campo]?.trim();
    return mio ? { valor: mio, heredado: false } : { valor: global[campo].trim(), heredado: true };
  };
  const instance = pick("instance");
  const webhookUrl = pick("webhookUrl");
  const adminPhone = pick("adminPhone");
  const apiKeyPropia = !!propia?.apiKeySetAt;
  const webhookSinLlave = !webhookUrl.heredado && !apiKeyPropia;
  return {
    instance: instance.valor,
    webhookUrl: webhookUrl.valor,
    adminPhone: adminPhone.valor,
    // Apagar la empresa manda; si no dijo nada, manda el global.
    enabled: propia ? propia.enabled && global.enabled : global.enabled,
    heredado: {
      instance: instance.heredado,
      webhookUrl: webhookUrl.heredado,
      adminPhone: adminPhone.heredado,
    },
    apiKeyPropia,
    webhookSinLlave,
    incompleta:
      !instance.valor ||
      !webhookUrl.valor ||
      webhookSinLlave ||
      !(apiKeyPropia || !!global.apiKeySetAt),
  };
}

// --- Escritura --------------------------------------------------------------

const validar = (patch: ClientWhatsappConfig) => {
  const limpio: Record<string, unknown> = {};
  if (patch.instance !== undefined) {
    const v = patch.instance.trim();
    limpio.instance = v || deleteField();
  }
  if (patch.webhookUrl !== undefined) {
    const v = patch.webhookUrl.trim();
    if (v && !/^https:\/\//.test(v)) {
      throw new Error("El webhook debe ser una URL https:// (la apikey viaja en el header).");
    }
    limpio.webhookUrl = v ? v.replace(/\/+$/, "") : deleteField();
  }
  if (patch.adminPhone !== undefined) {
    const v = patch.adminPhone.replace(/[\s()-]/g, "");
    if (v && !/^\+\d{11,15}$/.test(v)) {
      throw new Error("El teléfono debe ir en formato internacional, con lada: +5217221514185.");
    }
    limpio.adminPhone = v || deleteField();
  }
  if (patch.enabled !== undefined) limpio.enabled = patch.enabled;
  return limpio;
};

/**
 * Valores con los que venían cableados los workflows antes de que esto fuera
 * configurable. No son secretos —la URL y el teléfono ya estaban en el YAML—,
 * así que se siembran para que la migración no deje a nadie sin avisos. Lo
 * único que hay que capturar a mano es la apikey.
 */
const DEFAULTS_HISTORICOS = {
  instance: "Pruebas de todo",
  webhookUrl: "https://automatizacion-n8n.fbqqbe.easypanel.host/webhook/manda_notificacion",
  adminPhone: "+5217221514185",
};

/**
 * Deja la configuración global lista con lo que los workflows usaban antes.
 * Idempotente y no destructivo: solo llena los campos que estén vacíos, así que
 * no pisa nada de lo que ya se haya capturado.
 */
export async function seedGlobalWhatsappDefaults(email: string): Promise<boolean> {
  const actual = await getGlobalWhatsapp();
  const patch: ClientWhatsappConfig = {};
  if (!actual.instance.trim()) patch.instance = DEFAULTS_HISTORICOS.instance;
  if (!actual.webhookUrl.trim()) patch.webhookUrl = DEFAULTS_HISTORICOS.webhookUrl;
  if (!actual.adminPhone.trim()) patch.adminPhone = DEFAULTS_HISTORICOS.adminPhone;
  if (Object.keys(patch).length === 0) return false;
  await setGlobalWhatsapp(patch, email);
  return true;
}

export async function setGlobalWhatsapp(patch: ClientWhatsappConfig, email: string) {
  await setDoc(
    GLOBAL(),
    { ...validar(patch), updatedAt: new Date(), updatedBy: email },
    { merge: true },
  );
}

export async function setClientWhatsapp(clientId: string, patch: ClientWhatsappConfig, email: string) {
  await setDoc(
    DEL_CLIENTE(clientId),
    { ...validar(patch), updatedAt: new Date(), updatedBy: email },
    { merge: true },
  );
}

/**
 * Guarda la apikey del webhook. `clientId` undefined = la default global.
 * Solo se escribe: las reglas prohíben leer `secrets/` desde el navegador, así
 * que la metadata de "cuándo se guardó" va aparte, en el doc de config.
 */
export async function setWhatsappApiKey(apiKey: string, email: string, clientId?: string) {
  const limpia = apiKey.trim();
  if (!limpia) throw new Error("Pega la apikey del webhook de n8n.");
  if (limpia.length < 8) throw new Error("Esa apikey se ve incompleta; cópiala entera.");
  await setDoc(SECRETO(clientId), { apiKey: limpia, updatedBy: email, updatedAt: new Date() });
  const meta = { apiKeySetAt: new Date(), apiKeySetBy: email, updatedAt: new Date(), updatedBy: email };
  await setDoc(clientId ? DEL_CLIENTE(clientId) : GLOBAL(), meta, { merge: true });
}

/**
 * Quita la apikey propia de una empresa para que vuelva a usar la global. No
 * borra el secreto (nadie puede leerlo para confirmar qué había): lo sobrescribe
 * vacío y limpia la metadata, que es lo que el workflow consulta.
 */
export async function clearClientWhatsappApiKey(clientId: string, email: string) {
  await setDoc(SECRETO(clientId), { apiKey: "", updatedBy: email, updatedAt: new Date() });
  await setDoc(
    DEL_CLIENTE(clientId),
    { apiKeySetAt: deleteField(), apiKeySetBy: deleteField(), updatedAt: new Date(), updatedBy: email },
    { merge: true },
  );
}
