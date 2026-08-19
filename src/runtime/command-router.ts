import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline/promises';
import dotenv from 'dotenv';

import type { ResolveLocalCommandOptions, LocalCommandResolution } from './local-command-resolver';
import { LocalCommandResolutionError, resolveLocalCommand } from './local-command-resolver';
import { GUARDRAIL_ACK_FLAG } from './cli';
import { runLocalLinkCommand } from './local-link';
import { runLocalDoctor } from './local-doctor';
import { isWithinPath } from './path-containment';
import { ensureSystemGitignoreEntry, inspectProjectLayout, type ProjectLayoutInspection } from './project-layout-inspector';
import {
  buildSetupConsentRecord,
  createFileSetupConsentStore,
  findValidSetupConsent,
  persistSetupConsent,
  promptSetupConsent,
  resolveWorkflowPosture,
  type SetupConsentSource,
  type SetupConsentStore,
  type WorkflowPosture
} from './setup-consent';
import {
  getProfileBundle,
  getProfilePack,
  listProfileBundles,
  listProfilePacks,
  resolveProfileSelection,
  type ProfileBundle,
  type ProfilePackDimension,
  type ProfilePack,
  type ProfileResolution
} from '../workflow/profile-registry';
import {
  materializeWorkflowPlan as defaultMaterializeWorkflowPlan,
  renderWorkflowFilePlan,
  validateWorkflowContent,
  type WorkflowMaterializationPlan,
  type WorkflowMaterializerOptions,
  type WorkflowFilePlanEntry
} from '../workflow/materializer';
import { getPortableSkill, listPortableSkills } from '../workflow/portable-skill-catalog';

export interface DashboardLaunchContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  envFilePath: string;
  repoRoot: string;
}

export interface LinkLocalRunOptions {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface CommandRouterDependencies {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  runDashboard: (argv: readonly string[], context: DashboardLaunchContext) => Promise<number>;
  runLinkLocal: (argv: readonly string[], options?: LinkLocalRunOptions) => Promise<number>;
  resolveLocalCommand: (options: ResolveLocalCommandOptions) => LocalCommandResolution;
  resolveWorkflowPosture: (workflowPath: string, env?: NodeJS.ProcessEnv) => WorkflowPosture;
  setupConsentStore: SetupConsentStore;
  promptSetupConsent: typeof promptSetupConsent;
  loadEnvFile: (envFilePath: string) => void;
  promptInitOverwrite: (conflicts: readonly WorkflowFilePlanEntry[]) => Promise<boolean>;
  promptInitInputs: (options: PromptInitInputsOptions) => Promise<PromptInitInputsResult>;
  materializeWorkflowPlan: (options: WorkflowMaterializerOptions) => WorkflowMaterializationPlan;
  clock: () => Date;
  packageVersion: string;
  repoRoot: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdinIsTTY: () => boolean;
  stdoutIsTTY: () => boolean;
}

export interface RunCommandRouterOptions {
  argv: readonly string[];
  deps?: Partial<CommandRouterDependencies>;
}

export type DashboardSupervisorSignal = 'SIGINT' | 'SIGTERM';

interface DashboardSupervisorSignalTarget {
  killed?: boolean;
  kill(signal: DashboardSupervisorSignal): unknown;
}

interface DashboardSupervisorSignalSource {
  once(signal: DashboardSupervisorSignal, listener: () => void): unknown;
  removeListener(signal: DashboardSupervisorSignal, listener: () => void): unknown;
}

export interface DashboardSupervisorSignalBinding {
  cleanup: () => void;
  forwardedSignal: () => DashboardSupervisorSignal | null;
}

const SUPPORTED_COMMANDS = ['dashboard', 'doctor', 'setup', 'profile', 'init', 'link-local'] as const;

function defaultRepoRoot(): string {
  let current = __dirname;
  for (let depth = 0; depth < 5; depth += 1) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return process.cwd();
}

function readPackageVersion(repoRoot: string): string {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof payload.version === 'string' ? payload.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function bindDashboardSupervisorSignalForwarding(
  child: DashboardSupervisorSignalTarget,
  signalSource: DashboardSupervisorSignalSource = process
): DashboardSupervisorSignalBinding {
  let forwarded: DashboardSupervisorSignal | null = null;

  const handlers: Record<DashboardSupervisorSignal, () => void> = {
    SIGINT: () => {
      if (forwarded) {
        return;
      }
      forwarded = 'SIGINT';
      if (!child.killed) {
        child.kill('SIGINT');
      }
    },
    SIGTERM: () => {
      if (forwarded) {
        return;
      }
      forwarded = 'SIGTERM';
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }
  };

  signalSource.once('SIGINT', handlers.SIGINT);
  signalSource.once('SIGTERM', handlers.SIGTERM);

  return {
    cleanup: () => {
      signalSource.removeListener('SIGINT', handlers.SIGINT);
      signalSource.removeListener('SIGTERM', handlers.SIGTERM);
    },
    forwardedSignal: () => forwarded
  };
}

function signalExitCode(signal: DashboardSupervisorSignal): number {
  return signal === 'SIGINT' ? 130 : 143;
}

function runDashboardSupervisor(
  argv: readonly string[],
  context: DashboardLaunchContext
): Promise<number> {
  const supervisorScript = path.join(context.repoRoot, 'scripts', 'start-dashboard-supervisor.js');
  const env = {
    ...process.env,
    ...context.env,
    SYMPHONY_ENV_FILE: context.envFilePath
  };

  return new Promise((resolve) => {
    const child: ChildProcess = spawn(process.execPath, [supervisorScript, ...argv], {
      cwd: context.cwd,
      env,
      stdio: 'inherit'
    });
    const signalBinding = bindDashboardSupervisorSignalForwarding(child);
    let settled = false;

    const settle = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      signalBinding.cleanup();
      resolve(exitCode);
    };

    child.on('error', (error) => {
      process.stderr.write(`Failed to start dashboard supervisor: ${error.message}\n`);
      settle(1);
    });

    child.on('exit', (code, signal) => {
      const forwardedSignal = signalBinding.forwardedSignal();
      if (forwardedSignal) {
        settle(signalExitCode(forwardedSignal));
        return;
      }
      if (typeof code === 'number') {
        settle(code);
        return;
      }
      process.stderr.write(`Dashboard supervisor exited from signal ${signal || 'unknown'}\n`);
      settle(1);
    });
  });
}

function defaultDependencies(): CommandRouterDependencies {
  const repoRoot = defaultRepoRoot();
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    runDashboard: (argv, context) => runDashboardSupervisor(argv, context),
    runLinkLocal: (argv, linkOptions) =>
      runLocalLinkCommand({
        argv,
        deps: {
          repoRoot,
          stdout: linkOptions?.stdout,
          stderr: linkOptions?.stderr
        }
      }),
    resolveLocalCommand,
    resolveWorkflowPosture,
    setupConsentStore: createFileSetupConsentStore(),
    promptSetupConsent,
    loadEnvFile: (envFilePath) => {
      dotenv.config({ path: envFilePath });
    },
    promptInitOverwrite: (conflicts) => promptInitOverwrite(conflicts),
    promptInitInputs: (options) => promptInitInputs(options),
    materializeWorkflowPlan: defaultMaterializeWorkflowPlan,
    clock: () => new Date(),
    packageVersion: readPackageVersion(repoRoot),
    repoRoot,
    cwd: process.cwd(),
    env: process.env,
    stdinIsTTY: () => Boolean(process.stdin.isTTY),
    stdoutIsTTY: () => Boolean(process.stdout.isTTY)
  };
}

