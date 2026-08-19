import type { Issue } from '../tracker';
import type { WorkspaceManager } from '../workspace';
import type { WorkspaceInfo } from '../workspace';
import type { CodexRunner } from '../codex';
import type { CodexRunnerEvent } from '../codex';
import { CodexAgentRunner, type AgentRunResult, type AgentRunner, type AgentRunnerEvent } from '../agent';
import type { CodexCancellationOutcome, CodexInputRequestPayload } from '../codex/types';
import { CodexRunnerError } from '../codex/errors';
import type { EffectiveConfig } from '../workflow';
import { CANONICAL_EVENT } from '../observability/events';
import { REASON_CODES } from '../observability/reason-codes';
import { buildCodexSpawnCommand } from '../codex/command-builder';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { WorkerCompletionReason } from './types';

const DEFAULT_CONTINUATION_PROMPT =
  'Continue on the same thread for this issue. Focus on incremental progress and report outcomes clearly.';

export interface LocalWorkerRunInput {
  issue: Issue;
  attempt: number | null;
  worker_host?: string;
  workspaceManager: WorkspaceManager;
  workspace: WorkspaceInfo;
  codexRunner?: CodexRunner;
  agentRunner?: AgentRunner;
  config: EffectiveConfig;
  renderPrompt: (params: { issue: Issue; attempt: number | null }) => Promise<string>;
  resumeContext?: string | null;
  recoverWorkspaceAttemptResidue?: boolean;
  issueStateFetcher: (issue_ids: string[]) => Promise<Issue[]>;
  onCodexEvent?: (event: CodexRunnerEvent) => void;
  onAgentEvent?: (event: AgentRunnerEvent) => void;
  cancellationSignal?: AbortSignal;
}

export interface LocalWorkerRunResult {
  reason: 'normal' | 'abnormal';
  session_id: string | null;
  completion_reason?: WorkerCompletionReason;
  refreshed_state?: string | null;
  error?: string;
  cancellation_outcome?: CodexCancellationOutcome;
  input_required_payload?: CodexInputRequestPayload;
  retryable?: boolean;
}

