import { describe, expect, it } from 'vitest';

import { ConfigResolver } from '../../src/workflow/resolver';
import { WorkflowConfigError } from '../../src/workflow/errors';

const definition = {
  config: { tracker: { kind: 'memory' } },
  prompt_template: 'Do the work.'
};

describe('agent runtime environment configuration', () => {
  it('defaults to Codex', () => {
    const resolved = new ConfigResolver({ env: {} }).resolve(definition);
    expect(resolved.agent_runtime).toEqual({
      selected: 'codex',
      claude_command: 'claude',
      claude_model: null,
      claude_allow_non_subscription_auth: false,
      claude_supported_version: '2.1.224'
    });
  });

  it('selects Claude and sources its model, command, and auth override from environment', () => {
    const resolved = new ConfigResolver({
      env: {
        SYMPHONY_AGENT_RUNTIME: 'claude-cli',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
        SYMPHONY_CLAUDE_COMMAND: '/opt/claude/bin/claude',
        SYMPHONY_CLAUDE_ALLOW_NON_SUBSCRIPTION_AUTH: 'true'
      }
    }).resolve(definition);

    expect(resolved.agent_runtime).toMatchObject({
      selected: 'claude-cli',
      claude_model: 'claude-sonnet-4-6',
      claude_command: '/opt/claude/bin/claude',
      claude_allow_non_subscription_auth: true
    });
  });

  it.each([
    [{ SYMPHONY_AGENT_RUNTIME: 'other' }, 'invalid_agent_runtime'],
    [{ SYMPHONY_AGENT_RUNTIME: 'claude-cli' }, 'invalid_claude_model'],
    [{ SYMPHONY_AGENT_RUNTIME: 'claude-cli', ANTHROPIC_MODEL: 'model\nflag' }, 'invalid_claude_model'],
    [{ SYMPHONY_CLAUDE_COMMAND: 'claude\n--flag' }, 'invalid_claude_command']
  ])('fails startup for invalid environment %j', (env, expectedCode) => {
    expect(() => new ConfigResolver({ env }).resolve(definition)).toThrowError(WorkflowConfigError);
    try {
      new ConfigResolver({ env }).resolve(definition);
    } catch (error) {
      expect((error as WorkflowConfigError).code).toBe(expectedCode);
    }
  });
});
