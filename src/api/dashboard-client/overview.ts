import { OPERATOR_TRANSITION_RULES } from './config';
import { elements } from './dom';
import { state } from './state';
import { formatDate, formatElapsedMs, formatNumber, getActionRequiredLabel, isActionRequiredCode, formatOverviewTokenValue, formatTokenDimension } from './formatting';
import { renderRunning, renderRetry, renderBlocked } from './issues';

const DRAIN_BLOCKER_LABELS: Record<string, string> = {
  active_worker: 'Active workers',
  live_codex_app_server_process: 'Agent runner processes',
  pending_retry: 'Pending retries',
  in_flight_tracker_write: 'Tracker writes',
  persistence_history_write: 'Current persistence/history writes',
  unknown_degraded_blocker_source_health: 'Unknown/degraded current blocker source',
  stale_runtime: 'Legacy stale-runtime blocker',
  unknown_current_build_identity: 'Legacy build-identity blocker'
};

const DRAIN_WARNING_LABELS: Record<string, string> = {
  stale_runtime_warning: 'Stale runtime warning',
  unknown_current_build_identity_warning: 'Build identity warning',
  persistence_history_degraded: 'Audit-health degradation'
};

const DRAIN_BLOCKER_ORDER = [
  'active_worker',
  'live_codex_app_server_process',
  'pending_retry',
  'in_flight_tracker_write',
  'persistence_history_write',
  'unknown_degraded_blocker_source_health',
  'stale_runtime',
  'unknown_current_build_identity'
];

function formatPendingWorkDetail(entry: any) {
    const stateName = String(entry && entry.state ? entry.state : 'Unknown');
    const count = Number(entry && entry.count) || 0;
    const countLabel = formatNumber(count);
    if (entry && entry.maintenance_eligible) {
      return 'Pending ' + stateName + ' maintenance work ' + countLabel + ': maintenance-eligible, not an active agent.';
    }
    if (stateName === 'Agent Review') {
      return 'Pending Agent Review normal review work ' + countLabel + ': blocked until Symphony restarts on the current build, not an active agent.';
    }
    return 'Pending ' + stateName + ' normal work ' + countLabel + ': blocked until Symphony restarts on the current build, not an active agent.';
  }

function isRecord(value: any): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

function humanizeRateLimitKey(value: string) {
    return String(value || 'Rate limit')
      .replace(/[_-]/g, ' ')
      .replace(/\b\w/g, function (character) {
        return character.toUpperCase();
      });
  }

function numberFromFields(source: Record<string, any>, keys: string[]) {
    for (const key of keys) {
      const value = Number(source[key]);
      if (Number.isFinite(value)) {
        return value;
      }
    }
    return null;
  }

function formatRateLimitValue(value: number | null) {
    return value === null ? 'n/a' : formatNumber(value);
  }

function valueFromFields(source: Record<string, any>, keys: string[]) {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && value !== '') {
        return value;
      }
    }
    return null;
  }

function formatRateLimitDetailValue(value: any) {
    if (value === null || value === undefined || value === '') {
      return 'n/a';
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 1_000_000_000_000) {
        return formatDate(value);
      }
      return formatNumber(value);
    }
    return String(value);
  }

