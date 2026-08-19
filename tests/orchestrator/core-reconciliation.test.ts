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

describe('OrchestratorCore reconciliation and stale lineage', () => {
  it('clears blocked issue state when tracker reports non-active or terminal state', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-clear', identifier: 'ABC-CLEAR' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-clear',
      'abnormal',
      'tool requestUserInput could not be auto-answered (turn_input_required)'
    );

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-clear', identifier: 'ABC-CLEAR', state: 'Done' })
    ]);

    await harness.orchestrator.tick('interval');
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-clear')).toBe(false);
  });

  it('requeues retry with explicit slot exhaustion reason when no slots are available', async () => {
    const harness = createHarness({ configOverrides: { max_concurrent_agents: 1 } });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-busy' })]);
    await harness.orchestrator.tick('interval');
    harness.now.value += 1;
    await harness.orchestrator.onWorkerExit('i-busy', 'normal');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-occupying-slot', identifier: 'ABC-2', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-busy' })]);
    await harness.orchestrator.onRetryTimer('i-busy');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-busy');
    expect(retryEntry?.attempt).toBe(2);
    expect(retryEntry?.error).toBe('no available orchestrator slots');
    expect(retryEntry?.stop_reason_code).toBe('slots_exhausted');
  });

  it('requeues fresh-dispatch retry on slot exhaustion without implementation thread lineage', async () => {
    const harness = createHarness({
      configOverrides: {
        max_concurrent_agents: 1,
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-fresh-slots', state: 'In Progress' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-fresh-slots', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });
    await harness.orchestrator.onWorkerExit('i-fresh-slots', 'abnormal', 'transient implementation failure');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-occupying-slot', identifier: 'ABC-2', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-fresh-slots', state: 'Agent Review' })]);
    await harness.orchestrator.onRetryTimer('i-fresh-slots');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-fresh-slots');
    expect(retryEntry?.attempt).toBe(2);
    expect(retryEntry?.error).toBe('no available orchestrator slots');
    expect(retryEntry?.stop_reason_code).toBe('slots_exhausted');
    expect(retryEntry?.previous_thread_id).toBeNull();
    expect(retryEntry?.previous_session_id).toBeNull();
    expect(retryEntry?.issue_run_id).toBeNull();
    expect(harness.spawned).toEqual([
      { issue_id: 'i-fresh-slots', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-occupying-slot', attempt: null, worker_host: null, resume_context: null }
    ]);
  });

  it('preserves non-fresh active-state continuation retry metadata', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-normal-retry', state: 'In Progress' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-normal-retry', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });
    await harness.orchestrator.onWorkerExit('i-normal-retry', 'normal');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-normal-retry');
    expect(retryEntry?.attempt).toBe(1);
    expect(retryEntry?.previous_thread_id).toBe('implementation-thread');
    expect(retryEntry?.previous_session_id).toBe('implementation-session');
  });

  it('releases claim if retry issue is no longer in candidate set', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-release' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-release', 'normal');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([]);
    await harness.orchestrator.onRetryTimer('i-release');

    expect(harness.orchestrator.getStateSnapshot().claimed.has('i-release')).toBe(false);
  });

  it('updates running issue snapshots for active states during reconciliation', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-active', state: 'Todo' })]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-active', identifier: 'ABC-99', state: 'In Progress' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    const updated = harness.orchestrator.getStateSnapshot().running.get('i-active');
    expect(updated?.issue.state).toBe('In Progress');
    expect(updated?.identifier).toBe('ABC-99');
  });

  it('releases stale implementation worker when refreshed into Agent Review fresh-dispatch handoff', async () => {
    const completedRuns: Array<Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0]> = [];
    const stateTransitions: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendStateTransition']>>[0]> = [];
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    let harness: Harness;
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-handoff-release',
      appendIssueRun: async () => 'issue-run-handoff-release',
      appendAttempt: async () => 'attempt-handoff-release',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      appendStateTransition: async (params) => {
        stateTransitions.push(params);
        return `transition-${stateTransitions.length}`;
      },
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      },
      terminateWorker: async ({ issue_id, cleanup_workspace, reason }) => {
        harness.terminated.push({ issue_id, cleanup_workspace, reason });
        await harness.orchestrator.onWorkerExit(issue_id, 'normal', undefined, {
          completion_reason: REASON_CODES.handoffStateReached,
          refreshed_state: 'Agent Review',
          worker_instance_id: harness.orchestrator.getStateSnapshot().running.get(issue_id)?.worker_instance_id,
          session_id: 'implementation-session'
        });
        return makeTerminationResult({ cleanup_requested: cleanup_workspace, cleanup_succeeded: cleanup_workspace ? true : null });
      },
      logger: {
        log: ({ event, context }) => logs.push({ event, context: context ?? {} })
      },
      persistence
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-stale-handoff', identifier: 'ABC-HANDOFF', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-stale-handoff', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-stale-handoff', identifier: 'ABC-HANDOFF', state: 'Agent Review' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-stale-handoff',
        cleanup_workspace: false,
        reason: REASON_CODES.handoffRelease
      }
    ]);
    expect(snapshot.running.has('i-stale-handoff')).toBe(false);
    expect(snapshot.claimed.has('i-stale-handoff')).toBe(false);
    expect(snapshot.retry_attempts.has('i-stale-handoff')).toBe(false);
    expect(completedRuns).toEqual([
      expect.objectContaining({
        terminal_status: 'succeeded',
        process_status: 'cancelled',
        workflow_outcome: 'handoff_reached',
        error_code: REASON_CODES.handoffRelease,
        terminal_reason_code: REASON_CODES.handoffRelease,
        session_id: 'implementation-session',
        thread_id: 'implementation-thread',
        turn_id: 'implementation-turn'
      })
    ]);
    expect(stateTransitions.filter((transition) => transition.to_status !== 'running')).toEqual([
      expect.objectContaining({
        to_status: 'handoff_reached',
        status: 'succeeded',
        reason_code: REASON_CODES.handoffRelease
      })
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.orchestration.workerExitHandled,
        context: expect.objectContaining({
          outcome: 'termination_exit_observed'
        })
      })
    );
    await harness.orchestrator.onWorkerExit('i-stale-handoff', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review',
      worker_instance_id: 'i-stale-handoff-worker-1',
      session_id: 'implementation-session'
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.orchestration.staleWorkerExitIgnored,
        context: expect.objectContaining({
          issue_id: 'i-stale-handoff',
          stale_reason: 'ownership_already_released',
          event_worker_instance_id: 'i-stale-handoff-worker-1',
          event_session_id: 'implementation-session'
        })
      })
    );

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-stale-handoff', identifier: 'ABC-HANDOFF', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    const freshReview = harness.orchestrator.getStateSnapshot().running.get('i-stale-handoff');
    expect(harness.spawned).toEqual([
      { issue_id: 'i-stale-handoff', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-stale-handoff', attempt: null, worker_host: null, resume_context: null }
    ]);
    expect(freshReview?.retry_attempt).toBe(0);
    expect(freshReview?.thread_id).toBeNull();
    expect(freshReview?.session_id).toBeNull();
  });

  it('records Human Review as a successful handoff while the stopped process remains cancelled', async () => {
    const completedRuns: Array<Parameters<OrchestratorPersistencePort['completeRun']>[0]> = [];
    let harness: Harness;
    harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        handoff_states: ['Agent Review', 'Human Review'],
        fresh_dispatch_states: ['Agent Review']
      },
      terminateWorker: async ({ issue_id, cleanup_workspace, reason }) => {
        harness.terminated.push({ issue_id, cleanup_workspace, reason });
        harness.orchestrator.onWorkerEvent(issue_id, {
          timestamp_ms: harness.now.value + 1,
          event: CANONICAL_EVENT.agentRunner.turnCancelled,
          agent_runtime: 'claude-cli'
        });
        return makeTerminationResult({ cleanup_requested: cleanup_workspace, cleanup_succeeded: null });
      },
      persistence: {
        startRun: async () => 'run-human-review-handoff',
        recordSession: async () => undefined,
        recordEvent: async () => undefined,
        completeRun: async (params) => {
          completedRuns.push(params);
        }
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-human-review-handoff', identifier: 'ABC-HUMAN', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-human-review-handoff', identifier: 'ABC-HUMAN', state: 'Human Review' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    expect(harness.terminated).toEqual([
      { issue_id: 'i-human-review-handoff', cleanup_workspace: false, reason: REASON_CODES.handoffStateReached }
    ]);
    expect(completedRuns).toEqual([
      expect.objectContaining({
        terminal_status: 'succeeded',
        process_status: 'cancelled',
        workflow_outcome: 'handoff_reached'
      })
    ]);
    expect(harness.orchestrator.getStateSnapshot().phase_timeline?.get('i-human-review-handoff')?.at(-1)?.phase).toBe(
      'completed'
    );
  });

  it('treats mismatched worker exits during release as stale without confirming the releasing worker', async () => {
    const completedRuns: Array<Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0]> = [];
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    let releaseStateDuringMismatch: string | null = null;
    let harness: Harness;
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-mismatch-release',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      },
      terminateWorker: async ({ issue_id, cleanup_workspace, reason }) => {
        harness.terminated.push({ issue_id, cleanup_workspace, reason });
        releaseStateDuringMismatch =
          harness.orchestrator.getStateSnapshot().running.get(issue_id)?.termination?.state ?? null;
        await harness.orchestrator.onWorkerExit(issue_id, 'normal', undefined, {
          completion_reason: REASON_CODES.handoffStateReached,
          refreshed_state: 'Agent Review',
          worker_instance_id: 'other-worker',
          session_id: 'other-session'
        });
        expect(harness.orchestrator.getStateSnapshot().running.get(issue_id)?.termination?.state).toBe('requested');
        return makeTerminationResult({ cleanup_requested: cleanup_workspace, cleanup_succeeded: cleanup_workspace ? true : null });
      },
      logger: {
        log: ({ event, context }) => logs.push({ event, context: context ?? {} })
      },
      persistence
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-release-mismatch', identifier: 'ABC-MISMATCH', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-release-mismatch', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-release-mismatch', identifier: 'ABC-MISMATCH', state: 'Agent Review' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    expect(releaseStateDuringMismatch).toBe('requested');
    expect(completedRuns).toEqual([
      expect.objectContaining({
        terminal_status: 'succeeded',
        process_status: 'cancelled',
        workflow_outcome: 'handoff_reached',
        error_code: REASON_CODES.handoffRelease
      })
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.orchestration.staleWorkerExitIgnored,
        context: expect.objectContaining({
          issue_id: 'i-release-mismatch',
          stale_reason: 'worker_instance_mismatch',
          termination_state: 'requested',
          event_worker_instance_id: 'other-worker',
          event_session_id: 'other-session'
        })
      })
    );
    expect(
      logs.some(
        (entry) =>
          entry.event === CANONICAL_EVENT.orchestration.workerExitHandled &&
          entry.context.outcome === 'termination_exit_observed'
      )
    ).toBe(false);
  });

  it('keeps termination release active across cleanup and treats exit as confirmation-only', async () => {
    const completedRuns: Array<Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0]> = [];
    let releaseStateDuringCleanup: string | null = null;
    let harness: Harness;
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-cleanup-release',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    harness = createHarness({
      terminateWorker: async ({ issue_id, cleanup_workspace, reason }) => {
        harness.terminated.push({ issue_id, cleanup_workspace, reason });
        releaseStateDuringCleanup =
          harness.orchestrator.getStateSnapshot().running.get(issue_id)?.termination?.state ?? null;
        await harness.orchestrator.onWorkerExit(issue_id, 'abnormal', 'turn_input_required: choose next action', {
          worker_instance_id: harness.orchestrator.getStateSnapshot().running.get(issue_id)?.worker_instance_id,
          session_id: 'cleanup-session'
        });
        return makeTerminationResult({ cleanup_requested: cleanup_workspace, cleanup_succeeded: cleanup_workspace ? true : null });
      },
      persistence
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-cleanup-release', identifier: 'ABC-CLEANUP', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-cleanup-release', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'cleanup-thread',
      turn_id: 'cleanup-turn',
      session_id: 'cleanup-session'
    });
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-cleanup-release', identifier: 'ABC-CLEANUP', state: 'Done' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(releaseStateDuringCleanup).toBe('requested');
    expect(harness.terminated).toEqual([
      { issue_id: 'i-cleanup-release', cleanup_workspace: true, reason: REASON_CODES.terminalStateReached }
    ]);
    expect(snapshot.running.has('i-cleanup-release')).toBe(false);
    expect(snapshot.blocked_inputs.has('i-cleanup-release')).toBe(false);
    expect(snapshot.retry_attempts.has('i-cleanup-release')).toBe(false);
    expect(completedRuns).toEqual([
      expect.objectContaining({
        terminal_status: 'succeeded',
        process_status: 'cancelled',
        workflow_outcome: 'succeeded',
        error_code: REASON_CODES.terminalStateReached
      })
    ]);
  });

  it('records termination failure diagnostics without silently returning to healthy running', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      },
      terminateWorker: async () => {
        throw new Error('termination timed out');
      },
      logger: {
        log: ({ event, context }) => logs.push({ event, context: context ?? {} })
      }
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-termination-fails', identifier: 'ABC-TERMFAIL', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-termination-fails', identifier: 'ABC-TERMFAIL', state: 'Agent Review' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-termination-fails');
    expect(running?.termination).toEqual(
      expect.objectContaining({
        state: 'failed',
        reason: REASON_CODES.handoffRelease,
        failure_detail: 'termination timed out'
      })
    );
    expect(snapshot.claimed.has('i-termination-fails')).toBe(true);
    expect(snapshot.health.last_error).toContain('worker termination failed for ABC-TERMFAIL');
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.orchestration.workerTerminated,
        context: expect.objectContaining({
          issue_id: 'i-termination-fails',
          termination_state: 'failed',
          error: 'termination timed out'
        })
      })
    );
  });

  it('ignores late implementation worker exit after Agent Review fresh dispatch claims pre-session ownership', async () => {
    const completedRuns: Array<Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0]> = [];
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    let runSequence = 0;
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => `run-${++runSequence}`,
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      },
      logger: {
        log: ({ event, context }) => logs.push({ event, context: context ?? {} })
      },
      persistence
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-duplicate-review', identifier: 'ABC-DUPE', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');
    const implementationWorkerId = harness.orchestrator.getStateSnapshot().running.get('i-duplicate-review')?.worker_instance_id;

    harness.orchestrator.onWorkerEvent('i-duplicate-review', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session',
      codex_app_server_pid: 33021,
      worker_instance_id: implementationWorkerId
    });
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-duplicate-review', identifier: 'ABC-DUPE', state: 'Agent Review' })
    ]);
    await harness.orchestrator.reconcileRunningIssues();

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-duplicate-review', identifier: 'ABC-DUPE', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');
    const reviewBeforeLateExit = harness.orchestrator.getStateSnapshot().running.get('i-duplicate-review');
    expect(reviewBeforeLateExit?.worker_instance_id).toBe('i-duplicate-review-worker-2');
    expect(reviewBeforeLateExit?.thread_id).toBeNull();
    expect(reviewBeforeLateExit?.session_id).toBeNull();

    await harness.orchestrator.onWorkerExit('i-duplicate-review', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review',
      worker_instance_id: implementationWorkerId,
      codex_app_server_pid: 33021,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });

    const reviewAfterLateExit = harness.orchestrator.getStateSnapshot().running.get('i-duplicate-review');
    expect(reviewAfterLateExit?.worker_instance_id).toBe('i-duplicate-review-worker-2');
    expect(reviewAfterLateExit?.run_id).toBe('run-2');
    expect(reviewAfterLateExit?.thread_id).toBeNull();
    expect(harness.spawned).toHaveLength(2);
    expect(completedRuns).toHaveLength(1);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.orchestration.staleWorkerExitIgnored,
        context: expect.objectContaining({
          issue_id: 'i-duplicate-review',
          stale_reason: 'worker_instance_mismatch',
          active_worker_instance_id: 'i-duplicate-review-worker-2',
          event_worker_instance_id: implementationWorkerId
        })
      })
    );

    await harness.orchestrator.tick('interval');
    expect(harness.spawned).toHaveLength(2);
  });

  it('releases completed Agent Review ownership when issue routes back to In Progress for fresh dispatch', async () => {
    const completedRuns: Array<Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-review-terminal-release',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review', 'In Progress']
      },
      logger: {
        log: ({ event, context }) => {
          logs.push({ event, context: context ?? {} });
        }
      },
      persistence
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-terminal-release', identifier: 'NIE-87', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-review-terminal-release', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 7931
    });
    harness.orchestrator.onWorkerEvent('i-review-terminal-release', {
      timestamp_ms: harness.now.value + 2,
      event: CANONICAL_EVENT.codex.turnCompleted,
      detail: 'task_complete',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 7931
    });

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-review-terminal-release', identifier: 'NIE-87', state: 'In Progress' })
    ]);
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-terminal-release', identifier: 'NIE-87', state: 'In Progress' })
    ]);

    await harness.orchestrator.tick('interval');

    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-review-terminal-release',
        cleanup_workspace: false,
        reason: REASON_CODES.handoffRelease
      }
    ]);
    expect(completedRuns).toEqual([
      expect.objectContaining({
        terminal_status: 'succeeded',
        process_status: 'cancelled',
        workflow_outcome: 'handoff_reached',
        error_code: REASON_CODES.handoffRelease,
        terminal_reason_code: REASON_CODES.handoffRelease,
        session_id: 'review-session',
        thread_id: 'review-thread',
        turn_id: 'review-turn'
      })
    ]);
    expect(harness.spawned).toEqual([
      { issue_id: 'i-review-terminal-release', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-review-terminal-release', attempt: null, worker_host: null, resume_context: null }
    ]);
    harness.orchestrator.onWorkerEvent('i-review-terminal-release', {
      timestamp_ms: harness.now.value + 3,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'late waiting after task_complete',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session'
    });
    harness.orchestrator.onWorkerEvent('i-review-terminal-release', {
      timestamp_ms: harness.now.value + 4,
      event: CANONICAL_EVENT.codex.phasePlanning,
      detail: 'late planning after task_complete',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session'
    });
    const running = harness.orchestrator.getStateSnapshot().running.get('i-review-terminal-release');
    expect(running?.started_issue_state).toBe('In Progress');
    expect(running?.thread_id).toBeNull();
    expect(running?.last_event).toBeNull();
    expect(running?.last_codex_timestamp_ms).toBeNull();
    expect(running?.recent_events).toEqual([]);
    expect(running?.quarantined_event_count).toBe(2);
    expect(running?.quarantined_events?.map((event) => event.event)).toEqual([
      CANONICAL_EVENT.codex.turnWaiting,
      CANONICAL_EVENT.codex.phasePlanning
    ]);
    expect(running?.quarantined_events?.every((event) => event.reason === 'lineage_mismatch')).toBe(true);
    expect(
      logs.some(
        (entry) =>
          entry.event === CANONICAL_EVENT.orchestration.dispatchDuplicateSkipped &&
          entry.context.issue_id === 'i-review-terminal-release'
      )
    ).toBe(false);
  });

  it('quarantines terminal turn residue before tracker refresh releases ownership', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        handoff_states: ['Agent Review', 'In Progress'],
        fresh_dispatch_states: ['Agent Review', 'In Progress']
      }
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-terminal-residue', identifier: 'NIE-95', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-terminal-residue', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 85269
    });
    harness.orchestrator.onWorkerEvent('i-terminal-residue', {
      timestamp_ms: harness.now.value + 2,
      event: CANONICAL_EVENT.codex.turnCompleted,
      detail: 'task_complete',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 85269
    });
    harness.orchestrator.onWorkerEvent('i-terminal-residue', {
      timestamp_ms: harness.now.value + 3,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'late waiting after task_complete',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 85269
    });
    harness.orchestrator.onWorkerEvent('i-terminal-residue', {
      timestamp_ms: harness.now.value + 4,
      event: CANONICAL_EVENT.codex.phasePlanning,
      detail: 'late planning after task_complete',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 85269
    });
    harness.orchestrator.onWorkerEvent('i-terminal-residue', {
      timestamp_ms: harness.now.value + 5,
      event: CANONICAL_EVENT.codex.turnCompleted,
      detail: 'wrong-lineage terminal',
      thread_id: 'review-thread',
      turn_id: 'older-turn',
      session_id: 'older-session'
    });

    const completedRunning = harness.orchestrator.getStateSnapshot().running.get('i-terminal-residue');
    expect(completedRunning?.last_event).toBe(CANONICAL_EVENT.codex.turnCompleted);
    expect(completedRunning?.last_message).toBe('task_complete');
    expect(completedRunning?.last_codex_timestamp_ms).toBe(harness.now.value + 2);
    expect(completedRunning?.last_progress_transition_at_ms).toBe(harness.now.value + 2);
    expect(completedRunning?.current_phase).toBe('validation');
    expect(completedRunning?.recent_events.map((event) => event.event)).toEqual([
      CANONICAL_EVENT.codex.turnStarted,
      CANONICAL_EVENT.codex.turnCompleted
    ]);
    expect(completedRunning?.quarantined_event_count).toBe(3);
    expect(completedRunning?.quarantined_events?.map((event) => [event.event, event.reason])).toEqual([
      [CANONICAL_EVENT.codex.turnWaiting, 'terminal_residue'],
      [CANONICAL_EVENT.codex.phasePlanning, 'terminal_residue'],
      [CANONICAL_EVENT.codex.turnCompleted, 'lineage_mismatch']
    ]);

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-terminal-residue', identifier: 'NIE-95', state: 'In Progress' })
    ]);
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-terminal-residue', identifier: 'NIE-95', state: 'In Progress' })
    ]);

    await harness.orchestrator.tick('interval');

    const freshImplementation = harness.orchestrator.getStateSnapshot().running.get('i-terminal-residue');
    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-terminal-residue',
        cleanup_workspace: false,
        reason: REASON_CODES.handoffRelease
      }
    ]);
    expect(harness.spawned).toEqual([
      { issue_id: 'i-terminal-residue', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-terminal-residue', attempt: null, worker_host: null, resume_context: null }
    ]);
    expect(freshImplementation?.started_issue_state).toBe('In Progress');
    expect(freshImplementation?.last_event).toBeNull();
  });

  it('keeps fresh review worker running while Agent Review remains active', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-running', identifier: 'ABC-REVIEW', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-review-running', identifier: 'ABC-REVIEW', state: 'Agent Review' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    const running = harness.orchestrator.getStateSnapshot().running.get('i-review-running');
    expect(running?.issue.state).toBe('Agent Review');
    expect(harness.terminated).toEqual([]);
  });

  it('stops running worker without cleanup when state becomes non-active and non-terminal', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-nonactive' })]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-nonactive', state: 'Backlog' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-nonactive',
        cleanup_workspace: false,
        reason: 'non_active_state_transition'
      }
    ]);
  });

  it('preserves stalled root-cause diagnostics when non-active reconciliation cancels a run', async () => {
    const completedRuns: Array<Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-nonactive-stalled',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
      persistence
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-nonactive-stalled', identifier: 'ABC-STOP' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-nonactive-stalled', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for tool output',
      thread_id: 'thread-stop',
      turn_id: 'turn-stop',
      session_id: 'session-stop'
    });
    harness.now.value += 2_000;
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-nonactive-stalled', identifier: 'ABC-STOP', state: 'Agent Review' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-nonactive-stalled',
        cleanup_workspace: false,
        reason: 'non_active_state_transition'
      }
    ]);
    expect(completedRuns).toEqual([
      expect.objectContaining({
        run_id: 'run-nonactive-stalled',
        terminal_status: 'cancelled',
        error_code: 'non_active_state_transition',
        terminal_reason_code: 'non_active_state_transition',
        root_cause_status: 'blocked',
        root_cause_reason_code: REASON_CODES.turnWaitingThresholdExceeded,
        root_cause_reason_detail: 'codex turn waiting: waiting for tool output',
        root_cause_at: new Date(1_001_000).toISOString(),
        session_id: 'session-stop',
        thread_id: 'thread-stop',
        turn_id: 'turn-stop'
      })
    ]);
    expect(harness.orchestrator.getStateSnapshot().running.has('i-nonactive-stalled')).toBe(false);
  });

  it('records unsupported typed termination evidence when non-active reconciliation cancels a run', async () => {
    const completedRuns: Array<Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0]> = [];
    const stateTransitions: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendStateTransition']>>[0]> = [];
    const logs: Array<{ event: string; message: string; context: Record<string, unknown> }> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-nonactive-unsupported',
      appendIssueRun: async () => 'issue-run-nonactive-unsupported',
      appendAttempt: async () => 'attempt-nonactive-unsupported',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      appendStateTransition: async (params) => {
        stateTransitions.push(params);
        return `transition-${stateTransitions.length}`;
      },
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    const harness = createHarness({
      persistence,
      logger: {
        log: ({ event, message, context }) => logs.push({ event, message, context: context ?? {} })
      },
      terminateWorker: async () =>
        makeTerminationResult({
          result: 'unsupported',
          cancellation_supported: false,
          cancellation_requested: false,
          worker_settled: null,
          graceful_exit_observed: null,
          reason_code: 'worker_cancel_unsupported',
          detail: 'foreign worker handle does not expose cancel'
        })
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-nonactive-unsupported' })]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-nonactive-unsupported', state: 'Backlog' })
    ]);
    await harness.orchestrator.reconcileRunningIssues();

    expect(completedRuns).toEqual([
      expect.objectContaining({
        terminal_status: 'cancelled',
        terminal_reason_code: 'non_active_state_transition',
        terminal_reason_detail: expect.stringContaining('termination_result=unsupported')
      })
    ]);
    expect(stateTransitions.at(-1)).toEqual(
      expect.objectContaining({
        reason_code: 'non_active_state_transition',
        reason_detail: expect.stringContaining('termination_reason_code=worker_cancel_unsupported')
      })
    );
    const finalized = logs.find((entry) => entry.message === 'worker termination finalized: non_active_state_transition');
    expect(finalized?.context).toEqual(
      expect.objectContaining({
        worker_termination_result: 'unsupported',
        worker_termination_reason_code: 'worker_cancel_unsupported',
        graceful_exit_observed: null,
        worker_termination_requested: true
      })
    );
  });

  it('stops running worker with cleanup when state becomes terminal', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-terminal' })]);
    await harness.orchestrator.tick('interval');
    harness.now.value += 2500;

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-terminal', state: 'Done' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();
    const snapshot = harness.orchestrator.getStateSnapshot();

    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-terminal',
        cleanup_workspace: true,
        reason: REASON_CODES.terminalStateReached
      }
    ]);
    expect(snapshot.codex_totals.seconds_running).toBe(2);
  });

  it('is a no-op reconciliation when there are no running issues', async () => {
    const harness = createHarness();
    await harness.orchestrator.reconcileRunningIssues();
    expect(harness.tracker.fetch_issue_states_by_ids).not.toHaveBeenCalled();
  });

  it('keeps workers running when state refresh fails', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-refresh-fail' })]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_issue_states_by_ids.mockRejectedValue(new Error('unavailable'));
    await harness.orchestrator.reconcileRunningIssues();

    expect(harness.orchestrator.getStateSnapshot().running.has('i-refresh-fail')).toBe(true);
    expect(harness.terminated).toHaveLength(0);
  });

  it('kills stalled sessions and schedules retry', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({ configOverrides: { stall_timeout_ms: 10 }, logger });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-stall' })]);
    await harness.orchestrator.tick('interval');

    harness.now.value += 3200;
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([]);
    await harness.orchestrator.reconcileRunningIssues();

    const snapshot = harness.orchestrator.getStateSnapshot();
    const retryEntry = snapshot.retry_attempts.get('i-stall');
    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-stall',
        cleanup_workspace: false,
        reason: 'stall_timeout'
      }
    ]);
    expect(retryEntry?.attempt).toBe(1);
    expect(retryEntry?.error).toBe('worker stalled');
    expect(retryEntry?.stop_reason_code).toBe('worker_stalled');
    expect(snapshot.codex_totals.seconds_running).toBe(3);
    const stalled = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.workerStalled);
    expect(stalled?.context.issue_id).toBe('i-stall');
    expect(stalled?.context.issue_identifier).toBe('ABC-1');
  });

  it('records unknown typed termination evidence when stalled sessions are retried', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const harness = createHarness({
      configOverrides: { stall_timeout_ms: 10 },
      logger: {
        log: ({ event, context }) => {
          logs.push({ event, context: context ?? {} });
        }
      },
      terminateWorker: async () =>
        makeTerminationResult({
          result: 'unknown',
          worker_settled: null,
          graceful_exit_observed: null,
          forced_kill_requested: true,
          forced_kill_settled: false,
          reason_code: 'worker_cancel_forced_kill_unconfirmed',
          detail: 'forced kill was requested but process exit was not confirmed'
        })
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-stall-unknown' })]);
    await harness.orchestrator.tick('interval');

    harness.now.value += 3200;
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([]);
    await harness.orchestrator.reconcileRunningIssues();

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-stall-unknown');
    expect(retryEntry?.error).toBe('worker stalled');
    expect(retryEntry?.stop_reason_detail).toContain('termination_result=unknown');
    expect(retryEntry?.stop_reason_detail).toContain('termination_reason_code=worker_cancel_forced_kill_unconfirmed');
    expect(logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.workerStalled)?.context).toEqual(
      expect.objectContaining({
        worker_termination_result: 'unknown',
        worker_termination_reason_code: 'worker_cancel_forced_kill_unconfirmed',
        forced_kill_requested: true,
        forced_kill_settled: false
      })
    );
  });

  it('tracks failed dispatch validation in health state', async () => {
    const harness = createHarness();
    const dispatchDenied = new OrchestratorCore({
      config: {
        poll_interval_ms: 30_000,
        max_concurrent_agents: 2,
        max_concurrent_agents_by_state: {},
        max_retry_backoff_ms: 300_000,
        active_states: ['Todo', 'In Progress'],
        terminal_states: ['Done'],
        stall_timeout_ms: 300_000
      },
      ports: {
        tracker: harness.tracker,
        dispatchPreflight: () => ({ dispatch_allowed: false, reason: 'missing runtime token' }),
        spawnWorker: async () => ({ ok: false, error: 'blocked' }),
        terminateWorker: async () => makeTerminationResult(),
        scheduleRetryTimer: () => ({}),
        cancelRetryTimer: () => undefined,
        notifyObservers: () => undefined
      },
      nowMs: () => harness.now.value
    });

    await dispatchDenied.tick('interval');
    const snapshot = dispatchDenied.getStateSnapshot();
    expect(snapshot.health.dispatch_validation).toBe('failed');
    expect(snapshot.health.last_error).toContain('missing runtime token');
  });

  it('emits dispatch validation recovered when preflight transitions failed->ok', async () => {
    const tracker = makeTracker();
    const now = { value: 1_000_000 };
    const logs: Array<{ event: string; level: 'info' | 'warn' | 'error' }> = [];
    const dispatchAllowed = { value: false };
    const logger: StructuredLogger = {
      log: ({ level, event }) => {
        logs.push({ level, event });
      }
    };

    const orchestrator = new OrchestratorCore({
      config: {
        poll_interval_ms: 30_000,
        max_concurrent_agents: 2,
        max_concurrent_agents_by_state: {},
        max_retry_backoff_ms: 300_000,
        active_states: ['Todo', 'In Progress'],
        terminal_states: ['Done'],
        stall_timeout_ms: 300_000
      },
      ports: {
        tracker,
        dispatchPreflight: () =>
          dispatchAllowed.value
            ? { dispatch_allowed: true }
            : { dispatch_allowed: false, reason: 'missing runtime token' },
        spawnWorker: async () => ({ ok: false, error: 'blocked' }),
        terminateWorker: async () => makeTerminationResult(),
        scheduleRetryTimer: () => ({}),
        cancelRetryTimer: () => undefined,
        notifyObservers: () => undefined
      },
      nowMs: () => now.value,
      logger
    });

    await orchestrator.tick('interval');
    dispatchAllowed.value = true;
    await orchestrator.tick('manual_refresh');

    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.orchestration.dispatchValidationFailed)).toBe(true);
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.orchestration.dispatchValidationRecovered)).toBe(true);
    expect(orchestrator.getStateSnapshot().health.dispatch_validation).toBe('ok');
    expect(orchestrator.getStateSnapshot().health.last_error).toBeNull();
  });

  it('[SPEC-14.1-1] logs tracker state refresh failure and keeps workers running', async () => {
    const logs: Array<{ event: string }> = [];
    const logger: StructuredLogger = {
      log: ({ event }) => {
        logs.push({ event });
      }
    };
    const harness = createHarness({ logger });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-refresh-fail' })]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_issue_states_by_ids.mockRejectedValue(new Error('unavailable'));
    await harness.orchestrator.reconcileRunningIssues();

    expect(harness.orchestrator.getStateSnapshot().running.has('i-refresh-fail')).toBe(true);
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.tracker.stateRefreshFailed)).toBe(true);
  });

  it('logs retry candidate fetch failure and requeues retry with incremented attempt', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({ logger });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-retry-fetch-fail' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit('i-retry-fetch-fail', 'normal');
    harness.tracker.fetch_candidate_issues.mockRejectedValue(new Error('tracker unavailable'));
    await harness.orchestrator.onRetryTimer('i-retry-fetch-fail');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-retry-fetch-fail');
    expect(retryEntry?.attempt).toBe(2);
    expect(retryEntry?.error).toBe('retry poll failed');
    expect(retryEntry?.stop_reason_code).toBe('retry_fetch_failed');
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.tracker.retryFetchFailed)).toBe(true);
    const failureLog = logs.find((entry) => entry.event === CANONICAL_EVENT.tracker.retryFetchFailed);
    expect(failureLog?.context.issue_identifier).toBe('ABC-1');
    expect(failureLog?.context).not.toHaveProperty('identifier');
  });

  it('retries only tracker refresh after a completed turn refresh failure', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-refresh-retry', identifier: 'ABC-REFRESH', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-refresh-retry', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'completed-thread',
      turn_id: 'completed-turn',
      session_id: 'completed-session'
    });

    await harness.orchestrator.onWorkerExit('i-refresh-retry', 'normal', 'issue_state_refresh_failed: fetch failed', {
      completion_reason: REASON_CODES.issueStateRefreshFailed
    });

    const refreshRetry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-refresh-retry');
    expect(refreshRetry).toMatchObject({
      attempt: 1,
      error: 'tracker state refresh pending',
      stop_reason_code: REASON_CODES.issueStateRefreshFailed,
      previous_thread_id: 'completed-thread',
      previous_session_id: 'completed-session'
    });

    harness.tracker.fetch_candidate_issues.mockClear();
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-refresh-retry', identifier: 'ABC-REFRESH', state: 'In Progress' })
    ]);
    await harness.orchestrator.onRetryTimer('i-refresh-retry');

    expect(harness.tracker.fetch_issue_states_by_ids).toHaveBeenCalledWith(['i-refresh-retry']);
    expect(harness.tracker.fetch_candidate_issues).not.toHaveBeenCalled();
    expect(harness.spawned).toHaveLength(1);
    expect(harness.orchestrator.getStateSnapshot().retry_attempts.get('i-refresh-retry')).toMatchObject({
      attempt: 1,
      error: null,
      stop_reason_code: REASON_CODES.normalCompletion,
      previous_thread_id: 'completed-thread',
      previous_session_id: 'completed-session'
    });
  });

  it('emits typed retry cleanup when a refresh-failure retry resolves terminal', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({ logger });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-refresh-cleanup', identifier: 'ABC-CLEANUP' })
    ]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit(
      'i-refresh-cleanup',
      'normal',
      'issue_state_refresh_failed: Linear request failed: TypeError: fetch failed',
      { completion_reason: REASON_CODES.issueStateRefreshFailed }
    );
    const scheduledRetry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-refresh-cleanup');
    expect(scheduledRetry?.stop_reason_code).toBe(REASON_CODES.issueStateRefreshFailed);

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-refresh-cleanup', identifier: 'ABC-CLEANUP', state: 'Done' })
    ]);
    await harness.orchestrator.onRetryTimer('i-refresh-cleanup');

    const snapshot = harness.orchestrator.getStateSnapshot();
    const cleanupLog = logs.find((entry) => entry.event === CANONICAL_EVENT.tracker.retryCleared);
    expect(snapshot.retry_attempts.has('i-refresh-cleanup')).toBe(false);
    expect(snapshot.claimed.has('i-refresh-cleanup')).toBe(false);
    expect(cleanupLog?.context).toMatchObject({
      issue_id: 'i-refresh-cleanup',
      issue_identifier: 'ABC-CLEANUP',
      previous_retry_reason: REASON_CODES.issueStateRefreshFailed,
      retry_attempt: 1,
      observed_tracker_state: 'Done',
      cleanup_reason: 'tracker_state_terminal'
    });
    expect(cleanupLog?.context.due_at_ms).toBe(scheduledRetry?.due_at_ms);
    expect(
      snapshot.recent_runtime_events.some(
        (event) =>
          event.event === CANONICAL_EVENT.tracker.retryCleared &&
          event.issue_identifier === 'ABC-CLEANUP' &&
          event.detail?.includes('cleanup_reason=tracker_state_terminal') &&
          event.detail?.includes(`due_at_ms=${scheduledRetry?.due_at_ms}`)
      )
    ).toBe(true);
  });

  it('emits typed retry cleanup when a retry disappears from active candidates', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({ logger });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-missing-candidate' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-missing-candidate', 'normal');

    const scheduledRetry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-missing-candidate');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([]);
    await harness.orchestrator.onRetryTimer('i-missing-candidate');

    const cleanupLog = logs.find((entry) => entry.event === CANONICAL_EVENT.tracker.retryCleared);
    expect(harness.orchestrator.getStateSnapshot().retry_attempts.has('i-missing-candidate')).toBe(false);
    expect(cleanupLog?.context).toMatchObject({
      issue_id: 'i-missing-candidate',
      issue_identifier: 'ABC-1',
      previous_retry_reason: REASON_CODES.normalCompletion,
      retry_attempt: 1,
      observed_tracker_state: null,
      cleanup_reason: 'active_candidate_missing'
    });
    expect(cleanupLog?.context.due_at_ms).toBe(scheduledRetry?.due_at_ms);
  });

  it('emits deterministic lifecycle logs for dispatch, retry scheduling, worker exits, and terminal transitions', async () => {
    const logs: Array<{ event: string; message: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, message, context }) => {
        logs.push({ event, message, context: context ?? {} });
      }
    };
    const harness = createHarness({ logger });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-lifecycle', identifier: 'ABC-42' })]);

    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-lifecycle', 'normal');

    const dispatchStart = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.dispatchAttemptStarted);
    expect(dispatchStart?.context.issue_id).toBe('i-lifecycle');
    expect(dispatchStart?.context.issue_identifier).toBe('ABC-42');

    const dispatchSuccess = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.dispatchSpawnSucceeded);
    expect(dispatchSuccess?.message).toBe('dispatch spawn succeeded');
    expect(dispatchSuccess?.context.issue_identifier).toBe('ABC-42');

    const workerExit = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.workerExitHandled);
    expect(workerExit?.message).toBe('worker exit handled: completed; retrying continuation');
    expect(workerExit?.context.issue_id).toBe('i-lifecycle');
    expect(workerExit?.context.issue_identifier).toBe('ABC-42');
    expect(workerExit?.context).toHaveProperty('session_id');

    const retryScheduled = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.retryScheduled);
    expect(retryScheduled?.context.issue_id).toBe('i-lifecycle');
    expect(retryScheduled?.context.issue_identifier).toBe('ABC-42');
    expect(retryScheduled?.context.delay_type).toBe('continuation');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-terminal', identifier: 'ABC-99' })]);
    await harness.orchestrator.tick('interval');
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([makeIssue({ id: 'i-terminal', identifier: 'ABC-99', state: 'Done' })]);
    await harness.orchestrator.reconcileRunningIssues();

    const terminated = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.workerTerminated);
    expect(terminated?.context.issue_id).toBe('i-terminal');
    expect(terminated?.context.issue_identifier).toBe('ABC-99');
    expect(terminated?.context.reason).toBe(REASON_CODES.terminalStateReached);
    expect(terminated?.context.cleanup_workspace).toBe(true);
  });

  it('includes issue/session context when session persistence logging fails', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const writeFailures: Array<Parameters<NonNullable<OrchestratorPersistencePort['recordHistoryWriteFailure']>>[0]> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-1',
      recordSession: async () => {
        throw new Error('persistence unavailable');
      },
      recordHistoryWriteFailure: async (params) => {
        writeFailures.push(params);
      },
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({ logger, persistence });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-session-fail', identifier: 'ABC-5' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-session-fail', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      session_id: 'thread-9-turn-1'
    });
    await new Promise((resolve) => setImmediate(resolve));

    const persistenceFailure = logs.find((entry) => entry.event === CANONICAL_EVENT.persistence.recordSessionFailed);
    expect(persistenceFailure?.context.issue_id).toBe('i-session-fail');
    expect(persistenceFailure?.context.issue_identifier).toBe('ABC-5');
    expect(persistenceFailure?.context.session_id).toBe('thread-9-turn-1');
    expect(writeFailures).toEqual([]);
  });

  it('preserves unsupported approval method evidence beyond the runner callback', async () => {
    const recordedEvents: Array<Record<string, unknown>> = [];
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'legacy-run-approval',
      recordSession: async () => undefined,
      recordEvent: async (params) => {
        recordedEvents.push(params);
      },
      completeRun: async () => undefined
    };
    const harness = createHarness({
      logger: {
        log: ({ event, context }) => logs.push({ event, context: context ?? {} })
      },
      persistence
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-approval', identifier: 'ABC-APPROVAL' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent(
      'i-approval',
      toWorkerEvent(
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          event: CANONICAL_EVENT.codex.unsupportedServerRequest,
          codex_app_server_pid: 1234,
          thread_id: 'thread-approval',
          turn_id: 'turn-approval',
          session_id: 'session-approval',
          detail: 'approval/request',
          reason_code: REASON_CODES.unsupportedApprovalServerRequest,
          request_method: 'approval/request',
          request_category: 'approval'
        },
        harness.now.value + 10
      )
    );
    harness.orchestrator.onWorkerEvent(
      'i-approval',
      toWorkerEvent(
        {
          timestamp: new Date(harness.now.value + 11).toISOString(),
          event: CANONICAL_EVENT.codex.rateLimitsUpdated,
          codex_app_server_pid: 1234,
          thread_id: 'thread-approval',
          turn_id: 'turn-approval',
          session_id: 'session-approval',
          rate_limits: { primary: { remaining: 5, limit: 10 } }
        },
        harness.now.value + 11
      )
    );
    harness.orchestrator.onWorkerEvent(
      'i-approval',
      toWorkerEvent(
        {
          timestamp: new Date(harness.now.value + 12).toISOString(),
          event: CANONICAL_EVENT.codex.protocolWarning,
          codex_app_server_pid: 1234,
          thread_id: 'thread-approval',
          turn_id: 'turn-approval',
          session_id: 'session-approval',
          detail: 'guardian policy warning',
          protocol_warning: {
            method: 'guardianWarning',
            reason_code: REASON_CODES.codexProtocolGuardianWarning,
            message: 'guardian policy warning',
            severity: 'warn',
            source: 'app_server_protocol'
          },
          protocol_warnings: [
            {
              method: 'guardianWarning',
              reason_code: REASON_CODES.codexProtocolGuardianWarning,
              message: 'guardian policy warning',
              severity: 'warn',
              source: 'app_server_protocol'
            }
          ]
        },
        harness.now.value + 12
      )
    );
    harness.orchestrator.onWorkerEvent(
      'i-approval',
      toWorkerEvent(
        {
          timestamp: new Date(harness.now.value + 13).toISOString(),
          event: CANONICAL_EVENT.codex.modelRerouted,
          codex_app_server_pid: 1234,
          thread_id: 'thread-approval',
          turn_id: 'turn-approval',
          session_id: 'session-approval',
          detail: REASON_CODES.codexModelRerouted,
          model_reroute: {
            requested_model: 'gpt-requested',
            effective_model: 'gpt-effective',
            reason_code: REASON_CODES.codexModelRerouted,
            source: 'app_server_protocol'
          },
          requested_model: 'gpt-requested',
          effective_model: 'gpt-effective'
        },
        harness.now.value + 13
      )
    );
    harness.orchestrator.onWorkerEvent(
      'i-approval',
      toWorkerEvent(
        {
          timestamp: new Date(harness.now.value + 14).toISOString(),
          event: CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch,
          codex_app_server_pid: 1234,
          thread_id: 'thread-approval',
          turn_id: 'turn-approval',
          session_id: 'session-approval',
          detail: 'dynamic tool capability mismatch',
          tool_call_id: 'call-dynamic-1',
          tool_name: 'linear_graphql'
        },
        harness.now.value + 14
      )
    );
    await new Promise((resolve) => setImmediate(resolve));

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-approval');
    expect(running?.recent_events.find((event) => event.event === CANONICAL_EVENT.codex.unsupportedServerRequest)).toMatchObject({
      event: CANONICAL_EVENT.codex.unsupportedServerRequest,
      reason_code: REASON_CODES.unsupportedApprovalServerRequest,
      request_method: 'approval/request',
      request_category: 'approval'
    });
    expect(snapshot.recent_runtime_events.find((event) => event.event === CANONICAL_EVENT.codex.unsupportedServerRequest)).toMatchObject({
      event: CANONICAL_EVENT.codex.unsupportedServerRequest,
      reason_code: REASON_CODES.unsupportedApprovalServerRequest,
      request_method: 'approval/request',
      request_category: 'approval'
    });
    expect(recordedEvents.find((event) => event.event === CANONICAL_EVENT.codex.unsupportedServerRequest)).toMatchObject({
      event: CANONICAL_EVENT.codex.unsupportedServerRequest,
      reason_code: REASON_CODES.unsupportedApprovalServerRequest,
      request_method: 'approval/request',
      request_category: 'approval'
    });
    expect(logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.workerEvent)?.context).toMatchObject({
      reason_code: REASON_CODES.unsupportedApprovalServerRequest,
      request_method: 'approval/request',
      request_category: 'approval'
    });
    expect(running).toMatchObject({
      rate_limits: { primary: { remaining: 5, limit: 10 } },
      protocol_warnings: [
        {
          method: 'guardianWarning',
          reason_code: REASON_CODES.codexProtocolGuardianWarning,
          message: 'guardian policy warning',
          severity: 'warn',
          source: 'app_server_protocol'
        }
      ],
      model_reroute: {
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective',
        reason_code: REASON_CODES.codexModelRerouted,
        source: 'app_server_protocol'
      },
      requested_model: 'gpt-requested',
      effective_model: 'gpt-effective'
    });
    expect(
      running?.recent_events.find((event) => event.event === CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch)
    ).toMatchObject({
      tool_call_id: 'call-dynamic-1',
      tool_name: 'linear_graphql'
    });

    const projector = new SnapshotService({ nowMs: () => harness.now.value + 20 });
    const projected = projector.projectState(harness.orchestrator.getStateSnapshot());
    const projectedIssue = projector.projectIssue(harness.orchestrator.getStateSnapshot(), 'ABC-APPROVAL');
    expect(projected.running[0]).toMatchObject({
      rate_limits: { primary: { remaining: 5, limit: 10 } },
      protocol_warnings: [
        {
          reason_code: REASON_CODES.codexProtocolGuardianWarning,
          message: 'guardian policy warning'
        }
      ],
      model_reroute: {
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective'
      },
      requested_model: 'gpt-requested',
      effective_model: 'gpt-effective'
    });
    expect(projectedIssue?.running).toMatchObject({
      rate_limits: { primary: { remaining: 5, limit: 10 } },
      protocol_warnings: [
        {
          reason_code: REASON_CODES.codexProtocolGuardianWarning,
          message: 'guardian policy warning'
        }
      ],
      model_reroute: {
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective'
      },
      requested_model: 'gpt-requested',
      effective_model: 'gpt-effective'
    });
    expect(
      projectedIssue?.recent_events.find((event) => event.event === CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch)
    ).toMatchObject({
      tool_call_id: 'call-dynamic-1',
      tool_name: 'linear_graphql'
    });
    expect(projectedIssue?.recent_events.find((event) => event.event === CANONICAL_EVENT.codex.unsupportedServerRequest)).toMatchObject({
      reason_code: REASON_CODES.unsupportedApprovalServerRequest,
      request_method: 'approval/request',
      request_category: 'approval'
    });
    expect(projected.recent_runtime_events.find((event) => event.event === CANONICAL_EVENT.codex.unsupportedServerRequest)).toMatchObject({
      reason_code: REASON_CODES.unsupportedApprovalServerRequest,
      request_method: 'approval/request',
      request_category: 'approval'
    });
    expect(
      projected.recent_runtime_events.find((event) => event.event === CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch)
    ).toMatchObject({
      tool_call_id: 'call-dynamic-1',
      tool_name: 'linear_graphql'
    });
  });

  it('ignores usage aggregation when worker event thread_id mismatches active running thread', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-thread-mismatch' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-thread-mismatch', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-1',
      turn_id: 'turn-1'
    });

    harness.orchestrator.onWorkerEvent('i-thread-mismatch', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      thread_id: 'thread-2',
      usage: {
        input_tokens: 99,
        output_tokens: 99,
        total_tokens: 99
      }
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-thread-mismatch');
    expect(running?.tokens.total_tokens).toBe(0);
    expect(snapshot.codex_totals.total_tokens).toBe(0);
  });

  it('ignores stale worker events that mismatch the active running thread lineage', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-stale-thread', identifier: 'ABC-STALE' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-stale-thread', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-current',
      session_id: 'session-current'
    });
    harness.orchestrator.onWorkerEvent('i-stale-thread', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'late stale waiting heartbeat',
      thread_id: 'thread-stale',
      turn_id: 'turn-stale',
      session_id: 'session-stale'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-stale-thread');
    expect(running).toMatchObject({
      last_event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-current',
      session_id: 'session-current',
      stalled_waiting_reason: null,
      running_waiting_started_at_ms: null
    });
    expect(snapshot.phase_timeline?.get('i-stale-thread')?.map((marker) => marker.phase)).toEqual([
      'dispatch_started',
      'workspace_ready',
      'codex_turn_started'
    ]);
    expect(running?.quarantined_event_count).toBe(1);
    expect(running?.quarantined_events?.[0]).toEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnWaiting,
        thread_id: 'thread-stale',
        turn_id: 'turn-stale',
        session_id: 'session-stale',
        active_thread_id: 'thread-current',
        active_turn_id: 'turn-current',
        active_session_id: 'session-current',
        reason: 'lineage_mismatch'
      })
    );
    expect(snapshot.recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored)).toBe(
      false
    );
  });

  it('quarantines old implementation PID events after fresh Agent Review handoff even when they echo the fresh lineage', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-handoff-pid', identifier: 'NIE-84', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-handoff-pid', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session',
      codex_app_server_pid: 46181
    });
    await harness.orchestrator.onWorkerExit('i-handoff-pid', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-handoff-pid', identifier: 'NIE-84', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-handoff-pid', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'old implementation heartbeat elapsed_s=1151',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 46181
    });
    harness.orchestrator.onWorkerEvent('i-handoff-pid', {
      timestamp_ms: harness.now.value + 30,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'fresh review heartbeat elapsed_s=110',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 94799
    });
    harness.orchestrator.onWorkerEvent('i-handoff-pid', {
      timestamp_ms: harness.now.value + 40,
      event: CANONICAL_EVENT.codex.phasePlanning,
      detail: 'old implementation planning elapsed_s=1160',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 46181
    });

    const running = harness.orchestrator.getStateSnapshot().running.get('i-handoff-pid');
    expect(running).toMatchObject({
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: '94799',
      last_event: CANONICAL_EVENT.codex.turnWaiting,
      last_message: 'fresh review heartbeat elapsed_s=110'
    });
    expect(running?.quarantined_event_count).toBe(2);
    expect(running?.quarantined_events).toEqual([
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnWaiting,
        codex_app_server_pid: '46181',
        active_codex_app_server_pid: null,
        active_thread_id: null,
        active_turn_id: null,
        active_session_id: null,
        reason: 'inactive_worker_pid'
      }),
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.phasePlanning,
        codex_app_server_pid: '46181',
        active_codex_app_server_pid: '94799',
        active_thread_id: 'review-thread',
        active_turn_id: 'review-turn',
        active_session_id: 'review-session',
        reason: 'inactive_worker_pid'
      })
    ]);
  });

  it('accepts a fresh worker reusing an inactive PID after the TTL expires', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review'],
        inactive_worker_pid_ttl_ms: 1_000
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-reused-pid-after-ttl', identifier: 'NIE-86', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-reused-pid-after-ttl', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'old-thread',
      turn_id: 'old-turn',
      session_id: 'old-session',
      codex_app_server_pid: 46181
    });
    await harness.orchestrator.onWorkerExit('i-reused-pid-after-ttl', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.now.value += 1_001;
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-reused-pid-after-ttl', identifier: 'NIE-86', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-reused-pid-after-ttl', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'fresh-thread',
      turn_id: 'fresh-turn',
      session_id: 'fresh-session',
      codex_app_server_pid: 46181
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-reused-pid-after-ttl');
    expect(running).toMatchObject({
      thread_id: 'fresh-thread',
      turn_id: 'fresh-turn',
      session_id: 'fresh-session',
      codex_app_server_pid: '46181',
      quarantined_event_count: 0
    });
    expect(snapshot.inactive_worker_pids?.has('i-reused-pid-after-ttl')).toBe(false);
  });

  it('keeps reused inactive PID events quarantined before the TTL expires', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review'],
        inactive_worker_pid_ttl_ms: 1_000
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-reused-pid-before-ttl', identifier: 'NIE-86', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-reused-pid-before-ttl', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'old-thread',
      turn_id: 'old-turn',
      session_id: 'old-session',
      codex_app_server_pid: 46181
    });
    await harness.orchestrator.onWorkerExit('i-reused-pid-before-ttl', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.now.value += 999;
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-reused-pid-before-ttl', identifier: 'NIE-86', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-reused-pid-before-ttl', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'fresh-thread',
      turn_id: 'fresh-turn',
      session_id: 'fresh-session',
      codex_app_server_pid: 46181
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-reused-pid-before-ttl');
    expect(running).toMatchObject({
      thread_id: null,
      turn_id: null,
      session_id: null,
      codex_app_server_pid: null,
      quarantined_event_count: 1
    });
    expect(running?.quarantined_events?.[0]).toEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnStarted,
        codex_app_server_pid: '46181',
        reason: 'inactive_worker_pid'
      })
    );
    expect(snapshot.inactive_worker_pids?.get('i-reused-pid-before-ttl')).toEqual([
      expect.objectContaining({ pid: '46181' })
    ]);
  });

  it('prunes expired inactive PID entries before matching stale events', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review'],
        inactive_worker_pid_ttl_ms: 1_000
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-prune-expired-pid', identifier: 'NIE-86', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-prune-expired-pid', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'old-thread',
      turn_id: 'old-turn',
      session_id: 'old-session',
      codex_app_server_pid: 46181
    });
    await harness.orchestrator.onWorkerExit('i-prune-expired-pid', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.now.value += 1_000;
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-prune-expired-pid', identifier: 'NIE-86', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-prune-expired-pid', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnWaiting,
      thread_id: 'fresh-thread',
      turn_id: 'fresh-turn',
      session_id: 'fresh-session',
      codex_app_server_pid: 46181
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.inactive_worker_pids?.has('i-prune-expired-pid')).toBe(false);
    expect(snapshot.running.get('i-prune-expired-pid')?.quarantined_event_count).toBe(0);
  });

  it('quarantines old implementation and canceled review PID events after Cancel Turn retry', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-cancel-retry-pid', identifier: 'NIE-84', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-cancel-retry-pid', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session',
      codex_app_server_pid: 46181
    });
    await harness.orchestrator.onWorkerExit('i-cancel-retry-pid', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-cancel-retry-pid', identifier: 'NIE-84', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-cancel-retry-pid', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'first-review-thread',
      turn_id: 'first-review-turn',
      session_id: 'first-review-session',
      codex_app_server_pid: 94799
    });

    const cancelled = await harness.orchestrator.cancelCurrentTurn('NIE-84', {
      confirmed: true,
      reason_note: 'linear bug'
    });
    expect(cancelled).toEqual({ ok: true, issue_id: 'i-cancel-retry-pid' });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-cancel-retry-pid', identifier: 'NIE-84', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    for (const [pid, elapsed] of [
      [94799, 601],
      [46181, 1643]
    ] as const) {
      harness.orchestrator.onWorkerEvent('i-cancel-retry-pid', {
        timestamp_ms: harness.now.value + elapsed,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: `stale heartbeat elapsed_s=${elapsed}`,
        thread_id: 'retry-thread',
        turn_id: 'retry-turn',
        session_id: 'retry-session',
        codex_app_server_pid: pid
      });
    }
    harness.orchestrator.onWorkerEvent('i-cancel-retry-pid', {
      timestamp_ms: harness.now.value + 5,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'fresh retry heartbeat elapsed_s=5',
      thread_id: 'retry-thread',
      turn_id: 'retry-turn',
      session_id: 'retry-session',
      codex_app_server_pid: 5737
    });
    harness.orchestrator.onWorkerEvent('i-cancel-retry-pid', {
      timestamp_ms: harness.now.value + 700,
      event: CANONICAL_EVENT.codex.phasePlanning,
      detail: 'canceled worker planning elapsed_s=700',
      thread_id: 'retry-thread',
      turn_id: 'retry-turn',
      session_id: 'retry-session',
      codex_app_server_pid: 94799
    });

    const running = harness.orchestrator.getStateSnapshot().running.get('i-cancel-retry-pid');
    expect(running).toMatchObject({
      thread_id: 'retry-thread',
      turn_id: 'retry-turn',
      session_id: 'retry-session',
      codex_app_server_pid: '5737',
      last_event: CANONICAL_EVENT.codex.turnWaiting,
      last_message: 'fresh retry heartbeat elapsed_s=5'
    });
    expect(running?.quarantined_event_count).toBe(3);
    expect(running?.quarantined_events?.map((event) => [event.codex_app_server_pid, event.reason])).toEqual([
      ['94799', 'inactive_worker_pid'],
      ['46181', 'inactive_worker_pid'],
      ['94799', 'inactive_worker_pid']
    ]);
  });

  it('ignores stale turn started events from an old turn on the active thread', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-stale-turn', identifier: 'ABC-STALE-TURN' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-stale-turn', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2'
    });
    harness.orchestrator.onWorkerEvent('i-stale-turn', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-stale-turn', {
      timestamp_ms: harness.now.value + 200,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'late stale waiting heartbeat',
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-stale-turn');
    expect(running).toMatchObject({
      last_event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2',
      stalled_waiting_reason: null,
      running_waiting_started_at_ms: null
    });
    expect(snapshot.phase_timeline?.get('i-stale-turn')?.map((marker) => marker.phase)).toEqual([
      'dispatch_started',
      'workspace_ready',
      'codex_turn_started'
    ]);
    expect(running?.quarantined_event_count).toBe(2);
    expect(running?.quarantined_events?.map((event) => event.event)).toEqual([
      CANONICAL_EVENT.codex.turnStarted,
      CANONICAL_EVENT.codex.turnWaiting
    ]);
    expect(running?.quarantined_events?.every((event) => event.turn_id === 'turn-1')).toBe(true);
    expect(snapshot.recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored)).toBe(
      false
    );
  });

  it('accepts continuation turn starts on the active thread after the prior turn completed', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-continuation-turn', identifier: 'ABC-CONTINUE' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-continuation-turn', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-continuation-turn', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-continuation-turn', {
      timestamp_ms: harness.now.value + 200,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-continuation-turn');
    expect(running).toMatchObject({
      last_event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2',
      turn_count: 2
    });
    expect(snapshot.phase_timeline?.get('i-continuation-turn')?.map((marker) => marker.phase)).toEqual([
      'dispatch_started',
      'workspace_ready',
      'codex_turn_started',
      'validation'
    ]);
    expect(
      snapshot.recent_runtime_events.some(
        (event) =>
          event.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored &&
          event.issue_identifier === 'ABC-CONTINUE'
      )
    ).toBe(false);
  });

  it('accepts provider-neutral continuation turns and quarantines only stale prior-process activity', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-claude-continuation', identifier: 'ABC-CLAUDE-CONTINUE' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-claude-continuation', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.agentRunner.turnStarted,
      agent_runtime: 'claude-cli',
      worker_process_pid: 4001,
      thread_id: 'claude:session-current',
      turn_id: 'claude-turn-1',
      session_id: 'session-current',
      requested_model: 'claude-sonnet-4-6'
    });
    harness.orchestrator.onWorkerEvent('i-claude-continuation', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.agentRunner.turnCompleted,
      agent_runtime: 'claude-cli',
      worker_process_pid: 4001,
      thread_id: 'claude:session-current',
      turn_id: 'claude-turn-1',
      session_id: 'session-current',
      provider_usage: {
        runtime: 'claude-cli',
        model: 'claude-sonnet-4-6',
        effective_models: ['claude-sonnet-4-6'],
        input_tokens: 10,
        output_tokens: 4,
        cache_read_tokens: 2,
        cache_creation_tokens: 1,
        provider_turn_count: 1,
        estimated_cost_usd: 0.01,
        source: 'claude_stream_result',
        status: 'final',
        confidence: 'provider_result'
      }
    });
    harness.orchestrator.onWorkerEvent('i-claude-continuation', {
      timestamp_ms: harness.now.value + 200,
      event: CANONICAL_EVENT.agentRunner.turnStarted,
      agent_runtime: 'claude-cli',
      worker_process_pid: 4002,
      thread_id: 'claude:session-current',
      turn_id: 'claude-turn-2',
      session_id: 'session-current',
      requested_model: 'claude-sonnet-4-6'
    });

    const running = harness.orchestrator.getStateSnapshot().running.get('i-claude-continuation');
    expect(running).toMatchObject({
      last_event: CANONICAL_EVENT.agentRunner.turnStarted,
      agent_runtime: 'claude-cli',
      worker_process_pid: '4002',
      turn_id: 'claude-turn-2',
      session_id: 'session-current',
      turn_count: 2,
      provider_usage: {
        status: 'awaiting',
        input_tokens: null,
        output_tokens: null,
        estimated_cost_usd: null
      },
      quarantined_event_count: 0
    });

    harness.orchestrator.onWorkerEvent('i-claude-continuation', {
      timestamp_ms: harness.now.value + 300,
      event: CANONICAL_EVENT.agentRunner.activity,
      agent_runtime: 'claude-cli',
      worker_process_pid: 4001,
      thread_id: 'claude:session-current',
      turn_id: 'claude-turn-1',
      session_id: 'session-current',
      detail: 'late prior invocation event'
    });
    expect(harness.orchestrator.getStateSnapshot().running.get('i-claude-continuation')).toMatchObject({
      worker_process_pid: '4002',
      turn_id: 'claude-turn-2',
      quarantined_event_count: 1,
      quarantined_events: [
        expect.objectContaining({
          worker_process_pid: '4001',
          active_worker_process_pid: '4002',
          turn_id: 'claude-turn-1',
          active_turn_id: 'claude-turn-2',
          reason: 'worker_identity_mismatch'
        })
      ]
    });
  });

  it('ignores stale turn started events from an old turn after a newer turn completed', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-stale-after-complete', identifier: 'ABC-STALE-COMPLETE' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-stale-after-complete', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-stale-after-complete', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-stale-after-complete', {
      timestamp_ms: harness.now.value + 200,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2'
    });
    harness.orchestrator.onWorkerEvent('i-stale-after-complete', {
      timestamp_ms: harness.now.value + 300,
      event: CANONICAL_EVENT.codex.turnCompleted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2'
    });
    harness.orchestrator.onWorkerEvent('i-stale-after-complete', {
      timestamp_ms: harness.now.value + 400,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-stale-after-complete');
    expect(running).toMatchObject({
      last_event: CANONICAL_EVENT.codex.turnCompleted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2',
      turn_count: 2
    });
    expect(snapshot.phase_timeline?.get('i-stale-after-complete')?.map((marker) => marker.phase)).toEqual([
      'dispatch_started',
      'workspace_ready',
      'codex_turn_started',
      'validation'
    ]);
    expect(running?.quarantined_event_count).toBe(1);
    expect(running?.quarantined_events?.[0]).toEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-current',
        turn_id: 'turn-1',
        session_id: 'session-turn-1',
        active_thread_id: 'thread-current',
        active_turn_id: 'turn-2',
        active_session_id: 'session-turn-2',
        reason: 'lineage_mismatch'
      })
    );
    expect(snapshot.recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored)).toBe(
      false
    );
  });

  it('ignores stale turn started events with old session lineage even when thread lineage is omitted', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-stale-start-session', identifier: 'ABC-STALE-SESSION' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-stale-start-session', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-current',
      session_id: 'session-current'
    });
    harness.orchestrator.onWorkerEvent('i-stale-start-session', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnStarted,
      turn_id: 'turn-stale',
      session_id: 'session-stale'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-stale-start-session');
    expect(running).toMatchObject({
      last_event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-current',
      session_id: 'session-current'
    });
    expect(snapshot.phase_timeline?.get('i-stale-start-session')?.map((marker) => marker.phase)).toEqual([
      'dispatch_started',
      'workspace_ready',
      'codex_turn_started'
    ]);
    expect(running?.quarantined_event_count).toBe(1);
    expect(running?.quarantined_events?.[0]).toEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: null,
        turn_id: 'turn-stale',
        session_id: 'session-stale',
        active_thread_id: 'thread-current',
        active_turn_id: 'turn-current',
        active_session_id: 'session-current',
        reason: 'lineage_mismatch'
      })
    );
    expect(snapshot.recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored)).toBe(
      false
    );
  });
});
