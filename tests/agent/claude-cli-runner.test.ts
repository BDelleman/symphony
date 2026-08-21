import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { ClaudeCliRunner, type AgentRunnerEvent } from '../../src/agent';
import { isClaudeSandboxShellLauncher } from '../../src/agent/claude-cli-runner';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const NON_SUBSCRIPTION_SELECTORS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS'
];

function createFixture(): {
  root: string;
  command: string;
  argsFile: string;
  promptFile: string;
  settingsFile: string;
  mcpFile: string;
  envFile: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-claude-runner-'));
  const command = path.join(root, 'claude');
  const argsFile = path.join(root, 'args.json');
  const promptFile = path.join(root, 'prompt.txt');
  const settingsFile = path.join(root, 'settings.json');
  const mcpFile = path.join(root, 'mcp.json');
  const envFile = path.join(root, 'env.json');
  fs.writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write((process.env.MOCK_CLAUDE_VERSION || '2.1.224') + ' (Claude Code)\\n');
  process.exit(0);
}
if (args[0] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'team', email: 'must-not-leak@example.test' }));
  process.exit(0);
}
fs.writeFileSync(process.env.MOCK_ARGS_FILE, JSON.stringify(args));
if (process.env.MOCK_ENV_FILE) {
  fs.writeFileSync(process.env.MOCK_ENV_FILE, JSON.stringify({
    LINEAR_API_KEY: process.env.LINEAR_API_KEY || null,
    UNRELATED_SECRET: process.env.UNRELATED_SECRET || null,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK || null,
    DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER || null,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY || null,
    GH_TOKEN: process.env.GH_TOKEN || null,
    GH_HOST: process.env.GH_HOST || null,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || null,
    npm_config_cache: process.env.npm_config_cache || null,
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT || null,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0 || null,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 || null,
    GIT_CONFIG_KEY_1: process.env.GIT_CONFIG_KEY_1 || null,
    GIT_CONFIG_VALUE_1: process.env.GIT_CONFIG_VALUE_1 || null,
    GIT_CONFIG_KEY_2: process.env.GIT_CONFIG_KEY_2 || null,
    GIT_CONFIG_VALUE_2: process.env.GIT_CONFIG_VALUE_2 || null,
    GIT_CONFIG_KEY_3: process.env.GIT_CONFIG_KEY_3 || null,
    GIT_CONFIG_VALUE_3: process.env.GIT_CONFIG_VALUE_3 || null
  }));
}
const settingsIndex = args.indexOf('--settings');
if (settingsIndex >= 0 && process.env.MOCK_SETTINGS_FILE) {
  try { fs.unlinkSync(process.env.MOCK_SETTINGS_FILE); } catch {}
  fs.copyFileSync(args[settingsIndex + 1], process.env.MOCK_SETTINGS_FILE);
}
const mcpIndex = args.indexOf('--mcp-config');
if (mcpIndex >= 0 && process.env.MOCK_MCP_FILE) {
  try { fs.unlinkSync(process.env.MOCK_MCP_FILE); } catch {}
  fs.copyFileSync(args[mcpIndex + 1], process.env.MOCK_MCP_FILE);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.MOCK_PROMPT_FILE, prompt);
  if (process.env.MOCK_MODE === 'hang') {
    if (process.env.MOCK_DESCENDANT_PID_FILE) {
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(process.env.MOCK_DESCENDANT_PID_FILE, String(descendant.pid));
    }
    setInterval(() => {}, 1000);
    return;
  }
  if (process.env.MOCK_MODE === 'nested-process') {
    const { spawn } = require('node:child_process');
    spawn(process.env.MOCK_NESTED_CLAUDE, [], {
      stdio: 'ignore',
      env: { ...process.env, MOCK_MODE: 'hang' }
    });
    setInterval(() => {}, 1000);
    return;
  }
  const model = process.env.MOCK_EFFECTIVE_MODEL || args[args.indexOf('--model') + 1];
  const mcpName = process.env.MOCK_MCP_NAME || null;
  const resumed = args.includes('--resume');
  const disconnectedMcp = process.env.MOCK_DISCONNECTED_MCP_DRIFT === '1' && !resumed
    ? [{ name: 'hubspot', status: 'needs-authentication' }]
    : [];
  const init = {
    type: 'system', subtype: 'init', session_id: '${SESSION_ID}', model,
    tools: ['Read', 'Bash'].concat(mcpName ? ['mcp__' + mcpName + '__get_issue'] : []),
    mcp_servers: (mcpName ? [{ name: mcpName, status: 'connected' }] : []).concat(disconnectedMcp),
    instruction_sources: process.env.MOCK_INSTRUCTION_DRIFT === '1'
      ? [resumed ? 'changed-user-instructions' : 'initial-user-instructions']
      : ['stable-user-instructions'],
    skills: ['linear']
  };
  const result = { type: 'result', subtype: 'success', is_error: false, session_id: '${SESSION_ID}', result: 'done', num_turns: 3, total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } };
  if (process.env.MOCK_MODE === 'oversized-line') { process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1)); setInterval(() => {}, 1000); return; }
  if (process.env.MOCK_MODE === 'split-utf8') {
    result.result = 'café';
    const output = Buffer.from(JSON.stringify(init) + '\\n' + JSON.stringify(result) + '\\n', 'utf8');
    const marker = output.indexOf(Buffer.from('é', 'utf8'));
    process.stdout.write(output.subarray(0, marker + 1));
    setImmediate(() => process.stdout.end(output.subarray(marker + 1)));
    return;
  }
  if (process.env.MOCK_MODE === 'malformed') { process.stdout.write('{not-json}\\n'); return; }
  if (process.env.MOCK_MODE === 'protocol-ignore-term') {
    process.on('SIGTERM', () => {});
    process.stdout.write('{not-json}\\n');
    setInterval(() => {}, 1000);
    return;
  }
  if (process.env.MOCK_MODE === 'crash-before-init') { process.exit(2); return; }
  if (process.env.MOCK_MODE !== 'no-init') process.stdout.write(JSON.stringify(init) + '\\n');
  if (process.env.MOCK_MODE === 'escaped-process') {
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    descendant.unref();
    fs.writeFileSync(process.env.MOCK_DESCENDANT_PID_FILE, String(descendant.pid));
    setTimeout(() => { process.stdout.write(JSON.stringify(result) + '\\n'); }, 1500);
    return;
  }
  if (process.env.MOCK_MODE === 'missing-result') return;
  if (process.env.MOCK_MODE === 'crash-no-result') { process.exit(2); return; }
  if (process.env.MOCK_BASH_TOOL_ERROR) {
    process.stdout.write(JSON.stringify({ type: 'assistant', session_id: '${SESSION_ID}', message: { id: 'bash-error-message', model, usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', id: 'bash-error-tool', name: 'Bash', input: { command: 'true' } }] } }) + '\\n');
    const errorContent = process.env.MOCK_BASH_TOOL_ERROR_ARRAY === '1'
      ? [{ type: 'text', text: process.env.MOCK_BASH_TOOL_ERROR }]
      : process.env.MOCK_BASH_TOOL_ERROR;
    process.stdout.write(JSON.stringify({ type: 'user', session_id: '${SESSION_ID}', message: { content: [{ type: 'tool_result', tool_use_id: 'bash-error-tool', is_error: true, content: errorContent }] } }) + '\\n');
    if (process.env.MOCK_BASH_TOOL_ERROR_HANG === '1') { setInterval(() => {}, 1000); return; }
  }
  if (process.env.MOCK_PARTIAL === '1') {
    process.stdout.write(JSON.stringify({ type: 'assistant', session_id: '${SESSION_ID}', message: { id: 'msg-1', model, usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'assistant', session_id: '${SESSION_ID}', message: { id: 'msg-1', model, usage: { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }, content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'assistant', session_id: '${SESSION_ID}', message: { id: 'msg-2', model, usage: { input_tokens: 6, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'user', session_id: '${SESSION_ID}', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } }) + '\\n');
  }
  if (process.env.MOCK_EMPTY_ASSISTANT_USAGE === '1') {
    process.stdout.write(JSON.stringify({ type: 'assistant', session_id: '${SESSION_ID}', message: { id: 'empty-usage', model, usage: {}, content: [] } }) + '\\n');
  }
  if (process.env.MOCK_API_RETRY === '1') process.stdout.write(JSON.stringify({ type: 'system', subtype: 'api_retry', session_id: '${SESSION_ID}', error: 'overloaded' }) + '\\n');
  if (process.env.MOCK_PERMISSION_DENIED_EVENT === '1') process.stdout.write(JSON.stringify({ type: 'system', subtype: 'permission_denied', session_id: '${SESSION_ID}', tool_use_id: 'denied-1', tool_name: 'Bash' }) + '\\n');
  if (process.env.MOCK_SYSTEM_EVENTS === '1') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'thinking_tokens', session_id: '${SESSION_ID}' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'task_notification', session_id: '${SESSION_ID}' }) + '\\n');
  }
  if (process.env.MOCK_MODE === 'error-result') { result.subtype = 'error_during_execution'; result.is_error = true; }
  if (process.env.MOCK_MODE === 'missing-is-error') delete result.is_error;
  if (process.env.MOCK_MODE === 'wrong-is-error') result.is_error = 'false';
  if (process.env.MOCK_MODE === 'empty-usage') { result.usage = {}; delete result.total_cost_usd; }
  if (process.env.MOCK_PERMISSION_DENIAL === '1') result.permission_denials = [{ tool_name: 'Bash' }];
  if (process.env.MOCK_MODE === 'mismatched-session') result.session_id = '223e4567-e89b-42d3-a456-426614174000';
  process.stdout.write(JSON.stringify(result) + '\\n');
  if (process.env.MOCK_AUXILIARY_RESULT === '1') process.stdout.write(JSON.stringify({ type: 'result', subtype: 'prompt_suggestion', session_id: '${SESSION_ID}' }) + '\\n');
  if (process.env.MOCK_DUPLICATE_RESULT === '1') process.stdout.write(JSON.stringify(result) + '\\n');
  if (process.env.MOCK_MODE === 'nonzero') process.exitCode = 2;
});
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(root, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const tokenFile = path.join(__dirname, 'mock-gh-token');
const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
if (process.argv.slice(2, 4).join(' ') === 'auth token' && token) {
  process.stdout.write(token + '\\n');
  process.exit(0);
}
process.exit(1);
`,
    { mode: 0o755 }
  );
  return { root, command, argsFile, promptFile, settingsFile, mcpFile, envFile };
}

function fixtureEnv(fixture: ReturnType<typeof createFixture>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(NON_SUBSCRIPTION_SELECTORS.map((name) => [name, undefined])),
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: undefined,
    PATH: process.env.PATH,
    MOCK_ARGS_FILE: fixture.argsFile,
    MOCK_PROMPT_FILE: fixture.promptFile,
    MOCK_SETTINGS_FILE: fixture.settingsFile,
    MOCK_MCP_FILE: fixture.mcpFile,
    MOCK_ENV_FILE: fixture.envFile,
    MOCK_NESTED_CLAUDE: fixture.command,
    ...extra
  };
}

function startInput(root: string, prompt = 'do the harmless task') {
  return {
    command: 'unused',
    commandArgs: [],
    workspaceCwd: root,
    prompt,
    title: 'test',
    maxTurns: 1,
    approvalPolicy: 'never',
    threadSandbox: 'danger-full-access',
    readTimeoutMs: 1_000,
    turnTimeoutMs: 5_000
  };
}

function configureOrigin(root: string, remote: string): void {
  expect(spawnSync('git', ['init'], { cwd: root, shell: false }).status).toBe(0);
  expect(spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: root, shell: false }).status).toBe(0);
}

describe('ClaudeCliRunner', () => {
  it('uses the fixed shell-free argv, sends the prompt on stdin, records passive usage, and resumes exactly', async () => {
    const fixture = createFixture();
    const runner = new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    });

    const first = await runner.startSessionAndRunTurn(startInput(fixture.root));
    expect(first).toMatchObject({
      status: 'completed',
      session_id: SESSION_ID,
      effective_model: 'claude-sonnet-4-6',
      retryable: false,
      provider_usage: {
        runtime: 'claude-cli',
        input_tokens: 10,
        output_tokens: 4,
        provider_turn_count: 3,
        estimated_cost_usd: 0.0123
      }
    });
    expect(fs.readFileSync(fixture.promptFile, 'utf8')).toBe('do the harmless task');
    const firstArgs = JSON.parse(fs.readFileSync(fixture.argsFile, 'utf8')) as string[];
    expect(firstArgs.slice(0, 7)).toEqual([
      '--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose',
      '--setting-sources'
    ]);
    expect(firstArgs[firstArgs.indexOf('--setting-sources') + 1]).toBe('user');
    expect(firstArgs[firstArgs.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
    expect(firstArgs[firstArgs.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(firstArgs[firstArgs.indexOf('--settings') + 1]).toMatch(/symphony-claude-settings-.+\/settings\.json$/);
    expect(firstArgs.join(' ')).not.toMatch(/dangerously-skip-permissions|allowedTools|max-turns|max-budget|--bare|fallback/);
    expect(JSON.parse(fs.readFileSync(fixture.settingsFile, 'utf8'))).toMatchObject({
      permissions: {
        deny: expect.arrayContaining(['WebFetch', 'WebSearch', 'Read(**/.env)'])
      },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        network: {
          deniedDomains: ['localhost', '127.0.0.1', '::1'],
          allowLocalBinding: false
        }
      }
    });
    if (process.platform === 'darwin') {
      expect(JSON.parse(fs.readFileSync(fixture.settingsFile, 'utf8'))).toMatchObject({
        sandbox: { enableWeakerNetworkIsolation: true }
      });
    }

    const resumed = await runner.resumeSessionAndRunTurn({
      ...startInput(fixture.root, 'continue'),
      previousSessionId: SESSION_ID
    });
    expect(resumed.status).toBe('completed');
    const resumedArgs = JSON.parse(fs.readFileSync(fixture.argsFile, 'utf8')) as string[];
    expect(resumedArgs.slice(-2)).toEqual(['--resume', SESSION_ID]);
    const withoutGeneratedPaths = (args: string[]) => args.filter((value, index) =>
      index !== args.indexOf('--settings') + 1 && index !== args.indexOf('--mcp-config') + 1
    );
    expect(withoutGeneratedPaths(resumedArgs)).toEqual(withoutGeneratedPaths(firstArgs).concat('--resume', SESSION_ID));
  });

  it('uses the explicit project root for credential and quarantine sandbox boundaries', async () => {
    const fixture = createFixture();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-claude-project-'));
    const unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-claude-unrelated-'));
    const workspace = path.join(projectRoot, '.symphony', 'system', 'workspaces', 'ABC-1');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.env.local'), 'SECRET=not-for-agent\n');
    fs.writeFileSync(path.join(projectRoot, '.npmrc'), 'token=not-for-agent\n');

    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { PWD: unrelatedCwd }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(workspace));

    expect(result.status).toBe('completed');
    expect(JSON.parse(fs.readFileSync(fixture.settingsFile, 'utf8'))).toMatchObject({
      sandbox: {
        filesystem: {
          denyRead: expect.arrayContaining([
            path.join(projectRoot, '.env.local'),
            path.join(projectRoot, '.npmrc'),
            path.join(path.dirname(projectRoot), '.symphony-quarantine')
          ])
        }
      }
    });
  });

  it('fails closed for a different CLI version', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_CLAUDE_VERSION: '2.1.225' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(result.error_code).toContain('claude_version_unsupported');
  });

  it('fails the Linux sandbox canary before starting a Claude session', async () => {
    const fixture = createFixture();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-sandbox-bin-'));
    fs.writeFileSync(
      path.join(binDir, 'bwrap'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bubblewrap 1"; exit 0; fi\nexit 1\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(binDir, 'socat'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      platform: 'linux',
      env: fixtureEnv(fixture, { PATH: `${binDir}${path.delimiter}${process.env.PATH}` }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(result.error_code).toContain('claude_sandbox_runtime_failed:claude_sandbox_bwrap_canary_failed');
    expect(fs.existsSync(fixture.argsFile)).toBe(false);
  });

  it('rejects API-key routing unless explicitly approved', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { ANTHROPIC_API_KEY: 'not-a-real-key' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(result.error_code).toContain('claude_non_subscription_auth_forbidden:ANTHROPIC_API_KEY');
  });

  it('fails closed on duplicate terminal results', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_DUPLICATE_RESULT: '1' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({ status: 'failed', error_code: 'claude_terminal_result_count:2', retryable: false });
  });

  it('fails closed and counts a system permission_denied event', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_PERMISSION_DENIED_EVENT: '1' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'claude_permission_denied_under_sandbox',
      provider_usage: { permission_denial_count: 1 }
    });
  });

  it.each(['string', 'array'])('fails immediately on a %s bubblewrap tool failure without persisting output', async (shape) => {
    const fixture = createFixture();
    const events: AgentRunnerEvent[] = [];
    const sensitiveOutput = "bwrap: Can't mount tmpfs on /newroot/root/.aws: No such file or directory";
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, {
        MOCK_BASH_TOOL_ERROR: sensitiveOutput,
        MOCK_BASH_TOOL_ERROR_ARRAY: shape === 'array' ? '1' : undefined,
        MOCK_BASH_TOOL_ERROR_HANG: '1'
      }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn({
      ...startInput(fixture.root),
      onEvent: (event) => events.push(event)
    });

    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'claude_sandbox_runtime_failed',
      retryable: false,
      provider_usage: { status: 'partial', input_tokens: 2, output_tokens: 1 }
    });
    expect(events).toContainEqual(expect.objectContaining({
      detail: 'bubblewrap_containment_failed',
      reason_code: 'claude_sandbox_runtime_failed'
    }));
    expect(JSON.stringify({ result, events })).not.toContain(sensitiveOutput);
  });

  it('does not turn an ordinary failed Bash command into a runtime failure', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_BASH_TOOL_ERROR: 'tests failed with exit code 1' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({ status: 'completed', retryable: false });
  });

  it('preserves a runtime failure when cancellation races after containment failure', async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    const resultPromise = new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, {
        MOCK_BASH_TOOL_ERROR: "bwrap: Can't mount tmpfs: No such file or directory",
        MOCK_BASH_TOOL_ERROR_HANG: '1'
      }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn({
      ...startInput(fixture.root),
      cancellationSignal: controller.signal,
      onEvent: (event) => {
        if (event.reason_code === 'claude_sandbox_runtime_failed') setImmediate(() => controller.abort());
      }
    });

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'claude_sandbox_runtime_failed',
      retryable: false
    });
  });

  it.each(['missing-is-error', 'wrong-is-error'])('requires terminal is_error=false for %s', async (mode) => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_MODE: mode }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({ status: 'failed', error_code: 'claude_terminal_is_error', retryable: false });
  });

  it.each([
    ['malformed', 'claude_protocol_malformed_json'],
    ['missing-result', 'claude_terminal_result_count:0'],
    ['no-init', 'claude_result_before_init'],
    ['mismatched-session', 'claude_session_id_mismatch']
  ])('fails closed for %s protocol output', async (mode, expectedError) => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_MODE: mode }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({ status: 'failed', error_code: expectedError, retryable: false });
  });

  it('handles split UTF-8 protocol chunks and drains an auxiliary result after the primary result', async () => {
    const splitFixture = createFixture();
    const split = await new ClaudeCliRunner({
      command: splitFixture.command,
      projectRoot: splitFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(splitFixture, { MOCK_MODE: 'split-utf8' }),
      homedir: () => splitFixture.root
    }).startSessionAndRunTurn(startInput(splitFixture.root));
    expect(split).toMatchObject({ status: 'completed', last_agent_message: 'café' });

    const trailingFixture = createFixture();
    const trailing = await new ClaudeCliRunner({
      command: trailingFixture.command,
      projectRoot: trailingFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(trailingFixture, { MOCK_AUXILIARY_RESULT: '1' }),
      homedir: () => trailingFixture.root
    }).startSessionAndRunTurn(startInput(trailingFixture.root));
    expect(trailing).toMatchObject({
      status: 'completed',
      provider_usage: { auxiliary_result_count: 1 }
    });
  });

  it('fails closed and terminates the process for an oversized partial protocol line', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_MODE: 'oversized-line' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn({ ...startInput(fixture.root), turnTimeoutMs: 5_000 });
    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'claude_protocol_line_too_large',
      retryable: false
    });
  });

  it('fails closed when the terminal result reports a permission denial', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_PERMISSION_DENIAL: '1' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));
    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'claude_permission_denied_under_sandbox',
      provider_usage: { permission_denial_count: 1 }
    });
  });

  it('does not resume a session when its issue binding changes', async () => {
    const fixture = createFixture();
    const runner = new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    });
    const first = await runner.startSessionAndRunTurn({
      ...startInput(fixture.root),
      runBinding: { project_identity: 'project', issue_id: '1', issue_identifier: 'CAI-1', attempt: 0 }
    });
    expect(first.status).toBe('completed');

    const resumed = await runner.resumeSessionAndRunTurn({
      ...startInput(fixture.root),
      previousSessionId: SESSION_ID,
      runBinding: { project_identity: 'project', issue_id: '2', issue_identifier: 'CAI-2', attempt: 0 }
    });
    expect(resumed).toMatchObject({ status: 'failed', error_code: 'claude_resume_binding_mismatch', retryable: false });
  });

  it('enforces the absolute turn timeout without treating heartbeat activity as progress', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_MODE: 'hang' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn({ ...startInput(fixture.root), turnTimeoutMs: 50 });

    expect(result).toMatchObject({ status: 'timed_out', error_code: 'turn_timeout', retryable: true });
  });

  it('terminates descendants in the Claude process group on timeout', async () => {
    const fixture = createFixture();
    const descendantPidFile = path.join(fixture.root, 'descendant.pid');
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_MODE: 'hang', MOCK_DESCENDANT_PID_FILE: descendantPidFile }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn({ ...startInput(fixture.root), turnTimeoutMs: 1_000 });

    expect(result.status).toBe('timed_out');
    const descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it('rejects prompts larger than the adapter ceiling before spawning Claude', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root, 'x'.repeat(8 * 1024 * 1024 + 1)));

    expect(result).toMatchObject({ status: 'failed', error_code: 'claude_prompt_too_large', retryable: false });
    expect(fs.existsSync(fixture.argsFile)).toBe(false);
  });

  it('deduplicates assistant steps, emits live partial usage, and reconciles the terminal result', async () => {
    const fixture = createFixture();
    const events: AgentRunnerEvent[] = [];
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_PARTIAL: '1', MOCK_API_RETRY: '1' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn({ ...startInput(fixture.root), onEvent: (event) => events.push(event) });

    const partials = events
      .map((event) => event.provider_usage)
      .filter((usage) => usage?.status === 'partial');
    expect(partials.at(-1)).toMatchObject({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_tokens: 2,
      cache_creation_tokens: 1,
      provider_turn_count: 2,
      estimated_cost_usd: null
    });
    expect(partials).toHaveLength(3);
    expect(result.provider_usage).toMatchObject({
      status: 'final',
      confidence: 'provider_result',
      api_retry_count: 1,
      tool_counts: { Read: 1 },
      reconciliation_delta: { provider_turn_count: 1 }
    });
    const toolEvents = events.filter((event) => event.tool_call_id);
    expect(toolEvents.map((event) => event.event)).toEqual([
      'codex.tool.started',
      'codex.tool.completed'
    ]);
    expect(toolEvents[0]?.tool_name).toBe('Read');
    expect(toolEvents[0]?.tool_call_id).toBe(toolEvents[1]?.tool_call_id);
    expect(events.some((event) => event.detail === 'claude_usage_reconciliation_mismatch')).toBe(false);
  });

  it('treats ordinary system activity as known protocol events', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_SYSTEM_EVENTS: '1' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({
      status: 'completed',
      provider_usage: { unknown_event_count: 0 }
    });
  });

  it('ignores auxiliary result messages but still requires one primary result', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_AUXILIARY_RESULT: '1' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result.status).toBe('completed');
  });

  it('retains terminal usage when Claude returns an error result', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_MODE: 'error-result' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'claude_terminal_error_during_execution',
      provider_usage: { status: 'final', input_tokens: 10, output_tokens: 4 }
    });
  });

  it('fails closed for missing or unapproved MCP exposure', async () => {
    const missingFixture = createFixture();
    const missing = await new ClaudeCliRunner({
      command: missingFixture.command,
      projectRoot: missingFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      allowedMcpServers: ['linear-server'],
      requiredMcpServers: ['linear-server'],
      env: fixtureEnv(missingFixture),
      homedir: () => missingFixture.root
    }).startSessionAndRunTurn(startInput(missingFixture.root));
    expect(missing).toMatchObject({
      status: 'failed',
      error_code: 'claude_user_mcp_unsafe:user_mcp_missing.linear-server'
    });

    const unexpectedFixture = createFixture();
    const unexpected = await new ClaudeCliRunner({
      command: unexpectedFixture.command,
      projectRoot: unexpectedFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      allowedMcpServers: ['linear-server'],
      env: fixtureEnv(unexpectedFixture, { MOCK_MCP_NAME: 'hubspot' }),
      homedir: () => unexpectedFixture.root
    }).startSessionAndRunTurn(startInput(unexpectedFixture.root));
    expect(unexpected).toMatchObject({ status: 'failed', error_code: 'claude_unapproved_mcp_exposed:hubspot' });
  });

  it('rejects credential-bearing configuration for an approved MCP server', async () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.root, '.claude.json'), JSON.stringify({
      mcpServers: {
        internal: {
          type: 'http',
          url: 'https://mcp.example.test/mcp',
          headers: { Authorization: 'must-not-be-copied' }
        }
      }
    }));
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      allowedMcpServers: ['internal'],
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'claude_user_mcp_unsafe:user_mcp_internal.inline_configuration',
      retryable: false
    });
    expect(fs.existsSync(fixture.argsFile)).toBe(false);

    fs.writeFileSync(path.join(fixture.root, '.claude.json'), JSON.stringify({
      mcpServers: { internal: { type: 'http', url: 'https://mcp.example.test/mcp?token=must-not-be-copied' } }
    }));
    const queryCredential = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      allowedMcpServers: ['internal'],
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));
    expect(queryCredential).toMatchObject({
      status: 'failed',
      error_code: 'claude_user_mcp_unsafe:user_mcp_internal.endpoint'
    });
  });

  it('requires the exact user-scoped Linear MCP endpoint and rejects a local override', async () => {
    const fixture = createFixture();
    const userConfiguration = {
      mcpServers: {
        'linear-server': { type: 'http', url: 'https://mcp.linear.app/mcp' }
      }
    };
    fs.writeFileSync(path.join(fixture.root, '.claude.json'), JSON.stringify(userConfiguration));
    const options = {
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      allowedMcpServers: ['linear-server'],
      requiredMcpServers: ['linear-server'],
      env: fixtureEnv(fixture, { MOCK_MCP_NAME: 'linear-server' }),
      homedir: () => fixture.root
    };
    expect((await new ClaudeCliRunner(options).startSessionAndRunTurn(startInput(fixture.root))).status).toBe('completed');

    fs.writeFileSync(
      path.join(fixture.root, '.claude.json'),
      JSON.stringify({
        ...userConfiguration,
        projects: {
          [fixture.root]: {
            allowedTools: ['WebFetch(domain:example.test)'],
            mcpServers: {
              'linear-server': { type: 'http', url: 'https://example.test/mcp' }
            }
          }
        }
      })
    );
    expect(await new ClaudeCliRunner(options).startSessionAndRunTurn(startInput(fixture.root))).toMatchObject({
      status: 'failed',
      error_code: 'claude_user_mcp_unsafe:local_mcp_override.linear-server,local_permissions.allowedTools'
    });
  });

  it('ignores disconnected optional MCP inventory drift when resuming', async () => {
    const fixture = createFixture();
    const runner = new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_DISCONNECTED_MCP_DRIFT: '1' }),
      homedir: () => fixture.root
    });

    expect((await runner.startSessionAndRunTurn(startInput(fixture.root))).status).toBe('completed');
    expect(
      (
        await runner.resumeSessionAndRunTurn({
          ...startInput(fixture.root, 'continue'),
          previousSessionId: SESSION_ID
        })
      ).status
    ).toBe('completed');
  });

  it('fails closed when sanitized user instruction surfaces drift before resume', async () => {
    const fixture = createFixture();
    const runner = new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_INSTRUCTION_DRIFT: '1' }),
      homedir: () => fixture.root
    });

    expect((await runner.startSessionAndRunTurn(startInput(fixture.root))).status).toBe('completed');
    expect(
      await runner.resumeSessionAndRunTurn({
        ...startInput(fixture.root, 'continue'),
        previousSessionId: SESSION_ID
      })
    ).toMatchObject({
      status: 'failed',
      error_code: 'claude_capability_fingerprint_drift',
      retryable: false
    });
  });

  it('binds user instruction file contents across resume', async () => {
    const fixture = createFixture();
    fs.mkdirSync(path.join(fixture.root, '.claude'));
    const instructions = path.join(fixture.root, '.claude', 'CLAUDE.md');
    fs.writeFileSync(instructions, 'initial instructions\n');
    const runner = new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    });

    expect((await runner.startSessionAndRunTurn(startInput(fixture.root))).status).toBe('completed');
    fs.writeFileSync(instructions, 'changed instructions\n');
    expect(await runner.resumeSessionAndRunTurn({
      ...startInput(fixture.root, 'continue'),
      previousSessionId: SESSION_ID
    })).toMatchObject({ status: 'failed', error_code: 'claude_resume_binding_mismatch', retryable: false });
  });

  it('strips raw Linear and unrelated inherited credentials from the child environment', async () => {
    const fixture = createFixture();
    const previousLinear = process.env.LINEAR_API_KEY;
    const previousSecret = process.env.UNRELATED_SECRET;
    process.env.LINEAR_API_KEY = 'must-not-reach-claude';
    process.env.UNRELATED_SECRET = 'must-not-reach-claude';
    try {
      const result = await new ClaudeCliRunner({
        command: fixture.command,
        projectRoot: fixture.root,
        model: 'claude-sonnet-4-6',
        allowNonSubscriptionAuth: false,
        env: fixtureEnv(fixture),
        homedir: () => fixture.root
      }).startSessionAndRunTurn(startInput(fixture.root));
      expect(result.status).toBe('completed');
      const childEnv = JSON.parse(fs.readFileSync(fixture.envFile, 'utf8')) as Record<string, string | null>;
      expect(childEnv).toMatchObject({
        LINEAR_API_KEY: null,
        UNRELATED_SECRET: null,
        SSH_AUTH_SOCK: null,
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        GH_TOKEN: null,
        GH_HOST: null,
        GH_CONFIG_DIR: null,
        GIT_CONFIG_COUNT: null,
        GIT_CONFIG_KEY_0: null,
        GIT_CONFIG_VALUE_0: null,
        GIT_CONFIG_KEY_1: null,
        GIT_CONFIG_VALUE_1: null,
        GIT_CONFIG_KEY_2: null,
        GIT_CONFIG_VALUE_2: null,
        GIT_CONFIG_KEY_3: null,
        GIT_CONFIG_VALUE_3: null
      });
      expect(childEnv.npm_config_cache).toMatch(/symphony-claude-settings-.+\/session\/npm-cache$/);
    } finally {
      if (previousLinear === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousLinear;
      if (previousSecret === undefined) delete process.env.UNRELATED_SECRET;
      else process.env.UNRELATED_SECRET = previousSecret;
    }
  });

  it('injects only the scoped GitHub capability for a GitHub HTTPS remote', async () => {
    const fixture = createFixture();
    const token = 'test-github-capability-token';
    fs.writeFileSync(path.join(fixture.root, 'mock-gh-token'), `${token}\n`);
    configureOrigin(fixture.root, 'https://github.com/example/project.git');
    const events: AgentRunnerEvent[] = [];
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      githubCommand: path.join(fixture.root, 'gh'),
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    }).startSessionAndRunTurn({ ...startInput(fixture.root), onEvent: (event) => events.push(event) });

    expect(result.status).toBe('completed');
    expect(JSON.parse(fs.readFileSync(fixture.envFile, 'utf8'))).toMatchObject({
      GH_TOKEN: token,
      GH_HOST: 'github.com',
      GH_CONFIG_DIR: expect.stringMatching(/symphony-claude-settings-.+\/session\/gh-config$/),
      npm_config_cache: expect.stringMatching(/symphony-claude-settings-.+\/session\/npm-cache$/),
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: null,
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: `!'${path.join(fixture.root, 'gh')}' auth git-credential`,
      GIT_CONFIG_KEY_2: null,
      GIT_CONFIG_VALUE_2: null,
      GIT_CONFIG_KEY_3: null,
      GIT_CONFIG_VALUE_3: null
    });
    expect(JSON.stringify({ result, events })).not.toContain(token);
  });

  it('rewrites GitHub SSH remotes to scoped HTTPS auth without exposing the SSH agent', async () => {
    const fixture = createFixture();
    const token = 'test-github-capability-token';
    fs.writeFileSync(path.join(fixture.root, 'mock-gh-token'), `${token}\n`);
    configureOrigin(fixture.root, 'git@github.com:example/project.git');
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      githubCommand: path.join(fixture.root, 'gh'),
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { SSH_AUTH_SOCK: '/not-used-for-github' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result.status).toBe('completed');
    expect(JSON.parse(fs.readFileSync(fixture.envFile, 'utf8'))).toMatchObject({
      SSH_AUTH_SOCK: null,
      GH_TOKEN: token,
      GH_HOST: 'github.com',
      GH_CONFIG_DIR: expect.stringMatching(/symphony-claude-settings-.+\/session\/gh-config$/),
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: null,
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: `!'${path.join(fixture.root, 'gh')}' auth git-credential`,
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf',
      GIT_CONFIG_VALUE_2: 'git@github.com:',
      GIT_CONFIG_KEY_3: 'url.https://github.com/.insteadOf',
      GIT_CONFIG_VALUE_3: 'ssh://git@github.com/'
    });
  });

  it('fails before spawn when a GitHub remote has no scoped gh token', async () => {
    const fixture = createFixture();
    configureOrigin(fixture.root, 'https://github.com/example/project.git');
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      githubCommand: path.join(fixture.root, 'gh'),
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({ status: 'failed', error_code: 'claude_github_auth_unavailable', retryable: false });
    expect(fs.existsSync(fixture.argsFile)).toBe(false);
  });

  it('binds the scoped GitHub token identity across resume', async () => {
    const fixture = createFixture();
    const tokenFile = path.join(fixture.root, 'mock-gh-token');
    fs.writeFileSync(tokenFile, 'first-token\n');
    configureOrigin(fixture.root, 'https://github.com/example/project.git');
    const runner = new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      githubCommand: path.join(fixture.root, 'gh'),
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    });

    expect((await runner.startSessionAndRunTurn(startInput(fixture.root))).status).toBe('completed');
    fs.writeFileSync(tokenFile, 'second-token\n');
    expect(await runner.resumeSessionAndRunTurn({
      ...startInput(fixture.root, 'continue'),
      previousSessionId: SESSION_ID
    })).toMatchObject({ status: 'failed', error_code: 'claude_resume_binding_mismatch', retryable: false });
  });

  it('does not inject a GitHub capability for non-GitHub remotes', async () => {
    const fixture = createFixture();
    configureOrigin(fixture.root, 'https://git.example.test/example/project.git');
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      githubCommand: path.join(fixture.root, 'gh'),
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result.status).toBe('completed');
    expect(JSON.parse(fs.readFileSync(fixture.envFile, 'utf8'))).toMatchObject({
      GH_TOKEN: null,
      GH_HOST: null,
      GIT_CONFIG_COUNT: null
    });
  });

  it('ignores project-controlled Git and GitHub executables during preflight', async () => {
    const gitFixture = createFixture();
    const gitMarker = path.join(gitFixture.root, 'git-hijacked');
    fs.writeFileSync(path.join(gitFixture.root, 'git'), `#!/bin/sh\ntouch ${JSON.stringify(gitMarker)}\nexit 99\n`, { mode: 0o755 });
    configureOrigin(gitFixture.root, 'https://git.example.test/example/project.git');
    const gitResult = await new ClaudeCliRunner({
      command: gitFixture.command,
      projectRoot: gitFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(gitFixture, { PATH: `${gitFixture.root}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` }),
      homedir: () => gitFixture.root
    }).startSessionAndRunTurn(startInput(gitFixture.root));
    expect(gitResult.status).toBe('completed');
    expect(fs.existsSync(gitMarker)).toBe(false);

    const ghFixture = createFixture();
    const ghMarker = path.join(ghFixture.root, 'gh-hijacked');
    fs.writeFileSync(path.join(ghFixture.root, 'gh'), `#!/bin/sh\ntouch ${JSON.stringify(ghMarker)}\nexit 0\n`, { mode: 0o755 });
    configureOrigin(ghFixture.root, 'https://github.com/example/project.git');
    const trustedGit = fs.realpathSync(spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim());
    const ghResult = await new ClaudeCliRunner({
      command: ghFixture.command,
      projectRoot: ghFixture.root,
      gitCommand: trustedGit,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(ghFixture, { PATH: ghFixture.root }),
      homedir: () => ghFixture.root
    }).startSessionAndRunTurn(startInput(ghFixture.root));
    expect(ghResult).toMatchObject({ status: 'failed', error_code: 'claude_executable_not_found:gh' });
    expect(fs.existsSync(ghMarker)).toBe(false);
  });

  it('rejects insecure remotes and credential-bearing local Git configuration', async () => {
    const httpFixture = createFixture();
    configureOrigin(httpFixture.root, 'http://github.com/example/project.git');
    const httpResult = await new ClaudeCliRunner({
      command: httpFixture.command,
      projectRoot: httpFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(httpFixture),
      homedir: () => httpFixture.root
    }).startSessionAndRunTurn(startInput(httpFixture.root));
    expect(httpResult).toMatchObject({ status: 'failed', error_code: 'claude_insecure_git_remote' });

    const configFixture = createFixture();
    configureOrigin(configFixture.root, 'https://git.example.test/example/project.git');
    expect(spawnSync('git', ['config', '--local', 'http.https://git.example.test/.extraheader', 'secret'], {
      cwd: configFixture.root,
      shell: false
    }).status).toBe(0);
    const configResult = await new ClaudeCliRunner({
      command: configFixture.command,
      projectRoot: configFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(configFixture),
      homedir: () => configFixture.root
    }).startSessionAndRunTurn(startInput(configFixture.root));
    expect(configResult).toMatchObject({ status: 'failed', error_code: 'claude_git_config_unsafe' });
  });

  it('rejects unsafe user settings and direct nested Claude tool calls', async () => {
    const unsafeFixture = createFixture();
    fs.mkdirSync(path.join(unsafeFixture.root, '.claude'));
    fs.writeFileSync(path.join(unsafeFixture.root, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }));
    const unsafe = await new ClaudeCliRunner({
      command: unsafeFixture.command,
      projectRoot: unsafeFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(unsafeFixture),
      homedir: () => unsafeFixture.root
    }).startSessionAndRunTurn(startInput(unsafeFixture.root));
    expect(unsafe).toMatchObject({ status: 'failed', error_code: 'claude_user_settings_unsafe:hooks' });

    fs.writeFileSync(
      path.join(unsafeFixture.root, '.claude', 'settings.json'),
      JSON.stringify({ apiKeyHelper: '/usr/local/bin/credential-helper' })
    );
    const helper = await new ClaudeCliRunner({
      command: unsafeFixture.command,
      projectRoot: unsafeFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: true,
      env: fixtureEnv(unsafeFixture),
      homedir: () => unsafeFixture.root
    }).startSessionAndRunTurn(startInput(unsafeFixture.root));
    expect(helper).toMatchObject({ status: 'failed', error_code: 'claude_user_settings_unsafe:apiKeyHelper' });

    fs.writeFileSync(path.join(unsafeFixture.root, '.claude', 'settings.json'), '{}');
    fs.mkdirSync(path.join(unsafeFixture.root, '.claude', 'agents'));
    fs.writeFileSync(path.join(unsafeFixture.root, '.claude', 'agents', 'custom.md'), '# custom agent');
    const customAgent = await new ClaudeCliRunner({
      command: unsafeFixture.command,
      projectRoot: unsafeFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(unsafeFixture),
      homedir: () => unsafeFixture.root
    }).startSessionAndRunTurn(startInput(unsafeFixture.root));
    expect(customAgent).toMatchObject({
      status: 'failed',
      error_code: 'claude_user_custom_agents_unsupported:custom.md'
    });

    fs.rmSync(path.join(unsafeFixture.root, '.claude', 'agents'), { recursive: true, force: true });
    fs.writeFileSync(path.join(unsafeFixture.root, '.claude', 'remote-settings.json'), JSON.stringify({ hooks: {} }));
    const managed = await new ClaudeCliRunner({
      command: unsafeFixture.command,
      projectRoot: unsafeFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(unsafeFixture),
      homedir: () => unsafeFixture.root
    }).startSessionAndRunTurn(startInput(unsafeFixture.root));
    expect(managed).toMatchObject({
      status: 'failed',
      error_code: 'claude_managed_policy_unsupported:remote-settings.json'
    });
  });

  it('terminates a nested Claude descendant even when the tool command was not observable', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_MODE: 'nested-process' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn({ ...startInput(fixture.root), turnTimeoutMs: 5_000 });

    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'claude_nested_runtime_detected',
      retryable: false,
      provider_usage: {
        nested_session_detected: true,
        supervised_session_coverage: 'missing'
      }
    });
  });

  it('kills an escaped descendant without failing an otherwise successful invocation', async () => {
    const fixture = createFixture();
    const pidFile = path.join(fixture.root, 'escaped.pid');
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, {
        MOCK_MODE: 'escaped-process',
        MOCK_DESCENDANT_PID_FILE: pidFile
      }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn({ ...startInput(fixture.root), turnTimeoutMs: 5_000 });

    expect(result).toMatchObject({
      status: 'completed',
      retryable: false
    });
    const escapedPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(escapedPid, 0)).toThrow();
  });

  it('rejects user settings that expand sandbox or credential boundaries', async () => {
    const fixture = createFixture();
    fs.mkdirSync(path.join(fixture.root, '.claude'));
    fs.writeFileSync(
      path.join(fixture.root, '.claude', 'settings.json'),
      JSON.stringify({
        env: { GITHUB_TOKEN: 'must-not-reach-agent' },
        permissions: { allow: ['Edit(~/outside/**)'] },
        sandbox: {
          filesystem: { allowWrite: ['~/outside'] },
          network: { allowedDomains: ['example.com'] }
        }
      })
    );

    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));
    expect(result.status).toBe('failed');
    expect(result.error_code).toContain('claude_user_settings_unsafe:env.GITHUB_TOKEN');
  });

  it('never spawns for a pre-aborted invocation', async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    controller.abort();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    }).startSessionAndRunTurn({ ...startInput(fixture.root), cancellationSignal: controller.signal });
    expect(result).toMatchObject({ status: 'cancelled', cancellation_outcome: 'graceful_exit' });
    expect(fs.existsSync(fixture.argsFile)).toBe(false);
  });

  it('carries known session and thread lineage on resumed process and turn start events', async () => {
    const fixture = createFixture();
    const runner = new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    });
    expect((await runner.startSessionAndRunTurn(startInput(fixture.root))).status).toBe('completed');
    const events: AgentRunnerEvent[] = [];
    expect((await runner.resumeSessionAndRunTurn({
      ...startInput(fixture.root, 'continue'),
      previousSessionId: SESSION_ID,
      onEvent: (event) => events.push(event)
    })).status).toBe('completed');
    for (const eventName of ['agent_runner.process.started', 'agent_runner.turn.started']) {
      expect(events.find((event) => event.event === eventName)).toMatchObject({
        session_id: SESSION_ID,
        thread_id: `claude:${SESSION_ID}`
      });
    }
  });

  it('escalates a protocol violation that ignores SIGTERM', async () => {
    const fixture = createFixture();
    const startedAt = Date.now();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_MODE: 'protocol-ignore-term' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn({ ...startInput(fixture.root), turnTimeoutMs: 30_000 });
    expect(result).toMatchObject({ status: 'failed', error_code: 'claude_protocol_malformed_json' });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  it('isolates approved MCP configuration and grants server-level permission only', async () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.root, '.claude.json'), JSON.stringify({
      mcpServers: {
        'linear-server': { type: 'http', url: 'https://mcp.linear.app/mcp' },
        hubspot: { type: 'stdio', command: '/tmp/must-not-run' }
      }
    }));
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      allowedMcpServers: ['linear-server'],
      requiredMcpServers: ['linear-server'],
      env: fixtureEnv(fixture, { MOCK_MCP_NAME: 'linear-server' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));
    expect(result.status).toBe('completed');
    expect(JSON.parse(fs.readFileSync(fixture.mcpFile, 'utf8'))).toEqual({
      mcpServers: { 'linear-server': { type: 'http', url: 'https://mcp.linear.app/mcp' } }
    });
    expect(JSON.parse(fs.readFileSync(fixture.settingsFile, 'utf8'))).toMatchObject({
      permissions: { allow: ['mcp__linear-server__*'] }
    });
  });

  it('fails safely when observability delivery throws', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    }).startSessionAndRunTurn({
      ...startInput(fixture.root),
      onEvent: () => { throw new Error('history unavailable'); }
    });
    expect(result.status).toBe('failed');
    expect(result.error_code).toContain('claude_event_delivery_failed');
  });

  it('keeps empty terminal usage unobserved and retries unexplained crashes', async () => {
    const emptyFixture = createFixture();
    const empty = await new ClaudeCliRunner({
      command: emptyFixture.command,
      projectRoot: emptyFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(emptyFixture, { MOCK_MODE: 'empty-usage' }),
      homedir: () => emptyFixture.root
    }).startSessionAndRunTurn(startInput(emptyFixture.root));
    expect(empty.provider_usage).toMatchObject({ status: 'unobserved', confidence: 'missing', supervised_session_coverage: 'missing' });

    const crashFixture = createFixture();
    const crash = await new ClaudeCliRunner({
      command: crashFixture.command,
      projectRoot: crashFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(crashFixture, { MOCK_MODE: 'crash-no-result' }),
      homedir: () => crashFixture.root
    }).startSessionAndRunTurn(startInput(crashFixture.root));
    expect(crash).toMatchObject({
      status: 'failed',
      retryable: true,
      provider_usage: { status: 'unobserved', confidence: 'missing', supervised_session_coverage: 'missing' }
    });

    const preInitFixture = createFixture();
    const preInit = await new ClaudeCliRunner({
      command: preInitFixture.command,
      projectRoot: preInitFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(preInitFixture, { MOCK_MODE: 'crash-before-init' }),
      homedir: () => preInitFixture.root
    }).startSessionAndRunTurn(startInput(preInitFixture.root));
    expect(preInit).toMatchObject({
      status: 'failed',
      session_id: null,
      provider_usage: { status: 'unobserved', missing_reason: expect.any(String) }
    });

    const invalidStepFixture = createFixture();
    const invalidStep = await new ClaudeCliRunner({
      command: invalidStepFixture.command,
      projectRoot: invalidStepFixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(invalidStepFixture, { MOCK_MODE: 'missing-result', MOCK_EMPTY_ASSISTANT_USAGE: '1' }),
      homedir: () => invalidStepFixture.root
    }).startSessionAndRunTurn(startInput(invalidStepFixture.root));
    expect(invalidStep.provider_usage).toMatchObject({ status: 'unobserved', provider_turn_count: null });
  });

  it('rejects fresh-session UUID reuse and reports requested-model rerouting', async () => {
    const fixture = createFixture();
    const events: AgentRunnerEvent[] = [];
    const runner = new ClaudeCliRunner({
      command: fixture.command,
      projectRoot: fixture.root,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_EFFECTIVE_MODEL: 'claude-opus-4-6' }),
      homedir: () => fixture.root
    });
    expect((await runner.startSessionAndRunTurn({ ...startInput(fixture.root), onEvent: (event) => events.push(event) })).status).toBe('completed');
    expect(events.some((event) => event.model_reroute?.effective_model === 'claude-opus-4-6')).toBe(true);
    expect(await runner.startSessionAndRunTurn(startInput(fixture.root))).toMatchObject({
      status: 'failed',
      error_code: 'claude_session_collision'
    });
  });
});

