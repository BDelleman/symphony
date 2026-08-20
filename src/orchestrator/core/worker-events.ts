import { CANONICAL_EVENT } from '../../observability/events';
import { REASON_CODES } from '../../observability/reason-codes';
import type { StructuredLogger } from '../../observability';
import type {
  BlockedEntry,
  OrchestratorState,
  QuarantinedWorkerEventReason,
  ReleasedWorkerRecord,
  RunningEntry,
  WorkerExitDetails,
  WorkerExitReason,
  WorkerObservabilityEvent
} from '../types';

export type WorkerActivityState = 'advancing' | 'active_but_opaque' | 'heartbeat_only' | 'stale';

export interface WorkerActivityClassification {
  latest_meaningful_progress_at_ms: number | null;
  latest_liveness_at_ms: number | null;
  latest_thread_activity_at_ms: number | null;
  activity_state: WorkerActivityState;
}

type InactiveWorkerPidEntry = {
  pid: string;
  runtime_pid?: string | null;
  worker_instance_id?: string | null;
  recorded_at_ms: number;
  reason: string;
  thread_id: string | null;
  turn_id: string | null;
  session_id: string | null;
};

export interface WorkerEventLineageState {
  inactive_worker_pids?: Map<string, InactiveWorkerPidEntry[]>;
  released_workers?: Map<string, ReleasedWorkerRecord[]>;
}

export interface WorkerEventWorkflowContext {
  state: OrchestratorState;
  issueId: string;
  workerEvent: WorkerObservabilityEvent;
  inactiveWorkerPidTtlMs: number;
  runningWaitThresholdMs: number;
  nowMs: () => number;
  logger?: StructuredLogger;
  notifyObservers: () => void;
  quarantineBlockedWorkerEvent: (
    blockedEntry: BlockedEntry,
    workerEvent: WorkerObservabilityEvent,
    reason: 'awaiting_operator_latch' | 'lineage_mismatch'
  ) => void;
  captureWorkerProgressSignal: (runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent) => void;
  maybeEmitHeartbeatOnly: (issueId: string, runningEntry: RunningEntry, observedAtMs: number) => void;
  resetRunningWaitEpisode: (runningEntry: RunningEntry, progressAtMs: number) => void;
  isMeaningfulWorkerProgressEvent: (workerEvent: WorkerObservabilityEvent) => boolean;
  observeThroughput: (sample: { at_ms: number; tokens: number }) => void;
  updateOutstandingToolCalls: (runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent) => void;
  updateBudgetProjection: (issueId: string, runningEntry: RunningEntry, totalTokens: number) => void;
  maybeEmitTokenTelemetryWarning: (runningEntry: RunningEntry, eventAtMs: number) => void;
  maybeEmitBudgetTelemetryUnavailable: (runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent) => void;
  maybeEnforceBudget: (issueId: string, runningEntry: RunningEntry, timestampMs: number) => void;
  persistSession?: (params: { run_id: string; session_id: string }) => Promise<unknown>;
  persistRunEvent?: (params: {
    run_id: string;
    timestamp_ms: number;
    event: string;
    message: string | null;
    reason_code: string | null;
    request_method: string | null;
    request_category: string | null;
  }) => Promise<unknown>;
  beginExecutionGraphWorkerTurnObservation: (
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent
  ) => boolean;
  queuePersistExecutionGraphWorkerEvent: (
    issueId: string,
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent,
    turnAlreadyObserved: boolean
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
    protocol_warning?: WorkerObservabilityEvent['protocol_warning'];
    model_reroute?: WorkerObservabilityEvent['model_reroute'];
    requested_model?: string | null;
    effective_model?: string | null;
  }) => void;
  emitExplicitPhaseMarker: (issueId: string, workerEvent: WorkerObservabilityEvent) => boolean;
  emitMappedPhaseMarker: (issueId: string, workerEvent: WorkerObservabilityEvent) => void;
  hasOutstandingToolCallEvidence: (runningEntry: RunningEntry) => boolean;
  maybeClassifyRunningWaitStall: (issueId: string, runningEntry: RunningEntry, observedAtMs: number) => Promise<unknown>;
}

export function humanizeWorkerEvent(event: WorkerObservabilityEvent): string {
  const base = event.event.replace(/[._/]+/g, ' ').trim();
  if (event.detail && event.detail.trim().length > 0) {
    return `${base}: ${event.detail.trim()}`;
  }

  return base;
}

export function normalizeCodexAppServerPid(pid: number | string | null | undefined): string | null {
  return pid === undefined || pid === null ? null : String(pid);
}

export function normalizeWorkerProcessPid(pid: number | string | null | undefined): string | null {
  return pid === undefined || pid === null ? null : String(pid);
}

export function normalizeWorkerInstanceId(workerInstanceId: string | null | undefined): string | null {
  const trimmed = workerInstanceId?.trim();
  return trimmed ? trimmed : null;
}

export function severityForRuntimeEvent(eventName: string): 'info' | 'warn' | 'error' {
  if (eventName.includes('failed') || eventName.includes('error')) {
    return 'error';
  }
  if (eventName.includes('retry') || eventName.includes('validation') || eventName.includes('unsupported')) {
    return 'warn';
  }
  return 'info';
}

export function isTerminalTurnEvent(event: string): boolean {
  return (
    event === CANONICAL_EVENT.codex.turnCompleted ||
    event === CANONICAL_EVENT.codex.turnFailed ||
    event === CANONICAL_EVENT.codex.turnCancelled ||
    event === CANONICAL_EVENT.agentRunner.turnCompleted ||
    event === CANONICAL_EVENT.agentRunner.turnFailed ||
    event === CANONICAL_EVENT.agentRunner.turnCancelled ||
    event === CANONICAL_EVENT.agentRunner.turnTimedOut
  );
}

export function shouldResetRunningWaitEpisode(event: string): boolean {
  return (
    isTerminalTurnEvent(event) ||
    event === CANONICAL_EVENT.codex.turnStarted ||
    event === CANONICAL_EVENT.agentRunner.turnStarted ||
    event === CANONICAL_EVENT.codex.promptSent ||
    event === CANONICAL_EVENT.codex.turnInputRequired ||
    event === CANONICAL_EVENT.codex.startupFailed ||
    event === CANONICAL_EVENT.codex.phaseImplementation ||
    event === CANONICAL_EVENT.codex.phaseValidation ||
    event === CANONICAL_EVENT.codex.toolCallStarted ||
    event === CANONICAL_EVENT.codex.toolCallCompleted ||
    event === CANONICAL_EVENT.codex.toolCallFailed
  );
}

