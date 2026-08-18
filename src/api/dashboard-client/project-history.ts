import { elements } from './dom';
import { state } from './state';
import { fetchJson } from './connection';
import { formatDate, formatNumber } from './formatting';
import { createActionButton, createStateBadge } from './issue-detail';

export function factLabel(value: any) {
    return String(value || 'unknown').replace(/_/g, ' ');
  }

export function factClass(status: any) {
    switch (status) {
      case 'present':
        return 'mini-badge mini-badge-good';
      case 'lifecycle_pending':
      case 'optional_unavailable':
      case 'missing':
        return 'mini-badge mini-badge-missing';
      case 'redacted':
      case 'truncated':
        return 'mini-badge mini-badge-warning';
      case 'degraded':
      case 'unavailable':
      default:
        return 'mini-badge mini-badge-bad';
    }
  }

export function createFactBadge(fact: any) {
    const badge = document.createElement('span');
    badge.className = factClass(fact && fact.status);
    badge.textContent = factLabel(fact && fact.status) + ': ' + factLabel(fact && fact.fact);
    if (fact && (fact.reason_code || fact.detail)) {
      badge.title = [fact.reason_code, fact.detail].filter(Boolean).join(' | ');
    }
    return badge;
  }

export function createFactBadges(facts: any) {
    if (!Array.isArray(facts)) {
      return [];
    }
    const badgesByLabel = new Map();
    for (const fact of facts) {
      const badge = createFactBadge(fact);
      const label = badge.textContent || '';
      const existing = badgesByLabel.get(label);
      if (!existing) {
        badgesByLabel.set(label, badge);
        continue;
      }
      if (badge.title && existing.title !== badge.title) {
        existing.title = [existing.title, badge.title].filter(Boolean).join(' | ');
      }
    }
    return Array.from(badgesByLabel.values());
  }

export function createProjectHistoryEmptyRow(message: any) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 9;
    cell.className = 'muted';
    cell.textContent = message;
    row.append(cell);
    return row;
  }

export function projectKeyFromHistoryPayload(historyPayload: any) {
    const runs = historyPayload && Array.isArray(historyPayload.runs) ? historyPayload.runs : [];
    for (const run of runs) {
      if (run && run.identity && run.identity.project && run.identity.project.key) {
        return run.identity.project.key;
      }
      if (run && run.identity_projection && run.identity_projection.project_key) {
        return run.identity_projection.project_key;
      }
    }
    return '';
  }

export function summarizeProjectHistoryReferences(row: any) {
    const summary = row && row.summary ? row.summary : {};
    return [
      'evidence ' + formatNumber(summary.evidence_reference_count || 0),
      'tracker ' + formatNumber(summary.tracker_snapshot_count || 0),
      'PR/ref ' + formatNumber(summary.ticket_reference_count || 0),
      'operator ' + formatNumber(summary.operator_action_count || 0)
    ].join(' • ');
  }

export function summarizeProjectHistoryMetrics(row: any) {
    const summary = row && row.summary ? row.summary : {};
    return [
      'attempts ' + formatNumber(summary.attempt_count || 0),
      'phases ' + formatNumber(summary.phase_count || 0),
      'threads ' + formatNumber(summary.thread_count || 0),
      'turns ' + formatNumber(summary.turn_count || 0),
      'tokens ' + (summary.total_tokens === null || summary.total_tokens === undefined ? 'n/a' : formatNumber(summary.total_tokens))
    ].join(' • ');
  }

