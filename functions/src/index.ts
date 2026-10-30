/**
 * Cloud Functions del dashboard.
 *
 * `agenteRepos`: agente que responde sobre los repos de SOZU (técnico y manual
 * de usuario) con la documentación de sozu-docs y el código de GitHub. Mismo
 * patrón que la Guía del portal de sozu-admin (`ia-guia-portal`): catálogo
 * cerrado de herramientas de solo lectura, historial guardado por el backend y
 * gate de permiso en el servidor; aquí con Firebase Auth en lugar de Supabase.
 *
 * Es un callable con streaming: manda trozos `{tipo: "texto" | "herramienta"}`
 * mientras trabaja y al final devuelve la respuesta completa ya guardada.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { consumirCupo, reposPermitidos, verificarAcceso } from "./agente/acceso.js";
import { docPorRuta, indiceDocs, limpiarRuta, obtenerCorpus } from "./agente/docs.js";
import { describirLlamada, ejecutar, HERRAMIENTAS } from "./agente/herramientas.js";
import { bloqueDocs, bloqueRepos, INSTRUCCIONES } from "./agente/instrucciones.js";
import { cerrarRelacionados, cerrarTicket, clienteSupabase, ticketsAsignados, ticketsResueltos, tomarTicket } from "./agente/tickets.js";
import { desligarTicket, grupoDeRelacionados, relacionadosConDashboard, relacionarTicket } from "./agente/relaciones.js";
import { destinatarios, iniciarAviso, marcarEntregado, responderAviso, terminarAviso } from "./agente/avisos.js";
import { agregarPrManual, buscarPrsExternos, buscarPrsPorTexto, notaConPrs, verificarPrsExternos } from "./agente/prsExternos.js";
import { mandarAClaude, ORQUESTADOR } from "./agente/mandar.js";
import { issueDelTicket, responderAClaude, seguimientoClaude, type AdjuntoRespuesta } from "./agente/claude.js";
import { abrirSubida } from "./agente/adjuntos.js";
import { contenidoUsuario, recortarImagenes, validarAdjuntosChat, type AdjuntoChat } from "./agente/adjuntosChat.js";
import { procesarAdjunto } from "./agente/procesarAdjunto.js";
import { abrirConsola, ErrorConsola, finConsola, lineaConsola, sesionConsola } from "./agente/consola.js";
import { qrWhatsapp } from "./whatsapp.js";
import { falloDocs } from "./docsFallo.js";
import { sentryWebhook as atenderSentry } from "./sentryWebhook.js";
import { cambiarEstado, crearTicketIssue, detalleIssue, issuesDeTicket, resolverIssuesDeTicket, resolverPorTicketsCerrados, sentryDeTickets, type Estado } from "./sentryIssues.js";
import {
  conectarToken, desconectarToken, exigirTokenClaude, leerTokenClaude, llavePublica, marcarTokenRenovado, secretDe,
} from "./agente/tokenClaude.js";

initializeApp();

const ANTHROPIC_API_KEY = defineSecret("AGENTE_ANTHROPIC_API_KEY");
// Los mismos PATs que ya usa el front (Secret Manager de sozu-admin-dev):
// el principal lee los repos monitoreados; el de docs, sozu-docs.
const GITHUB_TOKEN = defineSecret("DASHBOARD_GITHUB_TOKEN");
const GITHUB_DOCS_TOKEN = defineSecret("DASHBOARD_GITHUB_DOCS_TOKEN");
// Service role del Supabase de PRODUCCIÓN de sozu-admin: solo para leer los
// tickets asignados a quien pregunta (ver agente/tickets.ts).
const SUPABASE_SERVICE_KEY = defineSecret("AGENTE_SUPABASE_SERVICE_KEY");

// Sonnet: responde bien preguntas de docs y código y cuesta varias veces menos que Opus.
const MODELO = "claude-sonnet-5-5";
const MAX_MENSAJE = 4_000;
/** Turnos previos (pregunta + respuesta) que se mandan como contexto. */
const MAX_HISTORIAL = 20;
/** Vueltas del loop de herramientas antes de forzar el cierre. */
const MAX_ITERACIONES = 16;
const MAX_TITULO = 80;

export type ChunkAgente =
  | { tipo: "texto"; delta: string }
  | { tipo: "herramienta"; nombre: string; etiqueta: string };

interface Entrada {
  conversacionId?: string | null;
  mensaje: string;
  adjuntos?: AdjuntoChat[];
}

