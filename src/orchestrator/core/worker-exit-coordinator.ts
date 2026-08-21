import type { Issue } from '../../tracker';
import type { StructuredLogger } from '../../observability';
import { CANONICAL_EVENT } from '../../observability/events';
import { REASON_CODES } from '../../observability/reason-codes';
import {
  isMissingToolOutputRecoveryInProgress,
  workerTerminationResultContext,
  workerTerminationResultDetail
} from './blocked-input-recovery';
import {
  applyWorkerExitLineage,
  findReleasedWorkerRecord,
  normalizeCodexAppServerPid,
  normalizeWorkerInstanceId,
  recordTerminationExitObserved,
  rememberInactiveWorkerPid,
  staleWorkerExitReasonForRunningEntry
} from './worker-events';
import type {
  BlockedEntry,
  BudgetRuntimeProjection,
  MissingToolOutputRecoveryState,
  OrchestratorOptions,
  OrchestratorState,
  ProgressSignals,
  RetryDelayType,
  RunningEntry,
  WorkerCompletionReason,
  WorkerExitDetails,
  WorkerExitReason
} from '../types';

const DEFAULT_INACTIVE_WORKER_PID_TTL_MS = 60 * 60 * 1000;

export interface WorkerExitScheduleRetryParams {
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

export interface WorkerExitBlockedInputParams {
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

export interface WorkerExitWorkspaceConflictContext {
  detail: string;
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
}

export interface WorkerExitCoordinatorHooks {
  normalStopForWorkerCompletion: (
    completionReason: WorkerCompletionReason | null,
    refreshedState: string | null
  ) => {
    reason_code: string;
    detail: string;
    message: string;
    cleanup_workspace: boolean;
  } | null;
  completeRunRecord: (
    runningEntry: RunningEntry,
    terminalStatus: 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'cancelled',
    errorCode: string | null,
    recoveryOverride?: MissingToolOutputRecoveryState | null,
    terminalReasonDetail?: string | null
  ) => Promise<void>;
  scheduleRetry: (params: WorkerExitScheduleRetryParams) => Promise<void>;
  scheduleBlockedInput: (params: WorkerExitBlockedInputParams) => Promise<{ created: boolean }>;
  scheduleRecoveryStartFailedBlock: (issueId: string, running: RunningEntry, error: string) => Promise<void>;
  persistExecutionGraphStateTransition: (
    runningEntry: RunningEntry,
    toStatus: string,
    status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying',
    reasonCode: string,
    reasonDetail: string | null
  ) => Promise<void>;
  emitPhaseMarker: (
    issueId: string,
    marker: {
      phase: string;
      detail: string | null;
      attempt: number;
      thread_id?: string | null;
      session_id?: string | null;
    }
  ) => void;
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
  addRuntimeSecondsFromEntry: (runningEntry: RunningEntry) => void;
  recordBudgetUsageSample: (issueId: string, totalTokens: number, timestampMs: number) => void;
  inferStopReasonCode: (error: string | undefined, fallback: string) => string;
  inferInputRequiredDetail: (
    error: string | undefined,
    fallbackReason: string
  ) => {
    detail: string;
    request_id: string | null;
    request_method: string | null;
    prompt_text: string | null;
    questions: Array<{ id: string; prompt?: string; options?: Array<{ label: string; value?: string }> }>;
  };
  inferWorkspaceConflictContext: (
    error: string | undefined,
    fallbackReason: string
  ) => WorkerExitWorkspaceConflictContext;
}

export interface WorkerExitCoordinatorContext {
  readonly state: OrchestratorState;
  readonly config: OrchestratorOptions['config'];
  readonly ports: OrchestratorOptions['ports'];
  readonly persistence: OrchestratorOptions['persistence'] | undefined;
  readonly logger: StructuredLogger | undefined;
  readonly nowMs: () => number;
  readonly hooks: WorkerExitCoordinatorHooks;
}

export async function coordinateWorkerExit(
  context: WorkerExitCoordinatorContext,
  issue_id: string,
  reason: WorkerExitReason,
  error?: string,
  details: WorkerExitDetails = {}
): Promise<void> {
    const running = context.state.running.get(issue_id);
    if (!running) {
      const releasedWorker = findReleasedWorkerRecord(context.state.released_workers, issue_id, details);
      if (context.state.completed.has(issue_id) || releasedWorker) {
        context.logger?.log({
          level: 'info',
          event: CANONICAL_EVENT.orchestration.staleWorkerExitIgnored,
          message: 'late worker exit observed after runtime ownership was already released',
          context: {
            issue_id,
            reason,
            error: error ?? null,
            completion_reason: details.completion_reason ?? null,
            refreshed_state: details.refreshed_state ?? null,
            stale_reason: 'ownership_already_released',
            release_reason: releasedWorker?.reason ?? null,
            release_session_id: releasedWorker?.session_id ?? null,
            event_worker_instance_id: normalizeWorkerInstanceId(details.worker_instance_id),
            event_codex_app_server_pid: normalizeCodexAppServerPid(details.codex_app_server_pid),
            event_thread_id: details.thread_id ?? null,
            event_turn_id: details.turn_id ?? null,
            event_session_id: details.session_id ?? null
          }
        });
      }
      return;
    }

    const staleExitReason = staleWorkerExitReasonForRunningEntry(running, details);
    if (staleExitReason) {
      context.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.orchestration.staleWorkerExitIgnored,
        message: 'stale worker exit ignored for active run',
        context: {
          issue_id,
          issue_identifier: running.identifier,
          reason,
          error: error ?? null,
          completion_reason: details.completion_reason ?? null,
          refreshed_state: details.refreshed_state ?? null,
          stale_reason: staleExitReason,
          termination_state: running.termination?.state ?? null,
          termination_reason: running.termination?.reason ?? null,
          active_run_id: running.run_id ?? null,
          active_issue_run_id: running.issue_run_id ?? null,
          active_attempt_id: running.attempt_id ?? null,
          active_worker_instance_id: running.worker_instance_id ?? null,
          event_worker_instance_id: normalizeWorkerInstanceId(details.worker_instance_id),
          active_codex_app_server_pid: running.codex_app_server_pid ?? null,
          event_codex_app_server_pid: normalizeCodexAppServerPid(details.codex_app_server_pid),
          active_thread_id: running.thread_id ?? null,
          event_thread_id: details.thread_id ?? null,
          active_turn_id: running.turn_id ?? null,
          event_turn_id: details.turn_id ?? null,
          active_session_id: running.session_id ?? null,
          event_session_id: details.session_id ?? null
        }
      });
      context.ports.notifyObservers?.();
      return;
    }

