import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTION_REQUIRED_CODES, OPERATOR_TRANSITION_RULES } from '../../src/api/dashboard-client/config';
import {
  formatApiError,
  formatElapsedMs,
  formatNumber,
  formatOverviewTokenValue,
  formatTokenBreakdown,
  getActionRequiredLabel,
  getProgressSignalLabel,
  getRetryStateLabel,
  getTokenConfidenceLabel,
  getTurnControlLabel
} from '../../src/api/dashboard-client/formatting';
import {
  formatHeroSnapshotFreshness,
  getConnectionClass,
  getConnectionLabel,
  handleSseEnvelope,
  loadDiagnostics,
  loadUiState,
  refreshNow,
  schedulePollingFallback,
  scheduleStateSave
} from '../../src/api/dashboard-client/connection';
import { elements, setDashboardElements } from '../../src/api/dashboard-client/dom';
import {
  formatDiagnosticSummary,
  formatConversationSummary,
  formatInputDecisionContext,
  loadIssue,
  renderConversation,
  renderIssueExplainer,
  renderThreadDiagnostics,
  renderTimelineLane,
  spanLabel
} from '../../src/api/dashboard-client/issue-detail';
import { renderBlocked, renderRetry, renderRunning, rowMatchesFilter } from '../../src/api/dashboard-client/issues';
import {
  buildBlockedInputRequest,
  buildCancelRequest,
  buildDrainControlRequest,
  buildOperatorActionRequest,
  buildResumeRequest,
  cancelBlockedIssue,
  resumeBlockedIssue,
  runOperatorAction,
  waitForDrainQuiescence,
  submitBlockedInput
} from '../../src/api/dashboard-client/operator-actions';
import {
  computeDisplayRuntimeSeconds,
  deriveOperatorTransitionRows,
  describeTransition,
  renderActionRequiredBanner,
  renderApiDegradedBanner,
  renderOverview,
  renderRateLimits
} from '../../src/api/dashboard-client/overview';
import {
  createFactBadges,
  createProjectHistoryEmptyRow,
  factClass,
  loadProjectHistory,
  loadProjectHistoryDetail,
  projectKeyFromHistoryPayload,
  renderProjectHistory,
  renderProjectHistoryDetail,
  summarizeProjectHistoryHealth,
  summarizeProjectHistoryMetrics,
  summarizeProjectHistoryReferences
} from '../../src/api/dashboard-client/project-history';
import { renderRuntimeEvents } from '../../src/api/dashboard-client/runtime';
import { resolveDashboardClientConstants } from '../../src/api/dashboard-client/server-config';
import { REASON_CODES } from '../../src/observability';
import {
  mergeStoppedRunRecoveryPayload,
  normalizeStoppedRunRecoveryPayload,
  loadStoppedRunRecovery,
  renderStoppedRunRecovery,
  recoveryStatusLabel
} from '../../src/api/dashboard-client/stopped-runs';
import { state } from '../../src/api/dashboard-client/state';

class FakeElement {
  textContent = '';
  className = '';
  title = '';
  type = '';
  colSpan = 0;
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  value = '';
  disabled = false;
  open = false;
  dataset: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};
  classList = {
    add: (...names: string[]) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      names.forEach((name) => classes.add(name));
      this.className = Array.from(classes).join(' ');
    },
    remove: (...names: string[]) => {
      const removeSet = new Set(names);
      this.className = this.className
        .split(/\s+/)
        .filter((name) => name && !removeSet.has(name))
        .join(' ');
    },
    contains: (name: string) => this.className.split(/\s+/).includes(name)
  };

  append(...children: FakeElement[]) {
    this.children.push(...children);
  }

  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]) {
    this.children = children;
  }

  setAttribute(name: string, value: string) {
    this.dataset[name] = value;
  }

  getAttribute(name: string) {
    return this.dataset[name] || null;
  }

  addEventListener(event: string, listener: Function) {
    this.listeners[event] = this.listeners[event] || [];
    this.listeners[event].push(listener);
  }

  click() {
    for (const listener of this.listeners.click || []) {
      listener({ stopPropagation: vi.fn() });
    }
  }

  select() {
    // no-op for copy fallback tests
  }
}

function makeDashboardElements() {
  return {
    connectionBadge: new FakeElement(),
    connectionDetail: new FakeElement(),
    lastUpdated: new FakeElement(),
    refreshButton: new FakeElement(),
    refreshStatus: new FakeElement(),
    healthMessage: new FakeElement(),
    lastError: new FakeElement(),
    actionRequiredBanner: new FakeElement(),
    actionRequiredTitle: new FakeElement(),
    actionRequiredSummary: new FakeElement(),
    actionRequiredGroups: new FakeElement(),
    runtimeStaleBanner: new FakeElement(),
    runtimeStaleTitle: new FakeElement(),
    runtimeStaleSummary: new FakeElement(),
    runtimeUpdateBanner: new FakeElement(),
    runtimeUpdateTitle: new FakeElement(),
    runtimeUpdateSummary: new FakeElement(),
    runtimeUpdatePrepareButton: new FakeElement(),
    runtimeUpdateApplyButton: new FakeElement(),
    runtimeUpdatePanel: new FakeElement(),
    runtimeUpdatePreparePanelButton: new FakeElement(),
    runtimeUpdateApplyPanelButton: new FakeElement(),
    runtimeUpdateState: new FakeElement(),
    runtimeUpdateRecommendation: new FakeElement(),
    runtimeUpdateStatus: new FakeElement(),
    runtimeUpdateDetails: new FakeElement(),
    drainModePanel: new FakeElement(),
    drainModeSummary: new FakeElement(),
    drainModeBoundary: new FakeElement(),
    drainModeMeta: new FakeElement(),
    drainBlockersList: new FakeElement(),
    drainControlStatus: new FakeElement(),
    drainEnterButton: new FakeElement(),
    drainExitButton: new FakeElement(),
    drainWaitButton: new FakeElement(),
    drainShutdownButton: new FakeElement(),
    apiDegradedBanner: new FakeElement(),
    apiDegradedTitle: new FakeElement(),
    apiDegradedSummary: new FakeElement(),
    snapshotErrorPanel: new FakeElement(),
    snapshotErrorMessage: new FakeElement(),
    kpiGrid: new FakeElement(),
    retryStatusSummary: new FakeElement(),
    rateLimits: new FakeElement(),
    throughputPanel: new FakeElement(),
    throughputOutput: new FakeElement(),
    runtimeResolutionOutput: new FakeElement(),
    runningRows: new FakeElement(),
    retryRows: new FakeElement(),
    blockedRows: new FakeElement(),
    stoppedRunRecoveryList: new FakeElement(),
    stoppedRunRecoveryLoad: new FakeElement(),
    projectHistoryProjectKey: new FakeElement(),
    projectHistoryLoad: new FakeElement(),
    projectHistoryStatus: new FakeElement(),
    projectHistoryFacts: new FakeElement(),
    projectHistoryRows: new FakeElement(),
    projectHistoryDetail: new FakeElement(),
    statusFilter: new FakeElement(),
    runningFilter: new FakeElement(),
    issuePanel: new FakeElement(),
    issueInput: new FakeElement(),
    issueLoad: new FakeElement(),
    issueOpenJson: new FakeElement(),
    issueSummary: new FakeElement(),
    conversationSummary: new FakeElement(),
    conversationList: new FakeElement(),
    conversationRoleFilter: new FakeElement(),
    conversationDensity: new FakeElement(),
    issueExplainerCard: new FakeElement(),
    issueExplainerActionability: new FakeElement(),
    issueExplainerHeadline: new FakeElement(),
    issueExplainerClassification: new FakeElement(),
    issueExplainerReason: new FakeElement(),
    issueExplainerAction: new FakeElement(),
    issueExplainerTransition: new FakeElement(),
    issueExplainerVersion: new FakeElement(),
    issueExplainerDetail: new FakeElement(),
    threadDetail: new FakeElement(),
    threadTimelineLanes: new FakeElement(),
    threadBlockerCard: new FakeElement(),
    threadCapabilityWarnings: new FakeElement(),
    threadRawEvents: new FakeElement(),
    issueOutput: new FakeElement(),
    runtimeEventsPanel: new FakeElement(),
    eventFeedFilter: new FakeElement(),
    runtimeEventsList: new FakeElement(),
    diagnosticsOutput: new FakeElement(),
    historyList: new FakeElement()
  };
}