export function summarizeProjectHistoryHealth(health: any) {
    if (!health || typeof health !== 'object') {
      return 'Health: unavailable';
    }
    const storage = health.storage || {};
    const schema = health.schema || {};
    const counts = health.counts || {};
    const retention = health.retention || {};
    const prune = retention.last_prune || {};
    const writes = health.writes || {};
    const projections = health.projections || {};
    const appServerLite = health.app_server_lite || {};
    const policyParts = [];
    if (appServerLite.redacted_event_count || appServerLite.truncated_event_count || appServerLite.summary_only_event_count) {
      policyParts.push(
        'payload policy redacted ' +
          formatNumber(appServerLite.redacted_event_count || 0) +
          ' / truncated ' +
          formatNumber(appServerLite.truncated_event_count || 0) +
          ' / summary-only ' +
          formatNumber(appServerLite.summary_only_event_count || 0)
      );
    }
    if (appServerLite.unavailable_event_count) {
      const reasons = Array.isArray(appServerLite.unavailable_reasons)
        ? appServerLite.unavailable_reasons
            .map(function (reason: any) {
              return (reason.reason_code || 'unknown') + ' ' + formatNumber(reason.count || 0) + ' ' + (reason.classification || 'unknown');
            })
            .join(', ')
        : 'reason unknown';
      policyParts.push('payload unavailable ' + formatNumber(appServerLite.unavailable_event_count || 0) + ' (' + reasons + ')');
    }
    const diagnostics = Array.isArray(health.diagnostics) ? health.diagnostics : [];
    const lifecyclePendingCount = diagnostics.filter(function (fact: any) {
      return fact && fact.status === 'lifecycle_pending';
    }).length;
    const optionalUnavailableCount = diagnostics.filter(function (fact: any) {
      return fact && fact.status === 'optional_unavailable';
    }).length;
    const degradedFactCount = diagnostics.filter(function (fact: any) {
      return fact && (fact.status === 'missing' || fact.status === 'degraded' || fact.status === 'unavailable');
    }).length;
    if (lifecyclePendingCount || optionalUnavailableCount || degradedFactCount) {
      policyParts.push(
        'facts pending ' +
          formatNumber(lifecyclePendingCount) +
          ' / optional unavailable ' +
          formatNumber(optionalUnavailableCount) +
          ' / degraded ' +
          formatNumber(degradedFactCount)
      );
    }
    return [
      'Health: ' + (health.status || 'unknown'),
      'enabled ' + (health.enabled ? 'yes' : 'no'),
      'storage ' + (storage.target || storage.type || 'n/a'),
      'schema ' + (schema.status || 'unknown') + ' / integrity ' + (schema.integrity_ok ? 'ok' : 'degraded'),
      'runs ' + formatNumber(counts.runs || 0),
      'tickets ' + (counts.tickets === null || counts.tickets === undefined ? 'n/a' : formatNumber(counts.tickets)),
      'retention ' + (retention.retention_days === null || retention.retention_days === undefined ? 'n/a' : formatNumber(retention.retention_days) + 'd'),
      'prune ' + (prune.status || 'unknown'),
      'writes ' + (writes.status || 'unknown'),
      'projection ' + (projections.status || 'unknown'),
      'app-server-lite ' + (appServerLite.status || 'unknown')
    ]
      .concat(policyParts)
      .join(' • ');
  }

