import os from 'node:os';
import path from 'node:path';

import { DEFAULT_LOG_ROTATION_MAX_BYTES, DEFAULT_LOG_ROTATION_MAX_FILES } from '../observability';
import { WorkflowConfigError } from './errors';
import type { EffectiveConfig, WorkflowDefinition } from './types';

interface ResolverOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  tmpdir?: () => string;
}

interface ResolveOptions {
  workflowPath?: string;
}

const DEFAULT_LINEAR_ACTIVE_STATES = ['Todo', 'In Progress'];
const DEFAULT_LINEAR_TERMINAL_STATES = ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'];
const DEFAULT_GITHUB_ACTIVE_STATES = ['Open'];
const DEFAULT_GITHUB_TERMINAL_STATES = ['Closed'];
const DEFAULT_SYSTEM_STATE_DIR = '.symphony/system';

function getDefaultActiveStates(trackerKind: string): string[] {
  if (trackerKind === 'github') {
    return DEFAULT_GITHUB_ACTIVE_STATES;
  }

  return DEFAULT_LINEAR_ACTIVE_STATES;
}

function getDefaultTerminalStates(trackerKind: string): string[] {
  if (trackerKind === 'github') {
    return DEFAULT_GITHUB_TERMINAL_STATES;
  }

  return DEFAULT_LINEAR_TERMINAL_STATES;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function parseApprovalPolicy(
  value: unknown
):
  | string
  | {
      reject?: {
        sandbox_approval?: boolean;
        rules?: boolean;
        mcp_elicitations?: boolean;
      };
    }
  | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const rejectRaw = record.reject;
  if (typeof rejectRaw !== 'object' || rejectRaw === null || Array.isArray(rejectRaw)) {
    return {};
  }

  const rejectRecord = rejectRaw as Record<string, unknown>;
  const reject: {
    sandbox_approval?: boolean;
    rules?: boolean;
    mcp_elicitations?: boolean;
  } = {};

  if (typeof rejectRecord.sandbox_approval === 'boolean') {
    reject.sandbox_approval = rejectRecord.sandbox_approval;
  }
  if (typeof rejectRecord.rules === 'boolean') {
    reject.rules = rejectRecord.rules;
  }
  if (typeof rejectRecord.mcp_elicitations === 'boolean') {
    reject.mcp_elicitations = rejectRecord.mcp_elicitations;
  }

  return Object.keys(reject).length > 0 ? { reject } : {};
}

function readInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) {
    return parseInt(value, 10);
  }

  return fallback;
}

function readIntStrict(value: unknown, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    return fallback;
  }

  return readInt(value, Number.NaN);
}

function readString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value;
  }

  return fallback;
}

