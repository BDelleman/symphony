#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const { resolveLocalVitestBin } = require('./profile-slow-tests.js');

const ERROR_CODE = 'vitest_group_failed';

const INTEGRATION_TEST_FILES = [
  {
    file: 'tests/cli/local-multi-project-trial.test.ts',
    reason: 'process-heavy local multi-project simulation; slowest profiled file at 87.39s'
  },
  {
    file: 'tests/runtime/bootstrap.test.ts',
    reason: 'runtime bootstrap and git-backed startup simulation; profiled at 53.21s'
  },
  {
    file: 'tests/cli/meta-check-scripts.test.ts',
    reason: 'git/worktree PR metadata simulation; profiled at 24.28s'
  },
  {
    file: 'tests/runtime/update-manager.test.ts',
    reason: 'git/worktree update-manager simulation; profiled at 18.93s'
  },
  {
    file: 'tests/cli/local-command-router.test.ts',
    reason: 'real CLI, temp git repositories, and generated worktree materialization; profiled at 14.64s'
  },
  {
    file: 'tests/api/server-state.test.ts',
    reason: 'server control-plane state simulation with worktree/process-heavy cases; profiled at 5.96s'
  },
  {
    file: 'tests/cli/doctor-mvp-scenario-matrix.test.ts',
    reason: 'real CLI scenario matrix over blocker/pass/warning worktree states; profiled at 5.29s'
  },
  {
    file: 'tests/cli/workspace-before-remove.test.ts',
    reason: 'workspace cleanup hook and git/worktree safety simulation; profiled at 2.44s'
  },
  {
    file: 'tests/cli/worktree-bootstrap.test.ts',
    reason: 'worktree bootstrap command simulation; profiled at 2.01s'
  }
];

function usage() {
  process.stdout.write(
    [
      'Usage: node scripts/run-vitest-group.js <fast|integration|full> [vitest args...]',
      '',
      'Groups:',
      '  fast         Run deterministic unit tests and exclude profiled simulation-heavy files.',
      '  integration  Run the profiled git/worktree/process-heavy simulation files.',
      '  full         Run the complete Vitest suite.',
      '',
      'Options:',
      '  --list       Print the integration files moved out of the fast path.',
      '  --help       Show this help message.'
    ].join('\n')
  );
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const list = rest.includes('--list');
  const help = mode === '--help' || mode === '-h' || rest.includes('--help') || rest.includes('-h');
  const vitestArgs = rest.filter((arg) => arg !== '--list' && arg !== '--help' && arg !== '-h');
  return { mode, list, help, vitestArgs };
}

function buildVitestArgs(mode, extraArgs = []) {
  if (mode === 'fast') {
    return [
      'run',
      ...INTEGRATION_TEST_FILES.map(({ file }) => `--exclude=${file}`),
      ...extraArgs
    ];
  }

  if (mode === 'integration') {
    return ['run', ...INTEGRATION_TEST_FILES.map(({ file }) => file), ...extraArgs];
  }

  if (mode === 'full') {
    return ['run', ...extraArgs];
  }

  throw new Error(`Unknown test group "${mode}". Expected fast, integration, or full.`);
}

function formatMovedFiles() {
  return [
    'Simulation-heavy files excluded from the fast unit path:',
    ...INTEGRATION_TEST_FILES.map(({ file, reason }) => `- ${file}: ${reason}`)
  ].join('\n');
}

function run(argv = process.argv.slice(2), options = {}) {
  const cwd = options.cwd || process.cwd();
  const parsed = parseArgs(argv);

  if (parsed.help || !parsed.mode) {
    usage();
    return 0;
  }

  if (parsed.list) {
    process.stdout.write(`${formatMovedFiles()}\n`);
    if (!parsed.vitestArgs.length) {
      return 0;
    }
  }

  const vitestArgs = buildVitestArgs(parsed.mode, parsed.vitestArgs);
  const vitestBin = resolveLocalVitestBin(cwd);
  const result = spawnSync(vitestBin, vitestArgs, {
    cwd,
    env: process.env,
    shell: process.platform === 'win32',
    stdio: 'inherit'
  });

  if (result.error) {
    throw result.error;
  }

  return typeof result.status === 'number' ? result.status : 1;
}

if (require.main === module) {
  try {
    process.exitCode = run();
  } catch (error) {
    process.stderr.write(`${ERROR_CODE}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ERROR_CODE,
  INTEGRATION_TEST_FILES,
  buildVitestArgs,
  formatMovedFiles,
  parseArgs,
  run
};
