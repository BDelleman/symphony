import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { operationalCommandStdio } from '../helpers/quiet-operational-output';
import { CANONICAL_EVENT } from '../../src/observability/events';
import { REASON_CODES } from '../../src/observability/reason-codes';
import { createRuntimeEnvironment, createRuntimeTerminateWorkerPort, toWorkerEvent } from '../../src/runtime';
import { SqlitePersistenceStore, buildDurableIdentity } from '../../src/persistence';
import type { TrackerAdapter } from '../../src/tracker';

const RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS = 30_000;

interface TestDatabase {
  exec(sql: string): void;
  close(): void;
}

function openDatabase(dbPath: string): TestDatabase {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => TestDatabase };
  return new sqlite.DatabaseSync(dbPath);
}

function requireApiAddress(runtime: { apiServer: { address: () => { host: string; port: number } } | null }) {
  if (!runtime.apiServer) {
    throw new Error('expected API server to be enabled for this test');
  }

  return runtime.apiServer.address();
}

function expectedRuntimeSinks(options: { observer?: boolean; capture?: boolean } = {}): string[] {
  const visibleStderr =
    process.env.SYMPHONY_TEST_LOGS === '1' ||
    process.env.SYMPHONY_TEST_LOGS === 'true' ||
    process.env.SYMPHONY_TEST_LOGS === 'stderr';
  const sinks = visibleStderr ? ['stderr', 'file'] : ['file'];
  if (options.capture ?? true) {
    sinks.push('test-capture');
  }
  if (options.observer) {
    sinks.push('observer');
  }
  return sinks;
}

async function makeWorkflowFile(options?: {
  includeTrackerCredentials?: boolean;
  includeServerPort?: boolean;
  serverPort?: number;
  loggingRoot?: string;
  omitWorkspaceRoot?: boolean;
  omitPersistencePath?: boolean;
  persistenceDbPath?: string;
  pollingIntervalMs?: number;
  hooksTimeoutMs?: number;
  codexBlock?: string;
  workspaceProvisionerBlock?: string;
  runtimeUpdateBlock?: string;
}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-runtime-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  const includeTrackerCredentials = options?.includeTrackerCredentials ?? true;
  const includeServerPort = options?.includeServerPort ?? true;
  const serverPort = options?.serverPort ?? 0;
  const loggingRoot = options?.loggingRoot;
  const workspaceRootBlock = options?.omitWorkspaceRoot
    ? ''
    : `  root: ${JSON.stringify(path.join(dir, 'workspaces'))}
`;
  const persistencePathBlock = options?.omitPersistencePath
    ? ''
    : `  db_path: ${JSON.stringify(options?.persistenceDbPath ?? path.join(dir, 'runtime.sqlite'))}
`;
  const pollingIntervalMs = options?.pollingIntervalMs ?? 1000;
  const hooksTimeoutMs = options?.hooksTimeoutMs ?? 1000;
  const codexBlock =
    options?.codexBlock ??
    `codex:
  command: codex app-server
  turn_timeout_ms: 1000
  read_timeout_ms: 1000
  stall_timeout_ms: 1000
`;
  const trackerCredentialBlock = includeTrackerCredentials
    ? `  api_key: test-token
  project_slug: TEST
`
    : '';
  const serverBlock = includeServerPort
    ? `server:
  port: ${serverPort}
`
    : '';
  const loggingBlock =
    typeof loggingRoot === 'string' && loggingRoot.trim().length > 0
      ? `logging:
  root: ${JSON.stringify(loggingRoot)}
`
      : '';
  const workspaceProvisionerBlock = options?.workspaceProvisionerBlock ?? '';
  const runtimeUpdateBlock = options?.runtimeUpdateBlock ?? '';
  const content = `---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
${trackerCredentialBlock}  active_states:
    - Todo
  terminal_states:
    - Done
polling:
  interval_ms: ${pollingIntervalMs}
workspace:
${workspaceRootBlock}\
${workspaceProvisionerBlock}\
${runtimeUpdateBlock}\
hooks:
  timeout_ms: ${hooksTimeoutMs}
agent:
  max_concurrent_agents: 1
  max_retry_backoff_ms: 10000
  max_turns: 1
${codexBlock}\
persistence:
  enabled: true
${persistencePathBlock}\
  retention_days: 14
${serverBlock}${loggingBlock}---
Issue {{ issue.identifier }} attempt {{ attempt }}
`;
  await fs.writeFile(workflowPath, content, 'utf8');
  return workflowPath;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: operationalCommandStdio() }).trim();
}

async function writeTestFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

async function makeRuntimeUpdateRepo(): Promise<{ root: string; remote: string; local: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-runtime-bootstrap-update-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, ['init', '--bare', remote]);
  git(root, ['clone', remote, local]);
  git(local, ['config', 'user.email', 'symphony@example.test']);
  git(local, ['config', 'user.name', 'Symphony Test']);
  await writeTestFile(path.join(local, 'package.json'), '{"scripts":{"build":"node -e \\"process.exit(0)\\""}}\n');
  await writeTestFile(path.join(local, 'index.js'), 'console.log("bootstrap");\n');
  git(local, ['add', '.']);
  git(local, ['commit', '-m', 'initial']);
  git(local, ['branch', '-M', 'main']);
  git(local, ['push', '-u', 'origin', 'main']);
  return { root, remote, local };
}

