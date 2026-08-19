import { describe, expect, it } from 'vitest';

import {
  buildProjectHistoryConsumerSummaryResponse,
  buildProjectHistoryHealth,
  buildProjectHistoryListResponse,
  buildProjectHistoryTicketDetailResponse
} from '../../src/api/project-history';
import type { DurableIdentity, TicketTimelineRecord } from '../../src/persistence';

function identity(overrides: Partial<DurableIdentity['ticket']> = {}): DurableIdentity {
  return {
    project: {
      key: 'project-main',
      project_root: '/repo/main',
      workflow_path: '/repo/main/WORKFLOW.md',
      workflow_hash: { status: 'present', value: 'workflow-hash' },
      repository_remote: { status: 'present', value: 'git@github.com:nielsgl/symphony.git' }
    },
    ticket: {
      key: overrides.key ?? 'ticket-abc-1',
      tracker_kind: 'linear',
      tracker_scope: { status: 'present', value: 'symphony' },
      remote_issue_id: overrides.remote_issue_id ?? 'remote-abc-1',
      human_issue_identifier: overrides.human_issue_identifier ?? 'ABC-1'
    }
  };
}

function timeline(overrides: Partial<TicketTimelineRecord> = {}): TicketTimelineRecord {
  const durableIdentity = identity();
  return {
    identity: durableIdentity,
    issue_runs: [
      {
        issue_run_id: 'issue-run-1',
        issue_id: durableIdentity.ticket.remote_issue_id,
        issue_identifier: durableIdentity.ticket.human_issue_identifier,
        identity: durableIdentity,
        started_at: '2026-04-10T10:00:00.000Z',
        ended_at: '2026-04-10T10:30:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    attempts: [
      {
        attempt_id: 'attempt-1',
        issue_run_id: 'issue-run-1',
        attempt_number: 1,
        started_at: '2026-04-10T10:00:01.000Z',
        ended_at: '2026-04-10T10:30:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    threads: [
      {
        thread_id: 'thread-1',
        attempt_id: 'attempt-1',
        started_at: '2026-04-10T10:00:02.000Z',
        ended_at: '2026-04-10T10:29:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    turns: [
      {
        turn_id: 'turn-1',
        thread_id: 'thread-1',
        turn_index: 0,
        started_at: '2026-04-10T10:00:03.000Z',
        ended_at: '2026-04-10T10:20:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    phase_spans: [
      {
        phase_span_id: 'phase-1',
        turn_id: 'turn-1',
        phase: 'implementation',
        started_at: '2026-04-10T10:01:00.000Z',
        ended_at: '2026-04-10T10:19:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    state_transitions: [
      {
        state_transition_id: 'state-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        from_status: 'In Progress',
        to_status: 'Agent Review',
        transitioned_at: '2026-04-10T10:29:30.000Z',
        status: 'succeeded',
        reason_code: 'review_ready',
        reason_detail: null
      }
    ],
    terminal_outcomes: [
      {
        terminal_outcome_id: 'outcome-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        outcome: 'succeeded',
        reason_code: 'agent_review_ready',
        reason_detail: null,
        recorded_at: '2026-04-10T10:30:00.000Z'
      }
    ],
    blockers: [
      {
        blocker_id: 'blocker-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        blocker_type: 'review_feedback',
        status: 'resolved',
        reason_code: 'review_comment_addressed',
        reason_detail: 'fixed reviewer note',
        blocked_at: '2026-04-10T10:10:00.000Z',
        resolved_at: '2026-04-10T10:15:00.000Z'
      }
    ],
    evidence_references: [
      {
        evidence_reference_id: 'evidence-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        evidence_kind: 'validation',
        uri: 'file://validation.txt',
        title: 'targeted validation',
        metadata: { command: 'npm test -- tests/api/project-history.test.ts' },
        recorded_at: '2026-04-10T10:28:00.000Z'
      }
    ],
    tracker_snapshots: [
      {
        tracker_snapshot_id: 'tracker-1',
        project_key: 'project-main',
        ticket_key: 'ticket-abc-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        tracker_kind: 'linear',
        tracker_scope_status: 'present',
        tracker_scope_value: 'symphony',
        tracker_scope_reason: null,
        remote_issue_id: durableIdentity.ticket.remote_issue_id,
        human_issue_identifier: durableIdentity.ticket.human_issue_identifier,
        title: 'Ticket ABC-1',
        tracker_status: 'Agent Review',
        assignee_status: 'unknown',
        assignee_identifier: null,
        assignee_reason: null,
        labels: ['ready-for-agent'],
        project_status: 'available',
        project_identifier: 'project-main',
        project_reason: null,
        team_status: 'available',
        team_identifier: 'Nielsgl',
        team_reason: null,
        observed_at: '2026-04-10T10:30:00.000Z',
        observation_hash: 'tracker-hash',
        duplicate_count: 1,
        last_observed_at: '2026-04-10T10:30:00.000Z'
      }
    ],
    ticket_references: [],
    operator_actions: [],
    drain_audit_events: [],
    blocked_input_events: [],
    app_server_events: [
      {
        app_server_event_id: 'app-event-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        observed_at: '2026-04-10T10:25:00.000Z',
        policy_version: 1,
        payload_class: 'protocol_lifecycle',
        detail_status: 'summary_only',
        redaction_status: 'not_required',
        source_event_id: 'event-1',
        source_event_name: 'thread/tokenUsage/updated',
        summary: 'token update',
        summary_fields: { total_tokens: 42 },
        redacted_excerpt: null,
        truncation: { truncated: false, original_bytes: 24, excerpt_bytes: 24, max_excerpt_bytes: 4096 },
        unavailable_reason_code: null,
        full_payload_stored: false
      }
    ],
    token_model_facts: [
      {
        token_model_fact_id: 'token-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        requested_model: 'gpt-5.4',
        effective_model: 'gpt-5.4',
        model_source: 'terminal_turn_summary',
        input_tokens: 20,
        output_tokens: 22,
        cached_input_tokens: null,
        reasoning_output_tokens: null,
        total_tokens: 42,
        model_context_window: null,
        telemetry_confidence: 'observed_live',
        observed_at: '2026-04-10T10:25:00.000Z'
      }
    ],
    ...overrides
  };
}

describe('Project History consumer summary', () => {
  it('projects compact read-only facts for a normal ticket', () => {
    const summary = buildProjectHistoryConsumerSummaryResponse(timeline());

    expect(summary.schema_version).toBe('symphony.project_history.consumer_summary.v1');
    expect(summary.read_only).toBe(true);
    expect(summary.deferred_capabilities).toEqual(['validation_reuse', 'phase_handoff_packets', 'drain_mode', 'operator_steering']);
    expect(summary.current_ticket_state).toMatchObject({ state: 'completed', current_status: 'Agent Review' });
    expect(summary.attempts).toMatchObject({ total: 1, repeated: false });
    expect(summary.recent_phases[0]).toMatchObject({ phase: 'implementation', status: 'succeeded' });
    expect(summary.blockers).toMatchObject({ active_count: 0, resolved_count: 1 });
    expect(summary.token_model).toMatchObject({
      status: 'present',
      total_tokens: 42,
      requested_models: ['gpt-5.4'],
      effective_models: ['gpt-5.4']
    });
    expect(summary.app_server_lite).toMatchObject({ status: 'present' });
    expect(summary.evidence_references[0]).toMatchObject({ evidence_kind: 'validation', uri: 'file://validation.txt' });
  });

  it('projects each Claude invocation once and prefers terminal per-model usage over partial snapshots', () => {
    const claudeTimeline = timeline({
      token_model_facts: [
        {
          token_model_fact_id: 'claude-partial-legacy',
          issue_run_id: 'issue-run-1',
          attempt_id: 'attempt-1',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          requested_model: 'claude-sonnet-4-6',
          effective_model: 'claude-sonnet-4-6',
          model_source: 'claude_assistant_step',
          input_tokens: 8,
          output_tokens: 2,
          cached_input_tokens: 1,
          cache_creation_input_tokens: 0,
          reasoning_output_tokens: null,
          total_tokens: null,
          model_context_window: null,
          runtime_provider: 'claude-cli',
          provider_turn_count: 1,
          estimated_cost_usd: null,
          provider_usage_status: 'partial',
          telemetry_confidence: 'provider_step',
          observed_at: '2026-04-10T10:20:00.000Z'
        },
        {
          token_model_fact_id: 'claude-final',
          issue_run_id: 'issue-run-1',
          attempt_id: 'attempt-1',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          requested_model: 'claude-sonnet-4-6',
          effective_model: 'claude-sonnet-4-6',
          model_source: 'claude_stream_result',
          input_tokens: 12,
          output_tokens: 5,
          cached_input_tokens: 3,
          cache_creation_input_tokens: 1,
          reasoning_output_tokens: null,
          total_tokens: null,
          model_context_window: null,
          runtime_provider: 'claude-cli',
          provider_turn_count: 2,
          estimated_cost_usd: 0.03,
          provider_usage_status: 'final',
          telemetry_confidence: 'provider_result',
          observed_at: '2026-04-10T10:25:00.000Z'
        },
        {
          token_model_fact_id: 'claude-model-final',
          issue_run_id: 'issue-run-1',
          attempt_id: 'attempt-1',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          requested_model: 'claude-sonnet-4-6',
          effective_model: 'claude-sonnet-4-6',
          model_source: 'claude_model_usage',
          input_tokens: 12,
          output_tokens: 5,
          cached_input_tokens: 3,
          cache_creation_input_tokens: 1,
          reasoning_output_tokens: null,
          total_tokens: null,
          model_context_window: null,
          runtime_provider: 'claude-cli',
          provider_turn_count: null,
          estimated_cost_usd: 0.03,
          provider_usage_status: 'final',
          telemetry_confidence: 'provider_result',
          observed_at: '2026-04-10T10:25:00.000Z'
        }
      ]
    });

    const detail = buildProjectHistoryTicketDetailResponse(claudeTimeline);
    expect(detail.provider_totals).toEqual([
      expect.objectContaining({
        runtime_provider: 'claude-cli',
        effective_model: null,
        ticket_phase: 'implementation',
        invocation_count: 1,
        final_invocation_count: 1,
        provider_turn_count: 2,
        input_tokens: null,
        estimated_cost_usd: null
      }),
      expect.objectContaining({
        runtime_provider: 'claude-cli',
        effective_model: 'claude-sonnet-4-6',
        ticket_phase: 'implementation',
        invocation_count: 0,
        final_invocation_count: 0,
        partial_invocation_count: 0,
        input_tokens: 12,
        output_tokens: 5,
        cache_read_tokens: 3,
        cache_creation_tokens: 1,
        provider_turn_count: null,
        estimated_cost_usd: 0.03
      })
    ]);
    const summary = buildProjectHistoryConsumerSummaryResponse(claudeTimeline);
    expect(summary.token_model.by_runtime_and_model).toEqual([
      expect.objectContaining({
        runtime_provider: 'claude-cli',
        effective_model: 'claude-sonnet-4-6',
        fact_count: 0,
        total_tokens: null,
        provider_turn_count: null,
        estimated_cost_usd: 0.03
      }),
      expect.objectContaining({
        runtime_provider: 'claude-cli',
        effective_model: 'unallocated-provider-turns',
        fact_count: 1,
        provider_turn_count: 2,
        estimated_cost_usd: null
      })
    ]);
  });

  it('does not attach a prior run outcome to the latest running attempt', () => {
    const activeTimeline = timeline({
      issue_runs: [
        ...timeline().issue_runs,
        { ...timeline().issue_runs[0], issue_run_id: 'issue-run-2', started_at: '2026-04-10T11:00:00.000Z', ended_at: null, status: 'running' }
      ],
      attempts: [
        ...timeline().attempts,
        { ...timeline().attempts[0], attempt_id: 'attempt-2', issue_run_id: 'issue-run-2', started_at: '2026-04-10T11:00:01.000Z', ended_at: null, status: 'running' }
      ]
    });

    expect(buildProjectHistoryConsumerSummaryResponse(activeTimeline).attempts.latest).toMatchObject({
      attempt_id: 'attempt-2',
      status: 'running',
      outcome: null,
      outcome_reason_code: null
    });
  });

  it('projects drain audit events in project lists and ticket timelines', () => {
    const drainEvent = {
      drain_audit_event_id: 'drain-audit-1',
      project_key: 'project-main',
      ticket_key: 'ticket-abc-1',
      issue_run_id: 'issue-run-1',
      attempt_id: 'attempt-1',
      thread_id: 'thread-1',
      turn_id: null,
      event_type: 'safe-shutdown-allowed' as const,
      actor: 'operator',
      source: 'api',
      result: 'accepted' as const,
      result_code: 'quiescent',
      reason_note: null,
      state_context: {
        safe_to_shutdown: true,
        quiescence_state: 'safe',
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
        warnings: [
          {
            category: 'stale_runtime_warning',
            count: 1,
            detail: 'Running runtime build runtime-old is stale compared with current-new',
            source: 'dispatch_safety',
            recommended_action: 'Enter Drain Mode, wait for quiescence, rebuild, and restart Symphony.'
          },
          {
            category: 'persistence_history_degraded',
            count: 1,
            detail: 'appendStateTransition.executionGraph: turn_waiting_threshold_exceeded',
            source: 'audit_health'
          }
        ],
        restart_guidance: {
          safe_to_restart: true,
          recommended_action: 'restart_runtime_to_current_build',
          pending_work: [{ state: 'Agent Review', count: 1, maintenance_eligible: false }],
          detail: 'Runtime is quiescent enough to restart; restart/update Symphony before dispatching normal work.'
        }
      },
      blocker_summaries: [],
      occurred_at: '2026-04-10T10:26:00.000Z',
      observed_at: '2026-04-10T10:26:00.000Z',
      observation_hash: 'drain-hash',
      duplicate_count: 1,
      last_observed_at: '2026-04-10T10:26:00.000Z'
    };
    const ticketTimeline = timeline({ drain_audit_events: [drainEvent] });

    const list = buildProjectHistoryListResponse({
      projectKey: 'project-main',
      timelines: [ticketTimeline],
      drainAuditEvents: [drainEvent],
      page: { limit: 50, offset: 0, has_more: false, total: 1 }
    });
    const detail = buildProjectHistoryTicketDetailResponse(ticketTimeline);

    expect(list.drain_audit_events).toEqual([drainEvent]);
    expect(list.tickets[0].summary.drain_audit_event_count).toBe(1);
    expect(list.tickets[0].facts).toEqual(
      expect.arrayContaining([expect.objectContaining({ fact: 'drain_audit_events', status: 'present' })])
    );
    expect(detail.drain_audit_events).toEqual([drainEvent]);
    expect(detail.drain_audit_events[0].state_context).toMatchObject({
      safe_to_shutdown: true,
      warnings: [
        expect.objectContaining({ category: 'stale_runtime_warning', source: 'dispatch_safety' }),
        expect.objectContaining({ category: 'persistence_history_degraded', source: 'audit_health' })
      ],
      restart_guidance: {
        safe_to_restart: true,
        recommended_action: 'restart_runtime_to_current_build',
        pending_work: [{ state: 'Agent Review', count: 1, maintenance_eligible: false }]
      }
    });
    expect(detail.latest_observed_at).toBe('2026-04-10T10:30:00.000Z');
  });

  it('marks repeated attempts and returns newest attempts first', () => {
    const summary = buildProjectHistoryConsumerSummaryResponse(
      timeline({
        attempts: [
          {
            attempt_id: 'attempt-1',
            issue_run_id: 'issue-run-1',
            attempt_number: 1,
            started_at: '2026-04-10T10:00:01.000Z',
            ended_at: '2026-04-10T10:10:00.000Z',
            status: 'failed',
            reason_code: 'worker_exit_abnormal',
            reason_detail: null
          },
          {
            attempt_id: 'attempt-2',
            issue_run_id: 'issue-run-1',
            attempt_number: 2,
            started_at: '2026-04-10T10:11:00.000Z',
            ended_at: null,
            status: 'running',
            reason_code: 'attempt_started',
            reason_detail: null
          }
        ]
      })
    );

    expect(summary.attempts).toMatchObject({
      total: 2,
      repeated: true,
      latest: { attempt_id: 'attempt-2', attempt_number: 2, status: 'running' }
    });
    expect(summary.attempts.recent.map((attempt) => attempt.attempt_id)).toEqual(['attempt-2', 'attempt-1']);
  });

  it('surfaces degraded history health without hiding available facts', () => {
    const summary = buildProjectHistoryConsumerSummaryResponse(timeline(), {
      schema_name: 'project_execution_history',
      target_version: 6,
      applied_version: 6,
      status: 'degraded',
      degraded_reason_code: 'history_write_failed',
      degraded_detail: 'appendTicketTerminalOutcome failed',
      updated_at: '2026-04-10T10:31:00.000Z',
      migrations: []
    });

    expect(summary.current_ticket_state.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact: 'history_schema',
          status: 'degraded',
          reason_code: 'history_write_failed'
        }),
        expect.objectContaining({ fact: 'token_model_summaries', status: 'present' })
      ])
    );
  });

  it('builds healthy operator history diagnostics without raw payloads', () => {
    const health = buildProjectHistoryHealth({
      persistenceHealth: {
        enabled: true,
        db_path: '/tmp/runtime.sqlite',
        retention_days: 14,
        run_count: 2,
        ticket_count: 1,
        last_pruned_at: '2026-04-11T00:00:00.000Z',
        last_prune_failure_at: null,
        last_prune_failure_reason: null,
        last_prune_failure_detail: null,
        integrity_ok: true,
        history_schema: {
          schema_name: 'project_execution_history',
          target_version: 8,
          applied_version: 8,
          status: 'healthy',
          degraded_reason_code: null,
          degraded_detail: null,
          updated_at: '2026-04-11T00:00:00.000Z',
          migrations: []
        },
        recent_write_failures: []
      },
      timelines: [timeline({ evidence_references: [] })],
      ticketCount: 1
    });

    expect(health).toMatchObject({
      status: 'healthy',
      enabled: true,
      storage: { type: 'sqlite', target: '/tmp/runtime.sqlite' },
      schema: { status: 'healthy', integrity_ok: true, target_version: 8, applied_version: 8 },
      counts: { runs: 2, tickets: 1 },
      retention: { retention_days: 14, last_prune: { status: 'succeeded' } },
      writes: { status: 'healthy', recent_failures: [] },
      projections: { status: 'healthy' },
      app_server_lite: { status: 'healthy' }
    });
    expect(JSON.stringify(health)).not.toContain('raw transcript');
    expect(health.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ fact: 'evidence_references', status: 'optional_unavailable' })])
    );
  });

  it('keeps active ticket health healthy while terminal outcome is lifecycle-pending', () => {
    const health = buildProjectHistoryHealth({
      persistenceHealth: {
        enabled: true,
        db_path: '/tmp/runtime.sqlite',
        retention_days: 14,
        run_count: 1,
        ticket_count: 1,
        last_pruned_at: '2026-04-11T00:00:00.000Z',
        last_prune_failure_at: null,
        last_prune_failure_reason: null,
        last_prune_failure_detail: null,
        integrity_ok: true,
        history_schema: {
          schema_name: 'project_execution_history',
          target_version: 8,
          applied_version: 8,
          status: 'healthy',
          degraded_reason_code: null,
          degraded_detail: null,
          updated_at: '2026-04-11T00:00:00.000Z',
          migrations: []
        },
        recent_write_failures: []
      },
      timelines: [
        timeline({
          issue_runs: [
            {
              ...timeline().issue_runs[0],
              ended_at: null,
              status: 'running'
            }
          ],
          attempts: [
            {
              ...timeline().attempts[0],
              ended_at: null,
              status: 'running'
            }
          ],
          terminal_outcomes: []
        })
      ],
      ticketCount: 1
    });

    expect(health.status).toBe('healthy');
    expect(health.projections).toMatchObject({ status: 'healthy', reason_code: null });
    expect(health.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact: 'terminal_outcome',
          status: 'lifecycle_pending',
          reason_code: 'project_history_terminal_outcome_missing'
        })
      ])
    );
  });

  it('degrades completed ticket health when the terminal outcome fact is missing', () => {
    const health = buildProjectHistoryHealth({
      persistenceHealth: {
        enabled: true,
        db_path: '/tmp/runtime.sqlite',
        retention_days: 14,
        run_count: 1,
        ticket_count: 1,
        last_pruned_at: '2026-04-11T00:00:00.000Z',
        last_prune_failure_at: null,
        last_prune_failure_reason: null,
        last_prune_failure_detail: null,
        integrity_ok: true,
        history_schema: {
          schema_name: 'project_execution_history',
          target_version: 8,
          applied_version: 8,
          status: 'healthy',
          degraded_reason_code: null,
          degraded_detail: null,
          updated_at: '2026-04-11T00:00:00.000Z',
          migrations: []
        },
        recent_write_failures: []
      },
      timelines: [
        timeline({
          terminal_outcomes: []
        })
      ],
      ticketCount: 1
    });

    expect(health.status).toBe('degraded');
    expect(health.projections).toMatchObject({
      status: 'degraded',
      reason_code: 'project_history_terminal_outcome_missing'
    });
    expect(health.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact: 'terminal_outcome',
          status: 'missing',
          reason_code: 'project_history_terminal_outcome_missing'
        })
      ])
    );
  });

  it('keeps expected app-server-lite payload policy facts healthy', () => {
    const health = buildProjectHistoryHealth({
      persistenceHealth: {
        enabled: true,
        db_path: '/tmp/runtime.sqlite',
        retention_days: 14,
        run_count: 2,
        ticket_count: 1,
        last_pruned_at: '2026-04-11T00:00:00.000Z',
        last_prune_failure_at: null,
        last_prune_failure_reason: null,
        last_prune_failure_detail: null,
        integrity_ok: true,
        history_schema: {
          schema_name: 'project_execution_history',
          target_version: 8,
          applied_version: 8,
          status: 'healthy',
          degraded_reason_code: null,
          degraded_detail: null,
          updated_at: '2026-04-11T00:00:00.000Z',
          migrations: []
        },
        recent_write_failures: []
      },
      timelines: [
        timeline({
          app_server_events: [
            {
              app_server_event_id: 'app-event-redacted',
              issue_run_id: 'issue-run-1',
              attempt_id: 'attempt-1',
              thread_id: 'thread-1',
              turn_id: 'turn-1',
              observed_at: '2026-04-10T10:25:00.000Z',
              policy_version: 1,
              payload_class: 'protocol_request_response',
              detail_status: 'redacted_truncated_excerpt',
              redaction_status: 'redacted',
              source_event_id: 'event-redacted',
              source_event_name: 'turn/completed',
              summary: 'turn completed',
              summary_fields: { status: 'succeeded' },
              redacted_excerpt: 'token=***REDACTED***',
              truncation: { truncated: true, original_bytes: 1024, excerpt_bytes: 64, max_excerpt_bytes: 64 },
              unavailable_reason_code: null,
              full_payload_stored: false
            },
            {
              app_server_event_id: 'app-event-summary',
              issue_run_id: 'issue-run-1',
              attempt_id: 'attempt-1',
              thread_id: 'thread-1',
              turn_id: 'turn-1',
              observed_at: '2026-04-10T10:26:00.000Z',
              policy_version: 1,
              payload_class: 'tool_payload',
              detail_status: 'summary_only',
              redaction_status: 'redacted',
              source_event_id: 'event-summary',
              source_event_name: 'tool/call',
              summary: 'tool payload summarized',
              summary_fields: { tool: 'shell' },
              redacted_excerpt: null,
              truncation: { truncated: false, original_bytes: 2048, excerpt_bytes: 0, max_excerpt_bytes: 64 },
              unavailable_reason_code: null,
              full_payload_stored: false
            },
            {
              app_server_event_id: 'app-event-policy-unavailable',
              issue_run_id: 'issue-run-1',
              attempt_id: 'attempt-1',
              thread_id: 'thread-1',
              turn_id: 'turn-1',
              observed_at: '2026-04-10T10:27:00.000Z',
              policy_version: 1,
              payload_class: 'conversation_transcript',
              detail_status: 'unavailable_policy',
              redaction_status: 'unavailable_policy',
              source_event_id: 'event-policy-unavailable',
              source_event_name: 'conversation/raw',
              summary: null,
              summary_fields: {},
              redacted_excerpt: null,
              truncation: { truncated: false, original_bytes: 8192, excerpt_bytes: 0, max_excerpt_bytes: 64 },
              unavailable_reason_code: 'conversation_transcript_policy_unavailable',
              full_payload_stored: false
            }
          ]
        })
      ],
      ticketCount: 1
    });

    expect(health.status).toBe('healthy');
    expect(health.app_server_lite).toMatchObject({
      status: 'healthy',
      redacted_event_count: 2,
      truncated_event_count: 1,
      summary_only_event_count: 1,
      unavailable_event_count: 1,
      full_payload_stored_count: 0,
      degraded_event_count: 0,
      unavailable_reasons: [
        {
          reason_code: 'conversation_transcript_policy_unavailable',
          count: 1,
          classification: 'expected_policy'
        }
      ]
    });
    expect(health.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fact: 'app_server_lite_health', status: 'present', reason_code: null }),
        expect.objectContaining({ fact: 'app_server_lite_payload', status: 'redacted' }),
        expect.objectContaining({ fact: 'app_server_lite_payload', status: 'truncated' })
      ])
    );
  });

  it('degrades app-server-lite health for full payloads and malformed unavailable policy state', () => {
    const health = buildProjectHistoryHealth({
      persistenceHealth: {
        enabled: true,
        db_path: '/tmp/runtime.sqlite',
        retention_days: 14,
        run_count: 2,
        ticket_count: 1,
        last_pruned_at: '2026-04-11T00:00:00.000Z',
        last_prune_failure_at: null,
        last_prune_failure_reason: null,
        last_prune_failure_detail: null,
        integrity_ok: true,
        history_schema: {
          schema_name: 'project_execution_history',
          target_version: 8,
          applied_version: 8,
          status: 'healthy',
          degraded_reason_code: null,
          degraded_detail: null,
          updated_at: '2026-04-11T00:00:00.000Z',
          migrations: []
        },
        recent_write_failures: []
      },
      timelines: [
        timeline({
          app_server_events: [
            {
              app_server_event_id: 'app-event-full-payload',
              issue_run_id: 'issue-run-1',
              attempt_id: 'attempt-1',
              thread_id: 'thread-1',
              turn_id: 'turn-1',
              observed_at: '2026-04-10T10:25:00.000Z',
              policy_version: 1,
              payload_class: 'protocol_lifecycle',
              detail_status: 'redacted_excerpt',
              redaction_status: 'not_required',
              source_event_id: 'event-full-payload',
              source_event_name: 'thread/started',
              summary: 'thread started',
              summary_fields: {},
              redacted_excerpt: '{}',
              truncation: { truncated: false, original_bytes: 2, excerpt_bytes: 2, max_excerpt_bytes: 64 },
              unavailable_reason_code: null,
              full_payload_stored: true
            },
            {
              app_server_event_id: 'app-event-malformed',
              issue_run_id: 'issue-run-1',
              attempt_id: 'attempt-1',
              thread_id: 'thread-1',
              turn_id: 'turn-1',
              observed_at: '2026-04-10T10:26:00.000Z',
              policy_version: 1,
              payload_class: 'protocol_lifecycle',
              detail_status: 'redacted_excerpt',
              redaction_status: 'redacted',
              source_event_id: 'event-malformed',
              source_event_name: 'turn/completed',
              summary: 'turn completed',
              summary_fields: {},
              redacted_excerpt: null,
              truncation: { truncated: false, original_bytes: 2, excerpt_bytes: 0, max_excerpt_bytes: 64 },
              unavailable_reason_code: 'projection_payload_missing',
              full_payload_stored: false
            }
          ]
        })
      ],
      ticketCount: 1
    });

    expect(health.status).toBe('degraded');
    expect(health.app_server_lite).toMatchObject({
      status: 'degraded',
      redacted_event_count: 1,
      truncated_event_count: 0,
      unavailable_event_count: 1,
      full_payload_stored_count: 1,
      degraded_event_count: 2,
      unavailable_reasons: [
        {
          reason_code: 'projection_payload_missing',
          count: 1,
          classification: 'failure'
        }
      ]
    });
    expect(health.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact: 'app_server_lite_health',
          status: 'degraded',
          reason_code: 'project_history_app_server_lite_degraded',
          detail: expect.stringContaining('full_payload_stored=1')
        })
      ])
    );
  });

  it('marks disabled history persistence as explicit disabled health', () => {
    const health = buildProjectHistoryHealth({
      persistenceHealth: {
        enabled: false,
        db_path: null,
        retention_days: 14,
        run_count: 0,
        ticket_count: 0,
        last_pruned_at: null,
        last_prune_failure_at: null,
        last_prune_failure_reason: null,
        last_prune_failure_detail: null,
        integrity_ok: false,
        recent_write_failures: []
      },
      timelines: [],
      ticketCount: null,
      projectionAvailable: false,
      projectionFailureReasonCode: 'project_history_projection_unavailable'
    });

    expect(health).toMatchObject({
      status: 'disabled',
      enabled: false,
      storage: { type: 'disabled', target: null },
      counts: { runs: 0, tickets: 0 },
      projections: { status: 'unavailable', reason_code: 'project_history_projection_unavailable' }
    });
  });

  it('marks migration-needed schema health as degraded', () => {
    const health = buildProjectHistoryHealth({
      persistenceHealth: {
        enabled: true,
        db_path: '/tmp/runtime.sqlite',
        retention_days: 14,
        run_count: 0,
        ticket_count: 0,
        last_pruned_at: null,
        last_prune_failure_at: null,
        last_prune_failure_reason: null,
        last_prune_failure_detail: null,
        integrity_ok: false,
        history_schema: {
          schema_name: 'project_execution_history',
          target_version: 8,
          applied_version: 6,
          status: 'degraded',
          degraded_reason_code: 'history_schema_migration_needed',
          degraded_detail: 'target version 8 is not applied',
          updated_at: '2026-04-11T00:00:00.000Z',
          migrations: []
        },
        recent_write_failures: []
      },
      timelines: []
    });

    expect(health).toMatchObject({
      status: 'degraded',
      schema: {
        status: 'degraded',
        integrity_ok: false,
        reason_code: 'history_schema_migration_needed',
        detail: 'target version 8 is not applied'
      }
    });
  });

  it('surfaces write-failing and retention-failing states with redacted detail', () => {
    const health = buildProjectHistoryHealth({
      persistenceHealth: {
        enabled: true,
        db_path: '/tmp/runtime.sqlite',
        retention_days: 1,
        run_count: 3,
        ticket_count: 2,
        last_pruned_at: null,
        last_prune_failure_at: '2026-04-11T12:00:00.000Z',
        last_prune_failure_reason: 'retention_prune_failed',
        last_prune_failure_detail: 'token=***REDACTED*** prune exploded',
        integrity_ok: false,
        history_schema: {
          schema_name: 'project_execution_history',
          target_version: 8,
          applied_version: 8,
          status: 'degraded',
          degraded_reason_code: 'history_write_failed',
          degraded_detail: 'appendTicketBlocker: turn_input_required',
          updated_at: '2026-04-11T12:00:00.000Z',
          migrations: []
        },
        recent_write_failures: [
          {
            operation: 'appendTicketBlocker',
            reason_code: 'turn_input_required',
            detail: 'database locked token=***REDACTED***',
            recorded_at: '2026-04-11T12:00:00.000Z'
          }
        ]
      },
      timelines: [timeline()]
    });

    expect(health.status).toBe('degraded');
    expect(health.writes).toMatchObject({
      status: 'degraded',
      recent_failures: [expect.objectContaining({ operation: 'appendTicketBlocker', reason_code: 'turn_input_required' })]
    });
    expect(health.retention.last_prune).toMatchObject({
      status: 'failed',
      failure_reason_code: 'retention_prune_failed',
      failure_detail: 'token=***REDACTED*** prune exploded'
    });
    expect(JSON.stringify(health)).not.toContain('secret');
  });

  it('marks optional app-server-lite and token facts as explicitly optional', () => {
    const summary = buildProjectHistoryConsumerSummaryResponse(
      timeline({
        app_server_events: [],
        token_model_facts: []
      })
    );

    expect(summary.token_model).toMatchObject({
      status: 'missing',
      total_tokens: null,
      requested_models: [],
      effective_models: [],
      telemetry_confidences: [],
      recent: []
    });
    expect(summary.app_server_lite).toEqual({ status: 'missing', excerpts: [] });
    expect(summary.current_ticket_state.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact: 'token_model_summaries',
          status: 'optional_unavailable',
          reason_code: 'project_history_token_model_summaries_missing'
        }),
        expect.objectContaining({
          fact: 'app_server_lite_summaries',
          status: 'optional_unavailable',
          reason_code: 'project_history_app_server_lite_summaries_missing'
        })
      ])
    );
  });

  it('keeps optional telemetry absence from degrading project history health', () => {
    const health = buildProjectHistoryHealth({
      persistenceHealth: {
        enabled: true,
        db_path: '/tmp/runtime.sqlite',
        retention_days: 14,
        run_count: 1,
        ticket_count: 1,
        last_pruned_at: '2026-04-11T00:00:00.000Z',
        last_prune_failure_at: null,
        last_prune_failure_reason: null,
        last_prune_failure_detail: null,
        integrity_ok: true,
        history_schema: {
          schema_name: 'project_execution_history',
          target_version: 8,
          applied_version: 8,
          status: 'healthy',
          degraded_reason_code: null,
          degraded_detail: null,
          updated_at: '2026-04-11T00:00:00.000Z',
          migrations: []
        },
        recent_write_failures: []
      },
      timelines: [
        timeline({
          app_server_events: [],
          token_model_facts: []
        })
      ],
      ticketCount: 1
    });

    expect(health.status).toBe('healthy');
    expect(health.projections).toMatchObject({ status: 'healthy', reason_code: null });
    expect(health.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact: 'token_model_summaries',
          status: 'optional_unavailable',
          reason_code: 'project_history_token_model_summaries_missing'
        }),
        expect.objectContaining({
          fact: 'app_server_lite_summaries',
          status: 'optional_unavailable',
          reason_code: 'project_history_app_server_lite_summaries_missing'
        })
      ])
    );
  });
});
