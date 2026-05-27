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
      octokit.repos.listBranches({ owner, repo, per_page: 20 }),
      octokit.pulls.list({ owner, repo, state: "open", per_page: 20 }),
      octokit.actions.listWorkflowRunsForRepo({ owner, repo, per_page: 20 }),
    ]);

    // Ordenar antes de slicear: main y dev primero, así nunca quedan fuera por paginación
    const rawBranches = branchesResp.data;
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
        const reviewDecision = await getPRReviewDecision(owner, repo, pr.number, requestedReviewers);
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
