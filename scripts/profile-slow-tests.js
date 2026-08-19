#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ERROR_CODE = 'slow_test_profile_failed';
const DEFAULT_LIMIT = 10;
const HEAVY_PATTERNS = [
  ['git', /\bgit\b|github|pr-submit|upstream|branch|merge/i],
  ['worktree', /worktree|workspace|provision|copy-ignored|before-remove/i],
  ['process', /child_process|spawn|execFile|subprocess|process-lifecycle|runner-process|desktop|tauri|local-multi-project|integration-profile|stress/i]
];

function usage() {
  process.stdout.write(
    [
      'Usage: npm run test:profile:slow -- [options] [vitest-file-or-filter ...]',
      '',
      'Runs Vitest with the JSON reporter, then prints a concise slow-test profile.',
      '',
      'Options:',
      `  --limit <count>          Number of slow files and tests to show (default: ${DEFAULT_LIMIT})`,
      '  --json                   Emit machine-readable report JSON',
      '  --input <path>           Read an existing Vitest JSON report instead of running Vitest',
      '  --keep-json              Keep the temporary Vitest JSON report and print its path',
      '  --help                   Show this help message',
      '',
      'Examples:',
      '  npm run test:profile:slow',
      '  npm run test:profile:slow -- --limit=5 tests/workspace',
      ''
    ].join('\n')
  );
}

