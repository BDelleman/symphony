import type { Issue } from '../../tracker';
import type {
  BlockedEntry,
  CircuitBreakerEntry,
  CodexSessionTranscriptScanBudget,
  DispatchBackpressureState,
  OperatorActionRecord,
  ReleasedWorkerRecord,
  RetryEntry,
  RunningEntry,
  StateSnapshotOptions,
  TranscriptToolCallDiagnostic,
  TranscriptToolCallDiagnosticStats,
  WorkerTerminationResult
} from '../types';

export function cloneWorkerTerminationResult(result: WorkerTerminationResult): WorkerTerminationResult {
  return { ...result };
}

export function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blocked_by: issue.blocked_by.map((blocker) => ({
      id: blocker.id,
      identifier: blocker.identifier,
      state: blocker.state
    })),
    created_at: issue.created_at ? new Date(issue.created_at.getTime()) : null,
    updated_at: issue.updated_at ? new Date(issue.updated_at.getTime()) : null
  };
}

export function cloneDispatchBackpressureState(state: DispatchBackpressureState): DispatchBackpressureState {
  return { ...state };
}

const emptyTranscriptToolCallDiagnosticStats = (): TranscriptToolCallDiagnosticStats => ({
  total_count: 0,
  newest_observed_at_ms: null,
  counts_by_lineage: {
    active_owned: 0,
    prior_stale: 0,
    external_manual: 0,
    unattributed: 0
  },
  counts_by_kind: {
    function_call: 0,
    function_call_output: 0
  }
});

function summarizeTranscriptToolCallDiagnostics(
  diagnostics: TranscriptToolCallDiagnostic[] | undefined
): TranscriptToolCallDiagnosticStats {
  const stats = emptyTranscriptToolCallDiagnosticStats();
  for (const diagnostic of diagnostics ?? []) {
    stats.total_count += 1;
    stats.counts_by_lineage[diagnostic.lineage] += 1;
    stats.counts_by_kind[diagnostic.kind] += 1;
    stats.newest_observed_at_ms =
      stats.newest_observed_at_ms === null
        ? diagnostic.observed_at_ms
        : Math.max(stats.newest_observed_at_ms, diagnostic.observed_at_ms);
  }
  return stats;
}

function cloneTranscriptToolCallDiagnostics(
  diagnostics: TranscriptToolCallDiagnostic[] | undefined,
  options: Required<StateSnapshotOptions>
): {
  transcript_tool_call_diagnostics?: TranscriptToolCallDiagnostic[];
  transcript_tool_call_diagnostic_stats?: TranscriptToolCallDiagnosticStats;
} {
  if (options.includeTranscriptToolCallDiagnostics) {
    return {
      transcript_tool_call_diagnostics: (diagnostics ?? []).map((diagnostic) => ({
        ...diagnostic
      })),
      transcript_tool_call_diagnostic_stats: undefined
    };
  }
  return {
    transcript_tool_call_diagnostics: undefined,
    transcript_tool_call_diagnostic_stats: summarizeTranscriptToolCallDiagnostics(diagnostics)
  };
}

function cloneCodexSessionTranscriptScanBudget(
  budget: CodexSessionTranscriptScanBudget | undefined
): CodexSessionTranscriptScanBudget | undefined {
  if (!budget) {
    return undefined;
  }
  return {
    ...budget,
    reason_codes: [...budget.reason_codes],
    limits: { ...budget.limits }
  };
}

