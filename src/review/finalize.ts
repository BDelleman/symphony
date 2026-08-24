import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { encodeReviewOutcome, normalizeReviewMarkdown, receiptSha256, reviewSha256 } from './contract';
import { createGhApiFetch, GitHubReviewClient, parseGitHubRemote } from './github-context';
import type { AgentReviewOutcome, ReviewReceiptV2, ReviewRoute, ReviewVerdict } from './types';

interface FinalizeOptions {
  issue: string;
  pr: number;
  route: ReviewRoute;
  bodyFile: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
  client?: GitHubReviewClient;
}

export interface FinalizeResult {
  finalPath: string;
  receiptPath: string;
  envelope: string;
  receipt: ReviewReceiptV2;
  outcome: AgentReviewOutcome;
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

function verdictForRoute(route: ReviewRoute): ReviewVerdict {
  if (route === 'merging' || route === 'human_review') return 'pass';
  if (route === 'in_progress') return 'blocked';
  return 'reset';
}

// Green checks gate the App approval, which only passing routes ever submit. The send-back
// routes exist precisely for red CI, so they require a settled check set instead: the review
// must still describe a decided PR, but a failing one no longer traps the issue in the gate.
export function checksRequirementForRoute(route: ReviewRoute): 'green' | 'settled' {
  return verdictForRoute(route) === 'pass' ? 'green' : 'settled';
}

function assertChecksSatisfyRoute(
  route: ReviewRoute,
  snapshot: { checks_green: boolean; checks_settled: boolean }
): void {
  if (checksRequirementForRoute(route) === 'green') {
    if (!snapshot.checks_green) throw new Error('review_finalize_checks_not_green');
    return;
  }
  if (!snapshot.checks_settled) throw new Error('review_finalize_checks_unsettled');
}

function assertReviewBody(body: string): void {
  if (!body.trim()) throw new Error('review_finalize_body_empty');
  if (body.includes('### Review Receipt')) throw new Error('review_finalize_body_contains_receipt');
  for (const heading of [
    '### Scope Read',
    '### Independent Invariants',
    '### Acceptance Criteria Mapping',
    '### Triggered Review Lenses',
    '### Findings'
  ]) {
    if (!body.includes(heading)) throw new Error(`review_finalize_section_missing:${heading.slice(4).toLowerCase().replaceAll(' ', '_')}`);
  }
  if (body.includes('<!--')) throw new Error('review_finalize_placeholder_remaining');
}

export async function finalizeAgentReview(options: FinalizeOptions): Promise<FinalizeResult> {
  const attemptId = options.env.SYMPHONY_ATTEMPT_ID?.trim();
  if (!attemptId) throw new Error('review_finalize_attempt_id_missing');
  const root = fs.realpathSync(git(options.cwd, ['rev-parse', '--show-toplevel']));
  const status = git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (status) throw new Error('review_finalize_workspace_dirty');
  const headSha = git(root, ['rev-parse', 'HEAD']);
  const remote = git(root, ['remote', 'get-url', 'origin']);
  const repository = parseGitHubRemote(remote);
  if (!repository) throw new Error('review_finalize_remote_invalid');
  const bodyPath = fs.realpathSync(path.resolve(options.cwd, options.bodyFile));
  const rawGitDirectory = git(root, ['rev-parse', '--git-dir']);
  const gitDirectory = fs.realpathSync(path.isAbsolute(rawGitDirectory) ? rawGitDirectory : path.resolve(root, rawGitDirectory));
  const relativeBody = path.relative(gitDirectory, bodyPath);
  if (relativeBody.startsWith('..') || path.isAbsolute(relativeBody)) throw new Error('review_finalize_body_outside_private_capsule');
  const reviewBody = normalizeReviewMarkdown(fs.readFileSync(bodyPath, 'utf8'));
  assertReviewBody(reviewBody);

  const client = options.client ?? new GitHubReviewClient({
    token: options.env.GH_TOKEN ?? options.env.GITHUB_TOKEN,
    fetchFn: createGhApiFetch({ cwd: root, env: options.env })
  });
  const reviewerLogin = options.env.SYMPHONY_REVIEWER_APP_LOGIN ?? 'symphony-reviewer[bot]';
  const snapshot = await client.fetchSnapshot(repository, options.pr, reviewerLogin);
  if (snapshot.state !== 'open' || snapshot.draft) throw new Error('review_finalize_pr_not_ready');
  // A PR opened against the wrong base branch fails the approval gate at the
  // very end of the pipeline; when the orchestrator exports the workflow's
  // base ref, refuse to finalize against it so the review turn surfaces the
  // misconfigured PR immediately with an actionable error.
  const expectedBaseRef = options.env.SYMPHONY_BASE_REF?.trim().replace(/^origin\//, '');
  if (expectedBaseRef && snapshot.base_ref !== expectedBaseRef) {
    throw new Error(`review_finalize_pr_base_mismatch:pr=${snapshot.base_ref},workflow=${expectedBaseRef}`);
  }
  if (snapshot.head_sha !== headSha) throw new Error('review_finalize_head_mismatch');
  assertChecksSatisfyRoute(options.route, snapshot);

  const artifactHash = reviewSha256(reviewBody);
  const receipt: ReviewReceiptV2 = {
    version: 2,
    issue_id: options.issue,
    issue_version: null,
    repository,
    pr_number: options.pr,
    base_ref: snapshot.base_ref,
    base_sha: snapshot.base_sha,
    head_sha: snapshot.head_sha,
    verdict: verdictForRoute(options.route),
    route: options.route,
    symphony_attempt_id: attemptId,
    review_artifact_sha256: artifactHash,
    github_context_sha256: snapshot.context_sha256,
    created_at: (options.now ?? (() => new Date()))().toISOString()
  };
  const outcome: AgentReviewOutcome = {
    version: 1,
    issue_id: options.issue,
    pr_number: options.pr,
    base_sha: snapshot.base_sha,
    head_sha: snapshot.head_sha,
    verdict: receipt.verdict,
    route: receipt.route,
    symphony_attempt_id: attemptId,
    review_receipt_sha256: receiptSha256(receipt),
    review_artifact_sha256: artifactHash
  };
  const capsule = path.join(gitDirectory, 'symphony-review', snapshot.head_sha);
  fs.mkdirSync(capsule, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(capsule, 'receipt-v2.json');
  const finalPath = path.join(capsule, 'final.md');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(finalPath, `${reviewBody}\n### Review Receipt\n${JSON.stringify(receipt)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return { finalPath, receiptPath, envelope: encodeReviewOutcome(outcome), receipt, outcome };
}

export function parseFinalizeArgs(argv: readonly string[]): Omit<FinalizeOptions, 'cwd' | 'env'> {
  const read = (flag: string): string => {
    const index = argv.indexOf(flag);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (!value || value.startsWith('--')) throw new Error(`review_finalize_missing_option:${flag}`);
    return value;
  };
  if (argv[0] !== 'finalize') throw new Error('review_finalize_subcommand_required');
  const pr = Number(read('--pr'));
  if (!Number.isInteger(pr) || pr < 1) throw new Error('review_finalize_pr_invalid');
  const route = read('--route') as ReviewRoute;
  if (!['merging', 'human_review', 'in_progress', 'rework'].includes(route)) {
    throw new Error('review_finalize_route_invalid');
  }
  return { issue: read('--issue'), pr, route, bodyFile: read('--body-file') };
}

export async function runReviewCommand(argv: readonly string[], deps: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    deps.stdout('Usage: symphony review finalize --issue <identifier> --pr <number> --route <route> --body-file <path>\n');
    return 0;
  }
  try {
    const parsed = parseFinalizeArgs(argv);
    const result = await finalizeAgentReview({ ...parsed, cwd: deps.cwd, env: deps.env });
    deps.stdout(`review_artifact=${result.finalPath}\nreview_receipt=${result.receiptPath}\n${result.envelope}\n`);
    return 0;
  } catch (error) {
    deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
