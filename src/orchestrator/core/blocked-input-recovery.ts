import { createHash } from 'node:crypto';
import { REASON_CODES } from '../../observability/reason-codes';
import {
  type BlockedEntry,
  type MissingToolOutputRecoveryState,
  type OrchestratorState,
  type OutstandingToolCall,
  type RunningEntry,
  type WorkerObservabilityEvent,
  type WorkerTerminationResult
} from '../types';
import { normalizeCodexAppServerPid } from './worker-events';

type ToolOutputWaitDiagnostic = NonNullable<BlockedEntry['tool_output_wait']>;

export function workerTerminationResultContext(result: WorkerTerminationResult | null | undefined): Record<string, unknown> {
  if (!result) {
    return {
      worker_termination_result: null
    };
  }
  return {
    worker_termination_result: result.result,
    worker_termination_reason_code: result.reason_code,
    worker_termination_detail: result.detail,
    worker_cancellation_supported: result.cancellation_supported,
    worker_cancellation_requested: result.cancellation_requested,
    worker_settled: result.worker_settled,
    graceful_exit_observed: result.graceful_exit_observed,
    forced_kill_requested: result.forced_kill_requested,
    forced_kill_settled: result.forced_kill_settled,
    cleanup_requested: result.cleanup_requested,
    cleanup_succeeded: result.cleanup_succeeded
  };
}

export function workerTerminationResultDetail(prefix: string, result: WorkerTerminationResult): string {
  const fields = [
    `termination_result=${result.result}`,
    `termination_reason_code=${result.reason_code}`,
    `termination_detail=${result.detail ?? 'none'}`,
    `cancellation_supported=${result.cancellation_supported}`,
    `cancellation_requested=${result.cancellation_requested}`,
    `worker_settled=${result.worker_settled ?? 'unknown'}`,
    `graceful_exit_observed=${result.graceful_exit_observed ?? 'unknown'}`,
    `forced_kill_requested=${result.forced_kill_requested}`,
    `forced_kill_settled=${result.forced_kill_settled ?? 'unknown'}`,
    `cleanup_requested=${result.cleanup_requested}`,
    `cleanup_succeeded=${result.cleanup_succeeded ?? 'unknown'}`
  ];
  return `${prefix} ${fields.join(' ')}`;
}

export function workerTerminationExceptionResult(error: unknown): WorkerTerminationResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    cancellation_supported: false,
    cancellation_requested: true,
    worker_settled: null,
    graceful_exit_observed: null,
    forced_kill_requested: false,
    forced_kill_settled: null,
    cleanup_requested: false,
    cleanup_succeeded: null,
    result: 'unknown',
    reason_code: REASON_CODES.workerCancelUnknown,
    detail: `Worker termination failed before returning typed outcome: ${message}`
  };
}

export function normalizeOperatorReasonNote(reason_note: string | null | undefined): string | null {
  const trimmed = reason_note?.trim();
  return trimmed ? trimmed : null;
}

export function reasonNoteRequiredFailure(): { ok: false; code: string; message: string } {
  return { ok: false, code: 'reason_note_required', message: 'reason_note is required' };
}

/**
 * A no-progress circuit breaker can hold an issue that has no blocked-input
 * record and no running attempt. Resume and requeue both fall through to a
 * generic "nothing to do here" error in that case, which sends the operator in
 * circles while the dashboard still shows the issue as held. Name the actual
 * holder and the only endpoint that releases it.
 */
export function activeAutomationFaultFailure(
  state: OrchestratorState,
  issue_identifier: string
): { ok: false; code: string; message: string } | null {
  const held = Array.from(state.circuit_breakers.values()).some(
    (entry) => entry.issue_identifier === issue_identifier && entry.breaker_active
  );
  if (!held) {
    return null;
  }
  return {
    ok: false,
    code: 'automation_fault_active',
    message: `Issue ${issue_identifier} is held by a no-progress automation fault; clear it with POST /api/v1/issues/${encodeURIComponent(issue_identifier)}/clear-automation-fault`
  };
}

