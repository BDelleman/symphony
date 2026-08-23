import type { Issue } from '../../tracker';
import type { StructuredLogger } from '../../observability';
import { CANONICAL_EVENT } from '../../observability/events';
import { REASON_CODES } from '../../observability/reason-codes';
import type { PhaseMarker } from '../../observability';
import { isActiveState, shouldDispatchIssue } from '../decisions';
import type {
  BlockedEntry,
  BudgetRuntimeProjection,
  OperatorActionRecord,
  OrchestratorOptions,
  OrchestratorState,
  ProgressSignals,
  RetryDelayType,
  MissingToolOutputRecoveryState
} from '../types';
import { normalizeOperatorReasonNote, reasonNoteRequiredFailure } from './blocked-input-recovery';
import type { DispatchGraphContext } from './execution-graph-persistence';

export interface BlockedInputScheduleParams {
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
  conflict_files?: Array<{
    path: string;
    status: 'staged' | 'unstaged' | 'unknown';
    classification?: 'ephemeral' | 'tracked_ephemeral' | 'unknown_non_ephemeral';
  }>;
  classification_summary?: {
    ephemeral: number;
    tracked_ephemeral: number;
    unknown_non_ephemeral: number;
  };
  resolution_hints?: string[];
  pending_input?: {
    detail: string;
    request_id: string | null;
    request_method: string | null;
    prompt_text: string | null;
    questions: Array<{ id: string; prompt?: string; options?: Array<{ label: string; value?: string }> }>;
  } | null;
  tool_output_wait?: BlockedEntry['tool_output_wait'];
  transcript_tool_call_diagnostics?: BlockedEntry['transcript_tool_call_diagnostics'];
  recovery?: BlockedEntry['recovery'];
  session_console?: Array<{ at_ms: number; event: string; message: string | null }>;
  previous_thread_id: string | null;
  previous_turn_id?: string | null;
  previous_session_id: string | null;
  attempt_count_window?: number;
  window_minutes?: number;
  last_known_commit_sha?: string | null;
  last_progress_checkpoint_at?: number | null;
  progress_signals?: ProgressSignals;
  required_actions?: string[];
  apply_circuit_breaker?: boolean;
  budget?: BudgetRuntimeProjection;
}

export interface BlockedInputScheduleRetryParams {
  issue_id: string;
  identifier: string;
  attempt: number;
  issue_run_id?: string | null;
  previous_attempt_id?: string | null;
  delay_type: RetryDelayType;
  error?: string | null;
  worker_host?: string | null;
  workspace_path?: string | null;
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
  stop_reason_code?: string | null;
  stop_reason_detail?: string | null;
  previous_thread_id?: string | null;
  previous_turn_id?: string | null;
  previous_session_id?: string | null;
  last_progress_checkpoint_at?: number | null;
  issue_snapshot?: Issue | null;
  progress_signals?: ProgressSignals;
  recover_workspace_attempt_residue?: boolean;
  budget?: BudgetRuntimeProjection;
  recovery?: MissingToolOutputRecoveryState | null;
  delay_ms?: number;
}

export interface BlockedInputCoordinatorHooks {
  getLastPhaseMarker: (issueId: string) => PhaseMarker | null;
  inferInputSchemaType: (
    questions: Array<{ id: string; prompt?: string; options?: Array<{ label: string; value?: string }> }>
  ) => 'options' | 'text' | 'unknown';
  upsertCircuitBreaker: (entry: {
    issue_id: string;
    issue_identifier: string;
    breaker_active: boolean;
    breaker_hit_count: number;
    breaker_window_minutes: number;
    breaker_first_hit_at_ms: number;
    breaker_last_hit_at_ms: number;
  }) => Promise<void>;
  clearCircuitBreaker: (issueId: string) => Promise<void>;
  recordHistoryWriteFailure: (operation: string, reasonCode: string, error: unknown) => Promise<void>;
  captureProgressSignals: (params: {
    issue: Issue | null;
    issue_id: string;
    branch_name: string | null;
    repo_root: string | null;
    previous_progress_signals?: ProgressSignals | null;
  }) => Promise<ProgressSignals>;
  dispatchIssue: (
    issue: Issue,
    attempt: number | null,
    resumeContext?: string | null,
    graphContext?: DispatchGraphContext
  ) => Promise<void>;
  scheduleRetry: (params: BlockedInputScheduleRetryParams) => Promise<void>;
  describeIssueRuntimeState: (issueId: string) => Record<string, unknown>;
  targetIdentifiersFromRuntimeState: (
    issueId: string,
    runtimeState: Record<string, unknown>
  ) => NonNullable<OperatorActionRecord['target_identifiers']>;
  recordOperatorAction: (issueId: string, action: OperatorActionRecord) => void;
  recordRuntimeEvent: (params: {
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
  }) => void;
  refreshQuiescenceState?: () => void;
}

export interface BlockedInputCoordinatorContext {
  readonly state: OrchestratorState;
  readonly config: OrchestratorOptions['config'];
  readonly tracker: Pick<OrchestratorOptions['ports']['tracker'], 'fetch_issue_states_by_ids' | 'update_issue_state'>;
  readonly cancelRetryTimer: OrchestratorOptions['ports']['cancelRetryTimer'];
  readonly submitBlockedIssueInputNative?: OrchestratorOptions['ports']['submitBlockedIssueInputNative'];
  readonly notifyObservers?: OrchestratorOptions['ports']['notifyObservers'];
  readonly persistence: OrchestratorOptions['persistence'] | undefined;
  readonly logger: StructuredLogger | undefined;
  readonly nowMs: () => number;
  readonly hooks: BlockedInputCoordinatorHooks;
}

