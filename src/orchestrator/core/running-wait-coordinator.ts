import type { Issue } from '../../tracker';
import type { StructuredLogger } from '../../observability';
import { CANONICAL_EVENT } from '../../observability/events';
import { REASON_CODES } from '../../observability/reason-codes';
import { isActiveState } from '../decisions';
import type {
  MissingToolOutputRecoveryState,
  OrchestratorOptions,
  OrchestratorState,
  OutstandingToolCall,
  ProgressSignals,
  RunningEntry,
  WorkerObservabilityEvent
} from '../types';
import type { DispatchCoordinatorScheduleRetryParams } from './dispatch-coordinator';
import {
  workerTerminationResultContext,
  workerTerminationResultDetail
} from './blocked-input-recovery';
import {
  classifyWorkerActivity,
  rememberInactiveWorkerPid,
  rememberReleasedWorker,
  shouldResetRunningWaitEpisode,
  workerEventLooksLikeTrackerComment
} from './worker-events';
import {
  classifyProgressSignals,
  isFreshDispatchState,
  isKnownReviewHandoffTransition,
  normalizeStateName
} from './retry-backpressure';

const DEFAULT_INACTIVE_WORKER_PID_TTL_MS = 60 * 60 * 1000;

export interface RunningWaitCoordinatorHooks {
  scanCodexSessionTranscriptForToolCalls: (runningEntry: RunningEntry, observedAtMs: number) => void;
  findMissingToolOutputCandidate: (
    runningEntry: RunningEntry,
    observedAtMs: number,
    waitThresholdMs: number
  ) => OutstandingToolCall | null;
  recoverOrBlockMissingToolOutput: (
    issueId: string,
    runningEntry: RunningEntry,
    missingToolOutput: OutstandingToolCall,
    observedAtMs: number
  ) => Promise<void>;
  addRuntimeSecondsFromEntry: (runningEntry: RunningEntry) => void;
  completeRunRecord: (
    runningEntry: RunningEntry,
    terminalStatus: 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'cancelled',
    errorCode: string | null,
    recoveryOverride?: MissingToolOutputRecoveryState | null,
    terminalReasonDetail?: string | null
  ) => Promise<void>;
  persistExecutionGraphStateTransition: (
    runningEntry: RunningEntry,
    toStatus: string,
    status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying',
    reasonCode: string,
    reasonDetail: string | null
  ) => Promise<void>;
  scheduleRetry: (params: DispatchCoordinatorScheduleRetryParams) => Promise<void>;
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
  getLastPhaseMarker: (issueId: string) => { phase: string } | null;
  clearCircuitBreaker: (issueId: string) => Promise<void>;
  dispatchIssue: (issue: Issue, attempt: number | null) => Promise<void>;
}

export interface RunningWaitCoordinatorContext {
  readonly state: OrchestratorState;
  readonly config: OrchestratorOptions['config'];
  readonly tracker: Pick<OrchestratorOptions['ports']['tracker'], 'fetch_issue_states_by_ids'>;
  readonly terminateWorker: OrchestratorOptions['ports']['terminateWorker'];
  readonly logger: StructuredLogger | undefined;
  readonly nowMs: () => number;
  readonly hooks: RunningWaitCoordinatorHooks;
}

