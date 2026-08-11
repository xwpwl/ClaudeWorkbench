import type { ClaudeRunOptions } from '../../shared/types/claude';
import { UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE } from '../../shared/types/modelProviders';
import type { ProviderEnvironmentPort } from '../claude/ClaudeCliAdapter';
import { ProviderCapabilityResolver } from './ProviderCapabilityResolver';
import {
  ProviderEnvironmentResolver,
  type ProviderExecutionBinding,
} from './ProviderEnvironmentResolver';
import type { StoredModelProvider, StoredProviderModel } from './ModelProviderService';

export interface ProviderExecutionRepository {
  getProvider(providerId: string): StoredModelProvider | null;
  listModels(providerId: string): StoredProviderModel[];
}

export interface ProviderExecutionCredentialStore {
  read(reference: string): string;
}

export class ProviderExecutionEnvironmentService implements ProviderEnvironmentPort {
  private readonly capabilities = new ProviderCapabilityResolver();

  constructor(
    private readonly repository: ProviderExecutionRepository,
    private readonly credentials: ProviderExecutionCredentialStore,
    private readonly environment: ProviderEnvironmentResolver,
  ) {}

  resolveChildEnvironment(
    options: Readonly<ClaudeRunOptions>,
    inherited: Readonly<NodeJS.ProcessEnv>,
  ): NodeJS.ProcessEnv {
    const providerId = options.modelProviderId?.trim();
    if (!providerId) throw new Error('Main-process Provider identity is required.');
    const selection = options.resolvedModelSelection;
    if (!selection
      || selection.providerId !== providerId
      || selection.runtimeType !== 'claude-code') {
      throw new Error('Main-process resolved Provider identity is required.');
    }
    const modelIntent = options.model?.trim();
    const usesClaudeDefault = selection.executionSource === 'claude_code'
      && selection.modelId === 'default';
    if ((!modelIntent && !usesClaudeDefault)
      || (modelIntent && modelIntent !== selection.modelId)) {
      throw new Error('Main-process model identity does not match the resolved selection.');
    }
    if (selection.executionSource === 'environment'
      || selection.executionSource === 'claude_code') {
      return this.environment.buildChildEnvironment(
        inherited,
        syntheticBinding(providerId, selection.executionSource),
      );
    }
    if (selection.executionSource !== 'database_provider') {
      throw new Error('Main-process execution source is invalid.');
    }

    const provider = this.repository.getProvider(providerId);
    if (!provider) throw new Error('Selected Provider was not found.');
    if (!provider.enabled) throw new Error(`Selected Provider is disabled: ${provider.name}`);
    if (!provider.credentialRef) throw new Error(`Selected Provider is not configured: ${provider.name}`);

    const modelId = selection.modelId.trim();
    if (!modelId) throw new Error('Main-process model identity is required.');
    if (!this.repository.listModels(provider.id).some((model) => model.modelId === modelId)) {
      throw new Error('Selected model does not belong to the Provider.');
    }

    const trusted = this.capabilities.resolve(
      provider.type,
      provider.apiFormat,
      provider.capabilities,
    );
    if (trusted.runtimeType !== 'claude-code' || !trusted.capabilities.supportsClaudeCode) {
      throw new Error(UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE);
    }
    if (options.workflowContext && !trusted.capabilities.supportsAgentWorkflow) {
      throw new Error('Current Provider does not support Agent Workflow.');
    }
    if (options.workflowContext
      && (options.workflowContext.stage === 'coder' || options.workflowContext.stage === 'tester')
      && (!trusted.capabilities.supportsTools || !trusted.capabilities.supportsMCP)) {
      throw new Error('Current Agent role requires Provider tools and MCP capabilities.');
    }

    const credential = this.credentials.read(provider.credentialRef);
    return this.environment.buildChildEnvironment(inherited, {
      providerId: provider.id,
      type: provider.type,
      apiFormat: provider.apiFormat,
      baseUrl: provider.baseUrl,
      credential,
      source: 'application',
    });
  }
}

function syntheticBinding(
  providerId: string,
  source: 'environment' | 'claude_code',
): ProviderExecutionBinding {
  return {
    providerId,
    type: 'anthropic',
    apiFormat: 'anthropic-messages',
    baseUrl: null,
    credential: null,
    source,
  };
}
