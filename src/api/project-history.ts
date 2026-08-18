import type {
  AppServerEventLedgerExcerpt,
  DrainAuditEventRecord,
  DurableIdentity,
  ExecutionGraphEntityStatus,
  HistorySchemaHealth,
  ProjectHistoryAppServerLiteSummary,
  ProjectHistoryTicketSummaryProjection,
  PersistenceHealth,
  IssueRunRecord,
  TicketTimelineRecord
} from '../persistence';
import { REASON_CODES } from '../observability/reason-codes';

export type ProjectHistoryFactStatus =
  | 'present'
  | 'missing'
  | 'lifecycle_pending'
  | 'optional_unavailable'
  | 'degraded'
  | 'redacted'
  | 'truncated'
  | 'unavailable';

export interface ProjectHistoryFactState {
  fact: string;
  status: ProjectHistoryFactStatus;
  reason_code: string | null;
  detail: string | null;
}

export interface ProjectHistoryPage {
  limit: number;
  offset: number;
  has_more: boolean;
  total: number | null;
}

export interface ProjectHistoryHealth {
  status: 'healthy' | 'disabled' | 'degraded';
  enabled: boolean;
  storage: {
    type: 'sqlite' | 'disabled';
    target: string | null;
  };
  schema: {
    status: 'healthy' | 'degraded' | 'unavailable';
    integrity_ok: boolean;
    target_version: number | null;
    applied_version: number | null;
    reason_code: string | null;
    detail: string | null;
  };
  counts: {
    runs: number;
    tickets: number | null;
  };
  retention: {
    retention_days: number | null;
    last_prune: {
      status: 'succeeded' | 'failed' | 'never_run';
      last_pruned_at: string | null;
      failure_at: string | null;
      failure_reason_code: string | null;
      failure_detail: string | null;
    };
  };
  writes: {
    status: 'healthy' | 'degraded';
    recent_failures: NonNullable<PersistenceHealth['recent_write_failures']>;
  };
  projections: {
    status: 'healthy' | 'degraded' | 'unavailable';
    reason_code: string | null;
    detail: string | null;
  };
  app_server_lite: {
    status: 'healthy' | 'degraded' | 'missing';
    redacted_event_count: number;
    truncated_event_count: number;
    summary_only_event_count: number;
    unavailable_event_count: number;
    full_payload_stored_count: number;
    degraded_event_count: number;
    unavailable_reasons: Array<{
      reason_code: string;
      count: number;
      classification: 'expected_policy' | 'failure';
    }>;
  };
  diagnostics: ProjectHistoryFactState[];
}

export interface ProjectHistoryTicketRow {
  project_identity: DurableIdentity['project'];
  ticket_identity: DurableIdentity['ticket'];
  state: 'active' | 'completed';
  current_status: string;
  last_known_status: string;
  latest_attempt: {
    attempt_id: string | null;
    attempt_number: number | null;
    status: ExecutionGraphEntityStatus | null;
    started_at: string | null;
    ended_at: string | null;
    outcome: string | null;
    outcome_reason_code: string | null;
  };
  summary: {
    issue_run_count: number;
    attempt_count: number;
    thread_count: number;
    turn_count: number;
    phase_count: number;
    state_transition_count: number;
    active_blocker_count: number;
    resolved_blocker_count: number;
    evidence_reference_count: number;
    tracker_snapshot_count: number;
    ticket_reference_count: number;
    operator_action_count: number;
    drain_audit_event_count: number;
    blocked_input_event_count: number;
    app_server_event_count: number;
    token_model_fact_count: number;
    total_tokens: number | null;
  };
  facts: ProjectHistoryFactState[];
  latest_observed_at: string | null;
}

export interface ProjectHistoryTicketListResponse {
  project_identity: {
    key: string;
  };
  health: ProjectHistoryHealth;
  page: ProjectHistoryPage;
  tickets: ProjectHistoryTicketRow[];
  drain_audit_events: DrainAuditEventRecord[];
  facts: ProjectHistoryFactState[];
}

export interface ProjectHistoryTicketDetailResponse extends ProjectHistoryTicketRow {
  health: ProjectHistoryHealth;
  timeline: TicketTimelineRecord;
  attempts: TicketTimelineRecord['attempts'];
  phases: TicketTimelineRecord['phase_spans'];
  state_transitions: TicketTimelineRecord['state_transitions'];
  thread_references: Array<{ thread_id: string; attempt_id: string; started_at: string; ended_at: string | null; status: string }>;
  turn_references: Array<{ turn_id: string; thread_id: string; turn_index: number; started_at: string; ended_at: string | null; status: string }>;
  outcomes: TicketTimelineRecord['terminal_outcomes'];
  blockers: TicketTimelineRecord['blockers'];
  evidence_references: TicketTimelineRecord['evidence_references'];
  tracker_facts: TicketTimelineRecord['tracker_snapshots'];
  pr_and_reference_facts: TicketTimelineRecord['ticket_references'];
  operator_facts: TicketTimelineRecord['operator_actions'];
  drain_audit_events: TicketTimelineRecord['drain_audit_events'];
  blocked_input_events: TicketTimelineRecord['blocked_input_events'];
  app_server_lite_summaries: AppServerEventLedgerExcerpt[];
  token_model_summaries: TicketTimelineRecord['token_model_facts'];
}

