import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { CANONICAL_EVENT } from '../observability/events';
import { REASON_CODES } from '../observability/reason-codes';
import { auditSensitiveWorkspaceFiles } from '../workspace/sensitive-files';
import {
  claudeSandboxProtectedPathCandidates,
  createClaudeSandboxPathSnapshot,
  probeClaudeSandboxRuntime,
  type ClaudeSandboxPathSnapshot
} from './claude-sandbox';
import type {
  AgentRunResult,
  AgentRunner,
  AgentRunnerEvent,
  AgentRunnerResumeInput,
  AgentRunnerStartInput,
  ProviderUsage
} from './types';
import { parseReviewOutcome } from '../review';
import { stripReviewerCredentials } from '../review/credential-boundary';

export const CLAUDE_SUPPORTED_VERSION = '2.1.224';
const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_DETAIL_BYTES = 16 * 1024;
const MAX_TOOL_FAILURE_INSPECTION_BYTES = 64 * 1024;
const HEARTBEAT_MS = 5_000;
const NESTED_PROCESS_SCAN_MS = 1_000;
const TERMINATION_GRACE_MS = 5_000;
const PROCESS_CLOSE_GRACE_MS = 2_000;
const PREFLIGHT_TIMEOUT_MS = 10_000;
const MAX_TELEMETRY_IDENTITIES = 10_000;
const MAX_TELEMETRY_NAME_BYTES = 256;
const MAX_SESSION_BINDINGS = 1_000;
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
  projectRoot: string;
  gitCommand?: string;
  githubCommand?: string;
  allowNonSubscriptionAuth: boolean;
  networkAllowedDomains?: string[];
  allowedMcpServers?: string[];
  requiredMcpServers?: string[];
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
  initSessionId: string | null;
  effectiveModel: string | null;
  capabilityFingerprint: string | null;
  instructionFingerprint: string | null;
  skillFingerprint: string | null;
  terminalResult: Record<string, unknown> | null;
  primaryResults: Record<string, unknown>[];
  terminalFailure: string | null;
  terminalResultCount: number;
  auxiliaryResultCount: number;
  continuationCount: number;
  initCount: number;
  apiRetryCount: number;
  permissionDenialCount: number;
  unknownEventCount: number;
  lastEvent: string;
  protocolError: string | null;
  runtimeFailure: string | null;
}

interface ClaudeSessionBinding {
  project_identity: string;
  issue_id: string;
  issue_identifier: string;
  attempt: number | null;
  workspace_realpath: string;
  project_root_realpath: string;
  model: string;
  os_user: number | string;
  config_hash: string;
}

interface UsageNumbers {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

interface UserSettingsAssessment {
  hash: string;
  selectors: string[];
  unsafe: string[];
  environmentNames: string[];
}

interface ManagedPolicyAssessment {
  hash: string;
  present: string[];
}

interface GitRemoteIdentity {
  scheme: 'ssh' | 'https' | 'http' | 'other' | 'missing';
  host: string | null;
  repository: string | null;
  has_credentials: boolean;
}

interface ValidatedSshAgent {
  socketPath: string;
  identityHash: string;
}

interface GitHubCapability {
  host: string;
  token: string;
  executable: string;
  identityHash: string;
}

export interface ClaudeUserMcpAssessment {
  hash: string;
  unsafe: string[];
  configuredUserServers: string[];
  approvedServerConfiguration: Record<string, Record<string, unknown>>;
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

function readTokenCount(record: Record<string, unknown>, key: string): number | null {
  const value = readFiniteNumber(record, key);
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readNonNegativeNumber(record: Record<string, unknown>, key: string): number | null {
  const value = readFiniteNumber(record, key);
  return value !== null && value >= 0 ? value : null;
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

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveTrustedExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  forbiddenRoots: string[] = []
): string {
  if (command.includes(path.sep)) {
    if (!path.isAbsolute(command)) throw new Error(`claude_executable_untrusted:${command}`);
    const absolute = command;
    const resolved = fs.realpathSync(absolute);
    fs.accessSync(resolved, fs.constants.X_OK);
    if (forbiddenRoots.some((root) => isPathInside(root, resolved))) throw new Error(`claude_executable_untrusted:${command}`);
    if ((fs.statSync(resolved).mode & 0o022) !== 0) throw new Error(`claude_executable_insecure_permissions:${command}`);
    return resolved;
  }

  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const resolved = fs.realpathSync(candidate);
      if (forbiddenRoots.some((root) => isPathInside(root, resolved))) continue;
      if ((fs.statSync(resolved).mode & 0o022) !== 0) continue;
      return resolved;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`claude_executable_not_found:${command}`);
}

function assessUserSettings(home: string): UserSettingsAssessment {
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return {
      hash: crypto.createHash('sha256').update('missing').digest('hex'),
      selectors: [],
      unsafe: [],
      environmentNames: []
    };
  }
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const settings = asRecord(parsed);
    if (!settings) throw new Error('settings_not_object');
    const selectors = settings.apiKeyHelper ? ['apiKeyHelper'] : [];
    const unsafe: string[] = [];
    if (settings.apiKeyHelper !== undefined) unsafe.push('apiKeyHelper');
    const settingsEnv = asRecord(settings.env);
    const environmentNames = settingsEnv
      ? Object.entries(settingsEnv)
          .filter(([, value]) => (typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined))
          .map(([name]) => name)
      : [];
    if (settingsEnv) {
      selectors.push(
        ...NON_SUBSCRIPTION_ENV_NAMES.filter((name) => {
          const value = settingsEnv[name];
          return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
        })
      );
      for (const name of environmentNames) unsafe.push(`env.${name}`);
    }
    const hooks = asRecord(settings.hooks);
    const enabledPlugins = asRecord(settings.enabledPlugins);
    const plugins = asRecord(settings.plugins);
    const sandbox = asRecord(settings.sandbox);
    const sandboxFilesystem = asRecord(sandbox?.filesystem);
    const sandboxNetwork = asRecord(sandbox?.network);
    const permissions = asRecord(settings.permissions);
    if (hooks && Object.keys(hooks).length > 0) unsafe.push('hooks');
    if (enabledPlugins && Object.values(enabledPlugins).some((value) => value === true)) unsafe.push('enabledPlugins');
    if (plugins && Object.keys(plugins).length > 0) unsafe.push('plugins');
    if (settings.agents !== undefined) unsafe.push('agents');
    if (sandbox && Array.isArray(sandbox.excludedCommands) && sandbox.excludedCommands.length > 0) unsafe.push('sandbox.excludedCommands');
    if (sandbox?.allowUnsandboxedCommands === true) unsafe.push('sandbox.allowUnsandboxedCommands');
    if (sandbox?.failIfUnavailable === false) unsafe.push('sandbox.failIfUnavailable');
    if (sandbox?.allowAppleEvents === true) unsafe.push('sandbox.allowAppleEvents');
    if (sandboxFilesystem?.disabled === true) unsafe.push('sandbox.filesystem.disabled');
    if (sandboxNetwork?.allowAllUnixSockets === true) unsafe.push('sandbox.network.allowAllUnixSockets');
    if (sandboxNetwork?.enableWeakerNetworkIsolation === true) unsafe.push('sandbox.network.enableWeakerNetworkIsolation');
    if (permissions?.defaultMode === 'bypassPermissions') unsafe.push('permissions.defaultMode');
    if (Array.isArray(permissions?.allow) && permissions.allow.length > 0) unsafe.push('permissions.allow');
    if (Array.isArray(permissions?.additionalDirectories) && permissions.additionalDirectories.length > 0) {
      unsafe.push('permissions.additionalDirectories');
    }
    if (sandboxFilesystem && Array.isArray(sandboxFilesystem.allowWrite) && sandboxFilesystem.allowWrite.length > 0) {
      unsafe.push('sandbox.filesystem.allowWrite');
    }
    if (sandboxFilesystem && Array.isArray(sandboxFilesystem.allowRead) && sandboxFilesystem.allowRead.length > 0) {
      unsafe.push('sandbox.filesystem.allowRead');
    }
    if (sandboxNetwork && Array.isArray(sandboxNetwork.allowedDomains) && sandboxNetwork.allowedDomains.length > 0) {
      unsafe.push('sandbox.network.allowedDomains');
    }
    if (sandboxNetwork && Array.isArray(sandboxNetwork.allowUnixSockets) && sandboxNetwork.allowUnixSockets.length > 0) {
      unsafe.push('sandbox.network.allowUnixSockets');
    }
    if (sandboxNetwork?.allowAllUnixSockets === true) unsafe.push('sandbox.network.allowAllUnixSockets');
    if (sandboxNetwork?.allowLocalBinding === true) unsafe.push('sandbox.network.allowLocalBinding');
    if (Array.isArray(sandboxNetwork?.allowMachLookup) && sandboxNetwork.allowMachLookup.length > 0) {
      unsafe.push('sandbox.network.allowMachLookup');
    }
    if (sandboxNetwork?.httpProxyPort !== undefined) unsafe.push('sandbox.network.httpProxyPort');
    if (sandboxNetwork?.socksProxyPort !== undefined) unsafe.push('sandbox.network.socksProxyPort');
    if (sandboxNetwork?.tlsTerminate !== undefined) unsafe.push('sandbox.network.tlsTerminate');
    if (sandbox?.enableWeakerNestedSandbox === true) unsafe.push('sandbox.enableWeakerNestedSandbox');
    if (sandbox?.enableWeakerNetworkIsolation === true) unsafe.push('sandbox.enableWeakerNetworkIsolation');
    if (sandbox?.ignoreViolations !== undefined) unsafe.push('sandbox.ignoreViolations');
    if (sandbox?.ripgrep !== undefined) unsafe.push('sandbox.ripgrep');
    if (settings.processWrapper !== undefined) unsafe.push('processWrapper');
    if (settings.statusLine !== undefined) unsafe.push('statusLine');
    if (settings.fileSuggestion !== undefined) unsafe.push('fileSuggestion');
    return {
      hash: crypto.createHash('sha256').update(raw).digest('hex'),
      selectors: [...new Set(selectors)],
      unsafe: [...new Set(unsafe)],
      environmentNames: [...new Set(environmentNames)]
    };
  } catch (error) {
    throw new Error(`claude_user_settings_unreadable:${error instanceof Error ? error.message : String(error)}`);
  }
}

function assessManagedPolicy(platform: NodeJS.Platform, home: string): ManagedPolicyAssessment {
  const baseCandidates = platform === 'darwin'
    ? [
        '/Library/Application Support/ClaudeCode/managed-settings.json',
        '/Library/Application Support/ClaudeCode/managed-mcp.json',
        '/Library/Managed Preferences/com.anthropic.claudecode.plist',
        '/Library/Managed Preferences/com.anthropic.ClaudeCode.plist'
      ]
    : platform === 'linux'
      ? ['/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-mcp.json']
      : [];
  const dropInDirectories = platform === 'darwin'
    ? ['/Library/Application Support/ClaudeCode/managed-settings.d']
    : platform === 'linux'
      ? ['/etc/claude-code/managed-settings.d']
      : [];
  const dropIns = dropInDirectories.flatMap((directory) => {
    try {
      return fs.readdirSync(directory)
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => path.join(directory, entry));
    } catch {
      return [];
    }
  });
  const remoteSettings = path.join(home, '.claude', 'remote-settings.json');
  const remoteSettingsPresent = (() => {
    if (!fs.existsSync(remoteSettings)) return false;
    try {
      const parsed = JSON.parse(fs.readFileSync(remoteSettings, 'utf8')) as unknown;
      if (Array.isArray(parsed)) return parsed.length > 0;
      const record = asRecord(parsed);
      return Boolean(record && Object.keys(record).length > 0);
    } catch {
      return true;
    }
  })();
  const candidates = [
    ...baseCandidates,
    ...dropIns,
    path.join(home, '.claude', 'managed-settings.json'),
    path.join(home, '.claude', 'managed-mcp.json'),
    ...(remoteSettingsPresent ? [remoteSettings] : [])
  ];
  const present = candidates.filter((candidate) => fs.existsSync(candidate));
  const digest = crypto.createHash('sha256');
  for (const candidate of present) {
    digest.update(candidate).update('\0').update(fs.readFileSync(candidate)).update('\0');
  }
  return { hash: digest.update(present.length === 0 ? 'missing' : '').digest('hex'), present };
}

