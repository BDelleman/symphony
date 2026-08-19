import { redactUnknown } from '../security/redaction';
import {
  createHistoryRetentionPruneRecordTable,
  createProjectExecutionHistoryTables,
  drainAuditEventTypeCheckSql,
  ensureHistoryMigrationTables,
  ensureHistoryWriteFailureTable
} from './schema';
import { HISTORY_SCHEMA_NAME, type SchemaHealthStore } from './schema-health-store';
import type { PersistenceDatabase, PersistenceStoreContext } from './store-context';

interface HistoryMigration {
  version: number;
  name: string;
  apply(context: HistoryMigrationContext): void;
}

export interface HistoryMigrationIdentityAccess {
  ensureIssueRunIdentityColumn(): void;
  ensureIssueRunIdentityKeyColumns(): void;
  createHistoryIdentityProjectionTable(): void;
  backfillExistingHistoryIdentities(): void;
  normalizeExistingProjectIdentityKeys(): void;
  ensureProjectScopedTicketIdentityTable(): void;
}

export interface HistoryMigrationStoreDependencies {
  context: PersistenceStoreContext;
  db: PersistenceDatabase;
  nowMs: () => number;
  identityAccess: HistoryMigrationIdentityAccess;
  schemaHealthStore: SchemaHealthStore;
  migrationFailureForTest?: string;
}

interface HistoryMigrationContext {
  context: PersistenceStoreContext;
  db: PersistenceDatabase;
  identity: HistoryMigrationIdentityAccess;
  recordHistoryHealthMetadata: (status: 'healthy' | 'degraded', reasonCode: string | null, detail: string | null) => void;
}

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

export class HistoryMigrationStore {
  private readonly context: PersistenceStoreContext;
  private readonly db: PersistenceDatabase;
  private readonly nowMs: () => number;
  private readonly identityAccess: HistoryMigrationIdentityAccess;
  private readonly schemaHealthStore: SchemaHealthStore;
  private readonly migrationFailureForTest: string | undefined;

  constructor(dependencies: HistoryMigrationStoreDependencies) {
    this.context = dependencies.context;
    this.db = dependencies.db;
    this.nowMs = dependencies.nowMs;
    this.identityAccess = dependencies.identityAccess;
    this.schemaHealthStore = dependencies.schemaHealthStore;
    this.migrationFailureForTest = dependencies.migrationFailureForTest;
  }