export interface ProjectHistoryConsumerSummaryResponse {
  schema_version: 'symphony.project_history.consumer_summary.v1';
  read_only: true;
  deferred_capabilities: Array<'validation_reuse' | 'phase_handoff_packets' | 'drain_mode' | 'operator_steering'>;
  health: ProjectHistoryHealth;
  project_identity: DurableIdentity['project'];
  ticket_identity: DurableIdentity['ticket'];
  current_ticket_state: {
    state: ProjectHistoryTicketRow['state'];
    current_status: string;
    last_known_status: string;
    latest_observed_at: string | null;
    facts: ProjectHistoryFactState[];
  };
  attempts: {
    total: number;
    repeated: boolean;
    latest: ProjectHistoryTicketRow['latest_attempt'];
    recent: Array<{
      attempt_id: string;
      attempt_number: number;
      status: ExecutionGraphEntityStatus;
      started_at: string;
      ended_at: string | null;
      reason_code: string | null;
      reason_detail: string | null;
    }>;
  };
  recent_phases: Array<{
    phase: string;
    status: ExecutionGraphEntityStatus;
    started_at: string;
    ended_at: string | null;
    reason_code: string | null;
    reason_detail: string | null;
  }>;
  blockers: {
    active_count: number;
    resolved_count: number;
    recent: Array<{
      blocker_type: string;
      status: 'active' | 'resolved';
      reason_code: string;
      reason_detail: string | null;
      blocked_at: string;
      resolved_at: string | null;
    }>;
  };
  token_model: {
    status: 'present' | 'missing';
    total_tokens: number | null;
    requested_models: string[];
    effective_models: string[];
    telemetry_confidences: string[];
    runtime_providers: string[];
    provider_turn_count: number | null;
    estimated_cost_usd: number | null;
    by_runtime_and_model: Array<{
      runtime_provider: string;
      effective_model: string;
      fact_count: number;
      total_tokens: number | null;
      provider_turn_count: number | null;
      estimated_cost_usd: number | null;
    }>;
    recent: Array<{
      requested_model: string | null;
      effective_model: string | null;
      model_source: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_input_tokens: number | null;
      reasoning_output_tokens: number | null;
      total_tokens: number | null;
      model_context_window: number | null;
      runtime_provider: string | null;
      provider_turn_count: number | null;
      estimated_cost_usd: number | null;
      telemetry_confidence: string;
      observed_at: string;
    }>;
  };
  app_server_lite: {
    status: 'present' | 'missing' | 'degraded';
    excerpts: Array<{
      source_event_id: string;
      source_event_name: string;
      observed_at: string;
      payload_class: string;
      detail_status: string;
      redaction_status: string;
      summary: string | null;
      summary_fields: Record<string, unknown>;
      redacted_excerpt: string | null;
      unavailable_reason_code: string | null;
      truncated: boolean;
      full_payload_stored: boolean;
    }>;
  };
  evidence_references: Array<{
    evidence_kind: string;
    uri: string;
    title: string | null;
    recorded_at: string;
    metadata: Record<string, unknown> | null;
  }>;
}

export function buildProjectHistoryListResponse(params: {
  projectKey: string;
  timelines?: TicketTimelineRecord[];
  summaries?: ProjectHistoryTicketSummaryProjection[];
  drainAuditEvents?: DrainAuditEventRecord[];
  page: ProjectHistoryPage;
  persistenceHealth?: PersistenceHealth | null;
  historySchemaHealth?: HistorySchemaHealth | null;
}): ProjectHistoryTicketListResponse {
  const historySchemaHealth = params.historySchemaHealth ?? params.persistenceHealth?.history_schema ?? null;
  const summaries = params.summaries ?? params.timelines?.map((timeline) => buildProjectHistoryTicketSummary(timeline)) ?? [];
  const health = buildProjectHistoryHealth({
    persistenceHealth: params.persistenceHealth ?? null,
    summaries,
    ticketCount: params.page.total,
    projectionAvailable: true,
    historySchemaHealth
  });
  return {
    project_identity: {
      key: params.projectKey
    },
    health,
    page: params.page,
    tickets: summaries.map((summary) => buildProjectHistoryTicketRowFromSummary(summary, historySchemaHealth)),
    drain_audit_events: params.drainAuditEvents ?? [],
    facts: health.diagnostics
  };
}

export function buildProjectHistoryTicketDetailResponse(
  timeline: TicketTimelineRecord,
  historySchemaHealth?: HistorySchemaHealth | null,
  persistenceHealth?: PersistenceHealth | null
): ProjectHistoryTicketDetailResponse {
  const row = buildProjectHistoryTicketRow(timeline, historySchemaHealth);
  const health = buildProjectHistoryHealth({
    persistenceHealth: persistenceHealth ?? null,
    timelines: [timeline],
    ticketCount: 1,
    projectionAvailable: true,
    historySchemaHealth
  });
  return {
    ...row,
    health,
    timeline,
    attempts: timeline.attempts,
    phases: timeline.phase_spans,
    state_transitions: timeline.state_transitions,
    thread_references: timeline.threads.map((thread) => ({
      thread_id: thread.thread_id,
      attempt_id: thread.attempt_id,
      started_at: thread.started_at,
      ended_at: thread.ended_at,
      status: thread.status
    })),
    turn_references: timeline.turns.map((turn) => ({
      turn_id: turn.turn_id,
      thread_id: turn.thread_id,
      turn_index: turn.turn_index,
      started_at: turn.started_at,
      ended_at: turn.ended_at,
      status: turn.status
    })),
    outcomes: timeline.terminal_outcomes,
    blockers: timeline.blockers,
    evidence_references: timeline.evidence_references,
    tracker_facts: timeline.tracker_snapshots,
    pr_and_reference_facts: timeline.ticket_references,
    operator_facts: timeline.operator_actions,
    drain_audit_events: timeline.drain_audit_events,
    blocked_input_events: timeline.blocked_input_events,
    app_server_lite_summaries: timeline.app_server_events,
    token_model_summaries: timeline.token_model_facts
  };
}

