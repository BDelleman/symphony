import { describe, expect, it } from 'vitest';

import {
  collectExternalReviewEvidence,
  externalReviewEnvironment,
  externalReviewSettled,
  resolveExternalReviewPolicy,
  GitHubReviewClient
} from '../../src/review';

const HEAD = '01a4e58a103fda46ddca86a31ce3baefbaf304f4';
const PREVIOUS_HEAD = '4d0e32a24f6dee937ee8b566b8c8fc00e134ce98';
const POLICY = resolveExternalReviewPolicy({ SYMPHONY_EXTERNAL_REVIEW_BOT: 'chatgpt-codex-connector' });

// Reconstructed from conclusion-ai/ai-platform#577, where the App approval was
// submitted at 07:19:47 and the review that contradicted it arrived at 07:19:58.
const REQUEST = {
  login: 'bdelleman',
  body: '@codex review',
  created_at: '2026-08-24T07:11:27Z'
};

describe('external review evidence', () => {
  it('reports pending while the reviewer has not answered for this head', () => {
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      policy: POLICY,
      // The previous round's review is answered and resolved; it says nothing
      // about the commit that replaced it.
      reviews: [{ login: 'chatgpt-codex-connector[bot]', commit_id: PREVIOUS_HEAD }],
      comments: [REQUEST]
    });
    expect(evidence).toEqual({
      requested_at: '2026-08-24T07:11:27Z',
      answered_for_head: false,
      unavailable_at: null
    });
    expect(externalReviewSettled(evidence, POLICY)).toBe(false);
  });

  it('settles once the reviewer answers for the exact head', () => {
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      policy: POLICY,
      reviews: [
        { login: 'chatgpt-codex-connector[bot]', commit_id: PREVIOUS_HEAD },
        { login: 'chatgpt-codex-connector[bot]', commit_id: HEAD }
      ],
      comments: [REQUEST]
    });
    expect(evidence.answered_for_head).toBe(true);
    expect(externalReviewSettled(evidence, POLICY)).toBe(true);
  });

  it('settles on an explicit unavailability notice', () => {
    // conclusion-ai/ai-platform#569: the quota notice landed ten seconds after
    // the request, which is what real unavailability looks like.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      policy: POLICY,
      reviews: [],
      comments: [
        { login: 'bdelleman', body: '@codex review', created_at: '2026-08-23T10:14:44Z' },
        {
          login: 'chatgpt-codex-connector[bot]',
          body: 'You have reached your Codex usage limits for code reviews.',
          created_at: '2026-08-23T10:14:54Z'
        }
      ]
    });
    expect(evidence.unavailable_at).toBe('2026-08-23T10:14:54Z');
    expect(externalReviewSettled(evidence, POLICY)).toBe(true);
  });

  it('ignores an unavailability notice that predates the current request', () => {
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      policy: POLICY,
      reviews: [],
      comments: [
        {
          login: 'chatgpt-codex-connector[bot]',
          body: 'You have reached your Codex usage limits for code reviews.',
          created_at: '2026-08-23T10:14:54Z'
        },
        REQUEST
      ]
    });
    expect(evidence.unavailable_at).toBeNull();
    expect(externalReviewSettled(evidence, POLICY)).toBe(false);
  });

  it('does not let the reviewer start its own clock by quoting the marker', () => {
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      policy: POLICY,
      reviews: [],
      comments: [{
        login: 'chatgpt-codex-connector[bot]',
        body: 'Comment "@codex review" to trigger a review.',
        created_at: '2026-08-24T07:11:27Z'
      }]
    });
    expect(evidence.requested_at).toBeNull();
  });

  it('stays inert when no reviewer bot is configured', () => {
    const policy = resolveExternalReviewPolicy({});
    const evidence = collectExternalReviewEvidence({ headSha: HEAD, policy, reviews: [], comments: [REQUEST] });
    expect(evidence).toEqual({ requested_at: null, answered_for_head: false, unavailable_at: null });
    expect(externalReviewSettled(evidence, policy)).toBe(true);
  });
});

