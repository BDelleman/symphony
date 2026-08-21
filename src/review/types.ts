export type ReviewRoute = 'merging' | 'human_review' | 'in_progress' | 'rework';
export type ReviewVerdict = 'pass' | 'blocked' | 'reset';

export interface ReviewReceiptV2 {
  version: 2;
  issue_id: string;
  issue_version: number | null;
  repository: string;
  pr_number: number;
  base_ref: string;
  base_sha: string;
  head_sha: string;
  verdict: ReviewVerdict;
  route: ReviewRoute;
  symphony_attempt_id: string;
  review_artifact_sha256: string;
  github_context_sha256: string;
  created_at: string;
}

export interface AgentReviewOutcome {
  version: 1;
  issue_id: string;
  pr_number: number;
  base_sha: string;
  head_sha: string;
  verdict: ReviewVerdict;
  route: ReviewRoute;
  symphony_attempt_id: string;
  review_receipt_sha256: string;
  review_artifact_sha256: string;
}

export interface ReviewApprovalResult {
  ok: boolean;
  route?: ReviewRoute;
  state?: string;
  reason_code?: string;
  detail?: string;
}