export const agenteRepos = onCall<Entrada, Promise<unknown>, ChunkAgente>(
  {
    region: "us-central1",
    secrets: [ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_DOCS_TOKEN],
    timeoutSeconds: 540,
    memory: "1GiB",
    maxInstances: 5,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req, res) => {
    const usuario = await verificarAcceso(req);
    const adjuntos = validarAdjuntosChat(req.data?.adjuntos, usuario.email);
    const mensaje = typeof req.data?.mensaje === "string" ? req.data.mensaje.trim() : "";
    if ((!mensaje && adjuntos.length === 0) || mensaje.length > MAX_MENSAJE) {
      throw new HttpsError("invalid-argument", `El mensaje debe tener entre 1 y ${MAX_MENSAJE} caracteres.`);
    }
    const restantes = await consumirCupo(usuario);

    const db = getFirestore();
    const conversaciones = db.collection("agente_conversaciones");

    // ── Conversación: la existente (si es suya) o una nueva ────────────────
    let convRef = conversaciones.doc();
    let nueva = true;
    if (req.data.conversacionId) {
      const ref = conversaciones.doc(String(req.data.conversacionId));
      const snap = await ref.get();
      if (!snap.exists || snap.data()?.owner !== usuario.email) {
        throw new HttpsError("not-found", "La conversación no existe.");
      }
      convRef = ref;
      nueva = false;
    }
    const mensajesRef = convRef.collection("mensajes");

    // Historial como texto plano: preguntas y respuestas finales. Las llamadas
    // a herramientas de turnos anteriores no se reenvían (el modelo vuelve a
    // consultar lo que necesite) y las respuestas con error tampoco.
    const historial: Anthropic.Beta.BetaMessageParam[] = [];
    if (!nueva) {
      const previos = await mensajesRef.orderBy("creado", "desc").limit(MAX_HISTORIAL * 2).get();
      for (const d of previos.docs.reverse()) {
        const m = d.data();
        if (m.error || typeof m.texto !== "string") continue;
        const adj = Array.isArray(m.adjuntos) ? (m.adjuntos as AdjuntoChat[]) : [];
        if (!m.texto.trim() && adj.length === 0) continue;
        historial.push(
          m.rol === "asistente"
            ? { role: "assistant", content: m.texto }
            : { role: "user", content: contenidoUsuario(m.texto, adj) },
        );
      }
      // El primer mensaje mandado a la API tiene que ser del usuario.
      while (historial[0]?.role === "assistant") historial.shift();
    }

    const ahora = FieldValue.serverTimestamp();
    if (nueva) {
      await convRef.set({
        owner: usuario.email,
        titulo: (mensaje || `Adjunto: ${adjuntos[0].nombre}`).replace(/\s+/g, " ").slice(0, MAX_TITULO),
        fijada: false,
        creado: ahora,
        actualizado: ahora,
      });
    }
    await mensajesRef.add({ rol: "usuario", texto: mensaje, ...(adjuntos.length ? { adjuntos } : {}), creado: ahora });

    // ── Contexto: docs + repos del usuario ─────────────────────────────────
    const ghCodigo = new Octokit({ auth: GITHUB_TOKEN.value(), userAgent: "sozu-dashboard-agente" });
    const ghDocs = GITHUB_DOCS_TOKEN.value()
      ? new Octokit({ auth: GITHUB_DOCS_TOKEN.value(), userAgent: "sozu-dashboard-agente" })
      : ghCodigo;
    const [corpus, repos] = await Promise.all([obtenerCorpus(ghDocs), reposPermitidos(usuario)]);

    const system: Anthropic.Beta.BetaTextBlockParam[] = [
      { type: "text", text: INSTRUCCIONES },
      { type: "text", text: bloqueDocs(indiceDocs(corpus), corpus.sha) },
      { type: "text", text: bloqueRepos(repos), cache_control: { type: "ephemeral" } },
    ];

    const fecha = new Date().toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", dateStyle: "full" });
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...historial,
      { role: "user", content: contenidoUsuario(`[Hoy es ${fecha}. Pregunta de ${usuario.email}]\n\n${mensaje}`, adjuntos) },
    ];
    // Imágenes de turnos viejos: solo las últimas MAX_IMAGENES (las anteriores
    // quedan como texto con su nombre) para no inflar cada vuelta.
    recortarImagenes(messages);

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    const ctx = { ghDocs, ghCodigo, repos };
    const herramientasUsadas: { nombre: string; etiqueta: string }[] = [];
    // Documentos que el agente abrió con leer_doc: se guardan con la respuesta
    // para que el panel los ofrezca como enlaces (si la persona tiene permiso).
    const docsLeidos = new Set<string>();
    const textos: string[] = [];
    const uso = { input: 0, output: 0, cacheLectura: 0, cacheEscritura: 0 };
    let modeloFinal = MODELO;
    let reintentosJson = 0;

    try {
      for (let vuelta = 0; vuelta < MAX_ITERACIONES; vuelta++) {
        const ultima = vuelta === MAX_ITERACIONES - 1;
        const stream = client.beta.messages.stream({
          model: MODELO,
          max_tokens: 32_000,
          system,
          tools: HERRAMIENTAS,
          // En la última vuelta se cierra sin herramientas: mejor una respuesta
          // con lo que ya se encontró que cortar sin nada.
          ...(ultima ? { tool_choice: { type: "none" as const } } : {}),
          messages,
          output_config: { effort: "medium" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });
        let textoVuelta = "";
        stream.on("text", (delta) => {
          textoVuelta += delta;
          void res?.sendChunk({ tipo: "texto", delta });
        });

        let respuesta: Anthropic.Beta.BetaMessage;
        try {
          respuesta = await stream.finalMessage();
          reintentosJson = 0;
        } catch (e) {
          // Solo se reintenta un tool input que no se pudo parsear; los errores
          // de la API suben tal cual.
          if (e instanceof Anthropic.APIError || reintentosJson++ >= 2) throw e;
          console.warn("[agenteRepos] tool input sin JSON válido; se repite la vuelta");
          vuelta--;
          continue;
        }

        modeloFinal = respuesta.model;
        uso.input += respuesta.usage.input_tokens;
        uso.output += respuesta.usage.output_tokens;
        uso.cacheLectura += respuesta.usage.cache_read_input_tokens ?? 0;
        uso.cacheEscritura += respuesta.usage.cache_creation_input_tokens ?? 0;
        if (textoVuelta.trim()) textos.push(textoVuelta.trim());

        if (respuesta.stop_reason === "refusal") {
          textos.push("_No puedo ayudar con esa solicitud._");
          break;
        }
        if (respuesta.stop_reason === "pause_turn") {
          messages.push({ role: "assistant", content: respuesta.content });
          continue;
        }
        const usos = respuesta.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (usos.length === 0) break;
        if (respuesta.stop_reason === "max_tokens") {
          throw new Error("tool input truncado por max_tokens");
        }

        messages.push({ role: "assistant", content: respuesta.content });
        for (const u of usos) {
          const ruta = (u.input as { ruta?: unknown })?.ruta;
          if (u.name === "leer_doc" && typeof ruta === "string" && docPorRuta(corpus, ruta)) {
            docsLeidos.add(limpiarRuta(ruta));
          }
          const etiqueta = describirLlamada(u.name, u.input);
          herramientasUsadas.push({ nombre: u.name, etiqueta });
          void res?.sendChunk({ tipo: "herramienta", nombre: u.name, etiqueta });
        }
        // En paralelo, y todos los resultados en un solo mensaje de usuario.
        const resultados = await Promise.all(
          usos.map(async (u): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
            const r = await ejecutar(u.name, u.input, ctx);
            return { type: "tool_result", tool_use_id: u.id, content: r.texto, ...(r.esError ? { is_error: true } : {}) };
          }),
        );
        messages.push({ role: "user", content: resultados });
      }
    } catch (e) {
      console.error("[agenteRepos] error del modelo", e);
      await mensajesRef.add({ rol: "asistente", texto: "", error: true, creado: FieldValue.serverTimestamp() });
      if (e instanceof Anthropic.RateLimitError) {
        throw new HttpsError("resource-exhausted", "El modelo está saturado; intenta en un minuto.");
      }
      throw new HttpsError("unavailable", "No se pudo completar la respuesta. Intenta de nuevo.");
    }

    const texto = textos.join("\n\n") || "_No obtuve una respuesta. Intenta reformular la pregunta._";
    const msgRef = await mensajesRef.add({
      rol: "asistente",
      texto,
      herramientas: herramientasUsadas,
      docs: [...docsLeidos],
      modelo: modeloFinal,
      uso,
      creado: FieldValue.serverTimestamp(),
    });
    await convRef.update({ actualizado: FieldValue.serverTimestamp() });

    return {
      conversacionId: convRef.id,
      mensajeId: msgRef.id,
      texto,
      herramientas: herramientasUsadas,
      docs: [...docsLeidos],
      restantes,
    };
  },
);