function parseRateLimitDate(value: any) {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const timestamp = value > 1_000_000_000_000 ? value : value * 1000;
      return Number.isFinite(timestamp) ? timestamp : null;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

function formatCompactDuration(seconds: number | null) {
    if (seconds === null || !Number.isFinite(seconds)) {
      return 'n/a';
    }
    const rounded = Math.max(0, Math.round(seconds));
    const days = Math.floor(rounded / 86400);
    const hours = Math.floor((rounded % 86400) / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    if (days > 0) {
      return days + 'd ' + hours + 'h';
    }
    if (hours > 0) {
      return hours + 'h ' + minutes + 'm';
    }
    return minutes + 'm';
  }

function windowSecondsFromRateLimit(entry: Record<string, any>) {
    const seconds = numberFromFields(entry, ['window_seconds', 'windowSeconds', 'reset_seconds', 'resetSeconds']);
    if (seconds !== null) {
      return seconds;
    }
    const minutes = numberFromFields(entry, ['window_minutes', 'windowMinutes']);
    if (minutes !== null) {
      return minutes * 60;
    }
    const hours = numberFromFields(entry, ['window_hours', 'windowHours']);
    if (hours !== null) {
      return hours * 3600;
    }
    const days = numberFromFields(entry, ['window_days', 'windowDays']);
    if (days !== null) {
      return days * 86400;
    }
    return null;
  }

function resetTimestampFromRateLimit(entry: Record<string, any>) {
    const direct = valueFromFields(entry, ['reset_at', 'resetAt', 'resets_at', 'resetsAt', 'reset_time', 'resetTime']);
    const parsed = parseRateLimitDate(direct);
    if (parsed !== null) {
      return parsed;
    }
    const resetInSeconds = numberFromFields(entry, ['reset_in_seconds', 'resetInSeconds', 'resets_in_seconds', 'resetsInSeconds']);
    if (resetInSeconds !== null) {
      return Date.now() + resetInSeconds * 1000;
    }
    return null;
  }

function describeRateLimitProjection(entry: Record<string, any>, remaining: number | null, limit: number | null, resetAtMs: number | null, windowSeconds: number | null) {
    if (remaining === null || limit === null || limit <= 0 || resetAtMs === null || windowSeconds === null || windowSeconds <= 0) {
      return {
        status: 'schedule unknown',
        detail: 'Add reset and window data to project depletion.',
        surplusLabel: 'Surplus n/a',
        runwayLabel: 'Run-out n/a'
      };
    }
    const secondsToReset = Math.max(0, (resetAtMs - Date.now()) / 1000);
    const expectedRemaining = limit * Math.min(1, secondsToReset / windowSeconds);
    const delta = Math.round(remaining - expectedRemaining);
    const used = Math.max(0, limit - remaining);
    const elapsed = Math.max(0, windowSeconds - secondsToReset);
    const burnPerSecond = elapsed > 0 ? used / elapsed : 0;
    const secondsToEmpty = burnPerSecond > 0 ? remaining / burnPerSecond : null;
    const onSchedule = delta >= 0 || (secondsToEmpty !== null && secondsToEmpty >= secondsToReset);
    return {
      status: onSchedule ? 'on schedule' : 'deficit',
      detail: onSchedule
        ? 'Current pace lasts through reset.'
        : 'Current pace runs out before reset.',
      surplusLabel: (delta >= 0 ? 'Surplus +' : 'Deficit ') + formatNumber(delta),
      runwayLabel: secondsToEmpty === null ? 'Run-out not projected' : 'Run-out in ' + formatCompactDuration(secondsToEmpty)
    };
  }

function rateLimitWindowProgressPercent(resetAtMs: number | null, windowSeconds: number | null) {
    if (resetAtMs === null || windowSeconds === null || windowSeconds <= 0) {
      return null;
    }
    const secondsToReset = Math.max(0, (resetAtMs - Date.now()) / 1000);
    const elapsedSeconds = Math.max(0, Math.min(windowSeconds, windowSeconds - secondsToReset));
    return Math.max(0, Math.min(100, (elapsedSeconds / windowSeconds) * 100));
  }

function percentFromRateLimit(entry: Record<string, any>, remaining: number | null, limit: number | null) {
    const explicit = numberFromFields(entry, ['used_percent', 'usedPercent', 'usage_percent', 'usagePercent', 'percent_used', 'percentUsed']);
    if (explicit !== null) {
      return Math.max(0, Math.min(100, explicit));
    }
    if (remaining !== null && limit !== null && limit > 0) {
      return Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
    }
    return null;
  }

function rateLimitStatusClass(usedPercent: number | null) {
    if (usedPercent === null) {
      return '';
    }
    if (usedPercent >= 90) {
      return ' rate-limit-card-critical';
    }
    if (usedPercent >= 70) {
      return ' rate-limit-card-warning';
    }
    return '';
  }

function rateLimitStatusLabel(usedPercent: number | null) {
    if (usedPercent === null) {
      return 'reported';
    }
    if (usedPercent >= 90) {
      return 'near limit';
    }
    if (usedPercent >= 70) {
      return 'watch';
    }
    return 'healthy';
  }

function createRateLimitMetric(label: string, value: string) {
    const metric = document.createElement('div');
    metric.className = 'rate-limit-metric';
    const labelNode = document.createElement('span');
    labelNode.textContent = label;
    const valueNode = document.createElement('strong');
    valueNode.textContent = value;
    metric.append(labelNode, valueNode);
    return metric;
  }

function createRateLimitChip(label: string, value: any) {
    const chip = document.createElement('span');
    chip.className = 'rate-limit-chip';
    chip.textContent = label + ': ' + formatRateLimitDetailValue(value);
    return chip;
  }

function createRateLimitMarker(label: string, value: string, tone = '') {
    const marker = document.createElement('div');
    marker.className = 'rate-limit-marker' + (tone ? ' rate-limit-marker-' + tone : '');
    const labelNode = document.createElement('span');
    labelNode.textContent = label;
    const valueNode = document.createElement('strong');
    valueNode.textContent = value;
    marker.append(labelNode, valueNode);
    return marker;
  }

function createRateLimitSummary(entries: [string, Record<string, any>][]) {
    const summary = document.createElement('div');
    summary.className = 'rate-limit-summary';
    const label = document.createElement('span');
    label.textContent = 'Latest snapshot:';
    const uniqueSnapshots = Array.from(new Set(entries.map(function ([, entry]) {
      return valueFromFields(entry, ['updated_at', 'updatedAt', 'observed_at', 'observedAt', 'reported_at', 'reportedAt']);
    }).filter(function (value) {
      return value !== null;
    }).map(function (value) {
      return formatRateLimitDetailValue(value);
    })));
    const value = document.createElement('strong');
    value.textContent = uniqueSnapshots.length === 0
      ? 'current API state'
      : uniqueSnapshots.length === 1
        ? uniqueSnapshots[0]
        : uniqueSnapshots.length + ' reported times';
    summary.append(label, value);
    return summary;
  }

function rateLimitEntries(rateLimits: any) {
    if (!isRecord(rateLimits)) {
      return [];
    }
    const hasDirectLimitShape = ['remaining', 'limit', 'used_percent', 'usedPercent', 'reset_at', 'resetAt', 'resets_at', 'resetsAt'].some(function (key) {
      return key in rateLimits;
    });
    if (hasDirectLimitShape) {
      return [['Current', rateLimits]] as [string, Record<string, any>][];
    }
    return Object.entries(rateLimits).filter(function (entry): entry is [string, Record<string, any>] {
      return isRecord(entry[1]);
    });
  }

export function renderRateLimits(rateLimits: any) {
    const entries = rateLimitEntries(rateLimits);
    if (!entries.length) {
      const empty = document.createElement('article');
      empty.className = 'rate-limit-card rate-limit-empty';
      const title = document.createElement('div');
      title.className = 'rate-limit-title';
      const name = document.createElement('strong');
      name.className = 'rate-limit-name';
      name.textContent = 'No rate limits reported';
      const status = document.createElement('span');
      status.className = 'rate-limit-status';
      status.textContent = 'idle';
      title.append(name, status);
      const detail = document.createElement('p');
      detail.className = 'muted';
      detail.textContent = 'No coding-agent rate-limit snapshot has been reported for the current runtime.';
      empty.append(title, detail);
      elements.rateLimits.replaceChildren(empty);
      return;
    }

    const summary = createRateLimitSummary(entries);
    const cards = entries.map(function ([name, entry]) {
      const remaining = numberFromFields(entry, ['remaining', 'remaining_requests', 'remainingRequests']);
      const limit = numberFromFields(entry, ['limit', 'total', 'total_limit', 'totalLimit']);
      const usedPercent = percentFromRateLimit(entry, remaining, limit);
      const used = remaining !== null && limit !== null ? Math.max(0, limit - remaining) : null;
      const resetAtMs = resetTimestampFromRateLimit(entry);
      const windowSeconds = windowSecondsFromRateLimit(entry);
      const projection = describeRateLimitProjection(entry, remaining, limit, resetAtMs, windowSeconds);
      const windowProgressPercent = rateLimitWindowProgressPercent(resetAtMs, windowSeconds);
      const card = document.createElement('article');
      card.className = 'rate-limit-card' + rateLimitStatusClass(usedPercent);

      const title = document.createElement('div');
      title.className = 'rate-limit-title';
      const label = document.createElement('strong');
      label.className = 'rate-limit-name';
      label.textContent = humanizeRateLimitKey(name);
      const status = document.createElement('span');
      status.className = 'rate-limit-status';
      status.textContent = rateLimitStatusLabel(usedPercent);
      title.append(label, status);

      const meter = document.createElement('div');
      meter.className = 'rate-limit-meter';
      const fill = document.createElement('div');
      fill.className = 'rate-limit-meter-fill';
      fill.style.width = (usedPercent === null ? 0 : usedPercent).toFixed(0) + '%';
      meter.append(fill);
      if (windowProgressPercent !== null) {
        const timeMarker = document.createElement('div');
        timeMarker.className = 'rate-limit-time-marker';
        timeMarker.style.left = windowProgressPercent.toFixed(0) + '%';
        timeMarker.title = 'Window progress ' + windowProgressPercent.toFixed(0) + '%';
        meter.append(timeMarker);
      }

      const meterLegend = document.createElement('div');
      meterLegend.className = 'rate-limit-meter-legend';
      const usageLegend = document.createElement('span');
      usageLegend.textContent = usedPercent === null ? 'Capacity used n/a' : 'Capacity used ' + Math.round(usedPercent) + '%';
      const progressLegend = document.createElement('span');
      progressLegend.textContent = windowProgressPercent === null ? 'Window progress n/a' : 'Window progress ' + Math.round(windowProgressPercent) + '%';
      meterLegend.append(usageLegend, progressLegend);

      const metrics = document.createElement('div');
      metrics.className = 'rate-limit-metrics';
      metrics.append(
        createRateLimitMetric('Remaining', formatRateLimitValue(remaining)),
        createRateLimitMetric('Used', usedPercent === null ? formatRateLimitValue(used) : Math.round(usedPercent) + '%'),
        createRateLimitMetric('Limit', formatRateLimitValue(limit))
      );

      const details = document.createElement('div');
      details.className = 'rate-limit-detail-list';
      [
        ['Reset', resetAtMs],
        ['Resets in', resetAtMs === null ? null : formatCompactDuration((resetAtMs - Date.now()) / 1000)],
        ['Window', windowSeconds === null ? null : formatCompactDuration(windowSeconds)],
        ['Policy', entry.policy ?? entry.type ?? entry.scope]
      ].filter(function ([, value]) {
        return value !== undefined && value !== null && value !== '';
      }).forEach(function ([detailLabel, value]) {
        details.append(createRateLimitChip(String(detailLabel), value));
      });

      const forecast = document.createElement('div');
      forecast.className = 'rate-limit-forecast';
      forecast.append(
        createRateLimitMarker('Schedule', projection.status, projection.status === 'deficit' ? 'deficit' : 'positive'),
        createRateLimitMarker('Balance', projection.surplusLabel, projection.surplusLabel.startsWith('Deficit') ? 'deficit' : 'positive'),
        createRateLimitMarker('Projection', projection.runwayLabel, projection.detail.includes('runs out') ? 'deficit' : '')
      );

      const caption = document.createElement('p');
      caption.className = 'rate-limit-caption';
      caption.textContent = projection.detail;

      card.append(title, meter, meterLegend, metrics);
      if (details.children.length) {
        card.append(details);
      }
      card.append(forecast, caption);
      return card;
    });
    elements.rateLimits.replaceChildren(summary, ...cards);
  }

export function createMetricCard(label: any, value: any) {
    const card = document.createElement('article');
    card.className = 'kpi-card';
    const title = document.createElement('h3');
    title.textContent = label;
    const number = document.createElement('p');
    number.textContent = value;
    card.append(title, number);
    return card;
  }

export function computeDisplayRuntimeSeconds(payload: any) {
    if (!payload || !payload.codex_totals) {
      return 0;
    }
    const base = Number(payload.codex_totals.seconds_running) || 0;
    const generatedAtMs = Date.parse(payload.generated_at || '');
    if (!Number.isFinite(generatedAtMs)) {
      return base;
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - generatedAtMs) / 1000));
    return base + elapsed;
  }

