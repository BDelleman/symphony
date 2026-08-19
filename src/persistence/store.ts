import { REASON_CODES } from '../observability/reason-codes';
import { redactUnknown } from '../security/redaction';
import { AppServerLedgerStore } from './app-server-ledger-store';
import { classifyPersistedWorkerOwnership, findLatestTerminalRunEventEvidence } from './execution-graph-reconciliation';
import {
  ExecutionGraphWriter,
  type AppendDrainAuditHistoryParams,
  type AppendAttemptParams,
  type AppendBlockedInputEventParams,
  type AppendIssueRunParams,
  type AppendOperatorActionHistoryParams,
  type AppendPhaseSpanParams,
  type AppendProviderUsageStepFactParams,
  type AppendStateTransitionParams,
  type AppendThreadParams,
  type AppendTicketBlockerParams,
  type AppendTicketEvidenceReferenceParams,
  type AppendTicketReferenceParams,
  type AppendTicketTerminalOutcomeParams,
  type AppendTokenModelFactParams,
  type AppendToolSpanParams,
  type AppendTrackerTicketSnapshotParams,
  type AppendTurnParams
} from './execution-graph-writer';
import { HistoryMigrationStore } from './history-migration-store';
import { IdentityProjectionStore, parseDurableIdentity } from './identity-projection-store';
import { ProjectHistoryReader } from './project-history-reader';
import { RetentionHealthStore } from './retention-health-store';
import { RuntimeStateStore } from './runtime-state-store';
import { RunHistoryStore, type RunHistoryIdentityProjection } from './run-history-store';
import { createBasePersistenceSchema } from './schema';
import { SchemaHealthStore } from './schema-health-store';
import { createPersistenceStoreContext, type PersistenceDatabase, type PersistenceStoreContext } from './store-context';
import type {
  AppServerEventLedgerRecord,
  BreakerMetadataRecord,
  CompletedProviderUsageTotal,
  DurableRunHistoryRecord,
  DurableIdentity,
  DrainAuditEventRecord,
  AttemptRecord,
  ExecutionGraphEntityStatus,
  HistoryPayloadClass,
  ExecutionGraphThreadLineage,
  HistorySchemaHealth,
  HistoryWriteFailureRecord,
  IssueRunRecord,
  PhaseSpanRecord,
  PersistedBlockedInputRecord,
  PersistedOperatorActionsRecord,
  PersistenceHealth,
  PersistenceHealthOptions,
  ProjectHistoryTicketSummaryPage,
  RunTerminalStatus,
  StateTransitionRecord,
  TicketBlockerRecord,
  TicketTerminalOutcomeRecord,
  TicketTimelineRecord,
  ThreadRecord,
  TokenModelFactRecord,
  ToolSpanRecord,
  TurnRecord,
  UiContinuityState
} from './types';
import { hydrateTokenModelFact, type TokenModelFactDatabaseRecord } from './types';

interface PersistenceStoreOptions {
  dbPath: string;
  retentionDays: number;
  nowMs?: () => number;
  migrationFailureForTest?: string;
  pruneFailureForTest?: string;
  integrityCheckTtlMs?: number;
}

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

export class SqlitePersistenceStore {
  readonly completeRunIncludesTerminalEvidence = true;
  private readonly context: PersistenceStoreContext;
  private readonly dbPath: string;
  private readonly retentionDays: number;
  private readonly nowMs: () => number;
  private readonly migrationFailureForTest: string | undefined;
  private readonly pruneFailureForTest: string | undefined;
  private readonly executionGraphWriter: ExecutionGraphWriter;
  private readonly identityProjectionStore: IdentityProjectionStore;
  private readonly runHistoryStore: RunHistoryStore;
  private readonly projectHistoryReader: ProjectHistoryReader;
  private readonly runtimeStateStore: RuntimeStateStore;
  private readonly appServerLedgerStore: AppServerLedgerStore;
  private readonly retentionHealthStore: RetentionHealthStore;
  private readonly schemaHealthStore: SchemaHealthStore;
  private readonly historyMigrationStore: HistoryMigrationStore;
  private transactionDepth = 0;
  private readonly db: PersistenceDatabase;