export type SubmitBlockedIssueInputNativeResult = {
  applied: boolean;
  code: 'native_applied' | 'session_expired' | 'request_not_found' | 'transport_unsupported' | 'native_submit_failed';
  message?: string;
  resume_context?: string;
};

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

export async function scheduleBlockedInput(
  context: BlockedInputCoordinatorContext,
  params: BlockedInputScheduleParams
): Promise<{ created: boolean }> {
  const existingRetry = context.state.retry_attempts.get(params.issue_id);
  if (existingRetry) {
    context.cancelRetryTimer(existingRetry.timer_handle);
    context.state.retry_attempts.delete(params.issue_id);
  }

  const existingBlocked = context.state.blocked_inputs.get(params.issue_id);
  if (existingBlocked && existingBlocked.stop_reason_code === params.stop_reason_code && existingBlocked.requires_manual_resume) {
    return { created: false };
  }

  const lastPhaseMarker = context.hooks.getLastPhaseMarker(params.issue_id);
  const blockedEntry: BlockedEntry = {
    issue_id: params.issue_id,
    issue_identifier: params.issue_identifier,
    attempt: params.attempt,
    issue_run_id: params.issue_run_id ?? null,
    previous_attempt_id: params.previous_attempt_id ?? null,
    worker_host: params.worker_host,
    workspace_path: params.workspace_path,
    provisioner_type: params.provisioner_type,
    branch_name: params.branch_name,
    repo_root: params.repo_root,
    workspace_exists: params.workspace_exists,
    workspace_git_status: params.workspace_git_status,
    workspace_provisioned: params.workspace_provisioned,
    workspace_is_git_worktree: params.workspace_is_git_worktree,
    copy_ignored_applied: params.copy_ignored_applied ?? false,
    copy_ignored_status: params.copy_ignored_status ?? null,
    copy_ignored_summary: params.copy_ignored_summary ?? null,
    stop_reason_code: params.stop_reason_code,
    stop_reason_detail: params.stop_reason_detail,
    conflict_files: (params.conflict_files ?? []).map((file) => ({ ...file })),
    classification_summary: params.classification_summary ? { ...params.classification_summary } : undefined,
    resolution_hints: [...(params.resolution_hints ?? [])],
    previous_thread_id: params.previous_thread_id,
    previous_turn_id: params.previous_turn_id ?? null,
    previous_session_id: params.previous_session_id,
    last_phase: lastPhaseMarker?.phase ?? null,
    last_phase_at_ms: lastPhaseMarker?.at_ms ?? null,
    last_phase_detail: lastPhaseMarker?.detail ?? null,
    blocked_at_ms: context.nowMs(),
    requires_manual_resume: true,
    awaiting_operator: true,
    awaiting_operator_reason_code: params.stop_reason_code,
    awaiting_operator_since_ms: context.nowMs(),
    awaiting_operator_resume_nonce: (existingBlocked?.awaiting_operator_resume_nonce ?? 0) + 1,
    attempt_count_window: params.attempt_count_window,
    window_minutes: params.window_minutes,
    last_known_commit_sha: params.last_known_commit_sha ?? null,
    last_progress_checkpoint_at: params.last_progress_checkpoint_at ?? null,
    progress_signals: params.progress_signals
      ? {
          commit_sha: params.progress_signals.commit_sha ?? null,
          checklist_checkpoint: params.progress_signals.checklist_checkpoint ?? null,
          state_marker: params.progress_signals.state_marker ?? null,
          tracker_comment_created: params.progress_signals.tracker_comment_created ?? false,
          tracker_status_transition: params.progress_signals.tracker_status_transition ?? null,
          agent_review_handoff: params.progress_signals.agent_review_handoff ?? null,
          tracker_started_state: params.progress_signals.tracker_started_state ?? null
        }
      : undefined,
    required_actions: [...(params.required_actions ?? [])],
    resume_override_reason: null,
    budget: params.budget ? { ...params.budget } : undefined,
    pending_input: params.pending_input
      ? {
          request_id: params.pending_input.request_id,
          request_method: params.pending_input.request_method,
          prompt_text: params.pending_input.prompt_text,
          questions: params.pending_input.questions,
          input_schema_type: context.hooks.inferInputSchemaType(params.pending_input.questions),
          input_required_at_ms: context.nowMs()
        }
      : null,
    last_input_submit: null,
    resume_history: [],
    tool_output_wait: params.tool_output_wait
      ? {
          ...params.tool_output_wait,
          recommended_actions: [...params.tool_output_wait.recommended_actions]
        }
      : null,
    transcript_tool_call_diagnostics: (params.transcript_tool_call_diagnostics ?? []).map((diagnostic) => ({ ...diagnostic })),
    recovery: params.recovery ? { ...params.recovery } : null,
    session_console: (params.session_console ?? []).slice(-40),
    quarantined_events: [],
    quarantined_event_count: 0,
    last_quarantined_event_at_ms: null
  };
  context.state.blocked_inputs.set(params.issue_id, blockedEntry);
  context.state.claimed.add(params.issue_id);

  if (params.apply_circuit_breaker) {
    await context.hooks.upsertCircuitBreaker({
      issue_id: params.issue_id,
      issue_identifier: params.issue_identifier,
      breaker_active: true,
      breaker_hit_count: Math.max(1, params.attempt_count_window ?? 1),
      breaker_window_minutes: Math.max(1, params.window_minutes ?? context.config.respawn_window_minutes ?? 30),
      breaker_first_hit_at_ms: blockedEntry.blocked_at_ms,
      breaker_last_hit_at_ms: blockedEntry.blocked_at_ms
    });
  }

  void context.persistence?.upsertBlockedInput?.(params.issue_id, JSON.stringify(blockedEntry));
  void persistTicketBlocker(context, blockedEntry);
  void persistBlockedInputEvent(context, blockedEntry);

  context.logger?.log({
    level: 'warn',
    event: CANONICAL_EVENT.orchestration.blockedInputScheduled,
    message: 'issue blocked: operator input required',
    context: {
      issue_id: params.issue_id,
      issue_identifier: params.issue_identifier,
      stop_reason_code: params.stop_reason_code,
      request_id: params.pending_input?.request_id ?? null,
      previous_thread_id: params.previous_thread_id,
      previous_session_id: params.previous_session_id
    }
  });
  return { created: true };
}

