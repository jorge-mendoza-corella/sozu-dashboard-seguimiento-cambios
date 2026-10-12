/**
 * En qué va cada PR que Claude Code abrió para un ticket, y si el ticket ya se
 * puede cerrar: TODOS sus PRs (los que no se cerraron sin merge) en PRD.
 *
 * No depende de que alguien haya visto el deploy en el dashboard: se pregunta a
 * GitHub directo.
 *   abierto  -> el PR hacia dev no se ha mergeado
 *   en_dev   -> mergeado a dev, su commit aún no está en main
 *   en_main  -> ya está en main, pero el último deploy exitoso a PRD no lo trae
 *   en_prd   -> el último deploy exitoso a PRD (workflow "deploy" en main) lo incluye
 *   cerrado  -> se cerró sin merge: no cuenta para cerrar el ticket
 *
 * Gasta llamadas del token del dashboard (el mismo límite de 5,000/h que todo lo
 * demás), así que el resultado se guarda en el registro de enviados y se rehace
 * como mucho cada REVISAR_MS, salvo que se pida forzar (tras un deploy a PRD).
 */
import type { Octokit } from "@octokit/rest";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

export type EstadoPr = "abierto" | "en_dev" | "en_main" | "en_prd" | "cerrado";

export interface PrClaude {
  url: string;
  owner: string;
  repo: string;
  numero: number;
  titulo: string;
  estado: EstadoPr;
  /** PR hacia main que lo llevó a producción, si ya llegó a main. */
  prMain: { numero: number; url: string } | null;
}

export interface EstadoPrsTicket {
  prs: PrClaude[];
  /** Todos los PRs vigentes ya están en PRD (y hay al menos uno). */
  listo: boolean;
  revisadoEn: string;
}

const REVISAR_MS = 10 * 60_000;
const TRAILER = /^Ticket-SOZU:\s*#(\d+)/im;

/** ¿El commit `sha` ya está contenido en `base` (rama o sha)? */
async function contenido(gh: Octokit, owner: string, repo: string, base: string, sha: string): Promise<boolean> {
  try {
    const { data } = await gh.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${sha}`, per_page: 1 });
    return data.status === "identical" || data.status === "behind";
  } catch {
    return false;
  }
}

/** Sha del último deploy exitoso a PRD (workflows con "deploy" en el nombre, en main, sin "dev"). */
async function shaPrd(gh: Octokit, owner: string, repo: string): Promise<string | null | "sin_deploy"> {
  const { data } = await gh.actions.listWorkflowRunsForRepo({ owner, repo, branch: "main", status: "success", per_page: 30 });
  const deploys = data.workflow_runs.filter((r) => /deploy/i.test(r.name ?? "") && !/\bdev\b/i.test(r.name ?? ""));
  if (deploys.length) return deploys[0].head_sha;
  // Repos sin workflow de deploy (p. ej. solo documentación): llegar a main es llegar a producción.
  return "sin_deploy";
}

async function estadoDePr(gh: Octokit, url: string): Promise<PrClaude | null> {
  const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (!m) return null;
  const [, owner, repo, n] = m;
  const { data: pr } = await gh.pulls.get({ owner, repo, pull_number: Number(n) });
  const base: PrClaude = { url: pr.html_url, owner, repo, numero: pr.number, titulo: pr.title, estado: "abierto", prMain: null };
  if (!pr.merged_at) return { ...base, estado: pr.state === "closed" ? "cerrado" : "abierto" };

  const sha = pr.merge_commit_sha ?? pr.head.sha;
  if (!(await contenido(gh, owner, repo, "main", sha))) return { ...base, estado: "en_dev" };

  // El PR hacia main que lo llevó (para la nota de cierre).
  let prMain: PrClaude["prMain"] = null;
  try {
    const { data: asociados } = await gh.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: sha });
    const pm = asociados.find((p) => p.base.ref === "main" && p.merged_at);
    if (pm) prMain = { numero: pm.number, url: pm.html_url };
  } catch {
    /* sin el PR a main la nota usa el PR hacia dev */
  }

  const prd = await shaPrd(gh, owner, repo);
  const enPrd = prd === "sin_deploy" || (!!prd && (await contenido(gh, owner, repo, prd, sha)));
  return { ...base, estado: enPrd ? "en_prd" : "en_main", prMain };
}

/** Primeras líneas de los commits del PR que traen el trailer de este ticket. */
async function cambiosDePr(gh: Octokit, p: PrClaude, numeroTicket: number): Promise<string[]> {
  try {
    const { data } = await gh.pulls.listCommits({ owner: p.owner, repo: p.repo, pull_number: p.numero, per_page: 100 });
    const lineas = data
      .map((c) => c.commit.message)
      .filter((msg) => Number(msg.match(TRAILER)?.[1]) === numeroTicket)
      .map((msg) => msg.split("\n")[0].trim().replace(/^\w+(\([^)]*\))?!?:\s*/, "").replace(/^./, (c) => c.toUpperCase()))
      .filter(Boolean);
    return [...new Set(lineas)].slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * Estado de los PRs del ticket, desde el registro si es reciente. Si todos
 * llegaron a PRD, deja en el registro lo que necesita el cierre (`prs` con la
 * nota por repo y `listoParaCerrar`).
 */
export async function estadoPrsTicket(
  gh: Octokit,
  email: string,
  ticketId: string,
  urls: string[],
  forzar = false,
): Promise<EstadoPrsTicket> {
  const ref = getFirestore().doc(`agente_tickets_enviados/${email}__${ticketId}`);
  const reg = (await ref.get()).data() ?? {};
  const previo = reg.prsClaude as EstadoPrsTicket | undefined;
  const mismos = !!previo && previo.prs.length === urls.length && urls.every((u) => previo.prs.some((p) => p.url === u));
  const reciente = !!previo && Date.now() - Date.parse(previo.revisadoEn) < REVISAR_MS;
  // Ya listo no cambia; reciente y con los mismos PRs, se reusa.
  if (previo && mismos && (previo.listo || (reciente && !forzar))) return previo;
  if (!urls.length) return { prs: [], listo: false, revisadoEn: new Date().toISOString() };

  const prs = (await Promise.all(urls.map((u) => estadoDePr(gh, u).catch(() => null)))).filter((p): p is PrClaude => !!p);
  const vigentes = prs.filter((p) => p.estado !== "cerrado");
  const listo = vigentes.length > 0 && vigentes.every((p) => p.estado === "en_prd");
  const estado: EstadoPrsTicket = { prs, listo, revisadoEn: new Date().toISOString() };

  const cambios: Record<string, unknown> = { prsClaude: estado };
  // Apareció otro PR después de estar listo: vuelve a esperar a que llegue a PRD.
  if (!listo && reg.listoParaCerrar) cambios.listoParaCerrar = false;
  if (listo && !reg.listoParaCerrar) {
    const numero = Number(reg.numero);
    cambios.listoParaCerrar = true;
    cambios.listoEn = FieldValue.serverTimestamp();
    cambios.prs = await Promise.all(vigentes.map(async (p) => {
      const lineas = await cambiosDePr(gh, p, numero);
      return {
        repo: p.repo,
        pr: p.prMain?.numero ?? p.numero,
        url: p.prMain?.url ?? p.url,
        cambios: lineas.length ? lineas : [p.titulo],
      };
    }));
  }
  await ref.set(cambios, { merge: true });
  return estado;
}