/**
 * `agenteDoc`: entrega un documento de sozu-docs completo para el visor del
 * panel. Pide el permiso "Ver documentación" (`agente_config/acceso.docs`);
 * sin él, el panel muestra el nombre del documento pero no lo deja abrir, y
 * esta función es la que lo hace valer (el repo de docs es privado).
 */
export const agenteDoc = onCall<{ ruta: string }>(
  {
    region: "us-central1",
    secrets: [GITHUB_TOKEN, GITHUB_DOCS_TOKEN],
    timeoutSeconds: 60,
    memory: "512MiB",
    maxInstances: 5,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req) => {
    await verificarAcceso(req, "docs");
    const ruta = typeof req.data?.ruta === "string" ? req.data.ruta : "";
    if (!ruta || ruta.length > 300) throw new HttpsError("invalid-argument", "Ruta inválida.");
    const ghDocs = new Octokit({ auth: GITHUB_DOCS_TOKEN.value() || GITHUB_TOKEN.value(), userAgent: "sozu-dashboard-agente" });
    const corpus = await obtenerCorpus(ghDocs);
    const doc = docPorRuta(corpus, ruta);
    if (!doc) throw new HttpsError("not-found", "Ese documento no existe en sozu-docs.");
    return { ruta: doc.ruta, titulo: doc.titulo, texto: doc.texto, sha: corpus.sha.slice(0, 7) };
  },
);

/**
 * `agenteTickets`: tickets pendientes del portal de sozu-admin asignados a
 * quien está logueado. Requiere el permiso "Revisar tickets". El panel lo
 * llama cada 15 min; si hay, el personaje grita. Con `vista: "resueltos"`,
 * los ya cerrados (pestaña Resueltos, solo lectura).
 */
export const agenteTickets = onCall(
  {
    region: "us-central1",
    secrets: [SUPABASE_SERVICE_KEY],
    timeoutSeconds: 60,
    memory: "512MiB",
    maxInstances: 5,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req) => {
    const usuario = await verificarAcceso(req, "tickets");
    try {
      const sb = clienteSupabase(SUPABASE_SERVICE_KEY.value());
      const tickets = (req.data as { vista?: string } | undefined)?.vista === "resueltos"
        ? await ticketsResueltos(sb, usuario.email)
        : await ticketsAsignados(sb, usuario.email);
      const ids = tickets.map((t) => Number(t.id));
      // Issue de Sentry ligado (ticket levantado desde Monitoreo) y tickets
      // relacionados («¿Ya lo había reportado antes?»). Si fallan, los tickets
      // salen igual, sin eso.
      const [deSentry, relacionados, grupos] = await Promise.all([
        sentryDeTickets(ids).catch(() => new Map()),
        relacionadosConDashboard(sb, ids).catch(() => new Map()),
        // El grupo completo (relacionados de relacionados): lo que se cierra en cascada.
        grupoDeRelacionados(sb, ids).catch(() => new Map()),
      ]);
      return {
        tickets: tickets.map((t) => ({
          ...t,
          sentry: deSentry.get(Number(t.id)) ?? null,
          relacionados: relacionados.get(Number(t.id)) ?? [],
          grupo: grupos.get(Number(t.id)) ?? [],
        })),
        revisado: new Date().toISOString(),
      };
    } catch (e) {
      console.error("[agenteTickets]", e);
      throw new HttpsError("unavailable", "No se pudieron leer los tickets del portal.");
    }
  },
);

/**
 * `agenteMandarAClaude`: abre en el repo orquestador un issue con el .md del
 * ticket; Claude Code (suscripción, en GitHub Actions) lo trabaja y abre PRs
 * hacia `dev`. Reemplaza al análisis por API (`agenteAnalizarTicket`), que
 * costaba en cada ticket: Claude Code ya investiga por su cuenta. Solo tickets
 * asignados a quien lo manda. Ver agente/mandar.ts.
 */
export const agenteMandarAClaude = onCall<{ ticketId: string; md: string }>(
  {
    region: "us-central1",
    secrets: [GITHUB_TOKEN, SUPABASE_SERVICE_KEY],
    timeoutSeconds: 60,
    memory: "512MiB",
    maxInstances: 5,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req) => {
    const usuario = await verificarAcceso(req, "claude");
    const ticketId = String(req.data?.ticketId ?? "");
    const md = typeof req.data?.md === "string" ? req.data.md : "";
    if (!/^\d+$/.test(ticketId)) throw new HttpsError("invalid-argument", "Ticket inválido.");
    if (!md.trim()) throw new HttpsError("invalid-argument", "El .md del ticket viene vacío.");
    await exigirTokenClaude(usuario.email, usuario.esRoot);
    const sb = clienteSupabase(SUPABASE_SERVICE_KEY.value());
    const tickets = await ticketsAsignados(sb, usuario.email);
    const t = tickets.find((x) => x.id === ticketId);
    if (!t) throw new HttpsError("not-found", "Ese ticket no está entre tus pendientes.");
    const repos = await reposPermitidos(usuario);
    let issue;
    try {
      const gh = new Octokit({ auth: GITHUB_TOKEN.value(), userAgent: "sozu-dashboard-agente" });
      issue = await mandarAClaude(gh, usuario.email, t, md, repos, secretDe(usuario.email, usuario.esRoot));
    } catch (e) {
      console.error("[agenteMandarAClaude]", e);
      throw new HttpsError("unavailable", `No se pudo abrir el issue en ${ORQUESTADOR.owner}/${ORQUESTADOR.repo}.`);
    }
    // Mandarlo es tomarlo («Yo trabajo el ticket»): pasa a En atención y deja de verse para
    // los demás asignados. El issue ya está abierto: si falla, no se tumba el envío.
    const nombre = (t.asignados.find((a) => a.soyYo)?.nombre ?? "").split(" ")[0] || usuario.email;
    await tomarTicket(sb, usuario.email, Number(ticketId), `${nombre} estará atendiendo el ticket con Claude Code.`)
      .catch((e) => console.error("[agenteMandarAClaude] tomar ticket", e));
    return issue;
  },
);

