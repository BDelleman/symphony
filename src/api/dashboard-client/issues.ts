import { DASHBOARD_CONFIG } from './config';
import { elements } from './dom';
import { state } from './state';
import { setRefreshStatus } from './connection';
import { createActionButton, copyText, formatDiagnosticSummary, formatInputDecisionContext, getDiagnosticSummary, createOperatorHintBadge, createProvisioningBadge, createStateBadge, loadIssue } from './issue-detail';
import { cancelBlockedIssue, resumeBlockedIssue, runOperatorAction, submitBlockedInput } from './operator-actions';
import { createBlockedRootCauseBlock, createBudgetBlock, formatDate, formatDurationFromIso, formatDurationFromMs, formatElapsedMs, formatNumber, formatProviderUsage, formatTokenBreakdown, getActionRequiredLabel, getProgressSignalLabel, getRetryStateLabel, getTokenConfidenceLabel, getTurnControlLabel } from './formatting';

export function rowMatchesFilter(entry: any) {
    if (state.filter.status === 'running' && entry.state.toLowerCase().includes('retry')) {
      return false;
    }
    if (state.filter.status === 'retrying' && !entry.state.toLowerCase().includes('retry')) {
      return false;
    }
    if (state.filter.status === 'blocked') {
      return false;
    }
    if (!state.filter.query) {
      return true;
    }
    return entry.issue_identifier.toLowerCase().includes(state.filter.query.toLowerCase());
  }

