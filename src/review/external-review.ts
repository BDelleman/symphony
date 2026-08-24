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
  // A list because a reviewer declines in more than one voice: a usage ceiling
  // and a credit ceiling do not share a phrase. One pattern per accepted form,
  // and the configured list is the definition of "declined" — nothing else is.
  unavailable_patterns: string[];
}

export interface ExternalReviewEvidence {
  requested_at: string | null;
  answered_at: string | null;
  unavailable_at: string | null;
  // When the current head first became the PR head, from GitHub's own
  // timeline. Reviews name the commit they reviewed; requests and
  // unavailability notices do not, so this is the only anchor that can bind
  // them to a head. Null means the arrival could not be established.
  head_arrived_at: string | null;
}

export interface ExternalReviewReviewInput {
  login: string;
  commit_id: string;
  submitted_at: string;
}

export interface ExternalReviewCommentInput {
  login: string;
  body: string;
  created_at: string;
}

export const EXTERNAL_REVIEW_ABSENT: ExternalReviewEvidence = {
  requested_at: null,
  answered_at: null,
  unavailable_at: null,
  head_arrived_at: null
};

export const EXTERNAL_REVIEW_ENV = {
  botLogin: 'SYMPHONY_EXTERNAL_REVIEW_BOT',
  requestMarker: 'SYMPHONY_EXTERNAL_REVIEW_REQUEST_MARKER',
  unavailablePatterns: 'SYMPHONY_EXTERNAL_REVIEW_UNAVAILABLE_PATTERNS'
} as const;

export function normaliseBotLogin(value: string): string {
  return value.trim().toLowerCase().replace(/\[bot\]$/, '');
}

// The requirement is opt-in: a project without a configured reviewer bot keeps
// the previous behaviour instead of blocking on evidence it can never produce.
// Patterns cross the worker boundary as JSON so a phrase containing a comma or
// a quote cannot be split into two patterns that match nothing.
export function parseExternalReviewPatterns(raw: string | undefined): string[] {
  if (raw === undefined) return ['usage limit'];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normaliseExternalReviewPatterns(parsed.filter((entry): entry is string => typeof entry === 'string'));
  } catch {
    return [];
  }
}

export function normaliseExternalReviewPatterns(patterns: readonly string[]): string[] {
  return patterns.map((pattern) => pattern.trim().toLowerCase()).filter((pattern) => pattern.length > 0);
}

export function resolveExternalReviewPolicy(env: NodeJS.ProcessEnv): ExternalReviewPolicy {
  return {
    bot_login: normaliseBotLogin(env[EXTERNAL_REVIEW_ENV.botLogin] ?? ''),
    request_marker: (env[EXTERNAL_REVIEW_ENV.requestMarker] ?? '@codex review').trim().toLowerCase(),
    unavailable_patterns: parseExternalReviewPatterns(env[EXTERNAL_REVIEW_ENV.unavailablePatterns])
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
    [EXTERNAL_REVIEW_ENV.unavailablePatterns]: JSON.stringify(policy.unavailable_patterns)
  };
}

export function collectExternalReviewEvidence(input: {
  headSha: string;
  // Recorded as a fact, applied as a rule in externalReviewSettled: the
  // evidence stays a plain readback of GitHub, and one place decides.
  headArrivedAt: string | null;
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

  // ISO-8601 UTC from the GitHub API sorts lexicographically, so no Date
  // parsing is needed to order an answer against the request that provoked it.
  const latest = (values: readonly string[]): string | null => {
    const sorted = [...values].filter((value) => value.length > 0).sort();
    return sorted.length > 0 ? sorted[sorted.length - 1] : null;
  };

  const answeredAt = latest(input.reviews
    .filter((review) => isBot(review.login) && review.commit_id === input.headSha)
    .map((review) => review.submitted_at));

  const unavailableAt = latest(input.comments
    .filter((comment) =>
      isBot(comment.login)
      && policy.unavailable_patterns.some((pattern) => comment.body.toLowerCase().includes(pattern)))
    .map((comment) => comment.created_at));

  return {
    requested_at: requestedAt,
    answered_at: answeredAt,
    unavailable_at: unavailableAt,
    head_arrived_at: input.headArrivedAt
  };
}

// The two ways the wait can still be open, named apart so the logs can tell a
// reviewer that has not spoken from a notice that vouches for the wrong head.
export type ExternalReviewHold = 'pending' | 'stale_request';

// Silence is not availability. Only a review bound to this head, or the
// reviewer saying it will not produce one, ends the wait — and the answer has
// to be newer than the request it answers. A request posted after the last
// answer is still outstanding, so a second review may still land; treating the
// earlier answer as final there would reopen the very race this gate closes.
//
// A review names the commit it reviewed, so answered_at is head-bound by
// construction. An unavailability notice names nothing, and the bare request
// it answers names nothing either, so ordering alone lets a notice for an old
// head settle a new one: request for commit A, commits land, the reviewer
// declines — the decline postdates the request and vouches for a head nobody
// asked about. Unavailability therefore settles only when the full chain
// holds: unavailable_at >= newest requested_at >= head_arrived_at. A request
// older than the current head is evidence for a previous head, and an
// unknown arrival time proves nothing, so both hold — the gate fails closed.
export function externalReviewHold(
  evidence: ExternalReviewEvidence,
  policy: ExternalReviewPolicy
): ExternalReviewHold | null {
  if (!externalReviewRequired(policy)) return null;
  const answersRequest = (answeredAt: string | null): boolean =>
    answeredAt !== null && (evidence.requested_at === null || answeredAt >= evidence.requested_at);
  if (answersRequest(evidence.answered_at)) return null;
  if (!answersRequest(evidence.unavailable_at)) return 'pending';
  const requestBoundToHead = evidence.requested_at !== null
    && evidence.head_arrived_at !== null
    && evidence.requested_at >= evidence.head_arrived_at;
  return requestBoundToHead ? null : 'stale_request';
}

export function externalReviewSettled(
  evidence: ExternalReviewEvidence,
  policy: ExternalReviewPolicy
): boolean {
  return externalReviewHold(evidence, policy) === null;
}