  constructor(options: PersistenceStoreOptions) {
    this.context = createPersistenceStoreContext({
      dbPath: options.dbPath,
      retentionDays: options.retentionDays,
      nowMs: options.nowMs ?? (() => Date.now())
    });
    this.dbPath = this.context.dbPath;
    this.retentionDays = this.context.retentionDays;
    this.nowMs = this.context.nowMs;
    this.migrationFailureForTest = options.migrationFailureForTest;
    this.pruneFailureForTest = options.pruneFailureForTest;

    this.db = this.context.db;
    this.schemaHealthStore = new SchemaHealthStore({
      db: this.db,
      nowMs: this.nowMs
    });
    this.identityProjectionStore = new IdentityProjectionStore({
      db: this.db,
      nowMs: this.nowMs,
      isHistorySchemaHealthy: () => this.readHistorySchemaHealth().status === 'healthy',
      recordHistoryHealthMetadata: (status, reasonCode, detail) => this.recordHistoryHealthMetadata(status, reasonCode, detail)
    });
    this.executionGraphWriter = new ExecutionGraphWriter({
      db: this.db,
      transaction: (fn) => this.transaction(fn),
      upsertProjectIdentity: (project) => this.identityProjectionStore.upsertProjectIdentity(project),
      upsertHistoryIdentity: (identity) => this.identityProjectionStore.upsertHistoryIdentity(identity),
      recordIdentityProjection: (record) => this.identityProjectionStore.recordIdentityProjection(record),
      readIssueRunIdentity: (issueRunId) => this.identityProjectionStore.readIssueRunIdentity(issueRunId)
    });
    const runHistoryIdentityProjection: RunHistoryIdentityProjection = {
      upsertHistoryIdentity: (identity) => this.identityProjectionStore.upsertHistoryIdentity(identity),
      recordIdentityProjection: (record) => this.identityProjectionStore.recordIdentityProjection(record),
      lookupIssueRunIdForRun: (runId) => this.identityProjectionStore.lookupIssueRunIdForRun(runId),
      readHistoryIdentityProjection: (statement, sourceId) =>
        this.identityProjectionStore.readHistoryIdentityProjection(statement, sourceId)
    };
    this.runHistoryStore = new RunHistoryStore({
      db: this.db,
      nowMs: this.nowMs,
      transaction: (fn) => this.transaction(fn),
      identityProjection: runHistoryIdentityProjection,
      executionGraphWriter: this.executionGraphWriter
    });
    this.runtimeStateStore = new RuntimeStateStore({
      db: this.db,
      nowMs: this.nowMs
    });
    this.appServerLedgerStore = new AppServerLedgerStore({
      db: this.db,
      nowMs: this.nowMs
    });
    this.retentionHealthStore = new RetentionHealthStore({
      db: this.db,
      dbPath: this.dbPath,
      retentionDays: this.retentionDays,
      nowMs: this.nowMs,
      transaction: (fn) => this.transaction(fn),
      readHistorySchemaHealth: () => this.readHistorySchemaHealth(),
      recordHistoryHealthMetadata: (status, reasonCode, detail) => this.recordHistoryHealthMetadata(status, reasonCode, detail),
      listHistoryWriteFailures: (limit) => this.listHistoryWriteFailures(limit),
      pruneFailureForTest: this.pruneFailureForTest,
      integrityCheckTtlMs: options.integrityCheckTtlMs
    });
    this.projectHistoryReader = new ProjectHistoryReader({
      db: this.db
    });
    this.historyMigrationStore = new HistoryMigrationStore({
      context: this.context,
      db: this.db,
      nowMs: this.nowMs,
      identityAccess: this.identityProjectionStore,
      schemaHealthStore: this.schemaHealthStore,
      migrationFailureForTest: this.migrationFailureForTest
    });
    createBasePersistenceSchema(this.db);
    this.historyMigrationStore.runHistorySchemaMigrations();
  }

  close(): void {
    this.db.close();
  }