function renderDashboardResolution(
  resolved: LocalCommandResolution,
  posture: WorkflowPosture,
  consentSource: SetupConsentSource
): string {
  return [
    'Symphony dashboard startup context:',
    `  project root: ${resolved.currentProjectRoot} (${resolved.sources.projectRoot})`,
    `  workflow: ${resolved.workflowPath} (${resolved.sources.workflowPath})`,
    `  env file: ${resolved.envFilePath} (${resolved.sources.envFilePath})`,
    `  profile: ${resolved.profile.name} (${resolved.profile.source})`,
    `  host: ${resolved.host.host} (${resolved.host.source})`,
    `  port: ${resolved.port.port} (${resolved.port.source})`,
    `  required posture: ${posture.posture}`,
    `  reason: ${posture.reason}`,
    `  consent: ${consentSource}`,
    ''
  ].join('\n');
}

function renderHelp(): string {
  return [
    'Symphony local command',
    '',
    'Usage:',
    '  symphony <command> [options]',
    '  symphony --help',
    '  symphony --version',
    '',
    'Commands:',
    '  dashboard       Start the local Symphony dashboard using the existing runner',
    '  doctor          Run local command and dashboard adoption readiness checks',
    '  setup           Record user-local setup consent for this workflow',
    '  profile         Inspect bounded local command profiles',
    '  init            Materialize a generated WORKFLOW.md and local runtime ignore plan',
    '  link-local      Link this checkout as a stable local symphony executable',
    '',
    'Run `symphony <command> --help` for command-specific help.'
  ].join('\n');
}

function renderDashboardHelp(): string {
  return [
    'Symphony dashboard',
    '',
    'Usage:',
    '  symphony dashboard [workflow-path] [options]',
    '  symphony dashboard --workflow <path> [options]',
    '',
    'Starts the local Symphony dashboard for a resolved project workflow.',
    '',
    'Options:',
    '  --workflow <path>  Use an explicit WORKFLOW.md path',
    '  --port <port>      Bind the dashboard to a port',
    '  --host <host>      Bind the dashboard to a host',
    '  --env-file <path>  Load environment values from an explicit file',
    '  --profile <name>   Select a bounded local command profile',
    '  --offline          Start without network-dependent integrations',
    '  --logs-root <path> Write runtime logs under an explicit directory',
    '  -h, --help         Show this help'
  ].join('\n');
}

function renderSetupHelp(): string {
  return [
    'Symphony setup',
    '',
    'Usage:',
    '  symphony setup [--yes] [resolver options]',
    '',
    'Records explicit user-local consent for the resolved project/workflow identity.',
    'Project files can declare required posture, but they cannot grant consent.'
  ].join('\n');
}

function renderDoctorHelp(): string {
  return [
    'Symphony doctor',
    '',
    'Usage:',
    '  symphony doctor [--json] [--ci] [--fix] [--yes] [--claude-smoke --linear-issue <id>] [resolver options]',
    '',
    'Checks local command linking, workflow resolution, setup consent, env path,',
    'host/port readiness, and dashboard supervisor prerequisites.',
    '`--claude-smoke` is explicit, mutating, and consumes Claude quota to verify Linear read/write readiness.',
    '',
    'Exit codes:',
    '  0  clean',
    '  1  warning-only findings',
    '  2  blocker findings'
  ].join('\n');
}

function hasExplicitSetupConsentArg(argv: readonly string[]): boolean {
  return argv.includes('--yes') || argv.includes('--accept-high-trust-local-run');
}

