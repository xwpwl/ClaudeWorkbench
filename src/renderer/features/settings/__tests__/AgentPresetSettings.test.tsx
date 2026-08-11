// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentPresetId,
  AgentPresetPreview,
  AgentPresetRolePreview,
  ModelTier,
  ModelTierCandidatePublic,
  ModelTierResolutionPublic,
} from '../../../../shared/types/modelTiers';
import type { PublicAgentModelPolicyReference } from '../../../../shared/types/modelProviders';
import { setLocale } from '../../../i18n';
import { AgentPresetSettings, type AgentPresetSettingsApi } from '../AgentPresetSettings';

const scope = { type: 'global' } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
const candidate: ModelTierCandidatePublic = {
  providerId: 'provider-mimo', providerName: 'MiMo Gateway', modelId: 'mimo-v2.5-pro',
  modelDisplayName: 'MiMo v2.5 Pro', runtimeType: 'claude-code', executionSource: 'database_provider',
  health: { state: 'connected', lastTestedAt: 1_725_000_000_000 },
};

const literalMappings: Record<AgentPresetId, Record<'planner' | 'coder' | 'tester' | 'reviewer' | 'fixer', ModelTier>> = {
  software_development: { planner: 'high_quality', coder: 'balanced', tester: 'fast', reviewer: 'high_quality', fixer: 'balanced' },
  quick_change: { planner: 'fast', coder: 'fast', tester: 'fast', reviewer: 'balanced', fixer: 'fast' },
  high_quality_review: { planner: 'high_quality', coder: 'balanced', tester: 'balanced', reviewer: 'high_quality', fixer: 'high_quality' },
};

function resolution(tier: ModelTier): ModelTierResolutionPublic {
  return {
    scope, tier,
    display: { tier, displayName: null, quality: null, speed: null, cost: null },
    source: 'global',
    binding: { tier, providerId: candidate.providerId, modelId: candidate.modelId, updatedAt: 1_725_000_000_000 },
    candidate, validity: 'valid', invalidReason: null,
  };
}

function preview(presetId: AgentPresetId, revision = `revision-${presetId}`): AgentPresetPreview {
  const roles = Object.fromEntries(Object.entries(literalMappings[presetId]).map(([role, tier]) => [role, {
    role, tier, resolution: resolution(tier),
  }])) as AgentPresetPreview['roles'];
  return { scope, presetId, revision, roles };
}

