import { redactUnknown } from '../security/redaction';
import { ensureHistoryMigrationTables } from './schema';
import type { PersistenceDatabase } from './store-context';
import type { HistorySchemaHealth } from './types';

export const HISTORY_SCHEMA_NAME = 'project_execution_history';
export const HISTORY_SCHEMA_VERSION = 13;

export interface HistorySchemaStateParams {
  appliedVersion: number;
  status: 'healthy' | 'degraded';
  degradedReasonCode: string | null;
  degradedDetail: string | null;
}

export interface SchemaHealthStoreDependencies {
  db: PersistenceDatabase;
  nowMs: () => number;
}

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

export class SchemaHealthStore {
  private readonly db: PersistenceDatabase;
  private readonly nowMs: () => number;

  constructor(dependencies: SchemaHealthStoreDependencies) {
    this.db = dependencies.db;
    this.nowMs = dependencies.nowMs;
  }

  readHistorySchemaHealth(): HistorySchemaHealth {
    ensureHistoryMigrationTables(this.db);
    const row = this.db.prepare('SELECT * FROM history_schema_state WHERE schema_name = ?').get(HISTORY_SCHEMA_NAME) as
      | {
          schema_name: 'project_execution_history';
          target_version: number;
          applied_version: number;
          status: 'healthy' | 'degraded';
          degraded_reason_code: string | null;
          degraded_detail: string | null;
          updated_at: string;
        }
      | undefined;
    const migrations = this.db
      .prepare(
        `SELECT version, name, status, started_at, finished_at, error_message
         FROM history_schema_migrations
         WHERE schema_name = ?
         ORDER BY version ASC`
      )
      .all(HISTORY_SCHEMA_NAME) as HistorySchemaHealth['migrations'];

    return {
      schema_name: HISTORY_SCHEMA_NAME,
      target_version: HISTORY_SCHEMA_VERSION,
      applied_version: row?.applied_version ?? 0,
      status: row?.status ?? 'degraded',
      degraded_reason_code: row ? row.degraded_reason_code : 'history_schema_state_missing',
      degraded_detail: row ? row.degraded_detail : 'Project Execution History schema state has not been recorded.',
      updated_at: row?.updated_at ?? asIso(this.nowMs()),
      migrations
    };
  }

  recordHistorySchemaState(params: HistorySchemaStateParams): void {
    this.db
      .prepare(
        `INSERT INTO history_schema_state
          (schema_name, target_version, applied_version, status, degraded_reason_code, degraded_detail, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(schema_name) DO UPDATE SET
          target_version = excluded.target_version,
          applied_version = excluded.applied_version,
          status = excluded.status,
          degraded_reason_code = excluded.degraded_reason_code,
          degraded_detail = excluded.degraded_detail,
          updated_at = excluded.updated_at`
      )
      .run(
        HISTORY_SCHEMA_NAME,
        HISTORY_SCHEMA_VERSION,
        params.appliedVersion,
        params.status,
        params.degradedReasonCode,
        redactUnknown(params.degradedDetail),
        asIso(this.nowMs())
      );
  }

  recordHistoryHealthMetadata(status: 'healthy' | 'degraded', reasonCode: string | null, detail: string | null): void {
    this.db
      .prepare(
        `INSERT INTO history_health_metadata
          (singleton_id, status, reason_code, detail, checked_at, schema_version, applied_migration_version)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
          status = excluded.status,
          reason_code = excluded.reason_code,
          detail = excluded.detail,
          checked_at = excluded.checked_at,
          schema_version = excluded.schema_version,
          applied_migration_version = excluded.applied_migration_version`
      )
      .run(
        status,
        reasonCode,
        redactUnknown(detail),
        asIso(this.nowMs()),
        HISTORY_SCHEMA_VERSION,
        this.readHistorySchemaHealth().applied_version
      );
  }
}