  runHistorySchemaMigrations(): void {
    ensureHistoryMigrationTables(this.db);

    const migrationContext: HistoryMigrationContext = {
      context: this.context,
      db: this.db,
      identity: this.identityAccess,
      recordHistoryHealthMetadata: (status, reasonCode, detail) =>
        this.schemaHealthStore.recordHistoryHealthMetadata(status, reasonCode, detail)
    };

    for (const migration of historyMigrations()) {
      const existing = this.db
        .prepare('SELECT status FROM history_schema_migrations WHERE schema_name = ? AND version = ?')
        .get(HISTORY_SCHEMA_NAME, migration.version) as { status: string } | undefined;
      if (existing?.status === 'applied') {
        continue;
      }

      const startedAt = asIso(this.nowMs());
      try {
        this.db.exec('BEGIN;');
        if (this.migrationFailureForTest === migration.name) {
          throw new Error(`injected migration failure: ${migration.name}`);
        }
        migration.apply(migrationContext);
        const finishedAt = asIso(this.nowMs());
        this.db
          .prepare(
            `INSERT INTO history_schema_migrations
              (schema_name, version, name, status, started_at, finished_at, error_message)
             VALUES (?, ?, ?, 'applied', ?, ?, NULL)
             ON CONFLICT(schema_name, version) DO UPDATE SET
              name = excluded.name,
              status = excluded.status,
              started_at = excluded.started_at,
              finished_at = excluded.finished_at,
              error_message = excluded.error_message`
          )
          .run(HISTORY_SCHEMA_NAME, migration.version, migration.name, startedAt, finishedAt);
        this.schemaHealthStore.recordHistorySchemaState({
          appliedVersion: migration.version,
          status: 'healthy',
          degradedReasonCode: null,
          degradedDetail: null
        });
        this.db.exec('COMMIT;');
      } catch (error) {
        try {
          this.db.exec('ROLLBACK;');
        } catch {
          // The migration may have failed before BEGIN was accepted.
        }
        const detail = error instanceof Error ? error.message : String(error);
        this.recordHistoryMigrationFailure(migration, startedAt, detail);
        break;
      }
    }

    // Version 14 remained unreleased while its additive shape was developed. A local
    // database may therefore already carry an applied v14 marker from an earlier
    // development build. Reassert the idempotent shape so such databases cannot run
    // with a partially applied provider-usage contract.
    const providerUsageV2 = this.db
      .prepare(
        'SELECT status FROM history_schema_migrations WHERE schema_name = ? AND version = 14'
      )
      .get(HISTORY_SCHEMA_NAME) as { status: string } | undefined;
    if (providerUsageV2?.status === 'applied') {
      try {
        this.db.exec('BEGIN;');
        ensureProviderUsageObservabilityV2(this.db, () => undefined);
        this.db.exec('COMMIT;');
        const currentHealth = this.schemaHealthStore.readHistorySchemaHealth();
        if (currentHealth.degraded_reason_code === 'history_provider_usage_shape_repair_failed') {
          this.schemaHealthStore.recordHistorySchemaState({
            appliedVersion: 14,
            status: 'healthy',
            degradedReasonCode: null,
            degradedDetail: null
          });
        }
      } catch (error) {
        try {
          this.db.exec('ROLLBACK;');
        } catch {
          // The repair may have failed before BEGIN was accepted.
        }
        this.schemaHealthStore.recordHistorySchemaState({
          appliedVersion: 14,
          status: 'degraded',
          degradedReasonCode: 'history_provider_usage_shape_repair_failed',
          degradedDetail: error instanceof Error ? error.message : String(error)
        });
      }
    }

    ensureHistoryWriteFailureTable(this.db);

    const state = this.db
      .prepare('SELECT status FROM history_schema_state WHERE schema_name = ?')
      .get(HISTORY_SCHEMA_NAME) as { status: string } | undefined;
    if (!state) {
      this.schemaHealthStore.recordHistorySchemaState({
        appliedVersion: 0,
        status: 'degraded',
        degradedReasonCode: 'history_schema_not_applied',
        degradedDetail: 'No Project Execution History migration completed.'
      });
    }
  }

  private recordHistoryMigrationFailure(migration: HistoryMigration, startedAt: string, detail: string): void {
    const finishedAt = asIso(this.nowMs());
    const redactedDetail = redactUnknown(detail) as string;
    this.db
      .prepare(
        `INSERT INTO history_schema_migrations
          (schema_name, version, name, status, started_at, finished_at, error_message)
         VALUES (?, ?, ?, 'failed', ?, ?, ?)
         ON CONFLICT(schema_name, version) DO UPDATE SET
          name = excluded.name,
          status = excluded.status,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          error_message = excluded.error_message`
      )
      .run(HISTORY_SCHEMA_NAME, migration.version, migration.name, startedAt, finishedAt, redactedDetail);
    this.schemaHealthStore.recordHistorySchemaState({
      appliedVersion: migration.version - 1,
      status: 'degraded',
      degradedReasonCode: 'history_schema_migration_failed',
      degradedDetail: redactedDetail
    });
  }
}

