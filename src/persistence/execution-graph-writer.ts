import { createHash } from 'node:crypto';

import { redactUnknown } from '../security/redaction';
import { serializeDurableIdentity } from './identity-projection-store';
import type { PersistenceDatabase } from './store-context';
import type {
  DurableIdentity,
  DrainAuditBlockerSummary,
  DrainAuditEventRecord,
  DrainAuditEventType,
  ExecutionGraphEntityStatus,
  HistoryIdentityProjectionRecord,
  IdentityEvidence,
  ProjectIdentity,
  RunTerminalStatus,
  TicketReferenceRecord,
  TokenModelTelemetryConfidence
} from './types';

export interface ExecutionGraphWriterDependencies {
  db: PersistenceDatabase;
  transaction: <T>(fn: () => T) => T;
  upsertProjectIdentity: (project: ProjectIdentity) => void;
  upsertHistoryIdentity: (identity: DurableIdentity) => void;
  recordIdentityProjection: (record: Omit<HistoryIdentityProjectionRecord, 'updated_at'>) => void;
  readIssueRunIdentity: (issueRunId: string | null) => DurableIdentity | null;
}

export interface AppendIssueRunParams {
  issue_id: string;
  issue_identifier: string;
  identity: DurableIdentity;
  started_at: string;
  ended_at?: string | null;
  status: ExecutionGraphEntityStatus;
  reason_code?: string | null;
  reason_detail?: string | null;
  issue_run_id?: string;
}

export interface AppendAttemptParams {
  issue_run_id: string;
  attempt_number: number;
  started_at: string;
  ended_at?: string | null;
  status: ExecutionGraphEntityStatus;
  reason_code?: string | null;
  reason_detail?: string | null;
  attempt_id?: string;
}

export interface AppendThreadParams {
  attempt_id: string;
  session_id?: string | null;
  agent_runtime?: string | null;
  worker_instance_id?: string | null;
  worker_process_pid?: number | null;
  started_at: string;
  ended_at?: string | null;
  status: ExecutionGraphEntityStatus;
  reason_code?: string | null;
  reason_detail?: string | null;
  thread_id?: string;
}

export interface AppendTurnParams {
  thread_id: string;
  turn_index: number;
  started_at: string;
  ended_at?: string | null;
  status: ExecutionGraphEntityStatus;
  reason_code?: string | null;
  reason_detail?: string | null;
  turn_id?: string;
}

export interface AppendPhaseSpanParams {
  turn_id: string;
  phase: string;
  started_at: string;
  ended_at?: string | null;
  status: ExecutionGraphEntityStatus;
  reason_code?: string | null;
  reason_detail?: string | null;
  phase_span_id?: string;
}

export interface AppendToolSpanParams {
  turn_id: string;
  tool_name: string;
  started_at: string;
  ended_at?: string | null;
  status: ExecutionGraphEntityStatus;
  reason_code?: string | null;
  reason_detail?: string | null;
  tool_span_id?: string;
}

export interface AppendStateTransitionParams {
  issue_run_id: string;
  attempt_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  from_status?: string | null;
  to_status: string;
  transitioned_at: string;
  status: ExecutionGraphEntityStatus;
  reason_code?: string | null;
  reason_detail?: string | null;
  state_transition_id?: string;
}

export interface AppendTicketTerminalOutcomeParams {
  issue_run_id: string;
  attempt_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  outcome: RunTerminalStatus;
  reason_code?: string | null;
  reason_detail?: string | null;
  recorded_at: string;
  terminal_outcome_id?: string;
}

export interface AppendTicketBlockerParams {
  issue_run_id: string;
  attempt_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  blocker_type: string;
  status?: 'active' | 'resolved';
  reason_code: string;
  reason_detail?: string | null;
  blocked_at: string;
  resolved_at?: string | null;
  blocker_id?: string;
}

export interface AppendTicketEvidenceReferenceParams {
  issue_run_id: string;
  attempt_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  evidence_kind: string;
  uri: string;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  recorded_at: string;
  evidence_reference_id?: string;
}

export interface AppendTrackerTicketSnapshotParams {
  identity?: DurableIdentity | null;
  issue_run_id?: string | null;
  attempt_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  tracker_kind: string;
  tracker_scope?: IdentityEvidence | null;
  remote_issue_id: string;
  human_issue_identifier: string;
  title: string;
  tracker_status: string;
  assignee_status?: 'available' | 'unavailable' | 'unknown';
  assignee_identifier?: string | null;
  assignee_reason?: string | null;
  labels?: string[];
  project_status?: 'available' | 'unavailable' | 'unknown';
  project_identifier?: string | null;
  project_reason?: string | null;
  team_status?: 'available' | 'unavailable' | 'unknown';
  team_identifier?: string | null;
  team_reason?: string | null;
  observed_at: string;
  tracker_snapshot_id?: string;
}

export interface AppendTicketReferenceParams {
  identity?: DurableIdentity | null;
  issue_run_id?: string | null;
  attempt_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  reference_kind: TicketReferenceRecord['reference_kind'];
  availability: 'available' | 'unavailable' | 'unknown';
  uri?: string | null;
  label?: string | null;
  external_id?: string | null;
  state?: string | null;
  metadata?: Record<string, unknown> | null;
  observed_at: string;
  ticket_reference_id?: string;
}

export interface AppendOperatorActionHistoryParams {
  identity?: DurableIdentity | null;
  issue_run_id?: string | null;
  attempt_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  action: string;
  actor?: string | null;
  result: 'accepted' | 'rejected' | 'failed';
  result_code?: string | null;
  message?: string | null;
  reason_note?: string | null;
  phase?: string | null;
  state_context?: Record<string, unknown> | null;
  requested_at: string;
  observed_at: string;
  operator_action_id?: string;
}

export interface AppendBlockedInputEventParams {
  identity?: DurableIdentity | null;
  issue_run_id?: string | null;
  attempt_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  issue_id: string;
  issue_identifier: string;
  phase?: string | null;
  runtime_state: string;
  reason_code: string;
  reason_detail?: string | null;
  request_id?: string | null;
  request_method?: string | null;
  input_schema_type?: string | null;
  prompt_text?: string | null;
  pending_input?: Record<string, unknown> | null;
  state_context?: Record<string, unknown> | null;
  blocked_at: string;
  blocked_input_event_id?: string;
}

