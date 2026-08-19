import { randomUUID } from 'node:crypto';

import { REASON_CODES } from '../observability/reason-codes';
import { redactUnknown } from '../security/redaction';
import type {
  AppendAttemptParams,
  AppendIssueRunParams,
  AppendTicketTerminalOutcomeParams,
  AppendStateTransitionParams,
  CompleteAttemptRowParams,
  CompleteIssueRunRowParams
} from './execution-graph-writer';
import { parseDurableIdentity, serializeDurableIdentity } from './identity-projection-store';
import type { PersistenceDatabase } from './store-context';
import { hydrateTokenModelFact, type TokenModelFactDatabaseRecord } from './types';
import type {
  AppServerEventLedgerRecord,
  CompletedProviderUsageTotal,
  DurableIdentity,
  DurableRunHistoryRecord,
  ExecutionGraphEntityStatus,
  HistoryIdentityProjectionRecord,
  RunTerminalStatus,
  TokenModelFactRecord
} from './types';

export interface RunHistoryExecutionGraphWriter {
  appendIssueRun(params: AppendIssueRunParams): string;
  appendAttempt(params: AppendAttemptParams): string;
  appendStateTransition(params: AppendStateTransitionParams): string;
  appendTicketTerminalOutcome(params: AppendTicketTerminalOutcomeParams): string;
  completeIssueRunRow(params: CompleteIssueRunRowParams): void;
  completeAttemptRow(params: CompleteAttemptRowParams): void;
}

export interface RunHistoryIdentityProjection {
  upsertHistoryIdentity(identity: DurableIdentity): void;
  recordIdentityProjection(record: Omit<HistoryIdentityProjectionRecord, 'updated_at'>): void;
  lookupIssueRunIdForRun(runId: string): string | null;
  readHistoryIdentityProjection(statement: { get(...args: unknown[]): unknown } | null, sourceId: string): HistoryIdentityProjectionRecord | null;
}

export interface RunHistoryStoreDependencies {
  db: PersistenceDatabase;
  nowMs: () => number;
  transaction: <T>(fn: () => T) => T;
  identityProjection: RunHistoryIdentityProjection;
  executionGraphWriter: RunHistoryExecutionGraphWriter;
}

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function parseNullableJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseHistoryPayloadTruncation(value: string): AppServerEventLedgerRecord['truncation'] {
  const parsed = JSON.parse(value) as AppServerEventLedgerRecord['truncation'];
  return {
    truncated: Boolean(parsed.truncated),
    original_bytes: Number(parsed.original_bytes),
    excerpt_bytes: Number(parsed.excerpt_bytes),
    max_excerpt_bytes: Number(parsed.max_excerpt_bytes)
  };
}

function hasTable(db: PersistenceDatabase, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { name: string }
    | undefined;
  return Boolean(row);
}

export class RunHistoryStore {
  private readonly db: PersistenceDatabase;
  private readonly nowMs: () => number;
  private readonly transaction: <T>(fn: () => T) => T;
  private readonly identityProjection: RunHistoryIdentityProjection;
  private readonly executionGraphWriter: RunHistoryExecutionGraphWriter;

  constructor(dependencies: RunHistoryStoreDependencies) {
    this.db = dependencies.db;
    this.nowMs = dependencies.nowMs;
    this.transaction = dependencies.transaction;
    this.identityProjection = dependencies.identityProjection;
    this.executionGraphWriter = dependencies.executionGraphWriter;
  }

  startRun(params: {
    issue_id: string;
    issue_identifier: string;
    identity: DurableIdentity;
    started_at?: string;
    issue_run_id?: string | null;
  }): string {
    const runId = randomUUID();
    this.identityProjection.upsertHistoryIdentity(params.identity);
    this.db
      .prepare(
        'INSERT INTO runs (run_id, issue_id, issue_identifier, identity, started_at, ended_at, terminal_status, error_code) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)'
      )
      .run(runId, params.issue_id, params.issue_identifier, serializeDurableIdentity(params.identity), params.started_at ?? asIso(this.nowMs()));
    this.identityProjection.recordIdentityProjection({
      source_table: 'runs',
      source_id: runId,
      run_id: runId,
      issue_run_id: params.issue_run_id ?? null,
      issue_id: params.issue_id,
      issue_identifier: params.issue_identifier,
      projection_status: 'projected',
      reason_code: null,
      reason_detail: null,
      project_key: params.identity.project.key,
      ticket_key: params.identity.ticket.key
    });
    return runId;
  }

