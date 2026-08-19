import type { Issue } from '../../tracker';
import { createHash } from 'node:crypto';
import type { StructuredLogger } from '../../observability';
import { CANONICAL_EVENT } from '../../observability/events';
import { REASON_CODES } from '../../observability/reason-codes';
import { parseDynamicToolCapabilityMismatchDetail } from '../../observability/dynamic-tool-capability';
import { redactUnknown } from '../../security/redaction';
import type { HistoryPayloadClass } from '../../persistence';
import type {
  OrchestratorOptions,
  OrchestratorPersistencePort,
  RetryEntry,
  RunningEntry,
  WorkerObservabilityEvent
} from '../types';

type ExecutionGraphStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
type ExecutionGraphTransitionStatus = ExecutionGraphStatus | 'retrying';
type TicketReferenceKind = 'branch' | 'pull_request' | 'review' | 'merge' | 'evidence';

export interface DispatchGraphContext {
  issue_run_id?: string | null;
  previous_attempt_id?: string | null;
  previous_thread_id?: string | null;
  previous_turn_id?: string | null;
  previous_session_id?: string | null;
  recover_workspace_attempt_residue?: boolean;
}

interface AppServerLiteSummary {
  payload_class: HistoryPayloadClass;
  summary: string;
  summary_fields: Record<string, unknown>;
  unavailable_reason_code?: string | null;
}

interface PersistenceFailureContext {
  persistence?: OrchestratorPersistencePort;
  logger?: StructuredLogger;
  recordHistoryWriteFailure: (operation: string, reasonCode: string, error: unknown) => Promise<void>;
}

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function truncateLogValue(value: string, maxLength = 240): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function persistenceErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return truncateLogValue(String(redactUnknown(error.message)));
  }
  if (typeof error === 'string') {
    return truncateLogValue(String(redactUnknown(error)));
  }
  return null;
}

function persistenceErrorName(error: unknown): string | null {
  return error instanceof Error ? error.name : null;
}

function persistenceErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : null;
}

