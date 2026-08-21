import type { CodexRunner } from '../codex';
import { CodexAgentRunner, type AgentRunner, type AgentRunnerEvent } from '../agent';
import type { CodexCancellationOutcome } from '../codex/types';
import type { StructuredLogger } from '../observability';
import { CANONICAL_EVENT } from '../observability/events';
import { REASON_CODES } from '../observability/reason-codes';
import type { Issue } from '../tracker';
import { TemplateEngine, type Template } from '../workflow';
import type { EffectiveConfig } from '../workflow';
import type { WorkspaceManager } from '../workspace';
import type { WorkspaceInfo } from '../workspace';
import type { SpawnWorkerResult, WorkerExitDetails, WorkerTerminationResult } from './types';
import { runLocalWorkerAttempt, runLocalWorkerRecoveryAttempt } from './local-worker-runner';
import type { AgentReviewOutcome, ReviewApprovalResult } from '../review';

interface WorkerHandle {
  issue_id: string;
  issue_identifier: string;
  worker_instance_id: string;
  worker_host: string | null;
  promise: Promise<void>;
  cancel: (reason: string) => Promise<WorkerCancellationAttemptResult>;
  cleanup_workspace_promise?: Promise<boolean>;
}

interface WorkerCancellationAttemptResult {
  cancellation_requested: boolean;
  worker_settled: boolean | null;
  graceful_exit_observed: boolean | null;
  forced_kill_requested: boolean;
  forced_kill_settled: boolean | null;
  reason_code: string;
  detail: string | null;
}

export interface LocalRunnerBridgeOptions {
  workspaceManager: WorkspaceManager;
  codexRunner: CodexRunner;
  agentRunner?: AgentRunner;
  config: EffectiveConfig;
  promptTemplate: string;
  renderPrompt?: (params: { issue: Issue; attempt: number | null }) => Promise<string>;
  issueStateFetcher?: (issue_ids: string[]) => Promise<Issue[]>;
  reviewOutcomeHandler?: (params: {
    issue: Issue;
    outcome: AgentReviewOutcome;
    workspace: WorkspaceInfo;
    symphonyAttemptId: string;
    sessionId: string | null;
  }) => Promise<ReviewApprovalResult>;
  logger?: StructuredLogger;
  onWorkerExit?: (
    params: { issue_id: string; reason: 'normal' | 'abnormal'; error?: string; worker_handle?: unknown } & WorkerExitDetails
  ) => Promise<void> | void;
  onWorkerEvent?: (params: { issue_id: string; event: AgentRunnerEvent }) => void;
}

export class LocalRunnerBridge {
  private readonly workspaceManager: WorkspaceManager;
  private readonly codexRunner: CodexRunner;
  private readonly agentRunner: AgentRunner;
  private config: EffectiveConfig;
  private renderPrompt: (params: { issue: Issue; attempt: number | null }) => Promise<string>;
  private readonly logger?: StructuredLogger;
  private readonly issueStateFetcher: (issue_ids: string[]) => Promise<Issue[]>;
  private readonly reviewOutcomeHandler?: LocalRunnerBridgeOptions['reviewOutcomeHandler'];
  private readonly onWorkerExit?: LocalRunnerBridgeOptions['onWorkerExit'];
  private readonly onWorkerEvent?: LocalRunnerBridgeOptions['onWorkerEvent'];
  private nextWorkerSequence = 0;

  constructor(options: LocalRunnerBridgeOptions) {
    this.workspaceManager = options.workspaceManager;
    this.codexRunner = options.codexRunner;
    this.agentRunner = options.agentRunner ?? new CodexAgentRunner(options.codexRunner);
    this.config = options.config;
    if (options.renderPrompt) {
      this.renderPrompt = options.renderPrompt;
    } else {
      const compiledTemplate: Template = new TemplateEngine().compile(options.promptTemplate);
      this.renderPrompt = async ({ issue, attempt }) => {
        return compiledTemplate.render({ issue: issue as unknown as Record<string, unknown>, attempt });
      };
    }
    this.logger = options.logger;
    this.issueStateFetcher = options.issueStateFetcher ?? (async () => []);
    this.reviewOutcomeHandler = options.reviewOutcomeHandler;
    this.onWorkerExit = options.onWorkerExit;
    this.onWorkerEvent = options.onWorkerEvent;
  }

