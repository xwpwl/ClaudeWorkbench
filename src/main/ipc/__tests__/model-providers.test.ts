import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelProviderPage,
  ProviderConnectionResult,
  ProviderDraftInput,
  ProviderModel,
  ProviderValidationResult,
  PublicModelProvider,
} from '../../../shared/types/modelProviders';
import type {
  AgentPresetPreview,
  ModelTierCandidatePublic,
  ModelTierResolutionPublic,
} from '../../../shared/types/modelTiers';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { AgentPresetServiceError } from '../../model-providers/AgentPresetService';
import { ModelProviderServiceError } from '../../model-providers/ModelProviderService';
import {
  ModelSelectionFailure,
  ModelSwitchError,
} from '../../model-providers/ModelSelectionResolver';
import { ModelTierServiceError } from '../../model-providers/ModelTierService';
import {
  registerModelProviderIPC,
  type AgentPresetServicePort,
  type ModelProviderServicePort,
  type ModelTierServicePort,
} from '../model-providers';
import { publicIpcMainForTest } from './public-invoke-test-helper';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const PROVIDER_ID = 'provider-mimo';
const RENDERER_URL = 'file:///C:/ClaudeWorkbench/dist/renderer/index.html';
const SENTINEL = 'provider-secret-sentinel';
const PATH_SENTINEL = 'private-gateway-path-token-sentinel';
const BIND_ALL_CHANNEL = 'model-tier:bind-all';
const PROJECT_AI_SUMMARY_CHANNEL = 'project-ai:get-configuration-summary';
const TASK_SWITCH_OPTIONS_CHANNEL = 'model-selection:list-task-switch-options';

function tierCandidate(): ModelTierCandidatePublic {
  return {
    providerId: PROVIDER_ID,
    providerName: 'MiMo',
    modelId: 'mimo-v2.5-pro',
    modelDisplayName: 'MiMo v2.5 Pro',
    runtimeType: 'claude-code',
    executionSource: 'database_provider',
    health: { state: 'connected', lastTestedAt: 1_700_000_000_000 },
  };
}

function tierResolution(tier: 'high_quality' | 'balanced' | 'fast'): ModelTierResolutionPublic {
  return {
    scope: { type: 'global' },
    tier,
    display: { tier, displayName: null, quality: null, speed: null, cost: null },
    source: 'global',
    binding: {
      tier,
      providerId: PROVIDER_ID,
      modelId: 'mimo-v2.5-pro',
      updatedAt: 1_700_000_000_300,
    },
    candidate: tierCandidate(),
    validity: 'valid',
    invalidReason: null,
  };
}

function presetPreview(): AgentPresetPreview {
  const roles = Object.fromEntries(
    ['planner', 'coder', 'tester', 'reviewer', 'fixer'].map((role) => [role, {
      role,
      tier: role === 'planner' || role === 'reviewer' ? 'high_quality' : 'balanced',
      resolution: tierResolution(
        role === 'planner' || role === 'reviewer' ? 'high_quality' : 'balanced',
      ),
    }]),
  ) as AgentPresetPreview['roles'];
  return {
    scope: { type: 'global' },
    presetId: 'software_development',
    revision: `agent-preset:v1:${'a'.repeat(64)}`,
    roles,
  };
}

function provider(overrides: Partial<PublicModelProvider> = {}): PublicModelProvider {
  return {
    id: PROVIDER_ID,
    name: 'MiMo',
    type: 'anthropic-compatible',
    apiFormat: 'anthropic-messages',
    runtimeType: 'claude-code',
    baseUrl: 'https://example.invalid',
    baseUrlPathRedacted: false,
    enabled: true,
    isDefault: false,
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
      lastTestedAt: 1_700_000_000_000,
      lastErrorType: null,
      latencyMs: 81,
    },
    defaultModelId: 'mimo-v2.5-pro',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    ...overrides,
  };
}

function model(): ProviderModel {
  return {
    providerId: PROVIDER_ID,
    modelId: 'mimo-v2.5-pro',
    displayName: 'MiMo v2.5 Pro',
    source: 'discovered',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
  };
}

function success(): ProviderConnectionResult {
  return {
    ok: true,
    testedAt: 1_700_000_000_200,
    latencyMs: 81,
    discoveredModelIds: ['mimo-v2.5-pro'],
  };
}

function draft(overrides: Partial<ProviderDraftInput> = {}): ProviderDraftInput {
  return {
    name: 'MiMo',
    type: 'anthropic-compatible',
    apiFormat: 'anthropic-messages',
    baseUrlIntent: { mode: 'replace', value: 'https://example.invalid' },
    credential: SENTINEL,
    defaultModelId: 'mimo-v2.5-pro',
    ...overrides,
  };
}

function projectAiSummaryFixture() {
  const tiers = (['high_quality', 'balanced', 'fast'] as const).map((tier, index) => ({
    tier,
    display: {
      tier,
      displayName: null,
      quality: index === 0 ? 'high' as const : null,
      speed: null,
      cost: null,
    },
    source: index === 0 ? 'project' as const : index === 1 ? 'global' as const : 'none' as const,
    validity: index === 2 ? 'unbound' as const : 'valid' as const,
    invalidReason: index === 2 ? 'tier_unbound' as const : null,
    candidate: index === 2 ? null : {
      providerName: index === 0 ? 'MiMo' : 'Claude',
      modelId: index === 0 ? 'mimo-v2.5-pro' : 'claude-sonnet',
      modelDisplayName: null,
      runtimeType: 'claude-code' as const,
      health: { state: 'connected' as const, lastTestedAt: 100 },
      ...(index === 0 ? {
        providerId: `synthetic:v1:${SENTINEL}`,
        baseUrl: `https://example.invalid/${PATH_SENTINEL}`,
      } : {}),
    },
  }));
  return {
    includesTaskOverride: false,
    presetStatus: { kind: 'custom' as const },
    tiers,
    roles: [{
      status: 'resolved' as const,
      role: 'planner' as const,
      providerName: 'MiMo',
      modelId: 'mimo-v2.5-pro',
      runtimeType: 'claude-code' as const,
      source: 'project_policy' as const,
      providerId: SENTINEL,
      capabilities: provider().capabilities,
      executionSource: 'environment',
    }, {
      status: 'resolved' as const,
      role: 'coder' as const,
      providerName: 'Claude',
      modelId: 'claude-sonnet',
      runtimeType: 'claude-code' as const,
      source: 'global_agent_policy' as const,
    }, {
      status: 'unavailable' as const,
      role: 'tester' as const,
      reason: 'provider_disabled' as const,
      rawError: SENTINEL,
    }, {
      status: 'resolved' as const,
      role: 'reviewer' as const,
      providerName: 'MiMo',
      modelId: 'mimo-v2.5-pro',
      runtimeType: 'claude-code' as const,
      source: 'project_policy' as const,
    }, {
      status: 'unavailable' as const,
      role: 'fixer' as const,
      reason: 'workflow_capability_missing' as const,
    }],
    credentialRef: SENTINEL,
    vaultPath: PATH_SENTINEL,
  };
}

