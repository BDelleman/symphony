import type { Issue } from '../../tracker';
import { REASON_CODES } from '../../observability/reason-codes';
import type { PhaseMarker } from '../../observability';
import type {
  OperatorActionRecord,
  OrchestratorOptions,
  OrchestratorState,
  ProgressSignals,
  RetryDelayType
} from '../types';
import { normalizeOperatorReasonNote, reasonNoteRequiredFailure } from './blocked-input-recovery';

export interface OperatorControlScheduleRetryParams {
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
}

export interface OperatorControlCoordinatorHooks {
  getLastPhaseMarker: (issueId: string) => PhaseMarker | null;
  terminateRunningIssue: (issueId: string, cleanupWorkspace: boolean, reason: string) => Promise<void>;
  scheduleRetry: (params: OperatorControlScheduleRetryParams) => Promise<void>;
  recordHistoryWriteFailure: (operation: string, reasonCode: string, error: unknown) => Promise<void>;
}

export interface OperatorControlCoordinatorContext {
  readonly state: OrchestratorState;
  readonly resolveProgressSignals?: OrchestratorOptions['ports']['resolveProgressSignals'];
  readonly notifyObservers?: OrchestratorOptions['ports']['notifyObservers'];
  readonly persistence: OrchestratorOptions['persistence'] | undefined;
  readonly nowMs: () => number;
  readonly hooks: OperatorControlCoordinatorHooks;
}

export async function coordinateCaptureProgressSignals(
  context: OperatorControlCoordinatorContext,
  params: {
    issue: Issue | null;
    issue_id: string;
    branch_name: string | null;
    repo_root: string | null;
    previous_progress_signals?: ProgressSignals | null;
  }
): Promise<ProgressSignals> {
  const fallbackStateMarker = context.hooks.getLastPhaseMarker(params.issue_id)?.phase ?? null;
  if (!context.resolveProgressSignals) {
    return {
      commit_sha: params.previous_progress_signals?.commit_sha ?? null,
      checklist_checkpoint: params.previous_progress_signals?.checklist_checkpoint ?? null,
      state_marker: params.previous_progress_signals?.state_marker ?? fallbackStateMarker,
      tracker_comment_created: params.previous_progress_signals?.tracker_comment_created ?? false,
      tracker_status_transition: params.previous_progress_signals?.tracker_status_transition ?? null,
      agent_review_handoff: params.previous_progress_signals?.agent_review_handoff ?? null,
      tracker_started_state: params.previous_progress_signals?.tracker_started_state ?? null
    };
  }

  try {
    const resolved = await context.resolveProgressSignals({
      issue: params.issue,
      issue_id: params.issue_id,
      branch_name: params.branch_name,
      repo_root: params.repo_root,
      fallback_state_marker: fallbackStateMarker,
      previous_progress_signals: params.previous_progress_signals ?? null
    });
    return {
      commit_sha: resolved.commit_sha ?? params.previous_progress_signals?.commit_sha ?? null,
      checklist_checkpoint: resolved.checklist_checkpoint ?? params.previous_progress_signals?.checklist_checkpoint ?? null,
      state_marker: resolved.state_marker ?? params.previous_progress_signals?.state_marker ?? fallbackStateMarker,
      tracker_comment_created:
        resolved.tracker_comment_created ?? params.previous_progress_signals?.tracker_comment_created ?? false,
      tracker_status_transition:
        resolved.tracker_status_transition ?? params.previous_progress_signals?.tracker_status_transition ?? null,
      agent_review_handoff: resolved.agent_review_handoff ?? params.previous_progress_signals?.agent_review_handoff ?? null,
      tracker_started_state: resolved.tracker_started_state ?? params.previous_progress_signals?.tracker_started_state ?? null
    };
  } catch {
    return {
      commit_sha: params.previous_progress_signals?.commit_sha ?? null,
      checklist_checkpoint: params.previous_progress_signals?.checklist_checkpoint ?? null,
      state_marker: params.previous_progress_signals?.state_marker ?? fallbackStateMarker,
      tracker_comment_created: params.previous_progress_signals?.tracker_comment_created ?? false,
      tracker_status_transition: params.previous_progress_signals?.tracker_status_transition ?? null,
      agent_review_handoff: params.previous_progress_signals?.agent_review_handoff ?? null,
      tracker_started_state: params.previous_progress_signals?.tracker_started_state ?? null
    };
  }
}

