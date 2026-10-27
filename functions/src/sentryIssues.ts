/**
 * Detalle de un issue de Sentry y cambio de estado (resolver, ignorar,
 * reabrir) desde la pestaña Monitoreo.
 *
 * El token de Sentry lee y escribe en TODA la organización, así que no viaja
 * al navegador: el front llama a estas funciones y aquí se decide si quien
 * pregunta puede ver ese repo, con la MISMA regla que `sentry/{slug}` en
 * firestore.rules (`veMonitoreoDe`): empresa, proyecto, repo y el permiso
 * `verMonitoreo` resuelto repo > empresa > general. Cambiar el estado pide
 * además `resolverMonitoreo`, resuelto igual.
 *
 * El token sale de Secret Manager (`SENTRY_AUTH_TOKEN`, el mismo del sync) en
 * tiempo de ejecución, como en sentryWebhook.ts. Para cambiar estados necesita
 * el scope `event:write`.
 *
 * `crearTicketIssue` levanta un ticket en el portal de sozu-admin (Supabase)
 * con todo el detalle, en el pipeline de Sistemas Soporte técnico, igual que
 * `crearTicket` del portal (tickets-store.tsx). Uno por issue: queda en
 * `sentryTickets/{issueId}` y el panel muestra el folio en vez del botón.
 */
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { SUPERUSER_EMAIL } from "./agente/acceso.js";
import { sinAcentos, usuarioPortal } from "./agente/tickets.js";
import { secretoGlobal } from "./whatsapp.js";

const ORG = "sozu-lh";
const API = `https://us.sentry.io/api/0/organizations/${ORG}`;
/** Frames por excepción: los de arriba son el código de la librería o del runtime. */
const MAX_FRAMES = 30;
/** Tags que identifican a una persona (IP, id de usuario): no salen de aquí. */
const TAGS_PRIVADOS = new Set(["user", "user.ip", "user.id", "user.email", "user.username"]);

export type Estado = "resolved" | "ignored" | "unresolved";
type Permiso = "verMonitoreo" | "resolverMonitoreo";

interface Alcance {
  slug: string;
  repoId: string;
  projectId: string;
  clientId: string;
  reposDelProyecto: string[];
}

const lista = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const mapa = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Copia de `veMonitoreoDe` de firestore.rules, con el permiso como parámetro. */
export function puede(perfil: Record<string, unknown>, d: Alcance, permiso: Permiso): boolean {
  const superuser = perfil.role === "superuser";
  const proyectos = lista(perfil.projectIds);
  const repos = lista(perfil.repoIds);
  const deEmpresa = superuser || lista(perfil.clientIds).includes(d.clientId);
  const deProyecto = superuser || proyectos.length === 0 || proyectos.includes(d.projectId);
  const deRepo = !repos.some((r) => d.reposDelProyecto.includes(r)) || repos.includes(d.repoId);
  const general = mapa(perfil.permissions);
  const porEmpresa = mapa(mapa(perfil.permissionsByClient)[d.clientId]);
  const porRepo = mapa(mapa(perfil.permissionsByRepo)[d.repoId]);
  const valor = permiso in porRepo ? porRepo[permiso] : permiso in porEmpresa ? porEmpresa[permiso] : general[permiso];
  return deEmpresa && deProyecto && deRepo && valor === true;
}

