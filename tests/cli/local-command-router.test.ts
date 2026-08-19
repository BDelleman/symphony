import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  bindDashboardSupervisorSignalForwarding,
  runCommandRouter,
  type CommandRouterDependencies,
  type DashboardLaunchContext,
  type LinkLocalRunOptions,
  type DashboardSupervisorSignal
} from '../../src/runtime/command-router';
import { resolveLocalCommand } from '../../src/runtime/local-command-resolver';
import {
  buildSetupConsentRecord,
  createFileSetupConsentStore,
  persistSetupConsent,
  type SetupConsentStore,
  type SetupConsentStorePayload,
  type WorkflowPosture
} from '../../src/runtime/setup-consent';
import { materializeWorkflowPlan, validateWorkflowContent } from '../../src/workflow/materializer';
import { WorkflowLoader } from '../../src/workflow/loader';
import { ConfigResolver } from '../../src/workflow/resolver';
import { createWorkspaceProvisioner } from '../../src/workspace/provisioner';

const execFileAsync = promisify(execFile);
const realCliScript = path.join(process.cwd(), 'scripts', 'symphony.js');

function createMemoryConsentStore(storePath = path.join(os.tmpdir(), 'symphony-user-state', 'setup-consent.json')) {
  let payload: SetupConsentStorePayload = { version: 1, records: [] };
  const store: SetupConsentStore = {
    path: storePath,
    read: () => payload,
    write: (next) => {
      payload = next;
    }
  };
  return {
    store,
    records: () => payload.records
  };
}

const HIGH_TRUST_POSTURE: WorkflowPosture = {
  posture: 'high-trust',
  reason: 'workflow effective codex sandbox posture requires danger-full-access local execution',
  evidence: {
    thread_sandbox: 'danger-full-access',
    turn_sandbox_policy: 'danger-full-access'
  }
};

const VALID_WORKFLOW = ['---', 'tracker:', '  kind: memory', 'codex:', '  command: codex', '---', 'workflow'].join('\n');
const ENV_BACKED_LINEAR_WORKFLOW = [
  '---',
  'tracker:',
  '  kind: linear',
  '  api_key: $DOCTOR_ONLY_LINEAR_TOKEN',
  '  project_slug: DEMO',
  'codex:',
  '  command: codex',
  '---',
  'workflow'
].join('\n');

function createHarness(overrides: { packageVersion?: string; repoRoot?: string } = {}) {
  let stdout = '';
  let stderr = '';
  const unexpectedPromptInitInputs: CommandRouterDependencies['promptInitInputs'] = async () => {
    throw new Error('unexpected init prompt');
  };
  const unexpectedPromptInitOverwrite: CommandRouterDependencies['promptInitOverwrite'] = async () => {
    throw new Error('unexpected init overwrite prompt');
  };
  const dashboardCalls: string[][] = [];
  const dashboardContexts: Array<{ cwd: string; envFilePath: string; repoRoot: string }> = [];
  const linkLocalCalls: string[][] = [];
  const envFileLoads: string[] = [];
  const consent = createMemoryConsentStore();

  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    dashboardCalls,
    dashboardContexts,
    linkLocalCalls,
    envFileLoads,
    consent,
    deps: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
      runDashboard: async (argv: readonly string[], context: DashboardLaunchContext) => {
        dashboardCalls.push([...argv]);
        dashboardContexts.push({
          cwd: context.cwd,
          envFilePath: context.envFilePath,
          repoRoot: context.repoRoot
        });
        return 27;
      },
      runLinkLocal: async (argv: readonly string[]) => {
        linkLocalCalls.push([...argv]);
        return 28;
      },
      loadEnvFile: (envFilePath: string) => {
        envFileLoads.push(envFilePath);
      },
      materializeWorkflowPlan,
      setupConsentStore: consent.store,
      resolveWorkflowPosture: () => HIGH_TRUST_POSTURE,
      promptSetupConsent: async () => false,
      promptInitOverwrite: unexpectedPromptInitOverwrite,
      promptInitInputs: unexpectedPromptInitInputs,
      clock: () => new Date('2026-05-24T20:00:00.000Z'),
      packageVersion: overrides.packageVersion ?? '9.8.7',
      repoRoot: overrides.repoRoot ?? '/repo/symphony',
      cwd: process.cwd(),
      env: {},
      stdinIsTTY: () => false,
      stdoutIsTTY: () => false
    }
  };
}

async function createDoctorRepo(): Promise<{ repoRoot: string; binDir: string; shimPath: string }> {
  const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-doctor-repo-')));
  await fs.mkdir(path.join(repoRoot, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'dist', 'src', 'runtime'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'scripts', 'symphony.js'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(path.join(repoRoot, 'scripts', 'start-dashboard-supervisor.js'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(path.join(repoRoot, 'dist', 'src', 'runtime', 'command-router.js'), 'module.exports = {};\n', 'utf8');
  const binDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-doctor-bin-')));
  const shimPath = path.join(binDir, 'symphony');
  await fs.writeFile(path.join(binDir, 'codex'), '#!/usr/bin/env bash\nexit 0\n', { encoding: 'utf8', mode: 0o755 });
  await fs.writeFile(
    shimPath,
    [
      '#!/usr/bin/env bash',
      '# symphony-local-shim',
      '# symphony-shim-version: 1',
      `# symphony-repo-root: ${repoRoot}`,
      `# symphony-entrypoint: ${path.join(repoRoot, 'scripts', 'symphony.js')}`,
      'exit 0',
      ''
    ].join('\n'),
    { encoding: 'utf8', mode: 0o755 }
  );
  return { repoRoot, binDir, shimPath };
}

async function createDoctorProject(workflowContent = VALID_WORKFLOW): Promise<string> {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-doctor-project-')));
  await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), workflowContent, 'utf8');
  await fs.writeFile(path.join(projectRoot, '.gitignore'), '.symphony/system/\n', 'utf8');
  return projectRoot;
}

async function writeExecutable(filePath: string, content = '#!/usr/bin/env bash\nexit 0\n'): Promise<void> {
  await fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o755 });
}

async function writeFakeCodexAppServer(binDir: string, visibleSkillNames: string[]): Promise<void> {
  await writeExecutable(
    path.join(binDir, 'codex'),
    [
      `#!${process.execPath}`,
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      'rl.on("line", (line) => {',
      '  let message;',
      '  try { message = JSON.parse(line); } catch { return; }',
      '  if (message.method === "initialize") {',
      '    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "fake-codex", codexHome: process.cwd(), platformFamily: "unix", platformOs: "macos" } }) + "\\n");',
      '  }',
      '  if (message.method === "skills/list") {',
      '    const cwd = message.params && Array.isArray(message.params.cwds) ? message.params.cwds[0] : process.cwd();',
      `    const names = ${JSON.stringify(visibleSkillNames)};`,
      '    process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ cwd, skills: names.map((name) => ({ name, description: name, path: cwd + "/.codex/skills/" + name + "/SKILL.md", scope: "repo", enabled: true })), errors: [] }] } }) + "\\n");',
      '  }',
      '});',
      ''
    ].join('\n')
  );
}

function projectLocalSkillsWorkflow(skillIds: string[]): string {
  return [
    '---',
    'symphony:',
    '  generated_profile:',
    '    profile: "solo-local"',
    '    bundle: "memory-generic"',
    '    packs:',
    '      - "tracker:memory"',
    '    portable_skills:',
    ...skillIds.flatMap((skillId) => [
      `      - name: "${skillId}"`,
      `        path: ".codex/skills/${skillId}/"`
    ]),
    'tracker:',
    '  kind: memory',
    'codex:',
    '  command: codex app-server',
    '---',
    'workflow'
  ].join('\n');
}

async function installProjectSkill(projectRoot: string, skillId: string, helpers: string[] = []): Promise<void> {
  const skillRoot = path.join(projectRoot, '.codex', 'skills', skillId);
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), `# ${skillId}\n`, 'utf8');
  for (const helper of helpers) {
    const helperPath = path.join(projectRoot, helper);
    await fs.mkdir(path.dirname(helperPath), { recursive: true });
    await fs.writeFile(helperPath, '#!/usr/bin/env bash\nexit 0\n', { encoding: 'utf8', mode: 0o755 });
  }
}

async function createInitGitRepo(prefix = 'symphony-init-real-cli-'): Promise<string> {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  await execFileAsync('git', ['init'], { cwd: projectRoot });
  return projectRoot;
}

function runRealInit(projectRoot: string, argv: string[], input?: string) {
  return spawnSync(process.execPath, [realCliScript, 'init', ...argv], {
    cwd: projectRoot,
    input,
    encoding: 'utf8'
  });
}

function runRealDoctor(projectRoot: string) {
  return spawnSync(process.execPath, [realCliScript, 'doctor', '--json', '--ci'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      LINEAR_API_KEY: 'generated-validation-placeholder',
      GITHUB_TOKEN: 'generated-validation-placeholder',
      SYMPHONY_USER_STATE_DIR: path.join(projectRoot, '.tmp-user-state')
    }
  });
}

async function expectGeneratedWorkflowValid(projectRoot: string, expectedBundle: string) {
  const workflowPath = path.join(projectRoot, 'WORKFLOW.md');
  const workflow = await fs.readFile(workflowPath, 'utf8');
  expect(validateWorkflowContent(workflow, workflowPath)).toMatchObject({ ok: true });
  expect(workflow).toContain('symphony-generated-profile');
  expect(workflow).toContain(`bundle: "${expectedBundle}"`);
  expect(workflow).toContain(`bundle=${expectedBundle}`);
  expect(workflow).not.toMatch(/Agent Review|Human Review|Merging|workflow:symphony-internal/);
}

function expectDoctorGeneratedProfileProvenance(result: ReturnType<typeof spawnSync>, expectedBundle: string) {
  const stdout = result.stdout.toString();
  expect(stdout).not.toBe('');
  const payload = JSON.parse(stdout) as {
    findings: Array<{
      id: string;
      reason: string;
      details: { bundle?: string; runtimeLoadingBehavior?: string };
    }>;
  };
  const finding = payload.findings.find((candidate) => candidate.id === 'customization.generated_profile');
  expect(finding).toMatchObject({
    reason: 'generated_profile_provenance_recorded',
    details: {
      bundle: expectedBundle,
      runtimeLoadingBehavior: 'observable_only'
    }
  });
}

