// Anthropic Admin API — usage cost tracking
// Admin key (sk-ant-admin...) en VITE_ANTHROPIC_ADMIN_KEY
// Verify pricing at: https://www.anthropic.com/pricing

const BASE = "https://api.anthropic.com/v1";

function adminHeaders(): Record<string, string> {
  return {
    "anthropic-version": "2023-06-01",
    "x-api-key": import.meta.env.VITE_ANTHROPIC_ADMIN_KEY ?? "",
  };
}

export function hasAdminKey(): boolean {
  return !!import.meta.env.VITE_ANTHROPIC_ADMIN_KEY;
}

// ---- API types -----------------------------------------------------------

export interface AnthropicOrgUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface RawCacheCreation {
  ephemeral_1h_input_tokens?: number;
  ephemeral_5m_input_tokens?: number;
}

export interface RawUsageResult {
  account_id: string | null;
  model: string;
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: RawCacheCreation | null;
  output_tokens: number;
}

export interface RawUsageBucket {
  starting_at: string;
  ending_at: string;
  results: RawUsageResult[];
}

// ---- Processed types -----------------------------------------------------

export interface ModelCost {
  model: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface ContributorCostEntry {
  githubLogin: string;
  accountId: string | null;
  email: string;
  totalUsd: number;
  byModel: ModelCost[];
}

export interface DailyCostEntry {
  date: string; // YYYY-MM-DD
  totalUsd: number;
  byModel: Record<string, number>;
}

export interface CostsData {
  windowDays: number;
  totalUsd: number;
  byContributor: ContributorCostEntry[];
  unmapped: ContributorCostEntry[];
  byModel: ModelCost[];
  daily: DailyCostEntry[];
}

// ---- Pricing table (USD per token) ---------------------------------------

interface Pricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

// Prefix-matched: longest match wins. Prices as of 2025.
const PRICING_TABLE: [string, Pricing][] = [
  ["claude-opus-4",    { input: 15/1e6,   output: 75/1e6,   cacheRead: 1.5/1e6,   cacheCreate: 18.75/1e6 }],
  ["claude-sonnet-4",  { input: 3/1e6,    output: 15/1e6,   cacheRead: 0.3/1e6,   cacheCreate: 3.75/1e6  }],
  ["claude-haiku-4",   { input: 0.8/1e6,  output: 4/1e6,    cacheRead: 0.08/1e6,  cacheCreate: 1/1e6     }],
  ["claude-opus-3-5",  { input: 3/1e6,    output: 15/1e6,   cacheRead: 0.3/1e6,   cacheCreate: 3.75/1e6  }],
  ["claude-sonnet-3-5",{ input: 3/1e6,    output: 15/1e6,   cacheRead: 0.3/1e6,   cacheCreate: 3.75/1e6  }],
  ["claude-haiku-3-5", { input: 0.8/1e6,  output: 4/1e6,    cacheRead: 0.08/1e6,  cacheCreate: 1/1e6     }],
  ["claude-opus-3",    { input: 15/1e6,   output: 75/1e6,   cacheRead: 1.5/1e6,   cacheCreate: 18.75/1e6 }],
  ["claude-sonnet-3",  { input: 3/1e6,    output: 15/1e6,   cacheRead: 0.3/1e6,   cacheCreate: 3.75/1e6  }],
  ["claude-haiku-3",   { input: 0.25/1e6, output: 1.25/1e6, cacheRead: 0.03/1e6,  cacheCreate: 0.3/1e6   }],
];

function getModelPricing(model: string): Pricing {
  const lower = model.toLowerCase();
  for (const [key, price] of PRICING_TABLE) {
    if (lower.includes(key)) return price;
  }
  return PRICING_TABLE[1][1]; // fallback: Sonnet 4
}

function computeResultCost(r: RawUsageResult): number {
  const p = getModelPricing(r.model);
  const cacheCreateTokens =
    (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
    (r.cache_creation?.ephemeral_5m_input_tokens ?? 0);
  return (
    r.uncached_input_tokens * p.input +
    r.cache_read_input_tokens * p.cacheRead +
    cacheCreateTokens * p.cacheCreate +
    r.output_tokens * p.output
  );
}

// ---- API fetch helpers ---------------------------------------------------

async function anthropicFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: adminHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return res.json() as Promise<T>;
}

interface Paginated<T> {
  data: T[];
  has_more: boolean;
  next_page?: string;
}

async function fetchAllPages<T>(buildPath: (page?: string) => string): Promise<T[]> {
  const all: T[] = [];
  let page: string | undefined;
  while (true) {
    const json = await anthropicFetch<Paginated<T>>(buildPath(page));
    all.push(...json.data);
    if (!json.has_more || !json.next_page) break;
    page = json.next_page;
  }
  return all;
}

export async function fetchOrgUsers(): Promise<AnthropicOrgUser[]> {
  return fetchAllPages<AnthropicOrgUser>((page) => {
    const q = new URLSearchParams({ limit: "100" });
    if (page) q.set("page", page);
    return `/organizations/users?${q}`;
  });
}

export async function fetchUsageBuckets(windowDays: number): Promise<RawUsageBucket[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const startingAt = since.toISOString().slice(0, 10) + "T00:00:00Z";
  return fetchAllPages<RawUsageBucket>((page) => {
    const q = new URLSearchParams({
      starting_at: startingAt,
      bucket_width: "1d",
      limit: String(Math.min(windowDays + 2, 100)),
    });
    q.append("group_by[]", "account_id");
    q.append("group_by[]", "model");
    if (page) q.set("page", page);
    return `/organizations/usage_report/messages?${q}`;
  });
}

// ---- Processing ----------------------------------------------------------

export interface Mapping {
  accountId: string;
  githubLogin: string;
  email?: string;
}

function mergeModelCost(dest: Map<string, ModelCost>, r: RawUsageResult): void {
  const usd = computeResultCost(r);
  const cacheCreate =
    (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
    (r.cache_creation?.ephemeral_5m_input_tokens ?? 0);
  const existing = dest.get(r.model);
  if (existing) {
    existing.usd += usd;
    existing.inputTokens += r.uncached_input_tokens;
    existing.outputTokens += r.output_tokens;
    existing.cacheReadTokens += r.cache_read_input_tokens;
    existing.cacheCreateTokens += cacheCreate;
  } else {
    dest.set(r.model, {
      model: r.model,
      usd,
      inputTokens: r.uncached_input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_input_tokens,
      cacheCreateTokens: cacheCreate,
    });
  }
}

export function processCosts(
  buckets: RawUsageBucket[],
  orgUsers: AnthropicOrgUser[],
  mappings: Mapping[],
  windowDays: number,
): CostsData {
  const orgEmailMap = new Map(orgUsers.map((u) => [u.id, u.email]));
  const loginMap = new Map(mappings.map((m) => [m.accountId, m.githubLogin]));
  const mappingEmailMap = new Map(
    mappings.map((m) => [m.accountId, m.email ?? orgEmailMap.get(m.accountId) ?? ""]),
  );

  const byAccount = new Map<string, Map<string, ModelCost>>();
  const aggByModel = new Map<string, ModelCost>();
  const dailyMap = new Map<string, DailyCostEntry>();

  for (const bucket of buckets) {
    const dateStr = bucket.starting_at.slice(0, 10);
    if (!dailyMap.has(dateStr)) {
      dailyMap.set(dateStr, { date: dateStr, totalUsd: 0, byModel: {} });
    }
    const day = dailyMap.get(dateStr)!;

    for (const r of bucket.results) {
      const accountKey = r.account_id ?? "__workbench__";

      if (!byAccount.has(accountKey)) byAccount.set(accountKey, new Map());
      mergeModelCost(byAccount.get(accountKey)!, r);
      mergeModelCost(aggByModel, r);

      const usd = computeResultCost(r);
      day.totalUsd += usd;
      day.byModel[r.model] = (day.byModel[r.model] ?? 0) + usd;
    }
  }

  const mapped: ContributorCostEntry[] = [];
  const unmapped: ContributorCostEntry[] = [];
  let totalUsd = 0;

  for (const [accountId, modelMap] of byAccount) {
    const byModel = Array.from(modelMap.values()).sort((a, b) => b.usd - a.usd);
    const entryUsd = byModel.reduce((s, m) => s + m.usd, 0);
    totalUsd += entryUsd;

    const githubLogin = loginMap.get(accountId);
    const email =
      mappingEmailMap.get(accountId) ??
      orgEmailMap.get(accountId) ??
      "";

    const entry: ContributorCostEntry = {
      githubLogin: githubLogin ?? accountId,
      accountId,
      email,
      totalUsd: entryUsd,
      byModel,
    };

    (githubLogin ? mapped : unmapped).push(entry);
  }

  mapped.sort((a, b) => b.totalUsd - a.totalUsd);
  unmapped.sort((a, b) => b.totalUsd - a.totalUsd);

  return {
    windowDays,
    totalUsd,
    byContributor: mapped,
    unmapped,
    byModel: Array.from(aggByModel.values()).sort((a, b) => b.usd - a.usd),
    daily: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
