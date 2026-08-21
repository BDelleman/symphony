import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

import { ConfigResolver, ConfigValidator, WorkflowLoader } from '../workflow';
import { WorkflowConfigError } from '../workflow/errors';
import type { EffectiveConfig } from '../workflow/types';
import type {
  ResolveLocalCommandOptions,
  LocalCommandResolution,
  LocalPathSource,
  LocalScalarSource
} from './local-command-resolver';
import { LocalCommandResolutionError } from './local-command-resolver';
import { isWithinPath } from './path-containment';
import {
  ensureSystemGitignoreEntry,
  inspectProjectLayout,
  type ProjectLayoutInspection,
  type ProjectLayoutWarningCode
} from './project-layout-inspector';
import {
  buildSetupConsentRecord,
  findValidSetupConsent,
  persistSetupConsent,
  type SetupConsentSource,
  type SetupConsentStore,
  type WorkflowPosture
} from './setup-consent';
import {
  readWorkflowGeneratedProfileProvenance,
  validateWorkflowGeneratedProfileProvenance
} from '../workflow/provenance';
import {
  listDefaultPortableSkillIds,
  listOptInPortableSkillIds,
  listPortableSkills,
  getPortableSkill,
  type PortableSkillCatalogEntry,
  type PortableSkillId,
  type PortableSkillPrerequisiteKind
} from '../workflow/portable-skill-catalog';
import {
  CLAUDE_SUPPORTED_VERSION,
  ClaudeCliRunner,
  inspectClaudeUserMcpConfiguration,
  resolveTrustedExecutable
} from '../agent';
import {
  claudeSandboxProtectedPathCandidates,
  createClaudeSandboxPathSnapshot,
  probeClaudeSandboxRuntime
} from '../agent/claude-sandbox';
import { auditSensitiveWorkspaceFiles, type SensitiveWorkspaceFileViolation } from '../workspace';
import {
  classifyPersistedWorkerOwnership,
  findLatestTerminalRunEventEvidence,
  SqlitePersistenceStore
} from '../persistence';
import { REASON_CODES } from '../observability';
import {
  GitHubAppApprovalBroker,
  parseGitHubRemote,
  stripReviewerCredentials,
  SUPERVISOR_REVIEWER_ENV_NAMES
} from '../review';

const CLAUDE_NON_SUBSCRIPTION_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS'
] as const;

export type DoctorCheckStatus = 'ok' | 'warning' | 'failure';
export type DoctorOverallStatus = DoctorCheckStatus;
export type DoctorFindingSeverity = 'pass' | 'warning' | 'blocker';
export type DoctorFindingProvenanceCategory =
  | 'cli_flag'
  | 'environment_variable'
  | 'environment_file'
  | 'workflow_value'
  | 'generated_profile'
  | 'project_default'
  | 'layout_inspection'
  | 'user_local_trust_state'
  | 'inferred_runtime_default'
  | 'path_lookup'
  | 'local_checkout'
  | 'git_repository'
  | 'runtime_probe'
  | 'project_file'
  | 'tool_prerequisite'
  | 'credential_configuration'
  | 'codex_app_server';

export interface DoctorFindingSource {
  category: DoctorFindingProvenanceCategory;
  value?: string;
  present?: boolean;
}

export interface DoctorFindingRemediation {
  guidance: string | null;
}

export type DoctorFindingSafeFixMutationScope = 'project_file' | 'user_local_state' | 'local_link';

export interface DoctorFindingSafeFixMutation {
  scope: DoctorFindingSafeFixMutationScope;
  path: string;
  operation:
    | 'append_gitignore_entry'
    | 'record_setup_consent'
    | 'refresh_local_shim'
    | 'chmod_env_file'
    | 'quarantine_sensitive_file'
    | 'repair_history_orphans';
}

export interface DoctorFindingSafeFix {
  available: boolean;
  fixId: string | null;
  command: string | null;
  requiresYes: boolean;
  mutates: DoctorFindingSafeFixMutation[];
}

export interface DoctorFinding {
  id: string;
  code: string;
  title: string;
  message: string;
  status: DoctorCheckStatus;
  checkStatus: DoctorCheckStatus;
  severity: DoctorFindingSeverity;
  reason: string;
  summary: string;
  source: DoctorFindingSource;
  remediationGuidance: string | null;
  remediationInfo: DoctorFindingRemediation;
  safeFix: DoctorFindingSafeFix;
  remediation?: string;
  details: Record<string, unknown>;
}

export type DoctorCheck = DoctorFinding;
type DoctorFindingInput = Omit<
  DoctorFinding,
  | 'code'
  | 'message'
  | 'checkStatus'
  | 'severity'
  | 'source'
  | 'remediationGuidance'
  | 'remediationInfo'
  | 'safeFix'
  | 'details'
> & {
  code?: string;
  message?: string;
  source?: DoctorFindingSource;
  remediationGuidance?: string | null;
  remediationInfo?: DoctorFindingRemediation;
  safeFix?: DoctorFindingSafeFix;
  details?: Record<string, unknown>;
};

export interface DoctorFixAction {
  id: string;
  status: 'applied' | 'skipped' | 'failed';
  summary: string;
  safe: boolean;
  targetFindingIds: string[];
  requiresYes: boolean;
  details?: Record<string, unknown>;
}

type DoctorFixActionInput = Omit<DoctorFixAction, 'safe' | 'targetFindingIds' | 'requiresYes'> &
  Partial<Pick<DoctorFixAction, 'safe' | 'targetFindingIds' | 'requiresYes'>>;

export interface DoctorJsonResult {
  version: 1;
  command: 'doctor';
  status: DoctorOverallStatus;
  reason: 'ready' | 'warnings_present' | 'blockers_present';
  exitCode: 0 | 1 | 2;
  exitSemantics: {
    code: 0 | 1 | 2;
    meaning: 'ready' | 'warnings_non_blocking' | 'blockers_present';
    ci: {
      requested: boolean;
      promptsAllowed: false;
      nonZeroOnBlocker: boolean;
    };
  };
  ci: boolean;
  fix: boolean;
  cwd: string;
  symphonyCheckoutRoot: string;
  resolution: {
    projectRoot: string | null;
    workflowPath: string | null;
    envFilePath: string | null;
    profile: string | null;
    host: string | null;
    port: number | null;
    ephemeralPort: boolean | null;
    consent: SetupConsentSource | null;
  };
  layout: ProjectLayoutInspection | null;
  findings: DoctorFinding[];
  checks: DoctorFinding[];
  fixes: DoctorFixAction[];
  projectContext: {
    cwd: string;
    symphonyCheckoutRoot: string;
    projectRoot: string | null;
    workflowPath: string | null;
    envFilePath: string | null;
    envFileExists: boolean | null;
    profile: string | null;
  };
}

export interface RunLocalDoctorOptions {
  argv: readonly string[];
  deps: LocalDoctorDependencies;
}

export interface LocalDoctorDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  resolveLocalCommand: (options: ResolveLocalCommandOptions) => LocalCommandResolution;
  resolveWorkflowPosture: (workflowPath: string, env?: NodeJS.ProcessEnv) => WorkflowPosture;
  setupConsentStore: SetupConsentStore;
  runLinkLocal: (argv: readonly string[]) => Promise<number>;
  clock: () => Date;
}

interface DoctorArgs {
  json: boolean;
  ci: boolean;
  fix: boolean;
  yes: boolean;
  claudeSmoke: boolean;
  linearIssue: string | null;
  resolverArgv: string[];
}

interface ShimMetadata {
  path: string;
  owned: boolean;
  repoRoot: string | null;
  entrypoint: string | null;
  verificationError?: string;
}

interface WorkflowCustomizationMetadata {
  profile: string | null;
  bundle: string | null;
  packs: string[];
  portableSkills: Array<{ name: string; path: string; source: string }>;
  references: WorkflowCustomizationReference[];
  sources: string[];
}

interface WorkflowCustomizationReference {
  path: string;
  kind: 'skill' | 'prompt' | 'customization';
  source: string;
}

export interface DoctorPortableSkillCatalogSummary {
  skillIds: string[];
  defaultRecommendedSkillIds: string[];
  optInSkillIds: string[];
  targetMaterializationRoot: '.codex/skills';
  reservedRuntimeSource: '.symphony/skills';
  runtimeLoadingSupported: false;
}

export function summarizePortableSkillCatalogForDoctor(): DoctorPortableSkillCatalogSummary {
  return {
    skillIds: listPortableSkills().map((skill) => skill.id),
    defaultRecommendedSkillIds: listDefaultPortableSkillIds(),
    optInSkillIds: listOptInPortableSkillIds(),
    targetMaterializationRoot: '.codex/skills',
    reservedRuntimeSource: '.symphony/skills',
    runtimeLoadingSupported: false
  };
}

const DOCTOR_FLAGS = new Set([
  '--json', '--ci', '--fix', '--yes', '--accept-high-trust-local-run', '--claude-smoke', '--linear-issue'
]);

function disabledSafeFix(): DoctorFindingSafeFix {
  return { available: false, fixId: null, command: null, requiresYes: false, mutates: [] };
}

function parseDoctorArgs(argv: readonly string[]): DoctorArgs | { error: string } {
  const resolverArgv: string[] = [];
  let json = false;
  let ci = false;
  let fix = false;
  let yes = false;
  let claudeSmoke = false;
  let linearIssue: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--ci') {
      ci = true;
      continue;
    }
    if (arg === '--fix') {
      fix = true;
      continue;
    }
    if (arg === '--yes' || arg === '--accept-high-trust-local-run') {
      yes = true;
      continue;
    }
    if (arg === '--claude-smoke') {
      claudeSmoke = true;
      continue;
    }
    if (arg === '--linear-issue') {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith('--')) return { error: '--linear-issue requires an issue identifier' };
      linearIssue = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--doctor-')) {
      return { error: `Unsupported doctor option: ${arg}` };
    }
    if (arg.startsWith('--') && DOCTOR_FLAGS.has(arg.split('=')[0])) {
      return { error: `Unsupported doctor option value form: ${arg}` };
    }
    resolverArgv.push(arg);
  }

  if (claudeSmoke && !linearIssue) return { error: '--claude-smoke requires --linear-issue <id>' };
  if (claudeSmoke && ci) return { error: '--claude-smoke cannot run with --ci because the smoke is explicitly mutating' };
  if (linearIssue && !/^[A-Za-z][A-Za-z0-9_-]{0,31}-\d{1,12}$/.test(linearIssue)) {
    return { error: '--linear-issue must be a bounded tracker identifier such as NIE-303' };
  }
  return { json, ci, fix, yes, claudeSmoke, linearIssue, resolverArgv };
}

function findExecutableOnPath(env: NodeJS.ProcessEnv): string | null {
  const entries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, 'symphony');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

