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
  return { token, id, issue, ref: d.ref, slug: alcance.slug, alcance };
}

const texto = (v: unknown) => (typeof v === "string" ? v : "");
const numero = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

/** Lo que pinta el panel: el issue y su último evento, sin datos de personas. */
export async function detalleIssue(req: CallableRequest<{ issueId: string }>, sb: SupabaseClient) {
  const { token, id, issue, slug } = await autorizar(req, req.data?.issueId, "verMonitoreo");
  const [detalle, ticket] = await Promise.all([detalleDe(token, id, issue, slug), ticketDe(id)]);
  // Con su etapa en el portal: si ya se resolvió, el panel ofrece resolver el issue.
  return { ...detalle, ticket: ticket ? { ...ticket, ...(await estadoTicket(sb, ticket.ticketId)) } : null };
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
const TERMINALES = new Set(["resuelta", "cerrada", "descartada"]);

export interface TicketIssue {
  numero: number;
  ticketId: number;
  url: string;
  creadoPor: string;
}

async function ticketDe(issueId: string): Promise<TicketIssue | null> {
  const d = (await getFirestore().doc(`sentryTickets/${issueId}`).get()).data();
  return d ? { numero: numero(d.numero), ticketId: numero(d.ticketId), url: texto(d.url), creadoPor: texto(d.creadoPor) } : null;
}

/** Etapa del ticket en el portal y si ya se resolvió (o cerró / descartó). */
async function estadoTicket(sb: SupabaseClient, ticketId: number): Promise<{ etapa: string | null; resuelto: boolean }> {
  const { data, error } = await sb
    .from("tickets")
    .select("activo, tickets_etapas(nombre, tipo_semantico, cerrada)")
    .eq("id", ticketId)
    .maybeSingle();
  if (error || !data) return { etapa: null, resuelto: false };
  const e = mapa(Array.isArray(data.tickets_etapas) ? data.tickets_etapas[0] : data.tickets_etapas);
  const resuelto = e.cerrada === true || TERMINALES.has(texto(e.tipo_semantico)) || data.activo === false;
  return { etapa: texto(e.nombre) || null, resuelto };
}

/** Quién sufre el error según el repo: el campo «Rol afectado» de la plantilla. */
const ROL_POR_REPO: [RegExp, string][] = [
  [/agente-app/, "agente inmobiliario (app de agentes)"],
  [/cliente-app/, "cliente (app de clientes)"],
  [/-web$|landing/, "visitante del sitio (posible cliente)"],
  [/admin/, "usuario interno del admin"],
];
const rolDe = (slug: string) =>
  ROL_POR_REPO.find(([re]) => re.test(slug))?.[1] ?? "usuarios de las apps y del admin (servicio de backend)";

/** Secretos que la plantilla rechaza (CLABEs, JWT, llaves): no se copian del evento. */
const limpiar = (t: string) =>
  t
    .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g, "[jwt]")
    .replace(/\b(sk|pk|rk)_(live|test)_\w{10,}/gi, "[llave]")
    .replace(/\b\d{18}\b/g, "[CLABE]");

const fechaMx = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" }) : "—";

interface Contexto {
  repo: string;
  proyecto: string;
  folio: number | null;
}

/**
 * Descripción en la plantilla de Sistemas del portal (sozu-admin,
 * plantilla-sistemas.ts) con todo lo que trae Sentry, para que pase los
 * "puntos obligatorios" de un ticket de tipo error sin pasar por el asistente.
 */
