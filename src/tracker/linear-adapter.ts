import { TrackerAdapterError } from './errors';
import type { Issue, IssueBlockerRef, IssuePullRequestLink, TrackerAdapter, TrackerComment } from './types';

interface LinearAdapterOptions {
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  assignee?: string;
  activeStates: string[];
  pageSize?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface GraphqlSuccess {
  data: unknown;
  errors?: Array<{ message?: string }>;
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 30000;
const ISSUE_STATE_REFRESH_RETRY_DELAYS_MS = [100, 500];

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parsePriority(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableIssueStateRefreshError(error: unknown): boolean {
  if (!(error instanceof TrackerAdapterError)) {
    return false;
  }

  if (error.code === 'linear_api_request') {
    return true;
  }

  if (error.code !== 'linear_api_status') {
    return false;
  }

  const status = error.message.match(/status (\d+)/)?.[1];
  if (!status) {
    return false;
  }
  const statusCode = Number(status);
  return statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504;
}

function readNodes(value: unknown): Record<string, unknown>[] {
  const objectValue = readObject(value);
  if (!objectValue) {
    return [];
  }

  const nodes = objectValue.nodes;
  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes.map((entry) => readObject(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function normalizeLabels(rawIssue: Record<string, unknown>): string[] {
  const labels = readNodes(rawIssue.labels);
  return labels
    .map((label) => readString(label.name).toLowerCase())
    .filter((name) => Boolean(name));
}

function normalizeBlockers(rawIssue: Record<string, unknown>): IssueBlockerRef[] {
  const inverseRelations = readNodes(rawIssue.inverseRelations);
  return inverseRelations
    .filter((relation) => readString(relation.type).toLowerCase() === 'blocks')
    .map((relation) => {
      const issue = readObject(relation.issue);
      const issueState = issue ? readObject(issue.state) : null;

      return {
        id: issue ? readNullableString(issue.id) : null,
        identifier: issue ? readNullableString(issue.identifier) : null,
        state: issueState ? readNullableString(issueState.name) : null
      };
    });
}

function parseGithubPullRequestUrl(url: string): { repository: string; number: number } | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (!match) {
    return null;
  }

  const number = Number(match[3]);
  if (!Number.isInteger(number)) {
    return null;
  }

  return {
    repository: `${match[1]}/${match[2]}`,
    number
  };
}

function normalizePullRequestLinks(attachments: Record<string, unknown>[]): {
  repository: string;
  pr_links: IssuePullRequestLink[];
} | null {
  const links: IssuePullRequestLink[] = [];
  let repository: string | null = null;
  const seen = new Set<string>();

  for (const attachment of attachments) {
    const url = readString(attachment.url).trim();
    const parsed = parseGithubPullRequestUrl(url);
    if (!parsed) {
      continue;
    }

    const key = `${parsed.repository}#${parsed.number}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    repository ??= parsed.repository;
    links.push({
      number: parsed.number,
      url,
      state: 'unknown',
      merged: false
    });
  }

  if (!repository || links.length === 0) {
    return null;
  }

  return {
    repository,
    pr_links: links
  };
}

function normalizeIssue(rawIssue: Record<string, unknown>): Issue {
  const state = readObject(rawIssue.state);
  const assignee = readObject(rawIssue.assignee);
  const project = readObject(rawIssue.project);
  const team = readObject(rawIssue.team);
  const attachments = readNodes(rawIssue.attachments);
  const hasGithubIssueLink = attachments.some((attachment) => {
    const url = readString(attachment.url).trim();
    return /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+(?:[/?#].*)?$/i.test(url);
  });
  const prLinks = normalizePullRequestLinks(attachments);

  return {
    id: readString(rawIssue.id),
    identifier: readString(rawIssue.identifier),
    title: readString(rawIssue.title),
    description: readNullableString(rawIssue.description),
    priority: parsePriority(rawIssue.priority),
    state: readString(state?.name),
    branch_name: readNullableString(rawIssue.branchName),
    url: readNullableString(rawIssue.url),
    labels: normalizeLabels(rawIssue),
    blocked_by: normalizeBlockers(rawIssue),
    tracker_meta: {
      tracker_kind: 'linear',
      repository: prLinks?.repository ?? 'unknown',
      pr_links: prLinks?.pr_links ?? [],
      assignee: assignee
        ? {
            id: readNullableString(assignee.id),
            name: readNullableString(assignee.name) ?? readNullableString(assignee.displayName)
          }
        : null,
      project: project
        ? {
            id: readNullableString(project.id),
            slug: readNullableString(project.slugId) ?? readNullableString(project.slug),
            name: readNullableString(project.name)
          }
        : null,
      team: team
        ? {
            id: readNullableString(team.id),
            key: readNullableString(team.key),
            name: readNullableString(team.name)
          }
        : null
    },
    has_github_issue_link: hasGithubIssueLink,
    created_at: parseIsoDate(rawIssue.createdAt),
    updated_at: parseIsoDate(rawIssue.updatedAt),
    version: typeof rawIssue.version === 'number' && Number.isInteger(rawIssue.version) ? rawIssue.version : null
  };
}

function isMinimalStateIssue(issue: Issue): boolean {
  return Boolean(issue.id && issue.identifier && issue.state);
}

export function buildIssuesQuery(): string {
  return `
query Issues($projectSlug: String!, $stateNames: [String!], $after: String, $first: Int!) {
  issues(
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $stateNames } }
    }
    after: $after
    first: $first
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      url
      branchName
      createdAt
      updatedAt
      state {
        name
      }
      assignee {
        id
        name
        displayName
      }
      project {
        id
        slugId
        name
      }
      team {
        id
        key
        name
      }
      labels {
        nodes {
          name
        }
      }
      inverseRelations {
        nodes {
          type
          issue {
            id
            identifier
            state {
              name
            }
          }
        }
      }
      attachments {
        nodes {
          url
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;
}

export function buildIssuesByAssigneeQuery(): string {
  return `
query IssuesByAssignee($projectSlug: String!, $stateNames: [String!], $assigneeId: String!, $after: String, $first: Int!) {
  issues(
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $stateNames } }
      assignee: { id: { eq: $assigneeId } }
    }
    after: $after
    first: $first
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      url
      branchName
      createdAt
      updatedAt
      state {
        name
      }
      assignee {
        id
        name
        displayName
      }
      project {
        id
        slugId
        name
      }
      team {
        id
        key
        name
      }
      labels {
        nodes {
          name
        }
      }
      inverseRelations {
        nodes {
          type
          issue {
            id
            identifier
            state {
              name
            }
          }
        }
      }
      attachments {
        nodes {
          url
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;
}

export function buildIssueStatesByIdsQuery(): string {
  return `
query IssuesByIds($issueIds: [ID!]!) {
  issues(filter: { id: { in: $issueIds } }) {
    nodes {
      id
      identifier
      title
      description
      priority
      url
      branchName
      createdAt
      updatedAt
      state {
        name
      }
      assignee {
        id
        name
        displayName
      }
      project {
        id
        slugId
        name
      }
      team {
        id
        key
        name
      }
      labels {
        nodes {
          name
        }
      }
      inverseRelations {
        nodes {
          type
          issue {
            id
            identifier
            state {
              name
            }
          }
        }
      }
      attachments {
        nodes {
          url
        }
      }
    }
  }
}`;
}

export function buildCreateCommentMutation(): string {
  return `
mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
  }
}`;
}

export function buildIssueCommentsQuery(): string {
  return `
query IssueComments($issueId: String!, $after: String) {
  issue(id: $issueId) {
    comments(first: 100, after: $after) {
      nodes {
        id
        body
        createdAt
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
}

export function buildIssueStateOptionsQuery(): string {
  return `
query IssueStateOptions($issueId: String!) {
  issue(id: $issueId) {
    team {
      states {
        nodes {
          id
          name
        }
      }
    }
  }
}`;
}

export function buildViewerQuery(): string {
  return `
query Viewer {
  viewer {
    id
  }
}`;
}

export function buildUpdateIssueStateMutation(): string {
  return `
mutation UpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
  }
}`;
}

export class LinearTrackerAdapter implements TrackerAdapter {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly projectSlug: string;
  private readonly assignee: string | null;
  private readonly activeStates: string[];
  private readonly pageSize: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private assigneeIdCache: string | null;

  constructor(options: LinearAdapterOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.projectSlug = options.projectSlug;
    this.assignee = options.assignee?.trim() ? options.assignee.trim() : null;
    this.activeStates = [...options.activeStates];
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
    this.assigneeIdCache = null;
  }

  async fetch_candidate_issues(): Promise<Issue[]> {
    return this.fetchIssuesByStateFilter(this.activeStates);
  }

  async fetch_issues_by_states(state_names: string[]): Promise<Issue[]> {
    if (state_names.length === 0) {
      return [];
    }

    return this.fetchIssuesByStateFilter(state_names);
  }

  async fetch_issue_states_by_ids(issue_ids: string[]): Promise<Issue[]> {
    if (issue_ids.length === 0) {
      return [];
    }

    const payload = await this.graphqlRequestWithTransientRetry(buildIssueStatesByIdsQuery(), { issueIds: issue_ids });
    const nodes = this.extractIssueNodes(payload);
    return nodes.map(normalizeIssue).filter(isMinimalStateIssue);
  }

  async create_comment(issue_id: string, body: string): Promise<void> {
    const payload = await this.graphqlRequest(buildCreateCommentMutation(), {
      issueId: issue_id,
      body
    });
    const data = readObject(payload.data);
    const commentCreate = data ? readObject(data.commentCreate) : null;
    if (!commentCreate || !readBoolean(commentCreate.success)) {
      throw new TrackerAdapterError('linear_unknown_payload', 'Linear payload missing data.commentCreate.success');
    }
  }

  async fetch_issue_comments(issue_id: string): Promise<TrackerComment[]> {
    const output: TrackerComment[] = [];
    let after: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const payload = await this.graphqlRequest(buildIssueCommentsQuery(), { issueId: issue_id, after });
      const data = readObject(payload.data);
      const issue = data ? readObject(data.issue) : null;
      const connection = issue ? readObject(issue.comments) : null;
      const comments = connection ? readNodes(connection) : [];
      output.push(...comments.map((comment) => ({
        id: readString(comment.id),
        body: readString(comment.body),
        created_at: parseIsoDate(comment.createdAt),
        updated_at: parseIsoDate(comment.updatedAt)
      })));
      const pageInfo = connection ? readObject(connection.pageInfo) : null;
      if (pageInfo?.hasNextPage !== true) return output;
      after = readString(pageInfo.endCursor) || null;
      if (!after) throw new TrackerAdapterError('linear_missing_end_cursor', 'Linear comments pagination cursor is missing');
    }
    throw new TrackerAdapterError('linear_unknown_payload', 'Linear comments pagination exceeded the supported limit');
  }

  async update_issue_state(issue_id: string, state_name: string): Promise<void> {
    const stateId = await this.resolveStateId(issue_id, state_name);
    const payload = await this.graphqlRequest(buildUpdateIssueStateMutation(), {
      issueId: issue_id,
      stateId
    });
    const data = readObject(payload.data);
    const issueUpdate = data ? readObject(data.issueUpdate) : null;
    if (!issueUpdate || !readBoolean(issueUpdate.success)) {
      throw new TrackerAdapterError('linear_unknown_payload', 'Linear payload missing data.issueUpdate.success');
    }
  }

  private async fetchIssuesByStateFilter(stateNames: string[]): Promise<Issue[]> {
    const issues: Issue[] = [];
    let cursor: string | null = null;
    const assigneeId = await this.resolveAssigneeId();
    const query = assigneeId ? buildIssuesByAssigneeQuery() : buildIssuesQuery();

    while (true) {
      const payload = await this.graphqlRequest(query, {
        projectSlug: this.projectSlug,
        stateNames,
        ...(assigneeId ? { assigneeId } : {}),
        after: cursor,
        first: this.pageSize
      });

      const issuesObj = this.extractIssuesObject(payload);
      const nodes = this.extractIssueNodesFromIssuesObject(issuesObj);

      for (const node of nodes) {
        const normalized = normalizeIssue(node);
        if (isMinimalStateIssue(normalized)) {
          issues.push(normalized);
        }
      }

      const pageInfo = readObject(issuesObj.pageInfo);
      const hasNextPage = Boolean(pageInfo?.hasNextPage);
      if (!hasNextPage) {
        break;
      }

      const endCursor = readNullableString(pageInfo?.endCursor);
      if (!endCursor) {
        throw new TrackerAdapterError(
          'linear_missing_end_cursor',
          'Linear payload indicated next page but pageInfo.endCursor is missing'
        );
      }

      cursor = endCursor;
    }

    return issues;
  }

  private async graphqlRequest(query: string, variables: Record<string, unknown>): Promise<GraphqlSuccess> {
    let response: Response;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);

    try {
      response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.apiKey
        },
        body: JSON.stringify({ query, variables }),
        signal: abortController.signal
      });
    } catch (error) {
      throw new TrackerAdapterError('linear_api_request', `Linear request failed: ${String(error)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new TrackerAdapterError('linear_api_status', `Linear API returned status ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new TrackerAdapterError('linear_unknown_payload', `Linear payload is not valid JSON: ${String(error)}`);
    }

    const objectPayload = readObject(payload);
    if (!objectPayload) {
      throw new TrackerAdapterError('linear_unknown_payload', 'Linear payload is not an object');
    }

    const errors = Array.isArray(objectPayload.errors) ? objectPayload.errors : [];
    if (errors.length > 0) {
      throw new TrackerAdapterError('linear_graphql_errors', 'Linear GraphQL response contains errors');
    }

    if (!Object.prototype.hasOwnProperty.call(objectPayload, 'data')) {
      throw new TrackerAdapterError('linear_unknown_payload', 'Linear payload missing data');
    }

    return objectPayload as unknown as GraphqlSuccess;
  }

  private async graphqlRequestWithTransientRetry(
    query: string,
    variables: Record<string, unknown>
  ): Promise<GraphqlSuccess> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= ISSUE_STATE_REFRESH_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await this.graphqlRequest(query, variables);
      } catch (error) {
        lastError = error;
        if (!isRetryableIssueStateRefreshError(error) || attempt >= ISSUE_STATE_REFRESH_RETRY_DELAYS_MS.length) {
          throw error;
        }
        await sleep(ISSUE_STATE_REFRESH_RETRY_DELAYS_MS[attempt]);
      }
    }
    throw lastError;
  }

  private async resolveStateId(issueId: string, stateName: string): Promise<string> {
    const payload = await this.graphqlRequest(buildIssueStateOptionsQuery(), { issueId });
    const data = readObject(payload.data);
    const issue = data ? readObject(data.issue) : null;
    const team = issue ? readObject(issue.team) : null;
    const states = team ? readObject(team.states) : null;
    const nodes = states ? readNodes(states) : [];
    const normalizedName = stateName.trim().toLowerCase();
    const matchedState = nodes.find((node) => readString(node.name).trim().toLowerCase() === normalizedName);
    const stateId = matchedState ? readString(matchedState.id, '') : '';
    if (!stateId) {
      throw new TrackerAdapterError(
        'linear_state_not_found',
        `Linear state '${stateName}' was not found for issue ${issueId}`
      );
    }
    return stateId;
  }

  private async resolveAssigneeId(): Promise<string | null> {
    if (!this.assignee) {
      return null;
    }

    if (this.assignee.toLowerCase() !== 'me' && this.assignee.toLowerCase() !== 'viewer') {
      return this.assignee;
    }

    if (this.assigneeIdCache) {
      return this.assigneeIdCache;
    }

    const payload = await this.graphqlRequest(buildViewerQuery(), {});
    const data = readObject(payload.data);
    const viewer = data ? readObject(data.viewer) : null;
    const viewerId = viewer ? readString(viewer.id, '') : '';
    if (!viewerId) {
      throw new TrackerAdapterError('linear_unknown_payload', 'Linear payload missing data.viewer.id');
    }
    this.assigneeIdCache = viewerId;
    return viewerId;
  }

  private extractIssuesObject(payload: GraphqlSuccess): Record<string, unknown> {
    const data = readObject(payload.data);
    const issues = data ? readObject(data.issues) : null;

    if (!issues) {
      throw new TrackerAdapterError('linear_unknown_payload', 'Linear payload missing data.issues');
    }

    return issues;
  }

  private extractIssueNodes(payload: GraphqlSuccess): Record<string, unknown>[] {
    const issuesObj = this.extractIssuesObject(payload);
    return this.extractIssueNodesFromIssuesObject(issuesObj);
  }

  private extractIssueNodesFromIssuesObject(issuesObj: Record<string, unknown>): Record<string, unknown>[] {
    if (!Array.isArray(issuesObj.nodes)) {
      throw new TrackerAdapterError('linear_unknown_payload', 'Linear payload missing issues.nodes array');
    }

    return issuesObj.nodes
      .map((node) => readObject(node))
      .filter((node): node is Record<string, unknown> => Boolean(node));
  }
}
