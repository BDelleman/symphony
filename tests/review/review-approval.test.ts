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
  type GitHubPullRequestSnapshot,
  type ReviewReceiptV2
} from '../../src/review';
import { createGhApiFetch } from '../../src/review/github-context';
import type { Issue, TrackerAdapter } from '../../src/tracker';

const dirs: string[] = [];
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
      head_sha: actualHead, title: 'Review', body: '', draft: false, state: 'open', checks_green: true,
      review_decision: null, semantic_context: {}, context_sha256: 'e'.repeat(64)
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
      title: 'Review', body: '', draft: false, state: 'open', checks_green: true, review_decision: 'APPROVED',
      semantic_context: {}, context_sha256: receipt.github_context_sha256
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
});
