import { elements } from './dom';
import { state } from './state';
import { formatBudgetSummary, formatDate, formatElapsedMs, formatNumber, formatProviderUsage, getActionRequiredLabel, getProgressSignalLabel, getTokenConfidenceLabel, getTurnControlLabel } from './formatting';
import { fetchJson, loadStateViaPoll, scheduleStateSave, setRefreshStatus } from './connection';
import { renderRunning } from './issues';
import { deriveOperatorTransitionRows } from './overview';

let issueDetailRequestSequence = 0;

export function createStateBadge(stateValue: any) {
    const badge = document.createElement('span');
    badge.className = 'state-badge';
    const normalized = String(stateValue || '').toLowerCase();
    if (normalized.includes('progress') || normalized.includes('running')) {
      badge.classList.add('state-active');
    } else if (normalized.includes('todo') || normalized.includes('backlog')) {
      badge.classList.add('state-idle');
    } else if (normalized.includes('done') || normalized.includes('closed')) {
      badge.classList.add('state-terminal');
    } else {
      badge.classList.add('state-neutral');
    }
    badge.textContent = stateValue || 'unknown';
    return badge;
  }

export function createProvisioningBadge(label: any, ok: any) {
    const badge = document.createElement('span');
    badge.className = 'mini-badge ' + (ok ? 'mini-badge-good' : 'mini-badge-bad');
    badge.textContent = label + ': ' + (ok ? 'yes' : 'no');
    return badge;
  }

export function normalizeActionability(value: any) {
    const actionability = String(value || 'none');
    return actionability === 'required' || actionability === 'recommended' ? actionability : 'none';
  }

export function createOperatorHintBadge(hint: any) {
    if (!hint) {
      return null;
    }
    const actionability = normalizeActionability(hint.actionability);
    const badge = document.createElement('span');
    badge.className = 'operator-hint actionability-' + actionability;
    badge.textContent = String(hint.headline || hint.classification || 'Runtime diagnostics');
    badge.title = 'Actionability: ' + actionability + ' • Classification: ' + String(hint.classification || 'unknown');
    return badge;
  }

export function renderIssueExplainer(explainer: any) {
    if (!explainer) {
      elements.issueExplainerCard.classList.add('hidden');
      return;
    }
    const actionability = normalizeActionability(explainer.actionability);
    elements.issueExplainerCard.className = 'operator-explainer actionability-' + actionability;
    elements.issueExplainerActionability.className = 'status-pill actionability-' + actionability;
    elements.issueExplainerActionability.textContent = actionability;
    elements.issueExplainerHeadline.textContent = explainer.headline || 'Runtime diagnostics unavailable';
    elements.issueExplainerClassification.textContent = explainer.classification || 'unknown';
    elements.issueExplainerReason.textContent =
      (explainer.reason_code || 'n/a') + (explainer.reason_detail ? ' • ' + explainer.reason_detail : '');
    elements.issueExplainerAction.textContent =
      Array.isArray(explainer.recommended_actions) && explainer.recommended_actions.length
        ? explainer.recommended_actions.join('; ')
        : 'No operator action required';
    elements.issueExplainerTransition.textContent = explainer.expected_transition || 'No automatic transition expected';
    elements.issueExplainerVersion.textContent = explainer.version || 'unknown';
    elements.issueExplainerDetail.textContent = explainer.detail || '';
  }

export function appendDefinitionValue(list: any, label: any, value: any) {
    const wrapper = document.createElement('div');
    const term = document.createElement('dt');
    const definition = document.createElement('dd');
    term.textContent = label;
    definition.textContent = value === null || value === undefined || value === '' ? 'n/a' : String(value);
    wrapper.append(term, definition);
    list.append(wrapper);
  }

