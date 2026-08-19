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
      claude_network_allowed_domains: [
        'api.github.com',
        'codeload.github.com',
        'github.com',
        'mcp.linear.app',
        'objects.githubusercontent.com',
        'raw.githubusercontent.com',
        'registry.npmjs.org',
        'uploads.github.com'
      ],
      claude_allowed_mcp_servers: ['linear-server'],
      claude_supported_version: '2.1.224'
    });
  });

  it('selects Claude and sources its model, command, and auth override from environment', () => {
    const resolved = new ConfigResolver({
      env: {
        SYMPHONY_AGENT_RUNTIME: 'claude-cli',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
        SYMPHONY_CLAUDE_COMMAND: '/opt/claude/bin/claude',
        SYMPHONY_CLAUDE_ALLOW_NON_SUBSCRIPTION_AUTH: 'true',
        SYMPHONY_CLAUDE_NETWORK_ALLOWED_DOMAINS: 'github.com,registry.npmjs.org',
        SYMPHONY_CLAUDE_ALLOWED_MCP_SERVERS: 'linear-server,github'
      }
    }).resolve(definition);

    expect(resolved.agent_runtime).toMatchObject({
      selected: 'claude-cli',
      claude_model: 'claude-sonnet-4-6',
      claude_command: '/opt/claude/bin/claude',
      claude_allow_non_subscription_auth: true,
      claude_network_allowed_domains: ['github.com', 'registry.npmjs.org'],
      claude_allowed_mcp_servers: ['github', 'linear-server']
    });
  });

  it.each([
    [{ SYMPHONY_AGENT_RUNTIME: 'other' }, 'invalid_agent_runtime'],
    [{ SYMPHONY_AGENT_RUNTIME: 'claude-cli' }, 'invalid_claude_model'],
    [{ SYMPHONY_AGENT_RUNTIME: 'claude-cli', ANTHROPIC_MODEL: 'model\nflag' }, 'invalid_claude_model'],
    [{ SYMPHONY_AGENT_RUNTIME: 'claude-cli', ANTHROPIC_MODEL: 'claude-sonnet-4-6-latest' }, 'invalid_claude_model'],
    [{ SYMPHONY_CLAUDE_COMMAND: 'claude\n--flag' }, 'invalid_claude_command'],
    [{ SYMPHONY_CLAUDE_NETWORK_ALLOWED_DOMAINS: '*.github.com' }, 'invalid_claude_network_allowed_domains'],
    [{ SYMPHONY_CLAUDE_NETWORK_ALLOWED_DOMAINS: 'https://github.com' }, 'invalid_claude_network_allowed_domains'],
    [{ SYMPHONY_CLAUDE_NETWORK_ALLOWED_DOMAINS: 'localhost' }, 'invalid_claude_network_allowed_domains'],
    [{ SYMPHONY_CLAUDE_ALLOWED_MCP_SERVERS: 'linear server' }, 'invalid_claude_allowed_mcp_servers']
  ])('fails startup for invalid environment %j', (env, expectedCode) => {
    expect(() => new ConfigResolver({ env }).resolve(definition)).toThrowError(WorkflowConfigError);
    try {
      new ConfigResolver({ env }).resolve(definition);
    } catch (error) {
      expect((error as WorkflowConfigError).code).toBe(expectedCode);
    }
  });
});