export function staleWorkerEventReasonForRunningEntry(params: {
  runningEntry: RunningEntry;
  workerEvent: WorkerObservabilityEvent;
  inactiveWorkerEntries: InactiveWorkerPidEntry[];
}): QuarantinedWorkerEventReason | null {
  const { runningEntry, workerEvent, inactiveWorkerEntries } = params;
  const eventPid = normalizeCodexAppServerPid(workerEvent.codex_app_server_pid);
  const eventRuntimePid = normalizeWorkerProcessPid(workerEvent.worker_process_pid);
  const eventWorkerInstanceId = normalizeWorkerInstanceId(workerEvent.worker_instance_id);
  if (
    eventWorkerInstanceId &&
    runningEntry.worker_instance_id &&
    eventWorkerInstanceId !== runningEntry.worker_instance_id
  ) {
    return 'worker_identity_mismatch';
  }

  if (eventPid && isInactiveWorkerPid(inactiveWorkerEntries, eventPid, eventWorkerInstanceId)) {
    return 'inactive_worker_pid';
  }

  if (
    eventRuntimePid &&
    isInactiveWorkerRuntimePid(inactiveWorkerEntries, eventRuntimePid, eventWorkerInstanceId)
  ) {
    return 'inactive_worker_pid';
  }

  if (isCodexContinuationSessionStart(runningEntry, workerEvent)) {
    return null;
  }

  if (eventPid && runningEntry.codex_app_server_pid && eventPid !== runningEntry.codex_app_server_pid) {
    return 'worker_identity_mismatch';
  }

  if (runningEntry.thread_id && workerEvent.thread_id && workerEvent.thread_id !== runningEntry.thread_id) {
    return 'lineage_mismatch';
  }

  if (isSameThreadContinuationTurnStart(runningEntry, workerEvent)) {
    return null;
  }

  if (isSameThreadContinuationProcessStart(runningEntry, workerEvent)) {
    return null;
  }

  if (isSameThreadRecoveryTurnStart(runningEntry, workerEvent)) {
    return null;
  }

  if (
    eventRuntimePid &&
    runningEntry.worker_process_pid &&
    eventRuntimePid !== runningEntry.worker_process_pid
  ) {
    return 'worker_identity_mismatch';
  }

  if (!eventPid && isInactiveWorkerLineage(inactiveWorkerEntries, workerEvent)) {
    return 'lineage_mismatch';
  }

  if (isPreviousRecoveryTurnEvent(runningEntry, workerEvent)) {
    return 'lineage_mismatch';
  }

  if (isTerminalTurnResidue(runningEntry, workerEvent)) {
    return 'terminal_residue';
  }

  if (runningEntry.turn_id && workerEvent.turn_id && workerEvent.turn_id !== runningEntry.turn_id) {
    return 'lineage_mismatch';
  }

  return runningEntry.session_id && workerEvent.session_id && workerEvent.session_id !== runningEntry.session_id
    ? 'lineage_mismatch'
    : null;
}

export function captureMissingToolOutputRecoveryReplacementLineage(
  runningEntry: RunningEntry,
  workerEvent: WorkerObservabilityEvent
): void {
  const recovery = runningEntry.recovery ?? null;
  if (!recovery || recovery.last_result !== 'started' || workerEvent.event !== CANONICAL_EVENT.codex.turnStarted) {
    return;
  }

  const replacementTurnId = workerEvent.turn_id ?? runningEntry.turn_id ?? null;
  if (!replacementTurnId || replacementTurnId === recovery.previous_turn_id) {
    return;
  }

  const replacementThreadId = workerEvent.thread_id ?? runningEntry.thread_id ?? recovery.previous_thread_id ?? null;
  if (recovery.previous_thread_id && replacementThreadId && replacementThreadId !== recovery.previous_thread_id) {
    return;
  }

  runningEntry.recovery = {
    ...recovery,
    replacement_thread_id: replacementThreadId,
    replacement_turn_id: replacementTurnId,
    replacement_session_id: workerEvent.session_id ?? runningEntry.session_id ?? null
  };
}

export function pruneInactiveWorkerPidsForIssue(params: {
  state: WorkerEventLineageState;
  issueId: string;
  nowMs: number;
  ttlMs: number;
}): InactiveWorkerPidEntry[] {
  const { state, issueId, nowMs, ttlMs } = params;
  const entries = state.inactive_worker_pids?.get(issueId) ?? [];
  if (entries.length === 0) {
    return [];
  }

  const activeEntries = entries.filter(
    (entry) => Number.isFinite(entry.recorded_at_ms) && nowMs - entry.recorded_at_ms < Math.max(0, ttlMs)
  );
  if (activeEntries.length === entries.length) {
    return entries;
  }

  if (!state.inactive_worker_pids) {
    state.inactive_worker_pids = new Map();
  }
  if (activeEntries.length > 0) {
    state.inactive_worker_pids.set(issueId, activeEntries);
  } else {
    state.inactive_worker_pids.delete(issueId);
  }
  return activeEntries;
}

export function rememberInactiveWorkerPid(params: {
  state: WorkerEventLineageState;
  runningEntry: RunningEntry;
  reason: string;
  nowMs: number;
  ttlMs: number;
}): void {
  const { state, runningEntry, reason, nowMs, ttlMs } = params;
  const pid = runningEntry.codex_app_server_pid;
  const runtimePid = runningEntry.worker_process_pid ?? null;
  if (!pid && !runtimePid && !runningEntry.thread_id && !runningEntry.turn_id && !runningEntry.session_id) {
    return;
  }
  const issueId = runningEntry.issue.id;
  const existing = pruneInactiveWorkerPidsForIssue({ state, issueId, nowMs, ttlMs });
  const next = [
    ...existing.filter(
      (entry) =>
        !(
          entry.pid === (pid ?? '') &&
          (entry.runtime_pid ?? null) === runtimePid &&
          entry.turn_id === (runningEntry.turn_id ?? null)
        )
    ),
    {
      pid: pid ?? '',
      runtime_pid: runtimePid,
      worker_instance_id: runningEntry.worker_instance_id ?? null,
      recorded_at_ms: nowMs,
      reason,
      thread_id: runningEntry.thread_id ?? null,
      turn_id: runningEntry.turn_id ?? null,
      session_id: runningEntry.session_id ?? null
    }
  ].slice(-20);
  if (!state.inactive_worker_pids) {
    state.inactive_worker_pids = new Map();
  }
  state.inactive_worker_pids.set(issueId, next);
}

