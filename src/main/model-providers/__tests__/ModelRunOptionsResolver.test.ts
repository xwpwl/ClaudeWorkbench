import { describe, expect, it, vi } from 'vitest';
import type { ClaudeRunOptions } from '../../../shared/types/claude';
import type { ResolvedModelSelection } from '../../../shared/types/modelProviders';
import { ModelRunOptionsResolver } from '../ModelRunOptionsResolver';

function options(overrides: Partial<ClaudeRunOptions> = {}): ClaudeRunOptions {
  return {
    runId: 'run-1', taskId: 'task-1', projectId: 'project-1', projectKey: 'project',
    sessionKey: 'project::task-1', projectPath: 'C:\\project', prompt: 'work',
    model: 'legacy-model', ...overrides,
  };
}

function selection(overrides: Partial<ResolvedModelSelection> = {}): ResolvedModelSelection {
  return Object.freeze({
    providerId: 'provider-mimo', providerName: 'MiMo', modelId: 'mimo-v2.5-pro',
    runtimeType: 'claude-code', source: 'global_default', executionSource: 'database_provider',
    capabilities: Object.freeze({
      supportsClaudeCode: true, supportsAgentWorkflow: true, supportsTools: true,
      supportsMCP: true, supportsStreaming: true, supportsVision: false,
    }),
    ...overrides,
  });
}

const noSessionBindings = { getSessionModelBinding: () => null };

