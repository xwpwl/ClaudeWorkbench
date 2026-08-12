import { describe, expect, it, vi } from 'vitest';
import type {
  ProviderConnectionResult,
  ProviderDraftInput,
} from '../../../shared/types/modelProviders';
import {
  ModelProviderService,
  ModelProviderServiceError,
  type CredentialCleanupJob,
  type CredentialStorePort,
  type ModelProviderPersistence,
  type ResolvedProviderListRequest,
  type StoredModelProvider,
  type StoredProviderModel,
} from '../ModelProviderService';

const success: ProviderConnectionResult = {
  ok: true,
  testedAt: 2_000,
  latencyMs: 42,
  discoveredModelIds: ['remote-model'],
};

const failure: ProviderConnectionResult = {
  ok: false,
  testedAt: 2_000,
  latencyMs: 42,
  discoveredModelIds: [],
  error: { type: 'invalid_key', statusCode: 401, message: 'API key was rejected.' },
};

const PATH_SENTINEL = 'private-gateway-path-token-sentinel';

const anthropicDraft: ProviderDraftInput = {
  name: 'MiMo',
  type: 'anthropic-compatible',
  apiFormat: 'anthropic-messages',
  baseUrlIntent: { mode: 'replace', value: 'https://mimo.example/anthropic/' },
  credential: 'credential-sentinel',
  defaultModelId: 'mimo-v2.5-pro',
};

function storedProvider(overrides: Partial<StoredModelProvider> = {}): StoredModelProvider {
  return {
    id: 'provider-existing',
    name: 'Existing',
    type: 'anthropic',
    apiFormat: 'anthropic-messages',
    runtimeType: 'claude-code',
    baseUrl: 'https://api.anthropic.com',
    credentialRef: 'safe-storage://v1/old',
    defaultModelId: 'claude-model',
    enabled: true,
    isDefault: false,
    capabilities: {
      supportsClaudeCode: true,
      supportsAgentWorkflow: true,
      supportsTools: true,
      supportsMCP: true,
      supportsStreaming: true,
      supportsVision: true,
    },
    health: { state: 'connected', lastTestedAt: 1_000, lastErrorType: null, latencyMs: 10 },
    metadata: {},
    createdAt: 500,
    updatedAt: 1_000,
    ...overrides,
  };
}

class FakePersistence implements ModelProviderPersistence {
  readonly providers = new Map<string, StoredModelProvider>();
  readonly models = new Map<string, StoredProviderModel[]>();
  readonly cleanupJobs = new Map<string, CredentialCleanupJob>();
  failCreate = false;
  failUpdate = false;
  failCompleteDelete = false;

  listProviders(input: ResolvedProviderListRequest) {
    const values = [...this.providers.values()]
      .filter((provider) => input.enabled === undefined || provider.enabled === input.enabled);
    return {
      items: values.slice(input.offset, input.offset + input.limit),
      total: values.length,
      limit: input.limit,
      offset: input.offset,
    };
  }

  getProvider(id: string) { return this.providers.get(id) ?? null; }

  createProvider(provider: StoredModelProvider, models: StoredProviderModel[]) {
    if (this.failCreate) throw new Error('database create failure credential-sentinel');
    this.providers.set(provider.id, structuredClone(provider));
    this.models.set(provider.id, structuredClone(models));
  }

  updateProvider(
    provider: StoredModelProvider,
    models: StoredProviderModel[],
    expectedProvider: StoredModelProvider,
    cleanupJob?: CredentialCleanupJob,
  ) {
    if (this.failUpdate) throw new Error('database update failure credential-sentinel');
    const current = this.providers.get(provider.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(expectedProvider)) {
      throw Object.assign(new Error('Provider changed after validation.'), {
        code: 'PROVIDER_STALE',
      });
    }
    this.providers.set(provider.id, structuredClone(provider));
    this.models.set(provider.id, structuredClone(models));
    if (cleanupJob) this.cleanupJobs.set(cleanupJob.id, structuredClone(cleanupJob));
  }

  updateProviderHealth(providerId: string, health: StoredModelProvider['health']) {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('missing provider');
    this.providers.set(providerId, { ...provider, health: { ...health }, updatedAt: health.lastTestedAt ?? provider.updatedAt });
  }

  listModels(providerId: string) { return structuredClone(this.models.get(providerId) ?? []); }

  upsertModels(providerId: string, models: StoredProviderModel[]) {
    this.models.set(providerId, structuredClone(models));
  }

  synchronizeDiscoveredModels(providerId: string, models: StoredProviderModel[]) {
    const provider = this.providers.get(providerId);
    const synchronized = new Map(
      (this.models.get(providerId) ?? []).map((model) => [model.modelId, structuredClone(model)]),
    );
    const currentIds = new Set(models.map(({ modelId }) => modelId));
    for (const [modelId, existing] of synchronized) {
      if (existing.source === 'discovered'
        && modelId !== provider?.defaultModelId
        && !currentIds.has(modelId)) {
        synchronized.delete(modelId);
      }
    }
    for (const model of models) {
      const existing = synchronized.get(model.modelId);
      synchronized.set(model.modelId, existing?.source === 'manual'
        ? { ...model, source: 'manual', createdAt: existing.createdAt }
        : structuredClone(model));
    }
    this.models.set(providerId, [...synchronized.values()]);
  }

  setDefaultProvider(providerId: string, updatedAt: number) {
    for (const [id, provider] of this.providers) {
      this.providers.set(id, { ...provider, isDefault: id === providerId, updatedAt });
    }
  }