function renderSetupSummary(params: {
  resolved: LocalCommandResolution;
  posture: WorkflowPosture;
  storePath: string;
  layout: ProjectLayoutInspection;
}): string {
  const layoutWarnings =
    params.layout.warnings.length === 0
      ? ['  warnings: none']
      : params.layout.warnings.map((warning) => `  warning: ${warning.message} next: ${warning.remediation}`);
  const legacySummary =
    params.layout.legacyRuntimePaths.length === 0
      ? 'none'
      : params.layout.legacyRuntimePaths.map((item) => item.path).join(', ');

  return [
    'Symphony setup high-trust consent:',
    `  project root: ${params.resolved.currentProjectRoot} (${params.resolved.sources.projectRoot})`,
    `  workflow: ${params.resolved.workflowPath} (${params.resolved.sources.workflowPath})`,
    `  identity key: ${params.resolved.projectIdentity.key}`,
    `  required posture: ${params.posture.posture}`,
    `  reason: ${params.posture.reason}`,
    `  consent store: ${params.storePath}`,
    '',
    'Project layout:',
    `  status: ${params.layout.status}`,
    `  workflow root: ${params.layout.workflow.exists ? 'present' : 'missing'} (${params.layout.workflow.path})`,
    `  runtime state root: ${params.layout.runtimeStateRoot.path}/`,
    `  gitignore: ${params.layout.ignoreAnalysis.status}`,
    `  reserved customization: ${params.layout.reservedCustomizationPaths.map((item) => item.path).join(', ')}`,
    `  legacy runtime paths: ${legacySummary}`,
    ...layoutWarnings,
    '',
    'Consent is user-local and scoped to this exact project/workflow identity.',
    'WORKFLOW.md can explain the required posture, but it cannot grant consent.',
    ''
  ].join('\n');
}

async function runSetupCommand(
  argv: readonly string[],
  deps: CommandRouterDependencies
): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    deps.stdout(`${renderSetupHelp()}\n`);
    return 0;
  }

  let resolved: LocalCommandResolution;
  try {
    resolved = deps.resolveLocalCommand({
      command: 'setup',
      argv,
      cwd: deps.cwd,
      env: deps.env,
      symphonyCheckoutRoot: deps.repoRoot
    });
  } catch (error) {
    const message =
      error instanceof LocalCommandResolutionError || error instanceof Error ? error.message : String(error);
    deps.stderr(`${message}\n`);
    return 1;
  }

  if (isWithinPath(resolved.currentProjectRoot, deps.setupConsentStore.path)) {
    deps.stderr('Refusing to store setup consent under the project checkout; choose a user-local state path.\n');
    return 1;
  }

  const posture = deps.resolveWorkflowPosture(resolved.workflowPath, deps.env);
  let layout = inspectProjectLayout(resolved.currentProjectRoot);
  deps.stdout(renderSetupSummary({ resolved, posture, storePath: deps.setupConsentStore.path, layout }));

  const approved =
    hasExplicitSetupConsentArg(argv) ||
    (await deps.promptSetupConsent({ resolved, posture, input: process.stdin, output: process.stdout }));
  if (!approved) {
    deps.stderr('Setup consent was not recorded because explicit approval was not provided.\n');
    return 1;
  }

  if (!layout.ignoreAnalysis.hasNarrowSystemIgnore) {
    const fix = ensureSystemGitignoreEntry(resolved.currentProjectRoot);
    deps.stdout(`[${fix.status}] layout.gitignore-system: ${fix.summary}\n`);
    if (fix.status === 'failed') {
      return 1;
    }
    layout = inspectProjectLayout(resolved.currentProjectRoot);
  }

  const record = buildSetupConsentRecord({
    resolved,
    posture,
    approvedAt: deps.clock().toISOString()
  });
  persistSetupConsent(deps.setupConsentStore, record);
  deps.stdout(`Setup consent recorded for identity ${record.identity_key}.\n`);
  return 0;
}

function renderInitHelp(): string {
  return [
    'Symphony init',
    '',
    'Usage:',
    '  symphony init --help',
    '  symphony init --bundle memory-generic',
    '  symphony init --dry-run --bundle memory-generic',
    '  symphony init --force --bundle memory-generic',
    '  symphony init --force-skills --bundle memory-generic',
    '  symphony init --dry-run --bundle memory-generic --skill commit --skill land',
    '  symphony init --dry-run --bundle memory-generic --skills commit,land',
    '  symphony init --dry-run --bundle memory-generic --no-skills',
    '  symphony init --dry-run --pack tracker:memory --pack workspace:none --pack toolchain:generic --pack workflow:solo-local',
    '  symphony init --tracker memory --workspace none --toolchain generic --workflow solo-local',
    '  symphony init --bundle linear-node --linear-project-slug SYMPHONY',
    '  symphony init --bundle github-node --github-owner octo-org --github-repo octo-repo',
    '  symphony init --no-input --bundle memory-generic',
    '',
    'Writes are non-destructive by default. Existing generated targets require',
    'interactive confirmation or --force. Use --force-skills to overwrite only',
    'project-local portable skills. Dry-run renders the same file plan without writing files.',
    '',
    'Portable skills:',
    `  Default: ${listPortableSkills()
      .filter((skill) => skill.defaultRecommended)
      .map((skill) => skill.id)
      .join(', ')}`,
    `  Available: ${listPortableSkills()
      .map((skill) => skill.id)
      .join(', ')}`,
    '  Use --skill <name> repeatedly or --skills <name,name> to select an explicit set.',
    '  Use --no-skills to opt out of project-local skill materialization.',
    '',
    'When run from a TTY, missing init selections and hosted tracker inputs are',
    'prompted interactively. Use --no-input, explicit flags, or CI=true for',
    'deterministic non-interactive operation.'
  ].join('\n');
}

