import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import { WorkspaceError } from './errors';
import { copyIgnoredArtifacts } from './copy-ignored';
import { NoopProvisioner } from './provisioner';
import { auditSensitiveWorkspaceFiles } from './sensitive-files';
import type {
  CleanupWorkspacesResult,
  HookExecutionResult,
  WorkspaceHookName,
  WorkspaceInfo,
  WorkspaceManagerOptions,
  WorkspacePrepareAttemptOptions
} from './types';

const SANITIZE_PATTERN = /[^A-Za-z0-9._-]/g;
const TEMP_ARTIFACTS = ['tmp', '.elixir_ls'];
const VCS_DIRECTORIES = new Set(['.git', '.hg', '.jj', '.svn']);
const VENV_SCAN_MAX_ENTRIES = 50_000;
const EPHEMERAL_FILE_EXACT = new Set(['.symphony-provision.json']);
const EPHEMERAL_PREFIXES = ['output/playwright/'];
const SENTINEL_UI_PATH = 'src/api/dashboard-assets.ts';

async function defaultRunShell(params: {
  cwd: string;
  script: string;
  timeoutMs: number;
}): Promise<{ timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', params.script], {
      cwd: params.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let settled = false;
    let output = '';

    const finish = (result: { timedOut: boolean; error?: string }) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ timedOut: true, error: 'hook timeout' });
    }, params.timeoutMs);

    child.on('error', (error) => {
      finish({ timedOut: false, error: error.message });
    });

    child.on('close', (code) => {
      if (code === 0) {
        finish({ timedOut: false });
        return;
      }

      const message = output.trim().slice(0, 500) || `hook exited with code ${code ?? 'unknown'}`;
      finish({ timedOut: false, error: message });
    });
  });
}

async function defaultProbeTool(params: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      stdio: ['ignore', 'ignore', 'ignore']
    });

    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function defaultRunGit(params: { cwd: string; args: string[] }): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', params.args, { cwd: params.cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? stdout : null));
  });
}

function normalizeHookReasonCode(reason: string): string {
  return reason
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseHookStructuredReason(output: string | undefined): string | null {
  if (!output) {
    return null;
  }

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index];
    try {
      const parsed = JSON.parse(candidate) as { action?: unknown; reason?: unknown };
      if (typeof parsed.reason === 'string' && parsed.reason.trim().length > 0) {
        return normalizeHookReasonCode(parsed.reason);
      }
    } catch {
      // best-effort parse only
    }
  }
  return null;
}

export class WorkspaceManager {
  private readonly root: string;
  private readonly hooks: WorkspaceManagerOptions['hooks'];
  private readonly provisioner: NonNullable<WorkspaceManagerOptions['provisioner']>;
  private readonly nowMs: () => number;
  private readonly runShell: NonNullable<WorkspaceManagerOptions['runShell']>;
  private readonly probeTool: NonNullable<WorkspaceManagerOptions['probeTool']>;
  private readonly runGit: NonNullable<WorkspaceManagerOptions['runGit']>;
  private readonly onHookResult?: WorkspaceManagerOptions['onHookResult'];
  private readonly onProvisionerResult?: WorkspaceManagerOptions['onProvisionerResult'];
  private copyIgnored: WorkspaceManagerOptions['copyIgnored'];
  private readonly onCopyIgnoredResult?: WorkspaceManagerOptions['onCopyIgnoredResult'];
  private readonly onPreflightResult?: WorkspaceManagerOptions['onPreflightResult'];

  constructor(options: WorkspaceManagerOptions) {
    this.root = path.resolve(options.root);
    this.hooks = options.hooks;
    this.provisioner = options.provisioner ?? new NoopProvisioner();
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.runShell = options.runShell ?? defaultRunShell;
    this.probeTool = options.probeTool ?? defaultProbeTool;
    this.runGit = options.runGit ?? defaultRunGit;
    this.onHookResult = options.onHookResult;
    this.onProvisionerResult = options.onProvisionerResult;
    this.copyIgnored = options.copyIgnored;
    this.onCopyIgnoredResult = options.onCopyIgnoredResult;
    this.onPreflightResult = options.onPreflightResult;
  }