export async function runLocalWorkerAttempt(input: LocalWorkerRunInput): Promise<LocalWorkerRunResult> {
  let workspacePath: string | null = null;
  const emitCompatibilityEvent = (event: CodexRunnerEvent): void => {
    input.onCodexEvent?.(event);
    if (input.onAgentEvent && input.onAgentEvent !== input.onCodexEvent) {
      input.onAgentEvent({
        ...event,
        agent_runtime: input.agentRunner?.runtime ?? 'codex-app-server',
        worker_process_pid: event.codex_app_server_pid
      });
    }
  };

  try {
    const workspace = input.workspace;
    workspacePath = workspace.path;
    const normalizedWorkspace = path.resolve(workspace.path);
    const normalizedRoot = path.resolve(input.config.workspace.root);
    if (normalizedWorkspace === normalizedRoot) {
      emitCompatibilityEvent({
        event: CANONICAL_EVENT.codex.startupFailed,
        timestamp: new Date().toISOString(),
        codex_app_server_pid: null,
        detail: REASON_CODES.unsafeWorkspaceRoot
      });
      return {
        reason: 'abnormal',
        session_id: null,
        error: REASON_CODES.unsafeWorkspaceRoot
      };
    }
    if (input.recoverWorkspaceAttemptResidue === true) {
      await input.workspaceManager.prepareAttempt(workspace.path, { allow_attempt_residue: true });
    } else {
      await input.workspaceManager.prepareAttempt(workspace.path);
    }
    let currentIssue = input.issue;
    let lastSessionId: string | null = null;
    const maxTurns = Math.max(1, input.config.agent.max_turns);
    const codexSpawnCommand = buildCodexSpawnCommand(input.config.codex);
    const agentRunner: AgentRunner | null =
      input.agentRunner ?? (input.codexRunner ? new CodexAgentRunner(input.codexRunner) : null);
    if (!agentRunner) {
      throw new Error('agent_runner_missing');
    }
    const onAgentEvent = input.onAgentEvent ?? (input.onCodexEvent as ((event: AgentRunnerEvent) => void) | undefined);

    if (input.config.codex.codex_resolution_mode === 'legacy') {
      emitCompatibilityEvent({
        event: CANONICAL_EVENT.codex.commandLegacyPathUsed,
        timestamp: new Date().toISOString(),
        codex_app_server_pid: null,
        detail: 'codex_command_legacy_path_used'
      });
    } else if (input.config.codex.codex_resolution_mode === 'mixed') {
      emitCompatibilityEvent({
        event: CANONICAL_EVENT.codex.commandMixedTypedOverridesApplied,
        timestamp: new Date().toISOString(),
        codex_app_server_pid: null,
        detail: 'codex_command_mixed_typed_overrides_applied'
      });
    }

    for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber += 1) {
      const basePrompt =
        turnNumber === 1
          ? await input.renderPrompt({
              issue: currentIssue,
              attempt: input.attempt
            })
          : DEFAULT_CONTINUATION_PROMPT;
      const prompt = turnNumber === 1 && input.resumeContext ? `${input.resumeContext}\n\n${basePrompt}` : basePrompt;

      const runInput = {
        command:
          agentRunner.runtime === 'claude-cli'
            ? (input.config.agent_runtime?.claude_command ?? 'claude')
            : codexSpawnCommand.command,
        commandArgs: agentRunner.runtime === 'claude-cli' ? [] : codexSpawnCommand.args,
        commandEnv: agentRunner.runtime === 'claude-cli' ? undefined : codexSpawnCommand.env,
        workspaceCwd: workspace.path,
        workerHost: input.worker_host,
        prompt,
        continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
        title: `${currentIssue.identifier}: ${currentIssue.title}`,
        maxTurns: 1,
        approvalPolicy: input.config.codex.approval_policy,
        threadSandbox: input.config.codex.thread_sandbox,
        turnSandboxPolicy: input.config.codex.turn_sandbox_policy
          ? { type: input.config.codex.turn_sandbox_policy }
          : undefined,
        onEvent: onAgentEvent,
        cancellationSignal: input.cancellationSignal,
        readTimeoutMs: input.config.codex.read_timeout_ms,
        turnTimeoutMs: input.config.codex.turn_timeout_ms,
        runBinding: {
          project_identity: input.config.workspace.provisioner.repo_root ?? input.config.workspace.root,
          issue_id: currentIssue.id,
          issue_identifier: currentIssue.identifier,
          attempt: input.attempt
        }
      };
      const turnResult: AgentRunResult | undefined =
        turnNumber > 1 && lastSessionId && agentRunner.capabilities.native_resume === 'within-attempt'
          ? await agentRunner.resumeSessionAndRunTurn?.({ ...runInput, previousSessionId: lastSessionId })
          : await agentRunner.startSessionAndRunTurn(runInput);

      if (!turnResult) {
        return {
          reason: 'abnormal',
          session_id: lastSessionId,
          error: 'agent_native_resume_unavailable'
        };
      }

      if (turnResult.status !== 'completed') {
        if (turnResult.status === 'cancelled') {
          try {
            const refreshedIssues = await input.issueStateFetcher([currentIssue.id]);
            const refreshedIssue = refreshedIssues.find((issue) => issue.id === currentIssue.id) ?? refreshedIssues[0];
            if (refreshedIssue && isStateListed(refreshedIssue.state, input.config.tracker.terminal_states)) {
              return {
                reason: 'normal',
                session_id: turnResult.session_id,
                completion_reason: REASON_CODES.terminalStateReached,
                refreshed_state: refreshedIssue.state,
                cancellation_outcome: turnResult.cancellation_outcome
              };
            }
            if (
              refreshedIssue &&
              isStateListed(refreshedIssue.state, input.config.tracker.handoff_states) &&
              (!isStateListed(currentIssue.state, input.config.tracker.fresh_dispatch_states) ||
                !isSameState(currentIssue.state, refreshedIssue.state))
            ) {
              return {
                reason: 'normal',
                session_id: turnResult.session_id,
                completion_reason: REASON_CODES.handoffStateReached,
                refreshed_state: refreshedIssue.state,
                cancellation_outcome: turnResult.cancellation_outcome
              };
            }
          } catch {
            // Preserve the cancellation failure when tracker state cannot confirm a successful handoff.
          }
        }
        const error =
          turnResult.error_code === REASON_CODES.turnInputRequired
            ? `${turnResult.error_code}: ${
                turnResult.input_required_payload
                  ? JSON.stringify({
                      detail: turnResult.error_detail ?? 'input_required_unanswerable',
                      ...turnResult.input_required_payload
                    })
                  : (turnResult.error_detail ?? 'input_required_unanswerable')
              }`
            : (turnResult.error_code ?? turnResult.last_event);
        return {
          reason: 'abnormal',
          session_id: turnResult.session_id,
          error,
          cancellation_outcome: turnResult.cancellation_outcome,
          input_required_payload: turnResult.input_required_payload,
          retryable: turnResult.retryable
        };
      }
      lastSessionId = turnResult.session_id;

      let refreshedIssues: Issue[];
      try {
        refreshedIssues = await input.issueStateFetcher([currentIssue.id]);
      } catch (error) {
        return {
          reason: 'normal',
          session_id: lastSessionId,
          completion_reason: REASON_CODES.issueStateRefreshFailed,
          error: `issue_state_refresh_failed: ${error instanceof Error ? error.message : 'unknown'}`
        };
      }

      if (refreshedIssues.length === 0) {
        return {
          reason: 'normal',
          session_id: lastSessionId,
          completion_reason: REASON_CODES.issueStateMissing
        };
      }

      const refreshedIssue = refreshedIssues.find((issue) => issue.id === currentIssue.id) ?? refreshedIssues[0];
      if (refreshedIssue && isStateListed(refreshedIssue.state, input.config.tracker.terminal_states)) {
        return {
          reason: 'normal',
          session_id: lastSessionId,
          completion_reason: REASON_CODES.terminalStateReached,
          refreshed_state: refreshedIssue.state
        };
      }

      if (
        refreshedIssue &&
        isStateListed(refreshedIssue.state, input.config.tracker.handoff_states) &&
        (!isStateListed(currentIssue.state, input.config.tracker.fresh_dispatch_states) ||
          !isSameState(currentIssue.state, refreshedIssue.state))
      ) {
        return {
          reason: 'normal',
          session_id: lastSessionId,
          completion_reason: REASON_CODES.handoffStateReached,
          refreshed_state: refreshedIssue.state
        };
      }

      if (
        refreshedIssue &&
        isStateListed(currentIssue.state, input.config.tracker.fresh_dispatch_states) &&
        !isSameState(currentIssue.state, refreshedIssue.state)
      ) {
        return {
          reason: 'normal',
          session_id: lastSessionId,
          completion_reason: REASON_CODES.freshDispatchStateRouted,
          refreshed_state: refreshedIssue.state
        };
      }

      if (
        refreshedIssue &&
        isStateListed(currentIssue.state, input.config.tracker.fresh_dispatch_states) &&
        isSameState(currentIssue.state, refreshedIssue.state)
      ) {
        return {
          reason: 'abnormal',
          session_id: lastSessionId,
          error: `${REASON_CODES.freshDispatchNoRoute}: ${currentIssue.state}`,
          refreshed_state: refreshedIssue.state,
          retryable: false
        };
      }

      if (!refreshedIssue || !isActiveState(refreshedIssue.state, input.config.tracker.active_states)) {
        return {
          reason: 'normal',
          session_id: lastSessionId,
          completion_reason: REASON_CODES.issueLeftActiveStates,
          refreshed_state: refreshedIssue?.state ?? null
        };
      }

      currentIssue = refreshedIssue;
      if (turnNumber >= maxTurns) {
        return {
          reason: 'normal',
          session_id: lastSessionId,
          completion_reason: REASON_CODES.maxTurnsReached
        };
      }
    }

    return {
      reason: 'normal',
      session_id: lastSessionId,
      completion_reason: REASON_CODES.maxTurnsReached
    };
  } catch (error) {
    const cancellationOutcome = readCancellationOutcome(error);
    if (cancellationOutcome) {
      return {
        reason: 'abnormal',
        session_id: null,
        error: error instanceof Error ? error.message : 'worker cancellation requested',
        cancellation_outcome: cancellationOutcome
      };
    }
    const workspaceConflictError = await renderWorkspaceConflictError(error, workspacePath);
    return {
      reason: 'abnormal',
      session_id: null,
      error: workspaceConflictError ?? (error instanceof Error ? error.message : 'unknown worker error')
    };
  } finally {
    if (workspacePath) {
      await input.workspaceManager.finalizeAttempt(workspacePath);
    }
  }
}