function readTruthyEnvironmentFlag(value: string | undefined): boolean {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function resolveAgentRuntime(env: NodeJS.ProcessEnv): 'codex' | 'claude-cli' {
  const value = env.SYMPHONY_AGENT_RUNTIME?.trim() || 'codex';
  if (value !== 'codex' && value !== 'claude-cli') {
    throw new WorkflowConfigError(
      'invalid_agent_runtime',
      `SYMPHONY_AGENT_RUNTIME must be codex or claude-cli, received ${JSON.stringify(value)}`
    );
  }
  return value;
}

function resolveClaudeCommand(env: NodeJS.ProcessEnv): string {
  const value = env.SYMPHONY_CLAUDE_COMMAND?.trim() || 'claude';
  if (/\s|\0/.test(value) || (value.includes(path.sep) && !path.isAbsolute(value))) {
    throw new WorkflowConfigError(
      'invalid_claude_command',
      'SYMPHONY_CLAUDE_COMMAND must be one executable name or an absolute path'
    );
  }
  return value;
}

function resolveClaudeModel(env: NodeJS.ProcessEnv, runtime: 'codex' | 'claude-cli'): string | null {
  const value = env.ANTHROPIC_MODEL?.trim() || null;
  if (runtime === 'claude-cli' && !value) {
    throw new WorkflowConfigError('invalid_claude_model', 'ANTHROPIC_MODEL is required for claude-cli');
  }
  if (
    value &&
    (
      Buffer.byteLength(value, 'utf8') > 256 ||
      !/^claude-[a-z0-9][a-z0-9.-]*\d[a-z0-9.-]*$/i.test(value) ||
      /(?:^|[.-])latest(?:$|[.-])/i.test(value)
    )
  ) {
    throw new WorkflowConfigError(
      'invalid_claude_model',
      'ANTHROPIC_MODEL must be a full pinned Claude model ID, for example claude-sonnet-4-6'
    );
  }
  return value;
}

const DEFAULT_CLAUDE_NETWORK_ALLOWED_DOMAINS = [
  'api.github.com',
  'codeload.github.com',
  'github.com',
  'mcp.linear.app',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
  'uploads.github.com'
] as const;

function resolveClaudeList(
  value: string | undefined,
  fallback: readonly string[],
  kind: 'domain' | 'mcp'
): string[] {
  const entries = value === undefined ? [...fallback] : value.split(',').map((entry) => entry.trim()).filter(Boolean);
  const pattern = kind === 'domain'
    ? /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i
    : /^[a-z0-9][a-z0-9._-]{0,127}$/i;
  if (entries.length === 0 || entries.some((entry) => !pattern.test(entry) || entry.includes('*'))) {
    throw new WorkflowConfigError(
      kind === 'domain' ? 'invalid_claude_network_allowed_domains' : 'invalid_claude_allowed_mcp_servers',
      kind === 'domain'
        ? 'SYMPHONY_CLAUDE_NETWORK_ALLOWED_DOMAINS must contain comma-separated exact non-loopback hostnames without wildcards'
        : 'SYMPHONY_CLAUDE_ALLOWED_MCP_SERVERS must contain comma-separated MCP server names'
    );
  }
  return [...new Set(entries.map((entry) => entry.toLowerCase()))].sort();
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  return fallback;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

function readStrictStringList(value: unknown, fallback: string[], fieldName: string): string[] {
  if (value === undefined || value === null) {
    return [...fallback];
  }

  if (!Array.isArray(value)) {
    throw new WorkflowConfigError(
      fieldName === 'tracker.handoff_states'
        ? 'invalid_tracker_handoff_states'
        : 'invalid_tracker_fresh_dispatch_states',
      `${fieldName} must be a string array`
    );
  }

  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new WorkflowConfigError(
        fieldName === 'tracker.handoff_states'
          ? 'invalid_tracker_handoff_states'
          : 'invalid_tracker_fresh_dispatch_states',
        `${fieldName} must be a string array of non-empty state names`
      );
    }
    return entry;
  });
}

function readOptionalStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new WorkflowConfigError('invalid_codex_extra_flags', 'codex.extra_flags must be a string array');
  }

  return value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new WorkflowConfigError('invalid_codex_extra_flags', 'codex.extra_flags must be a string array');
    }
    return entry;
  });
}

function readEnvStringList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const trimmed = value.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new WorkflowConfigError('invalid_codex_extra_flags', 'SYMPHONY_CODEX_FLAGS must be a JSON string array');
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new WorkflowConfigError('invalid_codex_extra_flags', 'SYMPHONY_CODEX_FLAGS must be a JSON string array');
  }
  return parsed as string[];
}

function resolveEnvToken(value: string, env: NodeJS.ProcessEnv): string {
  if (!value.startsWith('$')) {
    return value;
  }

  const varName = value.slice(1);
  if (!varName) {
    return '';
  }

  return env[varName] ?? '';
}

function expandHome(value: string, homedir: string): string {
  if (value === '~') {
    return homedir;
  }

  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homedir, value.slice(2));
  }

  return value;
}

function expandCodexHome(value: string, homedir: string): string {
  if (value === '$HOME') {
    return homedir;
  }

  if (value.startsWith('$HOME/') || value.startsWith('$HOME\\')) {
    return path.join(homedir, value.slice(6));
  }

  return expandHome(value, homedir);
}

function resolveCodexHome(value: string, homedir: string): string {
  const expanded = expandCodexHome(value, homedir);
  if (!path.isAbsolute(expanded) && hasPathSeparator(expanded)) {
    return path.normalize(expanded);
  }
  return expanded;
}

function readReasoningEffort(value: unknown): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }
  return undefined;
}

function readControlPlaneBackpressureHealth(value: unknown): 'slow' | 'large' | 'degraded' {
  if (typeof value !== 'string') {
    return 'degraded';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'slow' || normalized === 'large' || normalized === 'degraded') {
    return normalized;
  }
  return 'degraded';
}

