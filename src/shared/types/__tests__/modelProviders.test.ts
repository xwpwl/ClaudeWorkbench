import { describe, expect, it } from 'vitest';
import {
  AGENT_RUNTIME_TYPES,
  IMPLEMENTED_AGENT_RUNTIME_TYPES,
  MODEL_API_FORMATS,
  MODEL_PROVIDER_TYPES,
  MODEL_SELECTION_SOURCES,
  POLICY_RATINGS,
  PROVIDER_CAPABILITY_KEYS,
  PROVIDER_CONNECTION_ERROR_TYPES,
  PROVIDER_HEALTH_STATES,
  PROVIDER_SUPPORTED_USE_LABELS_ZH_CN,
  PROVIDER_SUPPORTED_USES,
  UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE,
  effectiveSourceLabel,
  supportedUsesForCapabilities,
  toPublicModelProvider,
} from '../modelProviders';
import { supportedUsesForCapabilities as supportedUsesFromBarrel } from '..';
import type {
  AgentModelPolicyNotes,
  CreateProviderInput,
  ProviderCapabilities,
  ProviderConnectionResult,
  ProviderModelRef,
  PublicModelProvider,
  ResolvedModelSelection,
  UpdateProviderInput,
} from '../modelProviders';

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    supportsClaudeCode: false,
    supportsAgentWorkflow: false,
    supportsTools: false,
    supportsMCP: false,
    supportsStreaming: false,
    supportsVision: false,
    ...overrides,
  };
}

function publicProvider(overrides: Partial<PublicModelProvider> = {}): PublicModelProvider {
  const providerCapabilities = capabilities({
    supportsClaudeCode: true,
    supportsAgentWorkflow: true,
    supportsTools: true,
    supportsMCP: true,
    supportsStreaming: true,
  });

  return {
    id: 'provider-mimo',
    name: 'MiMo',
    type: 'anthropic-compatible',
    apiFormat: 'anthropic-messages',
    runtimeType: 'claude-code',
    baseUrl: 'https://example.test',
    baseUrlPathRedacted: false,
    enabled: true,
    isDefault: true,
    configured: true,
    credentialSource: 'credential_store',
    capabilities: providerCapabilities,
    supportedUses: ['chat', 'agent_task', 'claude_code', 'mcp_tools'],
    health: {
      state: 'connected',
      lastTestedAt: 1_786_291_200_000,
      lastErrorType: null,
      latencyMs: 142,
    },
    defaultModelId: 'mimo-v2.5-pro',
    createdAt: 1_786_291_100_000,
    updatedAt: 1_786_291_200_000,
    ...overrides,
  };
}