export function renderProjectHistory() {
    const projectKey = state.projectHistory.projectKey || '';
    elements.projectHistoryProjectKey.value = projectKey;
    elements.projectHistoryLoad.disabled = !!state.projectHistory.loading;

    if (state.projectHistory.loading) {
      elements.projectHistoryStatus.textContent = 'Loading bounded ticket history for project ' + projectKey + '.';
      elements.projectHistoryRows.replaceChildren(createProjectHistoryEmptyRow('Loading project history...'));
      return;
    }

    if (state.projectHistory.error) {
      elements.projectHistoryStatus.textContent =
        'Project history unavailable: ' + state.projectHistory.error + ' • ' + summarizeProjectHistoryHealth(state.projectHistory.healthPayload);
      const healthFacts =
        state.projectHistory.healthPayload && Array.isArray(state.projectHistory.healthPayload.diagnostics)
          ? state.projectHistory.healthPayload.diagnostics
          : [];
      elements.projectHistoryFacts.replaceChildren(...createFactBadges(healthFacts));
      elements.projectHistoryRows.replaceChildren(createProjectHistoryEmptyRow('Project history unavailable.'));
      elements.projectHistoryDetail.classList.add('hidden');
      elements.projectHistoryDetail.replaceChildren();
      return;
    }

    const payload = state.projectHistory.listPayload;
    if (!payload) {
      elements.projectHistoryStatus.textContent = projectKey
        ? 'Project history is ready to load for project ' + projectKey + '.'
        : 'No project key discovered from bounded run history yet.';
      elements.projectHistoryFacts.replaceChildren();
      elements.projectHistoryRows.replaceChildren(createProjectHistoryEmptyRow('Project history uses bounded ticket rows and loads detail on demand.'));
      elements.projectHistoryDetail.classList.add('hidden');
      elements.projectHistoryDetail.replaceChildren();
      return;
    }

    const tickets = Array.isArray(payload.tickets) ? payload.tickets : [];
    const page = payload.page || {};
    elements.projectHistoryStatus.textContent =
      'Showing ' +
      formatNumber(tickets.length) +
      ' of ' +
      (page.total === null || page.total === undefined ? 'unknown' : formatNumber(page.total)) +
      ' ticket rows' +
      (page.has_more ? ' (bounded page; more rows available).' : '.') +
      ' • ' +
      summarizeProjectHistoryHealth(payload.health || state.projectHistory.healthPayload);
    elements.projectHistoryFacts.replaceChildren(...createFactBadges(payload.facts));

    if (!tickets.length) {
      elements.projectHistoryRows.replaceChildren(createProjectHistoryEmptyRow('No project ticket history available for this project.'));
      return;
    }

    const rows = tickets.map((entry: any) => {
      const row = document.createElement('tr');
      row.dataset.ticketKey = entry.ticket_identity && entry.ticket_identity.key ? entry.ticket_identity.key : '';
      const ticketCell = document.createElement('td');
      const ticketTitle = document.createElement('strong');
      ticketTitle.textContent = (entry.ticket_identity && entry.ticket_identity.human_issue_identifier) || row.dataset.ticketKey || 'unknown';
      const ticketMeta = document.createElement('div');
      ticketMeta.className = 'muted';
      ticketMeta.textContent = row.dataset.ticketKey || 'ticket key unavailable';
      ticketCell.append(ticketTitle, ticketMeta);

      const stateCell = document.createElement('td');
      stateCell.append(createStateBadge(entry.state || 'unknown'));
      const statusMeta = document.createElement('div');
      statusMeta.className = 'muted';
      statusMeta.textContent = entry.current_status || entry.last_known_status || 'unknown';
      stateCell.append(statusMeta);

      const attemptCell = document.createElement('td');
      const latestAttempt = entry.latest_attempt || {};
      attemptCell.textContent = latestAttempt.attempt_number === null || latestAttempt.attempt_number === undefined
        ? 'No attempt recorded'
        : 'Attempt ' + latestAttempt.attempt_number + ' • ' + (latestAttempt.status || 'unknown');
      const attemptMeta = document.createElement('div');
      attemptMeta.className = 'muted';
      attemptMeta.textContent = formatDate(latestAttempt.started_at) + (latestAttempt.ended_at ? ' - ' + formatDate(latestAttempt.ended_at) : '');
      attemptCell.append(attemptMeta);

      const outcomeCell = document.createElement('td');
      outcomeCell.textContent = latestAttempt.outcome || 'No terminal outcome';
      const outcomeMeta = document.createElement('div');
      outcomeMeta.className = 'muted';
      outcomeMeta.textContent = latestAttempt.outcome_reason_code || 'outcome fact missing or unavailable';
      outcomeCell.append(outcomeMeta);

      const refsCell = document.createElement('td');
      refsCell.textContent = summarizeProjectHistoryReferences(entry);

      const summaryCell = document.createElement('td');
      summaryCell.textContent = summarizeProjectHistoryMetrics(entry);

      const factsCell = document.createElement('td');
      factsCell.className = 'project-history-facts-cell';
      const factBadges = createFactBadges(entry.facts);
      factsCell.replaceChildren(...factBadges);

      const observedCell = document.createElement('td');
      observedCell.textContent = formatDate(entry.latest_observed_at);

      const actionsCell = document.createElement('td');
      const detailButton = createActionButton(
        state.projectHistory.detailLoadingTicketKey === row.dataset.ticketKey ? 'Loading...' : 'View Timeline',
        'ghost-button',
        function () {
          void loadProjectHistoryDetail(row.dataset.ticketKey || '');
        }
      );
      detailButton.disabled = !row.dataset.ticketKey || state.projectHistory.detailLoadingTicketKey === row.dataset.ticketKey;
      actionsCell.append(detailButton);

      row.append(ticketCell, stateCell, attemptCell, outcomeCell, refsCell, summaryCell, factsCell, observedCell, actionsCell);
      return row;
    });
    elements.projectHistoryRows.replaceChildren(...rows);
    renderProjectHistoryDetail();
  }