function harness(options: { publicTransport?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  } as unknown as IpcMain;

  const mainFrame = { url: RENDERER_URL };
  const trustedWebContents = {
    id: 42,
    mainFrame,
    getURL: vi.fn(() => RENDERER_URL),
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as WebContents;

  const page: ModelProviderPage = {
    items: [provider()],
    total: 1,
    limit: 25,
    offset: 0,
  };
  const validation: ProviderValidationResult = {
    validationToken: 'validation-token',
    connection: success(),
  };
  const service: ModelProviderServicePort = {
    listProviders: vi.fn(() => page),
    getProvider: vi.fn(() => provider()),
    listModels: vi.fn(() => [model()]),
    validateDraft: vi.fn(async () => validation),
    createProvider: vi.fn(async () => provider()),
    updateProvider: vi.fn(async () => provider()),
    testConnection: vi.fn(async () => success()),
    setDefaultProvider: vi.fn(() => provider({ isDefault: true })),
    setProviderEnabled: vi.fn((input) => provider({
      enabled: input.enabled,
      isDefault: input.enabled ? false : false,
    })),
    deleteProvider: vi.fn(async () => undefined),
  };
  const policyService = {
    listAgentPolicyReferences: vi.fn(() => [{
      scope: { type: 'global' as const },
      agentType: 'planner' as const,
      reference: { kind: 'tier' as const, tier: 'high_quality' as const },
      providerName: null,
      notes: { quality: 'high' as const, speed: null, cost: null },
      createdAt: 10,
      updatedAt: 20,
    }]),
    listAgentPolicies: vi.fn(() => [{
      agentType: 'planner',
      providerId: PROVIDER_ID,
      modelId: 'mimo-v2.5-pro',
      quality: 'high',
      speed: 'medium',
      cost: 'low',
      createdAt: 10,
      updatedAt: 20,
    }]),
    setAgentPolicy: vi.fn((input: Record<string, unknown>) => ({
      ...input,
      createdAt: 10,
      updatedAt: 20,
    })),
    deleteAgentPolicy: vi.fn(() => true),
    listProjectPolicies: vi.fn(() => [{
      projectId: 'project-1',
      agentType: 'default',
      providerId: PROVIDER_ID,
      modelId: 'mimo-v2.5-pro',
      createdAt: 30,
      updatedAt: 40,
    }]),
    setProjectPolicy: vi.fn((input: Record<string, unknown>) => ({
      ...input,
      createdAt: 30,
      updatedAt: 40,
    })),
    deleteProjectPolicy: vi.fn(() => true),
  };
  const resolvedSelection = {
    providerId: PROVIDER_ID,
    providerName: 'MiMo',
    modelId: 'mimo-v2.5-pro',
    runtimeType: 'claude-code',
    capabilities: provider().capabilities,
    source: 'task_override',
  } as const;
  const selectionService = {
    resolve: vi.fn(() => resolvedSelection),
    setTaskOverride: vi.fn(() => ({
      providerId: PROVIDER_ID,
      modelId: 'mimo-v2.5-pro',
      warning: '模型改变只影响后续 Agent 调用。',
    })),
    clearTaskOverride: vi.fn(() => ({ warning: '模型改变只影响后续 Agent 调用。' })),
    listTaskModelSwitchOptions: vi.fn(() => [{
      providerId: PROVIDER_ID,
      providerName: 'MiMo',
      modelId: 'mimo-v2.5-pro',
      modelDisplayName: 'MiMo Pro',
      runtimeType: 'claude-code' as const,
      credentialRef: SENTINEL,
      baseUrl: `https://example.invalid/${PATH_SENTINEL}`,
      capabilities: provider().capabilities,
    }]),
  };
  const tierService: ModelTierServicePort = {
    listCandidates: vi.fn(async () => [tierCandidate()]),
    getBindings: vi.fn(async () => [
      tierResolution('high_quality'),
      tierResolution('balanced'),
      tierResolution('fast'),
    ]),
    setBinding: vi.fn(async (input) => tierResolution(input.tier)),
    bindAllTiers: vi.fn(async () => [
      tierResolution('high_quality'),
      tierResolution('balanced'),
      tierResolution('fast'),
    ]),
    updateDisplayMetadata: vi.fn(async (input) => tierResolution(input.metadata.tier)),
    clearProjectBinding: vi.fn(async () => true),
  };
  const preview = presetPreview();
  const presetService: AgentPresetServicePort = {
    preparePreset: vi.fn(async () => ({ step: 'preview', preview })),
    previewPreset: vi.fn(async () => preview),
    applyPreset: vi.fn(async () => ({
      presetId: 'software_development',
      appliedAt: 1_700_000_000_300,
    })),
    getPresetStatus: vi.fn(async () => ({
      kind: 'preset',
      presetId: 'software_development',
    })),
  };
  const getTaskContext = vi.fn(() => ({
    projectId: 'project-1',
    status: 'idle',
    fallbackModelId: 'fallback-model',
  }));
  const isTaskActive = vi.fn(() => false);
  const projectAiConfigurationService = {
    getSummary: vi.fn(async () => projectAiSummaryFixture() as never),
  };

  const cleanup = registerModelProviderIPC(
    options.publicTransport ? publicIpcMainForTest(ipcMain) : ipcMain,
    {
    service,
    policyService,
    selectionService,
    tierService,
    presetService,
    projectAiConfigurationService,
    getTaskContext,
    isTaskActive,
    getTrustedWebContents: () => trustedWebContents,
    getTrustedFrameUrl: () => RENDERER_URL,
    now: () => 1_700_000_000_300,
    },
  );

  const event = {
    sender: trustedWebContents,
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;

  const invoke = async <T>(
    channel: string,
    args: unknown[] = [],
    invokeEvent: IpcMainInvokeEvent = event,
  ): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
    return await handler(invokeEvent, ...args) as T;
  };

  return {
    cleanup,
    event,
    handlers,
    invoke,
    ipcMain,
    mainFrame,
    page,
    policyService,
    resolvedSelection,
    selectionService,
    tierService,
    presetService,
    projectAiConfigurationService,
    service,
    getTaskContext,
    isTaskActive,
    trustedWebContents,
    validation,
  };
}

const INVOKE_CHANNELS = [
  IPC_CHANNELS.MODEL_PROVIDER_LIST,
  IPC_CHANNELS.MODEL_PROVIDER_GET,
  IPC_CHANNELS.MODEL_PROVIDER_LIST_MODELS,
  IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT,
  IPC_CHANNELS.MODEL_PROVIDER_CREATE,
  IPC_CHANNELS.MODEL_PROVIDER_UPDATE,
  IPC_CHANNELS.MODEL_PROVIDER_TEST_CONNECTION,
  IPC_CHANNELS.MODEL_PROVIDER_SET_DEFAULT,
  IPC_CHANNELS.MODEL_PROVIDER_SET_ENABLED,
  IPC_CHANNELS.MODEL_PROVIDER_DELETE,
  IPC_CHANNELS.MODEL_POLICY_LIST_AGENT,
  'model-policy:list-agent-references',
  IPC_CHANNELS.MODEL_POLICY_SET_AGENT,
  IPC_CHANNELS.MODEL_POLICY_DELETE_AGENT,
  IPC_CHANNELS.MODEL_POLICY_LIST_PROJECT,
  IPC_CHANNELS.MODEL_POLICY_SET_PROJECT,
  IPC_CHANNELS.MODEL_POLICY_DELETE_PROJECT,
  IPC_CHANNELS.MODEL_TIER_LIST_CANDIDATES,
  IPC_CHANNELS.MODEL_TIER_LIST_BINDINGS,
  IPC_CHANNELS.MODEL_TIER_SET_BINDING,
  BIND_ALL_CHANNEL,
  IPC_CHANNELS.MODEL_TIER_UPDATE_DISPLAY_METADATA,
  IPC_CHANNELS.MODEL_TIER_CLEAR_PROJECT_BINDING,
  IPC_CHANNELS.AGENT_PRESET_PREPARE,
  IPC_CHANNELS.AGENT_PRESET_PREVIEW,
  IPC_CHANNELS.AGENT_PRESET_APPLY,
  IPC_CHANNELS.AGENT_PRESET_GET_STATUS,
  PROJECT_AI_SUMMARY_CHANNEL,
  IPC_CHANNELS.MODEL_SELECTION_GET_EFFECTIVE,
  TASK_SWITCH_OPTIONS_CHANNEL,
  IPC_CHANNELS.MODEL_SELECTION_SET_TASK_OVERRIDE,
  IPC_CHANNELS.MODEL_SELECTION_CLEAR_TASK_OVERRIDE,
] as const;

describe('model provider IPC registration and trust boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns closed envelopes for an active switch and disabled preset without writes', async () => {
    const test = harness({ publicTransport: true });
    test.isTaskActive.mockReturnValue(true);
    const switchResult = await test.invoke(IPC_CHANNELS.MODEL_SELECTION_SET_TASK_OVERRIDE, [{
      taskId: 'task-1', providerId: PROVIDER_ID, modelId: 'mimo-v2.5-pro',
    }]).catch(() => ({ transportRejected: true }));
    expect(switchResult).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: 'TASK_ACTIVE', message: '正在运行任务时禁止切换模型。' },
    });
    expect(test.selectionService.setTaskOverride).not.toHaveBeenCalled();

    test.presetService.applyPreset.mockRejectedValueOnce(new AgentPresetServiceError(
      'PRESET_ROLE_UNAVAILABLE',
      'private C:\\Users\\Profile role is unavailable.',
    ));
    const presetResult = await test.invoke(IPC_CHANNELS.AGENT_PRESET_APPLY, [{
      scope: { type: 'global' },
      presetId: 'software_development',
      expectedRevision: `agent-preset:v1:${'a'.repeat(64)}`,
      previewConfirmed: true,
      overwriteConfirmed: true,
    }]).catch(() => ({ transportRejected: true }));
    expect(presetResult).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'PRESET_ROLE_UNAVAILABLE',
        message: 'One or more Agent roles need a valid model tier binding.',
      },
    });
    expect(JSON.stringify(presetResult)).not.toContain('Users');
  });

  it('preserves a typed selection capability failure through the public transport', async () => {
    const test = harness({ publicTransport: true });
    test.selectionService.resolve.mockRejectedValue(new ModelSelectionFailure(
      'WORKFLOW_CAPABILITY_MISSING',
      `C:\\Users\\PrivateProfile\\${SENTINEL}`,
    ));

    const result = await test.invoke(IPC_CHANNELS.MODEL_SELECTION_GET_EFFECTIVE, [{
      taskId: 'task-1',
    }]);
    expect(result).toStrictEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'WORKFLOW_CAPABILITY_MISSING',
        message: 'The selected model does not support the required workflow capability.',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/PrivateProfile|provider-secret-sentinel/iu);
    expect(test.selectionService.setTaskOverride).not.toHaveBeenCalled();
    expect(test.selectionService.clearTaskOverride).not.toHaveBeenCalled();
  });

  it('returns the stable management-only error when set-default rejects a Provider runtime', async () => {
    const test = harness({ publicTransport: true });
    test.service.setDefaultProvider.mockImplementation(() => {
      throw new ModelProviderServiceError(
        'PROVIDER_RUNTIME_NOT_RUNNABLE',
        `private ${SENTINEL} credential_ref`,
      );
    });

    const result = await test.invoke(IPC_CHANNELS.MODEL_PROVIDER_SET_DEFAULT, [PROVIDER_ID]);
    expect(result).toStrictEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'PROVIDER_RUNTIME_NOT_RUNNABLE',
        message: '当前 Provider 可以管理和测试，但尚不能用于 Claude Code Agent。请选择支持 Claude Code Runtime 的 Provider。',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/credential_ref|provider-secret-sentinel/iu);
  });

  it('does not promote forged provider codes or fixed messages through local projectors', async () => {
    const forgedCode = harness({ publicTransport: true });
    const codedError = new Error(`C:\\Users\\PrivateProfile\\${SENTINEL}`) as Error & {
      code?: string;
    };
    codedError.code = 'PROVIDER_DISABLED';
    forgedCode.service.listProviders.mockRejectedValue(codedError);

    const forgedMessage = harness({ publicTransport: true });
    forgedMessage.service.listProviders.mockRejectedValue(
      new Error('正在运行任务时禁止切换模型。'),
    );

    const forgedPreset = harness({ publicTransport: true });
    const presetError = new Error(`C:\\Users\\PrivateProfile\\${SENTINEL}`) as Error & {
      code?: string;
    };
    presetError.code = 'PRESET_ROLE_UNAVAILABLE';
    forgedPreset.presetService.applyPreset.mockRejectedValueOnce(presetError);

    const [codedResult, messageResult, presetResult] = await Promise.all([
      forgedCode.invoke(IPC_CHANNELS.MODEL_PROVIDER_LIST, [{}]),
      forgedMessage.invoke(IPC_CHANNELS.MODEL_PROVIDER_LIST, [{}]),
      forgedPreset.invoke(IPC_CHANNELS.AGENT_PRESET_APPLY, [{
        scope: { type: 'global' },
        presetId: 'software_development',
        expectedRevision: `agent-preset:v1:${'a'.repeat(64)}`,
        previewConfirmed: true,
        overwriteConfirmed: true,
      }]),
    ]);
    for (const result of [codedResult, messageResult, presetResult]) {
      expect(result).toStrictEqual({
        schemaVersion: 1,
        ok: false,
        error: {
          code: 'MODEL_PROVIDER_OPERATION_FAILED',
          message: 'Model Provider operation failed.',
        },
      });
    }
    expect(JSON.stringify([codedResult, messageResult, presetResult]))
      .not.toMatch(/PrivateProfile|provider-secret-sentinel/iu);
    expect(forgedPreset.trustedWebContents.send).not.toHaveBeenCalled();
  });

  it('registers only the named invoke channels and removes them on disposal', () => {
    const test = harness();

    expect([...test.handlers.keys()]).toEqual(INVOKE_CHANNELS);
    expect(test.handlers.has(IPC_CHANNELS.MODEL_PROVIDER_CHANGED)).toBe(false);

    test.cleanup();

    expect(test.ipcMain.removeHandler).toHaveBeenCalledTimes(INVOKE_CHANNELS.length);
    expect(test.handlers.size).toBe(0);
  });

  it('rejects a foreign WebContents before calling the service', async () => {
    const test = harness();
    const foreign = {
      sender: { ...test.trustedWebContents, id: 99 },
      senderFrame: test.mainFrame,
    } as unknown as IpcMainInvokeEvent;

    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_LIST, [{}], foreign))
      .rejects.toThrow(/trusted main frame/i);
    expect(test.service.listProviders).not.toHaveBeenCalled();
  });

  it('rejects an untrusted frame on the tier candidate channel before service dispatch', async () => {
    const test = harness();
    const foreign = {
      sender: { ...test.trustedWebContents, id: 99 },
      senderFrame: test.mainFrame,
    } as unknown as IpcMainInvokeEvent;

    await expect(test.invoke(
      IPC_CHANNELS.MODEL_TIER_LIST_CANDIDATES,
      [{ scope: { type: 'global' } }],
      foreign,
    )).rejects.toThrow(/trusted main frame/i);
    expect(test.tierService.listCandidates).not.toHaveBeenCalled();
  });

  it('rejects a subframe even when it belongs to the trusted WebContents', async () => {
    const test = harness();
    const iframe = {
      sender: test.trustedWebContents,
      senderFrame: { url: RENDERER_URL },
    } as unknown as IpcMainInvokeEvent;

    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_GET, [PROVIDER_ID], iframe))
      .rejects.toThrow(/trusted main frame/i);
    expect(test.service.getProvider).not.toHaveBeenCalled();
  });

  it('rejects a main frame whose current URL does not match the trusted page', async () => {
    const test = harness();
    vi.mocked(test.trustedWebContents.getURL).mockReturnValue('file:///unexpected.html');

    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_GET, [PROVIDER_ID]))
      .rejects.toThrow(/trusted main frame/i);
    expect(test.service.getProvider).not.toHaveBeenCalled();
  });

  it('rejects a top-level navigation even when WebContents and frame now agree', async () => {
    const test = harness();
    test.mainFrame.url = 'file:///attacker-controlled.html';
    vi.mocked(test.trustedWebContents.getURL).mockReturnValue('file:///attacker-controlled.html');

    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_GET, [PROVIDER_ID]))
      .rejects.toThrow(/trusted main frame/i);
    expect(test.service.getProvider).not.toHaveBeenCalled();
  });
});

