import crypto from 'node:crypto';

import { REASON_CODES } from '../observability/reason-codes';
import type { AgentReviewOutcome, ReviewReceiptV2, ReviewRoute, ReviewVerdict } from './types';

export const REVIEW_OUTCOME_PREFIX = 'SYMPHONY_REVIEW_OUTCOME_V1 ';
export const MAX_REVIEW_OUTCOME_BYTES = 8 * 1024;

const ROUTES = new Set<ReviewRoute>(['merging', 'human_review', 'in_progress', 'rework']);
const VERDICTS = new Set<ReviewVerdict>(['pass', 'blocked', 'reset']);

export function normalizeReviewMarkdown(value: string): string {
  return `${value.replace(/\r\n/g, '\n').trimEnd()}\n`;
}

export function reviewSha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
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

export function encodeReviewOutcome(outcome: AgentReviewOutcome): string {
  return `${REVIEW_OUTCOME_PREFIX}${Buffer.from(canonicalJson(outcome), 'utf8').toString('base64url')}`;
}

export function parseReviewOutcome(message: string | undefined): AgentReviewOutcome | null {
  if (!message) return null;
  if (!message.includes(REVIEW_OUTCOME_PREFIX)) return null;
  if (Buffer.byteLength(message, 'utf8') > MAX_REVIEW_OUTCOME_BYTES) {
    throw new Error('review_approval_outcome_oversized');
  }
  const trimmed = message.trim();
  if (
    !trimmed.startsWith(REVIEW_OUTCOME_PREFIX)
    || trimmed.includes('\n')
    || trimmed.indexOf(REVIEW_OUTCOME_PREFIX) !== trimmed.lastIndexOf(REVIEW_OUTCOME_PREFIX)
  ) {
    throw new Error('review_approval_outcome_malformed');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice(REVIEW_OUTCOME_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('review_approval_outcome_malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('review_approval_outcome_malformed');
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.issue_id !== 'string' || !value.issue_id.trim() ||
    typeof value.pr_number !== 'number' || !Number.isInteger(value.pr_number) || value.pr_number < 1 ||
    typeof value.base_sha !== 'string' || !/^[0-9a-f]{40}$/i.test(value.base_sha) ||
    typeof value.head_sha !== 'string' || !/^[0-9a-f]{40}$/i.test(value.head_sha) ||
    typeof value.verdict !== 'string' || !VERDICTS.has(value.verdict as ReviewVerdict) ||
    typeof value.route !== 'string' || !ROUTES.has(value.route as ReviewRoute) ||
    typeof value.symphony_attempt_id !== 'string' || !value.symphony_attempt_id.trim() ||
    typeof value.review_receipt_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.review_receipt_sha256) ||
    typeof value.review_artifact_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.review_artifact_sha256)
  ) {
    throw new Error(REASON_CODES.reviewApprovalOutcomeInvalid);
  }
  const outcome = value as unknown as AgentReviewOutcome;
  const expectedRoute = outcome.verdict === 'pass'
    ? outcome.route === 'merging' || outcome.route === 'human_review'
    : outcome.verdict === 'blocked'
      ? outcome.route === 'in_progress'
      : outcome.route === 'rework';
  if (!expectedRoute) throw new Error('review_approval_outcome_route_mismatch');
  return outcome;
}

export function extractReviewReceipt(markdown: string): ReviewReceiptV2 | null {
  const marker = '### Review Receipt';
  const index = markdown.lastIndexOf(marker);
  if (index < 0) return null;
  const remainder = markdown.slice(index + marker.length).trim();
  const line = remainder.split(/\r?\n/, 1)[0]?.trim();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as ReviewReceiptV2;
    if (parsed.version !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function extractReviewArtifact(markdown: string): string | null {
  const marker = '### Review Receipt';
  const index = markdown.lastIndexOf(marker);
  if (index < 0) return null;
  return normalizeReviewMarkdown(markdown.slice(0, index));
}

export function receiptSha256(receipt: ReviewReceiptV2): string {
  return reviewSha256(canonicalJson(receipt));
}