export function createProjectHistorySection(title: any, items: any, renderItem: any) {
    const section = document.createElement('section');
    section.className = 'thread-detail-section';
    const heading = document.createElement('h3');
    heading.textContent = title;
    section.append(heading);
    if (!Array.isArray(items) || !items.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No ' + title.toLowerCase() + ' facts recorded.';
      section.append(empty);
      return section;
    }
    const list = document.createElement('ul');
    list.className = 'project-history-timeline-list';
    for (const item of items) {
      const node = document.createElement('li');
      node.textContent = renderItem(item);
      list.append(node);
    }
    section.append(list);
    return section;
  }

export function renderProjectHistoryDetail() {
    const detail = state.projectHistory.detailPayload;
    elements.projectHistoryDetail.replaceChildren();
    if (state.projectHistory.detailError) {
      elements.projectHistoryDetail.classList.remove('hidden');
      const error = document.createElement('p');
      error.className = 'status-error';
      error.textContent = 'Ticket timeline unavailable: ' + state.projectHistory.detailError;
      elements.projectHistoryDetail.append(error);
      return;
    }
    if (!detail) {
      elements.projectHistoryDetail.classList.add('hidden');
      return;
    }

    elements.projectHistoryDetail.classList.remove('hidden');
    const heading = document.createElement('h3');
    heading.textContent = 'Ticket Timeline: ' + ((detail.ticket_identity && detail.ticket_identity.human_issue_identifier) || detail.ticket_identity.key);
    const facts = document.createElement('div');
    facts.className = 'inline-badges';
    facts.replaceChildren(...createFactBadges(detail.facts));

    const grid = document.createElement('div');
    grid.className = 'project-history-detail-grid';
    const drainAuditEvents = Array.isArray(state.projectHistory.listPayload && state.projectHistory.listPayload.drain_audit_events)
      ? state.projectHistory.listPayload.drain_audit_events
      : [];
    grid.append(
      createProjectHistorySection('Drain Audit Events', drainAuditEvents, function (item: any) {
        return item.event_type + ' • ' + item.result_code + ' • ' + (item.actor || item.source || 'unknown') + ' • ' + formatDate(item.occurred_at);
      }),
      createProjectHistorySection('Attempts', detail.attempts, function (item: any) {
        return 'Attempt ' + item.attempt_number + ' • ' + item.status + ' • ' + formatDate(item.started_at) + ' - ' + formatDate(item.ended_at);
      }),
      createProjectHistorySection('Phases', detail.phases, function (item: any) {
        return item.phase + ' • ' + item.status + ' • ' + formatDate(item.started_at) + ' - ' + formatDate(item.ended_at) + (item.reason_code ? ' • ' + item.reason_code : '');
      }),
      createProjectHistorySection('State Transitions', detail.state_transitions, function (item: any) {
        return item.from_status + ' -> ' + item.to_status + ' • ' + formatDate(item.transitioned_at) + (item.reason_code ? ' • ' + item.reason_code : '');
      }),
      createProjectHistorySection('Thread References', detail.thread_references, function (item: any) {
        return item.thread_id + ' • attempt ' + item.attempt_id + ' • ' + item.status + ' • ' + formatDate(item.started_at);
      }),
      createProjectHistorySection('Turn References', detail.turn_references, function (item: any) {
        return item.turn_id + ' • thread ' + item.thread_id + ' • turn ' + item.turn_index + ' • ' + item.status;
      }),
      createProjectHistorySection('Outcomes', detail.outcomes, function (item: any) {
        return item.outcome + ' • ' + (item.reason_code || 'no reason') + ' • ' + formatDate(item.recorded_at);
      }),
      createProjectHistorySection('Blockers', detail.blockers, function (item: any) {
        return item.status + ' • ' + item.blocker_type + ' • ' + (item.reason_code || 'no reason') + ' • ' + (item.reason_detail || 'no detail');
      }),
      createProjectHistorySection('Evidence', detail.evidence_references, function (item: any) {
        return item.evidence_kind + ' • ' + (item.title || item.uri || 'untitled') + ' • ' + formatDate(item.recorded_at);
      }),
      createProjectHistorySection('Tracker And PR Facts', [].concat(detail.tracker_facts || [], detail.pr_and_reference_facts || [], detail.operator_facts || []), function (item: any) {
        return (item.tracker_status || item.reference_kind || item.action || 'fact') + ' • ' + (item.label || item.result || item.state || item.tracker_status || 'n/a') + ' • ' + formatDate(item.last_observed_at || item.observed_at || item.requested_at);
      }),
      createProjectHistorySection('Ticket Drain Audit Events', detail.drain_audit_events, function (item: any) {
        const blockers = Array.isArray(item.blocker_summaries) && item.blocker_summaries.length
          ? ' • blockers ' + item.blocker_summaries.map(function (blocker: any) {
              return blocker.category + ':' + blocker.count;
            }).join(', ')
          : '';
        return item.event_type + ' • ' + item.result + ' • ' + item.result_code + ' • ' + formatDate(item.occurred_at) + blockers;
      }),
      createProjectHistorySection('App Server Lite Excerpts', detail.app_server_lite_summaries, function (item: any) {
        return item.source_event_name + ' • ' + item.detail_status + ' • ' + (item.summary || item.redacted_excerpt || item.unavailable_reason_code || 'no excerpt');
      }),
      createProjectHistorySection('Token And Model Facts', detail.token_model_summaries, function (item: any) {
        const runtime = item.runtime_provider || 'codex-app-server';
        const turns = item.provider_turn_count === null || item.provider_turn_count === undefined ? 'n/a' : formatNumber(item.provider_turn_count);
        const cost = item.estimated_cost_usd === null || item.estimated_cost_usd === undefined ? 'n/a' : '$' + Number(item.estimated_cost_usd).toFixed(4);
        return runtime + ' • ' + (item.effective_model || item.requested_model || 'model unknown') + ' • tokens ' + (item.total_tokens === null || item.total_tokens === undefined ? 'n/a' : formatNumber(item.total_tokens)) + ' • turns ' + turns + ' • estimated ' + cost + ' • ' + (item.telemetry_confidence || 'confidence unknown');
      }),
      createProjectHistorySection('Blocked Input Events', detail.blocked_input_events, function (item: any) {
        return (item.request_id || 'request') + ' • ' + (item.status || 'status unknown') + ' • ' + (item.reason_code || 'no reason');
      })
    );
    elements.projectHistoryDetail.append(heading, facts, grid);
  }

