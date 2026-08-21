import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { CodexRunnerError } from '../errors';
import { buildSshSpawnArgs } from '../ssh-target';
import { stripReviewerCredentials } from '../../review/credential-boundary';

interface RunnerProcess {
  pid?: number | null;
  stdin: { write: (data: string) => void };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals | number) => void;
  once: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
}

type SpawnProcess = (params: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd: string;
  workerHost?: string;
}) => RunnerProcess;

const PROCESS_CANCEL_GRACE_MS = 500;
const PROCESS_CANCEL_FORCE_SETTLE_MS = 100;
function workerEnvironment(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return stripReviewerCredentials({ ...process.env, ...(overrides ?? {}) });
}

function renderShellCommand(command: string, args?: string[], env?: Record<string, string>): string {
  const commandWithArgs = args ? [command, ...args].map(shellEscape).join(' ') : command;
  const envPrefix = Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${shellEscape(value)}`)
    .join(' ');
  return envPrefix ? `${envPrefix} ${commandWithArgs}` : commandWithArgs;
}

function defaultSpawnProcess(params: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd: string;
  workerHost?: string;
}): RunnerProcess {
  const workerHost = params.workerHost?.trim();
  if (workerHost) {
    const remoteCommand = `cd ${shellEscape(params.cwd)} && exec ${renderShellCommand(params.command, params.args, params.env)}`;
    const child: ChildProcessWithoutNullStreams = spawn('ssh', buildSshSpawnArgs(workerHost, remoteCommand), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: workerEnvironment(undefined)
    });

    return child;
  }

  const child: ChildProcessWithoutNullStreams = params.args
    ? spawn(params.command, params.args, {
        cwd: params.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: workerEnvironment(params.env)
      })
    : spawn('bash', ['-lc', params.command], {
        cwd: params.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: workerEnvironment(params.env)
      });

  return child;
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : 'worker_cancelled';
}

function createCancellationError(signal: AbortSignal | undefined, outcome = 'requested'): CodexRunnerError {
  return new CodexRunnerError('turn_cancelled', `worker_cancelled:${abortReason(signal)}:${outcome}`);
}

function waitForProcessExit(
  processHandle: RunnerProcess,
  timeoutMs: number
): Promise<'exited' | 'timeout'> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('timeout'), timeoutMs);
    processHandle.once('exit', () => {
      clearTimeout(timeout);
      resolve('exited');
    });
  });
}

function createProcessCancellation(params: {
  processHandle: RunnerProcess;
  signal?: AbortSignal;
}): {
  withCancellation: <T>(promise: Promise<T>) => Promise<T>;
  cancellationRequested: () => boolean;
  waitForCancellation: () => Promise<CodexRunnerError | null>;
  dispose: () => void;
} {
  const { processHandle, signal } = params;
  let cancellationSettled: Promise<void> | null = null;
  let rejectCancellation: ((error: CodexRunnerError) => void) | null = null;
  let cancellationRejected = false;
  let cancellationError: CodexRunnerError | null = null;

  const cancellationPromise = new Promise<never>((_, reject) => {
    rejectCancellation = (error) => {
      if (!cancellationRejected) {
        cancellationRejected = true;
        cancellationError = error;
        reject(error);
      }
    };
  });
  // Prevent late aborts after a completed turn from surfacing as unhandled rejections.
  cancellationPromise.catch(() => undefined);

  const requestCancellation = () => {
    if (cancellationSettled) {
      return;
    }

    cancellationSettled = (async () => {
      processHandle.kill('SIGTERM');
      const gracefulExit = await waitForProcessExit(processHandle, PROCESS_CANCEL_GRACE_MS);
      if (gracefulExit !== 'exited') {
        processHandle.kill('SIGKILL');
        const forcedExit = await waitForProcessExit(processHandle, PROCESS_CANCEL_FORCE_SETTLE_MS);
        rejectCancellation?.(
          createCancellationError(signal, forcedExit === 'exited' ? 'forced_kill_exited' : 'forced_kill_requested')
        );
        return;
      }
      rejectCancellation?.(createCancellationError(signal, 'graceful_exit'));
    })();
  };

  if (signal?.aborted) {
    requestCancellation();
  } else {
    signal?.addEventListener('abort', requestCancellation, { once: true });
  }

  return {
    withCancellation: <T>(promise: Promise<T>): Promise<T> => {
      if (!signal) {
        return promise;
      }
      if (signal.aborted) {
        requestCancellation();
      }
      return Promise.race([promise, cancellationPromise]);
    },
    cancellationRequested: () => Boolean(signal?.aborted),
    waitForCancellation: async () => {
      await cancellationSettled;
      return cancellationError;
    },
    dispose: () => {
      signal?.removeEventListener('abort', requestCancellation);
    }
  };
}

function assertWorkspaceCwd(workspaceCwd: string): void {
  if (!path.isAbsolute(workspaceCwd)) {
    throw new CodexRunnerError('invalid_workspace_cwd', 'Workspace cwd must be an absolute path');
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(workspaceCwd);
  } catch {
    throw new CodexRunnerError('invalid_workspace_cwd', `Workspace cwd does not exist: ${workspaceCwd}`);
  }

  if (!stat.isDirectory()) {
    throw new CodexRunnerError('invalid_workspace_cwd', `Workspace cwd is not a directory: ${workspaceCwd}`);
  }
}

function assertRemoteWorkspaceCwd(workspaceCwd: string): void {
  if (!workspaceCwd.trim()) {
    throw new CodexRunnerError('invalid_remote_workspace_cwd', 'Remote workspace cwd must be non-empty');
  }

  if (workspaceCwd.includes('\n') || workspaceCwd.includes('\r') || workspaceCwd.includes('\u0000')) {
    throw new CodexRunnerError('invalid_remote_workspace_cwd', 'Remote workspace cwd contains invalid characters');
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export { abortReason, assertRemoteWorkspaceCwd, assertWorkspaceCwd, createCancellationError, createProcessCancellation, defaultSpawnProcess, shellEscape };
export type { RunnerProcess, SpawnProcess };
