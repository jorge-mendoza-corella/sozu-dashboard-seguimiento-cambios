import { deleteField, doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Notificaciones de WhatsApp, POR EMPRESA. Todo o nada: cada empresa manda por
// su propia instancia, con su propia llave, o no se le manda nada.
//
// Dónde vive cada cosa:
//   `clients/{id}/private/notifications`    instancia, webhook y teléfono
//   `clients/{id}/private/whatsappSecret`   apikey                    (read: false)
//
// No hay default global, y esa ausencia es deliberada: un global significa que
// la empresa que todavía no configuró sus avisos los recibe por el número de
// otra —el de quien lo haya puesto ahí—, y que su webhook podría acabar
// llevándose una llave que no es suya. Sin nada que heredar, esos dos problemas
// no existen. Un repo cuyo proyecto no tiene empresa asignada simplemente no
// notifica, y los workflows lo dicen en el log.
//
// La apikey cuelga del propio cliente para que la regla la acote sola, y nunca
// se lee desde el navegador: se escribe y ya. Quien la consume son los
// workflows, con cuenta de servicio. Lo visible aquí es cuándo y quién la dejó.
// ---------------------------------------------------------------------------

const DEL_CLIENTE = (clientId: string) => doc(db, "clients", clientId, "private", "notifications");

/** Doc con la apikey de la empresa. */
const SECRETO = (clientId: string) => doc(db, "clients", clientId, "private", "whatsappSecret");

/** Configuración de WhatsApp de una empresa. */
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
  /**
   * Primeros caracteres de la apikey, para poder mostrarla enmascarada.
   *
   * La llave completa no se puede leer desde el navegador —la regla lo prohíbe—
   * así que sin esta pista la pantalla no tendría NADA que enseñar: solo "hay
   * una guardada". Cuatro caracteres alcanzan para reconocer cuál es y no para
   * reconstruirla.
   */
  apiKeyHint: string | null;
  /** Largo de la apikey, para pintar los asteriscos que faltan. */
  apiKeyLength: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Lo que se puede escribir de la configuración. Vacío = borra el campo. */
export type ClientWhatsappConfig = Partial<Pick<WhatsappConfig, "instance" | "webhookUrl" | "adminPhone" | "enabled">>;

export const EMPTY_WHATSAPP: WhatsappConfig = {
  instance: "",
  webhookUrl: "",
  adminPhone: "",
  enabled: true,
  apiKeySetAt: null,
  apiKeySetBy: null,
  apiKeyHint: null,
  apiKeyLength: null,
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
    apiKeyHint: typeof d.apiKeyHint === "string" ? d.apiKeyHint : null,
    apiKeyLength: typeof d.apiKeyLength === "number" ? d.apiKeyLength : null,
    updatedAt: iso(d.updatedAt),
    updatedBy: typeof d.updatedBy === "string" ? d.updatedBy : null,
  };
}

// --- Lectura ----------------------------------------------------------------

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

/**
 * Apikey enmascarada: los primeros caracteres y el resto en asteriscos. Sin
 * pista guardada (llaves anteriores a este campo) devuelve null y la pantalla
 * se conforma con decir que hay una.
 */
export function maskApiKey(cfg: WhatsappConfig | null): string | null {
  if (!cfg?.apiKeyHint) return null;
  const largo = cfg.apiKeyLength ?? cfg.apiKeyHint.length + 8;
  return cfg.apiKeyHint + "*".repeat(Math.max(4, largo - cfg.apiKeyHint.length));
}

export interface ResolvedWhatsapp {
  instance: string;
  webhookUrl: string;
  adminPhone: string;
  enabled: boolean;
  /** Tiene apikey guardada. No se puede leer: solo consta que existe. */
  apiKeyPropia: boolean;
  /** Le falta algo para poder mandar: instancia, webhook o apikey. */
  incompleta: boolean;
  /** Está completa Y prendida: es lo único que hace que salga un mensaje. */
  puedeEnviar: boolean;
}