export function textoTicket(d: Detalle, c: Contexto): string {
  const e = d.evento;
  const x = e.excepciones[0];
  const propios = x ? (x.frames.some((f) => f.propio) ? x.frames.filter((f) => f.propio) : x.frames) : [];
  const arriba = propios[0];
  const lugar = (f: (typeof propios)[number]) =>
    `${f.archivo || "?"}${f.linea !== null ? `:${f.linea}` : ""}${f.columna !== null ? `:${f.columna}` : ""}${f.funcion ? ` en ${f.funcion}` : ""}`;
  const errorExacto = x ? `${x.tipo}${x.valor ? `: ${x.valor}` : ""}` : d.titulo;
  const donde = [
    `${c.proyecto} · repo ${c.repo}`,
    d.culprit && `(${d.culprit})`,
    e.url && `· URL ${e.url}`,
  ].filter(Boolean).join(" ");
  const cliente = [e.navegador, e.sistema, e.dispositivo, e.runtime].filter(Boolean).join(", ");
  const dias = d.primeraVez && d.ultimaVez
    ? Math.max(1, Math.round((Date.parse(d.ultimaVez) - Date.parse(d.primeraVez)) / 86_400_000) + 1)
    : 1;
  const transaccion = e.tags.find((t) => t.clave === "transaction")?.valor;

  const l: string[] = [
    "Tipo: error",
    `Dónde: ${donde}`,
    `Rol afectado: ${rolDe(d.slug)}`,
    `Ambiente y fecha: producción, desde ${fechaMx(d.primeraVez)} (último ${fechaMx(d.ultimaVez)}); ${d.eventos} ${d.eventos === 1 ? "evento" : "eventos"} en ${dias} ${dias === 1 ? "día" : "días"}, ${d.usuarios} ${d.usuarios === 1 ? "usuario afectado" : "usuarios afectados"}, ${d.eventos > 1 ? "pasa de forma repetida" : "visto una vez"}`,
    "",
    `Contexto: Sentry (monitoreo de errores de producción) registró el issue ${d.shortId} en ${c.repo}.${e.release ? ` Release ${e.release}.` : ""}${cliente ? ` Último evento desde ${cliente}.` : ""}${x && !x.manejado ? " El error no lo captura el código: llega sin manejar." : ""}`,
    `Situación actual: ${arriba ? `al ejecutar ${arriba.funcion || "el código"} (${arriba.archivo || "?"}${arriba.linea !== null ? `:${arriba.linea}` : ""})` : `en ${d.culprit || c.repo}`} truena con «${errorExacto}» y la operación no termina.`,
    `Resultado esperado: la operación${transaccion ? ` de ${transaccion}` : ""} termina sin error, el caso que lo provoca se maneja en el código y Sentry deja de registrar eventos nuevos de ${d.shortId}.`,
    "",
    `Precondiciones: ambiente de producción${cliente ? `; ${cliente}` : ""}.`,
    "Pasos para reproducir:",
    `1. ${e.url ? `Abrir o llamar ${e.metodo ? `${e.metodo} ` : ""}${e.url} en producción` : transaccion ? `Ejecutar ${transaccion} en producción` : `Usar el flujo de ${d.culprit || c.repo} en producción`}.`,
    `2. Hacer la acción que llega a ${arriba ? lugar(arriba) : d.culprit || "el código del stack trace"}.`,
    `3. Confirmar en Sentry que ${d.shortId} suma un evento nuevo (último evento ${e.id || "—"}).`,
    "",
    `Datos / identificadores: repo ${c.repo}; issue de Sentry ${d.shortId} (id ${d.id}), último evento ${e.id || "—"}${transaccion ? `; transacción ${transaccion}` : ""}${e.release ? `; release ${e.release}` : ""}.`,
    `Error exacto: ${errorExacto}`,
  ];
  if (propios.length) {
    l.push("Stack trace (código del repo, de donde truena hacia afuera):");
    for (const f of propios.slice(0, 12)) l.push(`- ${lugar(f)}`);
  }
  if (e.tags.length) l.push(`Tags del evento: ${e.tags.map((t) => `${t.clave}=${t.valor}`).join(", ")}`);
  l.push(
    "Lo que ya probé: nada todavía; el ticket se levantó desde Monitoreo del dashboard de cambios con el último evento de Sentry.",
    "Fuera de alcance: no silenciar el error ni cambiar la configuración de Sentry sin corregir la causa.",
    "Criterios de aceptación:",
    `- Después del deploy a producción no hay eventos nuevos de ${d.shortId}.`,
    "- Una prueba automatizada cubre el caso que lo provocaba.",
    `- El issue ${d.shortId} queda resuelto en Sentry.`,
    "Riesgos / dependencias: los archivos del stack trace pueden venir minificados (ubicar el código equivalente en el repo); revisar si otros repos llaman al mismo código.",
    `Qué necesito: ubicar la causa e implementar el cambio, con PR hacia dev que lleve ${c.folio ? `SOZU-${c.folio}` : "el folio del ticket (SOZU-N)"} en el título.`,
    "",
    `Detalle en Sentry: ${d.url}`,
  );
  return limpiar(l.join("\n"));
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
  const vivas = (etapas ?? []).filter((x) => !x.cerrada && !TERMINALES.has(x.tipo_semantico));
  const etapa = vivas.find((x) => x.tipo_semantico === "abierta") ?? vivas[0];
  if (!etapa) throw new HttpsError("failed-precondition", "El pipeline de Soporte técnico no tiene etapas abiertas.");
  return { pipeline: Number(p.id), etapa: Number(etapa.id) };
}

/** Nombre del proyecto del dashboard y `owner/repo` del issue. */
async function contextoDe(a: Alcance, folio: number | null): Promise<Contexto> {
  const proy = (await getFirestore().doc(`projects/${a.projectId}`).get()).data();
  return { repo: a.repoId.replace("__", "/") || a.slug, proyecto: texto(proy?.name) || a.slug, folio };
}

/** Deja a `uid` como propietario si el ticket no tiene ninguno (como el portal al crearlo). */
async function asignarSiFalta(sb: SupabaseClient, ticketId: number, uid: string): Promise<void> {
  const { data } = await sb.from("tickets_propietarios").select("id_usuario").eq("id_ticket", ticketId);
  if ((data ?? []).length) return;
  await sb.from("tickets_propietarios").insert({ id_ticket: ticketId, id_usuario: uid });
  await sb.from("tickets").update({ id_usuario_propietario: uid }).eq("id", ticketId).is("id_usuario_propietario", null);
}

