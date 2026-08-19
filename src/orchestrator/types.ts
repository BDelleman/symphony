import type { Issue, TrackerAdapter } from '../tracker';
import type { CodexAppServerThreadActivitySource } from '../codex/app-server-protocol';
import type {
  CodexModelRerouteEvidence,
  CodexProtocolWarningEvidence,
  CodexUsageTotals,
  TokenTelemetryStatus
} from '../codex';
import type { StructuredLogger } from '../observability';
import { REASON_CODES } from '../observability/reason-codes';
import type { PhaseMarker, PhaseMarkerName } from '../observability';
import type { ExecutionGraphEntityStatus, HistoryPayloadClass, PersistenceHealth, RunTerminalStatus } from '../persistence';
import type { ControlPlaneHealthSummary, ControlPlaneHealthState } from '../api/control-plane-health';

export type TickReason = 'startup' | 'interval' | 'manual_refresh' | 'retry_timer';
export type WorkerExitReason = 'normal' | 'abnormal';
export type WorkerCompletionReason =
  | typeof REASON_CODES.maxTurnsReached
  | typeof REASON_CODES.issueStateMissing
  | typeof REASON_CODES.issueStateRefreshFailed
  | typeof REASON_CODES.handoffStateReached
  | typeof REASON_CODES.freshDispatchStateRouted
  | typeof REASON_CODES.issueLeftActiveStates
  | typeof REASON_CODES.terminalStateReached;
export interface WorkerExitDetails {
  retryable?: boolean;
  completion_reason?: WorkerCompletionReason;
  refreshed_state?: string | null;
  worker_handle?: unknown;
  worker_instance_id?: string | null;
  codex_app_server_pid?: string | number | null;
  worker_process_pid?: string | number | null;
  thread_id?: string | null;
  turn_id?: string | null;
  session_id?: string | null;
}
export interface RunningEntryTermination {
  state: 'requested' | 'exit_observed' | 'finalizing' | 'failed';
  reason: string;
  cleanup_workspace: boolean;
  requested_at_ms: number;
  exit_observed_at_ms?: number;
  failure_at_ms?: number;
  failure_detail?: string;
  worker_handle?: unknown;
  worker_instance_id?: string | null;
  codex_app_server_pid?: string | null;
  worker_process_pid?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  session_id?: string | null;
}
export interface ReleasedWorkerRecord {
  released_at_ms: number;
  reason: string;
  cleanup_workspace: boolean;
  worker_instance_id?: string | null;
  codex_app_server_pid?: string | null;
  worker_process_pid?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  session_id?: string | null;
}
export type RetryDelayType = 'continuation' | 'failure' | 'backpressure';
export type BudgetHardLimitPolicy = 'block_requires_resume' | 'terminate_attempt';
export type BudgetStatus = 'ok' | 'warning' | 'hard_limited' | 'telemetry_unavailable';
export type QuarantinedWorkerEventReason =
  | 'lineage_mismatch'
  | 'worker_identity_mismatch'
  | 'inactive_worker_pid'
  | 'terminal_residue';

export interface BudgetRuntimeProjection {
  budget_usage_tokens: number | null;
  budget_limit_tokens: number | null;
  budget_window_minutes: number;
  budget_status: BudgetStatus;
  budget_policy: BudgetHardLimitPolicy | null;
  budget_message?: string | null;
}