export async function runLocalWorkerRecoveryAttempt(
  input: LocalWorkerRunInput & {
    previousThreadId: string;
    previousTurnId: string;
    previousSessionId: string | null;
    recoveryPrompt: string;
  }
): Promise<LocalWorkerRunResult> {
  let workspacePath: string | null = null;

  try {
    if (input.config.agent_runtime?.selected === 'claude-cli') {
      return {
        reason: 'abnormal',
        session_id: input.previousSessionId,
        error: 'claude_missing_tool_output_recovery_unsupported'
      };
    }
    if (!input.codexRunner) {
      return {
        reason: 'abnormal',
        session_id: input.previousSessionId,
        error: 'codex_runner_missing'
      };
    }
    const workspace = input.workspace;
    workspacePath = workspace.path;
    const normalizedWorkspace = path.resolve(workspace.path);
    const normalizedRoot = path.resolve(input.config.workspace.root);
    if (normalizedWorkspace === normalizedRoot) {
      input.onCodexEvent?.({
        event: CANONICAL_EVENT.codex.startupFailed,
        timestamp: new Date().toISOString(),
        codex_app_server_pid: null,
        detail: REASON_CODES.unsafeWorkspaceRoot
      });
      return {
        reason: 'abnormal',
        session_id: null,
        error: REASON_CODES.unsafeWorkspaceRoot
      };
    }
    await input.workspaceManager.prepareAttempt(workspace.path);
    const codexSpawnCommand = buildCodexSpawnCommand(input.config.codex);
    const turnResult = await input.codexRunner.resumeThreadInterruptAndRunTurn({
      command: codexSpawnCommand.command,
      commandArgs: codexSpawnCommand.args,
      commandEnv: codexSpawnCommand.env,
      workspaceCwd: workspace.path,
      workerHost: input.worker_host,
      prompt: input.recoveryPrompt,
      previousThreadId: input.previousThreadId,
      previousTurnId: input.previousTurnId,
      previousSessionId: input.previousSessionId,
      title: `${input.issue.identifier}: ${input.issue.title}`,
      maxTurns: 1,
      approvalPolicy: input.config.codex.approval_policy,
      threadSandbox: input.config.codex.thread_sandbox,
      turnSandboxPolicy: input.config.codex.turn_sandbox_policy ? { type: input.config.codex.turn_sandbox_policy } : undefined,
      onEvent: input.onCodexEvent,
      cancellationSignal: input.cancellationSignal,
      readTimeoutMs: input.config.codex.read_timeout_ms,
      turnTimeoutMs: input.config.codex.turn_timeout_ms
    });

    if (turnResult.status !== 'completed') {
      return {
        reason: 'abnormal',
        session_id: turnResult.session_id,
        error: turnResult.error_code ?? turnResult.last_event,
        cancellation_outcome: turnResult.cancellation_outcome,
        input_required_payload: turnResult.input_required_payload
      };
    }

    let refreshedIssues: Issue[];
    try {
      refreshedIssues = await input.issueStateFetcher([input.issue.id]);
    } catch (error) {
      return {
        reason: 'normal',
        session_id: turnResult.session_id,
        completion_reason: REASON_CODES.issueStateRefreshFailed,
        error: `issue_state_refresh_failed: ${error instanceof Error ? error.message : 'unknown'}`
      };
    }

    if (refreshedIssues.length === 0) {
      return {
        reason: 'normal',
        session_id: turnResult.session_id,
        completion_reason: REASON_CODES.issueStateMissing
      };
    }

    const refreshedIssue = refreshedIssues.find((issue) => issue.id === input.issue.id) ?? refreshedIssues[0];
    if (refreshedIssue && isStateListed(refreshedIssue.state, input.config.tracker.terminal_states)) {
      return {
        reason: 'normal',
        session_id: turnResult.session_id,
        completion_reason: REASON_CODES.terminalStateReached,
        refreshed_state: refreshedIssue.state
      };
    }

    if (
      refreshedIssue &&
      isStateListed(refreshedIssue.state, input.config.tracker.handoff_states) &&
      (!isStateListed(input.issue.state, input.config.tracker.fresh_dispatch_states) ||
        !isSameState(input.issue.state, refreshedIssue.state))
    ) {
      return {
        reason: 'normal',
        session_id: turnResult.session_id,
        completion_reason: REASON_CODES.handoffStateReached,
        refreshed_state: refreshedIssue.state
      };
    }

    if (
      refreshedIssue &&
      isStateListed(input.issue.state, input.config.tracker.fresh_dispatch_states) &&
      isSameState(input.issue.state, refreshedIssue.state)
    ) {
      return {
        reason: 'abnormal',
        session_id: turnResult.session_id,
        error: `${REASON_CODES.freshDispatchNoRoute}: ${input.issue.state}`,
        refreshed_state: refreshedIssue.state,
        retryable: false
      };
    }

    if (
      refreshedIssue &&
      isStateListed(input.issue.state, input.config.tracker.fresh_dispatch_states) &&
      !isSameState(input.issue.state, refreshedIssue.state)
    ) {
      return {
        reason: 'normal',
        session_id: turnResult.session_id,
        completion_reason: REASON_CODES.freshDispatchStateRouted,
        refreshed_state: refreshedIssue.state
      };
    }

    if (!refreshedIssue || !isActiveState(refreshedIssue.state, input.config.tracker.active_states)) {
      return {
        reason: 'normal',
        session_id: turnResult.session_id,
        completion_reason: REASON_CODES.issueLeftActiveStates,
        refreshed_state: refreshedIssue?.state ?? null
      };
    }

    return {
      reason: 'normal',
      session_id: turnResult.session_id,
      completion_reason: REASON_CODES.maxTurnsReached
    };
  } catch (error) {
    const cancellationOutcome = readCancellationOutcome(error);
    if (cancellationOutcome) {
      return {
        reason: 'abnormal',
        session_id: null,
        error: error instanceof Error ? error.message : 'worker cancellation requested',
        cancellation_outcome: cancellationOutcome
      };
    }
    const workspaceConflictError = await renderWorkspaceConflictError(error, workspacePath);
    return {
      reason: 'abnormal',
      session_id: null,
      error: workspaceConflictError ?? (error instanceof Error ? error.message : 'unknown recovery worker error')
    };
  } finally {
    if (workspacePath) {
      await input.workspaceManager.finalizeAttempt(workspacePath);
    }
  }
}

