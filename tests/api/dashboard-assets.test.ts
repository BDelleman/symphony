import vm from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderDashboardClientJs, renderDashboardHtml, renderDashboardStylesCss } from '../../src/api/dashboard-assets';

const ORIGINAL_GLOBALS = {
  document: globalThis.document,
  window: globalThis.window,
  EventSource: globalThis.EventSource,
  fetch: globalThis.fetch,
  setInterval: globalThis.setInterval
};

class FakeClassList {
  private readonly values = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) {
      this.values.add(token);
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) {
      this.values.delete(token);
    }
  }

  contains(token: string): boolean {
    return this.values.has(token);
  }

  toggle(token: string, force?: boolean): boolean {
    const shouldAdd = force ?? !this.values.has(token);
    if (shouldAdd) {
      this.values.add(token);
      return true;
    }
    this.values.delete(token);
    return false;
  }

  setFromClassName(className: string): void {
    this.values.clear();
    for (const token of className.split(/\s+/)) {
      if (token) {
        this.values.add(token);
      }
    }
  }

  toString(): string {
    return Array.from(this.values).join(' ');
  }
}

class FakeElement {
  readonly tagName: string;
  readonly classList = new FakeClassList();
  readonly listeners = new Map<string, Array<(event: { target?: FakeElement; key?: string; preventDefault(): void }) => void>>();
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  colSpan = 0;
  dataset: Record<string, string> = {};
  disabled = false;
  href = '';
  id = '';
  open = true;
  placeholder = '';
  style: Record<string, string> = {};
  title = '';
  type = '';
  value = '';
  private ownText = '';
  private ownClassName = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get className(): string {
    return this.ownClassName;
  }

  set className(value: string) {
    this.ownClassName = value;
    this.classList.setFromClassName(value);
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      this.appendChild(typeof node === 'string' ? FakeElement.text(node) : node);
    }
  }

  appendChild(node: FakeElement): FakeElement {
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.ownText = '';
    this.children = nodes;
  }

  addEventListener(type: string, handler: (event: { target?: FakeElement; key?: string; preventDefault(): void }) => void): void {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  click(): void {
    this.dispatch('click');
  }

  dispatch(type: string, event: { target?: FakeElement; key?: string; preventDefault(): void } = { preventDefault() {} }): void {
    const handlers = type === 'click' ? this.listeners.get('click') || [] : this.listeners.get(type) || [];
    for (const handler of handlers) {
      handler({ ...event, target: event.target ?? this });
    }
  }

  focus(): void {
    // Focus tracking is not needed for these dashboard assertions.
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name.startsWith('data-')) {
      this.dataset[name.slice('data-'.length)] = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name.startsWith('data-')) {
      return this.dataset[name.slice('data-'.length)] || null;
    }
    return this.attributes.get(name) || null;
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return [];
  }

  static text(value: string): FakeElement {
    const element = new FakeElement('#text');
    element.textContent = value;
    return element;
  }
}

class FakeDocument {
  readonly elements = new Map<string, FakeElement>();
  readonly listeners = new Map<string, Array<(event: { key?: string; preventDefault(): void }) => void>>();
  activeElement: FakeElement | null = null;

