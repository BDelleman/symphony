import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { WorkspaceError } from './errors';
import type { WorkspaceCopyIgnoredConfig } from './types';

const HARD_DENY_PATTERNS = [
  '.git/**',
  '.jj/**',
  '.hg/**',
  '.svn/**',
  '.ssh/**',
  '**/.ssh/**',
  '.gnupg/**',
  '**/.gnupg/**',
  '.aws/**',
  '**/.aws/**',
  '.azure/**',
  '**/.azure/**',
  '.kube/**',
  '**/.kube/**',
  '.config/gh/**',
  '**/.config/gh/**',
  '.config/gcloud/**',
  '**/.config/gcloud/**',
  '.config/containers/**',
  '**/.config/containers/**',
  '.config/pip/**',
  '**/.config/pip/**',
  '.config/pypoetry/**',
  '**/.config/pypoetry/**',
  '.cargo/**',
  '**/.cargo/**',
  '.composer/**',
  '**/.composer/**',
  '.docker/**',
  '**/.docker/**',
  '.terraform.d/**',
  '**/.terraform.d/**',
  '.claude.json',
  '**/.claude.json',
  '.mcp.json',
  '**/.mcp.json',
  '.npmrc',
  '**/.npmrc',
  '.pnpmrc',
  '**/.pnpmrc',
  '.yarnrc',
  '**/.yarnrc',
  '.yarnrc.yml',
  '**/.yarnrc.yml',
  '.pypirc',
  '**/.pypirc',
  '.netrc',
  '**/.netrc',
  '.authinfo',
  '**/.authinfo',
  '.git-credentials',
  '**/.git-credentials',
  'credentials',
  '**/credentials',
  'credentials.json',
  '**/credentials.json',
  '*service-account*.json',
  '**/*service-account*.json',
  '*.pem',
  '**/*.pem',
  '*.key',
  '**/*.key',
  '*.p12',
  '**/*.p12',
  '*.pfx',
  '**/*.pfx',
  '.env*',
  '**/.env*'
];

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function escapeRegex(literal: string): string {
  return literal.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(pattern: string, caseInsensitive = false): RegExp {
  const normalized = toPosix(pattern).replace(/^\/+/, '');
  let out = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const c = normalized[i];
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    out += escapeRegex(c);
  }
  out += '$';
  return new RegExp(out, caseInsensitive ? 'i' : undefined);
}

function isUnsafePattern(raw: string): boolean {
  const pattern = raw.trim();
  if (!pattern) {
    return false;
  }
  if (path.isAbsolute(pattern)) {
    return true;
  }
  const segments = toPosix(pattern).split('/');
  return segments.includes('..');
}

async function runGit(params: { cwd: string; args: string[] }): Promise<{ ok: boolean; stdout: string; stderr: string }> {
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

async function listFilesRecursive(root: string, current = ''): Promise<string[]> {
  const base = current ? path.join(root, current) : root;
  const entries = await fs.readdir(base, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.jj' || entry.name === '.hg' || entry.name === '.svn') {
      continue;
    }
    const rel = current ? path.join(current, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(root, rel)));
      continue;
    }
    files.push(rel);
  }
  return files;
}

async function resolvePrimaryWorktreePath(repoRoot: string): Promise<string> {
  const listed = await runGit({ cwd: repoRoot, args: ['worktree', 'list', '--porcelain'] });
  if (!listed.ok) {
    throw new WorkspaceError('workspace_copy_ignored_source_not_found', listed.stderr.trim() || 'failed to list worktrees');
  }
  const lines = listed.stdout.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      const wt = line.slice('worktree '.length).trim();
      if (wt) {
        return path.resolve(wt);
      }
    }
  }
  throw new WorkspaceError('workspace_copy_ignored_source_not_found', 'primary worktree not found');
}

async function isGitIgnored(repoRoot: string, relativePath: string): Promise<boolean> {
  const checked = await runGit({ cwd: repoRoot, args: ['check-ignore', '-q', '--', toPosix(relativePath)] });
  return checked.ok;
}

function compilePatterns(patterns: string[], caseInsensitive = false): RegExp[] {
  const compiled: RegExp[] = [];
  for (const raw of patterns) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const candidate = trimmed.endsWith('/') ? `${trimmed}**` : trimmed;
    compiled.push(globToRegex(candidate, caseInsensitive));
  }
  return compiled;
}

function matchesAny(relPath: string, patterns: RegExp[]): boolean {
  const normalized = toPosix(relPath);
  return patterns.some((pattern) => pattern.test(normalized));
}

export interface CopyIgnoredResult {
  status: 'skipped' | 'success';
  source_path: string;
  include_file: string;
  conflict_policy: 'skip' | 'overwrite' | 'fail';
  copied_files: number;
  skipped_existing: number;
  blocked_files: number;
  bytes_copied: number;
  duration_ms: number;
  warning?: string;
}

