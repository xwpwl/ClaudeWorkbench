import { describe, expect, it, vi } from 'vitest';
import {
  UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE,
  type ResolvedModelSelection,
} from '../../../shared/types/modelProviders';
import type {
  ModelTierCandidatePublic,
  ModelTierResolutionPublic,
  PersistedModelPolicyReference,
} from '../../../shared/types/modelTiers';
import type { RuntimeProviderDescriptor } from '../AgentRuntime';
import {
  ModelSelectionResolver,
  ModelSwitchError,
  type ModelSelectionStore,
  type PersistedModelSelection,
} from '../ModelSelectionResolver';
import type { StoredModelProvider, StoredProviderModel } from '../ModelProviderService';

function capabilities(overrides: Partial<StoredModelProvider['capabilities']> = {}) {
  return {
    supportsClaudeCode: true,
    supportsAgentWorkflow: true,
    supportsTools: true,
    supportsMCP: true,
    supportsStreaming: true,
    supportsVision: false,
    ...overrides,
  };
}

function provider(overrides: Partial<StoredModelProvider> = {}): StoredModelProvider {
  return {
    id: 'provider-default',
    name: 'Default Provider',
    type: 'anthropic-compatible',
    apiFormat: 'anthropic-messages',
    runtimeType: 'claude-code',
    baseUrl: 'https://provider.example',
    credentialRef: 'safe-storage://v1/ref',
    defaultModelId: 'default-model',
    enabled: true,
    isDefault: true,
    capabilities: capabilities(),
    health: { state: 'connected', lastTestedAt: 1, lastErrorType: null, latencyMs: 1 },
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function model(providerId: string, modelId: string): StoredProviderModel {
  return {
    providerId, modelId, displayName: null, source: 'manual', createdAt: 1, updatedAt: 1,
  };
}

class FakeStore implements ModelSelectionStore {
  providers = new Map<string, StoredModelProvider>();
  models = new Map<string, StoredProviderModel[]>();
  task = new Map<string, PersistedModelSelection>();
  project = new Map<string, PersistedModelSelection>();
  agent = new Map<string, PersistedModelSelection>();
  projectReferences = new Map<string, PersistedModelPolicyReference>();
  agentReferences = new Map<string, PersistedModelPolicyReference>();

  getTaskModelOverride(taskId: string) { return this.task.get(taskId) ?? null; }
  setTaskModelOverride(value: PersistedModelSelection & { taskId: string }) {
    this.task.set(value.taskId, { providerId: value.providerId, modelId: value.modelId });
  }
  deleteTaskModelOverride(taskId: string) { this.task.delete(taskId); }
  getProjectModelPolicy(projectId: string, agentType: string) {
    return this.project.get(`${projectId}:${agentType}`) ?? null;
  }
  getAgentModelPolicy(agentType: string) { return this.agent.get(agentType) ?? null; }
  getProjectModelPolicyReference(projectId: string, agentType: string) {
    const direct = this.getProjectModelPolicy(projectId, agentType);
    const reference = this.projectReferences.get(`${projectId}:${agentType}`)
      ?? (direct ? { kind: 'model' as const, ...direct } : null);
    return reference ? { reference } : null;
  }
  getAgentModelPolicyReference(agentType: string) {
    const direct = this.getAgentModelPolicy(agentType);
    const reference = this.agentReferences.get(agentType)
      ?? (direct ? { kind: 'model' as const, ...direct } : null);
    return reference ? { reference } : null;
  }
  getDefaultProvider() { return [...this.providers.values()].find((item) => item.isDefault && item.enabled) ?? null; }
  getProvider(providerId: string) { return this.providers.get(providerId) ?? null; }
  listModels(providerId: string) { return this.models.get(providerId) ?? []; }
  listProviders(input: { limit: number; offset: number; enabled?: boolean }) {
    const values = [...this.providers.values()]
      .filter((item) => input.enabled === undefined || item.enabled === input.enabled);
    return {
      items: values.slice(input.offset, input.offset + input.limit),
      total: values.length,
      limit: input.limit,
      offset: input.offset,
    };
  }
}

function tierResolution(
  candidate: ModelTierCandidatePublic,
  tierSource: 'global' | 'project' = 'global',
): ModelTierResolutionPublic {
  return {
    scope: tierSource === 'project'
      ? { type: 'project', projectId: 'project-1' }
      : { type: 'global' },
    tier: 'fast',
    display: { tier: 'fast', displayName: null, quality: null, speed: null, cost: null },
    source: tierSource,
    binding: { tier: 'fast', providerId: candidate.providerId, modelId: candidate.modelId, updatedAt: 1 },
    candidate,
    validity: 'valid',
    invalidReason: null,
  };
}

function harness(tier?: {
  resolveTier: (scope: unknown, tier: unknown) => Promise<ModelTierResolutionPublic>;
  listCandidates: (scope: unknown) => Promise<ModelTierCandidatePublic[]>;
  prepareTrustedSnapshot?: (scope: unknown) => Promise<object>;
  resolvePreparedBindings?: (scope: unknown, prepared: object) => ModelTierResolutionPublic[];
}, credentialExists: (reference: string) => boolean = () => true) {
  const store = new FakeStore();
  const providers = [
    provider(),
    provider({ id: 'provider-task', name: 'Task Provider', isDefault: false, defaultModelId: 'task-model' }),
    provider({ id: 'provider-project', name: 'Project Provider', isDefault: false, defaultModelId: 'project-model' }),
    provider({ id: 'provider-agent', name: 'Agent Provider', isDefault: false, defaultModelId: 'agent-model' }),
  ];
  for (const item of providers) {
    store.providers.set(item.id, item);
    store.models.set(item.id, [model(item.id, item.defaultModelId as string)]);
  }
  const assertRunnable = vi.fn((
    _descriptor: RuntimeProviderDescriptor,
    _use: 'chat' | 'agent-workflow',
  ) => ({ type: 'claude-code' }));
  const runtimeGate = { assertRunnable };
  const environmentSelection = vi.fn(() => null);
  const resolver = new ModelSelectionResolver({
    store,
    runtimeGate,
    resolveEnvironmentSelection: environmentSelection,
    credentialExists,
    ...(tier ? { tierResolver: tier } : {}),
    now: () => 5_000,
  });
  return { resolver, store, runtimeGate, environmentSelection };
}

const request = {
  taskId: 'task-1',
  projectId: 'project-1',
  agentType: 'planner' as const,
  fallbackModelId: 'fallback-model',
  use: 'agent-workflow' as const,
};

describe('ModelSelectionResolver priority and capability checks', () => {
  it('snapshots every workflow role once using role-specific fallback models', async () => {
    const test = harness();
    test.store.providers.get('provider-default')!.isDefault = false;

    const snapshot = await test.resolver.snapshotWorkflowPolicy({
      taskId: 'task-1',
      projectId: 'project-1',
      fallbackModelIds: {
        planner: 'planner-fallback',
        coder: 'coder-fallback',
        tester: 'tester-fallback',
        reviewer: 'reviewer-fallback',
        fixer: 'fixer-fallback',
      },
    });

    expect(Object.fromEntries(Object.entries(snapshot).map(([role, value]) => [
      role,
      { providerId: value.providerId, modelId: value.modelId, source: value.source },
    ]))).toEqual({
      planner: { providerId: 'claude-code:default', modelId: 'planner-fallback', source: 'claude_code' },
      coder: { providerId: 'claude-code:default', modelId: 'coder-fallback', source: 'claude_code' },
      tester: { providerId: 'claude-code:default', modelId: 'tester-fallback', source: 'claude_code' },
      reviewer: { providerId: 'claude-code:default', modelId: 'reviewer-fallback', source: 'claude_code' },
      fixer: { providerId: 'claude-code:default', modelId: 'fixer-fallback', source: 'claude_code' },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('keeps task override highest when the project role is a tier reference', async () => {
    const candidate: ModelTierCandidatePublic = {
      providerId: 'provider-project', providerName: 'Project Provider', modelId: 'project-model',
      runtimeType: 'claude-code', executionSource: 'database_provider',
      modelDisplayName: null, health: { state: 'connected', lastTestedAt: 1 },
    };
    const resolveTier = vi.fn(async () => tierResolution(candidate, 'project'));
    const test = harness({ resolveTier, listCandidates: vi.fn(async () => [candidate]) });
    test.store.task.set('task-1', { providerId: 'provider-task', modelId: 'task-model' });
    test.store.projectReferences.set('project-1:planner', { kind: 'tier', tier: 'fast' });

    await expect(test.resolver.resolve(request)).resolves.toMatchObject({
      providerId: 'provider-task', source: 'task_override', executionSource: 'database_provider',
    });
    expect(resolveTier).not.toHaveBeenCalled();
  });

  it('resolves a tier inside the winning project-policy layer with separate execution provenance', async () => {
    const candidate: ModelTierCandidatePublic = {
      providerId: `synthetic:v1:environment:${'a'.repeat(64)}`,
      providerName: 'Environment', modelId: 'env-model', runtimeType: 'claude-code',
      executionSource: 'environment', modelDisplayName: null,
      health: { state: 'connected', lastTestedAt: null },
    };
    const resolveTier = vi.fn(async () => tierResolution(candidate, 'project'));
    const test = harness({ resolveTier, listCandidates: vi.fn(async () => [candidate]) });
    test.store.providers.get('provider-default')!.isDefault = false;
    test.store.projectReferences.set('project-1:planner', { kind: 'tier', tier: 'fast' });
    test.environmentSelection.mockReturnValue({
      providerId: 'environment:anthropic', providerName: 'Environment', modelId: 'env-model',
      runtimeType: 'claude-code', executionSource: 'environment',
      capabilities: capabilities(), source: 'environment',
    });

    await expect(test.resolver.resolve(request)).resolves.toMatchObject({
      providerId: candidate.providerId,
      modelId: 'env-model',
      source: 'project_policy',
      executionSource: 'environment',
      tier: 'fast',
      tierSource: 'project',
    });
    expect(resolveTier).toHaveBeenCalledWith(
      { type: 'project', projectId: 'project-1' },
      'fast',
    );
  });

  it('freezes all five concrete tier selections for one Workflow while the next sees edits', async () => {
    const oldCandidate: ModelTierCandidatePublic = {
      providerId: 'provider-project', providerName: 'Project Provider', modelId: 'project-model',
      runtimeType: 'claude-code', executionSource: 'database_provider',
      modelDisplayName: null, health: { state: 'connected', lastTestedAt: 1 },
    };
    const newCandidate: ModelTierCandidatePublic = {
      providerId: 'provider-agent', providerName: 'Agent Provider', modelId: 'agent-model',
      runtimeType: 'claude-code', executionSource: 'database_provider',
      modelDisplayName: null, health: { state: 'connected', lastTestedAt: 1 },
    };
    let active = oldCandidate;
    const resolveTier = vi.fn(async () => tierResolution(active, 'global'));
    const listCandidates = vi.fn(async () => [oldCandidate, newCandidate]);
    const test = harness({ resolveTier, listCandidates });
    test.store.providers.get('provider-default')!.isDefault = false;
    for (const role of ['planner', 'coder', 'tester', 'reviewer', 'fixer'] as const) {
      test.store.agentReferences.set(role, { kind: 'tier', tier: 'fast' });
    }

    const current = await test.resolver.snapshotWorkflowPolicy({
      taskId: 'task-1', projectId: 'project-1', fallbackModelIds: {},
    });
    active = newCandidate;
    const currentStage = await test.resolver.revalidatePinnedSelection(current.coder, {
      ...request, agentType: 'coder',
    });
    const next = await test.resolver.snapshotWorkflowPolicy({
      taskId: 'task-1', projectId: 'project-1', fallbackModelIds: {},
    });

    expect(Object.values(current).map(({ modelId }) => modelId))
      .toEqual(Array(5).fill('project-model'));
    expect(currentStage.modelId).toBe('project-model');
    expect(next.coder.modelId).toBe('agent-model');
  });

  it('uses one prepared trusted tier snapshot for all five Workflow roles', async () => {
    const oldCandidate: ModelTierCandidatePublic = {
      providerId: 'provider-project', providerName: 'Project Provider', modelId: 'project-model',
      runtimeType: 'claude-code', executionSource: 'database_provider',
      modelDisplayName: null, health: { state: 'connected', lastTestedAt: 1 },
    };
    const newCandidate: ModelTierCandidatePublic = {
      providerId: 'provider-agent', providerName: 'Agent Provider', modelId: 'agent-model',
      runtimeType: 'claude-code', executionSource: 'database_provider',
      modelDisplayName: null, health: { state: 'connected', lastTestedAt: 1 },
    };
    let active = oldCandidate;
    const prepared = {};
    const test = harness({
      prepareTrustedSnapshot: vi.fn(async () => {
        const captured = active;
        (prepared as { captured?: ModelTierCandidatePublic }).captured = captured;
        active = newCandidate;
        return prepared;
      }),
      resolvePreparedBindings: vi.fn((_scope, token) => [
        tierResolution((token as { captured: ModelTierCandidatePublic }).captured, 'global'),
      ]),
      resolveTier: vi.fn(async () => {
        const current = active;
        active = newCandidate;
        return tierResolution(current, 'global');
      }),
      listCandidates: vi.fn(async () => [oldCandidate, newCandidate]),
    });
    test.store.providers.get('provider-default')!.isDefault = false;
    for (const role of ['planner', 'coder', 'tester', 'reviewer', 'fixer'] as const) {
      test.store.agentReferences.set(role, { kind: 'tier', tier: 'fast' });
    }

    const snapshot = await test.resolver.snapshotWorkflowPolicy({
      taskId: 'task-1', projectId: 'project-1', fallbackModelIds: {},
    });

    expect(Object.values(snapshot).map(({ modelId }) => modelId))
      .toEqual(Array(5).fill('project-model'));
  });

  it('fails a pinned synthetic stage closed when its exact execution identity disappears', async () => {
    const candidate: ModelTierCandidatePublic = {
      providerId: `synthetic:v1:environment:${'b'.repeat(64)}`,
      providerName: 'Environment', modelId: 'env-model', runtimeType: 'claude-code',
      executionSource: 'environment', modelDisplayName: null,
      health: { state: 'connected', lastTestedAt: null },
    };
    const resolveTier = vi.fn(async () => tierResolution(candidate, 'global'));
    const listCandidates = vi.fn(async () => []);
    const test = harness({ resolveTier, listCandidates });
    const pinned = {
      providerId: candidate.providerId, providerName: candidate.providerName, modelId: candidate.modelId,
      runtimeType: 'claude-code' as const, source: 'global_agent_policy' as const,
      executionSource: 'environment' as const, tier: 'fast' as const, tierSource: 'global' as const,
      capabilities: capabilities(),
    };

    await expect(test.resolver.revalidatePinnedSelection(pinned, request))
      .rejects.toThrow(/pinned.*identity/iu);
    expect(listCandidates).toHaveBeenCalledWith({ type: 'project', projectId: 'project-1' });
    expect(resolveTier).not.toHaveBeenCalled();
  });

  it('revalidates a pinned database tier through the trusted candidate snapshot', async () => {
    const candidate: ModelTierCandidatePublic = {
      providerId: 'provider-project', providerName: 'Project Provider', modelId: 'project-model',
      runtimeType: 'claude-code', executionSource: 'database_provider',
      modelDisplayName: null, health: { state: 'connected', lastTestedAt: 1 },
    };
    const test = harness({
      resolveTier: vi.fn(async () => tierResolution(candidate, 'global')),
      listCandidates: vi.fn(async () => []),
    });
    const pinned = {
      providerId: candidate.providerId, providerName: candidate.providerName, modelId: candidate.modelId,
      runtimeType: 'claude-code' as const, source: 'global_agent_policy' as const,
      executionSource: 'database_provider' as const, tier: 'fast' as const, tierSource: 'global' as const,
      capabilities: capabilities(),
    };

    await expect(test.resolver.revalidatePinnedSelection(pinned, request))
      .rejects.toThrow(/pinned.*identity/iu);
  });

  it('revalidates a pinned Provider directly without consulting changed policies', async () => {
    const test = harness();
    test.store.agent.set('planner', { providerId: 'provider-agent', modelId: 'agent-model' });
    const pinned = await test.resolver.resolve(request);
    test.store.agent.set('planner', { providerId: 'provider-task', modelId: 'task-model' });

    await expect(test.resolver.revalidatePinnedSelection(pinned, request)).resolves.toMatchObject({
      providerId: 'provider-agent',
      modelId: 'agent-model',
      source: 'global_agent_policy',
    });
  });

  it('revalidates current capabilities and blocks a pinned Coder before spawn', async () => {
    const test = harness();
    const coderRequest = { ...request, agentType: 'coder' as const };
    const pinned = await test.resolver.resolve(coderRequest);
    test.store.providers.get('provider-default')!.capabilities.supportsMCP = false;

    await expect(test.resolver.revalidatePinnedSelection(pinned, coderRequest))
      .rejects.toThrow(/tools and MCP/iu);
  });

  it('does not fall through when a pinned Provider is disabled after workflow creation', async () => {
    const test = harness();
    const pinned = await test.resolver.resolve(request);
    test.store.providers.get('provider-default')!.enabled = false;

    await expect(test.resolver.revalidatePinnedSelection(pinned, request))
      .rejects.toThrow(/disabled/iu);
  });

  it('resolves task override before every policy layer', async () => {
    const test = harness();
    test.store.task.set('task-1', { providerId: 'provider-task', modelId: 'task-model' });
    test.store.project.set('project-1:planner', { providerId: 'provider-project', modelId: 'project-model' });
    test.store.agent.set('planner', { providerId: 'provider-agent', modelId: 'agent-model' });
    await expect(test.resolver.resolve(request)).resolves.toMatchObject({
      providerId: 'provider-task', modelId: 'task-model', source: 'task_override',
    });
  });

  it('resolves project role before project default and global policy', async () => {
    const test = harness();
    test.store.project.set('project-1:planner', { providerId: 'provider-project', modelId: 'project-model' });
    test.store.project.set('project-1:default', { providerId: 'provider-task', modelId: 'task-model' });
    test.store.agent.set('planner', { providerId: 'provider-agent', modelId: 'agent-model' });
    await expect(test.resolver.resolve(request)).resolves.toMatchObject({
      providerId: 'provider-project', source: 'project_policy',
    });
  });

  it('uses project default before a global role policy', async () => {
    const test = harness();
    test.store.project.set('project-1:default', { providerId: 'provider-project', modelId: 'project-model' });
    test.store.agent.set('planner', { providerId: 'provider-agent', modelId: 'agent-model' });
    await expect(test.resolver.resolve(request)).resolves.toMatchObject({
      providerId: 'provider-project', source: 'project_policy',
    });
  });

  it('uses global Agent role policy before the global default', async () => {
    const test = harness();
    test.store.agent.set('planner', { providerId: 'provider-agent', modelId: 'agent-model' });
    await expect(test.resolver.resolve(request)).resolves.toMatchObject({
      providerId: 'provider-agent', source: 'global_agent_policy',
    });
  });

  it('preserves Tester and Fixer fallback to Coder policy', async () => {
    const test = harness();
    test.store.agent.set('coder', { providerId: 'provider-agent', modelId: 'agent-model' });
    await expect(test.resolver.resolve({ ...request, agentType: 'tester' })).resolves.toMatchObject({
      providerId: 'provider-agent', source: 'global_agent_policy',
    });
    await expect(test.resolver.resolve({ ...request, agentType: 'fixer' })).resolves.toMatchObject({
      providerId: 'provider-agent', source: 'global_agent_policy',
    });
  });

  it('uses the enabled global default when no scoped policy exists', async () => {
    await expect(harness().resolver.resolve(request)).resolves.toMatchObject({
      providerId: 'provider-default', modelId: 'default-model', source: 'global_default',
    });
  });

  it('uses environment selection after application policies', async () => {
    const test = harness();
    test.store.providers.get('provider-default')!.isDefault = false;
    test.environmentSelection.mockReturnValue({
      providerId: 'environment:anthropic', providerName: '环境变量', modelId: 'env-model',
      runtimeType: 'claude-code', executionSource: 'environment',
      capabilities: capabilities(), source: 'environment',
    });
    await expect(test.resolver.resolve(request)).resolves.toMatchObject({
      providerId: 'environment:anthropic', modelId: 'env-model', source: 'environment',
    });
  });

  it('falls through to Claude Code login/default behavior last', async () => {
    const test = harness();
    test.store.providers.get('provider-default')!.isDefault = false;
    await expect(test.resolver.resolve(request)).resolves.toMatchObject({
      providerId: 'claude-code:default',
      providerName: 'Claude Code',
      modelId: 'fallback-model',
      source: 'claude_code',
      runtimeType: 'claude-code',
    });
  });

  it('returns a detached immutable snapshot of the selected Provider', async () => {
    const test = harness();
    const resolved = await test.resolver.resolve(request);
    test.store.providers.get('provider-default')!.name = 'Mutated';
    test.store.providers.get('provider-default')!.capabilities.supportsMCP = false;
    expect(resolved.providerName).toBe('Default Provider');
    expect(resolved.capabilities.supportsMCP).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.capabilities)).toBe(true);
  });

  it.each([
    [provider({ enabled: false }), /disabled/iu],
    [provider({ credentialRef: null }), /configured/iu],
  ])('rejects invalid explicit Provider state without silently falling back', async (badProvider, message) => {
    const test = harness();
    test.store.providers.set('provider-default', badProvider);
    test.store.task.set('task-1', {
      providerId: 'provider-default',
      modelId: 'default-model',
    });
    await expect(test.resolver.resolve(request)).rejects.toThrow(message);
  });

  it('rejects a model that is not owned by the selected Provider', async () => {
    const test = harness();
    test.store.task.set('task-1', { providerId: 'provider-task', modelId: 'project-model' });
    await expect(test.resolver.resolve(request)).rejects.toThrow(/does not belong/iu);
  });

  it('re-derives capabilities and blocks forged OpenAI-compatible selections', async () => {
    const test = harness();
    test.store.providers.set('provider-openai', provider({
      id: 'provider-openai',
      name: 'DeepSeek',
      type: 'openai-compatible',
      apiFormat: 'openai-chat-completions',
      runtimeType: 'claude-code',
      defaultModelId: 'deepseek-chat',
      isDefault: false,
      capabilities: capabilities(),
    }));
    test.store.models.set('provider-openai', [model('provider-openai', 'deepseek-chat')]);
    test.store.task.set('task-1', { providerId: 'provider-openai', modelId: 'deepseek-chat' });
    await expect(test.resolver.resolve(request)).rejects.toThrow(UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE);
    expect(test.runtimeGate.assertRunnable).not.toHaveBeenCalled();
  });

  it('requires Agent Workflow capability for every workflow role', async () => {
    const test = harness();
    test.store.providers.get('provider-default')!.capabilities.supportsAgentWorkflow = false;
    await expect(test.resolver.resolve(request)).rejects.toThrow(/Agent Workflow/iu);
  });

  it.each(['coder', 'tester', 'fixer'] as const)(
    'requires tools and MCP for the %s role',
    async (agentType) => {
      const test = harness();
      test.store.providers.get('provider-default')!.capabilities.supportsMCP = false;
      await expect(test.resolver.resolve({ ...request, agentType })).rejects.toThrow(/tools and MCP/iu);
    },
  );

  it('does not require mutable tools for Planner or Reviewer', async () => {
    const test = harness();
    test.store.providers.get('provider-default')!.capabilities = capabilities({
      supportsTools: false, supportsMCP: false,
    });
    expect((await test.resolver.resolve({ ...request, agentType: 'planner' })).providerId)
      .toBe('provider-default');
    expect((await test.resolver.resolve({ ...request, agentType: 'reviewer' })).providerId)
      .toBe('provider-default');
  });

  it('passes the trusted projection to the registered runtime gate', async () => {
    const test = harness();
    await test.resolver.resolve(request);
    expect(test.runtimeGate.assertRunnable).toHaveBeenCalledWith(expect.objectContaining({
      id: 'provider-default', runtimeType: 'claude-code', configured: true,
    }), 'agent-workflow');
  });
});

describe('ModelSelectionResolver task switching', () => {
  it.each(['starting', 'running', 'waiting_permission'])(
    'blocks task model switching while status is %s',
    (status) => {
      const test = harness();
      expect(() => test.resolver.setTaskOverride({
        taskId: 'task-1', providerId: 'provider-task', modelId: 'task-model', status,
      })).toThrowError(ModelSwitchError);
      expect(test.store.task.size).toBe(0);
    },
  );

  it('persists an idle task override and returns the future-calls warning', () => {
    const test = harness();
    expect(test.resolver.setTaskOverride({
      taskId: 'task-1', providerId: 'provider-task', modelId: 'task-model', status: 'idle',
    })).toEqual({
      providerId: 'provider-task',
      modelId: 'task-model',
      warning: '模型改变只影响后续 Agent 调用。',
    });
    expect(test.store.task.get('task-1')).toEqual({
      providerId: 'provider-task', modelId: 'task-model',
    });
  });

  it('validates runtime capability before persisting a task override', () => {
    const test = harness();
    test.store.providers.get('provider-task')!.enabled = false;
    expect(() => test.resolver.setTaskOverride({
      taskId: 'task-1', providerId: 'provider-task', modelId: 'task-model', status: 'idle',
    })).toThrow(/disabled/iu);
    expect(test.store.task.size).toBe(0);
  });

  it('does not offer or persist a task Agent override without tools and MCP', () => {
    const test = harness();
    test.store.providers.get('provider-task')!.capabilities = {
      ...capabilities(),
      supportsTools: false,
      supportsMCP: false,
    };

    expect(test.resolver.listTaskModelSwitchOptions().map((item) => item.providerId))
      .not.toContain('provider-task');
    expect(() => test.resolver.setTaskOverride({
      taskId: 'task-1', providerId: 'provider-task', modelId: 'task-model', status: 'idle',
    })).toThrow(/tools and MCP/iu);
    expect(test.store.task.size).toBe(0);
  });

  it('clears an idle task override without changing global settings', () => {
    const test = harness();
    test.store.task.set('task-1', { providerId: 'provider-task', modelId: 'task-model' });
    expect(test.resolver.clearTaskOverride('task-1', 'idle')).toEqual({
      warning: '模型改变只影响后续 Agent 调用。',
    });
    expect(test.store.task.size).toBe(0);
  });
});

describe('ModelSelectionResolver project inspection and trusted switch options', () => {
  it('inspects project role policy without consulting the higher task override', async () => {
    const candidate: ModelTierCandidatePublic = {
      providerId: 'provider-project', providerName: 'Project Provider', modelId: 'project-model',
      runtimeType: 'claude-code', executionSource: 'database_provider', modelDisplayName: null,
      health: { state: 'connected', lastTestedAt: 1 },
    };
    const test = harness({
      resolveTier: vi.fn(async () => tierResolution(candidate, 'project')),
      listCandidates: vi.fn(async () => [candidate]),
    });
    test.store.task.set('task-1', { providerId: 'provider-task', modelId: 'task-model' });
    test.store.projectReferences.set('project-1:planner', { kind: 'tier', tier: 'fast' });
    const prepared = new Map([['fast', tierResolution(candidate, 'project')]] as const);
    const api = test.resolver as unknown as {
      inspectProjectPolicy(
        request: { projectId: string; agentType: 'planner'; fallbackModelId: string | null },
        tiers: ReadonlyMap<'fast', ModelTierResolutionPublic>,
      ): Promise<{ available: boolean; selection?: ResolvedModelSelection; reason?: string }>;
    };

    const result = await api.inspectProjectPolicy({
      projectId: 'project-1', agentType: 'planner', fallbackModelId: 'fallback-model',
    }, prepared);

    expect(result).toMatchObject({
      available: true,
      selection: {
        providerId: 'provider-project', modelId: 'project-model', source: 'project_policy',
        tier: 'fast', tierSource: 'project',
      },
    });
  });

  it('returns a closed invalid-tier reason without silently falling back', async () => {
    const test = harness({
      resolveTier: vi.fn(async () => {
        throw new Error('unexpected tier resolver call');
      }),
      listCandidates: vi.fn(async () => []),
    });
    test.store.projectReferences.set('project-1:reviewer', { kind: 'tier', tier: 'fast' });
    const invalid: ModelTierResolutionPublic = {
      scope: { type: 'project', projectId: 'project-1' },
      tier: 'fast',
      display: { tier: 'fast', displayName: null, quality: null, speed: null, cost: null },
      source: 'project',
      binding: { tier: 'fast', providerId: 'gone', modelId: 'gone', updatedAt: 1 },
      candidate: null,
      validity: 'needs_reconfiguration',
      invalidReason: 'provider_deleted',
    };
    const api = test.resolver as unknown as {
      inspectProjectPolicy(
        request: { projectId: string; agentType: 'reviewer'; fallbackModelId: null },
        tiers: ReadonlyMap<'fast', ModelTierResolutionPublic>,
      ): Promise<{ available: boolean; reason?: string }>;
    };

    await expect(api.inspectProjectPolicy({
      projectId: 'project-1', agentType: 'reviewer', fallbackModelId: null,
    }, new Map([['fast', invalid]]))).resolves.toEqual({
      available: false,
      reason: 'provider_deleted',
    });
  });

  it.each([
    {
      name: 'a deleted Provider',
      code: 'PROVIDER_DELETED',
      reason: 'provider_deleted',
      arrange: (test: ReturnType<typeof harness>) => {
        test.store.project.set('project-1:coder', {
          providerId: 'provider-deleted', modelId: 'project-model',
        });
      },
    },
    {
      name: 'a disabled Provider',
      code: 'PROVIDER_DISABLED',
      reason: 'provider_disabled',
      arrange: (test: ReturnType<typeof harness>) => {
        test.store.project.set('project-1:coder', {
          providerId: 'provider-project', modelId: 'project-model',
        });
        test.store.providers.get('provider-project')!.enabled = false;
      },
    },
    {
      name: 'a missing vault credential whose display name contains misleading words',
      code: 'PROVIDER_UNCONFIGURED',
      reason: 'provider_unconfigured',
      arrange: (test: ReturnType<typeof harness>) => {
        test.store.project.set('project-1:coder', {
          providerId: 'provider-project', modelId: 'project-model',
        });
        Object.assign(test.store.providers.get('provider-project')!, {
          name: 'Disabled Runtime Provider', credentialRef: null,
        });
      },
    },
    {
      name: 'an unhealthy Provider',
      code: 'CONNECTION_UNAVAILABLE',
      reason: 'connection_unavailable',
      arrange: (test: ReturnType<typeof harness>) => {
        test.store.project.set('project-1:coder', {
          providerId: 'provider-project', modelId: 'project-model',
        });
        test.store.providers.get('provider-project')!.health = {
          state: 'error', lastTestedAt: 1, lastErrorType: 'network', latencyMs: null,
        };
      },
    },
    {
      name: 'a never-tested Provider',
      code: 'CONNECTION_UNAVAILABLE',
      reason: 'connection_unavailable',
      arrange: (test: ReturnType<typeof harness>) => {
        test.store.project.set('project-1:coder', {
          providerId: 'provider-project', modelId: 'project-model',
        });
        test.store.providers.get('provider-project')!.health = {
          state: 'connected', lastTestedAt: null, lastErrorType: null, latencyMs: 1,
        };
      },
    },
    {
      name: 'a model outside Provider ownership',
      code: 'MODEL_MISSING',
      reason: 'model_missing',
      arrange: (test: ReturnType<typeof harness>) => {
        test.store.project.set('project-1:coder', {
          providerId: 'provider-project', modelId: 'not-owned',
        });
      },
    },
    {
      name: 'a recomputed incompatible Runtime',
      code: 'RUNTIME_INCOMPATIBLE',
      reason: 'runtime_incompatible',
      arrange: (test: ReturnType<typeof harness>) => {
        test.store.project.set('project-1:coder', {
          providerId: 'provider-project', modelId: 'project-model',
        });
        Object.assign(test.store.providers.get('provider-project')!, {
          type: 'openai-compatible', apiFormat: 'openai-chat-completions',
          runtimeType: 'claude-code', capabilities: capabilities(),
        });
      },
    },
    {
      name: 'a missing Agent Workflow capability',
      code: 'WORKFLOW_CAPABILITY_MISSING',
      reason: 'workflow_capability_missing',
      arrange: (test: ReturnType<typeof harness>) => {
        test.store.project.set('project-1:coder', {
          providerId: 'provider-project', modelId: 'project-model',
        });
        test.store.providers.get('provider-project')!.capabilities.supportsAgentWorkflow = false;
      },
    },
    {
      name: 'a missing Tools capability for Coder',
      code: 'WORKFLOW_CAPABILITY_MISSING',
      reason: 'workflow_capability_missing',
      arrange: (test: ReturnType<typeof harness>) => {
        test.store.project.set('project-1:coder', {
          providerId: 'provider-project', modelId: 'project-model',
        });
        test.store.providers.get('provider-project')!.capabilities.supportsTools = false;
      },
    },
    {
      name: 'a missing MCP capability for Coder',
      code: 'WORKFLOW_CAPABILITY_MISSING',
      reason: 'workflow_capability_missing',
      arrange: (test: ReturnType<typeof harness>) => {
        test.store.project.set('project-1:coder', {
          providerId: 'provider-project', modelId: 'project-model',
        });
        test.store.providers.get('provider-project')!.capabilities.supportsMCP = false;
      },
    },
  ])('carries typed direct-model failure for $name into the closed public reason', async ({
    code, reason, arrange,
  }) => {
    const test = harness();
    arrange(test);
    const directRequest = {
      projectId: 'project-1', agentType: 'coder' as const, use: 'agent-workflow' as const,
    };

    await expect(test.resolver.resolve(directRequest)).rejects.toMatchObject({ code });
    await expect(test.resolver.inspectProjectPolicy({
      projectId: 'project-1', agentType: 'coder', fallbackModelId: null,
      includesTaskOverride: false,
    }, new Map())).resolves.toEqual({ available: false, reason });
  });

  it('maps a typed Claude CLI runtime failure without parsing localized human text', async () => {
    const test = harness();
    test.store.project.set('project-1:planner', {
      providerId: 'provider-project', modelId: 'project-model',
    });
    test.runtimeGate.assertRunnable.mockImplementation(() => {
      throw Object.assign(new Error('arbitrary localized runtime detail'), {
        code: 'CLAUDE_CLI_UNAVAILABLE',
      });
    });

    await expect(test.resolver.inspectProjectPolicy({
      projectId: 'project-1', agentType: 'planner', fallbackModelId: null,
      includesTaskOverride: false,
    }, new Map())).resolves.toEqual({
      available: false,
      reason: 'claude_cli_unavailable',
    });
  });

  it('lists only main-verified connected database models runnable by the current Runtime', () => {
    const test = harness();
    test.store.providers.set('deepseek-forged', provider({
      id: 'deepseek-forged', name: 'DeepSeek', type: 'openai-compatible',
      apiFormat: 'openai-chat-completions', runtimeType: 'claude-code',
      capabilities: capabilities(), isDefault: false, defaultModelId: 'deepseek-chat',
    }));
    test.store.models.set('deepseek-forged', [model('deepseek-forged', 'deepseek-chat')]);
    test.store.providers.set('provider-error', provider({
      id: 'provider-error', name: 'Error Provider', isDefault: false,
      health: { state: 'error', lastTestedAt: 1, lastErrorType: 'network', latencyMs: null },
    }));
    test.store.models.set('provider-error', [model('provider-error', 'error-model')]);
    test.store.providers.set(`Synthetic:${'x'.repeat(12)}`, provider({
      id: `Synthetic:${'x'.repeat(12)}`, name: 'Internal synthetic', isDefault: false,
    }));
    test.store.models.set(`Synthetic:${'x'.repeat(12)}`, [model(`Synthetic:${'x'.repeat(12)}`, 'hidden')]);
    test.store.models.get('provider-default')!.push({
      ...model('other-provider', 'forged-ownership'),
    });
    const api = test.resolver as unknown as {
      listTaskModelSwitchOptions(): Array<Record<string, unknown>>;
    };

    const result = api.listTaskModelSwitchOptions();

    expect(result).toEqual(expect.arrayContaining([
      {
        providerId: 'provider-default', providerName: 'Default Provider',
        modelId: 'default-model', modelDisplayName: null, runtimeType: 'claude-code',
        connectionState: 'connected', purpose: 'task_agent_override', source: 'configured_provider',
      },
      {
        providerId: 'provider-task', providerName: 'Task Provider',
        modelId: 'task-model', modelDisplayName: null, runtimeType: 'claude-code',
        connectionState: 'connected', purpose: 'task_agent_override', source: 'configured_provider',
      },
    ]));
    expect(JSON.stringify(result)).not.toMatch(/DeepSeek|deepseek|synthetic:|forged-ownership|credential|baseUrl|capabilities/iu);
  });

  it('excludes a Provider rejected by AgentRuntimeRegistry even when stored fields claim support', () => {
    const test = harness();
    test.runtimeGate.assertRunnable.mockImplementation((descriptor: RuntimeProviderDescriptor) => {
      if (descriptor.id === 'provider-task') throw new Error('runtime rejected');
      return { type: 'claude-code' };
    });
    const api = test.resolver as unknown as {
      listTaskModelSwitchOptions(): Array<{ providerId: string }>;
    };

    expect(api.listTaskModelSwitchOptions().map(({ providerId }) => providerId))
      .not.toContain('provider-task');
  });

  it('excludes a Provider whose credential reference no longer exists in the main credential store', () => {
    const test = harness(undefined, (reference) => !reference.includes('missing'));
    test.store.providers.get('provider-task')!.credentialRef = 'safe-storage://v1/missing';

    expect(test.resolver.listTaskModelSwitchOptions().map(({ providerId }) => providerId))
      .not.toContain('provider-task');
    expect(() => test.resolver.setTaskOverride({
      taskId: 'task-1', providerId: 'provider-task', modelId: 'task-model', status: 'idle',
    })).toThrow(/not configured/iu);
  });

  it.each([
    {
      name: 'disabled state',
      prepare: (test: ReturnType<typeof harness>) => {
        test.store.providers.get('provider-task')!.enabled = false;
        return { providerId: 'provider-task', modelId: 'task-model' };
      },
    },
    {
      name: 'missing credential reference',
      prepare: (test: ReturnType<typeof harness>) => {
        test.store.providers.get('provider-task')!.credentialRef = null;
        return { providerId: 'provider-task', modelId: 'task-model' };
      },
    },
    {
      name: 'missing credential vault entry',
      prepare: (test: ReturnType<typeof harness>) => {
        test.store.providers.get('provider-task')!.credentialRef = 'safe-storage://v1/missing';
        return { providerId: 'provider-task', modelId: 'task-model' };
      },
      credentialExists: (reference: string) => !reference.includes('missing'),
    },
    {
      name: 'unhealthy connection',
      prepare: (test: ReturnType<typeof harness>) => {
        test.store.providers.get('provider-task')!.health = {
          state: 'error', lastTestedAt: 1, lastErrorType: 'network', latencyMs: null,
        };
        return { providerId: 'provider-task', modelId: 'task-model' };
      },
    },
    {
      name: 'missing successful test timestamp',
      prepare: (test: ReturnType<typeof harness>) => {
        test.store.providers.get('provider-task')!.health = {
          state: 'connected', lastTestedAt: null, lastErrorType: null, latencyMs: 1,
        };
        return { providerId: 'provider-task', modelId: 'task-model' };
      },
    },
    {
      name: 'forged model ownership',
      prepare: (test: ReturnType<typeof harness>) => {
        test.store.models.set('provider-task', [model('provider-other', 'task-model')]);
        return { providerId: 'provider-task', modelId: 'task-model' };
      },
    },
    {
      name: 'recomputed OpenAI Runtime',
      prepare: (test: ReturnType<typeof harness>) => {
        Object.assign(test.store.providers.get('provider-task')!, {
          type: 'openai-compatible', apiFormat: 'openai-chat-completions',
          runtimeType: 'claude-code', capabilities: capabilities(),
        });
        return { providerId: 'provider-task', modelId: 'task-model' };
      },
    },
    {
      name: 'Agent Runtime Registry rejection',
      prepare: (test: ReturnType<typeof harness>) => {
        test.runtimeGate.assertRunnable.mockImplementation((_provider, use) => {
          if (use === 'agent-workflow') throw new Error('registry rejected');
          return { type: 'claude-code' };
        });
        return { providerId: 'provider-task', modelId: 'task-model' };
      },
    },
    {
      name: 'case-insensitive reserved synthetic identity',
      prepare: (test: ReturnType<typeof harness>) => {
        const providerId = `Synthetic:${'r'.repeat(16)}`;
        test.store.providers.set(providerId, provider({
          id: providerId, name: 'Reserved internal identity', isDefault: false,
          defaultModelId: 'reserved-model',
        }));
        test.store.models.set(providerId, [model(providerId, 'reserved-model')]);
        return { providerId, modelId: 'reserved-model' };
      },
    },
  ])('applies the trusted switch-option eligibility predicate again for $name', ({
    prepare, credentialExists,
  }) => {
    const test = harness(undefined, credentialExists);
    const requested = prepare(test);

    expect(test.resolver.listTaskModelSwitchOptions()).not.toEqual(expect.arrayContaining([
      expect.objectContaining(requested),
    ]));
    expect(() => test.resolver.setTaskOverride({
      taskId: 'task-eligibility', ...requested, status: 'idle',
    })).toThrow();
    expect(test.store.task.has('task-eligibility')).toBe(false);
  });
});
