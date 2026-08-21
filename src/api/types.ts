import type {
  DrainModeState,
  OrchestratorState,
  StateSnapshotOptions,
  TickReason,
  ToolCallEvidenceSource,
  ToolCallCompletionStatus
} from '../orchestrator';
import type { CodexModelRerouteEvidence, CodexProtocolWarningEvidence } from '../codex';
import type { CodexAppServerThreadActivitySource } from '../codex/app-server-protocol';
import type { ProviderUsage } from '../agent';
import type { OperatorExplainer, OperatorExplainerHint, PhaseMarkerName } from '../observability';
import { REASON_CODES } from '../observability/reason-codes';
import type { StructuredLogger } from '../observability';
import type {
  DurableIdentity,
  DurableRunHistoryRecord,
  CompletedProviderUsageTotal,
  DrainAuditEventRecord,
  ExecutionGraphThreadLineage,
  PersistenceHealth,
  PersistenceHealthOptions,
  ProjectHistoryTicketSummaryPage,
  ReviewApprovalActionRecord,
  TicketTimelineRecord,
  UiContinuityState
} from '../persistence';
import type { SecurityProfile } from '../security';
import type { ControlPlaneHealthRecorder, ControlPlaneHealthSummary, ControlPlaneThresholds } from './control-plane-health';
import type { EventLoopHealthMonitor } from './event-loop-health';

export type TurnControlState = 'agent_turn' | 'operator_turn' | 'blocked_manual_resume' | 'automation_fault';
export type ProgressSignalState = 'advancing' | 'heartbeat_only' | 'active_but_opaque' | 'stalled_waiting';
export type SnapshotFreshnessState = 'fresh' | 'aging' | 'stale';
export type TokenTelemetryConfidence = 'observed_live' | 'backfilled' | 'missing';
export type ApiDegradedReasonCode = 'route_not_found' | 'schema_mismatch' | 'upstream_unavailable' | null;
export type NotBlockedExplainerCode =
  | 'active_turn_no_stop_reason'
  | 'within_wait_threshold'
  | 'awaiting_classifier_transition'
  | null;

export interface OperatorActionProjection {
  action: 'cancel' | 'clear_automation_fault' | 'requeue' | 'resume' | 'retry_step' | 'submit_input';
  requested_at_ms: number;
  result: 'accepted' | 'rejected' | 'failed';
  result_code: string | null;
  message: string | null;
  actor?: string | null;
  reason_note?: string | null;
  target_identifiers?: {
    issue_id: string;
    issue_identifier: string | null;
    run_id?: string | null;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    session_id?: string | null;
  };
  pre_state?: Record<string, unknown>;
  post_state?: Record<string, unknown>;
}

export interface ApiAvailableOperatorAction {
  id: 'cancel' | 'clear_automation_fault' | 'requeue' | 'resume' | 'retry_step' | 'submit_input';
  label: string;
  endpoint: string;
  method: 'POST';
  requires_reason_note: boolean;
  destructive: boolean;
}

export interface VisibilityProjectionFields {
  turn_control_state: TurnControlState;
  turn_control_reason_code: string | null;
  turn_control_since_ms: number | null;
  progress_signal_state: ProgressSignalState;
  last_progress_transition_at_ms: number | null;
  last_heartbeat_at_ms: number | null;
}

export interface TokenTelemetryQualityFields {
  token_telemetry_confidence: TokenTelemetryConfidence;
  token_telemetry_source: string | null;
  token_telemetry_last_observed_at_ms: number | null;
}

export interface SnapshotFreshnessFields {
  snapshot_generated_at_ms: number;
  snapshot_age_ms: number;
  snapshot_freshness_state: SnapshotFreshnessState;
}

export interface ApiDegradedFields {
  api_degraded_mode: boolean;
  api_degraded_reason_code: ApiDegradedReasonCode;
  api_degraded_routes: string[];
}

export interface RuntimeSnapshotSource {
  getStateSnapshot(options?: StateSnapshotOptions): OrchestratorState;
}

export interface RefreshTickSource {
  tick(reason: TickReason): Promise<void>;
}

export interface DiagnosticsSource {
  getActiveProfile(): SecurityProfile;
  getPersistenceHealth(options?: PersistenceHealthOptions): PersistenceHealth;
  listRunHistory(limit?: number): DurableRunHistoryRecord[];
  listCompletedProviderUsageTotals?: (excludeIssueRunIds?: string[]) => CompletedProviderUsageTotal[];
  listReviewApprovalActions?: (issueIdentifier?: string, limit?: number) => ReviewApprovalActionRecord[];
  reconstructThreadLineage?: (threadId: string) => ExecutionGraphThreadLineage | null;
  reconstructLatestThreadLineageByIssueIdentifier?: (issueIdentifier: string) => ExecutionGraphThreadLineage | null;
  listProjectTicketIdentities?: (
    projectKey: string,
    options?: { limit?: number; offset?: number }
  ) => { items: DurableIdentity[]; limit: number; offset: number; has_more: boolean; total: number };
  listProjectTicketSummaries?: (
    projectKey: string,
    options?: { limit?: number; offset?: number }
  ) => ProjectHistoryTicketSummaryPage;
  listProjectDrainAuditEvents?: (
    projectKey: string,
    options?: { limit?: number; offset?: number }
  ) => { items: DrainAuditEventRecord[]; limit: number; offset: number; has_more: boolean; total: number };
  getProjectTicketIdentity?: (projectKey: string, ticketKey: string) => DurableIdentity | null;
  reconstructTicketTimeline?: (identity: DurableIdentity) => TicketTimelineRecord;
  getLoggingHealth(): {
    root: string;
    active_file: string;
    rotation: {
      max_bytes: number;
      max_files: number;
    };
    sinks: string[];
  };
  getUiState(): UiContinuityState | null;
  setUiState(state: UiContinuityState): void;
  getPromptFallbackActive(): boolean;
  getProjectLayoutDiagnostics?: () => ApiProjectLayoutDiagnostics | null;
  getRuntimeResolution(): {
    workflow_path: string;
    workflow_dir: string;
    workspace_root: string;
    workspace_root_source: 'workflow' | 'default';
    server: {
      host: string;
      port: number | null;
    };
    provisioner_type: string;
    repo_root: string | null;
    base_ref: string | null;
    branch_name_template: string | null;
    effective_codex_home?: string | null;
    effective_codex_model?: string | null;
    effective_reasoning_effort?: string | null;
    effective_extra_flags_count?: number;
    codex_resolution_mode?: 'typed' | 'legacy' | 'mixed';
  };
  getWorkspaceProvisioner(): {
    provisioner_type: string;
    repo_root: string | null;
    base_ref: string | null;
    branch_name_template: string | null;
    last_provision_result: 'provisioned' | 'reused' | 'skipped' | 'failed' | null;
    last_teardown_result: 'removed' | 'kept' | 'skipped' | 'failed' | null;
    last_error_code: string | null;
    last_verification_result: 'verified' | 'reprovisioned' | 'failed' | null;
    last_cleanup_on_failure_result: 'cleaned' | 'cleanup_failed' | 'not_attempted' | null;
    verification_mode: 'strict' | 'none';
    last_integrity_status: 'ok' | 'reconciled' | 'failed' | null;
    last_integrity_reason_code: string | null;
    last_integrity_checked_at: string | null;
    last_integrity_reconciled_at: string | null;
  };
  getWorkspaceCopyIgnored(): {
    enabled: boolean;
    include_file: string;
    from: 'primary_worktree' | 'repo_root';
    conflict_policy: 'skip' | 'overwrite' | 'fail';
    require_gitignored: boolean;
    max_files: number;
    max_total_bytes: number;
    last_status: 'start' | 'success' | 'skipped' | 'failed' | null;
    last_error_code: string | null;
    last_error_message: string | null;
    source_path: string | null;
    copied_files: number;
    skipped_existing: number;
    blocked_files: number;
    bytes_copied: number;
    duration_ms: number;
  };
  getPhaseMarkers?(): {
    enabled: boolean;
    timeline_limit: number;
    last_emit_error_code: string | null;
  };
  getBreakerStatuses?(): Array<{
    issue_id: string;
    issue_identifier: string;
    breaker_active: boolean;
    breaker_hit_count: number;
    breaker_window_minutes: number;
    breaker_first_hit_at: string | null;
    breaker_last_hit_at: string | null;
  }>;
  getBlockedLatchStats?(): {
    blocked_latch_active_count: number;
    blocked_event_quarantine_total: number;
    blocked_event_allowlist_total: number;
    blocked_event_reject_total: number;
    blocked_latch_violation_total: number;
  };
}