export async function coordinateReconcileStalledRuns(context: RunningWaitCoordinatorContext): Promise<void> {
  const now = context.nowMs();
  const waitThresholdMs = context.config.running_wait_stall_threshold_ms ?? 300_000;

  for (const [issueId, runningEntry] of Array.from(context.state.running.entries())) {
    const elapsedMs = now - (runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms);
    if (waitThresholdMs > 0) {
      coordinateMaybeEmitHeartbeatOnly(context, issueId, runningEntry, now);
      const handledAsBlocked = await coordinateMaybeClassifyRunningWaitStall(context, issueId, runningEntry, now);
      if (handledAsBlocked) {
        continue;
      }
    }
    if (runningEntry.last_event && shouldResetRunningWaitEpisode(runningEntry.last_event)) {
      runningEntry.running_waiting_started_at_ms = null;
      runningEntry.running_wait_stall_event_emitted = false;
      runningEntry.heartbeat_only_event_emitted = false;
      runningEntry.stalled_waiting_since_ms = null;
      runningEntry.stalled_waiting_reason = null;
    }
    if (context.config.stall_timeout_ms > 0 && elapsedMs > context.config.stall_timeout_ms) {
      const terminationResult = await context.terminateWorker({
        issue_id: issueId,
        worker_handle: runningEntry.worker_handle,
        cleanup_workspace: false,
        reason: 'stall_timeout'
      });

      context.hooks.addRuntimeSecondsFromEntry(runningEntry);
      context.state.running.delete(issueId);

      const stalledDetail = workerTerminationResultDetail('worker stalled', terminationResult);
      await context.hooks.completeRunRecord(runningEntry, 'stalled', REASON_CODES.workerStalled, null, stalledDetail);

      await context.hooks.scheduleRetry({
        issue_id: issueId,
        identifier: runningEntry.identifier,
        attempt: runningEntry.retry_attempt + 1,
        issue_run_id: runningEntry.issue_run_id ?? null,
        previous_attempt_id: runningEntry.attempt_id ?? null,
        delay_type: 'failure',
        error: 'worker stalled',
        worker_host: runningEntry.worker_host ?? null,
        workspace_path: runningEntry.workspace_path ?? null,
        provisioner_type: runningEntry.provisioner_type ?? null,
        branch_name: runningEntry.branch_name ?? null,
        repo_root: runningEntry.repo_root ?? null,
        workspace_exists: runningEntry.workspace_exists,
        workspace_git_status: runningEntry.workspace_git_status,
        workspace_provisioned: runningEntry.workspace_provisioned,
        workspace_is_git_worktree: runningEntry.workspace_is_git_worktree,
        copy_ignored_applied: runningEntry.copy_ignored_applied,
        copy_ignored_status: runningEntry.copy_ignored_status,
        copy_ignored_summary: runningEntry.copy_ignored_summary,
        stop_reason_code: REASON_CODES.workerStalled,
        stop_reason_detail: stalledDetail,
        previous_thread_id: runningEntry.thread_id,
        previous_turn_id: runningEntry.turn_id,
        previous_session_id: runningEntry.session_id,
        last_progress_checkpoint_at: runningEntry.last_progress_transition_at_ms ?? runningEntry.started_at_ms,
        issue_snapshot: runningEntry.issue,
        progress_signals: runningEntry.progress_signals,
        recover_workspace_attempt_residue: true
      });
      context.state.health.last_error = `worker stalled for ${runningEntry.identifier}`;
      context.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.orchestration.workerStalled,
        message: 'worker stalled; retrying',
        context: {
          issue_id: issueId,
          issue_identifier: runningEntry.identifier,
          session_id: runningEntry.session_id,
          elapsed_ms: elapsedMs,
          ...workerTerminationResultContext(terminationResult)
        }
      });
      context.hooks.recordRuntimeEvent({
        event: CANONICAL_EVENT.orchestration.workerStalled,
        severity: 'warn',
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id ?? undefined,
        detail: stalledDetail
      });
      continue;
    }

    const handledAsOpaqueTimeout = await coordinateMaybeTerminateOpaqueActivityHardTimeout(context, issueId, runningEntry, now);
    if (handledAsOpaqueTimeout) {
      continue;
    }
  }
}

export function coordinateResetRunningWaitEpisode(runningEntry: RunningEntry, progressAtMs: number): void {
  runningEntry.running_waiting_started_at_ms = null;
  runningEntry.running_wait_stall_event_emitted = false;
  runningEntry.heartbeat_only_event_emitted = false;
  runningEntry.stalled_waiting_since_ms = null;
  runningEntry.stalled_waiting_reason = null;
  runningEntry.last_progress_transition_at_ms = progressAtMs;
}

export function coordinateIsMeaningfulWorkerProgressEvent(workerEvent: WorkerObservabilityEvent): boolean {
  return (
    (workerEvent.event === CANONICAL_EVENT.agentRunner.activity && !workerEvent.process_liveness_only) ||
    workerEvent.event === CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch ||
    workerEvent.event === CANONICAL_EVENT.codex.approvalAutoApproved ||
    workerEvent.event === CANONICAL_EVENT.codex.toolInputAutoAnswered ||
    workerEvent.event === CANONICAL_EVENT.codex.sideOutput
  );
}

export function coordinateMaybeEmitHeartbeatOnly(
  context: RunningWaitCoordinatorContext,
  issueId: string,
  runningEntry: RunningEntry,
  observedAtMs: number
): void {
  const thresholdMs = context.config.progress_heartbeat_only_warn_ms ?? 120_000;
  if (thresholdMs <= 0 || (runningEntry.last_event !== CANONICAL_EVENT.codex.turnWaiting && runningEntry.running_waiting_started_at_ms == null)) {
    return;
  }
  const waitingStartedAtMs =
    runningEntry.running_waiting_started_at_ms ?? runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms;
  runningEntry.running_waiting_started_at_ms = waitingStartedAtMs;
  if (observedAtMs - waitingStartedAtMs < thresholdMs || runningEntry.heartbeat_only_event_emitted) {
    return;
  }
  runningEntry.heartbeat_only_event_emitted = true;
  context.hooks.recordRuntimeEvent({
    event: CANONICAL_EVENT.progress.heartbeatOnlyDetected,
    severity: 'warn',
    issue_identifier: runningEntry.identifier,
    session_id: runningEntry.session_id ?? undefined,
    detail: `issue_id=${issueId} thread_id=${runningEntry.thread_id ?? 'unknown'} session_id=${runningEntry.session_id ?? 'unknown'} elapsed_ms=${Math.max(0, observedAtMs - waitingStartedAtMs)}`
  });
}