  recordRunStarted(params: {
    issue_id: string;
    issue_identifier: string;
    identity: DurableIdentity;
    started_at: string;
    attempt_number: number;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
  }): { run_id: string; issue_run_id: string; attempt_id: string } {
    return this.transaction(() => {
      const runId = this.startRun({
        issue_id: params.issue_id,
        issue_identifier: params.issue_identifier,
        identity: params.identity,
        started_at: params.started_at
      });
      const issueRunId = this.executionGraphWriter.appendIssueRun({
        issue_id: params.issue_id,
        issue_identifier: params.issue_identifier,
        identity: params.identity,
        started_at: params.started_at,
        status: params.status,
        reason_code: params.reason_code,
        reason_detail: params.reason_detail
      });
      this.identityProjection.recordIdentityProjection({
        source_table: 'runs',
        source_id: runId,
        run_id: runId,
        issue_run_id: issueRunId,
        issue_id: params.issue_id,
        issue_identifier: params.issue_identifier,
        projection_status: 'projected',
        reason_code: null,
        reason_detail: null,
        project_key: params.identity.project.key,
        ticket_key: params.identity.ticket.key
      });
      const attemptId = this.executionGraphWriter.appendAttempt({
        issue_run_id: issueRunId,
        attempt_number: params.attempt_number,
        started_at: params.started_at,
        status: params.status,
        reason_code: params.reason_code,
        reason_detail: params.reason_detail
      });
      this.executionGraphWriter.appendStateTransition({
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        from_status: null,
        to_status: params.status,
        transitioned_at: params.started_at,
        status: params.status,
        reason_code: params.reason_code,
        reason_detail: params.reason_detail
      });
      this.identityProjection.recordIdentityProjection({
        source_table: 'runs',
        source_id: runId,
        run_id: runId,
        issue_run_id: issueRunId,
        issue_id: params.issue_id,
        issue_identifier: params.issue_identifier,
        projection_status: 'projected',
        reason_code: null,
        reason_detail: null,
        project_key: params.identity.project.key,
        ticket_key: params.identity.ticket.key
      });
      return { run_id: runId, issue_run_id: issueRunId, attempt_id: attemptId };
    });
  }

  recordSession(runId: string, sessionId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO run_sessions (run_id, session_id) VALUES (?, ?)').run(runId, sessionId);
  }

  recordEvent(params: {
    run_id: string;
    event: string;
    message: string | null;
    timestamp_ms: number;
    reason_code?: string | null;
    request_method?: string | null;
    request_category?: string | null;
  }): void {
    const redactedMessage = redactUnknown(params.message) as string | null;
    this.db
      .prepare(
        'INSERT INTO run_events (run_id, at, event, message, reason_code, request_method, request_category) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        params.run_id,
        asIso(params.timestamp_ms),
        params.event,
        redactedMessage,
        params.reason_code ?? null,
        params.request_method ?? null,
        params.request_category ?? null
      );
  }

