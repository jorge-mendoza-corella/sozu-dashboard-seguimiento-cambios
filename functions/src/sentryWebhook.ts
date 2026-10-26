/**
 * Avisos de Sentry por WhatsApp.
 *
 * Sentry (Internal Integration de la org `sozu-lh`) llama a esta función cuando
 * se dispara una regla de alerta: issue nuevo, regresión (`event_alert`) o pico
 * de errores (`metric_alert`). Aquí se valida la firma, se descarta todo lo que
 * no sea de producción y se manda el WhatsApp por n8n con la MISMA resolución
 * que `ci/whatsapp.py` (la que usan los avisos de PRs y de builds):
 *
 *   sentry/{slug}.sentryProjectId           → qué proyecto de Sentry es
 *   repos (repo == slug).projectId         → proyecto del dashboard
 *   projects/{id}.clientId                 → empresa
 *   clients/{id}/private/notifications     → instance, webhookUrl, enabled
 *   clients/{id}/private/whatsappSecret    → apiKey
 *
 * Destinatarios, igual que allá: el APROBADOR del proyecto y los admins
 * globales suscritos a todos los repos (`avisaDeTodosLosRepos`). Los teléfonos
 * salen de Contribuidores.
 *
 * Silencio de 6 h por issue (`sentryAvisos/{clave}`): una regla de Sentry puede
 * volver a dispararse con cada evento, y el WhatsApp no es para eso.
 *
 * El client secret de la integración vive en Secret Manager
 * (`SENTRY_WEBHOOK_SECRET`) y se lee en tiempo de ejecución, como los de
 * whatsapp.ts: con `defineSecret` el deploy de TODAS las funciones fallaría
 * mientras el secreto no exista.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { secretoGlobal } from "./whatsapp.js";

const SILENCIO_MS = 6 * 60 * 60_000;
const INTENTOS = 3;
const ENTORNO = "production";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** HMAC-SHA256 del cuerpo crudo con el client secret, en hex (`sentry-hook-signature`). */
export function firmaValida(cuerpo: Buffer, firma: string, secreto: string): boolean {
  if (!firma || !secreto) return false;
  const esperada = createHmac("sha256", secreto).update(cuerpo).digest("hex");
  const a = Buffer.from(esperada, "utf8");
  const b = Buffer.from(firma, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Teléfonos (normalizar_telefono / enmascarar de ci/whatsapp.py) -----------

export function normalizarTelefono(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const limpio = String(valor).trim().replace(/[\s()\-.]/g, "");
  if (limpio.startsWith("+")) {
    const d = limpio.slice(1);
    return /^\d{8,15}$/.test(d) ? `+${d}` : null;
  }
  return /^\d{10}$/.test(limpio) ? `+521${limpio}` : null;
}

const enmascarar = (t: string | null) => {
  const d = (t ?? "").replace(/\D/g, "");
  return d.length >= 4 ? `···${d.slice(-4)}` : "···";
};

// --- Configuración de la empresa (resolve_for_project) -------------------------

interface ConfigWa {
  puedeEnviar: boolean;
  motivo: string;
  instance: string;
  webhook: string;
  apikey: string;
}

async function configDelProyecto(fs: Firestore, projectId: string): Promise<ConfigWa> {
  const clientId = str((await fs.doc(`projects/${projectId}`).get()).data()?.clientId);
  const cfg: ConfigWa = { puedeEnviar: false, motivo: "", instance: "", webhook: "", apikey: "" };
  if (!clientId) {
    cfg.motivo = `El proyecto '${projectId}' no tiene empresa asignada.`;
    return cfg;
  }
  const [n, s] = await Promise.all([
    fs.doc(`clients/${clientId}/private/notifications`).get(),
    fs.doc(`clients/${clientId}/private/whatsappSecret`).get(),
  ]);
  const c = n.data() ?? {};
  cfg.instance = str(c.instance);
  cfg.webhook = str(c.webhookUrl);
  cfg.apikey = str(s.data()?.apiKey);
  if (c.enabled === false) {
    cfg.motivo = `La empresa '${clientId}' tiene apagadas las notificaciones de WhatsApp.`;
    return cfg;
  }
  const faltan = ([["instancia", cfg.instance], ["webhook", cfg.webhook], ["apikey", cfg.apikey]] as const)
    .filter(([, v]) => !v).map(([k]) => k);
  if (faltan.length) {
    cfg.motivo = `La empresa '${clientId}' no tiene ${faltan.join(" ni ")} de WhatsApp.`;
    return cfg;
  }
  cfg.puedeEnviar = true;
  return cfg;
}

async function telefonoDeLogin(fs: Firestore, login: string): Promise<string | null> {
  if (!login) return null;
  return normalizarTelefono(str((await fs.doc(`contributors/${login}`).get()).data()?.telefonoWhatsapp));
}

/** approver_phone + global_admin_phones de ci/whatsapp.py, sin duplicados. */
async function destinatarios(fs: Firestore, projectId: string): Promise<string[]> {
  const tels = new Set<string>();
  const correo = str((await fs.doc(`projects/${projectId}`).get()).data()?.approverEmail);
  if (correo) {
    const login = str((await fs.doc(`users/${correo}`).get()).data()?.githubLogin);
    const t = await telefonoDeLogin(fs, login);
    if (t) tels.add(t);
    else console.log(`[sentryWebhook] el aprobador ${correo} no tiene teléfono utilizable en Contribuidores`);
  } else {
    console.log(`[sentryWebhook] el proyecto '${projectId}' no tiene aprobador configurado`);
  }
  const suscritos = await fs.collection("users")
    .where("avisaDeTodosLosRepos", "==", true).where("role", "==", "superuser").get();
  for (const d of suscritos.docs) {
    const t = await telefonoDeLogin(fs, str(d.data().githubLogin));
    if (t) tels.add(t);
  }
  return [...tels];
}

// --- Envío (send de ci/whatsapp.py) -------------------------------------------

/** n8n contesta 200 aunque el mensaje no salga: el fallo viaja en el cuerpo. */
function fallaEnElCuerpo(texto: string): string | null {
  let cuerpo: unknown;
  try {
    cuerpo = JSON.parse(texto);
  } catch {
    return null;
  }
  if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo)) return null;
  const c = cuerpo as Record<string, unknown>;
  if (c.datos_validos === false) return String(c.error_validacion || "n8n rechazó los datos").slice(0, 200);
  let error = c.error;
  if (!error) return null;
  if (typeof error === "object") error = (error as Record<string, unknown>).message ?? error;
  return String(typeof error === "string" ? error : JSON.stringify(error)).slice(0, 200);
}