export interface RunningEntry {
  issue: Issue;
  identifier: string;
  started_issue_state?: string;
  run_id: string | null;
  issue_run_id?: string | null;
  attempt_id?: string | null;
  worker_handle: unknown;
  worker_instance_id?: string | null;
  monitor_handle: unknown;
  retry_attempt: number;
  workspace_path: string | null;
  worker_host?: string | null;
  provisioner_type: string | null;
  branch_name: string | null;
  repo_root: string | null;
  workspace_exists: boolean;
  workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
  workspace_provisioned: boolean;
  workspace_is_git_worktree: boolean;
  copy_ignored_applied?: boolean;
  copy_ignored_status?: 'skipped' | 'success' | 'failed' | null;
  copy_ignored_summary?:
    | {
        copied_files: number;
        skipped_existing: number;
        blocked_files: number;
        bytes_copied: number;
        duration_ms: number;
      }
    | null;
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  persisted_thread_id?: string | null;
  persisted_thread_evidence_id?: string | null;
  persisted_turn_ids?: string[];
  pending_persisted_turn_ids?: string[];
  execution_graph_turn_indices?: Record<string, number>;
  pending_execution_graph_thread_started_at?: string | null;
  pending_execution_graph_turn?: {
    turn_id: string;
    turn_index: number;
    started_at: string;
  } | null;
  history_terminalizing?: boolean;
  codex_app_server_pid: string | null;
  agent_runtime?: 'codex-app-server' | 'claude-cli' | null;
  worker_process_pid?: string | null;
  provider_usage?: import('../agent').ProviderUsage | null;
  last_process_liveness_at_ms?: number | null;
  turn_count: number;
  last_event: string | null;
  last_event_summary: string | null;
  last_message: string | null;
  awaiting_input_since_ms?: number | null;
  pending_input_preview?: {
    type: string;
    prompt_preview: string | null;
    option_count: number | null;
  } | null;
  stalled_waiting_since_ms?: number | null;
  stalled_waiting_reason?: typeof REASON_CODES.turnWaitingThresholdExceeded | null;
  running_waiting_started_at_ms?: number | null;
  last_progress_transition_at_ms?: number | null;
  last_heartbeat_at_ms?: number | null;
  heartbeat_only_event_emitted?: boolean;
  running_wait_stall_event_emitted?: boolean;
  tokens: CodexUsageTotals;
  last_reported_tokens: CodexUsageTotals;
  token_telemetry_status: TokenTelemetryStatus;
  token_telemetry_last_source: string | null;
  token_telemetry_last_at_ms: number | null;
  token_telemetry_turn_started_at_ms: number | null;
  token_telemetry_warning_emitted: boolean;
  budget_warning_emitted?: boolean;
  budget_hard_limit_enforced?: boolean;
  budget?: BudgetRuntimeProjection;
  progress_signals?: ProgressSignals;
  recent_events: Array<{
    at_ms: number;
    event: string;
    message: string | null;
    reason_code?: string | null;
    request_method?: string | null;
    request_category?: string | null;
    tool_call_id?: string | null;
    tool_name?: string | null;
    protocol_warning?: CodexProtocolWarningEvidence;
    model_reroute?: CodexModelRerouteEvidence | null;
    requested_model?: string | null;
    effective_model?: string | null;
  }>;
  quarantined_events?: Array<{
    at_ms: number;
    event: string;
    message: string | null;
    codex_app_server_pid: string | null;
    worker_process_pid?: string | null;
    session_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
    active_codex_app_server_pid: string | null;
    active_worker_process_pid?: string | null;
    worker_instance_id?: string | null;
    active_worker_instance_id?: string | null;
    run_id?: string | null;
    issue_run_id?: string | null;
    attempt_id?: string | null;
    active_run_id?: string | null;
    active_issue_run_id?: string | null;
    active_attempt_id?: string | null;
    active_session_id: string | null;
    active_thread_id: string | null;
    active_turn_id: string | null;
    reason: QuarantinedWorkerEventReason;
  }>;
  quarantined_event_count?: number;
  last_quarantined_event_at_ms?: number | null;
  ownership_conflict?: {
    reason: 'pre_session_identity_conflict' | 'ownership_conflict';
    detected_at_ms: number;
    event: string;
    event_codex_app_server_pid: string | null;
    active_codex_app_server_pid: string | null;
    event_worker_instance_id: string | null;
    active_worker_instance_id: string | null;
    event_thread_id: string | null;
    event_turn_id: string | null;
    event_session_id: string | null;
  } | null;
  started_at_ms: number;
  last_codex_timestamp_ms: number | null;
  codex_thread_activity_at_ms?: number | null;
  codex_thread_activity_source?: CodexAppServerThreadActivitySource | null;
  codex_thread_activity_status?: string | null;
  rate_limits?: Record<string, unknown> | null;
  protocol_warnings?: CodexProtocolWarningEvidence[];
  model_reroute?: CodexModelRerouteEvidence | null;
  requested_model?: string | null;
  effective_model?: string | null;
  current_phase?: PhaseMarkerName | null;
  current_phase_at_ms?: number | null;
  phase_detail?: string | null;
  tool_call_ledger?: Record<string, ToolCallLedgerEntry>;
  outstanding_tool_calls?: Record<string, OutstandingToolCall>;
  transcript_tool_call_diagnostics?: TranscriptToolCallDiagnostic[];
  transcript_tool_call_diagnostic_stats?: TranscriptToolCallDiagnosticStats;
  codex_session_transcript_scan_offsets?: Record<string, number>;
  codex_session_transcript_scan_budget?: CodexSessionTranscriptScanBudget;
  codex_session_transcript_candidate_cache?: CodexSessionTranscriptCandidateCache;
  recovery?: MissingToolOutputRecoveryState | null;
  termination?: RunningEntryTermination | null;
}

export type ToolCallEvidenceSource = 'worker_event' | 'app_server_protocol' | 'session_transcript';
export type TranscriptToolCallLineage = 'active_owned' | 'prior_stale' | 'external_manual' | 'unattributed';

export interface OutstandingToolCall {
  call_id: string;
  tool_name: string;
  thread_id: string | null;
  turn_id: string | null;
  session_id: string | null;
  started_at_ms: number;
  last_waiting_at_ms: number | null;
  last_agent_message: string | null;
  evidence_source: ToolCallEvidenceSource;
}

export type ToolCallCompletionStatus = 'pending' | 'completed';

export interface ToolCallLedgerEntry {
  call_id: string;
  tool_name: string;
  thread_id: string | null;
  turn_id: string | null;
  session_id: string | null;
  issue_id: string;
  issue_identifier: string;
  run_id: string | null;
  issue_run_id: string | null;
  attempt_id: string | null;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  completed_at_ms: number | null;
  completion_status: ToolCallCompletionStatus;
  evidence_sources: ToolCallEvidenceSource[];
  start_evidence_source: ToolCallEvidenceSource | null;
  completion_evidence_source: ToolCallEvidenceSource | null;
  last_agent_message: string | null;
}

export type MissingToolOutputRecoveryMode = 'same_thread_guarded_continuation';
export type MissingToolOutputRecoveryResult = 'started' | 'succeeded' | 'blocked' | 'failed';
export type MissingToolOutputRecoveryInterruptStatus = 'not_started' | 'succeeded' | 'failed' | 'unknown';
export type WorkerTerminationOutcome = 'succeeded' | 'failed' | 'unsupported' | 'unknown';

