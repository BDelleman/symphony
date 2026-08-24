import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  encodeReviewOutcome,
  extractReviewArtifact,
  extractReviewReceipt,
  finalizeAgentReview,
  normalizeReviewMarkdown,
  parseReviewOutcome,
  receiptSha256,
  reviewSha256,
  ReviewApprovalCoordinator,
  stripReviewerCredentials,
  type AgentReviewOutcome,
  type ExternalReviewEvidence,
  type GitHubPullRequestSnapshot,
  type ReviewReceiptV2
} from '../../src/review';
import { createGhApiFetch } from '../../src/review/github-context';
import type { Issue, TrackerAdapter } from '../../src/tracker';

const dirs: string[] = [];

// No reviewer bot is configured in these fixtures, so the external-review
// requirement is inert and every snapshot reads as a finished conversation.
function settledExternalReview(): ExternalReviewEvidence {
  return { requested_at: null, answered_at: null, unavailable_at: null };
}
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

describe('worker GitHub transport', () => {
  it('routes reads through gh api without exposing tokens in argv', async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const fetchFn = createGhApiFetch({
      cwd: '/tmp',
      env: { GH_TOKEN: 'secret' },
      execute: (args, input) => {
        calls.push({ args, input });
        return JSON.stringify({ data: { repository: {} } });
      }
    });

    await expect((await fetchFn('https://api.github.com/repos/acme/repo/pulls/1')).json()).resolves.toEqual({
      data: { repository: {} }
    });
    await fetchFn('https://api.github.com/graphql', {
      method: 'POST',
      body: JSON.stringify({ query: 'query Test { viewer { login } }', variables: {} })
    });

    expect(calls[0]).toEqual({ args: ['api', '--method', 'GET', '/repos/acme/repo/pulls/1'], input: undefined });
    expect(calls[1]?.args).toEqual(['api', 'graphql', '--input', '-']);
    expect(calls.flatMap((call) => call.args)).not.toContain('secret');
    await expect(fetchFn('http://api.github.com/repos/acme/repo')).rejects.toThrow(
      'review_approval_github_cli_host_invalid'
    );
  });
});

function outcome(overrides: Partial<AgentReviewOutcome> = {}): AgentReviewOutcome {
  return {
    version: 1,
    issue_id: 'NIE-574',
    pr_number: 574,
    base_sha: baseSha,
    head_sha: headSha,
    verdict: 'pass',
    route: 'merging',
    symphony_attempt_id: 'attempt-1',
    review_receipt_sha256: 'c'.repeat(64),
    review_artifact_sha256: 'd'.repeat(64),
    ...overrides
  };
}

