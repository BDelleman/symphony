import net from 'node:net';
import path from 'node:path';

import { nowIso } from './errors';
import {
  isSupportedApprovalPolicy,
  isSupportedThreadSandbox,
  isSupportedTurnSandbox
} from '../security/profiles';
import type { DispatchPreflightOutcome, EffectiveConfig, ValidationResult } from './types';

export interface ConfigValidatorOptions {
  clock?: () => Date;
}

function mapGitHubStateNamesToEnums(stateNames: string[]): string[] {
  const mapped = new Set<string>();

  for (const stateName of stateNames) {
    const normalized = stateName.trim().toLowerCase();
    if (normalized === 'open') {
      mapped.add('OPEN');
      continue;
    }

    if (normalized === 'closed') {
      mapped.add('CLOSED');
    }
  }

  return Array.from(mapped);
}

function isValidServerHost(host: string): boolean {
  const trimmed = host.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === 'localhost') {
    return true;
  }
  if (net.isIP(trimmed) !== 0) {
    return true;
  }

  // Allow resolvable DNS hostnames; resolvability is validated at runtime startup.
  return /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)$/.test(
    trimmed
  );
}

function isPositiveInteger(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value > 0 && Math.trunc(value) === value);
}

function normalizeStateName(value: string): string {
  return value.trim().toLowerCase();
}

export class ConfigValidator {
  private readonly clock: () => Date;