  setProviderEnabled(providerId: string, enabled: boolean, updatedAt: number) {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('missing provider');
    this.providers.set(providerId, {
      ...provider,
      enabled,
      isDefault: enabled && provider.enabled ? provider.isDefault : false,
      updatedAt,
    });
  }

  beginProviderDeletion(job: CredentialCleanupJob) {
    const provider = this.providers.get(job.providerId);
    if (!provider) throw new Error('missing provider');
    this.providers.set(job.providerId, { ...provider, enabled: false, updatedAt: job.updatedAt });
    this.cleanupJobs.set(job.id, structuredClone(job));
  }

  enqueueCredentialCleanup(job: CredentialCleanupJob) {
    this.cleanupJobs.set(job.id, structuredClone(job));
  }

  completeCredentialCleanup(jobId: string, providerId: string | null) {
    if (this.failCompleteDelete) throw new Error('database delete failure');
    if (providerId) {
      this.providers.delete(providerId);
      this.models.delete(providerId);
    }
    this.cleanupJobs.delete(jobId);
  }

  listCredentialCleanupJobs() { return [...this.cleanupJobs.values()].map((job) => ({ ...job })); }

  markCredentialCleanupFailed(
    jobId: string,
    errorType: Exclude<CredentialCleanupJob['lastErrorType'], null>,
    updatedAt: number,
  ) {
    const job = this.cleanupJobs.get(jobId);
    if (!job) return;
    this.cleanupJobs.set(jobId, {
      ...job,
      attempts: job.attempts + 1,
      lastErrorType: errorType,
      lastAttemptAt: updatedAt,
      updatedAt,
    });
  }
}

function harness(options: {
  connection?: ProviderConnectionResult;
  active?: boolean;
  now?: () => number;
  randomId?: () => string;
  validateAgentDefault?: (providerId: string, modelId: string) => void;
} = {}) {
  const persistence = new FakePersistence();
  const secrets = new Map<string, string>([['safe-storage://v1/old', 'old-secret']]);
  let credentialNumber = 0;
  const credentialStore: CredentialStorePort = {
    create: vi.fn((secret: string) => {
      credentialNumber += 1;
      const reference = `safe-storage://v1/new-${credentialNumber}`;
      secrets.set(reference, secret);
      return reference;
    }),
    read: vi.fn((reference: string) => {
      const secret = secrets.get(reference);
      if (!secret) throw new Error('credential missing');
      return secret;
    }),
    delete: vi.fn((reference: string) => { secrets.delete(reference); }),
  };
  const tester = { test: vi.fn(async () => options.connection ?? success) };
  const ids = ['validation-1', 'provider-1', 'cleanup-1', 'validation-2', 'provider-2', 'cleanup-2'];
  let time = 1_000;
  const service = new ModelProviderService({
    persistence,
    credentialStore,
    connectionTester: tester,
    now: options.now ?? (() => time),
    randomId: options.randomId ?? (() => ids.shift() ?? 'generated-id'),
    isProviderInUse: () => options.active ?? false,
    validateAgentDefault: options.validateAgentDefault,
  });
  return {
    service,
    persistence,
    credentialStore,
    tester,
    secrets,
    advance(milliseconds: number) { time += milliseconds; },
  };
}