export function buildProjectHistoryConsumerSummaryResponse(
  timeline: TicketTimelineRecord,
  historySchemaHealth?: HistorySchemaHealth | null,
  persistenceHealth?: PersistenceHealth | null
): ProjectHistoryConsumerSummaryResponse {
  const row = buildProjectHistoryTicketRow(timeline, historySchemaHealth);
  const health = buildProjectHistoryHealth({
    persistenceHealth: persistenceHealth ?? null,
    timelines: [timeline],
    ticketCount: 1,
    projectionAvailable: true,
    historySchemaHealth
  });
  const recentAttempts = latestItems(timeline.attempts, (attempt) => attempt.started_at, 5).map((attempt) => ({
    attempt_id: attempt.attempt_id,
    attempt_number: attempt.attempt_number,
    status: attempt.status,
    started_at: attempt.started_at,
    ended_at: attempt.ended_at,
    reason_code: attempt.reason_code,
    reason_detail: attempt.reason_detail
  }));
  const recentPhases = latestItems(timeline.phase_spans, (phase) => phase.started_at, 8).map((phase) => ({
    phase: phase.phase,
    status: phase.status,
    started_at: phase.started_at,
    ended_at: phase.ended_at,
    reason_code: phase.reason_code,
    reason_detail: phase.reason_detail
  }));
  const recentBlockers = latestItems(timeline.blockers, (blocker) => blocker.blocked_at, 5).map((blocker) => ({
    blocker_type: blocker.blocker_type,
    status: blocker.status,
    reason_code: blocker.reason_code,
    reason_detail: blocker.reason_detail,
    blocked_at: blocker.blocked_at,
    resolved_at: blocker.resolved_at
  }));
  const recentTokenFacts = latestItems(timeline.token_model_facts, (fact) => fact.observed_at, 5);
  const providerGroups = groupProviderFacts(timeline.token_model_facts);
  const recentAppServerEvents = latestItems(timeline.app_server_events, (event) => event.observed_at, 5);
  const appServerPolicy = classifyAppServerLitePolicy(recentAppServerEvents);
  const appServerExcerpts = recentAppServerEvents.map((event) => ({
    source_event_id: event.source_event_id,
    source_event_name: event.source_event_name,
    observed_at: event.observed_at,
    payload_class: event.payload_class,
    detail_status: event.detail_status,
    redaction_status: event.redaction_status,
    summary: event.summary,
    summary_fields: event.summary_fields,
    redacted_excerpt: event.redacted_excerpt,
    unavailable_reason_code: event.unavailable_reason_code,
    truncated: event.truncation.truncated,
    full_payload_stored: event.full_payload_stored
  }));

  return {
    schema_version: 'symphony.project_history.consumer_summary.v1',
    read_only: true,
    deferred_capabilities: ['validation_reuse', 'phase_handoff_packets', 'drain_mode', 'operator_steering'],
    health,
    project_identity: row.project_identity,
    ticket_identity: row.ticket_identity,
    current_ticket_state: {
      state: row.state,
      current_status: row.current_status,
      last_known_status: row.last_known_status,
      latest_observed_at: row.latest_observed_at,
      facts: row.facts
    },
    attempts: {
      total: row.summary.attempt_count,
      repeated: row.summary.attempt_count > 1,
      latest: row.latest_attempt,
      recent: recentAttempts
    },
    recent_phases: recentPhases,
    blockers: {
      active_count: row.summary.active_blocker_count,
      resolved_count: row.summary.resolved_blocker_count,
      recent: recentBlockers
    },
    token_model: {
      status: timeline.token_model_facts.length > 0 ? 'present' : 'missing',
      total_tokens: row.summary.total_tokens,
      requested_models: uniqueStrings(timeline.token_model_facts.map((fact) => fact.requested_model)),
      effective_models: uniqueStrings(timeline.token_model_facts.map((fact) => fact.effective_model)),
      telemetry_confidences: uniqueStrings(timeline.token_model_facts.map((fact) => fact.telemetry_confidence)),
      runtime_providers: uniqueStrings(timeline.token_model_facts.map((fact) => fact.runtime_provider ?? null)),
      provider_turn_count: sumNullable(timeline.token_model_facts.map((fact) => fact.provider_turn_count ?? null)),
      estimated_cost_usd: sumNullable(timeline.token_model_facts.map((fact) => fact.estimated_cost_usd ?? null)),
      by_runtime_and_model: providerGroups,
      recent: recentTokenFacts.map((fact) => ({
        requested_model: fact.requested_model,
        effective_model: fact.effective_model,
        model_source: fact.model_source,
        input_tokens: fact.input_tokens,
        output_tokens: fact.output_tokens,
        cached_input_tokens: fact.cached_input_tokens,
        reasoning_output_tokens: fact.reasoning_output_tokens,
        total_tokens: fact.total_tokens,
        model_context_window: fact.model_context_window,
        runtime_provider: fact.runtime_provider ?? null,
        provider_turn_count: fact.provider_turn_count ?? null,
        estimated_cost_usd: fact.estimated_cost_usd ?? null,
        telemetry_confidence: fact.telemetry_confidence,
        observed_at: fact.observed_at
      }))
    },
    app_server_lite: {
      status:
        appServerExcerpts.length === 0
          ? 'missing'
          : appServerPolicy.degradedEventCount > 0
            ? 'degraded'
            : 'present',
      excerpts: appServerExcerpts
    },
    evidence_references: latestItems(timeline.evidence_references, (evidence) => evidence.recorded_at, 5).map((evidence) => ({
      evidence_kind: evidence.evidence_kind,
      uri: evidence.uri,
      title: evidence.title,
      recorded_at: evidence.recorded_at,
      metadata: evidence.metadata
    }))
  };
}