export async function coordinateMaybeClassifyRunningWaitStall(
  context: RunningWaitCoordinatorContext,
  issueId: string,
  runningEntry: RunningEntry,
  observedAtMs: number
): Promise<boolean> {
  const waitThresholdMs = context.config.progress_stalled_waiting_ms ?? context.config.running_wait_stall_threshold_ms ?? 300_000;
  if (waitThresholdMs <= 0) {
    return false;
  }

  context.hooks.scanCodexSessionTranscriptForToolCalls(runningEntry, observedAtMs);

  const missingToolOutput = context.hooks.findMissingToolOutputCandidate(runningEntry, observedAtMs, waitThresholdMs);
  if (missingToolOutput) {
    runningEntry.stalled_waiting_reason = REASON_CODES.turnWaitingThresholdExceeded;
    await context.hooks.recoverOrBlockMissingToolOutput(issueId, runningEntry, missingToolOutput, observedAtMs);
    return true;
  }

  if (runningEntry.awaiting_input_since_ms !== null) {
    return false;
  }

  if (runningEntry.last_event !== CANONICAL_EVENT.codex.turnWaiting && runningEntry.running_waiting_started_at_ms == null) {
    return false;
  }

  const waitingStartedAtMs =
    runningEntry.running_waiting_started_at_ms ?? runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms;
  runningEntry.running_waiting_started_at_ms = waitingStartedAtMs;
  const activity = classifyWorkerActivity({
    runningEntry,
    observedAtMs,
    waitThresholdMs: context.config.progress_stalled_waiting_ms ?? context.config.running_wait_stall_threshold_ms ?? 300_000
  });
  const lastMeaningfulActivityAtMs =
    typeof activity.latest_meaningful_progress_at_ms === 'number' && activity.latest_meaningful_progress_at_ms > waitingStartedAtMs
      ? activity.latest_meaningful_progress_at_ms
      : waitingStartedAtMs;
  const thresholdCrossedAtMs = lastMeaningfulActivityAtMs + waitThresholdMs;
  runningEntry.stalled_waiting_since_ms = thresholdCrossedAtMs;

  if (observedAtMs < thresholdCrossedAtMs) {
    runningEntry.stalled_waiting_reason = null;
    return false;
  }

  const elapsedMs = Math.max(0, observedAtMs - waitingStartedAtMs);
  if (!runningEntry.running_wait_stall_event_emitted) {
    runningEntry.running_wait_stall_event_emitted = true;
    const progressEvent =
      activity.activity_state === 'active_but_opaque'
        ? CANONICAL_EVENT.progress.activeButOpaqueDetected
        : CANONICAL_EVENT.progress.stalledWaitingDetected;
    context.hooks.recordRuntimeEvent({
      event: progressEvent,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: [
        `issue_id=${issueId}`,
        `thread_id=${runningEntry.thread_id ?? 'unknown'}`,
        `session_id=${runningEntry.session_id ?? 'unknown'}`,
        `activity_state=${activity.activity_state}`,
        `elapsed_ms=${elapsedMs}`,
        `latest_liveness_at_ms=${activity.latest_liveness_at_ms ?? 'unknown'}`,
        `latest_thread_activity_at_ms=${activity.latest_thread_activity_at_ms ?? 'unknown'}`
      ].join(' ')
    });
    context.hooks.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.runningWaitStallThresholdExceeded,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: `issue_id=${issueId} thread_id=${runningEntry.thread_id ?? 'unknown'} session_id=${runningEntry.session_id ?? 'unknown'} elapsed_ms=${elapsedMs}`
    });
  }
  runningEntry.stalled_waiting_reason = null;
  return false;
}

