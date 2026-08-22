import { db } from "./firebase";
import { doc, getDoc } from "firebase/firestore";

// ---------------------------------------------------------------------------
// Lo que el CI dejó anotado sobre los avisos de un deploy.
//
// El dashboard puede CALCULAR a quién le tocaría el aviso —el aprobador del
// proyecto, los suscritos, la configuración de la empresa—, pero no si el
// mensaje salió: eso solo lo sabe el workflow que lo mandó. Y no es lo mismo:
// un teléfono sin capturar, una instancia caída o una empresa apagada cambian
// el resultado sin cambiar la configuración que se ve desde aquí.
//
// Por eso el propio deploy escribe lo que hizo, con su cuenta de servicio, en
// `deployNotifications/{owner}__{repo}__{runId}`. Sin registro, la interfaz
// dice a quién LE TOCA y no afirma que le llegó.
// ---------------------------------------------------------------------------

export interface DeployNotification {
  /** Logins a los que el aviso salió bien. */
  avisados: string[];
  /** Logins que debían recibirlo y no pudieron, con el motivo. */
  fallidos: { login: string; motivo: string }[];
  /** `false` = la empresa tiene los avisos apagados o incompletos. */
  seMando: boolean;
  /** Por qué no se mandó nada, cuando `seMando` es falso. */
  motivo?: string;
  runId: string;
  updatedAt?: unknown;
}

export const deployNotifId = (owner: string, repo: string, runId: string | number) =>
  `${owner}__${repo}__${runId}`;

/** Registro del CI para ese run, o `null` si ese deploy no dejó nota. */
export async function getDeployNotification(
  owner: string,
  repo: string,
  runId: string | number,
): Promise<DeployNotification | null> {
  const snap = await getDoc(doc(db, "deployNotifications", deployNotifId(owner, repo, runId)));
  if (!snap.exists()) return null;
  const d = snap.data() as Partial<DeployNotification>;
  return {
    avisados: d.avisados ?? [],
    fallidos: d.fallidos ?? [],
    seMando: d.seMando ?? false,
    motivo: d.motivo,
    runId: String(runId),
    updatedAt: d.updatedAt,
  };
}