export function buildProjectHistoryHealth(params: {
  persistenceHealth?: PersistenceHealth | null;
  timelines?: TicketTimelineRecord[];
  summaries?: ProjectHistoryTicketSummaryProjection[];
  ticketCount?: number | null;
  projectionAvailable?: boolean;
  projectionFailureReasonCode?: string | null;
  projectionFailureDetail?: string | null;
  historySchemaHealth?: HistorySchemaHealth | null;
}): ProjectHistoryHealth {
  const persistenceHealth = params.persistenceHealth ?? null;
  const summaries = params.summaries ?? params.timelines?.map((timeline) => buildProjectHistoryTicketSummary(timeline)) ?? [];
  const historySchema = params.historySchemaHealth ?? persistenceHealth?.history_schema ?? null;
  const recentFailures = persistenceHealth?.recent_write_failures ?? [];
  const appServerPolicy = aggregateAppServerLiteSummaries(summaries.map((summary) => summary.app_server_lite));
  const expectedAppServerUnavailableReasons = new Set(
    appServerPolicy.unavailableReasons
      .filter((reason) => reason.classification === 'expected_policy')
      .map((reason) => reason.reason_code)
  );
  const projectionFacts = summaries.flatMap((summary) => summaryFacts(summary, historySchema));
  const projectionDegradedFact = projectionFacts.find(
    (fact) =>
      (fact.status === 'degraded' || fact.status === 'unavailable') &&
      !isExpectedAppServerPayloadPolicyFact(fact, expectedAppServerUnavailableReasons)
  );
  const projectionMissingFact = projectionFacts.find((fact) => fact.status === 'missing');
  const projectionReason =
    params.projectionFailureReasonCode ?? projectionDegradedFact?.reason_code ?? projectionMissingFact?.reason_code ?? null;
  const projectionDetail = params.projectionFailureDetail ?? projectionDegradedFact?.detail ?? null;
  const projectionAvailable = params.projectionAvailable ?? true;
  const projectionStatus: ProjectHistoryHealth['projections']['status'] = !projectionAvailable
    ? 'unavailable'
    : projectionReason
      ? 'degraded'
      : 'healthy';
  const appServerEventCount = summaries.reduce((sum, summary) => sum + summary.summary.app_server_event_count, 0);
  const appServerStatus: ProjectHistoryHealth['app_server_lite']['status'] =
    appServerEventCount === 0
      ? 'missing'
      : appServerPolicy.degradedEventCount > 0
        ? 'degraded'
        : 'healthy';
  const schemaStatus = historySchema?.status ?? (persistenceHealth?.enabled === false ? 'unavailable' : 'unavailable');
  const pruneStatus: ProjectHistoryHealth['retention']['last_prune']['status'] = persistenceHealth?.last_prune_failure_at
    ? 'failed'
    : persistenceHealth?.last_pruned_at
      ? 'succeeded'
      : 'never_run';
  const disabled = persistenceHealth?.enabled === false;
  const degraded =
    !disabled &&
    (!persistenceHealth ||
      persistenceHealth.integrity_ok === false ||
      schemaStatus === 'degraded' ||
      recentFailures.length > 0 ||
      pruneStatus === 'failed' ||
      projectionStatus !== 'healthy' ||
      appServerStatus === 'degraded');
  const diagnostics: ProjectHistoryFactState[] = [
    ...historyHealthFacts(historySchema),
    {
      fact: 'history_persistence',
      status: disabled ? 'unavailable' : persistenceHealth ? 'present' : 'unavailable',
      reason_code: disabled ? 'project_history_persistence_disabled' : persistenceHealth ? null : 'project_history_health_unavailable',
      detail: null
    },
    {
      fact: 'history_writes',
      status: recentFailures.length > 0 ? 'degraded' : 'present',
      reason_code: recentFailures.length > 0 ? recentFailures[0]?.reason_code ?? 'history_write_failed' : null,
      detail: recentFailures.length > 0 ? recentFailures[0]?.operation ?? null : null
    },
    {
      fact: 'history_retention',
      status: pruneStatus === 'failed' ? 'degraded' : 'present',
      reason_code: pruneStatus === 'failed' ? persistenceHealth?.last_prune_failure_reason ?? 'retention_prune_failed' : null,
      detail: pruneStatus === 'failed' ? persistenceHealth?.last_prune_failure_detail ?? null : null
    },
    {
      fact: 'history_projection',
      status: projectionStatus === 'healthy' ? 'present' : projectionStatus,
      reason_code: projectionReason,
      detail: projectionDetail
    },
    ...projectionFacts.filter((fact) => fact.fact !== 'history_schema'),
    {
      fact: 'app_server_lite_health',
      status:
        appServerStatus === 'healthy'
          ? 'present'
          : appServerStatus === 'missing'
            ? 'optional_unavailable'
            : 'degraded',
      reason_code:
        appServerStatus === 'missing'
          ? REASON_CODES.projectHistoryAppServerLiteSummariesMissing
          : appServerStatus === 'degraded'
            ? REASON_CODES.projectHistoryAppServerLiteDegraded
            : null,
      detail:
        appServerStatus === 'missing'
          ? null
          : `redacted=${appServerPolicy.redactedEventCount} truncated=${appServerPolicy.truncatedEventCount} summary_only=${appServerPolicy.summaryOnlyEventCount} unavailable=${appServerPolicy.unavailableEventCount} full_payload_stored=${appServerPolicy.fullPayloadStoredCount} degraded=${appServerPolicy.degradedEventCount}`
    },
    ...appServerLitePolicyFacts(appServerPolicy).filter((fact) => fact.fact === 'app_server_lite_payload')
  ];

  return {
    status: disabled ? 'disabled' : degraded ? 'degraded' : 'healthy',
    enabled: persistenceHealth?.enabled ?? false,
    storage: {
      type: persistenceHealth?.enabled === false ? 'disabled' : 'sqlite',
      target: persistenceHealth?.db_path ?? null
    },
    schema: {
      status: schemaStatus,
      integrity_ok: persistenceHealth?.integrity_ok ?? false,
      target_version: historySchema?.target_version ?? null,
      applied_version: historySchema?.applied_version ?? null,
      reason_code: historySchema?.degraded_reason_code ?? null,
      detail: historySchema?.degraded_detail ?? null
    },
    counts: {
      runs: persistenceHealth?.run_count ?? 0,
      tickets: params.ticketCount ?? persistenceHealth?.ticket_count ?? null
    },
    retention: {
      retention_days: persistenceHealth?.retention_days ?? null,
      last_prune: {
        status: pruneStatus,
        last_pruned_at: persistenceHealth?.last_pruned_at ?? null,
        failure_at: persistenceHealth?.last_prune_failure_at ?? null,
        failure_reason_code: persistenceHealth?.last_prune_failure_reason ?? null,
        failure_detail: persistenceHealth?.last_prune_failure_detail ?? null
      }
    },
    writes: {
      status: recentFailures.length > 0 ? 'degraded' : 'healthy',
      recent_failures: recentFailures
    },
    projections: {
      status: projectionStatus,
      reason_code: projectionReason,
      detail: projectionDetail
    },
    app_server_lite: {
      status: appServerStatus,
      redacted_event_count: appServerPolicy.redactedEventCount,
      truncated_event_count: appServerPolicy.truncatedEventCount,
      summary_only_event_count: appServerPolicy.summaryOnlyEventCount,
      unavailable_event_count: appServerPolicy.unavailableEventCount,
      full_payload_stored_count: appServerPolicy.fullPayloadStoredCount,
      degraded_event_count: appServerPolicy.degradedEventCount,
      unavailable_reasons: appServerPolicy.unavailableReasons
    },
    diagnostics
  };
}