export function rememberInactiveWorkerLineage(params: {
  state: WorkerEventLineageState;
  issueId: string;
  reason: string;
  nowMs: number;
  ttlMs: number;
  thread_id?: string | null;
  turn_id?: string | null;
  session_id?: string | null;
}): void {
  const { state, issueId, reason, nowMs, ttlMs } = params;
  const threadId = params.thread_id ?? null;
  const turnId = params.turn_id ?? null;
  const sessionId = params.session_id ?? null;
  if (!threadId && !turnId && !sessionId) {
    return;
  }

  const existing = pruneInactiveWorkerPidsForIssue({ state, issueId, nowMs, ttlMs });
  const next = [
    ...existing.filter(
      (entry) => !(entry.pid === '' && entry.thread_id === threadId && entry.turn_id === turnId && entry.session_id === sessionId)
    ),
    {
      pid: '',
      runtime_pid: null,
      worker_instance_id: null,
      recorded_at_ms: nowMs,
      reason,
      thread_id: threadId,
      turn_id: turnId,
      session_id: sessionId
    }
  ].slice(-20);
  if (!state.inactive_worker_pids) {
    state.inactive_worker_pids = new Map();
  }
  state.inactive_worker_pids.set(issueId, next);
}

export function rememberReleasedWorker(params: {
  state: WorkerEventLineageState;
  runningEntry: RunningEntry;
  reason: string;
  cleanupWorkspace: boolean;
  nowMs: number;
}): void {
  const { state, runningEntry, reason, cleanupWorkspace, nowMs } = params;
  const issueId = runningEntry.issue.id;
  const existing = state.released_workers?.get(issueId) ?? [];
  const next = [
    ...existing,
    {
      released_at_ms: nowMs,
      reason,
      cleanup_workspace: cleanupWorkspace,
      worker_instance_id: runningEntry.worker_instance_id ?? null,
      codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
      worker_process_pid: runningEntry.worker_process_pid ?? null,
      thread_id: runningEntry.thread_id ?? null,
      turn_id: runningEntry.turn_id ?? null,
      session_id: runningEntry.session_id ?? null
    }
  ].slice(-20);
  if (!state.released_workers) {
    state.released_workers = new Map();
  }
  state.released_workers.set(issueId, next);
}

export function findReleasedWorkerRecord(
  releasedWorkers: Map<string, ReleasedWorkerRecord[]> | undefined,
  issueId: string,
  details: WorkerExitDetails
): ReleasedWorkerRecord | null {
  const released = releasedWorkers?.get(issueId) ?? [];
  if (released.length === 0) {
    return null;
  }
  const workerInstanceId = normalizeWorkerInstanceId(details.worker_instance_id);
  const pid = normalizeCodexAppServerPid(details.codex_app_server_pid);
  const runtimePid = normalizeWorkerProcessPid(details.worker_process_pid);
  return (
    released.find((entry) => {
      if (workerInstanceId && entry.worker_instance_id === workerInstanceId) {
        return true;
      }
      if (pid && entry.codex_app_server_pid === pid) {
        return true;
      }
      if (runtimePid && entry.worker_process_pid === runtimePid) {
        return true;
      }
      if (details.turn_id && entry.turn_id === details.turn_id) {
        return true;
      }
      if (details.session_id && entry.session_id === details.session_id) {
        return true;
      }
      return false;
    }) ?? null
  );
}

