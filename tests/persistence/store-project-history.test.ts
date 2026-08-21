import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDurableIdentity,
  createStoreTestHarness,
  fs,
  os,
  path,
  SqlitePersistenceStore
} from './store-test-harness';

describe('SqlitePersistenceStore project history', () => {
  const { dirs, stores, identity, openDatabase, tableNames, withLegacyProjectKey, cleanup } = createStoreTestHarness();

  afterEach(cleanup);

  it('persists drain mode audit history across restart with project and ticket projections', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-drain-audit-history-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-drain-1', issue_identifier: 'DRAIN-1' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const issueRunId = storeA.appendIssueRun({
      issue_id: 'remote-drain-1',
      issue_identifier: 'DRAIN-1',
      identity: durableIdentity,
      started_at: '2026-05-21T10:00:00.000Z',
      status: 'running'
    });

    (storeA as any).appendDrainAuditHistory({
      project_identity: durableIdentity.project,
      event_type: 'drain-entered',
      actor: 'operator',
      source: 'api',
      result: 'accepted',
      result_code: 'drain_mode_entered',
      state_context: { drain_active: true, transcript: 'should be redacted' },
      blocker_summaries: [],
      occurred_at: '2026-05-21T10:01:00.000Z',
      observed_at: '2026-05-21T10:01:00.000Z'
    });
    (storeA as any).appendDrainAuditHistory({
      project_identity: durableIdentity.project,
      issue_run_id: issueRunId,
      event_type: 'wait-timed-out',
      actor: 'operator',
      source: 'api',
      result: 'rejected',
      result_code: 'timeout',
      state_context: { safe_to_shutdown: false, blocker_count: 1 },
      blocker_summaries: [
        {
          category: 'active_worker',
          count: 1,
          issue_identifiers: ['DRAIN-1'],
          run_identifiers: [issueRunId, 'thread-drain-1'],
          detail: 'DRAIN-1 is still running token=secret'
        }
      ],
      occurred_at: '2026-05-21T10:02:00.000Z',
      observed_at: '2026-05-21T10:02:00.000Z'
    });
    (storeA as any).appendDrainAuditHistory({
      project_identity: durableIdentity.project,
      event_type: 'safe-shutdown-refused',
      actor: 'operator',
      source: 'api',
      result: 'rejected',
      result_code: 'blockers_present',
      state_context: { safe_to_shutdown: false },
      blocker_summaries: [{ category: 'active_worker', count: 1, issue_identifiers: ['DRAIN-1'] }],
      occurred_at: '2026-05-21T10:03:00.000Z',
      observed_at: '2026-05-21T10:03:00.000Z'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const projectAudit = (storeB as any).listProjectDrainAuditEvents(durableIdentity.project.key, { limit: 10 });
    const timeline = storeB.reconstructTicketTimeline(durableIdentity);

    expect(projectAudit.items.map((entry: any) => entry.event_type)).toEqual([
      'safe-shutdown-refused',
      'wait-timed-out',
      'drain-entered'
    ]);
    expect(projectAudit.items[1]).toMatchObject({
      project_key: durableIdentity.project.key,
      ticket_key: durableIdentity.ticket.key,
      issue_run_id: issueRunId,
      actor: 'operator',
      source: 'api',
      result: 'rejected',
      result_code: 'timeout',
      blocker_summaries: [
        {
          category: 'active_worker',
          count: 1,
          issue_identifiers: ['DRAIN-1'],
          run_identifiers: [issueRunId, 'thread-drain-1']
        }
      ]
    });
    expect(JSON.stringify(projectAudit.items)).not.toContain('should be redacted');
    expect(JSON.stringify(projectAudit.items)).not.toContain('token=secret');
    expect(timeline.drain_audit_events.map((entry: any) => entry.event_type)).toEqual([
      'wait-timed-out',
      'safe-shutdown-refused'
    ]);
  });

  it('persists runtime update audit events across restart with project history projection', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-runtime-update-audit-history-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-update-1', issue_identifier: 'UPDATE-1' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const issueRunId = storeA.appendIssueRun({
      issue_id: 'remote-update-1',
      issue_identifier: 'UPDATE-1',
      identity: durableIdentity,
      started_at: '2026-05-21T10:00:00.000Z',
      status: 'running'
    });

    for (const [index, eventType] of [
      'update-detected',
      'update-pull-started',
      'update-build-succeeded',
      'update-manual-restart-required'
    ].entries()) {
      (storeA as any).appendDrainAuditHistory({
        project_identity: durableIdentity.project,
        issue_run_id: issueRunId,
        event_type: eventType,
        actor: 'operator',
        source: 'runtime_update',
        result: 'accepted',
        result_code: eventType,
        state_context: { command_output: `line ${index}`, secret: 'should be redacted' },
        blocker_summaries: [],
        occurred_at: `2026-05-21T10:0${index + 1}:00.000Z`,
        observed_at: `2026-05-21T10:0${index + 1}:00.000Z`
      });
    }
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const projectAudit = (storeB as any).listProjectDrainAuditEvents(durableIdentity.project.key, { limit: 10 });
    const timeline = storeB.reconstructTicketTimeline(durableIdentity);

    expect(projectAudit.items.map((entry: any) => entry.event_type)).toEqual([
      'update-manual-restart-required',
      'update-build-succeeded',
      'update-pull-started',
      'update-detected'
    ]);
    expect(timeline.drain_audit_events.map((entry: any) => entry.event_type)).toEqual([
      'update-detected',
      'update-pull-started',
      'update-build-succeeded',
      'update-manual-restart-required'
    ]);
    expect(JSON.stringify(projectAudit.items)).not.toContain('should be redacted');
  });

  it('persists operational tracker facts, references, and operator actions across restart with duplicate coalescing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-operational-history-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-operational-1', issue_identifier: 'OPS-1' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const issueRunId = storeA.appendIssueRun({
      issue_id: 'remote-operational-1',
      issue_identifier: 'OPS-1',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      status: 'running'
    });
    const attemptId = storeA.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 0,
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running'
    });
    const threadId = storeA.appendThread({
      attempt_id: attemptId,
      thread_id: 'thread-ops',
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running'
    });
    const turnId = storeA.appendTurn({
      thread_id: threadId,
      turn_id: 'turn-ops',
      turn_index: 0,
      started_at: '2026-04-11T10:00:03.000Z',
      status: 'running'
    });

    storeA.appendTrackerTicketSnapshot({
      identity: durableIdentity,
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      tracker_kind: 'linear',
      remote_issue_id: 'remote-operational-1',
      human_issue_identifier: 'OPS-1',
      title: 'Record tracker facts token=secret',
      tracker_status: 'In Progress',
      labels: ['ready-for-agent', 'history'],
      assignee_status: 'unknown',
      assignee_reason: 'tracker_assignee_unobserved',
      project_status: 'available',
      project_identifier: 'symphony',
      team_status: 'unavailable',
      team_reason: 'tracker_team_unavailable',
      observed_at: '2026-04-11T10:00:04.000Z'
    });
    storeA.appendTrackerTicketSnapshot({
      identity: durableIdentity,
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      tracker_kind: 'linear',
      remote_issue_id: 'remote-operational-1',
      human_issue_identifier: 'OPS-1',
      title: 'Record tracker facts token=secret',
      tracker_status: 'In Progress',
      labels: ['history', 'ready-for-agent'],
      assignee_status: 'unknown',
      assignee_reason: 'tracker_assignee_unobserved',
      project_status: 'available',
      project_identifier: 'symphony',
      team_status: 'unavailable',
      team_reason: 'tracker_team_unavailable',
      observed_at: '2026-04-11T10:01:04.000Z'
    });
    storeA.appendTicketReference({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      reference_kind: 'pull_request',
      availability: 'available',
      uri: 'https://github.com/nielsgl/symphony/pull/242',
      label: 'PR #242',
      external_id: '242',
      state: 'open',
      metadata: { review_state: 'pending', token: 'abcd1234' },
      observed_at: '2026-04-11T10:02:00.000Z'
    });
    storeA.appendTicketReference({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      reference_kind: 'review',
      availability: 'unknown',
      metadata: { reason: 'review_state_unobserved' },
      observed_at: '2026-04-11T10:02:01.000Z'
    });
    storeA.appendOperatorActionHistory({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      action: 'submit_input',
      actor: 'operator',
      result: 'accepted',
      result_code: 'native_applied',
      message: 'operator answer accepted',
      reason_note: 'continue after clarification token=abcd1234',
      phase: 'implementation',
      state_context: { pre_state: 'blocked', post_state: 'running', token: 'abcd1234' },
      requested_at: '2026-04-11T10:03:00.000Z',
      observed_at: '2026-04-11T10:03:01.000Z'
    });
    storeA.appendBlockedInputEvent({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      issue_id: 'remote-operational-1',
      issue_identifier: 'OPS-1',
      phase: 'implementation',
      runtime_state: 'blocked',
      reason_code: 'operator_input_required',
      reason_detail: 'Need operator answer token=abcd1234',
      request_id: 'request-1',
      request_method: 'input/request',
      input_schema_type: 'options',
      prompt_text: 'Choose deployment mode token=abcd1234',
      pending_input: {
        request_id: 'request-1',
        questions: [{ id: 'mode', prompt: 'Mode?', options: [{ label: 'Fast', value: 'fast' }] }],
        token: 'abcd1234'
      },
      state_context: {
        branch_name: 'feature/OPS-1',
        previous_session_id: 'session-1',
        token: 'abcd1234'
      },
      blocked_at: '2026-04-11T10:03:10.000Z'
    });
    storeA.appendAppServerEvent({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      observed_at: '2026-04-11T10:03:30.000Z',
      source_event_id: 'event-token-1',
      source_event_name: 'thread/tokenUsage/updated',
      payload_class: 'protocol_lifecycle',
      raw_payload: { token: 'abcd1234', total_tokens: 10 },
      summary: 'token update',
      summary_fields: { total_tokens: 10 }
    });
    const otherIdentity = identity({ issue_id: 'remote-operational-2', issue_identifier: 'OPS-2' });
    storeA.appendIssueRun({
      issue_id: 'remote-operational-2',
      issue_identifier: 'OPS-2',
      identity: otherIdentity,
      started_at: '2026-04-11T11:00:00.000Z',
      status: 'running'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const timeline = storeB.reconstructTicketTimeline(durableIdentity);
    const firstProjectPage = storeB.listProjectTicketIdentities(durableIdentity.project.key, { limit: 1 });
    const secondProjectPage = storeB.listProjectTicketIdentities(durableIdentity.project.key, { limit: 1, offset: 1 });
    const firstSummaryPage = storeB.listProjectTicketSummaries(durableIdentity.project.key, { limit: 1 });
    const secondSummaryPage = storeB.listProjectTicketSummaries(durableIdentity.project.key, { limit: 1, offset: 1 });

    expect(firstProjectPage).toMatchObject({
      limit: 1,
      offset: 0,
      has_more: true,
      total: 2
    });
    expect(firstProjectPage.items[0].ticket.human_issue_identifier).toBe('OPS-2');
    expect(secondProjectPage.items[0].ticket.human_issue_identifier).toBe('OPS-1');
    expect(firstSummaryPage).toMatchObject({
      limit: 1,
      offset: 0,
      has_more: true,
      total: 2
    });
    expect(firstSummaryPage.items[0].identity.ticket.human_issue_identifier).toBe('OPS-2');
    expect(secondSummaryPage.items[0]).toMatchObject({
      identity: durableIdentity,
      state: 'active',
      current_status: 'In Progress',
      summary: {
        issue_run_count: 1,
        attempt_count: 1,
        thread_count: 1,
        turn_count: 1,
        tracker_snapshot_count: 1,
        ticket_reference_count: 2,
        operator_action_count: 1,
        blocked_input_event_count: 1,
        app_server_event_count: 1
      },
      app_server_lite: {
        redacted_event_count: 1,
        truncated_event_count: 0,
        summary_only_event_count: 0
      },
      latest_observed_at: '2026-04-11T10:03:30.000Z'
    });
    expect(storeB.getProjectTicketIdentity(durableIdentity.project.key, durableIdentity.ticket.key)).toEqual(durableIdentity);
    expect(timeline.tracker_snapshots).toEqual([
      expect.objectContaining({
        project_key: durableIdentity.project.key,
        ticket_key: durableIdentity.ticket.key,
        issue_run_id: issueRunId,
        labels: ['history', 'ready-for-agent'],
        title: 'Record tracker facts token=***REDACTED***',
        assignee_status: 'unknown',
        project_identifier: 'symphony',
        duplicate_count: 2,
        observed_at: '2026-04-11T10:00:04.000Z',
        last_observed_at: '2026-04-11T10:01:04.000Z'
      })
    ]);
    expect(timeline.ticket_references).toEqual([
      expect.objectContaining({
        reference_kind: 'pull_request',
        availability: 'available',
        uri: 'https://github.com/nielsgl/symphony/pull/242',
        metadata: { review_state: 'pending', token: '***REDACTED***' }
      }),
      expect.objectContaining({
        reference_kind: 'review',
        availability: 'unknown',
        metadata: { reason: 'review_state_unobserved' }
      })
    ]);
    expect(timeline.operator_actions).toEqual([
      expect.objectContaining({
        action: 'submit_input',
        result: 'accepted',
        reason_note: 'continue after clarification token=***REDACTED***',
        phase: 'implementation',
        state_context: { pre_state: 'blocked', post_state: 'running', token: '***REDACTED***' }
      })
    ]);
    expect(timeline.blocked_input_events).toEqual([
      expect.objectContaining({
        issue_id: 'remote-operational-1',
        issue_identifier: 'OPS-1',
        phase: 'implementation',
        runtime_state: 'blocked',
        reason_code: 'operator_input_required',
        reason_detail: 'Need operator answer token=***REDACTED***',
        request_id: 'request-1',
        request_method: 'input/request',
        input_schema_type: 'options',
        prompt_text: 'Choose deployment mode token=***REDACTED***',
        pending_input: expect.objectContaining({ request_id: 'request-1', token: '***REDACTED***' }),
        state_context: expect.objectContaining({ branch_name: 'feature/OPS-1', token: '***REDACTED***' })
      })
    ]);
    expect(timeline.app_server_events).toEqual([
      expect.objectContaining({
        source_event_name: 'thread/tokenUsage/updated',
        summary_fields: { total_tokens: 10 },
        redacted_excerpt: expect.stringContaining('***REDACTED***')
      })
    ]);
  });

  it('retains failed history writes while clearing active degradation after clean restart reconciliation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-write-failure-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      nowMs: () => Date.parse('2026-04-11T10:00:00.000Z')
    });
    stores.push(storeA);
    storeA.recordHistoryWriteFailure({
      operation: 'appendTurn',
      reason_code: 'history_turn_write_failed',
      detail: 'database locked token=secret-value'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      nowMs: () => Date.parse('2026-04-11T10:05:00.000Z')
    });
    stores.push(storeB);

    expect(storeB.historySchemaHealth()).toMatchObject({
      status: 'degraded',
      degraded_reason_code: 'history_write_failed',
      degraded_detail: 'appendTurn: history_turn_write_failed'
    });
    expect(storeB.health()).toMatchObject({
      integrity_ok: false,
      history_schema: expect.objectContaining({
        status: 'degraded',
        degraded_reason_code: 'history_write_failed'
      })
    });
    expect(storeB.listHistoryWriteFailures()).toEqual([
      {
        operation: 'appendTurn',
        reason_code: 'history_turn_write_failed',
        detail: 'database locked token=***REDACTED***',
        recorded_at: '2026-04-11T10:00:00.000Z'
      }
    ]);
    expect(storeB.reconcileExecutionGraphAfterRestart()).toEqual({ recovered: 0, ambiguous: 0 });
    expect(storeB.historySchemaHealth()).toMatchObject({ status: 'healthy', degraded_reason_code: null });
    expect(storeB.health().recent_write_failures).toEqual([]);
    expect(storeB.listHistoryWriteFailures()).toHaveLength(1);
  });

  it('restores write-failure diagnostics for already-applied history schemas', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-write-failure-upgrade-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      nowMs: () => Date.parse('2026-04-11T10:00:00.000Z')
    });
    stores.push(storeA);
    expect(storeA.historySchemaHealth()).toMatchObject({ applied_version: 15, status: 'healthy' });
    storeA.close();
    stores.pop();

    const db = openDatabase(dbPath);
    try {
      db.exec('DROP TABLE history_write_failure;');
    } finally {
      db.close();
    }

    const storeB = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      nowMs: () => Date.parse('2026-04-11T10:05:00.000Z')
    });
    stores.push(storeB);

    storeB.recordHistoryWriteFailure({
      operation: 'appendTicketTerminalOutcome',
      reason_code: 'history_terminal_outcome_write_failed',
      detail: 'no such table before idempotent ensure'
    });

    expect(storeB.historySchemaHealth()).toMatchObject({
      applied_version: 15,
      status: 'degraded',
      degraded_reason_code: 'history_write_failed',
      degraded_detail: 'appendTicketTerminalOutcome: history_terminal_outcome_write_failed'
    });
    expect(storeB.listHistoryWriteFailures()).toEqual([
      expect.objectContaining({
        operation: 'appendTicketTerminalOutcome',
        reason_code: 'history_terminal_outcome_write_failed',
        detail: 'no such table before idempotent ensure',
        recorded_at: '2026-04-11T10:05:00.000Z'
      })
    ]);
  });

  it('uses an explicit transaction for run start history facts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-run-start-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const durableIdentity = identity({ issue_id: 'run-start-1', issue_identifier: 'RUN-START-1' });

    const started = store.recordRunStarted({
      issue_id: 'run-start-1',
      issue_identifier: 'RUN-START-1',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running',
      reason_code: 'dispatch_started',
      reason_detail: 'worker spawned'
    });
    expect(() =>
      store.recordRunStarted({
        issue_id: 'run-start-1',
        issue_identifier: 'RUN-START-1',
        identity: durableIdentity,
        started_at: '2026-04-11T10:00:00.000Z',
        attempt_number: 0,
        status: 'running',
        reason_code: 'dispatch_started',
        reason_detail: 'duplicate'
      })
    ).toThrow();

    const reopened = store.reconstructTicketTimeline(durableIdentity);
    expect(reopened.issue_runs.map((run) => run.issue_run_id)).toEqual([started.issue_run_id]);
    expect(reopened.attempts.map((attempt) => attempt.attempt_id)).toEqual([started.attempt_id]);
    expect(store.listRunHistory().filter((run) => run.issue_id === 'run-start-1')).toHaveLength(1);
  });

  it('projects outcomes only from the latest issue run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-latest-run-'));
    dirs.push(dir);
    const store = new SqlitePersistenceStore({ dbPath: path.join(dir, 'runtime.sqlite'), retentionDays: 14 });
    stores.push(store);
    const durableIdentity = identity({ issue_id: 'latest-run-1', issue_identifier: 'LATEST-1' });
    const completed = store.recordRunStarted({
      issue_id: 'latest-run-1',
      issue_identifier: 'LATEST-1',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    store.completeRun({
      run_id: completed.run_id,
      issue_run_id: completed.issue_run_id,
      attempt_id: completed.attempt_id,
      terminal_status: 'succeeded'
    });
    const active = store.recordRunStarted({
      issue_id: 'latest-run-1',
      issue_identifier: 'LATEST-1',
      identity: durableIdentity,
      started_at: '2026-04-11T11:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });

    expect(store.listProjectTicketSummaries(durableIdentity.project.key).items[0]).toMatchObject({
      state: 'active',
      latest_attempt: {
        attempt_id: active.attempt_id,
        status: 'running',
        outcome: null,
        outcome_reason_code: null
      }
    });
  });


});