export async function coordinateRecoverRunningWaitStall(
  context: RunningWaitCoordinatorContext,
  issueId: string,
  runningEntry: RunningEntry,
  observedAtMs: number,
  elapsedMs: number
): Promise<void> {
  if (context.state.running.get(issueId) !== runningEntry) {
    return;
  }

  const handoffProgress = await classifyTrackerHandoffProgress(context, issueId, runningEntry);
  if (handoffProgress?.kind === 'unknown') {
    await completeStalledTrackerRefreshUncertain(context, issueId, runningEntry, handoffProgress.error_detail, observedAtMs, elapsedMs);
    return;
  }
  if (handoffProgress?.kind === 'progress') {
    await completeStalledReviewHandoff(context, issueId, runningEntry, handoffProgress, observedAtMs, elapsedMs);
    return;
  }

  const detail = [
    'no meaningful progress while waiting for Codex turn completion',
    `reason_code=${REASON_CODES.turnWaitingThresholdExceeded}`,
    `thread_id=${runningEntry.thread_id ?? 'unknown'}`,
    `turn_id=${runningEntry.turn_id ?? 'unknown'}`,
    `session_id=${runningEntry.session_id ?? 'unknown'}`,
    `elapsed_wait_ms=${elapsedMs}`,
    `observed_at_ms=${observedAtMs}`
  ].join(' ');
  const terminationResult = await context.terminateWorker({
    issue_id: issueId,
    worker_handle: runningEntry.worker_handle,
    cleanup_workspace: false,
    reason: REASON_CODES.turnWaitingThresholdExceeded
  });
  const stalledDetail = workerTerminationResultDetail(detail, terminationResult);

  rememberInactiveWorkerPid({
    state: context.state,
    runningEntry,
    reason: REASON_CODES.turnWaitingThresholdExceeded,
    nowMs: context.nowMs(),
    ttlMs: context.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
  });
  context.hooks.addRuntimeSecondsFromEntry(runningEntry);
  await context.hooks.completeRunRecord(runningEntry, 'stalled', REASON_CODES.turnWaitingThresholdExceeded, null, stalledDetail);
  await context.hooks.persistExecutionGraphStateTransition(
    runningEntry,
    'failed',
    'failed',
    REASON_CODES.turnWaitingThresholdExceeded,
    stalledDetail
  );
  context.state.running.delete(issueId);

  await context.hooks.scheduleRetry({
    issue_id: issueId,
    identifier: runningEntry.identifier,
    attempt: runningEntry.retry_attempt + 1,
    issue_run_id: runningEntry.issue_run_id ?? null,
    previous_attempt_id: runningEntry.attempt_id ?? null,
    delay_type: 'failure',
    error: 'turn waiting threshold exceeded',
    worker_host: runningEntry.worker_host ?? null,
    workspace_path: runningEntry.workspace_path ?? null,
    provisioner_type: runningEntry.provisioner_type ?? null,
    branch_name: runningEntry.branch_name ?? null,
    repo_root: runningEntry.repo_root ?? null,
    workspace_exists: runningEntry.workspace_exists,
    workspace_git_status: runningEntry.workspace_git_status,
    workspace_provisioned: runningEntry.workspace_provisioned,
    workspace_is_git_worktree: runningEntry.workspace_is_git_worktree,
    copy_ignored_applied: runningEntry.copy_ignored_applied,
    copy_ignored_status: runningEntry.copy_ignored_status,
    copy_ignored_summary: runningEntry.copy_ignored_summary,
    stop_reason_code: REASON_CODES.turnWaitingThresholdExceeded,
    stop_reason_detail: stalledDetail,
    previous_thread_id: runningEntry.thread_id,
    previous_turn_id: runningEntry.turn_id,
    previous_session_id: runningEntry.session_id,
    last_progress_checkpoint_at: runningEntry.last_progress_transition_at_ms ?? runningEntry.started_at_ms,
    issue_snapshot: runningEntry.issue,
    progress_signals: runningEntry.progress_signals
  });
  context.state.health.last_error = `turn waiting threshold exceeded for ${runningEntry.identifier}`;
  context.logger?.log({
    level: 'warn',
    event: CANONICAL_EVENT.orchestration.workerStalled,
    message: 'turn waiting threshold exceeded; retrying',
    context: {
      issue_id: issueId,
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id,
      elapsed_ms: elapsedMs,
      stop_reason_code: REASON_CODES.turnWaitingThresholdExceeded,
      ...workerTerminationResultContext(terminationResult)
    }
  });
  context.hooks.recordRuntimeEvent({
    event: CANONICAL_EVENT.orchestration.workerStalled,
    severity: 'warn',
    issue_identifier: runningEntry.identifier,
    session_id: runningEntry.session_id ?? undefined,
    detail: stalledDetail
  });
}

