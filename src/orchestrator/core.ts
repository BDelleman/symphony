import type { Issue, TrackerAdapter } from '../tracker';
import type { PersistenceHealth } from '../persistence';
import type { StructuredLogger } from '../observability';
import { CANONICAL_EVENT } from '../observability/events';
import { REASON_CODES } from '../observability/reason-codes';
import {
  buildOperatorInputResumeContext as coordinateBuildOperatorInputResumeContext,
  cancelBlockedIssue as coordinateCancelBlockedIssue,
  clearBlockedInput as coordinateClearBlockedInput,
  persistBlockedInputEvent as coordinatePersistBlockedInputEvent,
  persistTicketBlocker as coordinatePersistTicketBlocker,
  resolveBacklogStateName as coordinateResolveBacklogStateName,
  resumeBlockedIssue as coordinateResumeBlockedIssue,
  scheduleBlockedInput as coordinateScheduleBlockedInput,
  submitBlockedIssueInput as coordinateSubmitBlockedIssueInput,
  submitBlockedIssueInputNative as coordinateSubmitBlockedIssueInputNative,
  ticketBlockerTypeForBlockedEntry as coordinateTicketBlockerTypeForBlockedEntry,
  type BlockedInputCoordinatorContext,
  type BlockedInputScheduleParams,
  type SubmitBlockedIssueInputNativeResult
} from './core/blocked-input-coordinator';
import { coordinateDispatchIssue, coordinateDispatchTick, type DispatchCoordinatorContext } from './core/dispatch-coordinator';
import {
  coordinateFindMissingToolOutputCandidate,
  coordinateHasOutstandingToolCallEvidence,
  coordinateRecoverOrBlockMissingToolOutput,
  coordinateScanCodexSessionTranscriptForToolCalls,
  type MissingToolOutputCoordinatorContext
} from './core/missing-tool-output-coordinator';
import {
  coordinateCaptureWorkerProgressSignal,
  coordinateIsMeaningfulWorkerProgressEvent,
  coordinateMarkRunningWaitStallRootCauseIfThresholdExceeded,
  coordinateMaybeClassifyRunningWaitStall,
  coordinateMaybeEmitHeartbeatOnly,
  coordinateResetRunningWaitEpisode,
  type RunningWaitCoordinatorContext
} from './core/running-wait-coordinator';
import {
  coordinateCancelCurrentTurn,
  coordinateCaptureProgressSignals,
  coordinateRequeueIssue,
  coordinateRetryLastFailedStep,
  describeIssueRuntimeState as coordinateDescribeIssueRuntimeState,
  recordOperatorAction as coordinateRecordOperatorAction,
  targetIdentifiersFromRuntimeState as coordinateTargetIdentifiersFromRuntimeState,
  type OperatorControlCoordinatorContext
} from './core/operator-control-coordinator';
import {
  addRuntimeSecondsFromEntry as coordinateAddRuntimeSecondsFromEntry,
  completeRunRecord as coordinateCompleteRunRecord,
  successfulWorkflowTerminationProjection,
  terminateRunningIssue as coordinateTerminateRunningIssue,
  type RunCompletionCoordinatorContext,
  workerTerminationAllowsRecovery as coordinateWorkerTerminationAllowsRecovery,
  workerTerminationInterruptStatus as coordinateWorkerTerminationInterruptStatus
} from './core/run-completion-coordinator';
import { coordinateRetryTimer, type RetryTimerCoordinatorContext } from './core/retry-timer-coordinator';
import {
  coordinateReconcileBlockedInputs,
  coordinateReconcileRunningIssues,
  type ReconciliationCoordinatorContext
} from './core/reconciliation-coordinator';
import { coordinateWorkerExit, type WorkerExitCoordinatorContext } from './core/worker-exit-coordinator';
import { parseDynamicToolCapabilityMismatchDetail } from '../observability/dynamic-tool-capability';
import { isKnownPhaseMarker, isTerminalPhaseMarker, phaseMarkerOrder, type PhaseMarker, type PhaseMarkerName } from '../observability';
import { ThroughputTracker } from '../observability/throughput';
import { computeFailureBackoffMs, shouldDispatchIssue } from './decisions';
import {
  applyBudgetBlockedTerminationEvidence,
  applyBudgetTelemetryUnavailable,
  computeIssueBudgetProjection,
  defaultBudgetProjection,
  evaluateBudgetEnforcement,
  recordIssueBudgetUsageSample,
  updateRunningBudgetProjection,
  type BudgetHardLimitDecision,
  type BudgetUsageSample
} from './core/budget';
import {
  cloneBlockedEntry,
  cloneCircuitBreakerEntry,
  cloneDispatchBackpressureState,
  cloneOperatorAction,
  cloneReleasedWorkerRecord,
  cloneRetryEntry,
  cloneRunningEntry
} from './core/snapshot-cloning';
import {
  beginExecutionGraphWorkerTurnObservation,
  persistExecutionGraphRetryTransition as persistExecutionGraphRetryTransitionHelper,
  persistExecutionGraphStateTransition as persistExecutionGraphStateTransitionHelper,
  persistOperationalFactsForIssue as persistOperationalFactsForIssueHelper,
  persistTicketEvidenceReferenceForThread as persistTicketEvidenceReferenceForThreadHelper,
  persistPreSpawnExecutionGraphAttempt as persistPreSpawnExecutionGraphAttemptHelper,
  queuePersistExecutionGraphWorkerEvent as queuePersistExecutionGraphWorkerEventHelper,
  recordHistoryWriteFailure as recordHistoryWriteFailureHelper,
  type DispatchGraphContext
} from './core/execution-graph-persistence';
import {
  applyBlockedWorkerEventQuarantine,
  buildRecoveryStartFailedBlockDetails,
  workerTerminationExceptionResult,
  workerTerminationResultDetail
} from './core/blocked-input-recovery';
import {
  applyWorkerEvent,
  isTerminalTurnEvent,
  normalizeCodexAppServerPid,
  normalizeWorkerInstanceId,
  rememberInactiveWorkerPid,
  rememberReleasedWorker,
  shouldResetRunningWaitEpisode
} from './core/worker-events';
import {
  emptyDispatchBackpressureState,
  getBackpressureRetryDelayMs,
} from './core/retry-backpressure';
import type {
  BlockedEntry,
  BudgetRuntimeProjection,
  CircuitBreakerEntry,
  DispatchBackpressureState,
  DrainModeState,
  DrainQuiescenceBlocker,
  DrainQuiescenceBlockerCounts,
  DrainQuiescenceRestartGuidance,
  DrainQuiescenceState,
  DrainQuiescenceWarning,
  MissingToolOutputRecoveryState,
  OperatorActionRecord,
  OrchestratorOptions,
  OrchestratorState,
  PhaseMarkerSettings,
  ProgressSignals,
  RedispatchProgressSample,
  RetryDelayType,
  RetryEntry,
  RunningEntry,
  ReleasedWorkerRecord,
  StateSnapshotOptions,
  TickReason,
  ToolCallLedgerEntry,
  ToolCallLedgerObservation,
  QuarantinedWorkerEventReason,
  WorkerCompletionReason,
  WorkerExitDetails,
  WorkerObservabilityEvent,
  WorkerExitReason,
  WorkerTerminationResult
} from './types';

const DEFAULT_INACTIVE_WORKER_PID_TTL_MS = 60 * 60 * 1000;

const emptyDrainModeState = (): DrainModeState => ({
  active: false,
  entered_at_ms: null,
  updated_at_ms: null,
  reason: null
});

const emptyDrainBlockerCounts = (): DrainQuiescenceBlockerCounts => ({
  active_worker: 0,
  live_codex_app_server_process: 0,
  pending_retry: 0,
  in_flight_tracker_write: 0,
  persistence_history_write: 0,
  unknown_degraded_blocker_source_health: 0,
  stale_runtime: 0,
  unknown_current_build_identity: 0
});

const emptyQuiescenceState = (updatedAtMs: number): DrainQuiescenceState => ({
  safe_to_shutdown: true,
  state: 'safe',
  updated_at_ms: updatedAtMs,
  blockers: [],
  blocker_counts: emptyDrainBlockerCounts(),
  warnings: [],
  restart_guidance: {
    safe_to_restart: true,
    recommended_action: 'none',
    pending_work: [],
    detail: 'Runtime is safe to restart.'
  }
});

interface ScheduleRetryParams {
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

interface WorkspaceConflictContext {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readTimestampMs(value: Record<string, unknown> | null): number | null {
  if (!value) {
    return null;
  }
  for (const key of ['timestamp_ms', 'timestampMs', 'created_at_ms', 'createdAtMs', 'at_ms', 'atMs']) {
    const numeric = value[key];
    if (typeof numeric === 'number' && Number.isFinite(numeric)) {
      return numeric;
    }
  }
  for (const key of ['timestamp', 'created_at', 'createdAt', 'time']) {
    const text = readString(value[key]);
    if (!text) {
      continue;
    }
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export class OrchestratorCore {
  private readonly config: OrchestratorOptions['config'];
  private readonly ports: OrchestratorOptions['ports'];
  private readonly nowMs: () => number;
  private readonly logger?: StructuredLogger;
  private readonly persistence?: OrchestratorOptions['persistence'];
  private readonly phaseSettings: PhaseMarkerSettings;
  private readonly throughputTracker: ThroughputTracker;
  private readonly tracker: TrackerAdapter;

  private readonly state: OrchestratorState;
  private readonly executionGraphPersistenceQueues = new WeakMap<RunningEntry, Promise<void>>();
  private readonly persistedPhaseSpanKeys = new WeakMap<RunningEntry, Set<string>>();
  private hostRoundRobinIndex: number;
  private serializedOperation: Promise<void>;
  private inFlightTrackerWrites = 0;
  private pendingExecutionGraphPersistenceWrites = 0;
  private lastQuiescencePendingIssues: Issue[] = [];

  constructor(options: OrchestratorOptions) {
    this.config = options.config;
    this.config.no_telemetry_warning_threshold_ms = this.config.no_telemetry_warning_threshold_ms ?? 120_000;
    this.config.progress_heartbeat_only_warn_ms = this.config.progress_heartbeat_only_warn_ms ?? 120_000;
    this.config.progress_stalled_waiting_ms = this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000;
    this.config.running_wait_stall_threshold_ms = this.config.progress_stalled_waiting_ms;
    this.config.worker_opaque_activity_hard_timeout_ms = this.config.worker_opaque_activity_hard_timeout_ms ?? 1_800_000;
    this.config.inactive_worker_pid_ttl_ms = this.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS;
    this.ports = options.ports;
    this.tracker = this.createTrackedTracker(options.ports.tracker);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.logger = options.logger;
    this.persistence = options.persistence;
    this.phaseSettings = {
      enabled: options.config.phase_markers_enabled !== false,
      timeline_limit: Math.max(1, options.config.phase_timeline_limit ?? 30),
      last_emit_error_code: null
    };

    this.state = {
      poll_interval_ms: this.config.poll_interval_ms,
      max_concurrent_agents: this.config.max_concurrent_agents,
      running: new Map(),
      claimed: new Set(),
      retry_attempts: new Map(),
      blocked_inputs: new Map(),
      operator_actions: new Map(),
      circuit_breakers: new Map(),
      redispatch_progress: new Map(),
      phase_timeline: new Map(),
      budget_usage_samples: new Map(),
      inactive_worker_pids: new Map(),
      released_workers: new Map(),
      completed: new Set(),
      codex_totals: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        seconds_running: 0
      },
      codex_rate_limits: null,
      health: {
        dispatch_validation: 'ok',
        last_error: null,
        dispatch_backpressure: emptyDispatchBackpressureState(getBackpressureRetryDelayMs(this.config))
      },
      drain_mode: emptyDrainModeState(),
      quiescence: emptyQuiescenceState(this.nowMs()),
      runtime_identity: this.readRuntimeIdentity(),
      throughput: {
        current_tps: 0,
        avg_tps_60s: 0,
        window_seconds: 600,
        sparkline_10m: Array.from({ length: 24 }, () => 0),
        sample_count: 0
      },
      recent_runtime_events: []
    };
    this.hostRoundRobinIndex = 0;
    this.throughputTracker = new ThroughputTracker();
    this.serializedOperation = Promise.resolve();
  }

  private createTrackedTracker(tracker: TrackerAdapter): TrackerAdapter {
    return {
      fetch_candidate_issues: () => tracker.fetch_candidate_issues(),
      fetch_issues_by_states: (stateNames) => tracker.fetch_issues_by_states(stateNames),
      fetch_issue_states_by_ids: (issueIds) => tracker.fetch_issue_states_by_ids(issueIds),
      create_comment: (issueId, body) => this.trackTrackerWrite(() => tracker.create_comment(issueId, body)),
      update_issue_state: (issueId, stateName) => this.trackTrackerWrite(() => tracker.update_issue_state(issueId, stateName))
    };
  }

  private async trackTrackerWrite<T>(operation: () => Promise<T>): Promise<T> {
    this.inFlightTrackerWrites += 1;
    this.refreshQuiescenceState();
    try {
      return await operation();
    } finally {
      this.inFlightTrackerWrites = Math.max(0, this.inFlightTrackerWrites - 1);
      this.refreshQuiescenceState();
      this.ports.notifyObservers?.();
    }
  }

  enterDrainMode(params: { reason?: string | null } = {}): DrainModeState {
    const nowMs = this.nowMs();
    const occurredAt = new Date(nowMs).toISOString();
    this.state.drain_mode = {
      active: true,
      entered_at_ms: this.state.drain_mode.active ? this.state.drain_mode.entered_at_ms : nowMs,
      updated_at_ms: nowMs,
      reason: params.reason ?? null
    };
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.runtime.drainEntered,
      severity: 'warn',
      detail: this.state.drain_mode.reason ?? 'drain mode entered'
    });
    this.refreshQuiescenceState();
    this.recordDrainAuditHistory({
      event_type: 'drain-entered',
      result: 'accepted',
      result_code: 'drain_mode_entered',
      reason_note: params.reason ?? null,
      state_context: this.drainAuditStateContext(),
      blocker_summaries: this.drainAuditBlockerSummaries(this.state.quiescence.blockers),
      occurred_at: occurredAt,
      observed_at: occurredAt
    });
    this.ports.notifyObservers?.();
    return { ...this.state.drain_mode };
  }

