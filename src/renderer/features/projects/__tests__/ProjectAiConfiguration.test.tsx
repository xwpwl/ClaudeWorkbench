// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectInspection, ProjectSettings } from '../../../../shared/types/project';
import type { ProjectAiConfigurationSummaryPublic } from '../../../../shared/types/projectAi';
import type { ModelTierResolutionPublic } from '../../../../shared/types/modelTiers';
import { setLocale } from '../../../i18n';
import { AgentModelTierSettings } from '../../settings/AgentModelTierSettings';
import { ProjectAiConfiguration, ProjectSettingsDialog } from '../ProjectSettingsDialog';

const originalApi = window.api;

afterEach(() => {
  cleanup();
  setLocale('zh-CN');
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi });
});

const SECRET = 'project-ai-secret-sentinel';
const SYNTHETIC = `synthetic:v1:${'a'.repeat(64)}`;

function resolution(
  tier: 'high_quality' | 'balanced' | 'fast',
  source: 'project' | 'global',
): ModelTierResolutionPublic {
  return {
    scope: { type: 'project', projectId: 'project-1' },
    tier,
    display: { tier, displayName: null, quality: null, speed: null, cost: null },
    source,
    binding: { tier, providerId: 'main-intent-id', modelId: `${tier}-model`, updatedAt: 1 },
    candidate: {
      providerId: 'main-intent-id',
      providerName: source === 'project' ? 'Project MiMo' : 'Global Claude',
      modelId: `${tier}-model`,
      modelDisplayName: null,
      runtimeType: 'claude-code',
      executionSource: 'database_provider',
      health: { state: 'connected', lastTestedAt: 100 },
    },
    validity: 'valid',
    invalidReason: null,
  };
}

const summary: ProjectAiConfigurationSummaryPublic = {
  includesTaskOverride: false,
  presetStatus: { kind: 'custom' },
  tiers: [
    { ...resolution('high_quality', 'project'), binding: undefined, scope: undefined, candidate: {
      providerName: 'Project MiMo', modelId: 'mimo-pro', modelDisplayName: null,
      runtimeType: 'claude-code', health: { state: 'connected', lastTestedAt: 100 },
    } },
    { ...resolution('balanced', 'global'), binding: undefined, scope: undefined, candidate: {
      providerName: 'Global Claude', modelId: 'sonnet', modelDisplayName: null,
      runtimeType: 'claude-code', health: { state: 'connected', lastTestedAt: 100 },
    } },
    {
      tier: 'fast',
      display: { tier: 'fast', displayName: null, quality: null, speed: null, cost: null },
      source: 'project', validity: 'needs_reconfiguration',
      invalidReason: 'provider_disabled', candidate: null,
    },
  ] as never,
  roles: [
    { status: 'resolved', role: 'planner', providerName: 'Project MiMo', modelId: 'mimo-pro', runtimeType: 'claude-code', source: 'project_policy', tier: 'high_quality', tierSource: 'project' },
    { status: 'resolved', role: 'coder', providerName: 'Global Claude', modelId: 'sonnet', runtimeType: 'claude-code', source: 'global_agent_policy' },
    { status: 'resolved', role: 'tester', providerName: 'Project MiMo', modelId: 'mimo-fast', runtimeType: 'claude-code', source: 'project_policy' },
    { status: 'unavailable', role: 'reviewer', reason: 'provider_disabled' },
    { status: 'resolved', role: 'fixer', providerName: 'Claude Code', modelId: 'default', runtimeType: 'claude-code', source: 'claude_code' },
  ],
};