export async function loadProjectHistory(projectKey?: any) {
    const requestedProjectKey = String(projectKey || elements.projectHistoryProjectKey.value || '').trim();
    if (!requestedProjectKey || state.projectHistory.loading) {
      renderProjectHistory();
      return;
    }
    state.projectHistory.projectKey = requestedProjectKey;
    state.projectHistory.loading = true;
    state.projectHistory.error = null;
    renderProjectHistory();
    try {
      state.projectHistory.listPayload = await fetchJson('/api/v1/projects/' + encodeURIComponent(requestedProjectKey) + '/history/tickets?limit=50');
      state.projectHistory.healthPayload = state.projectHistory.listPayload.health || null;
      state.projectHistory.detailPayload = null;
      state.projectHistory.detailError = null;
    } catch (error) {
      state.projectHistory.listPayload = null;
      state.projectHistory.error = String(error);
      try {
        state.projectHistory.healthPayload = await fetchJson('/api/v1/projects/' + encodeURIComponent(requestedProjectKey) + '/history/health');
      } catch {
        state.projectHistory.healthPayload = null;
      }
    } finally {
      state.projectHistory.loading = false;
      renderProjectHistory();
    }
  }

export async function loadProjectHistoryDetail(ticketKey: any) {
    const projectKey = state.projectHistory.projectKey;
    if (!projectKey || !ticketKey) {
      return;
    }
    state.projectHistory.detailLoadingTicketKey = ticketKey;
    state.projectHistory.detailError = null;
    renderProjectHistory();
    try {
      state.projectHistory.detailPayload = await fetchJson(
        '/api/v1/projects/' + encodeURIComponent(projectKey) + '/history/tickets/' + encodeURIComponent(ticketKey)
      );
    } catch (error) {
      state.projectHistory.detailPayload = null;
      state.projectHistory.detailError = String(error);
    } finally {
      state.projectHistory.detailLoadingTicketKey = null;
      renderProjectHistory();
    }
  }
