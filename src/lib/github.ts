import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: import.meta.env.VITE_GITHUB_TOKEN });

const reviewerOctokit = import.meta.env.VITE_GITHUB_REVIEWER_TOKEN
  ? new Octokit({ auth: import.meta.env.VITE_GITHUB_REVIEWER_TOKEN })
  : null;

export const REPOS = [
  { owner: "jorgeIMendoza", repo: "sozu-admin", label: "sozu-admin" },
  { owner: "jorgeIMendoza", repo: "sozu-supabase-migrations", label: "sozu-supabase-migrations" },
  { owner: "jorgeIMendoza", repo: "sozu-edge-functions", label: "sozu-edge-functions" },
  { owner: "jorgeIMendoza", repo: "sozu-n8n-workflows", label: "sozu-n8n-workflows" },
  { owner: "sozu-com", repo: "server-stp", label: "server-stp" },
] as const;

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
export async function fetchContributors(): Promise<Contributor[]> {
  const byLogin = new Map<string, Contributor>();

  await Promise.all(
    REPOS.map(async ({ owner, repo, label }) => {
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
