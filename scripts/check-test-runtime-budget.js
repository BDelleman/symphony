#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildProfile, resolveLocalVitestBin } = require('./profile-slow-tests.js');
const { buildVitestArgs } = require('./run-vitest-group.js');

const ERROR_CODE = 'test_runtime_budget_failed';
const DEFAULT_BASELINE = path.join('docs', 'test-runtime-baseline.json');
const VALID_COMMANDS = new Set(['fast', 'integration', 'full']);

function usage() {
  process.stdout.write(
    [
      'Usage: npm run test:runtime-guardrail -- [options]',
      '',
      'Compares a slow-test profile against the checked-in runtime baseline.',
      '',
      'Options:',
      '  --profile <fast|integration|full>  Run the selected Vitest group and compare it.',
      '  --input <path>                     Compare an existing profile or Vitest JSON report.',
      '  --command <fast|integration|full>  Command budget to use with --input.',
      `  --baseline <path>                  Baseline JSON path (default: ${DEFAULT_BASELINE})`,
      '  --json                             Emit machine-readable diagnostics.',
      '  --limit <count>                    Number of diagnostics to print (default: 8).',
      '  --help                             Show this help message.',
      '',
      'Examples:',
      '  npm run test:runtime-guardrail -- --profile fast',
      '  npm run test:profile:slow -- --json > /tmp/profile.json',
      '  npm run test:runtime-guardrail -- --input /tmp/profile.json --command full',
      ''
    ].join('\n')
  );
}

function parseArgs(argv) {
  const args = {
    profile: null,
    input: null,
    command: null,
    baseline: DEFAULT_BASELINE,
    json: false,
    limit: 8,
    help: false
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
    if (token === '--profile' || token === '--input' || token === '--command' || token === '--baseline' || token === '--limit') {
      args[token.slice(2)] = argv[i + 1];
      i += 1;
      continue;
    }
    const equalMatch = token.match(/^--(profile|input|command|baseline|limit)=(.+)$/);
    if (equalMatch) {
      args[equalMatch[1]] = equalMatch[2];
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  args.limit = Number(args.limit);
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }
  for (const field of ['profile', 'command']) {
    if (args[field] !== null && !VALID_COMMANDS.has(args[field])) {
      throw new Error(`--${field} must be one of: fast, integration, full`);
    }
  }
  if (args.profile && args.input) {
    throw new Error('Use either --profile or --input, not both');
  }
  if (!args.profile && !args.input && !args.help) {
    throw new Error('Provide --profile <fast|integration|full> or --input <path>');
  }
  if (args.profile && args.command && args.command !== args.profile) {
    throw new Error('--command must match --profile when both are provided');
  }

  return args;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function readJson(filePath, root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.resolve(root, filePath), 'utf8'));
}

function isProfileJson(payload) {
  return Boolean(payload && payload.result && Array.isArray(payload.slowest_files) && Array.isArray(payload.groups));
}

function commandFromProfile(profile) {
  const command = String(profile.command || '');
  if (/\bnpm\s+test\b/.test(command) && !command.includes('test:')) {
    return 'fast';
  }
  if (command.includes('test:integration')) {
    return 'integration';
  }
  if (command.includes('test:full')) {
    return 'full';
  }
  return null;
}

function normalizeProfile(payload, options) {
  if (isProfileJson(payload)) {
    return payload;
  }

  return buildProfile(payload, {
    cwd: options.cwd,
    wallClockMs: options.wallClockMs || 0,
    command: options.command || 'input report',
    vitestCommand: options.vitestCommand || 'input report'
  });
}

function runProfile(commandName, cwd) {
  const outputFile = path.join(os.tmpdir(), `symphony-runtime-guardrail-${process.pid}-${Date.now()}.json`);
  const vitestBin = resolveLocalVitestBin(cwd);
  const vitestArgs = [
    ...buildVitestArgs(commandName),
    '--reporter=json',
    `--outputFile=${outputFile}`
  ];
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(vitestBin, vitestArgs, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });
  const endedAt = process.hrtime.bigint();
  const wallClockMs = Number(endedAt - startedAt) / 1_000_000;

  if (!fs.existsSync(outputFile)) {
    throw new Error(`Vitest JSON report was not created. stderr: ${(result.stderr || '').trim()}`);
  }

  const payload = readJson(outputFile, '/');
  fs.rmSync(outputFile, { force: true });
  const profile = normalizeProfile(payload, {
    cwd,
    wallClockMs,
    command: baselineCommandLabel(commandName),
    vitestCommand: `${path.relative(cwd, vitestBin)} ${vitestArgs.join(' ')}`
  });

  return {
    profile,
    status: result.status ?? 1,
    stderr: result.stderr || ''
  };
}

function baselineCommandLabel(commandName) {
  if (commandName === 'fast') {
    return 'npm test';
  }
  if (commandName === 'integration') {
    return 'npm run test:integration';
  }
  return 'npm run test:full';
}

