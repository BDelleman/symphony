import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ClaudeCliRunner } from '../../src/agent';

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

function createFixture(): { root: string; command: string; argsFile: string; promptFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-claude-runner-'));
  const command = path.join(root, 'claude');
  const argsFile = path.join(root, 'args.json');
  const promptFile = path.join(root, 'prompt.txt');
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
  const model = args[args.indexOf('--model') + 1];
  const init = { type: 'system', subtype: 'init', session_id: '${SESSION_ID}', model, tools: ['Read', 'Bash'], mcp_servers: [] };
  const result = { type: 'result', subtype: 'success', is_error: false, session_id: '${SESSION_ID}', result: 'done', num_turns: 3, total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } };
  if (process.env.MOCK_MODE === 'malformed') { process.stdout.write('{not-json}\\n'); return; }
  if (process.env.MOCK_MODE !== 'no-init') process.stdout.write(JSON.stringify(init) + '\\n');
  if (process.env.MOCK_MODE === 'missing-result') return;
  if (process.env.MOCK_MODE === 'mismatched-session') result.session_id = '223e4567-e89b-42d3-a456-426614174000';
  process.stdout.write(JSON.stringify(result) + '\\n');
  if (process.env.MOCK_DUPLICATE_RESULT === '1') process.stdout.write(JSON.stringify(result) + '\\n');
  if (process.env.MOCK_MODE === 'nonzero') process.exitCode = 2;
});
`,
    { mode: 0o755 }
  );
  return { root, command, argsFile, promptFile };
}

function fixtureEnv(fixture: ReturnType<typeof createFixture>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(NON_SUBSCRIPTION_SELECTORS.map((name) => [name, undefined])),
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: undefined,
    MOCK_ARGS_FILE: fixture.argsFile,
    MOCK_PROMPT_FILE: fixture.promptFile,
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

describe('ClaudeCliRunner', () => {
  it('uses the fixed shell-free argv, sends the prompt on stdin, records passive usage, and resumes exactly', async () => {
    const fixture = createFixture();
    const runner = new ClaudeCliRunner({
      command: fixture.command,
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
    expect(firstArgs).toEqual([
      '--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose',
      '--setting-sources', 'user', '--model', 'claude-sonnet-4-6', '--dangerously-skip-permissions'
    ]);
    expect(firstArgs.join(' ')).not.toMatch(/allowedTools|max-turns|max-budget|--bare|fallback/);

    const resumed = await runner.resumeSessionAndRunTurn({
      ...startInput(fixture.root, 'continue'),
      previousSessionId: SESSION_ID
    });
    expect(resumed.status).toBe('completed');
    expect(JSON.parse(fs.readFileSync(fixture.argsFile, 'utf8'))).toEqual([...firstArgs, '--resume', SESSION_ID]);
  });

  it('fails closed for a different CLI version', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_CLAUDE_VERSION: '2.1.225' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(result.error_code).toContain('claude_version_unsupported');
  });

  it('rejects API-key routing unless explicitly approved', async () => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
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
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_DUPLICATE_RESULT: '1' }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({ status: 'failed', error_code: 'claude_terminal_result_count:2', retryable: false });
  });

  it.each([
    ['malformed', 'claude_protocol_malformed_json'],
    ['missing-result', 'claude_terminal_result_count:0'],
    ['no-init', 'claude_init_missing'],
    ['mismatched-session', 'claude_session_id_mismatch']
  ])('fails closed for %s protocol output', async (mode, expectedError) => {
    const fixture = createFixture();
    const result = await new ClaudeCliRunner({
      command: fixture.command,
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture, { MOCK_MODE: mode }),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root));

    expect(result).toMatchObject({ status: 'failed', error_code: expectedError, retryable: false });
  });

  it('does not resume a session when its issue binding changes', async () => {
    const fixture = createFixture();
    const runner = new ClaudeCliRunner({
      command: fixture.command,
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
      model: 'claude-sonnet-4-6',
      allowNonSubscriptionAuth: false,
      env: fixtureEnv(fixture),
      homedir: () => fixture.root
    }).startSessionAndRunTurn(startInput(fixture.root, 'x'.repeat(8 * 1024 * 1024 + 1)));

    expect(result).toMatchObject({ status: 'failed', error_code: 'claude_prompt_too_large', retryable: false });
    expect(fs.existsSync(fixture.argsFile)).toBe(false);
  });
});