  completeRun(params: {
    run_id: string;
    issue_run_id?: string | null;
    attempt_id?: string | null;
    terminal_status: RunTerminalStatus;
    error_code?: string | null;
    terminal_reason_code?: string | null;
    terminal_reason_detail?: string | null;
    root_cause_status?: ExecutionGraphEntityStatus | null;
    root_cause_reason_code?: string | null;
    root_cause_reason_detail?: string | null;
    root_cause_at?: string | null;
    session_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    missing_tool_output_recovery?: Record<string, unknown> | null;
  }): void {
    const redactedError = redactUnknown(params.error_code ?? null) as string | null;
    const redactedTerminalDetail = redactUnknown(params.terminal_reason_detail ?? null) as string | null;
    const redactedRootCauseDetail = redactUnknown(params.root_cause_reason_detail ?? null) as string | null;
    const redactedRecovery = params.missing_tool_output_recovery ? JSON.stringify(redactUnknown(params.missing_tool_output_recovery)) : null;
    const terminalReasonCode = params.terminal_reason_code ?? params.error_code ?? null;
    const handoffReached =
      terminalReasonCode === REASON_CODES.handoffStateReached ||
      terminalReasonCode === REASON_CODES.handoffRelease;
    const processStatus: RunTerminalStatus = handoffReached ? 'cancelled' : params.terminal_status;
    const workflowOutcome = handoffReached ? 'handoff_reached' : params.terminal_status;
    const completedAt = asIso(this.nowMs());
    const issueRunId = params.issue_run_id ?? this.identityProjection.lookupIssueRunIdForRun(params.run_id);
    this.transaction(() => {
      const attemptId = issueRunId ? (params.attempt_id ?? this.lookupActiveAttemptId(issueRunId)) : null;
      if (issueRunId) {
        const terminalScope = attemptId ?? params.run_id;
        this.executionGraphWriter.appendTicketTerminalOutcome({
          terminal_outcome_id: `terminal_outcome:${terminalScope}`,
          issue_run_id: issueRunId,
          attempt_id: attemptId,
          thread_id: params.thread_id ?? null,
          turn_id: params.turn_id ?? null,
          outcome: params.terminal_status,
          reason_code: terminalReasonCode,
          reason_detail: redactedTerminalDetail,
          recorded_at: completedAt
        });
        this.executionGraphWriter.appendStateTransition({
          state_transition_id: `terminal_transition:${terminalScope}`,
          issue_run_id: issueRunId,
          attempt_id: attemptId,
          thread_id: params.thread_id ?? null,
          turn_id: params.turn_id ?? null,
          from_status: null,
          to_status: workflowOutcome,
          transitioned_at: completedAt,
          status: params.terminal_status,
          reason_code: terminalReasonCode,
          reason_detail: redactedTerminalDetail
        });
      }
      this.db
        .prepare(
          `UPDATE runs SET
            ended_at = ?,
            completed_at = ?,
            terminal_status = ?,
            process_status = ?,
            workflow_outcome = ?,
            error_code = ?,
            terminal_reason_code = ?,
            terminal_reason_detail = ?,
            root_cause_status = ?,
            root_cause_reason_code = ?,
            root_cause_reason_detail = ?,
            root_cause_at = ?,
            session_id = ?,
            thread_id = ?,
            turn_id = ?,
            missing_tool_output_recovery = ?
          WHERE run_id = ?`
        )
        .run(
          completedAt,
          completedAt,
          params.terminal_status,
          processStatus,
          workflowOutcome,
          redactedError,
          terminalReasonCode,
          redactedTerminalDetail,
          params.root_cause_status ?? null,
          params.root_cause_reason_code ?? null,
          redactedRootCauseDetail,
          params.root_cause_at ?? null,
          params.session_id ?? null,
          params.thread_id ?? null,
          params.turn_id ?? null,
          redactedRecovery,
          params.run_id
        );

      if (!issueRunId) {
        return;
      }
      if (attemptId) {
        this.executionGraphWriter.completeAttemptRow({
          attempt_id: attemptId,
          ended_at: completedAt,
          status: params.terminal_status,
          process_status: processStatus,
          workflow_outcome: workflowOutcome,
          reason_code: terminalReasonCode,
          reason_detail: redactedTerminalDetail
        });
      }
      this.executionGraphWriter.completeIssueRunRow({
        issue_run_id: issueRunId,
        ended_at: completedAt,
        status: params.terminal_status,
        process_status: processStatus,
        workflow_outcome: workflowOutcome,
        reason_code: terminalReasonCode,
        reason_detail: redactedTerminalDetail
      });
    });
  }

