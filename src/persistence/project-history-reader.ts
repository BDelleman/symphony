import { sqlPlaceholders } from './sqlite-helpers';
import { parseDurableIdentity } from './identity-projection-store';
import type { PersistenceDatabase } from './store-context';
import { hydrateTokenModelFact, type TokenModelFactDatabaseRecord } from './types';
import type {
  AppServerEventLedgerRecord,
  AttemptRecord,
  BlockedInputEventRecord,
  DrainAuditBlockerSummary,
  DrainAuditEventRecord,
  DurableIdentity,
  IssueRunRecord,
  OperatorActionHistoryRecord,
  PhaseSpanRecord,
  ProjectHistoryAppServerLiteSummary,
  ProjectHistoryTicketSummaryPage,
  ProjectHistoryTicketSummaryProjection,
  StateTransitionRecord,
  ThreadRecord,
  TicketBlockerRecord,
  TicketEvidenceReferenceRecord,
  TicketReferenceRecord,
  TicketTerminalOutcomeRecord,
  TicketTimelineRecord,
  TokenModelFactRecord,
  ToolSpanRecord,
  TrackerTicketSnapshotRecord,
  TurnRecord
} from './types';

export interface ProjectHistoryReaderDependencies {
  db: PersistenceDatabase;
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

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: string): string[] {
  return parseJsonArray(value).filter((entry): entry is string => typeof entry === 'string');
}

function parseDrainAuditBlockers(value: string): DrainAuditBlockerSummary[] {
  return parseJsonArray(value)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      category: typeof entry.category === 'string' ? entry.category : 'unknown',
      count: typeof entry.count === 'number' && Number.isFinite(entry.count) ? entry.count : 0,
      issue_identifiers: Array.isArray(entry.issue_identifiers)
        ? entry.issue_identifiers.filter((item): item is string => typeof item === 'string')
        : [],
      run_identifiers: Array.isArray(entry.run_identifiers)
        ? entry.run_identifiers.filter((item): item is string => typeof item === 'string')
        : [],
      thread_identifiers: Array.isArray(entry.thread_identifiers)
        ? entry.thread_identifiers.filter((item): item is string => typeof item === 'string')
        : [],
      detail: typeof entry.detail === 'string' ? entry.detail : null
    }));
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

function maxStringTimestamp(values: Array<string | null | undefined>): string | null {
  return values
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort()
    .at(-1) ?? null;
}

function normalizeBoundedLimit(value: number | null | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function normalizeOffset(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return 0;
  }
  return value;
}

export class ProjectHistoryReader {
  private readonly db: PersistenceDatabase;

  constructor(dependencies: ProjectHistoryReaderDependencies) {
    this.db = dependencies.db;
  }

