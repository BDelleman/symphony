import { ACTION_REQUIRED_CODES } from './config';

export function formatNumber(value: any) {
    if (!Number.isFinite(value)) {
      return '0';
    }
    return value.toLocaleString('en-US');
  }

export function localTimeZoneLabel() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
    } catch (_error) {
      return 'local time';
    }
  }

export function formatUtcIso(timestampMs: any) {
    if (!Number.isFinite(timestampMs)) {
      return 'n/a';
    }
    return new Date(timestampMs).toISOString();
  }

export function formatDate(value: any) {
    if (!value) {
      return 'n/a';
    }
    let parsed;
    if (typeof value === 'number' && Number.isFinite(value)) {
      parsed = value;
    } else {
      parsed = Date.parse(value);
    }
    if (!Number.isFinite(parsed)) {
      return String(value);
    }
    const local = new Date(parsed).toLocaleString(undefined, { timeZoneName: 'short' });
    return local + ' [' + localTimeZoneLabel() + '] (UTC ' + formatUtcIso(parsed) + ')';
  }

export function formatCanonicalJsonBlock(label: any, payload: any) {
    return label + ' (canonical UTC ISO values preserved)\\n' + JSON.stringify(payload, null, 2);
  }

export function formatDurationFromIso(iso: any) {
    const parsed = Date.parse(iso || '');
    if (!Number.isFinite(parsed)) {
      return 'n/a';
    }
    const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remain = seconds % 60;
    return minutes + 'm ' + remain + 's';
  }

export function formatDurationFromEpochMs(epochMs: any) {
    if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
      return 'n/a';
    }
    return formatDurationFromMs(epochMs);
  }

export function getTurnControlLabel(state: any) {
    switch (state) {
      case 'agent_turn':
        return 'Agent Turn';
      case 'operator_turn':
        return 'Operator Turn';
      case 'blocked_manual_resume':
        return 'Manual Resume Required';
      case 'automation_fault':
        return 'Automation Fault';
      default:
        return 'Turn Unknown';
    }
  }

export function getProgressSignalLabel(state: any) {
    switch (state) {
      case 'advancing':
        return 'Advancing';
      case 'heartbeat_only':
        return 'Heartbeat Only';
      case 'active_but_opaque':
        return 'Active But Opaque';
      case 'stalled_waiting':
        return 'Stalled Waiting';
      default:
        return 'Progress Unknown';
    }
  }

export function getRetryStateLabel(entry: any) {
    if (entry && entry.due_state === 'overdue') {
      return 'Retry Overdue';
    }
    return 'Retry Scheduled';
  }

export function getTokenConfidenceLabel(confidence: any) {
    switch (confidence) {
      case 'observed_live':
        return 'Live';
      case 'backfilled':
        return 'Backfilled';
      case 'missing':
        return 'Missing';
      default:
        return 'Unknown';
    }
  }