function readCancellationOutcome(error: unknown): CodexCancellationOutcome | undefined {
  if (!(error instanceof CodexRunnerError) || error.code !== 'turn_cancelled') {
    return undefined;
  }
  const prefix = 'worker_cancelled:';
  if (!error.message.startsWith(prefix)) {
    return undefined;
  }
  const outcome = error.message.slice(prefix.length).split(':').pop();
  return outcome === 'requested' ||
    outcome === 'graceful_exit' ||
    outcome === 'forced_kill_exited' ||
    outcome === 'forced_kill_requested'
    ? outcome
    : undefined;
}

async function renderWorkspaceConflictError(error: unknown, workspacePath: string | null): Promise<string | null> {
  const typed = parseWorkspaceConflictError(error);
  if (!typed) {
    return null;
  }

  const structuredPreflight = parsePreflightConflictMessage(typed.message);
  const parsedMessageConflictFiles = structuredPreflight?.conflict_files ?? inferConflictFilesFromMessage(typed.message);
  const gitConflictFiles = workspacePath ? await readConflictFilesFromGitStatus(workspacePath) : [];
  const mergedConflictFiles = dedupeConflictFiles([...parsedMessageConflictFiles, ...gitConflictFiles]);

  const payload = {
    code: REASON_CODES.operatorWorkspaceConflict,
    detail: structuredPreflight?.detail ?? typed.message,
    conflict_files: mergedConflictFiles,
    classification_summary: structuredPreflight?.classification_summary,
    resolution_hints:
      structuredPreflight?.resolution_hints ?? [
        'Resolve workspace git conflicts in the issue worktree.',
        'Ensure the workspace branch/worktree mapping matches repository state.',
        'Resume the blocked issue explicitly after conflicts are resolved.'
      ]
  };
  return `workspace_conflict:${JSON.stringify(payload)}`;
}