  setRuntimeConfig(config: EffectiveConfig, promptTemplate: string): void {
    this.config = config;
    const compiledTemplate: Template = new TemplateEngine().compile(promptTemplate);
    this.renderPrompt = async ({ issue, attempt }) => {
      return compiledTemplate.render({ issue: issue as unknown as Record<string, unknown>, attempt });
    };
  }

  async spawnWorker(params: {
    issue: Issue;
    attempt: number | null;
    worker_host?: string | null;
    resume_context?: string | null;
    recover_workspace_attempt_residue?: boolean;
  }): Promise<SpawnWorkerResult> {
    const workerHost = params.worker_host ?? null;
    if (workerHost && !this.agentRunner.capabilities.remote_worker) {
      return { ok: false, error: 'claude_remote_worker_unsupported' };
    }
    let workspace;
    try {
      workspace = await this.workspaceManager.ensureWorkspace(params.issue.identifier);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'workspace provisioning failed'
      };
    }
    const cancellationController = new AbortController();
    const workerInstanceId = this.createWorkerInstanceId(params.issue.id);
    let runnerSettled = false;
    let cancellationOutcome: CodexCancellationOutcome | null = null;
    const workerPromise = this.startWorker(
      params.issue,
      params.attempt,
      workspace,
      workerHost,
      params.resume_context ?? null,
      params.recover_workspace_attempt_residue ?? false,
      workerInstanceId,
      cancellationController.signal,
      (outcome) => {
        cancellationOutcome = outcome;
        runnerSettled = true;
      }
    );
    const worker_handle: WorkerHandle = {
      issue_id: params.issue.id,
      issue_identifier: params.issue.identifier,
      worker_instance_id: workerInstanceId,
      promise: workerPromise,
      worker_host: workerHost,
      cancel: createWorkerCancel({
        issue_id: params.issue.id,
        issue_identifier: params.issue.identifier,
        worker_host: workerHost,
        controller: cancellationController,
        workerPromise,
        isRunnerSettled: () => runnerSettled,
        getCancellationOutcome: () => cancellationOutcome
      })
    };