export async function coordinateMaybeTerminateOpaqueActivityHardTimeout(
  context: RunningWaitCoordinatorContext,
  issueId: string,
  runningEntry: RunningEntry,
  observedAtMs: number
): Promise<boolean> {
  if (context.state.running.get(issueId) !== runningEntry || runningEntry.awaiting_input_since_ms !== null) {
    return false;
  }

  const hardTimeoutMs = context.config.worker_opaque_activity_hard_timeout_ms ?? 1_800_000;
  if (hardTimeoutMs <= 0) {
    return false;
  }

  context.hooks.scanCodexSessionTranscriptForToolCalls(runningEntry, observedAtMs);
  if (context.hooks.findMissingToolOutputCandidate(runningEntry, observedAtMs, context.config.progress_stalled_waiting_ms ?? 300_000)) {
    return false;
  }

  const activity = classifyWorkerActivity({
    runningEntry,
    observedAtMs,
    waitThresholdMs: context.config.progress_stalled_waiting_ms ?? context.config.running_wait_stall_threshold_ms ?? 300_000
  });
  if (activity.activity_state !== 'active_but_opaque' && activity.activity_state !== 'heartbeat_only') {
    return false;
  }
  const lastMeaningfulProgressAtMs = activity.latest_meaningful_progress_at_ms ?? runningEntry.started_at_ms;
  const opaqueElapsedMs = Math.max(0, observedAtMs - lastMeaningfulProgressAtMs);
  if (opaqueElapsedMs <= hardTimeoutMs) {
    return false;
  }

  const handoffProgress = await classifyTrackerHandoffProgress(context, issueId, runningEntry);
  if (handoffProgress?.kind === 'unknown') {
    await completeStalledTrackerRefreshUncertain(context, issueId, runningEntry, handoffProgress.error_detail, observedAtMs, opaqueElapsedMs);
    return true;
  }
  if (handoffProgress?.kind === 'progress') {
    await completeStalledReviewHandoff(context, issueId, runningEntry, handoffProgress, observedAtMs, opaqueElapsedMs);
    return true;
  }

  const detail = [
    'active but opaque hard timeout',
    `reason_code=${REASON_CODES.workerOpaqueActivityHardTimeout}`,
    `activity_state=${activity.activity_state}`,
    `thread_id=${runningEntry.thread_id ?? 'unknown'}`,
    `turn_id=${runningEntry.turn_id ?? 'unknown'}`,
    `session_id=${runningEntry.session_id ?? 'unknown'}`,
    `latest_meaningful_progress_at_ms=${activity.latest_meaningful_progress_at_ms ?? 'unknown'}`,
    `latest_liveness_at_ms=${activity.latest_liveness_at_ms ?? 'unknown'}`,
    `latest_thread_activity_at_ms=${activity.latest_thread_activity_at_ms ?? 'unknown'}`,
    `opaque_elapsed_ms=${opaqueElapsedMs}`,
    `observed_at_ms=${observedAtMs}`
  ].join(' ');
  const terminationResult = await context.terminateWorker({
    issue_id: issueId,
    worker_handle: runningEntry.worker_handle,
    cleanup_workspace: false,
    reason: REASON_CODES.workerOpaqueActivityHardTimeout
  });
  const stalledDetail = workerTerminationResultDetail(detail, terminationResult);

  rememberInactiveWorkerPid({
    state: context.state,
    runningEntry,
    reason: REASON_CODES.workerOpaqueActivityHardTimeout,
    nowMs: context.nowMs(),
    ttlMs: context.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
  });
  context.hooks.addRuntimeSecondsFromEntry(runningEntry);
  await context.hooks.completeRunRecord(runningEntry, 'stalled', REASON_CODES.workerOpaqueActivityHardTimeout, null, stalledDetail);
  await context.hooks.persistExecutionGraphStateTransition(
    runningEntry,
    'failed',
    'failed',
    REASON_CODES.workerOpaqueActivityHardTimeout,
    stalledDetail
  );
  context.state.running.delete(issueId);

  await context.hooks.scheduleRetry({
    issue_id: issueId,
    identifier: runningEntry.identifier,
    attempt: runningEntry.retry_attempt + 1,
    issue_run_id: runningEntry.issue_run_id ?? null,
    previous_attempt_id: runningEntry.attempt_id ?? null,
    delay_type: 'failure',
    error: 'active but opaque hard timeout',
    worker_host: runningEntry.worker_host ?? null,
    workspace_path: runningEntry.workspace_path ?? null,
    provisioner_type: runningEntry.provisioner_type ?? null,
    branch_name: runningEntry.branch_name ?? null,
    repo_root: runningEntry.repo_root ?? null,
    workspace_exists: runningEntry.workspace_exists,
    workspace_git_status: runningEntry.workspace_git_status,
    workspace_provisioned: runningEntry.workspace_provisioned,
    workspace_is_git_worktree: runningEntry.workspace_is_git_worktree,
    copy_ignored_applied: runningEntry.copy_ignored_applied,
    copy_ignored_status: runningEntry.copy_ignored_status,
    copy_ignored_summary: runningEntry.copy_ignored_summary,
    stop_reason_code: REASON_CODES.workerOpaqueActivityHardTimeout,
    stop_reason_detail: stalledDetail,
    previous_thread_id: runningEntry.thread_id,
    previous_turn_id: runningEntry.turn_id,
    previous_session_id: runningEntry.session_id,
    last_progress_checkpoint_at: activity.latest_meaningful_progress_at_ms ?? runningEntry.started_at_ms,
    issue_snapshot: runningEntry.issue,
    progress_signals: runningEntry.progress_signals,
    recover_workspace_attempt_residue: true
  });
  context.state.health.last_error = `active but opaque hard timeout for ${runningEntry.identifier}`;
  context.logger?.log({
    level: 'warn',
    event: CANONICAL_EVENT.orchestration.workerStalled,
    message: 'active but opaque hard timeout; retrying',
    context: {
      issue_id: issueId,
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id,
      elapsed_ms: opaqueElapsedMs,
      stop_reason_code: REASON_CODES.workerOpaqueActivityHardTimeout,
      ...workerTerminationResultContext(terminationResult)
    }
  });
  context.hooks.recordRuntimeEvent({
    event: CANONICAL_EVENT.orchestration.workerStalled,
    severity: 'warn',
    issue_identifier: runningEntry.identifier,
    session_id: runningEntry.session_id ?? undefined,
    detail: stalledDetail
  });
  return true;
}

