/**
 * Vigencia del token de la suscripción de Claude (`CLAUDE_CODE_OAUTH_TOKEN`)
 * que usan el orquestador de tickets y la documentación automática.
 *
 * El token es opaco: no se puede preguntar cuándo vence. `claude setup-token`
 * lo emite por un año, así que se guarda la fecha en que se renovó
 * (`agente_config/claudeToken`) y de ahí sale el vencimiento. La marca el root
 * con "Ya lo renové" en el aviso; el token en sí nunca pasa por aquí.
 */
import { getFirestore } from "firebase-admin/firestore";

const VIGENCIA_DIAS = 365;
const ref = () => getFirestore().doc("agente_config/claudeToken");

export interface TokenClaude {
  renovado: string | null;
  vence: string | null;
}

export async function leerTokenClaude(): Promise<TokenClaude> {
  const d = (await ref().get()).data() ?? {};
  return { renovado: typeof d.renovado === "string" ? d.renovado : null, vence: typeof d.vence === "string" ? d.vence : null };
}

export async function marcarTokenRenovado(email: string): Promise<TokenClaude> {
  const ahora = new Date();
  const t = { renovado: ahora.toISOString(), vence: new Date(ahora.getTime() + VIGENCIA_DIAS * 86_400_000).toISOString() };
  await ref().set({ ...t, por: email });
  return t;
}
