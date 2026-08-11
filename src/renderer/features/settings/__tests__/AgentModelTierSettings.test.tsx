// @vitest-environment jsdom

import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_TIERS, type ModelTierCandidatePublic, type ModelTierResolutionPublic } from '../../../../shared/types/modelTiers';
import { setLocale } from '../../../i18n';
import {
  AgentModelTierSettings,
  TierBindingWizard,
  type AgentTierSettingsApi,
} from '../AgentModelTierSettings';

const globalScope = { type: 'global' } as const;

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
  providerId: 'provider-long',
  providerName: 'Long Provider Name That Must Stay Accessible',
  modelId: 'model-long-identifier-that-must-stay-accessible',
  modelDisplayName: 'Model Long',
  runtimeType: 'claude-code',
  executionSource: 'database_provider',
  health: { state: 'connected', lastTestedAt: 1_725_000_000_000 },
};

function validResolution(
  tier: (typeof MODEL_TIERS)[number],
  source: 'global' | 'project' = 'global',
  resolutionScope: ModelTierResolutionPublic['scope'] = globalScope,
  providerName = candidate.providerName,
): ModelTierResolutionPublic {
  return {
    scope: resolutionScope,
    tier,
    display: { tier, displayName: null, quality: null, speed: null, cost: null },
    source,
    binding: { tier, providerId: candidate.providerId, modelId: candidate.modelId, updatedAt: 1_725_000_000_000 },
    candidate: { ...candidate, providerName },
    validity: 'valid',
    invalidReason: null,
  };
}

