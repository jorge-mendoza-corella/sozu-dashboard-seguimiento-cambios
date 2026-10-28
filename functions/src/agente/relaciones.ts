/**
 * Tickets relacionados a mano desde el detalle del ticket en el dashboard.
 *
 * El portal guarda una sola relación por ticket (`tickets.id_ticket_relacionado`)
 * y su trigger solo acepta un ticket anterior ya cerrado. Cuando el ticket que
 * se liga está cerrado y este aún no apunta a otro, se guarda ahí (el portal lo
 * ve igual); si no (está abierto, o ya hay uno), queda en Firestore
 * `agente_tickets_relaciones/{menor}_{mayor}` y solo lo ve el dashboard. Las dos
 * cuentan igual para cerrar en cascada (ver `cerrarRelacionados`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { comoRelacionado, relacionadosDe, SELECT_REL, usuarioPortal, type TicketRelacionado } from "./tickets.js";

const COL = "agente_tickets_relaciones";
const idPar = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

/** Relacionados del portal más los ligados desde el dashboard, sin repetir. */
export async function relacionadosConDashboard(sb: SupabaseClient, ids: number[]): Promise<Map<number, TicketRelacionado[]>> {
  const salida = await relacionadosDe(sb, ids);
  if (!ids.length) return salida;
  const pares = new Map<string, [number, number]>();
  for (let i = 0; i < ids.length; i += 30) {
    const snap = await getFirestore().collection(COL).where("ids", "array-contains-any", ids.slice(i, i + 30)).get();
    for (const d of snap.docs) {
      const [a, b] = (d.data().ids ?? []).map(Number);
      if (a && b) pares.set(d.id, [a, b]);
    }
  }
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
  const { data: propio } = await sb.from("tickets").select("id_ticket_relacionado").eq("id", idTicket).maybeSingle();
  let enPortal = false;
  if (rel.cerrado && propio && !propio.id_ticket_relacionado) {
    // El trigger del portal decide (exige etapa con `cerrada`); si lo rechaza, va a Firestore.
    const { error: e2 } = await sb.from("tickets").update({ id_ticket_relacionado: idRel }).eq("id", idTicket);
    enPortal = !e2;
  }
  if (!enPortal) {
    await getFirestore().doc(`${COL}/${idPar(idTicket, idRel)}`).set({
      ids: [idTicket, idRel], creadoPor: email, creadoEn: FieldValue.serverTimestamp(),
    });
  }
  await nota(sb, email, idTicket, `Se relaciona con el ticket #${numero} desde el dashboard de cambios: al cerrar uno se cierra también el otro.`).catch(() => {});
  return { ...rel, relacion: enPortal ? "anterior" : "dashboard" };
}

/**
 * Quita la relación de `idTicket` con `idRel`: la de Firestore o la del portal
 * cuando es este ticket el que apunta al otro. La que puso el otro ticket en el
 * portal (posterior) se quita desde ese ticket.
 */
export async function desligarTicket(sb: SupabaseClient, email: string, idTicket: number, idRel: number): Promise<void> {
  const ref = getFirestore().doc(`${COL}/${idPar(idTicket, idRel)}`);
  let quitado = false;
  if ((await ref.get()).exists) {
    await ref.delete();
    quitado = true;
  }
  const { data: propio } = await sb.from("tickets").select("id_ticket_relacionado").eq("id", idTicket).maybeSingle();
  if (Number(propio?.id_ticket_relacionado) === idRel) {
    const { error } = await sb.from("tickets").update({ id_ticket_relacionado: null }).eq("id", idTicket);
    if (error) throw error;
    quitado = true;
  }
  if (!quitado) throw new Error("rel_del_otro");
  const { data: otro } = await sb.from("tickets").select("numero").eq("id", idRel).maybeSingle();
  await nota(sb, email, idTicket, `Se quita la relación con el ticket #${otro?.numero ?? idRel} desde el dashboard de cambios.`).catch(() => {});
}