function classifyPersistenceFailure(error: unknown): string {
  const message = persistenceErrorMessage(error)?.toLowerCase() ?? '';
  const code = persistenceErrorCode(error)?.toLowerCase() ?? '';
  if (message.includes('foreign key') || message.includes('does not exist')) {
    return 'referential_integrity';
  }
  if (message.includes('unique') || message.includes('constraint') || code.includes('constraint')) {
    return 'constraint_violation';
  }
  if (message.includes('monotonic') || message.includes('ended_at')) {
    return 'timestamp_ordering';
  }
  return 'write_failed';
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export async function recordHistoryWriteFailure(
  persistence: OrchestratorOptions['persistence'],
  operation: string,
  reasonCode: string,
  error: unknown
): Promise<void> {
  try {
    await persistence?.recordHistoryWriteFailure?.({
      operation,
      reason_code: reasonCode,
      detail: persistenceErrorMessage(error)
    });
  } catch {
    // The original write failure remains the primary diagnostic.
  }
}

function appServerLiteSourceEventId(workerEvent: WorkerObservabilityEvent): string {
  const hash = createHash('sha256')
    .update(workerEvent.event)
    .update('\0')
    .update(String(workerEvent.timestamp_ms))
    .update('\0')
    .update(workerEvent.thread_id ?? '')
    .update('\0')
    .update(workerEvent.turn_id ?? '')
    .update('\0')
    .update(workerEvent.session_id ?? '')
    .update('\0')
    .update(workerEvent.tool_call_id ?? '')
    .update('\0')
    .update(workerEvent.request_method ?? '')
    .digest('hex')
    .slice(0, 20);
  return `worker_event:${hash}`;
}

function appServerLiteSummaryForWorkerEvent(workerEvent: WorkerObservabilityEvent): AppServerLiteSummary | null {
  const baseFields: Record<string, unknown> = {
    event: workerEvent.event,
    reason_code: workerEvent.reason_code ?? null,
    thread_id_available: Boolean(workerEvent.thread_id),
    turn_id_available: Boolean(workerEvent.turn_id),
    session_id_available: Boolean(workerEvent.session_id)
  };

  if (workerEvent.request_method || workerEvent.request_category) {
    return {
      payload_class: 'protocol_request_response',
      summary: `${workerEvent.event}: ${workerEvent.request_method ?? 'unknown method'}`,
      summary_fields: {
        ...baseFields,
        protocol_event_category: 'request_response',
        request_method: workerEvent.request_method ?? null,
        request_category: workerEvent.request_category ?? null
      }
    };
  }

  if (workerEvent.protocol_warning) {
    return {
      payload_class: 'protocol_lifecycle',
      summary: `${workerEvent.protocol_warning.reason_code}: ${workerEvent.protocol_warning.method}`,
      summary_fields: {
        ...baseFields,
        protocol_event_category: 'warning',
        method: workerEvent.protocol_warning.method,
        warning_reason_code: workerEvent.protocol_warning.reason_code,
        severity: workerEvent.protocol_warning.severity
      }
    };
  }

  if (workerEvent.model_reroute) {
    return {
      payload_class: 'protocol_lifecycle',
      summary: `${workerEvent.model_reroute.reason_code}: model rerouted`,
      summary_fields: {
        ...baseFields,
        protocol_event_category: 'model_signal',
        requested_model: workerEvent.model_reroute.requested_model,
        effective_model: workerEvent.model_reroute.effective_model,
        model_reason_code: workerEvent.model_reroute.reason_code
      }
    };
  }

  if (workerEvent.usage || workerEvent.provider_usage || workerEvent.rate_limits || workerEvent.token_telemetry_status) {
    return {
      payload_class: 'protocol_lifecycle',
      summary: `${workerEvent.event}: token/rate/model telemetry`,
      summary_fields: {
        ...baseFields,
        protocol_event_category: 'token_rate_signal',
        usage: workerEvent.usage ?? null,
        provider_usage: workerEvent.provider_usage ?? null,
        token_telemetry_status: workerEvent.token_telemetry_status ?? null,
        token_telemetry_last_source: workerEvent.token_telemetry_last_source ?? null,
        rate_limits: workerEvent.rate_limits ?? null,
        requested_model: workerEvent.requested_model ?? null,
        effective_model: workerEvent.effective_model ?? null
      }
    };
  }

  if (workerEvent.tool_call_id || workerEvent.tool_name || workerEvent.event === CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch) {
    return {
      payload_class: 'tool_payload',
      summary: `${workerEvent.event}: ${workerEvent.tool_name ?? workerEvent.tool_call_id ?? 'tool event'}`,
      summary_fields: {
        ...baseFields,
        protocol_event_category: 'dynamic_tool',
        tool_call_id: workerEvent.tool_call_id ?? null,
        tool_name: workerEvent.tool_name ?? null,
        evidence_source: workerEvent.tool_call_evidence_source ?? null
      },
      unavailable_reason_code: 'tool_payload_payload_not_stored'
    };
  }

  if (
    workerEvent.event === CANONICAL_EVENT.codex.turnStarted ||
    workerEvent.event === CANONICAL_EVENT.codex.turnCompleted ||
    workerEvent.event === CANONICAL_EVENT.codex.turnFailed ||
    workerEvent.event === CANONICAL_EVENT.codex.turnCancelled ||
    workerEvent.event === CANONICAL_EVENT.codex.turnInputRequired
  ) {
    return {
      payload_class: 'protocol_lifecycle',
      summary: workerEvent.event,
      summary_fields: {
        ...baseFields,
        protocol_event_category: 'terminal_event',
        terminal_source: workerEvent.terminal_source ?? null
      }
    };
  }

  return null;
}

function executionGraphStatusForWorkerEvent(eventName: string): ExecutionGraphStatus {
  switch (eventName) {
    case CANONICAL_EVENT.codex.turnCompleted:
    case CANONICAL_EVENT.agentRunner.turnCompleted:
    case CANONICAL_EVENT.codex.toolCallCompleted:
      return 'succeeded';
    case CANONICAL_EVENT.codex.turnFailed:
    case CANONICAL_EVENT.agentRunner.turnFailed:
    case CANONICAL_EVENT.agentRunner.turnTimedOut:
    case CANONICAL_EVENT.codex.toolCallFailed:
    case CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch:
    case CANONICAL_EVENT.codex.unsupportedToolCall:
      return 'failed';
    case CANONICAL_EVENT.codex.turnInputRequired:
      return 'blocked';
    case CANONICAL_EVENT.codex.turnCancelled:
    case CANONICAL_EVENT.agentRunner.turnCancelled:
      return 'cancelled';
    default:
      return 'running';
  }
}

function reasonCodeForWorkerEvent(eventName: string): string {
  if (eventName === CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch) {
    return REASON_CODES.unsupportedDynamicToolConsoleResume;
  }
  return eventName.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function phaseSpanNameForWorkerEvent(eventName: string): string | null {
  switch (eventName) {
    case CANONICAL_EVENT.codex.promptSent:
      return 'prompt_sent';
    case CANONICAL_EVENT.codex.phasePlanning:
    case CANONICAL_EVENT.codex.turnWaiting:
    case CANONICAL_EVENT.agentRunner.sessionStarted:
      return 'planning';
    case CANONICAL_EVENT.codex.phaseImplementation:
    case CANONICAL_EVENT.agentRunner.activity:
      return 'implementation';
    case CANONICAL_EVENT.codex.phaseValidation:
    case CANONICAL_EVENT.codex.turnCompleted:
      return 'validation';
    case CANONICAL_EVENT.agentRunner.turnCompleted:
      return 'completed';
    case CANONICAL_EVENT.codex.turnFailed:
    case CANONICAL_EVENT.agentRunner.turnFailed:
    case CANONICAL_EVENT.agentRunner.turnTimedOut:
    case CANONICAL_EVENT.agentRunner.turnCancelled:
      return 'failed';
    case CANONICAL_EVENT.codex.turnInputRequired:
      return 'blocked_input';
    default:
      return null;
  }
}

function toolNameForWorkerEvent(workerEvent: WorkerObservabilityEvent): string | null {
  if (
    workerEvent.event !== CANONICAL_EVENT.codex.toolCallCompleted &&
    workerEvent.event !== CANONICAL_EVENT.codex.toolCallStarted &&
    workerEvent.event !== CANONICAL_EVENT.codex.toolCallFailed &&
    workerEvent.event !== CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch &&
    workerEvent.event !== CANONICAL_EVENT.codex.unsupportedToolCall
  ) {
    return null;
  }
  const explicit = workerEvent.tool_name?.trim();
  if (explicit) {
    return explicit;
  }
  const mismatch = parseDynamicToolCapabilityMismatchDetail(workerEvent.detail);
  if (mismatch?.attempted_tool_name) {
    return mismatch.attempted_tool_name;
  }
  const detail = workerEvent.detail?.trim();
  return detail && detail.length > 0 ? detail : 'unknown_tool';
}

function transitionStatusForWorkerEvent(eventName: string): string | null {
  switch (eventName) {
    case CANONICAL_EVENT.codex.turnStarted:
    case CANONICAL_EVENT.agentRunner.turnStarted:
      return 'running';
    case CANONICAL_EVENT.codex.turnInputRequired:
      return 'blocked';
    case CANONICAL_EVENT.codex.turnCompleted:
    case CANONICAL_EVENT.agentRunner.turnCompleted:
      return 'succeeded';
    case CANONICAL_EVENT.codex.turnFailed:
    case CANONICAL_EVENT.agentRunner.turnFailed:
    case CANONICAL_EVENT.agentRunner.turnTimedOut:
      return 'failed';
    case CANONICAL_EVENT.codex.turnCancelled:
    case CANONICAL_EVENT.agentRunner.turnCancelled:
      return 'cancelled';
    default:
      return null;
  }
}

function shouldPersistTokenModelFact(workerEvent: WorkerObservabilityEvent): boolean {
  return Boolean(
    workerEvent.usage ||
      workerEvent.provider_usage ||
      workerEvent.model_reroute !== undefined ||
      workerEvent.requested_model !== undefined ||
      workerEvent.effective_model !== undefined
  );
}

function tokenModelFactSource(workerEvent: WorkerObservabilityEvent): string {
  return (
    workerEvent.token_telemetry_last_source ??
    workerEvent.model_reroute?.source ??
    workerEvent.provider_usage?.source ??
    (workerEvent.usage ? 'worker_event_usage' : 'worker_event_model')
  );
}

function tokenModelFactConfidence(
  workerEvent: WorkerObservabilityEvent
): 'observed_live' | 'backfilled' | 'provider_step' | 'provider_result' | 'legacy_partial' | 'missing' {
  if (workerEvent.provider_usage) return workerEvent.provider_usage.confidence;
  if (workerEvent.token_telemetry_status === 'unavailable') {
    return 'missing';
  }
  return workerEvent.usage ||
    workerEvent.provider_usage ||
    workerEvent.model_reroute ||
    workerEvent.requested_model ||
    workerEvent.effective_model
    ? 'observed_live'
    : 'missing';
}

function stableProviderFactId(
  runningEntry: RunningEntry,
  threadId: string | null,
  turnId: string | null,
  kind: 'invocation' | 'model',
  model: string | null = null
): string {
  const digest = createHash('sha256')
    .update(runningEntry.issue_run_id ?? '')
    .update('\0')
    .update(runningEntry.attempt_id ?? '')
    .update('\0')
    .update(threadId ?? '')
    .update('\0')
    .update(turnId ?? '')
    .update('\0')
    .update(kind)
    .update('\0')
    .update(model ?? '')
    .digest('hex');
  return `claude_${kind}:${digest}`;
}

function phaseSpanKeysForRunningEntry(
  persistedPhaseSpanKeys: WeakMap<RunningEntry, Set<string>>,
  runningEntry: RunningEntry
): Set<string> {
  let keys = persistedPhaseSpanKeys.get(runningEntry);
  if (!keys) {
    keys = new Set();
    persistedPhaseSpanKeys.set(runningEntry, keys);
  }
  return keys;
}

export function beginExecutionGraphWorkerTurnObservation(
  runningEntry: RunningEntry,
  workerEvent: WorkerObservabilityEvent
): boolean {
  const observedTurnId = workerEvent.turn_id ?? runningEntry.turn_id;
  const observedThreadId = workerEvent.thread_id ?? runningEntry.thread_id;
  const persistedTurnIds = (runningEntry.persisted_turn_ids ??= []);
  const pendingTurnIds = (runningEntry.pending_persisted_turn_ids ??= []);
  const turnAlreadyObserved = Boolean(
    observedTurnId && (persistedTurnIds.includes(observedTurnId) || pendingTurnIds.includes(observedTurnId))
  );
  const startsTurn =
    workerEvent.event === CANONICAL_EVENT.agentRunner.turnStarted ||
    workerEvent.event === CANONICAL_EVENT.codex.turnStarted;
  const startsGenericProcess = workerEvent.event === CANONICAL_EVENT.agentRunner.processStarted;
  if ((startsGenericProcess || startsTurn) && !observedThreadId) {
    const observedAt = asIso(workerEvent.timestamp_ms);
    const current = runningEntry.pending_execution_graph_thread_started_at;
    runningEntry.pending_execution_graph_thread_started_at = !current || observedAt < current ? observedAt : current;
  }
  const turnIndices = (runningEntry.execution_graph_turn_indices ??= {});
  if (startsTurn && observedTurnId && turnIndices[observedTurnId] === undefined) {
    turnIndices[observedTurnId] = Math.max(0, runningEntry.turn_count - 1);
  }
  if (startsTurn && observedTurnId && !observedThreadId) {
    runningEntry.pending_execution_graph_turn = {
      turn_id: observedTurnId,
      turn_index: turnIndices[observedTurnId] ?? 0,
      started_at: asIso(workerEvent.timestamp_ms)
    };
  }
  if (startsTurn && observedThreadId && observedTurnId && !turnAlreadyObserved) {
    pendingTurnIds.push(observedTurnId);
  }
  // Process/session/activity events may carry future lineage, but only an
  // authoritative turn-start event may reserve and create a durable turn.
  return turnAlreadyObserved || !startsTurn;
}

function markExecutionGraphWorkerTurnPersisted(runningEntry: RunningEntry, turnId: string): void {
  const persistedTurnIds = (runningEntry.persisted_turn_ids ??= []);
  if (!persistedTurnIds.includes(turnId)) {
    persistedTurnIds.push(turnId);
  }
  clearPendingExecutionGraphWorkerTurn(runningEntry, turnId);
}

function clearPendingExecutionGraphWorkerTurn(runningEntry: RunningEntry, turnId: string): void {
  const pending = runningEntry.pending_persisted_turn_ids;
  if (!pending) {
    return;
  }
  runningEntry.pending_persisted_turn_ids = pending.filter((entry) => entry !== turnId);
}

function executionGraphPersistenceFailureContext(
  issueId: string,
  runningEntry: RunningEntry,
  workerEvent: WorkerObservabilityEvent,
  operation: string,
  error: unknown
): Record<string, string | number | boolean | null> {
  return {
    issue_id: issueId,
    issue_identifier: runningEntry.identifier,
    session_id: runningEntry.session_id,
    active_thread_id: runningEntry.thread_id,
    active_turn_id: runningEntry.turn_id,
    event_thread_id: workerEvent.thread_id ?? null,
    event_turn_id: workerEvent.turn_id ?? null,
    event_timestamp: asIso(workerEvent.timestamp_ms),
    event: workerEvent.event,
    persistence_operation: operation,
    failure_kind: classifyPersistenceFailure(error),
    error_name: persistenceErrorName(error),
    error_code: persistenceErrorCode(error),
    error_message: persistenceErrorMessage(error)
  };
}

async function persistTicketReference(params: {
  runningEntry: RunningEntry;
  reference_kind: TicketReferenceKind;
  availability: 'available' | 'unavailable' | 'unknown';
  uri: string | null;
  label: string | null;
  external_id: string | null;
  state: string | null;
  metadata: Record<string, unknown> | null;
  observed_at: string;
  persistence?: OrchestratorPersistencePort;
}): Promise<void> {
  await params.persistence?.appendTicketReference?.({
    issue_run_id: params.runningEntry.issue_run_id ?? null,
    attempt_id: params.runningEntry.attempt_id ?? null,
    thread_id: params.runningEntry.thread_id ?? null,
    turn_id: params.runningEntry.turn_id ?? null,
    reference_kind: params.reference_kind,
    availability: params.availability,
    uri: params.uri,
    label: params.label,
    external_id: params.external_id,
    state: params.state,
    metadata: params.metadata,
    observed_at: params.observed_at
  });
}

export async function persistOperationalFactsForIssue(params: {
  issue: Issue;
  runningEntry: RunningEntry;
  observedAt: string;
} & PersistenceFailureContext): Promise<void> {
  const { issue, runningEntry, observedAt, persistence, logger } = params;
  if (!persistence || !runningEntry.issue_run_id) {
    return;
  }

  const trackerKind = issue.tracker_meta?.tracker_kind ?? 'unknown';
  const assigneeIdentifier = firstNonEmpty(issue.tracker_meta?.assignee?.id, issue.tracker_meta?.assignee?.name);
  const projectIdentifier = firstNonEmpty(
    issue.tracker_meta?.project?.slug,
    issue.tracker_meta?.project?.id,
    issue.tracker_meta?.project?.name
  );
  const teamIdentifier = firstNonEmpty(issue.tracker_meta?.team?.key, issue.tracker_meta?.team?.id, issue.tracker_meta?.team?.name);

  try {
    await persistence.appendTrackerTicketSnapshot?.({
      issue_run_id: runningEntry.issue_run_id,
      attempt_id: runningEntry.attempt_id ?? null,
      thread_id: runningEntry.thread_id ?? null,
      turn_id: runningEntry.turn_id ?? null,
      tracker_kind: trackerKind,
      remote_issue_id: issue.id,
      human_issue_identifier: issue.identifier,
      title: issue.title,
      tracker_status: issue.state,
      labels: issue.labels,
      assignee_status: assigneeIdentifier ? 'available' : issue.tracker_meta?.assignee === null ? 'unavailable' : 'unknown',
      assignee_identifier: assigneeIdentifier,
      assignee_reason: assigneeIdentifier ? null : issue.tracker_meta?.assignee === null ? 'tracker_assignee_unavailable' : 'tracker_assignee_unobserved',
      project_status: projectIdentifier ? 'available' : issue.tracker_meta?.project === null ? 'unavailable' : 'unknown',
      project_identifier: projectIdentifier,
      project_reason: projectIdentifier ? null : issue.tracker_meta?.project === null ? 'tracker_project_unavailable' : 'tracker_project_unobserved',
      team_status: teamIdentifier ? 'available' : issue.tracker_meta?.team === null ? 'unavailable' : 'unknown',
      team_identifier: teamIdentifier,
      team_reason: teamIdentifier ? null : issue.tracker_meta?.team === null ? 'tracker_team_unavailable' : 'tracker_team_unobserved',
      observed_at: observedAt
    });
    await persistTicketReference({
      runningEntry,
      reference_kind: 'branch',
      availability: issue.branch_name ? 'available' : 'unavailable',
      uri: issue.branch_name ? `git-branch:${issue.branch_name}` : null,
      label: issue.branch_name,
      external_id: issue.branch_name,
      state: issue.branch_name ? 'observed' : 'unavailable',
      metadata: issue.branch_name ? { branch_name: issue.branch_name } : { reason: 'tracker_branch_unavailable' },
      observed_at: observedAt,
      persistence
    });
    const prLinks = issue.tracker_meta?.pr_links ?? [];
    if (prLinks.length === 0) {
      await persistTicketReference({
        runningEntry,
        reference_kind: 'pull_request',
        availability: 'unknown',
        uri: null,
        label: null,
        external_id: null,
        state: null,
        metadata: { reason: 'tracker_pr_unobserved' },
        observed_at: observedAt,
        persistence
      });
      await persistTicketReference({
        runningEntry,
        reference_kind: 'review',
        availability: 'unknown',
        uri: null,
        label: null,
        external_id: null,
        state: null,
        metadata: { reason: 'review_state_unobserved' },
        observed_at: observedAt,
        persistence
      });
      await persistTicketReference({
        runningEntry,
        reference_kind: 'merge',
        availability: 'unknown',
        uri: null,
        label: null,
        external_id: null,
        state: null,
        metadata: { reason: 'merge_state_unobserved' },
        observed_at: observedAt,
        persistence
      });
    }
    for (const pr of prLinks) {
      await persistTicketReference({
        runningEntry,
        reference_kind: 'pull_request',
        availability: 'available',
        uri: pr.url,
        label: `PR #${pr.number}`,
        external_id: String(pr.number),
        state: pr.state,
        metadata: { merged: pr.merged, repository: issue.tracker_meta?.repository ?? null },
        observed_at: observedAt,
        persistence
      });
      await persistTicketReference({
        runningEntry,
        reference_kind: 'review',
        availability: 'unknown',
        uri: pr.url,
        label: `PR #${pr.number}`,
        external_id: String(pr.number),
        state: null,
        metadata: { reason: 'review_state_unobserved' },
        observed_at: observedAt,
        persistence
      });
      await persistTicketReference({
        runningEntry,
        reference_kind: 'merge',
        availability: pr.merged ? 'available' : 'unknown',
        uri: pr.url,
        label: `PR #${pr.number}`,
        external_id: String(pr.number),
        state: pr.merged ? 'merged' : pr.state,
        metadata: { merged: pr.merged },
        observed_at: observedAt,
        persistence
      });
    }
  } catch (error) {
    await params.recordHistoryWriteFailure('appendOperationalHistoryFacts', REASON_CODES.dispatchStarted, error);
    logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.persistence.recordEventFailed,
      message: `failed to persist operational history facts for ${issue.identifier}`,
      context: {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        issue_run_id: runningEntry.issue_run_id,
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

export async function persistExecutionGraphWorkerEvent(params: {
  issueId: string;
  runningEntry: RunningEntry;
  workerEvent: WorkerObservabilityEvent;
  turnAlreadyObserved: boolean;
  persistedPhaseSpanKeys: WeakMap<RunningEntry, Set<string>>;
} & PersistenceFailureContext): Promise<void> {
  const { issueId, runningEntry, workerEvent, turnAlreadyObserved, persistence, logger, persistedPhaseSpanKeys } = params;
  if (!persistence || !runningEntry.issue_run_id || !runningEntry.attempt_id) {
    const skippedTurnId = workerEvent.turn_id ?? runningEntry.turn_id;
    if (skippedTurnId) {
      clearPendingExecutionGraphWorkerTurn(runningEntry, skippedTurnId);
    }
    return;
  }

  let operation = 'unknown';
  try {
    const at = asIso(workerEvent.timestamp_ms);
    const threadId = workerEvent.thread_id ?? runningEntry.thread_id;
    const turnId = workerEvent.turn_id ?? runningEntry.turn_id;
    if (!threadId) {
      if (shouldPersistTokenModelFact(workerEvent)) {
        operation = 'appendTokenModelFact';
        await persistence.appendTokenModelFact?.({
          token_model_fact_id: workerEvent.agent_runtime === 'claude-cli'
            ? stableProviderFactId(runningEntry, null, null, 'invocation')
            : undefined,
          issue_run_id: runningEntry.issue_run_id,
          attempt_id: runningEntry.attempt_id,
          thread_id: null,
          turn_id: null,
          requested_model: workerEvent.requested_model ?? runningEntry.requested_model ?? null,
          effective_model: workerEvent.effective_model ?? runningEntry.effective_model ?? null,
          model_source: tokenModelFactSource(workerEvent),
          input_tokens: workerEvent.usage?.input_tokens ?? workerEvent.provider_usage?.input_tokens ?? null,
          output_tokens: workerEvent.usage?.output_tokens ?? workerEvent.provider_usage?.output_tokens ?? null,
          cached_input_tokens: workerEvent.usage?.cached_input_tokens ?? workerEvent.provider_usage?.cache_read_tokens ?? null,
          cache_creation_input_tokens: workerEvent.provider_usage?.cache_creation_tokens ?? null,
          reasoning_output_tokens: workerEvent.usage?.reasoning_output_tokens ?? null,
          total_tokens: workerEvent.usage?.total_tokens ?? null,
          model_context_window: workerEvent.usage?.model_context_window ?? null,
          runtime_provider: workerEvent.agent_runtime ?? null,
          provider_turn_count: workerEvent.provider_usage?.provider_turn_count ?? null,
          estimated_cost_usd: workerEvent.provider_usage?.estimated_cost_usd ?? null,
          provider_usage_status: workerEvent.provider_usage?.status ?? null,
          provider_usage_source: workerEvent.provider_usage?.source ?? null,
          api_retry_count: workerEvent.provider_usage?.api_retry_count ?? null,
          permission_denial_count: workerEvent.provider_usage?.permission_denial_count ?? null,
          unknown_event_count: workerEvent.provider_usage?.unknown_event_count ?? null,
          auxiliary_result_count: workerEvent.provider_usage?.auxiliary_result_count ?? null,
          effective_models: workerEvent.provider_usage?.effective_models ?? null,
          tool_counts: workerEvent.provider_usage?.tool_counts ?? null,
          mcp_counts: workerEvent.provider_usage?.mcp_counts ?? null,
          missing_reason: workerEvent.provider_usage?.missing_reason ?? null,
          nested_session_detected: workerEvent.provider_usage?.nested_session_detected ?? null,
          supervised_session_coverage: workerEvent.provider_usage?.supervised_session_coverage ?? null,
          telemetry_confidence: tokenModelFactConfidence(workerEvent),
          observed_at: workerEvent.provider_usage?.updated_at ?? at
        });
      }
      return;
    }

    if (
      threadId &&
      (
        runningEntry.persisted_thread_id !== threadId ||
        workerEvent.event === CANONICAL_EVENT.agentRunner.processStarted ||
        workerEvent.event === CANONICAL_EVENT.agentRunner.sessionStarted ||
        workerEvent.event === CANONICAL_EVENT.agentRunner.turnStarted ||
        workerEvent.event === CANONICAL_EVENT.codex.turnStarted
      )
    ) {
      operation = 'appendThread';
      await persistence.appendThread?.({
        attempt_id: runningEntry.attempt_id,
        thread_id: threadId,
        session_id: workerEvent.session_id ?? runningEntry.session_id,
        agent_runtime: workerEvent.agent_runtime ?? runningEntry.agent_runtime ?? null,
        worker_instance_id: workerEvent.worker_instance_id ?? runningEntry.worker_instance_id ?? null,
        worker_process_pid: workerEvent.worker_process_pid ?? workerEvent.codex_app_server_pid ?? null,
        started_at: runningEntry.pending_execution_graph_thread_started_at ?? at,
        status: 'running',
        reason_code: REASON_CODES.codexSessionStarted,
        reason_detail: workerEvent.session_id ?? runningEntry.session_id
      });
      runningEntry.persisted_thread_id = threadId;
    }

    const startsTurn =
      workerEvent.event === CANONICAL_EVENT.agentRunner.turnStarted ||
      workerEvent.event === CANONICAL_EVENT.codex.turnStarted;
    if (startsTurn && threadId && turnId && !turnAlreadyObserved) {
      operation = 'appendTurn';
      await persistence.appendTurn?.({
        thread_id: threadId,
        turn_id: turnId,
        turn_index: runningEntry.execution_graph_turn_indices?.[turnId] ?? Math.max(0, runningEntry.turn_count - 1),
        started_at: at,
        status: executionGraphStatusForWorkerEvent(workerEvent.event),
        reason_code: reasonCodeForWorkerEvent(workerEvent.event),
        reason_detail: workerEvent.detail ?? null
      });
      markExecutionGraphWorkerTurnPersisted(runningEntry, turnId);
    }
    const bufferedTurn = runningEntry.pending_execution_graph_turn;
    if (
      workerEvent.event === CANONICAL_EVENT.agentRunner.sessionStarted &&
      threadId &&
      turnId &&
      bufferedTurn?.turn_id === turnId &&
      !(runningEntry.persisted_turn_ids ?? []).includes(turnId)
    ) {
      operation = 'appendTurn';
      await persistence.appendTurn?.({
        thread_id: threadId,
        turn_id: turnId,
        turn_index: bufferedTurn.turn_index,
        started_at: bufferedTurn.started_at,
        status: 'running',
        reason_code: reasonCodeForWorkerEvent(CANONICAL_EVENT.agentRunner.turnStarted),
        reason_detail: null
      });
      markExecutionGraphWorkerTurnPersisted(runningEntry, turnId);
      operation = 'appendStateTransition';
      await persistence.appendStateTransition?.({
        issue_run_id: runningEntry.issue_run_id,
        attempt_id: runningEntry.attempt_id,
        thread_id: threadId,
        turn_id: turnId,
        from_status: null,
        to_status: 'running',
        transitioned_at: bufferedTurn.started_at,
        status: 'running',
        reason_code: reasonCodeForWorkerEvent(CANONICAL_EVENT.agentRunner.turnStarted),
        reason_detail: null
      });
      runningEntry.pending_execution_graph_turn = null;
      runningEntry.pending_execution_graph_thread_started_at = null;
    }

    if (threadId && turnId && runningEntry.persisted_thread_evidence_id !== threadId) {
      await persistTicketEvidenceReferenceForThread({
        persistence,
        logger,
        recordHistoryWriteFailure: params.recordHistoryWriteFailure,
        runningEntry,
        workerEvent,
        threadId,
        recordedAt: at
      });
      runningEntry.persisted_thread_evidence_id = threadId;
    }

    if (turnId) {
      const phase = phaseSpanNameForWorkerEvent(workerEvent.event);
      if (phase) {
        const phaseSpanKey = `${turnId}\0${phase}`;
        const persistedKeys = phaseSpanKeysForRunningEntry(persistedPhaseSpanKeys, runningEntry);
        if (!persistedKeys.has(phaseSpanKey)) {
          operation = 'appendPhaseSpan';
          await persistence.appendPhaseSpan?.({
            turn_id: turnId,
            phase,
            started_at: at,
            ended_at: at,
            status: executionGraphStatusForWorkerEvent(workerEvent.event),
            reason_code: reasonCodeForWorkerEvent(workerEvent.event),
            reason_detail: workerEvent.detail ?? null
          });
          persistedKeys.add(phaseSpanKey);
        }
      }

      const toolName = toolNameForWorkerEvent(workerEvent);
      if (toolName) {
        operation = 'appendToolSpan';
        await persistence.appendToolSpan?.({
          turn_id: turnId,
          tool_name: toolName,
          started_at: at,
          ended_at: at,
          status: executionGraphStatusForWorkerEvent(workerEvent.event),
          reason_code: reasonCodeForWorkerEvent(workerEvent.event),
          reason_detail: workerEvent.detail ?? null
        });
      }
    }

    const toStatus = transitionStatusForWorkerEvent(workerEvent.event);
    if (toStatus) {
      operation = 'appendStateTransition';
      await persistence.appendStateTransition?.({
        issue_run_id: runningEntry.issue_run_id,
        attempt_id: runningEntry.attempt_id,
        thread_id: threadId ?? null,
        turn_id: turnId ?? null,
        from_status: null,
        to_status: toStatus,
        transitioned_at: at,
        status: executionGraphStatusForWorkerEvent(workerEvent.event),
        reason_code: reasonCodeForWorkerEvent(workerEvent.event),
        reason_detail: workerEvent.detail ?? null
      });
    }

    if (shouldPersistTokenModelFact(workerEvent)) {
      operation = 'appendTokenModelFact';
      await persistence.appendTokenModelFact?.({
        token_model_fact_id:
          workerEvent.agent_runtime === 'claude-cli'
            ? stableProviderFactId(runningEntry, threadId, turnId, 'invocation')
            : undefined,
        issue_run_id: runningEntry.issue_run_id,
        attempt_id: runningEntry.attempt_id,
        thread_id: threadId ?? null,
        turn_id: turnId ?? null,
        requested_model: workerEvent.requested_model ?? runningEntry.requested_model ?? null,
        effective_model: workerEvent.effective_model ?? runningEntry.effective_model ?? null,
        model_source: tokenModelFactSource(workerEvent),
        input_tokens: workerEvent.usage?.input_tokens ?? workerEvent.provider_usage?.input_tokens ?? null,
        output_tokens: workerEvent.usage?.output_tokens ?? workerEvent.provider_usage?.output_tokens ?? null,
        cached_input_tokens: workerEvent.usage?.cached_input_tokens ?? workerEvent.provider_usage?.cache_read_tokens ?? null,
        cache_creation_input_tokens: workerEvent.provider_usage?.cache_creation_tokens ?? null,
        reasoning_output_tokens: workerEvent.usage?.reasoning_output_tokens ?? null,
        total_tokens: workerEvent.usage?.total_tokens ?? null,
        model_context_window: workerEvent.usage?.model_context_window ?? null,
        runtime_provider: workerEvent.agent_runtime ?? null,
        provider_turn_count: workerEvent.provider_usage?.provider_turn_count ?? null,
        estimated_cost_usd: workerEvent.provider_usage?.estimated_cost_usd ?? null,
        provider_usage_status: workerEvent.provider_usage?.status ?? null,
        provider_usage_source: workerEvent.provider_usage?.source ?? null,
        api_retry_count: workerEvent.provider_usage?.api_retry_count ?? null,
        api_error_status: workerEvent.provider_usage?.api_error_status ?? null,
        terminal_reason: workerEvent.provider_usage?.terminal_reason ?? null,
        stop_reason: workerEvent.provider_usage?.stop_reason ?? null,
        duration_ms: workerEvent.provider_usage?.duration_ms ?? null,
        duration_api_ms: workerEvent.provider_usage?.duration_api_ms ?? null,
        time_to_first_token_ms: workerEvent.provider_usage?.time_to_first_token_ms ?? null,
        permission_denial_count: workerEvent.provider_usage?.permission_denial_count ?? null,
        unknown_event_count: workerEvent.provider_usage?.unknown_event_count ?? null,
        auxiliary_result_count: workerEvent.provider_usage?.auxiliary_result_count ?? null,
        effective_models: workerEvent.provider_usage?.effective_models ?? null,
        tool_counts: workerEvent.provider_usage?.tool_counts ?? null,
        mcp_counts: workerEvent.provider_usage?.mcp_counts ?? null,
        missing_reason: workerEvent.provider_usage?.missing_reason ?? null,
        reconciliation_delta: workerEvent.provider_usage?.reconciliation_delta ?? null,
        model_usage: workerEvent.provider_usage?.model_usage ?? null,
        nested_session_detected: workerEvent.provider_usage?.nested_session_detected ?? null,
        supervised_session_coverage: workerEvent.provider_usage?.supervised_session_coverage ?? null,
        telemetry_confidence: tokenModelFactConfidence(workerEvent),
        observed_at: workerEvent.token_telemetry_last_at_ms ? asIso(workerEvent.token_telemetry_last_at_ms) : at
      });
      for (const modelUsage of workerEvent.provider_usage?.model_usage ?? []) {
        operation = 'appendTokenModelFact';
        await persistence.appendTokenModelFact?.({
          token_model_fact_id: stableProviderFactId(runningEntry, threadId, turnId, 'model', modelUsage.model),
          issue_run_id: runningEntry.issue_run_id,
          attempt_id: runningEntry.attempt_id,
          thread_id: threadId ?? null,
          turn_id: turnId ?? null,
          requested_model: workerEvent.requested_model ?? runningEntry.requested_model ?? null,
          effective_model: modelUsage.model,
          model_source: 'claude_model_usage',
          input_tokens: modelUsage.input_tokens,
          output_tokens: modelUsage.output_tokens,
          cached_input_tokens: modelUsage.cache_read_tokens,
          cache_creation_input_tokens: modelUsage.cache_creation_tokens,
          total_tokens: null,
          runtime_provider: 'claude-cli',
          provider_turn_count: null,
          estimated_cost_usd: modelUsage.estimated_cost_usd,
          provider_usage_status: 'final',
          provider_usage_source: 'claude_model_usage',
          api_retry_count: workerEvent.provider_usage?.api_retry_count ?? null,
          effective_models: [modelUsage.model],
          telemetry_confidence: 'provider_result',
          observed_at: workerEvent.provider_usage?.updated_at ?? at
        });
      }
    }

    if (turnId && workerEvent.provider_usage_step_facts?.length) {
      for (const step of workerEvent.provider_usage_step_facts) {
        operation = 'appendProviderUsageStepFact';
        await persistence.appendProviderUsageStepFact?.({
          issue_run_id: runningEntry.issue_run_id,
          attempt_id: runningEntry.attempt_id,
          thread_id: threadId ?? null,
          turn_id: turnId,
          message_id_hash: step.message_id_hash,
          model: step.model,
          input_tokens: step.input_tokens,
          output_tokens: step.output_tokens,
          cache_read_tokens: step.cache_read_tokens,
          cache_creation_tokens: step.cache_creation_tokens,
          observed_at: step.observed_at
        });
      }
    }

    const appServerLiteSummary = appServerLiteSummaryForWorkerEvent(workerEvent);
    if (appServerLiteSummary && persistence.appendAppServerEvent) {
      operation = 'appendAppServerEvent';
      await persistence.appendAppServerEvent({
        issue_run_id: runningEntry.issue_run_id,
        attempt_id: runningEntry.attempt_id,
        thread_id: threadId ?? null,
        turn_id: turnId ?? null,
        observed_at: at,
        source_event_id: appServerLiteSourceEventId(workerEvent),
        source_event_name: workerEvent.event,
        payload_class: appServerLiteSummary.payload_class,
        summary: appServerLiteSummary.summary,
        summary_fields: appServerLiteSummary.summary_fields,
        unavailable_reason_code: appServerLiteSummary.unavailable_reason_code ?? null
      });
    }
  } catch (error) {
    const failedTurnId = workerEvent.turn_id ?? runningEntry.turn_id;
    if (failedTurnId) {
      clearPendingExecutionGraphWorkerTurn(runningEntry, failedTurnId);
    }
    await params.recordHistoryWriteFailure(operation, reasonCodeForWorkerEvent(workerEvent.event), error);
    logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.persistence.recordEventFailed,
      message: `failed to persist execution graph event for ${runningEntry.identifier}`,
      context: executionGraphPersistenceFailureContext(issueId, runningEntry, workerEvent, operation, error)
    });
  }
}

export function queuePersistExecutionGraphWorkerEvent(params: {
  queues: WeakMap<RunningEntry, Promise<void>>;
  issueId: string;
  runningEntry: RunningEntry;
  workerEvent: WorkerObservabilityEvent;
  turnAlreadyObserved: boolean;
  persistedPhaseSpanKeys: WeakMap<RunningEntry, Set<string>>;
} & PersistenceFailureContext): Promise<void> {
  if (params.runningEntry.history_terminalizing) {
    return Promise.resolve();
  }
  const previous = params.queues.get(params.runningEntry) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => persistExecutionGraphWorkerEvent(params));
  params.queues.set(params.runningEntry, next);
  void next
    .finally(() => {
      if (params.queues.get(params.runningEntry) === next) {
        params.queues.delete(params.runningEntry);
      }
    })
    .catch(() => undefined);
  return next;
}

export async function persistTicketEvidenceReferenceForThread(params: {
  runningEntry: RunningEntry;
  workerEvent: WorkerObservabilityEvent;
  threadId: string;
  recordedAt: string;
} & PersistenceFailureContext): Promise<void> {
  const { persistence, logger, runningEntry, workerEvent, threadId, recordedAt } = params;
  if (!persistence?.appendTicketEvidenceReference || !runningEntry.issue_run_id || !runningEntry.attempt_id) {
    return;
  }

  try {
    await persistence.appendTicketEvidenceReference({
      issue_run_id: runningEntry.issue_run_id,
      attempt_id: runningEntry.attempt_id,
      thread_id: threadId,
      turn_id: workerEvent.turn_id ?? runningEntry.turn_id ?? null,
      evidence_kind: 'agent_thread',
      uri: `agent-thread:${threadId}`,
      title: 'Agent thread observed',
      metadata: {
        session_id: workerEvent.session_id ?? runningEntry.session_id ?? null,
        agent_runtime: workerEvent.agent_runtime ?? runningEntry.agent_runtime ?? null,
        worker_instance_id: workerEvent.worker_instance_id ?? runningEntry.worker_instance_id ?? null,
        worker_process_pid: workerEvent.worker_process_pid ?? workerEvent.codex_app_server_pid ?? null,
        event: workerEvent.event
      },
      recorded_at: recordedAt
    });
  } catch (error) {
    await params.recordHistoryWriteFailure('appendTicketEvidenceReference', reasonCodeForWorkerEvent(workerEvent.event), error);
    logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.persistence.recordEventFailed,
      message: `failed to persist ticket evidence reference for ${runningEntry.identifier}`,
      context: {
        issue_id: runningEntry.issue.id,
        issue_identifier: runningEntry.identifier,
        issue_run_id: runningEntry.issue_run_id,
        attempt_id: runningEntry.attempt_id,
        thread_id: threadId,
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

export async function persistExecutionGraphStateTransition(params: {
  runningEntry: RunningEntry;
  toStatus: string;
  status: ExecutionGraphTransitionStatus;
  reasonCode: string;
  reasonDetail: string | null;
  nowMs: () => number;
} & PersistenceFailureContext): Promise<void> {
  const { persistence, logger, runningEntry, toStatus, status, reasonCode, reasonDetail, nowMs } = params;
  if (!persistence || !runningEntry.issue_run_id) {
    return;
  }
  const persistedThreadId = runningEntry.persisted_thread_id ?? null;
  const threadId =
    persistedThreadId && (!runningEntry.thread_id || runningEntry.thread_id === persistedThreadId)
      ? persistedThreadId
      : null;
  const turnId =
    threadId && runningEntry.turn_id && (runningEntry.persisted_turn_ids ?? []).includes(runningEntry.turn_id)
      ? runningEntry.turn_id
      : null;

  try {
    await persistence.appendStateTransition?.({
      issue_run_id: runningEntry.issue_run_id,
      attempt_id: runningEntry.attempt_id,
      thread_id: threadId,
      turn_id: turnId,
      from_status: null,
      to_status: toStatus,
      transitioned_at: asIso(nowMs()),
      status,
      reason_code: reasonCode,
      reason_detail: reasonDetail
    });
  } catch (error) {
    await params.recordHistoryWriteFailure('appendStateTransition.executionGraph', reasonCode, error);
    logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.persistence.recordEventFailed,
      message: `failed to persist execution graph transition for ${runningEntry.identifier}`,
      context: {
        issue_id: runningEntry.issue.id,
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id,
        thread_id: runningEntry.thread_id,
        turn_id: runningEntry.turn_id,
        reason_code: reasonCode
      }
    });
  }
}

export async function persistExecutionGraphRetryTransition(params: {
  retryEntry: RetryEntry;
  toStatus: string;
  status: ExecutionGraphTransitionStatus;
  reasonCode: string;
  reasonDetail: string | null;
  nowMs: () => number;
} & PersistenceFailureContext): Promise<void> {
  const { persistence, logger, retryEntry, toStatus, status, reasonCode, reasonDetail, nowMs } = params;
  if (!persistence || !retryEntry.issue_run_id) {
    return;
  }

  try {
    await persistence.appendStateTransition?.({
      issue_run_id: retryEntry.issue_run_id,
      attempt_id: retryEntry.previous_attempt_id,
      thread_id: null,
      turn_id: null,
      from_status: null,
      to_status: toStatus,
      transitioned_at: asIso(nowMs()),
      status,
      reason_code: reasonCode,
      reason_detail: reasonDetail
    });
  } catch (error) {
    await params.recordHistoryWriteFailure('appendStateTransition.retry', reasonCode, error);
    logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.persistence.recordEventFailed,
      message: `failed to persist execution graph retry transition for ${retryEntry.identifier}`,
      context: {
        issue_id: retryEntry.issue_id,
        issue_identifier: retryEntry.identifier,
        thread_id: retryEntry.previous_thread_id,
        reason_code: reasonCode
      }
    });
  }
}

export async function persistPreSpawnExecutionGraphAttempt(params: {
  issue: Issue;
  attempt: number | null;
  graphContext: DispatchGraphContext;
  status: 'failed' | 'blocked';
  reasonCode: string;
  reasonDetail: string | null;
  nowMs: () => number;
} & PersistenceFailureContext): Promise<DispatchGraphContext> {
  const { persistence, logger } = params;
  if (!persistence) {
    return params.graphContext;
  }

  try {
    const startedAt = asIso(params.nowMs());
    const issueRunId =
      params.graphContext.issue_run_id ??
      (await persistence.appendIssueRun?.({
        issue_id: params.issue.id,
        issue_identifier: params.issue.identifier,
        started_at: startedAt,
        status: 'running',
        reason_code: REASON_CODES.dispatchStarted,
        reason_detail: 'dispatch attempt started'
      })) ??
      null;
    if (!issueRunId) {
      return params.graphContext;
    }

    const attemptId =
      (await persistence.appendAttempt?.({
        issue_run_id: issueRunId,
        attempt_number: params.attempt ?? 0,
        started_at: startedAt,
        ended_at: startedAt,
        status: params.status,
        reason_code: params.reasonCode,
        reason_detail: params.reasonDetail
      })) ?? null;

    if (attemptId) {
      await persistence.appendStateTransition?.({
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        from_status: null,
        to_status: params.status,
        transitioned_at: startedAt,
        status: params.status,
        reason_code: params.reasonCode,
        reason_detail: params.reasonDetail
      });
      await persistence.appendStateTransition?.({
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        from_status: params.status,
        to_status: 'retrying',
        transitioned_at: startedAt,
        status: 'retrying',
        reason_code: params.reasonCode,
        reason_detail: params.reasonDetail
      });
      if (params.status === 'failed') {
        await persistence.appendTicketTerminalOutcome?.({
          issue_run_id: issueRunId,
          attempt_id: attemptId,
          outcome: 'failed',
          reason_code: params.reasonCode,
          reason_detail: params.reasonDetail,
          recorded_at: startedAt
        });
      } else {
        await persistence.appendTicketBlocker?.({
          issue_run_id: issueRunId,
          attempt_id: attemptId,
          blocker_type: 'orchestration_blocker',
          status: 'active',
          reason_code: params.reasonCode,
          reason_detail: params.reasonDetail,
          blocked_at: startedAt
        });
      }
    }

    return {
      issue_run_id: issueRunId,
      previous_attempt_id: attemptId ?? params.graphContext.previous_attempt_id ?? null
    };
  } catch (error) {
    await params.recordHistoryWriteFailure('persistPreSpawnExecutionGraphAttempt', params.reasonCode, error);
    logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.persistence.recordEventFailed,
      message: `failed to persist pre-spawn execution graph attempt for ${params.issue.identifier}`,
      context: {
        issue_id: params.issue.id,
        issue_identifier: params.issue.identifier,
        reason_code: params.reasonCode
      }
    });
    return params.graphContext;
  }
}