function parsePreflightConflictMessage(message: string): {
  detail: string;
  conflict_files: Array<{
    path: string;
    status: 'staged' | 'unstaged' | 'unknown';
    classification?: 'ephemeral' | 'tracked_ephemeral' | 'unknown_non_ephemeral';
  }>;
  classification_summary?: {
    ephemeral: number;
    tracked_ephemeral: number;
    unknown_non_ephemeral: number;
  };
  resolution_hints: string[];
} | null {
  const prefix = 'workspace_preflight_conflict:';
  if (!message.startsWith(prefix)) {
    return null;
  }
  try {
    const parsed = JSON.parse(message.slice(prefix.length)) as {
      detail?: unknown;
      conflict_files?: Array<{ path?: unknown; status?: unknown; classification?: unknown }>;
      classification_summary?: { ephemeral?: unknown; tracked_ephemeral?: unknown; unknown_non_ephemeral?: unknown };
      resolution_hints?: unknown;
    };
    const conflict_files = Array.isArray(parsed.conflict_files)
      ? parsed.conflict_files
          .map((entry): { path: string; status: 'staged' | 'unstaged' | 'unknown'; classification?: 'ephemeral' | 'tracked_ephemeral' | 'unknown_non_ephemeral' } | null => {
            const path = typeof entry.path === 'string' ? entry.path.trim() : '';
            const status = entry.status === 'staged' || entry.status === 'unstaged' ? entry.status : 'unknown';
            const classification =
              entry.classification === 'ephemeral' ||
              entry.classification === 'tracked_ephemeral' ||
              entry.classification === 'unknown_non_ephemeral'
                ? entry.classification
                : undefined;
            return path ? { path, status, classification } : null;
          })
          .filter((entry) => entry !== null)
      : [];
    const resolution_hints = Array.isArray(parsed.resolution_hints)
      ? parsed.resolution_hints.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    return {
      detail: typeof parsed.detail === 'string' && parsed.detail.trim().length > 0 ? parsed.detail : 'workspace preflight conflict',
      conflict_files,
      classification_summary: parsed.classification_summary
        ? {
            ephemeral: Number(parsed.classification_summary.ephemeral ?? 0),
            tracked_ephemeral: Number(parsed.classification_summary.tracked_ephemeral ?? 0),
            unknown_non_ephemeral: Number(parsed.classification_summary.unknown_non_ephemeral ?? 0)
          }
        : undefined,
      resolution_hints
    };
  } catch {
    return null;
  }
}