function classifyAppServerLitePolicy(events: AppServerEventLedgerExcerpt[]): {
  redactedEventCount: number;
  truncatedEventCount: number;
  summaryOnlyEventCount: number;
  unavailableEventCount: number;
  fullPayloadStoredCount: number;
  degradedEventCount: number;
  unavailableReasons: ProjectHistoryHealth['app_server_lite']['unavailable_reasons'];
} {
  const unavailableReasons = new Map<string, { count: number; classification: 'expected_policy' | 'failure' }>();
  let redactedEventCount = 0;
  let truncatedEventCount = 0;
  let summaryOnlyEventCount = 0;
  let unavailableEventCount = 0;
  let fullPayloadStoredCount = 0;
  let degradedEventCount = 0;

  for (const event of events) {
    if (event.redaction_status === 'redacted') {
      redactedEventCount += 1;
    }
    if (event.truncation.truncated) {
      truncatedEventCount += 1;
    }
    if (event.detail_status === 'summary_only') {
      summaryOnlyEventCount += 1;
    }
    if (event.full_payload_stored) {
      fullPayloadStoredCount += 1;
    }

    const unavailableClassification = classifyUnavailablePolicy(event);
    if (event.unavailable_reason_code) {
      unavailableEventCount += 1;
      const existing = unavailableReasons.get(event.unavailable_reason_code);
      unavailableReasons.set(event.unavailable_reason_code, {
        count: (existing?.count ?? 0) + 1,
        classification:
          existing?.classification === 'failure' || unavailableClassification === 'failure'
            ? 'failure'
            : unavailableClassification
      });
    }

    if (event.full_payload_stored || unavailableClassification === 'failure' || hasMalformedPayloadPolicyMetadata(event)) {
      degradedEventCount += 1;
    }
  }

  return {
    redactedEventCount,
    truncatedEventCount,
    summaryOnlyEventCount,
    unavailableEventCount,
    fullPayloadStoredCount,
    degradedEventCount,
    unavailableReasons: [...unavailableReasons.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason_code, value]) => ({ reason_code, ...value }))
  };
}

function toAppServerLiteSummary(policy: ReturnType<typeof classifyAppServerLitePolicy>): ProjectHistoryAppServerLiteSummary {
  return {
    redacted_event_count: policy.redactedEventCount,
    truncated_event_count: policy.truncatedEventCount,
    summary_only_event_count: policy.summaryOnlyEventCount,
    unavailable_event_count: policy.unavailableEventCount,
    full_payload_stored_count: policy.fullPayloadStoredCount,
    degraded_event_count: policy.degradedEventCount,
    unavailable_reasons: policy.unavailableReasons
  };
}

