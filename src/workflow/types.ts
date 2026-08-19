export type WorkflowErrorCode =
  | 'missing_workflow_file'
  | 'workflow_parse_error'
  | 'workflow_front_matter_not_a_map'
  | 'template_parse_error'
  | 'template_render_error';

export type ValidationErrorCode =
  | 'missing_tracker_kind'
  | 'unsupported_tracker_kind'
  | 'missing_tracker_api_key'
  | 'missing_tracker_project_slug'
  | 'missing_tracker_owner'
  | 'missing_tracker_repo'
  | 'invalid_tracker_active_states_for_github'
  | 'invalid_tracker_github_linking_mode'
  | 'invalid_tracker_handoff_states'
  | 'invalid_tracker_fresh_dispatch_states'
  | 'missing_codex_command'
  | 'invalid_codex_reasoning_effort'
  | 'invalid_codex_extra_flags'
  | 'invalid_codex_approval_policy'
  | 'invalid_codex_approval_policy_shape'
  | 'invalid_codex_thread_sandbox'
  | 'invalid_codex_turn_sandbox_policy'
  | 'invalid_codex_user_input_policy'
  | 'invalid_polling_interval_ms'
  | 'invalid_hooks_timeout_ms'
  | 'invalid_agent_max_concurrent_agents'
  | 'invalid_agent_max_turns'
  | 'invalid_agent_runtime'
  | 'invalid_claude_command'
  | 'invalid_claude_model'
  | 'invalid_claude_network_allowed_domains'
  | 'invalid_claude_allowed_mcp_servers'
  | 'invalid_agent_max_retry_backoff_ms'
  | 'invalid_agent_respawn_window_minutes'
  | 'invalid_agent_respawn_max_attempts_without_progress'
  | 'invalid_agent_dispatch_backpressure'
  | 'invalid_budget_per_run_total_tokens'
  | 'invalid_budget_per_issue_rolling_tokens'
  | 'invalid_budget_rolling_window_minutes'
  | 'invalid_budget_warning_threshold_ratio'
  | 'invalid_budget_hard_limit_policy'
  | 'invalid_agent_max_concurrent_agents_by_state'
  | 'invalid_codex_turn_timeout_ms'
  | 'invalid_codex_read_timeout_ms'
  | 'invalid_codex_stall_timeout_ms'
  | 'invalid_codex_running_wait_stall_threshold_ms'
  | 'invalid_codex_progress_heartbeat_only_warn_ms'
  | 'invalid_codex_progress_stalled_waiting_ms'
  | 'invalid_codex_worker_opaque_activity_hard_timeout_ms'
  | 'invalid_worker_max_concurrent_agents_per_host'
  | 'invalid_server_host'
  | 'invalid_workspace_provisioner_type'
  | 'invalid_workspace_provisioner_repo_root'
  | 'invalid_workspace_provisioner_branch_template'
  | 'invalid_workspace_provisioner_teardown_mode'
  | 'invalid_worktree_sandbox_policy'
  | 'invalid_workspace_copy_ignored_include_file'
  | 'invalid_workspace_copy_ignored_from'
  | 'invalid_workspace_copy_ignored_conflict_policy'
  | 'invalid_workspace_copy_ignored_limits'
  | 'invalid_runtime_update_github_eligibility_mode'
  | 'invalid_logging_root'
  | 'invalid_logging_max_bytes'
  | 'invalid_logging_max_files'
  | 'invalid_validation_ui_evidence_profile'
  | 'invalid_generated_profile_provenance';

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  api_key: string;
  project_slug: string;
  assignee?: string;
  owner?: string;
  repo?: string;
  github_linking?: {
    mode: 'off' | 'warn' | 'required' | string;
  };
  active_states: string[];
  terminal_states: string[];
  handoff_states: string[];
  fresh_dispatch_states: string[];
}

export interface HooksConfig {
  after_create?: string;
  before_run?: string;
  after_run?: string;
  before_remove?: string;
  timeout_ms: number;
}

export interface AgentConfig {
  max_concurrent_agents: number;
  max_retry_backoff_ms: number;
  respawn_window_minutes?: number;
  respawn_max_attempts_without_progress?: number;
  max_turns: number;
  max_concurrent_agents_by_state: Record<string, number>;
  dispatch_backpressure?: {
    enabled: boolean;
    retry_delay_ms: number;
    min_running_agents: number;
    control_plane_health: 'slow' | 'large' | 'degraded';
    control_plane_stale_after_ms: number;
    host_load_per_cpu?: number | null;
  };
}

