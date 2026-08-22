import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { StructuredLogger } from '../observability';
import { CANONICAL_EVENT } from '../observability/events';
import { REASON_CODES } from '../observability/reason-codes';
import type { Issue, TrackerAdapter } from '../tracker';
import type { WorkspaceInfo } from '../workspace';
import type { ReviewApprovalActionRecord, ReviewApprovalActionStatus } from '../persistence';
import { resolveWorkspaceGitDirectory } from './capsule';
import { extractReviewArtifact, extractReviewReceipt, receiptSha256, reviewSha256 } from './contract';
import { GitHubAppApprovalBroker } from './github-app-broker';
import { GitHubReviewClient, parseGitHubRemote } from './github-context';
import type { AgentReviewOutcome, ReviewApprovalResult, ReviewRoute } from './types';

export interface ReviewApprovalCoordinatorOptions {
  tracker: TrackerAdapter;
  projectRoot: string;
  workspaceRoot: string;
  managedWorkspaceRoot: string;
  baseRef: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  logger?: StructuredLogger;
  actionLedger?: {
    upsertReviewApprovalAction(record: ReviewApprovalActionRecord): void;
    listNonterminalReviewApprovalActions?(): ReviewApprovalActionRecord[];
  };
  githubClient?: GitHubReviewClient;
  brokerFactory?: () => Pick<GitHubAppApprovalBroker, 'separatedIdentity' | 'approve'>;
}

function routeState(route: ReviewRoute): string {
  if (route === 'human_review') return 'Human Review';
  if (route === 'in_progress') return 'In Progress';
  if (route === 'rework') return 'Rework';
  return 'Merging';
}

function sameState(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function git(workspace: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024
  }).trim();
}

function failure(reason: string, detail?: string): ReviewApprovalResult {
  return { ok: false, reason_code: reason, detail };
}

function canonicalFailureReason(detail: string): string {
  if (/credential|private_key|key_|installation|app_identity|identity_not_separated|repository_not_installed/.test(detail)) {
    return REASON_CODES.reviewApprovalCredentialsInvalid;
  }
  if (/github_status|github_auth|graphql/.test(detail)) return REASON_CODES.reviewApprovalGithubFailed;
  if (/readback|effective_decision|route_readback/.test(detail)) return REASON_CODES.reviewApprovalReadbackFailed;
  if (/coordinator|comment_read_unsupported|ledger|history/.test(detail)) {
    return REASON_CODES.reviewApprovalSupervisorUnavailable;
  }
  return REASON_CODES.reviewApprovalContextMismatch;
}

export class ReviewApprovalCoordinator {
  private readonly env: NodeJS.ProcessEnv;
  private readonly client: GitHubReviewClient;

  constructor(private readonly options: ReviewApprovalCoordinatorOptions) {
    this.env = options.env ?? process.env;
    this.client = options.githubClient ?? new GitHubReviewClient({
        token: this.env.GH_TOKEN ?? this.env.GITHUB_TOKEN,
        fetchFn: options.fetchFn
      });
  }

  private broker(): Pick<GitHubAppApprovalBroker, 'separatedIdentity' | 'approve'> {
    const appId = this.env.SYMPHONY_REVIEWER_APP_ID?.trim();
    const installationId = this.env.SYMPHONY_REVIEWER_INSTALLATION_ID?.trim();
    if (!appId || !installationId) throw new Error('review_approval_credentials_missing');
    return this.options.brokerFactory?.() ?? new GitHubAppApprovalBroker({
      appId,
      installationId,
      privateKeyPath: this.env.SYMPHONY_REVIEWER_PRIVATE_KEY_PATH,
      privateKey: this.env.SYMPHONY_REVIEWER_PRIVATE_KEY,
      projectRoot: this.options.projectRoot,
      workspaceRoot: this.options.workspaceRoot,
      managedWorkspaceRoot: this.options.managedWorkspaceRoot,
      fetchFn: this.options.fetchFn,
      operatorToken: this.env.GH_TOKEN ?? this.env.GITHUB_TOKEN
    });
  }