describe('project AI summary and trusted task switch option IPC', () => {
  it('rejects extra project-summary keys before calling the main service', async () => {
    const test = harness();

    await expect(test.invoke(PROJECT_AI_SUMMARY_CHANNEL, [{
      projectId: 'project-1',
      taskId: 'dummy-task-must-not-be-accepted',
    }])).rejects.toThrow('Invalid model configuration request.');
    expect(test.projectAiConfigurationService.getSummary).not.toHaveBeenCalled();
  });

  it('projects the project summary field by field and removes main-only identities', async () => {
    const test = harness();

    const result = await test.invoke<Record<string, unknown>>(
      PROJECT_AI_SUMMARY_CHANNEL,
      [{ projectId: 'project-1' }],
    );

    expect(test.projectAiConfigurationService.getSummary).toHaveBeenCalledWith({
      projectId: 'project-1',
    });
    expect(result).toMatchObject({
      includesTaskOverride: false,
      presetStatus: { kind: 'custom' },
    });
    expect((result.tiers as Array<{ tier: string }>).map(({ tier }) => tier)).toEqual([
      'high_quality', 'balanced', 'fast',
    ]);
    expect((result.roles as Array<{ role: string }>).map(({ role }) => role)).toEqual([
      'planner', 'coder', 'tester', 'reviewer', 'fixer',
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /providerId|synthetic:|credential|vault|baseUrl|https?:|executionSource|capabilities|rawError|private-gateway-path-token-sentinel/iu,
    );
  });

  it('maps raw project-summary failures to one fixed public message', async () => {
    const test = harness();
    test.projectAiConfigurationService.getSummary.mockRejectedValue(
      new Error(`database ${SENTINEL} ${PATH_SENTINEL}`),
    );

    await expect(test.invoke(PROJECT_AI_SUMMARY_CHANNEL, [{ projectId: 'project-1' }]))
      .rejects.toThrow('Project AI configuration could not be read.');
  });

  it.each([
    {
      name: 'missing tiers',
      mutate: (summary: ReturnType<typeof projectAiSummaryFixture>) => ({
        ...summary, tiers: summary.tiers.slice(0, 2),
      }),
    },
    {
      name: 'duplicate tiers',
      mutate: (summary: ReturnType<typeof projectAiSummaryFixture>) => ({
        ...summary, tiers: [summary.tiers[0], summary.tiers[0], summary.tiers[2]],
      }),
    },
    {
      name: 'reordered tiers',
      mutate: (summary: ReturnType<typeof projectAiSummaryFixture>) => ({
        ...summary, tiers: [summary.tiers[1], summary.tiers[0], summary.tiers[2]],
      }),
    },
    {
      name: 'missing roles',
      mutate: (summary: ReturnType<typeof projectAiSummaryFixture>) => ({
        ...summary, roles: summary.roles.slice(0, 4),
      }),
    },
    {
      name: 'duplicate roles',
      mutate: (summary: ReturnType<typeof projectAiSummaryFixture>) => ({
        ...summary,
        roles: [
          summary.roles[0], summary.roles[0], summary.roles[2],
          summary.roles[3], summary.roles[4],
        ],
      }),
    },
    {
      name: 'reordered roles',
      mutate: (summary: ReturnType<typeof projectAiSummaryFixture>) => ({
        ...summary,
        roles: [
          summary.roles[1], summary.roles[0], summary.roles[2],
          summary.roles[3], summary.roles[4],
        ],
      }),
    },
  ])('rejects a project baseline with $name', async ({ mutate }) => {
    const test = harness();
    test.projectAiConfigurationService.getSummary.mockResolvedValue(
      mutate(projectAiSummaryFixture()) as never,
    );

    await expect(test.invoke(PROJECT_AI_SUMMARY_CHANNEL, [{ projectId: 'project-1' }]))
      .rejects.toThrow('Project AI configuration could not be read.');
  });

  it.each([
    {
      name: 'a true task-override inclusion flag',
      mutate: (summary: ReturnType<typeof projectAiSummaryFixture>) => ({
        ...summary, includesTaskOverride: true,
      }),
    },
    {
      name: 'a task_override role source',
      mutate: (summary: ReturnType<typeof projectAiSummaryFixture>) => ({
        ...summary,
        roles: [
          { ...summary.roles[0], source: 'task_override' },
          ...summary.roles.slice(1),
        ],
      }),
    },
  ])('rejects a project baseline containing $name', async ({ mutate }) => {
    const test = harness();
    test.projectAiConfigurationService.getSummary.mockResolvedValue(
      mutate(projectAiSummaryFixture()) as never,
    );

    await expect(test.invoke(PROJECT_AI_SUMMARY_CHANNEL, [{ projectId: 'project-1' }]))
      .rejects.toThrow('Project AI configuration could not be read.');
  });

  it('verifies task context and projects trusted switch options without provider internals', async () => {
    const test = harness();

    const result = await test.invoke<Array<Record<string, unknown>>>(
      TASK_SWITCH_OPTIONS_CHANNEL,
      [{ taskId: 'task-1' }],
    );

    expect(test.getTaskContext).toHaveBeenCalledWith('task-1');
    expect(test.selectionService.listTaskModelSwitchOptions).toHaveBeenCalledOnce();
    expect(result).toEqual([{
      providerId: PROVIDER_ID,
      providerName: 'MiMo',
      modelId: 'mimo-v2.5-pro',
      modelDisplayName: 'MiMo Pro',
      runtimeType: 'claude-code',
      purpose: 'task_agent_override',
      source: 'configured_provider',
    }]);
    expect(JSON.stringify(result)).not.toMatch(/credential|baseUrl|capabilities|private-gateway/iu);
  });

  it('rejects extra switch-option keys and a missing task before listing options', async () => {
    const test = harness();
    await expect(test.invoke(TASK_SWITCH_OPTIONS_CHANNEL, [{
      taskId: 'task-1',
      providerId: PROVIDER_ID,
    }])).rejects.toThrow('Model Provider operation failed.');
    expect(test.selectionService.listTaskModelSwitchOptions).not.toHaveBeenCalled();

    test.getTaskContext.mockReturnValueOnce(null as never);
    await expect(test.invoke(TASK_SWITCH_OPTIONS_CHANNEL, [{ taskId: 'missing' }]))
      .rejects.toThrow('Task was not found.');
    expect(test.selectionService.listTaskModelSwitchOptions).not.toHaveBeenCalled();
  });
});

describe('model tier and preset IPC', () => {
  it('delegates only closed tier intent and projects safe candidate and binding fields', async () => {
    const test = harness();
    vi.mocked(test.tierService.listCandidates).mockResolvedValue([{
      ...tierCandidate(),
      credential_ref: SENTINEL,
      apiKey: SENTINEL,
      baseUrl: `https://${SENTINEL}@example.invalid`,
    } as never]);
    vi.mocked(test.tierService.setBinding).mockResolvedValue({
      ...tierResolution('balanced'),
      vaultPath: `C:/vault/${SENTINEL}`,
    } as never);

    const candidates = await test.invoke<Record<string, unknown>[]>(
      IPC_CHANNELS.MODEL_TIER_LIST_CANDIDATES,
      [{ scope: { type: 'global' } }],
    );
    const binding = await test.invoke<Record<string, unknown>>(
      IPC_CHANNELS.MODEL_TIER_SET_BINDING,
      [{
        scope: { type: 'global' },
        tier: 'balanced',
        providerId: PROVIDER_ID,
        modelId: 'mimo-v2.5-pro',
      }],
    );

    expect(test.tierService.listCandidates).toHaveBeenCalledWith({ type: 'global' });
    expect(test.tierService.setBinding).toHaveBeenCalledWith({
      scope: { type: 'global' },
      tier: 'balanced',
      providerId: PROVIDER_ID,
      modelId: 'mimo-v2.5-pro',
    });
    expect(JSON.stringify({ candidates, binding })).not.toMatch(
      /credential_ref|api.?key|baseUrl|vault|provider-secret-sentinel/iu,
    );
    expect(test.trustedWebContents.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_CHANGED,
      { type: 'tier_changed', providerId: null, changedAt: 1_700_000_000_300 },
    );
  });

  it('binds all tiers with one service call and never accepts renderer-derived trust facts', async () => {
    const test = harness();
    const input = {
      scope: { type: 'project', projectId: 'project-1' as const },
      providerId: PROVIDER_ID,
      modelId: 'mimo-v2.5-pro',
    } as const;

    await test.invoke(BIND_ALL_CHANNEL, [input]);

    expect(test.tierService.bindAllTiers).toHaveBeenCalledTimes(1);
    expect(test.tierService.bindAllTiers).toHaveBeenCalledWith(input);
    expect(test.tierService.setBinding).not.toHaveBeenCalled();
    await expect(test.invoke(BIND_ALL_CHANNEL, [{
      ...input,
      capabilities: { supportsAgentWorkflow: true },
    }])).rejects.toThrow();
  });

  it('supports scoped bindings, display notes, and Follow global with strict bounded input', async () => {
    const test = harness();
    await test.invoke(IPC_CHANNELS.MODEL_TIER_LIST_BINDINGS, [{
      scope: { type: 'project', projectId: 'project-1' },
    }]);
    await test.invoke(IPC_CHANNELS.MODEL_TIER_UPDATE_DISPLAY_METADATA, [{
      scope: { type: 'global' },
      metadata: {
        tier: 'fast',
        displayName: 'Fast lane',
        quality: 'medium',
        speed: 'high',
        cost: 'low',
      },
    }]);
    await test.invoke(IPC_CHANNELS.MODEL_TIER_CLEAR_PROJECT_BINDING, [{
      projectId: 'project-1',
      tier: 'fast',
    }]);

    expect(test.tierService.getBindings).toHaveBeenCalledWith({
      type: 'project', projectId: 'project-1',
    });
    expect(test.tierService.clearProjectBinding).toHaveBeenCalledWith('project-1', 'fast');
    await expect(test.invoke(IPC_CHANNELS.MODEL_TIER_LIST_BINDINGS, [{
      scope: { type: 'global', projectId: 'forged-project' },
    }])).rejects.toThrow();
    await expect(test.invoke(IPC_CHANNELS.MODEL_TIER_CLEAR_PROJECT_BINDING, [{
      projectId: `project-${'x'.repeat(129)}`,
      tier: 'fast',
    }])).rejects.toThrow();
    await expect(test.invoke(IPC_CHANNELS.MODEL_TIER_CLEAR_PROJECT_BINDING, [{
      projectId: 'project-1\nforged',
      tier: 'fast',
    }])).rejects.toThrow();
  });

  it('forwards preset prepare, preview, status, and both apply confirmations only', async () => {
    const test = harness();
    const scope = { type: 'global' as const };
    const base = { scope, presetId: 'software_development' as const };

    await test.invoke(IPC_CHANNELS.AGENT_PRESET_PREPARE, [base]);
    await test.invoke(IPC_CHANNELS.AGENT_PRESET_PREVIEW, [base]);
    await test.invoke(IPC_CHANNELS.AGENT_PRESET_GET_STATUS, [{ scope }]);
    await test.invoke(IPC_CHANNELS.AGENT_PRESET_APPLY, [{
      ...base,
      expectedRevision: `agent-preset:v1:${'a'.repeat(64)}`,
      previewConfirmed: true,
      overwriteConfirmed: false,
    }]);

    expect(test.presetService.applyPreset).toHaveBeenCalledWith(
      scope,
      'software_development',
      `agent-preset:v1:${'a'.repeat(64)}`,
      true,
      false,
    );
    expect(test.trustedWebContents.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_CHANGED,
      { type: 'preset_applied', providerId: null, changedAt: 1_700_000_000_300 },
    );
  });

  it('projects every preset reply and change event through closed safe fields', async () => {
    const test = harness();
    const unsafePreview = {
      ...presetPreview(),
      credential_ref: SENTINEL,
      hmacKey: SENTINEL,
      vaultPath: `C:/vault/${SENTINEL}`,
      rawEnvironment: { ANTHROPIC_API_KEY: SENTINEL },
    } as never;
    vi.mocked(test.presetService.preparePreset).mockResolvedValue({
      step: 'preview',
      preview: unsafePreview,
      secret: SENTINEL,
    } as never);
    vi.mocked(test.presetService.previewPreset).mockResolvedValue(unsafePreview);
    vi.mocked(test.presetService.applyPreset).mockResolvedValue({
      presetId: 'software_development',
      appliedAt: 1_700_000_000_300,
      encryptedBlob: SENTINEL,
    } as never);
    vi.mocked(test.presetService.getPresetStatus).mockResolvedValue({
      kind: 'preset',
      presetId: 'software_development',
      baseUrl: `https://${SENTINEL}@example.invalid`,
    } as never);
    const base = {
      scope: { type: 'global' as const },
      presetId: 'software_development' as const,
    };

    const replies = [
      await test.invoke(IPC_CHANNELS.AGENT_PRESET_PREPARE, [base]),
      await test.invoke(IPC_CHANNELS.AGENT_PRESET_PREVIEW, [base]),
      await test.invoke(IPC_CHANNELS.AGENT_PRESET_APPLY, [{
        ...base,
        expectedRevision: `agent-preset:v1:${'a'.repeat(64)}`,
        previewConfirmed: true,
        overwriteConfirmed: false,
      }]),
      await test.invoke(IPC_CHANNELS.AGENT_PRESET_GET_STATUS, [{ scope: base.scope }]),
      vi.mocked(test.trustedWebContents.send).mock.calls,
    ];

    expect(JSON.stringify(replies)).not.toMatch(
      /credential_ref|hmacKey|vaultPath|rawEnvironment|encryptedBlob|baseUrl|provider-secret-sentinel/iu,
    );
  });

  it('rejects stale or missing confirmation fields and sanitizes unexpected service failures', async () => {
    const test = harness();
    const valid = {
      scope: { type: 'global' },
      presetId: 'software_development',
      expectedRevision: `agent-preset:v1:${'a'.repeat(64)}`,
      previewConfirmed: true,
      overwriteConfirmed: false,
    };
    await expect(test.invoke(IPC_CHANNELS.AGENT_PRESET_APPLY, [{
      ...valid,
      expectedRevision: `agent-preset:v1:${'a'.repeat(63)}`,
    }])).rejects.toThrow(/invalid model configuration request/iu);
    await expect(test.invoke(IPC_CHANNELS.AGENT_PRESET_APPLY, [{
      ...valid,
      previewConfirmed: undefined,
    }])).rejects.toThrow(/invalid model configuration request/iu);
    expect(test.presetService.applyPreset).not.toHaveBeenCalled();

    vi.mocked(test.presetService.applyPreset).mockRejectedValueOnce(
      new AgentPresetServiceError('PREVIEW_STALE', `raw ${SENTINEL}`),
    );
    await expect(test.invoke(IPC_CHANNELS.AGENT_PRESET_APPLY, [valid]))
      .rejects.toThrow('The Agent template preview is out of date.');

    vi.mocked(test.presetService.previewPreset).mockRejectedValue(
      new Error(`raw ${SENTINEL} credential_ref C:/vault/blob`),
    );
    await expect(test.invoke(IPC_CHANNELS.AGENT_PRESET_PREVIEW, [{
      scope: { type: 'global' },
      presetId: 'software_development',
    }])).rejects.toThrow('Model Provider operation failed.');
  });

  it('fails a forged project through main-process authority with a closed public error', async () => {
    const test = harness();
    vi.mocked(test.tierService.listCandidates).mockRejectedValue(
      new ModelTierServiceError('PROJECT_NOT_FOUND', `raw database ${SENTINEL}`),
    );

    await expect(test.invoke(IPC_CHANNELS.MODEL_TIER_LIST_CANDIDATES, [{
      scope: { type: 'project', projectId: 'nonexistent-project' },
    }])).rejects.toThrow('The selected project was not found.');
  });

  it('rejects reserved synthetic application Provider IDs before service dispatch', async () => {
    const test = harness();
    for (const synthetic of [
      `synthetic:v1:environment:${'a'.repeat(64)}`,
      'synthetic:v2:future-reserved-identity',
      'synthetic:',
      'Synthetic:v2:repository-owned-case-insensitive-id',
    ]) {
      await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_UPDATE, [{
        providerId: synthetic,
        validationToken: 'token-1',
      }])).rejects.toThrow();
      await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_SET_ENABLED, [{
        providerId: synthetic,
        enabled: false,
      }])).rejects.toThrow();
      await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_DELETE, [{
        providerId: synthetic,
        confirmCredentialDeletion: true,
      }])).rejects.toThrow();
      await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_GET, [synthetic]))
        .rejects.toThrow();
      await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_LIST_MODELS, [synthetic]))
        .rejects.toThrow();
      await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_TEST_CONNECTION, [synthetic]))
        .rejects.toThrow();
      await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_SET_DEFAULT, [synthetic]))
        .rejects.toThrow();
      await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT, [{
        ...draft(),
        providerId: synthetic,
      }])).rejects.toThrow();
      await expect(test.invoke(IPC_CHANNELS.MODEL_POLICY_SET_AGENT, [{
        agentType: 'planner',
        providerId: synthetic,
        modelId: 'model-1',
        quality: null,
        speed: null,
        cost: null,
      }])).rejects.toThrow();
      await expect(test.invoke(IPC_CHANNELS.MODEL_POLICY_SET_PROJECT, [{
        projectId: 'project-1',
        agentType: 'default',
        providerId: synthetic,
        modelId: 'model-1',
      }])).rejects.toThrow();
      await expect(test.invoke(IPC_CHANNELS.MODEL_SELECTION_SET_TASK_OVERRIDE, [{
        taskId: 'task-1',
        providerId: synthetic,
        modelId: 'model-1',
      }])).rejects.toThrow();
    }
    expect(test.service.updateProvider).not.toHaveBeenCalled();
    expect(test.service.setProviderEnabled).not.toHaveBeenCalled();
    expect(test.service.deleteProvider).not.toHaveBeenCalled();
    expect(test.service.getProvider).not.toHaveBeenCalled();
    expect(test.service.listModels).not.toHaveBeenCalled();
    expect(test.service.testConnection).not.toHaveBeenCalled();
    expect(test.service.setDefaultProvider).not.toHaveBeenCalled();
    expect(test.service.validateDraft).not.toHaveBeenCalled();
    expect(test.policyService.setAgentPolicy).not.toHaveBeenCalled();
    expect(test.policyService.setProjectPolicy).not.toHaveBeenCalled();
    expect(test.selectionService.setTaskOverride).not.toHaveBeenCalled();

  });

  it('leaves synthetic tier IDs to exact trusted candidate validation in the tier service', async () => {
    const test = harness();
    const synthetic = `synthetic:v1:environment:${'a'.repeat(64)}`;

    await test.invoke(IPC_CHANNELS.MODEL_TIER_SET_BINDING, [{
      scope: { type: 'global' },
      tier: 'balanced',
      providerId: synthetic,
      modelId: 'mimo-v2.5-pro',
    }]);
    await test.invoke(BIND_ALL_CHANNEL, [{
      scope: { type: 'global' },
      providerId: synthetic,
      modelId: 'mimo-v2.5-pro',
    }]);

    expect(test.tierService.setBinding).toHaveBeenCalledWith({
      scope: { type: 'global' },
      tier: 'balanced',
      providerId: synthetic,
      modelId: 'mimo-v2.5-pro',
    });
    expect(test.tierService.bindAllTiers).toHaveBeenCalledWith({
      scope: { type: 'global' },
      providerId: synthetic,
      modelId: 'mimo-v2.5-pro',
    });
  });
});