  historySchemaHealth(): HistorySchemaHealth {
    return this.readHistorySchemaHealth();
  }

  reconcileExecutionGraphAfterRestart(): { recovered: number; ambiguous: number } {
    const rows = this.db
      .prepare(
        `SELECT issue_run.issue_run_id, issue_run.issue_id, issue_run.started_at,
          runs.completed_at, runs.terminal_status, runs.terminal_reason_code, runs.terminal_reason_detail
         FROM issue_run
         LEFT JOIN runs ON runs.run_id = (
           SELECT projected_run.run_id
           FROM history_identity_projection
           JOIN runs AS projected_run ON projected_run.run_id = history_identity_projection.source_id
           WHERE history_identity_projection.source_table = 'runs'
             AND history_identity_projection.issue_run_id = issue_run.issue_run_id
           ORDER BY projected_run.started_at DESC, projected_run.run_id DESC
           LIMIT 1
         )
         WHERE issue_run.ended_at IS NULL
         ORDER BY issue_run.started_at ASC`
      )
      .all() as Array<{
      issue_run_id: string;
      issue_id: string;
      started_at: string;
      completed_at: string | null;
      terminal_status: RunTerminalStatus | null;
      terminal_reason_code: string | null;
      terminal_reason_detail: string | null;
    }>;
    let recovered = 0;
    let ambiguous = 0;
    for (const row of rows) {
      let recoveryAt = row.completed_at;
      let recoveryStatus = row.terminal_status;
      let recoveryDetail = 'Closed from the provably terminal parent run during startup reconciliation.';
      if (!recoveryAt || !recoveryStatus) {
        const terminalEvent = findLatestTerminalRunEventEvidence(this.db, row.issue_run_id, row.issue_id, row.started_at);
        if (terminalEvent) {
          recoveryAt = terminalEvent.at;
          recoveryStatus = terminalEvent.status;
          recoveryDetail = `Closed from terminal runner event ${terminalEvent.event} on run ${terminalEvent.run_id}.`;
        }
      }
      if (!recoveryAt || !recoveryStatus) {
        const supersedingRun = this.db
          .prepare(
            `SELECT issue_run_id, started_at
             FROM issue_run
             WHERE issue_id = ?
               AND issue_run_id <> ?
               AND started_at > ?
               AND ended_at IS NOT NULL
               AND status <> 'running'
             ORDER BY started_at ASC
             LIMIT 1`
          )
          .get(row.issue_id, row.issue_run_id, row.started_at) as
          | { issue_run_id: string; started_at: string }
          | undefined;
        if (supersedingRun) {
          recoveryAt = supersedingRun.started_at;
          recoveryStatus = 'cancelled';
          recoveryDetail = `Closed after later terminal issue run ${supersedingRun.issue_run_id} proved this run was superseded.`;
        }
      }
      const workerOwners = this.db
        .prepare(
          `SELECT thread.worker_instance_id, thread.worker_process_pid
           FROM thread
           JOIN attempt ON attempt.attempt_id = thread.attempt_id
           WHERE attempt.issue_run_id = ? AND thread.ended_at IS NULL`
        )
        .all(row.issue_run_id) as Array<{ worker_instance_id: string | null; worker_process_pid: number | null }>;
      const workerOwnership = classifyPersistedWorkerOwnership(workerOwners);
      if (workerOwnership === 'active_or_unknown') {
        ambiguous += 1;
        continue;
      }
      if (!recoveryAt || !recoveryStatus) {
        if (workerOwnership !== 'inactive') {
          ambiguous += 1;
          continue;
        }
        recoveryAt = row.started_at;
        recoveryStatus = 'failed';
        recoveryDetail = 'Closed after the persisted worker process was confirmed absent during restart reconciliation.';
      }
      const latestGraphTimestamp = this.db
        .prepare(
          `SELECT MAX(value) AS latest FROM (
             SELECT started_at AS value FROM issue_run WHERE issue_run_id = ?
             UNION ALL SELECT started_at FROM attempt WHERE issue_run_id = ?
             UNION ALL SELECT thread.started_at FROM thread JOIN attempt ON attempt.attempt_id = thread.attempt_id WHERE attempt.issue_run_id = ?
             UNION ALL SELECT turn.started_at FROM turn JOIN thread ON thread.thread_id = turn.thread_id JOIN attempt ON attempt.attempt_id = thread.attempt_id WHERE attempt.issue_run_id = ?
             UNION ALL SELECT phase_span.started_at FROM phase_span JOIN turn ON turn.turn_id = phase_span.turn_id JOIN thread ON thread.thread_id = turn.thread_id JOIN attempt ON attempt.attempt_id = thread.attempt_id WHERE attempt.issue_run_id = ?
             UNION ALL SELECT tool_span.started_at FROM tool_span JOIN turn ON turn.turn_id = tool_span.turn_id JOIN thread ON thread.thread_id = turn.thread_id JOIN attempt ON attempt.attempt_id = thread.attempt_id WHERE attempt.issue_run_id = ?
             UNION ALL SELECT transitioned_at FROM state_transition WHERE issue_run_id = ?
           )`
        )
        .get(
          row.issue_run_id,
          row.issue_run_id,
          row.issue_run_id,
          row.issue_run_id,
          row.issue_run_id,
          row.issue_run_id,
          row.issue_run_id
        ) as
        | { latest: string | null }
        | undefined;
      const endedAt = [recoveryAt, row.started_at, latestGraphTimestamp?.latest ?? row.started_at].sort().at(-1)!;
      const attempts = this.db
        .prepare('SELECT attempt_id, started_at FROM attempt WHERE issue_run_id = ? AND ended_at IS NULL ORDER BY attempt_number ASC')
        .all(row.issue_run_id) as Array<{ attempt_id: string; started_at: string }>;
      this.transaction(() => {
        for (const attempt of attempts) {
          const attemptEndedAt = endedAt < attempt.started_at ? attempt.started_at : endedAt;
          this.executionGraphWriter.appendStateTransition({
            issue_run_id: row.issue_run_id,
            attempt_id: attempt.attempt_id,
            from_status: 'running',
            to_status: recoveryStatus,
            transitioned_at: attemptEndedAt,
            status: recoveryStatus,
            reason_code: REASON_CODES.recoveredAfterRestart,
            reason_detail: recoveryDetail
          });
          this.executionGraphWriter.completeAttemptRow({
            attempt_id: attempt.attempt_id,
            ended_at: attemptEndedAt,
            status: recoveryStatus,
            process_status: recoveryStatus,
            workflow_outcome: recoveryStatus,
            reason_code: REASON_CODES.recoveredAfterRestart,
            reason_detail: recoveryDetail
          });
        }
        this.executionGraphWriter.completeIssueRunRow({
          issue_run_id: row.issue_run_id,
          ended_at: endedAt,
          status: recoveryStatus,
          process_status: recoveryStatus,
          workflow_outcome: recoveryStatus,
          reason_code: REASON_CODES.recoveredAfterRestart,
          reason_detail: recoveryDetail
        });
      });
      recovered += 1;
    }
    if (ambiguous > 0) {
      this.recordHistorySchemaState({
        appliedVersion: this.readHistorySchemaHealth().applied_version,
        status: 'degraded',
        degradedReasonCode: 'history_orphan_reconciliation_ambiguous',
        degradedDetail: `${ambiguous} active issue run(s) have ambiguous parent or worker ownership.`
      });
      this.recordHistoryHealthMetadata(
        'degraded',
        'history_orphan_reconciliation_ambiguous',
        `${ambiguous} active issue run(s) have ambiguous parent or worker ownership.`
      );
    } else if (this.readHistorySchemaHealth().degraded_reason_code === 'history_orphan_reconciliation_ambiguous') {
      this.recordHistorySchemaState({
        appliedVersion: this.readHistorySchemaHealth().applied_version,
        status: 'healthy',
        degradedReasonCode: null,
        degradedDetail: null
      });
      this.recordHistoryHealthMetadata('healthy', null, null);
    }
    return { recovered, ambiguous };
  }