/**
 * `agenteClaudeSeguimiento`: en qué va Claude Code con un ticket mandado (estado,
 * avance del checklist, conversación y PRs). Solo el de quien lo mandó.
 */
export const agenteClaudeSeguimiento = onCall<{ ticketId: string; forzarPrs?: boolean }>(
  {
    region: "us-central1",
    secrets: [GITHUB_TOKEN],
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 5,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req) => {
    const usuario = await verificarAcceso(req, "tickets");
    const ticketId = String(req.data?.ticketId ?? "");
    if (!/^\d+$/.test(ticketId)) throw new HttpsError("invalid-argument", "Ticket inválido.");
    const issue = await issueDelTicket(usuario.email, ticketId);
    try {
      const gh = new Octokit({ auth: GITHUB_TOKEN.value(), userAgent: "sozu-dashboard-agente" });
      return await seguimientoClaude(gh, issue, { email: usuario.email, ticketId, forzarPrs: req.data?.forzarPrs === true });
    } catch (e) {
      console.error("[agenteClaudeSeguimiento]", e);
      throw new HttpsError("unavailable", "No se pudo leer el avance en GitHub.");
    }
  },
);

/**
 * `agenteClaudeToken`: el token de Claude con el que corren los tickets de quien
 * llama. `accion`:
 *   - "leer" (default): si está conectado y cuándo vence (para avisar antes).
 *   - "llave": llave pública del orquestador, para cifrar el token en el navegador.
 *   - "conectar": guarda el token YA CIFRADO como secret propio (nunca llega en claro).
 *   - "desconectar": borra su secret.
 *   - "renovado": solo el root; marca el token compartido como recién renovado.
 */
export const agenteClaudeToken = onCall<{ accion?: string; keyId?: string; cifrado?: string }>(
  {
    region: "us-central1",
    secrets: [GITHUB_TOKEN],
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 5,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req) => {
    const usuario = await verificarAcceso(req, "tickets");
    const accion = req.data?.accion ?? "leer";
    // Conectar o renovar el token solo tiene caso para quien manda a Claude.
    if (accion !== "leer" && accion !== "desconectar" && !usuario.mandaClaude) {
      throw new HttpsError("permission-denied", "No tienes permiso para mandar tickets a Claude.");
    }
    const gh = () => new Octokit({ auth: GITHUB_TOKEN.value(), userAgent: "sozu-dashboard-agente" });
    try {
      if (accion === "leer") return await leerTokenClaude(usuario.email, usuario.esRoot);
      if (accion === "renovado") {
        if (!usuario.esRoot) throw new HttpsError("permission-denied", "Solo el administrador renueva el token compartido.");
        return await marcarTokenRenovado(usuario.email);
      }
      // El root usa el token compartido (también lo usan los docs): no se conecta aquí.
      if (usuario.esRoot) throw new HttpsError("failed-precondition", "Tu token es el compartido: renuévalo con el comando del aviso.");
      if (accion === "llave") return await llavePublica(gh());
      if (accion === "conectar") return await conectarToken(gh(), usuario.email, String(req.data?.keyId ?? ""), String(req.data?.cifrado ?? ""));
      if (accion === "desconectar") return await desconectarToken(gh(), usuario.email);
      throw new HttpsError("invalid-argument", "Acción inválida.");
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("[agenteClaudeToken]", e);
      throw new HttpsError("unavailable", "No se pudo guardar en GitHub. Intenta de nuevo.");
    }
  },
);

/**
 * `agenteClaudeResponder`: contesta a Claude desde el dashboard (comentario con
 * @claude en el issue, que dispara otra corrida sobre la misma rama y PR).
 */
export const agenteClaudeResponder = onCall<{ ticketId: string; texto: string; adjuntos?: AdjuntoRespuesta[] }>(
  {
    region: "us-central1",
    secrets: [GITHUB_TOKEN],
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 5,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req) => {
    const usuario = await verificarAcceso(req, "claude");
    const ticketId = String(req.data?.ticketId ?? "");
    if (!/^\d+$/.test(ticketId)) throw new HttpsError("invalid-argument", "Ticket inválido.");
    const issue = await issueDelTicket(usuario.email, ticketId);
    await exigirTokenClaude(usuario.email, usuario.esRoot);
    const gh = new Octokit({ auth: GITHUB_TOKEN.value(), userAgent: "sozu-dashboard-agente" });
    try {
      const adjuntos = Array.isArray(req.data?.adjuntos) ? req.data.adjuntos : [];
      await responderAClaude(gh, usuario.email, issue.numero, String(req.data?.texto ?? ""), adjuntos);
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("[agenteClaudeResponder]", e);
      throw new HttpsError("unavailable", "No se pudo mandar la respuesta a GitHub.");
    }
    return { ok: true };
  },
);

/**
 * `agenteSubirAdjunto`: abre la subida de una imagen, video, audio o documento
 * para la respuesta a Claude (solo tickets que la persona mandó) o, con ticketId
 * "chat", para una pregunta a GeorgIA. Ver agente/adjuntos.ts.
 */
export const agenteSubirAdjunto = onCall<{ ticketId: string; nombre: string; tipo: string; tamano: number }>(
  {
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 5,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req) => {
    const ticketId = String(req.data?.ticketId ?? "");
    const esChat = ticketId === "chat";
    const usuario = await verificarAcceso(req, esChat ? "agente" : "tickets");
    if (!esChat) {
      if (!/^\d+$/.test(ticketId)) throw new HttpsError("invalid-argument", "Ticket inválido.");
      await issueDelTicket(usuario.email, ticketId);
    }
    const origen = req.rawRequest.headers.origin;
    return abrirSubida(
      usuario.email, ticketId, String(req.data?.nombre ?? "archivo"), String(req.data?.tipo ?? ""), Number(req.data?.tamano),
      typeof origen === "string" ? origen : undefined,
    );
  },
);