async function completeStalledTrackerRefreshUncertain(
  context: RunningWaitCoordinatorContext,
  issueId: string,
  runningEntry: RunningEntry,
  errorDetail: string,
  observedAtMs: number,
  elapsedMs: number
): Promise<void> {
  const detail = [
    'tracker state refresh failed during stalled-wait recovery',
    `reason_code=${REASON_CODES.issueStateRefreshFailed}`,
    `refresh_error=${errorDetail}`,
    `thread_id=${runningEntry.thread_id ?? 'unknown'}`,
    `turn_id=${runningEntry.turn_id ?? 'unknown'}`,
    `session_id=${runningEntry.session_id ?? 'unknown'}`,
    `elapsed_wait_ms=${elapsedMs}`,
    `observed_at_ms=${observedAtMs}`
  ].join(' ');
  const terminationResult = await context.terminateWorker({
    issue_id: issueId,
    worker_handle: runningEntry.worker_handle,
    cleanup_workspace: false,
    reason: REASON_CODES.turnWaitingThresholdExceeded
  });
  const stalledDetail = workerTerminationResultDetail(detail, terminationResult);

  rememberInactiveWorkerPid({
    state: context.state,
    runningEntry,
    reason: REASON_CODES.issueStateRefreshFailed,
    nowMs: context.nowMs(),
    ttlMs: context.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
  });
  context.hooks.addRuntimeSecondsFromEntry(runningEntry);
  await context.hooks.completeRunRecord(runningEntry, 'stalled', REASON_CODES.issueStateRefreshFailed, null, stalledDetail);
  await context.hooks.persistExecutionGraphStateTransition(
    runningEntry,
    'failed',
    'failed',
    REASON_CODES.issueStateRefreshFailed,
    stalledDetail
  );
  context.state.running.delete(issueId);

  await context.hooks.scheduleRetry({
    issue_id: issueId,
    identifier: runningEntry.identifier,
    attempt: runningEntry.retry_attempt + 1,
    issue_run_id: runningEntry.issue_run_id ?? null,
    previous_attempt_id: runningEntry.attempt_id ?? null,
    delay_type: 'failure',
    error: 'tracker state refresh failed during stalled-wait recovery',
    worker_host: runningEntry.worker_host ?? null,
    workspace_path: runningEntry.workspace_path ?? null,
    provisioner_type: runningEntry.provisioner_type ?? null,
    branch_name: runningEntry.branch_name ?? null,
    repo_root: runningEntry.repo_root ?? null,
    workspace_exists: runningEntry.workspace_exists,
    workspace_git_status: runningEntry.workspace_git_status,
    workspace_provisioned: runningEntry.workspace_provisioned,
    workspace_is_git_worktree: runningEntry.workspace_is_git_worktree,
    copy_ignored_applied: runningEntry.copy_ignored_applied,
    copy_ignored_status: runningEntry.copy_ignored_status,
    copy_ignored_summary: runningEntry.copy_ignored_summary,
    stop_reason_code: REASON_CODES.issueStateRefreshFailed,
    stop_reason_detail: stalledDetail,
    previous_thread_id: runningEntry.thread_id,
    previous_turn_id: runningEntry.turn_id,
    previous_session_id: runningEntry.session_id,
    issue_snapshot: runningEntry.issue,
    progress_signals: runningEntry.progress_signals
  });
  context.state.health.last_error = `tracker state refresh failed during stalled-wait recovery for ${runningEntry.identifier}`;
  context.logger?.log({
    level: 'warn',
    event: CANONICAL_EVENT.tracker.stateRefreshFailed,
    message: 'tracker refresh uncertainty scheduled bounded retry',
    context: {
      issue_id: issueId,
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id,
      elapsed_ms: elapsedMs,
      stop_reason_code: REASON_CODES.issueStateRefreshFailed,
      error: errorDetail,
      ...workerTerminationResultContext(terminationResult)
    }
  });
  context.hooks.recordRuntimeEvent({
    event: CANONICAL_EVENT.tracker.stateRefreshFailed,
    severity: 'warn',
    issue_identifier: runningEntry.identifier,
    session_id: runningEntry.session_id ?? undefined,
    detail: stalledDetail
  });
}