function normalizeAppServerLiteSummary(summary: ProjectHistoryAppServerLiteSummary): ReturnType<typeof classifyAppServerLitePolicy> {
  return {
    redactedEventCount: summary.redacted_event_count,
    truncatedEventCount: summary.truncated_event_count,
    summaryOnlyEventCount: summary.summary_only_event_count,
    unavailableEventCount: summary.unavailable_event_count,
    fullPayloadStoredCount: summary.full_payload_stored_count,
    degradedEventCount: summary.degraded_event_count,
    unavailableReasons: summary.unavailable_reasons
  };
}

function aggregateAppServerLiteSummaries(summaries: ProjectHistoryAppServerLiteSummary[]): ReturnType<typeof classifyAppServerLitePolicy> {
  const unavailableReasons = new Map<string, { count: number; classification: 'expected_policy' | 'failure' }>();
  const aggregate = {
    redactedEventCount: 0,
    truncatedEventCount: 0,
    summaryOnlyEventCount: 0,
    unavailableEventCount: 0,
    fullPayloadStoredCount: 0,
    degradedEventCount: 0,
    unavailableReasons: [] as ProjectHistoryHealth['app_server_lite']['unavailable_reasons']
  };

  for (const summary of summaries) {
    aggregate.redactedEventCount += summary.redacted_event_count;
    aggregate.truncatedEventCount += summary.truncated_event_count;
    aggregate.summaryOnlyEventCount += summary.summary_only_event_count;
    aggregate.unavailableEventCount += summary.unavailable_event_count;
    aggregate.fullPayloadStoredCount += summary.full_payload_stored_count;
    aggregate.degradedEventCount += summary.degraded_event_count;
    for (const reason of summary.unavailable_reasons) {
      const existing = unavailableReasons.get(reason.reason_code);
      unavailableReasons.set(reason.reason_code, {
        count: (existing?.count ?? 0) + reason.count,
        classification:
          existing?.classification === 'failure' || reason.classification === 'failure'
            ? 'failure'
            : reason.classification
      });
    }
  }

  aggregate.unavailableReasons = [...unavailableReasons.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason_code, value]) => ({ reason_code, ...value }));
  return aggregate;
}

function appServerLitePolicyFacts(policy: ReturnType<typeof classifyAppServerLitePolicy>): ProjectHistoryFactState[] {
  const facts: ProjectHistoryFactState[] = [];
  if (
    policy.redactedEventCount === 0 &&
    policy.truncatedEventCount === 0 &&
    policy.summaryOnlyEventCount === 0 &&
    policy.unavailableEventCount === 0 &&
    policy.fullPayloadStoredCount === 0
  ) {
    return [
      {
        fact: 'app_server_lite_summaries',
        status: 'optional_unavailable',
        reason_code: REASON_CODES.projectHistoryAppServerLiteSummariesMissing,
        detail: null
      }
    ];
  }

  facts.push({ fact: 'app_server_lite_summaries', status: 'present', reason_code: null, detail: null });
  if (policy.redactedEventCount > 0) {
    facts.push({
      fact: 'app_server_lite_payload',
      status: 'redacted',
      reason_code: REASON_CODES.projectHistoryPayloadRedacted,
      detail: `${policy.redactedEventCount} app-server event payload(s) were redacted`
    });
  }
  if (policy.truncatedEventCount > 0) {
    facts.push({
      fact: 'app_server_lite_payload',
      status: 'truncated',
      reason_code: REASON_CODES.projectHistoryPayloadTruncated,
      detail: `${policy.truncatedEventCount} app-server event payload excerpt(s) were truncated`
    });
  }
  for (const reason of policy.unavailableReasons) {
    facts.push({
      fact: 'app_server_lite_payload',
      status: 'unavailable',
      reason_code: reason.reason_code,
      detail: `${reason.count} app-server event payload(s) unavailable`
    });
  }
  if (policy.fullPayloadStoredCount > 0 || policy.degradedEventCount > 0) {
    facts.push({
      fact: 'app_server_lite_payload',
      status: 'degraded',
      reason_code: REASON_CODES.projectHistoryAppServerLiteDegraded,
      detail: `${policy.degradedEventCount} app-server event payload policy issue(s) detected`
    });
  }
  return facts;
}

function classifyUnavailablePolicy(event: AppServerEventLedgerExcerpt): 'expected_policy' | 'failure' {
  if (!event.unavailable_reason_code) {
    return 'expected_policy';
  }
  return event.detail_status === 'unavailable_policy' && event.redaction_status === 'unavailable_policy' ? 'expected_policy' : 'failure';
}

function hasMalformedPayloadPolicyMetadata(event: AppServerEventLedgerExcerpt): boolean {
  if (!Number.isFinite(event.policy_version) || event.policy_version < 1) {
    return true;
  }
  if (event.detail_status === 'unavailable_policy') {
    return event.redaction_status !== 'unavailable_policy' || !event.unavailable_reason_code;
  }
  if (event.detail_status === 'unavailable_source') {
    return event.redaction_status !== 'unavailable_source' || !event.unavailable_reason_code;
  }
  if (event.unavailable_reason_code) {
    return true;
  }
  return false;
}

function isExpectedAppServerPayloadPolicyFact(fact: ProjectHistoryFactState, expectedUnavailableReasons: Set<string>): boolean {
  if (fact.fact !== 'app_server_lite_payload') {
    return false;
  }
  if (fact.status === 'redacted' || fact.status === 'truncated') {
    return true;
  }
  return fact.status === 'unavailable' && fact.reason_code !== null && expectedUnavailableReasons.has(fact.reason_code);
}

