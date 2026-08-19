import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Issue } from '../../tracker';
import type { StructuredLogger } from '../../observability';
import { CANONICAL_EVENT } from '../../observability/events';
import { REASON_CODES } from '../../observability/reason-codes';
import { isActiveState, isTerminalState } from '../decisions';
import type { BlockedEntry, OrchestratorOptions, OrchestratorState, RunningEntry } from '../types';
import { isFreshDispatchState, isHandoffFreshDispatchState, isHandoffState, normalizeStateName } from './retry-backpressure';
import { coordinateReconcileStalledRuns, type RunningWaitCoordinatorContext } from './running-wait-coordinator';
import type { DispatchCoordinatorScheduleRetryParams } from './dispatch-coordinator';

export interface ReconciliationCoordinatorHooks {
  terminateRunningIssue: (issueId: string, cleanupWorkspace: boolean, reason: string) => Promise<void>;
  clearBlockedInput: (issueId: string, reason: string) => void;
  clearCircuitBreaker: (issueId: string) => Promise<void>;
  scheduleRetry: (params: DispatchCoordinatorScheduleRetryParams) => Promise<void>;
  markRunningWaitStallRootCauseIfThresholdExceeded: (runningEntry: RunningEntry, observedAtMs: number) => void;
  recordRuntimeEvent: (params: {
    event: string;
    severity: 'info' | 'warn' | 'error';
    issue_identifier?: string;
    session_id?: string;
    detail?: string;
    reason_code?: string | null;
    request_method?: string | null;
    request_category?: string | null;
    tool_call_id?: string | null;
    tool_name?: string | null;
  }) => void;
}

export interface ReconciliationCoordinatorContext {
  readonly state: OrchestratorState;
  readonly config: OrchestratorOptions['config'];
  readonly tracker: Pick<OrchestratorOptions['ports']['tracker'], 'fetch_issue_states_by_ids'>;
  readonly runningWait: RunningWaitCoordinatorContext;
  readonly logger: StructuredLogger | undefined;
  readonly nowMs: () => number;
  readonly hooks: ReconciliationCoordinatorHooks;
}

export async function coordinateReconcileRunningIssues(context: ReconciliationCoordinatorContext): Promise<void> {
  if (context.state.running.size === 0) {
    return;
  }

  const runningIssueIds = Array.from(context.state.running.keys());

  let refreshed: Issue[];
  try {
    refreshed = await context.tracker.fetch_issue_states_by_ids(runningIssueIds);
  } catch (error) {
    context.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.tracker.stateRefreshFailed,
      message: 'failed to refresh tracker states for running issues',
      context: {
        issue_count: runningIssueIds.length,
        error: error instanceof Error ? error.message : 'unknown'
      }
    });
    context.hooks.recordRuntimeEvent({
      event: CANONICAL_EVENT.tracker.stateRefreshFailed,
      severity: 'warn',
      detail: error instanceof Error ? error.message : 'unknown'
    });
    await coordinateReconcileStalledRuns(context.runningWait);
    return;
  }

  for (const refreshedIssue of refreshed) {
    const runningEntry = context.state.running.get(refreshedIssue.id);
    if (!runningEntry) {
      continue;
    }

    if (isTerminalState(refreshedIssue.state, context.config)) {
      await context.hooks.terminateRunningIssue(refreshedIssue.id, true, REASON_CODES.terminalStateReached);
      continue;
    }

    if (
      isHandoffFreshDispatchState(refreshedIssue.state, context.config) &&
      !didRunStartInState(runningEntry, refreshedIssue.state)
    ) {
      await context.hooks.terminateRunningIssue(refreshedIssue.id, false, REASON_CODES.handoffRelease);
      continue;
    }

    if (isHandoffState(refreshedIssue.state, context.config) && !didRunStartInState(runningEntry, refreshedIssue.state)) {
      await context.hooks.terminateRunningIssue(refreshedIssue.id, false, REASON_CODES.handoffStateReached);
      continue;
    }

    if (
      runningEntry.last_event === CANONICAL_EVENT.codex.turnCompleted &&
      isFreshDispatchState(refreshedIssue.state, context.config) &&
      !didRunStartInState(runningEntry, refreshedIssue.state)
    ) {
      await context.hooks.terminateRunningIssue(refreshedIssue.id, false, REASON_CODES.handoffRelease);
      continue;
    }

    if (isActiveState(refreshedIssue.state, context.config)) {
      runningEntry.issue = refreshedIssue;
      runningEntry.identifier = refreshedIssue.identifier;
      continue;
    }

    context.hooks.markRunningWaitStallRootCauseIfThresholdExceeded(runningEntry, context.nowMs());
    await context.hooks.terminateRunningIssue(refreshedIssue.id, false, 'non_active_state_transition');
  }

  await coordinateReconcileStalledRuns(context.runningWait);
}

