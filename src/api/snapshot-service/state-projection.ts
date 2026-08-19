import type { RunningEntry, OrchestratorState } from '../../orchestrator';
import { REASON_CODES } from '../../observability';
import { resolveSnapshotFreshness } from '../runtime-visibility';
import type { ApiCodexSessionTranscriptScanBudget } from '../types';
import { asIsoDate } from './time';

export function projectPhaseTiming(entry: { current_phase_at_ms?: number | null }, nowMs: number) {
  const phaseStartedAtMs = entry.current_phase_at_ms ?? null;
  return {
    phase_started_at: phaseStartedAtMs ? asIsoDate(phaseStartedAtMs) : null,
    phase_elapsed_ms: phaseStartedAtMs ? Math.max(0, nowMs - phaseStartedAtMs) : null,
    source: phaseStartedAtMs ? REASON_CODES.symphonyPhaseMarker : null
  };
}

export function projectCodexThreadActivity(
  entry: {
    thread_id?: string | null;
    codex_thread_activity_at_ms?: number | null;
    codex_thread_activity_source?: import('../../codex/app-server-protocol').CodexAppServerThreadActivitySource | null;
    codex_thread_activity_status?: string | null;
  },
  nowMs: number
) {
  const updatedAtMs = entry.codex_thread_activity_at_ms ?? null;
  return {
    thread_id: entry.thread_id ?? null,
    updated_at: updatedAtMs ? asIsoDate(updatedAtMs) : null,
    updated_at_ms: updatedAtMs,
    age_ms: updatedAtMs ? Math.max(0, nowMs - updatedAtMs) : null,
    source: entry.codex_thread_activity_source ?? null,
    status: updatedAtMs ? ('available' as const) : ('unavailable' as const),
    thread_status: entry.codex_thread_activity_status ?? null
  };
}

export function projectCodexSessionTranscriptScanBudget(
  entry: Pick<RunningEntry, 'codex_session_transcript_scan_budget'>
): ApiCodexSessionTranscriptScanBudget | null {
  const budget = entry.codex_session_transcript_scan_budget;
  if (!budget) {
    return null;
  }
  return {
    observed_at: asIsoDate(budget.observed_at_ms),
    observed_at_ms: budget.observed_at_ms,
    candidate_count: budget.candidate_count,
    files_considered: budget.files_considered,
    files_parsed: budget.files_parsed,
    bytes_read: budget.bytes_read,
    exhausted: budget.exhausted,
    reason_codes: [...budget.reason_codes],
    limits: { ...budget.limits }
  };
}

export function resolveStateFreshness(state: OrchestratorState, nowMs: number) {
  return resolveSnapshotFreshness(state.snapshot_generated_at_ms ?? nowMs, nowMs);
}
