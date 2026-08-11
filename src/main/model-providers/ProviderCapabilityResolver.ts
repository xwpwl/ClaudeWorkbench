import type {
  AgentRuntimeType,
  ModelApiFormat,
  ModelProviderType,
  ProviderCapabilities,
} from '../../shared/types/modelProviders';

export interface ResolvedProviderCapabilities {
  runtimeType: AgentRuntimeType;
  capabilities: ProviderCapabilities;
}

const NO_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  supportsClaudeCode: false,
  supportsAgentWorkflow: false,
  supportsTools: false,
  supportsMCP: false,
  supportsStreaming: false,
  supportsVision: false,
});

const ANTHROPIC_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  supportsClaudeCode: true,
  supportsAgentWorkflow: true,
  supportsTools: true,
  supportsMCP: true,
  supportsStreaming: true,
  supportsVision: true,
});

const ANTHROPIC_COMPATIBLE_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  ...ANTHROPIC_CAPABILITIES,
  supportsVision: false,
});

const OPENAI_COMPATIBLE_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  supportsClaudeCode: false,
  supportsAgentWorkflow: false,
  supportsTools: true,
  supportsMCP: false,
  supportsStreaming: true,
  supportsVision: false,
});

const CUSTOM_ANTHROPIC_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  supportsClaudeCode: true,
  supportsAgentWorkflow: true,
  supportsTools: true,
  supportsMCP: true,
  supportsStreaming: true,
  supportsVision: false,
});

function envelope(
  type: ModelProviderType,
  apiFormat: ModelApiFormat,
): ResolvedProviderCapabilities {
  if (apiFormat === 'anthropic-messages') {
    if (type === 'anthropic') {
      return { runtimeType: 'claude-code', capabilities: { ...ANTHROPIC_CAPABILITIES } };
    }
    if (type === 'anthropic-compatible') {
      return {
        runtimeType: 'claude-code',
        capabilities: { ...ANTHROPIC_COMPATIBLE_CAPABILITIES },
      };
    }
    if (type === 'custom') {
      return {
        runtimeType: 'claude-code',
        capabilities: { ...CUSTOM_ANTHROPIC_CAPABILITIES },
      };
    }
  }

  if (apiFormat === 'openai-chat-completions') {
    if (type === 'openai-compatible' || type === 'custom') {
      return { runtimeType: 'none', capabilities: { ...OPENAI_COMPATIBLE_CAPABILITIES } };
    }
  }

  return { runtimeType: 'none', capabilities: { ...NO_CAPABILITIES } };
}

function narrowCapabilities(
  maximum: ProviderCapabilities,
  requested?: Partial<ProviderCapabilities>,
): ProviderCapabilities {
  const supportsClaudeCode = maximum.supportsClaudeCode
    && requested?.supportsClaudeCode !== false;
  const supportsTools = maximum.supportsTools && requested?.supportsTools !== false;
  return {
    supportsClaudeCode,
    supportsAgentWorkflow: maximum.supportsAgentWorkflow
      && requested?.supportsAgentWorkflow !== false
      && supportsClaudeCode,
    supportsTools,
    supportsMCP: maximum.supportsMCP
      && requested?.supportsMCP !== false
      && supportsTools,
    supportsStreaming: maximum.supportsStreaming && requested?.supportsStreaming !== false,
    supportsVision: maximum.supportsVision && requested?.supportsVision !== false,
  };
}

export function resolveProviderRuntime(
  type: ModelProviderType,
  apiFormat: ModelApiFormat,
): AgentRuntimeType {
  return envelope(type, apiFormat).runtimeType;
}

export function resolveProviderCapabilities(
  type: ModelProviderType,
  apiFormat: ModelApiFormat,
  requested?: Partial<ProviderCapabilities>,
): ProviderCapabilities {
  return narrowCapabilities(envelope(type, apiFormat).capabilities, requested);
}

export class ProviderCapabilityResolver {
  resolve(
    type: ModelProviderType,
    apiFormat: ModelApiFormat,
    requested?: Partial<ProviderCapabilities>,
  ): ResolvedProviderCapabilities {
    const maximum = envelope(type, apiFormat);
    return {
      runtimeType: maximum.runtimeType,
      capabilities: narrowCapabilities(maximum.capabilities, requested),
    };
  }
}
