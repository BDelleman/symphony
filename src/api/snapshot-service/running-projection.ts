import type { OrchestratorState, RunningEntry } from '../../orchestrator';
import { explainOperatorRuntimeState, REASON_CODES, toOperatorExplainerHint } from '../../observability';
import { buildRunningConversationLatest } from '../agent-conversation';
import { projectMissingToolOutputRecovery } from '../missing-tool-output-recovery';
import { resolveNotBlockedExplainer, resolveProgressSignal, resolveRunningTurnControl, resolveTokenTelemetryQuality } from '../runtime-visibility';
import type { ApiStateResponse } from '../types';
import { projectBudget } from './budget';
import { actionBelongsToRunningEntry } from './operator-actions';
import { projectCodexSessionTranscriptScanBudget, projectCodexThreadActivity, projectPhaseTiming } from './state-projection';
import { projectTranscriptToolCallDiagnosticSummary } from './transcript-diagnostics';
import { asIsoDate } from './time';

export function redactPromptPreview(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const redacted = trimmed
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '***REDACTED***')
    .replace(/\b(?:bearer\s+)?(?:sk|api|token|key)[_-]?[a-z0-9]*[:=]\s*[^\s,;]+/gi, '***REDACTED***')
    .replace(/\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=***REDACTED***');
  const truncated = Array.from(redacted).slice(0, 160).join('').trim();
  return truncated && truncated !== '***REDACTED***' ? truncated : null;
}

export function explainRunningEntry(entry: RunningEntry) {
  return explainOperatorRuntimeState({
    state_class: 'running',
    awaiting_input: Boolean(entry.awaiting_input_since_ms),
    stalled_waiting: Boolean(entry.stalled_waiting_since_ms && entry.stalled_waiting_reason),
    stalled_waiting_reason: entry.stalled_waiting_reason ?? null,
    reason_code:
      entry.stalled_waiting_since_ms && entry.stalled_waiting_reason
        ? entry.stalled_waiting_reason
        : entry.awaiting_input_since_ms
          ? REASON_CODES.turnInputRequired
          : null,
    reason_detail:
      entry.stalled_waiting_since_ms && entry.stalled_waiting_reason
        ? 'codex.turn.waiting heartbeat loop exceeded threshold'
        : entry.awaiting_input_since_ms
          ? entry.pending_input_preview?.type ?? null
          : entry.last_event_summary ?? entry.last_message
  });
}

export function isWaitLikeEvent(event: RunningEntry['recent_events'][number]): boolean {
  const normalized = `${event.event} ${event.message ?? ''}`.toLowerCase();
  return normalized.includes('waiting') || normalized.includes('heartbeat') || normalized.includes('wait');
}

export function resolveLastSuccessfulStep(entry: RunningEntry): string | null {
  const lastProgressEvent = [...entry.recent_events].reverse().find((event) => !isWaitLikeEvent(event));
  if (lastProgressEvent) {
    return lastProgressEvent.message ? `${lastProgressEvent.event}: ${lastProgressEvent.message}` : lastProgressEvent.event;
  }
  if (entry.current_phase) {
    return entry.phase_detail ? `${entry.current_phase}: ${entry.phase_detail}` : entry.current_phase;
  }
  return entry.last_event_summary ?? entry.last_event ?? null;
}

