#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizePrBody } = require('./normalize-pr-body');

const VALIDATION_POLICY_ID = 'symphony-fast-v1';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = { mode: 'create', title: '', prNumber: '', outputFile: '', branch: '', wait: false };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const value = argv[index + 1];
    if (current === '--mode' && value) parsed.mode = value;
    else if (current === '--title' && value) parsed.title = value;
    else if ((current === '--pr' || current === '--pr-number') && value) parsed.prNumber = value;
    else if (current === '--output-file' && value) parsed.outputFile = value;
    else if (current === '--branch' && value) parsed.branch = value;
    else if (current === '--wait') {
      parsed.wait = true;
      continue;
    } else fail(`submit_pr_invalid_args: unsupported argument ${current}`);
    index += 1;
  }
  if (!['create', 'edit', 'upsert'].includes(parsed.mode)) {
    fail("submit_pr_invalid_args: --mode must be one of 'create', 'edit', or 'upsert'");
  }
  return parsed;
}

function isTruthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function commandText(command, args) {
  return [command, ...args].map((value) => (/\s/.test(value) ? JSON.stringify(value) : value)).join(' ');
}

function runCommand(command, args, options = {}) {
  if (options.dryRun) {
    process.stdout.write(`[dry-run] ${commandText(command, args)}\n`);
    return { stdout: '', status: 0 };
  }
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: options.env || process.env,
    timeout: options.timeout
  });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? String(result.stderr || result.stdout || '').trim() : '';
    fail(`${options.errorCode || 'submit_pr_command_failed'}: ${commandText(command, args)}${detail ? `: ${detail}` : ''}`);
  }
  return { stdout: String(result.stdout || '').trim(), status: result.status };
}

function gitText(args, errorCode) {
  return runCommand('git', args, { capture: true, errorCode }).stdout;
}

function assertBranch(branch, expectedBranch) {
  if (!branch || (expectedBranch && branch !== expectedBranch)) {
    fail(`submit_pr_branch_mismatch: expected=${expectedBranch || '<provided branch>'}:actual=${branch || '<detached>'}`);
  }
  runCommand('git', ['check-ref-format', '--branch', branch], { capture: true, errorCode: 'submit_pr_invalid_branch' });
}

function candidateIdentity() {
  const headSha = gitText(['rev-parse', 'HEAD'], 'submit_pr_head_unavailable');
  const treeSha = gitText(['rev-parse', 'HEAD^{tree}'], 'submit_pr_tree_unavailable');
  return {
    head_sha: headSha,
    tree_sha: treeSha,
    validation_policy_id: VALIDATION_POLICY_ID,
    environment_fingerprint: crypto
      .createHash('sha256')
      .update(`${process.platform}\0${process.arch}\0${process.version}\0loopback=${probeLoopbackBinding()}`)
      .digest('hex')
  };
}

function receiptPath(candidate) {
  const gitCache = gitText(['rev-parse', '--git-path', 'symphony-validation-receipts'], 'validation_cache_unavailable');
  return path.resolve(process.cwd(), gitCache, `${candidate.head_sha}.json`);
}