function parseShimMetadata(executablePath: string): ShimMetadata {
  let content: string;
  try {
    content = fs.readFileSync(executablePath, 'utf8');
  } catch (error) {
    return {
      path: executablePath,
      owned: false,
      repoRoot: null,
      entrypoint: null,
      verificationError: (error as Error).message
    };
  }

  const owned = content.includes('# symphony-local-shim');
  const repoRoot = content.match(/^# symphony-repo-root: (.+)$/m)?.[1] ?? null;
  const entrypoint = content.match(/^# symphony-entrypoint: (.+)$/m)?.[1] ?? null;
  return { path: executablePath, owned, repoRoot, entrypoint };
}

function severityForStatus(status: DoctorCheckStatus): DoctorFindingSeverity {
  if (status === 'failure') {
    return 'blocker';
  }
  if (status === 'warning') {
    return 'warning';
  }
  return 'pass';
}

function safeFixForFinding(
  check: Pick<DoctorFindingInput, 'id' | 'status'>,
  context: { projectRoot?: string; setupConsentStorePath?: string; persistencePath?: string } = {}
): DoctorFindingSafeFix {
  if (check.id.startsWith('executable.') || check.id.startsWith('shim_checkout.')) {
    return {
      available: check.status !== 'ok',
      fixId: 'link-local',
      command: 'symphony doctor --fix --yes',
      requiresYes: true,
      mutates: [
        {
          scope: 'local_link',
          path: 'symphony link-local managed shim target',
          operation: 'refresh_local_shim'
        }
      ]
    };
  }
  if (check.id === 'layout.gitignore_system') {
    return {
      available: check.status !== 'ok',
      fixId: 'layout.gitignore-system',
      command: 'symphony doctor --fix --yes',
      requiresYes: true,
      mutates: [
        {
          scope: 'project_file',
          path: context.projectRoot ? path.join(context.projectRoot, '.gitignore') : '.gitignore',
          operation: 'append_gitignore_entry'
        }
      ]
    };
  }
  if (check.id === 'setup.consent') {
    return {
      available: check.status !== 'ok',
      fixId: 'setup-consent',
      command: 'symphony doctor --fix --yes',
      requiresYes: true,
      mutates: [
        {
          scope: 'user_local_state',
          path: context.setupConsentStorePath ?? 'user-local setup consent store',
          operation: 'record_setup_consent'
        }
      ]
    };
  }
  if (check.id === 'env.permissions') {
    return {
      available: check.status !== 'ok',
      fixId: 'env-permissions',
      command: 'symphony doctor --fix --yes',
      requiresYes: true,
      mutates: [
        {
          scope: 'project_file',
          path: context.projectRoot ? path.join(context.projectRoot, '.env') : '.env',
          operation: 'chmod_env_file'
        }
      ]
    };
  }
  if (check.id === 'workspace.sensitive_files') {
    return {
      available: check.status !== 'ok',
      fixId: 'workspace-sensitive-files',
      command: 'symphony doctor --fix --yes',
      requiresYes: true,
      mutates: [
        {
          scope: 'project_file',
          path: context.projectRoot
            ? sensitiveQuarantineBase(context.projectRoot)
            : '.symphony-quarantine',
          operation: 'quarantine_sensitive_file'
        }
      ]
    };
  }
  if (check.id === 'history.execution_graph_reconciliation') {
    return {
      available: check.status !== 'ok',
      fixId: 'history-execution-graph-reconciliation',
      command: 'symphony doctor --fix --yes',
      requiresYes: true,
      mutates: [
        {
          scope: 'project_file',
          path: context.persistencePath ?? (context.projectRoot
            ? path.join(context.projectRoot, '.symphony', 'system', 'runtime.sqlite')
            : '.symphony/system/runtime.sqlite'),
          operation: 'repair_history_orphans'
        }
      ]
    };
  }
  return disabledSafeFix();
}

function sourceFromPathSource(source: LocalPathSource): DoctorFindingSource {
  if (source === 'cli') {
    return { category: 'cli_flag', value: source, present: true };
  }
  if (source === 'env') {
    return { category: 'environment_variable', value: source, present: true };
  }
  if (source === 'profile') {
    return { category: 'generated_profile', value: source, present: true };
  }
  return { category: 'workflow_value', value: source, present: true };
}

function sourceFromScalarSource(source: LocalScalarSource): DoctorFindingSource {
  if (source === 'cli') {
    return { category: 'cli_flag', value: source, present: true };
  }
  if (source === 'env') {
    return { category: 'environment_variable', value: source, present: true };
  }
  if (source === 'profile') {
    return { category: 'generated_profile', value: source, present: true };
  }
  return { category: 'inferred_runtime_default', value: source, present: true };
}

function sourceForFinding(check: DoctorFindingInput): DoctorFindingSource {
  if (check.id === 'resolver.workflow' && typeof check.details?.workflowSource === 'string') {
    return sourceFromPathSource(check.details.workflowSource as LocalPathSource);
  }
  if (check.id === 'env.path' && typeof check.details?.source === 'string') {
    const source = check.details.source as LocalPathSource;
    if (check.details.exists === true) {
      return { category: 'environment_file', value: source, present: true };
    }
    return source === 'project'
      ? { category: 'project_default', value: source, present: true }
      : sourceFromPathSource(source);
  }
  if (check.id === 'server.port' && typeof check.details?.source === 'string') {
    return sourceFromScalarSource(check.details.source as LocalScalarSource);
  }
  if (check.id.startsWith('layout.')) {
    return { category: 'layout_inspection', present: true };
  }
  if (check.id.startsWith('customization.generated_profile')) {
    return { category: 'generated_profile', present: check.status === 'ok' };
  }
  if (check.id.startsWith('customization.reference.')) {
    return { category: 'generated_profile', present: check.status === 'ok' };
  }
  if (check.id.startsWith('project_local_skills.skill.') || check.id.startsWith('project_local_skills.helper.')) {
    return { category: 'project_file', present: check.status === 'ok' };
  }
  if (check.id.startsWith('project_local_skills.prerequisite.')) {
    return { category: 'tool_prerequisite', present: check.status === 'ok' };
  }
  if (check.id.startsWith('project_local_skills.credentials.')) {
    return { category: 'credential_configuration', present: check.status === 'ok' };
  }
  if (check.id === 'project_local_skills.selection') {
    return { category: 'generated_profile', present: check.status === 'ok' };
  }
  if (check.id === 'project_local_skills.codex_visibility') {
    return { category: 'codex_app_server', present: check.status === 'ok' };
  }
  if (check.id === 'setup.consent') {
    return check.reason === 'setup_consent_flag'
      ? { category: 'cli_flag', value: 'guardrail_ack', present: true }
      : { category: 'user_local_trust_state', value: check.reason, present: check.status === 'ok' };
  }
  if (check.id.startsWith('workspace.')) {
    return check.id === 'workspace.base_ref' || check.id === 'workspace.dirty_policy'
      ? { category: 'git_repository', present: true }
      : { category: 'workflow_value', present: true };
  }
  if (check.id === 'workflow.effective_config' || check.id === 'codex.command') {
    return { category: 'workflow_value', present: check.status === 'ok' };
  }
  if (check.id.startsWith('executable.')) {
    return { category: 'path_lookup', present: check.status === 'ok' };
  }
  if (check.id.startsWith('shim_checkout.') || check.id === 'dashboard.prerequisites') {
    return { category: 'local_checkout', present: check.status === 'ok' };
  }
  if (check.id === 'doctor.options') {
    return { category: 'cli_flag', present: false };
  }
  return { category: 'runtime_probe', present: check.status === 'ok' };
}

function readWorkflowCustomizationMetadata(workflowPath: string, config: Record<string, unknown>): WorkflowCustomizationMetadata | null {
  let workflowText = '';
  try {
    workflowText = fs.readFileSync(workflowPath, 'utf8');
  } catch {
    return readWorkflowGeneratedProfileProvenance({ config }).metadata;
  }
  return readWorkflowGeneratedProfileProvenance({ config, workflowText }).metadata;
}

function safeReferenceId(reference: WorkflowCustomizationReference): string {
  return reference.path
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function resolveProjectReference(projectRoot: string, relativePath: string): string | null {
  if (path.isAbsolute(relativePath)) {
    return null;
  }
  const resolved = path.resolve(projectRoot, relativePath);
  return isWithinPath(projectRoot, resolved) ? resolved : null;
}

function addCustomizationChecks(
  checks: DoctorFinding[],
  resolved: LocalCommandResolution,
  metadata: WorkflowCustomizationMetadata | null
): void {
  const hasMetadata = Boolean(metadata?.profile || metadata?.bundle || metadata?.packs.length || metadata?.references.length);
  addCheck(checks, {
    id: 'customization.generated_profile',
    title: 'Generated workflow customization provenance is observable',
    status: 'ok',
    reason: hasMetadata ? 'generated_profile_provenance_recorded' : 'generated_profile_provenance_absent',
    summary: hasMetadata
      ? `Workflow records generated profile provenance (${[
          metadata?.profile ? `profile ${metadata.profile}` : null,
          metadata?.bundle ? `bundle ${metadata.bundle}` : null,
          metadata?.packs.length ? `packs ${metadata.packs.join(', ')}` : null
        ]
          .filter(Boolean)
          .join('; ')}); runtime behavior comes from the materialized workflow.`
      : 'Workflow does not record generated profile, bundle, pack, or customization provenance.',
    source: hasMetadata
      ? { category: 'generated_profile', value: metadata?.sources.join(',') ?? 'workflow', present: true }
      : { category: 'workflow_value', present: false },
    details: {
      profile: metadata?.profile ?? null,
      bundle: metadata?.bundle ?? null,
      packs: metadata?.packs ?? [],
      sources: metadata?.sources ?? [],
      runtimeLoadingSupported: false,
      runtimeLoadingBehavior: 'observable_only'
    }
  });
  for (const reference of metadata?.references ?? []) {
    const fullPath = resolveProjectReference(resolved.currentProjectRoot, reference.path);
    const exists = fullPath ? fs.existsSync(fullPath) : false;
    addCheck(checks, {
      id: `customization.reference.${safeReferenceId(reference) || reference.kind}`,
      title: `Observable ${reference.kind} customization reference exists`,
      status: exists ? 'ok' : 'warning',
      reason: exists ? 'customization_reference_present' : 'customization_reference_missing',
      summary: exists
        ? `Referenced ${reference.kind} customization file is present: ${reference.path}; this is observable project content, not runtime-loaded behavior.`
        : `Referenced ${reference.kind} customization file is missing: ${reference.path}; this is an observable project reference, not a Codex runtime loading failure.`,
      remediation: exists
        ? undefined
        : 'Create the referenced project file or remove the stale workflow customization reference.',
      source: { category: 'generated_profile', value: reference.source, present: true },
      details: {
        path: reference.path,
        kind: reference.kind,
        exists,
        projectRoot: resolved.currentProjectRoot,
        withinProject: fullPath !== null,
        source: reference.source,
        runtimeLoadingSupported: false,
        runtimeLoadingBehavior: 'observable_only',
        note: 'Doctor reports this explicit project reference; Codex project-local skill/prompt loading is not enabled by this finding.'
      }
    });
  }
}

function normalizeSkillPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '');
}

function skillIdFromPortableSkillProvenance(entry: { name: string; path: string }): PortableSkillId | null {
  const byName = getPortableSkill(entry.name);
  if (byName) {
    return byName.id;
  }

  const normalizedPath = normalizeSkillPath(entry.path);
  const byPath = listPortableSkills().find((skill) => normalizeSkillPath(skill.destinationDirectory) === normalizedPath);
  return byPath?.id ?? null;
}

function selectedPortableSkillsFromMetadata(metadata: WorkflowCustomizationMetadata | null): {
  selectedSkills: PortableSkillCatalogEntry[];
  unknown: Array<{ name: string; path: string; source: string }>;
} {
  const selectedSkillIds: PortableSkillId[] = [];
  const unknown: Array<{ name: string; path: string; source: string }> = [];
  for (const entry of metadata?.portableSkills ?? []) {
    const id = skillIdFromPortableSkillProvenance(entry);
    if (!id) {
      unknown.push(entry);
      continue;
    }
    if (!selectedSkillIds.includes(id)) {
      selectedSkillIds.push(id);
    }
  }

  return {
    selectedSkills: selectedSkillIds.map((id) => getPortableSkill(id)).filter((skill): skill is PortableSkillCatalogEntry => Boolean(skill)),
    unknown
  };
}

function projectRelativePath(projectRoot: string, relativePath: string): string {
  return path.join(projectRoot, relativePath);
}

function addProjectLocalSkillMaterializationChecks(
  checks: DoctorFinding[],
  projectRoot: string,
  selectedSkills: readonly PortableSkillCatalogEntry[],
  unknown: readonly { name: string; path: string; source: string }[]
): void {
  const unknownNames = unknown.map((entry) => entry.name);
  addCheck(checks, {
    id: 'project_local_skills.selection',
    title: 'Project-local portable skill selection is recorded',
    status: unknown.length > 0 ? 'warning' : 'ok',
    reason:
      unknown.length > 0
        ? 'portable_skill_selection_unrecognized'
        : selectedSkills.length > 0
          ? 'portable_skills_selected'
          : 'portable_skills_not_selected',
    summary:
      unknown.length > 0
        ? `Workflow records ${unknown.length} unrecognized project-local portable skill(s): ${unknownNames.join(', ')}.`
        : selectedSkills.length > 0
        ? `Workflow selected ${selectedSkills.length} project-local portable skill(s): ${selectedSkills.map((skill) => skill.id).join(', ')}.`
        : 'Workflow did not select project-local portable skills.',
    remediation:
      unknown.length > 0
        ? 'Regenerate WORKFLOW.md with this Symphony version or install a Symphony version that recognizes the recorded portable skill catalog entry.'
        : undefined,
    details: {
      selectedSkillIds: selectedSkills.map((skill) => skill.id),
      unknown
    }
  });

  for (const skill of selectedSkills) {
    const skillPath = projectRelativePath(projectRoot, path.join(skill.destinationDirectory, 'SKILL.md'));
    const exists = fs.existsSync(skillPath) && fs.statSync(skillPath).isFile();
    addCheck(checks, {
      id: `project_local_skills.skill.${skill.id}`,
      title: `Project-local skill ${skill.id} is installed`,
      status: exists ? 'ok' : 'failure',
      reason: exists ? 'portable_skill_installed' : 'portable_skill_missing',
      summary: exists ? `Project-local skill file is present: ${skillPath}` : `Project-local skill file is missing: ${skillPath}`,
      remediation: exists ? undefined : `Rerun \`symphony init --force-skills --skill ${skill.id}\` or restore ${skillPath}.`,
      details: {
        skillId: skill.id,
        path: skillPath,
        exists
      }
    });

    for (const helper of skill.helperScripts) {
      const helperPath = projectRelativePath(projectRoot, helper.destinationPath);
      const helperExists = fs.existsSync(helperPath) && fs.statSync(helperPath).isFile();
      addCheck(checks, {
        id: `project_local_skills.helper.${skill.id}.${safeReferenceId({ path: helper.destinationPath, kind: 'skill', source: 'catalog' })}`,
        title: `Project-local skill helper for ${skill.id} is installed`,
        status: helperExists ? 'ok' : helper.required ? 'failure' : 'warning',
        reason: helperExists ? 'portable_skill_helper_present' : 'portable_skill_helper_missing',
        summary: helperExists
          ? `Required helper script is present: ${helperPath}`
          : `Required helper script is missing: ${helperPath}`,
        remediation: helperExists
          ? undefined
          : `Rerun \`symphony init --force-skills --skill ${skill.id}\` or restore ${helperPath}.`,
        details: {
          skillId: skill.id,
          path: helperPath,
          runtime: helper.runtime,
          required: helper.required,
          exists: helperExists
        }
      });
    }
  }
}

function requiredPrerequisiteKinds(selectedSkills: readonly PortableSkillCatalogEntry[]): PortableSkillPrerequisiteKind[] {
  const kinds: PortableSkillPrerequisiteKind[] = [];
  for (const skill of selectedSkills) {
    for (const prerequisite of skill.prerequisites) {
      if (!prerequisite.required) {
        continue;
      }
      if (!kinds.includes(prerequisite.kind)) {
        kinds.push(prerequisite.kind);
      }
    }
  }
  return kinds;
}

function addProjectLocalSkillPrerequisiteChecks(
  checks: DoctorFinding[],
  selectedSkills: readonly PortableSkillCatalogEntry[],
  env: NodeJS.ProcessEnv,
  envFilePath: string
): void {
  const kinds = requiredPrerequisiteKinds(selectedSkills);
  const tools: Array<{ kind: PortableSkillPrerequisiteKind; commands: string[]; label: string }> = [
    { kind: 'git', commands: ['git'], label: 'Git CLI' },
    { kind: 'github-cli', commands: ['gh'], label: 'GitHub CLI' },
    { kind: 'uv', commands: ['uv'], label: 'uv' },
    { kind: 'node', commands: ['node'], label: 'Node.js' },
    { kind: 'python', commands: ['python3', 'python'], label: 'Python' }
  ];

  for (const tool of tools.filter((candidate) => kinds.includes(candidate.kind))) {
    let resolvedCommand: string | null = null;
    let executablePath: string | null = null;
    for (const command of tool.commands) {
      executablePath = findCommandOnPath(command, env);
      if (executablePath) {
        resolvedCommand = command;
        break;
      }
    }
    const commandSummary = tool.commands.join(' or ');
    addCheck(checks, {
      id: `project_local_skills.prerequisite.${tool.kind}`,
      title: `${tool.label} is available for selected project-local skills`,
      status: executablePath ? 'ok' : 'failure',
      reason: executablePath ? 'portable_skill_prerequisite_present' : 'portable_skill_prerequisite_missing',
      summary: executablePath
        ? `${tool.label} prerequisite resolves to ${executablePath}.`
        : `${tool.label} prerequisite is missing for selected project-local skills: ${commandSummary}`,
      remediation: executablePath ? undefined : `Install ${commandSummary} or put it on PATH before using the selected project-local skills.`,
      details: {
        kind: tool.kind,
        tool: tool.commands[0],
        command: resolvedCommand ?? tool.commands[0],
        commandCandidates: tool.commands,
        executablePath,
        requiredBySelectedSkills: true
      }
    });
  }

  if (kinds.includes('linear-mcp') || kinds.includes('linear-graphql')) {
    const envFileValues = fs.existsSync(envFilePath) ? readEnvFileValues(envFilePath) : {};
    const envPresent = typeof env.LINEAR_API_KEY === 'string' && env.LINEAR_API_KEY.length > 0;
    const envFilePresent = typeof envFileValues.LINEAR_API_KEY === 'string' && envFileValues.LINEAR_API_KEY.length > 0;
    const present = envPresent || envFilePresent;
    const sourceCategory = envPresent ? 'environment_variable' : envFilePresent ? 'environment_file' : 'credential_configuration';
    addCheck(checks, {
      id: 'project_local_skills.credentials.linear',
      title: 'Linear credentials are configured for selected project-local skills',
      status: present ? 'ok' : 'failure',
      reason: present ? 'linear_skill_credentials_present' : 'linear_skill_credentials_missing',
      summary: present
        ? `Linear credential configuration is present from ${envPresent ? 'environment variable' : 'project env file'}.`
        : 'Linear credential configuration is missing for selected project-local Linear helper skills.',
      remediation: present ? undefined : 'Set LINEAR_API_KEY in the process environment or project .env before using Linear helper skills.',
      source: { category: sourceCategory, value: envPresent ? 'LINEAR_API_KEY' : envFilePresent ? envFilePath : 'LINEAR_API_KEY', present },
      details: {
        envVarName: 'LINEAR_API_KEY',
        present,
        sources: {
          environmentVariable: { present: envPresent },
          projectEnvFile: { path: envFilePath, present: envFilePresent, exists: fs.existsSync(envFilePath) }
        }
      }
    });
  }
}

function splitCommand(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
}

function readJsonLines(buffer: string): unknown[] {
  return buffer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((line): line is unknown => line !== null);
}

function extractSkillNamesFromDiscovery(payload: unknown, projectRoot: string): string[] {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const result = record.result && typeof record.result === 'object' && !Array.isArray(record.result) ? (record.result as Record<string, unknown>) : {};
  const data = Array.isArray(result.data) ? result.data : [];
  const names: string[] = [];
  for (const entry of data) {
    const entryRecord = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const cwd = typeof entryRecord.cwd === 'string' ? entryRecord.cwd : '';
    if (cwd && path.resolve(cwd) !== path.resolve(projectRoot)) {
      continue;
    }
    const skills = Array.isArray(entryRecord.skills) ? entryRecord.skills : [];
    for (const skill of skills) {
      const skillRecord = skill && typeof skill === 'object' && !Array.isArray(skill) ? (skill as Record<string, unknown>) : {};
      if (typeof skillRecord.name === 'string' && skillRecord.enabled !== false) {
        names.push(skillRecord.name);
      }
    }
  }
  return names;
}

async function probeCodexSkillDiscovery(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
  selectedSkills: readonly PortableSkillCatalogEntry[];
  unknown: readonly { name: string; path: string; source: string }[];
  timeoutMs?: number;
}): Promise<DoctorFindingInput> {
  const selectedSkillIds = params.selectedSkills.map((skill) => skill.id);
  const unknownSkillNames = params.unknown.map((entry) => entry.name);
  if (params.selectedSkills.length === 0) {
    if (params.unknown.length > 0) {
      return {
        id: 'project_local_skills.codex_visibility',
        title: 'Codex-visible project-local skill discovery is checked',
        status: 'warning',
        reason: 'codex_skill_discovery_unknown_provenance',
        summary: `Codex skill discovery was not checked because workflow provenance contains unrecognized project-local portable skill(s): ${unknownSkillNames.join(', ')}.`,
        remediation: 'Regenerate WORKFLOW.md with this Symphony version or install a Symphony version that recognizes the recorded portable skill catalog entry.',
        details: {
          selectedSkillIds,
          unknownSkillNames,
          unknown: params.unknown
        }
      };
    }
    return {
      id: 'project_local_skills.codex_visibility',
      title: 'Codex-visible project-local skill discovery is checked',
      status: 'ok',
      reason: 'codex_skill_discovery_not_required',
      summary: 'No project-local portable skills are selected, so Codex skill discovery is not required.',
      details: { selectedSkillIds }
    };
  }

  const commandParts = splitCommand(params.command);
  const appServerIndex = commandParts.lastIndexOf('app-server');
  if (commandParts.length === 0 || appServerIndex < 0) {
    return {
      id: 'project_local_skills.codex_visibility',
      title: 'Codex-visible project-local skill discovery is checked',
      status: 'warning',
      reason: 'codex_skill_discovery_not_app_server',
      summary: `Codex skill discovery could not be checked because codex.command is not an app-server command: ${params.command}`,
      remediation: 'Use `codex app-server` as the workflow codex.command to enable doctor skill visibility checks.',
      details: { command: params.command, selectedSkillIds, unknownSkillNames }
    };
  }

  return new Promise((resolve) => {
    const child = spawn(commandParts[0], commandParts.slice(1), {
      cwd: params.projectRoot,
      env: params.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      finish({
        id: 'project_local_skills.codex_visibility',
        title: 'Codex-visible project-local skill discovery is checked',
        status: 'warning',
        reason: 'codex_skill_discovery_unavailable',
        summary: 'Codex app-server skill discovery timed out before returning skills/list.',
        remediation: 'Run `codex app-server` manually in the project root and inspect `skills/list` support.',
        details: { selectedSkillIds, unknownSkillNames, timeoutMs: params.timeoutMs ?? 2500 }
      });
    }, params.timeoutMs ?? 2500);

    function finish(finding: DoctorFindingInput): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.kill('SIGTERM');
      resolve(finding);
    }

    child.once('error', (error) => {
      finish({
        id: 'project_local_skills.codex_visibility',
        title: 'Codex-visible project-local skill discovery is checked',
        status: 'warning',
        reason: 'codex_skill_discovery_unavailable',
        summary: `Codex app-server skill discovery could not start: ${error.message}`,
        remediation: 'Install Codex or fix codex.command before relying on project-local skill discovery.',
        details: { selectedSkillIds, unknownSkillNames, error: error.message }
      });
    });
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      const response = readJsonLines(stdout).find(
        (line) => typeof line === 'object' && line !== null && (line as Record<string, unknown>).id === 2
      );
      if (!response) {
        return;
      }
      const visibleNames = extractSkillNamesFromDiscovery(response, params.projectRoot);
      const expectedNames = params.selectedSkills.map((skill) => skill.name);
      const missing = expectedNames.filter((name) => !visibleNames.includes(name));
      const visible = expectedNames.filter((name) => visibleNames.includes(name));
      finish({
        id: 'project_local_skills.codex_visibility',
        title: 'Codex-visible project-local skill discovery is checked',
        status: missing.length === 0 && params.unknown.length === 0 ? 'ok' : 'warning',
        reason:
          missing.length > 0
            ? 'codex_skill_discovery_partial'
            : params.unknown.length > 0
              ? 'codex_skill_discovery_unknown_provenance'
              : 'codex_skill_discovery_visible',
        summary:
          missing.length > 0
            ? `Codex app-server did not report ${missing.length} selected project-local skill(s): ${missing.join(', ')}.`
            : params.unknown.length > 0
              ? `Codex app-server reports all recognized selected project-local skills as visible, but workflow provenance contains unrecognized skill(s): ${unknownSkillNames.join(', ')}.`
              : `Codex app-server reports all selected project-local skills as visible: ${visible.join(', ')}.`,
        remediation:
          missing.length > 0
            ? 'Open the project with Codex from the project root and verify .codex/skills discovery.'
            : params.unknown.length > 0
              ? 'Regenerate WORKFLOW.md with this Symphony version or install a Symphony version that recognizes the recorded portable skill catalog entry.'
              : undefined,
        details: {
          selectedSkillIds,
          visibleSkillNames: visible,
          missingSkillNames: missing,
          unknownSkillNames,
          unknown: params.unknown,
          discoveryResponseShape: 'skills/list'
        }
      });
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('exit', (code) => {
      if (settled) {
        return;
      }
      finish({
        id: 'project_local_skills.codex_visibility',
        title: 'Codex-visible project-local skill discovery is checked',
        status: 'warning',
        reason: 'codex_skill_discovery_unavailable',
        summary: `Codex app-server exited before returning skills/list (exit ${code ?? 'signal'}).`,
        remediation: 'Run `codex app-server` manually in the project root and inspect startup errors.',
        details: {
          selectedSkillIds,
          unknownSkillNames,
          exitCode: code,
          stderrPreview: stderr.trim().slice(0, 500)
        }
      });
    });

    child.stdin?.write(
      `${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'symphony-doctor', version: '0.1.0' },
          capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] }
        }
      })}\n`
    );
    child.stdin?.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    child.stdin?.write(
      `${JSON.stringify({ id: 2, method: 'skills/list', params: { cwds: [params.projectRoot], forceReload: true } })}\n`
    );
  });
}

function isSensitiveKey(key: string): boolean {
  if (key === 'authMethod') return false;
  return /(api[_-]?key|token|secret|password|credential|authorization|auth)/i.test(key);
}

function redactDetails(value: unknown, key = ''): unknown {
  if (isSensitiveKey(key)) {
    const present = typeof value === 'string' ? value.length > 0 : value !== null && value !== undefined;
    return { redacted: true, present };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDetails(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactDetails(entryValue, entryKey)
      ])
    );
  }
  return value;
}