export interface WorkerTerminationResult {
  cancellation_supported: boolean;
  cancellation_requested: boolean;
  worker_settled: boolean | null;
  graceful_exit_observed: boolean | null;
  forced_kill_requested: boolean;
  forced_kill_settled: boolean | null;
  cleanup_requested: boolean;
  cleanup_succeeded: boolean | null;
  result: WorkerTerminationOutcome;
  reason_code: string;
  detail: string | null;
}

export interface MissingToolOutputRecoveryState {
  attempt_count: number;
  started_at_ms: number;
  reason_code: typeof REASON_CODES.missingToolOutput;
  mode: MissingToolOutputRecoveryMode;
  previous_thread_id: string | null;
  previous_turn_id: string | null;
  previous_session_id: string | null;
  replacement_thread_id?: string | null;
  replacement_turn_id?: string | null;
  replacement_session_id?: string | null;
  previous_worker_handle_known: boolean;
  previous_codex_app_server_pid: string | null;
  last_tool_name: string;
  last_call_id: string;
  evidence_source: ToolCallEvidenceSource;
  elapsed_wait_ms: number;
  last_agent_message: string | null;
  last_observed_phase: PhaseMarkerName | null;
  last_observed_phase_detail: string | null;
  recent_event_count: number;
  quarantined_event_count: number;
  prompt_hash: string;
  prompt_summary: string;
  interrupt_cancel_result?: {
    status: MissingToolOutputRecoveryInterruptStatus;
    reason_code?: string | null;
    detail?: string | null;
    termination_result?: WorkerTerminationResult | null;
  } | null;
  last_result: MissingToolOutputRecoveryResult;
  last_result_reason_code?: string | null;
  last_result_detail?: string | null;
}

export interface ToolCallLedgerObservation {
  kind: 'function_call' | 'function_call_output';
  call_id: string;
  tool_name?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  session_id?: string | null;
  observed_at_ms: number;
  last_agent_message?: string | null;
  evidence_source: ToolCallEvidenceSource;
}

export interface TranscriptToolCallDiagnostic {
  kind: 'function_call' | 'function_call_output';
  call_id: string;
  tool_name: string | null;
  thread_id: string | null;
  turn_id: string | null;
  session_id: string | null;
  issue_id: string | null;
  issue_identifier: string | null;
  run_id: string | null;
  issue_run_id: string | null;
  attempt_id: string | null;
  codex_app_server_pid: string | null;
  observed_at_ms: number;
  lineage: TranscriptToolCallLineage;
  reason: string;
  active_issue_id: string;
  active_issue_identifier: string;
  active_run_id: string | null;
  active_issue_run_id: string | null;
  active_attempt_id: string | null;
  active_codex_app_server_pid: string | null;
  active_thread_id: string | null;
  active_turn_id: string | null;
  active_session_id: string | null;
}

export interface TranscriptToolCallDiagnosticStats {
  total_count: number;
  newest_observed_at_ms: number | null;
  counts_by_lineage: Record<TranscriptToolCallLineage, number>;
  counts_by_kind: Record<'function_call' | 'function_call_output', number>;
}

export interface CodexSessionTranscriptScanBudget {
  observed_at_ms: number;
  candidate_count: number;
  files_considered: number;
  files_parsed: number;
  bytes_read: number;
  exhausted: boolean;
  reason_codes: string[];
  limits: {
    max_candidate_files: number;
    max_discovery_files: number;
    max_probe_bytes: number;
    max_scan_bytes: number;
    max_file_age_ms: number;
    max_wall_clock_ms: number;
  };
}

export interface CodexSessionTranscriptCandidateCache extends CodexSessionTranscriptScanBudget {
  identity_key: string;
  paths: string[];
  refreshed_at_ms: number;
}

export interface StateSnapshotOptions {
  includeTranscriptToolCallDiagnostics?: boolean;
}

export type OperatorActionType =
  | 'cancel'
  | 'clear_automation_fault'
  | 'requeue'
  | 'resume'
  | 'retry_step'
  | 'submit_input';

export interface OperatorActionRecord {
  action: OperatorActionType;
  requested_at_ms: number;
  result: 'accepted' | 'rejected' | 'failed';
  result_code: string | null;
  message: string | null;
  actor?: string | null;
  reason_note?: string | null;
  target_identifiers?: {
    issue_id: string;
    issue_identifier: string | null;
    issue_run_id?: string | null;
    run_id?: string | null;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    session_id?: string | null;
  };
  pre_state?: Record<string, unknown>;
  post_state?: Record<string, unknown>;
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  issue_run_id?: string | null;
  previous_attempt_id?: string | null;
  due_at_ms: number;
  error: string | null;
  worker_host: string | null;
  workspace_path: string | null;
  provisioner_type: string | null;
  branch_name: string | null;
  repo_root: string | null;
  workspace_exists: boolean;
  workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
  workspace_provisioned: boolean;
  workspace_is_git_worktree: boolean;
  copy_ignored_applied?: boolean;
  copy_ignored_status?: 'skipped' | 'success' | 'failed' | null;
  copy_ignored_summary?:
    | {
        copied_files: number;
        skipped_existing: number;
        blocked_files: number;
        bytes_copied: number;
        duration_ms: number;
      }
    | null;
  stop_reason_code: string | null;
  stop_reason_detail: string | null;
  previous_thread_id: string | null;
  previous_turn_id?: string | null;
  previous_session_id: string | null;
  last_progress_checkpoint_at?: number | null;
  last_phase?: PhaseMarkerName | null;
  last_phase_at_ms?: number | null;
  last_phase_detail?: string | null;
  timer_handle: unknown;
  progress_signals?: ProgressSignals;
  recover_workspace_attempt_residue?: boolean;
  budget?: BudgetRuntimeProjection;
  recovery?: MissingToolOutputRecoveryState | null;
}