async function pushRuntimeUpdate(root: string): Promise<void> {
  const remoteWork = path.join(root, `remote-work-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  git(root, ['clone', path.join(root, 'remote.git'), remoteWork]);
  git(remoteWork, ['config', 'user.email', 'symphony@example.test']);
  git(remoteWork, ['config', 'user.name', 'Symphony Test']);
  await writeTestFile(path.join(remoteWork, 'index.js'), `console.log("update-${Date.now()}");\n`);
  git(remoteWork, ['add', '.']);
  git(remoteWork, ['commit', '-m', 'remote update']);
  git(remoteWork, ['push', 'origin', 'main']);
}

describe('createRuntimeEnvironment', () => {
  const runtimes: Array<{ stop: () => Promise<void> }> = [];
  const dirs: string[] = [];
  const originalTestLogEnv = {
    SYMPHONY_TEST_LOGS: process.env.SYMPHONY_TEST_LOGS,
    SYMPHONY_TEST_LOG_LEVEL: process.env.SYMPHONY_TEST_LOG_LEVEL,
    SYMPHONY_TEST_LOG_CAPTURE: process.env.SYMPHONY_TEST_LOG_CAPTURE,
    SYMPHONY_TEST_LOG_CAPTURE_LINES: process.env.SYMPHONY_TEST_LOG_CAPTURE_LINES
  };

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalTestLogEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    while (runtimes.length > 0) {
      const runtime = runtimes.pop();
      if (runtime) {
        await runtime.stop();
      }
    }

    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('forwards terminateWorker reasons through the runtime bridge adapter', async () => {
    const workerHandle = { worker: 'handle' };
    const terminateWorker = vi.fn(async (params) => ({
      cancellation_supported: true,
      cancellation_requested: true,
      worker_settled: true,
      graceful_exit_observed: true,
      forced_kill_requested: false,
      forced_kill_settled: null,
      cleanup_requested: params.cleanup_workspace,
      cleanup_succeeded: null,
      result: 'succeeded' as const,
      reason_code: REASON_CODES.workerCancelGracefulExit,
      detail: null
    }));
    const port = createRuntimeTerminateWorkerPort({ terminateWorker });

    await port({
      issue_id: 'issue-1',
      worker_handle: workerHandle,
      cleanup_workspace: false,
      reason: REASON_CODES.missingToolOutputRecoveryInterrupted
    });

    expect(terminateWorker).toHaveBeenCalledWith({
      issue_id: 'issue-1',
      worker_handle: workerHandle,
      cleanup_workspace: false,
      reason: REASON_CODES.missingToolOutputRecoveryInterrupted
    });
  });

  it('preserves protocol warning and model reroute evidence in worker event conversion', () => {
    const workerEvent = toWorkerEvent(
      {
        event: CANONICAL_EVENT.codex.turnCompleted,
        timestamp: '2026-05-11T13:20:00.000Z',
        codex_app_server_pid: 1234,
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        protocol_warnings: [
          {
            method: 'session/configWarning',
            reason_code: 'codex_protocol_config_warning',
            message: 'config field is deprecated',
            severity: 'warn',
            source: 'app_server_protocol'
          }
        ],
        protocol_warning: {
          method: 'session/configWarning',
          reason_code: 'codex_protocol_config_warning',
          message: 'config field is deprecated',
          severity: 'warn',
          source: 'app_server_protocol'
        },
        model_reroute: {
          requested_model: 'gpt-requested',
          effective_model: 'gpt-effective',
          reason_code: 'codex_model_rerouted',
          source: 'app_server_protocol'
        },
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective',
        reason_code: REASON_CODES.unsupportedApprovalServerRequest,
        request_method: 'approval/request',
        request_category: 'approval'
      },
      Date.parse('2026-05-11T13:21:00.000Z')
    );

    expect(workerEvent).toMatchObject({
      event: CANONICAL_EVENT.codex.turnCompleted,
      timestamp_ms: Date.parse('2026-05-11T13:20:00.000Z'),
      protocol_warnings: [
        {
          method: 'session/configWarning',
          reason_code: 'codex_protocol_config_warning',
          message: 'config field is deprecated'
        }
      ],
      protocol_warning: {
        method: 'session/configWarning',
        reason_code: 'codex_protocol_config_warning',
        message: 'config field is deprecated'
      },
      model_reroute: {
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective',
        reason_code: 'codex_model_rerouted'
      },
      requested_model: 'gpt-requested',
      effective_model: 'gpt-effective',
      reason_code: REASON_CODES.unsupportedApprovalServerRequest,
      request_method: 'approval/request',
      request_category: 'approval'
    });
  });

  it('starts live runtime and serves orchestrator-backed state endpoint', async () => {
    const workflowPath = await makeWorkflowFile();
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [
        {
          id: 'issue-1',
          identifier: 'ABC-1',
          title: 'Issue ABC-1',
          description: null,
          priority: 1,
          state: 'Todo',
          branch_name: null,
          url: null,
          labels: [],
          blocked_by: [],
          created_at: new Date('2026-05-04T00:00:00.000Z'),
          updated_at: new Date('2026-05-04T00:00:00.000Z')
        }
      ]),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as {
      counts: { running: number; retrying: number };
      health: { dispatch_validation: 'ok' | 'failed'; last_error: string | null };
      runtime_identity: {
        process_started_at_ms: number;
        process_started_at: string;
        running_build: { identity: string | null; commit_sha: string | null; source_timestamp_ms: number | null };
        current_build: { identity: string | null; commit_sha: string | null; source_timestamp_ms: number | null; status: string };
        status: string;
        health_warning: { code: string; recommended_action: string } | null;
      } | null;
    };

    expect(response.status).toBe(200);
    expect(payload.counts.running).toBe(0);
    expect(payload.health.dispatch_validation).toBe('ok');
    expect(payload.runtime_identity).toMatchObject({
      process_started_at: expect.any(String),
      process_started_at_ms: expect.any(Number),
      running_build: {
        identity: expect.any(String),
        commit_sha: expect.any(String)
      },
      current_build: {
        identity: expect.any(String),
        commit_sha: expect.any(String),
        status: 'available'
      },
      status: 'current',
      health_warning: null
    });
    expect(payload.runtime_identity?.process_started_at_ms).toBeGreaterThan(0);
    expect(tracker.fetch_candidate_issues).toHaveBeenCalled();
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('maps refresh endpoint to orchestrator manual refresh tick', async () => {
    const workflowPath = await makeWorkflowFile();
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [
        {
          id: 'issue-1',
          identifier: 'ABC-1',
          title: 'Issue ABC-1',
          description: null,
          priority: 1,
          state: 'Todo',
          branch_name: null,
          url: null,
          labels: [],
          blocked_by: [],
          created_at: new Date('2026-05-04T00:00:00.000Z'),
          updated_at: new Date('2026-05-04T00:00:00.000Z')
        }
      ]),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/refresh`, { method: 'POST' });
    expect(response.status).toBe(202);
    expect(tracker.fetch_candidate_issues).toHaveBeenCalled();
  });

  it('falls back with typed reason when runtime native submit has no active transport session', async () => {
    const workflowPath = await makeWorkflowFile();
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [
        {
          id: 'issue-1',
          identifier: 'ABC-1',
          title: 'Issue ABC-1',
          description: null,
          priority: 1,
          state: 'Todo',
          branch_name: null,
          url: null,
          labels: [],
          blocked_by: [],
          created_at: new Date('2026-05-04T00:00:00.000Z'),
          updated_at: new Date('2026-05-04T00:00:00.000Z')
        }
      ]),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    await (runtime.orchestrator as unknown as {
      scheduleBlockedInput: (params: Record<string, unknown>) => Promise<void>;
    }).scheduleBlockedInput({
      issue_id: 'issue-1',
      issue_identifier: 'ABC-1',
      attempt: 1,
      worker_host: null,
      workspace_path: null,
      provisioner_type: null,
      branch_name: null,
      repo_root: null,
      workspace_exists: true,
      workspace_git_status: 'clean',
      workspace_provisioned: false,
      workspace_is_git_worktree: false,
      stop_reason_code: 'turn_input_required',
      stop_reason_detail: 'tool requestUserInput input_required_unanswerable',
      pending_input: {
        detail: 'tool requestUserInput input_required_unanswerable',
        request_id: 'req-native-1',
        request_method: 'tool_request_user_input',
        prompt_text: 'Please choose a path.',
        questions: [{ id: 'q-1', prompt: 'Proceed?', options: [{ label: 'Continue' }] }]
      },
      session_console: [],
      previous_thread_id: 'thread-1',
      previous_session_id: 'session-1'
    });

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-1/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: 'req-native-1',
        reason_note: 'continue with selected answer',
        answer: { question_id: 'q-1', option_label: 'Continue' }
      })
    });
    const payload = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('input_submission_expired');
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('exposes SSE event stream endpoint for runtime state push updates', async () => {
    const workflowPath = await makeWorkflowFile();
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await runtime.orchestrator.tick('manual_refresh');
    await response.body?.cancel();
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('starts in offline mode when tracker credentials are missing and adapter is provided', async () => {
    const workflowPath = await makeWorkflowFile({ includeTrackerCredentials: false });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as {
      health: { dispatch_validation: 'ok' | 'failed'; last_error: string | null };
    };

    expect(response.status).toBe(200);
    expect(payload.health.dispatch_validation).toBe('failed');
    expect(payload.health.last_error).toMatch(/tracker\.(api_key|project_slug)/);
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('fails startup on strict numeric validation errors', async () => {
    const workflowPath = await makeWorkflowFile({ hooksTimeoutMs: 0 });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    expect(() =>
      createRuntimeEnvironment({
        workflowPath,
        trackerAdapter: tracker,
        port: 0
      })
    ).toThrow('hooks.timeout_ms must be a positive integer');
  });

  it('exposes diagnostics profile and persistence status endpoints', async () => {
    const workflowPath = await makeWorkflowFile();
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const payload = (await response.json()) as {
      active_profile: { name: string; approval_policy: string };
      persistence: { enabled: boolean; integrity_ok: boolean };
      logging: {
        root: string;
        active_file: string;
        sinks: string[];
        rotation: { max_bytes: number; max_files: number };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.active_profile.name).toBe('strict');
    expect(payload.active_profile.approval_policy).toBe('never');
    expect(payload.persistence.enabled).toBe(true);
    expect(payload.persistence.integrity_ok).toBe(true);
    expect(payload.logging.root).toBe(path.join(path.dirname(workflowPath), '.symphony', 'system', 'logs'));
    expect(payload.logging.active_file).toBe(
      path.join(path.dirname(workflowPath), '.symphony', 'system', 'logs', 'symphony.log')
    );
    expect(payload.logging.sinks).toEqual(expectedRuntimeSinks());
    expect(payload.logging.rotation.max_files).toBe(5);
    expect((payload as Record<string, unknown>).workspace_copy_ignored).toMatchObject({
      enabled: false,
      conflict_policy: 'skip',
      from: 'primary_worktree'
    });
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('wires runtime update GitHub eligibility mode from workflow config into bootstrap readiness', async () => {
    const repo = await makeRuntimeUpdateRepo();
    dirs.push(repo.root);
    await pushRuntimeUpdate(repo.root);
    const workflowPath = await makeWorkflowFile({
      workspaceProvisionerBlock: `  provisioner:
    type: none
    repo_root: ${JSON.stringify(repo.local)}
    base_ref: origin/main
`,
      runtimeUpdateBlock: `runtime_update:
  github_eligibility:
    mode: trust_raw_git
`
    });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const payload = (await response.json()) as {
      runtime_update: {
        state: string;
        github_eligibility: {
          mode: string;
          state: string;
          provider: string;
        };
        refusal_reasons: string[];
      };
    };

    expect(response.status).toBe(200);
    expect(payload.runtime_update).toMatchObject({
      state: 'local_checkout_behind',
      github_eligibility: {
        mode: 'trust_raw_git',
        state: 'github_trusted_raw_git',
        provider: 'none'
      },
      refusal_reasons: []
    });
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('exposes redaction-safe effective typed codex config in diagnostics', async () => {
    const workflowPath = await makeWorkflowFile({
      codexBlock: `codex:
  home: "$HOME/runtime-codex"
  model: gpt-test
  reasoning_effort: high
  extra_flags:
    - --config
    - shell_environment_policy.inherit=all
  turn_timeout_ms: 1000
  read_timeout_ms: 1000
  stall_timeout_ms: 1000
`
    });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const payload = (await response.json()) as {
      runtime_resolution: {
        effective_codex_home: string | null;
        effective_codex_model: string | null;
        effective_reasoning_effort: string | null;
        effective_extra_flags_count: number;
        codex_resolution_mode: 'typed' | 'legacy' | 'mixed';
      };
    };

    expect(response.status).toBe(200);
    expect(payload.runtime_resolution).toMatchObject({
      effective_codex_home: path.normalize(`${os.homedir()}/runtime-codex`),
      effective_codex_model: 'gpt-test',
      effective_reasoning_effort: 'high',
      effective_extra_flags_count: 2,
      codex_resolution_mode: 'typed'
    });
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('restores durable history on restart without restoring running or retry state', async () => {
    const workflowPath = await makeWorkflowFile();
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);
    const dbPath = path.join(workflowDir, 'runtime.sqlite');

    const seededAtMs = Date.now();
    const seedStore = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      nowMs: () => seededAtMs
    });
    const runId = seedStore.startRun({
      issue_id: 'issue-1',
      issue_identifier: 'ABC-1',
      identity: buildDurableIdentity({
        projectRoot: workflowDir,
        workflowPath,
        workflowHash: { status: 'present', value: 'workflow-hash' },
        repositoryRemote: { status: 'missing', reason: 'repository_remote_unavailable' },
        trackerKind: 'linear',
        trackerScope: 'TEST',
        remoteIssueId: 'issue-1',
        humanIssueIdentifier: 'ABC-1'
      })
    });
    seedStore.recordSession(runId, 'thread-1-turn-1');
    seedStore.completeRun({ run_id: runId, terminal_status: 'succeeded' });
    seedStore.close();

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const historyResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/history`);
    const historyPayload = (await historyResponse.json()) as {
      runs: Array<{ run_id: string; issue_identifier: string; terminal_status: string | null; completed_at: string | null }>;
    };
    expect(historyResponse.status).toBe(200);
    expect(historyPayload.runs.some((entry) => entry.run_id === runId)).toBe(true);
    expect(historyPayload.runs.find((entry) => entry.run_id === runId)?.completed_at).toBe(new Date(seededAtMs).toISOString());

    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const statePayload = (await stateResponse.json()) as {
      counts: { running: number; retrying: number };
    };
    expect(stateResponse.status).toBe(200);
    expect(statePayload.counts.running).toBe(0);
    expect(statePayload.counts.retrying).toBe(0);
  });

  it('keeps diagnostics available when startup retention pruning fails', async () => {
    const workflowPath = await makeWorkflowFile();
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);
    const dbPath = path.join(workflowDir, 'runtime.sqlite');

    const seededAtMs = Date.parse('2026-04-01T10:00:00.000Z');
    const runtimeNowMs = Date.parse('2026-04-20T10:00:00.000Z');
    const seedStore = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      nowMs: () => seededAtMs
    });
    const runId = seedStore.startRun({
      issue_id: 'issue-prune-failure',
      issue_identifier: 'PRUNE-1',
      identity: buildDurableIdentity({
        projectRoot: workflowDir,
        workflowPath,
        workflowHash: { status: 'present', value: 'workflow-hash' },
        repositoryRemote: { status: 'missing', reason: 'repository_remote_unavailable' },
        trackerKind: 'linear',
        trackerScope: 'TEST',
        remoteIssueId: 'issue-prune-failure',
        humanIssueIdentifier: 'PRUNE-1'
      })
    });
    seedStore.completeRun({ run_id: runId, terminal_status: 'succeeded' });
    seedStore.close();

    const db = openDatabase(dbPath);
    try {
      db.exec(`
        CREATE TRIGGER fail_retention_prune_delete
        BEFORE DELETE ON runs
        BEGIN
          SELECT RAISE(FAIL, 'token=abcd prune exploded');
        END;
      `);
    } finally {
      db.close();
    }

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0,
      nowMs: () => runtimeNowMs
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const payload = (await response.json()) as {
      persistence: {
        last_pruned_at: string | null;
        last_prune_failure_at: string | null;
        last_prune_failure_reason: string | null;
        last_prune_failure_detail: string | null;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.persistence).toMatchObject({
      last_pruned_at: null,
      last_prune_failure_at: '2026-04-20T10:00:00.000Z',
      last_prune_failure_reason: 'retention_prune_failed',
      last_prune_failure_detail: 'token=***REDACTED*** prune exploded'
    });
  });

  it('restores persisted suppression and breaker state on restart and projects diagnostics', async () => {
    const workflowPath = await makeWorkflowFile();
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);
    const dbPath = path.join(workflowDir, 'runtime.sqlite');

    const seedStore = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14
    });
    seedStore.upsertBreaker({
      issue_id: 'issue-1',
      issue_identifier: 'ABC-1',
      breaker_active: true,
      breaker_hit_count: 2,
      breaker_window_minutes: 30,
      breaker_first_hit_at: '2026-04-11T10:00:00.000Z',
      breaker_last_hit_at: '2026-04-11T10:02:00.000Z'
    });
    seedStore.upsertBlockedInput(
      'issue-1',
      JSON.stringify({
        issue_id: 'issue-1',
        issue_identifier: 'ABC-1',
        attempt: 2,
        worker_host: null,
        workspace_path: '/tmp/symphony/ABC-1',
        provisioner_type: null,
        branch_name: null,
        repo_root: null,
        workspace_exists: true,
        workspace_git_status: 'dirty',
        workspace_provisioned: true,
        workspace_is_git_worktree: true,
        stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
        stop_reason_detail: 'completion gate blocked redispatch because no progress signal was detected',
        conflict_files: [],
        resolution_hints: ['Resolve and resume'],
        blocked_at_ms: Date.parse('2026-04-11T10:02:00.000Z'),
        requires_manual_resume: true,
        pending_input: null,
        session_console: []
      })
    );
    seedStore.upsertOperatorActions(
      'issue-1',
      JSON.stringify([
        {
          action: 'resume',
          requested_at_ms: Date.parse('2026-04-11T10:03:00.000Z'),
          result: 'rejected',
          result_code: 'resume_failed',
          message: 'requires progress'
        }
      ])
    );
    seedStore.close();

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [
        {
          id: 'issue-1',
          identifier: 'ABC-1',
          title: 'Issue ABC-1',
          description: null,
          priority: 1,
          state: 'Todo',
          branch_name: null,
          url: null,
          labels: [],
          blocked_by: [],
          created_at: new Date('2026-04-11T10:00:00.000Z'),
          updated_at: new Date('2026-04-11T10:00:00.000Z')
        }
      ]),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      breaker_statuses: Array<{
        issue_identifier: string;
        breaker_active: boolean;
        breaker_hit_count: number;
        breaker_window_minutes: number;
      }>;
    };
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.breaker_statuses).toEqual([]);

    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const statePayload = (await stateResponse.json()) as {
      blocked: Array<{
        operator_actions: Array<{ action: string; result: string; result_code: string | null }>;
      }>;
      recent_runtime_events: Array<{ event: string; issue_identifier?: string; detail?: string }>;
    };
    expect(statePayload.blocked).toEqual([]);
    expect(statePayload.recent_runtime_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: CANONICAL_EVENT.orchestration.staleBlockedInputCleared,
          issue_identifier: 'ABC-1'
        })
      ])
    );
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('keeps HTTP extension disabled when neither CLI port nor workflow server.port is configured', async () => {
    const workflowPath = await makeWorkflowFile({ includeServerPort: false });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker
    });
    runtimes.push(runtime);

    expect(runtime.apiServer).toBeNull();
    await runtime.start();

    expect(tracker.fetch_candidate_issues).toHaveBeenCalled();
  });

  it('still enables HTTP extension when CLI port is explicitly provided', async () => {
    const workflowPath = await makeWorkflowFile({ includeServerPort: false });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    expect(runtime.apiServer).not.toBeNull();
    await runtime.start();
    const address = requireApiAddress(runtime);
    expect(address.port).toBeGreaterThan(0);
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('uses CLI port precedence over workflow server.port when both are configured', async () => {
    const workflowPath = await makeWorkflowFile({ includeServerPort: true, serverPort: 41001 });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const entries: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger = {
      log: (params: {
        level: 'info' | 'warn' | 'error';
        event: string;
        message: string;
        context?: Record<string, unknown>;
      }) => {
        entries.push({ event: params.event, context: params.context ?? {} });
      }
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0,
      logObserver: logger
    });
    runtimes.push(runtime);

    await runtime.start();

    const enabledEvent = entries.find((entry) => entry.event === CANONICAL_EVENT.runtime.httpEnabled);
    expect(enabledEvent).toBeDefined();
    expect(enabledEvent?.context.configured_port).toBe(0);
    const loggingConfiguredEvent = entries.find((entry) => entry.event === CANONICAL_EVENT.runtime.loggingConfigured);
    expect(loggingConfiguredEvent).toBeDefined();
    expect(loggingConfiguredEvent?.context.logs_root_source).toBe('default');

    const address = requireApiAddress(runtime);
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      logging: { sinks: string[] };
    };
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.logging.sinks).toEqual(expectedRuntimeSinks({ observer: true }));
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('enables stderr runtime logs in tests when explicitly requested', async () => {
    process.env.SYMPHONY_TEST_LOGS = '1';
    process.env.SYMPHONY_TEST_LOG_LEVEL = 'warn';

    const workflowPath = await makeWorkflowFile({ includeServerPort: true, serverPort: 41001 });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0,
      logObserver: {
        log: () => undefined
      }
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      logging: { sinks: string[] };
    };

    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.logging.sinks).toEqual(['stderr', 'file', 'test-capture', 'observer']);
  });

  it('allows test log capture to be disabled explicitly', async () => {
    process.env.SYMPHONY_TEST_LOG_CAPTURE = '0';

    const workflowPath = await makeWorkflowFile({ includeServerPort: true, serverPort: 41001 });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      logging: { sinks: string[] };
    };

    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.logging.sinks).toEqual(expectedRuntimeSinks({ capture: false }));
  });

  it('exposes default runtime-owned paths under the workflow system state root in diagnostics', async () => {
    const workflowPath = await makeWorkflowFile({
      omitWorkspaceRoot: true,
      omitPersistencePath: true,
      includeServerPort: true,
      serverPort: 0
    });
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      runtime_resolution: { workspace_root: string; workspace_root_source: string };
      logging: { root: string; active_file: string };
      persistence: { db_path: string | null };
    };

    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.runtime_resolution).toMatchObject({
      workspace_root: path.join(workflowDir, '.symphony', 'system', 'workspaces'),
      workspace_root_source: 'default'
    });
    expect(diagnosticsPayload.logging).toMatchObject({
      root: path.join(workflowDir, '.symphony', 'system', 'logs'),
      active_file: path.join(workflowDir, '.symphony', 'system', 'logs', 'symphony.log')
    });
    expect(diagnosticsPayload.persistence.db_path).toBe(path.join(workflowDir, '.symphony', 'system', 'runtime.sqlite'));
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('exposes healthy project layout diagnostics for default system state paths', async () => {
    const workflowPath = await makeWorkflowFile({
      omitWorkspaceRoot: true,
      omitPersistencePath: true,
      includeServerPort: true,
      serverPort: 0
    });
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);
    await writeTestFile(path.join(workflowDir, '.gitignore'), '.symphony/system/\n');

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({ workflowPath, trackerAdapter: tracker, port: 0 });
    runtimes.push(runtime);
    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const payload = (await response.json()) as {
      project_layout: {
        status: string;
        canonical_workflow_path: { path: string; source: string; exists: boolean };
        project_root: { path: string };
        expected_runtime_state_root: { path: string; relative_path: string; source: string };
        effective_workspace_root: { path: string; source: string; explicit_override_source: string | null };
        effective_log_root: { path: string; source: string; explicit_override_source: string | null };
        effective_persistence_path: { path: string; source: string; explicit_override_source: string | null };
        ignore_status: { status: string; has_narrow_system_ignore: boolean };
        broad_ignore_warning: { status: string; present: boolean };
        legacy_runtime_path_status: { status: string; present: boolean; paths: unknown[] };
        reserved_customization_path_status: { status: string; paths: Array<{ path: string; loaded_by_runtime: boolean }> };
        warnings: unknown[];
      };
    };

    expect(response.status).toBe(200);
    expect(payload.project_layout).toMatchObject({
      status: 'ok',
      canonical_workflow_path: {
        path: workflowPath,
        source: 'runtime_contract',
        exists: true
      },
      project_root: { path: workflowDir },
      expected_runtime_state_root: {
        path: path.join(workflowDir, '.symphony', 'system'),
        relative_path: '.symphony/system',
        source: 'default_system_state'
      },
      effective_workspace_root: {
        path: path.join(workflowDir, '.symphony', 'system', 'workspaces'),
        source: 'default_system_state',
        explicit_override_source: null
      },
      effective_log_root: {
        path: path.join(workflowDir, '.symphony', 'system', 'logs'),
        source: 'default_system_state',
        explicit_override_source: null
      },
      effective_persistence_path: {
        path: path.join(workflowDir, '.symphony', 'system', 'runtime.sqlite'),
        source: 'default_system_state',
        explicit_override_source: null
      },
      ignore_status: {
        status: 'narrow-system',
        has_narrow_system_ignore: true
      },
      broad_ignore_warning: {
        status: 'ok',
        present: false
      },
      legacy_runtime_path_status: {
        status: 'ok',
        present: false,
        paths: []
      },
      reserved_customization_path_status: {
        status: 'reserved'
      },
      warnings: []
    });
    expect(payload.project_layout.reserved_customization_path_status.paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.symphony/skills', loaded_by_runtime: false }),
        expect.objectContaining({ path: '.symphony/prompts', loaded_by_runtime: false })
      ])
    );
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('reports explicit workflow persistence overrides even when the path equals the default', async () => {
    const workflowPath = await makeWorkflowFile({
      omitWorkspaceRoot: true,
      persistenceDbPath: '.symphony/system/runtime.sqlite',
      includeServerPort: true,
      serverPort: 0
    });
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);
    await writeTestFile(path.join(workflowDir, '.gitignore'), '.symphony/system/\n');

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({ workflowPath, trackerAdapter: tracker, port: 0 });
    runtimes.push(runtime);
    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const payload = (await response.json()) as {
      persistence: { db_path: string | null };
      project_layout: {
        effective_persistence_path: { path: string; source: string; explicit_override_source: string | null };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.persistence.db_path).toBe(path.join(workflowDir, '.symphony', 'system', 'runtime.sqlite'));
    expect(payload.project_layout.effective_persistence_path).toMatchObject({
      path: path.join(workflowDir, '.symphony', 'system', 'runtime.sqlite'),
      source: 'explicit_override',
      explicit_override_source: 'workflow'
    });
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('reports broad and missing system ignore layout warnings without failing diagnostics', async () => {
    const workflowPath = await makeWorkflowFile({ includeServerPort: true, serverPort: 0 });
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);
    await writeTestFile(path.join(workflowDir, '.gitignore'), '.symphony/\n');

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };
    const runtime = createRuntimeEnvironment({ workflowPath, trackerAdapter: tracker, port: 0 });
    runtimes.push(runtime);
    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const payload = (await response.json()) as {
      project_layout: {
        status: string;
        ignore_status: { status: string; has_narrow_system_ignore: boolean };
        broad_ignore_warning: { status: string; present: boolean };
        warnings: Array<{ code: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.project_layout.status).toBe('warning');
    expect(payload.project_layout.ignore_status).toMatchObject({
      status: 'broad-symphony',
      has_narrow_system_ignore: false
    });
    expect(payload.project_layout.broad_ignore_warning).toMatchObject({
      status: 'warning',
      present: true
    });
    expect(payload.project_layout.warnings.map((warning) => warning.code).sort()).toEqual([
      'broad_symphony_ignore',
      'system_ignore_missing'
    ]);
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('reports missing system ignore layout warnings when .gitignore is absent', async () => {
    const workflowPath = await makeWorkflowFile({ includeServerPort: true, serverPort: 0 });
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };
    const runtime = createRuntimeEnvironment({ workflowPath, trackerAdapter: tracker, port: 0 });
    runtimes.push(runtime);
    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const payload = (await response.json()) as {
      project_layout: {
        ignore_status: { exists: boolean; status: string };
        broad_ignore_warning: { status: string; present: boolean };
        warnings: Array<{ code: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.project_layout.ignore_status).toMatchObject({ exists: false, status: 'missing' });
    expect(payload.project_layout.broad_ignore_warning).toMatchObject({ status: 'ok', present: false });
    expect(payload.project_layout.warnings.map((warning) => warning.code)).toContain('system_ignore_missing');
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('keeps diagnostics available when legacy runtime state exists', async () => {
    const workflowPath = await makeWorkflowFile({ includeServerPort: true, serverPort: 0 });
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);
    await writeTestFile(path.join(workflowDir, '.gitignore'), '.symphony/system/\n');
    await fs.mkdir(path.join(workflowDir, '.symphony', 'workspaces'), { recursive: true });

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };
    const runtime = createRuntimeEnvironment({ workflowPath, trackerAdapter: tracker, port: 0 });
    runtimes.push(runtime);
    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const payload = (await response.json()) as {
      project_layout: {
        legacy_runtime_path_status: { status: string; present: boolean; paths: Array<{ path: string }> };
        warnings: Array<{ code: string; path: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.project_layout.legacy_runtime_path_status).toMatchObject({
      status: 'warning',
      present: true,
      paths: [expect.objectContaining({ path: '.symphony/workspaces' })]
    });
    expect(payload.project_layout.warnings).toContainEqual(
      expect.objectContaining({ code: 'legacy_runtime_path_present', path: '.symphony/workspaces' })
    );
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('distinguishes explicit layout path overrides and omits sensitive workflow content', async () => {
    const workflowPath = await makeWorkflowFile({
      includeServerPort: true,
      serverPort: 0,
      loggingRoot: 'custom-logs',
      codexBlock: `codex:
  command: codex app-server
  turn_timeout_ms: 1000
  read_timeout_ms: 1000
  stall_timeout_ms: 1000
# workflow body secret marker: DO_NOT_PROJECT_WORKFLOW_BODY
`
    });
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);
    await writeTestFile(path.join(workflowDir, '.gitignore'), '.symphony/system/\n');

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };
    const runtime = createRuntimeEnvironment({ workflowPath, trackerAdapter: tracker, logsRoot: path.join(workflowDir, 'cli-logs'), port: 0 });
    runtimes.push(runtime);
    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const payload = (await response.json()) as {
      project_layout: {
        effective_workspace_root: { source: string; explicit_override_source: string | null };
        effective_log_root: { path: string; source: string; explicit_override_source: string | null };
        effective_persistence_path: { source: string; explicit_override_source: string | null };
      };
    };
    const projectLayoutJson = JSON.stringify(payload.project_layout);

    expect(response.status).toBe(200);
    expect(payload.project_layout.effective_workspace_root).toMatchObject({
      source: 'explicit_override',
      explicit_override_source: 'workflow'
    });
    expect(payload.project_layout.effective_log_root).toMatchObject({
      path: path.join(workflowDir, 'cli-logs'),
      source: 'explicit_override',
      explicit_override_source: 'cli'
    });
    expect(payload.project_layout.effective_persistence_path).toMatchObject({
      source: 'explicit_override',
      explicit_override_source: 'workflow'
    });
    expect(projectLayoutJson).not.toContain('DO_NOT_PROJECT_WORKFLOW_BODY');
    expect(projectLayoutJson).not.toContain('test-token');
  }, RUNTIME_STARTUP_INTEGRATION_TEST_TIMEOUT_MS);

  it('uses explicit logsRoot option precedence over workflow logging.root', async () => {
    const workflowPath = await makeWorkflowFile();
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);
    const cliLogsRoot = path.join(workflowDir, 'custom-logs');

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };
    const entries: Array<{ event: string; context: Record<string, unknown> }> = [];

    const runtime = createRuntimeEnvironment({
      workflowPath,
      logsRoot: cliLogsRoot,
      trackerAdapter: tracker,
      port: 0,
      logObserver: {
        log: (params) => {
          entries.push({ event: params.event, context: params.context ?? {} });
        }
      }
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      logging: { root: string; active_file: string };
    };

    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.logging.root).toBe(cliLogsRoot);
    expect(diagnosticsPayload.logging.active_file).toBe(path.join(cliLogsRoot, 'symphony.log'));
    const loggingConfiguredEvent = entries.find((entry) => entry.event === CANONICAL_EVENT.runtime.loggingConfigured);
    expect(loggingConfiguredEvent?.context.logs_root_source).toBe('cli');
  });

  it('uses workflow logging.root when CLI logsRoot is unset', async () => {
    const workflowPath = await makeWorkflowFile({
      loggingRoot: '$SYMPHONY_TEST_LOG_ROOT'
    });
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);

    const workflowLogsRoot = path.join(workflowDir, 'workflow-logs');
    process.env.SYMPHONY_TEST_LOG_ROOT = workflowLogsRoot;

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };
    const entries: Array<{ event: string; context: Record<string, unknown> }> = [];

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0,
      logObserver: {
        log: (params) => {
          entries.push({ event: params.event, context: params.context ?? {} });
        }
      }
    });
    runtimes.push(runtime);

    try {
      await runtime.start();
      const address = requireApiAddress(runtime);

      const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
      const diagnosticsPayload = (await diagnosticsResponse.json()) as {
        logging: { root: string; active_file: string; sinks: string[] };
      };

      expect(diagnosticsResponse.status).toBe(200);
      expect(diagnosticsPayload.logging.root).toBe(workflowLogsRoot);
      expect(diagnosticsPayload.logging.active_file).toBe(path.join(workflowLogsRoot, 'symphony.log'));
      expect(diagnosticsPayload.logging.sinks).toEqual(expectedRuntimeSinks({ observer: true }));
      const loggingConfiguredEvent = entries.find((entry) => entry.event === CANONICAL_EVENT.runtime.loggingConfigured);
      expect(loggingConfiguredEvent?.context.logs_root_source).toBe('workflow');
    } finally {
      delete process.env.SYMPHONY_TEST_LOG_ROOT;
    }
  });

  it('fails startup with typed workflow config error when logs root is not writable', async () => {
    const workflowPath = await makeWorkflowFile();
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);

    const blockedPath = path.join(workflowDir, 'blocked-log-root');
    await fs.writeFile(blockedPath, 'not-a-directory', 'utf8');

    expect(() =>
      createRuntimeEnvironment({
        workflowPath,
        logsRoot: blockedPath,
        trackerAdapter: {
          fetch_candidate_issues: async () => [],
          fetch_issues_by_states: async () => [],
          fetch_issue_states_by_ids: async () => [],
          create_comment: vi.fn(async () => undefined),
          update_issue_state: vi.fn(async () => undefined)
        },
        port: 0
      })
    ).toThrow(/invalid_logging_root|logging\.root is not writable/i);
  });

  it('throws startup failure for nonexistent explicit workflow path', () => {
    const missingPath = path.join(os.tmpdir(), `missing-${Date.now()}.md`);

    expect(() =>
      createRuntimeEnvironment({
        workflowPath: missingPath,
        port: 0,
        trackerAdapter: {
          fetch_candidate_issues: async () => [],
          fetch_issues_by_states: async () => [],
          fetch_issue_states_by_ids: async () => [],
          create_comment: vi.fn(async () => undefined),
          update_issue_state: vi.fn(async () => undefined)
        }
      })
    ).toThrow(/workflow file/i);
  });

  it('fails startup with invalid_server_host when host is not resolvable', async () => {
    const workflowPath = await makeWorkflowFile();
    dirs.push(path.dirname(workflowPath));

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: {
        fetch_candidate_issues: async () => [],
        fetch_issues_by_states: async () => [],
        fetch_issue_states_by_ids: async () => [],
        create_comment: vi.fn(async () => undefined),
        update_issue_state: vi.fn(async () => undefined)
      },
      host: 'nonexistent.invalid.symphony.local',
      port: 0
    });

    await expect(runtime.start()).rejects.toThrow(/invalid_server_host|not resolvable/);
  });

  it('supports runtime workflow path switch and preserves last-known-good config', async () => {
    const workflowPath = await makeWorkflowFile({ pollingIntervalMs: 1000 });
    const generatedNextWorkflowPath = await makeWorkflowFile({ pollingIntervalMs: 4000 });
    const nextWorkflowPath = path.join(path.dirname(workflowPath), 'WORKFLOW.next.md');
    await fs.copyFile(generatedNextWorkflowPath, nextWorkflowPath);
    const crossProjectWorkflowPath = await makeWorkflowFile({ pollingIntervalMs: 6000 });
    dirs.push(path.dirname(workflowPath));
    dirs.push(path.dirname(generatedNextWorkflowPath));
    dirs.push(path.dirname(crossProjectWorkflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);
    await runtime.start();

    const address = requireApiAddress(runtime);
    const switchResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/workflow/path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_path: nextWorkflowPath })
    });
    expect(switchResponse.status).toBe(202);
    expect(runtime.orchestrator.getStateSnapshot().poll_interval_ms).toBe(4000);

    const crossProjectResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/workflow/path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_path: crossProjectWorkflowPath })
    });
    expect(crossProjectResponse.status).toBe(422);
    expect(runtime.orchestrator.getStateSnapshot().poll_interval_ms).toBe(4000);

    const previousRuntime = process.env.SYMPHONY_AGENT_RUNTIME;
    const previousModel = process.env.ANTHROPIC_MODEL;
    process.env.SYMPHONY_AGENT_RUNTIME = 'claude-cli';
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    let runtimeSwitchResponse: Response;
    try {
      runtimeSwitchResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/workflow/path`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflow_path: nextWorkflowPath })
      });
    } finally {
      if (previousRuntime === undefined) delete process.env.SYMPHONY_AGENT_RUNTIME;
      else process.env.SYMPHONY_AGENT_RUNTIME = previousRuntime;
      if (previousModel === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = previousModel;
    }
    expect(runtimeSwitchResponse.status).toBe(422);
    expect(runtime.orchestrator.getStateSnapshot().poll_interval_ms).toBe(4000);

    const invalidResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/workflow/path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_path: path.join(path.dirname(nextWorkflowPath), 'missing.md') })
    });
    expect(invalidResponse.status).toBe(422);
    expect(runtime.orchestrator.getStateSnapshot().poll_interval_ms).toBe(4000);
  });

  it('emits startup cold-start and terminal cleanup diagnostics markers', async () => {
    const workflowPath = await makeWorkflowFile();
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);
    const workspaceRoot = path.join(workflowDir, 'workspaces');
    await fs.mkdir(path.join(workspaceRoot, 'ABC-1'), { recursive: true });

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => [
        {
          id: 'issue-1',
          identifier: 'ABC-1',
          title: 'Issue ABC-1',
          description: null,
          priority: 1,
          state: 'Done',
          branch_name: null,
          url: null,
          labels: [],
          blocked_by: [],
          created_at: new Date('2026-04-10T10:00:00.000Z'),
          updated_at: new Date('2026-04-10T10:00:00.000Z')
        }
      ]),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0,
      logObserver: {
        log: (params) => {
          logs.push({ event: params.event, context: params.context ?? {} });
        }
      }
    });
    runtimes.push(runtime);

    await runtime.start();

    const stateInitialized = logs.find((entry) => entry.event === CANONICAL_EVENT.runtime.startupStateInitialized);
    expect(stateInitialized).toBeDefined();
    expect(stateInitialized?.context.state_source).toBe('cold_start');
    expect(stateInitialized?.context.running_cleared).toBe(0);
    expect(stateInitialized?.context.retry_cleared).toBe(0);

    const cleanupCompleted = logs.find((entry) => entry.event === CANONICAL_EVENT.runtime.startupCleanupCompleted);
    expect(cleanupCompleted).toBeDefined();
    expect(cleanupCompleted?.context.terminal_issue_count).toBe(1);
    expect(cleanupCompleted?.context.cleaned_count).toBe(1);
    expect(cleanupCompleted?.context.failed_count).toBe(0);
  });
});
