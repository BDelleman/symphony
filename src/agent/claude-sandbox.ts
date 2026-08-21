import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX_PROBE_TIMEOUT_MS = 5_000;
const SANDBOX_PROBE_MAX_BUFFER_BYTES = 64 * 1024;

export interface ClaudeSandboxPathSnapshot {
  protectedPaths: string[];
  skippedMissingCount: number;
  collapsedCount: number;
  fingerprint: string;
}

export interface ClaudeSandboxRuntimeProbe {
  ready: boolean;
  fingerprint: string;
  reason: string;
  dependencies: Array<{ name: string; executablePath: string }>;
  stderrBytes: number;
  stderrSha256: string | null;
}

export function claudeSandboxProtectedPathCandidates(params: {
  executable: string;
  workspace: string;
  projectRoot: string;
  projectSensitivePaths: string[];
  home: string;
  additionalProtectedPaths?: string[];
}): string[] {
  return [
    path.dirname(params.executable),
    path.join(params.workspace, '.env'),
    path.join(params.home, '.claude'),
    path.join(params.home, '.aws'),
    path.join(params.home, '.azure'),
    path.join(params.home, '.claude.json'),
    path.join(params.home, '.config', 'gh'),
    path.join(params.home, '.config', 'gcloud'),
    path.join(params.home, '.config', 'containers'),
    path.join(params.home, '.config', 'pip'),
    path.join(params.home, '.config', 'pypoetry'),
    path.join(params.home, '.cargo'),
    path.join(params.home, '.composer'),
    path.join(params.home, '.docker'),
    path.join(params.home, '.kube'),
    path.join(params.home, '.git-credentials'),
    path.join(params.home, '.netrc'),
    path.join(params.home, '.authinfo'),
    path.join(params.home, '.npmrc'),
    path.join(params.home, '.pnpmrc'),
    path.join(params.home, '.pypirc'),
    path.join(params.home, '.ssh'),
    path.join(params.home, '.terraform.d'),
    path.join(params.home, '.yarnrc'),
    path.join(params.home, '.yarnrc.yml'),
    ...params.projectSensitivePaths,
    ...(params.additionalProtectedPaths ?? []),
    path.join(path.dirname(params.projectRoot), '.symphony-quarantine')
  ];
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function createClaudeSandboxPathSnapshot(candidates: readonly string[]): ClaudeSandboxPathSnapshot {
  let skippedMissingCount = 0;
  const resolved = new Map<string, { isDirectory: boolean; identity: string }>();

  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        skippedMissingCount += 1;
        continue;
      }
      throw new Error('claude_sandbox_protected_path_unreadable');
    }

    let canonical = absolute;
    if (lstat.isSymbolicLink()) {
      try {
        canonical = fs.realpathSync(absolute);
      } catch {
        throw new Error('claude_sandbox_protected_path_unsafe');
      }
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(canonical);
    } catch {
      throw new Error('claude_sandbox_protected_path_unreadable');
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error('claude_sandbox_protected_path_unsafe');
    }
    resolved.set(canonical, {
      isDirectory: stat.isDirectory(),
      identity: stat.isDirectory() ? 'directory' : 'file'
    });
  }

  const ordered = [...resolved.entries()].sort(([left], [right]) => {
    const depthDelta = left.split(path.sep).length - right.split(path.sep).length;
    return depthDelta || left.localeCompare(right);
  });
  const retained: Array<[string, { isDirectory: boolean; identity: string }]> = [];
  let collapsedCount = 0;
  for (const entry of ordered) {
    if (retained.some(([ancestor, metadata]) => metadata.isDirectory && isInside(ancestor, entry[0]))) {
      collapsedCount += 1;
      continue;
    }
    retained.push(entry);
  }

  const protectedPaths = retained.map(([candidate]) => candidate);
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(retained.map(([candidate, metadata]) => [candidate, metadata.identity])))
    .digest('hex');
  return { protectedPaths, skippedMissingCount, collapsedCount, fingerprint };
}

function executableIdentity(executablePath: string): string {
  const canonical = fs.realpathSync(executablePath);
  const stat = fs.statSync(canonical);
  return `${canonical}:${stat.dev}:${stat.ino}:${stat.mode & 0o777}`;
}

