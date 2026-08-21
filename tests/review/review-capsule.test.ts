import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  encodeReviewOutcome,
  parseReviewOutcome,
  readCapsuleReviewOutcome,
  receiptSha256,
  reviewOutcomesEqual,
  type ReviewReceiptV2
} from '../../src/review';

const dirs: string[] = [];
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

function receipt(overrides: Partial<ReviewReceiptV2> = {}): ReviewReceiptV2 {
  return {
    version: 2,
    issue_id: 'NIE-574',
    issue_version: null,
    repository: 'acme/repo',
    pr_number: 574,
    base_ref: 'main',
    base_sha: baseSha,
    head_sha: headSha,
    verdict: 'pass',
    route: 'merging',
    symphony_attempt_id: 'attempt-1',
    review_artifact_sha256: 'd'.repeat(64),
    github_context_sha256: 'e'.repeat(64),
    created_at: '2026-08-21T12:00:00.000Z',
    ...overrides
  };
}

async function workspaceWithCapsule(
  receipts: ReviewReceiptV2[],
  options: { gitFileIndirection?: boolean; capsuleDirName?: (entry: ReviewReceiptV2) => string } = {}
): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-capsule-'));
  dirs.push(workspace);
  let gitDirectory = path.join(workspace, '.git');
  if (options.gitFileIndirection) {
    gitDirectory = path.join(workspace, 'real-git-dir');
    await fs.mkdir(gitDirectory, { recursive: true });
    await fs.writeFile(path.join(workspace, '.git'), `gitdir: ${gitDirectory}\n`, 'utf8');
  }
  for (const entry of receipts) {
    const capsule = path.join(
      gitDirectory,
      'symphony-review',
      options.capsuleDirName ? options.capsuleDirName(entry) : entry.head_sha
    );
    await fs.mkdir(capsule, { recursive: true });
    await fs.writeFile(path.join(capsule, 'receipt-v2.json'), `${JSON.stringify(entry)}\n`, 'utf8');
  }
  return workspace;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('review capsule outcome transport', () => {
  it('derives the same outcome from the capsule receipt that finalize encoded in the envelope', async () => {
    const stored = receipt();
    const workspace = await workspaceWithCapsule([stored]);
    const capsuleOutcome = readCapsuleReviewOutcome({ workspacePath: workspace, symphonyAttemptId: 'attempt-1' });
    expect(capsuleOutcome).not.toBeNull();
    const envelopeOutcome = parseReviewOutcome(encodeReviewOutcome(capsuleOutcome!));
    expect(reviewOutcomesEqual(capsuleOutcome!, envelopeOutcome!)).toBe(true);
    expect(capsuleOutcome!.review_receipt_sha256).toBe(receiptSha256(stored));
    expect(capsuleOutcome!.verdict).toBe('pass');
  });

  it('resolves the capsule through a gitdir file indirection', async () => {
    const workspace = await workspaceWithCapsule([receipt()], { gitFileIndirection: true });
    expect(readCapsuleReviewOutcome({ workspacePath: workspace, symphonyAttemptId: 'attempt-1' })).not.toBeNull();
  });

  it('returns null when no receipt matches the attempt', async () => {
    const workspace = await workspaceWithCapsule([receipt({ symphony_attempt_id: 'attempt-0' })]);
    expect(readCapsuleReviewOutcome({ workspacePath: workspace, symphonyAttemptId: 'attempt-1' })).toBeNull();
    expect(readCapsuleReviewOutcome({ workspacePath: workspace, symphonyAttemptId: '' })).toBeNull();
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-capsule-'));
    dirs.push(bare);
    expect(readCapsuleReviewOutcome({ workspacePath: bare, symphonyAttemptId: 'attempt-1' })).toBeNull();
  });

  it('ignores unparseable receipts but fails closed on ambiguity and integrity mismatches', async () => {
    const corrupt = await workspaceWithCapsule([receipt()]);
    const corruptCapsule = path.join(corrupt, '.git', 'symphony-review', 'f'.repeat(40));
    await fs.mkdir(corruptCapsule, { recursive: true });
    await fs.writeFile(path.join(corruptCapsule, 'receipt-v2.json'), 'not json', 'utf8');
    expect(readCapsuleReviewOutcome({ workspacePath: corrupt, symphonyAttemptId: 'attempt-1' })).not.toBeNull();

    const ambiguous = await workspaceWithCapsule([receipt(), receipt({ head_sha: 'c'.repeat(40) })]);
    expect(() => readCapsuleReviewOutcome({ workspacePath: ambiguous, symphonyAttemptId: 'attempt-1' })).toThrow(
      'review_approval_receipt_ambiguous'
    );

    const misplaced = await workspaceWithCapsule([receipt()], { capsuleDirName: () => '9'.repeat(40) });
    expect(() => readCapsuleReviewOutcome({ workspacePath: misplaced, symphonyAttemptId: 'attempt-1' })).toThrow(
      'review_approval_receipt_ambiguous'
    );

    const invalid = await workspaceWithCapsule([receipt({ verdict: 'pass', route: 'rework' })]);
    expect(() => readCapsuleReviewOutcome({ workspacePath: invalid, symphonyAttemptId: 'attempt-1' })).toThrow(
      'review_approval_outcome_route_mismatch'
    );
  });
});