  constructor(options: ConfigValidatorOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  validate(effectiveConfig: EffectiveConfig): ValidationResult {
    const at = nowIso(this.clock);

    if (!effectiveConfig.tracker.kind.trim()) {
      return {
        ok: false,
        error_code: 'missing_tracker_kind',
        message: 'tracker.kind is required',
        at
      };
    }

    if (
      effectiveConfig.tracker.kind !== 'linear' &&
      effectiveConfig.tracker.kind !== 'github' &&
      effectiveConfig.tracker.kind !== 'memory'
    ) {
      return {
        ok: false,
        error_code: 'unsupported_tracker_kind',
        message: `tracker.kind '${effectiveConfig.tracker.kind}' is not supported`,
        at
      };
    }

    if (effectiveConfig.tracker.kind !== 'memory' && !effectiveConfig.tracker.api_key.trim()) {
      return {
        ok: false,
        error_code: 'missing_tracker_api_key',
        message: 'tracker.api_key is required after env resolution',
        at
      };
    }

    if (effectiveConfig.tracker.kind === 'linear' && !effectiveConfig.tracker.project_slug.trim()) {
      return {
        ok: false,
        error_code: 'missing_tracker_project_slug',
        message: 'tracker.project_slug is required for tracker.kind=linear',
        at
      };
    }

    if (effectiveConfig.tracker.kind === 'github' && !effectiveConfig.tracker.owner?.trim()) {
      return {
        ok: false,
        error_code: 'missing_tracker_owner',
        message: 'tracker.owner is required for tracker.kind=github',
        at
      };
    }

    if (effectiveConfig.tracker.kind === 'github' && !effectiveConfig.tracker.repo?.trim()) {
      return {
        ok: false,
        error_code: 'missing_tracker_repo',
        message: 'tracker.repo is required for tracker.kind=github',
        at
      };
    }

    if (effectiveConfig.tracker.kind === 'github') {
      const mappedActiveStates = mapGitHubStateNamesToEnums(effectiveConfig.tracker.active_states);
      if (mappedActiveStates.length === 0) {
        return {
          ok: false,
          error_code: 'invalid_tracker_active_states_for_github',
          message: 'tracker.active_states must include at least one of: Open, Closed for tracker.kind=github',
          at
        };
      }
    }

    if (effectiveConfig.review_approval) {
      if (
        effectiveConfig.review_approval.provider !== 'github_app' ||
        effectiveConfig.review_approval.required !== true ||
        effectiveConfig.tracker.kind !== 'linear'
      ) {
        return {
          ok: false,
          error_code: 'invalid_review_approval',
          message: 'review_approval requires provider=github_app, required=true, and tracker.kind=linear',
          at
        };
      }
      if (!effectiveConfig.tracker.fresh_dispatch_states.some((state) => state.trim().toLowerCase() === 'agent review')) {
        return {
          ok: false,
          error_code: 'invalid_review_approval',
          message: 'review_approval requires Agent Review in tracker.fresh_dispatch_states',
          at
        };
      }
      if (!effectiveConfig.persistence.enabled) {
        return {
          ok: false,
          error_code: 'invalid_review_approval',
          message: 'review_approval requires persistence.enabled=true for durable supervisor actions',
          at
        };
      }
      const externalReview = effectiveConfig.review_approval.external_review;
      if (
        externalReview
        && (!externalReview.bot_login.trim()
          || !externalReview.request_marker.trim()
          || !externalReview.unavailable_pattern.trim())
      ) {
        return {
          ok: false,
          error_code: 'invalid_review_approval',
          message:
            'review_approval.external_review requires non-empty bot_login, request_marker, and unavailable_pattern',
          at
        };
      }
    }

    const githubLinkingMode = effectiveConfig.tracker.github_linking?.mode ?? 'off';
    if (githubLinkingMode !== 'off' && githubLinkingMode !== 'warn' && githubLinkingMode !== 'required') {
      return {
        ok: false,
        error_code: 'invalid_tracker_github_linking_mode',
        message: `tracker.github_linking.mode '${githubLinkingMode}' is not supported`,
        at
      };
    }

    const terminalStates = new Set(effectiveConfig.tracker.terminal_states.map(normalizeStateName));
    const activeStates = new Set(effectiveConfig.tracker.active_states.map(normalizeStateName));
    const handoffStates = new Set(effectiveConfig.tracker.handoff_states.map(normalizeStateName));
    const handoffTerminalOverlap = effectiveConfig.tracker.handoff_states.find((stateName) =>
      terminalStates.has(normalizeStateName(stateName))
    );
    if (handoffTerminalOverlap !== undefined) {
      return {
        ok: false,
        error_code: 'invalid_tracker_handoff_states',
        message: `tracker.handoff_states must not include terminal state '${handoffTerminalOverlap}'`,
        at
      };
    }

    const freshTerminalOverlap = effectiveConfig.tracker.fresh_dispatch_states.find((stateName) =>
      terminalStates.has(normalizeStateName(stateName))
    );
    if (freshTerminalOverlap !== undefined) {
      return {
        ok: false,
        error_code: 'invalid_tracker_fresh_dispatch_states',
        message: `tracker.fresh_dispatch_states must not include terminal state '${freshTerminalOverlap}'`,
        at
      };
    }

    const freshOutsideHandoff = effectiveConfig.tracker.fresh_dispatch_states.find(
      (stateName) => !handoffStates.has(normalizeStateName(stateName))
    );
    if (freshOutsideHandoff !== undefined) {
      return {
        ok: false,
        error_code: 'invalid_tracker_fresh_dispatch_states',
        message: `tracker.fresh_dispatch_states must also be listed in tracker.handoff_states: '${freshOutsideHandoff}'`,
        at
      };
    }

    const freshOutsideActive = effectiveConfig.tracker.fresh_dispatch_states.find(
      (stateName) => !activeStates.has(normalizeStateName(stateName))
    );
    if (freshOutsideActive !== undefined) {
      return {
        ok: false,
        error_code: 'invalid_tracker_fresh_dispatch_states',
        message: `tracker.fresh_dispatch_states must also be listed in tracker.active_states: '${freshOutsideActive}'`,
        at
      };
    }

    if (!effectiveConfig.codex.command.trim()) {
      return {
        ok: false,
        error_code: 'missing_codex_command',
        message: 'codex.command is required and must be non-empty',
        at
      };
    }

    const reasoningEffort = effectiveConfig.codex.effective_reasoning_effort;
    if (
      reasoningEffort !== null &&
      reasoningEffort !== undefined &&
      reasoningEffort !== 'low' &&
      reasoningEffort !== 'medium' &&
      reasoningEffort !== 'high' &&
      reasoningEffort !== 'xhigh'
    ) {
      return {
        ok: false,
        error_code: 'invalid_codex_reasoning_effort',
        message: "codex.reasoning_effort must be one of: low, medium, high, xhigh",
        at
      };
    }

    const extraFlags = effectiveConfig.codex.effective_extra_flags ?? [];
    if (
      !Array.isArray(extraFlags) ||
      extraFlags.length > 32 ||
      extraFlags.some((entry) => typeof entry !== 'string' || entry.length > 120)
    ) {
      return {
        ok: false,
        error_code: 'invalid_codex_extra_flags',
        message: 'codex.extra_flags must be a string array with at most 32 entries and 120 chars per entry',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.polling.interval_ms) || effectiveConfig.polling.interval_ms <= 0) {
      return {
        ok: false,
        error_code: 'invalid_polling_interval_ms',
        message: 'polling.interval_ms must be a positive integer',
        at
      };
    }

    const uiEvidenceProfile = effectiveConfig.validation?.ui_evidence_profile ?? 'baseline';
    if (uiEvidenceProfile !== 'baseline' && uiEvidenceProfile !== 'strict') {
      return {
        ok: false,
        error_code: 'invalid_validation_ui_evidence_profile',
        message: `validation.ui_evidence_profile '${uiEvidenceProfile}' is not supported`,
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.hooks.timeout_ms) || effectiveConfig.hooks.timeout_ms <= 0) {
      return {
        ok: false,
        error_code: 'invalid_hooks_timeout_ms',
        message: 'hooks.timeout_ms must be a positive integer when provided',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.agent.max_concurrent_agents) || effectiveConfig.agent.max_concurrent_agents <= 0) {
      return {
        ok: false,
        error_code: 'invalid_agent_max_concurrent_agents',
        message: 'agent.max_concurrent_agents must be a positive integer',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.agent.max_turns) || effectiveConfig.agent.max_turns <= 0) {
      return {
        ok: false,
        error_code: 'invalid_agent_max_turns',
        message: 'agent.max_turns must be a positive integer',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.agent.max_retry_backoff_ms) || effectiveConfig.agent.max_retry_backoff_ms <= 0) {
      return {
        ok: false,
        error_code: 'invalid_agent_max_retry_backoff_ms',
        message: 'agent.max_retry_backoff_ms must be a positive integer',
        at
      };
    }

    const respawnWindowMinutes = effectiveConfig.agent.respawn_window_minutes ?? 30;
    if (!Number.isFinite(respawnWindowMinutes) || respawnWindowMinutes <= 0) {
      return {
        ok: false,
        error_code: 'invalid_agent_respawn_window_minutes',
        message: 'agent.respawn_window_minutes must be a positive integer',
        at
      };
    }

    if (
      !Number.isFinite(effectiveConfig.agent.respawn_max_attempts_without_progress ?? 3) ||
      (effectiveConfig.agent.respawn_max_attempts_without_progress ?? 3) <= 0
    ) {
      return {
        ok: false,
        error_code: 'invalid_agent_respawn_max_attempts_without_progress',
        message: 'agent.respawn_max_attempts_without_progress must be a positive integer',
        at
      };
    }

    for (const [stateName, limit] of Object.entries(effectiveConfig.agent.max_concurrent_agents_by_state)) {
      if (!Number.isFinite(limit) || limit <= 0) {
        return {
          ok: false,
          error_code: 'invalid_agent_max_concurrent_agents_by_state',
          message: `agent.max_concurrent_agents_by_state['${stateName}'] must be a positive integer`,
          at
        };
      }
    }

    const dispatchBackpressure = effectiveConfig.agent.dispatch_backpressure ?? {
      enabled: true,
      retry_delay_ms: 30000,
      min_running_agents: 1,
      control_plane_health: 'degraded' as const,
      control_plane_stale_after_ms: 60000
    };
    if (
      !Number.isFinite(dispatchBackpressure.retry_delay_ms) ||
      dispatchBackpressure.retry_delay_ms <= 0 ||
      Math.trunc(dispatchBackpressure.retry_delay_ms) !== dispatchBackpressure.retry_delay_ms
    ) {
      return {
        ok: false,
        error_code: 'invalid_agent_dispatch_backpressure',
        message: 'agent.dispatch_backpressure.retry_delay_ms must be a positive integer',
        at
      };
    }
    if (
      !Number.isFinite(dispatchBackpressure.min_running_agents) ||
      dispatchBackpressure.min_running_agents < 0 ||
      Math.trunc(dispatchBackpressure.min_running_agents) !== dispatchBackpressure.min_running_agents
    ) {
      return {
        ok: false,
        error_code: 'invalid_agent_dispatch_backpressure',
        message: 'agent.dispatch_backpressure.min_running_agents must be a non-negative integer',
        at
      };
    }
    if (
      dispatchBackpressure.control_plane_health !== 'slow' &&
      dispatchBackpressure.control_plane_health !== 'large' &&
      dispatchBackpressure.control_plane_health !== 'degraded'
    ) {
      return {
        ok: false,
        error_code: 'invalid_agent_dispatch_backpressure',
        message: "agent.dispatch_backpressure.control_plane_health must be one of: slow, large, degraded",
        at
      };
    }
    if (
      !Number.isFinite(dispatchBackpressure.control_plane_stale_after_ms) ||
      dispatchBackpressure.control_plane_stale_after_ms <= 0 ||
      Math.trunc(dispatchBackpressure.control_plane_stale_after_ms) !== dispatchBackpressure.control_plane_stale_after_ms
    ) {
      return {
        ok: false,
        error_code: 'invalid_agent_dispatch_backpressure',
        message: 'agent.dispatch_backpressure.control_plane_stale_after_ms must be a positive integer',
        at
      };
    }
    if (
      dispatchBackpressure.host_load_per_cpu !== undefined &&
      dispatchBackpressure.host_load_per_cpu !== null &&
      (!Number.isFinite(dispatchBackpressure.host_load_per_cpu) || dispatchBackpressure.host_load_per_cpu <= 0)
    ) {
      return {
        ok: false,
        error_code: 'invalid_agent_dispatch_backpressure',
        message: 'agent.dispatch_backpressure.host_load_per_cpu must be positive when provided',
        at
      };
    }

    const budget = effectiveConfig.budget ?? {
      rolling_window_minutes: 1440,
      warning_threshold_ratio: 0.8,
      hard_limit_policy: 'block_requires_resume'
    };

    if (!isPositiveInteger(budget.per_run_total_tokens)) {
      return {
        ok: false,
        error_code: 'invalid_budget_per_run_total_tokens',
        message: 'budget.per_run_total_tokens must be a positive integer when provided',
        at
      };
    }

    if (!isPositiveInteger(budget.per_issue_rolling_tokens)) {
      return {
        ok: false,
        error_code: 'invalid_budget_per_issue_rolling_tokens',
        message: 'budget.per_issue_rolling_tokens must be a positive integer when provided',
        at
      };
    }

    if (
      !Number.isFinite(budget.rolling_window_minutes) ||
      budget.rolling_window_minutes <= 0 ||
      Math.trunc(budget.rolling_window_minutes) !== budget.rolling_window_minutes
    ) {
      return {
        ok: false,
        error_code: 'invalid_budget_rolling_window_minutes',
        message: 'budget.rolling_window_minutes must be a positive integer',
        at
      };
    }

    if (
      !Number.isFinite(budget.warning_threshold_ratio) ||
      budget.warning_threshold_ratio <= 0 ||
      budget.warning_threshold_ratio > 1
    ) {
      return {
        ok: false,
        error_code: 'invalid_budget_warning_threshold_ratio',
        message: 'budget.warning_threshold_ratio must be greater than 0 and less than or equal to 1',
        at
      };
    }

    if (
      budget.hard_limit_policy !== 'block_requires_resume' &&
      budget.hard_limit_policy !== 'terminate_attempt'
    ) {
      return {
        ok: false,
        error_code: 'invalid_budget_hard_limit_policy',
        message: "budget.hard_limit_policy must be 'block_requires_resume' or 'terminate_attempt'",
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.codex.turn_timeout_ms) || effectiveConfig.codex.turn_timeout_ms <= 0) {
      return {
        ok: false,
        error_code: 'invalid_codex_turn_timeout_ms',
        message: 'codex.turn_timeout_ms must be a positive integer',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.codex.read_timeout_ms) || effectiveConfig.codex.read_timeout_ms <= 0) {
      return {
        ok: false,
        error_code: 'invalid_codex_read_timeout_ms',
        message: 'codex.read_timeout_ms must be a positive integer',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.codex.stall_timeout_ms) || effectiveConfig.codex.stall_timeout_ms <= 0) {
      return {
        ok: false,
        error_code: 'invalid_codex_stall_timeout_ms',
        message: 'codex.stall_timeout_ms must be a positive integer',
        at
      };
    }
    const runningWaitThreshold = effectiveConfig.codex.running_wait_stall_threshold_ms ?? 300000;
    if (!Number.isFinite(runningWaitThreshold) || runningWaitThreshold <= 0) {
      return {
        ok: false,
        error_code: 'invalid_codex_running_wait_stall_threshold_ms',
        message: 'codex.running_wait_stall_threshold_ms must be a positive integer',
        at
      };
    }

    const heartbeatOnlyWarnMs = effectiveConfig.codex.progress_heartbeat_only_warn_ms ?? 120000;
    if (!Number.isFinite(heartbeatOnlyWarnMs) || heartbeatOnlyWarnMs <= 0) {
      return {
        ok: false,
        error_code: 'invalid_codex_progress_heartbeat_only_warn_ms',
        message: 'codex.progress_heartbeat_only_warn_ms must be a positive integer',
        at
      };
    }

    const stalledWaitingMs = effectiveConfig.codex.progress_stalled_waiting_ms ?? 300000;
    if (!Number.isFinite(stalledWaitingMs) || stalledWaitingMs <= 0) {
      return {
        ok: false,
        error_code: 'invalid_codex_progress_stalled_waiting_ms',
        message: 'codex.progress_stalled_waiting_ms must be a positive integer',
        at
      };
    }

    const opaqueActivityHardTimeoutMs = effectiveConfig.codex.worker_opaque_activity_hard_timeout_ms ?? 1800000;
    if (!Number.isFinite(opaqueActivityHardTimeoutMs) || opaqueActivityHardTimeoutMs <= 0) {
      return {
        ok: false,
        error_code: 'invalid_codex_worker_opaque_activity_hard_timeout_ms',
        message: 'codex.worker_opaque_activity_hard_timeout_ms must be a positive integer',
        at
      };
    }

    const provisionerType = effectiveConfig.workspace.provisioner.type;
    if (provisionerType !== 'none' && provisionerType !== 'worktree' && provisionerType !== 'clone') {
      return {
        ok: false,
        error_code: 'invalid_workspace_provisioner_type',
        message: `workspace.provisioner.type '${provisionerType}' is not supported`,
        at
      };
    }

    const runtimeUpdateGithubEligibilityMode = effectiveConfig.runtime_update?.github_eligibility.mode ?? 'required';
    if (
      runtimeUpdateGithubEligibilityMode !== 'required' &&
      runtimeUpdateGithubEligibilityMode !== 'allow_absent_checks' &&
      runtimeUpdateGithubEligibilityMode !== 'trust_raw_git'
    ) {
      return {
        ok: false,
        error_code: 'invalid_runtime_update_github_eligibility_mode',
        message: `runtime_update.github_eligibility.mode '${runtimeUpdateGithubEligibilityMode}' is not supported`,
        at
      };
    }

    const teardownMode = effectiveConfig.workspace.provisioner.teardown_mode;
    if (teardownMode !== 'remove_worktree' && teardownMode !== 'keep') {
      return {
        ok: false,
        error_code: 'invalid_workspace_provisioner_teardown_mode',
        message: `workspace.provisioner.teardown_mode '${teardownMode}' is not supported`,
        at
      };
    }

    if (
      (provisionerType === 'worktree' || provisionerType === 'clone') &&
      !effectiveConfig.workspace.provisioner.repo_root?.trim()
    ) {
      return {
        ok: false,
        error_code: 'invalid_workspace_provisioner_repo_root',
        message: `workspace.provisioner.repo_root is required when workspace.provisioner.type=${provisionerType}`,
        at
      };
    }

    if (
      provisionerType === 'worktree' &&
      !effectiveConfig.workspace.provisioner.branch_template.includes('{{ issue.identifier }}')
    ) {
      return {
        ok: false,
        error_code: 'invalid_workspace_provisioner_branch_template',
        message:
          'workspace.provisioner.branch_template must include {{ issue.identifier }} when workspace.provisioner.type=worktree',
        at
      };
    }

    const approvalPolicyValue = effectiveConfig.codex.approval_policy;
    const approvalPolicyLooksLikeObject =
      approvalPolicyValue !== undefined &&
      typeof approvalPolicyValue === 'object' &&
      approvalPolicyValue !== null;
    if (!isSupportedApprovalPolicy(approvalPolicyValue)) {
      return {
        ok: false,
        error_code: approvalPolicyLooksLikeObject
          ? 'invalid_codex_approval_policy_shape'
          : 'invalid_codex_approval_policy',
        message: approvalPolicyLooksLikeObject
          ? 'codex.approval_policy object shape is invalid'
          : `codex.approval_policy '${String(approvalPolicyValue)}' is not supported`,
        at
      };
    }

    if (!isSupportedThreadSandbox(effectiveConfig.codex.thread_sandbox)) {
      return {
        ok: false,
        error_code: 'invalid_codex_thread_sandbox',
        message: `codex.thread_sandbox '${effectiveConfig.codex.thread_sandbox}' is not supported`,
        at
      };
    }

    if (!isSupportedTurnSandbox(effectiveConfig.codex.turn_sandbox_policy)) {
      return {
        ok: false,
        error_code: 'invalid_codex_turn_sandbox_policy',
        message: `codex.turn_sandbox_policy '${effectiveConfig.codex.turn_sandbox_policy}' is not supported`,
        at
      };
    }

    if (
      provisionerType === 'worktree' &&
      (effectiveConfig.codex.thread_sandbox !== 'danger-full-access' ||
        effectiveConfig.codex.turn_sandbox_policy !== 'danger-full-access')
    ) {
      return {
        ok: false,
        error_code: 'invalid_worktree_sandbox_policy',
        message:
          'workspace.provisioner.type=worktree requires codex.thread_sandbox=danger-full-access and codex.turn_sandbox_policy=danger-full-access',
        at
      };
    }

    const copyIgnored = effectiveConfig.workspace.copy_ignored;
    if (copyIgnored.enabled) {
      if (!path.isAbsolute(copyIgnored.include_file) || copyIgnored.include_file.trim().length === 0) {
        return {
          ok: false,
          error_code: 'invalid_workspace_copy_ignored_include_file',
          message: 'workspace.copy_ignored.include_file must resolve to a non-empty absolute path',
          at
        };
      }

      if (copyIgnored.from !== 'primary_worktree' && copyIgnored.from !== 'repo_root') {
        return {
          ok: false,
          error_code: 'invalid_workspace_copy_ignored_from',
          message: `workspace.copy_ignored.from '${copyIgnored.from}' is not supported`,
          at
        };
      }

      if (
        copyIgnored.conflict_policy !== 'skip' &&
        copyIgnored.conflict_policy !== 'overwrite' &&
        copyIgnored.conflict_policy !== 'fail'
      ) {
        return {
          ok: false,
          error_code: 'invalid_workspace_copy_ignored_conflict_policy',
          message: `workspace.copy_ignored.conflict_policy '${copyIgnored.conflict_policy}' is not supported`,
          at
        };
      }

      if (
        !Number.isFinite(copyIgnored.max_files) ||
        copyIgnored.max_files <= 0 ||
        !Number.isFinite(copyIgnored.max_total_bytes) ||
        copyIgnored.max_total_bytes <= 0
      ) {
        return {
          ok: false,
          error_code: 'invalid_workspace_copy_ignored_limits',
          message: 'workspace.copy_ignored.max_files and max_total_bytes must be positive integers',
          at
        };
      }
    }

    if (
      effectiveConfig.codex.user_input_policy !== undefined &&
      effectiveConfig.codex.user_input_policy !== 'fail_attempt'
    ) {
      return {
        ok: false,
        error_code: 'invalid_codex_user_input_policy',
        message: `codex.user_input_policy '${effectiveConfig.codex.user_input_policy}' is not supported`,
        at
      };
    }

    if (
      effectiveConfig.worker?.max_concurrent_agents_per_host !== undefined &&
      (!Number.isFinite(effectiveConfig.worker.max_concurrent_agents_per_host) ||
        effectiveConfig.worker.max_concurrent_agents_per_host <= 0)
    ) {
      return {
        ok: false,
        error_code: 'invalid_worker_max_concurrent_agents_per_host',
        message: 'worker.max_concurrent_agents_per_host must be a positive integer when provided',
        at
      };
    }

    if (effectiveConfig.server?.host !== undefined && !isValidServerHost(effectiveConfig.server.host)) {
      return {
        ok: false,
        error_code: 'invalid_server_host',
        message: `server.host '${effectiveConfig.server.host}' is not a valid bind host`,
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.logging.max_bytes) || effectiveConfig.logging.max_bytes <= 0) {
      return {
        ok: false,
        error_code: 'invalid_logging_max_bytes',
        message: 'logging.max_bytes must be a positive integer',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.logging.max_files) || effectiveConfig.logging.max_files <= 0) {
      return {
        ok: false,
        error_code: 'invalid_logging_max_files',
        message: 'logging.max_files must be a positive integer',
        at
      };
    }

    return { ok: true, at };
  }

  evaluateDispatchPreflight(effectiveConfig: EffectiveConfig): DispatchPreflightOutcome {
    const validation = this.validate(effectiveConfig);

    if (!validation.ok) {
      return {
        dispatch_allowed: false,
        reconciliation_allowed: true,
        validation
      };
    }

    return {
      dispatch_allowed: true,
      reconciliation_allowed: true,
      validation
    };
  }
}