async function classifyTrackerHandoffProgress(
  context: RunningWaitCoordinatorContext,
  issueId: string,
  runningEntry: RunningEntry
): Promise<
  | { kind: 'progress'; issue: Issue; signals: ProgressSignals; reasons: string[] }
  | { kind: 'unknown'; error_detail: string }
  | null
> {
  let refreshed: Issue[];
  try {
    refreshed = await context.tracker.fetch_issue_states_by_ids([issueId]);
  } catch (error) {
    const errorDetail = error instanceof Error ? error.message : String(error);
    context.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.tracker.stateRefreshFailed,
      message: 'failed to refresh tracker state before stalled-wait recovery',
      context: {
        issue_id: issueId,
        issue_identifier: runningEntry.identifier,
        error: errorDetail
      }
    });
    return { kind: 'unknown', error_detail: errorDetail };
  }

  const issue = refreshed.find((candidate) => candidate.id === issueId);
  if (!issue) {
    return null;
  }

  const startedState = runningEntry.started_issue_state ?? runningEntry.issue.state;
  if (normalizeStateName(startedState) !== normalizeStateName('Agent Review')) {
    return null;
  }
  if (normalizeStateName(issue.state) === normalizeStateName(startedState)) {
    return null;
  }

  if (!isKnownReviewHandoffTransition({ startedState, currentState: issue.state, config: context.config })) {
    return null;
  }

  const signals: ProgressSignals = {
    commit_sha: null,
    checklist_checkpoint: null,
    state_marker: context.hooks.getLastPhaseMarker(issueId)?.phase ?? null,
    tracker_comment_created: hasWorkerTrackerCommentSignal(runningEntry),
    tracker_status_transition: `${startedState} -> ${issue.state}`,
    agent_review_handoff: issue.state,
    tracker_started_state: startedState
  };
  const reasons = classifyProgressSignals(signals);
  if (!reasons.includes('agent_review_handoff')) {
    return null;
  }
  return { kind: 'progress', issue, signals, reasons };
}

function hasWorkerTrackerCommentSignal(runningEntry: RunningEntry): boolean {
  if (runningEntry.progress_signals?.tracker_comment_created) {
    return true;
  }
  return runningEntry.recent_events.some((event) => {
    return workerEventLooksLikeTrackerComment(event);
  });
}

export function coordinateCaptureWorkerProgressSignal(
  context: RunningWaitCoordinatorContext,
  runningEntry: RunningEntry,
  workerEvent: WorkerObservabilityEvent
): void {
  if (!workerEventLooksLikeTrackerComment(workerEvent)) {
    return;
  }

  runningEntry.progress_signals = {
    commit_sha: runningEntry.progress_signals?.commit_sha ?? null,
    checklist_checkpoint: runningEntry.progress_signals?.checklist_checkpoint ?? null,
    state_marker: runningEntry.progress_signals?.state_marker ?? context.hooks.getLastPhaseMarker(runningEntry.issue.id)?.phase ?? null,
    tracker_comment_created: true,
    tracker_status_transition: runningEntry.progress_signals?.tracker_status_transition ?? null,
    agent_review_handoff: runningEntry.progress_signals?.agent_review_handoff ?? null,
    tracker_started_state:
      runningEntry.progress_signals?.tracker_started_state ?? runningEntry.started_issue_state ?? runningEntry.issue.state
  };
}

