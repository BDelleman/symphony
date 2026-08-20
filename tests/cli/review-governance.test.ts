import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const reviewScript = path.join(repoRoot, 'scripts/review-with-governance.js');
const temporaryRoots: string[] = [];

type Fixture = {
  root: string;
  statePath: string;
  env: NodeJS.ProcessEnv;
  baseSha: string;
  headSha: string;
  prUrl: string;
};

function execute(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function writeState(fixture: Fixture, mutate: (state: any) => void) {
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  mutate(state);
  fs.writeFileSync(fixture.statePath, JSON.stringify(state));
}

function createFixture(change: string | Buffer = 'Document the dashboard stop command.\n'): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-review-governance-'));
  temporaryRoots.push(root);
  execute('git', ['init', '-b', 'main'], root);
  const bin = path.join(root, '.git', 'test-bin');
  fs.mkdirSync(bin);
  execute('git', ['config', 'user.email', 'test@example.com'], root);
  execute('git', ['config', 'user.name', 'Test User'], root);
  fs.writeFileSync(path.join(root, 'README.md'), 'Symphony\n');
  execute('git', ['add', 'README.md'], root);
  execute('git', ['commit', '-m', 'initial'], root);
  const baseSha = execute('git', ['rev-parse', 'HEAD'], root);
  execute('git', ['switch', '-c', 'feature/NIE-900'], root);
  fs.writeFileSync(path.join(root, Buffer.isBuffer(change) ? 'fixture.bin' : 'GUIDE.md'), change);
  execute('git', ['add', '.'], root);
  execute('git', ['commit', '-m', 'docs'], root);
  const headSha = execute('git', ['rev-parse', 'HEAD'], root);
  const prUrl = 'https://github.com/example/symphony/pull/900';
  const statePath = path.join(root, '.git', 'gh-state.json');
  const pr = {
    number: 900,
    url: prUrl,
    title: 'Document the dashboard stop command',
    body: '## Summary\nDocument the dashboard stop command.\n\n## Verification\nFast CI passed.',
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    baseRefOid: baseSha,
    headRefName: 'feature/NIE-900',
    headRefOid: headSha,
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [
      {
        name: 'Fast validation (ubuntu-latest)',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        workflowName: 'Fast CI',
        startedAt: '2026-08-19T08:00:00Z',
        completedAt: '2026-08-19T08:01:00Z'
      }
    ],
    reviews: [],
    comments: [],
    updatedAt: '2026-08-19T08:00:00Z'
  };
  fs.writeFileSync(statePath, JSON.stringify({ repository: 'example/symphony', pr, reviews: [], issueComments: [], inlineComments: [] }));
  const fakeGh = path.join(bin, 'gh');
  fs.writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE_FILE, 'utf8'));
const args = process.argv.slice(2);
const key = args[0] + ' ' + (args[1] || '');
if (state.malformed === key) { process.stdout.write('{'); process.exit(0); }
if (key === 'pr view') process.stdout.write(JSON.stringify(state.pr));
else if (key === 'repo view') process.stdout.write(JSON.stringify({ nameWithOwner: state.repository }));
else if (args[0] === 'api') {
  const endpoint = args[args.length - 1];
  const items = endpoint.includes('/reviews') ? state.reviews : endpoint.includes('/issues/') ? state.issueComments : state.inlineComments;
  process.stdout.write(JSON.stringify([items || []]));
}
else { process.stderr.write('unexpected gh call: ' + args.join(' ')); process.exit(1); }
`
  );
  fs.chmodSync(fakeGh, 0o755);
  return {
    root,
    statePath,
    baseSha,
    headSha,
    prUrl,
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE_FILE: statePath }
  };
}

function advanceRemoteMain(fixture: Fixture) {
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-review-remote-'));
  temporaryRoots.push(controlRoot);
  const remote = path.join(controlRoot, 'remote.git');
  const updater = path.join(controlRoot, 'updater');
  execute('git', ['clone', '--bare', fixture.root, remote], controlRoot);
  execute('git', ['remote', 'add', 'origin', remote], fixture.root);
  execute('git', ['clone', remote, updater], controlRoot);
  execute('git', ['config', 'user.email', 'test@example.com'], updater);
  execute('git', ['config', 'user.name', 'Test User'], updater);
  execute('git', ['switch', 'main'], updater);
  fs.writeFileSync(path.join(updater, 'BASE.md'), 'Advanced main.\n');
  execute('git', ['add', 'BASE.md'], updater);
  execute('git', ['commit', '-m', 'advance main'], updater);
  execute('git', ['push', 'origin', 'main'], updater);
  return execute('git', ['rev-parse', 'HEAD'], updater);
}

function runReview(fixture: Fixture, args: string[]) {
  return spawnSync(process.execPath, [reviewScript, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, ...fixture.env }
  });
}

function digest(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function prepare(fixture: Fixture) {
  const result = runReview(fixture, ['prepare', '--issue', 'NIE-900', '--pr', '900']);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function validDraft(fixture: Fixture) {
  return `## Agent Review