export async function coordinateReconcileBlockedInputs(context: ReconciliationCoordinatorContext): Promise<void> {
  if (context.state.blocked_inputs.size === 0) {
    return;
  }

  const blockedIssueIds = Array.from(context.state.blocked_inputs.keys());
  let refreshed: Issue[];
  try {
    refreshed = await context.tracker.fetch_issue_states_by_ids(blockedIssueIds);
  } catch (error) {
    context.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.tracker.stateRefreshFailed,
      message: 'failed to refresh tracker states for blocked issues',
      context: {
        issue_count: blockedIssueIds.length,
        error: error instanceof Error ? error.message : 'unknown'
      }
    });
    return;
  }

  const refreshedById = new Map(refreshed.map((issue) => [issue.id, issue]));
  for (const issueId of blockedIssueIds) {
    const blocked = context.state.blocked_inputs.get(issueId);
    if (!blocked) {
      continue;
    }

    const issue = refreshedById.get(issueId);
    if (issue && shouldClearStaleNoProgressBlockedInput(context, blocked, issue)) {
      context.hooks.clearBlockedInput(issueId, REASON_CODES.staleBlockedInputCleared);
      context.state.redispatch_progress?.delete(issueId);
      void context.hooks.clearCircuitBreaker(issueId);
      context.hooks.recordRuntimeEvent({
        event: CANONICAL_EVENT.orchestration.staleBlockedInputCleared,
        severity: 'info',
        issue_identifier: blocked.issue_identifier,
        detail: `tracker_state=${issue.state} stop_reason_code=${blocked.stop_reason_code}`
      });
      context.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.orchestration.staleBlockedInputCleared,
        message: 'stale no-progress blocked input cleared for actionable tracker state',
        context: {
          issue_id: issueId,
          issue_identifier: blocked.issue_identifier,
          tracker_state: issue.state,
          stop_reason_code: blocked.stop_reason_code,
          pending_input: blocked.pending_input ? JSON.stringify(blocked.pending_input) : null
        }
      });
      continue;
    }
    if (issue && shouldRecoverWorkspaceAttemptResidue(context, blocked, issue)) {
      context.hooks.clearBlockedInput(issueId, REASON_CODES.workspaceAttemptResidueRecovered);
      await context.hooks.scheduleRetry({
        issue_id: issueId,
        identifier: blocked.issue_identifier,
        attempt: blocked.attempt,
        issue_run_id: blocked.issue_run_id,
        previous_attempt_id: blocked.previous_attempt_id,
        delay_type: 'continuation',
        error: 'workspace attempt residue recovered',
        worker_host: blocked.worker_host,
        workspace_path: blocked.workspace_path,
        provisioner_type: blocked.provisioner_type,
        branch_name: blocked.branch_name,
        repo_root: blocked.repo_root,
        workspace_exists: blocked.workspace_exists,
        workspace_git_status: blocked.workspace_git_status,
        workspace_provisioned: blocked.workspace_provisioned,
        workspace_is_git_worktree: blocked.workspace_is_git_worktree,
        copy_ignored_applied: blocked.copy_ignored_applied,
        copy_ignored_status: blocked.copy_ignored_status,
        copy_ignored_summary: blocked.copy_ignored_summary,
        stop_reason_code: REASON_CODES.workspaceAttemptResidueRecovered,
        stop_reason_detail: 'recoverable workspace attempt residue will be continued',
        previous_thread_id: blocked.previous_thread_id,
        previous_turn_id: blocked.previous_turn_id ?? null,
        previous_session_id: blocked.previous_session_id,
        progress_signals: blocked.progress_signals,
        recover_workspace_attempt_residue: true,
        issue_snapshot: issue
      });
      context.hooks.recordRuntimeEvent({
        event: CANONICAL_EVENT.orchestration.blockedInputCleared,
        severity: 'info',
        issue_identifier: blocked.issue_identifier,
        detail: `workspace_attempt_residue_recovered conflict_files=${blocked.conflict_files.length}`
      });
      continue;
    }
    if (!issue || isTerminalState(issue.state, context.config) || !isActiveState(issue.state, context.config)) {
      if (
        blocked.stop_reason_code === REASON_CODES.missingToolOutput ||
        blocked.stop_reason_code === REASON_CODES.missingToolOutputRecoveryStartFailed ||
        blocked.stop_reason_code === REASON_CODES.missingToolOutputRecoveryExhausted ||
        blocked.stop_reason_code === REASON_CODES.missingToolOutputRecoveryUnsafe
      ) {
        continue;
      }
      context.hooks.clearBlockedInput(issueId, issue ? 'issue_no_longer_active' : 'issue_not_found');
    }
  }
}

function didRunStartInState(runningEntry: RunningEntry, issueState: string): boolean {
  return normalizeStateName(runningEntry.started_issue_state ?? runningEntry.issue.state) === normalizeStateName(issueState);
}

function shouldClearStaleNoProgressBlockedInput(
  context: ReconciliationCoordinatorContext,
  blocked: BlockedEntry,
  issue: Issue
): boolean {
  if (blocked.pending_input) {
    return false;
  }
  if (!isActiveState(issue.state, context.config)) {
    return false;
  }
  return (
    blocked.stop_reason_code === REASON_CODES.operatorNoProgressRedispatchBlocked ||
    blocked.stop_reason_code === REASON_CODES.awaitingHumanReviewScopeIncomplete
  );
}