function historyMigrations(): HistoryMigration[] {
  return [
    {
      version: 1,
      name: 'project_execution_history_v1',
      apply: (context) => {
        ensureRunDiagnosticColumns(context.db);
        context.identity.ensureIssueRunIdentityColumn();
        ensureRunEventDiagnosticColumns(context.db);
        createProjectExecutionHistoryTables(context.context);
      }
    },
    {
      version: 2,
      name: 'ticket_orchestration_ledger_v1',
      apply: (context) => {
        context.identity.ensureIssueRunIdentityKeyColumns();
        createTicketOrchestrationLedgerTables(context.db, context.recordHistoryHealthMetadata);
      }
    },
    {
      version: 3,
      name: 'app_server_event_ledger_lite_policy',
      apply: (context) => {
        createAppServerEventLedgerTables(context.db);
      }
    },
    {
      version: 4,
      name: 'existing_run_history_identity_backfill_v1',
      apply: (context) => {
        context.identity.createHistoryIdentityProjectionTable();
        context.identity.backfillExistingHistoryIdentities();
      }
    },
    {
      version: 5,
      name: 'token_model_fact_dimensions_v1',
      apply: (context) => {
        ensureTokenModelFactColumns(context.db, context.recordHistoryHealthMetadata);
      }
    },
    {
      version: 6,
      name: 'operational_history_facts_v1',
      apply: (context) => {
        createOperationalHistoryFactTables(context.db, context.recordHistoryHealthMetadata);
      }
    },
    {
      version: 7,
      name: 'history_retention_prune_evidence_v1',
      apply: (context) => {
        createHistoryRetentionPruneRecordTable(context.db);
      }
    },
    {
      version: 8,
      name: 'stable_project_identity_key_v1',
      apply: (context) => {
        context.identity.normalizeExistingProjectIdentityKeys();
      }
    },
    {
      version: 9,
      name: 'project_scoped_ticket_identity_v1',
      apply: (context) => {
        context.identity.ensureProjectScopedTicketIdentityTable();
      }
    },
    {
      version: 10,
      name: 'drain_audit_history_v1',
      apply: (context) => {
        createProjectExecutionHistoryTables(context.context);
      }
    },
    {
      version: 11,
      name: 'runtime_update_drain_audit_events_v1',
      apply: (context) => {
        ensureRuntimeUpdateDrainAuditEventTypes(context.db);
      }
    },
    {
      version: 12,
      name: 'runtime_restart_drain_audit_events_v1',
      apply: (context) => {
        ensureRuntimeUpdateDrainAuditEventTypes(context.db);
      }
    },
    {
      version: 13,
      name: 'provider_usage_dimensions_v1',
      apply: (context) => {
        ensureTokenModelFactColumns(context.db, context.recordHistoryHealthMetadata);
      }
    },
    {
      version: 14,
      name: 'provider_usage_observability_v2',
      apply: (context) => {
        ensureProviderUsageObservabilityV2(context.db, context.recordHistoryHealthMetadata);
      }
    }
  ];
}