export function applyBlockedWorkerEventQuarantine(
  blockedEntry: BlockedEntry,
  workerEvent: WorkerObservabilityEvent,
  reason: 'awaiting_operator_latch' | 'lineage_mismatch'
): void {
  const quarantinedEvent = {
    at_ms: workerEvent.timestamp_ms,
    event: workerEvent.event,
    message: workerEvent.detail ?? null,
    codex_app_server_pid: normalizeCodexAppServerPid(workerEvent.codex_app_server_pid),
    session_id: workerEvent.session_id ?? null,
    thread_id: workerEvent.thread_id ?? null,
    turn_id: workerEvent.turn_id ?? null,
    reason
  };
  blockedEntry.quarantined_events = [...(blockedEntry.quarantined_events ?? []), quarantinedEvent].slice(-40);
  blockedEntry.quarantined_event_count = (blockedEntry.quarantined_event_count ?? 0) + 1;
  blockedEntry.last_quarantined_event_at_ms = workerEvent.timestamp_ms;
}

export function isMissingToolOutputRecoveryInProgress(running: RunningEntry): running is RunningEntry & {
  recovery: MissingToolOutputRecoveryState;
} {
  return running.recovery?.reason_code === REASON_CODES.missingToolOutput && running.recovery.last_result === 'started';
}

export function buildMissingToolOutputRecoveryState(
  runningEntry: RunningEntry,
  missingToolOutput: OutstandingToolCall,
  params: {
    observedAtMs: number;
    previousThreadId: string | null;
    previousTurnId: string | null;
    previousSessionId: string | null;
    elapsedWaitMs: number;
    attemptCount: number;
    recoveryPrompt: string;
  }
): MissingToolOutputRecoveryState {
  return {
    attempt_count: params.attemptCount,
    started_at_ms: params.observedAtMs,
    reason_code: REASON_CODES.missingToolOutput,
    mode: 'same_thread_guarded_continuation',
    previous_thread_id: params.previousThreadId,
    previous_turn_id: params.previousTurnId,
    previous_session_id: params.previousSessionId,
    previous_worker_handle_known: Boolean(runningEntry.worker_handle),
    previous_codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
    last_tool_name: missingToolOutput.tool_name,
    last_call_id: missingToolOutput.call_id,
    evidence_source: missingToolOutput.evidence_source,
    elapsed_wait_ms: params.elapsedWaitMs,
    last_agent_message: missingToolOutput.last_agent_message ?? runningEntry.last_message ?? null,
    last_observed_phase: runningEntry.current_phase ?? null,
    last_observed_phase_detail: runningEntry.phase_detail ?? null,
    recent_event_count: runningEntry.recent_events.length,
    quarantined_event_count: runningEntry.quarantined_event_count ?? 0,
    prompt_hash: createHash('sha256').update(params.recoveryPrompt).digest('hex').slice(0, 16),
    prompt_summary: 'guarded recovery prompt: inspect state before retrying indeterminate tool action',
    interrupt_cancel_result: {
      status: 'not_started',
      reason_code: null,
      detail: null
    },
    last_result: 'started'
  };
}

export function buildMissingToolOutputRecoveryPrompt(
  runningEntry: RunningEntry,
  missingToolOutput: OutstandingToolCall,
  params: {
    previousThreadId: string | null;
    previousTurnId: string | null;
    previousSessionId: string | null;
    elapsedWaitMs: number;
  }
): string {
  const lastObserved = runningEntry.current_phase
    ? `${runningEntry.current_phase}${runningEntry.phase_detail ? `: ${runningEntry.phase_detail}` : ''}`
    : (runningEntry.last_event_summary ?? runningEntry.last_event ?? 'unknown');
  return [
    'Recover from an interrupted/stalled turn.',
    '',
    'The previous turn stalled while waiting for a tool result. Treat the last tool action outcome as indeterminate unless you can prove otherwise.',
    '',
    'Before retrying anything, inspect current local and external state relevant to the last attempted action.',
    '',
    'If the action already took effect, do not repeat it; continue from the next required workflow step.',
    'If the action did not take effect, retry it once using the normal workflow path.',
    'If the action partially took effect, cannot be verified safely, or retrying could duplicate an external side effect, stop and report the ambiguity with the exact state you found and the required operator action.',
    '',
    'Recovery context:',
    `- issue: ${runningEntry.identifier}/${runningEntry.issue.id}`,
    `- issue state: ${runningEntry.issue.state}`,
    `- run id: ${runningEntry.run_id ?? 'unknown'}`,
    `- attempt id: ${runningEntry.attempt_id ?? 'unknown'}`,
    `- previous thread: ${params.previousThreadId ?? 'unknown'}`,
    `- previous turn: ${params.previousTurnId ?? 'unknown'}`,
    `- previous session: ${params.previousSessionId ?? 'unknown'}`,
    `- worker host: ${runningEntry.worker_host ?? 'unknown'}`,
    `- Codex app-server PID: ${runningEntry.codex_app_server_pid ?? 'unknown'}`,
    `- last tool: ${missingToolOutput.tool_name}`,
    `- last call id: ${missingToolOutput.call_id}`,
    `- evidence source: ${missingToolOutput.evidence_source}`,
    `- elapsed wait: ${Math.round(params.elapsedWaitMs / 1000)}s`,
    `- last observed phase/event: ${lastObserved}`,
    `- last agent message: ${missingToolOutput.last_agent_message ?? runningEntry.last_message ?? 'unknown'}`,
    `- recent event count: ${runningEntry.recent_events.length}`,
    `- quarantined event count: ${runningEntry.quarantined_event_count ?? 0}`
  ].join('\n');
}