export type ApiProjectLayoutPathSource =
  | 'default_system_state'
  | 'explicit_override'
  | 'runtime_contract';

export interface ApiProjectLayoutEffectivePath {
  path: string;
  source: ApiProjectLayoutPathSource;
  explicit_override_source: 'workflow' | 'cli' | null;
}

export interface ApiProjectLayoutPathStatus {
  path: string;
  role: string;
  status: 'present' | 'missing' | 'reserved' | 'legacy-present';
  exists: boolean;
  loaded_by_runtime?: boolean;
}

export interface ApiProjectLayoutDiagnostics {
  status: 'ok' | 'warning';
  canonical_workflow_path: ApiProjectLayoutEffectivePath & {
    exists: boolean;
  };
  project_root: {
    path: string;
  };
  expected_runtime_state_root: ApiProjectLayoutEffectivePath & {
    relative_path: '.symphony/system';
  };
  effective_workspace_root: ApiProjectLayoutEffectivePath;
  effective_log_root: ApiProjectLayoutEffectivePath;
  effective_persistence_path: ApiProjectLayoutEffectivePath;
  ignore_status: {
    path: '.gitignore';
    exists: boolean;
    status: 'missing' | 'narrow-system' | 'broad-symphony' | 'mixed-legacy' | 'unclassified' | 'unreadable';
    has_narrow_system_ignore: boolean;
    remediation: string;
  };
  broad_ignore_warning: {
    status: 'ok' | 'warning';
    present: boolean;
    remediation: string | null;
  };
  legacy_runtime_path_status: {
    status: 'ok' | 'warning';
    present: boolean;
    paths: ApiProjectLayoutPathStatus[];
  };
  reserved_customization_path_status: {
    status: 'reserved';
    paths: ApiProjectLayoutPathStatus[];
  };
  warnings: Array<{
    code: string;
    path: string;
    message: string;
    remediation: string;
  }>;
}

export interface LocalApiErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

export interface ApiBudgetProjection {
  budget_usage_tokens: number | null;
  budget_limit_tokens: number | null;
  budget_window_minutes: number;
  budget_status: 'ok' | 'warning' | 'hard_limited' | 'telemetry_unavailable';
  budget_policy: 'block_requires_resume' | 'terminate_attempt' | null;
  budget_message?: string | null;
}

export interface ApiPhaseTimingProjection {
  phase_started_at: string | null;
  phase_elapsed_ms: number | null;
  source: typeof import('../observability').REASON_CODES.symphonyPhaseMarker | null;
}

export interface ApiCodexThreadActivityProjection {
  thread_id: string | null;
  updated_at: string | null;
  updated_at_ms: number | null;
  age_ms: number | null;
  source: CodexAppServerThreadActivitySource | null;
  status: 'available' | 'unavailable';
  thread_status: string | null;
}

export interface ApiBlockedRootCauseProjection {
  phase: PhaseMarkerName;
  reason_code: string;
  summary: string;
  detail: string;
  remediation_hint: string | null;
  differs_from_current_operator_block: boolean;
}

export interface ApiCurrentOperatorBlockProjection {
  reason_code: string;
  detail: string | null;
}

export type ApiRetryDueState = 'pending' | 'overdue';

export interface ApiRetryCauseProjection {
  reason_code: string | null;
  detail: string | null;
  operator_detail: string | null;
  headline: string;
  expected_transition: string | null;
  last_phase: PhaseMarkerName | null;
  due_at_ms: number;
  due_state: ApiRetryDueState;
  overdue_ms: number | null;
  retry_wait_ms: number | null;
}

export interface ApiToolCallLedgerEntry {
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
  first_seen_at: string;
  first_seen_at_ms: number;
  last_seen_at: string;
  last_seen_at_ms: number;
  completed_at: string | null;
  completed_at_ms: number | null;
  duration_ms: number | null;
  completion_status: ToolCallCompletionStatus;
  evidence_sources: ToolCallEvidenceSource[];
  start_evidence_source: ToolCallEvidenceSource | null;
  completion_evidence_source: ToolCallEvidenceSource | null;
  last_agent_message: string | null;
}