  recordHistoryWriteFailure(params: { operation: string; reason_code: string; detail?: string | null }): void {
    const recordedAt = asIso(this.nowMs());
    const detail = redactUnknown(params.detail ?? null) as string | null;
    this.db
      .prepare(
        `INSERT INTO history_write_failure
          (operation, reason_code, detail, recorded_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(params.operation, params.reason_code, detail, recordedAt);
    this.recordHistorySchemaState({
      appliedVersion: this.readHistorySchemaHealth().applied_version,
      status: 'degraded',
      degradedReasonCode: 'history_write_failed',
      degradedDetail: `${params.operation}: ${params.reason_code}`
    });
    this.recordHistoryHealthMetadata('degraded', 'history_write_failed', `${params.operation}: ${params.reason_code}`);
  }

  listHistoryWriteFailures(limit = 20): HistoryWriteFailureRecord[] {
    return this.db
      .prepare(
        `SELECT operation, reason_code, detail, recorded_at
         FROM history_write_failure
         ORDER BY recorded_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(limit) as HistoryWriteFailureRecord[];
  }

  startRun(params: {
    issue_id: string;
    issue_identifier: string;
    identity: DurableIdentity;
    started_at?: string;
    issue_run_id?: string | null;
  }): string {
    return this.runHistoryStore.startRun(params);
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
    return this.runHistoryStore.recordRunStarted(params);
  }

  recordSession(runId: string, sessionId: string): void {
    this.runHistoryStore.recordSession(runId, sessionId);
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
    this.runHistoryStore.recordEvent(params);
  }

  appendAppServerEvent(params: {
    issue_run_id: string;
    observed_at: string;
    source_event_id: string;
    source_event_name: string;
    payload_class: HistoryPayloadClass;
    raw_payload?: unknown;
    summary?: string | null;
    summary_fields?: Record<string, unknown>;
    unavailable_reason_code?: string | null;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    app_server_event_id?: string;
  }): string {
    return this.appServerLedgerStore.appendAppServerEvent(params);
  }

  listAppServerEventLedger(issueRunId: string): AppServerEventLedgerRecord[] {
    return this.appServerLedgerStore.listAppServerEventLedger(issueRunId);
  }

  appendIssueRun(params: AppendIssueRunParams): string {
    return this.executionGraphWriter.appendIssueRun(params);
  }

  appendAttempt(params: AppendAttemptParams): string {
    return this.executionGraphWriter.appendAttempt(params);
  }

  appendThread(params: AppendThreadParams): string {
    return this.executionGraphWriter.appendThread(params);
  }

  appendTurn(params: AppendTurnParams): string {
    return this.executionGraphWriter.appendTurn(params);
  }

  appendPhaseSpan(params: AppendPhaseSpanParams): string {
    return this.executionGraphWriter.appendPhaseSpan(params);
  }

  appendToolSpan(params: AppendToolSpanParams): string {
    return this.executionGraphWriter.appendToolSpan(params);
  }

  appendStateTransition(params: AppendStateTransitionParams): string {
    return this.executionGraphWriter.appendStateTransition(params);
  }

  appendTicketTerminalOutcome(params: AppendTicketTerminalOutcomeParams): string {
    return this.executionGraphWriter.appendTicketTerminalOutcome(params);
  }

  appendTicketBlocker(params: AppendTicketBlockerParams): string {
    return this.executionGraphWriter.appendTicketBlocker(params);
  }

  appendTicketEvidenceReference(params: AppendTicketEvidenceReferenceParams): string {
    return this.executionGraphWriter.appendTicketEvidenceReference(params);
  }

  appendTrackerTicketSnapshot(params: AppendTrackerTicketSnapshotParams): string {
    return this.executionGraphWriter.appendTrackerTicketSnapshot(params);
  }

  appendTicketReference(params: AppendTicketReferenceParams): string {
    return this.executionGraphWriter.appendTicketReference(params);
  }

  appendOperatorActionHistory(params: AppendOperatorActionHistoryParams): string {
    return this.executionGraphWriter.appendOperatorActionHistory(params);
  }

  appendDrainAuditHistory(params: AppendDrainAuditHistoryParams): string {
    return this.executionGraphWriter.appendDrainAuditHistory(params);
  }

  listProjectDrainAuditEvents(
    projectKey: string,
    options: { limit?: number; offset?: number } = {}
  ): { items: DrainAuditEventRecord[]; limit: number; offset: number; has_more: boolean; total: number } {
    return this.projectHistoryReader.listProjectDrainAuditEvents(projectKey, options);
  }

  appendBlockedInputEvent(params: AppendBlockedInputEventParams): string {
    return this.executionGraphWriter.appendBlockedInputEvent(params);
  }

  appendTokenModelFact(params: AppendTokenModelFactParams): string {
    return this.executionGraphWriter.appendTokenModelFact(params);
  }

  appendProviderUsageStepFact(params: AppendProviderUsageStepFactParams): string {
    return this.executionGraphWriter.appendProviderUsageStepFact(params);
  }

  reconstructThreadLineage(threadId: string): ExecutionGraphThreadLineage | null {
    const thread = this.db.prepare('SELECT * FROM thread WHERE thread_id = ?').get(threadId) as ThreadRecord | undefined;
    if (!thread) {
      return null;
    }
    const attempt = this.db.prepare('SELECT * FROM attempt WHERE attempt_id = ?').get(thread.attempt_id) as AttemptRecord;
    const issueRunRow = this.db.prepare('SELECT * FROM issue_run WHERE issue_run_id = ?').get(attempt.issue_run_id) as
      | (Omit<IssueRunRecord, 'identity'> & { identity: string | null })
      | undefined;
    if (!issueRunRow) {
      throw new Error(`issue_run ${attempt.issue_run_id} does not exist`);
    }
    const issueRun: IssueRunRecord = {
      ...issueRunRow,
      identity: parseDurableIdentity(issueRunRow.identity)
    };
    const transitions = this.db
      .prepare('SELECT * FROM state_transition WHERE issue_run_id = ? ORDER BY transitioned_at ASC, state_transition_id ASC')
      .all(issueRun.issue_run_id) as StateTransitionRecord[];
    const turns = this.db
      .prepare('SELECT * FROM turn WHERE thread_id = ? ORDER BY turn_index ASC, started_at ASC')
      .all(threadId) as TurnRecord[];
    const tokenModelFacts = (this.db
      .prepare(
        `SELECT * FROM history_token_model_fact
         WHERE issue_run_id = ?
         ORDER BY observed_at ASC, token_model_fact_id ASC`
      )
      .all(issueRun.issue_run_id) as TokenModelFactDatabaseRecord[]).map(hydrateTokenModelFact);

    return {
      issue_run: issueRun,
      attempt,
      thread,
      turns: turns.map((turn) => ({
        ...turn,
        phase_spans: this.db
          .prepare('SELECT * FROM phase_span WHERE turn_id = ? ORDER BY started_at ASC, phase_span_id ASC')
          .all(turn.turn_id) as PhaseSpanRecord[],
        tool_spans: this.db
          .prepare('SELECT * FROM tool_span WHERE turn_id = ? ORDER BY started_at ASC, tool_span_id ASC')
          .all(turn.turn_id) as ToolSpanRecord[],
        state_transitions: transitions.filter((transition) => transition.turn_id === turn.turn_id),
        token_model_facts: tokenModelFacts.filter((fact) => fact.turn_id === turn.turn_id)
      })),
      state_transitions: transitions,
      token_model_facts: tokenModelFacts
    };
  }

  reconstructLatestThreadLineageByIssueIdentifier(issueIdentifier: string): ExecutionGraphThreadLineage | null {
    const row = this.db
      .prepare(
        `SELECT thread.thread_id
        FROM issue_run
        JOIN attempt ON attempt.issue_run_id = issue_run.issue_run_id
        JOIN thread ON thread.attempt_id = attempt.attempt_id
        WHERE issue_run.issue_identifier = ?
        ORDER BY issue_run.started_at DESC, attempt.attempt_number DESC, thread.started_at DESC, thread.thread_id DESC
        LIMIT 1`
      )
      .get(issueIdentifier) as { thread_id: string } | undefined;
    return row ? this.reconstructThreadLineage(row.thread_id) : null;
  }

  listProjectTicketIdentities(
    projectKey: string,
    options: { limit?: number; offset?: number } = {}
  ): { items: DurableIdentity[]; limit: number; offset: number; has_more: boolean; total: number } {
    return this.projectHistoryReader.listProjectTicketIdentities(projectKey, options);
  }

  listProjectTicketSummaries(
    projectKey: string,
    options: { limit?: number; offset?: number } = {}
  ): ProjectHistoryTicketSummaryPage {
    return this.projectHistoryReader.listProjectTicketSummaries(projectKey, options);
  }

  getProjectTicketIdentity(projectKey: string, ticketKey: string): DurableIdentity | null {
    return this.projectHistoryReader.getProjectTicketIdentity(projectKey, ticketKey);
  }

  reconstructTicketTimeline(identity: DurableIdentity): TicketTimelineRecord {
    return this.projectHistoryReader.reconstructTicketTimeline(identity);
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
    this.runHistoryStore.completeRun(params);
  }

  listRunHistory(limit = 50): DurableRunHistoryRecord[] {
    return this.runHistoryStore.listRunHistory(limit);
  }

  listCompletedProviderUsageTotals(excludeIssueRunIds: string[] = []): CompletedProviderUsageTotal[] {
    return this.runHistoryStore.listCompletedProviderUsageTotals(excludeIssueRunIds);
  }

  private recordHistoryHealthMetadata(status: 'healthy' | 'degraded', reasonCode: string | null, detail: string | null): void {
    this.schemaHealthStore.recordHistoryHealthMetadata(status, reasonCode, detail);
  }

  private recordHistorySchemaState(params: {
    appliedVersion: number;
    status: 'healthy' | 'degraded';
    degradedReasonCode: string | null;
    degradedDetail: string | null;
  }): void {
    this.schemaHealthStore.recordHistorySchemaState(params);
  }

  private readHistorySchemaHealth(): HistorySchemaHealth {
    return this.schemaHealthStore.readHistorySchemaHealth();
  }

  saveUiState(state: UiContinuityState): void {
    this.runtimeStateStore.saveUiState(state);
  }

  loadUiState(): UiContinuityState | null {
    return this.runtimeStateStore.loadUiState();
  }

  upsertBreaker(record: BreakerMetadataRecord): void {
    this.runtimeStateStore.upsertBreaker(record);
  }

  deleteBreaker(issueId: string): void {
    this.runtimeStateStore.deleteBreaker(issueId);
  }

  listBreakers(): BreakerMetadataRecord[] {
    return this.runtimeStateStore.listBreakers();
  }

  upsertBlockedInput(issueId: string, payload: string): void {
    this.runtimeStateStore.upsertBlockedInput(issueId, payload);
  }

  deleteBlockedInput(issueId: string): void {
    this.runtimeStateStore.deleteBlockedInput(issueId);
  }

  listBlockedInputs(): PersistedBlockedInputRecord[] {
    return this.runtimeStateStore.listBlockedInputs();
  }

  upsertOperatorActions(issueId: string, payload: string): void {
    this.runtimeStateStore.upsertOperatorActions(issueId, payload);
  }

  listOperatorActions(): PersistedOperatorActionsRecord[] {
    return this.runtimeStateStore.listOperatorActions();
  }

  pruneExpiredRuns(): number {
    return this.retentionHealthStore.pruneExpiredRuns();
  }

  health(options: PersistenceHealthOptions = {}): PersistenceHealth {
    return this.retentionHealthStore.health(options);
  }

  private transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      return fn();
    }
    this.db.exec('BEGIN;');
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      this.transactionDepth -= 1;
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Preserve the original write error for callers.
      }
      this.transactionDepth -= 1;
      throw error;
    }
  }
}