function reviewBody(): string {
  return normalizeReviewMarkdown(`### Scope Read
Issue and exact head read.

### Independent Invariants
Approval identity is separated.

### Acceptance Criteria Mapping
All criteria pass.

### Triggered Review Lenses
Review lifecycle.

### Findings
None.
`);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('review approval contract', () => {
  it('round-trips one exact terminal envelope and rejects conflicting content', () => {
    const encoded = encodeReviewOutcome(outcome());
    expect(parseReviewOutcome(encoded)).toEqual(outcome());
    expect(parseReviewOutcome('ordinary long response '.repeat(1000))).toBeNull();
    expect(() => parseReviewOutcome(`${encoded}\ntrailing`)).toThrow('review_approval_outcome_malformed');
    expect(() => parseReviewOutcome(`${encoded}\n${encoded}`)).toThrow('review_approval_outcome_malformed');
    expect(() => parseReviewOutcome(encodeReviewOutcome(outcome({ verdict: 'blocked', route: 'merging' })))).toThrow(
      'review_approval_outcome_route_mismatch'
    );
  });

  it('strips every supervisor reviewer credential from worker environments', () => {
    expect(stripReviewerCredentials({
      PATH: '/usr/bin',
      SYMPHONY_REVIEWER_APP_ID: '1',
      SYMPHONY_REVIEWER_INSTALLATION_ID: '2',
      SYMPHONY_REVIEWER_PRIVATE_KEY: 'secret',
      SYMPHONY_REVIEWER_PRIVATE_KEY_PATH: '/secret/key.pem'
    })).toEqual({ PATH: '/usr/bin' });
  });

  it('finalizes a clean exact-head review without reviewer credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-review-finalize-'));
    dirs.push(root);
    execFileSync('git', ['init', '-b', 'feature/NIE-574'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await fs.writeFile(path.join(root, 'README.md'), 'review\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'docs: review'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:nielsgl/symphony.git'], { cwd: root });
    const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const capsule = path.join(root, '.git', 'symphony-review', actualHead);
    await fs.mkdir(capsule, { recursive: true });
    const bodyFile = path.join(capsule, 'draft.md');
    await fs.writeFile(bodyFile, reviewBody());
    const snapshot: GitHubPullRequestSnapshot = {
      repository: 'nielsgl/symphony', number: 574, base_ref: 'main', base_sha: baseSha,
      head_sha: actualHead, title: 'Review', body: '', draft: false, state: 'open', checks_green: true, checks_settled: true,
      review_decision: null, unresolved_review_threads: 0, external_review: settledExternalReview(), semantic_context: {}, context_sha256: 'e'.repeat(64)
    };
    const result = await finalizeAgentReview({
      issue: 'NIE-574', pr: 574, route: 'merging', bodyFile, cwd: root,
      env: { SYMPHONY_ATTEMPT_ID: 'attempt-1', GH_TOKEN: 'worker-token' },
      now: () => new Date('2026-08-21T10:00:00.000Z'),
      client: { fetchSnapshot: vi.fn(async () => snapshot) } as any
    });
    expect(result.receipt).toMatchObject({ version: 2, head_sha: actualHead, symphony_attempt_id: 'attempt-1' });
    expect(parseReviewOutcome(result.envelope)).toEqual(result.outcome);
    const final = await fs.readFile(result.finalPath, 'utf8');
    expect(extractReviewReceipt(final)).toEqual(result.receipt);
    expect(extractReviewArtifact(final)).toBe(reviewBody());

    await expect(finalizeAgentReview({
      issue: 'NIE-574', pr: 574, route: 'merging', bodyFile, cwd: root,
      env: { SYMPHONY_ATTEMPT_ID: 'attempt-1', GH_TOKEN: 'worker-token', SYMPHONY_BASE_REF: 'origin/develop' },
      now: () => new Date('2026-08-21T10:00:00.000Z'),
      client: { fetchSnapshot: vi.fn(async () => snapshot) } as any
    })).rejects.toThrow('review_finalize_pr_base_mismatch:pr=main,workflow=develop');
    await expect(finalizeAgentReview({
      issue: 'NIE-574', pr: 574, route: 'merging', bodyFile, cwd: root,
      env: { SYMPHONY_ATTEMPT_ID: 'attempt-1', GH_TOKEN: 'worker-token', SYMPHONY_BASE_REF: 'main' },
      now: () => new Date('2026-08-21T10:00:00.000Z'),
      client: { fetchSnapshot: vi.fn(async () => snapshot) } as any
    })).resolves.toMatchObject({ receipt: { base_ref: 'main' } });
  });
});

