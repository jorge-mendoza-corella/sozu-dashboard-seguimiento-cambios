/**
 * Tickets del portal de sozu-admin (Supabase de producción) asignados a quien
 * pregunta. Solo lectura.
 *
 * Con service role no aplica la RLS del portal, así que el filtro por persona
 * se hace aquí y es la única barrera: siempre por el email de la SESIÓN
 * (verificado por Firebase), nunca por algo que mande el navegador.
 *
 * Modelo (sozu-supabase-migrations):
 *   usuarios(auth_user_id, nombre, email)
 *   tickets_propietarios(id_ticket, id_usuario → auth_user_id)   asignados (N:N)
 *   tickets.id_usuario_propietario                                asignado legado (1)
 *   tickets_etapas.tipo_semantico ∈ abierta | en_proceso | resuelta | cerrada | descartada
 *   tickets_adjuntos(nombre, tipo foto|video|audio|documento, url pública, activo)
 *   creador: tickets.id_usuario_creador → usuarios; solicitante: tickets_solicitantes →
 *   entidades_relacionadas → personas (o el texto tickets.solicitante)
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getFirestore } from "firebase-admin/firestore";

/**
 * `tickets.fecha_creacion` es `timestamp without time zone` con default
 * CURRENT_TIMESTAMP: guarda la hora UTC pero llega sin zona
 * ("2026-10-23T19:41:00"), y el navegador la leía como hora local, así que un
 * ticket abierto a la 1:41 pm se mostraba a las 7:41 pm. Se le pone la Z.
 */
export function comoUtc(fecha: string): string {
  if (!fecha) return fecha;
  const iso = fecha.replace(" ", "T");
  return /T\d/.test(iso) && !/(Z|[+-]\d\d(:?\d\d)?)$/i.test(iso) ? `${iso}Z` : iso;
}

export const SUPABASE_URL = "https://tzmhgfjmddkfyffkkmto.supabase.co";
/** Enlace directo (sozu-admin abre Mis tickets → pipeline → folio → detalle con ?ticket=). */
const urlTicket = (numero: number) => `https://admin.sozu.com/admin/portal-tickets/todos?ticket=${numero}`;
/** Pipelines de Sistemas ("SOZU - Sistemas Soporte técnico", "… Nuevos Features", …): la regla de antes. */
const PIPELINE_SISTEMAS = /sozu\s*-?\s*sistemas/i;
/**
 * Pipelines que le tocan a GeorgIA: los que tienen prendido «Mostrar el asistente
 * al levantar un ticket» (`tickets_pipelines.mostrar_asistente`). Misma regla que
 * el portal (sozu-admin, plantilla-sistemas.ts → muestraAsistente): si la columna
 * aún no existe, los de Sistemas por nombre.
 */
const pipelineConAsistente = (p: Fila | null): boolean =>
  typeof p?.mostrar_asistente === "boolean" ? p.mostrar_asistente : PIPELINE_SISTEMAS.test(p?.nombre ?? "");
/**
 * Etapas que le tocan a quien atiende (más la de entrada de cualquier pipeline:
 * `tipo_semantico` abierta); las demás (detenido…) no se muestran. La de
 * atención solo se le muestra a quien lo trabaja (ver `atendidoPor`).
 */
const ETAPAS_VISIBLES = ["nuevo", "en revision", "en lista de espera"];
const ORDEN_PRIORIDAD: Record<string, number> = { alta: 0, media: 1, baja: 2 };
const MAX_TICKETS = 80;

export interface TicketSalida {
  id: string;
  numero: number;
  folio: string;
  pipelineId: string;
  etapaId: string;
  titulo: string;
  descripcion: string;
  etapa: string | null;
  pipeline: string | null;
  categoria: string | null;
  /** Correo del usuario del portal que levantó el ticket: el panel lo usa para elegir qué avatar de GeorgIA avisa y lo trabaja. */
  creadorEmail: string | null;
  proyecto: string | null;
  prioridad: string | null;
  abiertoPor: string | null;
  abiertoEn: string;
  asignados: { nombre: string; email: string | null; soyYo: boolean }[];
  /** Lo tomó quien pregunta («Yo trabajo el ticket» o «Mandar a Claude»): ya no es un pendiente por avisar. */
  loAtiendoYo: boolean;
  evidencias: { nombre: string; tipo: "imagen" | "audio" | "video" | "documento" | "otro"; url: string | null }[];
  url: string | null;
}

