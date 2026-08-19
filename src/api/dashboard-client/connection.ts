import { DASHBOARD_CONFIG } from './config';
import { elements } from './dom';
import { state } from './state';
import { formatApiError, formatCanonicalJsonBlock, formatDate, formatDurationFromIso } from './formatting';
import { renderActionRequiredBanner, renderApiDegradedBanner, renderOverview } from './overview';
import { renderThroughput, renderRuntimeEvents, renderRuntimeResolution, renderSnapshotError, clearSnapshotError } from './runtime';
import { renderRunning, renderRetry, renderBlocked } from './issues';
import { renderStoppedRunRecovery, mergeStoppedRunRecoveryPayload } from './stopped-runs';
import { loadIssue } from './issue-detail';
import { renderProjectHistory, loadProjectHistory, projectKeyFromHistoryPayload } from './project-history';

let issueDetailRefreshInFlight = false;
let issueDetailRefreshQueued = false;

function normalizeConversationRole(value: any) {
    return value === 'system' ||
      value === 'user' ||
      value === 'assistant' ||
      value === 'tool' ||
      value === 'runtime'
      ? value
      : 'all';
  }

function normalizeConversationDensity(value: any) {
    return value === 'compact' ? 'compact' : 'comfortable';
  }

export function refreshSelectedIssueDetail() {
    if (!state.selectedIssue || !elements.issuePanel || !elements.issuePanel.open) {
      issueDetailRefreshQueued = false;
      return;
    }
    if (issueDetailRefreshInFlight) {
      issueDetailRefreshQueued = true;
      return;
    }

    issueDetailRefreshInFlight = true;
    void loadIssue(state.selectedIssue, { openPanel: false }).finally(function () {
      issueDetailRefreshInFlight = false;
      if (!issueDetailRefreshQueued) {
        return;
      }
      issueDetailRefreshQueued = false;
      refreshSelectedIssueDetail();
    });
  }

export function getConnectionLabel(mode: any) {
    switch (mode) {
      case 'streaming':
        return 'Streaming';
      case 'polling':
        return 'Polling';
      case 'connecting':
        return 'Connecting';
      default:
        return 'Offline';
    }
  }

export function getConnectionClass(mode: any) {
    switch (mode) {
      case 'streaming':
        return 'badge badge-live';
      case 'polling':
        return 'badge badge-polling';
      case 'connecting':
        return 'badge badge-connecting';
      default:
        return 'badge badge-offline';
    }
  }

export function describeStreamFallback() {
    if (state.streamConnected && !state.streamSnapshotHealthy) {
      return 'Stream connected; waiting for the first snapshot.';
    }
    if (state.streamFallbackReason === 'error') {
      return 'Stream paused; polling is keeping this view current.';
    }
    if (state.streamFallbackReason === 'connecting') {
      return 'Connecting to live updates; polling is active.';
    }
    return 'Live stream unavailable; polling is active.';
  }

export function setConnectionStatus(mode: any, detail: any) {
    state.connection = mode;
    elements.connectionBadge.textContent = getConnectionLabel(mode);
    elements.connectionBadge.className = getConnectionClass(mode);
    elements.connectionDetail.textContent = detail;
  }