function normalizeFinding(check: DoctorFindingInput): DoctorFinding {
  const details = redactDetails(check.details ?? {}) as Record<string, unknown>;
  const remediationGuidance = check.remediationGuidance ?? check.remediation ?? null;
  return {
    ...check,
    code: check.code ?? check.reason,
    message: check.message ?? check.summary,
    checkStatus: check.status,
    severity: severityForStatus(check.status),
    source: check.source ?? sourceForFinding({ ...check, details }),
    remediationGuidance,
    remediationInfo: check.remediationInfo ?? { guidance: remediationGuidance },
    safeFix: check.safeFix ?? safeFixForFinding(check),
    details
  };
}

function addCheck(checks: DoctorFinding[], check: DoctorFindingInput): void {
  checks.push(normalizeFinding(check));
}

function normalizeFixAction(fix: DoctorFixActionInput): DoctorFixAction {
  const defaultTargets: Record<string, string[]> = {
    'link-local': [
      'executable.discoverable',
      'executable.checkout',
      'shim_checkout.checkout_exists',
      'shim_checkout.cli_script',
      'shim_checkout.built_cli'
    ],
    'layout.gitignore-system': ['layout.gitignore_system'],
    'env-permissions': ['env.permissions'],
    'workspace-sensitive-files': ['workspace.sensitive_files'],
    'setup-consent': ['setup.consent']
  };
  return {
    ...fix,
    safe: fix.safe ?? true,
    targetFindingIds: fix.targetFindingIds ?? defaultTargets[fix.id] ?? [],
    requiresYes: fix.requiresYes ?? true,
    details: redactDetails(fix.details ?? {}) as Record<string, unknown>
  };
}

function addFix(fixes: DoctorFixAction[], fix: DoctorFixActionInput): void {
  fixes.push(normalizeFixAction(fix));
}

function statusRank(status: DoctorCheckStatus): number {
  if (status === 'failure') {
    return 2;
  }
  if (status === 'warning') {
    return 1;
  }
  return 0;
}

function summarizeStatus(checks: readonly DoctorFinding[]): {
  status: DoctorOverallStatus;
  reason: DoctorJsonResult['reason'];
  exitCode: 0 | 1 | 2;
} {
  const worst = checks.reduce((current, check) => Math.max(current, statusRank(check.status)), 0);
  if (worst === 2) {
    return { status: 'failure', reason: 'blockers_present', exitCode: 2 };
  }
  if (worst === 1) {
    return { status: 'warning', reason: 'warnings_present', exitCode: 1 };
  }
  return { status: 'ok', reason: 'ready', exitCode: 0 };
}

function layoutWarningSeverity(code: ProjectLayoutWarningCode): DoctorCheckStatus {
  return code === 'workflow_missing' || code === 'invalid_layout_path' || code === 'gitignore_unreadable'
    ? 'failure'
    : 'warning';
}

function addLayoutChecks(checks: DoctorFinding[], layout: ProjectLayoutInspection): void {
  addCheck(checks, {
    id: 'layout.workflow',
    title: 'Root WORKFLOW.md is canonical',
    status: layout.workflow.exists ? 'ok' : 'failure',
    reason: layout.workflow.exists ? 'workflow_root_present' : 'workflow_root_missing',
    summary: layout.workflow.exists ? 'Root WORKFLOW.md is present.' : 'Root WORKFLOW.md is missing.',
    remediation: layout.workflow.remediation,
    details: { workflow: layout.workflow, projectContractPaths: layout.projectContractPaths }
  });
  addCheck(checks, {
    id: 'layout.runtime_state_root',
    title: '.symphony/system runtime root is reserved',
    status: 'ok',
    reason: 'runtime_state_root_reserved',
    summary: '.symphony/system/ is the runtime-owned local state root.',
    details: { runtimeStateRoot: layout.runtimeStateRoot, runtimeOwnedPaths: layout.runtimeOwnedPaths }
  });
  addCheck(checks, {
    id: 'layout.gitignore_system',
    title: '.gitignore covers runtime state root',
    status: layout.ignoreAnalysis.hasNarrowSystemIgnore
      ? 'ok'
      : layout.ignoreAnalysis.status === 'unreadable'
        ? 'failure'
        : 'warning',
    reason: layout.ignoreAnalysis.hasNarrowSystemIgnore
      ? 'system_ignore_present'
      : layout.ignoreAnalysis.status === 'unreadable'
        ? 'gitignore_unreadable'
        : 'system_ignore_missing',
    summary: layout.ignoreAnalysis.hasNarrowSystemIgnore
      ? '.gitignore includes .symphony/system/.'
      : '.gitignore does not narrowly ignore .symphony/system/.',
    remediation: layout.ignoreAnalysis.hasNarrowSystemIgnore
      ? undefined
      : 'Add .symphony/system/ to .gitignore; `symphony doctor --fix --yes` can append it safely.',
    safeFix: safeFixForFinding(
      { id: 'layout.gitignore_system', status: layout.ignoreAnalysis.hasNarrowSystemIgnore ? 'ok' : 'warning' },
      { projectRoot: layout.projectRoot }
    ),
    details: { ignoreAnalysis: layout.ignoreAnalysis }
  });
  addCheck(checks, {
    id: 'layout.broad_symphony_ignore',
    title: 'Broad .symphony/ ignores are not hiding project customization',
    status: layout.ignoreAnalysis.hasBroadSymphonyIgnore ? 'warning' : 'ok',
    reason: layout.ignoreAnalysis.hasBroadSymphonyIgnore ? 'broad_symphony_ignore_present' : 'no_broad_symphony_ignore',
    summary: layout.ignoreAnalysis.hasBroadSymphonyIgnore
      ? 'A broad .symphony/ ignore may hide future project-owned customization.'
      : 'No broad .symphony/ ignore was found.',
    remediation: layout.ignoreAnalysis.hasBroadSymphonyIgnore
      ? 'Migrate broad .symphony/ ignores to .symphony/system/ manually; doctor will not remove broad ignores.'
      : undefined,
    details: {
      patterns: layout.ignoreAnalysis.patterns.filter((pattern) => pattern.kind === 'broad-symphony')
    }
  });
  addCheck(checks, {
    id: 'layout.reserved_customization',
    title: 'Reserved customization paths remain project-owned',
    status: 'ok',
    reason: 'reserved_customization_reported',
    summary: 'Reserved .symphony customization paths are reported and are not loaded by runtime.',
    details: { reservedCustomizationPaths: layout.reservedCustomizationPaths }
  });
  addCheck(checks, {
    id: 'layout.legacy_runtime_paths',
    title: 'Legacy runtime paths are absent',
    status: layout.legacyRuntimePaths.length === 0 ? 'ok' : 'warning',
    reason: layout.legacyRuntimePaths.length === 0 ? 'legacy_runtime_paths_absent' : 'legacy_runtime_paths_present',
    summary:
      layout.legacyRuntimePaths.length === 0
        ? 'No legacy runtime state paths were found.'
        : `Found ${layout.legacyRuntimePaths.length} legacy runtime state path(s).`,
    remediation:
      layout.legacyRuntimePaths.length === 0
        ? undefined
        : 'Migrate runtime state to .symphony/system/ manually after verifying no active process uses the legacy paths.',
    details: { legacyRuntimePaths: layout.legacyRuntimePaths }
  });

  for (const warning of layout.warnings.filter((item) =>
    ['invalid_layout_path', 'gitignore_unreadable'].includes(item.code)
  )) {
    addCheck(checks, {
      id: `layout.warning.${warning.code}`,
      title: `Layout warning: ${warning.code}`,
      status: layoutWarningSeverity(warning.code),
      reason: warning.code,
      summary: warning.message,
      remediation: warning.remediation,
      details: { path: warning.path }
    });
  }
}

function checkCheckoutEntrypoint(repoRoot: string, label: string): DoctorFindingInput {
  const scriptEntrypoint = path.join(repoRoot, 'scripts', 'symphony.js');
  const builtEntrypoint = path.join(repoRoot, 'dist', 'src', 'runtime', 'command-router.js');
  if (!fs.existsSync(repoRoot)) {
    return {
      id: `${label}.checkout_exists`,
      title: `${label} checkout exists`,
      status: 'failure',
      reason: 'checkout_missing',
      summary: `Checkout does not exist: ${repoRoot}`,
      remediation: 'Refresh the local link from an existing Symphony checkout with `npm run link:local`.',
      details: { repoRoot }
    };
  }
  if (!fs.existsSync(scriptEntrypoint)) {
    return {
      id: `${label}.cli_script`,
      title: `${label} CLI script exists`,
      status: 'failure',
      reason: 'cli_script_missing',
      summary: `CLI script is missing: ${scriptEntrypoint}`,
      remediation: 'Refresh the local link from a valid Symphony checkout with `npm run link:local`.',
      details: { scriptEntrypoint }
    };
  }
  if (!fs.existsSync(builtEntrypoint)) {
    return {
      id: `${label}.built_cli`,
      title: `${label} built CLI entrypoint exists`,
      status: 'failure',
      reason: 'build_missing',
      summary: `Built CLI entrypoint is missing: ${builtEntrypoint}`,
      remediation: 'Run `npm run build` in the Symphony checkout, then rerun `npm run link:local`.',
      details: { builtEntrypoint }
    };
  }
  return {
    id: `${label}.built_cli`,
    title: `${label} built CLI entrypoint exists`,
    status: 'ok',
    reason: 'built_cli_ready',
    summary: `Built CLI entrypoint is present: ${builtEntrypoint}`,
    details: { scriptEntrypoint, builtEntrypoint }
  };
}

function canListen(host: string, port: number): Promise<boolean> {
  if (port === 0) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

function readEnvFileValues(envFilePath: string): NodeJS.ProcessEnv {
  try {
    return dotenv.parse(fs.readFileSync(envFilePath));
  } catch {
    return {};
  }
}

function findCommandOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const [executable] = command.trim().split(/\s+/);
  if (!executable) {
    return null;
  }

  if (executable.includes(path.sep)) {
    try {
      fs.accessSync(executable, fs.constants.X_OK);
      return fs.realpathSync(executable);
    } catch {
      return null;
    }
  }

  for (const entry of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue searching PATH.
    }
  }

  return null;
}

function workflowRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function envTokenName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('$') || trimmed.length === 1) {
    return null;
  }
  const name = trimmed.slice(1);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
}

function requiredTrackerEnvTokens(definition: { config: Record<string, unknown> }): Array<{ field: string; name: string }> {
  const tracker = workflowRecord(definition.config.tracker);
  const kind = typeof tracker.kind === 'string' ? tracker.kind.trim() : '';
  const requirements: Array<{ field: string; name: string }> = [];

  const explicitApiKey = typeof tracker.api_key === 'string';
  const apiKeyToken = explicitApiKey
    ? envTokenName(tracker.api_key)
    : kind === 'linear'
      ? 'LINEAR_API_KEY'
      : kind === 'github'
        ? 'GITHUB_TOKEN'
        : null;
  if ((kind === 'linear' || kind === 'github') && apiKeyToken) {
    requirements.push({ field: 'tracker.api_key', name: apiKeyToken });
  }

  for (const field of kind === 'linear' ? ['project_slug'] : kind === 'github' ? ['owner', 'repo'] : []) {
    const token = envTokenName(tracker[field]);
    if (token) {
      requirements.push({ field: `tracker.${field}`, name: token });
    }
  }

  return requirements;
}

function buildRequiredEnvCheck(
  definition: { config: Record<string, unknown> },
  env: NodeJS.ProcessEnv,
  envFilePath: string
): DoctorFindingInput {
  const requirements = requiredTrackerEnvTokens(definition);
  const variables = requirements.map((requirement) => ({
    name: requirement.name,
    field: requirement.field,
    present: typeof env[requirement.name] === 'string' && env[requirement.name]!.length > 0
  }));
  const missing = variables.filter((variable) => !variable.present);

  return {
    id: 'env.required_variables',
    title: 'Required environment variables are present',
    status: missing.length > 0 ? 'failure' : 'ok',
    reason: missing.length > 0 ? 'required_env_missing' : 'required_env_present',
    summary:
      missing.length > 0
        ? `Missing ${missing.length} required environment variable(s) after loading the effective environment source.`
        : 'All required environment variables are present after loading the effective environment source.',
    remediation:
      missing.length > 0
        ? 'Define the missing variables in the project .env file or process environment before starting Symphony.'
        : undefined,
    source: { category: 'environment_file', value: envFilePath, present: fs.existsSync(envFilePath) },
    details: {
      envFilePath,
      variables
    }
  };
}

function validateWorkflow(resolved: LocalCommandResolution, env: NodeJS.ProcessEnv): {
  check: DoctorFindingInput;
  effectiveConfig: EffectiveConfig | null;
  configValid: boolean;
  envCheck: DoctorFindingInput | null;
} {
  try {
    const definition = new WorkflowLoader().load({ explicitPath: resolved.workflowPath });
    const workflowText = fs.readFileSync(resolved.workflowPath, 'utf8');
    const provenanceValidation = validateWorkflowGeneratedProfileProvenance({
      config: definition.config,
      workflowText
    });
    if (!provenanceValidation.ok) {
      return {
        check: {
          id: 'workflow.effective_config',
          title: 'Workflow effective config validates',
          status: 'failure',
          reason: 'invalid_generated_profile_provenance',
          summary: provenanceValidation.message,
          remediation: 'Fix generated profile provenance in WORKFLOW.md before starting the dashboard.',
          details: { workflowPath: resolved.workflowPath }
        },
        effectiveConfig: null,
        configValid: false,
        envCheck: null
      };
    }
    const effective = new ConfigResolver({ env }).resolve(definition, { workflowPath: resolved.workflowPath });
    const envCheck = buildRequiredEnvCheck(definition, env, resolved.envFilePath);
    const workflowDetails = {
      workflowPath: resolved.workflowPath,
      trackerKind: effective.tracker.kind,
      trackerApiKey: effective.tracker.api_key
    };
    const validation = new ConfigValidator().validate(effective);
    if (!validation.ok) {
      return {
        check: {
          id: 'workflow.effective_config',
          title: 'Workflow effective config validates',
          status: 'failure',
          reason: validation.error_code,
          summary: validation.message,
          remediation: 'Fix WORKFLOW.md or the referenced environment variables before starting the dashboard.',
          details: { ...workflowDetails, at: validation.at }
        },
        effectiveConfig: effective,
        configValid: false,
        envCheck
      };
    }
    return {
      check: {
        id: 'workflow.effective_config',
        title: 'Workflow effective config validates',
        status: 'ok',
        reason: 'workflow_config_valid',
        summary: 'Workflow syntax and effective configuration are valid for local startup.',
        details: workflowDetails
      },
      effectiveConfig: effective,
      configValid: true,
      envCheck
    };
  } catch (error) {
    const code = error instanceof WorkflowConfigError ? error.code : 'workflow_validation_failed';
    const message = error instanceof Error ? error.message : String(error);
    return {
      check: {
        id: 'workflow.effective_config',
        title: 'Workflow effective config validates',
        status: 'failure',
        reason: code,
        summary: message,
        remediation: 'Fix WORKFLOW.md syntax/configuration before starting the dashboard.',
        details: { workflowPath: resolved.workflowPath }
      },
      effectiveConfig: null,
      configValid: false,
      envCheck: null
    };
  }
}

function runGit(cwd: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

function parseRemoteBaseRef(baseRef: string): { remote: string; ref: string } | null {
  const [remote, ...rest] = baseRef.split('/');
  if (!remote || rest.length === 0) {
    return null;
  }

  return { remote, ref: rest.join('/') };
}

function checkBaseRef(repoRoot: string, baseRef: string): DoctorFindingInput {
  const localRef = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  if (localRef.ok) {
    return {
      id: 'workspace.base_ref',
      title: 'Workspace base ref is ready',
      status: 'ok',
      reason: 'base_ref_exists',
      summary: `Base ref ${baseRef} resolves locally.`,
      details: { repoRoot, baseRef, source: 'local' }
    };
  }

  const remoteRef = parseRemoteBaseRef(baseRef);
  if (remoteRef) {
    const remote = runGit(repoRoot, ['ls-remote', '--exit-code', remoteRef.remote, remoteRef.ref]);
    if (remote.ok) {
      return {
        id: 'workspace.base_ref',
        title: 'Workspace base ref is ready',
        status: 'ok',
        reason: 'base_ref_fetchable',
        summary: `Base ref ${baseRef} is fetchable from ${remoteRef.remote}.`,
        details: { repoRoot, baseRef, source: 'remote', remote: remoteRef.remote, ref: remoteRef.ref }
      };
    }
  }

  return {
    id: 'workspace.base_ref',
    title: 'Workspace base ref is ready',
    status: 'failure',
    reason: 'base_ref_unavailable',
    summary: `Base ref ${baseRef} does not resolve locally and was not fetchable.`,
    remediation: 'Fetch the configured base ref or update workspace.provisioner.base_ref before running agents.',
    details: { repoRoot, baseRef, stderr: localRef.stderr.trim() }
  };
}

function checkCloneBaseRef(repoRoot: string, baseRef: string): DoctorFindingInput {
  const cloneRef = baseRef.replace(/^origin\//, '');
  const branchRef = `refs/heads/${cloneRef}`;
  const branch = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${branchRef}^{commit}`]);
  if (branch.ok) {
    return {
      id: 'workspace.base_ref',
      title: 'Workspace base ref is ready',
      status: 'ok',
      reason: 'base_ref_exists',
      summary: `Clone base ref ${baseRef} resolves to a source branch.`,
      details: { repoRoot, baseRef, source: 'clone_branch', ref: branchRef }
    };
  }

  const tagRef = `refs/tags/${cloneRef}`;
  const tag = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${tagRef}^{commit}`]);
  if (tag.ok) {
    return {
      id: 'workspace.base_ref',
      title: 'Workspace base ref is ready',
      status: 'ok',
      reason: 'base_ref_exists',
      summary: `Clone base ref ${baseRef} resolves to a source tag.`,
      details: { repoRoot, baseRef, source: 'clone_tag', ref: tagRef }
    };
  }

  return {
    id: 'workspace.base_ref',
    title: 'Workspace base ref is ready',
    status: 'failure',
    reason: 'base_ref_unavailable',
    summary: `Clone base ref ${baseRef} is not a source branch or tag.`,
    remediation: 'Set workspace.provisioner.base_ref to a branch or tag that git clone --branch can check out.',
    details: { repoRoot, baseRef, checkedRefs: [branchRef, tagRef], stderr: branch.stderr.trim() || tag.stderr.trim() }
  };
}

