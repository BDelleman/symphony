import { describe, expect, it } from 'vitest';

import { LinearTrackerAdapter } from '../../src/tracker/linear-adapter';

interface FakeRequest {
  query: string;
  variables: Record<string, unknown>;
}

function makeIssueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'issue-1',
    identifier: 'ABC-1',
    title: 'Test issue',
    description: 'desc',
    priority: 1,
    url: 'https://linear.app/issue/ABC-1',
    branchName: 'feature/abc-1',
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T11:00:00.000Z',
    state: { name: 'Todo' },
    assignee: { id: 'user-1', name: 'Niels', displayName: 'Niels van Galen Last' },
    project: { id: 'project-1', slugId: 'symphony', name: 'Symphony' },
    team: { id: 'team-1', key: 'NIE', name: 'Nielsgl' },
    labels: { nodes: [{ name: 'Backend' }, { name: 'P0' }] },
    inverseRelations: {
      nodes: [
        {
          type: 'blocks',
          issue: {
            id: 'issue-0',
            identifier: 'ABC-0',
            state: { name: 'Done' }
          }
        },
        {
          type: 'relates_to',
          issue: {
            id: 'issue-x',
            identifier: 'ABC-X',
            state: { name: 'Todo' }
          }
        }
      ]
    },
    ...overrides
  };
}

function createAdapterWithQueuedResponses(
  responses: Array<Response | Error>,
  requests: FakeRequest[],
  options: { assignee?: string } = {}
) {
  const fetchFn: typeof fetch = async (_input, init) => {
    if (!init || typeof init.body !== 'string') {
      throw new Error('missing request body');
    }

    requests.push(JSON.parse(init.body) as FakeRequest);

    const next = responses.shift();
    if (!next) {
      throw new Error('unexpected fetch invocation');
    }

    if (next instanceof Error) {
      throw next;
    }

    return next;
  };

  return new LinearTrackerAdapter({
    endpoint: 'https://api.linear.app/graphql',
    apiKey: 'token',
    projectSlug: 'PRJ',
    assignee: options.assignee,
    activeStates: ['Todo', 'In Progress'],
    fetchFn
  });
}