/**
 * `agenteClaudeLog`: la corrida de Claude Code en GitHub Actions manda aquí lo
 * que va haciendo (consola en vivo del panel). Callable y no onRequest: una
 * función HTTP nueva pide permiso de IAM para hacerla pública, que la cuenta de
 * deploy no tiene. El runner la llama sin sesión (POST {"data": {...}}); la
 * autenticación va en el cuerpo (OIDC de GitHub o la llave). Ver agente/consola.ts.
 */
export const agenteClaudeLog = onCall<{ accion: string; issue: number; jwt?: string; llave?: string; texto?: string; tipo?: string; repo?: string }>(
  { region: "us-central1", timeoutSeconds: 30, memory: "256MiB", maxInstances: 10 },
  async (req) => {
    const b = req.data ?? ({} as Record<string, unknown>);
    const issue = Number(b.issue);
    try {
      if (!Number.isInteger(issue) || issue <= 0) throw new ErrorConsola(400, "issue inválido");
      if (b.accion === "abrir") return await abrirConsola(String(b.jwt ?? ""), issue);
      const llave = String(b.llave ?? "");
      if (b.accion === "linea") await lineaConsola(issue, llave, String(b.texto ?? ""), String(b.tipo ?? ""), String(b.repo ?? ""));
      else if (b.accion === "sesion") await sesionConsola(issue, llave, String(b.texto ?? ""));
      else if (b.accion === "fin") await finConsola(issue, llave);
      else throw new ErrorConsola(400, "accion inválida");
      return { ok: true };
    } catch (e) {
      if (e instanceof ErrorConsola) {
        throw new HttpsError(e.status === 401 ? "unauthenticated" : e.status === 403 ? "permission-denied" : e.status === 404 ? "not-found" : "invalid-argument", e.message);
      }
      console.error("[agenteClaudeLog]", e);
      throw new HttpsError("internal", "interno");
    }
  },
);

/**
 * `agenteBuscarPrsTicket`: PRs de un ticket que se trabajó por fuera del
 * dashboard (convención `SOZU-N` / rama `ticket-N` / trailer `Ticket-SOZU: #N`,
 * ver agente/prsExternos.ts), con en qué va cada uno. Solo tickets asignados a
 * quien pregunta. Para cerrarlo desde aquí eligiendo qué PRs lo resolvieron.
 * Con `agregar` (o `quitar`) y la URL de un PR, lo liga a mano al ticket: para
 * los que no traen nada que los relacione. Con `texto`, busca PRs fusionados de
 * Sozu por título o descripción (vacío: los de la última semana).
 */
export const agenteBuscarPrsTicket = onCall<{ ticketId: string; forzar?: boolean; agregar?: string; quitar?: string; texto?: string; autor?: string; desde?: string; hasta?: string }>(
  {
    region: "us-central1",
    secrets: [GITHUB_TOKEN, SUPABASE_SERVICE_KEY],
    timeoutSeconds: 120,
    memory: "512MiB",
    maxInstances: 5,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req) => {
    const usuario = await verificarAcceso(req, "tickets");
    const ticketId = String(req.data?.ticketId ?? "");
    if (!/^\d+$/.test(ticketId)) throw new HttpsError("invalid-argument", "Ticket inválido.");
    const t = (await ticketsAsignados(clienteSupabase(SUPABASE_SERVICE_KEY.value()), usuario.email)).find((x) => x.id === ticketId);
    if (!t) throw new HttpsError("not-found", "Ese ticket no está entre tus pendientes.");
    try {
      const gh = new Octokit({ auth: GITHUB_TOKEN.value(), userAgent: "sozu-dashboard-agente" });
      const agregar = typeof req.data?.agregar === "string" ? req.data.agregar : "";
      const quitar = typeof req.data?.quitar === "string" ? req.data.quitar : "";
      if (agregar || quitar) return await agregarPrManual(gh, usuario.email, t, agregar || quitar, !!quitar);
      // Buscar en el historial por texto (título o descripción) para agregarlos a mano.
      if (typeof req.data?.texto === "string") {
        const { autor, desde, hasta } = req.data;
        return { historial: await buscarPrsPorTexto(gh, req.data.texto, { autor, desde, hasta }) };
      }
      return await buscarPrsExternos(gh, usuario.email, t, req.data?.forzar === true);
    } catch (e) {
      const conocidos: Record<string, string> = {
        pr_url: "Pega la URL del PR, como https://github.com/dueño/repo/pull/123.",
        pr_ajeno: "Ese PR no es de un repo de Sozu.",
        pr_no_existe: "No encontré ese PR en GitHub.",
      };
      const m = (e as Error).message;
      if (conocidos[m]) throw new HttpsError("failed-precondition", conocidos[m]);
      console.error("[agenteBuscarPrsTicket]", e);
      throw new HttpsError("unavailable", "No se pudieron buscar los PRs en GitHub.");
    }
  },
);

/**
 * `agenteCerrarTicket`: pasa el ticket a la etapa resuelta de su pipeline y deja la
 * nota de seguimiento (lo que se actualizó, por repo y PR). Solo tickets de Sistemas
 * asignados a quien cierra; la nota queda a su nombre en el portal.
 *
 * Trabajado por fuera (sin issue de Claude ni PRs registrados): se cierra con los
 * PRs que eligió quien cierra (`prsSeleccionados`), re-verificados aquí contra la
 * convención del folio y ya mergeados a main. Quedan en el registro (`prs`,
 * `origen: "externo"`) y en la nota del portal.
 */