export function formatHeroSnapshotAge(ageMs: any) {
    if (!Number.isFinite(ageMs)) {
      return null;
    }
    const seconds = Math.max(0, Math.floor(Number(ageMs) / 1000));
    if (seconds < 60) {
      return 'Updated just now';
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return 'Updated ' + minutes + 'm ago';
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return 'Updated ' + hours + 'h' + (remainingMinutes ? ' ' + remainingMinutes + 'm' : '') + ' ago';
  }

export function formatHeroSnapshotFreshness(value: any) {
    const payload = state.payload;
    const generatedAtMs = payload && typeof payload.snapshot_generated_at_ms === 'number'
      ? payload.snapshot_generated_at_ms
      : Date.parse(value || '');
    if (!Number.isFinite(generatedAtMs)) {
      return { text: 'Waiting for first snapshot', title: '' };
    }
    const snapshotAgeMs = payload && typeof payload.snapshot_age_ms === 'number'
      ? payload.snapshot_age_ms
      : Date.now() - generatedAtMs;
    const ageText = formatHeroSnapshotAge(snapshotAgeMs) || 'Snapshot time available';
    const freshness = payload && payload.snapshot_freshness_state
      ? String(payload.snapshot_freshness_state).replace(/_/g, ' ')
      : '';
    return {
      text: ageText + (freshness ? ' • Snapshot ' + freshness : ''),
      title: 'Snapshot generated at ' + formatDate(value)
    };
  }

export function setLastUpdated(value: any) {
    const freshness = formatHeroSnapshotFreshness(value);
    elements.lastUpdated.textContent = freshness.text;
    elements.lastUpdated.title = freshness.title;
  }

export function setRefreshStatus(message: any, isError: any) {
    elements.refreshStatus.textContent = message;
    elements.refreshStatus.className = isError ? 'status-error' : 'status-ok';
  }

export function isStreamHealthy() {
    return state.streamConnected && state.streamSnapshotHealthy;
  }

export function clearPollTimer() {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

export function schedulePollingFallback() {
    clearPollTimer();
    if (isStreamHealthy()) {
      return;
    }
    state.pollTimer = setTimeout(loadStateViaPoll, state.pollDelayMs);
  }

export function applyPayload(payload: any, source: any) {
    if (payload && payload.error) {
      renderSnapshotError(payload.error);
      setLastUpdated(payload.generated_at || new Date().toISOString());
      return false;
    }

    clearSnapshotError();
    if (state.stoppedRunRecoveryLoaded && state.stoppedRunRecoveryPayload) {
      payload = mergeStoppedRunRecoveryPayload(payload, state.stoppedRunRecoveryPayload);
    }
    state.payload = payload;
    state.lastGoodPayload = payload;
    renderOverview(payload);
    renderActionRequiredBanner(payload);
    renderApiDegradedBanner(payload);
    renderThroughput(payload);
    renderRunning(payload);
    renderRetry(payload);
    renderBlocked(payload);
    renderStoppedRunRecovery(payload);
    renderRuntimeEvents(payload);
    setLastUpdated(payload.generated_at || new Date().toISOString());
    refreshSelectedIssueDetail();
    if (source === 'stream') {
      state.streamSnapshotHealthy = true;
      state.streamStatus = 'streaming';
      state.streamFallbackReason = null;
      setConnectionStatus('streaming', 'Live updates are flowing.');
      state.pollDelayMs = DASHBOARD_CONFIG.refresh_ms;
      clearPollTimer();
    }
    return true;
  }

export function updateRuntimeClock() {
    if (state.lastGoodPayload) {
      renderOverview(state.lastGoodPayload);
    }
    const runtimeCells = document.querySelectorAll('.runtime-cell');
    for (const runtimeCell of runtimeCells) {
      const startedAt = runtimeCell.getAttribute('data-started-at');
      runtimeCell.textContent = formatDurationFromIso(startedAt);
    }
  }

export async function fetchJson(url: any, init?: any) {
    const response = await fetch(url, init);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(formatApiError(payload, 'Request failed'));
    }
    return payload;
  }

export async function loadStateViaPoll() {
    try {
      const payload = await fetchJson('/api/v1/state');
      const usablePayload = applyPayload(payload, 'poll');
      if (isStreamHealthy()) {
        setConnectionStatus('streaming', 'Live updates are flowing.');
      } else if (usablePayload) {
        setConnectionStatus('polling', describeStreamFallback());
      } else {
        setConnectionStatus('offline', 'Polling returned snapshot error');
      }
      state.pollDelayMs = DASHBOARD_CONFIG.refresh_ms;
    } catch (error) {
      setConnectionStatus('offline', 'Polling failed');
      setRefreshStatus('Polling failed: ' + String(error), true);
      state.pollDelayMs = Math.min(state.pollDelayMs * 2, 30000);
    } finally {
      schedulePollingFallback();
    }
  }

export function scheduleStateSave() {
    if (!state.uiStateLoaded) {
      return;
    }

    clearTimeout(state.uiStateSaveTimer);
    state.uiStateSaveTimer = setTimeout(async function () {
      try {
        await fetch('/api/v1/ui-state', {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            state: {
              selected_issue: state.selectedIssue || null,
              filters: {
                status: state.filter.status,
                query: state.filter.query,
                conversation_role: state.filter.conversationRole,
                conversation_density: state.filter.conversationDensity
              },
              event_feed_filter: state.filter.eventFeedSeverity,
              panels: {
                throughput_open: !!elements.throughputPanel.open,
                runtime_events_open: !!elements.runtimeEventsPanel.open
              },
              panel_state: {
                issue_detail_open: !!elements.issuePanel.open
              }
            }
          })
        });
      } catch {
        // Keep UI responsive; persistence failures are non-fatal.
      }
    }, 250);
  }