function githubFixture(options: {
  reviews: Array<Record<string, unknown>>;
  issueComments: Array<Record<string, unknown>>;
  threads: Array<{ id: string; isResolved: boolean }>;
}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const json = (value: unknown): Response =>
      new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    const route = url.pathname;
    if (route === '/graphql') {
      return json({
        data: {
          repository: {
            pullRequest: {
              reviewDecision: 'REVIEW_REQUIRED',
              reviewThreads: { nodes: options.threads, pageInfo: { hasNextPage: false } }
            }
          }
        }
      });
    }
    if (route === '/repos/acme/repo/pulls/1') {
      return json({
        head: { sha: HEAD },
        base: { ref: 'develop', sha: 'a'.repeat(40) },
        title: 'Review', body: '', draft: false, state: 'open', changed_files: 1
      });
    }
    if (route === '/repos/acme/repo/pulls/1/reviews') return json(options.reviews);
    if (route === '/repos/acme/repo/issues/1/comments') return json(options.issueComments);
    if (route === '/repos/acme/repo/pulls/1/comments') return json([]);
    if (route === '/repos/acme/repo/pulls/1/files') return json([{ filename: 'README.md' }]);
    if (route === `/repos/acme/repo/commits/${HEAD}/check-runs`) {
      return json({ total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] });
    }
    if (route === `/repos/acme/repo/commits/${HEAD}/status`) return json({ total_count: 0, statuses: [] });
    throw new Error(`unexpected route ${route}`);
  }) as typeof fetch;
}

describe('snapshot feedback derivation', () => {
  it('counts only unresolved threads, whatever commit GitHub re-anchors them to', async () => {
    // GitHub drags surviving threads forward onto every new head, so the
    // previous round's resolved threads report commit_id === HEAD. Counting by
    // commit would make any PR that ever had one review round permanently
    // unapprovable; only isResolved may decide.
    const client = new GitHubReviewClient({
      token: 'test-token',
      externalReviewPolicy: POLICY,
      fetchFn: githubFixture({
        reviews: [{ id: 1, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'COMMENTED', body: '', commit_id: PREVIOUS_HEAD }],
        issueComments: [{ id: 10, user: { login: 'BDelleman' }, body: '@codex review', created_at: '2026-08-24T07:11:27Z' }],
        threads: [
          { id: 'thread-1', isResolved: true },
          { id: 'thread-2', isResolved: true },
          { id: 'thread-3', isResolved: true }
        ]
      })
    });
    const snapshot = await client.fetchSnapshot('acme/repo', 1, 'symphony-reviewer[bot]');
    expect(snapshot.unresolved_review_threads).toBe(0);
    // Clean by every state reading, and still not approvable: the reviewer has
    // not spoken about this head yet. This is exactly the 07:19:24 moment.
    expect(snapshot.external_review.answered_for_head).toBe(false);
    expect(externalReviewSettled(snapshot.external_review, POLICY)).toBe(false);
  });

  it('surfaces the findings that arrive after the head was reviewed', async () => {
    const client = new GitHubReviewClient({
      token: 'test-token',
      externalReviewPolicy: POLICY,
      fetchFn: githubFixture({
        reviews: [{ id: 2, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'COMMENTED', body: '', commit_id: HEAD }],
        issueComments: [{ id: 10, user: { login: 'BDelleman' }, body: '@codex review', created_at: '2026-08-24T07:11:27Z' }],
        threads: [
          { id: 'thread-1', isResolved: true },
          { id: 'thread-4', isResolved: false },
          { id: 'thread-5', isResolved: false },
          { id: 'thread-6', isResolved: false }
        ]
      })
    });
    const snapshot = await client.fetchSnapshot('acme/repo', 1, 'symphony-reviewer[bot]');
    expect(snapshot.unresolved_review_threads).toBe(3);
    expect(externalReviewSettled(snapshot.external_review, POLICY)).toBe(true);
  });
});

describe('external review worker handoff', () => {
  it('carries the policy across the worker environment allowlist', () => {
    // The worker environment is an allowlist, not an inherited copy, so a
    // policy that is not handed over explicitly leaves `symphony review
    // finalize` ungated inside the worker.
    expect(externalReviewEnvironment(POLICY)).toEqual({
      SYMPHONY_EXTERNAL_REVIEW_BOT: 'chatgpt-codex-connector',
      SYMPHONY_EXTERNAL_REVIEW_REQUEST_MARKER: '@codex review',
      SYMPHONY_EXTERNAL_REVIEW_UNAVAILABLE_PATTERN: 'usage limits'
    });
    expect(resolveExternalReviewPolicy(externalReviewEnvironment(POLICY))).toEqual(POLICY);
    expect(externalReviewEnvironment(resolveExternalReviewPolicy({}))).toEqual({});
  });
});
