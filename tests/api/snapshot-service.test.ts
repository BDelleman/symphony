import { describe, expect, it } from 'vitest';

import { SnapshotService } from '../../src/api';
import type { OrchestratorState, TranscriptToolCallDiagnostic, TranscriptToolCallLineage } from '../../src/orchestrator';
import { CANONICAL_EVENT } from '../../src/observability/events';
import { REASON_CODES } from '../../src/observability/reason-codes';
import type { Issue } from '../../src/tracker';

function makeRunningEntry(overrides: Record<string, unknown> = {}) {
  return {
    issue: makeIssue(),
    identifier: 'ABC-1',
    run_id: 'run-1',
    worker_handle: {},
    monitor_handle: {},
    retry_attempt: 0,
    workspace_path: '/tmp/symphony/ABC-1',
    provisioner_type: 'none',
    branch_name: null,
    repo_root: null,
    workspace_exists: true,
    workspace_git_status: 'unknown' as const,
    workspace_provisioned: false,
    workspace_is_git_worktree: false,
    session_id: 'thread-1-turn-3',
    thread_id: 'thread-1',
    turn_id: 'turn-3',
    codex_app_server_pid: '12345',
    turn_count: 3,
    last_event: CANONICAL_EVENT.codex.turnCompleted,
    last_event_summary: 'codex turn completed: done',
    last_message: 'done',
    awaiting_input_since_ms: null,
    pending_input_preview: null,
    stalled_waiting_since_ms: null,
    stalled_waiting_reason: null,
    tokens: {
      input_tokens: 11,
      output_tokens: 5,
      total_tokens: 16
    },
    last_reported_tokens: {
      input_tokens: 11,
      output_tokens: 5,
      total_tokens: 16
    },
    token_telemetry_status: 'available' as const,
    token_telemetry_last_source: 'terminal_turn_summary',
    token_telemetry_last_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
    token_telemetry_turn_started_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
    token_telemetry_warning_emitted: false,
    recent_events: [
      {
        at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
        event: CANONICAL_EVENT.codex.turnCompleted,
        message: 'done'
      }
    ],
    started_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
    last_codex_timestamp_ms: Date.parse('2026-04-10T10:01:00.000Z'),
    ...overrides
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'ABC-1',
    title: 'Issue ABC-1',
    description: null,
    priority: 1,
    state: 'In Progress',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date('2026-04-10T10:00:00.000Z'),
    updated_at: new Date('2026-04-10T10:00:00.000Z'),
    ...overrides
  };
}

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    poll_interval_ms: 30_000,
    max_concurrent_agents: 10,
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    blocked_inputs: new Map(),
    circuit_breakers: new Map(),
    budget_usage_samples: new Map(),
    completed: new Set(),
    codex_totals: {
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      seconds_running: 40
    },
    codex_rate_limits: null,
    health: {
      dispatch_validation: 'ok',
      last_error: null
    },
    drain_mode: {
      active: false,
      entered_at_ms: null,
      updated_at_ms: null,
      reason: null
    },
    quiescence: {
      safe_to_shutdown: true,
      state: 'safe',
      updated_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
      blockers: [],
      blocker_counts: {
        active_worker: 0,
        live_codex_app_server_process: 0,
        pending_retry: 0,
        in_flight_tracker_write: 0,
        persistence_history_write: 0,
        unknown_degraded_blocker_source_health: 0,
        stale_runtime: 0,
        unknown_current_build_identity: 0
      },
      warnings: [],
      restart_guidance: {
        safe_to_restart: true,
        recommended_action: 'none',
        pending_work: [],
        detail: 'Runtime is safe to restart.'
      }
    },
    runtime_identity: null,
    throughput: {
      current_tps: 0,
      avg_tps_60s: 0,
      window_seconds: 600,
      sparkline_10m: Array.from({ length: 24 }, () => 0),
      sample_count: 0
    },
    recent_runtime_events: [],
    ...overrides
  };
}

function makeTranscriptDiagnostic(
  index: number,
  overrides: Partial<TranscriptToolCallDiagnostic> = {}
): TranscriptToolCallDiagnostic {
  const lineage = (['active_owned', 'prior_stale', 'external_manual', 'unattributed'] as TranscriptToolCallLineage[])[
    index % 4
  ];
  return {
    kind: index % 2 === 0 ? 'function_call' : 'function_call_output',
    call_id: `call-${index}`,
    tool_name: index % 2 === 0 ? 'linear_graphql' : null,
    thread_id: `thread-${index % 3}`,
    turn_id: `turn-${index % 5}`,
    session_id: `session-${index % 7}`,
    issue_id: `issue-${index % 2}`,
    issue_identifier: `ABC-${index % 2}`,
    run_id: `run-${index % 2}`,
    issue_run_id: `issue-run-${index % 2}`,
    attempt_id: `attempt-${index % 2}`,
    codex_app_server_pid: `${1000 + index}`,
    observed_at_ms: Date.parse('2026-04-10T10:01:00.000Z') + index * 1000,
    lineage,
    reason: `${lineage} diagnostic`,
    active_issue_id: 'issue-active',
    active_issue_identifier: 'ABC-ACTIVE',
    active_run_id: 'run-active',
    active_issue_run_id: 'issue-run-active',
    active_attempt_id: 'attempt-active',
    active_codex_app_server_pid: '9999',
    active_thread_id: 'thread-active',
    active_turn_id: 'turn-active',
    active_session_id: 'session-active',
    ...overrides
  };
}

function makeTranscriptScanBudget() {
  return {
    observed_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
    candidate_count: 10,
    files_considered: 3,
    files_parsed: 2,
    bytes_read: 4096,
    exhausted: true,
    reason_codes: ['transcript_probe_byte_budget_exhausted', 'transcript_scan_wall_clock_budget_exhausted'],
    limits: {
      max_candidate_files: 12,
      max_discovery_files: 20,
      max_probe_bytes: 8192,
      max_scan_bytes: 16384,
      max_file_age_ms: 86_400_000,
      max_wall_clock_ms: 25
    }
  };
}