describe('model policy IPC', () => {
  it('projects a trusted direct-reference Provider name without leaking unapproved service fields', async () => {
    const test = harness();
    vi.mocked(test.policyService.listAgentPolicyReferences).mockReturnValue([{
      scope: { type: 'global' },
      agentType: 'planner',
      reference: { kind: 'model', providerId: PROVIDER_ID, modelId: 'mimo-v2.5-pro' },
      providerName: 'Friendly MiMo Gateway',
      notes: { quality: 'high', speed: null, cost: null },
      createdAt: 10,
      updatedAt: 20,
      credential_ref: SENTINEL,
      baseUrl: `https://gateway.example/${SENTINEL}`,
      rawError: SENTINEL,
    }] as never);

    const result = await test.invoke<Array<Record<string, unknown>>>(
      'model-policy:list-agent-references',
      [{ scope: { type: 'global' } }],
    );

    expect(result).toEqual([{
      scope: { type: 'global' },
      agentType: 'planner',
      reference: { kind: 'model', providerId: PROVIDER_ID, modelId: 'mimo-v2.5-pro' },
      providerName: 'Friendly MiMo Gateway',
      notes: { quality: 'high', speed: null, cost: null },
      createdAt: 10,
      updatedAt: 20,
    }]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('strictly scopes and safely projects closed model-or-tier Agent references', async () => {
    const test = harness();
    vi.mocked(test.policyService.listAgentPolicyReferences).mockReturnValue([{
      ...test.policyService.listAgentPolicyReferences()[0],
      credential_ref: SENTINEL,
      baseUrl: `https://gateway.example/${SENTINEL}`,
      rawError: SENTINEL,
      reference: { kind: 'tier', tier: 'high_quality', vaultPath: SENTINEL },
    }] as never);

    const result = await test.invoke<Array<Record<string, unknown>>>(
      'model-policy:list-agent-references',
      [{ scope: { type: 'global' } }],
    );
    expect(result).toEqual([{
      scope: { type: 'global' },
      agentType: 'planner',
      reference: { kind: 'tier', tier: 'high_quality' },
      providerName: null,
      notes: { quality: 'high', speed: null, cost: null },
      createdAt: 10,
      updatedAt: 20,
    }]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(test.policyService.listAgentPolicyReferences).toHaveBeenCalledWith({ type: 'global' });
    await expect(test.invoke('model-policy:list-agent-references', [{
      scope: { type: 'global' }, secret: SENTINEL,
    }])).rejects.toThrow();
  });

  it('projects Agent policy notes and never returns unapproved service fields', async () => {
    const test = harness();
    vi.mocked(test.policyService.listAgentPolicies).mockReturnValue([{
      ...test.policyService.listAgentPolicies()[0],
      credential: SENTINEL,
      metadata: { apiKey: SENTINEL },
    }] as never);

    const result = await test.invoke<Array<Record<string, unknown>>>(
      IPC_CHANNELS.MODEL_POLICY_LIST_AGENT,
    );

    expect(result).toEqual([{
      agentType: 'planner',
      providerId: PROVIDER_ID,
      modelId: 'mimo-v2.5-pro',
      notes: { quality: 'high', speed: 'medium', cost: 'low' },
      createdAt: 10,
      updatedAt: 20,
    }]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('strictly validates and delegates Agent policy mutations to the gated service', async () => {
    const test = harness();
    const input = {
      agentType: 'reviewer',
      providerId: PROVIDER_ID,
      modelId: 'mimo-v2.5-pro',
      quality: 'high',
      speed: 'medium',
      cost: null,
    };

    await test.invoke(IPC_CHANNELS.MODEL_POLICY_SET_AGENT, [input]);
    expect(test.policyService.setAgentPolicy).toHaveBeenCalledWith(input);
    await test.invoke(IPC_CHANNELS.MODEL_POLICY_DELETE_AGENT, [{ agentType: 'reviewer' }]);
    expect(test.policyService.deleteAgentPolicy).toHaveBeenCalledWith('reviewer');

    await expect(test.invoke(IPC_CHANNELS.MODEL_POLICY_SET_AGENT, [{
      ...input,
      credential: SENTINEL,
    }])).rejects.toThrow();
    await expect(test.invoke(IPC_CHANNELS.MODEL_POLICY_SET_AGENT, [{
      ...input,
      agentType: 'admin',
    }])).rejects.toThrow();
    await expect(test.invoke(IPC_CHANNELS.MODEL_POLICY_SET_AGENT, [{
      ...input,
      quality: 'premium',
    }])).rejects.toThrow();
  });

  it('strictly validates project policy inputs and projects public records', async () => {
    const test = harness();
    const listed = await test.invoke<Array<Record<string, unknown>>>(
      IPC_CHANNELS.MODEL_POLICY_LIST_PROJECT,
      [{ projectId: 'project-1' }],
    );
    expect(listed).toEqual([{
      projectId: 'project-1',
      agentType: 'default',
      providerId: PROVIDER_ID,
      modelId: 'mimo-v2.5-pro',
      createdAt: 30,
      updatedAt: 40,
    }]);

    const input = {
      projectId: 'project-1',
      agentType: 'coder',
      providerId: PROVIDER_ID,
      modelId: 'mimo-v2.5-pro',
    };
    await test.invoke(IPC_CHANNELS.MODEL_POLICY_SET_PROJECT, [input]);
    expect(test.policyService.setProjectPolicy).toHaveBeenCalledWith(input);
    await test.invoke(IPC_CHANNELS.MODEL_POLICY_DELETE_PROJECT, [{
      projectId: 'project-1', agentType: 'coder',
    }]);
    expect(test.policyService.deleteProjectPolicy).toHaveBeenCalledWith('project-1', 'coder');

    await expect(test.invoke(IPC_CHANNELS.MODEL_POLICY_LIST_PROJECT, [{
      projectId: 'project-1', secret: SENTINEL,
    }])).rejects.toThrow();
  });

  it('publishes sanitized change events after successful policy mutations', async () => {
    const test = harness();

    await test.invoke(IPC_CHANNELS.MODEL_POLICY_SET_AGENT, [{
      agentType: 'planner',
      providerId: PROVIDER_ID,
      modelId: 'mimo-v2.5-pro',
      quality: 'high',
      speed: 'medium',
      cost: 'low',
    }]);
    expect(test.trustedWebContents.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_CHANGED,
      { type: 'policy_changed', providerId: PROVIDER_ID, changedAt: 1_700_000_000_300 },
    );

    await test.invoke(IPC_CHANNELS.MODEL_POLICY_DELETE_AGENT, [{ agentType: 'planner' }]);
    expect(test.trustedWebContents.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_CHANGED,
      { type: 'policy_changed', providerId: null, changedAt: 1_700_000_000_300 },
    );
  });
});

describe('effective model selection and task quick switch IPC', () => {
  it('derives project identity and use from trusted task context', async () => {
    const test = harness();
    const result = await test.invoke<Record<string, unknown>>(
      IPC_CHANNELS.MODEL_SELECTION_GET_EFFECTIVE,
      [{ taskId: 'task-1', agentType: 'planner' }],
    );

    expect(test.getTaskContext).toHaveBeenCalledWith('task-1');
    expect(test.selectionService.resolve).toHaveBeenCalledWith({
      taskId: 'task-1',
      projectId: 'project-1',
      agentType: 'planner',
      fallbackModelId: 'fallback-model',
      use: 'agent-workflow',
    });
    expect(result).toEqual(test.resolvedSelection);

    await expect(test.invoke(IPC_CHANNELS.MODEL_SELECTION_GET_EFFECTIVE, [{
      taskId: 'task-1',
      projectId: 'attacker-project',
      status: 'idle',
      use: 'chat',
    }])).rejects.toThrow();
  });

  it('uses chat for an effective selection without an Agent role', async () => {
    const test = harness();
    await test.invoke(IPC_CHANNELS.MODEL_SELECTION_GET_EFFECTIVE, [{ taskId: 'task-1' }]);
    expect(test.selectionService.resolve).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      projectId: 'project-1',
      use: 'chat',
    }));
  });

  it('rejects a case-insensitive reserved synthetic identity before override mutation', async () => {
    const test = harness();

    await expect(test.invoke(IPC_CHANNELS.MODEL_SELECTION_SET_TASK_OVERRIDE, [{
      taskId: 'task-1',
      providerId: 'Synthetic:v2:repository-owned-case-insensitive-id',
      modelId: 'forged-model',
    }])).rejects.toThrow();
    expect(test.selectionService.setTaskOverride).not.toHaveBeenCalled();
    expect(test.selectionService.resolve).not.toHaveBeenCalled();
  });

  it('rejects an unknown task before resolving or mutating selection', async () => {
    const test = harness();
    test.getTaskContext.mockReturnValue(null);

    await expect(test.invoke(IPC_CHANNELS.MODEL_SELECTION_GET_EFFECTIVE, [
      { taskId: 'missing' },
    ])).rejects.toThrow(/task was not found/i);
    await expect(test.invoke(IPC_CHANNELS.MODEL_SELECTION_SET_TASK_OVERRIDE, [{
      taskId: 'missing', providerId: PROVIDER_ID, modelId: 'mimo-v2.5-pro',
    }])).rejects.toThrow(/task was not found/i);
    expect(test.selectionService.resolve).not.toHaveBeenCalled();
    expect(test.selectionService.setTaskOverride).not.toHaveBeenCalled();
  });

  it('takes task status only from main and returns a public effective snapshot plus warning', async () => {
    const test = harness();
    vi.mocked(test.selectionService.resolve).mockReturnValue({
      ...test.resolvedSelection,
      credentialRef: `safe-storage://${SENTINEL}`,
      metadata: { secret: SENTINEL },
    } as never);

    const result = await test.invoke<Record<string, unknown>>(
      IPC_CHANNELS.MODEL_SELECTION_SET_TASK_OVERRIDE,
      [{ taskId: 'task-1', providerId: PROVIDER_ID, modelId: 'mimo-v2.5-pro' }],
    );

    expect(test.selectionService.setTaskOverride).toHaveBeenCalledWith({
      taskId: 'task-1',
      providerId: PROVIDER_ID,
      modelId: 'mimo-v2.5-pro',
      status: 'idle',
    });
    expect(result).toEqual({
      selection: test.resolvedSelection,
      warning: '模型改变只影响后续 Agent 调用。',
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(test.trustedWebContents.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_CHANGED,
      { type: 'selection_changed', providerId: PROVIDER_ID, changedAt: 1_700_000_000_300 },
    );

    await expect(test.invoke(IPC_CHANNELS.MODEL_SELECTION_SET_TASK_OVERRIDE, [{
      taskId: 'task-1',
      providerId: PROVIDER_ID,
      modelId: 'mimo-v2.5-pro',
      status: 'idle',
    }])).rejects.toThrow();
  });

  it('delegates the trusted running status so the service can block switching', async () => {
    const test = harness();
    test.getTaskContext.mockReturnValue({
      projectId: 'project-1', status: 'running', fallbackModelId: null,
    });
    test.selectionService.setTaskOverride.mockImplementation((input) => {
      if (input.status === 'running') {
        throw new ModelSwitchError('TASK_ACTIVE', '正在运行任务时禁止切换模型。');
      }
      return { providerId: input.providerId, modelId: input.modelId, warning: '' };
    });

    await expect(test.invoke(IPC_CHANNELS.MODEL_SELECTION_SET_TASK_OVERRIDE, [{
      taskId: 'task-1', providerId: PROVIDER_ID, modelId: 'mimo-v2.5-pro',
    }])).rejects.toThrow('正在运行任务时禁止切换模型。');
    expect(test.selectionService.resolve).not.toHaveBeenCalled();
  });

  it('blocks a TaskManager-active task even while its persisted status is still idle', async () => {
    const test = harness();
    test.isTaskActive.mockReturnValue(true);

    await expect(test.invoke(IPC_CHANNELS.MODEL_SELECTION_SET_TASK_OVERRIDE, [{
      taskId: 'task-1', providerId: PROVIDER_ID, modelId: 'mimo-v2.5-pro',
    }])).rejects.toThrow('正在运行任务时禁止切换模型。');
    await expect(test.invoke(IPC_CHANNELS.MODEL_SELECTION_CLEAR_TASK_OVERRIDE, [{
      taskId: 'task-1',
    }])).rejects.toThrow('正在运行任务时禁止切换模型。');
    expect(test.selectionService.setTaskOverride).not.toHaveBeenCalled();
    expect(test.selectionService.clearTaskOverride).not.toHaveBeenCalled();
  });

  it('clears an idle override and resolves the newly effective future selection', async () => {
    const test = harness();
    vi.mocked(test.selectionService.resolve).mockReturnValue({
      ...test.resolvedSelection,
      source: 'global_default',
    });

    const result = await test.invoke<Record<string, unknown>>(
      IPC_CHANNELS.MODEL_SELECTION_CLEAR_TASK_OVERRIDE,
      [{ taskId: 'task-1' }],
    );

    expect(test.selectionService.clearTaskOverride).toHaveBeenCalledWith('task-1', 'idle');
    expect(result).toMatchObject({
      selection: { source: 'global_default' },
      warning: '模型改变只影响后续 Agent 调用。',
    });
    expect(test.trustedWebContents.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_CHANGED,
      { type: 'selection_changed', providerId: null, changedAt: 1_700_000_000_300 },
    );
  });
});

describe('model provider IPC input validation', () => {
  it('normalizes bounded pagination and rejects unknown fields', async () => {
    const test = harness();

    await test.invoke(IPC_CHANNELS.MODEL_PROVIDER_LIST, [{ enabled: true }]);
    expect(test.service.listProviders).toHaveBeenCalledWith({
      enabled: true,
      limit: 25,
      offset: 0,
    });

    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_LIST, [{ limit: 101 }]))
      .rejects.toThrow();
    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_LIST, [{ secret: SENTINEL }]))
      .rejects.toThrow();
  });

  it('accepts credentials only in a strict, size-bounded validation draft', async () => {
    const test = harness();
    await test.invoke(IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT, [draft()]);
    expect(test.service.validateDraft).toHaveBeenCalledWith(draft());

    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT, [
      { ...draft(), credentialRef: `safe-storage://${SENTINEL}` },
    ])).rejects.toThrow();
    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT, [
      draft({ credential: 'x'.repeat(8_193) }),
    ])).rejects.toThrow();
  });

  it('accepts only the closed existing-provider Base URL preserve intent', async () => {
    const test = harness();
    const preserved = {
      providerId: PROVIDER_ID,
      name: 'MiMo renamed',
      type: 'anthropic-compatible',
      apiFormat: 'anthropic-messages',
      baseUrlIntent: { mode: 'preserve_existing' },
      credential: null,
      defaultModelId: 'mimo-v2.5-pro',
    };

    await test.invoke(IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT, [preserved]);
    expect(test.service.validateDraft).toHaveBeenCalledWith(preserved);
    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT, [{
      ...preserved,
      providerId: undefined,
    }])).rejects.toThrow();
    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT, [{
      ...preserved,
      baseUrlIntent: { mode: 'preserve_existing', value: 'https://forged.invalid' },
    }])).rejects.toThrow();
  });

  it('does not broadcast a persisted health change for an edit-draft validation', async () => {
    const test = harness();

    await test.invoke(IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT, [draft({
      providerId: PROVIDER_ID,
      credential: null,
    })]);

    expect(test.trustedWebContents.send).not.toHaveBeenCalled();
  });

  it('accepts only a validation token when creating a provider', async () => {
    const test = harness();
    await test.invoke(IPC_CHANNELS.MODEL_PROVIDER_CREATE, [{ validationToken: 'token-1' }]);
    expect(test.service.createProvider).toHaveBeenCalledWith({ validationToken: 'token-1' });

    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_CREATE, [{
      validationToken: 'token-1',
      credential: SENTINEL,
    }])).rejects.toThrow();
  });

  it('requires explicit credential deletion confirmation', async () => {
    const test = harness();

    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_DELETE, [{
      providerId: PROVIDER_ID,
      confirmCredentialDeletion: false,
    }])).rejects.toThrow(/confirmation/i);
    expect(test.service.deleteProvider).not.toHaveBeenCalled();

    await test.invoke(IPC_CHANNELS.MODEL_PROVIDER_DELETE, [{
      providerId: PROVIDER_ID,
      confirmCredentialDeletion: true,
    }]);
    expect(test.service.deleteProvider).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      confirmCredentialDeletion: true,
    });
  });

  it('accepts only a strict Provider enabled mutation and publishes a change', async () => {
    const test = harness();
    const result = await test.invoke<PublicModelProvider>(
      IPC_CHANNELS.MODEL_PROVIDER_SET_ENABLED,
      [{ providerId: PROVIDER_ID, enabled: false }],
    );
    expect(test.service.setProviderEnabled).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      enabled: false,
    });
    expect(result.enabled).toBe(false);
    expect(test.trustedWebContents.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_CHANGED,
      { type: 'enabled_changed', providerId: PROVIDER_ID, changedAt: 1_700_000_000_300 },
    );

    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_SET_ENABLED, [{
      providerId: PROVIDER_ID,
      enabled: true,
      isDefault: true,
    }])).rejects.toThrow();
  });
});

