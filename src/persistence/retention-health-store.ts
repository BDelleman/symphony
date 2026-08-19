import { createHash } from 'node:crypto';

import { redactUnknown } from '../security/redaction';
import type { PersistenceDatabase } from './store-context';
import type {
  ExecutionGraphEntityStatus,
  HistorySchemaHealth,
  HistoryWriteFailureRecord,
  PersistenceHealth,
  PersistenceHealthOptions,
  PersistenceIntegrityCheckStatus,
  RunTerminalStatus
} from './types';

export interface RetentionHealthStoreDependencies {
  db: PersistenceDatabase;
  dbPath: string;
  retentionDays: number;
  nowMs: () => number;
  transaction: <T>(fn: () => T) => T;
  readHistorySchemaHealth: () => HistorySchemaHealth;
  recordHistoryHealthMetadata: (status: 'healthy' | 'degraded', reasonCode: string | null, detail: string | null) => void;
  listHistoryWriteFailures: (limit: number) => HistoryWriteFailureRecord[];
  pruneFailureForTest?: string;
  integrityCheckTtlMs?: number;
}

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
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

export class RetentionHealthStore {
  private static readonly DEFAULT_INTEGRITY_CHECK_TTL_MS = 5 * 60 * 1000;

  private readonly db: PersistenceDatabase;
  private readonly dbPath: string;
  private readonly retentionDays: number;
  private readonly nowMs: () => number;
  private readonly transaction: <T>(fn: () => T) => T;
  private readonly readHistorySchemaHealth: () => HistorySchemaHealth;
  private readonly recordHistoryHealthMetadata: (status: 'healthy' | 'degraded', reasonCode: string | null, detail: string | null) => void;
  private readonly listHistoryWriteFailures: (limit: number) => HistoryWriteFailureRecord[];
  private readonly pruneFailureForTest: string | undefined;
  private readonly integrityCheckTtlMs: number;
  private integrityCheckCache: {
    checkedAtMs: number;
    ok: boolean;
    durationMs: number;
    source: PersistenceHealthOptions['integrity_check_source'];
    detail: string | null;
  } | null = null;

  constructor(dependencies: RetentionHealthStoreDependencies) {
    this.db = dependencies.db;
    this.dbPath = dependencies.dbPath;
    this.retentionDays = dependencies.retentionDays;
    this.nowMs = dependencies.nowMs;
    this.transaction = dependencies.transaction;
    this.readHistorySchemaHealth = dependencies.readHistorySchemaHealth;
    this.recordHistoryHealthMetadata = dependencies.recordHistoryHealthMetadata;
    this.listHistoryWriteFailures = dependencies.listHistoryWriteFailures;
    this.pruneFailureForTest = dependencies.pruneFailureForTest;
    this.integrityCheckTtlMs =
      typeof dependencies.integrityCheckTtlMs === 'number' && dependencies.integrityCheckTtlMs >= 0
        ? dependencies.integrityCheckTtlMs
        : RetentionHealthStore.DEFAULT_INTEGRITY_CHECK_TTL_MS;
  }

  pruneExpiredRuns(): number {
    const cutoffMs = this.nowMs() - this.retentionDays * 24 * 60 * 60 * 1000;
    const cutoff = asIso(cutoffMs);
    const prunedAt = asIso(this.nowMs());

    try {
      if (this.pruneFailureForTest) {
        throw new Error(this.pruneFailureForTest);
      }

      return this.transaction(() => {
        const expiredRuns = this.expiredCompletedRuns(cutoff);
        const expiredIssueRuns = this.expiredCompletedIssueRuns(cutoff);
        let pruned = 0;

        for (const item of expiredRuns) {
          this.recordRetentionPrune({
            source_table: 'runs',
            source_id: item.run_id,
            issue_id: item.issue_id,
            issue_identifier: item.issue_identifier,
            project_key: item.project_key,
            ticket_key: item.ticket_key,
            started_at: item.started_at,
            completed_at: item.completed_at,
            cutoff_at: cutoff,
            pruned_at: prunedAt,
            pruned_record_count: item.pruned_record_count,
            metadata: {
              terminal_status: item.terminal_status,
              pruned_tables: ['run_sessions', 'run_events', 'runs']
            }
          });
          this.db.prepare('DELETE FROM run_sessions WHERE run_id = ?').run(item.run_id);
          this.db.prepare('DELETE FROM run_events WHERE run_id = ?').run(item.run_id);
          this.db.prepare('DELETE FROM runs WHERE run_id = ?').run(item.run_id);
          pruned += 1;
        }

        for (const item of expiredIssueRuns) {
          this.recordRetentionPrune({
            source_table: 'issue_run',
            source_id: item.issue_run_id,
            issue_id: item.issue_id,
            issue_identifier: item.issue_identifier,
            project_key: item.project_key,
            ticket_key: item.ticket_key,
            started_at: item.started_at,
            completed_at: item.completed_at,
            cutoff_at: cutoff,
            pruned_at: prunedAt,
            pruned_record_count: item.pruned_record_count,
            metadata: {
              status: item.status,
              pruned_tables: [
                'history_app_server_event',
                'history_protocol_summary',
                'history_token_model_fact',
                'history_provider_usage_step_fact',
                'history_ticket_evidence_reference',
                'history_ticket_blocker',
                'history_ticket_terminal_outcome',
                'history_tracker_ticket_snapshot',
                'history_ticket_reference',
                'history_operator_action',
                'history_drain_audit_event',
                'history_blocked_input_event',
                'state_transition',
                'tool_span',
                'phase_span',
                'turn',
                'thread',
                'attempt',
                'issue_run'
              ]
            }
          });
          this.deleteIssueRunHistory(item.issue_run_id);
          pruned += 1;
        }

        this.db
          .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run('last_pruned_at', prunedAt);
        this.updateHistoryRetentionMetadata();

        return pruned;
      });
    } catch (error) {
      this.recordPruneFailure(error);
      throw error;
    }
  }