  async reconcilePendingActions(): Promise<{ recovered: number; superseded: number }> {
    const ledger = this.options.actionLedger;
    const pending = ledger?.listNonterminalReviewApprovalActions?.() ?? [];
    let recovered = 0;
    let superseded = 0;
    for (const original of pending) {
      let action = original;
      const persist = (status: ReviewApprovalActionStatus, updates: Partial<ReviewApprovalActionRecord> = {}): void => {
        const now = new Date().toISOString();
        action = {
          ...action,
          ...updates,
          status,
          updated_at: now,
          approved_at: status === 'approved' ? now : action.approved_at,
          routed_at: status === 'routed' ? now : action.routed_at
        };
        ledger?.upsertReviewApprovalAction(action);
      };
      try {
        const issue = (await this.options.tracker.fetch_issue_states_by_ids([action.issue_id]))[0];
        if (!issue) throw new Error('review_approval_issue_missing');
        const route = (action.effective_route ?? action.requested_route) as ReviewRoute;
        if (!['merging', 'human_review', 'in_progress', 'rework'].includes(route)) {
          throw new Error('review_approval_route_invalid');
        }
        const desiredState = routeState(route);
        if (sameState(issue.state, desiredState) && ['approved', 'routing_pending'].includes(action.status)) {
          persist('routed', { reason_code: null });
          recovered += 1;
          continue;
        }
        if (!sameState(issue.state, 'Agent Review')) {
          persist('superseded', { reason_code: REASON_CODES.reviewApprovalContextMismatch });
          superseded += 1;
          continue;
        }
        if (!this.options.tracker.fetch_issue_comments) throw new Error('review_approval_comment_read_unsupported');
        const comments = await this.options.tracker.fetch_issue_comments(action.issue_id);
        const matches = comments.flatMap((comment) => {
          const receipt = extractReviewReceipt(comment.body);
          const artifact = extractReviewArtifact(comment.body);
          return receipt && artifact ? [{ receipt, artifact }] : [];
        }).filter(({ receipt, artifact }) =>
          receiptSha256(receipt) === action.receipt_sha256
          && reviewSha256(artifact) === action.review_artifact_sha256
          && receipt.github_context_sha256 === action.github_context_sha256
          && receipt.repository === action.repository
          && receipt.pr_number === action.pr_number
          && receipt.base_sha === action.base_sha
          && receipt.head_sha === action.head_sha
          && receipt.symphony_attempt_id === action.symphony_attempt_id
        );
        if (matches.length !== 1) throw new Error('review_approval_receipt_missing_or_duplicate');
        const broker = this.broker();
        const identity = await broker.separatedIdentity();
        const snapshot = await this.client.fetchSnapshot(action.repository, action.pr_number, identity.login);
        if (
          snapshot.state !== 'open'
          || snapshot.draft
          || snapshot.base_ref !== this.options.baseRef.replace(/^origin\//, '')
          || snapshot.base_sha !== action.base_sha
          || snapshot.head_sha !== action.head_sha
          || snapshot.context_sha256 !== action.github_context_sha256
          || !snapshot.checks_green
        ) {
          persist('superseded', { reason_code: REASON_CODES.reviewApprovalContextMismatch });
          superseded += 1;
          continue;
        }
        const passRoute = route === 'merging' || route === 'human_review';
        const effectiveRoute = passRoute && issue.labels.some((label) => label.toLowerCase() === 'human review')
          ? 'human_review'
          : route;
        if (passRoute) {
          persist('approval_pending', { effective_route: effectiveRoute, app_slug: identity.slug, app_login: identity.login });
          const approval = await broker.approve(action.repository, action.pr_number, action.head_sha);
          persist('approved', {
            github_review_id: approval.review_id,
            github_review_state: 'APPROVED'
          });
          const afterApproval = await this.client.fetchSnapshot(action.repository, action.pr_number, identity.login);
          if (
            afterApproval.head_sha !== action.head_sha
            || afterApproval.context_sha256 !== action.github_context_sha256
            || !afterApproval.checks_green
            || afterApproval.review_decision !== 'APPROVED'
          ) {
            persist('superseded', { reason_code: REASON_CODES.reviewApprovalContextMismatch });
            superseded += 1;
            continue;
          }
        }
        persist('routing_pending', { effective_route: effectiveRoute });
        const destination = routeState(effectiveRoute);
        await this.options.tracker.update_issue_state(action.issue_id, destination);
        const routed = (await this.options.tracker.fetch_issue_states_by_ids([action.issue_id]))[0];
        if (!routed || !sameState(routed.state, destination)) throw new Error('review_approval_route_readback_failed');
        persist('routed', { reason_code: null });
        recovered += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        persist('failed', { reason_code: canonicalFailureReason(detail) });
        throw new Error(`review_approval_reconciliation_failed:${action.issue_identifier}:${detail}`);
      }
    }
    return { recovered, superseded };
  }

  async process(params: {
    issue: Issue;
    outcome: AgentReviewOutcome;
    workspace: WorkspaceInfo;
    symphonyAttemptId: string;
  }): Promise<ReviewApprovalResult> {
    let action: ReviewApprovalActionRecord | null = null;
    const updateAction = (status: ReviewApprovalActionStatus, updates: Partial<ReviewApprovalActionRecord> = {}): void => {
      if (!action || !this.options.actionLedger) return;
      const now = new Date().toISOString();
      action = {
        ...action,
        ...updates,
        status,
        updated_at: now,
        validated_at: status === 'approval_pending' ? now : action.validated_at,
        approved_at: status === 'approved' ? now : action.approved_at,
        routed_at: status === 'routed' ? now : action.routed_at
      };
      this.options.actionLedger.upsertReviewApprovalAction(action);
    };
    const fail = (detail: string): ReviewApprovalResult => {
      const reason = canonicalFailureReason(detail);
      updateAction(detail.includes('drift') || detail.includes('mismatch') ? 'superseded' : 'failed', {
        reason_code: reason
      });
      this.options.logger?.log({
        level: 'warn',
        event: reason === REASON_CODES.reviewApprovalCredentialsInvalid
          ? CANONICAL_EVENT.reviewApproval.credentialsInvalid
          : reason === REASON_CODES.reviewApprovalGithubFailed
            ? CANONICAL_EVENT.reviewApproval.githubFailed
            : reason === REASON_CODES.reviewApprovalReadbackFailed
              ? CANONICAL_EVENT.reviewApproval.readbackFailed
              : CANONICAL_EVENT.reviewApproval.contextMismatch,
        message: 'supervisor review approval gate failed closed',
        context: { issue_id: params.issue.id, reason_code: reason, detail }
      });
      return failure(reason, detail);
    };
    try {
      this.options.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.reviewApproval.requested,
        message: 'supervisor review approval requested',
        context: { issue_id: params.issue.id, symphony_attempt_id: params.symphonyAttemptId }
      });
      if (!params.outcome || params.outcome.symphony_attempt_id !== params.symphonyAttemptId) {
        return fail('review_approval_attempt_mismatch');
      }
      if (params.outcome.issue_id !== params.issue.id && params.outcome.issue_id !== params.issue.identifier) {
        return fail('review_approval_issue_mismatch');
      }
      const refreshed = await this.options.tracker.fetch_issue_states_by_ids([params.issue.id]);
      const issue = refreshed.find((candidate) => candidate.id === params.issue.id) ?? refreshed[0];
      if (!issue || !sameState(issue.state, 'Agent Review')) return fail('review_approval_issue_left_agent_review');
      if (!this.options.tracker.fetch_issue_comments) return fail('review_approval_comment_read_unsupported');
      const status = git(params.workspace.path, ['status', '--porcelain', '--untracked-files=all']);
      if (status) return fail('review_approval_workspace_dirty');
      const headSha = git(params.workspace.path, ['rev-parse', 'HEAD']);
      if (headSha !== params.outcome.head_sha) return fail('review_approval_head_changed');
      const repository = parseGitHubRemote(git(params.workspace.path, ['remote', 'get-url', 'origin']));
      if (!repository) return fail('review_approval_repository_invalid');
      if (issue.tracker_meta?.repository !== 'unknown' && issue.tracker_meta?.repository !== repository) {
        return fail('review_approval_repository_mismatch');
      }
      const links = issue.tracker_meta?.pr_links.filter((link) => !link.merged) ?? [];
      if (links.length !== 1 || links[0]!.number !== params.outcome.pr_number) {
        return fail('review_approval_pr_binding_ambiguous');
      }
      const matchPublishedArtifacts = (comments: { body: string }[]) => comments.flatMap((comment) => {
        const receipt = extractReviewReceipt(comment.body);
        const artifact = extractReviewArtifact(comment.body);
        return receipt && artifact ? [{ receipt, artifact }] : [];
      }).filter(({ receipt, artifact }) =>
        receiptSha256(receipt) === params.outcome.review_receipt_sha256
        && reviewSha256(artifact) === params.outcome.review_artifact_sha256
      );
      let artifacts = matchPublishedArtifacts(await this.options.tracker.fetch_issue_comments(params.issue.id));
      if (artifacts.length === 0) {
        // The workflow asks the worker to publish final.md as a tracker
        // comment, but an agent copying kilobytes of markdown by hand drifts
        // often enough that a receipt-verified review was discarded as
        // unpublished. The capsule written by `review finalize` holds the
        // canonical bytes; when they hash-match the outcome, the supervisor
        // publishes them itself and re-reads. A capsule that does not match
        // the outcome, or anything other than exactly one published match
        // afterwards, still fails closed.
        const gitDirectory = resolveWorkspaceGitDirectory(params.workspace.path);
        let finalMarkdown: string | null = null;
        try {
          finalMarkdown = gitDirectory
            ? fs.readFileSync(path.join(gitDirectory, 'symphony-review', params.outcome.head_sha, 'final.md'), 'utf8')
            : null;
        } catch {
          finalMarkdown = null;
        }
        const capsuleReceipt = finalMarkdown ? extractReviewReceipt(finalMarkdown) : null;
        const capsuleArtifact = finalMarkdown ? extractReviewArtifact(finalMarkdown) : null;
        if (
          !finalMarkdown
          || !capsuleReceipt
          || !capsuleArtifact
          || receiptSha256(capsuleReceipt) !== params.outcome.review_receipt_sha256
          || reviewSha256(capsuleArtifact) !== params.outcome.review_artifact_sha256
        ) {
          return fail('review_approval_receipt_missing_or_duplicate');
        }
        await this.options.tracker.create_comment(params.issue.id, finalMarkdown);
        this.options.logger?.log({
          level: 'info',
          event: CANONICAL_EVENT.reviewApproval.artifactPublished,
          message: 'supervisor published the capsule review artifact as the tracker comment',
          context: { issue_id: params.issue.id, pr_number: params.outcome.pr_number, head_sha: params.outcome.head_sha }
        });
        artifacts = matchPublishedArtifacts(await this.options.tracker.fetch_issue_comments(params.issue.id));
      }
      if (artifacts.length !== 1) return fail('review_approval_receipt_missing_or_duplicate');
      const { receipt, artifact } = artifacts[0]!;
      if (
        receipt.issue_id !== params.outcome.issue_id
        || receipt.repository !== repository
        || receipt.pr_number !== params.outcome.pr_number
        || receipt.base_sha !== params.outcome.base_sha
        || receipt.head_sha !== params.outcome.head_sha
        || receipt.verdict !== params.outcome.verdict
        || receipt.route !== params.outcome.route
        || receipt.symphony_attempt_id !== params.symphonyAttemptId
        || receipt.review_artifact_sha256 !== reviewSha256(artifact)
      ) return fail('review_approval_receipt_mismatch');

      const now = new Date().toISOString();
      const actionKey = crypto.createHash('sha256').update([
        this.options.projectRoot,
        params.issue.id,
        repository,
        String(receipt.pr_number),
        receipt.head_sha,
        params.outcome.review_receipt_sha256,
        this.env.SYMPHONY_REVIEWER_INSTALLATION_ID ?? ''
      ].join('\0')).digest('hex');
      action = {
        action_key: actionKey,
        project_key: null,
        issue_id: params.issue.id,
        issue_identifier: params.issue.identifier,
        issue_run_id: null,
        attempt_id: null,
        thread_id: null,
        turn_id: null,
        symphony_attempt_id: params.symphonyAttemptId,
        repository,
        pr_number: receipt.pr_number,
        base_sha: receipt.base_sha,
        head_sha: receipt.head_sha,
        receipt_sha256: params.outcome.review_receipt_sha256,
        review_artifact_sha256: params.outcome.review_artifact_sha256,
        github_context_sha256: receipt.github_context_sha256,
        requested_route: receipt.route,
        effective_route: null,
        app_slug: null,
        app_login: null,
        github_review_id: null,
        github_review_state: null,
        status: 'pending_validation',
        reason_code: null,
        created_at: now,
        validated_at: null,
        approved_at: null,
        routed_at: null,
        updated_at: now
      };
      this.options.actionLedger?.upsertReviewApprovalAction(action);

      const broker = this.broker();
      const identity = await broker.separatedIdentity();
      const snapshot = await this.client.fetchSnapshot(repository, params.outcome.pr_number, identity.login);
      if (
        snapshot.state !== 'open'
        || snapshot.draft
        || snapshot.base_ref !== this.options.baseRef.replace(/^origin\//, '')
        || receipt.base_ref !== snapshot.base_ref
        || snapshot.base_sha !== receipt.base_sha
        || snapshot.head_sha !== receipt.head_sha
        || !snapshot.checks_green
        || snapshot.context_sha256 !== receipt.github_context_sha256
      ) {
        updateAction('superseded', { reason_code: REASON_CODES.reviewApprovalContextMismatch });
        return fail(REASON_CODES.reviewApprovalContextMismatch);
      }
      this.options.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.reviewApproval.validated,
        message: 'supervisor review evidence validated',
        context: { issue_id: params.issue.id, pr_number: receipt.pr_number, head_sha: receipt.head_sha }
      });

