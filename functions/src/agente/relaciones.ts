/**
 * Tickets relacionados a mano desde el detalle del ticket en el dashboard.
 *
 * El portal guarda una sola relación por ticket (`tickets.id_ticket_relacionado`),
 * abierto o cerrado (migración 20261031140000 de sozu-supabase-migrations). La liga
 * se guarda ahí en el lado que esté libre: este ticket apunta al otro o, si ya
 * apunta a uno, el otro a este; así el portal la ve y la marca. Solo si los dos ya
 * tienen relación (o la BD la rechaza) queda en Firestore
 * `agente_tickets_relaciones/{menor}_{mayor}`, que solo ve el dashboard. Las de
 * Firestore se pasan al portal en cuanto se leen y hay un lado libre. Las dos
 * cuentan igual para cerrar en cascada (ver `cerrarRelacionados`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { comoRelacionado, relacionadosDe, SELECT_REL, usuarioPortal, type TicketRelacionado } from "./tickets.js";

const COL = "agente_tickets_relaciones";
const idPar = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

/**
 * Guarda la liga en `tickets.id_ticket_relacionado` del lado libre: `idTicket` apunta
 * a `idRel` ("anterior") o, si ya apunta a otro, `idRel` a `idTicket` ("posterior").
 * null = los dos lados ocupados o la BD la rechazó.
 */
async function ligarEnPortal(sb: SupabaseClient, idTicket: number, idRel: number): Promise<"anterior" | "posterior" | null> {
  const { data, error } = await sb.from("tickets").select("id, id_ticket_relacionado").in("id", [idTicket, idRel]);
  if (error) return null;
  const libre = (id: number) => {
    const f = (data ?? []).find((r) => Number(r.id) === id);
    return !!f && !f.id_ticket_relacionado;
  };
  const lados: [number, number, "anterior" | "posterior"][] = [[idTicket, idRel, "anterior"], [idRel, idTicket, "posterior"]];
  for (const [desde, hacia, relacion] of lados) {
    if (!libre(desde)) continue;
    const { error: e2 } = await sb.from("tickets").update({ id_ticket_relacionado: hacia }).eq("id", desde);
    if (!e2) return relacion;
  }
  return null;
}

/** Pasa al portal las ligas de Firestore que ya caben ahí; las que no, se quedan. */
async function pasarAlPortal(sb: SupabaseClient, pares: Map<string, [number, number]>): Promise<void> {
  await Promise.allSettled(
    [...pares].map(async ([doc, [a, b]]) => {
      if (await ligarEnPortal(sb, a, b)) {
        await getFirestore().doc(`${COL}/${doc}`).delete();
        pares.delete(doc);
      }
    }),
  );
}

/** Relacionados del portal más los ligados desde el dashboard, sin repetir. */
export async function relacionadosConDashboard(sb: SupabaseClient, ids: number[]): Promise<Map<number, TicketRelacionado[]>> {
  if (!ids.length) return relacionadosDe(sb, ids);
  const pares = new Map<string, [number, number]>();
  for (let i = 0; i < ids.length; i += 30) {
    const snap = await getFirestore().collection(COL).where("ids", "array-contains-any", ids.slice(i, i + 30)).get();
    for (const d of snap.docs) {
      const [a, b] = (d.data().ids ?? []).map(Number);
      if (a && b) pares.set(d.id, [a, b]);
    }
  }
  if (pares.size) await pasarAlPortal(sb, pares);
  // Después de pasar las ligas, para que las que ya están en el portal salgan como del portal.
  const salida = await relacionadosDe(sb, ids);
  if (!pares.size) return salida;
  const propios = new Set(ids);
  const otros = new Set<number>();
  for (const [a, b] of pares.values()) {
    if (propios.has(a)) otros.add(b);
    if (propios.has(b)) otros.add(a);
  }
  const { data, error } = await sb.from("tickets").select(SELECT_REL).in("id", [...otros]).eq("activo", true);
  if (error) return salida;
  const porId = new Map((data ?? []).map((f) => [Number(f.id), f]));
  const agregar = (id: number, otro: number) => {
    const f = porId.get(otro);
    const ya = salida.get(id) ?? [];
    if (!f || ya.some((r) => Number(r.id) === otro)) return;
    salida.set(id, [...ya, comoRelacionado(f, "dashboard")]);
  };
  for (const [a, b] of pares.values()) {
    if (propios.has(a)) agregar(a, b);
    if (propios.has(b)) agregar(b, a);
  }
  return salida;
}

async function nota(sb: SupabaseClient, email: string, idTicket: number, texto: string) {
  const yo = await usuarioPortal(sb, email);
  if (!yo) return;
  await sb.from("tickets_actividad").insert({
    id_ticket: idTicket, texto, tipo: "nota", id_usuario_autor: yo.auth_user_id, visible_cliente: false,
  });
}

/** Liga `idTicket` con el ticket de folio `numero`. Devuelve el relacionado como lo verá el panel. */
export async function relacionarTicket(sb: SupabaseClient, email: string, idTicket: number, numero: number): Promise<TicketRelacionado> {
  const { data: f, error } = await sb.from("tickets").select(SELECT_REL).eq("numero", numero).eq("activo", true).maybeSingle();
  if (error) throw error;
  if (!f) throw new Error("rel_no_existe");
  const idRel = Number(f.id);
  if (idRel === idTicket) throw new Error("rel_mismo");
  const ya = (await relacionadosConDashboard(sb, [idTicket])).get(idTicket) ?? [];
  if (ya.some((r) => Number(r.id) === idRel)) throw new Error("rel_ya");

  const rel = comoRelacionado(f, "dashboard");
  // El trigger del portal decide (existe, activo, no el mismo); si lo rechaza, va a Firestore.
  const enPortal = await ligarEnPortal(sb, idTicket, idRel);
  if (!enPortal) {
    await getFirestore().doc(`${COL}/${idPar(idTicket, idRel)}`).set({
      ids: [idTicket, idRel], creadoPor: email, creadoEn: FieldValue.serverTimestamp(),
    });
  }
  await nota(sb, email, idTicket, `Se relaciona con el ticket #${numero} desde el dashboard de cambios: al cerrar uno se cierra también el otro.`).catch(() => {});
  return { ...rel, relacion: enPortal ?? "dashboard" };
}

/**
 * Quita la relación de `idTicket` con `idRel`: la de Firestore o la del portal, en
 * el lado que la tenga (el dashboard la guarda en el que estaba libre).
 */
export async function desligarTicket(sb: SupabaseClient, email: string, idTicket: number, idRel: number): Promise<void> {
  const ref = getFirestore().doc(`${COL}/${idPar(idTicket, idRel)}`);
  let quitado = false;
  if ((await ref.get()).exists) {
    await ref.delete();
    quitado = true;
  }
  const lados: [number, number][] = [[idTicket, idRel], [idRel, idTicket]];
  for (const [desde, hacia] of lados) {
    const { data: fila } = await sb.from("tickets").select("id_ticket_relacionado").eq("id", desde).maybeSingle();
    if (Number(fila?.id_ticket_relacionado) !== hacia) continue;
    const { error } = await sb.from("tickets").update({ id_ticket_relacionado: null }).eq("id", desde);
    if (error) throw error;
    quitado = true;
  }
  if (!quitado) throw new Error("rel_del_otro");
  const { data: otro } = await sb.from("tickets").select("numero").eq("id", idRel).maybeSingle();
  await nota(sb, email, idTicket, `Se quita la relación con el ticket #${otro?.numero ?? idRel} desde el dashboard de cambios.`).catch(() => {});
}