async function sentry(token: string, ruta: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const r = await fetch(`${API}/${ruta}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (r.status === 404) throw new HttpsError("not-found", "Ese issue ya no existe en Sentry.");
  if (r.status === 403) throw new HttpsError("failed-precondition", "El token de Sentry no tiene permiso para esto (falta el scope event:write).");
  if (!r.ok) throw new HttpsError("unavailable", `Sentry respondió ${r.status}.`);
  return (await r.json()) as Record<string, unknown>;
}

/**
 * Quién pregunta, qué issue es y si puede: devuelve el token, el issue y el doc
 * `sentry/{slug}` de su proyecto. Todo lo que no pasa termina en HttpsError.
 */
async function autorizar(req: CallableRequest, issueId: unknown, permiso: Permiso) {
  const t = req.auth?.token;
  if (!t?.email) throw new HttpsError("unauthenticated", "Inicia sesión.");
  if (t.email_verified !== true || t.firebase?.sign_in_provider !== "google.com") {
    throw new HttpsError("permission-denied", "Hace falta sesión de Google con correo verificado.");
  }
  const id = String(issueId ?? "");
  if (!/^\d{1,20}$/.test(id)) throw new HttpsError("invalid-argument", "Issue inválido.");

  const token = await secretoGlobal("SENTRY_AUTH_TOKEN");
  if (!token) throw new HttpsError("failed-precondition", "Falta el token de Sentry en el servidor.");

  const issue = await sentry(token, `issues/${id}/`);
  const pid = String(mapa(issue.project).id ?? "");
  const fs = getFirestore();
  const docs = await fs.collection("sentry").where("sentryProjectId", "==", pid).limit(1).get();
  if (docs.empty) throw new HttpsError("not-found", "Ese issue no es de un repo monitoreado.");
  const d = docs.docs[0];
  const x = d.data();
  const alcance: Alcance = {
    slug: d.id,
    repoId: String(x.repoId ?? ""),
    projectId: String(x.projectId ?? ""),
    clientId: String(x.clientId ?? ""),
    reposDelProyecto: lista(x.reposDelProyecto),
  };

  const email = t.email.toLowerCase();
  if (email !== SUPERUSER_EMAIL) {
    const perfil = (await fs.doc(`users/${email}`).get()).data();
    if (!perfil || !puede(perfil, alcance, permiso)) {
      throw new HttpsError("permission-denied", permiso === "verMonitoreo" ? "No tienes acceso a este repo." : "No tienes permiso para cambiar issues de este repo.");
    }
  }
  return { token, id, issue, ref: d.ref, slug: alcance.slug };
}

const texto = (v: unknown) => (typeof v === "string" ? v : "");
const numero = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

/** Lo que pinta el panel: el issue y su último evento, sin datos de personas. */
export async function detalleIssue(req: CallableRequest<{ issueId: string }>) {
  const { token, id, issue, slug } = await autorizar(req, req.data?.issueId, "verMonitoreo");
  const [detalle, ticket] = await Promise.all([detalleDe(token, id, issue, slug), ticketDe(id)]);
  return { ...detalle, ticket };
}

type Detalle = Awaited<ReturnType<typeof detalleDe>>;

async function detalleDe(token: string, id: string, issue: Record<string, unknown>, slug: string) {
  const ev = await sentry(token, `issues/${id}/events/latest/`).catch(() => ({} as Record<string, unknown>));
  const entries = Array.isArray(ev.entries) ? (ev.entries as Record<string, unknown>[]) : [];
  const de = (tipo: string) => mapa(entries.find((e) => e.type === tipo)?.data);

  const excepciones = (Array.isArray(de("exception").values) ? (de("exception").values as Record<string, unknown>[]) : []).map((x) => {
    const frames = Array.isArray(mapa(x.stacktrace).frames) ? (mapa(x.stacktrace).frames as Record<string, unknown>[]) : [];
    return {
      tipo: texto(x.type),
      valor: texto(x.value),
      mecanismo: texto(mapa(x.mechanism).type),
      manejado: mapa(x.mechanism).handled !== false,
      // Sentry los da del más externo al más interno; el panel los quiere al revés
      // (donde reventó, primero), y solo los últimos MAX_FRAMES.
      frames: frames.slice(-MAX_FRAMES).reverse().map((f) => ({
        archivo: texto(f.filename) || texto(f.absPath) || texto(f.module),
        funcion: texto(f.function),
        linea: f.lineNo == null ? null : numero(f.lineNo),
        columna: f.colNo == null ? null : numero(f.colNo),
        propio: f.inApp === true,
        contexto: (Array.isArray(f.context) ? (f.context as [number, string][]) : []).map(([n, l]) => ({ n: numero(n), l: texto(l).slice(0, 300) })),
      })),
    };
  });

  const req0 = de("request");
  const tags = (Array.isArray(ev.tags) ? (ev.tags as Record<string, unknown>[]) : [])
    .map((tg) => ({ clave: texto(tg.key), valor: texto(tg.value) }))
    .filter((tg) => tg.clave && !TAGS_PRIVADOS.has(tg.clave));
  const contextos = mapa(ev.contexts);
  const nombreVersion = (c: unknown) => [texto(mapa(c).name), texto(mapa(c).version)].filter(Boolean).join(" ");

  return {
    id,
    slug,
    shortId: texto(issue.shortId),
    titulo: texto(issue.title),
    culprit: texto(issue.culprit),
    nivel: texto(issue.level) || "error",
    estado: texto(issue.status),
    eventos: numero(issue.count),
    usuarios: numero(issue.userCount),
    primeraVez: texto(issue.firstSeen) || null,
    ultimaVez: texto(issue.lastSeen) || null,
    url: texto(issue.permalink),
    evento: {
      id: texto(ev.eventID),
      fecha: texto(ev.dateCreated) || null,
      release: texto(mapa(ev.release).version) || null,
      mensaje: texto(ev.message),
      url: texto(req0.url) || null,
      metodo: texto(req0.method) || null,
      navegador: nombreVersion(contextos.browser) || null,
      sistema: nombreVersion(contextos.os) || null,
      dispositivo: texto(mapa(contextos.device).model) || texto(mapa(contextos.device).family) || null,
      runtime: nombreVersion(contextos.runtime) || null,
      excepciones,
      tags,
    },
  };
}

/**
 * Cambia el estado en Sentry y ajusta el resumen de Firestore para que la
 * pestaña no tenga que esperar al siguiente sync (que lo recalcula igual).
 */
export async function cambiarEstado(req: CallableRequest<{ issueId: string; estado: Estado }>) {
  const estado = req.data?.estado;
  if (estado !== "resolved" && estado !== "ignored" && estado !== "unresolved") {
    throw new HttpsError("invalid-argument", "Estado inválido.");
  }
  const { token, id, ref } = await autorizar(req, req.data?.issueId, "resolverMonitoreo");
  await sentry(token, `issues/${id}/`, { method: "PUT", body: JSON.stringify({ status: estado }) });

  if (estado !== "unresolved") {
    await getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prod = mapa(mapa(snap.data()?.entornos).produccion);
      const top = Array.isArray(prod.top) ? (prod.top as Record<string, unknown>[]) : [];
      const resueltos = Array.isArray(prod.resueltos) ? (prod.resueltos as Record<string, unknown>[]) : [];
      const quitado = top.find((i) => String(i.id) === id);
      if (!quitado) return;
      const nuevo = Date.now() - Date.parse(texto(quitado.primeraVez)) < 86_400_000;
      tx.update(ref, {
        "entornos.produccion.top": top.filter((i) => i !== quitado),
        "entornos.produccion.resueltos": [{ ...quitado, estado }, ...resueltos.filter((i) => String(i.id) !== id)].slice(0, 5),
        "entornos.produccion.sinResolver": Math.max(0, numero(prod.sinResolver) - 1),
        "entornos.produccion.nuevos24h": Math.max(0, numero(prod.nuevos24h) - (nuevo ? 1 : 0)),
      });
    });
  }
  return { ok: true, estado };
}

// --- Ticket en el portal ------------------------------------------------------

/** Pipeline al que van los errores: "SOZU - Sistemas Soporte técnico". */
const PIPELINE_SOPORTE = /sistemas.*soporte/;
/** Clave de `tickets_fuentes` (FK): la misma que usa el portal por defecto. */
const FUENTE = "portal_admin";
const URL_TICKET = (numero: number) => `https://admin.sozu.com/admin/portal-tickets/todos?ticket=${numero}`;

export interface TicketIssue {
  numero: number;
  url: string;
  creadoPor: string;
}

async function ticketDe(issueId: string): Promise<TicketIssue | null> {
  const d = (await getFirestore().doc(`sentryTickets/${issueId}`).get()).data();
  return d ? { numero: numero(d.numero), url: texto(d.url), creadoPor: texto(d.creadoPor) } : null;
}

/** Texto del ticket: lo que necesita quien lo resuelva sin abrir Sentry. */
export function textoTicket(d: Detalle): string {
  const e = d.evento;
  const l: string[] = [
    `Error de producción reportado por Sentry en el repo ${d.slug}.`,
    "",
    `Issue: ${d.shortId} (${d.nivel})`,
    `Error: ${d.titulo}`,
  ];
  if (d.culprit) l.push(`Dónde: ${d.culprit}`);
  l.push(`Eventos: ${d.eventos} · Usuarios afectados: ${d.usuarios}`);
  l.push(`Primera vez: ${d.primeraVez ?? "—"} · Última vez: ${d.ultimaVez ?? "—"}`);
  const entorno = [
    ["URL", e.url ? `${e.metodo ? `${e.metodo} ` : ""}${e.url}` : null],
    ["Navegador", e.navegador], ["Sistema", e.sistema], ["Dispositivo", e.dispositivo],
    ["Runtime", e.runtime], ["Release", e.release],
  ].filter(([, v]) => v);
  if (entorno.length) {
    l.push("", "Último evento:");
    for (const [k, v] of entorno) l.push(`- ${k}: ${v}`);
  }
  for (const x of e.excepciones) {
    l.push("", `Stack trace: ${x.tipo}${x.valor ? `: ${x.valor}` : ""}${x.manejado ? "" : " (no capturado)"}`);
    const frames = x.frames.filter((f) => f.propio).length ? x.frames.filter((f) => f.propio) : x.frames;
    for (const f of frames.slice(0, 15)) {
      l.push(`- ${f.archivo || "?"}${f.linea !== null ? `:${f.linea}` : ""}${f.columna !== null ? `:${f.columna}` : ""}${f.funcion ? ` en ${f.funcion}` : ""}`);
    }
  }
  if (e.tags.length) l.push("", `Tags: ${e.tags.map((t) => `${t.clave}=${t.valor}`).join(", ")}`);
  l.push("", `Detalle en Sentry: ${d.url}`);
  return l.join("\n");
}

const prioridadDe = (nivel: string) => (nivel === "fatal" || nivel === "error" ? "alta" : nivel === "warning" ? "media" : "baja");

async function destino(sb: SupabaseClient): Promise<{ pipeline: number; etapa: number }> {
  const { data: pipelines, error } = await sb.from("tickets_pipelines").select("id, nombre").eq("activo", true);
  if (error) throw error;
  const p = (pipelines ?? []).find((x) => PIPELINE_SOPORTE.test(sinAcentos(String(x.nombre))));
  if (!p) throw new HttpsError("failed-precondition", "No encontré el pipeline «Sistemas Soporte técnico» en el portal.");
  const { data: etapas, error: e2 } = await sb
    .from("tickets_etapas")
    .select("id, nombre, orden, tipo_semantico, cerrada")
    .eq("id_pipeline", p.id)
    .eq("activo", true)
    .order("orden");
  if (e2) throw e2;
  // Etapa de entrada, como un ticket nuevo del portal: la abierta, o la primera viva.
  const vivas = (etapas ?? []).filter((x) => !x.cerrada && !["resuelta", "cerrada", "descartada"].includes(x.tipo_semantico));
  const etapa = vivas.find((x) => x.tipo_semantico === "abierta") ?? vivas[0];
  if (!etapa) throw new HttpsError("failed-precondition", "El pipeline de Soporte técnico no tiene etapas abiertas.");
  return { pipeline: Number(p.id), etapa: Number(etapa.id) };
}

/**
 * Levanta el ticket (o devuelve el que ya existe para ese issue). Pide el mismo
 * permiso que resolver: es una acción sobre el error, no solo verlo.
 */
export async function crearTicketIssue(req: CallableRequest<{ issueId: string }>, sb: SupabaseClient): Promise<TicketIssue> {
  const { token, id, issue, slug } = await autorizar(req, req.data?.issueId, "resolverMonitoreo");
  const ref = getFirestore().doc(`sentryTickets/${id}`);
  const previo = await ticketDe(id);
  if (previo) return previo;

  const email = String(req.auth?.token.email ?? "").toLowerCase();
  const yo = await usuarioPortal(sb, email);
  if (!yo) throw new HttpsError("failed-precondition", "Tu correo no tiene usuario en el portal de tickets.");
  const d = await detalleDe(token, id, issue, slug);
  const { pipeline, etapa } = await destino(sb);

  const { data: ins, error } = await sb
    .from("tickets")
    .insert({
      nombre: `[Sentry] ${d.shortId}: ${d.titulo}`.slice(0, 200),
      id_pipeline: pipeline,
      id_etapa: etapa,
      prioridad: prioridadDe(d.nivel),
      id_usuario_creador: yo.auth_user_id,
      descripcion: textoTicket(d),
      fuente: FUENTE,
    })
    .select("id, numero")
    .single();
  if (error || !ins) {
    console.error("[sentryCrearTicket]", error);
    throw new HttpsError("unavailable", `El portal no aceptó el ticket: ${error?.message ?? "sin respuesta"}.`);
  }
  await sb.from("tickets_actividad").insert({
    id_ticket: ins.id,
    texto: `Ticket creado desde Monitoreo del dashboard de cambios (Sentry ${d.shortId}).`,
    tipo: "sistema",
    id_usuario_autor: yo.auth_user_id,
  });

  const salida: TicketIssue = { numero: Number(ins.numero), url: URL_TICKET(Number(ins.numero)), creadoPor: email };
  await ref.set({ ...salida, ticketId: Number(ins.id), slug, creadoEn: FieldValue.serverTimestamp() });
  // Nota en el issue para quien llegue por Sentry; si falla, el ticket ya existe.
  await sentry(token, `issues/${id}/comments/`, {
    method: "POST",
    body: JSON.stringify({ text: `Ticket SOZU-${salida.numero} en el portal: ${salida.url}` }),
  }).catch((e) => console.warn("[sentryCrearTicket] comentario", (e as Error).message));
  return salida;
}
