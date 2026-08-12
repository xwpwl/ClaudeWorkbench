import { describe, expect, it, vi } from 'vitest';
import type { RuntimeProviderDescriptor } from '../AgentRuntime';
import {
  AgentModelPolicyService,
  AgentModelPolicyServiceError,
  type AgentModelPolicyStore,
} from '../AgentModelPolicyService';
import type {
  AgentModelPolicyRecord,
  AgentModelPolicyReferenceRecord,
  ProjectModelPolicyRecord,
  ProjectModelPolicyReferenceRecord,
} from '../ModelProviderRepository';
import type { StoredModelProvider, StoredProviderModel } from '../ModelProviderService';

function provider(overrides: Partial<StoredModelProvider> = {}): StoredModelProvider {
  return {
    id: 'provider-1', name: 'MiMo', type: 'anthropic-compatible',
    apiFormat: 'anthropic-messages', runtimeType: 'claude-code',
    baseUrl: 'https://mimo.example', credentialRef: 'safe-storage://v1/ref',
    defaultModelId: 'mimo-pro', enabled: true, isDefault: false,
    capabilities: {
      supportsClaudeCode: true, supportsAgentWorkflow: true, supportsTools: true,
      supportsMCP: true, supportsStreaming: true, supportsVision: false,
    },
    health: { state: 'connected', lastTestedAt: 1, lastErrorType: null, latencyMs: 1 },
    metadata: {}, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

class FakePolicyStore implements AgentModelPolicyStore {
  providers = new Map<string, StoredModelProvider>();
  models = new Map<string, StoredProviderModel[]>();
  agents = new Map<string, AgentModelPolicyRecord>();
  agentReferences = new Map<string, AgentModelPolicyReferenceRecord>();
  projects = new Map<string, ProjectModelPolicyRecord>();
  projectReferences = new Map<string, ProjectModelPolicyReferenceRecord>();
  getProvider(id: string) { return this.providers.get(id) ?? null; }
  listModels(id: string) { return this.models.get(id) ?? []; }
  setAgentModelPolicy(value: AgentModelPolicyRecord) {
    this.agents.set(value.agentType, value);
    this.agentReferences.set(value.agentType, {
      agentType: value.agentType,
      reference: { kind: 'model', providerId: value.providerId, modelId: value.modelId },
      quality: value.quality, speed: value.speed, cost: value.cost,
      createdAt: value.createdAt, updatedAt: value.updatedAt,
    });
  }
  getAgentModelPolicy(role: AgentModelPolicyRecord['agentType']) { return this.agents.get(role) ?? null; }
  listAgentModelPolicies() { return [...this.agents.values()]; }
  deleteAgentModelPolicy(role: AgentModelPolicyRecord['agentType']) {
    const removed = this.agentReferences.delete(role) || this.agents.has(role);
    this.agents.delete(role);
    return removed;
  }
  setAgentModelPolicyReference(value: AgentModelPolicyReferenceRecord) {
    this.agentReferences.set(value.agentType, value);
    if (value.reference.kind === 'model') {
      this.agents.set(value.agentType, {
        agentType: value.agentType,
        providerId: value.reference.providerId,
        modelId: value.reference.modelId,
        quality: value.quality,
        speed: value.speed,
        cost: value.cost,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      });
    } else {
      this.agents.delete(value.agentType);
    }
  }
  getAgentModelPolicyReference(role: AgentModelPolicyRecord['agentType']) {
    return this.agentReferences.get(role) ?? null;
  }
  listAgentModelPolicyReferences() { return [...this.agentReferences.values()]; }
  setProjectModelPolicy(value: ProjectModelPolicyRecord) {
    this.projects.set(`${value.projectId}:${value.agentType}`, value);
  }
  getProjectModelPolicy(projectId: string, role: ProjectModelPolicyRecord['agentType']) {
    return this.projects.get(`${projectId}:${role}`) ?? null;
  }
  listProjectModelPolicies(projectId: string) {
    return [...this.projects.values()].filter((value) => value.projectId === projectId);
  }
  listProjectModelPolicyReferences(projectId: string) {
    return [...this.projectReferences.values()].filter((value) => value.projectId === projectId);
  }
  deleteProjectModelPolicy(projectId: string, role: ProjectModelPolicyRecord['agentType']) {
    return this.projects.delete(`${projectId}:${role}`);
  }
}

function harness(overrides: Partial<StoredModelProvider> = {}) {
  const store = new FakePolicyStore();
  const value = provider(overrides);
  store.providers.set(value.id, value);
  store.models.set(value.id, [{
    providerId: value.id, modelId: 'mimo-pro', displayName: null, source: 'manual',
    createdAt: 1, updatedAt: 1,
  }]);
  const assertRunnable = vi.fn((_value: RuntimeProviderDescriptor) => ({}));
  const service = new AgentModelPolicyService({
    store,
    runtimeGate: { assertRunnable },
    now: () => 3_000,
    projectExists: (id) => id === 'project-1',
  });
  return { service, store, assertRunnable };
}

describe('AgentModelPolicyService', () => {
  it('stores global Planner policy with informational quality/speed/cost notes', () => {
    const test = harness();
    expect(test.service.setAgentPolicy({
      agentType: 'planner', providerId: 'provider-1', modelId: 'mimo-pro',
      quality: 'high', speed: 'medium', cost: 'low',
    })).toEqual({
      agentType: 'planner', providerId: 'provider-1', modelId: 'mimo-pro',
      quality: 'high', speed: 'medium', cost: 'low', createdAt: 3_000, updatedAt: 3_000,
    });
    expect(test.assertRunnable).toHaveBeenCalledOnce();
  });

  it('preserves created time while updating notes', () => {
    const test = harness();
    test.store.agents.set('planner', {
      agentType: 'planner', providerId: 'provider-1', modelId: 'mimo-pro',
      quality: null, speed: null, cost: null, createdAt: 1_000, updatedAt: 1_000,
    });
    expect(test.service.setAgentPolicy({
      agentType: 'planner', providerId: 'provider-1', modelId: 'mimo-pro',
      quality: 'high', speed: null, cost: null,
    })).toMatchObject({ createdAt: 1_000, updatedAt: 3_000, quality: 'high' });
  });

  it('updates notes without replacing an existing tier reference', () => {
    const test = harness();
    test.store.setAgentModelPolicyReference({
      agentType: 'planner',
      reference: { kind: 'tier', tier: 'high_quality' },
      quality: null, speed: null, cost: null, createdAt: 1_000, updatedAt: 1_000,
    });

    expect(test.service.updateAgentPolicyNotes({
      agentType: 'planner', quality: 'high', speed: 'medium', cost: 'low',
    })).toEqual({
      agentType: 'planner',
      reference: { kind: 'tier', tier: 'high_quality' },
      quality: 'high', speed: 'medium', cost: 'low', createdAt: 1_000, updatedAt: 3_000,
    });
  });

  it('turns a tier reference into a direct model reference on manual model selection', () => {
    const test = harness();
    test.store.setAgentModelPolicyReference({
      agentType: 'coder',
      reference: { kind: 'tier', tier: 'balanced' },
      quality: 'high', speed: null, cost: null, createdAt: 1_000, updatedAt: 1_000,
    });

    test.service.setAgentPolicy({
      agentType: 'coder', providerId: 'provider-1', modelId: 'mimo-pro',
      quality: 'high', speed: null, cost: null,
    });
    expect(test.store.getAgentModelPolicyReference('coder')).toMatchObject({
      reference: { kind: 'model', providerId: 'provider-1', modelId: 'mimo-pro' },
      createdAt: 1_000,
      updatedAt: 3_000,
    });
  });

  it('lists policies in stable role order and deletes explicitly', () => {
    const test = harness();
    for (const agentType of ['reviewer', 'planner'] as const) {
      test.service.setAgentPolicy({
        agentType, providerId: 'provider-1', modelId: 'mimo-pro',
        quality: null, speed: null, cost: null,
      });
    }
    expect(test.service.listAgentPolicies().map((item) => item.agentType))
      .toEqual(['planner', 'reviewer']);
    expect(test.service.deleteAgentPolicy('planner')).toBe(true);
    expect(test.service.getAgentPolicy('planner')).toBeNull();
  });

  it('lists closed model-or-tier references for the requested scope in stable role order', () => {
    const test = harness();
    test.store.setAgentModelPolicyReference({
      agentType: 'reviewer', reference: { kind: 'tier', tier: 'high_quality' },
      quality: 'high', speed: null, cost: null, createdAt: 1, updatedAt: 2,
    });
    test.store.setAgentModelPolicyReference({
      agentType: 'planner', reference: { kind: 'model', providerId: 'provider-1', modelId: 'mimo-pro' },
      quality: null, speed: 'medium', cost: null, createdAt: 3, updatedAt: 4,
    });

    expect(test.service.listAgentPolicyReferences({ type: 'global' })).toEqual([
      expect.objectContaining({ agentType: 'planner', reference: { kind: 'model', providerId: 'provider-1', modelId: 'mimo-pro' }, providerName: 'MiMo' }),
      expect.objectContaining({ agentType: 'reviewer', reference: { kind: 'tier', tier: 'high_quality' }, providerName: null }),
    ]);
  });

  it.each(['quality', 'speed', 'cost'] as const)('rejects invalid %s notes', (key) => {
    const test = harness();
    expect(() => test.service.setAgentPolicy({
      agentType: 'planner', providerId: 'provider-1', modelId: 'mimo-pro',
      quality: null, speed: null, cost: null, [key]: 'automatic',
    } as never)).toThrowError(AgentModelPolicyServiceError);
  });

  it.each([
    [{ enabled: false }, /disabled/iu],
    [{ credentialRef: null }, /configured/iu],
    [{ capabilities: { ...provider().capabilities, supportsAgentWorkflow: false } }, /不能用于 Agent/u],
  ])('rejects unusable Providers', (override, error) => {
    const test = harness(override);
    expect(() => test.service.setAgentPolicy({
      agentType: 'planner', providerId: 'provider-1', modelId: 'mimo-pro',
      quality: null, speed: null, cost: null,
    })).toThrow(error);
  });

  it('re-derives capability ceilings and rejects raw OpenAI-compatible Providers', () => {
    const test = harness({
      type: 'openai-compatible', apiFormat: 'openai-chat-completions',
      runtimeType: 'claude-code', capabilities: provider().capabilities,
    });
    expect(() => test.service.setAgentPolicy({
      agentType: 'reviewer', providerId: 'provider-1', modelId: 'mimo-pro',
      quality: null, speed: null, cost: null,
    })).toThrowError(expect.objectContaining({
      code: 'RUNTIME_INCOMPATIBLE',
      message: '该模型当前不能用于 Agent，请重新选择。',
    }));
    expect(test.assertRunnable).not.toHaveBeenCalled();
  });

  it.each(['coder', 'tester', 'fixer'] as const)('requires tools and MCP for %s', (agentType) => {
    const test = harness({
      capabilities: { ...provider().capabilities, supportsMCP: false },
    });
    expect(() => test.service.setAgentPolicy({
      agentType, providerId: 'provider-1', modelId: 'mimo-pro',
      quality: null, speed: null, cost: null,
    })).toThrow(/不能用于 Agent/u);
  });

  it('permits a read-only Reviewer without tools/MCP', () => {
    const test = harness({
      capabilities: { ...provider().capabilities, supportsTools: false, supportsMCP: false },
    });
    expect(test.service.setAgentPolicy({
      agentType: 'reviewer', providerId: 'provider-1', modelId: 'mimo-pro',
      quality: 'high', speed: 'low', cost: 'high',
    }).agentType).toBe('reviewer');
  });

  it('rejects cross-Provider and missing model identities', () => {
    const test = harness();
    expect(() => test.service.setAgentPolicy({
      agentType: 'planner', providerId: 'provider-1', modelId: 'other-model',
      quality: null, speed: null, cost: null,
    })).toThrow(/does not belong/iu);
    expect(() => test.service.setAgentPolicy({
      agentType: 'planner', providerId: 'missing', modelId: 'mimo-pro',
      quality: null, speed: null, cost: null,
    })).toThrow(/not found/iu);
  });

  it('stores project default and role policies without crossing project identity', () => {
    const test = harness();
    const result = test.service.setProjectPolicy({
      projectId: 'project-1', agentType: 'default', providerId: 'provider-1',
      modelId: 'mimo-pro',
    });
    expect(result).toMatchObject({ projectId: 'project-1', agentType: 'default' });
    expect(test.service.listProjectPolicies('project-1')).toEqual([result]);
    expect(() => test.service.setProjectPolicy({
      projectId: 'missing', agentType: 'planner', providerId: 'provider-1', modelId: 'mimo-pro',
    })).toThrow(/project/iu);
  });

  it('deletes only the requested project role policy', () => {
    const test = harness();
    for (const agentType of ['default', 'planner'] as const) {
      test.service.setProjectPolicy({
        projectId: 'project-1', agentType, providerId: 'provider-1', modelId: 'mimo-pro',
      });
    }
    expect(test.service.deleteProjectPolicy('project-1', 'planner')).toBe(true);
    expect(test.service.getProjectPolicy('project-1', 'default')).not.toBeNull();
  });
});