export function cloneRunningEntry(entry: RunningEntry, options: Required<StateSnapshotOptions>): RunningEntry {
  return {
    ...entry,
    issue: cloneIssue(entry.issue),
    tokens: { ...entry.tokens },
    last_reported_tokens: { ...entry.last_reported_tokens },
    persisted_turn_ids: [...(entry.persisted_turn_ids ?? [])],
    pending_persisted_turn_ids: [...(entry.pending_persisted_turn_ids ?? [])],
    execution_graph_turn_indices: { ...(entry.execution_graph_turn_indices ?? {}) },
    recent_events: entry.recent_events.map((event) => ({ ...event })),
    quarantined_events: (entry.quarantined_events ?? []).map((event) => ({ ...event })),
    quarantined_event_count: entry.quarantined_event_count ?? 0,
    last_quarantined_event_at_ms: entry.last_quarantined_event_at_ms ?? null,
    copy_ignored_summary: entry.copy_ignored_summary ? { ...entry.copy_ignored_summary } : null,
    awaiting_input_since_ms: entry.awaiting_input_since_ms ?? null,
    pending_input_preview: entry.pending_input_preview ? { ...entry.pending_input_preview } : null,
    stalled_waiting_since_ms: entry.stalled_waiting_since_ms ?? null,
    stalled_waiting_reason: entry.stalled_waiting_reason ?? null,
    running_waiting_started_at_ms: entry.running_waiting_started_at_ms ?? null,
    last_progress_transition_at_ms: entry.last_progress_transition_at_ms ?? null,
    last_heartbeat_at_ms: entry.last_heartbeat_at_ms ?? null,
    heartbeat_only_event_emitted: entry.heartbeat_only_event_emitted ?? false,
    running_wait_stall_event_emitted: entry.running_wait_stall_event_emitted ?? false,
    progress_signals: entry.progress_signals ? { ...entry.progress_signals } : undefined,
    codex_thread_activity_at_ms: entry.codex_thread_activity_at_ms ?? null,
    codex_thread_activity_source: entry.codex_thread_activity_source ?? null,
    codex_thread_activity_status: entry.codex_thread_activity_status ?? null,
    current_phase: entry.current_phase,
    current_phase_at_ms: entry.current_phase_at_ms,
    phase_detail: entry.phase_detail,
    tool_call_ledger: Object.fromEntries(
      Object.entries(entry.tool_call_ledger ?? {}).map(([callId, call]) => [
        callId,
        {
          ...call,
          evidence_sources: [...call.evidence_sources]
        }
      ])
    ),
    outstanding_tool_calls: Object.fromEntries(
      Object.entries(entry.outstanding_tool_calls ?? {}).map(([callId, call]) => [callId, { ...call }])
    ),
    ...cloneTranscriptToolCallDiagnostics(entry.transcript_tool_call_diagnostics, options),
    codex_session_transcript_scan_offsets: { ...(entry.codex_session_transcript_scan_offsets ?? {}) },
    codex_session_transcript_scan_budget: cloneCodexSessionTranscriptScanBudget(
      entry.codex_session_transcript_scan_budget
    ),
    codex_session_transcript_candidate_cache: undefined,
    recovery: entry.recovery ? { ...entry.recovery } : null,
    termination: entry.termination ? { ...entry.termination } : null,
    ownership_conflict: entry.ownership_conflict ? { ...entry.ownership_conflict } : null,
    budget: entry.budget ? { ...entry.budget } : undefined
  };
}

export function cloneOperatorAction(entry: OperatorActionRecord): OperatorActionRecord {
  return { ...entry };
}

export function cloneReleasedWorkerRecord(entry: ReleasedWorkerRecord): ReleasedWorkerRecord {
  return { ...entry };
}

export function cloneRetryEntry(entry: RetryEntry): RetryEntry {
  return {
    issue_id: entry.issue_id,
    identifier: entry.identifier,
    attempt: entry.attempt,
    issue_run_id: entry.issue_run_id ?? null,
    previous_attempt_id: entry.previous_attempt_id ?? null,
    due_at_ms: entry.due_at_ms,
    error: entry.error,
    worker_host: entry.worker_host,
    workspace_path: entry.workspace_path,
    provisioner_type: entry.provisioner_type,
    branch_name: entry.branch_name,
    repo_root: entry.repo_root,
    workspace_exists: entry.workspace_exists,
    workspace_git_status: entry.workspace_git_status,
    workspace_provisioned: entry.workspace_provisioned,
    workspace_is_git_worktree: entry.workspace_is_git_worktree,
    copy_ignored_applied: entry.copy_ignored_applied,
    copy_ignored_status: entry.copy_ignored_status,
    copy_ignored_summary: entry.copy_ignored_summary ? { ...entry.copy_ignored_summary } : null,
    stop_reason_code: entry.stop_reason_code,
    stop_reason_detail: entry.stop_reason_detail,
    previous_thread_id: entry.previous_thread_id,
    previous_turn_id: entry.previous_turn_id ?? null,
    previous_session_id: entry.previous_session_id,
    last_progress_checkpoint_at: entry.last_progress_checkpoint_at ?? null,
    last_phase: entry.last_phase,
    last_phase_at_ms: entry.last_phase_at_ms,
    last_phase_detail: entry.last_phase_detail,
    timer_handle: entry.timer_handle,
    progress_signals: entry.progress_signals ? { ...entry.progress_signals } : undefined,
    recover_workspace_attempt_residue: entry.recover_workspace_attempt_residue ?? false,
    budget: entry.budget ? { ...entry.budget } : undefined,
    recovery: entry.recovery ? { ...entry.recovery } : null
  };
}

