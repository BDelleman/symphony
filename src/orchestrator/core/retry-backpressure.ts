import os from 'node:os';
import type { ControlPlaneEndpointHealth, ControlPlaneHealthState, ControlPlaneHealthSummary } from '../../api/control-plane-health';
import { REASON_CODES } from '../../observability/reason-codes';
import type { Issue } from '../../tracker';
import { isActiveState, isTerminalState } from '../decisions';
import type {
  DispatchBackpressureState,
  HostLoadSnapshot,
  OrchestratorOptions,
  ProgressSignals,
  RedispatchProgressSample,
  RetryEntry
} from '../types';

export const DEFAULT_BACKPRESSURE_RETRY_DELAY_MS = 30_000;
export const DEFAULT_BACKPRESSURE_MIN_RUNNING_AGENTS = 1;
export const DEFAULT_BACKPRESSURE_CONTROL_PLANE_HEALTH: ControlPlaneHealthState = 'degraded';
export const DEFAULT_BACKPRESSURE_CONTROL_PLANE_STALE_AFTER_MS = 60_000;

const CONTROL_PLANE_HEALTH_RANK: Record<ControlPlaneHealthState, number> = {
  ok: 0,
  slow: 1,
  large: 2,
  degraded: 3
};

export function emptyDispatchBackpressureState(
  retryDelayMs = DEFAULT_BACKPRESSURE_RETRY_DELAY_MS
): DispatchBackpressureState {
  return {
    active: false,
    reason_code: null,
    reason_detail: null,
    source: null,
    observed_at_ms: null,
    retry_delay_ms: retryDelayMs
  };
}

export function getBackpressureRetryDelayMs(config: OrchestratorOptions['config']): number {
  const configured = config.dispatch_backpressure?.retry_delay_ms;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.trunc(configured);
  }
  return DEFAULT_BACKPRESSURE_RETRY_DELAY_MS;
}

export function isBackpressureEnabled(config: OrchestratorOptions['config']): boolean {
  return config.dispatch_backpressure?.enabled !== false;
}

export function classifyControlPlaneEndpointLastHealth(
  endpoint: ControlPlaneEndpointHealth,
  summary: ControlPlaneHealthSummary
): ControlPlaneHealthState {
  if (endpoint.last_snapshot_error_code) {
    return 'degraded';
  }
  const duration = endpoint.last_duration_ms ?? 0;
  const payload = endpoint.last_payload_bytes ?? 0;
  if (duration >= summary.thresholds.degraded_ms || payload >= summary.thresholds.degraded_payload_bytes) {
    return 'degraded';
  }
  if (payload >= summary.thresholds.large_payload_bytes) {
    return 'large';
  }
  if (duration >= summary.thresholds.slow_ms) {
    return 'slow';
  }
  return 'ok';
}

export function evaluateControlPlaneBackpressure(params: {
  summary: ControlPlaneHealthSummary | null | undefined;
  config: OrchestratorOptions['config'];
  nowMs: number;
  retryDelayMs: number;
}): DispatchBackpressureState | null {
  const { summary, config, nowMs, retryDelayMs } = params;
  if (!summary || summary.endpoints.length === 0) {
    return null;
  }

  const staleAfterMs =
    config.dispatch_backpressure?.control_plane_stale_after_ms ?? DEFAULT_BACKPRESSURE_CONTROL_PLANE_STALE_AFTER_MS;
  const threshold = config.dispatch_backpressure?.control_plane_health ?? DEFAULT_BACKPRESSURE_CONTROL_PLANE_HEALTH;
  const thresholdRank = CONTROL_PLANE_HEALTH_RANK[threshold] ?? CONTROL_PLANE_HEALTH_RANK.degraded;

  let selected:
    | {
        endpoint: ControlPlaneEndpointHealth;
        health: ControlPlaneHealthState;
        observedAtMs: number;
      }
    | null = null;

  for (const endpoint of summary.endpoints) {
    if (!endpoint.last_observed_at) {
      continue;
    }
    const observedAtMs = Date.parse(endpoint.last_observed_at);
    if (!Number.isFinite(observedAtMs) || nowMs - observedAtMs > staleAfterMs) {
      continue;
    }
    const health = classifyControlPlaneEndpointLastHealth(endpoint, summary);
    if (CONTROL_PLANE_HEALTH_RANK[health] < thresholdRank) {
      continue;
    }
    if (!selected || CONTROL_PLANE_HEALTH_RANK[health] > CONTROL_PLANE_HEALTH_RANK[selected.health]) {
      selected = { endpoint, health, observedAtMs };
    }
  }

  if (!selected) {
    return null;
  }

  const reasonDetail = [
    `source=control_plane`,
    `endpoint=${selected.endpoint.endpoint}`,
    `transport=${selected.endpoint.transport}`,
    `health=${selected.health}`,
    `duration_ms=${selected.endpoint.last_duration_ms ?? 'unknown'}`,
    `payload_bytes=${selected.endpoint.last_payload_bytes ?? 'unknown'}`
  ].join(' ');

  return {
    active: true,
    reason_code: REASON_CODES.dispatchBackpressureControlPlane,
    reason_detail: reasonDetail,
    source: 'control_plane',
    observed_at_ms: selected.observedAtMs,
    retry_delay_ms: retryDelayMs
  };
}