  health(options: PersistenceHealthOptions = {}): PersistenceHealth {
    const depth = options.depth ?? 'fast';
    const runCountRow = this.db.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number };
    const ticketCountRow = this.hasTable('history_identity_projection')
      ? (this.db
          .prepare(
            `SELECT COUNT(DISTINCT COALESCE(ticket_key, issue_identifier, issue_id)) AS count
             FROM history_identity_projection`
          )
          .get() as { count: number })
      : { count: 0 };
    const pruneRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('last_pruned_at') as
      | { value: string }
      | undefined;
    const pruneFailureAtRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('last_prune_failure_at') as
      | { value: string }
      | undefined;
    const pruneFailureReasonRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('last_prune_failure_reason') as
      | { value: string }
      | undefined;
    const pruneFailureDetailRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('last_prune_failure_detail') as
      | { value: string }
      | undefined;

    const historySchema = this.readHistorySchemaHealth();
    const integrityCheck = this.readIntegrityCheckStatus(options);
    const healthOk = integrityCheck.status !== 'failed' && historySchema.status === 'healthy';
    try {
      this.recordHistoryHealthMetadata(historySchema.status, historySchema.degraded_reason_code, historySchema.degraded_detail);
    } catch {
      // If the history schema is degraded before v1 tables exist, the durable
      // schema_state row remains the source of truth for the degraded status.
    }

