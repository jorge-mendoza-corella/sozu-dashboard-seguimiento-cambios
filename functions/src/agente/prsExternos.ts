/**
 * PRs de un ticket que se trabajó POR FUERA del dashboard (nadie lo mandó a
 * Claude ni copió su .md), para poder cerrarlo desde aquí dejando constancia
 * de qué PRs lo resolvieron.
 *
 * Convención para ligar un PR con el ticket de folio N (basta con una):
 *   - trailer en algún commit:   `Ticket-SOZU: #N`   (el mismo del flujo con Claude)
 *   - título o descripción:      `SOZU-N`            (p. ej. "fix: totales SOZU-1255")
 *                                o `Ticket #N`       (p. ej. "Ticket #1425" en la descripción)
 *   - nombre de la rama:         `ticket-N`, `ticket/N` o `sozu-N`
 *
 * Todas con borde de número: el folio 125 no se confunde con el 1255. `SOZU-N`
 * o `Ticket #N`, y no `#N` a secas, porque `#N` en GitHub es el número de un PR
 * o issue.
 *
 * Se busca solo en los repos de Sozu que monitorea el dashboard. Las búsquedas
 * de GitHub (commits y PRs) tienen tope de 30 por minuto para todo el token,
 * así que el resultado se guarda en el registro del ticket y se reusa
 * REVISAR_MS; el barrido de PRs por repo cubre lo que el índice de búsqueda
 * todavía no tiene (y las ramas, que la búsqueda no mira).
 */
import type { Octokit } from "@octokit/rest";
import { getFirestore } from "firebase-admin/firestore";
import { cambiosDePr, estadoDePr, type PrClaude } from "./prsTicket.js";

/** Empresa dueña de los repos donde se buscan los PRs (Sozu). */
const CLIENTE_SOZU = "kX60JlcDL2p2EFlsi9HT";
const REVISAR_MS = 10 * 60_000;
/** Más que esto ya no es "los PRs de un ticket": algo matcheó de más. */
const MAX_PRS = 20;

export type RazonMatch = "trailer" | "titulo" | "rama";

export interface PrExterno extends PrClaude {
  razones: RazonMatch[];
  /** Ya entró a main (en_main o en_prd): puede contar para cerrar. */
  mergeado: boolean;
}

export interface PrsExternos {
  numero: number;
  prs: PrExterno[];
  revisadoEn: string;
}

/** Criterios de la convención para el folio `n`. Un solo lugar para todo el flujo. */
export function criteriosTicket(n: number) {
  return {
    trailer: new RegExp(`^Ticket-SOZU:\\s*#${n}(?!\\d)`, "im"),
    texto: new RegExp(`(?<![\\w-])(?:SOZU-|Ticket\\s*:?\\s*#)${n}(?!\\d)`, "i"),
    rama: new RegExp(`(?:^|[^a-z0-9])(?:ticket|sozu)[-/_]${n}(?!\\d)`, "i"),
  };
}

/** Por qué este PR es del ticket, mirando solo título, descripción y rama. */
function razonesDePr(pr: { title: string; body?: string | null; head: { ref: string } }, n: number): RazonMatch[] {
  const c = criteriosTicket(n);
  const razones: RazonMatch[] = [];
  const texto = `${pr.title}\n${pr.body ?? ""}`;
  if (c.texto.test(texto)) razones.push("titulo");
  // El trailer pegado en la descripción también cuenta.
  if (c.trailer.test(texto)) razones.push("trailer");
  if (c.rama.test(pr.head.ref)) razones.push("rama");
  return razones;
}

/** owner/repo de los repos de Sozu en el dashboard. */
export async function reposDeSozu(): Promise<{ owner: string; repo: string }[]> {
  const fs = getFirestore();
  const proyectos = await fs.collection("projects").where("clientId", "==", CLIENTE_SOZU).get();
  const ids = new Set(proyectos.docs.map((d) => d.id));
  const repos = await fs.collection("repos").get();
  return repos.docs
    .map((d) => d.data())
    .filter((r) => ids.has(String(r.projectId)) && r.owner && r.repo)
    .map((r) => ({ owner: String(r.owner), repo: String(r.repo) }));
}

const clave = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();
const urlPr = (owner: string, repo: string, n: number) => `https://github.com/${owner}/${repo}/pull/${n}`;