function renderProfileHelp(): string {
  return [
    'Symphony profiles',
    '',
    'Usage:',
    '  symphony profile list',
    '  symphony profile show <pack-or-bundle>',
    '  symphony profile show symphony-internal',
    '',
    'Discovery only:',
    '  Packs and bundles describe init materialization inputs.',
    '  Runtime execution continues to use the materialized workflow file.',
    '',
    'Examples:',
    '  symphony profile show linear-node',
    '  symphony profile show tracker:memory'
  ].join('\n');
}

function renderProfileList(repoRoot: string): string {
  const lines = [
    'Symphony profile registry',
    '',
    'Packs:',
    ...listProfilePacks().map((pack) => renderProfilePackSummary(pack, repoRoot)),
    '',
    'Bundles:',
    ...listProfileBundles().map(
      (bundle) =>
        `  ${bundle.id}\t${bundle.title}\n    expands: ${bundle.packs.join(', ')}\n    intended use: ${bundle.intendedUse}`
    ),
    '',
    'Conflict model:',
    '  Select exactly one pack for each required dimension: tracker, workspace, toolchain, workflow.',
    '  Packs in the same dimension conflict; choose a bundle or one explicit pack per dimension.',
    '',
    'Protected profiles:',
    `  symphony-internal -> workflow:symphony-internal (${path.join(repoRoot, 'WORKFLOW.md')})`,
    '  Protected bindings are golden references to checked-in workflows, not generated templates.'
  ];
  return `${lines.join('\n')}\n`;
}

function renderProfilePackSummary(pack: ProfilePack, repoRoot: string): string {
  const markers: string[] = [pack.dimension];
  if (pack.protected) {
    markers.push('protected');
  }
  const binding = pack.binding ? `\n    binding: ${renderProfilePackBinding(pack, repoRoot)}` : '';
  return `  ${pack.id}\t${markers.join(', ')}\n    ${pack.summary}\n    intended use: ${pack.intendedUse}${binding}`;
}

function renderProfilePackBinding(pack: ProfilePack, repoRoot: string): string {
  if (!pack.binding) {
    return 'none';
  }
  if (pack.binding.kind === 'checked-in-workflow') {
    return `${path.join(repoRoot, pack.binding.path)} (${pack.binding.description})`;
  }
  return pack.binding.description;
}

function renderProfileSelectionResolution(resolution: ProfileResolution): string[] {
  const lines = [
    'Resolution:',
    `  requested: ${resolution.requested.join(', ') || '(none)'}`,
    `  packs: ${resolution.packs.map((pack) => pack.id).join(', ') || '(none)'}`
  ];

  if (resolution.expandedBundles.length > 0) {
    lines.push('  bundle expansions:');
    for (const expansion of resolution.expandedBundles) {
      lines.push(`    ${expansion.bundle.id} -> ${expansion.packs.join(', ')}`);
    }
  }

  lines.push('  dimensions:');
  for (const dimension of ['tracker', 'workspace', 'toolchain', 'workflow'] as const) {
    lines.push(`    ${dimension}: ${resolution.dimensions[dimension]?.id ?? '(missing)'}`);
  }

  if (resolution.errors.length > 0) {
    lines.push('  errors:');
    for (const error of resolution.errors) {
      lines.push(`    - ${error}`);
    }
  } else {
    lines.push('  errors: none');
  }

  if (resolution.warnings.length > 0) {
    lines.push('  warnings:');
    for (const warning of resolution.warnings) {
      lines.push(`    - ${warning}`);
    }
  }

  return lines;
}

function renderProfileBundle(bundle: ProfileBundle): string {
  const resolution = resolveProfileSelection([bundle.id]);
  return [
    `Bundle: ${bundle.id}`,
    `Title: ${bundle.title}`,
    `Summary: ${bundle.summary}`,
    `Intended use: ${bundle.intendedUse}`,
    `Expands to: ${bundle.packs.join(', ')}`,
    ...renderProfileSelectionResolution(resolution)
  ].join('\n');
}

function renderProfilePack(pack: ProfilePack, repoRoot: string): string {
  const sameDimensionConflicts = listProfilePacks()
    .filter((candidate) => candidate.dimension === pack.dimension && candidate.id !== pack.id)
    .map((candidate) => candidate.id);
  const resolution = resolveProfileSelection([pack.id]);
  const lines = [
    `Pack: ${pack.id}`,
    `Title: ${pack.title}`,
    `Dimension: ${pack.dimension}`,
    `Summary: ${pack.summary}`,
    `Intended use: ${pack.intendedUse}`,
    `Conflicts: ${sameDimensionConflicts.length > 0 ? sameDimensionConflicts.join(', ') : 'none'}`,
    `Protected: ${pack.protected ? 'yes' : 'no'}`,
    `Binding: ${pack.binding ? renderProfilePackBinding(pack, repoRoot) : 'none'}`,
    ...renderProfileSelectionResolution(resolution)
  ];
  if (pack.id === 'workflow:symphony-internal') {
    lines.unshift('Type: protected');
    lines.unshift('Profile: symphony-internal');
  }
  return lines.join('\n');
}

function failUnsupported(
  deps: CommandRouterDependencies,
  message: string,
  help: string
): number {
  deps.stderr(`${message}\n\n${help}\n`);
  return 1;
}

