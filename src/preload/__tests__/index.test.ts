import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeWorkbenchAPI, ClaudeWorkbenchIpcTransport } from '../../shared/types/ipc';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { PermissionSettlement } from '../../shared/types/permissionBroker';
import type { ModelProviderChangedEvent } from '../../shared/types/ipc';
import { createMainWorldPublicApi } from '../../renderer/public-api-facade';

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: electronMocks.exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
    send: electronMocks.send,
  },
}));

await import('../index');

electronMocks.invoke.mockImplementation(async () => ({
  schemaVersion: 1,
  ok: true,
  value: undefined,
}));

beforeEach(() => {
  electronMocks.invoke.mockReset().mockResolvedValue({
    schemaVersion: 1,
    ok: true,
    value: undefined,
  });
});

function exposedApi(): ClaudeWorkbenchAPI {
  const call = electronMocks.exposeInMainWorld.mock.calls.find(
    ([name]) => name === '__claudeWorkbenchIpcTransport',
  );
  if (!call) throw new Error('Preload API was not exposed.');
  return createMainWorldPublicApi(call[1] as ClaudeWorkbenchIpcTransport);
}

describe('preload public invoke transport', () => {
  it('unwraps exact success envelopes including an explicit undefined value', async () => {
    electronMocks.invoke
      .mockResolvedValueOnce({ schemaVersion: 1, ok: true, value: { completedVersion: 1 } })
      .mockResolvedValueOnce({ schemaVersion: 1, ok: true, value: undefined });

    await expect(exposedApi().getFirstRunCompletedVersion()).resolves.toEqual({ completedVersion: 1 });
    await expect(exposedApi().setFirstRunCompletedVersion(1)).resolves.toBeUndefined();
  });

  it('turns an exact failure envelope into one local path-free Error', async () => {
    electronMocks.invoke.mockResolvedValueOnce({
      schemaVersion: 1,
      ok: false,
      error: { code: 'NOT_A_REPOSITORY', message: 'Selected project is not a Git working tree.' },
    });

    const error = await exposedApi().getGitWorkspaceStatus('project-1', 'C:\\private\\project')
      .then(() => null, (reason) => reason as Error & { code?: unknown; cause?: unknown });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'Error',
      message: 'Selected project is not a Git working tree.',
      code: 'NOT_A_REPOSITORY',
    });
    expect(error?.stack).toBe('Error: Selected project is not a Git working tree.');
    expect(error).not.toHaveProperty('cause');
    expect(Reflect.ownKeys(error ?? {})).toEqual(['stack', 'message', 'code']);
  });

  it('accepts an exact class-specific fixed message for a shared public code', async () => {
    electronMocks.invoke.mockResolvedValueOnce({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'CHECKPOINT_TASK_ACTIVE',
        message: 'An active task blocks this checkpoint action.',
      },
    });

    const error = await exposedApi().previewCheckpointRestore('checkpoint-1')
      .then(() => null, (reason) => reason as Error & { code?: unknown });
    expect(error).toMatchObject({
      message: 'An active task blocks this checkpoint action.',
      code: 'CHECKPOINT_TASK_ACTIVE',
    });
    expect(error?.stack).toBe('Error: An active task blocks this checkpoint action.');
  });

  it('turns a dirty transport rejection into one fixed local Error without inspecting it', async () => {
    const dirty = new Error('C:\\Users\\PrivateProfile\\workspace private-transport-secret') as Error & {
      cause?: unknown;
      privateField?: unknown;
    };
    dirty.stack = 'Error: C:/Users/PrivateProfile/workspace/private.ts:1:1';
    dirty.cause = { secret: 'private-transport-secret' };
    dirty.privateField = { profile: 'C:\\Users\\PrivateProfile' };
    electronMocks.invoke.mockRejectedValueOnce(dirty);

    const error = await exposedApi().getFirstRunCompletedVersion()
      .then(() => null, (reason) => reason as Error & { code?: unknown; cause?: unknown });
    expect(error).toMatchObject({
      message: 'The main process did not return a response.',
      code: 'IPC_TRANSPORT_FAILED',
    });
    expect(error?.stack).toBe('Error: The main process did not return a response.');
    expect(error).not.toHaveProperty('cause');
    expect(Reflect.ownKeys(error ?? {})).toEqual(['stack', 'message', 'code']);
    expect(JSON.stringify(error)).not.toMatch(/PrivateProfile|private-transport-secret/iu);
  });

  it.each([
    undefined,
    null,
    [],
    { schemaVersion: 2, ok: true, value: null },
    { schemaVersion: 1, ok: true },
    { schemaVersion: 1, ok: true, value: null, extra: true },
    Object.assign(Object.create({ inherited: true }), {
      schemaVersion: 1, ok: true, value: null,
    }),
    { schemaVersion: 1, ok: false, error: { code: 'NOT_A_REPOSITORY' } },
    { schemaVersion: 1, ok: false, error: {
      code: 'UNKNOWN_DYNAMIC_CODE', message: 'Selected project is not a Git working tree.',
    } },
    { schemaVersion: 1, ok: false, error: {
      code: 'NOT_A_REPOSITORY', message: 'C:\\Users\\PrivateProfile\\dynamic message',
    } },
    { schemaVersion: 1, ok: false, error: Object.assign(Object.create(null), {
      code: 'NOT_A_REPOSITORY', message: 'Selected project is not a Git working tree.',
    }) },
    { schemaVersion: 1, ok: false, error: {
      code: 'NOT_A_REPOSITORY', message: 'Selected project is not a Git working tree.', extra: true,
    } },
    new Proxy({}, {
      ownKeys: () => { throw new Error('C:\\Users\\PrivateProfile\\private-proxy-value'); },
    }),
  ])('rejects a malformed or extra-key envelope without reflecting it: %#', async (response) => {
    electronMocks.invoke.mockResolvedValueOnce(response);

    const error = await exposedApi().getFirstRunCompletedVersion()
      .then(() => null, (reason) => reason as Error & { code?: unknown });
    expect(error).toMatchObject({
      message: 'Invalid response from the main process.',
      code: 'IPC_RESPONSE_INVALID',
    });
    expect(error?.stack).toBe('Error: Invalid response from the main process.');
    expect(JSON.stringify(error)).not.toContain('NOT_A_REPOSITORY');
  });

  it('rejects accessor-backed failure fields without reflecting a later private value', async () => {
    let messageReads = 0;
    const failure = { code: 'NOT_A_REPOSITORY' } as {
      code: string;
      message?: string;
    };
    Object.defineProperty(failure, 'message', {
      configurable: true,
      enumerable: true,
      get: () => {
        messageReads += 1;
        return messageReads === 1
          ? 'Selected project is not a Git working tree.'
          : 'C:\\Users\\PrivateProfile\\private-accessor-value';
      },
    });
    electronMocks.invoke.mockResolvedValueOnce({
      schemaVersion: 1,
      ok: false,
      error: failure,
    });

    const error = await exposedApi().getFirstRunCompletedVersion()
      .then(() => null, (reason) => reason as Error & { code?: unknown });
    expect(error).toMatchObject({
      message: 'Invalid response from the main process.',
      code: 'IPC_RESPONSE_INVALID',
    });
    expect(messageReads).toBe(0);
    expect(error?.stack).toBe('Error: Invalid response from the main process.');
    expect(JSON.stringify(error)).not.toMatch(/PrivateProfile|private-accessor-value/iu);
  });
});