async function initReviewRepo(remote: string): Promise<{ root: string; head: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-review-'));
  dirs.push(root);
  execFileSync('git', ['init', '-b', 'feature/NIE-574'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  await fs.writeFile(path.join(root, 'README.md'), 'review\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'docs: review'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
  return { root, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
}

function snapshotFor(head: string, overrides: Partial<GitHubPullRequestSnapshot> = {}): GitHubPullRequestSnapshot {
  return {
    repository: 'nielsgl/symphony', number: 574, base_ref: 'main', base_sha: baseSha, head_sha: head,
    title: 'Review', body: '', draft: false, state: 'open', checks_green: true, checks_settled: true,
    review_decision: null, unresolved_review_threads: 0, external_review: settledExternalReview(), semantic_context: {}, context_sha256: 'e'.repeat(64),
    ...overrides
  };
}

async function draftFor(root: string, head: string): Promise<string> {
  const capsule = path.join(root, '.git', 'symphony-review', head);
  await fs.mkdir(capsule, { recursive: true });
  const bodyFile = path.join(capsule, 'draft.md');
  await fs.writeFile(bodyFile, reviewBody());
  return bodyFile;
}

describe('review finalize checks gate', () => {
  it('finalizes a send-back route when settled checks are red', async () => {
    const { root, head } = await initReviewRepo('git@github.com:nielsgl/symphony.git');
    const bodyFile = await draftFor(root, head);
    const snapshot = snapshotFor(head, { checks_green: false, checks_settled: true });
    const result = await finalizeAgentReview({
      issue: 'NIE-574', pr: 574, route: 'in_progress', bodyFile, cwd: root,
      env: { SYMPHONY_ATTEMPT_ID: 'attempt-1', GH_TOKEN: 'worker-token' },
      now: () => new Date('2026-08-21T10:00:00.000Z'),
      client: { fetchSnapshot: vi.fn(async () => snapshot) } as any
    });
    expect(result.receipt).toMatchObject({ verdict: 'blocked', route: 'in_progress', head_sha: head });
    expect(parseReviewOutcome(result.envelope)).toEqual(result.outcome);
  });

  it('refuses every route while the check set is still unsettled', async () => {
    const { root, head } = await initReviewRepo('git@github.com:nielsgl/symphony.git');
    const bodyFile = await draftFor(root, head);
    const client = { fetchSnapshot: vi.fn(async () => snapshotFor(head, { checks_green: false, checks_settled: false })) } as any;
    const env = { SYMPHONY_ATTEMPT_ID: 'attempt-1', GH_TOKEN: 'worker-token' };
    for (const route of ['in_progress', 'rework'] as const) {
      await expect(finalizeAgentReview({
        issue: 'NIE-574', pr: 574, route, bodyFile, cwd: root, env, client
      })).rejects.toThrow('review_finalize_checks_unsettled');
    }
    await expect(finalizeAgentReview({
      issue: 'NIE-574', pr: 574, route: 'merging', bodyFile, cwd: root, env, client
    })).rejects.toThrow('review_finalize_checks_not_green');
  });

  it('still requires green checks before an approval route may finalize', async () => {
    const { root, head } = await initReviewRepo('git@github.com:nielsgl/symphony.git');
    const bodyFile = await draftFor(root, head);
    const client = { fetchSnapshot: vi.fn(async () => snapshotFor(head, { checks_green: false, checks_settled: true })) } as any;
    const env = { SYMPHONY_ATTEMPT_ID: 'attempt-1', GH_TOKEN: 'worker-token' };
    for (const route of ['merging', 'human_review'] as const) {
      await expect(finalizeAgentReview({
        issue: 'NIE-574', pr: 574, route, bodyFile, cwd: root, env, client
      })).rejects.toThrow('review_finalize_checks_not_green');
    }
  });
});

describe('ReviewApprovalCoordinator', () => {
  it('approves the exact head before routing a passing review', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-review-coordinator-'));
    dirs.push(root);
    execFileSync('git', ['init', '-b', 'feature/NIE-574'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await fs.writeFile(path.join(root, 'README.md'), 'review\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'docs: review'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/nielsgl/symphony.git'], { cwd: root });
    const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const artifact = reviewBody();
    const receipt: ReviewReceiptV2 = {
      version: 2, issue_id: 'NIE-574', issue_version: null, repository: 'nielsgl/symphony', pr_number: 574,
      base_ref: 'main', base_sha: baseSha, head_sha: actualHead, verdict: 'pass', route: 'merging',
      symphony_attempt_id: 'attempt-1', review_artifact_sha256: reviewSha256(artifact),
      github_context_sha256: 'e'.repeat(64), created_at: '2026-08-21T10:00:00.000Z'
    };
    const terminal = outcome({
      head_sha: actualHead,
      review_receipt_sha256: receiptSha256(receipt),
      review_artifact_sha256: receipt.review_artifact_sha256
    });
    let state = 'Agent Review';
    const issue: Issue = {
      id: 'linear-id', identifier: 'NIE-574', title: 'Review', description: null, priority: null, state,
      branch_name: 'feature/NIE-574', url: null, labels: [], blocked_by: [], created_at: null, updated_at: null,
      tracker_meta: { tracker_kind: 'linear', repository: 'nielsgl/symphony', pr_links: [
        { number: 574, url: 'https://github.com/nielsgl/symphony/pull/574', state: 'open', merged: false }
      ] }
    };
    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [{ ...issue, state }]),
      fetch_issue_comments: vi.fn(async () => [{
        id: 'comment-1', body: `${artifact}\n### Review Receipt\n${JSON.stringify(receipt)}\n`, created_at: null, updated_at: null
      }]),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async (_id, nextState) => { state = nextState; })
    };
    const events: string[] = [];
    const snapshot: GitHubPullRequestSnapshot = {
      repository: 'nielsgl/symphony', number: 574, base_ref: 'main', base_sha: baseSha, head_sha: actualHead,
      title: 'Review', body: '', draft: false, state: 'open', checks_green: true, checks_settled: true, review_decision: 'APPROVED',
      unresolved_review_threads: 0, external_review: settledExternalReview(), semantic_context: {}, context_sha256: receipt.github_context_sha256
    };
    const coordinator = new ReviewApprovalCoordinator({
      tracker, projectRoot: root, workspaceRoot: path.join(root, 'workspaces'),
      managedWorkspaceRoot: path.join(root, 'workspaces'), baseRef: 'origin/main',
      env: { SYMPHONY_REVIEWER_APP_ID: '1', SYMPHONY_REVIEWER_INSTALLATION_ID: '2' },
      githubClient: { fetchSnapshot: vi.fn(async () => snapshot) } as any,
      brokerFactory: () => ({
        separatedIdentity: vi.fn(async () => ({ slug: 'symphony-reviewer', login: 'symphony-reviewer[bot]', app_id: '1', installation_id: '2' })),
        approve: vi.fn(async () => { events.push('approved'); return { identity: {} as any, review_id: 99, reused: false }; })
      }),
      actionLedger: { upsertReviewApprovalAction: vi.fn(() => events.push('persisted')) }
    });
    const result = await coordinator.process({
      issue, outcome: terminal, workspace: { path: root, workspace_key: 'NIE-574', created_now: false },
      symphonyAttemptId: 'attempt-1'
    });
    expect(result).toMatchObject({ ok: true, state: 'Merging' });
    expect(events).toContain('approved');
    expect(tracker.update_issue_state).toHaveBeenCalledWith('linear-id', 'Merging');
  });

  it('publishes the capsule artifact itself when the worker comment is missing or drifted', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-review-coordinator-'));
    dirs.push(root);
    execFileSync('git', ['init', '-b', 'feature/NIE-574'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await fs.writeFile(path.join(root, 'README.md'), 'review\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'docs: review'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/nielsgl/symphony.git'], { cwd: root });
    const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const artifact = reviewBody();
    const receipt: ReviewReceiptV2 = {
      version: 2, issue_id: 'NIE-574', issue_version: null, repository: 'nielsgl/symphony', pr_number: 574,
      base_ref: 'main', base_sha: baseSha, head_sha: actualHead, verdict: 'pass', route: 'merging',
      symphony_attempt_id: 'attempt-1', review_artifact_sha256: reviewSha256(artifact),
      github_context_sha256: 'e'.repeat(64), created_at: '2026-08-21T10:00:00.000Z'
    };
    const finalMarkdown = `${artifact}\n### Review Receipt\n${JSON.stringify(receipt)}\n`;
    const capsule = path.join(root, '.git', 'symphony-review', actualHead);
    await fs.mkdir(capsule, { recursive: true });
    await fs.writeFile(path.join(capsule, 'final.md'), finalMarkdown);
    const terminal = outcome({
      head_sha: actualHead,
      review_receipt_sha256: receiptSha256(receipt),
      review_artifact_sha256: receipt.review_artifact_sha256
    });
    let state = 'Agent Review';
    const issue: Issue = {
      id: 'linear-id', identifier: 'NIE-574', title: 'Review', description: null, priority: null, state,
      branch_name: 'feature/NIE-574', url: null, labels: [], blocked_by: [], created_at: null, updated_at: null,
      tracker_meta: { tracker_kind: 'linear', repository: 'nielsgl/symphony', pr_links: [
        { number: 574, url: 'https://github.com/nielsgl/symphony/pull/574', state: 'open', merged: false }
      ] }
    };
    // The worker paraphrased the review into the tracker: the receipt JSON
    // survived but the artifact text drifted, so its hash no longer matches.
    const drifted = `${artifact.replace('Approval identity', 'The approval identity')}\n### Review Receipt\n${JSON.stringify(receipt)}\n`;
    const published: string[] = [];
    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [{ ...issue, state }]),
      fetch_issue_comments: vi.fn(async () => [
        { id: 'comment-1', body: drifted, created_at: null, updated_at: null },
        ...published.map((body, index) => ({ id: `posted-${index}`, body, created_at: null, updated_at: null }))
      ]),
      create_comment: vi.fn(async (_id, body) => { published.push(body); }),
      update_issue_state: vi.fn(async (_id, nextState) => { state = nextState; })
    };
    const snapshot: GitHubPullRequestSnapshot = {
      repository: 'nielsgl/symphony', number: 574, base_ref: 'main', base_sha: baseSha, head_sha: actualHead,
      title: 'Review', body: '', draft: false, state: 'open', checks_green: true, checks_settled: true, review_decision: 'APPROVED',
      unresolved_review_threads: 0, external_review: settledExternalReview(), semantic_context: {}, context_sha256: receipt.github_context_sha256
    };
    const coordinator = new ReviewApprovalCoordinator({
      tracker, projectRoot: root, workspaceRoot: path.join(root, 'workspaces'),
      managedWorkspaceRoot: path.join(root, 'workspaces'), baseRef: 'origin/main',
      env: { SYMPHONY_REVIEWER_APP_ID: '1', SYMPHONY_REVIEWER_INSTALLATION_ID: '2' },
      githubClient: { fetchSnapshot: vi.fn(async () => snapshot) } as any,
      brokerFactory: () => ({
        separatedIdentity: vi.fn(async () => ({ slug: 'symphony-reviewer', login: 'symphony-reviewer[bot]', app_id: '1', installation_id: '2' })),
        approve: vi.fn(async () => ({ identity: {} as any, review_id: 99, reused: false }))
      }),
      actionLedger: { upsertReviewApprovalAction: vi.fn() }
    });
    const result = await coordinator.process({
      issue, outcome: terminal, workspace: { path: root, workspace_key: 'NIE-574', created_now: false },
      symphonyAttemptId: 'attempt-1'
    });
    expect(result).toMatchObject({ ok: true, state: 'Merging' });
    expect(published).toEqual([finalMarkdown]);

    // Without a hash-matching capsule the gate still fails closed.
    await fs.rm(path.join(capsule, 'final.md'));
    published.splice(0);
    state = 'Agent Review';
    const second = await coordinator.process({
      issue, outcome: terminal, workspace: { path: root, workspace_key: 'NIE-574', created_now: false },
      symphonyAttemptId: 'attempt-1'
    });
    expect(second).toMatchObject({ ok: false, reason_code: 'review_approval_context_mismatch' });
    expect(published).toEqual([]);
  });

  it('routes a blocked review back to In Progress on red checks without approving', async () => {
    const { root, head } = await initReviewRepo('https://github.com/nielsgl/symphony.git');
    const artifact = reviewBody();
    const receipt: ReviewReceiptV2 = {
      version: 2, issue_id: 'NIE-574', issue_version: null, repository: 'nielsgl/symphony', pr_number: 574,
      base_ref: 'main', base_sha: baseSha, head_sha: head, verdict: 'blocked', route: 'in_progress',
      symphony_attempt_id: 'attempt-1', review_artifact_sha256: reviewSha256(artifact),
      github_context_sha256: 'e'.repeat(64), created_at: '2026-08-21T10:00:00.000Z'
    };
    const terminal = outcome({
      head_sha: head, verdict: 'blocked', route: 'in_progress',
      review_receipt_sha256: receiptSha256(receipt),
      review_artifact_sha256: receipt.review_artifact_sha256
    });
    let state = 'Agent Review';
    const issue: Issue = {
      id: 'linear-id', identifier: 'NIE-574', title: 'Review', description: null, priority: null, state,
      branch_name: 'feature/NIE-574', url: null, labels: [], blocked_by: [], created_at: null, updated_at: null,
      tracker_meta: { tracker_kind: 'linear', repository: 'nielsgl/symphony', pr_links: [
        { number: 574, url: 'https://github.com/nielsgl/symphony/pull/574', state: 'open', merged: false }
      ] }
    };
    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [{ ...issue, state }]),
      fetch_issue_comments: vi.fn(async () => [{
        id: 'comment-1', body: `${artifact}\n### Review Receipt\n${JSON.stringify(receipt)}\n`, created_at: null, updated_at: null
      }]),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async (_id, nextState) => { state = nextState; })
    };
    const approve = vi.fn(async () => ({ identity: {} as any, review_id: 99, reused: false }));
    const coordinator = new ReviewApprovalCoordinator({
      tracker, projectRoot: root, workspaceRoot: path.join(root, 'workspaces'),
      managedWorkspaceRoot: path.join(root, 'workspaces'), baseRef: 'origin/main',
      env: { SYMPHONY_REVIEWER_APP_ID: '1', SYMPHONY_REVIEWER_INSTALLATION_ID: '2' },
      githubClient: {
        fetchSnapshot: vi.fn(async () => snapshotFor(head, {
          checks_green: false, checks_settled: true, context_sha256: receipt.github_context_sha256
        }))
      } as any,
      brokerFactory: () => ({
        separatedIdentity: vi.fn(async () => ({ slug: 'symphony-reviewer', login: 'symphony-reviewer[bot]', app_id: '1', installation_id: '2' })),
        approve
      }),
      actionLedger: { upsertReviewApprovalAction: vi.fn() }
    });
    const result = await coordinator.process({
      issue, outcome: terminal, workspace: { path: root, workspace_key: 'NIE-574', created_now: false },
      symphonyAttemptId: 'attempt-1'
    });
    expect(result).toMatchObject({ ok: true, route: 'in_progress', state: 'In Progress' });
    expect(approve).not.toHaveBeenCalled();
    expect(tracker.update_issue_state).toHaveBeenCalledWith('linear-id', 'In Progress');
  });

  it('names checks_unsettled when a send-back arrives with checks still running', async () => {
    const { root, head } = await initReviewRepo('https://github.com/nielsgl/symphony.git');
    const artifact = reviewBody();
    const receipt: ReviewReceiptV2 = {
      version: 2, issue_id: 'NIE-574', issue_version: null, repository: 'nielsgl/symphony', pr_number: 574,
      base_ref: 'main', base_sha: baseSha, head_sha: head, verdict: 'blocked', route: 'in_progress',
      symphony_attempt_id: 'attempt-1', review_artifact_sha256: reviewSha256(artifact),
      github_context_sha256: 'e'.repeat(64), created_at: '2026-08-21T10:00:00.000Z'
    };
    const terminal = outcome({
      head_sha: head, verdict: 'blocked', route: 'in_progress',
      review_receipt_sha256: receiptSha256(receipt),
      review_artifact_sha256: receipt.review_artifact_sha256
    });
    const issue: Issue = {
      id: 'linear-id', identifier: 'NIE-574', title: 'Review', description: null, priority: null, state: 'Agent Review',
      branch_name: 'feature/NIE-574', url: null, labels: [], blocked_by: [], created_at: null, updated_at: null,
      tracker_meta: { tracker_kind: 'linear', repository: 'nielsgl/symphony', pr_links: [
        { number: 574, url: 'https://github.com/nielsgl/symphony/pull/574', state: 'open', merged: false }
      ] }
    };
    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [issue]),
      fetch_issue_comments: vi.fn(async () => [{
        id: 'comment-1', body: `${artifact}\n### Review Receipt\n${JSON.stringify(receipt)}\n`, created_at: null, updated_at: null
      }]),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };
    const coordinator = new ReviewApprovalCoordinator({
      tracker, projectRoot: root, workspaceRoot: path.join(root, 'workspaces'),
      managedWorkspaceRoot: path.join(root, 'workspaces'), baseRef: 'origin/main',
      env: { SYMPHONY_REVIEWER_APP_ID: '1', SYMPHONY_REVIEWER_INSTALLATION_ID: '2' },
      githubClient: {
        fetchSnapshot: vi.fn(async () => snapshotFor(head, {
          checks_green: false, checks_settled: false, context_sha256: receipt.github_context_sha256
        }))
      } as any,
      brokerFactory: () => ({
        separatedIdentity: vi.fn(async () => ({ slug: 'symphony-reviewer', login: 'symphony-reviewer[bot]', app_id: '1', installation_id: '2' })),
        approve: vi.fn()
      }),
      actionLedger: { upsertReviewApprovalAction: vi.fn() }
    });
    const result = await coordinator.process({
      issue, outcome: terminal, workspace: { path: root, workspace_key: 'NIE-574', created_now: false },
      symphonyAttemptId: 'attempt-1'
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('checks_unsettled');
    expect(tracker.update_issue_state).not.toHaveBeenCalled();
  });
});