export function renderOverview(payload: any) {
    const splitUnavailable = payload.codex_totals && payload.codex_totals.token_split_status === 'aggregate_only';
    const quiescence = payload.quiescence || { safe_to_shutdown: true, blocker_counts: {}, blockers: [] };
    const drainBlockerCount = Object.values(quiescence.blocker_counts || {}).reduce(function (total: number, value: any) {
      return total + (Number(value) || 0);
    }, 0);
    const warningCount = Array.isArray(quiescence.warnings)
      ? quiescence.warnings.reduce(function (total: number, warning: any) {
          return total + (Number(warning && warning.count) || 0);
        }, 0)
      : 0;
    const providerTotals = Array.isArray(payload.provider_totals) ? payload.provider_totals : [];
    const providerSum = function (field: string) {
      const values = providerTotals
        .map(function (entry: any) { return entry[field]; })
        .filter(function (value: any) { return typeof value === 'number'; });
      return values.length ? values.reduce(function (total: number, value: number) { return total + value; }, 0) : null;
    };
    const providerCost = providerSum('estimated_cost_usd');
    const providerFinalInvocations = providerSum('final_invocation_count') ?? 0;
    const providerPartialInvocations = providerSum('partial_invocation_count') ?? 0;
    const providerUnobservedInvocations = providerSum('unobserved_invocation_count') ?? 0;
    const providerMissingInvocations = providerSum('missing_invocation_count') ?? 0;
    const providerCoverageGaps =
      providerPartialInvocations + providerUnobservedInvocations + providerMissingInvocations;
    elements.kpiGrid.replaceChildren(
      createMetricCard('Safe To Shutdown', quiescence.safe_to_shutdown ? 'Yes' : 'No'),
      createMetricCard('Shutdown Blockers', formatNumber(drainBlockerCount)),
      createMetricCard('Restart Warnings', formatNumber(warningCount)),
      createMetricCard('Running', formatNumber(payload.counts.running)),
      createMetricCard('Retrying', formatNumber(payload.counts.retrying)),
      createMetricCard('Blocked', formatNumber(payload.counts.blocked)),
      createMetricCard('Stopped', formatNumber(payload.counts.stopped || 0)),
      createMetricCard('Stalled Waiting', formatNumber(payload.counts.running_stalled_waiting_count || 0)),
      createMetricCard('Awaiting Input', formatNumber(payload.counts.running_awaiting_input_count || 0)),
      createMetricCard('Codex Enforcement Total', formatOverviewTokenValue(payload, 'total_tokens', splitUnavailable)),
      createMetricCard('Codex Enforcement Input', formatOverviewTokenValue(payload, 'input_tokens', splitUnavailable)),
      createMetricCard('Codex Enforcement Output', formatOverviewTokenValue(payload, 'output_tokens', splitUnavailable)),
      createMetricCard('Codex Cached Input', formatOverviewTokenValue(payload, 'cached_input_tokens', splitUnavailable)),
      createMetricCard('Codex Reasoning Output', formatOverviewTokenValue(payload, 'reasoning_output_tokens', splitUnavailable)),
      createMetricCard('Codex Max Context', formatOverviewTokenValue(payload, 'model_context_window', splitUnavailable)),
      createMetricCard('Provider Input', formatTokenDimension(providerSum('input_tokens'), 'Unavailable')),
      createMetricCard('Provider Output', formatTokenDimension(providerSum('output_tokens'), 'Unavailable')),
      createMetricCard('Provider Cache Read', formatTokenDimension(providerSum('cache_read_tokens'), 'Unavailable')),
      createMetricCard('Provider Cache Create', formatTokenDimension(providerSum('cache_creation_tokens'), 'Unavailable')),
      createMetricCard('Provider Turns', formatTokenDimension(providerSum('provider_turn_count'), 'Unavailable')),
      createMetricCard('Provider Estimated Cost', providerCost === null ? 'Unavailable' : '$' + Number(providerCost).toFixed(4)),
      createMetricCard('Provider Final Invocations', formatNumber(providerFinalInvocations)),
      createMetricCard('Provider Partial Invocations', formatNumber(providerPartialInvocations)),
      createMetricCard('Provider Unobserved Invocations', formatNumber(providerUnobservedInvocations)),
      createMetricCard('Provider Missing Invocations', formatNumber(providerMissingInvocations)),
      createMetricCard('Provider Coverage Gaps', formatNumber(providerCoverageGaps)),
      createMetricCard('Runtime Seconds', formatNumber(computeDisplayRuntimeSeconds(payload)))
    );

    const failed = payload.health.dispatch_validation === 'failed';
    elements.healthMessage.className = failed ? 'health health-failed' : 'health health-ok';
    const drainMode = payload.drain_mode || { active: false };
    const drainStatus = drainMode.active
      ? 'Drain Mode: active, ' + (quiescence.safe_to_shutdown ? 'restart safe' : 'restart blocked')
      : 'Drain Mode: inactive';
    elements.healthMessage.textContent = 'Dispatch validation: ' + payload.health.dispatch_validation + ' • ' + drainStatus;
    const blockerDetail =
      quiescence.blockers && quiescence.blockers.length
        ? quiescence.blockers.map(function (blocker: any) {
            return blocker.detail;
          }).join(' • ')
        : '';
    elements.lastError.textContent = [
      payload.health.last_error ? 'Last error: ' + payload.health.last_error : '',
      blockerDetail ? 'Shutdown blockers: ' + blockerDetail : ''
    ].filter(Boolean).join(' • ');
    renderRuntimeIdentityWarning(payload.runtime_identity || null);
    renderRuntimeUpdate(payload.runtime_update || null, payload);
    renderDrainModeWorkflow(payload);
    renderRetryStatusSummary(payload);

    const rateLimits = payload.rate_limits;
    renderRateLimits(rateLimits);
  }