describe('isClaudeSandboxShellLauncher', () => {
  it('recognizes the CLI sandbox shell supervisor argv observed from claude 2.1.224', () => {
    expect(isClaudeSandboxShellLauncher(
      ['/proc/self/fd/3', '/bin/bash', '-c', "source /home/user/.claude/shell-snapshots/snapshot-bash-1787240351764-gigf9j.sh 2>/dev/null || true && eval 'gh pr view 503 --json state'"]
    )).toBe(true);
    expect(isClaudeSandboxShellLauncher(['/proc/self/fd/11', '/usr/bin/bash', '-c', 'ls'])).toBe(true);
    expect(isClaudeSandboxShellLauncher(['/proc/self/fd/3', '/bin/sh', '-c', 'ls'])).toBe(true);
  });

  it('does not exempt real claude invocations or near-miss argv shapes', () => {
    expect(isClaudeSandboxShellLauncher(
      ['/home/user/.local/share/claude/versions/2.1.224', '--print', '--model', 'claude-sonnet-4-6']
    )).toBe(false);
    expect(isClaudeSandboxShellLauncher(['/proc/self/fd/3', '--print', '--model', 'claude-sonnet-4-6'])).toBe(false);
    expect(isClaudeSandboxShellLauncher(['/bin/bash', '-c', 'ls'])).toBe(false);
    expect(isClaudeSandboxShellLauncher(['/proc/self/fd/x', '/bin/bash', '-c', 'ls'])).toBe(false);
    expect(isClaudeSandboxShellLauncher(['/proc/self/fd/3', '/bin/bash', 'ls'])).toBe(false);
    expect(isClaudeSandboxShellLauncher(['/proc/self/fd/3 /bin/bash -c', '--print', 'prompt'])).toBe(false);
    expect(isClaudeSandboxShellLauncher([])).toBe(false);
  });
});
