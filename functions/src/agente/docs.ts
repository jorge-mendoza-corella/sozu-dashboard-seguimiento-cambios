/**
 * Corpus de documentación del agente: los `.md` de `sozu-docs/docs/**`.
 *
 * Es el mismo repo que regenera el workflow `update-docs.yml` de cada repo de
 * SOZU en cada push a main (doc técnica por repo + `user-manual/`), así que el
 * agente siempre responde contra lo último publicado.
 *
 * Se baja completo (~1 MB, ~115 archivos) y se queda en memoria de la
 * instancia. Antes de reusarlo se compara el SHA de `main`: si alguien publicó
 * docs nuevos, se recarga; si no, cero descargas. Con ~300k tokens no cabe
 * mandarlo entero en cada pregunta, por eso el modelo lo consulta con
 * herramientas (índice en el system prompt + buscar + leer).
 */
import { Octokit } from "@octokit/rest";

export const DOCS_OWNER = "jorge-mendoza-corella";
export const DOCS_REPO = "sozu-docs";
const DOCS_REF = "main";
const DOCS_PREFIJO = "docs/";
/** Cada cuánto se vuelve a preguntar el SHA de main (no el contenido). */
const REVALIDAR_MS = 5 * 60_000;

export interface DocArchivo {
  /** Ruta relativa a `docs/` (p. ej. `edge-functions/ia-guia-portal.md`). */
  ruta: string;
  titulo: string;
  texto: string;
}

interface Corpus {
  sha: string;
  revisado: number;
  archivos: Map<string, DocArchivo>;
}

let corpus: Corpus | null = null;
let cargando: Promise<Corpus> | null = null;

const tituloDe = (ruta: string, texto: string) =>
  texto.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? ruta.replace(/\.md$/, "");

async function shaDeMain(gh: Octokit): Promise<string> {
  const { data } = await gh.repos.getBranch({ owner: DOCS_OWNER, repo: DOCS_REPO, branch: DOCS_REF });
  return data.commit.sha;
}

async function descargar(gh: Octokit, sha: string): Promise<Corpus> {
  const { data: arbol } = await gh.git.getTree({
    owner: DOCS_OWNER,
    repo: DOCS_REPO,
    tree_sha: sha,
    recursive: "true",
  });
  const blobs = arbol.tree.filter(
    (n) => n.type === "blob" && n.path?.startsWith(DOCS_PREFIJO) && n.path.endsWith(".md") && n.sha,
  );
  const archivos = new Map<string, DocArchivo>();
  // De 10 en 10: son ~115 blobs y la API secundaria de GitHub castiga ráfagas.
  for (let i = 0; i < blobs.length; i += 10) {
    await Promise.all(
      blobs.slice(i, i + 10).map(async (b) => {
        const { data } = await gh.git.getBlob({ owner: DOCS_OWNER, repo: DOCS_REPO, file_sha: b.sha! });
        const texto = Buffer.from(data.content, "base64").toString("utf8");
        const ruta = b.path!.slice(DOCS_PREFIJO.length);
        archivos.set(ruta, { ruta, titulo: tituloDe(ruta, texto), texto });
      }),
    );
  }
  return { sha, revisado: Date.now(), archivos };
}

/** Corpus vigente; descarga solo si cambió el SHA de main. */
export async function obtenerCorpus(gh: Octokit): Promise<Corpus> {
  if (corpus && Date.now() - corpus.revisado < REVALIDAR_MS) return corpus;
  if (cargando) return cargando;
  cargando = (async () => {
    try {
      const sha = await shaDeMain(gh);
      if (corpus && corpus.sha === sha) {
        corpus.revisado = Date.now();
        return corpus;
      }
      corpus = await descargar(gh, sha);
      return corpus;
    } catch (e) {
      // GitHub caído: mejor responder con lo que ya había que no responder.
      if (corpus) return corpus;
      throw e;
    } finally {
      cargando = null;
    }
  })();
  return cargando;
}

/**
 * Índice para el system prompt: una línea por archivo, ordenado por ruta.
 * Determinista a propósito (va dentro del prefijo cacheado): mismo SHA, mismo
 * texto byte por byte.
 */
export function indiceDocs(c: Corpus): string {
  return [...c.archivos.values()]
    .sort((a, b) => a.ruta.localeCompare(b.ruta))
    .map((a) => `- ${a.ruta} — ${a.titulo} (${Math.ceil(a.texto.length / 1000)}k car.)`)
    .join("\n");
}