describe('review finalize feedback gate', () => {
  const env = {
    SYMPHONY_ATTEMPT_ID: 'attempt-1',
    GH_TOKEN: 'worker-token',
    SYMPHONY_EXTERNAL_REVIEW_BOT: 'chatgpt-codex-connector'
  };
  const pending = {
    unresolved_review_threads: 0,
    external_review: { requested_at: '2026-08-24T07:11:27Z', answered_at: null, unavailable_at: null }
  };

  it('refuses an approval route while the external reviewer has not answered for this head', async () => {
    // The PR is clean by every state reading: zero unresolved threads, green
    // checks, matching head. It is still not approvable, because the reviewer
    // has not finished. Approving here is the ai-platform#577 failure.
    const { root, head } = await initReviewRepo('git@github.com:nielsgl/symphony.git');
    const bodyFile = await draftFor(root, head);
    const client = { fetchSnapshot: vi.fn(async () => snapshotFor(head, pending)) } as any;
    for (const route of ['merging', 'human_review'] as const) {
      await expect(finalizeAgentReview({
        issue: 'NIE-574', pr: 574, route, bodyFile, cwd: root, env, client
      })).rejects.toThrow('review_finalize_external_review_pending');
    }
  });

  it('refuses an approval route while a review conversation is unresolved', async () => {
    const { root, head } = await initReviewRepo('git@github.com:nielsgl/symphony.git');
    const bodyFile = await draftFor(root, head);
    const client = { fetchSnapshot: vi.fn(async () => snapshotFor(head, {
      unresolved_review_threads: 3,
      external_review: { requested_at: '2026-08-24T07:11:27Z', answered_at: '2026-08-24T07:19:58Z', unavailable_at: null }
    })) } as any;
    await expect(finalizeAgentReview({
      issue: 'NIE-574', pr: 574, route: 'merging', bodyFile, cwd: root, env, client
    })).rejects.toThrow('review_finalize_unresolved_review_threads:3');
  });

  it('lets the send-back routes finalize while the review conversation is unfinished', async () => {
    // The send-back routes are the reply to unfinished feedback, so gating them
    // on finished feedback would trap exactly the issues that must move.
    const { root, head } = await initReviewRepo('git@github.com:nielsgl/symphony.git');
    const bodyFile = await draftFor(root, head);
    const client = { fetchSnapshot: vi.fn(async () => snapshotFor(head, {
      unresolved_review_threads: 3,
      external_review: { requested_at: '2026-08-24T07:11:27Z', answered_at: null, unavailable_at: null }
    })) } as any;
    for (const route of ['in_progress', 'rework'] as const) {
      await expect(finalizeAgentReview({
        issue: 'NIE-574', pr: 574, route, bodyFile, cwd: root, env, client
      })).resolves.toMatchObject({ receipt: { route } });
    }
  });

  it('approves once the reviewer has declined to review', async () => {
    const { root, head } = await initReviewRepo('git@github.com:nielsgl/symphony.git');
    const bodyFile = await draftFor(root, head);
    const client = { fetchSnapshot: vi.fn(async () => snapshotFor(head, {
      unresolved_review_threads: 0,
      external_review: {
        requested_at: '2026-08-23T10:14:44Z',
        answered_at: null,
        unavailable_at: '2026-08-23T10:14:54Z'
      }
    })) } as any;
    await expect(finalizeAgentReview({
      issue: 'NIE-574', pr: 574, route: 'merging', bodyFile, cwd: root, env, client
    })).resolves.toMatchObject({ receipt: { route: 'merging', verdict: 'pass' } });
  });

  it('stays inert for projects with no configured external reviewer', async () => {
    const { root, head } = await initReviewRepo('git@github.com:nielsgl/symphony.git');
    const bodyFile = await draftFor(root, head);
    const client = { fetchSnapshot: vi.fn(async () => snapshotFor(head, pending)) } as any;
    await expect(finalizeAgentReview({
      issue: 'NIE-574', pr: 574, route: 'merging', bodyFile, cwd: root,
      env: { SYMPHONY_ATTEMPT_ID: 'attempt-1', GH_TOKEN: 'worker-token' },
      client
    })).resolves.toMatchObject({ receipt: { route: 'merging' } });
  });
});