function assessUserCustomAgents(home: string): { hash: string; present: string[] } {
  const directory = path.join(home, '.claude', 'agents');
  let present: string[] = [];
  try {
    present = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch {
    present = [];
  }
  const digest = crypto.createHash('sha256');
  for (const candidate of present) {
    digest.update(path.basename(candidate)).update('\0').update(fs.readFileSync(candidate)).update('\0');
  }
  return { hash: digest.update(present.length === 0 ? 'missing' : '').digest('hex'), present };
}

function hashUserInstructionSurface(home: string): string {
  const roots = [
    path.join(home, '.claude', 'CLAUDE.md'),
    path.join(home, '.claude', 'rules'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.claude', 'commands')
  ];
  const files: string[] = [];
  const pending = [...roots];
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error('claude_user_instruction_symlink_unsupported');
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(candidate)) pending.push(path.join(candidate, entry));
      continue;
    }
    if (stat.isFile()) files.push(candidate);
    if (files.length > 1_000) throw new Error('claude_user_instruction_inventory_too_large');
  }
  files.sort();
  const digest = crypto.createHash('sha256');
  let totalBytes = 0;
  for (const file of files) {
    const content = fs.readFileSync(file);
    totalBytes += content.length;
    if (totalBytes > 16 * 1024 * 1024) throw new Error('claude_user_instruction_inventory_too_large');
    digest.update(path.relative(home, file)).update('\0').update(content).update('\0');
  }
  return digest.update(files.length === 0 ? 'missing' : '').digest('hex');
}