  exitDrainMode(params: { reason?: string | null } = {}): DrainModeState {
    const nowMs = this.nowMs();
    const occurredAt = new Date(nowMs).toISOString();
    this.state.drain_mode = {
      active: false,
      entered_at_ms: null,
      updated_at_ms: nowMs,
      reason: params.reason ?? null
    };
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.runtime.drainExited,
      severity: 'info',
      detail: this.state.drain_mode.reason ?? 'drain mode exited'
    });
    this.refreshQuiescenceState();
    this.recordDrainAuditHistory({
      event_type: 'drain-exited',
      result: 'accepted',
      result_code: 'drain_mode_exited',
      reason_note: params.reason ?? null,
      state_context: this.drainAuditStateContext(),
      blocker_summaries: this.drainAuditBlockerSummaries(this.state.quiescence.blockers),
      occurred_at: occurredAt,
      observed_at: occurredAt
    });
    this.ports.notifyObservers?.();
    return { ...this.state.drain_mode };
  }

  readDrainMode(): DrainModeState {
    return { ...this.state.drain_mode };
  }

  private readRuntimeIdentity() {
    if (!this.ports.resolveRuntimeIdentity) {
      return null;
    }
    try {
      return this.ports.resolveRuntimeIdentity();
    } catch {
      return null;
    }
  }

  private refreshRuntimeIdentity(): void {
    const nextIdentity = this.readRuntimeIdentity();
    if (nextIdentity) {
      this.state.runtime_identity = nextIdentity;
    }
  }

  private runtimeIdentityDispatchBlockerDetail(): string | null {
    this.refreshRuntimeIdentity();
    const identity = this.state.runtime_identity;
    if (!identity?.health_warning) {
      return null;
    }
    if (identity.status === 'stale' || identity.status === 'unknown_current') {
      return identity.health_warning.message;
    }
    return null;
  }

  private refreshQuiescenceState(pendingIssues?: Issue[]): DrainQuiescenceState {
    if (pendingIssues) {
      this.lastQuiescencePendingIssues = [...pendingIssues];
    }
    this.refreshRuntimeIdentity();
    const blockers: DrainQuiescenceBlocker[] = [];
    const warnings: DrainQuiescenceWarning[] = [];
    const counts = emptyDrainBlockerCounts();
    const runningEntries = Array.from(this.state.running.values());
    const runningIssueIdentifiers = runningEntries.map((entry) => entry.identifier);
    const runningRunIdentifiers = runningEntries.flatMap((entry) =>
      [entry.run_id, entry.issue_run_id, entry.attempt_id].filter((id): id is string => Boolean(id))
    );
    const runningThreadIdentifiers = runningEntries
      .map((entry) => entry.thread_id)
      .filter((id): id is string => Boolean(id));
    if (runningEntries.length > 0) {
      counts.active_worker = runningEntries.length;
      blockers.push({
        category: 'active_worker',
        count: runningEntries.length,
        detail:
          runningEntries.length === 1
            ? `${runningIssueIdentifiers[0]} is still running`
            : `${runningEntries.length} workers are still running`,
        issue_identifiers: runningIssueIdentifiers,
        run_identifiers: runningRunIdentifiers,
        thread_identifiers: runningThreadIdentifiers
      });
    }

    const liveAgentEntries = runningEntries.filter((entry) =>
      Boolean(entry.worker_process_pid ?? entry.codex_app_server_pid)
    );
    if (liveAgentEntries.length > 0) {
      counts.live_codex_app_server_process = liveAgentEntries.length;
      blockers.push({
        category: 'live_codex_app_server_process',
        count: liveAgentEntries.length,
        detail:
          liveAgentEntries.length === 1
            ? `${liveAgentEntries[0].identifier} has a live agent runner process`
            : `${liveAgentEntries.length} live agent runner processes are attached to active workers`,
        issue_identifiers: liveAgentEntries.map((entry) => entry.identifier),
        run_identifiers: liveAgentEntries.flatMap((entry) =>
          [entry.run_id, entry.issue_run_id, entry.attempt_id].filter((id): id is string => Boolean(id))
        ),
        thread_identifiers: liveAgentEntries.map((entry) => entry.thread_id).filter((id): id is string => Boolean(id))
      });
    }

    const retryEntries = Array.from(this.state.retry_attempts.values());
    if (retryEntries.length > 0) {
      counts.pending_retry = retryEntries.length;
      blockers.push({
        category: 'pending_retry',
        count: retryEntries.length,
        detail:
          retryEntries.length === 1
            ? `${retryEntries[0].identifier} has a pending retry`
            : `${retryEntries.length} retry attempts are pending`,
        issue_identifiers: retryEntries.map((entry) => entry.identifier),
        run_identifiers: retryEntries.flatMap((entry) =>
          [entry.issue_run_id, entry.previous_attempt_id].filter((id): id is string => Boolean(id))
        ),
        thread_identifiers: retryEntries
          .map((entry) => entry.previous_thread_id)
          .filter((id): id is string => Boolean(id))
      });
    }

    if (this.inFlightTrackerWrites > 0) {
      counts.in_flight_tracker_write = this.inFlightTrackerWrites;
      blockers.push({
        category: 'in_flight_tracker_write',
        count: this.inFlightTrackerWrites,
        detail:
          this.inFlightTrackerWrites === 1
            ? '1 tracker write is still in flight'
            : `${this.inFlightTrackerWrites} tracker writes are still in flight`,
        issue_identifiers: []
      });
    }

    const pendingTurnHistoryWriteCount = runningEntries.reduce(
      (total, entry) => total + (entry.pending_persisted_turn_ids?.length ?? 0),
      0
    );
    const pendingHistoryWriteCount = pendingTurnHistoryWriteCount + this.pendingExecutionGraphPersistenceWrites;
    const persistenceHealth = this.readPersistenceHealth();
    const persistenceHealthWarning = this.describePersistenceHealthWarning(persistenceHealth);
    if (pendingHistoryWriteCount > 0) {
      counts.persistence_history_write = pendingHistoryWriteCount;
      blockers.push({
        category: 'persistence_history_write',
        count: pendingHistoryWriteCount,
        detail: `${pendingHistoryWriteCount} execution-history write${pendingHistoryWriteCount === 1 ? '' : 's'} pending flush`,
        issue_identifiers: runningEntries
          .filter((entry) => (entry.pending_persisted_turn_ids?.length ?? 0) > 0)
          .map((entry) => entry.identifier),
        run_identifiers: runningEntries
          .filter((entry) => (entry.pending_persisted_turn_ids?.length ?? 0) > 0)
          .flatMap((entry) => [entry.run_id, entry.issue_run_id, entry.attempt_id].filter((id): id is string => Boolean(id))),
        thread_identifiers: runningEntries
          .filter((entry) => (entry.pending_persisted_turn_ids?.length ?? 0) > 0)
          .map((entry) => entry.thread_id)
          .filter((id): id is string => Boolean(id))
      });
    }
    if (persistenceHealthWarning) {
      warnings.push({
        category: 'persistence_history_degraded',
        count: 1,
        detail: persistenceHealthWarning,
        source: 'audit_health'
      });
    }

    if (this.state.health.dispatch_validation === 'failed') {
      counts.unknown_degraded_blocker_source_health = 1;
      blockers.push({
        category: 'unknown_degraded_blocker_source_health',
        count: 1,
        detail: this.state.health.last_error ?? 'dispatch validation health is degraded',
        issue_identifiers: []
      });
    }

    const runtimeIdentity = this.state.runtime_identity;
    if (runtimeIdentity?.status === 'stale' && runtimeIdentity.health_warning) {
      warnings.push({
        category: 'stale_runtime_warning',
        count: 1,
        detail: runtimeIdentity.health_warning.message,
        source: 'dispatch_safety',
        recommended_action: runtimeIdentity.health_warning.recommended_action
      });
    } else if (runtimeIdentity?.status === 'unknown_current' && runtimeIdentity.health_warning) {
      warnings.push({
        category: 'unknown_current_build_identity_warning',
        count: 1,
        detail: runtimeIdentity.health_warning.message,
        source: 'dispatch_safety',
        recommended_action: runtimeIdentity.health_warning.recommended_action
      });
    }

    const safeToShutdown = blockers.length === 0;
    const restartGuidance = this.buildRestartGuidance(safeToShutdown, warnings, this.lastQuiescencePendingIssues);
    const next: DrainQuiescenceState = {
      safe_to_shutdown: safeToShutdown,
      state: safeToShutdown ? 'safe' : 'blocked',
      updated_at_ms: this.nowMs(),
      blockers,
      blocker_counts: counts,
      warnings,
      restart_guidance: restartGuidance
    };
    const previousSignature = JSON.stringify({
      safe_to_shutdown: this.state.quiescence.safe_to_shutdown,
      blocker_counts: this.state.quiescence.blocker_counts,
      warnings: this.state.quiescence.warnings ?? [],
      restart_guidance: this.state.quiescence.restart_guidance ?? null
    });
    const nextSignature = JSON.stringify({
      safe_to_shutdown: next.safe_to_shutdown,
      blocker_counts: next.blocker_counts,
      warnings: next.warnings,
      restart_guidance: next.restart_guidance
    });
    this.state.quiescence = next;
    if (this.state.drain_mode.active && previousSignature !== nextSignature) {
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.runtime.quiescenceChanged,
        severity: next.safe_to_shutdown ? 'info' : 'warn',
        detail: next.safe_to_shutdown ? 'runtime is safe to shutdown' : `runtime has ${blockers.length} quiescence blocker categories`
      });
      if (next.safe_to_shutdown) {
        const occurredAt = new Date(next.updated_at_ms).toISOString();
        this.recordDrainAuditHistory({
          event_type: 'quiescence-reached',
          result: 'observed',
          result_code: 'quiescent',
          state_context: this.drainAuditStateContext(),
          blocker_summaries: [],
          occurred_at: occurredAt,
          observed_at: occurredAt
        });
      }
    }
    return next;
  }

  private readPersistenceHealth(): PersistenceHealth | null {
    if (!this.ports.getPersistenceHealth) {
      return null;
    }
    try {
      return this.ports.getPersistenceHealth();
    } catch (error) {
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.persistence.recordEventFailed,
        message: 'failed to read persistence health for drain quiescence',
        context: {
          error: error instanceof Error ? error.message : 'unknown'
        }
      });
      return {
        enabled: true,
        db_path: null,
        retention_days: 0,
        health_depth: 'fast',
        run_count: 0,
        last_pruned_at: null,
        last_prune_failure_at: null,
        last_prune_failure_reason: 'persistence_health_unavailable',
        last_prune_failure_detail: error instanceof Error ? error.message : 'unknown',
        integrity_ok: false
      };
    }
  }

  private describePersistenceHealthWarning(health: PersistenceHealth | null): string | null {
    if (!health || !health.enabled) {
      return null;
    }
    if (!health.integrity_ok) {
      return health.history_schema?.degraded_detail ?? health.last_prune_failure_detail ?? 'persistence integrity is degraded';
    }
    if (health.history_schema?.status === 'degraded') {
      return health.history_schema.degraded_detail ?? health.history_schema.degraded_reason_code ?? 'history schema is degraded';
    }
    if (health.last_prune_failure_at) {
      return health.last_prune_failure_detail ?? health.last_prune_failure_reason ?? 'history retention pruning is degraded';
    }
    if (health.recent_write_failures?.length) {
      const latest = health.recent_write_failures[0];
      return `recent history write failure: ${latest.operation} (${latest.reason_code})`;
    }
    return null;
  }

  private buildRestartGuidance(
    safeToShutdown: boolean,
    warnings: DrainQuiescenceWarning[],
    pendingIssues: Issue[]
  ): DrainQuiescenceRestartGuidance {
    const pendingByState = new Map<string, { state: string; count: number; maintenance_eligible: boolean }>();
    for (const issue of pendingIssues) {
      const stateName = issue.state || 'unknown';
      const existing = pendingByState.get(stateName) ?? {
        state: stateName,
        count: 0,
        maintenance_eligible: stateName.trim().toLowerCase() === 'merging'
      };
      existing.count += 1;
      pendingByState.set(stateName, existing);
    }
    const pending_work = [...pendingByState.values()].sort((a, b) => a.state.localeCompare(b.state));
    const hasDispatchSafetyWarning = warnings.some((warning) => warning.source === 'dispatch_safety');
    if (!safeToShutdown) {
      return {
        safe_to_restart: false,
        recommended_action: 'wait_for_true_shutdown_blockers',
        pending_work,
        detail: 'Wait for active workers, child processes, retries, and current writes to clear before restarting.'
      };
    }
    if (hasDispatchSafetyWarning) {
      return {
        safe_to_restart: true,
        recommended_action: 'restart_runtime_to_current_build',
        pending_work,
        detail: 'Runtime is quiescent enough to restart; restart/update Symphony before dispatching normal work.'
      };
    }
    return {
      safe_to_restart: true,
      recommended_action: 'none',
      pending_work,
      detail: 'Runtime is safe to restart.'
    };
  }

  getStateSnapshot(options: StateSnapshotOptions = {}): OrchestratorState {
    const snapshotOptions: Required<StateSnapshotOptions> = {
      includeTranscriptToolCallDiagnostics: options.includeTranscriptToolCallDiagnostics ?? true
    };
    return {
      ...this.state,
      snapshot_generated_at_ms: this.nowMs(),
      running: new Map(
        Array.from(this.state.running.entries()).map(([issueId, entry]) => [issueId, cloneRunningEntry(entry, snapshotOptions)])
      ),
      claimed: new Set(this.state.claimed.values()),
      retry_attempts: new Map(
        Array.from(this.state.retry_attempts.entries()).map(([issueId, entry]) => [issueId, cloneRetryEntry(entry)])
      ),
      blocked_inputs: new Map(
        Array.from(this.state.blocked_inputs.entries()).map(([issueId, entry]) => [issueId, cloneBlockedEntry(entry, snapshotOptions)])
      ),
      operator_actions: new Map(
        Array.from((this.state.operator_actions ?? new Map<string, OperatorActionRecord[]>()).entries()).map(([issueId, entries]) => [
          issueId,
          entries.map((entry) => cloneOperatorAction(entry))
        ])
      ),
      circuit_breakers: new Map(
        Array.from(this.state.circuit_breakers.entries()).map(([issueId, entry]) => [issueId, cloneCircuitBreakerEntry(entry)])
      ),
      redispatch_progress: new Map(
        Array.from((this.state.redispatch_progress ?? new Map<string, RedispatchProgressSample[]>()).entries()).map(([issueId, entries]) => [
          issueId,
          entries.map((entry) => ({ ...entry }))
        ])
      ),
      phase_timeline: new Map(
        Array.from((this.state.phase_timeline ?? new Map<string, PhaseMarker[]>()).entries()).map(([issueId, markers]) => [
          issueId,
          markers.map((marker: PhaseMarker) => ({ ...marker }))
        ])
      ),
      budget_usage_samples: new Map(
        Array.from((this.state.budget_usage_samples ?? new Map<string, Array<{ at_ms: number; total_tokens: number }>>()).entries()).map(([issueId, samples]) => [
          issueId,
          samples.map((sample) => ({ ...sample }))
        ])
      ),
      inactive_worker_pids: new Map(
        Array.from(
          (
            this.state.inactive_worker_pids ??
            new Map<
              string,
              Array<{
                pid: string;
                recorded_at_ms: number;
                reason: string;
                thread_id: string | null;
                turn_id: string | null;
                session_id: string | null;
              }>
            >()
          ).entries()
        ).map(([issueId, entries]) => [issueId, entries.map((entry) => ({ ...entry }))])
      ),
      released_workers: new Map(
        Array.from((this.state.released_workers ?? new Map<string, ReleasedWorkerRecord[]>()).entries()).map(
          ([issueId, entries]) => [issueId, entries.map((entry) => cloneReleasedWorkerRecord(entry))]
        )
      ),
      completed: new Set(this.state.completed.values()),
      codex_totals: { ...this.state.codex_totals },
      codex_rate_limits: this.state.codex_rate_limits ? { ...this.state.codex_rate_limits } : null,
      health: {
        ...this.state.health,
        dispatch_backpressure: cloneDispatchBackpressureState(
          this.state.health.dispatch_backpressure ?? emptyDispatchBackpressureState(getBackpressureRetryDelayMs(this.config))
        )
      },
      drain_mode: { ...this.state.drain_mode },
      runtime_identity: this.state.runtime_identity
        ? {
            process_started_at_ms: this.state.runtime_identity.process_started_at_ms,
            running_build: { ...this.state.runtime_identity.running_build },
            current_build: { ...this.state.runtime_identity.current_build },
            status: this.state.runtime_identity.status,
            health_warning: this.state.runtime_identity.health_warning ? { ...this.state.runtime_identity.health_warning } : null
          }
        : null,
      quiescence: {
        ...this.state.quiescence,
        blockers: this.state.quiescence.blockers.map((blocker) => ({
          ...blocker,
          issue_identifiers: [...blocker.issue_identifiers]
        })),
        blocker_counts: { ...this.state.quiescence.blocker_counts },
        warnings: (this.state.quiescence.warnings ?? []).map((warning) => ({ ...warning })),
        restart_guidance: {
          ...(this.state.quiescence.restart_guidance ?? {
            safe_to_restart: true,
            recommended_action: 'none',
            pending_work: [],
            detail: 'Runtime is safe to restart.'
          }),
          pending_work: (this.state.quiescence.restart_guidance?.pending_work ?? []).map((entry) => ({ ...entry }))
        }
      },
      throughput: this.throughputTracker.snapshot(this.nowMs()),
      recent_runtime_events: this.state.recent_runtime_events.map((event) => ({ ...event }))
    };
  }

  applyRuntimeConfig(config: {
    poll_interval_ms: number;
    max_concurrent_agents: number;
    max_concurrent_agents_by_state: Record<string, number>;
    max_retry_backoff_ms: number;
    respawn_window_minutes: number;
    respawn_max_attempts_without_progress: number;
    active_states: string[];
    terminal_states: string[];
    handoff_states?: string[];
    fresh_dispatch_states?: string[];
    github_linking_mode?: 'off' | 'warn' | 'required' | string;
    stall_timeout_ms: number;
    no_telemetry_warning_threshold_ms?: number;
    running_wait_stall_threshold_ms?: number;
    progress_heartbeat_only_warn_ms?: number;
    progress_stalled_waiting_ms?: number;
    worker_opaque_activity_hard_timeout_ms?: number;
    inactive_worker_pid_ttl_ms?: number;
    worker_hosts?: string[];
    max_concurrent_agents_per_host?: number | null;
    phase_markers_enabled?: boolean;
    phase_timeline_limit?: number;
    budget?: OrchestratorOptions['config']['budget'];
    dispatch_backpressure?: OrchestratorOptions['config']['dispatch_backpressure'];
  }): void {
    this.config.poll_interval_ms = config.poll_interval_ms;
    this.config.max_concurrent_agents = config.max_concurrent_agents;
    this.config.max_concurrent_agents_by_state = { ...config.max_concurrent_agents_by_state };
    this.config.max_retry_backoff_ms = config.max_retry_backoff_ms;
    this.config.respawn_window_minutes = config.respawn_window_minutes;
    this.config.respawn_max_attempts_without_progress = config.respawn_max_attempts_without_progress;
    this.config.active_states = [...config.active_states];
    this.config.terminal_states = [...config.terminal_states];
    this.config.handoff_states = [...(config.handoff_states ?? [])];
    this.config.fresh_dispatch_states = [...(config.fresh_dispatch_states ?? [])];
    this.config.github_linking_mode = config.github_linking_mode ?? 'off';
    this.config.stall_timeout_ms = config.stall_timeout_ms;
    this.config.no_telemetry_warning_threshold_ms = config.no_telemetry_warning_threshold_ms ?? 120_000;
    this.config.progress_heartbeat_only_warn_ms = config.progress_heartbeat_only_warn_ms ?? 120_000;
    this.config.progress_stalled_waiting_ms = config.progress_stalled_waiting_ms ?? config.running_wait_stall_threshold_ms ?? 300_000;
    this.config.running_wait_stall_threshold_ms = this.config.progress_stalled_waiting_ms;
    this.config.worker_opaque_activity_hard_timeout_ms = config.worker_opaque_activity_hard_timeout_ms ?? 1_800_000;
    this.config.inactive_worker_pid_ttl_ms = config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS;
    this.config.worker_hosts = config.worker_hosts ? [...config.worker_hosts] : [];
    this.config.max_concurrent_agents_per_host = config.max_concurrent_agents_per_host ?? null;
    this.config.phase_markers_enabled = config.phase_markers_enabled ?? true;
    this.config.phase_timeline_limit = config.phase_timeline_limit ?? 30;
    this.config.budget = config.budget;
    this.config.dispatch_backpressure = config.dispatch_backpressure;
    this.phaseSettings.enabled = this.config.phase_markers_enabled !== false;
    this.phaseSettings.timeline_limit = Math.max(1, this.config.phase_timeline_limit ?? 30);

    this.state.poll_interval_ms = config.poll_interval_ms;
    this.state.max_concurrent_agents = config.max_concurrent_agents;
    this.state.health.dispatch_backpressure = {
      ...(this.state.health.dispatch_backpressure ?? emptyDispatchBackpressureState(getBackpressureRetryDelayMs(this.config))),
      retry_delay_ms: getBackpressureRetryDelayMs(this.config)
    };
  }

  async tick(reason: TickReason): Promise<void> {
    await this.runSerializedOperation(() => this.tickOnce(reason));
  }

  private recordDispatchBackpressure(issue: Issue, backpressure: DispatchBackpressureState, attempt: number | null): void {
    this.state.health.dispatch_backpressure = cloneDispatchBackpressureState(backpressure);
    this.state.health.last_error = `dispatch backpressure active for ${issue.identifier}: ${backpressure.reason_code}`;
    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.dispatchBackpressureActive,
      message: 'dispatch delayed by local backpressure',
      context: {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        retry_attempt: attempt ?? 0,
        reason_code: backpressure.reason_code,
        reason_detail: backpressure.reason_detail,
        source: backpressure.source,
        retry_delay_ms: backpressure.retry_delay_ms
      }
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.dispatchBackpressureActive,
      severity: 'warn',
      issue_identifier: issue.identifier,
      detail: `${backpressure.reason_code}: ${backpressure.reason_detail ?? 'dispatch delayed'}`
    });
  }

  private async delayDispatchForBackpressure(issue: Issue, attempt: number | null, backpressure: DispatchBackpressureState): Promise<void> {
    this.recordDispatchBackpressure(issue, backpressure, attempt);
    await this.scheduleRetry({
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt: attempt ?? 1,
      delay_type: 'backpressure',
      delay_ms: backpressure.retry_delay_ms,
      error: 'dispatch delayed by local backpressure',
      worker_host: null,
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
      stop_reason_code: backpressure.reason_code,
      stop_reason_detail: backpressure.reason_detail,
      issue_snapshot: issue
    });
  }

  private dispatchCoordinatorContext(): DispatchCoordinatorContext {
    return {
      state: this.state,
      config: this.config,
      tracker: this.tracker,
      dispatchPreflight: () => this.ports.dispatchPreflight(),
      spawnWorker: (params) => this.ports.spawnWorker(params),
      cancelRetryTimer: (timerHandle) => this.ports.cancelRetryTimer(timerHandle),
      notifyObservers: this.ports.notifyObservers ? () => this.ports.notifyObservers?.() : undefined,
      getControlPlaneHealth: this.ports.getControlPlaneHealth ? () => this.ports.getControlPlaneHealth!() : undefined,
      getHostLoad: this.ports.getHostLoad ? () => this.ports.getHostLoad!() : undefined,
      persistence: this.persistence,
      logger: this.logger,
      nowMs: () => this.nowMs(),
      hooks: {
        reconcileRunningIssues: () => this.reconcileRunningIssues(),
        reconcileBlockedInputs: () => this.reconcileBlockedInputs(),
        recordDuplicateDispatchSkipped: (issue, retryAttempt) => this.recordDuplicateDispatchSkipped(issue, retryAttempt),
        delayDispatchForBackpressure: (issue, attempt, backpressure) =>
          this.delayDispatchForBackpressure(issue, attempt, backpressure),
        emitPhaseMarker: (issueId, marker) => this.emitPhaseMarker(issueId, marker),
        recordRuntimeEvent: (params) => this.recordRuntimeEvent(params),
        refreshQuiescenceState: (pendingIssues) => {
          this.refreshQuiescenceState(pendingIssues);
        },
        selectWorkerHost: () => this.selectWorkerHost(),
        persistPreSpawnExecutionGraphAttempt: (params) => this.persistPreSpawnExecutionGraphAttempt(params),
        scheduleRetry: (params) => this.scheduleRetry(params),
        workerInstanceIdFromHandle: (workerHandle) => this.workerInstanceIdFromHandle(workerHandle),
        computeBudgetProjection: (issueId, currentAttemptTokens, telemetryStatus, forcedStatus, forcedMessage) =>
          this.computeBudgetProjection(issueId, currentAttemptTokens, telemetryStatus, forcedStatus, forcedMessage),
        persistOperationalFactsForIssue: (issue, runningEntry, observedAt) =>
          this.persistOperationalFactsForIssue(issue, runningEntry, observedAt),
        recordHistoryWriteFailure: (operation, reasonCode, error) =>
          this.recordHistoryWriteFailure(operation, reasonCode, error)
      }
    };
  }

  private async tickOnce(reason: TickReason): Promise<void> {
    await coordinateDispatchTick(this.dispatchCoordinatorContext(), reason);
  }

  private reconciliationCoordinatorContext(): ReconciliationCoordinatorContext {
    return {
      state: this.state,
      config: this.config,
      tracker: this.tracker,
      runningWait: this.runningWaitCoordinatorContext(),
      logger: this.logger,
      nowMs: () => this.nowMs(),
      hooks: {
        terminateRunningIssue: (issueId, cleanupWorkspace, reason) =>
          this.terminateRunningIssue(issueId, cleanupWorkspace, reason),
        clearBlockedInput: (issueId, reason) => this.clearBlockedInput(issueId, reason),
        clearCircuitBreaker: (issueId) => this.clearCircuitBreaker(issueId),
        scheduleRetry: (params) => this.scheduleRetry(params),
        markRunningWaitStallRootCauseIfThresholdExceeded: (runningEntry, observedAtMs) =>
          this.markRunningWaitStallRootCauseIfThresholdExceeded(runningEntry, observedAtMs),
        recordRuntimeEvent: (params) => this.recordRuntimeEvent(params)
      }
    };
  }

  private async runSerializedOperation(operation: () => Promise<void>): Promise<void> {
    const run = this.serializedOperation.then(operation, operation);
    this.serializedOperation = run.catch(() => undefined);
    await run;
  }

  private workerInstanceIdFromHandle(workerHandle: unknown): string | null {
    const record = asRecord(workerHandle);
    return normalizeWorkerInstanceId(readString(record?.worker_instance_id));
  }

  private missingToolOutputCoordinatorContext(): MissingToolOutputCoordinatorContext {
    return {
      state: this.state,
      config: this.config,
      terminateWorker: (params) => this.ports.terminateWorker(params),
      recoverMissingToolOutput: this.ports.recoverMissingToolOutput,
      notifyObservers: this.ports.notifyObservers ? () => this.ports.notifyObservers?.() : undefined,
      logger: this.logger,
      nowMs: () => this.nowMs(),
      hooks: {
        applyToolCallLedgerObservation: (runningEntry, observation) =>
          this.applyToolCallLedgerObservation(runningEntry, observation),
        scheduleBlockedInput: (params) => this.scheduleBlockedInput(params),
        addRuntimeSecondsFromEntry: (runningEntry) => this.addRuntimeSecondsFromEntry(runningEntry),
        completeRunRecord: (runningEntry, terminalStatus, errorCode, recoveryOverride, terminalReasonDetail) =>
          this.completeRunRecord(runningEntry, terminalStatus, errorCode, recoveryOverride, terminalReasonDetail),
        persistExecutionGraphStateTransition: (runningEntry, toStatus, status, reasonCode, reasonDetail) =>
          this.persistExecutionGraphStateTransition(runningEntry, toStatus, status, reasonCode, reasonDetail),
        recordRuntimeEvent: (params) => this.recordRuntimeEvent(params),
        workerTerminationAllowsRecovery: (result) => this.workerTerminationAllowsRecovery(result),
        workerTerminationInterruptStatus: (result) => this.workerTerminationInterruptStatus(result),
        workerInstanceIdFromHandle: (workerHandle) => this.workerInstanceIdFromHandle(workerHandle)
      }
    };
  }

  private runningWaitCoordinatorContext(): RunningWaitCoordinatorContext {
    return {
      state: this.state,
      config: this.config,
      tracker: this.tracker,
      terminateWorker: (params) => this.ports.terminateWorker(params),
      logger: this.logger,
      nowMs: () => this.nowMs(),
      hooks: {
        scanCodexSessionTranscriptForToolCalls: (runningEntry, observedAtMs) =>
          this.scanCodexSessionTranscriptForToolCalls(runningEntry, observedAtMs),
        findMissingToolOutputCandidate: (runningEntry, observedAtMs, waitThresholdMs) =>
          this.findMissingToolOutputCandidate(runningEntry, observedAtMs, waitThresholdMs),
        recoverOrBlockMissingToolOutput: (issueId, runningEntry, missingToolOutput, observedAtMs) =>
          this.recoverOrBlockMissingToolOutput(issueId, runningEntry, missingToolOutput, observedAtMs),
        addRuntimeSecondsFromEntry: (runningEntry) => this.addRuntimeSecondsFromEntry(runningEntry),
        completeRunRecord: (runningEntry, terminalStatus, errorCode, recoveryOverride, terminalReasonDetail) =>
          this.completeRunRecord(runningEntry, terminalStatus, errorCode, recoveryOverride, terminalReasonDetail),
        persistExecutionGraphStateTransition: (runningEntry, toStatus, status, reasonCode, reasonDetail) =>
          this.persistExecutionGraphStateTransition(runningEntry, toStatus, status, reasonCode, reasonDetail),
        scheduleRetry: (params) => this.scheduleRetry(params),
        recordRuntimeEvent: (params) => this.recordRuntimeEvent(params),
        getLastPhaseMarker: (issueId) => this.getLastPhaseMarker(issueId),
        clearCircuitBreaker: (issueId) => this.clearCircuitBreaker(issueId),
        dispatchIssue: (issue, attempt) => this.dispatchIssue(issue, attempt)
      }
    };
  }

  private runCompletionCoordinatorContext(): RunCompletionCoordinatorContext {
    return {
      state: this.state,
      config: this.config,
      terminateWorker: (params) => this.ports.terminateWorker(params),
      cancelRetryTimer: (timerHandle) => this.ports.cancelRetryTimer(timerHandle),
      notifyObservers: this.ports.notifyObservers ? () => this.ports.notifyObservers?.() : undefined,
      persistence: this.persistence,
      logger: this.logger,
      nowMs: () => this.nowMs(),
      hooks: {
        drainExecutionGraphPersistence: async (runningEntry) => {
          await (this.executionGraphPersistenceQueues.get(runningEntry) ?? Promise.resolve()).catch(() => undefined);
        },
        recordHistoryWriteFailure: (operation, reasonCode, error) =>
          this.recordHistoryWriteFailure(operation, reasonCode, error),
        persistExecutionGraphStateTransition: (runningEntry, toStatus, status, reasonCode, reasonDetail) =>
          this.persistExecutionGraphStateTransition(runningEntry, toStatus, status, reasonCode, reasonDetail)
      }
    };
  }

  onWorkerEvent(issue_id: string, workerEvent: WorkerObservabilityEvent): void {
    applyWorkerEvent({
      state: this.state,
      issueId: issue_id,
      workerEvent,
      inactiveWorkerPidTtlMs: this.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS,
      runningWaitThresholdMs: this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000,
      nowMs: () => this.nowMs(),
      logger: this.logger,
      notifyObservers: () => this.ports.notifyObservers?.(),
      quarantineBlockedWorkerEvent: (blockedEntry, event, reason) => this.quarantineBlockedWorkerEvent(blockedEntry, event, reason),
      captureWorkerProgressSignal: (runningEntry, event) => this.captureWorkerProgressSignal(runningEntry, event),
      maybeEmitHeartbeatOnly: (issueId, runningEntry, observedAtMs) => this.maybeEmitHeartbeatOnly(issueId, runningEntry, observedAtMs),
      resetRunningWaitEpisode: (runningEntry, progressAtMs) => this.resetRunningWaitEpisode(runningEntry, progressAtMs),
      isMeaningfulWorkerProgressEvent: (event) => this.isMeaningfulWorkerProgressEvent(event),
      observeThroughput: (sample) => this.throughputTracker.observe(sample),
      updateOutstandingToolCalls: (runningEntry, event) => this.updateOutstandingToolCalls(runningEntry, event),
      updateBudgetProjection: (issueId, runningEntry, totalTokens) =>
        updateRunningBudgetProjection({
          budget: this.config.budget,
          budgetSamples: this.budgetUsageSamples(),
          nowMs: this.nowMs(),
          issueId,
          runningEntry,
          currentAttemptTokens: totalTokens,
          telemetryStatus: 'available'
        }),
      maybeEmitTokenTelemetryWarning: (runningEntry, eventAtMs) => this.maybeEmitTokenTelemetryWarning(runningEntry, eventAtMs),
      maybeEmitBudgetTelemetryUnavailable: (runningEntry, event) => this.maybeEmitBudgetTelemetryUnavailable(runningEntry, event),
      maybeEnforceBudget: (issueId, runningEntry, timestampMs) => this.maybeEnforceBudget(issueId, runningEntry, timestampMs),
      persistSession: (params) => this.persistence?.recordSession(params) ?? Promise.resolve(),
      persistRunEvent: (params) => this.persistence?.recordEvent(params) ?? Promise.resolve(),
      beginExecutionGraphWorkerTurnObservation: (runningEntry, event) =>
        beginExecutionGraphWorkerTurnObservation(runningEntry, event),
      queuePersistExecutionGraphWorkerEvent: (issueId, runningEntry, event, turnAlreadyObserved) =>
        this.queuePersistExecutionGraphWorkerEvent(issueId, runningEntry, event, turnAlreadyObserved),
      recordRuntimeEvent: (params) => this.recordRuntimeEvent(params),
      emitExplicitPhaseMarker: (issueId, event) => this.emitExplicitPhaseMarker(issueId, event),
      emitMappedPhaseMarker: (issueId, event) => this.emitMappedPhaseMarker(issueId, event),
      hasOutstandingToolCallEvidence: (runningEntry) => coordinateHasOutstandingToolCallEvidence(runningEntry),
      maybeClassifyRunningWaitStall: (issueId, runningEntry, observedAtMs) =>
        this.maybeClassifyRunningWaitStall(issueId, runningEntry, observedAtMs)
    });
  }

  private queuePersistExecutionGraphWorkerEvent(
    issueId: string,
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent,
    turnAlreadyObserved: boolean
  ): void {
    this.pendingExecutionGraphPersistenceWrites += 1;
    this.refreshQuiescenceState();
    const queued = queuePersistExecutionGraphWorkerEventHelper({
      queues: this.executionGraphPersistenceQueues,
      issueId,
      runningEntry,
      workerEvent,
      turnAlreadyObserved,
      persistedPhaseSpanKeys: this.persistedPhaseSpanKeys,
      persistence: this.persistence,
      logger: this.logger,
      recordHistoryWriteFailure: (operation, reasonCode, error) => this.recordHistoryWriteFailure(operation, reasonCode, error)
    });
    void queued
      .finally(() => {
        this.pendingExecutionGraphPersistenceWrites = Math.max(0, this.pendingExecutionGraphPersistenceWrites - 1);
        this.refreshQuiescenceState();
        this.ports.notifyObservers?.();
      })
      .catch(() => undefined);
  }

  private async recordHistoryWriteFailure(operation: string, reasonCode: string, error: unknown): Promise<void> {
    await recordHistoryWriteFailureHelper(this.persistence, operation, reasonCode, error);
  }

  private drainAuditStateContext(): Record<string, unknown> {
    return {
      drain_active: this.state.drain_mode.active,
      safe_to_shutdown: this.state.quiescence.safe_to_shutdown,
      quiescence_state: this.state.quiescence.state,
      blocker_counts: this.state.quiescence.blocker_counts,
      warnings: (this.state.quiescence.warnings ?? []).map((warning) => ({ ...warning })),
      restart_guidance: this.state.quiescence.restart_guidance
        ? {
            ...this.state.quiescence.restart_guidance,
            pending_work: this.state.quiescence.restart_guidance.pending_work.map((entry) => ({ ...entry }))
          }
        : null
    };
  }

  private drainAuditBlockerSummaries(blockers: DrainQuiescenceBlocker[]): Array<{
    category: string;
    count: number;
    issue_identifiers: string[];
    run_identifiers?: string[];
    thread_identifiers?: string[];
    detail: string | null;
  }> {
    return blockers.map((blocker) => ({
      category: blocker.category,
      count: blocker.count,
      issue_identifiers: blocker.issue_identifiers,
      run_identifiers: blocker.run_identifiers,
      thread_identifiers: blocker.thread_identifiers,
      detail: blocker.detail
    }));
  }

  private recordDrainAuditHistory(params: {
    event_type:
      | 'drain-entered'
      | 'drain-exited'
      | 'quiescence-reached'
      | 'wait-started'
      | 'wait-timed-out'
      | 'safe-shutdown-allowed'
      | 'safe-shutdown-refused';
    result: 'accepted' | 'rejected' | 'failed' | 'observed';
    result_code: string;
    reason_note?: string | null;
    state_context: Record<string, unknown>;
    blocker_summaries: Array<{
      category: string;
      count: number;
      issue_identifiers: string[];
      run_identifiers?: string[];
      thread_identifiers?: string[];
      detail: string | null;
    }>;
    occurred_at: string;
    observed_at: string;
  }): void {
    void this.persistence
      ?.appendDrainAuditHistory?.({
        ...params,
        actor: 'operator',
        source: 'orchestrator'
      })
      .catch((error) => {
        void this.recordHistoryWriteFailure('appendDrainAuditHistory', params.result_code, error);
      });
  }

  private normalStopForWorkerCompletion(
    completionReason: WorkerCompletionReason | null,
    refreshedState: string | null
  ): {
    reason_code: string;
    detail: string;
    message: string;
    cleanup_workspace: boolean;
  } | null {
    switch (completionReason) {
      case REASON_CODES.handoffStateReached:
        return {
          reason_code: REASON_CODES.handoffStateReached,
          detail: refreshedState
            ? `worker completed after refreshed issue reached handoff state: ${refreshedState}`
            : 'worker completed after refreshed issue reached a handoff state',
          message: 'worker exit handled: completed at handoff state',
          cleanup_workspace: false
        };
      case REASON_CODES.freshDispatchStateRouted:
        return {
          reason_code: REASON_CODES.freshDispatchStateRouted,
          detail: refreshedState
            ? `worker completed after fresh-dispatch state routed issue to: ${refreshedState}`
            : 'worker completed after fresh-dispatch state routed issue',
          message: 'worker exit handled: fresh-dispatch state routed',
          cleanup_workspace: false
        };
      case REASON_CODES.issueLeftActiveStates:
        return {
          reason_code: REASON_CODES.issueLeftActiveStates,
          detail: refreshedState
            ? `worker completed after refreshed issue left active states: ${refreshedState}`
            : 'worker completed after refreshed issue left active states',
          message: 'worker exit handled: completed after issue left active states',
          cleanup_workspace: false
        };
      case REASON_CODES.issueStateMissing:
        return {
          reason_code: REASON_CODES.issueStateMissing,
          detail: 'worker completed but tracker refresh did not return the issue',
          message: 'worker exit handled: completed after missing issue refresh',
          cleanup_workspace: false
        };
      case REASON_CODES.terminalStateReached:
        return {
          reason_code: REASON_CODES.terminalStateReached,
          detail: refreshedState
            ? `worker completed after refreshed issue reached terminal state: ${refreshedState}`
            : 'worker completed after refreshed issue reached a terminal state',
          message: 'worker exit handled: completed at terminal state',
          cleanup_workspace: true
        };
      case REASON_CODES.maxTurnsReached:
      case REASON_CODES.issueStateRefreshFailed:
      case null:
        return null;
    }
  }

  private async persistExecutionGraphStateTransition(
    runningEntry: RunningEntry,
    toStatus: string,
    status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying',
    reasonCode: string,
    reasonDetail: string | null
  ): Promise<void> {
    await persistExecutionGraphStateTransitionHelper({
      runningEntry,
      toStatus,
      status,
      reasonCode,
      reasonDetail,
      nowMs: () => this.nowMs(),
      persistence: this.persistence,
      logger: this.logger,
      recordHistoryWriteFailure: (operation, failureReasonCode, error) =>
        this.recordHistoryWriteFailure(operation, failureReasonCode, error)
    });
  }

  private async persistTicketEvidenceReferenceForThread(
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent,
    threadId: string,
    recordedAt: string
  ): Promise<void> {
    await persistTicketEvidenceReferenceForThreadHelper({
      runningEntry,
      workerEvent,
      threadId,
      recordedAt,
      persistence: this.persistence,
      logger: this.logger,
      recordHistoryWriteFailure: (operation, failureReasonCode, error) =>
        this.recordHistoryWriteFailure(operation, failureReasonCode, error)
    });
  }

  private async persistOperationalFactsForIssue(issue: Issue, runningEntry: RunningEntry, observedAt: string): Promise<void> {
    await persistOperationalFactsForIssueHelper({
      issue,
      runningEntry,
      observedAt,
      persistence: this.persistence,
      logger: this.logger,
      recordHistoryWriteFailure: (operation, failureReasonCode, error) =>
        this.recordHistoryWriteFailure(operation, failureReasonCode, error)
    });
  }

  private async persistExecutionGraphRetryTransition(
    retryEntry: RetryEntry,
    toStatus: string,
    status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying',
    reasonCode: string,
    reasonDetail: string | null
  ): Promise<void> {
    await persistExecutionGraphRetryTransitionHelper({
      retryEntry,
      toStatus,
      status,
      reasonCode,
      reasonDetail,
      nowMs: () => this.nowMs(),
      persistence: this.persistence,
      logger: this.logger,
      recordHistoryWriteFailure: (operation, failureReasonCode, error) =>
        this.recordHistoryWriteFailure(operation, failureReasonCode, error)
    });
  }

  private async persistPreSpawnExecutionGraphAttempt(params: {
    issue: Issue;
    attempt: number | null;
    graphContext: DispatchGraphContext;
    status: 'failed' | 'blocked';
    reasonCode: string;
    reasonDetail: string | null;
  }): Promise<DispatchGraphContext> {
    return persistPreSpawnExecutionGraphAttemptHelper({
      ...params,
      nowMs: () => this.nowMs(),
      persistence: this.persistence,
      logger: this.logger,
      recordHistoryWriteFailure: (operation, failureReasonCode, error) =>
        this.recordHistoryWriteFailure(operation, failureReasonCode, error)
    });
  }

  private budgetUsageSamples(): Map<string, BudgetUsageSample[]> {
    const budgetSamples = this.state.budget_usage_samples ?? new Map<string, BudgetUsageSample[]>();
    this.state.budget_usage_samples = budgetSamples;
    return budgetSamples;
  }

  private computeBudgetProjection(
    issueId: string,
    currentAttemptTokens: number,
    telemetryStatus: 'available' | 'pending' | 'unavailable',
    forcedStatus?: BudgetRuntimeProjection['budget_status'],
    forcedMessage?: string | null
  ): BudgetRuntimeProjection {
    return computeIssueBudgetProjection({
      budget: this.config.budget,
      budgetSamples: this.budgetUsageSamples(),
      nowMs: this.nowMs(),
      issueId,
      currentAttemptTokens,
      telemetryStatus,
      forcedStatus,
      forcedMessage
    });
  }

  private maybeEmitBudgetTelemetryUnavailable(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): void {
    applyBudgetTelemetryUnavailable({
      budget: this.config.budget,
      budgetSamples: this.budgetUsageSamples(),
      nowMs: this.nowMs(),
      logger: this.logger,
      recordRuntimeEvent: (params) => this.recordRuntimeEvent(params),
      runningEntry,
      workerEvent
    });
  }

  private maybeEnforceBudget(issueId: string, runningEntry: RunningEntry, timestampMs: number): void {
    const decision = evaluateBudgetEnforcement({
      budget: this.config.budget,
      budgetSamples: this.budgetUsageSamples(),
      nowMs: this.nowMs(),
      logger: this.logger,
      recordRuntimeEvent: (params) => this.recordRuntimeEvent(params),
      issueId,
      runningEntry
    });
    if (!decision) {
      return;
    }
    this.enforceBudgetHardLimit(issueId, runningEntry, timestampMs, decision).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const failureDetail = `Budget hard limit cleanup failed: ${message}`;
      this.state.health.last_error = failureDetail;
      this.logger?.log({
        level: 'error',
        event: CANONICAL_EVENT.budget.hardLimitExceeded,
        message: 'budget hard limit cleanup failed',
        context: {
          issue_id: issueId,
          issue_identifier: runningEntry.identifier,
          error: message
        }
      });
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.budget.hardLimitExceeded,
        severity: 'error',
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id ?? undefined,
        detail: failureDetail
      });
      this.ports.notifyObservers?.();
    });
  }

  private async enforceBudgetHardLimit(
    issueId: string,
    running: RunningEntry,
    timestampMs: number,
    decision: BudgetHardLimitDecision
  ): Promise<void> {
    const budget = this.config.budget;
    if (!budget) {
      return;
    }

    this.emitPhaseMarker(issueId, {
      phase: decision.phase,
      detail: decision.stopReasonDetail,
      attempt: running.retry_attempt,
      thread_id: running.thread_id,
      session_id: running.session_id
    });

    this.addRuntimeSecondsFromEntry(running);
    this.recordBudgetUsageSample(issueId, running.tokens.total_tokens, timestampMs);
    this.state.running.delete(issueId);
    this.state.health.last_error = decision.stopReasonDetail;

    if (budget.hard_limit_policy === 'block_requires_resume') {
      void this.scheduleBlockedInput({
        issue_id: issueId,
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
        stop_reason_code: decision.stopReasonCode,
        stop_reason_detail: decision.stopReasonDetail,
        session_console: running.recent_events,
        previous_thread_id: running.thread_id,
        previous_turn_id: running.turn_id,
        previous_session_id: running.session_id,
        required_actions: ['Increase budget and resume', 'Cancel and return to backlog'],
        budget: running.budget
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.state.health.last_error = `Budget hard limit block scheduling failed: ${message}`;
        this.logger?.log({
          level: 'error',
          event: CANONICAL_EVENT.budget.hardLimitExceeded,
          message: 'budget hard limit block scheduling failed',
          context: {
            issue_id: issueId,
            issue_identifier: running.identifier,
            error: message
          }
        });
      });
    } else {
      this.state.claimed.delete(issueId);
    }

    this.ports.notifyObservers?.();

    let terminationResult: WorkerTerminationResult;
    try {
      terminationResult = await this.ports.terminateWorker({
        issue_id: issueId,
        worker_handle: running.worker_handle,
        cleanup_workspace: false,
        reason: decision.stopReasonCode
      });
    } catch (error) {
      if (budget.hard_limit_policy === 'block_requires_resume') {
        const unknownResult = workerTerminationExceptionResult(error);
        this.updateBudgetBlockedTerminationEvidence(
          issueId,
          workerTerminationResultDetail(decision.stopReasonDetail, unknownResult),
          unknownResult
        );
      }
      throw error;
    }

    const terminalReasonDetail = workerTerminationResultDetail(decision.stopReasonDetail, terminationResult);
    if (budget.hard_limit_policy === 'block_requires_resume') {
      this.updateBudgetBlockedTerminationEvidence(issueId, terminalReasonDetail, terminationResult);
    }
    await this.completeRunRecord(running, 'failed', decision.stopReasonCode, null, terminalReasonDetail);
  }

  private updateBudgetBlockedTerminationEvidence(
    issueId: string,
    stopReasonDetail: string,
    terminationResult: WorkerTerminationResult
  ): void {
    const blockedEntry = this.state.blocked_inputs.get(issueId);
    if (
      !applyBudgetBlockedTerminationEvidence({
        blockedEntry,
        stopReasonDetail,
        terminationResult
      })
    ) {
      return;
    }
    void this.persistence?.upsertBlockedInput?.(issueId, JSON.stringify(blockedEntry));
    this.ports.notifyObservers?.();
  }

  private recordBudgetUsageSample(issueId: string, totalTokens: number, timestampMs: number): void {
    recordIssueBudgetUsageSample({
      budget: this.config.budget,
      budgetSamples: this.budgetUsageSamples(),
      nowMs: timestampMs,
      issueId,
      totalTokens,
      timestampMs
    });
  }

  private quarantineBlockedWorkerEvent(
    blockedEntry: BlockedEntry,
    workerEvent: WorkerObservabilityEvent,
    reason: 'awaiting_operator_latch' | 'lineage_mismatch'
  ): void {
    applyBlockedWorkerEventQuarantine(blockedEntry, workerEvent, reason);
    void this.persistence
      ?.upsertBlockedInput?.(blockedEntry.issue_id, JSON.stringify(blockedEntry))
      .catch(() => undefined);
    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.blockedWorkerEventQuarantined,
      message: 'worker event quarantined while awaiting operator action',
      context: {
        issue_id: blockedEntry.issue_id,
        issue_identifier: blockedEntry.issue_identifier,
        stop_reason_code: blockedEntry.stop_reason_code,
        quarantined_event: workerEvent.event,
        reason
      }
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.blockedWorkerEventQuarantined,
      severity: 'warn',
      issue_identifier: blockedEntry.issue_identifier,
      session_id: workerEvent.session_id,
      detail: `event=${workerEvent.event} reason=${reason}`
    });
    this.ports.notifyObservers?.();
  }

  private workerExitCoordinatorContext(): WorkerExitCoordinatorContext {
    return {
      state: this.state,
      config: this.config,
      ports: this.ports,
      persistence: this.persistence,
      logger: this.logger,
      nowMs: () => this.nowMs(),
      hooks: {
        normalStopForWorkerCompletion: (completionReason, refreshedState) =>
          this.normalStopForWorkerCompletion(completionReason, refreshedState),
        completeRunRecord: (runningEntry, terminalStatus, errorCode, recoveryOverride, terminalReasonDetail) =>
          this.completeRunRecord(runningEntry, terminalStatus, errorCode, recoveryOverride ?? null, terminalReasonDetail ?? null),
        scheduleRetry: (params) => this.scheduleRetry(params),
        scheduleBlockedInput: (params) => this.scheduleBlockedInput(params),
        clearCircuitBreaker: (issueId) => this.clearCircuitBreaker(issueId),
        scheduleRecoveryStartFailedBlock: (issueId, running, recoveryError) =>
          this.scheduleRecoveryStartFailedBlock(issueId, running, recoveryError),
        persistExecutionGraphStateTransition: (runningEntry, toStatus, status, reasonCode, reasonDetail) =>
          this.persistExecutionGraphStateTransition(runningEntry, toStatus, status, reasonCode, reasonDetail),
        emitPhaseMarker: (issueId, marker) => this.emitPhaseMarker(issueId, marker),
        recordRuntimeEvent: (params) => this.recordRuntimeEvent(params),
        addRuntimeSecondsFromEntry: (runningEntry) => this.addRuntimeSecondsFromEntry(runningEntry),
        recordBudgetUsageSample: (issueId, totalTokens, timestampMs) =>
          this.recordBudgetUsageSample(issueId, totalTokens, timestampMs),
        inferStopReasonCode: (stopError, fallback) => this.inferStopReasonCode(stopError, fallback),
        inferInputRequiredDetail: (inputError, fallbackReason) =>
          this.inferInputRequiredDetail(inputError, fallbackReason),
        inferWorkspaceConflictContext: (conflictError, fallbackReason) =>
          this.inferWorkspaceConflictContext(conflictError, fallbackReason)
      }
    };
  }

  async onWorkerExit(
    issue_id: string,
    reason: WorkerExitReason,
    error?: string,
    details: WorkerExitDetails = {}
  ): Promise<void> {
    await coordinateWorkerExit(this.workerExitCoordinatorContext(), issue_id, reason, error, details);
  }

  private async scheduleRecoveryStartFailedBlock(issueId: string, running: RunningEntry, error: string): Promise<void> {
    const { recovery, diagnostic, detail } = buildRecoveryStartFailedBlockDetails(running, error);

    await this.scheduleBlockedInput({
      issue_id: issueId,
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
      stop_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
      stop_reason_detail: detail,
      resolution_hints: diagnostic?.recommended_actions ?? [],
      required_actions: diagnostic?.recommended_actions ?? [],
      session_console: running.recent_events,
      previous_thread_id: diagnostic?.thread_id ?? running.thread_id,
      previous_turn_id: diagnostic?.turn_id ?? running.turn_id,
      previous_session_id: diagnostic?.session_id ?? running.session_id,
      last_progress_checkpoint_at: running.last_progress_transition_at_ms ?? running.started_at_ms,
      tool_output_wait: diagnostic,
      recovery
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.blockedInputScheduled,
      severity: 'warn',
      issue_identifier: running.identifier,
      session_id: diagnostic?.session_id ?? running.session_id ?? undefined,
      detail
    });
    await this.persistExecutionGraphStateTransition(
      running,
      'blocked',
      'blocked',
      REASON_CODES.missingToolOutputRecoveryStartFailed,
      detail
    );
  }

  private retryTimerCoordinatorContext(): RetryTimerCoordinatorContext {
    return {
      state: this.state,
      config: this.config,
      tracker: this.tracker,
      cancelRetryTimer: (timerHandle) => this.ports.cancelRetryTimer(timerHandle),
      getControlPlaneHealth: this.ports.getControlPlaneHealth
        ? () => this.ports.getControlPlaneHealth!()
        : undefined,
      getHostLoad: this.ports.getHostLoad ? () => this.ports.getHostLoad!() : undefined,
      logger: this.logger,
      nowMs: () => this.nowMs(),
      hooks: {
        scheduleRetry: (params) => this.scheduleRetry(params),
        scheduleBlockedInput: (params) => this.scheduleBlockedInput(params),
        dispatchIssue: (issue, attempt, resumeContext, graphContext) =>
          this.dispatchIssue(issue, attempt, resumeContext ?? null, graphContext),
        workspaceAttemptResidueResumeContext: (retryEntry) => this.workspaceAttemptResidueResumeContext(retryEntry),
        upsertCircuitBreaker: (entry) => this.upsertCircuitBreaker(entry),
        persistExecutionGraphRetryTransition: (retryEntry, toStatus, status, reasonCode, reasonDetail) =>
          this.persistExecutionGraphRetryTransition(retryEntry, toStatus, status, reasonCode, reasonDetail),
        recordRuntimeEvent: (params) => this.recordRuntimeEvent(params)
      }
    };
  }

  async onRetryTimer(issue_id: string): Promise<void> {
    await this.runSerializedOperation(async () => {
      const runtimeIdentityBlockerDetail = this.runtimeIdentityDispatchBlockerDetail();
      if (this.state.drain_mode.active || runtimeIdentityBlockerDetail) {
        const retryEntry = this.state.retry_attempts.get(issue_id);
        if (retryEntry) {
          this.ports.cancelRetryTimer(retryEntry.timer_handle);
          retryEntry.timer_handle = null;
          retryEntry.due_at_ms = this.nowMs();
          this.recordRuntimeEvent({
            event: CANONICAL_EVENT.runtime.drainRetryHeld,
            severity: 'info',
            issue_identifier: retryEntry.identifier,
            detail: runtimeIdentityBlockerDetail ?? 'retry dispatch held during drain mode'
          });
          this.refreshQuiescenceState();
          this.ports.notifyObservers?.();
        }
        return;
      }
      await coordinateRetryTimer(this.retryTimerCoordinatorContext(), issue_id);
      this.refreshQuiescenceState();
    });
  }

  private async upsertCircuitBreaker(entry: CircuitBreakerEntry): Promise<void> {
    this.state.circuit_breakers.set(entry.issue_id, { ...entry });
    await this.persistence?.upsertBreaker?.({
      issue_id: entry.issue_id,
      issue_identifier: entry.issue_identifier,
      breaker_active: entry.breaker_active,
      breaker_hit_count: entry.breaker_hit_count,
      breaker_window_minutes: entry.breaker_window_minutes,
      breaker_first_hit_at: entry.breaker_first_hit_at_ms ? new Date(entry.breaker_first_hit_at_ms).toISOString() : null,
      breaker_last_hit_at: entry.breaker_last_hit_at_ms ? new Date(entry.breaker_last_hit_at_ms).toISOString() : null
    });
  }

  private async clearCircuitBreaker(issueId: string): Promise<void> {
    this.state.circuit_breakers.delete(issueId);
    await this.persistence?.deleteBreaker?.(issueId);
  }

  private blockedInputCoordinatorContext(): BlockedInputCoordinatorContext {
    return {
      state: this.state,
      config: this.config,
      tracker: this.tracker,
      cancelRetryTimer: (timerHandle) => this.ports.cancelRetryTimer(timerHandle),
      submitBlockedIssueInputNative: this.ports.submitBlockedIssueInputNative
        ? (params) => this.ports.submitBlockedIssueInputNative!(params)
        : undefined,
      notifyObservers: this.ports.notifyObservers ? () => this.ports.notifyObservers!() : undefined,
      persistence: this.persistence,
      logger: this.logger,
      nowMs: () => this.nowMs(),
      hooks: {
        getLastPhaseMarker: (issueId) => this.getLastPhaseMarker(issueId),
        inferInputSchemaType: (questions) => this.inferInputSchemaType(questions),
        upsertCircuitBreaker: (entry) => this.upsertCircuitBreaker(entry),
        clearCircuitBreaker: (issueId) => this.clearCircuitBreaker(issueId),
        recordHistoryWriteFailure: (operation, reasonCode, error) =>
          this.recordHistoryWriteFailure(operation, reasonCode, error),
        captureProgressSignals: (params) => this.captureProgressSignals(params),
        dispatchIssue: (issue, attempt, resumeContext, graphContext) =>
          this.dispatchIssue(issue, attempt, resumeContext ?? null, graphContext),
        scheduleRetry: (params) => this.scheduleRetry(params),
        describeIssueRuntimeState: (issueId) => this.describeIssueRuntimeState(issueId),
        targetIdentifiersFromRuntimeState: (issueId, runtimeState) =>
          this.targetIdentifiersFromRuntimeState(issueId, runtimeState),
        recordOperatorAction: (issueId, action) => this.recordOperatorAction(issueId, action),
        recordRuntimeEvent: (params) => this.recordRuntimeEvent(params),
        refreshQuiescenceState: () => {
          this.refreshQuiescenceState();
        }
      }
    };
  }

  getCircuitBreakerSnapshot(): CircuitBreakerEntry[] {
    return Array.from(this.state.circuit_breakers.values()).map((entry) => ({ ...entry }));
  }

  getBlockedLatchDiagnostics(): {
    blocked_latch_active_count: number;
    blocked_event_quarantine_total: number;
    blocked_event_allowlist_total: number;
    blocked_event_reject_total: number;
    blocked_latch_violation_total: number;
  } {
    const blocked = Array.from(this.state.blocked_inputs.values());
    const quarantineTotal = blocked.reduce((sum, entry) => sum + (entry.quarantined_event_count ?? 0), 0);
    return {
      blocked_latch_active_count: blocked.filter((entry) => entry.awaiting_operator).length,
      blocked_event_quarantine_total: quarantineTotal,
      blocked_event_allowlist_total: 0,
      blocked_event_reject_total: 0,
      blocked_latch_violation_total: 0
    };
  }

  restoreSuppressionState(params: {
    blocked_entries: BlockedEntry[];
    breaker_entries: CircuitBreakerEntry[];
    operator_actions?: Map<string, OperatorActionRecord[]>;
  }): void {
    for (const entry of params.breaker_entries) {
      this.state.circuit_breakers.set(entry.issue_id, cloneCircuitBreakerEntry(entry));
    }
    for (const entry of params.blocked_entries) {
      this.state.blocked_inputs.set(entry.issue_id, cloneBlockedEntry(entry, { includeTranscriptToolCallDiagnostics: true }));
      this.state.claimed.add(entry.issue_id);
    }
    for (const [issueId, actions] of params.operator_actions ?? new Map<string, OperatorActionRecord[]>()) {
      this.state.operator_actions?.set(issueId, actions.map((action) => cloneOperatorAction(action)).slice(-20));
    }
  }

  async reconcileRunningIssues(): Promise<void> {
    await coordinateReconcileRunningIssues(this.reconciliationCoordinatorContext());
  }

  async reconcileBlockedInputs(): Promise<void> {
    await coordinateReconcileBlockedInputs(this.reconciliationCoordinatorContext());
  }

  updateCodexTimestamp(issue_id: string, timestampMs: number): void {
    const runningEntry = this.state.running.get(issue_id);
    if (!runningEntry) {
      return;
    }

    runningEntry.last_codex_timestamp_ms = timestampMs;
  }

  private async dispatchIssue(
    issue: Issue,
    attempt: number | null,
    resume_context: string | null = null,
    graphContext: DispatchGraphContext = {}
  ): Promise<void> {
    const runtimeIdentityBlockerDetail = this.runtimeIdentityDispatchBlockerDetail();
    if (this.state.drain_mode.active || runtimeIdentityBlockerDetail) {
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.runtime.drainDispatchSkipped,
        severity: 'info',
        issue_identifier: issue.identifier,
        detail: runtimeIdentityBlockerDetail ?? 'direct dispatch skipped during drain mode'
      });
      this.refreshQuiescenceState();
      this.ports.notifyObservers?.();
      return;
    }
    await coordinateDispatchIssue(this.dispatchCoordinatorContext(), issue, attempt, resume_context, graphContext);
  }

  private recordDuplicateDispatchSkipped(issue: Issue, retryAttempt: number): void {
    const runningEntry = this.state.running.get(issue.id);
    if (runningEntry) {
      const waitThresholdMs = this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000;
      const waitingStartedAtMs = runningEntry.running_waiting_started_at_ms ?? null;
      const lastMeaningfulActivityAtMs =
        waitingStartedAtMs !== null &&
        typeof runningEntry.last_progress_transition_at_ms === 'number' &&
        runningEntry.last_progress_transition_at_ms > waitingStartedAtMs
          ? runningEntry.last_progress_transition_at_ms
          : waitingStartedAtMs;
      if (
        runningEntry.stalled_waiting_reason === REASON_CODES.turnWaitingThresholdExceeded ||
        (waitThresholdMs > 0 &&
          lastMeaningfulActivityAtMs !== null &&
          this.nowMs() >= lastMeaningfulActivityAtMs + waitThresholdMs)
      ) {
        void this.maybeClassifyRunningWaitStall(issue.id, runningEntry, this.nowMs());
        return;
      }
    }
    const retryEntry = this.state.retry_attempts.get(issue.id);
    if (retryEntry?.stop_reason_code === REASON_CODES.turnWaitingThresholdExceeded) {
      return;
    }

    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.dispatchDuplicateSkipped,
      message: 'dispatch skipped: issue already has active runtime ownership',
      context: {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        retry_attempt: retryAttempt,
        runtime_state: JSON.stringify(this.describeIssueRuntimeState(issue.id))
      }
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.dispatchDuplicateSkipped,
      severity: 'warn',
      issue_identifier: issue.identifier,
      detail: 'issue already has active runtime ownership'
    });
  }

  private async terminateRunningIssue(issue_id: string, cleanup_workspace: boolean, reason: string): Promise<void> {
    await coordinateTerminateRunningIssue(this.runCompletionCoordinatorContext(), issue_id, cleanup_workspace, reason);
  }

  private async scheduleRetry(params: ScheduleRetryParams): Promise<void> {
    if (this.state.blocked_inputs.has(params.issue_id)) {
      this.state.blocked_inputs.delete(params.issue_id);
    }

    const existing = this.state.retry_attempts.get(params.issue_id);
    if (existing) {
      this.ports.cancelRetryTimer(existing.timer_handle);
      this.state.retry_attempts.delete(params.issue_id);
    }

    const delayMs =
      params.delay_ms ??
      (params.delay_type === 'continuation'
        ? 1000
        : params.delay_type === 'backpressure'
          ? getBackpressureRetryDelayMs(this.config)
          : computeFailureBackoffMs(params.attempt, this.config.max_retry_backoff_ms));

    const dueAtMs = this.nowMs() + delayMs;

    const timerHandle = this.ports.scheduleRetryTimer({
      issue_id: params.issue_id,
      due_at_ms: dueAtMs,
      callback: async () => {
        await this.onRetryTimer(params.issue_id);
      }
    });

    const resolvedProgressSignals = await this.captureProgressSignals({
      issue: params.issue_snapshot ?? null,
      issue_id: params.issue_id,
      branch_name: params.branch_name ?? null,
      repo_root: params.repo_root ?? null,
      previous_progress_signals: params.progress_signals ?? null
    });
    this.state.retry_attempts.set(params.issue_id, {
      issue_id: params.issue_id,
      identifier: params.identifier,
      attempt: params.attempt,
      issue_run_id: params.issue_run_id ?? null,
      previous_attempt_id: params.previous_attempt_id ?? null,
      due_at_ms: dueAtMs,
      error: params.error ?? null,
      worker_host: params.worker_host ?? null,
      workspace_path: params.workspace_path ?? null,
      provisioner_type: params.provisioner_type ?? null,
      branch_name: params.branch_name ?? null,
      repo_root: params.repo_root ?? null,
      workspace_exists: params.workspace_exists ?? false,
      workspace_git_status: params.workspace_git_status ?? null,
      workspace_provisioned: params.workspace_provisioned ?? false,
      workspace_is_git_worktree: params.workspace_is_git_worktree ?? false,
      copy_ignored_applied: params.copy_ignored_applied ?? false,
      copy_ignored_status: params.copy_ignored_status ?? null,
      copy_ignored_summary: params.copy_ignored_summary ?? null,
      stop_reason_code: params.stop_reason_code ?? null,
      stop_reason_detail: params.stop_reason_detail ?? null,
      previous_thread_id: params.previous_thread_id ?? null,
      previous_turn_id: params.previous_turn_id ?? null,
      previous_session_id: params.previous_session_id ?? null,
      last_progress_checkpoint_at: params.last_progress_checkpoint_at ?? null,
      last_phase: this.getLastPhaseMarker(params.issue_id)?.phase ?? null,
      last_phase_at_ms: this.getLastPhaseMarker(params.issue_id)?.at_ms ?? null,
      last_phase_detail: this.getLastPhaseMarker(params.issue_id)?.detail ?? null,
      progress_signals: resolvedProgressSignals,
      recover_workspace_attempt_residue: params.recover_workspace_attempt_residue ?? false,
      budget: params.budget ? { ...params.budget } : undefined,
      recovery: params.recovery ? { ...params.recovery } : null,
      timer_handle: timerHandle
    });

    this.state.claimed.add(params.issue_id);
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.retryScheduled,
      message: `retry scheduled (${params.delay_type})`,
      context: {
        issue_id: params.issue_id,
        issue_identifier: params.identifier,
        attempt: params.attempt,
        delay_type: params.delay_type,
        due_at_ms: dueAtMs,
        error: params.error ?? null,
        stop_reason_code: params.stop_reason_code ?? null
      }
    });
    this.refreshQuiescenceState();
  }

  private workspaceAttemptResidueResumeContext(retryEntry: RetryEntry): string | null {
    if (!retryEntry.recover_workspace_attempt_residue) {
      return null;
    }
    return [
      'Workspace attempt residue recovery:',
      '- The previous attempt left dirty files in this managed issue workspace.',
      '- Continue from the current workspace state instead of restarting.',
      '- First inspect `git status --short` and `git diff` / untracked files.',
      '- Run the ticket-required validation before committing.',
      '- Commit/push only if the dirty workspace matches the ticket scope; otherwise report the blocker.'
    ].join('\n');
  }

  private async scheduleBlockedInput(params: BlockedInputScheduleParams): Promise<{ created: boolean }> {
    return coordinateScheduleBlockedInput(this.blockedInputCoordinatorContext(), params);
  }

  private clearBlockedInput(issue_id: string, reason: string): void {
    coordinateClearBlockedInput(this.blockedInputCoordinatorContext(), issue_id, reason);
  }

  private async persistTicketBlocker(blockedEntry: BlockedEntry): Promise<void> {
    await coordinatePersistTicketBlocker(this.blockedInputCoordinatorContext(), blockedEntry);
  }

  private async persistBlockedInputEvent(blockedEntry: BlockedEntry): Promise<void> {
    await coordinatePersistBlockedInputEvent(this.blockedInputCoordinatorContext(), blockedEntry);
  }

  private ticketBlockerTypeForBlockedEntry(blockedEntry: BlockedEntry): string {
    return coordinateTicketBlockerTypeForBlockedEntry(blockedEntry);
  }

  private resolveBacklogStateName(): string {
    return coordinateResolveBacklogStateName(this.blockedInputCoordinatorContext());
  }

  private operatorControlCoordinatorContext(): OperatorControlCoordinatorContext {
    return {
      state: this.state,
      resolveProgressSignals: this.ports.resolveProgressSignals
        ? (params) => this.ports.resolveProgressSignals!(params)
        : undefined,
      notifyObservers: this.ports.notifyObservers ? () => this.ports.notifyObservers!() : undefined,
      persistence: this.persistence,
      nowMs: () => this.nowMs(),
      hooks: {
        getLastPhaseMarker: (issueId) => this.getLastPhaseMarker(issueId),
        terminateRunningIssue: (issueId, cleanupWorkspace, reason) =>
          this.terminateRunningIssue(issueId, cleanupWorkspace, reason),
        scheduleRetry: (params) => this.scheduleRetry(params),
        recordHistoryWriteFailure: (operation, reasonCode, error) =>
          this.recordHistoryWriteFailure(operation, reasonCode, error),
        clearCircuitBreaker: (issueId) => this.clearCircuitBreaker(issueId)
      }
    };
  }

  private async captureProgressSignals(params: {
    issue: Issue | null;
    issue_id: string;
    branch_name: string | null;
    repo_root: string | null;
    previous_progress_signals?: ProgressSignals | null;
  }): Promise<ProgressSignals> {
    return coordinateCaptureProgressSignals(this.operatorControlCoordinatorContext(), params);
  }

  async cancelCurrentTurn(
    issue_identifier: string,
    params: { actor?: string | null; reason_note?: string | null; confirmed?: boolean | null } = {}
  ): Promise<{ ok: true; issue_id: string } | { ok: false; code: string; message: string }> {
    return coordinateCancelCurrentTurn(this.operatorControlCoordinatorContext(), issue_identifier, params);
  }

  async requeueIssue(
    issue_identifier: string,
    params: { actor?: string | null; reason_note?: string | null; confirmed?: boolean | null } = {}
  ): Promise<{ ok: true; issue_id: string; retry_attempt: number } | { ok: false; code: string; message: string }> {
    return coordinateRequeueIssue(this.operatorControlCoordinatorContext(), issue_identifier, params);
  }

  async retryLastFailedStep(
    issue_identifier: string,
    params: { actor?: string | null; reason_note?: string | null } = {}
  ): Promise<{ ok: true; issue_id: string; retry_attempt: number } | { ok: false; code: string; message: string }> {
    return coordinateRetryLastFailedStep(this.operatorControlCoordinatorContext(), issue_identifier, params);
  }

  async clearAutomationFault(
    issue_identifier: string,
    params: { actor?: string | null; reason_note?: string | null } = {}
  ): Promise<
    | {
        ok: true;
        issue_id: string;
        status: 'started' | 'held';
        result_code: string;
        message: string;
        dispatch_started: boolean;
        breaker_cleared: boolean;
      }
    | { ok: false; code: string; message: string }
  > {
    const reasonNote = typeof params.reason_note === 'string' ? params.reason_note.trim() : '';
    if (!reasonNote) {
      return { ok: false, code: 'reason_note_required', message: 'reason_note is required' };
    }

    const breaker = Array.from(this.state.circuit_breakers.values()).find(
      (entry) => entry.issue_identifier === issue_identifier && entry.breaker_active
    );
    if (!breaker) {
      return { ok: false, code: 'issue_not_automation_fault', message: `Issue ${issue_identifier} has no active automation fault` };
    }

    if (
      this.state.running.has(breaker.issue_id) ||
      this.state.retry_attempts.has(breaker.issue_id) ||
      this.state.blocked_inputs.has(breaker.issue_id)
    ) {
      const preState = this.describeIssueRuntimeState(breaker.issue_id);
      this.recordOperatorAction(breaker.issue_id, {
        action: 'clear_automation_fault',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: 'unsupported_transition',
        message: 'existing runtime state must use its normal operator action',
        actor: params.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(breaker.issue_id)
      });
      return {
        ok: false,
        code: 'unsupported_transition',
        message: `Issue ${issue_identifier} is running, retrying, or blocked on operator input`
      };
    }

    const preState = this.describeIssueRuntimeState(breaker.issue_id);
    const hold = (resultCode: string, message: string) => {
      this.recordOperatorAction(breaker.issue_id, {
        action: 'clear_automation_fault',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: resultCode,
        message,
        actor: params.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(breaker.issue_id)
      });
      this.ports.notifyObservers?.();
      return {
        ok: true as const,
        issue_id: breaker.issue_id,
        status: 'held' as const,
        result_code: resultCode,
        message,
        dispatch_started: false,
        breaker_cleared: false
      };
    };

    const preflight = this.ports.dispatchPreflight();
    if (!preflight.dispatch_allowed) {
      this.state.health.dispatch_validation = 'failed';
      this.state.health.last_error = preflight.reason ?? 'dispatch preflight rejected dispatch';
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.orchestration.dispatchValidationFailed,
        severity: 'warn',
        issue_identifier,
        detail: this.state.health.last_error ?? undefined
      });
      return hold('dispatch_validation_failed', this.state.health.last_error ?? 'dispatch validation failed');
    }
    this.state.health.dispatch_validation = 'ok';
    this.state.health.last_error = null;

    const runtimeIdentityBlocker = this.runtimeIdentityDispatchBlockerDetail();
    if (this.state.drain_mode.active || runtimeIdentityBlocker) {
      const resultCode = runtimeIdentityBlocker ? 'runtime_identity_dispatch_blocked' : 'drain_mode_active';
      return hold(resultCode, runtimeIdentityBlocker ?? 'Drain Mode is active; automation fault recovery is held until drain exits');
    }

    let refreshedIssues: Issue[];
    try {
      refreshedIssues = await this.tracker.fetch_issue_states_by_ids([breaker.issue_id]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to refresh issue state';
      this.recordOperatorAction(breaker.issue_id, {
        action: 'clear_automation_fault',
        requested_at_ms: this.nowMs(),
        result: 'failed',
        result_code: 'tracker_state_refresh_failed',
        message,
        actor: params.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(breaker.issue_id)
      });
      return { ok: false, code: 'tracker_state_refresh_failed', message };
    }

    const issue = refreshedIssues.find((entry) => entry.id === breaker.issue_id);
    if (!issue) {
      this.recordOperatorAction(breaker.issue_id, {
        action: 'clear_automation_fault',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: 'issue_not_found',
        message: `Issue ${issue_identifier} no longer exists in tracker`,
        actor: params.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(breaker.issue_id)
      });
      return { ok: false, code: 'issue_not_found', message: `Issue ${issue_identifier} no longer exists in tracker` };
    }

    const eligibility = shouldDispatchIssue(issue, this.state, this.config, { skipClaimCheckForIssueId: issue.id });
    if (!eligibility.eligible) {
      return hold(eligibility.reason, `Issue ${issue.identifier} is not dispatchable: ${eligibility.reason}`);
    }
    if ((this.config.github_linking_mode ?? 'off') === 'required' && issue.has_github_issue_link !== true) {
      return hold('github_issue_link_missing', `Issue ${issue.identifier} is missing a linked GitHub issue`);
    }

    await this.clearCircuitBreaker(issue.id);
    this.state.redispatch_progress?.delete(issue.id);
    this.state.claimed.delete(issue.id);
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.automationFaultCleared,
      severity: 'info',
      issue_identifier: issue.identifier,
      detail: reasonNote,
      reason_code: REASON_CODES.operatorClearAutomationFault
    });
    await this.dispatchIssue(issue, null, 'Operator cleared automation fault and requested redispatch');
    const resultCode = this.state.running.has(issue.id) ? REASON_CODES.dispatchStarted : REASON_CODES.operatorClearAutomationFault;
    this.recordOperatorAction(issue.id, {
      action: 'clear_automation_fault',
      requested_at_ms: this.nowMs(),
      result: 'accepted',
      result_code: resultCode,
      message: 'automation fault cleared and redispatch requested',
      actor: params.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState,
      post_state: this.describeIssueRuntimeState(issue.id)
    });
    this.ports.notifyObservers?.();
    return {
      ok: true,
      issue_id: issue.id,
      status: 'started',
      result_code: resultCode,
      message: 'automation fault cleared and redispatch requested',
      dispatch_started: this.state.running.has(issue.id),
      breaker_cleared: true
    };
  }

  async resumeBlockedIssue(
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
    return coordinateResumeBlockedIssue(
      this.blockedInputCoordinatorContext(),
      issue_identifier,
      resume_context,
      resume_override_reason,
      operator_context,
      resume_metadata
    );
  }

  async cancelBlockedIssue(
    issue_identifier: string,
    cancel_reason: string | null = null,
    operator_context: { actor?: string | null; reason_note?: string | null; confirmed?: boolean | null } | null = null
  ): Promise<{ ok: true; issue_id: string; moved_to_state: string } | { ok: false; code: string; message: string }> {
    return coordinateCancelBlockedIssue(this.blockedInputCoordinatorContext(), issue_identifier, cancel_reason, operator_context);
  }

  async submitBlockedIssueInput(params: {
    issue_identifier: string;
    request_id: string;
    actor?: string | null;
    reason_note?: string | null;
    answer: { question_id?: string; option_label?: string; text?: string };
  }): Promise<
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
    return coordinateSubmitBlockedIssueInput(this.blockedInputCoordinatorContext(), params);
  }

  private async submitBlockedIssueInputNative(
    blocked: BlockedEntry,
    params: { issue_identifier: string; request_id: string; answer: { question_id?: string; option_label?: string; text?: string } }
  ): Promise<SubmitBlockedIssueInputNativeResult> {
    return coordinateSubmitBlockedIssueInputNative(this.blockedInputCoordinatorContext(), blocked, params);
  }

  private buildOperatorInputResumeContext(
    blocked: BlockedEntry,
    answer: { question_id?: string; option_label?: string; text?: string }
  ): string {
    return coordinateBuildOperatorInputResumeContext(blocked, answer);
  }

  getPhaseMarkerSettings(): PhaseMarkerSettings {
    return { ...this.phaseSettings };
  }

  private getLastPhaseMarker(issue_id: string): PhaseMarker | null {
    const timeline = this.state.phase_timeline?.get(issue_id);
    return timeline && timeline.length > 0 ? timeline[timeline.length - 1] ?? null : null;
  }

  private emitExplicitPhaseMarker(issue_id: string, workerEvent: WorkerObservabilityEvent): boolean {
    const running = this.state.running.get(issue_id);
    const markerBase = {
      at_ms: workerEvent.timestamp_ms,
      detail: workerEvent.detail ?? null,
      attempt: running?.retry_attempt ?? 0,
      thread_id: workerEvent.thread_id ?? running?.thread_id ?? null,
      session_id: workerEvent.session_id ?? running?.session_id ?? null
    };

    switch (workerEvent.event) {
      case CANONICAL_EVENT.codex.promptSent:
        this.emitPhaseMarker(issue_id, { ...markerBase, phase: 'prompt_sent' });
        return true;
      case CANONICAL_EVENT.codex.phasePlanning:
        this.emitPhaseMarker(issue_id, { ...markerBase, phase: 'planning' });
        return true;
      case CANONICAL_EVENT.codex.phaseImplementation:
        this.emitPhaseMarker(issue_id, { ...markerBase, phase: 'implementation' });
        return true;
      case CANONICAL_EVENT.codex.phaseValidation:
        this.emitPhaseMarker(issue_id, { ...markerBase, phase: 'validation' });
        return true;
      default:
        return false;
    }
  }

  private emitMappedPhaseMarker(issue_id: string, workerEvent: WorkerObservabilityEvent): void {
    const running = this.state.running.get(issue_id);
    const mapped =
      workerEvent.event === CANONICAL_EVENT.agentRunner.turnCancelled &&
      running?.termination &&
      successfulWorkflowTerminationProjection(running.termination.reason)
        ? 'completed'
        : this.mapPhaseForWorkerEvent(workerEvent.event);
    if (!mapped) {
      return;
    }
    this.emitPhaseMarker(issue_id, {
      at_ms: workerEvent.timestamp_ms,
      phase: mapped,
      detail: workerEvent.detail ?? null,
      attempt: running?.retry_attempt ?? 0,
      thread_id: workerEvent.thread_id ?? running?.thread_id ?? null,
      session_id: workerEvent.session_id ?? running?.session_id ?? null
    });
  }

  private mapPhaseForWorkerEvent(eventName: string): PhaseMarkerName | null {
    switch (eventName) {
      case CANONICAL_EVENT.codex.sessionStarted:
        return REASON_CODES.codexSessionStarted;
      case CANONICAL_EVENT.codex.turnStarted:
        return 'codex_turn_started';
      case CANONICAL_EVENT.codex.turnWaiting:
        return 'planning';
      case CANONICAL_EVENT.codex.toolCallCompleted:
        return 'implementation';
      case CANONICAL_EVENT.codex.turnCompleted:
        return 'validation';
      case CANONICAL_EVENT.agentRunner.turnStarted:
        return 'planning';
      case CANONICAL_EVENT.agentRunner.activity:
        return 'implementation';
      case CANONICAL_EVENT.agentRunner.turnCompleted:
        return 'completed';
      case CANONICAL_EVENT.agentRunner.turnFailed:
      case CANONICAL_EVENT.agentRunner.turnTimedOut:
        return 'failed';
      case CANONICAL_EVENT.agentRunner.turnCancelled:
        return 'failed';
      case CANONICAL_EVENT.codex.turnFailed:
        return 'failed';
      case CANONICAL_EVENT.codex.turnInputRequired:
        return 'blocked_input';
      default:
        return null;
    }
  }

  private emitPhaseMarker(
    issue_id: string,
    marker: {
      at_ms?: number;
      phase: PhaseMarkerName | string;
      detail: string | null;
      attempt: number;
      thread_id?: string | null;
      session_id?: string | null;
    }
  ): void {
    if (!this.phaseSettings.enabled) {
      return;
    }
    if (!isKnownPhaseMarker(marker.phase)) {
      this.phaseSettings.last_emit_error_code = 'unknown_phase';
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.orchestration.phaseMarkerIgnored,
        message: 'phase marker ignored: unknown phase',
        context: { issue_id, phase: marker.phase, attempt: marker.attempt }
      });
      return;
    }
    const timeline = this.state.phase_timeline?.get(issue_id) ?? [];
    const lastForAttempt = this.getLastPhaseMarkerForAttempt(timeline, marker.attempt);
    if (
      lastForAttempt &&
      (isTerminalPhaseMarker(lastForAttempt.phase) || phaseMarkerOrder(marker.phase) <= phaseMarkerOrder(lastForAttempt.phase))
    ) {
      this.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.orchestration.phaseMarkerIgnored,
        message: 'phase marker ignored: non-monotonic or terminal',
        context: { issue_id, phase: marker.phase, previous_phase: lastForAttempt.phase, attempt: marker.attempt }
      });
      return;
    }
    const next: PhaseMarker = {
      at_ms: marker.at_ms ?? this.nowMs(),
      phase: marker.phase,
      detail: marker.detail,
      attempt: marker.attempt,
      thread_id: marker.thread_id ?? null,
      session_id: marker.session_id ?? null
    };
    timeline.push(next);
    if (timeline.length > this.phaseSettings.timeline_limit) {
      timeline.splice(0, timeline.length - this.phaseSettings.timeline_limit);
    }
    this.state.phase_timeline?.set(issue_id, timeline);
    const running = this.state.running.get(issue_id);
    if (running) {
      running.current_phase = next.phase;
      running.current_phase_at_ms = next.at_ms;
      running.phase_detail = next.detail;
    }
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.phaseMarkerEmitted,
      message: 'phase marker emitted',
      context: {
        issue_id,
        phase: next.phase,
        attempt: next.attempt,
        thread_id: next.thread_id,
        session_id: next.session_id
      }
    });
  }

  private getLastPhaseMarkerForAttempt(timeline: PhaseMarker[], attempt: number): PhaseMarker | null {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const marker = timeline[index];
      if (marker?.attempt === attempt) {
        return marker;
      }
    }
    return null;
  }

  private inferStopReasonCode(error: string | undefined, fallback: string): string {
    if (!error) {
      return fallback;
    }

    const workspaceConflictPayload = this.parseWorkspaceConflictPayload(error);
    if (workspaceConflictPayload?.code === REASON_CODES.operatorWorkspaceConflict) {
      return REASON_CODES.operatorWorkspaceConflict;
    }

    const normalized = error.toLowerCase();
    if (normalized.includes(REASON_CODES.turnInputRequired)) {
      return REASON_CODES.turnInputRequired;
    }
    if (normalized.includes(REASON_CODES.issueStateRefreshFailed)) {
      return REASON_CODES.issueStateRefreshFailed;
    }
    if (normalized.includes(REASON_CODES.freshDispatchNoRoute)) {
      return REASON_CODES.freshDispatchNoRoute;
    }
    if (normalized.includes(REASON_CODES.claudeSandboxRuntimeFailed)) {
      return REASON_CODES.claudeSandboxRuntimeFailed;
    }
    if (normalized.includes('claude_permission_denied_under_sandbox')) {
      return REASON_CODES.claudePermissionDenied;
    }
    if (normalized.includes(REASON_CODES.unsafeWorkspaceRoot)) {
      return REASON_CODES.unsafeWorkspaceRoot;
    }
    if (normalized.includes(REASON_CODES.workspaceEmpty)) {
      return REASON_CODES.workspaceEmpty;
    }
    if (
      normalized.includes('workspace_unprovisioned_conflict') ||
      normalized.includes('worktree_branch_conflict')
    ) {
      return REASON_CODES.operatorWorkspaceConflict;
    }

    return fallback;
  }

  private inferWorkspaceConflictContext(error: string | undefined, fallbackReason: string): WorkspaceConflictContext {
    const defaultDetail = error ?? `worker exited: ${fallbackReason}`;
    const defaultHints = [
      'Resolve workspace git conflicts in the issue worktree.',
      'Ensure the workspace branch/worktree mapping matches repository state.',
      'Resume the blocked issue explicitly after conflicts are resolved.'
    ];
    if (!error) {
      return { detail: defaultDetail, conflict_files: [], resolution_hints: defaultHints };
    }

    const payload = this.parseWorkspaceConflictPayload(error);
    if (payload) {
      return {
        detail: payload.detail ?? defaultDetail,
        conflict_files: payload.conflict_files,
        classification_summary: payload.classification_summary,
        resolution_hints: payload.resolution_hints.length > 0 ? payload.resolution_hints : defaultHints
      };
    }

    const inferredConflictFiles = this.inferWorkspaceConflictFiles(defaultDetail);
    return { detail: defaultDetail, conflict_files: inferredConflictFiles, resolution_hints: defaultHints };
  }

  private inferWorkspaceConflictFiles(detail: string): Array<{ path: string; status: 'staged' | 'unstaged' | 'unknown' }> {
    const normalized = detail.toLowerCase();
    if (normalized.includes('worktree_branch_conflict')) {
      return [{ path: '.git/HEAD', status: 'unknown' }];
    }
    if (normalized.includes('workspace path is not a managed git worktree')) {
      return [{ path: '.git', status: 'unknown' }];
    }
    if (normalized.includes('workspace path exists but branch cannot be inspected')) {
      return [{ path: '.git/HEAD', status: 'unknown' }];
    }
    if (normalized.includes('workspace path exists but is not a managed git worktree')) {
      return [{ path: '.git', status: 'unknown' }];
    }

    return [];
  }

  private parseWorkspaceConflictPayload(error: string): {
    code: string | null;
    detail: string | null;
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
  } | null {
    const prefix = 'workspace_conflict:';
    if (!error.toLowerCase().startsWith(prefix)) {
      return null;
    }
    const rawDetail = error.slice(prefix.length).trim();
    try {
      const payload = JSON.parse(rawDetail) as {
        code?: string;
        detail?: string;
        conflict_files?: Array<{ path?: string; status?: string; classification?: string }>;
        classification_summary?: { ephemeral?: number; tracked_ephemeral?: number; unknown_non_ephemeral?: number };
        resolution_hints?: string[];
      };
      return {
        code: typeof payload.code === 'string' ? payload.code : null,
        detail: typeof payload.detail === 'string' ? payload.detail : null,
        conflict_files: (payload.conflict_files ?? [])
          .filter((file) => typeof file?.path === 'string' && file.path.trim().length > 0)
          .map((file) => ({
            path: String(file.path),
            status: file?.status === 'staged' || file?.status === 'unstaged' ? file.status : 'unknown',
            classification:
              file.classification === 'ephemeral' ||
              file.classification === 'tracked_ephemeral' ||
              file.classification === 'unknown_non_ephemeral'
                ? file.classification
                : undefined
          })),
        classification_summary: payload.classification_summary
          ? {
              ephemeral: Number(payload.classification_summary.ephemeral ?? 0),
              tracked_ephemeral: Number(payload.classification_summary.tracked_ephemeral ?? 0),
              unknown_non_ephemeral: Number(payload.classification_summary.unknown_non_ephemeral ?? 0)
            }
          : undefined,
        resolution_hints: (payload.resolution_hints ?? []).filter(
          (hint): hint is string => typeof hint === 'string' && hint.trim().length > 0
        )
      };
    } catch {
      return null;
    }
  }

  private inferInputRequiredDetail(
    error: string | undefined,
    fallbackReason: string
  ): {
    detail: string;
    request_id: string | null;
    request_method: string | null;
    prompt_text: string | null;
    questions: Array<{ id: string; prompt?: string; options?: Array<{ label: string; value?: string }> }>;
  } {
    if (!error) {
      return {
        detail: `worker exited: ${fallbackReason}`,
        request_id: null,
        request_method: null,
        prompt_text: null,
        questions: []
      };
    }
    const prefix = `${REASON_CODES.turnInputRequired}:`;
    if (error.toLowerCase().startsWith(prefix)) {
      const rawDetail = error.slice(prefix.length).trim() || 'input_required_unanswerable';
      try {
        const payload = JSON.parse(rawDetail) as {
          detail?: string;
          request_id?: string;
          request_method?: string;
          prompt_text?: string | null;
          questions?: Array<{ id?: string; prompt?: string; options?: Array<{ label?: string; value?: string }> }>;
        };
        return {
          detail: payload.detail ?? 'input_required_unanswerable',
          request_id: payload.request_id ?? null,
          request_method: payload.request_method ?? null,
          prompt_text: payload.prompt_text ?? null,
          questions: Array.isArray(payload.questions)
            ? payload.questions
                .filter((question) => Boolean(question?.id))
                .map((question) => ({
                  id: String(question.id),
                  ...(question?.prompt ? { prompt: String(question.prompt) } : {}),
                  ...(Array.isArray(question?.options)
                    ? {
                        options: question.options
                          .filter((option) => Boolean(option?.label))
                          .map((option) => ({
                            label: String(option.label),
                            ...(option?.value ? { value: String(option.value) } : {})
                          }))
                      }
                    : {})
                }))
            : []
        };
      } catch {
        return {
          detail: rawDetail,
          request_id: null,
          request_method: null,
          prompt_text: null,
          questions: []
        };
      }
    }
    return {
      detail: error,
      request_id: null,
      request_method: null,
      prompt_text: null,
      questions: []
    };
  }

  private inferInputSchemaType(
    questions: Array<{ id: string; prompt?: string; options?: Array<{ label: string; value?: string }> }>
  ): 'options' | 'text' | 'unknown' {
    if (questions.some((question) => Array.isArray(question.options) && question.options.length > 0)) {
      return 'options';
    }
    if (questions.length > 0) {
      return 'text';
    }
    return 'unknown';
  }

  private addRuntimeSecondsFromEntry(runningEntry: RunningEntry): void {
    coordinateAddRuntimeSecondsFromEntry(this.runCompletionCoordinatorContext(), runningEntry);
  }

  private describeIssueRuntimeState(issueId: string): Record<string, unknown> {
    return coordinateDescribeIssueRuntimeState(this.operatorControlCoordinatorContext(), issueId);
  }

  private recordOperatorAction(issueId: string, action: OperatorActionRecord): void {
    coordinateRecordOperatorAction(this.operatorControlCoordinatorContext(), issueId, action);
  }

  private targetIdentifiersFromRuntimeState(
    issueId: string,
    runtimeState: Record<string, unknown>
  ): NonNullable<OperatorActionRecord['target_identifiers']> {
    return coordinateTargetIdentifiersFromRuntimeState(issueId, runtimeState);
  }

  private maybeEmitTokenTelemetryWarning(runningEntry: RunningEntry, eventAtMs: number): void {
    if (runningEntry.token_telemetry_status === 'available' || runningEntry.token_telemetry_warning_emitted) {
      return;
    }

    const turnStartedAtMs = runningEntry.token_telemetry_turn_started_at_ms;
    if (turnStartedAtMs === null) {
      return;
    }

    const thresholdMs = this.config.no_telemetry_warning_threshold_ms ?? 120_000;
    if (thresholdMs <= 0 || eventAtMs - turnStartedAtMs < thresholdMs) {
      return;
    }

    runningEntry.token_telemetry_warning_emitted = true;
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.codex.tokenTelemetryMissingThresholdExceeded,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: `token_telemetry_status=${runningEntry.token_telemetry_status} elapsed_ms=${eventAtMs - turnStartedAtMs}`
    });
  }

  private resetRunningWaitEpisode(runningEntry: RunningEntry, progressAtMs: number): void {
    coordinateResetRunningWaitEpisode(runningEntry, progressAtMs);
  }

  private isMeaningfulWorkerProgressEvent(workerEvent: WorkerObservabilityEvent): boolean {
    return coordinateIsMeaningfulWorkerProgressEvent(workerEvent);
  }

  private updateOutstandingToolCalls(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): void {
    if (workerEvent.event === CANONICAL_EVENT.codex.toolCallStarted) {
      const callId = this.resolveToolCallId(workerEvent);
      if (!callId) {
        return;
      }
      this.applyToolCallLedgerObservation(runningEntry, {
        kind: 'function_call',
        call_id: callId,
        tool_name: this.resolveToolName(workerEvent),
        thread_id: workerEvent.thread_id ?? runningEntry.thread_id ?? null,
        turn_id: workerEvent.turn_id ?? runningEntry.turn_id ?? null,
        session_id: workerEvent.session_id ?? runningEntry.session_id ?? null,
        observed_at_ms: workerEvent.timestamp_ms,
        last_agent_message: runningEntry.last_message ?? null,
        evidence_source: workerEvent.tool_call_evidence_source ?? 'worker_event'
      });
      return;
    }

    if (
      workerEvent.event === CANONICAL_EVENT.codex.toolCallCompleted ||
      workerEvent.event === CANONICAL_EVENT.codex.toolCallFailed ||
      workerEvent.event === CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch ||
      workerEvent.event === CANONICAL_EVENT.codex.unsupportedToolCall
    ) {
      const callId = this.resolveToolCallId(workerEvent);
      if (!callId) {
        return;
      }
      this.applyToolCallLedgerObservation(runningEntry, {
        kind: 'function_call_output',
        call_id: callId,
        tool_name: workerEvent.tool_name ?? null,
        thread_id: workerEvent.thread_id ?? runningEntry.thread_id ?? null,
        turn_id: workerEvent.turn_id ?? runningEntry.turn_id ?? null,
        session_id: workerEvent.session_id ?? runningEntry.session_id ?? null,
        observed_at_ms: workerEvent.timestamp_ms,
        evidence_source: workerEvent.tool_call_evidence_source ?? 'worker_event'
      });
      return;
    }

    if (workerEvent.event === CANONICAL_EVENT.codex.turnWaiting && runningEntry.outstanding_tool_calls) {
      for (const call of Object.values(runningEntry.outstanding_tool_calls)) {
        call.last_waiting_at_ms = workerEvent.timestamp_ms;
        call.last_agent_message = workerEvent.detail ?? runningEntry.last_message ?? call.last_agent_message;
      }
    }
  }

  private applyToolCallLedgerObservation(runningEntry: RunningEntry, observation: ToolCallLedgerObservation): void {
    const callId = observation.call_id.trim();
    if (!callId) {
      return;
    }

    const ledgerEntry = this.upsertToolCallLedgerEntry(runningEntry, observation, callId);
    if (observation.kind === 'function_call_output') {
      if (runningEntry.outstanding_tool_calls) {
        delete runningEntry.outstanding_tool_calls[callId];
      }
      return;
    }

    const calls = runningEntry.outstanding_tool_calls ?? {};
    const existing = calls[callId];
    if (!existing && ledgerEntry.completion_status === 'completed') {
      return;
    }
    calls[callId] = {
      call_id: callId,
      tool_name: ledgerEntry.tool_name,
      thread_id: ledgerEntry.thread_id,
      turn_id: ledgerEntry.turn_id,
      session_id: ledgerEntry.session_id,
      started_at_ms: existing?.started_at_ms ?? ledgerEntry.first_seen_at_ms,
      last_waiting_at_ms: existing?.last_waiting_at_ms ?? null,
      last_agent_message: observation.last_agent_message ?? runningEntry.last_message ?? existing?.last_agent_message ?? null,
      evidence_source: existing?.evidence_source ?? ledgerEntry.start_evidence_source ?? observation.evidence_source
    };
    runningEntry.outstanding_tool_calls = calls;
  }

  private upsertToolCallLedgerEntry(
    runningEntry: RunningEntry,
    observation: ToolCallLedgerObservation,
    callId: string
  ): ToolCallLedgerEntry {
    const ledger = (runningEntry.tool_call_ledger ??= {});
    const existing = ledger[callId];
    const toolName =
      observation.tool_name?.trim() ||
      existing?.tool_name ||
      runningEntry.outstanding_tool_calls?.[callId]?.tool_name ||
      'unknown_tool';
    const evidenceSources = existing?.evidence_sources ? [...existing.evidence_sources] : [];
    if (!evidenceSources.includes(observation.evidence_source)) {
      evidenceSources.push(observation.evidence_source);
    }

    const firstSeenAtMs = existing ? Math.min(existing.first_seen_at_ms, observation.observed_at_ms) : observation.observed_at_ms;
    const lastSeenAtMs = existing ? Math.max(existing.last_seen_at_ms, observation.observed_at_ms) : observation.observed_at_ms;
    const completionStatus =
      observation.kind === 'function_call_output' || existing?.completion_status === 'completed' ? 'completed' : 'pending';
    const completedAtMs =
      observation.kind === 'function_call_output'
        ? existing?.completed_at_ms
          ? Math.min(existing.completed_at_ms, observation.observed_at_ms)
          : observation.observed_at_ms
        : existing?.completed_at_ms ?? null;

    const entry: ToolCallLedgerEntry = {
      call_id: callId,
      tool_name: toolName,
      thread_id: existing?.thread_id ?? observation.thread_id ?? runningEntry.thread_id ?? null,
      turn_id: existing?.turn_id ?? observation.turn_id ?? runningEntry.turn_id ?? null,
      session_id: existing?.session_id ?? observation.session_id ?? runningEntry.session_id ?? null,
      issue_id: runningEntry.issue.id,
      issue_identifier: runningEntry.identifier,
      run_id: runningEntry.run_id ?? null,
      issue_run_id: runningEntry.issue_run_id ?? null,
      attempt_id: runningEntry.attempt_id ?? null,
      first_seen_at_ms: firstSeenAtMs,
      last_seen_at_ms: lastSeenAtMs,
      completed_at_ms: completedAtMs,
      completion_status: completionStatus,
      evidence_sources: evidenceSources,
      start_evidence_source:
        existing?.start_evidence_source ?? (observation.kind === 'function_call' ? observation.evidence_source : null),
      completion_evidence_source:
        observation.kind === 'function_call_output'
          ? observation.evidence_source
          : existing?.completion_evidence_source ?? null,
      last_agent_message:
        observation.last_agent_message ?? runningEntry.last_message ?? existing?.last_agent_message ?? null
    };
    ledger[callId] = entry;
    return entry;
  }

  private resolveToolCallId(workerEvent: WorkerObservabilityEvent): string | null {
    const explicit = workerEvent.tool_call_id?.trim();
    if (explicit) {
      return explicit;
    }

    const detail = workerEvent.detail?.trim();
    if (!detail) {
      return null;
    }
    const mismatch = parseDynamicToolCapabilityMismatchDetail(detail);
    if (mismatch?.call_id) {
      return mismatch.call_id;
    }
    const match = detail.match(/\b(?:call_id|callId|id)=([^\s,]+)/);
    return match?.[1] ?? null;
  }

  private resolveToolName(workerEvent: WorkerObservabilityEvent): string {
    const explicit = workerEvent.tool_name?.trim();
    if (explicit) {
      return explicit;
    }
    const detail = workerEvent.detail?.trim();
    return detail && detail.length > 0 ? detail : 'unknown_tool';
  }

  private maybeEmitHeartbeatOnly(issueId: string, runningEntry: RunningEntry, observedAtMs: number): void {
    coordinateMaybeEmitHeartbeatOnly(this.runningWaitCoordinatorContext(), issueId, runningEntry, observedAtMs);
  }

  private async maybeClassifyRunningWaitStall(
    issueId: string,
    runningEntry: RunningEntry,
    observedAtMs: number
  ): Promise<boolean> {
    return coordinateMaybeClassifyRunningWaitStall(this.runningWaitCoordinatorContext(), issueId, runningEntry, observedAtMs);
  }

  private captureWorkerProgressSignal(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): void {
    coordinateCaptureWorkerProgressSignal(this.runningWaitCoordinatorContext(), runningEntry, workerEvent);
  }

  private markRunningWaitStallRootCauseIfThresholdExceeded(runningEntry: RunningEntry, observedAtMs: number): void {
    coordinateMarkRunningWaitStallRootCauseIfThresholdExceeded(this.runningWaitCoordinatorContext(), runningEntry, observedAtMs);
  }

  private hasOutstandingToolCallEvidence(runningEntry: RunningEntry): boolean {
    return coordinateHasOutstandingToolCallEvidence(runningEntry);
  }

  private findMissingToolOutputCandidate(
    runningEntry: RunningEntry,
    observedAtMs: number,
    waitThresholdMs: number
  ) {
    return coordinateFindMissingToolOutputCandidate(runningEntry, observedAtMs, waitThresholdMs);
  }

  private scanCodexSessionTranscriptForToolCalls(runningEntry: RunningEntry, observedAtMs: number): void {
    coordinateScanCodexSessionTranscriptForToolCalls(this.missingToolOutputCoordinatorContext(), runningEntry, observedAtMs);
  }

  private async recoverOrBlockMissingToolOutput(
    issueId: string,
    runningEntry: RunningEntry,
    missingToolOutput: NonNullable<ReturnType<typeof coordinateFindMissingToolOutputCandidate>>,
    observedAtMs: number
  ): Promise<void> {
    await coordinateRecoverOrBlockMissingToolOutput(
      this.missingToolOutputCoordinatorContext(),
      issueId,
      runningEntry,
      missingToolOutput,
      observedAtMs
    );
  }

  private workerTerminationAllowsRecovery(result: WorkerTerminationResult): boolean {
    return coordinateWorkerTerminationAllowsRecovery(result);
  }

  private workerTerminationInterruptStatus(
    result: WorkerTerminationResult
  ): NonNullable<MissingToolOutputRecoveryState['interrupt_cancel_result']>['status'] {
    return coordinateWorkerTerminationInterruptStatus(result);
  }

  private async completeRunRecord(
    runningEntry: RunningEntry,
    terminal_status: 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'cancelled',
    error_code: string | null,
    recoveryOverride: MissingToolOutputRecoveryState | null = null,
    terminalReasonDetail: string | null = null
  ): Promise<void> {
    await coordinateCompleteRunRecord(
      this.runCompletionCoordinatorContext(),
      runningEntry,
      terminal_status,
      error_code,
      recoveryOverride,
      terminalReasonDetail
    );
  }


  private recordRuntimeEvent(params: {
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
    protocol_warning?: import('../codex').CodexProtocolWarningEvidence;
    model_reroute?: import('../codex').CodexModelRerouteEvidence | null;
    requested_model?: string | null;
    effective_model?: string | null;
  }): void {
    this.state.recent_runtime_events.push({
      at_ms: this.nowMs(),
      event: params.event,
      severity: params.severity,
      issue_identifier: params.issue_identifier,
      session_id: params.session_id,
      detail: params.detail,
      ...(params.reason_code !== undefined ? { reason_code: params.reason_code } : {}),
      ...(params.request_method !== undefined ? { request_method: params.request_method } : {}),
      ...(params.request_category !== undefined ? { request_category: params.request_category } : {}),
      ...(params.tool_call_id !== undefined ? { tool_call_id: params.tool_call_id } : {}),
      ...(params.tool_name !== undefined ? { tool_name: params.tool_name } : {}),
      ...(params.protocol_warning !== undefined ? { protocol_warning: { ...params.protocol_warning } } : {}),
      ...(params.model_reroute !== undefined
        ? { model_reroute: params.model_reroute ? { ...params.model_reroute } : null }
        : {}),
      ...(params.requested_model !== undefined ? { requested_model: params.requested_model } : {}),
      ...(params.effective_model !== undefined ? { effective_model: params.effective_model } : {})
    });
    if (this.state.recent_runtime_events.length > 50) {
      this.state.recent_runtime_events.splice(0, this.state.recent_runtime_events.length - 50);
    }
  }

  private selectWorkerHost(): string | null {
    const configuredHosts = this.config.worker_hosts ?? [];
    if (!configuredHosts.length) {
      return null;
    }

    if (!this.config.max_concurrent_agents_per_host || this.config.max_concurrent_agents_per_host <= 0) {
      const host = configuredHosts[this.hostRoundRobinIndex % configuredHosts.length] ?? configuredHosts[0];
      this.hostRoundRobinIndex = (this.hostRoundRobinIndex + 1) % configuredHosts.length;
      return host ?? null;
    }

    const hostLimit = this.config.max_concurrent_agents_per_host;
    const currentByHost = new Map<string, number>();
    for (const entry of this.state.running.values()) {
      if (!entry.worker_host) {
        continue;
      }
      currentByHost.set(entry.worker_host, (currentByHost.get(entry.worker_host) ?? 0) + 1);
    }

    for (let offset = 0; offset < configuredHosts.length; offset += 1) {
      const idx = (this.hostRoundRobinIndex + offset) % configuredHosts.length;
      const candidate = configuredHosts[idx];
      if ((currentByHost.get(candidate) ?? 0) < hostLimit) {
        this.hostRoundRobinIndex = (idx + 1) % configuredHosts.length;
        return candidate;
      }
    }

    return null;
  }
}