describe('ModelProviderService validation and create', () => {
  it('keeps a created non-root gateway path in main while returning only its origin', async () => {
    const test = harness();
    const validation = await test.service.validateDraft({
      ...anthropicDraft,
      baseUrlIntent: {
        mode: 'replace',
        value: `https://mimo.example/anthropic/${PATH_SENTINEL}`,
      },
    });

    const result = await test.service.createProvider({
      validationToken: validation.validationToken as string,
    });

    expect(test.persistence.getProvider('provider-1')?.baseUrl)
      .toBe(`https://mimo.example/anthropic/${PATH_SENTINEL}`);
    expect(result.baseUrl).toBe('https://mimo.example');
    expect(result.baseUrlPathRedacted).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PATH_SENTINEL);
  });

  it('performs a real test and returns a single-use validation token without echoing the credential', async () => {
    const test = harness();
    const result = await test.service.validateDraft(anthropicDraft);
    expect(test.tester.test).toHaveBeenCalledWith({
      providerType: 'anthropic-compatible',
      apiFormat: 'anthropic-messages',
      baseUrl: 'https://mimo.example/anthropic',
      apiKey: 'credential-sentinel',
      modelId: 'mimo-v2.5-pro',
    });
    expect(result).toEqual({ validationToken: 'validation-1', connection: success });
    expect(JSON.stringify(result)).not.toContain('credential-sentinel');
  });

  it('uses the official Anthropic endpoint when its Base URL is omitted', async () => {
    const test = harness();

    await test.service.validateDraft({
      ...anthropicDraft,
      type: 'anthropic',
      baseUrlIntent: { mode: 'replace', value: null },
    });

    expect(test.tester.test).toHaveBeenCalledWith(expect.objectContaining({
      apiFormat: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
    }));
  });

  it('does not issue a token or persist a failed configuration', async () => {
    const test = harness({ connection: failure });
    const result = await test.service.validateDraft(anthropicDraft);
    expect(result).toEqual({ validationToken: null, connection: failure });
    expect(test.persistence.providers.size).toBe(0);
    await expect(test.service.createProvider({ validationToken: 'missing' }))
      .rejects.toMatchObject({ code: 'INVALID_VALIDATION_TOKEN' });
  });

  it('creates an encrypted Provider only after successful validation', async () => {
    const test = harness();
    const validation = await test.service.validateDraft(anthropicDraft);
    const provider = await test.service.createProvider({
      validationToken: validation.validationToken as string,
    });
    expect(test.credentialStore.create).toHaveBeenCalledWith('credential-sentinel');
    expect(provider).toMatchObject({
      id: 'provider-1',
      name: 'MiMo',
      type: 'anthropic-compatible',
      runtimeType: 'claude-code',
      configured: true,
      defaultModelId: 'mimo-v2.5-pro',
      health: { state: 'connected', lastTestedAt: 2_000, latencyMs: 42 },
      capabilities: { supportsClaudeCode: true, supportsAgentWorkflow: true },
    });
    expect(provider.supportedUses).toContain('agent_task');
    expect(JSON.stringify(provider)).not.toContain('credentialRef');
    expect(JSON.stringify(provider)).not.toContain('credential-sentinel');
    expect(test.persistence.models.get('provider-1')?.map((model) => [model.modelId, model.source]))
      .toEqual([['mimo-v2.5-pro', 'manual'], ['remote-model', 'discovered']]);
  });

  it('marks OpenAI-compatible Providers as management-only despite forged capabilities', async () => {
    const test = harness();
    const validation = await test.service.validateDraft({
      ...anthropicDraft,
      name: 'DeepSeek',
      type: 'openai-compatible',
      apiFormat: 'openai-chat-completions',
      capabilities: {
        supportsClaudeCode: true,
        supportsAgentWorkflow: true,
        supportsMCP: true,
      },
    });
    const provider = await test.service.createProvider({
      validationToken: validation.validationToken as string,
    });
    expect(provider.runtimeType).toBe('none');
    expect(provider.capabilities).toMatchObject({
      supportsClaudeCode: false,
      supportsAgentWorkflow: false,
      supportsMCP: false,
    });
    expect(provider.supportedUses).not.toContain('agent_task');
  });

  it('consumes validation tokens exactly once', async () => {
    const test = harness();
    const validation = await test.service.validateDraft(anthropicDraft);
    await test.service.createProvider({ validationToken: validation.validationToken as string });
    await expect(test.service.createProvider({ validationToken: validation.validationToken as string }))
      .rejects.toMatchObject({ code: 'INVALID_VALIDATION_TOKEN' });
  });

  it('expires validation tokens after five minutes', async () => {
    const test = harness();
    const validation = await test.service.validateDraft(anthropicDraft);
    test.advance(300_001);
    await expect(test.service.createProvider({ validationToken: validation.validationToken as string }))
      .rejects.toMatchObject({ code: 'EXPIRED_VALIDATION_TOKEN' });
  });

  it('purges an abandoned validation secret when its five-minute timer expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const test = harness({ now: Date.now });
      const validation = await test.service.validateDraft(anthropicDraft);

      await vi.advanceTimersByTimeAsync(300_001);

      await expect(test.service.createProvider({
        validationToken: validation.validationToken as string,
      })).rejects.toMatchObject({ code: 'INVALID_VALIDATION_TOKEN' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds pending validation secrets and evicts the oldest token', async () => {
    let sequence = 0;
    const test = harness({ randomId: () => `generated-${sequence += 1}` });
    const tokens: string[] = [];
    for (let index = 0; index < 129; index += 1) {
      const validation = await test.service.validateDraft(anthropicDraft);
      tokens.push(validation.validationToken as string);
    }

    await expect(test.service.createProvider({ validationToken: tokens[0] }))
      .rejects.toMatchObject({ code: 'INVALID_VALIDATION_TOKEN' });
    await expect(test.service.createProvider({ validationToken: tokens.at(-1) as string }))
      .resolves.toMatchObject({ name: 'MiMo' });
  });

  it('deletes a newly written credential if database create fails', async () => {
    const test = harness();
    test.persistence.failCreate = true;
    const validation = await test.service.validateDraft(anthropicDraft);
    await expect(test.service.createProvider({ validationToken: validation.validationToken as string }))
      .rejects.toThrow('Provider could not be created.');
    expect(test.credentialStore.delete).toHaveBeenCalledWith('safe-storage://v1/new-1');
    expect(test.secrets.has('safe-storage://v1/new-1')).toBe(false);
  });

  it('persists a cleanup tombstone if rollback cannot delete a newly written credential', async () => {
    const test = harness();
    test.persistence.failCreate = true;
    vi.mocked(test.credentialStore.delete).mockImplementationOnce(() => {
      throw new Error('credential vault unavailable');
    });
    const validation = await test.service.validateDraft(anthropicDraft);

    await expect(test.service.createProvider({
      validationToken: validation.validationToken as string,
    })).rejects.toThrow('Provider could not be created.');

    expect([...test.persistence.cleanupJobs.values()]).toEqual([
      expect.objectContaining({
        providerId: null,
        credentialRef: 'safe-storage://v1/new-1',
        attempts: 0,
      }),
    ]);
  });

  it.each([
    [{ ...anthropicDraft, name: '' }, 'name'],
    [{ ...anthropicDraft, name: 'x'.repeat(81) }, 'name'],
    [{ ...anthropicDraft, name: 'MiMo\nforged-log-entry' }, 'name'],
    [{ ...anthropicDraft, defaultModelId: '' }, 'model'],
    [{ ...anthropicDraft, credential: '' }, 'credential'],
    [{
      ...anthropicDraft,
      type: 'openai-compatible' as const,
      apiFormat: 'openai-chat-completions' as const,
      baseUrlIntent: { mode: 'replace' as const, value: null },
    }, 'Base URL'],
  ])('rejects invalid draft fields before network access', async (draft, message) => {
    const test = harness();
    await expect(test.service.validateDraft(draft)).rejects.toThrow(new RegExp(message, 'iu'));
    expect(test.tester.test).not.toHaveBeenCalled();
  });
});