describe('supervisor feedback mirror', () => {
  it('names external_review_pending and never approves a receipt the gate would not mint', async () => {
    const { root, head } = await initReviewRepo('https://github.com/nielsgl/symphony.git');
    const artifact = reviewBody();
    const receipt: ReviewReceiptV2 = {
      version: 2, issue_id: 'NIE-574', issue_version: null, repository: 'nielsgl/symphony', pr_number: 574,
      base_ref: 'main', base_sha: baseSha, head_sha: head, verdict: 'pass', route: 'merging',
      symphony_attempt_id: 'attempt-1', review_artifact_sha256: reviewSha256(artifact),
      github_context_sha256: 'e'.repeat(64), created_at: '2026-08-21T10:00:00.000Z'
    };
    const terminal = outcome({
      head_sha: head, verdict: 'pass', route: 'merging',
      review_receipt_sha256: receiptSha256(receipt),
      review_artifact_sha256: receipt.review_artifact_sha256
    });
    const issue: Issue = {
      id: 'linear-id', identifier: 'NIE-574', title: 'Review', description: null, priority: null, state: 'Agent Review',
      branch_name: 'feature/NIE-574', url: null, labels: [], blocked_by: [], created_at: null, updated_at: null,
      tracker_meta: { tracker_kind: 'linear', repository: 'nielsgl/symphony', pr_links: [
        { number: 574, url: 'https://github.com/nielsgl/symphony/pull/574', state: 'open', merged: false }
      ] }
    };
    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [issue]),
      fetch_issue_comments: vi.fn(async () => [{
        id: 'comment-1', body: `${artifact}\n### Review Receipt\n${JSON.stringify(receipt)}\n`, created_at: null, updated_at: null
      }]),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };
    const approve = vi.fn();
    const coordinator = new ReviewApprovalCoordinator({
      tracker, projectRoot: root, workspaceRoot: path.join(root, 'workspaces'),
      managedWorkspaceRoot: path.join(root, 'workspaces'), baseRef: 'origin/main',
      env: {
        SYMPHONY_REVIEWER_APP_ID: '1',
        SYMPHONY_REVIEWER_INSTALLATION_ID: '2',
        SYMPHONY_EXTERNAL_REVIEW_BOT: 'chatgpt-codex-connector'
      },
      githubClient: {
        fetchSnapshot: vi.fn(async () => snapshotFor(head, {
          context_sha256: receipt.github_context_sha256,
          unresolved_review_threads: 0,
          external_review: { requested_at: '2026-08-24T07:11:27Z', answered_at: null, unavailable_at: null }
        }))
      } as any,
      brokerFactory: () => ({
        separatedIdentity: vi.fn(async () => ({ slug: 'symphony-reviewer', login: 'symphony-reviewer[bot]', app_id: '1', installation_id: '2' })),
        approve
      }),
      actionLedger: { upsertReviewApprovalAction: vi.fn() }
    });
    const result = await coordinator.process({
      issue, outcome: terminal, workspace: { path: root, workspace_key: 'NIE-574', created_now: false },
      symphonyAttemptId: 'attempt-1'
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('external_review_pending');
    expect(approve).not.toHaveBeenCalled();
    expect(tracker.update_issue_state).not.toHaveBeenCalled();
  });
});
