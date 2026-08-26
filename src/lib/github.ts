import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: import.meta.env.VITE_GITHUB_TOKEN });

const reviewerOctokit = import.meta.env.VITE_GITHUB_REVIEWER_TOKEN
  ? new Octokit({ auth: import.meta.env.VITE_GITHUB_REVIEWER_TOKEN })
  : null;

// ---------------------------------------------------------------------------
// Token de sesión: cada usuario del dashboard opera con SU PAT (guardado en
// Firestore users/{email}.githubToken). Las ACCIONES (crear PR, merge, cerrar)
// salen a nombre de su cuenta real de GitHub. Las lecturas siguen usando el
// token de env (compartido) para no fragmentar el rate limit por usuario.
// Fallback: sin token de sesión (root/legacy) se usa el token de env.
// ---------------------------------------------------------------------------
let sessionOctokit: Octokit | null = null;
let sessionLogin: string | null = null;

export function setSessionGithubAuth(token: string | null, login: string | null) {
  sessionOctokit = token ? new Octokit({ auth: token }) : null;
  sessionLogin = login;
}

export const getSessionLogin = () => sessionLogin;

/** Octokit con el que se ejecutan las acciones del usuario actual. */
const actor = () => sessionOctokit ?? octokit;

/**
 * Traduce los 403/404 de GitHub en acciones de escritura (merge, cerrar PR).
 *
 * GitHub contesta **404 en vez de 403** cuando el token no tiene permiso de
 * escritura: no revela la existencia de lo que no puedes tocar. Ese "Not Found"
 * pelón llegaba tal cual a la tarjeta de CI/CD y se leía como "el PR ya no
 * existe", cuando el PR estaba ahí, aprobado y mergeable — el que no alcanzaba
 * era el token. Se consulta qué puede hacer de verdad la cuenta que actúa para
 * decirlo con todas sus letras; si resulta que sí puede escribir, el 404 es de
 * otra cosa y el error original se deja intacto.
 */
async function errorDeEscritura(err: unknown, owner: string, repo: string, accion: string): Promise<unknown> {
  const status = (err as { status?: number }).status;
  if (status !== 403 && status !== 404) return err;

  const quien = sessionLogin ? `@${sessionLogin}` : "el token de entorno del dashboard";
  let alcance = "no tiene permiso de escritura en";
  try {
    const { data } = await actor().repos.get({ owner, repo });
    if (data.permissions?.push) return err;
  } catch {
    alcance = "ni siquiera puede ver";
  }

  return new Error(
    `GitHub responde ${status} al ${accion}: ${quien} ${alcance} ${owner}/${repo}. ` +
    "Un 404 aquí significa \"sin permiso\", no \"no existe\": el PR sigue abierto. " +
    "Registra una API key de GitHub (token classic con scope \"repo\") de una cuenta con acceso de escritura al repo.",
  );
}

/** Credenciales del aprobador configurado para un proyecto. */
export interface ApproverAuth {
  token: string;
  login: string;
}

/** Repos por defecto — usados solo para sembrar el proyecto inicial "SOZU". */
export const REPOS = [
  { owner: "jorgeIMendoza", repo: "sozu-admin", label: "sozu-admin" },
  { owner: "jorgeIMendoza", repo: "sozu-supabase-migrations", label: "sozu-supabase-migrations" },
  { owner: "jorgeIMendoza", repo: "sozu-edge-functions", label: "sozu-edge-functions" },
  { owner: "jorgeIMendoza", repo: "sozu-n8n-workflows", label: "sozu-n8n-workflows" },
  { owner: "sozu-com", repo: "server-stp", label: "server-stp" },
] as const;

/** Forma mínima de un repo para las funciones de agregación. */
export interface RepoRef {
  owner: string;
  repo: string;
  label: string;
}

/** Parsea un link/owner-repo de GitHub. Acepta URL completa, git@, o "owner/repo". */
export function parseRepoUrl(input: string): { owner: string; repo: string } | null {
  const s = input.trim();
  if (!s) return null;
  // owner/repo simple
  const simple = s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (simple) return { owner: simple[1], repo: simple[2] };
  // URL https o git@
  const url = s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (url) return { owner: url[1], repo: url[2] };
  return null;
}

export interface RepoAccess {
  ok: boolean;
  status: number;
  canPush: boolean; // el token principal es colaborador con permiso de escritura
  isPrivate?: boolean;
  fullName?: string;
  error?: string;
}

/** Valida que el token principal pueda acceder al repo y con qué nivel. */
export async function validateRepoAccess(owner: string, repo: string): Promise<RepoAccess> {
  try {
    const { data } = await octokit.repos.get({ owner, repo });
    const perms = (data as { permissions?: { push?: boolean; admin?: boolean } }).permissions;
    return {
      ok: true,
      status: 200,
      canPush: !!(perms?.push || perms?.admin),
      isPrivate: data.private,
      fullName: data.full_name,
    };
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status ?? 0;
    return {
      ok: false,
      status,
      canPush: false,
      error: status === 404
        ? "No encontrado o el token no tiene acceso (404)."
        : status === 403
          ? "Acceso denegado (403)."
          : err instanceof Error ? err.message : "Error desconocido",
    };
  }
}

