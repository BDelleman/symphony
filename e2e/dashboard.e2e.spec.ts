import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';

type DashboardStatePayload = {
  generated_at: string;
  snapshot_generated_at_ms?: number;
  snapshot_age_ms?: number;
  snapshot_freshness_state?: string;
  api_degraded_mode?: boolean;
  api_degraded_reason_code?: string | null;
  api_degraded_routes?: string[];
  counts: {
    running: number;
    retrying: number;
    blocked: number;
    stopped: number;
    running_stalled_waiting_count: number;
    running_awaiting_input_count: number;
  };
  codex_totals: {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    seconds_running: number;
  };
  provider_totals?: Array<Record<string, unknown>>;
  rate_limits: Record<string, unknown> | null;
  throughput: {
    windows: Array<Record<string, unknown>>;
    generated_at: string;
  } | null;
  running: Array<Record<string, unknown>>;
  retrying: Array<Record<string, unknown>>;
  blocked: Array<Record<string, unknown>>;
  stopped_runs: Array<Record<string, unknown>>;
  recent_runtime_events: Array<Record<string, unknown>>;
  health: Record<string, unknown>;
};

type IssuePayload = Record<string, unknown>;

const ISO_NOW = '2026-04-30T10:00:00.000Z';
const ISO_OLD = '2026-04-30T09:58:00.000Z';

function baseState(overrides: Partial<DashboardStatePayload> = {}): DashboardStatePayload {
  return {
    generated_at: ISO_NOW,
    snapshot_generated_at_ms: Date.parse(ISO_NOW),
    snapshot_age_ms: 0,
    snapshot_freshness_state: 'fresh',
    api_degraded_mode: false,
    api_degraded_reason_code: null,
    api_degraded_routes: [],
    counts: {
      running: 0,
      retrying: 0,
      blocked: 0,
      stopped: 0,
      running_stalled_waiting_count: 0,
      running_awaiting_input_count: 0
    },
    codex_totals: {
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      seconds_running: 0
    },
    rate_limits: null,
    throughput: {
      windows: [],
      generated_at: ISO_NOW
    },
    running: [],
    retrying: [],
    blocked: [],
    stopped_runs: [],
    recent_runtime_events: [],
    health: {
      dispatch_validation: 'ok',
      last_error: null
    },
    ...overrides
  };
}

async function installDashboardApiMocks(
  page: Parameters<typeof test>[0]['page'],
  options: {
    state: DashboardStatePayload | (() => DashboardStatePayload);
    issues?: Record<string, IssuePayload | ((id: string) => IssuePayload)>;
    diagnostics?: Record<string, IssuePayload | ((id: string) => IssuePayload)>;
    runHistory?: Record<string, unknown>;
    projectHistory?: {
      list?: Record<string, unknown>;
      details?: Record<string, Record<string, unknown>>;
      listStatus?: number;
      onDetailLoad?: (ticketKey: string) => void;
    };
    onInputSubmit?: (issueIdentifier: string, payload: Record<string, unknown>) => void;
    onRefresh?: () => void;
  }
): Promise<void> {
  await page.route('**/api/v1/state**', async (route) => {
    const payload = typeof options.state === 'function' ? options.state() : options.state;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload)
    });
  });

  await page.route('**/api/v1/diagnostics**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        logging: { sink: 'stdout' },
        persistence: { integrity_ok: true },
        runtime_resolution: { workspace_root: '/tmp/symphony' },
        phase_markers: { enabled: true, timeline_limit: 30, last_emit_error_code: null }
      })
    });
  });

  await page.route('**/api/v1/history?limit=8', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(options.runHistory ?? { runs: [] })
    });
  });

  await page.route('**/api/v1/stopped-runs/recovery', async (route) => {
    const payload = typeof options.state === 'function' ? options.state() : options.state;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        stopped_runs: payload.stopped_runs ?? [],
        counts: {
          stopped: payload.counts.stopped
        }
      })
    });
  });

  await page.route('**/api/v1/projects/*/history/tickets?limit=50', async (route) => {
    if (!options.projectHistory?.list) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'project_history_unavailable', message: 'Project history unavailable' } })
      });
      return;
    }
    await route.fulfill({
      status: options.projectHistory.listStatus ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(options.projectHistory.list)
    });
  });

  await page.route('**/api/v1/projects/*/history/health', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        options.projectHistory?.list?.health ?? {
          status: 'disabled',
          enabled: false,
          storage: { type: 'disabled', target: null },
          schema: { status: 'unavailable', integrity_ok: false, target_version: null, applied_version: null, reason_code: null, detail: null },
          counts: { runs: 0, tickets: null },
          retention: { retention_days: null, last_prune: { status: 'never_run', last_pruned_at: null, failure_at: null, failure_reason_code: null, failure_detail: null } },
          writes: { status: 'healthy', recent_failures: [] },
          projections: { status: 'unavailable', reason_code: 'project_history_projection_unavailable', detail: null },
          app_server_lite: { status: 'missing', redacted_event_count: 0, truncated_event_count: 0, unavailable_event_count: 0, full_payload_stored_count: 0 },
          diagnostics: []
        }
      )
    });
  });

  await page.route('**/api/v1/projects/*/history/tickets/*', async (route) => {
    const ticketKey = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) || '');
    options.projectHistory?.onDetailLoad?.(ticketKey);
    const payload = options.projectHistory?.details?.[ticketKey];
    if (!payload) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'project_history_ticket_not_found', message: 'Ticket not found' } })
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.route('**/api/v1/ui-state', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ saved: true }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: null }) });
  });

  await page.route('**/api/v1/refresh', async (route) => {
    options.onRefresh?.();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ queued: true, coalesced: false })
    });
  });

  await page.route('**/api/v1/events**', async (route) => {
    await route.abort();
  });

  await page.route('**/api/v1/issues/*/resume', async (route) => {
    const segments = route.request().url().split('/');
    const issueIdentifier = decodeURIComponent(segments[segments.length - 2] || 'UNKNOWN');
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ issue_identifier: issueIdentifier })
    });
  });

  await page.route('**/api/v1/issues/*/cancel', async (route) => {
    const segments = route.request().url().split('/');
    const issueIdentifier = decodeURIComponent(segments[segments.length - 2] || 'UNKNOWN');
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ issue_identifier: issueIdentifier, moved_to_state: 'Backlog' })
    });
  });

  await page.route('**/api/v1/issues/*/input', async (route) => {
    const segments = route.request().url().split('/');
    const issueIdentifier = decodeURIComponent(segments[segments.length - 2] || 'UNKNOWN');
    const payload = JSON.parse(route.request().postData() || '{}') as Record<string, unknown>;
    options.onInputSubmit?.(issueIdentifier, payload);
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        issue_identifier: issueIdentifier,
        resume_mode: 'native',
        resume_reason_code: 'input_required_pending'
      })
    });
  });

  await page.route('**/api/v1/issues/*/diagnostics', async (route) => {
    const segments = route.request().url().split('/');
    const issueIdentifier = decodeURIComponent(segments[segments.length - 2] || '');
    const diagnosticsResolver = options.diagnostics?.[issueIdentifier];
    if (!diagnosticsResolver) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'thread_diagnostics_not_found', message: 'No diagnostics' } })
      });
      return;
    }
    const payload = typeof diagnosticsResolver === 'function' ? diagnosticsResolver(issueIdentifier) : diagnosticsResolver;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.route('**/api/v1/*', async (route) => {
    const url = new URL(route.request().url());
    const passthrough = new Set([
      '/api/v1/state',
      '/api/v1/diagnostics',
      '/api/v1/history',
      '/api/v1/ui-state',
      '/api/v1/refresh'
    ]);
    if (passthrough.has(url.pathname) || url.pathname.endsWith('/resume')) {
      await route.fallback();
      return;
    }
    const issueIdentifier = decodeURIComponent(url.pathname.split('/').at(-1) || '');
    const issueResolver = options.issues?.[issueIdentifier];

    if (!issueResolver) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Issue not found' } })
      });
      return;
    }

    const payload = typeof issueResolver === 'function' ? issueResolver(issueIdentifier) : issueResolver;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
}