export function inspectClaudeUserMcpConfiguration(params: {
  home: string;
  workspace: string;
  allowedServers: Iterable<string>;
  requiredServers: Iterable<string>;
}): ClaudeUserMcpAssessment {
  const allowed = new Set([...params.allowedServers].map((name) => name.toLowerCase()));
  const required = new Set([...params.requiredServers].map((name) => name.toLowerCase()));
  const configPath = path.join(params.home, '.claude.json');
  if (!fs.existsSync(configPath)) {
    return {
      hash: stableConfigurationHash(['missing']),
      unsafe: [...required].map((name) => `user_mcp_missing.${name}`),
      configuredUserServers: [],
      approvedServerConfiguration: {}
    };
  }
  try {
    const parsed = asRecord(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    if (!parsed) throw new Error('config_not_object');
    const rawUserServers = asRecord(parsed.mcpServers) ?? {};
    const userServers = Object.fromEntries(Object.entries(rawUserServers).map(([name, value]) => [name.toLowerCase(), value]));
    const configuredUserServers = Object.keys(userServers).sort();
    const unsafe: string[] = [];
    const approvedServerConfiguration: Record<string, Record<string, unknown>> = {};
    for (const name of required) {
      if (!asRecord(userServers[name])) unsafe.push(`user_mcp_missing.${name}`);
    }
    for (const name of [...allowed].sort()) {
      const server = asRecord(userServers[name]);
      if (!server) continue;
      const reasonName = name.replace(/-/g, '_');
      const transport = readString(server, 'type')?.toLowerCase();
      const url = readString(server, 'url');
      let parsedUrl: URL | null = null;
      try {
        parsedUrl = url ? new URL(url) : null;
      } catch {
        // Reported below as an invalid endpoint.
      }
      if (!['http', 'streamable-http'].includes(transport ?? '')) unsafe.push(`user_mcp_${reasonName}.transport`);
      if (
        !parsedUrl ||
        parsedUrl.protocol !== 'https:' ||
        parsedUrl.username ||
        parsedUrl.password ||
        parsedUrl.search ||
        parsedUrl.hash
      ) {
        unsafe.push(`user_mcp_${reasonName}.endpoint`);
      }
      if (Object.keys(server).some((key) => !['type', 'url'].includes(key))) {
        unsafe.push(`user_mcp_${reasonName}.inline_configuration`);
      }
      if (!unsafe.some((entry) => entry.startsWith(`user_mcp_${reasonName}.`)) && transport && url) {
        approvedServerConfiguration[name] = { type: transport, url };
      }
    }
    const linear = asRecord(userServers['linear-server']);
    if (linear) {
      const url = readString(linear, 'url');
      if (url !== 'https://mcp.linear.app/mcp') unsafe.push('user_mcp_linear_server.endpoint');
    }
    const projects = asRecord(parsed.projects) ?? {};
    const workspace = path.resolve(params.workspace);
    let localPermissionsPresent = false;
    for (const [projectPath, rawProject] of Object.entries(projects)) {
      if (path.resolve(projectPath) !== workspace) continue;
      const project = asRecord(rawProject) ?? {};
      if (Array.isArray(project.allowedTools) && project.allowedTools.length > 0) {
        unsafe.push('local_permissions.allowedTools');
        localPermissionsPresent = true;
      }
      const localServers = asRecord(project.mcpServers) ?? {};
      for (const name of Object.keys(localServers).map((entry) => entry.toLowerCase())) {
        if (allowed.has(name) || required.has(name)) unsafe.push(`local_mcp_override.${name}`);
      }
    }
    return {
      hash: stableConfigurationHash([approvedServerConfiguration, localPermissionsPresent, [...new Set(unsafe)].sort()]),
      unsafe: [...new Set(unsafe)].sort(),
      configuredUserServers,
      approvedServerConfiguration
    };
  } catch (error) {
    return {
      hash: stableConfigurationHash(['invalid']),
      unsafe: [`user_mcp_config_unreadable.${boundedFailureSignal(error instanceof Error ? error.message : String(error)) ?? 'invalid'}`],
      configuredUserServers: [],
      approvedServerConfiguration: {}
    };
  }
}

function readAuthStatus(executable: string, cwd: string, env: NodeJS.ProcessEnv): ClaudeAuthStatus {
  const result = spawnSync(executable, ['auth', 'status', '--json'], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: PREFLIGHT_TIMEOUT_MS,
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
  const assessment = assessUserSettings(home);
  const selectors: string[] = [
    ...NON_SUBSCRIPTION_ENV_NAMES.filter((name) => Boolean(env[name]?.trim())),
    ...assessment.selectors
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

const SUBSCRIPTION_TOKEN_EXPIRY_MARGIN_MS = 60_000;

// Subscription OAuth tokens expire roughly daily, and the sandboxed CLI does
// not run the interactive refresh flow: a worker dispatched with a stale token
// burns its turn on an immediate 401 and blocks the issue behind a generic
// terminal error. Reading the expiry lets the runner refuse such a dispatch
// upfront with an actionable code. Returns null when the credentials file is
// absent, unreadable, or carries no numeric expiry (keychain-backed or
// non-subscription auth) — the preflight only acts on positive evidence.
function readSubscriptionTokenExpiry(home: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8')) as {
      claudeAiOauth?: { expiresAt?: unknown };
    };
    const expiresAt = parsed.claudeAiOauth?.expiresAt;
    return typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
}

function isRetryableClaudeFailure(code: string): boolean {
  return (
    code.startsWith('claude_process_exit:') ||
    /api_status=(?:429|5\d\d)/i.test(code) ||
    /rate.?limit|overload|network|server|temporar|unavailable|api_retry/i.test(code)
  );
}

function boundedFailureSignal(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 80);
  return normalized || null;
}

function assertSupportedVersion(executable: string, cwd: string, env: NodeJS.ProcessEnv, supported: string): void {
  const result = spawnSync(executable, ['--version'], {
    cwd,
    env,
    encoding: 'utf8',
    shell: false,
    timeout: PREFLIGHT_TIMEOUT_MS
  });
  if (result.status !== 0) throw new Error('claude_version_unavailable');
  const match = result.stdout.match(/\b\d+\.\d+\.\d+\b/);
  if (match?.[0] !== supported) {
    throw new Error(`claude_version_unsupported:expected=${supported}:actual=${match?.[0] ?? 'unknown'}`);
  }
}

function hashInitSurface(payload: Record<string, unknown>, keys: string[]): string {
  const normalized = Object.fromEntries(
    keys.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]])
  );
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function buildCapabilityFingerprint(payload: Record<string, unknown>, activeServers: Set<string>): string {
  const normalized = {
    tools: Array.isArray(payload.tools) ? payload.tools.map(String).sort() : [],
    active_mcp_servers: [...activeServers].sort()
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function zeroUsage(): UsageNumbers {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
}

function usageNumbers(value: unknown): UsageNumbers | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const inputTokens = readTokenCount(usage, 'input_tokens');
  const outputTokens = readTokenCount(usage, 'output_tokens');
  const cacheReadTokens = readTokenCount(usage, 'cache_read_input_tokens');
  const cacheCreationTokens = readTokenCount(usage, 'cache_creation_input_tokens');
  if ([inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens].some((count) => count === null)) return null;
  return {
    input_tokens: inputTokens!,
    output_tokens: outputTokens!,
    cache_read_tokens: cacheReadTokens!,
    cache_creation_tokens: cacheCreationTokens!
  };
}

function addUsage(target: UsageNumbers, value: UsageNumbers): UsageNumbers {
  return {
    input_tokens: target.input_tokens + value.input_tokens,
    output_tokens: target.output_tokens + value.output_tokens,
    cache_read_tokens: target.cache_read_tokens + value.cache_read_tokens,
    cache_creation_tokens: target.cache_creation_tokens + value.cache_creation_tokens
  };
}

function maxUsage(left: UsageNumbers | undefined, right: UsageNumbers): UsageNumbers {
  if (!left) return right;
  return {
    input_tokens: Math.max(left.input_tokens, right.input_tokens),
    output_tokens: Math.max(left.output_tokens, right.output_tokens),
    cache_read_tokens: Math.max(left.cache_read_tokens, right.cache_read_tokens),
    cache_creation_tokens: Math.max(left.cache_creation_tokens, right.cache_creation_tokens)
  };
}

function modelUsageFromResult(result: Record<string, unknown>) {
  const value = asRecord(result.modelUsage) ?? asRecord(result.model_usage);
  if (!value) return [];
  return Object.entries(value)
    .map(([model, raw]) => {
      const usage = asRecord(raw) ?? {};
      return {
        model,
        input_tokens: readTokenCount(usage, 'inputTokens') ?? 0,
        output_tokens: readTokenCount(usage, 'outputTokens') ?? 0,
        cache_read_tokens: readTokenCount(usage, 'cacheReadInputTokens') ?? 0,
        cache_creation_tokens: readTokenCount(usage, 'cacheCreationInputTokens') ?? 0,
        estimated_cost_usd: readNonNegativeNumber(usage, 'costUSD')
      };
    })
    .filter((usage) =>
      usage.input_tokens > 0 ||
      usage.output_tokens > 0 ||
      usage.cache_read_tokens > 0 ||
      usage.cache_creation_tokens > 0 ||
      (usage.estimated_cost_usd ?? 0) > 0
    );
}

function usageFromResult(
  result: Record<string, unknown>,
  model: string | null,
  partial: ProviderUsage | null,
  apiRetryCount: number,
  toolCounts: Record<string, number>,
  mcpCounts: Record<string, number>,
  updatedAt: string,
  protocol: {
    timeToFirstTokenMs: number | null;
    permissionDenialCount: number;
    unknownEventCount: number;
    auxiliaryResultCount: number;
  }
): ProviderUsage {
  const usageRecord = asRecord(result.usage);
  const usage = usageRecord ?? {};
  const modelUsage = modelUsageFromResult(result);
  const finalNumbers = usageNumbers(usage);
  const finalTurns = readTokenCount(result, 'num_turns');
  const hasTokenEvidence = [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens'
  ].some((key) => readTokenCount(usage, key) !== null);
  const reconciliationDelta = partial && hasTokenEvidence && finalNumbers
    ? {
        input_tokens: finalNumbers.input_tokens - (partial.input_tokens ?? 0),
        output_tokens: finalNumbers.output_tokens - (partial.output_tokens ?? 0),
        cache_read_tokens: finalNumbers.cache_read_tokens - (partial.cache_read_tokens ?? 0),
        cache_creation_tokens: finalNumbers.cache_creation_tokens - (partial.cache_creation_tokens ?? 0),
        provider_turn_count: (finalTurns ?? 0) - (partial.provider_turn_count ?? 0)
      }
    : null;
  const hasCostEvidence = readNonNegativeNumber(result, 'total_cost_usd') !== null;
  return {
    runtime: 'claude-cli',
    model,
    effective_models: [...new Set([model, ...modelUsage.map((entry) => entry.model)].filter((value): value is string => Boolean(value)))],
    input_tokens: readTokenCount(usage, 'input_tokens'),
    output_tokens: readTokenCount(usage, 'output_tokens'),
    cache_read_tokens: readTokenCount(usage, 'cache_read_input_tokens'),
    cache_creation_tokens: readTokenCount(usage, 'cache_creation_input_tokens'),
    provider_turn_count: readTokenCount(result, 'num_turns'),
    estimated_cost_usd: readNonNegativeNumber(result, 'total_cost_usd'),
    source: 'claude_stream_result',
    status: hasTokenEvidence || hasCostEvidence ? 'final' : 'unobserved',
    confidence: hasTokenEvidence || hasCostEvidence ? 'provider_result' : 'missing',
    api_retry_count: apiRetryCount,
    api_error_status:
      readFiniteNumber(result, 'api_error_status') ?? readString(result, 'api_error_status'),
    terminal_reason: readString(result, 'terminal_reason'),
    stop_reason: readString(result, 'stop_reason'),
    duration_ms: readNonNegativeNumber(result, 'duration_ms'),
    duration_api_ms: readNonNegativeNumber(result, 'duration_api_ms'),
    time_to_first_token_ms: protocol.timeToFirstTokenMs,
    permission_denial_count: protocol.permissionDenialCount,
    unknown_event_count: protocol.unknownEventCount,
    auxiliary_result_count: protocol.auxiliaryResultCount,
    nested_session_detected: false,
    supervised_session_coverage: hasTokenEvidence ? 'complete' : hasCostEvidence ? 'partial' : 'missing',
    tool_counts: { ...toolCounts },
    mcp_counts: { ...mcpCounts },
    updated_at: updatedAt,
    missing_reason: hasTokenEvidence ? null : hasCostEvidence ? 'claude_result_token_usage_missing' : 'claude_result_usage_missing',
    reconciliation_delta: reconciliationDelta,
    model_usage: modelUsage
  };
}

function aggregateTerminalResults(results: readonly Record<string, unknown>[]): Record<string, unknown> | null {
  const last = results.at(-1);
  if (!last) return null;
  const aggregate: Record<string, unknown> = { ...last };
  const usageKeys = [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens'
  ] as const;
  const usage: Record<string, number> = {};
  for (const key of usageKeys) {
    const values = results.map((result) => readTokenCount(asRecord(result.usage) ?? {}, key));
    if (values.every((value): value is number => value !== null)) {
      usage[key] = values.reduce((sum, value) => sum + value, 0);
    }
  }
  aggregate.usage = usage;

  const turns = results.map((result) => readTokenCount(result, 'num_turns'));
  if (turns.every((value): value is number => value !== null)) {
    aggregate.num_turns = turns.reduce((sum, value) => sum + value, 0);
  } else {
    delete aggregate.num_turns;
  }
  const costs = results.map((result) => readNonNegativeNumber(result, 'total_cost_usd'));
  if (costs.every((value): value is number => value !== null)) {
    aggregate.total_cost_usd = costs.reduce((sum, value) => sum + value, 0);
  } else {
    delete aggregate.total_cost_usd;
  }

  const perModel = new Map<string, ReturnType<typeof modelUsageFromResult>[number]>();
  for (const result of results) {
    for (const modelUsage of modelUsageFromResult(result)) {
      const previous = perModel.get(modelUsage.model);
      perModel.set(modelUsage.model, {
        model: modelUsage.model,
        input_tokens: (previous?.input_tokens ?? 0) + modelUsage.input_tokens,
        output_tokens: (previous?.output_tokens ?? 0) + modelUsage.output_tokens,
        cache_read_tokens: (previous?.cache_read_tokens ?? 0) + modelUsage.cache_read_tokens,
        cache_creation_tokens: (previous?.cache_creation_tokens ?? 0) + modelUsage.cache_creation_tokens,
        estimated_cost_usd:
          previous?.estimated_cost_usd === null || modelUsage.estimated_cost_usd === null
            ? null
            : (previous?.estimated_cost_usd ?? 0) + modelUsage.estimated_cost_usd
      });
    }
  }
  aggregate.modelUsage = Object.fromEntries([...perModel].map(([model, modelUsage]) => [model, {
    inputTokens: modelUsage.input_tokens,
    outputTokens: modelUsage.output_tokens,
    cacheReadInputTokens: modelUsage.cache_read_tokens,
    cacheCreationInputTokens: modelUsage.cache_creation_tokens,
    costUSD: modelUsage.estimated_cost_usd
  }]));
  return aggregate;
}

function effectiveModelsFromResult(result: Record<string, unknown>, initModel: string | null): string[] {
  return [...new Set([initModel, ...modelUsageFromResult(result).map((usage) => usage.model)].filter((model): model is string => Boolean(model)))];
}

function mcpServerFromToolName(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const separator = toolName.indexOf('__', 5);
  return separator > 5 ? toolName.slice(5, separator).toLowerCase() : null;
}

function activeMcpServers(payload: Record<string, unknown>): Set<string> {
  const active = new Set<string>();
  if (Array.isArray(payload.tools)) {
    for (const rawName of payload.tools) {
      const server = mcpServerFromToolName(String(rawName));
      if (server) active.add(server);
    }
  }
  if (Array.isArray(payload.mcp_servers)) {
    for (const rawEntry of payload.mcp_servers) {
      const entry = asRecord(rawEntry);
      if (!entry) continue;
      const name = readString(entry, 'name')?.toLowerCase();
      const status = readString(entry, 'status')?.toLowerCase();
      if (name && (!status || ['connected', 'ready', 'available'].includes(status))) active.add(name);
    }
  }
  return active;
}

function isAuxiliaryResult(payload: Record<string, unknown>): boolean {
  const subtype = readString(payload, 'subtype')?.toLowerCase() ?? '';
  const origin = asRecord(payload.origin);
  const originKind = readString(origin ?? {}, 'kind')?.toLowerCase() ?? '';
  const auxiliary = ['task_notification', 'task-notification', 'prompt_suggestion', 'prompt-suggestion'];
  return auxiliary.includes(subtype) || auxiliary.includes(originKind);
}

function partialUsageSnapshot(
  steps: Map<string, UsageNumbers>,
  model: string | null,
  observedModels: Iterable<string>,
  apiRetryCount: number,
  toolCounts: Record<string, number>,
  mcpCounts: Record<string, number>,
  updatedAt: string,
  protocol: { permissionDenialCount: number; unknownEventCount: number; auxiliaryResultCount: number }
): ProviderUsage | null {
  if (steps.size === 0) return null;
  let accumulated = zeroUsage();
  for (const step of steps.values()) {
    accumulated = addUsage(accumulated, step);
    if (Object.values(accumulated).some((count) => !Number.isSafeInteger(count) || count < 0)) return null;
  }
  return {
    runtime: 'claude-cli',
    model,
    effective_models: [...new Set(observedModels)],
    input_tokens: accumulated.input_tokens,
    output_tokens: accumulated.output_tokens,
    cache_read_tokens: accumulated.cache_read_tokens,
    cache_creation_tokens: accumulated.cache_creation_tokens,
    provider_turn_count: steps.size,
    estimated_cost_usd: null,
    source: 'claude_assistant_step',
    status: 'partial',
    confidence: 'provider_step',
    api_retry_count: apiRetryCount,
    permission_denial_count: protocol.permissionDenialCount,
    unknown_event_count: protocol.unknownEventCount,
    auxiliary_result_count: protocol.auxiliaryResultCount,
    nested_session_detected: false,
    supervised_session_coverage: 'partial',
    tool_counts: { ...toolCounts },
    mcp_counts: { ...mcpCounts },
    updated_at: updatedAt,
    missing_reason: 'live_lower_bound_until_terminal_result',
    reconciliation_delta: null,
    model_usage: []
  };
}

function unobservedUsageSnapshot(params: {
  model: string | null;
  observedModels: Iterable<string>;
  apiRetryCount: number;
  permissionDenialCount: number;
  unknownEventCount: number;
  auxiliaryResultCount: number;
  toolCounts: Record<string, number>;
  mcpCounts: Record<string, number>;
  updatedAt: string;
  missingReason: string;
}): ProviderUsage {
  return {
    runtime: 'claude-cli',
    model: params.model,
    effective_models: [...new Set(params.observedModels)],
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    provider_turn_count: null,
    estimated_cost_usd: null,
    source: 'claude_invocation',
    status: 'unobserved',
    confidence: 'missing',
    api_retry_count: params.apiRetryCount,
    permission_denial_count: params.permissionDenialCount,
    unknown_event_count: params.unknownEventCount,
    auxiliary_result_count: params.auxiliaryResultCount,
    nested_session_detected: false,
    supervised_session_coverage: 'missing',
    tool_counts: { ...params.toolCounts },
    mcp_counts: { ...params.mcpCounts },
    updated_at: params.updatedAt,
    missing_reason: params.missingReason,
    reconciliation_delta: null,
    model_usage: []
  };
}

function stableConfigurationHash(parts: unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function buildSandboxSettings(params: {
  executable: string;
  workspace: string;
  sessionTemp: string;
  protectedPathSnapshot: ClaudeSandboxPathSnapshot;
  networkAllowedDomains: string[];
  sshAuthSock: string | null;
  allowedMcpServers: string[];
  enableWeakerNetworkIsolation: boolean;
}): Record<string, unknown> {
  const protectedPaths = params.protectedPathSnapshot.protectedPaths;
  const absoluteReadRules = protectedPaths.flatMap((protectedPath) => {
    const absolute = protectedPath.replace(/^\/+/, '');
    return [`Read(//${absolute})`, `Read(//${absolute}/**)`];
  });
  const allowUnixSockets = params.sshAuthSock ? [params.sshAuthSock] : [];
  return {
    permissions: {
      allow: params.allowedMcpServers.map((server) => `mcp__${server}__*`),
      deny: [
        'Read(./.env)',
        'Read(**/.env)',
        ...absoluteReadRules,
        'WebFetch',
        'WebSearch',
        'Bash(claude *)',
        `Bash(${params.executable} *)`
      ]
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      ...(params.enableWeakerNetworkIsolation ? { enableWeakerNetworkIsolation: true } : {}),
      filesystem: { allowWrite: [params.workspace, params.sessionTemp], denyRead: protectedPaths },
      network: {
        allowedDomains: params.networkAllowedDomains,
        deniedDomains: ['localhost', '127.0.0.1', '::1'],
        allowLocalBinding: false,
        ...(allowUnixSockets.length > 0 ? { allowUnixSockets } : {})
      }
    }
  };
}

function readGitRemoteIdentity(workspace: string, gitExecutable: string): GitRemoteIdentity {
  const result = spawnSync(gitExecutable, ['config', '--file', path.join(workspace, '.git', 'config'), '--get', 'remote.origin.url'], {
    cwd: workspace,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    encoding: 'utf8',
    shell: false,
    timeout: PREFLIGHT_TIMEOUT_MS,
    maxBuffer: 64 * 1024
  });
  const remote = result.status === 0 ? result.stdout.trim() : '';
  if (!remote) return { scheme: 'missing', host: null, repository: null, has_credentials: false };
  const normalizeRepository = (value: string): string | null => {
    const normalized = value.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    return normalized && !normalized.includes('@') ? normalized : null;
  };
  if (remote.includes('://')) {
    try {
      const parsed = new URL(remote);
      const hasCredentials = Boolean(
        parsed.password || ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.username)
      );
      if (parsed.protocol === 'ssh:') {
        return { scheme: 'ssh', host: parsed.hostname.toLowerCase(), repository: normalizeRepository(parsed.pathname), has_credentials: hasCredentials };
      }
      if (parsed.protocol === 'https:') {
        return { scheme: 'https', host: parsed.hostname.toLowerCase(), repository: normalizeRepository(parsed.pathname), has_credentials: hasCredentials };
      }
      if (parsed.protocol === 'http:') {
        return { scheme: 'http', host: parsed.hostname.toLowerCase(), repository: normalizeRepository(parsed.pathname), has_credentials: hasCredentials };
      }
      return { scheme: 'other', host: parsed.hostname.toLowerCase() || null, repository: null, has_credentials: hasCredentials };
    } catch {
      return { scheme: 'other', host: null, repository: null, has_credentials: false };
    }
  }
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(remote);
  return scp
    ? { scheme: 'ssh', host: scp[1]!.toLowerCase(), repository: normalizeRepository(scp[2]!), has_credentials: false }
    : { scheme: 'other', host: null, repository: null, has_credentials: false };
}

function assertGitConfigurationSafe(workspace: string, gitExecutable: string): void {
  const result = spawnSync(
    gitExecutable,
    ['config', '--file', path.join(workspace, '.git', 'config'), '--name-only', '--get-regexp', '.*'],
    {
      cwd: workspace,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      encoding: 'utf8',
      shell: false,
      timeout: PREFLIGHT_TIMEOUT_MS,
      maxBuffer: 64 * 1024
    }
  );
  if (result.status !== 0 && result.status !== 1) throw new Error('claude_git_config_unreadable');
  const unsafe = result.stdout
    .split(/\r?\n/)
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean)
    .some((key) =>
      key.startsWith('credential.') ||
      (key.startsWith('http.') && key.endsWith('.extraheader')) ||
      key === 'core.sshcommand' ||
      key === 'include.path' ||
      key.startsWith('includeif.')
    );
  if (unsafe) throw new Error('claude_git_config_unsafe');
}

