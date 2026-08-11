import type {
  ClaudeEventEnvelope,
  ClaudeInstallationInfo,
  ClaudeRunDescriptor,
  ClaudeRunOptions,
} from '../../shared/types/claude';
import type {
  AgentRuntime,
  AgentRuntimeAdapter,
  RuntimeProviderDescriptor,
} from './AgentRuntime';

/** Keeps the existing Claude adapter as the only implemented Agent runtime. */
export class ClaudeCodeAgentRuntime implements AgentRuntime {
  readonly type = 'claude-code' as const;
  readonly implemented = true;

  constructor(private readonly adapter: AgentRuntimeAdapter) {}

  supports(provider: RuntimeProviderDescriptor): boolean {
    return provider.runtimeType === this.type && provider.capabilities.supportsClaudeCode;
  }

  checkInstallation(): Promise<ClaudeInstallationInfo> {
    return this.adapter.checkInstallation();
  }

  runPrompt(options: ClaudeRunOptions): Promise<ClaudeRunDescriptor> {
    return this.adapter.runPrompt(options);
  }

  stopRun(runId: string): Promise<boolean> {
    return this.adapter.stopRun(runId);
  }

  stopAll(): Promise<void> {
    return this.adapter.stopAll();
  }

  subscribe(listener: (envelope: ClaudeEventEnvelope) => void): () => void {
    return this.adapter.subscribe(listener);
  }
}