export async function coordinateCancelCurrentTurn(
  context: OperatorControlCoordinatorContext,
  issue_identifier: string,
  params: { actor?: string | null; reason_note?: string | null; confirmed?: boolean | null } = {}
): Promise<{ ok: true; issue_id: string } | { ok: false; code: string; message: string }> {
  const reasonNote = normalizeOperatorReasonNote(params.reason_note);
  if (!reasonNote) {
    return reasonNoteRequiredFailure();
  }
  const running = Array.from(context.state.running.values()).find((entry) => entry.identifier === issue_identifier);
  if (!running) {
    return { ok: false, code: 'unsupported_transition', message: `Issue ${issue_identifier} has no running turn to cancel` };
  }
  const preState = describeIssueRuntimeState(context, running.issue.id);
  if (params.confirmed !== true) {
    recordOperatorAction(context, running.issue.id, {
      action: 'cancel',
      requested_at_ms: context.nowMs(),
      result: 'rejected',
      result_code: 'confirmation_required',
      message: 'Cancel current turn requires explicit confirmation',
      actor: params.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState,
      post_state: describeIssueRuntimeState(context, running.issue.id)
    });
    return { ok: false, code: 'confirmation_required', message: 'Cancel current turn requires explicit confirmation' };
  }

  await context.hooks.terminateRunningIssue(running.issue.id, false, reasonNote);
  recordOperatorAction(context, running.issue.id, {
    action: 'cancel',
    requested_at_ms: context.nowMs(),
    result: 'accepted',
    result_code: 'current_turn_cancelled',
    message: 'current turn cancelled',
    actor: params.actor ?? null,
    reason_note: reasonNote,
    pre_state: preState,
    post_state: describeIssueRuntimeState(context, running.issue.id)
  });
  context.notifyObservers?.();
  return { ok: true, issue_id: running.issue.id };
}