function ensureProviderUsageObservabilityV2(
  db: PersistenceDatabase,
  recordHistoryHealthMetadata: (status: 'healthy' | 'degraded', reasonCode: string | null, detail: string | null) => void
): void {
  ensureTokenModelFactColumns(db, recordHistoryHealthMetadata);
  const columns = db.prepare('PRAGMA table_info(history_token_model_fact)').all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  const migrations: Array<[string, string]> = [
    ['cache_creation_input_tokens', 'ALTER TABLE history_token_model_fact ADD COLUMN cache_creation_input_tokens INTEGER'],
    ['provider_usage_status', 'ALTER TABLE history_token_model_fact ADD COLUMN provider_usage_status TEXT'],
    ['provider_usage_source', 'ALTER TABLE history_token_model_fact ADD COLUMN provider_usage_source TEXT'],
    ['api_retry_count', 'ALTER TABLE history_token_model_fact ADD COLUMN api_retry_count INTEGER'],
    ['api_error_status', 'ALTER TABLE history_token_model_fact ADD COLUMN api_error_status TEXT'],
    ['terminal_reason', 'ALTER TABLE history_token_model_fact ADD COLUMN terminal_reason TEXT'],
    ['stop_reason', 'ALTER TABLE history_token_model_fact ADD COLUMN stop_reason TEXT'],
    ['duration_ms', 'ALTER TABLE history_token_model_fact ADD COLUMN duration_ms INTEGER'],
    ['duration_api_ms', 'ALTER TABLE history_token_model_fact ADD COLUMN duration_api_ms INTEGER'],
    ['time_to_first_token_ms', 'ALTER TABLE history_token_model_fact ADD COLUMN time_to_first_token_ms INTEGER'],
    ['permission_denial_count', 'ALTER TABLE history_token_model_fact ADD COLUMN permission_denial_count INTEGER'],
    ['unknown_event_count', 'ALTER TABLE history_token_model_fact ADD COLUMN unknown_event_count INTEGER'],
    ['auxiliary_result_count', 'ALTER TABLE history_token_model_fact ADD COLUMN auxiliary_result_count INTEGER'],
    ['effective_models', 'ALTER TABLE history_token_model_fact ADD COLUMN effective_models TEXT'],
    ['tool_counts', 'ALTER TABLE history_token_model_fact ADD COLUMN tool_counts TEXT'],
    ['mcp_counts', 'ALTER TABLE history_token_model_fact ADD COLUMN mcp_counts TEXT'],
    ['missing_reason', 'ALTER TABLE history_token_model_fact ADD COLUMN missing_reason TEXT'],
    ['reconciliation_delta', 'ALTER TABLE history_token_model_fact ADD COLUMN reconciliation_delta TEXT'],
    ['model_usage', 'ALTER TABLE history_token_model_fact ADD COLUMN model_usage TEXT'],
    ['nested_session_detected', 'ALTER TABLE history_token_model_fact ADD COLUMN nested_session_detected INTEGER'],
    ['supervised_session_coverage', 'ALTER TABLE history_token_model_fact ADD COLUMN supervised_session_coverage TEXT']
  ];
  for (const [column, sql] of migrations) {
    if (!existing.has(column)) db.exec(`${sql};`);
  }
  for (const table of ['runs', 'issue_run', 'attempt']) {
    const lifecycleColumns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const lifecycleExisting = new Set(lifecycleColumns.map((column) => column.name));
    if (!lifecycleExisting.has('process_status')) db.exec(`ALTER TABLE ${table} ADD COLUMN process_status TEXT;`);
    if (!lifecycleExisting.has('workflow_outcome')) db.exec(`ALTER TABLE ${table} ADD COLUMN workflow_outcome TEXT;`);
  }
  const threadColumns = db.prepare('PRAGMA table_info(thread)').all() as Array<{ name: string }>;
  const threadExisting = new Set(threadColumns.map((column) => column.name));
  const threadMigrations: Array<[string, string]> = [
    ['session_id', 'ALTER TABLE thread ADD COLUMN session_id TEXT'],
    ['agent_runtime', 'ALTER TABLE thread ADD COLUMN agent_runtime TEXT'],
    ['worker_instance_id', 'ALTER TABLE thread ADD COLUMN worker_instance_id TEXT'],
    ['worker_process_pid', 'ALTER TABLE thread ADD COLUMN worker_process_pid INTEGER']
  ];
  for (const [column, sql] of threadMigrations) {
    if (!threadExisting.has(column)) db.exec(`${sql};`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_provider_usage_step_fact (
      provider_usage_step_fact_id TEXT PRIMARY KEY,
      issue_run_id TEXT NOT NULL,
      attempt_id TEXT,
      thread_id TEXT,
      turn_id TEXT NOT NULL,
      message_id_hash TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL,
      runtime_provider TEXT NOT NULL,
      source TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT,
      UNIQUE (issue_run_id, turn_id, message_id_hash)
    );
    CREATE INDEX IF NOT EXISTS history_provider_usage_step_fact_turn_idx
      ON history_provider_usage_step_fact(turn_id, observed_at ASC);
    UPDATE history_token_model_fact
       SET provider_usage_status = COALESCE(provider_usage_status, 'partial'),
           provider_usage_source = COALESCE(provider_usage_source, 'legacy_partial'),
           telemetry_confidence = CASE
             WHEN telemetry_confidence IN ('observed_live', 'backfilled') THEN 'legacy_partial'
             ELSE telemetry_confidence
           END
     WHERE runtime_provider = 'claude-cli';
  `);
  recordHistoryHealthMetadata('healthy', null, null);
}

function ensureRuntimeUpdateDrainAuditEventTypes(db: PersistenceDatabase): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'history_drain_audit_event'")
    .get() as { sql: string } | undefined;
  if (!table) {
    return;
  }
  if (table.sql.includes('update-reconnect-observed')) {
    return;
  }

  db.exec(`
    CREATE TABLE history_drain_audit_event_runtime_update_migration (
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
    INSERT INTO history_drain_audit_event_runtime_update_migration
      SELECT * FROM history_drain_audit_event;
    DROP TABLE history_drain_audit_event;
    ALTER TABLE history_drain_audit_event_runtime_update_migration RENAME TO history_drain_audit_event;
    CREATE INDEX IF NOT EXISTS history_drain_audit_event_project_idx
      ON history_drain_audit_event(project_key, occurred_at DESC, drain_audit_event_id DESC);
    CREATE INDEX IF NOT EXISTS history_drain_audit_event_ticket_idx
      ON history_drain_audit_event(project_key, ticket_key, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS history_drain_audit_event_issue_run_idx
      ON history_drain_audit_event(issue_run_id);
  `);
}

function createTicketOrchestrationLedgerTables(
  db: PersistenceDatabase,
  recordHistoryHealthMetadata: (status: 'healthy' | 'degraded', reasonCode: string | null, detail: string | null) => void
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_ticket_terminal_outcome (
      terminal_outcome_id TEXT PRIMARY KEY,
      issue_run_id TEXT NOT NULL,
      attempt_id TEXT,
      thread_id TEXT,
      turn_id TEXT,
      outcome TEXT NOT NULL,
      reason_code TEXT,
      reason_detail TEXT,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS history_ticket_blocker (
      blocker_id TEXT PRIMARY KEY,
      issue_run_id TEXT NOT NULL,
      attempt_id TEXT,
      thread_id TEXT,
      turn_id TEXT,
      blocker_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
      reason_code TEXT NOT NULL,
      reason_detail TEXT,
      blocked_at TEXT NOT NULL,
      resolved_at TEXT,
      CHECK (resolved_at IS NULL OR resolved_at >= blocked_at),
      FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS history_ticket_evidence_reference (
      evidence_reference_id TEXT PRIMARY KEY,
      issue_run_id TEXT NOT NULL,
      attempt_id TEXT,
      thread_id TEXT,
      turn_id TEXT,
      evidence_kind TEXT NOT NULL,
      uri TEXT NOT NULL,
      title TEXT,
      metadata TEXT,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
    );
  `);
  ensureHistoryWriteFailureTable(db);
  recordHistoryHealthMetadata('healthy', null, null);
}

function createOperationalHistoryFactTables(
  db: PersistenceDatabase,
  recordHistoryHealthMetadata: (status: 'healthy' | 'degraded', reasonCode: string | null, detail: string | null) => void
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_tracker_ticket_snapshot (
      tracker_snapshot_id TEXT PRIMARY KEY,
      project_key TEXT,
      ticket_key TEXT,
      issue_run_id TEXT,
      attempt_id TEXT,
      thread_id TEXT,
      turn_id TEXT,
      tracker_kind TEXT NOT NULL,
      tracker_scope_status TEXT NOT NULL CHECK (tracker_scope_status IN ('present', 'missing')),
      tracker_scope_value TEXT,
      tracker_scope_reason TEXT,
      remote_issue_id TEXT NOT NULL,
      human_issue_identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      tracker_status TEXT NOT NULL,
      assignee_status TEXT NOT NULL CHECK (assignee_status IN ('available', 'unavailable', 'unknown')),
      assignee_identifier TEXT,
      assignee_reason TEXT,
      labels TEXT NOT NULL,
      project_status TEXT NOT NULL CHECK (project_status IN ('available', 'unavailable', 'unknown')),
      project_identifier TEXT,
      project_reason TEXT,
      team_status TEXT NOT NULL CHECK (team_status IN ('available', 'unavailable', 'unknown')),
      team_identifier TEXT,
      team_reason TEXT,
      observed_at TEXT NOT NULL,
      observation_hash TEXT NOT NULL,
      duplicate_count INTEGER NOT NULL DEFAULT 1,
      last_observed_at TEXT NOT NULL,
      UNIQUE (issue_run_id, observation_hash),
      FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS history_ticket_reference (
      ticket_reference_id TEXT PRIMARY KEY,
      project_key TEXT,
      ticket_key TEXT,
      issue_run_id TEXT,
      attempt_id TEXT,
      thread_id TEXT,
      turn_id TEXT,
      reference_kind TEXT NOT NULL CHECK (reference_kind IN ('branch', 'pull_request', 'review', 'merge', 'evidence')),
      availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable', 'unknown')),
      uri TEXT,
      label TEXT,
      external_id TEXT,
      state TEXT,
      metadata TEXT,
      observed_at TEXT NOT NULL,
      observation_hash TEXT NOT NULL,
      duplicate_count INTEGER NOT NULL DEFAULT 1,
      last_observed_at TEXT NOT NULL,
      UNIQUE (issue_run_id, reference_kind, observation_hash),
      FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS history_operator_action (
      operator_action_id TEXT PRIMARY KEY,
      project_key TEXT,
      ticket_key TEXT,
      issue_run_id TEXT,
      attempt_id TEXT,
      thread_id TEXT,
      turn_id TEXT,
      action TEXT NOT NULL,
      actor TEXT,
      result TEXT NOT NULL CHECK (result IN ('accepted', 'rejected', 'failed')),
      result_code TEXT,
      message TEXT,
      reason_note TEXT,
      phase TEXT,
      state_context TEXT,
      requested_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      observation_hash TEXT NOT NULL,
      duplicate_count INTEGER NOT NULL DEFAULT 1,
      last_observed_at TEXT NOT NULL,
      UNIQUE (issue_run_id, action, observation_hash),
      FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS history_blocked_input_event (
      blocked_input_event_id TEXT PRIMARY KEY,
      project_key TEXT,
      ticket_key TEXT,
      issue_run_id TEXT,
      attempt_id TEXT,
      thread_id TEXT,
      turn_id TEXT,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT NOT NULL,
      phase TEXT,
      runtime_state TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      reason_detail TEXT,
      request_id TEXT,
      request_method TEXT,
      input_schema_type TEXT,
      prompt_text TEXT,
      pending_input TEXT,
      state_context TEXT,
      blocked_at TEXT NOT NULL,
      observation_hash TEXT NOT NULL,
      duplicate_count INTEGER NOT NULL DEFAULT 1,
      last_observed_at TEXT NOT NULL,
      UNIQUE (issue_run_id, observation_hash),
      FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
    );
  `);
  recordHistoryHealthMetadata('healthy', null, null);
}

function createAppServerEventLedgerTables(db: PersistenceDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_app_server_event (
      app_server_event_id TEXT PRIMARY KEY,
      issue_run_id TEXT NOT NULL,
      attempt_id TEXT,
      thread_id TEXT,
      turn_id TEXT,
      observed_at TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      source_event_name TEXT NOT NULL,
      payload_class TEXT NOT NULL,
      detail_status TEXT NOT NULL CHECK (detail_status IN (
        'absent',
        'summary_only',
        'redacted_excerpt',
        'redacted_truncated_excerpt',
        'unavailable_policy',
        'unavailable_source'
      )),
      redaction_status TEXT NOT NULL CHECK (redaction_status IN (
        'not_required',
        'redacted',
        'unavailable_policy',
        'unavailable_source'
      )),
      summary TEXT,
      summary_fields TEXT NOT NULL,
      redacted_excerpt TEXT,
      truncation TEXT NOT NULL,
      unavailable_reason_code TEXT,
      full_payload_stored INTEGER NOT NULL DEFAULT 0 CHECK (full_payload_stored IN (0, 1)),
      policy_version INTEGER NOT NULL,
      CHECK (full_payload_stored = 0),
      FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS history_app_server_event_issue_run_observed_idx
      ON history_app_server_event(issue_run_id, observed_at, app_server_event_id);
  `);
}

function ensureRunDiagnosticColumns(db: PersistenceDatabase): void {
  const columns = db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  const migrations: Array<[string, string]> = [
    ['identity', 'ALTER TABLE runs ADD COLUMN identity TEXT'],
    ['terminal_reason_code', 'ALTER TABLE runs ADD COLUMN terminal_reason_code TEXT'],
    ['completed_at', 'ALTER TABLE runs ADD COLUMN completed_at TEXT'],
    ['terminal_reason_detail', 'ALTER TABLE runs ADD COLUMN terminal_reason_detail TEXT'],
    ['root_cause_status', 'ALTER TABLE runs ADD COLUMN root_cause_status TEXT'],
    ['root_cause_reason_code', 'ALTER TABLE runs ADD COLUMN root_cause_reason_code TEXT'],
    ['root_cause_reason_detail', 'ALTER TABLE runs ADD COLUMN root_cause_reason_detail TEXT'],
    ['root_cause_at', 'ALTER TABLE runs ADD COLUMN root_cause_at TEXT'],
    ['session_id', 'ALTER TABLE runs ADD COLUMN session_id TEXT'],
    ['thread_id', 'ALTER TABLE runs ADD COLUMN thread_id TEXT'],
    ['turn_id', 'ALTER TABLE runs ADD COLUMN turn_id TEXT'],
    ['missing_tool_output_recovery', 'ALTER TABLE runs ADD COLUMN missing_tool_output_recovery TEXT']
  ];
  for (const [column, sql] of migrations) {
    if (!existing.has(column)) {
      db.exec(`${sql};`);
    }
  }
  db.exec('UPDATE runs SET terminal_reason_code = error_code WHERE terminal_reason_code IS NULL AND error_code IS NOT NULL;');
  db.exec(
    'UPDATE runs SET completed_at = ended_at WHERE completed_at IS NULL AND terminal_status IS NOT NULL AND ended_at IS NOT NULL;'
  );
}

function ensureRunEventDiagnosticColumns(db: PersistenceDatabase): void {
  const columns = db.prepare('PRAGMA table_info(run_events)').all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  const migrations: Array<[string, string]> = [
    ['reason_code', 'ALTER TABLE run_events ADD COLUMN reason_code TEXT'],
    ['request_method', 'ALTER TABLE run_events ADD COLUMN request_method TEXT'],
    ['request_category', 'ALTER TABLE run_events ADD COLUMN request_category TEXT']
  ];
  for (const [column, sql] of migrations) {
    if (!existing.has(column)) {
      db.exec(`${sql};`);
    }
  }
}

function ensureTokenModelFactColumns(
  db: PersistenceDatabase,
  recordHistoryHealthMetadata: (status: 'healthy' | 'degraded', reasonCode: string | null, detail: string | null) => void
): void {
  const columns = db.prepare('PRAGMA table_info(history_token_model_fact)').all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  const migrations: Array<[string, string]> = [
    ['requested_model', 'ALTER TABLE history_token_model_fact ADD COLUMN requested_model TEXT'],
    ['model_context_window', 'ALTER TABLE history_token_model_fact ADD COLUMN model_context_window INTEGER'],
    ['runtime_provider', 'ALTER TABLE history_token_model_fact ADD COLUMN runtime_provider TEXT'],
    ['provider_turn_count', 'ALTER TABLE history_token_model_fact ADD COLUMN provider_turn_count INTEGER'],
    ['estimated_cost_usd', 'ALTER TABLE history_token_model_fact ADD COLUMN estimated_cost_usd REAL']
  ];
  for (const [column, sql] of migrations) {
    if (!existing.has(column)) {
      db.exec(`${sql};`);
    }
  }
  recordHistoryHealthMetadata('healthy', null, null);
}