export function applyWorkerEvent(context: WorkerEventWorkflowContext): void {
  const { state, issueId, workerEvent } = context;
  const runningEntry = state.running.get(issueId);
  if (!runningEntry) {
    const blockedEntry = state.blocked_inputs.get(issueId);
    if (blockedEntry?.awaiting_operator) {
      context.quarantineBlockedWorkerEvent(blockedEntry, workerEvent, 'awaiting_operator_latch');
    }
    return;
  }

  const staleReason = staleWorkerEventReasonForRunningEntry({
    runningEntry,
    workerEvent,
    inactiveWorkerEntries: pruneInactiveWorkerPidsForIssue({
      state,
      issueId,
      nowMs: context.nowMs(),
      ttlMs: context.inactiveWorkerPidTtlMs
    })
  });
  if (staleReason) {
    recordStaleRunningWorkerEvent(context, runningEntry, staleReason);
    return;
  }

  if (isCodexContinuationSessionStart(runningEntry, workerEvent)) {
    runningEntry.thread_id = workerEvent.thread_id ?? null;
    runningEntry.turn_id = null;
    runningEntry.session_id = null;
  }

  if (workerEvent.process_liveness_only) {
    runningEntry.last_process_liveness_at_ms = workerEvent.timestamp_ms;
  } else {
    runningEntry.last_codex_timestamp_ms = workerEvent.timestamp_ms;
  }
  if (workerEvent.agent_runtime) {
    runningEntry.agent_runtime = workerEvent.agent_runtime;
  }
  if (workerEvent.worker_process_pid !== undefined && workerEvent.worker_process_pid !== null) {
    runningEntry.worker_process_pid = String(workerEvent.worker_process_pid);
  }
  runningEntry.last_event = workerEvent.event;
  runningEntry.last_event_summary = humanizeWorkerEvent(workerEvent);
  runningEntry.last_message = workerEvent.detail ?? null;
  context.captureWorkerProgressSignal(runningEntry, workerEvent);
  if (
    workerEvent.codex_thread_activity_at_ms !== undefined &&
    workerEvent.codex_thread_activity_at_ms !== null &&
    (!workerEvent.thread_id || !runningEntry.thread_id || workerEvent.thread_id === runningEntry.thread_id)
  ) {
    runningEntry.codex_thread_activity_at_ms = workerEvent.codex_thread_activity_at_ms;
    runningEntry.codex_thread_activity_source = workerEvent.codex_thread_activity_source ?? 'app_server_protocol_thread_updated_at';
    runningEntry.codex_thread_activity_status = workerEvent.codex_thread_activity_status ?? null;
  }
  if (workerEvent.event === CANONICAL_EVENT.codex.turnInputRequired) {
    runningEntry.awaiting_input_since_ms = workerEvent.timestamp_ms;
    runningEntry.pending_input_preview = {
      type: REASON_CODES.turnInputRequired,
      prompt_preview: workerEvent.detail ?? null,
      option_count: null
    };
  }
  if (workerEvent.event === CANONICAL_EVENT.codex.turnWaiting) {
    runningEntry.last_heartbeat_at_ms = workerEvent.timestamp_ms;
    if (runningEntry.running_waiting_started_at_ms === undefined || runningEntry.running_waiting_started_at_ms === null) {
      runningEntry.running_waiting_started_at_ms = workerEvent.timestamp_ms;
      runningEntry.running_wait_stall_event_emitted = false;
      runningEntry.heartbeat_only_event_emitted = false;
    }
    if (
      (runningEntry.stalled_waiting_since_ms === undefined || runningEntry.stalled_waiting_since_ms === null) &&
      context.runningWaitThresholdMs > 0
    ) {
      runningEntry.stalled_waiting_since_ms = runningEntry.running_waiting_started_at_ms + context.runningWaitThresholdMs;
    }
    runningEntry.stalled_waiting_reason = null;
    context.maybeEmitHeartbeatOnly(issueId, runningEntry, workerEvent.timestamp_ms);
  } else if (shouldResetRunningWaitEpisode(workerEvent.event)) {
    context.resetRunningWaitEpisode(runningEntry, workerEvent.timestamp_ms);
  } else if (context.isMeaningfulWorkerProgressEvent(workerEvent)) {
    runningEntry.last_progress_transition_at_ms = workerEvent.timestamp_ms;
  }

  if (workerEvent.thread_id && !runningEntry.thread_id) {
    runningEntry.thread_id = workerEvent.thread_id;
  }
  if (workerEvent.turn_id) {
    runningEntry.turn_id = workerEvent.turn_id;
  }
  if (workerEvent.codex_app_server_pid !== undefined && workerEvent.codex_app_server_pid !== null) {
    runningEntry.codex_app_server_pid = String(workerEvent.codex_app_server_pid);
  }
  if (!workerEvent.session_id && runningEntry.thread_id && runningEntry.turn_id) {
    workerEvent.session_id = `${runningEntry.thread_id}-${runningEntry.turn_id}`;
  }

  if (workerEvent.session_id) {
    const hadSessionId = runningEntry.session_id;
    runningEntry.session_id = workerEvent.session_id;
    if (runningEntry.run_id && hadSessionId !== workerEvent.session_id) {
      void context
        .persistSession?.({
          run_id: runningEntry.run_id,
          session_id: workerEvent.session_id
        })
        .catch(() => {
          context.logger?.log({
            level: 'warn',
            event: CANONICAL_EVENT.persistence.recordSessionFailed,
            message: `failed to persist session for ${runningEntry.identifier}`,
            context: {
              issue_id: issueId,
              issue_identifier: runningEntry.identifier,
              session_id: workerEvent.session_id
            }
          });
        });
    }
  }

  captureMissingToolOutputRecoveryReplacementLineage(runningEntry, workerEvent);
  context.updateOutstandingToolCalls(runningEntry, workerEvent);

  if (workerEvent.event === CANONICAL_EVENT.codex.turnStarted) {
    runningEntry.turn_count += 1;
    runningEntry.token_telemetry_status = 'pending';
    runningEntry.token_telemetry_turn_started_at_ms = workerEvent.timestamp_ms;
    runningEntry.token_telemetry_warning_emitted = false;
  } else if (workerEvent.event === CANONICAL_EVENT.agentRunner.turnStarted) {
    runningEntry.turn_count += 1;
    if (workerEvent.agent_runtime === 'claude-cli') {
      runningEntry.provider_usage = {
        runtime: 'claude-cli',
        model: workerEvent.requested_model ?? runningEntry.requested_model ?? null,
        effective_models: [],
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        provider_turn_count: null,
        estimated_cost_usd: null,
        source: 'claude_invocation',
        status: 'awaiting',
        confidence: 'missing',
        api_retry_count: 0,
        tool_counts: {},
        mcp_counts: {},
        updated_at: new Date(workerEvent.timestamp_ms).toISOString(),
        missing_reason: null,
        reconciliation_delta: null,
        model_usage: []
      };
    }
  }

  if (workerEvent.provider_usage) {
    const previous = runningEntry.provider_usage;
    const next = workerEvent.provider_usage;
    const tokenProgress =
      (next.input_tokens ?? 0) > (previous?.input_tokens ?? 0) ||
      (next.output_tokens ?? 0) > (previous?.output_tokens ?? 0) ||
      (next.cache_read_tokens ?? 0) > (previous?.cache_read_tokens ?? 0) ||
      (next.cache_creation_tokens ?? 0) > (previous?.cache_creation_tokens ?? 0);
    runningEntry.provider_usage = {
      ...next,
      effective_models: [...(next.effective_models ?? [])],
      tool_counts: { ...(next.tool_counts ?? {}) },
      mcp_counts: { ...(next.mcp_counts ?? {}) },
      model_usage: (next.model_usage ?? []).map((entry) => ({ ...entry })),
      reconciliation_delta: next.reconciliation_delta ? { ...next.reconciliation_delta } : null
    };
    if (tokenProgress) context.resetRunningWaitEpisode(runningEntry, workerEvent.timestamp_ms);
  }

  const usageThreadMatches =
    !workerEvent.thread_id || !runningEntry.thread_id || workerEvent.thread_id === runningEntry.thread_id;
  if (workerEvent.usage && usageThreadMatches) {
    const usage = workerEvent.usage;
    const inputDelta = Math.max(0, usage.input_tokens - runningEntry.last_reported_tokens.input_tokens);
    const outputDelta = Math.max(0, usage.output_tokens - runningEntry.last_reported_tokens.output_tokens);
    const totalDelta = Math.max(0, usage.total_tokens - runningEntry.last_reported_tokens.total_tokens);
    state.codex_totals.input_tokens += inputDelta;
    state.codex_totals.output_tokens += outputDelta;
    state.codex_totals.total_tokens += totalDelta;
    if (
      typeof usage.cached_input_tokens === 'number' &&
      typeof runningEntry.last_reported_tokens.cached_input_tokens === 'number'
    ) {
      state.codex_totals.cached_input_tokens =
        (state.codex_totals.cached_input_tokens ?? 0) +
        Math.max(0, usage.cached_input_tokens - runningEntry.last_reported_tokens.cached_input_tokens);
    } else if (typeof usage.cached_input_tokens === 'number' && state.codex_totals.cached_input_tokens === undefined) {
      state.codex_totals.cached_input_tokens = usage.cached_input_tokens;
    }
    if (
      typeof usage.reasoning_output_tokens === 'number' &&
      typeof runningEntry.last_reported_tokens.reasoning_output_tokens === 'number'
    ) {
      state.codex_totals.reasoning_output_tokens =
        (state.codex_totals.reasoning_output_tokens ?? 0) +
        Math.max(0, usage.reasoning_output_tokens - runningEntry.last_reported_tokens.reasoning_output_tokens);
    } else if (
      typeof usage.reasoning_output_tokens === 'number' &&
      state.codex_totals.reasoning_output_tokens === undefined
    ) {
      state.codex_totals.reasoning_output_tokens = usage.reasoning_output_tokens;
    }
    if (typeof usage.model_context_window === 'number') {
      state.codex_totals.model_context_window =
        typeof state.codex_totals.model_context_window === 'number'
          ? Math.max(state.codex_totals.model_context_window, usage.model_context_window)
          : usage.model_context_window;
    }
    runningEntry.tokens = { ...usage };
    runningEntry.last_reported_tokens = { ...usage };
    runningEntry.token_telemetry_status = workerEvent.token_telemetry_status ?? 'available';
    runningEntry.token_telemetry_last_source = workerEvent.token_telemetry_last_source ?? 'worker_event_usage';
    runningEntry.token_telemetry_last_at_ms = workerEvent.token_telemetry_last_at_ms ?? workerEvent.timestamp_ms;
    if (totalDelta > 0) {
      context.resetRunningWaitEpisode(runningEntry, runningEntry.token_telemetry_last_at_ms);
      context.observeThroughput({
        at_ms: workerEvent.timestamp_ms,
        tokens: totalDelta
      });
    }
    context.updateBudgetProjection(issueId, runningEntry, usage.total_tokens);
  }

  if (workerEvent.token_telemetry_status && !workerEvent.usage) {
    runningEntry.token_telemetry_status = workerEvent.token_telemetry_status;
    runningEntry.token_telemetry_last_source = workerEvent.token_telemetry_last_source ?? runningEntry.token_telemetry_last_source;
    runningEntry.token_telemetry_last_at_ms = workerEvent.token_telemetry_last_at_ms ?? runningEntry.token_telemetry_last_at_ms;
  }
  if (isTerminalTurnEvent(workerEvent.event) && !workerEvent.usage && runningEntry.token_telemetry_status === 'pending') {
    runningEntry.token_telemetry_status = 'unavailable';
  }

  if (workerEvent.agent_runtime !== 'claude-cli') {
    context.maybeEmitTokenTelemetryWarning(runningEntry, workerEvent.timestamp_ms);
    context.maybeEmitBudgetTelemetryUnavailable(runningEntry, workerEvent);
    context.maybeEnforceBudget(issueId, runningEntry, workerEvent.timestamp_ms);
  }

  if (workerEvent.rate_limits) {
    state.codex_rate_limits = { ...workerEvent.rate_limits };
    runningEntry.rate_limits = { ...workerEvent.rate_limits };
  }
  if (workerEvent.protocol_warnings) {
    runningEntry.protocol_warnings = workerEvent.protocol_warnings.map((warning) => ({ ...warning }));
  } else if (workerEvent.protocol_warning) {
    runningEntry.protocol_warnings = [...(runningEntry.protocol_warnings ?? []), { ...workerEvent.protocol_warning }];
  }
  if (workerEvent.model_reroute !== undefined) {
    runningEntry.model_reroute = workerEvent.model_reroute ? { ...workerEvent.model_reroute } : null;
  }
  if (workerEvent.requested_model !== undefined) {
    runningEntry.requested_model = workerEvent.requested_model ?? null;
  }
  if (workerEvent.effective_model !== undefined) {
    runningEntry.effective_model = workerEvent.effective_model ?? null;
  }

  runningEntry.recent_events.push({
    at_ms: workerEvent.timestamp_ms,
    event: workerEvent.event,
    message: workerEvent.detail ?? null,
    ...(workerEvent.reason_code !== undefined ? { reason_code: workerEvent.reason_code } : {}),
    ...(workerEvent.request_method !== undefined ? { request_method: workerEvent.request_method } : {}),
    ...(workerEvent.request_category !== undefined ? { request_category: workerEvent.request_category } : {}),
    ...(workerEvent.tool_call_id !== undefined ? { tool_call_id: workerEvent.tool_call_id } : {}),
    ...(workerEvent.tool_name !== undefined ? { tool_name: workerEvent.tool_name } : {}),
    ...(workerEvent.protocol_warning !== undefined ? { protocol_warning: { ...workerEvent.protocol_warning } } : {}),
    ...(workerEvent.model_reroute !== undefined
      ? { model_reroute: workerEvent.model_reroute ? { ...workerEvent.model_reroute } : null }
      : {}),
    ...(workerEvent.requested_model !== undefined ? { requested_model: workerEvent.requested_model } : {}),
    ...(workerEvent.effective_model !== undefined ? { effective_model: workerEvent.effective_model } : {})
  });
  if (runningEntry.recent_events.length > 20) {
    runningEntry.recent_events.splice(0, runningEntry.recent_events.length - 20);
  }

  if (runningEntry.run_id) {
    void context
      .persistRunEvent?.({
        run_id: runningEntry.run_id,
        timestamp_ms: workerEvent.timestamp_ms,
        event: workerEvent.event,
        message: workerEvent.detail ?? null,
        reason_code: workerEvent.reason_code ?? null,
        request_method: workerEvent.request_method ?? null,
        request_category: workerEvent.request_category ?? null
      })
      .catch(() => {
        context.logger?.log({
          level: 'warn',
          event: CANONICAL_EVENT.persistence.recordEventFailed,
          message: `failed to persist worker event for ${runningEntry.identifier}`,
          context: {
            issue_id: issueId,
            issue_identifier: runningEntry.identifier,
            session_id: runningEntry.session_id
          }
        });
      });
  }

  const turnAlreadyObserved = context.beginExecutionGraphWorkerTurnObservation(runningEntry, workerEvent);
  context.queuePersistExecutionGraphWorkerEvent(issueId, runningEntry, workerEvent, turnAlreadyObserved);

  context.logger?.log({
    level: 'info',
    event: CANONICAL_EVENT.orchestration.workerEvent,
    message: workerEvent.event,
    context: {
      issue_id: issueId,
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id,
      thread_id: runningEntry.thread_id,
      turn_id: runningEntry.turn_id,
      worker_host: runningEntry.worker_host,
      codex_app_server_pid: runningEntry.codex_app_server_pid,
      event: workerEvent.event,
      event_summary: runningEntry.last_event_summary,
      reason_code: workerEvent.reason_code ?? null,
      request_method: workerEvent.request_method ?? null,
      request_category: workerEvent.request_category ?? null
    }
  });
  context.recordRuntimeEvent({
    event: workerEvent.event,
    severity: severityForRuntimeEvent(workerEvent.event),
    issue_identifier: runningEntry.identifier,
    session_id: runningEntry.session_id ?? undefined,
    detail: workerEvent.detail,
    ...(workerEvent.reason_code !== undefined ? { reason_code: workerEvent.reason_code } : {}),
    ...(workerEvent.request_method !== undefined ? { request_method: workerEvent.request_method } : {}),
    ...(workerEvent.request_category !== undefined ? { request_category: workerEvent.request_category } : {}),
    ...(workerEvent.tool_call_id !== undefined ? { tool_call_id: workerEvent.tool_call_id } : {}),
    ...(workerEvent.tool_name !== undefined ? { tool_name: workerEvent.tool_name } : {}),
    ...(workerEvent.protocol_warning !== undefined ? { protocol_warning: { ...workerEvent.protocol_warning } } : {}),
    ...(workerEvent.model_reroute !== undefined
      ? { model_reroute: workerEvent.model_reroute ? { ...workerEvent.model_reroute } : null }
      : {}),
    ...(workerEvent.requested_model !== undefined ? { requested_model: workerEvent.requested_model } : {}),
    ...(workerEvent.effective_model !== undefined ? { effective_model: workerEvent.effective_model } : {})
  });
  if (!context.emitExplicitPhaseMarker(issueId, workerEvent)) {
    context.emitMappedPhaseMarker(issueId, workerEvent);
  }

  if (
    workerEvent.event === CANONICAL_EVENT.codex.turnWaiting ||
    runningEntry.running_waiting_started_at_ms != null ||
    context.hasOutstandingToolCallEvidence(runningEntry)
  ) {
    void context.maybeClassifyRunningWaitStall(issueId, runningEntry, workerEvent.timestamp_ms);
  }
}

