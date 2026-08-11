import type {
  ClaudeInstallationInfo,
  ClaudeRunDescriptor,
  ClaudeRunOptions,
} from '../../shared/types/claude';
import {
  UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE,
  type AgentRuntimeType,
  type ImplementedAgentRuntimeType,
} from '../../shared/types/modelProviders';
import type {
  AgentRuntime,
  AgentRuntimeUse,
  RuntimeProviderDescriptor,
} from './AgentRuntime';
import { ProviderCapabilityResolver } from './ProviderCapabilityResolver';

const UNSUPPORTED_AGENT_WORKFLOW_MESSAGE = '当前 Provider 不支持 Agent Workflow';

export class AgentRuntimeRegistry {
  private readonly runtimes = new Map<AgentRuntimeType, AgentRuntime>();
  private readonly capabilityResolver = new ProviderCapabilityResolver();

  constructor(runtimes: readonly AgentRuntime[] = []) {
    for (const runtime of runtimes) {
      this.runtimes.set(runtime.type, runtime);
    }
  }

  get(type: AgentRuntimeType): AgentRuntime | undefined {
    return this.runtimes.get(type);
  }

  async checkInstallation(
    type: ImplementedAgentRuntimeType = 'claude-code',
  ): Promise<ClaudeInstallationInfo> {
    const runtime = this.runtimes.get(type);
    if (!runtime?.implemented) {
      return { installed: false, path: null, version: null };
    }
    return runtime.checkInstallation();
  }

  assertRunnable(
    provider: RuntimeProviderDescriptor,
    use: AgentRuntimeUse = 'agent-workflow',
  ): AgentRuntime {
    if (!provider.enabled) {
      throw new Error(`Provider 已停用：${provider.name}`);
    }
    if (!provider.configured) {
      throw new Error(`Provider 尚未配置：${provider.name}`);
    }
    const trusted = this.capabilityResolver.resolve(
      provider.type,
      provider.apiFormat,
      provider.capabilities,
    );
    if (provider.runtimeType !== trusted.runtimeType
      || trusted.runtimeType !== 'claude-code'
      || !trusted.capabilities.supportsClaudeCode) {
      throw new Error(UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE);
    }
    if (use === 'agent-workflow' && !trusted.capabilities.supportsAgentWorkflow) {
      throw new Error(UNSUPPORTED_AGENT_WORKFLOW_MESSAGE);
    }

    const runtime = this.runtimes.get(trusted.runtimeType);
    if (!runtime?.implemented || !runtime.supports({
      ...provider,
      runtimeType: trusted.runtimeType,
      capabilities: trusted.capabilities,
    })) {
      throw new Error(UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE);
    }
    return runtime;
  }

  async runPrompt(
    provider: RuntimeProviderDescriptor,
    options: ClaudeRunOptions,
    use: AgentRuntimeUse = 'agent-workflow',
  ): Promise<ClaudeRunDescriptor> {
    const runtime = this.assertRunnable(provider, use);
    return runtime.runPrompt(options);
  }
}