### Scope Read
- Issue: NIE-900
- PR: ${fixture.prUrl}
- Base SHA: ${fixture.baseSha}
- Head SHA: ${fixture.headSha}
- Prior findings reviewed: none

### Independent Invariants
- The requested documentation must match the checked-in command.

### Acceptance Criteria Mapping
| Criterion | Evidence | Verdict |
| --- | --- | --- |
| Document the command | GUIDE.md and complete diff | pass |

### Triggered Review Lenses
| Lens | Trigger | Evidence | Verdict |
| --- | --- | --- | --- |
| Acceptance Criteria | every implementation PR | GUIDE.md and issue scope | pass |

### Findings
- No blocking findings.
`;
}

afterEach(() => {
  while (temporaryRoots.length > 0) fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe('governed Agent Review helper', () => {
  it('prepares a complete capsule and finalizes the existing v1 receipt', () => {
    const fixture = createFixture();
    const prepared = prepare(fixture);
    expect(prepared).toMatchObject({
      status: 'prepared',
      issue_id: 'NIE-900',
      pr_number: 900,
      base_sha: fixture.baseSha,
      head_sha: fixture.headSha,
      changed_files: 1
    });
    expect(fs.readFileSync(prepared.diff_file, 'utf8')).toContain('GUIDE.md');
    const context = JSON.parse(fs.readFileSync(prepared.context_file, 'utf8'));
    expect(context.changed_files[0]).toMatchObject({ path: 'GUIDE.md', status: 'A', binary: false });
    fs.writeFileSync(prepared.draft_file, validDraft(fixture));

    const finalized = runReview(fixture, [
      'finalize',
      '--body-file',
      prepared.draft_file,
      '--route',
      'merging',
      '--issue-version',
      '12'
    ]);

    expect(finalized.status, finalized.stderr).toBe(0);
    const output = JSON.parse(finalized.stdout);
    const finalBody = fs.readFileSync(output.final_file, 'utf8');
    expect(finalBody).toContain('- Pass: route to Merging');
    expect(finalBody).toContain('"issue_version":12');
    expect(finalBody).toContain('"route":"merging"');
  });

  it.each([
    ['draft PR', 'review_pr_draft_forbidden', (fixture: Fixture) => writeState(fixture, (state) => { state.pr.isDraft = true; })],
    ['wrong base', 'review_pr_wrong_base', (fixture: Fixture) => writeState(fixture, (state) => { state.pr.baseRefName = 'develop'; })],
    ['stale head', 'review_pr_head_mismatch', (fixture: Fixture) => writeState(fixture, (state) => { state.pr.headRefOid = 'f'.repeat(40); })],
    ['pending Fast CI', 'review_required_check_not_ready', (fixture: Fixture) => writeState(fixture, (state) => { state.pr.statusCheckRollup[0].status = 'IN_PROGRESS'; state.pr.statusCheckRollup[0].conclusion = ''; })]
  ])('fails prepare for %s', (_name, errorCode, mutate) => {
    const fixture = createFixture();
    mutate(fixture);
    const result = runReview(fixture, ['prepare', '--issue', 'NIE-900', '--pr', '900']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(errorCode);
  });

  it('binds prepare to the explicit linked PR and issue branch', () => {
    const fixture = createFixture();
    let result = runReview(fixture, ['prepare', '--issue', 'NIE-900', '--pr', '901']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review_pr_identity_mismatch');

    result = runReview(fixture, ['prepare', '--issue', 'NIE-901', '--pr', '900']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review_issue_branch_mismatch');
  });

  it('uses the newest timestamped Fast CI rerun', () => {
    const fixture = createFixture();
    writeState(fixture, (state) => {
      state.pr.statusCheckRollup.unshift({
        name: 'Fast validation (ubuntu-latest)',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        workflowName: 'Fast CI',
        startedAt: '2026-08-19T07:00:00Z',
        completedAt: '2026-08-19T07:01:00Z'
      });
    });
    expect(runReview(fixture, ['prepare', '--issue', 'NIE-900', '--pr', '900']).status).toBe(0);
  });

  it('fetches an exact advanced base commit missing from a reused clone', () => {
    const fixture = createFixture();
    const advancedBase = advanceRemoteMain(fixture);
    expect(spawnSync('git', ['cat-file', '-e', `${advancedBase}^{commit}`], { cwd: fixture.root }).status).not.toBe(0);
    writeState(fixture, (state) => { state.pr.baseRefOid = advancedBase; });

    const result = runReview(fixture, ['prepare', '--issue', 'NIE-900', '--pr', '900']);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).base_sha).toBe(advancedBase);
  });

  it('fails prepare for a dirty worktree', () => {
    const fixture = createFixture();
    fs.appendFileSync(path.join(fixture.root, 'README.md'), 'dirty\n');
    const result = runReview(fixture, ['prepare', '--issue', 'NIE-900', '--pr', '900']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review_worktree_dirty');
  });

  it('fails closed on malformed GitHub JSON', () => {
    const fixture = createFixture();
    writeState(fixture, (state) => { state.malformed = 'pr view'; });
    const result = runReview(fixture, ['prepare', '--issue', 'NIE-900', '--pr', '900']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review_pr_read_failed: GitHub returned malformed JSON');
  });

  it('captures large and binary diffs without truncating the capsule', () => {
    const large = createFixture(`${'review evidence line\n'.repeat(75_000)}`);
    const largePrepared = prepare(large);
    expect(largePrepared.diff_bytes).toBeGreaterThan(1_000_000);
    expect(fs.statSync(largePrepared.diff_file).size).toBe(largePrepared.diff_bytes);

    const binary = createFixture(Buffer.from([0, 1, 2, 3, 0, 255, 4, 5]));
    const binaryPrepared = prepare(binary);
    const context = JSON.parse(fs.readFileSync(binaryPrepared.context_file, 'utf8'));
    expect(context.changed_files[0]).toMatchObject({ path: 'fixture.bin', binary: true });
    expect(fs.readFileSync(binaryPrepared.diff_file, 'utf8')).toMatch(/GIT binary patch|Binary files/);
  });

  it('normalizes complete GitHub feedback and captures PR review context', () => {
    const fixture = createFixture();
    writeState(fixture, (state) => {
      state.reviews.push({ id: 3, user: { login: 'reviewer', avatar_url: 'ignored' }, state: 'APPROVED', body: 'looks good', reactions: { total_count: 99 } });
      state.issueComments.push({ id: 2, user: { login: 'author' }, body: 'scope note', html_url: 'ignored' });
      state.inlineComments.push({ id: 1, user: { login: 'reviewer' }, body: 'line note', path: 'GUIDE.md', line: 1, diff_hunk: 'ignored' });
    });
    const prepared = prepare(fixture);
    const serialized = fs.readFileSync(prepared.context_file, 'utf8');
    const context = JSON.parse(serialized);
    expect(context.pr).toMatchObject({ title: 'Document the dashboard stop command', body: expect.stringContaining('## Summary') });
    expect(context.feedback).toMatchObject({
      reviews: [{ id: 3, author: 'reviewer', body: 'looks good' }],
      issue_comments: [{ id: 2, author: 'author', body: 'scope note' }],
      inline_comments: [{ id: 1, author: 'reviewer', body: 'line note', path: 'GUIDE.md', line: 1 }]
    });
    expect(serialized).not.toContain('avatar_url');
    expect(serialized).not.toContain('reactions');
    expect(serialized).not.toContain('diff_hunk');
  });

  it('rejects capsule tampering, including self-consistent hashes that differ from the live diff', () => {
    const fixture = createFixture();
    const prepared = prepare(fixture);
    fs.appendFileSync(prepared.diff_file, 'tampered');
    let result = runReview(fixture, ['finalize', '--body-file', prepared.draft_file, '--route', 'merging']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review_capsule_tampered');

    const consistent = createFixture();
    const consistentPrepared = prepare(consistent);
    fs.writeFileSync(consistentPrepared.draft_file, validDraft(consistent));
    const changedPatch = `${fs.readFileSync(consistentPrepared.diff_file, 'utf8')}tampered`;
    fs.writeFileSync(consistentPrepared.diff_file, changedPatch);
    const context = JSON.parse(fs.readFileSync(consistentPrepared.context_file, 'utf8'));
    context.diff.bytes = Buffer.byteLength(changedPatch);
    context.diff.sha256 = digest(changedPatch);
    const serialized = `${JSON.stringify(context, null, 2)}\n`;
    fs.writeFileSync(consistentPrepared.context_file, serialized);
    fs.writeFileSync(path.join(path.dirname(consistentPrepared.context_file), 'context.sha256'), `${digest(serialized)}\n`);
    result = runReview(consistent, ['finalize', '--body-file', consistentPrepared.draft_file, '--route', 'merging']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review_capsule_live_diff_mismatch');
  });

  it('retains a stale same-head draft only as reference when feedback changes', () => {
    const fresh = createFixture();
    const freshPrepared = prepare(fresh);
    const draft = validDraft(fresh);
    fs.writeFileSync(freshPrepared.draft_file, draft);
    const unchanged = prepare(fresh);
    expect(unchanged.draft_preserved).toBe(true);
    expect(fs.readFileSync(unchanged.draft_file, 'utf8')).toBe(draft);
    writeState(fresh, (state) => { state.inlineComments.push({ id: 1, body: 'new finding' }); });
    let result = runReview(fresh, ['finalize', '--body-file', unchanged.draft_file, '--route', 'merging']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review_pr_feedback_changed');

    const refreshed = prepare(fresh);
    expect(refreshed.draft_preserved).toBe(false);
    expect(refreshed.refresh_required).toBe(true);
    expect(fs.readFileSync(refreshed.previous_draft_file, 'utf8')).toBe(draft);
    expect(fs.readFileSync(refreshed.draft_file, 'utf8')).toContain('<!-- summarize relevant feedback from context.json -->');
    fs.writeFileSync(
      refreshed.draft_file,
      draft.replace('Prior findings reviewed: none', 'Prior findings reviewed: inline comment 1')
    );
    result = runReview(fresh, ['finalize', '--body-file', refreshed.draft_file, '--route', 'merging']);
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects PR body and review-decision drift after prepare', () => {
    const bodyDrift = createFixture();
    const bodyPrepared = prepare(bodyDrift);
    fs.writeFileSync(bodyPrepared.draft_file, validDraft(bodyDrift));
    writeState(bodyDrift, (state) => { state.pr.body = `${state.pr.body}\nChanged after review.`; });
    let result = runReview(bodyDrift, ['finalize', '--body-file', bodyPrepared.draft_file, '--route', 'merging']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review_pr_identity_changed');

    const decisionDrift = createFixture();
    const decisionPrepared = prepare(decisionDrift);
    fs.writeFileSync(decisionPrepared.draft_file, validDraft(decisionDrift));
    writeState(decisionDrift, (state) => { state.pr.reviewDecision = 'CHANGES_REQUESTED'; });
    result = runReview(decisionDrift, ['finalize', '--body-file', decisionPrepared.draft_file, '--route', 'merging']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review_pr_feedback_changed');
  });

  it.each([
    ['keeps generated sections out of drafts', (body: string) => `${body}\n### Verdict\n- Pass: route to Merging\n`, 'review_body_has_generated_sections'],
    ['rejects unfinished placeholders', (body: string) => body.replace('Document the command', '<!-- criterion -->'), 'review_body_incomplete'],
    ['rejects route and finding mismatch', (body: string) => body, 'review_artifact_check_failed']
  ])('%s', (_name, transform, errorCode) => {
    const fixture = createFixture();
    const prepared = prepare(fixture);
    fs.writeFileSync(prepared.draft_file, transform(validDraft(fixture)));
    const route = errorCode === 'review_artifact_check_failed' ? 'in_progress' : 'merging';
    const result = runReview(fixture, ['finalize', '--body-file', prepared.draft_file, '--route', route]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(errorCode);
  });

  it('allows legitimate HTML comments in completed evidence', () => {
    const fixture = createFixture();
    const prepared = prepare(fixture);
    fs.writeFileSync(prepared.draft_file, validDraft(fixture).replace('GUIDE.md and complete diff', 'GUIDE.md <!-- evidence --> and complete diff'));
    const result = runReview(fixture, ['finalize', '--body-file', prepared.draft_file, '--route', 'merging']);
    expect(result.status, result.stderr).toBe(0);
  });
});
