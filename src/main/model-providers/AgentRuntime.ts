import type {
  ClaudeAdapter,
  ClaudeEventEnvelope,
  ClaudeInstallationInfo,
  ClaudeRunDescriptor,
  ClaudeRunOptions,
} from '../../shared/types/claude';
import type {
  AgentRuntimeType,
  ModelApiFormat,
  ModelProviderType,
  ProviderCapabilities,
} from '../../shared/types/modelProviders';

export type AgentRuntimeUse = 'chat' | 'agent-workflow';

export interface RuntimeProviderDescriptor {
  id: string;
  name: string;
  type: ModelProviderType;
  apiFormat: ModelApiFormat;
  runtimeType: AgentRuntimeType;
  enabled: boolean;
  configured: boolean;
  capabilities: ProviderCapabilities;
}

/**
 * Runtime-neutral execution contract. `openai-agent` is a reserved discriminator;
 * no implementation is registered in this phase.
 */
export interface AgentRuntime {
  readonly type: Exclude<AgentRuntimeType, 'none'>;
  readonly implemented: boolean;
  supports(provider: RuntimeProviderDescriptor): boolean;
  checkInstallation(): Promise<ClaudeInstallationInfo>;
  runPrompt(options: ClaudeRunOptions): Promise<ClaudeRunDescriptor>;
  stopRun(runId: string): Promise<boolean>;
  stopAll(): Promise<void>;
  subscribe(listener: (envelope: ClaudeEventEnvelope) => void): () => void;
}

export type AgentRuntimeAdapter = ClaudeAdapter;