export function renderThreadBlockerCard(blocker: any) {
    elements.threadBlockerCard.replaceChildren();
    if (!blocker) {
      appendDefinitionValue(elements.threadBlockerCard, 'classification', 'n/a');
      appendDefinitionValue(elements.threadBlockerCard, 'reason_code', 'n/a');
      appendDefinitionValue(elements.threadBlockerCard, 'reason_detail', 'n/a');
      appendDefinitionValue(elements.threadBlockerCard, 'time_since_progress', 'n/a');
      appendDefinitionValue(elements.threadBlockerCard, 'recommended_actions', 'No blocker actions reported.');
      appendDefinitionValue(elements.threadBlockerCard, 'expected_auto_transition', 'n/a');
      return;
    }
    appendDefinitionValue(elements.threadBlockerCard, 'classification', blocker.classification);
    appendDefinitionValue(elements.threadBlockerCard, 'reason_code', blocker.reason_code);
    appendDefinitionValue(elements.threadBlockerCard, 'reason_detail', blocker.reason_detail);
    appendDefinitionValue(elements.threadBlockerCard, 'time_since_progress', blocker.time_since_progress);
    if (blocker.missing_tool_output_recovery) {
      const recovery = blocker.missing_tool_output_recovery;
      appendDefinitionValue(elements.threadBlockerCard, 'recovery_headline', recovery.headline);
      appendDefinitionValue(elements.threadBlockerCard, 'recovery_state', recovery.status);
      appendDefinitionValue(elements.threadBlockerCard, 'recovery_next_action', recovery.next_action);
      appendDefinitionValue(elements.threadBlockerCard, 'original_tool', recovery.original_tool_name);
      appendDefinitionValue(elements.threadBlockerCard, 'original_call_id', recovery.original_call_id);
      appendDefinitionValue(elements.threadBlockerCard, 'evidence_source', recovery.evidence_source);
      appendDefinitionValue(elements.threadBlockerCard, 'elapsed_wait_ms', recovery.elapsed_wait_ms);
      appendDefinitionValue(
        elements.threadBlockerCard,
        'active_ownership',
        recovery.active_ownership
          ? [
              'issue ' + (recovery.active_ownership.issue_identifier || recovery.active_ownership.issue_id || 'n/a'),
              'thread ' + (recovery.active_ownership.thread_id || 'n/a'),
              'turn ' + (recovery.active_ownership.turn_id || 'n/a'),
              'session ' + (recovery.active_ownership.session_id || 'n/a'),
              'app_server_owned ' + String(Boolean(recovery.active_ownership.app_server_owned))
            ].join(' | ')
          : 'n/a'
      );
      appendDefinitionValue(
        elements.threadBlockerCard,
        'recovery_lineage',
        [
          'interrupt ' + ((recovery.interrupt_cancel_result && recovery.interrupt_cancel_result.status) || 'n/a'),
          'replacement_thread ' + ((recovery.replacement_turn && recovery.replacement_turn.thread_id) || 'n/a'),
          'replacement_turn ' + ((recovery.replacement_turn && recovery.replacement_turn.turn_id) || 'n/a'),
          'prompt ' + ((recovery.guarded_prompt_dispatch && recovery.guarded_prompt_dispatch.status) || 'n/a'),
          'outcome ' + ((recovery.final_outcome && recovery.final_outcome.result) || 'n/a')
        ].join(' | ')
      );
    }
    appendDefinitionValue(
      elements.threadBlockerCard,
      'recommended_actions',
      Array.isArray(blocker.recommended_actions) ? blocker.recommended_actions.join('; ') : 'n/a'
    );
    appendDefinitionValue(elements.threadBlockerCard, 'expected_auto_transition', blocker.expected_auto_transition);
  }

export function spanLabel(span: any, kind: any) {
    if (kind === 'phase') {
      return span.phase || 'phase';
    }
    if (kind === 'tool') {
      return span.tool_name || 'tool';
    }
    return span.reason_code || span.status || 'wait';
  }

export function renderTimelineLane(title: any, spans: any, kind: any) {
    const lane = document.createElement('section');
    lane.className = 'timeline-lane timeline-lane-' + kind;
    const heading = document.createElement('h4');
    heading.textContent = title;
    lane.append(heading);
    const safeSpans = Array.isArray(spans) ? spans : [];
    if (!safeSpans.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No ' + title.toLowerCase() + ' spans.';
      lane.append(empty);
      return lane;
    }
    const list = document.createElement('ul');
    for (const span of safeSpans) {
      const item = document.createElement('li');
      const label = document.createElement('strong');
      const meta = document.createElement('span');
      label.textContent = spanLabel(span, kind);
      meta.textContent =
        ' | started ' +
        formatDate(span.started_at_ms) +
        ' | ended ' +
        (span.ended_at_ms === null || span.ended_at_ms === undefined ? 'open' : formatDate(span.ended_at_ms)) +
        ' | duration ' +
        (span.duration_ms === null || span.duration_ms === undefined ? 'open' : String(span.duration_ms)) +
        ' | status ' +
        (span.status || 'n/a') +
        ' | reason ' +
        (span.reason_code || 'n/a') +
        ' | ' +
        (span.reason_detail || 'n/a');
      item.append(label, meta);
      list.append(item);
    }
    lane.append(list);
    return lane;
  }