function formatRuntimeUpdateLabel(value: any) {
    return String(value || 'unknown').replace(/_/g, ' ');
  }

function isActionableRuntimeUpdate(readiness: any) {
    return !!readiness && [
      'local_checkout_behind',
      'remote_update_available',
      'runtime_stale',
      'source_changed_build_not_updated'
    ].includes(readiness.state) && isGithubRuntimeUpdateEligible(readiness.github_eligibility) && !(readiness.refusal_reasons && readiness.refusal_reasons.length > 0);
  }

function isGithubRuntimeUpdateEligible(eligibility: any) {
    return !!eligibility && [
      'github_verified',
      'github_checks_absent_allowed',
      'github_trusted_raw_git'
    ].includes(eligibility.state);
  }

function updateRuntimeUpdateButtons(readiness: any, payload: any) {
    const quiescence = payload && payload.quiescence ? payload.quiescence : { safe_to_shutdown: false };
    const drainMode = payload && payload.drain_mode ? payload.drain_mode : { active: false };
    const restart = payload && payload.runtime_restart ? payload.runtime_restart : null;
    const restartPhase = restart && restart.phase;
    const actionable = isActionableRuntimeUpdate(readiness);
    const prepared = readiness && readiness.prepared === true;
    const applyReady = readiness && readiness.apply_ready === true;
    const prepareDisabled = !actionable || prepared;
    const applyDisabled = !actionable || !applyReady || !drainMode.active || !quiescence.safe_to_shutdown || restartPhase === 'restarting';
    [
      elements.runtimeUpdatePrepareButton,
      elements.runtimeUpdatePreparePanelButton
    ].filter(Boolean).forEach(function (button: any) {
      button.disabled = prepareDisabled;
    });
    [
      elements.runtimeUpdateApplyButton,
      elements.runtimeUpdateApplyPanelButton
    ].filter(Boolean).forEach(function (button: any) {
      button.disabled = applyDisabled;
    });
  }

function shortRuntimeUpdateSha(value: any) {
    const text = value ? String(value) : '';
    return text ? text.slice(0, 12) : 'unknown';
  }

function describeRuntimeUpdateState(readiness: any) {
    if (readiness && readiness.apply_ready === true) {
      return 'Prepared update ready';
    }
    if (readiness && readiness.prepared === true) {
      return 'Update prepared';
    }
    switch (readiness && readiness.state) {
      case 'local_checkout_behind':
      case 'remote_update_available':
        return 'Update ready to prepare';
      case 'runtime_stale':
        return 'Restart required';
      case 'source_changed_build_not_updated':
        return 'New build available';
      case 'build_current':
        return 'Running the current build';
      default:
        return readiness ? formatRuntimeUpdateLabel(readiness.state) : 'Runtime update unavailable';
    }
  }

function formatRuntimeUpdateCommitCount(value: any) {
    if (value === null || value === undefined) {
      return 'an unknown number of commits';
    }
    const count = Number(value);
    if (!Number.isFinite(count)) {
      return 'an unknown number of commits';
    }
    return count + ' ' + (count === 1 ? 'commit' : 'commits');
  }