describe('ModelProviderService update, test, and delete', () => {
  it('does not preserve default status when an update would make the Provider management-only', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider({ isDefault: true }));
    const validation = await test.service.validateDraft({
      providerId: 'provider-existing',
      name: 'DeepSeek',
      type: 'openai-compatible',
      apiFormat: 'openai-chat-completions',
      baseUrlIntent: { mode: 'replace', value: 'https://api.deepseek.example/v1' },
      credential: 'deepseek-secret',
      defaultModelId: 'deepseek-chat',
      capabilities: {
        supportsClaudeCode: true,
        supportsAgentWorkflow: true,
      },
    });

    await expect(test.service.updateProvider({
      providerId: 'provider-existing',
      validationToken: validation.validationToken as string,
    })).rejects.toMatchObject({ code: 'PROVIDER_RUNTIME_NOT_RUNNABLE' });
    expect(test.persistence.getProvider('provider-existing')).toMatchObject({
      type: 'anthropic',
      apiFormat: 'anthropic-messages',
      runtimeType: 'claude-code',
      isDefault: true,
    });
    expect(test.credentialStore.create).not.toHaveBeenCalled();
  });

  it('rejects a same-millisecond stale preserve token without pairing the old endpoint with the new credential', async () => {
    const test = harness();
    const endpointA = 'https://gateway.example/tenant-a';
    const endpointB = 'https://gateway.example/tenant-b';
    test.persistence.providers.set('provider-existing', storedProvider({
      type: 'anthropic-compatible',
      baseUrl: endpointA,
      updatedAt: 1_000,
    }));

    const stale = await test.service.validateDraft({
      providerId: 'provider-existing',
      name: 'Provider A edited',
      type: 'anthropic-compatible',
      apiFormat: 'anthropic-messages',
      baseUrlIntent: { mode: 'preserve_existing' },
      credential: null,
      defaultModelId: 'claude-model',
    });
    const fresh = await test.service.validateDraft({
      providerId: 'provider-existing',
      name: 'Provider B',
      type: 'anthropic-compatible',
      apiFormat: 'anthropic-messages',
      baseUrlIntent: { mode: 'replace', value: endpointB },
      credential: 'secret-b',
      defaultModelId: 'claude-model',
    });
    await test.service.updateProvider({
      providerId: 'provider-existing',
      validationToken: fresh.validationToken as string,
    });

    let staleError: unknown;
    try {
      await test.service.updateProvider({
        providerId: 'provider-existing',
        validationToken: stale.validationToken as string,
      });
    } catch (error) {
      staleError = error;
    }

    expect(staleError).toMatchObject({ code: 'STALE_PROVIDER' });
    expect(test.persistence.getProvider('provider-existing')).toMatchObject({
      name: 'Provider B',
      baseUrl: endpointB,
      credentialRef: 'safe-storage://v1/new-1',
    });
    expect(test.secrets.get('safe-storage://v1/new-1')).toBe('secret-b');
    expect(test.tester.test).toHaveBeenNthCalledWith(1, expect.objectContaining({
      baseUrl: endpointA,
      apiKey: 'old-secret',
    }));
    expect(test.tester.test).toHaveBeenNthCalledWith(2, expect.objectContaining({
      baseUrl: endpointB,
      apiKey: 'secret-b',
    }));
    expect(test.tester.test).toHaveBeenCalledTimes(2);
    await expect(test.service.updateProvider({
      providerId: 'provider-existing',
      validationToken: stale.validationToken as string,
    })).rejects.toMatchObject({ code: 'INVALID_VALIDATION_TOKEN' });
  });

  it('rejects a stale replacement token and deletes its newly-created credential', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider({
      type: 'anthropic-compatible',
      baseUrl: 'https://gateway.example/tenant-a',
      updatedAt: 1_000,
    }));
    const stale = await test.service.validateDraft({
      providerId: 'provider-existing', name: 'Provider C', type: 'anthropic-compatible',
      apiFormat: 'anthropic-messages',
      baseUrlIntent: { mode: 'replace', value: 'https://other.example/tenant-c' },
      credential: 'secret-c', defaultModelId: 'claude-model',
    });
    const fresh = await test.service.validateDraft({
      providerId: 'provider-existing', name: 'Provider B', type: 'anthropic-compatible',
      apiFormat: 'anthropic-messages',
      baseUrlIntent: { mode: 'replace', value: 'https://new.example/tenant-b' },
      credential: 'secret-b', defaultModelId: 'claude-model',
    });
    await test.service.updateProvider({
      providerId: 'provider-existing', validationToken: fresh.validationToken as string,
    });

    await expect(test.service.updateProvider({
      providerId: 'provider-existing', validationToken: stale.validationToken as string,
    })).rejects.toMatchObject({ code: 'STALE_PROVIDER' });

    expect(test.persistence.getProvider('provider-existing')).toMatchObject({
      name: 'Provider B',
      baseUrl: 'https://new.example/tenant-b',
      credentialRef: 'safe-storage://v1/new-1',
    });
    expect(test.credentialStore.delete).toHaveBeenCalledWith('safe-storage://v1/new-2');
    expect(test.secrets.has('safe-storage://v1/new-2')).toBe(false);
  });

  it('enqueues cleanup for a stale replacement credential when immediate deletion fails', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider({ updatedAt: 1_000 }));
    const stale = await test.service.validateDraft({
      ...anthropicDraft,
      providerId: 'provider-existing',
      type: 'anthropic',
      baseUrlIntent: { mode: 'replace', value: 'https://api.anthropic.com/path-c' },
      credential: 'secret-c',
      defaultModelId: 'claude-model',
    });
    const fresh = await test.service.validateDraft({
      ...anthropicDraft,
      providerId: 'provider-existing',
      name: 'Provider B',
      type: 'anthropic',
      baseUrlIntent: { mode: 'replace', value: 'https://api.anthropic.com/path-b' },
      credential: 'secret-b',
      defaultModelId: 'claude-model',
    });
    await test.service.updateProvider({
      providerId: 'provider-existing', validationToken: fresh.validationToken as string,
    });
    vi.mocked(test.credentialStore.delete).mockImplementationOnce(() => {
      throw new Error('vault unavailable');
    });

    await expect(test.service.updateProvider({
      providerId: 'provider-existing', validationToken: stale.validationToken as string,
    })).rejects.toMatchObject({ code: 'STALE_PROVIDER' });

    expect([...test.persistence.cleanupJobs.values()]).toContainEqual(expect.objectContaining({
      providerId: null,
      credentialRef: 'safe-storage://v1/new-2',
      attempts: 0,
    }));
    expect(test.persistence.getProvider('provider-existing')).toMatchObject({
      name: 'Provider B', credentialRef: 'safe-storage://v1/new-1',
    });
  });

  it('preserves a hidden existing Base URL path while validating and updating other fields', async () => {
    const test = harness();
    const rawEndpoint = `https://gateway.example/anthropic/${PATH_SENTINEL}`;
    test.persistence.providers.set('provider-existing', storedProvider({
      type: 'anthropic-compatible',
      baseUrl: rawEndpoint,
    }));

    const validation = await test.service.validateDraft({
      providerId: 'provider-existing',
      name: 'Renamed without endpoint replacement',
      type: 'anthropic-compatible',
      apiFormat: 'anthropic-messages',
      baseUrlIntent: { mode: 'preserve_existing' },
      credential: null,
      defaultModelId: 'claude-model',
    } as ProviderDraftInput);
    expect(test.tester.test).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: rawEndpoint,
      apiKey: 'old-secret',
    }));

    const result = await test.service.updateProvider({
      providerId: 'provider-existing',
      validationToken: validation.validationToken as string,
    });

    expect(test.persistence.getProvider('provider-existing')?.baseUrl).toBe(rawEndpoint);
    expect(result).toMatchObject({
      name: 'Renamed without endpoint replacement',
      baseUrl: 'https://gateway.example',
      baseUrlPathRedacted: true,
    });
    expect(JSON.stringify(result)).not.toContain(PATH_SENTINEL);
  });

  it('replaces a hidden path only after explicit Base URL replacement intent', async () => {
    const test = harness();
    const replacement = 'https://gateway.example/anthropic/replacement';
    test.persistence.providers.set('provider-existing', storedProvider({
      type: 'anthropic-compatible',
      baseUrl: `https://gateway.example/anthropic/${PATH_SENTINEL}`,
    }));

    const validation = await test.service.validateDraft({
      providerId: 'provider-existing',
      name: 'Explicit replacement',
      type: 'anthropic-compatible',
      apiFormat: 'anthropic-messages',
      baseUrlIntent: { mode: 'replace', value: replacement },
      credential: null,
      defaultModelId: 'claude-model',
    } as ProviderDraftInput);
    await test.service.updateProvider({
      providerId: 'provider-existing',
      validationToken: validation.validationToken as string,
    });

    expect(test.tester.test).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: replacement }));
    expect(test.persistence.getProvider('provider-existing')?.baseUrl).toBe(replacement);
  });

  it('rejects preserve intent for create and keeps preserve tokens bound to their Provider', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider({
      baseUrl: `https://gateway.example/${PATH_SENTINEL}`,
    }));
    test.persistence.providers.set('provider-other', storedProvider({ id: 'provider-other' }));

    await expect(test.service.validateDraft({
      name: 'Forged create preserve',
      type: 'anthropic-compatible',
      apiFormat: 'anthropic-messages',
      baseUrlIntent: { mode: 'preserve_existing' },
      credential: 'new-secret',
      defaultModelId: null,
    } as ProviderDraftInput)).rejects.toMatchObject({ code: 'INVALID_DRAFT' });

    const validation = await test.service.validateDraft({
      providerId: 'provider-existing',
      name: 'Existing',
      type: 'anthropic',
      apiFormat: 'anthropic-messages',
      baseUrlIntent: { mode: 'preserve_existing' },
      credential: null,
      defaultModelId: 'claude-model',
    } as ProviderDraftInput);
    await expect(test.service.updateProvider({
      providerId: 'provider-other',
      validationToken: validation.validationToken as string,
    })).rejects.toMatchObject({ code: 'TOKEN_PROVIDER_MISMATCH' });
  });

  it('keeps saved health unchanged when a successful edit validation is abandoned', async () => {
    const test = harness();
    const originalHealth: StoredModelProvider['health'] = {
      state: 'error',
      lastTestedAt: 900,
      lastErrorType: 'timeout',
      latencyMs: null,
    };
    test.persistence.providers.set('provider-existing', storedProvider({ health: originalHealth }));

    await test.service.validateDraft({
      ...anthropicDraft,
      providerId: 'provider-existing',
      type: 'anthropic',
      baseUrlIntent: { mode: 'replace', value: 'https://api.anthropic.com' },
      credential: null,
      defaultModelId: 'claude-model',
    });

    expect(test.persistence.getProvider('provider-existing')?.health).toEqual(originalHealth);
  });

  it('keeps saved health unchanged when an edit draft connection test fails', async () => {
    const test = harness({ connection: failure });
    const originalHealth = storedProvider().health;
    test.persistence.providers.set('provider-existing', storedProvider());

    await test.service.validateDraft({
      ...anthropicDraft,
      providerId: 'provider-existing',
      type: 'anthropic',
      baseUrlIntent: { mode: 'replace', value: 'https://api.anthropic.com' },
      credential: null,
      defaultModelId: 'claude-model',
    });

    expect(test.persistence.getProvider('provider-existing')?.health).toEqual(originalHealth);
  });

  it('reuses the stored credential for same-origin updates without revealing it', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider());
    const result = await test.service.validateDraft({
      ...anthropicDraft,
      providerId: 'provider-existing',
      name: 'Renamed',
      type: 'anthropic',
      baseUrlIntent: { mode: 'replace', value: 'https://api.anthropic.com/' },
      credential: null,
      defaultModelId: 'claude-model',
    });
    expect(test.credentialStore.read).toHaveBeenCalledWith('safe-storage://v1/old');
    expect(JSON.stringify(result)).not.toContain('old-secret');
    await test.service.updateProvider({
      providerId: 'provider-existing',
      validationToken: result.validationToken as string,
    });
    expect(test.credentialStore.create).not.toHaveBeenCalled();
    expect(test.persistence.getProvider('provider-existing')?.name).toBe('Renamed');
  });

  it('preserves existing model records when an edit discovers only a subset', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider());
    test.persistence.models.set('provider-existing', [{
      providerId: 'provider-existing',
      modelId: 'policy-model',
      displayName: 'Policy model',
      source: 'manual',
      createdAt: 500,
      updatedAt: 500,
    }]);

    const validation = await test.service.validateDraft({
      ...anthropicDraft,
      providerId: 'provider-existing',
      type: 'anthropic',
      baseUrlIntent: { mode: 'replace', value: 'https://api.anthropic.com' },
      credential: null,
      defaultModelId: 'claude-model',
    });
    await test.service.updateProvider({
      providerId: 'provider-existing',
      validationToken: validation.validationToken as string,
    });

    expect(test.persistence.models.get('provider-existing')).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'policy-model', source: 'manual', createdAt: 500 }),
      expect.objectContaining({ modelId: 'remote-model', source: 'discovered' }),
    ]));
  });

  it('requires credential replacement when the Provider origin changes', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider());
    await expect(test.service.validateDraft({
      ...anthropicDraft,
      providerId: 'provider-existing',
      type: 'anthropic',
      baseUrlIntent: { mode: 'replace', value: 'https://new-origin.example' },
      credential: null,
    })).rejects.toMatchObject({ code: 'CREDENTIAL_REENTRY_REQUIRED' });
    expect(test.tester.test).not.toHaveBeenCalled();
  });

  it('persists a replacement before deleting the old credential', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider());
    const validation = await test.service.validateDraft({
      ...anthropicDraft,
      providerId: 'provider-existing',
      name: 'Replaced',
      type: 'anthropic',
      baseUrlIntent: { mode: 'replace', value: 'https://api.anthropic.com' },
    });
    await test.service.updateProvider({
      providerId: 'provider-existing',
      validationToken: validation.validationToken as string,
    });
    expect(test.persistence.getProvider('provider-existing')?.credentialRef)
      .toBe('safe-storage://v1/new-1');
    expect(test.credentialStore.delete).toHaveBeenCalledWith('safe-storage://v1/old');
  });

  it('removes the new credential and preserves the old record if update persistence fails', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider());
    test.persistence.failUpdate = true;
    const validation = await test.service.validateDraft({
      ...anthropicDraft,
      providerId: 'provider-existing',
      type: 'anthropic',
      baseUrlIntent: { mode: 'replace', value: 'https://api.anthropic.com' },
    });
    await expect(test.service.updateProvider({
      providerId: 'provider-existing',
      validationToken: validation.validationToken as string,
    })).rejects.toThrow('Provider could not be updated.');
    expect(test.credentialStore.delete).toHaveBeenCalledWith('safe-storage://v1/new-1');
    expect(test.persistence.getProvider('provider-existing')?.credentialRef)
      .toBe('safe-storage://v1/old');
  });

  it('persists a cleanup tombstone if failed update rollback cannot delete the replacement', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider());
    test.persistence.failUpdate = true;
    vi.mocked(test.credentialStore.delete).mockImplementationOnce(() => {
      throw new Error('credential vault unavailable');
    });
    const validation = await test.service.validateDraft({
      ...anthropicDraft,
      providerId: 'provider-existing',
      type: 'anthropic',
      baseUrlIntent: { mode: 'replace', value: 'https://api.anthropic.com' },
    });

    await expect(test.service.updateProvider({
      providerId: 'provider-existing',
      validationToken: validation.validationToken as string,
    })).rejects.toThrow('Provider could not be updated.');

    expect([...test.persistence.cleanupJobs.values()]).toEqual([
      expect.objectContaining({
        providerId: null,
        credentialRef: 'safe-storage://v1/new-1',
        attempts: 0,
      }),
    ]);
  });

  it('binds update tokens to the validated Provider identity', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider());
    const validation = await test.service.validateDraft({
      ...anthropicDraft,
      providerId: 'provider-existing',
      type: 'anthropic',
      baseUrlIntent: { mode: 'replace', value: 'https://api.anthropic.com' },
    });
    await expect(test.service.updateProvider({
      providerId: 'provider-other',
      validationToken: validation.validationToken as string,
    })).rejects.toMatchObject({ code: 'TOKEN_PROVIDER_MISMATCH' });
  });

  it('tests a saved Provider and persists successful health and discovered models', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider());
    test.persistence.models.set('provider-existing', []);
    const result = await test.service.testConnection('provider-existing');
    expect(result).toEqual(success);
    expect(test.persistence.getProvider('provider-existing')?.health).toEqual({
      state: 'connected', lastTestedAt: 2_000, lastErrorType: null, latencyMs: 42,
    });
    expect(test.persistence.models.get('provider-existing')?.some(
      (model) => model.modelId === 'remote-model' && model.source === 'discovered',
    )).toBe(true);
  });

  it('refreshes the saved discovered model set instead of retaining stale entries', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider());
    test.persistence.models.set('provider-existing', [
      {
        providerId: 'provider-existing', modelId: 'claude-model', displayName: null,
        source: 'manual', createdAt: 500, updatedAt: 500,
      },
      {
        providerId: 'provider-existing', modelId: 'manual-model', displayName: 'Manual',
        source: 'manual', createdAt: 500, updatedAt: 500,
      },
      {
        providerId: 'provider-existing', modelId: 'stale-model', displayName: null,
        source: 'discovered', createdAt: 500, updatedAt: 500,
      },
    ]);

    await test.service.testConnection('provider-existing');

    expect(test.persistence.listModels('provider-existing').map((model) => model.modelId).sort())
      .toEqual(['claude-model', 'manual-model', 'remote-model']);
  });

  it('removes stale discovered models when a successful refresh returns an empty list', async () => {
    const test = harness({
      connection: { ok: true, testedAt: 2_000, latencyMs: 42, discoveredModelIds: [] },
    });
    test.persistence.providers.set('provider-existing', storedProvider());
    test.persistence.models.set('provider-existing', [
      {
        providerId: 'provider-existing', modelId: 'claude-model', displayName: null,
        source: 'manual', createdAt: 500, updatedAt: 500,
      },
      {
        providerId: 'provider-existing', modelId: 'stale-model', displayName: null,
        source: 'discovered', createdAt: 500, updatedAt: 500,
      },
    ]);

    await test.service.testConnection('provider-existing');

    expect(test.persistence.listModels('provider-existing').map((model) => model.modelId))
      .toEqual(['claude-model']);
  });

  it('persists only a categorized error in health', async () => {
    const test = harness({ connection: failure });
    test.persistence.providers.set('provider-existing', storedProvider());
    await test.service.testConnection('provider-existing');
    expect(test.persistence.getProvider('provider-existing')?.health).toEqual({
      state: 'error', lastTestedAt: 2_000, lastErrorType: 'invalid_key', latencyMs: 42,
    });
    expect(JSON.stringify(test.persistence.getProvider('provider-existing'))).not.toContain(
      'API key was rejected',
    );
  });

  it('requires explicit credential deletion confirmation', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider());
    await expect(test.service.deleteProvider({
      providerId: 'provider-existing',
      confirmCredentialDeletion: false,
    })).rejects.toMatchObject({ code: 'DELETE_CONFIRMATION_REQUIRED' });
    expect(test.credentialStore.delete).not.toHaveBeenCalled();
  });

  it('disables, cleans the credential, then completes Provider deletion', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider());
    await test.service.deleteProvider({
      providerId: 'provider-existing',
      confirmCredentialDeletion: true,
    });
    expect(test.credentialStore.delete).toHaveBeenCalledWith('safe-storage://v1/old');
    expect(test.persistence.getProvider('provider-existing')).toBeNull();
    expect(test.persistence.cleanupJobs.size).toBe(0);
  });

  it('retains a disabled Provider and tombstone when credential deletion fails', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider());
    vi.mocked(test.credentialStore.delete).mockImplementationOnce(() => {
      throw new Error('OS secret failure credential-sentinel');
    });
    await expect(test.service.deleteProvider({
      providerId: 'provider-existing',
      confirmCredentialDeletion: true,
    })).rejects.toThrow('Credential cleanup is pending.');
    expect(test.persistence.getProvider('provider-existing')?.enabled).toBe(false);
    const job = [...test.persistence.cleanupJobs.values()][0];
    expect(job).toMatchObject({ attempts: 1, lastErrorType: 'io' });
    expect(JSON.stringify(job)).not.toContain('credential-sentinel');
  });

  it('retries cleanup tombstones idempotently on startup', async () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider({ enabled: false }));
    test.persistence.cleanupJobs.set('cleanup-existing', {
      id: 'cleanup-existing',
      providerId: 'provider-existing',
      credentialRef: 'safe-storage://v1/old',
      attempts: 1,
      nextAttemptAt: null,
      lastAttemptAt: 500,
      lastErrorType: 'io',
      createdAt: 500,
      updatedAt: 500,
    });
    await test.service.retryCredentialCleanup();
    expect(test.persistence.getProvider('provider-existing')).toBeNull();
    expect(test.persistence.cleanupJobs.size).toBe(0);
  });

  it.each(['validate', 'delete'] as const)('blocks %s while the Provider is used by an active task', async (operation) => {
    const test = harness({ active: true });
    test.persistence.providers.set('provider-existing', storedProvider());
    const action = operation === 'validate'
      ? test.service.validateDraft({
        ...anthropicDraft,
        providerId: 'provider-existing',
        type: 'anthropic',
        baseUrlIntent: { mode: 'replace', value: 'https://api.anthropic.com' },
      })
      : test.service.deleteProvider({
        providerId: 'provider-existing',
        confirmCredentialDeletion: true,
      });
    await expect(action).rejects.toMatchObject({ code: 'PROVIDER_IN_USE' });
  });
});

