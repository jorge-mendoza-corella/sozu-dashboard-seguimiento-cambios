/**
 * Lectura del código de los repos monitoreados, vía API de GitHub.
 *
 * Todo es de SOLO LECTURA y siempre acotado a los repos que el usuario puede
 * ver en el dashboard (`reposPermitidos` en acceso.ts): el modelo elige el repo
 * por su etiqueta y aquí se traduce a owner/repo; nunca escribe un owner a mano.
 */
import { Octokit } from "@octokit/rest";

export interface RepoAgente {
  owner: string;
  repo: string;
  label: string;
  proyecto: string;
}

/** Tope del contenido de un archivo devuelto al modelo. */
const MAX_ARCHIVO = 40_000;

const estado = (e: unknown) => (e as { status?: number }).status;

export function resolverRepo(repos: RepoAgente[], nombre: string): RepoAgente | null {
  const n = nombre.trim().toLowerCase();
  return (
    repos.find((r) => r.label.toLowerCase() === n) ??
    repos.find((r) => `${r.owner}/${r.repo}`.toLowerCase() === n) ??
    repos.find((r) => r.repo.toLowerCase() === n) ??
    null
  );
}

export async function buscarCodigo(gh: Octokit, repos: RepoAgente[], consulta: string): Promise<string> {
  // La búsqueda de código de GitHub admite varios `repo:` con OR implícito;
  // el tope de la query es de 256 caracteres, así que con muchos repos se parte.
  const grupos: RepoAgente[][] = [];
  let actual: RepoAgente[] = [];
  let largo = consulta.length;
  for (const r of repos) {
    const q = ` repo:${r.owner}/${r.repo}`;
    if (largo + q.length > 250 && actual.length) {
      grupos.push(actual);
      actual = [];
      largo = consulta.length;
    }
    actual.push(r);
    largo += q.length;
  }
  if (actual.length) grupos.push(actual);

  const hallazgos: { repo: string; ruta: string; fragmentos: string[] }[] = [];
  let total = 0;
  for (const g of grupos) {
    try {
      const { data } = await gh.search.code({
        q: `${consulta} ${g.map((r) => `repo:${r.owner}/${r.repo}`).join(" ")}`,
        per_page: 15,
        headers: { accept: "application/vnd.github.text-match+json" },
      });
      total += data.total_count;
      for (const it of data.items) {
        const repo = repos.find((r) => `${r.owner}/${r.repo}`.toLowerCase() === it.repository.full_name.toLowerCase());
        hallazgos.push({
          repo: repo?.label ?? it.repository.full_name,
          ruta: it.path,
          fragmentos: (it.text_matches ?? []).map((m) => (m.fragment ?? "").slice(0, 300)).slice(0, 2),
        });
      }
    } catch (e) {
      if (estado(e) === 403 || estado(e) === 429) {
        return JSON.stringify({ error: "limite_github", detalle: "La búsqueda de código de GitHub está limitada por minuto; reintenta en un momento o lee archivos directamente." });
      }
      if (estado(e) === 422) return JSON.stringify({ error: "consulta_invalida" });
      throw e;
    }
  }
  return JSON.stringify({ total, mostrados: hallazgos.length, resultados: hallazgos.slice(0, 20) });
}

export async function leerArchivo(gh: Octokit, repo: RepoAgente, ruta: string, ref?: string, desdeLinea = 1): Promise<string> {
  const limpia = ruta.replace(/^\/+/, "");
  try {
    const { data } = await gh.repos.getContent({ owner: repo.owner, repo: repo.repo, path: limpia, ...(ref ? { ref } : {}) });
    if (Array.isArray(data)) {
      return JSON.stringify({
        repo: repo.label,
        directorio: limpia || "/",
        entradas: data.map((e) => (e.type === "dir" ? `${e.name}/` : e.name)).sort(),
      });
    }
    if (data.type !== "file" || !("content" in data)) {
      return JSON.stringify({ error: "no_es_archivo", tipo: data.type });
    }
    const texto = Buffer.from(data.content, "base64").toString("utf8");
    if (/\u0000/.test(texto.slice(0, 2000))) return JSON.stringify({ error: "binario", ruta: limpia });
    const lineas = texto.split("\n");
    const desde = Math.max(1, Math.floor(desdeLinea));
    let out = "";
    let hasta = desde - 1;
    while (hasta < lineas.length && out.length + lineas[hasta].length + 1 <= MAX_ARCHIVO) {
      out += `${hasta + 1}\t${lineas[hasta]}\n`;
      hasta++;
    }
    const pie = hasta < lineas.length ? `\n[continúa: pide desde_linea=${hasta + 1}]` : "";
    return `[${repo.label}:${limpia}${ref ? `@${ref}` : ""} · líneas ${desde}-${hasta} de ${lineas.length}]\n${out}${pie}`;
  } catch (e) {
    if (estado(e) === 404) return JSON.stringify({ error: "no_existe", repo: repo.label, ruta: limpia, ref: ref ?? "rama por defecto" });
    throw e;
  }
}

export async function actividadRepo(
  gh: Octokit,
  repo: RepoAgente,
  tipo: "commits" | "prs",
  opciones: { ruta?: string; rama?: string },
): Promise<string> {
  if (tipo === "prs") {
    const { data } = await gh.pulls.list({ owner: repo.owner, repo: repo.repo, state: "all", per_page: 20, sort: "updated", direction: "desc" });
    return JSON.stringify({
      repo: repo.label,
      prs: data.map((p) => ({
        numero: p.number,
        titulo: p.title,
        autor: p.user?.login,
        estado: p.merged_at ? "mergeado" : p.state,
        base: p.base.ref,
        rama: p.head.ref,
        actualizado: p.updated_at,
        descripcion: (p.body ?? "").slice(0, 400),
      })),
    });
  }
  const { data } = await gh.repos.listCommits({
    owner: repo.owner,
    repo: repo.repo,
    per_page: 20,
    ...(opciones.ruta ? { path: opciones.ruta } : {}),
    ...(opciones.rama ? { sha: opciones.rama } : {}),
  });
  return JSON.stringify({
    repo: repo.label,
    ruta: opciones.ruta ?? null,
    commits: data.map((c) => ({
      sha: c.sha.slice(0, 7),
      fecha: c.commit.author?.date,
      autor: c.author?.login ?? c.commit.author?.name,
      mensaje: c.commit.message.split("\n").slice(0, 3).join(" ").slice(0, 300),
    })),
  });
}
