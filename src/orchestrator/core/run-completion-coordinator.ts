import type { StructuredLogger } from '../../observability';
import { CANONICAL_EVENT } from '../../observability/events';
import { REASON_CODES } from '../../observability/reason-codes';
import {
  buildDurableMissingToolOutputRecoveryContext,
  workerTerminationResultContext,
  workerTerminationResultDetail
} from './blocked-input-recovery';
import { rememberInactiveWorkerPid, rememberReleasedWorker } from './worker-events';
import type {
  MissingToolOutputRecoveryState,
  OrchestratorOptions,
  OrchestratorState,
  RunningEntry,
  WorkerTerminationResult
} from '../types';

const DEFAULT_INACTIVE_WORKER_PID_TTL_MS = 60 * 60 * 1000;

type TerminalStatus = 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'cancelled';

interface RootCauseDiagnostic {
  status: 'blocked' | 'running' | null;
  reason_code: string | null;
  reason_detail: string | null;
  at: string | null;
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
}

interface PersistedCompletionLineage {
  thread_id: string | null;
  turn_id: string | null;
}

interface CompletionProjection {
  process_status: TerminalStatus;
  workflow_outcome: string;
}

export function successfulWorkflowTerminationProjection(reason: string): CompletionProjection | null {
  if (reason === REASON_CODES.handoffStateReached || reason === REASON_CODES.handoffRelease) {
    return { process_status: 'cancelled', workflow_outcome: 'handoff_reached' };
  }
  if (reason === REASON_CODES.terminalStateReached) {
    return { process_status: 'cancelled', workflow_outcome: 'succeeded' };
  }
  return null;
}

function persistedCompletionLineage(
  runningEntry: RunningEntry,
  preferredThreadId: string | null,
  preferredTurnId: string | null
): PersistedCompletionLineage {
  if (!runningEntry.issue_run_id) {
    return {
      thread_id: preferredThreadId ?? runningEntry.thread_id ?? null,
      turn_id: preferredTurnId ?? runningEntry.turn_id ?? null
    };
  }
  const persistedThreadId = runningEntry.persisted_thread_id ?? null;
  const observedThreadId = preferredThreadId ?? runningEntry.thread_id;
  const threadId =
    persistedThreadId && (!observedThreadId || observedThreadId === persistedThreadId) ? persistedThreadId : null;
  if (!threadId) {
    return { thread_id: null, turn_id: null };
  }
  const persistedTurnIds = runningEntry.persisted_turn_ids ?? [];
  const turnId = [preferredTurnId, runningEntry.turn_id].find(
    (candidate): candidate is string => Boolean(candidate && persistedTurnIds.includes(candidate))
  );
  return { thread_id: threadId, turn_id: turnId ?? null };
}

export interface RunCompletionCoordinatorHooks {
  drainExecutionGraphPersistence: (runningEntry: RunningEntry) => Promise<void>;
  recordHistoryWriteFailure: (operation: string, reasonCode: string, error: unknown) => Promise<void>;
  persistExecutionGraphStateTransition: (
    runningEntry: RunningEntry,
    toStatus: string,
    status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying',
    reasonCode: string,
    reasonDetail: string | null
  ) => Promise<void>;
}

export interface RunCompletionCoordinatorContext {
  readonly state: OrchestratorState;
  readonly config: OrchestratorOptions['config'];
  readonly terminateWorker: OrchestratorOptions['ports']['terminateWorker'];
  readonly cancelRetryTimer: OrchestratorOptions['ports']['cancelRetryTimer'];
  readonly notifyObservers?: OrchestratorOptions['ports']['notifyObservers'];
  readonly persistence: OrchestratorOptions['persistence'] | undefined;
  readonly logger: StructuredLogger | undefined;
  readonly nowMs: () => number;
  readonly hooks: RunCompletionCoordinatorHooks;
}

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

export function addRuntimeSecondsFromEntry(context: RunCompletionCoordinatorContext, runningEntry: RunningEntry): void {
  context.state.codex_totals.seconds_running += Math.max(0, Math.floor((context.nowMs() - runningEntry.started_at_ms) / 1000));
}

