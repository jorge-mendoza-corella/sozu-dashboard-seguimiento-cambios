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

export const SUPABASE_URL = "https://tzmhgfjmddkfyffkkmto.supabase.co";
/** Enlace directo (sozu-admin abre Mis tickets → pipeline → folio → detalle con ?ticket=). */
const urlTicket = (numero: number) => `https://admin.sozu.com/admin/portal-tickets/todos?ticket=${numero}`;
/** Solo los pipelines de Sistemas ("SOZU - Sistemas Soporte técnico", "… Nuevos Features", …). */
const PIPELINE_SISTEMAS = /sozu\s*-?\s*sistemas/i;
/** Etapas que le tocan a quien atiende; las demás (en atención, detenido…) no se muestran. */
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
  /**
   * Correos de los titulares (personas) de la categoría, en el orden en que se
   * dieron de alta. Los titulares por rol no entran. Con esto el panel elige
   * qué avatar de GeorgIA avisa y trabaja el ticket.
   */
  titulares: string[];
  proyecto: string | null;
  prioridad: string | null;
  abiertoPor: string | null;
  abiertoEn: string;
  asignados: { nombre: string; email: string | null; soyYo: boolean }[];
  evidencias: { nombre: string; tipo: "imagen" | "audio" | "video" | "documento" | "otro"; url: string | null }[];
  url: string | null;
}

// deno-lint-ignore no-explicit-any
type Fila = any;

const tipoEvidencia = (t: string | null): TicketSalida["evidencias"][number]["tipo"] =>
  t === "foto" ? "imagen" : t === "audio" ? "audio" : t === "video" ? "video" : t === "documento" ? "documento" : "otro";

export const sinAcentos = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

const uno = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

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
       id_pipeline, id_etapa, id_categoria,
       tickets_etapas(nombre, tipo_semantico), tickets_pipelines(nombre), tickets_categorias(nombre),
       proyectos(nombre), tickets_propietarios(id_usuario),
       tickets_adjuntos(nombre, tipo, url, activo), tickets_solicitantes(id_entidad_relacionada)`,
    )
    .in("id", ids)
    .eq("activo", true)
    .order("fecha_creacion", { ascending: false });
  if (e4) throw e4;

  // Pipelines de Sistemas y etapas Nuevo / En revisión / En lista de espera. Orden: prioridad
  // (alta → media → baja → sin) y, dentro de cada una, el más antiguo primero.
  const pendientes = (filas ?? [])
    .filter((t: Fila) => PIPELINE_SISTEMAS.test(uno<Fila>(t.tickets_pipelines)?.nombre ?? ""))
    .filter((t: Fila) => ETAPAS_VISIBLES.includes(sinAcentos(uno<Fila>(t.tickets_etapas)?.nombre ?? "")))
    .sort((a: Fila, b: Fila) =>
      (ORDEN_PRIORIDAD[a.prioridad] ?? 3) - (ORDEN_PRIORIDAD[b.prioridad] ?? 3) ||
      Date.parse(a.fecha_creacion) - Date.parse(b.fecha_creacion))
    .slice(0, MAX_TICKETS);
  if (pendientes.length === 0) return [];

  // Titulares (personas) de las categorías de estos tickets.
  const categorias = [...new Set(pendientes.map((t: Fila) => t.id_categoria).filter((c: unknown) => c != null))];
  const titularesPorCategoria = new Map<number, string[]>();
  if (categorias.length) {
    const { data: tits, error: e6 } = await sb
      .from("tickets_categorias_usuarios")
      .select("id_categoria, id_usuario")
      .in("id_categoria", categorias)
      .order("id", { ascending: true });
    if (e6) throw e6;
    for (const r of tits ?? []) {
      const l = titularesPorCategoria.get(r.id_categoria) ?? [];
      l.push(r.id_usuario);
      titularesPorCategoria.set(r.id_categoria, l);
    }
  }

  // Nombres de asignados, creadores y titulares en una sola consulta.
  const uids = new Set<string>();
  for (const l of titularesPorCategoria.values()) for (const u of l) uids.add(u);
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
    const asignadosUids = new Set<string>((t.tickets_propietarios ?? []).map((p: Fila) => p.id_usuario));
    if (t.id_usuario_propietario) asignadosUids.add(t.id_usuario_propietario);
    const asignados = [...asignadosUids]
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
      titulares: (titularesPorCategoria.get(t.id_categoria) ?? [])
        .map((u) => porUid.get(u)?.email as string | undefined)
        .filter((e): e is string => !!e),
      proyecto: uno<Fila>(t.proyectos)?.nombre ?? null,
      prioridad: t.prioridad && t.prioridad !== "sin" ? t.prioridad : null,
      abiertoPor,
      abiertoEn: t.fecha_creacion,
      asignados,
      evidencias: (t.tickets_adjuntos ?? [])
        .filter((a: Fila) => a.activo !== false)
        .map((a: Fila) => ({ nombre: a.nombre ?? "archivo", tipo: tipoEvidencia(a.tipo), url: a.url ?? null })),
      url: urlTicket(t.numero),
    };
  });
}

/**
 * Cierra un ticket como lo haría el portal (tickets-store.tsx → moverEtapa):
 * nota de seguimiento, etapa "resuelta" del mismo pipeline con fecha_cierre, y
 * el registro `cambio_estado` con origen/destino. Solo si el ticket está asignado
 * a quien cierra y es de un pipeline de Sistemas. Autor = el usuario del portal
 * con ese email (queda a su nombre, no a nombre de un robot).
 */
export async function cerrarTicket(sb: SupabaseClient, email: string, idTicket: number, nota: string): Promise<{ etapa: string }> {
  const yo = await usuarioPortal(sb, email);
  if (!yo) throw new Error("sin_usuario_portal");
  const uid: string = yo.auth_user_id;

  const { data: t, error: e2 } = await sb
    .from("tickets")
    .select("id, id_pipeline, id_etapa, id_usuario_propietario, activo, tickets_pipelines(nombre), tickets_propietarios(id_usuario)")
    .eq("id", idTicket)
    .maybeSingle();
  if (e2) throw e2;
  if (!t || !t.activo) throw new Error("no_existe");
  const propietarios = ((t.tickets_propietarios ?? []) as Fila[]).map((p) => p.id_usuario);
  if (!propietarios.includes(uid) && t.id_usuario_propietario !== uid) throw new Error("no_es_tuyo");
  if (!PIPELINE_SISTEMAS.test(uno<Fila>(t.tickets_pipelines)?.nombre ?? "")) throw new Error("pipeline_no_permitido");

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