export function evaluateHostLoadBackpressure(params: {
  config: OrchestratorOptions['config'];
  getHostLoad: (() => HostLoadSnapshot | null | undefined) | undefined;
  nowMs: () => number;
  retryDelayMs: number;
}): DispatchBackpressureState | null {
  const { config, getHostLoad, nowMs, retryDelayMs } = params;
  const threshold = config.dispatch_backpressure?.host_load_per_cpu;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) {
    return null;
  }

  const configuredLoad = getHostLoad?.();
  const load = configuredLoad ?? {
    load_average_1m: os.loadavg()[0] ?? 0,
    cpu_count: os.cpus().length
  };
  const cpuCount = Math.max(1, Math.trunc(load.cpu_count));
  const loadPerCpu = load.load_average_1m / cpuCount;
  if (!Number.isFinite(loadPerCpu) || loadPerCpu < threshold) {
    return null;
  }

  return {
    active: true,
    reason_code: REASON_CODES.dispatchBackpressureHostLoad,
    reason_detail: [
      `source=host_load`,
      `load_average_1m=${Math.round(load.load_average_1m * 100) / 100}`,
      `cpu_count=${cpuCount}`,
      `load_per_cpu=${Math.round(loadPerCpu * 100) / 100}`,
      `threshold_per_cpu=${threshold}`
    ].join(' '),
    source: 'host_load',
    observed_at_ms: nowMs(),
    retry_delay_ms: retryDelayMs
  };
}

export function evaluateDispatchBackpressure(params: {
  config: OrchestratorOptions['config'];
  runningCount: number;
  getControlPlaneHealth: (() => ControlPlaneHealthSummary | null | undefined) | undefined;
  getHostLoad: (() => HostLoadSnapshot | null | undefined) | undefined;
  nowMs: () => number;
}): DispatchBackpressureState {
  const { config, runningCount, getControlPlaneHealth, getHostLoad, nowMs } = params;
  const retryDelayMs = getBackpressureRetryDelayMs(config);
  const minRunningAgents = Math.max(
    0,
    Math.trunc(config.dispatch_backpressure?.min_running_agents ?? DEFAULT_BACKPRESSURE_MIN_RUNNING_AGENTS)
  );

  if (!isBackpressureEnabled(config) || runningCount < minRunningAgents) {
    return emptyDispatchBackpressureState(retryDelayMs);
  }

  const controlPlaneHealth = getControlPlaneHealth?.();
  const controlPlaneBackpressure =
    controlPlaneHealth && controlPlaneHealth.endpoints.length > 0
      ? evaluateControlPlaneBackpressure({
          summary: controlPlaneHealth,
          config,
          nowMs: nowMs(),
          retryDelayMs
        })
      : null;
  if (controlPlaneBackpressure) {
    return controlPlaneBackpressure;
  }

  const hostLoadBackpressure = evaluateHostLoadBackpressure({
    config,
    getHostLoad,
    nowMs,
    retryDelayMs
  });
  return hostLoadBackpressure ?? emptyDispatchBackpressureState(retryDelayMs);
}