function runProfileCommand(argv: readonly string[], deps: CommandRouterDependencies): number {
  const [mode, value, ...extra] = argv;

  if (mode === '--help' || mode === '-h') {
    deps.stdout(`${renderProfileHelp()}\n`);
    return 0;
  }

  if (mode === 'list' && extra.length === 0 && value === undefined) {
    deps.stdout(renderProfileList(deps.repoRoot));
    return 0;
  }

  if (mode === 'show' && value !== undefined && extra.length === 0) {
    const bundle = getProfileBundle(value);
    if (bundle) {
      deps.stdout(`${renderProfileBundle(bundle)}\n`);
      return 0;
    }

    const pack = getProfilePack(value);
    if (pack) {
      deps.stdout(`${renderProfilePack(pack, deps.repoRoot)}\n`);
      return 0;
    }
  }

  return failUnsupported(
    deps,
    `Unsupported profile command: ${argv.join(' ') || '(missing mode)'}`,
    renderProfileHelp()
  );
}

interface ParsedInitSelections {
  dryRun: boolean;
  force: boolean;
  forceSkills: boolean;
  noInput: boolean;
  selections: string[];
  portableSkillIds: string[] | null;
  noPortableSkills: boolean;
  errors: string[];
  linearProjectSlug: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
}

interface PromptInitInputsOptions {
  parsed: ParsedInitSelections;
  resolution: ProfileResolution;
  projectFacts: ReturnType<typeof detectInitProjectFacts>;
}

interface PromptInitInputsResult {
  selections: string[];
  linearProjectSlug: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
}

function parseInitSelections(argv: readonly string[]): ParsedInitSelections {
  const selections: string[] = [];
  const errors: string[] = [];
  let dryRun = false;
  let force = false;
  let forceSkills = false;
  let noInput = false;
  let portableSkillIds: string[] | null = null;
  let noPortableSkills = false;
  let linearProjectSlug: string | null = null;
  let githubOwner: string | null = null;
  let githubRepo: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--force-skills' || arg === '--force-portable-skills') {
      forceSkills = true;
      continue;
    }
    if (arg === '--no-input' || arg === '--ci') {
      noInput = true;
      continue;
    }
    if (arg === '--no-skills') {
      noPortableSkills = true;
      continue;
    }
    if (arg === '--skill' || arg === '--skills') {
      const value = argv[index + 1];
      if (!value) {
        errors.push(`${arg} requires a value.`);
      } else {
        portableSkillIds = portableSkillIds ?? [];
        portableSkillIds.push(...parsePortableSkillList(value));
        index += 1;
      }
      continue;
    }
    if (arg === '--bundle' || arg === '--pack') {
      const value = argv[index + 1];
      if (!value) {
        errors.push(`${arg} requires a value.`);
      } else {
        selections.push(value);
        index += 1;
      }
      continue;
    }
    if (arg === '--tracker' || arg === '--workspace' || arg === '--toolchain' || arg === '--workflow') {
      const value = argv[index + 1];
      if (!value) {
        errors.push(`${arg} requires a value.`);
      } else {
        selections.push(`${arg.slice(2)}:${value}`);
        index += 1;
      }
      continue;
    }
    if (arg === '--linear-project-slug' || arg === '--linear-project') {
      const value = argv[index + 1];
      if (!value) {
        errors.push(`${arg} requires a value.`);
      } else {
        linearProjectSlug = value;
        index += 1;
      }
      continue;
    }
    if (arg === '--github-owner') {
      const value = argv[index + 1];
      if (!value) {
        errors.push(`${arg} requires a value.`);
      } else {
        githubOwner = value;
        index += 1;
      }
      continue;
    }
    if (arg === '--github-repo') {
      const value = argv[index + 1];
      if (!value) {
        errors.push(`${arg} requires a value.`);
      } else {
        githubRepo = value;
        index += 1;
      }
      continue;
    }
    errors.push(`Unsupported init option: ${arg}`);
  }

  if (noPortableSkills && portableSkillIds && portableSkillIds.length > 0) {
    errors.push('--no-skills cannot be combined with --skill or --skills.');
  }
  if (portableSkillIds) {
    for (const id of portableSkillIds) {
      if (!getPortableSkill(id)) {
        errors.push(`Unknown portable skill '${id}'. Choose one of: ${listPortableSkills().map((skill) => skill.id).join(', ')}.`);
      }
    }
  }

  return {
    dryRun,
    force,
    forceSkills,
    noInput,
    selections,
    portableSkillIds,
    noPortableSkills,
    errors,
    linearProjectSlug,
    githubOwner,
    githubRepo
  };
}

function parsePortableSkillList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function detectInitProjectFacts(cwd: string): {
  root: string;
  packageManager: string | null;
  existingWorkflowPath: string | null;
  githubRepository: { owner: string; repo: string; remote: string } | null;
} {
  const root = findGitWorkTreeRoot(cwd) ?? fs.realpathSync(cwd);
  const packageManager = detectPackageManager(root);
  const workflowPath = path.join(root, 'WORKFLOW.md');
  return {
    root,
    packageManager,
    existingWorkflowPath: fs.existsSync(workflowPath) ? workflowPath : null,
    githubRepository: detectGitHubRepository(root)
  };
}

function detectPackageManager(root: string): string | null {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(root, 'yarn.lock'))) {
    return 'yarn';
  }
  if (fs.existsSync(path.join(root, 'package-lock.json'))) {
    return 'npm';
  }
  if (fs.existsSync(path.join(root, 'package.json'))) {
    return 'npm';
  }
  return null;
}