function compareRuntime(profile, baseline, commandName) {
  const diagnostics = [];
  const commandBudget = baseline.commands?.[commandName];
  if (!commandBudget) {
    throw new Error(`Baseline does not define command budget: ${commandName}`);
  }

  if (!profile.result?.success) {
    diagnostics.push({
      kind: 'test_failure',
      command: commandName,
      message: `${commandName} test command did not pass (${Number(profile.result?.failed_tests || 0)} failed tests)`
    });
  }

  if (Number(profile.wall_clock_ms || 0) > commandBudget.budget_wall_clock_ms) {
    diagnostics.push({
      kind: 'command_wall_clock',
      command: commandName,
      actual_ms: Number(profile.wall_clock_ms || 0),
      budget_ms: commandBudget.budget_wall_clock_ms,
      baseline_ms: commandBudget.baseline_wall_clock_ms,
      message: `${commandName} wall clock ${seconds(profile.wall_clock_ms)} exceeds budget ${seconds(commandBudget.budget_wall_clock_ms)} (baseline ${seconds(commandBudget.baseline_wall_clock_ms)})`
    });
  }

  const slowFileBudgets = baseline.slow_files || {};
  for (const file of profile.slowest_files || []) {
    const fileBudget = slowFileBudgets[file.file];
    if (!fileBudget || fileBudget.command !== commandName) {
      continue;
    }
    if (Number(file.duration_ms || 0) > fileBudget.budget_ms) {
      diagnostics.push({
        kind: 'slow_file',
        command: commandName,
        file: file.file,
        actual_ms: Number(file.duration_ms || 0),
        budget_ms: fileBudget.budget_ms,
        baseline_ms: fileBudget.baseline_ms,
        note: fileBudget.note,
        message: `${file.file} ${seconds(file.duration_ms)} exceeds budget ${seconds(fileBudget.budget_ms)} (baseline ${seconds(fileBudget.baseline_ms)})`
      });
    }
  }

  return {
    ok: diagnostics.length === 0 && Boolean(profile.result?.success),
    command: commandName,
    command_budget: commandBudget,
    profile_summary: {
      success: Boolean(profile.result?.success),
      wall_clock_ms: Number(profile.wall_clock_ms || 0),
      total_files: Number(profile.result?.total_files || 0),
      total_tests: Number(profile.result?.total_tests || 0),
      failed_tests: Number(profile.result?.failed_tests || 0)
    },
    diagnostics
  };
}

function formatResult(result, limit = 8) {
  const lines = [
    result.ok ? 'Test runtime guardrail passed.' : `${ERROR_CODE}: runtime budget regression detected.`,
    `Command: ${result.command} (${result.command_budget.command})`,
    `Scope: ${result.command_budget.scope}`,
    `Wall clock: ${seconds(result.profile_summary.wall_clock_ms)} (budget ${seconds(result.command_budget.budget_wall_clock_ms)}, baseline ${seconds(result.command_budget.baseline_wall_clock_ms)})`,
    `Result: ${result.profile_summary.success ? 'pass' : 'fail'} (${result.profile_summary.total_files} files, ${result.profile_summary.total_tests} tests, ${result.profile_summary.failed_tests} failed)`
  ];

  if (result.diagnostics.length) {
    lines.push('', `Diagnostics (top ${Math.min(limit, result.diagnostics.length)}):`);
    for (const diagnostic of result.diagnostics.slice(0, limit)) {
      lines.push(`- ${diagnostic.message}`);
      if (diagnostic.kind === 'slow_file') {
        lines.push(`  Action: inspect this file with \`npm run test:profile:slow -- --limit=10 ${diagnostic.file}\`; fix avoidable setup or update the baseline with rationale when the slower production-path proof is intentional.`);
      } else {
        lines.push('  Action: rerun the relevant profile, inspect the slowest files, and either fix avoidable slowdown or update the checked-in baseline with reviewer-visible rationale.');
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }

  const baseline = readJson(args.baseline, cwd);
  const commandName = args.profile || args.command;
  const run = args.profile
    ? runProfile(args.profile, cwd)
    : {
        profile: normalizeProfile(readJson(args.input, cwd), {
          cwd,
          command: args.command ? baselineCommandLabel(args.command) : 'input report'
        }),
        status: 0,
        stderr: ''
      };
  const resolvedCommand = commandName || commandFromProfile(run.profile);
  if (!resolvedCommand) {
    throw new Error('Unable to infer command budget from input; pass --command <fast|integration|full>');
  }

  const result = compareRuntime(run.profile, baseline, resolvedCommand);
  if (run.status !== 0) {
    result.ok = false;
    result.diagnostics.push({
      kind: 'test_failure',
      command: resolvedCommand,
      message: `${resolvedCommand} test command exited ${run.status}${run.stderr.trim() ? `: ${run.stderr.trim()}` : ''}`
    });
  }

  process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatResult(result, args.limit));
  return result.ok ? 0 : 1;
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
  normalizeProfile,
  compareRuntime,
  formatResult,
  main
};
