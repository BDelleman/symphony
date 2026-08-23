import { describe, expect, it, vi } from 'vitest';

import { OrchestratorCore } from '../../src/orchestrator/core';
import { LocalRunnerBridge } from '../../src/orchestrator/local-runner-bridge';
import type { OrchestratorConfig, OrchestratorPorts } from '../../src/orchestrator/types';
import type { StructuredLogger } from '../../src/observability';
import { CANONICAL_EVENT } from '../../src/observability/events';
import { REASON_CODES } from '../../src/observability/reason-codes';
import type { Issue, TrackerAdapter } from '../../src/tracker/types';
import type { EffectiveConfig } from '../../src/workflow/types';
import type { CodexRunner, CodexRunnerEvent } from '../../src/codex';
import { CodexRunnerError } from '../../src/codex/errors';
import type { WorkspaceManager } from '../../src/workspace';
import type { WorkerTerminationResult } from '../../src/orchestrator/types';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'i-1',
    identifier: 'ABC-1',
    title: 'Issue ABC-1',
    description: null,
    priority: 2,
    state: 'Todo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  };
}

function makeConfig(): EffectiveConfig {
  return {
    tracker: {
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      api_key: 'token',
      project_slug: 'PROJ',
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done'],
      handoff_states: [],
      fresh_dispatch_states: []
    },
    polling: { interval_ms: 30000 },
    workspace: {
      root: '/tmp/symphony',
      root_source: 'workflow',
      provisioner: {
        type: 'none',
        base_ref: 'origin/main',
        branch_template: 'feature/{{ issue.identifier }}',
        teardown_mode: 'remove_worktree',
        allow_dirty_repo: false,
        fallback_to_clone_on_worktree_failure: false
      },
      copy_ignored: {
        enabled: false,
        include_file: '/tmp/symphony/.worktreeinclude',
        from: 'primary_worktree',
        conflict_policy: 'skip',
        require_gitignored: true,
        max_files: 10_000,
        max_total_bytes: 5 * 1024 * 1024 * 1024,
        allow_patterns: [],
        deny_patterns: []
      }
    },
    hooks: { timeout_ms: 1000 },
    agent: {
      max_concurrent_agents: 2,
      max_retry_backoff_ms: 300000,
      max_turns: 1,
      max_concurrent_agents_by_state: {}
    },
    codex: {
      command: 'codex app-server',
      turn_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 300000
    },
    persistence: {
      enabled: true,
      db_path: '/tmp/symphony/runtime.sqlite',
      db_path_source: 'workflow',
      retention_days: 14
    },
    logging: {
      root: '/tmp/symphony/log',
      root_source: 'workflow',
      max_bytes: 10 * 1024 * 1024,
      max_files: 5
    }
  };
}