function addWorkspaceChecks(checks: DoctorFinding[], resolved: LocalCommandResolution, effectiveConfig: EffectiveConfig): void {
  const provisioner = effectiveConfig.workspace.provisioner;
  if (provisioner.type === 'none') {
    addCheck(checks, {
      id: 'workspace.provisioner',
      title: 'Workspace provisioner is configured',
      status: 'ok',
      reason: 'workspace_provisioner_disabled',
      summary: 'Workspace provisioning is disabled for this workflow.',
      details: { type: provisioner.type }
    });
    return;
  }

  const repoRoot = provisioner.repo_root;
  if (!repoRoot) {
    addCheck(checks, {
      id: 'workspace.git_repository',
      title: 'Workspace repository is ready',
      status: 'failure',
      reason: 'repo_root_missing',
      summary: 'workspace.provisioner.repo_root is not configured.',
      remediation: 'Set workspace.provisioner.repo_root to an existing git checkout.',
      details: { type: provisioner.type }
    });
    return;
  }

  const repoStat = fs.existsSync(repoRoot) ? fs.statSync(repoRoot) : null;
  if (!repoStat?.isDirectory()) {
    addCheck(checks, {
      id: 'workspace.git_repository',
      title: 'Workspace repository is ready',
      status: 'failure',
      reason: 'repo_root_missing',
      summary: `workspace.provisioner.repo_root is not a directory: ${repoRoot}`,
      remediation: 'Set workspace.provisioner.repo_root to an existing git checkout.',
      details: { type: provisioner.type, repoRoot }
    });
    return;
  }

  const insideWorkTree = runGit(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!insideWorkTree.ok || insideWorkTree.stdout.trim() !== 'true') {
    addCheck(checks, {
      id: 'workspace.git_repository',
      title: 'Workspace repository is ready',
      status: 'failure',
      reason: 'repo_root_not_git_repository',
      summary: `workspace.provisioner.repo_root is not a git work tree: ${repoRoot}`,
      remediation: 'Use a git checkout for workspace.provisioner.repo_root.',
      details: { type: provisioner.type, repoRoot, stderr: insideWorkTree.stderr.trim() }
    });
    return;
  }

  addCheck(checks, {
    id: 'workspace.git_repository',
    title: 'Workspace repository is ready',
    status: 'ok',
    reason: 'repo_root_git_repository',
    summary: `workspace.provisioner.repo_root is a git work tree: ${repoRoot}`,
    details: { type: provisioner.type, repoRoot }
  });

  if (provisioner.type === 'worktree') {
    const worktreeList = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
    addCheck(checks, {
      id: 'workspace.worktree',
      title: 'Git worktree support is ready',
      status: worktreeList.ok ? 'ok' : 'failure',
      reason: worktreeList.ok ? 'worktree_list_ready' : 'worktree_list_failed',
      summary: worktreeList.ok ? 'Git worktree metadata can be inspected.' : 'Git worktree metadata could not be inspected.',
      remediation: worktreeList.ok ? undefined : 'Repair git worktree metadata before provisioning issue workspaces.',
      details: { repoRoot, stderr: worktreeList.stderr.trim() }
    });
  }

  addCheck(
    checks,
    provisioner.type === 'clone' ? checkCloneBaseRef(repoRoot, provisioner.base_ref) : checkBaseRef(repoRoot, provisioner.base_ref)
  );

  const status = runGit(repoRoot, ['status', '--porcelain']);
  const dirty = status.stdout.trim().length > 0;
  addCheck(checks, {
    id: 'workspace.dirty_policy',
    title: 'Dirty repository policy is satisfied',
    status: !dirty || provisioner.allow_dirty_repo ? 'ok' : 'failure',
    reason: dirty
      ? provisioner.allow_dirty_repo
        ? 'dirty_repo_allowed'
        : 'dirty_repo_blocked'
      : 'repo_clean',
    summary: dirty
      ? provisioner.allow_dirty_repo
        ? 'Repository has local changes and workflow allows dirty provisioning.'
        : 'Repository has local changes but workflow blocks dirty provisioning.'
      : 'Repository has no local changes.',
    remediation: dirty && !provisioner.allow_dirty_repo ? 'Commit, stash, or discard local changes before provisioning workspaces.' : undefined,
    details: {
      repoRoot,
      allowDirtyRepo: provisioner.allow_dirty_repo,
      dirtyEntries: status.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 20)
    }
  });
}

function publicSensitiveViolations(violations: SensitiveWorkspaceFileViolation[]): Array<{
  path: string;
  category: string;
  mode: string;
}> {
  return violations.map(({ path: violationPath, category, mode }) => ({ path: violationPath, category, mode }));
}

type SensitiveQuarantineRecovery = {
  incomplete: string[];
  recovered: string[];
  failures: string[];
};

function sensitiveQuarantineBase(projectRoot: string): string {
  const projectKey = crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
  return path.join(path.dirname(path.resolve(projectRoot)), '.symphony-quarantine', projectKey, 'worktree-sensitive');
}

function reconcileSensitiveQuarantineJournals(params: {
  projectRoot: string;
  workspaceRoot: string;
  apply: boolean;
}): SensitiveQuarantineRecovery {
  const quarantineBase = sensitiveQuarantineBase(params.projectRoot);
  const result: SensitiveQuarantineRecovery = { incomplete: [], recovered: [], failures: [] };
  if (!fs.existsSync(quarantineBase)) return result;
  for (const directory of fs.readdirSync(quarantineBase, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const journalPath = path.join(quarantineBase, directory.name, 'manifest.json');
    if (!fs.existsSync(journalPath)) continue;
    let journal: any;
    try {
      journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    } catch {
      result.failures.push(path.relative(quarantineBase, journalPath));
      continue;
    }
    if (journal.state === 'complete' || journal.state === 'rolled_back' || journal.state === REASON_CODES.recoveredAfterRestart) {
      continue;
    }
    result.incomplete.push(path.relative(quarantineBase, journalPath));
    if (!params.apply || !Array.isArray(journal.entries)) continue;
    let failed = false;
    for (const entry of [...journal.entries].reverse()) {
      const source = typeof entry.source === 'string' ? path.resolve(entry.source) : '';
      const destination = typeof entry.destination === 'string' ? path.resolve(entry.destination) : '';
      const journalRoot = path.dirname(journalPath);
      if (!source || !destination || !isWithinPath(params.workspaceRoot, source) || !isWithinPath(journalRoot, destination)) {
        entry.status = 'recovery_refused';
        failed = true;
        continue;
      }
      const sourceExists = fs.existsSync(source);
      const destinationExists = fs.existsSync(destination);
      if (sourceExists && !destinationExists) {
        entry.status = 'restored';
      } else if (!sourceExists && destinationExists) {
        try {
          fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
          fs.renameSync(destination, source);
          entry.status = 'restored';
        } catch {
          entry.status = 'recovery_failed';
          failed = true;
        }
      } else if (!sourceExists && !destinationExists) {
        entry.status = 'recovery_missing_both';
        failed = true;
      } else {
        entry.status = 'recovery_ambiguous_both_exist';
        failed = true;
      }
    }
    journal.state = failed ? 'partial_failure' : REASON_CODES.recoveredAfterRestart;
    const temporary = `${journalPath}.recovery.tmp`;
    const descriptor = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, journalPath);
    if (failed) result.failures.push(path.relative(params.projectRoot, journalPath));
    else result.recovered.push(path.relative(params.projectRoot, journalPath));
  }
  return result;
}

function addManagedWorkspaceSensitiveFileCheck(params: {
  checks: DoctorFinding[];
  fixes: DoctorFixAction[];
  effectiveConfig: EffectiveConfig;
  projectRoot: string;
  fix: boolean;
  yes: boolean;
  ci: boolean;
  now: Date;
}): void {
  const workspaceRoot = path.resolve(params.effectiveConfig.workspace.root);
  const journalRecovery = reconcileSensitiveQuarantineJournals({
    projectRoot: params.projectRoot,
    workspaceRoot,
    apply: params.fix && params.yes && !params.ci
  });
  let audit = auditSensitiveWorkspaceFiles(workspaceRoot);

  if (params.fix && audit.complete && audit.violations.length > 0) {
    if (params.ci) {
      addFix(params.fixes, {
        id: 'workspace-sensitive-files',
        status: 'skipped',
        summary: 'Sensitive worktree files were not quarantined because `--ci` forbids doctor fix mutations.'
      });
    } else if (!params.yes) {
      addFix(params.fixes, {
        id: 'workspace-sensitive-files',
        status: 'skipped',
        summary: 'Sensitive worktree files were not quarantined because `--yes` was not provided.'
      });
    } else {
      const stamp = params.now.toISOString().replace(/[:.]/g, '-');
      const quarantineRoot = path.join(sensitiveQuarantineBase(params.projectRoot), stamp);
      if (isWithinPath(workspaceRoot, quarantineRoot)) {
        addFix(params.fixes, {
          id: 'workspace-sensitive-files',
          status: 'failed',
          summary: 'Refused to quarantine sensitive files inside the managed workspace root.'
        });
      } else {
        const moved: Array<{ path: string; category: string; mode: string }> = [];
        let failure: string | null = null;
        const journal = {
          quarantined_at: params.now.toISOString(),
          state: 'planned',
          entries: audit.violations.map((violation) => ({
            path: violation.path,
            category: violation.category,
            mode: violation.mode,
            source: violation.absolutePath,
            destination: path.join(quarantineRoot, violation.path),
            status: 'pending'
          }))
        };
        const manifestPath = path.join(quarantineRoot, 'manifest.json');
        const persistJournal = () => {
          fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
          const temporary = `${manifestPath}.tmp`;
          const descriptor = fs.openSync(temporary, 'w', 0o600);
          try {
            fs.writeFileSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
            fs.fsyncSync(descriptor);
          } finally {
            fs.closeSync(descriptor);
          }
          fs.renameSync(temporary, manifestPath);
        };
        try {
          persistJournal();
          for (const [index, violation] of audit.violations.entries()) {
            const destination = journal.entries[index]!.destination;
            fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
            fs.renameSync(violation.absolutePath, destination);
            moved.push({ path: violation.path, category: violation.category, mode: violation.mode });
            journal.entries[index]!.status = 'moved';
            journal.state = 'moving';
            persistJournal();
          }
          journal.state = 'complete';
          persistJournal();
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
          journal.state = 'rollback';
          for (const entry of [...journal.entries].reverse()) {
            if (entry.status !== 'moved') continue;
            try {
              fs.mkdirSync(path.dirname(entry.source), { recursive: true, mode: 0o700 });
              fs.renameSync(entry.destination, entry.source);
              entry.status = 'restored';
            } catch {
              entry.status = 'rollback_failed';
            }
          }
          journal.state = journal.entries.some((entry) => entry.status === 'rollback_failed')
            ? 'partial_failure'
            : 'rolled_back';
          try {
            persistJournal();
          } catch {
            // The pre-mutation journal remains the recovery source when the update itself fails.
          }
        }
        addFix(params.fixes, {
          id: 'workspace-sensitive-files',
          status: failure ? 'failed' : 'applied',
          summary: failure
            ? `Sensitive worktree quarantine stopped after ${moved.length} move(s): ${failure}`
            : `Moved ${moved.length} sensitive worktree path(s) into recoverable quarantine.`,
          details: { entries: moved, quarantine: path.relative(sensitiveQuarantineBase(params.projectRoot), quarantineRoot) }
        });
        audit = auditSensitiveWorkspaceFiles(workspaceRoot);
      }
    }
  }

  const unresolvedJournalCount = journalRecovery.incomplete.length - journalRecovery.recovered.length;
  const ready = audit.complete && audit.violations.length === 0 && unresolvedJournalCount === 0 && journalRecovery.failures.length === 0;
  addCheck(params.checks, {
    id: 'workspace.sensitive_files',
    title: 'Managed worktrees contain no credential files',
    status: ready ? 'ok' : 'failure',
    reason: !audit.complete
      ? 'workspace_sensitive_file_audit_incomplete'
      : journalRecovery.failures.length > 0 || unresolvedJournalCount > 0
        ? 'workspace_sensitive_file_quarantine_recovery_required'
      : audit.violations.length > 0
        ? 'workspace_sensitive_files_detected'
        : 'workspace_sensitive_files_absent',
    summary: !audit.complete
      ? `Managed worktree audit was incomplete after ${audit.scannedEntries} entries.`
      : journalRecovery.failures.length > 0 || unresolvedJournalCount > 0
        ? `Detected ${unresolvedJournalCount} incomplete sensitive-file quarantine journal(s).`
      : audit.violations.length > 0
        ? `Detected ${audit.violations.length} sensitive path(s) in managed worktrees.`
        : `Managed worktree audit completed without sensitive paths (${audit.scannedEntries} entries).`,
    remediation: ready ? undefined : 'Remove the reported files or run `symphony doctor --fix --yes` to quarantine them recoverably.',
    safeFix: safeFixForFinding(
      { id: 'workspace.sensitive_files', status: ready ? 'ok' : 'failure' },
      { projectRoot: params.projectRoot }
    ),
    details: {
      workspaceRoot,
      scannedEntries: audit.scannedEntries,
      complete: audit.complete,
      violations: publicSensitiveViolations(audit.violations),
      error: audit.error,
      journalRecovery
    }
  });
}

interface HistoryReconciliationAudit {
  databaseExists: boolean;
  active: number;
  repairable: number;
  ambiguous: number;
  error: string | null;
}

function auditHistoryReconciliation(dbPath: string): HistoryReconciliationAudit {
  if (!fs.existsSync(dbPath)) {
    return { databaseExists: false, active: 0, repairable: 0, ambiguous: 0, error: null };
  }
  let db: {
    prepare: (sql: string) => { get: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[] };
    close: () => void;
  } | null = null;
  try {
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => typeof db;
    };
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const issueRunTable = db!.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'issue_run'").get();
    if (!issueRunTable) return { databaseExists: true, active: 0, repairable: 0, ambiguous: 0, error: null };
    const rows = db!.prepare(
      `SELECT issue_run.issue_run_id, issue_run.issue_id, issue_run.started_at,
        runs.completed_at, runs.terminal_status
       FROM issue_run
       LEFT JOIN runs ON runs.run_id = (
         SELECT projected_run.run_id
         FROM history_identity_projection
         JOIN runs AS projected_run ON projected_run.run_id = history_identity_projection.source_id
         WHERE history_identity_projection.source_table = 'runs'
           AND history_identity_projection.issue_run_id = issue_run.issue_run_id
         ORDER BY projected_run.started_at DESC, projected_run.run_id DESC
         LIMIT 1
       )
       WHERE issue_run.ended_at IS NULL`
    ).all() as Array<{
      issue_run_id: string;
      issue_id: string;
      started_at: string;
      completed_at: string | null;
      terminal_status: string | null;
    }>;
    const threadColumns = new Set(
      (db!.prepare('PRAGMA table_info(thread)').all() as Array<{ name: string }>).map((column) => column.name)
    );
    const workerInstanceProjection = threadColumns.has('worker_instance_id')
      ? 'thread.worker_instance_id'
      : 'NULL AS worker_instance_id';
    const workerPidProjection = threadColumns.has('worker_process_pid')
      ? 'thread.worker_process_pid'
      : 'NULL AS worker_process_pid';
    let repairable = 0;
    let ambiguous = 0;
    for (const row of rows) {
      let terminalEvidence = Boolean(row.completed_at && row.terminal_status);
      if (!row.completed_at || !row.terminal_status) {
        const terminalEvent = findLatestTerminalRunEventEvidence(db!, row.issue_run_id, row.issue_id, row.started_at);
        terminalEvidence = terminalEvent !== null;
        if (!terminalEvidence) {
          const supersedingRun = db!.prepare(
            `SELECT issue_run_id
             FROM issue_run
             WHERE issue_id = ?
               AND issue_run_id <> ?
               AND started_at > ?
               AND ended_at IS NOT NULL
               AND status <> 'running'
             ORDER BY started_at ASC
             LIMIT 1`
          ).get(row.issue_id, row.issue_run_id, row.started_at);
          terminalEvidence = Boolean(supersedingRun);
        }
      }
      const owners = db!.prepare(
        `SELECT ${workerInstanceProjection}, ${workerPidProjection}
         FROM thread
         JOIN attempt ON attempt.attempt_id = thread.attempt_id
         WHERE attempt.issue_run_id = ? AND thread.ended_at IS NULL`
      ).all(row.issue_run_id) as Array<{ worker_instance_id: string | null; worker_process_pid: number | null }>;
      const workerOwnership = classifyPersistedWorkerOwnership(owners);
      if (workerOwnership === 'active_or_unknown' || (!terminalEvidence && workerOwnership !== 'inactive')) {
        ambiguous += 1;
      } else {
        repairable += 1;
      }
    }
    const staleRunProjectionCount = Number((db!.prepare(
      `SELECT COUNT(*) AS count
       FROM runs
       JOIN history_identity_projection ON history_identity_projection.source_table = 'runs'
         AND history_identity_projection.source_id = runs.run_id
       JOIN issue_run ON issue_run.issue_run_id = history_identity_projection.issue_run_id
       WHERE runs.ended_at IS NULL
         AND issue_run.ended_at IS NOT NULL
         AND issue_run.status <> 'running'`
    ).get() as { count: number }).count);
    return {
      databaseExists: true,
      active: rows.length + staleRunProjectionCount,
      repairable: repairable + staleRunProjectionCount,
      ambiguous,
      error: null
    };
  } catch (error) {
    return {
      databaseExists: true,
      active: 0,
      repairable: 0,
      ambiguous: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    db?.close();
  }
}