export interface RedispatchProgressSample {
  at_ms: number;
  commit_sha: string | null;
  checklist_checkpoint: string | null;
  state_marker: string | null;
  pr_open: boolean;
  tracker_comment_created?: boolean;
  tracker_status_transition?: string | null;
  agent_review_handoff?: string | null;
  tracker_started_state?: string | null;
}

export interface ProgressSignals {
  commit_sha: string | null;
  checklist_checkpoint: string | null;
  state_marker: string | null;
  tracker_comment_created?: boolean;
  tracker_status_transition?: string | null;
  agent_review_handoff?: string | null;
  tracker_started_state?: string | null;
}

export interface BlockedEntry {
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  issue_run_id?: string | null;
  previous_attempt_id?: string | null;
  worker_host: string | null;
  workspace_path: string | null;
  provisioner_type: string | null;
  branch_name: string | null;
  repo_root: string | null;
  workspace_exists: boolean;
  workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
  workspace_provisioned: boolean;
  workspace_is_git_worktree: boolean;
  copy_ignored_applied?: boolean;
  copy_ignored_status?: 'skipped' | 'success' | 'failed' | null;
  copy_ignored_summary?:
    | {
        copied_files: number;
        skipped_existing: number;
        blocked_files: number;
        bytes_copied: number;
        duration_ms: number;
      }
    | null;
  stop_reason_code: string;
  stop_reason_detail: string | null;
  conflict_files: Array<{
    path: string;
    status: 'staged' | 'unstaged' | 'unknown';
    classification?: 'ephemeral' | 'tracked_ephemeral' | 'unknown_non_ephemeral';
  }>;
  classification_summary?: {
    ephemeral: number;
    tracked_ephemeral: number;
    unknown_non_ephemeral: number;
  };
  resolution_hints: string[];
  previous_thread_id: string | null;
  previous_turn_id?: string | null;
  previous_session_id: string | null;
  last_phase?: PhaseMarkerName | null;
  last_phase_at_ms?: number | null;
  last_phase_detail?: string | null;
  blocked_at_ms: number;
  requires_manual_resume: true;
  awaiting_operator?: true;
  awaiting_operator_reason_code?: string;
  awaiting_operator_since_ms?: number;
  awaiting_operator_resume_nonce?: number;
  attempt_count_window?: number;
  window_minutes?: number;
  last_known_commit_sha?: string | null;
  last_progress_checkpoint_at?: number | null;
  progress_signals?: ProgressSignals;
  required_actions?: string[];
  resume_override_reason?: string | null;
  budget?: BudgetRuntimeProjection;
  pending_input?: {
    request_id: string | null;
    request_method: string | null;
    prompt_text: string | null;
    questions: Array<{
      id: string;
      prompt?: string;
      options?: Array<{ label: string; value?: string }>;
    }>;
    input_schema_type: 'options' | 'text' | 'unknown';
    input_required_at_ms: number;
  } | null;
  last_input_submit?: {
    submitted_at_ms: number;
    request_id: string;
    resume_mode: 'native' | 'fallback';
    resume_reason_code: string;
  } | null;
  resume_history?: Array<{
    submitted_at_ms: number;
    request_id: string;
    resume_mode: 'native' | 'fallback';
    resume_reason_code: string;
    previous_thread_id: string | null;
    previous_session_id: string | null;
  }>;
  session_console?: Array<{
    at_ms: number;
    event: string;
    message: string | null;
    reason_code?: string | null;
    request_method?: string | null;
    request_category?: string | null;
    tool_call_id?: string | null;
    tool_name?: string | null;
    protocol_warning?: CodexProtocolWarningEvidence;
    model_reroute?: CodexModelRerouteEvidence | null;
    requested_model?: string | null;
    effective_model?: string | null;
  }>;
  tool_output_wait?: {
    tool_name: string;
    call_id: string;
    thread_id: string | null;
    turn_id: string | null;
    session_id: string | null;
    elapsed_wait_ms: number;
    last_agent_message: string | null;
    evidence_source?: ToolCallEvidenceSource;
    recommended_actions: string[];
  } | null;
  transcript_tool_call_diagnostics?: TranscriptToolCallDiagnostic[];
  transcript_tool_call_diagnostic_stats?: TranscriptToolCallDiagnosticStats;
  recovery?: MissingToolOutputRecoveryState | null;
  worker_termination_result?: WorkerTerminationResult | null;
  quarantined_events?: Array<{
    at_ms: number;
    event: string;
    message: string | null;
    codex_app_server_pid: string | null;
    session_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
    active_codex_app_server_pid?: string | null;
    reason: 'awaiting_operator_latch' | QuarantinedWorkerEventReason;
  }>;
  quarantined_event_count?: number;
  last_quarantined_event_at_ms?: number | null;
}

