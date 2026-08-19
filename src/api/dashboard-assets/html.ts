import type { DashboardClientConfig } from './types';

export function renderDashboardHtml(_config?: DashboardClientConfig): string {
  const revision = encodeURIComponent(_config?.asset_revision || 'dev');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="symphony-dashboard-asset-revision" content="${revision}" />
  <title>Symphony Operator Control</title>
  <link rel="icon" href="data:," />
  <link rel="stylesheet" href="/dashboard/styles.css?v=${revision}" />
  <script src="/dashboard/client.js?v=${revision}" defer></script>
</head>
<body>
  <div class="backdrop"></div>
  <header class="hero">
    <div class="hero-copy">
      <p class="eyebrow">Symphony Runtime</p>
      <h1>Operator Control Surface</h1>
      <p class="hero-subtitle">Turn every run from first signal to confident handoff.</p>
    </div>
    <div class="hero-status-card" aria-label="Runtime status">
      <div class="status-row hero-status-topline">
        <span class="status-kicker">Runtime signal</span>
        <span id="connection-badge" class="badge badge-live">Live</span>
      </div>
      <strong class="hero-status-title">Control surface ready</strong>
      <p id="connection-detail" class="hero-status-detail">Live updates are connected.</p>
      <div class="hero-status-meta">
        <span>Snapshot</span>
        <span id="last-updated">Waiting for first snapshot</span>
      </div>
      <div class="hero-actions">
        <button id="refresh-button" class="refresh-now-button" type="button">Refresh Now</button>
        <a id="preview-lens-link" class="preview-lens-link" href="/lens" rel="noopener">Preview Lens</a>
        <span id="refresh-status" aria-live="polite"></span>
      </div>
    </div>
  </header>

  <section id="action-required-banner" class="action-required-banner hidden" role="region" aria-live="polite">
    <strong id="action-required-title">Action Required</strong>
    <span id="action-required-summary"></span>
    <div id="action-required-groups" class="inline-badges"></div>
  </section>

  <section id="runtime-stale-banner" class="runtime-stale-banner hidden" role="region" aria-live="polite">
    <strong id="runtime-stale-title">Runtime Build Warning</strong>
    <span id="runtime-stale-summary"></span>
  </section>

  <section id="runtime-update-banner" class="runtime-update-banner hidden" role="region" aria-live="polite">
    <strong id="runtime-update-title">Runtime Update Available</strong>
    <span id="runtime-update-summary"></span>
    <div class="runtime-update-actions">
      <button id="runtime-update-prepare-button" type="button">Prepare update</button>
      <button id="runtime-update-apply-button" class="ghost-button" type="button">Apply update</button>
    </div>
  </section>

  <section id="api-degraded-banner" class="api-degraded-banner hidden" role="region" aria-live="polite">
    <strong id="api-degraded-title">API Degraded</strong>
    <span id="api-degraded-summary"></span>
  </section>

  <main class="layout">
    <section id="snapshot-error-panel" class="panel panel-wide snapshot-error hidden">
      <div class="panel-head">
        <h2>Snapshot Unavailable</h2>
      </div>
      <p id="snapshot-error-message" class="muted">Snapshot unavailable.</p>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Runtime Overview</h2>
      </div>
      <p id="health-message" class="health health-ok">Dispatch validation: ok</p>
      <p id="last-error" class="muted"></p>
      <div id="kpi-grid" class="kpi-grid"></div>
      <div id="retry-status-summary" class="retry-status-summary hidden" aria-live="polite"></div>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Rate Limits</h2>
      </div>
      <div id="rate-limits" class="rate-limit-grid" aria-live="polite"></div>
    </section>

    <section id="drain-mode-panel" class="panel panel-wide drain-mode-panel" aria-live="polite">
      <div class="panel-head">
        <h2>Drain Mode</h2>
        <div class="drain-actions">
          <button id="drain-enter-button" type="button">Enter Drain Mode</button>
          <button id="drain-exit-button" class="ghost-button" type="button">Exit Drain Mode</button>
          <button id="drain-wait-button" class="ghost-button" type="button">Wait for Quiescence</button>
          <button id="drain-shutdown-button" type="button">Request Safe Shutdown</button>
        </div>
      </div>
      <div class="drain-mode-grid">
        <div>
          <strong id="drain-mode-summary">Drain Mode inactive</strong>
          <p id="drain-mode-boundary" class="drain-boundary">Restart safety has not been evaluated yet.</p>
          <p id="drain-mode-meta" class="muted"></p>
          <p id="drain-control-status" class="muted"></p>
        </div>
        <div id="drain-blockers-list" class="drain-blockers-list"></div>
      </div>
    </section>

    <section id="runtime-update-panel" class="panel panel-wide runtime-update-panel" aria-live="polite">
      <div class="panel-head">
        <h2>Runtime Update</h2>
        <div class="runtime-update-actions">
          <button id="runtime-update-prepare-panel-button" type="button">Prepare update</button>
          <button id="runtime-update-apply-panel-button" class="ghost-button" type="button">Apply update</button>
        </div>
      </div>
      <div class="runtime-update-grid">
        <div>
          <strong id="runtime-update-state">No update action required</strong>
          <p id="runtime-update-recommendation" class="runtime-update-guidance muted">Runtime update readiness has not been evaluated yet.</p>
          <p id="runtime-update-status" class="muted"></p>
        </div>
        <div id="runtime-update-details" class="runtime-update-details">Runtime update details unavailable.</div>
      </div>
    </section>

    <section class="panel panel-wide">
      <details id="throughput-panel" open>
        <summary>Throughput</summary>
        <pre id="throughput-output" class="code-block">No throughput samples yet.</pre>
      </details>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Runtime Resolution</h2>
      </div>
      <pre id="runtime-resolution-output" class="code-block">Runtime resolution unavailable.</pre>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Running Sessions</h2>
        <div class="toolbar">
          <select id="status-filter" aria-label="Status filter">
            <option value="all">All</option>
            <option value="running">Running</option>
            <option value="retrying">Retrying</option>
            <option value="blocked">Blocked</option>
          </select>
          <input id="running-filter" type="search" placeholder="Filter issues (/)" aria-label="Filter running issues" />
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>State</th>
              <th>Session</th>
              <th>Phase</th>
              <th>Runtime</th>
              <th>Turns</th>
              <th>Tokens</th>
              <th>Blocker</th>
              <th>Time Since Progress</th>
              <th>Last Successful Step</th>
              <th>Last Event</th>
              <th>Last Message</th>
              <th>Last Event At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="running-rows">
            <tr><td colspan="14" class="muted">No running issues.</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Retry Queue</h2>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Attempt</th>
              <th>Due At</th>
              <th>Host</th>
              <th>Workspace</th>
              <th>Provisioning</th>
              <th>Stop Reason</th>
              <th>Previous Session</th>
              <th>Error</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="retry-rows">
            <tr><td colspan="10" class="muted">No issues are waiting for retry.</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Blocked Input Required</h2>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Attempt</th>
              <th>Blocked At</th>
              <th>Host</th>
              <th>Workspace</th>
              <th>Stop Reason</th>
              <th>Previous Session</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="blocked-rows">
            <tr><td colspan="8" class="muted">No issues are blocked on operator input.</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Stopped Run Recovery</h2>
        <button id="stopped-run-recovery-load" type="button">Load Recovery</button>
      </div>
      <p class="muted">Use these cards when a run has already stopped and no longer appears in running, retrying, or blocked state. Inspect forensics first, then resume only when the API marks resume valid.</p>
      <div id="stopped-run-recovery-list" class="recovery-list">
        <p class="muted">No recent stopped runs need recovery.</p>
      </div>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Project History</h2>
        <div class="toolbar">
          <input id="project-history-project-key" type="text" placeholder="Project key" aria-label="Project history project key" />
          <button id="project-history-load" type="button">Load History</button>
        </div>
      </div>
      <p id="project-history-status" class="muted">No project history loaded.</p>
      <div id="project-history-facts" class="inline-badges" aria-live="polite"></div>
      <div class="table-wrap">
        <table class="project-history-table">
          <thead>
            <tr>
              <th>Ticket</th>
              <th>State</th>
              <th>Latest Attempt</th>
              <th>Outcome</th>
              <th>References</th>
              <th>Summary</th>
              <th>Facts</th>
              <th>Observed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="project-history-rows">
            <tr><td colspan="9" class="muted">Project history uses bounded ticket rows and loads detail on demand.</td></tr>
          </tbody>
        </table>
      </div>
      <div id="project-history-detail" class="project-history-detail hidden" aria-live="polite"></div>
    </section>

    <section class="panel panel-wide">
      <details id="issue-panel" open>
        <summary>Issue Detail</summary>
        <div class="issue-detail">
          <div class="inline-form">
            <input id="issue-input" type="text" placeholder="ABC-123" aria-label="Issue identifier" />
            <button id="issue-load" type="button">Load</button>
            <button id="issue-open-json" type="button">Open JSON</button>
          </div>
          <p id="issue-summary" class="muted">No issue selected.</p>
          <section class="conversation-panel" aria-live="polite">
            <div class="conversation-panel-head">
              <div>
                <h3>Agent Conversation</h3>
                <p id="conversation-summary" class="muted">No conversation evidence loaded.</p>
              </div>
              <div class="toolbar compact-toolbar" role="group" aria-label="Conversation display controls">
                <select id="conversation-role-filter" aria-label="Conversation role filter">
                  <option value="all">All roles</option>
                  <option value="system">System</option>
                  <option value="user">User</option>
                  <option value="assistant">Assistant</option>
                  <option value="tool">Tool</option>
                  <option value="runtime">Runtime</option>
                </select>
                <select id="conversation-density" aria-label="Conversation density">
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </div>
            </div>
            <ol id="conversation-list" class="conversation-list">
              <li class="muted">Select an issue to inspect messages.</li>
            </ol>
          </section>
          <div id="issue-explainer-card" class="operator-explainer hidden" aria-live="polite">
            <div class="operator-explainer-head">
              <span id="issue-explainer-actionability" class="status-pill">none</span>
              <strong id="issue-explainer-headline">No diagnostics loaded</strong>
            </div>
            <dl class="operator-explainer-grid">
              <div>
                <dt>Classification</dt>
                <dd id="issue-explainer-classification">n/a</dd>
              </div>
              <div>
                <dt>Reason</dt>
                <dd id="issue-explainer-reason">n/a</dd>
              </div>
              <div>
                <dt>Recommended Action</dt>
                <dd id="issue-explainer-action">n/a</dd>
              </div>
              <div>
                <dt>Expected Transition</dt>
                <dd id="issue-explainer-transition">n/a</dd>
              </div>
              <div>
                <dt>Map Version</dt>
                <dd id="issue-explainer-version">n/a</dd>
              </div>
            </dl>
            <p id="issue-explainer-detail" class="muted"></p>
          </div>
          <div id="thread-detail" class="thread-detail hidden" aria-live="polite">
            <div class="thread-detail-grid">
              <section class="thread-detail-section">
                <h3>Timeline Lanes</h3>
                <div id="thread-timeline-lanes" class="timeline-lanes"></div>
              </section>
              <section class="thread-detail-section">
                <h3>Blocker Intelligence</h3>
                <dl id="thread-blocker-card" class="blocker-card"></dl>
              </section>
              <section class="thread-detail-section">
                <h3>Capability Warnings</h3>
                <div id="thread-capability-warnings" class="capability-warnings muted">No capability warnings.</div>
              </section>
            </div>
            <section class="thread-detail-section">
              <h3>Raw Event Stream</h3>
              <pre id="thread-raw-events" class="code-block raw-event-stream">No thread diagnostics loaded.</pre>
            </section>
          </div>
          <pre id="issue-output" class="code-block">Select a running issue or enter an issue identifier.</pre>
        </div>
      </details>
    </section>

    <section class="panel panel-wide">
      <details id="runtime-events-panel" open>
        <summary>Runtime Event Feed</summary>
        <div class="toolbar">
          <select id="event-feed-filter" aria-label="Runtime event severity filter">
            <option value="all">All</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </div>
        <ul id="runtime-events-list" class="list">
          <li class="muted">No runtime events.</li>
        </ul>
      </details>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Diagnostics</h2>
      </div>
      <pre id="diagnostics-output" class="code-block">Diagnostics unavailable.</pre>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Recent Runs</h2>
      </div>
      <ul id="history-list" class="list">
        <li class="muted">No run history available.</li>
      </ul>
    </section>
  </main>
</body>
</html>`;
}