export function clearBlockedInput(context: BlockedInputCoordinatorContext, issue_id: string, reason: string): void {
  const blocked = context.state.blocked_inputs.get(issue_id);
  if (!blocked) {
    return;
  }

  context.state.blocked_inputs.delete(issue_id);
  context.state.claimed.delete(issue_id);
  void context.persistence?.deleteBlockedInput?.(issue_id);
  context.logger?.log({
    level: 'info',
    event: CANONICAL_EVENT.orchestration.blockedInputCleared,
    message: 'blocked issue cleared',
    context: {
      issue_id,
      issue_identifier: blocked.issue_identifier,
      reason
    }
  });
}

export async function persistTicketBlocker(context: BlockedInputCoordinatorContext, blockedEntry: BlockedEntry): Promise<void> {
  if (!context.persistence?.appendTicketBlocker || !blockedEntry.issue_run_id) {
    return;
  }

  try {
    await context.persistence.appendTicketBlocker({
      issue_run_id: blockedEntry.issue_run_id,
      attempt_id: blockedEntry.previous_attempt_id ?? null,
      thread_id: blockedEntry.previous_thread_id ?? null,
      turn_id: blockedEntry.previous_turn_id ?? null,
      blocker_type: ticketBlockerTypeForBlockedEntry(blockedEntry),
      status: 'active',
      reason_code: blockedEntry.stop_reason_code,
      reason_detail: blockedEntry.stop_reason_detail,
      blocked_at: asIso(blockedEntry.blocked_at_ms)
    });
  } catch (error) {
    await context.hooks.recordHistoryWriteFailure('appendTicketBlocker', blockedEntry.stop_reason_code, error);
    context.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.persistence.recordEventFailed,
      message: `failed to persist ticket blocker for ${blockedEntry.issue_identifier}`,
      context: {
        issue_id: blockedEntry.issue_id,
        issue_identifier: blockedEntry.issue_identifier,
        issue_run_id: blockedEntry.issue_run_id,
        previous_attempt_id: blockedEntry.previous_attempt_id ?? null,
        reason_code: blockedEntry.stop_reason_code,
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

export async function persistBlockedInputEvent(context: BlockedInputCoordinatorContext, blockedEntry: BlockedEntry): Promise<void> {
  if (!context.persistence?.appendBlockedInputEvent || !blockedEntry.issue_run_id) {
    return;
  }

  try {
    await context.persistence.appendBlockedInputEvent({
      issue_run_id: blockedEntry.issue_run_id,
      attempt_id: blockedEntry.previous_attempt_id ?? null,
      thread_id: blockedEntry.previous_thread_id ?? null,
      turn_id: blockedEntry.previous_turn_id ?? null,
      issue_id: blockedEntry.issue_id,
      issue_identifier: blockedEntry.issue_identifier,
      phase: blockedEntry.last_phase,
      runtime_state: 'blocked',
      reason_code: blockedEntry.stop_reason_code,
      reason_detail: blockedEntry.stop_reason_detail,
      request_id: blockedEntry.pending_input?.request_id ?? null,
      request_method: blockedEntry.pending_input?.request_method ?? null,
      input_schema_type: blockedEntry.pending_input?.input_schema_type ?? null,
      prompt_text: blockedEntry.pending_input?.prompt_text ?? null,
      pending_input: blockedEntry.pending_input
        ? {
            request_id: blockedEntry.pending_input.request_id,
            request_method: blockedEntry.pending_input.request_method,
            prompt_text: blockedEntry.pending_input.prompt_text,
            input_schema_type: blockedEntry.pending_input.input_schema_type,
            questions: blockedEntry.pending_input.questions
          }
        : null,
      state_context: {
        previous_session_id: blockedEntry.previous_session_id,
        previous_turn_id: blockedEntry.previous_turn_id ?? null,
        worker_host: blockedEntry.worker_host,
        workspace_path: blockedEntry.workspace_path,
        branch_name: blockedEntry.branch_name,
        last_phase_at_ms: blockedEntry.last_phase_at_ms,
        last_phase_detail: blockedEntry.last_phase_detail,
        tool_output_wait: blockedEntry.tool_output_wait,
        conflict_files: blockedEntry.conflict_files,
        budget: blockedEntry.budget ?? null,
        recovery: blockedEntry.recovery,
        required_actions: blockedEntry.required_actions,
        progress_signals: blockedEntry.progress_signals ?? null
      },
      blocked_at: asIso(blockedEntry.blocked_at_ms)
    });
  } catch (error) {
    await context.hooks.recordHistoryWriteFailure('appendBlockedInputEvent', blockedEntry.stop_reason_code, error);
    context.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.persistence.recordEventFailed,
      message: `failed to persist blocked input event for ${blockedEntry.issue_identifier}`,
      context: {
        issue_id: blockedEntry.issue_id,
        issue_identifier: blockedEntry.issue_identifier,
        issue_run_id: blockedEntry.issue_run_id,
        previous_attempt_id: blockedEntry.previous_attempt_id ?? null,
        reason_code: blockedEntry.stop_reason_code,
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

export function ticketBlockerTypeForBlockedEntry(blockedEntry: BlockedEntry): string {
  if (blockedEntry.pending_input) {
    return 'operator_input';
  }
  if (blockedEntry.tool_output_wait) {
    return REASON_CODES.missingToolOutput;
  }
  if (blockedEntry.conflict_files.length > 0) {
    return 'workspace_conflict';
  }
  if (blockedEntry.budget?.budget_status === 'hard_limited') {
    return 'budget_limit';
  }
  return 'orchestration_blocker';
}

export function resolveBacklogStateName(context: BlockedInputCoordinatorContext): string {
  const candidates = context.config.active_states ?? [];
  const backlog = candidates.find((entry) => entry.trim().toLowerCase() === 'backlog');
  if (backlog) {
    return backlog;
  }
  const todo = candidates.find((entry) => entry.trim().toLowerCase() === 'todo');
  if (todo) {
    return todo;
  }
  return 'Todo';
}

export async function resumeBlockedIssue(
  context: BlockedInputCoordinatorContext,
  issue_identifier: string,
  resume_context: string | null = null,
  resume_override_reason: string | null = null,
  operator_context: { actor?: string | null; reason_note?: string | null } | null = null,
  resume_metadata?: {
    request_id: string;
    resume_mode: 'native' | 'fallback';
    resume_reason_code: string;
  }
): Promise<{ ok: true; issue_id: string } | { ok: false; code: string; message: string }> {
  const reasonNote = normalizeOperatorReasonNote(operator_context?.reason_note);
  if (!reasonNote) {
    return reasonNoteRequiredFailure();
  }
  const blocked = Array.from(context.state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issue_identifier);
  if (!blocked) {
    // A no-progress circuit breaker can hold an issue with no blocked-input
    // record at all; a bare "not blocked" here sends the operator in circles
    // while the dashboard still shows the issue as blocked. Name the actual
    // holder and the endpoint that releases it.
    const breaker = Array.from(context.state.circuit_breakers.values()).find(
      (entry) => entry.issue_identifier === issue_identifier && entry.breaker_active
    );
    if (breaker) {
      return {
        ok: false,
        code: 'automation_fault_active',
        message: `Issue ${issue_identifier} is held by a no-progress automation fault; clear it with POST /api/v1/issues/${issue_identifier}/clear-automation-fault`
      };
    }
    return {
      ok: false,
      code: 'issue_not_blocked',
      message: `Issue ${issue_identifier} is not blocked`
    };
  }
  const preState = context.hooks.describeIssueRuntimeState(blocked.issue_id);
  context.hooks.refreshQuiescenceState?.();
  const runtimeIdentityBlocker =
    context.state.runtime_identity?.status === 'stale' || context.state.runtime_identity?.status === 'unknown_current'
      ? context.state.runtime_identity.health_warning?.message
      : null;
  if (context.state.drain_mode.active || runtimeIdentityBlocker) {
    const resultCode = runtimeIdentityBlocker ? 'runtime_identity_dispatch_blocked' : 'drain_mode_active';
    const message = runtimeIdentityBlocker ?? 'Drain Mode is active; resume is held until drain exits';
    context.hooks.recordOperatorAction(blocked.issue_id, {
      action: resume_metadata ? 'submit_input' : 'resume',
      requested_at_ms: context.nowMs(),
      result: 'rejected',
      result_code: resultCode,
      message,
      actor: operator_context?.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState,
      post_state: context.hooks.describeIssueRuntimeState(blocked.issue_id)
    });
    context.hooks.recordRuntimeEvent({
      event: CANONICAL_EVENT.runtime.drainDispatchSkipped,
      severity: 'info',
      issue_identifier: blocked.issue_identifier,
      detail: message
    });
    context.notifyObservers?.();
    return {
      ok: false,
      code: resultCode,
      message
    };
  }

  let refreshedIssues: Issue[];
  try {
    refreshedIssues = await context.tracker.fetch_issue_states_by_ids([blocked.issue_id]);
  } catch (error) {
    context.hooks.recordOperatorAction(blocked.issue_id, {
      action: 'resume',
      requested_at_ms: context.nowMs(),
      result: 'failed',
      result_code: 'resume_failed',
      message: error instanceof Error ? error.message : 'failed to refresh issue state',
      actor: operator_context?.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState,
      post_state: context.hooks.describeIssueRuntimeState(blocked.issue_id)
    });
    return {
      ok: false,
      code: 'resume_failed',
      message: error instanceof Error ? error.message : 'failed to refresh issue state'
    };
  }

  const issue = refreshedIssues.find((entry) => entry.id === blocked.issue_id);
  if (!issue) {
    context.hooks.recordOperatorAction(blocked.issue_id, {
      action: 'resume',
      requested_at_ms: context.nowMs(),
      result: 'rejected',
      result_code: 'issue_not_found',
      message: `Issue ${issue_identifier} no longer exists in tracker`,
      actor: operator_context?.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState
    });
    clearBlockedInput(context, blocked.issue_id, 'issue_not_found');
    return {
      ok: false,
      code: 'issue_not_found',
      message: `Issue ${issue_identifier} no longer exists in tracker`
    };
  }

  if (!isActiveState(issue.state, context.config)) {
    context.hooks.recordOperatorAction(blocked.issue_id, {
      action: 'resume',
      requested_at_ms: context.nowMs(),
      result: 'rejected',
      result_code: 'issue_not_active',
      message: `Issue ${issue_identifier} is no longer in an active state`,
      actor: operator_context?.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState
    });
    clearBlockedInput(context, blocked.issue_id, 'issue_not_active');
    return {
      ok: false,
      code: 'issue_not_active',
      message: `Issue ${issue_identifier} is no longer in an active state`
    };
  }

  const currentSignals = await context.hooks.captureProgressSignals({
    issue,
    issue_id: blocked.issue_id,
    branch_name: blocked.branch_name,
    repo_root: blocked.repo_root
  });
  const hasProgressSignal =
    currentSignals.commit_sha !== (blocked.progress_signals?.commit_sha ?? null) ||
    currentSignals.checklist_checkpoint !== (blocked.progress_signals?.checklist_checkpoint ?? null) ||
    currentSignals.state_marker !== (blocked.progress_signals?.state_marker ?? null);
  const requiresProgressResume =
    blocked.stop_reason_code === REASON_CODES.operatorNoProgressRedispatchBlocked ||
    blocked.stop_reason_code === REASON_CODES.awaitingHumanReviewScopeIncomplete;
  if (requiresProgressResume && !hasProgressSignal && (!resume_override_reason || resume_override_reason.trim().length === 0)) {
    context.hooks.recordOperatorAction(blocked.issue_id, {
      action: 'resume',
      requested_at_ms: context.nowMs(),
      result: 'rejected',
      result_code: 'resume_failed',
      message: `Issue ${issue_identifier} requires progress or an explicit resume override reason`,
      actor: operator_context?.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState,
      post_state: context.hooks.describeIssueRuntimeState(blocked.issue_id)
    });
    return {
      ok: false,
      code: 'resume_failed',
      message: `Issue ${issue_identifier} requires progress or an explicit resume override reason`
    };
  }
  blocked.resume_override_reason = resume_override_reason?.trim() || null;

  context.state.blocked_inputs.delete(blocked.issue_id);
  context.state.claimed.delete(blocked.issue_id);
  context.state.redispatch_progress?.delete(blocked.issue_id);
  await context.hooks.clearCircuitBreaker(blocked.issue_id);
  await context.persistence?.deleteBlockedInput?.(blocked.issue_id);

  const eligibility = shouldDispatchIssue(issue, context.state, context.config);
  if (eligibility.eligible) {
    await context.hooks.dispatchIssue(issue, blocked.attempt, resume_context, {
      issue_run_id: blocked.issue_run_id,
      previous_attempt_id: blocked.previous_attempt_id,
      previous_thread_id: blocked.previous_thread_id ?? null,
      previous_turn_id: blocked.previous_turn_id ?? null,
      previous_session_id: blocked.previous_session_id ?? null,
      recover_workspace_attempt_residue: blocked.stop_reason_code === REASON_CODES.operatorWorkspaceConflict
    });
  } else if (eligibility.reason === 'global_slots_exhausted' || eligibility.reason === 'state_slots_exhausted') {
    await context.hooks.scheduleRetry({
      issue_id: blocked.issue_id,
      identifier: blocked.issue_identifier,
      attempt: blocked.attempt,
      issue_run_id: blocked.issue_run_id,
      previous_attempt_id: blocked.previous_attempt_id,
      delay_type: 'failure',
      error: 'no available orchestrator slots',
      worker_host: blocked.worker_host,
      workspace_path: blocked.workspace_path,
      provisioner_type: blocked.provisioner_type,
      branch_name: blocked.branch_name,
      repo_root: blocked.repo_root,
      workspace_exists: blocked.workspace_exists,
      workspace_git_status: blocked.workspace_git_status,
      workspace_provisioned: blocked.workspace_provisioned,
      workspace_is_git_worktree: blocked.workspace_is_git_worktree,
      copy_ignored_applied: blocked.copy_ignored_applied,
      copy_ignored_status: blocked.copy_ignored_status,
      copy_ignored_summary: blocked.copy_ignored_summary,
      stop_reason_code: REASON_CODES.slotsExhausted,
      stop_reason_detail: 'resume blocked by no available orchestrator slots',
      previous_thread_id: blocked.previous_thread_id,
      previous_turn_id: blocked.previous_turn_id ?? null,
      previous_session_id: blocked.previous_session_id,
      recover_workspace_attempt_residue: blocked.stop_reason_code === REASON_CODES.operatorWorkspaceConflict,
      issue_snapshot: issue
    });
  } else {
    await context.hooks.scheduleRetry({
      issue_id: blocked.issue_id,
      identifier: blocked.issue_identifier,
      attempt: blocked.attempt,
      issue_run_id: blocked.issue_run_id,
      previous_attempt_id: blocked.previous_attempt_id,
      delay_type: 'continuation',
      error: null,
      worker_host: blocked.worker_host,
      workspace_path: blocked.workspace_path,
      provisioner_type: blocked.provisioner_type,
      branch_name: blocked.branch_name,
      repo_root: blocked.repo_root,
      workspace_exists: blocked.workspace_exists,
      workspace_git_status: blocked.workspace_git_status,
      workspace_provisioned: blocked.workspace_provisioned,
      workspace_is_git_worktree: blocked.workspace_is_git_worktree,
      copy_ignored_applied: blocked.copy_ignored_applied,
      copy_ignored_status: blocked.copy_ignored_status,
      copy_ignored_summary: blocked.copy_ignored_summary,
      stop_reason_code: REASON_CODES.manualResume,
      stop_reason_detail: 'manual resume requested',
      previous_thread_id: blocked.previous_thread_id,
      previous_turn_id: blocked.previous_turn_id ?? null,
      previous_session_id: blocked.previous_session_id,
      recover_workspace_attempt_residue: blocked.stop_reason_code === REASON_CODES.operatorWorkspaceConflict,
      issue_snapshot: issue
    });
  }

  if (resume_metadata) {
    const submittedAtMs = context.nowMs();
    const record = {
      submitted_at_ms: submittedAtMs,
      request_id: resume_metadata.request_id,
      resume_mode: resume_metadata.resume_mode,
      resume_reason_code: resume_metadata.resume_reason_code,
      previous_thread_id: blocked.previous_thread_id ?? null,
      previous_session_id: blocked.previous_session_id ?? null
    };
    blocked.last_input_submit = {
      submitted_at_ms: submittedAtMs,
      request_id: resume_metadata.request_id,
      resume_mode: resume_metadata.resume_mode,
      resume_reason_code: resume_metadata.resume_reason_code
    };
    blocked.resume_history = [...(blocked.resume_history ?? []), record].slice(-20);
  }

  context.logger?.log({
    level: 'info',
    event: CANONICAL_EVENT.orchestration.blockedInputResumed,
    message: 'blocked issue resumed',
    context: {
      issue_id: blocked.issue_id,
      issue_identifier: blocked.issue_identifier,
      request_id: resume_metadata?.request_id ?? blocked.pending_input?.request_id ?? null,
      resume_mode: resume_metadata?.resume_mode ?? null,
      resume_reason_code: resume_metadata?.resume_reason_code ?? null,
      previous_thread_id: blocked.previous_thread_id,
      previous_session_id: blocked.previous_session_id
    }
  });

  context.hooks.recordOperatorAction(blocked.issue_id, {
    action: resume_metadata ? 'submit_input' : 'resume',
    requested_at_ms: context.nowMs(),
    result: 'accepted',
    result_code: resume_metadata?.resume_reason_code ?? 'resume_accepted',
    message: 'blocked issue resumed',
    actor: operator_context?.actor ?? null,
    reason_note: reasonNote,
    pre_state: preState,
    post_state: context.hooks.describeIssueRuntimeState(blocked.issue_id)
  });
  context.notifyObservers?.();
  return {
    ok: true,
    issue_id: blocked.issue_id
  };
}

export async function cancelBlockedIssue(
  context: BlockedInputCoordinatorContext,
  issue_identifier: string,
  cancel_reason: string | null = null,
  operator_context: { actor?: string | null; reason_note?: string | null; confirmed?: boolean | null } | null = null
): Promise<{ ok: true; issue_id: string; moved_to_state: string } | { ok: false; code: string; message: string }> {
  const reasonNote = normalizeOperatorReasonNote(operator_context?.reason_note ?? cancel_reason);
  if (!reasonNote) {
    return reasonNoteRequiredFailure();
  }
  const blocked = Array.from(context.state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issue_identifier);
  if (!blocked) {
    return {
      ok: false,
      code: 'issue_not_blocked',
      message: `Issue ${issue_identifier} is not blocked`
    };
  }
  const preState = context.hooks.describeIssueRuntimeState(blocked.issue_id);
  if (operator_context?.confirmed !== true) {
    context.hooks.recordOperatorAction(blocked.issue_id, {
      action: 'cancel',
      requested_at_ms: context.nowMs(),
      result: 'rejected',
      result_code: 'confirmation_required',
      message: 'Cancel requires explicit confirmation',
      actor: operator_context?.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState,
      post_state: context.hooks.describeIssueRuntimeState(blocked.issue_id)
    });
    return { ok: false, code: 'confirmation_required', message: 'Cancel requires explicit confirmation' };
  }

  const targetState = resolveBacklogStateName(context);
  try {
    await context.tracker.update_issue_state(blocked.issue_id, targetState);
  } catch (error) {
    context.hooks.recordOperatorAction(blocked.issue_id, {
      action: 'cancel',
      requested_at_ms: context.nowMs(),
      result: 'failed',
      result_code: 'cancel_failed',
      message: error instanceof Error ? error.message : 'failed to move issue to backlog state',
      actor: operator_context?.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState,
      post_state: context.hooks.describeIssueRuntimeState(blocked.issue_id)
    });
    return {
      ok: false,
      code: 'cancel_failed',
      message: error instanceof Error ? error.message : 'failed to move issue to backlog state'
    };
  }

  clearBlockedInput(context, blocked.issue_id, 'operator_cancelled_to_backlog');
  context.state.redispatch_progress?.delete(blocked.issue_id);
  await context.hooks.clearCircuitBreaker(blocked.issue_id);
  context.hooks.recordOperatorAction(blocked.issue_id, {
    action: 'cancel',
    requested_at_ms: context.nowMs(),
    result: 'accepted',
    result_code: targetState,
    message: `cancelled to backlog: ${reasonNote}`,
    actor: operator_context?.actor ?? null,
    reason_note: reasonNote,
    target_identifiers: context.hooks.targetIdentifiersFromRuntimeState(blocked.issue_id, preState),
    pre_state: preState,
    post_state: context.hooks.describeIssueRuntimeState(blocked.issue_id)
  });
  context.hooks.recordRuntimeEvent({
    event: CANONICAL_EVENT.orchestration.cancelToBacklogExecuted,
    severity: 'info',
    issue_identifier,
    detail: cancel_reason?.trim() ? `cancelled to backlog: ${cancel_reason.trim()}` : 'cancelled to backlog'
  });
  context.logger?.log({
    level: 'info',
    event: CANONICAL_EVENT.orchestration.cancelToBacklogExecuted,
    message: cancel_reason?.trim() ? `cancelled to backlog: ${cancel_reason.trim()}` : 'cancelled to backlog',
    context: {
      issue_id: blocked.issue_id,
      issue_identifier,
      stop_reason_code: blocked.stop_reason_code,
      classification_summary: JSON.stringify(
        blocked.classification_summary ?? {
          ephemeral: 0,
          tracked_ephemeral: 0,
          unknown_non_ephemeral: 0
        }
      ),
      next_operator_action: 'issue.state.todo',
      next_operator_action_endpoint: '/api/v1/issues/:issue_identifier/cancel'
    }
  });
  context.notifyObservers?.();
  return { ok: true, issue_id: blocked.issue_id, moved_to_state: targetState };
}

export async function submitBlockedIssueInput(
  context: BlockedInputCoordinatorContext,
  params: {
    issue_identifier: string;
    request_id: string;
    actor?: string | null;
    reason_note?: string | null;
    answer: { question_id?: string; option_label?: string; text?: string };
  }
): Promise<
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
> {
  const reasonNote = normalizeOperatorReasonNote(params.reason_note);
  if (!reasonNote) {
    return reasonNoteRequiredFailure();
  }
  const blocked = Array.from(context.state.blocked_inputs.values()).find((entry) => entry.issue_identifier === params.issue_identifier);
  if (!blocked) {
    return { ok: false, code: 'issue_not_blocked', message: `Issue ${params.issue_identifier} is not blocked` };
  }
  const preState = context.hooks.describeIssueRuntimeState(blocked.issue_id);
  const operatorContext = { actor: params.actor ?? null, reason_note: reasonNote };
  if (!blocked.pending_input) {
    context.hooks.recordOperatorAction(blocked.issue_id, {
      action: 'submit_input',
      requested_at_ms: context.nowMs(),
      result: 'rejected',
      result_code: 'input_submission_not_answerable',
      message: 'Blocked issue has no pending input request payload',
      actor: operatorContext.actor,
      reason_note: operatorContext.reason_note,
      pre_state: preState,
      post_state: context.hooks.describeIssueRuntimeState(blocked.issue_id)
    });
    return { ok: false, code: 'input_submission_not_answerable', message: 'Blocked issue has no pending input request payload' };
  }
  if (!blocked.pending_input.request_id || blocked.pending_input.request_id !== params.request_id) {
    context.hooks.recordOperatorAction(blocked.issue_id, {
      action: 'submit_input',
      requested_at_ms: context.nowMs(),
      result: 'rejected',
      result_code: 'input_submission_expired',
      message: 'Input request_id does not match current blocked request',
      actor: operatorContext.actor,
      reason_note: operatorContext.reason_note,
      pre_state: preState,
      post_state: context.hooks.describeIssueRuntimeState(blocked.issue_id)
    });
    return { ok: false, code: 'input_submission_expired', message: 'Input request_id does not match current blocked request' };
  }

  if (blocked.pending_input.input_schema_type === 'options') {
    const q = blocked.pending_input.questions.find((question) => question.id === params.answer.question_id) ?? blocked.pending_input.questions[0];
    const options = q?.options ?? [];
    if (!params.answer.option_label || !options.some((option) => option.label === params.answer.option_label)) {
      context.hooks.recordOperatorAction(blocked.issue_id, {
        action: 'submit_input',
        requested_at_ms: context.nowMs(),
        result: 'rejected',
        result_code: 'input_submission_invalid',
        message: 'Answer must select a valid option label for the pending question',
        actor: operatorContext.actor,
        reason_note: operatorContext.reason_note,
        pre_state: preState,
        post_state: context.hooks.describeIssueRuntimeState(blocked.issue_id)
      });
      return { ok: false, code: 'input_submission_invalid', message: 'Answer must select a valid option label for the pending question' };
    }
  } else if (blocked.pending_input.input_schema_type === 'text') {
    if (!params.answer.text || !params.answer.text.trim()) {
      context.hooks.recordOperatorAction(blocked.issue_id, {
        action: 'submit_input',
        requested_at_ms: context.nowMs(),
        result: 'rejected',
        result_code: 'input_submission_invalid',
        message: 'Answer text is required for this input request',
        actor: operatorContext.actor,
        reason_note: operatorContext.reason_note,
        pre_state: preState,
        post_state: context.hooks.describeIssueRuntimeState(blocked.issue_id)
      });
      return { ok: false, code: 'input_submission_invalid', message: 'Answer text is required for this input request' };
    }
  }

  context.hooks.refreshQuiescenceState?.();
  const runtimeIdentityBlocker =
    context.state.runtime_identity?.status === 'stale' || context.state.runtime_identity?.status === 'unknown_current'
      ? context.state.runtime_identity.health_warning?.message
      : null;
  if (context.state.drain_mode.active || runtimeIdentityBlocker) {
    const resultCode = runtimeIdentityBlocker ? 'runtime_identity_dispatch_blocked' : 'drain_mode_active';
    const message = runtimeIdentityBlocker ?? 'Drain Mode is active; input submission is held until drain exits';
    context.hooks.recordOperatorAction(blocked.issue_id, {
      action: 'submit_input',
      requested_at_ms: context.nowMs(),
      result: 'rejected',
      result_code: resultCode,
      message,
      actor: operatorContext.actor,
      reason_note: operatorContext.reason_note,
      pre_state: preState,
      post_state: context.hooks.describeIssueRuntimeState(blocked.issue_id)
    });
    context.hooks.recordRuntimeEvent({
      event: CANONICAL_EVENT.runtime.drainDispatchSkipped,
      severity: 'info',
      issue_identifier: blocked.issue_identifier,
      detail: message
    });
    context.notifyObservers?.();
    return {
      ok: false,
      code: resultCode,
      message
    };
  }

  const nativeAttempt = await submitBlockedIssueInputNative(context, blocked, params);
  if (nativeAttempt.applied) {
    context.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.blockedInputSubmitNativeApplied,
      message: 'native blocked input submission applied',
      context: {
        issue_id: blocked.issue_id,
        issue_identifier: blocked.issue_identifier,
        request_id: params.request_id
      }
    });
    const resumed = await resumeBlockedIssue(context, params.issue_identifier, nativeAttempt.resume_context ?? null, null, operatorContext, {
      request_id: params.request_id,
      resume_mode: 'native',
      resume_reason_code: 'native_applied'
    });
    if (!resumed.ok) {
      return resumed;
    }
    return {
      ok: true,
      issue_id: resumed.issue_id,
      request_id: params.request_id,
      resume_mode: 'native',
      resume_reason_code: 'native_applied',
      requested_at: new Date().toISOString(),
      request_lineage: {
        previous_thread_id: blocked.previous_thread_id ?? null,
        previous_session_id: blocked.previous_session_id ?? null
      }
    };
  }

  context.logger?.log({
    level: 'warn',
    event: CANONICAL_EVENT.orchestration.blockedInputSubmitNativeFailed,
    message: 'native blocked input submission unavailable',
    context: {
      issue_id: blocked.issue_id,
      issue_identifier: blocked.issue_identifier,
      request_id: params.request_id,
      resume_reason_code: nativeAttempt.code
    }
  });

  const mappedCode =
    nativeAttempt.code === 'session_expired' || nativeAttempt.code === 'request_not_found'
      ? 'input_submission_expired'
      : nativeAttempt.code === 'transport_unsupported'
        ? 'input_submission_transport_unavailable'
        : 'input_submission_not_answerable';
  context.hooks.recordOperatorAction(blocked.issue_id, {
    action: 'submit_input',
    requested_at_ms: context.nowMs(),
    result: mappedCode === 'input_submission_transport_unavailable' ? 'failed' : 'rejected',
    result_code: mappedCode,
    message: nativeAttempt.message ?? 'Input submission unavailable for this request',
    actor: operatorContext.actor,
    reason_note: operatorContext.reason_note,
    pre_state: preState,
    post_state: context.hooks.describeIssueRuntimeState(blocked.issue_id)
  });
  return { ok: false, code: mappedCode, message: nativeAttempt.message ?? 'Input submission unavailable for this request' };
}

export async function submitBlockedIssueInputNative(
  context: BlockedInputCoordinatorContext,
  blocked: BlockedEntry,
  params: { issue_identifier: string; request_id: string; answer: { question_id?: string; option_label?: string; text?: string } }
): Promise<SubmitBlockedIssueInputNativeResult> {
  if (!context.submitBlockedIssueInputNative) {
    return { applied: false, code: 'transport_unsupported' };
  }
  return context.submitBlockedIssueInputNative({
    issue_id: blocked.issue_id,
    issue_identifier: params.issue_identifier,
    request_id: params.request_id,
    request_method: blocked.pending_input?.request_method ?? null,
    previous_thread_id: blocked.previous_thread_id ?? null,
    previous_session_id: blocked.previous_session_id ?? null,
    answer: params.answer
  });
}

export function buildOperatorInputResumeContext(
  blocked: BlockedEntry,
  answer: { question_id?: string; option_label?: string; text?: string }
): string {
  const question =
    blocked.pending_input?.questions.find((entry) => entry.id === answer.question_id) ?? blocked.pending_input?.questions[0] ?? null;
  const promptText = question?.prompt ?? blocked.pending_input?.prompt_text ?? 'Operator input requested';
  const normalizedAnswer = answer.option_label ?? answer.text?.trim() ?? '';
  const requestId = blocked.pending_input?.request_id ?? 'unknown';
  return [
    'Operator provided input for a previously blocked request. Apply this answer and continue execution.',
    `Request ID: ${requestId}`,
    `Question: ${promptText}`,
    `Answer: ${normalizedAnswer}`
  ].join('\n');
}
