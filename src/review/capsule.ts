import fs from 'node:fs';
import path from 'node:path';

import { coerceReviewOutcome, receiptSha256 } from './contract';
import type { AgentReviewOutcome, ReviewReceiptV2 } from './types';

// `review finalize` writes receipt-v2.json into <git-dir>/symphony-review/<head_sha>/
// as a deterministic side effect of a successful finalize. Reading the outcome from
// that capsule removes the agent's free-text final message as the transport for the
// review contract: prose or markdown decoration around the terminal envelope can no
// longer discard a finalized review. This adds no forgery surface — the worker can
// already write arbitrary files in its workspace, and the coordinator authenticates
// every outcome against the receipt posted to the PR, exactly as it does for
// envelope-transported outcomes.

export function resolveWorkspaceGitDirectory(workspacePath: string): string | null {
  const dotGit = path.join(workspacePath, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
  if (!match) return null;
  return path.resolve(workspacePath, match[1]!);
}

export interface CapsuleReviewOutcomeQuery {
  workspacePath: string;
  symphonyAttemptId: string;
}

export function readCapsuleReviewOutcome(query: CapsuleReviewOutcomeQuery): AgentReviewOutcome | null {
  const attemptId = query.symphonyAttemptId.trim();
  if (!attemptId) return null;
  const gitDirectory = resolveWorkspaceGitDirectory(query.workspacePath);
  if (!gitDirectory) return null;
  const capsuleRoot = path.join(gitDirectory, 'symphony-review');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(capsuleRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches: { headShaDirectory: string; receipt: ReviewReceiptV2 }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(capsuleRoot, entry.name, 'receipt-v2.json'), 'utf8'));
    } catch {
      // A missing or unparseable receipt cannot be attributed to any attempt.
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const receipt = parsed as ReviewReceiptV2;
    if (receipt.version !== 2) continue;
    if (typeof receipt.symphony_attempt_id !== 'string' || receipt.symphony_attempt_id !== attemptId) continue;
    matches.push({ headShaDirectory: entry.name, receipt });
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error('review_approval_receipt_ambiguous');
  const { headShaDirectory, receipt } = matches[0]!;
  if (typeof receipt.head_sha !== 'string' || receipt.head_sha !== headShaDirectory) {
    throw new Error('review_approval_receipt_ambiguous');
  }
  return coerceReviewOutcome({
    version: 1,
    issue_id: receipt.issue_id,
    pr_number: receipt.pr_number,
    base_sha: receipt.base_sha,
    head_sha: receipt.head_sha,
    verdict: receipt.verdict,
    route: receipt.route,
    symphony_attempt_id: receipt.symphony_attempt_id,
    review_receipt_sha256: receiptSha256(receipt),
    review_artifact_sha256: receipt.review_artifact_sha256
  });
}

export function reviewOutcomesEqual(left: AgentReviewOutcome, right: AgentReviewOutcome): boolean {
  return (
    left.version === right.version &&
    left.issue_id === right.issue_id &&
    left.pr_number === right.pr_number &&
    left.base_sha === right.base_sha &&
    left.head_sha === right.head_sha &&
    left.verdict === right.verdict &&
    left.route === right.route &&
    left.symphony_attempt_id === right.symphony_attempt_id &&
    left.review_receipt_sha256 === right.review_receipt_sha256 &&
    left.review_artifact_sha256 === right.review_artifact_sha256
  );
}