function listenOnLocalhost(port = 0): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('expected TCP address'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function doctorFinding(payload: { findings: Array<{ id: string }> }, id: string) {
  const found = payload.findings.find((finding) => finding.id === id);
  expect(found, `missing doctor finding ${id}`).toBeTruthy();
  return found!;
}

describe('local symphony command router', () => {
  it('prints top-level help with supported commands', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({ argv: ['--help'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('symphony <command> [options]');
    expect(harness.stdout).toContain('dashboard');
    expect(harness.stdout).toContain('doctor');
    expect(harness.stdout).toContain('setup           Record user-local setup consent for this workflow');
    expect(harness.stdout).not.toContain('Reserved for future local setup consent and configuration');
    expect(harness.stdout).toContain('profile');
    expect(harness.stdout).toContain('init');
    expect(harness.stdout).toContain('link-local');
    expect(harness.stderr).toBe('');
  });

  it('prints the package version', async () => {
    const harness = createHarness({ packageVersion: '1.2.3' });

    const exitCode = await runCommandRouter({ argv: ['--version'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toBe('1.2.3\n');
    expect(harness.stderr).toBe('');
  });

  it('prints dashboard command help without resolving or starting the dashboard', async () => {
    const harness = createHarness();
    const guardedDeps: Partial<CommandRouterDependencies> = {
      ...harness.deps,
      resolveLocalCommand: () => {
        throw new Error('unexpected dashboard resolver call');
      },
      loadEnvFile: () => {
        throw new Error('unexpected env file load');
      },
      runDashboard: async () => {
        throw new Error('unexpected dashboard startup');
      }
    };

    const longHelpExitCode = await runCommandRouter({
      argv: ['dashboard', '--help'],
      deps: guardedDeps
    });
    const longHelpOutput = harness.stdout;

    expect(longHelpExitCode).toBe(0);
    expect(longHelpOutput).toContain('Symphony dashboard');
    expect(longHelpOutput).toContain('symphony dashboard [workflow-path] [options]');
    expect(longHelpOutput).toContain('symphony dashboard --workflow <path> [options]');
    expect(longHelpOutput).toContain('--workflow <path>');
    expect(longHelpOutput).toContain('--port <port>');
    expect(longHelpOutput).toContain('--host <host>');
    expect(longHelpOutput).toContain('--env-file <path>');
    expect(longHelpOutput).toContain('--profile <name>');
    expect(longHelpOutput).toContain('--offline');
    expect(longHelpOutput).toContain('--logs-root <path>');
    expect(harness.dashboardCalls).toEqual([]);
    expect(harness.envFileLoads).toEqual([]);
    expect(harness.stderr).toBe('');

    const shortHelpHarness = createHarness();
    const shortHelpExitCode = await runCommandRouter({
      argv: ['dashboard', '-h'],
      deps: {
        ...guardedDeps,
        stdout: shortHelpHarness.deps.stdout,
        stderr: shortHelpHarness.deps.stderr
      }
    });

    expect(shortHelpExitCode).toBe(0);
    expect(shortHelpHarness.stdout).toBe(longHelpOutput);
    expect(shortHelpHarness.stderr).toBe('');
  });

  it('lists bounded profiles including symphony-internal', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({ argv: ['profile', 'list'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Symphony profile registry');
    expect(harness.stdout).toContain('tracker:linear');
    expect(harness.stdout).toContain('tracker:github');
    expect(harness.stdout).toContain('tracker:memory');
    expect(harness.stdout).toContain('workspace:worktree');
    expect(harness.stdout).toContain('toolchain:node');
    expect(harness.stdout).toContain('workflow:team-review');
    expect(harness.stdout).toContain('symphony-internal');
    expect(harness.stdout).toContain('checked-in WORKFLOW.md');
    expect(harness.stdout).toContain('linear-node');
    expect(harness.stdout).toContain('expands: tracker:linear, workspace:worktree, toolchain:node, workflow:solo-local');
    expect(harness.stdout).toContain('github-node');
    expect(harness.stdout).toContain('Select exactly one pack for each required dimension');
    expect(harness.stderr).toBe('');
  });

  it('shows visible bundle expansion and validation metadata', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({ argv: ['profile', 'show', 'linear-node'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Bundle: linear-node');
    expect(harness.stdout).toContain('Expands to: tracker:linear, workspace:worktree, toolchain:node, workflow:solo-local');
    expect(harness.stdout).toContain('bundle expansions:');
    expect(harness.stdout).toContain('linear-node -> tracker:linear, workspace:worktree, toolchain:node, workflow:solo-local');
    expect(harness.stdout).toContain('tracker: tracker:linear');
    expect(harness.stdout).toContain('errors: none');
    expect(harness.stderr).toBe('');
  });

  it('shows pack metadata and required-dimension validation output', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({ argv: ['profile', 'show', 'tracker:memory'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Pack: tracker:memory');
    expect(harness.stdout).toContain('Dimension: tracker');
    expect(harness.stdout).toContain('Intended use: Local and demo workflows');
    expect(harness.stdout).toContain('Conflicts: tracker:linear, tracker:github');
    expect(harness.stdout).toContain('Missing required workspace pack');
    expect(harness.stdout).toContain('Missing required toolchain pack');
    expect(harness.stdout).toContain('Missing required workflow pack');
    expect(harness.stdout).not.toContain('memory-demo');
    expect(harness.stderr).toBe('');
  });

  it('shows symphony-internal as the protected checked-in workflow binding', async () => {
    const repoRoot = '/repo/symphony';
    const harness = createHarness({ repoRoot });

    const exitCode = await runCommandRouter({
      argv: ['profile', 'show', 'symphony-internal'],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Profile: symphony-internal');
    expect(harness.stdout).toContain('Type: protected');
    expect(harness.stdout).toContain('Pack: workflow:symphony-internal');
    expect(harness.stdout).toContain(path.join(repoRoot, 'WORKFLOW.md'));
    expect(harness.stdout).toContain('checked-in Symphony WORKFLOW.md');
    expect(harness.stdout).toContain('not a generated workflow template');
    expect(harness.stdout).toContain('Protected: yes');
    expect(harness.stdout).toContain('must not generate templates');
    expect(harness.stderr).toBe('');
  });

  it('prints init help with materialization options and safety semantics', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({ argv: ['init', '--help'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('symphony init --help');
    expect(harness.stdout).toContain('symphony init --bundle memory-generic');
    expect(harness.stdout).toContain('symphony init --dry-run --bundle memory-generic');
    expect(harness.stdout).toContain('symphony init --force-skills --bundle memory-generic');
    expect(harness.stdout).toContain('symphony init --dry-run --bundle memory-generic --skill commit --skill land');
    expect(harness.stdout).toContain('symphony init --dry-run --bundle memory-generic --no-skills');
    expect(harness.stdout).toContain('Use --skill <name> repeatedly or --skills <name,name> to select an explicit set.');
    expect(harness.stdout).toContain('Use --no-skills to opt out of project-local skill materialization.');
    expect(harness.stdout).toContain('interactive confirmation or --force');
    expect(harness.stdout).toContain('Use --force-skills to overwrite only');
    expect(harness.stdout).toContain('Dry-run renders the same file plan without writing files');
    expect(harness.stderr).toBe('');
  });

  it('renders memory generic init dry-run file plan without writing files', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-dry-run-')));
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run', '--bundle', 'memory-generic'],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Symphony init dry-run file plan');
    expect(harness.stdout).toContain('Selected packs: tracker:memory, workspace:none, toolchain:generic, workflow:solo-local');
    expect(harness.stdout).toContain('Bundle provenance: memory-generic -> tracker:memory, workspace:none, toolchain:generic, workflow:solo-local');
    expect(harness.stdout).toContain('Validation: ok');
    expect(harness.stdout).toContain('Writes performed: no');
    expect(harness.stdout).toContain('would_write: yes');
    expect(harness.stdout).toContain('WORKFLOW.md');
    expect(harness.stdout).toContain('.codex/skills/commit/SKILL.md');
    expect(harness.stdout).toContain('.codex/skills/land/SKILL.md');
    expect(harness.stdout).toContain('.codex/skills/land/scripts/land_watch.py');
    expect(harness.stdout).not.toContain('.symphony/skills/');
    expect(harness.stdout).toContain('<!-- symphony-generated-profile: profile=solo-local; bundle=memory-generic; packs=tracker:memory,workspace:none,toolchain:generic,workflow:solo-local;');
    expect(harness.stdout).not.toContain('workflow:symphony-internal');
    await expect(fs.access(path.join(projectRoot, 'WORKFLOW.md'))).rejects.toThrow();
    await expect(fs.access(path.join(projectRoot, '.symphony'))).rejects.toThrow();
    await expect(fs.access(path.join(projectRoot, '.codex'))).rejects.toThrow();
    expect(harness.stderr).toBe('');
  });

  it('renders explicitly selected portable skills and helper scripts in dry-run output', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-skills-')));
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run', '--bundle', 'memory-generic', '--skill', 'linear-ui-evidence', '--skill', 'land'],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Portable skills: linear-ui-evidence, land');
    expect(harness.stdout).toContain('.codex/skills/linear-ui-evidence/SKILL.md');
    expect(harness.stdout).toContain('.codex/skills/linear-ui-evidence/scripts/publish-linear-ui-evidence.js');
    expect(harness.stdout).toContain('.codex/skills/land/scripts/land_watch.py');
    expect(harness.stdout).not.toContain('.codex/skills/commit/SKILL.md');
    await expect(fs.access(path.join(projectRoot, '.codex'))).rejects.toThrow();
    expect(harness.stderr).toBe('');
  });

  it('supports no-skills dry-run mode without prompting', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-no-skills-')));
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run', '--no-input', '--bundle', 'memory-generic', '--no-skills'],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Portable skills: (none)');
    expect(harness.stdout).not.toContain('.codex/skills/');
    expect(harness.stderr).toBe('');
  });

  it('fails closed for unknown portable skill names before prompting', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-bad-skill-')));
    const harness = createHarness();
    harness.deps.cwd = projectRoot;
    harness.deps.stdinIsTTY = () => true;
    harness.deps.stdoutIsTTY = () => true;
    let prompted = false;
    harness.deps.promptInitInputs = async () => {
      prompted = true;
      throw new Error('unexpected init prompt');
    };

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run', '--bundle', 'memory-generic', '--skill', 'missing-skill'],
      deps: harness.deps
    });

    expect(exitCode).toBe(1);
    expect(prompted).toBe(false);
    expect(harness.stderr).toContain("Unknown portable skill 'missing-skill'. Choose one of:");
  });

  it('marks existing portable skill dry-run destinations as conflicts', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-skill-conflict-')));
    const harness = createHarness();
    harness.deps.cwd = projectRoot;
    await fs.mkdir(path.join(projectRoot, '.codex', 'skills', 'commit'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.codex', 'skills', 'commit', 'SKILL.md'), 'existing local skill\n', 'utf8');

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run', '--bundle', 'memory-generic', '--skills', 'commit'],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('.codex/skills/commit/SKILL.md');
    expect(harness.stdout).toContain('action: overwrite');
    expect(harness.stdout).toContain('overwrite: exists');
    expect(harness.stdout).toContain('overwrite_approval_required: yes');
    expect(await fs.readFile(path.join(projectRoot, '.codex', 'skills', 'commit', 'SKILL.md'), 'utf8')).toBe(
      'existing local skill\n'
    );
    expect(harness.stderr).toBe('');
  });

  it('prompts for missing init selections when an interactive TTY is available', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-interactive-')));
    const harness = createHarness();
    harness.deps.cwd = projectRoot;
    harness.deps.stdinIsTTY = () => true;
    harness.deps.stdoutIsTTY = () => true;
    harness.deps.promptInitInputs = async ({ parsed }) => ({
      selections: [...parsed.selections, 'tracker:memory', 'workspace:none', 'toolchain:generic', 'workflow:solo-local'],
      linearProjectSlug: parsed.linearProjectSlug,
      githubOwner: parsed.githubOwner,
      githubRepo: parsed.githubRepo
    });

    const exitCode = await runCommandRouter({ argv: ['init', '--dry-run'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Symphony init dry-run file plan');
    expect(harness.stdout).toContain('Selected packs: tracker:memory, workspace:none, toolchain:generic, workflow:solo-local');
    expect(harness.stdout).toContain('Validation: ok');
    expect(harness.stderr).toBe('');
  });

  it('writes memory generic init files through the real CLI in a temporary git repository', async () => {
    const projectRoot = await createInitGitRepo();

    const result = runRealInit(projectRoot, ['--bundle', 'memory-generic']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Symphony init write complete');
    expect(result.stdout).toContain('Validation: ok');
    expect(await fs.readFile(path.join(projectRoot, 'WORKFLOW.md'), 'utf8')).toContain('symphony-generated-profile');
    expect(await fs.readFile(path.join(projectRoot, '.symphony', 'system', '.gitignore'), 'utf8')).toBe('*\n!.gitignore\n');
    expect(await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8')).toBe('.symphony/system/\n');
    await expect(fs.access(path.join(projectRoot, '.symphony', 'config.yaml'))).rejects.toThrow();
  });

  it('writes selected project-local skills with helper scripts through init', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-write-skills-');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['init', '--bundle', 'memory-generic', '--skills', 'commit,land', '--no-input'],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(harness.stderr).toBe('');
    expect(harness.stdout).toContain('Symphony init write complete');
    expect(harness.stdout).toContain('.codex/skills/commit/SKILL.md: create written');
    expect(harness.stdout).toContain('.codex/skills/land/scripts/land_watch.py: create written');
    expect(await fs.readFile(path.join(projectRoot, '.codex', 'skills', 'commit', 'SKILL.md'), 'utf8')).toContain(
      '# Commit'
    );
    expect(await fs.readFile(path.join(projectRoot, '.codex', 'skills', 'land', 'scripts', 'land_watch.py'), 'utf8')).toContain(
      'async def watch_pr'
    );
    expect((await fs.stat(path.join(projectRoot, '.codex', 'skills', 'land', 'scripts', 'land_watch.py'))).mode & 0o777).toBe(
      0o755
    );
    await expect(fs.access(path.join(projectRoot, '.symphony', 'skills'))).rejects.toThrow();
  });

  it('fails closed for customized project-local skills in non-interactive init', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-skill-conflict-write-');
    const firstHarness = createHarness();
    firstHarness.deps.cwd = projectRoot;
    const first = await runCommandRouter({
      argv: ['init', '--bundle', 'memory-generic', '--skills', 'commit', '--no-input'],
      deps: firstHarness.deps
    });
    expect(first).toBe(0);
    await fs.writeFile(path.join(projectRoot, '.codex', 'skills', 'commit', 'SKILL.md'), 'custom local skill\n', 'utf8');
    const secondHarness = createHarness();
    secondHarness.deps.cwd = projectRoot;

    const second = await runCommandRouter({
      argv: ['init', '--bundle', 'memory-generic', '--skills', 'commit', '--no-input'],
      deps: secondHarness.deps
    });

    expect(second).toBe(1);
    expect(secondHarness.stderr).toContain('Symphony init found existing files that would be overwritten');
    expect(secondHarness.stderr).toContain('.codex/skills/commit/SKILL.md');
    expect(secondHarness.stderr).toContain('--force-skills for .codex/skills conflicts only');
    expect(await fs.readFile(path.join(projectRoot, '.codex', 'skills', 'commit', 'SKILL.md'), 'utf8')).toBe(
      'custom local skill\n'
    );
  });

  it('force-overwrites selected skills without pruning extra user files', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-force-skills-');
    const firstHarness = createHarness();
    firstHarness.deps.cwd = projectRoot;
    const first = await runCommandRouter({
      argv: ['init', '--bundle', 'memory-generic', '--skills', 'commit', '--no-input'],
      deps: firstHarness.deps
    });
    expect(first).toBe(0);
    const skillPath = path.join(projectRoot, '.codex', 'skills', 'commit', 'SKILL.md');
    const extraPath = path.join(projectRoot, '.codex', 'skills', 'commit', 'notes.local.md');
    await fs.writeFile(skillPath, 'custom local skill\n', 'utf8');
    await fs.writeFile(extraPath, 'keep me\n', 'utf8');
    const forcedHarness = createHarness();
    forcedHarness.deps.cwd = projectRoot;

    const forced = await runCommandRouter({
      argv: ['init', '--bundle', 'memory-generic', '--skills', 'commit', '--force-skills', '--no-input'],
      deps: forcedHarness.deps
    });

    expect(forced).toBe(0);
    expect(forcedHarness.stderr).toBe('');
    expect(await fs.readFile(skillPath, 'utf8')).toContain('# Commit');
    expect(await fs.readFile(extraPath, 'utf8')).toBe('keep me\n');
    await expect(fs.access(path.join(projectRoot, '.symphony', 'skills'))).rejects.toThrow();
  });

  it('keeps skill-scoped force from overwriting unrelated init files', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-force-skills-scoped-');
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'custom workflow\n', 'utf8');
    await fs.mkdir(path.join(projectRoot, '.codex', 'skills', 'commit'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.codex', 'skills', 'commit', 'SKILL.md'), 'custom skill\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const result = await runCommandRouter({
      argv: ['init', '--bundle', 'memory-generic', '--skills', 'commit', '--force-skills', '--no-input'],
      deps: harness.deps
    });

    expect(result).toBe(1);
    expect(harness.stderr).toContain('WORKFLOW.md');
    expect(harness.stderr).not.toContain('.codex/skills/commit/SKILL.md');
    expect(await fs.readFile(path.join(projectRoot, 'WORKFLOW.md'), 'utf8')).toBe('custom workflow\n');
    expect(await fs.readFile(path.join(projectRoot, '.codex', 'skills', 'commit', 'SKILL.md'), 'utf8')).toBe(
      'custom skill\n'
    );
  });

  it('refuses skill destinations that resolve outside the project through symlinks', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-skill-symlink-');
    const escapeRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-skill-escape-')));
    await fs.mkdir(path.join(projectRoot, '.codex', 'skills'), { recursive: true });
    await fs.symlink(escapeRoot, path.join(projectRoot, '.codex', 'skills', 'commit'), 'dir');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const result = await runCommandRouter({
      argv: ['init', '--bundle', 'memory-generic', '--skills', 'commit', '--force-skills', '--no-input'],
      deps: harness.deps
    });

    expect(result).toBe(1);
    expect(harness.stderr).toContain('portable skill destination .codex/skills/commit escapes');
    await expect(fs.access(path.join(escapeRoot, 'SKILL.md'))).rejects.toThrow();
    await expect(fs.access(path.join(projectRoot, '.symphony'))).rejects.toThrow();
  });

  it('refuses skill destinations that resolve outside the skill tree through internal symlinks', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-skill-internal-symlink-');
    await fs.mkdir(path.join(projectRoot, 'docs'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'docs', 'SKILL.md'), 'custom docs skill\n', 'utf8');
    await fs.mkdir(path.join(projectRoot, '.codex', 'skills'), { recursive: true });
    await fs.symlink(path.join('..', '..', 'docs'), path.join(projectRoot, '.codex', 'skills', 'commit'), 'dir');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const result = await runCommandRouter({
      argv: ['init', '--bundle', 'memory-generic', '--skills', 'commit', '--force-skills', '--no-input'],
      deps: harness.deps
    });

    expect(result).toBe(1);
    expect(harness.stderr).toContain('portable skill destination .codex/skills/commit/SKILL.md escapes');
    expect(await fs.readFile(path.join(projectRoot, 'docs', 'SKILL.md'), 'utf8')).toBe('custom docs skill\n');
    await expect(fs.access(path.join(projectRoot, '.symphony'))).rejects.toThrow();
  });

  it('reports directory skill-file conflicts without raw filesystem errors', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-skill-directory-conflict-');
    await fs.mkdir(path.join(projectRoot, '.codex', 'skills', 'commit', 'SKILL.md'), { recursive: true });
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const result = await runCommandRouter({
      argv: ['init', '--bundle', 'memory-generic', '--skills', 'commit', '--force-skills', '--no-input'],
      deps: harness.deps
    });

    expect(result).toBe(1);
    expect(harness.stderr).toContain('Symphony init found existing files that would be overwritten');
    expect(harness.stderr).toContain('.codex/skills/commit/SKILL.md');
    expect(harness.stderr).toContain('Some conflicting paths are directories');
    expect(harness.stderr).toContain('Move or remove those directories before rerunning init');
    expect(harness.stderr).not.toContain('EISDIR');
    await expect(fs.access(path.join(projectRoot, 'WORKFLOW.md'))).rejects.toThrow();
  });

  it('does not prompt for directory skill-file conflicts in interactive init', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-skill-directory-interactive-');
    await fs.mkdir(path.join(projectRoot, '.codex', 'skills', 'commit', 'SKILL.md'), { recursive: true });
    const harness = createHarness();
    harness.deps.cwd = projectRoot;
    harness.deps.stdinIsTTY = () => true;
    harness.deps.stdoutIsTTY = () => true;
    let prompted = false;
    harness.deps.promptInitOverwrite = async () => {
      prompted = true;
      return true;
    };

    const result = await runCommandRouter({
      argv: ['init', '--bundle', 'memory-generic', '--skills', 'commit'],
      deps: harness.deps
    });

    expect(result).toBe(1);
    expect(prompted).toBe(false);
    expect(harness.stderr).toContain('Symphony init found existing files that would be overwritten');
    expect(harness.stderr).toContain('.codex/skills/commit/SKILL.md');
    expect(harness.stderr).toContain('Some conflicting paths are directories');
    expect(harness.stderr).toContain('Move or remove those directories before rerunning init');
    expect(harness.stderr).not.toContain('EISDIR');
    await expect(fs.access(path.join(projectRoot, 'WORKFLOW.md'))).rejects.toThrow();
  });

  it('writes clone profile workflows through the real CLI and doctor checks the configured repo root', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-clone-write-');
    await execFileAsync('git', ['config', 'user.email', 'clone-profile@example.test'], { cwd: projectRoot });
    await execFileAsync('git', ['config', 'user.name', 'Clone Profile'], { cwd: projectRoot });
    await fs.writeFile(path.join(projectRoot, 'README.md'), 'clone profile\n', 'utf8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: projectRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: projectRoot });
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: projectRoot });

    const dryRun = runRealInit(projectRoot, [
      '--dry-run',
      '--tracker',
      'memory',
      '--workspace',
      'clone',
      '--toolchain',
      'generic',
      '--workflow',
      'solo-local'
    ]);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stderr).toBe('');
    expect(dryRun.stdout).toContain('Validation: ok');
    expect(dryRun.stdout).toContain('type: "clone"');
    expect(dryRun.stdout).toContain('repo_root: "."');
    expect(dryRun.stdout).toContain('base_ref: "main"');

    const write = runRealInit(projectRoot, [
      '--tracker',
      'memory',
      '--workspace',
      'clone',
      '--toolchain',
      'generic',
      '--workflow',
      'solo-local'
    ]);
    expect(write.status).toBe(0);
    expect(write.stderr).toBe('');
    expect(write.stdout).toContain('Validation: ok');

    const workflow = await fs.readFile(path.join(projectRoot, 'WORKFLOW.md'), 'utf8');
    expect(workflow).toContain('    type: "clone"');
    expect(workflow).toContain('    repo_root: "."');
    expect(workflow).toContain('    base_ref: "main"');
    expect(validateWorkflowContent(workflow, path.join(projectRoot, 'WORKFLOW.md'))).toMatchObject({ ok: true });
    await execFileAsync('git', ['add', 'WORKFLOW.md', '.gitignore', '.codex'], { cwd: projectRoot });
    await execFileAsync('git', ['commit', '-m', 'add generated workflow'], { cwd: projectRoot });
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: projectRoot });

    const binDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-clone-bin-')));
    await fs.writeFile(
      path.join(binDir, 'symphony'),
      [
        '#!/usr/bin/env bash',
        '# symphony-local-shim',
        '# symphony-shim-version: 1',
        `# symphony-repo-root: ${process.cwd()}`,
        `# symphony-entrypoint: ${realCliScript}`,
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(realCliScript)} "$@"`,
        ''
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 }
    );
    await writeFakeCodexAppServer(binDir, ['commit', 'pull', 'push', 'land']);
    await writeExecutable(path.join(binDir, 'gh'));
    await writeExecutable(path.join(binDir, 'uv'));
    await writeExecutable(path.join(binDir, 'python'));
    await writeExecutable(path.join(binDir, 'python3'));
    const stateHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-clone-state-')));
    const cliEnv = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      SYMPHONY_LOCAL_STATE_HOME: stateHome,
      SYMPHONY_USER_STATE_DIR: stateHome,
      LINEAR_API_KEY: 'generated-validation-placeholder',
      GITHUB_TOKEN: 'generated-validation-placeholder'
    };
    const setup = spawnSync(process.execPath, [realCliScript, 'setup', '--yes'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: cliEnv
    });
    expect(setup.status).toBe(0);

    const doctor = spawnSync(process.execPath, [realCliScript, 'doctor', '--json', '--ci'], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: cliEnv
    });
    const payload = JSON.parse(doctor.stdout.toString()) as {
      status: string;
      findings?: Array<{ id: string; status: string; reason: string; details?: Record<string, unknown> }>;
      checks?: Array<{ id: string; status: string; reason: string; details?: Record<string, unknown> }>;
    };
    const findings = payload.findings ?? payload.checks ?? [];
    expect(doctor.status, `${doctor.stdout}\n${doctor.stderr}`).toBe(0);
    expect(payload.status).toBe('ok');
    expect(findings.find((finding) => finding.id === 'workflow.effective_config')).toMatchObject({
      status: 'ok',
      reason: 'workflow_config_valid'
    });
    expect(findings.find((finding) => finding.id === 'workspace.git_repository')).toMatchObject({
      status: 'ok',
      reason: 'repo_root_git_repository',
      details: { type: 'clone', repoRoot: projectRoot }
    });
    expect(findings.find((finding) => finding.id === 'workspace.base_ref')).toMatchObject({
      status: 'ok',
      reason: 'base_ref_exists',
      details: { baseRef: 'main', source: 'clone_branch' }
    });

    const definition = new WorkflowLoader().parse(workflow);
    const effective = new ConfigResolver({ env: {}, homedir: () => projectRoot }).resolve(definition, {
      workflowPath: path.join(projectRoot, 'WORKFLOW.md')
    });
    const workspacePath = path.join(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-clone-workspace-'))), 'NIE-267');
    const provision = await createWorkspaceProvisioner(effective.workspace.provisioner).provision({
      identifier: 'NIE-267',
      workspacePath
    });
    expect(provision).toMatchObject({
      status: 'provisioned',
      provisioner_type: 'clone',
      repo_root: projectRoot,
      workspace_provisioned: true
    });
  });

  it('writes hosted Node profile workflows through the real CLI and exposes doctor provenance', async () => {
    const linearRoot = await createInitGitRepo('symphony-init-linear-node-write-');
    await fs.writeFile(path.join(linearRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    const linear = runRealInit(linearRoot, ['--bundle', 'linear-node', '--linear-project-slug', 'SMOKE']);

    expect(linear.status).toBe(0);
    expect(linear.stderr).toBe('');
    expect(linear.stdout).toContain('Symphony init write complete');
    expect(linear.stdout).toContain('Validation: ok');
    await expectGeneratedWorkflowValid(linearRoot, 'linear-node');
    expect(await fs.readFile(path.join(linearRoot, '.env.example'), 'utf8')).toContain('LINEAR_API_KEY=');
    expect(await fs.readFile(path.join(linearRoot, '.worktreeinclude'), 'utf8')).toContain('.env');
    expectDoctorGeneratedProfileProvenance(runRealDoctor(linearRoot), 'linear-node');

    const githubRoot = await createInitGitRepo('symphony-init-github-node-write-');
    await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:nielsgl/smoke-node.git'], {
      cwd: githubRoot
    });
    await fs.writeFile(path.join(githubRoot, 'package-lock.json'), '{}\n', 'utf8');
    const github = runRealInit(githubRoot, ['--bundle', 'github-node']);

    expect(github.status).toBe(0);
    expect(github.stderr).toBe('');
    expect(github.stdout).toContain('Symphony init write complete');
    expect(github.stdout).toContain('Validation: ok');
    await expectGeneratedWorkflowValid(githubRoot, 'github-node');
    expect(await fs.readFile(path.join(githubRoot, '.env.example'), 'utf8')).toContain('GITHUB_TOKEN=');
    expect(await fs.readFile(path.join(githubRoot, '.worktreeinclude'), 'utf8')).toContain('.env');
    expectDoctorGeneratedProfileProvenance(runRealDoctor(githubRoot), 'github-node');
  });

  it('refuses conflicting real CLI writes by default in a temporary git repository', async () => {
    const projectRoot = await createInitGitRepo();
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'existing policy\n', 'utf8');

    const result = runRealInit(projectRoot, ['--bundle', 'memory-generic'], '');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Symphony init found existing files that would be overwritten');
    expect(result.stderr).toContain('WORKFLOW.md');
    expect(await fs.readFile(path.join(projectRoot, 'WORKFLOW.md'), 'utf8')).toBe('existing policy\n');
    await expect(fs.access(path.join(projectRoot, '.symphony'))).rejects.toThrow();
  });

  it('refuses piped overwrite confirmation in non-interactive real CLI mode', async () => {
    const projectRoot = await createInitGitRepo();
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'existing policy\n', 'utf8');

    const result = runRealInit(projectRoot, ['--bundle', 'memory-generic'], 'yes\n');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Symphony init found existing files that would be overwritten');
    expect(result.stderr).toContain('WORKFLOW.md');
    expect(await fs.readFile(path.join(projectRoot, 'WORKFLOW.md'), 'utf8')).toBe('existing policy\n');
  });

  it('accepts explicit interactive overwrite confirmation through the command router', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-confirmed-overwrite-');
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'existing policy\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;
    harness.deps.stdinIsTTY = () => true;
    harness.deps.stdoutIsTTY = () => true;
    harness.deps.promptInitOverwrite = async (conflicts) => {
      expect(conflicts.map((conflict) => conflict.path)).toEqual(['WORKFLOW.md']);
      return true;
    };

    const result = await runCommandRouter({
      argv: ['init', '--bundle', 'memory-generic'],
      deps: harness.deps
    });

    expect(result).toBe(0);
    expect(harness.stderr).toBe('');
    expect(harness.stdout).toContain('Symphony init write complete');
    expect(await fs.readFile(path.join(projectRoot, 'WORKFLOW.md'), 'utf8')).toContain('symphony-generated-profile');
  });

  it('accepts forced real CLI overwrites and updates gitignore idempotently', async () => {
    const projectRoot = await createInitGitRepo();
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'existing policy\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, '.gitignore'), 'node_modules\n', 'utf8');

    const first = runRealInit(projectRoot, ['--force', '--bundle', 'memory-generic']);
    const second = runRealInit(projectRoot, ['--force', '--bundle', 'memory-generic']);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8')).toBe('node_modules\n.symphony/system/\n');
    expect(second.stdout).toContain('.gitignore: skip');
  });

  it('does not write files during real CLI dry-run in a temporary git repository', async () => {
    const projectRoot = await createInitGitRepo();

    const result = runRealInit(projectRoot, ['--dry-run', '--bundle', 'memory-generic']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Symphony init dry-run file plan');
    await expect(fs.access(path.join(projectRoot, 'WORKFLOW.md'))).rejects.toThrow();
    await expect(fs.access(path.join(projectRoot, '.symphony'))).rejects.toThrow();
    await expect(fs.access(path.join(projectRoot, '.gitignore'))).rejects.toThrow();
  });

  it('plans init dry-run files at the Git work tree root from a nested cwd', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-git-root-')));
    const nestedCwd = path.join(projectRoot, 'packages', 'app');
    await fs.mkdir(nestedCwd, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: projectRoot });
    const harness = createHarness();
    harness.deps.cwd = nestedCwd;

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run', '--bundle', 'memory-generic'],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain(`Project root: ${projectRoot}`);
    expect(harness.stdout).toContain('1. WORKFLOW.md');
    expect(harness.stdout).toContain(`- Project root: .`);
    expect(harness.stdout).not.toContain(`Project root: ${nestedCwd}`);
    expect(harness.stdout).not.toContain(`- Project root: ${nestedCwd}`);
    await expect(fs.access(path.join(projectRoot, 'WORKFLOW.md'))).rejects.toThrow();
    await expect(fs.access(path.join(nestedCwd, 'WORKFLOW.md'))).rejects.toThrow();
    await expect(fs.access(path.join(projectRoot, '.symphony'))).rejects.toThrow();
    expect(harness.stderr).toBe('');
  });

  it('renders stable init dry-run output for repeated runs', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-idempotent-')));
    const first = createHarness();
    first.deps.cwd = projectRoot;
    const second = createHarness();
    second.deps.cwd = projectRoot;

    expect(
      await runCommandRouter({
        argv: ['init', '--dry-run', '--bundle', 'memory-generic'],
        deps: first.deps
      })
    ).toBe(0);
    expect(
      await runCommandRouter({
        argv: ['init', '--dry-run', '--bundle', 'memory-generic'],
        deps: second.deps
      })
    ).toBe(0);

    expect(second.stdout).toBe(first.stdout);
  });

  it('supports explicit team-review generic memory dry-run selections', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-team-')));
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: [
        'init',
        '--dry-run',
        '--tracker',
        'memory',
        '--workspace',
        'none',
        '--toolchain',
        'generic',
        '--workflow',
        'team-review'
      ],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('profile=team-review');
    expect(harness.stdout).toContain('handoff_states: [\"Agent Review\"]');
    expect(harness.stdout).toContain('fresh_dispatch_states: [\"Agent Review\"]');
    expect(harness.stderr).toBe('');
  });

  it('renders Linear Node dry-run workflows with non-interactive tracker inputs', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-linear-node-');
    await fs.writeFile(path.join(projectRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run', '--bundle', 'linear-node', '--linear-project-slug', 'SYMPHONY'],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Selected packs: tracker:linear, workspace:worktree, toolchain:node, workflow:solo-local');
    expect(harness.stdout).toContain('Validation: ok');
    expect(harness.stdout).toContain('.env.example');
    expect(harness.stdout).toContain('LINEAR_API_KEY=');
    expect(harness.stdout).toContain('.worktreeinclude');
    expect(harness.stdout).toContain('project_slug: "SYMPHONY"');
    expect(harness.stdout).toContain('Package manager: pnpm');
    expect(harness.stdout).toContain('after_create: "pnpm install"');
    expect(harness.stderr).toBe('');
  });

  it('prompts for missing Linear hosted tracker input when interactive', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-linear-node-prompt-');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;
    harness.deps.stdinIsTTY = () => true;
    harness.deps.stdoutIsTTY = () => true;
    harness.deps.promptInitInputs = async ({ parsed }) => ({
      selections: [...parsed.selections],
      linearProjectSlug: 'PROMPTED',
      githubOwner: parsed.githubOwner,
      githubRepo: parsed.githubRepo
    });

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run', '--bundle', 'linear-node'],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('project_slug: "PROMPTED"');
    expect(harness.stdout).toContain('Validation: ok');
    expect(harness.stderr).toBe('');
  });

  it('fails Linear Node dry-run without hosted input in non-interactive mode', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-linear-node-missing-');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run', '--bundle', 'linear-node'],
      deps: harness.deps
    });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain('Missing required Linear project slug');
    expect(harness.stdout).toBe('');
  });

  it('detects GitHub remotes and npm lockfiles for GitHub Node dry-run workflows', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-github-node-');
    await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:nielsgl/symphony.git'], {
      cwd: projectRoot
    });
    await fs.writeFile(path.join(projectRoot, 'package-lock.json'), '{}\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run', '--bundle', 'github-node'],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Selected packs: tracker:github, workspace:worktree, toolchain:node, workflow:solo-local');
    expect(harness.stdout).toContain('Validation: ok');
    expect(harness.stdout).toContain('owner: "nielsgl"');
    expect(harness.stdout).toContain('repo: "symphony"');
    expect(harness.stdout).toContain('- GitHub owner: nielsgl (detected from git remote)');
    expect(harness.stdout).toContain('GITHUB_TOKEN=');
    expect(harness.stdout).toContain('Package manager: npm');
    expect(harness.stdout).toContain('after_create: "npm install"');
    expect(harness.stderr).toBe('');
  });

  it('fails GitHub Node dry-run without a remote or explicit owner and repo', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-github-node-missing-');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run', '--bundle', 'github-node'],
      deps: harness.deps
    });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain('Missing required GitHub owner');
    expect(harness.stderr).toContain('Missing required GitHub repo');
    expect(harness.stdout).toBe('');
  });

  it('renders GitHub Node dry-run workflows with explicit owner and repo flags', async () => {
    const projectRoot = await createInitGitRepo('symphony-init-github-node-explicit-');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run', '--bundle', 'github-node', '--github-owner', 'octo-org', '--github-repo', 'octo-repo'],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('owner: "octo-org"');
    expect(harness.stdout).toContain('repo: "octo-repo"');
    expect(harness.stdout).toContain('Validation: ok');
    expect(harness.stderr).toBe('');
  });

  it('generates workspace support files only for worktree init selections', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-workspace-files-')));

    const worktree = createHarness();
    worktree.deps.cwd = projectRoot;
    expect(
      await runCommandRouter({
        argv: [
          'init',
          '--dry-run',
          '--tracker',
          'memory',
          '--workspace',
          'worktree',
          '--toolchain',
          'generic',
          '--workflow',
          'solo-local'
        ],
        deps: worktree.deps
      })
    ).toBe(0);
    expect(worktree.stdout).toContain('.worktreeinclude');

    const clone = createHarness();
    clone.deps.cwd = projectRoot;
    expect(
      await runCommandRouter({
        argv: [
          'init',
          '--dry-run',
          '--tracker',
          'memory',
          '--workspace',
          'clone',
          '--toolchain',
          'generic',
          '--workflow',
          'solo-local'
        ],
        deps: clone.deps
      })
    ).toBe(0);
    expect(clone.stdout).not.toContain('2. .worktreeinclude');

    const none = createHarness();
    none.deps.cwd = projectRoot;
    expect(
      await runCommandRouter({
        argv: ['init', '--dry-run', '--bundle', 'memory-generic'],
        deps: none.deps
      })
    ).toBe(0);
    expect(none.stdout).not.toContain('2. .worktreeinclude');
  });

  it('fails init dry-run when required profile selections are missing', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run', '--pack', 'tracker:memory'],
      deps: harness.deps
    });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain('Missing required workspace pack');
    expect(harness.stderr).toContain('Missing required toolchain pack');
    expect(harness.stderr).toContain('Missing required workflow pack');
    expect(harness.stderr).toContain('provide all required --tracker/--workspace/--toolchain/--workflow flags');
    expect(harness.stdout).toBe('');
  });

  it('does not prompt in CI even when stdio reports TTY', async () => {
    const harness = createHarness();
    harness.deps.env = { CI: 'true' };
    harness.deps.stdinIsTTY = () => true;
    harness.deps.stdoutIsTTY = () => true;

    const exitCode = await runCommandRouter({
      argv: ['init', '--dry-run'],
      deps: harness.deps
    });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain('Missing required tracker pack');
    expect(harness.stderr).toContain('provide all required --tracker/--workspace/--toolchain/--workflow flags');
    expect(harness.stdout).toBe('');
  });

  it('blocks write success when generated workflow validation fails', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-init-validation-failure-')));
    const harness = createHarness();
    harness.deps.cwd = projectRoot;
    harness.deps.materializeWorkflowPlan = (options) => ({
      ...materializeWorkflowPlan(options),
      validation: {
        ok: false,
        error_code: 'missing_codex_command',
        message: 'codex.command is required',
        at: '2026-05-25T00:00:00.000Z'
      }
    });

    const exitCode = await runCommandRouter({
      argv: ['init', '--bundle', 'memory-generic'],
      deps: harness.deps
    });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain('Generated workflow validation failed: codex.command is required');
    await expect(fs.access(path.join(projectRoot, 'WORKFLOW.md'))).rejects.toThrow();
  });

  it('refuses to generate protected symphony-internal init profiles', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({
      argv: [
        'init',
        '--dry-run',
        '--pack',
        'tracker:memory',
        '--pack',
        'workspace:none',
        '--pack',
        'toolchain:generic',
        '--pack',
        'workflow:symphony-internal'
      ],
      deps: harness.deps
    });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain('Protected workflow bindings cannot be generated by init');
    expect(harness.stdout).toBe('');
  });

  it('fails unknown commands with actionable help', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({ argv: ['frobnicate'], deps: harness.deps });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain("Unknown command 'frobnicate'");
    expect(harness.stderr).toContain('Supported commands: dashboard, doctor, setup, profile, init, link-local');
    expect(harness.stderr).toContain('symphony <command> [options]');
    expect(harness.stdout).toBe('');
  });

  it('fails unsupported profile modes instead of silently succeeding', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({
      argv: ['profile', 'show', 'custom-profile'],
      deps: harness.deps
    });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain('Unsupported profile command: show custom-profile');
    expect(harness.stderr).toContain('symphony profile show symphony-internal');
    expect(harness.stdout).toBe('');
  });

  it('reports healthy local doctor readiness with a linked shim and setup consent', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    expect(await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps })).toBe(0);
    const exitCode = await runCommandRouter({ argv: ['doctor'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Symphony doctor: ok');
    expect(harness.stdout).toContain(`project root: ${projectRoot}`);
    expect(harness.stdout).toContain(`workflow: ${path.join(projectRoot, 'WORKFLOW.md')}`);
    expect(harness.stdout).toContain(`env file: ${path.join(projectRoot, '.env')}`);
    expect(harness.stdout).toContain('port: 0 (ephemeral)');
    expect(harness.stdout).toContain('consent: setup');
    expect(harness.stdout).not.toContain('SYMPHONY_TEST_VALUE');
    expect(harness.stderr).toBe('');
  });

  it('emits stable JSON doctor output and CI blocker exit behavior', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json', '--ci'], deps: harness.deps });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(payload).toMatchObject({
      version: 1,
      command: 'doctor',
      status: 'failure',
      reason: 'blockers_present',
      exitCode: 2,
      exitSemantics: {
        code: 2,
        meaning: 'blockers_present',
        ci: {
          requested: true,
          promptsAllowed: false,
          nonZeroOnBlocker: true
        }
      },
      ci: true,
      resolution: {
        projectRoot,
        workflowPath: path.join(projectRoot, 'WORKFLOW.md'),
        envFilePath: path.join(projectRoot, '.env'),
        host: '127.0.0.1',
        port: 0,
        ephemeralPort: true,
        consent: 'missing'
      }
    });
    expect(payload.projectContext).toMatchObject({
      cwd: projectRoot,
      symphonyCheckoutRoot: repoRoot,
      projectRoot,
      workflowPath: path.join(projectRoot, 'WORKFLOW.md'),
      envFilePath: path.join(projectRoot, '.env'),
      envFileExists: false,
      profile: 'project'
    });
    expect(payload.findings).toEqual(payload.checks);
    expect(payload.findings.every((finding: Record<string, unknown>) =>
      ['id', 'code', 'severity', 'message', 'source', 'remediationInfo', 'safeFix', 'details', 'checkStatus'].every((key) =>
        Object.prototype.hasOwnProperty.call(finding, key)
      )
    )).toBe(true);
    expect(doctorFinding(payload, 'setup.consent')).toMatchObject({
      code: 'setup_consent_missing',
      severity: 'blocker',
      checkStatus: 'failure',
      message: expect.stringContaining('No user-local setup consent exists'),
      source: { category: 'user_local_trust_state', present: false },
      remediationInfo: { guidance: expect.stringContaining('symphony setup --yes') },
      safeFix: {
        available: true,
        fixId: 'setup-consent',
        command: 'symphony doctor --fix --yes',
        requiresYes: true,
        mutates: [
          {
            scope: 'user_local_state',
            path: harness.deps.setupConsentStore.path,
            operation: 'record_setup_consent'
          }
        ]
      },
      details: {
        posture: 'high-trust'
      }
    });
    expect(doctorFinding(payload, 'server.port')).toMatchObject({
      severity: 'pass',
      checkStatus: 'ok',
      source: { category: 'inferred_runtime_default', value: 'default', present: true },
      safeFix: { available: false }
    });
    expect(doctorFinding(payload, 'env.path')).toMatchObject({
      source: { category: 'project_default', value: 'project', present: true },
      details: { exists: false }
    });
    expect(doctorFinding(payload, 'layout.gitignore_system')).toMatchObject({
      source: { category: 'layout_inspection' },
      safeFix: {
        available: false,
        mutates: [
          {
            scope: 'project_file',
            path: path.join(projectRoot, '.gitignore'),
            operation: 'append_gitignore_entry'
          }
        ]
      }
    });
    expect(doctorFinding(payload, 'workflow.effective_config')).toMatchObject({
      details: {
        trackerApiKey: { redacted: true, present: false }
      }
    });
    expect(payload.checks.some((check: { id: string; reason: string }) => check.id === 'setup.consent' && check.reason === 'setup_consent_missing')).toBe(true);
    expect(payload.layout).toMatchObject({
      workflow: { path: 'WORKFLOW.md', exists: true, canonical: true },
      runtimeStateRoot: { path: '.symphony/system', owner: 'runtime-state' },
      ignoreAnalysis: { status: 'narrow-system', hasNarrowSystemIgnore: true }
    });
    expect(harness.stderr).toBe('');
  });

  it('normalizes doctor provenance categories and redacts sensitive details', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject(ENV_BACKED_LINEAR_WORKFLOW);
    await fs.writeFile(path.join(projectRoot, '.env'), 'DOCTOR_ONLY_LINEAR_TOKEN=secret-from-env-file\n', 'utf8');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--port', '0', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(0);
    expect(doctorFinding(payload, 'resolver.workflow')).toMatchObject({
      source: { category: 'workflow_value', value: 'project', present: true }
    });
    expect(doctorFinding(payload, 'env.path')).toMatchObject({
      source: { category: 'environment_file', value: 'project', present: true },
      details: { exists: true }
    });
    expect(doctorFinding(payload, 'workflow.effective_config')).toMatchObject({
      severity: 'pass',
      source: { category: 'workflow_value', present: true },
      details: {
        trackerKind: 'linear',
        trackerApiKey: { redacted: true, present: true }
      }
    });
    expect(doctorFinding(payload, 'server.port')).toMatchObject({
      source: { category: 'cli_flag', value: 'cli', present: true }
    });
    expect(doctorFinding(payload, 'setup.consent')).toMatchObject({
      source: { category: 'cli_flag', value: 'guardrail_ack', present: true }
    });
    expect(JSON.stringify(payload)).not.toContain('secret-from-env-file');
    expect(harness.stderr).toBe('');
  });

  it('reports environment-variable provenance for doctor env overrides', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir, SYMPHONY_PORT: '0' };

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json', '--ci'], deps: harness.deps });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(doctorFinding(payload, 'server.port')).toMatchObject({
      severity: 'pass',
      checkStatus: 'ok',
      source: { category: 'environment_variable', value: 'env', present: true },
      details: { port: 0, source: 'env' }
    });
    expect(harness.stderr).toBe('');
  });

  it('reports generated profile provenance for symphony-internal doctor checks', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    await fs.writeFile(path.join(repoRoot, 'WORKFLOW.md'), VALID_WORKFLOW, 'utf8');
    await fs.writeFile(path.join(repoRoot, '.gitignore'), '.symphony/system/\n', 'utf8');
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--profile', 'symphony-internal', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(0);
    expect(payload.projectContext).toMatchObject({
      projectRoot: repoRoot,
      workflowPath: path.join(repoRoot, 'WORKFLOW.md'),
      profile: 'symphony-internal'
    });
    expect(doctorFinding(payload, 'resolver.workflow')).toMatchObject({
      source: { category: 'generated_profile', value: 'profile', present: true }
    });
    expect(harness.stderr).toBe('');
  });

  it('reports generated workflow customization provenance and missing explicit references', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const workflow = [
      '---',
      'tracker:',
      '  kind: memory',
      'codex:',
      '  command: codex',
      '---',
      [
        '<!-- symphony-generated-profile: profile=team-review; bundle=linear-node; packs=tracker:linear,workflow:team-review;',
        'prompt=.symphony/prompts/review.md; skill=.symphony/skills/commit/SKILL.md -->'
      ].join(' '),
      'workflow'
    ].join('\n');
    const projectRoot = await createDoctorProject(workflow);
    await fs.mkdir(path.join(projectRoot, '.symphony', 'skills'), { recursive: true });
    await fs.mkdir(path.join(projectRoot, '.symphony', 'prompts'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.symphony', 'prompts', 'review.md'), 'review prompt\n', 'utf8');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(1);
    const reservedCustomization = doctorFinding(payload, 'layout.reserved_customization') as unknown as {
      details: { reservedCustomizationPaths: Array<Record<string, unknown>> };
    };
    expect(reservedCustomization.details.reservedCustomizationPaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.symphony/skills', exists: true, loadedByRuntime: false }),
        expect.objectContaining({ path: '.symphony/prompts', exists: true, loadedByRuntime: false })
      ])
    );
    expect(doctorFinding(payload, 'customization.generated_profile')).toMatchObject({
      status: 'ok',
      severity: 'pass',
      reason: 'generated_profile_provenance_recorded',
      source: { category: 'generated_profile', value: 'workflow_comment', present: true },
      details: {
        profile: 'team-review',
        bundle: 'linear-node',
        packs: ['tracker:linear', 'workflow:team-review'],
        runtimeLoadingSupported: false,
        runtimeLoadingBehavior: 'observable_only'
      }
    });
    expect(doctorFinding(payload, 'customization.reference.symphony_prompts_review_md')).toMatchObject({
      status: 'ok',
      severity: 'pass',
      reason: 'customization_reference_present',
      source: { category: 'generated_profile', value: 'workflow_comment', present: true },
      details: {
        path: '.symphony/prompts/review.md',
        kind: 'prompt',
        exists: true,
        runtimeLoadingSupported: false,
        runtimeLoadingBehavior: 'observable_only'
      }
    });
    expect(doctorFinding(payload, 'customization.reference.symphony_skills_commit_skill_md')).toMatchObject({
      status: 'warning',
      severity: 'warning',
      reason: 'customization_reference_missing',
      details: {
        path: '.symphony/skills/commit/SKILL.md',
        kind: 'skill',
        exists: false,
        runtimeLoadingSupported: false,
        runtimeLoadingBehavior: 'observable_only'
      }
    });
    expect(JSON.stringify(payload)).not.toContain('loaded by Codex');
    expect(harness.stderr).toBe('');
  });

  it('reports absent customization provenance for generic workflows without warnings', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(0);
    expect(doctorFinding(payload, 'customization.generated_profile')).toMatchObject({
      status: 'ok',
      reason: 'generated_profile_provenance_absent',
      source: { category: 'workflow_value', present: false },
      details: {
        profile: null,
        bundle: null,
        packs: [],
        sources: [],
        runtimeLoadingSupported: false
      }
    });
    expect(payload.findings.some((finding: { id: string }) => finding.id.startsWith('customization.reference.'))).toBe(false);
    expect(harness.stderr).toBe('');
  });

  it('rejects malformed generated workflow provenance in doctor validation', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const workflow = [
      '---',
      'symphony:',
      '  generated_profile:',
      '    profile: 42',
      '    bundle: []',
      '    packs: tracker:memory',
      'tracker:',
      '  kind: memory',
      'codex:',
      '  command: codex',
      '---',
      'workflow'
    ].join('\n');
    const projectRoot = await createDoctorProject(workflow);
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(doctorFinding(payload, 'workflow.effective_config')).toMatchObject({
      status: 'failure',
      reason: 'invalid_generated_profile_provenance'
    });
    expect((doctorFinding(payload, 'workflow.effective_config') as unknown as { summary: string }).summary).toContain(
      'workflow_frontmatter.profile must be a non-empty string'
    );
    expect(harness.stderr).toBe('');
  });

  it('rejects incomplete present generated workflow provenance in doctor validation', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const workflow = [
      '---',
      'symphony:',
      '  generated_profile: {}',
      'tracker:',
      '  kind: memory',
      'codex:',
      '  command: codex',
      '---',
      'workflow'
    ].join('\n');
    const projectRoot = await createDoctorProject(workflow);
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(doctorFinding(payload, 'workflow.effective_config')).toMatchObject({
      status: 'failure',
      reason: 'invalid_generated_profile_provenance'
    });
    expect((doctorFinding(payload, 'workflow.effective_config') as unknown as { summary: string }).summary).toContain(
      'workflow_frontmatter.profile is required'
    );
    expect((doctorFinding(payload, 'workflow.effective_config') as unknown as { summary: string }).summary).toContain(
      'workflow_frontmatter.bundle is required'
    );
    expect((doctorFinding(payload, 'workflow.effective_config') as unknown as { summary: string }).summary).toContain(
      'workflow_frontmatter.packs is required'
    );
    expect(harness.stderr).toBe('');
  });

  it('renders the customization runtime-loading boundary in human doctor output', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const workflow = [
      '---',
      'tracker:',
      '  kind: memory',
      'codex:',
      '  command: codex',
      '---',
      '<!-- symphony-generated-profile: profile=solo-local; bundle=github-node; packs=tracker:github; prompt=.symphony/prompts/missing.md -->',
      'workflow'
    ].join('\n');
    const projectRoot = await createDoctorProject(workflow);
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: harness.deps
    });

    expect(exitCode).toBe(1);
    expect(harness.stdout).toContain('Generated workflow customization provenance is observable');
    expect(harness.stdout).toContain('runtime behavior comes from the materialized workflow');
    expect(harness.stdout).toContain('Observable prompt customization reference exists');
    expect(harness.stdout).toContain('not a Codex runtime loading failure');
    expect(harness.stderr).toBe('');
  });

  it('reports layout checks in doctor human output', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    await fs.writeFile(path.join(projectRoot, '.gitignore'), '.symphony/\n', 'utf8');
    await fs.mkdir(path.join(projectRoot, '.symphony', 'workspaces'), { recursive: true });
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor'], deps: harness.deps });

    expect(exitCode).toBe(2);
    expect(harness.stdout).toContain('Root WORKFLOW.md is canonical');
    expect(harness.stdout).toContain('.symphony/system runtime root is reserved');
    expect(harness.stdout).toContain('.gitignore covers runtime state root');
    expect(harness.stdout).toContain('Broad .symphony/ ignores are not hiding project customization');
    expect(harness.stdout).toContain('Reserved customization paths remain project-owned');
    expect(harness.stdout).toContain('Legacy runtime paths are absent');
    expect(harness.stdout).toContain('broad .symphony/ ignore may hide future project-owned customization');
    expect(harness.stdout).toContain('Found 1 legacy runtime state path');
    expect(harness.stdout).toContain('doctor will not remove broad ignores');
    expect(harness.stdout).toContain('Migrate runtime state to .symphony/system/ manually');
    expect(harness.stderr).toBe('');
  });

  it('reports clean project-local skills, helpers, prerequisites, and Codex visibility', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    await writeFakeCodexAppServer(binDir, ['commit', 'land']);
    await writeExecutable(path.join(binDir, 'git'));
    await writeExecutable(path.join(binDir, 'gh'));
    await writeExecutable(path.join(binDir, 'uv'));
    await writeExecutable(path.join(binDir, 'python3'));
    const projectRoot = await createDoctorProject(projectLocalSkillsWorkflow(['commit', 'land']));
    await installProjectSkill(projectRoot, 'commit');
    await installProjectSkill(projectRoot, 'land', ['.codex/skills/land/scripts/land_watch.py']);
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(0);
    expect(doctorFinding(payload, 'project_local_skills.selection')).toMatchObject({
      status: 'ok',
      reason: 'portable_skills_selected',
      details: { selectedSkillIds: ['commit', 'land'] }
    });
    expect(doctorFinding(payload, 'project_local_skills.skill.commit')).toMatchObject({
      status: 'ok',
      reason: 'portable_skill_installed',
      details: { path: path.join(projectRoot, '.codex', 'skills', 'commit', 'SKILL.md'), exists: true }
    });
    expect(doctorFinding(payload, 'project_local_skills.helper.land.codex_skills_land_scripts_land_watch_py')).toMatchObject({
      status: 'ok',
      reason: 'portable_skill_helper_present',
      details: { path: path.join(projectRoot, '.codex', 'skills', 'land', 'scripts', 'land_watch.py'), exists: true }
    });
    expect(doctorFinding(payload, 'project_local_skills.prerequisite.github-cli')).toMatchObject({
      status: 'ok',
      reason: 'portable_skill_prerequisite_present',
      details: { tool: 'gh' }
    });
    expect(doctorFinding(payload, 'project_local_skills.prerequisite.uv')).toMatchObject({
      status: 'ok',
      reason: 'portable_skill_prerequisite_present',
      details: { tool: 'uv' }
    });
    expect(doctorFinding(payload, 'project_local_skills.prerequisite.git')).toMatchObject({
      status: 'ok',
      reason: 'portable_skill_prerequisite_present',
      details: { tool: 'git' }
    });
    expect(doctorFinding(payload, 'project_local_skills.prerequisite.python')).toMatchObject({
      status: 'ok',
      reason: 'portable_skill_prerequisite_present',
      details: { tool: 'python3', command: 'python3', commandCandidates: ['python3', 'python'] }
    });
    expect(doctorFinding(payload, 'project_local_skills.codex_visibility')).toMatchObject({
      status: 'ok',
      reason: 'codex_skill_discovery_visible',
      details: { visibleSkillNames: ['commit', 'land'], missingSkillNames: [] }
    });
    expect(harness.stderr).toBe('');
  });

  it('reports missing project-local skill files separately from missing helper scripts', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    await writeFakeCodexAppServer(binDir, ['commit']);
    await writeExecutable(path.join(binDir, 'git'));
    await writeExecutable(path.join(binDir, 'gh'));
    await writeExecutable(path.join(binDir, 'uv'));
    await writeExecutable(path.join(binDir, 'python3'));
    const projectRoot = await createDoctorProject(projectLocalSkillsWorkflow(['commit', 'land']));
    await installProjectSkill(projectRoot, 'commit');
    await fs.mkdir(path.join(projectRoot, '.codex', 'skills', 'land'), { recursive: true });
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--ci', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(doctorFinding(payload, 'project_local_skills.skill.land')).toMatchObject({
      status: 'failure',
      reason: 'portable_skill_missing',
      details: { path: path.join(projectRoot, '.codex', 'skills', 'land', 'SKILL.md'), exists: false }
    });
    expect(doctorFinding(payload, 'project_local_skills.helper.land.codex_skills_land_scripts_land_watch_py')).toMatchObject({
      status: 'failure',
      reason: 'portable_skill_helper_missing',
      details: { path: path.join(projectRoot, '.codex', 'skills', 'land', 'scripts', 'land_watch.py'), exists: false }
    });
    expect(doctorFinding(payload, 'project_local_skills.codex_visibility')).toMatchObject({
      status: 'warning',
      reason: 'codex_skill_discovery_partial',
      details: { visibleSkillNames: ['commit'], missingSkillNames: ['land'] }
    });
    expect(harness.stderr).toBe('');
  });

  it('warns on unknown project-local portable skill provenance without false discovery success', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    await writeFakeCodexAppServer(binDir, []);
    const projectRoot = await createDoctorProject(projectLocalSkillsWorkflow([]).replace(
      '    portable_skills:\n',
      [
        '    portable_skills:',
        '      - name: "unknown-skill"',
        '        path: ".codex/skills/unknown-skill/"',
        ''
      ].join('\n')
    ));
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--ci', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(1);
    expect(doctorFinding(payload, 'project_local_skills.selection')).toMatchObject({
      status: 'warning',
      reason: 'portable_skill_selection_unrecognized',
      summary: expect.stringContaining('unknown-skill'),
      details: {
        selectedSkillIds: [],
        unknown: [{ name: 'unknown-skill', path: '.codex/skills/unknown-skill/', source: 'workflow_frontmatter' }]
      }
    });
    expect(doctorFinding(payload, 'project_local_skills.codex_visibility')).toMatchObject({
      status: 'warning',
      reason: 'codex_skill_discovery_unknown_provenance',
      summary: expect.stringContaining('unknown-skill'),
      details: {
        selectedSkillIds: [],
        unknownSkillNames: ['unknown-skill']
      }
    });
    expect(doctorFinding(payload, 'project_local_skills.codex_visibility')).not.toMatchObject({
      reason: 'codex_skill_discovery_not_required'
    });
    expect(harness.stderr).toBe('');
  });

  it('reports selected-skill prerequisite and Linear credential status without leaking secrets', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    await writeFakeCodexAppServer(binDir, ['linear-ui-evidence']);
    const projectRoot = await createDoctorProject(projectLocalSkillsWorkflow(['linear-ui-evidence']));
    await installProjectSkill(projectRoot, 'linear-ui-evidence', [
      '.codex/skills/linear-ui-evidence/scripts/publish-linear-ui-evidence.js'
    ]);
    const missingHarness = createHarness({ repoRoot });
    missingHarness.deps.cwd = projectRoot;
    missingHarness.deps.env = { PATH: binDir, LINEAR_API_KEY: '' };

    const missingExitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--ci', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: missingHarness.deps
    });
    const missingPayload = JSON.parse(missingHarness.stdout);
    expect(missingExitCode).toBe(2);
    expect(doctorFinding(missingPayload, 'project_local_skills.prerequisite.node')).toMatchObject({
      status: 'failure',
      reason: 'portable_skill_prerequisite_missing',
      details: { tool: 'node' }
    });
    expect(doctorFinding(missingPayload, 'project_local_skills.credentials.linear')).toMatchObject({
      status: 'failure',
      reason: 'linear_skill_credentials_missing',
      details: {
        envVarName: 'LINEAR_API_KEY',
        present: false,
        sources: { environmentVariable: { present: false } }
      }
    });

    await writeExecutable(path.join(binDir, 'node'));
    const presentHarness = createHarness({ repoRoot });
    presentHarness.deps.cwd = projectRoot;
    presentHarness.deps.env = { PATH: binDir, LINEAR_API_KEY: 'linear-secret-value' };
    const presentExitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: presentHarness.deps
    });
    const presentPayload = JSON.parse(presentHarness.stdout);

    expect(presentExitCode).toBe(0);
    expect(doctorFinding(presentPayload, 'project_local_skills.prerequisite.node')).toMatchObject({
      status: 'ok',
      reason: 'portable_skill_prerequisite_present'
    });
    expect(doctorFinding(presentPayload, 'project_local_skills.credentials.linear')).toMatchObject({
      status: 'ok',
      reason: 'linear_skill_credentials_present',
      source: { category: 'environment_variable', value: 'LINEAR_API_KEY', present: true }
    });
    expect(JSON.stringify(presentPayload)).not.toContain('linear-secret-value');
    expect(presentHarness.stderr).toBe('');
  });

  it('reports missing git and Python prerequisites for selected project-local skills', async () => {
    const missingGit = await createDoctorRepo();
    await writeFakeCodexAppServer(missingGit.binDir, ['commit']);
    const gitProjectRoot = await createDoctorProject(projectLocalSkillsWorkflow(['commit']));
    await installProjectSkill(gitProjectRoot, 'commit');
    const missingGitHarness = createHarness({ repoRoot: missingGit.repoRoot });
    missingGitHarness.deps.cwd = gitProjectRoot;
    missingGitHarness.deps.env = { PATH: missingGit.binDir };

    const missingGitExitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--ci', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: missingGitHarness.deps
    });
    const missingGitPayload = JSON.parse(missingGitHarness.stdout);

    expect(missingGitExitCode).toBe(2);
    expect(doctorFinding(missingGitPayload, 'project_local_skills.prerequisite.git')).toMatchObject({
      status: 'failure',
      reason: 'portable_skill_prerequisite_missing',
      summary: expect.stringContaining('git'),
      details: { kind: 'git', tool: 'git', executablePath: null, requiredBySelectedSkills: true }
    });
    expect(missingGitHarness.stderr).toBe('');

    const missingPython = await createDoctorRepo();
    await writeFakeCodexAppServer(missingPython.binDir, ['land']);
    await writeExecutable(path.join(missingPython.binDir, 'git'));
    await writeExecutable(path.join(missingPython.binDir, 'gh'));
    await writeExecutable(path.join(missingPython.binDir, 'uv'));
    const pythonProjectRoot = await createDoctorProject(projectLocalSkillsWorkflow(['land']));
    await installProjectSkill(pythonProjectRoot, 'land', ['.codex/skills/land/scripts/land_watch.py']);
    const missingPythonHarness = createHarness({ repoRoot: missingPython.repoRoot });
    missingPythonHarness.deps.cwd = pythonProjectRoot;
    missingPythonHarness.deps.env = { PATH: missingPython.binDir };

    const missingPythonExitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--ci', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: missingPythonHarness.deps
    });
    const missingPythonPayload = JSON.parse(missingPythonHarness.stdout);

    expect(missingPythonExitCode).toBe(2);
    expect(doctorFinding(missingPythonPayload, 'project_local_skills.prerequisite.python')).toMatchObject({
      status: 'failure',
      reason: 'portable_skill_prerequisite_missing',
      summary: expect.stringContaining('python3 or python'),
      details: {
        kind: 'python',
        tool: 'python3',
        command: 'python3',
        commandCandidates: ['python3', 'python'],
        executablePath: null,
        requiredBySelectedSkills: true
      }
    });
    expect(missingPythonHarness.stderr).toBe('');
  });

  it('reports degraded Codex skill discovery when app-server visibility is unavailable', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    await writeExecutable(path.join(binDir, 'git'));
    await writeExecutable(path.join(binDir, 'gh'));
    const projectRoot = await createDoctorProject(projectLocalSkillsWorkflow(['push']));
    await installProjectSkill(projectRoot, 'push');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(1);
    expect(doctorFinding(payload, 'project_local_skills.codex_visibility')).toMatchObject({
      status: 'warning',
      reason: 'codex_skill_discovery_unavailable'
    });
    expect(harness.stdout).toContain('Codex-visible project-local skill discovery is checked');
    expect(harness.stdout).toContain('Codex app-server exited before returning skills/list');
    expect(harness.stderr).toBe('');
  });

  it('emits stable JSON layout findings and warning-only CI exit behavior', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const setupHarness = createHarness({ repoRoot });
    setupHarness.deps.cwd = projectRoot;
    setupHarness.deps.env = { PATH: binDir };
    expect(await runCommandRouter({ argv: ['setup', '--yes'], deps: setupHarness.deps })).toBe(0);
    await fs.rm(path.join(projectRoot, '.gitignore'));

    const doctorHarness = createHarness({ repoRoot });
    doctorHarness.deps.cwd = projectRoot;
    doctorHarness.deps.env = { PATH: binDir };
    doctorHarness.deps.setupConsentStore = setupHarness.deps.setupConsentStore;

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json', '--ci'], deps: doctorHarness.deps });
    const payload = JSON.parse(doctorHarness.stdout);

    expect(exitCode).toBe(1);
    expect(payload.status).toBe('warning');
    expect(payload.reason).toBe('warnings_present');
    expect(payload.layout.ignoreAnalysis).toMatchObject({
      exists: false,
      status: 'missing',
      hasNarrowSystemIgnore: false
    });
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'layout.gitignore_system',
          status: 'warning',
          reason: 'system_ignore_missing'
        })
      ])
    );
    expect(doctorHarness.stderr).toBe('');
  });

  it('treats invalid layout paths as CI blockers', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const setupHarness = createHarness({ repoRoot });
    setupHarness.deps.cwd = projectRoot;
    setupHarness.deps.env = { PATH: binDir };
    expect(await runCommandRouter({ argv: ['setup', '--yes'], deps: setupHarness.deps })).toBe(0);
    await fs.writeFile(path.join(projectRoot, '.symphony'), 'not-a-directory\n', 'utf8');

    const doctorHarness = createHarness({ repoRoot });
    doctorHarness.deps.cwd = projectRoot;
    doctorHarness.deps.env = { PATH: binDir };
    doctorHarness.deps.setupConsentStore = setupHarness.deps.setupConsentStore;

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json', '--ci'], deps: doctorHarness.deps });
    const payload = JSON.parse(doctorHarness.stdout);

    expect(exitCode).toBe(2);
    expect(payload.status).toBe('failure');
    expect(payload.reason).toBe('blockers_present');
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'layout.warning.invalid_layout_path',
          status: 'failure',
          reason: 'invalid_layout_path'
        })
      ])
    );
    expect(doctorHarness.stderr).toBe('');
  });

  it('validates doctor workflow config with values loaded from the resolved project env file', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject(ENV_BACKED_LINEAR_WORKFLOW);
    await fs.writeFile(path.join(projectRoot, '.env'), 'DOCTOR_ONLY_LINEAR_TOKEN=secret-from-env-file\n', 'utf8');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json'], deps: harness.deps });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'workflow.effective_config',
          status: 'ok',
          reason: 'workflow_config_valid'
        }),
        expect.objectContaining({
          id: 'setup.consent',
          status: 'failure',
          reason: 'setup_consent_missing'
        })
      ])
    );
    expect(JSON.stringify(payload)).not.toContain('secret-from-env-file');
    expect(harness.stderr).toBe('');
  });

  it('reports missing link and PATH issues with actionable remediation', async () => {
    const projectRoot = await createDoctorProject();
    const repoRoot = (await createDoctorRepo()).repoRoot;
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-empty-path-'))) };

    const exitCode = await runCommandRouter({ argv: ['doctor'], deps: harness.deps });

    expect(exitCode).toBe(2);
    expect(harness.stdout).toContain('`symphony` was not found on PATH');
    expect(harness.stdout).toContain('npm run link:local');
    expect(harness.stderr).toBe('');
  });

  it('reports stale shim checkout targets and built CLI refresh guidance', async () => {
    const { repoRoot, binDir, shimPath } = await createDoctorRepo();
    const missingRoot = path.join(os.tmpdir(), `symphony-missing-${Date.now()}`);
    await fs.writeFile(
      shimPath,
      [
        '#!/usr/bin/env bash',
        '# symphony-local-shim',
        '# symphony-shim-version: 1',
        `# symphony-repo-root: ${missingRoot}`,
        `# symphony-entrypoint: ${path.join(missingRoot, 'scripts', 'symphony.js')}`,
        'exit 0',
        ''
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 }
    );
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor'], deps: harness.deps });

    expect(exitCode).toBe(2);
    expect(harness.stdout).toContain('PATH shim points at');
    expect(harness.stdout).toContain('expected');
    expect(harness.stdout).toContain('Checkout does not exist');
    expect(harness.stdout).toContain('Refresh the local link');
  });

  it('keeps doctor --fix --json output parseable when link-local remediation emits text', async () => {
    const { repoRoot, binDir, shimPath } = await createDoctorRepo();
    const missingRoot = path.join(os.tmpdir(), `symphony-missing-${Date.now()}`);
    await fs.writeFile(
      shimPath,
      [
        '#!/usr/bin/env bash',
        '# symphony-local-shim',
        '# symphony-shim-version: 1',
        `# symphony-repo-root: ${missingRoot}`,
        `# symphony-entrypoint: ${path.join(missingRoot, 'scripts', 'symphony.js')}`,
        'exit 0',
        ''
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 }
    );
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };
    harness.deps.runLinkLocal = async (argv: readonly string[], options?: LinkLocalRunOptions) => {
      harness.linkLocalCalls.push([...argv]);
      (options?.stdout ?? harness.deps.stdout)('Updated Symphony local shim\n');
      return 0;
    };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--fix', '--yes', '--json'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(harness.stdout).not.toContain('Updated Symphony local shim');
    expect(payload.fixes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'link-local',
          status: 'applied'
        })
      ])
    );
    expect(harness.linkLocalCalls).toEqual([[]]);
    expect(harness.stderr).toBe('');
  });

  it('does not perform doctor fix mutations in CI mode', async () => {
    const { repoRoot } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    await fs.writeFile(path.join(projectRoot, '.gitignore'), '.symphony/\n', 'utf8');
    const emptyBin = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-empty-path-')));
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: emptyBin };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--fix', '--yes', '--ci', '--json'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8')).toBe('.symphony/\n');
    expect(harness.consent.records()).toEqual([]);
    expect(harness.linkLocalCalls).toEqual([]);
    expect(payload.fixes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'link-local',
          status: 'skipped',
          summary: expect.stringContaining('`--ci` forbids doctor fix mutations')
        }),
        expect.objectContaining({
          id: 'layout.gitignore-system',
          status: 'skipped',
          summary: expect.stringContaining('`--ci` forbids doctor fix mutations')
        }),
        expect.objectContaining({
          id: 'setup-consent',
          status: 'skipped',
          summary: expect.stringContaining('`--ci` forbids doctor fix mutations')
        })
      ])
    );
    expect(payload.exitSemantics.ci).toMatchObject({
      requested: true,
      promptsAllowed: false,
      nonZeroOnBlocker: true
    });
    expect(harness.stderr).toBe('');
  });

  it('reports missing and invalid workflows through the local resolver and config validator', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-no-workflow-')));
    const missingHarness = createHarness({ repoRoot });
    missingHarness.deps.cwd = cwd;
    missingHarness.deps.env = { PATH: binDir };

    expect(await runCommandRouter({ argv: ['doctor'], deps: missingHarness.deps })).toBe(2);
    expect(missingHarness.stdout).toContain('No WORKFLOW.md was found');

    const invalidProject = await createDoctorProject(['---', 'tracker:', '  kind: linear', '---', 'workflow'].join('\n'));
    const invalidHarness = createHarness({ repoRoot });
    invalidHarness.deps.cwd = invalidProject;
    invalidHarness.deps.env = { PATH: binDir };

    expect(await runCommandRouter({ argv: ['doctor'], deps: invalidHarness.deps })).toBe(2);
    expect(invalidHarness.stdout).toContain('tracker.api_key is required after env resolution');
  });

  it('reports fixed port unavailability before dashboard startup', async () => {
    const { server, port } = await listenOnLocalhost();
    try {
      const { repoRoot, binDir } = await createDoctorRepo();
      const projectRoot = await createDoctorProject();
      const harness = createHarness({ repoRoot });
      harness.deps.cwd = projectRoot;
      harness.deps.env = { PATH: binDir };
      expect(await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps })).toBe(0);

      const exitCode = await runCommandRouter({ argv: ['doctor', '--port', String(port)], deps: harness.deps });

      expect(exitCode).toBe(2);
      expect(harness.stdout).toContain(`Dashboard cannot bind 127.0.0.1:${port}`);
      expect(harness.stdout).toContain('Choose a different port');
      expect(harness.dashboardCalls).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps doctor --fix bounded to link/setup remediation', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor', '--fix', '--yes'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.consent.records()).toHaveLength(1);
    expect(harness.linkLocalCalls).toEqual([]);
    expect(harness.stdout).toContain('[applied] setup-consent');
    expect(harness.dashboardCalls).toEqual([]);
  });

  it('doctor --fix --yes can append the runtime-state gitignore entry without removing broad ignores', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    await fs.writeFile(path.join(projectRoot, '.gitignore'), 'node_modules/\n.symphony/\n.env\n', 'utf8');
    await fs.mkdir(path.join(projectRoot, '.symphony', 'workspaces'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.symphony', 'runtime.sqlite'), 'legacy', 'utf8');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor', '--fix', '--yes', '--json'], deps: harness.deps });
    const payload = JSON.parse(harness.stdout);
    const gitignore = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');

    expect(exitCode).toBe(1);
    expect(gitignore).toBe('node_modules/\n.symphony/\n.env\n.symphony/system/\n');
    expect(payload.fixes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'layout.gitignore-system',
          status: 'applied',
          details: {
            path: '.gitignore',
            pattern: '.symphony/system/'
          }
        }),
        expect.objectContaining({
          id: 'setup-consent',
          status: 'applied'
        })
      ])
    );
    expect(payload.layout.ignoreAnalysis).toMatchObject({
      hasBroadSymphonyIgnore: true,
      hasNarrowSystemIgnore: true
    });
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'layout.broad_symphony_ignore',
          status: 'warning'
        })
      ])
    );
    expect(doctorFinding(payload, 'layout.gitignore_system')).toMatchObject({
      safeFix: {
        available: false,
        mutates: [
          {
            scope: 'project_file',
            path: path.join(projectRoot, '.gitignore'),
            operation: 'append_gitignore_entry'
          }
        ]
      }
    });
    expect(doctorFinding(payload, 'layout.legacy_runtime_paths')).toMatchObject({
      status: 'warning'
    });
    expect(await fs.readFile(path.join(projectRoot, '.symphony', 'runtime.sqlite'), 'utf8')).toBe('legacy');
    await expect(fs.stat(path.join(projectRoot, '.symphony', 'workspaces'))).resolves.toBeTruthy();
    expect(harness.stderr).toBe('');
  });

  it('doctor --fix --yes is idempotent for the runtime-state gitignore entry', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    await fs.writeFile(path.join(projectRoot, '.gitignore'), '.symphony/\n', 'utf8');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    expect(await runCommandRouter({ argv: ['doctor', '--fix', '--yes', '--json'], deps: harness.deps })).toBe(1);
    const firstGitignore = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');
    const secondHarness = createHarness({ repoRoot });
    secondHarness.deps.cwd = projectRoot;
    secondHarness.deps.env = { PATH: binDir };

    expect(await runCommandRouter({ argv: ['doctor', '--fix', '--yes', '--json'], deps: secondHarness.deps })).toBe(1);
    const secondPayload = JSON.parse(secondHarness.stdout);
    const secondGitignore = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');

    expect(firstGitignore).toBe('.symphony/\n.symphony/system/\n');
    expect(secondGitignore).toBe(firstGitignore);
    expect(secondPayload.fixes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'layout.gitignore-system',
          status: 'applied'
        })
      ])
    );
    expect(secondPayload.checks.filter((check: { id: string }) => check.id === 'layout.gitignore_system')).toHaveLength(1);
  });

  it('refuses doctor --fix setup consent when local state is inside the project checkout', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const projectConsentPath = path.join(projectRoot, '.symphony', 'setup-consent.json');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };
    harness.deps.setupConsentStore = createFileSetupConsentStore(projectConsentPath);

    const exitCode = await runCommandRouter({ argv: ['doctor', '--fix', '--yes', '--json'], deps: harness.deps });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(payload.status).toBe('failure');
    expect(payload.reason).toBe('blockers_present');
    expect(payload.resolution.consent).toBe('missing');
    expect(payload.fixes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'setup-consent',
          status: 'failed',
          details: { storeLocation: 'project_checkout' }
        })
      ])
    );
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'setup.consent',
          status: 'failure',
          reason: 'setup_consent_missing',
          remediation: expect.stringContaining('outside the project checkout')
        })
      ])
    );
    await expect(fs.access(projectConsentPath)).rejects.toThrow();
    expect(harness.stderr).toBe('');
    expect(harness.dashboardCalls).toEqual([]);
  });

  it('ignores existing setup consent when local state is inside the project checkout', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const projectConsentPath = path.join(projectRoot, '.symphony', 'setup-consent.json');
    const userConsentPath = path.join(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-user-state-'))), 'setup-consent.json');
    const setupHarness = createHarness({ repoRoot });
    setupHarness.deps.cwd = projectRoot;
    setupHarness.deps.env = { PATH: binDir };
    setupHarness.deps.setupConsentStore = createFileSetupConsentStore(userConsentPath);

    const setupExitCode = await runCommandRouter({ argv: ['setup', '--yes'], deps: setupHarness.deps });
    await fs.mkdir(path.dirname(projectConsentPath), { recursive: true });
    await fs.copyFile(userConsentPath, projectConsentPath);

    const doctorHarness = createHarness({ repoRoot });
    doctorHarness.deps.cwd = projectRoot;
    doctorHarness.deps.env = { PATH: binDir };
    doctorHarness.deps.setupConsentStore = createFileSetupConsentStore(projectConsentPath);

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json'], deps: doctorHarness.deps });
    const payload = JSON.parse(doctorHarness.stdout);

    expect(setupExitCode).toBe(0);
    expect(exitCode).toBe(2);
    expect(payload.status).toBe('failure');
    expect(payload.reason).toBe('blockers_present');
    expect(payload.resolution.consent).toBe('missing');
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'setup.consent',
          status: 'failure',
          reason: 'setup_consent_missing',
          remediation: expect.stringContaining('outside the project checkout')
        })
      ])
    );
    expect(doctorHarness.stderr).toBe('');
    expect(doctorHarness.dashboardCalls).toEqual([]);
  });

  it('does not treat workflow declarations as doctor setup consent authority', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject(
      ['---', 'local_high_trust_consent: true', 'codex:', '  command: codex', '---', 'workflow'].join('\n')
    );
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json'], deps: harness.deps });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(payload.resolution.consent).toBe('missing');
    expect(doctorFinding(payload, 'setup.consent')).toMatchObject({
      status: 'failure',
      reason: 'setup_consent_missing',
      source: { category: 'user_local_trust_state', present: false }
    });
    expect(harness.consent.records()).toEqual([]);
    expect(harness.stderr).toBe('');
  });

  it('records explicit setup consent in user-local state for the resolved workflow identity', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-setup-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, '.gitignore'), '.symphony/system/\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Symphony setup high-trust consent:');
    expect(harness.stdout).toContain(`project root: ${projectRoot} (project)`);
    expect(harness.stdout).toContain('required posture: high-trust');
    expect(harness.stdout).toContain('Project layout:');
    expect(harness.stdout).toContain('runtime state root: .symphony/system/');
    expect(harness.stdout).toContain('gitignore: narrow-system');
    expect(harness.stdout).toContain('Setup consent recorded for identity');
    expect(harness.stderr).toBe('');
    expect(harness.consent.records()).toHaveLength(1);
    const [record] = harness.consent.records();
    expect(record.evidence.project_root).toBe(projectRoot);
    expect(record.evidence.workflow_path).toBe(path.join(projectRoot, 'WORKFLOW.md'));
    expect(record.evidence.project_root_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.evidence.workflow_path_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain('workflow\\n');
  });

  it('setup --yes safely appends a missing runtime-state gitignore entry', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-setup-layout-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, '.gitignore'), 'node_modules/\n.symphony/\n', 'utf8');
    await fs.mkdir(path.join(projectRoot, '.symphony', 'workspaces'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.symphony', 'runtime.sqlite'), 'legacy', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps });
    const gitignore = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');

    expect(exitCode).toBe(0);
    expect(gitignore).toBe('node_modules/\n.symphony/\n.symphony/system/\n');
    expect(harness.stdout).toContain('[applied] layout.gitignore-system');
    expect(harness.stdout).toContain('warning: A broad .symphony/ ignore hides future project-owned customization paths.');
    expect(await fs.readFile(path.join(projectRoot, '.symphony', 'runtime.sqlite'), 'utf8')).toBe('legacy');
    await expect(fs.stat(path.join(projectRoot, '.symphony', 'workspaces'))).resolves.toBeTruthy();
  });

  it('setup --yes avoids duplicate runtime-state gitignore entries', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-setup-layout-dupe-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, '.gitignore'), '.symphony/system/\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps });
    const gitignore = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');

    expect(exitCode).toBe(0);
    expect(gitignore).toBe('.symphony/system/\n');
    expect(harness.stdout).not.toContain('layout.gitignore-system');
  });

  it('fails setup safely when explicit consent is not available', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-setup-refuse-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({ argv: ['setup'], deps: harness.deps });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain('Setup consent was not recorded');
    expect(harness.consent.records()).toEqual([]);
  });

  it('refuses to persist setup consent inside the project checkout', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-project-state-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;
    const projectStore = createMemoryConsentStore(path.join(projectRoot, '.symphony', 'setup-consent.json'));
    harness.deps.setupConsentStore = projectStore.store;

    const exitCode = await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain('Refusing to store setup consent under the project checkout');
    expect(projectStore.records()).toEqual([]);
  });

  it('uses valid setup consent as the dashboard guardrail acknowledgement source', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-setup-dashboard-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    expect(await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps })).toBe(0);
    const exitCode = await runCommandRouter({ argv: ['dashboard', '--port=0'], deps: harness.deps });

    expect(exitCode).toBe(27);
    expect(harness.dashboardCalls.at(-1)).toContain('--i-understand-that-this-will-be-running-without-the-usual-guardrails');
    expect(harness.stdout).toContain('required posture: high-trust');
    expect(harness.stdout).toContain(
      'reason: workflow effective codex sandbox posture requires danger-full-access local execution'
    );
    expect(harness.stdout).toContain('consent: setup');
  });

  it('does not trust project-contained setup consent for dashboard startup', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-dashboard-project-state-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    const projectStore = createMemoryConsentStore(path.join(projectRoot, '.symphony', 'setup-consent.json'));
    const harness = createHarness();
    harness.deps.cwd = projectRoot;
    harness.deps.setupConsentStore = projectStore.store;

    const setupExit = await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps });
    expect(setupExit).toBe(1);
    const resolved = resolveLocalCommand({
      command: 'dashboard',
      argv: ['--port=0'],
      cwd: projectRoot,
      env: harness.deps.env,
      symphonyCheckoutRoot: harness.deps.repoRoot
    });
    persistSetupConsent(
      projectStore.store,
      buildSetupConsentRecord({
        resolved,
        posture: HIGH_TRUST_POSTURE,
        approvedAt: '2026-05-24T20:00:00.000Z'
      })
    );

    const exitCode = await runCommandRouter({ argv: ['dashboard', '--port=0'], deps: harness.deps });

    expect(exitCode).toBe(27);
    expect(projectStore.records()).toHaveLength(1);
    expect(harness.dashboardCalls.at(-1)).not.toContain('--i-understand-that-this-will-be-running-without-the-usual-guardrails');
    expect(harness.stdout).toContain('consent: missing');
  });

  it('does not treat workflow declarations as setup consent authority', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-project-file-')));
    await fs.writeFile(
      path.join(projectRoot, 'WORKFLOW.md'),
      ['---', 'local_high_trust_consent: true', '---', 'workflow'].join('\n'),
      'utf8'
    );
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({ argv: ['dashboard', '--port=0'], deps: harness.deps });

    expect(exitCode).toBe(27);
    expect(harness.dashboardCalls.at(-1)).not.toContain('--i-understand-that-this-will-be-running-without-the-usual-guardrails');
    expect(harness.stdout).toContain('required posture: high-trust');
    expect(harness.stdout).toContain(
      'reason: workflow effective codex sandbox posture requires danger-full-access local execution'
    );
    expect(harness.stdout).toContain('consent: missing');
  });

  it('bypasses old setup consent when the workflow identity changes', async () => {
    const projectA = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-identity-a-')));
    const projectB = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-identity-b-')));
    await fs.writeFile(path.join(projectA, 'WORKFLOW.md'), 'workflow a\n', 'utf8');
    await fs.writeFile(path.join(projectB, 'WORKFLOW.md'), 'workflow b\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectA;
    expect(await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps })).toBe(0);

    harness.deps.cwd = projectB;
    const exitCode = await runCommandRouter({ argv: ['dashboard', '--port=0'], deps: harness.deps });

    expect(exitCode).toBe(27);
    expect(harness.dashboardCalls.at(-1)).not.toContain('--i-understand-that-this-will-be-running-without-the-usual-guardrails');
    expect(harness.stdout).toContain('consent: missing');
  });

  it('resolves dashboard local context before delegating to the existing dashboard runner', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-project-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, '.env'), 'SYMPHONY_TEST_VALUE=1\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['dashboard', '--port=0', '--offline'],
      deps: harness.deps
    });

    expect(exitCode).toBe(27);
    expect(harness.dashboardCalls).toEqual([
      [
        '--offline',
        path.join('--workflow=' + projectRoot, 'WORKFLOW.md'),
        '--host=127.0.0.1',
        '--port=0'
      ]
    ]);
    expect(harness.dashboardContexts).toEqual([
      {
        cwd: projectRoot,
        envFilePath: path.join(projectRoot, '.env'),
        repoRoot: '/repo/symphony'
      }
    ]);
    expect(harness.envFileLoads).toEqual([path.join(projectRoot, '.env')]);
    expect(harness.stdout).toContain('Symphony dashboard startup context:');
    expect(harness.stdout).toContain(`project root: ${projectRoot} (project)`);
    expect(harness.stdout).toContain(`workflow: ${path.join(projectRoot, 'WORKFLOW.md')} (project)`);
    expect(harness.stdout).toContain(`env file: ${path.join(projectRoot, '.env')} (project)`);
    expect(harness.stdout).toContain('profile: project (default)');
    expect(harness.stdout).toContain('host: 127.0.0.1 (default)');
    expect(harness.stdout).toContain('port: 0 (cli)');
    expect(harness.stdout).toContain('consent: missing');
    expect(harness.stderr).toBe('');
  });

  it('delegates link-local arguments to the local linker', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({
      argv: ['link-local', '--target', '/tmp/symphony'],
      deps: harness.deps
    });

    expect(exitCode).toBe(28);
    expect(harness.linkLocalCalls).toEqual([['--target', '/tmp/symphony']]);
    expect(harness.stdout).toBe('');
    expect(harness.stderr).toBe('');
  });

  it('loads the explicit workflow project env file before delegating dashboard startup', async () => {
    const cwdProject = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-cwd-')));
    const explicitProject = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-explicit-')));
    await fs.writeFile(path.join(cwdProject, 'WORKFLOW.md'), 'cwd workflow\n', 'utf8');
    await fs.writeFile(path.join(cwdProject, '.env'), 'SYMPHONY_HOST=198.51.100.1\n', 'utf8');
    await fs.writeFile(path.join(explicitProject, 'WORKFLOW.md'), 'explicit workflow\n', 'utf8');
    await fs.writeFile(path.join(explicitProject, '.env'), 'SYMPHONY_HOST=203.0.113.7\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = cwdProject;

    const exitCode = await runCommandRouter({
      argv: ['dashboard', '--workflow', path.join(explicitProject, 'WORKFLOW.md'), '--port', '0'],
      deps: harness.deps
    });

    expect(exitCode).toBe(27);
    expect(harness.envFileLoads).toEqual([path.join(explicitProject, '.env')]);
    expect(harness.dashboardContexts).toEqual([
      {
        cwd: cwdProject,
        envFilePath: path.join(explicitProject, '.env'),
        repoRoot: '/repo/symphony'
      }
    ]);
    expect(harness.dashboardCalls).toEqual([
      [
        `--workflow=${path.join(explicitProject, 'WORKFLOW.md')}`,
        '--host=203.0.113.7',
        '--port=0'
      ]
    ]);
    expect(harness.stdout).toContain(`project root: ${explicitProject} (cli)`);
    expect(harness.stdout).toContain(`workflow: ${path.join(explicitProject, 'WORKFLOW.md')} (cli)`);
    expect(harness.stdout).toContain(`env file: ${path.join(explicitProject, '.env')} (project)`);
    expect(harness.stdout).toContain('host: 203.0.113.7 (env)');
    expect(harness.stderr).toBe('');
  });

  it('routes the symphony-internal profile through the checkout workflow and preserves consent flag', async () => {
    const externalProject = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-external-')));
    await fs.writeFile(path.join(externalProject, 'WORKFLOW.md'), 'external workflow\n', 'utf8');
    const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-repo-')));
    await fs.writeFile(path.join(repoRoot, 'WORKFLOW.md'), 'repo workflow\n', 'utf8');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = externalProject;

    const exitCode = await runCommandRouter({
      argv: [
        'dashboard',
        '--profile',
        'symphony-internal',
        '--host',
        '0.0.0.0',
        '--port',
        '0',
        '--i-understand-that-this-will-be-running-without-the-usual-guardrails'
      ],
      deps: harness.deps
    });

    expect(exitCode).toBe(27);
    expect(harness.envFileLoads).toEqual([path.join(repoRoot, '.env')]);
    expect(harness.dashboardContexts).toEqual([
      {
        cwd: externalProject,
        envFilePath: path.join(repoRoot, '.env'),
        repoRoot
      }
    ]);
    expect(harness.dashboardCalls).toEqual([
      [
        '--i-understand-that-this-will-be-running-without-the-usual-guardrails',
        `--workflow=${path.join(repoRoot, 'WORKFLOW.md')}`,
        '--host=0.0.0.0',
        '--port=0'
      ]
    ]);
    expect(harness.stdout).toContain(`project root: ${repoRoot} (profile)`);
    expect(harness.stdout).toContain(`workflow: ${path.join(repoRoot, 'WORKFLOW.md')} (profile)`);
    expect(harness.stdout).toContain('profile: symphony-internal (cli)');
    expect(harness.stdout).toContain('host: 0.0.0.0 (cli)');
    expect(harness.stdout).toContain('consent: flag');
    expect(harness.stderr).toBe('');
  });

  it('fails missing resolver-managed values before dashboard startup', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-missing-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['dashboard', '--workflow', '--port', '0'],
      deps: harness.deps
    });

    expect(exitCode).toBe(1);
    expect(harness.dashboardCalls).toEqual([]);
    expect(harness.envFileLoads).toEqual([]);
    expect(harness.stderr).toContain('cli workflow requires a value');
  });

  it('forwards wrapper termination signals to the active dashboard supervisor child', () => {
    const signalSource = new EventEmitter() as EventEmitter & {
      once(signal: DashboardSupervisorSignal, listener: () => void): EventEmitter;
      removeListener(signal: DashboardSupervisorSignal, listener: () => void): EventEmitter;
    };
    const forwardedSignals: DashboardSupervisorSignal[] = [];
    const child = {
      killed: false,
      kill: (signal: DashboardSupervisorSignal) => {
        forwardedSignals.push(signal);
        child.killed = true;
        return true;
      }
    };

    const binding = bindDashboardSupervisorSignalForwarding(child, signalSource);

    signalSource.emit('SIGTERM');
    signalSource.emit('SIGINT');
    binding.cleanup();

    expect(forwardedSignals).toEqual(['SIGTERM']);
    expect(binding.forwardedSignal()).toBe('SIGTERM');
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
  });

  it('cleans dashboard supervisor signal listeners when no signal was forwarded', () => {
    const signalSource = new EventEmitter() as EventEmitter & {
      once(signal: DashboardSupervisorSignal, listener: () => void): EventEmitter;
      removeListener(signal: DashboardSupervisorSignal, listener: () => void): EventEmitter;
    };
    const child = {
      killed: false,
      kill: () => {
        throw new Error('signal should not be forwarded');
      }
    };

    const binding = bindDashboardSupervisorSignalForwarding(child, signalSource);
    binding.cleanup();

    expect(binding.forwardedSignal()).toBeNull();
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
  });
});