export function buildRetryClearedContext(
  retryEntry: RetryEntry,
  params: {
    cleanup_reason: 'active_candidate_missing' | 'tracker_state_terminal' | 'tracker_state_non_active';
    observed_tracker_state: string | null;
  }
): {
  issue_id: string;
  issue_identifier: string;
  previous_retry_reason: string | null;
  retry_attempt: number;
  due_at_ms: number;
  observed_tracker_state: string | null;
  cleanup_reason: 'active_candidate_missing' | 'tracker_state_terminal' | 'tracker_state_non_active';
} {
  return {
    issue_id: retryEntry.issue_id,
    issue_identifier: retryEntry.identifier,
    previous_retry_reason: retryEntry.stop_reason_code ?? retryEntry.error,
    retry_attempt: retryEntry.attempt,
    due_at_ms: retryEntry.due_at_ms,
    observed_tracker_state: params.observed_tracker_state,
    cleanup_reason: params.cleanup_reason
  };
}

export function buildRetryClearedDetail(
  retryEntry: RetryEntry,
  context: ReturnType<typeof buildRetryClearedContext>
): string {
  return (
    `cleanup_reason=${context.cleanup_reason} previous_retry_reason=${context.previous_retry_reason ?? 'unknown'} ` +
    `retry_attempt=${retryEntry.attempt} due_at_ms=${retryEntry.due_at_ms} ` +
    `observed_tracker_state=${context.observed_tracker_state ?? 'unknown'}`
  );
}

export function evaluateRedispatchGate(params: {
  issue_id: string;
  retryEntry: RetryEntry;
  issue: Issue;
  config: OrchestratorOptions['config'];
  progressMap: Map<string, RedispatchProgressSample[]>;
  nowMs: number;
}): {
  allow_redispatch: boolean;
  awaiting_human_review_scope_incomplete: boolean;
  breaker_hit: boolean;
  attempt_count_window: number;
  window_minutes: number;
  last_known_commit_sha: string | null;
  last_progress_checkpoint_at: number | null;
  progress_signals: ProgressSignals;
  progress_signal_reasons: string[];
} {
  const { issue_id, retryEntry, issue, config, progressMap, nowMs } = params;
  const windowMinutes = Math.max(1, config.respawn_window_minutes ?? 30);
  const windowMs = windowMinutes * 60_000;
  const startedState = retryEntry.progress_signals?.tracker_started_state ?? null;
  const trackerStatusTransition =
    retryEntry.progress_signals?.tracker_status_transition ??
    (retryEntry.progress_signals?.tracker_comment_created &&
    startedState &&
    isKnownReviewHandoffTransition({ startedState, currentState: issue.state, config })
      ? `${startedState} -> ${issue.state}`
      : null);
  const agentReviewHandoff =
    retryEntry.progress_signals?.agent_review_handoff ??
    (trackerStatusTransition && isKnownReviewHandoffTransition({ startedState, currentState: issue.state, config })
      ? issue.state
      : null);
  const currentSignals = {
    commit_sha: retryEntry.progress_signals?.commit_sha ?? null,
    checklist_checkpoint: retryEntry.progress_signals?.checklist_checkpoint ?? null,
    state_marker: retryEntry.progress_signals?.state_marker ?? null,
    tracker_comment_created: retryEntry.progress_signals?.tracker_comment_created ?? false,
    tracker_status_transition: trackerStatusTransition,
    agent_review_handoff: agentReviewHandoff,
    tracker_started_state: startedState
  };
  const existing = progressMap.get(issue_id) ?? [];
  const sample = {
    at_ms: nowMs,
    commit_sha: currentSignals.commit_sha,
    checklist_checkpoint: currentSignals.checklist_checkpoint,
    state_marker: currentSignals.state_marker,
    pr_open: hasOpenPullRequest(issue),
    tracker_comment_created: currentSignals.tracker_comment_created,
    tracker_status_transition: currentSignals.tracker_status_transition,
    agent_review_handoff: currentSignals.agent_review_handoff
  };
  const kept = existing.filter((entry) => nowMs - entry.at_ms <= windowMs);
  const updated = [...kept, sample];
  progressMap.set(issue_id, updated);
  const first = updated[0] ?? sample;
  const noProgress =
    first.commit_sha === sample.commit_sha &&
    first.checklist_checkpoint === sample.checklist_checkpoint &&
    first.state_marker === sample.state_marker;
  const progressSignalReasons = classifyProgressSignals(currentSignals);
  const hasExternalProgress = progressSignalReasons.length > 0;
  const attemptCountWindow = updated.length;
  const breakerHit = noProgress && !hasExternalProgress && attemptCountWindow >= Math.max(1, config.respawn_max_attempts_without_progress ?? 3);
  const awaitingHuman = Boolean(sample.pr_open && noProgress && !hasExternalProgress);
  return {
    allow_redispatch: !awaitingHuman && !breakerHit,
    awaiting_human_review_scope_incomplete: awaitingHuman,
    breaker_hit: breakerHit,
    attempt_count_window: attemptCountWindow,
    window_minutes: windowMinutes,
    last_known_commit_sha: sample.commit_sha,
    last_progress_checkpoint_at: noProgress && !hasExternalProgress ? retryEntry.last_progress_checkpoint_at ?? null : sample.at_ms,
    progress_signals: currentSignals,
    progress_signal_reasons: progressSignalReasons
  };
}

