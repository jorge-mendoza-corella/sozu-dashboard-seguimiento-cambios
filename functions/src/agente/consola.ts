/**
 * Consola en vivo de Claude Code: lo que va haciendo en la corrida (comandos,
 * archivos que lee o edita, búsquedas), para verlo avanzar desde el panel.
 *
 * GitHub no da el log de un job hasta que termina, así que la corrida lo manda
 * aquí: un hook de Claude Code (PreToolUse) en el orquestador llama a esta
 * función por cada acción. No es historial: cada corrida reemplaza la anterior y
 * solo se guardan las últimas MAX_LINEAS, en `agente_claude_log/{issue}`.
 *
 * Autenticación sin secretos compartidos:
 *   1. "abrir": la corrida manda su token OIDC de GitHub Actions; se verifica que
 *      lo firmó GitHub y que viene del repo orquestador. Se responde una llave
 *      aleatoria válida por unas horas.
 *   2. "linea"/"fin": llevan esa llave.
 */
import { randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { ORQUESTADOR } from "./mandar.js";

const EMISOR = "https://token.actions.githubusercontent.com";
export const AUDIENCIA = "sozu-dashboard";
const JWKS = createRemoteJWKSet(new URL(`${EMISOR}/.well-known/jwks`));
const VIGENCIA_MS = 3 * 60 * 60_000;
const MAX_LINEAS = 300;
const MAX_TEXTO = 400;

export class ErrorConsola extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const ref = (issue: number) => getFirestore().doc(`agente_claude_log/${issue}`);

export async function abrirConsola(jwt: string, issue: number): Promise<{ llave: string }> {
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(jwt, JWKS, { issuer: EMISOR, audience: AUDIENCIA }));
  } catch {
    throw new ErrorConsola(401, "Token OIDC inválido.");
  }
  if (claims.repository !== `${ORQUESTADOR.owner}/${ORQUESTADOR.repo}`) throw new ErrorConsola(403, "Repo no autorizado.");

  // Dueño: quien mandó el ticket (solo esa persona puede leer la consola).
  const enviados = await getFirestore().collection("agente_tickets_enviados").where("issue.numero", "==", issue).limit(1).get();
  const owner = enviados.docs[0]?.data().owner;
  if (!owner) throw new ErrorConsola(404, "Ese issue no es de un ticket mandado desde el dashboard.");

  const llave = randomBytes(24).toString("hex");
  await ref(issue).set({
    owner,
    issue,
    run: String(claims.run_id ?? ""),
    llave,
    expira: Timestamp.fromMillis(Date.now() + VIGENCIA_MS),
    inicio: FieldValue.serverTimestamp(),
    activo: true,
    lineas: [],
  });
  return { llave };
}

async function validar(issue: number, llave: string) {
  const d = (await ref(issue).get()).data();
  if (!d || d.llave !== llave || !(d.expira instanceof Timestamp) || d.expira.toMillis() < Date.now()) {
    throw new ErrorConsola(403, "Llave inválida o vencida.");
  }
}

export async function lineaConsola(issue: number, llave: string, texto: string, tipo: string, repo = ""): Promise<void> {
  await validar(issue, llave);
  const linea = {
    t: Date.now(),
    tipo: String(tipo).slice(0, 20),
    texto: String(texto).replace(/\s+/g, " ").trim().slice(0, MAX_TEXTO),
    // Sigla de dos letras del repo (BD, BE, FE…), si la acción toca uno.
    repo: /^[A-Z0-9]{2}$/.test(repo) ? repo : "",
  };
  if (!linea.texto) return;
  await getFirestore().runTransaction(async (tx) => {
    const d = (await tx.get(ref(issue))).data() ?? {};
    const lineas = [...(Array.isArray(d.lineas) ? d.lineas : []), linea].slice(-MAX_LINEAS);
    tx.update(ref(issue), { lineas, activo: true });
  });
}

/** Id de la sesión de Claude Code de esta corrida (para ubicarla en GitHub). */
export async function sesionConsola(issue: number, llave: string, sesion: string): Promise<void> {
  await validar(issue, llave);
  const id = String(sesion).trim();
  if (!/^[\w-]{8,80}$/.test(id)) return;
  await ref(issue).update({ sesion: id });
}

export async function finConsola(issue: number, llave: string): Promise<void> {
  await validar(issue, llave);
  await ref(issue).update({ activo: false, fin: FieldValue.serverTimestamp() });
}