function addHistoryReconciliationCheck(params: {
  checks: DoctorFinding[];
  fixes: DoctorFixAction[];
  effectiveConfig: EffectiveConfig;
  projectRoot: string;
  fix: boolean;
  yes: boolean;
  ci: boolean;
}): void {
  if (!params.effectiveConfig.persistence.enabled) {
    addCheck(params.checks, {
      id: 'history.execution_graph_reconciliation',
      title: 'Execution graph history is reconciled',
      status: 'ok',
      reason: 'history_persistence_disabled',
      summary: 'Persistent execution history is disabled.',
      details: { enabled: false }
    });
    return;
  }
  const dbPath = params.effectiveConfig.persistence.db_path;
  let audit = auditHistoryReconciliation(dbPath);
  if (params.fix && audit.repairable > 0) {
    if (params.ci || !params.yes) {
      addFix(params.fixes, {
        id: 'history-execution-graph-reconciliation',
        status: 'skipped',
        summary: params.ci
          ? 'History reconciliation was not run because `--ci` forbids doctor fix mutations.'
          : 'History reconciliation was not run because `--yes` was not provided.'
      });
    } else {
      let failure: string | null = null;
      let result: { recovered: number; ambiguous: number } | null = null;
      try {
        const store = new SqlitePersistenceStore({
          dbPath,
          retentionDays: params.effectiveConfig.persistence.retention_days
        });
        try {
          result = store.reconcileExecutionGraphAfterRestart();
        } finally {
          store.close();
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      addFix(params.fixes, {
        id: 'history-execution-graph-reconciliation',
        status: failure ? 'failed' : 'applied',
        summary: failure
          ? `History reconciliation failed: ${failure}`
          : `Closed ${result?.recovered ?? 0} provably orphaned execution graph record(s); ${result?.ambiguous ?? 0} remain ambiguous.`,
        details: result ?? undefined
      });
      audit = auditHistoryReconciliation(dbPath);
    }
  }
  const ready = audit.error === null && audit.active === 0;
  const baseSafeFix = safeFixForFinding(
    { id: 'history.execution_graph_reconciliation', status: ready ? 'ok' : 'failure' },
    { projectRoot: params.projectRoot, persistencePath: dbPath }
  );
  addCheck(params.checks, {
    id: 'history.execution_graph_reconciliation',
    title: 'Execution graph history is reconciled',
    status: ready ? 'ok' : 'failure',
    reason: audit.error
      ? 'history_reconciliation_audit_failed'
      : audit.ambiguous > 0
        ? 'history_orphan_reconciliation_ambiguous'
        : audit.repairable > 0
          ? 'history_orphan_reconciliation_required'
          : 'history_execution_graph_reconciled',
    summary: audit.error
      ? 'Execution history could not be audited safely.'
      : audit.active === 0
        ? 'No active persisted execution graph records require restart reconciliation.'
        : `${audit.repairable} provably orphaned record(s) are repairable; ${audit.ambiguous} record(s) remain ambiguous.`,
    remediation: ready
      ? undefined
      : audit.repairable > 0
        ? 'Stop the runtime, then run `symphony doctor --fix --yes`; ambiguous records are never changed automatically.'
        : 'Inspect the owning runtime or parent run; doctor refuses to change ambiguous records.',
    safeFix: { ...baseSafeFix, available: audit.repairable > 0 },
    details: {
      databasePath: dbPath,
      databaseExists: audit.databaseExists,
      activeCount: audit.active,
      repairableCount: audit.repairable,
      ambiguousCount: audit.ambiguous,
      auditError: audit.error
    }
  });
}

function addCodexCommandCheck(checks: DoctorFinding[], effectiveConfig: EffectiveConfig, env: NodeJS.ProcessEnv): void {
  const command = effectiveConfig.codex.command;
  const executablePath = findCommandOnPath(command, env);
  addCheck(checks, {
    id: 'codex.command',
    title: 'Codex command is available',
    status: executablePath ? 'ok' : 'failure',
    reason: executablePath ? 'codex_command_available' : 'codex_command_missing',
    summary: executablePath ? `Codex command resolves to ${executablePath}.` : `Codex command is not executable: ${command}`,
    remediation: executablePath ? undefined : 'Install Codex or set codex.command to an executable command before starting agents.',
    details: { command, executablePath }
  });
}

async function addReviewApprovalCheck(
  checks: DoctorFinding[],
  effectiveConfig: EffectiveConfig,
  env: NodeJS.ProcessEnv,
  projectRoot: string
): Promise<void> {
  if (!effectiveConfig.review_approval) return;
  let repository: string | null = null;
  try {
    const remote = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot,
      env: { PATH: env.PATH },
      encoding: 'utf8',
      shell: false,
      timeout: 10_000,
      maxBuffer: 64 * 1024
    });
    repository = remote.status === 0 ? parseGitHubRemote(remote.stdout.trim()) : null;
    if (!repository) throw new Error('review_approval_repository_invalid');
    const appId = env.SYMPHONY_REVIEWER_APP_ID?.trim();
    const installationId = env.SYMPHONY_REVIEWER_INSTALLATION_ID?.trim();
    if (!appId || !installationId) throw new Error('review_approval_credentials_missing');
    const broker = new GitHubAppApprovalBroker({
      appId,
      installationId,
      privateKeyPath: env.SYMPHONY_REVIEWER_PRIVATE_KEY_PATH,
      privateKey: env.SYMPHONY_REVIEWER_PRIVATE_KEY,
      projectRoot,
      workspaceRoot: effectiveConfig.workspace.root,
      managedWorkspaceRoot: effectiveConfig.workspace.root,
      operatorToken: env.GH_TOKEN ?? env.GITHUB_TOKEN
    });
    const probe = await broker.probe(repository);
    const childEnvironment = stripReviewerCredentials(env);
    const leakedNames = SUPERVISOR_REVIEWER_ENV_NAMES.filter((name) => childEnvironment[name] !== undefined);
    if (leakedNames.length > 0) throw new Error('review_approval_worker_environment_leak');
    addCheck(checks, {
      id: 'review_approval.github_app',
      title: 'Supervisor GitHub App review approval is ready',
      status: probe.inline_key ? 'warning' : 'ok',
      reason: probe.inline_key ? 'review_approval_inline_key_deprecated' : 'review_approval_ready',
      summary: probe.inline_key
        ? `Reviewer App ${probe.identity.slug} is ready for ${repository}, but inline private-key configuration is deprecated.`
        : `Reviewer App ${probe.identity.slug} is ready for ${repository} and isolated from worker environments.`,
      remediation: probe.inline_key
        ? 'Move the reviewer private key to a mode-0600 file outside the project and managed workspace roots.'
        : undefined,
      details: {
        repository,
        appSlug: probe.identity.slug,
        appLogin: probe.identity.login,
        operatorLogin: probe.operator_login,
        installationId: probe.identity.installation_id,
        keyConfiguration: probe.inline_key ? 'inline_deprecated' : 'path',
        keyPath: probe.key_path,
        permissions: probe.permissions,
        reviewerVariablesExcludedFromWorkers: true
      }
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(':', 1)[0] : REASON_CODES.reviewApprovalCredentialsInvalid;
    addCheck(checks, {
      id: 'review_approval.github_app',
      title: 'Supervisor GitHub App review approval is ready',
      status: 'failure',
      reason,
      summary: 'The supervisor reviewer App configuration or repository capability failed validation.',
      remediation: 'Fix the reviewer App ID, installation, mode-0600 key path, repository access, and operator identity, then rerun doctor.',
      details: { repository, reviewerVariablesExcludedFromWorkers: true }
    });
  }
}

function inspectClaudeUserSettings(
  env: NodeJS.ProcessEnv,
  allowNonSubscriptionAuth: boolean
): { selectors: string[]; unsafe: string[]; hash: string } {
  const home = env.HOME?.trim() || os.homedir();
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return { selectors: [], unsafe: [], hash: crypto.createHash('sha256').update('missing').digest('hex') };
  }
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const record = workflowRecord(parsed);
    const settingsEnv = workflowRecord(record.env);
    const sandbox = workflowRecord(record.sandbox);
    const filesystem = workflowRecord(sandbox.filesystem);
    const network = workflowRecord(sandbox.network);
    const permissions = workflowRecord(record.permissions);
    const enabledPlugins = workflowRecord(record.enabledPlugins);
    const plugins = workflowRecord(record.plugins);
    const environmentNames = Object.entries(settingsEnv)
      .filter(([, value]) => (typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined))
      .map(([name]) => name);
    const unsafe = [
      ...(Object.keys(workflowRecord(record.hooks)).length > 0 ? ['hooks'] : []),
      ...(Object.values(enabledPlugins).some((value) => value === true) ? ['enabledPlugins'] : []),
      ...(Object.keys(plugins).length > 0 ? ['plugins'] : []),
      ...(record.agents !== undefined ? ['agents'] : []),
      ...(Array.isArray(sandbox.excludedCommands) && sandbox.excludedCommands.length > 0 ? ['sandbox.excludedCommands'] : []),
      ...(sandbox.allowUnsandboxedCommands === true ? ['sandbox.allowUnsandboxedCommands'] : []),
      ...(sandbox.failIfUnavailable === false ? ['sandbox.failIfUnavailable'] : []),
      ...(sandbox.allowAppleEvents === true ? ['sandbox.allowAppleEvents'] : []),
      ...(filesystem.disabled === true ? ['sandbox.filesystem.disabled'] : []),
      ...(network.allowAllUnixSockets === true ? ['sandbox.network.allowAllUnixSockets'] : []),
      ...(network.enableWeakerNetworkIsolation === true ? ['sandbox.network.enableWeakerNetworkIsolation'] : []),
      ...(permissions.defaultMode === 'bypassPermissions' ? ['permissions.defaultMode'] : []),
      ...(Array.isArray(permissions.allow) && permissions.allow.length > 0 ? ['permissions.allow'] : []),
      ...(Array.isArray(permissions.additionalDirectories) && permissions.additionalDirectories.length > 0
        ? ['permissions.additionalDirectories']
        : []),
      ...(Array.isArray(filesystem.allowWrite) && filesystem.allowWrite.length > 0 ? ['sandbox.filesystem.allowWrite'] : []),
      ...(Array.isArray(filesystem.allowRead) && filesystem.allowRead.length > 0 ? ['sandbox.filesystem.allowRead'] : []),
      ...(Array.isArray(network.allowedDomains) && network.allowedDomains.length > 0 ? ['sandbox.network.allowedDomains'] : []),
      ...(Array.isArray(network.allowUnixSockets) && network.allowUnixSockets.length > 0
        ? ['sandbox.network.allowUnixSockets']
        : []),
      ...(network.allowLocalBinding === true ? ['sandbox.network.allowLocalBinding'] : []),
      ...(Array.isArray(network.allowMachLookup) && network.allowMachLookup.length > 0
        ? ['sandbox.network.allowMachLookup']
        : []),
      ...(network.httpProxyPort !== undefined ? ['sandbox.network.httpProxyPort'] : []),
      ...(network.socksProxyPort !== undefined ? ['sandbox.network.socksProxyPort'] : []),
      ...(network.tlsTerminate !== undefined ? ['sandbox.network.tlsTerminate'] : []),
      ...(sandbox.enableWeakerNestedSandbox === true ? ['sandbox.enableWeakerNestedSandbox'] : []),
      ...(sandbox.enableWeakerNetworkIsolation === true ? ['sandbox.enableWeakerNetworkIsolation'] : []),
      ...(sandbox.ignoreViolations !== undefined ? ['sandbox.ignoreViolations'] : []),
      ...(sandbox.ripgrep !== undefined ? ['sandbox.ripgrep'] : []),
      ...(record.processWrapper !== undefined ? ['processWrapper'] : []),
      ...(record.statusLine !== undefined ? ['statusLine'] : []),
      ...(record.fileSuggestion !== undefined ? ['fileSuggestion'] : []),
      ...(record.apiKeyHelper !== undefined ? ['apiKeyHelper'] : []),
      ...environmentNames.map((name) => `env.${name}`)
    ];
    const selectors = [
      ...(record.apiKeyHelper ? ['apiKeyHelper'] : []),
      ...CLAUDE_NON_SUBSCRIPTION_ENV_NAMES.filter((name) => {
        const value = settingsEnv[name];
        return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
      })
    ];
    return {
      selectors: [...new Set(selectors)],
      unsafe: [...new Set(unsafe)],
      hash: crypto.createHash('sha256').update(raw).digest('hex')
    };
  } catch {
    return { selectors: ['invalid_user_settings'], unsafe: ['invalid_user_settings'], hash: 'invalid' };
  }
}

function inspectClaudeGitRemote(projectRoot: string, gitExecutable: string | null): {
  scheme: 'ssh' | 'https' | 'http' | 'other' | 'missing';
  host: string | null;
  hasCredentials: boolean;
} {
  if (!gitExecutable) return { scheme: 'other', host: null, hasCredentials: false };
  const remote = spawnSync(gitExecutable, ['config', '--file', path.join(projectRoot, '.git', 'config'), '--get', 'remote.origin.url'], {
    cwd: projectRoot,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    maxBuffer: 64 * 1024
  });
  const value = remote.status === 0 ? remote.stdout.trim() : '';
  if (!value) return { scheme: 'missing', host: null, hasCredentials: false };
  if (value.includes('://')) {
    try {
      const parsed = new URL(value);
      const hasCredentials = Boolean(
        parsed.password || ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.username)
      );
      if (parsed.protocol === 'ssh:') return { scheme: 'ssh', host: parsed.hostname.toLowerCase(), hasCredentials };
      if (parsed.protocol === 'https:') {
        return { scheme: 'https', host: parsed.hostname.toLowerCase(), hasCredentials };
      }
      if (parsed.protocol === 'http:') return { scheme: 'http', host: parsed.hostname.toLowerCase(), hasCredentials };
      return { scheme: 'other', host: parsed.hostname.toLowerCase() || null, hasCredentials };
    } catch {
      return { scheme: 'other', host: null, hasCredentials: false };
    }
  }
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):/.exec(value);
  return scp
    ? { scheme: 'ssh', host: scp[1]!.toLowerCase(), hasCredentials: false }
    : { scheme: 'other', host: null, hasCredentials: false };
}

function inspectClaudeSshAgent(
  env: NodeJS.ProcessEnv,
  forbiddenRoots: string[]
): { ready: boolean; socketPath: string | null; reason: string } {
  const candidate = env.SSH_AUTH_SOCK?.trim();
  if (!candidate) return { ready: false, socketPath: null, reason: 'missing' };
  try {
    const socketPath = fs.realpathSync(candidate);
    const stat = fs.statSync(socketPath);
    if (!stat.isSocket()) return { ready: false, socketPath, reason: 'not_socket' };
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return { ready: false, socketPath, reason: 'owner_mismatch' };
    }
    const sshAddExecutable = resolveTrustedExecutable('ssh-add', env, forbiddenRoots);
    const probe = spawnSync(sshAddExecutable, ['-l'], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SSH_AUTH_SOCK: socketPath },
      encoding: 'utf8',
      shell: false,
      timeout: 10_000,
      maxBuffer: 64 * 1024
    });
    if (probe.status === 1) return { ready: false, socketPath, reason: 'no_identities' };
    if (probe.status !== 0) return { ready: false, socketPath, reason: 'probe_failed' };
    return { ready: true, socketPath, reason: 'ready' };
  } catch {
    return { ready: false, socketPath: null, reason: 'invalid' };
  }
}

