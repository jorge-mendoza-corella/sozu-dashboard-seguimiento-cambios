/**
 * QR para volver a vincular la instancia de WhatsApp (Evolution API) de una
 * empresa desde el badge rojo del dashboard, sin entrar al manager de Evolution.
 *
 * La apikey nunca sale del servidor: se resuelve igual que el monitor
 * (`ci/whatsapp_status_sync.py`): URL de la empresa o la global; llave global o
 * la de la empresa (`clients/{id}/private/whatsappSecret`, que el navegador no
 * puede leer).
 *
 * Cada llamada primero pregunta el estado. Si ya está conectada, lo deja en
 * `whatsappStatus/{clientId}` para que el badge se ponga verde de inmediato (sin
 * esperar al monitor) y no pide QR: pedirlo con la sesión abierta no sirve de nada.
 */
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";

export interface RespuestaQr {
  conectado: boolean;
  /** data:image/png;base64,... */
  qr: string | null;
  pairingCode: string | null;
  detalle: string | null;
}

/**
 * Mismo criterio que las reglas: superuser, o administrador de ESA empresa con
 * permiso de configurarla (`configuraCliente`). Login de Google verificado.
 */
async function verificarPermiso(req: CallableRequest, clientId: string): Promise<void> {
  const t = req.auth?.token;
  if (!t?.email) throw new HttpsError("unauthenticated", "Inicia sesión.");
  if (t.email_verified !== true || t.firebase?.sign_in_provider !== "google.com") {
    throw new HttpsError("permission-denied", "Se requiere sesión de Google con correo verificado.");
  }
  const p = (await getFirestore().doc(`users/${t.email.toLowerCase()}`).get()).data()
    ?? (await getFirestore().doc(`users/${t.email}`).get()).data();
  if (!p) throw new HttpsError("permission-denied", "Tu usuario no está registrado en el dashboard.");
  if (p.role === "superuser") return;
  const lista = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const configurables = Array.isArray(p.configClientIds) ? lista(p.configClientIds) : lista(p.adminClientIds);
  if (p.role === "client_admin" && lista(p.clientIds).includes(clientId) && configurables.includes(clientId)) return;
  throw new HttpsError("permission-denied", "No puedes reconectar el WhatsApp de esta empresa.");
}

/** Token de la cuenta de servicio de la función (servidor de metadatos). */
async function tokenServicio(): Promise<string | null> {
  try {
    const r = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
    );
    return r.ok ? ((await r.json()) as { access_token: string }).access_token : null;
  } catch {
    return null;
  }
}

/**
 * Secretos globales del monitor (Secret Manager de sozu-admin-dev). Se leen en
 * tiempo de ejecución y no con `defineSecret`: si no existen, el deploy de TODAS
 * las funciones fallaría, y aquí son solo el respaldo de la config por empresa.
 */
export async function secretoGlobal(nombre: string): Promise<string> {
  const token = await tokenServicio();
  const proyecto = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT ?? "sozu-admin-dev";
  if (!token) return "";
  try {
    const r = await fetch(
      `https://secretmanager.googleapis.com/v1/projects/${proyecto}/secrets/${nombre}/versions/latest:access`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r.ok) return "";
    const j = (await r.json()) as { payload?: { data?: string } };
    return j.payload?.data ? Buffer.from(j.payload.data, "base64").toString("utf8").trim() : "";
  } catch {
    return "";
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

async function evolucion(url: string, key: string, ruta: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${url.replace(/\/+$/, "")}${ruta}`, {
    headers: { apikey: key },
    signal: AbortSignal.timeout(20_000),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await r.json()) as Record<string, unknown>;
  } catch {
    // Respuesta vacía o no JSON: se reporta por el status.
  }
  return { status: r.status, json };
}

function errorEvolution(status: number, instancia: string): HttpsError {
  if (status === 401 || status === 403) return new HttpsError("failed-precondition", "Evolution API rechazó la llave (apikey inválida).");
  if (status === 404) return new HttpsError("not-found", `La instancia "${instancia}" no existe en Evolution API.`);
  return new HttpsError("unavailable", `Evolution API respondió ${status}.`);
}

export async function qrWhatsapp(req: CallableRequest<{ clientId?: string }>): Promise<RespuestaQr> {
  const clientId = str(req.data?.clientId);
  if (!clientId || clientId.length > 200 || clientId.includes("/")) {
    throw new HttpsError("invalid-argument", "Empresa inválida.");
  }
  await verificarPermiso(req, clientId);

  const fs = getFirestore();
  const [cfgSnap, secretoSnap] = await Promise.all([
    fs.doc(`clients/${clientId}/private/notifications`).get(),
    fs.doc(`clients/${clientId}/private/whatsappSecret`).get(),
  ]);
  const cfg = cfgSnap.data() ?? {};
  const instancia = str(cfg.instance);
  if (!instancia) throw new HttpsError("failed-precondition", "La empresa no tiene instancia de WhatsApp configurada.");

  const url = str(cfg.evolutionUrl) || (await secretoGlobal("EVOLUTION_URL"));
  const key = (await secretoGlobal("EVOLUTION_API_KEY")) || str(secretoSnap.data()?.apiKey);
  if (!url || !key) {
    throw new HttpsError("failed-precondition", `Falta configurar ${!url ? "la URL" : "la apikey"} de Evolution API.`);
  }

  const ruta = encodeURIComponent(instancia);
  let estado;
  try {
    estado = await evolucion(url, key, `/instance/connectionState/${ruta}`);
  } catch {
    throw new HttpsError("unavailable", "No se pudo contactar a Evolution API.");
  }
  if (estado.status !== 200) throw errorEvolution(estado.status, instancia);
  const inst = (estado.json.instance ?? {}) as Record<string, unknown>;
  const crudo = (str(inst.state) || str(estado.json.state)).toLowerCase();

  if (crudo === "open") {
    const ref = fs.doc(`whatsappStatus/${clientId}`);
    const previo = (await ref.get()).data();
    const ahora = Timestamp.now();
    await ref.set(
      {
        estado: "conectado",
        detalle: "",
        desde: previo?.estado === "conectado" && previo.desde ? previo.desde : ahora,
        revisadoAt: ahora,
        ultimaConexion: ahora,
      },
      { merge: true },
    );
    return { conectado: true, qr: null, pairingCode: null, detalle: null };
  }

  let conexion;
  try {
    conexion = await evolucion(url, key, `/instance/connect/${ruta}`);
  } catch {
    throw new HttpsError("unavailable", "No se pudo contactar a Evolution API.");
  }
  if (conexion.status !== 200) throw errorEvolution(conexion.status, instancia);
  // v2: { base64, code, pairingCode, count }; v1: { base64, code } o { qrcode: { base64 } }.
  const qrcode = (conexion.json.qrcode ?? {}) as Record<string, unknown>;
  const base64 = str(conexion.json.base64) || str(qrcode.base64);
  const qr = base64 ? (base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`) : null;
  return {
    conectado: false,
    qr,
    pairingCode: str(conexion.json.pairingCode) || str(qrcode.pairingCode) || null,
    detalle: qr ? null : "Evolution no devolvió un código QR. Se reintenta en unos segundos.",
  };
}