export function renderRunning(payload: any) {
    const rows = payload.running.filter(rowMatchesFilter);
    if (!rows.length) {
      const emptyRow = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 14;
      cell.className = 'muted';
      cell.textContent = 'No running issues match current filters.';
      emptyRow.appendChild(cell);
      elements.runningRows.replaceChildren(emptyRow);
      return;
    }

    const nodes = rows.map((entry: any) => {
      const row = document.createElement('tr');
      row.setAttribute('data-issue', entry.issue_identifier);
      if (state.selectedIssue === entry.issue_identifier) {
        row.classList.add('selected-row');
      }

      const issueCell = document.createElement('td');
      const issueLink = document.createElement('a');
      issueLink.href = '#thread-detail-' + encodeURIComponent(entry.issue_identifier);
      issueLink.textContent = entry.issue_identifier;
      issueLink.addEventListener('click', function (event: any) {
        event.preventDefault();
        event.stopPropagation();
        elements.issueInput.value = entry.issue_identifier;
        void loadIssue(entry.issue_identifier);
      });
      issueCell.append(issueLink);

      const stateCell = document.createElement('td');
      stateCell.appendChild(createStateBadge(entry.state));
      const dispatchState = document.createElement('div');
      dispatchState.className = 'muted';
      dispatchState.textContent = 'Dispatched from ' + (entry.dispatch_state || entry.state);
      stateCell.append(dispatchState);
      const stateFlags = document.createElement('div');
      stateFlags.className = 'inline-badges';
      const turnBadge = document.createElement('span');
      turnBadge.className = 'status-pill ' + (entry.turn_control_state === 'operator_turn' ? 'failed' : 'pending');
      turnBadge.textContent = getTurnControlLabel(entry.turn_control_state);
      stateFlags.append(turnBadge);
      const progressBadge = document.createElement('span');
      progressBadge.className = 'status-pill ' + (entry.progress_signal_state === 'stalled_waiting' ? 'failed' : 'pending');
      progressBadge.textContent = getProgressSignalLabel(entry.progress_signal_state);
      stateFlags.append(progressBadge);
      if (entry.awaiting_input) {
        const awaitingBadge = document.createElement('span');
        awaitingBadge.className = 'status-pill pending';
        awaitingBadge.textContent = 'Awaiting Input';
        stateFlags.append(awaitingBadge);
      }
      if (entry.stalled_waiting && entry.progress_signal_state !== 'stalled_waiting') {
        const stalledBadge = document.createElement('span');
        stalledBadge.className = 'status-pill failed';
        stalledBadge.textContent = 'Stalled Waiting';
        stateFlags.append(stalledBadge);
      }
      const runningHintBadge = createOperatorHintBadge(entry.operator_explainer_hint);
      if (runningHintBadge && entry.operator_explainer_hint.actionability !== 'none') {
        stateFlags.append(runningHintBadge);
      }
      if (entry.quarantined_event_count > 0) {
        const quarantineBadge = document.createElement('span');
        quarantineBadge.className = 'status-pill failed';
        quarantineBadge.textContent = 'Quarantined events ' + formatNumber(entry.quarantined_event_count);
        stateFlags.append(quarantineBadge);
      }
      if (
        entry.model_reroute ||
        (entry.provider_usage && Array.isArray(entry.provider_usage.effective_models) &&
          entry.provider_usage.effective_models.some((model: string) => model !== entry.requested_model))
      ) {
        const rerouteBadge = document.createElement('span');
        rerouteBadge.className = 'status-pill pending';
        rerouteBadge.textContent = 'Model rerouted';
        stateFlags.append(rerouteBadge);
      }
      if (entry.provider_usage && entry.provider_usage.nested_session_detected) {
        const nestedBadge = document.createElement('span');
        nestedBadge.className = 'status-pill failed';
        nestedBadge.textContent = 'Nested provider detected';
        stateFlags.append(nestedBadge);
      }
      if (entry.provider_usage && (entry.provider_usage.permission_denial_count > 0 || entry.provider_usage.unknown_event_count > 0)) {
        const protocolBadge = document.createElement('span');
        protocolBadge.className = 'status-pill pending';
        protocolBadge.textContent =
          'Provider warnings ' +
          formatNumber((entry.provider_usage.permission_denial_count || 0) + (entry.provider_usage.unknown_event_count || 0));
        stateFlags.append(protocolBadge);
      }
      if (entry.provider_usage && (entry.provider_usage.status === 'partial' || entry.provider_usage.status === 'unobserved')) {
        const coverageBadge = document.createElement('span');
        coverageBadge.className = 'status-pill pending';
        coverageBadge.textContent = entry.provider_usage.status === 'partial' ? 'Live provider usage lower bound' : 'Provider usage missing';
        stateFlags.append(coverageBadge);
      }
      if (entry.provider_usage && entry.provider_usage.supervised_session_coverage !== 'complete') {
        const coverageBadge = document.createElement('span');
        coverageBadge.className = 'status-pill pending';
        coverageBadge.textContent = 'Session coverage ' + (entry.provider_usage.supervised_session_coverage || 'missing');
        stateFlags.append(coverageBadge);
      }
      if (stateFlags.children.length > 0) {
        stateCell.append(stateFlags);
      }

      const sessionCell = document.createElement('td');
      const sessionValue = document.createElement('div');
      sessionValue.textContent = entry.session_id || 'n/a';
      const sessionMeta = document.createElement('div');
      sessionMeta.className = 'muted';
      const sessionMetaParts = [];
      sessionMetaParts.push('Runtime ' + (entry.agent_runtime || 'codex-app-server'));
      if (entry.requested_model) sessionMetaParts.push('Requested ' + entry.requested_model);
      if (entry.effective_model) sessionMetaParts.push('Effective ' + entry.effective_model);
      if (entry.worker_process_pid) sessionMetaParts.push('PID ' + entry.worker_process_pid);
      if (entry.thread_id) sessionMetaParts.push('Thread ' + entry.thread_id);
      if (entry.turn_id) sessionMetaParts.push('Turn ' + entry.turn_id);
      if (entry.worker_host) {
        sessionMetaParts.push('Host ' + entry.worker_host);
      }
      if (entry.workspace_path) {
        sessionMetaParts.push(entry.workspace_path);
      }
      if (entry.provisioner_type) {
        sessionMetaParts.push('Provisioner ' + entry.provisioner_type);
      }
      if (entry.branch_name) {
        sessionMetaParts.push('Branch ' + entry.branch_name);
      }
      if (entry.workspace_git_status) {
        sessionMetaParts.push('Git ' + entry.workspace_git_status);
      }
      sessionMeta.textContent = sessionMetaParts.length ? sessionMetaParts.join(' • ') : 'Host n/a';
      sessionCell.append(sessionValue, sessionMeta);

      const phaseCell = document.createElement('td');
      const phaseLabel = document.createElement('div');
      phaseLabel.textContent = entry.current_phase || 'n/a';
      const phaseMeta = document.createElement('div');
      phaseMeta.className = 'muted';
      if (entry.current_phase_at) {
        const phaseAgeMs = Date.now() - Date.parse(entry.current_phase_at);
        const stale = Number.isFinite(phaseAgeMs) && phaseAgeMs > DASHBOARD_CONFIG.phase_stale_warn_ms;
        phaseMeta.textContent = (entry.phase_elapsed_ms ? 'elapsed ' + Math.floor(entry.phase_elapsed_ms / 1000) + 's' : 'elapsed n/a') + ' • phase unchanged for ' + formatDurationFromIso(entry.current_phase_at) + (stale ? ' • No phase movement yet' : '');
      } else {
        phaseMeta.textContent = 'No phase movement yet';
      }
      const threadActivityMeta = document.createElement('div');
      threadActivityMeta.className = 'muted';
      const threadActivity = entry.codex_thread_activity || null;
      if (threadActivity && threadActivity.updated_at) {
        const threadStatus = threadActivity.thread_status ? ' • ' + threadActivity.thread_status : '';
        threadActivityMeta.textContent = 'Agent session active ' + formatDurationFromIso(threadActivity.updated_at) + ' ago' + threadStatus;
      } else if (entry.thread_id) {
        threadActivityMeta.textContent = 'Agent session activity unavailable';
      } else {
        threadActivityMeta.textContent = 'Agent session n/a';
      }
      phaseCell.append(phaseLabel, phaseMeta, threadActivityMeta);

      const runtimeCell = document.createElement('td');
      runtimeCell.className = 'runtime-cell';
      runtimeCell.setAttribute('data-started-at', entry.started_at);
      runtimeCell.textContent = formatDurationFromIso(entry.started_at);
      if (entry.awaiting_input_since_ms) {
        const awaitingTimer = document.createElement('div');
        awaitingTimer.className = 'muted';
        awaitingTimer.textContent = 'Awaiting input: ' + formatDurationFromMs(entry.awaiting_input_since_ms);
        runtimeCell.append(awaitingTimer);
      }
      if (entry.stalled_waiting_since_ms) {
        const stalledTimer = document.createElement('div');
        stalledTimer.className = 'muted';
        stalledTimer.textContent = 'Stalled waiting: ' + formatDurationFromMs(entry.stalled_waiting_since_ms);
        runtimeCell.append(stalledTimer);
      }
      if (entry.not_blocked_explainer_text) {
        const explainer = document.createElement('div');
        explainer.className = 'muted';
        explainer.textContent = 'Why not blocked: ' + entry.not_blocked_explainer_text;
        runtimeCell.append(explainer);
      }

      const turnsCell = document.createElement('td');
      turnsCell.textContent = 'Outer ' + formatNumber(entry.turn_count);
      if (entry.provider_usage) {
        const providerTurns = document.createElement('div');
        providerTurns.className = 'muted';
        providerTurns.textContent = 'Provider ' + (typeof entry.provider_usage.provider_turn_count === 'number'
          ? formatNumber(entry.provider_usage.provider_turn_count)
          : 'n/a');
        turnsCell.append(providerTurns);
      }

      const tokensCell = document.createElement('td');
      if (entry.agent_runtime === 'claude-cli') {
        const providerStatus = entry.provider_usage && entry.provider_usage.status;
        const providerTitle = document.createElement('div');
        providerTitle.textContent = providerStatus === 'partial' ? 'Partial provider usage' : 'Provider usage';
        const providerBadge = document.createElement('span');
        providerBadge.className = 'mini-badge ' + (providerStatus === 'final' ? 'mini-badge-good' : providerStatus === 'unobserved' ? 'mini-badge-bad' : '');
        providerBadge.textContent = providerStatus || 'unobserved';
        const providerDetail = document.createElement('div');
        providerDetail.className = 'muted';
        providerDetail.textContent = formatProviderUsage(entry.provider_usage);
        const enforcement = document.createElement('div');
        enforcement.className = 'muted';
        enforcement.textContent = 'Telemetry only • no Symphony token or cost enforcement';
        tokensCell.append(providerTitle, providerBadge, providerDetail, enforcement);
      } else {
      const tokenTotal = document.createElement('div');
      const telemetryStatus = entry.token_telemetry_status || 'unavailable';
      const telemetryConfidence = entry.token_telemetry_confidence || (telemetryStatus === 'available' ? 'observed_live' : 'missing');
      if (telemetryStatus === 'pending') {
        tokenTotal.textContent = 'Pending';
      } else if (telemetryConfidence === 'missing') {
        tokenTotal.textContent = 'Missing telemetry';
      } else {
        tokenTotal.textContent = 'Total: ' + formatNumber(entry.tokens.total_tokens);
      }
      const tokenDetail = document.createElement('div');
      tokenDetail.className = 'muted';
      if (telemetryStatus === 'available') {
        tokenDetail.textContent = formatTokenBreakdown(entry.tokens, entry.token_telemetry_source);
      } else {
        tokenDetail.textContent = telemetryStatus === 'pending' ? 'Waiting for first usage payload' : 'No telemetry path detected';
      }
      const tokenBadge = document.createElement('span');
      tokenBadge.className = 'mini-badge ' + (telemetryConfidence === 'missing' ? 'mini-badge-bad' : 'mini-badge-good');
      tokenBadge.title = 'Token telemetry confidence/source quality';
      tokenBadge.textContent = getTokenConfidenceLabel(telemetryConfidence);
      tokensCell.append(tokenTotal, tokenBadge, tokenDetail);
      tokensCell.append(createBudgetBlock(entry));
      }

      const blockerCell = document.createElement('td');
      const blockerValue = document.createElement('div');
      blockerValue.textContent = entry.current_blocker_class || 'n/a';
      const diagnosticSummary = document.createElement('div');
      diagnosticSummary.className = 'muted';
      diagnosticSummary.textContent = formatDiagnosticSummary(getDiagnosticSummary(entry));
      blockerCell.append(blockerValue, diagnosticSummary);

      const timeSinceProgressCell = document.createElement('td');
      timeSinceProgressCell.textContent =
        typeof entry.time_since_progress === 'number'
          ? String(entry.time_since_progress) + ' ms (' + formatElapsedMs(entry.time_since_progress) + ')'
          : 'n/a';

      const lastSuccessfulStepCell = document.createElement('td');
      lastSuccessfulStepCell.textContent = entry.last_successful_step || 'n/a';

      const eventCell = document.createElement('td');
      eventCell.textContent = entry.last_event_summary || entry.last_event || 'n/a';

      const messageCell = document.createElement('td');
      const conversationLatest = entry.conversation_latest || null;
      const messageValue = document.createElement('div');
      messageValue.textContent = (conversationLatest && conversationLatest.summary) || entry.last_message || 'n/a';
      messageCell.append(messageValue);
      if (conversationLatest && conversationLatest.role) {
        const conversationMeta = document.createElement('div');
        conversationMeta.className = 'muted';
        conversationMeta.textContent =
          'Conversation latest: ' +
          conversationLatest.role +
          ' via ' +
          (conversationLatest.source || 'unknown') +
          (conversationLatest.at ? ' @ ' + formatDate(conversationLatest.at) : '');
        messageCell.append(conversationMeta);
      }

      const lastEventAtCell = document.createElement('td');
      lastEventAtCell.textContent = formatDate(entry.last_event_at);

      const actionsCell = document.createElement('td');
      actionsCell.className = 'action-cell';
      const lastAction = Array.isArray(entry.operator_actions) && entry.operator_actions.length
        ? entry.operator_actions[entry.operator_actions.length - 1]
        : null;
      if (lastAction) {
        const actionOutcome = document.createElement('div');
        actionOutcome.className = 'muted';
        actionOutcome.textContent = 'Last action: ' + lastAction.action + ' ' + lastAction.result + (lastAction.result_code ? ' (' + lastAction.result_code + ')' : '');
        actionsCell.append(actionOutcome);
      }
      const copySession = createActionButton('Copy Session', 'ghost-button', function () {
        copyText(entry.session_id || '');
      });
      const copyThreadTurn = createActionButton('Copy Thread/Turn', 'ghost-button', function () {
        if (entry.thread_id && entry.turn_id) {
          copyText(entry.thread_id + '/' + entry.turn_id);
          return;
        }
        setRefreshStatus('Thread/turn id unavailable', true);
      });
      const openJson = createActionButton('JSON', 'ghost-button', function () {
        window.open('/api/v1/' + encodeURIComponent(entry.issue_identifier), '_blank', 'noopener');
      });
      const respondNow = createActionButton('Respond Now', 'ghost-button', function () {
        elements.issueInput.value = entry.issue_identifier;
        void loadIssue(entry.issue_identifier);
      });
      respondNow.disabled = !entry.awaiting_input;
      const investigate = createActionButton('Inspect Diagnostics', 'ghost-button', function () {
        elements.issueInput.value = entry.issue_identifier;
        void loadIssue(entry.issue_identifier);
      });
      investigate.disabled = !entry.stalled_waiting;
      const cancelTurn = createActionButton('Cancel Turn', 'ghost-button', function () {
        void runOperatorAction(entry.issue_identifier, 'cancel-turn', true);
      });
      const requeue = createActionButton('Requeue', 'ghost-button', function () {
        void runOperatorAction(entry.issue_identifier, 'requeue', true);
      });
      actionsCell.append(copySession, copyThreadTurn, respondNow, investigate, cancelTurn, requeue, openJson);

      row.append(
        issueCell,
        stateCell,
        sessionCell,
        phaseCell,
        runtimeCell,
        turnsCell,
        tokensCell,
        blockerCell,
        timeSinceProgressCell,
        lastSuccessfulStepCell,
        eventCell,
        messageCell,
        lastEventAtCell,
        actionsCell
      );

      row.addEventListener('click', function () {
        elements.issueInput.value = entry.issue_identifier;
        void loadIssue(entry.issue_identifier);
      });

      return row;
    });

    elements.runningRows.replaceChildren(...nodes);
  }

