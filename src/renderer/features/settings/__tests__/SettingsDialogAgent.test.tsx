// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../../shared/types/ipc';
import type { PublicModelProvider } from '../../../../shared/types/modelProviders';
import { setLocale } from '../../../i18n';
import { SettingsDialog } from '../SettingsDialog';

const settings = {
  claudePath: 'claude', autoDetectClaude: true, claudeGitBashPath: '',
  defaultModel: '', detectedModel: '', modelSource: 'claude-default',
  defaultPermissionMode: 'standard', showDangerousPermissions: false,
  gitPath: 'git', vscodePath: 'code', terminalShell: 'powershell',
  theme: 'light', fontSize: 14, language: 'zh-CN', dataPath: '', autoCheckUpdates: false,
} satisfies AppSettings;

const originalApi = window.api;

beforeEach(() => {
  setLocale('zh-CN');
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      getSettings: vi.fn().mockResolvedValue(settings),
      checkEnvironment: vi.fn().mockResolvedValue({}),
      getConnectionStatus: vi.fn().mockResolvedValue({}),
      listModelTierBindings: vi.fn().mockResolvedValue([]),
      listModelTierCandidates: vi.fn().mockResolvedValue([]),
      getAgentPresetStatus: vi.fn().mockResolvedValue({ kind: 'custom' }),
      prepareAgentPreset: vi.fn(), previewAgentPreset: vi.fn(), applyAgentPreset: vi.fn(),
      setModelTierBinding: vi.fn(), bindAllModelTiers: vi.fn(),
      updateModelTierDisplayMetadata: vi.fn(), clearProjectModelTierBinding: vi.fn(),
      listModelProviders: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 }),
      listAgentModelPolicies: vi.fn().mockResolvedValue([]),
      listAgentModelPolicyReferences: vi.fn().mockResolvedValue([]),
      getModelProvider: vi.fn(), listModelProviderModels: vi.fn(),
      setAgentModelPolicy: vi.fn(), deleteAgentModelPolicy: vi.fn(),
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi });
});