/** Cuentas GitHub detrás de los tokens (para mostrar a quién dar permisos). */
export async function getTokenAccounts(): Promise<{ primary: string | null; reviewer: string | null }> {
  const [primary, reviewer] = await Promise.all([
    octokit.users.getAuthenticated().then((r) => r.data.login).catch(() => null),
    reviewerOctokit
      ? reviewerOctokit.users.getAuthenticated().then((r) => r.data.login).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { primary, reviewer };
}

export interface BranchInfo {
  name: string;
  lastCommitSha: string;
  lastCommitMessage: string;
  lastCommitAuthor: string;
  lastCommitDate: string;
  aheadOfMain: number;
  aheadOfDev: number;
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  head: string;
  base: string;
  url: string;
  createdAt: string;
  draft: boolean;
  checksState: "success" | "failure" | "pending" | "unknown";
  /** Quién CREÓ el PR en GitHub. No siempre es quien escribió el código. */
  author: string;
  /**
   * Autores REALES: los marcadores `<!-- pr_author: login -->` que el dashboard
   * embebe en el cuerpo según los commits, o el creador si no hay ninguno.
   *
   * Es la lista que notifican los workflows, y la que hay que mostrar. Con
   * `author` a secas, un PR creado desde el dashboard por una persona para los
   * commits de otra decía que se le avisaría a quien apretó el botón — y el
   * WhatsApp le llegaba al que sí escribió el código.
   */
  authors: string[];
  requestedReviewers: string[];
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  hasConflict: boolean;
}

export interface WorkflowRun {
  name: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  url: string;
  headBranch: string | null;
  headSha?: string;
  /** Login de quien disparó el run (el que hizo el push/merge). */
  actor?: string | null;
  /** Id del run en GitHub: la llave con la que el CI anota a quién avisó. */
  runId?: number;
}

export interface RepoStatus {
  owner: string;
  repo: string;
  label: string;
  branches: BranchInfo[];
  openPRs: PullRequest[];
  latestRuns: WorkflowRun[];
  error?: string;
}

// Caché sha → login del autor: el SHA es inmutable, así que los refetch
// periódicos no repiten llamadas para ramas que no se movieron.
const commitAuthorCache = new Map<string, string>();

async function getCommitAuthorCached(owner: string, repo: string, sha: string): Promise<string> {
  const hit = commitAuthorCache.get(sha);
  if (hit !== undefined) return hit;
  const author = await octokit.repos
    .getCommit({ owner, repo, ref: sha })
    .then((r) => r.data.author?.login ?? r.data.commit.author?.name ?? "")
    .catch(() => "");
  commitAuthorCache.set(sha, author);
  if (commitAuthorCache.size > 500) commitAuthorCache.clear(); // tope simple
  return author;
}

/**
 * Logins de GitHub que autoraron los commits de head vs base — para
 * notificar automáticamente a los verdaderos autores del PR.
 */
export async function getBranchCommitAuthors(
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<string[]> {
  try {
    const { data } = await octokit.repos.compareCommits({ owner, repo, base, head });
    const logins = new Set<string>();
    for (const c of data.commits) {
      const l = c.author?.login;
      if (l && !l.includes("[bot]")) logins.add(l);
    }
    return [...logins];
  } catch {
    return [];
  }
}

/** Contribuidores históricos del repo (para configurar notificables por proyecto). */
export async function listRepoContributors(owner: string, repo: string): Promise<string[]> {
  try {
    const { data } = await octokit.repos.listContributors({ owner, repo, per_page: 60 });
    return data
      .map((c) => c.login)
      .filter((l): l is string => !!l && !l.includes("[bot]"));
  } catch {
    return [];
  }
}

export interface DeployMeta {
  /** Autores reales del PR (marcadores pr_author) o creador. */
  authors: string[];
  /** Quién(es) aprobaron el PR y si fue bypass automático del dashboard. */
  approvedBy: Array<{ login: string; auto: boolean }>;
  /** Quién hizo el merge que disparó el deploy. */
  mergedBy: string | null;
  prNumber: number | null;
  /**
   * Rama destino del PR y si llegó a mergearse. Sin esto, un `approvedBy`
   * vacío se pintaba como un guion: no distinguía "se mergeó sin aprobación
   * vigente" —lo normal en ramas no productivas, donde el dashboard hace
   * bypass— de "main sin aprobar", que sí sería grave.
   */
  baseRef: string | null;
  merged: boolean;
}

/**
 * Autores reales de un PR: los marcadores `<!-- pr_author: login -->` de su
 * cuerpo, que es exactamente lo que leen los workflows para decidir a quién
 * avisar. Sin marcadores queda el creador, que es lo que hacen ellos también.
 */
function autoresDelCuerpo(body: string | null | undefined, creador?: string): string[] {
  const marcados = [...(body ?? "").matchAll(/<!-- pr_author: ([\w.-]+) -->/g)].map((m) => m[1]);
  const unicos = [...new Set(marcados)];
  return unicos.length > 0 ? unicos : creador ? [creador] : [];
}

/**
 * Metadatos de un deploy a partir de su commit: PR asociado, autores,
 * aprobadores y quién mergeó. Se consulta perezosamente (hover del tooltip).
 */
export async function getDeployMeta(owner: string, repo: string, headSha: string): Promise<DeployMeta> {
  const empty: DeployMeta = {
    authors: [], approvedBy: [], mergedBy: null, prNumber: null, baseRef: null, merged: false,
  };
  try {
    const { data: prs } = await octokit.repos.listPullRequestsAssociatedWithCommit({
      owner, repo, commit_sha: headSha,
    });
    const pr = prs[0];
    if (!pr) return empty;
    const [detail, reviews] = await Promise.all([
      octokit.pulls.get({ owner, repo, pull_number: pr.number }),
      octokit.pulls.listReviews({ owner, repo, pull_number: pr.number, per_page: 50 }),
    ]);

    // Bypass = review marcada por el dashboard, o (heurística para reviews
    // viejas sin marca) approve casi simultáneo al merge en PRs que no van a main.
    const mergedAtMs = detail.data.merged_at ? new Date(detail.data.merged_at).getTime() : null;
    const isMainPR = detail.data.base.ref === "main";
    const seen = new Set<string>();
    const approvedBy = reviews.data
      .filter((r) => r.state === "APPROVED")
      .map((r) => {
        const submitted = r.submitted_at ? new Date(r.submitted_at).getTime() : null;
        const nearMerge = mergedAtMs !== null && submitted !== null && Math.abs(mergedAtMs - submitted) < 90_000;
        return {
          login: r.user?.login ?? "?",
          auto: (r.body ?? "").toLowerCase().includes("bypass") || (!isMainPR && nearMerge),
        };
      })
      .filter((a) => (seen.has(a.login) ? false : (seen.add(a.login), true)));
    return {
      authors: autoresDelCuerpo(detail.data.body, detail.data.user?.login ?? "?"),
      approvedBy,
      mergedBy: detail.data.merged_by?.login ?? null,
      prNumber: pr.number,
      baseRef: detail.data.base.ref,
      merged: !!detail.data.merged_at,
    };
  } catch {
    return empty;
  }
}

/**
 * Nombre público de una cuenta de GitHub (`name` del perfil), o null.
 *
 * Una petición por cuenta, así que se pide SOLO cuando alguien abre una ficha,
 * nunca al pintar una lista: la cuota de la API es una sola para todo el
 * dashboard y treinta tarjetas serían treinta llamadas por render. El resultado
 * se cachea —incluido el "no tiene nombre"— porque un perfil no cambia entre
 * dos clics.
 */
const nombresGitHub = new Map<string, string | null>();
export async function getGithubDisplayName(login: string): Promise<string | null> {
  if (nombresGitHub.has(login)) return nombresGitHub.get(login) ?? null;
  try {
    const { data } = await octokit.users.getByUsername({ username: login });
    const nombre = data.name?.trim() || null;
    nombresGitHub.set(login, nombre);
    return nombre;
  } catch {
    // Un fallo NO se cachea: si fue el rate limit, la próxima vez que se abra
    // la ficha vuelve a intentarlo en vez de quedarse sin nombre para siempre.
    return null;
  }
}

/** SHA del HEAD de una rama (null si la rama/repo no existe o no hay acceso). */
export async function getBranchHeadSha(owner: string, repo: string, branch: string): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getBranch({ owner, repo, branch });
    return data.commit.sha;
  } catch {
    return null;
  }
}

/**
 * True si el repo tiene algún workflow de deploy corriendo o en cola.
 * Se usa para bloquear builds de app hasta que termine el deploy web.
 */
export async function hasActiveDeployRun(owner: string, repo: string): Promise<boolean> {
  const [inProgress, queued] = await Promise.all([
    octokit.actions.listWorkflowRunsForRepo({ owner, repo, status: "in_progress", per_page: 20 }),
    octokit.actions.listWorkflowRunsForRepo({ owner, repo, status: "queued", per_page: 20 }),
  ]);
  return [...inProgress.data.workflow_runs, ...queued.data.workflow_runs]
    .some((r) => /deploy/i.test(r.name ?? ""));
}

/**
 * True si el deploy MÁS RECIENTE de alguna rama falló. Un deploy exitoso
 * posterior en la misma rama limpia el fallo previo, así que no se reporta
 * como fallando. `latestRuns` viene ordenado más-nuevo-primero, por lo que
 * el primer run visto por rama es el último deploy de esa rama.
 */
export function hasFailingDeploy(latestRuns: WorkflowRun[]): boolean {
  const latestByBranch = new Map<string, WorkflowRun>();
  for (const r of latestRuns) {
    const key = r.headBranch ?? "";
    if (!latestByBranch.has(key)) latestByBranch.set(key, r);
  }
  for (const r of latestByBranch.values()) {
    if (r.conclusion === "failure") return true;
  }
  return false;
}

/**
 * Estado de revisión tal como lo evalúa GitHub (`reviewDecision` de GraphQL):
 * respeta la protección de rama, incluido `require_code_owner_reviews`. Con
 * CODEOWNERS un approve de alguien que no es dueño del código deja el PR en
 * REVIEW_REQUIRED — el cálculo por REST (solo mirar los states) lo daba por
 * APPROVED y el dashboard mostraba aprobado un PR que GitHub no dejaba mergear.
 * `reviewDecision` es null en repos sin reviews requeridas: ahí se cae al
 * cálculo manual con las reviews de la misma query.
 */
async function getPRReviewDecision(
  owner: string,
  repo: string,
  pullNumber: number,
  requestedReviewers: string[],
): Promise<"APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null> {
  try {
    const gql = `query {
      repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
        pullRequest(number: ${pullNumber}) {
          reviewDecision
          latestReviews(last: 50) { nodes { state author { login } } }
        }
      }
    }`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await octokit.graphql(gql);
    const pr = data.repository?.pullRequest;
    const decision = pr?.reviewDecision as string | null | undefined;
    if (decision === "APPROVED" || decision === "CHANGES_REQUESTED" || decision === "REVIEW_REQUIRED") {
      return decision;
    }
    const states: string[] = (pr?.latestReviews?.nodes ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((n: any) => n?.state)
      .filter((s: string | undefined): s is string => !!s && s !== "COMMENTED");
    if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
    if (states.includes("APPROVED")) return "APPROVED";
    if (requestedReviewers.length > 0) return "REVIEW_REQUIRED";
    return null;
  } catch {
    return requestedReviewers.length > 0 ? "REVIEW_REQUIRED" : null;
  }
}

// ---------------------------------------------------------------------------
// CODEOWNERS: con `require_code_owner_reviews` GitHub exige la review de los
// dueños del código, no de cualquiera. El dashboard firma también con la cuenta
// del dueño (si hay token para ella) para que un approve desde aquí valga tanto
// para main como para dev.
// ---------------------------------------------------------------------------

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
const codeOwnersCache = new Map<string, Promise<string[]>>();

/** Logins (sin @) que son dueños del repo según CODEOWNERS. Los teams se omiten. */
export function getCodeOwnerLogins(owner: string, repo: string): Promise<string[]> {
  const key = `${owner}/${repo}`;
  const cached = codeOwnersCache.get(key);
  if (cached) return cached;

  const task = (async () => {
    for (const path of CODEOWNERS_PATHS) {
      try {
        const { data } = await octokit.repos.getContent({ owner, repo, path });
        const content = (data as { content?: string }).content;
        if (!content) continue;
        const text = atob(content.replace(/\n/g, ""));
        const logins = new Set<string>();
        for (const rawLine of text.split("\n")) {
          const line = rawLine.split("#")[0].trim();
          if (!line) continue;
          for (const token of line.split(/\s+/).slice(1)) {
            if (token.startsWith("@") && !token.includes("/")) logins.add(token.slice(1));
          }
        }
        return [...logins];
      } catch {
        /* ese path no existe: probar el siguiente */
      }
    }
    return [];
  })();

  codeOwnersCache.set(key, task);
  return task;
}

const envAuthCache = new Map<string, Promise<ApproverAuth | null>>();

/** Credenciales de un token de env (su login se resuelve una sola vez). */
function getEnvAuth(kind: "primary" | "reviewer"): Promise<ApproverAuth | null> {
  const cached = envAuthCache.get(kind);
  if (cached) return cached;
  const token = (kind === "primary"
    ? import.meta.env.VITE_GITHUB_TOKEN
    : import.meta.env.VITE_GITHUB_REVIEWER_TOKEN) as string | undefined;
  const client = kind === "primary" ? octokit : reviewerOctokit;
  const task: Promise<ApproverAuth | null> = token && client
    ? client.users.getAuthenticated().then((r) => ({ token, login: r.data.login })).catch(() => null)
    : Promise.resolve(null);
  envAuthCache.set(kind, task);
  return task;
}

/**
 * Aprueba el PR con la cuenta de cada CODEOWNER que aún no lo haya aprobado y
 * para la que tengamos token (aprobador del proyecto, usuarios del dashboard o
 * el reviewer de env). Devuelve los logins con los que se firmó.
 * No hace nada si el repo no tiene CODEOWNERS, o si el único dueño es el autor
 * del PR (GitHub no permite aprobar tu propio PR).
 */
export async function ensureCodeOwnerApproval(
  owner: string,
  repo: string,
  pullNumber: number,
  prAuthor: string,
  auths: ApproverAuth[] = [],
): Promise<string[]> {
  const owners = await getCodeOwnerLogins(owner, repo);
  if (owners.length === 0) return [];

  // Los tokens de env también sirven: el principal suele ser la cuenta dueña
  // del repo, que es justo el CODEOWNER que GitHub está esperando.
  const [envPrimary, envReviewer] = await Promise.all([getEnvAuth("primary"), getEnvAuth("reviewer")]);
  const byLogin = new Map<string, ApproverAuth>();
  for (const a of [...auths, envPrimary, envReviewer]) {
    if (a?.token && a.login) byLogin.set(a.login.toLowerCase(), a);
  }

  // Quién ya tiene un approve vigente (las dismissed vienen como DISMISSED).
  const approved = new Set<string>();
  try {
    const { data: reviews } = await octokit.pulls.listReviews({ owner, repo, pull_number: pullNumber });
    for (const r of reviews) {
      if (r.state === "APPROVED" && r.user?.login) approved.add(r.user.login.toLowerCase());
    }
  } catch {
    /* sin lectura de reviews: intentamos aprobar igual, GitHub deduplica */
  }

  const signed: string[] = [];
  for (const login of owners) {
    const key = login.toLowerCase();
    if (key === prAuthor.toLowerCase()) continue; // nadie aprueba su propio PR
    if (approved.has(key)) continue;
    const auth = byLogin.get(key);
    if (!auth) continue;
    try {
      await new Octokit({ auth: auth.token }).pulls.createReview({
        owner, repo, pull_number: pullNumber, event: "APPROVE",
        body: "Aprobado desde el dashboard como dueño del código (CODEOWNERS).",
      });
      signed.push(auth.login);
    } catch {
      /* si esta cuenta no puede aprobar, seguimos con el resto */
    }
  }
  return signed;
}

async function getAheadBy(owner: string, repo: string, base: string, head: string): Promise<number> {
  try {
    // per_page 1: solo interesa ahead_by; sin esto GitHub arma y manda hasta
    // 250 commits con archivos por comparación — payload y latencia enormes.
    const { data } = await octokit.repos.compareCommits({ owner, repo, base, head, per_page: 1 });
    return data.ahead_by;
  } catch {
    return 0;
  }
}

export async function fetchRepoStatus(owner: string, repo: string, label: string): Promise<RepoStatus> {
  try {
    const [branchesResp, prsResp, runsResp] = await Promise.all([
      octokit.repos.listBranches({ owner, repo, per_page: 100 }),
      octokit.pulls.list({ owner, repo, state: "open", per_page: 20 }),
      octokit.actions.listWorkflowRunsForRepo({ owner, repo, per_page: 20 }),
    ]);

    // listBranches devuelve las ramas en orden alfabético y paginado, así que
    // en repos con muchas ramas (cambios_*, feat/*) "main" puede quedar fuera.
    // Traemos main y dev explícitamente si no vinieron en la lista.
    const rawBranches = [...branchesResp.data];
    for (const required of ["main", "dev"]) {
      if (!rawBranches.some((b) => b.name === required)) {
        try {
          const { data } = await octokit.repos.getBranch({ owner, repo, branch: required });
          rawBranches.push(data as unknown as (typeof rawBranches)[number]);
        } catch {
          /* la rama no existe en este repo */
        }
      }
    }

    // Ordenar antes de slicear: main y dev primero, así nunca quedan fuera por paginación
    const sortedRaw = [
      ...rawBranches.filter((b) => b.name === "main"),
      ...rawBranches.filter((b) => b.name === "dev"),
      ...rawBranches.filter((b) => b.name !== "main" && b.name !== "dev"),
    ];

    // Una sola consulta GraphQL por repo para TODAS las ramas: autor del
    // último commit + aheadBy vs main/dev. Antes eran ~3 llamadas REST por
    // rama (30 por repo) y GitHub encolaba el aluvión — esto era la causa
    // principal de la lentitud del dashboard.
    const top = sortedRaw.slice(0, 10);
    let branches: BranchInfo[];
    try {
      const parts = top.map((b, i) => {
        const ref = JSON.stringify(`refs/heads/${b.name}`);
        const head = JSON.stringify(b.name);
        let q = `b${i}: ref(qualifiedName: ${ref}) { target { ... on Commit { author { user { login } name } } } }`;
        if (b.name !== "main") {
          q += `\nm${i}: ref(qualifiedName: "refs/heads/main") { compare(headRef: ${head}) { aheadBy } }`;
        }
        if (b.name !== "main" && b.name !== "dev") {
          q += `\nd${i}: ref(qualifiedName: "refs/heads/dev") { compare(headRef: ${head}) { aheadBy } }`;
        }
        return q;
      });
      const gql = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ${parts.join("\n")} } }`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await octokit.graphql(gql);
      branches = top.map((b, i) => {
        const node = data.repository?.[`b${i}`]?.target?.author;
        return {
          name: b.name,
          lastCommitSha: b.commit.sha.slice(0, 7),
          lastCommitMessage: "",
          lastCommitAuthor: b.name === "main" || b.name === "dev"
            ? ""
            : (node?.user?.login ?? node?.name ?? ""),
          lastCommitDate: "",
          aheadOfMain: data.repository?.[`m${i}`]?.compare?.aheadBy ?? 0,
          aheadOfDev: data.repository?.[`d${i}`]?.compare?.aheadBy ?? 0,
        };
      });
    } catch {
      // Fallback REST (lento) si GraphQL falla por lo que sea.
      branches = await Promise.all(
        top.map(async (b) => {
          const [aheadMain, aheadDev] = await Promise.all([
            b.name !== "main" ? getAheadBy(owner, repo, "main", b.name) : Promise.resolve(0),
            b.name !== "dev" && b.name !== "main" ? getAheadBy(owner, repo, "dev", b.name) : Promise.resolve(0),
          ]);
          const author = b.name === "main" || b.name === "dev"
            ? ""
            : await getCommitAuthorCached(owner, repo, b.commit.sha);
          return {
            name: b.name,
            lastCommitSha: b.commit.sha.slice(0, 7),
            lastCommitMessage: "",
            lastCommitAuthor: author,
            lastCommitDate: "",
            aheadOfMain: aheadMain,
            aheadOfDev: aheadDev,
          };
        })
      );
    }

    const openPRs: PullRequest[] = await Promise.all(
      prsResp.data.map(async (pr) => {
        const requestedReviewers = pr.requested_reviewers?.map((r) => r.login) ?? [];
        const [reviewDecision, prDetail] = await Promise.all([
          getPRReviewDecision(owner, repo, pr.number, requestedReviewers),
          octokit.pulls.get({ owner, repo, pull_number: pr.number }).catch(() => null),
        ]);
        return {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          head: pr.head.ref,
          base: pr.base.ref,
          url: pr.html_url,
          createdAt: pr.created_at,
          draft: pr.draft ?? false,
          checksState: "unknown" as const,
          author: pr.user?.login ?? "",
          authors: autoresDelCuerpo(prDetail?.data.body ?? pr.body, pr.user?.login),
          requestedReviewers,
          reviewDecision,
          hasConflict: prDetail?.data.mergeable === false,
        };
      }),
    );

    const latestRuns: WorkflowRun[] = runsResp.data.workflow_runs
      .filter((r) => (r.name ?? "").toLowerCase().includes("deploy"))
      // Solo deploys de las ramas reales (main/dev). Runs en ramas de feature
      // o PR no deben marcar el repo como fallando ni mostrarse como deploy.
      .filter((r) => ["main", "dev"].includes(r.head_branch ?? ""))
      .slice(0, 3)
      .map((r) => ({
        name: r.name ?? "Workflow",
        status: r.status ?? "unknown",
        conclusion: r.conclusion ?? null,
        createdAt: r.created_at,
        url: r.html_url,
        headBranch: r.head_branch ?? null,
        headSha: r.head_sha,
        actor: r.triggering_actor?.login ?? r.actor?.login ?? null,
        runId: r.id,
      }));

    return { owner, repo, label, branches, openPRs, latestRuns };
  } catch (err: unknown) {
    return {
      owner, repo, label, branches: [], openPRs: [], latestRuns: [],
      error: mensajeDeError(err),
    };
  }
}

/**
 * El error de GitHub en cristiano.
 *
 * El de rate limit llega con tres líneas de texto legal y un request ID, y así
 * se pintaba entero en cada tarjeta: seis párrafos rojos que tapaban la pantalla
 * sin decir lo único que importa —que no es un fallo del repo y que se arregla
 * solo—. El token de lectura es uno para todo el dashboard, así que cuando se
 * agota, se agota para todos a la vez.
 */
function mensajeDeError(err: unknown): string {
  const e = err as { status?: number; message?: string; response?: { headers?: Record<string, string> } };
  const esLimite = e?.status === 403 && (e.message ?? "").toLowerCase().includes("rate limit");
  if (!esLimite) return e?.message ?? "Error desconocido";
  const reset = Number(e.response?.headers?.["x-ratelimit-reset"] ?? 0);
  const cuando = reset
    ? new Date(reset * 1000).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    "GitHub limitó las peticiones de este token (5.000/hora, compartidas por todo el dashboard). "
    + (cuando ? `Se repone a las ${cuando}; ` : "Se repone en menos de una hora; ")
    + "hasta entonces no se puede leer el estado de los repos. No es un problema del repositorio."
  );
}

/** Cierra un PR sin hacer merge (como el usuario de la sesión). */
export async function closePR(owner: string, repo: string, pullNumber: number): Promise<void> {
  try {
    await actor().pulls.update({ owner, repo, pull_number: pullNumber, state: "closed" });
  } catch (err) {
    throw await errorDeEscritura(err, owner, repo, "cerrar el PR");
  }
}

export async function mergePR(
  owner: string,
  repo: string,
  pullNumber: number,
  mergeMethod: "merge" | "squash" | "rebase" = "merge",
): Promise<void> {
  try {
    await actor().pulls.merge({
      owner,
      repo,
      pull_number: pullNumber,
      merge_method: mergeMethod,
    });
  } catch (err) {
    throw await errorDeEscritura(err, owner, repo, "mergear");
  }
}

// Para ramas no-producción: aprueba y hace merge (bypass de branch protection).
// La aprobación la firma el APROBADOR configurado del proyecto; si el autor
// del PR es el propio aprobador (no puede aprobarse a sí mismo), o no hay
// aprobador configurado, se cae a los tokens legacy de env.
export async function mergeWithBypass(
  owner: string,
  repo: string,
  pullNumber: number,
  prAuthor: string,
  approver?: ApproverAuth,
  /** El PR ya tiene una aprobación: mergear sin volver a aprobar. */
  alreadyApproved = false,
  /** Credenciales disponibles para firmar como CODEOWNER si hace falta. */
  codeOwnerAuths: ApproverAuth[] = [],
): Promise<void> {
  // Con aprobación previa no hace falta el bypass, y re-aprobar borraría la
  // trazabilidad de quién revisó de verdad (quedaría marcado como automático).
  if (!alreadyApproved) {
    let approverOctokit: Octokit | null = null;

    if (approver && approver.login !== prAuthor) {
      approverOctokit = new Octokit({ auth: approver.token });
    } else if (reviewerOctokit) {
      const { data: reviewerUser } = await reviewerOctokit.users.getAuthenticated();
      approverOctokit = prAuthor === reviewerUser.login ? octokit : reviewerOctokit;
    }
    if (!approverOctokit) {
      throw new Error("Sin aprobador disponible: configura el aprobador del proyecto (con API key) o VITE_GITHUB_REVIEWER_TOKEN.");
    }

    await approverOctokit.pulls.createReview({
      owner, repo, pull_number: pullNumber, event: "APPROVE",
      body: "Auto-aprobado por el dashboard (bypass a ramas no productivas).",
    });
  }

  // El approve del aprobador no basta si el repo tiene CODEOWNERS: la
  // protección de dev exige la review del dueño del código. Se firma también
  // con esa cuenta (incluso si el PR ya estaba aprobado por otro).
  const auths = [...codeOwnerAuths, ...(approver ? [approver] : [])];
  await ensureCodeOwnerApproval(owner, repo, pullNumber, prAuthor, auths);

  try {
    await actor().pulls.merge({
      owner, repo, pull_number: pullNumber, merge_method: "merge",
    });
  } catch (err) {
    throw await errorDeEscritura(err, owner, repo, "mergear");
  }
}

export async function createPR(
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body: string = "",
  reviewerLogin?: string,
): Promise<{ number: number; url: string }> {
  const { data } = await actor().pulls.create({ owner, repo, title, head, base, body });

  // Asignar como reviewer al aprobador del proyecto (o al legacy de env).
  try {
    let login = reviewerLogin ?? null;
    if (!login && reviewerOctokit) {
      login = (await reviewerOctokit.users.getAuthenticated()).data.login;
    }
    if (login && login !== getSessionLogin()) {
      await actor().pulls.requestReviewers({
        owner, repo, pull_number: data.number, reviewers: [login],
      });
    }
  } catch {
    // Si falla asignar reviewer no bloqueamos la creación del PR
  }

  return { number: data.number, url: data.html_url };
}

export interface PRWithCommits {
  number: number;
  title: string;
  author: string;
  url: string;
  mergedAt: string;
  commits: Array<{ sha: string; message: string; author: string }>;
  /** Descripción del PR sin marcadores internos (<!-- pr_author -->, menciones). */
  description?: string;
}

/** Limpia el body de un PR: fuera marcadores y líneas de mención de autores. */
export function cleanPRDescription(body: string | null | undefined): string {
  return (body ?? "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("<!--") && !l.trim().startsWith("> 👤") && !l.includes("Generated with [Claude Code]"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Contenido del PRÓXIMO release dev→main (antes de crear el PR): los PRs
 * mergeados a dev que main aún no tiene, con sus commits y descripciones.
 */
export async function getPendingReleasePRs(owner: string, repo: string): Promise<PRWithCommits[]> {
  const { data } = await octokit.repos.compareCommits({ owner, repo, base: "main", head: "dev" });
  const nums = new Set<number>();
  for (const c of data.commits) {
    const m = c.commit.message.match(/^Merge pull request #(\d+)/);
    if (m) nums.add(Number(m[1]));
  }
  if (nums.size === 0) return [];

  const results: PRWithCommits[] = [];
  await Promise.all([...nums].map(async (num) => {
    try {
      const [{ data: pr }, { data: commits }] = await Promise.all([
        octokit.pulls.get({ owner, repo, pull_number: num }),
        octokit.pulls.listCommits({ owner, repo, pull_number: num, per_page: 30 }),
      ]);
      const bodyAuthor = (pr.body ?? "").match(/<!-- pr_author: ([\w.-]+) -->/)?.[1];
      results.push({
        number: pr.number,
        title: pr.title,
        author: bodyAuthor ?? pr.user?.login ?? "unknown",
        url: pr.html_url,
        mergedAt: pr.merged_at ?? "",
        description: cleanPRDescription(pr.body),
        commits: commits.map((c) => ({
          sha: c.sha.slice(0, 7),
          message: c.commit.message.split("\n")[0],
          author: c.author?.login ?? c.commit.author?.name ?? "unknown",
        })),
      });
    } catch { /* skip */ }
  }));

  return results.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
}

/** Dado un PR dev→main, devuelve los PRs de dev incluidos con sus commits. */
export async function getMergedDevPRsForRelease(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PRWithCommits[]> {
  const allCommits = await octokit.paginate(octokit.pulls.listCommits, {
    owner, repo, pull_number: prNumber, per_page: 100,
  });

  const devPRNums = new Set<number>();
  for (const c of allCommits) {
    const m = c.commit.message.match(/^Merge pull request #(\d+)/);
    if (m) devPRNums.add(Number(m[1]));
  }

  if (devPRNums.size === 0) return [];

  const results: PRWithCommits[] = [];
  await Promise.all([...devPRNums].map(async (num) => {
    try {
      const [{ data: pr }, { data: commits }] = await Promise.all([
        octokit.pulls.get({ owner, repo, pull_number: num }),
        octokit.pulls.listCommits({ owner, repo, pull_number: num, per_page: 30 }),
      ]);
      const bodyAuthor = (pr.body ?? "").match(/<!-- pr_author: ([\w.-]+) -->/)?.[1];
      results.push({
        number: pr.number,
        title: pr.title,
        author: bodyAuthor ?? pr.user?.login ?? "unknown",
        url: pr.html_url,
        mergedAt: pr.merged_at ?? "",
        commits: commits.map((c) => ({
          sha: c.sha.slice(0, 7),
          message: c.commit.message.split("\n")[0],
          author: c.author?.login ?? c.commit.author?.name ?? "unknown",
        })),
      });
    } catch { /* skip */ }
  }));

  return results.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
}

/** Dado el headSha de un deploy, devuelve los PRs y commits incluidos. */
export async function getDeployPRChain(
  owner: string,
  repo: string,
  headSha: string,
  headBranch: string | null,
): Promise<PRWithCommits[]> {
  // Obtener PR asociado al commit
  const { data: prs } = await octokit.repos.listPullRequestsAssociatedWithCommit({
    owner, repo, commit_sha: headSha,
  });

  const pr = prs[0];
  if (!pr) return [];

  // Si el deploy es de main, obtener la cadena de PRs de dev
  if (headBranch === "main") {
    return getMergedDevPRsForRelease(owner, repo, pr.number);
  }

  // Si es dev: devolver el PR con sus commits directamente
  const { data: commits } = await octokit.pulls.listCommits({
    owner, repo, pull_number: pr.number, per_page: 30,
  });
  const bodyAuthor = (pr.body ?? "").match(/<!-- pr_author: ([\w.-]+) -->/)?.[1];
  return [{
    number: pr.number,
    title: pr.title,
    author: bodyAuthor ?? pr.user?.login ?? "unknown",
    url: pr.html_url,
    mergedAt: pr.merged_at ?? "",
    commits: commits.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0],
      author: c.author?.login ?? c.commit.author?.name ?? "unknown",
    })),
  }];
}

export async function submitReview(
  owner: string,
  repo: string,
  pullNumber: number,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  body: string = "",
  approver?: ApproverAuth,
  /** Credenciales disponibles para firmar también como CODEOWNER. */
  codeOwnerAuths: ApproverAuth[] = [],
  /** Autor del PR: no se le puede pedir que apruebe su propio PR. */
  prAuthor: string = "",
): Promise<void> {
  // La review la firma el aprobador del proyecto; sin él, el token legacy.
  const reviewer = approver ? new Octokit({ auth: approver.token }) : reviewerOctokit;
  if (!reviewer) {
    throw new Error("Sin aprobador disponible: configura el aprobador del proyecto (con API key) o VITE_GITHUB_REVIEWER_TOKEN.");
  }
  await reviewer.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    event,
    body,
  });

  // Un approve solo cuenta para GitHub si lo firma un dueño del código cuando
  // el repo tiene CODEOWNERS. Se añade esa firma para que aprobar aquí deje el
  // PR realmente mergeable y no quede "Awaiting approval" en GitHub.
  if (event === "APPROVE") {
    const auths = [...codeOwnerAuths, ...(approver ? [approver] : [])];
    await ensureCodeOwnerApproval(owner, repo, pullNumber, prAuthor, auths);
  }
}

// ---------------------------------------------------------------------------
// Contribuidores
// ---------------------------------------------------------------------------

export interface ContributorRepoStat {
  repo: string;
  contributions: number;
}

export interface Contributor {
  login: string;
  avatarUrl: string;
  htmlUrl: string;
  totalContributions: number;
  repos: ContributorRepoStat[];
}

const isBot = (login: string, type: string) =>
  type === "Bot" || /\[bot\]$/i.test(login) || /-bot$/i.test(login);

/**
 * Agrega los contribuidores de todos los repos de `REPOS`, sumando commits por
 * usuario y guardando el desglose por repo. Excluye bots.
 */
export async function fetchContributors(repos: RepoRef[]): Promise<Contributor[]> {
  const byLogin = new Map<string, Contributor>();

  await Promise.all(
    repos.map(async ({ owner, repo, label }) => {
      try {
        const data = await octokit.paginate(octokit.repos.listContributors, {
          owner,
          repo,
          per_page: 100,
        });
        for (const c of data) {
          if (!c.login || isBot(c.login, c.type ?? "")) continue;
          let entry = byLogin.get(c.login);
          if (!entry) {
            entry = {
              login: c.login,
              avatarUrl: c.avatar_url ?? "",
              htmlUrl: c.html_url ?? "",
              totalContributions: 0,
              repos: [],
            };
            byLogin.set(c.login, entry);
          }
          entry.totalContributions += c.contributions ?? 0;
          entry.repos.push({ repo: label, contributions: c.contributions ?? 0 });
        }
      } catch {
        /* repo sin acceso o error puntual: se omite */
      }
    }),
  );

  return [...byLogin.values()]
    .map((c) => ({ ...c, repos: c.repos.sort((a, b) => b.contributions - a.contributions) }))
    .sort((a, b) => b.totalContributions - a.totalContributions);
}

// ---------------------------------------------------------------------------
// Actividad de commits (analítica ejecutiva)
// ---------------------------------------------------------------------------

/**
 * Un commit único (dedup por SHA dentro del repo, sin bots).
 * `inMain`/`inDev` indican en qué rama(s) es alcanzable. Un commit mergeado a
 * main aparece en ambas; la brecha dev−main = trabajo aún no integrado.
 */
export interface CommitRecord {
  sha: string;
  date: string; // YYYY-MM-DD
  login: string;
  repo: string; // label del repo
  inMain: boolean;
  inDev: boolean;
}

/** Un Pull Request creado dentro de la ventana. */
export interface PRRecord {
  date: string; // YYYY-MM-DD (created_at)
  login: string; // autor del PR
  repo: string; // label del repo
  merged: boolean;
}

export interface ContributorRef {
  login: string;
  avatarUrl: string;
}

export interface CommitActivity {
  commits: CommitRecord[]; // commits únicos de la ventana (sin bots)
  prs: PRRecord[]; // PRs creados en la ventana (sin bots)
  authors: ContributorRef[]; // contribuidores distintos, ordenados por actividad
  repos: string[]; // labels de repos con actividad (para el filtro)
  windowDays: number;
  since: string; // ISO
}

const dayKey = (iso: string) => iso.slice(0, 10); // YYYY-MM-DD

/**
 * Trae actividad de los últimos `windowDays` días por repo:
 * - Commits de `main` y de `dev` (dedup por SHA, flags inMain/inDev).
 * - PRs creados en la ventana.
 * Excluye bots. Tolera repos sin acceso o sin rama dev.
 */
export async function fetchCommitActivity(repos: RepoRef[], windowDays = 30): Promise<CommitActivity> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const sinceMs = new Date(since).getTime();

  const commits: CommitRecord[] = [];
  const prs: PRRecord[] = [];
  const avatarByLogin = new Map<string, string>();
  const totalByLogin = new Map<string, number>();
  const reposWithActivity = new Set<string>();

  const note = (login: string, avatar?: string | null) => {
    totalByLogin.set(login, (totalByLogin.get(login) ?? 0) + 1);
    if (avatar && !avatarByLogin.get(login)) avatarByLogin.set(login, avatar);
  };

  await Promise.all(
    repos.map(async ({ owner, repo, label }) => {
      // commits por rama (dedup por sha dentro del repo)
      const bySha = new Map<string, CommitRecord>();
      const fetchBranch = async (branch: "main" | "dev") => {
        try {
          const data = await octokit.paginate(octokit.repos.listCommits, {
            owner,
            repo,
            sha: branch,
            since,
            per_page: 100,
          });
          for (const c of data) {
            const dateIso = c.commit?.author?.date;
            if (!dateIso) continue;
            const login = c.author?.login ?? c.commit?.author?.name ?? "desconocido";
            if (isBot(login, c.author?.type ?? "")) continue;
            let rec = bySha.get(c.sha);
            if (!rec) {
              rec = { sha: c.sha, date: dayKey(dateIso), login, repo: label, inMain: false, inDev: false };
              bySha.set(c.sha, rec);
              note(login, c.author?.avatar_url);
            }
            if (branch === "main") rec.inMain = true;
            else rec.inDev = true;
          }
        } catch {
          /* rama inexistente o sin acceso: se omite */
        }
      };

      // PRs creados en la ventana (state=all, orden desc por creación; corta al salir de la ventana)
      const fetchPRs = async () => {
        try {
          await octokit.paginate(
            octokit.pulls.list,
            { owner, repo, state: "all", sort: "created", direction: "desc", per_page: 100 },
            (response, done) => {
              const inWindow = [];
              for (const pr of response.data) {
                if (new Date(pr.created_at).getTime() < sinceMs) {
                  done();
                  break;
                }
                inWindow.push(pr);
              }
              for (const pr of inWindow) {
                const login = pr.user?.login ?? "desconocido";
                if (isBot(login, pr.user?.type ?? "")) continue;
                prs.push({ date: dayKey(pr.created_at), login, repo: label, merged: !!pr.merged_at });
                reposWithActivity.add(label);
                note(login, pr.user?.avatar_url);
              }
              return [];
            },
          );
        } catch {
          /* repo sin acceso: se omite */
        }
      };

      await Promise.all([fetchBranch("main"), fetchBranch("dev"), fetchPRs()]);
      if (bySha.size > 0) reposWithActivity.add(label);
      commits.push(...bySha.values());
    }),
  );

  const authors: ContributorRef[] = [...totalByLogin.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([login]) => ({ login, avatarUrl: avatarByLogin.get(login) ?? "" }));

  const repoLabels = repos.map((r) => r.label).filter((l) => reposWithActivity.has(l));

  return { commits, prs, authors, repos: repoLabels, windowDays, since };
}

// --- Agregadores client-side (puros, reutilizables en UI y export) -----------

export interface DailyMetrics {
  date: string;
  dev: number; // commits alcanzables en dev
  main: number; // commits alcanzables en main
  prs: number; // PRs creados
}
export interface AuthorMetrics {
  login: string;
  dev: number;
  main: number;
  prs: number;
  total: number; // commits únicos (dev ∪ main)
  perDay: number; // total / días activos
}
export interface RepoMetrics {
  repo: string;
  dev: number;
  main: number;
  prs: number;
  total: number;
}

/** Serie diaria continua (zero-fill) con las tres métricas. */
export function buildDailySeries(
  commits: CommitRecord[],
  prs: PRRecord[],
  since: string,
  windowDays: number,
): DailyMetrics[] {
  const byDay = new Map<string, { dev: number; main: number; prs: number }>();
  const get = (d: string) => {
    let e = byDay.get(d);
    if (!e) {
      e = { dev: 0, main: 0, prs: 0 };
      byDay.set(d, e);
    }
    return e;
  };
  for (const c of commits) {
    const e = get(c.date);
    if (c.inDev) e.dev += 1;
    if (c.inMain) e.main += 1;
  }
  for (const p of prs) get(p.date).prs += 1;

  const startMs = new Date(since).getTime();
  const out: DailyMetrics[] = [];
  for (let i = 0; i < windowDays; i++) {
    const day = dayKey(new Date(startMs + i * 86_400_000).toISOString());
    const e = byDay.get(day);
    out.push({ date: day, dev: e?.dev ?? 0, main: e?.main ?? 0, prs: e?.prs ?? 0 });
  }
  return out;
}

export function aggregateByAuthor(commits: CommitRecord[], prs: PRRecord[]): AuthorMetrics[] {
  const m = new Map<string, { dev: number; main: number; prs: number; total: number; days: Set<string> }>();
  const get = (login: string) => {
    let e = m.get(login);
    if (!e) {
      e = { dev: 0, main: 0, prs: 0, total: 0, days: new Set() };
      m.set(login, e);
    }
    return e;
  };
  for (const c of commits) {
    const e = get(c.login);
    if (c.inDev) e.dev += 1;
    if (c.inMain) e.main += 1;
    e.total += 1;
    e.days.add(c.date);
  }
  for (const p of prs) get(p.login).prs += 1;
  return [...m.entries()]
    .map(([login, e]) => ({
      login,
      dev: e.dev,
      main: e.main,
      prs: e.prs,
      total: e.total,
      perDay: e.total / (e.days.size || 1),
    }))
    .sort((a, b) => b.total - a.total || b.prs - a.prs);
}

export function aggregateByRepo(commits: CommitRecord[], prs: PRRecord[]): RepoMetrics[] {
  const m = new Map<string, { dev: number; main: number; prs: number; total: number }>();
  const get = (repo: string) => {
    let e = m.get(repo);
    if (!e) {
      e = { dev: 0, main: 0, prs: 0, total: 0 };
      m.set(repo, e);
    }
    return e;
  };
  for (const c of commits) {
    const e = get(c.repo);
    if (c.inDev) e.dev += 1;
    if (c.inMain) e.main += 1;
    e.total += 1;
  }
  for (const p of prs) get(p.repo).prs += 1;
  return [...m.entries()]
    .map(([repo, e]) => ({ repo, ...e }))
    .sort((a, b) => b.total - a.total || b.prs - a.prs);
}
