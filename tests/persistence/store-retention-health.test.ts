import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDurableIdentity,
  createStoreTestHarness,
  fs,
  os,
  path,
  SqlitePersistenceStore
} from './store-test-harness';
import { RetentionHealthStore } from '../../src/persistence/retention-health-store';

describe('SqlitePersistenceStore retention and health', () => {
  const { dirs, stores, identity, openDatabase, tableNames, withLegacyProjectKey, cleanup } = createStoreTestHarness();

  afterEach(cleanup);
  it('applies retention pruning and reports integrity', async () => {
    const base = Date.parse('2026-04-11T12:00:00.000Z');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-prune-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base });
    stores.push(store);

    const runId = store.startRun({
      issue_id: 'i-old',
      issue_identifier: 'OLD-1',
      identity: identity({ issue_id: 'i-old', issue_identifier: 'OLD-1' })
    });
    store.completeRun({ run_id: runId, terminal_status: 'failed', error_code: 'token=abcd1234' });

    // Move clock forward by 2 days and prune.
    const lateStore = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base + 2 * 24 * 60 * 60 * 1000 });
    stores.push(lateStore);
    const pruned = lateStore.pruneExpiredRuns();
    expect(pruned).toBeGreaterThanOrEqual(1);

    const health = lateStore.health();
    expect(health.integrity_ok).toBe(true);
    expect(health.last_pruned_at).not.toBeNull();
  });

  it('applies retention to completed operational history and preserves active evidence', async () => {
    const base = Date.parse('2026-04-11T12:00:00.000Z');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-retention-operational-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base });
    stores.push(store);

    const expiredRunId = store.startRun({
      issue_id: 'expired-run',
      issue_identifier: 'EXP-1',
      identity: identity({ issue_id: 'expired-run', issue_identifier: 'EXP-1' }),
      started_at: '2026-04-10T10:00:00.000Z'
    });
    store.recordSession(expiredRunId, 'expired-session');
    store.recordEvent({
      run_id: expiredRunId,
      event: 'completed',
      message: 'expired run event',
      timestamp_ms: Date.parse('2026-04-10T10:05:00.000Z')
    });
    store.completeRun({ run_id: expiredRunId, terminal_status: 'succeeded' });

    const activeRunId = store.startRun({
      issue_id: 'active-run',
      issue_identifier: 'ACTIVE-RETENTION-1',
      identity: identity({ issue_id: 'active-run', issue_identifier: 'ACTIVE-RETENTION-1' }),
      started_at: '2026-04-10T09:00:00.000Z'
    });

    const expiredGraph = store.recordRunStarted({
      issue_id: 'expired-issue-run',
      issue_identifier: 'EXP-ISSUE-1',
      identity: identity({ issue_id: 'expired-issue-run', issue_identifier: 'EXP-ISSUE-1' }),
      started_at: '2026-04-10T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const expiredThreadId = store.appendThread({
      attempt_id: expiredGraph.attempt_id,
      thread_id: 'expired-thread-retention',
      started_at: '2026-04-10T10:00:02.000Z',
      status: 'running'
    });
    const expiredTurnId = store.appendTurn({
      thread_id: expiredThreadId,
      turn_id: 'expired-turn-retention',
      turn_index: 0,
      started_at: '2026-04-10T10:00:03.000Z',
      status: 'running'
    });
    store.appendAppServerEvent({
      issue_run_id: expiredGraph.issue_run_id,
      attempt_id: expiredGraph.attempt_id,
      thread_id: expiredThreadId,
      turn_id: expiredTurnId,
      observed_at: '2026-04-10T10:00:04.000Z',
      source_event_id: 'expired-app-event',
      source_event_name: 'rawResponseItem/completed',
      payload_class: 'protocol_request_response',
      raw_payload: { message: 'old protocol evidence' },
      summary: 'old protocol evidence'
    });
    store.appendProviderUsageStepFact({
      issue_run_id: expiredGraph.issue_run_id,
      attempt_id: expiredGraph.attempt_id,
      thread_id: expiredThreadId,
      turn_id: expiredTurnId,
      message_id_hash: 'a'.repeat(64),
      model: 'claude-sonnet-4-6',
      input_tokens: 4,
      output_tokens: 2,
      cache_read_tokens: 1,
      cache_creation_tokens: 0,
      observed_at: '2026-04-10T10:00:04.500Z'
    });
    store.appendDrainAuditHistory({
      issue_run_id: expiredGraph.issue_run_id,
      project_identity: identity({ issue_id: 'expired-issue-run', issue_identifier: 'EXP-ISSUE-1' }).project,
      event_type: 'wait-timed-out',
      actor: 'operator',
      source: 'api',
      result: 'rejected',
      result_code: 'timeout',
      state_context: { safe_to_shutdown: false, blocker_count: 1 },
      blocker_summaries: [{ category: 'active_worker', count: 1, issue_identifiers: ['EXP-ISSUE-1'] }],
      occurred_at: '2026-04-10T10:00:05.000Z',
      observed_at: '2026-04-10T10:00:05.000Z'
    });
    store.completeRun({ run_id: expiredGraph.run_id, terminal_status: 'succeeded' });

    const activeIssueRunId = store.appendIssueRun({
      issue_id: 'active-issue-run',
      issue_identifier: 'ACTIVE-ISSUE-1',
      identity: identity({ issue_id: 'active-issue-run', issue_identifier: 'ACTIVE-ISSUE-1' }),
      started_at: '2026-04-10T09:00:00.000Z',
      status: 'running'
    });
    const activeAttemptId = store.appendAttempt({
      issue_run_id: activeIssueRunId,
      attempt_number: 0,
      started_at: '2026-04-10T09:00:01.000Z',
      status: 'running'
    });
    const activeThreadId = store.appendThread({
      attempt_id: activeAttemptId,
      thread_id: 'active-thread-retention',
      started_at: '2026-04-10T09:00:02.000Z',
      status: 'running'
    });
    const activeTurnId = store.appendTurn({
      thread_id: activeThreadId,
      turn_id: 'active-turn-retention',
      turn_index: 0,
      started_at: '2026-04-10T09:00:03.000Z',
      status: 'running'
    });
    store.appendAppServerEvent({
      issue_run_id: activeIssueRunId,
      attempt_id: activeAttemptId,
      thread_id: activeThreadId,
      turn_id: activeTurnId,
      observed_at: '2026-04-10T09:00:04.000Z',
      source_event_id: 'active-app-event',
      source_event_name: 'rawResponseItem/completed',
      payload_class: 'protocol_request_response',
      raw_payload: { message: 'active protocol evidence' },
      summary: 'active protocol evidence'
    });
    store.appendProviderUsageStepFact({
      issue_run_id: activeIssueRunId,
      attempt_id: activeAttemptId,
      thread_id: activeThreadId,
      turn_id: activeTurnId,
      message_id_hash: 'b'.repeat(64),
      model: 'claude-sonnet-4-6',
      input_tokens: 5,
      output_tokens: 3,
      cache_read_tokens: 0,
      cache_creation_tokens: 1,
      observed_at: '2026-04-10T09:00:04.500Z'
    });
    const activeIdentity = identity({ issue_id: 'active-issue-run', issue_identifier: 'ACTIVE-ISSUE-1' });
    store.appendDrainAuditHistory({
      issue_run_id: activeIssueRunId,
      project_identity: activeIdentity.project,
      event_type: 'drain-entered',
      actor: 'operator',
      source: 'orchestrator',
      result: 'accepted',
      result_code: 'drain_mode_entered',
      state_context: { drain_active: true, safe_to_shutdown: true },
      blocker_summaries: [],
      occurred_at: '2026-04-10T09:00:05.000Z',
      observed_at: '2026-04-10T09:00:05.000Z'
    });

    const lateStore = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base + 2 * 24 * 60 * 60 * 1000 });
    stores.push(lateStore);
    expect(lateStore.pruneExpiredRuns()).toBe(3);

    expect(lateStore.listRunHistory(10).map((run) => run.run_id)).toContain(activeRunId);
    expect(lateStore.listRunHistory(10).map((run) => run.run_id)).not.toContain(expiredRunId);
    expect(lateStore.reconstructThreadLineage(activeThreadId)?.issue_run.issue_run_id).toBe(activeIssueRunId);
    expect(lateStore.reconstructThreadLineage(expiredThreadId)).toBeNull();
    expect(lateStore.listAppServerEventLedger(activeIssueRunId)).toHaveLength(1);
    expect(lateStore.listAppServerEventLedger(expiredGraph.issue_run_id)).toHaveLength(0);
    const retainedDrainAuditEvents = lateStore.listProjectDrainAuditEvents(activeIdentity.project.key).items;
    expect(retainedDrainAuditEvents.map((entry) => entry.issue_run_id)).toEqual([activeIssueRunId]);
    expect(retainedDrainAuditEvents.map((entry) => entry.issue_run_id)).not.toContain(expiredGraph.issue_run_id);

    const db = openDatabase(dbPath);
    try {
      const records = db
        .prepare(
          `SELECT source_table, source_id, reason_code, pruned_record_count
           FROM history_retention_prune_record
           ORDER BY source_table, source_id`
        )
        .all();
      expect(records).toHaveLength(3);
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source_table: 'runs',
            source_id: expiredRunId,
            reason_code: 'retention_policy_expired_completed_history'
          }),
          expect.objectContaining({
            source_table: 'runs',
            source_id: expiredGraph.run_id,
            reason_code: 'retention_policy_expired_completed_history'
          }),
          expect.objectContaining({
            source_table: 'issue_run',
            source_id: expiredGraph.issue_run_id,
            reason_code: 'retention_policy_expired_completed_history',
            pruned_record_count: 10
          })
        ])
      );
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM history_provider_usage_step_fact WHERE issue_run_id = ?').get(expiredGraph.issue_run_id)
      ).toEqual({ count: 0 });
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM history_provider_usage_step_fact WHERE issue_run_id = ?').get(activeIssueRunId)
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('records retention prune failures in persistence health evidence', async () => {
    const base = Date.parse('2026-04-11T12:00:00.000Z');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-retention-failure-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base, pruneFailureForTest: 'token=abcd prune exploded' });
    stores.push(store);

    expect(() => store.pruneExpiredRuns()).toThrow(/prune exploded/);
    expect(store.health()).toMatchObject({
      last_pruned_at: null,
      last_prune_failure_at: '2026-04-11T12:00:00.000Z',
      last_prune_failure_reason: 'retention_prune_failed',
      last_prune_failure_detail: 'token=***REDACTED*** prune exploded'
    });
  });

  it('keeps fast health off sqlite integrity checks and deep health refreshes cached integrity metadata', () => {
    let now = Date.parse('2026-04-11T12:00:00.000Z');
    let integrityChecks = 0;
    let integrityResult = 'ok';
    const db = {
      prepare(sql: string) {
        return {
          get(value?: string) {
            if (sql.includes('sqlite_master')) {
              return value === 'history_identity_projection' ? { name: value } : undefined;
            }
            if (sql.includes('COUNT(DISTINCT')) {
              return { count: 2 };
            }
            if (sql.includes('COUNT(*) AS count FROM runs')) {
              return { count: 3 };
            }
            if (sql.includes('PRAGMA integrity_check')) {
              integrityChecks += 1;
              return { integrity_check: integrityResult };
            }
            if (sql.includes('SELECT value FROM meta')) {
              return undefined;
            }
            throw new Error(`unexpected query: ${sql}`);
          }
        };
      }
    };
    const store = new RetentionHealthStore({
      db: db as any,
      dbPath: '/tmp/runtime.sqlite',
      retentionDays: 365,
      nowMs: () => now,
      transaction: (fn) => fn(),
      readHistorySchemaHealth: () =>
        ({
          status: 'healthy',
          target_version: 8,
          applied_version: 8,
          degraded_reason_code: null,
          degraded_detail: null,
          migrations: []
        }) as any,
      recordHistoryHealthMetadata: () => {},
      listHistoryWriteFailures: () => [],
      integrityCheckTtlMs: 1_000
    });

    expect(store.health({ depth: 'fast' })).toMatchObject({
      integrity_ok: true,
      health_depth: 'fast',
      integrity_check: {
        status: 'unknown',
        freshness: 'unknown',
        checked_at: null
      }
    });
    expect(store.health({ depth: 'fast' }).integrity_ok).toBe(true);
    expect(integrityChecks).toBe(0);

    expect(store.health({ depth: 'deep', integrity_check_source: 'manual' })).toMatchObject({
      integrity_ok: true,
      health_depth: 'deep',
      integrity_check: {
        status: 'ok',
        freshness: 'fresh',
        checked_at: '2026-04-11T12:00:00.000Z',
        source: 'manual'
      }
    });
    expect(integrityChecks).toBe(1);

    integrityResult = 'database disk image is malformed';
    now += 1_001;
    expect(store.health({ depth: 'fast' })).toMatchObject({
      integrity_ok: true,
      integrity_check: {
        status: 'ok',
        freshness: 'stale'
      }
    });
    expect(integrityChecks).toBe(1);

    expect(store.health({ depth: 'deep', integrity_check_source: 'scheduled' })).toMatchObject({
      integrity_ok: false,
      integrity_check: {
        status: 'failed',
        freshness: 'fresh',
        source: 'scheduled',
        detail: 'database disk image is malformed'
      }
    });
    expect(integrityChecks).toBe(2);

    expect(store.health({ depth: 'fast' })).toMatchObject({
      integrity_ok: false,
      integrity_check: {
        status: 'failed',
        freshness: 'fresh'
      }
    });
    expect(integrityChecks).toBe(2);
  });


});
