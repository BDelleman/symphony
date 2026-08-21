import { describe, expect, it } from 'vitest';

import { ConfigValidator } from '../../src/workflow/validator';
import type { EffectiveConfig } from '../../src/workflow/types';

function baseConfig(): EffectiveConfig {
  return {
    tracker: {
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      api_key: 'token',
      project_slug: 'ABC',
      github_linking: { mode: 'off' },
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done'],
      handoff_states: [],
      fresh_dispatch_states: []
    },
    polling: { interval_ms: 30000 },
    workspace: {
      root: '/tmp/symphony',
      root_source: 'workflow',
      provisioner: {
        type: 'none',
        base_ref: 'origin/main',
        branch_template: 'feature/{{ issue.identifier }}',
        teardown_mode: 'remove_worktree',
        allow_dirty_repo: false,
        fallback_to_clone_on_worktree_failure: false
      },
      copy_ignored: {
        enabled: false,
        include_file: '/tmp/symphony/.worktreeinclude',
        from: 'primary_worktree',
        conflict_policy: 'skip',
        require_gitignored: true,
        max_files: 10_000,
        max_total_bytes: 5 * 1024 * 1024 * 1024,
        allow_patterns: [],
        deny_patterns: []
      }
    },
    hooks: { timeout_ms: 60000 },
    agent: {
      max_concurrent_agents: 10,
      max_retry_backoff_ms: 300000,
      max_turns: 20,
      max_concurrent_agents_by_state: {}
    },
    budget: {
      rolling_window_minutes: 1440,
      warning_threshold_ratio: 0.8,
      hard_limit_policy: 'block_requires_resume'
    },
    codex: {
      command: 'codex app-server',
      turn_timeout_ms: 3600000,
      read_timeout_ms: 5000,
      stall_timeout_ms: 300000,
      progress_heartbeat_only_warn_ms: 120000,
      progress_stalled_waiting_ms: 300000
    },
    persistence: {
      enabled: true,
      db_path: '/tmp/symphony/runtime.sqlite',
      db_path_source: 'workflow',
      retention_days: 14
    },
    logging: {
      root: '/tmp/symphony/log',
      root_source: 'workflow',
      max_bytes: 10 * 1024 * 1024,
      max_files: 5
    },
    validation: {
      ui_evidence_profile: 'baseline'
    },
    runtime_update: {
      github_eligibility: {
        mode: 'required'
      }
    }
  };
}