describe('SnapshotService', () => {
  it('projects Claude usage separately without changing Codex enforcement totals or nulls', () => {
    const service = new SnapshotService({ nowMs: () => Date.parse('2026-04-10T10:02:00.000Z') });
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            agent_runtime: 'claude-cli',
            worker_process_pid: '4321',
            requested_model: 'claude-sonnet-4-6',
            effective_model: 'claude-sonnet-4-6',
            provider_usage: {
              runtime: 'claude-cli',
              model: 'claude-sonnet-4-6',
              effective_models: ['claude-sonnet-4-6'],
              input_tokens: 120,
              output_tokens: 30,
              cache_read_tokens: null,
              cache_creation_tokens: 5,
              provider_turn_count: 2,
              estimated_cost_usd: null,
              source: 'claude_stream_result',
              status: 'partial',
              confidence: 'provider_step',
              api_retry_count: 0,
              tool_counts: { Read: 1 },
              mcp_counts: { 'linear-server': 1 },
              updated_at: '2026-04-10T10:01:30.000Z',
              supervised_session_coverage: 'partial'
            }
          })
        ]
      ])
    });

    const projected = service.projectState(state);
    expect(projected.codex_totals).toMatchObject({ input_tokens: 10, output_tokens: 20, total_tokens: 30 });
    expect(projected.running[0]).toMatchObject({
      agent_runtime: 'claude-cli',
      worker_process_pid: '4321',
      provider_usage: {
        status: 'partial',
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: null,
        estimated_cost_usd: null,
        supervised_session_coverage: 'partial'
      }
    });
    expect(projected.provider_totals).toEqual([
      expect.objectContaining({
        runtime: 'claude-cli',
        effective_model: 'claude-sonnet-4-6',
        partial_invocation_count: 1,
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: null,
        cache_creation_tokens: 5,
        estimated_cost_usd: null
      })
    ]);
  });

  it('projects orchestrator state into API state contract and includes active runtime seconds', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:02:00.000Z')
    });

    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            last_codex_timestamp_ms: null,
            tool_call_ledger: {
              'call-api-1': {
                call_id: 'call-api-1',
                tool_name: 'linear_graphql',
                thread_id: 'thread-1',
                turn_id: 'turn-3',
                session_id: 'thread-1-turn-3',
                issue_id: 'issue-1',
                issue_identifier: 'ABC-1',
                run_id: 'run-1',
                issue_run_id: 'issue-run-1',
                attempt_id: 'attempt-1',
                first_seen_at_ms: Date.parse('2026-04-10T10:01:05.000Z'),
                last_seen_at_ms: Date.parse('2026-04-10T10:01:07.000Z'),
                completed_at_ms: Date.parse('2026-04-10T10:01:07.000Z'),
                completion_status: 'completed',
                evidence_sources: ['app_server_protocol', 'worker_event'],
                start_evidence_source: 'app_server_protocol',
                completion_evidence_source: 'worker_event',
                last_agent_message: 'waiting for linear_graphql output'
              }
            }
          })
        ]
      ]),
      retry_attempts: new Map([
        [
          'issue-2',
          {
            issue_id: 'issue-2',
            identifier: 'ABC-2',
            attempt: 1,
            due_at_ms: Date.parse('2026-04-10T10:02:30.000Z'),
            error: 'retrying',
            worker_host: 'build-1',
            workspace_path: '/tmp/symphony/ABC-2',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-2',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'turn_input_required',
            stop_reason_detail: 'tool requestUserInput could not be auto-answered',
            previous_thread_id: 'thread-prev',
            previous_session_id: 'thread-prev-turn-prev',
            timer_handle: {}
          }
        ]
      ])
    });

    const projected = service.projectState(state);
    expect(projected.counts.running).toBe(1);
    expect(projected.counts.blocked).toBe(0);
    expect(projected.counts.running_stalled_waiting_count).toBe(0);
    expect(projected.counts.running_awaiting_input_count).toBe(0);
    expect(projected.codex_totals.seconds_running).toBe(100);
    expect(projected.health.dispatch_validation).toBe('ok');
    expect(projected.running[0]?.session_id).toBe('thread-1-turn-3');
    expect(projected.running[0]?.thread_id).toBe('thread-1');
    expect(projected.running[0]?.turn_id).toBe('turn-3');
    expect(projected.running[0]?.codex_app_server_pid).toBe('12345');
    expect(projected.running[0]?.last_event_summary).toBe('codex turn completed: done');
    expect(projected.running[0]?.turn_count).toBe(3);
    expect(projected.running[0]?.phase_timing).toEqual({
      phase_started_at: null,
      phase_elapsed_ms: null,
      source: null
    });
    expect(projected.running[0]?.codex_thread_activity).toEqual({
      thread_id: 'thread-1',
      updated_at: null,
      updated_at_ms: null,
      age_ms: null,
      source: null,
      status: 'unavailable',
      thread_status: null
    });
    expect(projected.running[0]?.awaiting_input).toBe(false);
    expect(projected.running[0]?.pending_input_preview).toBeNull();
    expect(projected.running[0]?.stalled_waiting).toBe(false);
    expect(projected.running[0]?.operator_explainer_hint).toEqual({
      classification: 'healthy',
      actionability: 'none',
      headline: 'Run is progressing'
    });
    expect(projected.running[0]?.workspace_path).toBe('/tmp/symphony/ABC-1');
    expect(projected.running[0]?.token_telemetry_status).toBe('available');
    expect(projected.running[0]?.token_telemetry_last_source).toBe('terminal_turn_summary');
    expect(projected.running[0]?.token_telemetry_last_at_ms).toBe(Date.parse('2026-04-10T10:01:00.000Z'));
    expect(projected.snapshot_generated_at_ms).toBe(Date.parse('2026-04-10T10:02:00.000Z'));
    expect(projected.snapshot_age_ms).toBe(0);
    expect(projected.snapshot_freshness_state).toBe('fresh');
    expect(projected.api_degraded_mode).toBe(false);
    expect(projected.running[0]?.turn_control_state).toBe('agent_turn');
    expect(projected.running[0]?.progress_signal_state).toBe('advancing');
    expect(projected.running[0]?.token_telemetry_confidence).toBe('observed_live');
    expect(projected.running[0]?.budget_status).toBe('ok');
    expect(projected.running[0]?.budget_usage_tokens).toBeNull();
    expect(projected.running[0] as unknown as Record<string, unknown>).not.toHaveProperty('tool_call_ledger');
    expect(projected.running[0]?.transcript_tool_call_diagnostic_summary).toMatchObject({
      detailed_diagnostics_available: true,
      total_count: 0,
      detail_url: '/api/v1/issues/ABC-1/diagnostics',
      newest_observed_at: '2026-04-10T10:01:07.000Z',
      newest_observed_at_ms: Date.parse('2026-04-10T10:01:07.000Z')
    });
    expect(JSON.stringify(projected.running[0])).not.toContain('call-api-1');
    const issueDetail = service.projectIssue(state, 'ABC-1');
    expect(issueDetail.running as unknown as Record<string, unknown>).not.toHaveProperty('tool_call_ledger');
    expect(JSON.stringify(issueDetail.running)).not.toContain('call-api-1');
    expect(issueDetail.running?.transcript_tool_call_diagnostic_summary).toMatchObject({
      detailed_diagnostics_available: true,
      total_count: 0,
      detail_url: '/api/v1/issues/ABC-1/diagnostics'
    });
    const runtimeDiagnostics = service.projectIssueRuntimeDiagnostics(state, 'ABC-1');
    expect(runtimeDiagnostics.tool_call_ledger.records).toHaveLength(1);
    expect(runtimeDiagnostics.tool_call_ledger.records[0]?.call_id).toBe('call-api-1');
    expect(projected.retrying[0]?.worker_host).toBe('build-1');
    expect(projected.retrying[0]?.workspace_path).toBe('/tmp/symphony/ABC-2');
    expect(projected.retrying[0]?.stop_reason_code).toBe('turn_input_required');
    expect(projected.retrying[0]?.transcript_tool_call_diagnostic_summary).toMatchObject({
      detailed_diagnostics_available: false,
      total_count: 0,
      newest_observed_at: null,
      active_missing_tool_output: { active: false },
      recovery: { active: false, status: null, attempt_count: 0 }
    });
  });

  it('projects overdue tracker refresh retries with structured top-level cause data', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-05-11T13:05:21.648Z')
    });
    const state = makeState({
      retry_attempts: new Map([
        [
          'issue-nie-128',
          {
            issue_id: 'issue-nie-128',
            identifier: 'NIE-128',
            attempt: 1,
            due_at_ms: Date.parse('2026-05-11T12:56:21.648Z'),
            error: 'issue_state_refresh_failed: Linear request failed: TypeError: fetch failed',
            worker_host: 'hessian',
            workspace_path: '/tmp/symphony/NIE-128',
            provisioner_type: 'worktree',
            branch_name: 'feature/NIE-128',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: REASON_CODES.issueStateRefreshFailed,
            stop_reason_detail: 'issue_state_refresh_failed: Linear request failed: TypeError: fetch failed',
            previous_thread_id: 'thread-prev',
            previous_session_id: 'session-prev',
            last_phase: 'validation',
            timer_handle: {}
          }
        ]
      ])
    });

    const projected = service.projectState(state);

    expect(projected.retry_status).toMatchObject({
      total: 1,
      overdue_count: 1,
      pending_count: 0,
      entries: [
        expect.objectContaining({
          issue_identifier: 'NIE-128',
          due_state: 'overdue',
          overdue_ms: 540_000,
          reason_code: REASON_CODES.issueStateRefreshFailed,
          last_phase: 'validation',
          headline: 'Tracker refresh failed after run activity',
          operator_detail:
            'The Codex turn completed and reached post-run tracker refresh, but Symphony could not refresh the issue state from Linear before deciding the next workflow step. The scheduled retry refreshes tracker state without rerunning the completed turn.'
        })
      ]
    });
    expect(projected.retrying[0]).toMatchObject({
      issue_identifier: 'NIE-128',
      due_state: 'overdue',
      overdue_ms: 540_000,
      retry_wait_ms: null,
      stop_reason_code: REASON_CODES.issueStateRefreshFailed,
      last_phase: 'validation',
      retry_cause: expect.objectContaining({
        reason_code: REASON_CODES.issueStateRefreshFailed,
        due_state: 'overdue',
        expected_transition: 'Retry due time passed 540000ms ago; dispatch may be stuck'
      }),
      operator_explainer_hint: {
        classification: 'retrying',
        actionability: 'recommended',
        headline: 'Tracker refresh failed after run activity'
      }
    });
  });

  it('separates Symphony phase age from Codex app-server thread activity age', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            current_phase: 'implementation',
            current_phase_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
            phase_detail: 'editing files',
            last_codex_timestamp_ms: Date.parse('2026-04-10T10:04:30.000Z'),
            codex_thread_activity_at_ms: Date.parse('2026-04-10T10:04:45.000Z'),
            codex_thread_activity_source: 'app_server_protocol_thread_updated_at',
            codex_thread_activity_status: 'running'
          })
        ]
      ])
    });

    const projected = service.projectState(state);

    expect(projected.running[0]?.current_phase).toBe('implementation');
    expect(projected.running[0]?.phase_timing).toEqual({
      phase_started_at: '2026-04-10T10:01:00.000Z',
      phase_elapsed_ms: 240_000,
      source: 'symphony_phase_marker'
    });
    expect(projected.running[0]?.last_event_at).toBe('2026-04-10T10:04:30.000Z');
    expect(projected.running[0]?.codex_thread_activity).toEqual({
      thread_id: 'thread-1',
      updated_at: '2026-04-10T10:04:45.000Z',
      updated_at_ms: Date.parse('2026-04-10T10:04:45.000Z'),
      age_ms: 15_000,
      source: 'app_server_protocol_thread_updated_at',
      status: 'available',
      thread_status: 'running'
    });
  });

  it('keeps state summary bounded for multiple active runs with large transcript diagnostic histories', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            transcript_tool_call_diagnostics: Array.from({ length: 200 }, (_, index) => makeTranscriptDiagnostic(index))
          })
        ],
        [
          'issue-2',
          makeRunningEntry({
            issue: makeIssue({ id: 'issue-2', identifier: 'ABC-2' }),
            identifier: 'ABC-2',
            transcript_tool_call_diagnostics: Array.from({ length: 200 }, (_, index) =>
              makeTranscriptDiagnostic(index + 200, { active_issue_id: 'issue-2', active_issue_identifier: 'ABC-2' })
            )
          })
        ]
      ])
    });

    const projected = service.projectState(state);
    const firstRunning = projected.running[0] as unknown as Record<string, unknown>;

    expect(projected.running).toHaveLength(2);
    expect(firstRunning).not.toHaveProperty('transcript_tool_call_diagnostics');
    expect(JSON.stringify(projected.running)).not.toContain('active_issue_id');
    expect(projected.running[0]?.transcript_tool_call_diagnostic_summary).toEqual({
      detailed_diagnostics_available: true,
      total_count: 200,
      detail_url: '/api/v1/issues/ABC-1/diagnostics',
      newest_observed_at: '2026-04-10T10:04:19.000Z',
      newest_observed_at_ms: Date.parse('2026-04-10T10:04:19.000Z'),
      counts_by_lineage: {
        active_owned: 50,
        prior_stale: 50,
        external_manual: 50,
        unattributed: 50
      },
      counts_by_kind: {
        function_call: 100,
        function_call_output: 100
      },
      active_missing_tool_output: {
        active: false,
        tool_name: null,
        call_id: null,
        thread_id: null,
        turn_id: null,
        session_id: null,
        evidence_source: null
      },
      recovery: {
        active: false,
        status: null,
        attempt_count: 0,
        last_result_reason_code: null,
        previous_thread_id: null,
        replacement_thread_id: null
      }
    });
    expect(JSON.stringify(projected).length).toBeLessThan(25_000);
  });

  it('computes snapshot freshness from the source snapshot timestamp', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:02:40.000Z')
    });

    const projected = service.projectState(
      makeState({
        snapshot_generated_at_ms: Date.parse('2026-04-10T10:02:00.000Z')
      })
    );

    expect(projected.snapshot_generated_at_ms).toBe(Date.parse('2026-04-10T10:02:00.000Z'));
    expect(projected.snapshot_age_ms).toBe(40_000);
    expect(projected.snapshot_freshness_state).toBe('stale');
  });

  it('projects additive budget fields for running and blocked rows', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            budget: {
              budget_usage_tokens: 80,
              budget_limit_tokens: 100,
              budget_window_minutes: 1440,
              budget_status: 'warning',
              budget_policy: 'block_requires_resume',
              budget_message: null
            }
          })
        ]
      ]),
      blocked_inputs: new Map([
        [
          'issue-2',
          {
            issue_id: 'issue-2',
            issue_identifier: 'ABC-2',
            attempt: 1,
            worker_host: null,
            workspace_path: null,
            provisioner_type: null,
            branch_name: null,
            repo_root: null,
            workspace_exists: false,
            workspace_git_status: null,
            workspace_provisioned: false,
            workspace_is_git_worktree: false,
            stop_reason_code: 'operator_action_required_budget_limit_exceeded',
            stop_reason_detail: 'Budget hard limit exceeded. Continuation blocked until manual resume.',
            conflict_files: [],
            resolution_hints: [],
            previous_thread_id: null,
            previous_session_id: null,
            blocked_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            requires_manual_resume: true,
            budget: {
              budget_usage_tokens: 105,
              budget_limit_tokens: 100,
              budget_window_minutes: 1440,
              budget_status: 'hard_limited',
              budget_policy: 'block_requires_resume',
              budget_message: 'Budget hard limit exceeded. Continuation blocked until manual resume.'
            }
          }
        ]
      ])
    });

    const projected = service.projectState(state);
    expect(projected.running[0]).toMatchObject({
      budget_usage_tokens: 80,
      budget_limit_tokens: 100,
      budget_window_minutes: 1440,
      budget_status: 'warning',
      budget_policy: 'block_requires_resume'
    });
    expect(projected.blocked[0]).toMatchObject({
      budget_usage_tokens: 105,
      budget_status: 'hard_limited',
      budget_message: 'Budget hard limit exceeded. Continuation blocked until manual resume.'
    });

    const issue = service.projectIssue(state, 'ABC-2');
    expect(issue.blocked).toMatchObject({
      budget_usage_tokens: 105,
      budget_status: 'hard_limited',
      budget_policy: 'block_requires_resume'
    });
  });

  it('projects running awaiting-input and stalled-waiting fields with redacted preview', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            awaiting_input_since_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            pending_input_preview: {
              type: 'turn_input_required',
              prompt_preview: 'email admin@example.com api_key=abc123',
              option_count: 2
            },
            stalled_waiting_since_ms: Date.parse('2026-04-10T10:03:00.000Z'),
            stalled_waiting_reason: 'turn_waiting_threshold_exceeded',
            last_progress_transition_at_ms: Date.parse('2026-04-10T10:04:00.000Z')
          })
        ]
      ])
    });
    const projected = service.projectState(state);
    expect(projected.running[0]?.awaiting_input).toBe(true);
    expect(projected.running[0]?.awaiting_input_since_ms).toBe(Date.parse('2026-04-10T10:04:00.000Z'));
    expect(projected.running[0]?.pending_input_preview?.prompt_preview).toContain('***REDACTED***');
    expect(projected.running[0]?.stalled_waiting).toBe(true);
    expect(projected.running[0]?.stalled_waiting_reason).toBe('turn_waiting_threshold_exceeded');
    expect(projected.running[0]?.turn_control_state).toBe('operator_turn');
    expect(projected.running[0]?.progress_signal_state).toBe('stalled_waiting');
    expect(projected.running[0]?.not_blocked_explainer_code).toBe('awaiting_classifier_transition');
    expect(projected.counts.running_stalled_waiting_count).toBe(1);
    expect(projected.counts.running_awaiting_input_count).toBe(0);
    expect(projected.running[0]?.operator_explainer_hint).toEqual({
      classification: 'stalled_waiting',
      actionability: 'required',
      headline: 'Run is alive but waiting too long'
    });
    expect(projected.running[0]?.current_blocker_class).toBe('stalled_waiting');
    expect(projected.running[0]?.time_since_progress).toBe(60000);
    expect(projected.running[0]?.last_successful_step).toBe('codex.turn.completed: done');

    const issue = service.projectIssue(state, 'ABC-1');
    expect(issue.operator_explainer).toMatchObject({
      version: expect.any(String),
      classification: 'stalled_waiting',
      actionability: 'required',
      headline: 'Run is alive but waiting too long',
      detail: expect.any(String),
      recommended_actions: ['Inspect issue diagnostics', 'Cancel the current turn', 'Requeue the run'],
      expected_transition:
        'Automatic recovery may schedule a retry; otherwise the operator can cancel the current turn or requeue.',
      reason_code: 'turn_waiting_threshold_exceeded',
      reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold'
    });
    expect(JSON.stringify(issue.operator_explainer)).toBe(JSON.stringify(service.projectIssue(state, 'ABC-1').operator_explainer));
  });

  it('projects stalled waiting state when rate-limit metadata is the latest raw event', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:08:00.000Z')
    });
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            last_event: CANONICAL_EVENT.codex.rateLimitsUpdated,
            last_event_summary: 'rate limits updated',
            last_message: 'rate limits updated',
            running_waiting_started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
            last_heartbeat_at_ms: Date.parse('2026-04-10T10:07:45.000Z'),
            last_codex_timestamp_ms: Date.parse('2026-04-10T10:07:45.000Z'),
            last_progress_transition_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
            stalled_waiting_since_ms: Date.parse('2026-04-10T10:05:00.000Z'),
            stalled_waiting_reason: REASON_CODES.turnWaitingThresholdExceeded,
            recent_events: [
              {
                at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
                event: CANONICAL_EVENT.codex.turnStarted,
                message: 'turn started'
              },
              {
                at_ms: Date.parse('2026-04-10T10:05:30.000Z'),
                event: CANONICAL_EVENT.codex.turnWaiting,
                message: 'waiting_for_turn_completion elapsed_s=330'
              },
              {
                at_ms: Date.parse('2026-04-10T10:07:45.000Z'),
                event: CANONICAL_EVENT.codex.rateLimitsUpdated,
                message: 'rate limits updated'
              }
            ],
            rate_limits: {
              primary: {
                used_percent: 11,
                window_minutes: 300,
                resets_at: Date.parse('2026-04-10T12:00:00.000Z')
              }
            }
          })
        ]
      ])
    });

    const projected = service.projectState(state);

    expect(projected.counts.running_stalled_waiting_count).toBe(1);
    expect(projected.running[0]).toMatchObject({
      last_event: CANONICAL_EVENT.codex.rateLimitsUpdated,
      stalled_waiting: true,
      progress_signal_state: 'stalled_waiting',
      current_blocker_class: 'stalled_waiting',
      stalled_waiting_reason: REASON_CODES.turnWaitingThresholdExceeded
    });
    expect(projected.running[0]?.operator_explainer_hint).toMatchObject({
      classification: 'stalled_waiting',
      actionability: 'required'
    });
  });

  it('projects active long-running waiting turns with fresh thread activity as heartbeat-only without stalled-waiting blockers', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:06:30.000Z')
    });
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            last_event: CANONICAL_EVENT.codex.turnWaiting,
            last_event_summary: 'codex turn waiting: waiting_for_turn_completion elapsed_s=390',
            last_message: 'waiting_for_turn_completion elapsed_s=390',
            running_waiting_started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
            last_heartbeat_at_ms: Date.parse('2026-04-10T10:06:30.000Z'),
            last_codex_timestamp_ms: Date.parse('2026-04-10T10:06:30.000Z'),
            last_progress_transition_at_ms: Date.parse('2026-04-10T10:06:30.000Z'),
            stalled_waiting_since_ms: Date.parse('2026-04-10T10:11:00.000Z'),
            stalled_waiting_reason: null,
            tokens: {
              input_tokens: 20,
              output_tokens: 15,
              total_tokens: 35
            },
            last_reported_tokens: {
              input_tokens: 20,
              output_tokens: 15,
              total_tokens: 35
            },
            recent_events: [
              {
                at_ms: Date.parse('2026-04-10T10:06:30.000Z'),
                event: CANONICAL_EVENT.codex.turnWaiting,
                message: 'waiting_for_turn_completion elapsed_s=390'
              }
            ]
          })
        ]
      ])
    });

    const projected = service.projectState(state);

    expect(projected.running[0]?.stalled_waiting).toBe(false);
    expect(projected.running[0]?.stalled_waiting_since_ms).toBeNull();
    expect(projected.running[0]?.stalled_waiting_reason).toBeNull();
    expect(projected.running[0]?.progress_signal_state).toBe('heartbeat_only');
    expect(projected.counts.running_stalled_waiting_count).toBe(0);
    expect(projected.running[0]?.operator_explainer_hint?.classification).not.toBe('stalled_waiting');

    const issue = service.projectIssue(state, 'ABC-1');
    expect(issue.operator_explainer).toMatchObject({
      classification: 'healthy',
      actionability: 'none'
    });
    expect(issue.operator_explainer.reason_detail).not.toBe('codex.turn.waiting heartbeat loop exceeded threshold');
  });

  it('truncates pending input previews by UTF-8 characters after redaction', () => {
    const service = new SnapshotService();
    const prompt = `${'界'.repeat(170)} operator@example.com`;
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            awaiting_input_since_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            pending_input_preview: {
              type: 'turn_input_required',
              prompt_preview: prompt,
              option_count: 1
            }
          })
        ]
      ])
    });

    const projected = service.projectState(state);
    const preview = projected.running[0]?.pending_input_preview?.prompt_preview ?? '';
    expect(Array.from(preview)).toHaveLength(160);
    expect(preview).toBe('界'.repeat(160));
    expect(preview).not.toContain('operator@example.com');

    const issue = service.projectIssue(state, 'ABC-1');
    const issuePreview = issue.running?.pending_input_preview?.prompt_preview ?? '';
    expect(Array.from(issuePreview)).toHaveLength(160);
    expect(issuePreview).toBe('界'.repeat(160));
  });

  it('throws issue_not_found for unknown issue projection', () => {
    const service = new SnapshotService();
    const state = makeState();

    expect(() => service.projectIssue(state, 'ABC-404')).toThrow('Issue ABC-404 is not in runtime state');
  });

  it('projects blocked issue payload with blocked status and details', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      blocked_inputs: new Map([
        [
          'issue-9',
          {
            issue_id: 'issue-9',
            issue_identifier: 'ABC-9',
            attempt: 4,
            worker_host: 'build-9',
            workspace_path: '/tmp/symphony/ABC-9',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-9',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'operator_action_required_workspace_conflict',
            stop_reason_detail: 'workspace_unprovisioned_conflict: worktree_branch_conflict',
            conflict_files: [{ path: 'src/orchestrator/core.ts', status: 'unstaged' }],
            resolution_hints: ['Resolve branch/worktree mismatch before manual resume.'],
            previous_thread_id: 'thread-prev',
            previous_session_id: 'thread-prev-turn-prev',
            blocked_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            requires_manual_resume: true,
            pending_input: null,
            session_console: []
          }
        ]
      ])
    });

    const projected = service.projectIssue(state, 'ABC-9');
    expect(projected.status).toBe('blocked');
    expect(projected.retry).toBeNull();
    expect(projected.blocked).toMatchObject({
      stop_reason_code: 'operator_action_required_workspace_conflict',
      progress_signal_state: 'advancing',
      previous_session_id: 'thread-prev-turn-prev',
      requires_manual_resume: true,
      conflict_files: [{ path: 'src/orchestrator/core.ts', status: 'unstaged' }]
    });
  });

  it('projects redacted transcript scan budget diagnostics without candidate paths', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            codex_session_transcript_scan_budget: makeTranscriptScanBudget(),
            codex_session_transcript_candidate_cache: {
              ...makeTranscriptScanBudget(),
              identity_key: 'thread-1:turn-3',
              paths: ['/Users/example/.codex/sessions/2026/05/07/historical.jsonl'],
              refreshed_at_ms: Date.parse('2026-04-10T10:04:00.000Z')
            }
          })
        ]
      ])
    });

    const projected = service.projectState(state);
    const issueProjection = service.projectIssue(state, 'ABC-1');
    const runtimeDiagnostics = service.projectIssueRuntimeDiagnostics(state, 'ABC-1');

    const expectedBudget = {
      observed_at: '2026-04-10T10:04:00.000Z',
      observed_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
      candidate_count: 10,
      files_considered: 3,
      files_parsed: 2,
      bytes_read: 4096,
      exhausted: true,
      reason_codes: ['transcript_probe_byte_budget_exhausted', 'transcript_scan_wall_clock_budget_exhausted'],
      limits: {
        max_candidate_files: 12,
        max_discovery_files: 20,
        max_probe_bytes: 8192,
        max_scan_bytes: 16384,
        max_file_age_ms: 86_400_000,
        max_wall_clock_ms: 25
      }
    };
    expect(projected.running[0]?.codex_session_transcript_scan_budget).toEqual(expectedBudget);
    expect(issueProjection.running?.codex_session_transcript_scan_budget).toEqual(expectedBudget);
    expect(runtimeDiagnostics.codex_session_transcript_scan_budget).toEqual(expectedBudget);
    expect(JSON.stringify(projected.running)).not.toContain('/Users/example/.codex/sessions');
    expect(JSON.stringify(issueProjection)).not.toContain('/Users/example/.codex/sessions');
    expect(JSON.stringify(runtimeDiagnostics)).not.toContain('/Users/example/.codex/sessions');
  });

  it('projects missing-tool-output blocked diagnostics as actionable API data', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      blocked_inputs: new Map([
        [
          'issue-tool',
          {
            issue_id: 'issue-tool',
            issue_identifier: 'ABC-TOOL',
            attempt: 1,
            worker_host: null,
            workspace_path: null,
            provisioner_type: null,
            branch_name: null,
            repo_root: null,
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: REASON_CODES.missingToolOutput,
            stop_reason_detail:
              'tool_name=linear_graphql call_id=call_pfKTUH5GFubLHpXfln7UScnU thread_id=thread-1 turn_id=turn-1 session_id=session-1 elapsed_wait_ms=2000',
            conflict_files: [],
            resolution_hints: ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run'],
            previous_thread_id: 'thread-1',
            previous_session_id: 'session-1',
            blocked_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            requires_manual_resume: true,
            pending_input: null,
            tool_output_wait: {
              tool_name: 'linear_graphql',
              call_id: 'call_pfKTUH5GFubLHpXfln7UScnU',
              thread_id: 'thread-1',
              turn_id: 'turn-1',
              session_id: 'session-1',
              elapsed_wait_ms: 2000,
              last_agent_message: 'waiting for linear_graphql output',
              evidence_source: 'session_transcript',
              recommended_actions: ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run']
            },
            transcript_tool_call_diagnostics: [
              makeTranscriptDiagnostic(0, {
                lineage: 'active_owned',
                kind: 'function_call',
                observed_at_ms: Date.parse('2026-04-10T10:04:01.000Z')
              }),
              makeTranscriptDiagnostic(1, {
                lineage: 'prior_stale',
                kind: 'function_call_output',
                observed_at_ms: Date.parse('2026-04-10T10:04:02.000Z')
              }),
              makeTranscriptDiagnostic(2, {
                lineage: 'external_manual',
                kind: 'function_call',
                observed_at_ms: Date.parse('2026-04-10T10:04:03.000Z')
              }),
              makeTranscriptDiagnostic(3, {
                lineage: 'unattributed',
                kind: 'function_call_output',
                observed_at_ms: Date.parse('2026-04-10T10:04:04.000Z')
              })
            ],
            recovery: {
              attempt_count: 1,
              started_at_ms: Date.parse('2026-04-10T10:04:10.000Z'),
              reason_code: REASON_CODES.missingToolOutput,
              mode: 'same_thread_guarded_continuation',
              previous_thread_id: 'thread-1',
              previous_turn_id: 'turn-1',
              previous_session_id: 'session-1',
              replacement_thread_id: 'thread-2',
              replacement_turn_id: 'turn-2',
              replacement_session_id: 'session-2',
              previous_worker_handle_known: true,
              previous_codex_app_server_pid: '12345',
              last_tool_name: 'linear_graphql',
              last_call_id: 'call_pfKTUH5GFubLHpXfln7UScnU',
              evidence_source: 'session_transcript',
              elapsed_wait_ms: 2000,
              last_agent_message: 'waiting for linear_graphql output',
              last_observed_phase: 'implementation',
              last_observed_phase_detail: 'waiting for tool output',
              recent_event_count: 1,
              quarantined_event_count: 0,
              prompt_hash: 'hash-1',
              prompt_summary: 'Recover missing linear_graphql output.',
              last_result: 'blocked',
              last_result_reason_code: 'guarded_continuation_waiting',
              last_result_detail: 'waiting for replacement turn'
            },
            session_console: []
          }
        ]
      ])
    });

    const stateProjection = service.projectState(state);
    expect(stateProjection.counts.blocked).toBe(1);
    expect(stateProjection.blocked[0]).toMatchObject({
      stop_reason_code: REASON_CODES.missingToolOutput,
      requires_manual_resume: true,
      turn_control_state: 'blocked_manual_resume',
      progress_signal_state: 'stalled_waiting',
      tool_output_wait: {
        tool_name: 'linear_graphql',
        call_id: 'call_pfKTUH5GFubLHpXfln7UScnU',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        session_id: 'session-1',
        elapsed_wait_ms: 2000,
        last_agent_message: 'waiting for linear_graphql output',
        evidence_source: 'session_transcript',
        recommended_actions: ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run']
      },
      transcript_tool_call_diagnostic_summary: {
        detailed_diagnostics_available: true,
        total_count: 4,
        detail_url: '/api/v1/issues/ABC-TOOL/diagnostics',
        newest_observed_at: '2026-04-10T10:04:04.000Z',
        newest_observed_at_ms: Date.parse('2026-04-10T10:04:04.000Z'),
        counts_by_lineage: {
          active_owned: 1,
          prior_stale: 1,
          external_manual: 1,
          unattributed: 1
        },
        counts_by_kind: {
          function_call: 2,
          function_call_output: 2
        },
        active_missing_tool_output: {
          active: true,
          tool_name: 'linear_graphql',
          call_id: 'call_pfKTUH5GFubLHpXfln7UScnU',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          session_id: 'session-1',
          evidence_source: 'session_transcript'
        },
        recovery: {
          active: true,
          status: 'blocked',
          attempt_count: 1,
          last_result_reason_code: 'guarded_continuation_waiting',
          previous_thread_id: 'thread-1',
          replacement_thread_id: 'thread-2'
        }
      },
      missing_tool_output_recovery: {
        status: 'manual_action_required',
        headline: 'Missing-output recovery needs operator action',
        original_tool_name: 'linear_graphql',
        original_call_id: 'call_pfKTUH5GFubLHpXfln7UScnU',
        evidence_source: 'session_transcript',
        active_ownership: {
          issue_id: 'issue-tool',
          issue_identifier: 'ABC-TOOL',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          session_id: 'session-1',
          app_server_owned: false
        },
        interrupt_cancel_result: {
          status: 'not_started',
          reason_code: null
        },
        guarded_prompt_dispatch: {
          status: 'not_started'
        },
        final_outcome: {
          result: 'blocked'
        }
      }
    });
    expect(stateProjection.blocked[0] as unknown as Record<string, unknown>).not.toHaveProperty(
      'transcript_tool_call_diagnostics'
    );
    expect(JSON.stringify(stateProjection.blocked[0])).not.toContain('active_issue_id');

    const issueProjection = service.projectIssue(state, 'ABC-TOOL');
    expect(issueProjection.status).toBe('blocked');
    expect(issueProjection.blocked?.tool_output_wait?.call_id).toBe('call_pfKTUH5GFubLHpXfln7UScnU');
    expect(issueProjection.blocked as unknown as Record<string, unknown>).not.toHaveProperty('transcript_tool_call_diagnostics');
    expect(issueProjection.blocked?.transcript_tool_call_diagnostic_summary.detail_url).toBe(
      '/api/v1/issues/ABC-TOOL/diagnostics'
    );
    expect(issueProjection.blocked?.missing_tool_output_recovery?.next_action).toContain('Inspect current external state');
    expect(issueProjection.operator_explainer.reason_code).toBe(REASON_CODES.missingToolOutput);
  });

  it('projects bounded issue runtime diagnostics with pagination metadata', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            transcript_tool_call_diagnostics: Array.from({ length: 8 }, (_, index) => makeTranscriptDiagnostic(index)),
            tool_call_ledger: Object.fromEntries(
              Array.from({ length: 5 }, (_, index) => [
                `call-${index}`,
                {
                  call_id: `call-${index}`,
                  tool_name: 'linear_graphql',
                  thread_id: 'thread-1',
                  turn_id: 'turn-1',
                  session_id: 'session-1',
                  issue_id: 'issue-1',
                  issue_identifier: 'ABC-1',
                  run_id: 'run-1',
                  issue_run_id: 'issue-run-1',
                  attempt_id: 'attempt-1',
                  first_seen_at_ms: Date.parse('2026-04-10T10:01:00.000Z') + index * 1000,
                  last_seen_at_ms: Date.parse('2026-04-10T10:02:00.000Z') + index * 1000,
                  completed_at_ms: null,
                  completion_status: 'pending',
                  evidence_sources: ['session_transcript'],
                  start_evidence_source: 'session_transcript',
                  completion_evidence_source: null,
                  last_agent_message: 'waiting for output'
                }
              ])
            )
          })
        ]
      ])
    });

    const diagnostics = service.projectIssueRuntimeDiagnostics(state, 'ABC-1', { limit: 3, offset: 2 });

    expect(diagnostics.status).toBe('running');
    expect(diagnostics.transcript_tool_call_diagnostics.metadata).toEqual({
      total_available_count: 8,
      included_count: 3,
      limit: 3,
      offset: 2,
      has_more: true,
      truncated: true,
      oldest_observed_at: '2026-04-10T10:01:03.000Z',
      oldest_observed_at_ms: Date.parse('2026-04-10T10:01:03.000Z'),
      newest_observed_at: '2026-04-10T10:01:05.000Z',
      newest_observed_at_ms: Date.parse('2026-04-10T10:01:05.000Z')
    });
    expect(diagnostics.transcript_tool_call_diagnostics.records.map((record) => record.call_id)).toEqual([
      'call-5',
      'call-4',
      'call-3'
    ]);
    expect(diagnostics.tool_call_ledger.metadata).toMatchObject({
      total_available_count: 5,
      included_count: 3,
      limit: 3,
      offset: 2,
      has_more: false,
      truncated: true
    });
    expect(diagnostics.tool_call_ledger.records.map((record) => record.call_id)).toEqual(['call-2', 'call-1', 'call-0']);
    expect(JSON.stringify(diagnostics)).toContain('"active_issue_id"');
  });

  it('only projects no-progress blocked issues as stalled waiting', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      blocked_inputs: new Map([
        [
          'issue-stalled',
          {
            issue_id: 'issue-stalled',
            issue_identifier: 'ABC-STALLED',
            attempt: 2,
            worker_host: null,
            workspace_path: null,
            provisioner_type: null,
            branch_name: null,
            repo_root: null,
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
            stop_reason_detail: 'completion gate blocked redispatch because no progress signal was detected',
            conflict_files: [],
            resolution_hints: [],
            previous_thread_id: null,
            previous_session_id: null,
            blocked_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            requires_manual_resume: true,
            last_progress_checkpoint_at: null,
            pending_input: null,
            session_console: []
          }
        ]
      ])
    });

    const projected = service.projectIssue(state, 'ABC-STALLED');
    expect(projected.blocked?.progress_signal_state).toBe('stalled_waiting');
    expect(projected.blocked?.last_progress_transition_at_ms).toBeNull();
  });

  it('projects failed last-phase detail as root cause separate from current operator latch', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      blocked_inputs: new Map([
        [
          'issue-dirty',
          {
            issue_id: 'issue-dirty',
            issue_identifier: 'ABC-DIRTY',
            attempt: 2,
            worker_host: null,
            workspace_path: null,
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-DIRTY',
            repo_root: '/repo/root',
            workspace_exists: false,
            workspace_git_status: 'dirty',
            workspace_provisioned: false,
            workspace_is_git_worktree: false,
            stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
            stop_reason_detail: 'completion gate blocked redispatch because no progress signal was detected',
            conflict_files: [],
            resolution_hints: [],
            previous_thread_id: null,
            previous_session_id: null,
            blocked_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            requires_manual_resume: true,
            last_phase: 'failed',
            last_phase_detail: 'workspace_provision_failed: worktree_dirty_repo',
            pending_input: null,
            session_console: []
          }
        ]
      ])
    });

    const stateProjection = service.projectState(state);
    expect(stateProjection.blocked[0]).toMatchObject({
      stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
      current_operator_block: {
        reason_code: 'operator_action_required_no_progress_redispatch_blocked',
        detail: 'completion gate blocked redispatch because no progress signal was detected'
      },
      root_cause: {
        phase: 'failed',
        reason_code: 'worktree_dirty_repo',
        summary: 'Workspace provisioning failed: repo root has uncommitted or untracked files.',
        detail: 'workspace_provision_failed: worktree_dirty_repo',
        remediation_hint: 'Clean, commit, or ignore the dirty repo files, then requeue or resume.',
        differs_from_current_operator_block: true
      }
    });

    const issueProjection = service.projectIssue(state, 'ABC-DIRTY');
    expect(issueProjection.blocked?.root_cause?.reason_code).toBe('worktree_dirty_repo');
    expect(issueProjection.blocked?.current_operator_block.reason_code).toBe(
      'operator_action_required_no_progress_redispatch_blocked'
    );
  });

  it('projects breaker metadata on state and issue blocked payloads', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      blocked_inputs: new Map([
        [
          'issue-9',
          {
            issue_id: 'issue-9',
            issue_identifier: 'ABC-9',
            attempt: 4,
            worker_host: null,
            workspace_path: null,
            provisioner_type: null,
            branch_name: null,
            repo_root: null,
            workspace_exists: true,
            workspace_git_status: 'dirty',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
            stop_reason_detail: 'blocked',
            conflict_files: [],
            resolution_hints: [],
            previous_thread_id: null,
            previous_session_id: null,
            blocked_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            requires_manual_resume: true,
            pending_input: null,
            session_console: []
          }
        ]
      ]),
      circuit_breakers: new Map([
        [
          'issue-9',
          {
            issue_id: 'issue-9',
            issue_identifier: 'ABC-9',
            breaker_active: true,
            breaker_hit_count: 5,
            breaker_window_minutes: 30,
            breaker_first_hit_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
            breaker_last_hit_at_ms: Date.parse('2026-04-10T10:04:00.000Z')
          }
        ]
      ])
    });

    const stateProjection = service.projectState(state);
    expect(stateProjection.blocked[0]).toMatchObject({
      issue_identifier: 'ABC-9',
      operator_explainer_hint: {
        classification: 'failed',
        actionability: 'recommended',
        headline: 'Redispatch stopped after no progress'
      },
      breaker_active: true,
      breaker_hit_count: 5,
      breaker_window_minutes: 30,
      breaker_first_hit_at: '2026-04-10T10:00:00.000Z',
      breaker_last_hit_at: '2026-04-10T10:04:00.000Z'
    });

    const issueProjection = service.projectIssue(state, 'ABC-9');
    expect(issueProjection.status).toBe('blocked');
    expect(issueProjection.operator_explainer).toMatchObject({
      classification: 'failed',
      actionability: 'recommended',
      reason_code: 'operator_action_required_no_progress_redispatch_blocked'
    });
    expect(issueProjection.blocked?.stop_reason_code).toBe('operator_action_required_no_progress_redispatch_blocked');
  });

  it('projects circuit-breaker-only no-progress faults without input-required latches', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      circuit_breakers: new Map([
        [
          'issue-breaker-only',
          {
            issue_id: 'issue-breaker-only',
            issue_identifier: 'ABC-BREAKER',
            breaker_active: true,
            breaker_hit_count: 3,
            breaker_window_minutes: 30,
            breaker_first_hit_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
            breaker_last_hit_at_ms: Date.parse('2026-04-10T10:04:00.000Z')
          }
        ]
      ])
    });

    const stateProjection = service.projectState(state);
    expect(stateProjection.counts.blocked).toBe(1);
    expect(stateProjection.blocked).toHaveLength(1);
    expect(stateProjection.blocked[0]).toMatchObject({
      issue_id: 'issue-breaker-only',
      issue_identifier: 'ABC-BREAKER',
      stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
      stop_reason_detail:
        'Completion gate stopped redispatch because no progress signal was detected; no answerable input payload is pending.',
      pending_input: null,
      requires_manual_resume: false,
      awaiting_operator: false,
      breaker_active: true,
      breaker_hit_count: 3,
      breaker_window_minutes: 30,
      breaker_first_hit_at: '2026-04-10T10:00:00.000Z',
      breaker_last_hit_at: '2026-04-10T10:04:00.000Z',
      runtime_state_kind: 'automation_fault',
      available_actions: [
        {
          id: 'clear_automation_fault',
          label: 'Clear Fault + Retry',
          endpoint: '/api/v1/issues/ABC-BREAKER/clear-automation-fault',
          method: 'POST',
          requires_reason_note: true,
          destructive: false
        }
      ],
      operator_explainer_hint: {
        classification: 'failed',
        actionability: 'recommended',
        headline: 'Redispatch stopped after no progress'
      }
    });
  });

  it('returns issue detail for circuit-breaker-only no-progress faults', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      circuit_breakers: new Map([
        [
          'issue-breaker-only',
          {
            issue_id: 'issue-breaker-only',
            issue_identifier: 'ABC-BREAKER',
            breaker_active: true,
            breaker_hit_count: 3,
            breaker_window_minutes: 30,
            breaker_first_hit_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
            breaker_last_hit_at_ms: Date.parse('2026-04-10T10:04:00.000Z')
          }
        ]
      ])
    });

    const issueProjection = service.projectIssue(state, 'ABC-BREAKER');
    expect(issueProjection.status).toBe('blocked');
    expect(issueProjection.operator_explainer).toMatchObject({
      classification: 'failed',
      actionability: 'recommended',
      reason_code: 'operator_action_required_no_progress_redispatch_blocked'
    });
    expect(issueProjection.blocked).toMatchObject({
      issue_id: 'issue-breaker-only',
      stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
      pending_input: null,
      requires_manual_resume: false,
      awaiting_operator: false,
      breaker_active: true,
      breaker_hit_count: 3,
      runtime_state_kind: 'automation_fault',
      available_actions: [
        {
          id: 'clear_automation_fault',
          label: 'Clear Fault + Retry',
          endpoint: '/api/v1/issues/ABC-BREAKER/clear-automation-fault',
          method: 'POST',
          requires_reason_note: true,
          destructive: false
        }
      ]
    });
  });

  it('projects failed health state and issue recent events for diagnostics', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:02:00.000Z')
    });

    const state = makeState({
      health: {
        dispatch_validation: 'failed',
        last_error: 'dispatch preflight rejected dispatch'
      },
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            recent_events: [
              {
                at_ms: Date.parse('2026-04-10T10:01:30.000Z'),
                event: CANONICAL_EVENT.codex.turnStarted,
                message: null
              },
              {
                at_ms: Date.parse('2026-04-10T10:01:45.000Z'),
                event: CANONICAL_EVENT.codex.turnCompleted,
                message: 'done'
              }
            ]
          })
        ]
      ])
    });

    const projected = service.projectState(state);
    expect(projected.health.dispatch_validation).toBe('failed');
    expect(projected.health.last_error).toContain('dispatch preflight');

    const issue = service.projectIssue(state, 'ABC-1');
    expect(issue.workspace.path).toBe('/tmp/symphony/ABC-1');
    expect(issue.workspace.host).toBeNull();
    expect(issue.running?.thread_id).toBe('thread-1');
    expect(issue.running?.turn_id).toBe('turn-3');
    expect(issue.running?.codex_app_server_pid).toBe('12345');
    expect(issue.running?.last_event_summary).toBe('codex turn completed: done');
    expect(issue.recent_events).toHaveLength(2);
    expect(issue.recent_events[1]?.event).toBe(CANONICAL_EVENT.codex.turnCompleted);
    expect(issue.logs.codex_session_logs).toEqual([]);
    expect(issue.tracked).toEqual({});
  });

  it('preserves protocol evidence in blocked-only issue recent events', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:02:00.000Z')
    });

    const state = makeState({
      blocked_inputs: new Map([
        [
          'issue-1',
          {
            issue_id: 'issue-1',
            issue_identifier: 'ABC-1',
            attempt: 1,
            worker_host: null,
            workspace_path: '/tmp/symphony/ABC-1',
            provisioner_type: 'none',
            branch_name: null,
            repo_root: null,
            workspace_exists: true,
            workspace_git_status: 'unknown',
            workspace_provisioned: false,
            workspace_is_git_worktree: false,
            stop_reason_code: REASON_CODES.unsupportedApprovalServerRequest,
            stop_reason_detail: 'approval request failed closed',
            conflict_files: [],
            resolution_hints: ['Inspect the Codex thread'],
            previous_thread_id: 'thread-1',
            previous_session_id: 'session-1',
            blocked_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
            requires_manual_resume: true,
            required_actions: ['Inspect the Codex thread'],
            pending_input: null,
            session_console: [
              {
                at_ms: Date.parse('2026-04-10T10:01:30.000Z'),
                event: CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch,
                message: 'dynamic tool capability mismatch',
                reason_code: REASON_CODES.unsupportedDynamicToolConsoleResume,
                request_method: 'tools/call',
                request_category: 'dynamic_tool',
                tool_call_id: 'call-dynamic-1',
                tool_name: 'linear_graphql',
                protocol_warning: {
                  method: 'tools/call',
                  reason_code: REASON_CODES.codexProtocolGuardianWarning,
                  message: 'guardian policy warning',
                  severity: 'warn',
                  source: 'app_server_protocol'
                },
                model_reroute: {
                  requested_model: 'gpt-requested',
                  effective_model: 'gpt-effective',
                  reason_code: REASON_CODES.codexModelRerouted,
                  source: 'app_server_protocol'
                },
                requested_model: 'gpt-requested',
                effective_model: 'gpt-effective'
              }
            ]
          }
        ]
      ])
    });

    const issue = service.projectIssue(state, 'ABC-1');

    expect(issue.recent_events).toEqual([
      expect.objectContaining({
        at: '2026-04-10T10:01:30.000Z',
        event: CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch,
        reason_code: REASON_CODES.unsupportedDynamicToolConsoleResume,
        request_method: 'tools/call',
        request_category: 'dynamic_tool',
        tool_call_id: 'call-dynamic-1',
        tool_name: 'linear_graphql',
        protocol_warning: expect.objectContaining({
          method: 'tools/call',
          reason_code: REASON_CODES.codexProtocolGuardianWarning
        }),
        model_reroute: expect.objectContaining({
          requested_model: 'gpt-requested',
          effective_model: 'gpt-effective'
        }),
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective'
      })
    ]);
  });

  it('projects active recent events separately from stale same-issue diagnostics', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:02:00.000Z')
    });

    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            thread_id: 'fresh-thread',
            turn_id: 'fresh-turn',
            session_id: 'fresh-session',
            codex_app_server_pid: '2002',
            last_event: CANONICAL_EVENT.codex.turnStarted,
            last_event_summary: 'codex turn started',
            last_message: null,
            last_codex_timestamp_ms: Date.parse('2026-04-10T10:01:30.000Z'),
            recent_events: [
              {
                at_ms: Date.parse('2026-04-10T10:01:30.000Z'),
                event: CANONICAL_EVENT.codex.turnStarted,
                message: null
              }
            ],
            quarantined_event_count: 2,
            last_quarantined_event_at_ms: Date.parse('2026-04-10T10:01:45.000Z'),
            quarantined_events: [
              {
                at_ms: Date.parse('2026-04-10T10:01:45.000Z'),
                event: CANONICAL_EVENT.codex.turnWaiting,
                message: 'late prior-review heartbeat',
                codex_app_server_pid: '1001',
                thread_id: 'review-thread',
                turn_id: 'review-turn',
                session_id: 'review-session',
                active_codex_app_server_pid: '2002',
                active_thread_id: 'fresh-thread',
                active_turn_id: 'fresh-turn',
                active_session_id: 'fresh-session',
                reason: 'lineage_mismatch'
              },
              {
                at_ms: Date.parse('2026-04-10T10:01:50.000Z'),
                event: CANONICAL_EVENT.codex.phasePlanning,
                message: 'late planning after task_complete',
                codex_app_server_pid: '2002',
                thread_id: 'fresh-thread',
                turn_id: 'fresh-turn',
                session_id: 'fresh-session',
                active_codex_app_server_pid: '2002',
                active_thread_id: 'fresh-thread',
                active_turn_id: 'fresh-turn',
                active_session_id: 'fresh-session',
                reason: 'terminal_residue'
              }
            ]
          })
        ]
      ])
    });

    const issue = service.projectIssue(state, 'ABC-1');
    expect(issue.running?.thread_id).toBe('fresh-thread');
    expect(issue.running?.codex_app_server_pid).toBe('2002');
    expect(issue.running?.quarantined_event_count).toBe(2);
    expect(issue.recent_events).toEqual([
      {
        at: '2026-04-10T10:01:30.000Z',
        event: CANONICAL_EVENT.codex.turnStarted,
        message: null
      }
    ]);
    expect(issue.stale_events).toEqual([
      expect.objectContaining({
        at: '2026-04-10T10:01:45.000Z',
        event: CANONICAL_EVENT.codex.turnWaiting,
        message: 'late prior-review heartbeat',
        codex_app_server_pid: '1001',
        thread_id: 'review-thread',
        turn_id: 'review-turn',
        session_id: 'review-session',
        active_codex_app_server_pid: '2002',
        active_thread_id: 'fresh-thread',
        active_turn_id: 'fresh-turn',
        active_session_id: 'fresh-session',
        reason: 'lineage_mismatch'
      }),
      expect.objectContaining({
        at: '2026-04-10T10:01:50.000Z',
        event: CANONICAL_EVENT.codex.phasePlanning,
        message: 'late planning after task_complete',
        codex_app_server_pid: '2002',
        thread_id: 'fresh-thread',
        turn_id: 'fresh-turn',
        session_id: 'fresh-session',
        active_codex_app_server_pid: '2002',
        active_thread_id: 'fresh-thread',
        active_turn_id: 'fresh-turn',
        active_session_id: 'fresh-session',
        reason: 'terminal_residue'
      })
    ]);

    const projectedState = service.projectState(state);
    expect(projectedState.running[0]?.thread_id).toBe('fresh-thread');
    expect(projectedState.running[0]?.codex_app_server_pid).toBe('2002');
    expect(projectedState.running[0]?.quarantined_event_count).toBe(2);
  });

  it('filters stale operator actions from running issue detail projections', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:02:00.000Z')
    });

    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            run_id: 'fresh-run',
            attempt_id: 'fresh-attempt',
            thread_id: 'fresh-thread',
            turn_id: 'fresh-turn',
            session_id: 'fresh-session',
            started_at_ms: Date.parse('2026-04-10T10:01:00.000Z')
          })
        ]
      ]),
      operator_actions: new Map([
        [
          'issue-1',
          [
            {
              action: 'cancel',
              requested_at_ms: Date.parse('2026-04-10T10:00:30.000Z'),
              result: 'accepted',
              result_code: 'current_turn_cancelled',
              message: 'cancel accepted',
              target_identifiers: {
                issue_id: 'issue-1',
                issue_identifier: 'ABC-1',
                run_id: 'old-run',
                attempt_id: 'old-attempt',
                thread_id: 'old-thread',
                turn_id: 'old-turn',
                session_id: 'old-session'
              }
            },
            {
              action: 'resume',
              requested_at_ms: Date.parse('2026-04-10T10:01:30.000Z'),
              result: 'accepted',
              result_code: 'resume_accepted',
              message: 'resume accepted',
              target_identifiers: {
                issue_id: 'issue-1',
                issue_identifier: 'ABC-1',
                run_id: 'fresh-run',
                attempt_id: 'fresh-attempt',
                thread_id: 'fresh-thread',
                turn_id: 'fresh-turn',
                session_id: 'fresh-session'
              }
            }
          ]
        ]
      ])
    });

    const issue = service.projectIssue(state, 'ABC-1');
    expect(issue.operator_actions).toEqual([
      expect.objectContaining({
        action: 'resume',
        result_code: 'resume_accepted'
      })
    ]);
    expect(issue.running?.operator_actions).toEqual([
      expect.objectContaining({
        action: 'resume',
        result_code: 'resume_accepted'
      })
    ]);

    const projectedState = service.projectState(state);
    expect(projectedState.running[0]?.operator_actions).toEqual([
      expect.objectContaining({
        action: 'resume',
        result_code: 'resume_accepted'
      })
    ]);
  });

  it('projects running issue retry metadata with worker and workspace context when queued', () => {
    const service = new SnapshotService();
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry()
        ]
      ]),
      retry_attempts: new Map([
        [
          'issue-1',
          {
            issue_id: 'issue-1',
            identifier: 'ABC-1',
            attempt: 1,
            due_at_ms: Date.parse('2026-04-10T10:03:00.000Z'),
            error: 'retrying',
            worker_host: 'build-2',
            workspace_path: '/tmp/symphony/ABC-1',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-1',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'dirty',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'turn_input_required',
            stop_reason_detail: 'tool requestUserInput could not be auto-answered',
            conflict_files: [],
            resolution_hints: [],
            previous_thread_id: 'thread-prev',
            previous_attempt_id: 'attempt-prev',
            previous_session_id: 'thread-prev-turn-prev',
            recovery: {
              attempt_count: 1,
              started_at_ms: Date.parse('2026-04-10T10:01:30.000Z'),
              reason_code: REASON_CODES.missingToolOutput,
              mode: 'same_thread_guarded_continuation',
              previous_thread_id: 'thread-prev',
              previous_turn_id: 'turn-prev',
              previous_session_id: 'thread-prev-turn-prev',
              replacement_thread_id: 'thread-prev',
              replacement_turn_id: 'turn-replacement-success',
              replacement_session_id: 'session-replacement-success',
              previous_worker_handle_known: true,
              previous_codex_app_server_pid: '12345',
              last_tool_name: 'linear_graphql',
              last_call_id: 'call-retry-1',
              evidence_source: 'session_transcript',
              elapsed_wait_ms: 180_000,
              last_agent_message: 'waiting_for_turn_completion elapsed_s=180',
              last_observed_phase: null,
              last_observed_phase_detail: null,
              recent_event_count: 5,
              quarantined_event_count: 0,
              prompt_hash: 'hash-retry',
              prompt_summary: 'guarded recovery prompt',
              interrupt_cancel_result: {
                status: 'succeeded',
                reason_code: REASON_CODES.missingToolOutputRecoveryInterrupted,
                detail: 'interrupted previous turn'
              },
              last_result: 'succeeded'
            },
            timer_handle: {}
          }
        ]
      ])
    });

    const issue = service.projectIssue(state, 'ABC-1');
    expect(issue.retry).toMatchObject({
      attempt: 1,
      due_at: '2026-04-10T10:03:00.000Z',
      error: 'retrying',
      worker_host: 'build-2',
      workspace_path: '/tmp/symphony/ABC-1',
      provisioner_type: 'worktree',
      branch_name: 'feature/ABC-1',
      repo_root: '/tmp/source',
      workspace_exists: true,
      workspace_git_status: 'dirty',
      workspace_provisioned: true,
      workspace_is_git_worktree: true,
      copy_ignored_applied: false,
      copy_ignored_status: null,
      copy_ignored_summary: null,
      stop_reason_code: 'turn_input_required',
      stop_reason_detail: 'tool requestUserInput could not be auto-answered',
      previous_thread_id: 'thread-prev',
      previous_session_id: 'thread-prev-turn-prev',
      last_phase: null,
      last_phase_at: null,
      last_phase_detail: null
    });
    expect(issue.retry?.missing_tool_output_recovery).toMatchObject({
      status: 'succeeded',
      original_tool_name: 'linear_graphql',
      original_call_id: 'call-retry-1',
      evidence_source: 'session_transcript',
      elapsed_wait_ms: 180_000,
      active_ownership: {
        issue_id: 'issue-1',
        issue_identifier: 'ABC-1',
        attempt_id: 'attempt-prev',
        thread_id: 'thread-prev',
        turn_id: 'turn-prev',
        session_id: 'thread-prev-turn-prev',
        app_server_owned: false
      },
      replacement_turn: {
        thread_id: 'thread-prev',
        turn_id: 'turn-replacement-success',
        session_id: 'session-replacement-success'
      },
      interrupt_cancel_result: {
        status: 'succeeded',
        reason_code: REASON_CODES.missingToolOutputRecoveryInterrupted
      },
      final_outcome: {
        result: 'succeeded'
      }
    });
    expect(issue.operator_explainer).toMatchObject({
      classification: 'healthy',
      actionability: 'none'
    });
    expect(issue.retry).toMatchObject({
      stop_reason_code: 'turn_input_required'
    });
  });

  it('projects enriched optional token dimensions without breaking baseline token fields', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:02:00.000Z')
    });

    const state = makeState({
      codex_totals: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        cached_input_tokens: 4,
        reasoning_output_tokens: 3,
        model_context_window: 200000,
        seconds_running: 40
      },
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            tokens: {
              input_tokens: 11,
              output_tokens: 5,
              total_tokens: 16,
              cached_input_tokens: 2,
              reasoning_output_tokens: 1,
              model_context_window: 200000
            }
          })
        ]
      ])
    });

    const projected = service.projectState(state);
    expect(projected.codex_totals.total_tokens).toBe(30);
    expect(projected.codex_totals.cached_input_tokens).toBe(4);
    expect(projected.codex_totals.reasoning_output_tokens).toBe(3);
    expect(projected.codex_totals.model_context_window).toBe(200000);
    expect(projected.running[0]?.tokens.cached_input_tokens).toBe(2);
    expect(projected.running[0]?.tokens.reasoning_output_tokens).toBe(1);
    expect(projected.running[0]?.tokens.model_context_window).toBe(200000);
  });

  it('projects retry-only issue payload with retry workspace and host context', () => {
    const service = new SnapshotService();
    const state = makeState({
      retry_attempts: new Map([
        [
          'issue-2',
          {
            issue_id: 'issue-2',
            identifier: 'ABC-2',
            attempt: 2,
            due_at_ms: Date.parse('2026-04-10T10:02:30.000Z'),
            error: 'retrying',
            worker_host: 'build-1',
            workspace_path: '/tmp/symphony/ABC-2',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-2',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'turn_input_required',
            stop_reason_detail: 'tool requestUserInput could not be auto-answered',
            conflict_files: [],
            resolution_hints: [],
            previous_thread_id: 'thread-prev',
            previous_attempt_id: 'attempt-prev',
            previous_session_id: 'thread-prev-turn-prev',
            recovery: {
              attempt_count: 1,
              started_at_ms: Date.parse('2026-04-10T10:01:30.000Z'),
              reason_code: REASON_CODES.missingToolOutput,
              mode: 'same_thread_guarded_continuation',
              previous_thread_id: 'thread-prev',
              previous_turn_id: 'turn-prev',
              previous_session_id: 'thread-prev-turn-prev',
              replacement_thread_id: 'thread-prev',
              replacement_turn_id: 'turn-replacement-success',
              replacement_session_id: 'session-replacement-success',
              previous_worker_handle_known: true,
              previous_codex_app_server_pid: '12345',
              last_tool_name: 'linear_graphql',
              last_call_id: 'call-retry-2',
              evidence_source: 'session_transcript',
              elapsed_wait_ms: 180_000,
              last_agent_message: 'waiting_for_turn_completion elapsed_s=180',
              last_observed_phase: null,
              last_observed_phase_detail: null,
              recent_event_count: 5,
              quarantined_event_count: 0,
              prompt_hash: 'hash-retry',
              prompt_summary: 'guarded recovery prompt',
              interrupt_cancel_result: {
                status: 'succeeded',
                reason_code: REASON_CODES.missingToolOutputRecoveryInterrupted,
                detail: 'interrupted previous turn'
              },
              last_result: 'succeeded'
            },
            timer_handle: {}
          }
        ]
      ])
    });

    const projected = service.projectIssue(state, 'ABC-2');
    expect(projected.status).toBe('retrying');
    expect(projected.workspace).toEqual({
      host: 'build-1',
      path: '/tmp/symphony/ABC-2'
    });
    expect(projected.retry).toMatchObject({
      attempt: 2,
      due_at: '2026-04-10T10:02:30.000Z',
      error: 'retrying',
      worker_host: 'build-1',
      workspace_path: '/tmp/symphony/ABC-2',
      provisioner_type: 'worktree',
      branch_name: 'feature/ABC-2',
      repo_root: '/tmp/source',
      workspace_exists: true,
      workspace_git_status: 'clean',
      workspace_provisioned: true,
      workspace_is_git_worktree: true,
      copy_ignored_applied: false,
      copy_ignored_status: null,
      copy_ignored_summary: null,
      stop_reason_code: 'turn_input_required',
      stop_reason_detail: 'tool requestUserInput could not be auto-answered',
      previous_thread_id: 'thread-prev',
      previous_session_id: 'thread-prev-turn-prev',
      last_phase: null,
      last_phase_at: null,
      last_phase_detail: null
    });
    expect(projected.retry?.missing_tool_output_recovery).toMatchObject({
      status: 'succeeded',
      original_tool_name: 'linear_graphql',
      original_call_id: 'call-retry-2',
      active_ownership: {
        issue_id: 'issue-2',
        issue_identifier: 'ABC-2',
        attempt_id: 'attempt-prev',
        thread_id: 'thread-prev',
        turn_id: 'turn-prev',
        session_id: 'thread-prev-turn-prev',
        app_server_owned: false
      },
      replacement_turn: {
        thread_id: 'thread-prev',
        turn_id: 'turn-replacement-success',
        session_id: 'session-replacement-success'
      },
      final_outcome: {
        result: 'succeeded'
      }
    });
    expect(projected.operator_explainer).toMatchObject({
      classification: 'awaiting_input',
      actionability: 'required',
      expected_transition: expect.stringContaining('Retry due time passed'),
      reason_code: 'turn_input_required'
    });
    expect(projected.retry).toMatchObject({
      due_state: 'overdue',
      retry_cause: expect.objectContaining({
        expected_transition: expect.stringContaining('dispatch may be stuck')
      })
    });
  });
});
