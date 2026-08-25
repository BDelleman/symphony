import { describe, expect, it } from 'vitest';

import {
  parseWaitExternalArgs,
  renderWaitExternalResult,
  resolveExternalReviewPolicy,
  waitForExternalReview,
  type ExternalReviewEvidence,
  type GitHubReviewClient
} from '../../src/review';

const HEAD = '01a4e58a103fda46ddca86a31ce3baefbaf304f4';
const ENV = {
  SYMPHONY_EXTERNAL_REVIEW_BOT: 'chatgpt-codex-connector',
  SYMPHONY_EXTERNAL_REVIEW_REQUEST_MARKER: '@codex review',
  SYMPHONY_EXTERNAL_REVIEW_UNAVAILABLE_PATTERNS: JSON.stringify(['usage limit'])
};

function evidence(overrides: Partial<ExternalReviewEvidence>): ExternalReviewEvidence {
  return {
    requested_at: '2026-08-25T09:10:40Z',
    answered_at: null,
    unavailable_at: null,
    head_arrived_at: '2026-08-25T09:05:00Z',
    ...overrides
  };
}

// Only head_sha and external_review are read by the wait loop; the cast keeps
// the fake honest about that surface without replaying GitHub payloads.
function clientReturning(snapshots: Array<{ head_sha: string; external_review: ExternalReviewEvidence }>): GitHubReviewClient {
  let call = 0;
  return {
    fetchSnapshot: async () => snapshots[Math.min(call++, snapshots.length - 1)]
  } as unknown as GitHubReviewClient;
}

function fakeTimers(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let clock = 0;
  const slept: number[] = [];
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    slept
  };
}