describe('model provider IPC public projection', () => {
  it('projects stale Provider update failures through a fixed non-secret error', async () => {
    const test = harness();
    vi.mocked(test.service.updateProvider).mockRejectedValue(new ModelProviderServiceError(
      'STALE_PROVIDER',
      `stale ${SENTINEL} credential_ref https://gateway.example/private-path`,
    ));

    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_UPDATE, [{
      providerId: PROVIDER_ID,
      validationToken: 'token-2',
    }])).rejects.toThrow('Provider changed after validation. Test the connection again.');
  });

  it('redacts a non-root Base URL path from every Provider-returning handler', async () => {
    const test = harness();
    const unsafeProvider = provider({
      baseUrl: `https://gateway.example/anthropic/${PATH_SENTINEL}`,
      baseUrlPathRedacted: false,
    });
    vi.mocked(test.service.listProviders).mockReturnValue({
      ...test.page,
      items: [unsafeProvider],
    });
    vi.mocked(test.service.getProvider).mockReturnValue(unsafeProvider);
    vi.mocked(test.service.createProvider).mockResolvedValue(unsafeProvider);
    vi.mocked(test.service.updateProvider).mockResolvedValue(unsafeProvider);
    vi.mocked(test.service.setDefaultProvider).mockReturnValue({ ...unsafeProvider, isDefault: true });
    vi.mocked(test.service.setProviderEnabled).mockReturnValue({ ...unsafeProvider, enabled: false });

    const replies = [
      await test.invoke<ModelProviderPage>(IPC_CHANNELS.MODEL_PROVIDER_LIST, [{}]),
      await test.invoke<PublicModelProvider>(IPC_CHANNELS.MODEL_PROVIDER_GET, [PROVIDER_ID]),
      await test.invoke<PublicModelProvider>(IPC_CHANNELS.MODEL_PROVIDER_CREATE, [{ validationToken: 'token-1' }]),
      await test.invoke<PublicModelProvider>(IPC_CHANNELS.MODEL_PROVIDER_UPDATE, [{ providerId: PROVIDER_ID, validationToken: 'token-2' }]),
      await test.invoke<PublicModelProvider>(IPC_CHANNELS.MODEL_PROVIDER_SET_DEFAULT, [PROVIDER_ID]),
      await test.invoke<PublicModelProvider>(IPC_CHANNELS.MODEL_PROVIDER_SET_ENABLED, [{ providerId: PROVIDER_ID, enabled: false }]),
    ];
    const providers = [
      (replies[0] as ModelProviderPage).items[0],
      ...replies.slice(1) as PublicModelProvider[],
    ];

    for (const result of providers) {
      expect(result.baseUrl).toBe('https://gateway.example');
      expect(result.baseUrlPathRedacted).toBe(true);
    }
    expect(JSON.stringify({ replies, events: vi.mocked(test.trustedWebContents.send).mock.calls }))
      .not.toContain(PATH_SENTINEL);
  });

  it('normalizes unexpected Provider, policy, and selection failures without raw private data', async () => {
    const test = harness();
    const raw = new Error(`credential_ref apiKey https://${SENTINEL}@example.invalid C:/vault/blob`);
    vi.mocked(test.service.listProviders).mockRejectedValue(raw);
    await expect(test.invoke(IPC_CHANNELS.MODEL_PROVIDER_LIST, [{}]))
      .rejects.toThrow('Model Provider operation failed.');

    test.policyService.listAgentPolicies.mockRejectedValue(raw);
    await expect(test.invoke(IPC_CHANNELS.MODEL_POLICY_LIST_AGENT))
      .rejects.toThrow('Model Provider operation failed.');

    test.selectionService.resolve.mockRejectedValue(raw);
    await expect(test.invoke(IPC_CHANNELS.MODEL_SELECTION_GET_EFFECTIVE, [{
      taskId: 'task-1',
    }])).rejects.toThrow('Model Provider operation failed.');
  });

  it('drops credential, reference, blob, and other unapproved fields from provider pages', async () => {
    const test = harness();
    const unsafe = {
      ...provider(),
      credential: SENTINEL,
      credentialRef: `safe-storage://${SENTINEL}`,
      encryptedBlob: SENTINEL,
      metadata: { apiKey: SENTINEL },
    };
    vi.mocked(test.service.listProviders).mockReturnValue({
      ...test.page,
      items: [unsafe],
    });

    const result = await test.invoke<ModelProviderPage>(IPC_CHANNELS.MODEL_PROVIDER_LIST, [{}]);
    const serialized = JSON.stringify(result);

    expect(result.items[0]).toEqual(provider());
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toMatch(/credentialRef|encryptedBlob|apiKey/);
  });

  it('never echoes the validation draft or transient credential', async () => {
    const test = harness();
    vi.mocked(test.service.validateDraft).mockResolvedValue({
      ...test.validation,
      credential: SENTINEL,
      draft: draft(),
    } as never);

    const result = await test.invoke<ProviderValidationResult>(
      IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT,
      [draft()],
    );

    expect(result).toEqual(test.validation);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('replaces connection error details with a categorized public message', async () => {
    const test = harness();
    vi.mocked(test.service.testConnection).mockResolvedValue({
      ok: false,
      testedAt: 1_700_000_000_200,
      latencyMs: null,
      discoveredModelIds: [],
      error: {
        type: 'invalid_key',
        statusCode: 401,
        message: `remote response contained ${SENTINEL}`,
      },
    });

    const result = await test.invoke<ProviderConnectionResult>(
      IPC_CHANNELS.MODEL_PROVIDER_TEST_CONNECTION,
      [PROVIDER_ID],
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    if (!result.ok) expect(result.error.type).toBe('invalid_key');
  });

  it('publishes a sanitized change notification only after a successful mutation', async () => {
    const test = harness();

    await test.invoke(IPC_CHANNELS.MODEL_PROVIDER_CREATE, [{ validationToken: 'token-1' }]);

    expect(test.trustedWebContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_CHANGED,
      {
        type: 'created',
        providerId: PROVIDER_ID,
        changedAt: 1_700_000_000_300,
      },
    );
    expect(JSON.stringify(vi.mocked(test.trustedWebContents.send).mock.calls)).not.toContain(SENTINEL);
  });
});
