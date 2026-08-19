import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/worktree_bootstrap.py');
const GIT_WORKTREE_INTEGRATION_TEST_TIMEOUT_MS = 30_000;

function run(cmd: string, args: string[], cwd: string): void {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function runBootstrap(args: string[], cwd: string) {
  return spawnSync('python3', [SCRIPT_PATH, ...args], {
    cwd,
    encoding: 'utf8'
  });
}

describe('worktree_bootstrap.py', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const targetPath of cleanupPaths.splice(0)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
  });

  it('auto-resolves source from sibling worktree when --source is omitted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-worktree-bootstrap-'));
    cleanupPaths.push(root);
    const primary = path.join(root, 'primary');
    const target = path.join(root, 'target');
    fs.mkdirSync(primary, { recursive: true });

    run('git', ['init'], primary);
    run('git', ['config', 'user.email', 'test@example.com'], primary);
    run('git', ['config', 'user.name', 'Test User'], primary);
    run('git', ['checkout', '-b', 'main'], primary);
    fs.writeFileSync(path.join(primary, '.gitignore'), '.cache/\n');
    fs.writeFileSync(path.join(primary, '.worktreeinclude'), '.cache/**\n');
    fs.writeFileSync(path.join(primary, 'README.md'), 'root\n');
    run('git', ['add', '.gitignore', '.worktreeinclude', 'README.md'], primary);
    run('git', ['commit', '-m', 'init'], primary);

    fs.mkdirSync(path.join(primary, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(primary, '.cache', 'artifact.txt'), 'hello\n');

    run('git', ['worktree', 'add', target, '-b', 'feature/NIE-BOOTSTRAP'], primary);

    const result = runBootstrap([], target);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(target, '.cache', 'artifact.txt'))).toBe(true);
  }, GIT_WORKTREE_INTEGRATION_TEST_TIMEOUT_MS);

  it('treats a standalone clone with an inactive include policy as a safe no-op', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-clone-bootstrap-'));
    cleanupPaths.push(root);
    const source = path.join(root, 'source');
    const clone = path.join(root, 'clone');
    fs.mkdirSync(source, { recursive: true });
    run('git', ['init'], source);
    run('git', ['config', 'user.email', 'test@example.com'], source);
    run('git', ['config', 'user.name', 'Test User'], source);
    run('git', ['checkout', '-b', 'main'], source);
    fs.writeFileSync(path.join(source, '.worktreeinclude'), '# no ignored artifacts requested\n');
    fs.writeFileSync(path.join(source, 'README.md'), 'root\n');
    run('git', ['add', '.worktreeinclude', 'README.md'], source);
    run('git', ['commit', '-m', 'init'], source);
    run('git', ['clone', '--no-hardlinks', source, clone], root);

    const result = runBootstrap([], clone);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('include file has no active patterns; copied nothing');
  });

  it('uses current working directory as default target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-worktree-bootstrap-'));
    cleanupPaths.push(root);
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(target, { recursive: true });

    run('git', ['init'], source);
    run('git', ['config', 'user.email', 'test@example.com'], source);
    run('git', ['config', 'user.name', 'Test User'], source);

    fs.writeFileSync(path.join(source, '.gitignore'), '.cache/\n');
    fs.mkdirSync(path.join(source, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(source, '.cache', 'artifact.txt'), 'hello\n');
    fs.writeFileSync(path.join(source, '.worktreeinclude'), '.cache/**\n');

    run('git', ['init'], target);
    run('git', ['config', 'user.email', 'test@example.com'], target);
    run('git', ['config', 'user.name', 'Test User'], target);

    const result = runBootstrap(['--source', source], target);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(target, '.cache', 'artifact.txt'))).toBe(true);
  });

  it('does not overcount copied files when destination already exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-worktree-bootstrap-'));
    cleanupPaths.push(root);
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(target, { recursive: true });

    run('git', ['init'], source);
    run('git', ['config', 'user.email', 'test@example.com'], source);
    run('git', ['config', 'user.name', 'Test User'], source);

    fs.writeFileSync(path.join(source, '.gitignore'), '.cache/\n');
    fs.mkdirSync(path.join(source, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(source, '.cache', 'artifact.txt'), 'hello\n');
    fs.writeFileSync(path.join(source, '.worktreeinclude'), '.cache/**\n');

    run('git', ['init'], target);
    run('git', ['config', 'user.email', 'test@example.com'], target);
    run('git', ['config', 'user.name', 'Test User'], target);

    fs.mkdirSync(path.join(target, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(target, '.cache', 'artifact.txt'), 'existing\n');

    const result = runBootstrap(['--source', source, '--target', target], root);
    expect(result.status).toBe(0);

    const summaryLine = result.stdout
      .trim()
      .split('\n')
      .find((line) => {
        try {
          const parsed = JSON.parse(line) as { action?: string; selected?: number };
          return parsed.action === 'summary' && typeof parsed.selected === 'number';
        } catch {
          return false;
        }
      });

    expect(summaryLine).toBeTruthy();
    const summary = JSON.parse(summaryLine as string) as { copied: number; selected: number };
    expect(summary.selected).toBe(1);
    expect(summary.copied).toBe(0);
  });

  it('hard-denies dotenv, auth-store, package-manager auth, and key material even when explicitly included', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-worktree-bootstrap-sensitive-'));
    cleanupPaths.push(root);
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    run('git', ['init'], source);
    run('git', ['config', 'user.email', 'test@example.com'], source);
    run('git', ['config', 'user.name', 'Test User'], source);
    run('git', ['init'], target);
    fs.writeFileSync(path.join(source, '.gitignore'), '.env*\n.claude.json\n.mcp.json\n.npmrc\n.pnpmrc\n.git-credentials\ncredentials.json\n*service-account*.json\n*.pem\ntokenizer-cache.bin\n');
    fs.writeFileSync(path.join(source, '.worktreeinclude'), '.env*\n.claude.json\n.mcp.json\n.npmrc\n.pnpmrc\n.git-credentials\ncredentials.json\n*service-account*.json\n*.pem\ntokenizer-cache.bin\n');
    for (const name of ['.env', '.env.local', '.claude.json', '.mcp.json', '.npmrc', '.pnpmrc', '.git-credentials', 'credentials.json', 'deploy-service-account.json', 'client.pem', 'tokenizer-cache.bin']) {
      fs.writeFileSync(path.join(source, name), 'must-not-copy\n');
    }

    const result = runBootstrap(['--source', source, '--target', target], root);
    expect(result.status).toBe(0);
    for (const name of ['.env', '.env.local', '.claude.json', '.mcp.json', '.npmrc', '.pnpmrc', '.git-credentials', 'credentials.json', 'deploy-service-account.json', 'client.pem']) {
      expect(fs.existsSync(path.join(target, name))).toBe(false);
    }
    expect(fs.existsSync(path.join(target, 'tokenizer-cache.bin'))).toBe(true);
    expect(result.stdout).toContain('sensitive path is hard-denied');
  });

  it('refuses selected source symlinks consistently with the TypeScript bootstrap path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-worktree-bootstrap-symlink-'));
    cleanupPaths.push(root);
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    run('git', ['init'], source);
    run('git', ['config', 'user.email', 'test@example.com'], source);
    run('git', ['config', 'user.name', 'Test User'], source);
    run('git', ['init'], target);
    fs.writeFileSync(path.join(source, '.gitignore'), 'cache-link\n');
    fs.writeFileSync(path.join(source, '.worktreeinclude'), 'cache-link\n');
    fs.writeFileSync(path.join(source, 'cache-target'), 'ignored artifact\n');
    fs.symlinkSync('cache-target', path.join(source, 'cache-link'));

    const result = runBootstrap(['--source', source, '--target', target], root);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('refusing to copy symlink: cache-link');
    expect(fs.existsSync(path.join(target, 'cache-link'))).toBe(false);
  });

  it('rejects the removed legacy --allow-sensitive escape hatch', () => {
    const result = runBootstrap(['--allow-sensitive'], process.cwd());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unrecognized arguments: --allow-sensitive');
  });
});
