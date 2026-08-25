import { execFileSync } from 'node:child_process';

import {
  externalReviewHold,
  externalReviewRequired,
  resolveExternalReviewPolicy,
  type ExternalReviewEvidence
} from './external-review';
import { createGhApiFetch, GitHubReviewClient, parseGitHubRemote } from './github-context';

// One bounded wait per invocation: the command must return before the
// missing-tool-output watchdog (running_wait_stall_threshold_ms, 300s by
// default) classifies the call as stalled, so the default budget stays well
// under it. The worker re-invokes until the status stops being 'pending'.
const DEFAULT_BUDGET_MS = 240_000;
const DEFAULT_POLL_INTERVAL_MS = 20_000;

export const WAIT_EXTERNAL_ENV = {
  budgetMs: 'SYMPHONY_WAIT_EXTERNAL_BUDGET_MS',
  pollIntervalMs: 'SYMPHONY_WAIT_EXTERNAL_POLL_INTERVAL_MS'
} as const;

export type WaitExternalStatus =
  | 'settled_answered'
  | 'settled_declined'
  | 'not_required'
  | 'pending'
  | 'stale_request'
  | 'head_mismatch';

export interface WaitExternalResult {
  status: WaitExternalStatus;
  head_sha: string;
  pr_head_sha: string | null;
  evidence: ExternalReviewEvidence | null;
  waited_ms: number;
  polls: number;
  hint: string;
}

export interface WaitExternalOptions {
  pr: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  budgetMs?: number;
  pollIntervalMs?: number;
  client?: GitHubReviewClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  resolveHead?: () => string;
  resolveRepository?: () => string | null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024
  }).trim();
}

function readPositiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export async function waitForExternalReview(options: WaitExternalOptions): Promise<WaitExternalResult> {
  const policy = resolveExternalReviewPolicy(options.env);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const budgetMs = options.budgetMs ?? readPositiveInteger(options.env[WAIT_EXTERNAL_ENV.budgetMs], DEFAULT_BUDGET_MS);
  const pollIntervalMs = options.pollIntervalMs
    ?? readPositiveInteger(options.env[WAIT_EXTERNAL_ENV.pollIntervalMs], DEFAULT_POLL_INTERVAL_MS);
  const headSha = (options.resolveHead ?? (() => git(options.cwd, ['rev-parse', 'HEAD'])))();

  if (!externalReviewRequired(policy)) {
    return {
      status: 'not_required',
      head_sha: headSha,
      pr_head_sha: null,
      evidence: null,
      waited_ms: 0,
      polls: 0,
      hint: 'No external reviewer is configured for this workflow; proceed to finalize.'
    };
  }

  const repository = (options.resolveRepository
    ?? (() => parseGitHubRemote(git(options.cwd, ['remote', 'get-url', 'origin']))))();
  if (!repository) throw new Error('review_wait_external_remote_invalid');
  const client = options.client ?? new GitHubReviewClient({
    token: options.env.GH_TOKEN ?? options.env.GITHUB_TOKEN,
    fetchFn: createGhApiFetch({ cwd: options.cwd, env: options.env }),
    externalReviewPolicy: policy
  });
  const reviewerLogin = options.env.SYMPHONY_REVIEWER_APP_LOGIN ?? 'symphony-reviewer[bot]';

  const startedAt = now();
  let polls = 0;
  for (;;) {
    const snapshot = await client.fetchSnapshot(repository, options.pr, reviewerLogin);
    polls += 1;
    const waitedMs = now() - startedAt;
    if (snapshot.head_sha !== headSha) {
      return {
        status: 'head_mismatch',
        head_sha: headSha,
        pr_head_sha: snapshot.head_sha,
        evidence: snapshot.external_review,
        waited_ms: waitedMs,
        polls,
        hint: 'The PR head no longer matches the local HEAD; sync the workspace before waiting again.'
      };
    }
    const hold = externalReviewHold(snapshot.external_review, policy);
    if (hold === null) {
      const answered = snapshot.external_review.answered_at !== null;
      return {
        status: answered ? 'settled_answered' : 'settled_declined',
        head_sha: headSha,
        pr_head_sha: snapshot.head_sha,
        evidence: snapshot.external_review,
        waited_ms: waitedMs,
        polls,
        hint: answered
          ? 'The external reviewer has answered for this head; read its feedback, then finalize.'
          : 'The external reviewer declined for this head; record the unavailability, then finalize.'
      };
    }
    if (hold === 'stale_request') {
      // Waiting cannot repair a request that predates the head it must vouch
      // for; only a fresh request can, so return immediately instead of
      // burning the budget on an outcome that is already decided.
      return {
        status: 'stale_request',
        head_sha: headSha,
        pr_head_sha: snapshot.head_sha,
        evidence: snapshot.external_review,
        waited_ms: waitedMs,
        polls,
        hint: 'The newest review request predates the current head; post a fresh request, then wait again.'
      };
    }
    const remainingMs = budgetMs - (now() - startedAt);
    if (remainingMs <= 0) {
      return {
        status: 'pending',
        head_sha: headSha,
        pr_head_sha: snapshot.head_sha,
        evidence: snapshot.external_review,
        waited_ms: now() - startedAt,
        polls,
        hint: 'The external reviewer has not answered yet; run this command again to keep waiting.'
      };
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

export function renderWaitExternalResult(result: WaitExternalResult): string {
  const evidence = result.evidence;
  return [
    `external_review_status=${result.status}`,
    `head_sha=${result.head_sha}`,
    `pr_head_sha=${result.pr_head_sha ?? 'n/a'}`,
    `requested_at=${evidence?.requested_at ?? 'n/a'}`,
    `answered_at=${evidence?.answered_at ?? 'n/a'}`,
    `unavailable_at=${evidence?.unavailable_at ?? 'n/a'}`,
    `waited_ms=${result.waited_ms}`,
    `polls=${result.polls}`,
    `hint=${result.hint}`
  ].join('\n');
}

export function parseWaitExternalArgs(argv: readonly string[]): { pr: number; budgetMs?: number; pollIntervalMs?: number } {
  if (argv[0] !== 'wait-external') throw new Error('review_wait_external_subcommand_required');
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`review_wait_external_missing_option:${flag}`);
    return value;
  };
  const pr = Number(read('--pr'));
  if (!Number.isInteger(pr) || pr < 1) throw new Error('review_wait_external_pr_invalid');
  const budgetSeconds = read('--budget-seconds');
  const pollSeconds = read('--poll-seconds');
  const toMs = (raw: string, flag: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`review_wait_external_option_invalid:${flag}`);
    return value * 1000;
  };
  return {
    pr,
    budgetMs: budgetSeconds === undefined ? undefined : toMs(budgetSeconds, '--budget-seconds'),
    pollIntervalMs: pollSeconds === undefined ? undefined : toMs(pollSeconds, '--poll-seconds')
  };
}