function addClaudeRuntimeChecks(
  checks: DoctorFinding[],
  effectiveConfig: EffectiveConfig,
  env: NodeJS.ProcessEnv,
  projectRoot: string
): void {
  const runtime = effectiveConfig.agent_runtime;
  if (!runtime || runtime.selected !== 'claude-cli') return;

  const platformReady = ['darwin', 'linux'].includes(process.platform);
  const remoteHosts = effectiveConfig.worker?.ssh_hosts ?? [];
  addCheck(checks, {
    id: 'claude.runtime_scope',
    title: 'Claude runtime is local on a supported platform',
    status: platformReady && remoteHosts.length === 0 ? 'ok' : 'failure',
    reason:
      !platformReady ? 'claude_platform_unsupported' : remoteHosts.length > 0 ? 'claude_remote_worker_unsupported' : 'claude_runtime_scope_supported',
    summary:
      !platformReady
        ? `Claude CLI runtime is unsupported on ${process.platform}.`
        : remoteHosts.length > 0
          ? 'Claude CLI runtime does not support configured SSH worker hosts.'
          : `Claude CLI runtime is local on supported platform ${process.platform}.`,
    remediation:
      platformReady && remoteHosts.length === 0
        ? undefined
        : 'Use a local macOS/Linux worker or select the Codex runtime for remote workers.',
    details: { platform: process.platform, configuredRemoteHostCount: remoteHosts.length }
  });
  const isolatedGitDirectory = effectiveConfig.workspace.provisioner.type === 'clone';
  addCheck(checks, {
    id: 'claude.workspace_git_boundary',
    title: 'Claude workspace owns its Git metadata',
    status: isolatedGitDirectory ? 'ok' : 'failure',
    reason: isolatedGitDirectory ? 'claude_clone_workspace_ready' : 'claude_linked_worktree_metadata_unsupported',
    summary: isolatedGitDirectory
      ? 'Clone provisioning keeps writable Git metadata inside the sandboxed workspace.'
      : `Provisioner ${effectiveConfig.workspace.provisioner.type} stores writable Git metadata outside the worktree boundary.`,
    remediation: isolatedGitDirectory
      ? undefined
      : 'Use workspace.provisioner.type=clone for claude-cli so commit and push remain inside the strict filesystem boundary.',
    details: { provisionerType: effectiveConfig.workspace.provisioner.type }
  });
  addCheck(checks, {
    id: 'claude.process_containment',
    title: 'Claude child processes use supervised process ownership',
    status: 'ok',
    reason: 'claude_process_group_supervision_ready',
    summary: 'Symphony uses a dedicated process group, descendant monitoring, and TERM/KILL cleanup for each Claude invocation.',
    details: { platform: process.platform, enforcement: 'process_group_and_descendant_monitoring' }
  });
  const persistenceDisabled = Boolean(env.CLAUDE_CODE_SKIP_PROMPT_HISTORY?.trim());
  addCheck(checks, {
    id: 'claude.session_persistence',
    title: 'Claude session persistence is enabled',
    status: persistenceDisabled ? 'failure' : 'ok',
    reason: persistenceDisabled ? 'claude_session_persistence_disabled' : 'claude_session_persistence_ready',
    summary: persistenceDisabled
      ? 'CLAUDE_CODE_SKIP_PROMPT_HISTORY disables the transcript needed for exact attempt-local resume.'
      : 'No session-persistence disabling selector was detected.',
    remediation: persistenceDisabled ? 'Unset CLAUDE_CODE_SKIP_PROMPT_HISTORY before starting Symphony.' : undefined,
    details: { disabled: persistenceDisabled }
  });
  addCheck(checks, {
    id: 'claude.model',
    title: 'Claude model is pinned',
    status: runtime.claude_model ? 'ok' : 'failure',
    reason: runtime.claude_model ? 'claude_model_pinned' : 'claude_model_missing',
    summary: runtime.claude_model ? `Claude model is pinned to ${runtime.claude_model}.` : 'ANTHROPIC_MODEL is missing.',
    details: { requestedModel: runtime.claude_model }
  });

  let executablePath: string | null = null;
  try {
    executablePath = resolveTrustedExecutable(
      runtime.claude_command,
      env,
      path.isAbsolute(runtime.claude_command) ? [] : [projectRoot]
    );
  } catch {
    // The command readiness finding below reports the unavailable trusted path.
  }
  addCheck(checks, {
    id: 'claude.command',
    title: 'Claude command is available',
    status: executablePath ? 'ok' : 'failure',
    reason: executablePath ? 'claude_command_available' : 'claude_command_missing',
    summary: executablePath ? `Claude command resolves to ${executablePath}.` : `Claude command is not executable: ${runtime.claude_command}`,
    remediation: executablePath ? undefined : 'Install the supported Claude CLI or set SYMPHONY_CLAUDE_COMMAND to an executable path.',
    details: { command: runtime.claude_command, executablePath }
  });
  if (!executablePath) return;

  const userSettings = inspectClaudeUserSettings(env, runtime.claude_allow_non_subscription_auth);
  addCheck(checks, {
    id: 'claude.user_settings',
    title: 'Claude user settings preserve the supervised sandbox boundary',
    status: userSettings.unsafe.length === 0 ? 'ok' : 'failure',
    reason: userSettings.unsafe.length === 0 ? 'claude_user_settings_safe' : 'claude_user_settings_unsafe',
    summary:
      userSettings.unsafe.length === 0
        ? 'No executable customization, credential environment, broad permission, or sandbox weakening was detected.'
        : `Unsafe Claude user setting(s): ${userSettings.unsafe.join(', ')}.`,
    remediation:
      userSettings.unsafe.length === 0
        ? undefined
        : 'Remove the unsafe user-scoped Claude customization before running Symphony with claude-cli.',
    details: { unsafe: userSettings.unsafe, settingsHash: userSettings.hash }
  });
  const managedPolicyBaseCandidates = process.platform === 'darwin'
    ? [
        '/Library/Application Support/ClaudeCode/managed-settings.json',
        '/Library/Application Support/ClaudeCode/managed-mcp.json',
        '/Library/Managed Preferences/com.anthropic.claudecode.plist',
        '/Library/Managed Preferences/com.anthropic.ClaudeCode.plist'
      ]
    : ['/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-mcp.json'];
  const managedDropInDirectories = process.platform === 'darwin'
    ? ['/Library/Application Support/ClaudeCode/managed-settings.d']
    : ['/etc/claude-code/managed-settings.d'];
  const managedPolicyCandidates = [
    ...managedPolicyBaseCandidates,
    ...managedDropInDirectories.flatMap((directory) => {
      try {
        return fs.readdirSync(directory)
          .filter((entry) => entry.endsWith('.json'))
          .map((entry) => path.join(directory, entry));
      } catch {
        return [];
      }
    }),
    path.join(os.homedir(), '.claude', 'managed-settings.json'),
    path.join(os.homedir(), '.claude', 'managed-mcp.json')
  ];
  const remoteSettingsPath = path.join(os.homedir(), '.claude', 'remote-settings.json');
  if (fs.existsSync(remoteSettingsPath)) {
    try {
      const remoteSettings = JSON.parse(fs.readFileSync(remoteSettingsPath, 'utf8')) as unknown;
      const hasRemoteSettings = Array.isArray(remoteSettings)
        ? remoteSettings.length > 0
        : Boolean(remoteSettings && typeof remoteSettings === 'object' && Object.keys(remoteSettings).length > 0);
      if (hasRemoteSettings) managedPolicyCandidates.push(remoteSettingsPath);
    } catch {
      managedPolicyCandidates.push(remoteSettingsPath);
    }
  }
  const managedPolicyPresent = managedPolicyCandidates.filter((candidate) => fs.existsSync(candidate));
  addCheck(checks, {
    id: 'claude.managed_policy',
    title: 'Claude managed policy cannot override the supervised sandbox',
    status: managedPolicyPresent.length === 0 ? 'ok' : 'failure',
    reason: managedPolicyPresent.length === 0 ? 'claude_managed_policy_absent' : 'claude_managed_policy_unsupported',
    summary: managedPolicyPresent.length === 0
      ? 'No host-managed Claude settings source was detected.'
      : 'Managed Claude policy is present and cannot be safely composed with the MVP sandbox contract.',
    remediation: managedPolicyPresent.length === 0
      ? undefined
      : 'Use a worker without managed Claude policy until effective-policy attestation is implemented.',
    details: { present: managedPolicyPresent.map((candidate) => path.basename(candidate)) }
  });
  const customAgentsDirectory = path.join(os.homedir(), '.claude', 'agents');
  const customAgents = (() => {
    try {
      return fs.readdirSync(customAgentsDirectory).filter((entry) => entry.toLowerCase().endsWith('.md'));
    } catch {
      return [];
    }
  })();
  addCheck(checks, {
    id: 'claude.custom_agents',
    title: 'Claude user custom agents are disabled',
    status: customAgents.length === 0 ? 'ok' : 'failure',
    reason: customAgents.length === 0 ? 'claude_user_custom_agents_absent' : 'claude_user_custom_agents_unsupported',
    summary: customAgents.length === 0
      ? 'No user-scoped custom agent definitions were found.'
      : 'User-scoped custom agent definitions are not supported by the supervised runtime.',
    remediation: customAgents.length === 0 ? undefined : 'Remove user custom-agent files before using claude-cli with Symphony.',
    details: { count: customAgents.length }
  });

  const sandboxDependencyNames = process.platform === 'darwin' ? ['sandbox-exec'] : ['bwrap', 'socat'];
  const sandboxDependencies = sandboxDependencyNames.map((name) => ({ name, executablePath: findCommandOnPath(name, env) }));
  const missingSandboxDependencies = sandboxDependencies.filter((entry) => !entry.executablePath).map((entry) => entry.name);
  let sandboxPolicyCounts = { existing: 0, skippedMissing: 0, collapsed: 0 };
  let sandboxPolicyError: string | null = null;
  try {
    const sensitiveAudit = auditSensitiveWorkspaceFiles(projectRoot);
    if (!sensitiveAudit.complete) throw new Error('claude_project_sensitive_audit_incomplete');
    const snapshot = createClaudeSandboxPathSnapshot(claudeSandboxProtectedPathCandidates({
      executable: executablePath,
      workspace: projectRoot,
      projectRoot,
      projectSensitivePaths: sensitiveAudit.violations.map((violation) => violation.absolutePath),
      home: env.HOME?.trim() || os.homedir(),
      additionalProtectedPaths: env.SYMPHONY_REVIEWER_PRIVATE_KEY_PATH
        ? [env.SYMPHONY_REVIEWER_PRIVATE_KEY_PATH]
        : []
    }));
    sandboxPolicyCounts = {
      existing: snapshot.protectedPaths.length,
      skippedMissing: snapshot.skippedMissingCount,
      collapsed: snapshot.collapsedCount
    };
  } catch (error) {
    sandboxPolicyError = error instanceof Error ? error.message : 'claude_sandbox_policy_invalid';
  }
  const bwrapExecutable = sandboxDependencies.find((entry) => entry.name === 'bwrap')?.executablePath ?? null;
  const socatExecutable = sandboxDependencies.find((entry) => entry.name === 'socat')?.executablePath ?? null;
  const sandboxProbe = missingSandboxDependencies.length === 0
    ? probeClaudeSandboxRuntime({ platform: process.platform, bwrapExecutable, socatExecutable, env })
    : null;
  const sandboxReady = missingSandboxDependencies.length === 0 && !sandboxPolicyError && (sandboxProbe?.ready ?? false);
  const sandboxFailureReason = sandboxPolicyError
    ? 'claude_sandbox_policy_invalid'
    : missingSandboxDependencies.length > 0
      ? 'claude_sandbox_unavailable'
      : sandboxProbe?.reason ?? 'claude_sandbox_unavailable';
  addCheck(checks, {
    id: 'claude.sandbox',
    title: 'Claude fail-closed sandbox prerequisites are available',
    status: sandboxReady ? 'ok' : 'failure',
    reason: sandboxReady ? 'claude_sandbox_ready' : sandboxFailureReason,
    summary: sandboxReady
      ? `Sandbox policy and dependencies are ready (${sandboxDependencyNames.join(', ')}); Symphony will require failIfUnavailable.`
      : sandboxPolicyError
        ? 'The generated Claude sandbox policy could not be materialized safely.'
        : missingSandboxDependencies.length > 0
          ? `Required sandbox dependency or dependencies were not found: ${missingSandboxDependencies.join(', ')}.`
          : 'The installed sandbox dependencies failed the capability canary.',
    remediation: sandboxReady ? undefined : 'Repair the reported sandbox policy or host dependency failure before starting claude-cli workers.',
    details: {
      dependencies: sandboxDependencies,
      missing: missingSandboxDependencies,
      policy: sandboxPolicyCounts,
      policyError: sandboxPolicyError,
      probe: sandboxProbe ? {
        reason: sandboxProbe.reason,
        stderrBytes: sandboxProbe.stderrBytes,
        stderrSha256: sandboxProbe.stderrSha256
      } : null,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      deniedDomains: ['localhost', '127.0.0.1', '::1'],
      allowLocalBinding: false
    }
  });

  addCheck(checks, {
    id: 'claude.network_policy',
    title: 'Claude network policy uses exact approved hosts',
    status: 'ok',
    reason: 'claude_network_policy_ready',
    summary: `Claude network access is restricted to ${runtime.claude_network_allowed_domains.length} exact host(s).`,
    details: { allowedDomains: runtime.claude_network_allowed_domains }
  });

  const requiredMcpServers = ['linear-server'];
  const userMcpConfiguration = inspectClaudeUserMcpConfiguration({
    home: env.HOME?.trim() || os.homedir(),
    workspace: projectRoot,
    allowedServers: runtime.claude_allowed_mcp_servers,
    requiredServers: requiredMcpServers
  });
  const mayProbeMcp = userMcpConfiguration.unsafe.length === 0;
  const requiredMcpResults = mayProbeMcp ? requiredMcpServers.map((name) => {
    const probe = spawnSync(executablePath, ['--setting-sources', 'user', 'mcp', 'get', name], {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
      shell: false,
      maxBuffer: 1024 * 1024,
      timeout: 10_000
    });
    return { name, ready: probe.status === 0 };
  }) : [];
  const missingMcp = requiredMcpResults.filter((entry) => !entry.ready).map((entry) => entry.name);
  const mcpReady =
    mayProbeMcp &&
    missingMcp.length === 0 &&
    userMcpConfiguration.unsafe.length === 0;
  addCheck(checks, {
    id: 'claude.mcp',
    title: 'Claude user-scoped MCP inventory is approved and isolated',
    status: mcpReady ? 'ok' : 'failure',
    reason: mcpReady
      ? 'claude_mcp_ready'
      : userMcpConfiguration.unsafe.length > 0
        ? 'claude_user_mcp_configuration_unsafe'
        : missingMcp.length > 0
        ? 'claude_required_mcp_missing_user_scope'
        : 'claude_required_mcp_missing_user_scope',
    summary: mcpReady
      ? `Required user-scoped MCP configuration is present; connection is verified only by the explicit live smoke.`
      : userMcpConfiguration.unsafe.length > 0
        ? `User-scoped MCP configuration is unsafe or incomplete: ${userMcpConfiguration.unsafe.join(', ')}.`
        : missingMcp.length > 0
        ? `Required user-scoped MCP server(s) are missing: ${missingMcp.join(', ')}.`
        : 'Required user-scoped MCP configuration is unavailable.',
    remediation: mcpReady
      ? undefined
      : 'Configure required servers with `claude mcp add --scope user ...` and disconnect unapproved user-scoped servers.',
    details: {
      allowed: runtime.claude_allowed_mcp_servers,
      connected: [],
      connectionStatus: 'verified_by_explicit_smoke_only',
      configuredUserServers: userMcpConfiguration.configuredUserServers,
      configurationHash: userMcpConfiguration.hash,
      configurationUnsafe: userMcpConfiguration.unsafe,
      missing: missingMcp,
      disconnectedRequired: [],
      unapprovedConnected: []
    }
  });

  const inheritedCredentialNames = Object.keys(env)
    .filter((name) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL)/i.test(name) && Boolean(env[name]?.trim()))
    .sort();
  addCheck(checks, {
    id: 'claude.inherited_credentials',
    title: 'Inherited credential names are inventoried',
    status: inheritedCredentialNames.length > 0 ? 'warning' : 'ok',
    reason: inheritedCredentialNames.length > 0 ? 'claude_inherited_credentials_present' : 'claude_inherited_credentials_absent',
    summary: inheritedCredentialNames.length > 0
      ? `${inheritedCredentialNames.length} credential-like environment variable name(s) are present; the runner strips unrelated values and LINEAR_API_KEY.`
      : 'No credential-like environment variable names were detected.',
    details: { names: inheritedCredentialNames }
  });

  let gitExecutable: string | null = null;
  try {
    gitExecutable = resolveTrustedExecutable('git', env, [projectRoot]);
  } catch {
    // The readiness finding below reports the missing trusted executable.
  }
  const gitRemote = inspectClaudeGitRemote(projectRoot, gitExecutable);
  const sshAgent = gitRemote.scheme === 'ssh' ? inspectClaudeSshAgent(env, [projectRoot]) : null;
  const sshCompatible =
    Boolean(gitExecutable) &&
    !gitRemote.hasCredentials &&
    gitRemote.scheme !== 'http' &&
    (gitRemote.scheme !== 'ssh' ||
      (process.platform !== 'linux' &&
        Boolean(gitRemote.host) &&
        runtime.claude_network_allowed_domains.includes(gitRemote.host!) &&
        sshAgent?.ready === true));
  let gitSummary = `SSH remote ${gitRemote.host ?? 'unknown'} requires an owned agent socket with at least one identity and a matching allowed network host.`;
  if (sshCompatible) {
    gitSummary = gitRemote.scheme === 'ssh'
      ? `SSH agent forwarding is available for approved host ${gitRemote.host}.`
      : 'The Git remote does not require SSH agent forwarding.';
  } else if (gitRemote.hasCredentials) {
    gitSummary = 'The Git origin embeds credentials; use a credential helper or SSH agent instead.';
  } else if (!gitExecutable) {
    gitSummary = 'No trusted Git executable is available outside the project root.';
  } else if (gitRemote.scheme === 'http') {
    gitSummary = 'The Git origin uses unencrypted HTTP; use HTTPS or an approved SSH route.';
  } else if (process.platform === 'linux' && gitRemote.scheme === 'ssh') {
    gitSummary = 'Linux Claude sandboxing cannot safely expose a single SSH agent socket; use an HTTPS origin.';
  }
  addCheck(checks, {
    id: 'claude.git_ssh',
    title: 'Git remote authentication is compatible with the sandbox',
    status: sshCompatible ? 'ok' : 'failure',
    reason: sshCompatible ? 'claude_git_auth_ready' : 'claude_git_ssh_unavailable',
    summary: gitSummary,
    details: {
      remoteScheme: gitRemote.scheme,
      remoteContainsUserInfo: gitRemote.hasCredentials,
      sshHost: gitRemote.scheme === 'ssh' ? gitRemote.host : null,
      sshAgentPresent: Boolean(env.SSH_AUTH_SOCK?.trim()),
      sshAgentReady: sshAgent?.ready ?? false,
      sshAgentReason: sshAgent?.reason ?? 'not_required'
    }
  });
  const githubHost = gitRemote.host && (gitRemote.host === 'github.com' || gitRemote.host.endsWith('.github.com'))
    ? gitRemote.host
    : null;
  let githubExecutable: string | null = null;
  if (githubHost) {
    try {
      githubExecutable = resolveTrustedExecutable('gh', env, [projectRoot]);
    } catch {
      // The readiness finding below reports the missing trusted executable.
    }
  }
  const githubAuth = githubHost && githubExecutable
    ? spawnSync(githubExecutable, ['auth', 'token', '--hostname', githubHost], {
        cwd: projectRoot,
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: env.HOME ?? os.homedir(),
          USER: env.USER,
          LOGNAME: env.LOGNAME
        },
        encoding: 'utf8',
        shell: false,
        timeout: 10_000,
        maxBuffer: 64 * 1024
      })
    : null;
  const githubAuthReady = !githubHost || (githubAuth?.status === 0 && Boolean(githubAuth.stdout.trim()));
  const githubAuthStatus = githubAuthReady ? 'ok' : 'failure';
  addCheck(checks, {
    id: 'claude.github_auth',
    title: 'GitHub CLI route is ready for the configured remote',
    status: githubAuthStatus,
    reason: !githubHost
      ? 'claude_github_auth_not_required'
      : githubAuthReady
        ? 'claude_github_auth_ready'
        : 'claude_github_auth_unavailable',
    summary: githubHost
      ? githubAuthReady
        ? `GitHub CLI can supply a scoped child capability for ${githubHost}.`
        : `GitHub CLI authentication is unavailable for ${githubHost}.`
      : 'The configured remote does not require a GitHub CLI authentication check.',
    remediation: githubAuthReady ? undefined : `Run \`gh auth login --hostname ${githubHost}\`, then rerun doctor and the explicit Claude smoke.`,
    details: {
      githubHost,
      gitExecutable,
      githubExecutable,
      exitStatus: githubAuth?.status ?? null,
      sandboxVerified: false
    }
  });

  const versionResult = spawnSync(executablePath, ['--version'], {
    env,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 1024 * 1024,
    timeout: 10_000
  });
  const version = `${versionResult.stdout ?? ''}\n${versionResult.stderr ?? ''}`.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
  const versionReady = versionResult.status === 0 && version === CLAUDE_SUPPORTED_VERSION;
  addCheck(checks, {
    id: 'claude.version',
    title: 'Claude CLI contract version is pinned',
    status: versionReady ? 'ok' : 'failure',
    reason: versionReady ? 'claude_version_supported' : 'claude_version_unsupported',
    summary: versionReady
      ? `Claude CLI ${version} matches the supported adapter contract.`
      : `Claude CLI version ${version ?? 'unknown'} does not match required ${CLAUDE_SUPPORTED_VERSION}.`,
    remediation: versionReady ? undefined : `Install Claude CLI ${CLAUDE_SUPPORTED_VERSION} and disable its auto-updater for Symphony runs.`,
    details: { expectedVersion: CLAUDE_SUPPORTED_VERSION, actualVersion: version, exitStatus: versionResult.status }
  });

  const selectors = [
    ...CLAUDE_NON_SUBSCRIPTION_ENV_NAMES.filter((name) => Boolean(env[name]?.trim())),
    ...userSettings.selectors
  ];
  const routingReady =
    !selectors.includes('invalid_user_settings') &&
    (runtime.claude_allow_non_subscription_auth || selectors.length === 0);
  addCheck(checks, {
    id: 'claude.credential_boundary',
    title: 'Claude credential route is approved',
    status: routingReady ? 'ok' : 'failure',
    reason: routingReady ? 'claude_credential_route_approved' : 'claude_non_subscription_route_forbidden',
    summary: routingReady
      ? runtime.claude_allow_non_subscription_auth
        ? 'Non-subscription Claude authentication is explicitly enabled.'
        : 'No API, gateway, or cloud-provider selector was detected.'
      : `Detected non-subscription Claude routing selector(s): ${selectors.join(', ')}.`,
    remediation: routingReady ? undefined : 'Remove the selectors or explicitly set SYMPHONY_CLAUDE_ALLOW_NON_SUBSCRIPTION_AUTH=true.',
    details: { selectors: [...new Set(selectors)], overrideEnabled: runtime.claude_allow_non_subscription_auth }
  });

  const authResult = spawnSync(executablePath, ['auth', 'status', '--json'], {
    env,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 1024 * 1024,
    timeout: 10_000
  });
  let auth: { loggedIn: boolean; authMethod: string | null; apiProvider: string | null; subscriptionType: string | null } = {
    loggedIn: false,
    authMethod: null,
    apiProvider: null,
    subscriptionType: null
  };
  try {
    const payload = workflowRecord(JSON.parse(authResult.stdout || '{}'));
    auth = {
      loggedIn: payload.loggedIn === true,
      authMethod: typeof payload.authMethod === 'string' ? payload.authMethod : null,
      apiProvider: typeof payload.apiProvider === 'string' ? payload.apiProvider : null,
      subscriptionType: typeof payload.subscriptionType === 'string' ? payload.subscriptionType : null
    };
  } catch {
    // The redacted default below becomes a blocking readiness finding.
  }
  const subscriptionReady =
    authResult.status === 0 &&
    auth.loggedIn &&
    (runtime.claude_allow_non_subscription_auth ||
      (auth.authMethod === 'claude.ai' &&
        auth.apiProvider === 'firstParty' &&
        ['team', 'enterprise'].includes(auth.subscriptionType ?? '')));
  addCheck(checks, {
    id: 'claude.auth',
    title: 'Claude authentication is ready',
    status: subscriptionReady ? 'ok' : 'failure',
    reason: subscriptionReady ? 'claude_auth_ready' : 'claude_subscription_auth_required',
    summary: subscriptionReady
      ? 'Claude authentication matches the configured route policy.'
      : 'Claude authentication is missing or does not match the required Team/Enterprise subscription route.',
    remediation: subscriptionReady ? undefined : 'Run `claude auth login`, then verify Team/Enterprise first-party authentication with `symphony doctor`.',
    details: auth
  });
}

