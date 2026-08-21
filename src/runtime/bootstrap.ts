import fs from 'node:fs';
import dns from 'node:dns/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { ControlPlaneHealthRecorder, LocalApiServer, type ApiProjectLayoutDiagnostics } from '../api';
import { SnapshotService } from '../api/snapshot-service';
import { CodexRunner, createDefaultDynamicToolExecutor } from '../codex';
import { ClaudeCliRunner, CodexAgentRunner, type AgentRunnerEvent } from '../agent';
import {
  DEFAULT_LOG_FILE_NAME,
  LevelFilterSink,
  type LogEntry,
  type LogSink,
  MultiSinkLogger,
  RotatingFileSink,
  TestLogCaptureSink,
  isTestLogCaptureEnabled,
  resolveTestLoggingPolicy,
  StderrSink,
  type StructuredLogger
} from '../observability';
import { CANONICAL_EVENT } from '../observability/events';
import { REASON_CODES } from '../observability/reason-codes';
import { SqlitePersistenceStore, buildDurableIdentity, type DurableIdentity } from '../persistence';
import {
  LocalRunnerBridge,
  OrchestratorCore,
  type DispatchPreflightResult,
  type OrchestratorPorts,
  type RuntimeBuildIdentityDetails,
  type RuntimeBuildIdentityState
} from '../orchestrator';
import type { WorkerObservabilityEvent } from '../orchestrator';
import { resolveSecurityProfile, securityProfileSummary } from '../security';
import { createTrackerAdapter, type TrackerAdapter } from '../tracker';
import { LocalRuntimeUpdateManager, type LocalRuntimeUpdateManagerOptions, type RuntimeRestartController } from './update-manager';
import { inspectProjectLayout } from './project-layout-inspector';
import { WorkflowConfigError } from '../workflow/errors';
import {
  WorkflowLoader,
  ConfigResolver,
  ConfigValidator,
  DEFAULT_PROMPT_TEMPLATE,
  type EffectiveConfig,
  type WorkflowDefinition
} from '../workflow';
import { WorkspaceManager, createWorkspaceProvisioner } from '../workspace';
import { ReviewApprovalCoordinator } from '../review';

interface RuntimeTimer {
  timeout: NodeJS.Timeout;
}

export interface RuntimeBootstrapOptions {
  workflowPath?: string;
  logsRoot?: string;
  host?: string;
  port?: number;
  nowMs?: () => number;
  logObserver?: StructuredLogger;
  trackerAdapter?: TrackerAdapter;
  fetchFn?: typeof fetch;
}

type LogsRootSource = 'cli' | 'workflow' | 'default';

function resolveRuntimeLogsRoot(params: {
  cliLogsRoot?: string;
  workflowLogsRoot: string;
  workflowLogsRootSource: 'workflow' | 'default';
  workflowDir: string;
}): { logsRoot: string; source: LogsRootSource } {
  if (params.cliLogsRoot && params.cliLogsRoot.trim().length > 0) {
    return {
      logsRoot: path.resolve(params.cliLogsRoot),
      source: 'cli'
    };
  }

  if (params.workflowLogsRootSource === 'workflow' && params.workflowLogsRoot.trim().length > 0) {
    const resolvedWorkflowLogsRoot = path.isAbsolute(params.workflowLogsRoot)
      ? params.workflowLogsRoot
      : path.resolve(params.workflowDir, params.workflowLogsRoot);
    return {
      logsRoot: resolvedWorkflowLogsRoot,
      source: 'workflow'
    };
  }

  return {
    logsRoot: path.join(params.workflowDir, '.symphony', 'system', 'logs'),
    source: 'default'
  };
}

function buildProjectLayoutDiagnostics(params: {
  workflowPath: string;
  workflowDir: string;
  workspaceRoot: string;
  workspaceRootSource: 'workflow' | 'default';
  logsRoot: string;
  logsRootSource: LogsRootSource;
  persistencePath: string | null;
  persistencePathSource: 'workflow' | 'default';
}): ApiProjectLayoutDiagnostics {
  const inspection = inspectProjectLayout(params.workflowDir);
  const expectedRuntimeStateRoot = path.join(params.workflowDir, '.symphony', 'system');
  const expectedPersistencePath = path.join(expectedRuntimeStateRoot, 'runtime.sqlite');
  const broadIgnoreWarning = inspection.warnings.find((warning) => warning.code === 'broad_symphony_ignore');
  const workspaceSource = params.workspaceRootSource === 'default' ? 'default_system_state' : 'explicit_override';
  const logsSource = params.logsRootSource === 'default' ? 'default_system_state' : 'explicit_override';
  const persistenceSource =
    params.persistencePathSource === 'default' ? 'default_system_state' : 'explicit_override';

  return {
    status: inspection.status,
    canonical_workflow_path: {
      path: params.workflowPath,
      source: 'runtime_contract',
      explicit_override_source: null,
      exists: inspection.workflow.exists
    },
    project_root: {
      path: inspection.projectRoot
    },
    expected_runtime_state_root: {
      path: expectedRuntimeStateRoot,
      relative_path: '.symphony/system',
      source: 'default_system_state',
      explicit_override_source: null
    },
    effective_workspace_root: {
      path: params.workspaceRoot,
      source: workspaceSource,
      explicit_override_source: params.workspaceRootSource === 'workflow' ? 'workflow' : null
    },
    effective_log_root: {
      path: params.logsRoot,
      source: logsSource,
      explicit_override_source:
        params.logsRootSource === 'cli' ? 'cli' : params.logsRootSource === 'workflow' ? 'workflow' : null
    },
    effective_persistence_path: {
      path: params.persistencePath ?? expectedPersistencePath,
      source: persistenceSource,
      explicit_override_source: persistenceSource === 'explicit_override' ? 'workflow' : null
    },
    ignore_status: {
      path: inspection.ignoreAnalysis.path,
      exists: inspection.ignoreAnalysis.exists,
      status: inspection.ignoreAnalysis.status,
      has_narrow_system_ignore: inspection.ignoreAnalysis.hasNarrowSystemIgnore,
      remediation: inspection.ignoreAnalysis.remediation
    },
    broad_ignore_warning: {
      status: broadIgnoreWarning ? 'warning' : 'ok',
      present: Boolean(broadIgnoreWarning),
      remediation: broadIgnoreWarning?.remediation ?? null
    },
    legacy_runtime_path_status: {
      status: inspection.legacyRuntimePaths.length > 0 ? 'warning' : 'ok',
      present: inspection.legacyRuntimePaths.length > 0,
      paths: inspection.legacyRuntimePaths.map((entry) => ({
        path: entry.path,
        role: entry.role,
        status: entry.status,
        exists: entry.exists
      }))
    },
    reserved_customization_path_status: {
      status: 'reserved',
      paths: inspection.reservedCustomizationPaths.map((entry) => ({
        path: entry.path,
        role: entry.role,
        status: entry.status,
        exists: entry.exists,
        loaded_by_runtime: entry.loadedByRuntime
      }))
    },
    warnings: inspection.warnings.map((warning) => ({
      code: warning.code,
      path: warning.path,
      message: warning.message,
      remediation: warning.remediation
    }))
  };
}

