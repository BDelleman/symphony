import type { RunningEntry, TranscriptToolCallDiagnosticStats } from '../../orchestrator';
import type { ApiDiagnosticPageMetadata, ApiTranscriptToolCallDiagnosticSummary } from '../types';
import { asIsoDate } from './time';

export function projectMissingToolOutput(
  entry: { tool_output_wait?: import('../../orchestrator').BlockedEntry['tool_output_wait'] }
) {
  return entry.tool_output_wait
    ? {
        ...entry.tool_output_wait,
        recommended_actions: [...entry.tool_output_wait.recommended_actions]
      }
    : null;
}

export function projectToolCallLedger(entry: { tool_call_ledger?: RunningEntry['tool_call_ledger'] }) {
  return Object.values(entry.tool_call_ledger ?? {})
    .sort((left, right) => left.first_seen_at_ms - right.first_seen_at_ms || left.call_id.localeCompare(right.call_id))
    .map((call) => ({
      call_id: call.call_id,
      tool_name: call.tool_name,
      thread_id: call.thread_id,
      turn_id: call.turn_id,
      session_id: call.session_id,
      issue_id: call.issue_id,
      issue_identifier: call.issue_identifier,
      run_id: call.run_id,
      issue_run_id: call.issue_run_id,
      attempt_id: call.attempt_id,
      first_seen_at: asIsoDate(call.first_seen_at_ms),
      first_seen_at_ms: call.first_seen_at_ms,
      last_seen_at: asIsoDate(call.last_seen_at_ms),
      last_seen_at_ms: call.last_seen_at_ms,
      completed_at: call.completed_at_ms === null ? null : asIsoDate(call.completed_at_ms),
      completed_at_ms: call.completed_at_ms,
      duration_ms: call.completed_at_ms === null ? null : Math.max(0, call.completed_at_ms - call.first_seen_at_ms),
      completion_status: call.completion_status,
      evidence_sources: [...call.evidence_sources],
      start_evidence_source: call.start_evidence_source,
      completion_evidence_source: call.completion_evidence_source,
      last_agent_message: call.last_agent_message
    }));
}

export function projectTranscriptToolCallDiagnostics(entry: {
  transcript_tool_call_diagnostics?: import('../../orchestrator').TranscriptToolCallDiagnostic[];
}) {
  return (entry.transcript_tool_call_diagnostics ?? []).map((diagnostic) => ({
    kind: diagnostic.kind,
    call_id: diagnostic.call_id,
    tool_name: diagnostic.tool_name,
    thread_id: diagnostic.thread_id,
    turn_id: diagnostic.turn_id,
    session_id: diagnostic.session_id,
    issue_id: diagnostic.issue_id,
    issue_identifier: diagnostic.issue_identifier,
    run_id: diagnostic.run_id,
    issue_run_id: diagnostic.issue_run_id,
    attempt_id: diagnostic.attempt_id,
    codex_app_server_pid: diagnostic.codex_app_server_pid,
    observed_at: asIsoDate(diagnostic.observed_at_ms),
    observed_at_ms: diagnostic.observed_at_ms,
    lineage: diagnostic.lineage,
    reason: diagnostic.reason,
    active_issue_id: diagnostic.active_issue_id,
    active_issue_identifier: diagnostic.active_issue_identifier,
    active_run_id: diagnostic.active_run_id,
    active_issue_run_id: diagnostic.active_issue_run_id,
    active_attempt_id: diagnostic.active_attempt_id,
    active_codex_app_server_pid: diagnostic.active_codex_app_server_pid,
    active_thread_id: diagnostic.active_thread_id,
    active_turn_id: diagnostic.active_turn_id,
    active_session_id: diagnostic.active_session_id
  }));
}