  setCopyIgnoredConfig(config: WorkspaceManagerOptions['copyIgnored']): void {
    this.copyIgnored = config;
  }

  deriveWorkspaceKey(identifier: string): string {
    return identifier.replace(SANITIZE_PATTERN, '_');
  }

  async ensureWorkspace(identifier: string): Promise<WorkspaceInfo> {
    const workspace_key = this.deriveWorkspaceKey(identifier);
    const workspacePath = path.resolve(this.root, workspace_key);
    this.assertContained(workspacePath);

    let created_now = false;
    let stat = await this.statIfExists(workspacePath);

    if (stat && !stat.isDirectory()) {
      throw new WorkspaceError(
        'workspace_non_directory_collision',
        `Workspace path collides with non-directory entry: ${workspacePath}`
      );
    }

    if (!stat) {
      await fs.mkdir(workspacePath, { recursive: true });
      created_now = true;
      stat = await this.statIfExists(workspacePath);
      if (!stat || !stat.isDirectory()) {
        throw new WorkspaceError('workspace_non_directory_collision', `Failed to create workspace directory: ${workspacePath}`);
      }
    }

    let provisionResult: Awaited<ReturnType<typeof this.provisioner.provision>> | null = null;
    let copyIgnoredApplied = false;
    let copyIgnoredStatus: 'skipped' | 'success' | 'failed' | undefined;
    let copyIgnoredSummary:
      | {
          copied_files: number;
          skipped_existing: number;
          blocked_files: number;
          bytes_copied: number;
          duration_ms: number;
        }
      | undefined;
    try {
      this.onProvisionerResult?.({
          phase: 'provision',
          identifier,
          workspace_path: workspacePath,
          status: 'start',
          provisioner_type: 'unknown'
        });
      provisionResult = await this.provisioner.provision({
        identifier,
        workspacePath
      });
      this.onProvisionerResult?.({
          phase: 'provision',
          identifier,
          workspace_path: workspacePath,
          status: provisionResult.status,
          provisioner_type: provisionResult.provisioner_type,
          workspace_integrity_status: provisionResult.workspace_integrity_status,
          workspace_integrity_reason: provisionResult.workspace_integrity_reason ?? null,
          workspace_integrity_checked_at: provisionResult.workspace_integrity_checked_at ?? null,
          workspace_integrity_reconciled_at: provisionResult.workspace_integrity_reconciled_at ?? null
      });
    } catch (error) {
        let cleanupAttempted = false;
        let cleanupSucceeded = false;
        let cleanupError: string | undefined;
        if (created_now) {
          cleanupAttempted = true;
          try {
            await fs.rm(workspacePath, { recursive: true, force: true });
            cleanupSucceeded = true;
          } catch (cleanupFailure) {
            cleanupError = cleanupFailure instanceof Error ? cleanupFailure.message : 'unknown cleanup error';
          }
        }
        this.onProvisionerResult?.({
          phase: 'provision',
          identifier,
          workspace_path: workspacePath,
          status: 'failed',
          provisioner_type: 'unknown',
          error_code: error instanceof WorkspaceError ? error.code : 'workspace_provision_failed',
          error_message: error instanceof Error ? error.message : 'unknown workspace provision failure',
          cleanup_attempted: cleanupAttempted,
          cleanup_succeeded: cleanupSucceeded,
          ...(cleanupError ? { cleanup_error: cleanupError } : {})
        });
      throw error;
    }
    if (created_now) {
      if (this.copyIgnored?.enabled) {
        copyIgnoredApplied = true;
        if (
          this.hooks.after_create &&
          /(worktreeinclude|copy[-_ ]ignored|copy[-_ ]worktree)/i.test(this.hooks.after_create)
        ) {
          this.onCopyIgnoredResult?.({
            identifier,
            workspace_path: workspacePath,
            status: 'skipped',
            warning: 'custom_copy_hook_detected'
          });
        }
        if (provisionResult?.provisioner_type === 'none') {
          this.onCopyIgnoredResult?.({
            identifier,
            workspace_path: workspacePath,
            status: 'skipped',
            warning: 'copy_ignored_skipped_for_none_provisioner'
          });
          copyIgnoredStatus = 'skipped';
          await this.runHookOrThrow('after_create', workspacePath);
          return {
            path: workspacePath,
            workspace_key,
            created_now,
            provisioner_type: provisionResult?.provisioner_type ?? undefined,
            branch_name: provisionResult?.branch_name ?? null,
            repo_root: provisionResult?.repo_root ?? null,
            workspace_exists: provisionResult?.workspace_exists ?? true,
            workspace_git_status: provisionResult?.workspace_git_status ?? 'unknown',
            workspace_provisioned: provisionResult?.workspace_provisioned ?? false,
            workspace_is_git_worktree: provisionResult?.workspace_is_git_worktree ?? false,
            workspace_integrity_status: provisionResult?.workspace_integrity_status ?? undefined,
            workspace_integrity_reason: provisionResult?.workspace_integrity_reason ?? null,
            workspace_integrity_checked_at: provisionResult?.workspace_integrity_checked_at ?? null,
            workspace_integrity_reconciled_at: provisionResult?.workspace_integrity_reconciled_at ?? null,
            copy_ignored_applied: copyIgnoredApplied,
            copy_ignored_status: copyIgnoredStatus,
            copy_ignored_summary: copyIgnoredSummary
          };
        }
        this.onCopyIgnoredResult?.({
          identifier,
          workspace_path: workspacePath,
          status: 'start'
        });
        try {
          const copyResult = await copyIgnoredArtifacts({
            identifier,
            workspacePath,
            provisionRepoRoot: provisionResult?.repo_root ?? null,
            config: this.copyIgnored,
            nowMs: this.nowMs
          });
          this.onCopyIgnoredResult?.({
            identifier,
            workspace_path: workspacePath,
            status: copyResult.status,
            source_path: copyResult.source_path,
            include_file: copyResult.include_file,
            conflict_policy: copyResult.conflict_policy,
            copied_files: copyResult.copied_files,
            skipped_existing: copyResult.skipped_existing,
            blocked_files: copyResult.blocked_files,
            bytes_copied: copyResult.bytes_copied,
            duration_ms: copyResult.duration_ms,
            warning: copyResult.warning
          });
          copyIgnoredStatus = copyResult.status;
          copyIgnoredSummary = {
            copied_files: copyResult.copied_files,
            skipped_existing: copyResult.skipped_existing,
            blocked_files: copyResult.blocked_files,
            bytes_copied: copyResult.bytes_copied,
            duration_ms: copyResult.duration_ms
          };
        } catch (error) {
          this.onCopyIgnoredResult?.({
            identifier,
            workspace_path: workspacePath,
            status: 'failed',
            error_code:
              error instanceof WorkspaceError ? error.code : 'workspace_copy_ignored_invalid_config',
            error_message: error instanceof Error ? error.message : 'workspace copy ignored failed'
          });
          copyIgnoredStatus = 'failed';
          throw error;
        }
      }

      await this.runHookOrThrow('after_create', workspacePath);
    }

    return {
      path: workspacePath,
      workspace_key,
      created_now,
      provisioner_type: provisionResult?.provisioner_type ?? undefined,
      branch_name: provisionResult?.branch_name ?? null,
      repo_root: provisionResult?.repo_root ?? null,
      workspace_exists: provisionResult?.workspace_exists ?? true,
      workspace_git_status: provisionResult?.workspace_git_status ?? 'unknown',
      workspace_provisioned: provisionResult?.workspace_provisioned ?? false,
      workspace_is_git_worktree: provisionResult?.workspace_is_git_worktree ?? false,
      workspace_integrity_status: provisionResult?.workspace_integrity_status ?? undefined,
      workspace_integrity_reason: provisionResult?.workspace_integrity_reason ?? null,
      workspace_integrity_checked_at: provisionResult?.workspace_integrity_checked_at ?? null,
      workspace_integrity_reconciled_at: provisionResult?.workspace_integrity_reconciled_at ?? null,
      copy_ignored_applied: copyIgnoredApplied,
      copy_ignored_status: copyIgnoredStatus,
      copy_ignored_summary: copyIgnoredSummary
    };
  }

