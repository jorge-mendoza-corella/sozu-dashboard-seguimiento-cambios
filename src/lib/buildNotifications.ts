import { doc, setDoc } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Registro de builds para avisar por WhatsApp cuando terminan.
//
// El aviso de fin de build dependía del `codemagic.yaml` de cada repo de app: el
// dashboard le inyectaba `WA_PHONE` al disparar el build y el propio workflow
// mandaba el mensaje al final. Eso deja fuera justo el caso que más importa —el
// build que revienta antes de llegar a ese paso— y de hecho un build de iOS
// falló sin avisar a nadie.
//
// Ahora avisa un sync programado (`ci/codemagic_builds_notify.py`), que pregunta
// a Codemagic cómo terminó cada build. Lo único que el sync no puede deducir es
// QUIÉN lo disparó desde el dashboard y a qué teléfono avisarle: eso se deja
// aquí, en `buildNotifications/{buildId}`, en el momento de lanzarlo.
//
// El doc lo cierra el sync (`notified: true`) con cuenta de servicio; desde el
// navegador solo se crea, nunca se actualiza, para que nadie pueda marcar como
// avisado un build del que no se avisó.
// ---------------------------------------------------------------------------

export interface BuildNotificationInput {
  buildId: string;
  projectId: string;
  appId: string;
  workflowId: string;
  branch?: string;
  /** Login de GitHub de quien disparó el build. */
  actorLogin?: string;
  /** Su teléfono de WhatsApp (10 dígitos, como en `contributors`). */
  actorPhone?: string;
  actorEmail?: string;
}

/**
 * Deja constancia de un build recién disparado. Es best-effort a propósito: si
 * falla, el build ya se lanzó y no tiene sentido tumbar esa pantalla —el sync
 * igual avisará al teléfono administrativo de la empresa, solo que sin poder
 * avisarle además a quien lo lanzó.
 */
export async function registerBuildForNotification(input: BuildNotificationInput): Promise<void> {
  const { buildId, ...resto } = input;
  if (!buildId) return;
  const campos: Record<string, unknown> = { buildId, notified: false, startedAt: new Date() };
  for (const [k, v] of Object.entries(resto)) {
    if (typeof v === "string" && v.trim()) campos[k] = v.trim();
  }
  try {
    await setDoc(doc(db, "buildNotifications", buildId), campos);
  } catch {
    // Sin ruido en la interfaz: el build sigue su curso.
  }
}