  listRunHistory(limit = 50): DurableRunHistoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, issue_id, issue_identifier, identity, started_at, ended_at, completed_at, terminal_status,
          process_status, workflow_outcome, error_code,
          terminal_reason_code, terminal_reason_detail, root_cause_status, root_cause_reason_code,
          root_cause_reason_detail, root_cause_at, session_id, thread_id, turn_id, missing_tool_output_recovery
        FROM runs ORDER BY started_at DESC LIMIT ?`
      )
      .all(limit) as Array<{
      run_id: string;
      issue_id: string;
      issue_identifier: string;
      identity: string | null;
      started_at: string;
      ended_at: string | null;
      completed_at: string | null;
      terminal_status: RunTerminalStatus | null;
      process_status: RunTerminalStatus | null;
      workflow_outcome: string | null;
      error_code: string | null;
      terminal_reason_code: string | null;
      terminal_reason_detail: string | null;
      root_cause_status: ExecutionGraphEntityStatus | null;
      root_cause_reason_code: string | null;
      root_cause_reason_detail: string | null;
      root_cause_at: string | null;
      session_id: string | null;
      thread_id: string | null;
      turn_id: string | null;
      missing_tool_output_recovery: string | null;
    }>;

    const sessionStmt = this.db.prepare('SELECT session_id FROM run_sessions WHERE run_id = ? ORDER BY session_id ASC');
    const appServerEventStmt = hasTable(this.db, 'history_app_server_event')
      ? this.db.prepare(
          `SELECT app_server_event_id, issue_run_id, attempt_id, thread_id, turn_id, observed_at,
            source_event_id, source_event_name, payload_class, detail_status, redaction_status,
            summary, summary_fields, redacted_excerpt, truncation, unavailable_reason_code,
            full_payload_stored, policy_version
           FROM history_app_server_event
           WHERE issue_run_id = ?
           ORDER BY observed_at ASC, app_server_event_id ASC
           LIMIT 25`
        )
      : null;
    const identityProjectionStmt = hasTable(this.db, 'history_identity_projection')
      ? this.db.prepare(
          `SELECT source_table, source_id, run_id, issue_run_id, issue_id, issue_identifier, projection_status,
            reason_code, reason_detail, project_key, ticket_key, updated_at
           FROM history_identity_projection
           WHERE source_table = 'runs' AND source_id = ?`
        )
      : null;
    const tokenModelFactStmt = this.db.prepare(
      `SELECT *
       FROM history_token_model_fact
       WHERE issue_run_id = ?
       ORDER BY history_token_model_fact.observed_at ASC, history_token_model_fact.token_model_fact_id ASC`
    );

    return rows.map((row) => {
      const sessions = sessionStmt.all(row.run_id) as Array<{ session_id: string }>;
      const identityProjection = this.identityProjection.readHistoryIdentityProjection(
        identityProjectionStmt as { get(...args: unknown[]): unknown } | null,
        row.run_id
      );
      const issueRunId = identityProjection?.issue_run_id ?? this.readIssueRunIdForRunContext(row.thread_id, row.turn_id);
      const appServerEvents =
        appServerEventStmt && issueRunId
          ? (appServerEventStmt.all(issueRunId) as Array<
              Omit<AppServerEventLedgerRecord, 'summary_fields' | 'truncation' | 'full_payload_stored'> & {
                summary_fields: string;
                truncation: string;
                full_payload_stored: 0 | 1;
              }
            >).map((event) => ({
              ...event,
              summary_fields: parseNullableJsonObject(event.summary_fields) ?? {},
              truncation: parseHistoryPayloadTruncation(event.truncation),
              full_payload_stored: event.full_payload_stored === 1
            }))
          : [];
      const record: DurableRunHistoryRecord = {
        run_id: row.run_id,
        issue_id: row.issue_id,
        issue_identifier: row.issue_identifier,
        identity: parseDurableIdentity(row.identity),
        identity_projection: identityProjection as HistoryIdentityProjectionRecord | null,
        started_at: row.started_at,
        ended_at: row.ended_at,
        completed_at: row.completed_at,
        terminal_status: row.terminal_status,
        process_status: row.process_status,
        workflow_outcome: row.workflow_outcome,
        error_code: row.error_code,
        terminal_reason_code: row.terminal_reason_code ?? row.error_code,
        terminal_reason_detail: row.terminal_reason_detail,
        root_cause_status: row.root_cause_status,
        root_cause_reason_code: row.root_cause_reason_code,
        root_cause_reason_detail: row.root_cause_reason_detail,
        root_cause_at: row.root_cause_at,
        session_id: row.session_id,
        thread_id: row.thread_id,
        turn_id: row.turn_id,
        session_ids: sessions.map((entry) => entry.session_id),
        app_server_events: appServerEvents,
        missing_tool_output_recovery: parseNullableJsonObject(row.missing_tool_output_recovery),
        token_model_facts: issueRunId
          ? (tokenModelFactStmt.all(issueRunId) as TokenModelFactDatabaseRecord[]).map(hydrateTokenModelFact)
          : []
      };

      return redactUnknown(record) as DurableRunHistoryRecord;
    });
  }

  listCompletedProviderUsageTotals(excludeIssueRunIds: string[] = []): CompletedProviderUsageTotal[] {
    if (!hasTable(this.db, 'history_token_model_fact')) return [];
    const excluded = new Set(excludeIssueRunIds);
    const facts = (this.db
      .prepare(
        `SELECT history_token_model_fact.*
         FROM history_token_model_fact
         JOIN issue_run ON issue_run.issue_run_id = history_token_model_fact.issue_run_id
         WHERE issue_run.ended_at IS NOT NULL
          AND history_token_model_fact.runtime_provider = 'claude-cli'
         ORDER BY history_token_model_fact.observed_at ASC, history_token_model_fact.token_model_fact_id ASC`
      )
      .all() as TokenModelFactDatabaseRecord[])
      .filter((fact) => !excluded.has(fact.issue_run_id))
      .map(hydrateTokenModelFact);
    const invocationFacts = new Map<string, TokenModelFactRecord>();
    const modelFacts = new Map<string, TokenModelFactRecord>();
    const rank = (fact: TokenModelFactRecord) =>
      fact.provider_usage_status === 'final' || fact.telemetry_confidence === 'provider_result'
        ? 2
        : 1;
    const prefer = (current: TokenModelFactRecord | undefined, candidate: TokenModelFactRecord) =>
      !current || rank(candidate) > rank(current) || (rank(candidate) === rank(current) && candidate.observed_at >= current.observed_at)
        ? candidate
        : current;
    for (const fact of facts) {
      const invocationKey = fact.turn_id ?? fact.token_model_fact_id;
      if (fact.model_source === 'claude_model_usage') {
        const key = `${invocationKey}\0${fact.effective_model ?? 'unknown'}`;
        modelFacts.set(key, prefer(modelFacts.get(key), fact));
      } else {
        invocationFacts.set(invocationKey, prefer(invocationFacts.get(invocationKey), fact));
      }
    }

    type Aggregate = CompletedProviderUsageTotal & {
      invocationKeys: Set<string>;
      seenInput: boolean;
      seenOutput: boolean;
      seenCacheRead: boolean;
      seenCacheCreation: boolean;
      seenTurns: boolean;
      seenCost: boolean;
    };
    const groups = new Map<string, Aggregate>();
    const add = (params: {
      invocationKey: string;
      model: string | null;
      status: string | null;
      input: number | null;
      output: number | null;
      cacheRead: number | null;
      cacheCreation: number | null;
      turns: number | null;
      cost: number | null;
      updatedAt: string;
    }) => {
      const key = params.model ?? '';
      const group = groups.get(key) ?? {
        runtime_provider: 'claude-cli' as const,
        effective_model: params.model,
        invocation_count: 0,
        final_invocation_count: 0,
        partial_invocation_count: 0,
        unobserved_invocation_count: 0,
        missing_invocation_count: 0,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        provider_turn_count: null,
        estimated_cost_usd: null,
        updated_at: null,
        invocationKeys: new Set<string>(),
        seenInput: false,
        seenOutput: false,
        seenCacheRead: false,
        seenCacheCreation: false,
        seenTurns: false,
        seenCost: false
      };
      if (!group.invocationKeys.has(params.invocationKey)) {
        group.invocationKeys.add(params.invocationKey);
        group.invocation_count += 1;
        if (params.status === 'final') group.final_invocation_count += 1;
        else if (params.status === 'partial' || params.status === 'legacy_partial') group.partial_invocation_count += 1;
        else if (params.status === 'unobserved') group.unobserved_invocation_count += 1;
        else group.missing_invocation_count += 1;
      }
      const accumulate = (value: number | null, current: number | null) => value === null ? current : (current ?? 0) + value;
      group.input_tokens = accumulate(params.input, group.input_tokens);
      group.output_tokens = accumulate(params.output, group.output_tokens);
      group.cache_read_tokens = accumulate(params.cacheRead, group.cache_read_tokens);
      group.cache_creation_tokens = accumulate(params.cacheCreation, group.cache_creation_tokens);
      group.provider_turn_count = accumulate(params.turns, group.provider_turn_count);
      group.estimated_cost_usd = accumulate(params.cost, group.estimated_cost_usd);
      group.seenInput ||= params.input !== null;
      group.seenOutput ||= params.output !== null;
      group.seenCacheRead ||= params.cacheRead !== null;
      group.seenCacheCreation ||= params.cacheCreation !== null;
      group.seenTurns ||= params.turns !== null;
      group.seenCost ||= params.cost !== null;
      group.updated_at = !group.updated_at || params.updatedAt > group.updated_at ? params.updatedAt : group.updated_at;
      groups.set(key, group);
    };

    for (const [invocationKey, invocation] of invocationFacts) {
      const models = [...modelFacts.entries()]
        .filter(([key]) => key.startsWith(`${invocationKey}\0`))
        .map(([, fact]) => fact)
        .filter((fact) => [fact.input_tokens, fact.output_tokens, fact.cached_input_tokens, fact.cache_creation_input_tokens]
          .some((value) => typeof value === 'number' && value > 0));
      if (models.length > 0) {
        for (const model of models) {
          add({
            invocationKey,
            model: model.effective_model,
            status: invocation.provider_usage_status ?? null,
            input: model.input_tokens,
            output: model.output_tokens,
            cacheRead: model.cached_input_tokens,
            cacheCreation: model.cache_creation_input_tokens ?? null,
            turns: models.length === 1 ? invocation.provider_turn_count ?? null : null,
            cost: model.estimated_cost_usd ?? null,
            updatedAt: invocation.observed_at
          });
        }
        if (models.length > 1 && invocation.provider_turn_count !== null && invocation.provider_turn_count !== undefined) {
          add({
            invocationKey,
            model: null,
            status: invocation.provider_usage_status ?? null,
            input: null,
            output: null,
            cacheRead: null,
            cacheCreation: null,
            turns: invocation.provider_turn_count,
            cost: null,
            updatedAt: invocation.observed_at
          });
        }
        continue;
      }
      add({
        invocationKey,
        model: invocation.effective_model ?? invocation.requested_model,
        status: invocation.provider_usage_status ?? null,
        input: invocation.input_tokens,
        output: invocation.output_tokens,
        cacheRead: invocation.cached_input_tokens,
        cacheCreation: invocation.cache_creation_input_tokens ?? null,
        turns: invocation.provider_turn_count ?? null,
        cost: invocation.estimated_cost_usd ?? null,
        updatedAt: invocation.observed_at
      });
    }

    return [...groups.values()]
      .map(({ invocationKeys: _keys, seenInput, seenOutput, seenCacheRead, seenCacheCreation, seenTurns, seenCost, ...group }) => ({
        ...group,
        input_tokens: seenInput ? group.input_tokens : null,
        output_tokens: seenOutput ? group.output_tokens : null,
        cache_read_tokens: seenCacheRead ? group.cache_read_tokens : null,
        cache_creation_tokens: seenCacheCreation ? group.cache_creation_tokens : null,
        provider_turn_count: seenTurns ? group.provider_turn_count : null,
        estimated_cost_usd: seenCost ? group.estimated_cost_usd : null
      }))
      .sort((left, right) => (left.effective_model ?? '').localeCompare(right.effective_model ?? ''));
  }

  private lookupActiveAttemptId(issueRunId: string): string | null {
    const activeAttempt = this.db
      .prepare(
        `SELECT attempt_id
         FROM attempt
         WHERE issue_run_id = ?
          AND ended_at IS NULL
         ORDER BY attempt_number DESC, started_at DESC, attempt_id DESC
         LIMIT 1`
      )
      .get(issueRunId) as { attempt_id: string } | undefined;
    return activeAttempt?.attempt_id ?? null;
  }

  private readIssueRunIdForRunContext(threadId: string | null, turnId: string | null): string | null {
    if (turnId) {
      const row = this.db
        .prepare(
          `SELECT attempt.issue_run_id
           FROM turn
           JOIN thread ON thread.thread_id = turn.thread_id
           JOIN attempt ON attempt.attempt_id = thread.attempt_id
           WHERE turn.turn_id = ?`
        )
        .get(turnId) as { issue_run_id: string } | undefined;
      if (row) {
        return row.issue_run_id;
      }
    }

    if (threadId) {
      const row = this.db
        .prepare(
          `SELECT attempt.issue_run_id
           FROM thread
           JOIN attempt ON attempt.attempt_id = thread.attempt_id
           WHERE thread.thread_id = ?`
        )
        .get(threadId) as { issue_run_id: string } | undefined;
      return row?.issue_run_id ?? null;
    }

    return null;
  }
}