/**
 * Qualifiers `user:` agrupados para que cada query quede bajo el tope de 256
 * caracteres de la búsqueda. Por dueño y no por repo: son pocos, y lo que caiga
 * en un repo que no se monitorea se descarta después.
 */
function gruposDeDuenos(owners: string[], base: string): string[] {
  const grupos: string[] = [];
  let actual = base;
  for (const o of owners) {
    const q = `${actual} user:${o}`;
    if (q.length > 240 && actual !== base) {
      grupos.push(actual);
      actual = `${base} user:${o}`;
    } else actual = q;
  }
  if (actual !== base) grupos.push(actual);
  return grupos;
}

/** Candidatos (url → por qué) en `repos`, sin estado. Exportado para probarlo aislado. */
export async function candidatosDelTicket(gh: Octokit, n: number, repos: { owner: string; repo: string }[]): Promise<Map<string, Set<RazonMatch>>> {
  const permitidos = new Map(repos.map((r) => [clave(r.owner, r.repo), r]));
  const owners = [...new Set(repos.map((r) => r.owner))];
  const encontrados = new Map<string, Set<RazonMatch>>();
  const anotar = (owner: string, repo: string, num: number, razon: RazonMatch) => {
    if (!permitidos.has(clave(owner, repo))) return;
    const url = urlPr(owner, repo, num);
    encontrados.set(url, (encontrados.get(url) ?? new Set()).add(razon));
  };
  const c = criteriosTicket(n);

  // (a) Commits con el trailer. La búsqueda es por palabras: el regex confirma.
  for (const q of gruposDeDuenos(owners, `"Ticket-SOZU" "${n}"`)) {
    try {
      const { data } = await gh.search.commits({ q, per_page: 50 });
      for (const it of data.items) {
        if (!c.trailer.test(it.commit.message)) continue;
        const [owner, repo] = it.repository.full_name.split("/");
        if (!permitidos.has(clave(owner, repo))) continue;
        const { data: prs } = await gh.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: it.sha });
        // El PR de release dev → main trae los commits de todos los tickets:
        // no es "el PR del ticket", su paso a main ya lo reporta `prMain`.
        for (const p of prs) if (p.head.ref !== "dev") anotar(owner, repo, p.number, "trailer");
      }
    } catch (e) {
      console.warn("[prsExternos] búsqueda de commits", (e as Error).message);
    }
  }

  // (b) PRs con SOZU-N o Ticket #N en título o descripción.
  for (const q of [`"SOZU-${n}" is:pr`, `"Ticket" "${n}" is:pr`].flatMap((base) => gruposDeDuenos(owners, base))) {
    try {
      const { data } = await gh.search.issuesAndPullRequests({ q, per_page: 50 });
      for (const it of data.items) {
        if (!c.texto.test(`${it.title}\n${it.body ?? ""}`)) continue;
        const m = it.html_url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
        if (m) anotar(m[1], m[2], Number(m[3]), "titulo");
      }
    } catch (e) {
      console.warn("[prsExternos] búsqueda de PRs", (e as Error).message);
    }
  }

  // (c) Barrido de los PRs recientes de cada repo: ramas (que la búsqueda no
  // indexa) y PRs que el índice todavía no tiene.
  await Promise.all(repos.map(async ({ owner, repo }) => {
    try {
      const { data } = await gh.pulls.list({ owner, repo, state: "all", sort: "updated", direction: "desc", per_page: 100 });
      for (const p of data) for (const r of razonesDePr(p, n)) anotar(owner, repo, p.number, r);
    } catch (e) {
      console.warn(`[prsExternos] ${owner}/${repo}`, (e as Error).message);
    }
  }));
  return encontrados;
}

const registro = (email: string, ticketId: string) => getFirestore().doc(`agente_tickets_enviados/${email}__${ticketId}`);

/**
 * PRs del ticket de folio `numero`, desde el registro si se revisó hace menos
 * de REVISAR_MS (salvo `forzar`). Deja el resultado en `prsExternos` del
 * registro; si el registro no existía, lo crea con lo mínimo para que el panel
 * lo lea (dueño, folio, título).
 */