function validateSshAgent(
  socketValue: string | undefined,
  env: NodeJS.ProcessEnv,
  forbiddenRoots: string[]
): ValidatedSshAgent | null {
  const candidate = socketValue?.trim();
  if (!candidate) return null;
  const socketPath = fs.realpathSync(candidate);
  const stat = fs.statSync(socketPath);
  if (!stat.isSocket()) throw new Error('claude_ssh_agent_not_socket');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('claude_ssh_agent_owner_mismatch');
  }
  const sshAddExecutable = resolveTrustedExecutable('ssh-add', env, forbiddenRoots);
  const probe = spawnSync(sshAddExecutable, ['-l'], {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SSH_AUTH_SOCK: socketPath },
    encoding: 'utf8',
    shell: false,
    timeout: PREFLIGHT_TIMEOUT_MS,
    maxBuffer: 64 * 1024
  });
  if (probe.status === 1) throw new Error('claude_ssh_agent_no_identities');
  if (probe.status !== 0) throw new Error('claude_ssh_agent_probe_failed');
  return {
    socketPath,
    identityHash: crypto.createHash('sha256')
      .update(`${socketPath}\0${stat.dev}\0${stat.ino}\0${stat.uid}\0${probe.stdout.trim().split(/\r?\n/).sort().join('\n')}`)
      .digest('hex')
  };
}

function resolveGitHubCapability(
  remote: GitRemoteIdentity,
  workspace: string,
  env: NodeJS.ProcessEnv,
  home: string,
  command: string,
  forbiddenRoots: string[]
): GitHubCapability | null {
  const host = remote.host;
  if (!host || (host !== 'github.com' && !host.endsWith('.github.com'))) return null;
  const executable = resolveTrustedExecutable(command, env, forbiddenRoots);
  const result = spawnSync(executable, ['auth', 'token', '--hostname', host], {
    cwd: workspace,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      USER: env.USER,
      LOGNAME: env.LOGNAME
    },
    encoding: 'utf8',
    shell: false,
    timeout: PREFLIGHT_TIMEOUT_MS,
    maxBuffer: 64 * 1024
  });
  const token = result.status === 0 ? result.stdout.trim() : '';
  if (!token) throw new Error('claude_github_auth_unavailable');
  return {
    host,
    token,
    executable,
    identityHash: crypto.createHash('sha256').update(`${host}\0${token}`).digest('hex')
  };
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function boundedTelemetryName(value: string): string {
  return trimUtf8(value.trim(), MAX_TELEMETRY_NAME_BYTES);
}

function boundedToolResultText(content: unknown): string {
  if (typeof content === 'string') return trimUtf8(content, MAX_TOOL_FAILURE_INSPECTION_BYTES);
  if (!Array.isArray(content)) return '';
  let output = '';
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block || readString(block, 'type') !== 'text') continue;
    const text = readString(block, 'text');
    if (!text) continue;
    output = trimUtf8(`${output}${output ? '\n' : ''}${text}`, MAX_TOOL_FAILURE_INSPECTION_BYTES);
    if (Buffer.byteLength(output, 'utf8') >= MAX_TOOL_FAILURE_INSPECTION_BYTES) break;
  }
  return output;
}

function sandboxRuntimeFailureCategory(content: unknown): string | null {
  const normalized = boundedToolResultText(content).toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('sandboxing requires wsl2')) return 'wsl_sandbox_unsupported';
  if (/sandbox(?:ing)? (?:initialization|startup) (?:failed|failure)/.test(normalized)) {
    return 'sandbox_initialization_failed';
  }
  if (/sandbox (?:dependency|dependencies).*(?:missing|unavailable|not found)/.test(normalized)) {
    return 'sandbox_dependency_unavailable';
  }
  if (
    normalized.includes('bwrap:') &&
    /(?:mount|namespace|unshare|sandbox)/.test(normalized) &&
    /(?:can(?:not|'t)|failed|failure|operation not permitted|no such file or directory)/.test(normalized)
  ) {
    return 'bubblewrap_containment_failed';
  }
  return null;
}

function retryCategory(value: unknown): string {
  const normalized = boundedFailureSignal(value) ?? 'unknown';
  if (/429|rate.?limit/.test(normalized)) return 'rate_limit';
  if (/overload|529/.test(normalized)) return 'overload';
  if (/network|connect|timeout|socket/.test(normalized)) return 'network';
  if (/5\d\d|server|unavailable/.test(normalized)) return 'server';
  return `unknown_sha256_${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

function createSandboxSettingsFile(
  createSettings: (directory: string) => Record<string, unknown>,
  approvedMcpConfiguration: Record<string, Record<string, unknown>>
): { directory: string; file: string; mcpFile: string; sessionTemp: string; hash: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-claude-settings-'));
  fs.chmodSync(directory, 0o700);
  const settingsDirectory = path.join(directory, 'policy');
  const sessionTemp = path.join(directory, 'session');
  fs.mkdirSync(settingsDirectory, { mode: 0o700 });
  fs.mkdirSync(sessionTemp, { mode: 0o700 });
  const file = path.join(settingsDirectory, 'settings.json');
  const mcpFile = path.join(settingsDirectory, 'mcp.json');
  const settings = createSettings(sessionTemp);
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  fs.writeFileSync(file, serialized, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(mcpFile, `${JSON.stringify({ mcpServers: approvedMcpConfiguration }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.chmodSync(file, 0o400);
  fs.chmodSync(mcpFile, 0o400);
  fs.chmodSync(settingsDirectory, 0o500);
  return { directory, file, mcpFile, sessionTemp, hash: crypto.createHash('sha256').update(serialized).digest('hex') };
}

function removeSandboxSettings(directory: string | null): void {
  if (!directory) return;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // The private directory contains no credentials and is cleaned on the next temp sweep.
  }
}

const SAFE_CHILD_ENV_NAMES = new Set([
  'CI', 'COLORTERM', 'FORCE_COLOR', 'GH_HOST', 'GITHUB_HOST', 'HOME', 'LANG', 'LOGNAME',
  'NO_COLOR', 'PATH', 'SHELL', 'SSH_AUTH_SOCK', 'TERM', 'TMPDIR', 'USER'
]);

function buildChildEnvironment(
  base: NodeJS.ProcessEnv,
  workspace: string,
  home: string,
  model: string,
  allowNonSubscriptionAuth: boolean,
  symphonyAttemptId: string | undefined
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (
      SAFE_CHILD_ENV_NAMES.has(name) ||
      name.startsWith('LC_') ||
      (base.NODE_ENV === 'test' && name.startsWith('MOCK_'))
    ) {
      output[name] = value;
    }
  }
  if (allowNonSubscriptionAuth) {
    for (const name of NON_SUBSCRIPTION_ENV_NAMES) {
      if (base[name] !== undefined) output[name] = base[name];
    }
  } else {
    for (const name of NON_SUBSCRIPTION_ENV_NAMES) delete output[name];
  }
  delete output.LINEAR_API_KEY;
  output.HOME = home;
  output.PWD = workspace;
  output.ANTHROPIC_MODEL = model;
  output.DISABLE_AUTOUPDATER = '1';
  output.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  if (symphonyAttemptId) output.SYMPHONY_ATTEMPT_ID = symphonyAttemptId;
  return stripReviewerCredentials(output);
}

interface ProcessRow {
  pid: number;
  ppid: number;
  started: string;
  command: string;
  args: string;
}

function processRowIdentity(row: ProcessRow): string {
  return crypto.createHash('sha256').update(`${row.started}\0${row.command}\0${row.args}`).digest('hex');
}

function readProcessRows(): ProcessRow[] {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm=,args='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    shell: false
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      started: match[3]!.trim(),
      command: match[4]!,
      args: match[5]!
    }));
}

function descendantProcessRows(rootPid: number | undefined, rows = readProcessRows()): ProcessRow[] {
  if (!rootPid) return [];
  const descendants = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => row.pid !== rootPid && descendants.has(row.pid));
}

// Claude CLI 2.1.x runs each sandboxed Bash tool command by re-exec'ing its own
// binary as the in-sandbox shell supervisor, with argv rewritten to
// "/proc/self/fd/N /bin/bash -c <command>". Its /proc/<pid>/exe therefore
// resolves to the claude executable even though no nested session exists. The
// supervisor is not always a direct child of the CLI root: some CLI builds
// (observed on 2.1.224) launch it behind intermediary shells and fork a
// same-argv helper child, so the exemption keys on the launcher argv shape at
// any descendant depth. A real nested claude invocation carries claude-style
// argv, and any nested claude spawned inside the sandboxed shell still appears
// as its own descendant row and fails closed.
export function isClaudeSandboxShellLauncher(argv: readonly string[]): boolean {
  return (
    argv.length === 4 &&
    /^\/proc\/self\/fd\/\d+$/.test(argv[0] ?? '') &&
    ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh'].includes(argv[1] ?? '') &&
    argv[2] === '-c'
  );
}

function readLinuxProcessArgv(pid: number): string[] | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!raw) return null;
    const argv = raw.split('\0');
    if (argv.at(-1) === '') argv.pop();
    return argv.length > 0 ? argv : null;
  } catch {
    return null;
  }
}

interface ProcessInspector {
  platform: NodeJS.Platform;
  realpath(candidate: string): string;
  readArgv(pid: number): string[] | null;
}

const hostProcessInspector: ProcessInspector = {
  platform: process.platform,
  realpath: (candidate) => fs.realpathSync(candidate),
  readArgv: readLinuxProcessArgv
};

