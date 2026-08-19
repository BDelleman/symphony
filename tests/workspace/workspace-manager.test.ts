import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

import { WorkspaceError, WorkspaceManager } from '../../src/workspace';

const GIT_PREFLIGHT_INTEGRATION_TEST_TIMEOUT_MS = 30_000;

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'symphony-workspace-test-'));
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function fakeGit(params: { statusOutputs?: string[]; unmergedEntries?: string } = {}) {
  // Keep fake Git state inside each test so porcelain/status mutations cannot leak between tests.
  const statusOutputs = [...(params.statusOutputs ?? [])];
  let lastStatus = statusOutputs.at(-1) ?? '';
  return vi.fn(async ({ args }: { cwd: string; args: string[] }) => {
    if (args[0] === 'status') {
      const nextStatus = statusOutputs.shift();
      if (nextStatus !== undefined) {
        lastStatus = nextStatus;
      }
      return nextStatus ?? lastStatus;
    }
    if (args[0] === 'rev-parse' && args[1] === '--git-path') {
      return `.git/${args[2]}\n`;
    }
    if (args[0] === 'ls-files' && args[1] === '-u') {
      return params.unmergedEntries ?? '';
    }
    return '';
  });
}

describe('WorkspaceManager', () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map(async (targetPath) => {
        await fs.rm(targetPath, { recursive: true, force: true });
      })
    );
  });

  it('[SPEC-9.1-1][SPEC-17.2-1] derives deterministic workspace key and path from issue identifier', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 }
    });

    expect(manager.deriveWorkspaceKey('ABC-123')).toBe('ABC-123');
    expect(manager.deriveWorkspaceKey('a/b:c?d')).toBe('a_b_c_d');

    const workspace = await manager.ensureWorkspace('a/b:c?d');
    expect(workspace.workspace_key).toBe('a_b_c_d');
    expect(workspace.path).toBe(path.resolve(root, 'a_b_c_d'));
  });

  it('creates missing workspace and reuses existing directory with created_now flag', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 }
    });

    const first = await manager.ensureWorkspace('ABC-1');
    const second = await manager.ensureWorkspace('ABC-1');

    expect(first.created_now).toBe(true);
    expect(second.created_now).toBe(false);
    expect(first.path).toBe(second.path);
  });

  it('replaces non-allowed identifier characters with underscore', () => {
    const manager = new WorkspaceManager({
      root: '/tmp/symphony',
      hooks: { timeout_ms: 1000 }
    });

    expect(manager.deriveWorkspaceKey('../ABC/é$*')).toBe('.._ABC____');
  });

  it('fails fast when workspace path collides with non-directory entry', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    await fs.writeFile(path.join(root, 'ABC-1'), 'collision');

    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 }
    });

    await expect(manager.ensureWorkspace('ABC-1')).rejects.toMatchObject({
      code: 'workspace_non_directory_collision'
    });
  });

  it('enforces root containment and cwd equality launch invariants', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 }
    });

    expect(() =>
      manager.assertLaunchSafety({
        workspacePath: path.resolve(root, '..', 'escape'),
        cwd: path.resolve(root, '..', 'escape')
      })
    ).toThrowError(WorkspaceError);

    expect(() =>
      manager.assertLaunchSafety({
        workspacePath: path.resolve(root, 'ABC-1'),
        cwd: path.resolve(root, 'ABC-2')
      })
    ).toThrowError(WorkspaceError);
  });

  it('removes temporary artifacts during prepareAttempt', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 }
    });

    const workspace = await manager.ensureWorkspace('ABC-1');
    await fs.mkdir(path.join(workspace.path, 'tmp'), { recursive: true });
    await fs.mkdir(path.join(workspace.path, '.elixir_ls'), { recursive: true });

    await manager.prepareAttempt(workspace.path);

    expect(await exists(path.join(workspace.path, 'tmp'))).toBe(false);
    expect(await exists(path.join(workspace.path, '.elixir_ls'))).toBe(false);
  });

  it('fails closed before hooks when a managed workspace contains credential material', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const runShell = vi.fn(async () => ({ timedOut: false }));
    const manager = new WorkspaceManager({
      root,
      hooks: { before_run: 'echo unsafe', timeout_ms: 1000 },
      runShell
    });
    const workspace = await manager.ensureWorkspace('ABC-SENSITIVE');
    await fs.writeFile(path.join(workspace.path, '.env.local'), 'TOKEN=must-not-leak\n', 'utf8');

    await expect(manager.prepareAttempt(workspace.path)).rejects.toMatchObject({
      code: 'workspace_sensitive_file_detected',
      message: expect.stringContaining('"category":"dotenv"')
    });
    expect(runShell).not.toHaveBeenCalled();
  });

  it('rejects untracked dotenv templates and real dotenv files', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 }
    });
    const workspace = await manager.ensureWorkspace('ABC-ENV-TEMPLATE');
    await fs.writeFile(path.join(workspace.path, '.env.example'), 'TOKEN=replace-me\n', 'utf8');

    await expect(manager.prepareAttempt(workspace.path)).rejects.toMatchObject({
      code: 'workspace_sensitive_file_detected',
      message: expect.stringContaining('"category":"dotenv"')
    });

    await fs.rm(path.join(workspace.path, '.env.example'));
    await fs.writeFile(path.join(workspace.path, '.env'), 'TOKEN=must-not-leak\n', 'utf8');
    await expect(manager.prepareAttempt(workspace.path)).rejects.toMatchObject({
      code: 'workspace_sensitive_file_detected',
      message: expect.stringContaining('"category":"dotenv"')
    });
  });

  it('fails closed when a trusted before-run hook creates credential material', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: { before_run: 'prepare', timeout_ms: 1000 },
      runShell: async ({ cwd }) => {
        await fs.writeFile(path.join(cwd, '.npmrc'), '//registry.npmjs.org/:_authToken=must-not-leak\n', 'utf8');
        return { timedOut: false };
      }
    });
    const workspace = await manager.ensureWorkspace('ABC-HOOK-SENSITIVE');

    await expect(manager.prepareAttempt(workspace.path)).rejects.toMatchObject({
      code: 'workspace_sensitive_file_detected',
      message: expect.stringContaining('"category":"package_manager_auth"')
    });
  });

  it('preflight removes staged ignored artifacts and sentinel-only MM drift', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const preflightResults: Array<{ status: string; cleaned_files: Array<{ path: string; action: string }> }> = [];
    const runGit = fakeGit({
      statusOutputs: [
        'A  output/playwright/demo.webm\nMM src/api/dashboard-assets.ts\n',
        ' M src/api/dashboard-assets.ts\n'
      ]
    });
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 },
      runGit,
      onPreflightResult: (result) => {
        preflightResults.push(result);
      }
    });

    const workspace = await manager.ensureWorkspace('ABC-1');
    await fs.mkdir(path.join(workspace.path, 'src/api'), { recursive: true });
    await fs.writeFile(path.join(workspace.path, 'src/api/dashboard-assets.ts'), 'export const a = 1;\n', 'utf8');
    await fs.mkdir(path.join(workspace.path, 'output/playwright'), { recursive: true });
    await fs.writeFile(path.join(workspace.path, 'output/playwright/demo.webm'), 'artifact', 'utf8');

    await manager.prepareAttempt(workspace.path);

    await expect(exists(path.join(workspace.path, 'output/playwright/demo.webm'))).resolves.toBe(false);
    expect(preflightResults.some((entry) => entry.status === 'cleaned')).toBe(true);
    expect(runGit).toHaveBeenCalledWith({
      cwd: workspace.path,
      args: ['restore', '--staged', '--', 'output/playwright/demo.webm']
    });
    expect(runGit).toHaveBeenCalledWith({
      cwd: workspace.path,
      args: ['rm', '--cached', '-f', '--ignore-unmatch', '--', 'output/playwright/demo.webm']
    });
  }, GIT_PREFLIGHT_INTEGRATION_TEST_TIMEOUT_MS);

  it('preflight blocks when tracked output/playwright artifacts remain', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const runGit = fakeGit({
      statusOutputs: [' M output/playwright/demo.webm\n', ' M output/playwright/demo.webm\n']
    });
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 },
      runGit
    });
    const workspace = await manager.ensureWorkspace('ABC-2');
    await fs.mkdir(path.join(workspace.path, 'output/playwright'), { recursive: true });
    await fs.writeFile(path.join(workspace.path, 'output/playwright/demo.webm'), 'stub-video\n', 'utf8');

    await expect(manager.prepareAttempt(workspace.path)).rejects.toMatchObject({
      code: 'workspace_unprovisioned_conflict',
      message: expect.stringContaining('workspace_preflight_conflict:')
    });
  });

  it('preflight allows explicit attempt residue for non-ephemeral dirty files and reports untracked files as unknown', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const preflightResults: Array<{
      status: string;
      conflict_files: Array<{ path: string; status: string; classification?: string }>;
    }> = [];
    const runGit = fakeGit({
      statusOutputs: [' D tests/orchestrator/core.test.ts\n?? tests/orchestrator/core-dispatch.test.ts\n']
    });
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 },
      runGit,
      onPreflightResult: (result) => {
        preflightResults.push(result);
      }
    });
    const workspace = await manager.ensureWorkspace('ABC-RESIDUE');

    await manager.prepareAttempt(workspace.path, { allow_attempt_residue: true });

    expect(preflightResults).toEqual([
      expect.objectContaining({
        status: 'attempt_residue_recoverable',
        conflict_files: expect.arrayContaining([
          { path: 'tests/orchestrator/core.test.ts', status: 'unstaged', classification: 'unknown_non_ephemeral' },
          { path: 'tests/orchestrator/core-dispatch.test.ts', status: 'unknown', classification: 'unknown_non_ephemeral' }
        ])
      })
    ]);
  });

  it('preflight does not allow attempt residue while a git merge is active', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const runGit = fakeGit({
      statusOutputs: [' M README.md\n']
    });
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 },
      runGit
    });
    const workspace = await manager.ensureWorkspace('ABC-MERGE');
    await fs.mkdir(path.join(workspace.path, '.git'), { recursive: true });
    await fs.writeFile(path.join(workspace.path, '.git/MERGE_HEAD'), '0000000000000000000000000000000000000000\n', 'utf8');

    await expect(manager.prepareAttempt(workspace.path, { allow_attempt_residue: true })).rejects.toMatchObject({
      code: 'workspace_unprovisioned_conflict',
      message: expect.stringContaining('workspace contains non-ephemeral dirty files after preflight cleanup')
    });
  });

  it.each(['REBASE_HEAD', 'AUTO_MERGE', 'sequencer'])(
    'preflight blocks attempt residue for git operation sentinel %s',
    async (sentinelName) => {
      const root = await makeTempRoot();
      cleanupPaths.push(root);
      const runGit = fakeGit({
        statusOutputs: [' M README.md\n']
      });
      const manager = new WorkspaceManager({
        root,
        hooks: { timeout_ms: 1000 },
        runGit
      });
      const workspace = await manager.ensureWorkspace(`ABC-${sentinelName}`);
      const absoluteSentinelPath = path.join(workspace.path, '.git', sentinelName);
      await fs.mkdir(path.dirname(absoluteSentinelPath), { recursive: true });
      if (sentinelName === 'sequencer') {
        await fs.mkdir(absoluteSentinelPath, { recursive: true });
      } else {
        await fs.writeFile(absoluteSentinelPath, '0000000000000000000000000000000000000000\n', 'utf8');
      }

      await expect(manager.prepareAttempt(workspace.path, { allow_attempt_residue: true })).rejects.toMatchObject({
        code: 'workspace_unprovisioned_conflict',
        message: expect.stringContaining('workspace contains non-ephemeral dirty files after preflight cleanup')
      });
    },
    30_000
  );

  it('preflight blocks attempt residue for unmerged index entries', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 }
    });
    const workspace = await manager.ensureWorkspace('ABC-UNMERGED');
    git(workspace.path, ['init']);
    git(workspace.path, ['config', 'user.email', 'test@example.com']);
    git(workspace.path, ['config', 'user.name', 'Workspace Test']);
    await fs.writeFile(path.join(workspace.path, 'README.md'), 'base\n', 'utf8');
    git(workspace.path, ['add', '.']);
    git(workspace.path, ['commit', '-m', 'initial']);
    git(workspace.path, ['checkout', '-b', 'left']);
    await fs.writeFile(path.join(workspace.path, 'README.md'), 'left\n', 'utf8');
    git(workspace.path, ['commit', '-am', 'left']);
    git(workspace.path, ['checkout', '-b', 'right', 'HEAD~1']);
    await fs.writeFile(path.join(workspace.path, 'README.md'), 'right\n', 'utf8');
    git(workspace.path, ['commit', '-am', 'right']);
    const merge = spawnSync('git', ['merge', 'left'], { cwd: workspace.path, encoding: 'utf8' });
    expect(merge.status).not.toBe(0);

    await expect(manager.prepareAttempt(workspace.path, { allow_attempt_residue: true })).rejects.toMatchObject({
      code: 'workspace_unprovisioned_conflict',
      message: expect.stringContaining('workspace contains non-ephemeral dirty files after preflight cleanup')
    });
  }, 30_000);

  it('preflight no-ops on clean workspace', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const preflightResults: Array<{ status: string }> = [];
    const runGit = fakeGit({ statusOutputs: [''] });
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 },
      runGit,
      onPreflightResult: (result) => {
        preflightResults.push(result);
      }
    });
    const workspace = await manager.ensureWorkspace('ABC-3');

    await manager.prepareAttempt(workspace.path);
    expect(preflightResults).toEqual([]);
  });

  it('enforces per-hook failure and timeout semantics', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const calls: string[] = [];
    const manager = new WorkspaceManager({
      root,
      hooks: {
        after_create: 'create',
        before_run: 'before',
        after_run: 'after',
        before_remove: 'remove',
        timeout_ms: 1000
      },
      runShell: async ({ script }) => {
        calls.push(script);
        if (script === 'create') {
          return { timedOut: true, error: 'timeout' };
        }
        if (script === 'before') {
          return { timedOut: false, error: 'failed' };
        }
        return { timedOut: false };
      },
      probeTool: async () => true
    });

    await expect(manager.ensureWorkspace('ABC-1')).rejects.toMatchObject({ code: 'workspace_hook_timeout' });

    const manager2 = new WorkspaceManager({
      root,
      hooks: {
        before_run: 'before',
        after_run: 'after',
        before_remove: 'remove',
        timeout_ms: 1000
      },
      runShell: async ({ script }) => {
        if (script === 'before') {
          return { timedOut: false, error: 'failed' };
        }
        if (script === 'after') {
          return { timedOut: true, error: 'timeout' };
        }
        if (script === 'remove') {
          return { timedOut: true, error: 'timeout' };
        }
        return { timedOut: false };
      },
      probeTool: async () => true
    });

    const workspace = await manager2.ensureWorkspace('ABC-2');
    await expect(manager2.prepareAttempt(workspace.path)).rejects.toMatchObject({ code: 'workspace_hook_failed' });
    await expect(manager2.finalizeAttempt(workspace.path)).resolves.toBeUndefined();
    await expect(manager2.cleanupWorkspace('ABC-2')).resolves.toBe(true);

    expect(calls).toContain('create');
  });

  it('surfaces structured hook reason codes instead of raw stderr blobs', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: {
        after_create: 'echo create',
        timeout_ms: 1000
      },
      runShell: async () => ({
        timedOut: false,
        error: '{"action":"error","reason":"source and target resolve to the same repository"}'
      })
    });

    await expect(manager.ensureWorkspace('ABC-1')).rejects.toMatchObject({
      code: 'workspace_hook_failed',
      message: expect.stringContaining('source_and_target_resolve_to_the_same_repository')
    });
  });

  it('preflights finalization shell/tool availability and emits typed fallback reason codes', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const hookResults: Array<{
      fallback_reason_code?: string;
      fallback_mode?: string;
      status: string;
    }> = [];
    const runShell = vi.fn(async () => ({ timedOut: false }));

    const manager = new WorkspaceManager({
      root,
      hooks: {
        after_run: 'echo finalize',
        timeout_ms: 1000
      },
      runShell,
      probeTool: async ({ command }) => command !== 'gh',
      onHookResult: (result) => {
        hookResults.push({
          fallback_reason_code: result.fallback_reason_code,
          fallback_mode: result.fallback_mode,
          status: result.status
        });
      }
    });

    const workspace = await manager.ensureWorkspace('ABC-1');
    await expect(manager.finalizeAttempt(workspace.path)).resolves.toBeUndefined();

    expect(runShell).not.toHaveBeenCalled();
    expect(hookResults).toContainEqual({
      fallback_reason_code: 'tool_missing_gh',
      fallback_mode: 'mcp_github',
      status: 'failed'
    });
  });

  it('runs after_create hook only on new workspace creation', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const runShell = vi.fn(async () => ({ timedOut: false }));
    const manager = new WorkspaceManager({
      root,
      hooks: {
        after_create: 'echo create',
        timeout_ms: 1000
      },
      runShell
    });

    await manager.ensureWorkspace('ABC-1');
    await manager.ensureWorkspace('ABC-1');

    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it('runs before_remove only for existing workspace directories', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);

    const runShell = vi.fn(async () => ({ timedOut: false }));
    const manager = new WorkspaceManager({
      root,
      hooks: {
        before_remove: 'echo remove',
        timeout_ms: 1000
      },
      runShell
    });

    await expect(manager.cleanupWorkspace('MISSING-1')).resolves.toBe(true);
    expect(runShell).not.toHaveBeenCalled();

    const dirWorkspace = await manager.ensureWorkspace('ABC-1');
    await expect(manager.cleanupWorkspace('ABC-1')).resolves.toBe(true);
    expect(runShell).toHaveBeenCalledTimes(1);
    expect(runShell).toHaveBeenLastCalledWith({
      cwd: dirWorkspace.path,
      script: 'echo remove',
      timeoutMs: 1000
    });
  });

  it('provisions before after_create and tears down after before_remove', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);

    const callOrder: string[] = [];
    const manager = new WorkspaceManager({
      root,
      hooks: {
        after_create: 'echo create',
        before_remove: 'echo remove',
        timeout_ms: 1000
      },
      provisioner: {
        provision: async () => {
          callOrder.push('provision');
          return {
            status: 'provisioned',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-1',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'clean'
          };
        },
        teardown: async () => {
          callOrder.push('teardown');
          return {
            status: 'removed',
            provisioner_type: 'worktree'
          };
        }
      },
      runShell: async ({ script }) => {
        if (script === 'echo create') {
          callOrder.push('after_create');
        }
        if (script === 'echo remove') {
          callOrder.push('before_remove');
        }
        return { timedOut: false };
      }
    });

    const workspace = await manager.ensureWorkspace('ABC-1');
    expect(workspace.provisioner_type).toBe('worktree');
    expect(workspace.branch_name).toBe('feature/ABC-1');
    await expect(manager.cleanupWorkspace('ABC-1')).resolves.toBe(true);

    expect(callOrder).toEqual(['provision', 'after_create', 'before_remove', 'teardown']);
  });

  it('does not remove workspace directory when teardown result is kept', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 },
      provisioner: {
        provision: async () => ({ status: 'provisioned', provisioner_type: 'worktree' }),
        teardown: async () => ({ status: 'kept', provisioner_type: 'worktree' })
      }
    });

    const workspace = await manager.ensureWorkspace('ABC-KEEP');
    await expect(manager.cleanupWorkspace('ABC-KEEP')).resolves.toBe(true);
    await expect(exists(workspace.path)).resolves.toBe(true);
  });

  it('removes freshly created workspace dir when provisioning fails', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const onProvisionerResult = vi.fn();
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 },
      provisioner: {
        provision: async () => {
          throw new WorkspaceError('workspace_provision_failed', 'forced failure');
        },
        teardown: async () => ({ status: 'skipped', provisioner_type: 'worktree' })
      },
      onProvisionerResult
    });

    await expect(manager.ensureWorkspace('ABC-FAIL')).rejects.toMatchObject({
      code: 'workspace_provision_failed'
    });

    const workspacePath = path.join(root, 'ABC-FAIL');
    await expect(exists(workspacePath)).resolves.toBe(false);
    expect(onProvisionerResult).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'provision',
        identifier: 'ABC-FAIL',
        status: 'failed',
        cleanup_attempted: true,
        cleanup_succeeded: true
      })
    );
  });

  it('returns false for non-directory entry at cleanup path and skips before_remove', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);

    const runShell = vi.fn(async () => ({ timedOut: false }));
    const manager = new WorkspaceManager({
      root,
      hooks: {
        before_remove: 'echo remove',
        timeout_ms: 1000
      },
      runShell
    });

    await fs.writeFile(path.join(root, 'ABC-1'), 'collision');
    await expect(manager.cleanupWorkspace('ABC-1')).resolves.toBe(false);
    expect(runShell).not.toHaveBeenCalled();
  });
});