export function renderThreadDiagnostics(diagnostics: any) {
    if (!diagnostics) {
      elements.threadDetail.classList.add('hidden');
      elements.threadRawEvents.textContent = 'Detailed diagnostics are not loaded.';
      return;
    }
    elements.threadDetail.classList.remove('hidden');
    elements.threadTimelineLanes.replaceChildren(
      renderTimelineLane('Phase', diagnostics.phase_spans, 'phase'),
      renderTimelineLane('Tool', diagnostics.tool_spans, 'tool'),
      renderTimelineLane('Wait', diagnostics.wait_spans, 'wait')
    );
    renderThreadBlockerCard(diagnostics.current_blocker || null);
    const warnings = Array.isArray(diagnostics.capability_warnings) ? diagnostics.capability_warnings : [];
    if (!warnings.length) {
      elements.threadCapabilityWarnings.className = 'capability-warnings muted';
      elements.threadCapabilityWarnings.textContent = 'No capability warnings.';
    } else {
      elements.threadCapabilityWarnings.className = 'capability-warnings';
      const list = document.createElement('ul');
      for (const warning of warnings) {
        const item = document.createElement('li');
        item.textContent =
          (warning.reason_code || 'capability_warning') +
          ' | source ' +
          (warning.source_environment || 'n/a') +
          ' | tool ' +
          (warning.attempted_tool_name || 'n/a') +
          ' | call ' +
          (warning.call_id || 'n/a') +
          ' | thread ' +
          (warning.thread_id || 'n/a') +
          ' | turn ' +
          (warning.turn_id || 'n/a') +
          ' | ' +
          (warning.unsupported_capability_message || 'unsupported capability') +
          ' | recovery ' +
          (warning.recommended_recovery_action || 'n/a');
        list.append(item);
      }
      elements.threadCapabilityWarnings.replaceChildren(list);
    }
    const events = Array.isArray(diagnostics.timeline) ? diagnostics.timeline : [];
    elements.threadRawEvents.textContent = events.length
      ? events
          .map(function (event: any) {
            return (
              formatDate(event.at_ms) +
              ' | ' +
              event.event +
              ' | thread ' +
              (event.thread_id || 'n/a') +
              ' | turn ' +
              (event.turn_id || 'n/a') +
              ' | session ' +
              (event.session_id || 'n/a') +
              ' | reason ' +
              (event.reason_code || 'n/a') +
              ' | ' +
              (event.reason_detail || 'n/a')
            );
          })
          .join('\\n')
      : 'No raw event stream entries.';
  }

export function getDiagnosticSummary(entry: any) {
    return entry && entry.transcript_tool_call_diagnostic_summary ? entry.transcript_tool_call_diagnostic_summary : null;
  }

export function formatDiagnosticSummary(summary: any) {
    if (!summary) {
      return 'Summary diagnostics: unavailable';
    }
    const parts = [];
    parts.push(summary.detailed_diagnostics_available ? 'detail available' : 'summary only');
    parts.push(formatNumber(summary.total_count || 0) + ' transcript records');
    if (summary.active_missing_tool_output && summary.active_missing_tool_output.active) {
      parts.push('missing output ' + (summary.active_missing_tool_output.tool_name || summary.active_missing_tool_output.call_id || 'active'));
    }
    if (summary.recovery && summary.recovery.active) {
      parts.push('recovery ' + (summary.recovery.status || 'active'));
    }
    if (summary.newest_observed_at) {
      parts.push('newest ' + formatDate(summary.newest_observed_at));
    }
    return 'Summary diagnostics: ' + parts.join(' | ');
  }

export function formatConversationSummary(conversation: any) {
    if (!conversation || !conversation.metadata) {
      return 'Conversation: no evidence loaded';
    }
    const latest = conversation.latest || {};
    const counts = conversation.metadata.role_counts || {};
    const countParts = ['system', 'user', 'assistant', 'tool', 'runtime']
      .filter(function (role) {
        return counts[role] > 0;
      })
      .map(function (role) {
        return role + ' ' + counts[role];
      });
    const latestText = latest.summary ? 'latest ' + (latest.role || 'message') + ': ' + latest.summary : 'latest unavailable';
    return (
      'Conversation: ' +
      formatNumber(conversation.metadata.included_count || 0) +
      ' shown' +
      (conversation.metadata.truncated ? ' of ' + formatNumber(conversation.metadata.total_available_count || 0) : '') +
      (countParts.length ? ' | ' + countParts.join(', ') : '') +
      ' | ' +
      latestText
    );
  }