  constructor(html: string) {
    const ids = html.matchAll(/id="([^"]+)"/g);
    for (const match of ids) {
      const element = new FakeElement('div');
      element.id = match[1];
      this.elements.set(match[1], element);
    }
  }

  getElementById(id: string): FakeElement {
    let element = this.elements.get(id);
    if (!element) {
      element = new FakeElement('div');
      element.id = id;
      this.elements.set(id, element);
    }
    return element;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  createTextNode(value: string): FakeElement {
    return FakeElement.text(value);
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return [];
  }

  addEventListener(type: string, handler: (event: { key?: string; preventDefault(): void }) => void): void {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<(event: { data: string }) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  addEventListener(type: string, handler: (event: { data: string }) => void) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(handler);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: { data: string }) {
    for (const handler of this.listeners.get(type) || []) {
      handler(event);
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function okJson(payload: unknown) {
  return {
    ok: true,
    async json() {
      return payload;
    }
  };
}

async function flushPromises(): Promise<void> {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  }
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function makeStatePayload() {
  return {
    generated_at: '2026-05-08T15:00:00.000Z',
    snapshot_generated_at_ms: Date.parse('2026-05-08T15:00:00.000Z'),
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
    health: {
      dispatch_validation: 'ok',
      last_error: null
    },
    rate_limits: null,
    throughput: null,
    running: [],
    retrying: [],
    blocked: [],
    stopped_runs: [],
    recent_events: [],
    recent_runtime_events: []
  };
}

function createRuntimeStatePayload() {
  return makeStatePayload();
}

function makeRunningSessionPayload(overrides: Record<string, unknown> = {}) {
  return {
    issue_identifier: 'NIE-184',
    state: 'In Progress',
    session_id: 'thread-token-turn-token',
    worker_host: 'hessian',
    workspace_path: '/tmp/symphony/NIE-184',
    provisioner_type: 'worktree',
    branch_name: 'feature/NIE-184',
    workspace_git_status: 'clean',
    thread_id: 'thread-token',
    turn_id: 'turn-token',
    turn_count: 1,
    current_phase: 'implementation',
    current_phase_at: '2026-05-08T15:00:00.000Z',
    phase_elapsed_ms: 0,
    started_at: '2026-05-08T14:55:00.000Z',
    last_event: 'codex.token_usage.updated',
    last_event_summary: 'codex token usage updated',
    last_message: 'token usage updated',
    last_event_at: '2026-05-08T15:00:00.000Z',
    tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    token_telemetry_status: 'available',
    token_telemetry_confidence: 'observed_live',
    token_telemetry_source: 'transcript_token_count',
    turn_control_state: 'agent_turn',
    progress_signal_state: 'advancing',
    current_blocker_class: null,
    time_since_progress: 0,
    last_successful_step: 'codex.token_usage.updated',
    transcript_tool_call_diagnostic_summary: null,
    operator_actions: [],
    actions: {},
    ...overrides
  };
}

function createStoppedRunRecoveryPayload() {
  return {
    counts: {
      stopped: 1
    },
    stopped_runs: [
      {
        run_id: 'run-stopped-1',
        issue_identifier: 'NIE-119',
        thread_id: 'thread-stopped-1',
        session_id: 'session-stopped-1',
        turn_id: 'turn-stopped-1',
        last_relevant_at: '2026-05-08T15:59:00.000Z',
        terminal_status: 'stopped',
        terminal_reason_code: 'capability_mismatch',
        terminal_reason_detail: 'Stopped after unsupported browser capability.',
        root_cause_status: 'action_required',
        root_cause_reason_code: 'missing_tool_output_recovery',
        root_cause_reason_detail: 'Inspect thread lineage before resume.',
        recovery_status: 'capability_mismatch',
        capability_mismatch: true,
        resume_valid: false,
        resume_disabled_reason: 'Unsupported browser capability.',
        capability_warning: {
          unsupported_capability_message: 'Browser tool was unavailable.',
          recommended_recovery_action: 'Resume with browser-capable runtime.'
        },
        actions: {
          inspect_forensics_url: '/api/v1/history/run-stopped-1',
          inspect_thread_url: '/api/v1/threads/thread-stopped-1',
          copy_thread_id_supported: true,
          copy_session_id_supported: true
        }
      }
    ]
  };
}

function installDashboardClient(fetchImpl: (url: string, init?: unknown) => Promise<{ ok: boolean; json(): Promise<unknown> }>) {
  const document = new FakeDocument(renderDashboardHtml());
  const storage = new Map<string, string>();
  const fetchCalls: string[] = [];
  const sandbox = {
    console,
    document,
    EventSource: class {
      close() {}
    },
    fetch: (url: string, init?: unknown) => {
      fetchCalls.push(String(url));
      return fetchImpl(String(url), init);
    },
    localStorage: {
      getItem(key: string) {
        return storage.get(key) || null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      }
    },
    setInterval() {
      return 0;
    },
    clearInterval() {},
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
    window: {
      confirm: () => true,
      localStorage: {
        getItem(key: string) {
          return storage.get(key) || null;
        },
        setItem(key: string, value: string) {
          storage.set(key, value);
        }
      },
      open() {},
      prompt: () => ''
    }
  };
  sandbox.window = { ...sandbox.window, localStorage: sandbox.localStorage };
  vm.runInNewContext(
    renderDashboardClientJs({
      dashboard_enabled: false,
      refresh_ms: 500,
      render_interval_ms: 250
    }),
    sandbox
  );

  return { document, fetchCalls };
}

function installDashboardClientHarness(options: { stateError?: Error } = {}) {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  const document = new FakeDocument(renderDashboardHtml());
  const fetchCalls: string[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    fetchCalls.push(String(url));
    if (url === '/api/v1/state') {
      if (options.stateError) {
        return Promise.reject(options.stateError);
      }
      return okJson(makeStatePayload());
    }
    if (url === '/api/v1/refresh') {
      expect(init?.method).toBe('POST');
      return okJson({ queued: true, coalesced: false });
    }
    if (url === '/api/v1/ui-state') {
      return okJson({ state: null });
    }
    if (url === '/api/v1/diagnostics') {
      return okJson({ runtime_resolution: null });
    }
    if (url === '/api/v1/history?limit=8') {
      return okJson({ runs: [] });
    }
    return okJson({});
  });

  vi.stubGlobal('document', document);
  vi.stubGlobal('window', {
    open: vi.fn(),
    localStorage: {
      getItem: vi.fn(() => null),
      setItem: vi.fn()
    },
    prompt: vi.fn(() => ''),
    confirm: vi.fn(() => true)
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', FakeEventSource);

  const script = renderDashboardClientJs({ dashboard_enabled: true, refresh_ms: 500, render_interval_ms: 500, phase_stale_warn_ms: 1000 });
  Function(script)();

  return {
    document,
    fetchCalls,
    stateFetchCount: () => fetchCalls.filter((url) => url === '/api/v1/state').length,
    refreshFetchCount: () => fetchCalls.filter((url) => url === '/api/v1/refresh').length,
    stream: () => {
      const stream = FakeEventSource.instances.at(-1);
      expect(stream).toBeDefined();
      return stream!;
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (ORIGINAL_GLOBALS.document) {
    globalThis.document = ORIGINAL_GLOBALS.document;
  }
  if (ORIGINAL_GLOBALS.window) {
    globalThis.window = ORIGINAL_GLOBALS.window;
  }
  if (ORIGINAL_GLOBALS.EventSource) {
    globalThis.EventSource = ORIGINAL_GLOBALS.EventSource;
  }
  if (ORIGINAL_GLOBALS.fetch) {
    globalThis.fetch = ORIGINAL_GLOBALS.fetch;
  }
  globalThis.setInterval = ORIGINAL_GLOBALS.setInterval;
});

describe('dashboard assets', () => {
  it('styles the Refresh Now button with the ticket pink treatment', () => {
    const css = renderDashboardStylesCss();

    expect(css).toContain('.refresh-now-button {\n  background: #ec4899;');
    expect(css).toContain('.refresh-now-button:hover {\n  background: #db2777;');
    expect(css).toContain('.refresh-now-button:focus-visible {\n  outline: 2px solid #f9a8d4;');
  });

  it('renders the operator control subtitle as outcome-focused copy', () => {
    const html = renderDashboardHtml();

    expect(html).toContain('Turn every run from first signal to confident handoff.');
    expect(html).toContain('<link rel="icon" href="data:," />');
    expect(html).not.toContain('Live orchestration visibility with retry control, issue drilldown, and desktop/browser parity.');
  });

  it('places rate limits below runtime overview and renders a visual container', () => {
    const html = renderDashboardHtml();
    const css = renderDashboardStylesCss();

    expect(html.indexOf('<h2>Runtime Overview</h2>')).toBeLessThan(html.indexOf('<h2>Rate Limits</h2>'));
    expect(html.indexOf('<h2>Rate Limits</h2>')).toBeLessThan(html.indexOf('<h2>Drain Mode</h2>'));
    expect(html).toContain('id="rate-limits" class="rate-limit-grid"');
    expect(html).not.toContain('<pre id="rate-limits"');
    expect(css).toContain('.rate-limit-card');
    expect(css).toContain('.rate-limit-meter-fill');
  });

  it('renders client budget display logic for visible status, policy, and stop messages', () => {
    const clientJs = renderDashboardClientJs();

    expect(clientJs).toContain('function createBudgetBlock(entry)');
    expect(clientJs).toContain('Budget: ');
    expect(clientJs).toContain('Budget usage unavailable; not counted as zero.');
    expect(clientJs).toContain('Policy ');
    expect(clientJs).toContain('Budget stopped continuation: ');
    expect(clientJs).toContain('tokensCell.append(createBudgetBlock(entry));');
    expect(clientJs).toContain('function formatTokenDimension(value, unavailableLabel)');
    expect(clientJs).toContain('function formatTokenBreakdown(tokens, telemetrySource)');
    expect(clientJs).toContain('function formatOverviewTokenValue(payload, field, splitUnavailable)');
    expect(clientJs).toContain('Split unavailable');
    expect(clientJs).toContain('Codex Cached Input');
    expect(clientJs).toContain('Codex Reasoning Output');
    expect(clientJs).toContain('Codex Max Context');
    expect(clientJs).toContain('Cached ');
    expect(clientJs).toContain('Reasoning ');
    expect(clientJs).toContain('Context ');
    expect(clientJs).toMatch(/payload\.codex_totals\.token_split_status === ["']aggregate_only["']/);
    expect(clientJs).toMatch(/tokens\.token_split_status === ["']aggregate_only["']/);
    expect(clientJs).toMatch(/token_split_status === ["']aggregate_only["']/);
    expect(clientJs.split('stopReasonCell.append(createBudgetBlock(entry));')).toHaveLength(3);
  });

  it('renders dashboard drilldown contract surfaces and row-level blocker fields', () => {
    const html = renderDashboardHtml();
    const clientJs = renderDashboardClientJs();

    expect(html).toContain('<th>Blocker</th>');
    expect(html).toContain('<th>Time Since Progress</th>');
    expect(html).toContain('<th>Last Successful Step</th>');
    expect(html).toContain('id="thread-timeline-lanes"');
    expect(html).toContain('id="thread-blocker-card"');
    expect(html).toContain('id="thread-capability-warnings"');
    expect(html).toContain('id="thread-raw-events"');
    expect(clientJs).toMatch(/fetchJson\(["']\/api\/v1\/issues\/["'] \+ encodeURIComponent\(issueId\) \+ ["']\/diagnostics["']\)/);
    expect(clientJs).toContain('function formatDiagnosticSummary(summary)');
    expect(clientJs).toContain('function formatCanonicalJsonBlock(label, payload)');
    expect(clientJs).toContain("Issue JSON (canonical UTC ISO values preserved)");
    expect(clientJs).toContain('Summary diagnostics: ');
    expect(clientJs).toContain('Detailed diagnostics: loaded');
    expect(clientJs).toContain('Detailed diagnostics: unavailable');
    expect(clientJs).toMatch(/elements\.threadRawEvents\.textContent = ["']Detailed diagnostics are not loaded\.["']/);
    expect(clientJs).toMatch(/renderTimelineLane\(["']Phase["']/);
    expect(clientJs).toMatch(/appendDefinitionValue\(elements\.threadBlockerCard, ["']classification["']/);
    expect(clientJs).toContain('diagnostics.capability_warnings');
    expect(clientJs).toContain('recommended_recovery_action');
    expect(clientJs).toMatch(/appendDefinitionValue\(elements\.threadBlockerCard, ["']recovery_headline["']/);
    expect(clientJs).toMatch(/appendDefinitionValue\(elements\.threadBlockerCard, ["']recovery_next_action["']/);
    expect(clientJs).toContain('missing_tool_output_recovery');
    expect(clientJs).toContain('entry.current_blocker_class');
    expect(clientJs).toContain('entry.time_since_progress');
    expect(clientJs).toContain('entry.last_successful_step');
    expect(clientJs).toContain('phase unchanged for ');
    expect(clientJs).toContain('Agent session active ');
    expect(clientJs).toContain('Agent session activity unavailable');
    expect(clientJs).toContain('entry.transcript_tool_call_diagnostic_summary');
    expect(clientJs).toContain('blockerCell.append(blockerValue, diagnosticSummary);');
    expect(clientJs).toContain('payload policy redacted ');
    expect(clientJs).toContain('payload unavailable ');
    expect(clientJs).toContain('facts pending ');
    expect(clientJs).toContain('optional unavailable ');
  });

  it('renders guided runtime update controls and client actions', () => {
    const html = renderDashboardHtml();
    const clientJs = renderDashboardClientJs();

    expect(html).toContain('id="runtime-update-banner"');
    expect(html).toContain('id="runtime-update-panel"');
    expect(html).toContain('id="runtime-update-prepare-button"');
    expect(html).toContain('id="runtime-update-apply-button"');
    expect(html).toContain('Runtime Update');
    expect(clientJs).toContain('function renderRuntimeUpdate(readiness, payload)');
    expect(clientJs).toContain('/api/v1/runtime-update/prepare');
    expect(clientJs).toContain('/api/v1/runtime-update/apply');
    expect(clientJs).toContain('Restart command: ');
    expect(clientJs).toContain('Apply the prepared update now.');
    expect(clientJs).toContain('runtime-update-fact');
  });

  it('lazy-loads issue diagnostics only for opened detail surfaces', () => {
    const clientJs = renderDashboardClientJs();
    const refreshBlock = clientJs.slice(clientJs.indexOf('async function refreshNow()'), clientJs.indexOf('async function loadDiagnostics()'));
    const streamBlock = clientJs.slice(clientJs.indexOf('function handleSseEnvelope'), clientJs.indexOf('function connectStream'));

    expect(clientJs).toContain('if (state.selectedIssue && elements.issuePanel.open)');
    expect(clientJs).toContain('void loadIssue(state.selectedIssue, { openPanel: false });');
    expect(clientJs).not.toContain('if (state.selectedIssue) {\n        void loadIssue(state.selectedIssue);');
    expect(clientJs).toMatch(/elements\.issuePanel\.addEventListener\(["']toggle["']/);
    expect(clientJs).toContain('state.suppressIssuePanelToggleLoad');
    expect(clientJs).toContain("void loadIssue(state.selectedIssue, { openPanel: false });");
    expect(clientJs).toContain('if (loadOptions.openPanel !== false && !elements.issuePanel.open)');
    expect(refreshBlock).toMatch(/fetchJson\(["']\/api\/v1\/refresh["']/);
    expect(refreshBlock).not.toContain('/diagnostics');
    expect(streamBlock).toMatch(/type === ["']state_snapshot["']/);
    expect(streamBlock).not.toContain('/diagnostics');
  });

  it('keeps polling before the stream delivers a usable state snapshot', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    expect(harness.stateFetchCount()).toBe(1);
    harness.stream().onopen?.();
    expect(harness.document.getElementById('connection-badge').textContent).toBe('Connecting');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('Stream connected; waiting for the first snapshot.');
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(harness.stateFetchCount()).toBe(2);
    expect(harness.document.getElementById('connection-badge').textContent).toBe('Polling');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('Stream connected; waiting for the first snapshot.');
  });

  it('suspends routine polling after a healthy stream state snapshot arrives', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    harness.stream().onopen?.();
    harness.stream().onmessage?.({
      data: JSON.stringify({ type: 'state_snapshot', payload: { state: makeStatePayload() } })
    });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();

    expect(harness.stateFetchCount()).toBe(1);
    expect(harness.document.getElementById('connection-badge').textContent).toBe('Streaming');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('Live updates are flowing.');
    expect(harness.document.getElementById('last-updated').textContent).toBe('Updated just now • Snapshot fresh');
  });

  it('handles named symphony SSE events from the server', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    harness.stream().onopen?.();
    harness.stream().emit('symphony', {
      data: JSON.stringify({ type: 'state_snapshot', payload: { state: makeStatePayload() } })
    });
    await flushPromises();

    expect(harness.document.getElementById('connection-badge').textContent).toBe('Streaming');
    expect(harness.stateFetchCount()).toBe(1);
  });

  it('renders polling fallback live instead of offline when polling succeeds while SSE is unhealthy', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    harness.stream().onerror?.();
    await flushPromises();

    expect(harness.stateFetchCount()).toBe(2);
    expect(harness.document.getElementById('connection-badge').textContent).toBe('Polling');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('Stream paused; polling is keeping this view current.');
    expect(harness.document.getElementById('connection-badge').textContent).not.toBe('Offline');
  });

  it('renders offline only when polling fails', async () => {
    const harness = installDashboardClientHarness({ stateError: new Error('api unavailable') });
    await flushPromises();

    expect(harness.document.getElementById('connection-badge').textContent).toBe('Offline');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('Polling failed');
  });

  it('renders overdue retry causes above the retry table', async () => {
    const harness = installDashboardClientHarness();
    vi.setSystemTime(new Date('2026-05-11T13:05:21.648Z'));
    await flushPromises();

    const state = makeStatePayload() as any;
    state.counts.retrying = 1;
    state.retry_status = {
      total: 1,
      overdue_count: 1,
      pending_count: 0,
      entries: [
        {
          issue_id: 'issue-nie-128',
          issue_identifier: 'NIE-128',
          attempt: 1,
          due_at: '2026-05-11T12:56:21.648Z',
          due_at_ms: Date.parse('2026-05-11T12:56:21.648Z'),
          due_state: 'overdue',
          overdue_ms: 540000,
          retry_wait_ms: null,
          reason_code: 'issue_state_refresh_failed',
          detail: 'issue_state_refresh_failed: Linear request failed: TypeError: fetch failed',
          operator_detail:
            'The Codex turn completed and reached post-run tracker refresh, but Symphony could not refresh the issue state from Linear before deciding the next workflow step. The scheduled retry refreshes tracker state without rerunning the completed turn.',
          headline: 'Tracker refresh failed after run activity',
          expected_transition: 'Retry due time passed 540000ms ago; dispatch may be stuck',
          last_phase: 'validation'
        }
      ]
    };
    state.retrying = [
      {
        issue_identifier: 'NIE-128',
        attempt: 1,
        due_at: '2026-05-11T12:56:21.648Z',
        due_state: 'overdue',
        overdue_ms: 540000,
        retry_wait_ms: null,
        stop_reason_code: 'issue_state_refresh_failed',
        stop_reason_detail: 'issue_state_refresh_failed: Linear request failed: TypeError: fetch failed',
        error: 'issue_state_refresh_failed: Linear request failed: TypeError: fetch failed',
        worker_host: 'hessian',
        workspace_path: '/tmp/symphony/NIE-128',
        provisioner_type: 'worktree',
        workspace_provisioned: true,
        workspace_is_git_worktree: true,
        last_phase: 'validation',
        operator_explainer_hint: {
          classification: 'retrying',
          actionability: 'recommended',
          headline: 'Tracker refresh failed after run activity'
        },
        retry_cause: state.retry_status.entries[0]
      }
    ];

    harness.stream().onopen?.();
    harness.stream().onmessage?.({
      data: JSON.stringify({ type: 'state_snapshot', payload: { state } })
    });
    await flushPromises();

    const overviewText = harness.document.getElementById('retry-status-summary').textContent;
    expect(overviewText).toContain('1 overdue retry needs attention');
    expect(overviewText).toContain('NIE-128');
    expect(overviewText).toContain('issue_state_refresh_failed');
    expect(overviewText).toContain('post-run tracker refresh');
    expect(overviewText).toContain('Overdue 9m 0s');
    expect(overviewText).toContain('Last phase: validation');
  });

  it('labels successful polling fallback as polling instead of offline', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    expect(harness.document.getElementById('connection-badge').textContent).toBe('Polling');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('Connecting to live updates; polling is active.');
  });

  it('renders phase age and Codex thread activity as separate clocks', async () => {
    const harness = installDashboardClientHarness();
    vi.setSystemTime(new Date('2026-05-08T15:05:00.000Z'));
    await flushPromises();

    const state = makeStatePayload() as any;
    state.counts.running = 1;
    state.running = [
      {
        issue_identifier: 'NIE-78',
        state: 'In Progress',
        session_id: 'thread-1-turn-1',
        worker_host: 'hessian',
        workspace_path: '/tmp/symphony/NIE-78',
        provisioner_type: 'worktree',
        branch_name: 'feature/NIE-78',
        workspace_git_status: 'clean',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        turn_count: 1,
        current_phase: 'implementation',
        current_phase_at: '2026-05-08T15:00:00.000Z',
        phase_elapsed_ms: 300000,
        phase_timing: {
          phase_started_at: '2026-05-08T15:00:00.000Z',
          phase_elapsed_ms: 300000,
          source: 'symphony_phase_marker'
        },
        codex_thread_activity: {
          thread_id: 'thread-1',
          updated_at: '2026-05-08T15:04:45.000Z',
          updated_at_ms: Date.parse('2026-05-08T15:04:45.000Z'),
          age_ms: 15000,
          source: 'app_server_protocol_thread_updated_at',
          status: 'available',
          thread_status: 'running'
        },
        started_at: '2026-05-08T14:55:00.000Z',
        last_event: 'codex.turn.waiting',
        last_event_summary: 'codex turn waiting: heartbeat',
        last_message: 'heartbeat',
        last_event_at: '2026-05-08T15:04:30.000Z',
        tokens: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        token_telemetry_status: 'available',
        token_telemetry_confidence: 'observed_live',
        token_telemetry_source: 'app_server_protocol',
        turn_control_state: 'agent_turn',
        progress_signal_state: 'heartbeat_only',
        current_blocker_class: null,
        time_since_progress: 300000,
        last_successful_step: 'codex.turn.started',
        transcript_tool_call_diagnostic_summary: null,
        operator_actions: [],
        actions: {}
      }
    ];

    harness.stream().onopen?.();
    harness.stream().onmessage?.({
      data: JSON.stringify({ type: 'state_snapshot', payload: { state } })
    });
    await flushPromises();

    const text = harness.document.getElementById('running-rows').textContent;
    expect(text).toContain('implementation');
    expect(text).toContain('phase unchanged for 5m');
    expect(text).not.toContain('updated 5m ago');
    expect(text).toContain('Agent session active 0m 15s ago');
    expect(text).toContain('codex turn waiting: heartbeat');
    expect(text).toContain('5:04:30');
    expect(text).toContain('(UTC 2026-05-08T15:04:30.000Z)');
  });

  it('renders all token dimensions in overview and running rows', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    const state = makeStatePayload() as any;
    state.counts.running = 1;
    state.codex_totals = {
      total_tokens: 123456,
      input_tokens: 100000,
      output_tokens: 23456,
      cached_input_tokens: 90000,
      reasoning_output_tokens: 3456,
      model_context_window: 200000,
      seconds_running: 0
    };
    state.running = [
      makeRunningSessionPayload({
        tokens: {
          input_tokens: 100000,
          output_tokens: 23456,
          total_tokens: 123456,
          cached_input_tokens: 90000,
          reasoning_output_tokens: 3456,
          model_context_window: 200000
        }
      })
    ];

    harness.stream().onopen?.();
    harness.stream().onmessage?.({
      data: JSON.stringify({ type: 'state_snapshot', payload: { state } })
    });
    await flushPromises();

    const overviewText = harness.document.getElementById('kpi-grid').textContent;
    expect(overviewText).toContain('Codex Enforcement Total123,456');
    expect(overviewText).toContain('Codex Enforcement Input100,000');
    expect(overviewText).toContain('Codex Enforcement Output23,456');
    expect(overviewText).toContain('Codex Cached Input90,000');
    expect(overviewText).toContain('Codex Reasoning Output3,456');
    expect(overviewText).toContain('Codex Max Context200,000');

    const rowText = harness.document.getElementById('running-rows').textContent;
    expect(rowText).toContain('Total: 123,456');
    expect(rowText).toContain('In 100,000 / Out 23,456 / Cached 90,000 / Reasoning 3,456 / Context 200,000');
    expect(rowText).toContain('transcript_token_count');
  });

  it('keeps aggregate-only token fallback from rendering fake split dimensions', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    const state = makeStatePayload() as any;
    state.counts.running = 1;
    state.codex_totals = {
      total_tokens: 321,
      input_tokens: 0,
      output_tokens: 0,
      token_split_status: 'aggregate_only',
      seconds_running: 0
    };
    state.running = [
      makeRunningSessionPayload({
        token_telemetry_source: 'codex_home_state_sqlite',
        tokens: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 321,
          token_split_status: 'aggregate_only'
        }
      })
    ];

    harness.stream().onopen?.();
    harness.stream().onmessage?.({
      data: JSON.stringify({ type: 'state_snapshot', payload: { state } })
    });
    await flushPromises();

    const overviewText = harness.document.getElementById('kpi-grid').textContent;
    expect(overviewText).toContain('Codex Enforcement Total321');
    expect(overviewText).toContain('Codex Enforcement InputSplit unavailable');
    expect(overviewText).toContain('Codex Enforcement OutputSplit unavailable');
    expect(overviewText).toContain('Codex Cached InputSplit unavailable');
    expect(overviewText).toContain('Codex Reasoning OutputSplit unavailable');
    expect(overviewText).toContain('Codex Max Context0');

    const rowText = harness.document.getElementById('running-rows').textContent;
    expect(rowText).toContain('Total: 321');
    expect(rowText).toContain('Split unavailable');
    expect(rowText).toContain('codex_home_state_sqlite');
    expect(rowText).not.toContain('Cached 0');
    expect(rowText).not.toContain('Reasoning 0');
    expect(rowText).not.toContain('Context 0');
  });

  it('renders zero token overview values when no token telemetry exists', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    const state = makeStatePayload() as any;
    state.codex_totals = {
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      seconds_running: 0
    };
    state.running = [];

    harness.stream().onopen?.();
    harness.stream().onmessage?.({
      data: JSON.stringify({ type: 'state_snapshot', payload: { state } })
    });
    await flushPromises();

    const overviewText = harness.document.getElementById('kpi-grid').textContent;
    expect(overviewText).toContain('Codex Enforcement Total0');
    expect(overviewText).toContain('Codex Enforcement Input0');
    expect(overviewText).toContain('Codex Enforcement Output0');
    expect(overviewText).toContain('Codex Cached Input0');
    expect(overviewText).toContain('Codex Reasoning Output0');
    expect(overviewText).toContain('Codex Max Context0');
  });

  it('renders issue console timestamps as local labels with UTC companions', async () => {
    vi.setSystemTime(new Date('2026-05-08T15:05:00.000Z'));
    const runtime = installDashboardClient(async (url) => {
      if (url === '/api/v1/state') {
        return okJson(makeStatePayload());
      }
      if (url === '/api/v1/ui-state') {
        return okJson({ state: null });
      }
      if (url === '/api/v1/diagnostics') {
        return okJson({ runtime_resolution: { observed_at: '2026-05-08T15:00:00.000Z' } });
      }
      if (url === '/api/v1/history?limit=8') {
        return okJson({ runs: [] });
      }
      if (url === '/api/v1/NIE-181') {
        return okJson({
          status: 'blocked',
          snapshot_freshness_state: 'fresh',
          snapshot_age_ms: 0,
          phase_timeline: [
            {
              at: '2026-05-08T15:01:00.000Z',
              phase: 'implementation',
              attempt: 1,
              detail: 'started',
              thread_id: 'thread-1',
              session_id: 'session-1'
            }
          ],
          operator_actions: [
            {
              requested_at_ms: Date.parse('2026-05-08T15:02:00.000Z'),
              actor: 'operator',
              action: 'resume',
              result: 'success',
              result_code: 'accepted',
              reason_note: 'continue',
              message: 'accepted'
            }
          ],
          blocked: {
            stop_reason_code: 'missing_tool_output_recovery',
            session_console: [
              {
                at: '2026-05-08T15:03:00.000Z',
                event: 'codex.turn.waiting',
                message: 'waiting'
              }
            ]
          }
        });
      }
      if (url === '/api/v1/issues/NIE-181/diagnostics') {
        return okJson({
          phase_spans: [],
          tool_spans: [],
          wait_spans: [],
          capability_warnings: [],
          timeline: [
            {
              at_ms: Date.parse('2026-05-08T15:04:00.000Z'),
              event: 'codex.turn.waiting',
              thread_id: 'thread-1',
              turn_id: 'turn-1',
              session_id: 'session-1',
              reason_code: null,
              reason_detail: 'waiting'
            }
          ]
        });
      }
      throw new Error('Unexpected dashboard fetch: ' + url);
    });

    await flushPromises();
    runtime.document.getElementById('issue-input').value = 'NIE-181';
    runtime.document.getElementById('issue-load').click();
    for (let index = 0; index < 5; index += 1) {
      await flushPromises();
    }

    expect(runtime.fetchCalls).toContain('/api/v1/NIE-181');
    const issueOutput = runtime.document.getElementById('issue-output').textContent;
    const consoleText = issueOutput.split('\\n\\nIssue JSON')[0] || issueOutput;
    expect(consoleText).toContain('(UTC 2026-05-08T15:01:00.000Z)');
    expect(consoleText).toContain('(UTC 2026-05-08T15:02:00.000Z)');
    expect(consoleText).toContain('(UTC 2026-05-08T15:03:00.000Z)');
    expect(runtime.document.getElementById('thread-raw-events').textContent).toContain('(UTC 2026-05-08T15:04:00.000Z)');
    expect(consoleText).not.toContain('\\n2026-05-08T15:01:00.000Z |');
    expect(consoleText).not.toContain('\\n2026-05-08T15:03:00.000Z |');
    expect(issueOutput).toContain('Issue JSON (canonical UTC ISO values preserved)');
    expect(runtime.document.getElementById('diagnostics-output').textContent).toContain('Diagnostics JSON (canonical UTC ISO values preserved)');
    expect(runtime.document.getElementById('runtime-resolution-output').textContent).toContain('Runtime Resolution JSON (canonical UTC ISO values preserved)');
  });

  it('resumes fallback polling when the stream errors after a healthy snapshot', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    harness.stream().onopen?.();
    harness.stream().onmessage?.({
      data: JSON.stringify({ type: 'state_snapshot', payload: { state: makeStatePayload() } })
    });
    await flushPromises();
    expect(harness.stateFetchCount()).toBe(1);

    harness.stream().onerror?.();
    await flushPromises();
    expect(harness.stateFetchCount()).toBe(2);
    expect(harness.document.getElementById('connection-badge').textContent).toBe('Polling');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('Stream paused; polling is keeping this view current.');

    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(harness.stateFetchCount()).toBe(3);
  });

  it('keeps manual refresh explicit while stream polling is suspended', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    harness.stream().onopen?.();
    harness.stream().onmessage?.({
      data: JSON.stringify({ type: 'state_snapshot', payload: { state: makeStatePayload() } })
    });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(harness.stateFetchCount()).toBe(1);

    harness.document.getElementById('refresh-button').click();
    await flushPromises();

    expect(harness.refreshFetchCount()).toBe(1);
    expect(harness.stateFetchCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(harness.stateFetchCount()).toBe(2);
  });

  it('lazy-loads stopped-run recovery details only on operator request', () => {
    const html = renderDashboardHtml();
    const clientJs = renderDashboardClientJs();
    const pollBlock = clientJs.slice(clientJs.indexOf('async function loadStateViaPoll()'), clientJs.indexOf('function scheduleStateSave()'));
    const streamBlock = clientJs.slice(clientJs.indexOf('function handleSseEnvelope'), clientJs.indexOf('function connectStream'));

    expect(html).toContain('id="stopped-run-recovery-load"');
    expect(clientJs).toMatch(/fetchJson\(["']\/api\/v1\/stopped-runs\/recovery["']\)/);
    expect(clientJs).toMatch(/elements\.stoppedRunRecoveryLoad\.addEventListener\(["']click["']/);
    expect(clientJs).toContain('Stopped-run recovery detail loads on demand.');
    expect(pollBlock).not.toContain('/api/v1/stopped-runs/recovery');
    expect(streamBlock).not.toContain('/api/v1/stopped-runs/recovery');
  });

  it('preserves stopped-run recovery loaded before the initial state snapshot', async () => {
    const stateRequest = deferred<{ ok: boolean; json(): Promise<unknown> }>();
    const fetchCalls: string[] = [];
    const runtime = installDashboardClient(async (url) => {
      fetchCalls.push(url);
      if (url === '/api/v1/state') {
        return stateRequest.promise;
      }
      if (url === '/api/v1/stopped-runs/recovery') {
        return okJson(createStoppedRunRecoveryPayload());
      }
      if (url === '/api/v1/ui-state') {
        return okJson({ state: null });
      }
      if (url === '/api/v1/diagnostics') {
        return okJson({ runtime_resolution: null });
      }
      if (url === '/api/v1/history?limit=8') {
        return okJson({ runs: [] });
      }
      throw new Error('Unexpected dashboard fetch: ' + url);
    });

    await flushPromises();

    expect(fetchCalls).toContain('/api/v1/state');
    expect(fetchCalls).not.toContain('/api/v1/stopped-runs/recovery');

    const recoveryList = runtime.document.getElementById('stopped-run-recovery-list');
    runtime.document.getElementById('stopped-run-recovery-load').click();
    await flushPromises();

    expect(fetchCalls.filter((url) => url === '/api/v1/stopped-runs/recovery')).toHaveLength(1);
    expect(recoveryList.textContent).toContain('NIE-119');
    expect(recoveryList.textContent).toContain('Capability mismatch');
    expect(recoveryList.textContent).toContain('Browser tool was unavailable.');

    stateRequest.resolve(okJson(createRuntimeStatePayload()));
    await flushPromises();

    expect(recoveryList.textContent).toContain('NIE-119');
    expect(recoveryList.textContent).toContain('Capability mismatch');
    expect(recoveryList.textContent).toContain('Browser tool was unavailable.');
    expect(recoveryList.textContent).not.toContain('No recent stopped runs need recovery.');
  });

  it('snapshots the stuck drilldown rendering vocabulary', () => {
    const clientJs = renderDashboardClientJs();
    const stuckVocabulary = [
      'Blocker Intelligence',
      'Raw Event Stream',
      'expected_auto_transition',
      'time_since_progress',
      'recommended_actions',
      'No raw event stream entries.'
    ].filter((token) => clientJs.includes(token) || renderDashboardHtml().includes(token));

    expect(stuckVocabulary).toMatchInlineSnapshot(`
      [
        "Blocker Intelligence",
        "Raw Event Stream",
        "expected_auto_transition",
        "time_since_progress",
        "recommended_actions",
        "No raw event stream entries.",
      ]
    `);
  });

  it('renders distinct operator copy and safe actions for stalled waiting recovery states', () => {
    const clientJs = renderDashboardClientJs();

    expect(clientJs).toMatch(/return ["']Heartbeat Only["']/);
    expect(clientJs).toMatch(/return ["']Stalled Waiting["']/);
    expect(clientJs).toMatch(/return ["']Retry Scheduled["']/);
    expect(clientJs).toMatch(/return ["']Manual Resume Required["']/);
    expect(clientJs).toMatch(/createActionButton\(["']Inspect Diagnostics["']/);
    expect(clientJs).toMatch(/createActionButton\(["']Cancel Turn["']/);
    expect(clientJs).toMatch(/createActionButton\(["']Requeue["']/);
    expect(clientJs).not.toMatch(/createActionButton\(["']Cleanup Workspace["']/);
  });

  it('renders reason-note prompts for blocked resume and input submission actions', () => {
    const clientJs = renderDashboardClientJs();

    expect(clientJs).toMatch(/window\.prompt\(["']Reason note for resuming this blocked issue["']/);
    expect(clientJs).toContain("resume_override_reason: resumeOverrideReason, reason_note: reasonNote");
    expect(clientJs).toMatch(/window\.prompt\(["']Reason note for submitting this blocked input["']/);
    expect(clientJs).toContain('reason_note: reasonNote');
    expect(clientJs).toContain('Resume skipped: reason note is required');
    expect(clientJs).toContain('Input submit skipped: reason note is required');
  });

  it('renders blocked root cause before the current operator latch reason', () => {
    const clientJs = renderDashboardClientJs();
    const rootCauseIndex = clientJs.indexOf('function createBlockedRootCauseBlock(entry)');
    const currentBlockIndex = clientJs.indexOf('Current operator block: ');

    expect(clientJs).toContain('Workspace provisioning failed: repo root has uncommitted or untracked files.');
    expect(clientJs).toContain('Remediation: ');
    expect(clientJs).toContain('Current block detail: ');
    expect(clientJs).toContain('root-cause-block');
    expect(rootCauseIndex).toBeGreaterThanOrEqual(0);
    expect(currentBlockIndex).toBeGreaterThan(rootCauseIndex);
  });
});
