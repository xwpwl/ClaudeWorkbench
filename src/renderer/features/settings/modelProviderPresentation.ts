import {
  type AgentRuntimeType,
  type ModelProviderType,
  type ModelPolicyAgentType,
  type ProviderCapabilities,
  type ProviderConnectionErrorType,
  type ProviderSupportedUse,
  type PublicModelProvider,
} from '../../../shared/types/modelProviders';
import { getLocale, t, type LocaleKey } from '../../i18n';

export interface CapabilityPresentation {
  key: keyof ProviderCapabilities;
  label: string;
  supported: boolean;
}

export interface ProviderHealthPresentation {
  label: string;
  tone: 'neutral' | 'success' | 'danger';
  lastTested: string;
  latency: string;
  error: string | null;
}

const TYPE_LABELS: Readonly<Record<ModelProviderType, LocaleKey>> = {
  anthropic: 'provider.type.anthropic',
  'anthropic-compatible': 'provider.type.anthropicCompatible',
  'openai-compatible': 'provider.type.openaiCompatible',
  custom: 'provider.type.custom',
};

const RUNTIME_LABELS: Readonly<Record<AgentRuntimeType, LocaleKey>> = {
  'claude-code': 'provider.runtime.claudeCode',
  none: 'provider.runtime.none',
  'openai-agent': 'provider.runtime.openaiAgent',
};

const CONNECTION_ERROR_LABELS: Readonly<Record<ProviderConnectionErrorType, LocaleKey>> = {
  invalid_key: 'provider.error.invalidKey',
  forbidden: 'provider.error.forbidden',
  not_found: 'provider.error.notFound',
  rate_limited: 'provider.error.rateLimited',
  timeout: 'provider.error.timeout',
  network: 'provider.error.network',
  invalid_response: 'provider.error.invalidResponse',
  unknown: 'provider.error.unknown',
};

const SUPPORTED_USE_LABELS: Readonly<Record<ProviderSupportedUse, LocaleKey>> = {
  chat: 'provider.use.chat',
  agent_task: 'provider.use.agentTask',
  claude_code: 'provider.use.claudeCode',
  mcp_tools: 'provider.use.mcpTools',
  vision: 'provider.use.vision',
};

export function providerTypeLabel(type: ModelProviderType): string {
  return t(TYPE_LABELS[type]);
}

export function runtimeTypeLabel(runtime: AgentRuntimeType): string {
  return t(RUNTIME_LABELS[runtime]);
}

export function connectionErrorLabel(type: ProviderConnectionErrorType): string {
  return t(CONNECTION_ERROR_LABELS[type]);
}

export function capabilityPresentations(
  capabilities: ProviderCapabilities,
): CapabilityPresentation[] {
  return [
    { key: 'supportsClaudeCode', label: t('provider.capability.claudeCode'), supported: capabilities.supportsClaudeCode },
    { key: 'supportsAgentWorkflow', label: t('provider.capability.agentWorkflow'), supported: capabilities.supportsAgentWorkflow },
    { key: 'supportsTools', label: t('provider.capability.tools'), supported: capabilities.supportsTools },
    { key: 'supportsMCP', label: t('provider.capability.mcp'), supported: capabilities.supportsMCP },
    { key: 'supportsStreaming', label: t('provider.capability.streaming'), supported: capabilities.supportsStreaming },
    { key: 'supportsVision', label: t('provider.capability.vision'), supported: capabilities.supportsVision },
  ];
}

export function supportedUseLabels(provider: PublicModelProvider): string[] {
  return provider.supportedUses.map((use) => t(SUPPORTED_USE_LABELS[use]));
}

export function healthPresentation(provider: PublicModelProvider): ProviderHealthPresentation {
  const { health } = provider;
  const label = !provider.enabled
    ? t('provider.health.disabled')
    : health.state === 'connected'
    ? t('provider.health.connected')
    : health.state === 'error'
      ? t('provider.health.failed')
      : provider.configured
        ? t('provider.health.configured')
        : t('provider.health.unconfigured');
  return {
    label,
    tone: !provider.enabled
      ? 'neutral'
      : health.state === 'connected'
        ? 'success'
        : health.state === 'error'
          ? 'danger'
          : 'neutral',
    lastTested: health.lastTestedAt === null
      ? t('provider.health.neverTested')
      : new Intl.DateTimeFormat(getLocale(), {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).format(new Date(health.lastTestedAt)),
    latency: health.latencyMs === null ? '—' : `${health.latencyMs} ms`,
    error: health.lastErrorType ? connectionErrorLabel(health.lastErrorType) : null,
  };
}

export function selectableWorkflowProviders(
  providers: readonly PublicModelProvider[],
  role?: ModelPolicyAgentType | 'default',
): PublicModelProvider[] {
  const requiresCodingCapabilities = role === 'coder'
    || role === 'tester'
    || role === 'fixer'
    || role === 'default';
  return providers.filter((provider) => (
    provider.enabled
    && provider.configured
    && provider.runtimeType === 'claude-code'
    && provider.capabilities.supportsClaudeCode
    && provider.capabilities.supportsAgentWorkflow
    && (!requiresCodingCapabilities || (
      provider.capabilities.supportsTools && provider.capabilities.supportsMCP
    ))
  ));
}