describe('LinearTrackerAdapter', () => {
  it('[SPEC-11.2-1][SPEC-17.3-1] uses project slugId + active-state filter and preserves pagination order', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [makeIssueNode({ id: 'i1', identifier: 'ABC-1' })],
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' }
              }
            }
          }),
          { status: 200 }
        ),
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [makeIssueNode({ id: 'i2', identifier: 'ABC-2' })],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }),
          { status: 200 }
        )
      ],
      requests
    );

    const issues = await adapter.fetch_candidate_issues();

    expect(issues.map((issue) => issue.id)).toEqual(['i1', 'i2']);
    expect(requests).toHaveLength(2);
    expect(requests[0].query).toContain('project: { slugId: { eq: $projectSlug } }');
    expect(requests[0].query).toContain('state: { name: { in: $stateNames } }');
    expect(requests[0].variables).toMatchObject({
      projectSlug: 'PRJ',
      stateNames: ['Todo', 'In Progress'],
      after: null,
      first: 50
    });
    expect(requests[1].variables.after).toBe('cursor-1');
  });

  it('returns empty for fetch_issues_by_states([]) without issuing API calls', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses([], requests);

    const issues = await adapter.fetch_issues_by_states([]);

    expect(issues).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('normalizes blockers, labels, priority and dates per contract', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  makeIssueNode({
                    priority: 2.4,
                    createdAt: 'invalid-date',
                    updatedAt: '2026-03-01T00:00:00.000Z'
                  })
                ],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }),
          { status: 200 }
        )
      ],
      requests
    );

    const [issue] = await adapter.fetch_candidate_issues();

    expect(issue.labels).toEqual(['backend', 'p0']);
    expect(issue.blocked_by).toEqual([
      {
        id: 'issue-0',
        identifier: 'ABC-0',
        state: 'Done'
      }
    ]);
    expect(issue.priority).toBeNull();
    expect(issue.created_at).toBeNull();
    expect(issue.updated_at?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('normalizes GitHub PR attachment URLs as tracker metadata', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  makeIssueNode({
                    attachments: {
                      nodes: [
                        { url: 'https://github.com/nielsgl/symphony/issues/242' },
                        { url: 'https://github.com/nielsgl/symphony/pull/251' },
                        { url: 'https://github.com/nielsgl/symphony/pull/251?notification_referrer_id=abc' },
                        { url: 'https://example.test/not-a-pr' }
                      ]
                    }
                  })
                ],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }),
          { status: 200 }
        )
      ],
      requests
    );

    const [issue] = await adapter.fetch_candidate_issues();

    expect(issue.has_github_issue_link).toBe(true);
    expect(issue.tracker_meta).toEqual({
      tracker_kind: 'linear',
      repository: 'nielsgl/symphony',
      assignee: { id: 'user-1', name: 'Niels' },
      project: { id: 'project-1', slug: 'symphony', name: 'Symphony' },
      team: { id: 'team-1', key: 'NIE', name: 'Nielsgl' },
      pr_links: [
        {
          number: 251,
          url: 'https://github.com/nielsgl/symphony/pull/251',
          state: 'unknown',
          merged: false
        }
      ]
    });
  });

  it('preserves Linear tracker scope metadata when no PR attachment exists', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [makeIssueNode({ attachments: { nodes: [] } })],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }),
          { status: 200 }
        )
      ],
      requests
    );

    const [issue] = await adapter.fetch_candidate_issues();

    expect(issue.tracker_meta).toEqual({
      tracker_kind: 'linear',
      repository: 'unknown',
      pr_links: [],
      assignee: { id: 'user-1', name: 'Niels' },
      project: { id: 'project-1', slug: 'symphony', name: 'Symphony' },
      team: { id: 'team-1', key: 'NIE', name: 'Nielsgl' }
    });
  });

  it('issues state-refresh query with GraphQL [ID!] variable typing', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [makeIssueNode({ id: 'i-refresh', identifier: 'ABC-55', state: { name: 'In Progress' } })]
              }
            }
          }),
          { status: 200 }
        )
      ],
      requests
    );

    const issues = await adapter.fetch_issue_states_by_ids(['i-refresh']);

    expect(issues[0].id).toBe('i-refresh');
    expect(requests[0].query).toContain('query IssuesByIds($issueIds: [ID!]!)');
    expect(requests[0].variables).toEqual({ issueIds: ['i-refresh'] });
  });

  it('reads every Linear comment page for receipt validation', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses([
      new Response(JSON.stringify({ data: { issue: { comments: {
        nodes: [{ id: 'c1', body: 'one', createdAt: null, updatedAt: null }],
        pageInfo: { hasNextPage: true, endCursor: 'next' }
      } } } }), { status: 200 }),
      new Response(JSON.stringify({ data: { issue: { comments: {
        nodes: [{ id: 'c2', body: 'two', createdAt: null, updatedAt: null }],
        pageInfo: { hasNextPage: false, endCursor: null }
      } } } }), { status: 200 })
    ], requests);

    expect((await adapter.fetch_issue_comments('issue-1')).map((comment) => comment.id)).toEqual(['c1', 'c2']);
    expect(requests.map((request) => request.variables.after)).toEqual([null, 'next']);
  });

  it('retries transient state-refresh request/status failures only', async () => {
    const requestRetryRequests: FakeRequest[] = [];
    const requestRetryAdapter = createAdapterWithQueuedResponses(
      [
        new Error('network down'),
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [makeIssueNode({ id: 'i-refresh', identifier: 'ABC-55', state: { name: 'In Progress' } })]
              }
            }
          }),
          { status: 200 }
        )
      ],
      requestRetryRequests
    );
    await expect(requestRetryAdapter.fetch_issue_states_by_ids(['i-refresh'])).resolves.toHaveLength(1);
    expect(requestRetryRequests).toHaveLength(2);

    const statusRetryRequests: FakeRequest[] = [];
    const statusRetryAdapter = createAdapterWithQueuedResponses(
      [
        new Response('temporarily unavailable', { status: 503 }),
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [makeIssueNode({ id: 'i-refresh', identifier: 'ABC-55', state: { name: 'In Progress' } })]
              }
            }
          }),
          { status: 200 }
        )
      ],
      statusRetryRequests
    );
    await expect(statusRetryAdapter.fetch_issue_states_by_ids(['i-refresh'])).resolves.toHaveLength(1);
    expect(statusRetryRequests).toHaveLength(2);

    const graphQlRequests: FakeRequest[] = [];
    const graphQlAdapter = createAdapterWithQueuedResponses(
      [new Response(JSON.stringify({ errors: [{ message: 'bad query' }] }), { status: 200 })],
      graphQlRequests
    );
    await expect(graphQlAdapter.fetch_issue_states_by_ids(['i-refresh'])).rejects.toMatchObject({
      code: 'linear_graphql_errors'
    });
    expect(graphQlRequests).toHaveLength(1);

    const payloadRequests: FakeRequest[] = [];
    const payloadAdapter = createAdapterWithQueuedResponses(
      [new Response(JSON.stringify({ data: { issues: null } }), { status: 200 })],
      payloadRequests
    );
    await expect(payloadAdapter.fetch_issue_states_by_ids(['i-refresh'])).rejects.toMatchObject({
      code: 'linear_unknown_payload'
    });
    expect(payloadRequests).toHaveLength(1);
  });

  it('maps request/status/graphql/payload errors to typed categories', async () => {
    const requestErrAdapter = createAdapterWithQueuedResponses([new Error('network down')], []);
    await expect(requestErrAdapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'linear_api_request'
    });

    const statusErrAdapter = createAdapterWithQueuedResponses([new Response('oops', { status: 502 })], []);
    await expect(statusErrAdapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'linear_api_status'
    });

    const graphqlErrAdapter = createAdapterWithQueuedResponses(
      [new Response(JSON.stringify({ errors: [{ message: 'bad query' }] }), { status: 200 })],
      []
    );
    await expect(graphqlErrAdapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'linear_graphql_errors'
    });

    const payloadErrAdapter = createAdapterWithQueuedResponses(
      [new Response(JSON.stringify({ data: { issues: { pageInfo: { hasNextPage: false } } } }), { status: 200 })],
      []
    );
    await expect(payloadErrAdapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'linear_unknown_payload'
    });
  });

  it('throws linear_missing_end_cursor when pagination marker is incomplete', async () => {
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [makeIssueNode()],
                pageInfo: { hasNextPage: true, endCursor: null }
              }
            }
          }),
          { status: 200 }
        )
      ],
      []
    );

    await expect(adapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'linear_missing_end_cursor'
    });
  });

  it('creates comments via commentCreate mutation', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 })],
      requests
    );

    await expect(adapter.create_comment('issue-1', 'hello')).resolves.toBeUndefined();
    expect(requests[0].query).toContain('mutation CreateComment');
    expect(requests[0].variables).toEqual({ issueId: 'issue-1', body: 'hello' });
  });

  it('updates issue state by resolving state id from team states', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              issue: {
                team: {
                  states: {
                    nodes: [
                      { id: 'state-1', name: 'Todo' },
                      { id: 'state-2', name: 'In Progress' }
                    ]
                  }
                }
              }
            }
          }),
          { status: 200 }
        ),
        new Response(
          JSON.stringify({
            data: {
              issueUpdate: {
                success: true
              }
            }
          }),
          { status: 200 }
        )
      ],
      requests
    );

    await expect(adapter.update_issue_state('issue-1', 'in progress')).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[0].query).toContain('query IssueStateOptions');
    expect(requests[1].query).toContain('mutation UpdateIssueState');
    expect(requests[1].variables).toEqual({ issueId: 'issue-1', stateId: 'state-2' });
  });

  it('throws linear_state_not_found when requested state cannot be resolved', async () => {
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              issue: {
                team: {
                  states: {
                    nodes: [{ id: 'state-1', name: 'Todo' }]
                  }
                }
              }
            }
          }),
          { status: 200 }
        )
      ],
      []
    );

    await expect(adapter.update_issue_state('issue-1', 'Done')).rejects.toMatchObject({
      code: 'linear_state_not_found'
    });
  });

  it('applies assignee filter with explicit assignee id', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [makeIssueNode()],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }),
          { status: 200 }
        )
      ],
      requests,
      { assignee: 'user-123' }
    );

    await adapter.fetch_candidate_issues();

    expect(requests[0].query).toContain('query IssuesByAssignee');
    expect(requests[0].query).toContain('$assigneeId: ID!');
    expect(requests[0].variables).toMatchObject({
      assigneeId: 'user-123'
    });
  });

  it('resolves assignee=me via viewer query before fetching candidates', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              viewer: {
                id: 'viewer-1'
              }
            }
          }),
          { status: 200 }
        ),
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [makeIssueNode()],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }),
          { status: 200 }
        )
      ],
      requests,
      { assignee: 'me' }
    );

    await adapter.fetch_candidate_issues();

    expect(requests).toHaveLength(2);
    expect(requests[0].query).toContain('query Viewer');
    expect(requests[1].query).toContain('query IssuesByAssignee');
    expect(requests[1].variables).toMatchObject({
      assigneeId: 'viewer-1'
    });
  });
});