export async function coordinateRequeueIssue(
  context: OperatorControlCoordinatorContext,
  issue_identifier: string,
  params: { actor?: string | null; reason_note?: string | null; confirmed?: boolean | null } = {}
): Promise<{ ok: true; issue_id: string; retry_attempt: number } | { ok: false; code: string; message: string }> {
  const reasonNote = normalizeOperatorReasonNote(params.reason_note);
  if (!reasonNote) {
    return reasonNoteRequiredFailure();
  }
  const running = Array.from(context.state.running.values()).find((entry) => entry.identifier === issue_identifier);
  if (running) {
    const preState = describeIssueRuntimeState(context, running.issue.id);
    if (params.confirmed !== true) {
      recordOperatorAction(context, running.issue.id, {
        action: 'requeue',
        requested_at_ms: context.nowMs(),
        result: 'rejected',
        result_code: 'confirmation_required',
        message: 'Requeue from a running turn requires explicit confirmation',
        actor: params.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState,
        post_state: describeIssueRuntimeState(context, running.issue.id)
      });
      return { ok: false, code: 'confirmation_required', message: 'Requeue from a running turn requires explicit confirmation' };
    }
    await context.hooks.terminateRunningIssue(running.issue.id, false, reasonNote);
    const retryAttempt = running.retry_attempt + 1;
    await context.hooks.scheduleRetry({
      issue_id: running.issue.id,
      identifier: running.identifier,
      attempt: retryAttempt,
      issue_run_id: running.issue_run_id ?? null,
      previous_attempt_id: running.attempt_id ?? null,
      delay_type: 'continuation',
      error: 'operator requeue requested',
      worker_host: running.worker_host ?? null,
      workspace_path: running.workspace_path,
      provisioner_type: running.provisioner_type,
      branch_name: running.branch_name,
      repo_root: running.repo_root,
      workspace_exists: running.workspace_exists,
      workspace_git_status: running.workspace_git_status,
      workspace_provisioned: running.workspace_provisioned,
      workspace_is_git_worktree: running.workspace_is_git_worktree,
      copy_ignored_applied: running.copy_ignored_applied,
      copy_ignored_status: running.copy_ignored_status,
      copy_ignored_summary: running.copy_ignored_summary,
      stop_reason_code: REASON_CODES.operatorRequeueRequested,
      stop_reason_detail: reasonNote,
      previous_thread_id: running.thread_id,
      previous_turn_id: running.turn_id,
      previous_session_id: running.session_id,
      issue_snapshot: running.issue,
      progress_signals: running.progress_signals
    });
    recordOperatorAction(context, running.issue.id, {
      action: 'requeue',
      requested_at_ms: context.nowMs(),
      result: 'accepted',
      result_code: 'requeue_scheduled',
      message: 'issue requeued',
      actor: params.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState,
      post_state: describeIssueRuntimeState(context, running.issue.id)
    });
    context.notifyObservers?.();
    return { ok: true, issue_id: running.issue.id, retry_attempt: retryAttempt };
  }

  const blocked = Array.from(context.state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issue_identifier);
  if (blocked) {
    const preState = describeIssueRuntimeState(context, blocked.issue_id);
    const retryAttempt = blocked.attempt;
    await context.hooks.scheduleRetry({
      issue_id: blocked.issue_id,
      identifier: blocked.issue_identifier,
      attempt: retryAttempt,
      issue_run_id: blocked.issue_run_id,
      previous_attempt_id: blocked.previous_attempt_id,
      delay_type: 'continuation',
      error: 'operator requeue requested',
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
      stop_reason_code: REASON_CODES.operatorRequeueRequested,
      stop_reason_detail: reasonNote,
      previous_thread_id: blocked.previous_thread_id,
      previous_turn_id: blocked.previous_turn_id ?? null,
      previous_session_id: blocked.previous_session_id,
      issue_snapshot: null
    });
    await context.persistence?.deleteBlockedInput?.(blocked.issue_id);
    recordOperatorAction(context, blocked.issue_id, {
      action: 'requeue',
      requested_at_ms: context.nowMs(),
      result: 'accepted',
      result_code: 'requeue_scheduled',
      message: 'issue requeued',
      actor: params.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState,
      post_state: describeIssueRuntimeState(context, blocked.issue_id)
    });
    context.notifyObservers?.();
    return { ok: true, issue_id: blocked.issue_id, retry_attempt: retryAttempt };
  }

  const retry = Array.from(context.state.retry_attempts.values()).find((entry) => entry.identifier === issue_identifier);
  if (retry) {
    const preState = describeIssueRuntimeState(context, retry.issue_id);
    await context.hooks.scheduleRetry({
      issue_id: retry.issue_id,
      identifier: retry.identifier,
      attempt: retry.attempt,
      issue_run_id: retry.issue_run_id,
      previous_attempt_id: retry.previous_attempt_id,
      delay_type: 'continuation',
      error: 'operator requeue requested',
      worker_host: retry.worker_host,
      workspace_path: retry.workspace_path,
      provisioner_type: retry.provisioner_type,
      branch_name: retry.branch_name,
      repo_root: retry.repo_root,
      workspace_exists: retry.workspace_exists,
      workspace_git_status: retry.workspace_git_status,
      workspace_provisioned: retry.workspace_provisioned,
      workspace_is_git_worktree: retry.workspace_is_git_worktree,
      copy_ignored_applied: retry.copy_ignored_applied,
      copy_ignored_status: retry.copy_ignored_status,
      copy_ignored_summary: retry.copy_ignored_summary,
      stop_reason_code: REASON_CODES.operatorRequeueRequested,
      stop_reason_detail: reasonNote,
      previous_thread_id: retry.previous_thread_id,
      previous_turn_id: retry.previous_turn_id ?? null,
      previous_session_id: retry.previous_session_id,
      issue_snapshot: null
    });
    recordOperatorAction(context, retry.issue_id, {
      action: 'requeue',
      requested_at_ms: context.nowMs(),
      result: 'accepted',
      result_code: 'requeue_scheduled',
      message: 'issue requeued',
      actor: params.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState,
      post_state: describeIssueRuntimeState(context, retry.issue_id)
    });
    context.notifyObservers?.();
    return { ok: true, issue_id: retry.issue_id, retry_attempt: retry.attempt };
  }

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
  return { ok: false, code: 'unsupported_transition', message: `Issue ${issue_identifier} is not running, blocked, or retrying` };
}

