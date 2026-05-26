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
  requestedReviewers: string[];
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

    const openPRs: PullRequest[] = prsResp.data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      head: pr.head.ref,
      base: pr.base.ref,
      url: pr.html_url,
      createdAt: pr.created_at,
      draft: pr.draft ?? false,
      checksState: "unknown" as const,
      requestedReviewers: pr.requested_reviewers?.map((r) => r.login) ?? [],
    }));

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
