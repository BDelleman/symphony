import type { OrchestratorState, RunningEntry } from '../orchestrator';
import { explainOperatorRuntimeState, REASON_CODES, toOperatorExplainerHint } from '../observability';
import { redactUnknown } from '../security/redaction';
import type { DurableRunHistoryRecord, ExecutionGraphThreadLineage } from '../persistence';
import { buildAgentConversationProjection } from './agent-conversation';
import { LocalApiError } from './errors';
import { projectMissingToolOutputRecovery } from './missing-tool-output-recovery';
import { projectBudget } from './snapshot-service/budget';
import { projectOperatorActions } from './snapshot-service/operator-actions';
import {
  projectAutomationFaultActions,
  projectBlockedInputActions,
  projectNoProgressCircuitBreakerFault,
  projectBlockedRootCause,
  projectCurrentOperatorBlock,
  projectRetryCause,
  projectRetryExplainer,
  projectRetryTiming
} from './snapshot-service/retries-and-blockers';
import { projectRunnerEventEvidence, projectRuntimeEventEvidence, projectQuarantinedRunningEvents } from './snapshot-service/runtime-events';
import { toStateRunningRow, explainRunningEntry, redactPromptPreview } from './snapshot-service/running-projection';
import { asIsoDate } from './snapshot-service/time';
import { projectCodexSessionTranscriptScanBudget, projectCodexThreadActivity, projectPhaseTiming, resolveStateFreshness } from './snapshot-service/state-projection';
import { buildPageMetadata, normalizeDiagnosticPageOptions, projectMissingToolOutput, projectToolCallLedger, projectTranscriptToolCallDiagnostics, projectTranscriptToolCallDiagnosticSummary, type RuntimeDiagnosticPageOptions } from './snapshot-service/transcript-diagnostics';
import { projectWorkerEventPressure } from './snapshot-service/worker-event-pressure';
import {
  createApiDegradedDiagnostics,
  resolveBlockedProgressSignal,
  resolveBlockedTurnControl,
  resolveNotBlockedExplainer,
  resolveProgressSignal,
  resolveRunningTurnControl,
  resolveTokenTelemetryQuality
} from './runtime-visibility';
import type {
  ApiDrainModeProjection,
  ApiDrainQuiescenceProjection,
  ApiIssueResponse,
  ApiIssueRuntimeDiagnosticsResponse,
  ApiRuntimeBuildIdentityProjection,
  ApiStateResponse
} from './types';

export interface SnapshotServiceOptions {
  nowMs?: () => number;
}

export class SnapshotService {
  private readonly nowMs: () => number;