export function renderRetry(payload: any) {
    const rows = payload.retrying.filter(function (entry: any) {
      if (state.filter.status === 'running' || state.filter.status === 'blocked') {
        return false;
      }
      if (!state.filter.query) {
        return true;
      }
      return entry.issue_identifier.toLowerCase().includes(state.filter.query.toLowerCase());
    });

    if (!rows.length) {
      const emptyRow = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 10;
      cell.className = 'muted';
      cell.textContent =
        state.filter.status === 'retrying'
          ? 'No retrying issues match current filters.'
          : 'No issues are waiting for retry.';
      emptyRow.appendChild(cell);
      elements.retryRows.replaceChildren(emptyRow);
      return;
    }

    const nodes = rows.map((entry: any) => {
      const row = document.createElement('tr');

      const issueCell = document.createElement('td');
      issueCell.textContent = entry.issue_identifier;

      const attemptCell = document.createElement('td');
      attemptCell.textContent = formatNumber(entry.attempt);

      const dueAtCell = document.createElement('td');
      const retryState = document.createElement('div');
      retryState.className = 'status-pill pending';
      retryState.textContent = getRetryStateLabel(entry);
      const retryDue = document.createElement('div');
      retryDue.className = 'muted';
      retryDue.textContent = formatDate(entry.due_at);
      dueAtCell.append(retryState, retryDue);

      const errorCell = document.createElement('td');
      errorCell.textContent = entry.error || 'n/a';

      const hostCell = document.createElement('td');
      hostCell.textContent = entry.worker_host || 'n/a';

      const workspaceCell = document.createElement('td');
      workspaceCell.textContent = entry.workspace_path || 'n/a';

      const provisioningCell = document.createElement('td');
      const provisioningType = document.createElement('div');
      provisioningType.textContent = entry.provisioner_type || 'n/a';
      const provisioningDetail = document.createElement('div');
      provisioningDetail.className = 'muted';
      const provisioningParts = [];
      if (entry.branch_name) {
        provisioningParts.push('Branch ' + entry.branch_name);
      }
      if (entry.workspace_git_status) {
        provisioningParts.push('Git ' + entry.workspace_git_status);
      }
      if (entry.workspace_exists === false) {
        provisioningParts.push('Missing workspace');
      }
      provisioningDetail.textContent = provisioningParts.length ? provisioningParts.join(' • ') : 'n/a';
      const provisioningFlags = document.createElement('div');
      provisioningFlags.className = 'inline-badges';
      provisioningFlags.append(
        createProvisioningBadge('Provisioned', Boolean(entry.workspace_provisioned)),
        createProvisioningBadge('Git worktree', Boolean(entry.workspace_is_git_worktree))
      );
      provisioningCell.append(provisioningType, provisioningDetail, provisioningFlags);

      const stopReasonCell = document.createElement('td');
      const stopReasonCode = document.createElement('div');
      stopReasonCode.textContent = entry.stop_reason_code || 'n/a';
      const stopReasonDetail = document.createElement('div');
      stopReasonDetail.className = 'muted';
      stopReasonDetail.textContent = entry.stop_reason_detail || 'n/a';
      stopReasonCell.append(stopReasonCode, stopReasonDetail);
      stopReasonCell.append(createBudgetBlock(entry));
      const retryHintBadge = createOperatorHintBadge(entry.operator_explainer_hint);
      if (retryHintBadge) {
        stopReasonCell.append(retryHintBadge);
      }
      const lastPhaseLine = document.createElement('div');
      lastPhaseLine.className = 'muted';
      lastPhaseLine.textContent = 'Last phase: ' + (entry.last_phase || 'n/a') + (entry.last_phase_at ? ' @ ' + formatDate(entry.last_phase_at) : '');
      stopReasonCell.append(lastPhaseLine);
      if (entry.last_phase_detail) {
        const lastPhaseDetailLine = document.createElement('div');
        lastPhaseDetailLine.className = 'muted';
        lastPhaseDetailLine.textContent = entry.last_phase_detail;
        stopReasonCell.append(lastPhaseDetailLine);
      }
      const inputDecision = formatInputDecisionContext(entry.stop_reason_detail || '');
      if (inputDecision) {
        const decisionLine = document.createElement('div');
        decisionLine.className = 'muted';
        decisionLine.textContent = inputDecision;
        stopReasonCell.append(decisionLine);
      }
      if (entry.last_input_submit) {
        const submitModeLine = document.createElement('div');
        submitModeLine.className = 'muted';
        submitModeLine.textContent =
          'Last submit: ' +
          entry.last_input_submit.resume_mode +
          ' (' +
          entry.last_input_submit.resume_reason_code +
          ') @ ' +
          formatDate(entry.last_input_submit.submitted_at);
        stopReasonCell.append(submitModeLine);
        if (entry.last_input_submit.resume_mode === 'fallback') {
          const fallbackBanner = document.createElement('div');
          fallbackBanner.className = 'status-pill pending';
          fallbackBanner.textContent = 'Native continuation unavailable; resumed via prompt context fallback.';
          stopReasonCell.append(fallbackBanner);
        }
      }
      if (entry.pending_input) {
        const pending = entry.pending_input;
        const requestLine = document.createElement('div');
        requestLine.className = 'muted';
        requestLine.textContent = 'Request: ' + (pending.request_id || 'n/a') + ' (' + (pending.input_schema_type || 'unknown') + ')';
        stopReasonCell.append(requestLine);
        if (pending.prompt_text) {
          const promptLine = document.createElement('div');
          promptLine.textContent = pending.prompt_text;
          stopReasonCell.append(promptLine);
        }
      }

      const previousSessionCell = document.createElement('td');
      const previousSessionValue = document.createElement('div');
      previousSessionValue.textContent = entry.previous_session_id || 'n/a';
      const previousThreadValue = document.createElement('div');
      previousThreadValue.className = 'muted';
      previousThreadValue.textContent = entry.previous_thread_id ? 'Thread ' + entry.previous_thread_id : 'Thread n/a';
      previousSessionCell.append(previousSessionValue, previousThreadValue);

      const actionsCell = document.createElement('td');
      const copyPreviousSession = createActionButton('Copy Prev Session', 'ghost-button', function () {
        copyText(entry.previous_session_id || '');
      });
      const copyPreviousThread = createActionButton('Copy Prev Thread', 'ghost-button', function () {
        copyText(entry.previous_thread_id || '');
      });
      const openJson = createActionButton('JSON', 'ghost-button', function () {
        window.open('/api/v1/' + encodeURIComponent(entry.issue_identifier), '_blank', 'noopener');
      });
      const retryStep = createActionButton('Retry Step', 'ghost-button', function () {
        void runOperatorAction(entry.issue_identifier, 'retry-step', false);
      });
      const requeue = createActionButton('Requeue', 'ghost-button', function () {
        void runOperatorAction(entry.issue_identifier, 'requeue', false);
      });
      actionsCell.append(copyPreviousSession, copyPreviousThread, retryStep, requeue, openJson);

      row.append(
        issueCell,
        attemptCell,
        dueAtCell,
        hostCell,
        workspaceCell,
        provisioningCell,
        stopReasonCell,
        previousSessionCell,
        errorCell,
        actionsCell
      );
      return row;
    });

    elements.retryRows.replaceChildren(...nodes);
  }