export function workerTerminationAllowsRecovery(result: WorkerTerminationResult): boolean {
  return (
    result.result === 'succeeded' &&
    result.cancellation_supported &&
    result.cancellation_requested &&
    result.worker_settled === true &&
    (result.forced_kill_requested ? result.forced_kill_settled === true : true)
  );
}

export function workerTerminationInterruptStatus(
  result: WorkerTerminationResult
): NonNullable<MissingToolOutputRecoveryState['interrupt_cancel_result']>['status'] {
  if (workerTerminationAllowsRecovery(result)) {
    return 'succeeded';
  }
  if (result.result === 'unknown') {
    return 'unknown';
  }
  return 'failed';
}

export async function terminateRunningIssue(
  context: RunCompletionCoordinatorContext,
  issue_id: string,
  cleanup_workspace: boolean,
  reason: string
): Promise<void> {
  const runningEntry = context.state.running.get(issue_id);
  if (!runningEntry) {
    return;
  }

  const requestedAtMs = context.nowMs();
  runningEntry.termination = {
    state: 'requested',
    reason,
    cleanup_workspace,
    requested_at_ms: requestedAtMs,
    worker_handle: runningEntry.worker_handle,
    worker_instance_id: runningEntry.worker_instance_id ?? null,
    codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
    worker_process_pid: runningEntry.worker_process_pid ?? null,
    thread_id: runningEntry.thread_id ?? null,
    turn_id: runningEntry.turn_id ?? null,
    session_id: runningEntry.session_id ?? null
  };

  context.logger?.log({
    level: 'info',
    event: CANONICAL_EVENT.orchestration.workerTerminated,
    message: `worker termination requested: ${reason}`,
    context: {
      issue_id,
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id,
      cleanup_workspace,
      reason,
      termination_state: 'requested',
      worker_instance_id: runningEntry.worker_instance_id ?? null,
      worker_process_identity_known: Boolean(runningEntry.worker_process_pid ?? runningEntry.codex_app_server_pid),
      worker_process_pid: runningEntry.worker_process_pid ?? null,
      codex_app_server_pid: runningEntry.codex_app_server_pid,
      thread_id: runningEntry.thread_id,
      turn_id: runningEntry.turn_id
    }
  });

  let terminationResult: WorkerTerminationResult | null = null;
  try {
    terminationResult = await context.terminateWorker({
      issue_id,
      worker_handle: runningEntry.worker_handle,
      cleanup_workspace,
      reason
    });
  } catch (error) {
    const failureDetail = error instanceof Error ? error.message : String(error);
    if (context.state.running.get(issue_id) === runningEntry) {
      runningEntry.termination = {
        ...runningEntry.termination,
        state: 'failed',
        failure_at_ms: context.nowMs(),
        failure_detail: failureDetail
      };
      context.state.health.last_error = `worker termination failed for ${runningEntry.identifier}: ${failureDetail}`;
    }
    context.logger?.log({
      level: 'error',
      event: CANONICAL_EVENT.orchestration.workerTerminated,
      message: `worker termination failed: ${reason}`,
      context: {
        issue_id,
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id,
        cleanup_workspace,
        reason,
        termination_state: 'failed',
        error: failureDetail,
        worker_instance_id: runningEntry.worker_instance_id ?? null,
        worker_process_identity_known: Boolean(runningEntry.worker_process_pid ?? runningEntry.codex_app_server_pid),
        worker_process_pid: runningEntry.worker_process_pid ?? null,
        codex_app_server_pid: runningEntry.codex_app_server_pid,
        thread_id: runningEntry.thread_id,
        turn_id: runningEntry.turn_id
      }
    });
    context.notifyObservers?.();
    return;
  }

  if (context.state.running.get(issue_id) !== runningEntry) {
    context.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.workerTerminated,
      message: 'worker termination finalization skipped for superseded ownership',
      context: {
        issue_id,
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id,
        cleanup_workspace,
        reason,
        termination_state: runningEntry.termination?.state ?? null,
        active_worker_instance_id: context.state.running.get(issue_id)?.worker_instance_id ?? null,
        released_worker_instance_id: runningEntry.worker_instance_id ?? null
      }
    });
    return;
  }

  runningEntry.termination = {
    ...runningEntry.termination,
    state: 'finalizing'
  };

  const finalizationDetail = workerTerminationResultDetail(`worker termination finalized: ${reason}`, terminationResult);
  const successfulWorkflowProjection = successfulWorkflowTerminationProjection(reason);
  const terminalStatus: TerminalStatus = successfulWorkflowProjection ? 'succeeded' : 'cancelled';
  addRuntimeSecondsFromEntry(context, runningEntry);
  await completeRunRecord(
    context,
    runningEntry,
    terminalStatus,
    reason,
    null,
    finalizationDetail,
    successfulWorkflowProjection ?? undefined
  );
  await context.hooks.persistExecutionGraphStateTransition(
    runningEntry,
    successfulWorkflowProjection?.workflow_outcome ?? 'cancelled',
    terminalStatus,
    reason,
    finalizationDetail
  );
  rememberInactiveWorkerPid({
    state: context.state,
    runningEntry,
    reason,
    nowMs: context.nowMs(),
    ttlMs: context.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
  });
  rememberReleasedWorker({ state: context.state, runningEntry, reason, cleanupWorkspace: cleanup_workspace, nowMs: context.nowMs() });
  context.state.running.delete(issue_id);
  context.state.claimed.delete(issue_id);
  if (successfulWorkflowProjection) {
    context.state.completed.add(issue_id);
  }
  context.logger?.log({
    level: 'info',
    event: CANONICAL_EVENT.orchestration.workerTerminated,
    message: `worker termination finalized: ${reason}`,
    context: {
      issue_id,
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id,
      cleanup_workspace,
      reason,
      termination_state: 'finalized',
      termination_exit_observed: Boolean(runningEntry.termination.exit_observed_at_ms),
      ...workerTerminationResultContext(terminationResult),
      worker_termination_requested: true,
      worker_process_identity_known: Boolean(runningEntry.worker_process_pid ?? runningEntry.codex_app_server_pid),
      worker_process_pid: runningEntry.worker_process_pid ?? null,
      codex_app_server_pid: runningEntry.codex_app_server_pid,
      same_issue_process_cleanup_verified: false
    }
  });

  const retry = context.state.retry_attempts.get(issue_id);
  if (retry) {
    context.cancelRetryTimer(retry.timer_handle);
    context.state.retry_attempts.delete(issue_id);
  }
}