export interface CircuitBreakerEntry {
  issue_id: string;
  issue_identifier: string;
  breaker_active: boolean;
  breaker_hit_count: number;
  breaker_window_minutes: number;
  breaker_first_hit_at_ms: number | null;
  breaker_last_hit_at_ms: number | null;
}

export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  snapshot_generated_at_ms?: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  blocked_inputs: Map<string, BlockedEntry>;
  operator_actions?: Map<string, OperatorActionRecord[]>;
  circuit_breakers: Map<string, CircuitBreakerEntry>;
  redispatch_progress?: Map<string, RedispatchProgressSample[]>;
  phase_timeline?: Map<string, PhaseMarker[]>;
  budget_usage_samples?: Map<string, Array<{ at_ms: number; total_tokens: number }>>;
  inactive_worker_pids?: Map<
    string,
    Array<{
      pid: string;
      runtime_pid?: string | null;
      recorded_at_ms: number;
      reason: string;
      thread_id: string | null;
      turn_id: string | null;
      session_id: string | null;
    }>
  >;
  released_workers?: Map<string, ReleasedWorkerRecord[]>;
  completed: Set<string>;
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
    model_context_window?: number;
    seconds_running: number;
  };
  codex_rate_limits: Record<string, unknown> | null;
  health: {
    dispatch_validation: 'ok' | 'failed';
    last_error: string | null;
    dispatch_backpressure?: DispatchBackpressureState;
  };
  drain_mode: DrainModeState;
  quiescence: DrainQuiescenceState;
  runtime_identity: RuntimeBuildIdentityState | null;
  throughput: {
    current_tps: number;
    avg_tps_60s: number;
    window_seconds: number;
    sparkline_10m: number[];
    sample_count: number;
  };
  recent_runtime_events: Array<{
    at_ms: number;
    event: string;
    severity: 'info' | 'warn' | 'error';
    issue_identifier?: string;
    session_id?: string;
    detail?: string;
    reason_code?: string | null;
    request_method?: string | null;
    request_category?: string | null;
    tool_call_id?: string | null;
    tool_name?: string | null;
    protocol_warning?: CodexProtocolWarningEvidence;
    model_reroute?: CodexModelRerouteEvidence | null;
    requested_model?: string | null;
    effective_model?: string | null;
  }>;
}

export interface DispatchPreflightResult {
  dispatch_allowed: boolean;
  reason?: string;
}

export interface HostLoadSnapshot {
  load_average_1m: number;
  cpu_count: number;
}

export type DispatchBackpressureSource = 'control_plane' | 'host_load';

export interface DispatchBackpressureState {
  active: boolean;
  reason_code: string | null;
  reason_detail: string | null;
  source: DispatchBackpressureSource | null;
  observed_at_ms: number | null;
  retry_delay_ms: number;
}

export type DrainQuiescenceBlockerCategory =
  | 'active_worker'
  | 'live_codex_app_server_process'
  | 'pending_retry'
  | 'in_flight_tracker_write'
  | 'persistence_history_write'
  | 'unknown_degraded_blocker_source_health'
  | 'stale_runtime'
  | 'unknown_current_build_identity';

export type DrainQuiescenceWarningCategory =
  | 'stale_runtime_warning'
  | 'unknown_current_build_identity_warning'
  | 'persistence_history_degraded';

export type DrainQuiescenceStateName = 'safe' | 'blocked';

export interface DrainModeState {
  active: boolean;
  entered_at_ms: number | null;
  updated_at_ms: number | null;
  reason: string | null;
}

export interface DrainQuiescenceBlocker {
  category: DrainQuiescenceBlockerCategory;
  count: number;
  detail: string;
  issue_identifiers: string[];
  run_identifiers?: string[];
  thread_identifiers?: string[];
}

export type DrainQuiescenceBlockerCounts = Record<DrainQuiescenceBlockerCategory, number>;

export interface DrainQuiescenceWarning {
  category: DrainQuiescenceWarningCategory;
  count: number;
  detail: string;
  source: 'dispatch_safety' | 'audit_health';
  recommended_action?: string;
}

export interface DrainQuiescenceRestartGuidance {
  safe_to_restart: boolean;
  recommended_action: 'none' | 'wait_for_true_shutdown_blockers' | 'restart_runtime_to_current_build';
  pending_work: Array<{
    state: string;
    count: number;
    maintenance_eligible: boolean;
  }>;
  detail: string;
}

export interface DrainQuiescenceState {
  safe_to_shutdown: boolean;
  state: DrainQuiescenceStateName;
  updated_at_ms: number;
  blockers: DrainQuiescenceBlocker[];
  blocker_counts: DrainQuiescenceBlockerCounts;
  warnings?: DrainQuiescenceWarning[];
  restart_guidance?: DrainQuiescenceRestartGuidance;
}

export type RuntimeBuildIdentityStatus = 'current' | 'stale' | 'unknown_current';
export type CurrentBuildIdentityStatus = 'available' | 'unknown';

export interface RuntimeBuildIdentityDetails {
  identity: string | null;
  commit_sha: string | null;
  source_timestamp_ms: number | null;
}

export interface CurrentRuntimeBuildIdentityDetails extends RuntimeBuildIdentityDetails {
  status: CurrentBuildIdentityStatus;
}

export interface RuntimeBuildIdentityWarning {
  code: 'stale_runtime_build' | 'unknown_current_build_identity';
  severity: 'warning' | 'degraded';
  message: string;
  recommended_action: string;
}