describe('preload first-run API', () => {
  it('exposes only named project and completion methods with exact arguments', async () => {
    const api = exposedApi();

    await api.createFirstRunTestProject();
    await api.getFirstRunCompletedVersion();
    await api.setFirstRunCompletedVersion(1);

    expect(electronMocks.invoke.mock.calls).toContainEqual([
      IPC_CHANNELS.FIRST_RUN_CREATE_TEST_PROJECT,
    ]);
    expect(electronMocks.invoke.mock.calls).toContainEqual([
      IPC_CHANNELS.FIRST_RUN_GET_COMPLETED_VERSION,
    ]);
    expect(electronMocks.invoke.mock.calls).toContainEqual([
      IPC_CHANNELS.FIRST_RUN_SET_COMPLETED_VERSION,
      1,
    ]);
    expect(api).not.toHaveProperty('invoke');
    expect(api).not.toHaveProperty('createFirstRunProjectAtPath');
    expect(api).not.toHaveProperty('cleanupFirstRunProject');
    expect(api).not.toHaveProperty('writeFirstRunProjectFile');
  });
});

describe('preload diagnostics API', () => {
  it('forwards only the exact per-export anonymous-data intent through its named method', async () => {
    const api = exposedApi();

    await api.exportDiagnostics({ includeAnonymousPerformanceData: false });
    await api.exportDiagnostics({ includeAnonymousPerformanceData: true });

    expect(electronMocks.invoke.mock.calls).toContainEqual([
      IPC_CHANNELS.SYSTEM_EXPORT_DIAGNOSTICS,
      { includeAnonymousPerformanceData: false },
    ]);
    expect(electronMocks.invoke.mock.calls).toContainEqual([
      IPC_CHANNELS.SYSTEM_EXPORT_DIAGNOSTICS,
      { includeAnonymousPerformanceData: true },
    ]);
    expect(api).not.toHaveProperty('invoke');
    expect(api).not.toHaveProperty('exportDiagnosticsWithAggregate');
    expect(api).not.toHaveProperty('getAnonymousPerformanceData');
  });
});