function recordStaleRunningWorkerEvent(
  context: WorkerEventWorkflowContext,
  runningEntry: RunningEntry,
  reason: QuarantinedWorkerEventReason
): void {
  const { issueId, workerEvent } = context;
  const quarantinedEvent = {
    at_ms: workerEvent.timestamp_ms,
    event: workerEvent.event,
    message: workerEvent.detail ?? null,
    codex_app_server_pid: normalizeCodexAppServerPid(workerEvent.codex_app_server_pid),
    worker_process_pid: normalizeWorkerProcessPid(workerEvent.worker_process_pid),
    worker_instance_id: normalizeWorkerInstanceId(workerEvent.worker_instance_id),
    session_id: workerEvent.session_id ?? null,
    thread_id: workerEvent.thread_id ?? null,
    turn_id: workerEvent.turn_id ?? null,
    active_codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
    active_worker_process_pid: runningEntry.worker_process_pid ?? null,
    active_worker_instance_id: runningEntry.worker_instance_id ?? null,
    run_id: null,
    issue_run_id: null,
    attempt_id: null,
    active_run_id: runningEntry.run_id ?? null,
    active_issue_run_id: runningEntry.issue_run_id ?? null,
    active_attempt_id: runningEntry.attempt_id ?? null,
    active_session_id: runningEntry.session_id ?? null,
    active_thread_id: runningEntry.thread_id ?? null,
    active_turn_id: runningEntry.turn_id ?? null,
    reason
  };
  runningEntry.quarantined_events = [...(runningEntry.quarantined_events ?? []), quarantinedEvent].slice(-40);
  runningEntry.quarantined_event_count = (runningEntry.quarantined_event_count ?? 0) + 1;
  runningEntry.last_quarantined_event_at_ms = workerEvent.timestamp_ms;

  context.logger?.log({
    level: 'warn',
    event: CANONICAL_EVENT.orchestration.staleWorkerEventIgnored,
    message: 'stale worker event ignored for active run',
    context: {
      issue_id: issueId,
      issue_identifier: runningEntry.identifier,
      active_thread_id: runningEntry.thread_id,
      event_thread_id: workerEvent.thread_id ?? null,
      active_turn_id: runningEntry.turn_id,
      event_turn_id: workerEvent.turn_id ?? null,
      active_session_id: runningEntry.session_id,
      event_session_id: workerEvent.session_id ?? null,
      active_codex_app_server_pid: runningEntry.codex_app_server_pid,
      event_codex_app_server_pid: normalizeCodexAppServerPid(workerEvent.codex_app_server_pid),
      active_worker_instance_id: runningEntry.worker_instance_id ?? null,
      event_worker_instance_id: normalizeWorkerInstanceId(workerEvent.worker_instance_id),
      active_run_id: runningEntry.run_id ?? null,
      active_issue_run_id: runningEntry.issue_run_id ?? null,
      active_attempt_id: runningEntry.attempt_id ?? null,
      event: workerEvent.event,
      reason: quarantinedEvent.reason
    }
  });
  maybeRecordOwnershipConflict(runningEntry, workerEvent, reason, context.logger);
  context.notifyObservers();
}