test.describe('phase-marker dashboard e2e', () => {
  test('project history renders bounded ticket rows and lazy timeline detail', async ({ page }) => {
    const projectKey = 'project-main';
    const completedTicketKey = 'ticket-completed';
    const activeTicketKey = 'ticket-active';
    let detailLoads = 0;

    const factStates = [
      { fact: 'history_schema', status: 'degraded', reason_code: 'history_write_failed', detail: 'history write degraded' },
      { fact: 'terminal_outcome', status: 'present', reason_code: null, detail: null },
      { fact: 'app_server_lite_payload', status: 'redacted', reason_code: 'project_history_payload_redacted', detail: null },
      { fact: 'app_server_lite_payload', status: 'truncated', reason_code: 'project_history_payload_truncated', detail: null }
    ];

    const completedRow = {
      project_identity: { key: projectKey },
      ticket_identity: { key: completedTicketKey, human_issue_identifier: 'NIE-200' },
      state: 'completed',
      current_status: 'Done',
      last_known_status: 'Done',
      latest_attempt: {
        attempt_id: 'attempt-2',
        attempt_number: 2,
        status: 'succeeded',
        started_at: '2026-05-10T10:00:00.000Z',
        ended_at: '2026-05-10T10:10:00.000Z',
        outcome: 'succeeded',
        outcome_reason_code: 'merged'
      },
      summary: {
        issue_run_count: 1,
        attempt_count: 2,
        thread_count: 2,
        turn_count: 5,
        phase_count: 4,
        state_transition_count: 3,
        active_blocker_count: 0,
        resolved_blocker_count: 1,
        evidence_reference_count: 1,
        tracker_snapshot_count: 1,
        ticket_reference_count: 1,
        operator_action_count: 1,
        blocked_input_event_count: 0,
        app_server_event_count: 1,
        token_model_fact_count: 1,
        total_tokens: 4200
      },
      facts: factStates,
      latest_observed_at: '2026-05-10T10:12:00.000Z'
    };

    const activeRow = {
      ...completedRow,
      ticket_identity: { key: activeTicketKey, human_issue_identifier: 'NIE-201' },
      state: 'active',
      current_status: 'In Progress',
      latest_attempt: {
        attempt_id: 'attempt-active',
        attempt_number: 1,
        status: 'running',
        started_at: '2026-05-10T11:00:00.000Z',
        ended_at: null,
        outcome: null,
        outcome_reason_code: null
      },
      summary: {
        ...completedRow.summary,
        attempt_count: 1,
        thread_count: 1,
        turn_count: 1,
        total_tokens: null
      },
      facts: [
        { fact: 'terminal_outcome', status: 'missing', reason_code: 'project_history_terminal_outcome_missing', detail: null },
        { fact: 'token_model_summaries', status: 'missing', reason_code: 'project_history_token_model_summaries_missing', detail: null },
        { fact: 'history_schema', status: 'degraded', reason_code: 'history_write_failed', detail: 'history write degraded' }
      ]
    };

    const completedDetail = {
      ...completedRow,
      attempts: [
        { attempt_id: 'attempt-1', attempt_number: 1, status: 'failed', started_at: '2026-05-10T09:00:00.000Z', ended_at: '2026-05-10T09:10:00.000Z' },
        { attempt_id: 'attempt-2', attempt_number: 2, status: 'succeeded', started_at: '2026-05-10T10:00:00.000Z', ended_at: '2026-05-10T10:10:00.000Z' }
      ],
      phases: [
        { phase: 'planning', status: 'completed', started_at: '2026-05-10T10:00:00.000Z', ended_at: '2026-05-10T10:02:00.000Z', reason_code: null },
        { phase: 'validation', status: 'completed', started_at: '2026-05-10T10:08:00.000Z', ended_at: '2026-05-10T10:10:00.000Z', reason_code: null }
      ],
      state_transitions: [
        { from_status: 'In Progress', to_status: 'Agent Review', transitioned_at: '2026-05-10T10:11:00.000Z', reason_code: 'review_ready' }
      ],
      thread_references: [
        { thread_id: 'thread-1', attempt_id: 'attempt-2', started_at: '2026-05-10T10:00:00.000Z', ended_at: '2026-05-10T10:10:00.000Z', status: 'completed' }
      ],
      turn_references: [
        { turn_id: 'turn-1', thread_id: 'thread-1', turn_index: 0, started_at: '2026-05-10T10:01:00.000Z', ended_at: '2026-05-10T10:09:00.000Z', status: 'completed' }
      ],
      outcomes: [{ outcome: 'succeeded', reason_code: 'merged', recorded_at: '2026-05-10T10:12:00.000Z' }],
      blockers: [{ status: 'resolved', blocker_type: 'tool_output', reason_code: 'missing_tool_output', reason_detail: 'recovered' }],
      evidence_references: [{ evidence_kind: 'test_output', title: 'project history proof', uri: 'file://proof.txt', recorded_at: '2026-05-10T10:09:00.000Z' }],
      tracker_facts: [{ tracker_status: 'Done', last_observed_at: '2026-05-10T10:12:00.000Z' }],
      pr_and_reference_facts: [{ reference_kind: 'pull_request', label: 'PR #240', state: 'merged', last_observed_at: '2026-05-10T10:12:00.000Z' }],
      operator_facts: [{ action: 'resume', result: 'accepted', requested_at: '2026-05-10T09:30:00.000Z' }],
      blocked_input_events: [],
      app_server_lite_summaries: [
        {
          source_event_name: 'thread/tokenUsage/updated',
          detail_status: 'redacted_truncated_excerpt',
          summary: 'token update',
          redacted_excerpt: 'token=***REDACTED***',
          unavailable_reason_code: null
        }
      ],
      token_model_summaries: [
        { effective_model: 'gpt-5.4', requested_model: 'gpt-5.4', total_tokens: 4200, telemetry_confidence: 'observed_live' }
      ]
    };

    await installDashboardApiMocks(page, {
      state: baseState(),
      runHistory: {
        runs: [
          {
            issue_identifier: 'NIE-200',
            terminal_status: 'succeeded',
            started_at: '2026-05-10T10:00:00.000Z',
            ended_at: '2026-05-10T10:10:00.000Z',
            identity: { project: { key: projectKey } }
          }
        ]
      },
      projectHistory: {
        list: {
          project_identity: { key: projectKey },
          health: {
            status: 'degraded',
            enabled: true,
            storage: { type: 'sqlite', target: '/tmp/runtime.sqlite' },
            schema: { status: 'degraded', integrity_ok: false, target_version: 7, applied_version: 7, reason_code: 'history_write_failed', detail: 'history write degraded' },
            counts: { runs: 2, tickets: 2 },
            retention: { retention_days: 14, last_prune: { status: 'failed', last_pruned_at: null, failure_at: '2026-05-10T10:00:00.000Z', failure_reason_code: 'retention_prune_failed', failure_detail: 'prune failed' } },
            writes: { status: 'degraded', recent_failures: [{ operation: 'appendTurn', reason_code: 'history_turn_write_failed', detail: 'redacted', recorded_at: '2026-05-10T10:00:00.000Z' }] },
            projections: { status: 'degraded', reason_code: 'history_write_failed', detail: 'projection degraded' },
            app_server_lite: { status: 'degraded', redacted_event_count: 1, truncated_event_count: 1, unavailable_event_count: 0, full_payload_stored_count: 0 },
            diagnostics: [{ fact: 'history_writes', status: 'degraded', reason_code: 'history_turn_write_failed', detail: 'appendTurn' }]
          },
          page: { limit: 50, offset: 0, has_more: true, total: 2 },
          tickets: [completedRow, activeRow],
          facts: [
            { fact: 'history_schema', status: 'degraded', reason_code: 'history_write_failed', detail: 'history write degraded' },
            { fact: 'history_schema', status: 'degraded', reason_code: 'history_write_failed', detail: 'history write degraded duplicate' },
            { fact: 'terminal_outcome', status: 'present', reason_code: null, detail: null },
            { fact: 'terminal_outcome', status: 'present', reason_code: null, detail: null }
          ]
        },
        details: {
          [completedTicketKey]: completedDetail
        },
        onDetailLoad: () => {
          detailLoads += 1;
        }
      }
    });

    await page.goto('/');

    await expect(page.locator('#project-history-status')).toContainText('Showing 2 of 2 ticket rows');
    await expect(page.locator('#project-history-status')).toContainText('more rows available');
    await expect(page.locator('#project-history-status')).toContainText('Health: degraded');
    await expect(page.locator('#project-history-status')).toContainText('retention 14d');
    await expect(page.locator('#project-history-status')).toContainText('prune failed');
    await expect(page.locator('#project-history-status')).toContainText('writes degraded');
    await expect(page.locator('#project-history-facts .mini-badge')).toHaveText([
      'degraded: history schema',
      'present: terminal outcome'
    ]);
    await expect(page.locator('#project-history-rows')).toContainText('NIE-200');
    await expect(page.locator('#project-history-rows')).toContainText('completed');
    await expect(page.locator('#project-history-rows')).toContainText('Attempt 2');
    await expect(page.locator('#project-history-rows')).toContainText('tokens 4,200');
    await expect(page.locator('#project-history-rows')).toContainText('NIE-201');
    await expect(page.locator('#project-history-rows')).toContainText('active');
    await expect(page.locator('#project-history-rows')).toContainText('missing: terminal outcome');
    await expect(page.locator('#project-history-rows')).toContainText('redacted: app server lite payload');
    await expect(page.locator('#project-history-detail')).toBeHidden();
    expect(detailLoads).toBe(0);

    await page.locator('tr[data-ticket-key="ticket-completed"]').getByRole('button', { name: 'View Timeline' }).click();

    await expect(page.locator('#project-history-detail')).toBeVisible();
    await expect(page.locator('#project-history-detail')).toContainText('Ticket Timeline: NIE-200');
    await expect(page.locator('#project-history-detail')).toContainText('Attempt 1');
    await expect(page.locator('#project-history-detail')).toContainText('Attempt 2');
    await expect(page.locator('#project-history-detail')).toContainText('State Transitions');
    await expect(page.locator('#project-history-detail')).toContainText('thread-1');
    await expect(page.locator('#project-history-detail')).toContainText('missing_tool_output');
    await expect(page.locator('#project-history-detail')).toContainText('PR #240');
    await expect(page.locator('#project-history-detail')).toContainText('token update');
    await expect(page.locator('#project-history-detail')).toContainText('gpt-5.4');
    await expect(page.locator('#project-history-detail')).not.toContainText('raw transcript');
    expect(detailLoads).toBe(1);
  });

  test('stopped-run recovery card renders terminal and root-cause diagnostics without overlap', async ({ page }) => {
    await installDashboardApiMocks(page, {
      state: baseState({
        counts: {
          running: 0,
          retrying: 0,
          blocked: 0,
          stopped: 1,
          running_stalled_waiting_count: 0,
          running_awaiting_input_count: 0
        },
        stopped_runs: [
          {
            run_id: 'run-nie-68',
            issue_id: 'issue-nie-68',
            issue_identifier: 'NIE-68',
            terminal_status: 'cancelled',
            terminal_reason_code: 'non_active_state_transition',
            terminal_reason_detail: 'Issue left active states during reconciliation.',
            root_cause_status: 'blocked',
            root_cause_reason_code: 'missing_tool_output',
            root_cause_reason_detail: 'missing Codex tool output for call_123',
            root_cause_at: '2026-05-05T10:05:00.000Z',
            thread_id: 'thread-nie-68',
            turn_id: 'turn-nie-68',
            session_id: 'session-nie-68',
            last_relevant_at: '2026-05-05T10:05:00.000Z',
            active_issue_present: false,
            recovery_status: 'capability_mismatch',
            resume_valid: false,
            resume_disabled_reason: 'Dynamic-tool capability mismatch requires a native runtime recovery path; console-only continuation is disabled.',
            capability_mismatch: true,
            capability_warning: {
              reason_code: 'unsupported_dynamic_tool_console_resume',
              source_environment: 'console_tui',
              attempted_tool_name: 'linear_graphql',
              call_id: 'call_123',
              thread_id: 'thread-nie-68',
              turn_id: 'turn-nie-68',
              unsupported_capability_message: 'Dynamic tools are unavailable in console TUI.',
              recommended_recovery_action: 'Use a native runtime continuation.'
            },
            actions: {
              inspect_forensics_url: '/api/v1/issues/NIE-68/forensics/export',
              inspect_thread_url: '/api/v1/history/threads/thread-nie-68',
              resume_url: null,
              acknowledge_supported: true,
              copy_thread_id_supported: true,
              copy_session_id_supported: true
            }
          }
        ]
      })
    });

    await page.goto('/');
    await page.locator('#stopped-run-recovery-load').click();

    const panel = page.locator('#stopped-run-recovery-list');
    await expect(panel).toContainText('NIE-68');
    await expect(panel).toContainText('cancelled / non_active_state_transition');
    await expect(panel).toContainText('missing Codex tool output');
    await expect(panel).toContainText('Capability mismatch');
    await expect(panel.getByRole('button', { name: 'Resume' })).toBeDisabled();
    await expect(page.locator('#running-rows')).toContainText('No running issues');
    await expect(page.locator('#blocked-rows')).toContainText('No issues are blocked on operator input.');

    const box = await panel.boundingBox();
    const blockedBox = await page.locator('#blocked-rows').boundingBox();
    expect(box).not.toBeNull();
    expect(blockedBox).not.toBeNull();
    expect(box!.y).toBeGreaterThan(blockedBox!.y);
  });

  test('running table shows current phase and stale warning metadata', async ({ page }) => {
    await installDashboardApiMocks(page, {
      state: baseState({
        running: [
          {
            issue_identifier: 'NIE-22',
            state: 'running',
            session_id: 'session-running-1',
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-22',
            provisioner_type: 'git_worktree',
            branch_name: 'feature/NIE-22',
            workspace_git_status: 'clean',
            started_at: ISO_OLD,
            turn_count: 4,
            tokens: { total_tokens: 1200, input_tokens: 800, output_tokens: 400 },
            last_event_summary: 'planning update',
            last_event: 'codex.phase.planning',
            last_message: 'Planning complete',
            last_event_at: ISO_NOW,
            thread_id: 'thread-1',
            turn_id: 'turn-1',
            current_phase: 'planning',
            current_phase_at: ISO_OLD,
            phase_elapsed_ms: 120000,
            phase_detail: 'waiting for implementation'
          }
        ]
      })
    });

    await page.goto('/');

    await expect(page.locator('#running-rows')).toContainText('NIE-22');
    await expect(page.locator('#running-rows')).toContainText('planning');
    await expect(page.locator('#running-rows')).toContainText('No phase movement yet');
  });

  test('renders live Claude dimensions and retained provider overview totals without fake zeroes', async ({ page }) => {
    const providerUsage = {
      runtime: 'claude-cli',
      model: 'claude-sonnet-4-6',
      effective_models: ['claude-sonnet-4-6'],
      input_tokens: 120,
      output_tokens: 30,
      cache_read_tokens: 50,
      cache_creation_tokens: 10,
      provider_turn_count: 3,
      estimated_cost_usd: null,
      source: 'claude_assistant_step',
      status: 'partial',
      confidence: 'provider_step',
      api_retry_count: 1,
      tool_counts: { Read: 2 },
      mcp_counts: { 'linear-server': 1 },
      updated_at: ISO_NOW,
      missing_reason: null,
      reconciliation_delta: null,
      model_usage: [],
      nested_session_detected: false,
      supervised_session_coverage: 'partial'
    };
    await installDashboardApiMocks(page, {
      state: baseState({
        counts: {
          running: 1,
          retrying: 0,
          blocked: 0,
          stopped: 0,
          running_stalled_waiting_count: 0,
          running_awaiting_input_count: 0
        },
        provider_totals: [{
          runtime: 'claude-cli',
          effective_model: 'claude-sonnet-4-6',
          invocation_count: 2,
          final_invocation_count: 1,
          partial_invocation_count: 1,
          input_tokens: 420,
          output_tokens: 90,
          cache_read_tokens: 150,
          cache_creation_tokens: 20,
          provider_turn_count: 7,
          estimated_cost_usd: 0.42,
          updated_at: ISO_NOW
        }],
        running: [{
          issue_identifier: 'NIE-CLAUDE',
          state: 'running',
          agent_runtime: 'claude-cli',
          requested_model: 'claude-sonnet-4-6',
          effective_model: 'claude-sonnet-4-6',
          worker_process_pid: 4242,
          session_id: '11111111-1111-4111-8111-111111111111',
          thread_id: 'claude:11111111-1111-4111-8111-111111111111',
          turn_id: 'claude-turn-1',
          workspace_path: '/tmp/workspaces/NIE-CLAUDE',
          provisioner_type: 'git_worktree',
          branch_name: 'feature/NIE-CLAUDE',
          workspace_git_status: 'clean',
          started_at: ISO_OLD,
          turn_count: 1,
          provider_usage: providerUsage,
          last_event_summary: 'Claude usage partial',
          last_event: 'agent_runner.activity',
          last_event_at: ISO_NOW,
          progress_signal_state: 'advancing',
          turn_control_state: 'agent_turn'
        }]
      })
    });

    await page.goto('/');

    await expect(page.locator('#kpi-grid')).toContainText('Provider Input420');
    await expect(page.locator('#kpi-grid')).toContainText('Provider Estimated Cost$0.4200');
    await expect(page.locator('#running-rows')).toContainText('Runtime claude-cli');
    await expect(page.locator('#running-rows')).toContainText('In 120 / Out 30 / Cache read 50 / Cache create 10');
    await expect(page.locator('#running-rows')).toContainText('Partial provider usage');
    await expect(page.locator('#running-rows')).not.toContainText('Estimated $0.0000');
  });

  test('issue detail distinguishes partial, final, and unobserved Claude telemetry transitions', async ({ page }) => {
    const baseUsage = {
      runtime: 'claude-cli',
      model: 'claude-sonnet-4-6',
      effective_models: ['claude-sonnet-4-6'],
      input_tokens: 25,
      output_tokens: 5,
      cache_read_tokens: 8,
      cache_creation_tokens: 2,
      provider_turn_count: 1,
      estimated_cost_usd: null,
      source: 'claude_assistant_step',
      status: 'partial',
      confidence: 'provider_step',
      api_retry_count: 0,
      tool_counts: { Read: 1 },
      mcp_counts: { 'linear-server': 1 },
      updated_at: ISO_NOW,
      missing_reason: null,
      supervised_session_coverage: 'partial'
    };
    let providerUsage: Record<string, unknown> = baseUsage;
    await installDashboardApiMocks(page, {
      state: baseState(),
      issues: {
        'NIE-CLAUDE-DETAIL': () => ({
          issue_identifier: 'NIE-CLAUDE-DETAIL',
          issue_id: 'issue-claude-detail',
          status: 'running',
          workspace: { path: '/tmp/workspaces/NIE-CLAUDE-DETAIL' },
          running: {
            agent_runtime: 'claude-cli',
            requested_model: 'claude-sonnet-4-6',
            effective_model: 'claude-sonnet-4-6',
            worker_process_pid: '4242',
            session_id: '33333333-3333-4333-8333-333333333333',
            thread_id: 'claude:33333333-3333-4333-8333-333333333333',
            turn_id: 'claude-detail-turn',
            provider_usage: providerUsage,
            provisioner_type: 'git_clone',
            branch_name: 'feature/NIE-CLAUDE-DETAIL',
            workspace_git_status: 'clean'
          },
          retry: null,
          blocked: null,
          phase_timeline: [],
          recent_events: []
        })
      }
    });

    await page.goto('/');
    await page.locator('#issue-input').fill('NIE-CLAUDE-DETAIL');
    await page.locator('#issue-load').click();
    await expect(page.locator('#issue-summary')).toContainText('Agent runtime: claude-cli');
    await expect(page.locator('#issue-summary')).toContainText('In 25 / Out 5 / Cache read 8 / Cache create 2');
    await expect(page.locator('#issue-summary')).toContainText('partial • provider_step');
    await expect(page.locator('#issue-summary')).not.toContainText('Estimated $0.0000');

    providerUsage = {
      ...baseUsage,
      input_tokens: 40,
      output_tokens: 9,
      provider_turn_count: 2,
      estimated_cost_usd: 0.031,
      source: 'claude_stream_result',
      status: 'final',
      confidence: 'provider_result',
      supervised_session_coverage: 'complete'
    };
    await page.locator('#issue-load').click();
    await expect(page.locator('#issue-summary')).toContainText('Estimated $0.0310');
    await expect(page.locator('#issue-summary')).toContainText('final • provider_result');

    providerUsage = {
      ...baseUsage,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      provider_turn_count: null,
      status: 'unobserved',
      confidence: 'missing',
      missing_reason: 'process_closed_without_usage',
      supervised_session_coverage: 'missing'
    };
    await page.locator('#issue-load').click();
    await expect(page.locator('#issue-summary')).toContainText('Provider usage missing • process_closed_without_usage');
    await expect(page.locator('#issue-summary')).toContainText('Provider coverage warning: missing');
  });

  test('renders operator explainer counters, row hints, and stalled-wait issue detail card', async ({ page }) => {
    await installDashboardApiMocks(page, {
      state: baseState({
        counts: {
          running: 1,
          retrying: 0,
          blocked: 1,
          running_stalled_waiting_count: 1,
          running_awaiting_input_count: 0
        },
        running: [
          {
            issue_identifier: 'NIE-49',
            state: 'running',
            session_id: 'session-stalled',
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-49',
            provisioner_type: 'git_worktree',
            branch_name: 'feature/NIE-49',
            workspace_git_status: 'clean',
            started_at: ISO_OLD,
            turn_count: 8,
            tokens: { total_tokens: 1200, input_tokens: 800, output_tokens: 400 },
            last_event_summary: 'codex.turn.waiting heartbeat',
            last_event: 'codex.turn.waiting',
            last_message: 'waiting',
            last_event_at: ISO_NOW,
            thread_id: 'thread-stalled',
            turn_id: 'turn-stalled',
            current_phase: 'implementation',
            current_phase_at: ISO_OLD,
            phase_elapsed_ms: 120000,
            phase_detail: 'waiting heartbeat',
            awaiting_input: false,
            progress_signal_state: 'stalled_waiting',
            stalled_waiting: true,
            stalled_waiting_since_ms: Date.parse('2026-04-30T09:59:00.000Z'),
            stalled_waiting_reason: 'turn_waiting_threshold_exceeded',
            operator_explainer_hint: {
              classification: 'stalled_waiting',
              actionability: 'required',
              headline: 'Run is alive but waiting too long'
            }
          }
        ],
        blocked: [
          {
            issue_identifier: 'NIE-50',
            attempt: 1,
            blocked_at: ISO_NOW,
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-50',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'turn_input_required',
            stop_reason_detail: 'operator input required',
            previous_session_id: 'session-prev-blocked',
            previous_thread_id: 'thread-prev-blocked',
            operator_explainer_hint: {
              classification: 'blocked_input',
              actionability: 'required',
              headline: 'Run is blocked on operator input'
            }
          }
        ]
      }),
      issues: {
        'NIE-49': {
          issue_identifier: 'NIE-49',
          issue_id: 'issue-nie-49',
          status: 'running',
          operator_explainer: {
            version: '2026-05-05.v1',
            classification: 'stalled_waiting',
            actionability: 'required',
            headline: 'Run is alive but waiting too long',
            detail: 'The run is still alive through codex.turn.waiting heartbeats after the configured wait threshold.',
            recommended_actions: ['Inspect recent events and decide whether to resume/cancel/restart'],
            expected_transition: null,
            reason_code: 'turn_waiting_threshold_exceeded',
            reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold'
          },
          workspace: { path: '/tmp/workspaces/NIE-49' },
          running: {
            current_phase: 'implementation',
            provisioner_type: 'git_worktree',
            branch_name: 'feature/NIE-49',
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true
          },
          retry: null,
          blocked: null,
          phase_timeline: [],
          recent_events: [
            {
              at: ISO_NOW,
              event: 'codex.turn.waiting',
              message: 'waiting'
            }
          ]
        }
      }
    });

    await page.goto('/');

    const stalledStateCell = page.locator('tr[data-issue="NIE-49"] td').nth(1);
    await expect(stalledStateCell).toContainText('Stalled Waiting');
    await expect(stalledStateCell).toContainText('Run is alive but waiting too long');
    await expect.poll(async () => (await stalledStateCell.textContent())?.match(/Stalled Waiting/g)?.length ?? 0).toBe(1);
    await expect
      .poll(async () => (await stalledStateCell.textContent())?.match(/Run is alive but waiting too long/g)?.length ?? 0)
      .toBe(1);

    await expect(page.locator('#kpi-grid')).toContainText('Stalled Waiting');
    await expect(page.locator('#kpi-grid')).toContainText('Awaiting Input');
    await expect(page.locator('#running-rows')).toContainText('Run is alive but waiting too long');
    await expect(page.locator('#blocked-rows')).toContainText('Run is blocked on operator input');

    await page.locator('#issue-input').fill('NIE-49');
    await page.locator('#issue-load').click();

    await expect(page.locator('#issue-explainer-card')).toContainText('Run is alive but waiting too long');
    await expect(page.locator('#issue-explainer-card')).toContainText('required');
    await expect(page.locator('#issue-explainer-card')).toContainText('Inspect recent events and decide whether to resume/cancel/restart');
    await expect(page.locator('#issue-summary')).toContainText('Actionability: required');
  });

  test('running row links open diagnostics drilldown with timeline lanes and blocker intelligence', async ({ page }) => {
    await installDashboardApiMocks(page, {
      state: baseState({
        running: [
          {
            issue_identifier: 'NIE-57',
            state: 'running',
            session_id: 'session-drilldown',
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-57',
            provisioner_type: 'git_worktree',
            branch_name: 'feature/NIE-57',
            workspace_git_status: 'clean',
            started_at: ISO_OLD,
            turn_count: 5,
            tokens: { total_tokens: 3000, input_tokens: 2200, output_tokens: 800 },
            last_event_summary: 'codex.turn.waiting heartbeat',
            last_event: 'codex.turn.waiting',
            last_message: 'waiting',
            last_event_at: ISO_NOW,
            thread_id: 'thread-drilldown',
            turn_id: 'turn-drilldown',
            current_phase: 'implementation',
            current_phase_at: ISO_OLD,
            phase_elapsed_ms: 120000,
            phase_detail: 'tool wait',
            current_blocker_class: 'stalled_waiting',
            time_since_progress: 90000,
            last_successful_step: 'codex.turn.started: implementation turn started'
          }
        ]
      }),
      issues: {
        'NIE-57': {
          issue_identifier: 'NIE-57',
          issue_id: 'issue-nie-57',
          status: 'running',
          workspace: { path: '/tmp/workspaces/NIE-57' },
          running: { current_phase: 'implementation' },
          retry: null,
          blocked: null,
          phase_timeline: [],
          recent_events: []
        }
      },
      diagnostics: {
        'NIE-57': {
          thread_id: 'thread-drilldown',
          issue_identifier: 'NIE-57',
          attempt: 0,
          status: 'stalled',
          timeline: [
            {
              at_ms: Date.parse('2026-04-30T09:58:30.000Z'),
              event: 'codex.turn.started',
              reason_code: null,
              reason_detail: 'implementation turn started',
              thread_id: 'thread-drilldown',
              turn_id: 'turn-drilldown',
              session_id: 'session-drilldown'
            },
            {
              at_ms: Date.parse('2026-04-30T09:59:30.000Z'),
              event: 'codex.turn.waiting',
              reason_code: 'turn_waiting_threshold_exceeded',
              reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold',
              thread_id: 'thread-drilldown',
              turn_id: 'turn-drilldown',
              session_id: 'session-drilldown'
            }
          ],
          phase_spans: [
            {
              phase: 'implementation',
              started_at_ms: Date.parse('2026-04-30T09:58:00.000Z'),
              ended_at_ms: null,
              duration_ms: null,
              status: 'running',
              reason_code: null,
              reason_detail: 'tool wait'
            }
          ],
          tool_spans: [
            {
              tool_name: 'exec_command',
              started_at_ms: Date.parse('2026-04-30T09:59:00.000Z'),
              ended_at_ms: null,
              duration_ms: null,
              status: 'running',
              reason_code: 'turn_waiting_threshold_exceeded',
              reason_detail: 'shell command still running'
            }
          ],
          wait_spans: [
            {
              started_at_ms: Date.parse('2026-04-30T09:59:30.000Z'),
              ended_at_ms: null,
              duration_ms: null,
              status: 'blocked',
              reason_code: 'turn_waiting_threshold_exceeded',
              reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold'
            }
          ],
          current_blocker: {
            classification: 'tool_waiting_long',
            reason_code: 'turn_waiting_threshold_exceeded',
            reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold',
            time_since_progress: 90000,
            actionability: 'recommended',
            recommended_actions: ['Inspect the active Codex turn and resume, cancel, or retry the run if the wait is not expected.'],
            expected_auto_transition: null
          },
          last_meaningful_progress_at_ms: Date.parse('2026-04-30T09:58:30.000Z')
        }
      }
    });

    await page.goto('/');

    await expect(page.locator('#running-rows')).toContainText('stalled_waiting');
    await expect(page.locator('#running-rows')).toContainText('90000 ms');
    await expect(page.locator('#running-rows')).toContainText('codex.turn.started: implementation turn started');

    await page.locator('#running-rows a', { hasText: 'NIE-57' }).click();

    await expect(page.locator('#thread-detail')).toBeVisible();
    await expect(page.locator('#thread-timeline-lanes')).toContainText('Phase');
    await expect(page.locator('#thread-timeline-lanes')).toContainText('implementation');
    await expect(page.locator('#thread-timeline-lanes')).toContainText('Tool');
    await expect(page.locator('#thread-timeline-lanes')).toContainText('exec_command');
    await expect(page.locator('#thread-timeline-lanes')).toContainText('Wait');
    await expect(page.locator('#thread-blocker-card')).toContainText('tool_waiting_long');
    await expect(page.locator('#thread-blocker-card')).toContainText('turn_waiting_threshold_exceeded');
    await expect(page.locator('#thread-blocker-card')).toContainText('90000');
    await expect(page.locator('#thread-blocker-card')).toContainText('Inspect the active Codex turn');
    await expect(page.locator('#thread-raw-events')).toContainText('codex.turn.waiting');
  });

  test('retrying and blocked views show last_phase context', async ({ page }) => {
    await installDashboardApiMocks(page, {
      state: baseState({
        retrying: [
          {
            issue_identifier: 'NIE-23',
            attempt: 2,
            due_at: ISO_NOW,
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-23',
            provisioner_type: 'git_worktree',
            branch_name: 'feature/NIE-23',
            workspace_git_status: 'dirty',
            workspace_exists: true,
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'retryable_error',
            stop_reason_detail: 'network glitch',
            previous_session_id: 'session-prev-retry',
            previous_thread_id: 'thread-prev-retry',
            error: 'timeout',
            last_phase: 'implementation',
            last_phase_at: ISO_OLD,
            last_phase_detail: 'tool call failed'
          }
        ],
        blocked: [
          {
            issue_identifier: 'NIE-24',
            attempt: 1,
            blocked_at: ISO_NOW,
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-24',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'blocked_input',
            stop_reason_detail: 'needs approval',
            previous_session_id: 'session-prev-blocked',
            previous_thread_id: 'thread-prev-blocked',
            last_phase: 'validation',
            last_phase_at: ISO_OLD,
            last_phase_detail: 'awaiting operator response'
          }
        ]
      })
    });

    await page.goto('/');

    await expect(page.locator('#retry-rows')).toContainText('Last phase: implementation');
    await expect(page.locator('#retry-rows')).toContainText('tool call failed');
    await expect(page.locator('#blocked-rows')).toContainText('Last phase: validation');
    await expect(page.locator('#blocked-rows')).toContainText('awaiting operator response');
  });

  test('blocked rows show failed phase root cause above current operator latch', async ({ page }) => {
    await installDashboardApiMocks(page, {
      state: baseState({
        counts: {
          running: 0,
          retrying: 0,
          blocked: 1,
          stopped: 0,
          running_stalled_waiting_count: 0,
          running_awaiting_input_count: 0
        },
        blocked: [
          {
            issue_identifier: 'NIE-78',
            attempt: 2,
            blocked_at: ISO_NOW,
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-78',
            workspace_provisioned: false,
            workspace_is_git_worktree: false,
            workspace_git_status: 'dirty',
            stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
            stop_reason_detail: 'completion gate blocked redispatch because no progress signal was detected',
            current_operator_block: {
              reason_code: 'operator_action_required_no_progress_redispatch_blocked',
              detail: 'completion gate blocked redispatch because no progress signal was detected'
            },
            root_cause: {
              phase: 'failed',
              reason_code: 'worktree_dirty_repo',
              summary: 'Workspace provisioning failed: repo root has uncommitted or untracked files.',
              detail: 'workspace_provision_failed: worktree_dirty_repo',
              remediation_hint: 'Clean, commit, or ignore the dirty repo files, then requeue or resume.',
              differs_from_current_operator_block: true
            },
            previous_session_id: 'session-prev-dirty',
            previous_thread_id: 'thread-prev-dirty',
            last_phase: 'failed',
            last_phase_at: ISO_OLD,
            last_phase_detail: 'workspace_provision_failed: worktree_dirty_repo',
            turn_control_state: 'blocked_manual_resume',
            progress_signal_state: 'stalled_waiting',
            required_actions: [],
            pending_input: null,
            last_input_submit: null
          }
        ]
      })
    });

    await page.goto('/');

    const row = page.locator('#blocked-rows tr').filter({ hasText: 'NIE-78' });
    await expect(row).toContainText('Root cause');
    await expect(row).toContainText('Workspace provisioning failed: repo root has uncommitted or untracked files.');
    await expect(row).toContainText('Clean, commit, or ignore the dirty repo files, then requeue or resume.');
    await expect(row).toContainText(
      'Current operator block: operator_action_required_no_progress_redispatch_blocked'
    );
    await expect(row).toContainText(
      'Current block detail: completion gate blocked redispatch because no progress signal was detected'
    );

    const rowText = (await row.textContent()) ?? '';
    expect(rowText.indexOf('Root cause')).toBeLessThan(rowText.indexOf('Current operator block:'));
    mkdirSync('output/playwright', { recursive: true });
    await row.screenshot({ path: 'output/playwright/nie-79-blocked-root-cause-row.png' });
  });

  test('blocked manual-resume rows hide Reply while preserving manual actions', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await installDashboardApiMocks(page, {
      state: baseState({
        counts: {
          running: 0,
          retrying: 0,
          blocked: 1,
          running_stalled_waiting_count: 0,
          running_awaiting_input_count: 0
        },
        blocked: [
          {
            issue_identifier: 'NIE-66-MANUAL',
            attempt: 3,
            blocked_at: ISO_NOW,
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-66-MANUAL',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
            stop_reason_detail: 'completion gate blocked redispatch because no progress signal was detected',
            previous_session_id: 'session-prev-manual',
            previous_thread_id: 'thread-prev-manual',
            turn_control_state: 'blocked_manual_resume',
            progress_signal_state: 'stalled_waiting',
            runtime_state_kind: 'blocked_input',
            requires_manual_resume: true,
            awaiting_operator: true,
            required_actions: [
              'Mark acceptance complete and resume',
              'Push additional commit and resume',
              'Cancel and return to backlog'
            ],
            available_actions: [
              {
                id: 'resume',
                label: 'Mark Acceptance Complete + Resume',
                endpoint: '/api/v1/issues/NIE-66-MANUAL/resume',
                method: 'POST',
                requires_reason_note: true,
                destructive: false
              },
              {
                id: 'resume',
                label: 'Push Commit + Resume',
                endpoint: '/api/v1/issues/NIE-66-MANUAL/resume',
                method: 'POST',
                requires_reason_note: true,
                destructive: false
              },
              {
                id: 'cancel',
                label: 'Cancel to Backlog',
                endpoint: '/api/v1/issues/NIE-66-MANUAL/cancel',
                method: 'POST',
                requires_reason_note: true,
                destructive: true
              }
            ],
            pending_input: null,
            last_input_submit: null
          }
        ]
      }),
      issues: {
        'NIE-66-MANUAL': {
          issue_identifier: 'NIE-66-MANUAL',
          status: 'blocked',
          workspace: { path: '/tmp/workspaces/NIE-66-MANUAL' },
          running: null,
          retry: null,
          blocked: {
            stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
            pending_input: null
          },
          phase_timeline: [],
          recent_events: []
        }
      }
    });
    page.on('dialog', async (dialog) => {
      if (dialog.type() === 'confirm') {
        await dialog.accept();
        return;
      }
      await dialog.accept('operator note');
    });

    await page.goto('/');

    const row = page.locator('#blocked-rows tr').filter({ hasText: 'NIE-66-MANUAL' });
    await expect(row).toContainText('Manual Resume Required');
    await expect(row.getByRole('button', { name: 'Reply' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Mark Acceptance Complete + Resume' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Push Commit + Resume' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Cancel to Backlog' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Copy Prev Session' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Copy Workspace' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'JSON' })).toBeVisible();

    await row.getByRole('button', { name: 'Mark Acceptance Complete + Resume' }).click();
    await row.getByRole('button', { name: 'Push Commit + Resume' }).click();
    await row.getByRole('button', { name: 'Cancel to Backlog' }).click();
    await row.getByRole('button', { name: 'Copy Prev Session' }).click();
    await row.getByRole('button', { name: 'Copy Workspace' }).click();
    const popupPromise = page.waitForEvent('popup');
    await row.getByRole('button', { name: 'JSON' }).click();
    await popupPromise;

    await expect(page.locator('#refresh-status')).not.toContainText('No pending input request payload');
  });

  test('blocked pending-input rows keep Reply and submit the current request id', async ({ page }) => {
    const inputSubmissions: Array<{ issueIdentifier: string; payload: Record<string, unknown> }> = [];
    await installDashboardApiMocks(page, {
      state: baseState({
        counts: {
          running: 0,
          retrying: 0,
          blocked: 1,
          running_stalled_waiting_count: 0,
          running_awaiting_input_count: 0
        },
        blocked: [
          {
            issue_identifier: 'NIE-66-INPUT',
            attempt: 1,
            blocked_at: ISO_NOW,
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-66-INPUT',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'turn_input_required',
            stop_reason_detail: 'operator input required',
            previous_session_id: 'session-prev-input',
            previous_thread_id: 'thread-prev-input',
            turn_control_state: 'operator_turn',
            progress_signal_state: 'heartbeat_only',
            pending_input: {
              request_id: 'request-nie-66-input',
              prompt_text: 'Approve continuation?',
              questions: [{ id: 'approval', label: 'Approval' }],
              input_schema_type: 'text',
              input_required_at: ISO_NOW
            }
          }
        ]
      }),
      onInputSubmit: (issueIdentifier, payload) => {
        inputSubmissions.push({ issueIdentifier, payload });
      }
    });
    page.on('dialog', async (dialog) => {
      await dialog.accept(dialog.message().includes('Reason note') ? 'operator note' : 'approved');
    });

    await page.goto('/');

    const row = page.locator('#blocked-rows tr').filter({ hasText: 'NIE-66-INPUT' });
    await expect(row.getByRole('button', { name: 'Reply' })).toBeVisible();

    await row.getByRole('button', { name: 'Reply' }).click();

    await expect.poll(() => inputSubmissions.length).toBe(1);
    expect(inputSubmissions[0]).toMatchObject({
      issueIdentifier: 'NIE-66-INPUT',
      payload: {
        request_id: 'request-nie-66-input',
        reason_note: 'operator note'
      }
    });
  });

  test('issue detail renders phase timeline and preserves context across transition', async ({ page }) => {
    let scenario: 'running' | 'retrying' = 'running';
    await installDashboardApiMocks(page, {
      state: () => {
        if (scenario === 'running') {
          return baseState({
            running: [
              {
                issue_identifier: 'NIE-25',
                state: 'running',
                session_id: 'session-transition-1',
                worker_host: 'hessian',
                workspace_path: '/tmp/workspaces/NIE-25',
                provisioner_type: 'git_worktree',
                branch_name: 'feature/NIE-25',
                workspace_git_status: 'clean',
                started_at: ISO_OLD,
                turn_count: 1,
                tokens: { total_tokens: 100, input_tokens: 60, output_tokens: 40 },
                last_event_summary: 'planning',
                last_event: 'codex.phase.planning',
                last_message: 'planning',
                last_event_at: ISO_NOW,
                thread_id: 'thread-transition',
                turn_id: 'turn-transition',
                current_phase: 'planning',
                current_phase_at: ISO_NOW,
                phase_elapsed_ms: 1000,
                phase_detail: 'plan created'
              }
            ]
          });
        }

        return baseState({
          running: [],
          retrying: [
            {
              issue_identifier: 'NIE-25',
              attempt: 2,
              due_at: ISO_NOW,
              worker_host: 'hessian',
              workspace_path: '/tmp/workspaces/NIE-25',
              provisioner_type: 'git_worktree',
              branch_name: 'feature/NIE-25',
              workspace_git_status: 'clean',
              workspace_exists: true,
              workspace_provisioned: true,
              workspace_is_git_worktree: true,
              stop_reason_code: 'retryable_error',
              stop_reason_detail: 'transient failure',
              previous_session_id: 'session-transition-1',
              previous_thread_id: 'thread-transition',
              error: 'timeout',
              last_phase: 'implementation',
              last_phase_at: ISO_NOW,
              last_phase_detail: 'call external tool'
            }
          ]
        });
      },
      onRefresh: () => {
        scenario = 'retrying';
      },
      issues: {
        'NIE-25': {
          issue_identifier: 'NIE-25',
          status: 'retrying',
          workspace: { path: '/tmp/workspaces/NIE-25' },
          retry: {
            stop_reason_code: 'retryable_error',
            previous_session_id: 'session-transition-1',
            last_phase: 'implementation',
            last_phase_at: ISO_NOW,
            last_phase_detail: 'call external tool'
          },
          blocked: null,
          running: null,
          phase_timeline: [
            {
              at: '2026-04-30T09:59:00.000Z',
              phase: 'planning',
              attempt: 1,
              detail: 'plan created',
              thread_id: 'thread-transition',
              session_id: 'session-transition-1'
            },
            {
              at: '2026-04-30T09:59:30.000Z',
              phase: 'implementation',
              attempt: 1,
              detail: 'call external tool',
              thread_id: 'thread-transition',
              session_id: 'session-transition-1'
            }
          ]
        }
      }
    });

    await page.goto('/');

    await expect(page.locator('#running-rows')).toContainText('NIE-25');

    await page.getByRole('button', { name: 'Refresh Now' }).click();

    await expect(page.locator('#retry-rows')).toContainText('NIE-25');
    await expect(page.locator('#retry-rows')).toContainText('Last phase: implementation');

    await page.locator('#issue-input').fill('NIE-25');
    await page.locator('#issue-load').click();

    await expect(page.locator('#issue-summary')).toContainText('Last phase before stop: implementation');
    await expect(page.locator('#issue-output')).toContainText('Execution Timeline');
    await expect(page.locator('#issue-output')).toContainText('planning');
    await expect(page.locator('#issue-output')).toContainText('implementation');
  });

  test('visibility badges render turn control, progress quality, token confidence, degraded banner, freshness, and action trail', async ({ page }) => {
    await installDashboardApiMocks(page, {
      state: baseState({
        api_degraded_mode: true,
        api_degraded_reason_code: 'route_not_found',
        api_degraded_routes: ['/api/v1/issues/:issue_identifier'],
        running: [
          {
            issue_identifier: 'NIE-53',
            state: 'running',
            session_id: 'session-visibility-1',
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-53',
            started_at: ISO_OLD,
            turn_count: 2,
            tokens: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
            token_telemetry_status: 'unavailable',
            token_telemetry_confidence: 'missing',
            token_telemetry_source: null,
            last_event_summary: 'codex turn waiting',
            last_event: 'codex.turn.waiting',
            last_message: 'waiting',
            last_event_at: ISO_NOW,
            thread_id: 'thread-visibility',
            turn_id: 'turn-visibility',
            current_phase: 'planning',
            current_phase_at: ISO_OLD,
            phase_elapsed_ms: 120000,
            turn_control_state: 'operator_turn',
            turn_control_reason_code: 'turn_input_required',
            turn_control_since_ms: Date.parse(ISO_OLD),
            progress_signal_state: 'heartbeat_only',
            last_progress_transition_at_ms: Date.parse(ISO_OLD),
            last_heartbeat_at_ms: Date.parse(ISO_NOW),
            not_blocked_explainer_code: 'within_wait_threshold',
            not_blocked_explainer_text: 'The run is emitting waiting heartbeats and remains within the configured blocked-transition threshold.',
            operator_actions: [
              {
                action: 'submit_input',
                requested_at_ms: Date.parse(ISO_NOW),
                result: 'rejected',
                result_code: 'input_submission_invalid',
                message: 'invalid answer'
              }
            ]
          }
        ]
      }),
      issues: {
        'NIE-53': {
          issue_identifier: 'NIE-53',
          status: 'running',
          snapshot_generated_at_ms: Date.parse(ISO_NOW),
          snapshot_age_ms: 0,
          snapshot_freshness_state: 'fresh',
          api_degraded_mode: true,
          api_degraded_reason_code: 'route_not_found',
          workspace: { path: '/tmp/workspaces/NIE-53' },
          running: {
            current_phase: 'planning',
            turn_control_state: 'operator_turn',
            progress_signal_state: 'heartbeat_only',
            token_telemetry_confidence: 'missing',
            not_blocked_explainer_text: 'The run is emitting waiting heartbeats and remains within the configured blocked-transition threshold.'
          },
          retry: null,
          blocked: null,
          operator_actions: [
            {
              action: 'submit_input',
              requested_at_ms: Date.parse(ISO_NOW),
              result: 'rejected',
              result_code: 'input_submission_invalid',
              message: 'invalid answer'
            }
          ],
          phase_timeline: [],
          recent_events: []
        }
      }
    });

    await page.goto('/');

    await expect(page.locator('#last-updated')).toContainText('fresh');
    await expect(page.locator('#api-degraded-banner')).toContainText('route_not_found');
    await expect(page.locator('#running-rows')).toContainText('Operator Turn');
    await expect(page.locator('#running-rows')).toContainText('Heartbeat Only');
    await expect(page.locator('#running-rows')).toContainText('Missing telemetry');
    await expect(page.locator('#running-rows')).toContainText('Why not blocked:');
    await expect(page.locator('#running-rows')).toContainText('Last action: submit_input rejected');

    await page.locator('#issue-input').fill('NIE-53');
    await page.locator('#issue-load').click();

    await expect(page.locator('#issue-summary')).toContainText('API degraded: route_not_found');
    await expect(page.locator('#issue-summary')).toContainText('Turn control: Operator Turn');
    await expect(page.locator('#issue-output')).toContainText('Operator Action Outcomes');
    await expect(page.locator('#issue-output')).toContainText('submit_input');
  });
});
