import type { PersistenceDatabase, PersistenceStoreContext } from './store-context';

export const DRAIN_AUDIT_EVENT_TYPES = [
  'drain-entered',
  'drain-exited',
  'quiescence-reached',
  'wait-started',
  'wait-timed-out',
  'safe-shutdown-allowed',
  'safe-shutdown-refused',
  'update-detected',
  'update-prepare-requested',
  'update-drain-entered',
  'update-quiescence-reached',
  'update-fetch-started',
  'update-fetch-succeeded',
  'update-fetch-failed',
  'update-pull-started',
  'update-pull-succeeded',
  'update-pull-failed',
  'update-pull-refused',
  'update-install-started',
  'update-install-succeeded',
  'update-install-failed',
  'update-install-skipped',
  'update-build-started',
  'update-build-succeeded',
  'update-build-failed',
  'update-build-skipped',
  'update-restart-requested',
  'update-restart-refused',
  'update-restart-ready',
  'update-restart-started',
  'update-old-child-shutdown-requested',
  'update-old-child-exited',
  'update-new-child-spawned',
  'update-new-child-ready',
  'update-dashboard-assets-verified',
  'update-dashboard-assets-failed',
  'update-reconnect-observed',
  'update-restart-completed',
  'update-restart-failed',
  'update-manual-restart-required'
] as const;

export function drainAuditEventTypeCheckSql(column = 'event_type'): string {
  return `${column} IN (${DRAIN_AUDIT_EVENT_TYPES.map((eventType) => `'${eventType}'`).join(', ')})`;
}

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

