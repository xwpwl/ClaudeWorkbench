import { describe, expect, it, vi } from 'vitest';
import type { ClaudeRunOptions } from '../../../shared/types/claude';
import { UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE } from '../../../shared/types/modelProviders';
import type { StoredModelProvider, StoredProviderModel } from '../ModelProviderService';
import { ProviderEnvironmentResolver } from '../ProviderEnvironmentResolver';
import { ProviderExecutionEnvironmentService } from '../ProviderExecutionEnvironmentService';

function provider(overrides: Partial<StoredModelProvider> = {}): StoredModelProvider {
  return {
    id: 'provider-mimo', name: 'MiMo', type: 'anthropic-compatible',
    apiFormat: 'anthropic-messages', runtimeType: 'claude-code',
    baseUrl: 'https://mimo.example', credentialRef: 'safe-storage://v1/ref',
    defaultModelId: 'mimo-v2.5-pro', enabled: true, isDefault: false,
    capabilities: {
      supportsClaudeCode: true, supportsAgentWorkflow: true, supportsTools: true,
      supportsMCP: true, supportsStreaming: true, supportsVision: false,
    },
    health: { state: 'connected', lastTestedAt: 1, lastErrorType: null, latencyMs: 1 },
    metadata: {}, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

function options(overrides: Partial<ClaudeRunOptions> = {}): ClaudeRunOptions {
  return {
    runId: 'run-1', taskId: 'task-1', projectId: 'project-1', projectKey: 'project',
    sessionKey: 'project::task-1', projectPath: 'C:\\project', prompt: 'work',
    modelProviderId: 'provider-mimo', model: 'mimo-v2.5-pro',
    resolvedModelSelection: resolvedSelection(),
    ...overrides,
  };
}

function resolvedSelection(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-mimo', providerName: 'MiMo', modelId: 'mimo-v2.5-pro',
    runtimeType: 'claude-code' as const, source: 'global_default' as const,
    executionSource: 'database_provider' as const,
    capabilities: provider().capabilities,
    ...overrides,
  };
}

function harness(overrides: Partial<StoredModelProvider> = {}) {
  const value = provider(overrides);
  const models: StoredProviderModel[] = [{
    providerId: value.id, modelId: value.defaultModelId as string, displayName: null,
    source: 'manual', createdAt: 1, updatedAt: 1,
  }];
  const repository = {
    getProvider: vi.fn((id: string) => id === value.id ? value : null),
    listModels: vi.fn((id: string) => id === value.id ? models : []),
  };
  const credentials = { read: vi.fn(() => 'credential-sentinel') };
  const service = new ProviderExecutionEnvironmentService(
    repository,
    credentials,
    new ProviderEnvironmentResolver(),
  );
  return { service, repository, credentials, value, models };
}

describe('ProviderExecutionEnvironmentService', () => {
  it('loads a trusted Provider and credential entirely in main process', () => {
    const test = harness();
    const env = test.service.resolveChildEnvironment(options(), {
      PATH: 'C:\\tools', ANTHROPIC_API_KEY: 'old',
    });
    expect(test.repository.getProvider).toHaveBeenCalledWith('provider-mimo');
    expect(test.credentials.read).toHaveBeenCalledWith('safe-storage://v1/ref');
    expect(env).toEqual({
      PATH: 'C:\\tools',
      ANTHROPIC_BASE_URL: 'https://mimo.example',
      ANTHROPIC_AUTH_TOKEN: 'credential-sentinel',
    });
  });

  it('preserves inherited environment and Claude Code synthetic selections', () => {
    const test = harness();
    const inherited = { PATH: 'x', ANTHROPIC_AUTH_TOKEN: 'existing' };
    expect(test.service.resolveChildEnvironment(options({
      modelProviderId: 'environment:anthropic',
      resolvedModelSelection: resolvedSelection({
        providerId: 'environment:anthropic', executionSource: 'environment',
      }),
    }), inherited)).toEqual(inherited);
    expect(test.service.resolveChildEnvironment(options({
      modelProviderId: 'claude-code:default',
      resolvedModelSelection: resolvedSelection({
        providerId: 'claude-code:default', executionSource: 'claude_code',
      }),
    }), inherited)).toEqual(inherited);
    expect(test.repository.getProvider).not.toHaveBeenCalled();
  });

  it.each([
    [{ enabled: false }, /disabled/iu],
    [{ credentialRef: null }, /configured/iu],
  ])('rejects unusable Provider state', (override, error) => {
    const test = harness(override);
    expect(() => test.service.resolveChildEnvironment(options(), {})).toThrow(error);
    expect(test.credentials.read).not.toHaveBeenCalled();
  });

  it('blocks forged OpenAI-compatible Providers before reading credentials', () => {
    const test = harness({
      type: 'openai-compatible', apiFormat: 'openai-chat-completions',
      runtimeType: 'claude-code', capabilities: provider().capabilities,
    });
    expect(() => test.service.resolveChildEnvironment(options(), {}))
      .toThrow(UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE);
    expect(test.credentials.read).not.toHaveBeenCalled();
  });

  it('rejects model IDs that do not belong to the Provider', () => {
    const test = harness();
    expect(() => test.service.resolveChildEnvironment(options({
      model: 'other-model',
      resolvedModelSelection: resolvedSelection({ modelId: 'other-model' }),
    }), {}))
      .toThrow(/does not belong/iu);
    expect(test.credentials.read).not.toHaveBeenCalled();
  });

  it('requires main-authored model and Provider identities', () => {
    const test = harness();
    expect(() => test.service.resolveChildEnvironment(options({ modelProviderId: '' }), {}))
      .toThrow(/identity/iu);
    expect(() => test.service.resolveChildEnvironment(options({ model: undefined }), {}))
      .toThrow(/model/iu);
  });

  it('does not mutate the inherited environment', () => {
    const test = harness();
    const inherited = { PATH: 'x', ANTHROPIC_API_KEY: 'old' };
    test.service.resolveChildEnvironment(options(), inherited);
    expect(inherited).toEqual({ PATH: 'x', ANTHROPIC_API_KEY: 'old' });
  });

  it('uses executionSource for synthetic dispatch even when IDs and policy source look database-backed', () => {
    const test = harness();
    const inherited = { PATH: 'x', ANTHROPIC_AUTH_TOKEN: 'existing' };

    const result = test.service.resolveChildEnvironment(options({
      modelProviderId: 'provider-mimo',
      resolvedModelSelection: resolvedSelection({
        providerId: 'provider-mimo',
        source: 'task_override',
        executionSource: 'environment',
      }),
    }), inherited);

    expect(result).toEqual(inherited);
    expect(test.repository.getProvider).not.toHaveBeenCalled();
    expect(test.credentials.read).not.toHaveBeenCalled();
  });

  it('uses executionSource for database dispatch even when the Provider ID and policy source look synthetic', () => {
    const test = harness({ id: 'environment:anthropic' });

    const result = test.service.resolveChildEnvironment(options({
      modelProviderId: 'environment:anthropic',
      resolvedModelSelection: resolvedSelection({
        providerId: 'environment:anthropic',
        source: 'environment',
        executionSource: 'database_provider',
      }),
    }), { PATH: 'x', ANTHROPIC_AUTH_TOKEN: 'existing' });

    expect(test.repository.getProvider).toHaveBeenCalledWith('environment:anthropic');
    expect(test.credentials.read).toHaveBeenCalledWith('safe-storage://v1/ref');
    expect(result.ANTHROPIC_AUTH_TOKEN).toBe('credential-sentinel');
  });
});