// deno-lint-ignore no-explicit-any
type Fila = any;

const tipoEvidencia = (t: string | null): TicketSalida["evidencias"][number]["tipo"] =>
  t === "foto" ? "imagen" : t === "audio" ? "audio" : t === "video" ? "video" : t === "documento" ? "documento" : "otro";

export const sinAcentos = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

const uno = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

interface EtapaPortal {
  id: number;
  nombre: string;
  orden: number;
  tipo_semantico: string | null;
  cerrada: boolean | null;
}

const TIPOS_TERMINALES = new Set(["resuelta", "cerrada", "descartada"]);
const NOMBRE_TERMINAL = /resuelt|cerrad|conclu|finaliz|no proced|cancelad|rechazad|desist/i;
const esTerminal = (e: EtapaPortal) =>
  !!e.cerrada || (e.tipo_semantico ? TIPOS_TERMINALES.has(e.tipo_semantico) : NOMBRE_TERMINAL.test(e.nombre));

/**
 * Etapa a la que pasa un ticket cuando alguien lo toma, igual que el portal
 * (sozu-admin, portal-tickets/estado.ts → etapaAtencion): «En atención» si el
 * pipeline la tiene; si no, «En proceso» o la primera etapa de trabajo.
 */
function etapaAtencion(etapas: EtapaPortal[]): EtapaPortal | undefined {
  const vivas = etapas.filter((e) => !esTerminal(e)).sort((a, b) => a.orden - b.orden);
  return (
    vivas.find((e) => sinAcentos(e.nombre).includes("atencion")) ??
    vivas.find((e) => sinAcentos(e.nombre).includes("en proceso")) ??
    vivas.find((e) => e.tipo_semantico === "en_proceso") ??
    vivas[1]
  );
}

/** Quién trabaja el ticket: su único propietario, si está en la etapa de atención (como el portal). */
function atendidoPor(propietarios: string[], idEtapa: number, etapas: EtapaPortal[]): string | null {
  if (propietarios.length !== 1) return null;
  return etapaAtencion(etapas)?.id === idEtapa ? propietarios[0] : null;
}

async function etapasPorPipeline(sb: SupabaseClient, pipelines: number[]): Promise<Map<number, EtapaPortal[]>> {
  const por = new Map<number, EtapaPortal[]>();
  if (pipelines.length === 0) return por;
  const { data, error } = await sb
    .from("tickets_etapas")
    .select("id, nombre, orden, tipo_semantico, cerrada, id_pipeline")
    .in("id_pipeline", pipelines)
    .eq("activo", true);
  if (error) throw error;
  for (const e of data ?? []) por.set(e.id_pipeline, [...(por.get(e.id_pipeline) ?? []), e]);
  return por;
}

const propietariosDe = (t: Fila): string[] => {
  const ids = new Set<string>((t.tickets_propietarios ?? []).map((p: Fila) => p.id_usuario));
  if (t.id_usuario_propietario) ids.add(t.id_usuario_propietario);
  return [...ids];
};