function buildProjectHistoryTicketRow(
  timeline: TicketTimelineRecord,
  historySchemaHealth?: HistorySchemaHealth | null
): ProjectHistoryTicketRow {
  return buildProjectHistoryTicketRowFromSummary(buildProjectHistoryTicketSummary(timeline), historySchemaHealth);
}

function buildProjectHistoryTicketRowFromSummary(
  summary: ProjectHistoryTicketSummaryProjection,
  historySchemaHealth?: HistorySchemaHealth | null
): ProjectHistoryTicketRow {
  return {
    project_identity: summary.identity.project,
    ticket_identity: summary.identity.ticket,
    state: summary.state,
    current_status: summary.current_status,
    last_known_status: summary.last_known_status,
    latest_attempt: summary.latest_attempt,
    summary: summary.summary,
    facts: summaryFacts(summary, historySchemaHealth),
    latest_observed_at: summary.latest_observed_at
  };
}

function buildProjectHistoryTicketSummary(timeline: TicketTimelineRecord): ProjectHistoryTicketSummaryProjection {
  const latestIssueRun = latestBy(timeline.issue_runs, (run) => run.started_at);
  const latestAttempt = latestBy(timeline.attempts, (attempt) => attempt.started_at);
  const latestOutcome = latestBy(timeline.terminal_outcomes, (outcome) => outcome.recorded_at);
  const latestTrackerSnapshot = latestBy(timeline.tracker_snapshots, (snapshot) => snapshot.last_observed_at);
  const latestTransition = latestBy(timeline.state_transitions, (transition) => transition.transitioned_at);
  const lastKnownStatus = latestTrackerSnapshot?.tracker_status ?? latestTransition?.to_status ?? latestIssueRun?.status ?? 'unknown';
  return {
    identity: timeline.identity,
    state: isTimelineActive(latestIssueRun) ? 'active' : 'completed',
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
    summary: {
      issue_run_count: timeline.issue_runs.length,
      attempt_count: timeline.attempts.length,
      thread_count: timeline.threads.length,
      turn_count: timeline.turns.length,
      phase_count: timeline.phase_spans.length,
      state_transition_count: timeline.state_transitions.length,
      active_blocker_count: timeline.blockers.filter((blocker) => blocker.status === 'active').length,
      resolved_blocker_count: timeline.blockers.filter((blocker) => blocker.status === 'resolved').length,
      evidence_reference_count: timeline.evidence_references.length,
      tracker_snapshot_count: timeline.tracker_snapshots.length,
      ticket_reference_count: timeline.ticket_references.length,
      operator_action_count: timeline.operator_actions.length,
      drain_audit_event_count: timeline.drain_audit_events.length,
      blocked_input_event_count: timeline.blocked_input_events.length,
      app_server_event_count: timeline.app_server_events.length,
      token_model_fact_count: timeline.token_model_facts.length,
      total_tokens: sumNullable(timeline.token_model_facts.map((fact) => fact.total_tokens))
    },
    app_server_lite: toAppServerLiteSummary(classifyAppServerLitePolicy(timeline.app_server_events)),
    latest_observed_at: maxTimestamp([
      latestIssueRun?.started_at ?? null,
      latestAttempt?.started_at ?? null,
      latestOutcome?.recorded_at ?? null,
      latestTrackerSnapshot?.last_observed_at ?? null,
      latestTransition?.transitioned_at ?? null,
      latestBy(timeline.drain_audit_events, (event) => event.observed_at)?.observed_at ?? null,
      latestBy(timeline.app_server_events, (event) => event.observed_at)?.observed_at ?? null
    ])
  };
}

function isTimelineActive(latestIssueRun: IssueRunRecord | null): boolean {
  if (!latestIssueRun) {
    return false;
  }
  return latestIssueRun.ended_at === null || ['pending', 'running', 'retrying', 'blocked'].includes(latestIssueRun.status);
}

function summaryFacts(
  summary: ProjectHistoryTicketSummaryProjection,
  historySchemaHealth?: HistorySchemaHealth | null
): ProjectHistoryFactState[] {
  const active = summary.state === 'active';
  return [
    ...historyHealthFacts(historySchemaHealth),
    presenceFact('tracker_snapshot', summary.summary.tracker_snapshot_count, REASON_CODES.projectHistoryTrackerSnapshotMissing),
    terminalOutcomeFact(summary.latest_attempt.outcome ? 1 : 0, active),
    presenceFact(
      'thread_turn_references',
      summary.summary.thread_count + summary.summary.turn_count,
      REASON_CODES.projectHistoryThreadTurnReferencesMissing
    ),
    presenceFact('evidence_references', summary.summary.evidence_reference_count, REASON_CODES.projectHistoryEvidenceReferencesMissing),
    presenceFact(
      'tracker_pr_operator_facts',
      summary.summary.tracker_snapshot_count + summary.summary.ticket_reference_count + summary.summary.operator_action_count,
      REASON_CODES.projectHistoryOperationalFactsMissing
    ),
    optionalFact('drain_audit_events', summary.summary.drain_audit_event_count, 'project_history_drain_audit_events_missing'),
    optionalFact('token_model_summaries', summary.summary.token_model_fact_count, REASON_CODES.projectHistoryTokenModelSummariesMissing),
    ...appServerLitePolicyFacts(normalizeAppServerLiteSummary(summary.app_server_lite))
  ];
}

function timelineFacts(timeline: TicketTimelineRecord, historySchemaHealth?: HistorySchemaHealth | null): ProjectHistoryFactState[] {
  return summaryFacts(buildProjectHistoryTicketSummary(timeline), historySchemaHealth);
}