export async function completeRunRecord(
  context: RunCompletionCoordinatorContext,
  runningEntry: RunningEntry,
  terminal_status: TerminalStatus,
  error_code: string | null,
  recoveryOverride: MissingToolOutputRecoveryState | null = null,
  terminalReasonDetail: string | null = null,
  completionProjection?: CompletionProjection
): Promise<void> {
  if (!runningEntry.run_id || !context.persistence) {
    return;
  }

  runningEntry.history_terminalizing = true;
  await context.hooks.drainExecutionGraphPersistence(runningEntry);
  const rootCause = extractRootCauseDiagnostic(runningEntry, error_code);
  const persistedLineage = persistedCompletionLineage(runningEntry, rootCause.thread_id, rootCause.turn_id);
  if (!context.persistence.completeRunIncludesTerminalEvidence) {
    await persistTicketTerminalOutcome(
      context,
      runningEntry,
      terminal_status,
      error_code,
      terminalReasonDetail,
      rootCause,
      persistedLineage
    );
  }
  try {
    await context.persistence.completeRun({
      run_id: runningEntry.run_id,
      issue_run_id: runningEntry.issue_run_id,
      attempt_id: runningEntry.attempt_id,
      terminal_status,
      process_status: completionProjection?.process_status,
      workflow_outcome: completionProjection?.workflow_outcome,
      error_code,
      terminal_reason_code: error_code,
      terminal_reason_detail: terminalReasonDetail,
      root_cause_status: rootCause.status,
      root_cause_reason_code: rootCause.reason_code,
      root_cause_reason_detail: rootCause.reason_detail,
      root_cause_at: rootCause.at,
      session_id: rootCause.session_id ?? runningEntry.session_id,
      thread_id: persistedLineage.thread_id,
      turn_id: persistedLineage.turn_id,
      missing_tool_output_recovery: buildDurableMissingToolOutputRecoveryContext(runningEntry, recoveryOverride)
    });
  } catch (error) {
    await context.hooks.recordHistoryWriteFailure('completeRun', error_code ?? REASON_CODES.normalCompletion, error);
    context.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.persistence.completeRunFailed,
      message: `failed to complete durable run record for ${runningEntry.identifier}`,
      context: {
        issue_id: runningEntry.issue.id,
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id
      }
    });
  }

}