export function buildMissingToolOutputBlockDetails(params: {
  runningEntry: RunningEntry;
  missingToolOutput: OutstandingToolCall;
  observedAtMs: number;
  stopReasonCode?: string;
  stopReasonDetailPrefix?: string | null;
}): {
  elapsedWaitMs: number;
  recommendedActions: string[];
  diagnostic: ToolOutputWaitDiagnostic;
  detail: string;
} {
  const { runningEntry, missingToolOutput, observedAtMs } = params;
  const stopReasonCode = params.stopReasonCode ?? REASON_CODES.missingToolOutput;
  const elapsedWaitMs = Math.max(0, observedAtMs - missingToolOutput.started_at_ms);
  const recommendedActions =
    stopReasonCode === REASON_CODES.missingToolOutput
      ? ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run']
      : [
          'Inspect external state for the last tool action',
          'Manually resume the Codex thread with guarded continuation',
          'Cancel or requeue after inspection'
        ];
  const diagnostic = {
    tool_name: missingToolOutput.tool_name,
    call_id: missingToolOutput.call_id,
    thread_id: missingToolOutput.thread_id ?? runningEntry.thread_id ?? null,
    turn_id: missingToolOutput.turn_id ?? runningEntry.turn_id ?? null,
    session_id: missingToolOutput.session_id ?? runningEntry.session_id ?? null,
    elapsed_wait_ms: elapsedWaitMs,
    last_agent_message: missingToolOutput.last_agent_message ?? runningEntry.last_message ?? null,
    evidence_source: missingToolOutput.evidence_source,
    recommended_actions: recommendedActions
  };
  const detail = [
    ...(params.stopReasonDetailPrefix ? [params.stopReasonDetailPrefix] : []),
    `tool_name=${diagnostic.tool_name}`,
    `call_id=${diagnostic.call_id}`,
    `thread_id=${diagnostic.thread_id ?? 'unknown'}`,
    `turn_id=${diagnostic.turn_id ?? 'unknown'}`,
    `session_id=${diagnostic.session_id ?? 'unknown'}`,
    `evidence_source=${diagnostic.evidence_source}`,
    `elapsed_wait_ms=${diagnostic.elapsed_wait_ms}`
  ].join(' ');
  return { elapsedWaitMs, recommendedActions, diagnostic, detail };
}

