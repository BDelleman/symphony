import type { Issue } from '../../tracker';
import type { StructuredLogger } from '../../observability';
import { CANONICAL_EVENT } from '../../observability/events';
import { REASON_CODES } from '../../observability/reason-codes';
import { availableGlobalSlots, nextAttempt, shouldDispatchIssue, sortCandidatesForDispatch } from '../decisions';
import type {
  BudgetRuntimeProjection,
  DispatchBackpressureState,
  MissingToolOutputRecoveryState,
  OrchestratorOptions,
  OrchestratorState,
  ProgressSignals,
  RetryDelayType,
  RunningEntry,
  TickReason
} from '../types';
import { emptyDispatchBackpressureState, evaluateDispatchBackpressure, getBackpressureRetryDelayMs } from './retry-backpressure';
import type { DispatchGraphContext } from './execution-graph-persistence';
import { rememberInactiveWorkerLineage } from './worker-events';

const DEFAULT_INACTIVE_WORKER_PID_TTL_MS = 60 * 60 * 1000;

export interface DispatchCoordinatorScheduleRetryParams {
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

export interface DispatchCoordinatorHooks {
  reconcileRunningIssues: () => Promise<void>;
  reconcileBlockedInputs: () => Promise<void>;
  recordDuplicateDispatchSkipped: (issue: Issue, retryAttempt: number) => void;
  delayDispatchForBackpressure: (
    issue: Issue,
    attempt: number | null,
    backpressure: DispatchBackpressureState
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
  refreshQuiescenceState?: (pendingIssues?: Issue[]) => void;
  selectWorkerHost: () => string | null;
  persistPreSpawnExecutionGraphAttempt: (params: {
    issue: Issue;
    attempt: number | null;
    graphContext: DispatchGraphContext;
    status: 'failed' | 'blocked';
    reasonCode: string;
    reasonDetail: string | null;
  }) => Promise<DispatchGraphContext>;
  scheduleRetry: (params: DispatchCoordinatorScheduleRetryParams) => Promise<void>;
  workerInstanceIdFromHandle: (workerHandle: unknown) => string | null;
  computeBudgetProjection: (
    issueId: string,
    currentAttemptTokens: number,
    telemetryStatus: 'available' | 'pending' | 'unavailable',
    forcedStatus?: BudgetRuntimeProjection['budget_status'],
    forcedMessage?: string | null
  ) => BudgetRuntimeProjection;
  persistOperationalFactsForIssue: (issue: Issue, runningEntry: RunningEntry, observedAt: string) => Promise<void>;
  recordHistoryWriteFailure: (operation: string, reasonCode: string, error: unknown) => Promise<void>;
}

export interface DispatchCoordinatorContext {
  readonly state: OrchestratorState;
  readonly config: OrchestratorOptions['config'];
  readonly tracker: Pick<OrchestratorOptions['ports']['tracker'], 'fetch_candidate_issues'>;
  readonly dispatchPreflight: OrchestratorOptions['ports']['dispatchPreflight'];
  readonly spawnWorker: OrchestratorOptions['ports']['spawnWorker'];
  readonly cancelRetryTimer: OrchestratorOptions['ports']['cancelRetryTimer'];
  readonly notifyObservers?: OrchestratorOptions['ports']['notifyObservers'];
  readonly getControlPlaneHealth?: OrchestratorOptions['ports']['getControlPlaneHealth'];
  readonly getHostLoad?: OrchestratorOptions['ports']['getHostLoad'];
  readonly persistence: OrchestratorOptions['persistence'] | undefined;
  readonly logger: StructuredLogger | undefined;
  readonly nowMs: () => number;
  readonly hooks: DispatchCoordinatorHooks;
}

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

export async function coordinateDispatchTick(context: DispatchCoordinatorContext, reason: TickReason): Promise<void> {
  const { state } = context;

  await context.hooks.reconcileRunningIssues();
  await context.hooks.reconcileBlockedInputs();

  const previousDispatchValidation = state.health.dispatch_validation;
  const preflight = context.dispatchPreflight();
  if (!preflight.dispatch_allowed) {
    state.health.dispatch_validation = 'failed';
    state.health.last_error = preflight.reason ?? 'dispatch preflight rejected dispatch';
    context.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.dispatchValidationFailed,
      message: state.health.last_error,
      context: {
        reason: state.health.last_error,
        tick_reason: reason
      }
    });
    context.hooks.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.dispatchValidationFailed,
      severity: 'warn',
      detail: state.health.last_error ?? undefined
    });
    context.notifyObservers?.();
    return;
  }

  state.health.dispatch_validation = 'ok';
  if (previousDispatchValidation === 'failed') {
    context.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.dispatchValidationRecovered,
      message: 'dispatch validation recovered',
      context: {
        tick_reason: reason
      }
    });
    context.hooks.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.dispatchValidationRecovered,
      severity: 'info'
    });
  }
  state.health.last_error = null;
  state.health.dispatch_backpressure = emptyDispatchBackpressureState(getBackpressureRetryDelayMs(context.config));

  let candidates: Issue[];
  try {
    candidates = await context.tracker.fetch_candidate_issues();
  } catch (error) {
    state.health.last_error = 'failed to fetch candidate issues';
    context.logger?.log({
      level: 'error',
      event: CANONICAL_EVENT.tracker.candidateFetchFailed,
      message: 'failed to fetch candidate issues',
      context: {
        tick_reason: reason,
        error: error instanceof Error ? error.message : 'unknown'
      }
    });
    context.hooks.recordRuntimeEvent({
      event: CANONICAL_EVENT.tracker.candidateFetchFailed,
      severity: 'error',
      detail: error instanceof Error ? error.message : 'unknown'
    });
    context.notifyObservers?.();
    return;
  }

  const sortedCandidates = sortCandidatesForDispatch(candidates);
  context.hooks.refreshQuiescenceState?.(sortedCandidates);
  const runtimeIdentityBlocker =
    state.runtime_identity?.status === 'stale' || state.runtime_identity?.status === 'unknown_current'
      ? state.runtime_identity.health_warning?.message
      : null;
  const runtimeIdentityReasonCode =
    state.runtime_identity?.status === 'stale'
      ? 'stale_runtime_build'
      : state.runtime_identity?.status === 'unknown_current'
        ? 'unknown_current_build_identity'
        : null;
  if (state.drain_mode.active || runtimeIdentityBlocker) {
    context.hooks.recordRuntimeEvent({
      event: CANONICAL_EVENT.runtime.drainDispatchSkipped,
      severity: 'info',
      detail: runtimeIdentityBlocker ?? `dispatch skipped during drain mode: ${reason}`,
      reason_code: runtimeIdentityReasonCode
    });
    context.hooks.refreshQuiescenceState?.(sortedCandidates);
    context.notifyObservers?.();
    return;
  }

  const githubLinkingMode = context.config.github_linking_mode ?? 'off';
  let missingGithubLinkCount = 0;

  for (const issue of sortedCandidates) {
    if (availableGlobalSlots(state) <= 0) {
      break;
    }

    if (state.blocked_inputs.has(issue.id)) {
      continue;
    }

    if (state.circuit_breakers.get(issue.id)?.breaker_active) {
      continue;
    }

    const eligibility = shouldDispatchIssue(issue, state, context.config);
    if (!eligibility.eligible) {
      if (eligibility.reason === 'already_running' || eligibility.reason === 'already_claimed') {
        context.hooks.recordDuplicateDispatchSkipped(issue, 0);
      }
      continue;
    }

    if (githubLinkingMode !== 'off' && issue.has_github_issue_link !== true) {
      missingGithubLinkCount += 1;
      context.logger?.log({
        level: githubLinkingMode === 'required' ? 'warn' : 'info',
        event: CANONICAL_EVENT.tracker.githubIssueLinkMissing,
        message:
          githubLinkingMode === 'required'
            ? `issue ${issue.identifier} is missing a linked GitHub issue; dispatch skipped`
            : `issue ${issue.identifier} is missing a linked GitHub issue`,
        context: {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          github_linking_mode: githubLinkingMode
        }
      });
      context.hooks.recordRuntimeEvent({
        event: CANONICAL_EVENT.tracker.githubIssueLinkMissing,
        severity: githubLinkingMode === 'required' ? 'warn' : 'info',
        issue_identifier: issue.identifier,
        detail: githubLinkingMode === 'required' ? 'missing_link_required_dispatch_skipped' : 'missing_link_warning_only'
      });
      if (githubLinkingMode === 'required') {
        continue;
      }
    }

    const backpressure = evaluateDispatchBackpressure({
      config: context.config,
      runningCount: state.running.size,
      getControlPlaneHealth: () => context.getControlPlaneHealth?.(),
      getHostLoad: () => context.getHostLoad?.(),
      nowMs: context.nowMs
    });
    if (backpressure.active) {
      await context.hooks.delayDispatchForBackpressure(issue, null, backpressure);
      break;
    }

    await coordinateDispatchIssue(context, issue, null);
  }

  if (githubLinkingMode === 'required' && missingGithubLinkCount > 0) {
    state.health.last_error = `${missingGithubLinkCount} candidate issue(s) missing linked GitHub issue`;
  }

  context.notifyObservers?.();
}