const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const PALABRAS_VACIAS = new Set([
  "el", "la", "los", "las", "de", "del", "en", "y", "o", "que", "como", "para", "por", "con",
  "un", "una", "se", "es", "al", "lo", "su", "sus", "the", "a", "of", "to", "and", "in",
]);

export interface ResultadoBusqueda {
  ruta: string;
  seccion: string;
  linea: number;
  puntaje: number;
  extracto: string;
}

/**
 * Búsqueda por términos sobre secciones (cada encabezado `#`/`##`/`###` abre
 * una). Puntúa por términos distintos encontrados y por frecuencia, con bonus
 * si el término está en el encabezado o en la ruta. Sin embeddings: el corpus
 * es chico y los términos técnicos (nombres de tablas, funciones, pantallas)
 * se buscan mejor literal.
 */
export function buscarEnDocs(
  c: Corpus,
  consulta: string,
  opciones: { seccion?: string; max?: number } = {},
): ResultadoBusqueda[] {
  const terminos = [...new Set(normalizar(consulta).split(/[^a-z0-9_\-.]+/))].filter(
    (t) => t.length > 1 && !PALABRAS_VACIAS.has(t),
  );
  if (terminos.length === 0) return [];
  const filtro = opciones.seccion ? normalizar(opciones.seccion).replace(/\/+$/, "") + "/" : null;
  const resultados: ResultadoBusqueda[] = [];

  for (const doc of c.archivos.values()) {
    if (filtro && !normalizar(doc.ruta).startsWith(filtro)) continue;
    const rutaN = normalizar(doc.ruta);
    const lineas = doc.texto.split("\n");
    let inicio = 0;
    let encabezado = doc.titulo;
    const cerrar = (fin: number) => {
      if (fin <= inicio) return;
      const cuerpo = normalizar(lineas.slice(inicio, fin).join("\n"));
      const encN = normalizar(encabezado);
      let puntaje = 0;
      let distintos = 0;
      for (const t of terminos) {
        const n = cuerpo.split(t).length - 1;
        if (n > 0) distintos++;
        puntaje += Math.min(n, 8);
        if (encN.includes(t)) puntaje += 6;
        if (rutaN.includes(t)) puntaje += 3;
      }
      if (distintos === 0) return;
      puntaje *= distintos / terminos.length + 0.5;
      // El extracto arranca en la primera línea que trae algún término.
      const rel = lineas.slice(inicio, fin).findIndex((l) => terminos.some((t) => normalizar(l).includes(t)));
      const desde = inicio + Math.max(rel, 0);
      resultados.push({
        ruta: doc.ruta,
        seccion: encabezado,
        linea: desde + 1,
        puntaje: Math.round(puntaje * 10) / 10,
        extracto: lineas.slice(desde, Math.min(desde + 6, fin)).join("\n").slice(0, 500),
      });
    };
    lineas.forEach((l, i) => {
      const m = l.match(/^#{1,3}\s+(.+)$/);
      if (!m) return;
      cerrar(i);
      inicio = i;
      encabezado = m[1].trim();
    });
    cerrar(lineas.length);
  }

  return resultados.sort((a, b) => b.puntaje - a.puntaje).slice(0, opciones.max ?? 12);
}

/** Tope de caracteres por lectura: lo demás se pide con `desde_linea`. */
export const MAX_LECTURA = 40_000;

export const limpiarRuta = (ruta: string) => ruta.trim().replace(/^\/+/, "").replace(/^docs\//, "");

export function docPorRuta(c: Corpus, ruta: string): DocArchivo | null {
  return c.archivos.get(limpiarRuta(ruta)) ?? null;
}

export function leerDoc(c: Corpus, ruta: string, desdeLinea = 1): string {
  const limpia = limpiarRuta(ruta);
  const doc = c.archivos.get(limpia);
  if (!doc) {
    const parecidos = [...c.archivos.keys()]
      .filter((r) => r.includes(limpia.split("/").pop()?.replace(/\.md$/, "") ?? "\0"))
      .slice(0, 5);
    return JSON.stringify({ error: "no_existe", ruta: limpia, parecidos });
  }
  const lineas = doc.texto.split("\n");
  const desde = Math.max(1, Math.floor(desdeLinea));
  let out = "";
  let hasta = desde - 1;
  while (hasta < lineas.length && out.length + lineas[hasta].length + 1 <= MAX_LECTURA) {
    out += lineas[hasta] + "\n";
    hasta++;
  }
  const encabezado = `[${doc.ruta} · líneas ${desde}-${hasta} de ${lineas.length}]`;
  const pie = hasta < lineas.length ? `\n[continúa: pide desde_linea=${hasta + 1}]` : "";
  return `${encabezado}\n${out}${pie}`;
}