function describeRuntimeUpdateAction(readiness: any, payload: any) {
    if (!readiness) {
      return 'The local runtime update detector is not configured.';
    }
    const drainMode = payload && payload.drain_mode ? payload.drain_mode : { active: false };
    const quiescence = payload && payload.quiescence ? payload.quiescence : { safe_to_shutdown: false };
    const restart = payload && payload.runtime_restart ? payload.runtime_restart : null;
    const restartCapability = restart && restart.capability ? restart.capability : null;
    const github = readiness.github_eligibility || {};
    const refusalReasons = Array.isArray(readiness.refusal_reasons) ? readiness.refusal_reasons : [];
    if (!readiness.attention_required) {
      return 'No operator action is needed. Symphony is already running from the expected checkout.';
    }
    if (!isGithubRuntimeUpdateEligible(github)) {
      return 'Wait for GitHub checks to finish before preparing this update.';
    }
    if (refusalReasons.length) {
      return 'Update is paused until this blocker clears: ' + refusalReasons.map(formatRuntimeUpdateLabel).join(', ') + '.';
    }
    if (readiness.state === 'runtime_stale') {
      return restartCapability && restartCapability.mode === 'supervisor_available'
        ? 'Restart Symphony from this panel once Drain Mode is quiet.'
        : 'Restart Symphony manually after Drain Mode is quiet.';
    }
    if (readiness.apply_ready === true) {
      if (!drainMode.active) {
        return 'Enter Drain Mode before applying the prepared update.';
      }
      if (!quiescence.safe_to_shutdown) {
        return 'Wait for active work to drain before applying the prepared update.';
      }
      return 'Apply the prepared update now. Symphony will keep restart guidance visible after the pull.';
    }
    if (readiness.prepared === true) {
      return 'Preparation is complete. Keep Drain Mode active until the system is quiet, then apply the update.';
    }
    return 'Prepare the update first. Symphony will enter Drain Mode and pin the candidate before anything is applied.';
  }

function describeRuntimeUpdateBanner(readiness: any, payload: any) {
    const local = readiness.local_checkout || {};
    const remote = readiness.fetched_remote || {};
    const counts = readiness.ahead_behind || {};
    const branch = local.branch || remote.base_ref || 'current branch';
    const behind = counts.behind === null || counts.behind === undefined ? 'unknown' : counts.behind;
    const target = shortRuntimeUpdateSha(remote.commit_sha);
    const restart = payload && payload.runtime_restart ? payload.runtime_restart : null;
    const restartCapability = restart && restart.capability ? restart.capability : null;
    const restartCopy = restartCapability && restartCapability.mode === 'supervisor_available'
      ? 'supervised restart available'
      : restartCapability
        ? 'manual restart may be required'
        : 'restart guidance pending';
    if (readiness.state === 'runtime_stale') {
      return 'The checkout has moved, but this dashboard is still running the older build. ' + restartCopy + '.';
    }
    return 'Remote ' + (remote.remote || 'origin') + '/' + (remote.base_ref || branch) + ' has ' + formatRuntimeUpdateCommitCount(behind) + ' ready for ' + branch + '. Target ' + target + '.';
  }

function describeGithubEligibility(eligibility: any) {
    if (!eligibility) {
      return 'GitHub checks: not reported';
    }
    const summary = eligibility.check_summary || {};
    const stateLabel = formatRuntimeUpdateLabel(eligibility.state || 'unknown');
    if (eligibility.state === 'github_verified') {
      return 'GitHub checks passed' + (Number.isFinite(summary.succeeded) ? ' (' + summary.succeeded + ' succeeded)' : '');
    }
    if (eligibility.state === 'github_checks_pending') {
      return 'GitHub checks are still running' + (Number.isFinite(summary.pending) ? ' (' + summary.pending + ' pending)' : '');
    }
    if (eligibility.state === 'github_checks_absent_allowed') {
      return 'No GitHub checks were reported; configuration allows the update to continue.';
    }
    if (eligibility.state === 'github_trusted_raw_git') {
      return 'GitHub checks are bypassed by trusted raw-git mode.';
    }
    return 'GitHub checks: ' + stateLabel;
  }

function runtimeUpdateFact(label: string, detail: string) {
    const item = document.createElement('div');
    item.className = 'runtime-update-fact';
    const title = document.createElement('strong');
    title.textContent = label;
    const value = document.createElement('span');
    value.textContent = detail;
    item.append(title, value);
    return item;
  }

function renderRuntimeUpdateFacts(readiness: any, payload: any) {
    if (!elements.runtimeUpdateDetails) {
      return;
    }
    if (!readiness) {
      elements.runtimeUpdateDetails.textContent = 'Runtime update details unavailable.';
      return;
    }
    const local = readiness.local_checkout || {};
    const remote = readiness.fetched_remote || {};
    const counts = readiness.ahead_behind || {};
    const fetch = readiness.last_fetch || {};
    const restart = payload && payload.runtime_restart ? payload.runtime_restart : null;
    const restartCapability = restart && restart.capability ? restart.capability : null;
    const facts = [
      runtimeUpdateFact('Current checkout', (local.branch || 'unknown branch') + ' @ ' + shortRuntimeUpdateSha(local.commit_sha)),
      runtimeUpdateFact('Available build', (remote.remote || 'origin') + '/' + (remote.base_ref || 'main') + ' @ ' + shortRuntimeUpdateSha(remote.commit_sha)),
      runtimeUpdateFact('Distance', (counts.behind === null || counts.behind === undefined ? 'unknown' : counts.behind) + ' behind, ' + (counts.ahead === null || counts.ahead === undefined ? 'unknown' : counts.ahead) + ' ahead'),
      runtimeUpdateFact('Checks', describeGithubEligibility(readiness.github_eligibility)),
      runtimeUpdateFact('Drain requirement', readiness.drain_required ? 'Drain Mode required before apply' : 'Drain Mode not required'),
      runtimeUpdateFact('Restart path', restartCapability ? formatRuntimeUpdateLabel(restartCapability.mode) : 'Restart guidance pending')
    ];
    if (fetch.result) {
      facts.push(runtimeUpdateFact('Last fetch', formatRuntimeUpdateLabel(fetch.result)));
    }
    if (readiness.prepared_update && readiness.prepared_update.candidate_sha) {
      facts.push(runtimeUpdateFact('Prepared candidate', shortRuntimeUpdateSha(readiness.prepared_update.candidate_sha)));
    }
    if (restart && restart.recommended_manual_recovery) {
      facts.push(runtimeUpdateFact('Manual recovery', restart.recommended_manual_recovery));
    }
    if (restart && restart.last_error && restart.last_error.message) {
      facts.push(runtimeUpdateFact('Last restart error', restart.last_error.message));
    }
    elements.runtimeUpdateDetails.replaceChildren(...facts);
  }