/** El issue del resumen de Firestore lleva su ticket: la lista lo muestra sin abrir el panel. */
async function marcarEnResumen(ref: FirebaseFirestore.DocumentReference, issueId: string, t: TicketIssue): Promise<void> {
  await getFirestore().runTransaction(async (tx) => {
    const prod = mapa(mapa((await tx.get(ref)).data()?.entornos).produccion);
    const conTicket = (lista: unknown) =>
      (Array.isArray(lista) ? (lista as Record<string, unknown>[]) : []).map((i) =>
        String(i.id) === issueId ? { ...i, ticket: { numero: t.numero, url: t.url } } : i,
      );
    tx.update(ref, { "entornos.produccion.top": conTicket(prod.top), "entornos.produccion.resueltos": conTicket(prod.resueltos) });
  });
}

/**
 * Levanta el ticket, o actualiza el que ya existe para ese issue: reescribe la
 * descripción con lo último de Sentry (mientras el ticket siga abierto) y lo
 * asigna a quien lo pide si quedó sin propietario. Pide el mismo permiso que
 * resolver: es una acción sobre el error, no solo verlo.
 */
export async function crearTicketIssue(req: CallableRequest<{ issueId: string }>, sb: SupabaseClient): Promise<TicketIssue & { actualizado: boolean }> {
  const { token, id, issue, slug, alcance, ref: refResumen } = await autorizar(req, req.data?.issueId, "resolverMonitoreo");
  const ref = getFirestore().doc(`sentryTickets/${id}`);
  const email = String(req.auth?.token.email ?? "").toLowerCase();
  const yo = await usuarioPortal(sb, email);
  if (!yo) throw new HttpsError("failed-precondition", "Tu correo no tiene usuario en el portal de tickets.");
  const d = await detalleDe(token, id, issue, slug);
  const nombre = `Corregir ${d.shortId} en ${slug}: ${d.titulo}`.slice(0, 200);

  const previo = await ticketDe(id);
  if (previo) {
    const { resuelto } = await estadoTicket(sb, previo.ticketId);
    if (!resuelto) {
      const { error } = await sb
        .from("tickets")
        .update({ nombre, descripcion: textoTicket(d, await contextoDe(alcance, previo.numero)) })
        .eq("id", previo.ticketId);
      if (error) throw new HttpsError("unavailable", `El portal no aceptó la actualización: ${error.message}.`);
      await asignarSiFalta(sb, previo.ticketId, yo.auth_user_id);
      await sb.from("tickets_actividad").insert({
        id_ticket: previo.ticketId,
        texto: `Descripción actualizada desde Monitoreo con el último evento de Sentry (${d.shortId}).`,
        tipo: "sistema",
        id_usuario_autor: yo.auth_user_id,
      });
    }
    await marcarEnResumen(refResumen, id, previo);
    return { ...previo, actualizado: !resuelto };
  }

  const { pipeline, etapa } = await destino(sb);
  const { data: ins, error } = await sb
    .from("tickets")
    .insert({
      nombre,
      id_pipeline: pipeline,
      id_etapa: etapa,
      prioridad: prioridadDe(d.nivel),
      id_usuario_creador: yo.auth_user_id,
      id_usuario_propietario: yo.auth_user_id,
      descripcion: textoTicket(d, await contextoDe(alcance, null)),
      fuente: FUENTE,
    })
    .select("id, numero")
    .single();
  if (error || !ins) {
    console.error("[sentryCrearTicket]", error);
    throw new HttpsError("unavailable", `El portal no aceptó el ticket: ${error?.message ?? "sin respuesta"}.`);
  }
  const folio = Number(ins.numero);
  // Con el folio ya asignado, el «Qué necesito» lo pide en el título del PR.
  await sb.from("tickets").update({ descripcion: textoTicket(d, await contextoDe(alcance, folio)) }).eq("id", ins.id);
  await asignarSiFalta(sb, Number(ins.id), yo.auth_user_id);
  await sb.from("tickets_actividad").insert({
    id_ticket: ins.id,
    texto: `Ticket creado desde Monitoreo del dashboard de cambios (Sentry ${d.shortId}).`,
    tipo: "sistema",
    id_usuario_autor: yo.auth_user_id,
  });

  const salida: TicketIssue = { numero: folio, ticketId: Number(ins.id), url: URL_TICKET(folio), creadoPor: email };
  await ref.set({ ...salida, slug, creadoEn: FieldValue.serverTimestamp() });
  await marcarEnResumen(refResumen, id, salida);
  // Nota en el issue para quien llegue por Sentry; si falla, el ticket ya existe.
  await sentry(token, `issues/${id}/comments/`, {
    method: "POST",
    body: JSON.stringify({ text: `Ticket SOZU-${folio} en el portal: ${salida.url}` }),
  }).catch((e) => console.warn("[sentryCrearTicket] comentario", (e as Error).message));
  return { ...salida, actualizado: false };
}
