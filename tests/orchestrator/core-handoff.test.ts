import { describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_EVENT,
  LocalApiServer,
  OrchestratorCore,
  REASON_CODES,
  SnapshotService,
  SqlitePersistenceStore,
  buildDurableIdentity,
  createHarness,
  fs,
  makeControlPlaneHealthSummary,
  makeIssue,
  makeTerminationResult,
  makeTracker,
  os,
  path,
  toWorkerEvent,
  withTemporaryCodexHome,
  writeSessionTranscript
} from './core-test-harness';
import type {
  Harness,
  Issue,
  OrchestratorPersistencePort,
  OrchestratorPorts,
  OrchestratorState,
  StructuredLogger,
  TranscriptToolCallDiagnostic,
  TranscriptToolCallLineage
} from './core-test-harness';

describe('OrchestratorCore handoff', () => {
  it('dispatches Agent Review after handoff as a fresh run without implementation context', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-agent-review', state: 'In Progress' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-agent-review', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });

    await harness.orchestrator.onWorkerExit('i-agent-review', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-agent-review', state: 'Agent Review' })]);
    await harness.orchestrator.tick('interval');

    expect(harness.spawned).toEqual([
      { issue_id: 'i-agent-review', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-agent-review', attempt: null, worker_host: null, resume_context: null }
    ]);
    const running = harness.orchestrator.getStateSnapshot().running.get('i-agent-review');
    expect(running?.retry_attempt).toBe(0);
    expect(running?.thread_id).toBeNull();
    expect(running?.session_id).toBeNull();
  });

  it('claimed/running protection prevents duplicate Agent Review fresh runs', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-review-claimed', state: 'Agent Review' })]);

    await harness.orchestrator.tick('interval');
    await harness.orchestrator.tick('interval');

    expect(harness.spawned).toEqual([
      { issue_id: 'i-review-claimed', attempt: null, worker_host: null, resume_context: null }
    ]);
    expect(harness.orchestrator.getStateSnapshot().claimed.has('i-review-claimed')).toBe(true);
  });

  it('blocks a fresh phase that exits without routing instead of redispatching it', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    const issue = makeIssue({ id: 'i-review-no-route', identifier: 'NIE-NO-ROUTE', state: 'Agent Review' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);

    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      issue.id,
      'abnormal',
      `${REASON_CODES.freshDispatchNoRoute}: Agent Review`,
      { retryable: false }
    );

    let snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.get(issue.id)?.stop_reason_code).toBe(REASON_CODES.freshDispatchNoRoute);
    expect(snapshot.retry_attempts.has(issue.id)).toBe(false);
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.get(issue.id)?.stop_reason_code).toBe(REASON_CODES.freshDispatchNoRoute);
    expect(harness.spawned).toHaveLength(1);
  });

  it('dispatches stale retry state in Agent Review as fresh without prior thread lineage', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-stale-review', state: 'In Progress' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-stale-review', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });
    await harness.orchestrator.onWorkerExit('i-stale-review', 'abnormal', 'transient implementation failure');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-stale-review', state: 'Agent Review' })]);
    await harness.orchestrator.onRetryTimer('i-stale-review');

    expect(harness.spawned).toEqual([
      { issue_id: 'i-stale-review', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-stale-review', attempt: null, worker_host: null, resume_context: null }
    ]);
    const running = harness.orchestrator.getStateSnapshot().running.get('i-stale-review');
    expect(running?.retry_attempt).toBe(0);
    expect(running?.thread_id).toBeNull();
    expect(running?.session_id).toBeNull();
  });

  it('records Agent Review handoff and routed fresh review completion as healthy non-cleanup exits', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review', 'Merging', 'Rework'],
        fresh_dispatch_states: ['Agent Review']
      }
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-review-lifecycle', state: 'In Progress' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-review-lifecycle', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });

    await harness.orchestrator.onWorkerExit('i-review-lifecycle', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-review-lifecycle', state: 'Agent Review' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-review-lifecycle', 'normal', undefined, {
      completion_reason: REASON_CODES.freshDispatchStateRouted,
      refreshed_state: 'In Progress'
    });

    expect(harness.spawned).toEqual([
      { issue_id: 'i-review-lifecycle', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-review-lifecycle', attempt: null, worker_host: null, resume_context: null }
    ]);
    expect(harness.terminated).toEqual([]);
    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-review-lifecycle')).toBe(false);
    expect(snapshot.completed.has('i-review-lifecycle')).toBe(true);
    expect(logs.filter((entry) => entry.event === CANONICAL_EVENT.orchestration.workerExitHandled).map((entry) => entry.context)).toEqual([
      expect.objectContaining({
        issue_id: 'i-review-lifecycle',
        outcome: 'completed',
        completion_reason: REASON_CODES.handoffStateReached,
        stop_reason_code: REASON_CODES.handoffStateReached,
        cleanup_workspace: false
      }),
      expect.objectContaining({
        issue_id: 'i-review-lifecycle',
        outcome: 'completed',
        completion_reason: REASON_CODES.freshDispatchStateRouted,
        stop_reason_code: REASON_CODES.freshDispatchStateRouted,
        refreshed_state: 'In Progress',
        cleanup_workspace: false
      })
    ]);
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.orchestration.workerStalled)).toBe(false);
    expect(
      logs.some(
        (entry) =>
          entry.context.stop_reason_code === REASON_CODES.workerExitAbnormal ||
          entry.context.stop_reason_code === REASON_CODES.workerStalled
      )
    ).toBe(false);
  });

  it('quarantines late prior-review events after a fresh same-issue fix dispatch without polluting active run activity', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        fresh_dispatch_states: ['Agent Review', 'In Progress']
      }
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-to-fix', identifier: 'NIE-79', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-review-to-fix', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 1001
    });
    await harness.orchestrator.onWorkerExit('i-review-to-fix', 'normal', undefined, {
      completion_reason: REASON_CODES.freshDispatchStateRouted,
      refreshed_state: 'In Progress'
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-to-fix', identifier: 'NIE-79', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-review-to-fix', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'fix-thread',
      turn_id: 'fix-turn',
      session_id: 'fix-session',
      codex_app_server_pid: 2002
    });

    harness.orchestrator.onWorkerEvent('i-review-to-fix', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'late review heartbeat',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 1001
    });
    harness.orchestrator.onWorkerEvent('i-review-to-fix', {
      timestamp_ms: harness.now.value + 30,
      event: CANONICAL_EVENT.codex.turnCompleted,
      detail: 'late review completion',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 1001
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-review-to-fix');
    expect(running?.thread_id).toBe('fix-thread');
    expect(running?.turn_id).toBe('fix-turn');
    expect(running?.session_id).toBe('fix-session');
    expect(running?.codex_app_server_pid).toBe('2002');
    expect(running?.last_event).toBe(CANONICAL_EVENT.codex.turnStarted);
    expect(running?.last_codex_timestamp_ms).toBe(harness.now.value + 10);
    expect(running?.recent_events).toEqual([
      {
        at_ms: harness.now.value + 10,
        event: CANONICAL_EVENT.codex.turnStarted,
        message: null
      }
    ]);
    expect(running?.quarantined_event_count).toBe(2);
    expect(running?.quarantined_events).toEqual([
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnWaiting,
        message: 'late review heartbeat',
        thread_id: 'review-thread',
        turn_id: 'review-turn',
        session_id: 'review-session',
        active_thread_id: 'fix-thread',
        active_turn_id: 'fix-turn',
        active_session_id: 'fix-session',
        reason: 'inactive_worker_pid'
      }),
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnCompleted,
        message: 'late review completion',
        thread_id: 'review-thread',
        turn_id: 'review-turn',
        session_id: 'review-session',
        active_thread_id: 'fix-thread',
        active_turn_id: 'fix-turn',
        active_session_id: 'fix-session',
        reason: 'inactive_worker_pid'
      })
    ]);
    expect(
      snapshot.recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored)
    ).toBe(false);
    expect(logs.filter((entry) => entry.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored)).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          active_thread_id: 'fix-thread',
          event_thread_id: 'review-thread',
          active_turn_id: 'fix-turn',
          event_turn_id: 'review-turn',
          active_session_id: 'fix-session',
          event_session_id: 'review-session',
          event: CANONICAL_EVENT.codex.turnWaiting
        })
      }),
      expect.objectContaining({
        context: expect.objectContaining({
          active_thread_id: 'fix-thread',
          event_thread_id: 'review-thread',
          active_turn_id: 'fix-turn',
          event_turn_id: 'review-turn',
          active_session_id: 'fix-session',
          event_session_id: 'review-session',
          event: CANONICAL_EVENT.codex.turnCompleted
        })
      })
    ]);
  });

  it('treats Agent Review tracker handback observed during stalled wait as progress and starts a fresh In Progress run', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review', 'In Progress'],
        progress_stalled_waiting_ms: 1_000,
        running_wait_stall_threshold_ms: 1_000,
        worker_opaque_activity_hard_timeout_ms: 1_000,
        stall_timeout_ms: 0
      }
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-handback', identifier: 'NIE-HAND', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-review-handback', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session'
    });
    harness.orchestrator.onWorkerEvent('i-review-handback', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for rate limit',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session'
    });
    harness.orchestrator.onWorkerEvent('i-review-handback', {
      timestamp_ms: harness.now.value + 30,
      event: 'linear.comment.created',
      detail: 'Agent Review findings: routing back to In Progress',
      tool_name: 'save_comment',
      request_category: 'linear',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session'
    });

    harness.now.value += 2_000;
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-review-handback', identifier: 'NIE-HAND', state: 'In Progress' })
    ]);
    await harness.orchestrator.reconcileRunningIssues();

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-handback', identifier: 'NIE-HAND', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(harness.terminated).toEqual([
      { issue_id: 'i-review-handback', cleanup_workspace: false, reason: REASON_CODES.freshDispatchStateRouted }
    ]);
    expect(harness.spawned).toEqual([
      { issue_id: 'i-review-handback', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-review-handback', attempt: null, worker_host: null, resume_context: null }
    ]);
    expect(snapshot.blocked_inputs.has('i-review-handback')).toBe(false);
    expect(snapshot.retry_attempts.has('i-review-handback')).toBe(false);
    expect(snapshot.running.get('i-review-handback')?.issue.state).toBe('In Progress');
    expect(logs.some((entry) => entry.event === 'orchestration.agent_review_handoff_progress_observed')).toBe(false);
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked)).toBe(false);
  });

  it('preserves worker-authored review comment provenance across heartbeat event churn before stalled-wait recovery', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review', 'In Progress'],
        progress_stalled_waiting_ms: 1_000,
        running_wait_stall_threshold_ms: 1_000,
        worker_opaque_activity_hard_timeout_ms: 1_000,
        stall_timeout_ms: 0
      }
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-handback-churn', identifier: 'NIE-CHURN', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-review-handback-churn', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session'
    });
    harness.orchestrator.onWorkerEvent('i-review-handback-churn', {
      timestamp_ms: harness.now.value + 20,
      event: 'linear.comment.created',
      detail: 'Agent Review findings: routing back to In Progress',
      tool_name: 'save_comment',
      request_category: 'linear',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session'
    });
    for (let index = 0; index < 25; index += 1) {
      harness.orchestrator.onWorkerEvent('i-review-handback-churn', {
        timestamp_ms: harness.now.value + 30 + index,
        event: index % 2 === 0 ? CANONICAL_EVENT.codex.turnWaiting : CANONICAL_EVENT.codex.rateLimitsUpdated,
        detail: 'heartbeat after handoff',
        thread_id: 'review-thread',
        turn_id: 'review-turn',
        session_id: 'review-session'
      });
    }

    expect(
      harness.orchestrator
        .getStateSnapshot()
        .running.get('i-review-handback-churn')
        ?.recent_events.some((event) => event.event === 'linear.comment.created')
    ).toBe(false);

    harness.now.value += 2_000;
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-review-handback-churn', identifier: 'NIE-CHURN', state: 'In Progress' })
    ]);
    await harness.orchestrator.reconcileRunningIssues();

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-handback-churn', identifier: 'NIE-CHURN', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-review-handback-churn')).toBe(false);
    expect(snapshot.retry_attempts.has('i-review-handback-churn')).toBe(false);
    expect(snapshot.running.get('i-review-handback-churn')?.issue.state).toBe('In Progress');
    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual([
      'i-review-handback-churn',
      'i-review-handback-churn'
    ]);
    expect(logs.some((entry) => entry.event === 'orchestration.agent_review_handoff_progress_observed')).toBe(false);
  });

  it('does not treat Agent Review status movement alone as worker-owned handback progress', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review', 'In Progress'],
        progress_stalled_waiting_ms: 1_000,
        running_wait_stall_threshold_ms: 1_000,
        worker_opaque_activity_hard_timeout_ms: 1_000,
        stall_timeout_ms: 0
      }
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-status-only-handback', identifier: 'NIE-STATUS', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-status-only-handback', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session'
    });
    harness.orchestrator.onWorkerEvent('i-status-only-handback', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for rate limit before I can post the review comment',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session'
    });

    harness.now.value += 2_000;
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-status-only-handback', identifier: 'NIE-STATUS', state: 'In Progress' })
    ]);
    await harness.orchestrator.reconcileRunningIssues();

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(harness.spawned).toEqual([
      { issue_id: 'i-status-only-handback', attempt: null, worker_host: null, resume_context: null }
    ]);
    expect(harness.terminated).toEqual([
      { issue_id: 'i-status-only-handback', cleanup_workspace: false, reason: REASON_CODES.freshDispatchStateRouted }
    ]);
    expect(snapshot.retry_attempts.has('i-status-only-handback')).toBe(false);
    expect(snapshot.running.has('i-status-only-handback')).toBe(false);
    expect(logs.some((entry) => entry.event === 'orchestration.agent_review_handoff_progress_observed')).toBe(false);
  });

  it('classifies tracker refresh failures during stalled-wait recovery as tracker uncertainty retries', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review', 'In Progress'],
        progress_stalled_waiting_ms: 1_000,
        running_wait_stall_threshold_ms: 1_000,
        worker_opaque_activity_hard_timeout_ms: 1_000,
        stall_timeout_ms: 0
      }
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-refresh-unknown', identifier: 'NIE-UNKNOWN', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-refresh-unknown', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'unknown-thread',
      turn_id: 'unknown-turn',
      session_id: 'unknown-session'
    });
    harness.orchestrator.onWorkerEvent('i-refresh-unknown', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for rate limit',
      thread_id: 'unknown-thread',
      turn_id: 'unknown-turn',
      session_id: 'unknown-session'
    });
    harness.orchestrator.onWorkerEvent('i-refresh-unknown', {
      timestamp_ms: harness.now.value + 30,
      event: 'linear.comment.created',
      detail: 'Agent Review findings: routing back to In Progress',
      tool_name: 'save_comment',
      request_category: 'linear',
      thread_id: 'unknown-thread',
      turn_id: 'unknown-turn',
      session_id: 'unknown-session'
    });

    harness.now.value += 2_000;
    harness.tracker.fetch_issue_states_by_ids.mockRejectedValue(new Error('Linear request failed: AbortError'));
    await harness.orchestrator.reconcileRunningIssues();

    const snapshot = harness.orchestrator.getStateSnapshot();
    const retry = snapshot.retry_attempts.get('i-refresh-unknown');
    expect(snapshot.blocked_inputs.has('i-refresh-unknown')).toBe(false);
    expect(retry?.stop_reason_code).toBe(REASON_CODES.issueStateRefreshFailed);
    expect(retry?.stop_reason_detail).toContain('AbortError');
    expect(retry?.progress_signals).toMatchObject({
      tracker_comment_created: true,
      tracker_started_state: 'Agent Review'
    });
    expect(harness.spawned).toHaveLength(1);
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.tracker.stateRefreshFailed)).toBe(true);
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked)).toBe(false);
  });

  it('suppresses the no-progress redispatch block when tracker handback progress is classified', async () => {
    const logs: Array<{ event: string; context?: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        fresh_dispatch_states: ['Agent Review'],
        respawn_max_attempts_without_progress: 1
      },
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: fallback_state_marker
      })
    });
    const reviewIssue = makeIssue({ id: 'i-gate-handback', identifier: 'NIE-GATE', state: 'Agent Review' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([reviewIssue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-gate-handback', 'abnormal', 'turn waiting threshold exceeded');

    const retry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-gate-handback');
    expect(retry).toBeDefined();
    retry!.progress_signals = {
      ...(retry!.progress_signals ?? {}),
      tracker_comment_created: true,
      tracker_status_transition: 'Agent Review -> In Progress',
      agent_review_handoff: 'In Progress'
    } as NonNullable<typeof retry>['progress_signals'];
    const internals = harness.orchestrator as unknown as { state: OrchestratorState };
    internals.state.retry_attempts.set('i-gate-handback', retry!);

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-gate-handback', identifier: 'NIE-GATE', state: 'In Progress' })
    ]);
    await harness.scheduled.get('i-gate-handback')?.callback();

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-gate-handback')).toBe(false);
    expect(snapshot.retry_attempts.has('i-gate-handback')).toBe(false);
    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-gate-handback', 'i-gate-handback']);
    expect(logs.some((entry) => entry.event === 'orchestration.no_progress_block_suppressed')).toBe(true);
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked)).toBe(false);
  });

  it('suppresses the no-progress redispatch block from production-captured worker handback progress', async () => {
    const logs: Array<{ event: string; context?: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        fresh_dispatch_states: ['Agent Review'],
        respawn_max_attempts_without_progress: 1
      },
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: fallback_state_marker
      })
    });
    const reviewIssue = makeIssue({ id: 'i-gate-handback-production', identifier: 'NIE-GATE-PROD', state: 'Agent Review' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([reviewIssue]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-gate-handback-production', {
      timestamp_ms: harness.now.value + 10,
      event: 'linear.comment.created',
      detail: 'Agent Review findings: routing back to In Progress',
      tool_name: 'save_comment',
      request_category: 'linear',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session'
    });
    await harness.orchestrator.onWorkerExit('i-gate-handback-production', 'abnormal', 'turn waiting threshold exceeded');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-gate-handback-production', identifier: 'NIE-GATE-PROD', state: 'In Progress' })
    ]);
    await harness.scheduled.get('i-gate-handback-production')?.callback();

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-gate-handback-production')).toBe(false);
    expect(snapshot.retry_attempts.has('i-gate-handback-production')).toBe(false);
    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual([
      'i-gate-handback-production',
      'i-gate-handback-production'
    ]);
    expect(logs.some((entry) => entry.event === 'orchestration.no_progress_block_suppressed')).toBe(true);
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked)).toBe(false);
  });

  it('clears stale no-progress blocked inputs during reconciliation when no pending input exists and tracker state is actionable', async () => {
    const logs: Array<{ event: string; context?: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context });
      }
    };
    const harness = createHarness({ logger });
    harness.orchestrator.restoreSuppressionState({
      blocked_entries: [
        {
          issue_id: 'i-stale-block',
          issue_identifier: 'NIE-STALE',
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
          stop_reason_code: REASON_CODES.operatorNoProgressRedispatchBlocked,
          stop_reason_detail: 'completion gate blocked redispatch because no progress signal was detected',
          conflict_files: [],
          resolution_hints: [],
          previous_thread_id: null,
          previous_session_id: null,
          blocked_at_ms: harness.now.value,
          requires_manual_resume: true,
          pending_input: null,
          session_console: []
        }
      ],
      breaker_entries: []
    });
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-stale-block', identifier: 'NIE-STALE', state: 'In Progress' })
    ]);

    await harness.orchestrator.reconcileBlockedInputs();

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-stale-block')).toBe(false);
    expect(snapshot.claimed.has('i-stale-block')).toBe(false);
    expect(logs.some((entry) => entry.event === 'orchestration.stale_blocked_input_cleared')).toBe(true);
  });

  it('does not schedule continuation retry when normal exit left active states', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-paused' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit('i-paused', 'normal', undefined, {
      completion_reason: 'issue_left_active_states',
      refreshed_state: 'Paused'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-paused')).toBe(false);
    expect(snapshot.completed.has('i-paused')).toBe(true);
    expect(harness.terminated).toEqual([]);
  });
});