export const agenteCerrarTicket = onCall<{ ticketId: string; nota: string; prsSeleccionados?: string[] }>(
  {
    region: "us-central1",
    secrets: [SUPABASE_SERVICE_KEY, GITHUB_TOKEN],
    timeoutSeconds: 120,
    memory: "512MiB",
    maxInstances: 5,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req) => {
    const usuario = await verificarAcceso(req, "tickets");
    const ticketId = String(req.data?.ticketId ?? "");
    let nota = typeof req.data?.nota === "string" ? req.data.nota : "";
    const seleccionados = Array.isArray(req.data?.prsSeleccionados)
      ? req.data.prsSeleccionados.filter((u): u is string => typeof u === "string")
      : [];
    if (!/^\d+$/.test(ticketId)) throw new HttpsError("invalid-argument", "Ticket inválido.");
    if (!nota.trim()) throw new HttpsError("invalid-argument", "La nota de seguimiento no puede ir vacía.");
    const ref = getFirestore().doc(`agente_tickets_enviados/${usuario.email}__${ticketId}`);
    const enviado = (await ref.get()).data();
    const sb = clienteSupabase(SUPABASE_SERVICE_KEY.value());
    // Trabajado por fuera: ni issue de Claude ni PRs con el trailer ya en PRD.
    const externo = !enviado?.issue && !(Array.isArray(enviado?.prs) && enviado.prs.length > 0);
    // Claude terminó sin abrir PRs (el arreglo ya estaba): se cierra igual, con
    // los PRs que lo habían resuelto si quien cierra los encontró y eligió.
    const sinCambios = !!enviado?.issue && enviado.sinCambios === true && enviado.listoParaCerrar !== true;
    let registroExterno: Record<string, unknown> | null = null;
    // Ya listo (sus PRs en PRD) y quien cierra sumó otros: se verifican igual y se agregan.
    const listoConOtros = !externo && !sinCambios && enviado?.listoParaCerrar === true && seleccionados.length > 0;
    if (externo || listoConOtros || (sinCambios && seleccionados.length > 0)) {
      if (!seleccionados.length) {
        throw new HttpsError("failed-precondition", "Elige al menos un PR que haya cerrado este ticket (busca sus PRs primero).");
      }
      const t = (await ticketsAsignados(sb, usuario.email)).find((x) => x.id === ticketId);
      if (!t) throw new HttpsError("not-found", "Ese ticket no está entre tus pendientes.");
      let prs;
      try {
        const gh = new Octokit({ auth: GITHUB_TOKEN.value(), userAgent: "sozu-dashboard-agente" });
        const manuales = Array.isArray(enviado?.prsManuales) ? enviado.prsManuales.filter((u: unknown): u is string => typeof u === "string") : [];
        prs = await verificarPrsExternos(gh, t.numero, seleccionados, manuales);
      } catch (e) {
        const m = (e as Error).message;
        const [codigo, url] = m.split(/:(.+)/);
        const motivos: Record<string, string> = {
          pr_ajeno: "no es de un repo de Sozu",
          pr_no_es_del_ticket: `no trae SOZU-${t.numero}, la rama ticket-${t.numero} ni el trailer Ticket-SOZU: #${t.numero} (agrégalo a mano)`,
          pr_sin_prd: "todavía no llega a PRD (el ticket se cierra cuando todo lo marcado está en producción)",
        };
        if (motivos[codigo]) throw new HttpsError("failed-precondition", `El PR ${url} ${motivos[codigo]}.`);
        console.error("[agenteCerrarTicket] verificar PRs", e);
        throw new HttpsError("unavailable", "No se pudieron verificar los PRs en GitHub.");
      }
      const sinEnPrd = prs.map((p) => ({ repo: p.repo, pr: p.pr, url: p.url, cambios: p.cambios }));
      // Con los que ya tenía (listo): la nota y el registro llevan todos, sin repetir.
      const previos = listoConOtros && Array.isArray(enviado?.prs) ? (enviado.prs as { repo: string; pr: number; url: string; cambios: string[] }[]) : [];
      const todos = [...previos, ...sinEnPrd.filter((p) => !previos.some((x) => x.url === p.url))];
      nota = notaConPrs(nota, todos);
      registroExterno = {
        owner: usuario.email, ticketId, numero: t.numero, folio: t.folio, titulo: t.titulo,
        prs: todos, listoParaCerrar: true,
        ...(listoConOtros ? {} : { origen: sinCambios ? "claude_sin_cambios" : "externo" }),
      };
    // Mandado a Claude: todos sus PRs en PRD. Copiado a mano: algún PR con el trailer en PRD.
    } else if (!sinCambios && (enviado?.issue ? enviado.listoParaCerrar !== true : !Array.isArray(enviado?.prs) || enviado.prs.length === 0)) {
      // Solo se cierra desde aquí lo que ya llegó a PRD por un PR hacia main ligado al ticket.
      throw new HttpsError("failed-precondition", "Todavía no están en PRD todos los PRs de este ticket; ciérralo cuando lleguen.");
    }
    // Issues de Sentry ligados (ticket levantado desde Monitoreo): la nota los
    // menciona y se resuelven en cuanto el ticket queda cerrado.
    const deSentry = await issuesDeTicket(Number(ticketId)).catch(() => []);
    const abiertos = deSentry.filter((i) => i.abierto).map((i) => i.shortId);
    // Relacionados abiertos («¿Ya lo había reportado antes?»): se cierran con
    // este, y la nota lo dice. Todo el grupo, no solo los directos.
    const relacionados = ((await grupoDeRelacionados(sb, [Number(ticketId)]).catch(() => new Map())).get(Number(ticketId)) ?? [])
      .filter((r: { cerrado: boolean; sePuedeCerrar: boolean }) => !r.cerrado && r.sePuedeCerrar);
    if (relacionados.length) {
      nota = `${nota.trimEnd()}\n\nSe cierra${relacionados.length === 1 ? "" : "n"} también ${relacionados.length === 1 ? "el ticket relacionado" : "los tickets relacionados"} ${relacionados.map((r: { folio: string }) => r.folio).join(", ")}.`;
    }
    if (abiertos.length) {
      nota = `${nota.trimEnd()}\n\nSentry: ${abiertos.join(", ")} se ${abiertos.length === 1 ? "marca" : "marcan"} como resuelto${abiertos.length === 1 ? "" : "s"} al cerrar este ticket.`;
    }
    try {
      const r = await cerrarTicket(sb, usuario.email, Number(ticketId), nota);
      await ref.set({ ...registroExterno, cerrado: true, cerradoEn: FieldValue.serverTimestamp() }, { merge: true });
      const folio = String(enviado?.folio ?? `#${ticketId}`);
      const sentryResueltos = await resolverIssuesDeTicket(deSentry, folio).catch(() => []);
      const enCascada = relacionados.length
        ? await cerrarRelacionados(sb, usuario.email, relacionados, folio).catch(() => ({ cerrados: [], fallidos: relacionados.map((x: { folio: string }) => x.folio) }))
        : { cerrados: [], fallidos: [] };
      return { ok: true, etapa: r.etapa, sentryResueltos, relacionadosCerrados: enCascada.cerrados, relacionadosFallidos: enCascada.fallidos };
    } catch (e) {
      const m = (e as Error).message;
      const conocidos: Record<string, string> = {
        no_es_tuyo: "Ese ticket no está asignado a ti.",
        no_existe: "Ese ticket ya no existe.",
        pipeline_no_permitido: "Solo se cierran tickets de los pipelines con el asistente prendido.",
        sin_etapa_resuelta: "El pipeline de ese ticket no tiene etapa de resuelto.",
        sin_usuario_portal: "Tu correo no tiene usuario en el portal de tickets.",
      };
      if (conocidos[m]) throw new HttpsError("failed-precondition", conocidos[m]);
      console.error("[agenteCerrarTicket]", e);
      throw new HttpsError("unavailable", "No se pudo cerrar el ticket en el portal.");
    }
  },
);

