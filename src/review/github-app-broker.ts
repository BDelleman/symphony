import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { REASON_CODES } from '../observability/reason-codes';
import { GitHubReviewClient } from './github-context';

export interface GitHubAppIdentity {
  slug: string;
  login: string;
  app_id: string;
  installation_id: string;
}

export interface GitHubApprovalResult {
  identity: GitHubAppIdentity;
  review_id: number;
  reused: boolean;
}

export interface GitHubAppProbeResult {
  identity: GitHubAppIdentity;
  operator_login: string;
  repository: string;
  permissions: Record<string, string>;
  inline_key: boolean;
  key_path: string | null;
}

export interface BrokerOptions {
  appId: string;
  installationId: string;
  privateKeyPath?: string;
  privateKey?: string;
  projectRoot: string;
  workspaceRoot: string;
  managedWorkspaceRoot: string;
  fetchFn?: typeof fetch;
  apiBase?: string;
  operatorToken?: string;
  now?: () => Date;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('review_approval_github_invalid_payload');
  return value as Record<string, unknown>;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function isTransientGitHubStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function retryDelay(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, attempt * 200));
}

export function loadReviewerPrivateKey(options: BrokerOptions): { key: string; path: string | null; inline: boolean } {
  if (options.privateKeyPath?.trim()) {
    const candidate = options.privateKeyPath.trim();
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('review_approval_key_not_regular');
    const resolved = fs.realpathSync(candidate);
    const resolvedStat = fs.statSync(resolved);
    if (!resolvedStat.isFile()) throw new Error('review_approval_key_not_regular');
    if ((resolvedStat.mode & 0o777) !== 0o600) throw new Error('review_approval_key_permissions');
    for (const root of [options.projectRoot, options.workspaceRoot, options.managedWorkspaceRoot]) {
      if (isInside(root, resolved)) throw new Error('review_approval_key_inside_agent_boundary');
    }
    const key = fs.readFileSync(resolved, 'utf8');
    crypto.createPrivateKey(key);
    return { key, path: resolved, inline: false };
  }
  if (options.privateKey?.trim()) {
    crypto.createPrivateKey(options.privateKey);
    return { key: options.privateKey, path: null, inline: true };
  }
  throw new Error('review_approval_credentials_missing');
}

export class GitHubAppApprovalBroker {
  private readonly fetchFn: typeof fetch;
  private readonly apiBase: string;
  private readonly operatorClient: GitHubReviewClient;

  constructor(private readonly options: BrokerOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.operatorClient = new GitHubReviewClient({
      token: options.operatorToken,
      fetchFn: this.fetchFn,
      apiBase: this.apiBase
    });
  }

  private jwt(): string {
    const now = Math.floor((this.options.now ?? (() => new Date()))().getTime() / 1000);
    const header = base64urlJson({ alg: 'RS256', typ: 'JWT' });
    const payload = base64urlJson({ iat: now - 30, exp: now + 9 * 60, iss: this.options.appId });
    const unsigned = `${header}.${payload}`;
    const { key } = loadReviewerPrivateKey(this.options);
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
    return `${unsigned}.${signature}`;
  }