export interface AppendTokenModelFactParams {
  issue_run_id: string;
  attempt_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  requested_model?: string | null;
  effective_model?: string | null;
  model_source?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_input_tokens?: number | null;
  reasoning_output_tokens?: number | null;
  total_tokens?: number | null;
  model_context_window?: number | null;
  runtime_provider?: string | null;
  provider_turn_count?: number | null;
  estimated_cost_usd?: number | null;
  cache_creation_input_tokens?: number | null;
  provider_usage_status?: string | null;
  provider_usage_source?: string | null;
  api_retry_count?: number | null;
  api_error_status?: number | string | null;
  terminal_reason?: string | null;
  stop_reason?: string | null;
  duration_ms?: number | null;
  duration_api_ms?: number | null;
  time_to_first_token_ms?: number | null;
  permission_denial_count?: number | null;
  unknown_event_count?: number | null;
  auxiliary_result_count?: number | null;
  effective_models?: string[] | null;
  tool_counts?: Record<string, number> | null;
  mcp_counts?: Record<string, number> | null;
  missing_reason?: string | null;
  reconciliation_delta?: Record<string, number> | null;
  model_usage?: unknown[] | null;
  nested_session_detected?: boolean | null;
  supervised_session_coverage?: string | null;
  telemetry_confidence: TokenModelTelemetryConfidence;
  observed_at: string;
  token_model_fact_id?: string;
}

export interface AppendProviderUsageStepFactParams {
  issue_run_id: string;
  attempt_id?: string | null;
  thread_id?: string | null;
  turn_id: string;
  message_id_hash: string;
  model?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  observed_at: string;
}

export interface AppendDrainAuditHistoryParams {
  project_identity: ProjectIdentity;
  issue_run_id?: string | null;
  attempt_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  event_type: DrainAuditEventType;
  actor?: string | null;
  source: string;
  result: DrainAuditEventRecord['result'];
  result_code: string;
  reason_note?: string | null;
  state_context?: Record<string, unknown> | null;
  blocker_summaries?: DrainAuditBlockerSummary[];
  occurred_at: string;
  observed_at: string;
  drain_audit_event_id?: string;
}

export interface CompleteIssueRunRowParams {
  issue_run_id: string;
  ended_at: string;
  status: RunTerminalStatus;
  process_status?: RunTerminalStatus | null;
  workflow_outcome?: string | null;
  reason_code: string | null;
  reason_detail: string | null;
}

export interface CompleteAttemptRowParams {
  attempt_id: string;
  ended_at: string;
  status: RunTerminalStatus;
  process_status?: RunTerminalStatus | null;
  workflow_outcome?: string | null;
  reason_code: string | null;
  reason_detail: string | null;
}

function asExecutionGraphId(kind: string, parts: Array<string | number | null | undefined>): string {
  const hash = createHash('sha256')
    .update(kind)
    .update('\0')
    .update(parts.map((part) => String(part ?? '')).join('\0'))
    .digest('hex')
    .slice(0, 32);
  return `${kind}_${hash}`;
}

function stableOperationalHash(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(redactUnknown(parts))).digest('hex');
}

function ensureMonotonicTimestamp(next: string, previous: string | null | undefined, label: string): void {
  if (previous && next < previous) {
    throw new Error(`${label} timestamp must be monotonic`);
  }
}

function ensureEndedAfterStarted(startedAt: string, endedAt: string | null | undefined, label: string): void {
  if (endedAt && endedAt < startedAt) {
    throw new Error(`${label} ended_at must be greater than or equal to started_at`);
  }
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function validateOptionalTokenCount(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeTelemetryConfidence(value: TokenModelTelemetryConfidence): TokenModelTelemetryConfidence {
  if (!['observed_live', 'backfilled', 'provider_step', 'provider_result', 'legacy_partial', 'missing'].includes(value)) {
    throw new Error('telemetry_confidence is invalid');
  }
  return value;
}

function normalizeIdentifierArray(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()))].slice(
    0,
    12
  );
}

function normalizeDrainAuditBlockers(blockers: DrainAuditBlockerSummary[]): DrainAuditBlockerSummary[] {
  return blockers.slice(0, 20).map((blocker) => ({
    category: blocker.category,
    count: Number.isSafeInteger(blocker.count) && blocker.count >= 0 ? blocker.count : 0,
    issue_identifiers: normalizeIdentifierArray(blocker.issue_identifiers),
    run_identifiers: normalizeIdentifierArray(blocker.run_identifiers),
    thread_identifiers: normalizeIdentifierArray(blocker.thread_identifiers),
    detail: redactUnknown(blocker.detail ?? null) as string | null
  }));
}

function normalizeDrainAuditStateContext(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  const redacted = redactUnknown(value) as Record<string, unknown>;
  const bounded: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(redacted).slice(0, 24)) {
    if (/transcript|raw_payload|conversation/i.test(key)) {
      bounded[key] = '[omitted]';
      continue;
    }
    bounded[key] = raw;
  }
  return bounded;
}

export class ExecutionGraphWriter {
  private readonly db: PersistenceDatabase;
  private readonly transaction: <T>(fn: () => T) => T;
  private readonly upsertProjectIdentity: (project: ProjectIdentity) => void;
  private readonly upsertHistoryIdentity: (identity: DurableIdentity) => void;
  private readonly recordIdentityProjection: ExecutionGraphWriterDependencies['recordIdentityProjection'];
  private readonly readIssueRunIdentity: ExecutionGraphWriterDependencies['readIssueRunIdentity'];

  constructor(dependencies: ExecutionGraphWriterDependencies) {
    this.db = dependencies.db;
    this.transaction = dependencies.transaction;
    this.upsertProjectIdentity = dependencies.upsertProjectIdentity;
    this.upsertHistoryIdentity = dependencies.upsertHistoryIdentity;
    this.recordIdentityProjection = dependencies.recordIdentityProjection;
    this.readIssueRunIdentity = dependencies.readIssueRunIdentity;
  }