describe('SettingsDialog Agent category', () => {
  it('hosts global model tiers, Agent templates, and the existing manual role controls', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={vi.fn()} />);

    expect(await screen.findByRole('dialog', { name: '设置' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '关闭' })).not.toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Agent' }));
    expect(await screen.findByRole('heading', { name: '模型档位' })).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Agent 模板' })).not.toBeNull();
    expect(await screen.findByTestId('agent-model-policy-editor')).not.toBeNull();
  });

  it('focuses, traps, closes with Escape, and returns focus to the opener', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open settings</button>
        {open ? <SettingsDialog onClose={() => setOpen(false)} /> : null}
      </>;
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open settings' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: '设置' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const focusables = within(dialog).getAllByRole('button').filter((button) => !button.hasAttribute('disabled'));
    focusables.at(-1)!.focus();
    await user.tab();
    expect(document.activeElement).toBe(focusables[0]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(focusables.at(-1));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('keeps the outer Settings modal inert while the Agent child modal is topmost', async () => {
    const user = userEvent.setup();
    vi.mocked(window.api.prepareAgentPreset).mockResolvedValue({ step: 'bind_tiers', missingTiers: ['balanced'] });
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} />);
    await user.click(await screen.findByRole('button', { name: 'Agent' }));
    await user.click(await screen.findByRole('button', { name: '应用软件开发模板' }));
    expect(await screen.findByRole('dialog', { name: '配置模型档位' })).not.toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '配置模型档位' })).toBeNull());
    expect(screen.getByRole('dialog', { name: '设置' })).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the complete manual role editor in English with tier-aware values', async () => {
    setLocale('en-US');
    vi.mocked(window.api.listAgentModelPolicyReferences).mockResolvedValue([{
      scope: { type: 'global' },
      agentType: 'planner',
      reference: { kind: 'tier', tier: 'high_quality' },
      providerName: null,
      notes: { quality: 'high', speed: 'medium', cost: 'low' },
      createdAt: 1,
      updatedAt: 2,
    }]);
    render(<SettingsDialog onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Agent' }));
    const editor = await screen.findByTestId('agent-model-policy-editor');
    const planner = within(editor).getByRole('combobox', { name: 'Planner model' });
    expect(within(planner).getByRole('option', { name: 'Tier: High quality' })).not.toBeNull();
    expect((planner as HTMLSelectElement).value).toBe('tier:high_quality');
    expect(within(editor).getAllByText('Quality').length).toBeGreaterThan(0);
    expect(within(editor).getAllByRole('option', { name: 'High' }).length).toBeGreaterThan(0);
    expect(editor.textContent).not.toContain('质量');
    expect(editor.textContent).not.toContain('速度');
    expect(editor.textContent).not.toContain('成本');
  });

  it('replaces one tier reference with a direct model and refreshes status to Custom', async () => {
    const user = userEvent.setup();
    const provider = {
      id: 'mimo', name: 'MiMo', type: 'anthropic-compatible', apiFormat: 'anthropic-messages',
      runtimeType: 'claude-code', baseUrl: 'https://api.example.test', baseUrlPathRedacted: false,
      enabled: true, isDefault: false, configured: true, credentialSource: 'credential_store',
      capabilities: { supportsClaudeCode: true, supportsAgentWorkflow: true, supportsTools: true, supportsMCP: true, supportsStreaming: true, supportsVision: false },
      supportedUses: ['chat', 'agent_task', 'claude_code', 'mcp_tools'],
      health: { state: 'connected', lastTestedAt: 1, lastErrorType: null, latencyMs: 1 },
      defaultModelId: 'mimo-v2.5-pro', createdAt: 1, updatedAt: 2,
    } satisfies PublicModelProvider;
    const tierReference = {
      scope: { type: 'global' as const }, agentType: 'planner' as const,
      reference: { kind: 'tier' as const, tier: 'high_quality' as const },
      providerName: null,
      notes: { quality: null, speed: null, cost: null }, createdAt: 1, updatedAt: 2,
    };
    vi.mocked(window.api.getAgentPresetStatus)
      .mockResolvedValueOnce({ kind: 'preset', presetId: 'software_development' })
      .mockResolvedValue({ kind: 'custom' });
    vi.mocked(window.api.listModelProviders).mockResolvedValue({ items: [provider], total: 1, limit: 100, offset: 0 });
    vi.mocked(window.api.listModelProviderModels).mockResolvedValue([{
      providerId: 'mimo', modelId: 'mimo-v2.5-pro', displayName: 'MiMo Pro', source: 'manual', createdAt: 1, updatedAt: 1,
    }]);
    let directPolicySaved = false;
    vi.mocked(window.api.listAgentModelPolicyReferences).mockImplementation(async () => directPolicySaved ? [{
      ...tierReference,
      reference: { kind: 'model', providerId: 'mimo', modelId: 'mimo-v2.5-pro' },
      providerName: 'MiMo',
    }] : [tierReference]);
    vi.mocked(window.api.listAgentModelPolicies).mockImplementation(async () => directPolicySaved ? [{
      agentType: 'planner', providerId: 'mimo', modelId: 'mimo-v2.5-pro',
      notes: { quality: null, speed: null, cost: null }, createdAt: 1, updatedAt: 2,
    }] : []);
    vi.mocked(window.api.setAgentModelPolicy).mockImplementation(async () => {
      directPolicySaved = true;
      return {
      agentType: 'planner', providerId: 'mimo', modelId: 'mimo-v2.5-pro',
      notes: { quality: null, speed: null, cost: null }, createdAt: 1, updatedAt: 2,
      };
    });

    render(<SettingsDialog onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Agent' }));
    const planner = await screen.findByRole('combobox', { name: 'Planner 模型' });
    expect((planner as HTMLSelectElement).value).toBe('tier:high_quality');
    await user.selectOptions(planner, 'mimo:mimo-v2.5-pro');
    await waitFor(() => expect(window.api.setAgentModelPolicy).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'planner', providerId: 'mimo', modelId: 'mimo-v2.5-pro',
    })));
    expect(await screen.findByText('已自定义')).not.toBeNull();
  });
});