describe('preload Session create API', () => {
  it('omits the optional argument entirely when no Session options were provided', async () => {
    const api = exposedApi();

    await api.createSession('project-1');
    await api.createSession('project-1', { model: 'model-a', permissionMode: 'plan' });

    expect(electronMocks.invoke.mock.calls).toContainEqual([
      IPC_CHANNELS.SESSION_CREATE,
      'project-1',
    ]);
    expect(electronMocks.invoke.mock.calls).toContainEqual([
      IPC_CHANNELS.SESSION_CREATE,
      'project-1',
      { model: 'model-a', permissionMode: 'plan' },
    ]);
  });
});

describe('preload permission settlement API', () => {
  it('forwards settlement events and removes the exact listener', () => {
    const listener = vi.fn();
    const unsubscribe = exposedApi().onPermissionSettled(listener);
    const registration = electronMocks.on.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.PERMISSION_SETTLED,
    );
    expect(registration).toBeDefined();
    const handler = registration?.[1] as (
      event: unknown,
      settlement: PermissionSettlement,
    ) => void;
    const settlement: PermissionSettlement = {
      requestId: 'request-1',
      runId: 'run-1',
      sessionKey: 'project::session',
      projectPath: 'C:\\projects\\fixture',
      toolName: 'Read',
      behavior: 'deny',
      cause: 'timeout',
      decisionClassification: 'user_reject',
      message: 'Permission request timed out.',
      settledAt: 25,
    };

    handler({}, settlement);
    unsubscribe();

    expect(listener).toHaveBeenCalledWith(settlement);
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.PERMISSION_SETTLED,
      handler,
    );
  });

  it('exposes project rule management only through permission IPC channels', async () => {
    const api = exposedApi();

    await api.listProjectPermissionRules('project-1', { limit: 25, offset: 0 });
    await api.setProjectPermissionRuleEnabled('project-1', 'rule-1', false);
    await api.deleteProjectPermissionRule('project-1', 'rule-1');
    await api.clearProjectPermissionRules('project-1', true);
    await api.listProjectPermissionAudit('project-1', { limit: 25, offset: 0 });

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.PERMISSION_RULES_LIST,
      'project-1',
      { limit: 25, offset: 0 },
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.PERMISSION_RULE_SET_ENABLED,
      'project-1',
      'rule-1',
      false,
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.PERMISSION_RULE_DELETE,
      'project-1',
      'rule-1',
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.PERMISSION_RULE_CLEAR,
      'project-1',
      true,
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.PERMISSION_AUDIT_LIST,
      'project-1',
      { limit: 25, offset: 0 },
    );
  });
});

describe('preload Git workspace API', () => {
  it('forwards explicit repository initialization with project identity and path', async () => {
    await exposedApi().initializeGitWorkspace('project-1', 'C:\\projects\\fixture');

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.GIT_WORKSPACE_INIT,
      'project-1',
      'C:\\projects\\fixture',
    );
  });
});

