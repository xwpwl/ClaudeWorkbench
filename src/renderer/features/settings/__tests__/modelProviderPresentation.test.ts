import { afterEach, describe, expect, it } from 'vitest';
import type { PublicModelProvider } from '../../../../shared/types/modelProviders';
import { setLocale } from '../../../i18n';
import {
  capabilityPresentations,
  connectionErrorLabel,
  healthPresentation,
  providerTypeLabel,
  runtimeTypeLabel,
  selectableWorkflowProviders,
  supportedUseLabels,
} from '../modelProviderPresentation';

function provider(overrides: Partial<PublicModelProvider> = {}): PublicModelProvider {
  return {
    id: 'mimo',
    name: 'MiMo',
    type: 'anthropic-compatible',
    apiFormat: 'anthropic-messages',
    runtimeType: 'claude-code',
    baseUrl: 'https://api.example.test',
    enabled: true,
    isDefault: true,
    configured: true,
    credentialSource: 'credential_store',
    agentModelStatus: 'valid',
    capabilities: {
      supportsClaudeCode: true,
      supportsAgentWorkflow: true,
      supportsTools: true,
      supportsMCP: true,
      supportsStreaming: true,
      supportsVision: false,
    },
    supportedUses: ['chat', 'agent_task', 'claude_code', 'mcp_tools'],
    health: {
      state: 'connected',
      lastTestedAt: Date.UTC(2026, 7, 9, 10, 20),
      lastErrorType: null,
      latencyMs: 182,
    },
    defaultModelId: 'mimo-v2.5-pro',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

afterEach(() => setLocale('zh-CN'));

describe('model Provider presentation', () => {
  it.each([
    ['anthropic', 'Claude 官方'],
    ['anthropic-compatible', 'Anthropic Compatible'],
    ['openai-compatible', 'OpenAI Compatible'],
    ['custom', '自定义'],
  ] as const)('labels Provider type %s', (type, label) => {
    expect(providerTypeLabel(type)).toBe(label);
  });

  it.each([
    ['claude-code', 'Claude Code Agent Runtime'],
    ['none', '无可用 Agent Runtime'],
    ['openai-agent', 'OpenAI Agent Runtime（尚未实现）'],
  ] as const)('labels runtime %s without pretending it exists', (runtime, label) => {
    expect(runtimeTypeLabel(runtime)).toBe(label);
  });

  it('renders every trusted capability in a stable order', () => {
    expect(capabilityPresentations(provider().capabilities)).toEqual([
      { key: 'supportsClaudeCode', label: 'Claude Code', supported: true },
      { key: 'supportsAgentWorkflow', label: 'Agent Workflow', supported: true },
      { key: 'supportsTools', label: '工具调用', supported: true },
      { key: 'supportsMCP', label: 'MCP', supported: true },
      { key: 'supportsStreaming', label: '流式响应', supported: true },
      { key: 'supportsVision', label: '视觉', supported: false },
    ]);
  });

  it('uses the public supported-use projection rather than guessing from the name', () => {
    expect(supportedUseLabels(provider())).toEqual([
      '普通聊天', 'Agent任务', 'Claude Code', 'MCP工具',
    ]);
  });

  it('does not call a connected OpenAI Provider usable for ordinary Workbench chat', () => {
    const deepSeek = provider({
      id: 'deepseek',
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
      supportedUses: [],
    });
    expect(supportedUseLabels(deepSeek)).toEqual([]);
  });

  it('shows a successful health summary with latency and last test time', () => {
    const result = healthPresentation(provider());
    expect(result.label).toBe('连接成功');
    expect(result.tone).toBe('success');
    expect(result.latency).toBe('182 ms');
    expect(result.lastTested).not.toBe('从未测试');
  });

  it('distinguishes configured but never tested from a successful connection', () => {
    const result = healthPresentation(provider({
      health: { state: 'configured', lastTestedAt: null, lastErrorType: null, latencyMs: null },
    }));
    expect(result.label).toBe('已配置');
    expect(result.lastTested).toBe('从未测试');
    expect(result.latency).toBe('—');
  });

  it('shows a disabled Provider as stopped even when its last connection succeeded', () => {
    const result = healthPresentation(provider({ enabled: false }));
    expect(result.label).toBe('已停用');
    expect(result.tone).toBe('neutral');
    expect(result.latency).toBe('182 ms');
  });

  it('shows categorized errors without raw server bodies', () => {
    const result = healthPresentation(provider({
      health: { state: 'error', lastTestedAt: 10, lastErrorType: 'invalid_key', latencyMs: null },
    }));
    expect(result.label).toBe('连接失败');
    expect(result.error).toBe('API Key 错误');
  });

  it.each([
    ['forbidden', '权限不足'],
    ['not_found', 'URL 或端点错误'],
    ['rate_limited', '请求限流'],
    ['timeout', '连接超时'],
    ['network', '网络错误'],
    ['invalid_response', '响应格式错误'],
    ['unknown', '未知错误'],
  ] as const)('maps public error category %s', (type, label) => {
    expect(connectionErrorLabel(type)).toBe(label);
  });

  it('allows only enabled, configured Claude Workflow Providers in policies', () => {
    const disabled = provider({ id: 'disabled', enabled: false });
    const unconfigured = provider({ id: 'empty', configured: false });
    const rawOpenAI = provider({
      id: 'deepseek',
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
    expect(selectableWorkflowProviders([disabled, unconfigured, rawOpenAI, provider()]))
      .toEqual([provider()]);
  });

  it('keeps a workflow-only Provider for Planner and Reviewer but excludes it from coding roles', () => {
    const workflowOnly = provider({
      id: 'workflow-only',
      agentModelStatus: 'needs_reconfiguration',
      capabilities: {
        ...provider().capabilities,
        supportsTools: false,
        supportsMCP: false,
      },
    });

    expect(selectableWorkflowProviders([workflowOnly], 'planner')).toEqual([workflowOnly]);
    expect(selectableWorkflowProviders([workflowOnly], 'reviewer')).toEqual([workflowOnly]);
    for (const role of ['coder', 'tester', 'fixer', 'default'] as const) {
      expect(selectableWorkflowProviders([workflowOnly], role)).toEqual([]);
    }
  });

  it('localizes Provider, Runtime, health, capability, and supported-use labels in English', () => {
    setLocale('en-US');
    expect(providerTypeLabel('anthropic')).toBe('Claude official');
    expect(runtimeTypeLabel('none')).toBe('No available Agent Runtime');
    expect(healthPresentation(provider()).label).toBe('Connected');
    expect(capabilityPresentations(provider().capabilities).map((item) => item.label))
      .toContain('Tool use');
    expect(supportedUseLabels(provider())).toContain('Chat');
  });
});
