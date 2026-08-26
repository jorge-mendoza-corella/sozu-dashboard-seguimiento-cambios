import { getDeployMeta, type DeployMeta } from "./github";

// ---------------------------------------------------------------------------
// Caché por sha de los metadatos de un deploy (PR, autores, aprobadores, quién
// mergeó).
//
// Vivía dentro de `DeployMetaTooltip`, privada. Cuando la tarjeta empezó a
// decir a quién se le avisó, hacía falta lo mismo para ponerle su papel a cada
// nombre: sin compartir la caché, el hover y la línea de avisos pedían el mismo
// PR a GitHub por separado, y hay un tope de peticiones por hora que se gasta
// con seis repos en pantalla refrescándose cada dos minutos.
// ---------------------------------------------------------------------------

const cache = new Map<string, DeployMeta>();
const enVuelo = new Map<string, Promise<DeployMeta>>();

export const metaEnCache = (sha: string | undefined) => (sha ? cache.get(sha) : undefined);

/** Metadatos del deploy, de la caché o de GitHub. Una sola petición por sha. */
export function getDeployMetaCached(owner: string, repo: string, sha: string): Promise<DeployMeta> {
  const guardado = cache.get(sha);
  if (guardado) return Promise.resolve(guardado);
  // Dos componentes pidiendo el mismo sha a la vez son dos peticiones idénticas:
  // se comparte la que ya está en vuelo.
  const yaVa = enVuelo.get(sha);
  if (yaVa) return yaVa;
  const p = getDeployMeta(owner, repo, sha)
    .then((m) => {
      // Solo se guarda un resultado ÚTIL. `getDeployMeta` devuelve el objeto
      // vacío tanto cuando la petición falla —rate limit de GitHub, por
      // ejemplo— como cuando el commit todavía no tiene PR asociado, que es lo
      // normal en los segundos siguientes a un merge. Cachear eso convertía un
      // tropiezo de un segundo en un dato ausente para siempre: la tarjeta se
      // quedaba diciendo que el deploy avisaría solo a quien lo disparó, sin
      // los autores del release, y ya no volvía a preguntar.
      if (m.prNumber !== null) cache.set(sha, m);
      enVuelo.delete(sha);
      return m;
    })
    .catch((e) => { enVuelo.delete(sha); throw e; });
  enVuelo.set(sha, p);
  return p;
}