describe('ModelProviderService queries', () => {
  it('redacts a stored path from list, get, default, and enable public replies', () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider({
      baseUrl: `https://gateway.example/anthropic/${PATH_SENTINEL}`,
      enabled: true,
    }));

    const results = [
      test.service.listProviders({ limit: 10, offset: 0 }).items[0],
      test.service.getProvider('provider-existing'),
      test.service.setDefaultProvider('provider-existing'),
      test.service.setProviderEnabled({ providerId: 'provider-existing', enabled: false }),
    ];

    for (const result of results) {
      expect(result.baseUrl).toBe('https://gateway.example');
      expect(result.baseUrlPathRedacted).toBe(true);
    }
    expect(JSON.stringify(results)).not.toContain(PATH_SENTINEL);
  });

  it('returns paginated public Providers and never returns credential references', () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider());
    const page = test.service.listProviders({ limit: 10, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.items[0].configured).toBe(true);
    expect(JSON.stringify(page)).not.toContain('credentialRef');
    expect(JSON.stringify(page)).not.toContain('safe-storage://');
  });

  it('bounds pagination and rejects invalid values', () => {
    const test = harness();
    expect(test.service.listProviders({}).limit).toBe(50);
    expect(() => test.service.listProviders({ limit: 101 })).toThrow(/limit/iu);
    expect(() => test.service.listProviders({ offset: -1 })).toThrow(/offset/iu);
  });

  it('sets one existing enabled Provider as the global default', () => {
    const validateAgentDefault = vi.fn();
    const test = harness({ validateAgentDefault });
    test.persistence.providers.set('provider-existing', storedProvider());
    test.persistence.providers.set('provider-two', storedProvider({ id: 'provider-two', isDefault: true }));
    test.service.setDefaultProvider('provider-existing');
    expect(test.persistence.getProvider('provider-existing')?.isDefault).toBe(true);
    expect(test.persistence.getProvider('provider-two')?.isDefault).toBe(false);
    expect(validateAgentDefault).toHaveBeenCalledWith('provider-existing', 'claude-model');
  });

  it('refuses to set a disabled Provider as default', () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider({ enabled: false }));
    expect(() => test.service.setDefaultProvider('provider-existing'))
      .toThrowError(ModelProviderServiceError);
  });

  it('does not make an OpenAI-compatible management-only Provider the Claude runtime default', () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider({
      type: 'openai-compatible',
      apiFormat: 'openai-chat-completions',
      runtimeType: 'none',
      capabilities: {
        supportsClaudeCode: false,
        supportsAgentWorkflow: false,
        supportsTools: false,
        supportsMCP: false,
        supportsStreaming: true,
        supportsVision: false,
      },
    }));

    expect(() => test.service.setDefaultProvider('provider-existing'))
      .toThrowError(expect.objectContaining({
        code: 'PROVIDER_RUNTIME_NOT_RUNNABLE',
        message: '当前 Provider 可以管理和测试，但尚不能用于 Claude Code Agent。请选择支持 Claude Code Runtime 的 Provider。',
      }));
    expect(test.persistence.getProvider('provider-existing')?.isDefault).toBe(false);
  });

  it('re-derives public runtime facts and marks a legacy invalid default for reconfiguration', () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider({
      type: 'openai-compatible',
      apiFormat: 'openai-chat-completions',
      runtimeType: 'claude-code',
      isDefault: true,
      capabilities: {
        supportsClaudeCode: true,
        supportsAgentWorkflow: true,
        supportsTools: true,
        supportsMCP: true,
        supportsStreaming: true,
        supportsVision: true,
      },
    }));

    expect(test.service.getProvider('provider-existing')).toMatchObject({
      runtimeType: 'none',
      isDefault: true,
      agentModelStatus: 'needs_reconfiguration',
      capabilities: {
        supportsClaudeCode: false,
        supportsAgentWorkflow: false,
      },
    });
    expect(test.persistence.getProvider('provider-existing')?.credentialRef)
      .toBe('safe-storage://v1/old');
  });

  it('disables a default Provider and clears its default status atomically', () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider({ isDefault: true }));
    const result = test.service.setProviderEnabled({ providerId: 'provider-existing', enabled: false });
    expect(result).toMatchObject({ enabled: false, isDefault: false });
    expect(test.persistence.getProvider('provider-existing')).toMatchObject({
      enabled: false,
      isDefault: false,
    });
  });

  it('re-enables a configured Provider without silently making it default', () => {
    const test = harness();
    test.persistence.providers.set('provider-existing', storedProvider({ enabled: false, isDefault: false }));
    const result = test.service.setProviderEnabled({ providerId: 'provider-existing', enabled: true });
    expect(result).toMatchObject({ enabled: true, isDefault: false, configured: true });
  });

  it('blocks disabling a Provider used by an active task', () => {
    const test = harness({ active: true });
    test.persistence.providers.set('provider-existing', storedProvider());
    expect(() => test.service.setProviderEnabled({
      providerId: 'provider-existing', enabled: false,
    })).toThrowError(expect.objectContaining({ code: 'PROVIDER_IN_USE' }));
    expect(test.persistence.getProvider('provider-existing')?.enabled).toBe(true);
  });
});