function maybeRecordOwnershipConflict(
  runningEntry: RunningEntry,
  workerEvent: WorkerObservabilityEvent,
  reason: QuarantinedWorkerEventReason,
  logger: StructuredLogger | undefined
): void {
  if (reason !== 'worker_identity_mismatch' && reason !== 'inactive_worker_pid') {
    return;
  }
  if (runningEntry.session_id || runningEntry.thread_id || runningEntry.turn_id) {
    return;
  }

  const eventPid = normalizeCodexAppServerPid(workerEvent.codex_app_server_pid);
  const eventWorkerInstanceId = normalizeWorkerInstanceId(workerEvent.worker_instance_id);
  if (!eventPid && !eventWorkerInstanceId) {
    return;
  }

  runningEntry.ownership_conflict = {
    reason: 'pre_session_identity_conflict',
    detected_at_ms: workerEvent.timestamp_ms,
    event: workerEvent.event,
    event_codex_app_server_pid: eventPid,
    active_codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
    event_worker_instance_id: eventWorkerInstanceId,
    active_worker_instance_id: runningEntry.worker_instance_id ?? null,
    event_thread_id: workerEvent.thread_id ?? null,
    event_turn_id: workerEvent.turn_id ?? null,
    event_session_id: workerEvent.session_id ?? null
  };
  logger?.log({
    level: 'warn',
    event: CANONICAL_EVENT.orchestration.ownershipConflictDetected,
    message: 'active worker ownership conflict detected',
    context: {
      issue_id: runningEntry.issue.id,
      issue_identifier: runningEntry.identifier,
      conflict_reason: runningEntry.ownership_conflict.reason,
      active_run_id: runningEntry.run_id ?? null,
      active_issue_run_id: runningEntry.issue_run_id ?? null,
      active_attempt_id: runningEntry.attempt_id ?? null,
      active_worker_instance_id: runningEntry.worker_instance_id ?? null,
      active_codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
      event_worker_instance_id: eventWorkerInstanceId,
      event_codex_app_server_pid: eventPid,
      event: workerEvent.event
    }
  });
}

export function staleWorkerExitReasonForRunningEntry(
  running: RunningEntry,
  details: WorkerExitDetails
): 'worker_instance_mismatch' | 'worker_handle_mismatch' | 'worker_pid_mismatch' | 'thread_mismatch' | 'turn_mismatch' | 'session_mismatch' | null {
  const exitWorkerInstanceId = normalizeWorkerInstanceId(details.worker_instance_id);
  if (exitWorkerInstanceId && running.worker_instance_id && exitWorkerInstanceId !== running.worker_instance_id) {
    return 'worker_instance_mismatch';
  }

  if (details.worker_handle !== undefined && details.worker_handle !== running.worker_handle) {
    return 'worker_handle_mismatch';
  }

  const exitPid = normalizeCodexAppServerPid(details.codex_app_server_pid);
  if (exitPid && running.codex_app_server_pid && exitPid !== running.codex_app_server_pid) {
    return 'worker_pid_mismatch';
  }

  const exitRuntimePid = normalizeWorkerProcessPid(details.worker_process_pid);
  if (exitRuntimePid && running.worker_process_pid && exitRuntimePid !== running.worker_process_pid) {
    return 'worker_pid_mismatch';
  }

  if (details.thread_id && running.thread_id && details.thread_id !== running.thread_id) {
    return 'thread_mismatch';
  }

  if (details.turn_id && running.turn_id && details.turn_id !== running.turn_id) {
    return 'turn_mismatch';
  }

  if (details.session_id && running.session_id && details.session_id !== running.session_id) {
    return 'session_mismatch';
  }

  return null;
}

