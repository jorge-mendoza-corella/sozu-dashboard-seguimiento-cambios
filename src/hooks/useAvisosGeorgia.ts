/**
 * Avisos de quien está logueado: escucha sus conversaciones, le pasa al avatar
 * (EVENTO_AVISO) cada mensaje nuevo que le toca y, mientras siga sin contestar y
 * la conversación abierta, se lo vuelve a mostrar cada REPETIR_MS. Cuando el
 * avatar lo grita (EVENTO_AVISO_ENTREGADO) se marca entregado: así quien lo
 * mandó sabe a quién ya le llegó.
 */
import { useEffect, useRef, useState } from "react";
import {
  audioDe, EVENTO_AVISO, EVENTO_AVISO_ENTREGADO, escucharConversaciones, marcarEntregado,
  type AvisoParaAvatar, type Conversacion,
} from "@/lib/avisos";

const REPETIR_MS = 5 * 60_000;
/** Al abrir el dashboard, lo pendiente que ya se había gritado vuelve a salir pronto. */
const PRIMER_RECORDATORIO_MS = 20_000;

export const meToca = (c: Conversacion, yo: string) => !c.cerrada && c.pendientePara === yo;

export function useAvisosGeorgia(email: string | null, activo: boolean) {
  const [conversaciones, setConversaciones] = useState<Conversacion[]>([]);
  // Lo último que se le pasó al avatar por conversación (mensaje y cuándo).
  const anunciados = useRef(new Map<string, { msgId: string; en: number }>());
  const convsRef = useRef<Conversacion[]>([]);

  useEffect(() => {
    if (!activo || !email) return;
    const anunciar = async (c: Conversacion, recordatorio: boolean) => {
      anunciados.current.set(c.id, { msgId: c.ultimo.id, en: Date.now() });
      const audio = !recordatorio && c.ultimo.conAudio ? await audioDe(c.id, c.ultimo.id).catch(() => undefined) : undefined;
      const detalle: AvisoParaAvatar = {
        convId: c.id, msgId: c.ultimo.id, deNombre: c.ultimo.deNombre, deSkin: c.ultimo.skin,
        texto: c.ultimo.texto, audio, voz: c.ultimo.voz, recordatorio,
      };
      window.dispatchEvent(new CustomEvent(EVENTO_AVISO, { detail: detalle }));
    };
    const parar = escucharConversaciones(email, (cs) => {
      convsRef.current = cs;
      setConversaciones(cs);
      for (const c of cs) {
        if (!meToca(c, email) || !c.ultimo.id) continue;
        const visto = anunciados.current.get(c.id);
        if (visto?.msgId === c.ultimo.id) continue;
        if (c.entregadoId === c.ultimo.id) {
          // Ya se había gritado (en otra sesión): sale como recordatorio en un rato.
          anunciados.current.set(c.id, { msgId: c.ultimo.id, en: Date.now() - REPETIR_MS + PRIMER_RECORDATORIO_MS });
        } else void anunciar(c, false);
      }
    });
    const reloj = setInterval(() => {
      for (const c of convsRef.current) {
        if (!meToca(c, email)) continue;
        const visto = anunciados.current.get(c.id);
        if (visto && Date.now() - visto.en >= REPETIR_MS) void anunciar(c, visto.msgId !== c.ultimo.id ? false : c.entregadoId === c.ultimo.id);
      }
    }, 15_000);
    const alEntregado = (e: Event) => {
      const d = (e as CustomEvent<{ convId: string; msgId: string }>).detail;
      if (d) void marcarEntregado(d.convId, d.msgId).catch(() => {});
    };
    window.addEventListener(EVENTO_AVISO_ENTREGADO, alEntregado);
    return () => {
      parar();
      clearInterval(reloj);
      window.removeEventListener(EVENTO_AVISO_ENTREGADO, alEntregado);
    };
  }, [activo, email]);

  return { conversaciones, pendientes: email ? conversaciones.filter((c) => meToca(c, email)).length : 0 };
}