export function clienteSupabase(serviceKey: string): SupabaseClient {
  return createClient(SUPABASE_URL, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Usuario del portal de quien entra al dashboard. No siempre es el mismo correo:
 * hay quien entra al dashboard con su cuenta de Google de otro dominio
 * (eduardo.araujo@investimento.mx) y en el portal es eduardo.araujo@sozu.com.
 * Se prueba, en orden: el mismo correo, el `correoPortal` de su ficha en
 * `users/{email}` (para casos que no sigan la regla) y el mismo usuario en
 * @sozu.com.
 */
export async function usuarioPortal(sb: SupabaseClient, email: string): Promise<{ auth_user_id: string; email: string } | null> {
  const ficha = (await getFirestore().doc(`users/${email}`).get().catch(() => null))?.data();
  const explicito = typeof ficha?.correoPortal === "string" ? ficha.correoPortal.trim().toLowerCase() : "";
  const local = email.split("@")[0];
  const candidatos = [...new Set([email, explicito, `${local}@sozu.com`].filter(Boolean))];
  for (const c of candidatos) {
    const { data, error } = await sb.from("usuarios").select("auth_user_id, email").ilike("email", c).limit(1).maybeSingle();
    if (error) throw error;
    if (data?.auth_user_id) return { auth_user_id: data.auth_user_id, email: data.email };
  }
  return null;
}

export async function ticketsAsignados(sb: SupabaseClient, email: string): Promise<TicketSalida[]> {
  const yo = await usuarioPortal(sb, email);
  if (!yo) return [];
  const uid: string = yo.auth_user_id;

  // Ids de tickets: por la tabla N:N y por la columna legada.
  const [{ data: props, error: e2 }, { data: legado, error: e3 }] = await Promise.all([
    sb.from("tickets_propietarios").select("id_ticket").eq("id_usuario", uid),
    sb.from("tickets").select("id").eq("id_usuario_propietario", uid).eq("activo", true),
  ]);
  if (e2) throw e2;
  if (e3) throw e3;
  const ids = [...new Set([...(props ?? []).map((p: Fila) => p.id_ticket), ...(legado ?? []).map((t: Fila) => t.id)])];
  if (ids.length === 0) return [];

  const { data: filas, error: e4 } = await sb
    .from("tickets")
    .select(
      `id, numero, nombre, descripcion, fecha_creacion, prioridad, solicitante, id_usuario_creador,
       id_usuario_propietario, id_entidad_relacionada,
       id_pipeline, id_etapa,
       tickets_etapas(nombre, tipo_semantico), tickets_pipelines(*), tickets_categorias(nombre),
       proyectos(nombre), tickets_propietarios(id_usuario),
       tickets_adjuntos(nombre, tipo, url, activo), tickets_solicitantes(id_entidad_relacionada)`,
    )
    .in("id", ids)
    .eq("activo", true)
    .order("fecha_creacion", { ascending: false });
  if (e4) throw e4;

  // Pipelines con asistente y etapas Nuevo / En revisión / En lista de espera, más los que
  // atiendo yo (los que atiende otro ya no me tienen de propietario). Orden: prioridad
  // (alta → media → baja → sin) y, dentro de cada una, el más antiguo primero.
  const conAsistente = (filas ?? []).filter((t: Fila) => pipelineConAsistente(uno<Fila>(t.tickets_pipelines)));
  const etapas = await etapasPorPipeline(sb, [...new Set<number>(conAsistente.map((t: Fila) => t.id_pipeline))]);
  const loAtiendo = (t: Fila) => atendidoPor(propietariosDe(t), t.id_etapa, etapas.get(t.id_pipeline) ?? []) === uid;
  const pendientes = conAsistente
    .filter((t: Fila) => {
      const etapa = uno<Fila>(t.tickets_etapas);
      return ETAPAS_VISIBLES.includes(sinAcentos(etapa?.nombre ?? "")) || etapa?.tipo_semantico === "abierta" || loAtiendo(t);
    })
    .sort((a: Fila, b: Fila) =>
      (ORDEN_PRIORIDAD[a.prioridad] ?? 3) - (ORDEN_PRIORIDAD[b.prioridad] ?? 3) ||
      Date.parse(a.fecha_creacion) - Date.parse(b.fecha_creacion))
    .slice(0, MAX_TICKETS);
  if (pendientes.length === 0) return [];

  // Nombres de asignados y creadores en una sola consulta.
  const uids = new Set<string>();
  for (const t of pendientes) {
    for (const p of t.tickets_propietarios ?? []) uids.add(p.id_usuario);
    if (t.id_usuario_propietario) uids.add(t.id_usuario_propietario);
    if (t.id_usuario_creador) uids.add(t.id_usuario_creador);
  }
  const { data: usuarios, error: e5 } = await sb
    .from("usuarios")
    .select("auth_user_id, nombre, email")
    .in("auth_user_id", [...uids]);
  if (e5) throw e5;
  const porUid = new Map((usuarios ?? []).map((u: Fila) => [u.auth_user_id, u]));

  // Solicitantes (contactos del CRM): entidades_relacionadas → personas.
  const entidades = new Set<number>();
  for (const t of pendientes) {
    for (const s of t.tickets_solicitantes ?? []) entidades.add(s.id_entidad_relacionada);
    if (t.id_entidad_relacionada) entidades.add(t.id_entidad_relacionada);
  }
  const nombrePorEntidad = new Map<number, string>();
  if (entidades.size) {
    const { data: ents } = await sb
      .from("entidades_relacionadas")
      .select("id, personas(nombre_legal, nombre_comercial)")
      .in("id", [...entidades]);
    for (const e of ents ?? []) {
      const p = uno<Fila>(e.personas);
      const n = p?.nombre_legal || p?.nombre_comercial;
      if (n) nombrePorEntidad.set(e.id, n);
    }
  }

  return pendientes.map((t: Fila): TicketSalida => {
    const asignados = propietariosDe(t)
      .map((id) => {
        const u = porUid.get(id);
        return { nombre: u?.nombre ?? "Usuario sin nombre", email: u?.email ?? null, soyYo: id === uid };
      })
      .sort((a, b) => Number(b.soyYo) - Number(a.soyYo) || a.nombre.localeCompare(b.nombre));

    const creador = t.id_usuario_creador ? porUid.get(t.id_usuario_creador)?.nombre : null;
    const solicitantes = (t.tickets_solicitantes ?? [])
      .map((s: Fila) => nombrePorEntidad.get(s.id_entidad_relacionada))
      .filter(Boolean);
    const solicitante =
      solicitantes.join(", ") || nombrePorEntidad.get(t.id_entidad_relacionada) || t.solicitante || null;
    // "Ramon" y "Ramón" son la misma persona: se compara sin acentos ni mayúsculas.
    const mismo = (a: string, b: string) => sinAcentos(a) === sinAcentos(b);
    const abiertoPor =
      creador && solicitante && !mismo(creador, solicitante) ? `${creador} (solicitante: ${solicitante})` : creador ?? solicitante;

    return {
      id: String(t.id),
      numero: t.numero,
      folio: `#${t.numero}`,
      pipelineId: String(t.id_pipeline),
      etapaId: String(t.id_etapa),
      titulo: t.nombre ?? "(sin asunto)",
      descripcion: t.descripcion ?? "",
      etapa: uno<Fila>(t.tickets_etapas)?.nombre ?? null,
      pipeline: uno<Fila>(t.tickets_pipelines)?.nombre ?? null,
      categoria: uno<Fila>(t.tickets_categorias)?.nombre ?? null,
      creadorEmail: (t.id_usuario_creador && porUid.get(t.id_usuario_creador)?.email) || null,
      proyecto: uno<Fila>(t.proyectos)?.nombre ?? null,
      prioridad: t.prioridad && t.prioridad !== "sin" ? t.prioridad : null,
      abiertoPor,
      abiertoEn: comoUtc(t.fecha_creacion),
      asignados,
      loAtiendoYo: loAtiendo(t),
      evidencias: (t.tickets_adjuntos ?? [])
        .filter((a: Fila) => a.activo !== false)
        .map((a: Fila) => ({ nombre: a.nombre ?? "archivo", tipo: tipoEvidencia(a.tipo), url: a.url ?? null })),
      url: urlTicket(t.numero),
    };
  });
}

/**
 * «Yo trabajo el ticket» como lo hace el portal (tickets-store.tsx → tomarTicket):
 * quien lo toma queda como único propietario (sale de los pendientes de los demás
 * asignados), el ticket pasa a la etapa de atención y queda la nota de
 * seguimiento. Lo usa «Mandar a Claude». Si otra persona ya lo atiende, no se le
 * quita; si ya lo atiendo yo, no hace nada.
 */
export async function tomarTicket(sb: SupabaseClient, email: string, idTicket: number, nota: string): Promise<void> {
  const yo = await usuarioPortal(sb, email);
  if (!yo) throw new Error("sin_usuario_portal");
  const uid: string = yo.auth_user_id;

  const { data: t, error: e2 } = await sb
    .from("tickets")
    .select("id, id_pipeline, id_etapa, id_usuario_propietario, activo, tickets_propietarios(id_usuario)")
    .eq("id", idTicket)
    .maybeSingle();
  if (e2) throw e2;
  if (!t || !t.activo) throw new Error("no_existe");
  const etapas = (await etapasPorPipeline(sb, [t.id_pipeline])).get(t.id_pipeline) ?? [];
  const otro = atendidoPor(propietariosDe(t), t.id_etapa, etapas);
  if (otro === uid) return;
  if (otro) throw new Error("lo_atiende_otro");
  const destino = etapaAtencion(etapas);

  const { error: e3 } = await sb.from("tickets_propietarios").delete().eq("id_ticket", idTicket);
  if (e3) throw e3;
  const { error: e4 } = await sb.from("tickets_propietarios").insert({ id_ticket: idTicket, id_usuario: uid });
  if (e4) throw e4;
  const cambiaEtapa = !!destino && destino.id !== t.id_etapa;
  const { error: e5 } = await sb
    .from("tickets")
    .update({ id_usuario_propietario: uid, ...(cambiaEtapa ? { id_etapa: destino.id, fecha_cierre: null } : {}) })
    .eq("id", idTicket);
  if (e5) throw e5;
  const actividad: Record<string, unknown>[] = [];
  if (cambiaEtapa)
    actividad.push({
      id_ticket: idTicket, texto: `Etapa actualizada a "${destino.nombre}".`, tipo: "cambio_estado",
      id_usuario_autor: uid, visible_cliente: false, id_etapa_origen: t.id_etapa, id_etapa_destino: destino.id,
    });
  actividad.push({ id_ticket: idTicket, texto: nota, tipo: "nota", id_usuario_autor: uid, visible_cliente: false });
  const { error: e6 } = await sb.from("tickets_actividad").insert(actividad);
  if (e6) throw e6;
}

/**
 * Cierra un ticket como lo haría el portal (tickets-store.tsx → moverEtapa):
 * nota de seguimiento, etapa "resuelta" del mismo pipeline con fecha_cierre, y
 * el registro `cambio_estado` con origen/destino. Solo si el ticket está asignado
 * a quien cierra y es de un pipeline con asistente. Autor = el usuario del portal
 * con ese email (queda a su nombre, no a nombre de un robot).
 */
export async function cerrarTicket(sb: SupabaseClient, email: string, idTicket: number, nota: string): Promise<{ etapa: string }> {
  const yo = await usuarioPortal(sb, email);
  if (!yo) throw new Error("sin_usuario_portal");
  return pasarAResuelto(sb, yo.auth_user_id, idTicket, nota, true);
}

/**
 * Pasa el ticket a la etapa resuelta de su pipeline con la nota a nombre de
 * `uid`. `exigirPropietario` = false solo para los relacionados que se cierran
 * en cascada con el principal (quien cierra lo pidió explícitamente).
 */
async function pasarAResuelto(sb: SupabaseClient, uid: string, idTicket: number, nota: string, exigirPropietario: boolean): Promise<{ etapa: string }> {
  const { data: t, error: e2 } = await sb
    .from("tickets")
    .select("id, id_pipeline, id_etapa, id_usuario_propietario, activo, tickets_pipelines(*), tickets_propietarios(id_usuario)")
    .eq("id", idTicket)
    .maybeSingle();
  if (e2) throw e2;
  if (!t || !t.activo) throw new Error("no_existe");
  const propietarios = ((t.tickets_propietarios ?? []) as Fila[]).map((p) => p.id_usuario);
  if (exigirPropietario && !propietarios.includes(uid) && t.id_usuario_propietario !== uid) throw new Error("no_es_tuyo");
  if (!pipelineConAsistente(uno<Fila>(t.tickets_pipelines))) throw new Error("pipeline_no_permitido");

  const { data: destino, error: e3 } = await sb
    .from("tickets_etapas")
    .select("id, nombre, cerrada")
    .eq("id_pipeline", t.id_pipeline)
    .eq("tipo_semantico", "resuelta")
    .eq("activo", true)
    .order("orden")
    .limit(1)
    .maybeSingle();
  if (e3) throw e3;
  if (!destino) throw new Error("sin_etapa_resuelta");

  const texto = nota.trim().slice(0, 6000);
  if (texto) {
    const { error } = await sb.from("tickets_actividad").insert({
      id_ticket: idTicket, texto, tipo: "nota", id_usuario_autor: uid, visible_cliente: false,
    });
    if (error) throw error;
  }
  const { error: e4 } = await sb
    .from("tickets")
    .update({ id_etapa: destino.id, fecha_cierre: destino.cerrada ? new Date().toISOString() : null })
    .eq("id", idTicket);
  if (e4) throw e4;
  const { error: e5 } = await sb.from("tickets_actividad").insert({
    id_ticket: idTicket,
    texto: `Etapa actualizada a "${destino.nombre}".`,
    tipo: "cambio_estado",
    id_usuario_autor: uid,
    visible_cliente: false,
    id_etapa_origen: t.id_etapa,
    id_etapa_destino: destino.id,
  });
  if (e5) throw e5;
  return { etapa: destino.nombre };
}

// --- Tickets relacionados («¿Ya lo había reportado antes?» del portal) -----------

/**
 * Otro ticket ligado por `tickets.id_ticket_relacionado`: el anterior al que
 * apunta este ticket, o uno posterior que apunta a este. Al cerrar uno desde el
 * dashboard se cierran también los relacionados que sigan abiertos (un nivel:
 * los directos).
 */
export interface TicketRelacionado {
  id: string;
  numero: number;
  folio: string;
  titulo: string;
  etapa: string | null;
  cerrado: boolean;
  relacion: "anterior" | "posterior";
  /** Está en un pipeline que el dashboard puede cerrar (los del asistente). */
  sePuedeCerrar: boolean;
  url: string;
}

const SELECT_REL = "id, numero, nombre, activo, id_ticket_relacionado, tickets_etapas(nombre, tipo_semantico, cerrada), tickets_pipelines(*)";

function comoRelacionado(f: Fila, relacion: TicketRelacionado["relacion"]): TicketRelacionado {
  const e = uno<Fila>(f.tickets_etapas);
  return {
    id: String(f.id),
    numero: Number(f.numero),
    folio: `#${f.numero}`,
    titulo: String(f.nombre ?? ""),
    etapa: e?.nombre ?? null,
    cerrado: !!e?.cerrada || TIPOS_TERMINALES.has(e?.tipo_semantico ?? ""),
    relacion,
    sePuedeCerrar: pipelineConAsistente(uno<Fila>(f.tickets_pipelines)),
    url: urlTicket(Number(f.numero)),
  };
}

/** Relacionados de cada ticket. Sin la columna en el ambiente (o si falla), vacío. */
export async function relacionadosDe(sb: SupabaseClient, ids: number[]): Promise<Map<number, TicketRelacionado[]>> {
  const salida = new Map<number, TicketRelacionado[]>();
  if (!ids.length) return salida;
  const agregar = (id: number, r: TicketRelacionado) => salida.set(id, [...(salida.get(id) ?? []), r]);
  const [propios, posteriores] = await Promise.all([
    sb.from("tickets").select("id, id_ticket_relacionado").in("id", ids).not("id_ticket_relacionado", "is", null),
    sb.from("tickets").select(SELECT_REL).in("id_ticket_relacionado", ids).eq("activo", true),
  ]);
  if (propios.error || posteriores.error) return salida;
  for (const f of posteriores.data ?? []) agregar(Number(f.id_ticket_relacionado), comoRelacionado(f, "posterior"));
  const anteriores = [...new Set((propios.data ?? []).map((f: Fila) => Number(f.id_ticket_relacionado)))];
  if (anteriores.length) {
    const { data, error } = await sb.from("tickets").select(SELECT_REL).in("id", anteriores).eq("activo", true);
    if (!error) {
      const porId = new Map((data ?? []).map((f: Fila) => [Number(f.id), f]));
      for (const f of propios.data ?? []) {
        const rel = porId.get(Number(f.id_ticket_relacionado));
        if (rel) agregar(Number(f.id), comoRelacionado(rel, "anterior"));
      }
    }
  }
  return salida;
}

/**
 * Cierra en cascada los relacionados abiertos del ticket que se acaba de cerrar,
 * con una nota que dice con cuál se cerraron. Los que no se pueden (otro
 * pipeline, ya no existen) se reportan sin detener a los demás.
 */
export async function cerrarRelacionados(
  sb: SupabaseClient,
  email: string,
  relacionados: TicketRelacionado[],
  folioPrincipal: string,
): Promise<{ cerrados: string[]; fallidos: string[] }> {
  const yo = await usuarioPortal(sb, email);
  const cerrados: string[] = [];
  const fallidos: string[] = [];
  if (!yo) return { cerrados, fallidos: relacionados.filter((r) => !r.cerrado).map((r) => r.folio) };
  for (const r of relacionados.filter((x) => !x.cerrado)) {
    try {
      await pasarAResuelto(
        sb,
        yo.auth_user_id,
        Number(r.id),
        `Se cierra junto con el ticket relacionado ${folioPrincipal}, desde el dashboard de cambios: lo que se resolvió ahí resuelve también este.`,
        false,
      );
      cerrados.push(r.folio);
    } catch (e) {
      console.warn(`[cerrarRelacionados] ${r.folio}`, (e as Error).message);
      fallidos.push(r.folio);
    }
  }
  return { cerrados, fallidos };
}