  appendIssueRun(params: AppendIssueRunParams): string {
    ensureEndedAfterStarted(params.started_at, params.ended_at, 'issue_run');
    const issueRunId = params.issue_run_id ?? asExecutionGraphId('issue_run', [params.issue_id, params.issue_identifier, params.started_at]);
    this.upsertHistoryIdentity(params.identity);
    this.db
      .prepare(
        `INSERT INTO issue_run
        (issue_run_id, issue_id, issue_identifier, identity, project_key, ticket_key, started_at, ended_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        issueRunId,
        params.issue_id,
        params.issue_identifier,
        serializeDurableIdentity(params.identity),
        params.identity.project.key,
        params.identity.ticket.key,
        params.started_at,
        params.ended_at ?? null,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    this.recordIdentityProjection({
      source_table: 'issue_run',
      source_id: issueRunId,
      run_id: null,
      issue_run_id: issueRunId,
      issue_id: params.issue_id,
      issue_identifier: params.issue_identifier,
      projection_status: 'projected',
      reason_code: null,
      reason_detail: null,
      project_key: params.identity.project.key,
      ticket_key: params.identity.ticket.key
    });
    return issueRunId;
  }

  appendAttempt(params: AppendAttemptParams): string {
    ensureEndedAfterStarted(params.started_at, params.ended_at, 'attempt');
    const parent = this.db.prepare('SELECT started_at FROM issue_run WHERE issue_run_id = ?').get(params.issue_run_id) as
      | { started_at: string }
      | undefined;
    if (!parent) {
      throw new Error(`issue_run ${params.issue_run_id} does not exist`);
    }
    ensureMonotonicTimestamp(params.started_at, parent.started_at, 'attempt');
    const attemptId = params.attempt_id ?? asExecutionGraphId('attempt', [params.issue_run_id, params.attempt_number]);
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO attempt
          (attempt_id, issue_run_id, attempt_number, started_at, ended_at, status, reason_code, reason_detail)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          attemptId,
          params.issue_run_id,
          params.attempt_number,
          params.started_at,
          params.ended_at ?? null,
          params.status,
          params.reason_code ?? null,
          redactUnknown(params.reason_detail ?? null)
        );
      if (params.status === 'running' && !params.ended_at) {
        this.db
          .prepare(
            `UPDATE issue_run SET
              ended_at = NULL,
              status = 'running',
              reason_code = ?,
              reason_detail = ?
            WHERE issue_run_id = ?`
          )
          .run(params.reason_code ?? null, redactUnknown(params.reason_detail ?? null), params.issue_run_id);
      }
    });
    return attemptId;
  }

  appendThread(params: AppendThreadParams): string {
    ensureEndedAfterStarted(params.started_at, params.ended_at, 'thread');
    const parent = this.db.prepare('SELECT started_at FROM attempt WHERE attempt_id = ?').get(params.attempt_id) as
      | { started_at: string }
      | undefined;
    if (!parent) {
      throw new Error(`attempt ${params.attempt_id} does not exist`);
    }
    ensureMonotonicTimestamp(params.started_at, parent.started_at, 'thread');
    const threadId = params.thread_id ?? asExecutionGraphId('thread', [params.attempt_id, params.started_at]);
    this.db
      .prepare(
        `INSERT INTO thread
        (thread_id, attempt_id, session_id, agent_runtime, worker_instance_id, worker_process_pid,
         started_at, ended_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          session_id = COALESCE(excluded.session_id, thread.session_id),
          agent_runtime = COALESCE(excluded.agent_runtime, thread.agent_runtime),
          worker_instance_id = COALESCE(excluded.worker_instance_id, thread.worker_instance_id),
          worker_process_pid = COALESCE(excluded.worker_process_pid, thread.worker_process_pid),
          ended_at = COALESCE(excluded.ended_at, thread.ended_at),
          status = excluded.status,
          reason_code = excluded.reason_code,
          reason_detail = excluded.reason_detail`
      )
      .run(
        threadId,
        params.attempt_id,
        params.session_id ?? null,
        params.agent_runtime ?? null,
        params.worker_instance_id ?? null,
        params.worker_process_pid ?? null,
        params.started_at,
        params.ended_at ?? null,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    return threadId;
  }

  appendTurn(params: AppendTurnParams): string {
    ensureEndedAfterStarted(params.started_at, params.ended_at, 'turn');
    const parent = this.db.prepare('SELECT started_at FROM thread WHERE thread_id = ?').get(params.thread_id) as
      | { started_at: string }
      | undefined;
    if (!parent) {
      throw new Error(`thread ${params.thread_id} does not exist`);
    }
    ensureMonotonicTimestamp(params.started_at, parent.started_at, 'turn');
    const turnId = params.turn_id ?? asExecutionGraphId('turn', [params.thread_id, params.turn_index]);
    this.db
      .prepare(
        `INSERT INTO turn
        (turn_id, thread_id, turn_index, started_at, ended_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        turnId,
        params.thread_id,
        params.turn_index,
        params.started_at,
        params.ended_at ?? null,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    return turnId;
  }

  appendPhaseSpan(params: AppendPhaseSpanParams): string {
    ensureEndedAfterStarted(params.started_at, params.ended_at, 'phase_span');
    this.ensureTurnTimestamp(params.turn_id, params.started_at, 'phase_span');
    const phaseSpanId = params.phase_span_id ?? asExecutionGraphId('phase_span', [params.turn_id, params.phase, params.started_at]);
    this.db
      .prepare(
        `INSERT INTO phase_span
        (phase_span_id, turn_id, phase, started_at, ended_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        phaseSpanId,
        params.turn_id,
        params.phase,
        params.started_at,
        params.ended_at ?? null,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    return phaseSpanId;
  }

  appendToolSpan(params: AppendToolSpanParams): string {
    ensureEndedAfterStarted(params.started_at, params.ended_at, 'tool_span');
    this.ensureTurnTimestamp(params.turn_id, params.started_at, 'tool_span');
    const toolSpanId = params.tool_span_id ?? asExecutionGraphId('tool_span', [params.turn_id, params.tool_name, params.started_at]);
    this.db
      .prepare(
        `INSERT INTO tool_span
        (tool_span_id, turn_id, tool_name, started_at, ended_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        toolSpanId,
        params.turn_id,
        params.tool_name,
        params.started_at,
        params.ended_at ?? null,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    return toolSpanId;
  }

  appendStateTransition(params: AppendStateTransitionParams): string {
    this.ensureStateTransitionReferences(params);
    const latest = this.db
      .prepare('SELECT transitioned_at FROM state_transition WHERE issue_run_id = ? ORDER BY transitioned_at DESC LIMIT 1')
      .get(params.issue_run_id) as { transitioned_at: string } | undefined;
    ensureMonotonicTimestamp(params.transitioned_at, latest?.transitioned_at, 'state_transition');
    const stateTransitionId =
      params.state_transition_id ??
      asExecutionGraphId('state_transition', [
        params.issue_run_id,
        params.attempt_id,
        params.thread_id,
        params.turn_id,
        params.from_status,
        params.to_status,
        params.transitioned_at,
        params.reason_code
      ]);
    this.db
      .prepare(
        `INSERT INTO state_transition
        (state_transition_id, issue_run_id, attempt_id, thread_id, turn_id, from_status, to_status, transitioned_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(state_transition_id) DO UPDATE SET
          issue_run_id = excluded.issue_run_id,
          attempt_id = excluded.attempt_id,
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          from_status = excluded.from_status,
          to_status = excluded.to_status,
          transitioned_at = excluded.transitioned_at,
          status = excluded.status,
          reason_code = excluded.reason_code,
          reason_detail = excluded.reason_detail`
      )
      .run(
        stateTransitionId,
        params.issue_run_id,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        params.from_status ?? null,
        params.to_status,
        params.transitioned_at,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    return stateTransitionId;
  }

  appendTicketTerminalOutcome(params: AppendTicketTerminalOutcomeParams): string {
    this.ensureTimelineFactReferences({
      issue_run_id: params.issue_run_id,
      attempt_id: params.attempt_id,
      thread_id: params.thread_id,
      turn_id: params.turn_id,
      timestamp: params.recorded_at,
      label: 'ticket_terminal_outcome'
    });
    const terminalOutcomeId =
      params.terminal_outcome_id ??
      asExecutionGraphId('ticket_terminal_outcome', [
        params.issue_run_id,
        params.attempt_id,
        params.thread_id,
        params.turn_id,
        params.outcome,
        params.recorded_at,
        params.reason_code
      ]);
    this.db
      .prepare(
        `INSERT INTO history_ticket_terminal_outcome
        (terminal_outcome_id, issue_run_id, attempt_id, thread_id, turn_id, outcome, reason_code, reason_detail, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(terminal_outcome_id) DO UPDATE SET
          issue_run_id = excluded.issue_run_id,
          attempt_id = excluded.attempt_id,
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          outcome = excluded.outcome,
          reason_code = excluded.reason_code,
          reason_detail = excluded.reason_detail,
          recorded_at = excluded.recorded_at`
      )
      .run(
        terminalOutcomeId,
        params.issue_run_id,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        params.outcome,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null),
        params.recorded_at
      );
    return terminalOutcomeId;
  }

  appendTicketBlocker(params: AppendTicketBlockerParams): string {
    ensureEndedAfterStarted(params.blocked_at, params.resolved_at, 'ticket_blocker');
    this.ensureTimelineFactReferences({
      issue_run_id: params.issue_run_id,
      attempt_id: params.attempt_id,
      thread_id: params.thread_id,
      turn_id: params.turn_id,
      timestamp: params.blocked_at,
      label: 'ticket_blocker'
    });
    const blockerId =
      params.blocker_id ??
      asExecutionGraphId('ticket_blocker', [
        params.issue_run_id,
        params.attempt_id,
        params.thread_id,
        params.turn_id,
        params.blocker_type,
        params.reason_code,
        params.blocked_at
      ]);
    this.db
      .prepare(
        `INSERT INTO history_ticket_blocker
        (blocker_id, issue_run_id, attempt_id, thread_id, turn_id, blocker_type, status, reason_code, reason_detail, blocked_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        blockerId,
        params.issue_run_id,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        params.blocker_type,
        params.status ?? 'active',
        params.reason_code,
        redactUnknown(params.reason_detail ?? null),
        params.blocked_at,
        params.resolved_at ?? null
      );
    return blockerId;
  }

  appendTicketEvidenceReference(params: AppendTicketEvidenceReferenceParams): string {
    this.ensureTimelineFactReferences({
      issue_run_id: params.issue_run_id,
      attempt_id: params.attempt_id,
      thread_id: params.thread_id,
      turn_id: params.turn_id,
      timestamp: params.recorded_at,
      label: 'ticket_evidence_reference'
    });
    const evidenceReferenceId =
      params.evidence_reference_id ??
      asExecutionGraphId('ticket_evidence_reference', [
        params.issue_run_id,
        params.attempt_id,
        params.thread_id,
        params.turn_id,
        params.evidence_kind,
        params.uri,
        params.recorded_at
      ]);
    this.db
      .prepare(
        `INSERT INTO history_ticket_evidence_reference
        (evidence_reference_id, issue_run_id, attempt_id, thread_id, turn_id, evidence_kind, uri, title, metadata, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        evidenceReferenceId,
        params.issue_run_id,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        params.evidence_kind,
        params.uri,
        redactUnknown(params.title ?? null),
        params.metadata ? JSON.stringify(redactUnknown(params.metadata)) : null,
        params.recorded_at
      );
    return evidenceReferenceId;
  }

  appendTrackerTicketSnapshot(params: AppendTrackerTicketSnapshotParams): string {
    const identity = params.identity ?? this.readIssueRunIdentity(params.issue_run_id ?? null);
    const trackerScope = identity?.ticket.tracker_scope ?? params.tracker_scope ?? { status: 'missing', reason: 'tracker_scope_unavailable' };
    const labels = [...(params.labels ?? [])].sort();
    const observationHash = stableOperationalHash([
      identity?.ticket.tracker_kind ?? params.tracker_kind,
      trackerScope,
      params.remote_issue_id,
      params.human_issue_identifier,
      params.title,
      params.tracker_status,
      params.assignee_status ?? 'unknown',
      params.assignee_identifier ?? null,
      params.assignee_reason ?? null,
      labels,
      params.project_status ?? 'unknown',
      params.project_identifier ?? null,
      params.project_reason ?? null,
      params.team_status ?? 'unknown',
      params.team_identifier ?? null,
      params.team_reason ?? null
    ]);
    const snapshotId =
      params.tracker_snapshot_id ?? asExecutionGraphId('tracker_ticket_snapshot', [params.issue_run_id, observationHash, params.observed_at]);
    this.db
      .prepare(
        `INSERT INTO history_tracker_ticket_snapshot
          (tracker_snapshot_id, project_key, ticket_key, issue_run_id, attempt_id, thread_id, turn_id,
           tracker_kind, tracker_scope_status, tracker_scope_value, tracker_scope_reason, remote_issue_id,
           human_issue_identifier, title, tracker_status, assignee_status, assignee_identifier,
           assignee_reason, labels, project_status, project_identifier, project_reason, team_status,
           team_identifier, team_reason, observed_at, observation_hash, duplicate_count, last_observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(issue_run_id, observation_hash) DO UPDATE SET
          duplicate_count = history_tracker_ticket_snapshot.duplicate_count + 1,
          last_observed_at = excluded.last_observed_at`
      )
      .run(
        snapshotId,
        identity?.project.key ?? null,
        identity?.ticket.key ?? null,
        params.issue_run_id ?? null,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        identity?.ticket.tracker_kind ?? params.tracker_kind,
        trackerScope.status,
        trackerScope.status === 'present' ? trackerScope.value : null,
        trackerScope.status === 'missing' ? trackerScope.reason : null,
        params.remote_issue_id,
        params.human_issue_identifier,
        redactUnknown(params.title),
        params.tracker_status,
        params.assignee_status ?? 'unknown',
        params.assignee_identifier ?? null,
        params.assignee_reason ?? null,
        JSON.stringify(labels),
        params.project_status ?? 'unknown',
        params.project_identifier ?? null,
        params.project_reason ?? null,
        params.team_status ?? 'unknown',
        params.team_identifier ?? null,
        params.team_reason ?? null,
        params.observed_at,
        observationHash,
        params.observed_at
      );
    return snapshotId;
  }

  appendTicketReference(params: AppendTicketReferenceParams): string {
    const identity = params.identity ?? this.readIssueRunIdentity(params.issue_run_id ?? null);
    const metadata = params.metadata ? (redactUnknown(params.metadata) as Record<string, unknown>) : null;
    const observationHash = stableOperationalHash([
      params.reference_kind,
      params.availability,
      params.uri ?? null,
      params.label ?? null,
      params.external_id ?? null,
      params.state ?? null,
      metadata
    ]);
    const referenceId =
      params.ticket_reference_id ?? asExecutionGraphId('ticket_reference', [params.issue_run_id, params.reference_kind, observationHash, params.observed_at]);
    this.db
      .prepare(
        `INSERT INTO history_ticket_reference
          (ticket_reference_id, project_key, ticket_key, issue_run_id, attempt_id, thread_id, turn_id,
           reference_kind, availability, uri, label, external_id, state, metadata, observed_at,
           observation_hash, duplicate_count, last_observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(issue_run_id, reference_kind, observation_hash) DO UPDATE SET
          duplicate_count = history_ticket_reference.duplicate_count + 1,
          last_observed_at = excluded.last_observed_at`
      )
      .run(
        referenceId,
        identity?.project.key ?? null,
        identity?.ticket.key ?? null,
        params.issue_run_id ?? null,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        params.reference_kind,
        params.availability,
        params.uri ?? null,
        redactUnknown(params.label ?? null),
        params.external_id ?? null,
        params.state ?? null,
        metadata ? JSON.stringify(metadata) : null,
        params.observed_at,
        observationHash,
        params.observed_at
      );
    return referenceId;
  }

  appendOperatorActionHistory(params: AppendOperatorActionHistoryParams): string {
    const identity = params.identity ?? this.readIssueRunIdentity(params.issue_run_id ?? null);
    const stateContext = params.state_context ? (redactUnknown(params.state_context) as Record<string, unknown>) : null;
    const observationHash = stableOperationalHash([
      params.action,
      params.actor ?? null,
      params.result,
      params.result_code ?? null,
      params.message ?? null,
      params.reason_note ?? null,
      params.phase ?? null,
      stateContext,
      params.requested_at
    ]);
    const operatorActionId =
      params.operator_action_id ?? asExecutionGraphId('operator_action', [params.issue_run_id, params.action, observationHash, params.observed_at]);
    this.db
      .prepare(
        `INSERT INTO history_operator_action
          (operator_action_id, project_key, ticket_key, issue_run_id, attempt_id, thread_id, turn_id,
           action, actor, result, result_code, message, reason_note, phase, state_context,
           requested_at, observed_at, observation_hash, duplicate_count, last_observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(issue_run_id, action, observation_hash) DO UPDATE SET
          duplicate_count = history_operator_action.duplicate_count + 1,
          last_observed_at = excluded.last_observed_at`
      )
      .run(
        operatorActionId,
        identity?.project.key ?? null,
        identity?.ticket.key ?? null,
        params.issue_run_id ?? null,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        params.action,
        params.actor ?? null,
        params.result,
        params.result_code ?? null,
        redactUnknown(params.message ?? null),
        redactUnknown(params.reason_note ?? null),
        params.phase ?? null,
        stateContext ? JSON.stringify(stateContext) : null,
        params.requested_at,
        params.observed_at,
        observationHash,
        params.observed_at
      );
    return operatorActionId;
  }

  appendDrainAuditHistory(params: AppendDrainAuditHistoryParams): string {
    this.upsertProjectIdentity(params.project_identity);
    const identity = params.issue_run_id ? this.readIssueRunIdentity(params.issue_run_id) : null;
    const stateContext = normalizeDrainAuditStateContext(params.state_context);
    const blockerSummaries = normalizeDrainAuditBlockers(params.blocker_summaries ?? []);
    const observationHash = stableOperationalHash([
      params.event_type,
      params.actor ?? null,
      params.source,
      params.result,
      params.result_code,
      params.reason_note ?? null,
      stateContext,
      blockerSummaries,
      params.occurred_at
    ]);
    const drainAuditEventId =
      params.drain_audit_event_id ?? asExecutionGraphId('drain_audit_event', [params.project_identity.key, params.event_type, observationHash]);
    this.db
      .prepare(
        `INSERT INTO history_drain_audit_event
          (drain_audit_event_id, project_key, ticket_key, issue_run_id, attempt_id, thread_id, turn_id,
           event_type, actor, source, result, result_code, reason_note, state_context, blocker_summaries,
           occurred_at, observed_at, observation_hash, duplicate_count, last_observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(project_key, event_type, observation_hash) DO UPDATE SET
          duplicate_count = history_drain_audit_event.duplicate_count + 1,
          last_observed_at = excluded.last_observed_at`
      )
      .run(
        drainAuditEventId,
        params.project_identity.key,
        identity?.ticket.key ?? null,
        params.issue_run_id ?? null,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        params.event_type,
        params.actor ?? null,
        params.source,
        params.result,
        params.result_code,
        redactUnknown(params.reason_note ?? null),
        stateContext ? JSON.stringify(stateContext) : null,
        JSON.stringify(blockerSummaries),
        params.occurred_at,
        params.observed_at,
        observationHash,
        params.observed_at
      );
    return drainAuditEventId;
  }

  appendBlockedInputEvent(params: AppendBlockedInputEventParams): string {
    const identity = params.identity ?? this.readIssueRunIdentity(params.issue_run_id ?? null);
    const pendingInput = params.pending_input ? (redactUnknown(params.pending_input) as Record<string, unknown>) : null;
    const stateContext = params.state_context ? (redactUnknown(params.state_context) as Record<string, unknown>) : null;
    const observationHash = stableOperationalHash([
      params.issue_id,
      params.issue_identifier,
      params.phase ?? null,
      params.runtime_state,
      params.reason_code,
      params.reason_detail ?? null,
      params.request_id ?? null,
      params.request_method ?? null,
      params.input_schema_type ?? null,
      params.prompt_text ?? null,
      pendingInput,
      stateContext
    ]);
    const blockedInputEventId =
      params.blocked_input_event_id ?? asExecutionGraphId('blocked_input_event', [params.issue_run_id, observationHash, params.blocked_at]);
    this.db
      .prepare(
        `INSERT INTO history_blocked_input_event
          (blocked_input_event_id, project_key, ticket_key, issue_run_id, attempt_id, thread_id, turn_id,
           issue_id, issue_identifier, phase, runtime_state, reason_code, reason_detail, request_id,
           request_method, input_schema_type, prompt_text, pending_input, state_context, blocked_at,
           observation_hash, duplicate_count, last_observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(issue_run_id, observation_hash) DO UPDATE SET
          duplicate_count = history_blocked_input_event.duplicate_count + 1,
          last_observed_at = excluded.last_observed_at`
      )
      .run(
        blockedInputEventId,
        identity?.project.key ?? null,
        identity?.ticket.key ?? null,
        params.issue_run_id ?? null,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        params.issue_id,
        params.issue_identifier,
        params.phase ?? null,
        params.runtime_state,
        params.reason_code,
        redactUnknown(params.reason_detail ?? null),
        params.request_id ?? null,
        params.request_method ?? null,
        params.input_schema_type ?? null,
        redactUnknown(params.prompt_text ?? null),
        pendingInput ? JSON.stringify(pendingInput) : null,
        stateContext ? JSON.stringify(stateContext) : null,
        params.blocked_at,
        observationHash,
        params.blocked_at
      );
    return blockedInputEventId;
  }

  appendTokenModelFact(params: AppendTokenModelFactParams): string {
    this.ensureTimelineFactReferences({
      issue_run_id: params.issue_run_id,
      attempt_id: params.attempt_id,
      thread_id: params.thread_id,
      turn_id: params.turn_id,
      timestamp: params.observed_at,
      label: 'token_model_fact'
    });
    const requestedModel = normalizeOptionalText(params.requested_model);
    const effectiveModel = normalizeOptionalText(params.effective_model);
    const modelSource = normalizeOptionalText(params.model_source);
    const inputTokens = validateOptionalTokenCount(params.input_tokens, 'input_tokens');
    const outputTokens = validateOptionalTokenCount(params.output_tokens, 'output_tokens');
    const cachedInputTokens = validateOptionalTokenCount(params.cached_input_tokens, 'cached_input_tokens');
    const reasoningOutputTokens = validateOptionalTokenCount(params.reasoning_output_tokens, 'reasoning_output_tokens');
    const totalTokens = validateOptionalTokenCount(params.total_tokens, 'total_tokens');
    const modelContextWindow = validateOptionalTokenCount(params.model_context_window, 'model_context_window');
    const runtimeProvider = normalizeOptionalText(params.runtime_provider);
    const providerTurnCount = validateOptionalTokenCount(params.provider_turn_count, 'provider_turn_count');
    const cacheCreationInputTokens = validateOptionalTokenCount(
      params.cache_creation_input_tokens,
      'cache_creation_input_tokens'
    );
    const providerUsageStatus = normalizeOptionalText(params.provider_usage_status);
    const providerUsageSource = normalizeOptionalText(params.provider_usage_source);
    const apiRetryCount = validateOptionalTokenCount(params.api_retry_count, 'api_retry_count');
    const apiErrorStatus = params.api_error_status === null || params.api_error_status === undefined
      ? null
      : normalizeOptionalText(String(params.api_error_status));
    const terminalReason = normalizeOptionalText(params.terminal_reason);
    const stopReason = normalizeOptionalText(params.stop_reason);
    const durationMs = validateOptionalTokenCount(params.duration_ms, 'duration_ms');
    const durationApiMs = validateOptionalTokenCount(params.duration_api_ms, 'duration_api_ms');
    const timeToFirstTokenMs = validateOptionalTokenCount(params.time_to_first_token_ms, 'time_to_first_token_ms');
    const permissionDenialCount = validateOptionalTokenCount(params.permission_denial_count, 'permission_denial_count');
    const unknownEventCount = validateOptionalTokenCount(params.unknown_event_count, 'unknown_event_count');
    const auxiliaryResultCount = validateOptionalTokenCount(params.auxiliary_result_count, 'auxiliary_result_count');
    const effectiveModels = params.effective_models ? JSON.stringify(normalizeIdentifierArray(params.effective_models)) : null;
    const toolCounts = params.tool_counts ? JSON.stringify(redactUnknown(params.tool_counts)) : null;
    const mcpCounts = params.mcp_counts ? JSON.stringify(redactUnknown(params.mcp_counts)) : null;
    const missingReason = normalizeOptionalText(params.missing_reason);
    const reconciliationDelta = params.reconciliation_delta
      ? JSON.stringify(redactUnknown(params.reconciliation_delta))
      : null;
    const modelUsage = params.model_usage ? JSON.stringify(redactUnknown(params.model_usage)) : null;
    const nestedSessionDetected = params.nested_session_detected === true ? 1 : params.nested_session_detected === false ? 0 : null;
    const supervisedSessionCoverage = normalizeOptionalText(params.supervised_session_coverage);
    const estimatedCostUsd =
      params.estimated_cost_usd === undefined || params.estimated_cost_usd === null
        ? null
        : Number.isFinite(params.estimated_cost_usd) && params.estimated_cost_usd >= 0
          ? params.estimated_cost_usd
          : (() => {
              throw new Error('estimated_cost_usd must be a non-negative finite number');
            })();
    const telemetryConfidence = normalizeTelemetryConfidence(params.telemetry_confidence);
    const tokenModelFactId =
      params.token_model_fact_id ??
      asExecutionGraphId('token_model_fact', [
        params.issue_run_id,
        params.attempt_id,
        params.thread_id,
        params.turn_id,
        requestedModel,
        effectiveModel,
        modelSource,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningOutputTokens,
        totalTokens,
        modelContextWindow,
        runtimeProvider,
        providerTurnCount,
        estimatedCostUsd,
        cacheCreationInputTokens,
        providerUsageStatus,
        providerUsageSource,
        apiRetryCount,
        apiErrorStatus,
        terminalReason,
        stopReason,
        durationMs,
        durationApiMs,
        timeToFirstTokenMs,
        permissionDenialCount,
        unknownEventCount,
        auxiliaryResultCount,
        effectiveModels,
        toolCounts,
        mcpCounts,
        missingReason,
        reconciliationDelta,
        modelUsage,
        nestedSessionDetected,
        supervisedSessionCoverage,
        telemetryConfidence,
        params.observed_at
      ]);

    this.db
      .prepare(
        `INSERT INTO history_token_model_fact
        (token_model_fact_id, issue_run_id, attempt_id, thread_id, turn_id, requested_model, effective_model,
         model_source, input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens, total_tokens,
         model_context_window, runtime_provider, provider_turn_count, estimated_cost_usd, cache_creation_input_tokens,
         provider_usage_status, provider_usage_source, api_retry_count, api_error_status, terminal_reason, stop_reason,
         duration_ms, duration_api_ms, time_to_first_token_ms, permission_denial_count, unknown_event_count,
         auxiliary_result_count, effective_models, tool_counts, mcp_counts,
         missing_reason, reconciliation_delta, model_usage, nested_session_detected, supervised_session_coverage,
         telemetry_confidence, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_model_fact_id) DO UPDATE SET
          requested_model = excluded.requested_model,
          effective_model = excluded.effective_model,
          model_source = excluded.model_source,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          total_tokens = excluded.total_tokens,
          model_context_window = excluded.model_context_window,
          runtime_provider = excluded.runtime_provider,
          cache_creation_input_tokens = excluded.cache_creation_input_tokens,
          provider_turn_count = excluded.provider_turn_count,
          estimated_cost_usd = excluded.estimated_cost_usd,
          provider_usage_status = excluded.provider_usage_status,
          provider_usage_source = excluded.provider_usage_source,
          api_retry_count = excluded.api_retry_count,
          api_error_status = excluded.api_error_status,
          terminal_reason = excluded.terminal_reason,
          stop_reason = excluded.stop_reason,
          duration_ms = excluded.duration_ms,
          duration_api_ms = excluded.duration_api_ms,
          time_to_first_token_ms = excluded.time_to_first_token_ms,
          permission_denial_count = excluded.permission_denial_count,
          unknown_event_count = excluded.unknown_event_count,
          auxiliary_result_count = excluded.auxiliary_result_count,
          effective_models = excluded.effective_models,
          tool_counts = excluded.tool_counts,
          mcp_counts = excluded.mcp_counts,
          missing_reason = excluded.missing_reason,
          reconciliation_delta = excluded.reconciliation_delta,
          model_usage = excluded.model_usage,
          nested_session_detected = excluded.nested_session_detected,
          supervised_session_coverage = excluded.supervised_session_coverage,
          telemetry_confidence = excluded.telemetry_confidence,
          observed_at = excluded.observed_at`
      )
      .run(
        tokenModelFactId,
        params.issue_run_id,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        requestedModel,
        effectiveModel,
        modelSource,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningOutputTokens,
        totalTokens,
        modelContextWindow,
        runtimeProvider,
        providerTurnCount,
        estimatedCostUsd,
        cacheCreationInputTokens,
        providerUsageStatus,
        providerUsageSource,
        apiRetryCount,
        apiErrorStatus,
        terminalReason,
        stopReason,
        durationMs,
        durationApiMs,
        timeToFirstTokenMs,
        permissionDenialCount,
        unknownEventCount,
        auxiliaryResultCount,
        effectiveModels,
        toolCounts,
        mcpCounts,
        missingReason,
        reconciliationDelta,
        modelUsage,
        nestedSessionDetected,
        supervisedSessionCoverage,
        telemetryConfidence,
        params.observed_at
      );
    return tokenModelFactId;
  }

  appendProviderUsageStepFact(params: AppendProviderUsageStepFactParams): string {
    this.ensureTimelineFactReferences({
      issue_run_id: params.issue_run_id,
      attempt_id: params.attempt_id,
      thread_id: params.thread_id,
      turn_id: params.turn_id,
      timestamp: params.observed_at,
      label: 'provider_usage_step_fact'
    });
    if (!/^[0-9a-f]{64}$/i.test(params.message_id_hash)) {
      throw new Error('message_id_hash must be a SHA-256 hex digest');
    }
    const inputTokens = validateOptionalTokenCount(params.input_tokens, 'input_tokens')!;
    const outputTokens = validateOptionalTokenCount(params.output_tokens, 'output_tokens')!;
    const cacheReadTokens = validateOptionalTokenCount(params.cache_read_tokens, 'cache_read_tokens')!;
    const cacheCreationTokens = validateOptionalTokenCount(params.cache_creation_tokens, 'cache_creation_tokens')!;
    const model = normalizeOptionalText(params.model);
    const factId = asExecutionGraphId('provider_usage_step_fact', [
      params.issue_run_id,
      params.turn_id,
      params.message_id_hash
    ]);
    this.db
      .prepare(
        `INSERT INTO history_provider_usage_step_fact
          (provider_usage_step_fact_id, issue_run_id, attempt_id, thread_id, turn_id, message_id_hash, model,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, runtime_provider, source,
           observed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claude-cli', 'claude_assistant_step', ?, ?)
         ON CONFLICT(issue_run_id, turn_id, message_id_hash) DO UPDATE SET
           model = COALESCE(excluded.model, history_provider_usage_step_fact.model),
           input_tokens = MAX(history_provider_usage_step_fact.input_tokens, excluded.input_tokens),
           output_tokens = MAX(history_provider_usage_step_fact.output_tokens, excluded.output_tokens),
           cache_read_tokens = MAX(history_provider_usage_step_fact.cache_read_tokens, excluded.cache_read_tokens),
           cache_creation_tokens = MAX(history_provider_usage_step_fact.cache_creation_tokens, excluded.cache_creation_tokens),
           updated_at = excluded.updated_at`
      )
      .run(
        factId,
        params.issue_run_id,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id,
        params.message_id_hash.toLowerCase(),
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        params.observed_at,
        params.observed_at
      );
    return factId;
  }

  completeIssueRunRow(params: CompleteIssueRunRowParams): void {
    const row = this.db.prepare('SELECT started_at FROM issue_run WHERE issue_run_id = ?').get(params.issue_run_id) as
      | { started_at: string }
      | undefined;
    if (!row) {
      return;
    }
    ensureEndedAfterStarted(row.started_at, params.ended_at, 'issue_run');
    this.db
      .prepare(
        `UPDATE issue_run SET
          ended_at = ?,
          status = ?,
          process_status = ?,
          workflow_outcome = ?,
          reason_code = ?,
          reason_detail = ?
        WHERE issue_run_id = ?`
      )
      .run(
        params.ended_at,
        params.status,
        params.process_status ?? params.status,
        params.workflow_outcome ?? params.status,
        params.reason_code,
        params.reason_detail,
        params.issue_run_id
      );
  }

  completeAttemptRow(params: CompleteAttemptRowParams): void {
    const row = this.db.prepare('SELECT started_at FROM attempt WHERE attempt_id = ?').get(params.attempt_id) as
      | { started_at: string }
      | undefined;
    if (!row) {
      return;
    }
    ensureEndedAfterStarted(row.started_at, params.ended_at, 'attempt');
    this.db
      .prepare(
        `UPDATE phase_span SET
          ended_at = COALESCE(ended_at, ?),
          status = CASE WHEN ended_at IS NULL THEN ? ELSE status END,
          reason_code = COALESCE(reason_code, ?),
          reason_detail = COALESCE(reason_detail, ?)
        WHERE turn_id IN (
          SELECT turn.turn_id FROM turn
          JOIN thread ON thread.thread_id = turn.thread_id
          WHERE thread.attempt_id = ?
        ) AND ended_at IS NULL`
      )
      .run(params.ended_at, params.status, params.reason_code, params.reason_detail, params.attempt_id);
    this.db
      .prepare(
        `UPDATE tool_span SET
          ended_at = COALESCE(ended_at, ?),
          status = CASE WHEN ended_at IS NULL THEN ? ELSE status END,
          reason_code = COALESCE(reason_code, ?),
          reason_detail = COALESCE(reason_detail, ?)
        WHERE turn_id IN (
          SELECT turn.turn_id FROM turn
          JOIN thread ON thread.thread_id = turn.thread_id
          WHERE thread.attempt_id = ?
        ) AND ended_at IS NULL`
      )
      .run(params.ended_at, params.status, params.reason_code, params.reason_detail, params.attempt_id);
    this.db
      .prepare(
        `UPDATE turn SET ended_at = ?, status = ?, reason_code = ?, reason_detail = ?
         WHERE thread_id IN (SELECT thread_id FROM thread WHERE attempt_id = ?) AND ended_at IS NULL`
      )
      .run(params.ended_at, params.status, params.reason_code, params.reason_detail, params.attempt_id);
    this.db
      .prepare(
        `UPDATE thread SET ended_at = ?, status = ?, reason_code = ?, reason_detail = ?
         WHERE attempt_id = ? AND ended_at IS NULL`
      )
      .run(params.ended_at, params.status, params.reason_code, params.reason_detail, params.attempt_id);
    this.db
      .prepare(
        `UPDATE attempt SET
          ended_at = ?,
          status = ?,
          process_status = ?,
          workflow_outcome = ?,
          reason_code = ?,
          reason_detail = ?
        WHERE attempt_id = ?`
      )
      .run(
        params.ended_at,
        params.status,
        params.process_status ?? params.status,
        params.workflow_outcome ?? params.status,
        params.reason_code,
        params.reason_detail,
        params.attempt_id
      );
  }

  private ensureTurnTimestamp(turnId: string, timestamp: string, label: string): void {
    const parent = this.db.prepare('SELECT started_at FROM turn WHERE turn_id = ?').get(turnId) as { started_at: string } | undefined;
    if (!parent) {
      throw new Error(`turn ${turnId} does not exist`);
    }
    ensureMonotonicTimestamp(timestamp, parent.started_at, label);
  }

  private ensureTimelineFactReferences(params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    timestamp: string;
    label: string;
  }): void {
    const issueRun = this.db.prepare('SELECT started_at FROM issue_run WHERE issue_run_id = ?').get(params.issue_run_id) as
      | { started_at: string }
      | undefined;
    if (!issueRun) {
      throw new Error(`issue_run ${params.issue_run_id} does not exist`);
    }
    ensureMonotonicTimestamp(params.timestamp, issueRun.started_at, params.label);

    if (params.attempt_id) {
      const attempt = this.db.prepare('SELECT issue_run_id, started_at FROM attempt WHERE attempt_id = ?').get(params.attempt_id) as
        | { issue_run_id: string; started_at: string }
        | undefined;
      if (!attempt || attempt.issue_run_id !== params.issue_run_id) {
        throw new Error(`attempt ${params.attempt_id} does not belong to issue_run ${params.issue_run_id}`);
      }
      ensureMonotonicTimestamp(params.timestamp, attempt.started_at, params.label);
    }

    if (params.thread_id) {
      const thread = this.db
        .prepare(
          `SELECT thread.started_at, thread.attempt_id, attempt.issue_run_id
           FROM thread
           JOIN attempt ON attempt.attempt_id = thread.attempt_id
           WHERE thread.thread_id = ?`
        )
        .get(params.thread_id) as { started_at: string; attempt_id: string; issue_run_id: string } | undefined;
      if (!thread || thread.issue_run_id !== params.issue_run_id) {
        throw new Error(`thread ${params.thread_id} does not belong to issue_run ${params.issue_run_id}`);
      }
      if (params.attempt_id && thread.attempt_id !== params.attempt_id) {
        throw new Error(`thread ${params.thread_id} does not belong to attempt ${params.attempt_id}`);
      }
      ensureMonotonicTimestamp(params.timestamp, thread.started_at, params.label);
    }

    if (params.turn_id) {
      const turn = this.db
        .prepare(
          `SELECT turn.started_at, turn.thread_id, thread.attempt_id, attempt.issue_run_id
           FROM turn
           JOIN thread ON thread.thread_id = turn.thread_id
           JOIN attempt ON attempt.attempt_id = thread.attempt_id
           WHERE turn.turn_id = ?`
        )
        .get(params.turn_id) as { started_at: string; thread_id: string; attempt_id: string; issue_run_id: string } | undefined;
      if (!turn || turn.issue_run_id !== params.issue_run_id) {
        throw new Error(`turn ${params.turn_id} does not belong to issue_run ${params.issue_run_id}`);
      }
      if (params.attempt_id && turn.attempt_id !== params.attempt_id) {
        throw new Error(`turn ${params.turn_id} does not belong to attempt ${params.attempt_id}`);
      }
      if (params.thread_id && turn.thread_id !== params.thread_id) {
        throw new Error(`turn ${params.turn_id} does not belong to thread ${params.thread_id}`);
      }
      ensureMonotonicTimestamp(params.timestamp, turn.started_at, params.label);
    }
  }

  private ensureStateTransitionReferences(params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    transitioned_at: string;
  }): void {
    const issueRun = this.db.prepare('SELECT started_at FROM issue_run WHERE issue_run_id = ?').get(params.issue_run_id) as
      | { started_at: string }
      | undefined;
    if (!issueRun) {
      throw new Error(`issue_run ${params.issue_run_id} does not exist`);
    }
    ensureMonotonicTimestamp(params.transitioned_at, issueRun.started_at, 'state_transition');

    if (params.attempt_id) {
      const attempt = this.db.prepare('SELECT issue_run_id, started_at FROM attempt WHERE attempt_id = ?').get(params.attempt_id) as
        | { issue_run_id: string; started_at: string }
        | undefined;
      if (!attempt || attempt.issue_run_id !== params.issue_run_id) {
        throw new Error(`attempt ${params.attempt_id} does not belong to issue_run ${params.issue_run_id}`);
      }
      ensureMonotonicTimestamp(params.transitioned_at, attempt.started_at, 'state_transition');
    }

    if (params.thread_id) {
      const thread = this.db
        .prepare(
          `SELECT thread.started_at, thread.attempt_id, attempt.issue_run_id
           FROM thread
           JOIN attempt ON attempt.attempt_id = thread.attempt_id
           WHERE thread.thread_id = ?`
        )
        .get(params.thread_id) as { started_at: string; attempt_id: string; issue_run_id: string } | undefined;
      if (!thread || thread.issue_run_id !== params.issue_run_id) {
        throw new Error(`thread ${params.thread_id} does not belong to issue_run ${params.issue_run_id}`);
      }
      if (params.attempt_id && thread.attempt_id !== params.attempt_id) {
        throw new Error(`thread ${params.thread_id} does not belong to attempt ${params.attempt_id}`);
      }
      ensureMonotonicTimestamp(params.transitioned_at, thread.started_at, 'state_transition');
    }

    if (params.turn_id) {
      const turn = this.db
        .prepare(
          `SELECT turn.started_at, turn.thread_id, thread.attempt_id, attempt.issue_run_id
           FROM turn
           JOIN thread ON thread.thread_id = turn.thread_id
           JOIN attempt ON attempt.attempt_id = thread.attempt_id
           WHERE turn.turn_id = ?`
        )
        .get(params.turn_id) as { started_at: string; thread_id: string; attempt_id: string; issue_run_id: string } | undefined;
      if (!turn || turn.issue_run_id !== params.issue_run_id) {
        throw new Error(`turn ${params.turn_id} does not belong to issue_run ${params.issue_run_id}`);
      }
      if (params.attempt_id && turn.attempt_id !== params.attempt_id) {
        throw new Error(`turn ${params.turn_id} does not belong to attempt ${params.attempt_id}`);
      }
      if (params.thread_id && turn.thread_id !== params.thread_id) {
        throw new Error(`turn ${params.turn_id} does not belong to thread ${params.thread_id}`);
      }
      ensureMonotonicTimestamp(params.transitioned_at, turn.started_at, 'state_transition');
    }
  }
}