export interface AgentRuntimeConfig {
  selected: 'codex' | 'claude-cli';
  claude_command: string;
  claude_model: string | null;
  claude_allow_non_subscription_auth: boolean;
  claude_network_allowed_domains: string[];
  claude_allowed_mcp_servers: string[];
  claude_supported_version: '2.1.224';
}

export type BudgetHardLimitPolicy = 'block_requires_resume' | 'terminate_attempt';

export interface BudgetConfig {
  per_run_total_tokens?: number;
  per_issue_rolling_tokens?: number;
  rolling_window_minutes: number;
  warning_threshold_ratio: number;
  hard_limit_policy: BudgetHardLimitPolicy;
}

export interface CodexConfig {
  command: string;
  command_source?: 'workflow' | 'default';
  home?: string;
  model?: string;
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh';
  extra_flags?: string[];
  effective_codex_home?: string;
  effective_codex_model?: string | null;
  effective_reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | null;
  effective_extra_flags?: string[];
  effective_extra_flags_count?: number;
  codex_resolution_mode?: 'typed' | 'legacy' | 'mixed';
  security_profile?: string;
  approval_policy?:
    | string
    | {
        reject?: {
          sandbox_approval?: boolean;
          rules?: boolean;
          mcp_elicitations?: boolean;
        };
      };
  thread_sandbox?: string;
  turn_sandbox_policy?: string;
  user_input_policy?: string;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
  running_wait_stall_threshold_ms?: number;
  progress_heartbeat_only_warn_ms?: number;
  progress_stalled_waiting_ms?: number;
  worker_opaque_activity_hard_timeout_ms?: number;
}

export interface PersistenceConfig {
  enabled: boolean;
  db_path: string;
  db_path_source: 'workflow' | 'default';
  retention_days: number;
}

export interface WorkerConfig {
  ssh_hosts?: string[];
  max_concurrent_agents_per_host?: number;
}

export interface LoggingConfig {
  root: string;
  root_source: 'workflow' | 'default';
  max_bytes: number;
  max_files: number;
}

export interface EffectiveConfig {
  tracker: TrackerConfig;
  polling: { interval_ms: number };
  workspace: {
    root: string;
    root_source: 'workflow' | 'default';
    provisioner: {
      type: 'worktree' | 'clone' | 'none' | string;
      repo_root?: string;
      base_ref: string;
      branch_template: string;
      teardown_mode: 'remove_worktree' | 'keep' | string;
      allow_dirty_repo: boolean;
      fallback_to_clone_on_worktree_failure: boolean;
    };
    copy_ignored: {
      enabled: boolean;
      include_file: string;
      from: 'primary_worktree' | 'repo_root' | string;
      conflict_policy: 'skip' | 'overwrite' | 'fail' | string;
      require_gitignored: boolean;
      max_files: number;
      max_total_bytes: number;
      allow_patterns: string[];
      deny_patterns: string[];
    };
  };
  hooks: HooksConfig;
  agent: AgentConfig;
  agent_runtime?: AgentRuntimeConfig;
  budget?: BudgetConfig;
  codex: CodexConfig;
  persistence: PersistenceConfig;
  observability?: {
    dashboard_enabled: boolean;
    refresh_ms: number;
    render_interval_ms: number;
    phase_markers_enabled?: boolean;
    phase_timeline_limit?: number;
    phase_stale_warn_ms?: number;
  };
  validation?: {
    ui_evidence_profile: 'baseline' | 'strict' | string;
  };
  runtime_update?: {
    github_eligibility: {
      mode: 'required' | 'allow_absent_checks' | 'trust_raw_git' | string;
    };
  };
  logging: LoggingConfig;
  worker?: WorkerConfig;
  server?: { port: number; host?: string };
}

export type ValidationResult =
  | { ok: true; at: string }
  | {
      ok: false;
      error_code: WorkflowErrorCode | ValidationErrorCode;
      message: string;
      at: string;
    };

export interface DispatchPreflightOutcome {
  dispatch_allowed: boolean;
  reconciliation_allowed: true;
  validation: ValidationResult;
}

export interface ReloadStatus {
  ok: boolean;
  at: string;
  source: 'startup' | 'watch' | 'preflight';
  error_code?: WorkflowErrorCode | ValidationErrorCode;
  message?: string;
}

export interface EffectiveConfigSnapshot {
  workflowDefinition: WorkflowDefinition;
  effectiveConfig: EffectiveConfig;
  promptTemplate: string;
  versionHash: string;
  lastReloadStatus: ReloadStatus;
}

export interface WorkflowEvent {
  event: string;
  at: string;
  source: 'startup' | 'watch' | 'preflight';
  version_hash?: string;
  error_code?: WorkflowErrorCode | ValidationErrorCode;
  message?: string;
}