export interface ApiTranscriptToolCallDiagnostic {
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
  observed_at: string;
  observed_at_ms: number;
  lineage: import('../orchestrator').TranscriptToolCallLineage;
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

export interface ApiTranscriptToolCallDiagnosticSummary {
  detailed_diagnostics_available: boolean;
  total_count: number;
  detail_url: string | null;
  newest_observed_at: string | null;
  newest_observed_at_ms: number | null;
  counts_by_lineage: Record<import('../orchestrator').TranscriptToolCallLineage, number>;
  counts_by_kind: Record<'function_call' | 'function_call_output', number>;
  active_missing_tool_output: {
    active: boolean;
    tool_name: string | null;
    call_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
    session_id: string | null;
    evidence_source: import('../orchestrator').ToolCallEvidenceSource | null;
  };
  recovery: {
    active: boolean;
    status: import('../orchestrator').MissingToolOutputRecoveryResult | null;
    attempt_count: number;
    last_result_reason_code: string | null;
    previous_thread_id: string | null;
    replacement_thread_id: string | null;
  };
}

export interface ApiDiagnosticPageMetadata {
  total_available_count: number;
  included_count: number;
  limit: number;
  offset: number;
  has_more: boolean;
  truncated: boolean;
  oldest_observed_at: string | null;
  oldest_observed_at_ms: number | null;
  newest_observed_at: string | null;
  newest_observed_at_ms: number | null;
}

export interface ApiIssueRuntimeDiagnosticsResponse extends SnapshotFreshnessFields, ApiDegradedFields {
  issue_identifier: string;
  issue_id: string;
  status: 'running' | 'retrying' | 'blocked';
  generated_at: string;
  diagnostics_endpoint: string;
  codex_session_transcript_scan_budget: ApiCodexSessionTranscriptScanBudget | null;
  transcript_tool_call_diagnostics: {
    metadata: ApiDiagnosticPageMetadata;
    records: ApiTranscriptToolCallDiagnostic[];
  };
  tool_call_ledger: {
    metadata: ApiDiagnosticPageMetadata;
    records: ApiToolCallLedgerEntry[];
  };
  missing_tool_output: {
    tool_name: string;
    call_id: string;
    thread_id: string | null;
    turn_id: string | null;
    session_id: string | null;
    elapsed_wait_ms: number;
    last_agent_message: string | null;
    evidence_source?: 'worker_event' | 'app_server_protocol' | 'session_transcript';
    recommended_actions: string[];
  } | null;
  recovery: import('../orchestrator').MissingToolOutputRecoveryState | null;
  missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
}

export interface ApiCodexSessionTranscriptScanBudget {
  observed_at: string;
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

export type ApiAgentConversationRole = 'system' | 'user' | 'assistant' | 'tool' | 'runtime';
export type ApiAgentConversationSource =
  | 'runtime_event'
  | 'app_server_ledger'
  | 'thread_diagnostics'
  | 'run_history';

export interface ApiAgentConversationMessage {
  id: string;
  at: string;
  at_ms: number;
  role: ApiAgentConversationRole;
  source: ApiAgentConversationSource;
  event: string | null;
  content: string;
  thread_id: string | null;
  turn_id: string | null;
  session_id: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  detail_status:
    | 'absent'
    | 'summary'
    | 'summary_only'
    | 'redacted_excerpt'
    | 'redacted_truncated_excerpt'
    | 'unavailable_policy'
    | 'unavailable_source';
  truncated: boolean;
}

export interface ApiAgentConversationProjection {
  issue_identifier: string;
  issue_id: string | null;
  latest: {
    at: string | null;
    at_ms: number | null;
    role: ApiAgentConversationRole | null;
    source: ApiAgentConversationSource | null;
    summary: string | null;
  };
  messages: ApiAgentConversationMessage[];
  metadata: {
    total_available_count: number;
    included_count: number;
    limit: number;
    truncated: boolean;
    sources: ApiAgentConversationSource[];
    role_counts: Record<ApiAgentConversationRole, number>;
    detail: string;
  };
}

export interface ApiStateResponse extends SnapshotFreshnessFields, ApiDegradedFields {
  generated_at: string;
  runtime_identity: ApiRuntimeBuildIdentityProjection | null;
  dashboard_asset_revision?: string | null;
  runtime_update: ApiRuntimeUpdateReadiness | null;
  runtime_restart: ApiRuntimeRestartStatus;
  drain_mode: ApiDrainModeProjection;
  quiescence: ApiDrainQuiescenceProjection;
  counts: {
    running: number;
    retrying: number;
    blocked: number;
    stopped: number;
    running_stalled_waiting_count: number;
    running_awaiting_input_count: number;
  };
  retry_status: {
    total: number;
    overdue_count: number;
    pending_count: number;
    entries: Array<{
      issue_id: string;
      issue_identifier: string;
      attempt: number;
      due_at: string;
      due_at_ms: number;
      due_state: ApiRetryDueState;
      overdue_ms: number | null;
      retry_wait_ms: number | null;
      reason_code: string | null;
      detail: string | null;
      operator_detail: string | null;
      headline: string;
      expected_transition: string | null;
      last_phase: PhaseMarkerName | null;
    }>;
  };
  worker_event_pressure: ApiWorkerEventPressure;
  running: Array<ApiBudgetProjection & {
    issue_id: string;
    issue_identifier: string;
    state: string;
    dispatch_state: string;
    session_id: string | null;
    worker_host: string | null;
    workspace_path: string | null;
    provisioner_type: string | null;
    branch_name: string | null;
    repo_root: string | null;
    workspace_exists: boolean;
    workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
    workspace_provisioned: boolean;
    workspace_is_git_worktree: boolean;
    copy_ignored_applied: boolean;
    copy_ignored_status: 'skipped' | 'success' | 'failed' | null;
    copy_ignored_summary: {
      copied_files: number;
      skipped_existing: number;
      blocked_files: number;
      bytes_copied: number;
      duration_ms: number;
    } | null;
    thread_id: string | null;
    turn_id: string | null;
    codex_app_server_pid: string | null;
    agent_runtime: 'codex-app-server' | 'claude-cli' | null;
    worker_process_pid: string | null;
    provider_usage: ProviderUsage | null;
    turn_count: number;
    last_event: string | null;
    last_event_summary: string | null;
    last_message: string | null;
    awaiting_input: boolean;
    awaiting_input_since_ms: number | null;
    pending_input_preview: {
      type: string;
      prompt_preview: string | null;
      option_count: number | null;
    } | null;
    stalled_waiting: boolean;
    stalled_waiting_since_ms: number | null;
    stalled_waiting_reason: typeof REASON_CODES.turnWaitingThresholdExceeded | null;
    current_phase: PhaseMarkerName | null;
    current_phase_at: string | null;
    phase_elapsed_ms: number | null;
    phase_timing: ApiPhaseTimingProjection;
    phase_detail: string | null;
    started_at: string;
    last_event_at: string | null;
    codex_thread_activity: ApiCodexThreadActivityProjection;
    token_telemetry_status: 'unavailable' | 'pending' | 'available';
    token_telemetry_last_source: string | null;
    token_telemetry_last_at_ms: number | null;
    token_telemetry_confidence: TokenTelemetryConfidence;
    token_telemetry_source: string | null;
    token_telemetry_last_observed_at_ms: number | null;
    turn_control_state: TurnControlState;
    turn_control_reason_code: string | null;
    turn_control_since_ms: number | null;
    progress_signal_state: ProgressSignalState;
    last_progress_transition_at_ms: number | null;
    last_heartbeat_at_ms: number | null;
    quarantined_event_count: number;
    last_quarantined_event_at: string | null;
    ownership_conflict: {
      reason: 'pre_session_identity_conflict' | 'ownership_conflict';
      detected_at: string;
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
    current_blocker_class: string | null;
    time_since_progress: number | null;
    last_successful_step: string | null;
    conversation_latest: ApiAgentConversationProjection['latest'];
    transcript_tool_call_diagnostic_summary: ApiTranscriptToolCallDiagnosticSummary;
    not_blocked_explainer_code: NotBlockedExplainerCode;
    not_blocked_explainer_text: string | null;
    operator_actions: OperatorActionProjection[];
    rate_limits: Record<string, unknown> | null;
    protocol_warnings: CodexProtocolWarningEvidence[];
    model_reroute: CodexModelRerouteEvidence | null;
    requested_model: string | null;
    effective_model: string | null;
    tokens: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      token_split_status?: 'available' | 'aggregate_only';
      cached_input_tokens?: number;
      reasoning_output_tokens?: number;
      model_context_window?: number;
    };
    recovery: import('../orchestrator').MissingToolOutputRecoveryState | null;
    missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
    codex_session_transcript_scan_budget: ApiCodexSessionTranscriptScanBudget | null;
    operator_explainer_hint: OperatorExplainerHint | null;
  }>;
  retrying: Array<ApiBudgetProjection & {
    issue_id: string;
    issue_identifier: string;
    attempt: number;
    due_at: string;
    due_at_ms: number;
    due_state: ApiRetryDueState;
    overdue_ms: number | null;
    retry_wait_ms: number | null;
    retry_cause: ApiRetryCauseProjection;
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
    copy_ignored_applied: boolean;
    copy_ignored_status: 'skipped' | 'success' | 'failed' | null;
    copy_ignored_summary: {
      copied_files: number;
      skipped_existing: number;
      blocked_files: number;
      bytes_copied: number;
      duration_ms: number;
    } | null;
    stop_reason_code: string | null;
    stop_reason_detail: string | null;
    previous_thread_id: string | null;
    previous_session_id: string | null;
    last_phase: PhaseMarkerName | null;
    last_phase_at: string | null;
    last_phase_detail: string | null;
    operator_explainer_hint: OperatorExplainerHint | null;
    recovery: import('../orchestrator').MissingToolOutputRecoveryState | null;
    missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
    transcript_tool_call_diagnostic_summary: ApiTranscriptToolCallDiagnosticSummary;
  }>;
  blocked: Array<ApiBudgetProjection & {
    issue_id: string;
    issue_identifier: string;
    attempt: number;
    blocked_at: string;
    worker_host: string | null;
    workspace_path: string | null;
    provisioner_type: string | null;
    branch_name: string | null;
    repo_root: string | null;
    workspace_exists: boolean;
    workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
    workspace_provisioned: boolean;
    workspace_is_git_worktree: boolean;
    copy_ignored_applied: boolean;
    copy_ignored_status: 'skipped' | 'success' | 'failed' | null;
    copy_ignored_summary: {
      copied_files: number;
      skipped_existing: number;
      blocked_files: number;
      bytes_copied: number;
      duration_ms: number;
    } | null;
    stop_reason_code: string;
    stop_reason_detail: string | null;
    worker_termination_result: import('../orchestrator').WorkerTerminationResult | null;
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
    previous_session_id: string | null;
    last_phase: PhaseMarkerName | null;
    last_phase_at: string | null;
    last_phase_detail: string | null;
    root_cause: ApiBlockedRootCauseProjection | null;
    current_operator_block: ApiCurrentOperatorBlockProjection;
    pending_input: {
      request_id: string | null;
      request_method: string | null;
      prompt_text: string | null;
      questions: Array<{
        id: string;
        prompt?: string;
        options?: Array<{ label: string; value?: string }>;
      }>;
      input_schema_type: 'options' | 'text' | 'unknown';
      input_required_at: string;
    } | null;
    tool_output_wait: {
      tool_name: string;
      call_id: string;
      thread_id: string | null;
      turn_id: string | null;
      session_id: string | null;
      elapsed_wait_ms: number;
      last_agent_message: string | null;
      evidence_source?: 'worker_event' | 'app_server_protocol' | 'session_transcript';
      recommended_actions: string[];
    } | null;
    transcript_tool_call_diagnostic_summary: ApiTranscriptToolCallDiagnosticSummary;
    last_input_submit: {
      submitted_at: string;
      request_id: string;
      resume_mode: 'native' | 'fallback';
      resume_reason_code: string;
    } | null;
    resume_history: Array<{
      submitted_at: string;
      request_id: string;
      resume_mode: 'native' | 'fallback';
      resume_reason_code: string;
      previous_thread_id: string | null;
      previous_session_id: string | null;
    }>;
    session_console: Array<{
      at: string;
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
    requires_manual_resume: boolean;
    awaiting_operator: boolean;
    awaiting_operator_reason_code: string;
    awaiting_operator_since: string;
    awaiting_operator_resume_nonce: number;
    quarantined_event_count: number;
    last_quarantined_event_at: string | null;
    ownership_conflict: {
      reason: 'pre_session_identity_conflict' | 'ownership_conflict';
      detected_at: string;
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
    breaker_active: boolean;
    breaker_hit_count: number;
    breaker_window_minutes: number;
    breaker_first_hit_at: string | null;
    breaker_last_hit_at: string | null;
    attempt_count_window?: number;
    window_minutes?: number;
    last_known_commit_sha?: string | null;
    last_progress_checkpoint_at?: string | null;
    progress_signals?: {
      commit_sha: string | null;
      checklist_checkpoint: string | null;
      state_marker: string | null;
      tracker_comment_created?: boolean;
      tracker_status_transition?: string | null;
      agent_review_handoff?: string | null;
      tracker_started_state?: string | null;
    };
    required_actions?: string[];
    resume_override_reason?: string | null;
    turn_control_state: TurnControlState;
    turn_control_reason_code: string | null;
    turn_control_since_ms: number | null;
    progress_signal_state: ProgressSignalState;
    last_progress_transition_at_ms: number | null;
    last_heartbeat_at_ms: number | null;
    operator_actions: OperatorActionProjection[];
    recovery: import('../orchestrator').MissingToolOutputRecoveryState | null;
    missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
    operator_explainer_hint: OperatorExplainerHint | null;
    runtime_state_kind: 'blocked_input' | 'automation_fault';
    available_actions: ApiAvailableOperatorAction[];
  }>;
  stopped_runs: Array<{
    run_id: string;
    issue_id: string;
    issue_identifier: string;
    terminal_status: string;
    terminal_reason_code: string | null;
    terminal_reason_detail: string | null;
    root_cause_status: string | null;
    root_cause_reason_code: string | null;
    root_cause_reason_detail: string | null;
    root_cause_at: string | null;
    thread_id: string | null;
    turn_id: string | null;
    session_id: string | null;
    last_relevant_at: string;
    active_issue_present: boolean;
    recovery_status: 'inspect_forensics' | 'resume_available' | 'resume_unavailable' | 'active_issue_present' | 'capability_mismatch';
    resume_valid: boolean;
    resume_disabled_reason: string | null;
    capability_mismatch: boolean;
    capability_warning: ThreadDiagnosticsCapabilityWarning | null;
    actions: {
      inspect_forensics_url: string;
      inspect_thread_url: string | null;
      resume_url: string | null;
      acknowledge_supported: true;
      copy_thread_id_supported: boolean;
      copy_session_id_supported: boolean;
    };
  }>;
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    token_split_status?: 'available' | 'aggregate_only';
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
    model_context_window?: number;
    seconds_running: number;
  };
  provider_totals: Array<{
    runtime: 'claude-cli';
    effective_model: string | null;
    invocation_count: number;
    final_invocation_count: number;
    partial_invocation_count: number;
    unobserved_invocation_count: number;
    missing_invocation_count: number;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    provider_turn_count: number | null;
    estimated_cost_usd: number | null;
    updated_at: string | null;
  }>;
  rate_limits: Record<string, unknown> | null;
  health: {
    dispatch_validation: 'ok' | 'failed';
    last_error: string | null;
    control_plane?: ControlPlaneHealthSummary;
  };
  throughput: {
    current_tps: number;
    avg_tps_60s: number;
    window_seconds: number;
    sparkline_10m: number[];
    sample_count: number;
  };
  recent_runtime_events: Array<{
    at: string;
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

export interface ApiDrainModeProjection {
  active: boolean;
  entered_at: string | null;
  entered_at_ms: number | null;
  updated_at: string | null;
  updated_at_ms: number | null;
  reason: string | null;
}

export interface ApiRuntimeBuildIdentityProjection {
  process_started_at: string;
  process_started_at_ms: number;
  running_build: {
    identity: string | null;
    commit_sha: string | null;
    source_timestamp: string | null;
    source_timestamp_ms: number | null;
  };
  current_build: {
    identity: string | null;
    commit_sha: string | null;
    source_timestamp: string | null;
    source_timestamp_ms: number | null;
    status: 'available' | 'unknown';
  };
  status: 'current' | 'stale' | 'unknown_current';
  health_warning: {
    code: 'stale_runtime_build' | 'unknown_current_build_identity';
    severity: 'warning' | 'degraded';
    message: string;
    recommended_action: string;
  } | null;
}

export type ApiRuntimeUpdateState =
  | 'no_remote_configured'
  | 'fetch_unavailable'
  | 'remote_update_available'
  | 'local_checkout_behind'
  | 'runtime_stale'
  | 'source_changed_build_not_updated'
  | 'build_current'
  | 'dirty_worktree'
  | 'branch_mismatch'
  | 'non_fast_forward_required'
  | 'unknown';

export type ApiRuntimeUpdateRecommendedAction =
  | 'none'
  | 'retry_fetch'
  | 'prepare_update'
  | 'wait_for_quiescence'
  | 'apply_update'
  | 'reconnect_dashboard'
  | 'manual_restart'
  | 'inspect_worktree'
  | 'resolve_branch'
  | 'resolve_history'
  | 'rebuild'
  | 'inspect_status';

export type ApiRuntimeUpdateGithubEligibilityState =
  | 'github_verified'
  | 'github_checks_pending'
  | 'github_checks_failed'
  | 'github_unavailable'
  | 'github_not_configured'
  | 'github_candidate_unknown'
  | 'github_checks_absent_allowed'
  | 'github_trusted_raw_git';

export interface ApiRuntimeUpdateGithubEligibility {
  mode: 'required' | 'allow_absent_checks' | 'trust_raw_git';
  state: ApiRuntimeUpdateGithubEligibilityState;
  provider: 'github' | 'none';
  owner: string | null;
  repo: string | null;
  base_ref: string | null;
  candidate_sha: string | null;
  checked_at: string | null;
  reason_code: string | null;
  check_summary: {
    total: number | null;
    succeeded: number | null;
    pending: number | null;
    failed: number | null;
    skipped: number | null;
  };
}

export interface ApiRuntimeUpdateReadiness {
  state: ApiRuntimeUpdateState;
  attention_required: boolean;
  drain_required: boolean;
  running_runtime_identity: ApiRuntimeBuildIdentityProjection | null;
  local_checkout: {
    branch: string | null;
    commit_sha: string | null;
    dirty: boolean | null;
    detached: boolean;
  };
  fetched_remote: {
    remote: string | null;
    base_ref: string | null;
    commit_sha: string | null;
  };
  ahead_behind: {
    ahead: number | null;
    behind: number | null;
  };
  last_fetch: {
    attempted_at: string | null;
    completed_at: string | null;
    result: 'not_attempted' | 'succeeded' | 'failed' | 'timeout' | 'skipped';
    reason_code: string | null;
  };
  build_status: 'unknown' | 'runtime_stale' | 'source_changed_build_not_updated' | 'current';
  recommended_action: ApiRuntimeUpdateRecommendedAction;
  refusal_reasons: string[];
  github_eligibility: ApiRuntimeUpdateGithubEligibility;
  prepared_update: {
    remote: string | null;
    base_ref: string | null;
    candidate_sha: string | null;
    local_sha_before_prepare: string | null;
    prepared_at: string;
    github_eligibility: ApiRuntimeUpdateGithubEligibility;
  } | null;
  prepared: boolean;
  apply_ready: boolean;
}

export type ApiRuntimeRestartCapabilityMode = 'supervisor_available' | 'manual_restart_required' | 'unknown';

export type ApiRuntimeRestartPhase =
  | 'idle'
  | 'restart_ready'
  | 'restarting'
  | 'completed'
  | 'failed'
  | 'manual_restart_required';

export interface ApiDashboardAssetVerification {
  ok: boolean;
  checked_at: string;
  revision: string | null;
  reason_code: string | null;
  detail: string | null;
  checks: Array<{
    path: string;
    status_code: number | null;
    duration_ms: number;
    cache_control: string | null;
    body_contains_revision: boolean;
    error: string | null;
  }>;
}

export interface ApiRuntimeRestartStatus {
  capability: {
    mode: ApiRuntimeRestartCapabilityMode;
    available: boolean;
    reason_code: string | null;
    detail: string;
  };
  phase: ApiRuntimeRestartPhase;
  attempt_id: string | null;
  requested_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  old_child_pid: number | null;
  new_child_pid: number | null;
  target_commit_sha: string | null;
  observed_running_commit_sha: string | null;
  dashboard_asset_verification?: ApiDashboardAssetVerification | null;
  recommended_manual_recovery: string | null;
  last_error: {
    reason_code: string;
    message: string;
  } | null;
}

export interface ApiRuntimeUpdateActionResponse {
  success: boolean;
  status:
    | 'draining'
    | 'waiting_for_quiescence'
    | 'applying'
    | 'ready_to_restart'
    | 'manual_restart_required'
    | 'completed'
    | 'failed'
    | 'refused'
    | 'timeout';
  step: 'prepare' | 'apply' | 'fetch' | 'pull' | 'install' | 'build' | 'restart' | 'manual_restart';
  reason_code?: string | null;
  recommended_action: ApiRuntimeUpdateRecommendedAction;
  idempotent_replay: boolean;
  drain_mode?: ApiDrainModeProjection;
  quiescence?: ApiDrainQuiescenceProjection;
  blockers?: ApiDrainControlBlocker[];
  readiness?: ApiRuntimeUpdateReadiness | null;
  command_results?: Array<{
    step: 'fetch' | 'pull' | 'install' | 'build';
    command: string[];
    cwd: string;
    status: 'succeeded' | 'failed' | 'timeout' | 'skipped';
    exit_code: number | null;
    duration_ms: number;
    stdout_excerpt: string;
    stderr_excerpt: string;
    reason_code: string | null;
  }>;
  restart?: {
    mode: 'manual' | 'wrapper';
    status: 'manual_restart_required' | 'restarting' | 'completed' | 'failed' | 'unavailable';
    command: string[];
    reason_code: string | null;
    attempt_id?: string | null;
  } | null;
  message?: string | null;
}

export interface ApiDrainQuiescenceProjection {
  safe_to_shutdown: boolean;
  state: 'safe' | 'blocked';
  updated_at: string;
  updated_at_ms: number;
  blockers: Array<{
    category:
      | 'active_worker'
      | 'live_codex_app_server_process'
      | 'pending_retry'
      | 'in_flight_tracker_write'
      | 'persistence_history_write'
      | 'unknown_degraded_blocker_source_health'
      | 'stale_runtime'
      | 'unknown_current_build_identity';
    count: number;
    detail: string;
    issue_identifiers: string[];
    run_identifiers?: string[];
    thread_identifiers?: string[];
  }>;
  blocker_counts: Record<
    | 'active_worker'
    | 'live_codex_app_server_process'
    | 'pending_retry'
    | 'in_flight_tracker_write'
    | 'persistence_history_write'
    | 'unknown_degraded_blocker_source_health'
    | 'stale_runtime'
    | 'unknown_current_build_identity',
    number
  >;
  warnings?: Array<{
    category: 'stale_runtime_warning' | 'unknown_current_build_identity_warning' | 'persistence_history_degraded';
    count: number;
    detail: string;
    source: 'dispatch_safety' | 'audit_health';
    recommended_action?: string;
  }>;
  restart_guidance?: {
    safe_to_restart: boolean;
    recommended_action: 'none' | 'wait_for_true_shutdown_blockers' | 'restart_runtime_to_current_build';
    pending_work: Array<{
      state: string;
      count: number;
      maintenance_eligible: boolean;
    }>;
    detail: string;
  };
}

export interface ApiDrainControlBlocker {
  category: ApiDrainQuiescenceProjection['blockers'][number]['category'];
  count: number;
  issue_identifiers: string[];
  run_identifiers: string[];
  thread_identifiers: string[];
  reason: string;
}

export interface ApiDrainWaitResponse {
  success: boolean;
  status: 'safe_to_shutdown' | 'timeout';
  reason: 'quiescent' | 'timeout';
  waited_ms: number;
  timed_out: boolean;
  quiescence: ApiDrainQuiescenceProjection;
  blockers: ApiDrainControlBlocker[];
}

export interface ApiDrainShutdownResponse {
  success: boolean;
  status: 'shutdown_requested' | 'blocked';
  mode: 'default' | 'override';
  reason: 'quiescent' | 'operator_override' | 'blockers_present';
  message: string;
  requested_at: string;
  requested_at_ms: number;
  idempotent_replay: boolean;
  quiescence: ApiDrainQuiescenceProjection;
  blockers: ApiDrainControlBlocker[];
}

export type ApiStateErrorCode = 'snapshot_timeout' | 'snapshot_unavailable';

export interface ApiStateErrorResponse {
  generated_at: string;
  error: {
    code: ApiStateErrorCode;
    message: string;
  };
}

export type ApiStateSnapshotResponse = ApiStateResponse | ApiStateErrorResponse;

export interface ApiIssueResponse extends SnapshotFreshnessFields, ApiDegradedFields {
  issue_identifier: string;
  issue_id: string;
  review_approval_actions?: ReviewApprovalActionRecord[];
  status: 'running' | 'retrying' | 'blocked';
  operator_actions: OperatorActionProjection[];
  operator_explainer: OperatorExplainer;
  workspace: {
    path: string | null;
    host: string | null;
  };
  attempts: {
    restart_count: number;
    current_retry_attempt: number;
  };
  running: (ApiBudgetProjection & {
    session_id: string | null;
    worker_host: string | null;
    workspace_path: string | null;
    provisioner_type: string | null;
    branch_name: string | null;
    repo_root: string | null;
    workspace_exists: boolean;
    workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
    workspace_provisioned: boolean;
    workspace_is_git_worktree: boolean;
    copy_ignored_applied: boolean;
    copy_ignored_status: 'skipped' | 'success' | 'failed' | null;
    copy_ignored_summary: {
      copied_files: number;
      skipped_existing: number;
      blocked_files: number;
      bytes_copied: number;
      duration_ms: number;
    } | null;
    thread_id: string | null;
    turn_id: string | null;
    codex_app_server_pid: string | null;
    agent_runtime: 'codex-app-server' | 'claude-cli' | null;
    worker_process_pid: string | null;
    provider_usage: ProviderUsage | null;
    turn_count: number;
    state: string;
    dispatch_state: string;
    started_at: string;
    last_event: string | null;
    last_event_summary: string | null;
    last_message: string | null;
    awaiting_input: boolean;
    awaiting_input_since_ms: number | null;
    pending_input_preview: {
      type: string;
      prompt_preview: string | null;
      option_count: number | null;
    } | null;
    stalled_waiting: boolean;
    stalled_waiting_since_ms: number | null;
    stalled_waiting_reason: typeof REASON_CODES.turnWaitingThresholdExceeded | null;
    current_phase: PhaseMarkerName | null;
    current_phase_at: string | null;
    phase_elapsed_ms: number | null;
    phase_timing: ApiPhaseTimingProjection;
    phase_detail: string | null;
    last_event_at: string | null;
    codex_thread_activity: ApiCodexThreadActivityProjection;
    token_telemetry_status: 'unavailable' | 'pending' | 'available';
    token_telemetry_last_source: string | null;
    token_telemetry_last_at_ms: number | null;
    token_telemetry_confidence: TokenTelemetryConfidence;
    token_telemetry_source: string | null;
    token_telemetry_last_observed_at_ms: number | null;
    turn_control_state: TurnControlState;
    turn_control_reason_code: string | null;
    turn_control_since_ms: number | null;
    progress_signal_state: ProgressSignalState;
    last_progress_transition_at_ms: number | null;
    last_heartbeat_at_ms: number | null;
    quarantined_event_count: number;
    last_quarantined_event_at: string | null;
    not_blocked_explainer_code: NotBlockedExplainerCode;
    not_blocked_explainer_text: string | null;
    operator_actions: OperatorActionProjection[];
    conversation_latest: ApiAgentConversationProjection['latest'];
    transcript_tool_call_diagnostic_summary: ApiTranscriptToolCallDiagnosticSummary;
    rate_limits: Record<string, unknown> | null;
    protocol_warnings: CodexProtocolWarningEvidence[];
    model_reroute: CodexModelRerouteEvidence | null;
    requested_model: string | null;
    effective_model: string | null;
    tokens: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      token_split_status?: 'available' | 'aggregate_only';
      cached_input_tokens?: number;
      reasoning_output_tokens?: number;
      model_context_window?: number;
    };
    recovery: import('../orchestrator').MissingToolOutputRecoveryState | null;
    missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
    codex_session_transcript_scan_budget: ApiCodexSessionTranscriptScanBudget | null;
  }) | null;
  retry: (ApiBudgetProjection & {
    attempt: number;
    due_at: string;
    due_at_ms: number;
    due_state: ApiRetryDueState;
    overdue_ms: number | null;
    retry_wait_ms: number | null;
    retry_cause: ApiRetryCauseProjection;
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
    copy_ignored_applied: boolean;
    copy_ignored_status: 'skipped' | 'success' | 'failed' | null;
    copy_ignored_summary: {
      copied_files: number;
      skipped_existing: number;
      blocked_files: number;
      bytes_copied: number;
      duration_ms: number;
    } | null;
    stop_reason_code: string | null;
    stop_reason_detail: string | null;
    previous_thread_id: string | null;
    previous_session_id: string | null;
    last_phase: PhaseMarkerName | null;
    last_phase_at: string | null;
    last_phase_detail: string | null;
    missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
    runtime_state_kind: 'blocked_input' | 'automation_fault';
    available_actions: ApiAvailableOperatorAction[];
  }) | null;
  blocked: (ApiBudgetProjection & {
    attempt: number;
    blocked_at: string;
    worker_host: string | null;
    workspace_path: string | null;
    provisioner_type: string | null;
    branch_name: string | null;
    repo_root: string | null;
    workspace_exists: boolean;
    workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
    workspace_provisioned: boolean;
    workspace_is_git_worktree: boolean;
    copy_ignored_applied: boolean;
    copy_ignored_status: 'skipped' | 'success' | 'failed' | null;
    copy_ignored_summary: {
      copied_files: number;
      skipped_existing: number;
      blocked_files: number;
      bytes_copied: number;
      duration_ms: number;
    } | null;
    stop_reason_code: string;
    stop_reason_detail: string | null;
    worker_termination_result: import('../orchestrator').WorkerTerminationResult | null;
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
    previous_session_id: string | null;
    last_phase: PhaseMarkerName | null;
    last_phase_at: string | null;
    last_phase_detail: string | null;
    root_cause: ApiBlockedRootCauseProjection | null;
    current_operator_block: ApiCurrentOperatorBlockProjection;
    pending_input: {
      request_id: string | null;
      request_method: string | null;
      prompt_text: string | null;
      questions: Array<{
        id: string;
        prompt?: string;
        options?: Array<{ label: string; value?: string }>;
      }>;
      input_schema_type: 'options' | 'text' | 'unknown';
      input_required_at: string;
    } | null;
    tool_output_wait: {
      tool_name: string;
      call_id: string;
      thread_id: string | null;
      turn_id: string | null;
      session_id: string | null;
      elapsed_wait_ms: number;
      last_agent_message: string | null;
      evidence_source?: 'worker_event' | 'app_server_protocol' | 'session_transcript';
      recommended_actions: string[];
    } | null;
    transcript_tool_call_diagnostic_summary: ApiTranscriptToolCallDiagnosticSummary;
    last_input_submit: {
      submitted_at: string;
      request_id: string;
      resume_mode: 'native' | 'fallback';
      resume_reason_code: string;
    } | null;
    resume_history: Array<{
      submitted_at: string;
      request_id: string;
      resume_mode: 'native' | 'fallback';
      resume_reason_code: string;
      previous_thread_id: string | null;
      previous_session_id: string | null;
    }>;
    session_console: Array<{
      at: string;
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
    requires_manual_resume: boolean;
    awaiting_operator: boolean;
    awaiting_operator_reason_code: string;
    awaiting_operator_since: string;
    awaiting_operator_resume_nonce: number;
    quarantined_event_count: number;
    last_quarantined_event_at: string | null;
    breaker_active: boolean;
    breaker_hit_count: number;
    breaker_window_minutes: number;
    breaker_first_hit_at: string | null;
    breaker_last_hit_at: string | null;
    attempt_count_window?: number;
    window_minutes?: number;
    last_known_commit_sha?: string | null;
    last_progress_checkpoint_at?: string | null;
    progress_signals?: {
      commit_sha: string | null;
      checklist_checkpoint: string | null;
      state_marker: string | null;
      tracker_comment_created?: boolean;
      tracker_status_transition?: string | null;
      agent_review_handoff?: string | null;
      tracker_started_state?: string | null;
    };
    required_actions?: string[];
    resume_override_reason?: string | null;
    turn_control_state: TurnControlState;
    turn_control_reason_code: string | null;
    turn_control_since_ms: number | null;
    progress_signal_state: ProgressSignalState;
    last_progress_transition_at_ms: number | null;
    last_heartbeat_at_ms: number | null;
    operator_actions: OperatorActionProjection[];
    recovery: import('../orchestrator').MissingToolOutputRecoveryState | null;
    missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
  }) | null;
  phase_timeline: Array<{
    at: string;
    phase: PhaseMarkerName;
    detail: string | null;
    attempt: number;
    thread_id: string | null;
    session_id: string | null;
  }>;
  conversation: ApiAgentConversationProjection;
  recent_events: Array<{
    at: string;
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
  stale_events: Array<{
    at: string;
    event: string;
    message: string | null;
    codex_app_server_pid: string | null;
    session_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
    active_codex_app_server_pid: string | null;
    worker_instance_id: string | null;
    active_worker_instance_id: string | null;
    run_id: string | null;
    issue_run_id: string | null;
    attempt_id: string | null;
    active_run_id: string | null;
    active_issue_run_id: string | null;
    active_attempt_id: string | null;
    active_session_id: string | null;
    active_thread_id: string | null;
    active_turn_id: string | null;
    reason: 'lineage_mismatch' | 'worker_identity_mismatch' | 'inactive_worker_pid' | 'terminal_residue';
  }>;
  last_error: string | null;
  logs: {
    codex_session_logs: string[];
  };
  tracked: Record<string, unknown>;
}

export interface ApiRefreshAcceptedResponse {
  queued: true;
  coalesced: boolean;
  requested_at: string;
  operations: ['poll', 'reconcile'];
}

export type ThreadDiagnosticsStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'stalled';

export type ThreadDiagnosticsBlockerClassification =
  | typeof REASON_CODES.missingToolOutput
  | 'stalled_waiting'
  | 'tool_waiting_long'
  | 'tracker_transition_pending'
  | 'input_required_pending'
  | 'codex_no_progress'
  | 'workspace_integrity_conflict'
  | 'retry_backoff_wait';

export interface ThreadDiagnosticsEvent {
  at_ms: number;
  event: string;
  reason_code: string | null;
  reason_detail: string | null;
  request_method?: string | null;
  request_category?: string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  protocol_warning?: CodexProtocolWarningEvidence;
  model_reroute?: CodexModelRerouteEvidence | null;
  requested_model?: string | null;
  effective_model?: string | null;
  thread_id: string;
  turn_id: string | null;
  session_id: string | null;
}

export interface ThreadDiagnosticsPhaseSpan {
  phase: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  duration_ms: number | null;
  status: string;
  reason_code: string | null;
  reason_detail: string | null;
}

export interface ThreadDiagnosticsToolSpan {
  tool_name: string;
  turn_id: string | null;
  started_at_ms: number;
  ended_at_ms: number | null;
  duration_ms: number | null;
  status: string;
  reason_code: string | null;
  reason_detail: string | null;
}

export interface ThreadDiagnosticsWaitSpan {
  started_at_ms: number;
  ended_at_ms: number | null;
  duration_ms: number | null;
  status: string;
  reason_code: string | null;
  reason_detail: string | null;
}

export interface ThreadDiagnosticsBlocker {
  classification: ThreadDiagnosticsBlockerClassification;
  reason_code: string | null;
  reason_detail: string | null;
  time_since_progress: number | null;
  actionability: 'none' | 'recommended' | 'required';
  recommended_actions: string[];
  expected_auto_transition: string | null;
  tool_output_wait?: import('../orchestrator').BlockedEntry['tool_output_wait'];
  missing_tool_output_recovery?: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
}

export interface ThreadDiagnosticsCapabilityWarning {
  reason_code: string;
  source_environment: 'console_tui';
  attempted_tool_name: string | null;
  call_id: string | null;
  thread_id: string;
  turn_id: string | null;
  unsupported_capability_message: string;
  recommended_recovery_action: string;
}

export interface ThreadDiagnosticsResponse {
  thread_id: string;
  issue_identifier: string;
  attempt: number;
  status: ThreadDiagnosticsStatus;
  timeline: ThreadDiagnosticsEvent[];
  phase_spans: ThreadDiagnosticsPhaseSpan[];
  tool_spans: ThreadDiagnosticsToolSpan[];
  wait_spans: ThreadDiagnosticsWaitSpan[];
  capability_warnings: ThreadDiagnosticsCapabilityWarning[];
  current_blocker: ThreadDiagnosticsBlocker | null;
  last_meaningful_progress_at_ms: number | null;
}

export type ApiEventType = 'state_snapshot' | 'refresh_accepted' | 'runtime_health_changed' | 'heartbeat';

export interface ApiEventEnvelope {
  event_id: number;
  generated_at: string;
  type: ApiEventType;
  payload: unknown;
}

export interface LocalApiServerOptions {
  host?: string;
  port?: number;
  snapshotSource: RuntimeSnapshotSource;
  refreshSource: RefreshTickSource;
  refreshCoalesceWindowMs?: number;
  diagnosticsSource?: DiagnosticsSource;
  drainControlSource?: {
    readDrainMode: () => DrainModeState;
    enterDrainMode: (params?: { reason?: string | null }) => DrainModeState;
    exitDrainMode: (params?: { reason?: string | null }) => DrainModeState;
  };
  drainAuditSink?: {
    appendDrainAuditHistory: (params: {
      event_type:
        | 'wait-started'
        | 'wait-timed-out'
        | 'quiescence-reached'
        | 'safe-shutdown-allowed'
        | 'safe-shutdown-refused'
        | 'update-detected'
        | 'update-prepare-requested'
        | 'update-drain-entered'
        | 'update-quiescence-reached'
        | 'update-fetch-started'
        | 'update-fetch-succeeded'
        | 'update-fetch-failed'
        | 'update-pull-started'
        | 'update-pull-succeeded'
        | 'update-pull-failed'
        | 'update-pull-refused'
        | 'update-install-started'
        | 'update-install-succeeded'
        | 'update-install-failed'
        | 'update-install-skipped'
        | 'update-build-started'
        | 'update-build-succeeded'
        | 'update-build-failed'
        | 'update-build-skipped'
        | 'update-restart-requested'
        | 'update-restart-refused'
        | 'update-restart-ready'
        | 'update-restart-started'
        | 'update-old-child-shutdown-requested'
        | 'update-old-child-exited'
        | 'update-new-child-spawned'
        | 'update-new-child-ready'
        | 'update-dashboard-assets-verified'
        | 'update-dashboard-assets-failed'
        | 'update-reconnect-observed'
        | 'update-restart-completed'
        | 'update-restart-failed'
        | 'update-manual-restart-required';
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
    recordHistoryWriteFailure?: (operation: string, reasonCode: string, error: unknown) => Promise<void>;
  };
  shutdownSource?: {
    shutdown: () => Promise<void>;
  };
  runtimeUpdateSource?: {
    readUpdateReadiness: () => ApiRuntimeUpdateReadiness | null;
    readRestartStatus?: () => ApiRuntimeRestartStatus;
    recordReconnectObserved?: () => Promise<void>;
    prepareUpdate: (params: { drain_mode: ApiDrainModeProjection }) => Promise<ApiRuntimeUpdateActionResponse>;
    applyUpdate: (params: { quiescence: ApiDrainQuiescenceProjection }) => Promise<ApiRuntimeUpdateActionResponse>;
  };
  workflowControlSource?: {
    switchWorkflowPath: (workflowPath: string) => Promise<{
      workflow_path: string;
      applied: boolean;
      error?: string;
    }>;
    forceReload: () => Promise<{
      workflow_path: string;
      applied: boolean;
      error?: string;
    }>;
  };
  issueControlSource?: {
    cancelCurrentTurn?: (
      issueIdentifier: string,
      params: { actor?: string; reason_note?: string; confirmed?: boolean }
    ) => Promise<{ ok: true; issue_id: string } | { ok: false; code: string; message: string }>;
    requeueIssue?: (
      issueIdentifier: string,
      params: { actor?: string; reason_note?: string; confirmed?: boolean }
    ) => Promise<{ ok: true; issue_id: string; retry_attempt: number } | { ok: false; code: string; message: string }>;
    retryLastFailedStep?: (
      issueIdentifier: string,
      params: { actor?: string; reason_note?: string }
    ) => Promise<{ ok: true; issue_id: string; retry_attempt: number } | { ok: false; code: string; message: string }>;
    clearAutomationFault?: (
      issueIdentifier: string,
      params: { actor?: string; reason_note?: string }
    ) => Promise<
      | {
          ok: true;
          issue_id: string;
          status: 'started' | 'held';
          result_code: string;
          message: string;
          dispatch_started: boolean;
          breaker_cleared: boolean;
        }
      | { ok: false; code: string; message: string }
    >;
    resumeBlockedIssue: (issueIdentifier: string, params?: { resume_override_reason?: string; actor?: string; reason_note?: string }) => Promise<
      { ok: true; issue_id: string } | { ok: false; code: string; message: string }
    >;
    cancelBlockedIssue: (issueIdentifier: string, params?: { cancel_reason?: string; actor?: string; reason_note?: string; confirmed?: boolean }) => Promise<
      { ok: true; issue_id: string; moved_to_state: string } | { ok: false; code: string; message: string }
    >;
    submitBlockedIssueInput: (params: {
      issueIdentifier: string;
      request_id: string;
      actor?: string;
      reason_note: string;
      answer: { question_id?: string; option_label?: string; text?: string };
    }) => Promise<
      | {
          ok: true;
          issue_id: string;
          request_id: string;
          resume_mode: 'native' | 'fallback';
          resume_reason_code: string;
          requested_at: string;
          request_lineage: { previous_thread_id: string | null; previous_session_id: string | null };
        }
      | { ok: false; code: string; message: string }
    >;
  };
  dashboardConfig?: {
    dashboard_enabled: boolean;
    refresh_ms: number;
    render_interval_ms: number;
    phase_stale_warn_ms?: number;
    asset_revision?: string | null;
  };
  nowMs?: () => number;
  requestTimingNowMs?: () => number;
  logger?: StructuredLogger;
  codexStateDbPath?: string;
  controlPlaneHealth?: {
    sampleLimit?: number;
    thresholds?: Partial<ControlPlaneThresholds>;
  };
  controlPlaneHealthRecorder?: ControlPlaneHealthRecorder;
  eventLoopHealthMonitor?: EventLoopHealthMonitor;
}

export interface ApiDiagnosticsResponse {
  runtime_identity: ApiRuntimeBuildIdentityProjection | null;
  dashboard_asset_revision?: string | null;
  runtime_update: ApiRuntimeUpdateReadiness | null;
  runtime_restart: ApiRuntimeRestartStatus;
  drain_mode: ApiDrainModeProjection;
  quiescence: ApiDrainQuiescenceProjection;
  active_profile: SecurityProfile;
  persistence: PersistenceHealth;
  logging: {
    root: string;
    active_file: string;
    rotation: {
      max_bytes: number;
      max_files: number;
    };
    sinks: string[];
  };
  event_vocabulary_version: string;
  token_accounting: {
    mode: 'strict_canonical';
    canonical_precedence: [
      'terminal_turn_summary',
      'thread/tokenUsage/updated.params.tokenUsage.total',
      'params.info.total_token_usage',
      'params.info.totalTokenUsage',
      'params.total_token_usage',
      'params.totalTokenUsage',
      'params.usage.total_token_usage',
      'params.usage.totalTokenUsage',
      'last_token_usage',
      'persisted_fallback_usage'
    ];
    excludes_generic_usage_for_totals: true;
    excludes_last_usage_for_totals: false;
    no_telemetry_warning_threshold_ms: number;
    optional_dimensions: ['cached_input_tokens', 'reasoning_output_tokens', 'model_context_window'];
    observed_dimensions: {
      cached_input_tokens: boolean;
      reasoning_output_tokens: boolean;
      model_context_window: boolean;
    };
  };
  token_telemetry_status: 'unavailable' | 'pending' | 'available';
  token_telemetry_last_source: string | null;
  token_telemetry_last_at_ms: number | null;
  token_enrichment: {
    status: 'not_required' | 'available' | 'degraded';
    degraded: boolean;
    reason_code: string | null;
    duration_ms: number;
  };
  workflow: {
    prompt_fallback_active: boolean;
  };
  project_layout: ApiProjectLayoutDiagnostics | null;
  runtime_resolution: {
    workflow_path: string;
    workflow_dir: string;
    workspace_root: string;
    workspace_root_source: 'workflow' | 'default';
    server: {
      host: string;
      port: number | null;
    };
    provisioner_type: string;
    repo_root: string | null;
    base_ref: string | null;
    branch_name_template: string | null;
    effective_codex_home: string | null;
    effective_codex_model: string | null;
    effective_reasoning_effort: string | null;
    effective_extra_flags_count: number;
    codex_resolution_mode: 'typed' | 'legacy' | 'mixed';
  };
  workspace_provisioner: {
    provisioner_type: string;
    repo_root: string | null;
    base_ref: string | null;
    branch_name_template: string | null;
    last_provision_result: 'provisioned' | 'reused' | 'skipped' | 'failed' | null;
    last_teardown_result: 'removed' | 'kept' | 'skipped' | 'failed' | null;
    last_error_code: string | null;
    last_verification_result: 'verified' | 'reprovisioned' | 'failed' | null;
    last_cleanup_on_failure_result: 'cleaned' | 'cleanup_failed' | 'not_attempted' | null;
    verification_mode: 'strict' | 'none';
  };
  workspace_copy_ignored: {
    enabled: boolean;
    include_file: string;
    from: 'primary_worktree' | 'repo_root';
    conflict_policy: 'skip' | 'overwrite' | 'fail';
    require_gitignored: boolean;
    max_files: number;
    max_total_bytes: number;
    last_status: 'start' | 'success' | 'skipped' | 'failed' | null;
    last_error_code: string | null;
    last_error_message: string | null;
    source_path: string | null;
    copied_files: number;
    skipped_existing: number;
    blocked_files: number;
    bytes_copied: number;
    duration_ms: number;
  };
  phase_markers: {
    enabled: boolean;
    timeline_limit: number;
    last_emit_error_code: string | null;
  };
  breaker_statuses: Array<{
    issue_id: string;
    issue_identifier: string;
    breaker_active: boolean;
    breaker_hit_count: number;
    breaker_window_minutes: number;
    breaker_first_hit_at: string | null;
    breaker_last_hit_at: string | null;
  }>;
  blocked_latch: {
    blocked_latch_active_count: number;
    blocked_event_quarantine_total: number;
    blocked_event_allowlist_total: number;
    blocked_event_reject_total: number;
    blocked_latch_violation_total: number;
  };
  stream: {
    live_client_count: number;
    last_client_connected_at: string | null;
    last_client_disconnected_at: string | null;
    last_snapshot_broadcast_at: string | null;
    last_snapshot_broadcast_latency_ms: number | null;
    last_snapshot_broadcast_status: 'ok' | 'failed' | 'no_clients' | null;
    last_snapshot_broadcast_error: string | null;
  };
  control_plane: ControlPlaneHealthSummary;
  worker_event_pressure: ApiWorkerEventPressure;
}

export interface ApiWorkerEventPressure {
  active_worker_count: number;
  waiting_worker_count: number;
  stalled_waiting_worker_count: number;
  rate_limited_worker_count: number;
  recent_worker_event_count: number;
  recent_planning_event_count: number;
  recent_waiting_event_count: number;
  recent_rate_limit_event_count: number;
  last_worker_event_at: string | null;
  last_worker_event_at_ms: number | null;
  degraded: boolean;
  reason_code: string | null;
}