export async function coordinateRetryLastFailedStep(
  context: OperatorControlCoordinatorContext,
  issue_identifier: string,
  params: { actor?: string | null; reason_note?: string | null } = {}
): Promise<{ ok: true; issue_id: string; retry_attempt: number } | { ok: false; code: string; message: string }> {
  const reasonNote = normalizeOperatorReasonNote(params.reason_note);
  if (!reasonNote) {
    return reasonNoteRequiredFailure();
  }
  const retry = Array.from(context.state.retry_attempts.values()).find((entry) => entry.identifier === issue_identifier);
  if (!retry) {
    return {
      ok: false,
      code: 'unsupported_transition',
      message: `Issue ${issue_identifier} has no failed or stalled retry step`
    };
  }
  const preState = describeIssueRuntimeState(context, retry.issue_id);
  await context.hooks.scheduleRetry({
    issue_id: retry.issue_id,
    identifier: retry.identifier,
    attempt: retry.attempt,
    issue_run_id: retry.issue_run_id,
    previous_attempt_id: retry.previous_attempt_id,
    delay_type: 'continuation',
    error: 'operator retry-step requested',
    worker_host: retry.worker_host,
    workspace_path: retry.workspace_path,
    provisioner_type: retry.provisioner_type,
    branch_name: retry.branch_name,
    repo_root: retry.repo_root,
    workspace_exists: retry.workspace_exists,
    workspace_git_status: retry.workspace_git_status,
    workspace_provisioned: retry.workspace_provisioned,
    workspace_is_git_worktree: retry.workspace_is_git_worktree,
    copy_ignored_applied: retry.copy_ignored_applied,
    copy_ignored_status: retry.copy_ignored_status,
    copy_ignored_summary: retry.copy_ignored_summary,
    stop_reason_code: REASON_CODES.operatorRetryStepRequested,
    stop_reason_detail: reasonNote,
    previous_thread_id: retry.previous_thread_id,
    previous_turn_id: retry.previous_turn_id ?? null,
    previous_session_id: retry.previous_session_id,
    issue_snapshot: null
  });
  recordOperatorAction(context, retry.issue_id, {
    action: 'retry_step',
    requested_at_ms: context.nowMs(),
    result: 'accepted',
    result_code: 'retry_step_scheduled',
    message: 'last failed or stalled step retry scheduled',
    actor: params.actor ?? null,
    reason_note: reasonNote,
    pre_state: preState,
    post_state: describeIssueRuntimeState(context, retry.issue_id)
  });
  context.notifyObservers?.();
  return { ok: true, issue_id: retry.issue_id, retry_attempt: retry.attempt };
}

export function describeIssueRuntimeState(
  context: OperatorControlCoordinatorContext,
  issueId: string
): Record<string, unknown> {
  const running = context.state.running.get(issueId);
  if (running) {
    return {
      runtime_state: 'running',
      issue_id: issueId,
      issue_identifier: running.identifier,
      issue_run_id: running.issue_run_id ?? null,
      run_id: running.run_id ?? null,
      attempt_id: running.attempt_id ?? null,
      retry_attempt: running.retry_attempt,
      thread_id: running.thread_id,
      turn_id: running.turn_id,
      session_id: running.session_id
    };
  }
  const blocked = context.state.blocked_inputs.get(issueId);
  if (blocked) {
    return {
      runtime_state: 'blocked',
      issue_id: issueId,
      issue_identifier: blocked.issue_identifier,
      issue_run_id: blocked.issue_run_id ?? null,
      run_id: null,
      attempt_id: blocked.previous_attempt_id ?? null,
      retry_attempt: blocked.attempt,
      thread_id: blocked.previous_thread_id,
      session_id: blocked.previous_session_id,
      reason_code: blocked.stop_reason_code
    };
  }
  const retry = context.state.retry_attempts.get(issueId);
  if (retry) {
    return {
      runtime_state: 'retrying',
      issue_id: issueId,
      issue_identifier: retry.identifier,
      issue_run_id: retry.issue_run_id ?? null,
      run_id: null,
      attempt_id: retry.previous_attempt_id ?? null,
      retry_attempt: retry.attempt,
      thread_id: retry.previous_thread_id,
      session_id: retry.previous_session_id,
      due_at_ms: retry.due_at_ms,
      reason_code: retry.stop_reason_code
    };
  }
  const breaker = context.state.circuit_breakers.get(issueId);
  if (breaker?.breaker_active) {
    return {
      runtime_state: 'automation_fault',
      issue_id: issueId,
      issue_identifier: breaker.issue_identifier,
      reason_code: REASON_CODES.operatorNoProgressRedispatchBlocked,
      breaker_active: true,
      breaker_hit_count: breaker.breaker_hit_count,
      breaker_window_minutes: breaker.breaker_window_minutes,
      breaker_first_hit_at_ms: breaker.breaker_first_hit_at_ms,
      breaker_last_hit_at_ms: breaker.breaker_last_hit_at_ms
    };
  }
  return {
    runtime_state: context.state.completed.has(issueId) ? 'completed' : 'untracked',
    issue_id: issueId
  };
}