export function renderBlocked(payload: any) {
    const rows = (payload.blocked || []).filter(function (entry: any) {
      if (state.filter.status === 'running' || state.filter.status === 'retrying') {
        return false;
      }
      if (state.filter.blockedReason !== 'all' && entry.stop_reason_code !== state.filter.blockedReason) {
        return false;
      }
      if (!state.filter.query) {
        return true;
      }
      return entry.issue_identifier.toLowerCase().includes(state.filter.query.toLowerCase());
    });

    if (!rows.length) {
      const emptyRow = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 8;
      cell.className = 'muted';
      cell.textContent =
        state.filter.status === 'blocked'
          ? 'No blocked issues match current filters.'
          : 'No issues are blocked on operator input.';
      emptyRow.appendChild(cell);
      elements.blockedRows.replaceChildren(emptyRow);
      return;
    }

    const nodes = rows.map((entry: any) => {
      const row = document.createElement('tr');

      const issueCell = document.createElement('td');
      issueCell.textContent = entry.issue_identifier;

      const attemptCell = document.createElement('td');
      attemptCell.textContent = formatNumber(entry.attempt);

      const blockedAtCell = document.createElement('td');
      blockedAtCell.textContent = formatDate(entry.blocked_at);

      const hostCell = document.createElement('td');
      hostCell.textContent = entry.worker_host || 'n/a';

      const workspaceCell = document.createElement('td');
      workspaceCell.textContent = entry.workspace_path || 'n/a';
      const provisioningFlags = document.createElement('div');
      provisioningFlags.className = 'inline-badges';
      provisioningFlags.append(
        createProvisioningBadge('Provisioned', Boolean(entry.workspace_provisioned)),
        createProvisioningBadge('Git worktree', Boolean(entry.workspace_is_git_worktree))
      );
      workspaceCell.append(provisioningFlags);

      const stopReasonCell = document.createElement('td');
      const rootCauseBlock = createBlockedRootCauseBlock(entry);
      if (rootCauseBlock) {
        stopReasonCell.append(rootCauseBlock);
      }
      const stopReasonCode = document.createElement('div');
      stopReasonCode.textContent =
        rootCauseBlock
          ? 'Current operator block: ' + (entry.current_operator_block?.reason_code || entry.stop_reason_code || 'n/a')
          : entry.stop_reason_code || 'n/a';
      const stopReasonDetail = document.createElement('div');
      stopReasonDetail.className = 'muted';
      stopReasonDetail.textContent =
        rootCauseBlock
          ? 'Current block detail: ' + (entry.current_operator_block?.detail || entry.stop_reason_detail || 'n/a')
          : entry.stop_reason_detail || 'n/a';
      stopReasonCell.append(stopReasonCode, stopReasonDetail);
      stopReasonCell.append(createBudgetBlock(entry));
      if (entry.stop_reason_code) {
        const stateLabel = document.createElement('div');
        stateLabel.className = 'status-pill failed';
        stateLabel.textContent = getActionRequiredLabel(entry.stop_reason_code);
        stopReasonCell.append(stateLabel);
      }
      const controlLine = document.createElement('div');
      controlLine.className = 'inline-badges';
      const turnBadge = document.createElement('span');
      turnBadge.className = 'status-pill failed';
      turnBadge.textContent = getTurnControlLabel(entry.turn_control_state);
      const progressBadge = document.createElement('span');
      progressBadge.className = 'status-pill failed';
      progressBadge.textContent = getProgressSignalLabel(entry.progress_signal_state);
      controlLine.append(turnBadge, progressBadge);
      stopReasonCell.append(controlLine);
      const blockedHintBadge = createOperatorHintBadge(entry.operator_explainer_hint);
      if (blockedHintBadge) {
        stopReasonCell.append(blockedHintBadge);
      }
      const lastPhaseLine = document.createElement('div');
      lastPhaseLine.className = 'muted';
      lastPhaseLine.textContent = 'Last phase: ' + (entry.last_phase || 'n/a') + (entry.last_phase_at ? ' @ ' + formatDate(entry.last_phase_at) : '');
      stopReasonCell.append(lastPhaseLine);
      if (entry.last_phase_detail) {
        const lastPhaseDetailLine = document.createElement('div');
        lastPhaseDetailLine.className = 'muted';
        lastPhaseDetailLine.textContent = entry.last_phase_detail;
        stopReasonCell.append(lastPhaseDetailLine);
      }
      const inputDecision = formatInputDecisionContext(entry.stop_reason_detail || '');
      if (inputDecision) {
        const decisionLine = document.createElement('div');
        decisionLine.className = 'muted';
        decisionLine.textContent = inputDecision;
        stopReasonCell.append(decisionLine);
      }
      if (Array.isArray(entry.conflict_files) && entry.conflict_files.length) {
        const conflictTitle = document.createElement('div');
        conflictTitle.className = 'muted';
        conflictTitle.textContent = 'Conflict files';
        stopReasonCell.append(conflictTitle);
        const conflictChips = document.createElement('div');
        conflictChips.className = 'inline-badges';
        for (const conflict of entry.conflict_files) {
          const chip = document.createElement('span');
          chip.className = 'mini-badge ' + (conflict.status === 'staged' ? 'mini-badge-good' : 'mini-badge-bad');
          chip.textContent = conflict.path + ' (' + (conflict.status || 'unknown') + ')';
          conflictChips.append(chip);
        }
        stopReasonCell.append(conflictChips);
      }
      if (Array.isArray(entry.required_actions) && entry.required_actions.length) {
        const requiredActions = document.createElement('div');
        requiredActions.className = 'muted';
        requiredActions.textContent = 'Required actions: ' + entry.required_actions.join(', ');
        stopReasonCell.append(requiredActions);
      }
      const countWindow = document.createElement('div');
      countWindow.className = 'muted';
      countWindow.textContent =
        'Attempt window: ' +
        formatNumber(entry.attempt_count_window) +
        ' in ' +
        formatNumber(entry.window_minutes) +
        ' minute(s)';
      stopReasonCell.append(countWindow);
      const progressLine = document.createElement('div');
      progressLine.className = 'muted';
      progressLine.textContent =
        'Last progress: ' +
        (entry.last_known_commit_sha || 'n/a') +
        ' @ ' +
        (entry.last_progress_checkpoint_at ? formatDate(entry.last_progress_checkpoint_at) : 'n/a');
      stopReasonCell.append(progressLine);

      const previousSessionCell = document.createElement('td');
      const previousSessionValue = document.createElement('div');
      previousSessionValue.textContent = entry.previous_session_id || 'n/a';
      const previousThreadValue = document.createElement('div');
      previousThreadValue.className = 'muted';
      previousThreadValue.textContent = entry.previous_thread_id ? 'Thread ' + entry.previous_thread_id : 'Thread n/a';
      previousSessionCell.append(previousSessionValue, previousThreadValue);

      const actionsCell = document.createElement('td');
      const lastAction = Array.isArray(entry.operator_actions) && entry.operator_actions.length
        ? entry.operator_actions[entry.operator_actions.length - 1]
        : null;
      if (lastAction) {
        const actionOutcome = document.createElement('div');
        actionOutcome.className = 'muted';
        actionOutcome.textContent = 'Last action: ' + lastAction.action + ' ' + lastAction.result + (lastAction.result_code ? ' (' + lastAction.result_code + ')' : '');
        actionsCell.append(actionOutcome);
      }
      const hasPendingInputRequest = Boolean(entry.pending_input && entry.pending_input.request_id);
      let replyButton = null;
      if (hasPendingInputRequest) {
        replyButton = createActionButton('Reply', 'ghost-button', function () {
          void submitBlockedInput(entry);
        });
      }
      const copyPreviousSession = createActionButton('Copy Prev Session', 'ghost-button', function () {
        copyText(entry.previous_session_id || '');
      });
      const copyWorkspace = createActionButton('Copy Workspace', 'ghost-button', function () {
        copyText(entry.workspace_path || '');
      });
      const openJson = createActionButton('JSON', 'ghost-button', function () {
        window.open('/api/v1/' + encodeURIComponent(entry.issue_identifier), '_blank', 'noopener');
      });
      if (replyButton) {
        actionsCell.append(replyButton);
      } else if (entry.runtime_state_kind !== 'automation_fault') {
        const manualResumeNote = document.createElement('div');
        manualResumeNote.className = 'muted';
        manualResumeNote.textContent = 'Manual resume required; no pending input request.';
        actionsCell.append(manualResumeNote);
      }
      const availableActions = Array.isArray(entry.available_actions) ? entry.available_actions : [];
      availableActions.forEach(function (action: any) {
        if (!action || !action.id || !action.label) {
          return;
        }
        if (action.id === 'submit_input') {
          return;
        }
        const button = createActionButton(action.label, 'ghost-button', function () {
          if (action.id === 'resume' && action.label === 'Push Commit + Resume') {
            void resumeBlockedIssue(entry.issue_identifier, 'operator_override_push_additional_commit');
            return;
          }
          if (action.id === 'resume') {
            void resumeBlockedIssue(entry.issue_identifier);
            return;
          }
          if (action.id === 'cancel') {
            void cancelBlockedIssue(entry.issue_identifier, 'operator_cancel_return_to_backlog');
            return;
          }
          if (action.id === 'clear_automation_fault') {
            void runOperatorAction(entry.issue_identifier, 'clear-automation-fault', Boolean(action.destructive));
            return;
          }
          void runOperatorAction(entry.issue_identifier, action.id === 'retry_step' ? 'retry-step' : action.id, Boolean(action.destructive));
        });
        actionsCell.append(button);
      });
      if (entry.runtime_state_kind === 'automation_fault') {
        const faultNote = document.createElement('div');
        faultNote.className = 'muted';
        faultNote.textContent = 'No-progress redispatch circuit breaker: ' + (entry.breaker_hit_count || 0) + ' hit(s) in ' + (entry.breaker_window_minutes || 0) + 'm.';
        actionsCell.append(faultNote);
      }
      actionsCell.append(copyPreviousSession, copyWorkspace, openJson);

      row.append(
        issueCell,
        attemptCell,
        blockedAtCell,
        hostCell,
        workspaceCell,
        stopReasonCell,
        previousSessionCell,
        actionsCell
      );
      return row;
    });

    elements.blockedRows.replaceChildren(...nodes);
  }