function parseWorkspaceConflictError(error: unknown): { message: string } | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const maybe = error as { code?: unknown; message?: unknown };
  const code = typeof maybe.code === 'string' ? maybe.code : null;
  const message = typeof maybe.message === 'string' ? maybe.message : null;
  if (!code || !message) {
    return null;
  }

  if (code === 'workspace_unprovisioned_conflict' || code === 'workspace_copy_ignored_invalid_config') {
    return { message };
  }

  return null;
}

function inferConflictFilesFromMessage(message: string): Array<{ path: string; status: 'staged' | 'unstaged' | 'unknown' }> {
  const destinationConflictMatch = message.match(/destination conflict:\s*([^\s].*)$/i);
  if (!destinationConflictMatch) {
    return [];
  }
  return [{ path: destinationConflictMatch[1].trim(), status: 'unknown' }];
}

async function readConflictFilesFromGitStatus(
  workspacePath: string
): Promise<Array<{ path: string; status: 'staged' | 'unstaged' | 'unknown' }>> {
  const output = await runGitStatusPorcelain(workspacePath);
  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 4)
    .map((line) => {
      const stagedCode = line[0] ?? ' ';
      const unstagedCode = line[1] ?? ' ';
      const filePath = line.slice(3).trim();
      let status: 'staged' | 'unstaged' | 'unknown' = 'unknown';
      if (stagedCode !== ' ') {
        status = 'staged';
      } else if (unstagedCode !== ' ') {
        status = 'unstaged';
      }
      return filePath ? { path: filePath, status } : null;
    })
    .filter((entry): entry is { path: string; status: 'staged' | 'unstaged' | 'unknown' } => Boolean(entry));
}

async function runGitStatusPorcelain(workspacePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['status', '--porcelain'], {
      cwd: workspacePath,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

function dedupeConflictFiles(
  files: Array<{ path: string; status: 'staged' | 'unstaged' | 'unknown' }>
): Array<{ path: string; status: 'staged' | 'unstaged' | 'unknown' }> {
  const byPath = new Map<string, { path: string; status: 'staged' | 'unstaged' | 'unknown' }>();
  for (const file of files) {
    const normalizedPath = file.path.trim();
    if (!normalizedPath) {
      continue;
    }
    const existing = byPath.get(normalizedPath);
    if (!existing) {
      byPath.set(normalizedPath, { path: normalizedPath, status: file.status });
      continue;
    }
    if (existing.status === 'unknown' && file.status !== 'unknown') {
      byPath.set(normalizedPath, { path: normalizedPath, status: file.status });
    }
  }
  return Array.from(byPath.values());
}

function isActiveState(state: string | null | undefined, activeStates: string[]): boolean {
  return isStateListed(state, activeStates);
}

function isStateListed(state: string | null | undefined, stateNames: string[]): boolean {
  if (!state) {
    return false;
  }
  const normalized = state.trim().toLowerCase();
  return stateNames.some((stateName) => stateName.trim().toLowerCase() === normalized);
}

function isSameState(left: string | null | undefined, right: string | null | undefined): boolean {
  return left?.trim().toLowerCase() === right?.trim().toLowerCase();
}
