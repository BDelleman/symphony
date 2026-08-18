import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { CANONICAL_EVENT } from '../observability/events';
import { REASON_CODES } from '../observability/reason-codes';
import type {
  AgentRunResult,
  AgentRunner,
  AgentRunnerEvent,
  AgentRunnerResumeInput,
  AgentRunnerStartInput,
  ProviderUsage
} from './types';

export const CLAUDE_SUPPORTED_VERSION = '2.1.224';
const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_DETAIL_BYTES = 16 * 1024;
const HEARTBEAT_MS = 5_000;
const TERMINATION_GRACE_MS = 5_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NON_SUBSCRIPTION_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS'
] as const;

export interface ClaudeCliRunnerOptions {
  command: string;
  model: string;
  allowNonSubscriptionAuth: boolean;
  supportedVersion?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  now?: () => Date;
}

interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  subscriptionType: string | null;
}

interface ParsedProtocolState {
  sessionId: string | null;
  effectiveModel: string | null;
  capabilityFingerprint: string | null;
  terminalResult: Record<string, unknown> | null;
  terminalResultCount: number;
  unknownEventCount: number;
  lastEvent: string;
  protocolError: string | null;
}

interface ClaudeSessionBinding {
  project_identity: string;
  issue_id: string;
  issue_identifier: string;
  attempt: number | null;
  workspace_realpath: string;
  model: string;
  os_user: number | string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readFiniteNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function trimUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string {
  if (command.includes(path.sep)) {
    const absolute = path.resolve(command);
    const resolved = fs.realpathSync(absolute);
    fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  }

  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`claude_executable_not_found:${command}`);
}

function userSettingSelectors(home: string): string[] {
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as unknown;
    const settings = asRecord(parsed);
    if (!settings) throw new Error('settings_not_object');
    const selectors = settings.apiKeyHelper ? ['apiKeyHelper'] : [];
    const settingsEnv = asRecord(settings.env);
    if (settingsEnv) {
      selectors.push(
        ...NON_SUBSCRIPTION_ENV_NAMES.filter((name) => {
          const value = settingsEnv[name];
          return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
        })
      );
    }
    return [...new Set(selectors)];
  } catch (error) {
    throw new Error(`claude_user_settings_unreadable:${error instanceof Error ? error.message : String(error)}`);
  }
}

function readAuthStatus(executable: string, cwd: string, env: NodeJS.ProcessEnv): ClaudeAuthStatus {
  const result = spawnSync(executable, ['auth', 'status', '--json'], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false
  });
  if (result.status !== 0) {
    throw new Error('claude_auth_not_ready');
  }
  const payload = asRecord(JSON.parse(result.stdout));
  if (!payload) {
    throw new Error('claude_auth_status_invalid');
  }
  return {
    loggedIn: payload.loggedIn === true,
    authMethod: readString(payload, 'authMethod'),
    apiProvider: readString(payload, 'apiProvider'),
    subscriptionType: readString(payload, 'subscriptionType')
  };
}

function assertApprovedAuth(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  home: string,
  allowNonSubscriptionAuth: boolean
): void {
  const selectors: string[] = [
    ...NON_SUBSCRIPTION_ENV_NAMES.filter((name) => Boolean(env[name]?.trim())),
    ...userSettingSelectors(home)
  ];
  if (!allowNonSubscriptionAuth && selectors.length > 0) {
    throw new Error(`claude_non_subscription_auth_forbidden:${[...new Set(selectors)].join(',')}`);
  }
  const auth = readAuthStatus(executable, cwd, env);
  if (allowNonSubscriptionAuth) return;
  if (
    !auth.loggedIn ||
    auth.authMethod !== 'claude.ai' ||
    auth.apiProvider !== 'firstParty' ||
    !['team', 'enterprise'].includes(auth.subscriptionType ?? '')
  ) {
    throw new Error('claude_subscription_auth_required');
  }
}