/**
 * Qué se usaría de verdad para notificar a esta empresa.
 *
 * Sin default global no hay cascada que resolver: o la empresa tiene sus tres
 * datos, o no se le manda nada. Se conserva la función —en vez de leer los
 * campos sueltos— porque `incompleta` y `puedeEnviar` son la misma cuenta que
 * hacen los workflows, y conviene que se calcule en un solo lugar.
 */
export function resolveWhatsapp(propia: WhatsappConfig | null): ResolvedWhatsapp {
  const instance = propia?.instance.trim() ?? "";
  const webhookUrl = propia?.webhookUrl.trim() ?? "";
  const adminPhone = propia?.adminPhone.trim() ?? "";
  const apiKeyPropia = !!propia?.apiKeySetAt;
  const enabled = propia?.enabled ?? true;
  const incompleta = !instance || !webhookUrl || !apiKeyPropia;
  return {
    instance,
    webhookUrl,
    adminPhone,
    enabled,
    apiKeyPropia,
    incompleta,
    puedeEnviar: !incompleta && enabled,
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
 * pero son **de Sozu**: esa instancia y ese número son suyos.
 */
const CONFIG_HISTORICA_DE_SOZU = {
  instance: "Pruebas de todo",
  webhookUrl: "https://automatizacion-n8n.fbqqbe.easypanel.host/webhook/manda_notificacion",
  adminPhone: "+5217221514185",
};

/** Guarda la configuración (no secreta) de una empresa. */
export async function setClientWhatsapp(clientId: string, patch: ClientWhatsappConfig, email: string) {
  await setDoc(
    DEL_CLIENTE(clientId),
    { ...validar(patch), updatedAt: new Date(), updatedBy: email },
    { merge: true },
  );
}

/**
 * Siembra en la EMPRESA indicada la configuración que los workflows traían
 * cableada. Va al cliente porque es suya: esa instancia y ese número son de
 * Sozu, y ninguna otra empresa debería mandar por ahí.
 *
 * Idempotente y no destructivo: solo llena los campos vacíos. La apikey no se
 * siembra —es un secreto, se captura a mano en Configuración → Notificaciones—.
 */
export async function seedClientWhatsappDefaults(clientId: string, email: string): Promise<boolean> {
  const actual = await getClientWhatsapp(clientId);
  const patch: ClientWhatsappConfig = {};
  if (!actual?.instance.trim()) patch.instance = CONFIG_HISTORICA_DE_SOZU.instance;
  if (!actual?.webhookUrl.trim()) patch.webhookUrl = CONFIG_HISTORICA_DE_SOZU.webhookUrl;
  if (!actual?.adminPhone.trim()) patch.adminPhone = CONFIG_HISTORICA_DE_SOZU.adminPhone;
  if (Object.keys(patch).length === 0) return false;
  await setClientWhatsapp(clientId, patch, email);
  return true;
}

/**
 * Guarda la apikey del webhook de una empresa. Solo se escribe: las reglas
 * prohíben leerla desde el navegador, así que la metadata de "cuándo y quién"
 * va aparte, en el doc de configuración.
 */
export async function setWhatsappApiKey(apiKey: string, email: string, clientId: string) {
  const limpia = apiKey.trim();
  if (!limpia) throw new Error("Pega la apikey del webhook de n8n.");
  if (limpia.length < 8) throw new Error("Esa apikey se ve incompleta; cópiala entera.");
  await setDoc(SECRETO(clientId), { apiKey: limpia, updatedBy: email, updatedAt: new Date() });
  // La pista va en el doc legible, no en el secreto: es lo único de la llave
  // que la pantalla puede volver a mostrar.
  const meta = {
    apiKeySetAt: new Date(),
    apiKeySetBy: email,
    apiKeyHint: limpia.slice(0, 4),
    apiKeyLength: limpia.length,
    updatedAt: new Date(),
    updatedBy: email,
  };
  await setDoc(DEL_CLIENTE(clientId), meta, { merge: true });
}