export function findNestedClaudeDescendant(
  rootPid: number | undefined,
  executable: string,
  rows = readProcessRows(),
  inspector: ProcessInspector = hostProcessInspector
): number | null {
  if (!rootPid) return null;
  const resolvesToExecutable = (candidate: string): boolean => {
    if (!path.isAbsolute(candidate)) return false;
    try {
      return inspector.realpath(candidate) === executable;
    } catch {
      return false;
    }
  };
  for (const row of descendantProcessRows(rootPid, rows)) {
    if (inspector.platform === 'linux') {
      try {
        if (inspector.realpath(`/proc/${row.pid}/exe`) === executable) {
          const argv = inspector.readArgv(row.pid);
          if (argv && isClaudeSandboxShellLauncher(argv)) continue;
          return row.pid;
        }
      } catch {
        // The process may have exited between ps and /proc inspection.
      }
    }
    const argv = row.args.trim().split(/\s+/).slice(0, 2);
    if (resolvesToExecutable(row.command) || argv.some(resolvesToExecutable)) {
      return row.pid;
    }
  }
  return null;
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

async function cleanupProcessGroup(pid: number | undefined): Promise<'none' | 'terminated' | 'killed' | 'survived'> {
  if (!processGroupExists(pid)) return 'none';
  killProcessGroup(pid, 'SIGTERM');
  const deadline = Date.now() + TERMINATION_GRACE_MS;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return 'terminated';
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  killProcessGroup(pid, 'SIGKILL');
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline) {
    if (!processGroupExists(pid)) return 'killed';
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return 'survived';
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  const state = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {
    encoding: 'utf8',
    shell: false,
    maxBuffer: 8 * 1024
  });
  return state.status === 0 && !state.stdout.trim().toUpperCase().startsWith('Z');
}

