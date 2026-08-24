import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ConfigResolver } from '../../src/workflow/resolver';
import type { WorkflowDefinition } from '../../src/workflow/types';

const baseWorkflow: WorkflowDefinition = {
  config: {},
  prompt_template: 'prompt'
};

describe('ConfigResolver', () => {
  it('applies defaults when optional fields are absent', () => {
    const resolver = new ConfigResolver({
      env: {},
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve(baseWorkflow);

    expect(config.polling.interval_ms).toBe(30000);
    expect(config.tracker.active_states).toEqual(['Todo', 'In Progress']);
    expect(config.tracker.handoff_states).toEqual([]);
    expect(config.tracker.fresh_dispatch_states).toEqual([]);
    expect(config.tracker.github_linking?.mode).toBe('off');
    expect(config.workspace.root).toBe(path.normalize('/home/tester/.symphony/system/workspaces'));
    expect(config.workspace.root_source).toBe('default');
    expect(config.workspace.provisioner).toEqual({
      type: 'none',
      base_ref: 'origin/main',
      branch_template: 'feature/{{ issue.identifier }}',
      teardown_mode: 'remove_worktree',
      allow_dirty_repo: false,
      fallback_to_clone_on_worktree_failure: false
    });
    expect(config.codex.command).toBe('codex app-server');
    expect(config.budget).toEqual({
      rolling_window_minutes: 1440,
      warning_threshold_ratio: 0.8,
      hard_limit_policy: 'block_requires_resume'
    });
    expect(config.persistence.enabled).toBe(true);
    expect(config.persistence.retention_days).toBe(14);
    expect(config.observability).toEqual({
      dashboard_enabled: true,
      refresh_ms: 4000,
      render_interval_ms: 1000,
      phase_markers_enabled: true,
      phase_timeline_limit: 30,
      phase_stale_warn_ms: 45000
    });
    expect(config.persistence.db_path).toBe(path.normalize('/home/tester/.symphony/system/runtime.sqlite'));
    expect(config.persistence.db_path_source).toBe('default');
    expect(config.logging.root).toBe(path.normalize('/home/tester/.symphony/system/logs'));
    expect(config.logging.root_source).toBe('default');
    expect(config.logging.max_bytes).toBe(10 * 1024 * 1024);
    expect(config.logging.max_files).toBe(5);
    expect(config.validation?.ui_evidence_profile).toBe('baseline');
    expect(config.runtime_update?.github_eligibility.mode).toBe('required');
    expect(config.review_approval).toBeUndefined();
  });

  it('resolves the fixed GitHub App review approval contract', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });
    const config = resolver.resolve({
      config: { review_approval: { provider: 'github_app', required: true } },
      prompt_template: 'prompt'
    });
    expect(config.review_approval).toEqual({ provider: 'github_app', required: true });
  });

  it('normalises the external reviewer contract and omits it when no bot is named', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });
    const config = resolver.resolve({
      config: {
        review_approval: {
          provider: 'github_app',
          required: true,
          external_review: { bot_login: 'chatgpt-codex-connector[bot]', unavailable_pattern: 'Usage Limits' }
        }
      },
      prompt_template: 'prompt'
    });
    expect(config.review_approval?.external_review).toEqual({
      bot_login: 'chatgpt-codex-connector',
      request_marker: '@codex review',
      unavailable_pattern: 'usage limits'
    });

    const withoutBot = resolver.resolve({
      config: { review_approval: { provider: 'github_app', required: true, external_review: { request_marker: '@codex review' } } },
      prompt_template: 'prompt'
    });
    expect(withoutBot.review_approval?.external_review).toBeUndefined();
  });

  it('resolves budget controls with defaults for optional policy fields', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        budget: {
          per_run_total_tokens: '10000',
          per_issue_rolling_tokens: 25000,
          warning_threshold_ratio: '0.75',
          hard_limit_policy: 'terminate_attempt'
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.budget).toEqual({
      per_run_total_tokens: 10000,
      per_issue_rolling_tokens: 25000,
      rolling_window_minutes: 1440,
      warning_threshold_ratio: 0.75,
      hard_limit_policy: 'terminate_attempt'
    });
  });

  it('resolves $VAR for tracker.api_key and workspace.root', () => {
    const resolver = new ConfigResolver({
      env: {
        LINEAR_API_KEY: 'secret-token',
        WORKSPACE_ROOT: '/srv/workspaces'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve({
      config: {
        tracker: { kind: 'linear', api_key: '$LINEAR_API_KEY', project_slug: 'ABC' },
        workspace: { root: '$WORKSPACE_ROOT' }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.api_key).toBe('secret-token');
    expect(config.workspace.root).toBe('/srv/workspaces');
    expect(config.workspace.root_source).toBe('workflow');
  });

  it('resolves $VAR for tracker.project_slug', () => {
    const resolver = new ConfigResolver({
      env: {
        LINEAR_PROJECT_SLUG: 'SYMPHONY'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve({
      config: {
        tracker: { kind: 'linear', api_key: 'token', project_slug: '$LINEAR_PROJECT_SLUG' }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.project_slug).toBe('SYMPHONY');
  });

  it('uses github defaults for endpoint and token fallback', () => {
    const resolver = new ConfigResolver({
      env: {
        GITHUB_TOKEN: 'gh-token'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve({
      config: {
        tracker: {
          kind: 'github',
          owner: 'nielsgl',
          repo: 'symphony'
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.endpoint).toBe('https://api.github.com/graphql');
    expect(config.tracker.api_key).toBe('gh-token');
    expect(config.tracker.owner).toBe('nielsgl');
    expect(config.tracker.repo).toBe('symphony');
    expect(config.tracker.active_states).toEqual(['Open']);
    expect(config.tracker.terminal_states).toEqual(['Closed']);
    expect(config.tracker.github_linking?.mode).toBe('off');
  });

  it('resolves tracker.github_linking.mode from workflow config', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        tracker: {
          kind: 'linear',
          api_key: 'token',
          project_slug: 'ABC',
          github_linking: { mode: 'required' }
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.github_linking?.mode).toBe('required');
  });

  it('resolves tracker handoff and fresh dispatch states from workflow config', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        tracker: {
          kind: 'linear',
          api_key: 'token',
          project_slug: 'ABC',
          active_states: ['Todo', 'In Progress', 'Agent Review', 'Merging', 'Rework'],
          handoff_states: ['Agent Review', 'Human Review'],
          fresh_dispatch_states: ['Agent Review']
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.handoff_states).toEqual(['Agent Review', 'Human Review']);
    expect(config.tracker.fresh_dispatch_states).toEqual(['Agent Review']);
  });

  it('rejects malformed tracker handoff and fresh dispatch state lists during resolution', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    expect(() =>
      resolver.resolve({
        config: {
          tracker: {
            kind: 'linear',
            api_key: 'token',
            project_slug: 'ABC',
            handoff_states: 'Agent Review'
          }
        },
        prompt_template: 'prompt'
      })
    ).toThrow('tracker.handoff_states must be a string array');

    expect(() =>
      resolver.resolve({
        config: {
          tracker: {
            kind: 'linear',
            api_key: 'token',
            project_slug: 'ABC',
            fresh_dispatch_states: ['Agent Review', 12]
          }
        },
        prompt_template: 'prompt'
      })
    ).toThrow('tracker.fresh_dispatch_states must be a string array of non-empty state names');
  });

  it('uses memory defaults without tracker token fallback', () => {
    const resolver = new ConfigResolver({
      env: {
        LINEAR_API_KEY: 'linear-token',
        GITHUB_TOKEN: 'gh-token'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve({
      config: {
        tracker: {
          kind: 'memory'
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.endpoint).toBe('memory://local');
    expect(config.tracker.api_key).toBe('');
    expect(config.tracker.active_states).toEqual(['Todo', 'In Progress']);
  });

  it('treats empty resolved $VAR as missing value', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        tracker: { kind: 'linear', api_key: '$LINEAR_API_KEY', project_slug: 'ABC' }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.api_key).toBe('');
  });

  it('resolves optional tracker.assignee from workflow config', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        tracker: {
          kind: 'linear',
          api_key: 'token',
          project_slug: 'ABC',
          assignee: 'me'
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.assignee).toBe('me');
  });

  it('expands ~ for path-intended fields', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        workspace: { root: '~/sym/workspaces' }
      },
      prompt_template: 'prompt'
    });

    expect(config.workspace.root).toBe(path.normalize('/home/tester/sym/workspaces'));
    expect(config.workspace.root_source).toBe('workflow');
  });

  it('preserves bare path strings without separators', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        workspace: { root: 'relativeRoot' }
      },
      prompt_template: 'prompt'
    });

    expect(config.workspace.root).toBe('relativeRoot');
    expect(config.workspace.root_source).toBe('workflow');
  });

  it('resolves relative workspace.root against workflow directory when workflow path is provided', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve(
      {
        config: {
          workspace: { root: './.symphony/workspaces' }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.workspace.root).toBe(path.normalize('/workspace/projects/todo-app/.symphony/workspaces'));
    expect(config.workspace.root_source).toBe('workflow');
  });

  it('resolves relative workspace.provisioner.repo_root against workflow directory', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve(
      {
        config: {
          workspace: {
            provisioner: {
              type: 'worktree',
              repo_root: '../app',
              base_ref: 'origin/main',
              branch_template: 'feature/{{ issue.identifier }}',
              teardown_mode: 'remove_worktree'
            }
          }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.workspace.provisioner).toMatchObject({
      type: 'worktree',
      repo_root: path.normalize('/workspace/projects/app'),
      base_ref: 'origin/main',
      branch_template: 'feature/{{ issue.identifier }}',
      teardown_mode: 'remove_worktree'
    });
  });

  it('resolves workspace.provisioner.repo_root dot path against workflow directory', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve(
      {
        config: {
          workspace: {
            provisioner: {
              type: 'worktree',
              repo_root: '.',
              base_ref: 'origin/main',
              branch_template: 'feature/{{ issue.identifier }}',
              teardown_mode: 'remove_worktree'
            }
          }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.workspace.provisioner).toMatchObject({
      type: 'worktree',
      repo_root: path.normalize('/workspace/projects/todo-app'),
      base_ref: 'origin/main',
      branch_template: 'feature/{{ issue.identifier }}',
      teardown_mode: 'remove_worktree'
    });
  });

  it('resolves runtime update GitHub eligibility mode from workflow config', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        runtime_update: {
          github_eligibility: {
            mode: 'allow_absent_checks'
          }
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.runtime_update?.github_eligibility.mode).toBe('allow_absent_checks');
  });

  it('normalizes per-state concurrency map and preserves invalid entries for validation', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        agent: {
          max_concurrent_agents_by_state: {
            'In Progress': '3',
            Todo: 0,
            Blocked: -1,
            Review: 'abc'
          }
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.agent.max_concurrent_agents_by_state).toEqual({
      'in progress': 3,
      todo: 0,
      blocked: -1,
      review: Number.NaN
    });
  });

  it('preserves codex.command as a shell command string', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        codex: { command: 'codex app-server --profile danger-full-access' }
      },
      prompt_template: 'prompt'
    });

    expect(config.codex.command).toBe('codex app-server --profile danger-full-access');
    expect(config.codex.codex_resolution_mode).toBe('legacy');
    expect(config.codex.effective_codex_home).toBe(path.normalize('/home/tester/.codex'));
  });

  it('resolves typed codex fields with workflow over environment precedence', () => {
    const resolver = new ConfigResolver({
      env: {
        SYMPHONY_CODEX_HOME: '/env/codex',
        SYMPHONY_CODEX_MODEL: 'env-model',
        SYMPHONY_CODEX_REASONING: 'low',
        SYMPHONY_CODEX_FLAGS: '["--env-flag"]'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve({
      config: {
        codex: {
          home: '$HOME/custom-codex',
          model: 'workflow-model',
          reasoning_effort: 'xhigh',
          extra_flags: ['--config', 'shell_environment_policy.inherit=all']
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.codex.codex_resolution_mode).toBe('typed');
    expect(config.codex.effective_codex_home).toBe(path.normalize('/home/tester/custom-codex'));
    expect(config.codex.effective_codex_model).toBe('workflow-model');
    expect(config.codex.effective_reasoning_effort).toBe('xhigh');
    expect(config.codex.effective_extra_flags).toEqual(['--config', 'shell_environment_policy.inherit=all']);
    expect(config.codex.effective_extra_flags_count).toBe(2);
  });

  it('uses environment overrides before defaults for typed codex fields', () => {
    const resolver = new ConfigResolver({
      env: {
        SYMPHONY_CODEX_HOME: '~/env-codex',
        SYMPHONY_CODEX_MODEL: 'env-model',
        SYMPHONY_CODEX_REASONING: 'medium',
        SYMPHONY_CODEX_FLAGS: '["--config","sandbox_workspace_write.network_access=true"]'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve({ config: {}, prompt_template: 'prompt' });

    expect(config.codex.codex_resolution_mode).toBe('typed');
    expect(config.codex.effective_codex_home).toBe(path.normalize('/home/tester/env-codex'));
    expect(config.codex.effective_codex_model).toBe('env-model');
    expect(config.codex.effective_reasoning_effort).toBe('medium');
    expect(config.codex.effective_extra_flags).toEqual(['--config', 'sandbox_workspace_write.network_access=true']);
  });

  it('rejects non-JSON SYMPHONY_CODEX_FLAGS values', () => {
    const resolver = new ConfigResolver({
      env: {
        SYMPHONY_CODEX_FLAGS: '--config sandbox_workspace_write.network_access=true'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    expect(() => resolver.resolve({ config: {}, prompt_template: 'prompt' })).toThrow(
      'SYMPHONY_CODEX_FLAGS must be a JSON string array'
    );
  });

  it('does not interpolate arbitrary environment variables in codex.home', () => {
    const resolver = new ConfigResolver({
      env: {
        TMPDIR: '/tmp/secret'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve({
      config: {
        codex: { home: '$TMPDIR/codex' }
      },
      prompt_template: 'prompt'
    });

    expect(config.codex.effective_codex_home).toBe('$TMPDIR/codex');
  });

  it('reports mixed mode when legacy command and typed codex fields are both set', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        codex: {
          command: 'CODEX_HOME="$HOME/.codex" codex --config model="old" app-server',
          model: 'typed-model'
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.codex.codex_resolution_mode).toBe('mixed');
    expect(config.codex.command).toContain('CODEX_HOME');
    expect(config.codex.effective_codex_model).toBe('typed-model');
  });

  it('rejects invalid typed codex field shapes during resolution', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    expect(() =>
      resolver.resolve({
        config: {
          codex: {
            reasoning_effort: 'maximum'
          }
        },
        prompt_template: 'prompt'
      })
    ).toThrow('codex.reasoning_effort must be one of: low, medium, high, xhigh');

    expect(() =>
      resolver.resolve({
        config: {
          codex: {
            extra_flags: '--config model="bad"'
          }
        },
        prompt_template: 'prompt'
      })
    ).toThrow('codex.extra_flags must be a string array');
  });

  it('preserves configured hooks timeout when provided for strict validation', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        hooks: { timeout_ms: 0 }
      },
      prompt_template: 'prompt'
    });

    expect(config.hooks.timeout_ms).toBe(0);
  });

  it('resolves workspace.copy_ignored defaults and include path', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve(
      {
        config: {
          workspace: {
            copy_ignored: {
              enabled: true
            }
          }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.workspace.copy_ignored).toMatchObject({
      enabled: true,
      include_file: path.normalize('/workspace/projects/todo-app/.worktreeinclude'),
      from: 'primary_worktree',
      conflict_policy: 'skip',
      require_gitignored: true
    });
  });

  it('rejects workspace.copy_ignored.include_file outside workflow directory', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    expect(() =>
      resolver.resolve(
        {
          config: {
            workspace: {
              copy_ignored: {
                enabled: true,
                include_file: '../outside/.worktreeinclude'
              }
            }
          },
          prompt_template: 'prompt'
        },
        { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
      )
    ).toThrow('workspace.copy_ignored.include_file must be contained in the workflow directory');
  });

  it('keeps default numeric values when optional fields are missing', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {},
      prompt_template: 'prompt'
    });

    expect(config.polling.interval_ms).toBe(30000);
    expect(config.hooks.timeout_ms).toBe(60000);
    expect(config.agent.max_concurrent_agents).toBe(10);
    expect(config.agent.max_turns).toBe(20);
    expect(config.agent.max_retry_backoff_ms).toBe(300000);
    expect(config.agent.dispatch_backpressure).toEqual({
      enabled: true,
      retry_delay_ms: 30000,
      min_running_agents: 1,
      control_plane_health: 'degraded',
      control_plane_stale_after_ms: 60000
    });
    expect(config.codex.turn_timeout_ms).toBe(3600000);
    expect(config.codex.read_timeout_ms).toBe(5000);
    expect(config.codex.stall_timeout_ms).toBe(300000);
    expect(config.codex.progress_heartbeat_only_warn_ms).toBe(120000);
    expect(config.codex.progress_stalled_waiting_ms).toBe(300000);
    expect(config.codex.worker_opaque_activity_hard_timeout_ms).toBe(1800000);
  });

  it('resolves progress visibility threshold overrides', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        codex: {
          progress_heartbeat_only_warn_ms: 1500,
          progress_stalled_waiting_ms: 4500,
          worker_opaque_activity_hard_timeout_ms: 9000
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.codex.progress_heartbeat_only_warn_ms).toBe(1500);
    expect(config.codex.progress_stalled_waiting_ms).toBe(4500);
    expect(config.codex.worker_opaque_activity_hard_timeout_ms).toBe(9000);
  });

  it('preserves invalid configured numeric values for fail-fast validation', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        polling: { interval_ms: 'abc' },
        hooks: { timeout_ms: 'abc' }
      },
      prompt_template: 'prompt'
    });

    expect(Number.isNaN(config.polling.interval_ms)).toBe(true);
    expect(Number.isNaN(config.hooks.timeout_ms)).toBe(true);
  });

  it('resolves codex profile overrides and persistence path', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        codex: {
          security_profile: 'balanced',
          approval_policy: 'on-request',
          thread_sandbox: 'workspace-write',
          turn_sandbox_policy: 'workspace',
          user_input_policy: 'fail_attempt'
        },
        persistence: {
          enabled: true,
          db_path: '~/symphony/runtime.sqlite',
          retention_days: 30
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.codex.security_profile).toBe('balanced');
    expect(config.codex.approval_policy).toBe('on-request');
    expect(config.persistence.db_path).toBe(path.normalize('/home/tester/symphony/runtime.sqlite'));
    expect(config.persistence.db_path_source).toBe('workflow');
    expect(config.persistence.retention_days).toBe(30);
  });

  it('defaults runtime-owned paths under the workflow system state root when workflow path is provided', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve(
      {
        config: {},
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.workspace.root).toBe(path.normalize('/workspace/projects/todo-app/.symphony/system/workspaces'));
    expect(config.workspace.root_source).toBe('default');
    expect(config.persistence.db_path).toBe(path.normalize('/workspace/projects/todo-app/.symphony/system/runtime.sqlite'));
    expect(config.persistence.db_path_source).toBe('default');
    expect(config.logging.root).toBe(path.normalize('/workspace/projects/todo-app/.symphony/system/logs'));
    expect(config.logging.root_source).toBe('default');
  });

  it('resolves explicit relative persistence path overrides from the workflow directory', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve(
      {
        config: {
          persistence: { db_path: '.symphony/system/runtime.sqlite' }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.persistence.db_path).toBe(path.normalize('/workspace/projects/todo-app/.symphony/system/runtime.sqlite'));
    expect(config.persistence.db_path_source).toBe('workflow');
  });

  it('preserves explicit absolute and home-expanded persistence path overrides', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const absoluteConfig = resolver.resolve(
      {
        config: {
          persistence: { db_path: '/srv/runtime.sqlite' }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );
    const homeConfig = resolver.resolve(
      {
        config: {
          persistence: { db_path: '~/runtime.sqlite' }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(absoluteConfig.persistence.db_path).toBe('/srv/runtime.sqlite');
    expect(absoluteConfig.persistence.db_path_source).toBe('workflow');
    expect(homeConfig.persistence.db_path).toBe(path.normalize('/home/tester/runtime.sqlite'));
    expect(homeConfig.persistence.db_path_source).toBe('workflow');
  });

  it('preserves explicit workflow path overrides over system state defaults', () => {
    const resolver = new ConfigResolver({
      env: {
        SYMPHONY_WORKSPACE_ROOT: '/srv/workspaces',
        SYMPHONY_LOG_ROOT: '/srv/logs',
        SYMPHONY_DB_PATH: '/srv/runtime.sqlite'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve(
      {
        config: {
          workspace: { root: '$SYMPHONY_WORKSPACE_ROOT' },
          logging: { root: '$SYMPHONY_LOG_ROOT' },
          persistence: { db_path: '$SYMPHONY_DB_PATH' }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.workspace.root).toBe('/srv/workspaces');
    expect(config.workspace.root_source).toBe('workflow');
    expect(config.logging.root).toBe('/srv/logs');
    expect(config.logging.root_source).toBe('workflow');
    expect(config.persistence.db_path).toBe('/srv/runtime.sqlite');
    expect(config.persistence.db_path_source).toBe('workflow');
  });

  it('resolves optional server.host with server.port', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });
    const config = resolver.resolve({
      config: {
        server: {
          port: 3000,
          host: '0.0.0.0'
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.server).toEqual({
      port: 3000,
      host: '0.0.0.0'
    });
  });

  it('resolves optional logging.root from workflow config', () => {
    const resolver = new ConfigResolver({
      env: {
        SYMPHONY_LOG_ROOT: '/var/log/symphony'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve(
      {
        config: {
          logging: {
            root: '$SYMPHONY_LOG_ROOT'
          }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.logging.root).toBe('/var/log/symphony');
    expect(config.logging.root_source).toBe('workflow');
  });

  it('resolves observability dashboard knobs with safe minimums', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });
    const config = resolver.resolve({
      config: {
        observability: {
          dashboard_enabled: false,
          refresh_ms: 100,
          render_interval_ms: 50
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.observability).toEqual({
      dashboard_enabled: false,
      refresh_ms: 500,
      render_interval_ms: 250,
      phase_markers_enabled: true,
      phase_timeline_limit: 30,
      phase_stale_warn_ms: 45000
    });
  });

  it('resolves optional logging.max_bytes and logging.max_files from workflow config', () => {
    const resolver = new ConfigResolver({
      env: {},
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve(
      {
        config: {
          logging: {
            max_bytes: 2097152,
            max_files: 7
          }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.logging.max_bytes).toBe(2097152);
    expect(config.logging.max_files).toBe(7);
  });

  it('parses optional worker extension fields', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        worker: {
          ssh_hosts: [' build-1 ', '', 'build-2'],
          max_concurrent_agents_per_host: '2'
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.worker).toEqual({
      ssh_hosts: ['build-1', 'build-2'],
      max_concurrent_agents_per_host: 2
    });
  });

  it('resolves validation.ui_evidence_profile from workflow config', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        validation: {
          ui_evidence_profile: 'strict'
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.validation?.ui_evidence_profile).toBe('strict');
  });
});