export function cloneBlockedEntry(entry: BlockedEntry, options: Required<StateSnapshotOptions>): BlockedEntry {
  return {
    issue_id: entry.issue_id,
    issue_identifier: entry.issue_identifier,
    attempt: entry.attempt,
    issue_run_id: entry.issue_run_id ?? null,
    previous_attempt_id: entry.previous_attempt_id ?? null,
    worker_host: entry.worker_host,
    workspace_path: entry.workspace_path,
    provisioner_type: entry.provisioner_type,
    branch_name: entry.branch_name,
    repo_root: entry.repo_root,
    workspace_exists: entry.workspace_exists,
    workspace_git_status: entry.workspace_git_status,
    workspace_provisioned: entry.workspace_provisioned,
    workspace_is_git_worktree: entry.workspace_is_git_worktree,
    copy_ignored_applied: entry.copy_ignored_applied,
    copy_ignored_status: entry.copy_ignored_status,
    copy_ignored_summary: entry.copy_ignored_summary ? { ...entry.copy_ignored_summary } : null,
    stop_reason_code: entry.stop_reason_code,
    stop_reason_detail: entry.stop_reason_detail,
    conflict_files: (entry.conflict_files ?? []).map((file) => ({ ...file })),
    classification_summary: entry.classification_summary ? { ...entry.classification_summary } : undefined,
    resolution_hints: [...(entry.resolution_hints ?? [])],
    previous_thread_id: entry.previous_thread_id,
    previous_turn_id: entry.previous_turn_id ?? null,
    previous_session_id: entry.previous_session_id,
    last_phase: entry.last_phase,
    last_phase_at_ms: entry.last_phase_at_ms,
    last_phase_detail: entry.last_phase_detail,
    blocked_at_ms: entry.blocked_at_ms,
    requires_manual_resume: true,
    awaiting_operator: true,
    awaiting_operator_reason_code: entry.awaiting_operator_reason_code ?? entry.stop_reason_code,
    awaiting_operator_since_ms: entry.awaiting_operator_since_ms ?? entry.blocked_at_ms,
    awaiting_operator_resume_nonce: entry.awaiting_operator_resume_nonce ?? 0,
    attempt_count_window: entry.attempt_count_window,
    window_minutes: entry.window_minutes,
    last_known_commit_sha: entry.last_known_commit_sha ?? null,
    last_progress_checkpoint_at: entry.last_progress_checkpoint_at ?? null,
    progress_signals: entry.progress_signals ? { ...entry.progress_signals } : undefined,
    required_actions: [...(entry.required_actions ?? [])],
    resume_override_reason: entry.resume_override_reason ?? null,
    budget: entry.budget ? { ...entry.budget } : undefined,
    pending_input: entry.pending_input
      ? {
          ...entry.pending_input,
          questions: entry.pending_input.questions.map((question) => ({
            ...question,
            options: question.options ? question.options.map((option) => ({ ...option })) : undefined
          }))
        }
      : null,
    tool_output_wait: entry.tool_output_wait
      ? {
          ...entry.tool_output_wait,
          recommended_actions: [...entry.tool_output_wait.recommended_actions]
        }
      : null,
    ...cloneTranscriptToolCallDiagnostics(entry.transcript_tool_call_diagnostics, options),
    session_console: (entry.session_console ?? []).map((event) => ({ ...event })),
    quarantined_events: (entry.quarantined_events ?? []).map((event) => ({ ...event })),
    quarantined_event_count: entry.quarantined_event_count ?? 0,
    last_quarantined_event_at_ms: entry.last_quarantined_event_at_ms ?? null,
    recovery: entry.recovery ? { ...entry.recovery } : null,
    worker_termination_result: entry.worker_termination_result
      ? cloneWorkerTerminationResult(entry.worker_termination_result)
      : null
  };
}

export function cloneCircuitBreakerEntry(entry: CircuitBreakerEntry): CircuitBreakerEntry {
  return { ...entry };
}
