import { randomUUID } from 'node:crypto';
import type {
  AgentRuntimeType,
  CreateProviderInput,
  DeleteProviderInput,
  ModelApiFormat,
  ModelProviderListRequest,
  ModelProviderPage,
  ModelProviderType,
  ProviderCapabilities,
  ProviderConnectionResult,
  ProviderDraftInput,
  ProviderHealth,
  ProviderModel,
  ProviderValidationResult,
  PublicModelProvider,
  SetProviderEnabledInput,
  UpdateProviderInput,
} from '../../shared/types/modelProviders';
import { toPublicModelProvider } from '../../shared/types/modelProviders';
import { PROVIDER_RUNTIME_NOT_RUNNABLE_MESSAGE } from '../../shared/types/modelProviders';
import { ProviderCapabilityResolver } from './ProviderCapabilityResolver';
import {
  normalizeProviderBaseUrl,
  type ProviderConnectionTestInput,
} from './ProviderConnectionTester';

const VALIDATION_TOKEN_TTL_MS = 5 * 60 * 1_000;
const MAX_PENDING_VALIDATION_TOKENS = 128;
const MAX_PROVIDER_NAME_LENGTH = 80;
const MAX_MODEL_ID_LENGTH = 256;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const OFFICIAL_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export interface StoredModelProvider {
  id: string;
  name: string;
  type: ModelProviderType;
  apiFormat: ModelApiFormat;
  runtimeType: AgentRuntimeType;
  baseUrl: string;
  credentialRef: string | null;
  defaultModelId: string | null;
  enabled: boolean;
  isDefault: boolean;
  capabilities: ProviderCapabilities;
  health: ProviderHealth;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type StoredProviderModel = ProviderModel;

export interface CredentialCleanupJob {
  id: string;
  providerId: string | null;
  credentialRef: string;
  attempts: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  lastErrorType: 'not_found' | 'io' | 'permission' | 'invalid_ref' | 'unknown' | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResolvedProviderListRequest {
  limit: number;
  offset: number;
  enabled?: boolean;
}

export interface ModelProviderPersistence {
  listProviders(input: ResolvedProviderListRequest): {
    items: StoredModelProvider[];
    total: number;
    limit: number;
    offset: number;
  };
  getProvider(providerId: string): StoredModelProvider | null;
  createProvider(provider: StoredModelProvider, models: StoredProviderModel[]): void;
  updateProvider(
    provider: StoredModelProvider,
    models: StoredProviderModel[],
    expectedProvider: StoredModelProvider,
    cleanupJob?: CredentialCleanupJob,
  ): void;
  updateProviderHealth(providerId: string, health: ProviderHealth): void;
  listModels(providerId: string): StoredProviderModel[];
  upsertModels(providerId: string, models: StoredProviderModel[]): void;
  synchronizeDiscoveredModels(providerId: string, models: StoredProviderModel[]): void;
  setDefaultProvider(providerId: string, updatedAt: number): void;
  setProviderEnabled(providerId: string, enabled: boolean, updatedAt: number): void;
  beginProviderDeletion(job: CredentialCleanupJob): void;
  enqueueCredentialCleanup(job: CredentialCleanupJob): void;
  completeCredentialCleanup(jobId: string, providerId: string | null): void;
  listCredentialCleanupJobs(): CredentialCleanupJob[];
  markCredentialCleanupFailed(
    jobId: string,
    errorType: Exclude<CredentialCleanupJob['lastErrorType'], null>,
    updatedAt: number,
  ): void;
}

export interface CredentialStorePort {
  create(secret: string): string;
  read(reference: string): string;
  delete(reference: string): void;
}

export interface ProviderConnectionTesterPort {
  test(input: ProviderConnectionTestInput): Promise<ProviderConnectionResult>;
}

export type ModelProviderServiceErrorCode =
  | 'INVALID_DRAFT'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_DISABLED'
  | 'PROVIDER_IN_USE'
  | 'INVALID_VALIDATION_TOKEN'
  | 'EXPIRED_VALIDATION_TOKEN'
  | 'TOKEN_PROVIDER_MISMATCH'
  | 'STALE_PROVIDER'
  | 'CREDENTIAL_REENTRY_REQUIRED'
  | 'DELETE_CONFIRMATION_REQUIRED'
  | 'UNSUPPORTED_RUNTIME'
  | 'PROVIDER_RUNTIME_NOT_RUNNABLE'
  | 'CREDENTIAL_CLEANUP_PENDING';

export class ModelProviderServiceError extends Error {
  constructor(
    readonly code: ModelProviderServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelProviderServiceError';
  }
}

export interface ModelProviderServiceDependencies {
  persistence: ModelProviderPersistence;
  credentialStore: CredentialStorePort;
  connectionTester: ProviderConnectionTesterPort;
  now?: () => number;
  randomId?: () => string;
  isProviderInUse?: (providerId: string) => boolean;
  validateAgentDefault?: (providerId: string, modelId: string) => void;
}

interface ValidatedDraft {
  draft: NormalizedProviderDraft;
  secret: string;
  replaceCredential: boolean;
  connection: Extract<ProviderConnectionResult, { ok: true }>;
  expiresAt: number;
  expectedProvider: StoredModelProvider | null;
}

interface NormalizedProviderDraft {
  providerId?: string;
  name: string;
  type: ModelProviderType;
  apiFormat: ModelApiFormat;
  baseUrl: string;
  defaultModelId: string | null;
  requestedCapabilities?: Partial<ProviderCapabilities>;
}

export class ModelProviderService {
  private readonly persistence: ModelProviderPersistence;
  private readonly credentialStore: CredentialStorePort;
  private readonly connectionTester: ProviderConnectionTesterPort;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly isProviderInUse: (providerId: string) => boolean;
  private readonly validateAgentDefault?: (providerId: string, modelId: string) => void;
  private readonly capabilityResolver = new ProviderCapabilityResolver();
  private readonly validationTokens = new Map<string, ValidatedDraft>();
  private readonly validationTokenTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(dependencies: ModelProviderServiceDependencies) {
    this.persistence = dependencies.persistence;
    this.credentialStore = dependencies.credentialStore;
    this.connectionTester = dependencies.connectionTester;
    this.now = dependencies.now ?? Date.now;
    this.randomId = dependencies.randomId ?? randomUUID;
    this.isProviderInUse = dependencies.isProviderInUse ?? (() => false);
    this.validateAgentDefault = dependencies.validateAgentDefault;
  }

  listProviders(input: ModelProviderListRequest = {}): ModelProviderPage {
    const resolved = normalizePage(input);
    const page = this.persistence.listProviders(resolved);
    return {
      items: page.items.map((provider) => this.publicProvider(provider)),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  getProvider(providerId: string): PublicModelProvider {
    return this.publicProvider(this.requireProvider(providerId));
  }

  listModels(providerId: string): ProviderModel[] {
    this.requireProvider(providerId);
    return this.persistence.listModels(providerId).map((model) => ({ ...model }));
  }

  async validateDraft(input: ProviderDraftInput): Promise<ProviderValidationResult> {
    let existing: StoredModelProvider | null = null;
    let secret: string;
    const replaceCredential = input.credential !== null;

    if (input.providerId) {
      this.assertNotInUse(input.providerId);
      existing = this.requireProvider(input.providerId);
    } else if (input.baseUrlIntent?.mode === 'preserve_existing') {
      throw new ModelProviderServiceError(
        'INVALID_DRAFT',
        'Preserving a Provider Base URL requires an existing Provider.',
      );
    }
    const draft = normalizeDraft(input, existing?.baseUrl ?? null);

    if (existing) {
      if (!replaceCredential && originChanged(existing, draft)) {
        throw new ModelProviderServiceError(
          'CREDENTIAL_REENTRY_REQUIRED',
          'Changing Provider origin requires credential replacement.',
        );
      }
      if (replaceCredential) {
        secret = input.credential as string;
      } else if (existing.credentialRef) {
        secret = this.credentialStore.read(existing.credentialRef);
      } else {
        throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider credential is not configured.');
      }
    } else {
      if (!replaceCredential) {
        throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider credential is required.');
      }
      secret = input.credential as string;
    }

    const connection = await this.connectionTester.test({
      providerType: draft.type,
      apiFormat: draft.apiFormat,
      baseUrl: draft.baseUrl,
      apiKey: secret,
      ...(draft.defaultModelId ? { modelId: draft.defaultModelId } : {}),
    });

    if (!connection.ok) return { validationToken: null, connection };

    const validationToken = this.randomId();
    if (this.validationTokens.has(validationToken)) {
      throw new ModelProviderServiceError(
        'INVALID_VALIDATION_TOKEN',
        'Provider validation token could not be created.',
      );
    }
    const expiresAt = this.now() + VALIDATION_TOKEN_TTL_MS;
    this.storeValidationToken(validationToken, {
      draft,
      secret,
      replaceCredential,
      connection,
      expiresAt,
      expectedProvider: existing ? immutableProviderSnapshot(existing) : null,
    });
    return { validationToken, connection };
  }

  async createProvider(input: CreateProviderInput): Promise<PublicModelProvider> {
    const validated = this.consumeToken(input.validationToken);
    if (validated.draft.providerId) {
      throw new ModelProviderServiceError(
        'TOKEN_PROVIDER_MISMATCH',
        'Validation token belongs to a Provider update.',
      );
    }

    const now = this.now();
    const id = this.randomId();
    const credentialRef = this.credentialStore.create(validated.secret);
    const provider = this.buildStoredProvider({
      id,
      draft: validated.draft,
      credentialRef,
      connection: validated.connection,
      createdAt: now,
      updatedAt: now,
    });
    const models = modelRecords(provider, validated.connection.discoveredModelIds, now);
    try {
      this.persistence.createProvider(provider, models);
    } catch {
      try {
        this.credentialStore.delete(credentialRef);
      } catch {
        this.enqueueOrphanCredentialCleanup(credentialRef, now);
      }
      throw new Error('Provider could not be created.');
    }
    return this.publicProvider(provider);
  }

  async updateProvider(input: UpdateProviderInput): Promise<PublicModelProvider> {
    const validated = this.consumeToken(input.validationToken);
    if (validated.draft.providerId !== input.providerId) {
      throw new ModelProviderServiceError(
        'TOKEN_PROVIDER_MISMATCH',
        'Validation token does not belong to this Provider.',
      );
    }
    if (!validated.expectedProvider) {
      throw new ModelProviderServiceError(
        'TOKEN_PROVIDER_MISMATCH',
        'Validation token does not contain a Provider update snapshot.',
      );
    }
    this.assertNotInUse(input.providerId);
    const existing = validated.expectedProvider;
    if (existing.isDefault) {
      this.assertAgentDefaultEnvelope(
        validated.draft.type,
        validated.draft.apiFormat,
        validated.draft.requestedCapabilities,
      );
    }
    const now = this.now();
    let credentialRef = existing.credentialRef;
    let newCredentialRef: string | null = null;
    if (validated.replaceCredential) {
      newCredentialRef = this.credentialStore.create(validated.secret);
      credentialRef = newCredentialRef;
    }
    if (!credentialRef) {
      throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider credential is not configured.');
    }

    const provider = this.buildStoredProvider({
      id: existing.id,
      draft: validated.draft,
      credentialRef,
      connection: validated.connection,
      createdAt: existing.createdAt,
      updatedAt: now,
      isDefault: existing.isDefault,
    });
    const models = mergeModels(
      this.persistence.listModels(existing.id),
      modelRecords(provider, validated.connection.discoveredModelIds, now),
    );
    const oldCredentialCleanup = newCredentialRef && existing.credentialRef
      ? this.cleanupJob(existing.credentialRef, null, now)
      : undefined;
    try {
      this.persistence.updateProvider(provider, models, existing, oldCredentialCleanup);
    } catch (error) {
      if (newCredentialRef) {
        try {
          this.credentialStore.delete(newCredentialRef);
        } catch {
          this.enqueueOrphanCredentialCleanup(newCredentialRef, now);
        }
      }
      if (hasErrorCode(error, 'PROVIDER_STALE')) {
        throw new ModelProviderServiceError(
          'STALE_PROVIDER',
          'Provider changed after validation. Test the connection again.',
        );
      }
      throw new Error('Provider could not be updated.');
    }
    if (oldCredentialCleanup) {
      await this.executeCleanupJob(oldCredentialCleanup, false);
    }
    return this.publicProvider(provider);
  }

  async testConnection(providerId: string): Promise<ProviderConnectionResult> {
    const provider = this.requireProvider(providerId);
    if (!provider.enabled) {
      throw new ModelProviderServiceError('PROVIDER_DISABLED', 'Provider is disabled.');
    }
    if (!provider.credentialRef) {
      throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider credential is not configured.');
    }
    const secret = this.credentialStore.read(provider.credentialRef);
    const connection = await this.connectionTester.test({
      providerType: provider.type,
      apiFormat: provider.apiFormat,
      baseUrl: provider.baseUrl,
      apiKey: secret,
      ...(provider.defaultModelId ? { modelId: provider.defaultModelId } : {}),
    });
    this.persistence.updateProviderHealth(provider.id, healthFromConnection(connection));
    if (connection.ok) {
      const discovered = modelRecords(
        { ...provider, defaultModelId: null },
        connection.discoveredModelIds,
        connection.testedAt,
      );
      this.persistence.synchronizeDiscoveredModels(provider.id, discovered);
    }
    return connection;
  }

  setDefaultProvider(providerId: string): PublicModelProvider {
    const provider = this.requireProvider(providerId);
    if (!provider.enabled) {
      throw new ModelProviderServiceError('PROVIDER_DISABLED', 'Disabled Provider cannot be default.');
    }
    if (!provider.credentialRef || !provider.defaultModelId) {
      throw this.agentDefaultNotRunnable();
    }
    this.assertAgentDefaultEnvelope(provider.type, provider.apiFormat, provider.capabilities);
    try {
      this.validateAgentDefault?.(provider.id, provider.defaultModelId);
    } catch {
      throw this.agentDefaultNotRunnable();
    }
    const now = this.now();
    this.persistence.setDefaultProvider(providerId, now);
    return this.publicProvider(this.requireProvider(providerId));
  }

  setProviderEnabled(input: SetProviderEnabledInput): PublicModelProvider {
    if (typeof input.enabled !== 'boolean') {
      throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider enabled state is invalid.');
    }
    const provider = this.requireProvider(input.providerId);
    if (provider.enabled === input.enabled) return this.publicProvider(provider);
    this.assertNotInUse(input.providerId);
    this.persistence.setProviderEnabled(input.providerId, input.enabled, this.now());
    return this.publicProvider(this.requireProvider(input.providerId));
  }

  async deleteProvider(input: DeleteProviderInput): Promise<void> {
    if (!input.confirmCredentialDeletion) {
      throw new ModelProviderServiceError(
        'DELETE_CONFIRMATION_REQUIRED',
        'Deleting a Provider requires credential deletion confirmation.',
      );
    }
    this.assertNotInUse(input.providerId);
    const provider = this.requireProvider(input.providerId);
    if (!provider.credentialRef) {
      throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider credential is not configured.');
    }
    const now = this.now();
    const job = this.cleanupJob(provider.credentialRef, provider.id, now);
    this.persistence.beginProviderDeletion(job);
    await this.executeCleanupJob(job, true);
  }

  async retryCredentialCleanup(): Promise<void> {
    for (const job of this.persistence.listCredentialCleanupJobs()) {
      await this.executeCleanupJob(job, false);
    }
  }

  private async executeCleanupJob(job: CredentialCleanupJob, throwOnFailure: boolean): Promise<void> {
    try {
      this.credentialStore.delete(job.credentialRef);
      this.persistence.completeCredentialCleanup(job.id, job.providerId);
    } catch {
      this.persistence.markCredentialCleanupFailed(
        job.id,
        'io',
        this.now(),
      );
      if (throwOnFailure) {
        throw new ModelProviderServiceError(
          'CREDENTIAL_CLEANUP_PENDING',
          'Credential cleanup is pending.',
        );
      }
    }
  }

  private consumeToken(token: string): ValidatedDraft {
    const validated = this.validationTokens.get(token);
    if (!validated) {
      throw new ModelProviderServiceError(
        'INVALID_VALIDATION_TOKEN',
        'Provider validation token is invalid or already used.',
      );
    }
    this.removeValidationToken(token);
    if (this.now() >= validated.expiresAt) {
      throw new ModelProviderServiceError(
        'EXPIRED_VALIDATION_TOKEN',
        'Provider validation token has expired.',
      );
    }
    return validated;
  }

  private storeValidationToken(token: string, validated: ValidatedDraft): void {
    this.purgeExpiredValidationTokens();
    while (this.validationTokens.size >= MAX_PENDING_VALIDATION_TOKENS) {
      const oldest = this.validationTokens.keys().next().value as string | undefined;
      if (!oldest) break;
      this.removeValidationToken(oldest);
    }
    this.validationTokens.set(token, validated);
    const delay = Math.max(1, validated.expiresAt - this.now());
    const timer = setTimeout(() => this.removeValidationToken(token), delay);
    timer.unref?.();
    this.validationTokenTimers.set(token, timer);
  }

  private purgeExpiredValidationTokens(): void {
    const now = this.now();
    for (const [token, validated] of this.validationTokens) {
      if (now >= validated.expiresAt) this.removeValidationToken(token);
    }
  }

  private removeValidationToken(token: string): void {
    this.validationTokens.delete(token);
    const timer = this.validationTokenTimers.get(token);
    if (timer) clearTimeout(timer);
    this.validationTokenTimers.delete(token);
  }

  private cleanupJob(
    credentialRef: string,
    providerId: string | null,
    now: number,
  ): CredentialCleanupJob {
    return {
      id: this.randomId(),
      providerId,
      credentialRef,
      attempts: 0,
      nextAttemptAt: null,
      lastAttemptAt: null,
      lastErrorType: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private enqueueOrphanCredentialCleanup(credentialRef: string, now: number): void {
    try {
      this.persistence.enqueueCredentialCleanup(this.cleanupJob(credentialRef, null, now));
    } catch {
      // Preserve the primary persistence error. The encrypted orphan remains opaque and unreferenced.
    }
  }

  private buildStoredProvider(input: {
    id: string;
    draft: NormalizedProviderDraft;
    credentialRef: string;
    connection: Extract<ProviderConnectionResult, { ok: true }>;
    createdAt: number;
    updatedAt: number;
    isDefault?: boolean;
  }): StoredModelProvider {
    const trusted = this.capabilityResolver.resolve(
      input.draft.type,
      input.draft.apiFormat,
      input.draft.requestedCapabilities,
    );
    return {
      id: input.id,
      name: input.draft.name,
      type: input.draft.type,
      apiFormat: input.draft.apiFormat,
      runtimeType: trusted.runtimeType,
      baseUrl: input.draft.baseUrl,
      credentialRef: input.credentialRef,
      defaultModelId: input.draft.defaultModelId
        ?? input.connection.discoveredModelIds[0]
        ?? null,
      enabled: true,
      isDefault: input.isDefault ?? false,
      capabilities: trusted.capabilities,
      health: healthFromConnection(input.connection),
      metadata: {},
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
  }

  private publicProvider(provider: StoredModelProvider): PublicModelProvider {
    const trusted = this.capabilityResolver.resolve(
      provider.type,
      provider.apiFormat,
      provider.capabilities,
    );
    return toPublicModelProvider({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      apiFormat: provider.apiFormat,
      runtimeType: trusted.runtimeType,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      isDefault: provider.isDefault,
      configured: provider.credentialRef !== null,
      credentialSource: provider.credentialRef ? 'credential_store' : 'none',
      capabilities: { ...trusted.capabilities },
      health: { ...provider.health },
      defaultModelId: provider.defaultModelId,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    });
  }

  private requireProvider(providerId: string): StoredModelProvider {
    const provider = this.persistence.getProvider(providerId);
    if (!provider) {
      throw new ModelProviderServiceError('PROVIDER_NOT_FOUND', 'Provider was not found.');
    }
    return provider;
  }

  private assertNotInUse(providerId: string): void {
    if (this.isProviderInUse(providerId)) {
      throw new ModelProviderServiceError(
        'PROVIDER_IN_USE',
        'Provider is used by an active task and cannot be changed.',
      );
    }
  }

  private assertAgentDefaultEnvelope(
    type: ModelProviderType,
    apiFormat: ModelApiFormat,
    requestedCapabilities?: Partial<ProviderCapabilities>,
  ): void {
    const trusted = this.capabilityResolver.resolve(type, apiFormat, requestedCapabilities);
    if (
      trusted.runtimeType !== 'claude-code'
      || !trusted.capabilities.supportsClaudeCode
      || !trusted.capabilities.supportsAgentWorkflow
      || !trusted.capabilities.supportsTools
      || !trusted.capabilities.supportsMCP
    ) {
      throw this.agentDefaultNotRunnable();
    }
  }

  private agentDefaultNotRunnable(): ModelProviderServiceError {
    return new ModelProviderServiceError(
      'PROVIDER_RUNTIME_NOT_RUNNABLE',
      PROVIDER_RUNTIME_NOT_RUNNABLE_MESSAGE,
    );
  }
}

function normalizeDraft(
  input: ProviderDraftInput,
  existingBaseUrl: string | null,
): NormalizedProviderDraft {
  const name = input.name?.trim();
  if (!name
    || name.length > MAX_PROVIDER_NAME_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider name is invalid.');
  }
  if (input.credential !== null && (
    typeof input.credential !== 'string'
    || input.credential.length === 0
  )) {
    throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider credential is invalid.');
  }
  const defaultModelId = input.defaultModelId?.trim() ?? null;
  if (input.defaultModelId !== null && (
    !defaultModelId
    || defaultModelId.length > MAX_MODEL_ID_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(defaultModelId)
  )) {
    throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider model ID is invalid.');
  }
  const baseUrlInput = providerBaseUrlFromIntent(input, existingBaseUrl);
  if (!baseUrlInput) {
    throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider Base URL is required.');
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeProviderBaseUrl(baseUrlInput);
  } catch {
    throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider Base URL is invalid.');
  }
  return {
    ...(input.providerId ? { providerId: input.providerId } : {}),
    name,
    type: input.type,
    apiFormat: input.apiFormat,
    baseUrl,
    defaultModelId,
    ...(input.capabilities ? { requestedCapabilities: { ...input.capabilities } } : {}),
  };
}

function normalizePage(input: ModelProviderListRequest): ResolvedProviderListRequest {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider list limit is invalid.');
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider list offset is invalid.');
  }
  return { limit, offset, ...(input.enabled === undefined ? {} : { enabled: input.enabled }) };
}

function originChanged(existing: StoredModelProvider, draft: NormalizedProviderDraft): boolean {
  return existing.type !== draft.type
    || existing.apiFormat !== draft.apiFormat
    || new URL(normalizeProviderBaseUrl(existing.baseUrl)).origin !== new URL(draft.baseUrl).origin;
}

function providerBaseUrlFromIntent(
  input: ProviderDraftInput,
  existingBaseUrl: string | null,
): string | null {
  const intent = input.baseUrlIntent as unknown;
  if (
    intent
    && typeof intent === 'object'
    && !Array.isArray(intent)
    && Object.keys(intent).length === 1
    && (intent as { mode?: unknown }).mode === 'preserve_existing'
  ) {
    if (!input.providerId || existingBaseUrl === null) {
      throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider Base URL cannot be preserved.');
    }
    return existingBaseUrl;
  }
  if (
    !intent
    || typeof intent !== 'object'
    || Array.isArray(intent)
    || Object.keys(intent).length !== 2
    || (intent as { mode?: unknown }).mode !== 'replace'
    || !Object.prototype.hasOwnProperty.call(intent, 'value')
  ) {
    throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider Base URL intent is invalid.');
  }
  const value = (intent as { value?: unknown }).value;
  if (value !== null && typeof value !== 'string') {
    throw new ModelProviderServiceError('INVALID_DRAFT', 'Provider Base URL intent is invalid.');
  }
  return value === null
    && input.type === 'anthropic'
    && input.apiFormat === 'anthropic-messages'
    ? OFFICIAL_ANTHROPIC_BASE_URL
    : value;
}

function healthFromConnection(connection: ProviderConnectionResult): ProviderHealth {
  if (connection.ok) {
    return {
      state: 'connected',
      lastTestedAt: connection.testedAt,
      lastErrorType: null,
      latencyMs: connection.latencyMs,
    };
  }
  return {
    state: 'error',
    lastTestedAt: connection.testedAt,
    lastErrorType: connection.error.type,
    latencyMs: connection.latencyMs,
  };
}

function modelRecords(
  provider: StoredModelProvider,
  discoveredModelIds: readonly string[],
  now: number,
): StoredProviderModel[] {
  const result: StoredProviderModel[] = [];
  if (provider.defaultModelId) {
    result.push({
      providerId: provider.id,
      modelId: provider.defaultModelId,
      displayName: null,
      source: 'manual',
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const modelId of [...new Set(discoveredModelIds)]) {
    if (!modelId || modelId === provider.defaultModelId) continue;
    result.push({
      providerId: provider.id,
      modelId,
      displayName: null,
      source: 'discovered',
      createdAt: now,
      updatedAt: now,
    });
  }
  return result;
}

function mergeModels(
  current: StoredProviderModel[],
  incoming: StoredProviderModel[],
): StoredProviderModel[] {
  const merged = new Map(current.map((model) => [model.modelId, model]));
  for (const model of incoming) {
    const existing = merged.get(model.modelId);
    merged.set(model.modelId, existing
      ? { ...model, source: existing.source === 'manual' ? 'manual' : model.source, createdAt: existing.createdAt }
      : model);
  }
  return [...merged.values()];
}

function immutableProviderSnapshot(provider: StoredModelProvider): StoredModelProvider {
  return deepFreeze(structuredClone(provider));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === 'object'
    && (error as { code?: unknown }).code === code;
}