function api(overrides: Partial<AgentTierSettingsApi> = {}): AgentTierSettingsApi {
  return {
    listModelTierCandidates: vi.fn().mockResolvedValue([candidate]),
    listModelTierBindings: vi.fn().mockResolvedValue(MODEL_TIERS.map((tier) => validResolution(tier))),
    setModelTierBinding: vi.fn().mockResolvedValue(validResolution('balanced')),
    bindAllModelTiers: vi.fn().mockResolvedValue(MODEL_TIERS.map((tier) => validResolution(tier))),
    updateModelTierDisplayMetadata: vi.fn().mockResolvedValue(validResolution('balanced')),
    clearProjectModelTierBinding: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

afterEach(cleanup);

beforeEach(() => {
  setLocale('zh-CN');
});

describe('AgentModelTierSettings', () => {
  it('commits its initial tier load during React StrictMode effect replay', async () => {
    setLocale('en-US');
    render(
      <React.StrictMode>
        <AgentModelTierSettings scope={globalScope} api={api()} onOpenProviderCenter={vi.fn()} />
      </React.StrictMode>,
    );

    expect(await screen.findAllByText('Long Provider Name That Must Stay Accessible')).toHaveLength(3);
  });

  it('commits a wizard write during React StrictMode effect replay', async () => {
    setLocale('en-US');
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(
      <React.StrictMode>
        <TierBindingWizard
          scope={globalScope}
          tiers={[...MODEL_TIERS]}
          api={api()}
          onComplete={onComplete}
          onCancel={vi.fn()}
          onOpenProviderCenter={vi.fn()}
        />
      </React.StrictMode>,
    );

    await user.click(await screen.findByRole('button', { name: 'Use this model for all tiers' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('renders global and project source labels exactly from each main-projected resolution', async () => {
    render(<AgentModelTierSettings
      scope={globalScope}
      api={api({
        listModelTierBindings: vi.fn().mockResolvedValue([
          validResolution('high_quality', 'global'),
          validResolution('balanced', 'project'),
          validResolution('fast', 'global'),
        ]),
      })}
      onOpenProviderCenter={vi.fn()}
    />);

    await screen.findByRole('heading', { name: '高质量' });
    expect(screen.getAllByText('档位来源：全局')).toHaveLength(2);
    expect(screen.getByText('档位来源：项目')).not.toBeNull();
    expect(screen.getByText('档位名称和备注由用户配置，不代表系统对模型能力的保证。')).not.toBeNull();
  });

  it('shows reconfiguration and the projected invalid reason without implying fallback', async () => {
    const valid = validResolution('balanced');
    if (valid.validity !== 'valid') throw new Error('Expected a valid fixture.');
    const invalid: ModelTierResolutionPublic = {
      scope: valid.scope,
      tier: valid.tier,
      display: valid.display,
      source: valid.source,
      binding: valid.binding,
      candidate: null,
      validity: 'needs_reconfiguration',
      invalidReason: 'provider_disabled',
    };
    render(<AgentModelTierSettings
      scope={globalScope}
      api={api({ listModelTierBindings: vi.fn().mockResolvedValue([
        validResolution('high_quality'), invalid, validResolution('fast'),
      ]) })}
      onOpenProviderCenter={vi.fn()}
    />);

    await screen.findByText('需要重新配置');
    expect(screen.getByText('Provider 已停用')).not.toBeNull();
    expect(document.body.textContent).not.toContain('回退');
    expect(screen.getByRole('button', { name: '重新配置均衡档位' })).not.toBeNull();
  });

  it('edits informational notes through the metadata API only', async () => {
    const user = userEvent.setup();
    const port = api();
    render(<AgentModelTierSettings scope={globalScope} api={port} onOpenProviderCenter={vi.fn()} />);

    await screen.findByRole('heading', { name: '均衡' });
    await user.selectOptions(screen.getByRole('combobox', { name: '均衡质量备注' }), 'high');
    await user.selectOptions(screen.getByRole('combobox', { name: '均衡速度备注' }), 'medium');
    await user.selectOptions(screen.getByRole('combobox', { name: '均衡成本备注' }), 'low');
    await user.click(screen.getByRole('button', { name: '保存均衡档位备注' }));

    expect(port.updateModelTierDisplayMetadata).toHaveBeenCalledWith({
      scope: globalScope,
      metadata: { tier: 'balanced', displayName: null, quality: 'high', speed: 'medium', cost: 'low' },
    });
  });

  it('uses one atomic bind-all call and zero per-tier calls when main returns one candidate', async () => {
    const user = userEvent.setup();
    const port = api();
    const onComplete = vi.fn();
    render(<TierBindingWizard
      scope={globalScope}
      tiers={[...MODEL_TIERS]}
      api={port}
      onComplete={onComplete}
      onCancel={vi.fn()}
      onOpenProviderCenter={vi.fn()}
    />);

    await screen.findByRole('dialog', { name: '配置模型档位' });
    await user.click(screen.getByRole('button', { name: '将此模型用于全部档位' }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(port.bindAllModelTiers).toHaveBeenCalledWith({
      scope: globalScope,
      providerId: 'provider-long',
      modelId: 'model-long-identifier-that-must-stay-accessible',
    });
    expect(port.setModelTierBinding).not.toHaveBeenCalled();
  });

  it('ignores a late project-A load after project B wins and never writes A notes into B', async () => {
    const user = userEvent.setup();
    const projectA = { type: 'project', projectId: 'project-a' } as const;
    const projectB = { type: 'project', projectId: 'project-b' } as const;
    const a = deferred<ModelTierResolutionPublic[]>();
    const b = deferred<ModelTierResolutionPublic[]>();
    const port = api({
      listModelTierBindings: vi.fn(({ scope }) => scope.type === 'project' && scope.projectId === 'project-a' ? a.promise : b.promise),
    });
    const rendered = render(<AgentModelTierSettings scope={projectA} api={port} onOpenProviderCenter={vi.fn()} />);

    rendered.rerender(<AgentModelTierSettings scope={projectB} api={port} onOpenProviderCenter={vi.fn()} />);
    await act(async () => b.resolve(MODEL_TIERS.map((tier) => validResolution(tier, 'project', projectB, 'Project B Provider'))));
    expect(await screen.findAllByText('Project B Provider')).toHaveLength(3);
    await act(async () => a.resolve(MODEL_TIERS.map((tier) => validResolution(tier, 'project', projectA, 'Project A Provider'))));
    expect(screen.queryByText('Project A Provider')).toBeNull();

    await user.selectOptions(screen.getByRole('combobox', { name: '均衡质量备注' }), 'high');
    await user.click(screen.getByRole('button', { name: '保存均衡档位备注' }));
    expect(port.updateModelTierDisplayMetadata).toHaveBeenCalledWith(expect.objectContaining({
      scope: projectB,
      metadata: expect.objectContaining({ tier: 'balanced', quality: 'high' }),
    }));
  });

  it('keeps a re-entered project-A note write authoritative when its prior incarnation settles', async () => {
    setLocale('en-US');
    const user = userEvent.setup();
    const projectA = { type: 'project', projectId: 'project-a' } as const;
    const projectB = { type: 'project', projectId: 'project-b' } as const;
    const priorAWrite = deferred<ModelTierResolutionPublic>();
    const currentAWrite = deferred<ModelTierResolutionPublic>();
    let aLoadCount = 0;
    let currentAWriteSettled = false;
    const resolutions = (resolutionScope: typeof projectA | typeof projectB, providerName: string) =>
      MODEL_TIERS.map((tier) => validResolution(tier, 'project', resolutionScope, providerName));
    const listModelTierBindings = vi.fn(({ scope: inputScope }) => {
      if (inputScope.type === 'project' && inputScope.projectId === 'project-b') {
        return Promise.resolve(resolutions(projectB, 'Project B Provider'));
      }
      aLoadCount += 1;
      const providerName = aLoadCount === 1
        ? 'Project A1 Provider'
        : aLoadCount === 2 || currentAWriteSettled
          ? 'Project A2 Provider'
          : 'Stale Project A1 Reload';
      return Promise.resolve(resolutions(projectA, providerName));
    });
    const updateModelTierDisplayMetadata = vi.fn()
      .mockImplementationOnce(() => priorAWrite.promise)
      .mockImplementationOnce(() => currentAWrite.promise);
    const port = api({ listModelTierBindings, updateModelTierDisplayMetadata });
    const rendered = render(<AgentModelTierSettings scope={projectA} api={port} onOpenProviderCenter={vi.fn()} />);

    expect(await screen.findAllByText('Project A1 Provider')).toHaveLength(3);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Balanced Quality note' }), 'medium');
    await user.click(screen.getByRole('button', { name: 'Save Balanced tier notes' }));

    rendered.rerender(<AgentModelTierSettings scope={projectB} api={port} onOpenProviderCenter={vi.fn()} />);
    expect(await screen.findAllByText('Project B Provider')).toHaveLength(3);
    rendered.rerender(<AgentModelTierSettings scope={projectA} api={port} onOpenProviderCenter={vi.fn()} />);
    expect(await screen.findAllByText('Project A2 Provider')).toHaveLength(3);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Balanced Quality note' }), 'high');
    await user.click(screen.getByRole('button', { name: 'Save Balanced tier notes' }));
    expect(screen.getByRole('button', { name: 'Save Balanced tier notes' }).hasAttribute('disabled')).toBe(true);

    await act(async () => priorAWrite.resolve(validResolution('balanced', 'project', projectA, 'Project A1 Provider')));
    expect(listModelTierBindings).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('Stale Project A1 Reload')).toBeNull();
    expect(screen.getAllByText('Project A2 Provider')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Save Balanced tier notes' }).hasAttribute('disabled')).toBe(true);

    currentAWriteSettled = true;
    await act(async () => currentAWrite.resolve(validResolution('balanced', 'project', projectA, 'Project A2 Provider')));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Balanced tier notes' }).hasAttribute('disabled')).toBe(false));
    expect(listModelTierBindings).toHaveBeenCalledTimes(4);
  });

  it('locks every close path while an atomic binding is being saved', async () => {
    const user = userEvent.setup();
    const pending = deferred<ModelTierResolutionPublic[]>();
    const onCancel = vi.fn();
    const onComplete = vi.fn();
    render(<TierBindingWizard
      scope={globalScope}
      tiers={[...MODEL_TIERS]}
      api={api({ bindAllModelTiers: vi.fn(() => pending.promise) })}
      onComplete={onComplete}
      onCancel={onCancel}
      onOpenProviderCenter={vi.fn()}
    />);

    await user.click(await screen.findByRole('button', { name: '将此模型用于全部档位' }));
    expect(await screen.findByRole('status', { name: '正在保存模型档位' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '关闭' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '取消' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('radio').hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(screen.getByRole('dialog', { name: '配置模型档位' }), { key: 'Escape' });
    fireEvent.mouseDown(document.querySelector('.agent-settings-modal-backdrop')!);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => pending.resolve(MODEL_TIERS.map((tier) => validResolution(tier))));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('shows only candidates returned by main and opens the existing Provider Center when empty', async () => {
    const user = userEvent.setup();
    const onOpenProviderCenter = vi.fn();
    render(<TierBindingWizard
      scope={globalScope}
      tiers={['balanced']}
      api={api({ listModelTierCandidates: vi.fn().mockResolvedValue([]) })}
      onComplete={vi.fn()}
      onCancel={vi.fn()}
      onOpenProviderCenter={onOpenProviderCenter}
    />);

    const emptyState = await screen.findByRole('region', { name: '没有可用于 Agent 的模型' });
    expect(document.body.textContent).not.toContain('OpenAI');
    expect(document.body.textContent).not.toContain('DeepSeek');
    await user.click(within(emptyState).getByRole('button', { name: '打开模型供应商中心' }));
    expect(onOpenProviderCenter).toHaveBeenCalledTimes(1);
  });

  it('never renders secret-like extra fields or a hidden Base URL pathname from an injected reply', async () => {
    const unsafe = {
      ...candidate,
      baseUrl: 'https://gateway.example/hidden-tenant-route',
      apiKey: 'sk-secret-sentinel',
      credential_ref: 'credential-secret-ref',
      hmacRef: 'hmac-secret-ref',
      vaultPath: 'vault-secret-path',
      blobName: 'blob-secret-name',
      rawError: 'raw-secret-error',
    } as ModelTierCandidatePublic;
    render(<TierBindingWizard
      scope={globalScope}
      tiers={['fast']}
      api={api({ listModelTierCandidates: vi.fn().mockResolvedValue([unsafe]) })}
      onComplete={vi.fn()}
      onCancel={vi.fn()}
      onOpenProviderCenter={vi.fn()}
    />);

    await screen.findByText('Long Provider Name That Must Stay Accessible');
    const output = document.body.textContent ?? '';
    for (const sentinel of ['hidden-tenant-route', 'sk-secret-sentinel', 'credential-secret-ref', 'hmac-secret-ref', 'vault-secret-path', 'blob-secret-name', 'raw-secret-error']) {
      expect(output).not.toContain(sentinel);
    }
  });

  it('traps keyboard focus, closes on Escape, and returns focus to the opener', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>打开档位向导</button>
        {open ? <TierBindingWizard
          scope={globalScope}
          tiers={['fast']}
          api={api()}
          onComplete={() => setOpen(false)}
          onCancel={() => setOpen(false)}
          onOpenProviderCenter={vi.fn()}
        /> : null}
      </>;
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: '打开档位向导' });
    await user.click(opener);

    const dialog = await screen.findByRole('dialog', { name: '配置模型档位' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '配置模型档位' })).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('renders the complete surface in English without losing the subjective-tier disclaimer', async () => {
    setLocale('en-US');
    render(<AgentModelTierSettings scope={globalScope} api={api()} onOpenProviderCenter={vi.fn()} />);

    await screen.findByRole('heading', { name: 'High quality' });
    expect(screen.getByText('Tier names and notes are user-configured and do not guarantee model capabilities.')).not.toBeNull();
    expect(screen.getAllByText('Tier source: Global')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Modify High quality tier' })).not.toBeNull();
    expect(screen.getByRole('combobox', { name: 'High quality Quality note' })).not.toBeNull();
  });
});