    return {
      enabled: true,
      db_path: this.dbPath,
      retention_days: this.retentionDays,
      health_depth: depth,
      run_count: runCountRow.count,
      ticket_count: ticketCountRow.count,
      last_pruned_at: pruneRow?.value ?? null,
      last_prune_failure_at: pruneFailureAtRow?.value ?? null,
      last_prune_failure_reason: pruneFailureReasonRow?.value ?? null,
      last_prune_failure_detail: pruneFailureDetailRow?.value ?? null,
      integrity_ok: healthOk,
      integrity_check: integrityCheck,
      history_schema: historySchema,
      recent_write_failures: this.listHistoryWriteFailures(5)
    };
  }

  private readIntegrityCheckStatus(options: PersistenceHealthOptions): PersistenceIntegrityCheckStatus {
    const depth = options.depth ?? 'fast';
    if (depth === 'deep' || options.force_integrity_check) {
      return this.runIntegrityCheck(options.integrity_check_source ?? 'diagnostics');
    }
    return this.cachedIntegrityCheckStatus();
  }

  private cachedIntegrityCheckStatus(): PersistenceIntegrityCheckStatus {
    const now = this.nowMs();
    if (!this.integrityCheckCache) {
      return {
        status: 'unknown',
        freshness: 'unknown',
        checked_at: null,
        checked_at_ms: null,
        duration_ms: null,
        source: null,
        detail: null
      };
    }
    const fresh = now - this.integrityCheckCache.checkedAtMs < this.integrityCheckTtlMs;
    return {
      status: this.integrityCheckCache.ok ? 'ok' : 'failed',
      freshness: fresh ? 'fresh' : 'stale',
      checked_at: asIso(this.integrityCheckCache.checkedAtMs),
      checked_at_ms: this.integrityCheckCache.checkedAtMs,
      duration_ms: this.integrityCheckCache.durationMs,
      source: this.integrityCheckCache.source ?? null,
      detail: this.integrityCheckCache.detail
    };
  }

  private runIntegrityCheck(source: PersistenceHealthOptions['integrity_check_source']): PersistenceIntegrityCheckStatus {
    const startedAtMs = this.nowMs();
    const integrityRow = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    const checkedAtMs = this.nowMs();
    const ok = integrityRow.integrity_check === 'ok';
    this.integrityCheckCache = {
      checkedAtMs,
      ok,
      durationMs: Math.max(0, checkedAtMs - startedAtMs),
      source,
      detail: ok ? null : integrityRow.integrity_check
    };
    return this.cachedIntegrityCheckStatus();
  }

  private expiredCompletedRuns(cutoff: string): Array<{
    run_id: string;
    issue_id: string;
    issue_identifier: string;
    project_key: string | null;
    ticket_key: string | null;
    started_at: string;
    completed_at: string;
    terminal_status: RunTerminalStatus;
    pruned_record_count: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT runs.run_id, runs.issue_id, runs.issue_identifier,
          history_identity_projection.project_key, history_identity_projection.ticket_key,
          runs.started_at, COALESCE(runs.completed_at, runs.ended_at) AS completed_at, runs.terminal_status,
          (1
            + (SELECT COUNT(*) FROM run_sessions WHERE run_sessions.run_id = runs.run_id)
            + (SELECT COUNT(*) FROM run_events WHERE run_events.run_id = runs.run_id)
          ) AS pruned_record_count
         FROM runs
         LEFT JOIN history_identity_projection
          ON history_identity_projection.source_table = 'runs'
          AND history_identity_projection.source_id = runs.run_id
         WHERE runs.terminal_status IS NOT NULL
          AND COALESCE(runs.completed_at, runs.ended_at) IS NOT NULL
          AND COALESCE(runs.completed_at, runs.ended_at) < ?
         ORDER BY completed_at ASC, runs.run_id ASC`
      )
      .all(cutoff) as Array<{
      run_id: string;
      issue_id: string;
      issue_identifier: string;
      project_key: string | null;
      ticket_key: string | null;
      started_at: string;
      completed_at: string;
      terminal_status: RunTerminalStatus;
      pruned_record_count: number;
    }>;
    return rows;
  }

  private expiredCompletedIssueRuns(cutoff: string): Array<{
    issue_run_id: string;
    issue_id: string;
    issue_identifier: string;
    project_key: string | null;
    ticket_key: string | null;
    started_at: string;
    ended_at: string;
    completed_at: string;
    status: ExecutionGraphEntityStatus;
    pruned_record_count: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT issue_run.issue_run_id, issue_run.issue_id, issue_run.issue_identifier,
          issue_run.project_key, issue_run.ticket_key, issue_run.started_at, issue_run.ended_at, issue_run.status,
          issue_run.ended_at AS completed_at,
          (1
            + (SELECT COUNT(*) FROM attempt WHERE attempt.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM thread JOIN attempt ON attempt.attempt_id = thread.attempt_id WHERE attempt.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM turn JOIN thread ON thread.thread_id = turn.thread_id JOIN attempt ON attempt.attempt_id = thread.attempt_id WHERE attempt.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM phase_span JOIN turn ON turn.turn_id = phase_span.turn_id JOIN thread ON thread.thread_id = turn.thread_id JOIN attempt ON attempt.attempt_id = thread.attempt_id WHERE attempt.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM tool_span JOIN turn ON turn.turn_id = tool_span.turn_id JOIN thread ON thread.thread_id = turn.thread_id JOIN attempt ON attempt.attempt_id = thread.attempt_id WHERE attempt.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM state_transition WHERE state_transition.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_ticket_terminal_outcome WHERE history_ticket_terminal_outcome.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_ticket_blocker WHERE history_ticket_blocker.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_ticket_evidence_reference WHERE history_ticket_evidence_reference.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_tracker_ticket_snapshot WHERE history_tracker_ticket_snapshot.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_ticket_reference WHERE history_ticket_reference.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_operator_action WHERE history_operator_action.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_drain_audit_event WHERE history_drain_audit_event.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_blocked_input_event WHERE history_blocked_input_event.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_protocol_summary WHERE history_protocol_summary.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_token_model_fact WHERE history_token_model_fact.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_provider_usage_step_fact WHERE history_provider_usage_step_fact.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_app_server_event WHERE history_app_server_event.issue_run_id = issue_run.issue_run_id)
          ) AS pruned_record_count
         FROM issue_run
         WHERE issue_run.ended_at IS NOT NULL
          AND issue_run.ended_at < ?
          AND issue_run.status IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'stalled')
         ORDER BY issue_run.ended_at ASC, issue_run.issue_run_id ASC`
      )
      .all(cutoff) as Array<{
      issue_run_id: string;
      issue_id: string;
      issue_identifier: string;
      project_key: string | null;
      ticket_key: string | null;
      started_at: string;
      ended_at: string;
      completed_at: string;
      status: ExecutionGraphEntityStatus;
      pruned_record_count: number;
    }>;
    return rows;
  }

  private recordRetentionPrune(params: {
    source_table: 'runs' | 'issue_run';
    source_id: string;
    issue_id: string;
    issue_identifier: string;
    project_key: string | null;
    ticket_key: string | null;
    started_at: string;
    completed_at: string;
    cutoff_at: string;
    pruned_at: string;
    pruned_record_count: number;
    metadata: Record<string, unknown>;
  }): void {
    if (!this.hasTable('history_retention_prune_record')) {
      return;
    }
    const pruneRecordId = asExecutionGraphId('retention_prune', [
      params.source_table,
      params.source_id,
      params.cutoff_at,
      params.pruned_at
    ]);
    this.db
      .prepare(
        `INSERT INTO history_retention_prune_record
          (prune_record_id, source_table, source_id, issue_id, issue_identifier, project_key, ticket_key,
           started_at, completed_at, pruned_at, retention_days, cutoff_at, pruned_record_count, reason_code, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        pruneRecordId,
        params.source_table,
        params.source_id,
        params.issue_id,
        params.issue_identifier,
        params.project_key,
        params.ticket_key,
        params.started_at,
        params.completed_at,
        params.pruned_at,
        this.retentionDays,
        params.cutoff_at,
        params.pruned_record_count,
        'retention_policy_expired_completed_history',
        JSON.stringify(redactUnknown(params.metadata))
      );
  }

  private deleteIssueRunHistory(issueRunId: string): void {
    this.db.prepare('DELETE FROM history_app_server_event WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_protocol_summary WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_provider_usage_step_fact WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_token_model_fact WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_ticket_evidence_reference WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_ticket_blocker WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_ticket_terminal_outcome WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_tracker_ticket_snapshot WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_ticket_reference WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_operator_action WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_drain_audit_event WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_blocked_input_event WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM state_transition WHERE issue_run_id = ?').run(issueRunId);
    this.db
      .prepare(
        `DELETE FROM tool_span
         WHERE turn_id IN (
          SELECT turn.turn_id FROM turn
          JOIN thread ON thread.thread_id = turn.thread_id
          JOIN attempt ON attempt.attempt_id = thread.attempt_id
          WHERE attempt.issue_run_id = ?
         )`
      )
      .run(issueRunId);
    this.db
      .prepare(
        `DELETE FROM phase_span
         WHERE turn_id IN (
          SELECT turn.turn_id FROM turn
          JOIN thread ON thread.thread_id = turn.thread_id
          JOIN attempt ON attempt.attempt_id = thread.attempt_id
          WHERE attempt.issue_run_id = ?
         )`
      )
      .run(issueRunId);
    this.db
      .prepare(
        `DELETE FROM turn
         WHERE thread_id IN (
          SELECT thread.thread_id FROM thread
          JOIN attempt ON attempt.attempt_id = thread.attempt_id
          WHERE attempt.issue_run_id = ?
         )`
      )
      .run(issueRunId);
    this.db
      .prepare('DELETE FROM thread WHERE attempt_id IN (SELECT attempt_id FROM attempt WHERE issue_run_id = ?)')
      .run(issueRunId);
    this.db.prepare('DELETE FROM attempt WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM issue_run WHERE issue_run_id = ?').run(issueRunId);
  }

  private recordPruneFailure(error: unknown): void {
    const failedAt = asIso(this.nowMs());
    const detail = error instanceof Error ? error.message : String(error);
    const redactedDetail = redactUnknown(detail) as string;
    const entries: Array<[string, string]> = [
      ['last_prune_failure_at', failedAt],
      ['last_prune_failure_reason', 'retention_prune_failed'],
      ['last_prune_failure_detail', redactedDetail]
    ];
    const upsert = this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [key, value] of entries) {
      upsert.run(key, value);
    }
    try {
      this.recordHistoryHealthMetadata('degraded', 'retention_prune_failed', redactedDetail);
    } catch {
      // Keep meta-level failure evidence even if history health tables are unavailable.
    }
  }

  private updateHistoryRetentionMetadata(): void {
    if (this.readHistorySchemaHealth().status !== 'healthy') {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO history_retention_metadata
          (singleton_id, retention_days, last_pruned_at, policy_version, updated_at)
         VALUES (1, ?, (SELECT value FROM meta WHERE key = 'last_pruned_at'), 1, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
          retention_days = excluded.retention_days,
          last_pruned_at = excluded.last_pruned_at,
          policy_version = excluded.policy_version,
          updated_at = excluded.updated_at`
      )
      .run(this.retentionDays, asIso(this.nowMs()));
  }

  private hasTable(name: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { name: string } | undefined;
    return Boolean(row);
  }
}
