import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { WorkspaceError } from './errors';
import type {
  WorkspaceProvisionContext,
  WorkspaceProvisionResult,
  WorkspaceProvisioner,
  WorkspaceTeardownContext,
  WorkspaceTeardownResult
} from './types';

type RunGit = (params: { cwd: string; args: string[] }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
const PROVISION_SENTINEL_NAME = '.symphony-provision.json';

async function defaultRunGit(params: { cwd: string; args: string[] }): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', params.args, {
      cwd: params.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      resolve({ ok: false, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

function sanitizeBranchIdentifier(identifier: string): string {
  const normalized = identifier.trim().replace(/[^A-Za-z0-9._/-]/g, '-');
  return normalized.replace(/\/+/g, '/').replace(/^-+|-+$/g, '') || 'issue';
}

function renderBranchName(template: string, identifier: string): string {
  return template.replace(/\{\{\s*issue\.identifier\s*\}\}/g, sanitizeBranchIdentifier(identifier));
}

function assertCredentialFreeRemote(remote: string): void {
  if (!remote.includes('://')) return;
  try {
    const parsed = new URL(remote);
    if (parsed.password || ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.username)) {
      throw new WorkspaceError('workspace_provision_failed', 'workspace_remote_contains_credentials');
    }
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError('workspace_provision_failed', 'workspace_remote_invalid');
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readDirectoryEntries(targetPath: string): Promise<string[]> {
  try {
    return await fs.readdir(targetPath);
  } catch {
    return [];
  }
}

function isSafeForReprovision(entries: string[]): boolean {
  if (entries.length === 0) {
    return true;
  }
  return entries.every((entry) => entry === PROVISION_SENTINEL_NAME);
}

interface WorktreeEntry {
  path: string;
  prunable: boolean;
}

function parseWorktreePorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const lines = output.split(/\r?\n/);
  let current: WorktreeEntry | null = null;
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (current) {
        entries.push(current);
      }
      current = { path: path.resolve(line.slice('worktree '.length).trim()), prunable: false };
      continue;
    }
    if (line.startsWith('prunable') && current) {
      current.prunable = true;
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

async function writeProvisionSentinel(params: {
  workspacePath: string;
  provisionerType: 'worktree' | 'clone';
  repoRoot: string;
  branchName?: string | null;
}): Promise<void> {
  const sentinelPath = path.join(params.workspacePath, PROVISION_SENTINEL_NAME);
  const payload = {
    provisioner_type: params.provisionerType,
    repo_root: params.repoRoot,
    branch_name: params.branchName ?? null,
    written_at: new Date().toISOString()
  };
  await fs.writeFile(sentinelPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function assertGitRepoRoot(repoRoot: string): Promise<void> {
  const resolved = path.resolve(repoRoot);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new WorkspaceError('workspace_provision_failed', `repo_root does not exist or is not a directory: ${resolved}`);
  }

  const dotGitPath = path.join(resolved, '.git');
  const dotGitStat = await fs.stat(dotGitPath).catch(() => null);
  if (!dotGitStat) {
    throw new WorkspaceError('workspace_provision_failed', `repo_root is not a git repository: ${resolved}`);
  }
}

export class NoopProvisioner implements WorkspaceProvisioner {
  async provision(_params: WorkspaceProvisionContext): Promise<WorkspaceProvisionResult> {
    return {
      status: 'skipped',
      provisioner_type: 'none',
      workspace_exists: true,
      workspace_git_status: 'unknown',
      workspace_provisioned: false,
      workspace_is_git_worktree: false
    };
  }

  async teardown(_params: WorkspaceTeardownContext): Promise<WorkspaceTeardownResult> {
    return {
      status: 'skipped',
      provisioner_type: 'none'
    };
  }
}

interface WorktreeProvisionerOptions {
  repoRoot: string;
  baseRef: string;
  branchTemplate: string;
  teardownMode: 'remove_worktree' | 'keep';
  allowDirtyRepo: boolean;
  runGit?: RunGit;
  fsOps?: {
    stat: typeof fs.stat;
    rm: typeof fs.rm;
  };
}

export class WorktreeProvisioner implements WorkspaceProvisioner {
  private readonly repoRoot: string;
  private readonly baseRef: string;
  private readonly branchTemplate: string;
  private readonly teardownMode: 'remove_worktree' | 'keep';
  private readonly allowDirtyRepo: boolean;
  private readonly runGit: RunGit;
  private readonly statPath: typeof fs.stat;
  private readonly rmPath: typeof fs.rm;

  constructor(options: WorktreeProvisionerOptions) {
    this.repoRoot = path.resolve(options.repoRoot);
    this.baseRef = options.baseRef;
    this.branchTemplate = options.branchTemplate;
    this.teardownMode = options.teardownMode;
    this.allowDirtyRepo = options.allowDirtyRepo;
    this.runGit = options.runGit ?? defaultRunGit;
    this.statPath = options.fsOps?.stat ?? fs.stat;
    this.rmPath = options.fsOps?.rm ?? fs.rm;
  }

  private async checkAndReconcileStaleWorktreeMetadata(workspacePath: string): Promise<{
    status: 'ok' | 'reconciled';
    reason: string | null;
    checkedAt: string;
    reconciledAt: string | null;
  }> {
    const checkedAt = new Date().toISOString();
    const targetPath = path.resolve(workspacePath);
    const workspaceExistsOnDisk = await pathExists(targetPath);
    const listBefore = await this.runGit({ cwd: this.repoRoot, args: ['worktree', 'list', '--porcelain'] });
    if (!listBefore.ok) {
      throw new WorkspaceError(
        'workspace_integrity_reconcile_failed',
        `workspace_integrity_reconcile_failed: failed to inspect git worktrees: ${listBefore.stderr.trim() || 'unknown'}`
      );
    }
    const matchBefore = parseWorktreePorcelain(listBefore.stdout).find((entry) => entry.path === targetPath);
    const shouldReconcilePrunable = Boolean(matchBefore?.prunable);
    const shouldReconcileMissingPathWithMetadata = !workspaceExistsOnDisk && Boolean(matchBefore);
    if (!shouldReconcilePrunable && !shouldReconcileMissingPathWithMetadata) {
      return { status: 'ok', reason: null, checkedAt, reconciledAt: null };
    }

    const prune = await this.runGit({ cwd: this.repoRoot, args: ['worktree', 'prune'] });
    if (!prune.ok) {
      throw new WorkspaceError(
        'workspace_integrity_reconcile_failed',
        `workspace_integrity_reconcile_failed: stale_worktree_metadata: ${prune.stderr.trim() || 'git worktree prune failed'}`
      );
    }
    const listAfter = await this.runGit({ cwd: this.repoRoot, args: ['worktree', 'list', '--porcelain'] });
    if (!listAfter.ok) {
      throw new WorkspaceError(
        'workspace_integrity_reconcile_failed',
        `workspace_integrity_reconcile_failed: failed to verify git worktrees after prune: ${listAfter.stderr.trim() || 'unknown'}`
      );
    }
    const stillPresent = parseWorktreePorcelain(listAfter.stdout).some((entry) => entry.path === targetPath);
    if (stillPresent) {
      throw new WorkspaceError(
        'workspace_integrity_reconcile_failed',
        'workspace_integrity_reconcile_failed: workspace_path_missing_with_metadata'
      );
    }

    const reconciledReason = shouldReconcileMissingPathWithMetadata
      ? 'workspace_path_missing_with_metadata_pruned'
      : 'stale_worktree_metadata';
    return {
      status: 'reconciled',
      reason: reconciledReason,
      checkedAt,
      reconciledAt: new Date().toISOString()
    };
  }

  async provision(params: WorkspaceProvisionContext): Promise<WorkspaceProvisionResult> {
    await assertGitRepoRoot(this.repoRoot);
    const branchName = renderBranchName(this.branchTemplate, params.identifier);
    const integrity = await this.checkAndReconcileStaleWorktreeMetadata(params.workspacePath);

    const existingWorkspaceStat = await this.statPath(params.workspacePath).catch(() => null);
    if (existingWorkspaceStat?.isDirectory()) {
      const gitMarker = path.join(params.workspacePath, '.git');
      if (await pathExists(gitMarker)) {
        const topLevel = await this.runGit({
          cwd: params.workspacePath,
          args: ['rev-parse', '--show-toplevel']
        });
        if (!topLevel.ok || path.resolve(topLevel.stdout.trim()) !== path.resolve(params.workspacePath)) {
          throw new WorkspaceError('workspace_unprovisioned_conflict', 'workspace path is not a managed git worktree');
        }

        const branch = await this.runGit({
          cwd: params.workspacePath,
          args: ['rev-parse', '--abbrev-ref', 'HEAD']
        });
        if (!branch.ok) {
          throw new WorkspaceError(
            'workspace_unprovisioned_conflict',
            `workspace path exists but branch cannot be inspected: ${branch.stderr.trim() || 'unknown'}`
          );
        }
        const currentBranch = branch.stdout.trim();
        if (currentBranch !== branchName) {
          throw new WorkspaceError('workspace_unprovisioned_conflict', 'worktree_branch_conflict');
        }
        await writeProvisionSentinel({
          workspacePath: params.workspacePath,
          provisionerType: 'worktree',
          repoRoot: this.repoRoot,
          branchName
        });
        return {
          status: 'reused',
          provisioner_type: 'worktree',
          branch_name: branchName,
          repo_root: this.repoRoot,
          workspace_exists: true,
          workspace_git_status: 'unknown',
          workspace_provisioned: true,
          workspace_is_git_worktree: true,
          workspace_integrity_status: integrity.status,
          workspace_integrity_reason: integrity.reason,
          workspace_integrity_checked_at: integrity.checkedAt,
          workspace_integrity_reconciled_at: integrity.reconciledAt
        };
      }

      const entries = await readDirectoryEntries(params.workspacePath);
      if (!isSafeForReprovision(entries)) {
        throw new WorkspaceError(
          'workspace_unprovisioned_conflict',
          'workspace path exists but is not a managed git worktree and is not safe to reprovision'
        );
      }
    }

    if (!this.allowDirtyRepo) {
      const status = await this.runGit({ cwd: this.repoRoot, args: ['status', '--porcelain'] });
      if (!status.ok) {
        throw new WorkspaceError('workspace_provision_failed', `failed to inspect repo status: ${status.stderr.trim() || 'unknown'}`);
      }
      if (status.stdout.trim().length > 0) {
        throw new WorkspaceError('workspace_provision_failed', 'worktree_dirty_repo');
      }
    }

    await this.rmPath(params.workspacePath, { recursive: true, force: true });
    const add = await this.runGit({
      cwd: this.repoRoot,
      args: ['worktree', 'add', '-b', branchName, params.workspacePath, this.baseRef]
    });
    if (!add.ok) {
      throw new WorkspaceError('workspace_provision_failed', add.stderr.trim() || 'worktree_add_failed');
    }

    await writeProvisionSentinel({
      workspacePath: params.workspacePath,
      provisionerType: 'worktree',
      repoRoot: this.repoRoot,
      branchName
    });

    return {
      status: 'provisioned',
      provisioner_type: 'worktree',
      branch_name: branchName,
      repo_root: this.repoRoot,
      workspace_exists: true,
      workspace_git_status: this.allowDirtyRepo ? 'unknown' : 'clean',
      workspace_provisioned: true,
      workspace_is_git_worktree: true,
      workspace_integrity_status: integrity.status,
      workspace_integrity_reason: integrity.reason,
      workspace_integrity_checked_at: integrity.checkedAt,
      workspace_integrity_reconciled_at: integrity.reconciledAt
    };
  }

  async teardown(params: WorkspaceTeardownContext): Promise<WorkspaceTeardownResult> {
    if (this.teardownMode === 'keep') {
      const integrity = await this.checkAndReconcileStaleWorktreeMetadata(params.workspacePath);
      return {
        status: 'kept',
        provisioner_type: 'worktree',
        workspace_integrity_status: integrity.status,
        workspace_integrity_reason: integrity.reason,
        workspace_integrity_checked_at: integrity.checkedAt,
        workspace_integrity_reconciled_at: integrity.reconciledAt
      };
    }

    const remove = await this.runGit({
      cwd: this.repoRoot,
      args: ['worktree', 'remove', '--force', params.workspacePath]
    });
    if (!remove.ok) {
      throw new WorkspaceError('workspace_provision_failed', remove.stderr.trim() || 'worktree_remove_failed');
    }

    return {
      status: 'removed',
      provisioner_type: 'worktree'
    };
  }
}

interface CloneProvisionerOptions {
  repoRoot: string;
  baseRef: string;
  branchTemplate: string;
  teardownMode: 'remove_worktree' | 'keep';
  runGit?: RunGit;
  fsOps?: {
    rm: typeof fs.rm;
  };
}

export class CloneProvisioner implements WorkspaceProvisioner {
  private readonly repoRoot: string;
  private readonly baseRef: string;
  private readonly branchTemplate: string;
  private readonly teardownMode: 'remove_worktree' | 'keep';
  private readonly runGit: RunGit;
  private readonly rmPath: typeof fs.rm;

  constructor(options: CloneProvisionerOptions) {
    this.repoRoot = options.repoRoot;
    this.baseRef = options.baseRef;
    this.branchTemplate = options.branchTemplate;
    this.teardownMode = options.teardownMode;
    this.runGit = options.runGit ?? defaultRunGit;
    this.rmPath = options.fsOps?.rm ?? fs.rm;
  }

  async provision(params: WorkspaceProvisionContext): Promise<WorkspaceProvisionResult> {
    await assertGitRepoRoot(this.repoRoot);
    const branchName = renderBranchName(this.branchTemplate, params.identifier);
    const upstream = await this.runGit({ cwd: this.repoRoot, args: ['config', '--get', 'remote.origin.url'] });
    const upstreamRemote = upstream.ok && upstream.stdout.trim() ? upstream.stdout.trim() : this.repoRoot;
    assertCredentialFreeRemote(upstreamRemote);
    const cloneBranch = this.baseRef.replace(/^origin\//, '');
    const existingWorkspaceStat = await fs.stat(params.workspacePath).catch(() => null);
    if (existingWorkspaceStat?.isDirectory()) {
      const gitMarker = path.join(params.workspacePath, '.git');
      if (await pathExists(gitMarker)) {
        const topLevel = await this.runGit({
          cwd: params.workspacePath,
          args: ['rev-parse', '--show-toplevel']
        });
        const remote = await this.runGit({
          cwd: params.workspacePath,
          args: ['config', '--get', 'remote.origin.url']
        });
        const branch = await this.runGit({
          cwd: params.workspacePath,
          args: ['rev-parse', '--abbrev-ref', 'HEAD']
        });
        if (topLevel.ok && remote.ok && branch.ok) {
          const remoteValue = remote.stdout.trim();
          const resolvedRemote = path.resolve(remoteValue);
          const workspaceMatches = path.resolve(topLevel.stdout.trim()) === path.resolve(params.workspacePath);
          const branchMatches = branch.stdout.trim() === branchName;
          const remoteMatches =
            remoteValue === this.repoRoot || resolvedRemote === this.repoRoot || remoteValue === upstreamRemote;
          if (workspaceMatches && branchMatches && remoteMatches) {
            await writeProvisionSentinel({
              workspacePath: params.workspacePath,
              provisionerType: 'clone',
              repoRoot: this.repoRoot,
              branchName
            });
            return {
              status: 'reused',
              provisioner_type: 'clone',
              branch_name: branchName,
              repo_root: this.repoRoot,
              workspace_exists: true,
              workspace_git_status: 'unknown',
              workspace_provisioned: true,
              workspace_is_git_worktree: false
            };
          }
        }
      }

      const entries = await readDirectoryEntries(params.workspacePath);
      if (!isSafeForReprovision(entries)) {
        throw new WorkspaceError(
          'workspace_unprovisioned_conflict',
          'workspace path exists but is not a managed clone and is not safe to reprovision'
        );
      }
    }

    await this.rmPath(params.workspacePath, { recursive: true, force: true });
    const clone = await this.runGit({
      cwd: process.cwd(),
      args: ['clone', '--no-hardlinks', '--branch', cloneBranch, '--single-branch', upstreamRemote, params.workspacePath]
    });
    if (!clone.ok) {
      throw new WorkspaceError('workspace_provision_failed', clone.stderr.trim() || 'clone_failed');
    }
    const setOrigin = await this.runGit({
      cwd: params.workspacePath,
      args: ['remote', 'set-url', 'origin', upstreamRemote]
    });
    if (!setOrigin.ok) {
      await this.rmPath(params.workspacePath, { recursive: true, force: true });
      throw new WorkspaceError('workspace_provision_failed', setOrigin.stderr.trim() || 'clone_origin_update_failed');
    }
    const createBranch = await this.runGit({
      cwd: params.workspacePath,
      args: ['checkout', '-b', branchName]
    });
    if (!createBranch.ok) {
      await this.rmPath(params.workspacePath, { recursive: true, force: true });
      throw new WorkspaceError('workspace_provision_failed', createBranch.stderr.trim() || 'clone_branch_create_failed');
    }

    await writeProvisionSentinel({
      workspacePath: params.workspacePath,
      provisionerType: 'clone',
      repoRoot: this.repoRoot,
      branchName
    });

    return {
      status: 'provisioned',
      provisioner_type: 'clone',
      branch_name: branchName,
      repo_root: this.repoRoot,
      workspace_exists: true,
      workspace_git_status: 'unknown',
      workspace_provisioned: true,
      workspace_is_git_worktree: false
    };
  }

  async teardown(params: WorkspaceTeardownContext): Promise<WorkspaceTeardownResult> {
    if (this.teardownMode === 'keep') {
      return {
        status: 'kept',
        provisioner_type: 'clone'
      };
    }

    await this.rmPath(params.workspacePath, { recursive: true, force: true });
    return {
      status: 'removed',
      provisioner_type: 'clone'
    };
  }
}

export function createWorkspaceProvisioner(config: {
  type: string;
  repo_root?: string;
  base_ref: string;
  branch_template: string;
  teardown_mode: string;
  allow_dirty_repo: boolean;
}): WorkspaceProvisioner {
  if (config.type === 'worktree') {
    return new WorktreeProvisioner({
      repoRoot: config.repo_root ?? '',
      baseRef: config.base_ref,
      branchTemplate: config.branch_template,
      teardownMode: config.teardown_mode === 'keep' ? 'keep' : 'remove_worktree',
      allowDirtyRepo: config.allow_dirty_repo
    });
  }

  if (config.type === 'clone') {
    return new CloneProvisioner({
      repoRoot: config.repo_root ?? '',
      baseRef: config.base_ref,
      branchTemplate: config.branch_template,
      teardownMode: config.teardown_mode === 'keep' ? 'keep' : 'remove_worktree'
    });
  }

  return new NoopProvisioner();
}
