import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentModelPolicyAssignment,
  ProviderConnectionResult,
  ProviderDraftInput,
  ProviderModel,
  PublicModelProvider,
} from '../../../../shared/types/modelProviders';
import {
  AgentModelPolicyEditor,
  ModelProviderCenterView,
  ProjectModelPolicyEditor,
  ProviderEditor,
  confirmAndDeleteProvider,
  deleteProviderFromCenter,
  loadAgentPolicyEditorData,
  persistAgentPolicyChange,
  persistProjectPolicyChange,
  startProviderPageSync,
  validateDraftAndClearCredential,
} from '../ModelProviderCenter';
import * as providerCenterModule from '../ModelProviderCenter';
import { setLocale } from '../../../i18n';

afterEach(() => setLocale('zh-CN'));

const capabilities = {
  supportsClaudeCode: true,
  supportsAgentWorkflow: true,
  supportsTools: true,
  supportsMCP: true,
  supportsStreaming: true,
  supportsVision: false,
};

function provider(overrides: Partial<PublicModelProvider> = {}): PublicModelProvider {
  return {
    id: 'mimo', name: 'MiMo', type: 'anthropic-compatible', apiFormat: 'anthropic-messages',
    runtimeType: 'claude-code', baseUrl: 'https://api.example.test', enabled: true,
    baseUrlPathRedacted: false,
    isDefault: false, configured: true, credentialSource: 'credential_store', capabilities,
    supportedUses: ['chat', 'agent_task', 'claude_code', 'mcp_tools'],
    health: { state: 'connected', lastTestedAt: Date.UTC(2026, 7, 9), lastErrorType: null, latencyMs: 92 },
    defaultModelId: 'mimo-v2.5-pro', createdAt: 1, updatedAt: 2, ...overrides,
  };
}

const models: ProviderModel[] = [
  { providerId: 'mimo', modelId: 'mimo-v2.5-pro', displayName: 'MiMo Pro', source: 'manual', createdAt: 1, updatedAt: 1 },
  { providerId: 'mimo', modelId: 'mimo-v2.5-fast', displayName: null, source: 'discovered', createdAt: 1, updatedAt: 1 },
];

const noop = () => {};

function viewMarkup(overrides: Partial<React.ComponentProps<typeof ModelProviderCenterView>> = {}) {
  return renderToStaticMarkup(React.createElement(ModelProviderCenterView, {
    providers: [provider()], total: 1, offset: 0, limit: 25, selectedProviderId: 'mimo',
    selectedProvider: provider(), models, loading: false, busyAction: null, error: null,
    onSelectProvider: noop, onAdd: noop, onEdit: noop, onTest: noop, onSetDefault: noop,
    onSetEnabled: noop, onRefreshModels: noop, onDelete: noop, onPageChange: noop, ...overrides,
  }));
}