async function writePrompt(child: ChildProcessWithoutNullStreams, prompt: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    child.stdin.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.stdin.end(prompt, 'utf8', () => {
      if (settled) return;
      settled = true;
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

  private retainSessionBinding(sessionId: string, binding: ClaudeSessionBinding, fingerprint: string | null): void {
    this.bindingBySession.delete(sessionId);
    this.bindingBySession.set(sessionId, binding);
    this.capabilityFingerprintBySession.delete(sessionId);
    if (fingerprint) this.capabilityFingerprintBySession.set(sessionId, fingerprint);
    while (this.bindingBySession.size > MAX_SESSION_BINDINGS) {
      const oldest = this.bindingBySession.keys().next().value as string | undefined;
      if (!oldest) break;
      this.bindingBySession.delete(oldest);
      this.capabilityFingerprintBySession.delete(oldest);
    }
  }

  constructor(private readonly options: ClaudeCliRunnerOptions) {
    this.env = { ...process.env, ...options.env };
    this.homedir = options.homedir ?? (() => this.env.HOME?.trim() || os.homedir());
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
    let child: ChildProcessWithoutNullStreams | null = null;
    let settingsDirectory: string | null = null;
    let eventDeliveryError: string | null = null;
    let deliveryFailureHandler: (() => void) | null = null;
    const emit = (
      event: Omit<
        AgentRunnerEvent,
        'agent_runtime' | 'worker_process_pid' | 'codex_app_server_pid' | 'timestamp'
      > & { timestamp?: string }
    ): boolean => {
      try {
        input.onEvent?.({
          ...event,
          timestamp: event.timestamp ?? this.now().toISOString(),
          agent_runtime: this.runtime,
          worker_process_pid: child?.pid ?? null,
          codex_app_server_pid: null
        });
        return true;
      } catch (error) {
        eventDeliveryError = `claude_event_delivery_failed:${boundedFailureSignal(error instanceof Error ? error.message : String(error)) ?? 'unknown'}`;
        deliveryFailureHandler?.();
        return false;
      }
    };

    const cancelledBeforeSpawn = (): AgentRunResult => ({
      runtime: this.runtime,
      status: 'cancelled',
      session_id: expectedSessionId,
      thread_id: expectedSessionId ? `claude:${expectedSessionId}` : null,
      turn_id: turnId,
      last_event: CANONICAL_EVENT.agentRunner.turnCancelled,
      error_code: REASON_CODES.workerCancelRequested,
      cancellation_outcome: 'graceful_exit',
      requested_model: this.options.model,
      effective_model: null,
      retryable: false
    });

    try {
      if (input.cancellationSignal?.aborted) return cancelledBeforeSpawn();
      if (input.workerHost) throw new Error('claude_remote_worker_unsupported');
      if (!['darwin', 'linux'].includes(this.platform)) throw new Error(`claude_platform_unsupported:${this.platform}`);
      if (!path.isAbsolute(input.workspaceCwd)) throw new Error('invalid_workspace_cwd');
      const workspace = fs.realpathSync(input.workspaceCwd);
      if (!fs.statSync(workspace).isDirectory()) throw new Error('invalid_workspace_cwd');
      const workspaceSensitiveAudit = auditSensitiveWorkspaceFiles(workspace);
      if (!workspaceSensitiveAudit.complete) throw new Error('claude_workspace_sensitive_audit_incomplete');
      const gitMarker = path.join(workspace, '.git');
      if (fs.existsSync(gitMarker) && fs.lstatSync(gitMarker).isFile()) {
        throw new Error('claude_linked_worktree_metadata_unsupported');
      }
      if (Buffer.byteLength(input.prompt, 'utf8') > MAX_PROMPT_BYTES) throw new Error('claude_prompt_too_large');
      if (expectedSessionId && !SESSION_ID_PATTERN.test(expectedSessionId)) throw new Error('claude_resume_session_invalid');
      if (this.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY?.trim()) throw new Error('claude_session_persistence_disabled');
      const home = this.homedir();
      const projectRoot = fs.realpathSync(this.options.projectRoot);
      if (!fs.statSync(projectRoot).isDirectory()) throw new Error('claude_project_root_invalid');
      const executable = resolveTrustedExecutable(
        this.options.command,
        this.env,
        path.isAbsolute(this.options.command) ? [] : [workspace, projectRoot]
      );
      const projectSensitiveAudit = auditSensitiveWorkspaceFiles(projectRoot);
      if (!projectSensitiveAudit.complete) throw new Error('claude_project_sensitive_audit_incomplete');
      const projectSensitivePaths = [...new Set([
        ...projectSensitiveAudit.violations.map((violation) => violation.absolutePath),
        ...workspaceSensitiveAudit.violations.map((violation) => violation.absolutePath)
      ])].sort();
      const userSettings = assessUserSettings(home);
      if (userSettings.unsafe.length > 0) {
        throw new Error(`claude_user_settings_unsafe:${userSettings.unsafe.join(',')}`);
      }
      const userCustomAgents = assessUserCustomAgents(home);
      if (userCustomAgents.present.length > 0) {
        throw new Error(`claude_user_custom_agents_unsupported:${userCustomAgents.present.map((value) => path.basename(value)).join(',')}`);
      }
      const managedPolicy = assessManagedPolicy(this.platform, home);
      if (managedPolicy.present.length > 0) {
        throw new Error(`claude_managed_policy_unsupported:${managedPolicy.present.map((value) => path.basename(value)).join(',')}`);
      }
      const userInstructionHash = hashUserInstructionSurface(home);
      if (!this.options.allowNonSubscriptionAuth) {
        const inheritedSelectors = NON_SUBSCRIPTION_ENV_NAMES.filter((name) => Boolean(this.env[name]?.trim()));
        const selectors = [...new Set([...inheritedSelectors, ...userSettings.selectors])];
        if (selectors.length > 0) throw new Error(`claude_non_subscription_auth_forbidden:${selectors.join(',')}`);
        const tokenExpiresAt = readSubscriptionTokenExpiry(home);
        if (tokenExpiresAt !== null && tokenExpiresAt <= Date.now() + SUBSCRIPTION_TOKEN_EXPIRY_MARGIN_MS) {
          throw new Error('claude_auth_expired');
        }
      }
      const networkAllowedDomains = [
        ...new Set((this.options.networkAllowedDomains ?? []).map((value) => value.toLowerCase()))
      ].sort();
      if (networkAllowedDomains.some((value) => value === 'localhost' || value === '127.0.0.1' || value === '::1')) {
        throw new Error('claude_loopback_network_forbidden');
      }
      const allowedMcpServers = new Set((this.options.allowedMcpServers ?? []).map((value) => value.toLowerCase()));
      const requiredMcpServers = new Set((this.options.requiredMcpServers ?? []).map((value) => value.toLowerCase()));
      const userMcpConfiguration = inspectClaudeUserMcpConfiguration({
        home,
        workspace,
        allowedServers: allowedMcpServers,
        requiredServers: requiredMcpServers
      });
      if (userMcpConfiguration.unsafe.length > 0) {
        throw new Error(`claude_user_mcp_unsafe:${userMcpConfiguration.unsafe.join(',')}`);
      }
      const gitExecutable = resolveTrustedExecutable(
        this.options.gitCommand ?? 'git',
        this.env,
        this.options.gitCommand ? [] : [workspace, projectRoot]
      );
      const gitRemote = readGitRemoteIdentity(workspace, gitExecutable);
      assertGitConfigurationSafe(workspace, gitExecutable);
      if (gitRemote.has_credentials) throw new Error('claude_git_remote_contains_credentials');
      if (gitRemote.scheme === 'http') throw new Error('claude_insecure_git_remote');
      const githubCapability = resolveGitHubCapability(
        gitRemote,
        workspace,
        this.env,
        home,
        this.options.githubCommand ?? 'gh',
        this.options.githubCommand ? [] : [workspace, projectRoot]
      );
      if (gitRemote.scheme === 'ssh' && !githubCapability && this.platform === 'linux') {
        throw new Error('claude_linux_ssh_remote_unsupported');
      }
      const sshAllowed =
        gitRemote.scheme === 'ssh' &&
        !githubCapability &&
        Boolean(gitRemote.host) &&
        networkAllowedDomains.includes(gitRemote.host!);
      const sshAgent = sshAllowed
        ? validateSshAgent(this.env.SSH_AUTH_SOCK, this.env, [workspace, projectRoot])
        : null;
      const childEnv = buildChildEnvironment(
        this.env,
        workspace,
        home,
        this.options.model,
        this.options.allowNonSubscriptionAuth,
        input.runBinding?.symphony_attempt_id
      );
      if (!sshAgent) delete childEnv.SSH_AUTH_SOCK;
      else childEnv.SSH_AUTH_SOCK = sshAgent.socketPath;
      if (githubCapability) {
        childEnv.GH_TOKEN = githubCapability.token;
        childEnv.GH_HOST = githubCapability.host;
        const gitConfiguration = [
          ['credential.helper', ''],
          [`credential.https://${githubCapability.host}.helper`, `!${quoteShellArgument(githubCapability.executable)} auth git-credential`]
        ];
        if (gitRemote.scheme === 'ssh') {
          gitConfiguration.push(
            [`url.https://${githubCapability.host}/.insteadOf`, `git@${githubCapability.host}:`],
            [`url.https://${githubCapability.host}/.insteadOf`, `ssh://git@${githubCapability.host}/`]
          );
        }
        childEnv.GIT_CONFIG_COUNT = String(gitConfiguration.length);
        gitConfiguration.forEach(([key, value], index) => {
          childEnv[`GIT_CONFIG_KEY_${index}`] = key;
          childEnv[`GIT_CONFIG_VALUE_${index}`] = value;
        });
      }
      assertSupportedVersion(executable, workspace, childEnv, this.supportedVersion);
      assertApprovedAuth(executable, workspace, childEnv, home, this.options.allowNonSubscriptionAuth);
      if (input.cancellationSignal?.aborted) return cancelledBeforeSpawn();

      const protectedPathSnapshot = createClaudeSandboxPathSnapshot(claudeSandboxProtectedPathCandidates({
        executable,
        workspace,
        projectRoot,
        projectSensitivePaths,
        home,
        additionalProtectedPaths: this.env.SYMPHONY_REVIEWER_PRIVATE_KEY_PATH
          ? [this.env.SYMPHONY_REVIEWER_PRIVATE_KEY_PATH]
          : []
      }));
      let sandboxRuntimeFingerprint = `platform:${this.platform}`;
      if (this.platform === 'linux') {
        let bwrapExecutable: string | null = null;
        let socatExecutable: string | null = null;
        try {
          bwrapExecutable = resolveTrustedExecutable('bwrap', childEnv, [workspace, projectRoot]);
          socatExecutable = resolveTrustedExecutable('socat', childEnv, [workspace, projectRoot]);
        } catch {
          // The shared probe returns the canonical missing-dependency failure.
        }
        const sandboxProbe = probeClaudeSandboxRuntime({
          platform: this.platform,
          bwrapExecutable,
          socatExecutable,
          env: childEnv
        });
        if (!sandboxProbe.ready) {
          throw new Error(`claude_sandbox_runtime_failed:${sandboxProbe.reason}`);
        }
        sandboxRuntimeFingerprint = sandboxProbe.fingerprint;
      }

      const settingsFile = createSandboxSettingsFile(
        (sessionTemp) => buildSandboxSettings({
          executable,
          workspace,
          sessionTemp,
          protectedPathSnapshot,
          networkAllowedDomains,
          sshAuthSock: sshAgent?.socketPath ?? null,
          allowedMcpServers: [...allowedMcpServers].sort(),
          enableWeakerNetworkIsolation: this.platform === 'darwin'
        }),
        userMcpConfiguration.approvedServerConfiguration
      );
      settingsDirectory = settingsFile.directory;
      childEnv.TMPDIR = settingsFile.sessionTemp;
      const npmCacheDirectory = path.join(settingsFile.sessionTemp, 'npm-cache');
      fs.mkdirSync(npmCacheDirectory, { mode: 0o700 });
      childEnv.npm_config_cache = npmCacheDirectory;
      if (githubCapability) {
        const githubConfigDirectory = path.join(settingsFile.sessionTemp, 'gh-config');
        fs.mkdirSync(githubConfigDirectory, { mode: 0o700 });
        childEnv.GH_CONFIG_DIR = githubConfigDirectory;
      }
      const stableSandboxPolicy = buildSandboxSettings({
        executable,
        workspace,
        sessionTemp: '<session-temp>',
        protectedPathSnapshot,
        networkAllowedDomains,
        sshAuthSock: sshAgent?.socketPath ?? null,
        allowedMcpServers: [...allowedMcpServers].sort(),
        enableWeakerNetworkIsolation: this.platform === 'darwin'
      });
      const binding: ClaudeSessionBinding = {
        project_identity: input.runBinding?.project_identity ?? workspace,
        issue_id: input.runBinding?.issue_id ?? input.title,
        issue_identifier: input.runBinding?.issue_identifier ?? input.title,
        attempt: input.runBinding?.attempt ?? null,
        workspace_realpath: workspace,
        project_root_realpath: projectRoot,
        model: this.options.model,
        os_user: typeof process.getuid === 'function' ? process.getuid() : (this.env.USER ?? 'unknown'),
        config_hash: stableConfigurationHash([
          userSettings.hash,
          userCustomAgents.hash,
          userInstructionHash,
          managedPolicy.hash,
          userMcpConfiguration.hash,
          stableSandboxPolicy,
          protectedPathSnapshot.fingerprint,
          sandboxRuntimeFingerprint,
          [...allowedMcpServers].sort(),
          [...requiredMcpServers].sort(),
          executable,
          this.supportedVersion,
          gitRemote,
          sshAgent?.identityHash ?? null,
          githubCapability?.identityHash ?? null
        ])
      };
      if (expectedSessionId) {
        const previousBinding = this.bindingBySession.get(expectedSessionId);
        if (!previousBinding || JSON.stringify(previousBinding) !== JSON.stringify(binding)) {
          throw new Error('claude_resume_binding_mismatch');
        }
      }

      const args = [
        '--print',
        '--input-format',
        'text',
        '--output-format',
        'stream-json',
        '--verbose',
        '--setting-sources',
        'user',
        '--settings',
        settingsFile.file,
        '--mcp-config',
        settingsFile.mcpFile,
        '--strict-mcp-config',
        '--model',
        this.options.model,
        '--permission-mode',
        'bypassPermissions'
      ];
      if (expectedSessionId) args.push('--resume', expectedSessionId);
      if (input.cancellationSignal?.aborted) {
        removeSandboxSettings(settingsDirectory);
        settingsDirectory = null;
        return cancelledBeforeSpawn();
      }

      child = spawn(executable, args, {
        cwd: workspace,
        env: childEnv,
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let terminationLifecycle: 'running' | 'terminating' | 'closed' = 'running';
      let forceKillTimer: NodeJS.Timeout | null = null;
      let closeDeadlineTimer: NodeJS.Timeout | null = null;
      const clearTerminationTimers = () => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (closeDeadlineTimer) clearTimeout(closeDeadlineTimer);
        forceKillTimer = null;
        closeDeadlineTimer = null;
      };
      const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: string | null }>((resolve) => {
        let spawnError: string | null = null;
        child?.once('error', (error) => {
          spawnError = error.message;
        });
        child?.once('close', (code, signal) => {
          terminationLifecycle = 'closed';
          clearTerminationTimers();
          resolve({ code, signal, spawnError });
        });
      });
      let committed: 'cancelled' | 'timed_out' | null = null;
      let terminationCause: 'cancelled' | 'timed_out' | 'protocol' | 'runtime' | 'provider' | null = null;
      let forcedKillSent = false;
      let resolveCloseDeadline: ((value: { code: null; signal: NodeJS.Signals; spawnError: string }) => void) | null = null;
      const closeDeadlinePromise = new Promise<{ code: null; signal: NodeJS.Signals; spawnError: string }>((resolve) => {
        resolveCloseDeadline = resolve;
      });
      const state: ParsedProtocolState = {
        sessionId: null,
        initSessionId: null,
        effectiveModel: null,
        capabilityFingerprint: null,
        instructionFingerprint: null,
        skillFingerprint: null,
        terminalResult: null,
        primaryResults: [],
        terminalFailure: null,
        terminalResultCount: 0,
        auxiliaryResultCount: 0,
        continuationCount: 0,
        initCount: 0,
        apiRetryCount: 0,
        permissionDenialCount: 0,
        unknownEventCount: 0,
        lastEvent: CANONICAL_EVENT.agentRunner.processStarted,
        protocolError: null,
        runtimeFailure: null
      };
      const requestTermination = (
        cause: string,
        kind: 'cancelled' | 'timed_out' | 'protocol' | 'runtime' | 'provider'
      ) => {
        if (terminationCause) {
          if (
            kind === 'protocol' &&
            (cause === 'claude_process_group_cleanup_failed' || cause === 'claude_escaped_descendant_cleanup_failed')
          ) {
            state.protocolError = cause;
          }
          return;
        }
        terminationCause = kind;
        if (kind === 'cancelled' || kind === 'timed_out') committed = kind;
        else if (kind === 'runtime') state.runtimeFailure = cause;
        else if (kind === 'provider') state.terminalFailure = cause;
        else state.protocolError = cause;
        if (terminationLifecycle === 'closed' || forceKillTimer || closeDeadlineTimer) return;
        terminationLifecycle = 'terminating';
        killProcessGroup(child?.pid, 'SIGTERM');
        forceKillTimer = setTimeout(() => {
          if (terminationLifecycle === 'closed') return;
          forcedKillSent = true;
          killProcessGroup(child?.pid, 'SIGKILL');
        }, TERMINATION_GRACE_MS);
        closeDeadlineTimer = setTimeout(() => {
          if (terminationLifecycle === 'closed') return;
          resolveCloseDeadline?.({ code: null, signal: 'SIGKILL', spawnError: 'claude_process_close_timeout' });
        }, TERMINATION_GRACE_MS + PROCESS_CLOSE_GRACE_MS);
      };
      deliveryFailureHandler = () => requestTermination(eventDeliveryError ?? 'claude_event_delivery_failed', 'protocol');
      emit({
        event: CANONICAL_EVENT.agentRunner.processStarted,
        session_id: expectedSessionId ?? undefined,
        thread_id: expectedSessionId ? `claude:${expectedSessionId}` : undefined,
        turn_id: turnId
      });

      let stderrBytes = 0;
      const stderrHash = crypto.createHash('sha256');
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        stderrHash.update(chunk);
      });

      const decoder = new StringDecoder('utf8');
      let pending = '';
      const assistantSteps = new Map<string, UsageNumbers>();
      const observedModels = new Set<string>();
      const emittedReroutes = new Set<string>();
      const observedToolIds = new Set<string>();
      const toolNamesById = new Map<string, string>();
      const observedPermissionDenialIds = new Set<string>();
      const toolCounts: Record<string, number> = {};
      const mcpCounts: Record<string, number> = {};
      let latestPartialUsage: ProviderUsage | null = null;
      let firstAssistantAtMs: number | null = null;
      const failProtocol = (code: string) => {
        if (state.protocolError) return;
        requestTermination(code, 'protocol');
      };
      const failRuntime = (code: string) => {
        if (state.runtimeFailure) return;
        requestTermination(code, 'runtime');
      };
      const parseLine = (line: string) => {
        if (!line.trim() || state.protocolError) return;
        if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
          failProtocol('claude_protocol_line_too_large');
          return;
        }
        let payload: Record<string, unknown>;
        try {
          const parsed = asRecord(JSON.parse(line));
          if (!parsed) throw new Error('not_object');
          payload = parsed;
        } catch {
          failProtocol('claude_protocol_malformed_json');
          return;
        }
        const type = readString(payload, 'type') ?? 'unknown';
        const subtype = readString(payload, 'subtype');
        const eventName = subtype ? `${type}/${subtype}` : type;
        state.lastEvent = eventName;
        const sessionId = readString(payload, 'session_id');
        if (sessionId) {
          if (!SESSION_ID_PATTERN.test(sessionId)) failProtocol('claude_session_id_invalid');
          else if (state.sessionId && state.sessionId !== sessionId) failProtocol('claude_session_id_mismatch');
          else if (expectedSessionId && expectedSessionId !== sessionId) failProtocol('claude_resume_session_mismatch');
          else state.sessionId = sessionId;
          if (state.protocolError) return;
        }

        if (type === 'system' && subtype === 'init') {
          if (!sessionId) {
            failProtocol('claude_init_session_missing');
            return;
          }
          const activeServers = activeMcpServers(payload);
          const effectiveModel = readString(payload, 'model');
          if (!effectiveModel) {
            failProtocol('claude_init_model_missing');
            return;
          }
          const instructionFingerprint = hashInitSurface(payload, [
            'claude_md',
            'instructions',
            'instruction_sources',
            'commands',
            'slash_commands'
          ]);
          const skillFingerprint = hashInitSurface(payload, ['skills', 'agents', 'plugins']);
          const capabilityFingerprint = stableConfigurationHash([
            buildCapabilityFingerprint(payload, activeServers),
            instructionFingerprint,
            skillFingerprint
          ]);
          const unexpectedServers = [...activeServers].filter((name) => !allowedMcpServers.has(name));
          const missingServers = [...requiredMcpServers].filter((name) => !activeServers.has(name));
          if (unexpectedServers.length > 0) {
            failProtocol(`claude_unapproved_mcp_exposed:${unexpectedServers.sort().join(',')}`);
            return;
          }
          if (missingServers.length > 0) {
            failProtocol(`claude_required_mcp_missing:${missingServers.sort().join(',')}`);
            return;
          }
          if (state.initCount > state.terminalResultCount) {
            if (
              state.initSessionId !== sessionId ||
              state.effectiveModel !== effectiveModel ||
              state.capabilityFingerprint !== capabilityFingerprint
            ) {
              failProtocol('claude_duplicate_init_mismatch');
              return;
            }
            emit({
              event: CANONICAL_EVENT.agentRunner.activity,
              session_id: state.sessionId ?? undefined,
              thread_id: state.sessionId ? `claude:${state.sessionId}` : undefined,
              turn_id: turnId,
              detail: 'claude_duplicate_init_ignored',
              process_liveness_only: true
            });
            return;
          }
          state.initCount += 1;
          const isContinuationInit = state.initCount > 1;
          const previousRoundFingerprint = state.capabilityFingerprint;
          if (isContinuationInit && state.terminalResultCount !== state.initCount - 1) {
            failProtocol(`claude_init_count:${state.initCount}`);
            return;
          }
          if (isContinuationInit) {
            state.continuationCount += 1;
            state.terminalResult = null;
          }
          state.initSessionId = sessionId;
          state.effectiveModel = effectiveModel;
          observedModels.add(state.effectiveModel);
          state.instructionFingerprint = instructionFingerprint;
          state.skillFingerprint = skillFingerprint;
          state.capabilityFingerprint = capabilityFingerprint;
          if (isContinuationInit && previousRoundFingerprint && previousRoundFingerprint !== state.capabilityFingerprint) {
            failProtocol('claude_capability_fingerprint_drift');
            return;
          }
          if (expectedSessionId) {
            const previousFingerprint = this.capabilityFingerprintBySession.get(expectedSessionId);
            if (previousFingerprint && previousFingerprint !== state.capabilityFingerprint) {
              failProtocol('claude_capability_fingerprint_drift');
              return;
            }
          } else {
            const existingBinding = this.bindingBySession.get(sessionId);
            if (existingBinding) {
              failProtocol('claude_session_collision');
              return;
            }
          }
          if (isContinuationInit) {
            emit({
              event: CANONICAL_EVENT.agentRunner.activity,
              session_id: state.sessionId ?? undefined,
              thread_id: state.sessionId ? `claude:${state.sessionId}` : undefined,
              turn_id: turnId,
              detail: `claude_continuation_turn:${state.continuationCount}`
            });
            return;
          }
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
          if (isAuxiliaryResult(payload)) {
            state.auxiliaryResultCount += 1;
            return;
          }
          if (state.initCount < 1 || !state.initSessionId) {
            failProtocol('claude_result_before_init');
            return;
          }
          if (state.terminalResultCount >= state.initCount) {
            failProtocol(`claude_terminal_result_count:${state.terminalResultCount + 1}`);
            return;
          }
          state.terminalResultCount += 1;
          state.terminalResult = payload;
          state.primaryResults.push(payload);
          const resultSessionId = readString(payload, 'session_id');
          if (!resultSessionId) {
            failProtocol('claude_terminal_session_missing');
            return;
          }
          const permissionDenials = Array.isArray(payload.permission_denials) ? payload.permission_denials.length : 0;
          if (permissionDenials > 0) {
            state.permissionDenialCount += permissionDenials;
            failRuntime('claude_permission_denied_under_sandbox');
            return;
          }
          const resultSubtype = readString(payload, 'subtype');
          const apiErrorStatus = boundedFailureSignal(payload.api_error_status);
          const terminalReason = boundedFailureSignal(payload.terminal_reason ?? payload.stop_reason);
          const resultFailure = resultSubtype !== 'success'
            ? `claude_terminal_${resultSubtype ?? 'unknown'}${apiErrorStatus ? `:api_status=${apiErrorStatus}` : ''}${terminalReason ? `:reason=${terminalReason}` : ''}`
            : payload.is_error !== false
              ? /oauth access token has expired/i.test(readString(payload, 'result') ?? '')
                ? 'claude_auth_expired'
                : 'claude_terminal_is_error'
              : null;
          if (resultFailure) requestTermination(resultFailure, 'provider');
          return;
        }
        if (type === 'system' && subtype === 'api_retry') {
          state.apiRetryCount += 1;
          emit({
            event: CANONICAL_EVENT.agentRunner.activity,
            session_id: state.sessionId ?? undefined,
            turn_id: turnId,
            detail: 'claude_api_retry',
            reason_code: retryCategory(payload.error),
            process_liveness_only: true
          });
          return;
        }
        if (type === 'system' && subtype === 'permission_denied') {
          const rawToolUseId = readString(payload, 'tool_use_id') ?? readString(payload, 'toolUseId');
          const denialId = rawToolUseId ?? crypto.createHash('sha256').update(line).digest('hex');
          if (!observedPermissionDenialIds.has(denialId)) {
            observedPermissionDenialIds.add(denialId);
            state.permissionDenialCount += 1;
          }
          const deniedTool = boundedTelemetryName(readString(payload, 'tool_name') ?? 'unknown');
          emit({
            event: CANONICAL_EVENT.agentRunner.activity,
            session_id: state.sessionId ?? undefined,
            turn_id: turnId,
            detail: `claude_permission_denied:${deniedTool}`,
            reason_code: REASON_CODES.claudePermissionDenied
          });
          failRuntime('claude_permission_denied_under_sandbox');
          return;
        }
        if (type === 'assistant') {
          if (state.terminalResult) {
            failProtocol('claude_activity_after_terminal_result');
            return;
          }
          if (firstAssistantAtMs === null) firstAssistantAtMs = this.now().getTime();
          const message = asRecord(payload.message);
          const rawMessageId = message ? readString(message, 'id') : null;
          const messageId = rawMessageId
            ? crypto.createHash('sha256').update(rawMessageId).digest('hex')
            : null;
          const stepUsage = message ? usageNumbers(message.usage) : null;
          if (messageId && stepUsage) {
            if (!assistantSteps.has(messageId) && assistantSteps.size >= MAX_TELEMETRY_IDENTITIES) {
              state.unknownEventCount += 1;
            } else {
            const previous = assistantSteps.get(messageId);
            const next = maxUsage(previous, stepUsage);
            assistantSteps.set(messageId, next);
            const messageModel = message ? readString(message, 'model') : null;
            if (messageModel) {
              state.effectiveModel = messageModel;
              observedModels.add(messageModel);
              if (messageModel !== this.options.model && !emittedReroutes.has(messageModel)) {
                emittedReroutes.add(messageModel);
                emit({
                  event: CANONICAL_EVENT.agentRunner.activity,
                  session_id: state.sessionId ?? undefined,
                  turn_id: turnId,
                  detail: REASON_CODES.claudeModelObserved,
                  requested_model: this.options.model,
                  effective_model: messageModel,
                  model_reroute: {
                    requested_model: this.options.model,
                    effective_model: messageModel,
                    reason_code: REASON_CODES.claudeModelObserved,
                    source: 'claude_assistant_step'
                  }
                });
              }
            }
            const observedAt = this.now().toISOString();
            latestPartialUsage = partialUsageSnapshot(
              assistantSteps,
              state.effectiveModel,
              observedModels,
              state.apiRetryCount,
              toolCounts,
              mcpCounts,
              observedAt,
              {
                permissionDenialCount: state.permissionDenialCount,
                unknownEventCount: state.unknownEventCount,
                auxiliaryResultCount: state.auxiliaryResultCount
              }
            );
            if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) {
              emit({
                event: CANONICAL_EVENT.agentRunner.activity,
                session_id: state.sessionId ?? undefined,
                turn_id: turnId,
                detail: 'claude_usage_partial',
                provider_usage: latestPartialUsage ?? undefined,
                provider_usage_step_facts: [
                  {
                    message_id_hash: messageId,
                    model: messageModel ?? state.effectiveModel,
                    input_tokens: next.input_tokens,
                    output_tokens: next.output_tokens,
                    cache_read_tokens: next.cache_read_tokens,
                    cache_creation_tokens: next.cache_creation_tokens,
                    observed_at: observedAt
                  }
                ]
              });
            }
            }
          }
          if (message && Array.isArray(message.content)) {
            for (const rawBlock of message.content) {
              const block = asRecord(rawBlock);
              if (!block || readString(block, 'type') !== 'tool_use') continue;
              const toolName = readString(block, 'name');
              const rawToolId = readString(block, 'id');
              const toolId = rawToolId
                ? crypto.createHash('sha256').update(rawToolId).digest('hex')
                : null;
              if (!toolName || !toolId || observedToolIds.has(toolId)) continue;
              if (observedToolIds.size >= MAX_TELEMETRY_IDENTITIES) {
                state.unknownEventCount += 1;
                continue;
              }
              observedToolIds.add(toolId);
              const boundedToolName = boundedTelemetryName(toolName);
              toolNamesById.set(toolId, boundedToolName);
              toolCounts[boundedToolName] = (toolCounts[boundedToolName] ?? 0) + 1;
              const mcpServer = mcpServerFromToolName(boundedToolName);
              if (mcpServer) mcpCounts[mcpServer] = (mcpCounts[mcpServer] ?? 0) + 1;
              emit({
                event: CANONICAL_EVENT.codex.toolCallStarted,
                session_id: state.sessionId ?? undefined,
                turn_id: turnId,
                detail: 'claude_tool_started',
                tool_call_id: toolId,
                tool_name: boundedToolName,
                tool_call_evidence_source: 'worker_event'
              });
            }
          }
          if (latestPartialUsage) {
            latestPartialUsage = {
              ...latestPartialUsage,
              tool_counts: { ...toolCounts },
              mcp_counts: { ...mcpCounts }
            };
          }
          return;
        }
        if (type === 'user') {
          const message = asRecord(payload.message);
          const content = Array.isArray(message?.content)
            ? message.content
            : Array.isArray(payload.content)
              ? payload.content
              : [];
          for (const rawBlock of content) {
            const block = asRecord(rawBlock);
            if (!block || readString(block, 'type') !== 'tool_result') continue;
            const rawToolId = readString(block, 'tool_use_id') ?? readString(block, 'toolUseId');
            if (!rawToolId) continue;
            const toolId = crypto.createHash('sha256').update(rawToolId).digest('hex');
            const toolName = toolNamesById.get(toolId);
            emit({
              event: block.is_error === true ? CANONICAL_EVENT.codex.toolCallFailed : CANONICAL_EVENT.codex.toolCallCompleted,
              session_id: state.sessionId ?? undefined,
              turn_id: turnId,
              detail: block.is_error === true ? 'claude_tool_failed' : 'claude_tool_completed',
              tool_call_id: toolId,
              tool_name: toolName,
              tool_call_evidence_source: 'worker_event'
            });
            if (block.is_error === true && toolName === 'Bash') {
              const category = sandboxRuntimeFailureCategory(block.content);
              if (category) {
                emit({
                  event: CANONICAL_EVENT.agentRunner.activity,
                  session_id: state.sessionId ?? undefined,
                  turn_id: turnId,
                  detail: category,
                  reason_code: REASON_CODES.claudeSandboxRuntimeFailed
                });
                failRuntime(REASON_CODES.claudeSandboxRuntimeFailed);
              }
            }
          }
          return;
        }
        if (type === 'system') {
          return;
        }
        state.unknownEventCount += 1;
      };

      child.stdout.on('data', (chunk: Buffer) => {
        pending += decoder.write(chunk);
        if (Buffer.byteLength(pending, 'utf8') > MAX_PROTOCOL_LINE_BYTES && !pending.includes('\n')) {
          failProtocol('claude_protocol_line_too_large');
          pending = '';
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

      emit({
        event: CANONICAL_EVENT.agentRunner.turnStarted,
        session_id: expectedSessionId ?? undefined,
        thread_id: expectedSessionId ? `claude:${expectedSessionId}` : undefined,
        turn_id: turnId,
        requested_model: this.options.model,
        effective_model: state.effectiveModel
      });
      const heartbeat = setInterval(() => {
        emit({
          event: CANONICAL_EVENT.agentRunner.activity,
          session_id: state.sessionId ?? undefined,
          turn_id: turnId,
          detail: 'process_alive',
          process_liveness_only: true
        });
      }, HEARTBEAT_MS);
      const observedDescendantPids = new Map<number, string>();
      const nestedProcessMonitor = setInterval(() => {
        const processRows = readProcessRows();
        for (const descendant of descendantProcessRows(child?.pid, processRows)) {
          if (!observedDescendantPids.has(descendant.pid) && observedDescendantPids.size < MAX_TELEMETRY_IDENTITIES) {
            observedDescendantPids.set(descendant.pid, processRowIdentity(descendant));
          }
        }
        const nestedPid = findNestedClaudeDescendant(child?.pid, executable, processRows);
        if (nestedPid && !state.protocolError) {
          failProtocol('claude_nested_runtime_detected');
        }
      }, NESTED_PROCESS_SCAN_MS);

      const terminate = (outcome: 'cancelled' | 'timed_out') => {
        if (terminationCause) return;
        requestTermination(outcome, outcome);
      };
      const abortListener = () => terminate('cancelled');
      input.cancellationSignal?.addEventListener('abort', abortListener, { once: true });
      if (input.cancellationSignal?.aborted) terminate('cancelled');
      const timeout = setTimeout(() => terminate('timed_out'), input.turnTimeoutMs);

      try {
        await writePrompt(child, input.prompt);
      } catch {
        failProtocol('claude_stdin_write_failed');
      }

      const close = await Promise.race([closePromise, closeDeadlinePromise]);

      clearInterval(heartbeat);
      clearInterval(nestedProcessMonitor);
      clearTimeout(timeout);
      clearTerminationTimers();
      input.cancellationSignal?.removeEventListener('abort', abortListener);
      pending += decoder.end();
      if (pending.trim()) parseLine(pending.replace(/\r$/, ''));
      const cleanupOutcome = await cleanupProcessGroup(child.pid);
      terminationLifecycle = 'closed';
      clearTerminationTimers();
      if (cleanupOutcome === 'killed' || cleanupOutcome === 'survived') forcedKillSent = true;
      if (cleanupOutcome === 'survived') {
        failProtocol('claude_process_group_cleanup_failed');
      }
      const finalProcessRows = new Map(readProcessRows().map((row) => [row.pid, row]));
      const escapedDescendants = [...observedDescendantPids.entries()]
        .filter(([pid, identity]) => {
          const current = finalProcessRows.get(pid);
          return Boolean(current && processRowIdentity(current) === identity && processExists(pid));
        })
        .map(([pid]) => pid);
      if (escapedDescendants.length > 0) {
        for (const pid of escapedDescendants) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // The final liveness check below determines whether cleanup succeeded.
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (escapedDescendants.some(processExists)) {
          failProtocol('claude_escaped_descendant_cleanup_failed');
        }
      }
      const stderrDigest = stderrBytes > 0 ? stderrHash.digest('hex') : null;
      const terminal = state.primaryResults.at(-1) ?? null;
      const aggregateTerminal = aggregateTerminalResults(state.primaryResults);
      const permissionDenials = state.permissionDenialCount;
      const usageObservedAt = this.now().toISOString();
      const refreshedPartialUsage = partialUsageSnapshot(
        assistantSteps,
        state.effectiveModel,
        observedModels,
        state.apiRetryCount,
        toolCounts,
        mcpCounts,
        usageObservedAt,
        {
          permissionDenialCount: permissionDenials,
          unknownEventCount: state.unknownEventCount,
          auxiliaryResultCount: state.auxiliaryResultCount
        }
      );
      let finalUsage = aggregateTerminal
        ? usageFromResult(
            aggregateTerminal,
            state.effectiveModel,
            refreshedPartialUsage,
            state.apiRetryCount,
            toolCounts,
            mcpCounts,
            usageObservedAt,
            {
              timeToFirstTokenMs: firstAssistantAtMs === null ? null : Math.max(0, firstAssistantAtMs - startedAt.getTime()),
              permissionDenialCount: permissionDenials,
              unknownEventCount: state.unknownEventCount,
              auxiliaryResultCount: state.auxiliaryResultCount
            }
          )
        : refreshedPartialUsage ?? unobservedUsageSnapshot({
            model: state.effectiveModel,
            observedModels,
            apiRetryCount: state.apiRetryCount,
            permissionDenialCount: permissionDenials,
            unknownEventCount: state.unknownEventCount,
            auxiliaryResultCount: state.auxiliaryResultCount,
            toolCounts,
            mcpCounts,
            updatedAt: usageObservedAt,
            missingReason: state.runtimeFailure ?? state.protocolError ?? 'claude_terminal_missing'
          });
      if (finalUsage) {
        finalUsage = {
          ...finalUsage,
          effective_models: [...new Set([...(finalUsage.effective_models ?? []), ...observedModels])]
        };
      }
      if (state.protocolError === 'claude_nested_runtime_detected') {
        finalUsage = finalUsage
          ? {
              ...finalUsage,
              nested_session_detected: true,
              supervised_session_coverage:
                finalUsage.status === 'final' ? 'complete' : finalUsage.status === 'partial' ? 'partial' : 'missing'
            }
          : {
              ...unobservedUsageSnapshot({
              model: state.effectiveModel,
              observedModels,
              apiRetryCount: state.apiRetryCount,
              permissionDenialCount: permissionDenials,
              unknownEventCount: state.unknownEventCount,
              auxiliaryResultCount: state.auxiliaryResultCount,
              toolCounts,
              mcpCounts,
              updatedAt: usageObservedAt,
              missingReason: 'claude_nested_runtime_detected'
              }),
              nested_session_detected: true
            };
      }
      removeSandboxSettings(settingsDirectory);
      settingsDirectory = null;

      if (committed) {
        const event = committed === 'timed_out' ? CANONICAL_EVENT.agentRunner.turnTimedOut : CANONICAL_EVENT.agentRunner.turnCancelled;
        emit({ event, session_id: state.sessionId ?? undefined, turn_id: turnId, provider_usage: finalUsage ?? undefined });
        return {
          runtime: this.runtime,
          status: committed,
          session_id: state.sessionId,
          thread_id: state.sessionId ? `claude:${state.sessionId}` : null,
          turn_id: turnId,
          last_event: event,
          error_code: state.protocolError ?? (committed === 'timed_out' ? REASON_CODES.turnTimeout : REASON_CODES.workerCancelRequested),
          error_detail: [
            state.runtimeFailure ? `runtime_failure=${state.runtimeFailure}` : null,
            state.protocolError ? `containment_failure=${state.protocolError}` : null,
            stderrDigest ? `stderr_bytes=${stderrBytes};stderr_sha256=${stderrDigest}` : null
          ].filter(Boolean).join(';') || undefined,
          cancellation_outcome: committed === 'cancelled'
            ? state.protocolError === 'claude_process_group_cleanup_failed' || state.protocolError === 'claude_escaped_descendant_cleanup_failed'
              ? 'forced_kill_requested'
              : forcedKillSent ? 'forced_kill_exited' : 'graceful_exit'
            : undefined,
          provider_usage: finalUsage ?? undefined,
          retryable: committed === 'timed_out'
        };
      }

      const terminalSession = terminal ? readString(terminal, 'session_id') : null;
      const processCrash = close.spawnError || close.code !== 0
        ? `claude_process_exit:${close.code ?? close.signal ?? 'unknown'}`
        : null;
      const failure =
        close.spawnError ||
        eventDeliveryError ||
        state.runtimeFailure ||
        state.protocolError ||
        state.terminalFailure ||
        (state.terminalResultCount !== state.initCount ? `claude_terminal_result_count:${state.terminalResultCount}` : null) ||
        (state.initCount < 1 ? `claude_init_count:${state.initCount}` : null) ||
        (!state.capabilityFingerprint ? 'claude_init_missing' : null) ||
        (!state.sessionId ? 'claude_session_id_missing' : null) ||
        (!state.initSessionId ? 'claude_init_session_missing' : null) ||
        (state.initSessionId !== state.sessionId ? 'claude_init_session_mismatch' : null) ||
        (!terminalSession ? 'claude_terminal_session_missing' : null) ||
        (terminalSession !== state.sessionId ? 'claude_terminal_session_mismatch' : null) ||
        (permissionDenials > 0 ? 'claude_permission_denied_under_sandbox' : null) ||
        processCrash;

      if (failure || !terminal) {
        emit({
          event: CANONICAL_EVENT.agentRunner.turnFailed,
          session_id: state.sessionId ?? undefined,
          turn_id: turnId,
          detail: failure ?? 'claude_terminal_missing',
          provider_usage: finalUsage ?? undefined
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
          provider_usage: finalUsage ?? undefined,
          retryable: state.terminalFailure
            ? isRetryableClaudeFailure(state.terminalFailure)
            : Boolean(processCrash) && !state.protocolError && !state.runtimeFailure
            ? true
            : isRetryableClaudeFailure(failure ?? 'claude_terminal_missing')
        };
      }

      const sessionId = state.sessionId!;
      const fingerprint = state.capabilityFingerprint;
      this.retainSessionBinding(sessionId, binding, fingerprint);

      const providerUsage = finalUsage!;
      for (const observedModel of effectiveModelsFromResult(aggregateTerminal ?? terminal, state.effectiveModel)) {
        if (observedModel === this.options.model) continue;
        if (emittedReroutes.has(observedModel)) continue;
        emit({
          event: CANONICAL_EVENT.agentRunner.activity,
          session_id: sessionId,
          thread_id: `claude:${sessionId}`,
          turn_id: turnId,
          detail: REASON_CODES.claudeModelObserved,
          requested_model: this.options.model,
          effective_model: observedModel,
          model_reroute: {
            requested_model: this.options.model,
            effective_model: observedModel,
            reason_code: REASON_CODES.claudeModelObserved,
            source: 'claude_stream_result'
          }
        });
      }
      const resultText = readString(terminal, 'result');
      const completionDelivered = emit({
        event: CANONICAL_EVENT.agentRunner.turnCompleted,
        session_id: sessionId,
        thread_id: `claude:${sessionId}`,
        turn_id: turnId,
        detail: resultText ? trimUtf8(resultText, MAX_RESULT_DETAIL_BYTES) : undefined,
        provider_usage: providerUsage,
        requested_model: this.options.model,
        effective_model: state.effectiveModel
      });
      if (!completionDelivered || eventDeliveryError) {
        return {
          runtime: this.runtime,
          status: 'failed',
          session_id: sessionId,
          thread_id: `claude:${sessionId}`,
          turn_id: turnId,
          last_event: CANONICAL_EVENT.agentRunner.turnFailed,
          error_code: eventDeliveryError ?? 'claude_event_delivery_failed',
          provider_usage: providerUsage,
          requested_model: this.options.model,
          effective_model: state.effectiveModel,
          retryable: false
        };
      }
      return {
        runtime: this.runtime,
        status: 'completed',
        session_id: sessionId,
        thread_id: `claude:${sessionId}`,
        turn_id: turnId,
        last_event: CANONICAL_EVENT.agentRunner.turnCompleted,
        last_agent_message: resultText ? trimUtf8(resultText, MAX_RESULT_DETAIL_BYTES) : undefined,
        review_outcome: parseReviewOutcome(resultText ?? undefined),
        provider_usage: providerUsage,
        requested_model: this.options.model,
        effective_model: state.effectiveModel,
        retryable: false
      };
    } catch (error) {
      const emergencyCleanup = child?.pid ? await cleanupProcessGroup(child.pid) : 'none';
      removeSandboxSettings(settingsDirectory);
      const detail = error instanceof Error ? error.message : String(error);
      const errorCode = emergencyCleanup === 'survived' ? 'claude_process_group_cleanup_failed' : detail;
      emit({ event: CANONICAL_EVENT.agentRunner.turnFailed, turn_id: turnId, detail });
      return {
        runtime: this.runtime,
        status: 'failed',
        session_id: expectedSessionId,
        thread_id: expectedSessionId ? `claude:${expectedSessionId}` : null,
        turn_id: turnId,
        last_event: CANONICAL_EVENT.agentRunner.turnFailed,
        error_code: errorCode,
        error_detail: `started_at=${startedAt.toISOString()};emergency_cleanup=${emergencyCleanup};cause=${detail}`,
        requested_model: this.options.model,
        effective_model: null,
        retryable: false
      };
    }
  }
}
