import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createClaudeSandboxPathSnapshot,
  probeClaudeSandboxRuntime
} from '../../src/agent/claude-sandbox';

function writeExecutable(filePath: string, body: string): void {
  fs.writeFileSync(filePath, body, { mode: 0o755 });
}

describe('Claude sandbox policy', () => {
  it('retains only existing canonical paths and collapses covered descendants', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-sandbox-paths-'));
    const protectedDirectory = path.join(root, 'credentials');
    const nestedFile = path.join(protectedDirectory, 'token');
    fs.mkdirSync(protectedDirectory);
    fs.writeFileSync(nestedFile, 'secret');
    const symlink = path.join(root, 'credential-link');
    fs.symlinkSync(protectedDirectory, symlink);

    const snapshot = createClaudeSandboxPathSnapshot([
      path.join(root, 'missing'),
      nestedFile,
      protectedDirectory,
      symlink
    ]);

    expect(snapshot.protectedPaths).toEqual([fs.realpathSync(protectedDirectory)]);
    expect(snapshot.skippedMissingCount).toBe(1);
    expect(snapshot.collapsedCount).toBe(1);
    expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed for a broken protected-path symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-sandbox-broken-'));
    const symlink = path.join(root, 'credential-link');
    fs.symlinkSync(path.join(root, 'missing-target'), symlink);

    expect(() => createClaudeSandboxPathSnapshot([symlink]))
      .toThrow('claude_sandbox_protected_path_unsafe');
  });

  it('runs the Linux dependency and namespace canary without model usage', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-sandbox-probe-'));
    const bwrap = path.join(root, 'bwrap');
    const socat = path.join(root, 'socat');
    writeExecutable(bwrap, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bubblewrap 1"; fi\nexit 0\n');
    writeExecutable(socat, '#!/bin/sh\necho "socat 1"\nexit 0\n');

    const result = probeClaudeSandboxRuntime({
      platform: 'linux',
      bwrapExecutable: bwrap,
      socatExecutable: socat,
      env: { PATH: root }
    });

    expect(result).toMatchObject({
      ready: true,
      reason: 'claude_sandbox_ready',
      stderrBytes: 0,
      stderrSha256: null
    });
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a sanitized Linux canary failure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-sandbox-probe-fail-'));
    const bwrap = path.join(root, 'bwrap');
    const socat = path.join(root, 'socat');
    writeExecutable(
      bwrap,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bubblewrap 1"; exit 0; fi\necho "sensitive bwrap detail" >&2\nexit 1\n'
    );
    writeExecutable(socat, '#!/bin/sh\necho "socat 1"\nexit 0\n');

    const result = probeClaudeSandboxRuntime({
      platform: 'linux',
      bwrapExecutable: bwrap,
      socatExecutable: socat,
      env: { PATH: root }
    });

    expect(result).toMatchObject({
      ready: false,
      reason: 'claude_sandbox_bwrap_canary_failed',
      stderrBytes: 23
    });
    expect(result.stderrSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain('sensitive bwrap detail');
  });
});
