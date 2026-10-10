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

export const SUPABASE_URL = "https://tzmhgfjmddkfyffkkmto.supabase.co";
/** Lo más cercano a un enlace directo: el portal no abre un ticket por URL. */
const URL_PORTAL = "https://admin.sozu.com/admin/portal-tickets/todos?tab=mios";
const PENDIENTES = ["abierta", "en_proceso"];
const MAX_TICKETS = 50;

export interface TicketSalida {
  id: string;
  folio: string;
  titulo: string;
  descripcion: string;
  etapa: string | null;
  pipeline: string | null;
  categoria: string | null;
  proyecto: string | null;
  prioridad: string | null;
  abiertoPor: string | null;
  abiertoEn: string;
  asignados: { nombre: string; email: string | null; soyYo: boolean }[];
  evidencias: { nombre: string; tipo: "imagen" | "audio" | "documento" | "otro"; url: string | null }[];
  url: string | null;
}

// deno-lint-ignore no-explicit-any
type Fila = any;

const tipoEvidencia = (t: string | null): TicketSalida["evidencias"][number]["tipo"] =>
  t === "foto" ? "imagen" : t === "audio" ? "audio" : t === "documento" ? "documento" : "otro";

const uno = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

export function clienteSupabase(serviceKey: string): SupabaseClient {
  return createClient(SUPABASE_URL, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function ticketsAsignados(sb: SupabaseClient, email: string): Promise<TicketSalida[]> {
  const { data: yo, error: e1 } = await sb
    .from("usuarios")
    .select("auth_user_id, nombre, email")
    .ilike("email", email)
    .limit(1)
    .maybeSingle();
  if (e1) throw e1;
  if (!yo?.auth_user_id) return [];
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
       tickets_etapas(nombre, tipo_semantico), tickets_pipelines(nombre), tickets_categorias(nombre),
       proyectos(nombre), tickets_propietarios(id_usuario),
       tickets_adjuntos(nombre, tipo, url, activo), tickets_solicitantes(id_entidad_relacionada)`,
    )
    .in("id", ids)
    .eq("activo", true)
    .order("fecha_creacion", { ascending: false });
  if (e4) throw e4;

  const pendientes = (filas ?? [])
    .filter((t: Fila) => PENDIENTES.includes(uno<Fila>(t.tickets_etapas)?.tipo_semantico))
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
    const abiertoPor =
      creador && solicitante && creador !== solicitante ? `${creador} (solicitante: ${solicitante})` : creador ?? solicitante;

    return {
      id: String(t.id),
      folio: `#${t.numero}`,
      titulo: t.nombre ?? "(sin asunto)",
      descripcion: t.descripcion ?? "",
      etapa: uno<Fila>(t.tickets_etapas)?.nombre ?? null,
      pipeline: uno<Fila>(t.tickets_pipelines)?.nombre ?? null,
      categoria: uno<Fila>(t.tickets_categorias)?.nombre ?? null,
      proyecto: uno<Fila>(t.proyectos)?.nombre ?? null,
      prioridad: t.prioridad && t.prioridad !== "sin" ? t.prioridad : null,
      abiertoPor,
      abiertoEn: t.fecha_creacion,
      asignados,
      evidencias: (t.tickets_adjuntos ?? [])
        .filter((a: Fila) => a.activo !== false)
        .map((a: Fila) => ({ nombre: a.nombre ?? "archivo", tipo: tipoEvidencia(a.tipo), url: a.url ?? null })),
      url: URL_PORTAL,
    };
  });
}
