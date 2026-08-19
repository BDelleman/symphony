import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDurableIdentity,
  createStoreTestHarness,
  fs,
  os,
  path,
  SqlitePersistenceStore
} from './store-test-harness';

describe('SqlitePersistenceStore execution graph', () => {
  const { dirs, stores, identity, openDatabase, tableNames, withLegacyProjectKey, cleanup } = createStoreTestHarness();

  afterEach(cleanup);

  it('preserves raw durable identity payloads for issue_run rows', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-identity-payload-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = withLegacyProjectKey(identity({ issue_id: 'i-legacy-key', issue_identifier: 'ABC-LEGACY' }));

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const started = store.recordRunStarted({
      issue_id: 'i-legacy-key',
      issue_identifier: 'ABC-LEGACY',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running',
      reason_code: 'dispatch_started'
    });

    const db = openDatabase(dbPath);
    try {
      const run = db.prepare('SELECT identity FROM runs WHERE run_id = ?').get(started.run_id) as { identity: string };
      const issueRun = db.prepare('SELECT identity FROM issue_run WHERE issue_run_id = ?').get(started.issue_run_id) as { identity: string };
      expect(JSON.parse(issueRun.identity)).toEqual(JSON.parse(run.identity));
      expect(JSON.parse(issueRun.identity)).toEqual(durableIdentity);
    } finally {
      db.close();
    }
  });

  it('closes normalized execution graph rows when a linked legacy run completes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-complete-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    let nowMs = Date.parse('2026-04-11T10:00:00.000Z');
    const durableIdentity = identity({ issue_id: 'i-linked', issue_identifier: 'ABC-LINKED' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => nowMs });
    stores.push(storeA);
    const started = storeA.recordRunStarted({
      issue_id: 'i-linked',
      issue_identifier: 'ABC-LINKED',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running',
      reason_code: 'dispatch_started',
      reason_detail: 'dispatch token=abcd1234'
    });

    nowMs = Date.parse('2026-04-11T10:05:00.000Z');
    storeA.completeRun({
      run_id: started.run_id,
      terminal_status: 'failed',
      error_code: 'worker_failed',
      terminal_reason_code: 'worker_failed',
      terminal_reason_detail: 'failed with token=abcd1234'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const timeline = storeB.reconstructTicketTimeline(durableIdentity);

    expect(timeline.issue_runs).toEqual([
      expect.objectContaining({
        issue_run_id: started.issue_run_id,
        ended_at: '2026-04-11T10:05:00.000Z',
        status: 'failed',
        reason_code: 'worker_failed',
        reason_detail: 'failed with token=***REDACTED***'
      })
    ]);
    expect(timeline.attempts).toEqual([
      expect.objectContaining({
        attempt_id: started.attempt_id,
        issue_run_id: started.issue_run_id,
        ended_at: '2026-04-11T10:05:00.000Z',
        status: 'failed',
        reason_code: 'worker_failed',
        reason_detail: 'failed with token=***REDACTED***'
      })
    ]);
    expect(timeline.state_transitions).toEqual([
      expect.objectContaining({
        issue_run_id: started.issue_run_id,
        attempt_id: started.attempt_id,
        to_status: 'running',
        reason_code: 'dispatch_started'
      }),
      expect.objectContaining({
        issue_run_id: started.issue_run_id,
        attempt_id: started.attempt_id,
        to_status: 'failed',
        reason_code: 'worker_failed'
      })
    ]);
  });

  it('closes turn and thread before the attempt and records handoff process/workflow outcomes separately', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-handoff-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    let nowMs = Date.parse('2026-04-11T10:05:00.000Z');
    const durableIdentity = identity({ issue_id: 'i-handoff', issue_identifier: 'ABC-HANDOFF' });
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => nowMs });
    stores.push(store);
    const started = store.recordRunStarted({
      issue_id: 'i-handoff',
      issue_identifier: 'ABC-HANDOFF',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const threadId = store.appendThread({
      attempt_id: started.attempt_id,
      thread_id: 'claude:handoff-session',
      started_at: '2026-04-11T10:01:00.000Z',
      status: 'running'
    });
    store.appendTurn({
      thread_id: threadId,
      turn_id: 'claude-handoff-turn',
      turn_index: 0,
      started_at: '2026-04-11T10:02:00.000Z',
      status: 'running'
    });

    store.completeRun({
      run_id: started.run_id,
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      terminal_status: 'succeeded',
      terminal_reason_code: 'handoff_state_reached'
    });

    const history = store.listRunHistory().find((run) => run.run_id === started.run_id);
    const timeline = store.reconstructTicketTimeline(durableIdentity);
    expect(history).toMatchObject({
      terminal_status: 'succeeded',
      process_status: 'cancelled',
      workflow_outcome: 'handoff_reached'
    });
    expect(timeline.turns[0]).toMatchObject({ ended_at: '2026-04-11T10:05:00.000Z', status: 'succeeded' });
    expect(timeline.threads[0]).toMatchObject({ ended_at: '2026-04-11T10:05:00.000Z', status: 'succeeded' });
    expect(timeline.attempts[0]).toMatchObject({
      process_status: 'cancelled',
      workflow_outcome: 'handoff_reached'
    });
    expect(timeline.issue_runs[0]).toMatchObject({
      process_status: 'cancelled',
      workflow_outcome: 'handoff_reached'
    });
  });

  it('treats tracker reconciliation handoff release as a reached workflow handoff', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-handoff-release-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'i-handoff-release', issue_identifier: 'ABC-HANDOFF-RELEASE' });
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const started = store.recordRunStarted({
      issue_id: 'i-handoff-release',
      issue_identifier: 'ABC-HANDOFF-RELEASE',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });

    store.completeRun({
      run_id: started.run_id,
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      terminal_status: 'cancelled',
      terminal_reason_code: 'handoff_release'
    });

    expect(store.listRunHistory().find((run) => run.run_id === started.run_id)).toMatchObject({
      terminal_status: 'cancelled',
      process_status: 'cancelled',
      workflow_outcome: 'handoff_reached'
    });
    expect(store.reconstructTicketTimeline(durableIdentity).issue_runs[0]).toMatchObject({
      process_status: 'cancelled',
      workflow_outcome: 'handoff_reached'
    });
  });

  it('repairs only provably terminal orphan graphs during explicit startup reconciliation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-reconcile-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'i-reconcile', issue_identifier: 'ABC-RECONCILE' });
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const started = store.recordRunStarted({
      issue_id: 'i-reconcile',
      issue_identifier: 'ABC-RECONCILE',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const db = openDatabase(dbPath);
    try {
      db.prepare(
        `UPDATE runs SET ended_at = ?, completed_at = ?, terminal_status = ?, terminal_reason_code = ? WHERE run_id = ?`
      ).run(
        '2026-04-11T10:05:00.000Z',
        '2026-04-11T10:05:00.000Z',
        'failed',
        'worker_crashed',
        started.run_id
      );
    } finally {
      db.close();
    }

    expect(store.reconcileExecutionGraphAfterRestart()).toEqual({ recovered: 1, ambiguous: 0 });
    expect(store.reconstructTicketTimeline(durableIdentity).issue_runs[0]).toMatchObject({
      ended_at: '2026-04-11T10:05:00.000Z',
      status: 'failed',
      reason_code: 'recovered_after_restart'
    });
  });

  it('repairs a pre-init failure from its terminal runner event', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-terminal-event-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'i-terminal-event', issue_identifier: 'ABC-TERMINAL-EVENT' });
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const started = store.recordRunStarted({
      issue_id: 'i-terminal-event',
      issue_identifier: 'ABC-TERMINAL-EVENT',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    store.recordEvent({
      run_id: started.run_id,
      event: 'agent_runner.turn.failed',
      message: 'provider failed before init',
      timestamp_ms: Date.parse('2026-04-11T10:05:00.000Z')
    });

    expect(store.reconcileExecutionGraphAfterRestart()).toEqual({ recovered: 1, ambiguous: 0 });
    expect(store.reconstructTicketTimeline(durableIdentity).issue_runs[0]).toMatchObject({
      ended_at: '2026-04-11T10:05:00.000Z',
      status: 'failed',
      reason_code: 'recovered_after_restart'
    });
  });

  it('does not use an earlier terminal event when the latest run has no terminal evidence', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-stale-terminal-event-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'i-stale-event', issue_identifier: 'ABC-STALE-EVENT' });
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const started = store.recordRunStarted({
      issue_id: 'i-stale-event',
      issue_identifier: 'ABC-STALE-EVENT',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    store.recordEvent({
      run_id: started.run_id,
      event: 'agent_runner.turn.failed',
      message: 'first attempt failed',
      timestamp_ms: Date.parse('2026-04-11T10:05:00.000Z')
    });
    store.startRun({
      issue_id: 'i-stale-event',
      issue_identifier: 'ABC-STALE-EVENT',
      identity: durableIdentity,
      started_at: '2026-04-11T10:10:00.000Z',
      issue_run_id: started.issue_run_id
    });

    expect(store.reconcileExecutionGraphAfterRestart()).toEqual({ recovered: 0, ambiguous: 1 });
  });

  it('repairs an inactive issue run superseded by a later terminal run for the same issue', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-superseded-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    let nowMs = Date.parse('2026-04-11T10:00:00.000Z');
    const durableIdentity = identity({ issue_id: 'i-superseded', issue_identifier: 'ABC-SUPERSEDED' });
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => nowMs });
    stores.push(store);
    const superseded = store.recordRunStarted({
      issue_id: 'i-superseded',
      issue_identifier: 'ABC-SUPERSEDED',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    nowMs = Date.parse('2026-04-11T10:10:00.000Z');
    const replacement = store.recordRunStarted({
      issue_id: 'i-superseded',
      issue_identifier: 'ABC-SUPERSEDED',
      identity: durableIdentity,
      started_at: '2026-04-11T10:10:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    nowMs = Date.parse('2026-04-11T10:15:00.000Z');
    store.completeRun({
      run_id: replacement.run_id,
      issue_run_id: replacement.issue_run_id,
      attempt_id: replacement.attempt_id,
      terminal_status: 'succeeded',
      terminal_reason_code: 'completed'
    });

    expect(store.reconcileExecutionGraphAfterRestart()).toEqual({ recovered: 1, ambiguous: 0 });
    const timeline = store.reconstructTicketTimeline(durableIdentity);
    expect(timeline.issue_runs.find((run) => run.issue_run_id === superseded.issue_run_id)).toMatchObject({
      ended_at: '2026-04-11T10:10:00.000Z',
      status: 'cancelled',
      process_status: 'cancelled',
      workflow_outcome: 'cancelled',
      reason_code: 'recovered_after_restart'
    });
    expect(timeline.issue_runs.find((run) => run.issue_run_id === replacement.issue_run_id)).toMatchObject({
      ended_at: '2026-04-11T10:15:00.000Z',
      status: 'succeeded'
    });
  });

  it('refuses restart reconciliation while persisted worker ownership is still live', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-live-owner-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'i-live-owner', issue_identifier: 'ABC-LIVE-OWNER' });
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const started = store.recordRunStarted({
      issue_id: 'i-live-owner',
      issue_identifier: 'ABC-LIVE-OWNER',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    store.appendThread({
      attempt_id: started.attempt_id,
      thread_id: 'thread-live-owner',
      session_id: 'session-live-owner',
      agent_runtime: 'claude-cli',
      worker_instance_id: 'worker-live-owner',
      worker_process_pid: process.pid,
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running'
    });
    const replacement = store.recordRunStarted({
      issue_id: 'i-live-owner',
      issue_identifier: 'ABC-LIVE-OWNER',
      identity: durableIdentity,
      started_at: '2026-04-11T10:10:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    store.completeRun({
      run_id: replacement.run_id,
      issue_run_id: replacement.issue_run_id,
      attempt_id: replacement.attempt_id,
      terminal_status: 'failed',
      terminal_reason_code: 'worker_crashed'
    });

    expect(store.reconcileExecutionGraphAfterRestart()).toEqual({ recovered: 0, ambiguous: 1 });
    expect(
      store.reconstructTicketTimeline(durableIdentity).issue_runs.find((run) => run.issue_run_id === started.issue_run_id)?.ended_at
    ).toBeNull();
    expect(store.historySchemaHealth()).toMatchObject({
      status: 'degraded',
      degraded_reason_code: 'history_orphan_reconciliation_ambiguous'
    });
  });

  it('reopens a linked issue run when retry lineage appends a later running attempt', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-retry-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    let nowMs = Date.parse('2026-04-11T10:00:00.000Z');
    const durableIdentity = identity({ issue_id: 'i-retry-linked', issue_identifier: 'ABC-RETRY' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => nowMs });
    stores.push(storeA);
    const started = storeA.recordRunStarted({
      issue_id: 'i-retry-linked',
      issue_identifier: 'ABC-RETRY',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running',
      reason_code: 'dispatch_started'
    });
    nowMs = Date.parse('2026-04-11T10:05:00.000Z');
    storeA.completeRun({
      run_id: started.run_id,
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      terminal_status: 'stalled',
      error_code: 'worker_stalled',
      terminal_reason_code: 'worker_stalled',
      terminal_reason_detail: 'stalled before retry'
    });

    const retryAttemptId = storeA.appendAttempt({
      issue_run_id: started.issue_run_id,
      attempt_number: 1,
      started_at: '2026-04-11T10:10:00.000Z',
      status: 'running',
      reason_code: 'attempt_started',
      reason_detail: 'retry attempt'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const timeline = storeB.reconstructTicketTimeline(durableIdentity);

    expect(timeline.issue_runs).toEqual([
      expect.objectContaining({
        issue_run_id: started.issue_run_id,
        ended_at: null,
        status: 'running',
        reason_code: 'attempt_started'
      })
    ]);
    expect(timeline.attempts).toEqual([
      expect.objectContaining({
        attempt_id: started.attempt_id,
        attempt_number: 0,
        ended_at: '2026-04-11T10:05:00.000Z',
        status: 'stalled',
        reason_code: 'worker_stalled'
      }),
      expect.objectContaining({
        attempt_id: retryAttemptId,
        attempt_number: 1,
        ended_at: null,
        status: 'running',
        reason_code: 'attempt_started'
      })
    ]);
  });

  it('records attempt-scoped terminal facts even when turn transitions share a status and the issue run is retried', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-terminal-facts-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    let nowMs = Date.parse('2026-04-11T10:05:00.000Z');
    const durableIdentity = identity({ issue_id: 'i-terminal-facts', issue_identifier: 'ABC-TERMINAL-FACTS' });
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => nowMs });
    stores.push(store);
    const started = store.recordRunStarted({
      issue_id: 'i-terminal-facts',
      issue_identifier: 'ABC-TERMINAL-FACTS',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running',
      reason_code: 'dispatch_started'
    });
    store.appendStateTransition({
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      from_status: 'running',
      to_status: 'succeeded',
      transitioned_at: '2026-04-11T10:04:00.000Z',
      status: 'succeeded',
      reason_code: 'turn_completed'
    });
    store.completeRun({
      run_id: started.run_id,
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      terminal_status: 'succeeded',
      terminal_reason_code: 'normal_completion'
    });

    const secondRunId = store.startRun({
      issue_id: 'i-terminal-facts',
      issue_identifier: 'ABC-TERMINAL-FACTS',
      identity: durableIdentity,
      started_at: '2026-04-11T10:10:00.000Z'
    });
    const secondAttemptId = store.appendAttempt({
      issue_run_id: started.issue_run_id,
      attempt_number: 1,
      started_at: '2026-04-11T10:10:00.000Z',
      status: 'running',
      reason_code: 'attempt_started'
    });
    nowMs = Date.parse('2026-04-11T10:15:00.000Z');
    store.completeRun({
      run_id: secondRunId,
      issue_run_id: started.issue_run_id,
      attempt_id: secondAttemptId,
      terminal_status: 'succeeded',
      terminal_reason_code: 'handoff_state_reached'
    });

    const db = openDatabase(dbPath);
    try {
      const outcomes = db
        .prepare('SELECT terminal_outcome_id, attempt_id, outcome, reason_code FROM history_ticket_terminal_outcome ORDER BY recorded_at')
        .all() as Array<Record<string, unknown>>;
      expect(outcomes).toEqual([
        expect.objectContaining({
          terminal_outcome_id: `terminal_outcome:${started.attempt_id}`,
          attempt_id: started.attempt_id,
          outcome: 'succeeded',
          reason_code: 'normal_completion'
        }),
        expect.objectContaining({
          terminal_outcome_id: `terminal_outcome:${secondAttemptId}`,
          attempt_id: secondAttemptId,
          outcome: 'succeeded',
          reason_code: 'handoff_state_reached'
        })
      ]);
      const terminalTransitions = db
        .prepare("SELECT state_transition_id, attempt_id, to_status, reason_code FROM state_transition WHERE state_transition_id LIKE 'terminal_transition:%' ORDER BY transitioned_at")
        .all() as Array<Record<string, unknown>>;
      expect(terminalTransitions).toEqual([
        expect.objectContaining({
          state_transition_id: `terminal_transition:${started.attempt_id}`,
          attempt_id: started.attempt_id,
          to_status: 'succeeded',
          reason_code: 'normal_completion'
        }),
        expect.objectContaining({
          state_transition_id: `terminal_transition:${secondAttemptId}`,
          attempt_id: secondAttemptId,
          to_status: 'handoff_reached',
          reason_code: 'handoff_state_reached'
        })
      ]);
    } finally {
      db.close();
    }
  });

  it('does not reopen a terminal issue run when retry append fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-retry-failed-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    let nowMs = Date.parse('2026-04-11T10:00:00.000Z');
    const durableIdentity = identity({ issue_id: 'i-retry-failed', issue_identifier: 'ABC-RETRY-FAIL' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => nowMs });
    stores.push(storeA);
    const started = storeA.recordRunStarted({
      issue_id: 'i-retry-failed',
      issue_identifier: 'ABC-RETRY-FAIL',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running',
      reason_code: 'dispatch_started'
    });
    nowMs = Date.parse('2026-04-11T10:05:00.000Z');
    storeA.completeRun({
      run_id: started.run_id,
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      terminal_status: 'stalled',
      error_code: 'worker_stalled',
      terminal_reason_code: 'worker_stalled',
      terminal_reason_detail: 'stalled before retry'
    });

    expect(() =>
      storeA.appendAttempt({
        issue_run_id: started.issue_run_id,
        attempt_number: 0,
        started_at: '2026-04-11T10:10:00.000Z',
        status: 'running',
        reason_code: 'attempt_started',
        reason_detail: 'duplicate retry attempt'
      })
    ).toThrow(/UNIQUE constraint failed/);
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const timeline = storeB.reconstructTicketTimeline(durableIdentity);

    expect(timeline.issue_runs).toEqual([
      expect.objectContaining({
        issue_run_id: started.issue_run_id,
        ended_at: '2026-04-11T10:05:00.000Z',
        status: 'stalled',
        reason_code: 'worker_stalled'
      })
    ]);
    expect(timeline.attempts).toEqual([
      expect.objectContaining({
        attempt_id: started.attempt_id,
        attempt_number: 0,
        ended_at: '2026-04-11T10:05:00.000Z',
        status: 'stalled',
        reason_code: 'worker_stalled'
      })
    ]);
  });

  it('closes linked normalized rows for succeeded cancelled and timed-out terminals', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-terminals-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    let nowMs = Date.parse('2026-04-11T10:00:00.000Z');
    const terminalStatuses = ['succeeded', 'cancelled', 'timed_out'] as const;

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => nowMs });
    stores.push(storeA);
    const identities = terminalStatuses.map((terminalStatus, index) =>
      identity({ issue_id: `i-${terminalStatus}`, issue_identifier: `ABC-TERM-${index}` })
    );
    const startedRows = terminalStatuses.map((terminalStatus, index) =>
      storeA.recordRunStarted({
        issue_id: `i-${terminalStatus}`,
        issue_identifier: `ABC-TERM-${index}`,
        identity: identities[index],
        started_at: `2026-04-11T10:0${index}:00.000Z`,
        attempt_number: 0,
        status: 'running',
        reason_code: 'dispatch_started'
      })
    );

    for (const [index, terminalStatus] of terminalStatuses.entries()) {
      nowMs = Date.parse(`2026-04-11T10:1${index}:00.000Z`);
      storeA.completeRun({
        run_id: startedRows[index].run_id,
        issue_run_id: startedRows[index].issue_run_id,
        attempt_id: startedRows[index].attempt_id,
        terminal_status: terminalStatus,
        terminal_reason_code: terminalStatus === 'succeeded' ? null : `reason_${terminalStatus}`,
        terminal_reason_detail: terminalStatus === 'succeeded' ? null : `detail ${terminalStatus}`
      });
    }
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    for (const [index, terminalStatus] of terminalStatuses.entries()) {
      const timeline = storeB.reconstructTicketTimeline(identities[index]);
      expect(timeline.issue_runs[0]).toMatchObject({
        issue_run_id: startedRows[index].issue_run_id,
        ended_at: `2026-04-11T10:1${index}:00.000Z`,
        status: terminalStatus,
        reason_code: terminalStatus === 'succeeded' ? null : `reason_${terminalStatus}`
      });
      expect(timeline.attempts[0]).toMatchObject({
        attempt_id: startedRows[index].attempt_id,
        ended_at: `2026-04-11T10:1${index}:00.000Z`,
        status: terminalStatus,
        reason_code: terminalStatus === 'succeeded' ? null : `reason_${terminalStatus}`
      });
    }
  });

  it('persists normalized execution graph lineage across restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const issueRunId = storeA.appendIssueRun({
      issue_id: 'issue-1',
      issue_identifier: 'ABC-1',
      identity: identity(),
      started_at: '2026-04-11T10:00:00.000Z',
      status: 'running',
      reason_code: 'dispatch_started',
      reason_detail: 'initial dispatch'
    });
    const attemptId = storeA.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 0,
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running',
      reason_code: 'attempt_started',
      reason_detail: null
    });
    const threadId = storeA.appendThread({
      attempt_id: attemptId,
      thread_id: 'thread-1',
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running',
      reason_code: 'codex_session_started',
      reason_detail: null
    });
    const turnId = storeA.appendTurn({
      thread_id: threadId,
      turn_index: 0,
      turn_id: 'turn-1',
      started_at: '2026-04-11T10:00:03.000Z',
      ended_at: '2026-04-11T10:04:00.000Z',
      status: 'succeeded',
      reason_code: 'turn_completed',
      reason_detail: 'ok'
    });
    storeA.appendPhaseSpan({
      turn_id: turnId,
      phase: 'planning',
      started_at: '2026-04-11T10:00:04.000Z',
      ended_at: '2026-04-11T10:01:00.000Z',
      status: 'succeeded',
      reason_code: 'phase_completed',
      reason_detail: null
    });
    storeA.appendToolSpan({
      turn_id: turnId,
      tool_name: 'exec_command',
      started_at: '2026-04-11T10:01:10.000Z',
      ended_at: '2026-04-11T10:01:11.000Z',
      status: 'succeeded',
      reason_code: 'tool_completed',
      reason_detail: 'token=abcd1234'
    });
    storeA.appendStateTransition({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      from_status: 'running',
      to_status: 'retrying',
      transitioned_at: '2026-04-11T10:04:01.000Z',
      status: 'retrying',
      reason_code: 'normal_completion',
      reason_detail: 'normal worker completion, continuing while issue is active'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const lineage = storeB.reconstructThreadLineage(threadId);
    const lineageByIssue = storeB.reconstructLatestThreadLineageByIssueIdentifier('ABC-1');

    expect(lineage?.issue_run.issue_run_id).toBe(issueRunId);
    expect(lineage?.attempt.attempt_id).toBe(attemptId);
    expect(lineage?.thread.thread_id).toBe(threadId);
    expect(lineage?.turns).toHaveLength(1);
    expect(lineage?.turns[0].turn_id).toBe(turnId);
    expect(lineage?.turns[0].phase_spans[0]).toMatchObject({ phase: 'planning' });
    expect(lineage?.turns[0].tool_spans[0]).toMatchObject({
      tool_name: 'exec_command',
      reason_detail: 'token=***REDACTED***'
    });
    expect(lineage?.state_transitions).toEqual([
      expect.objectContaining({
        from_status: 'running',
        to_status: 'retrying',
        reason_code: 'normal_completion'
      })
    ]);
    expect(lineageByIssue?.thread.thread_id).toBe(threadId);
    expect(storeB.reconstructLatestThreadLineageByIssueIdentifier('ABC-404')).toBeNull();
  });

  it('reconstructs a ticket timeline across multiple attempts and restart by durable identity', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-ticket-ledger-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-ticket-1', issue_identifier: 'TICKET-1' });
    const renamedIdentity = identity({ issue_id: 'remote-ticket-1', issue_identifier: 'TICKET-99' });
    const reusedHumanIdentifier = identity({ issue_id: 'remote-ticket-2', issue_identifier: 'TICKET-1', trackerScope: 'other-scope' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const issueRunId = storeA.appendIssueRun({
      issue_id: 'remote-ticket-1',
      issue_identifier: 'TICKET-1',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      ended_at: '2026-04-11T10:20:00.000Z',
      status: 'succeeded'
    });
    const attemptZeroId = storeA.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 0,
      started_at: '2026-04-11T10:00:01.000Z',
      ended_at: '2026-04-11T10:05:00.000Z',
      status: 'blocked',
      reason_code: 'missing_tool_output'
    });
    const threadZeroId = storeA.appendThread({
      attempt_id: attemptZeroId,
      thread_id: 'thread-ticket-0',
      started_at: '2026-04-11T10:00:02.000Z',
      ended_at: '2026-04-11T10:05:00.000Z',
      status: 'blocked'
    });
    const turnZeroId = storeA.appendTurn({
      thread_id: threadZeroId,
      turn_id: 'turn-ticket-0',
      turn_index: 0,
      started_at: '2026-04-11T10:00:03.000Z',
      ended_at: '2026-04-11T10:05:00.000Z',
      status: 'blocked'
    });
    storeA.appendPhaseSpan({
      turn_id: turnZeroId,
      phase: 'dispatch',
      started_at: '2026-04-11T10:00:04.000Z',
      ended_at: '2026-04-11T10:01:00.000Z',
      status: 'succeeded',
      reason_code: 'phase_completed'
    });
    storeA.appendTicketBlocker({
      issue_run_id: issueRunId,
      attempt_id: attemptZeroId,
      thread_id: threadZeroId,
      turn_id: turnZeroId,
      blocker_type: 'tool_output',
      status: 'resolved',
      reason_code: 'missing_tool_output',
      reason_detail: 'token=abcd1234',
      blocked_at: '2026-04-11T10:05:00.000Z',
      resolved_at: '2026-04-11T10:10:00.000Z'
    });
    storeA.appendStateTransition({
      issue_run_id: issueRunId,
      attempt_id: attemptZeroId,
      thread_id: threadZeroId,
      turn_id: turnZeroId,
      from_status: 'running',
      to_status: 'blocked',
      transitioned_at: '2026-04-11T10:05:01.000Z',
      status: 'blocked',
      reason_code: 'missing_tool_output'
    });
    const attemptOneId = storeA.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 1,
      started_at: '2026-04-11T10:10:00.000Z',
      ended_at: '2026-04-11T10:20:00.000Z',
      status: 'succeeded',
      reason_code: 'retry_completed'
    });
    const threadOneId = storeA.appendThread({
      attempt_id: attemptOneId,
      thread_id: 'thread-ticket-1',
      started_at: '2026-04-11T10:10:01.000Z',
      ended_at: '2026-04-11T10:20:00.000Z',
      status: 'succeeded'
    });
    const turnOneId = storeA.appendTurn({
      thread_id: threadOneId,
      turn_id: 'turn-ticket-1',
      turn_index: 0,
      started_at: '2026-04-11T10:10:02.000Z',
      ended_at: '2026-04-11T10:20:00.000Z',
      status: 'succeeded'
    });
    storeA.appendPhaseSpan({
      turn_id: turnOneId,
      phase: 'implementation',
      started_at: '2026-04-11T10:10:03.000Z',
      ended_at: '2026-04-11T10:19:00.000Z',
      status: 'succeeded',
      reason_code: 'phase_completed'
    });
    storeA.appendTicketEvidenceReference({
      issue_run_id: issueRunId,
      attempt_id: attemptOneId,
      thread_id: threadOneId,
      turn_id: turnOneId,
      evidence_kind: 'test_output',
      uri: 'file://validation/persistence.txt',
      title: 'persistence restart proof',
      metadata: { command: 'npm test -- tests/persistence/store.test.ts', token: 'abcd1234' },
      recorded_at: '2026-04-11T10:19:30.000Z'
    });
    storeA.appendTicketTerminalOutcome({
      issue_run_id: issueRunId,
      attempt_id: attemptOneId,
      thread_id: threadOneId,
      turn_id: turnOneId,
      outcome: 'succeeded',
      reason_code: 'agent_review_ready',
      reason_detail: 'ticket timeline complete',
      recorded_at: '2026-04-11T10:20:00.000Z'
    });
    storeA.appendIssueRun({
      issue_id: 'remote-ticket-2',
      issue_identifier: 'TICKET-1',
      identity: reusedHumanIdentifier,
      started_at: '2026-04-11T11:00:00.000Z',
      status: 'running'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const timeline = storeB.reconstructTicketTimeline(renamedIdentity);
    const otherTimeline = storeB.reconstructTicketTimeline(reusedHumanIdentifier);

    expect(timeline.issue_runs.map((run) => run.issue_run_id)).toEqual([issueRunId]);
    expect(timeline.issue_runs[0].identity?.ticket.human_issue_identifier).toBe('TICKET-1');
    expect(timeline.attempts.map((attempt) => attempt.attempt_number)).toEqual([0, 1]);
    expect(timeline.threads.map((thread) => thread.thread_id)).toEqual(['thread-ticket-0', 'thread-ticket-1']);
    expect(timeline.phase_spans.map((phase) => phase.phase)).toEqual(['dispatch', 'implementation']);
    expect(timeline.state_transitions).toEqual([expect.objectContaining({ to_status: 'blocked', reason_code: 'missing_tool_output' })]);
    expect(timeline.blockers).toEqual([
      expect.objectContaining({
        blocker_type: 'tool_output',
        status: 'resolved',
        reason_detail: 'token=***REDACTED***'
      })
    ]);
    expect(timeline.evidence_references).toEqual([
      expect.objectContaining({
        evidence_kind: 'test_output',
        title: 'persistence restart proof',
        metadata: { command: 'npm test -- tests/persistence/store.test.ts', token: '***REDACTED***' }
      })
    ]);
    expect(timeline.terminal_outcomes).toEqual([
      expect.objectContaining({ outcome: 'succeeded', reason_code: 'agent_review_ready' })
    ]);
    expect(otherTimeline.issue_runs).toHaveLength(1);
    expect(otherTimeline.attempts).toHaveLength(0);
  });

  it('enforces execution graph references and monotonic timestamps', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-integrity-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);

    const issueRunId = store.appendIssueRun({
      issue_id: 'issue-1',
      issue_identifier: 'ABC-1',
      identity: identity(),
      started_at: '2026-04-11T10:00:00.000Z',
      status: 'running'
    });
    const attemptId = store.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 0,
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running'
    });
    const threadId = store.appendThread({
      attempt_id: attemptId,
      thread_id: 'thread-1',
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running'
    });
    const turnId = store.appendTurn({
      thread_id: threadId,
      turn_index: 0,
      turn_id: 'turn-1',
      started_at: '2026-04-11T10:00:03.000Z',
      status: 'running'
    });
    const secondAttemptId = store.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 1,
      started_at: '2026-04-11T10:00:04.000Z',
      status: 'running'
    });
    const secondThreadId = store.appendThread({
      attempt_id: secondAttemptId,
      thread_id: 'thread-2',
      started_at: '2026-04-11T10:00:05.000Z',
      status: 'running'
    });
    store.appendTurn({
      thread_id: secondThreadId,
      turn_index: 0,
      turn_id: 'turn-2',
      started_at: '2026-04-11T10:00:06.000Z',
      status: 'running'
    });
    const sameAttemptThreadId = store.appendThread({
      attempt_id: attemptId,
      thread_id: 'thread-3',
      started_at: '2026-04-11T10:00:06.500Z',
      status: 'running'
    });
    const sameAttemptTurnId = store.appendTurn({
      thread_id: sameAttemptThreadId,
      turn_index: 0,
      turn_id: 'turn-3',
      started_at: '2026-04-11T10:00:06.600Z',
      status: 'running'
    });

    expect(() =>
      store.appendPhaseSpan({
        turn_id: 'missing-turn',
        phase: 'planning',
        started_at: '2026-04-11T10:00:04.000Z',
        status: 'running'
      })
    ).toThrow(/does not exist/);
    expect(() =>
      store.appendToolSpan({
        turn_id: turnId,
        tool_name: 'exec_command',
        started_at: '2026-04-11T09:59:59.000Z',
        status: 'running'
      })
    ).toThrow(/monotonic/);
    store.appendStateTransition({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      to_status: 'running',
      transitioned_at: '2026-04-11T10:00:07.000Z',
      status: 'running',
      reason_code: 'turn_started'
    });
    expect(() =>
      store.appendStateTransition({
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        thread_id: secondThreadId,
        to_status: 'running',
        transitioned_at: '2026-04-11T10:00:08.000Z',
        status: 'running',
        reason_code: 'lineage_mismatch'
      })
    ).toThrow(/does not belong to attempt/);
    expect(() =>
      store.appendStateTransition({
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        thread_id: threadId,
        turn_id: sameAttemptTurnId,
        to_status: 'running',
        transitioned_at: '2026-04-11T10:00:09.000Z',
        status: 'running',
        reason_code: 'lineage_mismatch'
      })
    ).toThrow(/does not belong to thread/);
    expect(() =>
      store.appendStateTransition({
        issue_run_id: issueRunId,
        to_status: 'failed',
        transitioned_at: '2026-04-11T10:00:03.000Z',
        status: 'failed',
        reason_code: 'out_of_order'
      })
    ).toThrow(/monotonic/);
  });


});