export function renderConversation(conversation: any) {
    const roleFilter = (state.filter && state.filter.conversationRole) || 'all';
    const density = (state.filter && state.filter.conversationDensity) || 'comfortable';
    elements.conversationSummary.textContent = formatConversationSummary(conversation);
    elements.conversationList.className = 'conversation-list conversation-density-' + density;
    const messages = Array.isArray(conversation && conversation.messages) ? conversation.messages : [];
    const visibleMessages = messages.filter(function (message: any) {
      return roleFilter === 'all' || message.role === roleFilter;
    });
    if (!visibleMessages.length) {
      const empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = messages.length ? 'No messages match this role filter.' : 'No conversation evidence is available yet.';
      elements.conversationList.replaceChildren(empty);
      return;
    }
    const nodes = visibleMessages.map(function (message: any) {
      const item = document.createElement('li');
      item.className = 'conversation-item conversation-role-' + (message.role || 'runtime');
      const meta = document.createElement('div');
      meta.className = 'conversation-meta';
      const role = document.createElement('span');
      role.className = 'conversation-role';
      role.textContent = message.role || 'runtime';
      const source = document.createElement('span');
      source.textContent =
        formatDate(message.at) +
        ' | ' +
        (message.source || 'unknown') +
        (message.event ? ' | ' + message.event : '') +
        (message.thread_id ? ' | thread ' + message.thread_id : '') +
        (message.tool_name ? ' | tool ' + message.tool_name : '');
      meta.append(role, source);
      const body = document.createElement('p');
      body.textContent = (message.content || 'n/a') + (message.truncated ? ' [truncated]' : '');
      item.append(meta, body);
      return item;
    });
    elements.conversationList.replaceChildren(...nodes);
  }

export function formatInputDecisionContext(detail: any) {
    if (!detail) {
      return null;
    }
    if (detail.includes('input_required_unanswerable')) {
      return 'Input handling: unanswerable schema (manual resume required)';
    }
    if (detail.includes('non_interactive_fallback')) {
      return 'Input handling: non-interactive fallback answer';
    }
    if (detail.includes('approval_option_permissive')) {
      return 'Input handling: permissive approval option selected';
    }
    if (detail.includes('approval_option_exact')) {
      return 'Input handling: exact approval option selected';
    }
    return null;
  }