function shouldRecoverWorkspaceAttemptResidue(
  context: ReconciliationCoordinatorContext,
  blocked: BlockedEntry,
  issue: Issue
): boolean {
  if (blocked.stop_reason_code !== REASON_CODES.operatorWorkspaceConflict) {
    return false;
  }
  if (blocked.pending_input || !isActiveState(issue.state, context.config)) {
    return false;
  }
  if (blocked.attempt <= 0 || !blocked.workspace_path) {
    return false;
  }
  if (!isRecoverableWorkspaceResiduePath(blocked)) {
    return false;
  }
  if (blocked.conflict_files.length === 0) {
    return false;
  }
  const summary = blocked.classification_summary;
  if (summary && (summary.tracked_ephemeral > 0 || summary.ephemeral > 0)) {
    return false;
  }
  const persistedClassificationsAreRecoverable = blocked.conflict_files.every((file) => {
    const normalized = file.path.replace(/\\/g, '/');
    const classification =
      file.classification ?? (summary?.unknown_non_ephemeral === blocked.conflict_files.length ? 'unknown_non_ephemeral' : null);
    return classification === 'unknown_non_ephemeral' && !normalized.startsWith('output/playwright/');
  });
  if (persistedClassificationsAreRecoverable) {
    return true;
  }
  return hasRecoverableLiveAttemptResidue(blocked);
}

function isRecoverableWorkspaceResiduePath(blocked: BlockedEntry): boolean {
  if (!blocked.workspace_path) {
    return false;
  }
  const workspacePath = blocked.workspace_path;
  try {
    const stat = fs.statSync(workspacePath);
    if (!stat.isDirectory()) {
      return false;
    }
    const gitDir = resolveGitDirSync(workspacePath);
    if (!gitDir) {
      return false;
    }
    const activeGitStatePaths = [
      'MERGE_HEAD',
      'REBASE_HEAD',
      'AUTO_MERGE',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'BISECT_LOG',
      'sequencer',
      'rebase-merge',
      'rebase-apply'
    ];
    if (activeGitStatePaths.some((entry) => fs.existsSync(path.join(gitDir, entry)))) {
      return false;
    }
    const unmerged = spawnSync('git', ['ls-files', '-u'], { cwd: workspacePath, encoding: 'utf8' });
    if (unmerged.status !== 0 || unmerged.stdout.trim()) {
      return false;
    }
    return !blocked.workspace_provisioned || (blocked.workspace_is_git_worktree && Boolean(blocked.branch_name && blocked.repo_root));
  } catch {
    return false;
  }
}

function hasRecoverableLiveAttemptResidue(blocked: BlockedEntry): boolean {
  if (!blocked.workspace_path || blocked.conflict_files.length === 0) {
    return false;
  }
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: blocked.workspace_path,
    encoding: 'utf8'
  });
  if (status.status !== 0) {
    return false;
  }

  const livePaths = new Set<string>();
  for (const entry of parseStatusPorcelain(status.stdout)) {
    const normalized = normalizePorcelainPath(entry.path);
    if (!normalized || isNonRecoverableResiduePath(normalized)) {
      return false;
    }
    if (entry.staged !== ' ' || entry.unstaged !== ' ') {
      livePaths.add(normalized);
    }
  }
  if (livePaths.size === 0) {
    return false;
  }

  const blockedPaths = new Set<string>();
  for (const file of blocked.conflict_files) {
    const normalized = normalizePorcelainPath(file.path);
    if (!normalized || isNonRecoverableResiduePath(normalized)) {
      return false;
    }
    blockedPaths.add(normalized);
  }

  return livePaths.size === blockedPaths.size && [...livePaths].every((livePath) => blockedPaths.has(livePath));
}

function parseStatusPorcelain(output: string): Array<{ staged: string; unstaged: string; path: string }> {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 4)
    .map((line) => ({ staged: line[0] ?? ' ', unstaged: line[1] ?? ' ', path: line.slice(3).trim() }))
    .filter((entry) => entry.path.length > 0);
}

function normalizePorcelainPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/');
  const renameTarget = normalized.includes(' -> ') ? normalized.slice(normalized.lastIndexOf(' -> ') + 4) : normalized;
  return renameTarget.replace(/^"|"$/g, '');
}

function isNonRecoverableResiduePath(normalizedPath: string): boolean {
  return normalizedPath === '.symphony-provision.json' || normalizedPath.startsWith('output/playwright/');
}

function resolveGitDirSync(workspacePath: string): string | null {
  const dotGitPath = path.join(workspacePath, '.git');
  try {
    const stat = fs.statSync(dotGitPath);
    if (stat.isDirectory()) {
      return dotGitPath;
    }
    if (!stat.isFile()) {
      return null;
    }
    const content = fs.readFileSync(dotGitPath, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/i.exec(content);
    if (!match) {
      return null;
    }
    return path.resolve(workspacePath, match[1]);
  } catch {
    return null;
  }
}