describe('review wait-external', () => {
  it('returns settled_answered as soon as the reviewer has spoken for this head', async () => {
    const timers = fakeTimers();
    const result = await waitForExternalReview({
      pr: 601,
      cwd: '/unused',
      env: ENV,
      client: clientReturning([{ head_sha: HEAD, external_review: evidence({ answered_at: '2026-08-25T09:15:19Z' }) }]),
      now: timers.now,
      sleep: timers.sleep,
      resolveHead: () => HEAD,
      resolveRepository: () => 'conclusion-ai/ai-platform'
    });
    expect(result.status).toBe('settled_answered');
    expect(result.polls).toBe(1);
    expect(timers.slept).toEqual([]);
  });

  it('keeps polling until the answer arrives, then settles', async () => {
    const timers = fakeTimers();
    const pending = { head_sha: HEAD, external_review: evidence({}) };
    const answered = { head_sha: HEAD, external_review: evidence({ answered_at: '2026-08-25T09:15:19Z' }) };
    const result = await waitForExternalReview({
      pr: 601,
      cwd: '/unused',
      env: ENV,
      client: clientReturning([pending, pending, answered]),
      now: timers.now,
      sleep: timers.sleep,
      resolveHead: () => HEAD,
      resolveRepository: () => 'conclusion-ai/ai-platform'
    });
    expect(result.status).toBe('settled_answered');
    expect(result.polls).toBe(3);
    expect(timers.slept).toEqual([20_000, 20_000]);
  });

  it('returns pending once the budget is spent instead of overstaying its tool call', async () => {
    // The command exists because a single quiet tool call longer than the
    // missing-tool-output threshold gets the worker killed; overstaying the
    // budget would recreate the failure it is meant to prevent.
    const timers = fakeTimers();
    const result = await waitForExternalReview({
      pr: 601,
      cwd: '/unused',
      env: ENV,
      budgetMs: 50_000,
      client: clientReturning([{ head_sha: HEAD, external_review: evidence({}) }]),
      now: timers.now,
      sleep: timers.sleep,
      resolveHead: () => HEAD,
      resolveRepository: () => 'conclusion-ai/ai-platform'
    });
    expect(result.status).toBe('pending');
    // 0ms → sleep 20s → 20s → sleep 20s → 40s → sleep the 10s remainder → 50s → budget spent.
    expect(timers.slept).toEqual([20_000, 20_000, 10_000]);
    expect(result.waited_ms).toBe(50_000);
  });

  it('returns stale_request immediately: waiting cannot repair it', async () => {
    const timers = fakeTimers();
    const result = await waitForExternalReview({
      pr: 601,
      cwd: '/unused',
      env: ENV,
      client: clientReturning([{
        head_sha: HEAD,
        // A decline answering a request older than the head: the hold is
        // 'stale_request' and only a fresh request changes it.
        external_review: evidence({
          requested_at: '2026-08-25T09:00:00Z',
          unavailable_at: '2026-08-25T09:01:00Z',
          head_arrived_at: '2026-08-25T09:05:00Z'
        })
      }]),
      now: timers.now,
      sleep: timers.sleep,
      resolveHead: () => HEAD,
      resolveRepository: () => 'conclusion-ai/ai-platform'
    });
    expect(result.status).toBe('stale_request');
    expect(result.polls).toBe(1);
    expect(timers.slept).toEqual([]);
  });

  it('reports head_mismatch instead of vouching for a head it did not check', async () => {
    const timers = fakeTimers();
    const result = await waitForExternalReview({
      pr: 601,
      cwd: '/unused',
      env: ENV,
      client: clientReturning([{ head_sha: '4d0e32a24f6dee937ee8b566b8c8fc00e134ce98', external_review: evidence({}) }]),
      now: timers.now,
      sleep: timers.sleep,
      resolveHead: () => HEAD,
      resolveRepository: () => 'conclusion-ai/ai-platform'
    });
    expect(result.status).toBe('head_mismatch');
    expect(result.pr_head_sha).toBe('4d0e32a24f6dee937ee8b566b8c8fc00e134ce98');
  });

  it('short-circuits to not_required when no reviewer bot is configured', async () => {
    const result = await waitForExternalReview({
      pr: 601,
      cwd: '/unused',
      env: {},
      resolveHead: () => HEAD,
      resolveRepository: () => 'conclusion-ai/ai-platform'
    });
    expect(result.status).toBe('not_required');
    expect(result.polls).toBe(0);
  });

  it('renders every field an agent needs to act without re-querying', () => {
    const text = renderWaitExternalResult({
      status: 'pending',
      head_sha: HEAD,
      pr_head_sha: HEAD,
      evidence: evidence({}),
      waited_ms: 240_000,
      polls: 12,
      hint: 'The external reviewer has not answered yet; run this command again to keep waiting.'
    });
    expect(text).toContain('external_review_status=pending');
    expect(text).toContain(`head_sha=${HEAD}`);
    expect(text).toContain('requested_at=2026-08-25T09:10:40Z');
    expect(text).toContain('answered_at=n/a');
    expect(text).toContain('hint=');
  });

  it('parses its flags and refuses malformed ones', () => {
    expect(parseWaitExternalArgs(['wait-external', '--pr', '601'])).toEqual({
      pr: 601,
      budgetMs: undefined,
      pollIntervalMs: undefined
    });
    expect(parseWaitExternalArgs(['wait-external', '--pr', '601', '--budget-seconds', '120', '--poll-seconds', '15']))
      .toEqual({ pr: 601, budgetMs: 120_000, pollIntervalMs: 15_000 });
    expect(() => parseWaitExternalArgs(['wait-external', '--pr', 'abc'])).toThrow('review_wait_external_pr_invalid');
    expect(() => parseWaitExternalArgs(['wait-external', '--pr', '601', '--budget-seconds', '0']))
      .toThrow('review_wait_external_option_invalid:--budget-seconds');
  });

  it('honours the environment overrides the orchestrator can hand across', async () => {
    const timers = fakeTimers();
    const result = await waitForExternalReview({
      pr: 601,
      cwd: '/unused',
      env: {
        ...ENV,
        SYMPHONY_WAIT_EXTERNAL_BUDGET_MS: '30000',
        SYMPHONY_WAIT_EXTERNAL_POLL_INTERVAL_MS: '10000'
      },
      client: clientReturning([{ head_sha: HEAD, external_review: evidence({}) }]),
      now: timers.now,
      sleep: timers.sleep,
      resolveHead: () => HEAD,
      resolveRepository: () => 'conclusion-ai/ai-platform'
    });
    expect(result.status).toBe('pending');
    expect(timers.slept).toEqual([10_000, 10_000, 10_000]);
  });
});