export interface RuntimeBuildIdentityState {
  process_started_at_ms: number;
  running_build: RuntimeBuildIdentityDetails;
  current_build: CurrentRuntimeBuildIdentityDetails;
  status: RuntimeBuildIdentityStatus;
  health_warning: RuntimeBuildIdentityWarning | null;
}

export interface SpawnWorkerResultSuccess {
  ok: true;
  worker_handle: unknown;
  worker_instance_id?: string | null;
  monitor_handle: unknown;
  workspace_path?: string | null;
  worker_host?: string | null;
  provisioner_type?: string | null;
  branch_name?: string | null;
  repo_root?: string | null;
  workspace_exists?: boolean;
  workspace_git_status?: 'clean' | 'dirty' | 'unknown' | null;
  workspace_provisioned?: boolean;
  workspace_is_git_worktree?: boolean;
  copy_ignored_applied?: boolean;
  copy_ignored_status?: 'skipped' | 'success' | 'failed' | null;
  copy_ignored_summary?:
    | {
        copied_files: number;
        skipped_existing: number;
        blocked_files: number;
        bytes_copied: number;
        duration_ms: number;
      }
    | null;
}

export interface SpawnWorkerResultFailure {
  ok: false;
  error: string;
}

export type SpawnWorkerResult = SpawnWorkerResultSuccess | SpawnWorkerResultFailure;

export interface OrchestratorPorts {
  tracker: TrackerAdapter;
  dispatchPreflight: () => DispatchPreflightResult;
  resolveRuntimeIdentity?: () => RuntimeBuildIdentityState | null;
  getControlPlaneHealth?: () => ControlPlaneHealthSummary | null;
  getHostLoad?: () => HostLoadSnapshot | null;
  getPersistenceHealth?: () => PersistenceHealth;
  spawnWorker: (params: {
    issue: Issue;
    attempt: number | null;
    worker_host?: string | null;
    resume_context?: string | null;
    recover_workspace_attempt_residue?: boolean;
  }) => Promise<SpawnWorkerResult>;
  recoverMissingToolOutput?: (params: {
    issue: Issue;
    attempt: number | null;
    worker_host?: string | null;
    previous_thread_id: string;
    previous_turn_id: string;
    previous_session_id: string | null;
    recovery_prompt: string;
  }) => Promise<SpawnWorkerResult>;
  terminateWorker: (params: {
    issue_id: string;
    worker_handle: unknown;
    cleanup_workspace: boolean;
    reason: string;
  }) => Promise<WorkerTerminationResult>;
  scheduleRetryTimer: (params: {
    issue_id: string;
    due_at_ms: number;
    callback: () => Promise<void>;
  }) => unknown;
  cancelRetryTimer: (timer_handle: unknown) => void;
  submitBlockedIssueInputNative?: (params: {
    issue_id: string;
    issue_identifier: string;
    request_id: string;
    request_method: string | null;
    previous_thread_id: string | null;
    previous_session_id: string | null;
    answer: { question_id?: string; option_label?: string; text?: string };
  }) => Promise<{
    applied: boolean;
    code:
      | 'native_applied'
      | 'session_expired'
      | 'request_not_found'
      | 'transport_unsupported'
      | 'native_submit_failed';
    message?: string;
    resume_context?: string;
  }>;
  resolveProgressSignals?: (params: {
    issue: Issue | null;
    issue_id: string;
    branch_name: string | null;
    repo_root: string | null;
    fallback_state_marker: string | null;
    previous_progress_signals?: ProgressSignals | null;
  }) => Promise<ProgressSignals>;
  notifyObservers?: () => void;
}

export interface PhaseMarkerSettings {
  enabled: boolean;
  timeline_limit: number;
  last_emit_error_code: string | null;
}