function readReceipt(candidate) {
  const target = receiptPath(candidate);
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    return parsed.candidate?.head_sha === candidate.head_sha &&
      parsed.candidate?.tree_sha === candidate.tree_sha &&
      parsed.candidate?.validation_policy_id === candidate.validation_policy_id &&
      parsed.candidate?.environment_fingerprint === candidate.environment_fingerprint
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeReceipt(receipt) {
  const target = receiptPath(receipt.candidate);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return target;
}

function probeLoopbackBinding() {
  const probe = spawnSync(
    process.execPath,
    ['-e', "const net=require('node:net');const s=net.createServer();s.once('error',()=>process.exit(1));s.listen(0,'127.0.0.1',()=>s.close(()=>process.exit(0)));"],
    { cwd: process.cwd(), stdio: 'ignore', timeout: 5000 }
  );
  return probe.status === 0;
}

function validateCandidate(candidate, env) {
  const cached = readReceipt(candidate);
  if (cached?.overall === 'passed' || cached?.overall === 'environment_incompatible') {
    process.stdout.write(`Reusing validation receipt for ${candidate.head_sha}.\n`);
    return { ...cached, cache_hit: true };
  }
  const validationStartedAt = Date.now();
  const commands = [];
  const run = (id, command, args) => {
    const startedAt = Date.now();
    runCommand(command, args, { env, errorCode: `validation_failed:${id}` });
    commands.push({ id, status: 'passed', failure_category: null, duration_ms: Date.now() - startedAt });
  };
  const baseSha = gitText(['merge-base', 'HEAD', 'origin/main'], 'validation_base_unavailable');
  run('diff-check', 'git', ['diff', '--check', `${baseSha}...HEAD`]);
  run('build', 'npm', ['run', 'build']);
  if (probeLoopbackBinding()) {
    run('fast-tests', 'npm', ['test']);
  } else {
    commands.push({
      id: 'fast-tests',
      status: 'environment_incompatible',
      failure_category: 'loopback_binding_unavailable',
      duration_ms: 0
    });
  }
  const after = candidateIdentity();
  if (after.head_sha !== candidate.head_sha || after.tree_sha !== candidate.tree_sha || gitText(['status', '--porcelain'], 'validation_status_failed')) {
    fail('candidate_changed_during_validation: validation must leave the exact committed candidate clean');
  }
  const environmentIncompatible = commands.some((entry) => entry.status === 'environment_incompatible');
  const receipt = {
    version: 1,
    candidate,
    commands,
    cache_hit: false,
    duration_ms: Date.now() - validationStartedAt,
    equivalent_ci_checks: environmentIncompatible ? ['Fast validation (ubuntu-latest)'] : [],
    overall: environmentIncompatible ? 'environment_incompatible' : 'passed',
    created_at: new Date().toISOString()
  };
  writeReceipt(receipt);
  return receipt;
}

function createGhArgs(parsed, normalizedBodyFile, mode, headBranch = '') {
  if (mode === 'edit') {
    return ['pr', 'edit', ...(parsed.prNumber.trim() ? [parsed.prNumber.trim()] : []), '--body-file', normalizedBodyFile];
  }
  if (!parsed.title.trim()) fail('submit_pr_invalid_args: --title is required when creating a PR');
  return [
    'pr',
    'create',
    '--title',
    parsed.title.trim(),
    '--body-file',
    normalizedBodyFile,
    ...(headBranch ? ['--head', headBranch, '--base', 'main'] : [])
  ];
}

function upsertPr(parsed, normalizedBodyFile, env, dryRun) {
  const existing = dryRun
    ? null
    : JSON.parse(
        runCommand(
          'gh',
          ['pr', 'list', '--head', parsed.branch, '--base', 'main', '--state', 'open', '--limit', '2', '--json', 'number,isDraft,baseRefName,headRefName'],
          { capture: true, errorCode: 'submit_pr_list_failed' }
        ).stdout || '[]'
      );
  if (existing && existing.length > 1) fail(`submit_pr_ambiguous_open_pr: branch=${parsed.branch}`);
  const openPr = existing?.[0] ?? null;
  if (openPr?.isDraft) fail(`submit_pr_draft_pr_forbidden: pr=${openPr.number}`);
  const mode = openPr ? 'edit' : 'create';
  const effective = openPr ? { ...parsed, prNumber: String(openPr.number) } : parsed;
  runCommand('gh', createGhArgs(effective, normalizedBodyFile, mode, openPr ? '' : parsed.branch), {
    env,
    dryRun,
    errorCode: 'submit_pr_upsert_failed'
  });
  const prNumber = dryRun
    ? ''
    : openPr?.number ??
      JSON.parse(
        runCommand('gh', ['pr', 'view', parsed.branch, '--json', 'number'], {
          capture: true,
          errorCode: 'submit_pr_readback_failed'
        }).stdout
      ).number;
  runCommand('gh', ['pr', 'edit', ...(prNumber ? [String(prNumber)] : []), '--add-label', 'symphony'], {
    env,
    dryRun,
    errorCode: 'submit_pr_label_failed'
  });
  return prNumber;
}

function submitWithGovernance(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const dryRun = isTruthy(process.env.SYMPHONY_SUBMIT_PR_DRY_RUN);
  const skipChecks = isTruthy(process.env.SYMPHONY_SUBMIT_PR_SKIP_CHECKS);
  const normalized = normalizePrBody({ outputFile: parsed.outputFile || process.env.SYMPHONY_PR_BODY_NORMALIZED_FILE });
  const env = { ...process.env, SYMPHONY_PR_BODY_FILE: normalized.resolvedOutput };

  if (parsed.mode !== 'upsert') {
    if (!skipChecks) {
      runCommand('npm', ['run', 'check:pr-governance'], { env });
      runCommand('npm', ['run', 'check:meta'], { env });
    }
    runCommand('gh', createGhArgs(parsed, normalized.resolvedOutput, parsed.mode), { env, dryRun });
    return;
  }

  if (!parsed.branch.trim()) fail('submit_pr_invalid_args: --branch is required for --mode upsert');
  if (!parsed.wait) fail('submit_pr_wait_required: --wait is required for governed upsert');
  if (skipChecks && !dryRun) fail('submit_pr_skip_checks_forbidden: governed upsert validation cannot be skipped');
  if (dryRun) {
    process.stdout.write(`[dry-run] validate exact committed candidate for ${parsed.branch}\n`);
    runCommand('git', ['push', 'origin', `HEAD:refs/heads/${parsed.branch}`], { dryRun: true });
    upsertPr(parsed, normalized.resolvedOutput, env, true);
    process.stdout.write('[dry-run] wait for exact-head implementation readiness\n');
    return;
  }

  const branch = gitText(['branch', '--show-current'], 'submit_pr_branch_unavailable');
  assertBranch(branch, parsed.branch.trim());
  if (gitText(['status', '--porcelain'], 'submit_pr_status_failed')) fail('submit_pr_candidate_dirty: commit the candidate before publication');
  const candidate = candidateIdentity();
  const receipt = skipChecks ? null : validateCandidate(candidate, env);
  runCommand('npm', ['run', 'check:meta'], { env, errorCode: 'validation_failed:meta' });
  runCommand('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { errorCode: 'submit_pr_push_failed' });
  const prNumber = upsertPr(parsed, normalized.resolvedOutput, env, false);
  const pr = JSON.parse(runCommand('gh', ['pr', 'view', String(prNumber), '--json', 'number,url,headRefOid,baseRefName,state,isDraft'], {
    capture: true,
    errorCode: 'submit_pr_readback_failed'
  }).stdout);
  if (pr.headRefOid !== candidate.head_sha) fail(`submit_pr_head_mismatch: expected=${candidate.head_sha}:actual=${pr.headRefOid}`);
  if (pr.state !== 'OPEN' || pr.isDraft || pr.baseRefName !== 'main') {
    fail(`submit_pr_invalid_pr_state: state=${pr.state}:draft=${Boolean(pr.isDraft)}:base=${pr.baseRefName}`);
  }
  runCommand(
    path.join(__dirname, '..', '.codex', 'skills', 'land', 'scripts', 'land_watch.py'),
    ['--mode', 'implementation-readiness', '--expected-head', candidate.head_sha, '--json'],
    { errorCode: 'submit_pr_readiness_failed' }
  );
  process.stdout.write(`${JSON.stringify({
    status: 'ready',
    pr_number: pr.number,
    pr_url: pr.url,
    head_sha: candidate.head_sha,
    validation: receipt?.overall || 'skipped',
    validation_cache_hit: receipt?.cache_hit ?? null,
    validation_duration_ms: receipt?.duration_ms ?? null
  })}\n`);
}

if (require.main === module) submitWithGovernance();

module.exports = { VALIDATION_POLICY_ID, candidateIdentity, parseArgs, submitWithGovernance };