function resetDashboardModuleState() {
  ACTION_REQUIRED_CODES.turn_input_required = 'Turn Input Required';
  OPERATOR_TRANSITION_RULES.eventMap['operator_resume_accepted'] = 'resume_accepted';
  OPERATOR_TRANSITION_RULES.eventMap['orchestration.blocked_input.resumed'] = 'resume_accepted';
  OPERATOR_TRANSITION_RULES.detailMap['resume accepted'] = 'resume_accepted';
  Object.assign(state, {
    payload: null,
    lastGoodPayload: null,
    selectedIssue: '',
    connection: 'offline',
    pollTimer: null,
    pollDelayMs: 4000,
    streamConnected: false,
    streamSnapshotHealthy: false,
    streamFallbackReason: 'connecting',
    uiStateLoaded: false,
    uiStateSaveTimer: null,
    stoppedRunRecoveryLoaded: false,
    stoppedRunRecoveryLoading: false,
    stoppedRunRecoveryPayload: null,
    projectHistory: {
      projectKey: '',
      loading: false,
      detailLoadingTicketKey: null,
      listPayload: null,
      healthPayload: null,
      detailPayload: null,
      error: null,
      detailError: null
    },
    filter: {
      query: '',
      status: 'all',
      eventFeedSeverity: 'all',
      blockedReason: 'all',
      conversationRole: 'all',
      conversationDensity: 'comfortable'
    },
    panels: {
      throughputOpen: true,
      runtimeEventsOpen: true
    },
    runtimeResolution: null
  });
  setDashboardElements(makeDashboardElements());
  vi.stubGlobal('document', {
    createElement: () => new FakeElement(),
    querySelectorAll: () => []
  });
  const localStorageValues = new Map<string, string>([['symphony.stoppedRunAcknowledged', '[]']]);
  vi.stubGlobal('window', {
    prompt: vi.fn(() => 'reason note'),
    confirm: vi.fn(() => true),
    localStorage: {
      getItem: vi.fn((key: string) => localStorageValues.get(key) || null),
      setItem: vi.fn((key: string, value: string) => {
        localStorageValues.set(key, value);
      })
    },
    open: vi.fn()
  });
}

function jsonResponse(payload: any, ok = true) {
  return {
    ok,
    json: vi.fn().mockResolvedValue(payload)
  };
}

function snapshotPayload(overrides: any = {}) {
  return {
    generated_at: '2026-05-21T10:00:00.000Z',
    counts: {
      running: 0,
      retrying: 0,
      blocked: 0,
      stopped: 0,
      running_stalled_waiting_count: 0,
      running_awaiting_input_count: 0
    },
    codex_totals: {
      total_tokens: 100,
      input_tokens: 40,
      output_tokens: 60,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      model_context_window: 200000,
      seconds_running: 12
    },
    health: { dispatch_validation: 'ok' },
    retrying: [],
    blocked: [],
    running: [],
    recent_runtime_events: [],
    ...overrides
  };
}

function collectText(node: any): string {
  return [node.textContent, ...(node.children || []).map(collectText)].filter(Boolean).join(' ');
}