async function linearSmokeMarkerControl(params: {
  effectiveConfig: EffectiveConfig;
  issueIdentifier: string;
  marker: string;
  remove: boolean;
}): Promise<{ before: number; after: number; removed: number; error: string | null }> {
  if (params.effectiveConfig.tracker.kind !== 'linear') {
    return { before: 0, after: 0, removed: 0, error: 'claude_smoke_requires_linear_tracker_control_plane' };
  }
  const request = async (query: string, variables: Record<string, unknown>) => {
    const response = await fetch(params.effectiveConfig.tracker.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: params.effectiveConfig.tracker.api_key
      },
      body: JSON.stringify({ query, variables })
    });
    if (!response.ok) throw new Error(`linear_http_${response.status}`);
    const payload = workflowRecord(await response.json());
    if (Array.isArray(payload.errors) && payload.errors.length > 0) throw new Error('linear_graphql_error');
    return workflowRecord(payload.data);
  };
  const list = async () => {
    const data = await request(
      'query SymphonyClaudeSmokeIssue($id: String!) { issue(id: $id) { comments { nodes { id body } } } }',
      { id: params.issueIdentifier }
    );
    const issue = workflowRecord(data.issue);
    const comments = workflowRecord(issue.comments);
    return (Array.isArray(comments.nodes) ? comments.nodes : [])
      .map((value) => workflowRecord(value))
      .filter((comment) => typeof comment.id === 'string' && comment.body === params.marker)
      .map((comment) => String(comment.id));
  };
  try {
    const beforeIds = await list();
    let removed = 0;
    if (params.remove) {
      for (const id of beforeIds) {
        const data = await request(
          'mutation SymphonyClaudeSmokeCommentDelete($id: String!) { commentDelete(id: $id) { success } }',
          { id }
        );
        if (workflowRecord(data.commentDelete).success === true) removed += 1;
      }
    }
    const afterIds = await list();
    return { before: beforeIds.length, after: afterIds.length, removed, error: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { before: 0, after: 0, removed: 0, error: detail.replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 160) };
  }
}