    return {
      ok: true,
      worker_handle,
      worker_instance_id: workerInstanceId,
      monitor_handle: worker_handle,
      worker_host: workerHost,
      workspace_path: workspace.path,
      provisioner_type: workspace.provisioner_type ?? null,
      branch_name: workspace.branch_name ?? null,
      repo_root: workspace.repo_root ?? null,
      workspace_exists: workspace.workspace_exists ?? true,
      workspace_git_status: workspace.workspace_git_status ?? 'unknown',
      workspace_provisioned: workspace.workspace_provisioned ?? false,
      workspace_is_git_worktree: workspace.workspace_is_git_worktree ?? false,
      copy_ignored_applied: workspace.copy_ignored_applied ?? false,
      copy_ignored_status: workspace.copy_ignored_status ?? null,
      copy_ignored_summary: workspace.copy_ignored_summary ?? null
    };
  }

  async recoverMissingToolOutput(params: {
    issue: Issue;
    attempt: number | null;
    worker_host?: string | null;
    previous_thread_id: string;
    previous_turn_id: string;
    previous_session_id: string | null;
    recovery_prompt: string;
  }): Promise<SpawnWorkerResult> {
    if (!this.agentRunner.capabilities.missing_tool_output_recovery) {
      return { ok: false, error: 'claude_missing_tool_output_recovery_unsupported' };
    }
    const workerHost = params.worker_host ?? null;
    let workspace;
    try {
      workspace = await this.workspaceManager.ensureWorkspace(params.issue.identifier);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'workspace provisioning failed'
      };
    }
    const cancellationController = new AbortController();
    const workerInstanceId = this.createWorkerInstanceId(params.issue.id);
    let runnerSettled = false;
    let cancellationOutcome: CodexCancellationOutcome | null = null;
    const workerPromise = this.startRecoveryWorker(params, workspace, workerHost, workerInstanceId, cancellationController.signal, (outcome) => {
      cancellationOutcome = outcome;
      runnerSettled = true;
    });
    const worker_handle: WorkerHandle = {
      issue_id: params.issue.id,
      issue_identifier: params.issue.identifier,
      worker_instance_id: workerInstanceId,
      promise: workerPromise,
      worker_host: workerHost,
      cancel: createWorkerCancel({
        issue_id: params.issue.id,
        issue_identifier: params.issue.identifier,
        worker_host: workerHost,
        controller: cancellationController,
        workerPromise,
        isRunnerSettled: () => runnerSettled,
        getCancellationOutcome: () => cancellationOutcome
      })
    };

    return {
      ok: true,
      worker_handle,
      worker_instance_id: workerInstanceId,
      monitor_handle: worker_handle,
      worker_host: workerHost,
      workspace_path: workspace.path,
      provisioner_type: workspace.provisioner_type ?? null,
      branch_name: workspace.branch_name ?? null,
      repo_root: workspace.repo_root ?? null,
      workspace_exists: workspace.workspace_exists ?? true,
      workspace_git_status: workspace.workspace_git_status ?? 'unknown',
      workspace_provisioned: workspace.workspace_provisioned ?? false,
      workspace_is_git_worktree: workspace.workspace_is_git_worktree ?? false,
      copy_ignored_applied: workspace.copy_ignored_applied ?? false,
      copy_ignored_status: workspace.copy_ignored_status ?? null,
      copy_ignored_summary: workspace.copy_ignored_summary ?? null
    };
  }

  async terminateWorker(params: {
    issue_id: string;
    worker_handle: unknown;
    cleanup_workspace: boolean;
    reason?: string;
  }): Promise<WorkerTerminationResult> {
    const reason = params.reason ?? 'worker_terminated';
    const workerHandle = params.worker_handle as WorkerHandle | null;
    if (!workerHandle?.issue_identifier) {
      return {
        cancellation_supported: false,
        cancellation_requested: false,
        worker_settled: null,
        graceful_exit_observed: null,
        forced_kill_requested: false,
        forced_kill_settled: null,
        cleanup_requested: params.cleanup_workspace,
        cleanup_succeeded: null,
        result: 'unsupported',
        reason_code: REASON_CODES.workerHandleMissing,
        detail: 'worker handle missing issue identifier'
      };
    }

    let cancellation: WorkerCancellationAttemptResult;
    if (typeof workerHandle.cancel === 'function') {
      try {
        cancellation = await workerHandle.cancel(reason);
      } catch (error) {
        cancellation = {
          cancellation_requested: true,
          worker_settled: null,
          graceful_exit_observed: null,
          forced_kill_requested: false,
          forced_kill_settled: null,
          reason_code: REASON_CODES.workerCancelFailed,
          detail: error instanceof Error ? error.message : 'worker cancellation failed'
        };
      }
      this.logger?.log({
        level: cancellation.worker_settled === true ? 'info' : 'warn',
        event: CANONICAL_EVENT.orchestration.workerTerminated,
        message: 'worker process cancellation requested',
        context: {
          issue_id: params.issue_id,
          issue_identifier: workerHandle.issue_identifier,
          worker_instance_id: workerHandle.worker_instance_id,
          cleanup_workspace: params.cleanup_workspace,
          reason,
          worker_host: workerHandle.worker_host,
          cancellation_contract: 'supported',
          cancel_requested: cancellation.cancellation_requested,
          worker_settled: cancellation.worker_settled,
          graceful_exit_observed: cancellation.graceful_exit_observed,
          forced_kill_requested: cancellation.forced_kill_requested,
          forced_kill_settled: cancellation.forced_kill_settled,
          cancellation_reason_code: cancellation.reason_code,
          cancellation_detail: cancellation.detail
        }
      });
    } else {
      cancellation = {
        cancellation_requested: false,
        worker_settled: null,
        graceful_exit_observed: null,
        forced_kill_requested: false,
        forced_kill_settled: null,
        reason_code: REASON_CODES.workerCancelUnsupported,
        detail: 'worker handle does not implement cancel(reason)'
      };
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.orchestration.workerTerminated,
        message: 'worker process cancellation unsupported',
        context: {
          issue_id: params.issue_id,
          issue_identifier: workerHandle.issue_identifier,
          worker_instance_id: workerHandle.worker_instance_id,
          cleanup_workspace: params.cleanup_workspace,
          reason,
          worker_host: workerHandle.worker_host,
          cancellation_contract: 'unsupported',
          cancel_requested: false,
          worker_settled: null,
          graceful_exit_observed: null,
          forced_kill_requested: false,
          forced_kill_settled: null
        }
      });
    }

    let cleanupSucceeded: boolean | null = null;
    if (params.cleanup_workspace) {
      this.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.workspace.teardownStart,
        message: 'worker workspace cleanup attempted',
        context: {
          issue_id: params.issue_id,
          issue_identifier: workerHandle.issue_identifier,
          worker_instance_id: workerHandle.worker_instance_id,
          reason
        }
      });
      try {
        workerHandle.cleanup_workspace_promise ??= this.workspaceManager.cleanupWorkspace(workerHandle.issue_identifier);
        cleanupSucceeded = await workerHandle.cleanup_workspace_promise;
      } catch {
        cleanupSucceeded = false;
      }
      this.logger?.log({
        level: cleanupSucceeded ? 'info' : 'warn',
        event: cleanupSucceeded ? CANONICAL_EVENT.workspace.teardownSuccess : CANONICAL_EVENT.workspace.teardownFailed,
        message: cleanupSucceeded ? 'worker workspace cleanup succeeded' : 'worker workspace cleanup failed',
        context: {
          issue_id: params.issue_id,
          issue_identifier: workerHandle.issue_identifier,
          worker_instance_id: workerHandle.worker_instance_id,
          reason,
          cleanup_succeeded: cleanupSucceeded
        }
      });
    }

    const result = workerTerminationResult({
      cancellation_supported: typeof workerHandle.cancel === 'function',
      cancellation,
      cleanup_requested: params.cleanup_workspace,
      cleanup_succeeded: cleanupSucceeded
    });
    this.logger?.log({
      level: result.result === 'succeeded' ? 'info' : 'warn',
      event: CANONICAL_EVENT.orchestration.workerTerminated,
      message: 'worker termination outcome recorded',
      context: {
        issue_id: params.issue_id,
        issue_identifier: workerHandle.issue_identifier,
        worker_instance_id: workerHandle.worker_instance_id,
        worker_host: workerHandle.worker_host,
        reason,
        ...result
      }
    });
    return result;
  }

  private async startWorker(
    issue: Issue,
    attempt: number | null,
    workspace: WorkspaceInfo,
    worker_host: string | null,
    resume_context: string | null,
    recoverWorkspaceAttemptResidue: boolean,
    workerInstanceId: string,
    cancellationSignal: AbortSignal,
    onRunnerSettled: (cancellationOutcome: CodexCancellationOutcome | null) => void
  ): Promise<void> {
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.agentRunner.attemptStarted,
      message: 'agent runner attempt started',
      context: {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        worker_host,
        attempt: attempt ?? 0
      }
    });
    let workerProcessPid: number | null = null;
    const result = await runLocalWorkerAttempt({
      issue,
      attempt,
      symphonyAttemptId: workerInstanceId,
      worker_host: worker_host ?? undefined,
      workspaceManager: this.workspaceManager,
      workspace,
      codexRunner: this.codexRunner,
      agentRunner: this.agentRunner,
      config: this.config,
      renderPrompt: this.renderPrompt,
      resumeContext: resume_context,
      recoverWorkspaceAttemptResidue,
      issueStateFetcher: this.issueStateFetcher,
      reviewOutcomeHandler: this.reviewOutcomeHandler,
      cancellationSignal,
      onAgentEvent: (event) => {
        if (event.worker_process_pid !== undefined && event.worker_process_pid !== null) {
          workerProcessPid = event.worker_process_pid;
        }
        this.onWorkerEvent?.({ issue_id: issue.id, event: { ...event, worker_instance_id: workerInstanceId } });
      }
    });
    onRunnerSettled(result.cancellation_outcome ?? null);
    if (result.reason === 'normal') {
      this.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.agentRunner.attemptCompleted,
        message: 'agent runner attempt completed',
        context: {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          session_id: result.session_id,
          completion_reason: result.completion_reason ?? REASON_CODES.normalCompletion,
          refreshed_state: result.refreshed_state ?? null
        }
      });
    } else {
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.agentRunner.attemptFailed,
        message: 'agent runner attempt failed',
        context: {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          session_id: result.session_id,
          error: result.error ?? 'unknown'
        }
      });
    }

    await this.onWorkerExit?.({
      issue_id: issue.id,
      reason: result.reason,
      error: result.error,
      worker_instance_id: workerInstanceId,
      completion_reason: result.completion_reason,
      refreshed_state: result.refreshed_state,
      session_id: result.session_id,
      worker_process_pid: workerProcessPid,
      retryable: result.retryable
    });
  }

  private async startRecoveryWorker(
    params: {
      issue: Issue;
      attempt: number | null;
      previous_thread_id: string;
      previous_turn_id: string;
      previous_session_id: string | null;
      recovery_prompt: string;
    },
    workspace: WorkspaceInfo,
    worker_host: string | null,
    workerInstanceId: string,
    cancellationSignal: AbortSignal,
    onRunnerSettled: (cancellationOutcome: CodexCancellationOutcome | null) => void
  ): Promise<void> {
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.agentRunner.attemptStarted,
      message: 'agent runner guarded recovery attempt started',
      context: {
        issue_id: params.issue.id,
        issue_identifier: params.issue.identifier,
        worker_host,
        attempt: params.attempt ?? 0,
        previous_thread_id: params.previous_thread_id,
        previous_turn_id: params.previous_turn_id
      }
    });
    let workerProcessPid: number | null = null;
    const result = await runLocalWorkerRecoveryAttempt({
      issue: params.issue,
      attempt: params.attempt,
      symphonyAttemptId: workerInstanceId,
      worker_host: worker_host ?? undefined,
      workspaceManager: this.workspaceManager,
      workspace,
      codexRunner: this.codexRunner,
      config: this.config,
      renderPrompt: this.renderPrompt,
      resumeContext: null,
      issueStateFetcher: this.issueStateFetcher,
      previousThreadId: params.previous_thread_id,
      previousTurnId: params.previous_turn_id,
      previousSessionId: params.previous_session_id,
      recoveryPrompt: params.recovery_prompt,
      cancellationSignal,
      onCodexEvent: (event) => {
        if (event.codex_app_server_pid !== null) {
          workerProcessPid = event.codex_app_server_pid;
        }
        this.onWorkerEvent?.({
          issue_id: params.issue.id,
          event: {
            ...event,
            agent_runtime: 'codex-app-server',
            worker_process_pid: event.codex_app_server_pid,
            worker_instance_id: workerInstanceId
          }
        });
      }
    });
    onRunnerSettled(result.cancellation_outcome ?? null);
    await this.onWorkerExit?.({
      issue_id: params.issue.id,
      reason: result.reason,
      error: result.error,
      worker_instance_id: workerInstanceId,
      completion_reason: result.completion_reason,
      refreshed_state: result.refreshed_state,
      session_id: result.session_id,
      worker_process_pid: workerProcessPid
    });
  }

  private createWorkerInstanceId(issueId: string): string {
    this.nextWorkerSequence += 1;
    return `${issueId}:${Date.now().toString(36)}:${this.nextWorkerSequence}`;
  }
}

