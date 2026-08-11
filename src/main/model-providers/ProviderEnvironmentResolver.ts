import type {
  ModelApiFormat,
  ModelProviderType,
  ResolvedModelSelection,
} from '../../shared/types/modelProviders';
import { UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE } from '../../shared/types/modelProviders';
import { resolveProviderCapabilities } from './ProviderCapabilityResolver';
import { normalizeProviderBaseUrl } from './ProviderConnectionTester';

const PROVIDER_ENVIRONMENT_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

export interface ProviderExecutionBinding {
  providerId: string;
  type: ModelProviderType;
  apiFormat: ModelApiFormat;
  baseUrl: string | null;
  credential: string | null;
  source: 'application' | 'environment' | 'claude_code';
}

type Environment = Record<string, string | undefined>;

export class ProviderEnvironmentResolver {
  buildChildEnvironment(
    inherited: Readonly<Environment>,
    binding: ProviderExecutionBinding,
  ): Environment {
    const child = { ...inherited };
    if (binding.source === 'environment' || binding.source === 'claude_code') return child;

    if (binding.apiFormat !== 'anthropic-messages'
      || (binding.type !== 'anthropic'
        && binding.type !== 'anthropic-compatible'
        && binding.type !== 'custom')) {
      throw new Error(UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE);
    }
    if (!binding.credential || binding.credential.includes('\0')) {
      throw new Error('Provider credential is unavailable or invalid.');
    }
    if (!binding.baseUrl) throw new Error('Provider Base URL is required.');

    let baseUrl: string;
    try {
      baseUrl = normalizeProviderBaseUrl(binding.baseUrl);
    } catch {
      throw new Error('Provider Base URL is invalid.');
    }
    for (const key of PROVIDER_ENVIRONMENT_KEYS) delete child[key];
    child.ANTHROPIC_BASE_URL = baseUrl;
    if (binding.type === 'anthropic') child.ANTHROPIC_API_KEY = binding.credential;
    else child.ANTHROPIC_AUTH_TOKEN = binding.credential;
    return child;
  }

  describeInheritedEnvironment(
    inherited: Readonly<Environment>,
    modelId: string,
  ): ResolvedModelSelection | null {
    const configured = Boolean(inherited.ANTHROPIC_API_KEY || inherited.ANTHROPIC_AUTH_TOKEN);
    if (!configured) return null;
    return {
      providerId: 'environment:anthropic',
      providerName: '环境变量',
      modelId: modelId.trim() || 'default',
      runtimeType: 'claude-code',
      executionSource: 'environment',
      capabilities: resolveProviderCapabilities(
        inherited.ANTHROPIC_BASE_URL ? 'anthropic-compatible' : 'anthropic',
        'anthropic-messages',
      ),
      source: 'environment',
    };
  }
}

export const providerEnvironmentInternals = {
  PROVIDER_ENVIRONMENT_KEYS,
};