describe('ConfigValidator', () => {
  it('returns ok for valid config', () => {
    const validator = new ConfigValidator();
    expect(validator.validate(baseConfig())).toEqual({ ok: true, at: expect.any(String) });
  });

  it('requires durable fresh Agent Review dispatch for the GitHub App gate', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.review_approval = { provider: 'github_app', required: true };
    config.tracker.active_states.push('Agent Review');
    config.tracker.handoff_states = ['Agent Review'];
    config.tracker.fresh_dispatch_states = ['Agent Review'];
    expect(validator.validate(config).ok).toBe(true);

    config.persistence.enabled = false;
    expect(validator.validate(config)).toMatchObject({ ok: false, error_code: 'invalid_review_approval' });
  });

  it('enforces supported tracker kind', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.kind = 'jira';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('unsupported_tracker_kind');
    }
  });

  it('enforces tracker api key after resolution', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.api_key = '';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('missing_tracker_api_key');
    }
  });

  it('enforces project slug for linear tracker', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.project_slug = '   ';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('missing_tracker_project_slug');
    }
  });

  it('requires owner and repo for github tracker', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.kind = 'github';
    config.tracker.project_slug = '';
    config.tracker.owner = ' ';
    config.tracker.repo = 'symphony';

    const missingOwner = validator.validate(config);
    expect(missingOwner.ok).toBe(false);
    if (!missingOwner.ok) {
      expect(missingOwner.error_code).toBe('missing_tracker_owner');
    }

    config.tracker.owner = 'nielsgl';
    config.tracker.repo = '';

    const missingRepo = validator.validate(config);
    expect(missingRepo.ok).toBe(false);
    if (!missingRepo.ok) {
      expect(missingRepo.error_code).toBe('missing_tracker_repo');
    }
  });

  it('accepts valid github tracker config', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.kind = 'github';
    config.tracker.project_slug = '';
    config.tracker.owner = 'nielsgl';
    config.tracker.repo = 'symphony';
    config.tracker.active_states = ['Open'];

    expect(validator.validate(config)).toEqual({ ok: true, at: expect.any(String) });
  });

  it('rejects unsupported tracker.github_linking.mode values', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.github_linking = { mode: 'enforce' };

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_tracker_github_linking_mode');
    }
  });

  it('accepts non-terminal handoff and fresh dispatch states', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.active_states = ['Todo', 'In Progress', 'Agent Review'];
    config.tracker.handoff_states = ['Agent Review', 'Human Review'];
    config.tracker.fresh_dispatch_states = ['Agent Review'];

    expect(validator.validate(config)).toEqual({ ok: true, at: expect.any(String) });
  });

  it('rejects terminal state overlap in handoff and fresh dispatch states', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.handoff_states = ['Agent Review', 'Done'];

    const invalidHandoff = validator.validate(config);
    expect(invalidHandoff.ok).toBe(false);
    if (!invalidHandoff.ok) {
      expect(invalidHandoff.error_code).toBe('invalid_tracker_handoff_states');
      expect(invalidHandoff.message).toContain("terminal state 'Done'");
    }

    config.tracker.handoff_states = ['Agent Review'];
    config.tracker.fresh_dispatch_states = ['Done'];
    const invalidFreshDispatch = validator.validate(config);
    expect(invalidFreshDispatch.ok).toBe(false);
    if (!invalidFreshDispatch.ok) {
      expect(invalidFreshDispatch.error_code).toBe('invalid_tracker_fresh_dispatch_states');
      expect(invalidFreshDispatch.message).toContain("terminal state 'Done'");
    }
  });

  it('requires fresh dispatch states to also be handoff states', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.handoff_states = ['Human Review'];
    config.tracker.fresh_dispatch_states = ['Agent Review'];

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_tracker_fresh_dispatch_states');
      expect(result.message).toContain('tracker.handoff_states');
    }
  });

  it('requires fresh dispatch states to also be active states', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.handoff_states = ['Agent Review'];
    config.tracker.fresh_dispatch_states = ['Agent Review'];

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_tracker_fresh_dispatch_states');
      expect(result.message).toContain('tracker.active_states');
    }
  });

  it('rejects github tracker config when active_states cannot map to open/closed', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.kind = 'github';
    config.tracker.project_slug = '';
    config.tracker.owner = 'nielsgl';
    config.tracker.repo = 'symphony';
    config.tracker.active_states = ['Todo', 'In Progress'];

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_tracker_active_states_for_github');
    }
  });

  it('accepts memory tracker config without api key or project slug', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.kind = 'memory';
    config.tracker.api_key = '';
    config.tracker.project_slug = '';
    config.tracker.active_states = ['Todo'];

    expect(validator.validate(config)).toEqual({ ok: true, at: expect.any(String) });
  });

  it('enforces non-empty codex command', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.codex.command = '   ';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('missing_codex_command');
    }
  });

  it('accepts valid budget controls', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.budget = {
      per_run_total_tokens: 1000,
      per_issue_rolling_tokens: 5000,
      rolling_window_minutes: 60,
      warning_threshold_ratio: 0.75,
      hard_limit_policy: 'terminate_attempt'
    };

    expect(validator.validate(config)).toEqual({ ok: true, at: expect.any(String) });
  });

  it('rejects invalid budget controls with typed errors', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.budget = {
      rolling_window_minutes: 1440,
      warning_threshold_ratio: 0.8,
      hard_limit_policy: 'block_requires_resume'
    };
    config.budget.per_run_total_tokens = 0;

    const invalidRunLimit = validator.validate(config);
    expect(invalidRunLimit.ok).toBe(false);
    if (!invalidRunLimit.ok) {
      expect(invalidRunLimit.error_code).toBe('invalid_budget_per_run_total_tokens');
    }

    config.budget.per_run_total_tokens = 1000;
    config.budget.warning_threshold_ratio = 1.5;
    const invalidThreshold = validator.validate(config);
    expect(invalidThreshold.ok).toBe(false);
    if (!invalidThreshold.ok) {
      expect(invalidThreshold.error_code).toBe('invalid_budget_warning_threshold_ratio');
    }
  });

  it('rejects invalid resolved codex reasoning effort', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.codex.effective_reasoning_effort = 'maximum' as 'medium';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_codex_reasoning_effort');
    }
  });

  it('rejects oversized codex extra flags', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.codex.effective_extra_flags = Array.from({ length: 33 }, (_, index) => `--flag-${index}`);

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_codex_extra_flags');
    }
  });

  it('blocks dispatch but allows reconciliation on failed preflight', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.codex.command = '';

    const outcome = validator.evaluateDispatchPreflight(config);
    expect(outcome.dispatch_allowed).toBe(false);
    expect(outcome.reconciliation_allowed).toBe(true);
    expect(outcome.validation.ok).toBe(false);
  });

  it('rejects unsupported codex approval policy values', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.codex.approval_policy = 'always';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_codex_approval_policy');
    }
  });

  it('rejects worktree provisioner when sandbox is not danger-full-access', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.workspace.provisioner.type = 'worktree';
    config.workspace.provisioner.repo_root = '/tmp/symphony';
    config.codex.thread_sandbox = 'workspace-write';
    config.codex.turn_sandbox_policy = 'workspace-write';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_worktree_sandbox_policy');
    }
  });

  it('accepts worktree provisioner with danger-full-access sandbox', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.workspace.provisioner.type = 'worktree';
    config.workspace.provisioner.repo_root = '/tmp/symphony';
    config.codex.thread_sandbox = 'danger-full-access';
    config.codex.turn_sandbox_policy = 'danger-full-access';

    expect(validator.validate(config)).toEqual({ ok: true, at: expect.any(String) });
  });

  it('rejects non-positive worker max_concurrent_agents_per_host when provided', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.worker = {
      ssh_hosts: ['build-1'],
      max_concurrent_agents_per_host: 0
    };

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_worker_max_concurrent_agents_per_host');
    }
  });

  it('rejects non-positive polling.interval_ms', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.polling.interval_ms = 0;

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_polling_interval_ms');
    }
  });

  it('rejects non-positive hooks.timeout_ms when provided', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.hooks.timeout_ms = 0;

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_hooks_timeout_ms');
    }
  });

  it('rejects unsupported validation.ui_evidence_profile', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.validation = { ui_evidence_profile: 'enforced' };

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_validation_ui_evidence_profile');
    }
  });

  it('rejects non-positive agent.max_concurrent_agents', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.agent.max_concurrent_agents = 0;

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_agent_max_concurrent_agents');
    }
  });

  it('rejects non-positive agent.max_turns', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.agent.max_turns = 0;

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_agent_max_turns');
    }
  });

  it('rejects non-positive agent.max_retry_backoff_ms', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.agent.max_retry_backoff_ms = 0;

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_agent_max_retry_backoff_ms');
    }
  });

  it('rejects invalid agent.max_concurrent_agents_by_state entries', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.agent.max_concurrent_agents_by_state = { todo: 0 };

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_agent_max_concurrent_agents_by_state');
    }
  });

  it('rejects non-positive codex.turn_timeout_ms', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.codex.turn_timeout_ms = 0;

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_codex_turn_timeout_ms');
    }
  });

  it('rejects non-positive codex.read_timeout_ms', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.codex.read_timeout_ms = 0;

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_codex_read_timeout_ms');
    }
  });

  it('rejects non-positive codex.stall_timeout_ms', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.codex.stall_timeout_ms = 0;

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_codex_stall_timeout_ms');
    }
  });

  it('rejects non-positive progress visibility thresholds', () => {
    const validator = new ConfigValidator();
    const heartbeatConfig = baseConfig();
    heartbeatConfig.codex.progress_heartbeat_only_warn_ms = 0;
    const heartbeatResult = validator.validate(heartbeatConfig);
    expect(heartbeatResult.ok).toBe(false);
    if (!heartbeatResult.ok) {
      expect(heartbeatResult.error_code).toBe('invalid_codex_progress_heartbeat_only_warn_ms');
    }

    const stalledConfig = baseConfig();
    stalledConfig.codex.progress_stalled_waiting_ms = 0;
    const stalledResult = validator.validate(stalledConfig);
    expect(stalledResult.ok).toBe(false);
    if (!stalledResult.ok) {
      expect(stalledResult.error_code).toBe('invalid_codex_progress_stalled_waiting_ms');
    }

    const opaqueHardTimeoutConfig = baseConfig();
    opaqueHardTimeoutConfig.codex.worker_opaque_activity_hard_timeout_ms = 0;
    const opaqueHardTimeoutResult = validator.validate(opaqueHardTimeoutConfig);
    expect(opaqueHardTimeoutResult.ok).toBe(false);
    if (!opaqueHardTimeoutResult.ok) {
      expect(opaqueHardTimeoutResult.error_code).toBe('invalid_codex_worker_opaque_activity_hard_timeout_ms');
    }
  });

  it('rejects non-positive logging.max_bytes', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.logging.max_bytes = 0;

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_logging_max_bytes');
    }
  });

  it('rejects invalid server.host values', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.server = {
      port: 3000,
      host: 'not a host'
    };

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_server_host');
    }
  });

  it('accepts DNS hostname syntax for server.host', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.server = {
      port: 3000,
      host: 'symphony.internal'
    };

    const result = validator.validate(config);
    expect(result.ok).toBe(true);
  });

  it('rejects non-positive logging.max_files', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.logging.max_files = 0;

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_logging_max_files');
    }
  });

  it('rejects unsupported workspace provisioner type', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.workspace.provisioner.type = 'custom';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_workspace_provisioner_type');
    }
  });

  it('rejects git-backed provisioners without repo_root', () => {
    const validator = new ConfigValidator();
    for (const provisionerType of ['worktree', 'clone'] as const) {
      const config = baseConfig();
      config.workspace.provisioner.type = provisionerType;
      delete config.workspace.provisioner.repo_root;

      const result = validator.validate(config);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe('invalid_workspace_provisioner_repo_root');
        expect(result.message).toContain(`workspace.provisioner.type=${provisionerType}`);
      }
    }
  });

  it('rejects worktree provisioner branch template without issue identifier token', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.workspace.provisioner.type = 'worktree';
    config.workspace.provisioner.repo_root = '/tmp/source-repo';
    config.workspace.provisioner.branch_template = 'feature/static';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_workspace_provisioner_branch_template');
    }
  });

  it('validates runtime update GitHub eligibility mode', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.runtime_update = {
      github_eligibility: {
        mode: 'trust_raw_git'
      }
    };

    expect(validator.validate(config)).toEqual({ ok: true, at: expect.any(String) });

    config.runtime_update.github_eligibility.mode = 'optimistic';
    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_runtime_update_github_eligibility_mode');
    }
  });

  it('rejects unsupported workspace.copy_ignored conflict_policy', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.workspace.copy_ignored.enabled = true;
    config.workspace.copy_ignored.conflict_policy = 'merge';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_workspace_copy_ignored_conflict_policy');
    }
  });

  it('rejects non-positive workspace.copy_ignored limits', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.workspace.copy_ignored.enabled = true;
    config.workspace.copy_ignored.max_files = 0;

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_workspace_copy_ignored_limits');
    }
  });
});