export interface OrchestratorPersistencePort {
  startRun: (params: { issue_id: string; issue_identifier: string; issue_run_id?: string | null }) => Promise<string>;
  recordRunStarted?: (params: {
    issue_id: string;
    issue_identifier: string;
    started_at: string;
    attempt_number: number;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
  }) => Promise<{ run_id: string; issue_run_id: string; attempt_id: string }>;
  appendIssueRun?: (params: {
    issue_id: string;
    issue_identifier: string;
    started_at: string;
    ended_at?: string | null;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    issue_run_id?: string;
  }) => Promise<string>;
  appendAttempt?: (params: {
    issue_run_id: string;
    attempt_number: number;
    started_at: string;
    ended_at?: string | null;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    attempt_id?: string;
  }) => Promise<string>;
  appendThread?: (params: {
    attempt_id: string;
    session_id?: string | null;
    agent_runtime?: string | null;
    worker_instance_id?: string | null;
    worker_process_pid?: number | null;
    started_at: string;
    ended_at?: string | null;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    thread_id?: string;
  }) => Promise<string>;
  appendTurn?: (params: {
    thread_id: string;
    turn_index: number;
    started_at: string;
    ended_at?: string | null;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    turn_id?: string;
  }) => Promise<string>;
  appendPhaseSpan?: (params: {
    turn_id: string;
    phase: string;
    started_at: string;
    ended_at?: string | null;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    phase_span_id?: string;
  }) => Promise<string>;
  appendToolSpan?: (params: {
    turn_id: string;
    tool_name: string;
    started_at: string;
    ended_at?: string | null;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    tool_span_id?: string;
  }) => Promise<string>;
  appendStateTransition?: (params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    from_status?: string | null;
    to_status: string;
    transitioned_at: string;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    state_transition_id?: string;
  }) => Promise<string>;
  appendTicketTerminalOutcome?: (params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    outcome: RunTerminalStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    recorded_at: string;
    terminal_outcome_id?: string;
  }) => Promise<string>;
  appendTicketBlocker?: (params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    blocker_type: string;
    status?: 'active' | 'resolved';
    reason_code: string;
    reason_detail?: string | null;
    blocked_at: string;
    resolved_at?: string | null;
    blocker_id?: string;
  }) => Promise<string>;
  appendTicketEvidenceReference?: (params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    evidence_kind: string;
    uri: string;
    title?: string | null;
    metadata?: Record<string, unknown> | null;
    recorded_at: string;
    evidence_reference_id?: string;
  }) => Promise<string>;
  appendTrackerTicketSnapshot?: (params: {
    issue_run_id?: string | null;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    tracker_kind: string;
    tracker_scope?: { status: 'present'; value: string } | { status: 'missing'; reason: string } | null;
    remote_issue_id: string;
    human_issue_identifier: string;
    title: string;
    tracker_status: string;
    assignee_status?: 'available' | 'unavailable' | 'unknown';
    assignee_identifier?: string | null;
    assignee_reason?: string | null;
    labels?: string[];
    project_status?: 'available' | 'unavailable' | 'unknown';
    project_identifier?: string | null;
    project_reason?: string | null;
    team_status?: 'available' | 'unavailable' | 'unknown';
    team_identifier?: string | null;
    team_reason?: string | null;
    observed_at: string;
  }) => Promise<string>;
  appendTicketReference?: (params: {
    issue_run_id?: string | null;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    reference_kind: 'branch' | 'pull_request' | 'review' | 'merge' | 'evidence';
    availability: 'available' | 'unavailable' | 'unknown';
    uri?: string | null;
    label?: string | null;
    external_id?: string | null;
    state?: string | null;
    metadata?: Record<string, unknown> | null;
    observed_at: string;
  }) => Promise<string>;
  appendOperatorActionHistory?: (params: {
    issue_run_id?: string | null;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    action: string;
    actor?: string | null;
    result: 'accepted' | 'rejected' | 'failed';
    result_code?: string | null;
    message?: string | null;
    reason_note?: string | null;
    phase?: string | null;
    state_context?: Record<string, unknown> | null;
    requested_at: string;
    observed_at: string;
  }) => Promise<string>;
  appendBlockedInputEvent?: (params: {
    issue_run_id?: string | null;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    issue_id: string;
    issue_identifier: string;
    phase?: string | null;
    runtime_state: string;
    reason_code: string;
    reason_detail?: string | null;
    request_id?: string | null;
    request_method?: string | null;
    input_schema_type?: string | null;
    prompt_text?: string | null;
    pending_input?: Record<string, unknown> | null;
    state_context?: Record<string, unknown> | null;
    blocked_at: string;
  }) => Promise<string>;
  appendTokenModelFact?: (params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    requested_model?: string | null;
    effective_model?: string | null;
    model_source?: string | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    cached_input_tokens?: number | null;
    reasoning_output_tokens?: number | null;
    total_tokens?: number | null;
    model_context_window?: number | null;
    runtime_provider?: string | null;
    provider_turn_count?: number | null;
    estimated_cost_usd?: number | null;
    cache_creation_input_tokens?: number | null;
    provider_usage_status?: string | null;
    provider_usage_source?: string | null;
    api_retry_count?: number | null;
    api_error_status?: number | string | null;
    terminal_reason?: string | null;
    stop_reason?: string | null;
    duration_ms?: number | null;
    duration_api_ms?: number | null;
    time_to_first_token_ms?: number | null;
    permission_denial_count?: number | null;
    unknown_event_count?: number | null;
    auxiliary_result_count?: number | null;
    effective_models?: string[] | null;
    tool_counts?: Record<string, number> | null;
    mcp_counts?: Record<string, number> | null;
    missing_reason?: string | null;
    reconciliation_delta?: Record<string, number> | null;
    model_usage?: unknown[] | null;
    nested_session_detected?: boolean | null;
    supervised_session_coverage?: string | null;
    telemetry_confidence:
      | 'observed_live'
      | 'backfilled'
      | 'provider_step'
      | 'provider_result'
      | 'legacy_partial'
      | 'missing';
    observed_at: string;
    token_model_fact_id?: string;
  }) => Promise<string>;
  appendProviderUsageStepFact?: (params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id: string;
    message_id_hash: string;
    model?: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    observed_at: string;
  }) => Promise<string>;
  appendDrainAuditHistory?: (params: {
    issue_run_id?: string | null;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    event_type:
      | 'drain-entered'
      | 'drain-exited'
      | 'quiescence-reached'
      | 'wait-started'
      | 'wait-timed-out'
      | 'safe-shutdown-allowed'
      | 'safe-shutdown-refused';
    actor?: string | null;
    source: string;
    result: 'accepted' | 'rejected' | 'failed' | 'observed';
    result_code: string;
    reason_note?: string | null;
    state_context?: Record<string, unknown> | null;
    blocker_summaries?: Array<{
      category: string;
      count: number;
      issue_identifiers?: string[];
      run_identifiers?: string[];
      thread_identifiers?: string[];
      detail?: string | null;
    }>;
    occurred_at: string;
    observed_at: string;
  }) => Promise<string>;
  appendAppServerEvent?: (params: {
    issue_run_id: string;
    observed_at: string;
    source_event_id: string;
    source_event_name: string;
    payload_class: HistoryPayloadClass;
    summary?: string | null;
    summary_fields?: Record<string, unknown>;
    unavailable_reason_code?: string | null;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    app_server_event_id?: string;
  }) => Promise<string>;
  recordHistoryWriteFailure?: (params: { operation: string; reason_code: string; detail?: string | null }) => Promise<void>;
  recordSession: (params: { run_id: string; session_id: string }) => Promise<void>;
  recordEvent: (params: {
    run_id: string;
    timestamp_ms: number;
    event: string;
    message: string | null;
    reason_code?: string | null;
    request_method?: string | null;
    request_category?: string | null;
  }) => Promise<void>;
  completeRunIncludesTerminalEvidence?: boolean;
  completeRun: (params: {
    run_id: string;
    issue_run_id?: string | null;
    attempt_id?: string | null;
    terminal_status: RunTerminalStatus;
    error_code?: string | null;
    terminal_reason_code?: string | null;
    terminal_reason_detail?: string | null;
    root_cause_status?: ExecutionGraphEntityStatus | null;
    root_cause_reason_code?: string | null;
    root_cause_reason_detail?: string | null;
    root_cause_at?: string | null;
    session_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    missing_tool_output_recovery?: Record<string, unknown> | null;
  }) => Promise<void>;
  upsertBreaker?: (params: {
    issue_id: string;
    issue_identifier: string;
    breaker_active: boolean;
    breaker_hit_count: number;
    breaker_window_minutes: number;
    breaker_first_hit_at: string | null;
    breaker_last_hit_at: string | null;
  }) => Promise<void>;
  deleteBreaker?: (issue_id: string) => Promise<void>;
  upsertBlockedInput?: (issue_id: string, payload: string) => Promise<void>;
  deleteBlockedInput?: (issue_id: string) => Promise<void>;
  upsertOperatorActions?: (issue_id: string, payload: string) => Promise<void>;
}