describe('dashboard browser client modules', () => {
  beforeEach(() => {
    resetDashboardModuleState();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('normalizes dashboard client config defaults and minimum values', () => {
    expect(
      resolveDashboardClientConstants({
        dashboard_enabled: undefined,
        refresh_ms: 10,
        render_interval_ms: 10,
        phase_stale_warn_ms: 10
      } as never).safeConfig
    ).toEqual({
      dashboard_enabled: true,
      refresh_ms: 500,
      render_interval_ms: 250,
      phase_stale_warn_ms: 1000
    });

    expect(resolveDashboardClientConstants({ dashboard_enabled: false } as never).safeConfig).toMatchObject({
      dashboard_enabled: false,
      refresh_ms: 4000,
      render_interval_ms: 1000,
      phase_stale_warn_ms: 45000
    });
  });

  it('formats numbers, durations, connection labels, and state labels directly', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(Number.NaN)).toBe('0');
    expect(formatElapsedMs(65000)).toBe('1m 5s');
    expect(formatElapsedMs(Number.NaN)).toBe('n/a');
    expect(getConnectionLabel('streaming')).toBe('Streaming');
    expect(getConnectionClass('polling')).toBe('badge badge-polling');
    state.payload = snapshotPayload({
      snapshot_generated_at_ms: Date.parse('2026-05-21T09:59:12.000Z'),
      snapshot_age_ms: 48_000,
      snapshot_freshness_state: 'fresh'
    });
    expect(formatHeroSnapshotFreshness('2026-05-21T09:59:12.000Z')).toMatchObject({
      text: 'Updated just now • Snapshot fresh'
    });
    state.payload = snapshotPayload({
      snapshot_generated_at_ms: Date.parse('2026-05-21T09:54:00.000Z'),
      snapshot_age_ms: 360_000,
      snapshot_freshness_state: 'stale'
    });
    expect(formatHeroSnapshotFreshness('2026-05-21T09:54:00.000Z')).toMatchObject({
      text: 'Updated 6m ago • Snapshot stale'
    });
    expect(getTurnControlLabel('blocked_manual_resume')).toBe('Manual Resume Required');
    expect(getProgressSignalLabel('stalled_waiting')).toBe('Stalled Waiting');
    expect(getRetryStateLabel({ due_state: 'overdue' })).toBe('Retry Overdue');
    expect(getTokenConfidenceLabel('observed_live')).toBe('Live');
  });

  it('keeps aggregate-only token split behavior importable', () => {
    expect(
      formatOverviewTokenValue(
        {
          codex_totals: {
            token_split_status: 'aggregate_only',
            input_tokens: 0
          }
        },
        'input_tokens',
        'Split unavailable'
      )
    ).toBe('Split unavailable');

    expect(
      formatTokenBreakdown(
        {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 321,
          token_split_status: 'aggregate_only'
        },
        'codex_home_state_sqlite'
      )
    ).toContain('Split unavailable');
  });

  it('formats action-required labels and API errors without the generated asset', () => {
    expect(resolveDashboardClientConstants({} as never).actionRequiredReasonLabels.missing_tool_output_recovery_exhausted).toBe(
      'Missing Tool Output Recovery Exhausted'
    );
    expect(getActionRequiredLabel(null)).toBe('unknown');
    expect(formatApiError({ error: { code: 'bad_request', message: 'Bad request' } }, 'Request failed')).toBe(
      'bad_request: Bad request'
    );
    expect(formatApiError({ error: { message: 'Unavailable' } }, 'Request failed')).toBe('Unavailable');
    expect(formatApiError(null, 'Request failed')).toBe('Request failed');
  });

  it('exposes direct connection behavior for polling fallback and SSE refresh envelopes', () => {
    vi.useFakeTimers();

    state.streamConnected = true;
    state.streamSnapshotHealthy = true;
    schedulePollingFallback();
    expect(state.pollTimer).toBeNull();

    state.streamSnapshotHealthy = false;
    schedulePollingFallback();
    expect(state.pollTimer).not.toBeNull();

    handleSseEnvelope({ type: 'refresh_accepted', payload: { accepted: { coalesced: true } } });
    expect(elements.refreshStatus.textContent).toBe('Refresh request coalesced');
  });

  it('keeps issue row filtering importable for running, retry, blocked, query, and reason filters', () => {
    const entry = { issue_identifier: 'NIE-217', state: 'In Progress' };
    expect(rowMatchesFilter(entry)).toBe(true);

    state.filter.query = 'missing';
    expect(rowMatchesFilter(entry)).toBe(false);

    state.filter.query = 'NIE';
    state.filter.status = 'retrying';
    expect(rowMatchesFilter(entry)).toBe(false);

    state.filter.status = 'blocked';
    expect(rowMatchesFilter(entry)).toBe(false);
  });

  it('renders running, retry, and blocked table regions directly', () => {
    renderRunning({
      running: [
        {
          issue_identifier: 'NIE-217',
          state: 'In Progress',
          session_id: 'session-1',
          current_phase: 'implementation',
          started_at: '2026-05-21T10:00:00.000Z',
          turn_count: 2,
          tokens: { total_tokens: 321, input_tokens: 0, output_tokens: 0, token_split_status: 'aggregate_only' },
          token_telemetry_status: 'available',
          token_telemetry_confidence: 'observed_live',
          current_blocker_class: 'none',
          last_successful_step: 'tests',
          conversation_latest: {
            role: 'assistant',
            source: 'runtime_event',
            summary: 'latest agent thought',
            at: '2026-05-21T10:01:00.000Z'
          },
          last_event_at: '2026-05-21T10:01:00.000Z'
        }
      ]
    });
    expect(collectText(elements.runningRows)).toContain('NIE-217');
    expect(collectText(elements.runningRows)).toContain('Split unavailable');
    expect(collectText(elements.runningRows)).toContain('latest agent thought');

    renderRetry({ retrying: [] });
    expect(collectText(elements.retryRows)).toContain('No issues are waiting for retry.');

    renderBlocked({
      blocked: [
        {
          issue_identifier: 'NIE-217',
          attempt: 1,
          blocked_at: '2026-05-21T10:00:00.000Z',
          stop_reason_code: 'turn_input_required',
          pending_input: { request_id: 'req-1' }
        }
      ]
    });
    expect(collectText(elements.blockedRows)).toContain('NIE-217');
    expect(collectText(elements.blockedRows)).toContain('Reply');
  });

  it('renders blocked-row actions from backend advertised capabilities', () => {
    renderBlocked({
      blocked: [
        {
          issue_identifier: 'NIE-217',
          attempt: 1,
          blocked_at: '2026-05-21T10:00:00.000Z',
          stop_reason_code: 'turn_input_required',
          runtime_state_kind: 'blocked_input',
          pending_input: null,
          available_actions: [
            {
              id: 'resume',
              label: 'Mark Acceptance Complete + Resume',
              endpoint: '/api/v1/issues/NIE-217/resume',
              method: 'POST',
              requires_reason_note: true,
              destructive: false
            },
            {
              id: 'cancel',
              label: 'Cancel to Backlog',
              endpoint: '/api/v1/issues/NIE-217/cancel',
              method: 'POST',
              requires_reason_note: true,
              destructive: true
            }
          ]
        }
      ]
    });

    const text = collectText(elements.blockedRows);
    expect(text).toContain('Mark Acceptance Complete + Resume');
    expect(text).toContain('Cancel to Backlog');
    expect(text).not.toContain('Requeue');
  });

  it('renders automation-fault recovery action without invalid blocked-input buttons', () => {
    renderBlocked({
      blocked: [
        {
          issue_identifier: 'NIE-229',
          attempt: 0,
          blocked_at: '2026-05-23T11:36:49.000Z',
          stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
          runtime_state_kind: 'automation_fault',
          pending_input: null,
          breaker_active: true,
          breaker_hit_count: 3,
          breaker_window_minutes: 30,
          available_actions: [
            {
              id: 'clear_automation_fault',
              label: 'Clear Fault + Retry',
              endpoint: '/api/v1/issues/NIE-229/clear-automation-fault',
              method: 'POST',
              requires_reason_note: true,
              destructive: false
            }
          ]
        }
      ]
    });

    const text = collectText(elements.blockedRows);
    expect(text).toContain('Clear Fault + Retry');
    expect(text).toContain('No-progress redispatch circuit breaker: 3 hit(s) in 30m.');
    expect(text).not.toContain('Mark Acceptance Complete + Resume');
    expect(text).not.toContain('Push Commit + Resume');
    expect(text).not.toContain('Cancel to Backlog');
    expect(text).not.toContain('Requeue');
  });

  it('renders runtime event empty and filtered states directly', () => {
    renderRuntimeEvents({ recent_runtime_events: [] });
    expect(collectText(elements.runtimeEventsList)).toContain('No runtime events.');

    state.filter.eventFeedSeverity = 'warn';
    renderRuntimeEvents({
      recent_runtime_events: [
        { severity: 'info', event: 'ignored', at: '2026-05-21T10:00:00.000Z' },
        { severity: 'warn', event: 'kept', at: '2026-05-21T10:00:00.000Z', detail: 'detail' }
      ]
    });
    expect(collectText(elements.runtimeEventsList)).toContain('[warn] kept');
    expect(collectText(elements.runtimeEventsList)).not.toContain('ignored');
  });

  it('constructs operator action request payloads directly', () => {
    expect(JSON.parse(buildResumeRequest('reviewed', 'operator_override').body)).toEqual({
      resume_override_reason: 'operator_override',
      reason_note: 'reviewed'
    });
    expect(JSON.parse(buildCancelRequest('cancel note', 'operator_cancel').body)).toEqual({
      cancel_reason: 'operator_cancel',
      reason_note: 'cancel note',
      confirmed: true
    });
    expect(JSON.parse(buildOperatorActionRequest('retry note', true).body)).toEqual({
      reason_note: 'retry note',
      confirmed: true
    });
    expect(JSON.parse(buildBlockedInputRequest({ request_id: 'req-1' }, 'answer note', { text: 'yes' }).body)).toEqual({
      request_id: 'req-1',
      reason_note: 'answer note',
      answer: { text: 'yes' }
    });
  });

  it('covers stopped-run recovery normalization, merge, and status labels directly', () => {
    expect(recoveryStatusLabel('resume_available')).toBe('Resume available');
    expect(normalizeStoppedRunRecoveryPayload({ stopped_runs: [{ run_id: 'run-1' }], counts: { stopped: 1 } })).toEqual({
      stopped_runs: [{ run_id: 'run-1' }],
      counts: { stopped: 1 }
    });
    expect(mergeStoppedRunRecoveryPayload({ counts: { running: 2 } }, { stopped_runs: [], counts: { stopped: 3 } })).toEqual({
      stopped_runs: [],
      counts: { running: 2, stopped: 3 }
    });

    setDashboardElements({ ...elements, stoppedRunRecoveryList: new FakeElement() });
    state.stoppedRunRecoveryLoaded = false;
    renderStoppedRunRecovery({ stopped_runs: [] });
    expect(collectText(elements.stoppedRunRecoveryList)).toContain('loads on demand');
  });

  it('covers project history summaries, fallback health text, and empty row rendering directly', () => {
    expect(projectKeyFromHistoryPayload({ runs: [{ identity: { project: { key: 'symphony' } } }] })).toBe('symphony');
    expect(summarizeProjectHistoryReferences({ summary: { evidence_reference_count: 1, tracker_snapshot_count: 2 } })).toContain(
      'evidence 1'
    );
    expect(summarizeProjectHistoryMetrics({ summary: { attempt_count: 2, total_tokens: null } })).toContain('tokens n/a');
    expect(summarizeProjectHistoryHealth({ status: 'degraded', enabled: true, diagnostics: [{ status: 'missing' }] })).toContain(
      'Health: degraded'
    );
    expect(factClass('present')).toContain('mini-badge-good');
    const row = createProjectHistoryEmptyRow('No project history.');
    expect(row.children[0].textContent).toBe('No project history.');
  });

  it('renders overview empty, aggregate-only, degraded, and action-required states directly', () => {
    vi.setSystemTime(new Date('2026-05-21T10:00:12.000Z'));

    renderOverview(
      snapshotPayload({
        generated_at: '2026-05-21T10:00:00.000Z',
        codex_totals: {
          total_tokens: 123,
          input_tokens: 0,
          output_tokens: 0,
          token_split_status: 'aggregate_only',
          seconds_running: 5
        },
        provider_totals: [
          {
            final_invocation_count: 2,
            partial_invocation_count: 1,
            unobserved_invocation_count: 3,
            missing_invocation_count: 4
          }
        ],
        retry_status: {
          entries: [
            {
              issue_identifier: 'NIE-217',
              due_state: 'overdue',
              overdue_ms: 65000,
              reason_code: 'missing_tool_output',
              operator_detail: 'tool output missing'
            }
          ]
        }
      })
    );
    expect(collectText(elements.kpiGrid)).toContain('Split unavailable');
    expect(collectText(elements.kpiGrid)).toContain('Runtime Seconds 17');
    expect(collectText(elements.kpiGrid)).toContain('Provider Final Invocations 2');
    expect(collectText(elements.kpiGrid)).toContain('Provider Partial Invocations 1');
    expect(collectText(elements.kpiGrid)).toContain('Provider Unobserved Invocations 3');
    expect(collectText(elements.kpiGrid)).toContain('Provider Missing Invocations 4');
    expect(collectText(elements.kpiGrid)).toContain('Provider Coverage Gaps 8');
    expect(collectText(elements.retryStatusSummary)).toContain('1 overdue retry needs attention');

    renderActionRequiredBanner({ blocked: [] });
    expect(elements.actionRequiredBanner.className).toContain('hidden');

    renderActionRequiredBanner({ blocked: [{ stop_reason_code: 'turn_input_required' }, { stop_reason_code: 'turn_input_required' }] });
    expect(elements.actionRequiredBanner.className).not.toContain('hidden');
    expect(elements.actionRequiredSummary.textContent).toBe('2 blocked runs need operator action.');
    expect(collectText(elements.actionRequiredGroups)).toContain('Turn Input Required (2)');

    renderApiDegradedBanner(null);
    expect(elements.apiDegradedBanner.className).toContain('hidden');
    renderApiDegradedBanner({ api_degraded_mode: true, api_degraded_reason_code: 'state_unavailable', api_degraded_routes: ['/api/v1/state'] });
    expect(elements.apiDegradedSummary.textContent).toBe('state_unavailable • fallback routes: /api/v1/state');

    expect(computeDisplayRuntimeSeconds(snapshotPayload({ codex_totals: { seconds_running: 5 } }))).toBe(17);
    expect(describeTransition('resume_accepted')).toMatchObject({ label: 'Resume Accepted', result: 'success' });
    expect(
      deriveOperatorTransitionRows('NIE-217', {
        recent_events: [{ at: '2026-05-21T10:00:00.000Z', event: 'operator_resume_accepted', message: 'resumed' }]
      })
    ).toEqual([
      {
        at: '2026-05-21T10:00:00.000Z',
        issue_identifier: 'NIE-217',
        label: 'Resume Accepted',
        result: 'success',
        detail: 'resumed'
      }
    ]);
  });

  it('renders rate limits as visual cards instead of raw JSON', () => {
    vi.setSystemTime(new Date('2026-05-24T08:00:00.000Z'));

    renderRateLimits(null);
    expect(collectText(elements.rateLimits)).toContain('No rate limits reported');
    expect(collectText(elements.rateLimits)).toContain('idle');

    renderRateLimits({
      primary: {
        remaining: 8,
        limit: 10,
        resetAt: '2026-05-24T09:00:00.000Z',
        window_minutes: 300,
        updatedAt: '2026-05-24T07:55:00.000Z'
      },
      secondary_pool: {
        remaining: 8,
        limit: 100,
        used_percent: 92,
        resetAt: '2026-05-31T08:00:00.000Z',
        window_seconds: 604800,
        policy: 'burst'
      }
    });

    const rendered = collectText(elements.rateLimits);
    expect(rendered.match(/Latest snapshot/g)).toHaveLength(1);
    expect(rendered).toContain('Primary');
    expect(rendered).toContain('Remaining 8');
    expect(rendered).toContain('Used 20%');
    expect(rendered).toContain('Capacity used 20%');
    expect(rendered).toContain('Window progress 80%');
    expect(rendered).toContain('Limit 10');
    expect(rendered).toContain('UTC 2026-05-24T09:00:00.000Z');
    expect(rendered).toContain('Resets in: 1h 0m');
    expect(rendered).toContain('Window: 5h 0m');
    expect(rendered).toContain('Schedule on schedule');
    expect(rendered).toContain('Balance Surplus +6');
    expect(rendered).toContain('Projection Run-out in 16h 0m');
    expect(rendered).toContain('Latest snapshot:');
    expect(rendered).toContain('Secondary Pool');
    expect(rendered).toContain('near limit');
    expect(rendered).toContain('Schedule deficit');
    expect(rendered).toContain('Balance Deficit -92');
    expect(rendered).toContain('Current pace runs out before reset.');
    expect(rendered).not.toContain('{');
    expect(elements.rateLimits.children[1].children[1].children[0].style.width).toBe('20%');
    expect(elements.rateLimits.children[1].children[1].children[1].style.left).toBe('80%');
    expect(elements.rateLimits.children[2].className).toContain('rate-limit-card-critical');
  });

  it('renders partial rate-limit payloads without exposing JSON', () => {
    renderRateLimits({
      session_window: {
        remaining: 120,
        resetInSeconds: 1800
      }
    });

    const rendered = collectText(elements.rateLimits);
    expect(rendered).toContain('Session Window');
    expect(rendered).toContain('Remaining 120');
    expect(rendered).toContain('Used n/a');
    expect(rendered).toContain('Limit n/a');
    expect(rendered).toContain('Schedule schedule unknown');
    expect(rendered).toContain('Surplus n/a');
    expect(rendered).toContain('Window progress n/a');
    expect(rendered).not.toContain('{');
  });

  it('renders Drain Mode and quiescence status prominently in the overview', () => {
    renderOverview(
      snapshotPayload({
        drain_mode: {
          active: true,
          entered_at: '2026-05-21T09:59:00.000Z',
          entered_at_ms: Date.parse('2026-05-21T09:59:00.000Z'),
          updated_at: '2026-05-21T10:00:00.000Z',
          updated_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          reason: 'safe runtime restart'
        },
        quiescence: {
          safe_to_shutdown: false,
          state: 'blocked',
          updated_at: '2026-05-21T10:00:00.000Z',
          updated_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          blocker_counts: {
            active_worker: 1,
            live_codex_app_server_process: 1,
            pending_retry: 1,
            in_flight_tracker_write: 0,
            persistence_history_write: 0,
            unknown_degraded_blocker_source_health: 0,
            stale_runtime: 0,
            unknown_current_build_identity: 0
          },
          blockers: [
            {
              category: 'active_worker',
              count: 1,
              detail: 'ABC-1 is still running',
              issue_identifiers: ['ABC-1']
            }
          ]
        }
      })
    );

    expect(elements.healthMessage.textContent).toContain('Drain Mode: active');
    expect(elements.healthMessage.textContent).toContain('restart blocked');
    expect(collectText(elements.kpiGrid)).toContain('Safe To Shutdown No');
    expect(collectText(elements.kpiGrid)).toContain('Shutdown Blockers 3');
    expect(elements.lastError.textContent).toContain('ABC-1 is still running');
  });

  it('renders Drain Mode workflow controls, blockers, stale warning context, and timeout results', async () => {
    renderOverview(
      snapshotPayload({
        drain_mode: {
          active: true,
          entered_at: '2026-05-21T09:59:00.000Z',
          entered_at_ms: Date.parse('2026-05-21T09:59:00.000Z'),
          updated_at: '2026-05-21T10:00:00.000Z',
          updated_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          reason: 'safe runtime restart'
        },
        runtime_identity: {
          health_warning: {
            code: 'stale_runtime_build',
            severity: 'warning',
            message: 'Running runtime build is stale',
            recommended_action: 'Enter Drain Mode, wait for quiescence, rebuild, and restart Symphony.'
          },
          running_build: { identity: 'old', commit_sha: 'old' },
          current_build: { identity: 'new', commit_sha: 'new' },
          process_started_at: '2026-05-21T09:00:00.000Z'
        },
        quiescence: {
          safe_to_shutdown: false,
          state: 'blocked',
          updated_at: '2026-05-21T10:00:00.000Z',
          updated_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          blocker_counts: {
            active_worker: 2,
            live_codex_app_server_process: 1,
            pending_retry: 1,
            in_flight_tracker_write: 1,
            persistence_history_write: 1,
            unknown_degraded_blocker_source_health: 1,
            stale_runtime: 0,
            unknown_current_build_identity: 0
          },
          warnings: [
            {
              category: 'stale_runtime_warning',
              count: 1,
              detail: 'running code is stale',
              source: 'dispatch_safety',
              recommended_action: 'Enter Drain Mode, wait for quiescence, rebuild, and restart Symphony.'
            },
            {
              category: 'persistence_history_degraded',
              count: 1,
              detail: 'historical audit write failed',
              source: 'audit_health'
            }
          ],
          restart_guidance: {
            safe_to_restart: false,
            recommended_action: 'wait_for_true_shutdown_blockers',
            pending_work: [],
            detail: 'Wait for true blockers.'
          },
          blockers: [
            { category: 'active_worker', count: 2, detail: 'ABC-1 and ABC-2 are still running', issue_identifiers: ['ABC-1', 'ABC-2'] },
            { category: 'live_codex_app_server_process', count: 1, detail: 'app server pid 123 is live', issue_identifiers: [] },
            { category: 'pending_retry', count: 1, detail: 'retry queue has one held item', issue_identifiers: ['ABC-3'] },
            { category: 'in_flight_tracker_write', count: 1, detail: 'tracker mutation is pending', issue_identifiers: ['ABC-4'] },
            { category: 'persistence_history_write', count: 1, detail: 'history write is pending', issue_identifiers: ['ABC-5'] },
            { category: 'unknown_degraded_blocker_source_health', count: 1, detail: 'blocker source health is degraded', issue_identifiers: [] }
          ]
        }
      })
    );

    expect(elements.drainModeSummary.textContent).toContain('Drain Mode active');
    expect(elements.drainModeBoundary.textContent).toContain('Restart is not safe yet');
    expect(elements.drainModeBoundary.textContent).toContain('ABC-1 and ABC-2 are still running');
    expect(collectText(elements.drainBlockersList)).toContain('Active workers 2');
    expect(collectText(elements.drainBlockersList)).toContain('Agent runner processes 1');
    expect(collectText(elements.drainBlockersList)).toContain('Pending retries 1');
    expect(collectText(elements.drainBlockersList)).toContain('Tracker writes 1');
    expect(collectText(elements.drainBlockersList)).toContain('Current persistence/history writes 1');
    expect(collectText(elements.drainBlockersList)).toContain('Unknown/degraded current blocker source 1');
    expect(collectText(elements.drainBlockersList)).toContain('Stale runtime warning 1');
    expect(collectText(elements.drainBlockersList)).toContain('Audit-health degradation 1');
    expect(elements.drainEnterButton.disabled).toBe(true);
    expect(elements.drainExitButton.disabled).toBe(true);
    expect(elements.drainWaitButton.disabled).toBe(false);
    expect(elements.drainShutdownButton.disabled).toBe(true);
    expect(elements.drainModeMeta.textContent).toContain('restart warning, not an active worker count');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: false,
          status: 'timeout',
          reason: 'timeout',
          timed_out: true,
          waited_ms: 250,
          quiescence: {
            safe_to_shutdown: false,
            state: 'blocked',
            updated_at: '2026-05-21T10:00:01.000Z',
            updated_at_ms: Date.parse('2026-05-21T10:00:01.000Z'),
            blocker_counts: { active_worker: 1 },
            blockers: [{ category: 'active_worker', count: 1, detail: 'ABC-1 is still running', issue_identifiers: ['ABC-1'] }]
          },
          blockers: [{ category: 'active_worker', count: 1, issue_identifiers: ['ABC-1'], run_identifiers: [], reason: 'ABC-1 is still running' }]
        }, false)
      )
      .mockResolvedValueOnce(jsonResponse(snapshotPayload()));
    vi.stubGlobal('fetch', fetchMock);

    await waitForDrainQuiescence();

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/drain-mode/wait', expect.objectContaining({ method: 'POST' }));
    expect(elements.drainControlStatus.textContent).toContain('Drain wait timed out');
    expect(elements.drainControlStatus.textContent).toContain('ABC-1 is still running');
    expect(elements.drainControlStatus.textContent).toContain('No forced cancel was requested');

    expect(buildDrainControlRequest('maintenance')).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    });
  });

  it('renders pending Agent Review work as normal review work, not active agents', () => {
    renderOverview(
      snapshotPayload({
        counts: { running: 0, retrying: 0, blocked: 0, stopped: 0 },
        drain_mode: { active: true, reason: 'safe runtime restart' },
        runtime_identity: {
          health_warning: {
            code: 'stale_runtime_build',
            severity: 'warning',
            message: 'Running runtime build is stale',
            recommended_action: 'restart Symphony on the current build'
          }
        },
        quiescence: {
          safe_to_shutdown: true,
          state: 'safe',
          blocker_counts: {
            active_worker: 0,
            live_codex_app_server_process: 0,
            pending_retry: 0,
            in_flight_tracker_write: 0,
            persistence_history_write: 0,
            unknown_degraded_blocker_source_health: 0,
            stale_runtime: 0,
            unknown_current_build_identity: 0
          },
          warnings: [
            {
              category: 'stale_runtime_warning',
              count: 1,
              detail: 'running code is stale',
              source: 'dispatch_safety',
              recommended_action: 'restart Symphony on the current build'
            }
          ],
          restart_guidance: {
            safe_to_restart: true,
            recommended_action: 'restart_runtime_to_current_build',
            pending_work: [{ state: 'Agent Review', count: 1, maintenance_eligible: false }],
            detail: 'Restart/update Symphony before dispatching pending normal work.'
          },
          blockers: []
        }
      })
    );

    const drainText = collectText(elements.drainBlockersList);
    expect(elements.drainModeBoundary.textContent).toContain('Shutdown/restart is safe');
    expect(collectText(elements.kpiGrid)).toContain('Running 0');
    expect(collectText(elements.kpiGrid)).toContain('Shutdown Blockers 0');
    expect(drainText).toContain('Pending work 1');
    expect(drainText).toContain('Pending Agent Review normal review work 1');
    expect(drainText).toContain('not an active agent');
    expect(drainText).not.toContain('Active workers 1');
  });

  it('renders pending Merging work as maintenance-eligible, not active agents', () => {
    renderOverview(
      snapshotPayload({
        counts: { running: 0, retrying: 0, blocked: 0, stopped: 0 },
        drain_mode: { active: true, reason: 'safe runtime restart' },
        runtime_identity: {
          health_warning: {
            code: 'stale_runtime_build',
            severity: 'warning',
            message: 'Running runtime build is stale',
            recommended_action: 'restart Symphony on the current build'
          }
        },
        quiescence: {
          safe_to_shutdown: true,
          state: 'safe',
          blocker_counts: {
            active_worker: 0,
            live_codex_app_server_process: 0,
            pending_retry: 0,
            in_flight_tracker_write: 0,
            persistence_history_write: 0,
            unknown_degraded_blocker_source_health: 0,
            stale_runtime: 0,
            unknown_current_build_identity: 0
          },
          warnings: [
            {
              category: 'stale_runtime_warning',
              count: 1,
              detail: 'running code is stale',
              source: 'dispatch_safety',
              recommended_action: 'restart Symphony on the current build'
            }
          ],
          restart_guidance: {
            safe_to_restart: true,
            recommended_action: 'restart_runtime_to_current_build',
            pending_work: [{ state: 'Merging', count: 1, maintenance_eligible: true }],
            detail: 'Restart/update Symphony before dispatching pending normal work.'
          },
          blockers: []
        }
      })
    );

    const drainText = collectText(elements.drainBlockersList);
    expect(elements.drainModeBoundary.textContent).toContain('Shutdown/restart is safe');
    expect(collectText(elements.kpiGrid)).toContain('Running 0');
    expect(collectText(elements.kpiGrid)).toContain('Shutdown Blockers 0');
    expect(drainText).toContain('Pending work 1');
    expect(drainText).toContain('Pending Merging maintenance work 1');
    expect(drainText).toContain('maintenance-eligible');
    expect(drainText).toContain('not an active agent');
    expect(drainText).not.toContain('Active workers 1');
  });

  it('renders a stale runtime warning above the overview', () => {
    renderOverview(
      snapshotPayload({
        runtime_identity: {
          process_started_at: '2026-05-21T09:00:00.000Z',
          process_started_at_ms: Date.parse('2026-05-21T09:00:00.000Z'),
          running_build: {
            identity: 'runtime-old',
            commit_sha: 'runtime-old',
            source_timestamp: '2026-05-21T08:55:00.000Z',
            source_timestamp_ms: Date.parse('2026-05-21T08:55:00.000Z')
          },
          current_build: {
            identity: 'current-new',
            commit_sha: 'current-new',
            source_timestamp: '2026-05-21T09:30:00.000Z',
            source_timestamp_ms: Date.parse('2026-05-21T09:30:00.000Z'),
            status: 'available'
          },
          status: 'stale',
          health_warning: {
            code: 'stale_runtime_build',
            severity: 'warning',
            message: 'Running runtime build runtime-old is stale compared with current-new',
            recommended_action: 'Enter Drain Mode, wait for quiescence, rebuild, and restart Symphony.'
          }
        }
      })
    );

    expect(elements.runtimeStaleBanner.className).not.toContain('hidden');
    expect(elements.runtimeStaleTitle.textContent).toBe('Runtime build is stale');
    expect(elements.runtimeStaleSummary.textContent).toContain('runtime-old');
    expect(elements.runtimeStaleSummary.textContent).toContain('current-new');
    expect(elements.runtimeStaleSummary.textContent).toContain('Process started');
    expect(elements.runtimeStaleSummary.textContent).toContain('Enter Drain Mode');
  });

  it('enables guided runtime update buttons only for actionable prepared readiness states', () => {
    renderOverview(
      snapshotPayload({
        quiescence: { safe_to_shutdown: true, blocker_counts: {}, blockers: [] },
        runtime_update: {
          state: 'build_current',
          attention_required: false,
          drain_required: false,
          recommended_action: 'none',
          refusal_reasons: [],
          local_checkout: { branch: 'main', commit_sha: 'local-ahead', dirty: false, detached: false },
          fetched_remote: { remote: 'origin', base_ref: 'main', commit_sha: 'remote-base' },
          ahead_behind: { ahead: 1, behind: 0 },
          last_fetch: { result: 'succeeded' }
        }
      })
    );

    expect(elements.runtimeUpdateBanner.className).toContain('hidden');
    expect(elements.runtimeUpdatePrepareButton.disabled).toBe(true);
    expect(elements.runtimeUpdatePreparePanelButton.disabled).toBe(true);
    expect(elements.runtimeUpdateApplyButton.disabled).toBe(true);
    expect(elements.runtimeUpdateApplyPanelButton.disabled).toBe(true);

    renderOverview(
      snapshotPayload({
        drain_mode: {
          active: true,
          entered_at: '2026-05-21T10:00:00.000Z',
          entered_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          updated_at: '2026-05-21T10:00:00.000Z',
          updated_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          reason: 'runtime_update_prepare'
        },
        quiescence: { safe_to_shutdown: true, blocker_counts: {}, blockers: [] },
        runtime_update: {
          state: 'local_checkout_behind',
          attention_required: true,
          drain_required: true,
          recommended_action: 'apply_update',
          prepared: true,
          apply_ready: true,
          refusal_reasons: [],
          local_checkout: { branch: 'main', commit_sha: 'old', dirty: false, detached: false },
          fetched_remote: { remote: 'origin', base_ref: 'main', commit_sha: 'new' },
          ahead_behind: { ahead: 0, behind: 1 },
          last_fetch: { result: 'succeeded' },
          github_eligibility: {
            mode: 'required',
            state: 'github_verified',
            provider: 'github',
            owner: 'nielsgl',
            repo: 'symphony',
            base_ref: 'main',
            candidate_sha: 'new',
            checked_at: '2026-05-21T10:00:00.000Z',
            reason_code: null,
            check_summary: { total: 1, succeeded: 1, pending: 0, failed: 0, skipped: 0 }
          }
        }
      })
    );

    expect(elements.runtimeUpdateBanner.className).not.toContain('hidden');
    expect(elements.runtimeUpdatePrepareButton.disabled).toBe(true);
    expect(elements.runtimeUpdatePreparePanelButton.disabled).toBe(true);
    expect(elements.runtimeUpdateApplyButton.disabled).toBe(false);
    expect(elements.runtimeUpdateApplyPanelButton.disabled).toBe(false);
    expect(elements.runtimeUpdateTitle.textContent).toBe('Runtime update available');
    expect(elements.runtimeUpdateSummary.textContent).toBe('Remote origin/main has 1 commit ready for main. Target new.');
    expect(elements.runtimeUpdateState.textContent).toBe('Prepared update ready');
    expect(elements.runtimeUpdateRecommendation.textContent).toContain('Apply the prepared update now');
    expect(collectText(elements.runtimeUpdateDetails)).toContain('Current checkout main @ old');
    expect(collectText(elements.runtimeUpdateDetails)).toContain('Available build origin/main @ new');
    expect(collectText(elements.runtimeUpdateDetails)).toContain('Checks GitHub checks passed (1 succeeded)');
  });

  it('blocks guided runtime update controls when GitHub eligibility is not verified', () => {
    renderOverview(
      snapshotPayload({
        drain_mode: {
          active: true,
          entered_at: '2026-05-21T10:00:00.000Z',
          entered_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          updated_at: '2026-05-21T10:00:00.000Z',
          updated_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          reason: 'runtime_update_prepare'
        },
        quiescence: { safe_to_shutdown: true, blocker_counts: {}, blockers: [] },
        runtime_update: {
          state: 'local_checkout_behind',
          attention_required: true,
          drain_required: true,
          recommended_action: 'prepare_update',
          prepared: false,
          apply_ready: false,
          refusal_reasons: [REASON_CODES.runtimeUpdateGithubEligibilityRequired],
          local_checkout: { branch: 'main', commit_sha: 'old', dirty: false, detached: false },
          fetched_remote: { remote: 'origin', base_ref: 'main', commit_sha: 'new' },
          ahead_behind: { ahead: 0, behind: 1 },
          last_fetch: { result: 'succeeded' },
          github_eligibility: {
            mode: 'required',
            state: 'github_checks_pending',
            provider: 'github',
            owner: 'nielsgl',
            repo: 'symphony',
            base_ref: 'main',
            candidate_sha: 'new',
            checked_at: '2026-05-21T10:00:00.000Z',
            reason_code: 'github_checks_pending',
            check_summary: { total: 1, succeeded: 0, pending: 1, failed: 0, skipped: 0 }
          }
        }
      })
    );

    expect(elements.runtimeUpdateBanner.className).not.toContain('hidden');
    expect(elements.runtimeUpdatePrepareButton.disabled).toBe(true);
    expect(elements.runtimeUpdateApplyButton.disabled).toBe(true);
    expect(elements.runtimeUpdateSummary.textContent).toBe('Remote origin/main has 1 commit ready for main. Target new.');
    expect(elements.runtimeUpdateRecommendation.textContent).toBe('Wait for GitHub checks to finish before preparing this update.');
    expect(collectText(elements.runtimeUpdateDetails)).toContain('Checks GitHub checks are still running (1 pending)');
    expect(elements.runtimeUpdateSummary.textContent).not.toContain('github github checks pending');
    expect(elements.runtimeUpdateRecommendation.textContent).not.toContain('GitHub eligibility: github checks pending');
  });

  it('uses supervised restart guidance for supervisor-backed runtime restarts', () => {
    renderOverview(
      snapshotPayload({
        drain_mode: {
          active: true,
          entered_at: '2026-05-21T10:00:00.000Z',
          entered_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          updated_at: '2026-05-21T10:00:00.000Z',
          updated_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          reason: 'runtime_update_prepare'
        },
        quiescence: { safe_to_shutdown: true, blocker_counts: {}, blockers: [] },
        runtime_restart: {
          required: true,
          status: 'required',
          reason_code: 'stale_runtime_build',
          capability: {
            mode: 'supervisor_available',
            supervisor_attempt_id: 'restart-attempt-1',
            supervisor_target_sha: 'new',
            manual_reason: null
          },
          active_attempt: null,
          last_attempt: null,
          recommended_manual_recovery: null
        },
        runtime_update: {
          state: 'runtime_stale',
          attention_required: true,
          drain_required: true,
          recommended_action: 'restart_runtime',
          prepared: false,
          apply_ready: false,
          refusal_reasons: [],
          local_checkout: { branch: 'main', commit_sha: 'new', dirty: false, detached: false },
          fetched_remote: { remote: 'origin', base_ref: 'main', commit_sha: 'new' },
          ahead_behind: { ahead: 0, behind: 0 },
          last_fetch: { result: 'succeeded' },
          github_eligibility: {
            mode: 'required',
            state: 'github_verified',
            provider: 'github',
            owner: 'nielsgl',
            repo: 'symphony',
            base_ref: 'main',
            candidate_sha: 'new',
            checked_at: '2026-05-21T10:00:00.000Z',
            reason_code: null,
            check_summary: { total: 1, succeeded: 1, pending: 0, failed: 0, skipped: 0 }
          }
        }
      })
    );

    expect(elements.runtimeUpdateState.textContent).toBe('Restart required');
    expect(elements.runtimeUpdateSummary.textContent).toContain('supervised restart available');
    expect(elements.runtimeUpdateRecommendation.textContent).toBe(
      'Restart Symphony from this panel once Drain Mode is quiet.'
    );
    expect(elements.runtimeUpdateRecommendation.textContent).not.toContain('manually');
  });

  it('does not offer apply as the first action when Drain Mode is already active', () => {
    renderOverview(
      snapshotPayload({
        drain_mode: {
          active: true,
          entered_at: '2026-05-21T10:00:00.000Z',
          entered_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          updated_at: '2026-05-21T10:00:00.000Z',
          updated_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          reason: 'manual_maintenance'
        },
        quiescence: { safe_to_shutdown: true, blocker_counts: {}, blockers: [] },
        runtime_update: {
          state: 'local_checkout_behind',
          attention_required: true,
          drain_required: true,
          recommended_action: 'prepare_update',
          prepared: false,
          apply_ready: false,
          refusal_reasons: [],
          local_checkout: { branch: 'main', commit_sha: 'old', dirty: false, detached: false },
          fetched_remote: { remote: 'origin', base_ref: 'main', commit_sha: 'new' },
          ahead_behind: { ahead: 0, behind: 1 },
          last_fetch: { result: 'succeeded' },
          github_eligibility: {
            mode: 'required',
            state: 'github_verified',
            provider: 'github',
            owner: 'nielsgl',
            repo: 'symphony',
            base_ref: 'main',
            candidate_sha: 'new',
            checked_at: '2026-05-21T10:00:00.000Z',
            reason_code: null,
            check_summary: { total: 1, succeeded: 1, pending: 0, failed: 0, skipped: 0 }
          }
        }
      })
    );

    expect(elements.runtimeUpdateBanner.className).not.toContain('hidden');
    expect(elements.runtimeUpdatePrepareButton.disabled).toBe(false);
    expect(elements.runtimeUpdatePreparePanelButton.disabled).toBe(false);
    expect(elements.runtimeUpdateApplyButton.disabled).toBe(true);
    expect(elements.runtimeUpdateApplyPanelButton.disabled).toBe(true);
    expect(elements.runtimeUpdateRecommendation.textContent).toContain('Prepare the update first');
  });

  it('renders unknown current build identity as degraded rather than stale', () => {
    renderOverview(
      snapshotPayload({
        runtime_identity: {
          process_started_at: '2026-05-21T09:00:00.000Z',
          process_started_at_ms: Date.parse('2026-05-21T09:00:00.000Z'),
          running_build: {
            identity: 'runtime-sha',
            commit_sha: 'runtime-sha',
            source_timestamp: '2026-05-21T08:55:00.000Z',
            source_timestamp_ms: Date.parse('2026-05-21T08:55:00.000Z')
          },
          current_build: {
            identity: null,
            commit_sha: null,
            source_timestamp: null,
            source_timestamp_ms: null,
            status: 'unknown'
          },
          status: 'unknown_current',
          health_warning: {
            code: 'unknown_current_build_identity',
            severity: 'degraded',
            message: 'Current repository build identity is unavailable',
            recommended_action: 'Validate the repository checkout and rerun build identity detection before dispatching new work.'
          }
        }
      })
    );

    expect(elements.runtimeStaleBanner.className).not.toContain('hidden');
    expect(elements.runtimeStaleTitle.textContent).toBe('Runtime build identity unknown');
    expect(elements.runtimeStaleSummary.textContent).toContain('runtime-sha');
    expect(elements.runtimeStaleSummary.textContent).toContain('Current build unknown');
    expect(elements.runtimeStaleSummary.textContent).toContain('Validate the repository checkout');
  });

  it('handles refresh, diagnostics, UI state load/save, and SSE snapshot/error envelopes directly', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ coalesced: false }))
      .mockResolvedValueOnce(jsonResponse(snapshotPayload()))
      .mockResolvedValueOnce(
        jsonResponse({
          runtime_resolution: { workspace_root: '/repo' },
          project_layout: {
            status: 'ok',
            project_root: { path: '/repo' }
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ runs: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          state: {
            selected_issue: 'NIE-217',
            filters: { status: 'blocked', query: 'manual' },
            event_feed_filter: 'warn',
            panels: { throughput_open: false, runtime_events_open: true },
            panel_state: { issue_detail_open: false }
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await refreshNow();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/refresh', { method: 'POST' });
    expect(elements.refreshStatus.textContent).toBe('Refresh queued');

    await loadDiagnostics();
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/v1/diagnostics', undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/v1/history?limit=8', undefined);
    expect(elements.diagnosticsOutput.textContent).toContain('Diagnostics JSON');
    expect(elements.diagnosticsOutput.textContent).toContain('"project_layout"');
    expect(collectText(elements.historyList)).toContain('No run history available.');

    await loadUiState();
    expect(state.selectedIssue).toBe('NIE-217');
    expect(state.filter.status).toBe('blocked');
    expect(elements.throughputPanel.open).toBe(false);

    scheduleStateSave();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/ui-state',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"selected_issue":"NIE-217"')
      })
    );

    handleSseEnvelope({ type: 'state_snapshot', payload: { state: snapshotPayload({ counts: { running: 1, retrying: 0, blocked: 0 } }) } });
    expect(state.connection).toBe('streaming');
    expect(collectText(elements.kpiGrid)).toContain('Running 1');

    handleSseEnvelope({ type: 'runtime_health_changed', payload: { health: { dispatch_validation: 'failed', last_error: 'bad' } } });
    expect(elements.refreshStatus.textContent).toBe('Health changed: failed (bad)');

    handleSseEnvelope(null);
    expect(elements.refreshStatus.textContent).toBe('Health changed: failed (bad)');
  });

  it('recovers safely from UI state fetch failures and malformed payloads', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'missing' }, false))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonResponse({ state: null }))
      .mockResolvedValueOnce(
        jsonResponse({
          state: {
            selected_issue: '',
            filters: {
              conversation_role: 'invalid-role',
              conversation_density: 'dense'
            },
            panel_state: { issue_detail_open: false }
          }
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await loadUiState();
    expect(state.uiStateLoaded).toBe(true);

    state.uiStateLoaded = false;
    await loadUiState();
    expect(state.uiStateLoaded).toBe(true);

    state.uiStateLoaded = false;
    await loadUiState();
    expect(state.uiStateLoaded).toBe(true);
    expect(state.selectedIssue).toBe('');

    state.uiStateLoaded = false;
    await loadUiState();
    expect(state.filter.conversationRole).toBe('all');
    expect(state.filter.conversationDensity).toBe('comfortable');
    expect(elements.conversationRoleFilter.value).toBe('all');
    expect(elements.conversationDensity.value).toBe('comfortable');
  });

  it('renders issue detail diagnostics, timelines, raw events, and load fallbacks directly', async () => {
    expect(spanLabel({ phase: 'implementation' }, 'phase')).toBe('implementation');
    expect(spanLabel({ tool_name: 'apply_patch' }, 'tool')).toBe('apply_patch');
    expect(formatDiagnosticSummary(null)).toBe('Summary diagnostics: unavailable');
    expect(
      formatDiagnosticSummary({
        detailed_diagnostics_available: true,
        total_count: 2,
        active_missing_tool_output: { active: true, tool_name: 'shell' },
        recovery: { active: true, status: 'running' },
        newest_observed_at: '2026-05-21T10:00:00.000Z'
      })
    ).toContain('missing output shell');
    expect(formatInputDecisionContext('approval_option_exact')).toBe('Input handling: exact approval option selected');

    const lane = renderTimelineLane('Tool', [{ tool_name: 'shell', status: 'ok', duration_ms: 10 }], 'tool');
    expect(collectText(lane)).toContain('shell');
    expect(collectText(renderTimelineLane('Wait', [], 'wait'))).toContain('No wait spans.');

    renderIssueExplainer(null);
    expect(elements.issueExplainerCard.className).toContain('hidden');
    renderIssueExplainer({
      actionability: 'required',
      headline: 'Operator needed',
      classification: 'manual',
      reason_code: 'turn_input_required',
      reason_detail: 'answer prompt',
      recommended_actions: ['answer'],
      expected_transition: 'resume',
      version: '1'
    });
    expect(elements.issueExplainerHeadline.textContent).toBe('Operator needed');
    expect(elements.issueExplainerAction.textContent).toBe('answer');

    expect(formatConversationSummary(null)).toBe('Conversation: no evidence loaded');
    renderConversation({
      latest: { role: 'assistant', source: 'runtime_event', summary: 'Implemented the feature' },
      metadata: {
        included_count: 2,
        total_available_count: 4,
        truncated: true,
        role_counts: { system: 0, user: 1, assistant: 1, tool: 0, runtime: 0 }
      },
      messages: [
        {
          at: '2026-05-21T10:00:00.000Z',
          role: 'user',
          source: 'runtime_event',
          event: 'pending_input',
          content: 'Please continue',
          thread_id: 'thread-1'
        },
        {
          at: '2026-05-21T10:01:00.000Z',
          role: 'assistant',
          source: 'app_server_ledger',
          event: 'assistant_text',
          content: 'Implemented the feature',
          truncated: true
        }
      ]
    });
    expect(elements.conversationSummary.textContent).toContain('latest assistant: Implemented the feature');
    expect(collectText(elements.conversationList)).toContain('Please continue');
    state.filter.conversationRole = 'tool';
    renderConversation({
      latest: {},
      metadata: { included_count: 1, total_available_count: 1, truncated: false, role_counts: {} },
      messages: [{ at: '2026-05-21T10:00:00.000Z', role: 'assistant', source: 'runtime_event', content: 'hidden' }]
    });
    expect(collectText(elements.conversationList)).toContain('No messages match this role filter.');
    state.filter.conversationRole = 'all';

    renderThreadDiagnostics(null);
    expect(elements.threadRawEvents.textContent).toBe('Detailed diagnostics are not loaded.');
    renderThreadDiagnostics({
      phase_spans: [{ phase: 'implementation', status: 'ok' }],
      tool_spans: [],
      wait_spans: [{ reason_code: 'waiting', status: 'open' }],
      current_blocker: { classification: 'input', reason_code: 'turn_input_required', recommended_actions: ['reply'] },
      capability_warnings: [{ reason_code: 'unsupported', attempted_tool_name: 'browser', unsupported_capability_message: 'no browser' }],
      timeline: [{ at_ms: 1779357600000, event: 'worker_event', thread_id: 'thread-1', reason_code: 'ok' }]
    });
    expect(collectText(elements.threadTimelineLanes)).toContain('implementation');
    expect(collectText(elements.threadCapabilityWarnings)).toContain('unsupported');
    expect(elements.threadRawEvents.textContent).toContain('worker_event');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'In Progress',
          snapshot_freshness_state: 'fresh',
          snapshot_age_ms: 10,
          running: {
            current_phase: 'implementation',
            token_telemetry_confidence: 'observed_live',
            transcript_tool_call_diagnostic_summary: { total_count: 1 }
          },
          conversation: {
            latest: { role: 'assistant', source: 'runtime_event', summary: 'latest implementation note' },
            metadata: {
              included_count: 1,
              total_available_count: 1,
              truncated: false,
              role_counts: { assistant: 1 }
            },
            messages: [
              {
                at: '2026-05-21T10:00:01.000Z',
                role: 'assistant',
                source: 'runtime_event',
                event: 'turn.completed',
                content: 'latest implementation note'
              }
            ]
          },
          phase_timeline: [{ at: '2026-05-21T10:00:00.000Z', phase: 'implementation', attempt: 1 }]
        })
      )
      .mockResolvedValueOnce(jsonResponse({ timeline: [] }))
      .mockRejectedValueOnce(new Error('issue down'));
    vi.stubGlobal('fetch', fetchMock);

    await loadIssue('NIE-217');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/NIE-217', undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/issues/NIE-217/diagnostics', undefined);
    expect(elements.issueSummary.textContent).toContain('Detailed diagnostics: loaded');
    expect(elements.conversationSummary.textContent).toContain('latest assistant: latest implementation note');
    expect(elements.issueOutput.textContent).toContain('Execution Timeline');

    await loadIssue('NIE-218');
    expect(elements.issueSummary.textContent).toBe('Issue detail degraded: fallback mode active.');
    expect(elements.issueOutput.textContent).toContain('Issue load failed: Error: issue down');
  });

  it('ignores stale issue detail responses when selected-agent refreshes overlap', async () => {
    let resolveOldIssue: (value: any) => void = () => {};
    const oldIssueResponse = new Promise((resolve) => {
      resolveOldIssue = resolve;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/NIE-OLD') {
        return oldIssueResponse;
      }
      if (url === '/api/v1/NIE-NEW') {
        return Promise.resolve(
          jsonResponse({
            status: 'running',
            snapshot_freshness_state: 'fresh',
            snapshot_age_ms: 1,
            conversation: {
              latest: { role: 'assistant', source: 'runtime_event', summary: 'new detail wins' },
              metadata: { included_count: 1, total_available_count: 1, truncated: false, role_counts: { assistant: 1 } },
              messages: [{ at: '2026-05-21T10:01:00.000Z', role: 'assistant', source: 'runtime_event', content: 'new detail wins' }]
            },
            phase_timeline: []
          })
        );
      }
      if (url === '/api/v1/issues/NIE-OLD/diagnostics' || url === '/api/v1/issues/NIE-NEW/diagnostics') {
        return Promise.resolve(jsonResponse({ timeline: [] }));
      }
      throw new Error('unexpected fetch ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    const oldLoad = loadIssue('NIE-OLD');
    const newLoad = loadIssue('NIE-NEW');
    await newLoad;
    expect(elements.conversationSummary.textContent).toContain('new detail wins');

    resolveOldIssue(
      jsonResponse({
        status: 'running',
        snapshot_freshness_state: 'fresh',
        snapshot_age_ms: 99,
        conversation: {
          latest: { role: 'assistant', source: 'runtime_event', summary: 'stale detail lost' },
          metadata: { included_count: 1, total_available_count: 1, truncated: false, role_counts: { assistant: 1 } },
          messages: [{ at: '2026-05-21T10:00:00.000Z', role: 'assistant', source: 'runtime_event', content: 'stale detail lost' }]
        },
        phase_timeline: []
      })
    );
    await oldLoad;

    expect(elements.issueInput.value).toBe('NIE-NEW');
    expect(elements.conversationSummary.textContent).toContain('new detail wins');
    expect(elements.conversationSummary.textContent).not.toContain('stale detail lost');
  });

  it('submits operator actions through direct module functions with endpoint and failure assertions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ issue_identifier: 'NIE-217' }))
      .mockResolvedValueOnce(jsonResponse(snapshotPayload()))
      .mockResolvedValueOnce(jsonResponse({ issue_identifier: 'NIE-217', moved_to_state: 'Backlog' }))
      .mockResolvedValueOnce(jsonResponse(snapshotPayload()))
      .mockResolvedValueOnce(jsonResponse({ issue_identifier: 'NIE-217' }))
      .mockResolvedValueOnce(jsonResponse(snapshotPayload()))
      .mockResolvedValueOnce(jsonResponse({ issue_identifier: 'NIE-217', resume_mode: 'normal', resume_reason_code: 'operator_input' }))
      .mockResolvedValueOnce(jsonResponse(snapshotPayload()));
    vi.stubGlobal('fetch', fetchMock);

    await resumeBlockedIssue('NIE-217', 'operator_override');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/issues/NIE-217/resume',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"resume_override_reason":"operator_override"') })
    );

    await cancelBlockedIssue('NIE-217', 'operator_cancel');
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/v1/issues/NIE-217/cancel',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"confirmed":true') })
    );

    await runOperatorAction('NIE-217', 'requeue', true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      '/api/v1/issues/NIE-217/requeue',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"reason_note":"reason note"') })
    );

    await submitBlockedInput({
      issue_identifier: 'NIE-217',
      pending_input: {
        request_id: 'req-1',
        input_schema_type: 'text',
        prompt_text: 'Answer?',
        questions: [{ id: 'q1' }]
      }
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      7,
      '/api/v1/issues/NIE-217/input',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"request_id":"req-1"') })
    );

    vi.mocked(window.prompt).mockReturnValueOnce('');
    await resumeBlockedIssue('NIE-218');
    expect(elements.refreshStatus.textContent).toBe('Resume skipped: reason note is required');
  });

  it('renders stopped-run recovery lazy, loading, loaded, acknowledgement, and API failure behavior directly', async () => {
    renderStoppedRunRecovery({ stopped_runs: [] });
    expect(collectText(elements.stoppedRunRecoveryList)).toContain('loads on demand');

    state.stoppedRunRecoveryLoaded = true;
    renderStoppedRunRecovery({
      stopped_runs: [
        {
          run_id: 'run-1',
          issue_identifier: 'NIE-217',
          recovery_status: 'resume_available',
          resume_valid: true,
          actions: { inspect_forensics_url: 'https://example.test', copy_thread_id_supported: true, copy_session_id_supported: true }
        }
      ]
    });
    expect(collectText(elements.stoppedRunRecoveryList)).toContain('NIE-217');
    const acknowledge = elements.stoppedRunRecoveryList.children[0].children[4].children[5];
    acknowledge.click();
    expect(window.localStorage.setItem).toHaveBeenCalledWith('symphony.stoppedRunAcknowledged', '["run-1"]');
    expect(collectText(elements.stoppedRunRecoveryList)).toContain('No recent stopped runs need recovery.');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ stopped_runs: [{ run_id: 'run-2', issue_identifier: 'NIE-218', actions: {} }], counts: { stopped: 1 } }))
      .mockRejectedValueOnce(new Error('recovery down'));
    vi.stubGlobal('fetch', fetchMock);
    state.payload = snapshotPayload();
    await loadStoppedRunRecovery();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/stopped-runs/recovery', undefined);
    expect(state.stoppedRunRecoveryLoaded).toBe(true);
    expect(elements.refreshStatus.textContent).toBe('Stopped-run recovery loaded');

    await loadStoppedRunRecovery();
    expect(elements.refreshStatus.textContent).toContain('Stopped-run recovery load failed');
  });

  it('loads and renders project history list/detail success, empty, fallback health, and errors directly', async () => {
    renderProjectHistory();
    expect(elements.projectHistoryStatus.textContent).toBe('No project key discovered from bounded run history yet.');

    state.projectHistory.projectKey = 'symphony';
    state.projectHistory.loading = true;
    renderProjectHistory();
    expect(collectText(elements.projectHistoryRows)).toContain('Loading project history...');

    state.projectHistory.loading = false;
    state.projectHistory.listPayload = {
      tickets: [
        {
          ticket_identity: { key: 'NIE-217', human_issue_identifier: 'NIE-217' },
          state: 'In Progress',
          current_status: 'In Progress',
          latest_attempt: { attempt_number: 1, status: 'running', started_at: '2026-05-21T10:00:00.000Z' },
          summary: { evidence_reference_count: 1, attempt_count: 1, total_tokens: 10 },
          facts: [{ status: 'present', fact: 'workspace' }],
          latest_observed_at: '2026-05-21T10:00:00.000Z'
        }
      ],
      page: { total: 1, has_more: false },
      facts: [{ status: 'present', fact: 'history' }],
      health: { status: 'ok', enabled: true, counts: { runs: 1 } }
    };
    renderProjectHistory();
    expect(collectText(elements.projectHistoryRows)).toContain('NIE-217');
    expect(collectText(elements.projectHistoryFacts)).toContain('present: history');

    state.projectHistory.detailPayload = {
      ticket_identity: { key: 'NIE-217', human_issue_identifier: 'NIE-217' },
      facts: [{ status: 'present', fact: 'timeline' }],
      attempts: [{ attempt_number: 1, status: 'running', started_at: '2026-05-21T10:00:00.000Z' }],
      phases: [],
      state_transitions: [],
      thread_references: [],
      turn_references: [],
      outcomes: [],
      blockers: [],
      evidence_references: [],
      app_server_lite_summaries: [],
      token_model_summaries: [],
      blocked_input_events: []
    };
    renderProjectHistoryDetail();
    expect(collectText(elements.projectHistoryDetail)).toContain('Ticket Timeline: NIE-217');
    expect(collectText(elements.projectHistoryDetail)).toContain('No phases facts recorded.');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ tickets: [], page: { total: 0 }, health: { status: 'ok' } }))
      .mockResolvedValueOnce(jsonResponse({ ticket_identity: { key: 'NIE-217' }, attempts: [], phases: [] }))
      .mockRejectedValueOnce(new Error('list down'))
      .mockResolvedValueOnce(jsonResponse({ status: 'degraded', enabled: true, diagnostics: [{ status: 'missing' }] }))
      .mockRejectedValueOnce(new Error('detail down'));
    vi.stubGlobal('fetch', fetchMock);

    await loadProjectHistory('symphony');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/projects/symphony/history/tickets?limit=50', undefined);
    expect(collectText(elements.projectHistoryRows)).toContain('No project ticket history available for this project.');

    await loadProjectHistoryDetail('NIE-217');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/projects/symphony/history/tickets/NIE-217', undefined);

    await loadProjectHistory('symphony');
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/v1/projects/symphony/history/health', undefined);
    expect(elements.projectHistoryStatus.textContent).toContain('Project history unavailable');

    state.projectHistory.error = null;
    state.projectHistory.listPayload = { tickets: [], page: { total: 0 } };
    await loadProjectHistoryDetail('NIE-218');
    expect(state.projectHistory.detailError).toContain('detail down');
    renderProjectHistoryDetail();
    expect(elements.projectHistoryDetail.className).not.toContain('hidden');
    expect(collectText(elements.projectHistoryDetail)).toContain('Ticket timeline unavailable');
  });

  it('deduplicates repeated project history fact labels while preserving distinct labels', () => {
    const badges = createFactBadges([
      { status: 'present', fact: 'tracker_snapshot', reason_code: 'first_tracker_snapshot', detail: 'first detail' },
      { status: 'present', fact: 'tracker_snapshot', reason_code: 'second_tracker_snapshot', detail: 'second detail' },
      { status: 'redacted', fact: 'app_server_lite_payload', reason_code: 'project_history_payload_redacted' },
      { status: 'truncated', fact: 'app_server_lite_payload', reason_code: 'project_history_payload_truncated' },
      { status: '', fact: '' },
      { status: '', fact: '' }
    ]);

    expect(badges.map((badge) => badge.textContent)).toEqual([
      'present: tracker snapshot',
      'redacted: app server lite payload',
      'truncated: app server lite payload',
      'unknown: unknown'
    ]);
    expect(badges[0].title).toContain('first_tracker_snapshot');
    expect(badges[0].title).toContain('second_tracker_snapshot');
  });
});