function detectGitHubRepository(root: string): { owner: string; repo: string; remote: string } | null {
  const remoteCandidates = ['origin', 'upstream'];
  for (const remote of remoteCandidates) {
    try {
      const url = execFileSync('git', ['config', '--get', `remote.${remote}.url`], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      const parsed = parseGitHubRemoteUrl(url);
      if (parsed) {
        return { ...parsed, remote };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function parseGitHubRemoteUrl(url: string): { owner: string; repo: string } | null {
  const normalized = url.trim().replace(/\.git$/, '');
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/.exec(normalized);
  if (ssh) {
    return { owner: ssh[1], repo: ssh[2] };
  }

  const https = /^https:\/\/github\.com\/([^/]+)\/(.+)$/.exec(normalized);
  if (https) {
    return { owner: https[1], repo: https[2] };
  }

  const gh = /^gh:([^/]+)\/(.+)$/.exec(normalized);
  if (gh) {
    return { owner: gh[1], repo: gh[2] };
  }

  return null;
}

function findGitWorkTreeRoot(cwd: string): string | null {
  let current = fs.realpathSync(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function promptInitOverwrite(conflicts: readonly WorkflowFilePlanEntry[]): Promise<boolean> {
  process.stdout.write(
    `Overwrite ${conflicts.length} existing Symphony init file${conflicts.length === 1 ? '' : 's'}? Type yes to continue: `
  );
  return new Promise((resolve) => {
    let answer = '';
    const input = process.stdin;
    const settle = (approved: boolean) => {
      input.off('data', onData);
      input.off('end', onEnd);
      resolve(approved);
    };
    const onEnd = () => settle(false);
    const onData = (chunk: Buffer | string) => {
      answer += chunk.toString();
      if (answer.includes('\n')) {
        const normalized = answer.trim().toLowerCase();
        settle(normalized === 'yes' || normalized === 'y');
      }
    };
    input.setEncoding('utf8');
    input.on('data', onData);
    input.once('end', onEnd);
    input.resume();
  });
}

async function promptInitInputs(options: PromptInitInputsOptions): Promise<PromptInitInputsResult> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await promptInitInputsWithQuestion(options, (question) => rl.question(question));
  } finally {
    rl.close();
  }
}

async function promptInitInputsWithQuestion(
  options: PromptInitInputsOptions,
  ask: (question: string) => Promise<string>
): Promise<PromptInitInputsResult> {
  const selections = [...options.parsed.selections];
  let resolution = options.resolution;
  for (const dimension of ['tracker', 'workspace', 'toolchain', 'workflow'] as const) {
    if (resolution.dimensions[dimension]) {
      continue;
    }
    const packId = await promptForDimensionPack(dimension, ask);
    selections.push(packId);
    resolution = resolveProfileSelection(selections);
  }

  const trackerKind = resolution.dimensions.tracker?.name;
  let linearProjectSlug = options.parsed.linearProjectSlug;
  let githubOwner = options.parsed.githubOwner;
  let githubRepo = options.parsed.githubRepo;

  if (trackerKind === 'linear' && !linearProjectSlug?.trim()) {
    linearProjectSlug = (await promptForRequiredText('Linear project slug', ask)).trim();
  }

  if (trackerKind === 'github') {
    const detected = options.projectFacts.githubRepository;
    if (!githubOwner?.trim() && !detected?.owner) {
      githubOwner = (await promptForRequiredText('GitHub owner', ask)).trim();
    }
    if (!githubRepo?.trim() && !detected?.repo) {
      githubRepo = (await promptForRequiredText('GitHub repo', ask)).trim();
    }
  }

  return { selections, linearProjectSlug, githubOwner, githubRepo };
}

async function promptForDimensionPack(
  dimension: ProfilePackDimension,
  ask: (question: string) => Promise<string>
): Promise<string> {
  const packs = listProfilePacks().filter((pack) => pack.dimension === dimension && !pack.protected);
  const choices = packs
    .map((pack, index) => `  ${index + 1}. ${pack.name} (${pack.id}) - ${pack.summary}`)
    .join('\n');

  while (true) {
    const answer = (
      await ask(`Choose ${dimension} pack:\n${choices}\nEnter number, name, or pack id: `)
    ).trim();
    const selected = matchPromptedPack(answer, packs);
    if (selected) {
      return selected.id;
    }
    process.stdout.write(`Unknown ${dimension} selection '${answer}'. Choose one of: ${packs.map((pack) => pack.name).join(', ')}.\n`);
  }
}

function matchPromptedPack(answer: string, packs: readonly ProfilePack[]): ProfilePack | null {
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= packs.length) {
    return packs[index - 1];
  }
  const normalized = answer.toLowerCase();
  return (
    packs.find((pack) => pack.id.toLowerCase() === normalized || pack.name.toLowerCase() === normalized) ?? null
  );
}

async function promptForRequiredText(label: string, ask: (question: string) => Promise<string>): Promise<string> {
  while (true) {
    const answer = await ask(`${label}: `);
    if (answer.trim()) {
      return answer;
    }
    process.stdout.write(`${label} is required.\n`);
  }
}

function initPromptsAllowed(parsed: ParsedInitSelections, deps: CommandRouterDependencies): boolean {
  return !parsed.noInput && !isTruthyEnv(deps.env.CI) && deps.stdinIsTTY() && deps.stdoutIsTTY();
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return !['0', 'false', 'no'].includes(value.toLowerCase());
}

function renderHostedInputErrors(params: {
  resolution: ProfileResolution;
  projectFacts: ReturnType<typeof detectInitProjectFacts>;
  parsed: ParsedInitSelections;
}): string[] {
  const trackerKind = params.resolution.dimensions.tracker?.name;
  const errors: string[] = [];
  if (trackerKind === 'linear' && !params.parsed.linearProjectSlug?.trim()) {
    errors.push('Missing required Linear project slug. Pass --linear-project-slug <slug> or run `symphony init` interactively from a TTY.');
  }
  if (trackerKind === 'github') {
    const detected = params.projectFacts.githubRepository;
    if (!params.parsed.githubOwner?.trim() && !detected?.owner) {
      errors.push('Missing required GitHub owner. Pass --github-owner <owner> or run `symphony init` interactively from a TTY.');
    }
    if (!params.parsed.githubRepo?.trim() && !detected?.repo) {
      errors.push('Missing required GitHub repo. Pass --github-repo <repo> or run `symphony init` interactively from a TTY.');
    }
  }
  return errors;
}

function nonInteractiveSelectionGuidance(parsed: ParsedInitSelections): string {
  if (parsed.noInput) {
    return 'Non-interactive init was requested with --no-input/--ci; provide a bundle or all required --tracker/--workspace/--toolchain/--workflow flags.';
  }
  return 'Run `symphony init` from an interactive TTY, choose a --bundle, or provide all required --tracker/--workspace/--toolchain/--workflow flags.';
}

function renderInitConflicts(conflicts: readonly WorkflowFilePlanEntry[]): string {
  const directoryConflicts = conflicts.filter((file) => file.conflictType === 'directory');
  return [
    'Symphony init found existing files that would be overwritten:',
    ...conflicts.map((file) => `  - ${file.path}`),
    ...(directoryConflicts.length > 0
      ? [
          '',
          'Some conflicting paths are directories at locations where Symphony needs to write files:',
          ...directoryConflicts.map((file) => `  - ${file.path}`),
          'Move or remove those directories before rerunning init; --force-skills does not delete directories.'
        ]
      : []),
    '',
    'To preserve local customizations, Symphony did not write any conflicting files.',
    'Resolve by moving or editing the listed paths, re-run interactively and confirm,',
    'or pass --force-skills for .codex/skills conflicts only. Use --force only when all',
    'generated init overwrites are intentional.'
  ].join('\n');
}

function isPortableSkillPlanEntry(file: WorkflowFilePlanEntry): boolean {
  const normalized = file.path.split(path.sep).join('/');
  return normalized === '.codex/skills' || normalized.startsWith('.codex/skills/');
}

function writeInitFilePlan(plan: WorkflowMaterializationPlan): void {
  for (const file of plan.files) {
    if (!file.wouldWrite || file.action === 'skip') {
      continue;
    }
    const absolutePath = path.join(plan.detectedProjectFacts.root, file.path);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, file.content ?? '', 'utf8');
    if (typeof file.mode === 'number') {
      fs.chmodSync(absolutePath, file.mode & 0o777);
    }
  }
}

function renderInitWriteSummary(plan: WorkflowMaterializationPlan): string {
  const written = plan.files.filter((file) => file.wouldWrite && file.action !== 'skip');
  const skipped = plan.files.filter((file) => file.action === 'skip');
  return [
    'Symphony init write complete',
    '',
    `Selections: ${plan.selections.join(', ') || '(none)'}`,
    `Project root: ${plan.detectedProjectFacts.root}`,
    `Writes performed: ${written.length}`,
    `Skipped unchanged: ${skipped.length}`,
    `Validation: ${plan.validation.ok ? 'ok' : `failed (${plan.validation.error_code})`}`,
    '',
    'Files:',
    ...plan.files.map((file) => `  - ${file.path}: ${file.action}${file.wouldWrite && file.action !== 'skip' ? ' written' : ''}`)
  ].join('\n');
}

async function runInitCommand(argv: readonly string[], deps: CommandRouterDependencies): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    deps.stdout(`${renderInitHelp()}\n`);
    return 0;
  }

  const parsed = parseInitSelections(argv);
  if (parsed.errors.length > 0) {
    deps.stderr(`${parsed.errors.join('\n')}\n\n${renderInitHelp()}\n`);
    return 1;
  }

  const projectFacts = detectInitProjectFacts(deps.cwd);
  let resolution = resolveProfileSelection(parsed.selections);
  if (resolution.errors.length > 0 && initPromptsAllowed(parsed, deps)) {
    const onlyMissingSelections = resolution.errors.every((error) => error.startsWith('Missing required '));
    if (onlyMissingSelections) {
      const prompted = await deps.promptInitInputs({ parsed, resolution, projectFacts });
      parsed.selections = prompted.selections;
      parsed.linearProjectSlug = prompted.linearProjectSlug;
      parsed.githubOwner = prompted.githubOwner;
      parsed.githubRepo = prompted.githubRepo;
      resolution = resolveProfileSelection(parsed.selections);
    }
  }

  if (resolution.errors.length > 0) {
    deps.stderr(`${resolution.errors.join('\n')}\n${nonInteractiveSelectionGuidance(parsed)}\n`);
    return 1;
  }

  const hostedInputErrors = renderHostedInputErrors({ resolution, projectFacts, parsed });
  if (hostedInputErrors.length > 0 && initPromptsAllowed(parsed, deps)) {
    const prompted = await deps.promptInitInputs({ parsed, resolution, projectFacts });
    parsed.selections = prompted.selections;
    parsed.linearProjectSlug = prompted.linearProjectSlug;
    parsed.githubOwner = prompted.githubOwner;
    parsed.githubRepo = prompted.githubRepo;
  }

  const remainingHostedInputErrors = renderHostedInputErrors({ resolution, projectFacts, parsed });
  if (remainingHostedInputErrors.length > 0) {
    deps.stderr(`${remainingHostedInputErrors.join('\n')}\n`);
    return 1;
  }

  try {
    const plan = deps.materializeWorkflowPlan({
      resolution,
      projectFacts,
      choices: {
        dryRun: parsed.dryRun,
        selections: parsed.selections,
        portableSkillIds: parsed.portableSkillIds ?? undefined,
        noPortableSkills: parsed.noPortableSkills,
        linearProjectSlug: parsed.linearProjectSlug,
        githubOwner: parsed.githubOwner,
        githubRepo: parsed.githubRepo
      },
      clock: deps.clock
    });
    if (!plan.validation.ok) {
      deps.stderr(`Generated workflow validation failed: ${plan.validation.message}\n`);
      return 1;
    }

    if (parsed.dryRun) {
      deps.stdout(renderWorkflowFilePlan(plan));
      return 0;
    }

    const conflicts = plan.files.filter((file) => file.requiresOverwriteApproval);
    const hardConflicts = conflicts.filter((file) => file.conflictType === 'directory');
    if (hardConflicts.length > 0) {
      deps.stderr(`${renderInitConflicts(hardConflicts)}\n`);
      return 1;
    }

    const unresolvedConflicts = conflicts.filter(
      (file) => !parsed.force && !(parsed.forceSkills && isPortableSkillPlanEntry(file))
    );
    if (unresolvedConflicts.length > 0) {
      if (initPromptsAllowed(parsed, deps)) {
        const approved = await deps.promptInitOverwrite(unresolvedConflicts);
        if (!approved) {
          deps.stderr(`${renderInitConflicts(unresolvedConflicts)}\n`);
          return 1;
        }
      } else {
        deps.stderr(`${renderInitConflicts(unresolvedConflicts)}\n`);
        return 1;
      }
    }

    writeInitFilePlan(plan);
    const workflowPath = path.join(plan.detectedProjectFacts.root, 'WORKFLOW.md');
    const materializedWorkflowValidation = validateWorkflowContent(fs.readFileSync(workflowPath, 'utf8'), workflowPath);
    if (!materializedWorkflowValidation.ok) {
      deps.stderr(`Generated workflow validation failed after write: ${materializedWorkflowValidation.message}\n`);
      return 1;
    }
    deps.stdout(`${renderInitWriteSummary({ ...plan, validation: materializedWorkflowValidation })}\n`);
    return 0;
  } catch (error) {
    deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runCommandRouter(options: RunCommandRouterOptions): Promise<number> {
  const deps = {
    ...defaultDependencies(),
    ...options.deps
  };

  const [command, ...rest] = options.argv;

  if (!command || command === '--help' || command === '-h') {
    deps.stdout(`${renderHelp()}\n`);
    return 0;
  }

  if (command === '--version' || command === '-v') {
    deps.stdout(`${deps.packageVersion}\n`);
    return 0;
  }

  if (command === 'dashboard') {
    if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) {
      deps.stdout(`${renderDashboardHelp()}\n`);
      return 0;
    }

    let resolved: LocalCommandResolution;
    try {
      resolved = deps.resolveLocalCommand({
        command: 'dashboard',
        argv: rest,
        cwd: deps.cwd,
        env: deps.env,
        symphonyCheckoutRoot: deps.repoRoot
      });
    } catch (error) {
      const message =
        error instanceof LocalCommandResolutionError || error instanceof Error ? error.message : String(error);
      deps.stderr(`${message}\n`);
      return 1;
    }
    let dashboardArgv = resolved.dashboardArgv;
    const posture = deps.resolveWorkflowPosture(resolved.workflowPath, deps.env);
    let consentSource: SetupConsentSource = dashboardArgv.includes(GUARDRAIL_ACK_FLAG) ? 'flag' : 'missing';
    const setupConsentStoreInProject = isWithinPath(resolved.currentProjectRoot, deps.setupConsentStore.path);
    if (consentSource === 'missing' && !setupConsentStoreInProject) {
      const consent = findValidSetupConsent({ store: deps.setupConsentStore, resolved, posture });
      if (consent) {
        dashboardArgv = [...dashboardArgv, GUARDRAIL_ACK_FLAG];
        consentSource = 'setup';
      }
    }
    deps.loadEnvFile(resolved.envFilePath);
    deps.stdout(renderDashboardResolution(resolved, posture, consentSource));
    return deps.runDashboard(dashboardArgv, {
      cwd: deps.cwd,
      env: deps.env,
      envFilePath: resolved.envFilePath,
      repoRoot: deps.repoRoot
    });
  }

  if (command === 'profile') {
    return runProfileCommand(rest, deps);
  }

  if (command === 'init') {
    return runInitCommand(rest, deps);
  }

  if (command === 'link-local') {
    return deps.runLinkLocal(rest);
  }

  if (command === 'setup') {
    return runSetupCommand(rest, deps);
  }

  if (command === 'doctor') {
    if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) {
      deps.stdout(`${renderDoctorHelp()}\n`);
      return 0;
    }
    const jsonOutput = rest.includes('--json');
    const doctor = await runLocalDoctor({
      argv: rest,
      deps: {
        cwd: deps.cwd,
        env: deps.env,
        repoRoot: deps.repoRoot,
        resolveLocalCommand: deps.resolveLocalCommand,
        resolveWorkflowPosture: deps.resolveWorkflowPosture,
        setupConsentStore: deps.setupConsentStore,
        runLinkLocal: (argv) =>
          deps.runLinkLocal(
            argv,
            jsonOutput
              ? {
                  stdout: () => undefined,
                  stderr: () => undefined
                }
              : undefined
          ),
        clock: deps.clock
      }
    });
    if (jsonOutput) {
      deps.stdout(`${JSON.stringify(doctor.result, null, 2)}\n`);
    } else {
      deps.stdout(doctor.human);
    }
    return doctor.result.exitCode;
  }

  return failUnsupported(
    deps,
    `Unknown command '${command}'. Supported commands: ${SUPPORTED_COMMANDS.join(', ')}.`,
    renderHelp()
  );
}