describe('ModelProviderCenterView', () => {
  it('uses compact single-column Provider cards at the settings width', () => {
    const html = viewMarkup();
    expect(html).toContain('data-testid="provider-card-list"');
    expect(html).toContain('data-narrow-safe="true"');
    expect(html).not.toContain('grid-cols-[190px_minmax(0,1fr)]');
    expect(html).toContain('mimo-v2.5-pro');
    expect(html).toContain('92 ms');
    expect(html).toContain('普通聊天');
  });

  it('keeps API format, origin-only URL, capabilities, and advanced actions in expandable details', () => {
    const html = viewMarkup({
      selectedProvider: provider({
        baseUrl: 'https://gateway.example',
        baseUrlPathRedacted: true,
      }),
    });
    expect(html).toContain('data-testid="provider-advanced-details"');
    expect(html).toContain('<summary');
    expect(html).toContain('https://gateway.example');
    expect(html).toContain('Endpoint path is hidden');
    expect(html).not.toContain('private-gateway-path-token-sentinel');
  });
  it('refreshes the current page after Provider events instead of resetting to page one', async () => {
    let current = { offset: 0, selectedProviderId: null as string | null };
    let providerChanged: (() => void) | null = null;
    const loadPage = vi.fn(async () => {});
    const unsubscribe = vi.fn();
    const stop = startProviderPageSync({
      loadPage,
      getCurrent: () => current,
      subscribe: (listener) => {
        providerChanged = listener;
        return unsubscribe;
      },
    });
    expect(loadPage).toHaveBeenNthCalledWith(1, 0);
    current = { offset: 50, selectedProviderId: 'provider-51' };
    providerChanged?.();
    await Promise.resolve();
    expect(loadPage).toHaveBeenNthCalledWith(2, 50, 'provider-51');
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('renders a paginated Provider list and selected details', () => {
    const html = viewMarkup({ total: 51 });
    expect(html).toContain('data-testid="model-provider-list"');
    expect(html).toContain('MiMo');
    expect(html).toContain('第 1 / 3 页');
    expect(html).toContain('mimo-v2.5-pro');
  });

  it('renders type, runtime, sanitized URL, and credential status', () => {
    const html = viewMarkup();
    expect(html).toContain('Anthropic Compatible');
    expect(html).toContain('Claude Code Agent Runtime');
    expect(html).toContain('https://api.example.test');
    expect(html).toContain('凭证安全存储');
    expect(html).not.toContain('credential_ref');
  });

  it('renders all six capability facts and friendly supported uses', () => {
    const html = viewMarkup();
    expect((html.match(/data-testid="provider-capability"/g) ?? [])).toHaveLength(6);
    for (const label of ['普通聊天', 'Agent任务', 'Claude Code', 'MCP工具']) {
      expect(html).toContain(label);
    }
  });

  it('shows connection health, last test, and latency', () => {
    const html = viewMarkup();
    expect(html).toContain('连接成功');
    expect(html).toContain('最近测试');
    expect(html).toContain('92 ms');
  });

  it('distinguishes discovered and manually entered models', () => {
    const html = viewMarkup();
    expect(html).toContain('手动添加');
    expect(html).toContain('连接发现');
    expect(html).toContain('mimo-v2.5-fast');
  });

  it('renders the exact unsupported warning for raw OpenAI Providers', () => {
    const deepSeek = provider({
      id: 'deepseek', name: 'DeepSeek', type: 'openai-compatible', apiFormat: 'openai-chat-completions',
      runtimeType: 'none', capabilities: { ...capabilities, supportsClaudeCode: false, supportsAgentWorkflow: false, supportsMCP: false },
      supportedUses: [], defaultModelId: 'deepseek-chat',
    });
    const html = viewMarkup({ providers: [deepSeek], selectedProviderId: deepSeek.id, selectedProvider: deepSeek, models: [] });
    expect(html).toContain('已配置，可测试；当前不支持 Claude Code Agent。');
    expect(html).toContain('当前 Provider 不支持 Claude Code Agent Runtime');
    expect(html).toContain('data-testid="test-provider"');
    expect(html).not.toContain('data-testid="set-default-provider"');
  });

  it('marks a legacy management-only default as needing reconfiguration', () => {
    const deepSeek = provider({
      id: 'deepseek', name: 'DeepSeek', type: 'openai-compatible',
      apiFormat: 'openai-chat-completions', runtimeType: 'none', isDefault: true,
      agentModelStatus: 'needs_reconfiguration',
      capabilities: { ...capabilities, supportsClaudeCode: false, supportsAgentWorkflow: false, supportsMCP: false },
      supportedUses: [], defaultModelId: 'deepseek-chat',
    });
    const html = viewMarkup({
      providers: [deepSeek], selectedProviderId: deepSeek.id,
      selectedProvider: deepSeek, models: [],
    });
    expect(html).toContain('需要重新配置');
    expect(html).toContain('该模型当前不能用于 Agent，请重新选择。');
  });

  it('keeps connected OpenAI Providers available for management and connection tests', () => {
    const deepSeek = provider({ id: 'deepseek', name: 'DeepSeek', runtimeType: 'none' });
    const html = viewMarkup({ providers: [deepSeek], selectedProvider: deepSeek, selectedProviderId: deepSeek.id });
    expect(html).toContain('data-testid="edit-provider"');
    expect(html).toContain('data-testid="test-provider"');
    expect(html).toContain('data-testid="delete-provider"');
  });

  it('shows distinct disable and refresh-model actions for an enabled Provider', () => {
    const html = viewMarkup();
    expect(html).toContain('data-testid="disable-provider"');
    expect(html).toContain('停用');
    expect(html).toContain('data-testid="refresh-provider-models"');
    expect(html).toContain('刷新模型');
  });

  it('allows a disabled Provider to be re-enabled but not probed before that', () => {
    const disabled = provider({ enabled: false, isDefault: false });
    const html = viewMarkup({ providers: [disabled], selectedProvider: disabled, selectedProviderId: disabled.id });
    expect(html).toContain('data-testid="enable-provider"');
    expect(html).toContain('启用');
    expect(html).not.toContain('data-testid="refresh-provider-models"');
    expect(html).not.toContain('data-testid="test-provider"');
  });

  it('renders loading, error, and empty states without dumping raw objects', () => {
    expect(viewMarkup({ loading: true })).toContain('正在加载模型供应商');
    expect(viewMarkup({ error: '无法读取 Provider', loading: false })).toContain('无法读取 Provider');
    const empty = viewMarkup({ providers: [], total: 0, selectedProviderId: null, selectedProvider: null, models: [] });
    expect(empty).toContain('尚未添加模型供应商');
    expect(empty).toContain('role="region"');
    expect(empty).toContain('aria-labelledby=');
  });

  it('renders the complete touched Provider card and advanced surface in English', () => {
    setLocale('en-US');
    const html = viewMarkup();
    for (const label of [
      'Model providers', 'Add Provider', 'Default model', 'Last tested',
      'Advanced details and actions', 'Test connection', 'Refresh models', 'Edit',
      'Set as default', 'Disable', 'Delete', 'Provider type', 'Runtime type',
      'API format', 'Base URL', 'Authentication', 'Connection status', 'Latency',
      'Capabilities', 'Supported uses', 'Model list', 'Manually added', 'Discovered',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).not.toMatch(/模型供应商|添加供应商|测试连接|刷新模型|设为默认|停用|删除|连接状态|支持用途|模型列表|手动添加|连接发现/iu);
  });
});

describe('ProviderEditor credential boundary', () => {
  const draft: ProviderDraftInput = {
    name: 'MiMo', type: 'anthropic-compatible', apiFormat: 'anthropic-messages',
    baseUrlIntent: { mode: 'replace', value: 'https://api.example.test' },
    credential: null, defaultModelId: 'mimo-v2.5-pro',
  };

  it('uses a password field that never receives a stored credential value', () => {
    const html = renderToStaticMarkup(React.createElement(ProviderEditor, {
      mode: 'edit', initialProvider: provider(), busy: false, onCancel: noop, onSaved: noop,
    }));
    expect(html).toContain('type="password"');
    expect(html).toContain('value=""');
    expect(html).toContain('已保存的 API Key 不可查看，只能替换');
    expect(html).not.toContain('credential_store://');
  });

  it('initializes a redacted endpoint as preserve-only state and explains the hidden path', () => {
    const redacted = provider({
      baseUrl: 'https://gateway.example',
      baseUrlPathRedacted: true,
    });
    const draftFromProvider = (providerCenterModule as unknown as {
      draftFromProvider?: (value: PublicModelProvider | null) => ProviderDraftInput;
    }).draftFromProvider;
    const initialDraft = draftFromProvider?.(redacted);
    const html = renderToStaticMarkup(React.createElement(ProviderEditor, {
      mode: 'edit', initialProvider: redacted, busy: false, onCancel: noop, onSaved: noop,
    }));

    expect(initialDraft).toMatchObject({
      providerId: 'mimo',
      baseUrlIntent: { mode: 'preserve_existing' },
    });
    expect(JSON.stringify(initialDraft)).not.toContain('private-gateway-path-token-sentinel');
    expect(html).toContain('https://gateway.example');
    expect(html).toContain('端点路径已隐藏；在你编辑 Base URL 前，它将保持不变。');
    expect(html).not.toContain('Endpoint path is hidden and will remain unchanged until you edit Base URL.');
    expect(html).toContain('Provider');
    expect(html).toContain('Base URL');
    expect(html).not.toContain('private-gateway-path-token-sentinel');
  });

  it('switches preserve intent to explicit replacement on every Base URL input edit', () => {
    const preserved = {
      providerId: 'mimo',
      name: 'MiMo',
      type: 'anthropic-compatible',
      apiFormat: 'anthropic-messages',
      baseUrlIntent: { mode: 'preserve_existing' },
      credential: null,
      defaultModelId: 'mimo-v2.5-pro',
    } as ProviderDraftInput;
    const replaceProviderBaseUrl = (providerCenterModule as unknown as {
      replaceProviderBaseUrl?: (
        value: ProviderDraftInput,
        replacement: string | null,
      ) => ProviderDraftInput;
    }).replaceProviderBaseUrl;

    expect(replaceProviderBaseUrl?.(
      preserved,
      'https://gateway.example/anthropic/new-private-path',
    )).toEqual({
      ...preserved,
      baseUrlIntent: {
        mode: 'replace',
        value: 'https://gateway.example/anthropic/new-private-path',
      },
    });
  });

  it('validates preserve without a path and sends an explicit replacement only after user edit', async () => {
    const connection: ProviderConnectionResult = {
      ok: true,
      testedAt: 10,
      latencyMs: 20,
      discoveredModelIds: [],
    };
    const preserve = {
      providerId: 'mimo',
      name: 'MiMo renamed',
      type: 'anthropic-compatible',
      apiFormat: 'anthropic-messages',
      baseUrlIntent: { mode: 'preserve_existing' },
      credential: null,
      defaultModelId: 'mimo-v2.5-pro',
    } as ProviderDraftInput;
    const replacement = {
      ...preserve,
      baseUrlIntent: {
        mode: 'replace',
        value: 'https://gateway.example/anthropic/new-private-path',
      },
    } as ProviderDraftInput;
    const validate = vi.fn(async () => ({ validationToken: 'token', connection }));
    const clear = vi.fn();

    await validateDraftAndClearCredential(preserve, '', validate, clear);
    await validateDraftAndClearCredential(replacement, 'replacement-secret', validate, clear);

    expect(validate).toHaveBeenNthCalledWith(1, { ...preserve, credential: null });
    expect(validate).toHaveBeenNthCalledWith(2, {
      ...replacement,
      credential: 'replacement-secret',
    });
    expect(clear).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(validate).mock.calls[0])).not.toContain(
      'private-gateway-path-token-sentinel',
    );
  });

  it('disables save before a successful real connection validation', () => {
    const html = renderToStaticMarkup(React.createElement(ProviderEditor, {
      mode: 'create', initialProvider: null, busy: false, onCancel: noop, onSaved: noop,
    }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="save-provider"/);
    expect(html).toContain('请先测试连接');
  });

  it('shows the three required Provider setup stages', () => {
    const html = renderToStaticMarkup(React.createElement(ProviderEditor, {
      mode: 'create', initialProvider: null, busy: false, onCancel: noop, onSaved: noop,
    }));
    expect((html.match(/data-testid="provider-editor-step"/g) ?? [])).toHaveLength(3);
    expect(html).toContain('1. 选择类型');
    expect(html).toContain('2. 填写连接');
    expect(html).toContain('3. 测试并保存');
  });

  it.each([
    ['create', null, ['Add model provider', '1. Choose type', 'Name', 'API Key', 'Save Provider']],
    ['edit', provider(), ['Edit MiMo', '2. Connection details', 'Replace API Key (optional)', 'Stored API Keys cannot be viewed; they can only be replaced.']],
  ] as const)('renders the complete English %s editor without Han text', (mode, initialProvider, labels) => {
    setLocale('en-US');
    const html = renderToStaticMarkup(React.createElement(ProviderEditor, {
      mode,
      initialProvider,
      busy: false,
      onCancel: noop,
      onSaved: noop,
    }));

    for (const label of labels) expect(html).toContain(label);
    expect(html).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('clears the transient credential immediately after successful validation', async () => {
    const connection: ProviderConnectionResult = { ok: true, testedAt: 10, latencyMs: 20, discoveredModelIds: ['mimo-v2.5-pro'] };
    const clear = vi.fn();
    const validate = vi.fn(async () => ({ validationToken: 'one-use-token', connection }));
    const result = await validateDraftAndClearCredential(draft, 'transient-secret', validate, clear);
    expect(result).toEqual({ validationToken: 'one-use-token', connection });
    expect(clear).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledWith({ ...draft, credential: 'transient-secret' });
  });

  it('clears the transient credential after validation failure too', async () => {
    const clear = vi.fn();
    await expect(validateDraftAndClearCredential(
      draft,
      'transient-secret',
      async () => { throw new Error('network'); },
      clear,
    )).rejects.toThrow('network');
    expect(clear).toHaveBeenCalledOnce();
  });

  it('sends null instead of an empty edit credential so stored credentials remain replace-only', async () => {
    const validate = vi.fn(async () => ({
      validationToken: 'token',
      connection: { ok: true, testedAt: 1, latencyMs: 2, discoveredModelIds: [] } as ProviderConnectionResult,
    }));
    await validateDraftAndClearCredential(draft, '', validate, noop);
    expect(validate).toHaveBeenCalledWith({ ...draft, credential: null });
  });
});

describe('Provider deletion boundary', () => {
  it('requires explicit credential deletion confirmation', async () => {
    const remove = vi.fn(async () => {});
    const confirm = vi.fn(() => true);
    await expect(confirmAndDeleteProvider(provider(), confirm, remove)).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith('删除 MiMo 也会永久删除其安全存储凭证。确定继续吗？');
    expect(remove).toHaveBeenCalledWith({ providerId: 'mimo', confirmCredentialDeletion: true });
  });

  it('leaves Provider and credential untouched when confirmation is cancelled', async () => {
    const remove = vi.fn(async () => {});
    await expect(confirmAndDeleteProvider(provider(), () => false, remove)).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not refresh or report failure when a user cancels deletion', async () => {
    const refresh = vi.fn(async () => {});
    const reportError = vi.fn();
    await expect(deleteProviderFromCenter(
      provider(),
      () => false,
      vi.fn(async () => {}),
      refresh,
      reportError,
    )).resolves.toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('AgentModelPolicyEditor', () => {
  const assignments: AgentModelPolicyAssignment[] = [{
    agentType: 'planner', providerId: 'mimo', modelId: 'mimo-v2.5-pro',
    notes: { quality: 'high', speed: 'medium', cost: 'high' },
  }];

  it('renders all five Agent roles and informational quality/speed/cost notes', () => {
    const html = renderToStaticMarkup(React.createElement(AgentModelPolicyEditor, {
      providers: [provider()], modelsByProvider: { mimo: models }, assignments, onChange: noop,
    }));
    for (const role of ['Planner', 'Coder', 'Tester', 'Reviewer', 'Fixer']) expect(html).toContain(role);
    for (const label of ['质量', '速度', '成本']) expect(html).toContain(label);
    expect(html).toContain('仅作信息备注，不参与自动路由');
  });

  it('reserves enough width for every low, medium, and high rating', () => {
    const html = renderToStaticMarkup(React.createElement(AgentModelPolicyEditor, {
      providers: [provider()], modelsByProvider: { mimo: models }, assignments, onChange: noop,
    }));
    expect(html).toContain('grid-cols-[72px_minmax(160px,1fr)_92px_92px_92px]');
  });

  it('never offers raw OpenAI-compatible Providers to Workflow roles', () => {
    const deepSeek = provider({ id: 'deepseek', name: 'DeepSeek', runtimeType: 'none', capabilities: { ...capabilities, supportsClaudeCode: false, supportsAgentWorkflow: false } });
    const html = renderToStaticMarkup(React.createElement(AgentModelPolicyEditor, {
      providers: [deepSeek, provider()], modelsByProvider: { deepseek: [], mimo: models }, assignments, onChange: noop,
    }));
    expect(html).toContain('MiMo / mimo-v2.5-pro');
    expect(html).not.toContain('DeepSeek /');
  });

  it('preserves a legacy invalid role value and marks it for reconfiguration', () => {
    const deepSeek = provider({
      id: 'deepseek', name: 'DeepSeek', runtimeType: 'none',
      agentModelStatus: 'needs_reconfiguration',
      capabilities: { ...capabilities, supportsClaudeCode: false, supportsAgentWorkflow: false },
    });
    const invalidAssignments: AgentModelPolicyAssignment[] = [{
      agentType: 'planner', providerId: 'deepseek', modelId: 'deepseek-chat',
      notes: { quality: null, speed: null, cost: null },
    }];
    const html = renderToStaticMarkup(React.createElement(AgentModelPolicyEditor, {
      providers: [deepSeek, provider()], modelsByProvider: { deepseek: [], mimo: models },
      assignments: invalidAssignments, onChange: noop,
    }));

    expect(html).toContain('该模型当前不能用于 Agent，请重新选择。');
    expect(html).toContain('value="deepseek:deepseek-chat"');
    expect(html).not.toContain('DeepSeek / deepseek-chat');
  });

  it('filters tools/MCP by role while keeping Planner and Reviewer workflow choices', () => {
    const workflowOnly = provider({
      id: 'workflow-only',
      name: 'Workflow Only',
      capabilities: { ...capabilities, supportsTools: false, supportsMCP: false },
      agentModelStatus: 'needs_reconfiguration',
    });
    const html = renderToStaticMarkup(React.createElement(AgentModelPolicyEditor, {
      providers: [workflowOnly],
      modelsByProvider: { 'workflow-only': [{ ...models[0], providerId: 'workflow-only' }] },
      assignments: [], onChange: noop,
    }));

    expect((html.match(/Workflow Only \/ mimo-v2\.5-pro/gu) ?? [])).toHaveLength(2);
  });

  it('persists policy notes through the dedicated policy API shape', async () => {
    const setPolicy = vi.fn(async (input) => ({ ...input, notes: { quality: input.quality, speed: input.speed, cost: input.cost }, createdAt: 1, updatedAt: 1 }));
    const deletePolicy = vi.fn(async () => true);
    await persistAgentPolicyChange('planner', assignments[0], { setPolicy, deletePolicy });
    expect(setPolicy).toHaveBeenCalledWith({
      agentType: 'planner', providerId: 'mimo', modelId: 'mimo-v2.5-pro',
      quality: 'high', speed: 'medium', cost: 'high',
    });
    expect(deletePolicy).not.toHaveBeenCalled();
  });

  it('deletes a role policy when the user returns it to follow-default', async () => {
    const setPolicy = vi.fn();
    const deletePolicy = vi.fn(async () => true);
    await persistAgentPolicyChange('coder', null, { setPolicy, deletePolicy });
    expect(deletePolicy).toHaveBeenCalledWith({ agentType: 'coder' });
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('loads only policy-referenced Providers missing from the current page', async () => {
    const archivedPageProvider = provider({ id: 'other', name: 'Other' });
    const listPolicies = vi.fn(async () => [{
      agentType: 'planner' as const, providerId: 'mimo', modelId: 'mimo-v2.5-pro',
      notes: { quality: 'high' as const, speed: null, cost: null }, createdAt: 1, updatedAt: 1,
    }]);
    const getProvider = vi.fn(async () => provider());
    const listModels = vi.fn(async () => models);
    const result = await loadAgentPolicyEditorData([archivedPageProvider], { listPolicies, getProvider, listModels });
    expect(getProvider).toHaveBeenCalledTimes(1);
    expect(getProvider).toHaveBeenCalledWith('mimo');
    expect(result.providers.map((item) => item.id)).toEqual(['other', 'mimo']);
    expect(result.modelsByProvider.mimo).toHaveLength(2);
  });
});

describe('ProjectModelPolicyEditor', () => {
  const projectPolicies = [{
    projectId: 'project-1', agentType: 'default' as const, providerId: 'mimo',
    modelId: 'mimo-v2.5-pro', createdAt: 1, updatedAt: 1,
  }];

  it('renders project default plus all five role overrides', () => {
    const html = renderToStaticMarkup(React.createElement(ProjectModelPolicyEditor, {
      providers: [provider()], modelsByProvider: { mimo: models }, policies: projectPolicies,
      busy: false, onChange: noop,
    }));
    for (const role of ['项目默认', 'Planner', 'Coder', 'Tester', 'Reviewer', 'Fixer']) {
      expect(html).toContain(role);
    }
  });

  it('excludes unsupported OpenAI Providers from every project policy selector', () => {
    const deepSeek = provider({ id: 'deepseek', name: 'DeepSeek', runtimeType: 'none', capabilities: { ...capabilities, supportsClaudeCode: false, supportsAgentWorkflow: false } });
    const html = renderToStaticMarkup(React.createElement(ProjectModelPolicyEditor, {
      providers: [deepSeek, provider()], modelsByProvider: { deepseek: [], mimo: models },
      policies: projectPolicies, busy: false, onChange: noop,
    }));
    expect(html).not.toContain('DeepSeek /');
    expect(html).toContain('MiMo / mimo-v2.5-pro');
  });

  it('shows an invalid project policy as needs-reconfiguration instead of following silently', () => {
    const deepSeek = provider({
      id: 'deepseek', name: 'DeepSeek', runtimeType: 'none',
      agentModelStatus: 'needs_reconfiguration',
      capabilities: { ...capabilities, supportsClaudeCode: false, supportsAgentWorkflow: false },
    });
    const html = renderToStaticMarkup(React.createElement(ProjectModelPolicyEditor, {
      providers: [deepSeek, provider()], modelsByProvider: { deepseek: [], mimo: models },
      policies: [{ ...projectPolicies[0], providerId: 'deepseek', modelId: 'deepseek-chat' }],
      busy: false, onChange: noop,
    }));

    expect(html).toContain('该模型当前不能用于 Agent，请重新选择。');
    expect(html).toContain('value="deepseek:deepseek-chat"');
  });

  it('uses dedicated project policy set and delete shapes', async () => {
    const setPolicy = vi.fn(async () => ({}));
    const deletePolicy = vi.fn(async () => true);
    await persistProjectPolicyChange('project-1', 'reviewer', {
      projectId: 'project-1', agentType: 'reviewer', providerId: 'mimo', modelId: 'mimo-v2.5-pro',
      createdAt: 1, updatedAt: 1,
    }, { setPolicy, deletePolicy });
    expect(setPolicy).toHaveBeenCalledWith({ projectId: 'project-1', agentType: 'reviewer', providerId: 'mimo', modelId: 'mimo-v2.5-pro' });
    await persistProjectPolicyChange('project-1', 'reviewer', null, { setPolicy, deletePolicy });
    expect(deletePolicy).toHaveBeenCalledWith({ projectId: 'project-1', agentType: 'reviewer' });
  });
});