export async function copyIgnoredArtifacts(params: {
  identifier: string;
  workspacePath: string;
  provisionRepoRoot?: string | null;
  config: WorkspaceCopyIgnoredConfig;
  nowMs?: () => number;
}): Promise<CopyIgnoredResult> {
  const nowMs = params.nowMs ?? (() => Date.now());
  const started = nowMs();
  const config = params.config;

  if (!config.enabled) {
    return {
      status: 'skipped',
      source_path: '',
      include_file: config.include_file,
      conflict_policy: 'skip',
      copied_files: 0,
      skipped_existing: 0,
      blocked_files: 0,
      bytes_copied: 0,
      duration_ms: 0
    };
  }

  const conflictPolicy = (config.conflict_policy === 'overwrite' || config.conflict_policy === 'fail'
    ? config.conflict_policy
    : 'skip') as 'skip' | 'overwrite' | 'fail';

  const includeFile = path.resolve(config.include_file);
  const includeText = await fs.readFile(includeFile, 'utf8').catch((error) => {
    throw new WorkspaceError(
      'workspace_copy_ignored_invalid_config',
      error instanceof Error ? error.message : 'failed to read include file'
    );
  });

  const includeLines = includeText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'));
  if (includeLines.some(isUnsafePattern)) {
    throw new WorkspaceError('workspace_copy_ignored_invalid_config', 'include file contains unsafe absolute or traversal pattern');
  }

  const includePatterns = compilePatterns(includeLines);
  const allowPatterns = compilePatterns(config.allow_patterns);
  const denyPatterns = compilePatterns([...HARD_DENY_PATTERNS, ...config.deny_patterns], true);

  const repoRoot = params.provisionRepoRoot ? path.resolve(params.provisionRepoRoot) : null;
  if (!repoRoot) {
    throw new WorkspaceError('workspace_copy_ignored_source_not_found', 'copy source repo root is not configured');
  }

  const sourcePath =
    config.from === 'repo_root' ? repoRoot : await resolvePrimaryWorktreePath(repoRoot);

  const sourceStat = await fs.stat(sourcePath).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    throw new WorkspaceError('workspace_copy_ignored_source_not_found', `copy source not found: ${sourcePath}`);
  }
  if (!isContainedPath(sourcePath, includeFile)) {
    throw new WorkspaceError('workspace_copy_ignored_invalid_config', 'include file must be within the source repository');
  }
  if (includePatterns.length === 0) {
    return {
      status: 'skipped',
      source_path: sourcePath,
      include_file: includeFile,
      conflict_policy: conflictPolicy,
      copied_files: 0,
      skipped_existing: 0,
      blocked_files: 0,
      bytes_copied: 0,
      duration_ms: Math.max(0, nowMs() - started),
      warning: 'include file has no active patterns'
    };
  }

  const workspaceResolved = path.resolve(params.workspacePath);
  const allFiles = await listFilesRecursive(sourcePath);
  const candidates = allFiles.filter((rel) => matchesAny(rel, includePatterns));

  let copiedFiles = 0;
  let skippedExisting = 0;
  let blockedFiles = 0;
  let bytesCopied = 0;

  for (const rel of candidates) {
    const normalized = toPosix(rel);
    if (isUnsafePattern(normalized)) {
      throw new WorkspaceError('workspace_copy_ignored_invalid_config', `unsafe candidate path: ${normalized}`);
    }

    if (matchesAny(normalized, denyPatterns)) {
      blockedFiles += 1;
      continue;
    }
    if (allowPatterns.length > 0 && !matchesAny(normalized, allowPatterns)) {
      continue;
    }

    if (config.require_gitignored) {
      const ignored = await isGitIgnored(sourcePath, normalized);
      if (!ignored) {
        continue;
      }
    }

    if (copiedFiles + skippedExisting + blockedFiles + 1 > config.max_files) {
      throw new WorkspaceError('workspace_copy_ignored_limits_exceeded', 'max_files limit exceeded');
    }

    const sourceFile = path.resolve(sourcePath, rel);
    const targetFile = path.resolve(workspaceResolved, rel);
    if (isContainedPath(workspaceResolved, targetFile)) {
      await fs.mkdir(path.dirname(targetFile), { recursive: true });
    } else {
      throw new WorkspaceError('workspace_copy_ignored_invalid_config', `target path escapes workspace: ${rel}`);
    }

    const sourceLstat = await fs.lstat(sourceFile);
    if (sourceLstat.isSymbolicLink()) {
      blockedFiles += 1;
      continue;
    }
    const targetLstat = await fs.lstat(targetFile).catch(() => null);
    if (targetLstat?.isSymbolicLink()) {
      throw new WorkspaceError('workspace_copy_ignored_invalid_config', `destination is a symbolic link: ${rel}`);
    }
    const targetParent = await fs.realpath(path.dirname(targetFile));
    if (!isContainedPath(workspaceResolved, targetParent)) {
      throw new WorkspaceError('workspace_copy_ignored_invalid_config', `destination parent escapes workspace: ${rel}`);
    }
    const targetExists = targetLstat !== null;
    if (targetExists) {
      if (conflictPolicy === 'skip') {
        skippedExisting += 1;
        continue;
      }
      if (conflictPolicy === 'fail') {
        throw new WorkspaceError('workspace_copy_ignored_invalid_config', `destination conflict: ${rel}`);
      }
    }

    const sourceStatFile = sourceLstat;
    if (bytesCopied + sourceStatFile.size > config.max_total_bytes) {
      throw new WorkspaceError('workspace_copy_ignored_limits_exceeded', 'max_total_bytes limit exceeded');
    }

    await fs.cp(sourceFile, targetFile, { recursive: false, force: conflictPolicy === 'overwrite', errorOnExist: false });
    copiedFiles += 1;
    bytesCopied += sourceStatFile.size;
  }

  return {
    status: 'success',
    source_path: sourcePath,
    include_file: includeFile,
    conflict_policy: conflictPolicy,
    copied_files: copiedFiles,
    skipped_existing: skippedExisting,
    blocked_files: blockedFiles,
    bytes_copied: bytesCopied,
    duration_ms: Math.max(0, nowMs() - started)
  };
}