export async function applyWorkerExitLineage(params: {
  running: RunningEntry;
  details: WorkerExitDetails;
  persistSession?: (params: { run_id: string; session_id: string }) => Promise<unknown>;
}): Promise<void> {
  const { running, details } = params;
  const sessionId = details.session_id ?? null;
  if (sessionId && !running.session_id) {
    running.session_id = sessionId;
    if (running.run_id) {
      await params.persistSession?.({
        run_id: running.run_id,
        session_id: sessionId
      });
    }
  }
  if (details.thread_id && !running.thread_id) {
    running.thread_id = details.thread_id;
  }
  if (details.turn_id && !running.turn_id) {
    running.turn_id = details.turn_id;
  }
  const codexAppServerPid = normalizeCodexAppServerPid(details.codex_app_server_pid);
  if (codexAppServerPid && !running.codex_app_server_pid) {
    running.codex_app_server_pid = codexAppServerPid;
  }
  const workerProcessPid = normalizeWorkerProcessPid(details.worker_process_pid);
  if (workerProcessPid && !running.worker_process_pid) {
    running.worker_process_pid = workerProcessPid;
  }
}

export function recordTerminationExitObserved(params: {
  issueId: string;
  running: RunningEntry;
  reason: WorkerExitReason;
  error: string | undefined;
  details: WorkerExitDetails;
  observedAtMs: number;
  logger?: StructuredLogger;
}): void {
  const { issueId, running, reason, error, details } = params;
  const termination = running.termination;
  if (!termination) {
    return;
  }
  running.termination = {
    ...termination,
    state: 'exit_observed',
    exit_observed_at_ms: termination.exit_observed_at_ms ?? params.observedAtMs,
    worker_instance_id: normalizeWorkerInstanceId(details.worker_instance_id) ?? termination.worker_instance_id ?? running.worker_instance_id ?? null,
    codex_app_server_pid: normalizeCodexAppServerPid(details.codex_app_server_pid) ?? termination.codex_app_server_pid ?? running.codex_app_server_pid ?? null,
    worker_process_pid:
      normalizeWorkerProcessPid(details.worker_process_pid) ??
      termination.worker_process_pid ??
      running.worker_process_pid ??
      null,
    thread_id: details.thread_id ?? termination.thread_id ?? running.thread_id ?? null,
    turn_id: details.turn_id ?? termination.turn_id ?? running.turn_id ?? null,
    session_id: details.session_id ?? termination.session_id ?? running.session_id ?? null
  };
  params.logger?.log({
    level: 'info',
    event: CANONICAL_EVENT.orchestration.workerExitHandled,
    message: 'worker exit observed during termination release',
    context: {
      issue_id: issueId,
      issue_identifier: running.identifier,
      reason,
      error: error ?? null,
      outcome: 'termination_exit_observed',
      termination_reason: termination.reason,
      termination_state: running.termination.state,
      cleanup_workspace: termination.cleanup_workspace,
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
      event_session_id: details.session_id ?? null,
      completion_reason: details.completion_reason ?? null,
      refreshed_state: details.refreshed_state ?? null
    }
  });
}

export function classifyWorkerActivity(params: {
  runningEntry: RunningEntry;
  observedAtMs: number;
  waitThresholdMs: number;
}): WorkerActivityClassification {
  const { runningEntry, observedAtMs, waitThresholdMs } = params;
  const latestMeaningfulProgressAtMs = Math.max(
    0,
    runningEntry.last_progress_transition_at_ms ?? runningEntry.started_at_ms,
    ...Object.values(runningEntry.tool_call_ledger ?? {}).map((entry) => entry.last_seen_at_ms),
    ...Object.values(runningEntry.outstanding_tool_calls ?? {}).map((entry) => entry.last_waiting_at_ms ?? entry.started_at_ms)
  );
  const latestThreadActivityAtMs = runningEntry.codex_thread_activity_at_ms ?? null;
  const latestLivenessAtMs = Math.max(
    0,
    runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms,
    runningEntry.last_process_liveness_at_ms ?? 0,
    runningEntry.last_heartbeat_at_ms ?? 0,
    latestThreadActivityAtMs ?? 0
  );
  const normalizedMeaningful = latestMeaningfulProgressAtMs > 0 ? latestMeaningfulProgressAtMs : null;
  const normalizedLiveness = latestLivenessAtMs > 0 ? latestLivenessAtMs : null;
  const meaningfulAgeMs = normalizedMeaningful === null ? Number.POSITIVE_INFINITY : observedAtMs - normalizedMeaningful;
  const livenessAgeMs = normalizedLiveness === null ? Number.POSITIVE_INFINITY : observedAtMs - normalizedLiveness;
  const hasFreshLiveness = waitThresholdMs <= 0 || livenessAgeMs <= waitThresholdMs;
  const hasFreshThreadActivity =
    latestThreadActivityAtMs !== null && (waitThresholdMs <= 0 || observedAtMs - latestThreadActivityAtMs <= waitThresholdMs);
  const waitingLike = runningEntry.last_event === CANONICAL_EVENT.codex.turnWaiting || runningEntry.running_waiting_started_at_ms != null;
  const activityState: WorkerActivityState =
    meaningfulAgeMs <= waitThresholdMs
      ? 'advancing'
      : hasFreshThreadActivity
        ? 'active_but_opaque'
        : hasFreshLiveness || waitingLike
          ? 'heartbeat_only'
          : 'stale';

  return {
    latest_meaningful_progress_at_ms: normalizedMeaningful,
    latest_liveness_at_ms: normalizedLiveness,
    latest_thread_activity_at_ms: latestThreadActivityAtMs,
    activity_state: activityState
  };
}

export function workerEventLooksLikeTrackerComment(
  workerEvent: Pick<WorkerObservabilityEvent, 'event' | 'tool_name' | 'request_method' | 'request_category'>
): boolean {
  const event = workerEvent.event?.toLowerCase() ?? '';
  const toolName = workerEvent.tool_name?.toLowerCase() ?? '';
  const requestMethod = workerEvent.request_method?.toLowerCase() ?? '';
  const requestCategory = workerEvent.request_category?.toLowerCase() ?? '';

  if (event === 'linear.comment.created' || event === 'linear.comment.updated') {
    return true;
  }

  const looksLikeLinearRequest = requestCategory === 'linear' || event.startsWith('linear.');
  return (
    looksLikeLinearRequest &&
    (toolName === 'save_comment' ||
      toolName === 'create_comment' ||
      requestMethod === 'save_comment' ||
      requestMethod === 'create_comment')
  );
}

