import { describe, expect, it } from 'vitest';

import {
  collectExternalReviewEvidence,
  externalReviewEnvironment,
  externalReviewHold,
  externalReviewSettled,
  parseExternalReviewPatterns,
  resolveExternalReviewPolicy,
  GitHubReviewClient
} from '../../src/review';

const HEAD = '01a4e58a103fda46ddca86a31ce3baefbaf304f4';
const PREVIOUS_HEAD = '4d0e32a24f6dee937ee8b566b8c8fc00e134ce98';
// When HEAD became the PR head, just before the request below asked about it.
const HEAD_ARRIVED = '2026-08-24T07:10:12Z';
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
      headArrivedAt: HEAD_ARRIVED,
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
      unavailable_at: null,
      head_arrived_at: HEAD_ARRIVED
    });
    expect(externalReviewSettled(evidence, POLICY)).toBe(false);
    expect(externalReviewHold(evidence, POLICY)).toBe('pending');
  });

  it('settles once the reviewer answers for the exact head', () => {
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      headArrivedAt: HEAD_ARRIVED,
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

  it('lets an answer for the exact head settle even without an arrival time', () => {
    // answered_at is head-bound by construction — the review names the commit
    // it reviewed — so it must not depend on the timeline lookup succeeding.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      headArrivedAt: null,
      policy: POLICY,
      reviews: [{ login: 'chatgpt-codex-connector[bot]', commit_id: HEAD, submitted_at: '2026-08-24T07:19:58Z' }],
      comments: [REQUEST]
    });
    expect(evidence.head_arrived_at).toBeNull();
    expect(externalReviewSettled(evidence, POLICY)).toBe(true);
  });

  it('settles on a clean verdict posted as a comment naming the head', () => {
    // conclusion-ai/ai-platform#601: Codex submits a PR review only when it has
    // findings. A clean verdict arrives as an issue comment ("Didn't find any
    // major issues. Reviewed commit: `7b12b50c21`"), which carries no commit_id
    // — the SHA in the body is the only binding. Without this channel the gate
    // can never settle on exactly the runs that should pass.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      headArrivedAt: HEAD_ARRIVED,
      policy: POLICY,
      reviews: [],
      comments: [REQUEST, {
        login: 'chatgpt-codex-connector[bot]',
        body: 'Codex Review: Didn\'t find any major issues.\n\n**Reviewed commit:** `01a4e58a10`',
        created_at: '2026-08-24T07:19:58Z'
      }]
    });
    expect(evidence.answered_at).toBe('2026-08-24T07:19:58Z');
    expect(externalReviewSettled(evidence, POLICY)).toBe(true);
  });

  it('refuses a clean comment that names a previous head', () => {
    // The mention is the binding, so a clean comment from the prior round must
    // vouch for nothing once commits land — the same rule commit_id enforces
    // for submitted reviews.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      headArrivedAt: HEAD_ARRIVED,
      policy: POLICY,
      reviews: [],
      comments: [REQUEST, {
        login: 'chatgpt-codex-connector[bot]',
        body: 'Codex Review: Didn\'t find any major issues.\n\n**Reviewed commit:** `4d0e32a24f`',
        created_at: '2026-08-24T07:19:58Z'
      }]
    });
    expect(evidence.answered_at).toBeNull();
    expect(externalReviewHold(evidence, POLICY)).toBe('pending');
  });

  it('does not let anyone but the reviewer answer by quoting the head', () => {
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      headArrivedAt: HEAD_ARRIVED,
      policy: POLICY,
      reviews: [],
      comments: [REQUEST, {
        login: 'bdelleman',
        body: `Reviewed commit ${HEAD} myself, looks fine.`,
        created_at: '2026-08-24T07:19:58Z'
      }]
    });
    expect(evidence.answered_at).toBeNull();
  });

  it('ignores a head mention too short to bind', () => {
    // Nine hex characters could be a checks id or a timestamp fragment; ten is
    // the shortest form the reviewer emits, so anything below it fails closed.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      headArrivedAt: HEAD_ARRIVED,
      policy: POLICY,
      reviews: [],
      comments: [REQUEST, {
        login: 'chatgpt-codex-connector[bot]',
        body: 'Reviewed commit `01a4e58a1` and found nothing.',
        created_at: '2026-08-24T07:19:58Z'
      }]
    });
    expect(evidence.answered_at).toBeNull();
  });

  it('reopens the wait when a newer request outlives a clean comment', () => {
    // Same ordering rule as submitted reviews: a clean comment for this head
    // answers only requests that precede it, so a fresh request keeps holding.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      headArrivedAt: HEAD_ARRIVED,
      policy: POLICY,
      reviews: [],
      comments: [
        REQUEST,
        {
          login: 'chatgpt-codex-connector[bot]',
          body: 'Codex Review: Didn\'t find any major issues.\n\n**Reviewed commit:** `01a4e58a10`',
          created_at: '2026-08-24T07:19:58Z'
        },
        { login: 'bdelleman', body: '@codex review', created_at: '2026-08-24T08:30:00Z' }
      ]
    });
    expect(evidence.answered_at).toBe('2026-08-24T07:19:58Z');
    expect(externalReviewSettled(evidence, POLICY)).toBe(false);
  });

  it('reopens the wait when a newer request outlives the last answer', () => {
    // A run that stops while Codex is still answering can be redispatched, and
    // the fresh run may post a second request. The first answer does not answer
    // the second request: a review may still be in flight, and treating the
    // earlier one as final would approve just before the later one lands, which
    // is the failure this gate exists to prevent.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      headArrivedAt: HEAD_ARRIVED,
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
    // the request, which is what real unavailability looks like. The head was
    // already on the PR when the request went out, so the notice vouches for it.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      headArrivedAt: '2026-08-23T10:13:02Z',
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

  it('refuses a notice answering a request older than the current head', () => {
    // The stale-request hole found five times on conclusion-ai/ai-platform#579:
    // a request goes out for commit A, new commits land, the reviewer posts a
    // usage-limit notice. The notice postdates the request, but the request
    // predates the head — nobody ever asked for a review of this head, so the
    // decline is evidence for a previous one and must not settle anything.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      headArrivedAt: '2026-08-24T07:15:00Z',
      policy: POLICY,
      reviews: [],
      comments: [
        REQUEST,
        {
          login: 'chatgpt-codex-connector[bot]',
          body: 'You have reached your Codex usage limits for code reviews.',
          created_at: '2026-08-24T07:16:30Z'
        }
      ]
    });
    expect(evidence.unavailable_at).toBe('2026-08-24T07:16:30Z');
    expect(externalReviewSettled(evidence, POLICY)).toBe(false);
    expect(externalReviewHold(evidence, POLICY)).toBe('stale_request');
  });

  it('holds unavailability when the head arrival time is unknown', () => {
    // A gate that cannot verify must hold, not pass: without an arrival time
    // there is no way to tell whether the request was for this head.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      headArrivedAt: null,
      policy: POLICY,
      reviews: [],
      comments: [
        REQUEST,
        {
          login: 'chatgpt-codex-connector[bot]',
          body: 'You have reached your Codex usage limits for code reviews.',
          created_at: '2026-08-24T07:16:30Z'
        }
      ]
    });
    expect(externalReviewSettled(evidence, POLICY)).toBe(false);
    expect(externalReviewHold(evidence, POLICY)).toBe('stale_request');
  });

  it('waits for the answer to the newest of two requests around a notice', () => {
    // Request, notice, request: the notice settled the first request, but the
    // second is outstanding and a review for it may still land.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      headArrivedAt: HEAD_ARRIVED,
      policy: POLICY,
      reviews: [],
      comments: [
        REQUEST,
        {
          login: 'chatgpt-codex-connector[bot]',
          body: 'You have reached your Codex usage limits for code reviews.',
          created_at: '2026-08-24T07:16:30Z'
        },
        { login: 'bdelleman', body: '@codex review', created_at: '2026-08-24T08:30:00Z' }
      ]
    });
    expect(evidence.requested_at).toBe('2026-08-24T08:30:00Z');
    expect(externalReviewSettled(evidence, POLICY)).toBe(false);
    expect(externalReviewHold(evidence, POLICY)).toBe('pending');
  });

  it('recognises every configured notice form, not just the first', () => {
    // A reviewer declines in more than one voice. conclusion-ai/ai-platform#579
    // drew "To use Codex here, create an environment for this repo", which
    // shares no phrase with the usage-limit notice; a single pattern would
    // leave the workflow declaring a settled state the gate could not confirm.
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD,
      headArrivedAt: HEAD_ARRIVED,
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
      headArrivedAt: HEAD_ARRIVED,
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
      headArrivedAt: HEAD_ARRIVED,
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
    const evidence = collectExternalReviewEvidence({
      headSha: HEAD, headArrivedAt: HEAD_ARRIVED, policy, reviews: [], comments: [REQUEST]
    });
    expect(evidence).toEqual({ requested_at: null, answered_at: null, unavailable_at: null, head_arrived_at: null });
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
  timeline?: Array<Record<string, unknown>>;
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
              reviewThreads: { nodes: options.threads, pageInfo: { hasNextPage: false } },
              timelineItems: { nodes: options.timeline ?? [] }
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

  it('binds an unavailability notice to the head via the PR timeline', async () => {
    // The force-push event names its after-commit and is stamped when GitHub
    // applied it, so it wins over the same head's committedDate: the latest
    // matching timestamp errs later, which only tightens the gate.
    const client = new GitHubReviewClient({
      token: 'test-token',
      externalReviewPolicy: POLICY,
      fetchFn: githubFixture({
        reviews: [],
        issueComments: [
          { id: 10, user: { login: 'BDelleman' }, body: '@codex review', created_at: '2026-08-24T07:11:27Z' },
          {
            id: 11, user: { login: 'chatgpt-codex-connector[bot]' },
            body: 'You have reached your Codex usage limits for code reviews.',
            created_at: '2026-08-24T07:12:00Z'
          }
        ],
        threads: [],
        timeline: [
          { __typename: 'PullRequestCommit', commit: { oid: HEAD, committedDate: '2026-08-24T07:02:00Z' } },
          { __typename: 'HeadRefForcePushedEvent', createdAt: '2026-08-24T07:10:12Z', afterCommit: { oid: HEAD } }
        ]
      })
    });
    const snapshot = await client.fetchSnapshot('acme/repo', 1, 'symphony-reviewer[bot]');
    expect(snapshot.external_review.head_arrived_at).toBe('2026-08-24T07:10:12Z');
    expect(externalReviewSettled(snapshot.external_review, POLICY)).toBe(true);
  });

  it('falls back to the committed date when the head arrived by plain push', async () => {
    const client = new GitHubReviewClient({
      token: 'test-token',
      externalReviewPolicy: POLICY,
      fetchFn: githubFixture({
        reviews: [],
        issueComments: [
          { id: 10, user: { login: 'BDelleman' }, body: '@codex review', created_at: '2026-08-24T07:11:27Z' },
          {
            id: 11, user: { login: 'chatgpt-codex-connector[bot]' },
            body: 'You have reached your Codex usage limits for code reviews.',
            created_at: '2026-08-24T07:12:00Z'
          }
        ],
        threads: [],
        timeline: [
          { __typename: 'PullRequestCommit', commit: { oid: PREVIOUS_HEAD, committedDate: '2026-08-23T13:40:00Z' } },
          { __typename: 'PullRequestCommit', commit: { oid: HEAD, committedDate: '2026-08-24T07:02:00Z' } }
        ]
      })
    });
    const snapshot = await client.fetchSnapshot('acme/repo', 1, 'symphony-reviewer[bot]');
    expect(snapshot.external_review.head_arrived_at).toBe('2026-08-24T07:02:00Z');
    expect(externalReviewSettled(snapshot.external_review, POLICY)).toBe(true);
  });

  it('fails closed when the head never appears in the timeline', async () => {
    // A head the timeline cannot date is a head the gate cannot verify a
    // request against, so the notice settles nothing — the head-bound review
    // path stays the only way through.
    const client = new GitHubReviewClient({
      token: 'test-token',
      externalReviewPolicy: POLICY,
      fetchFn: githubFixture({
        reviews: [],
        issueComments: [
          { id: 10, user: { login: 'BDelleman' }, body: '@codex review', created_at: '2026-08-24T07:11:27Z' },
          {
            id: 11, user: { login: 'chatgpt-codex-connector[bot]' },
            body: 'You have reached your Codex usage limits for code reviews.',
            created_at: '2026-08-24T07:12:00Z'
          }
        ],
        threads: [],
        timeline: [
          { __typename: 'PullRequestCommit', commit: { oid: PREVIOUS_HEAD, committedDate: '2026-08-23T13:40:00Z' } }
        ]
      })
    });
    const snapshot = await client.fetchSnapshot('acme/repo', 1, 'symphony-reviewer[bot]');
    expect(snapshot.external_review.head_arrived_at).toBeNull();
    expect(externalReviewSettled(snapshot.external_review, POLICY)).toBe(false);
    expect(externalReviewHold(snapshot.external_review, POLICY)).toBe('stale_request');
  });
});