async function enviar(cfg: ConfigWa, telefono: string, mensaje: string): Promise<boolean> {
  let ultimo = "";
  for (let intento = 1; intento <= INTENTOS; intento++) {
    try {
      const r = await fetch(cfg.webhook, {
        method: "POST",
        headers: { apikey: cfg.apikey, "Content-Type": "application/json" },
        body: JSON.stringify({ tipo: "wa", telefono, mensajeWA: mensaje, instanciaWA: cfg.instance }),
        signal: AbortSignal.timeout(20_000),
      });
      const texto = await r.text();
      if (r.ok) {
        const falla = fallaEnElCuerpo(texto);
        if (!falla) return true;
        ultimo = `HTTP ${r.status} pero n8n reportó: ${falla}`;
      } else {
        ultimo = `HTTP ${r.status} ${texto.slice(0, 200)}`;
      }
    } catch (e) {
      ultimo = e instanceof Error ? e.message : String(e);
    }
    if (intento < INTENTOS) await new Promise((ok) => setTimeout(ok, intento * 5_000));
  }
  console.error(`[sentryWebhook] no se pudo avisar a ${enmascarar(telefono)}: ${ultimo}`);
  return false;
}

// --- Payloads de Sentry --------------------------------------------------------

interface Aviso {
  /** Llave del silencio de 6 h. */
  clave: string;
  slug: string;
  mensaje: string;
}

async function slugDeProyectoSentry(fs: Firestore, id: unknown): Promise<string> {
  const pid = String(id ?? "");
  if (!pid) return "";
  const q = await fs.collection("sentry").where("sentryProjectId", "==", pid).limit(1).get();
  return q.empty ? "" : q.docs[0].id;
}