function makeTerminationResult(overrides: Partial<WorkerTerminationResult> = {}): WorkerTerminationResult {
  return {
    cancellation_supported: true,
    cancellation_requested: true,
    worker_settled: true,
    graceful_exit_observed: true,
    forced_kill_requested: false,
    forced_kill_settled: null,
    cleanup_requested: false,
    cleanup_succeeded: null,
    result: 'succeeded',
    reason_code: 'worker_cancel_graceful_exit',
    detail: 'worker process exited after graceful cancellation',
    ...overrides
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('LocalRunnerBridge integration', () => {
  it('routes transcript-backed task_complete runner results through normal worker exit handling', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi.fn().mockResolvedValueOnce({
      status: 'completed' as const,
      thread_id: 'thread-transcript',
      turn_id: 'turn-transcript',
      session_id: 'thread-transcript-turn-transcript',
      last_event: CANONICAL_EVENT.codex.turnCompleted,
      terminal_source: 'session_transcript' as const,
      last_agent_message: 'done from transcript'
    });
    const issueStateFetcher = vi.fn().mockResolvedValueOnce([makeIssue({ id: 'i-1', identifier: 'ABC-1', state: 'In Progress' })]);
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const exits: Array<{ reason: string; completion_reason?: string; session_id?: string | null }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => logs.push({ event, context: context ?? {} })
    };

    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config: makeConfig(),
      issueStateFetcher,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      logger,
      onWorkerExit: ({ reason, completion_reason, session_id }) => {
        exits.push({ reason, completion_reason, session_id });
      }
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.agentRunner.attemptCompleted,
        context: expect.objectContaining({
          session_id: 'thread-transcript-turn-transcript',
          completion_reason: REASON_CODES.maxTurnsReached
        })
      })
    );
    expect(exits).toEqual([
      { reason: 'normal', completion_reason: REASON_CODES.maxTurnsReached, session_id: 'thread-transcript-turn-transcript' }
    ]);
    expect(finalizeAttempt).toHaveBeenCalledWith('/tmp/symphony/ABC-1');
  });

  it('passes guarded recovery session lineage through worker exit details', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const resumeThreadInterruptAndRunTurn = vi.fn().mockResolvedValueOnce({
      status: 'completed' as const,
      thread_id: 'recovery-thread',
      turn_id: 'recovery-turn',
      session_id: 'recovery-session',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    });
    const exits: Array<{ reason: string; completion_reason?: string; session_id?: string | null }> = [];

    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { resumeThreadInterruptAndRunTurn } as unknown as CodexRunner,
      config: makeConfig(),
      issueStateFetcher: vi.fn(async () => [makeIssue({ id: 'i-1', identifier: 'ABC-1', state: 'In Progress' })]),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerExit: ({ reason, completion_reason, session_id }) => {
        exits.push({ reason, completion_reason, session_id });
      }
    });

    const spawned = await bridge.recoverMissingToolOutput({
      issue: makeIssue(),
      attempt: 1,
      previous_thread_id: 'previous-thread',
      previous_turn_id: 'previous-turn',
      previous_session_id: 'previous-session',
      recovery_prompt: 'Inspect guarded recovery state.'
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected recovery spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(exits).toEqual([
      { reason: 'normal', completion_reason: REASON_CODES.maxTurnsReached, session_id: 'recovery-session' }
    ]);
  });

  it('stops continuation turns when tracker refresh leaves active states', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        session_id: 'thread-1-turn-1',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      })
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-2',
        turn_id: 'turn-2',
        session_id: 'thread-2-turn-2',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      });

    const issueStateFetcher = vi
      .fn()
      .mockResolvedValueOnce([makeIssue({ id: 'i-1', identifier: 'ABC-1', state: 'In Progress' })])
      .mockResolvedValueOnce([makeIssue({ id: 'i-1', identifier: 'ABC-1', state: 'Done' })]);

    const workspaceManager = {
      ensureWorkspace,
      prepareAttempt,
      finalizeAttempt,
      cleanupWorkspace
    } as unknown as WorkspaceManager;

    const codexRunner = {
      startSessionAndRunTurn
    } as unknown as CodexRunner;

    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: {
        ...makeConfig(),
        agent: {
          ...makeConfig().agent,
          max_turns: 5
        }
      },
      issueStateFetcher,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}'
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    const workerHandle = spawned.worker_handle as { promise: Promise<void> };
    await workerHandle.promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(2);
    expect(startSessionAndRunTurn.mock.calls[0][0]).toMatchObject({
      prompt: expect.stringContaining('Issue ABC-1 attempt'),
      maxTurns: 1
    });
    expect(startSessionAndRunTurn.mock.calls[1][0]).toMatchObject({
      prompt: expect.stringContaining('Continue on the same thread'),
      maxTurns: 1
    });
    expect(issueStateFetcher).toHaveBeenCalledTimes(2);
    expect(finalizeAttempt).toHaveBeenCalledWith('/tmp/symphony/ABC-1');
  });

  it('stops continuation turns when tracker refresh reaches a handoff state', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        session_id: 'thread-1-turn-1',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      })
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-2',
        turn_id: 'turn-2',
        session_id: 'thread-2-turn-2',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      });

    const issueStateFetcher = vi.fn().mockResolvedValueOnce([
      makeIssue({ id: 'i-1', identifier: 'ABC-1', state: 'Agent Review' })
    ]);

    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => logs.push({ event, context: context ?? {} })
    };
    const config = makeConfig();
    config.agent.max_turns = 5;
    config.tracker.active_states = ['Todo', 'In Progress', 'Agent Review'];
    config.tracker.handoff_states = ['Agent Review'];

    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config,
      issueStateFetcher,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      logger
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(1);
    expect(issueStateFetcher).toHaveBeenCalledTimes(1);
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    expect(finalizeAttempt).toHaveBeenCalledWith('/tmp/symphony/ABC-1');

    const completed = logs.find((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptCompleted);
    expect(completed?.context).toMatchObject({
      issue_id: 'i-1',
      completion_reason: 'handoff_state_reached',
      refreshed_state: 'Agent Review'
    });
  });

  it('records cancellation as normal completion when tracker confirms a handoff', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const config = makeConfig();
    config.tracker.active_states = ['Todo', 'Agent Review'];
    config.tracker.handoff_states = ['Agent Review'];
    const bridge = new LocalRunnerBridge({
      workspaceManager: {
        ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
        prepareAttempt: vi.fn(async () => {}),
        finalizeAttempt: vi.fn(async () => {}),
        cleanupWorkspace: vi.fn(async () => true)
      } as unknown as WorkspaceManager,
      codexRunner: {} as CodexRunner,
      agentRunner: {
        runtime: 'claude-cli',
        capabilities: {
          native_resume: 'within-attempt',
          missing_tool_output_recovery: false,
          remote_worker: false,
          enforcement_usage: false
        },
        startSessionAndRunTurn: vi.fn(async () => ({
          runtime: 'claude-cli',
          status: 'cancelled',
          session_id: 'claude-session',
          thread_id: 'claude:claude-session',
          turn_id: 'claude-turn',
          last_event: CANONICAL_EVENT.agentRunner.turnCancelled,
          error_code: REASON_CODES.workerCancelRequested,
          cancellation_outcome: 'graceful_exit',
          retryable: false
        }))
      } as any,
      config,
      issueStateFetcher: vi.fn(async () => [makeIssue({ state: 'Agent Review' })]),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      logger: { log: ({ event, context }) => logs.push({ event, context: context ?? {} }) }
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error('expected spawn success');
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptFailed)).toBe(false);
    expect(logs.find((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptCompleted)?.context).toMatchObject({
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });
  });

  it('does not treat same-state fresh-phase cancellation as a successful handoff', async () => {
    const config = makeConfig();
    config.tracker.active_states = ['Agent Review'];
    config.tracker.handoff_states = ['Agent Review'];
    config.tracker.fresh_dispatch_states = ['Agent Review'];
    const exits: Array<{ reason: string; error?: string; retryable?: boolean }> = [];
    const bridge = new LocalRunnerBridge({
      workspaceManager: {
        ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
        prepareAttempt: vi.fn(async () => {}),
        finalizeAttempt: vi.fn(async () => {}),
        cleanupWorkspace: vi.fn(async () => true)
      } as unknown as WorkspaceManager,
      codexRunner: {} as CodexRunner,
      agentRunner: {
        runtime: 'claude-cli',
        capabilities: {
          native_resume: 'within-attempt',
          missing_tool_output_recovery: false,
          remote_worker: false,
          enforcement_usage: false
        },
        startSessionAndRunTurn: vi.fn(async () => ({
          runtime: 'claude-cli',
          status: 'cancelled',
          session_id: 'claude-session',
          thread_id: 'claude:claude-session',
          turn_id: 'claude-turn',
          last_event: CANONICAL_EVENT.agentRunner.turnCancelled,
          error_code: REASON_CODES.workerCancelRequested,
          cancellation_outcome: 'graceful_exit',
          retryable: false
        }))
      } as any,
      config,
      issueStateFetcher: vi.fn(async () => [makeIssue({ state: 'Agent Review' })]),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerExit: ({ reason, error, retryable }) => {
        exits.push({ reason, error, retryable });
      }
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue({ state: 'Agent Review' }), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error('expected spawn success');
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(exits).toEqual([{ reason: 'abnormal', error: REASON_CODES.workerCancelRequested, retryable: false }]);
  });

  it('stops fresh Agent Review runs after routing to the next workflow state', async () => {
    const routeCases = [
      { targetState: 'In Progress', expectedReason: REASON_CODES.freshDispatchStateRouted },
      { targetState: 'Rework', expectedReason: REASON_CODES.freshDispatchStateRouted },
      { targetState: 'Merging', expectedReason: REASON_CODES.freshDispatchStateRouted },
      { targetState: 'Human Review', expectedReason: REASON_CODES.handoffStateReached }
    ];

    for (const routeCase of routeCases) {
      const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
      const prepareAttempt = vi.fn(async () => {});
      const finalizeAttempt = vi.fn(async () => {});
      const cleanupWorkspace = vi.fn(async () => true);
      const startSessionAndRunTurn = vi
        .fn()
        .mockResolvedValueOnce({
          status: 'completed' as const,
          thread_id: 'review-thread',
          turn_id: 'review-turn',
          session_id: 'review-thread-turn',
          last_event: CANONICAL_EVENT.codex.turnCompleted
        })
        .mockResolvedValueOnce({
          status: 'completed' as const,
          thread_id: 'unexpected-continuation-thread',
          turn_id: 'unexpected-continuation-turn',
          session_id: 'unexpected-continuation-session',
          last_event: CANONICAL_EVENT.codex.turnCompleted
        });
      const issueStateFetcher = vi.fn().mockResolvedValueOnce([
        makeIssue({ id: 'i-1', identifier: 'ABC-1', state: routeCase.targetState })
      ]);
      const config = makeConfig();
      config.agent.max_turns = 5;
      config.tracker.active_states = ['Todo', 'In Progress', 'Agent Review', 'Merging', 'Rework'];
      config.tracker.handoff_states = ['Agent Review', 'Human Review'];
      config.tracker.fresh_dispatch_states = ['Agent Review'];
      const exits: Array<{ completion_reason?: string; refreshed_state?: string | null }> = [];

      const bridge = new LocalRunnerBridge({
        workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
        codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
        config,
        issueStateFetcher,
        promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
        onWorkerExit: ({ completion_reason, refreshed_state }) => {
          exits.push({ completion_reason, refreshed_state });
        }
      });

      const spawned = await bridge.spawnWorker({ issue: makeIssue({ state: 'Agent Review' }), attempt: null });
      expect(spawned.ok).toBe(true);
      if (!spawned.ok) {
        throw new Error('expected spawn success');
      }
      await (spawned.worker_handle as { promise: Promise<void> }).promise;

      expect(startSessionAndRunTurn, routeCase.targetState).toHaveBeenCalledTimes(1);
      expect(startSessionAndRunTurn.mock.calls[0][0].prompt, routeCase.targetState).toContain('Issue ABC-1 attempt');
      expect(startSessionAndRunTurn.mock.calls[0][0].prompt, routeCase.targetState).not.toContain('Continue on the same thread');
      expect(issueStateFetcher, routeCase.targetState).toHaveBeenCalledTimes(1);
      expect(cleanupWorkspace, routeCase.targetState).not.toHaveBeenCalled();
      expect(finalizeAttempt, routeCase.targetState).toHaveBeenCalledWith('/tmp/symphony/ABC-1');
      expect(exits, routeCase.targetState).toEqual([
        { completion_reason: routeCase.expectedReason, refreshed_state: routeCase.targetState }
      ]);
    }
  });

  it('blocks a fresh workflow phase that finishes without routing', async () => {
    const startSessionAndRunTurn = vi.fn().mockResolvedValue({
      status: 'completed' as const,
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    });
    const config = makeConfig();
    config.tracker.active_states = ['Agent Review'];
    config.tracker.handoff_states = ['Agent Review'];
    config.tracker.fresh_dispatch_states = ['Agent Review'];
    const exits: Array<{ reason: string; error?: string; retryable?: boolean }> = [];
    const bridge = new LocalRunnerBridge({
      workspaceManager: {
        ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
        prepareAttempt: vi.fn(async () => {}),
        finalizeAttempt: vi.fn(async () => {}),
        cleanupWorkspace: vi.fn(async () => true)
      } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config,
      issueStateFetcher: vi.fn(async () => [makeIssue({ state: 'Agent Review' })]),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerExit: ({ reason, error, retryable }) => {
        exits.push({ reason, error, retryable });
      }
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue({ state: 'Agent Review' }), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error('expected spawn success');
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([
      {
        reason: 'abnormal',
        error: `${REASON_CODES.freshDispatchNoRoute}: Agent Review`,
        retryable: false
      }
    ]);
  });

  it('refreshes issue state on the final turn before stopping at a handoff state', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi.fn().mockResolvedValueOnce({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    });

    const issueStateFetcher = vi.fn().mockResolvedValueOnce([
      makeIssue({ id: 'i-1', identifier: 'ABC-1', state: 'Agent Review' })
    ]);

    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => logs.push({ event, context: context ?? {} })
    };
    const config = makeConfig();
    config.agent.max_turns = 1;
    config.tracker.active_states = ['Todo', 'In Progress', 'Agent Review'];
    config.tracker.handoff_states = ['Agent Review'];

    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config,
      issueStateFetcher,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      logger
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(1);
    expect(issueStateFetcher).toHaveBeenCalledWith(['i-1']);
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    expect(finalizeAttempt).toHaveBeenCalledWith('/tmp/symphony/ABC-1');

    const completed = logs.find((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptCompleted);
    expect(completed?.context).toMatchObject({
      issue_id: 'i-1',
      completion_reason: 'handoff_state_reached',
      refreshed_state: 'Agent Review'
    });
  });

  it('preserves max-turn completion on the final turn for active non-handoff states', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi.fn().mockResolvedValueOnce({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    });

    const issueStateFetcher = vi.fn().mockResolvedValueOnce([
      makeIssue({ id: 'i-1', identifier: 'ABC-1', state: 'In Progress' })
    ]);

    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => logs.push({ event, context: context ?? {} })
    };
    const config = makeConfig();
    config.agent.max_turns = 1;

    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config,
      issueStateFetcher,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      logger
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(1);
    expect(issueStateFetcher).toHaveBeenCalledWith(['i-1']);
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    expect(finalizeAttempt).toHaveBeenCalledWith('/tmp/symphony/ABC-1');

    const completed = logs.find((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptCompleted);
    expect(completed?.context).toMatchObject({
      issue_id: 'i-1',
      completion_reason: 'max_turns_reached',
      refreshed_state: null
    });
  });

  it('preserves same-thread continuation for active states when handoff states are empty', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        session_id: 'thread-1-turn-1',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      })
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-2',
        turn_id: 'turn-2',
        session_id: 'thread-2-turn-2',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      });

    const issueStateFetcher = vi
      .fn()
      .mockResolvedValueOnce([makeIssue({ id: 'i-1', identifier: 'ABC-1', state: 'Agent Review' })])
      .mockResolvedValueOnce([makeIssue({ id: 'i-1', identifier: 'ABC-1', state: 'Done' })]);

    const config = makeConfig();
    config.agent.max_turns = 5;
    config.tracker.active_states = ['Todo', 'In Progress', 'Agent Review'];
    config.tracker.handoff_states = [];

    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config,
      issueStateFetcher,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}'
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(2);
    expect(startSessionAndRunTurn.mock.calls[1][0]).toMatchObject({
      prompt: expect.stringContaining('Continue on the same thread'),
      maxTurns: 1
    });
    expect(cleanupWorkspace).not.toHaveBeenCalled();
  });

  it('returns abnormal when issue state refresh fails after a completed turn', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi.fn().mockResolvedValueOnce({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    });

    const issueStateFetcher = vi.fn(async () => {
      throw new Error('Linear unavailable');
    });
    const exits: Array<{ reason: string; error?: string; completion_reason?: string }> = [];
    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config: { ...makeConfig(), agent: { ...makeConfig().agent, max_turns: 5 } },
      issueStateFetcher,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerExit: ({ reason, error, completion_reason }) => {
        exits.push({ reason, error, completion_reason });
      }
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([
      {
        reason: 'normal',
        error: 'issue_state_refresh_failed: Linear unavailable',
        completion_reason: REASON_CODES.issueStateRefreshFailed
      }
    ]);
    expect(finalizeAttempt).toHaveBeenCalledWith('/tmp/symphony/ABC-1');
  });

  it('stops normally when a completed turn has no refreshed issue', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        session_id: 'thread-1-turn-1',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      })
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-2',
        turn_id: 'turn-2',
        session_id: 'thread-2-turn-2',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      });

    const issueStateFetcher = vi.fn().mockResolvedValueOnce([]);
    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config: { ...makeConfig(), agent: { ...makeConfig().agent, max_turns: 5 } },
      issueStateFetcher,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}'
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(1);
    expect(issueStateFetcher).toHaveBeenCalledWith(['i-1']);
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    expect(finalizeAttempt).toHaveBeenCalledWith('/tmp/symphony/ABC-1');
  });

  it('stops normally when refreshed state is non-active and non-terminal', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        session_id: 'thread-1-turn-1',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      })
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-2',
        turn_id: 'turn-2',
        session_id: 'thread-2-turn-2',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      });

    const issueStateFetcher = vi
      .fn()
      .mockResolvedValueOnce([makeIssue({ id: 'i-1', identifier: 'ABC-1', state: 'Paused' })]);
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => logs.push({ event, context: context ?? {} })
    };
    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config: { ...makeConfig(), agent: { ...makeConfig().agent, max_turns: 5 } },
      issueStateFetcher,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      logger
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(1);
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    const completed = logs.find((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptCompleted);
    expect(completed?.context).toMatchObject({
      completion_reason: 'issue_left_active_states',
      refreshed_state: 'Paused'
    });
  });

  it('prepends resume context to first prompt when provided', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);
    const startSessionAndRunTurn = vi.fn(async () => ({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    }));

    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}'
    });

    const spawned = await bridge.spawnWorker({
      issue: makeIssue(),
      attempt: null,
      resume_context: 'Operator provided input.\nAnswer: Yes'
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Operator provided input.\nAnswer: Yes\n\nIssue ABC-1 attempt')
      })
    );
  });

  it('preserves a legacy wrapper base in mixed mode and emits a mixed-mode reason code', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);
    const startSessionAndRunTurn = vi.fn(async () => ({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    }));
    const events: CodexRunnerEvent[] = [];
    const config = makeConfig();
    config.codex = {
      ...config.codex,
      command: 'FOO=bar BAZ=qux CODEX_HOME="$HOME/.codex" /opt/codex-wrapper --config model="legacy" app-server',
      effective_codex_home: '/tmp/codex-home',
      effective_codex_model: 'typed-model',
      effective_reasoning_effort: 'high',
      effective_extra_flags: ['--config', 'shell_environment_policy.inherit=all'],
      effective_extra_flags_count: 2,
      codex_resolution_mode: 'mixed'
    };

    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerEvent: ({ event }) => events.push(event)
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/opt/codex-wrapper',
        commandArgs: [
          '--config',
          'model=legacy',
          '--config',
          'shell_environment_policy.inherit=all',
          '--config',
          'model="typed-model"',
          '--config',
          'model_reasoning_effort=high',
          'app-server'
        ],
        commandEnv: expect.objectContaining({
          BAZ: 'qux',
          CODEX_HOME: '/tmp/codex-home',
          FOO: 'bar',
          SYMPHONY_ATTEMPT_ID: expect.any(String)
        })
      })
    );
    expect(events.some((event) => event.detail === 'codex_command_legacy_path_used')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.commandMixedTypedOverridesApplied,
        detail: 'codex_command_mixed_typed_overrides_applied'
      })
    );
  });

  it('emits warning code when legacy-only codex command path is used', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);
    const startSessionAndRunTurn = vi.fn(async () => ({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    }));
    const events: CodexRunnerEvent[] = [];
    const config = makeConfig();
    config.codex.codex_resolution_mode = 'legacy';

    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerEvent: ({ event }) => events.push(event)
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'codex app-server',
        commandArgs: undefined,
        commandEnv: expect.objectContaining({ SYMPHONY_ATTEMPT_ID: expect.any(String) })
      })
    );
    expect(events).toEqual([
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.commandLegacyPathUsed,
        detail: 'codex_command_legacy_path_used'
      })
    ]);
  });

  it('runs workspace ensure/prepare/codex/finalize via orchestrator spawn path', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi.fn(async () => ({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    }));

    const workspaceManager = {
      ensureWorkspace,
      prepareAttempt,
      finalizeAttempt,
      cleanupWorkspace
    } as unknown as WorkspaceManager;

    const codexRunner = {
      startSessionAndRunTurn
    } as unknown as CodexRunner;

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => [makeIssue()]),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    let orchestrator!: OrchestratorCore;
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      logger,
      onWorkerExit: async ({ issue_id, reason }) => {
        await orchestrator.onWorkerExit(issue_id, reason);
      }
    });

    const ports: OrchestratorPorts = {
      tracker,
      dispatchPreflight: () => ({ dispatch_allowed: true }),
      spawnWorker: (params) => bridge.spawnWorker(params),
      terminateWorker: async () => makeTerminationResult(),
      scheduleRetryTimer: ({ issue_id }) => ({ issue_id }),
      cancelRetryTimer: () => {}
    };

    const config: OrchestratorConfig = {
      poll_interval_ms: 30000,
      max_concurrent_agents: 2,
      max_concurrent_agents_by_state: {},
      max_retry_backoff_ms: 300000,
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done'],
      stall_timeout_ms: 300000
    };

    orchestrator = new OrchestratorCore({ config, ports });
    await orchestrator.tick('interval');
    await flush();

    expect(ensureWorkspace).toHaveBeenCalledWith('ABC-1');
    expect(ensureWorkspace).toHaveBeenCalledTimes(1);
    expect(prepareAttempt).toHaveBeenCalledWith('/tmp/symphony/ABC-1');
    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(1);
    expect(startSessionAndRunTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Issue ABC-1 attempt'),
        maxTurns: 1
      })
    );
    expect(finalizeAttempt).toHaveBeenCalledWith('/tmp/symphony/ABC-1');

    const retry = orchestrator.getStateSnapshot().retry_attempts.get('i-1');
    expect(retry?.attempt).toBe(1);
    const started = logs.find((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptStarted);
    expect(started?.context.issue_id).toBe('i-1');
    expect(started?.context.issue_identifier).toBe('ABC-1');
    const completed = logs.find((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptCompleted);
    expect(completed?.context.session_id).toBe('thread-1-turn-1');
  });

  it('does not schedule orchestrator continuation when a worker completes at an active handoff state', async () => {
    const issue = makeIssue({ state: 'In Progress' });
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        session_id: 'thread-1-turn-1',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      })
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-2',
        turn_id: 'turn-2',
        session_id: 'thread-2-turn-2',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      });

    const workspaceManager = {
      ensureWorkspace,
      prepareAttempt,
      finalizeAttempt,
      cleanupWorkspace
    } as unknown as WorkspaceManager;
    const codexRunner = { startSessionAndRunTurn } as unknown as CodexRunner;
    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => [issue]),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [makeIssue({ id: issue.id, state: 'Agent Review' })]),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    let orchestrator!: OrchestratorCore;
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const bridgeConfig = makeConfig();
    bridgeConfig.agent.max_turns = 5;
    bridgeConfig.tracker.active_states = ['Todo', 'In Progress', 'Agent Review'];
    bridgeConfig.tracker.handoff_states = ['Agent Review'];
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: bridgeConfig,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      issueStateFetcher: (issueIds) => tracker.fetch_issue_states_by_ids(issueIds),
      logger,
      onWorkerExit: async ({ issue_id, reason, error, completion_reason, refreshed_state }) => {
        await orchestrator.onWorkerExit(issue_id, reason, error, { completion_reason, refreshed_state });
      }
    });

    const ports: OrchestratorPorts = {
      tracker,
      dispatchPreflight: () => ({ dispatch_allowed: true }),
      spawnWorker: (params) => bridge.spawnWorker(params),
      terminateWorker: async () => makeTerminationResult(),
      scheduleRetryTimer: ({ issue_id }) => ({ issue_id }),
      cancelRetryTimer: () => {}
    };

    const config: OrchestratorConfig = {
      poll_interval_ms: 30000,
      max_concurrent_agents: 2,
      max_concurrent_agents_by_state: {},
      max_retry_backoff_ms: 300000,
      active_states: ['Todo', 'In Progress', 'Agent Review'],
      terminal_states: ['Done'],
      stall_timeout_ms: 300000
    };

    orchestrator = new OrchestratorCore({ config, ports, logger });
    await orchestrator.tick('interval');
    await flush();

    const snapshot = orchestrator.getStateSnapshot();
    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(1);
    expect(snapshot.retry_attempts.has('i-1')).toBe(false);
    expect(snapshot.completed.has('i-1')).toBe(true);
    expect(cleanupWorkspace).not.toHaveBeenCalled();

    const completed = logs.find((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptCompleted);
    expect(completed?.context).toMatchObject({
      issue_id: 'i-1',
      completion_reason: 'handoff_state_reached',
      refreshed_state: 'Agent Review'
    });
    const handled = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.workerExitHandled);
    expect(handled?.context).toMatchObject({
      issue_id: 'i-1',
      outcome: 'completed',
      stop_reason_code: 'handoff_state_reached'
    });
  });

  it('uses terminal cleanup instead of max-turn continuation when the final turn refreshes to terminal', async () => {
    const issue = makeIssue({ state: 'In Progress' });
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi.fn().mockResolvedValueOnce({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    });

    const workspaceManager = {
      ensureWorkspace,
      prepareAttempt,
      finalizeAttempt,
      cleanupWorkspace
    } as unknown as WorkspaceManager;
    const codexRunner = { startSessionAndRunTurn } as unknown as CodexRunner;
    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => [issue]),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [makeIssue({ id: issue.id, state: 'Done' })]),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    let orchestrator!: OrchestratorCore;
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const bridgeConfig = makeConfig();
    bridgeConfig.agent.max_turns = 1;
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: bridgeConfig,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      issueStateFetcher: (issueIds) => tracker.fetch_issue_states_by_ids(issueIds),
      logger,
      onWorkerExit: async ({ issue_id, reason, error, completion_reason, refreshed_state }) => {
        await orchestrator.onWorkerExit(issue_id, reason, error, { completion_reason, refreshed_state });
      }
    });

    const ports: OrchestratorPorts = {
      tracker,
      dispatchPreflight: () => ({ dispatch_allowed: true }),
      spawnWorker: (params) => bridge.spawnWorker(params),
      terminateWorker: async ({ issue_id, worker_handle, cleanup_workspace }) => {
        return bridge.terminateWorker({ issue_id, worker_handle, cleanup_workspace });
      },
      scheduleRetryTimer: ({ issue_id }) => ({ issue_id }),
      cancelRetryTimer: () => {}
    };

    const config: OrchestratorConfig = {
      poll_interval_ms: 30000,
      max_concurrent_agents: 2,
      max_concurrent_agents_by_state: {},
      max_retry_backoff_ms: 300000,
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done'],
      stall_timeout_ms: 300000
    };

    orchestrator = new OrchestratorCore({ config, ports, logger });
    await orchestrator.tick('interval');
    await flush();

    const snapshot = orchestrator.getStateSnapshot();
    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(1);
    expect(snapshot.retry_attempts.has('i-1')).toBe(false);
    expect(snapshot.completed.has('i-1')).toBe(true);
    expect(cleanupWorkspace).toHaveBeenCalledWith('ABC-1');

    const completed = logs.find((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptCompleted);
    expect(completed?.context).toMatchObject({
      issue_id: 'i-1',
      completion_reason: 'terminal_state_reached',
      refreshed_state: 'Done'
    });
    const handled = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.workerExitHandled);
    expect(handled?.context).toMatchObject({
      issue_id: 'i-1',
      outcome: 'completed',
      stop_reason_code: 'terminal_state_reached',
      cleanup_workspace: true
    });
  });

  it('invokes workspace cleanup helper when terminateWorker requests cleanup', async () => {
    const issue = makeIssue();
    const cleanupWorkspace = vi.fn(async () => true);
    const workspaceManager = {
      ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
      prepareAttempt: vi.fn(async () => {}),
      finalizeAttempt: vi.fn(async () => {}),
      cleanupWorkspace
    } as unknown as WorkspaceManager;
    const codexRunner = {
      startSessionAndRunTurn: vi.fn(
        (input: { cancellationSignal?: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const cancel = () =>
              reject(new CodexRunnerError('turn_cancelled', `worker_cancelled:${String(input.cancellationSignal?.reason)}:graceful_exit`));
            input.cancellationSignal?.addEventListener('abort', cancel);
            if (input.cancellationSignal?.aborted) {
              cancel();
            }
          })
      )
    } as unknown as CodexRunner;

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => [issue]),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [makeIssue({ id: issue.id, state: 'Done' })]),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}'
    });

    const ports: OrchestratorPorts = {
      tracker,
      dispatchPreflight: () => ({ dispatch_allowed: true }),
      spawnWorker: (params) => bridge.spawnWorker(params),
      terminateWorker: async ({ issue_id, worker_handle, cleanup_workspace }) => {
        return bridge.terminateWorker({ issue_id, worker_handle, cleanup_workspace });
      },
      scheduleRetryTimer: ({ issue_id }) => ({ issue_id }),
      cancelRetryTimer: () => {}
    };

    const config: OrchestratorConfig = {
      poll_interval_ms: 30000,
      max_concurrent_agents: 1,
      max_concurrent_agents_by_state: {},
      max_retry_backoff_ms: 300000,
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done'],
      stall_timeout_ms: 300000
    };

    const orchestrator = new OrchestratorCore({ config, ports });
    await orchestrator.tick('interval');
    await orchestrator.reconcileRunningIssues();

    expect(cleanupWorkspace).toHaveBeenCalledWith('ABC-1');
  });

  it('cancels active worker process without workspace cleanup when terminateWorker cleanup is false', async () => {
    const cleanupWorkspace = vi.fn(async () => true);
    const workspaceManager = {
      ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
      prepareAttempt: vi.fn(async () => {}),
      finalizeAttempt: vi.fn(async () => {}),
      cleanupWorkspace
    } as unknown as WorkspaceManager;
    let observedSignal: AbortSignal | null = null;
    const codexRunner = {
      startSessionAndRunTurn: vi.fn(
        (input: { cancellationSignal?: AbortSignal }) =>
          new Promise((resolve, reject) => {
            observedSignal = input.cancellationSignal ?? null;
            const cancel = () => {
              reject(new CodexRunnerError('turn_cancelled', `worker_cancelled:${String(input.cancellationSignal?.reason)}:graceful_exit`));
            };
            input.cancellationSignal?.addEventListener('abort', cancel);
            if (input.cancellationSignal?.aborted) {
              cancel();
            }
          })
      )
    } as unknown as CodexRunner;

    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      logger: {
        log: ({ event, context }) => logs.push({ event, context: context ?? {} })
      }
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }

    const terminationResult = await bridge.terminateWorker({
      issue_id: 'i-1',
      worker_handle: spawned.worker_handle,
      cleanup_workspace: false,
      reason: 'operator_cancel_turn'
    });

    const signal = observedSignal as AbortSignal | null;
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe('operator_cancel_turn');
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    expect(terminationResult).toMatchObject({
      result: 'succeeded',
      cancellation_supported: true,
      cancellation_requested: true,
      worker_settled: true,
      graceful_exit_observed: true,
      forced_kill_requested: false,
      cleanup_requested: false,
      cleanup_succeeded: null
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.orchestration.workerTerminated,
        context: expect.objectContaining({
          cancel_requested: true,
          graceful_exit_observed: true,
          worker_instance_id: expect.any(String)
        })
      })
    );
    await expect((spawned.worker_handle as { promise: Promise<void> }).promise).resolves.toBeUndefined();
  });

  it('returns unsupported termination outcome when worker handle lacks cancel', async () => {
    const cleanupWorkspace = vi.fn(async () => true);
    const workspaceManager = {
      ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
      prepareAttempt: vi.fn(async () => {}),
      finalizeAttempt: vi.fn(async () => {}),
      cleanupWorkspace
    } as unknown as WorkspaceManager;
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner: { startSessionAndRunTurn: vi.fn() } as unknown as CodexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}'
    });

    const result = await bridge.terminateWorker({
      issue_id: 'i-1',
      worker_handle: {
        issue_id: 'i-1',
        issue_identifier: 'ABC-1',
        worker_instance_id: 'worker-1',
        worker_host: null,
        promise: Promise.resolve()
      },
      cleanup_workspace: false,
      reason: 'operator_cancel_turn'
    });

    expect(result).toMatchObject({
      result: 'unsupported',
      cancellation_supported: false,
      cancellation_requested: false,
      worker_settled: null,
      graceful_exit_observed: null,
      forced_kill_requested: false,
      forced_kill_settled: null,
      cleanup_requested: false,
      cleanup_succeeded: null,
      reason_code: 'worker_cancel_unsupported'
    });
    expect(cleanupWorkspace).not.toHaveBeenCalled();
  });

  it('reports workspace cleanup failure independently from settled cancellation', async () => {
    const cleanupWorkspace = vi.fn(async () => false);
    const workspaceManager = {
      ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
      prepareAttempt: vi.fn(async () => {}),
      finalizeAttempt: vi.fn(async () => {}),
      cleanupWorkspace
    } as unknown as WorkspaceManager;
    const codexRunner = {
      startSessionAndRunTurn: vi.fn(
        (input: { cancellationSignal?: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const cancel = () =>
              reject(new CodexRunnerError('turn_cancelled', `worker_cancelled:${String(input.cancellationSignal?.reason)}:graceful_exit`));
            input.cancellationSignal?.addEventListener('abort', cancel);
            if (input.cancellationSignal?.aborted) {
              cancel();
            }
          })
      )
    } as unknown as CodexRunner;
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}'
    });
    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }

    const result = await bridge.terminateWorker({
      issue_id: 'i-1',
      worker_handle: spawned.worker_handle,
      cleanup_workspace: true,
      reason: 'terminal_state_transition'
    });

    expect(result).toMatchObject({
      result: 'failed',
      cancellation_supported: true,
      cancellation_requested: true,
      worker_settled: true,
      graceful_exit_observed: true,
      cleanup_requested: true,
      cleanup_succeeded: false,
      reason_code: 'workspace_cleanup_failed'
    });
  });

  it('keeps workspace cleanup idempotent across repeated termination calls', async () => {
    const cleanupWorkspace = vi.fn(async () => true);
    const workspaceManager = {
      ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
      prepareAttempt: vi.fn(async () => {}),
      finalizeAttempt: vi.fn(async () => {}),
      cleanupWorkspace
    } as unknown as WorkspaceManager;
    const codexRunner = {
      startSessionAndRunTurn: vi.fn(
        (input: { cancellationSignal?: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const cancel = () => {
              reject(
                new CodexRunnerError('turn_cancelled', `worker_cancelled:${String(input.cancellationSignal?.reason)}:forced_kill_exited`)
              );
            };
            input.cancellationSignal?.addEventListener('abort', cancel);
            if (input.cancellationSignal?.aborted) {
              cancel();
            }
          })
      )
    } as unknown as CodexRunner;

    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      logger: {
        log: ({ event, context }) => logs.push({ event, context: context ?? {} })
      }
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }

    const firstTermination = await bridge.terminateWorker({
      issue_id: 'i-1',
      worker_handle: spawned.worker_handle,
      cleanup_workspace: true,
      reason: 'terminal_state_transition'
    });
    const secondTermination = await bridge.terminateWorker({
      issue_id: 'i-1',
      worker_handle: spawned.worker_handle,
      cleanup_workspace: true,
      reason: 'terminal_state_transition'
    });

    expect(cleanupWorkspace).toHaveBeenCalledTimes(1);
    expect(cleanupWorkspace).toHaveBeenCalledWith('ABC-1');
    expect(firstTermination).toMatchObject({
      result: 'succeeded',
      forced_kill_requested: true,
      forced_kill_settled: true,
      graceful_exit_observed: false,
      cleanup_requested: true,
      cleanup_succeeded: true
    });
    expect(secondTermination).toMatchObject({
      result: 'succeeded',
      cleanup_requested: true,
      cleanup_succeeded: true
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: CANONICAL_EVENT.workspace.teardownStart }),
        expect.objectContaining({
          event: CANONICAL_EVENT.workspace.teardownSuccess,
          context: expect.objectContaining({ cleanup_succeeded: true })
        })
      ])
    );
  });

  it('maps codex startup failure to abnormal worker exit and retry scheduling', async () => {
    const workspaceManager = {
      ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
      prepareAttempt: vi.fn(async () => {}),
      finalizeAttempt: vi.fn(async () => {}),
      cleanupWorkspace: vi.fn(async () => true)
    } as unknown as WorkspaceManager;
    const codexRunner = {
      startSessionAndRunTurn: vi.fn(async () => {
        throw new Error('response timeout');
      })
    } as unknown as CodexRunner;
    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => [makeIssue()]),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    let orchestrator!: OrchestratorCore;
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      logger,
      onWorkerExit: async ({ issue_id, reason }) => {
        await orchestrator.onWorkerExit(issue_id, reason);
      }
    });

    const ports: OrchestratorPorts = {
      tracker,
      dispatchPreflight: () => ({ dispatch_allowed: true }),
      spawnWorker: (params) => bridge.spawnWorker(params),
      terminateWorker: async () => makeTerminationResult(),
      scheduleRetryTimer: ({ issue_id, callback, due_at_ms }) => {
        void callback;
        return { issue_id, due_at_ms };
      },
      cancelRetryTimer: () => {}
    };

    const config: OrchestratorConfig = {
      poll_interval_ms: 30000,
      max_concurrent_agents: 2,
      max_concurrent_agents_by_state: {},
      max_retry_backoff_ms: 300000,
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done'],
      stall_timeout_ms: 300000
    };

    orchestrator = new OrchestratorCore({ config, ports });
    await orchestrator.tick('interval');
    await flush();

    const retry = orchestrator.getStateSnapshot().retry_attempts.get('i-1');
    expect(retry?.attempt).toBe(1);
    expect(retry?.error).toBe('worker exited: abnormal');
    const failed = logs.find((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptFailed);
    expect(failed?.context.issue_id).toBe('i-1');
    expect(failed?.context.issue_identifier).toBe('ABC-1');
    expect(failed?.context.error).toBe('response timeout');
  });

  it('emits typed workspace conflict envelope when workspace preflight reports unresolved tracked artifacts', async () => {
    const workspaceManager = {
      ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
      prepareAttempt: vi.fn(async () => {
        const err = new Error(
          'workspace_preflight_conflict:{"detail":"tracked output/playwright artifacts remain after preflight cleanup","conflict_files":[{"path":"output/playwright/demo.webm","status":"staged"}],"resolution_hints":["Remove tracked entries under output/playwright/ from git index/history."]}'
        ) as Error & { code?: string };
        err.code = 'workspace_unprovisioned_conflict';
        throw err;
      }),
      finalizeAttempt: vi.fn(async () => {}),
      cleanupWorkspace: vi.fn(async () => true)
    } as unknown as WorkspaceManager;
    const codexRunner = {
      startSessionAndRunTurn: vi.fn(async () => {
        throw new Error('should not be reached');
      })
    } as unknown as CodexRunner;
    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => [makeIssue()]),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    let orchestrator!: OrchestratorCore;
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerExit: async ({ issue_id, reason, error }) => {
        await orchestrator.onWorkerExit(issue_id, reason, error);
      }
    });

    const ports: OrchestratorPorts = {
      tracker,
      dispatchPreflight: () => ({ dispatch_allowed: true }),
      spawnWorker: (params) => bridge.spawnWorker(params),
      terminateWorker: async () => makeTerminationResult(),
      scheduleRetryTimer: ({ issue_id, callback, due_at_ms }) => {
        void callback;
        return { issue_id, due_at_ms };
      },
      cancelRetryTimer: () => {}
    };

    const config: OrchestratorConfig = {
      poll_interval_ms: 30000,
      max_concurrent_agents: 2,
      max_concurrent_agents_by_state: {},
      max_retry_backoff_ms: 300000,
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done'],
      stall_timeout_ms: 300000
    };

    orchestrator = new OrchestratorCore({ config, ports });
    await orchestrator.tick('interval');
    await flush();

    const snapshot = orchestrator.getStateSnapshot();
    const blocked = snapshot.blocked_inputs.get('i-1');
    expect(blocked?.stop_reason_code).toBe('operator_action_required_workspace_conflict');
    expect(blocked?.conflict_files).toEqual([{ path: 'output/playwright/demo.webm', status: 'staged' }]);
    expect(blocked?.resolution_hints).toContain('Remove tracked entries under output/playwright/ from git index/history.');
    expect(snapshot.retry_attempts.has('i-1')).toBe(false);
  });

  it('does not retry a sensitive workspace preflight failure', async () => {
    const exits: Array<{ reason: string; error?: string; retryable?: boolean }> = [];
    const workspaceManager = {
      ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
      prepareAttempt: vi.fn(async () => {
        const error = new Error('{"violations":[{"path":".venv/bin/python","category":"symlink_escape"}]}') as Error & {
          code?: string;
        };
        error.code = 'workspace_sensitive_file_detected';
        throw error;
      }),
      finalizeAttempt: vi.fn(async () => {}),
      cleanupWorkspace: vi.fn(async () => true)
    } as unknown as WorkspaceManager;
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner: {} as CodexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerExit: ({ reason, error, retryable }) => {
        exits.push({ reason, error, retryable });
      }
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error('expected spawn success');
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(exits).toEqual([
      {
        reason: 'abnormal',
        error: 'workspace_sensitive_file_detected:{"violations":[{"path":".venv/bin/python","category":"symlink_escape"}]}',
        retryable: false
      }
    ]);
  });

  it('fails fast with codex.startup.failed event when workspace resolves to unsafe root', async () => {
    const workspaceManager = {
      ensureWorkspace: vi.fn(async () => ({
        path: '/tmp/symphony',
        workspace_key: 'ABC-1',
        created_now: true
      })),
      prepareAttempt: vi.fn(async () => {}),
      finalizeAttempt: vi.fn(async () => {}),
      cleanupWorkspace: vi.fn(async () => true)
    } as unknown as WorkspaceManager;

    const startSessionAndRunTurn = vi.fn(async () => ({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    }));
    const codexRunner = {
      startSessionAndRunTurn
    } as unknown as CodexRunner;

    const events: string[] = [];
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: {
        ...makeConfig(),
        workspace: {
          root: '/tmp/symphony',
          root_source: 'workflow',
          provisioner: {
            type: 'none',
            base_ref: 'origin/main',
            branch_template: 'feature/{{ issue.identifier }}',
            teardown_mode: 'remove_worktree',
            allow_dirty_repo: false,
            fallback_to_clone_on_worktree_failure: false
          },
          copy_ignored: {
            enabled: false,
            include_file: '/tmp/symphony/.worktreeinclude',
            from: 'primary_worktree',
            conflict_policy: 'skip',
            require_gitignored: true,
            max_files: 10_000,
            max_total_bytes: 5 * 1024 * 1024 * 1024,
            allow_patterns: [],
            deny_patterns: []
          }
        }
      },
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerEvent: ({ event }) => {
        events.push(event.event);
      }
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    await flush();

    expect(startSessionAndRunTurn).not.toHaveBeenCalled();
    expect(events).toContain(CANONICAL_EVENT.codex.startupFailed);
  });
});