function ensureWritableDirectory(directoryPath: string): void {
  try {
    fs.mkdirSync(directoryPath, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown filesystem error';
    throw new WorkflowConfigError('invalid_logging_root', `logging.root is not writable at ${directoryPath}: ${message}`);
  }

  try {
    fs.accessSync(directoryPath, fs.constants.W_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown filesystem error';
    throw new WorkflowConfigError('invalid_logging_root', `logging.root is not writable at ${directoryPath}: ${message}`);
  }
}

async function assertResolvableServerHost(host: string): Promise<void> {
  const trimmed = host.trim();
  if (!trimmed || trimmed === 'localhost' || net.isIP(trimmed) !== 0) {
    return;
  }

  try {
    await dns.lookup(trimmed);
  } catch {
    throw new WorkflowConfigError('invalid_server_host', `server.host '${host}' is not resolvable`);
  }
}

function resolveBranchHeadSha(repoRoot: string | null, branchName: string | null): string | null {
  if (!repoRoot || !branchName) {
    return null;
  }
  const refs = [branchName, `refs/heads/${branchName}`, `refs/remotes/origin/${branchName}`];
  for (const ref of refs) {
    const result = spawnSync('git', ['rev-parse', ref], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
    if (result.status === 0) {
      const value = result.stdout.trim();
      if (value.length > 0) {
        return value;
      }
    }
  }
  return null;
}

function resolveGitRoot(cwd: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function resolveHeadSha(repoRoot: string | null): string | null {
  if (!repoRoot) {
    return null;
  }
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function resolveCommitTimestampMs(repoRoot: string | null, commitSha: string | null): number | null {
  if (!repoRoot || !commitSha) {
    return null;
  }
  const result = spawnSync('git', ['show', '-s', '--format=%cI', commitSha], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    return null;
  }
  const parsed = Date.parse(result.stdout.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveRepositoryBuildIdentity(repoRoot: string | null): RuntimeBuildIdentityDetails {
  const commitSha = resolveHeadSha(repoRoot);
  return {
    identity: commitSha,
    commit_sha: commitSha,
    source_timestamp_ms: resolveCommitTimestampMs(repoRoot, commitSha)
  };
}

function resolveRuntimeBuildIdentityState(params: {
  processStartedAtMs: number;
  repoRoot: string | null;
  runningBuild: RuntimeBuildIdentityDetails;
}): RuntimeBuildIdentityState {
  const currentRepositoryBuild = resolveRepositoryBuildIdentity(params.repoRoot);
  const currentBuild = {
    ...currentRepositoryBuild,
    status: currentRepositoryBuild.identity ? ('available' as const) : ('unknown' as const)
  };
  if (!currentBuild.identity) {
    return {
      process_started_at_ms: params.processStartedAtMs,
      running_build: params.runningBuild,
      current_build: currentBuild,
      status: 'unknown_current',
      health_warning: {
        code: 'unknown_current_build_identity',
        severity: 'degraded',
        message: 'Current repository build identity is unavailable',
        recommended_action: 'Validate the repository checkout and rerun build identity detection before dispatching new work.'
      }
    };
  }

  const staleByIdentity = Boolean(params.runningBuild.identity && params.runningBuild.identity !== currentBuild.identity);
  const staleByTimestamp =
    typeof params.runningBuild.source_timestamp_ms === 'number' &&
    typeof currentBuild.source_timestamp_ms === 'number' &&
    currentBuild.source_timestamp_ms > params.runningBuild.source_timestamp_ms;
  if (staleByIdentity || staleByTimestamp) {
    const runningLabel = params.runningBuild.identity ?? 'unknown';
    const currentLabel = currentBuild.identity ?? 'unknown';
    return {
      process_started_at_ms: params.processStartedAtMs,
      running_build: params.runningBuild,
      current_build: currentBuild,
      status: 'stale',
      health_warning: {
        code: 'stale_runtime_build',
        severity: 'warning',
        message: `Running runtime build ${runningLabel} is stale compared with ${currentLabel}`,
        recommended_action: 'Enter Drain Mode, wait for quiescence, rebuild, and restart Symphony.'
      }
    };
  }

  return {
    process_started_at_ms: params.processStartedAtMs,
    running_build: params.runningBuild,
    current_build: currentBuild,
    status: 'current',
    health_warning: null
  };
}

function resolveRuntimeUpdateGithubEligibilityMode(mode: string | undefined): 'required' | 'allow_absent_checks' | 'trust_raw_git' | undefined {
  if (mode === 'required' || mode === 'allow_absent_checks' || mode === 'trust_raw_git') {
    return mode;
  }
  return undefined;
}

function createProcessRestartController(): RuntimeRestartController | undefined {
  if (process.env.SYMPHONY_RESTART_SUPERVISOR !== '1' || typeof process.send !== 'function') {
    return undefined;
  }
  let requested = false;
  return {
    capability: () => ({
      mode: 'supervisor_available',
      available: true,
      reason_code: REASON_CODES.runtimeUpdateRestartSupervisorAvailable,
      detail: 'The local Symphony restart supervisor owns this dashboard child process.'
    }),
    requestRestart: async (request) => {
      if (requested) {
        return {
          accepted: false,
          reason_code: REASON_CODES.runtimeUpdateRestartDuplicate,
          message: 'A supervised restart request is already in progress.',
          old_child_pid: process.pid
        };
      }
      requested = true;
      process.send?.({
        type: 'symphony_supervised_restart_request',
        version: 1,
        attempt_id: request.attempt_id,
        target_commit_sha: request.target_commit_sha,
        old_commit_sha: request.old_commit_sha,
        requested_at: request.requested_at,
        child_pid: process.pid
      });
      return {
        accepted: true,
        reason_code: REASON_CODES.runtimeUpdateRestartRequested,
        old_child_pid: process.pid
      };
    }
  };
}

function readSupervisedRestartFailureHandoff(filePath: string | undefined): LocalRuntimeUpdateManagerOptions['supervisedRestartFailure'] {
  if (!filePath) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    fs.unlinkSync(filePath);
    if (parsed.version !== 1 || typeof parsed.attempt_id !== 'string' || !parsed.attempt_id.trim()) {
      return undefined;
    }
    const message = typeof parsed.message === 'string' && parsed.message.trim()
      ? parsed.message.slice(0, 500)
      : 'Supervisor reported that child process replacement failed.';
    return {
      attempt_id: parsed.attempt_id,
      target_commit_sha: typeof parsed.target_commit_sha === 'string' && parsed.target_commit_sha.trim()
        ? parsed.target_commit_sha
        : null,
      old_child_pid: typeof parsed.old_child_pid === 'number' && Number.isFinite(parsed.old_child_pid)
        ? parsed.old_child_pid
        : null,
      new_child_pid: typeof parsed.new_child_pid === 'number' && Number.isFinite(parsed.new_child_pid)
        ? parsed.new_child_pid
        : null,
      started_at: typeof parsed.started_at === 'string' && parsed.started_at.trim() ? parsed.started_at : null,
      failed_at: typeof parsed.failed_at === 'string' && parsed.failed_at.trim() ? parsed.failed_at : null,
      reason_code: typeof parsed.reason_code === 'string' && parsed.reason_code.trim()
        ? parsed.reason_code.slice(0, 120)
        : REASON_CODES.runtimeUpdateRestartFailed,
      message
    };
  } catch {
    return undefined;
  }
}

function extractChecklistCheckpoint(issueDescription: string | null): string | null {
  if (!issueDescription || issueDescription.trim().length === 0) {
    return null;
  }
  const checklistLines = issueDescription
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\[[ xX]\]\s+/.test(line));
  if (checklistLines.length === 0) {
    return null;
  }
  const normalized = checklistLines.join('\n');
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

function resolveTrackerScope(config: EffectiveConfig): string | null {
  if (config.tracker.kind === 'github') {
    return config.tracker.owner && config.tracker.repo ? `${config.tracker.owner}/${config.tracker.repo}` : null;
  }
  return config.tracker.project_slug || null;
}

class StructuredLoggerObserverSink implements LogSink {
  name = 'observer';
  private readonly observer: StructuredLogger;

  constructor(observer: StructuredLogger) {
    this.observer = observer;
  }

  write(entry: LogEntry, _rendered: string): void {
    this.observer.log({
      level: entry.level,
      event: entry.event,
      message: entry.message,
      context: entry.context
    });
  }
}

export interface RuntimeBootstrapResult {
  apiServer: LocalApiServer | null;
  orchestrator: OrchestratorCore;
  effectiveConfig: EffectiveConfig;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createRuntimeTerminateWorkerPort(
  bridge: Pick<LocalRunnerBridge, 'terminateWorker'>
): OrchestratorPorts['terminateWorker'] {
  return ({ issue_id, worker_handle, cleanup_workspace, reason }) =>
    bridge.terminateWorker({ issue_id, worker_handle, cleanup_workspace, reason });
}

export function toWorkerEvent(event: AgentRunnerEvent, nowMs: number): WorkerObservabilityEvent {
  const parsed = Date.parse(event.timestamp);
  return {
    timestamp_ms: Number.isFinite(parsed) ? parsed : nowMs,
    event: event.event,
    agent_runtime: event.agent_runtime,
    worker_process_pid: event.worker_process_pid,
    thread_id: event.thread_id,
    turn_id: event.turn_id,
    session_id: event.session_id,
    codex_app_server_pid: event.codex_app_server_pid,
    worker_instance_id: event.worker_instance_id,
    detail: event.detail,
    reason_code: event.reason_code,
    request_method: event.request_method,
    request_category: event.request_category,
    usage: event.usage,
    provider_usage: event.provider_usage,
    provider_usage_step_facts: event.provider_usage_step_facts,
    process_liveness_only: event.process_liveness_only,
    rate_limits: event.rate_limits,
    codex_thread_activity_at_ms: event.codex_thread_activity_at_ms,
    codex_thread_activity_source: event.codex_thread_activity_source,
    codex_thread_activity_status: event.codex_thread_activity_status,
    token_telemetry_status: event.token_telemetry_status,
    token_telemetry_last_source: event.token_telemetry_last_source,
    token_telemetry_last_at_ms: event.token_telemetry_last_at_ms,
    protocol_warnings: event.protocol_warnings,
    protocol_warning: event.protocol_warning,
    model_reroute: event.model_reroute,
    requested_model: event.requested_model,
    effective_model: event.effective_model,
    tool_call_id: event.tool_call_id,
    tool_name: event.tool_name,
    tool_call_evidence_source: event.tool_call_evidence_source
  };
}

export function createRuntimeEnvironment(options: RuntimeBootstrapOptions = {}): RuntimeBootstrapResult {
  const nowMs = options.nowMs ?? (() => Date.now());
  const workflowLoader = new WorkflowLoader();
  const resolvedWorkflowPath = workflowLoader.resolvePath({ explicitPath: options.workflowPath });
  const workflowDefinition = workflowLoader.load({ explicitPath: resolvedWorkflowPath });

  const configResolver = new ConfigResolver();
  let currentWorkflowPath = path.resolve(resolvedWorkflowPath);
  let currentWorkflowDefinition: WorkflowDefinition = workflowDefinition;
  let promptFallbackActive = workflowDefinition.prompt_template === DEFAULT_PROMPT_TEMPLATE;
  let effectiveConfig = configResolver.resolve(workflowDefinition, { workflowPath: currentWorkflowPath });
  let workflowDir = path.dirname(currentWorkflowPath);
  const startupProjectRoot = fs.realpathSync(effectiveConfig.workspace.provisioner.repo_root ?? workflowDir);
  const processStartedAtMs = nowMs();
  const runtimeIdentityRepoRoot =
    effectiveConfig.workspace.provisioner.repo_root ?? resolveGitRoot(workflowDir) ?? resolveGitRoot(process.cwd());
  const initialRepositoryBuild = resolveRepositoryBuildIdentity(runtimeIdentityRepoRoot);
  const runtimeBuildTimestampMs = process.env.SYMPHONY_RUNTIME_BUILD_TIMESTAMP
    ? Date.parse(process.env.SYMPHONY_RUNTIME_BUILD_TIMESTAMP)
    : null;
  const runtimeBuildIdentity: RuntimeBuildIdentityDetails = {
    identity: process.env.SYMPHONY_RUNTIME_BUILD_IDENTITY || process.env.SYMPHONY_RUNTIME_BUILD_SHA || initialRepositoryBuild.identity,
    commit_sha: process.env.SYMPHONY_RUNTIME_BUILD_SHA || initialRepositoryBuild.commit_sha,
    source_timestamp_ms: Number.isFinite(runtimeBuildTimestampMs) ? runtimeBuildTimestampMs : initialRepositoryBuild.source_timestamp_ms
  };
  const loggingResolution = resolveRuntimeLogsRoot({
    cliLogsRoot: options.logsRoot,
    workflowLogsRoot: effectiveConfig.logging.root,
    workflowLogsRootSource: effectiveConfig.logging.root_source,
    workflowDir
  });

  ensureWritableDirectory(loggingResolution.logsRoot);

  const activeLogFile = path.join(loggingResolution.logsRoot, DEFAULT_LOG_FILE_NAME);
  const observer = options.logObserver;
  const testLoggingPolicy = resolveTestLoggingPolicy();
  const activeSinks: LogSink[] = [
    new RotatingFileSink({
      root: loggingResolution.logsRoot,
      baseFileName: DEFAULT_LOG_FILE_NAME,
      maxBytes: effectiveConfig.logging.max_bytes,
      maxFiles: effectiveConfig.logging.max_files
    })
  ];
  if (testLoggingPolicy.visibleStderr) {
    activeSinks.unshift(new LevelFilterSink(new StderrSink(), testLoggingPolicy.visibleLevel));
  }
  if (testLoggingPolicy.isTest && isTestLogCaptureEnabled()) {
    activeSinks.push(new TestLogCaptureSink());
  }
  if (observer) {
    activeSinks.push(new StructuredLoggerObserverSink(observer));
  }
  const activeSinkNames = activeSinks.map((sink) => sink.name);
  const logger = new MultiSinkLogger({ sinks: activeSinks });

  logger.log({
    level: 'info',
    event: CANONICAL_EVENT.runtime.loggingConfigured,
    message: 'configured runtime log sinks',
    context: {
      logs_root: loggingResolution.logsRoot,
      logs_root_source: loggingResolution.source,
      active_log_file: activeLogFile,
      rotation_max_bytes: effectiveConfig.logging.max_bytes,
      rotation_max_files: effectiveConfig.logging.max_files
    }
  });

  const validator = new ConfigValidator();
  const startupValidation = validator.validate(effectiveConfig);
  if (!startupValidation.ok) {
    const canBypassTrackerCredentialValidation =
      Boolean(options.trackerAdapter) &&
      (startupValidation.error_code === 'missing_tracker_api_key' ||
        startupValidation.error_code === 'missing_tracker_project_slug' ||
        startupValidation.error_code === 'missing_tracker_owner' ||
        startupValidation.error_code === 'missing_tracker_repo');

    if (!canBypassTrackerCredentialValidation) {
      throw new Error(startupValidation.message);
    }

    logger.log({
      level: 'warn',
      event: CANONICAL_EVENT.runtime.startupValidationBypassed,
      message: startupValidation.message
    });
  }

  let tracker =
    options.trackerAdapter ??
    createTrackerAdapter(
      {
        ...effectiveConfig.tracker,
        timeout_ms: 30_000,
        page_size: 50
      },
      options.fetchFn
    );
  const trackerProxy: TrackerAdapter = {
    fetch_candidate_issues: async () => tracker.fetch_candidate_issues(),
    fetch_issues_by_states: async (state_names) => tracker.fetch_issues_by_states(state_names),
    fetch_issue_states_by_ids: async (issue_ids) => tracker.fetch_issue_states_by_ids(issue_ids),
    fetch_issue_comments: async (issue_id) => {
      if (!tracker.fetch_issue_comments) throw new Error('review_approval_comment_read_unsupported');
      return tracker.fetch_issue_comments(issue_id);
    },
    create_comment: async (issue_id, body) => tracker.create_comment(issue_id, body),
    update_issue_state: async (issue_id, state_name) => tracker.update_issue_state(issue_id, state_name)
  };

  const workspaceProvisionState: {
    last_provision_result: 'provisioned' | 'reused' | 'skipped' | 'failed' | null;
    last_teardown_result: 'removed' | 'kept' | 'skipped' | 'failed' | null;
    last_error_code: string | null;
    last_verification_result: 'verified' | 'reprovisioned' | 'failed' | null;
    last_cleanup_on_failure_result: 'cleaned' | 'cleanup_failed' | 'not_attempted' | null;
    verification_mode: 'strict' | 'none';
    last_integrity_status: 'ok' | 'reconciled' | 'failed' | null;
    last_integrity_reason_code: string | null;
    last_integrity_checked_at: string | null;
    last_integrity_reconciled_at: string | null;
  } = {
    last_provision_result: null,
    last_teardown_result: null,
    last_error_code: null,
    last_verification_result: null,
    last_cleanup_on_failure_result: null,
    verification_mode: effectiveConfig.workspace.provisioner.type === 'none' ? 'none' : 'strict',
    last_integrity_status: null,
    last_integrity_reason_code: null,
    last_integrity_checked_at: null,
    last_integrity_reconciled_at: null
  };
  const workspaceCopyIgnoredState: {
    last_status: 'start' | 'success' | 'skipped' | 'failed' | null;
    last_error_code: string | null;
    last_error_message: string | null;
    source_path: string | null;
    copied_files: number;
    skipped_existing: number;
    blocked_files: number;
    bytes_copied: number;
    duration_ms: number;
  } = {
    last_status: null,
    last_error_code: null,
    last_error_message: null,
    source_path: null,
    copied_files: 0,
    skipped_existing: 0,
    blocked_files: 0,
    bytes_copied: 0,
    duration_ms: 0
  };

  const workspaceManager = new WorkspaceManager({
    root: effectiveConfig.workspace.root,
    hooks: effectiveConfig.hooks,
    provisioner: createWorkspaceProvisioner(effectiveConfig.workspace.provisioner),
    copyIgnored: effectiveConfig.workspace.copy_ignored,
    onHookResult: (result) => {
      if (
        result.hook === 'after_run' &&
        result.status === 'failed' &&
        result.fallback_reason_code &&
        result.fallback_mode === 'mcp_github'
      ) {
        logger.log({
          level: 'warn',
          event: CANONICAL_EVENT.workspace.finalizationFallback,
          message: `workspace finalization switched to deterministic ${result.fallback_mode} fallback`,
          context: {
            hook: result.hook,
            fallback_reason_code: result.fallback_reason_code,
            fallback_mode: result.fallback_mode
          }
        });
      }
    },
    onProvisionerResult: (result) => {
      const baseContext = {
        issue_identifier: result.identifier,
        workspace_path: result.workspace_path,
        provisioner_type: result.provisioner_type,
        repo_root: effectiveConfig.workspace.provisioner.repo_root ?? null,
        base_ref: effectiveConfig.workspace.provisioner.base_ref,
        branch_name_template: effectiveConfig.workspace.provisioner.branch_template
      };

      if (result.phase === 'provision') {
        if (result.status === 'start') {
          logger.log({
            level: 'info',
            event: CANONICAL_EVENT.workspace.provisionStart,
            message: 'workspace provision started',
            context: baseContext
          });
          return;
        }
        if (result.status === 'failed') {
          workspaceProvisionState.last_provision_result = 'failed';
          workspaceProvisionState.last_error_code = result.error_code ?? 'workspace_provision_failed';
          workspaceProvisionState.last_verification_result = 'failed';
          if (workspaceProvisionState.last_error_code === 'workspace_integrity_reconcile_failed') {
            logger.log({
              level: 'error',
              event: CANONICAL_EVENT.workspace.integrityReconcileFailed,
              message: 'workspace integrity reconcile failed',
              context: baseContext
            });
          }
          logger.log({
            level: 'error',
            event: CANONICAL_EVENT.workspace.provisionFailed,
            message: result.error_message ?? 'workspace provisioning failed',
            context: {
              ...baseContext,
              error_code: workspaceProvisionState.last_error_code
            }
          });
          if (result.cleanup_attempted) {
            workspaceProvisionState.last_cleanup_on_failure_result = result.cleanup_succeeded ? 'cleaned' : 'cleanup_failed';
            logger.log({
              level: result.cleanup_succeeded ? 'info' : 'error',
              event: result.cleanup_succeeded
                ? CANONICAL_EVENT.workspace.provisionFailureCleanupSucceeded
                : CANONICAL_EVENT.workspace.provisionFailureCleanupFailed,
              message: result.cleanup_succeeded
                ? 'workspace provision failure cleanup succeeded'
                : 'workspace provision failure cleanup failed',
              context: {
                ...baseContext,
                cleanup_error: result.cleanup_error ?? null
              }
            });
          }
          if (!result.cleanup_attempted) {
            workspaceProvisionState.last_cleanup_on_failure_result = 'not_attempted';
          }
          return;
        }
        workspaceProvisionState.last_provision_result = result.status as 'provisioned' | 'reused' | 'skipped';
        workspaceProvisionState.last_error_code = null;
        workspaceProvisionState.last_verification_result = result.status === 'reused' ? 'verified' : 'reprovisioned';
        workspaceProvisionState.last_cleanup_on_failure_result = null;
        workspaceProvisionState.last_integrity_status = result.workspace_integrity_status ?? null;
        workspaceProvisionState.last_integrity_reason_code = result.workspace_integrity_reason ?? null;
        workspaceProvisionState.last_integrity_checked_at = result.workspace_integrity_checked_at ?? null;
        workspaceProvisionState.last_integrity_reconciled_at = result.workspace_integrity_reconciled_at ?? null;
        if (result.workspace_integrity_checked_at) {
          logger.log({
            level: 'info',
            event: CANONICAL_EVENT.workspace.integrityCheckStart,
            message: 'workspace integrity check started',
            context: baseContext
          });
          logger.log({
            level: result.workspace_integrity_status === 'failed' ? 'error' : 'info',
            event:
              result.workspace_integrity_status === 'failed'
                ? CANONICAL_EVENT.workspace.integrityCheckFailed
                : CANONICAL_EVENT.workspace.integrityCheckSuccess,
            message:
              result.workspace_integrity_status === 'failed'
                ? 'workspace integrity check failed'
                : 'workspace integrity check succeeded',
            context: {
              ...baseContext,
              reason_code: result.workspace_integrity_reason ?? null
            }
          });
        }
        if (result.workspace_integrity_status === 'reconciled') {
          logger.log({
            level: 'info',
            event: CANONICAL_EVENT.workspace.integrityReconcileStart,
            message: 'workspace integrity reconcile started',
            context: baseContext
          });
          logger.log({
            level:
              result.workspace_integrity_reason === 'workspace_path_missing_with_metadata_pruned' ? 'warn' : 'info',
            event: CANONICAL_EVENT.workspace.integrityReconcileSuccess,
            message: 'workspace integrity reconcile succeeded',
            context: {
              ...baseContext,
              reason_code: result.workspace_integrity_reason ?? null
            }
          });
          if (result.workspace_integrity_reason === 'workspace_path_missing_with_metadata_pruned') {
            logger.log({
              level: 'warn',
              event: CANONICAL_EVENT.workspace.staleMetadataPrunedWarning,
              message: 'workspace path missing while metadata existed; auto-pruned stale worktree metadata',
              context: baseContext
            });
          }
        }
        logger.log({
          level: 'info',
          event:
            result.status === 'reused'
              ? CANONICAL_EVENT.workspace.provisionReused
              : CANONICAL_EVENT.workspace.provisionSuccess,
          message: `workspace provision ${result.status}`,
          context: baseContext
        });
        return;
      }

      if (result.status === 'start') {
        logger.log({
          level: 'info',
          event: CANONICAL_EVENT.workspace.teardownStart,
          message: 'workspace teardown started',
          context: baseContext
        });
        return;
      }

      if (result.status === 'failed') {
        workspaceProvisionState.last_teardown_result = 'failed';
        workspaceProvisionState.last_error_code = result.error_code ?? 'workspace_provision_failed';
        if (workspaceProvisionState.last_error_code === 'workspace_integrity_reconcile_failed') {
          logger.log({
            level: 'error',
            event: CANONICAL_EVENT.workspace.integrityReconcileFailed,
            message: 'workspace integrity reconcile failed',
            context: baseContext
          });
        }
        logger.log({
          level: 'error',
          event: CANONICAL_EVENT.workspace.teardownFailed,
          message: result.error_message ?? 'workspace teardown failed',
          context: {
            ...baseContext,
            error_code: workspaceProvisionState.last_error_code
          }
        });
        return;
      }

      workspaceProvisionState.last_teardown_result = result.status as 'removed' | 'kept' | 'skipped';
      workspaceProvisionState.last_error_code = null;
      workspaceProvisionState.last_integrity_status = result.workspace_integrity_status ?? null;
      workspaceProvisionState.last_integrity_reason_code = result.workspace_integrity_reason ?? null;
      workspaceProvisionState.last_integrity_checked_at = result.workspace_integrity_checked_at ?? null;
      workspaceProvisionState.last_integrity_reconciled_at = result.workspace_integrity_reconciled_at ?? null;
      if (result.workspace_integrity_checked_at) {
        logger.log({
          level: 'info',
          event: CANONICAL_EVENT.workspace.integrityCheckStart,
          message: 'workspace integrity check started',
          context: baseContext
        });
        logger.log({
          level: result.workspace_integrity_status === 'failed' ? 'error' : 'info',
          event:
            result.workspace_integrity_status === 'failed'
              ? CANONICAL_EVENT.workspace.integrityCheckFailed
              : CANONICAL_EVENT.workspace.integrityCheckSuccess,
          message:
            result.workspace_integrity_status === 'failed'
              ? 'workspace integrity check failed'
              : 'workspace integrity check succeeded',
          context: {
            ...baseContext,
            reason_code: result.workspace_integrity_reason ?? null
          }
        });
      }
      if (result.workspace_integrity_status === 'reconciled') {
        logger.log({
          level: 'info',
          event: CANONICAL_EVENT.workspace.integrityReconcileStart,
          message: 'workspace integrity reconcile started',
          context: baseContext
        });
        logger.log({
          level:
            result.workspace_integrity_reason === 'workspace_path_missing_with_metadata_pruned' ? 'warn' : 'info',
          event: CANONICAL_EVENT.workspace.integrityReconcileSuccess,
          message: 'workspace integrity reconcile succeeded',
          context: {
            ...baseContext,
            reason_code: result.workspace_integrity_reason ?? null
          }
        });
        if (result.workspace_integrity_reason === 'workspace_path_missing_with_metadata_pruned') {
          logger.log({
            level: 'warn',
            event: CANONICAL_EVENT.workspace.staleMetadataPrunedWarning,
            message: 'workspace path missing while metadata existed; auto-pruned stale worktree metadata',
            context: baseContext
          });
        }
      }
      logger.log({
        level: 'info',
        event: CANONICAL_EVENT.workspace.teardownSuccess,
        message: `workspace teardown ${result.status}`,
        context: baseContext
      });
    },
    onCopyIgnoredResult: (result) => {
      const baseContext = {
        issue_identifier: result.identifier,
        workspace_path: result.workspace_path,
        include_file: result.include_file ?? effectiveConfig.workspace.copy_ignored.include_file,
        conflict_policy: result.conflict_policy ?? effectiveConfig.workspace.copy_ignored.conflict_policy
      };
      workspaceCopyIgnoredState.last_status = result.status;

      if (result.status === 'start') {
        logger.log({
          level: 'info',
          event: CANONICAL_EVENT.workspace.copyIgnoredStart,
          message: 'workspace copy-ignored started',
          context: baseContext
        });
        return;
      }

      if (result.status === 'failed') {
        workspaceCopyIgnoredState.last_error_code = result.error_code ?? 'workspace_copy_ignored_invalid_config';
        workspaceCopyIgnoredState.last_error_message = result.error_message ?? 'workspace copy-ignored failed';
        logger.log({
          level: 'error',
          event: CANONICAL_EVENT.workspace.copyIgnoredFailed,
          message: workspaceCopyIgnoredState.last_error_message,
          context: {
            ...baseContext,
            error_code: workspaceCopyIgnoredState.last_error_code
          }
        });
        return;
      }

      workspaceCopyIgnoredState.last_error_code = null;
      workspaceCopyIgnoredState.last_error_message = null;
      workspaceCopyIgnoredState.source_path = result.source_path ?? null;
      workspaceCopyIgnoredState.copied_files = result.copied_files ?? 0;
      workspaceCopyIgnoredState.skipped_existing = result.skipped_existing ?? 0;
      workspaceCopyIgnoredState.blocked_files = result.blocked_files ?? 0;
      workspaceCopyIgnoredState.bytes_copied = result.bytes_copied ?? 0;
      workspaceCopyIgnoredState.duration_ms = result.duration_ms ?? 0;
      logger.log({
        level: 'info',
        event: CANONICAL_EVENT.workspace.copyIgnoredSuccess,
        message: `workspace copy-ignored ${result.status}`,
        context: {
          ...baseContext,
          source_path: result.source_path ?? null,
          copied_files: result.copied_files ?? 0,
          skipped_existing: result.skipped_existing ?? 0,
          blocked_files: result.blocked_files ?? 0,
          bytes_copied: result.bytes_copied ?? 0,
          duration_ms: result.duration_ms ?? 0,
          warning: result.warning ?? null
        }
      });
    },
    onPreflightResult: (result) => {
      const parsedConflictFiles = result.conflict_files.map((file) => ({
        path: file.path,
        status: file.status,
        classification: file.classification ?? 'unknown_non_ephemeral'
      }));
      const classificationSummary = result.classification_summary ?? {
        ephemeral: 0,
        tracked_ephemeral: 0,
        unknown_non_ephemeral: 0
      };
      const context = {
        issue_identifier: result.identifier,
        workspace_path: result.workspace_path,
        cleaned_files: JSON.stringify(result.cleaned_files),
        conflict_files: JSON.stringify(parsedConflictFiles),
        resolution_hints: JSON.stringify(result.resolution_hints),
        stop_reason_code: REASON_CODES.operatorWorkspaceConflict,
        classification_summary: JSON.stringify(classificationSummary),
        next_operator_action: 'issue.resume',
        next_operator_action_endpoint: '/api/v1/issues/:issue_identifier/resume'
      };
      if (result.status === 'cleaned') {
        logger.log({
          level: 'info',
          event: CANONICAL_EVENT.workspace.preflightCleanupApplied,
          message: 'workspace preflight cleanup applied',
          context
        });
        return;
      }
      if (result.status === 'attempt_residue_recoverable') {
        logger.log({
          level: 'info',
          event: CANONICAL_EVENT.workspace.preflightCleanupApplied,
          message: 'workspace preflight allowed recoverable attempt residue',
          context: {
            ...context,
            stop_reason_code: REASON_CODES.workspaceAttemptResidueRecovered,
            next_operator_action: null,
            next_operator_action_endpoint: null
          }
        });
        return;
      }
      logger.log({
        level: 'warn',
        event: CANONICAL_EVENT.workspace.preflightConflictDetected,
        message: 'workspace preflight detected unresolved conflict',
        context
      });
    }
  });

  let activeProfile = resolveSecurityProfile(effectiveConfig.codex);
  effectiveConfig.codex.security_profile = activeProfile.name;
  effectiveConfig.codex.approval_policy = activeProfile.approval_policy;
  effectiveConfig.codex.thread_sandbox = activeProfile.thread_sandbox;
  effectiveConfig.codex.turn_sandbox_policy = activeProfile.turn_sandbox_policy.type;
  effectiveConfig.codex.user_input_policy = activeProfile.user_input_policy;

  logger.log({
    level: 'info',
    event: CANONICAL_EVENT.runtime.securityProfileActive,
    message: securityProfileSummary(activeProfile),
    context: {
      profile_name: activeProfile.name,
      approval_policy:
        typeof activeProfile.approval_policy === 'string'
          ? activeProfile.approval_policy
          : JSON.stringify(activeProfile.approval_policy),
      thread_sandbox: activeProfile.thread_sandbox,
      turn_sandbox_policy: activeProfile.turn_sandbox_policy.type
    }
  });

  const persistenceStore = effectiveConfig.persistence.enabled
    ? new SqlitePersistenceStore({
        dbPath: effectiveConfig.persistence.db_path,
        retentionDays: effectiveConfig.persistence.retention_days,
        nowMs
      })
    : null;
  const createIdentityForIssue = (params: { issue_id: string; issue_identifier: string }): DurableIdentity =>
    buildDurableIdentity({
      projectRoot: effectiveConfig.workspace.provisioner.repo_root ?? workflowDir,
      workflowPath: currentWorkflowPath,
      trackerKind: effectiveConfig.tracker.kind,
      trackerScope: resolveTrackerScope(effectiveConfig),
      remoteIssueId: params.issue_id,
      humanIssueIdentifier: params.issue_identifier
    });
  const runtimeProjectIdentity = createIdentityForIssue({
    issue_id: '__runtime__',
    issue_identifier: 'RUNTIME'
  }).project;

  const codexRunner = new CodexRunner({
    dynamicToolExecutor: createDefaultDynamicToolExecutor({
      trackerEndpoint: effectiveConfig.tracker.endpoint,
      trackerApiKey: effectiveConfig.tracker.api_key,
      fetchFn: options.fetchFn
    })
  });
  const agentRuntimeConfig = effectiveConfig.agent_runtime;
  const agentRunner =
    agentRuntimeConfig?.selected === 'claude-cli'
      ? new ClaudeCliRunner({
          command: agentRuntimeConfig.claude_command,
          model: agentRuntimeConfig.claude_model ?? '',
          projectRoot: startupProjectRoot,
          allowNonSubscriptionAuth: agentRuntimeConfig.claude_allow_non_subscription_auth,
          networkAllowedDomains: agentRuntimeConfig.claude_network_allowed_domains,
          allowedMcpServers: agentRuntimeConfig.claude_allowed_mcp_servers,
          requiredMcpServers: ['linear-server'],
          supportedVersion: agentRuntimeConfig.claude_supported_version
        })
      : new CodexAgentRunner(codexRunner);
  const reviewApprovalCoordinator = effectiveConfig.review_approval
    ? new ReviewApprovalCoordinator({
        tracker: trackerProxy,
        projectRoot: startupProjectRoot,
        workspaceRoot: effectiveConfig.workspace.root,
        managedWorkspaceRoot: effectiveConfig.workspace.root,
        baseRef: effectiveConfig.workspace.provisioner.base_ref,
        env: process.env,
        fetchFn: options.fetchFn,
        logger,
        actionLedger: persistenceStore ?? undefined
      })
    : null;
  let orchestrator: OrchestratorCore;
  let apiServer: LocalApiServer | null = null;
  let runtimeStarted = false;

  const bridge = new LocalRunnerBridge({
    workspaceManager,
    codexRunner,
    agentRunner,
    config: effectiveConfig,
    logger,
    promptTemplate: workflowDefinition.prompt_template,
    issueStateFetcher: async (issue_ids) => tracker.fetch_issue_states_by_ids(issue_ids),
    reviewOutcomeHandler: reviewApprovalCoordinator
      ? (params) => reviewApprovalCoordinator.process(params)
      : undefined,
    onWorkerExit: async ({ issue_id, reason, error, completion_reason, refreshed_state, worker_instance_id, session_id, retryable }) => {
      await orchestrator.onWorkerExit(issue_id, reason, error, {
        completion_reason,
        refreshed_state,
        worker_instance_id,
        session_id,
        retryable
      });
    },
    onWorkerEvent: ({ issue_id, event }) => {
      orchestrator.onWorkerEvent(issue_id, toWorkerEvent(event, nowMs()));
    }
  });

  const retryTimers = new Map<string, RuntimeTimer>();
  const controlPlaneHealth = new ControlPlaneHealthRecorder();
  let pollIntervalHandle: NodeJS.Timeout | null = null;

  const applyRuntimeConfig = (nextConfig: EffectiveConfig, nextWorkflowPath: string, nextDefinition: WorkflowDefinition): void => {
    let nextTracker = tracker;
    if (!options.trackerAdapter) {
      nextTracker = createTrackerAdapter(
        {
          ...nextConfig.tracker,
          timeout_ms: 30_000,
          page_size: 50
        },
        options.fetchFn
      );
    }

    const nextProfile = resolveSecurityProfile(nextConfig.codex);
    nextConfig.codex.security_profile = nextProfile.name;
    nextConfig.codex.approval_policy = nextProfile.approval_policy;
    nextConfig.codex.thread_sandbox = nextProfile.thread_sandbox;
    nextConfig.codex.turn_sandbox_policy = nextProfile.turn_sandbox_policy.type;
    nextConfig.codex.user_input_policy = nextProfile.user_input_policy;

    tracker = nextTracker;
    activeProfile = nextProfile;
    currentWorkflowPath = nextWorkflowPath;
    currentWorkflowDefinition = nextDefinition;
    promptFallbackActive = nextDefinition.prompt_template === DEFAULT_PROMPT_TEMPLATE;
    effectiveConfig = nextConfig;
    workflowDir = path.dirname(nextWorkflowPath);

    orchestrator.applyRuntimeConfig({
      poll_interval_ms: nextConfig.polling.interval_ms,
      max_concurrent_agents: nextConfig.agent.max_concurrent_agents,
      max_concurrent_agents_by_state: nextConfig.agent.max_concurrent_agents_by_state,
      max_retry_backoff_ms: nextConfig.agent.max_retry_backoff_ms,
      respawn_window_minutes: nextConfig.agent.respawn_window_minutes ?? 30,
      respawn_max_attempts_without_progress: nextConfig.agent.respawn_max_attempts_without_progress ?? 3,
      active_states: nextConfig.tracker.active_states,
      terminal_states: nextConfig.tracker.terminal_states,
      handoff_states: nextConfig.tracker.handoff_states,
      fresh_dispatch_states: nextConfig.tracker.fresh_dispatch_states,
      github_linking_mode: nextConfig.tracker.github_linking?.mode ?? 'off',
      stall_timeout_ms: nextConfig.codex.stall_timeout_ms,
      running_wait_stall_threshold_ms: nextConfig.codex.running_wait_stall_threshold_ms,
      progress_heartbeat_only_warn_ms: nextConfig.codex.progress_heartbeat_only_warn_ms,
      progress_stalled_waiting_ms: nextConfig.codex.progress_stalled_waiting_ms,
      worker_opaque_activity_hard_timeout_ms: nextConfig.codex.worker_opaque_activity_hard_timeout_ms,
      budget: nextConfig.budget,
      worker_hosts: nextConfig.worker?.ssh_hosts ?? [],
      max_concurrent_agents_per_host: nextConfig.worker?.max_concurrent_agents_per_host ?? null,
      dispatch_backpressure: nextConfig.agent.dispatch_backpressure
    });

    bridge.setRuntimeConfig(nextConfig, nextDefinition.prompt_template);
    workspaceManager.setCopyIgnoredConfig(nextConfig.workspace.copy_ignored);
    if (runtimeStarted) {
      if (pollIntervalHandle) {
        clearInterval(pollIntervalHandle);
      }
      pollIntervalHandle = setInterval(() => {
        void orchestrator.tick('interval');
      }, Math.max(1000, nextConfig.polling.interval_ms));
    }
  };

  const reloadWorkflow = async (workflowPath: string): Promise<{ workflow_path: string; applied: boolean; error?: string }> => {
    try {
      const nextPath = path.resolve(workflowPath);
      const nextDefinition = workflowLoader.load({ explicitPath: nextPath });
      const nextConfig = configResolver.resolve(nextDefinition, { workflowPath: nextPath });
      const validation = validator.validate(nextConfig);
      if (!validation.ok) {
        throw new WorkflowConfigError(validation.error_code, validation.message);
      }
      const nextProjectRoot = fs.realpathSync(nextConfig.workspace.provisioner.repo_root ?? path.dirname(nextPath));
      if (nextProjectRoot !== startupProjectRoot) {
        throw new Error('workflow_restart_required:project_root_changed');
      }
      if (JSON.stringify(nextConfig.agent_runtime) !== JSON.stringify(agentRuntimeConfig)) {
        throw new Error('workflow_restart_required:agent_runtime_changed');
      }
      if (JSON.stringify(nextConfig.review_approval) !== JSON.stringify(effectiveConfig.review_approval)) {
        throw new Error('workflow_restart_required:review_approval_changed');
      }

      applyRuntimeConfig(nextConfig, nextPath, nextDefinition);
      return {
        workflow_path: nextPath,
        applied: true
      };
    } catch (error) {
      return {
        workflow_path: currentWorkflowPath,
        applied: false,
        error: error instanceof Error ? error.message : 'workflow reload failed'
      };
    }
  };

  const dispatchPreflight = (): DispatchPreflightResult => {
    const result = validator.evaluateDispatchPreflight(effectiveConfig);
    return {
      dispatch_allowed: result.dispatch_allowed,
      reason: result.validation.ok ? undefined : result.validation.message
    };
  };

  orchestrator = new OrchestratorCore({
    config: {
      poll_interval_ms: effectiveConfig.polling.interval_ms,
      max_concurrent_agents: effectiveConfig.agent.max_concurrent_agents,
      max_concurrent_agents_by_state: effectiveConfig.agent.max_concurrent_agents_by_state,
      max_retry_backoff_ms: effectiveConfig.agent.max_retry_backoff_ms,
      respawn_window_minutes: effectiveConfig.agent.respawn_window_minutes ?? 30,
      respawn_max_attempts_without_progress: effectiveConfig.agent.respawn_max_attempts_without_progress ?? 3,
      active_states: effectiveConfig.tracker.active_states,
      terminal_states: effectiveConfig.tracker.terminal_states,
      handoff_states: effectiveConfig.tracker.handoff_states,
      fresh_dispatch_states: effectiveConfig.tracker.fresh_dispatch_states,
      github_linking_mode: effectiveConfig.tracker.github_linking?.mode ?? 'off',
      stall_timeout_ms: effectiveConfig.codex.stall_timeout_ms,
      running_wait_stall_threshold_ms: effectiveConfig.codex.running_wait_stall_threshold_ms,
      progress_heartbeat_only_warn_ms: effectiveConfig.codex.progress_heartbeat_only_warn_ms,
      progress_stalled_waiting_ms: effectiveConfig.codex.progress_stalled_waiting_ms,
      worker_opaque_activity_hard_timeout_ms: effectiveConfig.codex.worker_opaque_activity_hard_timeout_ms,
      phase_markers_enabled: effectiveConfig.observability?.phase_markers_enabled ?? true,
      phase_timeline_limit: effectiveConfig.observability?.phase_timeline_limit ?? 30,
      budget: effectiveConfig.budget,
      worker_hosts: effectiveConfig.worker?.ssh_hosts ?? [],
      max_concurrent_agents_per_host: effectiveConfig.worker?.max_concurrent_agents_per_host ?? null,
      dispatch_backpressure: effectiveConfig.agent.dispatch_backpressure
    },
    ports: {
      tracker: trackerProxy,
      dispatchPreflight,
      getControlPlaneHealth: () => controlPlaneHealth.summarize(nowMs()),
      getPersistenceHealth: () =>
        persistenceStore
          ? persistenceStore.health({ depth: 'fast', integrity_check_source: 'api' })
          : {
              enabled: false,
              db_path: null,
              retention_days: effectiveConfig.persistence.retention_days,
              health_depth: 'fast',
              run_count: 0,
              last_pruned_at: null,
              last_prune_failure_at: null,
              last_prune_failure_reason: null,
              last_prune_failure_detail: null,
              integrity_ok: true
            },
      spawnWorker: ({ issue, attempt, worker_host, resume_context, recover_workspace_attempt_residue }) =>
        bridge.spawnWorker({ issue, attempt, worker_host, resume_context, recover_workspace_attempt_residue }),
      recoverMissingToolOutput: (params) => bridge.recoverMissingToolOutput(params),
      terminateWorker: createRuntimeTerminateWorkerPort(bridge),
      scheduleRetryTimer: ({ issue_id, due_at_ms, callback }) => {
        const delayMs = Math.max(0, due_at_ms - nowMs());
        const timeout = setTimeout(() => {
          void callback().catch((error) => {
            logger.log({
              level: 'error',
              event: CANONICAL_EVENT.orchestration.retryTimerCallbackFailed,
              message: 'retry timer callback failed',
              context: {
                issue_id,
                due_at_ms,
                error: error instanceof Error ? error.message : 'unknown'
              }
            });
            apiServer?.notifyStateChanged('retry_timer_callback_failed');
          });
        }, delayMs);
        retryTimers.set(issue_id, { timeout });
        return timeout;
      },
      cancelRetryTimer: (timer_handle) => {
        const timeout = timer_handle as NodeJS.Timeout;
        clearTimeout(timeout);
        for (const [issueId, timer] of retryTimers.entries()) {
          if (timer.timeout === timeout) {
            retryTimers.delete(issueId);
          }
        }
      },
      submitBlockedIssueInputNative: async (params) => {
        const method = (params.request_method ?? '').trim().toLowerCase();
        const supportsNative =
          method === 'tool_request_user_input' || method === 'tool_requestuserinput' || method === 'mcp_elicitation_request';
        if (!supportsNative) {
          return { applied: false, code: 'transport_unsupported' as const };
        }
        const nativeResult = await codexRunner.submitBlockedInputNative({
          previous_session_id: params.previous_session_id,
          previous_thread_id: params.previous_thread_id,
          request_id: params.request_id,
          answer: params.answer
        });
        return {
          applied: nativeResult.applied,
          code: nativeResult.code,
          ...(nativeResult.message ? { message: nativeResult.message } : {})
        };
      },
      resolveProgressSignals: async (params) => ({
        commit_sha: resolveBranchHeadSha(params.repo_root, params.branch_name),
        checklist_checkpoint: extractChecklistCheckpoint(params.issue?.description ?? null),
        state_marker: params.fallback_state_marker,
        tracker_comment_created: params.previous_progress_signals?.tracker_comment_created ?? false,
        tracker_status_transition: params.previous_progress_signals?.tracker_status_transition ?? null,
        agent_review_handoff: params.previous_progress_signals?.agent_review_handoff ?? null,
        tracker_started_state: params.previous_progress_signals?.tracker_started_state ?? null
      }),
      resolveRuntimeIdentity: () =>
        resolveRuntimeBuildIdentityState({
          processStartedAtMs,
          repoRoot: runtimeIdentityRepoRoot,
          runningBuild: runtimeBuildIdentity
        }),
      notifyObservers: () => {
        apiServer?.notifyStateChanged('orchestrator_observer');
      }
    },
    nowMs,
    persistence: persistenceStore
      ? {
          startRun: async (params) => persistenceStore.startRun({ ...params, identity: createIdentityForIssue(params) }),
          recordRunStarted: async (params) =>
            persistenceStore.recordRunStarted({ ...params, identity: createIdentityForIssue(params) }),
          appendIssueRun: async (params) =>
            persistenceStore.appendIssueRun({ ...params, identity: createIdentityForIssue(params) }),
          appendAttempt: async (params) => persistenceStore.appendAttempt(params),
          appendThread: async (params) => persistenceStore.appendThread(params),
          appendTurn: async (params) => persistenceStore.appendTurn(params),
          appendPhaseSpan: async (params) => persistenceStore.appendPhaseSpan(params),
          appendToolSpan: async (params) => persistenceStore.appendToolSpan(params),
          appendStateTransition: async (params) => persistenceStore.appendStateTransition(params),
          appendTicketTerminalOutcome: async (params) => persistenceStore.appendTicketTerminalOutcome(params),
          appendTicketBlocker: async (params) => persistenceStore.appendTicketBlocker(params),
          appendTicketEvidenceReference: async (params) => persistenceStore.appendTicketEvidenceReference(params),
          appendTrackerTicketSnapshot: async (params) =>
            persistenceStore.appendTrackerTicketSnapshot({ ...params, identity: createIdentityForIssue({
              issue_id: params.remote_issue_id,
              issue_identifier: params.human_issue_identifier
            }) }),
          appendTicketReference: async (params) => persistenceStore.appendTicketReference(params),
          appendOperatorActionHistory: async (params) => persistenceStore.appendOperatorActionHistory(params),
          appendBlockedInputEvent: async (params) => persistenceStore.appendBlockedInputEvent(params),
          appendTokenModelFact: async (params) => persistenceStore.appendTokenModelFact(params),
          appendProviderUsageStepFact: async (params) => persistenceStore.appendProviderUsageStepFact(params),
          appendDrainAuditHistory: async (params) =>
            persistenceStore.appendDrainAuditHistory({ ...params, project_identity: runtimeProjectIdentity }),
          appendAppServerEvent: async (params) => persistenceStore.appendAppServerEvent(params),
          recordHistoryWriteFailure: async (params) => persistenceStore.recordHistoryWriteFailure(params),
          recordSession: async (params) => {
            persistenceStore.recordSession(params.run_id, params.session_id);
          },
          recordEvent: async (params) => {
            persistenceStore.recordEvent(params);
          },
          completeRunIncludesTerminalEvidence: persistenceStore.completeRunIncludesTerminalEvidence,
          completeRun: async (params) => {
            persistenceStore.completeRun(params);
          },
          upsertBreaker: async (params) => {
            persistenceStore.upsertBreaker(params);
          },
          deleteBreaker: async (issue_id) => {
            persistenceStore.deleteBreaker(issue_id);
          },
          upsertBlockedInput: async (issue_id, payload) => {
            persistenceStore.upsertBlockedInput(issue_id, payload);
          },
          deleteBlockedInput: async (issue_id) => {
            persistenceStore.deleteBlockedInput(issue_id);
          },
          upsertOperatorActions: async (issue_id, payload) => {
            persistenceStore.upsertOperatorActions(issue_id, payload);
          }
        }
      : undefined,
    logger
  });

  const resolvedPort = options.port ?? effectiveConfig.server?.port;
  const resolvedHost = options.host ?? effectiveConfig.server?.host ?? '127.0.0.1';
  let stopRuntime: (() => Promise<void>) | null = null;
  const runtimeUpdateSnapshotService = new SnapshotService({ nowMs });
  const supervisedRestartFailure = readSupervisedRestartFailureHandoff(process.env.SYMPHONY_RESTART_FAILURE_HANDOFF_FILE);
  const runtimeUpdateManager = new LocalRuntimeUpdateManager({
    repoRoot: runtimeIdentityRepoRoot,
    baseRef: effectiveConfig.workspace.provisioner.base_ref ?? 'main',
    remote: 'origin',
    githubEligibilityMode: resolveRuntimeUpdateGithubEligibilityMode(effectiveConfig.runtime_update?.github_eligibility.mode),
    nowMs,
    verifyDashboardAssets: async () => {
      if (!apiServer) {
        return {
          ok: false,
          checked_at: new Date(nowMs()).toISOString(),
          revision: runtimeBuildIdentity.identity ?? null,
          reason_code: REASON_CODES.runtimeUpdateDashboardAssetVerificationFailed,
          detail: 'Local API server is not available for dashboard asset verification.',
          checks: []
        };
      }
      return apiServer.verifyDashboardAssets();
    },
    runtimeIdentity: () => runtimeUpdateSnapshotService.projectRuntimeIdentity(
      orchestrator.getStateSnapshot({ includeTranscriptToolCallDiagnostics: false })
    ),
    auditSink: persistenceStore
      ? {
          appendDrainAuditHistory: async (params) =>
            persistenceStore.appendDrainAuditHistory({ ...params, project_identity: runtimeProjectIdentity }),
          recordHistoryWriteFailure: async (operation, reasonCode, error) =>
            persistenceStore.recordHistoryWriteFailure({
              operation,
              reason_code: reasonCode,
              detail: error instanceof Error ? error.message : String(error)
            })
        }
      : undefined,
    restartCommand: ['npm', 'run', 'start:dashboard'],
    restartController: createProcessRestartController(),
    supervisedRestartMetadata: process.env.SYMPHONY_RESTART_ATTEMPT_ID
      ? {
          attempt_id: process.env.SYMPHONY_RESTART_ATTEMPT_ID,
          target_commit_sha: process.env.SYMPHONY_RESTART_TARGET_SHA || null,
          old_child_pid: process.env.SYMPHONY_RESTART_OLD_CHILD_PID ? Number(process.env.SYMPHONY_RESTART_OLD_CHILD_PID) : null,
          new_child_pid: process.pid,
          started_at: process.env.SYMPHONY_RESTART_STARTED_AT || null
        }
      : undefined,
    supervisedRestartFailure
  });
  void runtimeUpdateManager.recordPendingSupervisedRestartFailure();
  if (process.env.SYMPHONY_RESTART_SUPERVISOR === '1' && typeof process.send === 'function') {
    process.on('message', (message: unknown) => {
      if (
        !message ||
        typeof message !== 'object' ||
        (message as { type?: unknown }).type !== 'symphony_supervised_restart_failed'
      ) {
        return;
      }
      const payload = message as { reason_code?: unknown; message?: unknown };
      void runtimeUpdateManager.recordSupervisedRestartFailure(
        typeof payload.reason_code === 'string' && payload.reason_code.trim()
          ? payload.reason_code
          : REASON_CODES.runtimeUpdateRestartFailed,
        typeof payload.message === 'string' && payload.message.trim()
          ? payload.message
          : 'Supervisor reported that child process replacement failed.'
      );
    });
  }
  apiServer =
    resolvedPort === undefined
      ? null
      : new LocalApiServer({
          host: resolvedHost,
          port: resolvedPort,
          snapshotSource: {
            getStateSnapshot: (options) => orchestrator.getStateSnapshot(options)
          },
          refreshSource: {
            tick: (reason) => orchestrator.tick(reason)
          },
          drainControlSource: {
            readDrainMode: () => orchestrator.readDrainMode(),
            enterDrainMode: (params) => orchestrator.enterDrainMode(params),
            exitDrainMode: (params) => orchestrator.exitDrainMode(params)
          },
          drainAuditSink: persistenceStore
            ? {
                appendDrainAuditHistory: async (params) =>
                  persistenceStore.appendDrainAuditHistory({ ...params, project_identity: runtimeProjectIdentity }),
                recordHistoryWriteFailure: async (operation, reasonCode, error) =>
                  persistenceStore.recordHistoryWriteFailure({
                    operation,
                    reason_code: reasonCode,
                    detail: error instanceof Error ? error.message : String(error)
                  })
              }
            : undefined,
          shutdownSource: {
            shutdown: async () => {
              if (!stopRuntime) {
                throw new Error('runtime shutdown is not initialized');
              }
              await stopRuntime();
            }
          },
          runtimeUpdateSource: runtimeUpdateManager,
          diagnosticsSource: {
            getActiveProfile: () => activeProfile,
            getPersistenceHealth: () =>
              persistenceStore
                ? persistenceStore.health({ depth: 'fast', integrity_check_source: 'diagnostics' })
                : {
                    enabled: false,
                    db_path: null,
                    retention_days: effectiveConfig.persistence.retention_days,
                    health_depth: 'fast',
                    run_count: 0,
                    last_pruned_at: null,
                    last_prune_failure_at: null,
                    last_prune_failure_reason: null,
                    last_prune_failure_detail: null,
                    integrity_ok: true
                  },
            listRunHistory: (limit) => (persistenceStore ? persistenceStore.listRunHistory(limit) : []),
            listCompletedProviderUsageTotals: (excludeIssueRunIds) =>
              persistenceStore ? persistenceStore.listCompletedProviderUsageTotals(excludeIssueRunIds) : [],
            listReviewApprovalActions: (issueIdentifier, limit) =>
              persistenceStore ? persistenceStore.listReviewApprovalActions(issueIdentifier, limit) : [],
            reconstructThreadLineage: (threadId) => (persistenceStore ? persistenceStore.reconstructThreadLineage(threadId) : null),
            reconstructLatestThreadLineageByIssueIdentifier: (issueIdentifier) =>
              persistenceStore ? persistenceStore.reconstructLatestThreadLineageByIssueIdentifier(issueIdentifier) : null,
            listProjectTicketIdentities: (projectKey, page) =>
              persistenceStore ? persistenceStore.listProjectTicketIdentities(projectKey, page) : { items: [], limit: page?.limit ?? 50, offset: page?.offset ?? 0, has_more: false, total: 0 },
            listProjectTicketSummaries: (projectKey, page) =>
              persistenceStore ? persistenceStore.listProjectTicketSummaries(projectKey, page) : { items: [], limit: page?.limit ?? 50, offset: page?.offset ?? 0, has_more: false, total: 0 },
            listProjectDrainAuditEvents: (projectKey, page) =>
              persistenceStore
                ? persistenceStore.listProjectDrainAuditEvents(projectKey, page)
                : { items: [], limit: page?.limit ?? 50, offset: page?.offset ?? 0, has_more: false, total: 0 },
            getProjectTicketIdentity: (projectKey, ticketKey) =>
              persistenceStore ? persistenceStore.getProjectTicketIdentity(projectKey, ticketKey) : null,
            reconstructTicketTimeline: (identity) => persistenceStore
              ? persistenceStore.reconstructTicketTimeline(identity)
              : {
                  identity,
                  issue_runs: [],
                  attempts: [],
                  threads: [],
                  turns: [],
                  phase_spans: [],
                  state_transitions: [],
                  terminal_outcomes: [],
                  blockers: [],
                  evidence_references: [],
                  tracker_snapshots: [],
                  ticket_references: [],
                  operator_actions: [],
                  drain_audit_events: [],
                  blocked_input_events: [],
                  app_server_events: [],
                  token_model_facts: []
                },
            getLoggingHealth: () => ({
              root: loggingResolution.logsRoot,
              active_file: activeLogFile,
              rotation: {
                max_bytes: effectiveConfig.logging.max_bytes,
                max_files: effectiveConfig.logging.max_files
              },
              sinks: activeSinkNames
            }),
            getUiState: () => (persistenceStore ? persistenceStore.loadUiState() : null),
            setUiState: (state) => {
              persistenceStore?.saveUiState(state);
            },
            getPromptFallbackActive: () => promptFallbackActive,
            getProjectLayoutDiagnostics: () =>
              buildProjectLayoutDiagnostics({
                workflowPath: currentWorkflowPath,
                workflowDir,
                workspaceRoot: effectiveConfig.workspace.root,
                workspaceRootSource: effectiveConfig.workspace.root_source,
                logsRoot: loggingResolution.logsRoot,
                logsRootSource: loggingResolution.source,
                persistencePath: effectiveConfig.persistence.db_path,
                persistencePathSource: effectiveConfig.persistence.db_path_source
              }),
            getPhaseMarkers: () => orchestrator.getPhaseMarkerSettings(),
            getBreakerStatuses: () =>
              orchestrator.getCircuitBreakerSnapshot().map((entry) => ({
                issue_id: entry.issue_id,
                issue_identifier: entry.issue_identifier,
                breaker_active: entry.breaker_active,
                breaker_hit_count: entry.breaker_hit_count,
                breaker_window_minutes: entry.breaker_window_minutes,
                breaker_first_hit_at: entry.breaker_first_hit_at_ms ? new Date(entry.breaker_first_hit_at_ms).toISOString() : null,
                breaker_last_hit_at: entry.breaker_last_hit_at_ms ? new Date(entry.breaker_last_hit_at_ms).toISOString() : null
              })),
            getBlockedLatchStats: () => orchestrator.getBlockedLatchDiagnostics(),
            getRuntimeResolution: () => ({
              workflow_path: currentWorkflowPath,
              workflow_dir: workflowDir,
              workspace_root: effectiveConfig.workspace.root,
              workspace_root_source: effectiveConfig.workspace.root_source,
              server: {
                host: apiServer?.address().host ?? resolvedHost,
                port: apiServer?.address().port ?? (resolvedPort ?? null)
              },
              provisioner_type: effectiveConfig.workspace.provisioner.type,
              repo_root: effectiveConfig.workspace.provisioner.repo_root ?? null,
              base_ref: effectiveConfig.workspace.provisioner.base_ref ?? null,
              branch_name_template: effectiveConfig.workspace.provisioner.branch_template ?? null,
              effective_codex_home: effectiveConfig.codex.effective_codex_home ?? null,
              effective_codex_model: effectiveConfig.codex.effective_codex_model ?? null,
              effective_reasoning_effort: effectiveConfig.codex.effective_reasoning_effort ?? null,
              effective_extra_flags_count: effectiveConfig.codex.effective_extra_flags_count ?? 0,
              codex_resolution_mode: effectiveConfig.codex.codex_resolution_mode ?? 'legacy'
            }),
            getWorkspaceProvisioner: () => ({
              provisioner_type: effectiveConfig.workspace.provisioner.type,
              repo_root: effectiveConfig.workspace.provisioner.repo_root ?? null,
              base_ref: effectiveConfig.workspace.provisioner.base_ref ?? null,
              branch_name_template: effectiveConfig.workspace.provisioner.branch_template ?? null,
              last_provision_result: workspaceProvisionState.last_provision_result,
              last_teardown_result: workspaceProvisionState.last_teardown_result,
              last_error_code: workspaceProvisionState.last_error_code,
              last_verification_result: workspaceProvisionState.last_verification_result,
              last_cleanup_on_failure_result: workspaceProvisionState.last_cleanup_on_failure_result,
              verification_mode: workspaceProvisionState.verification_mode,
              last_integrity_status: workspaceProvisionState.last_integrity_status,
              last_integrity_reason_code: workspaceProvisionState.last_integrity_reason_code,
              last_integrity_checked_at: workspaceProvisionState.last_integrity_checked_at,
              last_integrity_reconciled_at: workspaceProvisionState.last_integrity_reconciled_at
            }),
            getWorkspaceCopyIgnored: () => ({
              enabled: effectiveConfig.workspace.copy_ignored.enabled,
              include_file: effectiveConfig.workspace.copy_ignored.include_file,
              from:
                effectiveConfig.workspace.copy_ignored.from === 'repo_root'
                  ? 'repo_root'
                  : 'primary_worktree',
              conflict_policy:
                effectiveConfig.workspace.copy_ignored.conflict_policy === 'overwrite' ||
                effectiveConfig.workspace.copy_ignored.conflict_policy === 'fail'
                  ? effectiveConfig.workspace.copy_ignored.conflict_policy
                  : 'skip',
              require_gitignored: effectiveConfig.workspace.copy_ignored.require_gitignored,
              max_files: effectiveConfig.workspace.copy_ignored.max_files,
              max_total_bytes: effectiveConfig.workspace.copy_ignored.max_total_bytes,
              last_status: workspaceCopyIgnoredState.last_status,
              last_error_code: workspaceCopyIgnoredState.last_error_code,
              last_error_message: workspaceCopyIgnoredState.last_error_message,
              source_path: workspaceCopyIgnoredState.source_path,
              copied_files: workspaceCopyIgnoredState.copied_files,
              skipped_existing: workspaceCopyIgnoredState.skipped_existing,
              blocked_files: workspaceCopyIgnoredState.blocked_files,
              bytes_copied: workspaceCopyIgnoredState.bytes_copied,
              duration_ms: workspaceCopyIgnoredState.duration_ms
            })
          },
          workflowControlSource: {
            switchWorkflowPath: async (workflowPath) => {
              const result = await reloadWorkflow(workflowPath);
              if (!result.applied) {
                logger.log({
                  level: 'warn',
                  event: CANONICAL_EVENT.workflow.reloadFailed,
                  message: result.error ?? 'workflow path switch failed',
                  context: {
                    source: 'api_path_switch',
                    workflow_path: workflowPath
                  }
                });
                return result;
              }

              logger.log({
                level: 'info',
                event: CANONICAL_EVENT.workflow.pathSwitched,
                message: 'workflow path switched',
                context: {
                  workflow_path: result.workflow_path
                }
              });
              apiServer?.notifyStateChanged('workflow_path_switch');
              return result;
            },
            forceReload: async () => {
              const result = await reloadWorkflow(currentWorkflowPath);
              if (!result.applied) {
                logger.log({
                  level: 'warn',
                  event: CANONICAL_EVENT.workflow.reloadFailed,
                  message: result.error ?? 'workflow force reload failed',
                  context: {
                    source: 'api_force_reload',
                    workflow_path: currentWorkflowPath
                  }
                });
                return result;
              }

              logger.log({
                level: 'info',
                event: CANONICAL_EVENT.workflow.reloadForced,
                message: 'workflow force reload applied',
                context: {
                  workflow_path: result.workflow_path
                }
              });
              apiServer?.notifyStateChanged('workflow_force_reload');
              return result;
            }
          },
          issueControlSource: {
            cancelCurrentTurn: async (issueIdentifier, params) =>
              orchestrator.cancelCurrentTurn(issueIdentifier, params),
            requeueIssue: async (issueIdentifier, params) =>
              orchestrator.requeueIssue(issueIdentifier, params),
            retryLastFailedStep: async (issueIdentifier, params) =>
              orchestrator.retryLastFailedStep(issueIdentifier, params),
            clearAutomationFault: async (issueIdentifier, params) =>
              orchestrator.clearAutomationFault(issueIdentifier, {
                actor: params?.actor ?? null,
                reason_note: params?.reason_note ?? null
              }),
            resumeBlockedIssue: async (issueIdentifier, params) =>
              orchestrator.resumeBlockedIssue(issueIdentifier, null, params?.resume_override_reason ?? null, {
                actor: params?.actor ?? null,
                reason_note: params?.reason_note ?? null
              }),
            cancelBlockedIssue: async (issueIdentifier, params) =>
              orchestrator.cancelBlockedIssue(issueIdentifier, params?.cancel_reason ?? null, {
                actor: params?.actor ?? null,
                reason_note: params?.reason_note ?? null,
                confirmed: params?.confirmed ?? null
              }),
            submitBlockedIssueInput: async (params) =>
              orchestrator.submitBlockedIssueInput({
                issue_identifier: params.issueIdentifier,
                request_id: params.request_id,
                actor: params.actor ?? null,
                reason_note: params.reason_note,
                answer: params.answer
              })
          },
          dashboardConfig: {
            dashboard_enabled: effectiveConfig.observability?.dashboard_enabled ?? true,
            refresh_ms: effectiveConfig.observability?.refresh_ms ?? 4000,
            render_interval_ms: effectiveConfig.observability?.render_interval_ms ?? 1000,
            phase_stale_warn_ms: effectiveConfig.observability?.phase_stale_warn_ms ?? 45000,
            asset_revision: runtimeBuildIdentity.identity ?? runtimeBuildIdentity.commit_sha ?? null
          },
          codexStateDbPath: path.join(effectiveConfig.codex.effective_codex_home ?? `${process.env.HOME ?? ''}/.codex`, 'state_5.sqlite'),
          logger,
          controlPlaneHealthRecorder: controlPlaneHealth,
          nowMs
        });

  const start = async (): Promise<void> => {
    if (persistenceStore) {
      const reconciliation = persistenceStore.reconcileExecutionGraphAfterRestart();
      if (reconciliation.recovered > 0 || reconciliation.ambiguous > 0) {
        logger.log({
          level: reconciliation.ambiguous > 0 ? 'error' : 'info',
          event:
            reconciliation.ambiguous > 0
              ? CANONICAL_EVENT.persistence.startupReconciliationAmbiguous
              : CANONICAL_EVENT.persistence.startupReconciled,
          message:
            reconciliation.ambiguous > 0
              ? 'startup history reconciliation found ambiguous active records'
              : 'startup history reconciliation closed provably orphaned records',
          context: reconciliation
        });
      }
      const blockedEntries = persistenceStore
        .listBlockedInputs()
        .map((record) => {
          try {
            return JSON.parse(record.payload);
          } catch {
            return null;
          }
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      const breakerEntries = persistenceStore.listBreakers().map((entry) => ({
        issue_id: entry.issue_id,
        issue_identifier: entry.issue_identifier,
        breaker_active: entry.breaker_active,
        breaker_hit_count: entry.breaker_hit_count,
        breaker_window_minutes: entry.breaker_window_minutes,
        breaker_first_hit_at_ms: entry.breaker_first_hit_at ? Date.parse(entry.breaker_first_hit_at) : null,
        breaker_last_hit_at_ms: entry.breaker_last_hit_at ? Date.parse(entry.breaker_last_hit_at) : null
      }));
      const operatorActions = new Map(
        persistenceStore
          .listOperatorActions()
          .map((record) => {
            try {
              return [record.issue_id, JSON.parse(record.payload)];
            } catch {
              return null;
            }
          })
          .filter((entry): entry is [string, NonNullable<typeof entry>[1]] => entry !== null)
      );
      orchestrator.restoreSuppressionState({
        blocked_entries: blockedEntries,
        breaker_entries: breakerEntries,
        operator_actions: operatorActions
      });
    }

    if (reviewApprovalCoordinator) {
      const reconciliation = await reviewApprovalCoordinator.reconcilePendingActions();
      if (reconciliation.recovered > 0 || reconciliation.superseded > 0) {
        logger.log({
          level: 'info',
          event: CANONICAL_EVENT.reviewApproval.routeCompleted,
          message: 'reconciled durable review approval actions before worker dispatch',
          context: reconciliation
        });
      }
    }

    const startupSnapshot = orchestrator.getStateSnapshot();
    logger.log({
      level: 'info',
      event: CANONICAL_EVENT.runtime.startupStateInitialized,
      message: 'startup initialized orchestrator state from cold process memory',
      context: {
        state_source: 'cold_start',
        running_cleared: startupSnapshot.running.size,
        retry_cleared: startupSnapshot.retry_attempts.size
      }
    });

    if (apiServer) {
      await assertResolvableServerHost(resolvedHost);
      await apiServer.listen();
      const address = apiServer.address();
      logger.log({
        level: 'info',
        event: CANONICAL_EVENT.runtime.httpEnabled,
        message: 'local HTTP extension enabled',
        context: {
          host: address.host,
          port: address.port,
          configured_port: resolvedPort,
          configured_host: resolvedHost
        }
      });
      await runtimeUpdateManager.recordSupervisedRestartReady();
      process.send?.({
        type: 'symphony_supervised_restart_ready',
        version: 1,
        child_pid: process.pid,
        ready_at: new Date().toISOString()
      });
    } else {
      logger.log({
        level: 'info',
        event: CANONICAL_EVENT.runtime.httpDisabled,
        message: 'local HTTP extension disabled (no CLI or workflow port configured)',
        context: {
          configured_port: null
        }
      });
    }

    if (persistenceStore) {
      try {
        const pruned = persistenceStore.pruneExpiredRuns();
        logger.log({
          level: 'info',
          event: CANONICAL_EVENT.persistence.pruned,
          message: `pruned ${pruned} expired run records`,
          context: {
            pruned,
            retention_days: effectiveConfig.persistence.retention_days
          }
        });
      } catch (error) {
        const health = persistenceStore.health({ depth: 'deep', integrity_check_source: 'prune_failure' });
        logger.log({
          level: 'warn',
          event: CANONICAL_EVENT.persistence.pruneFailed,
          message: error instanceof Error ? error.message : 'retention pruning failed',
          context: {
            retention_days: effectiveConfig.persistence.retention_days,
            last_prune_failure_at: health.last_prune_failure_at,
            last_prune_failure_reason: health.last_prune_failure_reason,
            last_prune_failure_detail: health.last_prune_failure_detail
          }
        });
      }
    }

    try {
      const terminalIssues = await tracker.fetch_issues_by_states(effectiveConfig.tracker.terminal_states);
      const cleanupResults = await workspaceManager.cleanupWorkspaces(terminalIssues.map((issue) => issue.identifier));
      const cleanedCount = cleanupResults.filter((result) => result.cleaned).length;
      logger.log({
        level: 'info',
        event: CANONICAL_EVENT.runtime.startupCleanupCompleted,
        message: 'completed startup terminal workspace cleanup sweep',
        context: {
          terminal_issue_count: terminalIssues.length,
          cleaned_count: cleanedCount,
          failed_count: cleanupResults.length - cleanedCount
        }
      });
    } catch (error) {
      logger.log({
        level: 'warn',
        event: CANONICAL_EVENT.runtime.startupCleanupFailed,
        message: error instanceof Error ? error.message : 'terminal cleanup failed'
      });
    }

    await orchestrator.tick('startup');
    pollIntervalHandle = setInterval(() => {
      void orchestrator.tick('interval');
    }, Math.max(1000, effectiveConfig.polling.interval_ms));
    runtimeStarted = true;

    logger.log({
      level: 'info',
      event: CANONICAL_EVENT.runtime.started,
      message: 'runtime environment started',
      context: {
        poll_interval_ms: effectiveConfig.polling.interval_ms,
        http_server_enabled: apiServer !== null,
        workflow_path: currentWorkflowPath,
        workspace_root: effectiveConfig.workspace.root,
        workspace_root_source: effectiveConfig.workspace.root_source
      }
    });
  };

  const stop = async (): Promise<void> => {
    if (pollIntervalHandle) {
      clearInterval(pollIntervalHandle);
      pollIntervalHandle = null;
    }
    runtimeStarted = false;

    for (const timer of retryTimers.values()) {
      clearTimeout(timer.timeout);
    }
    retryTimers.clear();

    if (apiServer) {
      await apiServer.close();
    }

    persistenceStore?.close();

    logger.log({
      level: 'info',
      event: CANONICAL_EVENT.runtime.stopped,
      message: 'runtime environment stopped'
    });
  };
  stopRuntime = stop;

  return {
    apiServer,
    orchestrator,
    effectiveConfig,
    start,
    stop
  };
}