      let effectiveRoute = receipt.route;
      if (receipt.verdict === 'pass' && issue.labels.some((label) => label.toLowerCase() === 'human review')) {
        effectiveRoute = 'human_review';
      }
      updateAction(receipt.verdict === 'pass' ? 'approval_pending' : 'routing_pending', {
        effective_route: effectiveRoute,
        app_slug: identity.slug,
        app_login: identity.login
      });
      if (receipt.verdict === 'pass') {
        const approval = await broker.approve(repository, receipt.pr_number, receipt.head_sha);
        if (!approval.reused) {
          this.options.logger?.log({
            level: 'info',
            event: CANONICAL_EVENT.reviewApproval.submitted,
            message: 'submitted exact-head App approval',
            context: { issue_id: params.issue.id, pr_number: receipt.pr_number, head_sha: receipt.head_sha }
          });
        }
        updateAction('approved', {
          github_review_id: approval.review_id,
          github_review_state: 'APPROVED'
        });
        this.options.logger?.log({
          level: 'info',
          event: approval.reused ? CANONICAL_EVENT.reviewApproval.reused : CANONICAL_EVENT.reviewApproval.confirmed,
          message: approval.reused ? 'existing exact-head App approval reused' : 'exact-head App approval confirmed',
          context: { issue_id: params.issue.id, pr_number: receipt.pr_number, head_sha: receipt.head_sha, review_id: approval.review_id }
        });
        const afterApproval = await this.client.fetchSnapshot(repository, receipt.pr_number, identity.login);
        const stateAfterApproval = (await this.options.tracker.fetch_issue_states_by_ids([params.issue.id]))[0];
        if (
          !stateAfterApproval
          || !sameState(stateAfterApproval.state, 'Agent Review')
          || afterApproval.head_sha !== receipt.head_sha
          || afterApproval.context_sha256 !== receipt.github_context_sha256
          || !afterApproval.checks_green
          || afterApproval.review_decision !== 'APPROVED'
        ) {
          updateAction('superseded', { reason_code: REASON_CODES.reviewApprovalContextMismatch });
          return fail('review_approval_post_approval_drift');
        }
        updateAction('routing_pending');
      }
      this.options.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.reviewApproval.routingPending,
        message: 'review approval gate is routing the validated outcome',
        context: { issue_id: params.issue.id, route: effectiveRoute }
      });
      const state = routeState(effectiveRoute);
      await this.options.tracker.update_issue_state(params.issue.id, state);
      const routed = (await this.options.tracker.fetch_issue_states_by_ids([params.issue.id]))[0];
      if (!routed || !sameState(routed.state, state)) {
        updateAction('failed', { reason_code: REASON_CODES.reviewApprovalReadbackFailed });
        return fail('review_approval_route_readback_failed');
      }
      updateAction('routed', { effective_route: effectiveRoute, reason_code: null });
      this.options.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.reviewApproval.routeCompleted,
        message: 'supervisor review route completed',
        context: { issue_id: params.issue.id, route: effectiveRoute, state }
      });
      return { ok: true, route: effectiveRoute, state };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return fail(detail);
    }
  }
}