function hasPathSeparator(value: string): boolean {
  return (
    value.includes('/') ||
    value.includes('\\') ||
    value === '~' ||
    value.startsWith('~/') ||
    value.startsWith('~\\') ||
    value === '.' ||
    value === '..'
  );
}

function resolvePathLikeValue(
  value: unknown,
  env: NodeJS.ProcessEnv,
  homedir: string,
  fallback: string,
  options?: {
    relativeBaseDir?: string;
  }
): string {
  const raw = readString(value, fallback);
  const envResolved = resolveEnvToken(raw, env);
  const homeResolved = expandHome(envResolved, homedir);

  if (!hasPathSeparator(homeResolved)) {
    return homeResolved;
  }

  if (!path.isAbsolute(homeResolved) && options?.relativeBaseDir) {
    return path.normalize(path.resolve(options.relativeBaseDir, homeResolved));
  }

  return path.normalize(homeResolved);
}

function normalizePerStateMap(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const out: Record<string, number> = {};

  for (const [key, raw] of Object.entries(record)) {
    const parsed = readIntStrict(raw, Number.NaN);
    out[key.toLowerCase()] = parsed;
  }

  return out;
}

export class ConfigResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly homedir: () => string;
  private readonly tmpdir: () => string;

  constructor(options: ResolverOptions = {}) {
    this.env = options.env ?? process.env;
    this.homedir = options.homedir ?? os.homedir;
    this.tmpdir = options.tmpdir ?? os.tmpdir;
  }

  resolve(workflowDefinition: WorkflowDefinition, options: ResolveOptions = {}): EffectiveConfig {
    const config = asRecord(workflowDefinition.config);

    const tracker = asRecord(config.tracker);
    const polling = asRecord(config.polling);
    const workspace = asRecord(config.workspace);
    const provisioner = asRecord(workspace.provisioner);
    const copyIgnored = asRecord(workspace.copy_ignored);
    const hooks = asRecord(config.hooks);
    const agent = asRecord(config.agent);
    const reviewApproval = asRecord(config.review_approval);
    const dispatchBackpressure = asRecord(agent.dispatch_backpressure);
    const budget = asRecord(config.budget);
    const codex = asRecord(config.codex);
    const persistence = asRecord(config.persistence);
    const observability = asRecord(config.observability);
    const validation = asRecord(config.validation);
    const runtimeUpdate = asRecord(config.runtime_update);
    const runtimeUpdateGithubEligibility = asRecord(runtimeUpdate.github_eligibility);
    const logging = asRecord(config.logging);
    const worker = asRecord(config.worker);
    const server = asRecord(config.server);
    const selectedAgentRuntime = resolveAgentRuntime(this.env);
    const claudeModel = resolveClaudeModel(this.env, selectedAgentRuntime);

    const trackerKind = readString(tracker.kind, '');
    const trackerEndpoint =
      resolveEnvToken(readString(tracker.endpoint, ''), this.env) ||
      (trackerKind === 'linear'
        ? 'https://api.linear.app/graphql'
        : trackerKind === 'github'
          ? 'https://api.github.com/graphql'
          : trackerKind === 'memory'
            ? 'memory://local'
          : '');

    const trackerApiKeySource =
      typeof tracker.api_key === 'string'
        ? tracker.api_key
        : trackerKind === 'linear'
          ? '$LINEAR_API_KEY'
          : trackerKind === 'github'
            ? '$GITHUB_TOKEN'
            : trackerKind === 'memory'
              ? ''
            : '';
    const trackerApiKey = resolveEnvToken(trackerApiKeySource, this.env);

    const trackerProjectSlug = resolveEnvToken(readString(tracker.project_slug, ''), this.env);
    const trackerAssignee = resolveEnvToken(readString(tracker.assignee, ''), this.env);
    const trackerOwner = resolveEnvToken(readString(tracker.owner, ''), this.env);
    const trackerRepo = resolveEnvToken(readString(tracker.repo, ''), this.env);
    const trackerGithubLinking = asRecord(tracker.github_linking);
    const trackerGithubLinkingMode = readString(trackerGithubLinking.mode, 'off').trim() || 'off';

    const workflowResolvedPath =
      typeof options.workflowPath === 'string' && options.workflowPath.trim().length > 0
        ? path.resolve(options.workflowPath)
        : null;
    const workflowDir = workflowResolvedPath ? path.dirname(workflowResolvedPath) : this.homedir();
    const defaultSystemStateRoot = path.join(workflowDir, DEFAULT_SYSTEM_STATE_DIR);
    const workspaceRoot = resolvePathLikeValue(
      workspace.root,
      this.env,
      this.homedir(),
      path.join(defaultSystemStateRoot, 'workspaces'),
      {
        relativeBaseDir: workflowResolvedPath ? workflowDir : undefined
      }
    );
    const workspaceRootSource =
      typeof workspace.root === 'string' && workspace.root.trim().length > 0 && workspaceRoot.trim().length > 0
        ? 'workflow'
        : 'default';
    const provisionerType = readString(provisioner.type, 'none').trim() || 'none';
    const provisionerRepoRootCandidate = resolvePathLikeValue(
      provisioner.repo_root,
      this.env,
      this.homedir(),
      '',
      {
        relativeBaseDir: workflowResolvedPath ? workflowDir : undefined
      }
    );
    const provisionerRepoRoot = provisionerRepoRootCandidate.trim().length > 0 ? provisionerRepoRootCandidate : undefined;
    const provisionerBaseRef = readString(provisioner.base_ref, 'origin/main').trim() || 'origin/main';
    const provisionerBranchTemplate =
      readString(provisioner.branch_template, 'feature/{{ issue.identifier }}').trim() || 'feature/{{ issue.identifier }}';
    const provisionerTeardownMode = readString(provisioner.teardown_mode, 'remove_worktree').trim() || 'remove_worktree';
    const provisionerAllowDirtyRepo = readBoolean(provisioner.allow_dirty_repo, false);
    const provisionerFallbackToCloneOnWorktreeFailure = readBoolean(
      provisioner.fallback_to_clone_on_worktree_failure,
      false
    );
    const copyIgnoredEnabled = readBoolean(copyIgnored.enabled, false);
    const copyIgnoredIncludeFileRaw = readString(copyIgnored.include_file, '.worktreeinclude').trim() || '.worktreeinclude';
    const copyIgnoredIncludeFile = path.isAbsolute(copyIgnoredIncludeFileRaw)
      ? copyIgnoredIncludeFileRaw
      : path.resolve(workflowDir, copyIgnoredIncludeFileRaw);
    const copyIgnoredFrom = readString(copyIgnored.from, 'primary_worktree').trim() || 'primary_worktree';
    const copyIgnoredConflictPolicy = readString(copyIgnored.conflict_policy, 'skip').trim() || 'skip';
    const copyIgnoredRequireGitignored = readBoolean(copyIgnored.require_gitignored, true);
    const copyIgnoredMaxFiles = readInt(copyIgnored.max_files, 10_000);
    const copyIgnoredMaxTotalBytes = readInt(copyIgnored.max_total_bytes, 5 * 1024 * 1024 * 1024);
    const copyIgnoredAllowPatterns = readStringList(copyIgnored.allow_patterns, []);
    const copyIgnoredDenyPatterns = readStringList(copyIgnored.deny_patterns, []);
    if (copyIgnoredEnabled && !isContainedPath(workflowDir, copyIgnoredIncludeFile)) {
      throw new WorkflowConfigError(
        'invalid_workspace_copy_ignored_include_file',
        'workspace.copy_ignored.include_file must be contained in the workflow directory'
      );
    }

    const hooksTimeoutMs = readIntStrict(hooks.timeout_ms, 60000);

    const codexCommandSource =
      typeof codex.command === 'string' && codex.command.trim().length > 0 ? 'workflow' : 'default';
    const codexCommand = readString(codex.command, 'codex app-server');
    const codexHomeTyped = readString(codex.home, '').trim() || undefined;
    const codexModelTyped = readString(codex.model, '').trim() || undefined;
    const codexReasoningTyped = readReasoningEffort(codex.reasoning_effort);
    if (codex.reasoning_effort !== undefined && codexReasoningTyped === undefined) {
      throw new WorkflowConfigError(
        'invalid_codex_reasoning_effort',
        "codex.reasoning_effort must be one of: low, medium, high, xhigh"
      );
    }
    const codexExtraFlagsTyped = readOptionalStringList(codex.extra_flags);
    const codexHomeEnv = readString(this.env.SYMPHONY_CODEX_HOME, '').trim() || undefined;
    const codexModelEnv = readString(this.env.SYMPHONY_CODEX_MODEL, '').trim() || undefined;
    const codexReasoningEnv = readReasoningEffort(this.env.SYMPHONY_CODEX_REASONING);
    if (
      this.env.SYMPHONY_CODEX_REASONING !== undefined &&
      this.env.SYMPHONY_CODEX_REASONING.trim().length > 0 &&
      codexReasoningEnv === undefined
    ) {
      throw new WorkflowConfigError(
        'invalid_codex_reasoning_effort',
        'SYMPHONY_CODEX_REASONING must be one of: low, medium, high, xhigh'
      );
    }
    const codexExtraFlagsEnv = readEnvStringList(this.env.SYMPHONY_CODEX_FLAGS);
    const codexHomeRaw = codexHomeTyped ?? codexHomeEnv ?? path.join(this.homedir(), '.codex');
    const effectiveCodexHome = resolveCodexHome(codexHomeRaw, this.homedir());
    const effectiveCodexModel = codexModelTyped ?? codexModelEnv ?? null;
    const effectiveReasoningEffort = codexReasoningTyped ?? codexReasoningEnv ?? null;
    const effectiveExtraFlags = codexExtraFlagsTyped ?? codexExtraFlagsEnv ?? [];
    const hasTypedCodexField =
      codexHomeTyped !== undefined ||
      codexModelTyped !== undefined ||
      codexReasoningTyped !== undefined ||
      codexExtraFlagsTyped !== undefined ||
      codexHomeEnv !== undefined ||
      codexModelEnv !== undefined ||
      codexReasoningEnv !== undefined ||
      codexExtraFlagsEnv !== undefined;
    const codexResolutionMode =
      codexCommandSource === 'workflow' && hasTypedCodexField
        ? 'mixed'
        : codexCommandSource === 'workflow'
          ? 'legacy'
          : 'typed';
    const workflowScopedPersistencePath =
      path.join(defaultSystemStateRoot, 'runtime.sqlite');

    const persistenceDbPath = resolvePathLikeValue(
      persistence.db_path,
      this.env,
      this.homedir(),
      workflowScopedPersistencePath,
      {
        relativeBaseDir: workflowResolvedPath ? workflowDir : undefined
      }
    );
    const persistenceDbPathSource =
      typeof persistence.db_path === 'string' &&
      persistence.db_path.trim().length > 0 &&
      persistenceDbPath.trim().length > 0
        ? 'workflow'
        : 'default';
    const defaultLoggingRoot = path.join(defaultSystemStateRoot, 'logs');
    const resolvedLoggingRootCandidate = resolvePathLikeValue(logging.root, this.env, this.homedir(), defaultLoggingRoot);
    const loggingRootSource =
      typeof logging.root === 'string' && logging.root.trim().length > 0 && resolvedLoggingRootCandidate.trim().length > 0
        ? 'workflow'
        : 'default';
    const loggingRoot =
      resolvedLoggingRootCandidate.trim().length > 0 ? resolvedLoggingRootCandidate : defaultLoggingRoot;
    const loggingMaxBytes = readInt(logging.max_bytes, DEFAULT_LOG_ROTATION_MAX_BYTES);
    const loggingMaxFiles = readInt(logging.max_files, DEFAULT_LOG_ROTATION_MAX_FILES);
    const uiEvidenceProfile = readString(validation.ui_evidence_profile, 'baseline').trim().toLowerCase() || 'baseline';
    const runtimeUpdateGithubEligibilityMode =
      readString(runtimeUpdateGithubEligibility.mode, 'required').trim() || 'required';

    const resolved: EffectiveConfig = {
      tracker: {
        kind: trackerKind,
        endpoint: trackerEndpoint,
        api_key: trackerApiKey,
        project_slug: trackerProjectSlug,
        assignee: trackerAssignee || undefined,
        owner: trackerOwner,
        repo: trackerRepo,
        github_linking: {
          mode: trackerGithubLinkingMode
        },
        active_states: readStringList(tracker.active_states, getDefaultActiveStates(trackerKind)),
        terminal_states: readStringList(tracker.terminal_states, getDefaultTerminalStates(trackerKind)),
        handoff_states: readStrictStringList(tracker.handoff_states, [], 'tracker.handoff_states'),
        fresh_dispatch_states: readStrictStringList(
          tracker.fresh_dispatch_states,
          [],
          'tracker.fresh_dispatch_states'
        )
      },
      polling: {
        interval_ms: readIntStrict(polling.interval_ms, 30000)
      },
      workspace: {
        root: workspaceRoot,
        root_source: workspaceRootSource,
        provisioner: {
          type: provisionerType,
          ...(provisionerRepoRoot ? { repo_root: provisionerRepoRoot } : {}),
          base_ref: provisionerBaseRef,
          branch_template: provisionerBranchTemplate,
          teardown_mode: provisionerTeardownMode,
          allow_dirty_repo: provisionerAllowDirtyRepo,
          fallback_to_clone_on_worktree_failure: provisionerFallbackToCloneOnWorktreeFailure
        },
        copy_ignored: {
          enabled: copyIgnoredEnabled,
          include_file: copyIgnoredIncludeFile,
          from: copyIgnoredFrom,
          conflict_policy: copyIgnoredConflictPolicy,
          require_gitignored: copyIgnoredRequireGitignored,
          max_files: copyIgnoredMaxFiles,
          max_total_bytes: copyIgnoredMaxTotalBytes,
          allow_patterns: copyIgnoredAllowPatterns,
          deny_patterns: copyIgnoredDenyPatterns
        }
      },
      hooks: {
        after_create: readString(hooks.after_create, '') || undefined,
        before_run: readString(hooks.before_run, '') || undefined,
        after_run: readString(hooks.after_run, '') || undefined,
        before_remove: readString(hooks.before_remove, '') || undefined,
        timeout_ms: hooksTimeoutMs
      },
      agent: {
        max_concurrent_agents: readIntStrict(agent.max_concurrent_agents, 10),
        max_retry_backoff_ms: readIntStrict(agent.max_retry_backoff_ms, 300000),
        respawn_window_minutes: readIntStrict(agent.respawn_window_minutes, 30),
        respawn_max_attempts_without_progress: readIntStrict(agent.respawn_max_attempts_without_progress, 3),
        max_turns: readIntStrict(agent.max_turns, 20),
        max_concurrent_agents_by_state: normalizePerStateMap(agent.max_concurrent_agents_by_state),
        dispatch_backpressure: {
          enabled: readBoolean(dispatchBackpressure.enabled, true),
          retry_delay_ms: readIntStrict(dispatchBackpressure.retry_delay_ms, 30000),
          min_running_agents: readIntStrict(dispatchBackpressure.min_running_agents, 1),
          control_plane_health: readControlPlaneBackpressureHealth(dispatchBackpressure.control_plane_health),
          control_plane_stale_after_ms: readIntStrict(dispatchBackpressure.control_plane_stale_after_ms, 60000),
          ...(dispatchBackpressure.host_load_per_cpu !== undefined
            ? { host_load_per_cpu: Number(dispatchBackpressure.host_load_per_cpu) }
            : {})
        }
      },
      agent_runtime: {
        selected: selectedAgentRuntime,
        claude_command: resolveClaudeCommand(this.env),
        claude_model: claudeModel,
        claude_allow_non_subscription_auth: readTruthyEnvironmentFlag(
          this.env.SYMPHONY_CLAUDE_ALLOW_NON_SUBSCRIPTION_AUTH
        ),
        claude_network_allowed_domains: resolveClaudeList(
          this.env.SYMPHONY_CLAUDE_NETWORK_ALLOWED_DOMAINS,
          DEFAULT_CLAUDE_NETWORK_ALLOWED_DOMAINS,
          'domain'
        ),
        claude_allowed_mcp_servers: [
          ...new Set([
            'linear-server',
            ...resolveClaudeList(this.env.SYMPHONY_CLAUDE_ALLOWED_MCP_SERVERS, ['linear-server'], 'mcp')
          ])
        ].sort(),
        claude_supported_version: '2.1.224'
      },
      ...(Object.keys(reviewApproval).length > 0
        ? {
            review_approval: {
              provider: readString(reviewApproval.provider, '') as 'github_app',
              required: reviewApproval.required === true
            }
          }
        : {}),
      budget: {
        ...(budget.per_run_total_tokens !== undefined
          ? { per_run_total_tokens: readIntStrict(budget.per_run_total_tokens, Number.NaN) }
          : {}),
        ...(budget.per_issue_rolling_tokens !== undefined
          ? { per_issue_rolling_tokens: readIntStrict(budget.per_issue_rolling_tokens, Number.NaN) }
          : {}),
        rolling_window_minutes: readIntStrict(budget.rolling_window_minutes, 1440),
        warning_threshold_ratio:
          typeof budget.warning_threshold_ratio === 'number'
            ? budget.warning_threshold_ratio
            : typeof budget.warning_threshold_ratio === 'string' && budget.warning_threshold_ratio.trim().length > 0
              ? Number(budget.warning_threshold_ratio)
              : 0.8,
        hard_limit_policy:
          budget.hard_limit_policy === 'terminate_attempt' ? 'terminate_attempt' : 'block_requires_resume'
      },
      codex: {
        command: codexCommand,
        command_source: codexCommandSource,
        home: codexHomeTyped,
        model: codexModelTyped,
        reasoning_effort: codexReasoningTyped,
        extra_flags: codexExtraFlagsTyped,
        effective_codex_home: effectiveCodexHome,
        effective_codex_model: effectiveCodexModel,
        effective_reasoning_effort: effectiveReasoningEffort,
        effective_extra_flags: effectiveExtraFlags,
        effective_extra_flags_count: effectiveExtraFlags.length,
        codex_resolution_mode: codexResolutionMode,
        security_profile: readString(codex.security_profile, '') || undefined,
        approval_policy: parseApprovalPolicy(codex.approval_policy),
        thread_sandbox: readString(codex.thread_sandbox, '') || undefined,
        turn_sandbox_policy: readString(codex.turn_sandbox_policy, '') || undefined,
        user_input_policy: readString(codex.user_input_policy, '') || undefined,
        turn_timeout_ms: readIntStrict(codex.turn_timeout_ms, 3600000),
        read_timeout_ms: readIntStrict(codex.read_timeout_ms, 5000),
        stall_timeout_ms: readIntStrict(codex.stall_timeout_ms, 300000),
        running_wait_stall_threshold_ms: readInt(codex.running_wait_stall_threshold_ms, 300000),
        progress_heartbeat_only_warn_ms: readInt(codex.progress_heartbeat_only_warn_ms, 120000),
        progress_stalled_waiting_ms: readInt(codex.progress_stalled_waiting_ms, 300000),
        worker_opaque_activity_hard_timeout_ms: readInt(codex.worker_opaque_activity_hard_timeout_ms, 1800000)
      },
      persistence: {
        enabled: readBoolean(persistence.enabled, true),
        db_path: persistenceDbPath,
        db_path_source: persistenceDbPathSource,
        retention_days: Math.max(1, readInt(persistence.retention_days, 14))
      },
      observability: {
        dashboard_enabled: readBoolean(observability.dashboard_enabled, true),
        refresh_ms: Math.max(500, readInt(observability.refresh_ms, 4000)),
        render_interval_ms: Math.max(250, readInt(observability.render_interval_ms, 1000)),
        phase_markers_enabled: readBoolean(observability.phase_markers_enabled, true),
        phase_timeline_limit: Math.max(1, readInt(observability.phase_timeline_limit, 30)),
        phase_stale_warn_ms: Math.max(1000, readInt(observability.phase_stale_warn_ms, 45000))
      },
      validation: {
        ui_evidence_profile: uiEvidenceProfile
      },
      runtime_update: {
        github_eligibility: {
          mode: runtimeUpdateGithubEligibilityMode
        }
      },
      logging: {
        root: loggingRoot,
        root_source: loggingRootSource,
        max_bytes: loggingMaxBytes,
        max_files: loggingMaxFiles
      }
    };

    const sshHosts = readStringList(worker.ssh_hosts, []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    const maxConcurrentAgentsPerHost = readInt(worker.max_concurrent_agents_per_host, NaN);
    if (sshHosts.length > 0 || Number.isFinite(maxConcurrentAgentsPerHost)) {
      resolved.worker = {
        ...(sshHosts.length > 0 ? { ssh_hosts: sshHosts } : {}),
        ...(Number.isFinite(maxConcurrentAgentsPerHost)
          ? { max_concurrent_agents_per_host: maxConcurrentAgentsPerHost }
          : {})
      };
    }

    const serverPort = readInt(server.port, NaN);
    if (Number.isFinite(serverPort)) {
      resolved.server = {
        port: serverPort,
        host: readString(server.host, '') || undefined
      };
    }

    return resolved;
  }
}
