#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertHumanReadableMarkdownBody } = require('./lib/markdown-body');

const DEFAULT_OUTPUT_FILE = path.join(os.tmpdir(), `symphony-pr-body-${process.pid}.md`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readInput(rootDir, inputFile, inputBody) {
  const filePath = String(inputFile || '').trim();
  if (filePath.length > 0) {
    const resolved = path.resolve(rootDir, filePath);
    if (!fs.existsSync(resolved)) {
      fail(`normalize_pr_body_input_missing: input file not found: ${filePath}`);
    }
    return fs.readFileSync(resolved, 'utf8');
  }

  const body = typeof inputBody === 'string' ? inputBody : '';
  if (body.trim().length === 0) {
    fail('normalize_pr_body_input_missing: provide SYMPHONY_PR_BODY or SYMPHONY_PR_BODY_FILE');
  }
  return body;
}

function resolveGitPath(rootDir, outputFile) {
  const gitRelativePrefix = '.git/';
  if (!outputFile.startsWith(gitRelativePrefix)) {
    return path.resolve(rootDir, outputFile);
  }

  const gitPathArg = outputFile.slice(gitRelativePrefix.length);
  const result = spawnSync('git', ['rev-parse', '--git-path', gitPathArg], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  if (result.status === 0) {
    return path.resolve(rootDir, result.stdout.trim());
  }

  return path.resolve(rootDir, outputFile);
}

function writeNormalizedBody(rootDir, outputFile, normalizedBody) {
  const resolvedOutput = resolveGitPath(rootDir, outputFile);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, normalizedBody, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(resolvedOutput, 0o600);
  return resolvedOutput;
}

function normalizePrBody(opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const inputFile = opts.inputFile || process.env.SYMPHONY_PR_BODY_FILE || '';
  const inputBody = opts.inputBody ?? process.env.SYMPHONY_PR_BODY ?? '';
  const outputFile = opts.outputFile || process.env.SYMPHONY_PR_BODY_NORMALIZED_FILE || DEFAULT_OUTPUT_FILE;
  const emitPathOnly = opts.emitPathOnly ?? String(process.env.SYMPHONY_PR_BODY_NORMALIZED_PATH_ONLY || '').trim() === '1';

  const rawInput = readInput(rootDir, inputFile, inputBody);
  let normalizedBody;
  try {
    normalizedBody = assertHumanReadableMarkdownBody(rawInput);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'pr_body_escaped_newlines: body contains escaped newline sequences; normalize before submit');
  }

  const resolvedOutput = writeNormalizedBody(rootDir, outputFile, normalizedBody);
  const relativeOutput = path.relative(rootDir, resolvedOutput) || path.basename(resolvedOutput);

  if (emitPathOnly) {
    process.stdout.write(`${relativeOutput}\n`);
  } else {
    process.stdout.write(`Normalized PR body written: ${relativeOutput}\n`);
  }

  return {
    rootDir,
    normalizedBody,
    resolvedOutput,
    relativeOutput
  };
}

if (require.main === module) {
  normalizePrBody();
}

module.exports = {
  DEFAULT_OUTPUT_FILE,
  normalizePrBody
};