export async function loadUiState() {
    try {
      const response = await fetch('/api/v1/ui-state');
      if (!response.ok) {
        state.uiStateLoaded = true;
        return;
      }
      const payload = await response.json();
      const restored = payload.state;
      if (!restored) {
        state.uiStateLoaded = true;
        return;
      }

      state.selectedIssue = restored.selected_issue || '';
      state.filter.query = restored.filters && restored.filters.query ? restored.filters.query : '';
      state.filter.status = restored.filters && restored.filters.status ? restored.filters.status : 'all';
      state.filter.conversationRole = normalizeConversationRole(restored.filters && restored.filters.conversation_role);
      state.filter.conversationDensity = normalizeConversationDensity(restored.filters && restored.filters.conversation_density);
      state.filter.eventFeedSeverity = restored.event_feed_filter || 'all';
      state.panels.throughputOpen =
        restored.panels && typeof restored.panels.throughput_open === 'boolean' ? restored.panels.throughput_open : true;
      state.panels.runtimeEventsOpen =
        restored.panels && typeof restored.panels.runtime_events_open === 'boolean'
          ? restored.panels.runtime_events_open
          : true;

      elements.issueInput.value = state.selectedIssue;
      elements.runningFilter.value = state.filter.query;
      elements.statusFilter.value = state.filter.status;
      elements.conversationRoleFilter.value = state.filter.conversationRole;
      elements.conversationDensity.value = state.filter.conversationDensity;
      elements.eventFeedFilter.value = state.filter.eventFeedSeverity;
      elements.throughputPanel.open = state.panels.throughputOpen;
      elements.runtimeEventsPanel.open = state.panels.runtimeEventsOpen;
      if (restored.panel_state && typeof restored.panel_state.issue_detail_open === 'boolean') {
        elements.issuePanel.open = restored.panel_state.issue_detail_open;
      }

      state.uiStateLoaded = true;

      if (state.selectedIssue && elements.issuePanel.open) {
        void loadIssue(state.selectedIssue, { openPanel: false });
      }
    } catch {
      state.uiStateLoaded = true;
    }
  }

export async function refreshNow() {
    try {
      const payload = await fetchJson('/api/v1/refresh', { method: 'POST' });
      setRefreshStatus(payload.coalesced ? 'Refresh request coalesced' : 'Refresh queued', false);
      await loadStateViaPoll();
    } catch (error) {
      setRefreshStatus('Refresh failed: ' + String(error), true);
    }
  }