export function createBasePersistenceSchema(db: PersistenceDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_run (
      issue_run_id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT NOT NULL,
      identity TEXT,
      project_key TEXT,
      ticket_key TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      reason_code TEXT,
      reason_detail TEXT,
      CHECK (ended_at IS NULL OR ended_at >= started_at)
    );
    CREATE TABLE IF NOT EXISTS attempt (
      attempt_id TEXT PRIMARY KEY,
      issue_run_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      reason_code TEXT,
      reason_detail TEXT,
      UNIQUE (issue_run_id, attempt_number),
      CHECK (attempt_number >= 0),
      CHECK (ended_at IS NULL OR ended_at >= started_at),
      FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS thread (
      thread_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      reason_code TEXT,
      reason_detail TEXT,
      CHECK (ended_at IS NULL OR ended_at >= started_at),
      FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS turn (
      turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      reason_code TEXT,
      reason_detail TEXT,
      UNIQUE (thread_id, turn_index),
      CHECK (turn_index >= 0),
      CHECK (ended_at IS NULL OR ended_at >= started_at),
      FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS phase_span (
      phase_span_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      reason_code TEXT,
      reason_detail TEXT,
      CHECK (ended_at IS NULL OR ended_at >= started_at),
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS tool_span (
      tool_span_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      reason_code TEXT,
      reason_detail TEXT,
      CHECK (ended_at IS NULL OR ended_at >= started_at),
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS state_transition (
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
      reason_detail TEXT,
      FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT NOT NULL,
      identity TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      completed_at TEXT,
      terminal_status TEXT,
      error_code TEXT,
      terminal_reason_code TEXT,
      terminal_reason_detail TEXT,
      root_cause_status TEXT,
      root_cause_reason_code TEXT,
      root_cause_reason_detail TEXT,
      root_cause_at TEXT,
      session_id TEXT,
      thread_id TEXT,
      turn_id TEXT,
      missing_tool_output_recovery TEXT
    );
    CREATE TABLE IF NOT EXISTS run_sessions (
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (run_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS run_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      at TEXT NOT NULL,
      event TEXT NOT NULL,
      message TEXT,
      reason_code TEXT,
      request_method TEXT,
      request_category TEXT
    );
    CREATE TABLE IF NOT EXISTS ui_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS issue_breakers (
      issue_id TEXT PRIMARY KEY,
      issue_identifier TEXT NOT NULL,
      breaker_active INTEGER NOT NULL,
      breaker_hit_count INTEGER NOT NULL,
      breaker_window_minutes INTEGER NOT NULL,
      breaker_first_hit_at TEXT,
      breaker_last_hit_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS blocked_inputs (
      issue_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operator_actions (
      issue_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function ensureHistoryMigrationTables(db: PersistenceDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_schema_state (
      schema_name TEXT PRIMARY KEY,
      target_version INTEGER NOT NULL,
      applied_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded')),
      degraded_reason_code TEXT,
      degraded_detail TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history_schema_migrations (
      schema_name TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('applied', 'failed')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_message TEXT,
      PRIMARY KEY (schema_name, version)
    );
  `);
}

export function createProjectExecutionHistoryTables(context: PersistenceStoreContext): void {
  context.db.exec(`
    CREATE TABLE IF NOT EXISTS history_project_identity (
      project_key TEXT PRIMARY KEY,
      project_root TEXT NOT NULL,
      workflow_path TEXT NOT NULL,
      workflow_hash_status TEXT NOT NULL,
      workflow_hash_value TEXT,
      workflow_hash_reason TEXT,
      repository_remote_status TEXT NOT NULL,
      repository_remote_value TEXT,
      repository_remote_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history_ticket_identity (
      project_key TEXT NOT NULL,
      ticket_key TEXT NOT NULL,
      tracker_kind TEXT NOT NULL,
      tracker_scope_status TEXT NOT NULL,
      tracker_scope_value TEXT,
      tracker_scope_reason TEXT,
      remote_issue_id TEXT NOT NULL,
      human_issue_identifier TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_key, ticket_key),
      FOREIGN KEY (project_key) REFERENCES history_project_identity(project_key) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS history_protocol_summary (
      protocol_summary_id TEXT PRIMARY KEY,
      issue_run_id TEXT NOT NULL,
      attempt_id TEXT,
      thread_id TEXT,
      turn_id TEXT,
      protocol_name TEXT NOT NULL,
      protocol_version TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      warning_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS history_token_model_fact (
      token_model_fact_id TEXT PRIMARY KEY,
      issue_run_id TEXT NOT NULL,
      attempt_id TEXT,
      thread_id TEXT,
      turn_id TEXT,
      requested_model TEXT,
      effective_model TEXT,
      model_source TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_input_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      total_tokens INTEGER,
      model_context_window INTEGER,
      runtime_provider TEXT,
      provider_turn_count INTEGER,
      estimated_cost_usd REAL,
      telemetry_confidence TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS history_drain_audit_event (
      drain_audit_event_id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      ticket_key TEXT,
      issue_run_id TEXT,
      attempt_id TEXT,
      thread_id TEXT,
      turn_id TEXT,
      event_type TEXT NOT NULL CHECK (${drainAuditEventTypeCheckSql()}),
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
    CREATE INDEX IF NOT EXISTS history_drain_audit_event_project_idx
      ON history_drain_audit_event(project_key, occurred_at DESC, drain_audit_event_id DESC);
    CREATE INDEX IF NOT EXISTS history_drain_audit_event_ticket_idx
      ON history_drain_audit_event(project_key, ticket_key, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS history_drain_audit_event_issue_run_idx
      ON history_drain_audit_event(issue_run_id);
    CREATE TABLE IF NOT EXISTS history_retention_metadata (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      retention_days INTEGER NOT NULL,
      last_pruned_at TEXT,
      policy_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history_health_metadata (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded')),
      reason_code TEXT,
      detail TEXT,
      checked_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      applied_migration_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history_write_failure (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      detail TEXT,
      recorded_at TEXT NOT NULL
    );
  `);
  context.db
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
    .run(context.retentionDays, asIso(context.nowMs()));
  context.db
    .prepare(
      `INSERT INTO history_health_metadata
        (singleton_id, status, reason_code, detail, checked_at, schema_version, applied_migration_version)
       VALUES (1, 'healthy', NULL, NULL, ?, ?, ?)
       ON CONFLICT(singleton_id) DO UPDATE SET
        status = excluded.status,
        reason_code = excluded.reason_code,
        detail = excluded.detail,
        checked_at = excluded.checked_at,
        schema_version = excluded.schema_version,
        applied_migration_version = excluded.applied_migration_version`
    )
    .run(asIso(context.nowMs()), 1, 1);
}

export function createHistoryRetentionPruneRecordTable(db: PersistenceDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_retention_prune_record (
      prune_record_id TEXT PRIMARY KEY,
      source_table TEXT NOT NULL CHECK (source_table IN ('runs', 'issue_run')),
      source_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT NOT NULL,
      project_key TEXT,
      ticket_key TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      pruned_at TEXT NOT NULL,
      retention_days INTEGER NOT NULL,
      cutoff_at TEXT NOT NULL,
      pruned_record_count INTEGER NOT NULL,
      reason_code TEXT NOT NULL,
      metadata TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS history_retention_prune_record_source_idx
      ON history_retention_prune_record(source_table, source_id);
    CREATE INDEX IF NOT EXISTS history_retention_prune_record_pruned_at_idx
      ON history_retention_prune_record(pruned_at, prune_record_id);
  `);
}

export function ensureHistoryWriteFailureTable(db: PersistenceDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_write_failure (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      detail TEXT,
      recorded_at TEXT NOT NULL
    );
  `);
}
