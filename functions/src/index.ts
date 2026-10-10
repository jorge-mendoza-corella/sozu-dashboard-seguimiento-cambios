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
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { consumirCupo, reposPermitidos, verificarAcceso } from "./agente/acceso.js";
import { docPorRuta, indiceDocs, limpiarRuta, obtenerCorpus } from "./agente/docs.js";
import { describirLlamada, ejecutar, HERRAMIENTAS } from "./agente/herramientas.js";
import { bloqueDocs, bloqueRepos, INSTRUCCIONES } from "./agente/instrucciones.js";
import { clienteSupabase, ticketsAsignados } from "./agente/tickets.js";

initializeApp();

const ANTHROPIC_API_KEY = defineSecret("AGENTE_ANTHROPIC_API_KEY");
// Los mismos PATs que ya usa el front (Secret Manager de sozu-admin-dev):
// el principal lee los repos monitoreados; el de docs, sozu-docs.
const GITHUB_TOKEN = defineSecret("DASHBOARD_GITHUB_TOKEN");
const GITHUB_DOCS_TOKEN = defineSecret("DASHBOARD_GITHUB_DOCS_TOKEN");
// Service role del Supabase de PRODUCCIÓN de sozu-admin: solo para leer los
// tickets asignados a quien pregunta (ver agente/tickets.ts).
const SUPABASE_SERVICE_KEY = defineSecret("AGENTE_SUPABASE_SERVICE_KEY");

const MODELO = "claude-opus-5-5";
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
    const mensaje = typeof req.data?.mensaje === "string" ? req.data.mensaje.trim() : "";
    if (!mensaje || mensaje.length > MAX_MENSAJE) {
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
        if (m.error || typeof m.texto !== "string" || !m.texto.trim()) continue;
        historial.push({ role: m.rol === "asistente" ? "assistant" : "user", content: m.texto });
      }
      // El primer mensaje mandado a la API tiene que ser del usuario.
      while (historial[0]?.role === "assistant") historial.shift();
    }

    const ahora = FieldValue.serverTimestamp();
    if (nueva) {
      await convRef.set({
        owner: usuario.email,
        titulo: mensaje.replace(/\s+/g, " ").slice(0, MAX_TITULO),
        fijada: false,
        creado: ahora,
        actualizado: ahora,
      });
    }
    await mensajesRef.add({ rol: "usuario", texto: mensaje, creado: ahora });

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
      { role: "user", content: `[Hoy es ${fecha}. Pregunta de ${usuario.email}]\n\n${mensaje}` },
    ];

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
 * llama cada 15 min; si hay, el personaje grita.
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
      const tickets = await ticketsAsignados(clienteSupabase(SUPABASE_SERVICE_KEY.value()), usuario.email);
      return { tickets, revisado: new Date().toISOString() };
    } catch (e) {
      console.error("[agenteTickets]", e);
      throw new HttpsError("unavailable", "No se pudieron leer los tickets del portal.");
    }
  },
);
