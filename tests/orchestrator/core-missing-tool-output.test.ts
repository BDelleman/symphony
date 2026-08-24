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

describe('OrchestratorCore missing tool output', () => {
  it('blocks a dynamic tool call that never records matching tool output by call id', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-missing-tool', identifier: 'ABC-MISS-TOOL' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-missing-tool', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-missing',
      turn_id: 'turn-1',
      session_id: 'session-missing'
    });
    harness.orchestrator.onWorkerEvent('i-missing-tool', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'dynamic_tool',
      thread_id: 'thread-missing',
      turn_id: 'turn-1',
      session_id: 'session-missing',
      tool_name: 'dynamic_tool',
      tool_call_id: 'call_dynamic_1'
    });
    harness.orchestrator.onWorkerEvent('i-missing-tool', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for dynamic tool output',
      thread_id: 'thread-missing',
      turn_id: 'turn-1',
      session_id: 'session-missing'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-missing-tool');
    expect(blocked).toMatchObject({
      stop_reason_code: REASON_CODES.missingToolOutput,
      requires_manual_resume: true,
      previous_thread_id: 'thread-missing',
      previous_session_id: 'session-missing',
      tool_output_wait: {
        tool_name: 'dynamic_tool',
        call_id: 'call_dynamic_1',
        thread_id: 'thread-missing',
        turn_id: 'turn-1',
        session_id: 'session-missing',
        last_agent_message: 'waiting for dynamic tool output'
      }
    });
    expect(blocked?.tool_output_wait?.elapsed_wait_ms).toBeGreaterThanOrEqual(1_990);
    expect(blocked?.required_actions).toEqual(['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run']);
    expect(harness.orchestrator.getStateSnapshot().running.has('i-missing-tool')).toBe(false);
    expect(harness.terminated).toEqual([
      { issue_id: 'i-missing-tool', cleanup_workspace: false, reason: REASON_CODES.missingToolOutput }
    ]);
  });

  it('defers missing-tool-output recovery while other tool activity shows the worker advancing', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-live-subagent', identifier: 'ABC-LIVE-SUB' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-live-subagent', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-live',
      turn_id: 'turn-1',
      session_id: 'session-live'
    });
    harness.orchestrator.onWorkerEvent('i-live-subagent', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'claude_tool_started',
      thread_id: 'thread-live',
      turn_id: 'turn-1',
      session_id: 'session-live',
      tool_name: 'Agent',
      tool_call_id: 'call_agent_1'
    });

    // The Agent call stays outstanding past the threshold, but the subagent keeps
    // streaming its own tool events: the worker is demonstrably advancing.
    for (let step = 1; step <= 4; step += 1) {
      harness.now.value += 600;
      harness.orchestrator.onWorkerEvent('i-live-subagent', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.toolCallStarted,
        detail: 'claude_tool_started',
        thread_id: 'thread-live',
        turn_id: 'turn-1',
        session_id: 'session-live',
        tool_name: 'Edit',
        tool_call_id: `call_edit_${step}`
      });
      harness.orchestrator.onWorkerEvent('i-live-subagent', {
        timestamp_ms: harness.now.value + 5,
        event: CANONICAL_EVENT.codex.toolCallCompleted,
        detail: 'claude_tool_completed',
        thread_id: 'thread-live',
        turn_id: 'turn-1',
        session_id: 'session-live',
        tool_name: 'Edit',
        tool_call_id: `call_edit_${step}`
      });
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(harness.orchestrator.getStateSnapshot().running.has('i-live-subagent')).toBe(true);
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-live-subagent')).toBe(false);
    expect(harness.terminated).toEqual([]);
    expect(
      harness.orchestrator
        .getStateSnapshot()
        .recent_runtime_events.some(
          (event) => event.event === CANONICAL_EVENT.orchestration.missingToolOutputRecoveryDeferred
        )
    ).toBe(true);

    // Once every signal goes quiet for a full threshold window, the watchdog proceeds.
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-live-subagent');
    expect(blocked).toMatchObject({
      stop_reason_code: REASON_CODES.missingToolOutput,
      tool_output_wait: {
        tool_name: 'Agent',
        call_id: 'call_agent_1'
      }
    });
    expect(harness.orchestrator.getStateSnapshot().running.has('i-live-subagent')).toBe(false);
  });

  it('blocks a linear_graphql MCP-style tool call that never records matching tool output by call id', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-linear-tool', identifier: 'ABC-LINEAR-TOOL' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-linear-tool', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-linear',
      turn_id: 'turn-linear',
      session_id: 'session-linear'
    });
    harness.orchestrator.onWorkerEvent('i-linear-tool', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      thread_id: 'thread-linear',
      turn_id: 'turn-linear',
      session_id: 'session-linear',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_pfKTUH5GFubLHpXfln7UScnU'
    });
    harness.orchestrator.onWorkerEvent('i-linear-tool', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for linear_graphql output',
      thread_id: 'thread-linear',
      turn_id: 'turn-linear',
      session_id: 'session-linear'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-linear-tool');
    expect(blocked?.stop_reason_code).toBe(REASON_CODES.missingToolOutput);
    expect(blocked?.tool_output_wait).toMatchObject({
      tool_name: 'linear_graphql',
      call_id: 'call_pfKTUH5GFubLHpXfln7UScnU',
      thread_id: 'thread-linear',
      turn_id: 'turn-linear',
      session_id: 'session-linear'
    });
  });

  it('blocks a transcript-derived linear_graphql function_call without matching output', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-linear', identifier: 'ABC-TRANSCRIPT-LINEAR' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-linear', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-transcript',
        turn_id: 'turn-transcript',
        session_id: 'session-transcript'
      });
      writeSessionTranscript(codexHome, 'session-transcript.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-transcript',
          thread_id: 'thread-transcript',
          turn_id: 'turn-transcript',
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_transcript_linear'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-linear', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting_for_turn_completion elapsed_s=5',
        thread_id: 'thread-transcript',
        turn_id: 'turn-transcript',
        session_id: 'session-transcript'
      });
      harness.now.value += 500;
      await harness.orchestrator.tick('interval');
      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-linear')?.tool_call_ledger?.call_transcript_linear).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_transcript_linear',
        thread_id: 'thread-transcript',
        turn_id: 'turn-transcript',
        session_id: 'session-transcript',
        completion_status: 'pending',
        evidence_sources: ['session_transcript'],
        start_evidence_source: 'session_transcript',
        completion_evidence_source: null
      });
      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-linear')?.transcript_tool_call_diagnostics).toContainEqual(
        expect.objectContaining({
          kind: 'function_call',
          call_id: 'call_transcript_linear',
          lineage: 'active_owned',
          reason: 'matches active runtime lineage'
        })
      );

      harness.now.value += 1_500;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-linear');
      expect(blocked?.stop_reason_code).toBe(REASON_CODES.missingToolOutput);
      expect(blocked?.tool_output_wait).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_transcript_linear',
        thread_id: 'thread-transcript',
        turn_id: 'turn-transcript',
        session_id: 'session-transcript',
        evidence_source: 'session_transcript',
        last_agent_message: 'waiting_for_turn_completion elapsed_s=5'
      });
      expect(blocked?.tool_output_wait?.elapsed_wait_ms).toBeGreaterThanOrEqual(1_990);
    });
  });

  it('classifies transcript missing-tool output by outstanding call age even when planning heartbeats reset generic progress', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-live-regression', identifier: 'NIE-87-LIVE' })]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-live-regression', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-live',
        turn_id: 'turn-live',
        session_id: 'session-live'
      });
      writeSessionTranscript(codexHome, 'session-live.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-live',
          thread_id: 'thread-live',
          turn_id: 'turn-live',
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_live_linear'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-live-regression', {
        timestamp_ms: harness.now.value + 1_500,
        event: CANONICAL_EVENT.codex.phasePlanning,
        detail: 'waiting_for_turn_completion elapsed_s=1',
        thread_id: 'thread-live',
        turn_id: 'turn-live',
        session_id: 'session-live'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-live-regression')?.tool_output_wait).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_live_linear',
        evidence_source: 'session_transcript'
      });
    });
  });

  it('starts guarded same-thread recovery for missing tool output and quarantines interrupted worker events', async () => {
    const recoveries: Array<Parameters<NonNullable<OrchestratorPorts['recoverMissingToolOutput']>>[0]> = [];
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
      recoverMissingToolOutput: async (params) => {
        recoveries.push(params);
        return {
          ok: true,
          worker_handle: { recovery: true },
          monitor_handle: { recovery: true },
          worker_host: params.worker_host
        };
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover-tool', identifier: 'ABC-RECOVER' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-recover-tool', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-recover',
      turn_id: 'turn-old',
      session_id: 'session-old',
      codex_app_server_pid: 111
    });
    harness.orchestrator.onWorkerEvent('i-recover-tool', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_recover',
      thread_id: 'thread-recover',
      turn_id: 'turn-old',
      session_id: 'session-old',
      codex_app_server_pid: 111
    });
    harness.orchestrator.onWorkerEvent('i-recover-tool', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for linear_graphql output',
      thread_id: 'thread-recover',
      turn_id: 'turn-old',
      session_id: 'session-old',
      codex_app_server_pid: 111
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.terminated).toEqual([
      { issue_id: 'i-recover-tool', cleanup_workspace: false, reason: REASON_CODES.missingToolOutputRecoveryInterrupted }
    ]);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).toMatchObject({
      previous_thread_id: 'thread-recover',
      previous_turn_id: 'turn-old',
      previous_session_id: 'session-old'
    });
    expect(recoveries[0].recovery_prompt).toContain('Treat the last tool action outcome as indeterminate');
    expect(recoveries[0].recovery_prompt).toContain('Before retrying anything, inspect current local and external state');
    expect(recoveries[0].recovery_prompt).toContain('If the action already took effect, do not repeat it');
    expect(recoveries[0].recovery_prompt).toContain('If the action did not take effect, retry it once');
    expect(recoveries[0].recovery_prompt).toContain('cannot be verified safely');

    harness.orchestrator.onWorkerEvent('i-recover-tool', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'late old heartbeat',
      thread_id: 'thread-recover',
      turn_id: 'turn-old',
      session_id: 'session-old'
    });
    const afterLateOldEvent = harness.orchestrator.getStateSnapshot().running.get('i-recover-tool');
    expect(afterLateOldEvent?.last_event).toBe(CANONICAL_EVENT.orchestration.missingToolOutputRecoveryStarted);
    expect(afterLateOldEvent?.last_message).not.toBe('late old heartbeat');
    expect(afterLateOldEvent?.turn_id).toBe('turn-old');
    expect(afterLateOldEvent?.session_id).toBe('session-old');
    expect(afterLateOldEvent?.outstanding_tool_calls).toEqual({});
    expect(afterLateOldEvent?.quarantined_event_count).toBe(1);
    expect(afterLateOldEvent?.quarantined_events?.[0]).toMatchObject({
      reason: 'lineage_mismatch',
      event: CANONICAL_EVENT.codex.turnWaiting,
      thread_id: 'thread-recover',
      turn_id: 'turn-old',
      session_id: 'session-old',
      codex_app_server_pid: null
    });

    harness.orchestrator.onWorkerEvent('i-recover-tool', {
      timestamp_ms: harness.now.value + 200,
      event: CANONICAL_EVENT.codex.turnStarted,
      detail: 'recovery turn started',
      thread_id: 'thread-recover',
      turn_id: 'turn-recovery',
      session_id: 'session-recovery',
      codex_app_server_pid: 222
    });

    const running = harness.orchestrator.getStateSnapshot().running.get('i-recover-tool');
    expect(running?.recovery).toMatchObject({
      attempt_count: 1,
      mode: 'same_thread_guarded_continuation',
      last_result: 'started',
      previous_thread_id: 'thread-recover',
      previous_turn_id: 'turn-old',
      last_tool_name: 'linear_graphql',
      last_call_id: 'call_recover',
      interrupt_cancel_result: {
        status: 'succeeded',
        reason_code: 'worker_cancel_graceful_exit',
        detail: 'worker process exited after graceful cancellation',
        termination_result: expect.objectContaining({
          result: 'succeeded',
          cancellation_supported: true,
          worker_settled: true
        })
      }
    });
    expect(running?.quarantined_event_count).toBe(1);
    expect(running?.quarantined_events?.[0]?.reason).toBe('lineage_mismatch');
    expect(running?.turn_id).toBe('turn-recovery');
    expect(running?.codex_app_server_pid).toBe('222');
  });

  it('uses a guarded tool-agnostic recovery prompt for non-Linear tool stalls', async () => {
    const recoveries: Array<Parameters<NonNullable<OrchestratorPorts['recoverMissingToolOutput']>>[0]> = [];
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
      recoverMissingToolOutput: async (params) => {
        recoveries.push(params);
        return {
          ok: true,
          worker_handle: { recovery: true },
          monitor_handle: { recovery: true },
          worker_host: params.worker_host
        };
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover-generic', identifier: 'ABC-GENERIC' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-recover-generic', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-generic',
      turn_id: 'turn-generic-old',
      session_id: 'session-generic-old'
    });
    harness.orchestrator.onWorkerEvent('i-recover-generic', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'publish_artifact',
      tool_name: 'publish_artifact',
      tool_call_id: 'call_publish_artifact',
      thread_id: 'thread-generic',
      turn_id: 'turn-generic-old',
      session_id: 'session-generic-old'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].recovery_prompt).toContain('Treat the last tool action outcome as indeterminate');
    expect(recoveries[0].recovery_prompt).toContain('inspect current local and external state');
    expect(recoveries[0].recovery_prompt).toContain('If the action already took effect, do not repeat it');
    expect(recoveries[0].recovery_prompt).toContain('If the action did not take effect, retry it once');
    expect(recoveries[0].recovery_prompt).toContain('retrying could duplicate an external side effect');
    expect(recoveries[0].recovery_prompt).toContain('- last tool: publish_artifact');
    expect(recoveries[0].recovery_prompt).not.toContain('Linear');
    expect(recoveries[0].recovery_prompt).not.toContain('linear_graphql');
  });

  it('treats an intentional replacement recovery turn as the active-owned transcript lineage', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
        recoverMissingToolOutput: async (params) => ({
          ok: true,
          worker_handle: { recovery: true },
          monitor_handle: { recovery: true },
          worker_host: params.worker_host
        })
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover-owned-transcript', identifier: 'ABC-RECOVER-OWNED' })]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-recover-owned-transcript', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-replacement',
        turn_id: 'turn-original',
        session_id: 'session-original'
      });
      harness.orchestrator.onWorkerEvent('i-recover-owned-transcript', {
        timestamp_ms: harness.now.value + 10,
        event: CANONICAL_EVENT.codex.toolCallStarted,
        tool_name: 'linear_graphql',
        tool_call_id: 'call_original_missing',
        thread_id: 'thread-replacement',
        turn_id: 'turn-original',
        session_id: 'session-original'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));
      harness.orchestrator.onWorkerEvent('i-recover-owned-transcript', {
        timestamp_ms: harness.now.value + 100,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-replacement',
        turn_id: 'turn-replacement',
        session_id: 'session-replacement',
        codex_app_server_pid: 222
      });
      writeSessionTranscript(codexHome, 'session-replacement.jsonl', [
        {
          timestamp: new Date(harness.now.value + 150).toISOString(),
          thread_id: 'thread-replacement',
          turn_id: 'turn-replacement',
          session_id: 'session-replacement',
          codex_app_server_pid: 222,
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_replacement_owned'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-recover-owned-transcript', {
        timestamp_ms: harness.now.value + 200,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting after replacement turn transcript',
        thread_id: 'thread-replacement',
        turn_id: 'turn-replacement',
        session_id: 'session-replacement',
        codex_app_server_pid: 222
      });
      await harness.orchestrator.tick('interval');

      const running = harness.orchestrator.getStateSnapshot().running.get('i-recover-owned-transcript');
      expect(running?.turn_id).toBe('turn-replacement');
      expect(running?.session_id).toBe('session-replacement');
      expect(running?.tool_call_ledger?.call_replacement_owned).toMatchObject({
        completion_status: 'pending',
        thread_id: 'thread-replacement',
        turn_id: 'turn-replacement',
        session_id: 'session-replacement',
        start_evidence_source: 'session_transcript'
      });
      expect(running?.transcript_tool_call_diagnostics).toContainEqual(
        expect.objectContaining({
          call_id: 'call_replacement_owned',
          lineage: 'active_owned',
          active_turn_id: 'turn-replacement',
          active_session_id: 'session-replacement',
          active_codex_app_server_pid: '222'
        })
      );
    });
  });

  it('records recovery success metadata before scheduling same-thread continuation', async () => {
    const completedRuns: Array<Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-recover-success',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
      persistence,
      recoverMissingToolOutput: async (params) => ({
        ok: true,
        worker_handle: { recovery: true },
        monitor_handle: { recovery: true },
        worker_host: params.worker_host
      })
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover-succeeds', identifier: 'ABC-RECOVER-SUCCESS' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-recover-succeeds', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-recover-success',
      turn_id: 'turn-old-success',
      session_id: 'session-old-success'
    });
    harness.orchestrator.onWorkerEvent('i-recover-succeeds', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      tool_name: 'linear_graphql',
      tool_call_id: 'call_recover_success',
      thread_id: 'thread-recover-success',
      turn_id: 'turn-old-success',
      session_id: 'session-old-success'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    harness.orchestrator.onWorkerEvent('i-recover-succeeds', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-recover-success',
      turn_id: 'turn-replacement-success',
      session_id: 'session-replacement-success'
    });

    await harness.orchestrator.onWorkerExit('i-recover-succeeds', 'normal', undefined, {
      completion_reason: REASON_CODES.maxTurnsReached
    });

    expect(harness.orchestrator.getStateSnapshot().retry_attempts.get('i-recover-succeeds')).toMatchObject({
      stop_reason_code: REASON_CODES.normalCompletion,
      recovery: {
        last_result: 'succeeded',
        last_result_reason_code: REASON_CODES.maxTurnsReached,
        previous_thread_id: 'thread-recover-success',
        previous_turn_id: 'turn-old-success',
        previous_session_id: 'session-old-success',
        replacement_thread_id: 'thread-recover-success',
        replacement_turn_id: 'turn-replacement-success',
        replacement_session_id: 'session-replacement-success',
        last_tool_name: 'linear_graphql',
        last_call_id: 'call_recover_success'
      }
    });
    expect(completedRuns).toEqual([
      expect.objectContaining({
        run_id: 'run-recover-success',
        terminal_status: 'cancelled',
        error_code: REASON_CODES.missingToolOutputRecoveryInterrupted,
        missing_tool_output_recovery: expect.objectContaining({
          status: 'in_progress',
          interrupt_cancel_result: expect.objectContaining({
            status: 'succeeded',
            termination_result: expect.objectContaining({
              result: 'succeeded',
              reason_code: 'worker_cancel_graceful_exit',
              worker_settled: true,
              graceful_exit_observed: true
            })
          }),
          final_outcome: expect.objectContaining({ result: 'started' })
        })
      }),
      expect.objectContaining({
        run_id: 'run-recover-success',
        terminal_status: 'succeeded',
        thread_id: 'thread-recover-success',
        turn_id: 'turn-replacement-success',
        session_id: 'session-replacement-success',
        missing_tool_output_recovery: expect.objectContaining({
          status: 'succeeded',
          original_tool_name: 'linear_graphql',
          original_call_id: 'call_recover_success',
          interrupt_cancel_result: expect.objectContaining({
            status: 'succeeded',
            termination_result: expect.objectContaining({
              result: 'succeeded',
              reason_code: 'worker_cancel_graceful_exit',
              worker_settled: true,
              graceful_exit_observed: true
            })
          }),
          replacement_turn: expect.objectContaining({
            thread_id: 'thread-recover-success',
            turn_id: 'turn-replacement-success',
            session_id: 'session-replacement-success'
          }),
          final_outcome: expect.objectContaining({
            result: 'succeeded',
            reason_code: REASON_CODES.maxTurnsReached
          })
        })
      })
    ]);
  });

  it('preserves replacement lineage when a guarded recovery turn fails after starting', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
      recoverMissingToolOutput: async (params) => ({
        ok: true,
        worker_handle: { recovery: true },
        monitor_handle: { recovery: true },
        worker_host: params.worker_host
      })
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover-fails-after-start', identifier: 'ABC-RECOVER-FAILS' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-recover-fails-after-start', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-recover-fails',
      turn_id: 'turn-old-fails',
      session_id: 'session-old-fails'
    });
    harness.orchestrator.onWorkerEvent('i-recover-fails-after-start', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      tool_name: 'linear_graphql',
      tool_call_id: 'call_recover_fails',
      thread_id: 'thread-recover-fails',
      turn_id: 'turn-old-fails',
      session_id: 'session-old-fails'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    harness.orchestrator.onWorkerEvent('i-recover-fails-after-start', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-recover-fails',
      turn_id: 'turn-replacement-fails',
      session_id: 'session-replacement-fails'
    });

    await harness.orchestrator.onWorkerExit('i-recover-fails-after-start', 'abnormal', 'replacement failed');

    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-recover-fails-after-start')).toMatchObject({
      stop_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
      recovery: {
        last_result: 'failed',
        last_result_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
        previous_thread_id: 'thread-recover-fails',
        previous_turn_id: 'turn-old-fails',
        previous_session_id: 'session-old-fails',
        replacement_thread_id: 'thread-recover-fails',
        replacement_turn_id: 'turn-replacement-fails',
        replacement_session_id: 'session-replacement-fails',
        last_tool_name: 'linear_graphql',
        last_call_id: 'call_recover_fails'
      }
    });
  });

  it('blocks missing tool output without a previous turn id instead of spawning unrelated recovery', async () => {
    const recover = vi.fn<NonNullable<OrchestratorPorts['recoverMissingToolOutput']>>();
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
      recoverMissingToolOutput: recover
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover-no-turn', identifier: 'ABC-NO-TURN' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-recover-no-turn', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_no_turn'
    });
    harness.orchestrator.onWorkerEvent('i-recover-no-turn', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for linear_graphql output'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    expect(recover).not.toHaveBeenCalled();
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-recover-no-turn')).toMatchObject({
      stop_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
      recovery: {
        last_result: 'failed',
        last_result_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
        interrupt_cancel_result: {
          status: 'not_started',
          reason_code: null,
          detail: null
        }
      }
    });
  });

  it('blocks with recovery exhausted when the automatic recovery limit is reached', async () => {
    const recover = vi.fn<NonNullable<OrchestratorPorts['recoverMissingToolOutput']>>();
    const harness = createHarness({
      configOverrides: {
        running_wait_stall_threshold_ms: 1_000,
        stall_timeout_ms: 60_000,
        missing_tool_output_max_recoveries_per_run: 0
      },
      recoverMissingToolOutput: recover
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover-exhausted', identifier: 'ABC-EXHAUST' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-recover-exhausted', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-exhaust',
      turn_id: 'turn-exhaust',
      session_id: 'session-exhaust'
    });
    harness.orchestrator.onWorkerEvent('i-recover-exhausted', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_exhaust',
      thread_id: 'thread-exhaust',
      turn_id: 'turn-exhaust',
      session_id: 'session-exhaust'
    });
    harness.orchestrator.onWorkerEvent('i-recover-exhausted', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for linear_graphql output',
      thread_id: 'thread-exhaust',
      turn_id: 'turn-exhaust',
      session_id: 'session-exhaust'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    expect(recover).not.toHaveBeenCalled();
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-recover-exhausted')).toMatchObject({
      stop_reason_code: REASON_CODES.missingToolOutputRecoveryExhausted,
      recovery: {
        last_result: 'blocked',
        last_result_reason_code: REASON_CODES.missingToolOutputRecoveryExhausted
      }
    });
  });

  it('blocks a real Codex rollout transcript function_call without matching output', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const workspacePath = path.join(codexHome, 'workspaces', 'NIE-79');
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
        spawnWorker: async ({ issue, worker_host }) => {
          return {
            ok: true,
            worker_handle: { issue_id: issue.id },
            monitor_handle: { issue_id: issue.id },
            worker_host,
            workspace_path: workspacePath
          };
        }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-rollout', identifier: 'ABC-TRANSCRIPT-ROLLOUT' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-rollout', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-rollout',
        turn_id: 'turn-rollout',
        session_id: 'session-rollout'
      });
      writeSessionTranscript(codexHome, 'rollout-2026-05-07T13-40-00-000Z-abc123.jsonl', [
        {
          timestamp: new Date(harness.now.value + 5).toISOString(),
          type: 'turn_context',
          payload: {
            cwd: workspacePath
          }
        },
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-rollout',
          thread_id: 'thread-rollout',
          turn_id: 'turn-rollout',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_rollout_linear'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-rollout', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting_for_turn_completion elapsed_s=5',
        thread_id: 'thread-rollout',
        turn_id: 'turn-rollout',
        session_id: 'session-rollout'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-rollout')?.tool_output_wait).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_rollout_linear',
        thread_id: 'thread-rollout',
        turn_id: 'turn-rollout',
        session_id: 'session-rollout',
        evidence_source: 'session_transcript'
      });
    });
  });

  it('bounds and caches historical transcript discovery while preserving known active transcript evidence', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const workspacePath = path.join(codexHome, 'workspaces', 'NIE-177');
      const historicalDir = path.join(codexHome, 'sessions', '2026', '05', '01');
      fs.mkdirSync(historicalDir, { recursive: true });
      const largePayload = 'x'.repeat(128 * 1024);
      for (let index = 0; index < 20; index += 1) {
        fs.writeFileSync(
          path.join(historicalDir, `rollout-2026-05-01T00-00-${String(index).padStart(2, '0')}-historical.jsonl`),
          `${JSON.stringify({
            timestamp: new Date(Date.now()).toISOString(),
            type: 'event_msg',
            payload: { type: 'noise', padding: largePayload }
          })}\n`,
          'utf8'
        );
      }

      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 10_000, stall_timeout_ms: 60_000 },
        spawnWorker: async ({ issue, worker_host }) => {
          return {
            ok: true,
            worker_handle: { issue_id: issue.id },
            monitor_handle: { issue_id: issue.id },
            worker_host,
            workspace_path: workspacePath
          };
        }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-bounded', identifier: 'ABC-TRANSCRIPT-BOUNDED' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-bounded', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-bounded',
        turn_id: 'turn-bounded',
        session_id: 'session-bounded'
      });
      writeSessionTranscript(codexHome, 'rollout-thread-bounded.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-bounded',
          thread_id: 'thread-bounded',
          turn_id: 'turn-bounded',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_bounded_linear'
          }
        },
        {
          timestamp: new Date(harness.now.value + 20).toISOString(),
          session_id: 'session-bounded',
          thread_id: 'thread-bounded',
          turn_id: 'turn-bounded',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_bounded_linear',
            output: '{}'
          }
        }
      ]);

      const readdirSpy = vi.spyOn(fs, 'readdirSync');
      harness.orchestrator.onWorkerEvent('i-transcript-bounded', {
        timestamp_ms: harness.now.value + 30,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting with many historical transcripts present',
        thread_id: 'thread-bounded',
        turn_id: 'turn-bounded',
        session_id: 'session-bounded'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      const afterFirstScanReads = readdirSpy.mock.calls.length;
      const runningAfterFirstScan = harness.orchestrator.getStateSnapshot().running.get('i-transcript-bounded');
      expect(runningAfterFirstScan?.tool_call_ledger?.call_bounded_linear).toMatchObject({
        call_id: 'call_bounded_linear',
        completion_status: 'completed',
        evidence_sources: ['session_transcript']
      });
      expect(runningAfterFirstScan?.codex_session_transcript_scan_budget).toMatchObject({
        exhausted: true
      });
      expect(runningAfterFirstScan?.codex_session_transcript_scan_budget?.reason_codes).toContain('transcript_probe_byte_budget_exhausted');
      expect(
        (runningAfterFirstScan as { codex_session_transcript_candidate_cache?: unknown } | undefined)
          ?.codex_session_transcript_candidate_cache
      ).toBeUndefined();

      const snapshotAfterFirstScan = harness.orchestrator.getStateSnapshot();
      const snapshotBudget = snapshotAfterFirstScan.running.get('i-transcript-bounded')
        ?.codex_session_transcript_scan_budget;
      const service = new SnapshotService({ nowMs: () => harness.now.value });
      const projectedState = service.projectState(snapshotAfterFirstScan);
      const projectedIssue = service.projectIssue(snapshotAfterFirstScan, 'ABC-TRANSCRIPT-BOUNDED');
      const projectedDiagnostics = service.projectIssueRuntimeDiagnostics(
        snapshotAfterFirstScan,
        'ABC-TRANSCRIPT-BOUNDED'
      );

      expect(projectedState.running[0]?.codex_session_transcript_scan_budget).toMatchObject({
        exhausted: true,
        reason_codes: expect.arrayContaining(['transcript_probe_byte_budget_exhausted']),
        limits: expect.objectContaining({ max_discovery_files: 20 })
      });
      expect(projectedIssue.running?.codex_session_transcript_scan_budget).toEqual(
        projectedState.running[0]?.codex_session_transcript_scan_budget
      );
      expect(projectedDiagnostics.codex_session_transcript_scan_budget).toEqual(
        projectedState.running[0]?.codex_session_transcript_scan_budget
      );
      expect(JSON.stringify(snapshotAfterFirstScan)).not.toContain(`${path.sep}sessions${path.sep}`);
      expect(JSON.stringify(projectedState)).not.toContain(`${path.sep}sessions${path.sep}`);

      snapshotBudget?.reason_codes.push('mutated_snapshot_reason');
      if (snapshotBudget) {
        snapshotBudget.limits.max_scan_bytes = 1;
      }
      const resnapshotBudget = harness.orchestrator
        .getStateSnapshot()
        .running.get('i-transcript-bounded')?.codex_session_transcript_scan_budget;
      expect(resnapshotBudget?.reason_codes).not.toContain('mutated_snapshot_reason');
      expect(resnapshotBudget?.limits.max_scan_bytes).toBe(262_144);

      harness.now.value += 1_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(readdirSpy.mock.calls.length).toBe(afterFirstScanReads);
      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-bounded')?.tool_call_ledger?.call_bounded_linear).toMatchObject({
        completion_status: 'completed',
        evidence_sources: ['session_transcript']
      });
      readdirSpy.mockRestore();
    });
  });

  it('prioritizes the likely active rollout transcript before historical file-count exhaustion', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const workspacePath = path.join(codexHome, 'workspaces', 'NIE-177-active');
      const activeSessionDir = path.join(codexHome, 'sessions', '2026', '05', '07');
      fs.mkdirSync(activeSessionDir, { recursive: true });
      const largePayload = 'x'.repeat(128 * 1024);
      for (let index = 0; index < 80; index += 1) {
        fs.writeFileSync(
          path.join(activeSessionDir, `rollout-2026-05-07T00-00-${String(index).padStart(3, '0')}-historical.jsonl`),
          `${JSON.stringify({
            timestamp: new Date(Date.now()).toISOString(),
            type: 'event_msg',
            payload: { type: 'noise', workspace: '/tmp/unrelated-workspace', padding: largePayload }
          })}\n`,
          'utf8'
        );
      }

      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 10_000, stall_timeout_ms: 60_000 },
        spawnWorker: async ({ issue, worker_host }) => {
          return {
            ok: true,
            worker_handle: { issue_id: issue.id },
            monitor_handle: { issue_id: issue.id },
            worker_host,
            workspace_path: workspacePath
          };
        }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-active-priority', identifier: 'ABC-TRANSCRIPT-ACTIVE-PRIORITY' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-active-priority', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-active-priority',
        turn_id: 'turn-active-priority',
        session_id: 'session-active-priority'
      });
      writeSessionTranscript(codexHome, 'rollout-2026-05-07T13-45-00-000Z-def456.jsonl', [
        {
          timestamp: new Date(harness.now.value + 5).toISOString(),
          type: 'turn_context',
          payload: {
            cwd: workspacePath
          }
        },
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          type: 'response_item',
          thread_id: 'thread-active-priority',
          turn_id: 'turn-active-priority',
          session_id: 'session-active-priority',
          payload: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_active_priority'
          }
        },
        {
          timestamp: new Date(harness.now.value + 20).toISOString(),
          type: 'response_item',
          thread_id: 'thread-active-priority',
          turn_id: 'turn-active-priority',
          session_id: 'session-active-priority',
          payload: {
            type: 'function_call_output',
            call_id: 'call_active_priority',
            output: '{}'
          }
        }
      ]);

      const readdirSpy = vi.spyOn(fs, 'readdirSync');
      harness.orchestrator.onWorkerEvent('i-transcript-active-priority', {
        timestamp_ms: harness.now.value + 30,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting with same-directory historical transcripts present',
        thread_id: 'thread-active-priority',
        turn_id: 'turn-active-priority',
        session_id: 'session-active-priority'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      const afterFirstScanReads = readdirSpy.mock.calls.length;
      const runningAfterFirstScan = harness.orchestrator.getStateSnapshot().running.get('i-transcript-active-priority');
      expect(runningAfterFirstScan?.tool_call_ledger?.call_active_priority).toMatchObject({
        call_id: 'call_active_priority',
        completion_status: 'completed',
        evidence_sources: ['session_transcript']
      });
      expect(runningAfterFirstScan?.codex_session_transcript_scan_budget?.candidate_count).toBeGreaterThan(0);
      expect(runningAfterFirstScan?.codex_session_transcript_scan_budget?.files_considered).toBe(
        runningAfterFirstScan?.codex_session_transcript_scan_budget?.limits.max_discovery_files
      );
      expect(runningAfterFirstScan?.codex_session_transcript_scan_budget?.reason_codes).toContain(
        'transcript_discovery_file_count_budget_exhausted'
      );

      harness.now.value += 1_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(readdirSpy.mock.calls.length).toBe(afterFirstScanReads);
      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-active-priority')?.tool_call_ledger?.call_active_priority).toMatchObject({
        completion_status: 'completed',
        evidence_sources: ['session_transcript']
      });
      readdirSpy.mockRestore();
    });
  });

  it('prioritizes active rollout transcripts by run time before newer unrelated files can exhaust discovery', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const workspacePath = path.join(codexHome, 'workspaces', 'NIE-177-newer-active');
      const activeSessionDir = path.join(codexHome, 'sessions', '2026', '05', '07');
      fs.mkdirSync(activeSessionDir, { recursive: true });
      const largePayload = 'x'.repeat(128 * 1024);
      for (let index = 0; index < 40; index += 1) {
        const minute = 46 + index;
        const hour = 14 + Math.floor(minute / 60);
        fs.writeFileSync(
          path.join(
            activeSessionDir,
            `rollout-2026-05-07T${String(hour).padStart(2, '0')}-${String(
              minute % 60
            ).padStart(2, '0')}-00-newer-${String(index).padStart(3, '0')}.jsonl`
          ),
          `${JSON.stringify({
            timestamp: new Date(Date.parse('2026-05-07T14:46:00Z') + index * 60_000).toISOString(),
            type: 'event_msg',
            payload: { type: 'noise', workspace: '/tmp/unrelated-newer-workspace', padding: largePayload }
          })}\n`,
          'utf8'
        );
      }

      const harness = createHarness({
        configOverrides: {
          running_wait_stall_threshold_ms: 10_000,
          stall_timeout_ms: 8 * 60 * 60 * 1_000,
          worker_opaque_activity_hard_timeout_ms: 8 * 60 * 60 * 1_000
        },
        spawnWorker: async ({ issue, worker_host }) => {
          return {
            ok: true,
            worker_handle: { issue_id: issue.id },
            monitor_handle: { issue_id: issue.id },
            worker_host,
            workspace_path: workspacePath
          };
        }
      });
      harness.now.value = Date.parse('2026-05-07T13:45:00Z');
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-newer-active', identifier: 'ABC-TRANSCRIPT-NEWER-ACTIVE' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-newer-active', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-newer-active',
        turn_id: 'turn-newer-active',
        session_id: 'session-newer-active'
      });
      writeSessionTranscript(codexHome, 'rollout-2026-05-07T13-45-00-active789.jsonl', [
        {
          timestamp: new Date(harness.now.value + 5).toISOString(),
          type: 'turn_context',
          payload: {
            cwd: workspacePath
          }
        },
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          type: 'response_item',
          thread_id: 'thread-newer-active',
          turn_id: 'turn-newer-active',
          session_id: 'session-newer-active',
          payload: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_newer_active'
          }
        },
        {
          timestamp: new Date(harness.now.value + 20).toISOString(),
          type: 'response_item',
          thread_id: 'thread-newer-active',
          turn_id: 'turn-newer-active',
          session_id: 'session-newer-active',
          payload: {
            type: 'function_call_output',
            call_id: 'call_newer_active',
            output: '{}'
          }
        }
      ]);

      const readdirSpy = vi.spyOn(fs, 'readdirSync');
      const waitingAtMs = Date.parse('2026-05-07T15:00:00Z');
      harness.orchestrator.onWorkerEvent('i-transcript-newer-active', {
        timestamp_ms: waitingAtMs,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting much later with newer same-directory rollout transcripts present',
        thread_id: 'thread-newer-active',
        turn_id: 'turn-newer-active',
        session_id: 'session-newer-active'
      });
      harness.now.value = waitingAtMs + 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      const afterFirstScanReads = readdirSpy.mock.calls.length;
      const runningAfterFirstScan = harness.orchestrator.getStateSnapshot().running.get('i-transcript-newer-active');
      expect(runningAfterFirstScan?.tool_call_ledger?.call_newer_active).toMatchObject({
        call_id: 'call_newer_active',
        completion_status: 'completed',
        evidence_sources: ['session_transcript']
      });
      expect(runningAfterFirstScan?.codex_session_transcript_scan_budget?.candidate_count).toBeGreaterThan(0);
      expect(runningAfterFirstScan?.codex_session_transcript_scan_budget?.files_considered).toBe(
        runningAfterFirstScan?.codex_session_transcript_scan_budget?.limits.max_discovery_files
      );
      expect(runningAfterFirstScan?.codex_session_transcript_scan_budget?.reason_codes).toContain(
        'transcript_discovery_file_count_budget_exhausted'
      );

      harness.now.value += 1_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(readdirSpy.mock.calls.length).toBe(afterFirstScanReads);
      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-newer-active')?.tool_call_ledger?.call_newer_active).toMatchObject({
        completion_status: 'completed',
        evidence_sources: ['session_transcript']
      });
      readdirSpy.mockRestore();
    });
  });

  it('preserves an incomplete active transcript line for a later scan', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 10_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-partial-line', identifier: 'ABC-TRANSCRIPT-PARTIAL' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-partial-line', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-partial-line',
        turn_id: 'turn-partial-line',
        session_id: 'session-partial-line'
      });

      const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '07');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, 'session-partial-line.jsonl');
      const recordLine = JSON.stringify({
        timestamp: new Date(harness.now.value + 10).toISOString(),
        session_id: 'session-partial-line',
        thread_id: 'thread-partial-line',
        turn_id: 'turn-partial-line',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'linear_graphql',
          call_id: 'call_partial_line'
        }
      });
      const splitIndex = Math.floor(recordLine.length / 2);
      fs.writeFileSync(transcriptPath, recordLine.slice(0, splitIndex), 'utf8');

      harness.orchestrator.onWorkerEvent('i-transcript-partial-line', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting while transcript line is still being appended',
        thread_id: 'thread-partial-line',
        turn_id: 'turn-partial-line',
        session_id: 'session-partial-line'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');

      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-partial-line')?.tool_call_ledger ?? {}).toEqual({});

      fs.appendFileSync(transcriptPath, `${recordLine.slice(splitIndex)}\n`, 'utf8');
      harness.now.value += 100;
      await harness.orchestrator.tick('interval');

      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-partial-line')?.tool_call_ledger?.call_partial_line).toMatchObject({
        call_id: 'call_partial_line',
        completion_status: 'pending',
        evidence_sources: ['session_transcript']
      });
    });
  });

  it('processes complete transcript lines while preserving a trailing partial line', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 10_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-trailing-partial', identifier: 'ABC-TRANSCRIPT-TRAILING' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-trailing-partial', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-trailing-partial',
        turn_id: 'turn-trailing-partial',
        session_id: 'session-trailing-partial'
      });

      const callLine = JSON.stringify({
        timestamp: new Date(harness.now.value + 10).toISOString(),
        session_id: 'session-trailing-partial',
        thread_id: 'thread-trailing-partial',
        turn_id: 'turn-trailing-partial',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'linear_graphql',
          call_id: 'call_trailing_partial'
        }
      });
      const outputLine = JSON.stringify({
        timestamp: new Date(harness.now.value + 20).toISOString(),
        session_id: 'session-trailing-partial',
        thread_id: 'thread-trailing-partial',
        turn_id: 'turn-trailing-partial',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_trailing_partial',
          output: '{}'
        }
      });
      const outputSplitIndex = Math.floor(outputLine.length / 2);
      const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '07');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, 'session-trailing-partial.jsonl');
      fs.writeFileSync(transcriptPath, `${callLine}\n${outputLine.slice(0, outputSplitIndex)}`, 'utf8');

      harness.orchestrator.onWorkerEvent('i-transcript-trailing-partial', {
        timestamp_ms: harness.now.value + 30,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting with a complete call and partial output line',
        thread_id: 'thread-trailing-partial',
        turn_id: 'turn-trailing-partial',
        session_id: 'session-trailing-partial'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');

      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-trailing-partial')?.tool_call_ledger?.call_trailing_partial).toMatchObject({
        call_id: 'call_trailing_partial',
        completion_status: 'pending',
        evidence_sources: ['session_transcript']
      });

      fs.appendFileSync(transcriptPath, `${outputLine.slice(outputSplitIndex)}\n`, 'utf8');
      harness.now.value += 100;
      await harness.orchestrator.tick('interval');

      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-trailing-partial')?.tool_call_ledger?.call_trailing_partial).toMatchObject({
        call_id: 'call_trailing_partial',
        completion_status: 'completed',
        evidence_sources: ['session_transcript']
      });
    });
  });

  it('stops historical transcript discovery at the files-considered budget', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const historicalDir = path.join(codexHome, 'sessions', '2026', '05', '02');
      fs.mkdirSync(historicalDir, { recursive: true });
      const historicalFileCount = 120;
      for (let index = 0; index < historicalFileCount; index += 1) {
        fs.writeFileSync(
          path.join(historicalDir, `rollout-2026-05-02T00-00-${String(index).padStart(3, '0')}-noise.jsonl`),
          `${JSON.stringify({
            timestamp: new Date(Date.now()).toISOString(),
            type: 'event_msg',
            payload: { type: 'noise', workspace: '/tmp/unrelated-workspace' }
          })}\n`,
          'utf8'
        );
      }

      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 10_000, stall_timeout_ms: 60_000 },
        spawnWorker: async ({ issue, worker_host }) => {
          return {
            ok: true,
            worker_handle: { issue_id: issue.id },
            monitor_handle: { issue_id: issue.id },
            worker_host
          };
        }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-file-limit', identifier: 'ABC-TRANSCRIPT-FILE-LIMIT' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-file-limit', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-file-limit',
        turn_id: 'turn-file-limit',
        session_id: 'session-file-limit'
      });
      harness.orchestrator.onWorkerEvent('i-transcript-file-limit', {
        timestamp_ms: harness.now.value + 30,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting with many nonmatching historical transcripts present',
        thread_id: 'thread-file-limit',
        turn_id: 'turn-file-limit',
        session_id: 'session-file-limit'
      });

      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      const scanBudget = harness.orchestrator.getStateSnapshot().running.get(
        'i-transcript-file-limit'
      )?.codex_session_transcript_scan_budget;
      expect(scanBudget?.candidate_count).toBe(0);
      expect(scanBudget?.files_considered).toBeLessThan(historicalFileCount);
      expect(scanBudget?.files_considered).toBe(scanBudget?.limits.max_discovery_files);
      expect(scanBudget?.reason_codes).toContain('transcript_discovery_file_count_budget_exhausted');
    });
  });

  it('ignores stale same-workspace rollout function_call records from a prior run', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const workspacePath = path.join(codexHome, 'workspaces', 'NIE-79-reused');
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 10_000, stall_timeout_ms: 60_000 },
        spawnWorker: async ({ issue, worker_host }) => {
          return {
            ok: true,
            worker_handle: { issue_id: issue.id },
            monitor_handle: { issue_id: issue.id },
            worker_host,
            workspace_path: workspacePath
          };
        }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-rollout-stale', identifier: 'ABC-TRANSCRIPT-ROLLOUT-STALE' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-rollout-stale', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-rollout-current',
        turn_id: 'turn-rollout-current',
        session_id: 'session-rollout-current'
      });
      writeSessionTranscript(codexHome, 'rollout-2026-05-07T12-30-00-000Z-prior.jsonl', [
        {
          timestamp: new Date(harness.now.value - 10_000).toISOString(),
          type: 'turn_context',
          payload: {
            cwd: workspacePath
          }
        },
        {
          timestamp: new Date(harness.now.value - 9_000).toISOString(),
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_prior_rollout_same_workspace'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-rollout-stale', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting with prior same-workspace transcript present',
        thread_id: 'thread-rollout-current',
        turn_id: 'turn-rollout-current',
        session_id: 'session-rollout-current'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-transcript-rollout-stale')).toBe(false);
      const running = harness.orchestrator.getStateSnapshot().running.get('i-transcript-rollout-stale');
      expect(running?.outstanding_tool_calls ?? {}).toEqual({});
      expect(running?.tool_call_ledger ?? {}).toEqual({});
      expect(running?.transcript_tool_call_diagnostics).toContainEqual(
        expect.objectContaining({
          kind: 'function_call',
          call_id: 'call_prior_rollout_same_workspace',
          lineage: 'prior_stale',
          reason: 'transcript record predates active run start'
        })
      );
    });
  });

  it('does not block when a transcript function_call_output matches the transcript function_call', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 10_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-output', identifier: 'ABC-TRANSCRIPT-OUTPUT' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-output', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-output',
        turn_id: 'turn-output',
        session_id: 'session-output'
      });
      writeSessionTranscript(codexHome, 'session-output.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-output',
          thread_id: 'thread-output',
          turn_id: 'turn-output',
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_transcript_output'
          }
        },
        {
          timestamp: new Date(harness.now.value + 100).toISOString(),
          session_id: 'session-output',
          thread_id: 'thread-output',
          turn_id: 'turn-output',
          response_item: {
            type: 'function_call_output',
            call_id: 'call_transcript_output',
            output: '{}'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-output', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting after transcript tool output',
        thread_id: 'thread-output',
        turn_id: 'turn-output',
        session_id: 'session-output'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-transcript-output')).toBe(false);
      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-output')?.tool_call_ledger?.call_transcript_output).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_transcript_output',
        session_id: 'session-output',
        completion_status: 'completed',
        evidence_sources: ['session_transcript'],
        start_evidence_source: 'session_transcript',
        completion_evidence_source: 'session_transcript'
      });
    });
  });

  it('clears a real Codex rollout transcript function_call with a matching output payload', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const workspacePath = path.join(codexHome, 'workspaces', 'NIE-79-output');
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
        spawnWorker: async ({ issue, worker_host }) => {
          return {
            ok: true,
            worker_handle: { issue_id: issue.id },
            monitor_handle: { issue_id: issue.id },
            worker_host,
            workspace_path: workspacePath
          };
        }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-rollout-output', identifier: 'ABC-TRANSCRIPT-ROLLOUT-OUTPUT' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-rollout-output', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-rollout-output',
        turn_id: 'turn-rollout-output',
        session_id: 'session-rollout-output'
      });
      writeSessionTranscript(codexHome, 'rollout-2026-05-07T13-45-00-000Z-def456.jsonl', [
        {
          timestamp: new Date(harness.now.value + 5).toISOString(),
          type: 'turn_context',
          payload: {
            cwd: workspacePath
          }
        },
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          type: 'response_item',
          thread_id: 'thread-rollout-output',
          turn_id: 'turn-rollout-output',
          session_id: 'session-rollout-output',
          payload: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_rollout_output'
          }
        },
        {
          timestamp: new Date(harness.now.value + 100).toISOString(),
          type: 'response_item',
          thread_id: 'thread-rollout-output',
          turn_id: 'turn-rollout-output',
          session_id: 'session-rollout-output',
          payload: {
            type: 'function_call_output',
            call_id: 'call_rollout_output',
            output: '{}'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-rollout-output', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting after rollout transcript output',
        thread_id: 'thread-rollout-output',
        turn_id: 'turn-rollout-output',
        session_id: 'session-rollout-output'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-transcript-rollout-output')).toBe(false);
      expect(
        harness.orchestrator.getStateSnapshot().running.get('i-transcript-rollout-output')?.outstanding_tool_calls ?? {}
      ).toEqual({});
    });
  });

  it('keeps transcript function_call outstanding when only a stale mismatched output appears', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-stale-output', identifier: 'ABC-TRANSCRIPT-STALE-OUTPUT' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-stale-output', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-stale-output',
        turn_id: 'turn-stale-output',
        session_id: 'session-stale-output'
      });
      writeSessionTranscript(codexHome, 'session-stale-output.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-stale-output',
          thread_id: 'thread-stale-output',
          turn_id: 'turn-stale-output',
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_still_missing'
          }
        },
        {
          timestamp: new Date(harness.now.value + 100).toISOString(),
          session_id: 'session-stale-output',
          response_item: {
            type: 'function_call_output',
            call_id: 'call_old_completed',
            output: '{}'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-stale-output', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting with stale output present',
        thread_id: 'thread-stale-output',
        turn_id: 'turn-stale-output',
        session_id: 'session-stale-output'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-stale-output')?.tool_output_wait).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_still_missing',
        evidence_source: 'session_transcript'
      });
    });
  });

  it('does not clear active missing-tool evidence from an unlineaged external transcript output', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-unlineaged-output', identifier: 'ABC-TRANSCRIPT-UNLINEAGED-OUTPUT' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-unlineaged-output', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-owned-output',
        turn_id: 'turn-owned-output',
        session_id: 'session-owned-output'
      });
      writeSessionTranscript(codexHome, 'session-owned-output.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-owned-output',
          thread_id: 'thread-owned-output',
          turn_id: 'turn-owned-output',
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_owned_missing'
          }
        },
        {
          timestamp: new Date(harness.now.value + 100).toISOString(),
          response_item: {
            type: 'function_call_output',
            call_id: 'call_owned_missing',
            output: '{}'
          }
        }
      ]);
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-unlineaged-output')?.tool_output_wait).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_owned_missing',
        evidence_source: 'session_transcript'
      });
      expect(
        harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-unlineaged-output')?.transcript_tool_call_diagnostics
      ).toContainEqual(
        expect.objectContaining({
          kind: 'function_call_output',
          call_id: 'call_owned_missing',
          lineage: 'unattributed',
          reason: 'no active runtime lineage identifiers matched'
        })
      );
    });
  });

  it('keeps manual resume transcript output diagnostic-only when it only shares the active session', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-manual-resume', identifier: 'ABC-TRANSCRIPT-MANUAL' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-manual-resume', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-owned-manual',
        turn_id: 'turn-owned-manual',
        session_id: 'session-owned-manual'
      });
      harness.orchestrator.onWorkerEvent('i-transcript-manual-resume', {
        timestamp_ms: harness.now.value + 10,
        event: CANONICAL_EVENT.codex.toolCallStarted,
        tool_name: 'linear_graphql',
        tool_call_id: 'call_manual_resume_overlap',
        thread_id: 'thread-owned-manual',
        turn_id: 'turn-owned-manual',
        session_id: 'session-owned-manual'
      });
      writeSessionTranscript(codexHome, 'session-owned-manual.jsonl', [
        {
          timestamp: new Date(harness.now.value + 100).toISOString(),
          session_id: 'session-owned-manual',
          response_item: {
            type: 'function_call_output',
            call_id: 'call_manual_resume_overlap',
            output: '{}'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-manual-resume', {
        timestamp_ms: harness.now.value + 200,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting after external manual resume transcript append',
        thread_id: 'thread-owned-manual',
        turn_id: 'turn-owned-manual',
        session_id: 'session-owned-manual'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-manual-resume');
      expect(blocked?.transcript_tool_call_diagnostics).toContainEqual(
        expect.objectContaining({
          kind: 'function_call_output',
          call_id: 'call_manual_resume_overlap',
          session_id: 'session-owned-manual',
          lineage: 'external_manual',
          reason: 'partial active lineage is insufficient for ownership: session_id',
          active_thread_id: 'thread-owned-manual',
          active_turn_id: 'turn-owned-manual',
          active_session_id: 'session-owned-manual'
        })
      );
      expect(blocked?.tool_output_wait).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_manual_resume_overlap',
        evidence_source: 'worker_event'
      });
    });
  });

  it('blocks a non-Linear transcript function_call generically', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-nonlinear', identifier: 'ABC-TRANSCRIPT-NONLINEAR' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-nonlinear', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-nonlinear',
        turn_id: 'turn-nonlinear',
        session_id: 'session-nonlinear'
      });
      writeSessionTranscript(codexHome, 'session-nonlinear.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-nonlinear',
          thread_id: 'thread-nonlinear',
          turn_id: 'turn-nonlinear',
          response_item: {
            type: 'function_call',
            name: 'github_graphql',
            call_id: 'call_transcript_github'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-nonlinear', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting for github_graphql output',
        thread_id: 'thread-nonlinear',
        turn_id: 'turn-nonlinear',
        session_id: 'session-nonlinear'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-nonlinear')?.tool_output_wait).toMatchObject({
        tool_name: 'github_graphql',
        call_id: 'call_transcript_github',
        evidence_source: 'session_transcript'
      });
    });
  });

  it('ignores unrelated no-lineage transcript function_call records', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-unrelated', identifier: 'ABC-TRANSCRIPT-UNRELATED' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-unrelated', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-related',
        turn_id: 'turn-related',
        session_id: 'session-related'
      });
      writeSessionTranscript(codexHome, 'unrelated-session.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_unrelated_no_lineage'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-unrelated', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting with unrelated transcript present',
        thread_id: 'thread-related',
        turn_id: 'turn-related',
        session_id: 'session-related'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-transcript-unrelated')).toBe(false);
      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-unrelated')?.outstanding_tool_calls ?? {}).toEqual({});
    });
  });

  it('keeps missing tool output from being overwritten by generic stall timeout in the same tick', async () => {
    const completedRuns: Array<{ terminal_status: string; error_code: string | null }> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-missing-timeout',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async ({ terminal_status, error_code }) => {
        completedRuns.push({ terminal_status, error_code: error_code ?? null });
      }
    };
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 1_000 },
      persistence
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-missing-timeout', identifier: 'ABC-MISS-TIMEOUT' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-missing-timeout', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_timeout_collision',
      thread_id: 'thread-timeout',
      turn_id: 'turn-timeout',
      session_id: 'session-timeout'
    });
    harness.orchestrator.onWorkerEvent('i-missing-timeout', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for linear_graphql output',
      thread_id: 'thread-timeout',
      turn_id: 'turn-timeout',
      session_id: 'session-timeout'
    });

    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    const snapshot = harness.orchestrator.getStateSnapshot();
    const blocked = snapshot.blocked_inputs.get('i-missing-timeout');
    expect(blocked?.stop_reason_code).toBe(REASON_CODES.missingToolOutput);
    expect(blocked?.requires_manual_resume).toBe(true);
    expect(blocked?.tool_output_wait).toMatchObject({
      tool_name: 'linear_graphql',
      call_id: 'call_timeout_collision',
      thread_id: 'thread-timeout',
      turn_id: 'turn-timeout',
      session_id: 'session-timeout'
    });
    expect(snapshot.running.has('i-missing-timeout')).toBe(false);
    expect(snapshot.retry_attempts.has('i-missing-timeout')).toBe(false);
    expect(harness.terminated).toEqual([
      { issue_id: 'i-missing-timeout', cleanup_workspace: false, reason: REASON_CODES.missingToolOutput }
    ]);
    expect(completedRuns).toEqual([{ terminal_status: 'cancelled', error_code: REASON_CODES.missingToolOutput }]);
    expect(
      snapshot.recent_runtime_events.some(
        (entry) =>
          entry.event === CANONICAL_EVENT.orchestration.workerStalled && entry.issue_identifier === 'ABC-MISS-TIMEOUT'
      )
    ).toBe(false);
  });

  it('does not block when matching tool output arrives before the waiting threshold', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 10_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-tool-ok', identifier: 'ABC-TOOL-OK' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-tool-ok', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'dynamic_tool',
      tool_name: 'dynamic_tool',
      tool_call_id: 'call_ok'
    });
    harness.orchestrator.onWorkerEvent('i-tool-ok', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.toolCallCompleted,
      detail: 'dynamic_tool',
      tool_name: 'dynamic_tool',
      tool_call_id: 'call_ok'
    });
    harness.orchestrator.onWorkerEvent('i-tool-ok', {
      timestamp_ms: harness.now.value + 200,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting after tool output'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-tool-ok')).toBe(false);
    expect(harness.orchestrator.getStateSnapshot().running.get('i-tool-ok')?.tool_call_ledger?.call_ok).toMatchObject({
      call_id: 'call_ok',
      tool_name: 'dynamic_tool',
      issue_id: 'i-tool-ok',
      issue_identifier: 'ABC-TOOL-OK',
      completion_status: 'completed',
      first_seen_at_ms: harness.now.value - 2_000,
      last_seen_at_ms: harness.now.value - 1_900,
      completed_at_ms: harness.now.value - 1_900,
      evidence_sources: ['worker_event'],
      start_evidence_source: 'worker_event',
      completion_evidence_source: 'worker_event'
    });
    expect(harness.orchestrator.getStateSnapshot().running.get('i-tool-ok')?.outstanding_tool_calls ?? {}).toEqual({});
  });

  it('preserves app-server protocol evidence for completed function calls', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 10_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-protocol-tool', identifier: 'ABC-PROTOCOL-TOOL' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-protocol-tool', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-protocol',
      turn_id: 'turn-protocol',
      session_id: 'session-protocol'
    });
    harness.orchestrator.onWorkerEvent('i-protocol-tool', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      thread_id: 'thread-protocol',
      turn_id: 'turn-protocol',
      session_id: 'session-protocol',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_protocol_ledger',
      tool_call_evidence_source: 'app_server_protocol'
    });
    harness.orchestrator.onWorkerEvent('i-protocol-tool', {
      timestamp_ms: harness.now.value + 120,
      event: CANONICAL_EVENT.codex.toolCallCompleted,
      detail: 'function_call_output',
      thread_id: 'thread-protocol',
      turn_id: 'turn-protocol',
      session_id: 'session-protocol',
      tool_call_id: 'call_protocol_ledger',
      tool_call_evidence_source: 'app_server_protocol'
    });

    expect(harness.orchestrator.getStateSnapshot().running.get('i-protocol-tool')?.tool_call_ledger?.call_protocol_ledger).toMatchObject({
      call_id: 'call_protocol_ledger',
      tool_name: 'linear_graphql',
      thread_id: 'thread-protocol',
      turn_id: 'turn-protocol',
      session_id: 'session-protocol',
      completion_status: 'completed',
      first_seen_at_ms: harness.now.value + 10,
      last_seen_at_ms: harness.now.value + 120,
      completed_at_ms: harness.now.value + 120,
      evidence_sources: ['app_server_protocol'],
      start_evidence_source: 'app_server_protocol',
      completion_evidence_source: 'app_server_protocol'
    });
    expect(harness.orchestrator.getStateSnapshot().running.get('i-protocol-tool')?.outstanding_tool_calls ?? {}).toEqual({});
  });

  it('does not classify healthy MCP tool events as missing dynamic GraphQL output', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 10_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-mcp-healthy', identifier: 'ABC-MCP-HEALTHY' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-mcp-healthy', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_mcp',
      tool_name: 'linear_mcp',
      tool_call_id: 'call_mcp_healthy'
    });
    harness.orchestrator.onWorkerEvent('i-mcp-healthy', {
      timestamp_ms: harness.now.value + 50,
      event: CANONICAL_EVENT.codex.toolCallCompleted,
      detail: 'linear_mcp',
      tool_name: 'linear_mcp',
      tool_call_id: 'call_mcp_healthy'
    });
    harness.orchestrator.onWorkerEvent('i-mcp-healthy', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting after healthy MCP operation'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');

    const running = harness.orchestrator.getStateSnapshot().running.get('i-mcp-healthy');
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-mcp-healthy')).toBe(false);
    expect(running?.tool_call_ledger?.call_mcp_healthy).toMatchObject({
      tool_name: 'linear_mcp',
      completion_status: 'completed',
      evidence_sources: ['worker_event']
    });
    expect(
      Object.values(running?.tool_call_ledger ?? {}).some(
        (call) => call.tool_name === 'linear_graphql' && call.completion_status === 'pending'
      )
    ).toBe(false);
  });

  it('quarantines duplicate or late tool output after missing-output blocked classification', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-tool-late', identifier: 'ABC-TOOL-LATE' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-tool-late', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-late',
      turn_id: 'turn-late',
      session_id: 'session-late'
    });
    harness.orchestrator.onWorkerEvent('i-tool-late', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'dynamic_tool',
      tool_name: 'dynamic_tool',
      tool_call_id: 'call_late',
      thread_id: 'thread-late',
      turn_id: 'turn-late',
      session_id: 'session-late'
    });
    harness.orchestrator.onWorkerEvent('i-tool-late', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for tool output',
      thread_id: 'thread-late',
      turn_id: 'turn-late',
      session_id: 'session-late'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    harness.orchestrator.onWorkerEvent('i-tool-late', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.toolCallCompleted,
      detail: 'dynamic_tool',
      tool_name: 'dynamic_tool',
      tool_call_id: 'call_late',
      thread_id: 'thread-late',
      turn_id: 'turn-late',
      session_id: 'session-late'
    });

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-tool-late');
    expect(blocked?.stop_reason_code).toBe(REASON_CODES.missingToolOutput);
    expect(blocked?.quarantined_event_count).toBe(1);
    expect(blocked?.tool_output_wait?.call_id).toBe('call_late');
  });

  it('preserves missing-tool-output root cause when tracker state later leaves active states', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-tool-terminal', identifier: 'ABC-TOOL-TERM' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-tool-terminal', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-terminal',
      turn_id: 'turn-terminal',
      session_id: 'session-terminal'
    });
    harness.orchestrator.onWorkerEvent('i-tool-terminal', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_terminal',
      thread_id: 'thread-terminal',
      turn_id: 'turn-terminal',
      session_id: 'session-terminal'
    });
    harness.orchestrator.onWorkerEvent('i-tool-terminal', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for tool output',
      thread_id: 'thread-terminal',
      turn_id: 'turn-terminal',
      session_id: 'session-terminal'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-tool-terminal', identifier: 'ABC-TOOL-TERM', state: 'Done' })
    ]);
    await harness.orchestrator.reconcileBlockedInputs();

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-tool-terminal');
    expect(blocked?.stop_reason_code).toBe(REASON_CODES.missingToolOutput);
    expect(blocked?.tool_output_wait?.call_id).toBe('call_terminal');
  });
});