function isRetryableClaudeFailure(code: string): boolean {
  return (
    code.startsWith('claude_process_exit:') ||
    /rate.?limit|overload|network|server|temporar|unavailable|api_retry/i.test(code)
  );
}

function assertSupportedVersion(executable: string, cwd: string, env: NodeJS.ProcessEnv, supported: string): void {
  const result = spawnSync(executable, ['--version'], { cwd, env, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error('claude_version_unavailable');
  const match = result.stdout.match(/\b\d+\.\d+\.\d+\b/);
  if (match?.[0] !== supported) {
    throw new Error(`claude_version_unsupported:expected=${supported}:actual=${match?.[0] ?? 'unknown'}`);
  }
}

function buildCapabilityFingerprint(payload: Record<string, unknown>): string {
  const normalized = {
    tools: Array.isArray(payload.tools) ? payload.tools.map(String).sort() : [],
    mcp_servers: Array.isArray(payload.mcp_servers)
      ? payload.mcp_servers
          .map((entry) => {
            const record = asRecord(entry);
            return record ? { name: readString(record, 'name'), status: readString(record, 'status') } : null;
          })
          .filter(Boolean)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : [],
    plugins: Array.isArray(payload.plugins)
      ? payload.plugins
          .map((entry) => readString(asRecord(entry) ?? {}, 'name'))
          .filter(Boolean)
          .sort()
      : []
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function usageFromResult(result: Record<string, unknown>, model: string | null): ProviderUsage {
  const usage = asRecord(result.usage) ?? {};
  return {
    runtime: 'claude-cli',
    model,
    input_tokens: readFiniteNumber(usage, 'input_tokens'),
    output_tokens: readFiniteNumber(usage, 'output_tokens'),
    cache_read_tokens: readFiniteNumber(usage, 'cache_read_input_tokens'),
    cache_creation_tokens: readFiniteNumber(usage, 'cache_creation_input_tokens'),
    provider_turn_count: readFiniteNumber(result, 'num_turns'),
    estimated_cost_usd: readFiniteNumber(result, 'total_cost_usd'),
    source: 'claude_stream_result',
    confidence: result.usage || result.total_cost_usd !== undefined ? 'provider_estimate' : 'missing'
  };
}

function effectiveModelsFromResult(result: Record<string, unknown>, initModel: string | null): string[] {
  const modelUsage = asRecord(result.modelUsage) ?? asRecord(result.model_usage);
  return [...new Set([initModel, ...(modelUsage ? Object.keys(modelUsage) : [])].filter((model): model is string => Boolean(model)))];
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return false;
  }
}

function processGroupExists(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function cleanupProcessGroup(pid: number | undefined): Promise<'none' | 'terminated' | 'killed'> {
  if (!processGroupExists(pid)) return 'none';
  killProcessGroup(pid, 'SIGTERM');
  const deadline = Date.now() + TERMINATION_GRACE_MS;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return 'terminated';
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  killProcessGroup(pid, 'SIGKILL');
  return 'killed';
}

async function writePrompt(child: ChildProcessWithoutNullStreams, prompt: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.stdin.once('error', reject);
    child.stdin.end(prompt, 'utf8', () => {
      child.stdin.off('error', reject);
      resolve();
    });
  });
}

export class ClaudeCliRunner implements AgentRunner {
  readonly runtime = 'claude-cli' as const;
  readonly capabilities = {
    native_resume: 'within-attempt',
    missing_tool_output_recovery: false,
    remote_worker: false,
    enforcement_usage: false
  } as const;

  private readonly env: NodeJS.ProcessEnv;
  private readonly homedir: () => string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;
  private readonly supportedVersion: string;
  private readonly capabilityFingerprintBySession = new Map<string, string>();
  private readonly bindingBySession = new Map<string, ClaudeSessionBinding>();

  constructor(private readonly options: ClaudeCliRunnerOptions) {
    this.env = { ...process.env, ...options.env };
    this.homedir = options.homedir ?? os.homedir;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => new Date());
    this.supportedVersion = options.supportedVersion ?? CLAUDE_SUPPORTED_VERSION;
  }

  startSessionAndRunTurn(input: AgentRunnerStartInput): Promise<AgentRunResult> {
    return this.run(input, null);
  }

  resumeSessionAndRunTurn(input: AgentRunnerResumeInput): Promise<AgentRunResult> {
    return this.run(input, input.previousSessionId);
  }

  private async run(input: AgentRunnerStartInput, expectedSessionId: string | null): Promise<AgentRunResult> {
    const turnId = crypto.randomUUID();
    const startedAt = this.now();
    const emit = (
      event: Omit<
        AgentRunnerEvent,
        'agent_runtime' | 'worker_process_pid' | 'codex_app_server_pid' | 'timestamp'
      > & { timestamp?: string }
    ) =>
      input.onEvent?.({
        ...event,
        timestamp: event.timestamp ?? this.now().toISOString(),
        agent_runtime: this.runtime,
        worker_process_pid: child?.pid ?? null,
        codex_app_server_pid: null
      });
    let child: ChildProcessWithoutNullStreams | null = null;

    try {
      if (input.workerHost) throw new Error('claude_remote_worker_unsupported');
      if (!['darwin', 'linux'].includes(this.platform)) throw new Error(`claude_platform_unsupported:${this.platform}`);
      if (!path.isAbsolute(input.workspaceCwd)) throw new Error('invalid_workspace_cwd');
      const workspace = fs.realpathSync(input.workspaceCwd);
      if (!fs.statSync(workspace).isDirectory()) throw new Error('invalid_workspace_cwd');
      if (Buffer.byteLength(input.prompt, 'utf8') > MAX_PROMPT_BYTES) throw new Error('claude_prompt_too_large');
      if (expectedSessionId && !SESSION_ID_PATTERN.test(expectedSessionId)) throw new Error('claude_resume_session_invalid');
      if (this.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY?.trim()) throw new Error('claude_session_persistence_disabled');
      const binding: ClaudeSessionBinding = {
        project_identity: input.runBinding?.project_identity ?? workspace,
        issue_id: input.runBinding?.issue_id ?? input.title,
        issue_identifier: input.runBinding?.issue_identifier ?? input.title,
        attempt: input.runBinding?.attempt ?? null,
        workspace_realpath: workspace,
        model: this.options.model,
        os_user: typeof process.getuid === 'function' ? process.getuid() : (this.env.USER ?? 'unknown')
      };
      if (expectedSessionId) {
        const previousBinding = this.bindingBySession.get(expectedSessionId);
        if (!previousBinding || JSON.stringify(previousBinding) !== JSON.stringify(binding)) {
          throw new Error('claude_resume_binding_mismatch');
        }
      }

      const executable = resolveExecutable(this.options.command, this.env);
      const childEnv: NodeJS.ProcessEnv = {
        ...this.env,
        ANTHROPIC_MODEL: this.options.model,
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'
      };
      assertSupportedVersion(executable, workspace, childEnv, this.supportedVersion);
      assertApprovedAuth(executable, workspace, childEnv, this.homedir(), this.options.allowNonSubscriptionAuth);

      const args = [
        '--print',
        '--input-format',
        'text',
        '--output-format',
        'stream-json',
        '--verbose',
        '--setting-sources',
        'user',
        '--model',
        this.options.model,
        '--dangerously-skip-permissions'
      ];
      if (expectedSessionId) args.push('--resume', expectedSessionId);

      child = spawn(executable, args, {
        cwd: workspace,
        env: childEnv,
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: string | null }>((resolve) => {
        let spawnError: string | null = null;
        child?.once('error', (error) => {
          spawnError = error.message;
        });
        child?.once('close', (code, signal) => resolve({ code, signal, spawnError }));
      });
      emit({ event: CANONICAL_EVENT.agentRunner.processStarted, turn_id: turnId });

      const state: ParsedProtocolState = {
        sessionId: null,
        effectiveModel: null,
        capabilityFingerprint: null,
        terminalResult: null,
        terminalResultCount: 0,
        unknownEventCount: 0,
        lastEvent: CANONICAL_EVENT.agentRunner.processStarted,
        protocolError: null
      };
      let stderrBytes = 0;
      const stderrHash = crypto.createHash('sha256');
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        stderrHash.update(chunk);
      });

      const decoder = new StringDecoder('utf8');
      let pending = '';
      const parseLine = (line: string) => {
        if (!line.trim() || state.protocolError) return;
        if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
          state.protocolError = 'claude_protocol_line_too_large';
          return;
        }
        let payload: Record<string, unknown>;
        try {
          const parsed = asRecord(JSON.parse(line));
          if (!parsed) throw new Error('not_object');
          payload = parsed;
        } catch {
          state.protocolError = 'claude_protocol_malformed_json';
          return;
        }
        const type = readString(payload, 'type') ?? 'unknown';
        const subtype = readString(payload, 'subtype');
        const eventName = subtype ? `${type}/${subtype}` : type;
        state.lastEvent = eventName;
        const sessionId = readString(payload, 'session_id');
        if (sessionId) {
          if (!SESSION_ID_PATTERN.test(sessionId)) state.protocolError = 'claude_session_id_invalid';
          else if (state.sessionId && state.sessionId !== sessionId) state.protocolError = 'claude_session_id_mismatch';
          else if (expectedSessionId && expectedSessionId !== sessionId) state.protocolError = 'claude_resume_session_mismatch';
          else state.sessionId = sessionId;
        }

        if (type === 'system' && subtype === 'init') {
          state.effectiveModel = readString(payload, 'model');
          state.capabilityFingerprint = buildCapabilityFingerprint(payload);
          emit({
            event: CANONICAL_EVENT.agentRunner.sessionStarted,
            session_id: state.sessionId ?? undefined,
            thread_id: state.sessionId ? `claude:${state.sessionId}` : undefined,
            turn_id: turnId,
            requested_model: this.options.model,
            effective_model: state.effectiveModel
          });
          return;
        }
        if (type === 'result') {
          state.terminalResultCount += 1;
          state.terminalResult = payload;
          return;
        }
        if (type === 'system' && subtype === 'api_retry') {
          emit({
            event: CANONICAL_EVENT.agentRunner.activity,
            session_id: state.sessionId ?? undefined,
            turn_id: turnId,
            detail: 'claude_api_retry',
            reason_code: readString(payload, 'error') ?? undefined,
            process_liveness_only: true
          });
          return;
        }
        if (type === 'assistant' || type === 'user' || type === 'system') {
          emit({
            event: CANONICAL_EVENT.agentRunner.activity,
            session_id: state.sessionId ?? undefined,
            turn_id: turnId,
            detail: eventName
          });
          return;
        }
        state.unknownEventCount += 1;
      };

      child.stdout.on('data', (chunk: Buffer) => {
        pending += decoder.write(chunk);
        if (Buffer.byteLength(pending, 'utf8') > MAX_PROTOCOL_LINE_BYTES && !pending.includes('\n')) {
          state.protocolError = 'claude_protocol_line_too_large';
          return;
        }
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          const line = pending.slice(0, newline).replace(/\r$/, '');
          pending = pending.slice(newline + 1);
          parseLine(line);
          newline = pending.indexOf('\n');
        }
      });

      emit({ event: CANONICAL_EVENT.agentRunner.turnStarted, turn_id: turnId });
      const heartbeat = setInterval(() => {
        emit({
          event: CANONICAL_EVENT.agentRunner.activity,
          session_id: state.sessionId ?? undefined,
          turn_id: turnId,
          detail: 'process_alive',
          process_liveness_only: true
        });
      }, HEARTBEAT_MS);

      let committed: 'cancelled' | 'timed_out' | null = null;
      let forcedKillSent = false;
      let forceKillTimer: NodeJS.Timeout | null = null;
      const terminate = (outcome: 'cancelled' | 'timed_out') => {
        if (committed) return;
        committed = outcome;
        killProcessGroup(child?.pid, 'SIGTERM');
        forceKillTimer = setTimeout(() => {
          forcedKillSent = true;
          killProcessGroup(child?.pid, 'SIGKILL');
        }, TERMINATION_GRACE_MS);
      };
      const abortListener = () => terminate('cancelled');
      input.cancellationSignal?.addEventListener('abort', abortListener, { once: true });
      const timeout = setTimeout(() => terminate('timed_out'), input.turnTimeoutMs);

      try {
        await writePrompt(child, input.prompt);
      } catch {
        state.protocolError = 'claude_stdin_write_failed';
        killProcessGroup(child.pid, 'SIGTERM');
        forceKillTimer = setTimeout(() => {
          forcedKillSent = true;
          killProcessGroup(child?.pid, 'SIGKILL');
        }, TERMINATION_GRACE_MS);
      }

      const close = await closePromise;

      clearInterval(heartbeat);
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.cancellationSignal?.removeEventListener('abort', abortListener);
      pending += decoder.end();
      if (pending.trim()) parseLine(pending.replace(/\r$/, ''));
      await cleanupProcessGroup(child.pid);
      const stderrDigest = stderrBytes > 0 ? stderrHash.digest('hex') : null;

      if (committed) {
        const event = committed === 'timed_out' ? CANONICAL_EVENT.agentRunner.turnTimedOut : CANONICAL_EVENT.agentRunner.turnCancelled;
        emit({ event, session_id: state.sessionId ?? undefined, turn_id: turnId });
        return {
          runtime: this.runtime,
          status: committed,
          session_id: state.sessionId,
          thread_id: state.sessionId ? `claude:${state.sessionId}` : null,
          turn_id: turnId,
          last_event: event,
          error_code: committed === 'timed_out' ? REASON_CODES.turnTimeout : REASON_CODES.workerCancelRequested,
          error_detail: stderrDigest ? `stderr_bytes=${stderrBytes};stderr_sha256=${stderrDigest}` : undefined,
          cancellation_outcome: committed === 'cancelled' ? (forcedKillSent ? 'forced_kill_exited' : 'graceful_exit') : undefined,
          retryable: committed === 'timed_out'
        };
      }

      const terminal = state.terminalResult;
      const terminalSubtype = terminal ? readString(terminal, 'subtype') : null;
      const isError = terminal?.is_error === true;
      const terminalSession = terminal ? readString(terminal, 'session_id') : null;
      const permissionDenials = terminal && Array.isArray(terminal.permission_denials) ? terminal.permission_denials.length : 0;
      const failure =
        close.spawnError ||
        state.protocolError ||
        (state.terminalResultCount !== 1 ? `claude_terminal_result_count:${state.terminalResultCount}` : null) ||
        (!state.capabilityFingerprint ? 'claude_init_missing' : null) ||
        (!state.sessionId ? 'claude_session_id_missing' : null) ||
        (terminalSession && terminalSession !== state.sessionId ? 'claude_terminal_session_mismatch' : null) ||
        (terminalSubtype !== 'success' ? `claude_terminal_${terminalSubtype ?? 'unknown'}` : null) ||
        (isError ? 'claude_terminal_is_error' : null) ||
        (permissionDenials > 0 ? 'claude_permission_denied_under_bypass' : null) ||
        (close.code !== 0 ? `claude_process_exit:${close.code ?? close.signal ?? 'unknown'}` : null);

      if (failure || !terminal) {
        emit({
          event: CANONICAL_EVENT.agentRunner.turnFailed,
          session_id: state.sessionId ?? undefined,
          turn_id: turnId,
          detail: failure ?? 'claude_terminal_missing'
        });
        return {
          runtime: this.runtime,
          status: 'failed',
          session_id: state.sessionId,
          thread_id: state.sessionId ? `claude:${state.sessionId}` : null,
          turn_id: turnId,
          last_event: CANONICAL_EVENT.agentRunner.turnFailed,
          error_code: failure ?? 'claude_terminal_missing',
          error_detail: stderrDigest ? `stderr_bytes=${stderrBytes};stderr_sha256=${stderrDigest}` : undefined,
          requested_model: this.options.model,
          effective_model: state.effectiveModel,
          retryable: isRetryableClaudeFailure(failure ?? 'claude_terminal_missing')
        };
      }

      const sessionId = state.sessionId!;
      const fingerprint = state.capabilityFingerprint;
      if (expectedSessionId && fingerprint) {
        const previous = this.capabilityFingerprintBySession.get(expectedSessionId);
        if (previous && previous !== fingerprint) {
          return {
            runtime: this.runtime,
            status: 'failed',
            session_id: sessionId,
            thread_id: `claude:${sessionId}`,
            turn_id: turnId,
            last_event: CANONICAL_EVENT.agentRunner.turnFailed,
            error_code: 'claude_capability_fingerprint_drift',
            retryable: false
          };
        }
      }
      if (fingerprint) this.capabilityFingerprintBySession.set(sessionId, fingerprint);
      this.bindingBySession.set(sessionId, binding);

      const providerUsage = usageFromResult(terminal, state.effectiveModel);
      for (const observedModel of effectiveModelsFromResult(terminal, state.effectiveModel)) {
        if (observedModel === state.effectiveModel) continue;
        emit({
          event: CANONICAL_EVENT.agentRunner.activity,
          session_id: sessionId,
          thread_id: `claude:${sessionId}`,
          turn_id: turnId,
          detail: 'claude_model_observed',
          requested_model: this.options.model,
          effective_model: observedModel
        });
      }
      const resultText = readString(terminal, 'result');
      emit({
        event: CANONICAL_EVENT.agentRunner.turnCompleted,
        session_id: sessionId,
        thread_id: `claude:${sessionId}`,
        turn_id: turnId,
        detail: resultText ? trimUtf8(resultText, MAX_RESULT_DETAIL_BYTES) : undefined,
        provider_usage: providerUsage,
        requested_model: this.options.model,
        effective_model: state.effectiveModel
      });
      return {
        runtime: this.runtime,
        status: 'completed',
        session_id: sessionId,
        thread_id: `claude:${sessionId}`,
        turn_id: turnId,
        last_event: CANONICAL_EVENT.agentRunner.turnCompleted,
        last_agent_message: resultText ? trimUtf8(resultText, MAX_RESULT_DETAIL_BYTES) : undefined,
        provider_usage: providerUsage,
        requested_model: this.options.model,
        effective_model: state.effectiveModel,
        retryable: false
      };
    } catch (error) {
      if (child?.pid) killProcessGroup(child.pid, 'SIGKILL');
      const detail = error instanceof Error ? error.message : String(error);
      emit({ event: CANONICAL_EVENT.agentRunner.turnFailed, turn_id: turnId, detail });
      return {
        runtime: this.runtime,
        status: 'failed',
        session_id: expectedSessionId,
        thread_id: expectedSessionId ? `claude:${expectedSessionId}` : null,
        turn_id: turnId,
        last_event: CANONICAL_EVENT.agentRunner.turnFailed,
        error_code: detail,
        error_detail: `started_at=${startedAt.toISOString()}`,
        requested_model: this.options.model,
        effective_model: null,
        retryable: false
      };
    }
  }
}