function probeFailure(
  reason: string,
  dependencies: Array<{ name: string; executablePath: string }>,
  output: string | Buffer | null | undefined
): ClaudeSandboxRuntimeProbe {
  const stderr = Buffer.isBuffer(output) ? output : Buffer.from(output ?? '', 'utf8');
  return {
    ready: false,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(dependencies)).update(reason).digest('hex'),
    reason,
    dependencies,
    stderrBytes: stderr.length,
    stderrSha256: stderr.length > 0 ? crypto.createHash('sha256').update(stderr).digest('hex') : null
  };
}

export function probeClaudeSandboxRuntime(params: {
  platform: NodeJS.Platform;
  bwrapExecutable?: string | null;
  socatExecutable?: string | null;
  env: NodeJS.ProcessEnv;
}): ClaudeSandboxRuntimeProbe {
  if (params.platform !== 'linux') {
    return {
      ready: true,
      fingerprint: `platform:${params.platform}`,
      reason: 'claude_sandbox_probe_not_required',
      dependencies: [],
      stderrBytes: 0,
      stderrSha256: null
    };
  }

  if (!params.bwrapExecutable || !params.socatExecutable) {
    return probeFailure('claude_sandbox_dependency_missing', [], null);
  }
  let dependencies: Array<{ name: string; executablePath: string }>;
  try {
    dependencies = [
      { name: 'bwrap', executablePath: fs.realpathSync(params.bwrapExecutable) },
      { name: 'socat', executablePath: fs.realpathSync(params.socatExecutable) }
    ];
  } catch {
    return probeFailure('claude_sandbox_dependency_invalid', [], null);
  }
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-sandbox-probe-'));
  const deniedDirectory = path.join(probeRoot, 'denied');
  fs.mkdirSync(deniedDirectory, { mode: 0o700 });
  try {
    const socatVersion = spawnSync(params.socatExecutable, ['-V'], {
      env: params.env,
      encoding: 'utf8',
      shell: false,
      timeout: SANDBOX_PROBE_TIMEOUT_MS,
      maxBuffer: SANDBOX_PROBE_MAX_BUFFER_BYTES
    });
    if (socatVersion.status !== 0 || socatVersion.error) {
      return probeFailure('claude_sandbox_socat_probe_failed', dependencies, socatVersion.stderr);
    }

    const bwrapVersion = spawnSync(params.bwrapExecutable, ['--version'], {
      env: params.env,
      encoding: 'utf8',
      shell: false,
      timeout: SANDBOX_PROBE_TIMEOUT_MS,
      maxBuffer: SANDBOX_PROBE_MAX_BUFFER_BYTES
    });
    if (bwrapVersion.status !== 0 || bwrapVersion.error) {
      return probeFailure('claude_sandbox_bwrap_version_failed', dependencies, bwrapVersion.stderr);
    }

    const canary = spawnSync(params.bwrapExecutable, [
      '--die-with-parent',
      '--unshare-user',
      '--unshare-pid',
      '--unshare-net',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', deniedDirectory,
      '--', process.execPath, '-e', ''
    ], {
      env: params.env,
      encoding: 'utf8',
      shell: false,
      timeout: SANDBOX_PROBE_TIMEOUT_MS,
      maxBuffer: SANDBOX_PROBE_MAX_BUFFER_BYTES
    });
    if (canary.status !== 0 || canary.error) {
      return probeFailure('claude_sandbox_bwrap_canary_failed', dependencies, canary.stderr);
    }

    let fingerprint: string;
    try {
      fingerprint = crypto.createHash('sha256')
        .update(dependencies.map((dependency) => executableIdentity(dependency.executablePath)).join('\n'))
        .update(bwrapVersion.stdout ?? '')
        .update(socatVersion.stdout ?? '')
        .digest('hex');
    } catch {
      return probeFailure('claude_sandbox_dependency_invalid', dependencies, null);
    }
    return {
      ready: true,
      fingerprint,
      reason: 'claude_sandbox_ready',
      dependencies,
      stderrBytes: 0,
      stderrSha256: null
    };
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}