/** El aviso a mandar, o el motivo por el que no se manda nada. */
async function leerAviso(fs: Firestore, recurso: string, body: Record<string, unknown>): Promise<Aviso | string> {
  const data = (body.data ?? {}) as Record<string, unknown>;

  if (recurso === "event_alert") {
    const ev = (data.event ?? {}) as Record<string, unknown>;
    if (str(ev.environment) !== ENTORNO) return `entorno '${str(ev.environment)}' ignorado`;
    const slug = await slugDeProyectoSentry(fs, ev.project);
    if (!slug) return `proyecto de Sentry ${String(ev.project)} sin sync`;
    const regla = str(data.triggered_rule);
    const url = str(ev.web_url) || str(ev.issue_url);
    return {
      clave: `issue-${String(ev.issue_id ?? ev.event_id ?? "")}`,
      slug,
      mensaje: `🚨 ${slug} (producción)${regla ? ` · ${regla}` : ""}: ${str(ev.title) || "error nuevo"}`
        + (str(ev.culprit) ? ` — en ${str(ev.culprit)}` : "")
        + (url ? `. Detalle: ${url}` : ""),
    };
  }

  if (recurso === "metric_alert") {
    const accion = str(body.action);
    if (accion !== "critical" && accion !== "warning") return `metric_alert '${accion}' ignorado`;
    const ma = (data.metric_alert ?? {}) as Record<string, unknown>;
    const regla = (ma.alert_rule ?? {}) as Record<string, unknown>;
    if (str(regla.environment) !== ENTORNO) return `entorno '${str(regla.environment)}' ignorado`;
    const slug = Array.isArray(regla.projects) ? str(regla.projects[0]) : "";
    if (!slug) return "metric_alert sin proyecto";
    const url = str(data.web_url);
    return {
      clave: `metric-${String(ma.id ?? regla.id ?? "")}-${accion}`,
      slug,
      mensaje: `${accion === "critical" ? "🔥" : "⚠️"} ${slug} (producción): ${str(data.description_title) || str(regla.name)}`
        + (str(data.description_text) ? ` — ${str(data.description_text)}` : "")
        + (url ? `. Detalle: ${url}` : ""),
    };
  }

  return `recurso '${recurso}' ignorado`;
}

/** Reserva el aviso si pasaron 6 h desde el último de esa clave. */
async function reservar(fs: Firestore, clave: string): Promise<boolean> {
  const ref = fs.doc(`sentryAvisos/${clave.replace(/\//g, "_")}`);
  return fs.runTransaction(async (tx) => {
    const previo = (await tx.get(ref)).data()?.ultimoAviso as Timestamp | undefined;
    if (previo && Date.now() - previo.toMillis() < SILENCIO_MS) return false;
    tx.set(ref, { ultimoAviso: Timestamp.now() }, { merge: true });
    return true;
  });
}

export async function sentryWebhook(req: Request, res: Response): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).send("POST");
    return;
  }
  const secreto = await secretoGlobal("SENTRY_WEBHOOK_SECRET");
  if (!firmaValida(req.rawBody, String(req.get("sentry-hook-signature") ?? ""), secreto)) {
    res.status(401).send("firma inválida");
    return;
  }

  const fs = getFirestore();
  const recurso = String(req.get("sentry-hook-resource") ?? "");
  const aviso = await leerAviso(fs, recurso, (req.body ?? {}) as Record<string, unknown>);
  // Sentry reintenta lo que no contesta 2xx: lo que se descarta a propósito
  // también es un 200.
  if (typeof aviso === "string") {
    res.status(200).send(aviso);
    return;
  }

  const repo = await fs.collection("repos").where("repo", "==", aviso.slug).limit(1).get();
  const projectId = repo.empty ? "" : str(repo.docs[0].data().projectId);
  if (!projectId) {
    console.log(`[sentryWebhook] ${aviso.slug} no corresponde a ningún repo del dashboard`);
    res.status(200).send("sin repo");
    return;
  }
  const cfg = await configDelProyecto(fs, projectId);
  if (!cfg.puedeEnviar) {
    console.log(`[sentryWebhook] ${aviso.slug}: ${cfg.motivo}`);
    res.status(200).send("sin configuración");
    return;
  }
  const tels = await destinatarios(fs, projectId);
  if (tels.length === 0) {
    res.status(200).send("sin destinatarios");
    return;
  }
  if (!(await reservar(fs, aviso.clave))) {
    res.status(200).send("en silencio");
    return;
  }

  const enviados = await Promise.all(tels.map((t) => enviar(cfg, t, aviso.mensaje)));
  // Si no salió ninguno se libera la reserva: el siguiente disparo lo reintenta.
  if (!enviados.some(Boolean)) {
    await fs.doc(`sentryAvisos/${aviso.clave.replace(/\//g, "_")}`).delete();
    res.status(502).send("no se pudo avisar");
    return;
  }
  console.log(`[sentryWebhook] ${aviso.clave} → ${tels.map(enmascarar).join(", ")}`);
  res.status(200).send("ok");
}