const settings: ProjectSettings = {
  projectId: 'project-1', displayName: null, defaultModel: null,
  defaultPermission: 'plan', agentMode: 'develop', favorite: false,
  disabledMcpServers: [], updatedAt: '2026-08-09T00:00:00.000Z',
};
const inspection: ProjectInspection = {
  claudeMdExists: true,
  mcpCount: 2,
  skillCount: 3,
  git: { branch: 'main', hasChanges: true, isRepo: true, ahead: 0, behind: 0 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function namedSummary(providerName: string): ProjectAiConfigurationSummaryPublic {
  return {
    ...summary,
    roles: summary.roles.map((role) => role.role === 'planner' && role.status === 'resolved'
      ? { ...role, providerName }
      : { ...role }),
  };
}

function api(overrides: Record<string, unknown> = {}) {
  return {
    getProjectAiConfigurationSummary: vi.fn(async () => ({
      ...summary,
      credentialRef: SECRET,
      vaultPath: `/private/${SECRET}`,
      providerId: SYNTHETIC,
    } as never)),
    listModelTierCandidates: vi.fn(async () => []),
    listModelTierBindings: vi.fn(async () => [
      resolution('high_quality', 'project'),
      resolution('balanced', 'global'),
      resolution('fast', 'project'),
    ]),
    setModelTierBinding: vi.fn(),
    bindAllModelTiers: vi.fn(),
    updateModelTierDisplayMetadata: vi.fn(async (input: { metadata: { tier: 'high_quality' | 'balanced' | 'fast' } }) => resolution(input.metadata.tier, 'project')),
    clearProjectModelTierBinding: vi.fn(async () => true),
    prepareAgentPreset: vi.fn(),
    previewAgentPreset: vi.fn(),
    applyAgentPreset: vi.fn(),
    getAgentPresetStatus: vi.fn(async () => ({ kind: 'custom' as const })),
    listAgentModelPolicyReferences: vi.fn(async () => []),
    ...overrides,
  };
}

describe('Project AI configuration', () => {
  it('shows authoritative preset, tier sources, five effective roles, and invalid state without fallback', async () => {
    const port = api();
    const { container } = render(<ProjectAiConfiguration
      projectId="project-1"
      settings={settings}
      inspection={inspection}
      api={port}
      onOpenProviderCenter={() => undefined}
    />);

    expect(await screen.findByRole('region', { name: 'AI 配置' })).toBeTruthy();
    expect(screen.getAllByText('已自定义').length).toBeGreaterThan(0);
    expect(container.textContent).toMatch(/高质量.*项目/iu);
    expect(container.textContent).toMatch(/均衡.*全局/iu);
    for (const role of ['Planner', 'Coder', 'Tester', 'Reviewer', 'Fixer']) {
      expect(screen.getAllByText(role).length).toBeGreaterThan(0);
    }
    expect(container.textContent).toMatch(/Project MiMo.*mimo-pro/iu);
    expect(container.textContent).toMatch(/Reviewer.*Provider.*已停用/iu);
    expect(container.textContent).toContain('即时保存');
    expect(container.innerHTML).not.toMatch(/fallback|project-ai-secret|synthetic:v1|credential|vault|private\//iu);
  });

  it('shows permission, Git, Checkpoint, MCP, and Skills as read-only facts', async () => {
    const port = api();
    const { container } = render(<ProjectAiConfiguration
      projectId="project-1"
      settings={settings}
      inspection={inspection}
      api={port}
      onOpenProviderCenter={() => undefined}
    />);
    await screen.findByRole('region', { name: 'AI 配置' });
    expect(container.textContent).toMatch(/权限.*Plan/iu);
    expect(container.textContent).toMatch(/Git.*main/iu);
    expect(container.textContent).toMatch(/Checkpoint.*可用/iu);
    expect(container.textContent).toMatch(/MCP.*2/iu);
    expect(container.textContent).toMatch(/Skills.*3/iu);
    expect(screen.queryByRole('checkbox', { name: /Git|Checkpoint/iu })).toBeNull();
  });

  it('uses the strict Follow global intent once and refreshes authoritative tier bindings', async () => {
    const user = userEvent.setup();
    const port = api();
    port.listModelTierBindings
      .mockResolvedValueOnce([resolution('high_quality', 'project'), resolution('balanced', 'global'), resolution('fast', 'project')])
      .mockResolvedValue([resolution('high_quality', 'global'), resolution('balanced', 'global'), resolution('fast', 'global')]);
    render(<AgentModelTierSettings
      scope={{ type: 'project', projectId: 'project-1' }}
      api={port}
      onOpenProviderCenter={() => undefined}
    />);

    await user.click(await screen.findByRole('button', { name: /快速.*跟随全局/iu }));
    expect(port.clearProjectModelTierBinding).toHaveBeenCalledOnce();
    expect(port.clearProjectModelTierBinding).toHaveBeenCalledWith({
      projectId: 'project-1', tier: 'fast',
    });
    await waitFor(() => expect(port.listModelTierBindings).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText(/全局/iu).length).toBeGreaterThan(1);
  });

  it('supports English copy and marks the region as narrow-layout safe', async () => {
    setLocale('en-US');
    const port = api();
    const { container } = render(<ProjectAiConfiguration
      projectId="project-1"
      settings={settings}
      inspection={inspection}
      api={port}
      onOpenProviderCenter={() => undefined}
    />);
    expect(await screen.findByRole('region', { name: 'AI configuration' })).toBeTruthy();
    expect(container.querySelector('.project-ai-configuration')).toBeTruthy();
    expect(container.querySelector('[data-narrow-safe="true"]')).toBeTruthy();
    expect(container.textContent).toContain('Current template');
    expect(container.textContent).toContain('Model tier sources');
    expect(container.textContent).toContain('Effective Agent models');
    expect(container.textContent).toContain('Project policy');
    expect(container.textContent).toContain('Global Agent role policy');
    expect(container.textContent).toContain('Project capabilities');
    expect(container.textContent).not.toMatch(/当前模板|模型档位来源|实际 Agent 模型|项目策略|全局角色策略|项目能力/iu);
  });

  it('labels the legacy free-text model as an advanced Claude CLI fallback', async () => {
    setLocale('en-US');
    const originalApi = window.api;
    const port = api();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...originalApi,
        ...port,
        getProjectSettings: vi.fn(async () => ({ ...settings, defaultModel: 'sonnet' })),
        inspectProject: vi.fn(async () => inspection),
        listProjectPermissionRules: vi.fn(async () => ({ items: [], total: 0, limit: 50, offset: 0 })),
        listModelProviders: vi.fn(async () => ({ items: [], total: 0, limit: 100, offset: 0 })),
        listProjectModelPolicies: vi.fn(async () => []),
        onModelProviderChanged: vi.fn(() => () => undefined),
      },
    });
    const project: Project = {
      id: 'project-1', name: 'Demo', path: 'C:/demo',
      createdAt: '2026-08-09T00:00:00.000Z', lastOpenedAt: '2026-08-09T00:00:00.000Z',
    };
    render(<ProjectSettingsDialog project={project} onClose={() => undefined} />);
    const fallback = await screen.findByRole('textbox', { name: 'Advanced Claude CLI fallback model' }) as HTMLInputElement;
    expect(fallback.value).toBe('sonnet');
    expect(screen.getByText(/used only after Provider-backed project and global policies/iu)).toBeTruthy();
  });

  it('clears project A summary as soon as project B becomes the active scope', async () => {
    setLocale('en-US');
    const projectB = deferred<ProjectAiConfigurationSummaryPublic>();
    const getSummary = vi.fn(({ projectId }: { projectId: string }) => (
      projectId === 'project-a'
        ? Promise.resolve(namedSummary('Project A Summary'))
        : projectB.promise
    ));
    const port = api({ getProjectAiConfigurationSummary: getSummary });
    const view = (projectId: string) => <ProjectAiConfiguration
      projectId={projectId}
      settings={settings}
      inspection={inspection}
      api={port}
      onOpenProviderCenter={() => undefined}
    />;
    const rendered = render(view('project-a'));

    expect(await screen.findByText(/Project A Summary \/ mimo-pro/iu)).not.toBeNull();
    rendered.rerender(view('project-b'));
    await waitFor(() => expect(getSummary).toHaveBeenCalledWith({ projectId: 'project-b' }));

    expect(screen.queryByText(/Project A Summary \/ mimo-pro/iu)).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Loading');
  });

  it('keeps project B authoritative when a project A load settles later', async () => {
    setLocale('en-US');
    const projectA = deferred<ProjectAiConfigurationSummaryPublic>();
    const projectB = deferred<ProjectAiConfigurationSummaryPublic>();
    const port = api({
      getProjectAiConfigurationSummary: vi.fn(({ projectId }: { projectId: string }) => (
        projectId === 'project-a' ? projectA.promise : projectB.promise
      )),
    });
    const view = (projectId: string) => <ProjectAiConfiguration
      projectId={projectId}
      settings={settings}
      inspection={inspection}
      api={port}
      onOpenProviderCenter={() => undefined}
    />;
    const rendered = render(view('project-a'));
    rendered.rerender(view('project-b'));

    await act(async () => projectB.resolve(namedSummary('Project B Summary')));
    expect(await screen.findByText(/Project B Summary \/ mimo-pro/iu)).not.toBeNull();
    await act(async () => projectA.resolve(namedSummary('Stale Project A Summary')));

    expect(screen.queryByText(/Stale Project A Summary/iu)).toBeNull();
    expect(screen.getByText(/Project B Summary \/ mimo-pro/iu)).not.toBeNull();
  });

  it('does not confuse a prior project A incarnation with A after A to B to A navigation', async () => {
    setLocale('en-US');
    const priorA = deferred<ProjectAiConfigurationSummaryPublic>();
    const projectB = deferred<ProjectAiConfigurationSummaryPublic>();
    const currentA = deferred<ProjectAiConfigurationSummaryPublic>();
    let aCalls = 0;
    const port = api({
      getProjectAiConfigurationSummary: vi.fn(({ projectId }: { projectId: string }) => {
        if (projectId === 'project-b') return projectB.promise;
        aCalls += 1;
        return aCalls === 1 ? priorA.promise : currentA.promise;
      }),
    });
    const view = (projectId: string) => <ProjectAiConfiguration
      projectId={projectId}
      settings={settings}
      inspection={inspection}
      api={port}
      onOpenProviderCenter={() => undefined}
    />;
    const rendered = render(view('project-a'));
    rendered.rerender(view('project-b'));
    rendered.rerender(view('project-a'));

    await act(async () => currentA.resolve(namedSummary('Current Project A Summary')));
    expect(await screen.findByText(/Current Project A Summary \/ mimo-pro/iu)).not.toBeNull();
    await act(async () => priorA.resolve(namedSummary('Prior Project A Summary')));

    expect(screen.queryByText(/Prior Project A Summary/iu)).toBeNull();
    expect(screen.getByText(/Current Project A Summary \/ mimo-pro/iu)).not.toBeNull();
    await act(async () => projectB.resolve(namedSummary('Stale Project B Summary')));
    expect(screen.queryByText(/Stale Project B Summary/iu)).toBeNull();
  });

  it('ignores a stale Provider-change refresh after switching to another project', async () => {
    setLocale('en-US');
    const staleProviderRefresh = deferred<ProjectAiConfigurationSummaryPublic>();
    const projectB = deferred<ProjectAiConfigurationSummaryPublic>();
    const listeners = new Set<() => void>();
    let projectACalls = 0;
    const base = api({
      getProjectAiConfigurationSummary: vi.fn(({ projectId }: { projectId: string }) => {
        if (projectId === 'project-b') return projectB.promise;
        projectACalls += 1;
        return projectACalls === 1
          ? Promise.resolve(namedSummary('Initial Project A Summary'))
          : staleProviderRefresh.promise;
      }),
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...base,
        listModelProviders: vi.fn(async () => ({ items: [], total: 0, limit: 100, offset: 0 })),
        listProjectModelPolicies: vi.fn(async () => []),
        onModelProviderChanged: vi.fn((listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
      },
    });
    const view = (projectId: string) => <ProjectAiConfiguration
      projectId={projectId}
      settings={settings}
      inspection={inspection}
      onOpenProviderCenter={() => undefined}
    />;
    const rendered = render(view('project-a'));
    expect(await screen.findByText(/Initial Project A Summary \/ mimo-pro/iu)).not.toBeNull();

    act(() => listeners.forEach((listener) => listener()));
    await waitFor(() => expect(projectACalls).toBe(2));
    rendered.rerender(view('project-b'));
    await act(async () => projectB.resolve(namedSummary('Current Project B Summary')));
    expect(await screen.findByText(/Current Project B Summary \/ mimo-pro/iu)).not.toBeNull();
    await act(async () => staleProviderRefresh.resolve(namedSummary('Stale Provider Refresh A')));

    expect(screen.queryByText(/Stale Provider Refresh A/iu)).toBeNull();
    expect(screen.getByText(/Current Project B Summary \/ mimo-pro/iu)).not.toBeNull();
  });
});