describe('preload model provider API', () => {
  it('exposes named tier and preset methods without a repository or resolved-selection escape hatch', async () => {
    const api = exposedApi();
    const scope = { type: 'project' as const, projectId: 'project-1' };
    const binding = {
      scope,
      tier: 'balanced' as const,
      providerId: 'provider-1',
      modelId: 'model-1',
    };
    const preset = { scope, presetId: 'software_development' as const };

    await api.listModelTierCandidates({ scope });
    await api.listModelTierBindings({ scope });
    await api.setModelTierBinding(binding);
    await api.bindAllModelTiers({
      scope,
      providerId: 'provider-1',
      modelId: 'model-1',
    });
    await api.updateModelTierDisplayMetadata({
      scope,
      metadata: {
        tier: 'balanced',
        displayName: 'Daily work',
        quality: 'medium',
        speed: 'high',
        cost: 'low',
      },
    });
    await api.clearProjectModelTierBinding({ projectId: 'project-1', tier: 'balanced' });
    await api.prepareAgentPreset(preset);
    await api.previewAgentPreset(preset);
    await api.applyAgentPreset({
      ...preset,
      expectedRevision: `agent-preset:v1:${'a'.repeat(64)}`,
      previewConfirmed: true,
      overwriteConfirmed: false,
    });
    await api.getAgentPresetStatus({ scope });
    await api.listAgentModelPolicyReferences({ scope });

    expect(electronMocks.invoke.mock.calls).toContainEqual([
      IPC_CHANNELS.MODEL_TIER_LIST_CANDIDATES,
      { scope },
    ]);
    expect(electronMocks.invoke.mock.calls).toContainEqual([
      'model-tier:bind-all',
      { scope, providerId: 'provider-1', modelId: 'model-1' },
    ]);
    expect(electronMocks.invoke.mock.calls).toContainEqual([
      IPC_CHANNELS.AGENT_PRESET_APPLY,
      {
        ...preset,
        expectedRevision: `agent-preset:v1:${'a'.repeat(64)}`,
        previewConfirmed: true,
        overwriteConfirmed: false,
      },
    ]);
    expect(electronMocks.invoke.mock.calls).toContainEqual([
      'model-policy:list-agent-references',
      { scope },
    ]);
    expect(api).not.toHaveProperty('applyAgentPolicyReferencesAtomically');
    expect(api).not.toHaveProperty('resolvePreparedBindings');
    expect(api).not.toHaveProperty('runWithResolvedSelection');
  });

  it('exposes named provider methods without a generic IPC escape hatch', async () => {
    const api = exposedApi();

    await api.listModelProviders({ limit: 25, offset: 0 });
    await api.getModelProvider('provider-1');
    await api.listModelProviderModels('provider-1');
    await api.testModelProviderConnection('provider-1');
    await api.setDefaultModelProvider('provider-1');
    await api.setModelProviderEnabled({ providerId: 'provider-1', enabled: false });

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_LIST,
      { limit: 25, offset: 0 },
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_GET,
      'provider-1',
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_LIST_MODELS,
      'provider-1',
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_TEST_CONNECTION,
      'provider-1',
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_SET_DEFAULT,
      'provider-1',
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_SET_ENABLED,
      { providerId: 'provider-1', enabled: false },
    );
    expect(api).not.toHaveProperty('invoke');
    expect(api).not.toHaveProperty('getModelProviderCredential');
  });

  it('forwards a transient credential only to draft validation and saves by token', async () => {
    const api = exposedApi();
    const draft = {
      name: 'MiMo',
      type: 'anthropic-compatible' as const,
      apiFormat: 'anthropic-messages' as const,
      baseUrlIntent: { mode: 'replace', value: 'https://example.invalid' },
      credential: SENTINEL_CREDENTIAL,
      defaultModelId: 'mimo-v2.5-pro',
    };

    await api.validateModelProviderDraft(draft);
    const preserveDraft = {
      providerId: 'provider-1',
      name: 'MiMo renamed',
      type: 'anthropic-compatible' as const,
      apiFormat: 'anthropic-messages' as const,
      baseUrlIntent: { mode: 'preserve_existing' as const },
      credential: null,
      defaultModelId: 'mimo-v2.5-pro',
    };
    await api.validateModelProviderDraft(preserveDraft);
    await api.createModelProvider({ validationToken: 'validation-token' });
    await api.updateModelProvider({
      providerId: 'provider-1',
      validationToken: 'validation-token-2',
    });
    await api.deleteModelProvider({
      providerId: 'provider-1',
      confirmCredentialDeletion: true,
    });

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT,
      draft,
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT,
      preserveDraft,
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_CREATE,
      { validationToken: 'validation-token' },
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_UPDATE,
      { providerId: 'provider-1', validationToken: 'validation-token-2' },
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_DELETE,
      { providerId: 'provider-1', confirmCredentialDeletion: true },
    );
  });

  it('forwards provider changes and removes the exact listener on disposal', () => {
    const listener = vi.fn();
    const unsubscribe = exposedApi().onModelProviderChanged(listener);
    const registration = electronMocks.on.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.MODEL_PROVIDER_CHANGED,
    );
    expect(registration).toBeDefined();
    const handler = registration?.[1] as (
      event: unknown,
      change: ModelProviderChangedEvent,
    ) => void;
    const change: ModelProviderChangedEvent = {
      type: 'tested',
      providerId: 'provider-1',
      changedAt: 1_700_000_000_000,
    };

    handler({}, change);
    unsubscribe();

    expect(listener).toHaveBeenCalledWith(change);
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_PROVIDER_CHANGED,
      handler,
    );
  });

  it('exposes only named policy and effective-selection methods', async () => {
    const api = exposedApi();
    const agentPolicy = {
      agentType: 'planner' as const,
      providerId: 'provider-1',
      modelId: 'model-1',
      quality: 'high' as const,
      speed: 'medium' as const,
      cost: null,
    };
    const projectPolicy = {
      projectId: 'project-1',
      agentType: 'coder' as const,
      providerId: 'provider-1',
      modelId: 'model-1',
    };

    await api.listAgentModelPolicies();
    await api.setAgentModelPolicy(agentPolicy);
    await api.deleteAgentModelPolicy({ agentType: 'planner' });
    await api.listProjectModelPolicies({ projectId: 'project-1' });
    await api.setProjectModelPolicy(projectPolicy);
    await api.deleteProjectModelPolicy({ projectId: 'project-1', agentType: 'coder' });
    await api.getEffectiveModelSelection({ taskId: 'task-1', agentType: 'reviewer' });
    await api.getProjectAiConfigurationSummary({ projectId: 'project-1' });
    await api.listTaskModelSwitchOptions({ taskId: 'task-1' });
    await api.setTaskModelOverride({
      taskId: 'task-1', providerId: 'provider-1', modelId: 'model-1',
    });
    await api.clearTaskModelOverride({ taskId: 'task-1' });

    expect(electronMocks.invoke).toHaveBeenCalledWith(IPC_CHANNELS.MODEL_POLICY_LIST_AGENT);
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_POLICY_SET_AGENT,
      agentPolicy,
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_POLICY_DELETE_AGENT,
      { agentType: 'planner' },
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_POLICY_LIST_PROJECT,
      { projectId: 'project-1' },
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_POLICY_SET_PROJECT,
      projectPolicy,
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_POLICY_DELETE_PROJECT,
      { projectId: 'project-1', agentType: 'coder' },
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_SELECTION_GET_EFFECTIVE,
      { taskId: 'task-1', agentType: 'reviewer' },
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      'project-ai:get-configuration-summary',
      { projectId: 'project-1' },
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      'model-selection:list-task-switch-options',
      { taskId: 'task-1' },
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_SELECTION_SET_TASK_OVERRIDE,
      { taskId: 'task-1', providerId: 'provider-1', modelId: 'model-1' },
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.MODEL_SELECTION_CLEAR_TASK_OVERRIDE,
      { taskId: 'task-1' },
    );
    expect(api).not.toHaveProperty('getProjectAiConfigurationForTask');
    expect(api).not.toHaveProperty('createDummyTaskForModelInspection');
  });

  it('strips forged main-process model selection fields before run IPC', async () => {
    const api = exposedApi();
    const malicious = {
      runId: 'run-1',
      taskId: 'task-1',
      projectId: 'project-1',
      projectKey: 'project-key',
      sessionKey: 'session-key',
      projectPath: 'C:\\projects\\fixture',
      prompt: 'hello',
      model: 'renderer-model-is-still-a-fallback-only',
      modelProviderId: 'attacker-provider',
      resolvedModelSelection: { providerId: 'attacker-provider' },
    } as never;

    await api.runPrompt(malicious);

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      {
        runId: 'run-1',
        taskId: 'task-1',
        projectId: 'project-1',
        projectKey: 'project-key',
        sessionKey: 'session-key',
        projectPath: 'C:\\projects\\fixture',
        prompt: 'hello',
        model: 'renderer-model-is-still-a-fallback-only',
      },
    );
    const serialized = JSON.stringify(electronMocks.invoke.mock.calls.at(-1));
    expect(serialized).not.toMatch(/modelProviderId|resolvedModelSelection|attacker-provider/);
  });
});

const SENTINEL_CREDENTIAL = 'renderer-transient-provider-secret';