export async function coordinateDispatchIssue(
  context: DispatchCoordinatorContext,
  issue: Issue,
  attempt: number | null,
  resume_context: string | null = null,
  graphContext: DispatchGraphContext = {}
): Promise<void> {
  const { state } = context;

  if (state.running.has(issue.id) || state.claimed.has(issue.id)) {
    context.hooks.recordDuplicateDispatchSkipped(issue, attempt ?? 0);
    return;
  }

  state.claimed.add(issue.id);
  if (attempt === null || attempt === 0) {
    state.completed.delete(issue.id);
    state.phase_timeline?.set(issue.id, []);
  }
  context.hooks.emitPhaseMarker(issue.id, {
    phase: REASON_CODES.dispatchStarted,
    detail: 'dispatch attempt started',
    attempt: attempt ?? 0
  });
  context.logger?.log({
    level: 'info',
    event: CANONICAL_EVENT.orchestration.dispatchAttemptStarted,
    message: 'dispatch attempt started',
    context: {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      retry_attempt: attempt ?? 0
    }
  });
  const workerHost = context.hooks.selectWorkerHost();
  if ((context.config.worker_hosts?.length ?? 0) > 0 && !workerHost) {
    context.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.workerHostSlotsExhausted,
      message: 'dispatch blocked: no available worker host slots',
      context: {
        issue_id: issue.id,
        issue_identifier: issue.identifier
      }
    });
    context.hooks.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.workerHostSlotsExhausted,
      severity: 'warn',
      issue_identifier: issue.identifier,
      detail: 'no available worker host slots'
    });
    const retryGraphContext = await context.hooks.persistPreSpawnExecutionGraphAttempt({
      issue,
      attempt,
      graphContext,
      status: 'blocked',
      reasonCode: REASON_CODES.slotsExhausted,
      reasonDetail: 'no available worker host slots'
    });
    await context.hooks.scheduleRetry({
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt: nextAttempt(attempt),
      issue_run_id: retryGraphContext.issue_run_id ?? null,
      previous_attempt_id: retryGraphContext.previous_attempt_id ?? null,
      delay_type: 'failure',
      error: 'no available worker host slots',
      worker_host: workerHost,
      workspace_path: null,
      provisioner_type: null,
      branch_name: null,
      repo_root: null,
      workspace_exists: false,
      workspace_git_status: null,
      workspace_provisioned: false,
      workspace_is_git_worktree: false,
      copy_ignored_applied: false,
      copy_ignored_status: null,
      copy_ignored_summary: null,
      stop_reason_code: REASON_CODES.slotsExhausted,
      stop_reason_detail: 'no available worker host slots',
      issue_snapshot: issue
    });
    return;
  }

  const spawned = await context.spawnWorker({
    issue,
    attempt,
    worker_host: workerHost,
    resume_context,
    recover_workspace_attempt_residue: graphContext.recover_workspace_attempt_residue ?? false
  });

  if (!spawned.ok) {
    context.hooks.emitPhaseMarker(issue.id, {
      phase: 'failed',
      detail: spawned.error,
      attempt: attempt ?? 0
    });
    state.health.last_error = `failed to spawn agent for ${issue.identifier}`;
    context.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.dispatchSpawnFailed,
      message: 'dispatch failed; retrying',
      context: {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        retry_attempt: nextAttempt(attempt),
        error: spawned.error
      }
    });
    const retryGraphContext = await context.hooks.persistPreSpawnExecutionGraphAttempt({
      issue,
      attempt,
      graphContext,
      status: 'failed',
      reasonCode: REASON_CODES.spawnFailed,
      reasonDetail: spawned.error
    });
    await context.hooks.scheduleRetry({
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt: nextAttempt(attempt),
      issue_run_id: retryGraphContext.issue_run_id ?? null,
      previous_attempt_id: retryGraphContext.previous_attempt_id ?? null,
      delay_type: 'failure',
      error: 'failed to spawn agent',
      worker_host: workerHost,
      workspace_path: null,
      provisioner_type: null,
      branch_name: null,
      repo_root: null,
      workspace_exists: false,
      workspace_git_status: null,
      workspace_provisioned: false,
      workspace_is_git_worktree: false,
      copy_ignored_applied: false,
      copy_ignored_status: null,
      copy_ignored_summary: null,
      stop_reason_code: REASON_CODES.spawnFailed,
      stop_reason_detail: spawned.error,
      issue_snapshot: issue
    });
    return;
  }
  context.logger?.log({
    level: 'info',
    event: CANONICAL_EVENT.orchestration.dispatchSpawnSucceeded,
    message: 'dispatch spawn succeeded',
    context: {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      worker_host: spawned.worker_host ?? workerHost ?? null
    }
  });

  const startedAtMs = context.nowMs();
  state.running.set(issue.id, {
    issue,
    identifier: issue.identifier,
    dispatch_state: issue.state,
    started_issue_state: issue.state,
    run_id: null,
    issue_run_id: graphContext.issue_run_id ?? null,
    attempt_id: null,
    worker_handle: spawned.worker_handle,
    worker_instance_id: spawned.worker_instance_id ?? context.hooks.workerInstanceIdFromHandle(spawned.worker_handle),
    monitor_handle: spawned.monitor_handle,
    retry_attempt: attempt ?? 0,
    workspace_path: spawned.workspace_path ?? null,
    worker_host: spawned.worker_host ?? workerHost ?? null,
    provisioner_type: spawned.provisioner_type ?? null,
    branch_name: spawned.branch_name ?? null,
    repo_root: spawned.repo_root ?? null,
    workspace_exists: spawned.workspace_exists ?? false,
    workspace_git_status: spawned.workspace_git_status ?? null,
    workspace_provisioned: spawned.workspace_provisioned ?? false,
    workspace_is_git_worktree: spawned.workspace_is_git_worktree ?? false,
    copy_ignored_applied: spawned.copy_ignored_applied ?? false,
    copy_ignored_status: spawned.copy_ignored_status ?? null,
    copy_ignored_summary: spawned.copy_ignored_summary ?? null,
    session_id: null,
    thread_id: null,
    turn_id: null,
    persisted_thread_id: null,
    persisted_turn_ids: [],
    codex_app_server_pid: null,
    agent_runtime: null,
    worker_process_pid: null,
    last_process_liveness_at_ms: null,
    turn_count: 0,
    last_event: null,
    last_event_summary: null,
    last_message: null,
    awaiting_input_since_ms: null,
    pending_input_preview: null,
    stalled_waiting_since_ms: null,
    stalled_waiting_reason: null,
    running_waiting_started_at_ms: null,
    last_progress_transition_at_ms: startedAtMs,
    last_heartbeat_at_ms: null,
    heartbeat_only_event_emitted: false,
    running_wait_stall_event_emitted: false,
    tokens: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0
    },
    last_reported_tokens: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0
    },
    token_telemetry_status: 'unavailable',
    token_telemetry_last_source: null,
    token_telemetry_last_at_ms: null,
    token_telemetry_turn_started_at_ms: null,
    token_telemetry_warning_emitted: false,
    rate_limits: null,
    protocol_warnings: [],
    model_reroute: null,
    requested_model: null,
    effective_model: null,
    budget_warning_emitted: false,
    budget_hard_limit_enforced: false,
    budget: context.hooks.computeBudgetProjection(issue.id, 0, 'unavailable'),
    recent_events: [],
    quarantined_events: [],
    quarantined_event_count: 0,
    last_quarantined_event_at_ms: null,
    ownership_conflict: null,
    started_at_ms: startedAtMs,
    last_codex_timestamp_ms: null,
    codex_thread_activity_at_ms: null,
    codex_thread_activity_source: null,
    codex_thread_activity_status: null,
    current_phase: null,
    current_phase_at_ms: null,
    phase_detail: null,
    tool_call_ledger: {},
    outstanding_tool_calls: {},
    transcript_tool_call_diagnostics: [],
    codex_session_transcript_scan_offsets: {},
    recovery: null,
    termination: null
  });
  context.hooks.emitPhaseMarker(issue.id, {
    phase: 'workspace_ready',
    detail: 'workspace ready and worker spawned',
    attempt: attempt ?? 0
  });

  const runningEntry = state.running.get(issue.id);
  if (runningEntry && graphContext.recover_workspace_attempt_residue) {
    rememberInactiveWorkerLineage({
      state,
      issueId: issue.id,
      reason: REASON_CODES.workspaceAttemptResidueRecovered,
      nowMs: startedAtMs,
      ttlMs: context.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS,
      thread_id: graphContext.previous_thread_id ?? null,
      turn_id: graphContext.previous_turn_id ?? null,
      session_id: graphContext.previous_session_id ?? null
    });
  }
  if (runningEntry && context.persistence) {
    try {
      const startedAt = asIso(runningEntry.started_at_ms);
      if (!graphContext.issue_run_id && context.persistence.recordRunStarted) {
        const started = await context.persistence.recordRunStarted({
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          started_at: startedAt,
          status: 'running',
          reason_code: REASON_CODES.dispatchStarted,
          reason_detail: 'dispatch attempt started',
          attempt_number: runningEntry.retry_attempt
        });
        runningEntry.run_id = started.run_id;
        runningEntry.issue_run_id = started.issue_run_id;
        runningEntry.attempt_id = started.attempt_id;
      } else {
        runningEntry.run_id = await context.persistence.startRun({
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          issue_run_id: graphContext.issue_run_id ?? null
        });
        runningEntry.issue_run_id =
          graphContext.issue_run_id ??
          (await context.persistence.appendIssueRun?.({
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            started_at: startedAt,
            status: 'running',
            reason_code: REASON_CODES.dispatchStarted,
            reason_detail: 'dispatch attempt started'
          })) ??
          null;
        if (runningEntry.issue_run_id) {
          runningEntry.attempt_id =
            (await context.persistence.appendAttempt?.({
              issue_run_id: runningEntry.issue_run_id,
              attempt_number: runningEntry.retry_attempt,
              started_at: startedAt,
              status: 'running',
              reason_code: REASON_CODES.attemptStarted,
              reason_detail: 'worker spawned'
            })) ?? null;
          await context.persistence.appendStateTransition?.({
            issue_run_id: runningEntry.issue_run_id,
            attempt_id: runningEntry.attempt_id,
            from_status: null,
            to_status: 'running',
            transitioned_at: startedAt,
            status: 'running',
            reason_code: REASON_CODES.dispatchStarted,
            reason_detail: 'dispatch attempt started'
          });
        }
      }
      await context.hooks.persistOperationalFactsForIssue(issue, runningEntry, startedAt);
    } catch (error) {
      await context.hooks.recordHistoryWriteFailure('recordRunStarted', REASON_CODES.dispatchStarted, error);
      context.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.persistence.startRunFailed,
        message: `failed to start durable run record for ${issue.identifier}`,
        context: {
          issue_id: issue.id,
          issue_identifier: issue.identifier
        }
      });
    }
  }
  const existingRetry = state.retry_attempts.get(issue.id);
  if (existingRetry) {
    context.cancelRetryTimer(existingRetry.timer_handle);
    state.retry_attempts.delete(issue.id);
  }
}
