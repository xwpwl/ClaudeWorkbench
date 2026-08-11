import { describe, expect, it } from 'vitest';
import { UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE } from '../../../shared/types/modelProviders';
import {
  ProviderEnvironmentResolver,
  type ProviderExecutionBinding,
} from '../ProviderEnvironmentResolver';

const inherited = {
  PATH: 'C:\\tools',
  ANTHROPIC_BASE_URL: 'https://old.example',
  ANTHROPIC_API_KEY: 'old-api-key',
  ANTHROPIC_AUTH_TOKEN: 'old-auth-token',
};

function binding(overrides: Partial<ProviderExecutionBinding> = {}): ProviderExecutionBinding {
  return {
    providerId: 'provider-mimo',
    type: 'anthropic-compatible',
    apiFormat: 'anthropic-messages',
    baseUrl: 'https://mimo.example/anthropic',
    credential: 'new-credential',
    source: 'application',
    ...overrides,
  };
}

describe('ProviderEnvironmentResolver', () => {
  it('preserves the existing environment fallback unchanged in a fresh object', () => {
    const resolver = new ProviderEnvironmentResolver();
    const result = resolver.buildChildEnvironment(inherited, binding({ source: 'environment' }));
    expect(result).toEqual(inherited);
    expect(result).not.toBe(inherited);
  });

  it('preserves Claude Code login behavior without adding Provider variables', () => {
    const resolver = new ProviderEnvironmentResolver();
    const base = { PATH: 'C:\\tools', CLAUDE_CONFIG_DIR: 'C:\\claude' };
    expect(resolver.buildChildEnvironment(base, binding({ source: 'claude_code', credential: null })))
      .toEqual(base);
  });

  it('removes inherited Anthropic credentials before injecting a MiMo-compatible task binding', () => {
    const result = new ProviderEnvironmentResolver().buildChildEnvironment(inherited, binding());
    expect(result).toEqual({
      PATH: 'C:\\tools',
      ANTHROPIC_BASE_URL: 'https://mimo.example/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'new-credential',
    });
    expect(result).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('uses ANTHROPIC_API_KEY for the official Anthropic Provider', () => {
    const result = new ProviderEnvironmentResolver().buildChildEnvironment(inherited, binding({
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    }));
    expect(result.ANTHROPIC_API_KEY).toBe('new-credential');
    expect(result).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('never mutates the supplied or global environment object', () => {
    const original = { ...inherited };
    const resolver = new ProviderEnvironmentResolver();
    resolver.buildChildEnvironment(inherited, binding());
    expect(inherited).toEqual(original);
  });

  it('keeps concurrent Provider environments isolated', () => {
    const resolver = new ProviderEnvironmentResolver();
    const first = resolver.buildChildEnvironment(inherited, binding({
      providerId: 'one', baseUrl: 'https://one.example', credential: 'secret-one',
    }));
    const second = resolver.buildChildEnvironment(inherited, binding({
      providerId: 'two', baseUrl: 'https://two.example', credential: 'secret-two',
    }));
    expect(first.ANTHROPIC_BASE_URL).toBe('https://one.example');
    expect(first.ANTHROPIC_AUTH_TOKEN).toBe('secret-one');
    expect(second.ANTHROPIC_BASE_URL).toBe('https://two.example');
    expect(second.ANTHROPIC_AUTH_TOKEN).toBe('secret-two');
  });

  it('blocks raw OpenAI-compatible bindings instead of invoking Claude Code', () => {
    const resolver = new ProviderEnvironmentResolver();
    expect(() => resolver.buildChildEnvironment(inherited, binding({
      type: 'openai-compatible',
      apiFormat: 'openai-chat-completions',
    }))).toThrow(UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE);
  });

  it('requires an application credential and sanitized base URL', () => {
    const resolver = new ProviderEnvironmentResolver();
    expect(() => resolver.buildChildEnvironment(inherited, binding({ credential: null })))
      .toThrow(/credential/iu);
    expect(() => resolver.buildChildEnvironment(inherited, binding({ baseUrl: null })))
      .toThrow(/Base URL/iu);
    expect(() => resolver.buildChildEnvironment(inherited, binding({
      baseUrl: 'https://user:pass@example.com',
    }))).toThrow(/Base URL/iu);
  });

  it('rejects NUL-bearing environment values', () => {
    const resolver = new ProviderEnvironmentResolver();
    expect(() => resolver.buildChildEnvironment(inherited, binding({
      credential: 'secret\0suffix',
    }))).toThrow(/credential/iu);
  });

  it('detects a configured environment source without returning any secret values', () => {
    const resolver = new ProviderEnvironmentResolver();
    const source = resolver.describeInheritedEnvironment({
      ANTHROPIC_BASE_URL: 'https://mimo.example/path?token=hidden#fragment',
      ANTHROPIC_AUTH_TOKEN: 'credential-sentinel',
    }, 'mimo-v2.5-pro');
    expect(source).toMatchObject({
      providerId: 'environment:anthropic',
      providerName: '环境变量',
      modelId: 'mimo-v2.5-pro',
      source: 'environment',
      runtimeType: 'claude-code',
    });
    expect(JSON.stringify(source)).not.toContain('credential-sentinel');
    expect(JSON.stringify(source)).not.toContain('hidden');
  });

  it('returns null when no inherited Anthropic credential is configured', () => {
    expect(new ProviderEnvironmentResolver().describeInheritedEnvironment({ PATH: 'x' }, 'model'))
      .toBeNull();
  });
});
