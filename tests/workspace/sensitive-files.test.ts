import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { auditSensitiveWorkspaceFiles } from '../../src/workspace';

describe('managed workspace sensitive-file audit', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
  });

  it('reports only normalized path, category, mode, and internal absolute path metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-sensitive-audit-'));
    cleanup.push(root);
    await fs.mkdir(path.join(root, 'NIE-1', '.ssh'), { recursive: true });
    await fs.writeFile(path.join(root, 'NIE-1', '.env.local'), 'SECRET=never-report-this\n', { mode: 0o600 });
    await fs.writeFile(path.join(root, 'NIE-1', '.ssh', 'id_ed25519'), 'private-key-material\n', { mode: 0o600 });
    await fs.writeFile(path.join(root, 'NIE-1', 'README.md'), 'safe\n', 'utf8');

    const audit = auditSensitiveWorkspaceFiles(root);

    expect(audit.complete).toBe(true);
    expect(audit.violations.map(({ path: violationPath, category, mode }) => ({ path: violationPath, category, mode }))).toEqual(
      expect.arrayContaining([
        { path: 'NIE-1/.env.local', category: 'dotenv', mode: '0600' },
        { path: 'NIE-1/.ssh', category: 'ssh_credentials', mode: expect.any(String) }
      ])
    );
    expect(JSON.stringify(audit)).not.toContain('never-report-this');
    expect(JSON.stringify(audit)).not.toContain('private-key-material');
  });

  it('allows canonical tracked dotenv templates but rejects package auth and escaping symlinks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-sensitive-templates-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-sensitive-outside-'));
    cleanup.push(root, outside);
    await fs.writeFile(path.join(root, '.env.example'), 'LINEAR_API_KEY=\n', 'utf8');
    await fs.writeFile(path.join(root, '.env.sample'), 'TOKEN=\n', 'utf8');
    spawnSync('git', ['init'], { cwd: root, shell: false });
    spawnSync('git', ['add', '.env.example', '.env.sample'], { cwd: root, shell: false });
    spawnSync('git', ['-c', 'user.name=Symphony Test', '-c', 'user.email=symphony@example.test', 'commit', '-m', 'test fixtures'], {
      cwd: root,
      shell: false
    });
    await fs.writeFile(path.join(root, '.pnpmrc'), '//registry.example/:_authToken=secret\n', 'utf8');
    await fs.writeFile(path.join(outside, 'credential'), 'secret\n', 'utf8');
    await fs.symlink(path.join(outside, 'credential'), path.join(root, 'cache'));

    const audit = auditSensitiveWorkspaceFiles(root);
    expect(audit.violations.map((violation) => violation.path)).toEqual(expect.arrayContaining(['.pnpmrc', 'cache']));
    expect(audit.violations.map((violation) => violation.path)).not.toContain('.env.example');
    expect(audit.violations.map((violation) => violation.path)).not.toContain('.env.sample');

    await fs.writeFile(path.join(root, '.env.template'), 'SECRET=real-value\n', 'utf8');
    const retryResidueAudit = auditSensitiveWorkspaceFiles(root);
    expect(retryResidueAudit.violations.map((violation) => violation.path)).toContain('.env.template');
  });

  it('audits dependency trees for nested credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-sensitive-dependencies-'));
    cleanup.push(root);
    await fs.mkdir(path.join(root, 'node_modules', 'package'), { recursive: true });
    await fs.mkdir(path.join(root, '.venv', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'package', '.git-credentials'), 'secret\n');
    await fs.writeFile(path.join(root, '.venv', 'nested', '.env'), 'SECRET=secret\n');

    const audit = auditSensitiveWorkspaceFiles(root);
    expect(audit.complete).toBe(true);
    expect(audit.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'node_modules/package/.git-credentials', category: 'package_manager_auth' }),
      expect.objectContaining({ path: '.venv/nested/.env', category: 'dotenv' })
    ]));
  });

  it('detects container, Terraform, and service-account credential files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-sensitive-cloud-auth-'));
    cleanup.push(root);
    for (const relativePath of [
      '.docker/config.json',
      '.config/containers/auth.json',
      '.terraform.d/credentials.tfrc.json',
      'credentials.json',
      'deploy-service-account-key.json'
    ]) {
      await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
      await fs.writeFile(path.join(root, relativePath), 'secret\n');
    }

    expect(auditSensitiveWorkspaceFiles(root).violations.map((violation) => violation.path)).toEqual(
      expect.arrayContaining([
        '.docker',
        '.config/containers',
        '.terraform.d',
        'credentials.json',
        'deploy-service-account-key.json'
      ])
    );
  });

  it('does not exempt credential files placed in a workspace quarantine-shaped path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-sensitive-fake-quarantine-'));
    cleanup.push(root);
    const credential = path.join(root, '.symphony', 'system', 'quarantine', 'fake', '.git-credentials');
    await fs.mkdir(path.dirname(credential), { recursive: true });
    await fs.writeFile(credential, 'secret\n');

    expect(auditSensitiveWorkspaceFiles(root).violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '.symphony/system/quarantine/fake/.git-credentials',
        category: 'package_manager_auth'
      })
    ]));
  });
});