export function toStateRunningRow(
  issueId: string,
  entry: RunningEntry,
  nowMs: number,
  operatorActions: OrchestratorState['operator_actions']
): ApiStateResponse['running'][number] {
  const awaitingInput = Boolean(entry.awaiting_input_since_ms);
  const stalledWaiting = Boolean(entry.stalled_waiting_since_ms && entry.stalled_waiting_reason);
  const progressSignal = resolveProgressSignal(entry);
  const turnControl = resolveRunningTurnControl(entry);
  const notBlockedExplainer = resolveNotBlockedExplainer({
    blocked: false,
    progress_signal_state: progressSignal.progress_signal_state,
    awaiting_input: awaitingInput,
    waiting_started_at_ms: entry.running_waiting_started_at_ms ?? null,
    now_ms: nowMs,
    stalled_waiting_ms: 300_000
  });
  const operatorExplainer = explainRunningEntry(entry);
  const timeSinceProgress =
    typeof entry.last_progress_transition_at_ms === 'number'
      ? Math.max(0, nowMs - entry.last_progress_transition_at_ms)
      : null;
  return {
    issue_id: issueId,
    issue_identifier: entry.identifier,
    ...projectBudget(entry),
    state: entry.issue.state,
    dispatch_state: entry.dispatch_state ?? entry.started_issue_state ?? entry.issue.state,
    session_id: entry.session_id,
    worker_host: entry.worker_host ?? null,
    workspace_path: entry.workspace_path ?? null,
    provisioner_type: entry.provisioner_type ?? null,
    branch_name: entry.branch_name ?? null,
    repo_root: entry.repo_root ?? null,
    workspace_exists: entry.workspace_exists,
    workspace_git_status: entry.workspace_git_status ?? null,
    workspace_provisioned: entry.workspace_provisioned,
    workspace_is_git_worktree: entry.workspace_is_git_worktree,
    copy_ignored_applied: entry.copy_ignored_applied ?? false,
    copy_ignored_status: entry.copy_ignored_status ?? null,
    copy_ignored_summary: entry.copy_ignored_summary ?? null,
    thread_id: entry.thread_id,
    turn_id: entry.turn_id,
    codex_app_server_pid: entry.codex_app_server_pid,
    agent_runtime: entry.agent_runtime ?? null,
    worker_process_pid: entry.worker_process_pid ?? null,
    provider_usage: entry.provider_usage
      ? {
          ...entry.provider_usage,
          effective_models: [...(entry.provider_usage.effective_models ?? [])],
          tool_counts: { ...(entry.provider_usage.tool_counts ?? {}) },
          mcp_counts: { ...(entry.provider_usage.mcp_counts ?? {}) },
          model_usage: (entry.provider_usage.model_usage ?? []).map((usage) => ({ ...usage })),
          reconciliation_delta: entry.provider_usage.reconciliation_delta
            ? { ...entry.provider_usage.reconciliation_delta }
            : null
        }
      : null,
    turn_count: entry.turn_count,
    last_event: entry.last_event,
    last_event_summary: entry.last_event_summary,
    last_message: entry.last_message,
    awaiting_input: awaitingInput,
    awaiting_input_since_ms: entry.awaiting_input_since_ms ?? null,
    pending_input_preview: entry.pending_input_preview
      ? {
          type: entry.pending_input_preview.type,
          prompt_preview: redactPromptPreview(entry.pending_input_preview.prompt_preview),
          option_count: typeof entry.pending_input_preview.option_count === 'number' ? entry.pending_input_preview.option_count : null
        }
      : null,
    stalled_waiting: stalledWaiting,
    stalled_waiting_since_ms: stalledWaiting ? entry.stalled_waiting_since_ms ?? null : null,
    stalled_waiting_reason: stalledWaiting ? REASON_CODES.turnWaitingThresholdExceeded : null,
    current_phase: entry.current_phase ?? null,
    current_phase_at: entry.current_phase_at_ms ? asIsoDate(entry.current_phase_at_ms) : null,
    phase_elapsed_ms: entry.current_phase_at_ms ? Math.max(0, nowMs - entry.current_phase_at_ms) : null,
    phase_timing: projectPhaseTiming(entry, nowMs),
    phase_detail: entry.phase_detail ?? null,
    started_at: asIsoDate(entry.started_at_ms),
    last_event_at: entry.last_codex_timestamp_ms !== null ? asIsoDate(entry.last_codex_timestamp_ms) : null,
    codex_thread_activity: projectCodexThreadActivity(entry, nowMs),
    token_telemetry_status: entry.token_telemetry_status,
    token_telemetry_last_source: entry.token_telemetry_last_source,
    token_telemetry_last_at_ms: entry.token_telemetry_last_at_ms,
    rate_limits: entry.rate_limits ?? null,
    protocol_warnings: (entry.protocol_warnings ?? []).map((warning) => ({ ...warning })),
    model_reroute: entry.model_reroute ? { ...entry.model_reroute } : null,
    requested_model: entry.requested_model ?? null,
    effective_model: entry.effective_model ?? null,
    ...turnControl,
    ...progressSignal,
    ...resolveTokenTelemetryQuality(entry),
    quarantined_event_count: entry.quarantined_event_count ?? 0,
    last_quarantined_event_at: entry.last_quarantined_event_at_ms ? asIsoDate(entry.last_quarantined_event_at_ms) : null,
    ownership_conflict: entry.ownership_conflict
      ? {
          ...entry.ownership_conflict,
          detected_at: asIsoDate(entry.ownership_conflict.detected_at_ms)
        }
      : null,
    current_blocker_class: operatorExplainer.actionability === 'none' ? null : operatorExplainer.classification,
    time_since_progress: timeSinceProgress,
    last_successful_step: resolveLastSuccessfulStep(entry),
    conversation_latest: buildRunningConversationLatest(issueId, entry),
    transcript_tool_call_diagnostic_summary: projectTranscriptToolCallDiagnosticSummary(entry),
    ...notBlockedExplainer,
    operator_actions: (operatorActions?.get(issueId) ?? [])
      .filter((action) => actionBelongsToRunningEntry(action, entry))
      .map((action) => ({ ...action })),
    tokens: {
      input_tokens: entry.tokens.input_tokens,
      output_tokens: entry.tokens.output_tokens,
      total_tokens: entry.tokens.total_tokens,
      ...(typeof entry.tokens.cached_input_tokens === 'number'
        ? { cached_input_tokens: entry.tokens.cached_input_tokens }
        : {}),
      ...(typeof entry.tokens.reasoning_output_tokens === 'number'
        ? { reasoning_output_tokens: entry.tokens.reasoning_output_tokens }
        : {}),
      ...(typeof entry.tokens.model_context_window === 'number'
        ? { model_context_window: entry.tokens.model_context_window }
        : {})
    },
    recovery: entry.recovery ? { ...entry.recovery } : null,
    missing_tool_output_recovery: projectMissingToolOutputRecovery(entry),
    codex_session_transcript_scan_budget: projectCodexSessionTranscriptScanBudget(entry),
    operator_explainer_hint: toOperatorExplainerHint(operatorExplainer)
  };
}
