import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

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
  RuntimeBuildIdentityState,
  StructuredLogger,
  TranscriptToolCallDiagnostic,
  TranscriptToolCallLineage
} from './core-test-harness';

function makeRuntimeIdentity(status: 'current' | 'stale'): RuntimeBuildIdentityState {
  const stale = status === 'stale';
  return {
    process_started_at_ms: Date.parse('2026-05-21T09:00:00.000Z'),
    running_build: {
      identity: 'runtime-old',
      commit_sha: 'runtime-old',
      source_timestamp_ms: Date.parse('2026-05-21T08:55:00.000Z')
    },
    current_build: {
      identity: stale ? 'current-new' : 'runtime-old',
      commit_sha: stale ? 'current-new' : 'runtime-old',
      source_timestamp_ms: Date.parse(stale ? '2026-05-21T09:30:00.000Z' : '2026-05-21T08:55:00.000Z'),
      status: 'available'
    },
    status,
    health_warning: stale
      ? {
          code: 'stale_runtime_build',
          severity: 'warning',
          message: 'Running runtime build runtime-old is stale compared with current-new',
          recommended_action: 'Enter Drain Mode, wait for quiescence, rebuild, and restart Symphony.'
        }
      : null
  };
}

describe('OrchestratorCore blocked input', () => {
  const stalledProgressSignals = async () => ({
    commit_sha: 'sha-same',
    checklist_checkpoint: 'chk-same',
    state_marker: 'marker-same'
  });

  function createAutomationFaultHarness(options: Parameters<typeof createHarness>[0] = {}): Harness {
    return createHarness({
      ...options,
      configOverrides: {
        respawn_max_attempts_without_progress: 1,
        ...options.configOverrides
      },
      resolveProgressSignals: options.resolveProgressSignals ?? stalledProgressSignals
    });
  }

  async function openAutomationFault(harness: Harness, issue: Issue): Promise<void> {
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(issue.id, 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get(issue.id)?.callback();
    expect(harness.orchestrator.getStateSnapshot().circuit_breakers.get(issue.id)).toMatchObject({
      breaker_active: true
    });
  }

  it('surfaces pre-session ownership conflicts and filters stale operator action state from fresh runs', async () => {
    let harness: Harness;
    harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review', 'In Progress']
      },
      terminateWorker: async ({ issue_id, cleanup_workspace, reason }) => {
        harness.terminated.push({ issue_id, cleanup_workspace, reason });
        const releasing = harness.orchestrator.getStateSnapshot().running.get(issue_id);
        await harness.orchestrator.onWorkerExit(issue_id, 'abnormal', 'operator cancellation settled', {
          worker_instance_id: releasing?.worker_instance_id,
          codex_app_server_pid: releasing?.codex_app_server_pid,
          thread_id: releasing?.thread_id,
          turn_id: releasing?.turn_id,
          session_id: releasing?.session_id
        });
        return makeTerminationResult({ cleanup_requested: cleanup_workspace, cleanup_succeeded: cleanup_workspace ? true : null });
      }
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-stale-action', identifier: 'NIE-ACTION', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');
    const firstWorkerId = harness.orchestrator.getStateSnapshot().running.get('i-stale-action')?.worker_instance_id;

    harness.orchestrator.onWorkerEvent('i-stale-action', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'old-thread',
      turn_id: 'old-turn',
      session_id: 'old-session',
      codex_app_server_pid: 97537,
      worker_instance_id: firstWorkerId
    });
    await harness.orchestrator.cancelCurrentTurn('NIE-ACTION', {
      confirmed: true,
      actor: 'operator',
      reason_note: 'wrong worker'
    });
    harness.now.value += 100;
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-stale-action', identifier: 'NIE-ACTION', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    const fresh = harness.orchestrator.getStateSnapshot().running.get('i-stale-action');
    expect(fresh?.worker_instance_id).toBe('i-stale-action-worker-2');
    expect(fresh?.session_id).toBeNull();
    harness.orchestrator.onWorkerEvent('i-stale-action', {
      timestamp_ms: harness.now.value + 2,
      event: CANONICAL_EVENT.codex.phasePlanning,
      detail: 'same-issue event from a different live worker before session identity',
      codex_app_server_pid: 87938,
      worker_instance_id: firstWorkerId
    });

    const projected = new SnapshotService({ nowMs: () => harness.now.value + 3 }).projectState(
      harness.orchestrator.getStateSnapshot()
    );
    const row = projected.running.find((entry) => entry.issue_id === 'i-stale-action');
    expect(row?.operator_actions).toEqual([]);
    expect(row?.quarantined_event_count).toBe(1);
    expect(row?.ownership_conflict).toEqual(
      expect.objectContaining({
        reason: 'pre_session_identity_conflict',
        event_codex_app_server_pid: '87938',
        active_worker_instance_id: 'i-stale-action-worker-2',
        event_worker_instance_id: firstWorkerId
      })
    );
    const issueProjection = new SnapshotService({ nowMs: () => harness.now.value + 3 }).projectIssue(
      harness.orchestrator.getStateSnapshot(),
      'NIE-ACTION'
    );
    expect(issueProjection.running?.operator_actions).toEqual([]);
    expect(issueProjection.operator_actions).toEqual([]);
  });

  it('does not schedule continuation retry when normal exit has no refreshed issue', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-missing-refresh' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit('i-missing-refresh', 'normal', undefined, {
      completion_reason: 'issue_state_missing'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-missing-refresh')).toBe(false);
    expect(snapshot.completed.has('i-missing-refresh')).toBe(true);
    expect(harness.terminated).toEqual([]);
  });

  it('applies terminal cleanup without scheduling continuation when normal exit reached a terminal state', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-terminal' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit('i-terminal', 'normal', undefined, {
      completion_reason: 'terminal_state_reached',
      refreshed_state: 'Done'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-terminal')).toBe(false);
    expect(snapshot.completed.has('i-terminal')).toBe(true);
    expect(harness.terminated).toEqual([
      { issue_id: 'i-terminal', cleanup_workspace: true, reason: 'terminal_state_transition' }
    ]);
  });

  it('records typed terminal cleanup termination evidence on terminal completion', async () => {
    const completedRuns: Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0][] = [];
    const stateTransitions: Parameters<NonNullable<OrchestratorPersistencePort['appendStateTransition']>>[0][] = [];
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-terminal-cleanup',
      appendIssueRun: async () => 'issue-run-terminal-cleanup',
      appendAttempt: async () => 'attempt-terminal-cleanup',
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
      logger: { log: ({ event, context }) => logs.push({ event, context: context ?? {} }) },
      terminateWorker: async ({ cleanup_workspace }) =>
        makeTerminationResult({
          cleanup_requested: cleanup_workspace,
          cleanup_succeeded: true,
          result: 'unsupported',
          cancellation_supported: false,
          cancellation_requested: false,
          worker_settled: null,
          graceful_exit_observed: null,
          reason_code: 'worker_cancel_unsupported',
          detail: 'worker handle does not support cancellation'
        })
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-terminal-evidence' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit('i-terminal-evidence', 'normal', undefined, {
      completion_reason: 'terminal_state_reached',
      refreshed_state: 'Done'
    });

    expect(completedRuns).toEqual([
      expect.objectContaining({
        terminal_status: 'succeeded',
        terminal_reason_code: REASON_CODES.terminalStateReached,
        terminal_reason_detail: expect.stringContaining('termination_result=unsupported')
      })
    ]);
    expect(stateTransitions.at(-1)).toEqual(
      expect.objectContaining({
        reason_code: REASON_CODES.terminalStateReached,
        reason_detail: expect.stringContaining('termination_reason_code=worker_cancel_unsupported')
      })
    );
    expect(logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.workerExitHandled)?.context).toEqual(
      expect.objectContaining({
        worker_termination_result: 'unsupported',
        worker_termination_reason_code: 'worker_cancel_unsupported',
        graceful_exit_observed: null
      })
    );
  });

  it('opens a no-progress automation fault without creating an input-required latch when the configured threshold is reached', async () => {
    const harness = createHarness({
      configOverrides: { max_retry_backoff_ms: 25_000, respawn_max_attempts_without_progress: 1 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-abnormal' })]);
    await harness.orchestrator.tick('interval');

    harness.now.value += 1;
    await harness.orchestrator.onWorkerExit('i-abnormal', 'abnormal');

    const firstRetry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-abnormal');
    expect(firstRetry?.attempt).toBe(1);
    expect(firstRetry?.stop_reason_code).toBe('worker_exit_abnormal');
    expect(firstRetry?.due_at_ms).toBe(harness.now.value + 10_000);

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-abnormal' })]);
    await harness.orchestrator.onRetryTimer('i-abnormal');
    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-abnormal')).toBe(false);
    expect(snapshot.blocked_inputs.has('i-abnormal')).toBe(false);
    expect(snapshot.circuit_breakers.get('i-abnormal')).toMatchObject({
      breaker_active: true,
      breaker_hit_count: 1
    });
  });

  it('moves turn_input_required exits into blocked input state without scheduling retries', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-blocked-input' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit(
      'i-blocked-input',
      'abnormal',
      'tool requestUserInput could not be auto-answered (turn_input_required)'
    );

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-blocked-input')).toBe(false);
    expect(snapshot.blocked_inputs.get('i-blocked-input')?.stop_reason_code).toBe('turn_input_required');
    expect(snapshot.blocked_inputs.get('i-blocked-input')?.requires_manual_resume).toBe(true);
    expect(snapshot.blocked_inputs.get('i-blocked-input')?.conflict_files).toEqual([]);
    expect(snapshot.blocked_inputs.get('i-blocked-input')?.resolution_hints).toEqual([]);
  });

  it('moves workspace conflict exits into blocked input state without scheduling retries', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-workspace-conflict' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit(
      'i-workspace-conflict',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace_unprovisioned_conflict: worktree_branch_conflict","conflict_files":[{"path":"src/orchestrator/core.ts","status":"unstaged"}],"resolution_hints":["Resolve worktree branch mismatch and resume manually."]}'
    );

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-workspace-conflict')).toBe(false);
    expect(snapshot.blocked_inputs.get('i-workspace-conflict')).toMatchObject({
      stop_reason_code: 'operator_action_required_workspace_conflict',
      requires_manual_resume: true,
      conflict_files: [{ path: 'src/orchestrator/core.ts', status: 'unstaged' }],
      resolution_hints: ['Resolve worktree branch mismatch and resume manually.']
    });
  });

  it('infers conflict_files for non-prefixed workspace conflict details', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-workspace-conflict-inferred' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit(
      'i-workspace-conflict-inferred',
      'abnormal',
      'workspace_unprovisioned_conflict: worktree_branch_conflict'
    );

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-workspace-conflict-inferred')).toBe(false);
    expect(snapshot.blocked_inputs.get('i-workspace-conflict-inferred')).toMatchObject({
      stop_reason_code: 'operator_action_required_workspace_conflict',
      requires_manual_resume: true,
      conflict_files: [{ path: '.git/HEAD', status: 'unknown' }]
    });
  });

  it('does not map unrelated destination-conflict text to workspace conflict stop reason', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-non-workspace-conflict' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit(
      'i-non-workspace-conflict',
      'abnormal',
      'upload validation failed: destination conflict in artifacts directory'
    );

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-non-workspace-conflict')).toBe(false);
    expect(snapshot.retry_attempts.get('i-non-workspace-conflict')?.stop_reason_code).toBe('worker_exit_abnormal');
  });

  it('does not redispatch blocked workspace-conflict issues across repeated scheduler ticks until explicit resume', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-workspace-conflict-blocked', identifier: 'ABC-BLOCK' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit(
      'i-workspace-conflict-blocked',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace_unprovisioned_conflict: worktree_branch_conflict","conflict_files":[{"path":"src/api/server.ts","status":"staged"}],"resolution_hints":["Resolve and resume."]}'
    );

    const spawnedBeforeTicks = harness.spawned.length;
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-workspace-conflict-blocked', identifier: 'ABC-BLOCK', state: 'In Progress' })
    ]);
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-workspace-conflict-blocked', identifier: 'ABC-BLOCK', state: 'In Progress' })
    ]);

    await harness.orchestrator.tick('interval');
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.tick('interval');

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-workspace-conflict-blocked')).toBe(true);
    expect(snapshot.retry_attempts.has('i-workspace-conflict-blocked')).toBe(false);
    expect(harness.spawned.length).toBe(spawnedBeforeTicks);

    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-BLOCK', null, null, {
      actor: 'operator@example.test',
      reason_note: 'workspace conflict resolved'
    });
    expect(resumed).toEqual({ ok: true, issue_id: 'i-workspace-conflict-blocked' });
    expect(harness.spawned.length).toBe(spawnedBeforeTicks + 1);
  });

  it('protects manual workspace-conflict resume ownership from late setup-session events', async () => {
    const completedRuns: Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0][] = [];
    const harness = createHarness({
      persistence: {
        startRun: async () => `run-blocked-resume-${completedRuns.length + 1}`,
        appendIssueRun: async () => 'issue-run-blocked-resume',
        appendAttempt: async ({ attempt_number }) => `attempt-blocked-resume-${attempt_number}`,
        recordSession: async () => undefined,
        recordEvent: async () => undefined,
        completeRun: async (params) => {
          completedRuns.push(params);
        }
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-workspace-conflict-resume', identifier: 'ABC-BLOCK-RESUME', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-workspace-conflict-resume', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'setup generated package-lock.json before workspace preflight blocked',
      thread_id: 'thread-setup',
      turn_id: 'turn-setup',
      session_id: 'session-setup'
    });
    await harness.orchestrator.onWorkerExit(
      'i-workspace-conflict-resume',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace contains setup/preflight residue","conflict_files":[{"path":"package-lock.json","status":"untracked","classification":"unknown_non_ephemeral"}],"resolution_hints":["Resolve and resume."]}',
      {
        thread_id: 'thread-setup',
        turn_id: 'turn-setup',
        session_id: 'session-setup'
      }
    );

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-workspace-conflict-resume');
    expect(blocked).toMatchObject({
      previous_thread_id: 'thread-setup',
      previous_turn_id: 'turn-setup',
      previous_session_id: 'session-setup',
      requires_manual_resume: true
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-workspace-conflict-resume', identifier: 'ABC-BLOCK-RESUME', state: 'In Progress' })
    ]);
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-workspace-conflict-resume', identifier: 'ABC-BLOCK-RESUME', state: 'In Progress' })
    ]);
    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-BLOCK-RESUME', 'operator cleared package-lock residue', null, {
      actor: 'operator@example.test',
      reason_note: 'workspace conflict resolved'
    });
    expect(resumed).toEqual({ ok: true, issue_id: 'i-workspace-conflict-resume' });

    harness.orchestrator.onWorkerEvent('i-workspace-conflict-resume', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.phasePlanning,
      detail: 'late setup session heartbeat after manual resume dispatch',
      thread_id: 'thread-setup',
      turn_id: 'turn-setup',
      session_id: 'session-setup'
    });
    let running = harness.orchestrator.getStateSnapshot().running.get('i-workspace-conflict-resume');
    expect(running).toMatchObject({
      thread_id: null,
      turn_id: null,
      session_id: null,
      last_event: null,
      quarantined_event_count: 1
    });

    harness.orchestrator.onWorkerEvent('i-workspace-conflict-resume', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnStarted,
      detail: 'replacement session owns manual residue recovery',
      thread_id: 'thread-replacement',
      turn_id: 'turn-replacement',
      session_id: 'session-replacement'
    });
    running = harness.orchestrator.getStateSnapshot().running.get('i-workspace-conflict-resume');
    expect(running).toMatchObject({
      thread_id: 'thread-replacement',
      turn_id: 'turn-replacement',
      session_id: 'session-replacement',
      last_event: CANONICAL_EVENT.codex.turnStarted,
      last_message: 'replacement session owns manual residue recovery',
      quarantined_event_count: 1
    });

    await harness.orchestrator.onWorkerExit('i-workspace-conflict-resume', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review',
      thread_id: 'thread-replacement',
      turn_id: 'turn-replacement',
      session_id: 'session-replacement'
    });
    expect(completedRuns.at(-1)).toMatchObject({
      terminal_status: 'succeeded',
      thread_id: 'thread-replacement',
      turn_id: 'turn-replacement',
      session_id: 'session-replacement'
    });
  });

  it('recovers restart-restored workspace attempt residue into a continuation retry', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-attempt-residue-'));
    spawnSync('git', ['init'], { cwd: workspacePath });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspacePath });
    spawnSync('git', ['config', 'user.name', 'Blocked Input Test'], { cwd: workspacePath });
    const harness = createHarness();
    harness.orchestrator.restoreSuppressionState({
      blocked_entries: [
        {
          issue_id: 'i-attempt-residue',
          issue_identifier: 'NIE-RESIDUE',
          attempt: 1,
          worker_host: null,
          workspace_path: workspacePath,
          provisioner_type: 'worktree',
          branch_name: 'feature/NIE-RESIDUE',
          repo_root: '/tmp/symphony',
          workspace_exists: true,
          workspace_git_status: 'dirty',
          workspace_provisioned: true,
          workspace_is_git_worktree: true,
          stop_reason_code: REASON_CODES.operatorWorkspaceConflict,
          stop_reason_detail: 'workspace contains non-ephemeral dirty files after preflight cleanup',
          conflict_files: [
            { path: 'tests/orchestrator/core.test.ts', status: 'unstaged', classification: 'unknown_non_ephemeral' },
            { path: 'tests/orchestrator/core-dispatch.test.ts', status: 'unknown', classification: 'unknown_non_ephemeral' }
          ],
          classification_summary: { ephemeral: 0, tracked_ephemeral: 0, unknown_non_ephemeral: 2 },
          resolution_hints: ['Inspect the dirty files in the issue worktree.'],
          previous_thread_id: 'thread-prev',
          previous_turn_id: 'turn-prev',
          previous_session_id: 'session-prev',
          blocked_at_ms: harness.now.value,
          requires_manual_resume: true,
          pending_input: null,
          session_console: []
        }
      ],
      breaker_entries: []
    });
    const issue = makeIssue({ id: 'i-attempt-residue', identifier: 'NIE-RESIDUE', state: 'In Progress' });
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([issue]);
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);

    await harness.orchestrator.reconcileBlockedInputs();
    await harness.scheduled.get('i-attempt-residue')?.callback();

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-attempt-residue')).toBe(false);
    expect(harness.spawned).toEqual([
      expect.objectContaining({
        issue_id: 'i-attempt-residue',
        attempt: 1,
        resume_context: expect.stringContaining('Workspace attempt residue recovery'),
        recover_workspace_attempt_residue: true
      })
    ]);
    harness.orchestrator.onWorkerEvent('i-attempt-residue', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.phasePlanning,
      detail: 'late restored setup session heartbeat',
      thread_id: 'thread-prev',
      turn_id: 'turn-prev',
      session_id: 'session-prev'
    });
    let running = harness.orchestrator.getStateSnapshot().running.get('i-attempt-residue');
    expect(running).toMatchObject({
      thread_id: null,
      turn_id: null,
      session_id: null,
      last_event: null,
      quarantined_event_count: 1
    });
    harness.orchestrator.onWorkerEvent('i-attempt-residue', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnStarted,
      detail: 'replacement owns restored residue',
      thread_id: 'thread-replacement',
      turn_id: 'turn-replacement',
      session_id: 'session-replacement'
    });
    running = harness.orchestrator.getStateSnapshot().running.get('i-attempt-residue');
    expect(running).toMatchObject({
      thread_id: 'thread-replacement',
      turn_id: 'turn-replacement',
      session_id: 'session-replacement',
      last_event: CANONICAL_EVENT.codex.turnStarted,
      quarantined_event_count: 1
    });
    const service = new SnapshotService();
    const projectedState = service.projectState(harness.orchestrator.getStateSnapshot());
    const projectedIssue = service.projectIssue(harness.orchestrator.getStateSnapshot(), 'NIE-RESIDUE');
    expect(projectedState.running[0]).toMatchObject({
      issue_identifier: 'NIE-RESIDUE',
      thread_id: 'thread-replacement',
      turn_id: 'turn-replacement',
      session_id: 'session-replacement',
      quarantined_event_count: 1
    });
    expect(projectedIssue.running).toMatchObject({
      thread_id: 'thread-replacement',
      turn_id: 'turn-replacement',
      session_id: 'session-replacement'
    });
    expect(projectedIssue.stale_events).toEqual([
      expect.objectContaining({
        thread_id: 'thread-prev',
        turn_id: 'turn-prev',
        session_id: 'session-prev',
        active_thread_id: null,
        active_turn_id: null,
        active_session_id: null,
        reason: 'lineage_mismatch'
      })
    ]);
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('recovers legacy persisted workspace residue with missing workspace metadata', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-legacy-residue-'));
    spawnSync('git', ['init'], { cwd: workspacePath });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspacePath });
    spawnSync('git', ['config', 'user.name', 'Blocked Input Test'], { cwd: workspacePath });
    try {
      const harness = createHarness();
      harness.orchestrator.restoreSuppressionState({
        blocked_entries: [
          {
            issue_id: 'i-legacy-residue',
            issue_identifier: 'NIE-LEGACY',
            attempt: 2,
            worker_host: null,
            workspace_path: workspacePath,
            provisioner_type: null,
            branch_name: null,
            repo_root: null,
            workspace_exists: true,
            workspace_git_status: 'unknown',
            workspace_provisioned: false,
            workspace_is_git_worktree: false,
            copy_ignored_applied: false,
            copy_ignored_status: null,
            copy_ignored_summary: null,
            stop_reason_code: REASON_CODES.operatorWorkspaceConflict,
            stop_reason_detail: 'tracked output/playwright artifacts remain after preflight cleanup',
            conflict_files: [
              { path: 'tests/orchestrator/core.test.ts', status: 'unstaged' },
              { path: 'tests/orchestrator/core-dispatch.test.ts', status: 'staged' }
            ],
            classification_summary: { ephemeral: 0, tracked_ephemeral: 0, unknown_non_ephemeral: 2 },
            resolution_hints: ['Remove tracked entries under output/playwright/ from git index/history.'],
            previous_thread_id: null,
            previous_turn_id: null,
            previous_session_id: null,
            blocked_at_ms: harness.now.value,
            requires_manual_resume: true,
            pending_input: null,
            session_console: []
          }
        ],
        breaker_entries: []
      });
      const issue = makeIssue({ id: 'i-legacy-residue', identifier: 'NIE-LEGACY', state: 'In Progress' });
      harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([issue]);
      harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);

      await harness.orchestrator.reconcileBlockedInputs();
      await harness.scheduled.get('i-legacy-residue')?.callback();

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-legacy-residue')).toBe(false);
      expect(harness.spawned).toEqual([
        expect.objectContaining({
          issue_id: 'i-legacy-residue',
          attempt: 2,
          recover_workspace_attempt_residue: true
        })
      ]);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('recovers legacy workspace residue when persisted classification summary undercounts live dirty files', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-legacy-residue-mismatch-'));
    spawnSync('git', ['init'], { cwd: workspacePath });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspacePath });
    spawnSync('git', ['config', 'user.name', 'Blocked Input Test'], { cwd: workspacePath });
    fs.mkdirSync(path.join(workspacePath, 'src/api'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'tests/api'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'src/api/dashboard-assets.ts'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(workspacePath, 'tests/api/dashboard-assets.test.ts'), 'import { value } from "../../src/api/dashboard-assets";\n');
    spawnSync('git', ['add', 'src/api/dashboard-assets.ts', 'tests/api/dashboard-assets.test.ts'], { cwd: workspacePath });
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: workspacePath });
    fs.writeFileSync(path.join(workspacePath, 'src/api/dashboard-assets.ts'), 'export const value = 2;\n');
    fs.writeFileSync(path.join(workspacePath, 'tests/api/dashboard-assets.test.ts'), 'import { value } from "../../src/api/dashboard-assets";\nexpect(value).toBe(2);\n');
    try {
      const harness = createHarness();
      harness.orchestrator.restoreSuppressionState({
        blocked_entries: [
          {
            issue_id: 'i-legacy-mismatch-residue',
            issue_identifier: 'NIE-181',
            attempt: 2,
            worker_host: null,
            workspace_path: workspacePath,
            provisioner_type: null,
            branch_name: null,
            repo_root: null,
            workspace_exists: true,
            workspace_git_status: 'unknown',
            workspace_provisioned: false,
            workspace_is_git_worktree: false,
            copy_ignored_applied: false,
            copy_ignored_status: null,
            copy_ignored_summary: null,
            stop_reason_code: REASON_CODES.operatorWorkspaceConflict,
            stop_reason_detail: 'workspace contains non-ephemeral dirty files after preflight cleanup',
            conflict_files: [
              { path: 'tests/api/dashboard-assets.test.ts', status: 'unstaged' },
              { path: 'src/api/dashboard-assets.ts', status: 'unstaged' }
            ],
            classification_summary: { ephemeral: 0, tracked_ephemeral: 0, unknown_non_ephemeral: 1 },
            resolution_hints: ['Inspect the dirty files in the issue worktree.'],
            previous_thread_id: null,
            previous_turn_id: null,
            previous_session_id: null,
            blocked_at_ms: harness.now.value,
            requires_manual_resume: true,
            pending_input: null,
            session_console: []
          }
        ],
        breaker_entries: []
      });
      const issue = makeIssue({ id: 'i-legacy-mismatch-residue', identifier: 'NIE-181', state: 'In Progress' });
      harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([issue]);
      harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);

      await harness.orchestrator.reconcileBlockedInputs();
      await harness.scheduled.get('i-legacy-mismatch-residue')?.callback();

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-legacy-mismatch-residue')).toBe(false);
      expect(harness.spawned).toEqual([
        expect.objectContaining({
          issue_id: 'i-legacy-mismatch-residue',
          attempt: 2,
          recover_workspace_attempt_residue: true
        })
      ]);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('keeps tracked workspace artifacts blocked during restart reconciliation', async () => {
    const harness = createHarness();
    harness.orchestrator.restoreSuppressionState({
      blocked_entries: [
        {
          issue_id: 'i-tracked-artifact',
          issue_identifier: 'NIE-ARTIFACT',
          attempt: 1,
          worker_host: null,
          workspace_path: '/tmp/symphony/NIE-ARTIFACT',
          provisioner_type: 'worktree',
          branch_name: 'feature/NIE-ARTIFACT',
          repo_root: '/tmp/symphony',
          workspace_exists: true,
          workspace_git_status: 'dirty',
          workspace_provisioned: true,
          workspace_is_git_worktree: true,
          stop_reason_code: REASON_CODES.operatorWorkspaceConflict,
          stop_reason_detail: 'tracked output/playwright artifacts remain after preflight cleanup',
          conflict_files: [{ path: 'output/playwright/demo.webm', status: 'staged', classification: 'tracked_ephemeral' }],
          classification_summary: { ephemeral: 0, tracked_ephemeral: 1, unknown_non_ephemeral: 0 },
          resolution_hints: ['Remove tracked entries under output/playwright/ from git index/history.'],
          previous_thread_id: 'thread-prev',
          previous_turn_id: 'turn-prev',
          previous_session_id: 'session-prev',
          blocked_at_ms: harness.now.value,
          requires_manual_resume: true,
          pending_input: null,
          session_console: []
        }
      ],
      breaker_entries: []
    });
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-tracked-artifact', identifier: 'NIE-ARTIFACT', state: 'In Progress' })
    ]);

    await harness.orchestrator.reconcileBlockedInputs();

    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-tracked-artifact')).toBe(true);
    expect(harness.scheduled.has('i-tracked-artifact')).toBe(false);
  });

  it('clears restored no-progress suppression for actionable issues without explicit resume', async () => {
    const harness = createHarness();
    harness.orchestrator.restoreSuppressionState({
      blocked_entries: [
        {
          issue_id: 'i-restored',
          issue_identifier: 'ABC-RESTORE',
          attempt: 2,
          worker_host: null,
          workspace_path: null,
          provisioner_type: null,
          branch_name: null,
          repo_root: null,
          workspace_exists: true,
          workspace_git_status: 'dirty',
          workspace_provisioned: true,
          workspace_is_git_worktree: true,
          copy_ignored_applied: false,
          copy_ignored_status: null,
          copy_ignored_summary: null,
          stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
          stop_reason_detail: 'blocked',
          conflict_files: [],
          resolution_hints: [],
          previous_thread_id: null,
          previous_session_id: null,
          last_phase: null,
          last_phase_at_ms: null,
          last_phase_detail: null,
          blocked_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
          requires_manual_resume: true,
          pending_input: null,
          last_input_submit: null,
          resume_history: [],
          session_console: []
        }
      ],
      breaker_entries: []
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-restored', identifier: 'ABC-RESTORE', state: 'In Progress' })
    ]);
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-restored', identifier: 'ABC-RESTORE', state: 'In Progress' })
    ]);

    await harness.orchestrator.tick('interval');
    await harness.orchestrator.tick('interval');
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-restored')).toBe(false);
    expect(harness.spawned.find((entry) => entry.issue_id === 'i-restored')).toBeDefined();

    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-RESTORE', null, 'manual override', {
      actor: 'operator@example.test',
      reason_note: 'manual override accepted'
    });
    expect(resumed).toEqual({
      ok: false,
      code: 'issue_not_blocked',
      message: 'Issue ABC-RESTORE is not blocked'
    });
  });

  it('persists and restores operator action outcomes around manual resume', async () => {
    const persistedActions = new Map<string, string>();
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-operator-action',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined,
      upsertOperatorActions: async (issueId, payload) => {
        persistedActions.set(issueId, payload);
      }
    };
    const harness = createHarness({
      configOverrides: { respawn_max_attempts_without_progress: 1 },
      persistence
    });
    harness.orchestrator.restoreSuppressionState({
      blocked_entries: [
        {
          issue_id: 'i-action-trail',
          issue_identifier: 'ABC-ACTION',
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
          stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
          stop_reason_detail: 'completion gate blocked redispatch because no progress signal was detected',
          conflict_files: [],
          resolution_hints: [],
          previous_thread_id: null,
          previous_session_id: null,
          blocked_at_ms: harness.now.value,
          requires_manual_resume: true,
          progress_signals: { commit_sha: null, checklist_checkpoint: null, state_marker: null },
          pending_input: null,
          session_console: []
        }
      ],
      breaker_entries: []
    });
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-action-trail', identifier: 'ABC-ACTION', state: 'In Progress' })
    ]);

    const rejected = await harness.orchestrator.resumeBlockedIssue('ABC-ACTION', null, null, {
      actor: 'operator@example.test',
      reason_note: 'progress evidence missing'
    });
    expect(rejected.ok).toBe(false);
    expect(persistedActions.get('i-action-trail')).toContain('resume_failed');

    const restored = createHarness();
    restored.orchestrator.restoreSuppressionState({
      blocked_entries: Array.from(harness.orchestrator.getStateSnapshot().blocked_inputs.values()),
      breaker_entries: [],
      operator_actions: new Map([['i-action-trail', JSON.parse(persistedActions.get('i-action-trail') ?? '[]')]])
    });
    expect(restored.orchestrator.getStateSnapshot().operator_actions?.get('i-action-trail')).toEqual([
      expect.objectContaining({
        action: 'resume',
        result: 'rejected',
        result_code: 'resume_failed'
      })
    ]);

    restored.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-action-trail', identifier: 'ABC-ACTION', state: 'In Progress' })
    ]);
    const accepted = await restored.orchestrator.resumeBlockedIssue('ABC-ACTION', null, 'operator reviewed trail', {
      actor: 'operator@example.test',
      reason_note: 'operator reviewed trail'
    });
    expect(accepted).toEqual({ ok: true, issue_id: 'i-action-trail' });
    expect(restored.orchestrator.getStateSnapshot().operator_actions?.get('i-action-trail')).toEqual([
      expect.objectContaining({ result: 'rejected' }),
      expect.objectContaining({ result: 'accepted' })
    ]);
  });

  it('resumes blocked issue via manual resume API path and dispatches immediately when eligible', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-resume', identifier: 'ABC-RESUME' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-resume',
      'abnormal',
      'tool requestUserInput could not be auto-answered (turn_input_required)'
    );

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-resume', identifier: 'ABC-RESUME', state: 'In Progress' })
    ]);

    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-RESUME', null, null, {
      actor: 'operator@example.test',
      reason_note: 'input request answered'
    });
    expect(resumed).toEqual({ ok: true, issue_id: 'i-resume' });
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-resume')).toBe(false);
    expect(harness.spawned.map((entry) => entry.issue_id)).toContain('i-resume');
  });

  it('holds blocked resume during Drain Mode without consuming blocked state', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-drain-resume', identifier: 'ABC-DRAIN-RESUME' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-drain-resume',
      'abnormal',
      'tool requestUserInput could not be auto-answered (turn_input_required)'
    );
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-drain-resume')).toBe(true);

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-drain-resume', identifier: 'ABC-DRAIN-RESUME', state: 'In Progress' })
    ]);
    (harness.orchestrator as any).enterDrainMode({ reason: 'safe runtime restart' });

    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-DRAIN-RESUME', null, null, {
      actor: 'operator@example.test',
      reason_note: 'input request answered'
    });

    expect(resumed).toEqual({
      ok: false,
      code: 'drain_mode_active',
      message: 'Drain Mode is active; resume is held until drain exits'
    });
    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-drain-resume')).toBe(true);
    expect(snapshot.claimed.has('i-drain-resume')).toBe(true);
    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-drain-resume']);
    expect(snapshot.operator_actions?.get('i-drain-resume')).toEqual([
      expect.objectContaining({
        action: 'resume',
        result: 'rejected',
        result_code: 'drain_mode_active'
      })
    ]);
  });

  it('refreshes runtime identity before blocked resume so stale-after-startup builds do not consume blocked state', async () => {
    let runtimeIdentity = makeRuntimeIdentity('current');
    const harness = createHarness({
      resolveRuntimeIdentity: () => runtimeIdentity
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-stale-resume', identifier: 'ABC-STALE-RESUME' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-stale-resume',
      'abnormal',
      'tool requestUserInput could not be auto-answered (turn_input_required)'
    );
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-stale-resume')).toBe(true);

    runtimeIdentity = makeRuntimeIdentity('stale');
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-stale-resume', identifier: 'ABC-STALE-RESUME', state: 'In Progress' })
    ]);

    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-STALE-RESUME', null, null, {
      actor: 'operator@example.test',
      reason_note: 'input request answered'
    });

    expect(resumed).toEqual({
      ok: false,
      code: 'runtime_identity_dispatch_blocked',
      message: 'Running runtime build runtime-old is stale compared with current-new'
    });
    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-stale-resume')).toBe(true);
    expect(snapshot.claimed.has('i-stale-resume')).toBe(true);
    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-stale-resume']);
    expect(snapshot.runtime_identity?.status).toBe('stale');
    expect(snapshot.quiescence.blocker_counts.stale_runtime).toBe(0);
    expect((snapshot.quiescence as any).warnings).toContainEqual(expect.objectContaining({ category: 'stale_runtime_warning' }));
    expect(snapshot.operator_actions?.get('i-stale-resume')).toEqual([
      expect.objectContaining({
        action: 'resume',
        result: 'rejected',
        result_code: 'runtime_identity_dispatch_blocked'
      })
    ]);
  });

  it('allows resume without override when real progress signals changed', async () => {
    let commit = 'sha-old';
    const harness = createHarness({
      configOverrides: { respawn_max_attempts_without_progress: 1 },
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: commit,
        checklist_checkpoint: 'chk-1',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({
      id: 'i-progress',
      identifier: 'ABC-PROGRESS',
      state: 'In Progress',
      tracker_meta: {
        tracker_kind: 'github',
        repository: 'repo/name',
        pr_links: [{ number: 1, url: 'https://example.test/pr/1', state: 'open', merged: false }]
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-progress', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-progress')?.callback();

    commit = 'sha-new';
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([issue]);
    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-PROGRESS', null, null, {
      actor: 'operator@example.test',
      reason_note: 'progress signal changed'
    });
    expect(resumed).toEqual({ ok: true, issue_id: 'i-progress' });
  });

  it('keeps redispatching no-progress attempts until the configured threshold is reached', async () => {
    const logs: Array<{ event: string; context?: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: { respawn_max_attempts_without_progress: 3, respawn_window_minutes: 30 },
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({ id: 'i-gate-block', identifier: 'ABC-GATE', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-gate-block', 'abnormal', 'worker exited');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-gate-block')?.callback();

    let snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-gate-block')).toBe(false);
    expect(snapshot.circuit_breakers.has('i-gate-block')).toBe(false);
    expect(snapshot.retry_attempts.has('i-gate-block')).toBe(false);
    expect(harness.spawned.filter((entry) => entry.issue_id === 'i-gate-block')).toHaveLength(2);
    expect(
      harness.orchestrator
        .getStateSnapshot()
        .recent_runtime_events.some((entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked)
    ).toBe(false);

    await harness.orchestrator.onWorkerExit('i-gate-block', 'abnormal', 'worker exited again');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-gate-block')?.callback();

    snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-gate-block')).toBe(false);
    expect(snapshot.circuit_breakers.has('i-gate-block')).toBe(false);
    expect(snapshot.retry_attempts.has('i-gate-block')).toBe(false);
    expect(harness.spawned.filter((entry) => entry.issue_id === 'i-gate-block')).toHaveLength(3);

    await harness.orchestrator.onWorkerExit('i-gate-block', 'abnormal', 'worker exited a third time');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-gate-block')?.callback();

    snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-gate-block')).toBe(false);
    expect(snapshot.circuit_breakers.get('i-gate-block')).toMatchObject({
      breaker_active: true,
      breaker_hit_count: 3,
      breaker_window_minutes: 30
    });
    expect(
      harness.orchestrator
        .getStateSnapshot()
        .recent_runtime_events.some((entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked)
    ).toBe(true);
    const completionGateLog = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked);
    expect(completionGateLog?.context?.issue_id).toBe('i-gate-block');
    expect(completionGateLog?.context?.issue_identifier).toBe('ABC-GATE');
    expect(completionGateLog?.context?.stop_reason_code).toBe('operator_action_required_no_progress_redispatch_blocked');
    expect(completionGateLog?.context?.next_operator_action).toBe('inspect_no_progress_fault');
    expect(harness.spawned.filter((entry) => entry.issue_id === 'i-gate-block')).toHaveLength(3);
  });

  it('maps no-progress redispatch to awaiting_human_review_scope_incomplete when PR is open', async () => {
    const harness = createHarness({
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({
      id: 'i-awaiting-human',
      identifier: 'ABC-AWAIT',
      state: 'In Progress',
      tracker_meta: {
        tracker_kind: 'github',
        repository: 'repo/name',
        pr_links: [{ number: 7, url: 'https://example.test/pr/7', state: 'open', merged: false }]
      },
      description: '- [ ] Acceptance item remains open'
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-awaiting-human', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-awaiting-human')?.callback();

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-awaiting-human');
    expect(blocked?.stop_reason_code).toBe('awaiting_human_review_scope_incomplete');
    expect(
      harness.orchestrator
        .getStateSnapshot()
        .recent_runtime_events.some(
          (entry) => entry.event === CANONICAL_EVENT.orchestration.stateAwaitingHumanReviewScopeIncomplete
        )
    ).toBe(true);
  });

  it('emits circuit-breaker-opened event when no-progress attempts in window exceed threshold', async () => {
    const logs: Array<{ event: string; context?: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: { respawn_max_attempts_without_progress: 1, respawn_window_minutes: 30 },
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({ id: 'i-breaker', identifier: 'ABC-BREAKER', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-breaker', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-breaker')?.callback();

    expect(
      harness.orchestrator
        .getStateSnapshot()
        .recent_runtime_events.some((entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCircuitBreakerOpened)
    ).toBe(true);
    const breakerLog = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCircuitBreakerOpened);
    expect(breakerLog?.context?.issue_id).toBe('i-breaker');
    expect(breakerLog?.context?.issue_identifier).toBe('ABC-BREAKER');
    expect(breakerLog?.context?.next_operator_action).toBe('inspect_no_progress_fault');
    expect(breakerLog?.context?.next_operator_action_endpoint).toBeNull();
  });

  it('emits completion gate and breaker transition events once for an already blocked issue', async () => {
    const logs: Array<{ event: string; context?: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: { respawn_max_attempts_without_progress: 1, respawn_window_minutes: 30 },
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({ id: 'i-once', identifier: 'ABC-ONCE', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-once', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-once')?.callback();
    await harness.orchestrator.onWorkerExit('i-once', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-once')?.callback();

    const completionEventCount = logs.filter(
      (entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked
    ).length;
    const breakerEventCount = logs.filter(
      (entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCircuitBreakerOpened
    ).length;
    expect(completionEventCount).toBe(1);
    expect(breakerEventCount).toBe(1);
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.size).toBe(0);
    expect(harness.orchestrator.getStateSnapshot().circuit_breakers.get('i-once')).toMatchObject({
      breaker_active: true
    });
  });

  it('refuses to resume a no-progress automation fault and names the endpoint that clears it', async () => {
    const harness = createHarness({
      configOverrides: { respawn_max_attempts_without_progress: 1 },
      resolveProgressSignals: async () => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: 'marker-same'
      })
    });
    const issue = makeIssue({ id: 'i-resume-override', identifier: 'ABC-OVERRIDE', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-resume-override', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-resume-override')?.callback();

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([issue]);
    const withoutOverride = await harness.orchestrator.resumeBlockedIssue('ABC-OVERRIDE', null, null, {
      actor: 'operator@example.test',
      reason_note: 'resume requested'
    });
    expect(withoutOverride).toEqual({
      ok: false,
      code: 'automation_fault_active',
      message: 'Issue ABC-OVERRIDE is held by a no-progress automation fault; clear it with POST /api/v1/issues/ABC-OVERRIDE/clear-automation-fault'
    });

    const withOverride = await harness.orchestrator.resumeBlockedIssue(
      'ABC-OVERRIDE',
      null,
      'operator approved redispatch without new progress',
      {
        actor: 'operator@example.test',
        reason_note: 'operator approved redispatch without new progress'
      }
    );
    expect(withOverride).toEqual({
      ok: false,
      code: 'automation_fault_active',
      message: 'Issue ABC-OVERRIDE is held by a no-progress automation fault; clear it with POST /api/v1/issues/ABC-OVERRIDE/clear-automation-fault'
    });
    expect(harness.orchestrator.getStateSnapshot().circuit_breakers.get('i-resume-override')).toMatchObject({
      breaker_active: true
    });
  });

  it('clears circuit-breaker-only automation faults and redispatches when dispatch gates pass', async () => {
    const persistence = {
      upsertBreaker: vi.fn(async () => undefined),
      deleteBreaker: vi.fn(async () => undefined),
      upsertOperatorActions: vi.fn(async () => undefined),
      appendOperatorActionHistory: vi.fn(async () => 'operator-action-1')
    };
    const harness = createHarness({
      configOverrides: { respawn_max_attempts_without_progress: 1 },
      persistence: persistence as any,
      resolveProgressSignals: async () => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: 'marker-same'
      })
    });
    const issue = makeIssue({ id: 'i-clear-fault', identifier: 'ABC-CLEAR-FAULT', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-clear-fault', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-clear-fault')?.callback();
    expect(harness.orchestrator.getStateSnapshot().circuit_breakers.get('i-clear-fault')).toMatchObject({
      breaker_active: true
    });

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([issue]);
    const result = await harness.orchestrator.clearAutomationFault('ABC-CLEAR-FAULT', {
      actor: 'operator@example.test',
      reason_note: 'operator fixed dirty checkout'
    });

    expect(result).toMatchObject({
      ok: true,
      issue_id: 'i-clear-fault',
      status: 'started',
      breaker_cleared: true,
      dispatch_started: true
    });
    expect(harness.orchestrator.getStateSnapshot().circuit_breakers.has('i-clear-fault')).toBe(false);
    expect(harness.orchestrator.getStateSnapshot().redispatch_progress?.has('i-clear-fault')).toBe(false);
    expect(persistence.deleteBreaker).toHaveBeenCalledWith('i-clear-fault');
    expect(harness.spawned.filter((entry) => entry.issue_id === 'i-clear-fault')).toHaveLength(2);
    expect(harness.spawned.at(-1)).toMatchObject({
      issue_id: 'i-clear-fault',
      attempt: null,
      resume_context: 'Operator cleared automation fault and requested redispatch'
    });
    expect(harness.orchestrator.getStateSnapshot().operator_actions?.get('i-clear-fault')?.at(-1)).toMatchObject({
      action: 'clear_automation_fault',
      result: 'accepted',
      result_code: 'dispatch_started',
      reason_note: 'operator fixed dirty checkout'
    });
    expect(harness.orchestrator.getStateSnapshot().recent_runtime_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'orchestration.automation_fault.cleared',
          issue_identifier: 'ABC-CLEAR-FAULT',
          reason_code: 'operator_clear_automation_fault'
        })
      ])
    );
  });

  it('holds automation fault clearing during Drain Mode without deleting breaker state', async () => {
    const persistence = {
      upsertBreaker: vi.fn(async () => undefined),
      deleteBreaker: vi.fn(async () => undefined),
      upsertOperatorActions: vi.fn(async () => undefined),
      appendOperatorActionHistory: vi.fn(async () => 'operator-action-1')
    };
    const harness = createHarness({
      configOverrides: { respawn_max_attempts_without_progress: 1 },
      persistence: persistence as any,
      resolveProgressSignals: async () => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: 'marker-same'
      })
    });
    const issue = makeIssue({ id: 'i-clear-drain', identifier: 'ABC-CLEAR-DRAIN', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-clear-drain', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-clear-drain')?.callback();
    (harness.orchestrator as any).enterDrainMode({ reason: 'safe runtime restart' });

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([issue]);
    const result = await harness.orchestrator.clearAutomationFault('ABC-CLEAR-DRAIN', {
      actor: 'operator@example.test',
      reason_note: 'operator fixed dirty checkout'
    });

    expect(result).toMatchObject({
      ok: true,
      issue_id: 'i-clear-drain',
      status: 'held',
      result_code: 'drain_mode_active',
      breaker_cleared: false,
      dispatch_started: false
    });
    expect(harness.orchestrator.getStateSnapshot().circuit_breakers.get('i-clear-drain')).toMatchObject({
      breaker_active: true
    });
    expect(persistence.deleteBreaker).not.toHaveBeenCalled();
    expect(harness.spawned.filter((entry) => entry.issue_id === 'i-clear-drain')).toHaveLength(1);
  });

  it.each([
    { state: 'Done', result_code: 'not_active' },
    { state: 'Backlog', result_code: 'not_active' }
  ])('rejects automation fault clearing when tracker state is $state without deleting breaker state', async ({ state, result_code }) => {
    const persistence = {
      upsertBreaker: vi.fn(async () => undefined),
      deleteBreaker: vi.fn(async () => undefined),
      upsertOperatorActions: vi.fn(async () => undefined),
      appendOperatorActionHistory: vi.fn(async () => 'operator-action-1')
    };
    const harness = createAutomationFaultHarness({ persistence: persistence as any });
    const issue = makeIssue({ id: `i-clear-${state.toLowerCase()}`, identifier: `ABC-CLEAR-${state.toUpperCase()}`, state: 'In Progress' });
    await openAutomationFault(harness, issue);

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([makeIssue({ ...issue, state })]);
    const result = await harness.orchestrator.clearAutomationFault(issue.identifier, {
      actor: 'operator@example.test',
      reason_note: 'operator fixed dirty checkout'
    });

    expect(result).toMatchObject({
      ok: true,
      issue_id: issue.id,
      status: 'held',
      result_code,
      breaker_cleared: false,
      dispatch_started: false
    });
    expect(harness.orchestrator.getStateSnapshot().circuit_breakers.get(issue.id)).toMatchObject({
      breaker_active: true
    });
    expect(persistence.deleteBreaker).not.toHaveBeenCalled();
    expect(harness.spawned.filter((entry) => entry.issue_id === issue.id)).toHaveLength(1);
    expect(harness.orchestrator.getStateSnapshot().operator_actions?.get(issue.id)?.at(-1)).toMatchObject({
      action: 'clear_automation_fault',
      result: 'rejected',
      result_code
    });
  });

  it('holds automation fault clearing when runtime identity is stale without deleting breaker state', async () => {
    let runtimeIdentity = makeRuntimeIdentity('current');
    const persistence = {
      upsertBreaker: vi.fn(async () => undefined),
      deleteBreaker: vi.fn(async () => undefined),
      upsertOperatorActions: vi.fn(async () => undefined),
      appendOperatorActionHistory: vi.fn(async () => 'operator-action-1')
    };
    const harness = createAutomationFaultHarness({
      persistence: persistence as any,
      resolveRuntimeIdentity: () => runtimeIdentity
    });
    const issue = makeIssue({ id: 'i-clear-stale-runtime', identifier: 'ABC-CLEAR-STALE', state: 'In Progress' });
    await openAutomationFault(harness, issue);

    runtimeIdentity = makeRuntimeIdentity('stale');
    const result = await harness.orchestrator.clearAutomationFault(issue.identifier, {
      actor: 'operator@example.test',
      reason_note: 'operator fixed dirty checkout'
    });

    expect(result).toEqual({
      ok: true,
      issue_id: issue.id,
      status: 'held',
      result_code: 'runtime_identity_dispatch_blocked',
      message: 'Running runtime build runtime-old is stale compared with current-new',
      dispatch_started: false,
      breaker_cleared: false
    });
    expect(harness.tracker.fetch_issue_states_by_ids).not.toHaveBeenCalled();
    expect(harness.orchestrator.getStateSnapshot().circuit_breakers.get(issue.id)).toMatchObject({
      breaker_active: true
    });
    expect(persistence.deleteBreaker).not.toHaveBeenCalled();
    expect(harness.spawned.filter((entry) => entry.issue_id === issue.id)).toHaveLength(1);
    expect(harness.orchestrator.getStateSnapshot().operator_actions?.get(issue.id)).toEqual([
      expect.objectContaining({
        action: 'clear_automation_fault',
        result: 'rejected',
        result_code: 'runtime_identity_dispatch_blocked'
      })
    ]);
  });

  it('holds automation fault clearing when dispatch preflight fails without deleting breaker state', async () => {
    let dispatchAllowed = true;
    const persistence = {
      upsertBreaker: vi.fn(async () => undefined),
      deleteBreaker: vi.fn(async () => undefined),
      upsertOperatorActions: vi.fn(async () => undefined),
      appendOperatorActionHistory: vi.fn(async () => 'operator-action-1')
    };
    const harness = createAutomationFaultHarness({
      persistence: persistence as any,
      dispatchPreflight: () =>
        dispatchAllowed ? { dispatch_allowed: true } : { dispatch_allowed: false, reason: 'worktree_dirty_repo' }
    });
    const issue = makeIssue({ id: 'i-clear-preflight', identifier: 'ABC-CLEAR-PREFLIGHT', state: 'In Progress' });
    await openAutomationFault(harness, issue);

    dispatchAllowed = false;
    const result = await harness.orchestrator.clearAutomationFault(issue.identifier, {
      actor: 'operator@example.test',
      reason_note: 'operator fixed dirty checkout'
    });

    expect(result).toEqual({
      ok: true,
      issue_id: issue.id,
      status: 'held',
      result_code: 'dispatch_validation_failed',
      message: 'worktree_dirty_repo',
      dispatch_started: false,
      breaker_cleared: false
    });
    expect(harness.tracker.fetch_issue_states_by_ids).not.toHaveBeenCalled();
    expect(harness.orchestrator.getStateSnapshot().circuit_breakers.get(issue.id)).toMatchObject({
      breaker_active: true
    });
    expect(persistence.deleteBreaker).not.toHaveBeenCalled();
    expect(harness.orchestrator.getStateSnapshot().recent_runtime_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: CANONICAL_EVENT.orchestration.dispatchValidationFailed,
          issue_identifier: issue.identifier,
          detail: 'worktree_dirty_repo'
        })
      ])
    );
    expect(harness.orchestrator.getStateSnapshot().operator_actions?.get(issue.id)?.at(-1)).toMatchObject({
      action: 'clear_automation_fault',
      result: 'rejected',
      result_code: 'dispatch_validation_failed'
    });
  });

  it('holds automation fault clearing when required GitHub issue link is missing without deleting breaker state', async () => {
    const persistence = {
      upsertBreaker: vi.fn(async () => undefined),
      deleteBreaker: vi.fn(async () => undefined),
      upsertOperatorActions: vi.fn(async () => undefined),
      appendOperatorActionHistory: vi.fn(async () => 'operator-action-1')
    };
    const harness = createAutomationFaultHarness({
      configOverrides: { github_linking_mode: 'required' },
      persistence: persistence as any
    });
    const issue = makeIssue({
      id: 'i-clear-github-link',
      identifier: 'ABC-CLEAR-GITHUB',
      state: 'In Progress',
      has_github_issue_link: true
    });
    await openAutomationFault(harness, issue);

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ ...issue, has_github_issue_link: false })
    ]);
    const result = await harness.orchestrator.clearAutomationFault(issue.identifier, {
      actor: 'operator@example.test',
      reason_note: 'operator fixed dirty checkout'
    });

    expect(result).toEqual({
      ok: true,
      issue_id: issue.id,
      status: 'held',
      result_code: 'github_issue_link_missing',
      message: 'Issue ABC-CLEAR-GITHUB is missing a linked GitHub issue',
      dispatch_started: false,
      breaker_cleared: false
    });
    expect(harness.orchestrator.getStateSnapshot().circuit_breakers.get(issue.id)).toMatchObject({
      breaker_active: true
    });
    expect(persistence.deleteBreaker).not.toHaveBeenCalled();
    expect(harness.spawned.filter((entry) => entry.issue_id === issue.id)).toHaveLength(1);
    expect(harness.orchestrator.getStateSnapshot().operator_actions?.get(issue.id)?.at(-1)).toMatchObject({
      action: 'clear_automation_fault',
      result: 'rejected',
      result_code: 'github_issue_link_missing'
    });
  });

  it('rejects automation fault clearing for running, retrying, and normal blocked-input states without consuming them', async () => {
    const cases = ['running', 'retrying', 'blocked'] as const;

    for (const conflictState of cases) {
      const persistence = {
        upsertBreaker: vi.fn(async () => undefined),
        deleteBreaker: vi.fn(async () => undefined),
        upsertOperatorActions: vi.fn(async () => undefined),
        appendOperatorActionHistory: vi.fn(async () => 'operator-action-1')
      };
      const harness = createAutomationFaultHarness({ persistence: persistence as any });
      const issue = makeIssue({
        id: `i-clear-conflict-${conflictState}`,
        identifier: `ABC-CLEAR-${conflictState.toUpperCase()}`,
        state: 'In Progress'
      });

      harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
      await harness.orchestrator.tick('interval');
      const originalRunning = (harness.orchestrator as any).state.running.get(issue.id);
      await harness.orchestrator.onWorkerExit(issue.id, 'abnormal', 'worker exited');
      const originalRetry = (harness.orchestrator as any).state.retry_attempts.get(issue.id);
      harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
      await harness.scheduled.get(issue.id)?.callback();

      if (conflictState === 'running') {
        (harness.orchestrator as any).state.running.set(issue.id, originalRunning);
      } else if (conflictState === 'retrying') {
        (harness.orchestrator as any).state.retry_attempts.set(issue.id, originalRetry);
      } else {
        (harness.orchestrator as any).state.blocked_inputs.set(issue.id, {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          attempt: 1,
          worker_host: null,
          workspace_path: null,
          provisioner_type: 'none',
          branch_name: null,
          repo_root: null,
          workspace_exists: null,
          workspace_git_status: null,
          workspace_provisioned: false,
          workspace_is_git_worktree: null,
          stop_reason_code: 'operator_action_required_workspace_conflict',
          stop_reason_detail: 'workspace conflict',
          conflict_files: [],
          resolution_hints: [],
          previous_thread_id: null,
          previous_session_id: null,
          blocked_at_ms: harness.now.value,
          requires_manual_resume: true,
          pending_input: null,
          session_console: []
        });
      }

      const result = await harness.orchestrator.clearAutomationFault(issue.identifier, {
        actor: 'operator@example.test',
        reason_note: 'operator fixed dirty checkout'
      });
      const snapshot = harness.orchestrator.getStateSnapshot();

      expect(result).toEqual({
        ok: false,
        code: 'unsupported_transition',
        message: `Issue ${issue.identifier} is running, retrying, or blocked on operator input`
      });
      expect(snapshot.circuit_breakers.get(issue.id)).toMatchObject({ breaker_active: true });
      expect(snapshot.running.has(issue.id)).toBe(conflictState === 'running');
      expect(snapshot.retry_attempts.has(issue.id)).toBe(conflictState === 'retrying');
      expect(snapshot.blocked_inputs.has(issue.id)).toBe(conflictState === 'blocked');
      expect(persistence.deleteBreaker).not.toHaveBeenCalled();
      expect(snapshot.operator_actions?.get(issue.id)?.at(-1)).toMatchObject({
        action: 'clear_automation_fault',
        result: 'rejected',
        result_code: 'unsupported_transition'
      });
    }
  });

  it('cancels blocked issue to Todo/backlog state via dedicated path', async () => {
    const logs: Array<{ event: string; context?: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context });
      }
    };
    const harness = createHarness({ logger });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-cancel', identifier: 'ABC-CANCEL' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-cancel',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace conflict","conflict_files":[],"resolution_hints":["Resolve and resume."]}'
    );

    const rejected = await harness.orchestrator.cancelBlockedIssue('ABC-CANCEL', 'operator_cancel_return_to_backlog');
    expect(rejected).toEqual({
      ok: false,
      code: 'confirmation_required',
      message: 'Cancel requires explicit confirmation'
    });
    expect(harness.tracker.update_issue_state).not.toHaveBeenCalled();
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-cancel')).toBe(true);

    const cancelled = await harness.orchestrator.cancelBlockedIssue('ABC-CANCEL', 'operator_cancel_return_to_backlog', {
      actor: 'operator@example.test',
      reason_note: 'operator_cancel_return_to_backlog',
      confirmed: true
    });
    expect(cancelled).toEqual({ ok: true, issue_id: 'i-cancel', moved_to_state: 'Todo' });
    expect(harness.tracker.update_issue_state).toHaveBeenCalledWith('i-cancel', 'Todo');
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-cancel')).toBe(false);
    expect(harness.orchestrator.getStateSnapshot().operator_actions?.get('i-cancel')).toEqual([
      expect.objectContaining({
        action: 'cancel',
        actor: 'operator',
        reason_note: 'operator_cancel_return_to_backlog',
        result: 'rejected',
        result_code: 'confirmation_required',
        target_identifiers: expect.objectContaining({
          issue_id: 'i-cancel',
          issue_identifier: 'ABC-CANCEL'
        }),
        pre_state: expect.objectContaining({ runtime_state: 'blocked' }),
        post_state: expect.objectContaining({ runtime_state: 'blocked' })
      }),
      expect.objectContaining({
        action: 'cancel',
        actor: 'operator@example.test',
        reason_note: 'operator_cancel_return_to_backlog',
        result: 'accepted',
        result_code: 'Todo',
        target_identifiers: expect.objectContaining({
          issue_id: 'i-cancel',
          issue_identifier: 'ABC-CANCEL'
        }),
        pre_state: expect.objectContaining({ runtime_state: 'blocked', issue_identifier: 'ABC-CANCEL' }),
        post_state: expect.objectContaining({ runtime_state: 'untracked' })
      })
    ]);
    const cancelLog = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.cancelToBacklogExecuted);
    expect(cancelLog?.context?.issue_id).toBe('i-cancel');
    expect(cancelLog?.context?.next_operator_action).toBe('issue.state.todo');
  });

  it('requires confirmation before cancelling a running turn and records audit context', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-cancel-turn', identifier: 'ABC-CANCEL-TURN' })]);
    await harness.orchestrator.tick('interval');

    const rejected = await harness.orchestrator.cancelCurrentTurn('ABC-CANCEL-TURN', {
      actor: 'operator@example.test',
      reason_note: 'wrong branch'
    });
    expect(rejected).toEqual({
      ok: false,
      code: 'confirmation_required',
      message: 'Cancel current turn requires explicit confirmation'
    });
    expect(harness.terminated).toEqual([]);

    const accepted = await harness.orchestrator.cancelCurrentTurn('ABC-CANCEL-TURN', {
      actor: 'operator@example.test',
      reason_note: 'wrong branch',
      confirmed: true
    });
    expect(accepted).toEqual({ ok: true, issue_id: 'i-cancel-turn' });
    expect(harness.terminated).toEqual([
      { issue_id: 'i-cancel-turn', cleanup_workspace: false, reason: 'wrong branch' }
    ]);
    expect(harness.orchestrator.getStateSnapshot().operator_actions?.get('i-cancel-turn')).toEqual([
      expect.objectContaining({
        action: 'cancel',
        actor: 'operator@example.test',
        reason_note: 'wrong branch',
        result: 'rejected',
        result_code: 'confirmation_required',
        pre_state: expect.objectContaining({ runtime_state: 'running' }),
        post_state: expect.objectContaining({ runtime_state: 'running' })
      }),
      expect.objectContaining({
        action: 'cancel',
        actor: 'operator@example.test',
        reason_note: 'wrong branch',
        result: 'accepted',
        result_code: 'current_turn_cancelled',
        pre_state: expect.objectContaining({ runtime_state: 'running' }),
        post_state: expect.objectContaining({ runtime_state: 'untracked' })
      })
    ]);
  });

  it('persists operator actions with run, attempt, thread, and turn lineage', async () => {
    const operatorActionHistory: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendOperatorActionHistory']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'legacy-run-operator',
      appendIssueRun: async () => 'issue-run-operator',
      appendAttempt: async () => 'attempt-operator',
      appendThread: async (params) => String(params.thread_id),
      appendTurn: async (params) => String(params.turn_id),
      appendTrackerTicketSnapshot: async () => 'snapshot-operator',
      appendTicketReference: async () => 'reference-operator',
      appendOperatorActionHistory: async (params) => {
        operatorActionHistory.push(params);
        return `operator_action_${operatorActionHistory.length}`;
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({ persistence });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-operator-history', identifier: 'ABC-OP-HIST' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-operator-history', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-operator-history',
      turn_id: 'turn-operator-history',
      session_id: 'session-operator-history'
    });
    await new Promise((resolve) => setImmediate(resolve));

    await harness.orchestrator.cancelCurrentTurn('ABC-OP-HIST', {
      actor: 'operator@example.test',
      reason_note: 'operator requested stop',
      confirmed: true
    });

    expect(operatorActionHistory).toEqual([
      expect.objectContaining({
        issue_run_id: 'issue-run-operator',
        attempt_id: 'attempt-operator',
        thread_id: 'thread-operator-history',
        turn_id: 'turn-operator-history',
        action: 'cancel',
        actor: 'operator@example.test',
        result: 'accepted',
        result_code: 'current_turn_cancelled',
        reason_note: 'operator requested stop',
        state_context: expect.objectContaining({
          issue_id: 'i-operator-history',
          target_identifiers: expect.objectContaining({
            issue_id: 'i-operator-history',
            issue_identifier: 'ABC-OP-HIST',
            issue_run_id: 'issue-run-operator',
            run_id: 'legacy-run-operator',
            attempt_id: 'attempt-operator',
            thread_id: 'thread-operator-history',
            turn_id: 'turn-operator-history'
          })
        })
      })
    ]);
  });

  it('requeues blocked issues and persists immutable audit state transition details', async () => {
    const persistedActions = new Map<string, string>();
    const harness = createHarness({
      persistence: {
        startRun: async () => 'run-requeue',
        recordSession: async () => undefined,
        recordEvent: async () => undefined,
        completeRun: async () => undefined,
        deleteBlockedInput: async () => undefined,
        upsertOperatorActions: async (issueId, payload) => {
          persistedActions.set(issueId, payload);
        }
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-requeue', identifier: 'ABC-REQUEUE' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-requeue',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace conflict","conflict_files":[],"resolution_hints":["Resolve and resume."]}'
    );

    const result = await harness.orchestrator.requeueIssue('ABC-REQUEUE', {
      actor: 'operator@example.test',
      reason_note: 'workspace repaired'
    });

    expect(result).toEqual({ ok: true, issue_id: 'i-requeue', retry_attempt: 1 });
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-requeue')).toBe(false);
    expect(harness.orchestrator.getStateSnapshot().retry_attempts.get('i-requeue')).toMatchObject({
      identifier: 'ABC-REQUEUE',
      stop_reason_code: 'operator_requeue_requested'
    });
    const persisted = JSON.parse(persistedActions.get('i-requeue') ?? '[]') as Array<Record<string, unknown>>;
    expect(persisted).toEqual([
      expect.objectContaining({
        action: 'requeue',
        actor: 'operator@example.test',
        reason_note: 'workspace repaired',
        result: 'accepted',
        pre_state: expect.objectContaining({ runtime_state: 'blocked' }),
        post_state: expect.objectContaining({ runtime_state: 'retrying' }),
        target_identifiers: expect.objectContaining({
          issue_id: 'i-requeue',
          issue_identifier: 'ABC-REQUEUE'
        })
      })
    ]);
  });

  it('retries the last failed or stalled retry step where supported', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-retry-step', identifier: 'ABC-RETRY' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-retry-step', 'abnormal', 'worker exited');

    const result = await harness.orchestrator.retryLastFailedStep('ABC-RETRY', {
      actor: 'operator@example.test',
      reason_note: 'transient failure cleared'
    });
    const unsupported = await harness.orchestrator.retryLastFailedStep('ABC-MISSING', {
      actor: 'operator@example.test',
      reason_note: 'try missing'
    });

    expect(result).toEqual({ ok: true, issue_id: 'i-retry-step', retry_attempt: 1 });
    expect(harness.orchestrator.getStateSnapshot().operator_actions?.get('i-retry-step')).toEqual([
      expect.objectContaining({
        action: 'retry_step',
        actor: 'operator@example.test',
        reason_note: 'transient failure cleared',
        result: 'accepted',
        result_code: 'retry_step_scheduled',
        pre_state: expect.objectContaining({ runtime_state: 'retrying' }),
        post_state: expect.objectContaining({ runtime_state: 'retrying' })
      })
    ]);
    expect(unsupported).toEqual({
      ok: false,
      code: 'unsupported_transition',
      message: 'Issue ABC-MISSING has no failed or stalled retry step'
    });
  });

  it('rejects missing reason notes before mutating operator action paths', async () => {
    const runningHarness = createHarness();
    runningHarness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-running-reason', identifier: 'ABC-RUNNING-REASON' })
    ]);
    await runningHarness.orchestrator.tick('interval');
    const cancelMissingReason = await runningHarness.orchestrator.cancelCurrentTurn('ABC-RUNNING-REASON', {
      confirmed: true
    });
    expect(cancelMissingReason).toEqual({ ok: false, code: 'reason_note_required', message: 'reason_note is required' });
    expect(runningHarness.terminated).toEqual([]);
    expect(runningHarness.orchestrator.getStateSnapshot().operator_actions?.get('i-running-reason')).toBeUndefined();

    const blockedHarness = createHarness();
    blockedHarness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-blocked-reason', identifier: 'ABC-BLOCKED-REASON' })
    ]);
    await blockedHarness.orchestrator.tick('interval');
    await blockedHarness.orchestrator.onWorkerExit(
      'i-blocked-reason',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace conflict","conflict_files":[],"resolution_hints":["Resolve and resume."]}'
    );
    blockedHarness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-blocked-reason', identifier: 'ABC-BLOCKED-REASON', state: 'In Progress' })
    ]);
    await expect(blockedHarness.orchestrator.requeueIssue('ABC-BLOCKED-REASON', { reason_note: '   ' })).resolves.toEqual({
      ok: false,
      code: 'reason_note_required',
      message: 'reason_note is required'
    });
    await expect(blockedHarness.orchestrator.resumeBlockedIssue('ABC-BLOCKED-REASON')).resolves.toEqual({
      ok: false,
      code: 'reason_note_required',
      message: 'reason_note is required'
    });
    await expect(blockedHarness.orchestrator.cancelBlockedIssue('ABC-BLOCKED-REASON', null, { confirmed: true })).resolves.toEqual({
      ok: false,
      code: 'reason_note_required',
      message: 'reason_note is required'
    });
    expect(blockedHarness.orchestrator.getStateSnapshot().blocked_inputs.has('i-blocked-reason')).toBe(true);
    expect(blockedHarness.orchestrator.getStateSnapshot().retry_attempts.has('i-blocked-reason')).toBe(false);
    expect(blockedHarness.orchestrator.getStateSnapshot().operator_actions?.get('i-blocked-reason')).toBeUndefined();

    const retryHarness = createHarness();
    retryHarness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-retry-reason', identifier: 'ABC-RETRY-REASON' })
    ]);
    await retryHarness.orchestrator.tick('interval');
    await retryHarness.orchestrator.onWorkerExit('i-retry-reason', 'abnormal', 'worker exited');
    const retryMissingReason = await retryHarness.orchestrator.retryLastFailedStep('ABC-RETRY-REASON');
    expect(retryMissingReason).toEqual({ ok: false, code: 'reason_note_required', message: 'reason_note is required' });
    expect(retryHarness.orchestrator.getStateSnapshot().operator_actions?.get('i-retry-reason')).toBeUndefined();

    const submitHarness = createHarness();
    submitHarness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-submit-reason', identifier: 'ABC-SUBMIT-REASON' })
    ]);
    await submitHarness.orchestrator.tick('interval');
    await submitHarness.orchestrator.onWorkerExit(
      'i-submit-reason',
      'abnormal',
      'turn_input_required:{"detail":"operator input required","request_id":"req-reason","prompt_text":"Continue?","questions":[{"id":"q1","prompt":"Continue?","options":[{"label":"Yes"},{"label":"No"}]}]}'
    );
    const submitMissingReason = await submitHarness.orchestrator.submitBlockedIssueInput({
      issue_identifier: 'ABC-SUBMIT-REASON',
      request_id: 'req-reason',
      answer: { question_id: 'q1', option_label: 'Yes' }
    });
    expect(submitMissingReason).toEqual({ ok: false, code: 'reason_note_required', message: 'reason_note is required' });
    expect(submitHarness.orchestrator.getStateSnapshot().operator_actions?.get('i-submit-reason')).toBeUndefined();
  });

  it('returns typed not-answerable error when native blocked input transport is unavailable', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-submit', identifier: 'ABC-SUBMIT' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-submit',
      'abnormal',
      'turn_input_required:{"detail":"operator input required","request_id":"req-123","prompt_text":"Choose deployment action","questions":[{"id":"q1","prompt":"Deploy now?","options":[{"label":"Yes"},{"label":"No"}]}]}'
    );

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-submit', identifier: 'ABC-SUBMIT', state: 'In Progress' })
    ]);

    const result = await harness.orchestrator.submitBlockedIssueInput({
      issue_identifier: 'ABC-SUBMIT',
      request_id: 'req-123',
      actor: 'operator@example.test',
      reason_note: 'answer selected',
      answer: { question_id: 'q1', option_label: 'Yes' }
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'input_submission_transport_unavailable'
    });
  });

  it('submits blocked operator input through native transport when available', async () => {
    const harness = createHarness({
      submitBlockedIssueInputNative: async () => ({ applied: true, code: 'native_applied' })
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-native', identifier: 'ABC-NATIVE' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-native', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-native',
      turn_id: 'turn-native-blocked',
      session_id: 'session-native'
    });
    await harness.orchestrator.onWorkerExit(
      'i-native',
      'abnormal',
      'turn_input_required:{"detail":"operator input required","request_id":"req-native","prompt_text":"Continue?","questions":[{"id":"q1","prompt":"Continue?","options":[{"label":"Yes"},{"label":"No"}]}]}'
    );

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-native', identifier: 'ABC-NATIVE', state: 'In Progress' })
    ]);

    const result = await harness.orchestrator.submitBlockedIssueInput({
      issue_identifier: 'ABC-NATIVE',
      request_id: 'req-native',
      actor: 'operator@example.test',
      reason_note: 'continue with selected answer',
      answer: { question_id: 'q1', option_label: 'Yes' }
    });

    expect(result).toMatchObject({
      ok: true,
      issue_id: 'i-native',
      request_id: 'req-native',
      resume_mode: 'native',
      resume_reason_code: 'native_applied'
    });
    const resumedSpawn = harness.spawned.find((entry) => entry.issue_id === 'i-native' && entry.attempt === 2);
    expect(resumedSpawn?.resume_context ?? null).toBeNull();

    harness.orchestrator.onWorkerEvent('i-native', {
      timestamp_ms: harness.now.value + 2,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-native',
      turn_id: 'turn-native-continuation',
      session_id: 'session-native'
    });
    expect(harness.orchestrator.getStateSnapshot().running.get('i-native')).toMatchObject({
      thread_id: 'thread-native',
      turn_id: 'turn-native-continuation',
      session_id: 'session-native',
      quarantined_event_count: 0
    });
  });

  it('holds native blocked input submission during Drain Mode without applying or consuming blocked state', async () => {
    const nativeSubmit = vi.fn(async () => ({ applied: true as const, code: 'native_applied' as const }));
    const harness = createHarness({
      submitBlockedIssueInputNative: nativeSubmit
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-native-drain', identifier: 'ABC-NATIVE-DRAIN' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-native-drain',
      'abnormal',
      'turn_input_required:{"detail":"operator input required","request_id":"req-native-drain","prompt_text":"Continue?","questions":[{"id":"q1","prompt":"Continue?","options":[{"label":"Yes"},{"label":"No"}]}]}'
    );
    (harness.orchestrator as any).enterDrainMode({ reason: 'safe runtime restart' });

    const result = await harness.orchestrator.submitBlockedIssueInput({
      issue_identifier: 'ABC-NATIVE-DRAIN',
      request_id: 'req-native-drain',
      actor: 'operator@example.test',
      reason_note: 'continue with selected answer',
      answer: { question_id: 'q1', option_label: 'Yes' }
    });

    expect(result).toEqual({
      ok: false,
      code: 'drain_mode_active',
      message: 'Drain Mode is active; input submission is held until drain exits'
    });
    expect(nativeSubmit).not.toHaveBeenCalled();
    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-native-drain')).toBe(true);
    expect(snapshot.blocked_inputs.get('i-native-drain')?.pending_input?.request_id).toBe('req-native-drain');
    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-native-drain']);
    expect(snapshot.operator_actions?.get('i-native-drain')).toEqual([
      expect.objectContaining({
        action: 'submit_input',
        result: 'rejected',
        result_code: 'drain_mode_active'
      })
    ]);
  });

  it('refreshes runtime identity before native blocked input so stale-after-startup builds do not apply input', async () => {
    let runtimeIdentity = makeRuntimeIdentity('current');
    const nativeSubmit = vi.fn(async () => ({ applied: true as const, code: 'native_applied' as const }));
    const harness = createHarness({
      resolveRuntimeIdentity: () => runtimeIdentity,
      submitBlockedIssueInputNative: nativeSubmit
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-native-stale', identifier: 'ABC-NATIVE-STALE' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-native-stale',
      'abnormal',
      'turn_input_required:{"detail":"operator input required","request_id":"req-native-stale","prompt_text":"Continue?","questions":[{"id":"q1","prompt":"Continue?","options":[{"label":"Yes"},{"label":"No"}]}]}'
    );

    runtimeIdentity = makeRuntimeIdentity('stale');
    const result = await harness.orchestrator.submitBlockedIssueInput({
      issue_identifier: 'ABC-NATIVE-STALE',
      request_id: 'req-native-stale',
      actor: 'operator@example.test',
      reason_note: 'continue with selected answer',
      answer: { question_id: 'q1', option_label: 'Yes' }
    });

    expect(result).toEqual({
      ok: false,
      code: 'runtime_identity_dispatch_blocked',
      message: 'Running runtime build runtime-old is stale compared with current-new'
    });
    expect(nativeSubmit).not.toHaveBeenCalled();
    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-native-stale')).toBe(true);
    expect(snapshot.blocked_inputs.get('i-native-stale')?.pending_input?.request_id).toBe('req-native-stale');
    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-native-stale']);
    expect(snapshot.runtime_identity?.status).toBe('stale');
    expect(snapshot.quiescence.blocker_counts.stale_runtime).toBe(0);
    expect((snapshot.quiescence as any).warnings).toContainEqual(expect.objectContaining({ category: 'stale_runtime_warning' }));
    expect(snapshot.operator_actions?.get('i-native-stale')).toEqual([
      expect.objectContaining({
        action: 'submit_input',
        result: 'rejected',
        result_code: 'runtime_identity_dispatch_blocked'
      })
    ]);
  });

  it('quarantines late worker events for blocked issues awaiting operator action', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-quarantine', identifier: 'ABC-QUAR' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-quarantine',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace conflict","conflict_files":[],"resolution_hints":["Resolve and resume."]}'
    );

    harness.orchestrator.onWorkerEvent('i-quarantine', {
      timestamp_ms: Date.now(),
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'late event after blocked state',
      thread_id: 'thread-stale',
      session_id: 'thread-stale-turn-1'
    });

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-quarantine');
    expect(blocked?.awaiting_operator).toBe(true);
    expect(blocked?.quarantined_event_count).toBe(1);
    expect(blocked?.quarantined_events?.[0]?.event).toBe(CANONICAL_EVENT.codex.turnWaiting);
    expect(
      harness.orchestrator
        .getStateSnapshot()
        .recent_runtime_events.some((entry) => entry.event === CANONICAL_EVENT.orchestration.blockedWorkerEventQuarantined)
    ).toBe(true);
  });
});
