import type { RunTerminalStatus } from './types';

interface ReconciliationDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
  };
}

export interface TerminalRunEventEvidence {
  run_id: string;
  at: string;
  event: string;
  status: RunTerminalStatus;
}

const TERMINAL_FAILURE_EVENTS: Readonly<Record<string, RunTerminalStatus>> = {
  'agent_runner.turn.failed': 'failed',
  'agent_runner.turn.cancelled': 'cancelled',
  'agent_runner.turn.timed_out': 'timed_out',
  'codex.turn.failed': 'failed',
  'codex.turn.cancelled': 'cancelled',
  'codex.turn.timed_out': 'timed_out'
};

export function findLatestTerminalRunEventEvidence(
  db: ReconciliationDatabase,
  issueRunId: string,
  issueId: string,
  issueRunStartedAt: string
): TerminalRunEventEvidence | null {
  const events = Object.keys(TERMINAL_FAILURE_EVENTS);
  const placeholders = events.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT runs.run_id, run_events.at, run_events.event
       FROM runs
       JOIN run_events ON run_events.run_id = runs.run_id
       WHERE runs.run_id = (
         SELECT latest_run.run_id
         FROM runs AS latest_run
         LEFT JOIN history_identity_projection AS latest_projection
           ON latest_projection.source_table = 'runs'
          AND latest_projection.source_id = latest_run.run_id
         WHERE latest_run.issue_id = ? AND latest_run.started_at >= ?
           AND (latest_projection.issue_run_id = ? OR latest_projection.issue_run_id IS NULL)
         ORDER BY latest_run.started_at DESC, latest_run.run_id DESC
         LIMIT 1
       )
         AND run_events.event IN (${placeholders})
       ORDER BY run_events.at DESC, run_events.event_id DESC
       LIMIT 1`
    )
    .get(issueId, issueRunStartedAt, issueRunId, ...events) as
    | { run_id: string; at: string; event: string }
    | undefined;
  if (!row) {
    return null;
  }
  const status = TERMINAL_FAILURE_EVENTS[row.event];
  return status ? { ...row, status } : null;
}