export function formatDurationFromMs(timestampMs: any) {
    if (!Number.isFinite(timestampMs)) {
      return 'n/a';
    }
    const seconds = Math.max(0, Math.floor((Date.now() - Number(timestampMs)) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remain = seconds % 60;
    return minutes + 'm ' + remain + 's';
  }

export function formatElapsedMs(durationMs: any) {
    if (!Number.isFinite(durationMs)) {
      return 'n/a';
    }
    const seconds = Math.max(0, Math.floor(Number(durationMs) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remain = seconds % 60;
    return minutes + 'm ' + remain + 's';
  }

export function getActionRequiredLabel(code: any) {
    return ACTION_REQUIRED_CODES[code] || code || 'unknown';
  }

export function createBlockedRootCauseBlock(entry: any) {
    if (!entry || !entry.root_cause) {
      return null;
    }
    const block = document.createElement('div');
    block.className = 'root-cause-block';
    const label = document.createElement('div');
    label.className = 'root-cause-label';
    label.textContent = 'Root cause';
    const summary = document.createElement('div');
    summary.className = 'root-cause-summary';
    const rootCauseSummary =
      entry.root_cause.reason_code === 'worktree_dirty_repo'
        ? 'Workspace provisioning failed: repo root has uncommitted or untracked files.'
        : entry.root_cause.summary || entry.root_cause.detail || entry.root_cause.reason_code || 'n/a';
    summary.textContent = rootCauseSummary;
    block.append(label, summary);
    if (entry.root_cause.detail) {
      const detail = document.createElement('div');
      detail.className = 'muted';
      detail.textContent = 'Failed phase detail: ' + entry.root_cause.detail;
      block.append(detail);
    }
    const remediationHint =
      entry.root_cause.remediation_hint ||
      (entry.root_cause.reason_code === 'worktree_dirty_repo'
        ? 'Clean, commit, or ignore the dirty repo files, then requeue or resume.'
        : null);
    if (remediationHint) {
      const remediation = document.createElement('div');
      remediation.className = 'status-pill pending';
      remediation.textContent = 'Remediation: ' + remediationHint;
      block.append(remediation);
    }
    return block;
  }

export function isActionRequiredCode(code: any) {
    return Boolean(code && ACTION_REQUIRED_CODES[code]);
  }

export function formatBudgetStatusLabel(status: any) {
    switch (status) {
      case 'warning':
        return 'Warning';
      case 'hard_limited':
        return 'Hard limited';
      case 'telemetry_unavailable':
        return 'Telemetry unavailable';
      case 'ok':
        return 'Ok';
      default:
        return 'Not configured';
    }
  }

export function budgetStatusClass(status: any) {
    if (status === 'hard_limited') {
      return 'failed';
    }
    if (status === 'warning' || status === 'telemetry_unavailable') {
      return 'pending';
    }
    return 'success';
  }

export function createBudgetBlock(entry: any) {
    const container = document.createElement('div');
    container.className = 'budget-summary';
    const status = entry && entry.budget_status ? entry.budget_status : null;
    const statusPill = document.createElement('div');
    statusPill.className = 'status-pill ' + budgetStatusClass(status);
    statusPill.textContent = 'Budget: ' + formatBudgetStatusLabel(status);
    container.append(statusPill);

    const detail = document.createElement('div');
    detail.className = 'muted';
    if (status === 'telemetry_unavailable') {
      detail.textContent = 'Budget usage unavailable; not counted as zero.';
    } else if (typeof entry.budget_usage_tokens === 'number' || typeof entry.budget_limit_tokens === 'number') {
      const usage = typeof entry.budget_usage_tokens === 'number' ? formatNumber(entry.budget_usage_tokens) : 'n/a';
      const limit = typeof entry.budget_limit_tokens === 'number' ? formatNumber(entry.budget_limit_tokens) : 'n/a';
      detail.textContent = usage + ' / ' + limit + ' tokens';
    } else {
      detail.textContent = 'No token budget configured.';
    }
    container.append(detail);

    const metaParts = [];
    if (typeof entry.budget_window_minutes === 'number') {
      metaParts.push('Window ' + formatNumber(entry.budget_window_minutes) + 'm');
    }
    if (entry.budget_policy) {
      metaParts.push('Policy ' + entry.budget_policy);
    }
    if (metaParts.length) {
      const meta = document.createElement('div');
      meta.className = 'muted';
      meta.textContent = metaParts.join(' • ');
      container.append(meta);
    }
    if (entry.budget_message) {
      const message = document.createElement('div');
      message.className = status === 'hard_limited' ? 'status-error' : 'muted';
      message.textContent = 'Budget stopped continuation: ' + entry.budget_message;
      container.append(message);
    }
    return container;
  }

export function formatBudgetSummary(entry: any) {
    const status = entry && entry.budget_status ? entry.budget_status : null;
    const parts = ['Budget: ' + formatBudgetStatusLabel(status)];
    if (status === 'telemetry_unavailable') {
      parts.push('usage unavailable');
    } else if (entry && (typeof entry.budget_usage_tokens === 'number' || typeof entry.budget_limit_tokens === 'number')) {
      const usage = typeof entry.budget_usage_tokens === 'number' ? formatNumber(entry.budget_usage_tokens) : 'n/a';
      const limit = typeof entry.budget_limit_tokens === 'number' ? formatNumber(entry.budget_limit_tokens) : 'n/a';
      parts.push(usage + ' / ' + limit + ' tokens');
    }
    if (entry && typeof entry.budget_window_minutes === 'number') {
      parts.push('window ' + formatNumber(entry.budget_window_minutes) + 'm');
    }
    if (entry && entry.budget_policy) {
      parts.push('policy ' + entry.budget_policy);
    }
    if (entry && entry.budget_message) {
      parts.push(entry.budget_message);
    }
    return parts.join(' • ');
  }

export function formatTokenDimension(value: any, unavailableLabel: any) {
    return typeof value === 'number' ? formatNumber(value) : unavailableLabel;
  }

export function formatOverviewTokenValue(payload: any, field: any, splitUnavailable: any) {
    const codexTotals = payload && payload.codex_totals;
    if (!codexTotals) {
      return 'Unavailable';
    }
    if (splitUnavailable && field !== 'total_tokens' && field !== 'model_context_window') {
      return 'Split unavailable';
    }
    return formatTokenDimension(codexTotals[field], '0');
  }

export function formatTokenBreakdown(tokens: any, telemetrySource: any) {
    if (tokens && tokens.token_split_status === 'aggregate_only') {
      return 'Split unavailable' + (telemetrySource ? ' • ' + telemetrySource : '');
    }
    const parts = [
      'In ' + formatNumber(tokens.input_tokens),
      'Out ' + formatNumber(tokens.output_tokens)
    ];
    if (typeof tokens.cached_input_tokens === 'number') {
      parts.push('Cached ' + formatNumber(tokens.cached_input_tokens));
    }
    if (typeof tokens.reasoning_output_tokens === 'number') {
      parts.push('Reasoning ' + formatNumber(tokens.reasoning_output_tokens));
    }
    if (typeof tokens.model_context_window === 'number') {
      parts.push('Context ' + formatNumber(tokens.model_context_window));
    }
    return parts.join(' / ') + (telemetrySource ? ' • ' + telemetrySource : '');
  }

export function formatProviderUsage(usage: any) {
    if (!usage || usage.status === 'unobserved') {
      return 'Provider usage missing' + (usage && usage.missing_reason ? ' • ' + usage.missing_reason : '');
    }
    if (usage.status === 'awaiting') {
      return 'Awaiting first provider usage payload';
    }
    const value = function (field: string) {
      return typeof usage[field] === 'number' ? formatNumber(usage[field]) : 'n/a';
    };
    const parts = [
      'In ' + value('input_tokens'),
      'Out ' + value('output_tokens'),
      'Cache read ' + value('cache_read_tokens'),
      'Cache create ' + value('cache_creation_tokens'),
      'Provider turns ' + value('provider_turn_count')
    ];
    if (usage.status === 'final' && typeof usage.estimated_cost_usd === 'number') {
      parts.push('Estimated $' + Number(usage.estimated_cost_usd).toFixed(4));
    }
    parts.push(usage.status + ' • ' + usage.confidence);
    if (usage.supervised_session_coverage) parts.push('coverage ' + usage.supervised_session_coverage);
    if (typeof usage.api_retry_count === 'number') parts.push('API retries ' + formatNumber(usage.api_retry_count));
    const tools = Object.entries(usage.tool_counts || {});
    if (tools.length) parts.push('tools ' + tools.map(function (entry: any) { return entry[0] + ':' + entry[1]; }).join(', '));
    const mcp = Object.entries(usage.mcp_counts || {});
    if (mcp.length) parts.push('MCP ' + mcp.map(function (entry: any) { return entry[0] + ':' + entry[1]; }).join(', '));
    if (usage.updated_at) parts.push('updated ' + formatDate(usage.updated_at));
    return parts.join(' / ');
  }

export function formatApiError(payload: any, fallbackMessage: any) {
    if (!payload || !payload.error) {
      return fallbackMessage;
    }
    if (payload.error.code && payload.error.message) {
      return payload.error.code + ': ' + payload.error.message;
    }
    if (payload.error.message) {
      return String(payload.error.message);
    }
    return fallbackMessage;
  }
