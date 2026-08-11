import { describe, expect, it, vi } from 'vitest';
import type {
  ClaudeAdapter,
  ClaudeEventEnvelope,
  ClaudeRunOptions,
} from '../../../shared/types/claude';
import type { RuntimeProviderDescriptor } from '../AgentRuntime';
import { AgentRuntimeRegistry } from '../AgentRuntimeRegistry';
import { ClaudeCodeAgentRuntime } from '../ClaudeCodeAgentRuntime';

const UNSUPPORTED_RUNTIME_MESSAGE = '当前 Provider 不支持 Claude Code Agent Runtime';

function adapterDouble(): ClaudeAdapter {
  return {
    checkInstallation: vi.fn(async () => ({ installed: true, path: 'claude', version: '2.1.218' })),
    runPrompt: vi.fn(async (options: ClaudeRunOptions) => ({ runId: options.runId, pid: 123 })),
    stopRun: vi.fn(async () => true),
    stopAll: vi.fn(async () => undefined),
    subscribe: vi.fn((_listener: (event: ClaudeEventEnvelope) => void) => () => undefined),
  };
}

function provider(
  overrides: Partial<RuntimeProviderDescriptor> = {},
): RuntimeProviderDescriptor {
  return {
    id: 'provider-anthropic',
    name: 'Claude',
    type: 'anthropic',
    apiFormat: 'anthropic-messages',
    runtimeType: 'claude-code',
    enabled: true,
    configured: true,
    capabilities: {
      supportsClaudeCode: true,
      supportsAgentWorkflow: true,
      supportsTools: true,
      supportsMCP: true,
      supportsStreaming: true,
      supportsVision: true,
    },
    ...overrides,
  };
}

function runOptions(): ClaudeRunOptions {
  return {
    runId: 'run-1',
    projectId: 'project-1',
    taskId: 'task-1',
    projectKey: 'C:/repo',
    sessionKey: 'C:/repo::task-1',
    projectPath: 'C:/repo',
    prompt: 'Plan the change',
    permissionMode: 'plan',
  };
}

function registryWithAdapter(adapter: ClaudeAdapter): AgentRuntimeRegistry {
  return new AgentRuntimeRegistry([new ClaudeCodeAgentRuntime(adapter)]);
}

describe('AgentRuntimeRegistry', () => {
  it('blocks an OpenAI-compatible provider before ClaudeCliAdapter is called', async () => {
    const adapter = adapterDouble();
    const registry = registryWithAdapter(adapter);
    const deepSeek = provider({
      id: 'provider-deepseek',
      name: 'DeepSeek',
      type: 'openai-compatible',
      apiFormat: 'openai-chat-completions',
      runtimeType: 'none',
      capabilities: {
        supportsClaudeCode: false,
        supportsAgentWorkflow: false,
        supportsTools: true,
        supportsMCP: false,
        supportsStreaming: true,
        supportsVision: false,
      },
    });

    await expect(registry.runPrompt(deepSeek, runOptions(), 'agent-workflow'))
      .rejects.toThrow(UNSUPPORTED_RUNTIME_MESSAGE);
    expect(adapter.runPrompt).not.toHaveBeenCalled();
  });

  it('re-derives capabilities and blocks a spoofed OpenAI-compatible record', async () => {
    const adapter = adapterDouble();
    const registry = registryWithAdapter(adapter);
    const spoofed = provider({
      id: 'provider-spoofed',
      name: 'Spoofed DeepSeek',
      type: 'openai-compatible',
      apiFormat: 'openai-chat-completions',
      runtimeType: 'claude-code',
      capabilities: {
        supportsClaudeCode: true,
        supportsAgentWorkflow: true,
        supportsTools: true,
        supportsMCP: true,
        supportsStreaming: true,
        supportsVision: true,
      },
    });

    await expect(registry.runPrompt(spoofed, runOptions(), 'agent-workflow'))
      .rejects.toThrow(UNSUPPORTED_RUNTIME_MESSAGE);
    expect(adapter.runPrompt).not.toHaveBeenCalled();
  });

  it('blocks an unavailable future OpenAI Agent runtime before any adapter call', async () => {
    const adapter = adapterDouble();
    const registry = registryWithAdapter(adapter);
    const future = provider({
      runtimeType: 'openai-agent',
      capabilities: {
        supportsClaudeCode: false,
        supportsAgentWorkflow: true,
        supportsTools: true,
        supportsMCP: false,
        supportsStreaming: true,
        supportsVision: true,
      },
    });

    await expect(registry.runPrompt(future, runOptions(), 'agent-workflow'))
      .rejects.toThrow(UNSUPPORTED_RUNTIME_MESSAGE);
    expect(adapter.runPrompt).not.toHaveBeenCalled();
    expect(registry.get('openai-agent')).toBeUndefined();
  });

  it('blocks a narrowed Provider from Agent Workflow before adapter execution', async () => {
    const adapter = adapterDouble();
    const registry = registryWithAdapter(adapter);
    const chatOnly = provider({
      capabilities: {
        supportsClaudeCode: true,
        supportsAgentWorkflow: false,
        supportsTools: true,
        supportsMCP: true,
        supportsStreaming: true,
        supportsVision: true,
      },
    });

    await expect(registry.runPrompt(chatOnly, runOptions(), 'agent-workflow'))
      .rejects.toThrow('当前 Provider 不支持 Agent Workflow');
    expect(adapter.runPrompt).not.toHaveBeenCalled();
  });

  it('routes an Anthropic Provider through the sole Claude Code runtime', async () => {
    const adapter = adapterDouble();
    const registry = registryWithAdapter(adapter);

    await expect(registry.runPrompt(provider(), runOptions(), 'agent-workflow'))
      .resolves.toEqual({ runId: 'run-1', pid: 123 });
    expect(adapter.runPrompt).toHaveBeenCalledWith(runOptions());
  });

  it('keeps MiMo through an Anthropic-compatible gateway runnable', async () => {
    const adapter = adapterDouble();
    const registry = registryWithAdapter(adapter);
    const mimo = provider({
      id: 'provider-mimo',
      name: 'MiMo',
      type: 'anthropic-compatible',
      capabilities: {
        supportsClaudeCode: true,
        supportsAgentWorkflow: true,
        supportsTools: true,
        supportsMCP: true,
        supportsStreaming: true,
        supportsVision: false,
      },
    });

    await expect(registry.runPrompt(mimo, runOptions(), 'agent-workflow'))
      .resolves.toMatchObject({ runId: 'run-1' });
    expect(adapter.runPrompt).toHaveBeenCalledOnce();
  });

  it.each([
    ['disabled', { enabled: false }],
    ['not configured', { configured: false }],
  ] as const)('rejects a Provider that is %s before adapter execution', async (_label, overrides) => {
    const adapter = adapterDouble();
    const registry = registryWithAdapter(adapter);

    await expect(registry.runPrompt(provider(overrides), runOptions(), 'chat'))
      .rejects.toThrow('Provider');
    expect(adapter.runPrompt).not.toHaveBeenCalled();
  });
});