/**
 * `agenteMegafono`: Avisos, conversaciones 1 a 1 que el avatar de quien manda
 * va a gritar a la pantalla del otro. Abrir una (`accion` "iniciar", por
 * defecto) y ver a quién se le puede mandar ("destinatarios") pide el permiso
 * «Avisos»; contestar, marcar entregado y terminar solo pide ser parte de la
 * conversación. Ver agente/avisos.ts.
 */
export const agenteMegafono = onCall<{ accion?: string; id?: string; msgId?: string; texto?: string; audio?: string; para?: string[]; skin?: string; voz?: boolean }>(
  {
    region: "us-central1",
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 5,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req) => {
    const accion = req.data?.accion ?? "iniciar";
    const datos = req.data ?? {};
    if (accion === "destinatarios" || accion === "iniciar") {
      const usuario = await verificarAcceso(req, "megafono");
      if (accion === "destinatarios") return { destinatarios: await destinatarios() };
      return iniciarAviso(usuario.email, datos);
    }
    const usuario = await verificarAcceso(req, "agente");
    if (accion === "responder") return responderAviso(usuario.email, datos);
    if (accion === "entregado") return marcarEntregado(usuario.email, datos);
    if (accion === "terminar") return terminarAviso(usuario.email, datos);
    throw new HttpsError("invalid-argument", "Acción desconocida.");
  },
);

/**
 * `agenteRelacionarTicket`: liga (o con `quitar`, desliga) uno de mis tickets
 * con otro por folio, desde el detalle del ticket. Al cerrar uno desde aquí se
 * cierran también los relacionados. Ver agente/relaciones.ts.
 */
export const agenteRelacionarTicket = onCall<{ ticketId: string; numero?: number; quitar?: string }>(
  {
    region: "us-central1",
    secrets: [SUPABASE_SERVICE_KEY],
    timeoutSeconds: 60,
    memory: "512MiB",
    maxInstances: 5,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req) => {
    const usuario = await verificarAcceso(req, "tickets");
    const ticketId = String(req.data?.ticketId ?? "");
    const quitar = req.data?.quitar == null ? null : String(req.data.quitar);
    const numero = Number(req.data?.numero);
    if (!/^\d+$/.test(ticketId)) throw new HttpsError("invalid-argument", "Ticket inválido.");
    if (quitar ? !/^\d+$/.test(quitar) : !Number.isInteger(numero) || numero <= 0) {
      throw new HttpsError("invalid-argument", "Escribe el folio del ticket (solo el número).");
    }
    const sb = clienteSupabase(SUPABASE_SERVICE_KEY.value());
    if (!(await ticketsAsignados(sb, usuario.email)).some((x) => x.id === ticketId)) {
      throw new HttpsError("not-found", "Ese ticket no está entre tus pendientes.");
    }
    try {
      if (quitar) {
        await desligarTicket(sb, usuario.email, Number(ticketId), Number(quitar));
        return { ok: true };
      }
      return { ok: true, relacionado: await relacionarTicket(sb, usuario.email, Number(ticketId), numero) };
    } catch (e) {
      const conocidos: Record<string, string> = {
        rel_no_existe: `No existe el ticket #${numero}.`,
        rel_mismo: "Un ticket no se puede relacionar consigo mismo.",
        rel_ya: `Ya está relacionado con #${numero}.`,
        rel_del_otro: "Esa relación la puso el otro ticket en el portal; quítala desde ese ticket.",
      };
      const m = (e as Error).message;
      if (conocidos[m]) throw new HttpsError("failed-precondition", conocidos[m]);
      console.error("[agenteRelacionarTicket]", e);
      throw new HttpsError("unavailable", "No se pudo guardar la relación en el portal.");
    }
  },
);

/**
 * `whatsappQr`: QR para reconectar el WhatsApp (Evolution API) de una empresa
 * desde el badge rojo de la barra. Si ya está conectada, lo marca en
 * `whatsappStatus` y no devuelve QR. Ver whatsapp.ts.
 */
export const whatsappQr = onCall<{ clientId: string }>(
  {
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 3,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  (req) => qrWhatsapp(req),
);

/**
 * `sentryWebhook`: avisos de Sentry (issue nuevo, regresión, pico) por WhatsApp,
 * con la misma configuración por empresa que los avisos de PRs. HTTP y sin
 * login: lo llama Sentry, y la firma HMAC del client secret es la autenticación.
 * Ver sentryWebhook.ts.
 */
export const sentryWebhook = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "256MiB",
    maxInstances: 3,
  },
  (req, res) => atenderSentry(req, res),
);

const CORS_DASHBOARD = [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/];

/**
 * `sentryDetalleIssue`: el issue y su último evento (stack trace, tags,
 * navegador, URL) para el panel de Monitoreo. Mismo corte que las reglas de
 * `sentry/*`: empresa, proyecto, repo y `verMonitoreo`. Ver sentryIssues.ts.
 */
