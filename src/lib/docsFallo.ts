/**
 * Causa del último fallo de la documentación automática de un repo. La lee la
 * Cloud Function `docsFallo` del log del job (el navegador no puede bajarlo).
 */
import { getFunctions, httpsCallable } from "firebase/functions";
import { app } from "./firebase";

export type CausaDocs =
  | "token_vencido" | "limite_suscripcion" | "sin_credito" | "llave_invalida" | "limite" | "saturado" | "otro";

export interface FalloDocs {
  causa: CausaDocs;
  detalle: string | null;
}

const llamar = httpsCallable<{ owner: string; repo: string; runId: number }, FalloDocs>(
  getFunctions(app, "us-central1"), "docsFallo", { timeout: 60_000 },
);

export async function falloDocs(owner: string, repo: string, runId: number): Promise<FalloDocs> {
  return (await llamar({ owner, repo, runId })).data;
}

/** Texto corto para la etiqueta del punto rojo. */
export const ETIQUETA_CAUSA: Record<CausaDocs, string | null> = {
  token_vencido: "Token de Claude vencido",
  limite_suscripcion: "Límite de la ventana de Claude",
  sin_credito: "Sin crédito en la API",
  llave_invalida: "Llave de API inválida",
  limite: "Límite de la API",
  saturado: "API saturada",
  otro: null,
};

/** Qué hacer, para el tooltip. */
export const AYUDA_CAUSA: Record<CausaDocs, string> = {
  token_vencido:
    "El token de la suscripción de Claude (CLAUDE_CODE_OAUTH_TOKEN) venció o se revocó. Regenera con `claude setup-token` y actualiza el secret (instrucciones en Tickets → Claude).",
  limite_suscripcion:
    "Se acabó la ventana de 5 horas de la suscripción de Claude. Reintenta cuando se reinicie.",
  sin_credito:
    "Se acabó el saldo de la API de Anthropic (console.anthropic.com → Plans & Billing). Recárgalo y dale a Reintentar.",
  llave_invalida: "La ANTHROPIC_API_KEY del repo está vencida o revocada: hay que cambiar el secret y reintentar.",
  limite: "La API de Anthropic cortó por límite de uso. Espera unos minutos y reintenta.",
  saturado: "La API de Anthropic estaba saturada. Reintenta en un rato.",
  otro: "Revisa el log del run.",
};
