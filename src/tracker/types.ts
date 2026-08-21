export interface IssueBlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface IssuePullRequestLink {
  number: number;
  url: string;
  state: string;
  merged: boolean;
}

export interface IssueTrackerMeta {
  tracker_kind: 'github' | 'linear';
  repository: string;
  pr_links: IssuePullRequestLink[];
  assignee?: { id: string | null; name: string | null } | null;
  project?: { id: string | null; slug: string | null; name: string | null } | null;
  team?: { id: string | null; key: string | null; name: string | null } | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: IssueBlockerRef[];
  tracker_meta?: IssueTrackerMeta;
  has_github_issue_link?: boolean;
  created_at: Date | null;
  updated_at: Date | null;
  version?: number | null;
}

export interface TrackerComment {
  id: string;
  body: string;
  created_at: Date | null;
  updated_at: Date | null;
}

export interface TrackerAdapter {
  fetch_candidate_issues(): Promise<Issue[]>;
  fetch_issues_by_states(state_names: string[]): Promise<Issue[]>;
  fetch_issue_states_by_ids(issue_ids: string[]): Promise<Issue[]>;
  fetch_issue_comments?(issue_id: string): Promise<TrackerComment[]>;
  create_comment(issue_id: string, body: string): Promise<void>;
  update_issue_state(issue_id: string, state_name: string): Promise<void>;
}

export type TrackerErrorCode =
  | 'unsupported_tracker_kind'
  | 'missing_tracker_api_key'
  | 'missing_tracker_project_slug'
  | 'missing_tracker_owner'
  | 'missing_tracker_repo'
  | 'linear_api_request'
  | 'linear_api_status'
  | 'linear_graphql_errors'
  | 'linear_unknown_payload'
  | 'linear_missing_end_cursor'
  | 'linear_state_not_found'
  | 'github_api_request'
  | 'github_api_status'
  | 'github_graphql_errors'
  | 'github_unknown_payload'
  | 'github_missing_end_cursor'
  | 'github_invalid_state_filter'
  | 'github_invalid_state_transition';

export interface TrackerRuntimeConfig {
  kind: string;
  endpoint: string;
  api_key: string;
  project_slug: string;
  assignee?: string;
  owner?: string;
  repo?: string;
  active_states: string[];
  page_size?: number;
  timeout_ms?: number;
}