export function renderRuntimeUpdate(readiness: any, payload: any) {
    if (!elements.runtimeUpdatePanel || !elements.runtimeUpdateState || !elements.runtimeUpdateDetails) {
      return;
    }
    updateRuntimeUpdateButtons(readiness, payload);
    if (!readiness) {
      if (elements.runtimeUpdateBanner) {
        elements.runtimeUpdateBanner.classList.add('hidden');
      }
      elements.runtimeUpdateState.textContent = 'Runtime update readiness unavailable';
      elements.runtimeUpdateRecommendation.textContent = 'The local runtime update detector is not configured.';
      elements.runtimeUpdateDetails.textContent = 'Runtime update details unavailable.';
      return;
    }

    if (readiness.attention_required) {
      elements.runtimeUpdateBanner.classList.remove('hidden');
      elements.runtimeUpdateTitle.textContent =
        readiness.state === 'runtime_stale' ? 'Runtime restart required' : 'Runtime update available';
      elements.runtimeUpdateSummary.textContent = describeRuntimeUpdateBanner(readiness, payload);
    } else {
      elements.runtimeUpdateBanner.classList.add('hidden');
      elements.runtimeUpdateSummary.textContent = '';
    }

    elements.runtimeUpdateState.textContent = describeRuntimeUpdateState(readiness);
    elements.runtimeUpdateRecommendation.textContent = describeRuntimeUpdateAction(readiness, payload);
    renderRuntimeUpdateFacts(readiness, payload);
  }

export function renderDrainModeWorkflow(payload: any) {
    if (!elements.drainModeSummary || !elements.drainModeBoundary || !elements.drainBlockersList) {
      return;
    }
    const drainMode = payload.drain_mode || { active: false };
    const quiescence = payload.quiescence || { safe_to_shutdown: true, blocker_counts: {}, blockers: [] };
    const active = !!drainMode.active;
    const safeToShutdown = !!quiescence.safe_to_shutdown;
    const blockers = Array.isArray(quiescence.blockers) ? quiescence.blockers : [];
    const warnings = Array.isArray(quiescence.warnings) ? quiescence.warnings : [];
    const restartGuidance = quiescence.restart_guidance || null;
    const blockerDetails = blockers
      .map(function (blocker: any) {
        return blocker && blocker.detail ? blocker.detail : '';
      })
      .filter(Boolean);
    const totalBlockers = DRAIN_BLOCKER_ORDER.reduce(function (total, category) {
      return total + (Number(quiescence.blocker_counts && quiescence.blocker_counts[category]) || 0);
    }, 0);

    elements.drainModeSummary.textContent = active
      ? 'Drain Mode active' + (drainMode.reason ? ': ' + drainMode.reason : '')
      : 'Drain Mode inactive';
    elements.drainModeBoundary.className = safeToShutdown ? 'drain-boundary drain-boundary-safe' : 'drain-boundary drain-boundary-blocked';
    if (safeToShutdown) {
      if (restartGuidance && restartGuidance.recommended_action === 'restart_runtime_to_current_build') {
        elements.drainModeBoundary.textContent =
          'Shutdown/restart is safe: restart/update Symphony before dispatching pending normal work.';
      } else {
        elements.drainModeBoundary.textContent = active
          ? 'Shutdown/restart is safe: no true shutdown blockers are present.'
          : 'Restart safety is clear, but Drain Mode is not active.';
      }
    } else {
      elements.drainModeBoundary.textContent =
        'Restart is not safe yet: ' +
        (blockerDetails.length ? blockerDetails.join(' • ') : totalBlockers + ' quiescence blockers remain.');
    }

    const warning = payload.runtime_identity && payload.runtime_identity.health_warning;
    const metaParts = [];
    if (drainMode.entered_at) {
      metaParts.push('Entered ' + formatDate(drainMode.entered_at));
    }
    if (drainMode.updated_at) {
      metaParts.push('Updated ' + formatDate(drainMode.updated_at));
    }
    if (warning && warning.code === 'stale_runtime_build') {
      metaParts.push('Dispatch is unsafe because this runtime is stale; this is a restart warning, not an active worker count.');
    } else if (warning && warning.code === 'unknown_current_build_identity') {
      metaParts.push('Dispatch is unsafe because current build identity is unknown; this is a restart warning, not an active worker count.');
    } else {
      metaParts.push(active ? 'New dispatch is stopped while Drain Mode is active.' : 'Use Drain Mode before planned runtime restarts.');
    }
    elements.drainModeMeta.textContent = metaParts.join(' • ');

    const countByCategory = quiescence.blocker_counts || {};
    const detailByCategory = blockers.reduce(function (acc: Record<string, string>, blocker: any) {
      if (blocker && blocker.category && blocker.detail) {
        acc[blocker.category] = blocker.detail;
      }
      return acc;
    }, {});
    const blockerNodes = DRAIN_BLOCKER_ORDER.map(function (category) {
      const count = Number(countByCategory[category]) || 0;
      const item = document.createElement('div');
      item.className = 'drain-blocker-item ' + (count > 0 ? 'drain-blocker-active' : 'drain-blocker-clear');
      const label = document.createElement('strong');
      label.textContent = DRAIN_BLOCKER_LABELS[category] + ' ' + formatNumber(count);
      const detail = document.createElement('span');
      detail.textContent = count > 0 ? (detailByCategory[category] || 'Blocking safe restart') : 'Clear';
      item.append(label, detail);
      return item;
    });
    const warningNodes = warnings.map(function (warning: any) {
      const item = document.createElement('div');
      item.className = 'drain-blocker-item drain-blocker-warning';
      const label = document.createElement('strong');
      label.textContent = (DRAIN_WARNING_LABELS[warning.category] || String(warning.category || 'Warning')) + ' ' + formatNumber(Number(warning.count) || 0);
      const detail = document.createElement('span');
      detail.textContent = [
        warning.detail || 'Warning present',
        warning.recommended_action ? 'Action: ' + warning.recommended_action : ''
      ].filter(Boolean).join(' ');
      item.append(label, detail);
      return item;
    });
    const pendingWork = restartGuidance && Array.isArray(restartGuidance.pending_work)
      ? restartGuidance.pending_work
      : [];
    const pendingWorkNodes = pendingWork.map(function (entry: any) {
      const item = document.createElement('div');
      item.className = 'drain-blocker-item drain-blocker-pending-work';
      const label = document.createElement('strong');
      label.textContent = 'Pending work ' + formatNumber(Number(entry && entry.count) || 0);
      const detail = document.createElement('span');
      detail.textContent = formatPendingWorkDetail(entry);
      item.append(label, detail);
      return item;
    });
    const nodes = [...blockerNodes, ...warningNodes, ...pendingWorkNodes];
    elements.drainBlockersList.replaceChildren(...nodes);

    if (elements.drainEnterButton) {
      elements.drainEnterButton.disabled = active;
    }
    if (elements.drainExitButton) {
      elements.drainExitButton.disabled = !active || !safeToShutdown;
    }
    if (elements.drainWaitButton) {
      elements.drainWaitButton.disabled = !active || safeToShutdown;
    }
    if (elements.drainShutdownButton) {
      elements.drainShutdownButton.disabled = !active || !safeToShutdown;
    }
  }