export async function buscarPrsExternos(
  gh: Octokit,
  email: string,
  t: { id: string; numero: number; folio: string; titulo: string },
  forzar = false,
): Promise<PrsExternos> {
  const ref = registro(email, t.id);
  const previo = (await ref.get()).data()?.prsExternos as PrsExternos | undefined;
  if (!forzar && previo && previo.numero === t.numero && Date.now() - Date.parse(previo.revisadoEn) < REVISAR_MS) return previo;

  const encontrados = await candidatosDelTicket(gh, t.numero, await reposDeSozu());
  const urls = [...encontrados.keys()].slice(0, MAX_PRS);
  const prs = (await Promise.all(urls.map(async (url) => {
    const p = await estadoDePr(gh, url).catch(() => null);
    if (!p) return null;
    const r: PrExterno = { ...p, razones: [...(encontrados.get(url) ?? [])], mergeado: p.estado === "en_main" || p.estado === "en_prd" };
    return r;
  }))).filter((p): p is PrExterno => !!p);

  const salida: PrsExternos = { numero: t.numero, prs, revisadoEn: new Date().toISOString() };
  await ref.set(
    { owner: email, ticketId: t.id, numero: t.numero, folio: t.folio, titulo: t.titulo, prsExternos: salida },
    { merge: true },
  );
  return salida;
}

/**
 * Re-verifica en el servidor los PRs que eligió quien cierra: cada URL tiene que
 * ser de un repo de Sozu, cumplir la convención para este folio y estar en main.
 * No se fía del registro: `agente_tickets_enviados` lo puede escribir el propio
 * dueño desde el navegador.
 *
 * Devuelve las entradas en el formato de `prs` del registro (repo, pr, url,
 * cambios), con el PR hacia main cuando lo hay, igual que el flujo con Claude.
 */
export async function verificarPrsExternos(
  gh: Octokit,
  numero: number,
  urls: string[],
): Promise<{ repo: string; pr: number; url: string; cambios: string[]; enPrd: boolean }[]> {
  const repos = new Set((await reposDeSozu()).map((r) => clave(r.owner, r.repo)));
  const c = criteriosTicket(numero);
  return Promise.all([...new Set(urls)].slice(0, MAX_PRS).map(async (url) => {
    const m = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/);
    if (!m || !repos.has(clave(m[1], m[2]))) throw new Error(`pr_ajeno:${url}`);
    const [, owner, repo, n] = m;
    const { data: pr } = await gh.pulls.get({ owner, repo, pull_number: Number(n) });
    let es = razonesDePr(pr, numero).length > 0;
    if (!es) {
      const { data: commits } = await gh.pulls.listCommits({ owner, repo, pull_number: pr.number, per_page: 100 });
      es = commits.some((x) => c.trailer.test(x.commit.message));
    }
    if (!es) throw new Error(`pr_no_es_del_ticket:${url}`);
    const estado = await estadoDePr(gh, url);
    if (!estado || (estado.estado !== "en_main" && estado.estado !== "en_prd")) throw new Error(`pr_sin_merge:${url}`);
    const lineas = await cambiosDePr(gh, estado, numero);
    return {
      repo,
      pr: estado.prMain?.numero ?? estado.numero,
      url: estado.prMain?.url ?? estado.url,
      cambios: lineas.length ? lineas : [estado.titulo],
      enPrd: estado.estado === "en_prd",
    };
  }));
}

/**
 * La nota que llega al portal tiene que decir qué PRs cerraron el ticket. Si
 * quien cierra la editó y quitó alguno, se agrega al final la lista completa.
 */
export function notaConPrs(nota: string, prs: { repo: string; pr: number; url: string }[]): string {
  // "sozu-admin #12" o "sozu-admin — PR hacia main #12" (la de `notaDeCierre`) o la URL.
  const nombrado = (p: { repo: string; pr: number; url: string }) =>
    nota.includes(p.url) || new RegExp(`${p.repo.replace(/[.-]/g, "\\$&")}[^\\n]*#${p.pr}(?!\\d)`).test(nota);
  const faltan = prs.filter((p) => !nombrado(p));
  if (!faltan.length) return nota;
  return `${nota.trim()}\n\nPRs que cerraron el ticket:\n${prs.map((p) => `- ${p.repo} #${p.pr} ${p.url}`).join("\n")}`;
}