export function recordOperatorAction(
  context: OperatorControlCoordinatorContext,
  issueId: string,
  action: OperatorActionRecord
): void {
  const operatorActions = context.state.operator_actions ?? new Map<string, OperatorActionRecord[]>();
  context.state.operator_actions = operatorActions;
  const currentState = describeIssueRuntimeState(context, issueId);
  const normalized: OperatorActionRecord = {
    ...action,
    actor: action.actor ?? 'operator',
    reason_note: action.reason_note ?? null,
    target_identifiers: action.target_identifiers ?? targetIdentifiersFromRuntimeState(issueId, action.pre_state ?? currentState),
    pre_state: action.pre_state ?? currentState,
    post_state: action.post_state ?? currentState
  };
  const existing = operatorActions.get(issueId) ?? [];
  const updated = [...existing, normalized].slice(-20);
  operatorActions.set(issueId, updated);
  void context.persistence?.upsertOperatorActions?.(issueId, JSON.stringify(updated));
  void context.persistence
    ?.appendOperatorActionHistory?.({
      issue_run_id:
        stringOrNull(normalized.target_identifiers?.issue_run_id) ??
        stringOrNull((normalized.pre_state ?? {}).issue_run_id),
      attempt_id: stringOrNull(normalized.target_identifiers?.attempt_id),
      thread_id: stringOrNull(normalized.target_identifiers?.thread_id),
      turn_id: stringOrNull(normalized.target_identifiers?.turn_id),
      action: normalized.action,
      actor: normalized.actor ?? 'operator',
      result: normalized.result,
      result_code: normalized.result_code,
      message: normalized.message,
      reason_note: normalized.reason_note,
      phase: stringOrNull((normalized.pre_state ?? {}).current_phase) ?? stringOrNull((normalized.pre_state ?? {}).last_phase),
      state_context: {
        issue_id: issueId,
        target_identifiers: normalized.target_identifiers ?? null,
        pre_state: normalized.pre_state ?? null,
        post_state: normalized.post_state ?? null
      },
      requested_at: new Date(normalized.requested_at_ms).toISOString(),
      observed_at: new Date(context.nowMs()).toISOString()
    })
    ?.catch((error: unknown) => {
      void context.hooks.recordHistoryWriteFailure('appendOperatorActionHistory', normalized.result_code ?? normalized.action, error);
    });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function targetIdentifiersFromRuntimeState(
  issueId: string,
  runtimeState: Record<string, unknown>
): NonNullable<OperatorActionRecord['target_identifiers']> {
  return {
    issue_id: issueId,
    issue_identifier: typeof runtimeState.issue_identifier === 'string' ? runtimeState.issue_identifier : null,
    issue_run_id: typeof runtimeState.issue_run_id === 'string' ? runtimeState.issue_run_id : null,
    run_id: typeof runtimeState.run_id === 'string' ? runtimeState.run_id : null,
    attempt_id: typeof runtimeState.attempt_id === 'string' ? runtimeState.attempt_id : null,
    thread_id: typeof runtimeState.thread_id === 'string' ? runtimeState.thread_id : null,
    turn_id: typeof runtimeState.turn_id === 'string' ? runtimeState.turn_id : null,
    session_id: typeof runtimeState.session_id === 'string' ? runtimeState.session_id : null
  };
}
