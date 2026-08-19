import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDurableIdentity,
  createStoreTestHarness,
  fs,
  os,
  path,
  SqlitePersistenceStore
} from './store-test-harness';

describe('SqlitePersistenceStore token facts', () => {
  const { dirs, stores, identity, openDatabase, tableNames, withLegacyProjectKey, cleanup } = createStoreTestHarness();

  afterEach(cleanup);
  it('persists token and effective model facts across restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-token-model-fact-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-token-model-1', issue_identifier: 'TOK-1' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const started = storeA.recordRunStarted({
      issue_id: 'remote-token-model-1',
      issue_identifier: 'TOK-1',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const threadId = storeA.appendThread({
      attempt_id: started.attempt_id,
      thread_id: 'thread-token-model',
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running'
    });
    const turnId = storeA.appendTurn({
      thread_id: threadId,
      turn_id: 'turn-token-model',
      turn_index: 0,
      started_at: '2026-04-11T10:00:03.000Z',
      status: 'running'
    });
    storeA.appendTokenModelFact({
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      thread_id: threadId,
      turn_id: turnId,
      requested_model: 'gpt-requested',
      effective_model: 'gpt-effective',
      model_source: 'thread/tokenUsage/updated.params.tokenUsage.total',
      input_tokens: 10,
      output_tokens: 4,
      cached_input_tokens: 3,
      reasoning_output_tokens: 2,
      total_tokens: 14,
      model_context_window: 128000,
      telemetry_confidence: 'observed_live',
      observed_at: '2026-04-11T10:00:04.000Z'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);

    expect(storeB.reconstructThreadLineage(threadId)?.token_model_facts).toEqual([
      expect.objectContaining({
        issue_run_id: started.issue_run_id,
        attempt_id: started.attempt_id,
        thread_id: threadId,
        turn_id: turnId,
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective',
        model_source: 'thread/tokenUsage/updated.params.tokenUsage.total',
        input_tokens: 10,
        output_tokens: 4,
        cached_input_tokens: 3,
        reasoning_output_tokens: 2,
        total_tokens: 14,
        model_context_window: 128000,
        telemetry_confidence: 'observed_live',
        observed_at: '2026-04-11T10:00:04.000Z'
      })
    ]);
    expect(storeB.reconstructThreadLineage(threadId)?.turns[0]?.token_model_facts).toHaveLength(1);
    expect(storeB.reconstructTicketTimeline(durableIdentity).token_model_facts).toHaveLength(1);
    expect(storeB.listRunHistory().find((run) => run.run_id === started.run_id)?.token_model_facts).toEqual([
      expect.objectContaining({
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective',
        total_tokens: 14
      })
    ]);
  });

  it('scopes run history token model facts to each issue run across repeated ticket runs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-token-model-run-scope-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-token-model-repeat', issue_identifier: 'TOK-REPEAT' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const first = storeA.recordRunStarted({
      issue_id: 'remote-token-model-repeat',
      issue_identifier: 'TOK-REPEAT',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const firstThreadId = storeA.appendThread({
      attempt_id: first.attempt_id,
      thread_id: 'thread-token-model-first',
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running'
    });
    storeA.appendTokenModelFact({
      issue_run_id: first.issue_run_id,
      attempt_id: first.attempt_id,
      thread_id: firstThreadId,
      requested_model: 'gpt-first-requested',
      effective_model: 'gpt-first-effective',
      total_tokens: 11,
      telemetry_confidence: 'observed_live',
      observed_at: '2026-04-11T10:00:02.000Z'
    });

    const second = storeA.recordRunStarted({
      issue_id: 'remote-token-model-repeat',
      issue_identifier: 'TOK-REPEAT',
      identity: durableIdentity,
      started_at: '2026-04-11T11:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const secondThreadId = storeA.appendThread({
      attempt_id: second.attempt_id,
      thread_id: 'thread-token-model-second',
      started_at: '2026-04-11T11:00:01.000Z',
      status: 'running'
    });
    storeA.appendTokenModelFact({
      issue_run_id: second.issue_run_id,
      attempt_id: second.attempt_id,
      thread_id: secondThreadId,
      requested_model: 'gpt-second-requested',
      effective_model: 'gpt-second-effective',
      total_tokens: 22,
      telemetry_confidence: 'observed_live',
      observed_at: '2026-04-11T11:00:02.000Z'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const firstRun = storeB.listRunHistory(10).find((run) => run.run_id === first.run_id);
    const secondRun = storeB.listRunHistory(10).find((run) => run.run_id === second.run_id);

    expect(firstRun?.identity_projection?.issue_run_id).toBe(first.issue_run_id);
    expect(secondRun?.identity_projection?.issue_run_id).toBe(second.issue_run_id);
    expect(firstRun?.token_model_facts).toEqual([
      expect.objectContaining({
        issue_run_id: first.issue_run_id,
        requested_model: 'gpt-first-requested',
        effective_model: 'gpt-first-effective',
        total_tokens: 11
      })
    ]);
    expect(secondRun?.token_model_facts).toEqual([
      expect.objectContaining({
        issue_run_id: second.issue_run_id,
        requested_model: 'gpt-second-requested',
        effective_model: 'gpt-second-effective',
        total_tokens: 22
      })
    ]);
  });

  it('rejects malformed token telemetry without writing a partial fact', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-token-model-invalid-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-token-model-2', issue_identifier: 'TOK-2' });

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const issueRunId = store.appendIssueRun({
      issue_id: 'remote-token-model-2',
      issue_identifier: 'TOK-2',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      status: 'running'
    });

    expect(() =>
      store.appendTokenModelFact({
        issue_run_id: issueRunId,
        input_tokens: -1,
        telemetry_confidence: 'observed_live',
        observed_at: '2026-04-11T10:00:01.000Z'
      })
    ).toThrow('input_tokens must be a non-negative safe integer');
    expect(store.reconstructTicketTimeline(durableIdentity).token_model_facts).toEqual([]);
  });

  it('persists normalized Claude invocation and idempotent component-max step facts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-claude-provider-facts-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-claude-usage', issue_identifier: 'TOK-CLAUDE' });
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const started = store.recordRunStarted({
      issue_id: durableIdentity.ticket.remote_issue_id,
      issue_identifier: durableIdentity.ticket.human_issue_identifier,
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const threadId = store.appendThread({
      attempt_id: started.attempt_id,
      thread_id: 'claude:session-1',
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running'
    });
    const turnId = store.appendTurn({
      thread_id: threadId,
      turn_id: 'claude-turn-1',
      turn_index: 0,
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running'
    });
    const messageHash = 'a'.repeat(64);
    store.appendProviderUsageStepFact({
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      thread_id: threadId,
      turn_id: turnId,
      message_id_hash: messageHash,
      model: 'claude-sonnet-4-6',
      input_tokens: 4,
      output_tokens: 1,
      cache_read_tokens: 2,
      cache_creation_tokens: 0,
      observed_at: '2026-04-11T10:00:03.000Z'
    });
    store.appendProviderUsageStepFact({
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      thread_id: threadId,
      turn_id: turnId,
      message_id_hash: messageHash,
      model: 'claude-sonnet-4-6',
      input_tokens: 4,
      output_tokens: 3,
      cache_read_tokens: 2,
      cache_creation_tokens: 1,
      observed_at: '2026-04-11T10:00:04.000Z'
    });
    store.appendTokenModelFact({
      token_model_fact_id: 'claude-invocation-1',
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      thread_id: threadId,
      turn_id: turnId,
      requested_model: 'claude-sonnet-4-6',
      effective_model: null,
      model_source: 'claude_assistant_step',
      input_tokens: 4,
      output_tokens: 1,
      cached_input_tokens: 2,
      cache_creation_input_tokens: 0,
      total_tokens: null,
      provider_turn_count: 1,
      estimated_cost_usd: null,
      provider_usage_status: 'partial',
      provider_usage_source: 'claude_assistant_step',
      api_retry_count: 0,
      telemetry_confidence: 'provider_step',
      observed_at: '2026-04-11T10:00:04.000Z'
    });
    store.appendTokenModelFact({
      token_model_fact_id: 'claude-invocation-1',
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      thread_id: threadId,
      turn_id: turnId,
      requested_model: 'claude-sonnet-4-6',
      effective_model: 'claude-sonnet-4-6',
      runtime_provider: 'claude-cli',
      input_tokens: 10,
      output_tokens: 4,
      cached_input_tokens: 2,
      cache_creation_input_tokens: 1,
      total_tokens: null,
      provider_turn_count: 2,
      estimated_cost_usd: 0.0123,
      provider_usage_status: 'final',
      provider_usage_source: 'claude_stream_result',
      api_retry_count: 1,
      effective_models: ['claude-sonnet-4-6'],
      tool_counts: { Read: 1 },
      mcp_counts: { 'linear-server': 1 },
      reconciliation_delta: { output_tokens: 0 },
      model_usage: [{ model: 'claude-sonnet-4-6', input_tokens: 10, output_tokens: 4 }],
      telemetry_confidence: 'provider_result',
      observed_at: '2026-04-11T10:00:05.000Z'
    });

    const fact = store.reconstructThreadLineage(threadId)?.token_model_facts?.[0];
    expect(fact).toMatchObject({
      runtime_provider: 'claude-cli',
      effective_model: 'claude-sonnet-4-6',
      model_source: null,
      total_tokens: null,
      cache_creation_input_tokens: 1,
      provider_usage_status: 'final',
      provider_usage_source: 'claude_stream_result',
      telemetry_confidence: 'provider_result',
      effective_models: ['claude-sonnet-4-6'],
      tool_counts: { Read: 1 },
      mcp_counts: { 'linear-server': 1 }
    });
    expect(store.reconstructThreadLineage(threadId)?.token_model_facts).toHaveLength(1);
    const db = openDatabase(dbPath);
    try {
      expect(
        db.prepare('SELECT * FROM history_provider_usage_step_fact WHERE turn_id = ?').all(turnId)
      ).toEqual([
        expect.objectContaining({
          message_id_hash: messageHash,
          input_tokens: 4,
          output_tokens: 3,
          cache_read_tokens: 2,
          cache_creation_tokens: 1,
          runtime_provider: 'claude-cli'
        })
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps completed multi-model usage durable and leaves provider turns explicitly unallocated', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-claude-provider-totals-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-claude-totals', issue_identifier: 'TOK-TOTALS' });
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const started = store.recordRunStarted({
      issue_id: durableIdentity.ticket.remote_issue_id,
      issue_identifier: durableIdentity.ticket.human_issue_identifier,
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const threadId = store.appendThread({
      attempt_id: started.attempt_id,
      thread_id: 'claude:totals-session',
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running'
    });
    const turnId = store.appendTurn({
      thread_id: threadId,
      turn_id: 'claude-totals-turn',
      turn_index: 0,
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running'
    });
    store.appendTokenModelFact({
      token_model_fact_id: 'claude-totals-invocation',
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      thread_id: threadId,
      turn_id: turnId,
      requested_model: 'claude-sonnet-4-6',
      effective_model: 'claude-sonnet-4-6',
      runtime_provider: 'claude-cli',
      provider_turn_count: 3,
      provider_usage_status: 'final',
      provider_usage_source: 'claude_stream_result',
      telemetry_confidence: 'provider_result',
      observed_at: '2026-04-11T10:00:03.000Z'
    });
    for (const [model, input, output, cost] of [
      ['claude-sonnet-4-6', 10, 4, 0.01],
      ['claude-opus-4-1', 3, 2, 0.02]
    ] as const) {
      store.appendTokenModelFact({
        token_model_fact_id: `claude-totals-model-${model}`,
        issue_run_id: started.issue_run_id,
        attempt_id: started.attempt_id,
        thread_id: threadId,
        turn_id: turnId,
        requested_model: 'claude-sonnet-4-6',
        effective_model: model,
        model_source: 'claude_model_usage',
        runtime_provider: 'claude-cli',
        input_tokens: input,
        output_tokens: output,
        estimated_cost_usd: cost,
        provider_usage_status: 'final',
        provider_usage_source: 'claude_model_usage',
        telemetry_confidence: 'provider_result',
        observed_at: '2026-04-11T10:00:03.000Z'
      });
    }
    store.completeRun({
      run_id: started.run_id,
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      terminal_status: 'succeeded'
    });

    const activeRepeat = store.recordRunStarted({
      issue_id: durableIdentity.ticket.remote_issue_id,
      issue_identifier: durableIdentity.ticket.human_issue_identifier,
      identity: durableIdentity,
      started_at: '2026-04-11T11:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });

    const completedTotals = [
      expect.objectContaining({ effective_model: null, provider_turn_count: 3, input_tokens: null }),
      expect.objectContaining({ effective_model: 'claude-opus-4-1', input_tokens: 3, output_tokens: 2, provider_turn_count: null }),
      expect.objectContaining({ effective_model: 'claude-sonnet-4-6', input_tokens: 10, output_tokens: 4, provider_turn_count: null })
    ];
    expect(store.listCompletedProviderUsageTotals()).toEqual(completedTotals);
    expect(store.listCompletedProviderUsageTotals([activeRepeat.issue_run_id])).toEqual(completedTotals);
    expect(store.listCompletedProviderUsageTotals([started.issue_run_id])).toEqual([]);
  });

  it('counts unobserved provider invocations separately from partial and missing telemetry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-claude-provider-coverage-'));
    dirs.push(dir);
    const store = new SqlitePersistenceStore({ dbPath: path.join(dir, 'runtime.sqlite'), retentionDays: 14 });
    stores.push(store);
    const durableIdentity = identity({ issue_id: 'remote-claude-coverage', issue_identifier: 'TOK-COVERAGE' });
    const started = store.recordRunStarted({
      issue_id: durableIdentity.ticket.remote_issue_id,
      issue_identifier: durableIdentity.ticket.human_issue_identifier,
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const threadId = store.appendThread({
      attempt_id: started.attempt_id,
      thread_id: 'claude:coverage-session',
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running'
    });
    for (const [index, status, input] of [
      [0, 'final', 12],
      [1, 'unobserved', null]
    ] as const) {
      const turnId = store.appendTurn({
        thread_id: threadId,
        turn_id: `claude-coverage-turn-${index}`,
        turn_index: index,
        started_at: `2026-04-11T10:00:0${index + 2}.000Z`,
        status: index === 0 ? 'succeeded' : 'failed'
      });
      store.appendTokenModelFact({
        token_model_fact_id: `claude-coverage-invocation-${index}`,
        issue_run_id: started.issue_run_id,
        attempt_id: started.attempt_id,
        thread_id: threadId,
        turn_id: turnId,
        requested_model: 'claude-sonnet-4-6',
        effective_model: 'claude-sonnet-4-6',
        runtime_provider: 'claude-cli',
        input_tokens: input,
        provider_usage_status: status,
        provider_usage_source: status === 'final' ? 'claude_stream_result' : 'claude_invocation',
        missing_reason: status === 'unobserved' ? 'process_closed_without_usage' : null,
        telemetry_confidence: status === 'final' ? 'provider_result' : 'missing',
        observed_at: `2026-04-11T10:00:1${index}.000Z`
      });
    }
    store.completeRun({
      run_id: started.run_id,
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      terminal_status: 'failed'
    });

    expect(store.listCompletedProviderUsageTotals()).toEqual([
      expect.objectContaining({
        effective_model: null,
        invocation_count: 2,
        final_invocation_count: 1,
        partial_invocation_count: 0,
        unobserved_invocation_count: 1,
        missing_invocation_count: 0,
        input_tokens: null
      }),
      expect.objectContaining({
        effective_model: 'claude-sonnet-4-6',
        invocation_count: 0,
        final_invocation_count: 0,
        unobserved_invocation_count: 0,
        input_tokens: 12
      })
    ]);
  });


});