export async function loadDiagnostics() {
    try {
      const diagnostics = await fetchJson('/api/v1/diagnostics');
      state.runtimeResolution = diagnostics.runtime_resolution || null;
      elements.diagnosticsOutput.textContent = formatCanonicalJsonBlock('Diagnostics JSON', diagnostics);
      renderRuntimeResolution(state.runtimeResolution);
    } catch {
      elements.diagnosticsOutput.textContent = 'Diagnostics unavailable.';
      state.runtimeResolution = null;
      renderRuntimeResolution(null);
    }

    try {
      const historyPayload = await fetchJson('/api/v1/history?limit=8');
      const discoveredProjectKey = projectKeyFromHistoryPayload(historyPayload);
      if (discoveredProjectKey && !state.projectHistory.projectKey) {
        state.projectHistory.projectKey = discoveredProjectKey;
        void loadProjectHistory(discoveredProjectKey);
      } else {
        renderProjectHistory();
      }
      const runs = Array.isArray(historyPayload.runs) ? historyPayload.runs : [];
      if (!runs.length) {
        const empty = document.createElement('li');
        empty.className = 'muted';
        empty.textContent = 'No run history available.';
        elements.historyList.replaceChildren(empty);
        return;
      }

      const nodes = runs.map((entry: any) => {
        const item = document.createElement('li');
        const title = document.createElement('strong');
        title.textContent = entry.issue_identifier + ' (' + (entry.workflow_outcome || entry.terminal_status || 'active') + ')';
        const meta = document.createElement('span');
        meta.textContent =
          ' • process ' + (entry.process_status || 'n/a') +
          ' • started ' + formatDate(entry.started_at) +
          (entry.ended_at ? ' • ended ' + formatDate(entry.ended_at) : '');
        item.append(title, meta);
        return item;
      });
      elements.historyList.replaceChildren(...nodes);
    } catch {
      const empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = 'History unavailable.';
      elements.historyList.replaceChildren(empty);
    }
  }

export function handleSseEnvelope(envelope: any) {
    if (!envelope || typeof envelope !== 'object') {
      return;
    }

    const type = envelope.type;
    const payload = envelope.payload;

    if (type === 'state_snapshot' && payload && payload.state) {
      applyPayload(payload.state, 'stream');
      return;
    }

    if (type === 'refresh_accepted' && payload && payload.accepted) {
      setRefreshStatus(payload.accepted.coalesced ? 'Refresh request coalesced' : 'Refresh queued', false);
      return;
    }

    if (type === 'runtime_health_changed' && payload && payload.health) {
      const dispatch = payload.health.dispatch_validation || 'unknown';
      const message = payload.health.last_error ? payload.health.last_error : 'health changed';
      setRefreshStatus('Health changed: ' + dispatch + ' (' + message + ')', dispatch === 'failed');
      return;
    }
  }

export function connectStream() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }

    const stream = new EventSource('/api/v1/events');
    state.eventSource = stream;
    state.streamStatus = 'connecting';
    state.streamFallbackReason = 'connecting';
    setConnectionStatus('connecting', 'Connecting to live updates; polling is active.');

    stream.onopen = function () {
      state.streamConnected = true;
      state.streamSnapshotHealthy = false;
      state.streamStatus = 'connected_waiting_snapshot';
      state.streamFallbackReason = 'waiting_first_snapshot';
      state.streamRetryMs = 1000;
      setConnectionStatus('connecting', 'Stream connected; waiting for the first snapshot.');
    };

    function handleStreamMessage(event: any) {
      try {
        const envelope = JSON.parse(event.data);
        handleSseEnvelope(envelope);
      } catch {
        // Ignore malformed envelopes.
      }
    }

    stream.onmessage = handleStreamMessage;
    stream.addEventListener('symphony', handleStreamMessage);

    stream.onerror = function () {
      state.streamConnected = false;
      state.streamSnapshotHealthy = false;
      state.streamStatus = 'error';
      state.streamFallbackReason = 'error';
      setConnectionStatus('connecting', 'Stream paused; polling is keeping this view current.');
      stream.close();
      state.eventSource = null;
      void loadStateViaPoll();
      setTimeout(connectStream, state.streamRetryMs);
      state.streamRetryMs = Math.min(state.streamRetryMs * 2, 15000);
    };
  }