export function renderRuntimeIdentityWarning(runtimeIdentity: any) {
    if (!elements.runtimeStaleBanner || !elements.runtimeStaleTitle || !elements.runtimeStaleSummary) {
      return;
    }
    const warning = runtimeIdentity && runtimeIdentity.health_warning;
    if (!warning) {
      elements.runtimeStaleBanner.classList.add('hidden');
      elements.runtimeStaleTitle.textContent = 'Runtime Build Warning';
      elements.runtimeStaleSummary.textContent = '';
      return;
    }
    elements.runtimeStaleBanner.classList.remove('hidden');
    elements.runtimeStaleTitle.textContent =
      warning.code === 'unknown_current_build_identity' ? 'Runtime build identity unknown' : 'Runtime build is stale';
    const running = runtimeIdentity.running_build || {};
    const current = runtimeIdentity.current_build || {};
    const processStarted = runtimeIdentity.process_started_at || runtimeIdentity.process_started_at_ms || null;
    const currentLabel = current.identity || current.commit_sha || 'unknown';
    elements.runtimeStaleSummary.textContent = [
      warning.message,
      'Running build ' + (running.identity || running.commit_sha || 'unknown'),
      currentLabel === 'unknown' ? 'Current build unknown' : 'Current build ' + currentLabel,
      'Process started ' + formatDate(processStarted),
      warning.recommended_action
    ].join(' • ');
  }

export function renderRetryStatusSummary(payload: any) {
    const entries =
      payload.retry_status && Array.isArray(payload.retry_status.entries)
        ? payload.retry_status.entries
        : Array.isArray(payload.retrying)
          ? payload.retrying.map(function (entry: any) {
              const cause = entry.retry_cause || {};
              return {
                issue_identifier: entry.issue_identifier,
                attempt: entry.attempt,
                due_at: entry.due_at,
                due_state: entry.due_state || 'pending',
                overdue_ms: entry.overdue_ms || null,
                retry_wait_ms: entry.retry_wait_ms || null,
                reason_code: cause.reason_code || entry.stop_reason_code || null,
                detail: cause.detail || entry.stop_reason_detail || entry.error || null,
                operator_detail: cause.operator_detail || null,
                headline: cause.headline || (entry.operator_explainer_hint && entry.operator_explainer_hint.headline) || 'Run is waiting to retry',
                expected_transition: cause.expected_transition || null,
                last_phase: cause.last_phase || entry.last_phase || null
              };
            })
          : [];
    if (!entries.length) {
      elements.retryStatusSummary.classList.add('hidden');
      elements.retryStatusSummary.replaceChildren();
      return;
    }

    const header = document.createElement('div');
    header.className = 'retry-status-header';
    const overdueCount = entries.filter(function (entry: any) {
      return entry.due_state === 'overdue';
    }).length;
    header.textContent =
      overdueCount > 0
        ? overdueCount + ' overdue ' + (overdueCount === 1 ? 'retry needs' : 'retries need') + ' attention'
        : entries.length + ' retry' + (entries.length === 1 ? '' : 'ies') + ' scheduled';

    const list = document.createElement('div');
    list.className = 'retry-status-list';
    entries.slice(0, 4).forEach(function (entry: any) {
      const item = document.createElement('div');
      item.className = 'retry-status-item ' + (entry.due_state === 'overdue' ? 'overdue' : 'pending');

      const title = document.createElement('div');
      title.className = 'retry-status-title';
      const issue = document.createElement('strong');
      issue.textContent = entry.issue_identifier || 'unknown issue';
      const statePill = document.createElement('span');
      statePill.className = 'status-pill ' + (entry.due_state === 'overdue' ? 'failed' : 'pending');
      statePill.textContent =
        entry.due_state === 'overdue'
          ? 'Overdue ' + formatElapsedMs(entry.overdue_ms || 0)
          : 'Retry due ' + formatDate(entry.due_at);
      title.append(issue, statePill);

      const reason = document.createElement('div');
      reason.className = 'retry-status-reason';
      reason.textContent =
        (entry.reason_code || 'unknown_reason') +
        ' - ' +
        (entry.operator_detail || entry.detail || entry.headline || 'No retry detail available');

      const meta = document.createElement('div');
      meta.className = 'muted';
      const parts = [];
      if (entry.last_phase) {
        parts.push('Last phase: ' + entry.last_phase);
      }
      if (entry.detail && entry.detail !== entry.operator_detail) {
        parts.push(entry.detail);
      }
      if (entry.expected_transition) {
        parts.push(entry.expected_transition);
      }
      meta.textContent = parts.join(' • ');

      item.append(title, reason, meta);
      list.append(item);
    });

    elements.retryStatusSummary.classList.remove('hidden');
    elements.retryStatusSummary.replaceChildren(header, list);
  }

