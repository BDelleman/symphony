import { describe, expect, it } from 'vitest';

import {
  collectExternalReviewEvidence,
  externalReviewEnvironment,
  externalReviewSettled,
  parseExternalReviewPatterns,
  resolveExternalReviewPolicy,
  GitHubReviewClient
} from '../../src/review';

const HEAD = '01a4e58a103fda46ddca86a31ce3baefbaf304f4';
const PREVIOUS_HEAD = '4d0e32a24f6dee937ee8b566b8c8fc00e134ce98';
const POLICY = resolveExternalReviewPolicy({
  SYMPHONY_EXTERNAL_REVIEW_BOT: 'chatgpt-codex-connector',
  SYMPHONY_EXTERNAL_REVIEW_UNAVAILABLE_PATTERNS: JSON.stringify([
    'usage limit',
    'create an environment for this repo'
  ])
});

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
      reviews: [{
        login: 'chatgpt-codex-connector[bot]',
        commit_id: PREVIOUS_HEAD,
        submitted_at: '2026-08-23T13:58:24Z'
      }],
      comments: [REQUEST]
    });
    expect(evidence).toEqual({
      requested_at: '2026-08-24T07:11:27Z',
      answered_at: null,
      unavailable_at: null
    });
    expect(externalReviewSettled(evidence, POLICY)).toBe(false);
  });

  it('settles once the reviewer answers for the exact head', () => {
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      policy: POLICY,
      reviews: [
        { login: 'chatgpt-codex-connector[bot]', commit_id: PREVIOUS_HEAD, submitted_at: '2026-08-23T13:58:24Z' },
        { login: 'chatgpt-codex-connector[bot]', commit_id: HEAD, submitted_at: '2026-08-24T07:19:58Z' }
      ],
      comments: [REQUEST]
    });
    expect(evidence.answered_at).toBe('2026-08-24T07:19:58Z');
    expect(externalReviewSettled(evidence, POLICY)).toBe(true);
  });

  it('reopens the wait when a newer request outlives the last answer', () => {
    // A run that stops while Codex is still answering can be redispatched, and
    // the fresh run may post a second request. The first answer does not answer
    // the second request: a review may still be in flight, and treating the
    // earlier one as final would approve just before the later one lands, which
    // is the failure this gate exists to prevent.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      policy: POLICY,
      reviews: [{
        login: 'chatgpt-codex-connector[bot]',
        commit_id: HEAD,
        submitted_at: '2026-08-24T07:19:58Z'
      }],
      comments: [REQUEST, { login: 'bdelleman', body: '@codex review', created_at: '2026-08-24T08:30:00Z' }]
    });
    expect(evidence.answered_at).toBe('2026-08-24T07:19:58Z');
    expect(evidence.requested_at).toBe('2026-08-24T08:30:00Z');
    expect(externalReviewSettled(evidence, POLICY)).toBe(false);
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

  it('recognises every configured notice form, not just the first', () => {
    // A reviewer declines in more than one voice. conclusion-ai/ai-platform#579
    // drew "To use Codex here, create an environment for this repo", which
    // shares no phrase with the usage-limit notice; a single pattern would
    // leave the workflow declaring a settled state the gate could not confirm.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      policy: POLICY,
      reviews: [],
      comments: [
        { login: 'bdelleman', body: '@codex review', created_at: '2026-08-24T08:42:05Z' },
        {
          login: 'chatgpt-codex-connector[bot]',
          body: 'To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).',
          created_at: '2026-08-24T08:42:14Z'
        }
      ]
    });
    expect(evidence.unavailable_at).toBe('2026-08-24T08:42:14Z');
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
    expect(evidence.unavailable_at).toBe('2026-08-23T10:14:54Z');
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
    expect(evidence).toEqual({ requested_at: null, answered_at: null, unavailable_at: null });
    expect(externalReviewSettled(evidence, policy)).toBe(true);
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
      SYMPHONY_EXTERNAL_REVIEW_UNAVAILABLE_PATTERNS:
        '["usage limit","create an environment for this repo"]'
    });
    expect(resolveExternalReviewPolicy(externalReviewEnvironment(POLICY))).toEqual(POLICY);
    expect(externalReviewEnvironment(resolveExternalReviewPolicy({}))).toEqual({});
  });

  it('carries a pattern containing a comma without splitting it', () => {
    // JSON rather than a delimited string: a notice phrase is prose, and prose
    // contains commas.
    const policy = resolveExternalReviewPolicy({
      SYMPHONY_EXTERNAL_REVIEW_BOT: 'reviewer',
      SYMPHONY_EXTERNAL_REVIEW_UNAVAILABLE_PATTERNS: JSON.stringify(['sorry, no capacity'])
    });
    expect(policy.unavailable_patterns).toEqual(['sorry, no capacity']);
    expect(resolveExternalReviewPolicy(externalReviewEnvironment(policy))).toEqual(policy);
  });

  it('yields no patterns for malformed input rather than a bogus one', () => {
    expect(parseExternalReviewPatterns(undefined)).toEqual(['usage limit']);
    expect(parseExternalReviewPatterns('not json')).toEqual([]);
    expect(parseExternalReviewPatterns('"a string"')).toEqual([]);
    expect(parseExternalReviewPatterns(JSON.stringify(['  Usage Limit  ', '', 7]))).toEqual(['usage limit']);
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
        reviews: [{
          id: 1, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'COMMENTED', body: '',
          commit_id: PREVIOUS_HEAD, submitted_at: '2026-08-23T13:58:24Z'
        }],
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
    expect(snapshot.external_review.answered_at).toBeNull();
    expect(externalReviewSettled(snapshot.external_review, POLICY)).toBe(false);
  });

  it('surfaces the findings that arrive after the head was reviewed', async () => {
    const client = new GitHubReviewClient({
      token: 'test-token',
      externalReviewPolicy: POLICY,
      fetchFn: githubFixture({
        reviews: [{
          id: 2, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'COMMENTED', body: '',
          commit_id: HEAD, submitted_at: '2026-08-24T07:19:58Z'
        }],
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