  listProjectTicketIdentities(
    projectKey: string,
    options: { limit?: number; offset?: number } = {}
  ): { items: DurableIdentity[]; limit: number; offset: number; has_more: boolean; total: number } {
    const limit = normalizeBoundedLimit(options.limit, 50, 100);
    const offset = normalizeOffset(options.offset);
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM (
           SELECT ticket_key
           FROM issue_run
           WHERE project_key = ? AND ticket_key IS NOT NULL AND identity IS NOT NULL
           GROUP BY ticket_key
         )`
      )
      .get(projectKey) as { count: number };
    const ticketRows = this.db
      .prepare(
        `SELECT ticket_key, MAX(started_at) AS latest_started_at
         FROM issue_run
         WHERE project_key = ? AND ticket_key IS NOT NULL AND identity IS NOT NULL
         GROUP BY ticket_key
         ORDER BY latest_started_at DESC, ticket_key ASC
         LIMIT ? OFFSET ?`
      )
      .all(projectKey, limit, offset) as Array<{ ticket_key: string; latest_started_at: string }>;

    const identityStmt = this.db.prepare(
      `SELECT identity
       FROM issue_run
       WHERE project_key = ? AND ticket_key = ? AND identity IS NOT NULL
       ORDER BY started_at DESC, issue_run_id DESC
       LIMIT 1`
    );
    const items = ticketRows
      .map((row) => {
        const identityRow = identityStmt.get(projectKey, row.ticket_key) as { identity: string | null } | undefined;
        return parseDurableIdentity(identityRow?.identity ?? null);
      })
      .filter((identity): identity is DurableIdentity => identity !== null);

    return {
      items,
      limit,
      offset,
      has_more: offset + items.length < totalRow.count,
      total: totalRow.count
    };
  }

  listProjectTicketSummaries(
    projectKey: string,
    options: { limit?: number; offset?: number } = {}
  ): ProjectHistoryTicketSummaryPage {
    const page = this.listProjectTicketIdentities(projectKey, options);
    return {
      ...page,
      items: page.items.map((identity) => this.getProjectTicketSummary(identity))
    };
  }

  getProjectTicketIdentity(projectKey: string, ticketKey: string): DurableIdentity | null {
    const row = this.db
      .prepare(
        `SELECT identity
         FROM issue_run
         WHERE project_key = ? AND ticket_key = ? AND identity IS NOT NULL
         ORDER BY started_at DESC, issue_run_id DESC
         LIMIT 1`
      )
      .get(projectKey, ticketKey) as { identity: string | null } | undefined;
    return parseDurableIdentity(row?.identity ?? null);
  }

  listProjectDrainAuditEvents(
    projectKey: string,
    options: { limit?: number; offset?: number } = {}
  ): { items: DrainAuditEventRecord[]; limit: number; offset: number; has_more: boolean; total: number } {
    const limit = normalizeBoundedLimit(options.limit, 50, 100);
    const offset = normalizeOffset(options.offset);
    const totalRow = this.db
      .prepare('SELECT COUNT(*) AS count FROM history_drain_audit_event WHERE project_key = ?')
      .get(projectKey) as { count: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM history_drain_audit_event
         WHERE project_key = ?
         ORDER BY occurred_at DESC, drain_audit_event_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(projectKey, limit, offset) as Array<Omit<DrainAuditEventRecord, 'state_context' | 'blocker_summaries'> & {
      state_context: string | null;
      blocker_summaries: string;
    }>;
    const items = rows.map((row) => this.projectDrainAuditRow(row));
    return {
      items,
      limit,
      offset,
      has_more: offset + items.length < totalRow.count,
      total: totalRow.count
    };
  }

  reconstructTicketTimeline(identity: DurableIdentity): TicketTimelineRecord {
    const issueRunRows = this.db
      .prepare(
        `SELECT * FROM issue_run
         WHERE project_key = ? AND ticket_key = ?
         ORDER BY started_at ASC, issue_run_id ASC`
      )
      .all(identity.project.key, identity.ticket.key) as Array<Omit<IssueRunRecord, 'identity'> & { identity: string | null }>;
    const issueRuns = issueRunRows.map((row) => ({
      ...row,
      identity: parseDurableIdentity(row.identity)
    }));
    const issueRunIds = issueRuns.map((run) => run.issue_run_id);
    if (issueRunIds.length === 0) {
      return {
        identity,
        issue_runs: [],
        attempts: [],
        threads: [],
        turns: [],
        phase_spans: [],
        state_transitions: [],
        terminal_outcomes: [],
        blockers: [],
        evidence_references: [],
        tracker_snapshots: [],
        ticket_references: [],
        operator_actions: [],
        drain_audit_events: [],
        blocked_input_events: [],
        app_server_events: [],
        token_model_facts: []
      };
    }

    const attempts = this.selectByIssueRunIds<AttemptRecord>(
      `SELECT attempt.* FROM attempt
       JOIN issue_run ON issue_run.issue_run_id = attempt.issue_run_id
       WHERE issue_run.issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY issue_run.started_at ASC, attempt.attempt_number ASC, attempt.started_at ASC`,
      issueRunIds
    );
    const threads = this.selectByIssueRunIds<ThreadRecord>(
      `SELECT thread.* FROM thread
       JOIN attempt ON attempt.attempt_id = thread.attempt_id
       JOIN issue_run ON issue_run.issue_run_id = attempt.issue_run_id
       WHERE issue_run.issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY issue_run.started_at ASC, attempt.attempt_number ASC, thread.started_at ASC, thread.thread_id ASC`,
      issueRunIds
    );
    const turns = this.selectByIssueRunIds<TurnRecord>(
      `SELECT turn.* FROM turn
       JOIN thread ON thread.thread_id = turn.thread_id
       JOIN attempt ON attempt.attempt_id = thread.attempt_id
       JOIN issue_run ON issue_run.issue_run_id = attempt.issue_run_id
       WHERE issue_run.issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY issue_run.started_at ASC, attempt.attempt_number ASC, thread.started_at ASC, turn.turn_index ASC`,
      issueRunIds
    );
    const phaseSpans = this.selectByIssueRunIds<PhaseSpanRecord>(
      `SELECT phase_span.* FROM phase_span
       JOIN turn ON turn.turn_id = phase_span.turn_id
       JOIN thread ON thread.thread_id = turn.thread_id
       JOIN attempt ON attempt.attempt_id = thread.attempt_id
       JOIN issue_run ON issue_run.issue_run_id = attempt.issue_run_id
       WHERE issue_run.issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY phase_span.started_at ASC, phase_span.phase_span_id ASC`,
      issueRunIds
    );
    const stateTransitions = this.selectByIssueRunIds<StateTransitionRecord>(
      `SELECT * FROM state_transition
       WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY transitioned_at ASC, state_transition_id ASC`,
      issueRunIds
    );
    const terminalOutcomes = this.selectByIssueRunIds<TicketTerminalOutcomeRecord>(
      `SELECT * FROM history_ticket_terminal_outcome
       WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY recorded_at ASC, terminal_outcome_id ASC`,
      issueRunIds
    );
    const blockers = this.selectByIssueRunIds<TicketBlockerRecord>(
      `SELECT * FROM history_ticket_blocker
       WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY blocked_at ASC, blocker_id ASC`,
      issueRunIds
    );
    const evidenceRows = this.selectByIssueRunIds<Omit<TicketEvidenceReferenceRecord, 'metadata'> & { metadata: string | null }>(
      `SELECT * FROM history_ticket_evidence_reference
       WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY recorded_at ASC, evidence_reference_id ASC`,
      issueRunIds
    );
    const trackerSnapshotRows = this.selectByIssueRunIds<Omit<TrackerTicketSnapshotRecord, 'labels'> & { labels: string }>(
      `SELECT * FROM history_tracker_ticket_snapshot
       WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY observed_at ASC, tracker_snapshot_id ASC`,
      issueRunIds
    );
    const ticketReferenceRows = this.selectByIssueRunIds<Omit<TicketReferenceRecord, 'metadata'> & { metadata: string | null }>(
      `SELECT * FROM history_ticket_reference
       WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY observed_at ASC, ticket_reference_id ASC`,
      issueRunIds
    );
    const operatorActionRows = this.selectByIssueRunIds<Omit<OperatorActionHistoryRecord, 'state_context'> & { state_context: string | null }>(
      `SELECT * FROM history_operator_action
       WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY requested_at ASC, operator_action_id ASC`,
      issueRunIds
    );
    const drainAuditRows = this.db
      .prepare(
        `SELECT * FROM history_drain_audit_event
         WHERE project_key = ?
          AND (
            ticket_key = ?
            OR issue_run_id IN (${sqlPlaceholders(issueRunIds)})
            OR blocker_summaries LIKE ?
          )
         ORDER BY occurred_at ASC, drain_audit_event_id ASC`
      )
      .all(identity.project.key, identity.ticket.key, ...issueRunIds, `%"${identity.ticket.human_issue_identifier}"%`) as Array<
      Omit<DrainAuditEventRecord, 'state_context' | 'blocker_summaries'> & {
        state_context: string | null;
        blocker_summaries: string;
      }
    >;
    const blockedInputEventRows = this.selectByIssueRunIds<
      Omit<BlockedInputEventRecord, 'pending_input' | 'state_context'> & {
        pending_input: string | null;
        state_context: string | null;
      }
    >(
      `SELECT * FROM history_blocked_input_event
       WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY blocked_at ASC, blocked_input_event_id ASC`,
      issueRunIds
    );
    const tokenModelFacts = this.selectByIssueRunIds<TokenModelFactDatabaseRecord>(
      `SELECT * FROM history_token_model_fact
       WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY observed_at ASC, token_model_fact_id ASC`,
      issueRunIds
    ).map(hydrateTokenModelFact);
    const appServerEventRows = this.selectByIssueRunIds<
      Omit<AppServerEventLedgerRecord, 'summary_fields' | 'truncation' | 'full_payload_stored'> & {
        summary_fields: string;
        truncation: string;
        full_payload_stored: 0 | 1;
      }
    >(
      `SELECT app_server_event_id, issue_run_id, attempt_id, thread_id, turn_id, observed_at,
          source_event_id, source_event_name, payload_class, detail_status, redaction_status,
          summary, summary_fields, redacted_excerpt, truncation, unavailable_reason_code,
          full_payload_stored, policy_version
       FROM history_app_server_event
       WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
       ORDER BY observed_at ASC, app_server_event_id ASC`,
      issueRunIds
    );

    return {
      identity,
      issue_runs: issueRuns,
      attempts,
      threads,
      turns,
      phase_spans: phaseSpans,
      state_transitions: stateTransitions,
      terminal_outcomes: terminalOutcomes,
      blockers,
      evidence_references: evidenceRows.map((row) => ({
        ...row,
        metadata: parseNullableJsonObject(row.metadata)
      })),
      tracker_snapshots: trackerSnapshotRows.map((row) => ({
        ...row,
        labels: parseStringArray(row.labels)
      })),
      ticket_references: ticketReferenceRows.map((row) => ({
        ...row,
        metadata: parseNullableJsonObject(row.metadata)
      })),
      operator_actions: operatorActionRows.map((row) => ({
        ...row,
        state_context: parseNullableJsonObject(row.state_context)
      })),
      drain_audit_events: drainAuditRows.map((row) => this.projectDrainAuditRow(row)),
      blocked_input_events: blockedInputEventRows.map((row) => ({
        ...row,
        pending_input: parseNullableJsonObject(row.pending_input),
        state_context: parseNullableJsonObject(row.state_context)
      })),
      app_server_events: appServerEventRows.map((event) => ({
        ...event,
        summary_fields: parseNullableJsonObject(event.summary_fields) ?? {},
        truncation: parseHistoryPayloadTruncation(event.truncation),
        full_payload_stored: event.full_payload_stored === 1
      })),
      token_model_facts: tokenModelFacts
    };
  }

  private getProjectTicketSummary(identity: DurableIdentity): ProjectHistoryTicketSummaryProjection {
    const issueRuns = this.db
      .prepare(
        `SELECT issue_run_id, issue_id, issue_identifier, identity, started_at, ended_at, status, reason_code, reason_detail
         FROM issue_run
         WHERE project_key = ? AND ticket_key = ?
         ORDER BY started_at ASC, issue_run_id ASC`
      )
      .all(identity.project.key, identity.ticket.key) as Array<Omit<IssueRunRecord, 'identity'> & { identity: string | null }>;
    const issueRunIds = issueRuns.map((run) => run.issue_run_id);
    const latestIssueRun = issueRuns.at(-1) ?? null;
    const latestAttempt = this.latestSummaryAttempt(issueRunIds);
    const latestOutcome = this.latestSummaryOutcome(issueRunIds);
    const latestTrackerSnapshot = this.latestSummaryTrackerSnapshot(issueRunIds);
    const latestTransition = this.latestSummaryTransition(issueRunIds);
    const lastKnownStatus = latestTrackerSnapshot?.tracker_status ?? latestTransition?.to_status ?? latestIssueRun?.status ?? 'unknown';
    const summary = this.summaryCounts(issueRunIds);
    const latestObservedAt = maxStringTimestamp([
      latestIssueRun?.started_at ?? null,
      latestAttempt?.started_at ?? null,
      latestOutcome?.recorded_at ?? null,
      latestTrackerSnapshot?.last_observed_at ?? null,
      latestTransition?.transitioned_at ?? null,
      this.latestDrainAuditObservedAt(issueRunIds),
      this.latestAppServerObservedAt(issueRunIds)
    ]);

    return {
      identity,
      state: this.isSummaryActive(latestIssueRun) ? 'active' : 'completed',
      current_status: lastKnownStatus,
      last_known_status: lastKnownStatus,
      latest_attempt: {
        attempt_id: latestAttempt?.attempt_id ?? null,
        attempt_number: latestAttempt?.attempt_number ?? null,
        status: latestAttempt?.status ?? null,
        started_at: latestAttempt?.started_at ?? null,
        ended_at: latestAttempt?.ended_at ?? null,
        outcome: latestOutcome?.outcome ?? null,
        outcome_reason_code: latestOutcome?.reason_code ?? null
      },
      summary,
      app_server_lite: this.summaryAppServerLite(issueRunIds),
      latest_observed_at: latestObservedAt
    };
  }

  private isSummaryActive(latestIssueRun: Pick<IssueRunRecord, 'ended_at' | 'status'> | null): boolean {
    if (!latestIssueRun) {
      return false;
    }
    return latestIssueRun.ended_at === null || ['pending', 'running', 'retrying', 'blocked'].includes(latestIssueRun.status);
  }

  private latestSummaryAttempt(issueRunIds: string[]): AttemptRecord | null {
    if (issueRunIds.length === 0) {
      return null;
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM attempt
           WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
           ORDER BY started_at DESC, attempt_number DESC, attempt_id DESC
           LIMIT 1`
        )
        .get(...issueRunIds) as AttemptRecord | undefined
    ) ?? null;
  }

  private latestSummaryOutcome(issueRunIds: string[]): TicketTerminalOutcomeRecord | null {
    if (issueRunIds.length === 0) {
      return null;
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM history_ticket_terminal_outcome
           WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
           ORDER BY recorded_at DESC, terminal_outcome_id DESC
           LIMIT 1`
        )
        .get(...issueRunIds) as TicketTerminalOutcomeRecord | undefined
    ) ?? null;
  }

  private latestSummaryTrackerSnapshot(issueRunIds: string[]): TrackerTicketSnapshotRecord | null {
    if (issueRunIds.length === 0) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT * FROM history_tracker_ticket_snapshot
         WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
         ORDER BY last_observed_at DESC, tracker_snapshot_id DESC
         LIMIT 1`
      )
      .get(...issueRunIds) as (Omit<TrackerTicketSnapshotRecord, 'labels'> & { labels: string }) | undefined;
    return row ? { ...row, labels: parseStringArray(row.labels) } : null;
  }

  private latestSummaryTransition(issueRunIds: string[]): StateTransitionRecord | null {
    if (issueRunIds.length === 0) {
      return null;
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM state_transition
           WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})
           ORDER BY transitioned_at DESC, state_transition_id DESC
           LIMIT 1`
        )
        .get(...issueRunIds) as StateTransitionRecord | undefined
    ) ?? null;
  }

  private latestAppServerObservedAt(issueRunIds: string[]): string | null {
    if (issueRunIds.length === 0) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT MAX(observed_at) AS observed_at
         FROM history_app_server_event
         WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})`
      )
      .get(...issueRunIds) as { observed_at: string | null } | undefined;
    return row?.observed_at ?? null;
  }

  private latestDrainAuditObservedAt(issueRunIds: string[]): string | null {
    if (issueRunIds.length === 0) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT MAX(observed_at) AS observed_at
         FROM history_drain_audit_event
         WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})`
      )
      .get(...issueRunIds) as { observed_at: string | null } | undefined;
    return row?.observed_at ?? null;
  }

  private summaryCounts(issueRunIds: string[]): ProjectHistoryTicketSummaryProjection['summary'] {
    const count = (table: string, where: string = ''): number => {
      if (issueRunIds.length === 0) {
        return 0;
      }
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM ${table}
           WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})${where}`
        )
        .get(...issueRunIds) as { count: number };
      return row.count;
    };
    const tokenRow =
      issueRunIds.length === 0
        ? { count: 0, total_tokens: null as number | null }
        : (this.db
            .prepare(
              `SELECT COUNT(*) AS count,
                      SUM(CASE WHEN runtime_provider IS NULL OR runtime_provider != 'claude-cli' THEN total_tokens ELSE NULL END) AS total_tokens
               FROM history_token_model_fact
               WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})`
            )
            .get(...issueRunIds) as { count: number; total_tokens: number | null });
    return {
      issue_run_count: issueRunIds.length,
      attempt_count: count('attempt'),
      thread_count: this.countThreads(issueRunIds),
      turn_count: this.countTurns(issueRunIds),
      phase_count: this.countPhaseSpans(issueRunIds),
      state_transition_count: count('state_transition'),
      active_blocker_count: count('history_ticket_blocker', ` AND status = 'active'`),
      resolved_blocker_count: count('history_ticket_blocker', ` AND status = 'resolved'`),
      evidence_reference_count: count('history_ticket_evidence_reference'),
      tracker_snapshot_count: count('history_tracker_ticket_snapshot'),
      ticket_reference_count: count('history_ticket_reference'),
      operator_action_count: count('history_operator_action'),
      blocked_input_event_count: count('history_blocked_input_event'),
      app_server_event_count: count('history_app_server_event'),
      drain_audit_event_count: count('history_drain_audit_event'),
      token_model_fact_count: tokenRow.count,
      total_tokens: tokenRow.total_tokens
    };
  }

  private countThreads(issueRunIds: string[]): number {
    if (issueRunIds.length === 0) {
      return 0;
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM thread
         JOIN attempt ON attempt.attempt_id = thread.attempt_id
         WHERE attempt.issue_run_id IN (${sqlPlaceholders(issueRunIds)})`
      )
      .get(...issueRunIds) as { count: number };
    return row.count;
  }

  private countTurns(issueRunIds: string[]): number {
    if (issueRunIds.length === 0) {
      return 0;
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM turn
         JOIN thread ON thread.thread_id = turn.thread_id
         JOIN attempt ON attempt.attempt_id = thread.attempt_id
         WHERE attempt.issue_run_id IN (${sqlPlaceholders(issueRunIds)})`
      )
      .get(...issueRunIds) as { count: number };
    return row.count;
  }

  private countPhaseSpans(issueRunIds: string[]): number {
    if (issueRunIds.length === 0) {
      return 0;
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM phase_span
         JOIN turn ON turn.turn_id = phase_span.turn_id
         JOIN thread ON thread.thread_id = turn.thread_id
         JOIN attempt ON attempt.attempt_id = thread.attempt_id
         WHERE attempt.issue_run_id IN (${sqlPlaceholders(issueRunIds)})`
      )
      .get(...issueRunIds) as { count: number };
    return row.count;
  }

  private summaryAppServerLite(issueRunIds: string[]): ProjectHistoryAppServerLiteSummary {
    const summary: ProjectHistoryAppServerLiteSummary = {
      redacted_event_count: 0,
      truncated_event_count: 0,
      summary_only_event_count: 0,
      unavailable_event_count: 0,
      full_payload_stored_count: 0,
      degraded_event_count: 0,
      unavailable_reasons: []
    };
    if (issueRunIds.length === 0) {
      return summary;
    }
    const unavailableReasons = new Map<string, { count: number; classification: 'expected_policy' | 'failure' }>();
    const rows = this.db
      .prepare(
        `SELECT detail_status, redaction_status, truncation, unavailable_reason_code, full_payload_stored, policy_version
         FROM history_app_server_event
         WHERE issue_run_id IN (${sqlPlaceholders(issueRunIds)})`
      )
      .all(...issueRunIds) as Array<{
        detail_status: AppServerEventLedgerRecord['detail_status'];
        redaction_status: AppServerEventLedgerRecord['redaction_status'];
        truncation: string;
        unavailable_reason_code: string | null;
        full_payload_stored: 0 | 1;
        policy_version: number;
      }>;

    for (const row of rows) {
      const truncated = parseHistoryPayloadTruncation(row.truncation).truncated;
      const fullPayloadStored = row.full_payload_stored === 1;
      if (row.redaction_status === 'redacted') {
        summary.redacted_event_count += 1;
      }
      if (truncated) {
        summary.truncated_event_count += 1;
      }
      if (row.detail_status === 'summary_only') {
        summary.summary_only_event_count += 1;
      }
      if (fullPayloadStored) {
        summary.full_payload_stored_count += 1;
      }
      const unavailableClassification = this.classifySummaryUnavailablePolicy(row);
      if (row.unavailable_reason_code) {
        summary.unavailable_event_count += 1;
        const existing = unavailableReasons.get(row.unavailable_reason_code);
        unavailableReasons.set(row.unavailable_reason_code, {
          count: (existing?.count ?? 0) + 1,
          classification:
            existing?.classification === 'failure' || unavailableClassification === 'failure'
              ? 'failure'
              : unavailableClassification
        });
      }
      if (fullPayloadStored || unavailableClassification === 'failure' || this.hasMalformedSummaryPayloadPolicyMetadata(row)) {
        summary.degraded_event_count += 1;
      }
    }

    summary.unavailable_reasons = [...unavailableReasons.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason_code, value]) => ({ reason_code, ...value }));
    return summary;
  }

  private classifySummaryUnavailablePolicy(event: {
    detail_status: AppServerEventLedgerRecord['detail_status'];
    redaction_status: AppServerEventLedgerRecord['redaction_status'];
    unavailable_reason_code: string | null;
  }): 'expected_policy' | 'failure' {
    if (!event.unavailable_reason_code) {
      return 'expected_policy';
    }
    return event.detail_status === 'unavailable_policy' && event.redaction_status === 'unavailable_policy' ? 'expected_policy' : 'failure';
  }

  private hasMalformedSummaryPayloadPolicyMetadata(event: {
    policy_version: number;
    detail_status: AppServerEventLedgerRecord['detail_status'];
    redaction_status: AppServerEventLedgerRecord['redaction_status'];
    unavailable_reason_code: string | null;
  }): boolean {
    if (!Number.isFinite(event.policy_version) || event.policy_version < 1) {
      return true;
    }
    if (event.detail_status === 'unavailable_policy') {
      return event.redaction_status !== 'unavailable_policy' || !event.unavailable_reason_code;
    }
    if (event.detail_status === 'unavailable_source') {
      return event.redaction_status !== 'unavailable_source' || !event.unavailable_reason_code;
    }
    return Boolean(event.unavailable_reason_code);
  }

  private selectByIssueRunIds<T>(sql: string, issueRunIds: string[]): T[] {
    return this.db.prepare(sql).all(...issueRunIds) as T[];
  }

  private projectDrainAuditRow(
    row: Omit<DrainAuditEventRecord, 'state_context' | 'blocker_summaries'> & {
      state_context: string | null;
      blocker_summaries: string;
    }
  ): DrainAuditEventRecord {
    return {
      ...row,
      state_context: parseNullableJsonObject(row.state_context),
      blocker_summaries: parseDrainAuditBlockers(row.blocker_summaries)
    };
  }
}
