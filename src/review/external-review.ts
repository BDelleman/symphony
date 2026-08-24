// An external reviewer (Codex, a second App, a human bot) answers on its own
// clock, and nothing it posts is a check run, so `checks_settled` cannot see
// it. Approving on "no unresolved threads" alone therefore approves whatever
// the reviewer has not said yet: the threads that matter do not exist at the
// moment the gate looks. These helpers supply the missing liveness half —
// evidence that the configured reviewer has already spoken about this exact
// head, or has explicitly declined to.

export interface ExternalReviewPolicy {
  bot_login: string;
  request_marker: string;
  unavailable_pattern: string;
}

export interface ExternalReviewEvidence {
  requested_at: string | null;
  answered_for_head: boolean;
  unavailable_at: string | null;
}

export interface ExternalReviewReviewInput {
  login: string;
  commit_id: string;
}

export interface ExternalReviewCommentInput {
  login: string;
  body: string;
  created_at: string;
}

export const EXTERNAL_REVIEW_ABSENT: ExternalReviewEvidence = {
  requested_at: null,
  answered_for_head: false,
  unavailable_at: null
};

export const EXTERNAL_REVIEW_ENV = {
  botLogin: 'SYMPHONY_EXTERNAL_REVIEW_BOT',
  requestMarker: 'SYMPHONY_EXTERNAL_REVIEW_REQUEST_MARKER',
  unavailablePattern: 'SYMPHONY_EXTERNAL_REVIEW_UNAVAILABLE_PATTERN'
} as const;

export function normaliseBotLogin(value: string): string {
  return value.trim().toLowerCase().replace(/\[bot\]$/, '');
}

// The requirement is opt-in: a project without a configured reviewer bot keeps
// the previous behaviour instead of blocking on evidence it can never produce.
export function resolveExternalReviewPolicy(env: NodeJS.ProcessEnv): ExternalReviewPolicy {
  return {
    bot_login: normaliseBotLogin(env[EXTERNAL_REVIEW_ENV.botLogin] ?? ''),
    request_marker: (env[EXTERNAL_REVIEW_ENV.requestMarker] ?? '@codex review').trim().toLowerCase(),
    unavailable_pattern: (env[EXTERNAL_REVIEW_ENV.unavailablePattern] ?? 'usage limits').trim().toLowerCase()
  };
}

export function externalReviewRequired(policy: ExternalReviewPolicy): boolean {
  return policy.bot_login.length > 0;
}

// `symphony review finalize` runs inside the worker, whose environment is an
// allowlist rather than an inherited copy, so the policy has to be handed
// across the boundary the same way the attempt id and base ref are.
export function externalReviewEnvironment(
  policy: ExternalReviewPolicy | undefined
): Record<string, string> {
  if (!policy || !externalReviewRequired(policy)) return {};
  return {
    [EXTERNAL_REVIEW_ENV.botLogin]: policy.bot_login,
    [EXTERNAL_REVIEW_ENV.requestMarker]: policy.request_marker,
    [EXTERNAL_REVIEW_ENV.unavailablePattern]: policy.unavailable_pattern
  };
}

export function collectExternalReviewEvidence(input: {
  headSha: string;
  policy: ExternalReviewPolicy;
  reviews: readonly ExternalReviewReviewInput[];
  comments: readonly ExternalReviewCommentInput[];
}): ExternalReviewEvidence {
  const { policy } = input;
  if (!externalReviewRequired(policy)) return { ...EXTERNAL_REVIEW_ABSENT };

  const bot = policy.bot_login;
  const isBot = (login: string): boolean => normaliseBotLogin(login) === bot;

  // Only a request the reviewer did not write itself starts the clock, so a bot
  // quoting the marker back cannot backdate its own unavailability notice.
  const requests = input.comments
    .filter((comment) => !isBot(comment.login) && comment.body.toLowerCase().includes(policy.request_marker))
    .map((comment) => comment.created_at)
    .filter((createdAt) => createdAt.length > 0)
    .sort();
  const requestedAt = requests.length > 0 ? requests[requests.length - 1] : null;

  const answeredForHead = input.reviews.some(
    (review) => isBot(review.login) && review.commit_id === input.headSha
  );

  // ISO-8601 UTC from the GitHub API sorts lexicographically, so no Date
  // parsing is needed to order a notice against the request that provoked it.
  const unavailable = input.comments
    .filter((comment) =>
      isBot(comment.login)
      && policy.unavailable_pattern.length > 0
      && comment.body.toLowerCase().includes(policy.unavailable_pattern)
      && (requestedAt === null || comment.created_at >= requestedAt))
    .map((comment) => comment.created_at)
    .filter((createdAt) => createdAt.length > 0)
    .sort();

  return {
    requested_at: requestedAt,
    answered_for_head: answeredForHead,
    unavailable_at: unavailable.length > 0 ? unavailable[unavailable.length - 1] : null
  };
}

// Silence is not availability. Only a review bound to this head, or the
// reviewer saying it will not produce one, ends the wait.
export function externalReviewSettled(
  evidence: ExternalReviewEvidence,
  policy: ExternalReviewPolicy
): boolean {
  if (!externalReviewRequired(policy)) return true;
  return evidence.answered_for_head || evidence.unavailable_at !== null;
}