export function projectTranscriptToolCallDiagnosticSummary(entry: {
  transcript_tool_call_diagnostics?: import('../../orchestrator').TranscriptToolCallDiagnostic[];
  transcript_tool_call_diagnostic_stats?: TranscriptToolCallDiagnosticStats;
  tool_call_ledger?: RunningEntry['tool_call_ledger'];
  tool_output_wait?: import('../../orchestrator').BlockedEntry['tool_output_wait'];
  recovery?: import('../../orchestrator').MissingToolOutputRecoveryState | null;
  identifier?: string;
  issue_identifier?: string;
}): ApiTranscriptToolCallDiagnosticSummary {
  const diagnostics = entry.transcript_tool_call_diagnostics ?? [];
  const stats = entry.transcript_tool_call_diagnostic_stats;
  const countsByLineage: ApiTranscriptToolCallDiagnosticSummary['counts_by_lineage'] = stats
    ? { ...stats.counts_by_lineage }
    : {
        active_owned: 0,
        prior_stale: 0,
        external_manual: 0,
        unattributed: 0
      };
  const countsByKind: ApiTranscriptToolCallDiagnosticSummary['counts_by_kind'] = stats
    ? { ...stats.counts_by_kind }
    : {
        function_call: 0,
        function_call_output: 0
      };
  let newestObservedAtMs: number | null = stats?.newest_observed_at_ms ?? null;

  if (!stats) {
    for (const diagnostic of diagnostics) {
      countsByLineage[diagnostic.lineage] += 1;
      countsByKind[diagnostic.kind] += 1;
      newestObservedAtMs =
        newestObservedAtMs === null ? diagnostic.observed_at_ms : Math.max(newestObservedAtMs, diagnostic.observed_at_ms);
    }
  }

  const activeMissingToolOutput = entry.tool_output_wait ?? null;
  const recovery = entry.recovery ?? null;
  const ledgerRecords = projectToolCallLedger(entry);
  for (const ledgerRecord of ledgerRecords) {
    newestObservedAtMs =
      newestObservedAtMs === null
        ? ledgerRecord.last_seen_at_ms
        : Math.max(newestObservedAtMs, ledgerRecord.last_seen_at_ms);
  }
  const detailAvailable =
    (stats?.total_count ?? diagnostics.length) > 0 || ledgerRecords.length > 0 || Boolean(activeMissingToolOutput) || Boolean(recovery);
  return {
    detailed_diagnostics_available: detailAvailable,
    total_count: stats?.total_count ?? diagnostics.length,
    detail_url:
      detailAvailable
        ? `/api/v1/issues/${encodeURIComponent(entry.issue_identifier ?? entry.identifier ?? '')}/diagnostics`
        : null,
    newest_observed_at: newestObservedAtMs === null ? null : asIsoDate(newestObservedAtMs),
    newest_observed_at_ms: newestObservedAtMs,
    counts_by_lineage: countsByLineage,
    counts_by_kind: countsByKind,
    active_missing_tool_output: {
      active: Boolean(activeMissingToolOutput),
      tool_name: activeMissingToolOutput?.tool_name ?? null,
      call_id: activeMissingToolOutput?.call_id ?? null,
      thread_id: activeMissingToolOutput?.thread_id ?? null,
      turn_id: activeMissingToolOutput?.turn_id ?? null,
      session_id: activeMissingToolOutput?.session_id ?? null,
      evidence_source: activeMissingToolOutput?.evidence_source ?? null
    },
    recovery: {
      active: Boolean(recovery),
      status: recovery?.last_result ?? null,
      attempt_count: recovery?.attempt_count ?? 0,
      last_result_reason_code: recovery?.last_result_reason_code ?? null,
      previous_thread_id: recovery?.previous_thread_id ?? null,
      replacement_thread_id: recovery?.replacement_thread_id ?? null
    }
  };
}

export interface RuntimeDiagnosticPageOptions {
  limit?: number;
  offset?: number;
}

export function normalizeDiagnosticPageOptions(options: RuntimeDiagnosticPageOptions = {}): Required<RuntimeDiagnosticPageOptions> {
  const parsedLimit = typeof options.limit === 'number' && Number.isFinite(options.limit) ? Math.floor(options.limit) : 50;
  const parsedOffset = typeof options.offset === 'number' && Number.isFinite(options.offset) ? Math.floor(options.offset) : 0;
  return {
    limit: Math.min(200, Math.max(1, parsedLimit)),
    offset: Math.max(0, parsedOffset)
  };
}

export function buildPageMetadata<T>(
  records: T[],
  included: T[],
  options: Required<RuntimeDiagnosticPageOptions>,
  observedAtMs: (record: T) => number
): ApiDiagnosticPageMetadata {
  const includedTimestamps = included.map(observedAtMs).filter((timestamp) => Number.isFinite(timestamp));
  const oldestObservedAtMs = includedTimestamps.length > 0 ? Math.min(...includedTimestamps) : null;
  const newestObservedAtMs = includedTimestamps.length > 0 ? Math.max(...includedTimestamps) : null;
  return {
    total_available_count: records.length,
    included_count: included.length,
    limit: options.limit,
    offset: options.offset,
    has_more: options.offset + included.length < records.length,
    truncated: included.length < records.length,
    oldest_observed_at: oldestObservedAtMs === null ? null : asIsoDate(oldestObservedAtMs),
    oldest_observed_at_ms: oldestObservedAtMs,
    newest_observed_at: newestObservedAtMs === null ? null : asIsoDate(newestObservedAtMs),
    newest_observed_at_ms: newestObservedAtMs
  };
}