function parseArgs(argv) {
  const args = {
    limit: DEFAULT_LIMIT,
    json: false,
    input: null,
    keepJson: false,
    help: false,
    vitestArgs: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--keep-json') {
      args.keepJson = true;
      continue;
    }
    if (token === '--limit') {
      args.limit = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token.startsWith('--limit=')) {
      args.limit = Number(token.slice('--limit='.length));
      continue;
    }
    if (token === '--input') {
      args.input = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--input=')) {
      args.input = token.slice('--input='.length);
      continue;
    }
    args.vitestArgs.push(token);
  }

  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }

  return args;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function readGitSha(cwd) {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function normalizePath(filePath, cwd) {
  if (!filePath) {
    return '(unknown)';
  }
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith('..') ? relative : filePath;
}

function classifyHeavy(filePath, assertions = []) {
  const haystack = [
    filePath,
    ...assertions.map((assertion) => assertion.fullName || assertion.title || '')
  ].join('\n');
  const reasons = HEAVY_PATTERNS.filter(([, pattern]) => pattern.test(haystack)).map(([name]) => name);
  return {
    category: reasons.length ? 'git/worktree/process-heavy' : 'routine unit',
    reasons
  };
}

function readFileDurationMs(result) {
  if (typeof result.startTime === 'number' && typeof result.endTime === 'number') {
    return Math.max(0, result.endTime - result.startTime);
  }
  return (result.assertionResults || []).reduce((sum, assertion) => sum + Number(assertion.duration || 0), 0);
}

function buildProfile(vitestJson, options = {}) {
  const cwd = options.cwd || process.cwd();
  const wallClockMs = Number(options.wallClockMs || 0);
  const command = options.command || 'npm run test:profile:slow';
  const vitestCommand = options.vitestCommand || 'input report';
  const testResults = Array.isArray(vitestJson.testResults) ? vitestJson.testResults : [];

  const files = testResults
    .map((result) => {
      const file = normalizePath(result.name, cwd);
      const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
      const classification = classifyHeavy(file, assertions);
      return {
        file,
        duration_ms: readFileDurationMs(result),
        status: result.status || 'unknown',
        tests: assertions.length,
        category: classification.category,
        reasons: classification.reasons
      };
    })
    .sort((a, b) => b.duration_ms - a.duration_ms);

  const patterns = testResults
    .flatMap((result) => {
      const file = normalizePath(result.name, cwd);
      const classification = classifyHeavy(file, result.assertionResults || []);
      return (result.assertionResults || []).map((assertion) => ({
        file,
        name: assertion.fullName || assertion.title || '(unnamed test)',
        duration_ms: Number(assertion.duration || 0),
        status: assertion.status || 'unknown',
        category: classification.category,
        reasons: classification.reasons
      }));
    })
    .sort((a, b) => b.duration_ms - a.duration_ms);

  const groups = files.reduce(
    (acc, file) => {
      const group = acc[file.category] || {
        category: file.category,
        files: 0,
        tests: 0,
        duration_ms: 0,
        slowest_file: file.file,
        slowest_file_duration_ms: file.duration_ms
      };
      group.files += 1;
      group.tests += file.tests;
      group.duration_ms += file.duration_ms;
      if (file.duration_ms > group.slowest_file_duration_ms) {
        group.slowest_file = file.file;
        group.slowest_file_duration_ms = file.duration_ms;
      }
      acc[file.category] = group;
      return acc;
    },
    {}
  );

  return {
    measured_at: new Date().toISOString(),
    environment: {
      cwd,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      sha: readGitSha(cwd)
    },
    command,
    vitest_command: vitestCommand,
    wall_clock_ms: wallClockMs,
    result: {
      success: Boolean(vitestJson.success),
      total_files: files.length,
      total_tests: Number(vitestJson.numTotalTests || 0),
      passed_tests: Number(vitestJson.numPassedTests || 0),
      failed_tests: Number(vitestJson.numFailedTests || 0)
    },
    groups: Object.values(groups).sort((a, b) => b.duration_ms - a.duration_ms),
    slowest_files: files,
    expensive_patterns: patterns
  };
}

function formatReport(profile, limit = DEFAULT_LIMIT) {
  const lines = [
    'Slow test profile',
    `Environment: cwd=${profile.environment.cwd} sha=${profile.environment.sha} node=${profile.environment.node} platform=${profile.environment.platform}`,
    `Command: ${profile.command}`,
    `Vitest command: ${profile.vitest_command}`,
    `Wall clock: ${seconds(profile.wall_clock_ms)}`,
    `Result: ${profile.result.success ? 'pass' : 'fail'} (${profile.result.total_files} files, ${profile.result.total_tests} tests, ${profile.result.failed_tests} failed)`,
    '',
    'Groups:'
  ];

  for (const group of profile.groups) {
    lines.push(
      `- ${group.category}: ${seconds(group.duration_ms)} across ${group.files} files / ${group.tests} tests; slowest ${group.slowest_file} (${seconds(group.slowest_file_duration_ms)})`
    );
  }

  lines.push('', `Slowest files (top ${limit}):`);
  for (const [index, file] of profile.slowest_files.slice(0, limit).entries()) {
    const reason = file.reasons.length ? ` [${file.reasons.join(',')}]` : '';
    lines.push(
      `${index + 1}. ${seconds(file.duration_ms)} ${file.category}${reason} ${file.file} (${file.tests} tests, ${file.status})`
    );
  }

  lines.push('', `Expensive test patterns (top ${limit}):`);
  for (const [index, test] of profile.expensive_patterns.slice(0, limit).entries()) {
    const reason = test.reasons.length ? ` [${test.reasons.join(',')}]` : '';
    lines.push(`${index + 1}. ${seconds(test.duration_ms)} ${test.category}${reason} ${test.file} - ${test.name}`);
  }

  return `${lines.join('\n')}\n`;
}

function resolveLocalVitestBin(cwd) {
  const binaryName = process.platform === 'win32' ? 'vitest.cmd' : 'vitest';
  let current = path.resolve(cwd);
  while (true) {
    const binaryPath = path.join(current, 'node_modules', '.bin', binaryName);
    if (fs.existsSync(binaryPath)) {
      return binaryPath;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(`Local Vitest binary not found under ${path.resolve(cwd)} or its parent directories. Run npm install before profiling.`);
}

function runVitest(args) {
  const outputFile = path.join(os.tmpdir(), `symphony-slow-tests-${process.pid}-${Date.now()}.json`);
  const vitestBin = resolveLocalVitestBin(process.cwd());
  const vitestArgs = ['run', '--reporter=json', `--outputFile=${outputFile}`, ...args.vitestArgs];
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(vitestBin, vitestArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const endedAt = process.hrtime.bigint();
  const wallClockMs = Number(endedAt - startedAt) / 1_000_000;

  if (!fs.existsSync(outputFile)) {
    throw new Error(`Vitest JSON report was not created. stderr: ${(result.stderr || '').trim()}`);
  }

  const payload = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  if (args.keepJson) {
    process.stderr.write(`Vitest JSON report kept at ${outputFile}\n`);
  } else {
    fs.rmSync(outputFile, { force: true });
  }

  return {
    payload,
    wallClockMs,
    status: result.status ?? 1,
    vitestCommand: `${path.relative(process.cwd(), vitestBin)} ${vitestArgs.join(' ')}`
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return 0;
  }

  const command = `npm run test:profile:slow${process.argv.slice(2).length ? ` -- ${process.argv.slice(2).join(' ')}` : ''}`;
  const run = args.input
    ? {
        payload: JSON.parse(fs.readFileSync(args.input, 'utf8')),
        wallClockMs: 0,
        status: 0,
        vitestCommand: `input report ${args.input}`
      }
    : runVitest(args);
  const profile = buildProfile(run.payload, {
    cwd: process.cwd(),
    wallClockMs: run.wallClockMs,
    command,
    vitestCommand: run.vitestCommand
  });

  process.stdout.write(args.json ? `${JSON.stringify(profile, null, 2)}\n` : formatReport(profile, args.limit));
  return run.status;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${ERROR_CODE}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ERROR_CODE,
  parseArgs,
  classifyHeavy,
  buildProfile,
  formatReport,
  resolveLocalVitestBin
};