export const sentryDetalleIssue = onCall<{ issueId: string }>(
  { region: "us-central1", secrets: [SUPABASE_SERVICE_KEY], timeoutSeconds: 30, memory: "256MiB", maxInstances: 5, cors: CORS_DASHBOARD },
  (req) => detalleIssue(req, clienteSupabase(SUPABASE_SERVICE_KEY.value())),
);

/**
 * `sentryCambiarIssue`: resolver, ignorar o reabrir un issue desde Monitoreo.
 * Pide `resolverMonitoreo` además del alcance. Ver sentryIssues.ts.
 */
export const sentryCambiarIssue = onCall<{ issueId: string; estado: Estado }>(
  { region: "us-central1", timeoutSeconds: 30, memory: "256MiB", maxInstances: 5, cors: CORS_DASHBOARD },
  (req) => cambiarEstado(req),
);

/**
 * `sentryTicketCerrado`: lo llama el trigger de Supabase en cuanto un ticket
 * pasa a una etapa cerrada (`{ ticket_id, numero }`), desde el portal o donde
 * sea; si es de un issue de Sentry, lo resuelve al momento. No necesita
 * secreto: no confía en el aviso, vuelve a leer el ticket en el portal y solo
 * resuelve si de verdad está cerrado y el folio coincide.
 */
export const sentryTicketCerrado = onRequest(
  { region: "us-central1", secrets: [SUPABASE_SERVICE_KEY], timeoutSeconds: 60, memory: "256MiB", maxInstances: 3 },
  async (req, res) => {
    const ticketId = Number(req.body?.ticket_id);
    const folio = Number(req.body?.numero);
    if (req.method !== "POST" || !Number.isInteger(ticketId) || !Number.isInteger(folio)) {
      res.status(400).json({ ok: false });
      return;
    }
    const hechos = await resolverPorTicketsCerrados(clienteSupabase(SUPABASE_SERVICE_KEY.value()), { ticketId, numero: folio })
      .catch((e) => { console.error("[sentryTicketCerrado]", e); return [] as string[]; });
    if (hechos.length) console.log(`[sentryTicketCerrado] #${folio}: resueltos`, hechos.join(", "));
    res.json({ ok: true, resueltos: hechos });
  },
);

/**
 * `sentryTicketsCerrados`: respaldo del aviso de arriba (si pg_net falló o el
 * ticket se cerró antes de existir el trigger): cada 10 min resuelve los issues
 * cuyo ticket ya está cerrado. Ver sentryIssues.ts.
 */
export const sentryTicketsCerrados = onSchedule(
  { schedule: "every 10 minutes", region: "us-central1", secrets: [SUPABASE_SERVICE_KEY], timeoutSeconds: 120, memory: "256MiB" },
  async () => {
    const hechos = await resolverPorTicketsCerrados(clienteSupabase(SUPABASE_SERVICE_KEY.value()));
    if (hechos.length) console.log("[sentryTicketsCerrados] resueltos", hechos.join(", "));
  },
);

/**
 * `sentryCrearTicket`: levanta en el portal un ticket de Sistemas Soporte
 * técnico con todo el detalle del issue, asignado a quien lo pide (uno por
 * issue; si ya existe, le actualiza la descripción y el propietario). Pide
 * `crearTicketMonitoreo`. Ver sentryIssues.ts.
 */
export const sentryCrearTicket = onCall<{ issueId: string }>(
  { region: "us-central1", secrets: [SUPABASE_SERVICE_KEY], timeoutSeconds: 60, memory: "256MiB", maxInstances: 5, cors: CORS_DASHBOARD },
  (req) => crearTicketIssue(req, clienteSupabase(SUPABASE_SERVICE_KEY.value())),
);

/**
 * `docsFallo`: causa del último fallo de la documentación automática de un repo
 * (sin crédito en Anthropic, llave inválida…), leída del log del job. Ver
 * docsFallo.ts. Cualquier sesión de Google verificada del dashboard.
 */
export const docsFallo = onCall<{ owner: string; repo: string; runId: number }>(
  {
    region: "us-central1",
    secrets: [GITHUB_TOKEN],
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 3,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req) => {
    if (!req.auth?.token.email || req.auth.token.email_verified !== true) {
      throw new HttpsError("unauthenticated", "Inicia sesión.");
    }
    const owner = String(req.data?.owner ?? "");
    const repo = String(req.data?.repo ?? "");
    const runId = Number(req.data?.runId);
    if (!/^[\w.-]{1,100}$/.test(owner) || !/^[\w.-]{1,100}$/.test(repo) || !Number.isSafeInteger(runId) || runId <= 0) {
      throw new HttpsError("invalid-argument", "Run inválido.");
    }
    const gh = new Octokit({ auth: GITHUB_TOKEN.value(), userAgent: "sozu-dashboard" });
    try {
      return await falloDocs(gh, owner, repo, runId);
    } catch (e) {
      console.error("[docsFallo]", e);
      throw new HttpsError("unavailable", "No se pudo leer el log del run.");
    }
  },
);

/**
 * `agenteProcesarAdjunto`: transcribe un audio o video (y saca cuadros del
 * video) que la persona subió para GeorgIA. Ver agente/procesarAdjunto.ts.
 * Una petición por instancia: Whisper ocupa los dos CPUs.
 */
export const agenteProcesarAdjunto = onCall<{ url: string; tipo: "audio" | "video" }>(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "4GiB",
    cpu: 2,
    concurrency: 1,
    maxInstances: 3,
    cors: [/^https:\/\/dashboard\.sozu\.com$/, /^https:\/\/sozu-dashboard-dev\.web\.app$/, /^http:\/\/localhost:\d+$/],
  },
  async (req) => {
    const usuario = await verificarAcceso(req);
    const tipo = req.data?.tipo;
    if (tipo !== "audio" && tipo !== "video") throw new HttpsError("invalid-argument", "Solo audio o video.");
    try {
      return await procesarAdjunto(usuario.email, String(req.data?.url ?? ""), tipo);
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("[agenteProcesarAdjunto]", e);
      throw new HttpsError("unavailable", "No se pudo transcribir el archivo.");
    }
  },
);