  constructor(options: SnapshotServiceOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  projectDrainMode(state: OrchestratorState): ApiDrainModeProjection {
    return {
      active: state.drain_mode.active,
      entered_at: state.drain_mode.entered_at_ms === null ? null : asIsoDate(state.drain_mode.entered_at_ms),
      entered_at_ms: state.drain_mode.entered_at_ms,
      updated_at: state.drain_mode.updated_at_ms === null ? null : asIsoDate(state.drain_mode.updated_at_ms),
      updated_at_ms: state.drain_mode.updated_at_ms,
      reason: state.drain_mode.reason
    };
  }

  projectRuntimeIdentity(state: OrchestratorState): ApiRuntimeBuildIdentityProjection | null {
    const identity = state.runtime_identity;
    if (!identity) {
      return null;
    }
    return {
      process_started_at: asIsoDate(identity.process_started_at_ms),
      process_started_at_ms: identity.process_started_at_ms,
      running_build: {
        identity: identity.running_build.identity,
        commit_sha: identity.running_build.commit_sha,
        source_timestamp:
          identity.running_build.source_timestamp_ms === null ? null : asIsoDate(identity.running_build.source_timestamp_ms),
        source_timestamp_ms: identity.running_build.source_timestamp_ms
      },
      current_build: {
        identity: identity.current_build.identity,
        commit_sha: identity.current_build.commit_sha,
        source_timestamp:
          identity.current_build.source_timestamp_ms === null ? null : asIsoDate(identity.current_build.source_timestamp_ms),
        source_timestamp_ms: identity.current_build.source_timestamp_ms,
        status: identity.current_build.status
      },
      status: identity.status,
      health_warning: identity.health_warning ? { ...identity.health_warning } : null
    };
  }

  projectQuiescence(state: OrchestratorState): ApiDrainQuiescenceProjection {
    return {
      safe_to_shutdown: state.quiescence.safe_to_shutdown,
      state: state.quiescence.state,
      updated_at: asIsoDate(state.quiescence.updated_at_ms),
      updated_at_ms: state.quiescence.updated_at_ms,
      blockers: state.quiescence.blockers.map((blocker) => ({
        ...blocker,
        issue_identifiers: [...blocker.issue_identifiers]
      })),
      blocker_counts: { ...state.quiescence.blocker_counts },
      warnings: (state.quiescence.warnings ?? []).map((warning) => ({ ...warning })),
      restart_guidance: {
        ...(state.quiescence.restart_guidance ?? {
          safe_to_restart: true,
          recommended_action: 'none',
          pending_work: [],
          detail: 'Runtime is safe to restart.'
        }),
        pending_work: (state.quiescence.restart_guidance?.pending_work ?? []).map((entry) => ({ ...entry }))
      }
    };
  }

  projectState(state: OrchestratorState): ApiStateResponse {
    const nowMs = this.nowMs();
    const freshness = resolveStateFreshness(state, nowMs);
    const running = Array.from(state.running.entries()).map(([issueId, entry]) =>
      toStateRunningRow(issueId, entry, nowMs, state.operator_actions)
    );
    const retrying = Array.from(state.retry_attempts.values()).map((entry) => {
      const retryCause = projectRetryCause(entry, nowMs);
      return {
        ...projectBudget(entry),
        issue_id: entry.issue_id,
        issue_identifier: entry.identifier,
        attempt: entry.attempt,
        due_at: asIsoDate(entry.due_at_ms),
        due_at_ms: entry.due_at_ms,
        due_state: retryCause.due_state,
        overdue_ms: retryCause.overdue_ms,
        retry_wait_ms: retryCause.retry_wait_ms,
        retry_cause: retryCause,
        error: entry.error,
        worker_host: entry.worker_host ?? null,
        workspace_path: entry.workspace_path ?? null,
        provisioner_type: entry.provisioner_type ?? null,
        branch_name: entry.branch_name ?? null,
        repo_root: entry.repo_root ?? null,
        workspace_exists: entry.workspace_exists,
        workspace_git_status: entry.workspace_git_status ?? null,
        workspace_provisioned: entry.workspace_provisioned,
        workspace_is_git_worktree: entry.workspace_is_git_worktree,
        copy_ignored_applied: entry.copy_ignored_applied ?? false,
        copy_ignored_status: entry.copy_ignored_status ?? null,
        copy_ignored_summary: entry.copy_ignored_summary ?? null,
        stop_reason_code: entry.stop_reason_code ?? null,
        stop_reason_detail: entry.stop_reason_detail ?? null,
        previous_thread_id: entry.previous_thread_id ?? null,
        previous_session_id: entry.previous_session_id ?? null,
        last_progress_checkpoint_at: entry.last_progress_checkpoint_at ? asIsoDate(entry.last_progress_checkpoint_at) : null,
        last_phase: entry.last_phase ?? null,
        last_phase_at: entry.last_phase_at_ms ? asIsoDate(entry.last_phase_at_ms) : null,
        last_phase_detail: entry.last_phase_detail ?? null,
        recovery: entry.recovery ? { ...entry.recovery } : null,
        missing_tool_output_recovery: projectMissingToolOutputRecovery(entry),
        transcript_tool_call_diagnostic_summary: projectTranscriptToolCallDiagnosticSummary(entry),
        operator_explainer_hint: toOperatorExplainerHint(projectRetryExplainer(entry, nowMs))
      };
    });
    const retryStatus = {
      total: retrying.length,
      overdue_count: retrying.filter((entry) => entry.due_state === 'overdue').length,
      pending_count: retrying.filter((entry) => entry.due_state === 'pending').length,
      entries: retrying.map((entry) => ({
        issue_id: entry.issue_id,
        issue_identifier: entry.issue_identifier,
        attempt: entry.attempt,
        due_at: entry.due_at,
        due_at_ms: entry.due_at_ms,
        due_state: entry.due_state,
        overdue_ms: entry.overdue_ms,
        retry_wait_ms: entry.retry_wait_ms,
        reason_code: entry.retry_cause.reason_code,
        detail: entry.retry_cause.detail,
        operator_detail: entry.retry_cause.operator_detail,
        headline: entry.retry_cause.headline,
        expected_transition: entry.retry_cause.expected_transition,
        last_phase: entry.retry_cause.last_phase
      }))
    };
    const blockedFromInputs = Array.from(state.blocked_inputs.values()).map((entry) => {
      const progressSignal = resolveBlockedProgressSignal(entry);
      return {
        ...projectBudget(entry),
        ...(state.circuit_breakers.get(entry.issue_id)
          ? {
              breaker_active: state.circuit_breakers.get(entry.issue_id)?.breaker_active ?? false,
              breaker_hit_count: state.circuit_breakers.get(entry.issue_id)?.breaker_hit_count ?? 0,
              breaker_window_minutes: state.circuit_breakers.get(entry.issue_id)?.breaker_window_minutes ?? 0,
              breaker_first_hit_at: state.circuit_breakers.get(entry.issue_id)?.breaker_first_hit_at_ms
                ? asIsoDate(state.circuit_breakers.get(entry.issue_id)!.breaker_first_hit_at_ms!)
                : null,
              breaker_last_hit_at: state.circuit_breakers.get(entry.issue_id)?.breaker_last_hit_at_ms
                ? asIsoDate(state.circuit_breakers.get(entry.issue_id)!.breaker_last_hit_at_ms!)
                : null
            }
          : {
              breaker_active: false,
              breaker_hit_count: 0,
              breaker_window_minutes: 0,
              breaker_first_hit_at: null,
              breaker_last_hit_at: null
            }),
        issue_id: entry.issue_id,
        issue_identifier: entry.issue_identifier,
        attempt: entry.attempt,
        blocked_at: asIsoDate(entry.blocked_at_ms),
        worker_host: entry.worker_host ?? null,
        workspace_path: entry.workspace_path ?? null,
        provisioner_type: entry.provisioner_type ?? null,
        branch_name: entry.branch_name ?? null,
        repo_root: entry.repo_root ?? null,
        workspace_exists: entry.workspace_exists,
        workspace_git_status: entry.workspace_git_status ?? null,
        workspace_provisioned: entry.workspace_provisioned,
        workspace_is_git_worktree: entry.workspace_is_git_worktree,
        copy_ignored_applied: entry.copy_ignored_applied ?? false,
        copy_ignored_status: entry.copy_ignored_status ?? null,
        copy_ignored_summary: entry.copy_ignored_summary ?? null,
        stop_reason_code: entry.stop_reason_code,
        stop_reason_detail: entry.stop_reason_detail ?? null,
        worker_termination_result: entry.worker_termination_result ? { ...entry.worker_termination_result } : null,
        conflict_files: entry.conflict_files.map((file) => ({ ...file })),
        classification_summary: entry.classification_summary ? { ...entry.classification_summary } : undefined,
        resolution_hints: [...entry.resolution_hints],
        previous_thread_id: entry.previous_thread_id ?? null,
        previous_session_id: entry.previous_session_id ?? null,
        last_phase: entry.last_phase ?? null,
        last_phase_at: entry.last_phase_at_ms ? asIsoDate(entry.last_phase_at_ms) : null,
        last_phase_detail: entry.last_phase_detail ?? null,
        root_cause: projectBlockedRootCause(entry),
        current_operator_block: projectCurrentOperatorBlock(entry),
        requires_manual_resume: true as const,
        awaiting_operator: true as const,
        awaiting_operator_reason_code: entry.awaiting_operator_reason_code ?? entry.stop_reason_code,
        awaiting_operator_since: asIsoDate(entry.awaiting_operator_since_ms ?? entry.blocked_at_ms),
        awaiting_operator_resume_nonce: entry.awaiting_operator_resume_nonce ?? 0,
        quarantined_event_count: entry.quarantined_event_count ?? 0,
        last_quarantined_event_at: entry.last_quarantined_event_at_ms ? asIsoDate(entry.last_quarantined_event_at_ms) : null,
        attempt_count_window: entry.attempt_count_window,
        window_minutes: entry.window_minutes,
        last_known_commit_sha: entry.last_known_commit_sha ?? null,
        last_progress_checkpoint_at: entry.last_progress_checkpoint_at ? asIsoDate(entry.last_progress_checkpoint_at) : null,
        progress_signals: entry.progress_signals ? { ...entry.progress_signals } : undefined,
        required_actions: [...(entry.required_actions ?? [])],
        resume_override_reason: entry.resume_override_reason ?? null,
        ...resolveBlockedTurnControl(entry),
        ...progressSignal,
        operator_actions: projectOperatorActions(state, entry.issue_id),
        runtime_state_kind: 'blocked_input' as const,
        available_actions: projectBlockedInputActions(entry.issue_identifier),
        recovery: entry.recovery ? { ...entry.recovery } : null,
        missing_tool_output_recovery: projectMissingToolOutputRecovery(entry),
        operator_explainer_hint: toOperatorExplainerHint(
          explainOperatorRuntimeState({
            state_class: 'blocked',
            reason_code: entry.stop_reason_code,
            reason_detail: entry.stop_reason_detail
          })
        ),
        pending_input: entry.pending_input
          ? {
              ...entry.pending_input,
              input_required_at: asIsoDate(entry.pending_input.input_required_at_ms)
            }
          : null,
        tool_output_wait: projectMissingToolOutput(entry),
        transcript_tool_call_diagnostic_summary: projectTranscriptToolCallDiagnosticSummary(entry),
        last_input_submit: entry.last_input_submit
          ? {
              submitted_at: asIsoDate(entry.last_input_submit.submitted_at_ms),
              request_id: entry.last_input_submit.request_id,
              resume_mode: entry.last_input_submit.resume_mode,
              resume_reason_code: entry.last_input_submit.resume_reason_code
            }
          : null,
        resume_history: (entry.resume_history ?? []).map((history) => ({
          submitted_at: asIsoDate(history.submitted_at_ms),
          request_id: history.request_id,
          resume_mode: history.resume_mode,
          resume_reason_code: history.resume_reason_code,
          previous_thread_id: history.previous_thread_id ?? null,
          previous_session_id: history.previous_session_id ?? null
        })),
        session_console: (entry.session_console ?? []).map(projectRunnerEventEvidence)
      };
    });
    const blocked = [
      ...blockedFromInputs,
      ...Array.from(state.circuit_breakers.values())
        .filter((entry) => entry.breaker_active && !state.blocked_inputs.has(entry.issue_id))
        .map((entry) => projectNoProgressCircuitBreakerFault(entry, state, nowMs))
    ];

    const activeSeconds = Array.from(state.running.values()).reduce((total, entry) => {
      const seconds = Math.max(0, Math.floor((nowMs - entry.started_at_ms) / 1000));
      return total + seconds;
    }, 0);

    return redactUnknown({
      generated_at: asIsoDate(nowMs),
      ...freshness,
      ...createApiDegradedDiagnostics(null, []),
      runtime_identity: this.projectRuntimeIdentity(state),
      dashboard_asset_revision: null,
      runtime_update: null,
      runtime_restart: {
        capability: {
          mode: 'manual_restart_required',
          available: false,
          reason_code: REASON_CODES.runtimeUpdateRestartWrapperUnavailable,
          detail: 'Symphony is not running under the local restart supervisor.'
        },
        phase: 'manual_restart_required',
        attempt_id: null,
        requested_at: null,
        started_at: null,
        completed_at: null,
        failed_at: null,
        old_child_pid: null,
        new_child_pid: null,
        target_commit_sha: null,
        observed_running_commit_sha: null,
        recommended_manual_recovery: 'Restart Symphony with the supported supervisor command or rerun npm run start:dashboard manually.',
        last_error: null
      },
      drain_mode: this.projectDrainMode(state),
      quiescence: this.projectQuiescence(state),
      counts: {
        running: running.length,
        retrying: retrying.length,
        blocked: blocked.length,
        stopped: 0,
        running_stalled_waiting_count: running.filter((entry) => entry.operator_explainer_hint?.classification === 'stalled_waiting')
          .length,
        running_awaiting_input_count: running.filter((entry) => entry.operator_explainer_hint?.classification === 'awaiting_input')
          .length
      },
      retry_status: retryStatus,
      worker_event_pressure: projectWorkerEventPressure(state.running.values()),
      running,
      retrying,
      blocked,
      stopped_runs: [],
      codex_totals: {
        input_tokens: state.codex_totals.input_tokens,
        output_tokens: state.codex_totals.output_tokens,
        total_tokens: state.codex_totals.total_tokens,
        ...(typeof state.codex_totals.cached_input_tokens === 'number'
          ? { cached_input_tokens: state.codex_totals.cached_input_tokens }
          : {}),
        ...(typeof state.codex_totals.reasoning_output_tokens === 'number'
          ? { reasoning_output_tokens: state.codex_totals.reasoning_output_tokens }
          : {}),
        ...(typeof state.codex_totals.model_context_window === 'number'
          ? { model_context_window: state.codex_totals.model_context_window }
          : {}),
        seconds_running: state.codex_totals.seconds_running + activeSeconds
      },
      provider_totals: Array.from(
        running.reduce((groups, entry) => {
          const usage = entry.provider_usage;
          if (!usage) return groups;
          const model = usage.model ?? entry.effective_model ?? entry.requested_model ?? null;
          const key = `claude-cli\0${model ?? ''}`;
          const current = groups.get(key) ?? {
            runtime: 'claude-cli' as const,
            effective_model: model,
            invocation_count: 0,
            final_invocation_count: 0,
            partial_invocation_count: 0,
            unobserved_invocation_count: 0,
            missing_invocation_count: 0,
            input_tokens: null,
            output_tokens: null,
            cache_read_tokens: null,
            cache_creation_tokens: null,
            provider_turn_count: null,
            estimated_cost_usd: null,
            updated_at: null
          };
          const addNullable = (left: number | null, right: number | null) =>
            right === null ? left : (left ?? 0) + right;
          current.invocation_count += 1;
          if (usage.status === 'final') current.final_invocation_count += 1;
          if (usage.status === 'partial') current.partial_invocation_count += 1;
          else if (usage.status === 'unobserved') current.unobserved_invocation_count += 1;
          else if (usage.status !== 'final') current.missing_invocation_count += 1;
          current.input_tokens = addNullable(current.input_tokens, usage.input_tokens);
          current.output_tokens = addNullable(current.output_tokens, usage.output_tokens);
          current.cache_read_tokens = addNullable(current.cache_read_tokens, usage.cache_read_tokens);
          current.cache_creation_tokens = addNullable(current.cache_creation_tokens, usage.cache_creation_tokens);
          current.provider_turn_count = addNullable(current.provider_turn_count, usage.provider_turn_count);
          current.estimated_cost_usd = addNullable(current.estimated_cost_usd, usage.estimated_cost_usd);
          if (usage.updated_at && (!current.updated_at || usage.updated_at > current.updated_at)) current.updated_at = usage.updated_at;
          groups.set(key, current);
          return groups;
        }, new Map<string, ApiStateResponse['provider_totals'][number]>()).values()
      ).sort((left, right) => (left.effective_model ?? '').localeCompare(right.effective_model ?? '')),
      rate_limits: state.codex_rate_limits,
      health: {
        dispatch_validation: state.health.dispatch_validation,
        last_error: state.health.last_error
      },
      throughput: {
        current_tps: state.throughput.current_tps,
        avg_tps_60s: state.throughput.avg_tps_60s,
        window_seconds: state.throughput.window_seconds,
        sparkline_10m: [...state.throughput.sparkline_10m],
        sample_count: state.throughput.sample_count
      },
      recent_runtime_events: state.recent_runtime_events.map(projectRuntimeEventEvidence)
    }) as ApiStateResponse;
  }

  projectIssueRuntimeDiagnostics(
    state: OrchestratorState,
    issueIdentifier: string,
    options: RuntimeDiagnosticPageOptions = {}
  ): ApiIssueRuntimeDiagnosticsResponse {
    const nowMs = this.nowMs();
    const freshness = resolveStateFreshness(state, nowMs);
    const pageOptions = normalizeDiagnosticPageOptions(options);
    const runningEntry = Array.from(state.running.entries()).find(([, entry]) => entry.identifier === issueIdentifier);
    const retryEntry = Array.from(state.retry_attempts.values()).find((entry) => entry.identifier === issueIdentifier);
    const blockedEntry = Array.from(state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issueIdentifier);
    const issueId = runningEntry?.[0] ?? retryEntry?.issue_id ?? blockedEntry?.issue_id;

    if (!issueId) {
      throw new LocalApiError(
        'issue_diagnostics_not_found',
        `Issue ${issueIdentifier} has no runtime diagnostics`,
        404
      );
    }

    const status = runningEntry ? 'running' : retryEntry ? 'retrying' : 'blocked';
    const activeEntry = runningEntry ? runningEntry[1] : retryEntry ?? blockedEntry;
    if (!activeEntry) {
      throw new LocalApiError(
        'issue_diagnostics_not_found',
        `Issue ${issueIdentifier} has no runtime diagnostics`,
        404
      );
    }
    const transcriptDiagnostics =
      'transcript_tool_call_diagnostics' in activeEntry ? activeEntry.transcript_tool_call_diagnostics ?? [] : [];
    const transcriptRecords = [...transcriptDiagnostics]
      .sort((left, right) => right.observed_at_ms - left.observed_at_ms || left.call_id.localeCompare(right.call_id))
      .map((diagnostic) => projectTranscriptToolCallDiagnostics({ transcript_tool_call_diagnostics: [diagnostic] })[0]);
    const includedTranscriptRecords = transcriptRecords.slice(pageOptions.offset, pageOptions.offset + pageOptions.limit);
    const ledgerRecords = projectToolCallLedger(activeEntry as { tool_call_ledger?: RunningEntry['tool_call_ledger'] })
      .sort((left, right) => right.last_seen_at_ms - left.last_seen_at_ms || left.call_id.localeCompare(right.call_id));
    const includedLedgerRecords = ledgerRecords.slice(pageOptions.offset, pageOptions.offset + pageOptions.limit);

    return redactUnknown({
      issue_identifier: issueIdentifier,
      issue_id: issueId,
      status,
      generated_at: asIsoDate(nowMs),
      ...freshness,
      ...createApiDegradedDiagnostics(null, []),
      diagnostics_endpoint: `/api/v1/issues/${encodeURIComponent(issueIdentifier)}/diagnostics`,
      codex_session_transcript_scan_budget:
        'codex_session_transcript_scan_budget' in activeEntry
          ? projectCodexSessionTranscriptScanBudget(activeEntry)
          : null,
      transcript_tool_call_diagnostics: {
        metadata: buildPageMetadata(transcriptRecords, includedTranscriptRecords, pageOptions, (record) => record.observed_at_ms),
        records: includedTranscriptRecords
      },
      tool_call_ledger: {
        metadata: buildPageMetadata(ledgerRecords, includedLedgerRecords, pageOptions, (record) => record.last_seen_at_ms),
        records: includedLedgerRecords
      },
      missing_tool_output: projectMissingToolOutput(
        activeEntry as { tool_output_wait?: import('../orchestrator').BlockedEntry['tool_output_wait'] }
      ),
      recovery: activeEntry.recovery ? { ...activeEntry.recovery } : null,
      missing_tool_output_recovery: projectMissingToolOutputRecovery(activeEntry)
    }) as ApiIssueRuntimeDiagnosticsResponse;
  }

  projectIssue(
    state: OrchestratorState,
    issueIdentifier: string,
    options: { runHistory?: DurableRunHistoryRecord[]; lineage?: ExecutionGraphThreadLineage | null } = {}
  ): ApiIssueResponse {
    const nowMs = this.nowMs();
    const freshness = resolveStateFreshness(state, nowMs);
    const runningEntry = Array.from(state.running.entries()).find(([, entry]) => entry.identifier === issueIdentifier);
    const retryEntry = Array.from(state.retry_attempts.values()).find((entry) => entry.identifier === issueIdentifier);
    const blockedEntry = Array.from(state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issueIdentifier);
    const breakerEntry =
      blockedEntry
        ? state.circuit_breakers.get(blockedEntry.issue_id)
        : Array.from(state.circuit_breakers.values()).find(
            (entry) => entry.breaker_active && entry.issue_identifier === issueIdentifier
          );
    const conversation = buildAgentConversationProjection({
      state,
      issueIdentifier,
      runHistory: options.runHistory,
      lineage: options.lineage ?? null
    });

    if (!runningEntry && !retryEntry && !blockedEntry && !breakerEntry) {
      throw new LocalApiError(
        'issue_not_found',
        `Issue ${issueIdentifier} is not in runtime state`,
        404
      );
    }

    if (runningEntry) {
      const [issueId, entry] = runningEntry;
      const currentRetryAttempt = retryEntry?.attempt ?? 0;
      const progressSignal = resolveProgressSignal(entry);
      const turnControl = resolveRunningTurnControl(entry);
      const blockedProgressSignal = blockedEntry ? resolveBlockedProgressSignal(blockedEntry) : null;
      const operatorExplainer = explainRunningEntry(entry);
      return redactUnknown({
        issue_identifier: issueIdentifier,
        issue_id: issueId,
        status: 'running',
        ...freshness,
        ...createApiDegradedDiagnostics(null, []),
        operator_actions: projectOperatorActions(state, issueId, entry),
        operator_explainer: operatorExplainer,
        workspace: {
          path: entry.workspace_path,
          host: entry.worker_host ?? null
        },
        attempts: {
          restart_count: entry.retry_attempt,
          current_retry_attempt: currentRetryAttempt
        },
        running: {
          ...projectBudget(entry),
          session_id: entry.session_id,
          worker_host: entry.worker_host ?? null,
          workspace_path: entry.workspace_path ?? null,
          provisioner_type: entry.provisioner_type ?? null,
          branch_name: entry.branch_name ?? null,
          repo_root: entry.repo_root ?? null,
          workspace_exists: entry.workspace_exists,
          workspace_git_status: entry.workspace_git_status ?? null,
          workspace_provisioned: entry.workspace_provisioned,
          workspace_is_git_worktree: entry.workspace_is_git_worktree,
          copy_ignored_applied: entry.copy_ignored_applied ?? false,
          copy_ignored_status: entry.copy_ignored_status ?? null,
          copy_ignored_summary: entry.copy_ignored_summary ?? null,
          thread_id: entry.thread_id,
          turn_id: entry.turn_id,
          codex_app_server_pid: entry.codex_app_server_pid,
          agent_runtime: entry.agent_runtime ?? null,
          worker_process_pid: entry.worker_process_pid ?? null,
          provider_usage: entry.provider_usage
            ? {
                ...entry.provider_usage,
                effective_models: [...(entry.provider_usage.effective_models ?? [])],
                tool_counts: { ...(entry.provider_usage.tool_counts ?? {}) },
                mcp_counts: { ...(entry.provider_usage.mcp_counts ?? {}) },
                model_usage: (entry.provider_usage.model_usage ?? []).map((usage) => ({ ...usage })),
                reconciliation_delta: entry.provider_usage.reconciliation_delta
                  ? { ...entry.provider_usage.reconciliation_delta }
                  : null
              }
            : null,
          turn_count: entry.turn_count,
          state: entry.issue.state,
          dispatch_state: entry.dispatch_state ?? entry.started_issue_state ?? entry.issue.state,
          started_at: asIsoDate(entry.started_at_ms),
          last_event: entry.last_event,
          last_event_summary: entry.last_event_summary,
          last_message: entry.last_message,
          awaiting_input: Boolean(entry.awaiting_input_since_ms),
          awaiting_input_since_ms: entry.awaiting_input_since_ms ?? null,
          pending_input_preview: entry.pending_input_preview
            ? {
                type: entry.pending_input_preview.type,
                prompt_preview: redactPromptPreview(entry.pending_input_preview.prompt_preview),
                option_count: typeof entry.pending_input_preview.option_count === 'number' ? entry.pending_input_preview.option_count : null
              }
            : null,
          stalled_waiting: Boolean(entry.stalled_waiting_since_ms && entry.stalled_waiting_reason),
          stalled_waiting_since_ms:
            entry.stalled_waiting_since_ms && entry.stalled_waiting_reason ? entry.stalled_waiting_since_ms : null,
          stalled_waiting_reason:
            entry.stalled_waiting_since_ms && entry.stalled_waiting_reason ? REASON_CODES.turnWaitingThresholdExceeded : null,
          current_phase: entry.current_phase ?? null,
          current_phase_at: entry.current_phase_at_ms ? asIsoDate(entry.current_phase_at_ms) : null,
          phase_elapsed_ms: entry.current_phase_at_ms ? Math.max(0, this.nowMs() - entry.current_phase_at_ms) : null,
          phase_timing: projectPhaseTiming(entry, this.nowMs()),
          phase_detail: entry.phase_detail ?? null,
          last_event_at: entry.last_codex_timestamp_ms !== null ? asIsoDate(entry.last_codex_timestamp_ms) : null,
          codex_thread_activity: projectCodexThreadActivity(entry, this.nowMs()),
          token_telemetry_status: entry.token_telemetry_status,
          token_telemetry_last_source: entry.token_telemetry_last_source,
          token_telemetry_last_at_ms: entry.token_telemetry_last_at_ms,
          rate_limits: entry.rate_limits ?? null,
          protocol_warnings: (entry.protocol_warnings ?? []).map((warning) => ({ ...warning })),
          model_reroute: entry.model_reroute ? { ...entry.model_reroute } : null,
          requested_model: entry.requested_model ?? null,
          effective_model: entry.effective_model ?? null,
          ...turnControl,
          ...progressSignal,
          ...resolveTokenTelemetryQuality(entry),
          quarantined_event_count: entry.quarantined_event_count ?? 0,
          last_quarantined_event_at: entry.last_quarantined_event_at_ms
            ? asIsoDate(entry.last_quarantined_event_at_ms)
            : null,
          ...resolveNotBlockedExplainer({
            blocked: false,
            progress_signal_state: progressSignal.progress_signal_state,
            awaiting_input: Boolean(entry.awaiting_input_since_ms),
            waiting_started_at_ms: entry.running_waiting_started_at_ms ?? null,
            now_ms: nowMs,
            stalled_waiting_ms: 300_000
          }),
          operator_actions: projectOperatorActions(state, issueId, entry),
          transcript_tool_call_diagnostic_summary: projectTranscriptToolCallDiagnosticSummary(entry),
          tokens: {
            input_tokens: entry.tokens.input_tokens,
            output_tokens: entry.tokens.output_tokens,
            total_tokens: entry.tokens.total_tokens,
            ...(typeof entry.tokens.cached_input_tokens === 'number'
              ? { cached_input_tokens: entry.tokens.cached_input_tokens }
              : {}),
            ...(typeof entry.tokens.reasoning_output_tokens === 'number'
              ? { reasoning_output_tokens: entry.tokens.reasoning_output_tokens }
              : {}),
            ...(typeof entry.tokens.model_context_window === 'number'
              ? { model_context_window: entry.tokens.model_context_window }
              : {})
          },
          recovery: entry.recovery ? { ...entry.recovery } : null,
          missing_tool_output_recovery: projectMissingToolOutputRecovery(entry),
          codex_session_transcript_scan_budget: projectCodexSessionTranscriptScanBudget(entry)
        },
        retry: retryEntry
          ? {
              ...projectBudget(retryEntry),
              attempt: retryEntry.attempt,
              due_at: asIsoDate(retryEntry.due_at_ms),
              due_at_ms: retryEntry.due_at_ms,
              due_state: projectRetryTiming(retryEntry.due_at_ms, nowMs).due_state,
              overdue_ms: projectRetryTiming(retryEntry.due_at_ms, nowMs).overdue_ms,
              retry_wait_ms: projectRetryTiming(retryEntry.due_at_ms, nowMs).retry_wait_ms,
              retry_cause: projectRetryCause(retryEntry, nowMs),
              error: retryEntry.error,
              worker_host: retryEntry.worker_host ?? null,
              workspace_path: retryEntry.workspace_path ?? null,
              provisioner_type: retryEntry.provisioner_type ?? null,
              branch_name: retryEntry.branch_name ?? null,
              repo_root: retryEntry.repo_root ?? null,
              workspace_exists: retryEntry.workspace_exists,
              workspace_git_status: retryEntry.workspace_git_status ?? null,
              workspace_provisioned: retryEntry.workspace_provisioned,
              workspace_is_git_worktree: retryEntry.workspace_is_git_worktree,
              copy_ignored_applied: retryEntry.copy_ignored_applied ?? false,
              copy_ignored_status: retryEntry.copy_ignored_status ?? null,
              copy_ignored_summary: retryEntry.copy_ignored_summary ?? null,
              stop_reason_code: retryEntry.stop_reason_code ?? null,
              stop_reason_detail: retryEntry.stop_reason_detail ?? null,
              previous_thread_id: retryEntry.previous_thread_id ?? null,
              previous_session_id: retryEntry.previous_session_id ?? null,
              last_phase: retryEntry.last_phase ?? null,
              last_phase_at: retryEntry.last_phase_at_ms ? asIsoDate(retryEntry.last_phase_at_ms) : null,
              last_phase_detail: retryEntry.last_phase_detail ?? null,
              missing_tool_output_recovery: projectMissingToolOutputRecovery(retryEntry)
            }
          : null,
        blocked: blockedEntry
          ? {
              ...projectBudget(blockedEntry),
              attempt: blockedEntry.attempt,
              blocked_at: asIsoDate(blockedEntry.blocked_at_ms),
              worker_host: blockedEntry.worker_host ?? null,
              workspace_path: blockedEntry.workspace_path ?? null,
              provisioner_type: blockedEntry.provisioner_type ?? null,
              branch_name: blockedEntry.branch_name ?? null,
              repo_root: blockedEntry.repo_root ?? null,
              workspace_exists: blockedEntry.workspace_exists,
              workspace_git_status: blockedEntry.workspace_git_status ?? null,
              workspace_provisioned: blockedEntry.workspace_provisioned,
              workspace_is_git_worktree: blockedEntry.workspace_is_git_worktree,
              copy_ignored_applied: blockedEntry.copy_ignored_applied ?? false,
              copy_ignored_status: blockedEntry.copy_ignored_status ?? null,
              copy_ignored_summary: blockedEntry.copy_ignored_summary ?? null,
              stop_reason_code: blockedEntry.stop_reason_code,
              stop_reason_detail: blockedEntry.stop_reason_detail ?? null,
          conflict_files: blockedEntry.conflict_files.map((file) => ({ ...file })),
          classification_summary: blockedEntry.classification_summary ? { ...blockedEntry.classification_summary } : undefined,
              resolution_hints: [...blockedEntry.resolution_hints],
              previous_thread_id: blockedEntry.previous_thread_id ?? null,
              previous_session_id: blockedEntry.previous_session_id ?? null,
              last_phase: blockedEntry.last_phase ?? null,
              last_phase_at: blockedEntry.last_phase_at_ms ? asIsoDate(blockedEntry.last_phase_at_ms) : null,
              last_phase_detail: blockedEntry.last_phase_detail ?? null,
              root_cause: projectBlockedRootCause(blockedEntry),
              current_operator_block: projectCurrentOperatorBlock(blockedEntry),
          requires_manual_resume: true as const,
      awaiting_operator: true as const,
      awaiting_operator_reason_code: blockedEntry.awaiting_operator_reason_code ?? blockedEntry.stop_reason_code,
      awaiting_operator_since: asIsoDate(blockedEntry.awaiting_operator_since_ms ?? blockedEntry.blocked_at_ms),
      awaiting_operator_resume_nonce: blockedEntry.awaiting_operator_resume_nonce ?? 0,
      quarantined_event_count: blockedEntry.quarantined_event_count ?? 0,
      last_quarantined_event_at: blockedEntry.last_quarantined_event_at_ms ? asIsoDate(blockedEntry.last_quarantined_event_at_ms) : null,
          ...resolveBlockedTurnControl(blockedEntry),
          ...(blockedProgressSignal ?? resolveBlockedProgressSignal(blockedEntry)),
          operator_actions: projectOperatorActions(state, blockedEntry.issue_id),
          runtime_state_kind: 'blocked_input' as const,
          available_actions: projectBlockedInputActions(blockedEntry.issue_identifier),
          recovery: blockedEntry.recovery ? { ...blockedEntry.recovery } : null,
          missing_tool_output_recovery: projectMissingToolOutputRecovery(blockedEntry),
          breaker_active: breakerEntry?.breaker_active ?? false,
          breaker_hit_count: breakerEntry?.breaker_hit_count ?? 0,
          breaker_window_minutes: breakerEntry?.breaker_window_minutes ?? 0,
          breaker_first_hit_at: breakerEntry?.breaker_first_hit_at_ms ? asIsoDate(breakerEntry.breaker_first_hit_at_ms) : null,
          breaker_last_hit_at: breakerEntry?.breaker_last_hit_at_ms ? asIsoDate(breakerEntry.breaker_last_hit_at_ms) : null,
      attempt_count_window: blockedEntry.attempt_count_window,
      window_minutes: blockedEntry.window_minutes,
      last_known_commit_sha: blockedEntry.last_known_commit_sha ?? null,
      last_progress_checkpoint_at: blockedEntry.last_progress_checkpoint_at ? asIsoDate(blockedEntry.last_progress_checkpoint_at) : null,
      progress_signals: blockedEntry.progress_signals ? { ...blockedEntry.progress_signals } : undefined,
      required_actions: [...(blockedEntry.required_actions ?? [])],
      resume_override_reason: blockedEntry.resume_override_reason ?? null,
              pending_input: blockedEntry.pending_input
                ? {
                    ...blockedEntry.pending_input,
                    input_required_at: asIsoDate(blockedEntry.pending_input.input_required_at_ms)
                  }
                : null,
              tool_output_wait: projectMissingToolOutput(blockedEntry),
              transcript_tool_call_diagnostic_summary: projectTranscriptToolCallDiagnosticSummary(blockedEntry),
              last_input_submit: blockedEntry.last_input_submit
                ? {
                    submitted_at: asIsoDate(blockedEntry.last_input_submit.submitted_at_ms),
                    request_id: blockedEntry.last_input_submit.request_id,
                    resume_mode: blockedEntry.last_input_submit.resume_mode,
                    resume_reason_code: blockedEntry.last_input_submit.resume_reason_code
                  }
                : null,
              resume_history: (blockedEntry.resume_history ?? []).map((history) => ({
                submitted_at: asIsoDate(history.submitted_at_ms),
                request_id: history.request_id,
                resume_mode: history.resume_mode,
                resume_reason_code: history.resume_reason_code,
                previous_thread_id: history.previous_thread_id ?? null,
                previous_session_id: history.previous_session_id ?? null
              })),
              session_console: (blockedEntry.session_console ?? []).map(projectRunnerEventEvidence)
            }
          : null,
        phase_timeline: (state.phase_timeline?.get(issueId) ?? []).map((event) => ({
          at: asIsoDate(event.at_ms),
          phase: event.phase,
          detail: event.detail,
          attempt: event.attempt,
          thread_id: event.thread_id ?? null,
          session_id: event.session_id ?? null
        })),
        conversation,
        recent_events: entry.recent_events.map(projectRunnerEventEvidence),
        stale_events: projectQuarantinedRunningEvents(entry),
        last_error: retryEntry?.error ?? state.health.last_error,
        logs: {
          codex_session_logs: []
        },
        tracked: {}
      }) as ApiIssueResponse;
    }

    if (retryEntry) {
      const retryOnlyEntry = retryEntry;
      const issueId = retryOnlyEntry.issue_id;
      const blockedProgressSignal = blockedEntry ? resolveBlockedProgressSignal(blockedEntry) : null;
      const operatorExplainer = explainOperatorRuntimeState({
        state_class: 'retrying',
        reason_code: retryOnlyEntry.stop_reason_code,
        reason_detail: retryOnlyEntry.stop_reason_detail ?? retryOnlyEntry.error,
        expected_transition_detail: projectRetryExplainer(retryOnlyEntry, nowMs).expected_transition
      });
      return redactUnknown({
        issue_identifier: issueIdentifier,
        issue_id: issueId,
        status: 'retrying',
        ...freshness,
        ...createApiDegradedDiagnostics(null, []),
        operator_actions: projectOperatorActions(state, issueId),
        operator_explainer: operatorExplainer,
        workspace: {
          path: retryOnlyEntry.workspace_path ?? null,
          host: retryOnlyEntry.worker_host ?? null
        },
        attempts: {
          restart_count: 0,
          current_retry_attempt: retryOnlyEntry.attempt
        },
        running: null,
        retry: {
          ...projectBudget(retryOnlyEntry),
          attempt: retryOnlyEntry.attempt,
          due_at: asIsoDate(retryOnlyEntry.due_at_ms),
          due_at_ms: retryOnlyEntry.due_at_ms,
          due_state: projectRetryTiming(retryOnlyEntry.due_at_ms, nowMs).due_state,
          overdue_ms: projectRetryTiming(retryOnlyEntry.due_at_ms, nowMs).overdue_ms,
          retry_wait_ms: projectRetryTiming(retryOnlyEntry.due_at_ms, nowMs).retry_wait_ms,
          retry_cause: projectRetryCause(retryOnlyEntry, nowMs),
          error: retryOnlyEntry.error,
          worker_host: retryOnlyEntry.worker_host ?? null,
          workspace_path: retryOnlyEntry.workspace_path ?? null,
          provisioner_type: retryOnlyEntry.provisioner_type ?? null,
          branch_name: retryOnlyEntry.branch_name ?? null,
          repo_root: retryOnlyEntry.repo_root ?? null,
          workspace_exists: retryOnlyEntry.workspace_exists,
          workspace_git_status: retryOnlyEntry.workspace_git_status ?? null,
          workspace_provisioned: retryOnlyEntry.workspace_provisioned,
          workspace_is_git_worktree: retryOnlyEntry.workspace_is_git_worktree,
          copy_ignored_applied: retryOnlyEntry.copy_ignored_applied ?? false,
          copy_ignored_status: retryOnlyEntry.copy_ignored_status ?? null,
          copy_ignored_summary: retryOnlyEntry.copy_ignored_summary ?? null,
          stop_reason_code: retryOnlyEntry.stop_reason_code ?? null,
          stop_reason_detail: retryOnlyEntry.stop_reason_detail ?? null,
          previous_thread_id: retryOnlyEntry.previous_thread_id ?? null,
          previous_session_id: retryOnlyEntry.previous_session_id ?? null,
          last_phase: retryOnlyEntry.last_phase ?? null,
          last_phase_at: retryOnlyEntry.last_phase_at_ms ? asIsoDate(retryOnlyEntry.last_phase_at_ms) : null,
          last_phase_detail: retryOnlyEntry.last_phase_detail ?? null,
          missing_tool_output_recovery: projectMissingToolOutputRecovery(retryOnlyEntry)
        },
        blocked: blockedEntry
          ? {
              ...projectBudget(blockedEntry),
              attempt: blockedEntry.attempt,
              blocked_at: asIsoDate(blockedEntry.blocked_at_ms),
              worker_host: blockedEntry.worker_host ?? null,
              workspace_path: blockedEntry.workspace_path ?? null,
              provisioner_type: blockedEntry.provisioner_type ?? null,
              branch_name: blockedEntry.branch_name ?? null,
              repo_root: blockedEntry.repo_root ?? null,
              workspace_exists: blockedEntry.workspace_exists,
              workspace_git_status: blockedEntry.workspace_git_status ?? null,
              workspace_provisioned: blockedEntry.workspace_provisioned,
              workspace_is_git_worktree: blockedEntry.workspace_is_git_worktree,
              copy_ignored_applied: blockedEntry.copy_ignored_applied ?? false,
              copy_ignored_status: blockedEntry.copy_ignored_status ?? null,
              copy_ignored_summary: blockedEntry.copy_ignored_summary ?? null,
              stop_reason_code: blockedEntry.stop_reason_code,
              stop_reason_detail: blockedEntry.stop_reason_detail ?? null,
              conflict_files: blockedEntry.conflict_files.map((file) => ({ ...file })),
              resolution_hints: [...blockedEntry.resolution_hints],
              previous_thread_id: blockedEntry.previous_thread_id ?? null,
              previous_session_id: blockedEntry.previous_session_id ?? null,
              last_phase: blockedEntry.last_phase ?? null,
              last_phase_at: blockedEntry.last_phase_at_ms ? asIsoDate(blockedEntry.last_phase_at_ms) : null,
              last_phase_detail: blockedEntry.last_phase_detail ?? null,
              root_cause: projectBlockedRootCause(blockedEntry),
              current_operator_block: projectCurrentOperatorBlock(blockedEntry),
              requires_manual_resume: true as const,
              awaiting_operator: true as const,
              awaiting_operator_reason_code: blockedEntry.awaiting_operator_reason_code ?? blockedEntry.stop_reason_code,
              awaiting_operator_since: asIsoDate(blockedEntry.awaiting_operator_since_ms ?? blockedEntry.blocked_at_ms),
              awaiting_operator_resume_nonce: blockedEntry.awaiting_operator_resume_nonce ?? 0,
              quarantined_event_count: blockedEntry.quarantined_event_count ?? 0,
              last_quarantined_event_at: blockedEntry.last_quarantined_event_at_ms
                ? asIsoDate(blockedEntry.last_quarantined_event_at_ms)
                : null,
              attempt_count_window: blockedEntry.attempt_count_window,
              window_minutes: blockedEntry.window_minutes,
              last_known_commit_sha: blockedEntry.last_known_commit_sha ?? null,
              last_progress_checkpoint_at: blockedEntry.last_progress_checkpoint_at
                ? asIsoDate(blockedEntry.last_progress_checkpoint_at)
                : null,
              progress_signals: blockedEntry.progress_signals ? { ...blockedEntry.progress_signals } : undefined,
              required_actions: [...(blockedEntry.required_actions ?? [])],
              resume_override_reason: blockedEntry.resume_override_reason ?? null,
              ...resolveBlockedTurnControl(blockedEntry),
              ...(blockedProgressSignal ?? resolveBlockedProgressSignal(blockedEntry)),
              operator_actions: projectOperatorActions(state, blockedEntry.issue_id),
              runtime_state_kind: 'blocked_input' as const,
              available_actions: projectBlockedInputActions(blockedEntry.issue_identifier),
              recovery: blockedEntry.recovery ? { ...blockedEntry.recovery } : null,
              missing_tool_output_recovery: projectMissingToolOutputRecovery(blockedEntry),
              pending_input: blockedEntry.pending_input
                ? {
                    ...blockedEntry.pending_input,
                    input_required_at: asIsoDate(blockedEntry.pending_input.input_required_at_ms)
                  }
                : null,
              tool_output_wait: projectMissingToolOutput(blockedEntry),
              transcript_tool_call_diagnostic_summary: projectTranscriptToolCallDiagnosticSummary(blockedEntry),
              last_input_submit: blockedEntry.last_input_submit
                ? {
                    submitted_at: asIsoDate(blockedEntry.last_input_submit.submitted_at_ms),
                    request_id: blockedEntry.last_input_submit.request_id,
                    resume_mode: blockedEntry.last_input_submit.resume_mode,
                    resume_reason_code: blockedEntry.last_input_submit.resume_reason_code
                  }
                : null,
              resume_history: (blockedEntry.resume_history ?? []).map((history) => ({
                submitted_at: asIsoDate(history.submitted_at_ms),
                request_id: history.request_id,
                resume_mode: history.resume_mode,
                resume_reason_code: history.resume_reason_code,
                previous_thread_id: history.previous_thread_id ?? null,
                previous_session_id: history.previous_session_id ?? null
              })),
              session_console: (blockedEntry.session_console ?? []).map(projectRunnerEventEvidence)
            }
          : null,
        phase_timeline: (state.phase_timeline?.get(issueId) ?? []).map((event) => ({
          at: asIsoDate(event.at_ms),
          phase: event.phase,
          detail: event.detail,
          attempt: event.attempt,
          thread_id: event.thread_id ?? null,
          session_id: event.session_id ?? null
        })),
        conversation,
        recent_events: [],
        stale_events: [],
        last_error: retryOnlyEntry.error,
        logs: {
          codex_session_logs: []
        },
        tracked: {}
      }) as ApiIssueResponse;
    }

    if (!blockedEntry && breakerEntry) {
      const issueId = breakerEntry.issue_id;
      const blockedFault = projectNoProgressCircuitBreakerFault(breakerEntry, state, nowMs);
      const operatorExplainer = explainOperatorRuntimeState({
        state_class: 'blocked',
        reason_code: REASON_CODES.operatorNoProgressRedispatchBlocked,
        reason_detail: blockedFault.stop_reason_detail
      });
      return redactUnknown({
        issue_identifier: issueIdentifier,
        issue_id: issueId,
        status: 'blocked',
        ...freshness,
        ...createApiDegradedDiagnostics(null, []),
        operator_actions: projectOperatorActions(state, issueId),
        operator_explainer: operatorExplainer,
        workspace: {
          path: null,
          host: null
        },
        attempts: {
          restart_count: 0,
          current_retry_attempt: 0
        },
        running: null,
        retry: null,
        blocked: blockedFault,
        phase_timeline: (state.phase_timeline?.get(issueId) ?? []).map((event) => ({
          at: asIsoDate(event.at_ms),
          phase: event.phase,
          detail: event.detail,
          attempt: event.attempt,
          thread_id: event.thread_id ?? null,
          session_id: event.session_id ?? null
        })),
        conversation,
        recent_events: [],
        stale_events: [],
        last_error: state.health.last_error,
        logs: {
          codex_session_logs: []
        },
        tracked: {}
      }) as ApiIssueResponse;
    }

    if (!blockedEntry) {
      throw new LocalApiError(
        'issue_not_found',
        `Issue ${issueIdentifier} is not in runtime state`,
        404
      );
    }

    const issueId = blockedEntry.issue_id;
    const operatorExplainer = explainOperatorRuntimeState({
      state_class: 'blocked',
      reason_code: blockedEntry.stop_reason_code,
      reason_detail: blockedEntry.stop_reason_detail
    });
    return redactUnknown({
      issue_identifier: issueIdentifier,
      issue_id: issueId,
      status: 'blocked',
      ...freshness,
      ...createApiDegradedDiagnostics(null, []),
      operator_actions: projectOperatorActions(state, issueId),
      operator_explainer: operatorExplainer,
      workspace: {
        path: blockedEntry.workspace_path ?? null,
        host: blockedEntry.worker_host ?? null
      },
      attempts: {
        restart_count: 0,
        current_retry_attempt: blockedEntry.attempt
      },
      running: null,
      retry: null,
      blocked: {
        ...projectBudget(blockedEntry),
        attempt: blockedEntry.attempt,
        blocked_at: asIsoDate(blockedEntry.blocked_at_ms),
        worker_host: blockedEntry.worker_host ?? null,
        workspace_path: blockedEntry.workspace_path ?? null,
        provisioner_type: blockedEntry.provisioner_type ?? null,
        branch_name: blockedEntry.branch_name ?? null,
        repo_root: blockedEntry.repo_root ?? null,
        workspace_exists: blockedEntry.workspace_exists,
        workspace_git_status: blockedEntry.workspace_git_status ?? null,
        workspace_provisioned: blockedEntry.workspace_provisioned,
        workspace_is_git_worktree: blockedEntry.workspace_is_git_worktree,
        copy_ignored_applied: blockedEntry.copy_ignored_applied ?? false,
        copy_ignored_status: blockedEntry.copy_ignored_status ?? null,
        copy_ignored_summary: blockedEntry.copy_ignored_summary ?? null,
        stop_reason_code: blockedEntry.stop_reason_code,
        stop_reason_detail: blockedEntry.stop_reason_detail ?? null,
        worker_termination_result: blockedEntry.worker_termination_result ? { ...blockedEntry.worker_termination_result } : null,
        conflict_files: blockedEntry.conflict_files.map((file) => ({ ...file })),
        resolution_hints: [...blockedEntry.resolution_hints],
        previous_thread_id: blockedEntry.previous_thread_id ?? null,
        previous_session_id: blockedEntry.previous_session_id ?? null,
        last_phase: blockedEntry.last_phase ?? null,
        last_phase_at: blockedEntry.last_phase_at_ms ? asIsoDate(blockedEntry.last_phase_at_ms) : null,
        last_phase_detail: blockedEntry.last_phase_detail ?? null,
        root_cause: projectBlockedRootCause(blockedEntry),
        current_operator_block: projectCurrentOperatorBlock(blockedEntry),
        requires_manual_resume: true as const,
        awaiting_operator: true as const,
        awaiting_operator_reason_code: blockedEntry.awaiting_operator_reason_code ?? blockedEntry.stop_reason_code,
        awaiting_operator_since: asIsoDate(blockedEntry.awaiting_operator_since_ms ?? blockedEntry.blocked_at_ms),
        awaiting_operator_resume_nonce: blockedEntry.awaiting_operator_resume_nonce ?? 0,
        quarantined_event_count: blockedEntry.quarantined_event_count ?? 0,
        last_quarantined_event_at: blockedEntry.last_quarantined_event_at_ms
          ? asIsoDate(blockedEntry.last_quarantined_event_at_ms)
          : null,
        attempt_count_window: blockedEntry.attempt_count_window,
        window_minutes: blockedEntry.window_minutes,
        last_known_commit_sha: blockedEntry.last_known_commit_sha ?? null,
        last_progress_checkpoint_at: blockedEntry.last_progress_checkpoint_at
          ? asIsoDate(blockedEntry.last_progress_checkpoint_at)
          : null,
        progress_signals: blockedEntry.progress_signals ? { ...blockedEntry.progress_signals } : undefined,
        required_actions: [...(blockedEntry.required_actions ?? [])],
        resume_override_reason: blockedEntry.resume_override_reason ?? null,
        ...resolveBlockedTurnControl(blockedEntry),
        ...resolveBlockedProgressSignal(blockedEntry),
        operator_actions: projectOperatorActions(state, blockedEntry.issue_id),
        runtime_state_kind: 'blocked_input' as const,
        available_actions: projectBlockedInputActions(blockedEntry.issue_identifier),
        recovery: blockedEntry.recovery ? { ...blockedEntry.recovery } : null,
        missing_tool_output_recovery: projectMissingToolOutputRecovery(blockedEntry),
        pending_input: blockedEntry.pending_input
          ? {
              ...blockedEntry.pending_input,
              input_required_at: asIsoDate(blockedEntry.pending_input.input_required_at_ms)
            }
          : null,
        tool_output_wait: projectMissingToolOutput(blockedEntry),
        transcript_tool_call_diagnostic_summary: projectTranscriptToolCallDiagnosticSummary(blockedEntry),
        last_input_submit: blockedEntry.last_input_submit
          ? {
              submitted_at: asIsoDate(blockedEntry.last_input_submit.submitted_at_ms),
              request_id: blockedEntry.last_input_submit.request_id,
              resume_mode: blockedEntry.last_input_submit.resume_mode,
              resume_reason_code: blockedEntry.last_input_submit.resume_reason_code
            }
          : null,
        resume_history: (blockedEntry.resume_history ?? []).map((history) => ({
          submitted_at: asIsoDate(history.submitted_at_ms),
          request_id: history.request_id,
          resume_mode: history.resume_mode,
          resume_reason_code: history.resume_reason_code,
          previous_thread_id: history.previous_thread_id ?? null,
          previous_session_id: history.previous_session_id ?? null
        })),
        session_console: (blockedEntry.session_console ?? []).map(projectRunnerEventEvidence)
      },
      phase_timeline: (state.phase_timeline?.get(issueId) ?? []).map((event) => ({
        at: asIsoDate(event.at_ms),
        phase: event.phase,
        detail: event.detail,
        attempt: event.attempt,
        thread_id: event.thread_id ?? null,
        session_id: event.session_id ?? null
      })),
      conversation,
      recent_events: (blockedEntry.session_console ?? []).map(projectRunnerEventEvidence),
      stale_events: [],
      last_error: blockedEntry.stop_reason_detail ?? blockedEntry.stop_reason_code,
      logs: {
        codex_session_logs: []
      },
      tracked: {}
    }) as ApiIssueResponse;
  }
}
