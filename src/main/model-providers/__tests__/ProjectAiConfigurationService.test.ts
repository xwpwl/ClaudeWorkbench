import { describe, expect, it, vi } from 'vitest';
import type {
  ModelPolicyAgentType,
  ResolvedModelSelection,
} from '../../../shared/types/modelProviders';
import type {
  ModelTier,
  ModelTierResolutionPublic,
} from '../../../shared/types/modelTiers';
import { ProjectAiConfigurationService } from '../ProjectAiConfigurationService';

const SECRET = 'api-key-project-ai-secret';
const PRIVATE_PATH = '/private/gateway/path';
const SYNTHETIC = `synthetic:v1:environment:${'a'.repeat(64)}`;

function validTier(
  tier: ModelTier,
  source: 'global' | 'project',
  providerName: string,
  modelId: string,
): ModelTierResolutionPublic {
  const providerId = source === 'global' ? SYNTHETIC : 'provider-project';
  return {
    scope: { type: 'project', projectId: 'project-1' },
    tier,
    display: { tier, displayName: null, quality: null, speed: null, cost: null },
    source,
    binding: { tier, providerId, modelId, updatedAt: 10 },
    candidate: {
      providerId,
      providerName,
      modelId,
      modelDisplayName: null,
      runtimeType: 'claude-code',
      executionSource: source === 'global' ? 'environment' : 'database_provider',
      health: { state: 'connected', lastTestedAt: 20 },
    },
    validity: 'valid',
    invalidReason: null,
  };
}

function invalidTier(tier: ModelTier): ModelTierResolutionPublic {
  return {
    scope: { type: 'project', projectId: 'project-1' },
    tier,
    display: { tier, displayName: null, quality: null, speed: null, cost: null },
    source: 'project',
    binding: { tier, providerId: 'provider-disabled', modelId: 'old-model', updatedAt: 10 },
    candidate: null,
    validity: 'needs_reconfiguration',
    invalidReason: 'provider_disabled',
  };
}

function selection(
  providerName: string,
  modelId: string,
  source: ResolvedModelSelection['source'],
  tier?: ModelTier,
): ResolvedModelSelection {
  const base = {
    providerId: 'main-only-provider-id',
    providerName,
    modelId,
    runtimeType: 'claude-code' as const,
    capabilities: {
      supportsClaudeCode: true,
      supportsAgentWorkflow: true,
      supportsTools: true,
      supportsMCP: true,
      supportsStreaming: true,
      supportsVision: false,
    },
    source,
    executionSource: 'database_provider' as const,
  };
  return tier ? { ...base, tier, tierSource: 'global' as const } : base;
}

function harness() {
  const prepared = { opaque: true } as never;
  const resolutions = [
    validTier('high_quality', 'project', 'Project MiMo', 'mimo-pro'),
    validTier('balanced', 'global', 'Inherited Claude', 'balanced-env'),
    invalidTier('fast'),
  ];
  const tierService = {
    prepareTrustedSnapshot: vi.fn(async () => prepared),
    resolvePreparedBindings: vi.fn(() => resolutions),
  };
  const presetService = {
    getPresetStatus: vi.fn(async () => ({ kind: 'custom' as const })),
  };
  const inspectProjectPolicy = vi.fn(async ({ agentType }: {
    projectId: string;
    agentType: ModelPolicyAgentType;
    fallbackModelId: string | null;
  }, received: ReadonlyMap<ModelTier, ModelTierResolutionPublic>) => {
    expect(received).toBe((inspectProjectPolicy as unknown as { first?: unknown }).first ?? received);
    (inspectProjectPolicy as unknown as { first?: unknown }).first ??= received;
    if (agentType === 'reviewer') {
      return { available: false as const, reason: 'provider_disabled' as const };
    }
    const byRole = {
      planner: selection('Project MiMo', 'mimo-pro', 'project_policy', 'high_quality'),
      coder: selection('Global Claude', 'sonnet', 'global_agent_policy'),
      tester: selection('Project MiMo', 'mimo-fast', 'project_policy', 'fast'),
      fixer: selection('Claude Code', 'default', 'claude_code'),
    } as const;
    return { available: true as const, selection: byRole[agentType as keyof typeof byRole] };
  });
  const service = new ProjectAiConfigurationService({
    projectExists: vi.fn((projectId: string) => projectId === 'project-1'),
    projectFallbackModelId: vi.fn(() => 'project-fallback'),
    tierService,
    presetService,
    selectionInspector: { inspectProjectPolicy },
  });
  return { service, tierService, presetService, inspectProjectPolicy };
}