export function createActionButton(text: any, className: any, onClick: any) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    button.addEventListener('click', function (event: any) {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

export async function copyText(value: any) {
    if (!value) {
      setRefreshStatus('No value to copy', true);
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const helper = document.createElement('textarea');
        helper.value = value;
        helper.setAttribute('readonly', 'readonly');
        helper.style.position = 'absolute';
        helper.style.left = '-9999px';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        document.body.removeChild(helper);
      }
      setRefreshStatus('Copied: ' + value, false);
    } catch (error) {
      setRefreshStatus('Copy failed: ' + String(error), true);
    }
  }

export async function loadIssue(identifier: any, options?: any) {
    const issueId = (identifier || '').trim();
    if (!issueId) {
      return;
    }
    const requestSequence = ++issueDetailRequestSequence;
    const loadOptions = options || {};
    if (loadOptions.openPanel !== false && !elements.issuePanel.open) {
      state.suppressIssuePanelToggleLoad = true;
      elements.issuePanel.open = true;
      setTimeout(function () {
        state.suppressIssuePanelToggleLoad = false;
      }, 0);
    }

    try {
      const payload = await fetchJson('/api/v1/' + encodeURIComponent(issueId));
      let diagnostics = null;
      let diagnosticsLoadFailed = false;
      try {
        diagnostics = await fetchJson('/api/v1/issues/' + encodeURIComponent(issueId) + '/diagnostics');
      } catch (_diagnosticsError) {
        diagnosticsLoadFailed = true;
        diagnostics = null;
      }
      if (requestSequence !== issueDetailRequestSequence) {
        return;
      }
      state.selectedIssue = issueId;
      elements.issueInput.value = issueId;
      const summaryParts = [];
      summaryParts.push('Status: ' + (payload.status || 'unknown'));
      summaryParts.push('Snapshot: ' + (payload.snapshot_freshness_state || 'unknown') + ' age ' + formatNumber(payload.snapshot_age_ms) + 'ms');
      if (payload.api_degraded_mode) {
        summaryParts.push('API degraded: ' + (payload.api_degraded_reason_code || 'unknown'));
      }
      if (payload.workspace && payload.workspace.path) {
        summaryParts.push('Workspace: ' + payload.workspace.path);
      }
      if (payload.retry && payload.retry.stop_reason_code) {
        summaryParts.push('Stop reason: ' + payload.retry.stop_reason_code);
      }
      if (payload.blocked && payload.blocked.stop_reason_code) {
        summaryParts.push('Blocked reason: ' + getActionRequiredLabel(payload.blocked.stop_reason_code));
      }
      if (payload.retry && payload.retry.previous_session_id) {
        summaryParts.push('Previous session: ' + payload.retry.previous_session_id);
      }
      if (payload.blocked && payload.blocked.previous_session_id) {
        summaryParts.push('Previous session: ' + payload.blocked.previous_session_id);
      }
      if (payload.running && payload.running.current_phase) {
        summaryParts.push('Current phase: ' + payload.running.current_phase);
      }
      if (payload.running && payload.running.turn_control_state) {
        summaryParts.push('Turn control: ' + getTurnControlLabel(payload.running.turn_control_state));
        summaryParts.push('Progress: ' + getProgressSignalLabel(payload.running.progress_signal_state));
      }
      if (payload.running && payload.running.token_telemetry_confidence) {
        summaryParts.push('Token quality: ' + getTokenConfidenceLabel(payload.running.token_telemetry_confidence));
      }
      if (payload.running && payload.running.agent_runtime) {
        summaryParts.push('Agent runtime: ' + payload.running.agent_runtime);
        summaryParts.push('Requested model: ' + (payload.running.requested_model || 'n/a'));
        summaryParts.push('Effective model: ' + (payload.running.effective_model || 'n/a'));
        summaryParts.push('Process PID: ' + (payload.running.worker_process_pid || 'n/a'));
        summaryParts.push('Session: ' + (payload.running.session_id || 'n/a'));
        summaryParts.push('Thread: ' + (payload.running.thread_id || 'n/a'));
        summaryParts.push('Turn: ' + (payload.running.turn_id || 'n/a'));
      }
      if (payload.running && payload.running.provider_usage) {
        summaryParts.push('Provider usage: ' + formatProviderUsage(payload.running.provider_usage));
        summaryParts.push('Provider telemetry updated: ' + (payload.running.provider_usage.updated_at || 'n/a'));
        if (payload.running.provider_usage.supervised_session_coverage !== 'complete') {
          summaryParts.push('Provider coverage warning: ' + (payload.running.provider_usage.supervised_session_coverage || 'missing'));
        }
      }
      if (payload.running && payload.running.not_blocked_explainer_text) {
        summaryParts.push('Why not blocked: ' + payload.running.not_blocked_explainer_text);
      }
      if (payload.blocked && payload.blocked.turn_control_state) {
        summaryParts.push('Turn control: ' + getTurnControlLabel(payload.blocked.turn_control_state));
      }
      if ((payload.retry && payload.retry.last_phase) || (payload.blocked && payload.blocked.last_phase)) {
        summaryParts.push('Last phase before stop: ' + ((payload.retry && payload.retry.last_phase) || (payload.blocked && payload.blocked.last_phase)));
      }
      if (payload.operator_explainer) {
        summaryParts.push('Actionability: ' + payload.operator_explainer.actionability);
      }
      const runningOrRetry = payload.running || payload.retry || payload.blocked;
      if (runningOrRetry && runningOrRetry.provisioner_type) {
        summaryParts.push('Provisioner: ' + runningOrRetry.provisioner_type);
      }
      if (runningOrRetry && runningOrRetry.branch_name) {
        summaryParts.push('Branch: ' + runningOrRetry.branch_name);
      }
      if (runningOrRetry && runningOrRetry.workspace_git_status) {
        summaryParts.push('Workspace git: ' + runningOrRetry.workspace_git_status);
      }
      if (runningOrRetry && typeof runningOrRetry.workspace_provisioned === 'boolean') {
        summaryParts.push('Provisioned: ' + (runningOrRetry.workspace_provisioned ? 'yes' : 'no'));
      }
      if (runningOrRetry && typeof runningOrRetry.workspace_is_git_worktree === 'boolean') {
        summaryParts.push('Git worktree: ' + (runningOrRetry.workspace_is_git_worktree ? 'yes' : 'no'));
      }
      if (runningOrRetry) {
        summaryParts.push(formatBudgetSummary(runningOrRetry));
        summaryParts.push(formatDiagnosticSummary(getDiagnosticSummary(runningOrRetry)));
      }
      summaryParts.push(
        diagnostics
          ? 'Detailed diagnostics: loaded'
          : diagnosticsLoadFailed
            ? 'Detailed diagnostics: unavailable'
            : 'Detailed diagnostics: not loaded'
      );
      if (state.runtimeResolution && state.runtimeResolution.workspace_root) {
        summaryParts.push('Runtime workspace root: ' + state.runtimeResolution.workspace_root);
      }
      elements.issueSummary.textContent = summaryParts.join(' • ');
      renderConversation(payload.conversation || null);
      renderIssueExplainer(payload.operator_explainer || null);
      renderThreadDiagnostics(diagnostics);
      const timeline = Array.isArray(payload.phase_timeline) ? payload.phase_timeline : [];
      const sessionConsole = payload.blocked && Array.isArray(payload.blocked.session_console) ? payload.blocked.session_console : [];
      const timelineText = timeline.length
        ? timeline.map(function (marker: any) {
            return formatDate(marker.at) + ' | ' + marker.phase + ' | attempt ' + marker.attempt + ' | ' + (marker.detail || 'n/a') + ' | thread ' + (marker.thread_id || 'n/a') + ' | session ' + (marker.session_id || 'n/a');
          }).join('\\n')
        : 'No phase markers yet.';
      const operatorTimelineRows = deriveOperatorTransitionRows(issueId, payload);
      const operatorActions = Array.isArray(payload.operator_actions) ? payload.operator_actions : [];
      const availableActions =
        payload.blocked && Array.isArray(payload.blocked.available_actions) ? payload.blocked.available_actions : [];
      const availableActionText = availableActions.length
        ? availableActions.map(function (entry: any) {
            return (entry.label || entry.id || 'action') + ' | ' + (entry.method || 'POST') + ' ' + (entry.endpoint || 'n/a');
          }).join('\\n')
        : 'No backend-advertised issue actions.';
      const operatorActionText = operatorActions.length
        ? operatorActions.map(function (entry: any) {
            return formatDate(entry.requested_at_ms) + ' | ' + (entry.actor || 'operator') + ' | ' + entry.action + ' | ' + entry.result + ' | ' + (entry.result_code || 'n/a') + ' | ' + (entry.reason_note || 'no reason note') + ' | ' + (entry.message || 'n/a');
          }).join('\\n')
        : 'No operator action outcomes.';
      const operatorTimelineText = operatorTimelineRows.length
        ? operatorTimelineRows
            .map(function (entry: any) {
              return (
                formatDate(entry.at) +
                ' | ' +
                entry.label +
                ' | issue ' +
                entry.issue_identifier +
                ' | ' +
                entry.result +
                ' | ' +
                entry.detail
              );
            })
            .join('\\n')
        : 'No operator transition entries.';
      const sessionConsoleText = sessionConsole.length
        ? sessionConsole.map(function (event: any) {
            return formatDate(event.at) + ' | ' + event.event + ' | ' + (event.message || 'n/a');
          }).join('\\n')
        : 'No session console entries.';
      const budgetText = runningOrRetry ? formatBudgetSummary(runningOrRetry) : 'Budget: not configured';
      elements.issueOutput.textContent =
        'Operator Transition Timeline\\n' +
        operatorTimelineText +
        '\\n\\nOperator Action Outcomes\\n' +
        operatorActionText +
        '\\n\\nAvailable Actions\\n' +
        availableActionText +
        '\\n\\nExecution Timeline\\n' +
        timelineText +
        '\\n\\nSession Console\\n' +
        sessionConsoleText +
        '\\n\\nBudget\\n' +
        budgetText +
        '\\n\\nIssue JSON (canonical UTC ISO values preserved)\\n' +
        JSON.stringify(payload, null, 2);
      if (state.payload) {
        renderRunning(state.payload);
      }
      scheduleStateSave();
    } catch (error) {
      if (requestSequence !== issueDetailRequestSequence) {
        return;
      }
      elements.issueSummary.textContent = 'Issue detail degraded: fallback mode active.';
      renderConversation(null);
      renderIssueExplainer(null);
      renderThreadDiagnostics(null);
      elements.issueOutput.textContent =
        'Issue load failed: ' +
        String(error) +
        '\\n\\nFallback message\\nIssue detail payload is unavailable. Use only backend-advertised actions from the state snapshot when available.';
    }
  }
