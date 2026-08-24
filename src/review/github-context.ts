import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

import { REASON_CODES } from '../observability/reason-codes';

export interface GitHubPullRequestSnapshot {
  repository: string;
  number: number;
  base_ref: string;
  base_sha: string;
  head_sha: string;
  title: string;
  body: string;
  draft: boolean;
  state: string;
  checks_green: boolean;
  checks_settled: boolean;
  review_decision: string | null;
  semantic_context: Record<string, unknown>;
  context_sha256: string;
}

interface GitHubClientOptions {
  token?: string;
  fetchFn?: typeof fetch;
  apiBase?: string;
}

interface GhApiFetchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  execute?: (args: string[], input?: string) => string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('review_approval_github_invalid_payload');
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function userLogin(value: unknown): string {
  const user = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return stringValue(user.login).toLowerCase();
}

function stableById<T extends Record<string, unknown>>(items: T[]): T[] {
  return [...items].sort((left, right) => String(left.id ?? '').localeCompare(String(right.id ?? '')));
}

function normaliseReviewerLogin(value: string): string {
  return value.trim().toLowerCase().replace(/\[bot\]$/, '');
}

function transientGitHubStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function retryDelay(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, attempt * 200));
}

export function resolveGitHubToken(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (direct) return direct;
  try {
    return execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      maxBuffer: 64 * 1024
    }).trim();
  } catch {
    throw new Error('review_approval_github_auth_unavailable');
  }
}

export function createGhApiFetch(options: GhApiFetchOptions): typeof fetch {
  const execute = options.execute ?? ((args: string[], input?: string) => execFileSync('gh', args, {
    cwd: options.cwd,
    env: options.env,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  }));
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.username || url.password) {
      throw new Error('review_approval_github_cli_host_invalid');
    }
    const endpoint = `${url.pathname}${url.search}`;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : undefined;
    const args = endpoint === '/graphql'
      ? ['api', 'graphql', '--input', '-']
      : ['api', '--method', method, endpoint, ...(body ? ['--input', '-'] : [])];
    try {
      const output = execute(args, body);
      return new Response(output || 'null', { status: 200, headers: { 'content-type': 'application/json' } });
    } catch {
      throw new Error('review_approval_github_cli_failed');
    }
  }) as typeof fetch;
}

export class GitHubReviewClient {
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiBase: string;

  constructor(options: GitHubClientOptions = {}) {
    this.token = options.token ?? resolveGitHubToken();
    this.fetchFn = options.fetchFn ?? fetch;
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  }