async function completeStalledReviewHandoff(
  context: RunningWaitCoordinatorContext,
  issueId: string,
  runningEntry: RunningEntry,
  handoffProgress: { issue: Issue; signals: ProgressSignals; reasons: string[] },
  observedAtMs: number,
  elapsedMs: number
): Promise<void> {
  const detail = [
    'Agent Review handoff progress observed before stalled-wait cleanup',
    `reason_code=${REASON_CODES.agentReviewHandoffProgressObserved}`,
    `tracker_status_transition=${handoffProgress.signals.tracker_status_transition ?? 'unknown'}`,
    `thread_id=${runningEntry.thread_id ?? 'unknown'}`,
    `turn_id=${runningEntry.turn_id ?? 'unknown'}`,
    `session_id=${runningEntry.session_id ?? 'unknown'}`,
    `elapsed_wait_ms=${elapsedMs}`,
    `observed_at_ms=${observedAtMs}`
  ].join(' ');
  const terminationResult = await context.terminateWorker({
    issue_id: issueId,
    worker_handle: runningEntry.worker_handle,
    cleanup_workspace: false,
    reason: REASON_CODES.turnWaitingThresholdExceeded
  });
  const terminalDetail = workerTerminationResultDetail(detail, terminationResult);

  rememberInactiveWorkerPid({
    state: context.state,
    runningEntry,
    reason: REASON_CODES.turnWaitingThresholdExceeded,
    nowMs: context.nowMs(),
    ttlMs: context.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
  });
  context.hooks.addRuntimeSecondsFromEntry(runningEntry);
  await context.hooks.completeRunRecord(
    runningEntry,
    'succeeded',
    REASON_CODES.agentReviewHandoffProgressObserved,
    null,
    terminalDetail
  );
  await context.hooks.persistExecutionGraphStateTransition(
    runningEntry,
    'succeeded',
    'succeeded',
    REASON_CODES.agentReviewHandoffProgressObserved,
    terminalDetail
  );
  rememberReleasedWorker({
    state: context.state,
    runningEntry,
    reason: REASON_CODES.agentReviewHandoffProgressObserved,
    cleanupWorkspace: false,
    nowMs: context.nowMs()
  });
  context.state.running.delete(issueId);
  context.state.retry_attempts.delete(issueId);
  context.state.blocked_inputs.delete(issueId);
  context.state.claimed.delete(issueId);
  context.state.redispatch_progress?.delete(issueId);
  await context.hooks.clearCircuitBreaker(issueId);

  context.hooks.recordRuntimeEvent({
    event: CANONICAL_EVENT.orchestration.agentReviewHandoffProgressObserved,
    severity: 'info',
    issue_identifier: runningEntry.identifier,
    session_id: runningEntry.session_id ?? undefined,
    detail
  });
  context.logger?.log({
    level: 'info',
    event: CANONICAL_EVENT.orchestration.agentReviewHandoffProgressObserved,
    message: 'Agent Review handoff progress observed during stalled-wait recovery',
    context: {
      issue_id: issueId,
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id,
      progress_signal_reasons: handoffProgress.reasons.join(','),
      progress_signals: JSON.stringify(handoffProgress.signals),
      ...workerTerminationResultContext(terminationResult)
    }
  });

  if (isActiveState(handoffProgress.issue.state, context.config) && isFreshDispatchState(handoffProgress.issue.state, context.config)) {
    context.hooks.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.freshDispatchAfterReviewHandoff,
      severity: 'info',
      issue_identifier: runningEntry.identifier,
      detail: `tracker_state=${handoffProgress.issue.state}`
    });
    context.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.freshDispatchAfterReviewHandoff,
      message: 'fresh dispatch after Agent Review handoff',
      context: {
        issue_id: issueId,
        issue_identifier: runningEntry.identifier,
        tracker_state: handoffProgress.issue.state
      }
    });
    await context.hooks.dispatchIssue(handoffProgress.issue, null);
  } else {
    context.state.completed.add(issueId);
  }
}

export function coordinateMarkRunningWaitStallRootCauseIfThresholdExceeded(
  context: RunningWaitCoordinatorContext,
  runningEntry: RunningEntry,
  observedAtMs: number
): void {
  const waitThresholdMs = context.config.progress_stalled_waiting_ms ?? context.config.running_wait_stall_threshold_ms ?? 300_000;
  if (waitThresholdMs <= 0 || runningEntry.awaiting_input_since_ms !== null) {
    return;
  }
  if (runningEntry.last_event !== CANONICAL_EVENT.codex.turnWaiting && runningEntry.running_waiting_started_at_ms == null) {
    return;
  }

  const waitingStartedAtMs =
    runningEntry.running_waiting_started_at_ms ?? runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms;
  const lastMeaningfulActivityAtMs =
    typeof runningEntry.last_progress_transition_at_ms === 'number' &&
    runningEntry.last_progress_transition_at_ms > waitingStartedAtMs
      ? runningEntry.last_progress_transition_at_ms
      : waitingStartedAtMs;
  const thresholdCrossedAtMs = lastMeaningfulActivityAtMs + waitThresholdMs;
  runningEntry.stalled_waiting_since_ms = thresholdCrossedAtMs;
  if (observedAtMs >= thresholdCrossedAtMs) {
    runningEntry.stalled_waiting_reason = REASON_CODES.turnWaitingThresholdExceeded;
  }
}