export async function persistTicketTerminalOutcome(
  context: RunCompletionCoordinatorContext,
  runningEntry: RunningEntry,
  terminalStatus: TerminalStatus,
  reasonCode: string | null,
  reasonDetail: string | null,
  rootCause: {
    at: string | null;
    thread_id: string | null;
    turn_id: string | null;
  },
  persistedLineage = persistedCompletionLineage(runningEntry, rootCause.thread_id, rootCause.turn_id)
): Promise<void> {
  if (!context.persistence?.appendTicketTerminalOutcome || !runningEntry.issue_run_id) {
    return;
  }

  try {
    await context.persistence.appendTicketTerminalOutcome({
      issue_run_id: runningEntry.issue_run_id,
      attempt_id: runningEntry.attempt_id ?? null,
      thread_id: persistedLineage.thread_id,
      turn_id: persistedLineage.turn_id,
      outcome: terminalStatus,
      reason_code: reasonCode,
      reason_detail: reasonDetail,
      recorded_at: rootCause.at ?? asIso(context.nowMs())
    });
  } catch (error) {
    await context.hooks.recordHistoryWriteFailure('appendTicketTerminalOutcome', reasonCode ?? REASON_CODES.normalCompletion, error);
    context.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.persistence.recordEventFailed,
      message: `failed to persist ticket terminal outcome for ${runningEntry.identifier}`,
      context: {
        issue_id: runningEntry.issue.id,
        issue_identifier: runningEntry.identifier,
        issue_run_id: runningEntry.issue_run_id,
        attempt_id: runningEntry.attempt_id ?? null,
        reason_code: reasonCode,
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

export function extractRootCauseDiagnostic(runningEntry: RunningEntry, terminalReasonCode: string | null): RootCauseDiagnostic {
  if (runningEntry.stalled_waiting_reason) {
    return {
      status: 'blocked',
      reason_code: runningEntry.stalled_waiting_reason,
      reason_detail: runningEntry.last_event_summary ?? runningEntry.last_message ?? null,
      at:
        typeof runningEntry.stalled_waiting_since_ms === 'number'
          ? new Date(runningEntry.stalled_waiting_since_ms).toISOString()
          : null,
      session_id: runningEntry.session_id,
      thread_id: runningEntry.thread_id ?? runningEntry.persisted_thread_id ?? null,
      turn_id: runningEntry.turn_id
    };
  }

  const outstandingToolCall = Object.values(runningEntry.outstanding_tool_calls ?? {}).sort(
    (left, right) => left.started_at_ms - right.started_at_ms
  )[0];
  if (outstandingToolCall && terminalReasonCode !== REASON_CODES.missingToolOutput) {
    return {
      status: 'blocked',
      reason_code: REASON_CODES.missingToolOutput,
      reason_detail: [
        `tool_name=${outstandingToolCall.tool_name}`,
        `call_id=${outstandingToolCall.call_id}`,
        `thread_id=${outstandingToolCall.thread_id ?? runningEntry.thread_id ?? 'unknown'}`,
        `turn_id=${outstandingToolCall.turn_id ?? runningEntry.turn_id ?? 'unknown'}`,
        `session_id=${outstandingToolCall.session_id ?? runningEntry.session_id ?? 'unknown'}`
      ].join(' '),
      at: new Date(outstandingToolCall.started_at_ms).toISOString(),
      session_id: outstandingToolCall.session_id ?? runningEntry.session_id,
      thread_id: outstandingToolCall.thread_id ?? runningEntry.thread_id ?? runningEntry.persisted_thread_id ?? null,
      turn_id: outstandingToolCall.turn_id ?? runningEntry.turn_id
    };
  }

  return {
    status: null,
    reason_code: null,
    reason_detail: null,
    at: null,
    session_id: null,
    thread_id: null,
    turn_id: null
  };
}