export function renderActionRequiredBanner(payload: any) {
    const blockedEntries = Array.isArray(payload && payload.blocked) ? payload.blocked : [];
    const grouped: Record<string, number> = blockedEntries.reduce(function (acc: Record<string, number>, entry: any) {
      if (!isActionRequiredCode(entry.stop_reason_code)) {
        return acc;
      }
      acc[entry.stop_reason_code] = (acc[entry.stop_reason_code] || 0) + 1;
      return acc;
    }, {});
    const groupedEntries = Object.entries(grouped);
    if (!groupedEntries.length) {
      elements.actionRequiredBanner.classList.add('hidden');
      elements.actionRequiredSummary.textContent = '';
      elements.actionRequiredGroups.replaceChildren();
      return;
    }

    const total = groupedEntries.reduce(function (sum: any, entry: any) {
      const count = entry[1];
      return sum + count;
    }, 0);
    elements.actionRequiredBanner.classList.remove('hidden');
    elements.actionRequiredSummary.textContent = total + ' blocked run' + (total === 1 ? '' : 's') + ' need operator action.';

    const groupNodes = groupedEntries.map(function (entry: any) {
      const code = entry[0];
      const count = entry[1];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost-button reason-chip';
      button.textContent = getActionRequiredLabel(code) + ' (' + count + ')';
      button.title = 'Filter blocked rows for ' + getActionRequiredLabel(code);
      button.addEventListener('click', function () {
        state.filter.status = 'blocked';
        state.filter.blockedReason = code;
        elements.statusFilter.value = 'blocked';
        if (state.payload) {
          renderRunning(state.payload);
          renderRetry(state.payload);
          renderBlocked(state.payload);
        }
      });
      return button;
    });
    elements.actionRequiredGroups.replaceChildren(...groupNodes);
  }

export function renderApiDegradedBanner(payload: any) {
    const historyWarnings = payload && payload.quiescence && Array.isArray(payload.quiescence.warnings)
      ? payload.quiescence.warnings.filter(function (warning: any) {
          return warning && warning.category === 'persistence_history_degraded';
        })
      : [];
    if (!payload || (!payload.api_degraded_mode && historyWarnings.length === 0)) {
      elements.apiDegradedBanner.classList.add('hidden');
      elements.apiDegradedSummary.textContent = '';
      return;
    }
    elements.apiDegradedTitle.textContent = payload.api_degraded_mode
      ? (historyWarnings.length > 0 ? 'API and Audit History Degraded' : 'API Degraded')
      : 'Audit History Degraded';
    const routes = Array.isArray(payload.api_degraded_routes) ? payload.api_degraded_routes.join(', ') : 'n/a';
    elements.apiDegradedBanner.classList.remove('hidden');
    const messages = [];
    if (payload.api_degraded_mode) {
      messages.push((payload.api_degraded_reason_code || 'unknown') + ' • fallback routes: ' + routes);
    }
    historyWarnings.forEach(function (warning: any) {
      messages.push('History degraded: ' + (warning.reason_code || warning.detail || 'unknown') +
        (warning.observed_at ? ' • observed ' + warning.observed_at : ''));
    });
    elements.apiDegradedSummary.textContent = messages.join(' • ');
  }

export function describeTransition(transition: any) {
    switch (transition) {
      case 'completion_gate_blocked':
        return { label: 'Completion Gate Blocked', result: 'failure', detail: 'No progress signal detected in redispatch window.' };
      case 'circuit_breaker_opened':
        return { label: 'Circuit Breaker Opened', result: 'failure', detail: 'Respawn threshold reached; operator intervention required.' };
      case 'resume_accepted':
        return { label: 'Resume Accepted', result: 'success', detail: 'Resume request accepted and redispatch restarted.' };
      case 'resume_rejected':
        return { label: 'Resume Rejected', result: 'failure', detail: 'Resume request rejected; resolve blocking condition first.' };
      case 'cancel_accepted':
        return { label: 'Cancel Accepted', result: 'success', detail: 'Issue returned to backlog.' };
      case 'cancel_rejected':
        return { label: 'Cancel Rejected', result: 'failure', detail: 'Cancel request rejected; tracker state unchanged.' };
      default:
        return null;
    }
  }

export function deriveOperatorTransitionRows(issueId: any, payload: any) {
    const rows: any[] = [];
    const seen = new Set();
    function addRow(at: any, transition: any, detail: any) {
      const key = transition + ':' + String(at || 'n/a') + ':' + String(detail || '');
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const descriptor = describeTransition(transition);
      if (!descriptor) {
        return;
      }
      rows.push({
        at: at || 'n/a',
        issue_identifier: issueId,
        label: descriptor.label,
        result: descriptor.result,
        detail: detail && detail.trim ? (detail.trim() ? detail : descriptor.detail) : descriptor.detail
      });
    }

    const timeline = Array.isArray(payload.phase_timeline) ? payload.phase_timeline : [];
    for (const marker of timeline) {
      const normalized = String(marker && marker.detail ? marker.detail : '').trim().toLowerCase();
      const transition = OPERATOR_TRANSITION_RULES.detailMap[normalized];
      if (transition) {
        addRow(marker.at, transition, marker.detail || null);
      }
    }
    const events = Array.isArray(payload.recent_events) ? payload.recent_events : [];
    for (const entry of events) {
      const transitionByEvent = OPERATOR_TRANSITION_RULES.eventMap[String(entry && entry.event ? entry.event : '')];
      if (transitionByEvent) {
        addRow(entry.at, transitionByEvent, entry.message || null);
      }
      const normalizedMessage = String(entry && entry.message ? entry.message : '').trim().toLowerCase();
      const transitionByMessage = OPERATOR_TRANSITION_RULES.detailMap[normalizedMessage];
      if (transitionByMessage) {
        addRow(entry.at, transitionByMessage, entry.message || null);
      }
    }
    if (payload.blocked && (payload.blocked.stop_reason_code === '${REASON_CODES.operatorNoProgressRedispatchBlocked}' || payload.blocked.stop_reason_code === '${REASON_CODES.awaitingHumanReviewScopeIncomplete}')) {
      addRow('n/a', 'completion_gate_blocked', payload.blocked.stop_reason_detail || null);
    }
    return rows.sort(function (a: any, b: any) {
      const atA = Date.parse(a.at);
      const atB = Date.parse(b.at);
      if (Number.isFinite(atA) && Number.isFinite(atB)) {
        return atA - atB;
      }
      if (Number.isFinite(atA)) {
        return -1;
      }
      if (Number.isFinite(atB)) {
        return 1;
      }
      return a.label.localeCompare(b.label);
    });
  }