async function addClaudeSmokeCheck(params: {
  checks: DoctorFinding[];
  effectiveConfig: EffectiveConfig;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
  linearIssue: string;
}): Promise<void> {
  const blockingReadiness = params.checks.filter(
    (check) => check.id.startsWith('claude.') && check.status === 'failure'
  );
  if (blockingReadiness.length > 0) {
    addCheck(params.checks, {
      id: 'claude.smoke',
      title: 'Claude sandbox, GitHub, and Linear MCP live smoke',
      status: 'failure',
      reason: 'claude_smoke_readiness_blocked',
      summary: `Live smoke was not started because ${blockingReadiness.length} Claude readiness check(s) failed.`,
      remediation: 'Resolve every Claude readiness blocker, then rerun the explicit smoke command.',
      details: { blockingChecks: blockingReadiness.map((check) => check.id), modelQuotaConsumed: false }
    });
    return;
  }

  const runtime = params.effectiveConfig.agent_runtime;
  if (!runtime || runtime.selected !== 'claude-cli' || !runtime.claude_model) {
    addCheck(params.checks, {
      id: 'claude.smoke',
      title: 'Claude sandbox, GitHub, and Linear MCP live smoke',
      status: 'failure',
      reason: 'claude_smoke_runtime_not_selected',
      summary: 'Live smoke requires a resolved claude-cli runtime and pinned model.',
      details: { modelQuotaConsumed: false }
    });
    return;
  }
  let gitExecutable: string;
  try {
    gitExecutable = resolveTrustedExecutable('git', params.env, [params.projectRoot]);
  } catch {
    addCheck(params.checks, {
      id: 'claude.smoke',
      title: 'Claude sandbox, GitHub, and Linear MCP live smoke',
      status: 'failure',
      reason: 'claude_smoke_git_unavailable',
      summary: 'Live smoke requires a trusted Git executable outside the project root.',
      details: { modelQuotaConsumed: false }
    });
    return;
  }
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-claude-smoke-'));
  const smokeWorkspace = path.join(smokeRoot, 'workspace');
  const worktree = spawnSync(gitExecutable, ['clone', '--no-hardlinks', params.projectRoot, smokeWorkspace], {
    cwd: params.projectRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
  if (worktree.status !== 0) {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
    addCheck(params.checks, {
      id: 'claude.smoke',
      title: 'Claude sandbox and Linear MCP live smoke',
      status: 'failure',
      reason: 'claude_smoke_disposable_worktree_failed',
      summary: 'Live smoke could not create its disposable detached worktree.',
      details: { modelQuotaConsumed: false }
    });
    return;
  }
  const parentOrigin = spawnSync(gitExecutable, ['config', '--file', path.join(params.projectRoot, '.git', 'config'), '--get', 'remote.origin.url'], {
    cwd: params.projectRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    maxBuffer: 64 * 1024
  });
  const setSmokeOrigin = parentOrigin.status === 0
    ? spawnSync(gitExecutable, ['remote', 'set-url', 'origin', parentOrigin.stdout.trim()], {
        cwd: smokeWorkspace,
        encoding: 'utf8',
        shell: false,
        timeout: 10_000,
        maxBuffer: 64 * 1024
      })
    : null;
  if (!setSmokeOrigin || setSmokeOrigin.status !== 0) {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
    addCheck(params.checks, {
      id: 'claude.smoke',
      title: 'Claude sandbox, GitHub, and Linear MCP live smoke',
      status: 'failure',
      reason: 'claude_smoke_origin_setup_failed',
      summary: 'Live smoke could not bind its disposable clone to the canonical origin.',
      details: { modelQuotaConsumed: false }
    });
    return;
  }
  const smokeEnv = { ...params.env, PWD: smokeRoot };
  const runner = new ClaudeCliRunner({
    command: runtime.claude_command,
    model: runtime.claude_model,
    projectRoot: smokeRoot,
    allowNonSubscriptionAuth: runtime.claude_allow_non_subscription_auth,
    networkAllowedDomains: runtime.claude_network_allowed_domains,
    allowedMcpServers: runtime.claude_allowed_mcp_servers,
    requiredMcpServers: ['linear-server'],
    supportedVersion: runtime.claude_supported_version,
    gitCommand: gitExecutable,
    env: smokeEnv
  });
  const marker = `symphony-claude-smoke-${crypto.randomUUID()}`;
  const gitMarkerFile = `.symphony-smoke-${crypto.randomUUID()}.txt`;
  const gitMarkerContent = `SYMPHONY_GIT_SMOKE:${marker}`;
  const gitMarkerSubject = `test: ${marker}`;
  let result: Awaited<ReturnType<ClaudeCliRunner['startSessionAndRunTurn']>> | null = null;
  let cleanupResult: Awaited<ReturnType<ClaudeCliRunner['startSessionAndRunTurn']>> | null = null;
  let markerControl = { before: 0, after: 0, removed: 0, error: null as string | null };
  let cleanupMarkerReadback = { before: 0, after: 0, removed: 0, error: null as string | null };
  let finalMarkerCleanup = { before: 0, after: 0, removed: 0, error: null as string | null };
  let invocationError: string | null = null;
  let worktreeRemovalStatus: number | null = null;
  let gitSmokeVerified = false;
  try {
    result = await runner.startSessionAndRunTurn({
      command: 'unused',
      commandArgs: [],
      workspaceCwd: smokeWorkspace,
      prompt: [
        `Use only the user-scoped Linear MCP tools to read issue ${params.linearIssue}.`,
        `Add a temporary comment whose complete body is exactly ${marker}, read the issue again to verify it exists, and leave it for the supervising smoke to remove.`,
        'Run `git remote get-url origin` and `gh repo view --json nameWithOwner`; both commands must succeed without revealing credentials.',
        `Create ${gitMarkerFile} containing exactly ${gitMarkerContent}, commit it with subject ${JSON.stringify(gitMarkerSubject)}, and run a dry-run push of HEAD to origin branch refs/heads/${marker}.`,
        'Run `npm --version` and `npm view npm version` to verify the package-manager executable and approved registry route.',
        'If comment creation, Git remote access, or GitHub CLI authentication cannot be verified, return an error.',
        'Do not use curl, raw Linear HTTP, environment credentials, or another Claude process.',
        `Only after all checks succeed, end with the exact marker SYMPHONY_SMOKE_OK:${marker}.`
      ].join(' '),
      title: `Claude readiness smoke ${params.linearIssue}`,
      maxTurns: 1,
      approvalPolicy: 'never',
      threadSandbox: 'workspace-write',
      readTimeoutMs: params.effectiveConfig.codex.read_timeout_ms,
      turnTimeoutMs: params.effectiveConfig.codex.turn_timeout_ms,
      runBinding: {
        project_identity: smokeWorkspace,
        issue_id: params.linearIssue,
        issue_identifier: params.linearIssue,
        attempt: 0
      }
    });
    const committedSubject = spawnSync(gitExecutable, ['log', '-1', '--pretty=%s'], {
      cwd: smokeWorkspace, encoding: 'utf8', shell: false, timeout: 10_000, maxBuffer: 64 * 1024
    });
    gitSmokeVerified =
      committedSubject.status === 0 &&
      committedSubject.stdout.trim() === gitMarkerSubject &&
      fs.existsSync(path.join(smokeWorkspace, gitMarkerFile)) &&
      fs.readFileSync(path.join(smokeWorkspace, gitMarkerFile), 'utf8').trim() === gitMarkerContent;
    markerControl = await linearSmokeMarkerControl({
      effectiveConfig: params.effectiveConfig,
      issueIdentifier: params.linearIssue,
      marker,
      remove: true
    });
    if (!result.session_id) throw new Error('claude_smoke_session_missing');
    cleanupResult = await runner.resumeSessionAndRunTurn({
      command: 'unused',
      commandArgs: [],
      workspaceCwd: smokeWorkspace,
      prompt: [
        `Recall the exact temporary marker from the previous turn, then use the user-scoped Linear MCP to read issue ${params.linearIssue} and verify no comment contains it.`,
        `Do not write anything. If the marker is absent, end with the exact marker SYMPHONY_SMOKE_CLEAN:${marker}.`
      ].join(' '),
      title: `Claude readiness cleanup verification ${params.linearIssue}`,
      maxTurns: 1,
      approvalPolicy: 'never',
      threadSandbox: 'workspace-write',
      readTimeoutMs: params.effectiveConfig.codex.read_timeout_ms,
      turnTimeoutMs: params.effectiveConfig.codex.turn_timeout_ms,
      runBinding: {
        project_identity: smokeWorkspace,
        issue_id: params.linearIssue,
        issue_identifier: params.linearIssue,
        attempt: 0
      },
      previousSessionId: result.session_id
    });
    cleanupMarkerReadback = await linearSmokeMarkerControl({
      effectiveConfig: params.effectiveConfig,
      issueIdentifier: params.linearIssue,
      marker,
      remove: false
    });
  } catch (error) {
    invocationError = (error instanceof Error ? error.message : String(error))
      .replace(/[^a-zA-Z0-9_.:-]+/g, '_')
      .slice(0, 160);
  } finally {
    finalMarkerCleanup = await linearSmokeMarkerControl({
      effectiveConfig: params.effectiveConfig,
      issueIdentifier: params.linearIssue,
      marker,
      remove: true
    });
    try {
      fs.rmSync(smokeRoot, { recursive: true, force: true });
      worktreeRemovalStatus = fs.existsSync(smokeRoot) ? 1 : 0;
    } catch {
      worktreeRemovalStatus = 1;
    }
  }
  if (!result) {
    addCheck(params.checks, {
      id: 'claude.smoke',
      title: 'Claude sandbox, GitHub, and Linear MCP live smoke',
      status: 'failure',
      reason: 'claude_smoke_runner_failed',
      summary: 'Claude smoke could not complete its supervised runtime invocation.',
      remediation: 'Inspect the sanitized runner failure and readiness checks, then rerun against the dedicated test issue.',
      details: {
        issueIdentifier: params.linearIssue,
        invocationError,
        markerControl,
        worktreeRemovalStatus,
        modelQuotaConsumed: true
      }
    });
    return;
  }
  const linearToolCalls = result.provider_usage?.mcp_counts?.['linear-server'] ?? 0;
  const cleanupLinearToolCalls = cleanupResult?.provider_usage?.mcp_counts?.['linear-server'] ?? 0;
  const bashToolCalls = result.provider_usage?.tool_counts?.Bash ?? 0;
  const observedToolNames = Object.keys(result.provider_usage?.tool_counts ?? {});
  const linearCreateObserved = observedToolNames.some((name) => /linear-server.*(?:create|comment)/i.test(name));
  const linearReadObserved = observedToolNames.some((name) => /linear-server.*(?:get|read|issue|comment)/i.test(name));
  const ready =
    result.status === 'completed' &&
    cleanupResult?.status === 'completed' &&
    cleanupResult.session_id === result.session_id &&
    gitSmokeVerified &&
    linearCreateObserved &&
    linearReadObserved &&
    markerControl.before === 1 &&
    markerControl.removed === 1 &&
    markerControl.after === 0 &&
    markerControl.error === null &&
    cleanupMarkerReadback.before === 0 &&
    cleanupMarkerReadback.after === 0 &&
    cleanupMarkerReadback.error === null &&
    finalMarkerCleanup.after === 0 &&
    finalMarkerCleanup.error === null &&
    worktreeRemovalStatus === 0 &&
    result.last_agent_message?.includes(`SYMPHONY_SMOKE_OK:${marker}`) === true &&
    cleanupResult.last_agent_message?.includes(`SYMPHONY_SMOKE_CLEAN:${marker}`) === true;
  addCheck(params.checks, {
    id: 'claude.smoke',
    title: 'Claude sandbox, GitHub, and Linear MCP live smoke',
    status: ready ? 'ok' : 'failure',
    reason: ready ? 'claude_smoke_ready' : 'claude_smoke_failed',
    summary: ready
      ? `Claude completed the supervised sandbox, GitHub, and Linear read/write/cleanup smoke for ${params.linearIssue}.`
      : `Claude smoke failed with ${result.error_code ?? cleanupResult?.error_code ?? cleanupResult?.status ?? result.status}; observed ${linearToolCalls} Linear MCP tool call(s).`,
    remediation: ready ? undefined : 'Inspect the Claude runner result and MCP scope, then rerun against the dedicated test issue.',
    details: {
      issueIdentifier: params.linearIssue,
      runtime: result.runtime,
      status: result.status,
      errorCode: result.error_code ?? null,
      sessionId: result.session_id,
      linearToolCalls,
      cleanupLinearToolCalls,
      bashToolCalls,
      gitSmokeVerified,
      observedToolNames,
      linearCreateObserved,
      linearReadObserved,
      markerControl,
      cleanupMarkerReadback,
      finalMarkerCleanup,
      worktreeRemovalStatus,
      cleanupStatus: cleanupResult?.status ?? 'not_run',
      cleanupErrorCode: cleanupResult?.error_code ?? null,
      cleanupErrorDetail: cleanupResult?.error_detail ?? null,
      invocationError,
      providerUsageStatus: result.provider_usage?.status ?? 'unobserved',
      modelQuotaConsumed: true
    }
  });
}

function addTrackerCredentialCheck(checks: DoctorFinding[], effectiveConfig: EffectiveConfig): void {
  const tracker = effectiveConfig.tracker;
  if (tracker.kind === 'memory') {
    addCheck(checks, {
      id: 'tracker.credentials',
      title: 'Tracker credentials are ready',
      status: 'ok',
      reason: 'tracker_credentials_not_required',
      summary: 'Memory tracker mode does not require external tracker credentials.',
      details: { trackerKind: tracker.kind, required: false, present: true }
    });
    return;
  }

  const present = tracker.api_key.trim().length > 0;
  addCheck(checks, {
    id: 'tracker.credentials',
    title: 'Tracker credentials are ready',
    status: present ? 'ok' : 'failure',
    reason: present ? `${tracker.kind}_tracker_credentials_present` : `${tracker.kind}_tracker_credentials_missing`,
    summary: present
      ? `${tracker.kind} tracker credentials are present after environment resolution.`
      : `${tracker.kind} tracker credentials are missing after environment resolution.`,
    remediation: present ? undefined : `Set ${tracker.kind === 'linear' ? 'LINEAR_API_KEY' : 'GITHUB_TOKEN'} or tracker.api_key before starting Symphony.`,
    details: {
      trackerKind: tracker.kind,
      required: true,
      present
    }
  });
}

function addHookCommandReadinessCheck(checks: DoctorFinding[], effectiveConfig: EffectiveConfig, env: NodeJS.ProcessEnv): void {
  const hooks = [
    ['after_create', effectiveConfig.hooks.after_create],
    ['before_run', effectiveConfig.hooks.before_run],
    ['after_run', effectiveConfig.hooks.after_run],
    ['before_remove', effectiveConfig.hooks.before_remove]
  ]
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(([name, command]) => ({
      name,
      configured: true,
      commandPreview: command.split(/\r?\n/)[0].trim().slice(0, 120)
    }));
  const bashPath = findCommandOnPath('bash', env);
  const shellReady = Boolean(bashPath);

  addCheck(checks, {
    id: 'hooks.commands',
    title: 'Workspace hook command runner is ready',
    status: hooks.length === 0 ? 'ok' : shellReady ? 'ok' : 'failure',
    reason: shellReady
      ? hooks.length > 0
        ? 'hook_shell_ready'
        : 'no_hooks_configured'
      : hooks.length > 0
        ? 'hook_shell_missing'
        : 'no_hooks_configured',
    summary:
      hooks.length > 0
        ? shellReady
          ? `Found bash for ${hooks.length} configured workspace hook(s); hooks are reported but not executed by doctor.`
          : 'Workspace hooks are configured, but bash is not available for the runtime hook runner.'
        : shellReady
          ? 'No workspace hooks are configured.'
          : 'No workspace hooks are configured; bash was not found for future hook execution.',
    remediation:
      !shellReady && hooks.length > 0
        ? 'Install bash or adjust the runtime hook runner environment before provisioning workspaces.'
        : undefined,
    details: {
      bashPath,
      timeoutMs: effectiveConfig.hooks.timeout_ms,
      hooks,
      executed: false,
      guarantee: 'doctor verifies the hook shell is available and reports configured commands; it does not guarantee runtime hook success'
    }
  });
}

function renderHuman(result: DoctorJsonResult): string {
  const lines = [
    `Symphony doctor: ${result.status}`,
    `Reason: ${result.reason}`,
    `Exit code: ${result.exitCode}`,
    '',
    'Resolved context:',
    `  cwd: ${result.cwd}`,
    `  symphony checkout: ${result.symphonyCheckoutRoot}`,
    `  project root: ${result.resolution.projectRoot ?? '(unresolved)'}`,
    `  workflow: ${result.resolution.workflowPath ?? '(unresolved)'}`,
    `  env file: ${result.resolution.envFilePath ?? '(unresolved)'}`,
    `  profile: ${result.resolution.profile ?? '(unresolved)'}`,
    `  host: ${result.resolution.host ?? '(unresolved)'}`,
    `  port: ${
      result.resolution.port === null
        ? '(unresolved)'
        : `${result.resolution.port}${result.resolution.ephemeralPort ? ' (ephemeral)' : ''}`
    }`,
    `  consent: ${result.resolution.consent ?? '(unresolved)'}`,
    '',
    'Checks:'
  ];

  for (const check of result.findings) {
    lines.push(`  [${check.status}] ${check.title}: ${check.summary}`);
    if (check.remediation) {
      lines.push(`    next: ${check.remediation}`);
    }
  }

  if (result.fixes.length > 0) {
    lines.push('', 'Fix actions:');
    for (const fix of result.fixes) {
      lines.push(`  [${fix.status}] ${fix.id}: ${fix.summary}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function runLocalDoctor(options: RunLocalDoctorOptions): Promise<{
  result: DoctorJsonResult;
  human: string;
}> {
  const parsed = parseDoctorArgs(options.argv);
  const checks: DoctorFinding[] = [];
  const fixes: DoctorFixAction[] = [];
  const deps = options.deps;
  let resolved: LocalCommandResolution | null = null;
  let consentSource: SetupConsentSource | null = null;
  let layout: ProjectLayoutInspection | null = null;

  if ('error' in parsed) {
    addCheck(checks, {
      id: 'doctor.options',
      title: 'Doctor options parse',
      status: 'failure',
      reason: 'invalid_doctor_option',
      summary: parsed.error,
      remediation: 'Run `symphony doctor --help` for supported options.'
    });
  }

  const args = 'error' in parsed
    ? { json: false, ci: false, fix: false, yes: false, claudeSmoke: false, linearIssue: null, resolverArgv: [] }
    : parsed;
  const executablePath = findExecutableOnPath(deps.env);
  let shim: ShimMetadata | null = null;

  if (!executablePath) {
    addCheck(checks, {
      id: 'executable.discoverable',
      title: 'Local symphony executable is discoverable on PATH',
      status: 'failure',
      reason: 'path_missing',
      summary: '`symphony` was not found on PATH.',
      remediation: 'Run `npm run link:local` from the Symphony checkout, then ensure the linked bin directory is on PATH.'
    });
  } else {
    shim = parseShimMetadata(executablePath);
    if (!shim.owned) {
      addCheck(checks, {
        id: 'executable.discoverable',
        title: 'Local symphony executable is discoverable on PATH',
        status: 'failure',
        reason: 'link_unverifiable',
        summary: `Found ${executablePath}, but it is not a Symphony local shim.`,
        remediation: 'Run `npm run link:local` from the expected Symphony checkout or choose a PATH entry that points at the local shim.',
        details: { executablePath, verificationError: shim.verificationError }
      });
    } else if (shim.repoRoot && path.resolve(shim.repoRoot) !== path.resolve(deps.repoRoot)) {
      addCheck(checks, {
        id: 'executable.checkout',
        title: 'Local symphony executable points at this checkout',
        status: 'failure',
        reason: 'checkout_mismatch',
        summary: `PATH shim points at ${shim.repoRoot}, expected ${deps.repoRoot}.`,
        remediation: 'Refresh the local shim from this checkout with `npm run link:local`.',
        details: { executablePath, shimRepoRoot: shim.repoRoot, expectedRepoRoot: deps.repoRoot }
      });
    } else {
      addCheck(checks, {
        id: 'executable.checkout',
        title: 'Local symphony executable points at this checkout',
        status: 'ok',
        reason: 'checkout_match',
        summary: `PATH shim points at ${shim.repoRoot ?? deps.repoRoot}.`,
        details: { executablePath, shimRepoRoot: shim.repoRoot, shimEntrypoint: shim.entrypoint }
      });
    }
  }

  const shimRepoRoot = shim?.repoRoot ?? deps.repoRoot;
  addCheck(checks, checkCheckoutEntrypoint(shimRepoRoot, 'shim_checkout'));

  if (
    args.fix &&
    checks.some(
      (check) =>
        check.status !== 'ok' &&
        (check.id.startsWith('executable.') || check.reason === 'build_missing' || check.reason === 'checkout_missing')
    )
  ) {
    if (args.ci) {
      addFix(fixes, {
        id: 'link-local',
        status: 'skipped',
        summary: 'Link-local remediation was not run because `--ci` forbids doctor fix mutations.'
      });
    } else {
      const exitCode = await deps.runLinkLocal([]);
      addFix(fixes, {
        id: 'link-local',
        status: exitCode === 0 ? 'applied' : 'failed',
        summary:
          exitCode === 0
            ? 'Invoked `symphony link-local` remediation. Rerun doctor to verify PATH and shim state.'
            : `Link-local remediation failed with exit ${exitCode}.`,
        details: { exitCode }
      });
    }
  }

  try {
    resolved = deps.resolveLocalCommand({
      command: 'doctor',
      argv: args.resolverArgv,
      cwd: deps.cwd,
      env: deps.env,
      symphonyCheckoutRoot: deps.repoRoot
    });
    addCheck(checks, {
      id: 'resolver.workflow',
      title: 'Project workflow resolves',
      status: 'ok',
      reason: 'workflow_resolved',
      summary: `Resolved workflow ${resolved.workflowPath}.`,
      details: {
        projectRoot: resolved.currentProjectRoot,
        workflowPath: resolved.workflowPath,
        workflowSource: resolved.sources.workflowPath
      }
    });
    const dashboardEnv = {
      ...readEnvFileValues(resolved.envFilePath),
      ...deps.env
    };
    const workflowValidation = validateWorkflow(resolved, dashboardEnv);
    addCheck(checks, workflowValidation.check);
    if (workflowValidation.envCheck) {
      addCheck(checks, workflowValidation.envCheck);
    }
    if (workflowValidation.effectiveConfig) {
      addTrackerCredentialCheck(checks, workflowValidation.effectiveConfig);
      addHookCommandReadinessCheck(checks, workflowValidation.effectiveConfig, dashboardEnv);
      if (workflowValidation.configValid) {
        if (workflowValidation.effectiveConfig.agent_runtime?.selected === 'claude-cli') {
          addClaudeRuntimeChecks(checks, workflowValidation.effectiveConfig, dashboardEnv, resolved.currentProjectRoot);
          if (args.claudeSmoke && args.linearIssue) {
            await addClaudeSmokeCheck({
              checks,
              effectiveConfig: workflowValidation.effectiveConfig,
              env: dashboardEnv,
              projectRoot: resolved.currentProjectRoot,
              linearIssue: args.linearIssue
            });
          }
        } else {
          addCodexCommandCheck(checks, workflowValidation.effectiveConfig, dashboardEnv);
        }
        await addReviewApprovalCheck(
          checks,
          workflowValidation.effectiveConfig,
          dashboardEnv,
          resolved.currentProjectRoot
        );
        addWorkspaceChecks(checks, resolved, workflowValidation.effectiveConfig);
        addManagedWorkspaceSensitiveFileCheck({
          checks,
          fixes,
          effectiveConfig: workflowValidation.effectiveConfig,
          projectRoot: resolved.currentProjectRoot,
          fix: args.fix,
          yes: args.yes,
          ci: args.ci,
          now: deps.clock()
        });
        addHistoryReconciliationCheck({
          checks,
          fixes,
          effectiveConfig: workflowValidation.effectiveConfig,
          projectRoot: resolved.currentProjectRoot,
          fix: args.fix,
          yes: args.yes,
          ci: args.ci
        });
      }
    }
    addCheck(checks, {
      id: 'env.path',
      title: 'Project env file path resolved',
      status: 'ok',
      reason: 'env_path_resolved',
      summary: `Would load ${resolved.envFilePath}.`,
      remediation: fs.existsSync(resolved.envFilePath)
        ? undefined
        : 'Create this .env file if the workflow requires local environment variables; doctor does not print secret values.',
      details: {
        envFilePath: resolved.envFilePath,
        source: resolved.sources.envFilePath,
        exists: fs.existsSync(resolved.envFilePath)
      }
    });
    if (process.platform !== 'win32' && fs.existsSync(resolved.envFilePath)) {
      let mode = fs.statSync(resolved.envFilePath).mode & 0o777;
      if (mode !== 0o600 && args.fix) {
        if (args.ci) {
          addFix(fixes, {
            id: 'env-permissions',
            status: 'skipped',
            summary: 'Project .env permissions were not changed because `--ci` forbids doctor fix mutations.'
          });
        } else if (!args.yes) {
          addFix(fixes, {
            id: 'env-permissions',
            status: 'skipped',
            summary: 'Project .env permissions were not changed because `--yes` was not provided.'
          });
        } else {
          try {
            fs.chmodSync(resolved.envFilePath, 0o600);
            mode = fs.statSync(resolved.envFilePath).mode & 0o777;
            addFix(fixes, {
              id: 'env-permissions',
              status: mode === 0o600 ? 'applied' : 'failed',
              summary: mode === 0o600 ? 'Changed project .env permissions to 0600.' : 'Project .env permissions did not become 0600.'
            });
          } catch (error) {
            addFix(fixes, {
              id: 'env-permissions',
              status: 'failed',
              summary: `Could not change project .env permissions: ${error instanceof Error ? error.message : String(error)}`
            });
          }
        }
      }
      const permissionReady = mode === 0o600;
      addCheck(checks, {
        id: 'env.permissions',
        title: 'Project env file permissions are private',
        status: permissionReady ? 'ok' : 'failure',
        reason: permissionReady ? 'env_permissions_private' : 'env_permissions_insecure',
        summary: permissionReady ? 'Project .env permissions are 0600.' : `Project .env permissions are ${mode.toString(8).padStart(4, '0')}; required mode is 0600.`,
        remediation: permissionReady ? undefined : 'Run `symphony doctor --fix --yes` or `chmod 600 .env`.',
        safeFix: safeFixForFinding(
          { id: 'env.permissions', status: permissionReady ? 'ok' : 'failure' },
          { projectRoot: resolved.currentProjectRoot }
        ),
        details: { mode: mode.toString(8).padStart(4, '0'), requiredMode: '0600' }
      });
    }

    layout = inspectProjectLayout(resolved.currentProjectRoot);
    if (args.fix && args.ci && !layout.ignoreAnalysis.hasNarrowSystemIgnore) {
      addFix(fixes, {
        id: 'layout.gitignore-system',
        status: 'skipped',
        summary: 'Runtime-state gitignore entry was not added because `--ci` forbids doctor fix mutations.'
      });
    } else if (args.fix && args.yes && !layout.ignoreAnalysis.hasNarrowSystemIgnore) {
      const fix = ensureSystemGitignoreEntry(resolved.currentProjectRoot);
      addFix(fixes, {
        id: 'layout.gitignore-system',
        status: fix.status,
        summary: fix.summary,
        details: fix.details
      });
      layout = inspectProjectLayout(resolved.currentProjectRoot);
    } else if (args.fix && !layout.ignoreAnalysis.hasNarrowSystemIgnore) {
      addFix(fixes, {
        id: 'layout.gitignore-system',
        status: 'skipped',
        summary: 'Runtime-state gitignore entry was not added because `--yes` was not provided.'
      });
    }
    addLayoutChecks(checks, layout);
    let workflowConfig: Record<string, unknown> = {};
    try {
      workflowConfig = new WorkflowLoader().load({ explicitPath: resolved.workflowPath }).config;
    } catch {
      workflowConfig = {};
    }
    const customizationMetadata = readWorkflowCustomizationMetadata(resolved.workflowPath, workflowConfig);
    addCustomizationChecks(checks, resolved, customizationMetadata);
    const portableSkillSelection = selectedPortableSkillsFromMetadata(customizationMetadata);
    addProjectLocalSkillMaterializationChecks(
      checks,
      resolved.currentProjectRoot,
      portableSkillSelection.selectedSkills,
      portableSkillSelection.unknown
    );
    addProjectLocalSkillPrerequisiteChecks(
      checks,
      portableSkillSelection.selectedSkills,
      dashboardEnv,
      resolved.envFilePath
    );
    if (
      workflowValidation.effectiveConfig &&
      workflowValidation.effectiveConfig.agent_runtime?.selected !== 'claude-cli'
    ) {
      addCheck(
        checks,
        await probeCodexSkillDiscovery({
          command: workflowValidation.effectiveConfig.codex.command,
          env: dashboardEnv,
          projectRoot: resolved.currentProjectRoot,
          selectedSkills: portableSkillSelection.selectedSkills,
          unknown: portableSkillSelection.unknown
        })
      );
    }

    const portAvailable = await canListen(resolved.host.host, resolved.port.port);
    addCheck(checks, {
      id: 'server.port',
      title: 'Dashboard host and port are available',
      status: portAvailable ? 'ok' : 'failure',
      reason: resolved.port.port === 0 ? 'ephemeral_port' : portAvailable ? 'fixed_port_available' : 'port_unavailable',
      summary:
        resolved.port.port === 0
          ? `Dashboard will request an ephemeral port on ${resolved.host.host}.`
          : portAvailable
            ? `Dashboard can bind ${resolved.host.host}:${resolved.port.port}.`
            : `Dashboard cannot bind ${resolved.host.host}:${resolved.port.port}.`,
      remediation: portAvailable ? undefined : 'Choose a different port with `--port <number>` or stop the process using that port.',
      details: { host: resolved.host.host, port: resolved.port.port, source: resolved.port.source }
    });

    const posture = deps.resolveWorkflowPosture(resolved.workflowPath, dashboardEnv);
    consentSource = args.resolverArgv.includes('--i-understand-that-this-will-be-running-without-the-usual-guardrails')
      ? 'flag'
      : 'missing';
    const setupConsentStoreInProject = isWithinPath(resolved.currentProjectRoot, deps.setupConsentStore.path);
    if (consentSource === 'missing' && !setupConsentStoreInProject) {
      const consent = findValidSetupConsent({ store: deps.setupConsentStore, resolved, posture });
      consentSource = consent ? 'setup' : 'missing';
    }
    if (consentSource === 'missing' && args.fix && args.ci) {
      addFix(fixes, {
        id: 'setup-consent',
        status: 'skipped',
        summary: 'Setup consent was not recorded because `--ci` forbids doctor fix mutations.'
      });
    } else if (consentSource === 'missing' && args.fix && args.yes) {
      if (setupConsentStoreInProject) {
        addFix(fixes, {
          id: 'setup-consent',
          status: 'failed',
          summary:
            'Refused to record setup consent because the configured local state path is inside the project checkout.',
          details: { storeLocation: 'project_checkout' }
        });
      } else {
        const record = buildSetupConsentRecord({
          resolved,
          posture,
          approvedAt: deps.clock().toISOString()
        });
        persistSetupConsent(deps.setupConsentStore, record);
        consentSource = 'setup';
        addFix(fixes, {
          id: 'setup-consent',
          status: 'applied',
          summary: `Recorded explicit setup consent for identity ${record.identity_key}.`
        });
      }
    } else if (consentSource === 'missing' && args.fix) {
      addFix(fixes, {
        id: 'setup-consent',
        status: 'skipped',
        summary: 'Setup consent was not recorded because `--yes` was not provided.'
      });
    }
    addCheck(checks, {
      id: 'setup.consent',
      title: 'High-trust setup consent is available',
      status: consentSource === 'missing' ? 'failure' : 'ok',
      reason: consentSource === 'missing' ? 'setup_consent_missing' : `setup_consent_${consentSource}`,
      summary:
        consentSource === 'missing'
          ? `No user-local setup consent exists for required posture ${posture.posture}.`
          : `Setup consent source is ${consentSource} for required posture ${posture.posture}.`,
      remediation:
        consentSource === 'missing'
          ? setupConsentStoreInProject
            ? 'Choose a user-local Symphony state path outside the project checkout, then rerun `symphony setup --yes` or `symphony doctor --fix --yes`.'
            : 'Run `symphony setup --yes` for this project/workflow, or rerun doctor with `--fix --yes` to record explicit local consent.'
          : undefined,
      safeFix: safeFixForFinding(
        { id: 'setup.consent', status: consentSource === 'missing' ? 'failure' : 'ok' },
        { setupConsentStorePath: deps.setupConsentStore.path }
      ),
      details: { posture: posture.posture, reason: posture.reason, evidence: posture.evidence }
    });
    addCheck(checks, {
      id: 'dashboard.prerequisites',
      title: 'Dashboard supervisor prerequisites are present',
      status: fs.existsSync(path.join(deps.repoRoot, 'scripts', 'start-dashboard-supervisor.js')) ? 'ok' : 'failure',
      reason: fs.existsSync(path.join(deps.repoRoot, 'scripts', 'start-dashboard-supervisor.js'))
        ? 'dashboard_supervisor_ready'
        : 'dashboard_supervisor_missing',
      summary: fs.existsSync(path.join(deps.repoRoot, 'scripts', 'start-dashboard-supervisor.js'))
        ? 'Dashboard supervisor script is present.'
        : 'Dashboard supervisor script is missing.',
      remediation: fs.existsSync(path.join(deps.repoRoot, 'scripts', 'start-dashboard-supervisor.js'))
        ? undefined
        : 'Refresh the Symphony checkout or rebuild before launching the dashboard.'
    });
  } catch (error) {
    const reason = error instanceof LocalCommandResolutionError ? error.code : 'resolver_failed';
    const message = error instanceof Error ? error.message : String(error);
    addCheck(checks, {
      id: 'resolver.workflow',
      title: 'Project workflow resolves',
      status: 'failure',
      reason,
      summary: message,
      remediation: 'Run from a project containing WORKFLOW.md or pass `--workflow <path>`.'
    });
  }

  const summary = summarizeStatus(checks);
  const result: DoctorJsonResult = {
    version: 1,
    command: 'doctor',
    status: summary.status,
    reason: summary.reason,
    exitCode: summary.exitCode,
    exitSemantics: {
      code: summary.exitCode,
      meaning:
        summary.reason === 'ready'
          ? 'ready'
          : summary.reason === 'warnings_present'
            ? 'warnings_non_blocking'
            : 'blockers_present',
      ci: {
        requested: args.ci,
        promptsAllowed: false,
        nonZeroOnBlocker: summary.status === 'failure'
      }
    },
    ci: args.ci,
    fix: args.fix,
    cwd: deps.cwd,
    symphonyCheckoutRoot: deps.repoRoot,
    resolution: {
      projectRoot: resolved?.currentProjectRoot ?? null,
      workflowPath: resolved?.workflowPath ?? null,
      envFilePath: resolved?.envFilePath ?? null,
      profile: resolved?.profile.name ?? null,
      host: resolved?.host.host ?? null,
      port: resolved?.port.port ?? null,
      ephemeralPort: resolved ? resolved.port.port === 0 : null,
      consent: consentSource
    },
    layout,
    findings: checks,
    checks,
    projectContext: {
      cwd: deps.cwd,
      symphonyCheckoutRoot: deps.repoRoot,
      projectRoot: resolved?.currentProjectRoot ?? null,
      workflowPath: resolved?.workflowPath ?? null,
      envFilePath: resolved?.envFilePath ?? null,
      envFileExists: resolved ? fs.existsSync(resolved.envFilePath) : null,
      profile: resolved?.profile.name ?? null
    },
    fixes
  };

  return { result, human: renderHuman(result) };
}