export function buildRecoveryStartFailedBlockDetails(
  running: RunningEntry,
  error: string
): {
  recovery: MissingToolOutputRecoveryState | null;
  diagnostic: ToolOutputWaitDiagnostic | null;
  detail: string;
} {
  const recovery = running.recovery
    ? {
        ...running.recovery,
        last_result: 'failed' as const,
        last_result_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
        last_result_detail: error
      }
    : null;
  const diagnostic = recovery
    ? {
        tool_name: recovery.last_tool_name,
        call_id: recovery.last_call_id,
        thread_id: recovery.previous_thread_id ?? running.thread_id ?? null,
        turn_id: recovery.previous_turn_id ?? running.turn_id ?? null,
        session_id: recovery.previous_session_id ?? running.session_id ?? null,
        elapsed_wait_ms: recovery.elapsed_wait_ms,
        last_agent_message: recovery.last_agent_message ?? running.last_message ?? null,
        evidence_source: recovery.evidence_source,
        recommended_actions: [
          'Inspect external state for the last tool action',
          'Manually resume the Codex thread with guarded continuation',
          'Cancel or requeue after inspection'
        ]
      }
    : null;
  const detail = [
    'same-thread guarded recovery failed to start or complete',
    `error=${error}`,
    `tool_name=${diagnostic?.tool_name ?? 'unknown'}`,
    `call_id=${diagnostic?.call_id ?? 'unknown'}`,
    `thread_id=${diagnostic?.thread_id ?? 'unknown'}`,
    `turn_id=${diagnostic?.turn_id ?? 'unknown'}`,
    `session_id=${diagnostic?.session_id ?? 'unknown'}`
  ].join(' ');
  return { recovery, diagnostic, detail };
}

export function buildDurableMissingToolOutputRecoveryContext(
  runningEntry: RunningEntry,
  recoveryOverride: MissingToolOutputRecoveryState | null
): Record<string, unknown> | null {
  const recovery = recoveryOverride ?? runningEntry.recovery ?? null;
  if (!recovery) {
    return null;
  }
  const replacementThreadId = recovery.replacement_thread_id ?? runningEntry.thread_id ?? recovery.previous_thread_id ?? null;
  const replacementTurnId =
    recovery.replacement_turn_id ??
    (runningEntry.turn_id && runningEntry.turn_id !== recovery.previous_turn_id ? runningEntry.turn_id : null);
  const replacementSessionId =
    recovery.replacement_session_id ??
    (runningEntry.session_id && runningEntry.session_id !== recovery.previous_session_id ? runningEntry.session_id : null);
  return {
    status:
      recovery.last_result === 'started'
        ? 'in_progress'
        : recovery.last_result === 'succeeded'
          ? 'succeeded'
          : recovery.last_result === 'blocked' || recovery.last_result_reason_code === REASON_CODES.missingToolOutputRecoveryUnsafe
            ? 'manual_action_required'
            : 'failed',
    original_tool_name: recovery.last_tool_name,
    original_call_id: recovery.last_call_id,
    evidence_source: recovery.evidence_source,
    elapsed_wait_ms: recovery.elapsed_wait_ms,
    active_ownership: {
      issue_id: runningEntry.issue.id,
      issue_identifier: runningEntry.identifier,
      run_id: runningEntry.run_id ?? null,
      issue_run_id: runningEntry.issue_run_id ?? null,
      attempt_id: runningEntry.attempt_id ?? null,
      thread_id: runningEntry.thread_id ?? null,
      turn_id: runningEntry.turn_id ?? null,
      session_id: runningEntry.session_id ?? null,
      codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
      app_server_owned: Boolean(runningEntry.codex_app_server_pid || runningEntry.run_id || runningEntry.issue_run_id)
    },
    interrupt_cancel_result: {
      status: recovery.interrupt_cancel_result?.status ?? 'not_started',
      reason_code: recovery.interrupt_cancel_result?.reason_code ?? null,
      detail: recovery.interrupt_cancel_result?.detail ?? null,
      termination_result: recovery.interrupt_cancel_result?.termination_result ?? null
    },
    replacement_turn: {
      thread_id: replacementThreadId,
      turn_id: replacementTurnId,
      session_id: replacementSessionId
    },
    guarded_prompt_dispatch: {
      status:
        recovery.last_result === 'failed' && recovery.last_result_reason_code === REASON_CODES.missingToolOutputRecoveryStartFailed
          ? recovery.interrupt_cancel_result?.status === 'succeeded'
            ? 'failed'
            : 'not_started'
          : recovery.last_result === 'blocked'
            ? 'not_started'
            : 'sent',
      prompt_hash: recovery.prompt_hash,
      prompt_summary: recovery.prompt_summary
    },
    final_outcome: {
      result: recovery.last_result,
      reason_code: recovery.last_result_reason_code ?? null,
      detail: recovery.last_result_detail ?? null
    }
  };
}