function api(overrides: Partial<AgentPresetSettingsApi> = {}): AgentPresetSettingsApi {
  return {
    prepareAgentPreset: vi.fn().mockImplementation(({ presetId }: { presetId: AgentPresetId }) => Promise.resolve({ step: 'preview', preview: preview(presetId) })),
    previewAgentPreset: vi.fn().mockImplementation(({ presetId }: { presetId: AgentPresetId }) => Promise.resolve(preview(presetId))),
    applyAgentPreset: vi.fn().mockResolvedValue({ presetId: 'software_development', appliedAt: 1_725_000_001_000 }),
    getAgentPresetStatus: vi.fn().mockResolvedValue({ kind: 'preset', presetId: 'software_development' }),
    listAgentModelPolicyReferences: vi.fn().mockResolvedValue([
      { scope, agentType: 'planner', reference: { kind: 'tier', tier: 'high_quality' }, providerName: null, notes: { quality: null, speed: null, cost: null }, createdAt: 1, updatedAt: 2 },
      { scope, agentType: 'coder', reference: { kind: 'tier', tier: 'balanced' }, providerName: null, notes: { quality: null, speed: null, cost: null }, createdAt: 1, updatedAt: 2 },
      { scope, agentType: 'tester', reference: { kind: 'tier', tier: 'fast' }, providerName: null, notes: { quality: null, speed: null, cost: null }, createdAt: 1, updatedAt: 2 },
      { scope, agentType: 'reviewer', reference: { kind: 'tier', tier: 'high_quality' }, providerName: null, notes: { quality: null, speed: null, cost: null }, createdAt: 1, updatedAt: 2 },
      { scope, agentType: 'fixer', reference: { kind: 'tier', tier: 'balanced' }, providerName: null, notes: { quality: null, speed: null, cost: null }, createdAt: 1, updatedAt: 2 },
    ]),
    listModelTierCandidates: vi.fn().mockResolvedValue([candidate]),
    listModelTierBindings: vi.fn().mockResolvedValue(['high_quality', 'balanced', 'fast'].map((tier) => resolution(tier as ModelTier))),
    setModelTierBinding: vi.fn().mockResolvedValue(resolution('balanced')),
    bindAllModelTiers: vi.fn().mockResolvedValue(['high_quality', 'balanced', 'fast'].map((tier) => resolution(tier as ModelTier))),
    updateModelTierDisplayMetadata: vi.fn().mockResolvedValue(resolution('balanced')),
    clearProjectModelTierBinding: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

afterEach(cleanup);
beforeEach(() => setLocale('zh-CN'));

describe('AgentPresetSettings', () => {
  it('commits status during React StrictMode effect replay', async () => {
    setLocale('en-US');
    render(
      <React.StrictMode>
        <AgentPresetSettings scope={scope} api={api()} onOpenProviderCenter={vi.fn()} />
      </React.StrictMode>,
    );

    const status = screen.getByText('Current status').parentElement;
    await waitFor(() => expect(status?.textContent).toBe('Current statusSoftware development'));
  });

  it('commits prepare completion during React StrictMode effect replay', async () => {
    setLocale('en-US');
    const user = userEvent.setup();
    render(
      <React.StrictMode>
        <AgentPresetSettings scope={scope} api={api()} onOpenProviderCenter={vi.fn()} />
      </React.StrictMode>,
    );

    await user.click(await screen.findByRole('button', { name: 'Apply Quick change template' }));
    expect(await screen.findByRole('dialog', { name: 'Apply template preview' })).not.toBeNull();
  });

  it('clears a project-A prepare busy state when project B becomes active', async () => {
    setLocale('en-US');
    const user = userEvent.setup();
    const projectA = { type: 'project', projectId: 'project-a' } as const;
    const projectB = { type: 'project', projectId: 'project-b' } as const;
    const pendingA = deferred<{ step: 'preview'; preview: AgentPresetPreview }>();
    const port = api({
      prepareAgentPreset: vi.fn(({ scope: inputScope, presetId }) => inputScope.type === 'project' && inputScope.projectId === 'project-a'
        ? pendingA.promise
        : Promise.resolve({ step: 'preview' as const, preview: preview(presetId) })),
      listAgentModelPolicyReferences: vi.fn().mockResolvedValue([]),
    });
    const rendered = render(<AgentPresetSettings scope={projectA} api={port} onOpenProviderCenter={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Apply Software development template' }));
    expect(screen.getByRole('button', { name: 'Apply Quick change template' }).hasAttribute('disabled')).toBe(true);
    rendered.rerender(<AgentPresetSettings scope={projectB} api={port} onOpenProviderCenter={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply Quick change template' }).hasAttribute('disabled')).toBe(false));

    await act(async () => pendingA.resolve({ step: 'preview', preview: preview('software_development') }));
    expect(screen.getByRole('button', { name: 'Apply Quick change template' }).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Apply template preview' })).toBeNull();
  });

  it('clears a project-A apply busy state without letting its late finally mutate project B', async () => {
    setLocale('en-US');
    const user = userEvent.setup();
    const projectA = { type: 'project', projectId: 'project-a' } as const;
    const projectB = { type: 'project', projectId: 'project-b' } as const;
    const pendingApplyA = deferred<{ presetId: 'software_development'; appliedAt: number }>();
    const pendingPrepareB = deferred<{ step: 'preview'; preview: AgentPresetPreview }>();
    const port = api({
      prepareAgentPreset: vi.fn(({ scope: inputScope, presetId }) => inputScope.type === 'project' && inputScope.projectId === 'project-b'
        ? pendingPrepareB.promise
        : Promise.resolve({ step: 'preview' as const, preview: preview(presetId) })),
      applyAgentPreset: vi.fn(() => pendingApplyA.promise),
      listAgentModelPolicyReferences: vi.fn().mockResolvedValue([]),
    });
    const rendered = render(<AgentPresetSettings scope={projectA} api={port} onOpenProviderCenter={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Apply Software development template' }));
    await user.click(await screen.findByRole('button', { name: 'Apply' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm overwrite and apply' }));
    rendered.rerender(<AgentPresetSettings scope={projectB} api={port} onOpenProviderCenter={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply Quick change template' }).hasAttribute('disabled')).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Apply Quick change template' }));
    expect(screen.getByRole('button', { name: 'Apply Quick change template' }).hasAttribute('disabled')).toBe(true);

    await act(async () => pendingApplyA.resolve({ presetId: 'software_development', appliedAt: 10 }));
    expect(screen.getByRole('button', { name: 'Apply Quick change template' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText('Model configuration updated. This affects future Agent calls only.')).toBeNull();
    await act(async () => pendingPrepareB.resolve({ step: 'preview', preview: preview('quick_change') }));
    expect(await screen.findByRole('dialog', { name: 'Apply template preview' })).not.toBeNull();
  });

  it('keeps a re-entered project-A apply authoritative when its prior incarnation settles', async () => {
    setLocale('en-US');
    const user = userEvent.setup();
    const projectA = { type: 'project', projectId: 'project-a' } as const;
    const projectB = { type: 'project', projectId: 'project-b' } as const;
    const priorAApply = deferred<{ presetId: 'software_development'; appliedAt: number }>();
    const currentAApply = deferred<{ presetId: 'quick_change'; appliedAt: number }>();
    const applyAgentPreset = vi.fn()
      .mockImplementationOnce(() => priorAApply.promise)
      .mockImplementationOnce(() => currentAApply.promise);
    const port = api({
      applyAgentPreset,
      listAgentModelPolicyReferences: vi.fn().mockResolvedValue([]),
    });
    const rendered = render(<AgentPresetSettings scope={projectA} api={port} onOpenProviderCenter={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Apply Software development template' }));
    await user.click(await screen.findByRole('button', { name: 'Apply' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm overwrite and apply' }));

    rendered.rerender(<AgentPresetSettings scope={projectB} api={port} onOpenProviderCenter={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply Quick change template' }).hasAttribute('disabled')).toBe(false));
    rendered.rerender(<AgentPresetSettings scope={projectA} api={port} onOpenProviderCenter={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply Quick change template' }).hasAttribute('disabled')).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Apply Quick change template' }));
    await user.click(await screen.findByRole('button', { name: 'Apply' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm overwrite and apply' }));
    const currentDialog = await screen.findByRole('dialog', { name: 'Confirm Agent configuration overwrite' });
    expect(within(currentDialog).getByRole('button', { name: 'Confirm overwrite and apply' }).hasAttribute('disabled')).toBe(true);

    await act(async () => priorAApply.resolve({ presetId: 'software_development', appliedAt: 10 }));
    const stillCurrentDialog = screen.getByRole('dialog', { name: 'Confirm Agent configuration overwrite' });
    expect(within(stillCurrentDialog).getByRole('button', { name: 'Confirm overwrite and apply' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Apply Quick change template' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText('Model configuration updated; it only affects subsequent Agent calls.')).toBeNull();

    await act(async () => currentAApply.resolve({ presetId: 'quick_change', appliedAt: 20 }));
    expect(await screen.findByText('Model configuration updated; it only affects subsequent Agent calls.')).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Confirm Agent configuration overwrite' })).toBeNull());
    expect(applyAgentPreset).toHaveBeenCalledTimes(2);
  });

  it('renders a main-resolved Provider name for a direct reference without exposing its internal ID', async () => {
    setLocale('en-US');
    const directReference = {
      scope,
      agentType: 'planner',
      reference: { kind: 'model', providerId: 'provider-internal-opaque-id', modelId: 'mimo-v2.5-pro' },
      providerName: 'Friendly MiMo Gateway',
      notes: { quality: null, speed: null, cost: null },
      createdAt: 1,
      updatedAt: 2,
    } as PublicAgentModelPolicyReference & { providerName: string };
    render(<AgentPresetSettings
      scope={scope}
      api={api({ listAgentModelPolicyReferences: vi.fn().mockResolvedValue([directReference]) })}
      onOpenProviderCenter={vi.fn()}
    />);

    const plannerRow = (await screen.findAllByTestId('persisted-agent-role'))[0];
    expect(plannerRow.textContent).toContain('Friendly MiMo Gateway / mimo-v2.5-pro');
    expect(plannerRow.outerHTML).not.toContain('provider-internal-opaque-id');
  });

  it('first apply calls prepare and opens the binding wizard for missing tiers', async () => {
    const user = userEvent.setup();
    const port = api({ prepareAgentPreset: vi.fn().mockResolvedValue({ step: 'bind_tiers', missingTiers: ['high_quality', 'balanced', 'fast'] }) });
    render(<AgentPresetSettings scope={scope} api={port} onOpenProviderCenter={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '应用软件开发模板' }));
    expect(port.prepareAgentPreset).toHaveBeenCalledWith({ scope, presetId: 'software_development' });
    expect(await screen.findByRole('dialog', { name: '配置模型档位' })).not.toBeNull();
  });

  it('already-bound tiers go directly to a five-role preview', async () => {
    const user = userEvent.setup();
    render(<AgentPresetSettings scope={scope} api={api()} onOpenProviderCenter={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '应用快速修改模板' }));
    const dialog = await screen.findByRole('dialog', { name: '应用模板预览' });
    for (const role of ['Planner', 'Coder', 'Tester', 'Reviewer', 'Fixer']) {
      expect(within(dialog).getByText(role)).not.toBeNull();
    }
  });

  it('keeps the persisted five-role tier mapping visible after the preview is gone', async () => {
    render(<AgentPresetSettings scope={scope} api={api()} onOpenProviderCenter={vi.fn()} />);

    const rows = await screen.findAllByTestId('persisted-agent-role');
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Planner'),
      expect.stringContaining('Coder'),
      expect.stringContaining('Tester'),
      expect.stringContaining('Reviewer'),
      expect.stringContaining('Fixer'),
    ]);
    expect(rows[0].textContent).toContain('高质量');
    expect(rows[0].textContent).toContain('MiMo Gateway / mimo-v2.5-pro');
  });

  it('isolates late status and preview replies when switching project A to B', async () => {
    const projectA = { type: 'project', projectId: 'project-a' } as const;
    const projectB = { type: 'project', projectId: 'project-b' } as const;
    const statusA = deferred<{ kind: 'preset'; presetId: 'software_development' }>();
    const statusB = deferred<{ kind: 'custom' }>();
    const previewA = deferred<{ step: 'preview'; preview: AgentPresetPreview }>();
    const port = api({
      getAgentPresetStatus: vi.fn(({ scope: inputScope }) => inputScope.type === 'project' && inputScope.projectId === 'project-a' ? statusA.promise : statusB.promise),
      prepareAgentPreset: vi.fn(() => previewA.promise),
      listAgentModelPolicyReferences: vi.fn().mockResolvedValue([]),
    });
    const rendered = render(<AgentPresetSettings scope={projectA} api={port} onOpenProviderCenter={vi.fn()} />);
    rendered.rerender(<AgentPresetSettings scope={projectB} api={port} onOpenProviderCenter={vi.fn()} />);
    await act(async () => statusB.resolve({ kind: 'custom' }));
    expect(await screen.findByText('已自定义')).not.toBeNull();
    await act(async () => statusA.resolve({ kind: 'preset', presetId: 'software_development' }));
    expect(screen.queryByText('当前状态软件开发')).toBeNull();

    rendered.rerender(<AgentPresetSettings scope={projectA} api={port} onOpenProviderCenter={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: '应用软件开发模板' }));
    rendered.rerender(<AgentPresetSettings scope={projectB} api={port} onOpenProviderCenter={vi.fn()} />);
    await act(async () => previewA.resolve({ step: 'preview', preview: preview('software_development') }));
    expect(screen.queryByRole('dialog', { name: '应用模板预览' })).toBeNull();
  });

  it.each([
    ['software_development', '软件开发', ['高质量', '均衡', '快速', '高质量', '均衡']],
    ['quick_change', '快速修改', ['快速', '快速', '快速', '均衡', '快速']],
    ['high_quality_review', '高质量审查', ['高质量', '均衡', '均衡', '高质量', '高质量']],
  ] as const)('shows the exact server-preview mapping for %s across all five roles', async (presetId, label, tierLabels) => {
    const user = userEvent.setup();
    render(<AgentPresetSettings scope={scope} api={api()} onOpenProviderCenter={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: `应用${label}模板` }));
    const rows = within(await screen.findByRole('dialog', { name: '应用模板预览' })).getAllByTestId('preset-role-preview');
    expect(rows).toHaveLength(5);
    rows.forEach((row, index) => {
      expect(row.textContent).toContain(tierLabels[index]);
      expect(row.textContent).toContain('MiMo Gateway / mimo-v2.5-pro');
    });
    void presetId;
  });

  it('preview Cancel performs zero writes', async () => {
    const user = userEvent.setup();
    const port = api();
    render(<AgentPresetSettings scope={scope} api={port} onOpenProviderCenter={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '应用软件开发模板' }));
    await user.click(await screen.findByRole('button', { name: '取消' }));
    expect(port.applyAgentPreset).not.toHaveBeenCalled();
    expect(port.bindAllModelTiers).not.toHaveBeenCalled();
    expect(port.setModelTierBinding).not.toHaveBeenCalled();
  });

  it('custom status requires the exact second overwrite confirmation and sends both confirmations', async () => {
    const user = userEvent.setup();
    const port = api({ getAgentPresetStatus: vi.fn().mockResolvedValue({ kind: 'custom' }) });
    render(<AgentPresetSettings scope={scope} api={port} onOpenProviderCenter={vi.fn()} />);

    expect(await screen.findByText('已自定义')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: '应用软件开发模板' }));
    await user.click(await screen.findByRole('button', { name: '应用' }));
    expect(port.applyAgentPreset).not.toHaveBeenCalled();
    const warning = await screen.findByRole('dialog', { name: '确认覆盖 Agent 配置' });
    expect(warning.textContent).toContain('重新应用此模板将覆盖当前 Agent 角色模型配置。');
    await user.click(within(warning).getByRole('button', { name: '确认覆盖并应用' }));

    await waitFor(() => expect(port.applyAgentPreset).toHaveBeenCalledWith({
      scope,
      presetId: 'software_development',
      expectedRevision: 'revision-software_development',
      previewConfirmed: true,
      overwriteConfirmed: true,
    }));
  });

  it('shows the future-calls-only success message after application', async () => {
    const user = userEvent.setup();
    const port = api({ getAgentPresetStatus: vi.fn().mockResolvedValue({ kind: 'preset', presetId: 'software_development' }) });
    render(<AgentPresetSettings scope={scope} api={port} onOpenProviderCenter={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '应用快速修改模板' }));
    await user.click(await screen.findByRole('button', { name: '应用' }));
    await user.click(await screen.findByRole('button', { name: '确认覆盖并应用' }));
    expect(await screen.findByText('模型配置已更新，只影响后续 Agent 调用。')).not.toBeNull();
  });

  it('Modify model tiers returns from preview to the tier wizard', async () => {
    const user = userEvent.setup();
    render(<AgentPresetSettings scope={scope} api={api()} onOpenProviderCenter={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '应用高质量审查模板' }));
    await user.click(await screen.findByRole('button', { name: '修改模型档位' }));
    expect(await screen.findByRole('dialog', { name: '配置模型档位' })).not.toBeNull();
    expect(screen.queryByRole('dialog', { name: '应用模板预览' })).toBeNull();
  });

  it.each([
    ['PREVIEW_STALE', '模板预览已过期，请重新预览。', '重新预览'],
    ['PRESET_ROLE_UNAVAILABLE', '模型档位无效，需要重新配置。', '配置模型档位'],
    ['PROVIDER_DISABLED', 'Provider 已停用，需要重新配置模型档位。', '配置模型档位'],
  ])('keeps %s errors safe and actionable', async (code, message, action) => {
    const user = userEvent.setup();
    const error = Object.assign(new Error('raw-error-secret-sentinel'), { code });
    const port = api({
      getAgentPresetStatus: vi.fn().mockResolvedValue({ kind: 'custom' }),
      applyAgentPreset: vi.fn().mockRejectedValue(error),
    });
    render(<AgentPresetSettings scope={scope} api={port} onOpenProviderCenter={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '应用软件开发模板' }));
    await user.click(await screen.findByRole('button', { name: '应用' }));
    await user.click(await screen.findByRole('button', { name: '确认覆盖并应用' }));
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(screen.getByRole('button', { name: action })).not.toBeNull();
    expect(document.body.textContent).not.toContain('raw-error-secret-sentinel');
  });

  it('renders invalid projected roles as reconfiguration actions instead of fallback', async () => {
    const user = userEvent.setup();
    const invalid = preview('software_development');
    const balanced = invalid.roles.coder;
    const valid = balanced.resolution;
    if (valid.validity !== 'valid') throw new Error('Expected a valid fixture.');
    const invalidResolution: ModelTierResolutionPublic = {
      scope: valid.scope,
      tier: valid.tier,
      display: valid.display,
      source: valid.source,
      binding: valid.binding,
      candidate: null,
      validity: 'needs_reconfiguration',
      invalidReason: 'provider_disabled',
    };
    invalid.roles = {
      ...invalid.roles,
      coder: { ...balanced, resolution: invalidResolution } as AgentPresetRolePreview,
    };
    render(<AgentPresetSettings scope={scope} api={api({ prepareAgentPreset: vi.fn().mockResolvedValue({ step: 'preview', preview: invalid }) })} onOpenProviderCenter={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '应用软件开发模板' }));
    expect(await screen.findByText('需要重新配置：Provider 已停用')).not.toBeNull();
    expect(screen.getByRole('button', { name: '应用' }).hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).not.toContain('回退');
  });

  it('projects preview data into safe state and DOM without secret-like extras or hidden URL paths', async () => {
    const user = userEvent.setup();
    const unsafe = preview('quick_change') as AgentPresetPreview & Record<string, unknown>;
    Object.assign(unsafe, { credential_ref: 'credential-secret-ref', vaultPath: 'vault-secret-path' });
    Object.assign(unsafe.roles.planner.resolution.candidate ?? {}, {
      baseUrl: 'https://gateway.example/hidden-tenant-route', apiKey: 'sk-secret-sentinel', rawError: 'raw-secret-error',
    });
    render(<AgentPresetSettings scope={scope} api={api({ prepareAgentPreset: vi.fn().mockResolvedValue({ step: 'preview', preview: unsafe }) })} onOpenProviderCenter={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '应用快速修改模板' }));
    await screen.findByRole('dialog', { name: '应用模板预览' });
    const output = document.body.textContent ?? '';
    for (const sentinel of ['credential-secret-ref', 'vault-secret-path', 'hidden-tenant-route', 'sk-secret-sentinel', 'raw-secret-error']) {
      expect(output).not.toContain(sentinel);
    }
  });

  it('renders preset status and preview controls in English', async () => {
    setLocale('en-US');
    const user = userEvent.setup();
    render(<AgentPresetSettings scope={scope} api={api()} onOpenProviderCenter={vi.fn()} />);

    expect(await screen.findByText('Software development')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Apply Quick change template' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply template preview' });
    expect(screen.getByRole('button', { name: 'Modify model tiers' })).not.toBeNull();
    expect(within(dialog).getAllByText('claude-code · Global').length).toBeGreaterThan(0);
  });

  it('does not reprepare a preset when an in-flight tier write completes after a scope unmount', async () => {
    const user = userEvent.setup();
    const projectA = { type: 'project', projectId: 'project-a' } as const;
    const projectB = { type: 'project', projectId: 'project-b' } as const;
    const binding = deferred<ModelTierResolutionPublic[]>();
    const prepareAgentPreset = vi.fn().mockResolvedValue({ step: 'bind_tiers', missingTiers: ['high_quality', 'balanced', 'fast'] as ModelTier[] });
    const port = api({ prepareAgentPreset, bindAllModelTiers: vi.fn(() => binding.promise) });
    const rendered = render(<AgentPresetSettings scope={projectA} api={port} onOpenProviderCenter={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '应用软件开发模板' }));
    await user.click(await screen.findByRole('button', { name: '将此模型用于全部档位' }));
    rendered.rerender(<AgentPresetSettings scope={projectB} api={port} onOpenProviderCenter={vi.fn()} />);
    await act(async () => binding.resolve(['high_quality', 'balanced', 'fast'].map((tier) => resolution(tier as ModelTier))));
    await Promise.resolve();
    expect(prepareAgentPreset).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: '应用模板预览' })).toBeNull();
  });

  it('clears only a recovered status-load error after Recheck succeeds', async () => {
    const user = userEvent.setup();
    const getStatus = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ kind: 'custom' });
    render(<AgentPresetSettings scope={scope} api={api({ getAgentPresetStatus: getStatus })} onOpenProviderCenter={vi.fn()} />);

    expect(await screen.findByRole('alert')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: '重新检查' }));
    expect(await screen.findByText('已自定义')).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