function createWorkerCancel(params: {
  issue_id: string;
  issue_identifier: string;
  worker_host: string | null;
  controller: AbortController;
  workerPromise: Promise<void>;
  isRunnerSettled: () => boolean;
  getCancellationOutcome: () => CodexCancellationOutcome | null;
}): (reason: string) => Promise<WorkerCancellationAttemptResult> {
  let cancellationPromise: Promise<void> | null = null;
  return async (reason: string): Promise<WorkerCancellationAttemptResult> => {
    if (!params.controller.signal.aborted) {
      params.controller.abort(reason);
    }

    cancellationPromise ??= params.workerPromise.catch(() => undefined);
    if (!params.isRunnerSettled()) {
      await cancellationPromise;
    }
    return cancellationAttemptResult(params.getCancellationOutcome(), params.isRunnerSettled());
  };
}

function cancellationAttemptResult(
  outcome: CodexCancellationOutcome | null,
  runnerSettled: boolean
): WorkerCancellationAttemptResult {
  if (outcome === 'graceful_exit') {
    return {
      cancellation_requested: true,
      worker_settled: true,
      graceful_exit_observed: true,
      forced_kill_requested: false,
      forced_kill_settled: null,
      reason_code: REASON_CODES.workerCancelGracefulExit,
      detail: 'worker process exited after graceful cancellation'
    };
  }
  if (outcome === 'forced_kill_exited') {
    return {
      cancellation_requested: true,
      worker_settled: true,
      graceful_exit_observed: false,
      forced_kill_requested: true,
      forced_kill_settled: true,
      reason_code: REASON_CODES.workerCancelForcedKillExited,
      detail: 'worker process exited after forced kill'
    };
  }
  if (outcome === 'forced_kill_requested') {
    return {
      cancellation_requested: true,
      worker_settled: false,
      graceful_exit_observed: false,
      forced_kill_requested: true,
      forced_kill_settled: false,
      reason_code: REASON_CODES.workerCancelForcedKillUnconfirmed,
      detail: 'forced kill was requested but process exit was not confirmed'
    };
  }
  if (outcome === 'requested') {
    return {
      cancellation_requested: true,
      worker_settled: null,
      graceful_exit_observed: null,
      forced_kill_requested: false,
      forced_kill_settled: null,
      reason_code: REASON_CODES.workerCancelRequested,
      detail: 'worker cancellation was requested but settlement was not confirmed'
    };
  }
  return {
    cancellation_requested: true,
    worker_settled: runnerSettled ? true : null,
    graceful_exit_observed: null,
    forced_kill_requested: false,
    forced_kill_settled: null,
    reason_code: runnerSettled ? REASON_CODES.workerCancelSettledWithoutOutcome : REASON_CODES.workerCancelUnknown,
    detail: runnerSettled
      ? 'worker settled after cancellation but runner did not report graceful or forced outcome'
      : 'worker cancellation outcome is unknown'
  };
}

