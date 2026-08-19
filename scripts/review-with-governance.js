#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FAST_CHECK_NAME = 'Fast validation (ubuntu-latest)';
const DRAFT_PLACEHOLDERS = [
  'summarize relevant feedback from context.json',
  'list the issue-specific invariant',
  'criterion',
  'concrete evidence',
  'pass or finding',
  'triggered lens',
  'changed semantic',
  'P1/P2 finding or No blocking findings.'
];
const ROUTES = {
  merging: { verdict: 'pass', text: 'Pass: route to Merging' },
  human_review: { verdict: 'pass', text: 'Pass: route to Human Review' },
  in_progress: { verdict: 'blocked', text: 'Blocked: move to In Progress' },
  rework: { verdict: 'reset', text: 'Reset required: move to Rework' }
};

function fail(code, detail) {
  process.stderr.write(`${code}${detail ? `: ${detail}` : ''}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const operation = argv[0] || '';
  const parsed = { operation, issue: '', prNumber: null, bodyFile: '', route: '', issueVersion: null };
  if (!['prepare', 'finalize'].includes(operation)) {
    fail('review_governance_invalid_args', 'expected prepare or finalize');
  }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--issue' && value) parsed.issue = value;
    else if (arg === '--pr' && value) {
      if (!/^\d+$/.test(value) || Number(value) < 1) fail('review_governance_invalid_args', '--pr must be a positive integer');
      parsed.prNumber = Number(value);
    }
    else if (arg === '--body-file' && value) parsed.bodyFile = value;
    else if (arg === '--route' && value) parsed.route = value;
    else if (arg === '--issue-version' && value) {
      if (!/^\d+$/.test(value)) fail('review_governance_invalid_args', '--issue-version must be an integer');
      parsed.issueVersion = Number(value);
    } else fail('review_governance_invalid_args', `unsupported argument ${arg}`);
    index += 1;
  }
  if (operation === 'prepare' && !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(parsed.issue)) {
    fail('review_governance_invalid_args', '--issue must be a Linear identifier such as NIE-123');
  }
  if (operation === 'prepare' && !parsed.prNumber) {
    fail('review_governance_invalid_args', '--pr is required');
  }
  if (operation === 'finalize') {
    if (!parsed.bodyFile) fail('review_governance_invalid_args', '--body-file is required');
    if (!ROUTES[parsed.route]) fail('review_governance_invalid_args', '--route is invalid');
  }
  return parsed;
}

function run(command, args, code) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    maxBuffer: 512 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    fail(code, detail);
  }
  return String(result.stdout || '');
}

function git(args, code) {
  return run('git', args, code).trim();
}

function ghJson(args, code) {
  const output = run('gh', args, code).trim();
  try {
    return JSON.parse(output || 'null');
  } catch {
    fail(code, 'GitHub returned malformed JSON');
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function atomicWrite(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(target), 0o700);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

function assertCleanWorktree() {
  if (git(['status', '--porcelain'], 'review_worktree_status_failed')) {
    fail('review_worktree_dirty', 'commit or remove worktree changes before review');
  }
}

function currentIdentity() {
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], 'review_detached_head');
  const headSha = git(['rev-parse', 'HEAD'], 'review_head_unavailable');
  return { branch, headSha };
}

const PR_FIELDS = [
  'number',
  'url',
  'title',
  'body',
  'state',
  'isDraft',
  'baseRefName',
  'baseRefOid',
  'headRefName',
  'headRefOid',
  'mergeStateStatus',
  'reviewDecision',
  'statusCheckRollup',
  'updatedAt'
].join(',');

function loadPr(number) {
  return ghJson(['pr', 'view', String(number), '--json', PR_FIELDS], 'review_pr_read_failed');
}

function repoName() {
  const result = ghJson(['repo', 'view', '--json', 'nameWithOwner'], 'review_repo_read_failed');
  if (!result?.nameWithOwner) fail('review_repo_read_failed', 'missing nameWithOwner');
  return result.nameWithOwner;
}

function loadPagedApi(repository, endpoint, code) {
  const pages = ghJson(
    ['api', '--paginate', '--slurp', `repos/${repository}/${endpoint}`],
    code
  );
  return Array.isArray(pages) ? pages.flat() : [];
}

function authorLogin(item) {
  return item?.user?.login || item?.author?.login || null;
}

function sortByStableId(items) {
  return items.sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function loadFeedback(repository, number) {
  const reviews = loadPagedApi(repository, `pulls/${number}/reviews`, 'review_pr_reviews_failed').map((review) => ({
    id: review.id,
    author: authorLogin(review),
    state: review.state || null,
    body: review.body || '',
    commit_sha: review.commit_id || null,
    submitted_at: review.submitted_at || null
  }));
  const issueComments = loadPagedApi(repository, `issues/${number}/comments`, 'review_pr_comments_failed').map((comment) => ({
    id: comment.id,
    author: authorLogin(comment),
    body: comment.body || '',
    created_at: comment.created_at || null,
    updated_at: comment.updated_at || null
  }));
  const inlineComments = loadPagedApi(repository, `pulls/${number}/comments`, 'review_pr_inline_comments_failed').map((comment) => ({
    id: comment.id,
    author: authorLogin(comment),
    body: comment.body || '',
    path: comment.path || null,
    line: comment.line ?? comment.original_line ?? null,
    side: comment.side || null,
    commit_sha: comment.commit_id || null,
    reply_to_id: comment.in_reply_to_id || null,
    created_at: comment.created_at || null,
    updated_at: comment.updated_at || null
  }));
  return {
    reviews: sortByStableId(reviews),
    issue_comments: sortByStableId(issueComments),
    inline_comments: sortByStableId(inlineComments)
  };
}

function checkSummary(check) {
  return {
    name: check?.name || check?.context || '',
    status: String(check?.status || check?.state || '').toUpperCase(),
    conclusion: String(check?.conclusion || '').toUpperCase(),
    workflow_name: check?.workflowName || '',
    started_at: check?.startedAt || null,
    completed_at: check?.completedAt || null
  };
}

function checkTimestamp(check) {
  const value = check.completed_at || check.started_at;
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function assertReadyPr(pr, identity) {
  if (!pr || pr.state !== 'OPEN') fail('review_pr_not_open');
  if (pr.isDraft) fail('review_pr_draft_forbidden', `pr=${pr.number}`);
  if (pr.baseRefName !== 'main') fail('review_pr_wrong_base', `expected=main:actual=${pr.baseRefName || '<missing>'}`);
  if (pr.headRefName !== identity.branch) {
    fail('review_pr_branch_mismatch', `expected=${identity.branch}:actual=${pr.headRefName || '<missing>'}`);
  }
  if (pr.headRefOid !== identity.headSha) {
    fail('review_pr_head_mismatch', `expected=${identity.headSha}:actual=${pr.headRefOid || '<missing>'}`);
  }
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup.map(checkSummary) : [];
  const fast = checks.filter((check) => check.name === FAST_CHECK_NAME);
  if (fast.length > 1 && fast.some((check) => checkTimestamp(check) === null)) {
    fail('review_required_check_ambiguous', `${FAST_CHECK_NAME} has duplicate runs without timestamps`);
  }
  const latestFast = fast.reduce((latest, candidate) => {
    if (!latest) return candidate;
    return checkTimestamp(candidate) > checkTimestamp(latest) ? candidate : latest;
  }, null);
  if (!latestFast || latestFast.status !== 'COMPLETED' || latestFast.conclusion !== 'SUCCESS') {
    fail('review_required_check_not_ready', `${FAST_CHECK_NAME} must be completed successfully`);
  }
  return checks;
}

function parseNameStatus(raw) {
  const tokens = raw.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const entries = [];
  for (let index = 0; index < tokens.length;) {
    let status = tokens[index++];
    let firstPath = '';
    if (status.includes('\t')) {
      const split = status.indexOf('\t');
      firstPath = status.slice(split + 1);
      status = status.slice(0, split);
    } else {
      firstPath = tokens[index++] || '';
    }
    if (!status || !firstPath) fail('review_diff_manifest_invalid', 'malformed name-status output');
    if (/^[RC]/.test(status)) {
      const secondPath = tokens[index++] || '';
      if (!secondPath) fail('review_diff_manifest_invalid', 'rename/copy destination missing');
      entries.push({ status, old_path: firstPath, path: secondPath });
    } else {
      entries.push({ status, path: firstPath });
    }
  }
  return entries;
}

function parseNumstat(raw) {
  const tokens = raw.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const stats = new Map();
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index++];
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(token);
    if (!match) fail('review_diff_numstat_invalid', 'malformed numstat output');
    let filePath = match[3];
    if (!filePath) {
      index += 1;
      filePath = tokens[index++] || '';
    }
    if (!filePath) fail('review_diff_numstat_invalid', 'path missing');
    stats.set(filePath, {
      additions: match[1] === '-' ? null : Number(match[1]),
      deletions: match[2] === '-' ? null : Number(match[2]),
      binary: match[1] === '-' || match[2] === '-'
    });
  }
  return stats;
}

function gitObjectExists(revision) {
  const result = spawnSync('git', ['cat-file', '-e', `${revision}^{commit}`], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: process.env
  });
  return result.status === 0;
}

function buildDiff(baseSha, headSha) {
  if (!gitObjectExists(baseSha)) {
    run('git', ['fetch', '--no-tags', 'origin', baseSha], 'review_base_fetch_failed');
  }
  if (!gitObjectExists(baseSha)) fail('review_base_commit_unavailable', baseSha);
  const range = `${baseSha}...${headSha}`;
  const names = run('git', ['diff', '--name-status', '-z', '--find-renames', range], 'review_diff_manifest_failed');
  const numstat = run('git', ['diff', '--numstat', '-z', '--find-renames', range], 'review_diff_numstat_failed');
  const stats = parseNumstat(numstat);
  const manifest = parseNameStatus(names).map((entry) => ({
    ...entry,
    ...(stats.get(entry.path) || { additions: null, deletions: null, binary: null })
  }));
  const patch = run('git', ['diff', '--binary', '--full-index', '--find-renames', range], 'review_diff_failed');
  return { manifest, patch };
}

function capsuleDirectory(headSha) {
  const gitPath = git(['rev-parse', '--git-path', `symphony-review/${headSha}`], 'review_capsule_path_failed');
  return path.resolve(process.cwd(), gitPath);
}

function feedbackFrom(pr, feedback) {
  return {
    pr_updated_at: pr.updatedAt || null,
    review_decision: pr.reviewDecision || null,
    reviews: feedback.reviews,
    issue_comments: feedback.issue_comments,
    inline_comments: feedback.inline_comments
  };
}

function feedbackForHash(feedback) {
  return {
    review_decision: feedback.review_decision,
    reviews: feedback.reviews,
    issue_comments: feedback.issue_comments,
    inline_comments: feedback.inline_comments
  };
}

function draftTemplate(context) {
  return `## Agent Review

### Scope Read
- Issue: ${context.issue_id}
- PR: ${context.pr.url}
- Base SHA: ${context.pr.base_sha}
- Head SHA: ${context.pr.head_sha}
- Prior findings reviewed: <!-- summarize relevant feedback from context.json -->

### Independent Invariants
- <!-- list the issue-specific invariant -->

### Acceptance Criteria Mapping
| Criterion | Evidence | Verdict |
| --- | --- | --- |
| <!-- criterion --> | <!-- concrete evidence --> | <!-- pass or finding --> |

### Triggered Review Lenses
| Lens | Trigger | Evidence | Verdict |
| --- | --- | --- | --- |
| <!-- triggered lens --> | <!-- changed semantic --> | <!-- concrete evidence --> | <!-- pass or finding --> |

### Findings
- <!-- P1/P2 finding or No blocking findings. -->
`;
}

function hasDraftPlaceholders(body) {
  return DRAFT_PLACEHOLDERS.some((placeholder) => body.includes(`<!-- ${placeholder} -->`));
}

function priorDraft(directory, expected) {
  try {
    const priorContext = JSON.parse(fs.readFileSync(path.join(directory, 'context.json'), 'utf8'));
    if (
      priorContext.issue_id !== expected.issueId ||
      priorContext.pr?.number !== expected.prNumber ||
      priorContext.pr?.head_sha !== expected.headSha
    ) {
      return null;
    }
    const existing = fs.readFileSync(path.join(directory, 'draft.md'), 'utf8');
    if (hasDraftPlaceholders(existing) || /^### (Verdict|Review Receipt)\s*$/m.test(existing)) return null;
    return {
      body: existing,
      reusable:
        priorContext.pr?.base_sha === expected.baseSha &&
        priorContext.pr?.title === expected.title &&
        priorContext.pr?.body === expected.body &&
        priorContext.feedback_sha256 === expected.feedbackSha &&
        priorContext.diff?.sha256 === expected.diffSha &&
        stableJson(priorContext.changed_files) === stableJson(expected.manifest)
    };
  } catch {
    return null;
  }
}

function prepare(parsed) {
  const startedAt = Date.now();
  assertCleanWorktree();
  const identity = currentIdentity();
  const expectedBranch = `feature/${parsed.issue.toUpperCase()}`;
  if (identity.branch !== expectedBranch) {
    fail('review_issue_branch_mismatch', `expected=${expectedBranch}:actual=${identity.branch}`);
  }
  const pr = loadPr(parsed.prNumber);
  if (pr?.number !== parsed.prNumber) fail('review_pr_identity_mismatch', `expected=${parsed.prNumber}`);
  const checks = assertReadyPr(pr, identity);
  const repository = repoName();
  const feedback = feedbackFrom(pr, loadFeedback(repository, pr.number));
  const { manifest, patch } = buildDiff(pr.baseRefOid, pr.headRefOid);
  const directory = capsuleDirectory(identity.headSha);
  const feedbackSha = sha256(stableJson(feedbackForHash(feedback)));
  const previousDraft = priorDraft(directory, {
    issueId: parsed.issue.toUpperCase(),
    prNumber: pr.number,
    baseSha: pr.baseRefOid,
    headSha: pr.headRefOid,
    title: pr.title || '',
    body: pr.body || '',
    feedbackSha,
    diffSha: sha256(patch),
    manifest
  });
  const context = {
    version: 1,
    prepared_at: new Date().toISOString(),
    issue_id: parsed.issue.toUpperCase(),
    repository,
    branch: identity.branch,
    pr: {
      number: pr.number,
      url: pr.url,
      title: pr.title || '',
      body: pr.body || '',
      base_ref: pr.baseRefName,
      base_sha: pr.baseRefOid,
      head_ref: pr.headRefName,
      head_sha: pr.headRefOid,
      merge_state: pr.mergeStateStatus || null,
      review_decision: pr.reviewDecision || null
    },
    checks,
    changed_files: manifest,
    feedback,
    diff: {
      file: 'diff.patch',
      bytes: Buffer.byteLength(patch),
      sha256: sha256(patch)
    },
    feedback_sha256: feedbackSha
  };
  const serializedContext = `${JSON.stringify(context, null, 2)}\n`;
  atomicWrite(path.join(directory, 'diff.patch'), patch);
  atomicWrite(path.join(directory, 'context.json'), serializedContext);
  atomicWrite(path.join(directory, 'context.sha256'), `${sha256(serializedContext)}\n`);
  if (previousDraft && !previousDraft.reusable) {
    atomicWrite(path.join(directory, 'draft.previous.md'), previousDraft.body);
  }
  atomicWrite(path.join(directory, 'draft.md'), previousDraft?.reusable ? previousDraft.body : draftTemplate(context));
  process.stdout.write(`${JSON.stringify({
    status: 'prepared',
    issue_id: context.issue_id,
    pr_number: pr.number,
    base_sha: pr.baseRefOid,
    head_sha: pr.headRefOid,
    changed_files: manifest.length,
    draft_preserved: Boolean(previousDraft?.reusable),
    refresh_required: Boolean(previousDraft && !previousDraft.reusable),
    previous_draft_file: previousDraft && !previousDraft.reusable ? path.join(directory, 'draft.previous.md') : null,
    diff_bytes: context.diff.bytes,
    diff_sha256: context.diff.sha256,
    context_file: path.join(directory, 'context.json'),
    diff_file: path.join(directory, 'diff.patch'),
    draft_file: path.join(directory, 'draft.md'),
    duration_ms: Date.now() - startedAt
  })}\n`);
}

function readCapsule(headSha) {
  const directory = capsuleDirectory(headSha);
  const contextPath = path.join(directory, 'context.json');
  const contextHashPath = path.join(directory, 'context.sha256');
  let serialized;
  let expectedHash;
  let context;
  try {
    serialized = fs.readFileSync(contextPath, 'utf8');
    expectedHash = fs.readFileSync(contextHashPath, 'utf8').trim();
    context = JSON.parse(serialized);
  } catch (error) {
    fail('review_capsule_missing_or_invalid', error.message);
  }
  if (sha256(serialized) !== expectedHash) fail('review_capsule_tampered', 'context hash mismatch');
  if (context.diff?.file !== 'diff.patch') fail('review_capsule_tampered', 'unexpected diff path');
  const diffPath = path.join(directory, context.diff?.file || '');
  let patch;
  try {
    patch = fs.readFileSync(diffPath, 'utf8');
  } catch (error) {
    fail('review_capsule_missing_or_invalid', error.message);
  }
  if (Buffer.byteLength(patch) !== context.diff?.bytes || sha256(patch) !== context.diff?.sha256) {
    fail('review_capsule_tampered', 'diff hash mismatch');
  }
  return { directory, context };
}

function assertBodyInCapsule(bodyFile, directory) {
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(process.cwd(), bodyFile));
  } catch (error) {
    fail('review_body_missing', error.message);
  }
  const capsuleRoot = fs.realpathSync(directory);
  const relative = path.relative(capsuleRoot, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('review_body_outside_capsule', resolved);
  }
  return resolved;
}

function assertNoGeneratedSections(body) {
  if (/^### (Verdict|Review Receipt)\s*$/m.test(body)) {
    fail('review_body_has_generated_sections', 'remove Verdict and Review Receipt before finalize');
  }
  if (hasDraftPlaceholders(body)) fail('review_body_incomplete', 'replace all template placeholders');
  const trimmed = body.trimEnd();
  const findingsAt = trimmed.lastIndexOf('### Findings');
  if (findingsAt < 0 || /^### /m.test(trimmed.slice(findingsAt + '### Findings'.length))) {
    fail('review_body_invalid_ending', 'draft must end after Findings');
  }
  return `${trimmed}\n`;
}

function assertFreshFeedback(context, pr, repository) {
  const feedback = feedbackFrom(pr, loadFeedback(repository, pr.number));
  const currentHash = sha256(stableJson(feedbackForHash(feedback)));
  if (currentHash !== context.feedback_sha256) {
    fail('review_pr_feedback_changed', 'rerun prepare and review the new feedback');
  }
}

function finalize(parsed) {
  const startedAt = Date.now();
  assertCleanWorktree();
  const identity = currentIdentity();
  const { directory, context } = readCapsule(identity.headSha);
  if (context.version !== 1) fail('review_capsule_version_unsupported', String(context.version));
  if (context.branch !== identity.branch || context.pr?.head_sha !== identity.headSha) {
    fail('review_capsule_identity_mismatch');
  }
  const pr = loadPr(context.pr.number);
  assertReadyPr(pr, identity);
  if (
    pr.baseRefOid !== context.pr.base_sha ||
    pr.number !== context.pr.number ||
    pr.url !== context.pr.url ||
    (pr.title || '') !== context.pr.title ||
    (pr.body || '') !== context.pr.body
  ) {
    fail('review_pr_identity_changed', 'rerun prepare');
  }
  assertFreshFeedback(context, pr, context.repository);
  const liveDiff = buildDiff(pr.baseRefOid, pr.headRefOid);
  if (
    Buffer.byteLength(liveDiff.patch) !== context.diff.bytes ||
    sha256(liveDiff.patch) !== context.diff.sha256 ||
    stableJson(liveDiff.manifest) !== stableJson(context.changed_files)
  ) {
    fail('review_capsule_live_diff_mismatch', 'rerun prepare');
  }
  const bodyPath = assertBodyInCapsule(parsed.bodyFile, directory);
  let body;
  try {
    body = assertNoGeneratedSections(fs.readFileSync(bodyPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') fail('review_body_missing', bodyPath);
    throw error;
  }
  const route = ROUTES[parsed.route];
  const receipt = {
    version: 1,
    issue_id: context.issue_id,
    pr_number: context.pr.number,
    base_sha: context.pr.base_sha,
    head_sha: context.pr.head_sha,
    issue_version: parsed.issueVersion,
    verdict: route.verdict,
    route: parsed.route,
    reviewer_attempt_id: `agent-review-${crypto.randomUUID()}`,
    created_at: new Date().toISOString()
  };
  const finalBody = `${body}\n### Verdict\n- ${route.text}\n\n### Review Receipt\n${JSON.stringify(receipt)}\n`;
  const temporary = path.join(directory, `final.${process.pid}.${crypto.randomUUID()}.tmp.md`);
  fs.writeFileSync(temporary, finalBody, { mode: 0o600 });
  const checked = spawnSync(process.execPath, [path.join(__dirname, 'check-review-artifact.js'), '--body-file', temporary], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });
  if (checked.status !== 0) {
    fs.rmSync(temporary, { force: true });
    fail('review_artifact_check_failed', String(checked.stderr || checked.stdout || '').trim());
  }
  const finalPath = path.join(directory, 'final.md');
  fs.renameSync(temporary, finalPath);
  fs.chmodSync(finalPath, 0o600);
  process.stdout.write(`${JSON.stringify({
    status: 'finalized',
    issue_id: context.issue_id,
    pr_number: context.pr.number,
    base_sha: context.pr.base_sha,
    head_sha: context.pr.head_sha,
    route: parsed.route,
    final_file: finalPath,
    final_sha256: sha256(finalBody),
    duration_ms: Date.now() - startedAt
  })}\n`);
}

try {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.operation === 'prepare') prepare(parsed);
  else finalize(parsed);
} catch (error) {
  fail('review_governance_failed', error?.message || String(error));
}