  async request(pathname: string, init: RequestInit = {}): Promise<unknown> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await this.fetchFn(`${this.apiBase}${pathname}`, {
          ...init,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${this.token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'symphony-review-approval',
            ...(init.headers ?? {})
          }
        });
        if (response.ok) {
          if (response.status === 204) return null;
          return response.json();
        }
        if (!transientGitHubStatus(response.status) || attempt === 3) {
          throw new Error(`review_approval_github_status:${response.status}`);
        }
      } catch (error) {
        if (attempt === 3 || (error instanceof Error && error.message.startsWith('review_approval_github_status:'))) throw error;
      }
      await retryDelay(attempt);
    }
    throw new Error(REASON_CODES.reviewApprovalGithubFailed);
  }

  async graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload = asRecord(await this.request('/graphql', {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      headers: { 'Content-Type': 'application/json' }
    }));
    if (Array.isArray(payload.errors) && payload.errors.length > 0) throw new Error('review_approval_github_graphql_error');
    return asRecord(payload.data);
  }

  private async paginatedArray(pathname: string): Promise<Record<string, unknown>[]> {
    const output: Record<string, unknown>[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const separator = pathname.includes('?') ? '&' : '?';
      const raw = await this.request(`${pathname}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(raw)) throw new Error('review_approval_github_invalid_payload');
      const batch = raw.map(asRecord);
      output.push(...batch);
      if (batch.length < 100) return output;
    }
    throw new Error('review_approval_feedback_incomplete');
  }

  async fetchReviews(repository: string, prNumber: number): Promise<Record<string, unknown>[]> {
    const [owner, repo] = repository.split('/');
    if (!owner || !repo || repository.split('/').length !== 2) throw new Error('review_approval_repository_invalid');
    return this.paginatedArray(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews`
    );
  }

  private async fetchCheckRuns(encodedRepo: string, headSha: string): Promise<Record<string, unknown>[]> {
    const output: Record<string, unknown>[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const payload = asRecord(await this.request(
        `${encodedRepo}/commits/${headSha}/check-runs?per_page=100&page=${page}`
      ));
      const batch = Array.isArray(payload.check_runs) ? payload.check_runs.map(asRecord) : [];
      output.push(...batch);
      const total = numberValue(payload.total_count);
      if (batch.length < 100) {
        if (total !== null && output.length !== total) throw new Error('review_approval_checks_incomplete');
        return output;
      }
    }
    throw new Error('review_approval_checks_incomplete');
  }

  async fetchSnapshot(repository: string, prNumber: number, reviewerLogin: string): Promise<GitHubPullRequestSnapshot> {
    const [owner, repo] = repository.split('/');
    if (!owner || !repo || repository.split('/').length !== 2) throw new Error('review_approval_repository_invalid');
    const encodedRepo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const prRaw = await this.request(`${encodedRepo}/pulls/${prNumber}`);
    const pr = asRecord(prRaw);
    const head = asRecord(pr.head);
    const base = asRecord(pr.base);
    const headSha = stringValue(head.sha);
    if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error('review_approval_head_missing');
    const [reviews, comments, inline, files, checks, statusRaw, threadDataRaw] = await Promise.all([
      this.fetchReviews(repository, prNumber),
      this.paginatedArray(`${encodedRepo}/issues/${prNumber}/comments`),
      this.paginatedArray(`${encodedRepo}/pulls/${prNumber}/comments`),
      this.paginatedArray(`${encodedRepo}/pulls/${prNumber}/files`),
      this.fetchCheckRuns(encodedRepo, headSha),
      this.request(`${encodedRepo}/commits/${headSha}/status?per_page=100`),
      this.graphql(
        `query ReviewContext($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewDecision
              reviewThreads(first: 100) { nodes { id isResolved } pageInfo { hasNextPage } }
            }
          }
        }`,
        { owner, repo, number: prNumber }
      )
    ]);
    const changedFiles = typeof pr.changed_files === 'number' ? pr.changed_files : null;
    if (changedFiles === null || files.length !== changedFiles) throw new Error('review_approval_diff_incomplete');
    const statusPayload = asRecord(statusRaw);
    const statuses = Array.isArray(statusPayload.statuses) ? statusPayload.statuses.map(asRecord) : [];
    const statusTotal = numberValue(statusPayload.total_count);
    if (statusTotal !== null && statuses.length !== statusTotal) throw new Error('review_approval_checks_incomplete');
    const semanticChecks = [
      ...checks.map((check) => ({
        name: stringValue(check.name),
        status: stringValue(check.status),
        conclusion: stringValue(check.conclusion)
      })),
      ...statuses.map((status) => ({
        name: stringValue(status.context),
        status: 'completed',
        conclusion: stringValue(status.state)
      }))
    ].sort((left, right) =>
      left.name.localeCompare(right.name)
      || left.status.localeCompare(right.status)
      || left.conclusion.localeCompare(right.conclusion)
    );
    const checksSettled = semanticChecks.length > 0 && semanticChecks.every((check) => check.status === 'completed');
    const checksGreen = checksSettled && semanticChecks.every((check) =>
      ['success', 'neutral', 'skipped'].includes(check.conclusion)
    );

    const reviewer = normaliseReviewerLogin(reviewerLogin);
    const threadData = threadDataRaw as Record<string, unknown>;
    const repositoryNode = threadData.repository && typeof threadData.repository === 'object'
      ? threadData.repository as Record<string, unknown>
      : {};
    const pullRequestNode = repositoryNode.pullRequest && typeof repositoryNode.pullRequest === 'object'
      ? repositoryNode.pullRequest as Record<string, unknown>
      : {};
    const threadConnection = pullRequestNode.reviewThreads && typeof pullRequestNode.reviewThreads === 'object'
      ? pullRequestNode.reviewThreads as Record<string, unknown>
      : {};
    const pageInfo = threadConnection.pageInfo && typeof threadConnection.pageInfo === 'object'
      ? threadConnection.pageInfo as Record<string, unknown>
      : {};
    if (pageInfo.hasNextPage === true) throw new Error('review_approval_feedback_incomplete');
    const threads = Array.isArray(threadConnection.nodes) ? threadConnection.nodes.map(asRecord) : [];

    const semanticContext = {
      repository,
      pr_number: prNumber,
      base: { ref: stringValue(base.ref), sha: stringValue(base.sha) },
      head: { sha: headSha },
      title: stringValue(pr.title),
      body: stringValue(pr.body),
      draft: pr.draft === true,
      checks: semanticChecks,
      reviews: stableById(reviews
        .filter((review) => normaliseReviewerLogin(userLogin(review.user)) !== reviewer)
        .map((review) => ({
          id: numberValue(review.id),
          user: userLogin(review.user),
          state: stringValue(review.state),
          body: stringValue(review.body),
          commit_id: stringValue(review.commit_id)
        }))),
      comments: stableById(comments.map((comment) => ({
        id: numberValue(comment.id), user: userLogin(comment.user), body: stringValue(comment.body)
      }))),
      inline_comments: stableById(inline.map((comment) => ({
        id: numberValue(comment.id), user: userLogin(comment.user), body: stringValue(comment.body),
        path: stringValue(comment.path), line: numberValue(comment.line), side: stringValue(comment.side)
      }))),
      review_threads: stableById(threads.map((thread) => ({ id: stringValue(thread.id), resolved: thread.isResolved === true })))
    };
    const reviewDecision = typeof pullRequestNode.reviewDecision === 'string' ? pullRequestNode.reviewDecision : null;
    return {
      repository,
      number: prNumber,
      base_ref: stringValue(base.ref),
      base_sha: stringValue(base.sha),
      head_sha: headSha,
      title: stringValue(pr.title),
      body: stringValue(pr.body),
      draft: pr.draft === true,
      state: stringValue(pr.state),
      checks_green: checksGreen,
      checks_settled: checksSettled,
      review_decision: reviewDecision,
      semantic_context: semanticContext,
      context_sha256: crypto.createHash('sha256').update(canonicalJson(semanticContext)).digest('hex')
    };
  }
}

export function parseGitHubRemote(remote: string): string | null {
  const trimmed = remote.trim();
  const https = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  return ssh ? `${ssh[1]}/${ssh[2]}` : null;
}