    await applyWorkerExitLineage({
      running,
      details,
      persistSession: (params) => context.persistence?.recordSession(params) ?? Promise.resolve()
    });

    if (running.termination) {
      recordTerminationExitObserved({
        issueId: issue_id,
        running,
        reason,
        error,
        details,
        observedAtMs: context.nowMs(),
        logger: context.logger
      });
      context.ports.notifyObservers?.();
      return;
    }

    rememberInactiveWorkerPid({
      state: context.state,
      runningEntry: running,
      reason: details.completion_reason ?? reason,
      nowMs: context.nowMs(),
      ttlMs: context.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
    });
    context.state.running.delete(issue_id);
    context.hooks.addRuntimeSecondsFromEntry(running);
    context.hooks.recordBudgetUsageSample(issue_id, running.tokens.total_tokens, context.nowMs());

    if (reason === 'normal') {
      const completionReason = details.completion_reason ?? null;
      if (isMissingToolOutputRecoveryInProgress(running)) {
        running.recovery = {
          ...running.recovery,
          last_result: 'succeeded',
          last_result_reason_code: completionReason ?? REASON_CODES.normalCompletion,
          last_result_detail: details.refreshed_state
            ? `recovery turn completed after refreshed issue state: ${details.refreshed_state}`
            : 'recovery turn completed'
        };
        context.hooks.recordRuntimeEvent({
          event: CANONICAL_EVENT.orchestration.missingToolOutputRecoveryStarted,
          severity: 'info',
          issue_identifier: running.identifier,
          session_id: running.session_id ?? undefined,
          detail: `result=succeeded completion_reason=${completionReason ?? REASON_CODES.normalCompletion} refreshed_state=${details.refreshed_state ?? 'unknown'}`
        });
      }
      if (completionReason === REASON_CODES.issueStateRefreshFailed) {
        const stopReasonDetail = error ?? 'tracker state refresh failed after completed turn';
        context.hooks.emitPhaseMarker(issue_id, {
          phase: 'completed',
          detail: 'worker exited normally; tracker refresh pending',
          attempt: running.retry_attempt,
          thread_id: running.thread_id,
          session_id: running.session_id
        });
        await context.hooks.completeRunRecord(running, 'succeeded', REASON_CODES.issueStateRefreshFailed, null, stopReasonDetail);
        await context.hooks.persistExecutionGraphStateTransition(
          running,
          'retrying',
          'retrying',
          REASON_CODES.issueStateRefreshFailed,
          stopReasonDetail
        );
        context.state.completed.add(issue_id);
        await context.hooks.scheduleRetry({
          issue_id,
          identifier: running.identifier,
          attempt: 1,
          issue_run_id: running.issue_run_id ?? null,
          previous_attempt_id: running.attempt_id ?? null,
          delay_type: 'failure',
          error: 'tracker state refresh pending',
          worker_host: running.worker_host ?? null,
          workspace_path: running.workspace_path ?? null,
          provisioner_type: running.provisioner_type ?? null,
          branch_name: running.branch_name ?? null,
          repo_root: running.repo_root ?? null,
          workspace_exists: running.workspace_exists,
          workspace_git_status: running.workspace_git_status,
          workspace_provisioned: running.workspace_provisioned,
          workspace_is_git_worktree: running.workspace_is_git_worktree,
          copy_ignored_applied: running.copy_ignored_applied,
          copy_ignored_status: running.copy_ignored_status,
          copy_ignored_summary: running.copy_ignored_summary,
          stop_reason_code: REASON_CODES.issueStateRefreshFailed,
          stop_reason_detail: stopReasonDetail,
          previous_thread_id: running.thread_id,
          previous_turn_id: running.turn_id,
          previous_session_id: running.session_id,
          issue_snapshot: running.issue,
          progress_signals: running.progress_signals,
          budget: running.budget,
          recovery: running.recovery ? { ...running.recovery } : null
        });
        context.logger?.log({
          level: 'warn',
          event: CANONICAL_EVENT.orchestration.workerExitHandled,
          message: 'worker exit handled: completed; tracker refresh retry pending',
          context: {
            issue_id,
            issue_identifier: running.identifier,
            session_id: running.session_id,
            reason,
            outcome: 'tracker_refresh_pending',
            retry_attempt: 1,
            stop_reason_code: REASON_CODES.issueStateRefreshFailed,
            error: stopReasonDetail
          }
        });
        context.ports.notifyObservers?.();
        return;
      }
      const normalStop = context.hooks.normalStopForWorkerCompletion(completionReason, details.refreshed_state ?? null);
      if (normalStop) {
        context.hooks.emitPhaseMarker(issue_id, {
          phase: 'completed',
          detail: normalStop.detail,
          attempt: running.retry_attempt,
          thread_id: running.thread_id,
          session_id: running.session_id
        });
        const terminationResult = normalStop.cleanup_workspace
          ? await context.ports.terminateWorker({
            issue_id,
            worker_handle: running.worker_handle,
            cleanup_workspace: true,
            reason: 'terminal_state_transition'
          })
          : null;
        const terminalReasonDetail = terminationResult
          ? workerTerminationResultDetail(normalStop.detail, terminationResult)
          : normalStop.detail;
        await context.hooks.completeRunRecord(running, 'succeeded', normalStop.reason_code, null, terminalReasonDetail);
        await context.hooks.persistExecutionGraphStateTransition(
          running,
          'succeeded',
          'succeeded',
          normalStop.reason_code,
          terminalReasonDetail
        );
        context.state.completed.add(issue_id);
        context.state.claimed.delete(issue_id);
        context.logger?.log({
          level: 'info',
          event: CANONICAL_EVENT.orchestration.workerExitHandled,
          message: normalStop.message,
          context: {
            issue_id,
            issue_identifier: running.identifier,
            session_id: running.session_id,
            reason,
            outcome: 'completed',
            completion_reason: completionReason,
            refreshed_state: details.refreshed_state ?? null,
            stop_reason_code: normalStop.reason_code,
            ...workerTerminationResultContext(terminationResult),
            cleanup_workspace: normalStop.cleanup_workspace,
            worker_termination_requested: normalStop.cleanup_workspace,
            worker_process_identity_known: Boolean(running.worker_process_pid ?? running.codex_app_server_pid),
            worker_process_pid: running.worker_process_pid ?? null,
            codex_app_server_pid: running.codex_app_server_pid,
            same_issue_process_cleanup_verified: false
          }
        });
        context.ports.notifyObservers?.();
        return;
      }

      context.hooks.emitPhaseMarker(issue_id, {
        phase: 'completed',
        detail: 'worker exited normally',
        attempt: running.retry_attempt,
        thread_id: running.thread_id,
        session_id: running.session_id
      });
      await context.hooks.completeRunRecord(running, 'succeeded', null);
      await context.hooks.persistExecutionGraphStateTransition(
        running,
        'retrying',
        'retrying',
        REASON_CODES.normalCompletion,
        'normal worker completion, continuing while issue is active'
      );
      context.state.completed.add(issue_id);
      await context.hooks.scheduleRetry({
        issue_id,
        identifier: running.identifier,
        attempt: 1,
        issue_run_id: running.issue_run_id ?? null,
        previous_attempt_id: running.attempt_id ?? null,
        delay_type: 'continuation',
        error: null,
        worker_host: running.worker_host ?? null,
        workspace_path: running.workspace_path ?? null,
        provisioner_type: running.provisioner_type ?? null,
        branch_name: running.branch_name ?? null,
        repo_root: running.repo_root ?? null,
        workspace_exists: running.workspace_exists,
        workspace_git_status: running.workspace_git_status,
      workspace_provisioned: running.workspace_provisioned,
      workspace_is_git_worktree: running.workspace_is_git_worktree,
      copy_ignored_applied: running.copy_ignored_applied,
      copy_ignored_status: running.copy_ignored_status,
      copy_ignored_summary: running.copy_ignored_summary,
        stop_reason_code: REASON_CODES.normalCompletion,
        stop_reason_detail: 'normal worker completion, continuing while issue is active',
        previous_thread_id: running.thread_id,
        previous_turn_id: running.turn_id,
        previous_session_id: running.session_id,
        issue_snapshot: running.issue,
        progress_signals: running.progress_signals,
        budget: running.budget,
        recovery: running.recovery ? { ...running.recovery } : null
      });
      context.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.orchestration.workerExitHandled,
        message: 'worker exit handled: completed; retrying continuation',
        context: {
          issue_id,
          issue_identifier: running.identifier,
          session_id: running.session_id,
          reason,
          outcome: 'completed',
          retry_attempt: 1
        }
      });
    } else {
      const recoveryFailure = isMissingToolOutputRecoveryInProgress(running)
        ? {
            ...running.recovery,
            last_result: 'failed' as const,
            last_result_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
            last_result_detail: error ?? `worker exited: ${reason}`
          }
        : null;
      await context.hooks.completeRunRecord(running, 'failed', error ?? `worker exited: ${reason}`, recoveryFailure);
      context.state.health.last_error = `worker exited for ${running.identifier}`;
      const stopReasonCode = context.hooks.inferStopReasonCode(error, REASON_CODES.workerExitAbnormal);
      if (isMissingToolOutputRecoveryInProgress(running)) {
        await context.hooks.scheduleRecoveryStartFailedBlock(issue_id, running, error ?? `worker exited: ${reason}`);
        context.ports.notifyObservers?.();
        return;
      }
      if (stopReasonCode === REASON_CODES.turnInputRequired) {
        const inputDetail = context.hooks.inferInputRequiredDetail(error, reason);
        const stopReasonDetail = inputDetail.detail;
        context.hooks.emitPhaseMarker(issue_id, {
          phase: 'blocked_input',
          detail: stopReasonDetail,
          attempt: running.retry_attempt + 1,
          thread_id: running.thread_id,
          session_id: running.session_id
        });
        await context.hooks.scheduleBlockedInput({
          issue_id,
          issue_identifier: running.identifier,
          attempt: running.retry_attempt + 1,
          issue_run_id: running.issue_run_id ?? null,
          previous_attempt_id: running.attempt_id ?? null,
          worker_host: running.worker_host ?? null,
          workspace_path: running.workspace_path ?? null,
          provisioner_type: running.provisioner_type ?? null,
          branch_name: running.branch_name ?? null,
          repo_root: running.repo_root ?? null,
          workspace_exists: running.workspace_exists,
          workspace_git_status: running.workspace_git_status,
          workspace_provisioned: running.workspace_provisioned,
          workspace_is_git_worktree: running.workspace_is_git_worktree,
          copy_ignored_applied: running.copy_ignored_applied,
          copy_ignored_status: running.copy_ignored_status,
          copy_ignored_summary: running.copy_ignored_summary,
          stop_reason_code: REASON_CODES.turnInputRequired,
          stop_reason_detail: stopReasonDetail,
          pending_input: inputDetail,
          session_console: running.recent_events,
          previous_thread_id: running.thread_id,
          previous_turn_id: running.turn_id,
          previous_session_id: running.session_id
        });
        context.logger?.log({
          level: 'warn',
          event: CANONICAL_EVENT.orchestration.workerExitHandled,
          message: 'worker exit handled: blocked on operator input',
          context: {
            issue_id,
            issue_identifier: running.identifier,
            session_id: running.session_id,
            reason,
            outcome: 'blocked',
            stop_reason_code: REASON_CODES.turnInputRequired,
            error: stopReasonDetail
          }
        });
        await context.hooks.persistExecutionGraphStateTransition(running, 'blocked', 'blocked', REASON_CODES.turnInputRequired, stopReasonDetail);
        context.ports.notifyObservers?.();
        return;
      }
      if (stopReasonCode === REASON_CODES.operatorWorkspaceConflict) {
        const workspaceConflict = context.hooks.inferWorkspaceConflictContext(error, reason);
        context.hooks.emitPhaseMarker(issue_id, {
          phase: 'blocked_input',
          detail: workspaceConflict.detail,
          attempt: running.retry_attempt + 1,
          thread_id: running.thread_id,
          session_id: running.session_id
        });
        await context.hooks.scheduleBlockedInput({
          issue_id,
          issue_identifier: running.identifier,
          attempt: running.retry_attempt + 1,
          issue_run_id: running.issue_run_id ?? null,
          previous_attempt_id: running.attempt_id ?? null,
          worker_host: running.worker_host ?? null,
          workspace_path: running.workspace_path ?? null,
          provisioner_type: running.provisioner_type ?? null,
          branch_name: running.branch_name ?? null,
          repo_root: running.repo_root ?? null,
          workspace_exists: running.workspace_exists,
          workspace_git_status: running.workspace_git_status,
          workspace_provisioned: running.workspace_provisioned,
          workspace_is_git_worktree: running.workspace_is_git_worktree,
          copy_ignored_applied: running.copy_ignored_applied,
          copy_ignored_status: running.copy_ignored_status,
          copy_ignored_summary: running.copy_ignored_summary,
          stop_reason_code: REASON_CODES.operatorWorkspaceConflict,
          stop_reason_detail: workspaceConflict.detail,
          conflict_files: workspaceConflict.conflict_files,
          classification_summary: workspaceConflict.classification_summary,
          resolution_hints: workspaceConflict.resolution_hints,
          session_console: running.recent_events,
          previous_thread_id: running.thread_id,
          previous_turn_id: running.turn_id,
          previous_session_id: running.session_id
        });
        context.logger?.log({
          level: 'warn',
          event: CANONICAL_EVENT.orchestration.workerExitHandled,
          message: 'worker exit handled: blocked on workspace conflict',
          context: {
            issue_id,
            issue_identifier: running.identifier,
            session_id: running.session_id,
            reason,
            outcome: 'blocked',
            stop_reason_code: REASON_CODES.operatorWorkspaceConflict,
            error: workspaceConflict.detail
          }
        });
        await context.hooks.persistExecutionGraphStateTransition(
          running,
          'blocked',
          'blocked',
          REASON_CODES.operatorWorkspaceConflict,
          workspaceConflict.detail
        );
        context.ports.notifyObservers?.();
        return;
      }

      if (stopReasonCode === REASON_CODES.freshDispatchNoRoute) {
        const stopReasonDetail = error ?? 'fresh workflow phase completed without routing the issue';
        context.hooks.emitPhaseMarker(issue_id, {
          phase: 'blocked_input',
          detail: stopReasonDetail,
          attempt: running.retry_attempt + 1,
          thread_id: running.thread_id,
          session_id: running.session_id
        });
        await context.hooks.scheduleBlockedInput({
          issue_id,
          issue_identifier: running.identifier,
          attempt: running.retry_attempt + 1,
          issue_run_id: running.issue_run_id ?? null,
          previous_attempt_id: running.attempt_id ?? null,
          worker_host: running.worker_host ?? null,
          workspace_path: running.workspace_path ?? null,
          provisioner_type: running.provisioner_type ?? null,
          branch_name: running.branch_name ?? null,
          repo_root: running.repo_root ?? null,
          workspace_exists: running.workspace_exists,
          workspace_git_status: running.workspace_git_status,
          workspace_provisioned: running.workspace_provisioned,
          workspace_is_git_worktree: running.workspace_is_git_worktree,
          copy_ignored_applied: running.copy_ignored_applied,
          copy_ignored_status: running.copy_ignored_status,
          copy_ignored_summary: running.copy_ignored_summary,
          stop_reason_code: REASON_CODES.freshDispatchNoRoute,
          stop_reason_detail: stopReasonDetail,
          session_console: running.recent_events,
          previous_thread_id: running.thread_id,
          previous_turn_id: running.turn_id,
          previous_session_id: running.session_id,
          required_actions: ['Inspect the phase blocker', 'Correct the required evidence or tracker state', 'Requeue the issue']
        });
        await context.hooks.persistExecutionGraphStateTransition(
          running,
          'blocked',
          'blocked',
          REASON_CODES.freshDispatchNoRoute,
          stopReasonDetail
        );
        context.logger?.log({
          level: 'warn',
          event: CANONICAL_EVENT.orchestration.workerExitHandled,
          message: 'worker exit handled: fresh workflow phase did not route',
          context: {
            issue_id,
            issue_identifier: running.identifier,
            session_id: running.session_id,
            reason,
            outcome: 'blocked',
            stop_reason_code: REASON_CODES.freshDispatchNoRoute,
            error: stopReasonDetail
          }
        });
        context.ports.notifyObservers?.();
        return;
      }

      if (details.retryable === false) {
        const stopReasonDetail = error ?? `worker exited: ${reason}`;
        context.hooks.emitPhaseMarker(issue_id, {
          phase: 'failed',
          detail: stopReasonDetail,
          attempt: running.retry_attempt,
          thread_id: running.thread_id,
          session_id: running.session_id
        });
        await context.hooks.persistExecutionGraphStateTransition(
          running,
          'failed',
          'failed',
          stopReasonCode,
          stopReasonDetail
        );
        await context.hooks.scheduleBlockedInput({
          issue_id,
          issue_identifier: running.identifier,
          attempt: running.retry_attempt + 1,
          issue_run_id: running.issue_run_id ?? null,
          previous_attempt_id: running.attempt_id ?? null,
          worker_host: running.worker_host ?? null,
          workspace_path: running.workspace_path ?? null,
          provisioner_type: running.provisioner_type ?? null,
          branch_name: running.branch_name ?? null,
          repo_root: running.repo_root ?? null,
          workspace_exists: running.workspace_exists,
          workspace_git_status: running.workspace_git_status,
          workspace_provisioned: running.workspace_provisioned,
          workspace_is_git_worktree: running.workspace_is_git_worktree,
          copy_ignored_applied: running.copy_ignored_applied,
          copy_ignored_status: running.copy_ignored_status,
          copy_ignored_summary: running.copy_ignored_summary,
          stop_reason_code: stopReasonCode,
          stop_reason_detail: stopReasonDetail,
          session_console: running.recent_events,
          previous_thread_id: running.thread_id,
          previous_turn_id: running.turn_id,
          previous_session_id: running.session_id,
          required_actions: ['Correct the non-retryable failure', 'Resume the issue explicitly'],
          apply_circuit_breaker: true
        });
        context.logger?.log({
          level: 'error',
          event: CANONICAL_EVENT.orchestration.workerExitHandled,
          message: 'worker exit handled: non-retryable failure',
          context: {
            issue_id,
            issue_identifier: running.identifier,
            session_id: running.session_id,
            reason,
            outcome: 'failed',
            retryable: false,
            stop_reason_code: stopReasonCode,
            error: error ?? null
          }
        });
        context.state.claimed.delete(issue_id);
        context.ports.notifyObservers?.();
        return;
      }

      await context.hooks.scheduleRetry({
        issue_id,
        identifier: running.identifier,
        attempt: running.retry_attempt + 1,
        issue_run_id: running.issue_run_id ?? null,
        previous_attempt_id: running.attempt_id ?? null,
        delay_type: 'failure',
        error: error ?? `worker exited: ${reason}`,
        worker_host: running.worker_host ?? null,
        workspace_path: running.workspace_path ?? null,
        provisioner_type: running.provisioner_type ?? null,
        branch_name: running.branch_name ?? null,
        repo_root: running.repo_root ?? null,
        workspace_exists: running.workspace_exists,
        workspace_git_status: running.workspace_git_status,
        workspace_provisioned: running.workspace_provisioned,
        workspace_is_git_worktree: running.workspace_is_git_worktree,
        copy_ignored_applied: running.copy_ignored_applied,
        copy_ignored_status: running.copy_ignored_status,
        copy_ignored_summary: running.copy_ignored_summary,
        stop_reason_code: stopReasonCode,
        stop_reason_detail: error ?? `worker exited: ${reason}`,
        previous_thread_id: running.thread_id,
        previous_turn_id: running.turn_id,
        previous_session_id: running.session_id,
        issue_snapshot: running.issue,
        progress_signals: running.progress_signals,
        budget: running.budget,
        recovery: running.recovery ? { ...running.recovery } : null
      });
      context.hooks.emitPhaseMarker(issue_id, {
        phase: 'failed',
        detail: error ?? `worker exited: ${reason}`,
        attempt: running.retry_attempt,
        thread_id: running.thread_id,
        session_id: running.session_id
      });
      context.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.orchestration.workerExitHandled,
        message: 'worker exit handled: failed; retrying',
        context: {
          issue_id,
          issue_identifier: running.identifier,
          session_id: running.session_id,
          reason,
          outcome: 'failed',
          retry_attempt: running.retry_attempt + 1,
          error: error ?? null
        }
      });
      await context.hooks.persistExecutionGraphStateTransition(
        running,
        'retrying',
        'retrying',
        stopReasonCode,
        error ?? `worker exited: ${reason}`
      );
    }

    context.ports.notifyObservers?.();
}