function workerTerminationResult(params: {
  cancellation_supported: boolean;
  cancellation: WorkerCancellationAttemptResult;
  cleanup_requested: boolean;
  cleanup_succeeded: boolean | null;
}): WorkerTerminationResult {
  let result: WorkerTerminationResult['result'];
  if (!params.cancellation_supported) {
    result = 'unsupported';
  } else if (params.cleanup_requested && params.cleanup_succeeded !== true) {
    result = 'failed';
  } else if (params.cancellation.worker_settled === true) {
    result = 'succeeded';
  } else if (params.cancellation.worker_settled === false) {
    result = 'unknown';
  } else {
    result = params.cancellation.reason_code === REASON_CODES.workerCancelFailed ? 'failed' : 'unknown';
  }

  return {
    cancellation_supported: params.cancellation_supported,
    cancellation_requested: params.cancellation.cancellation_requested,
    worker_settled: params.cancellation.worker_settled,
    graceful_exit_observed: params.cancellation.graceful_exit_observed,
    forced_kill_requested: params.cancellation.forced_kill_requested,
    forced_kill_settled: params.cancellation.forced_kill_settled,
    cleanup_requested: params.cleanup_requested,
    cleanup_succeeded: params.cleanup_requested ? params.cleanup_succeeded : null,
    result,
    reason_code:
      params.cleanup_requested && params.cleanup_succeeded !== true
        ? REASON_CODES.workspaceCleanupFailed
        : params.cancellation.reason_code,
    detail:
      params.cleanup_requested && params.cleanup_succeeded !== true
        ? 'workspace cleanup did not succeed'
        : params.cancellation.detail
  };
}