export interface WorkerObservabilityEvent {
  timestamp_ms: number;
  event: string;
  agent_runtime?: 'codex-app-server' | 'claude-cli';
  worker_process_pid?: number | null;
  thread_id?: string;
  turn_id?: string;
  session_id?: string;
  codex_app_server_pid?: number | null;
  worker_instance_id?: string | null;
  detail?: string;
  reason_code?: string | null;
  request_method?: string | null;
  request_category?: string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  usage?: CodexUsageTotals;
  provider_usage?: import('../agent').ProviderUsage;
  provider_usage_step_facts?: import('../agent').ProviderUsageStepFact[];
  process_liveness_only?: boolean;
  token_telemetry_status?: TokenTelemetryStatus;
  token_telemetry_last_source?: string | null;
  token_telemetry_last_at_ms?: number | null;
  rate_limits?: Record<string, unknown> | null;
  protocol_warnings?: CodexProtocolWarningEvidence[];
  protocol_warning?: CodexProtocolWarningEvidence;
  model_reroute?: CodexModelRerouteEvidence | null;
  requested_model?: string | null;
  effective_model?: string | null;
  terminal_source?: 'app_server_protocol' | 'session_transcript';
  codex_thread_activity_at_ms?: number | null;
  codex_thread_activity_source?: CodexAppServerThreadActivitySource | null;
  codex_thread_activity_status?: string | null;
  tool_call_evidence_source?: ToolCallEvidenceSource;
}

export interface OrchestratorConfig {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  max_concurrent_agents_by_state: Record<string, number>;
  max_retry_backoff_ms: number;
  respawn_window_minutes?: number;
  respawn_max_attempts_without_progress?: number;
  active_states: string[];
  terminal_states: string[];
  handoff_states?: string[];
  fresh_dispatch_states?: string[];
  github_linking_mode?: 'off' | 'warn' | 'required' | string;
  stall_timeout_ms: number;
  no_telemetry_warning_threshold_ms?: number;
  running_wait_stall_threshold_ms?: number;
  missing_tool_output_max_recoveries_per_run?: number;
  progress_heartbeat_only_warn_ms?: number;
  progress_stalled_waiting_ms?: number;
  worker_opaque_activity_hard_timeout_ms?: number;
  inactive_worker_pid_ttl_ms?: number;
  phase_markers_enabled?: boolean;
  phase_timeline_limit?: number;
  budget?: {
    per_run_total_tokens?: number;
    per_issue_rolling_tokens?: number;
    rolling_window_minutes: number;
    warning_threshold_ratio: number;
    hard_limit_policy: BudgetHardLimitPolicy;
  };
  worker_hosts?: string[];
  max_concurrent_agents_per_host?: number | null;
  dispatch_backpressure?: {
    enabled?: boolean;
    retry_delay_ms?: number;
    min_running_agents?: number;
    control_plane_health?: ControlPlaneHealthState;
    control_plane_stale_after_ms?: number;
    host_load_per_cpu?: number | null;
  };
}

export interface OrchestratorOptions {
  config: OrchestratorConfig;
  ports: OrchestratorPorts;
  persistence?: OrchestratorPersistencePort;
  nowMs?: () => number;
  logger?: StructuredLogger;
}