describe('model provider contracts', () => {
  it('exposes the four provider types and two API formats', () => {
    expect(MODEL_PROVIDER_TYPES).toEqual([
      'anthropic',
      'anthropic-compatible',
      'openai-compatible',
      'custom',
    ]);
    expect(MODEL_API_FORMATS).toEqual(['anthropic-messages', 'openai-chat-completions']);
  });

  it('keeps exactly the six approved capability fields', () => {
    expect(PROVIDER_CAPABILITY_KEYS).toEqual([
      'supportsClaudeCode',
      'supportsAgentWorkflow',
      'supportsTools',
      'supportsMCP',
      'supportsStreaming',
      'supportsVision',
    ]);
  });

  it('projects every user-facing use from trusted capabilities in a stable order', () => {
    expect(
      supportedUsesForCapabilities(
        capabilities({
          supportsClaudeCode: true,
          supportsAgentWorkflow: true,
          supportsTools: true,
          supportsMCP: true,
          supportsStreaming: true,
          supportsVision: true,
        }),
      ),
    ).toEqual(['chat', 'agent_task', 'claude_code', 'mcp_tools', 'vision']);
    expect(PROVIDER_SUPPORTED_USES).toEqual([
      'chat',
      'agent_task',
      'claude_code',
      'mcp_tools',
      'vision',
    ]);
  });

  it('requires Claude Code capability before advertising ordinary chat', () => {
    expect(
      supportedUsesForCapabilities(
        capabilities({ supportsTools: true, supportsStreaming: true }),
      ),
    ).toEqual([]);
    expect(
      supportedUsesForCapabilities(capabilities({ supportsClaudeCode: true })),
    ).toEqual(['chat', 'claude_code']);
  });

  it('does not turn generic tools or streaming into unsupported user-facing uses', () => {
    expect(
      supportedUsesForCapabilities(
        capabilities({
          supportsAgentWorkflow: true,
          supportsTools: true,
          supportsMCP: true,
          supportsStreaming: true,
          supportsVision: true,
        }),
      ),
    ).toEqual(['agent_task', 'mcp_tools', 'vision']);
  });

  it('exports friendly Chinese labels without collapsing capability meanings', () => {
    expect(PROVIDER_SUPPORTED_USE_LABELS_ZH_CN).toEqual({
      chat: '普通聊天',
      agent_task: 'Agent任务',
      claude_code: 'Claude Code',
      mcp_tools: 'MCP工具',
      vision: '视觉任务',
    });
  });

  it('reserves OpenAI Agent runtime without marking it implemented', () => {
    expect(AGENT_RUNTIME_TYPES).toEqual(['claude-code', 'none', 'openai-agent']);
    expect(IMPLEMENTED_AGENT_RUNTIME_TYPES).toEqual(['claude-code']);
    expect(UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE).toBe(
      '当前 Provider 不支持 Claude Code Agent Runtime',
    );
  });

  it('defines health states and sanitized connection error categories', () => {
    expect(PROVIDER_HEALTH_STATES).toEqual([
      'not_configured',
      'configured',
      'connected',
      'error',
    ]);
    expect(PROVIDER_CONNECTION_ERROR_TYPES).toEqual([
      'invalid_key',
      'forbidden',
      'not_found',
      'rate_limited',
      'timeout',
      'network',
      'invalid_response',
      'unknown',
    ]);
  });

  it('maps internal resolution sources to the approved current-source labels', () => {
    expect(MODEL_SELECTION_SOURCES).toEqual([
      'task_override',
      'project_policy',
      'global_agent_policy',
      'global_default',
      'environment',
      'claude_code',
    ]);
    expect(effectiveSourceLabel('task_override')).toBe('任务覆盖');
    expect(effectiveSourceLabel('project_policy')).toBe('项目策略');
    expect(effectiveSourceLabel('global_agent_policy')).toBe('全局默认');
    expect(effectiveSourceLabel('global_default')).toBe('全局默认');
    expect(effectiveSourceLabel('environment')).toBe('环境变量');
    expect(effectiveSourceLabel('claude_code')).toBe('Claude Code');
  });

  it('keeps cost, speed, and quality ratings informational and nullable', () => {
    expect(POLICY_RATINGS).toEqual(['low', 'medium', 'high']);
    const notes: AgentModelPolicyNotes = {
      quality: 'high',
      speed: 'medium',
      cost: 'high',
    };
    const emptyNotes: AgentModelPolicyNotes = { quality: null, speed: null, cost: null };
    expect(notes).toEqual({ quality: 'high', speed: 'medium', cost: 'high' });
    expect(emptyNotes).toEqual({ quality: null, speed: null, cost: null });
  });

  it('creates a renderer-safe projection and recomputes supported uses', () => {
    const source = {
      ...publicProvider({ supportedUses: ['vision'] }),
      apiKey: 'sentinel-api-key',
      secret: 'sentinel-secret',
      credentialRef: 'safe-storage://v1/private-ref',
      encryptedBlob: 'sentinel-ciphertext',
    };

    const projected = toPublicModelProvider(source);
    const serialized = JSON.stringify(projected);

    expect(projected.supportedUses).toEqual(['chat', 'agent_task', 'claude_code', 'mcp_tools']);
    expect(projected.agentModelStatus).toBe('valid');
    expect(serialized).not.toContain('sentinel');
    expect(serialized).not.toContain('credentialRef');
    expect(serialized).not.toContain('apiKey');
    expect(Object.keys(projected).sort()).toEqual(
      [
        'agentModelStatus',
        'apiFormat',
        'baseUrl',
        'baseUrlPathRedacted',
        'capabilities',
        'configured',
        'createdAt',
        'credentialSource',
        'defaultModelId',
        'enabled',
        'health',
        'id',
        'isDefault',
        'name',
        'runtimeType',
        'supportedUses',
        'type',
        'updatedAt',
      ].sort(),
    );
  });

  it('exports the supported-use projection through the shared barrel', () => {
    expect(supportedUsesFromBarrel(capabilities({ supportsMCP: true }))).toEqual(['mcp_tools']);
  });

  it('provides typed model, selection, connection, create, and update DTOs', () => {
    const model: ProviderModelRef = { providerId: 'provider-mimo', modelId: 'mimo-v2.5-pro' };
    const selection: ResolvedModelSelection = {
      ...model,
      providerName: 'MiMo',
      runtimeType: 'claude-code',
      capabilities: capabilities({ supportsClaudeCode: true }),
      source: 'task_override',
    };
    const success: ProviderConnectionResult = {
      ok: true,
      testedAt: 1_786_291_200_000,
      latencyMs: 142,
      discoveredModelIds: ['mimo-v2.5-pro'],
    };
    const create: CreateProviderInput = { validationToken: 'validation-token' };
    const update: UpdateProviderInput = {
      providerId: 'provider-mimo',
      validationToken: 'replacement-token',
    };

    expect(selection.source).toBe('task_override');
    expect(success.discoveredModelIds).toEqual(['mimo-v2.5-pro']);
    expect(create.validationToken).toBe('validation-token');
    expect(update.providerId).toBe('provider-mimo');
  });
});