  private async appRequest(pathname: string, token: string, init: RequestInit = {}): Promise<unknown> {
    const method = String(init.method ?? 'GET').toUpperCase();
    const retryableRequest = method === 'GET' || method === 'DELETE' || pathname.endsWith('/access_tokens');
    for (let attempt = 1; attempt <= (retryableRequest ? 3 : 1); attempt += 1) {
      try {
        const response = await this.fetchFn(`${this.apiBase}${pathname}`, {
          ...init,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'symphony-review-approval',
            ...(init.headers ?? {})
          }
        });
        if (response.ok) {
          if (response.status === 204) return null;
          return response.json();
        }
        if (!retryableRequest || !isTransientGitHubStatus(response.status) || attempt === 3) {
          throw new Error(`review_approval_github_status:${response.status}`);
        }
      } catch (error) {
        if (!retryableRequest || attempt === 3 || (error instanceof Error && error.message.startsWith('review_approval_github_status:'))) {
          throw error;
        }
      }
      await retryDelay(attempt);
    }
    throw new Error(REASON_CODES.reviewApprovalGithubFailed);
  }

  async identity(): Promise<GitHubAppIdentity> {
    const app = asRecord(await this.appRequest('/app', this.jwt()));
    const slug = typeof app.slug === 'string' ? app.slug : '';
    if (!slug) throw new Error('review_approval_app_identity_missing');
    return {
      slug,
      login: `${slug}[bot]`,
      app_id: this.options.appId,
      installation_id: this.options.installationId
    };
  }

  async operatorLogin(): Promise<string> {
    const user = asRecord(await this.operatorClient.request('/user'));
    if (typeof user.login !== 'string' || !user.login) throw new Error('review_approval_operator_identity_missing');
    return user.login;
  }

  async separatedIdentity(): Promise<GitHubAppIdentity> {
    const identity = await this.identity();
    const operatorLogin = await this.operatorLogin();
    if (operatorLogin.toLowerCase().replace(/\[bot\]$/, '') === identity.slug.toLowerCase()) {
      throw new Error('review_approval_identity_not_separated');
    }
    return identity;
  }

  async approve(repository: string, prNumber: number, headSha: string): Promise<GitHubApprovalResult> {
    const identity = await this.separatedIdentity();
    const [owner, repo] = repository.split('/');
    if (!owner || !repo) throw new Error('review_approval_repository_invalid');
    const reviewPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews`;
    const reviews = await this.operatorClient.fetchReviews(repository, prNumber);
    const matching = reviews.find((review) => {
      const user = review.user && typeof review.user === 'object' ? review.user as Record<string, unknown> : {};
      return String(user.login ?? '').toLowerCase() === identity.login.toLowerCase()
        && review.state === 'APPROVED'
        && review.commit_id === headSha;
    });
    if (matching && typeof matching.id === 'number') {
      return { identity, review_id: matching.id, reused: true };
    }

    const tokenPayload = asRecord(await this.appRequest(
      `/app/installations/${encodeURIComponent(this.options.installationId)}/access_tokens`,
      this.jwt(),
      {
        method: 'POST',
        body: JSON.stringify({ repositories: [repo], permissions: { pull_requests: 'write', contents: 'read' } }),
        headers: { 'Content-Type': 'application/json' }
      }
    ));
    const installationToken = typeof tokenPayload.token === 'string' ? tokenPayload.token : '';
    if (!installationToken) throw new Error('review_approval_installation_token_missing');
    let reviewId: number | null = null;
    try {
      const repositories = asRecord(await this.appRequest('/installation/repositories?per_page=100', installationToken));
      const installed = Array.isArray(repositories.repositories) ? repositories.repositories.map(asRecord) : [];
      if (!installed.some((entry) => entry.full_name === repository)) throw new Error('review_approval_repository_not_installed');
      try {
        const created = asRecord(await this.appRequest(reviewPath, installationToken, {
          method: 'POST',
          body: JSON.stringify({ event: 'APPROVE', commit_id: headSha }),
          headers: { 'Content-Type': 'application/json' }
        }));
        reviewId = typeof created.id === 'number' ? created.id : null;
      } catch (error) {
        const recovery = await this.operatorClient.fetchReviews(repository, prNumber);
        const recovered = recovery.find((review) => {
          const user = review.user && typeof review.user === 'object' ? review.user as Record<string, unknown> : {};
          return String(user.login ?? '').toLowerCase() === identity.login.toLowerCase()
            && review.state === 'APPROVED'
            && review.commit_id === headSha;
        });
        if (!recovered || typeof recovered.id !== 'number') throw error;
        reviewId = recovered.id;
      }
      const readback = await this.operatorClient.fetchReviews(repository, prNumber);
      const confirmed = readback.find((review) => {
        const user = review.user && typeof review.user === 'object' ? review.user as Record<string, unknown> : {};
        return String(user.login ?? '').toLowerCase() === identity.login.toLowerCase()
          && review.state === 'APPROVED'
          && review.commit_id === headSha;
      });
      if (!confirmed || typeof confirmed.id !== 'number') throw new Error(REASON_CODES.reviewApprovalReadbackFailed);
      reviewId = confirmed.id;
      const snapshot = await this.operatorClient.fetchSnapshot(repository, prNumber, identity.login);
      if (snapshot.head_sha !== headSha || snapshot.review_decision !== 'APPROVED') {
        throw new Error('review_approval_effective_decision_missing');
      }
      return { identity, review_id: reviewId, reused: false };
    } finally {
      await this.appRequest('/installation/token', installationToken, { method: 'DELETE' }).catch(() => undefined);
    }
  }

  async probe(repository: string): Promise<GitHubAppProbeResult> {
    const identity = await this.identity();
    const operatorLogin = await this.operatorLogin();
    if (operatorLogin.toLowerCase().replace(/\[bot\]$/, '') === identity.slug.toLowerCase()) {
      throw new Error('review_approval_identity_not_separated');
    }
    const [, repo] = repository.split('/');
    if (!repo) throw new Error('review_approval_repository_invalid');
    const key = loadReviewerPrivateKey(this.options);
    const payload = asRecord(await this.appRequest(
      `/app/installations/${encodeURIComponent(this.options.installationId)}/access_tokens`,
      this.jwt(),
      {
        method: 'POST',
        body: JSON.stringify({ repositories: [repo], permissions: { pull_requests: 'write', contents: 'read' } }),
        headers: { 'Content-Type': 'application/json' }
      }
    ));
    const installationToken = typeof payload.token === 'string' ? payload.token : '';
    if (!installationToken) throw new Error('review_approval_installation_token_missing');
    try {
      const repositories = asRecord(await this.appRequest('/installation/repositories?per_page=100', installationToken));
      const installed = Array.isArray(repositories.repositories) ? repositories.repositories.map(asRecord) : [];
      if (!installed.some((entry) => entry.full_name === repository)) throw new Error('review_approval_repository_not_installed');
      const permissions = payload.permissions && typeof payload.permissions === 'object' && !Array.isArray(payload.permissions)
        ? payload.permissions as Record<string, string>
        : {};
      if (permissions.pull_requests !== 'write' || !['read', 'write'].includes(permissions.contents ?? '')) {
        throw new Error('review_approval_permissions_insufficient');
      }
      return {
        identity,
        operator_login: operatorLogin,
        repository,
        permissions,
        inline_key: key.inline,
        key_path: key.path
      };
    } finally {
      await this.appRequest('/installation/token', installationToken, { method: 'DELETE' }).catch(() => undefined);
    }
  }
}
