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

describe('OrchestratorCore persistence', () => {
  it('persists unobserved Claude usage when the process fails before a session exists', async () => {
    const tokenFacts: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendTokenModelFact']>>[0]> = [];
    const completedRuns: Array<Parameters<OrchestratorPersistencePort['completeRun']>[0]> = [];
    const transitions: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendStateTransition']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'pre-init-run',
      appendIssueRun: async () => 'pre-init-issue-run',
      appendAttempt: async () => 'pre-init-attempt',
      appendTokenModelFact: async (params) => {
        tokenFacts.push(params);
        return String(params.token_model_fact_id);
      },
      appendStateTransition: async (params) => {
        transitions.push(params);
        return 'pre-init-transition';
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    const harness = createHarness({ persistence });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-claude-pre-init', identifier: 'ABC-CLAUDE-PRE-INIT' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-claude-pre-init', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.agentRunner.turnFailed,
      agent_runtime: 'claude-cli',
      turn_id: 'pre-init-transient-turn',
      requested_model: 'claude-sonnet-4-6',
      provider_usage: {
        runtime: 'claude-cli',
        model: null,
        effective_models: [],
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        provider_turn_count: null,
        estimated_cost_usd: null,
        source: 'claude_invocation',
        status: 'unobserved',
        confidence: 'missing',
        missing_reason: 'claude_process_exit_2',
        supervised_session_coverage: 'missing'
      }
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(tokenFacts).toEqual([
      expect.objectContaining({
        issue_run_id: 'pre-init-issue-run',
        attempt_id: 'pre-init-attempt',
        thread_id: null,
        turn_id: null,
        runtime_provider: 'claude-cli',
        provider_usage_status: 'unobserved',
        missing_reason: 'claude_process_exit_2'
      })
    ]);
    await harness.orchestrator.onWorkerExit('i-claude-pre-init', 'abnormal');
    expect(completedRuns).toEqual([
      expect.objectContaining({
        run_id: 'pre-init-run',
        thread_id: null,
        turn_id: null
      })
    ]);
    expect(transitions).not.toEqual([]);
    expect(transitions.every((transition) => transition.thread_id == null && transition.turn_id == null)).toBe(true);
  });

  it('waits for fresh Claude lineage persistence before closing the run', async () => {
    const operations: string[] = [];
    const writeFailures: Array<Parameters<NonNullable<OrchestratorPersistencePort['recordHistoryWriteFailure']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'claude-lineage-run',
      appendIssueRun: async () => 'claude-lineage-issue-run',
      appendAttempt: async () => 'claude-lineage-attempt',
      appendThread: async (params) => {
        operations.push(`thread:${params.thread_id}`);
        return String(params.thread_id);
      },
      appendTurn: async (params) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        operations.push(`turn:${params.turn_id}`);
        return String(params.turn_id);
      },
      appendStateTransition: async () => 'transition',
      appendTicketEvidenceReference: async () => 'evidence',
      appendAppServerEvent: async () => 'event',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      recordHistoryWriteFailure: async (params) => {
        writeFailures.push(params);
      },
      completeRun: async () => {
        operations.push('complete');
      }
    };
    const harness = createHarness({ persistence });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-claude-lineage', identifier: 'ABC-CLAUDE-LINEAGE' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-claude-lineage', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.agentRunner.processStarted,
      agent_runtime: 'claude-cli',
      worker_process_pid: 4242,
      turn_id: 'claude-turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-claude-lineage', {
      timestamp_ms: harness.now.value + 2,
      event: CANONICAL_EVENT.agentRunner.turnStarted,
      agent_runtime: 'claude-cli',
      turn_id: 'claude-turn-1',
      requested_model: 'claude-sonnet-4-6'
    });
    harness.orchestrator.onWorkerEvent('i-claude-lineage', {
      timestamp_ms: harness.now.value + 3,
      event: CANONICAL_EVENT.agentRunner.sessionStarted,
      agent_runtime: 'claude-cli',
      session_id: '11111111-1111-4111-8111-111111111111',
      thread_id: 'claude:11111111-1111-4111-8111-111111111111',
      turn_id: 'claude-turn-1',
      requested_model: 'claude-sonnet-4-6',
      effective_model: 'claude-sonnet-4-6'
    });
    harness.orchestrator.onWorkerEvent('i-claude-lineage', {
      timestamp_ms: harness.now.value + 4,
      event: CANONICAL_EVENT.agentRunner.turnCompleted,
      agent_runtime: 'claude-cli',
      session_id: '11111111-1111-4111-8111-111111111111',
      thread_id: 'claude:11111111-1111-4111-8111-111111111111',
      turn_id: 'claude-turn-1'
    });
    await harness.orchestrator.onWorkerExit('i-claude-lineage', 'normal');

    expect(writeFailures).toEqual([]);
    expect(operations).toContain('thread:claude:11111111-1111-4111-8111-111111111111');
    expect(operations).toContain('turn:claude-turn-1');
    expect(operations.at(-1)).toBe('complete');
  });

  it('persists two resumed Claude turns with distinct durable indices in SQLite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-claude-resume-graph-'));
    const store = new SqlitePersistenceStore({ dbPath: path.join(dir, 'runtime.sqlite'), retentionDays: 14 });
    const identity = (params: { issue_id: string; issue_identifier: string }) =>
      buildDurableIdentity({
        projectRoot: dir,
        workflowPath: path.join(dir, 'WORKFLOW.md'),
        workflowHash: { status: 'present', value: 'workflow-hash' },
        repositoryRemote: { status: 'missing', reason: 'repository_remote_unavailable' },
        trackerKind: 'linear',
        trackerScope: 'TEST',
        remoteIssueId: params.issue_id,
        humanIssueIdentifier: params.issue_identifier
      });
    const persistence: OrchestratorPersistencePort = {
      startRun: async (params) => store.startRun({ ...params, identity: identity(params) }),
      appendIssueRun: async (params) => store.appendIssueRun({ ...params, identity: identity(params) }),
      appendAttempt: async (params) => store.appendAttempt(params),
      appendThread: async (params) => store.appendThread(params),
      appendTurn: async (params) => store.appendTurn(params),
      appendPhaseSpan: async (params) => store.appendPhaseSpan(params),
      appendStateTransition: async (params) => store.appendStateTransition(params),
      appendTicketEvidenceReference: async (params) => store.appendTicketEvidenceReference(params),
      appendTokenModelFact: async (params) => store.appendTokenModelFact(params),
      appendProviderUsageStepFact: async (params) => store.appendProviderUsageStepFact(params),
      recordSession: async ({ run_id, session_id }) => store.recordSession(run_id, session_id),
      recordEvent: async (params) => store.recordEvent(params),
      completeRunIncludesTerminalEvidence: true,
      completeRun: async (params) => store.completeRun(params)
    };
    const harness = createHarness({ persistence });
    const issueId = 'i-claude-resume-sqlite';
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const threadId = `claude:${sessionId}`;

    try {
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: issueId, identifier: 'ABC-CLAUDE-SQLITE' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent(issueId, {
        timestamp_ms: harness.now.value + 10,
        event: CANONICAL_EVENT.agentRunner.processStarted,
        agent_runtime: 'claude-cli',
        worker_process_pid: 5001,
        turn_id: 'claude-turn-sqlite-1'
      });
      await new Promise((resolve) => setImmediate(resolve));
      harness.orchestrator.onWorkerEvent(issueId, {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.agentRunner.turnStarted,
        agent_runtime: 'claude-cli',
        worker_process_pid: 5001,
        turn_id: 'claude-turn-sqlite-1',
        requested_model: 'claude-sonnet-4-6'
      });
      await new Promise((resolve) => setImmediate(resolve));
      harness.orchestrator.onWorkerEvent(issueId, {
        timestamp_ms: harness.now.value + 30,
        event: CANONICAL_EVENT.agentRunner.sessionStarted,
        agent_runtime: 'claude-cli',
        worker_process_pid: 5001,
        session_id: sessionId,
        thread_id: threadId,
        turn_id: 'claude-turn-sqlite-1',
        requested_model: 'claude-sonnet-4-6',
        effective_model: 'claude-sonnet-4-6'
      });
      harness.orchestrator.onWorkerEvent(issueId, {
        timestamp_ms: harness.now.value + 40,
        event: CANONICAL_EVENT.agentRunner.turnCompleted,
        agent_runtime: 'claude-cli',
        worker_process_pid: 5001,
        session_id: sessionId,
        thread_id: threadId,
        turn_id: 'claude-turn-sqlite-1',
        provider_usage: {
          runtime: 'claude-cli',
          model: 'claude-sonnet-4-6',
          effective_models: ['claude-sonnet-4-6'],
          input_tokens: 10,
          output_tokens: 2,
          cache_read_tokens: 1,
          cache_creation_tokens: 0,
          provider_turn_count: 1,
          estimated_cost_usd: 0.01,
          source: 'claude_stream_result',
          status: 'final',
          confidence: 'provider_result'
        }
      });
      harness.orchestrator.onWorkerEvent(issueId, {
        timestamp_ms: harness.now.value + 50,
        event: CANONICAL_EVENT.agentRunner.processStarted,
        agent_runtime: 'claude-cli',
        worker_process_pid: 5002,
        session_id: sessionId,
        thread_id: threadId,
        turn_id: 'claude-turn-sqlite-2'
      });
      harness.orchestrator.onWorkerEvent(issueId, {
        timestamp_ms: harness.now.value + 60,
        event: CANONICAL_EVENT.agentRunner.turnStarted,
        agent_runtime: 'claude-cli',
        worker_process_pid: 5002,
        session_id: sessionId,
        thread_id: threadId,
        turn_id: 'claude-turn-sqlite-2',
        requested_model: 'claude-sonnet-4-6'
      });
      harness.orchestrator.onWorkerEvent(issueId, {
        timestamp_ms: harness.now.value + 70,
        event: CANONICAL_EVENT.agentRunner.turnCompleted,
        agent_runtime: 'claude-cli',
        worker_process_pid: 5002,
        session_id: sessionId,
        thread_id: threadId,
        turn_id: 'claude-turn-sqlite-2',
        provider_usage: {
          runtime: 'claude-cli',
          model: 'claude-sonnet-4-6',
          effective_models: ['claude-sonnet-4-6'],
          input_tokens: 20,
          output_tokens: 4,
          cache_read_tokens: 3,
          cache_creation_tokens: 1,
          provider_turn_count: 2,
          estimated_cost_usd: 0.02,
          source: 'claude_stream_result',
          status: 'final',
          confidence: 'provider_result'
        }
      });
      await harness.orchestrator.onWorkerExit(issueId, 'normal');

      const lineage = store.reconstructThreadLineage(threadId);
      expect(lineage?.turns.map((turn) => ({ turn_id: turn.turn_id, turn_index: turn.turn_index }))).toEqual([
        { turn_id: 'claude-turn-sqlite-1', turn_index: 0 },
        { turn_id: 'claude-turn-sqlite-2', turn_index: 1 }
      ]);
      expect(lineage?.turns.every((turn) => turn.status === 'succeeded')).toBe(true);
      expect(lineage?.turns.flatMap((turn) => turn.phase_spans.map((phase) => phase.phase))).toEqual(
        expect.arrayContaining(['planning', 'completed'])
      );
      expect(lineage?.token_model_facts).toEqual(expect.arrayContaining([
        expect.objectContaining({ turn_id: 'claude-turn-sqlite-1', input_tokens: 10, output_tokens: 2 }),
        expect.objectContaining({ turn_id: 'claude-turn-sqlite-2', input_tokens: 20, output_tokens: 4 })
      ]));
      expect(store.historySchemaHealth()).toMatchObject({ status: 'healthy', applied_version: 14 });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists normalized execution graph from real dispatch and worker lifecycle events', async () => {
    const issueRuns: Array<Record<string, unknown>> = [];
    const attempts: Array<Record<string, unknown>> = [];
    const threads: Array<Record<string, unknown>> = [];
    const turns: Array<Record<string, unknown>> = [];
    const phaseSpans: Array<Record<string, unknown>> = [];
    const toolSpans: Array<Record<string, unknown>> = [];
    const transitions: Array<Record<string, unknown>> = [];
    const completedRuns: Array<Parameters<OrchestratorPersistencePort['completeRun']>[0]> = [];
    const terminalOutcomes: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendTicketTerminalOutcome']>>[0]> = [];
    const evidenceReferences: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendTicketEvidenceReference']>>[0]> = [];
    const trackerSnapshots: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendTrackerTicketSnapshot']>>[0]> = [];
    const ticketReferences: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendTicketReference']>>[0]> = [];
    const appServerEvents: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendAppServerEvent']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'legacy-run-1',
      appendIssueRun: async (params) => {
        issueRuns.push(params);
        return 'issue_run_1';
      },
      appendAttempt: async (params) => {
        attempts.push(params);
        return 'attempt_1';
      },
      appendThread: async (params) => {
        threads.push(params);
        return String(params.thread_id);
      },
      appendTurn: async (params) => {
        turns.push(params);
        return String(params.turn_id);
      },
      appendPhaseSpan: async (params) => {
        phaseSpans.push(params);
        return `phase_${phaseSpans.length}`;
      },
      appendToolSpan: async (params) => {
        toolSpans.push(params);
        return `tool_${toolSpans.length}`;
      },
      appendStateTransition: async (params) => {
        transitions.push(params);
        return `transition_${transitions.length}`;
      },
      appendTicketTerminalOutcome: async (params) => {
        terminalOutcomes.push(params);
        return `terminal_${terminalOutcomes.length}`;
      },
      appendTicketEvidenceReference: async (params) => {
        evidenceReferences.push(params);
        return `evidence_${evidenceReferences.length}`;
      },
      appendTrackerTicketSnapshot: async (params) => {
        trackerSnapshots.push(params);
        return `tracker_snapshot_${trackerSnapshots.length}`;
      },
      appendTicketReference: async (params) => {
        ticketReferences.push(params);
        return `ticket_reference_${ticketReferences.length}`;
      },
      appendAppServerEvent: async (params) => {
        appServerEvents.push(params);
        return `app_server_event_${appServerEvents.length}`;
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    const harness = createHarness({ persistence });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({
        id: 'i-lineage',
        identifier: 'ABC-LIN',
        title: 'Lineage issue',
        state: 'In Progress',
        labels: ['ready-for-agent'],
        branch_name: 'feature/ABC-LIN',
        tracker_meta: {
          tracker_kind: 'github',
          repository: 'nielsgl/symphony',
          pr_links: [{ number: 242, url: 'https://github.com/nielsgl/symphony/pull/242', state: 'OPEN', merged: false }]
        }
      })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-lineage', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      agent_runtime: 'codex-app-server',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-lineage', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.phasePlanning,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      detail: 'waiting_for_turn_completion elapsed_s=0'
    });
    harness.orchestrator.onWorkerEvent('i-lineage', {
      timestamp_ms: harness.now.value + 25,
      event: CANONICAL_EVENT.codex.unsupportedServerRequest,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      reason_code: REASON_CODES.unsupportedApprovalServerRequest,
      request_method: 'approval/request',
      request_category: 'approval'
    });
    harness.orchestrator.onWorkerEvent('i-lineage', {
      timestamp_ms: harness.now.value + 26,
      event: CANONICAL_EVENT.codex.protocolWarning,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      protocol_warning: {
        method: 'guardianWarning',
        reason_code: REASON_CODES.codexProtocolGuardianWarning,
        message: 'guardian warning with transcript token=raw-secret',
        severity: 'warn',
        source: 'app_server_protocol'
      }
    });
    harness.orchestrator.onWorkerEvent('i-lineage', {
      timestamp_ms: harness.now.value + 27,
      event: CANONICAL_EVENT.codex.modelRerouted,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      requested_model: 'gpt-requested',
      effective_model: 'gpt-effective',
      model_reroute: {
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective',
        reason_code: REASON_CODES.codexModelRerouted,
        source: 'app_server_protocol'
      }
    });
    harness.orchestrator.onWorkerEvent('i-lineage', {
      timestamp_ms: harness.now.value + 28,
      event: CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      tool_call_id: 'call-dynamic',
      tool_name: 'linear_graphql',
      tool_call_evidence_source: 'app_server_protocol'
    });
    harness.orchestrator.onWorkerEvent('i-lineage', {
      timestamp_ms: harness.now.value + 29,
      event: CANONICAL_EVENT.codex.turnWaiting,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15
      },
      rate_limits: {
        primary: { remaining: 8, limit: 10 }
      }
    });
    harness.orchestrator.onWorkerEvent('i-lineage', {
      timestamp_ms: harness.now.value + 30,
      event: CANONICAL_EVENT.codex.toolCallCompleted,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      detail: 'exec_command'
    });
    harness.orchestrator.onWorkerEvent('i-lineage', {
      timestamp_ms: harness.now.value + 40,
      event: CANONICAL_EVENT.codex.turnCompleted,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      detail: 'done'
    });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.orchestrator.onWorkerExit('i-lineage', 'normal');

    expect(issueRuns).toEqual([
      expect.objectContaining({
        issue_id: 'i-lineage',
        issue_identifier: 'ABC-LIN',
        status: 'running',
        reason_code: 'dispatch_started'
      })
    ]);
    expect(attempts).toEqual([expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_number: 0 })]);
    expect(threads).toEqual([expect.objectContaining({
      attempt_id: 'attempt_1',
      thread_id: 'thread-1',
      session_id: 'thread-1-turn-1',
      agent_runtime: 'codex-app-server',
      worker_instance_id: 'i-lineage-worker-1',
      worker_process_pid: null
    })]);
    expect(turns).toEqual([expect.objectContaining({ thread_id: 'thread-1', turn_id: 'turn-1', turn_index: 0 })]);
    expect(phaseSpans).toEqual(expect.arrayContaining([
      expect.objectContaining({ turn_id: 'turn-1', phase: 'planning', reason_code: 'codex_phase_planning' }),
      expect.objectContaining({ turn_id: 'turn-1', phase: 'validation', reason_code: 'codex_turn_completed' })
    ]));
    expect(toolSpans).toEqual(expect.arrayContaining([expect.objectContaining({ turn_id: 'turn-1', tool_name: 'exec_command', status: 'succeeded' })]));
    expect(transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_id: 'attempt_1', to_status: 'running', reason_code: 'dispatch_started' }),
      expect.objectContaining({ thread_id: 'thread-1', turn_id: 'turn-1', to_status: 'running', reason_code: 'codex_turn_started' }),
      expect.objectContaining({ thread_id: 'thread-1', turn_id: 'turn-1', to_status: 'succeeded', reason_code: 'codex_turn_completed' }),
      expect.objectContaining({ thread_id: 'thread-1', turn_id: 'turn-1', to_status: 'retrying', reason_code: 'normal_completion' })
    ]));
    expect(evidenceReferences).toEqual([
      expect.objectContaining({
        issue_run_id: 'issue_run_1',
        attempt_id: 'attempt_1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        evidence_kind: 'agent_thread',
        uri: 'agent-thread:thread-1',
        metadata: expect.objectContaining({
          session_id: 'thread-1-turn-1',
          agent_runtime: 'codex-app-server',
          worker_instance_id: 'i-lineage-worker-1',
          worker_process_pid: null
        })
      })
    ]);
    expect(trackerSnapshots).toEqual([
      expect.objectContaining({
        issue_run_id: 'issue_run_1',
        attempt_id: 'attempt_1',
        tracker_kind: 'github',
        remote_issue_id: 'i-lineage',
        human_issue_identifier: 'ABC-LIN',
        title: 'Lineage issue',
        tracker_status: 'In Progress',
        labels: ['ready-for-agent'],
        assignee_status: 'unknown',
        project_status: 'unknown',
        team_status: 'unknown'
      })
    ]);
    expect(ticketReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issue_run_id: 'issue_run_1',
        attempt_id: 'attempt_1',
        reference_kind: 'branch',
        availability: 'available',
        uri: 'git-branch:feature/ABC-LIN',
        external_id: 'feature/ABC-LIN'
      }),
      expect.objectContaining({
        issue_run_id: 'issue_run_1',
        attempt_id: 'attempt_1',
        reference_kind: 'pull_request',
        availability: 'available',
        uri: 'https://github.com/nielsgl/symphony/pull/242',
        external_id: '242',
        state: 'OPEN'
      }),
      expect.objectContaining({
        issue_run_id: 'issue_run_1',
        attempt_id: 'attempt_1',
        reference_kind: 'review',
        availability: 'unknown',
        uri: 'https://github.com/nielsgl/symphony/pull/242',
        external_id: '242',
        state: null,
        metadata: { reason: 'review_state_unobserved' }
      }),
      expect.objectContaining({
        issue_run_id: 'issue_run_1',
        attempt_id: 'attempt_1',
        reference_kind: 'merge',
        availability: 'unknown',
        external_id: '242',
        state: 'OPEN'
      })
    ]));
    expect(appServerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issue_run_id: 'issue_run_1',
          attempt_id: 'attempt_1',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          source_event_name: CANONICAL_EVENT.codex.unsupportedServerRequest,
          payload_class: 'protocol_request_response',
          summary_fields: expect.objectContaining({
            protocol_event_category: 'request_response',
            request_method: 'approval/request',
            request_category: 'approval'
          })
        }),
        expect.objectContaining({
          source_event_name: CANONICAL_EVENT.codex.protocolWarning,
          payload_class: 'protocol_lifecycle',
          summary_fields: expect.objectContaining({
            protocol_event_category: 'warning',
            warning_reason_code: REASON_CODES.codexProtocolGuardianWarning
          })
        }),
        expect.objectContaining({
          source_event_name: CANONICAL_EVENT.codex.modelRerouted,
          summary_fields: expect.objectContaining({
            protocol_event_category: 'model_signal',
            requested_model: 'gpt-requested',
            effective_model: 'gpt-effective'
          })
        }),
        expect.objectContaining({
          source_event_name: CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch,
          payload_class: 'tool_payload',
          unavailable_reason_code: 'tool_payload_payload_not_stored',
          summary_fields: expect.objectContaining({
            protocol_event_category: 'dynamic_tool',
            tool_call_id: 'call-dynamic',
            tool_name: 'linear_graphql'
          })
        }),
        expect.objectContaining({
          source_event_name: CANONICAL_EVENT.codex.turnWaiting,
          summary_fields: expect.objectContaining({
            protocol_event_category: 'token_rate_signal',
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
          })
        }),
        expect.objectContaining({
          source_event_name: CANONICAL_EVENT.codex.turnCompleted,
          summary_fields: expect.objectContaining({
            protocol_event_category: 'terminal_event'
          })
        })
      ])
    );
    expect(JSON.stringify(appServerEvents)).not.toContain('raw-secret');
    expect(terminalOutcomes).toEqual([
      expect.objectContaining({
        issue_run_id: 'issue_run_1',
        attempt_id: 'attempt_1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        outcome: 'succeeded',
        reason_code: null
      })
    ]);
    expect(completedRuns).toEqual([
      expect.objectContaining({
        run_id: 'legacy-run-1',
        issue_run_id: 'issue_run_1',
        attempt_id: 'attempt_1',
        terminal_status: 'succeeded',
        terminal_reason_code: null
      })
    ]);
  });

  it('persists Linear tracker scope facts without requiring PR metadata', async () => {
    const trackerSnapshots: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendTrackerTicketSnapshot']>>[0]> = [];
    const ticketReferences: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendTicketReference']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'legacy-run-linear-scope',
      appendIssueRun: async () => 'issue_run_linear',
      appendAttempt: async () => 'attempt_linear',
      appendTrackerTicketSnapshot: async (params) => {
        trackerSnapshots.push(params);
        return `tracker_snapshot_${trackerSnapshots.length}`;
      },
      appendTicketReference: async (params) => {
        ticketReferences.push(params);
        return `ticket_reference_${ticketReferences.length}`;
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({ persistence });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({
        id: 'linear-issue-1',
        identifier: 'NIE-999',
        title: 'Linear scope issue',
        state: 'In Progress',
        labels: ['ready-for-agent'],
        tracker_meta: {
          tracker_kind: 'linear',
          repository: 'unknown',
          pr_links: [],
          assignee: { id: 'user-1', name: 'Niels' },
          project: { id: 'project-1', slug: 'symphony', name: 'Symphony' },
          team: { id: 'team-1', key: 'NIE', name: 'Nielsgl' }
        }
      })
    ]);

    await harness.orchestrator.tick('interval');

    expect(trackerSnapshots).toEqual([
      expect.objectContaining({
        issue_run_id: 'issue_run_linear',
        attempt_id: 'attempt_linear',
        tracker_kind: 'linear',
        remote_issue_id: 'linear-issue-1',
        human_issue_identifier: 'NIE-999',
        assignee_status: 'available',
        assignee_identifier: 'user-1',
        project_status: 'available',
        project_identifier: 'symphony',
        team_status: 'available',
        team_identifier: 'NIE'
      })
    ]);
    expect(ticketReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference_kind: 'pull_request', availability: 'unknown', metadata: { reason: 'tracker_pr_unobserved' } })
    ]));
  });

  it('records terminal run completion write failures as degraded history diagnostics', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const writeFailures: Array<Parameters<NonNullable<OrchestratorPersistencePort['recordHistoryWriteFailure']>>[0]> = [];
    const terminalOutcomes: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendTicketTerminalOutcome']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'legacy-run-terminal-complete-failure',
      appendIssueRun: async () => 'issue-run-terminal-complete-failure',
      appendAttempt: async () => 'attempt-terminal-complete-failure',
      appendThread: async (params) => String(params.thread_id),
      appendTurn: async (params) => String(params.turn_id),
      appendTicketTerminalOutcome: async (params) => {
        terminalOutcomes.push(params);
        return 'terminal-complete-failure-outcome';
      },
      recordHistoryWriteFailure: async (params) => {
        writeFailures.push(params);
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => {
        throw new Error('database locked token=terminal-secret');
      }
    };
    const harness = createHarness({
      logger: {
        log: ({ event, context }) => logs.push({ event, context: context ?? {} })
      },
      persistence
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-terminal-complete-failure', identifier: 'ABC-TERM-COMPLETE-FAIL' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-terminal-complete-failure', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-terminal-complete-failure',
      turn_id: 'turn-terminal-complete-failure',
      session_id: 'session-terminal-complete-failure'
    });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.orchestrator.onWorkerExit('i-terminal-complete-failure', 'normal');

    expect(logs.find((entry) => entry.event === CANONICAL_EVENT.persistence.completeRunFailed)?.context).toMatchObject({
      issue_id: 'i-terminal-complete-failure',
      issue_identifier: 'ABC-TERM-COMPLETE-FAIL',
      session_id: 'session-terminal-complete-failure'
    });
    expect(writeFailures).toEqual([
      expect.objectContaining({
        operation: 'completeRun',
        reason_code: REASON_CODES.normalCompletion,
        detail: 'database locked token=***REDACTED***'
      })
    ]);
    expect(terminalOutcomes).toEqual([
      expect.objectContaining({
        issue_run_id: 'issue-run-terminal-complete-failure',
        outcome: 'succeeded',
        reason_code: null
      })
    ]);
  });

  it('records terminal outcome write failures as degraded history diagnostics', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const writeFailures: Array<Parameters<NonNullable<OrchestratorPersistencePort['recordHistoryWriteFailure']>>[0]> = [];
    const completedRuns: Array<Parameters<OrchestratorPersistencePort['completeRun']>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'legacy-run-terminal-outcome-failure',
      appendIssueRun: async () => 'issue-run-terminal-outcome-failure',
      appendAttempt: async () => 'attempt-terminal-outcome-failure',
      appendThread: async (params) => String(params.thread_id),
      appendTurn: async (params) => String(params.turn_id),
      appendTicketTerminalOutcome: async () => {
        throw new Error('database locked token=outcome-secret');
      },
      recordHistoryWriteFailure: async (params) => {
        writeFailures.push(params);
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    const harness = createHarness({
      logger: {
        log: ({ event, context }) => logs.push({ event, context: context ?? {} })
      },
      persistence
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-terminal-outcome-failure', identifier: 'ABC-TERM-OUTCOME-FAIL' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-terminal-outcome-failure', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-terminal-outcome-failure',
      turn_id: 'turn-terminal-outcome-failure',
      session_id: 'session-terminal-outcome-failure'
    });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.orchestrator.onWorkerExit('i-terminal-outcome-failure', 'normal');

    expect(completedRuns).toEqual([
      expect.objectContaining({
        run_id: 'legacy-run-terminal-outcome-failure',
        terminal_status: 'succeeded',
        terminal_reason_code: null
      })
    ]);
    expect(logs.find((entry) => entry.event === CANONICAL_EVENT.persistence.recordEventFailed)?.context).toMatchObject({
      issue_id: 'i-terminal-outcome-failure',
      issue_identifier: 'ABC-TERM-OUTCOME-FAIL',
      issue_run_id: 'issue-run-terminal-outcome-failure',
      attempt_id: 'attempt-terminal-outcome-failure',
      reason_code: null,
      error: 'database locked token=outcome-secret'
    });
    expect(writeFailures).toEqual([
      expect.objectContaining({
        operation: 'appendTicketTerminalOutcome',
        reason_code: REASON_CODES.normalCompletion,
        detail: 'database locked token=***REDACTED***'
      })
    ]);
  });

  it('records named Project History write failures as degraded diagnostics', async () => {
    const writeFailures: Array<Parameters<NonNullable<OrchestratorPersistencePort['recordHistoryWriteFailure']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'legacy-run-history-failure',
      appendStateTransition: async () => {
        throw new Error('database locked token=transition-secret');
      },
      appendTicketEvidenceReference: async () => {
        throw new Error('database locked token=evidence-secret');
      },
      appendIssueRun: async () => {
        throw new Error('database locked token=pre-spawn-secret');
      },
      appendTicketBlocker: async () => {
        throw new Error('database locked token=blocker-secret');
      },
      appendBlockedInputEvent: async () => {
        throw new Error('database locked token=blocked-input-secret');
      },
      recordHistoryWriteFailure: async (params) => {
        writeFailures.push(params);
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({ persistence });
    const internals = harness.orchestrator as unknown as {
      persistExecutionGraphStateTransition: (
        runningEntry: unknown,
        toStatus: string,
        status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying',
        reasonCode: string,
        reasonDetail: string | null
      ) => Promise<void>;
      persistTicketEvidenceReferenceForThread: (
        runningEntry: unknown,
        workerEvent: { event: string; turn_id?: string | null; session_id?: string | null },
        threadId: string,
        recordedAt: string
      ) => Promise<void>;
      persistExecutionGraphRetryTransition: (
        retryEntry: unknown,
        toStatus: string,
        status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying',
        reasonCode: string,
        reasonDetail: string | null
      ) => Promise<void>;
      persistPreSpawnExecutionGraphAttempt: (params: {
        issue: Issue;
        attempt: number | null;
        graphContext: { issue_run_id?: string | null; previous_attempt_id?: string | null };
        status: 'failed' | 'blocked';
        reasonCode: string;
        reasonDetail: string | null;
      }) => Promise<unknown>;
      persistTicketBlocker: (blockedEntry: unknown) => Promise<void>;
      persistBlockedInputEvent: (blockedEntry: unknown) => Promise<void>;
    };
    const issue = makeIssue({ id: 'i-history-failure', identifier: 'ABC-HISTORY-FAIL' });
    const runningEntry = {
      issue,
      identifier: issue.identifier,
      issue_run_id: 'issue-run-history-failure',
      attempt_id: 'attempt-history-failure',
      thread_id: 'thread-history-failure',
      turn_id: 'turn-history-failure',
      session_id: 'session-history-failure'
    };
    const retryEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      issue_run_id: 'issue-run-history-failure',
      previous_attempt_id: 'attempt-history-failure',
      previous_thread_id: 'thread-history-failure',
      previous_turn_id: 'turn-history-failure'
    };
    const blockedEntry = {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      issue_run_id: 'issue-run-history-failure',
      previous_attempt_id: 'attempt-history-failure',
      previous_thread_id: 'thread-history-failure',
      previous_turn_id: 'turn-history-failure',
      previous_session_id: 'session-history-failure',
      worker_host: null,
      workspace_path: null,
      branch_name: null,
      last_phase: 'blocked_input',
      last_phase_at_ms: harness.now.value,
      last_phase_detail: null,
      blocked_at_ms: harness.now.value,
      stop_reason_code: REASON_CODES.turnInputRequired,
      stop_reason_detail: 'operator input required',
      pending_input: null,
      tool_output_wait: null,
      conflict_files: [],
      budget: null,
      recovery: null,
      required_actions: [],
      progress_signals: null
    };

    await internals.persistExecutionGraphStateTransition(
      runningEntry,
      'blocked',
      'blocked',
      REASON_CODES.turnInputRequired,
      'operator input required'
    );
    await internals.persistTicketEvidenceReferenceForThread(
      runningEntry,
      { event: CANONICAL_EVENT.codex.turnStarted, turn_id: 'turn-history-failure', session_id: 'session-history-failure' },
      'thread-history-failure',
      '2026-05-12T06:00:00.000Z'
    );
    await internals.persistExecutionGraphRetryTransition(
      retryEntry,
      'retrying',
      'retrying',
      REASON_CODES.retryFetchFailed,
      'retry fetch failed'
    );
    await internals.persistPreSpawnExecutionGraphAttempt({
      issue,
      attempt: 0,
      graphContext: {},
      status: 'failed',
      reasonCode: REASON_CODES.spawnFailed,
      reasonDetail: 'spawn failed'
    });
    await internals.persistTicketBlocker(blockedEntry);
    await internals.persistBlockedInputEvent(blockedEntry);

    expect(writeFailures).toEqual([
      expect.objectContaining({
        operation: 'appendStateTransition.executionGraph',
        reason_code: REASON_CODES.turnInputRequired,
        detail: 'database locked token=***REDACTED***'
      }),
      expect.objectContaining({
        operation: 'appendTicketEvidenceReference',
        reason_code: 'codex_turn_started',
        detail: 'database locked token=***REDACTED***'
      }),
      expect.objectContaining({
        operation: 'appendStateTransition.retry',
        reason_code: REASON_CODES.retryFetchFailed,
        detail: 'database locked token=***REDACTED***'
      }),
      expect.objectContaining({
        operation: 'persistPreSpawnExecutionGraphAttempt',
        reason_code: REASON_CODES.spawnFailed,
        detail: 'database locked token=***REDACTED***'
      }),
      expect.objectContaining({
        operation: 'appendTicketBlocker',
        reason_code: REASON_CODES.turnInputRequired,
        detail: 'database locked token=***REDACTED***'
      }),
      expect.objectContaining({
        operation: 'appendBlockedInputEvent',
        reason_code: REASON_CODES.turnInputRequired,
        detail: 'database locked token=***REDACTED***'
      })
    ]);
  });

  it('persists duplicate-timestamp codex.turn.waiting heartbeats without generic record-failed warnings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-wait-heartbeats-'));
    const store = new SqlitePersistenceStore({
      dbPath: path.join(dir, 'runtime.sqlite'),
      retentionDays: 14,
      nowMs: () => Date.parse('2026-05-08T12:00:00.000Z')
    });
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const identity = (params: { issue_id: string; issue_identifier: string }) =>
      buildDurableIdentity({
        projectRoot: dir,
        workflowPath: path.join(dir, 'WORKFLOW.md'),
        workflowHash: { status: 'present', value: 'workflow-hash' },
        repositoryRemote: { status: 'missing', reason: 'repository_remote_unavailable' },
        trackerKind: 'linear',
        trackerScope: 'TEST',
        remoteIssueId: params.issue_id,
        humanIssueIdentifier: params.issue_identifier
      });
    const persistence: OrchestratorPersistencePort = {
      startRun: async (params) => store.startRun({ ...params, identity: identity(params) }),
      appendIssueRun: async (params) => store.appendIssueRun({ ...params, identity: identity(params) }),
      appendAttempt: async (params) => store.appendAttempt(params),
      appendThread: async (params) => store.appendThread(params),
      appendTurn: async (params) => store.appendTurn(params),
      appendPhaseSpan: async (params) => store.appendPhaseSpan(params),
      appendToolSpan: async (params) => store.appendToolSpan(params),
      appendStateTransition: async (params) => store.appendStateTransition(params),
      recordSession: async ({ run_id, session_id }) => store.recordSession(run_id, session_id),
      recordEvent: async (params) => store.recordEvent(params),
      completeRun: async (params) => store.completeRun(params)
    };
    const harness = createHarness({
      logger: {
        log: ({ event, context }) => logs.push({ event, context: context ?? {} })
      },
      persistence
    });

    try {
      harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-wait-graph', identifier: 'ABC-WAIT-GRAPH' })]);
      await harness.orchestrator.tick('interval');
      harness.orchestrator.onWorkerEvent('i-wait-graph', {
        timestamp_ms: harness.now.value + 10,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-wait-graph',
        turn_id: 'turn-wait-graph',
        session_id: 'session-wait-graph'
      });
      harness.orchestrator.onWorkerEvent('i-wait-graph', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting heartbeat 1',
        thread_id: 'thread-wait-graph',
        turn_id: 'turn-wait-graph',
        session_id: 'session-wait-graph'
      });
      harness.orchestrator.onWorkerEvent('i-wait-graph', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting heartbeat 2',
        thread_id: 'thread-wait-graph',
        turn_id: 'turn-wait-graph',
        session_id: 'session-wait-graph'
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(logs.filter((entry) => entry.event === CANONICAL_EVENT.persistence.recordEventFailed)).toHaveLength(0);
      const lineage = store.reconstructThreadLineage('thread-wait-graph');
      expect(lineage?.turns[0]?.phase_spans).toEqual(expect.arrayContaining([
        expect.objectContaining({
          phase: 'planning',
          reason_code: 'codex_turn_waiting',
          reason_detail: 'waiting heartbeat 1'
        })
      ]));
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs typed execution graph persistence failure context without leaking secrets', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const writeFailures: Array<Parameters<NonNullable<OrchestratorPersistencePort['recordHistoryWriteFailure']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'legacy-run-failure-context',
      appendIssueRun: async () => 'issue-run-failure-context',
      appendAttempt: async () => 'attempt-failure-context',
      appendThread: async () => 'thread-failure-context',
      appendTurn: async () => 'turn-failure-context',
      appendPhaseSpan: async () => {
        throw new Error('database locked token=secret-value');
      },
      recordHistoryWriteFailure: async (params) => {
        writeFailures.push(params);
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({
      logger: {
        log: ({ event, context }) => logs.push({ event, context: context ?? {} })
      },
      persistence
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-failure-context', identifier: 'ABC-FAIL-CONTEXT' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-failure-context', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-failure-context',
      turn_id: 'turn-failure-context',
      session_id: 'session-failure-context'
    });
    harness.orchestrator.onWorkerEvent('i-failure-context', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat',
      thread_id: 'thread-failure-context',
      turn_id: 'turn-failure-context',
      session_id: 'session-failure-context'
    });
    await new Promise((resolve) => setImmediate(resolve));

    const persistenceFailure = logs.find((entry) => entry.event === CANONICAL_EVENT.persistence.recordEventFailed);
    expect(persistenceFailure?.context).toEqual(
      expect.objectContaining({
        issue_id: 'i-failure-context',
        issue_identifier: 'ABC-FAIL-CONTEXT',
        event: CANONICAL_EVENT.codex.turnWaiting,
        persistence_operation: 'appendPhaseSpan',
        failure_kind: 'write_failed',
        error_name: 'Error',
        error_message: 'database locked token=***REDACTED***',
        event_thread_id: 'thread-failure-context',
        event_turn_id: 'turn-failure-context',
        active_thread_id: 'thread-failure-context',
        active_turn_id: 'turn-failure-context'
      })
    );
    expect(writeFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'appendPhaseSpan',
        reason_code: 'codex_turn_waiting',
        detail: 'database locked token=***REDACTED***'
      })
    ]));
  });

  it('does not mark a turn persisted when the durable turn write fails', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const writeFailures: Array<Parameters<NonNullable<OrchestratorPersistencePort['recordHistoryWriteFailure']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'legacy-run-turn-failure',
      appendIssueRun: async () => 'issue-run-turn-failure',
      appendAttempt: async () => 'attempt-turn-failure',
      appendThread: async () => 'thread-turn-failure',
      appendTurn: async () => {
        throw new Error('database locked before turn flush');
      },
      recordHistoryWriteFailure: async (params) => {
        writeFailures.push(params);
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({
      logger: {
        log: ({ event, context }) => logs.push({ event, context: context ?? {} })
      },
      persistence
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-turn-failure', identifier: 'ABC-TURN-FAIL' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-turn-failure', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-turn-failure',
      turn_id: 'turn-turn-failure',
      session_id: 'session-turn-failure'
    });
    await new Promise((resolve) => setImmediate(resolve));

    const running = harness.orchestrator.getStateSnapshot().running.get('i-turn-failure');
    expect(running?.persisted_turn_ids).toEqual([]);
    expect(running?.pending_persisted_turn_ids).toEqual([]);
    expect(writeFailures).toEqual([
      expect.objectContaining({
        operation: 'appendTurn',
        reason_code: 'codex_turn_started',
        detail: 'database locked before turn flush'
      })
    ]);
  });

  it('persists retry timer redispatch attempts under the original issue run', async () => {
    const issueRuns: Array<Record<string, unknown>> = [];
    const attempts: Array<Record<string, unknown>> = [];
    const threads: Array<Record<string, unknown>> = [];
    const transitions: Array<Record<string, unknown>> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => `legacy-run-${attempts.length + 1}`,
      appendIssueRun: async (params) => {
        issueRuns.push(params);
        return `issue_run_${issueRuns.length}`;
      },
      appendAttempt: async (params) => {
        attempts.push(params);
        return `attempt_${attempts.length}`;
      },
      appendThread: async (params) => {
        threads.push(params);
        return String(params.thread_id);
      },
      appendTurn: async (params) => String(params.turn_id),
      appendStateTransition: async (params) => {
        transitions.push(params);
        return `transition_${transitions.length}`;
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({
      persistence,
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-new',
        checklist_checkpoint: 'chk-new',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({ id: 'i-retry-lineage', identifier: 'ABC-RETRY', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-retry-lineage', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-0',
      turn_id: 'turn-0'
    });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.orchestrator.onWorkerExit('i-retry-lineage', 'normal');

    const internals = harness.orchestrator as unknown as {
      state: {
        redispatch_progress: Map<
          string,
          Array<{ at_ms: number; commit_sha: string | null; checklist_checkpoint: string | null; state_marker: string | null; pr_open: boolean }>
        >;
      };
    };
    internals.state.redispatch_progress = new Map([
      [
        'i-retry-lineage',
        [{ at_ms: harness.now.value - 1, commit_sha: 'sha-old', checklist_checkpoint: 'chk-old', state_marker: null, pr_open: false }]
      ]
    ]);
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-retry-lineage')?.callback();
    harness.orchestrator.onWorkerEvent('i-retry-lineage', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-1',
      turn_id: 'turn-1'
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(issueRuns).toHaveLength(1);
    expect(attempts).toEqual([
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_number: 0 }),
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_number: 1 })
    ]);
    expect(threads).toEqual([
      expect.objectContaining({ attempt_id: 'attempt_1', thread_id: 'thread-0' }),
      expect.objectContaining({ attempt_id: 'attempt_2', thread_id: 'thread-1' })
    ]);
    expect(transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_id: 'attempt_1', reason_code: 'normal_completion' }),
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_id: 'attempt_2', reason_code: 'dispatch_started' })
    ]));
    expect(harness.spawned.filter((entry) => entry.issue_id === 'i-retry-lineage').map((entry) => entry.attempt)).toEqual([null, 1]);
  });

  it('persists redispatch gate blocks on the retry lineage issue run', async () => {
    const issueRuns: Array<Record<string, unknown>> = [];
    const attempts: Array<Record<string, unknown>> = [];
    const transitions: Array<Record<string, unknown>> = [];
    const blockers: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendTicketBlocker']>>[0]> = [];
    const blockedInputEvents: Array<Parameters<NonNullable<OrchestratorPersistencePort['appendBlockedInputEvent']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'legacy-run-1',
      appendIssueRun: async (params) => {
        issueRuns.push(params);
        return `issue_run_${issueRuns.length}`;
      },
      appendAttempt: async (params) => {
        attempts.push(params);
        return `attempt_${attempts.length}`;
      },
      appendThread: async (params) => String(params.thread_id),
      appendTurn: async (params) => String(params.turn_id),
      appendStateTransition: async (params) => {
        transitions.push(params);
        return `transition_${transitions.length}`;
      },
      appendTicketBlocker: async (params) => {
        blockers.push(params);
        return `blocker_${blockers.length}`;
      },
      appendBlockedInputEvent: async (params) => {
        blockedInputEvents.push(params);
        return `blocked_input_event_${blockedInputEvents.length}`;
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({
      configOverrides: { respawn_max_attempts_without_progress: 1 },
      persistence,
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({ id: 'i-retry-blocked', identifier: 'ABC-BLOCK', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-retry-blocked', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-0',
      turn_id: 'turn-0'
    });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.orchestrator.onWorkerExit('i-retry-blocked', 'normal');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-retry-blocked')?.callback();

    expect(issueRuns).toHaveLength(1);
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-retry-blocked')).toBe(false);
    expect(harness.orchestrator.getStateSnapshot().circuit_breakers.get('i-retry-blocked')).toMatchObject({
      breaker_active: true,
      breaker_hit_count: 1
    });
    expect(transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issue_run_id: 'issue_run_1',
        attempt_id: 'attempt_1',
        thread_id: null,
        turn_id: null,
        to_status: 'blocked',
        reason_code: 'operator_action_required_no_progress_redispatch_blocked'
      })
    ]));
    expect(blockers).toEqual([]);
    expect(blockedInputEvents).toEqual([]);
    expect(harness.spawned.filter((entry) => entry.issue_id === 'i-retry-blocked')).toHaveLength(1);
  });

  it('persists spawn failure retries under one issue run when the retry timer succeeds', async () => {
    const issueRuns: Array<Record<string, unknown>> = [];
    const attempts: Array<Record<string, unknown>> = [];
    const threads: Array<Record<string, unknown>> = [];
    const transitions: Array<Record<string, unknown>> = [];
    let spawnCount = 0;
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => `legacy-run-${spawnCount}`,
      appendIssueRun: async (params) => {
        issueRuns.push(params);
        return `issue_run_${issueRuns.length}`;
      },
      appendAttempt: async (params) => {
        attempts.push(params);
        return `attempt_${attempts.length}`;
      },
      appendThread: async (params) => {
        threads.push(params);
        return String(params.thread_id);
      },
      appendTurn: async (params) => String(params.turn_id),
      appendStateTransition: async (params) => {
        transitions.push(params);
        return `transition_${transitions.length}`;
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({
      persistence,
      spawnWorker: async ({ issue, attempt, worker_host, resume_context }) => {
        spawnCount += 1;
        harness.spawned.push({ issue_id: issue.id, attempt, worker_host, resume_context });
        if (spawnCount === 1) {
          return { ok: false, error: 'agent binary missing' };
        }
        return {
          ok: true,
          worker_handle: { issue_id: issue.id },
          monitor_handle: { issue_id: issue.id },
          worker_host
        };
      },
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-new',
        checklist_checkpoint: 'chk-new',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({ id: 'i-spawn-retry-lineage', identifier: 'ABC-SPAWN', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-spawn-retry-lineage');
    expect(retryEntry?.issue_run_id).toBe('issue_run_1');
    expect(retryEntry?.previous_attempt_id).toBe('attempt_1');
    expect(retryEntry?.stop_reason_code).toBe('spawn_failed');

    const internals = harness.orchestrator as unknown as {
      state: {
        redispatch_progress: Map<
          string,
          Array<{ at_ms: number; commit_sha: string | null; checklist_checkpoint: string | null; state_marker: string | null; pr_open: boolean }>
        >;
      };
    };
    internals.state.redispatch_progress = new Map([
      [
        'i-spawn-retry-lineage',
        [{ at_ms: harness.now.value - 1, commit_sha: 'sha-old', checklist_checkpoint: 'chk-old', state_marker: null, pr_open: false }]
      ]
    ]);
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-spawn-retry-lineage')?.callback();
    harness.orchestrator.onWorkerEvent('i-spawn-retry-lineage', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-after-spawn-retry',
      turn_id: 'turn-after-spawn-retry'
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(issueRuns).toHaveLength(1);
    expect(attempts).toEqual([
      expect.objectContaining({
        issue_run_id: 'issue_run_1',
        attempt_number: 0,
        status: 'failed',
        reason_code: 'spawn_failed',
        reason_detail: 'agent binary missing'
      }),
      expect.objectContaining({
        issue_run_id: 'issue_run_1',
        attempt_number: 1,
        status: 'running',
        reason_code: 'attempt_started'
      })
    ]);
    expect(threads).toEqual([expect.objectContaining({ attempt_id: 'attempt_2', thread_id: 'thread-after-spawn-retry' })]);
    expect(transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_id: 'attempt_1', to_status: 'failed', reason_code: 'spawn_failed' }),
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_id: 'attempt_1', to_status: 'retrying', reason_code: 'spawn_failed' }),
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_id: 'attempt_2', to_status: 'running', reason_code: 'dispatch_started' })
    ]));
    expect(harness.spawned.filter((entry) => entry.issue_id === 'i-spawn-retry-lineage').map((entry) => entry.attempt)).toEqual([null, 1]);
  });

  it('persists worker-host capacity retries with graph lineage before a worker is spawned', async () => {
    const issueRuns: Array<Record<string, unknown>> = [];
    const attempts: Array<Record<string, unknown>> = [];
    const transitions: Array<Record<string, unknown>> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => `legacy-run-${attempts.length + 1}`,
      appendIssueRun: async (params) => {
        issueRuns.push(params);
        return `issue_run_${issueRuns.length}`;
      },
      appendAttempt: async (params) => {
        attempts.push(params);
        return `attempt_${attempts.length}`;
      },
      appendThread: async (params) => String(params.thread_id),
      appendTurn: async (params) => String(params.turn_id),
      appendStateTransition: async (params) => {
        transitions.push(params);
        return `transition_${transitions.length}`;
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({
      persistence,
      configOverrides: {
        max_concurrent_agents: 2,
        worker_hosts: ['build-1'],
        max_concurrent_agents_per_host: 1
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-capacity-lineage-1', identifier: 'ABC-CAP-1' }),
      makeIssue({ id: 'i-capacity-lineage-2', identifier: 'ABC-CAP-2' })
    ]);

    await harness.orchestrator.tick('interval');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-capacity-lineage-2');
    expect(retryEntry?.issue_run_id).toBe('issue_run_2');
    expect(retryEntry?.previous_attempt_id).toBe('attempt_2');
    expect(retryEntry?.stop_reason_code).toBe('slots_exhausted');
    expect(issueRuns).toHaveLength(2);
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_number: 0, status: 'running' }),
      expect.objectContaining({
        issue_run_id: 'issue_run_2',
        attempt_number: 0,
        status: 'blocked',
        reason_code: 'slots_exhausted',
        reason_detail: 'no available worker host slots'
      })
    ]));
    expect(transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_run_id: 'issue_run_2', attempt_id: 'attempt_2', to_status: 'blocked', reason_code: 'slots_exhausted' }),
      expect.objectContaining({ issue_run_id: 'issue_run_2', attempt_id: 'attempt_2', to_status: 'retrying', reason_code: 'slots_exhausted' })
    ]));
    expect(harness.spawned).toEqual([{ issue_id: 'i-capacity-lineage-1', attempt: null, worker_host: 'build-1', resume_context: null }]);
  });
});