describe('ModelRunOptionsResolver', () => {
  it('starts a fresh chat session when the persisted transcript belongs to another Provider', async () => {
    const resolver = new ModelRunOptionsResolver(
      { resolve: () => selection(), revalidatePinnedSelection: vi.fn() },
      {
        getSessionModelBinding: vi.fn(() => ({
          claudeSessionId: 'claude-session-1',
          providerId: 'provider-anthropic',
          modelId: 'claude-sonnet',
          runtimeType: 'claude-code',
          executionSource: 'database_provider',
        })),
      } as never,
    );

    const result = await resolver.resolve(options({
      resumeSessionId: 'claude-session-1',
      resolvedModelSelection: selection({ providerId: 'renderer-forged' }),
      ...({
        modelSessionBinding: {
          claudeSessionId: 'claude-session-1',
          providerId: 'provider-mimo',
          modelId: 'mimo-v2.5-pro',
          runtimeType: 'claude-code',
        },
      } as Record<string, unknown>),
    }));

    expect(result.resumeSessionId).toBeUndefined();
    expect(result).not.toHaveProperty('modelSessionBinding');
  });

  it('preserves normal chat continuation within the same Provider Runtime', async () => {
    const getSessionModelBinding = vi.fn(() => ({
      claudeSessionId: 'claude-session-1',
      providerId: 'provider-mimo',
      modelId: 'mimo-v2.5-pro',
      runtimeType: 'claude-code' as const,
      executionSource: 'database_provider' as const,
    }));
    const resolver = new ModelRunOptionsResolver(
      { resolve: () => selection(), revalidatePinnedSelection: vi.fn() },
      { getSessionModelBinding } as never,
    );

    const result = await resolver.resolve(options({ resumeSessionId: 'claude-session-1' }));

    expect(result.resumeSessionId).toBe('claude-session-1');
    expect(getSessionModelBinding).toHaveBeenCalledWith('task-1');
  });

  it.each(['environment', 'claude_code'] as const)(
    'starts fresh when a database Provider transcript is reused by %s with adversarial identical IDs',
    async (executionSource) => {
      const sameIdentity = {
        providerId: 'shared-provider-id',
        modelId: 'shared-model-id',
        runtimeType: 'claude-code' as const,
      };
      const resolver = new ModelRunOptionsResolver(
        {
          resolve: () => selection({ ...sameIdentity, executionSource }),
          revalidatePinnedSelection: vi.fn(),
        },
        {
          getSessionModelBinding: () => ({
            claudeSessionId: 'claude-session-1',
            ...sameIdentity,
            executionSource: 'database_provider',
          }),
        },
      );

      const result = await resolver.resolve(options({ resumeSessionId: 'claude-session-1' }));

      expect(result.resumeSessionId).toBeUndefined();
    },
  );

  it.each([
    { bindingPatch: { modelId: 'mimo-v2.5-fast' }, label: 'another model' },
    { bindingPatch: { runtimeType: 'openai-agent' }, label: 'another Runtime' },
  ] as const)('starts fresh when the same Provider transcript belongs to $label', async ({ bindingPatch }) => {
    const resolver = new ModelRunOptionsResolver(
      { resolve: () => selection(), revalidatePinnedSelection: vi.fn() },
      {
        getSessionModelBinding: vi.fn(() => ({
          claudeSessionId: 'claude-session-1', providerId: 'provider-mimo',
          modelId: 'mimo-v2.5-pro', runtimeType: 'claude-code',
          executionSource: 'database_provider', ...bindingPatch,
        })),
      } as never,
    );

    expect((await resolver.resolve(options({ resumeSessionId: 'claude-session-1' }))).resumeSessionId)
      .toBeUndefined();
  });

  it('fails closed to a fresh chat session when a legacy transcript has no trusted binding', async () => {
    const resolver = new ModelRunOptionsResolver(
      { resolve: () => selection(), revalidatePinnedSelection: vi.fn() },
      { getSessionModelBinding: vi.fn(() => null) } as never,
    );

    const result = await resolver.resolve(options({ resumeSessionId: 'legacy-session' }));

    expect(result.resumeSessionId).toBeUndefined();
  });

  it('does not change the legacy Workflow resume contract while new pinned Workflows stay fresh', async () => {
    const getSessionModelBinding = vi.fn(() => null);
    const resolver = new ModelRunOptionsResolver(
      { resolve: () => selection(), revalidatePinnedSelection: vi.fn() },
      { getSessionModelBinding } as never,
    );

    const result = await resolver.resolve(options({
      resumeSessionId: 'legacy-workflow-session',
      workflowContext: { workflowId: 'legacy-workflow', stage: 'planner', reviewRound: 0 },
    }));

    expect(result.resumeSessionId).toBe('legacy-workflow-session');
    expect(getSessionModelBinding).not.toHaveBeenCalled();
  });

  it('revalidates and applies a pinned workflow selection without re-reading policy', async () => {
    const pinned = selection({ providerId: 'provider-pinned', modelId: 'pinned-model' });
    const current = selection({
      providerId: 'provider-pinned', modelId: 'pinned-model', providerName: 'Renamed Provider',
    });
    const resolve = vi.fn(() => selection({ providerId: 'policy-changed' }));
    const revalidatePinnedSelection = vi.fn(() => current);
    const resolver = new ModelRunOptionsResolver(
      { resolve, revalidatePinnedSelection },
      noSessionBindings,
    );

    const result = await resolver.resolvePinned(options({
      workflowContext: { workflowId: 'workflow-1', stage: 'coder', reviewRound: 2 },
    }), pinned);

    expect(revalidatePinnedSelection).toHaveBeenCalledWith(pinned, {
      taskId: 'task-1', projectId: 'project-1', agentType: 'fixer', use: 'agent-workflow',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      model: 'pinned-model',
      modelProviderId: 'provider-pinned',
      resolvedModelSelection: current,
    });
  });

  it('rejects pinned resolution outside a trusted workflow stage', async () => {
    const revalidatePinnedSelection = vi.fn(() => selection());
    const resolver = new ModelRunOptionsResolver({
      resolve: () => selection(),
      revalidatePinnedSelection,
    }, noSessionBindings);
    await expect(resolver.resolvePinned(options(), selection())).rejects.toThrow(/workflow/iu);
    expect(revalidatePinnedSelection).not.toHaveBeenCalled();
  });

  it('re-resolves a normal task as chat and overwrites Renderer provider claims', async () => {
    const resolve = vi.fn(() => selection());
    const resolver = new ModelRunOptionsResolver(
      { resolve, revalidatePinnedSelection: vi.fn() },
      noSessionBindings,
    );
    const result = await resolver.resolve(options({
      modelProviderId: 'renderer-forged',
      resolvedModelSelection: selection({ providerId: 'renderer-forged' }),
    }));
    expect(resolve).toHaveBeenCalledWith({
      taskId: 'task-1', projectId: 'project-1', fallbackModelId: 'legacy-model', use: 'chat',
    });
    expect(result.modelProviderId).toBe('provider-mimo');
    expect(result.model).toBe('mimo-v2.5-pro');
    expect(result.resolvedModelSelection).toEqual(selection());
  });

  it.each([
    ['planner', 0, 'planner'],
    ['coder', 1, 'coder'],
    ['coder', 2, 'fixer'],
    ['tester', 2, 'tester'],
    ['reviewer', 2, 'reviewer'],
  ] as const)('maps workflow stage %s round %i to policy role %s', async (stage, reviewRound, agentType) => {
    const resolve = vi.fn(() => selection());
    const resolver = new ModelRunOptionsResolver(
      { resolve, revalidatePinnedSelection: vi.fn() },
      noSessionBindings,
    );
    await resolver.resolve(options({
      workflowContext: { workflowId: 'workflow-1', stage, reviewRound },
    }));
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', projectId: 'project-1', agentType, use: 'agent-workflow',
    }));
  });

  it('omits --model intent for the Claude Code default sentinel', async () => {
    const resolver = new ModelRunOptionsResolver({
      resolve: () => selection({
        providerId: 'claude-code:default', providerName: 'Claude Code',
        modelId: 'default', source: 'claude_code', executionSource: 'claude_code',
      }),
      revalidatePinnedSelection: vi.fn(),
    }, noSessionBindings);
    const result = await resolver.resolve(options({ model: undefined }));
    expect(result.model).toBeUndefined();
    expect(result.modelProviderId).toBe('claude-code:default');
  });

  it('dispatches Claude default-model behavior by trusted executionSource, not policy source or ID', async () => {
    const resolver = new ModelRunOptionsResolver({
      resolve: () => selection({
        providerId: `synthetic:v1:claude_code:${'c'.repeat(64)}`,
        providerName: 'Claude Code', modelId: 'default',
        source: 'project_policy', executionSource: 'claude_code',
        tier: 'fast', tierSource: 'project',
      }),
      revalidatePinnedSelection: vi.fn(),
    }, noSessionBindings);

    const result = await resolver.resolve(options());

    expect(result.model).toBeUndefined();
    expect(result.modelProviderId).toMatch(/^synthetic:v1:claude_code:/u);
    expect(result.resolvedModelSelection).toMatchObject({
      source: 'project_policy', executionSource: 'claude_code',
      tier: 'fast', tierSource: 'project',
    });
  });

  it('requires trusted task and project identity before policy resolution', async () => {
    const resolve = vi.fn(() => selection());
    const resolver = new ModelRunOptionsResolver(
      { resolve, revalidatePinnedSelection: vi.fn() },
      noSessionBindings,
    );
    await expect(resolver.resolve(options({ taskId: undefined }))).rejects.toThrow(/task/iu);
    await expect(resolver.resolve(options({ projectId: undefined }))).rejects.toThrow(/project/iu);
    expect(resolve).not.toHaveBeenCalled();
  });
});
