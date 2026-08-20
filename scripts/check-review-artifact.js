#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { assertHumanReadableMarkdownBody } = require('./lib/markdown-body');

function fail(message) {
  process.stderr.write(`review_artifact_invalid: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { bodyFile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--body-file') {
      out.bodyFile = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--body-file=')) {
      out.bodyFile = arg.slice('--body-file='.length);
    } else {
      fail(`unsupported argument ${arg}`);
    }
  }
  return out;
}

function readReviewBody(argv) {
  const parsed = parseArgs(argv);
  const bodyFile = parsed.bodyFile || process.env.SYMPHONY_REVIEW_BODY_FILE || '';
  const body = process.env.SYMPHONY_REVIEW_BODY || '';
  if (bodyFile.trim()) {
    const resolved = path.resolve(process.cwd(), bodyFile.trim());
    if (!fs.existsSync(resolved)) {
      fail(`body file does not exist: ${resolved}`);
    }
    return fs.readFileSync(resolved, 'utf8');
  }
  if (body.trim()) {
    return body;
  }
  fail('provide SYMPHONY_REVIEW_BODY, SYMPHONY_REVIEW_BODY_FILE, or --body-file');
}

function sectionContent(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (start < 0) {
    return null;
  }
  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{2,3}\s+/.test(line)) {
      break;
    }
    collected.push(line);
  }
  return collected.join('\n').trim();
}

function requireSection(body, heading) {
  const content = sectionContent(body, heading);
  if (!content) {
    fail(`missing or empty section: ${heading}`);
  }
  return content;
}

function requireField(section, label) {
  const pattern = new RegExp(`^-\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.+)$`, 'mi');
  const match = section.match(pattern);
  if (!match || !match[1].trim()) {
    fail(`missing required Scope Read field: ${label}`);
  }
}

function tableRows(section) {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|') && !/^\|\s*-+/.test(line));
}

function splitRow(row) {
  return row
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function requireTableEvidence(section, heading, expectedHeaders) {
  const rows = tableRows(section);
  if (rows.length < 2) {
    fail(`${heading} must include a markdown table with at least one evidence row`);
  }
  const headers = splitRow(rows[0]).map((header) => header.toLowerCase());
  for (const expected of expectedHeaders) {
    if (!headers.includes(expected.toLowerCase())) {
      fail(`${heading} table missing header: ${expected}`);
    }
  }
  const evidenceIndex = headers.indexOf('evidence');
  const verdictIndex = headers.indexOf('verdict');
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    fail(`${heading} table must include at least one data row`);
  }
  for (const row of dataRows) {
    const cells = splitRow(row);
    const evidence = cells[evidenceIndex] || '';
    const verdict = cells[verdictIndex] || '';
    if (!evidence || /^n\/?a$/i.test(evidence) || /^-+$/.test(evidence)) {
      fail(`${heading} row is missing evidence: ${row}`);
    }
    if (!verdict || /^n\/?a$/i.test(verdict) || /^-+$/.test(verdict)) {
      fail(`${heading} row is missing verdict: ${row}`);
    }
  }
}

function requireTableRows(section, heading, expectedHeaders) {
  const rows = tableRows(section);
  if (rows.length < 2) {
    fail(`${heading} must include a markdown table with at least one evidence row`);
  }
  const headers = splitRow(rows[0]).map((header) => header.toLowerCase());
  for (const expected of expectedHeaders) {
    if (!headers.includes(expected.toLowerCase())) {
      fail(`${heading} table missing header: ${expected}`);
    }
  }
  const dataRows = rows.slice(1);
  for (const row of dataRows) {
    const cells = splitRow(row);
    for (let index = 0; index < expectedHeaders.length; index += 1) {
      const expected = expectedHeaders[index];
      const actualIndex = headers.indexOf(expected.toLowerCase());
      const value = cells[actualIndex] || '';
      if (!value || /^-+$/.test(value)) {
        fail(`${heading} row is missing ${expected}: ${row}`);
      }
    }
  }
  return { headers, dataRows };
}

function requireFlag(section, label) {
  const pattern = new RegExp(`^-\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*:?`, 'i');
  const line = section.split(/\r?\n/).find((candidate) => pattern.test(candidate));
  if (!line) {
    fail(`Invalid Evidence Check missing required field: ${label}`);
  }
  const value = line.replace(pattern, '').trim();
  if (!value) {
    fail(`Invalid Evidence Check missing required field: ${label}`);
  }
  return value;
}

function isBlockedVerdict(verdict) {
  return /(Blocked: move to In Progress|Reset required: move to Rework)/.test(verdict);
}

function scopeField(scope, label) {
  const pattern = new RegExp(`^-\\s*${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*:\\s*(.+)$`, 'mi');
  return pattern.exec(scope)?.[1]?.trim() || '';
}

function validateReviewReceipt(body, scope, verdict) {
  const section = requireSection(body, 'Review Receipt');
  const jsonText = section
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let receipt;
  try {
    receipt = JSON.parse(jsonText);
  } catch {
    fail('Review Receipt must contain exactly one valid JSON object');
  }
  if (!receipt || Array.isArray(receipt) || typeof receipt !== 'object') {
    fail('Review Receipt must be a JSON object');
  }
  const requiredStrings = ['issue_id', 'base_sha', 'head_sha', 'verdict', 'route', 'reviewer_attempt_id', 'created_at'];
  if (receipt.version !== 1) fail('Review Receipt version must be 1');
  if (!Number.isInteger(receipt.pr_number) || receipt.pr_number <= 0) fail('Review Receipt pr_number must be a positive integer');
  if (!(receipt.issue_version === null || Number.isInteger(receipt.issue_version))) {
    fail('Review Receipt issue_version must be an integer or null');
  }
  for (const field of requiredStrings) {
    if (typeof receipt[field] !== 'string' || !receipt[field].trim()) fail(`Review Receipt missing ${field}`);
  }
  if (!['pass', 'blocked', 'reset'].includes(receipt.verdict)) fail('Review Receipt verdict is invalid');
  if (!['human_review', 'merging', 'in_progress', 'rework'].includes(receipt.route)) fail('Review Receipt route is invalid');
  if (!Number.isFinite(Date.parse(receipt.created_at))) fail('Review Receipt created_at must be an ISO timestamp');
  const scopeIssue = scopeField(scope, 'Issue');
  const scopePr = scopeField(scope, 'PR');
  const scopeBase = scopeField(scope, 'Base SHA');
  const scopeHead = scopeField(scope, 'Head SHA');
  const scopePrNumber = /\/pull\/(\d+)(?:\b|$)/.exec(scopePr)?.[1] ?? /^#?(\d+)$/.exec(scopePr)?.[1];
  if (receipt.issue_id !== scopeIssue) fail('Review Receipt issue_id must match Scope Read Issue');
  if (!scopePrNumber || receipt.pr_number !== Number(scopePrNumber)) fail('Review Receipt pr_number must match Scope Read PR');
  if (receipt.base_sha !== scopeBase) fail('Review Receipt base_sha must match Scope Read Base SHA');
  if (receipt.head_sha !== scopeHead) fail('Review Receipt head_sha must match Scope Read Head SHA');

  const expected = /Pass: route to Human Review/.test(verdict)
    ? ['pass', 'human_review']
    : /Pass: route to Merging/.test(verdict)
      ? ['pass', 'merging']
      : /Blocked: move to In Progress/.test(verdict)
        ? ['blocked', 'in_progress']
        : /Reset required: move to Rework/.test(verdict)
          ? ['reset', 'rework']
          : null;
  if (expected && (receipt.verdict !== expected[0] || receipt.route !== expected[1])) {
    fail('Review Receipt verdict and route must match the Verdict section');
  }
}

function requiresCrossSurfaceTrace(body) {
  const lenses = sectionContent(body, 'Triggered Review Lenses') || '';
  const searchable = `${body}\n${lenses}`;
  const hasRequiredPropagationMatrix = /propagation matrix:/i.test(searchable) && !/propagation matrix:\s*not required/i.test(searchable);
  return (
    /(^|\|)\s*cross-cutting|contract propagation|scenario-to-surface/i.test(searchable) ||
    hasRequiredPropagationMatrix
  );
}

function validateScenarioToSurfaceTrace(section) {
  const { headers, dataRows } = requireTableRows(section, 'Scenario-To-Surface Trace', [
    'Scenario / criterion',
    'Runtime behavior',
    'API/state/diagnostics',
    'Dashboard/operator UI',
    'Persistence/history/audit',
    'Tests/assertions',
    'Verdict'
  ]);
  const dashboardIndex = headers.indexOf('dashboard/operator ui');
  const apiIndex = headers.indexOf('api/state/diagnostics');
  const persistenceIndex = headers.indexOf('persistence/history/audit');
  for (const row of dataRows) {
    const cells = splitRow(row);
    const dashboard = cells[dashboardIndex] || '';
    const api = cells[apiIndex] || '';
    const persistence = cells[persistenceIndex] || '';
    if (/^(same as api|covered by api|api only|see api)$/i.test(dashboard)) {
      fail(`Scenario-To-Surface Trace dashboard evidence cannot be merged into API evidence: ${row}`);
    }
    if (/^(same as api|covered by api|api only|see api)$/i.test(persistence)) {
      fail(`Scenario-To-Surface Trace persistence evidence cannot be merged into API evidence: ${row}`);
    }
    if (/api\/dashboard\/persistence|api, dashboard, persistence|projection surfaces/i.test(`${api} ${dashboard} ${persistence}`)) {
      fail(`Scenario-To-Surface Trace must split API, dashboard, and persistence evidence: ${row}`);
    }
  }
}

function validateCrossSurfaceArtifact(body, verdict) {
  requireTableEvidence(
    requireSection(body, 'Scope Comments Reviewed'),
    'Scope Comments Reviewed',
    ['Comment / prior finding', 'Required scenario', 'Evidence', 'Verdict']
  );
  validateScenarioToSurfaceTrace(requireSection(body, 'Scenario-To-Surface Trace'));
  requireTableRows(requireSection(body, 'Path Census'), 'Path Census', [
    'Contract / invariant',
    'Search evidence',
    'Paths found',
    'Paths verified',
    'Gaps'
  ]);

  const invalidEvidence = requireSection(body, 'Invalid Evidence Check');
  const fixtureOnly = requireFlag(invalidEvidence, 'Fixture-only evidence present?');
  const representativePath = requireFlag(invalidEvidence, 'Representative-path shortcut used?');
  requireFlag(invalidEvidence, 'UI evidence matches changed state?');
  requireFlag(invalidEvidence, 'Head SHA reviewed');
  requireFlag(invalidEvidence, 'Residual unreviewed surfaces');

  if (/^yes\b/i.test(fixtureOnly) && !isBlockedVerdict(verdict)) {
    fail('Fixture-only evidence cannot pass cross-surface review');
  }
  if (/^yes\b/i.test(representativePath) && !isBlockedVerdict(verdict)) {
    fail('Representative-path shortcut cannot pass cross-surface review');
  }
}

function validateReviewArtifact(rawBody) {
  const body = assertHumanReadableMarkdownBody(rawBody);
  if (!/^## Agent Review\s*$/m.test(body)) {
    fail('missing top-level "## Agent Review" heading');
  }

  const scope = requireSection(body, 'Scope Read');
  for (const field of ['Issue', 'PR', 'Base SHA', 'Head SHA', 'Prior findings reviewed']) {
    requireField(scope, field);
  }

  const invariants = requireSection(body, 'Independent Invariants');
  if (!/^- |\d+\. /m.test(invariants)) {
    fail('Independent Invariants must list at least one invariant');
  }

  requireTableEvidence(
    requireSection(body, 'Acceptance Criteria Mapping'),
    'Acceptance Criteria Mapping',
    ['Criterion', 'Evidence', 'Verdict']
  );
  requireTableEvidence(
    requireSection(body, 'Triggered Review Lenses'),
    'Triggered Review Lenses',
    ['Lens', 'Trigger', 'Evidence', 'Verdict']
  );

  const findings = requireSection(body, 'Findings');
  if (!/(P1|P2|P3|No blocking findings)/i.test(findings)) {
    fail('Findings must list P1/P2/P3 findings or `No blocking findings`');
  }
  if (/\bP3\b/i.test(findings)) {
    fail('Findings must not include P3 or non-blocking suggestions');
  }

  const verdict = requireSection(body, 'Verdict');
  validateReviewReceipt(body, scope, verdict);
  if (!/(Blocked: move to In Progress|Reset required: move to Rework|Pass: route to Human Review|Pass: route to Merging)/.test(verdict)) {
    fail('Verdict must use one of the allowed routing outcomes');
  }
  const hasBlockingFinding = /\bP[12]\b/i.test(findings);
  const isPassing = /Pass: route to (Human Review|Merging)/.test(verdict);
  if (isPassing && (hasBlockingFinding || !/No blocking findings/i.test(findings))) {
    fail('Passing verdict requires `No blocking findings` and cannot include P1/P2 findings');
  }
  if (!isPassing && !hasBlockingFinding) {
    fail('Blocked or reset verdict requires at least one P1/P2 finding');
  }
  if (requiresCrossSurfaceTrace(body)) {
    validateCrossSurfaceArtifact(body, verdict);
  }
}

if (require.main === module) {
  try {
    validateReviewArtifact(readReviewBody(process.argv.slice(2)));
    process.stdout.write('Review artifact check passed.\n');
  } catch (error) {
    if (error && error.code === 'pr_body_escaped_newlines') {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

module.exports = {
  validateReviewArtifact
};