  async prepareAttempt(workspacePath: string, options: WorkspacePrepareAttemptOptions = {}): Promise<void> {
    const resolved = path.resolve(workspacePath);
    this.assertLaunchSafety({ workspacePath: resolved, cwd: resolved });
    await this.removeEscapedVirtualenvs(resolved);
    this.assertNoSensitiveFiles(resolved);

    for (const artifact of TEMP_ARTIFACTS) {
      await fs.rm(path.join(resolved, artifact), { recursive: true, force: true });
    }
    await this.normalizeKnownWorkspaceDrift(resolved, options);

    await this.runHookOrThrow('before_run', resolved);
    this.assertNoSensitiveFiles(resolved);
  }

  // Python virtualenvs symlink their interpreter outside the managed workspace
  // (a system interpreter, or a sandbox-session-scoped install that no longer
  // exists on reuse), so a reused workspace that carries one can never pass the
  // fail-closed sensitive-file audit: every redispatch fails with
  // symlink_escape and the issue loops without operator-visible remediation.
  // Virtualenvs are rebuildable attempt artifacts, so any venv whose
  // interpreter links dangle or resolve outside the workspace is removed before
  // auditing. Venvs whose links stay inside the workspace (or that were built
  // with --copies) are kept, and escaped symlinks anywhere else still fail the
  // audit closed.
  private async removeEscapedVirtualenvs(workspacePath: string): Promise<void> {
    const removed: Array<{ path: string; action: 'remove' }> = [];
    const pending = [''];
    let scanned = 0;
    while (pending.length > 0) {
      const relativeDirectory = pending.pop()!;
      const absoluteDirectory = relativeDirectory ? path.join(workspacePath, relativeDirectory) : workspacePath;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
      } catch {
        continue;
      }
      if (relativeDirectory && entries.some((entry) => entry.isFile() && entry.name === 'pyvenv.cfg')) {
        if (await this.virtualenvEscapesWorkspace(workspacePath, relativeDirectory)) {
          await fs.rm(absoluteDirectory, { recursive: true, force: true });
          removed.push({ path: relativeDirectory.replace(/\\/g, '/'), action: 'remove' });
        }
        continue;
      }
      for (const entry of entries) {
        scanned += 1;
        if (scanned > VENV_SCAN_MAX_ENTRIES) return;
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (VCS_DIRECTORIES.has(entry.name)) continue;
        pending.push(relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name);
      }
    }
    if (removed.length > 0) {
      this.onPreflightResult?.({
        identifier: path.basename(workspacePath),
        workspace_path: workspacePath,
        status: 'cleaned',
        cleaned_files: removed,
        conflict_files: [],
        resolution_hints: []
      });
    }
  }

  private async virtualenvEscapesWorkspace(workspacePath: string, venvRelative: string): Promise<boolean> {
    for (const binDirectory of ['bin', 'Scripts']) {
      const absoluteBin = path.join(workspacePath, venvRelative, binDirectory);
      let entries: Dirent[];
      try {
        entries = await fs.readdir(absoluteBin, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isSymbolicLink()) continue;
        let resolvedTarget: string;
        try {
          resolvedTarget = await fs.realpath(path.join(absoluteBin, entry.name));
        } catch {
          return true;
        }
        const relativeTarget = path.relative(workspacePath, resolvedTarget);
        if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) return true;
      }
    }
    return false;
  }

  private assertNoSensitiveFiles(workspacePath: string): void {
    const sensitiveFileAudit = auditSensitiveWorkspaceFiles(workspacePath);
    if (sensitiveFileAudit.complete && sensitiveFileAudit.violations.length === 0) return;
    const evidence = sensitiveFileAudit.violations.slice(0, 20).map(({ path: violationPath, category, mode }) => ({
      path: violationPath,
      category,
      mode
    }));
    throw new WorkspaceError(
      'workspace_sensitive_file_detected',
      JSON.stringify({
        complete: sensitiveFileAudit.complete,
        scanned_entries: sensitiveFileAudit.scannedEntries,
        violations: evidence,
        omitted_violations: Math.max(0, sensitiveFileAudit.violations.length - evidence.length),
        error: sensitiveFileAudit.error
      })
    );
  }

  private async normalizeKnownWorkspaceDrift(workspacePath: string, options: WorkspacePrepareAttemptOptions): Promise<void> {
    const statusOutput = await this.runGit({ cwd: workspacePath, args: ['status', '--porcelain'] });
    if (!statusOutput) {
      return;
    }
    const entries = this.parseStatusPorcelain(statusOutput);
    if (entries.length === 0) {
      return;
    }

    const cleanupActions: Array<{ path: string; action: 'unstage' | 'untrack' | 'remove' | 'restore' }> = [];
    const conflictFiles: Array<{
      path: string;
      status: 'staged' | 'unstaged' | 'unknown';
      classification: 'ephemeral' | 'tracked_ephemeral' | 'unknown_non_ephemeral';
    }> = [];
    const classificationSummary = {
      ephemeral: 0,
      tracked_ephemeral: 0,
      unknown_non_ephemeral: 0
    };

    for (const entry of entries) {
      const normalizedPath = entry.path.replace(/\\/g, '/');
      const isEphemeral =
        EPHEMERAL_FILE_EXACT.has(normalizedPath) || EPHEMERAL_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));
      if (!isEphemeral) {
        continue;
      }
      if (entry.staged !== ' ') {
        await this.runGit({ cwd: workspacePath, args: ['restore', '--staged', '--', normalizedPath] });
        cleanupActions.push({ path: normalizedPath, action: 'unstage' });
      }
      if (normalizedPath.startsWith('output/playwright/') && entry.staged !== '?') {
        await this.runGit({ cwd: workspacePath, args: ['rm', '--cached', '-f', '--ignore-unmatch', '--', normalizedPath] });
        cleanupActions.push({ path: normalizedPath, action: 'untrack' });
      }
      await fs.rm(path.join(workspacePath, normalizedPath), { recursive: true, force: true });
      cleanupActions.push({ path: normalizedPath, action: 'remove' });
    }

    const sentinel = entries.find((entry) => entry.path.replace(/\\/g, '/') === SENTINEL_UI_PATH);
    if (sentinel && sentinel.staged !== ' ' && sentinel.unstaged !== ' ') {
      await this.runGit({ cwd: workspacePath, args: ['restore', '--staged', '--', SENTINEL_UI_PATH] });
      cleanupActions.push({ path: SENTINEL_UI_PATH, action: 'unstage' });
    }

    const remaining = this.parseStatusPorcelain((await this.runGit({ cwd: workspacePath, args: ['status', '--porcelain'] })) ?? '');
    for (const entry of remaining) {
      const normalizedPath = entry.path.replace(/\\/g, '/');
      if (normalizedPath === SENTINEL_UI_PATH) {
        continue;
      }
      if (normalizedPath.startsWith('output/playwright/') && entry.staged !== '?') {
        const classification = 'tracked_ephemeral' as const;
        conflictFiles.push({ path: normalizedPath, status: this.statusForPorcelainEntry(entry), classification });
        classificationSummary[classification] += 1;
        continue;
      }
      if (EPHEMERAL_FILE_EXACT.has(normalizedPath) || EPHEMERAL_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix))) {
        const classification = 'ephemeral' as const;
        classificationSummary[classification] += 1;
        continue;
      }
      if (entry.staged !== ' ' || entry.unstaged !== ' ') {
        const classification = 'unknown_non_ephemeral' as const;
        conflictFiles.push({ path: normalizedPath, status: this.statusForPorcelainEntry(entry), classification });
        classificationSummary[classification] += 1;
      }
    }

    if (cleanupActions.length > 0) {
      this.onPreflightResult?.({
        identifier: path.basename(workspacePath),
        workspace_path: workspacePath,
        status: 'cleaned',
        cleaned_files: cleanupActions,
        conflict_files: [],
        classification_summary: classificationSummary,
        resolution_hints: []
      });
    }

    if (conflictFiles.length > 0) {
      const attemptResidueRecoverable =
        options.allow_attempt_residue === true &&
        classificationSummary.tracked_ephemeral === 0 &&
        classificationSummary.unknown_non_ephemeral === conflictFiles.length &&
        !(await this.hasActiveGitOperation(workspacePath));
      if (attemptResidueRecoverable) {
        this.onPreflightResult?.({
          identifier: path.basename(workspacePath),
          workspace_path: workspacePath,
          status: 'attempt_residue_recoverable',
          cleaned_files: cleanupActions,
          conflict_files: conflictFiles,
          classification_summary: classificationSummary,
          resolution_hints: [
            'Continue from the previous attempt residue in this managed issue workspace.',
            'Inspect the dirty diff, run required validation, and commit only if the residue matches the ticket scope.'
          ]
        });
        return;
      }
      const detail =
        classificationSummary.tracked_ephemeral > 0
          ? 'tracked output/playwright artifacts remain after preflight cleanup'
          : 'workspace contains non-ephemeral dirty files after preflight cleanup';
      const resolutionHints =
        classificationSummary.tracked_ephemeral > 0
          ? [
              'Remove tracked entries under output/playwright/ from git index/history.',
              'Run `git rm --cached output/playwright/<file>` for each tracked artifact.',
              'Resume only after workspace git status is free of tracked output/playwright entries.'
            ]
          : [
              'Inspect the dirty files in the issue worktree.',
              'Commit, stash, or remove the non-ephemeral changes before resuming.',
              'Resume only after the workspace state is known to be safe.'
            ];
      this.onPreflightResult?.({
        identifier: path.basename(workspacePath),
        workspace_path: workspacePath,
        status: 'conflict',
        cleaned_files: cleanupActions,
        conflict_files: conflictFiles,
        classification_summary: classificationSummary,
        resolution_hints: resolutionHints
      });
      throw new WorkspaceError(
        'workspace_unprovisioned_conflict',
        `workspace_preflight_conflict:${JSON.stringify({
          detail,
          conflict_files: conflictFiles,
          classification_summary: classificationSummary,
          resolution_hints: resolutionHints
        })}`
      );
    }
  }

  private statusForPorcelainEntry(entry: { staged: string; unstaged: string }): 'staged' | 'unstaged' | 'unknown' {
    if (entry.staged === '?' && entry.unstaged === '?') {
      return 'unknown';
    }
    return entry.staged !== ' ' ? 'staged' : 'unstaged';
  }

  private async hasActiveGitOperation(workspacePath: string): Promise<boolean> {
    const gitStatePaths = [
      'MERGE_HEAD',
      'REBASE_HEAD',
      'AUTO_MERGE',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'BISECT_LOG',
      'sequencer',
      'rebase-merge',
      'rebase-apply'
    ];
    for (const gitStatePath of gitStatePaths) {
      const resolved = await this.runGit({ cwd: workspacePath, args: ['rev-parse', '--git-path', gitStatePath] });
      const candidate = resolved?.trim();
      if (!candidate) {
        continue;
      }
      const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(workspacePath, candidate);
      if (await fs.stat(absolute).then(() => true, () => false)) {
        return true;
      }
    }
    const unmergedEntries = await this.runGit({ cwd: workspacePath, args: ['ls-files', '-u'] });
    if (unmergedEntries?.trim()) {
      return true;
    }
    return false;
  }

  private parseStatusPorcelain(output: string): Array<{ staged: string; unstaged: string; path: string }> {
    return output
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length >= 4)
      .map((line) => ({ staged: line[0] ?? ' ', unstaged: line[1] ?? ' ', path: line.slice(3).trim() }))
      .filter((entry) => entry.path.length > 0);
  }

  async finalizeAttempt(workspacePath: string): Promise<void> {
    const resolved = path.resolve(workspacePath);
    this.assertContained(resolved);
    await this.runHookBestEffort('after_run', resolved);
  }

  async cleanupWorkspace(identifier: string): Promise<boolean> {
    const workspacePath = path.resolve(this.root, this.deriveWorkspaceKey(identifier));
    this.assertContained(workspacePath);

    const stat = await this.statIfExists(workspacePath);
    if (!stat) {
      return true;
    }
    if (!stat.isDirectory()) {
      return false;
    }

    await this.runHookBestEffort('before_remove', workspacePath);
    try {
      this.onProvisionerResult?.({
        phase: 'teardown',
        identifier,
        workspace_path: workspacePath,
        status: 'start',
        provisioner_type: 'unknown'
      });
      const teardownResult = await this.provisioner.teardown({
        identifier,
        workspacePath
      });
      this.onProvisionerResult?.({
        phase: 'teardown',
        identifier,
        workspace_path: workspacePath,
        status: teardownResult.status,
        provisioner_type: teardownResult.provisioner_type,
        workspace_integrity_status: teardownResult.workspace_integrity_status,
        workspace_integrity_reason: teardownResult.workspace_integrity_reason ?? null,
        workspace_integrity_checked_at: teardownResult.workspace_integrity_checked_at ?? null,
        workspace_integrity_reconciled_at: teardownResult.workspace_integrity_reconciled_at ?? null,
        error_code:
          teardownResult.workspace_integrity_status === 'failed'
            ? teardownResult.workspace_integrity_reason ?? 'workspace_integrity_reconcile_failed'
            : undefined
      });
      if (teardownResult.status === 'kept') {
        return true;
      }
    } catch (error) {
      this.onProvisionerResult?.({
        phase: 'teardown',
        identifier,
        workspace_path: workspacePath,
        status: 'failed',
        provisioner_type: 'unknown',
        error_code: error instanceof WorkspaceError ? error.code : 'workspace_provision_failed',
        error_message: error instanceof Error ? error.message : 'unknown workspace teardown failure'
      });
      throw error;
    }

    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  async cleanupWorkspaces(identifiers: string[]): Promise<CleanupWorkspacesResult[]> {
    const results: CleanupWorkspacesResult[] = [];
    for (const identifier of identifiers) {
      const cleaned = await this.cleanupWorkspace(identifier);
      results.push({ identifier, cleaned });
    }
    return results;
  }

  assertLaunchSafety(params: { workspacePath: string; cwd: string }): void {
    const workspacePath = path.resolve(params.workspacePath);
    const cwd = path.resolve(params.cwd);

    this.assertContained(workspacePath);

    if (cwd !== workspacePath) {
      throw new WorkspaceError('workspace_cwd_mismatch', `Launch cwd must equal workspace path. cwd=${cwd} workspace=${workspacePath}`);
    }
  }

  private async runHookOrThrow(hook: WorkspaceHookName, cwd: string): Promise<void> {
    const result = await this.runHook(hook, cwd);
    if (result.status === 'succeeded') {
      return;
    }

    if (result.timed_out) {
      throw new WorkspaceError('workspace_hook_timeout', `${hook} hook timed out`);
    }

    throw new WorkspaceError(
      'workspace_hook_failed',
      `${hook} hook failed: ${result.hook_reason_code ?? result.error ?? 'unknown error'}`
    );
  }

  private async runHookBestEffort(hook: WorkspaceHookName, cwd: string): Promise<void> {
    await this.runHook(hook, cwd);
  }

  private async runHook(hook: WorkspaceHookName, cwd: string): Promise<HookExecutionResult> {
    const script = this.hooks[hook];
    if (!script) {
      return {
        hook,
        status: 'succeeded',
        duration_ms: 0,
        timed_out: false
      };
    }

    const started = this.nowMs();
    const fallbackReason = hook === 'after_run' ? await this.determineFinalizationFallbackReason(cwd) : null;
    if (fallbackReason) {
      const duration_ms = Math.max(0, this.nowMs() - started);
      const result: HookExecutionResult = {
        hook,
        status: 'failed',
        duration_ms,
        timed_out: false,
        error: `finalization local shell unavailable (${fallbackReason})`,
        fallback_reason_code: fallbackReason,
        fallback_mode: 'mcp_github'
      };
      this.onHookResult?.(result);
      return result;
    }

    const shellResult = await this.runShell({
      cwd,
      script,
      timeoutMs: this.hooks.timeout_ms
    });
    const duration_ms = Math.max(0, this.nowMs() - started);

    const inferredFallbackReason = this.inferFallbackReasonFromError(shellResult.error);
    const hookReasonCode = parseHookStructuredReason(shellResult.error);
    const result: HookExecutionResult = shellResult.error
      ? {
          hook,
          status: 'failed',
          duration_ms,
          timed_out: shellResult.timedOut,
          error: shellResult.error,
          hook_reason_code: hookReasonCode ?? undefined,
          fallback_reason_code: inferredFallbackReason ?? undefined,
          fallback_mode: inferredFallbackReason ? 'mcp_github' : undefined
        }
      : {
          hook,
          status: 'succeeded',
          duration_ms,
          timed_out: false
        };

    this.onHookResult?.(result);
    return result;
  }

  private inferFallbackReasonFromError(error: string | undefined): HookExecutionResult['fallback_reason_code'] | null {
    if (!error) {
      return null;
    }

    const normalized = error.toLowerCase();
    if (
      normalized.includes('spawn bash enoent') ||
      normalized.includes('no such file or directory') ||
      normalized.includes('os error 2')
    ) {
      return 'shell_unavailable';
    }

    return null;
  }

  private async determineFinalizationFallbackReason(cwd: string): Promise<HookExecutionResult['fallback_reason_code'] | null> {
    const shellAvailable = await this.probeTool({ command: 'bash', args: ['-lc', 'exit 0'], cwd });
    if (!shellAvailable) {
      return 'shell_unavailable';
    }

    const gitAvailable = await this.probeTool({ command: 'git', args: ['--version'], cwd });
    if (!gitAvailable) {
      return 'tool_missing_git';
    }

    const ghAvailable = await this.probeTool({ command: 'gh', args: ['--version'], cwd });
    if (!ghAvailable) {
      return 'tool_missing_gh';
    }

    return null;
  }

  private assertContained(workspacePath: string): void {
    const relative = path.relative(this.root, workspacePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new WorkspaceError(
        'workspace_not_contained',
        `Workspace path is outside configured root: path=${workspacePath} root=${this.root}`
      );
    }
  }

  private async statIfExists(targetPath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
    try {
      return await fs.stat(targetPath);
    } catch {
      return null;
    }
  }
}
