/**
 * Token de la suscripción de Claude con el que corre cada ticket mandado a
 * Claude Code (orquestador). Con Claude Team cada persona usa el suyo: su
 * ventana de 5 h, no la de otro.
 *
 *  - Root: el token compartido `CLAUDE_CODE_OAUTH_TOKEN`, que además usan los
 *    docs de los 8 repos. Lo renueva con `gh secret set` (ver AvisoTokenClaude);
 *    aquí solo se marca la fecha (`agente_config/claudeToken`).
 *  - Los demás: un secret propio en el orquestador (`CLAUDE_TOKEN_<CORREO>`).
 *    El navegador lo cifra con la llave pública del repo (sealed box de
 *    libsodium) antes de mandarlo: esta función solo ve el texto cifrado y lo
 *    deja en GitHub. En Firestore (`agente_claude_conexiones/{email}`) queda
 *    solo cuándo se conectó y cuándo vence.
 *
 * El token es opaco: no se le puede preguntar cuándo vence. `claude setup-token`
 * lo emite por un año, así que el vencimiento sale de la fecha de conexión.
 */
import type { Octokit } from "@octokit/rest";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { ORQUESTADOR } from "./mandar.js";

const VIGENCIA_DIAS = 365;
export const SECRET_COMPARTIDO = "CLAUDE_CODE_OAUTH_TOKEN";

const refCompartido = () => getFirestore().doc("agente_config/claudeToken");
const refPersona = (email: string) => getFirestore().doc(`agente_claude_conexiones/${email}`);

export interface TokenClaude {
  /** Hay token con el que mandar tickets. */
  conectado: boolean;
  /** Es el token compartido del root (también lo usan los docs). */
  compartido: boolean;
  renovado: string | null;
  vence: string | null;
}

/** jorge.mendoza@sozu.com → CLAUDE_TOKEN_JORGE_MENDOZA_SOZU_COM */
export function secretDe(email: string, esRoot: boolean): string {
  return esRoot ? SECRET_COMPARTIDO : `CLAUDE_TOKEN_${email.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`.slice(0, 100);
}

const fechas = (d: Record<string, unknown>) => ({
  renovado: typeof d.renovado === "string" ? d.renovado : null,
  vence: typeof d.vence === "string" ? d.vence : null,
});

export async function leerTokenClaude(email: string, esRoot: boolean): Promise<TokenClaude> {
  const d = (await (esRoot ? refCompartido() : refPersona(email)).get()).data();
  return { conectado: esRoot || !!d?.conectado, compartido: esRoot, ...fechas(d ?? {}) };
}

/** Para mandar o responder: sin token propio (o vencido), no se dispara la corrida. */
export async function exigirTokenClaude(email: string, esRoot: boolean): Promise<void> {
  if (esRoot) return;
  const t = await leerTokenClaude(email, false);
  if (!t.conectado) throw new HttpsError("failed-precondition", "Conecta tu cuenta de Claude antes de mandar tickets.");
  if (t.vence && Date.parse(t.vence) < Date.now()) {
    throw new HttpsError("failed-precondition", "Tu token de Claude venció: vuelve a conectarlo.");
  }
}

const nuevasFechas = () => {
  const ahora = new Date();
  return { renovado: ahora.toISOString(), vence: new Date(ahora.getTime() + VIGENCIA_DIAS * 86_400_000).toISOString() };
};

/** Root: marca el token compartido como recién renovado (lo cambió con `gh secret set`). */
export async function marcarTokenRenovado(email: string): Promise<TokenClaude> {
  const t = nuevasFechas();
  await refCompartido().set({ ...t, por: email });
  return { conectado: true, compartido: true, ...t };
}

/** Llave pública del orquestador, para que el navegador cifre el token. */
export async function llavePublica(gh: Octokit): Promise<{ keyId: string; key: string }> {
  const { data } = await gh.actions.getRepoPublicKey({ ...ORQUESTADOR });
  return { keyId: data.key_id, key: data.key };
}

/** Guarda el token (ya cifrado en el navegador) como secret propio en el orquestador. */
export async function conectarToken(gh: Octokit, email: string, keyId: string, cifrado: string): Promise<TokenClaude> {
  if (!/^[\w-]{1,64}$/.test(keyId) || !/^[A-Za-z0-9+/=]{40,4000}$/.test(cifrado)) {
    throw new HttpsError("invalid-argument", "Token cifrado inválido.");
  }
  await gh.actions.createOrUpdateRepoSecret({
    ...ORQUESTADOR,
    secret_name: secretDe(email, false),
    encrypted_value: cifrado,
    key_id: keyId,
  });
  const t = nuevasFechas();
  await refPersona(email).set({ conectado: true, ...t });
  return { conectado: true, compartido: false, ...t };
}

export async function desconectarToken(gh: Octokit, email: string): Promise<TokenClaude> {
  await gh.actions.deleteRepoSecret({ ...ORQUESTADOR, secret_name: secretDe(email, false) }).catch((e: { status?: number }) => {
    if (e?.status !== 404) throw e;
  });
  await refPersona(email).delete();
  return { conectado: false, compartido: false, renovado: null, vence: null };
}