function historyHealthFacts(historySchemaHealth?: HistorySchemaHealth | null): ProjectHistoryFactState[] {
  if (!historySchemaHealth) {
    return [
      {
        fact: 'history_schema',
        status: 'unavailable',
        reason_code: REASON_CODES.projectHistorySchemaHealthUnavailable,
        detail: null
      }
    ];
  }
  if (historySchemaHealth.status === 'degraded') {
    return [
      {
        fact: 'history_schema',
        status: 'degraded',
        reason_code: historySchemaHealth.degraded_reason_code,
        detail: historySchemaHealth.degraded_detail
      }
    ];
  }
  return [{ fact: 'history_schema', status: 'present', reason_code: null, detail: null }];
}

function presenceFact(fact: string, count: number, missingReasonCode: string): ProjectHistoryFactState {
  return count > 0
    ? { fact, status: 'present', reason_code: null, detail: null }
    : { fact, status: 'missing', reason_code: missingReasonCode, detail: null };
}

function terminalOutcomeFact(count: number, active: boolean): ProjectHistoryFactState {
  if (count > 0) {
    return { fact: 'terminal_outcome', status: 'present', reason_code: null, detail: null };
  }
  return {
    fact: 'terminal_outcome',
    status: active ? 'lifecycle_pending' : 'missing',
    reason_code: REASON_CODES.projectHistoryTerminalOutcomeMissing,
    detail: active ? 'Terminal outcome is expected after the active ticket reaches a terminal lifecycle state.' : null
  };
}

function optionalFact(fact: string, count: number, unavailableReasonCode: string): ProjectHistoryFactState {
  return count > 0
    ? { fact, status: 'present', reason_code: null, detail: null }
    : { fact, status: 'optional_unavailable', reason_code: unavailableReasonCode, detail: null };
}

function appServerFactStates(events: AppServerEventLedgerExcerpt[]): ProjectHistoryFactState[] {
  if (events.length === 0) {
    return [
      {
        fact: 'app_server_lite_summaries',
        status: 'optional_unavailable',
        reason_code: REASON_CODES.projectHistoryAppServerLiteSummariesMissing,
        detail: null
      }
    ];
  }
  const states: ProjectHistoryFactState[] = [{ fact: 'app_server_lite_summaries', status: 'present', reason_code: null, detail: null }];
  if (events.some((event) => event.redaction_status === 'redacted')) {
    states.push({ fact: 'app_server_lite_payload', status: 'redacted', reason_code: REASON_CODES.projectHistoryPayloadRedacted, detail: null });
  }
  if (events.some((event) => event.truncation.truncated)) {
    states.push({ fact: 'app_server_lite_payload', status: 'truncated', reason_code: REASON_CODES.projectHistoryPayloadTruncated, detail: null });
  }
  const unavailable = events.find((event) => event.unavailable_reason_code);
  if (unavailable) {
    states.push({
      fact: 'app_server_lite_payload',
      status: 'unavailable',
      reason_code: unavailable.unavailable_reason_code,
      detail: unavailable.source_event_name
    });
  }
  return states;
}

function latestBy<T>(items: T[], timestamp: (item: T) => string | null): T | null {
  return items.reduce<T | null>((latest, item) => {
    const itemTimestamp = timestamp(item);
    const latestTimestamp = latest ? timestamp(latest) : null;
    if (!itemTimestamp) {
      return latest;
    }
    return !latestTimestamp || itemTimestamp > latestTimestamp ? item : latest;
  }, null);
}

function latestItems<T>(items: T[], timestamp: (item: T) => string | null, limit: number): T[] {
  return [...items]
    .filter((item) => timestamp(item) !== null)
    .sort((a, b) => String(timestamp(b)).localeCompare(String(timestamp(a))))
    .slice(0, limit);
}

function maxTimestamp(values: Array<string | null>): string | null {
  return values.filter((value): value is string => value !== null).sort().at(-1) ?? null;
}

function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  if (present.length === 0) {
    return null;
  }
  return present.reduce((sum, value) => sum + value, 0);
}

function groupProviderFacts(facts: TicketTimelineRecord['token_model_facts']): ProjectHistoryConsumerSummaryResponse['token_model']['by_runtime_and_model'] {
  const groups = new Map<string, ProjectHistoryConsumerSummaryResponse['token_model']['by_runtime_and_model'][number] & {
    token_values: Array<number | null>;
    turn_values: Array<number | null>;
    cost_values: Array<number | null>;
  }>();
  for (const fact of facts) {
    const runtimeProvider = fact.runtime_provider ?? 'codex-app-server';
    const effectiveModel = fact.effective_model ?? 'unknown';
    const key = `${runtimeProvider}\u0000${effectiveModel}`;
    const group = groups.get(key) ?? {
      runtime_provider: runtimeProvider,
      effective_model: effectiveModel,
      fact_count: 0,
      total_tokens: null,
      provider_turn_count: null,
      estimated_cost_usd: null,
      token_values: [],
      turn_values: [],
      cost_values: []
    };
    group.fact_count += 1;
    group.token_values.push(fact.total_tokens);
    group.turn_values.push(fact.provider_turn_count ?? null);
    group.cost_values.push(fact.estimated_cost_usd ?? null);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ token_values, turn_values, cost_values, ...group }) => ({
      ...group,
      total_tokens: sumNullable(token_values),
      provider_turn_count: sumNullable(turn_values),
      estimated_cost_usd: sumNullable(cost_values)
    }))
    .sort((a, b) => `${a.runtime_provider}/${a.effective_model}`.localeCompare(`${b.runtime_provider}/${b.effective_model}`));
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))].sort();
}
