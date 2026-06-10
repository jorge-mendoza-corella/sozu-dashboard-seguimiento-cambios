import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: import.meta.env.VITE_GITHUB_TOKEN });

const reviewerOctokit = import.meta.env.VITE_GITHUB_REVIEWER_TOKEN
  ? new Octokit({ auth: import.meta.env.VITE_GITHUB_REVIEWER_TOKEN })
  : null;

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
  author: string;
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

async function getPRReviewDecision(
  owner: string,
  repo: string,
  pullNumber: number,
  requestedReviewers: string[],
): Promise<"APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null> {
  try {
    const { data: reviews } = await octokit.pulls.listReviews({ owner, repo, pull_number: pullNumber });
    const latestByUser = new Map<string, string>();
    for (const review of reviews) {
      if (review.state !== "COMMENTED" && review.user?.login) {
        latestByUser.set(review.user.login, review.state);
      }
    }
    const states = [...latestByUser.values()];
    if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
    if (states.includes("APPROVED")) return "APPROVED";
    if (requestedReviewers.length > 0) return "REVIEW_REQUIRED";
    return null;
  } catch {
    return requestedReviewers.length > 0 ? "REVIEW_REQUIRED" : null;
  }
}

async function getAheadBy(owner: string, repo: string, base: string, head: string): Promise<number> {
  try {
    const { data } = await octokit.repos.compareCommits({ owner, repo, base, head });
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

    const branches: BranchInfo[] = await Promise.all(
      sortedRaw.slice(0, 10).map(async (b) => {
        const [aheadMain, aheadDev] = await Promise.all([
          b.name !== "main" ? getAheadBy(owner, repo, "main", b.name) : Promise.resolve(0),
          b.name !== "dev" && b.name !== "main" ? getAheadBy(owner, repo, "dev", b.name) : Promise.resolve(0),
        ]);
        const commit = b.commit;
        return {
          name: b.name,
          lastCommitSha: commit.sha.slice(0, 7),
          lastCommitMessage: "",
          lastCommitAuthor: "",
          lastCommitDate: "",
          aheadOfMain: aheadMain,
          aheadOfDev: aheadDev,
        };
      })
    );

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
      }));

    return { owner, repo, label, branches, openPRs, latestRuns };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Error desconocido";
    return { owner, repo, label, branches: [], openPRs: [], latestRuns: [], error: msg };
  }
}

/** Cierra un PR sin hacer merge. */
export async function closePR(owner: string, repo: string, pullNumber: number): Promise<void> {
  await octokit.pulls.update({ owner, repo, pull_number: pullNumber, state: "closed" });
}

export async function mergePR(
  owner: string,
  repo: string,
  pullNumber: number,
  mergeMethod: "merge" | "squash" | "rebase" = "merge",
): Promise<void> {
  await octokit.pulls.merge({
    owner,
    repo,
    pull_number: pullNumber,
    merge_method: mergeMethod,
  });
}

// Para ramas no-producción: aprueba y hace merge (bypass de branch protection).
// prAuthor determina qué token aprueba: siempre el token distinto al autor del PR.
export async function mergeWithBypass(
  owner: string,
  repo: string,
  pullNumber: number,
  prAuthor: string,
): Promise<void> {
  if (!reviewerOctokit) {
    throw new Error("Token de revisor no configurado. Agrega VITE_GITHUB_REVIEWER_TOKEN al .env");
  }

  // Saber el login del reviewer para no aprobar su propio PR
  const { data: reviewerUser } = await reviewerOctokit.users.getAuthenticated();
  const approverOctokit = prAuthor === reviewerUser.login ? octokit : reviewerOctokit;

  await approverOctokit.pulls.createReview({
    owner, repo, pull_number: pullNumber, event: "APPROVE", body: "",
  });

  await octokit.pulls.merge({
    owner, repo, pull_number: pullNumber, merge_method: "merge",
  });
}

export async function createPR(
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body: string = "",
): Promise<{ number: number; url: string }> {
  const { data } = await octokit.pulls.create({ owner, repo, title, head, base, body });

  if (reviewerOctokit) {
    try {
      const { data: reviewerUser } = await reviewerOctokit.users.getAuthenticated();
      await octokit.pulls.requestReviewers({
        owner,
        repo,
        pull_number: data.number,
        reviewers: [reviewerUser.login],
      });
    } catch {
      // Si falla asignar reviewer no bloqueamos la creación del PR
    }
  }

  return { number: data.number, url: data.html_url };
}

export async function submitReview(
  owner: string,
  repo: string,
  pullNumber: number,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  body: string = "",
): Promise<void> {
  if (!reviewerOctokit) {
    throw new Error("Token de revisor no configurado. Agrega VITE_GITHUB_REVIEWER_TOKEN al .env");
  }
  await reviewerOctokit.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    event,
    body,
  });
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