export function classifyProgressSignals(signals: ProgressSignals): string[] {
  const reasons: string[] = [];
  if (signals.tracker_comment_created) {
    reasons.push('tracker_comment_created');
  }
  if (signals.tracker_comment_created && signals.tracker_status_transition) {
    reasons.push('tracker_status_transition');
  }
  if (signals.tracker_comment_created && signals.tracker_status_transition && signals.agent_review_handoff) {
    reasons.push('agent_review_handoff');
  }
  return reasons;
}

export function isKnownReviewHandoffTransition(params: {
  startedState: string | null | undefined;
  currentState: string;
  config: OrchestratorOptions['config'];
}): boolean {
  const { startedState, currentState, config } = params;
  if (!startedState || normalizeStateName(startedState) !== normalizeStateName('Agent Review')) {
    return false;
  }
  if (normalizeStateName(currentState) === normalizeStateName(startedState)) {
    return false;
  }
  return (
    normalizeStateName(currentState) === normalizeStateName('In Progress') ||
    normalizeStateName(currentState) === normalizeStateName('Human Review') ||
    normalizeStateName(currentState) === normalizeStateName('Merging') ||
    isActiveState(currentState, config) ||
    isTerminalState(currentState, config)
  );
}

export function hasOpenPullRequest(issue: Issue): boolean {
  const links = issue.tracker_meta?.pr_links ?? [];
  return links.some((link) => !link.merged && String(link.state).toLowerCase() === 'open');
}

export function isFreshDispatchState(issueState: string, config: OrchestratorOptions['config']): boolean {
  const normalizedState = normalizeStateName(issueState);
  return (config.fresh_dispatch_states ?? []).some((state) => normalizeStateName(state) === normalizedState);
}

export function isHandoffFreshDispatchState(issueState: string, config: OrchestratorOptions['config']): boolean {
  const normalizedState = normalizeStateName(issueState);
  const freshDispatch = (config.fresh_dispatch_states ?? []).some((state) => normalizeStateName(state) === normalizedState);
  if (!freshDispatch) {
    return false;
  }

  const handoffStates = config.handoff_states ?? [];
  if (handoffStates.length === 0) {
    return true;
  }

  return handoffStates.some((state) => normalizeStateName(state) === normalizedState);
}

export function isHandoffState(issueState: string, config: OrchestratorOptions['config']): boolean {
  const normalizedState = normalizeStateName(issueState);
  return (config.handoff_states ?? []).some((state) => normalizeStateName(state) === normalizedState);
}

export function normalizeStateName(state: string): string {
  return state.trim().toLowerCase();
}