function isInactiveWorkerPid(inactiveEntries: InactiveWorkerPidEntry[], pid: string, workerInstanceId: string | null): boolean {
  // Every current local bridge event is enriched with a worker instance ID. If
  // a legacy/untrusted producer omits it, fail closed on an inactive PID match
  // rather than letting stale activity acquire the new run's lineage.
  return inactiveEntries.some(
    (entry) => entry.pid === pid && (!workerInstanceId || entry.worker_instance_id === workerInstanceId)
  );
}

function isInactiveWorkerRuntimePid(
  inactiveEntries: InactiveWorkerPidEntry[],
  pid: string,
  workerInstanceId: string | null
): boolean {
  return inactiveEntries.some(
    (entry) => entry.runtime_pid === pid && (!workerInstanceId || entry.worker_instance_id === workerInstanceId)
  );
}

function isInactiveWorkerLineageQuarantineReason(reason: string): boolean {
  return reason === REASON_CODES.workspaceAttemptResidueRecovered || reason === REASON_CODES.handoffRelease;
}

function isInactiveWorkerLineage(
  inactiveEntries: InactiveWorkerPidEntry[],
  workerEvent: WorkerObservabilityEvent
): boolean {
  if (inactiveEntries.length === 0) {
    return false;
  }

  return inactiveEntries.some((entry) => {
    if (!isInactiveWorkerLineageQuarantineReason(entry.reason)) {
      return false;
    }
    const turnMatches = Boolean(entry.turn_id) && workerEvent.turn_id === entry.turn_id;
    const sessionMatches = Boolean(entry.session_id) && workerEvent.session_id === entry.session_id;
    if (!turnMatches && !sessionMatches) {
      return false;
    }
    return !entry.thread_id || !workerEvent.thread_id || workerEvent.thread_id === entry.thread_id;
  });
}

function isSameThreadContinuationTurnStart(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
  const turnId = workerEvent.turn_id;
  const isCodexContinuation =
    workerEvent.event === CANONICAL_EVENT.codex.turnStarted &&
    runningEntry.last_event === CANONICAL_EVENT.codex.turnCompleted;
  const isGenericContinuation =
    workerEvent.event === CANONICAL_EVENT.agentRunner.turnStarted &&
    runningEntry.last_event === CANONICAL_EVENT.agentRunner.turnCompleted;
  return (
    (isCodexContinuation || isGenericContinuation) &&
    Boolean(runningEntry.thread_id) &&
    workerEvent.thread_id === runningEntry.thread_id &&
    typeof turnId === 'string' &&
    !(runningEntry.persisted_turn_ids ?? []).includes(turnId) &&
    !(runningEntry.pending_persisted_turn_ids ?? []).includes(turnId)
  );
}

function isCodexContinuationSessionStart(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
  const eventWorkerInstanceId = normalizeWorkerInstanceId(workerEvent.worker_instance_id);
  const eventPid = normalizeCodexAppServerPid(workerEvent.codex_app_server_pid);
  return (
    workerEvent.event === CANONICAL_EVENT.codex.sessionStarted &&
    runningEntry.last_event === CANONICAL_EVENT.codex.turnCompleted &&
    Boolean(eventWorkerInstanceId) &&
    eventWorkerInstanceId === runningEntry.worker_instance_id &&
    Boolean(eventPid) &&
    eventPid !== runningEntry.codex_app_server_pid &&
    Boolean(workerEvent.thread_id) &&
    workerEvent.thread_id !== runningEntry.thread_id &&
    workerEvent.timestamp_ms >= (runningEntry.last_codex_timestamp_ms ?? 0)
  );
}

function isSameThreadContinuationProcessStart(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
  return (
    workerEvent.event === CANONICAL_EVENT.agentRunner.processStarted &&
    runningEntry.last_event === CANONICAL_EVENT.agentRunner.turnCompleted &&
    Boolean(runningEntry.thread_id) &&
    workerEvent.thread_id === runningEntry.thread_id &&
    Boolean(runningEntry.session_id) &&
    workerEvent.session_id === runningEntry.session_id &&
    typeof workerEvent.turn_id === 'string' &&
    workerEvent.turn_id !== runningEntry.turn_id
  );
}

function isTerminalTurnResidue(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
  if (!runningEntry.last_event || !isTerminalTurnEvent(runningEntry.last_event)) {
    return false;
  }
  if (
    workerEvent.event === CANONICAL_EVENT.codex.turnStarted ||
    workerEvent.event === CANONICAL_EVENT.agentRunner.turnStarted
  ) {
    return false;
  }

  const sameTurn = Boolean(runningEntry.turn_id) && workerEvent.turn_id === runningEntry.turn_id;
  const sameSession = Boolean(runningEntry.session_id) && workerEvent.session_id === runningEntry.session_id;
  const sameThread =
    !runningEntry.thread_id || !workerEvent.thread_id || workerEvent.thread_id === runningEntry.thread_id;
  const eventPid = normalizeCodexAppServerPid(workerEvent.codex_app_server_pid);
  const eventRuntimePid = normalizeWorkerProcessPid(workerEvent.worker_process_pid);
  const sameWorkerPid =
    (Boolean(runningEntry.codex_app_server_pid) && eventPid === runningEntry.codex_app_server_pid) ||
    (Boolean(runningEntry.worker_process_pid) && eventRuntimePid === runningEntry.worker_process_pid);
  const hasEventLineage = Boolean(
    workerEvent.thread_id || workerEvent.turn_id || workerEvent.session_id || eventPid || eventRuntimePid
  );
  return sameThread && (sameTurn || sameSession || sameWorkerPid || !hasEventLineage);
}

function isSameThreadRecoveryTurnStart(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
  const turnId = workerEvent.turn_id;
  return (
    workerEvent.event === CANONICAL_EVENT.codex.turnStarted &&
    runningEntry.recovery?.last_result === 'started' &&
    Boolean(runningEntry.thread_id) &&
    workerEvent.thread_id === runningEntry.thread_id &&
    typeof turnId === 'string' &&
    turnId !== runningEntry.turn_id
  );
}

function isPreviousRecoveryTurnEvent(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
  const recovery = runningEntry.recovery;
  if (!recovery || recovery.last_result !== 'started') {
    return false;
  }

  const matchesPreviousTurn = Boolean(recovery.previous_turn_id) && workerEvent.turn_id === recovery.previous_turn_id;
  const matchesPreviousSession =
    Boolean(recovery.previous_session_id) && workerEvent.session_id === recovery.previous_session_id;
  if (!matchesPreviousTurn && !matchesPreviousSession) {
    return false;
  }

  if (recovery.previous_thread_id && workerEvent.thread_id && workerEvent.thread_id !== recovery.previous_thread_id) {
    return false;
  }

  return true;
}