describe('ProjectAiConfigurationService', () => {
  it('uses one prepared tier snapshot for all five baseline roles and never creates or reads a task override', async () => {
    const test = harness();

    const result = await test.service.getSummary({ projectId: 'project-1' });

    expect(test.tierService.prepareTrustedSnapshot).toHaveBeenCalledOnce();
    expect(test.tierService.prepareTrustedSnapshot).toHaveBeenCalledWith({
      type: 'project', projectId: 'project-1',
    });
    expect(test.tierService.resolvePreparedBindings).toHaveBeenCalledOnce();
    expect(test.inspectProjectPolicy).toHaveBeenCalledTimes(5);
    expect(test.inspectProjectPolicy.mock.calls.map(([request]) => request)).toEqual([
      { projectId: 'project-1', agentType: 'planner', fallbackModelId: 'project-fallback', includesTaskOverride: false },
      { projectId: 'project-1', agentType: 'coder', fallbackModelId: 'project-fallback', includesTaskOverride: false },
      { projectId: 'project-1', agentType: 'tester', fallbackModelId: 'project-fallback', includesTaskOverride: false },
      { projectId: 'project-1', agentType: 'reviewer', fallbackModelId: 'project-fallback', includesTaskOverride: false },
      { projectId: 'project-1', agentType: 'fixer', fallbackModelId: 'project-fallback', includesTaskOverride: false },
    ]);
    expect((result as unknown as { includesTaskOverride?: boolean }).includesTaskOverride).toBe(false);
    expect(result.roles.map(({ role }) => role)).toEqual([
      'planner', 'coder', 'tester', 'reviewer', 'fixer',
    ]);
  });

  it('projects mixed direct and tier outcomes with project/global inheritance and no invalid-role fallback', async () => {
    const test = harness();

    const result = await test.service.getSummary({ projectId: 'project-1' });

    expect(result.presetStatus).toEqual({ kind: 'custom' });
    expect(result.tiers.map(({ tier, source, validity }) => ({ tier, source, validity }))).toEqual([
      { tier: 'high_quality', source: 'project', validity: 'valid' },
      { tier: 'balanced', source: 'global', validity: 'valid' },
      { tier: 'fast', source: 'project', validity: 'needs_reconfiguration' },
    ]);
    expect(result.roles).toEqual([
      { status: 'resolved', role: 'planner', providerName: 'Project MiMo', modelId: 'mimo-pro', runtimeType: 'claude-code', source: 'project_policy', tier: 'high_quality', tierSource: 'global' },
      { status: 'resolved', role: 'coder', providerName: 'Global Claude', modelId: 'sonnet', runtimeType: 'claude-code', source: 'global_agent_policy' },
      { status: 'resolved', role: 'tester', providerName: 'Project MiMo', modelId: 'mimo-fast', runtimeType: 'claude-code', source: 'project_policy', tier: 'fast', tierSource: 'global' },
      { status: 'unavailable', role: 'reviewer', reason: 'provider_disabled' },
      { status: 'resolved', role: 'fixer', providerName: 'Claude Code', modelId: 'default', runtimeType: 'claude-code', source: 'claude_code' },
    ]);
  });

  it('removes main-only identities, URLs, credential material, environments, and raw errors from the public summary', async () => {
    const test = harness();
    const result = await test.service.getSummary({ projectId: 'project-1' });
    const serialized = JSON.stringify({
      ...result,
      ignoredFixtureSentinels: undefined,
    });

    expect(serialized).not.toMatch(/providerId|executionSource|capabilities|credential|vault|environment|baseUrl|https?:|synthetic:/iu);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(PRIVATE_PATH);
  });

  it('fails a missing project with one fixed non-secret error', async () => {
    const test = harness();
    await expect(test.service.getSummary({ projectId: `missing-${SECRET}` }))
      .rejects.toThrow('The selected project was not found.');
    expect(test.tierService.prepareTrustedSnapshot).not.toHaveBeenCalled();
  });

  it('fails a forged task-override inspection closed for only that role', async () => {
    const test = harness();
    const original = test.inspectProjectPolicy.getMockImplementation();
    test.inspectProjectPolicy.mockImplementation(async (request, tiers) => {
      if (request.agentType === 'planner') {
        return {
          available: true,
          selection: selection('Forged task model', 'forged-model', 'task_override'),
        };
      }
      if (!original) throw new Error('missing inspection fixture');
      return original(request, tiers);
    });

    const result = await test.service.getSummary({ projectId: 'project-1' });

    expect((result as unknown as { includesTaskOverride?: boolean }).includesTaskOverride).toBe(false);
    expect(result.roles[0]).toEqual({
      status: 'unavailable',
      role: 'planner',
      reason: 'selection_unavailable',
    });
    expect(result.roles.slice(1).map(({ role }) => role)).toEqual([
      'coder', 'tester', 'reviewer', 'fixer',
    ]);
    expect(JSON.stringify(result)).not.toContain('task_override');
  });

  it.each([
    {
      name: 'a missing tier',
      tiers: [
        validTier('high_quality', 'project', 'Project MiMo', 'mimo-pro'),
        validTier('balanced', 'global', 'Inherited Claude', 'balanced-env'),
      ],
    },
    {
      name: 'a duplicated tier',
      tiers: [
        validTier('high_quality', 'project', 'Project MiMo', 'mimo-pro'),
        validTier('high_quality', 'global', 'Inherited Claude', 'balanced-env'),
        invalidTier('fast'),
      ],
    },
    {
      name: 'non-canonical tier order',
      tiers: [
        validTier('balanced', 'global', 'Inherited Claude', 'balanced-env'),
        validTier('high_quality', 'project', 'Project MiMo', 'mimo-pro'),
        invalidTier('fast'),
      ],
    },
  ])('rejects $name before presenting an authoritative project baseline', async ({ tiers }) => {
    const test = harness();
    test.tierService.resolvePreparedBindings.mockReturnValue(tiers);

    await expect(test.service.getSummary({ projectId: 'project-1' })).rejects.toThrow();
    expect(test.inspectProjectPolicy).not.toHaveBeenCalled();
  });
});
