import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDurableIdentity,
  createStoreTestHarness,
  fs,
  os,
  path,
  SqlitePersistenceStore
} from './store-test-harness';

describe('SqlitePersistenceStore migrations', () => {
  const { dirs, stores, identity, openDatabase, tableNames, withLegacyProjectKey, cleanup } = createStoreTestHarness();

  afterEach(cleanup);
  it('creates a versioned Project Execution History schema on clean databases', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-schema-clean-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 30, nowMs: () => Date.parse('2026-04-11T10:00:00.000Z') });
    stores.push(store);
    const durableIdentity = identity({ issue_id: 'history-clean-1', issue_identifier: 'HIST-1' });
    store.startRun({ issue_id: 'history-clean-1', issue_identifier: 'HIST-1', identity: durableIdentity });

    expect(tableNames(dbPath)).toEqual(
      expect.arrayContaining([
        'history_schema_state',
        'history_schema_migrations',
        'history_project_identity',
        'history_ticket_identity',
        'history_identity_projection',
        'history_protocol_summary',
        'history_app_server_event',
        'history_token_model_fact',
        'history_ticket_terminal_outcome',
        'history_ticket_blocker',
        'history_ticket_evidence_reference',
        'history_tracker_ticket_snapshot',
        'history_ticket_reference',
        'history_operator_action',
        'history_blocked_input_event',
        'history_write_failure',
        'history_retention_metadata',
        'history_retention_prune_record',
        'history_health_metadata',
        'issue_run',
        'attempt',
        'thread',
        'turn',
        'phase_span',
        'tool_span',
        'state_transition'
      ])
    );
    expect(store.historySchemaHealth()).toMatchObject({
      schema_name: 'project_execution_history',
      target_version: 13,
      applied_version: 13,
      status: 'healthy',
      degraded_reason_code: null
    });
    expect(store.historySchemaHealth().migrations).toEqual([
      expect.objectContaining({ version: 1, name: 'project_execution_history_v1', status: 'applied' }),
      expect.objectContaining({ version: 2, name: 'ticket_orchestration_ledger_v1', status: 'applied' }),
      expect.objectContaining({ version: 3, name: 'app_server_event_ledger_lite_policy', status: 'applied' }),
      expect.objectContaining({ version: 4, name: 'existing_run_history_identity_backfill_v1', status: 'applied' }),
      expect.objectContaining({ version: 5, name: 'token_model_fact_dimensions_v1', status: 'applied' }),
      expect.objectContaining({ version: 6, name: 'operational_history_facts_v1', status: 'applied' }),
      expect.objectContaining({ version: 7, name: 'history_retention_prune_evidence_v1', status: 'applied' }),
      expect.objectContaining({ version: 8, name: 'stable_project_identity_key_v1', status: 'applied' }),
      expect.objectContaining({ version: 9, name: 'project_scoped_ticket_identity_v1', status: 'applied' }),
      expect.objectContaining({ version: 10, name: 'drain_audit_history_v1', status: 'applied' }),
      expect.objectContaining({ version: 11, name: 'runtime_update_drain_audit_events_v1', status: 'applied' }),
      expect.objectContaining({ version: 12, name: 'runtime_restart_drain_audit_events_v1', status: 'applied' }),
      expect.objectContaining({ version: 13, name: 'provider_usage_dimensions_v1', status: 'applied' })
    ]);
  });

  it('runs history schema migrations idempotently across repeated opens', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-idempotent-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => Date.parse('2026-04-11T10:00:00.000Z') });
    stores.push(storeA);
    expect(storeA.historySchemaHealth().migrations).toHaveLength(13);
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => Date.parse('2026-04-11T10:10:00.000Z') });
    stores.push(storeB);

    expect(storeB.historySchemaHealth()).toMatchObject({ applied_version: 13, status: 'healthy' });
    expect(storeB.historySchemaHealth().migrations).toEqual([
      expect.objectContaining({ version: 1, status: 'applied' }),
      expect.objectContaining({ version: 2, status: 'applied' }),
      expect.objectContaining({ version: 3, status: 'applied' }),
      expect.objectContaining({ version: 4, status: 'applied' }),
      expect.objectContaining({ version: 5, status: 'applied' }),
      expect.objectContaining({ version: 6, status: 'applied' }),
      expect.objectContaining({ version: 7, status: 'applied' }),
      expect.objectContaining({ version: 8, status: 'applied' }),
      expect.objectContaining({ version: 9, status: 'applied' }),
      expect.objectContaining({ version: 10, status: 'applied' }),
      expect.objectContaining({ version: 11, status: 'applied' }),
      expect.objectContaining({ version: 12, status: 'applied' }),
      expect.objectContaining({ version: 13, status: 'applied' })
    ]);
  });

  it('adds provider usage dimensions when upgrading an existing version 12 history database', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-provider-usage-migration-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    storeA.close();
    stores.pop();

    const db = openDatabase(dbPath);
    try {
      db.exec('ALTER TABLE history_token_model_fact DROP COLUMN runtime_provider;');
      db.exec('ALTER TABLE history_token_model_fact DROP COLUMN provider_turn_count;');
      db.exec('ALTER TABLE history_token_model_fact DROP COLUMN estimated_cost_usd;');
      db.prepare("DELETE FROM history_schema_migrations WHERE schema_name = 'project_execution_history' AND version = 13").run();
      db.prepare("UPDATE history_schema_state SET applied_version = 12 WHERE schema_name = 'project_execution_history'").run();
    } finally {
      db.close();
    }

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    expect(storeB.historySchemaHealth()).toMatchObject({ applied_version: 13, status: 'healthy' });
    const migrated = openDatabase(dbPath);
    try {
      const columns = (migrated.prepare('PRAGMA table_info(history_token_model_fact)').all() as Array<{ name: string }>).map(
        (column) => column.name
      );
      expect(columns).toEqual(expect.arrayContaining(['runtime_provider', 'provider_turn_count', 'estimated_cost_usd']));
    } finally {
      migrated.close();
    }
  });

  it('upgrades existing drain audit tables to accept runtime update events', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-runtime-update-audit-migration-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'runtime-update-migration-1', issue_identifier: 'UPD-MIG-1' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    storeA.appendDrainAuditHistory({
      project_identity: durableIdentity.project,
      event_type: 'drain-entered',
      actor: 'operator',
      source: 'api',
      result: 'accepted',
      result_code: 'drain_mode_entered',
      state_context: { drain_active: true },
      blocker_summaries: [],
      occurred_at: '2026-05-21T10:00:00.000Z',
      observed_at: '2026-05-21T10:00:00.000Z'
    });
    storeA.close();
    stores.pop();

    const db = openDatabase(dbPath);
    try {
      db.exec(`
        CREATE TABLE history_drain_audit_event_legacy (
          drain_audit_event_id TEXT PRIMARY KEY,
          project_key TEXT NOT NULL,
          ticket_key TEXT,
          issue_run_id TEXT,
          attempt_id TEXT,
          thread_id TEXT,
          turn_id TEXT,
          event_type TEXT NOT NULL CHECK (event_type IN (
            'drain-entered',
            'drain-exited',
            'quiescence-reached',
            'wait-started',
            'wait-timed-out',
            'safe-shutdown-allowed',
            'safe-shutdown-refused'
          )),
          actor TEXT,
          source TEXT NOT NULL,
          result TEXT NOT NULL CHECK (result IN ('accepted', 'rejected', 'failed', 'observed')),
          result_code TEXT NOT NULL,
          reason_note TEXT,
          state_context TEXT,
          blocker_summaries TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          observation_hash TEXT NOT NULL,
          duplicate_count INTEGER NOT NULL DEFAULT 1,
          last_observed_at TEXT NOT NULL,
          FOREIGN KEY (project_key) REFERENCES history_project_identity(project_key) ON DELETE RESTRICT,
          FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
          FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
          FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
          FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT,
          UNIQUE (project_key, event_type, observation_hash)
        );
        INSERT INTO history_drain_audit_event_legacy
          SELECT * FROM history_drain_audit_event;
        DROP TABLE history_drain_audit_event;
        ALTER TABLE history_drain_audit_event_legacy RENAME TO history_drain_audit_event;
        CREATE INDEX IF NOT EXISTS history_drain_audit_event_project_idx
          ON history_drain_audit_event(project_key, occurred_at DESC, drain_audit_event_id DESC);
        CREATE INDEX IF NOT EXISTS history_drain_audit_event_ticket_idx
          ON history_drain_audit_event(project_key, ticket_key, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS history_drain_audit_event_issue_run_idx
          ON history_drain_audit_event(issue_run_id);
        DELETE FROM history_schema_migrations WHERE schema_name = 'project_execution_history' AND version IN (11, 12, 13);
        UPDATE history_schema_state
          SET applied_version = 10, status = 'healthy', degraded_reason_code = NULL, degraded_detail = NULL
          WHERE schema_name = 'project_execution_history';
      `);
    } finally {
      db.close();
    }

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    storeB.appendDrainAuditHistory({
      project_identity: durableIdentity.project,
      event_type: 'update-detected',
      actor: 'operator',
      source: 'runtime_update',
      result: 'observed',
      result_code: 'remote_update_available',
      state_context: { state: 'remote_update_available' },
      blocker_summaries: [],
      occurred_at: '2026-05-21T10:01:00.000Z',
      observed_at: '2026-05-21T10:01:00.000Z'
    });

    expect(storeB.historySchemaHealth()).toMatchObject({ applied_version: 13, status: 'healthy' });
    expect((storeB as any).listProjectDrainAuditEvents(durableIdentity.project.key, { limit: 10 }).items.map((entry: any) => entry.event_type)).toEqual([
      'update-detected',
      'drain-entered'
    ]);
  });

  it('migrates legacy global ticket identities from historical identity snapshots', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-ticket-scope-migration-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const projectA = identity({
      issue_id: 'legacy-shared-remote-1',
      issue_identifier: 'LEGACY-162',
      projectRoot: path.join(dir, 'project-a'),
      workflowPath: path.join(dir, 'project-a', 'WORKFLOW.md')
    });
    const projectB = identity({
      issue_id: 'legacy-shared-remote-1',
      issue_identifier: 'LEGACY-162',
      projectRoot: path.join(dir, 'project-b'),
      workflowPath: path.join(dir, 'project-b', 'WORKFLOW.md')
    });
    expect(projectA.ticket.key).toBe(projectB.ticket.key);

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    storeA.appendIssueRun({
      issue_run_id: 'legacy-project-a-run',
      issue_id: 'legacy-shared-remote-1',
      issue_identifier: 'LEGACY-162',
      identity: projectA,
      started_at: '2026-04-11T10:00:00.000Z',
      status: 'running'
    });
    storeA.appendIssueRun({
      issue_run_id: 'legacy-project-b-run',
      issue_id: 'legacy-shared-remote-1',
      issue_identifier: 'LEGACY-162',
      identity: projectB,
      started_at: '2026-04-11T11:00:00.000Z',
      status: 'running'
    });
    storeA.close();
    stores.pop();

    const dbA = openDatabase(dbPath);
    try {
      dbA.exec(`
        DROP TABLE history_ticket_identity;
        CREATE TABLE history_ticket_identity (
          ticket_key TEXT PRIMARY KEY,
          project_key TEXT NOT NULL,
          tracker_kind TEXT NOT NULL,
          tracker_scope_status TEXT NOT NULL,
          tracker_scope_value TEXT,
          tracker_scope_reason TEXT,
          remote_issue_id TEXT NOT NULL,
          human_issue_identifier TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_key) REFERENCES history_project_identity(project_key) ON DELETE RESTRICT
        );
      `);
      dbA
        .prepare(
          `INSERT INTO history_ticket_identity
            (ticket_key, project_key, tracker_kind, tracker_scope_status, tracker_scope_value, tracker_scope_reason,
             remote_issue_id, human_issue_identifier, created_at, updated_at)
           VALUES (?, ?, 'linear', 'present', 'symphony', NULL, ?, ?, '2026-04-11T11:00:00.000Z', '2026-04-11T11:00:00.000Z')`
        )
        .run(projectB.ticket.key, projectB.project.key, projectB.ticket.remote_issue_id, projectB.ticket.human_issue_identifier);
      dbA.prepare("DELETE FROM history_schema_migrations WHERE schema_name = 'project_execution_history' AND version IN (9, 10, 11, 12, 13)").run();
      dbA
        .prepare(
          `UPDATE history_schema_state
           SET applied_version = 8, status = 'healthy', degraded_reason_code = NULL, degraded_detail = NULL
           WHERE schema_name = 'project_execution_history'`
        )
        .run();
    } finally {
      dbA.close();
    }

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    expect(storeB.historySchemaHealth()).toMatchObject({ applied_version: 13, status: 'healthy' });
    expect(storeB.listProjectTicketIdentities(projectA.project.key).items).toEqual([projectA]);
    expect(storeB.listProjectTicketIdentities(projectB.project.key).items).toEqual([projectB]);
    expect(storeB.reconstructTicketTimeline(projectA).issue_runs.map((run) => run.issue_run_id)).toEqual(['legacy-project-a-run']);
    expect(storeB.reconstructTicketTimeline(projectB).issue_runs.map((run) => run.issue_run_id)).toEqual(['legacy-project-b-run']);

    const dbB = openDatabase(dbPath);
    try {
      const expectedRows = [
        { project_key: projectA.project.key, ticket_key: projectA.ticket.key },
        { project_key: projectB.project.key, ticket_key: projectB.ticket.key }
      ].sort((a, b) => a.project_key.localeCompare(b.project_key));
      expect(dbB.prepare('SELECT project_key, ticket_key FROM history_ticket_identity ORDER BY project_key').all()).toEqual(expectedRows);
    } finally {
      dbB.close();
    }
  });

  it('upgrades partial legacy history tables and records applied migration state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-partial-legacy-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const db = openDatabase(dbPath);
    try {
      db.exec(`
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          issue_identifier TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          terminal_status TEXT,
          error_code TEXT
        );
        CREATE TABLE run_sessions (
          run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          PRIMARY KEY (run_id, session_id)
        );
        CREATE TABLE run_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          at TEXT NOT NULL,
          event TEXT NOT NULL,
          message TEXT
        );
        CREATE TABLE issue_run (
          issue_run_id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          issue_identifier TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE attempt (
          attempt_id TEXT PRIMARY KEY,
          issue_run_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE thread (
          thread_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE turn (
          turn_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_index INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE phase_span (
          phase_span_id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE tool_span (
          tool_span_id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE state_transition (
          state_transition_id TEXT PRIMARY KEY,
          issue_run_id TEXT NOT NULL,
          attempt_id TEXT,
          thread_id TEXT,
          turn_id TEXT,
          from_status TEXT,
          to_status TEXT NOT NULL,
          transitioned_at TEXT NOT NULL,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        INSERT INTO runs (run_id, issue_id, issue_identifier, started_at, ended_at, terminal_status, error_code)
        VALUES ('legacy-run-1', 'legacy-issue-1', 'LEG-1', '2026-04-11T10:00:00.000Z', '2026-04-11T10:05:00.000Z', 'failed', 'legacy_error');
      `);
    } finally {
      db.close();
    }

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);

    expect(store.listRunHistory()).toEqual([
      expect.objectContaining({
        run_id: 'legacy-run-1',
        issue_identifier: 'LEG-1',
        completed_at: '2026-04-11T10:05:00.000Z',
        terminal_reason_code: 'legacy_error'
      })
    ]);
    expect(store.historySchemaHealth()).toMatchObject({ applied_version: 13, status: 'healthy' });
    expect(tableNames(dbPath)).toEqual(
      expect.arrayContaining([
        'history_token_model_fact',
        'history_protocol_summary',
        'history_ticket_evidence_reference',
        'history_app_server_event'
      ])
    );
  });

  it('records explicit degraded history state when migration execution fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-migration-failure-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      nowMs: () => Date.parse('2026-04-11T10:00:00.000Z'),
      migrationFailureForTest: 'project_execution_history_v1'
    });
    stores.push(store);

    expect(store.historySchemaHealth()).toMatchObject({
      applied_version: 0,
      status: 'degraded',
      degraded_reason_code: 'history_schema_migration_failed'
    });
    expect(store.historySchemaHealth().migrations).toEqual([
      expect.objectContaining({
        version: 1,
        name: 'project_execution_history_v1',
        status: 'failed',
        error_message: 'injected migration failure: project_execution_history_v1'
      })
    ]);
    expect(store.health()).toMatchObject({
      integrity_ok: false,
      history_schema: expect.objectContaining({ status: 'degraded' })
    });
  });


});
