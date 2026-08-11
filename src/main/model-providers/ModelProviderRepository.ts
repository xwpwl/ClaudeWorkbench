import {
  AppDatabase,
  type AgentModelPolicyDatabaseRow,
  type CredentialCleanupDatabaseRow,
  type CredentialCleanupErrorType,
  type ModelPolicyRating,
  type ModelProviderDatabaseRow,
  type ModelProviderModelDatabaseRow,
  type ModelTierBindingDatabaseRow,
  type ProjectModelTierBindingDatabaseRow,
  type ProjectModelPolicyDatabaseRow,
  type TaskModelOverrideDatabaseRow,
} from "../database/Database";
import {
  MODEL_TIERS,
  type ModelTier,
  type ModelTierBinding,
  type ModelTierScope,
  type PersistedModelPolicyReference,
} from "../../shared/types/modelTiers";
import {
  MODEL_POLICY_AGENT_TYPES,
  type ModelPolicyAgentType,
  type ProjectModelPolicyAgentType,
} from "../../shared/types/modelProviders";
import type {
  CredentialCleanupJob,
  ModelProviderPersistence,
  ResolvedProviderListRequest,
  StoredModelProvider,
  StoredProviderModel,
} from "./ModelProviderService";

const CLEANUP_RETRY_BASE_MS = 5_000;
const CLEANUP_RETRY_MAX_MS = 5 * 60_000;
export interface AgentModelPolicyRecord {
  agentType: ModelPolicyAgentType;
  providerId: string;
  modelId: string;
  quality: ModelPolicyRating | null;
  speed: ModelPolicyRating | null;
  cost: ModelPolicyRating | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentModelPolicyReferenceRecord {
  agentType: ModelPolicyAgentType;
  reference: PersistedModelPolicyReference;
  quality: ModelPolicyRating | null;
  speed: ModelPolicyRating | null;
  cost: ModelPolicyRating | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectModelPolicyRecord {
  projectId: string;
  agentType: ProjectModelPolicyAgentType;
  providerId: string;
  modelId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectModelPolicyReferenceRecord {
  projectId: string;
  agentType: ProjectModelPolicyAgentType;
  reference: PersistedModelPolicyReference;
  createdAt: number;
  updatedAt: number;
}

export type ModelTierBindingRecord = ModelTierBinding & {
  displayName: string | null;
  quality: ModelPolicyRating | null;
  speed: ModelPolicyRating | null;
  cost: ModelPolicyRating | null;
};

export type ProjectModelTierBindingRecord = ModelTierBindingRecord & {
  projectId: string;
};

export type AgentPolicyReferenceSet = Readonly<
  Record<ModelPolicyAgentType, PersistedModelPolicyReference>
>;

export type ModelProviderRepositoryErrorCode =
  | "POLICY_DERIVATION_INVALID"
  | "PROVIDER_STALE";

export class ModelProviderRepositoryError extends Error {
  constructor(
    readonly code: ModelProviderRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelProviderRepositoryError";
  }
}

export interface TaskModelOverrideRecord {
  taskId: string;
  providerId: string;
  modelId: string;
  createdAt: number;
  updatedAt: number;
}

export class ModelProviderRepository implements ModelProviderPersistence {
  constructor(private readonly database: AppDatabase) {}

  listProviders(input: ResolvedProviderListRequest): {
    items: StoredModelProvider[];
    total: number;
    limit: number;
    offset: number;
  } {
    const page = this.database.listModelProviderRows(input);
    return {
      items: page.items.map(providerFromDatabase),
      total: page.total,
      limit: input.limit,
      offset: input.offset,
    };
  }

  getProvider(providerId: string): StoredModelProvider | null {
    const row = this.database.getModelProviderRow(providerId);
    return row ? providerFromDatabase(row) : null;
  }

  getDefaultProvider(): StoredModelProvider | null {
    const row = this.database.getEnabledDefaultModelProviderRow();
    return row ? providerFromDatabase(row) : null;
  }

  createProvider(
    provider: StoredModelProvider,
    models: StoredProviderModel[],
  ): void {
    assertModelsBelongToProvider(provider.id, models);
    this.database.runInTransaction(() => {
      this.database.insertModelProviderRow(providerToDatabase(provider));
      for (const model of models) {
        this.database.upsertModelProviderModelRow(modelToDatabase(model));
      }
    });
  }

  updateProvider(
    provider: StoredModelProvider,
    models: StoredProviderModel[],
    expectedProvider: StoredModelProvider,
    cleanupJob?: CredentialCleanupJob,
  ): void {
    assertModelsBelongToProvider(provider.id, models);
    if (provider.id !== expectedProvider.id) {
      throw new ModelProviderRepositoryError(
        "PROVIDER_STALE",
        "Provider changed after validation.",
      );
    }
    this.database.runInTransaction(() => {
      if (!this.database.updateModelProviderRowIfCurrent(
        providerToDatabase(provider),
        providerToDatabase(expectedProvider),
      )) {
        throw new ModelProviderRepositoryError(
          "PROVIDER_STALE",
          "Provider changed after validation.",
        );
      }
      for (const model of models) {
        this.database.upsertModelProviderModelRow(modelToDatabase(model));
      }
      this.database.deleteModelProviderModelsExcept(
        provider.id,
        models.map(({ modelId }) => modelId),
      );
      if (cleanupJob) {
        this.database.insertCredentialCleanupRow(cleanupToDatabase(cleanupJob));
      }
    });
  }

  updateProviderHealth(
    providerId: string,
    health: StoredModelProvider["health"],
  ): void {
    const updated = this.database.updateModelProviderHealthRow(providerId, {
      health_state: health.state,
      last_tested_at: health.lastTestedAt,
      last_error_type: health.lastErrorType,
      latency_ms: health.latencyMs,
    });
    if (!updated) throw new Error(`Provider ${providerId} was not found.`);
  }

  listModels(providerId: string): StoredProviderModel[] {
    return this.database
      .listModelProviderModelRows(providerId)
      .map(modelFromDatabase);
  }

  upsertModels(providerId: string, models: StoredProviderModel[]): void {
    assertModelsBelongToProvider(providerId, models);
    this.database.runInTransaction(() => {
      for (const model of models) {
        this.database.upsertModelProviderModelRow(modelToDatabase(model));
      }
    });
  }

  synchronizeDiscoveredModels(
    providerId: string,
    models: StoredProviderModel[],
  ): void {
    assertModelsBelongToProvider(providerId, models);
    if (models.some((model) => model.source !== "discovered")) {
      throw new Error(
        "Discovered model synchronization accepts discovered models only.",
      );
    }
    this.database.runInTransaction(() => {
      for (const model of models) {
        this.database.upsertModelProviderModelRow(modelToDatabase(model));
      }
      const currentIds = new Set(models.map(({ modelId }) => modelId));
      for (const model of this.database.listModelProviderModelRows(
        providerId,
      )) {
        if (model.source === "discovered" && !currentIds.has(model.model_id)) {
          this.database.deleteUnreferencedDiscoveredModelProviderModelRow(
            providerId,
            model.model_id,
          );
        }
      }
    });
  }

  setDefaultProvider(providerId: string, updatedAt: number): void {
    this.database.runInTransaction(() => {
      const provider = this.database.getModelProviderRow(providerId);
      if (!provider) throw new Error(`Provider ${providerId} was not found.`);
      if (provider.enabled !== 1) {
        throw new Error("Only an enabled Provider can be the global default.");
      }
      this.database.clearDefaultModelProviderRows(providerId);
      if (!this.database.setModelProviderDefaultRow(providerId, updatedAt)) {
        throw new Error(`Provider ${providerId} could not be made default.`);
      }
    });
  }

  setProviderEnabled(
    providerId: string,
    enabled: boolean,
    updatedAt: number,
  ): void {
    this.database.runInTransaction(() => {
      const provider = this.getProvider(providerId);
      if (!provider) throw new Error(`Provider ${providerId} was not found.`);
      const next: StoredModelProvider = {
        ...provider,
        enabled,
        isDefault: enabled && provider.enabled ? provider.isDefault : false,
        updatedAt,
      };
      if (!this.database.updateModelProviderRow(providerToDatabase(next))) {
        throw new Error(`Provider ${providerId} could not be updated.`);
      }
    });
  }

  beginProviderDeletion(job: CredentialCleanupJob): void {
    this.database.runInTransaction(() => {
      const provider = job.providerId
        ? this.database.getModelProviderRow(job.providerId)
        : null;
      if (!job.providerId || !provider) {
        throw new Error("Credential cleanup Provider identity is invalid.");
      }
      if (provider.credential_ref !== job.credentialRef) {
        throw new Error(
          "Credential cleanup Provider identity does not match its credential.",
        );
      }
      this.database.insertCredentialCleanupRow(cleanupToDatabase(job));
      if (
        !this.database.disableModelProviderForDeletion(
          provider.id,
          job.updatedAt,
        )
      ) {
        throw new Error(`Provider ${provider.id} could not begin deletion.`);
      }
    });
  }

  enqueueCredentialCleanup(job: CredentialCleanupJob): void {
    this.database.insertCredentialCleanupRow(cleanupToDatabase(job));
  }

  completeCredentialCleanup(jobId: string, providerId: string | null): void {
    this.database.runInTransaction(() => {
      const job = this.database.getCredentialCleanupRow(jobId);
      if (!job || job.provider_id !== providerId) {
        throw new Error(
          "Credential cleanup Provider identity does not match the tombstone.",
        );
      }
      if (providerId) {
        const provider = this.database.getModelProviderRow(providerId);
        if (
          provider &&
          (provider.enabled !== 0 ||
            provider.credential_ref !== job.credential_ref)
        ) {
          throw new Error(
            "Credential cleanup Provider identity changed before deletion.",
          );
        }
        if (provider) this.database.deleteModelProviderRow(providerId);
      }
      if (!this.database.deleteCredentialCleanupRow(jobId)) {
        throw new Error(`Credential cleanup job ${jobId} was not found.`);
      }
    });
  }

  listCredentialCleanupJobs(): CredentialCleanupJob[] {
    return this.database.listCredentialCleanupRows().map(cleanupFromDatabase);
  }

  markCredentialCleanupFailed(
    jobId: string,
    errorType: Exclude<CredentialCleanupJob["lastErrorType"], null>,
    updatedAt: number,
  ): void {
    const job = this.database.getCredentialCleanupRow(jobId);
    if (!job) throw new Error(`Credential cleanup job ${jobId} was not found.`);
    const attempts = job.attempts + 1;
    const exponent = Math.min(job.attempts, 16);
    const delay = Math.min(
      CLEANUP_RETRY_MAX_MS,
      CLEANUP_RETRY_BASE_MS * 2 ** exponent,
    );
    const nextAttemptAt = Math.min(Number.MAX_SAFE_INTEGER, updatedAt + delay);
    if (
      !this.database.updateCredentialCleanupFailureRow({
        jobId,
        attempts,
        nextAttemptAt,
        lastAttemptAt: updatedAt,
        lastErrorType: errorType,
        updatedAt,
      })
    ) {
      throw new Error(`Credential cleanup job ${jobId} was not found.`);
    }
  }

  upsertModelTierBinding(binding: ModelTierBindingRecord): void {
    this.database.upsertModelTierBindingRow(tierBindingToDatabase(binding));
  }

  getModelTierBinding(tier: ModelTier): ModelTierBindingRecord | null {
    const row = this.database.getModelTierBindingRow(tier);
    return row ? tierBindingFromDatabase(row) : null;
  }

  listModelTierBindings(): ModelTierBindingRecord[] {
    return this.database
      .listModelTierBindingRows()
      .map(tierBindingFromDatabase);
  }

  deleteModelTierBinding(tier: ModelTier): boolean {
    return this.database.deleteModelTierBindingRow(tier);
  }

  upsertProjectModelTierBinding(binding: ProjectModelTierBindingRecord): void {
    this.database.upsertProjectModelTierBindingRow(
      projectTierBindingToDatabase(binding),
    );
  }

  getProjectModelTierBinding(
    projectId: string,
    tier: ModelTier,
  ): ProjectModelTierBindingRecord | null {
    const row = this.database.getProjectModelTierBindingRow(projectId, tier);
    return row ? projectTierBindingFromDatabase(row) : null;
  }

  listProjectModelTierBindings(
    projectId: string,
  ): ProjectModelTierBindingRecord[] {
    return this.database
      .listProjectModelTierBindingRows(projectId)
      .map(projectTierBindingFromDatabase);
  }

  deleteProjectModelTierBinding(projectId: string, tier: ModelTier): boolean {
    return this.database.deleteProjectModelTierBindingRow(projectId, tier);
  }

  bindAllModelTiersAtomically(input: {
    scope: ModelTierScope;
    now: number;
    deriveCandidateInTransaction: () => { providerId: string; modelId: string };
  }): Array<ModelTierBindingRecord | ProjectModelTierBindingRecord> {
    const scope = ownedPolicyScope(input.scope);
    const now = input.now;
    const deriveCandidateInTransaction = input.deriveCandidateInTransaction;
    if (
      typeof deriveCandidateInTransaction !== "function"
      || !Number.isSafeInteger(now)
      || now < 0
    ) {
      throw invalidPolicyDerivation();
    }
    return this.database.runInTransaction(() => {
      const candidate = ownedTierCandidate(
        deriveCandidateInTransaction() as unknown,
      );
      const rows: Array<ModelTierBindingRecord | ProjectModelTierBindingRecord> = [];
      for (const tier of MODEL_TIERS) {
        if (scope.type === "global") {
          const existing = this.database.getModelTierBindingRow(tier);
          const row: ModelTierBindingRecord = {
            tier,
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            displayName: existing?.display_name ?? null,
            quality: existing?.quality ?? null,
            speed: existing?.speed ?? null,
            cost: existing?.cost ?? null,
            updatedAt: now,
          };
          this.database.upsertModelTierBindingRow(
            tierBindingToDatabase(row),
          );
          rows.push(Object.freeze({ ...row }));
        } else {
          const existing = this.database.getProjectModelTierBindingRow(
            scope.projectId,
            tier,
          );
          const row: ProjectModelTierBindingRecord = {
            projectId: scope.projectId,
            tier,
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            displayName: existing?.display_name ?? null,
            quality: existing?.quality ?? null,
            speed: existing?.speed ?? null,
            cost: existing?.cost ?? null,
            updatedAt: now,
          };
          this.database.upsertProjectModelTierBindingRow(
            projectTierBindingToDatabase(row),
          );
          rows.push(Object.freeze({ ...row }));
        }
      }
      return rows;
    });
  }

  setAgentModelPolicy(policy: AgentModelPolicyRecord): void {
    this.database.setAgentModelPolicyRow(agentPolicyToDatabase(policy));
  }

  getAgentModelPolicy(
    agentType: ModelPolicyAgentType,
  ): AgentModelPolicyRecord | null {
    const row = this.database.getAgentModelPolicyRow(agentType);
    return row ? agentPolicyFromDatabase(row) : null;
  }

  listAgentModelPolicies(): AgentModelPolicyRecord[] {
    return this.database
      .listAgentModelPolicyRows()
      .map(agentPolicyFromDatabase);
  }

  deleteAgentModelPolicy(agentType: ModelPolicyAgentType): boolean {
    return this.database.deleteAgentModelPolicyRow(agentType);
  }

  setAgentModelPolicyReference(policy: AgentModelPolicyReferenceRecord): void {
    this.database.setAgentModelPolicyRow(
      agentPolicyReferenceToDatabase(policy),
    );
  }

  getAgentModelPolicyReference(
    agentType: ModelPolicyAgentType,
  ): AgentModelPolicyReferenceRecord | null {
    const row = this.database.getAgentModelPolicyRow(agentType);
    return row ? agentPolicyReferenceFromDatabase(row) : null;
  }

  listAgentModelPolicyReferences(): AgentModelPolicyReferenceRecord[] {
    return this.database
      .listAgentModelPolicyRows()
      .map(agentPolicyReferenceFromDatabase);
  }

  setProjectModelPolicy(policy: ProjectModelPolicyRecord): void {
    this.database.setProjectModelPolicyRow(projectPolicyToDatabase(policy));
  }

  getProjectModelPolicy(
    projectId: string,
    agentType: ProjectModelPolicyAgentType,
  ): ProjectModelPolicyRecord | null {
    const row = this.database.getProjectModelPolicyRow(projectId, agentType);
    return row ? projectPolicyFromDatabase(row) : null;
  }

  listProjectModelPolicies(projectId: string): ProjectModelPolicyRecord[] {
    return this.database
      .listProjectModelPolicyRows(projectId)
      .map(projectPolicyFromDatabase);
  }

  deleteProjectModelPolicy(
    projectId: string,
    agentType: ProjectModelPolicyAgentType,
  ): boolean {
    return this.database.deleteProjectModelPolicyRow(projectId, agentType);
  }

  setProjectModelPolicyReference(
    policy: ProjectModelPolicyReferenceRecord,
  ): void {
    this.database.setProjectModelPolicyRow(
      projectPolicyReferenceToDatabase(policy),
    );
  }

  getProjectModelPolicyReference(
    projectId: string,
    agentType: ProjectModelPolicyAgentType,
  ): ProjectModelPolicyReferenceRecord | null {
    const row = this.database.getProjectModelPolicyRow(projectId, agentType);
    return row ? projectPolicyReferenceFromDatabase(row) : null;
  }

  listProjectModelPolicyReferences(
    projectId: string,
  ): ProjectModelPolicyReferenceRecord[] {
    return this.database
      .listProjectModelPolicyRows(projectId)
      .map(projectPolicyReferenceFromDatabase);
  }

  applyAgentPolicyReferencesAtomically(input: {
    scope: ModelTierScope;
    now: number;
    /** Required synchronous derivation executed inside the write transaction. */
    deriveReferencesInTransaction: () => AgentPolicyReferenceSet;
  }): void {
    const scope = ownedPolicyScope(input.scope);
    const now = input.now;
    const deriveReferencesInTransaction = input.deriveReferencesInTransaction;
    if (typeof deriveReferencesInTransaction !== "function") {
      throw new ModelProviderRepositoryError(
        "POLICY_DERIVATION_INVALID",
        "A synchronous policy derivation callback is required.",
      );
    }
    if (!Number.isSafeInteger(now) || now < 0) {
      throw invalidPolicyDerivation();
    }
    this.database.runInTransaction(() => {
      const references = ownedAgentReferenceSnapshot(
        deriveReferencesInTransaction() as unknown,
      );
      assertCompleteAgentReferenceSet(references);
      for (const agentType of MODEL_POLICY_AGENT_TYPES) {
        const reference = references[agentType];
        if (scope.type === "global") {
          const existing = this.database.getAgentModelPolicyRow(agentType);
          this.database.setAgentModelPolicyRow(
            agentPolicyReferenceToDatabase({
              agentType,
              reference,
              quality: existing?.quality ?? null,
              speed: existing?.speed ?? null,
              cost: existing?.cost ?? null,
              createdAt: existing?.created_at ?? now,
              updatedAt: now,
            }),
          );
        } else {
          const existing = this.database.getProjectModelPolicyRow(
            scope.projectId,
            agentType,
          );
          this.database.setProjectModelPolicyRow(
            projectPolicyReferenceToDatabase({
              projectId: scope.projectId,
              agentType,
              reference,
              createdAt: existing?.created_at ?? now,
              updatedAt: now,
            }),
          );
        }
      }
    });
  }

  setTaskModelOverride(override: TaskModelOverrideRecord): void {
    this.database.setTaskModelOverrideRow(taskOverrideToDatabase(override));
  }

  getTaskModelOverride(taskId: string): TaskModelOverrideRecord | null {
    const row = this.database.getTaskModelOverrideRow(taskId);
    return row ? taskOverrideFromDatabase(row) : null;
  }

  deleteTaskModelOverride(taskId: string): boolean {
    return this.database.deleteTaskModelOverrideRow(taskId);
  }
}

function providerToDatabase(
  provider: StoredModelProvider,
): ModelProviderDatabaseRow {
  if (provider.id.startsWith("synthetic:")) {
    throw new Error("Provider identity uses the reserved synthetic namespace.");
  }
  if (provider.runtimeType === "openai-agent") {
    throw new Error(
      "OpenAI Agent Runtime is reserved and cannot be persisted as implemented.",
    );
  }
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    base_url: provider.baseUrl,
    api_format: provider.apiFormat,
    runtime_type: provider.runtimeType,
    credential_ref: provider.credentialRef,
    default_model_id: provider.defaultModelId,
    enabled: provider.enabled ? 1 : 0,
    is_default: provider.isDefault ? 1 : 0,
    supports_claude_code: provider.capabilities.supportsClaudeCode ? 1 : 0,
    supports_agent_workflow: provider.capabilities.supportsAgentWorkflow
      ? 1
      : 0,
    supports_tools: provider.capabilities.supportsTools ? 1 : 0,
    supports_mcp: provider.capabilities.supportsMCP ? 1 : 0,
    supports_streaming: provider.capabilities.supportsStreaming ? 1 : 0,
    supports_vision: provider.capabilities.supportsVision ? 1 : 0,
    metadata_json: JSON.stringify(provider.metadata),
    health_state: provider.health.state,
    last_tested_at: provider.health.lastTestedAt,
    last_error_type: provider.health.lastErrorType,
    latency_ms: provider.health.latencyMs,
    created_at: provider.createdAt,
    updated_at: provider.updatedAt,
  };
}

function providerFromDatabase(
  row: ModelProviderDatabaseRow,
): StoredModelProvider {
  if (row.base_url === null) {
    throw new Error(`Persisted Provider ${row.id} has no Base URL.`);
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    apiFormat: row.api_format,
    runtimeType: row.runtime_type,
    baseUrl: row.base_url,
    credentialRef: row.credential_ref,
    defaultModelId: row.default_model_id,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    capabilities: {
      supportsClaudeCode: row.supports_claude_code === 1,
      supportsAgentWorkflow: row.supports_agent_workflow === 1,
      supportsTools: row.supports_tools === 1,
      supportsMCP: row.supports_mcp === 1,
      supportsStreaming: row.supports_streaming === 1,
      supportsVision: row.supports_vision === 1,
    },
    health: {
      state: row.health_state,
      lastTestedAt: row.last_tested_at,
      lastErrorType: row.last_error_type,
      latencyMs: row.latency_ms,
    },
    metadata: parseMetadata(row.id, row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function modelToDatabase(
  model: StoredProviderModel,
): ModelProviderModelDatabaseRow {
  return {
    provider_id: model.providerId,
    model_id: model.modelId,
    display_name: model.displayName,
    source: model.source,
    created_at: model.createdAt,
    updated_at: model.updatedAt,
  };
}

function modelFromDatabase(
  row: ModelProviderModelDatabaseRow,
): StoredProviderModel {
  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    displayName: row.display_name,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanupToDatabase(
  job: CredentialCleanupJob,
): CredentialCleanupDatabaseRow {
  return {
    id: job.id,
    provider_id: job.providerId,
    credential_ref: job.credentialRef,
    attempts: job.attempts,
    next_attempt_at: job.nextAttemptAt,
    last_attempt_at: job.lastAttemptAt,
    last_error_type: job.lastErrorType,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

function cleanupFromDatabase(
  row: CredentialCleanupDatabaseRow,
): CredentialCleanupJob {
  return {
    id: row.id,
    providerId: row.provider_id,
    credentialRef: row.credential_ref,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at,
    lastErrorType: row.last_error_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function agentPolicyToDatabase(
  policy: AgentModelPolicyRecord,
): AgentModelPolicyDatabaseRow {
  return {
    agent_type: policy.agentType,
    provider_id: policy.providerId,
    model_id: policy.modelId,
    tier: null,
    quality: policy.quality,
    speed: policy.speed,
    cost: policy.cost,
    created_at: policy.createdAt,
    updated_at: policy.updatedAt,
  };
}

function agentPolicyFromDatabase(
  row: AgentModelPolicyDatabaseRow,
): AgentModelPolicyRecord {
  const reference = policyReferenceFromDatabase(row);
  if (reference.kind !== "model") {
    throw new Error(`Agent policy ${row.agent_type} uses a tier reference.`);
  }
  return {
    agentType: row.agent_type,
    providerId: reference.providerId,
    modelId: reference.modelId,
    quality: row.quality,
    speed: row.speed,
    cost: row.cost,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectPolicyToDatabase(
  policy: ProjectModelPolicyRecord,
): ProjectModelPolicyDatabaseRow {
  return {
    project_id: policy.projectId,
    agent_type: policy.agentType,
    provider_id: policy.providerId,
    model_id: policy.modelId,
    tier: null,
    created_at: policy.createdAt,
    updated_at: policy.updatedAt,
  };
}

function projectPolicyFromDatabase(
  row: ProjectModelPolicyDatabaseRow,
): ProjectModelPolicyRecord {
  const reference = policyReferenceFromDatabase(row);
  if (reference.kind !== "model") {
    throw new Error(
      `Project policy ${row.project_id}/${row.agent_type} uses a tier reference.`,
    );
  }
  return {
    projectId: row.project_id,
    agentType: row.agent_type,
    providerId: reference.providerId,
    modelId: reference.modelId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskOverrideToDatabase(
  override: TaskModelOverrideRecord,
): TaskModelOverrideDatabaseRow {
  return {
    task_id: override.taskId,
    provider_id: override.providerId,
    model_id: override.modelId,
    created_at: override.createdAt,
    updated_at: override.updatedAt,
  };
}

function taskOverrideFromDatabase(
  row: TaskModelOverrideDatabaseRow,
): TaskModelOverrideRecord {
  return {
    taskId: row.task_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function tierBindingToDatabase(
  binding: ModelTierBindingRecord,
): ModelTierBindingDatabaseRow {
  return {
    tier: binding.tier,
    provider_id: binding.providerId,
    model_id: binding.modelId,
    display_name: binding.displayName,
    quality: binding.quality,
    speed: binding.speed,
    cost: binding.cost,
    updated_at: binding.updatedAt,
  };
}

function tierBindingFromDatabase(
  row: ModelTierBindingDatabaseRow,
): ModelTierBindingRecord {
  return {
    tier: row.tier,
    providerId: row.provider_id,
    modelId: row.model_id,
    displayName: row.display_name,
    quality: row.quality,
    speed: row.speed,
    cost: row.cost,
    updatedAt: row.updated_at,
  } as ModelTierBindingRecord;
}

function projectTierBindingToDatabase(
  binding: ProjectModelTierBindingRecord,
): ProjectModelTierBindingDatabaseRow {
  return {
    project_id: binding.projectId,
    ...tierBindingToDatabase(binding),
  };
}

function projectTierBindingFromDatabase(
  row: ProjectModelTierBindingDatabaseRow,
): ProjectModelTierBindingRecord {
  return {
    projectId: row.project_id,
    ...tierBindingFromDatabase(row),
  };
}

function agentPolicyReferenceToDatabase(
  policy: AgentModelPolicyReferenceRecord,
): AgentModelPolicyDatabaseRow {
  const columns = policyReferenceToDatabase(policy.reference);
  return {
    agent_type: policy.agentType,
    ...columns,
    quality: policy.quality,
    speed: policy.speed,
    cost: policy.cost,
    created_at: policy.createdAt,
    updated_at: policy.updatedAt,
  };
}

function agentPolicyReferenceFromDatabase(
  row: AgentModelPolicyDatabaseRow,
): AgentModelPolicyReferenceRecord {
  return {
    agentType: row.agent_type,
    reference: policyReferenceFromDatabase(row),
    quality: row.quality,
    speed: row.speed,
    cost: row.cost,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectPolicyReferenceToDatabase(
  policy: ProjectModelPolicyReferenceRecord,
): ProjectModelPolicyDatabaseRow {
  const columns = policyReferenceToDatabase(policy.reference);
  return {
    project_id: policy.projectId,
    agent_type: policy.agentType,
    ...columns,
    created_at: policy.createdAt,
    updated_at: policy.updatedAt,
  };
}

function projectPolicyReferenceFromDatabase(
  row: ProjectModelPolicyDatabaseRow,
): ProjectModelPolicyReferenceRecord {
  return {
    projectId: row.project_id,
    agentType: row.agent_type,
    reference: policyReferenceFromDatabase(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function policyReferenceToDatabase(reference: PersistedModelPolicyReference): {
  provider_id: string | null;
  model_id: string | null;
  tier: ModelTier | null;
} {
  return reference.kind === "model"
    ? {
        provider_id: reference.providerId,
        model_id: reference.modelId,
        tier: null,
      }
    : { provider_id: null, model_id: null, tier: reference.tier };
}

function policyReferenceFromDatabase(row: {
  provider_id: string | null;
  model_id: string | null;
  tier: ModelTier | null;
}): PersistedModelPolicyReference {
  if (row.tier !== null && row.provider_id === null && row.model_id === null) {
    return { kind: "tier", tier: row.tier };
  }
  if (row.tier === null && row.provider_id !== null && row.model_id !== null) {
    return {
      kind: "model",
      providerId: row.provider_id,
      modelId: row.model_id,
    };
  }
  throw new Error("Persisted model policy reference is inconsistent.");
}

function assertCompleteAgentReferenceSet(
  references: Readonly<
    Record<ModelPolicyAgentType, PersistedModelPolicyReference>
  >,
): void {
  const actual = Object.keys(references).sort();
  const expected = [...MODEL_POLICY_AGENT_TYPES].sort();
  if (
    actual.length !== expected.length ||
    actual.some((role, index) => role !== expected[index])
  ) {
    throw invalidPolicyDerivation();
  }
}

function ownedAgentReferenceSnapshot(
  value: unknown,
): Readonly<Record<ModelPolicyAgentType, PersistedModelPolicyReference>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidPolicyDerivation();
  }
  assertCompleteAgentReferenceSet(
    value as Readonly<
      Record<ModelPolicyAgentType, PersistedModelPolicyReference>
    >,
  );
  const source = value as Record<ModelPolicyAgentType, unknown>;
  const entries = MODEL_POLICY_AGENT_TYPES.map((role) => {
    const candidate = source[role];
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw invalidPolicyDerivation();
    }
    const kind = (candidate as { kind?: unknown }).kind;
    if (kind === "tier") {
      const tier = (candidate as { tier?: unknown }).tier;
      if (typeof tier !== "string") throw invalidPolicyDerivation();
      return [role, Object.freeze({ kind: "tier", tier })] as const;
    }
    if (kind === "model") {
      const providerId = (candidate as { providerId?: unknown }).providerId;
      const modelId = (candidate as { modelId?: unknown }).modelId;
      if (typeof providerId !== "string" || typeof modelId !== "string") {
        throw invalidPolicyDerivation();
      }
      return [
        role,
        Object.freeze({ kind: "model", providerId, modelId }),
      ] as const;
    }
    throw invalidPolicyDerivation();
  });
  const owned = Object.fromEntries(entries) as Record<
    ModelPolicyAgentType,
    PersistedModelPolicyReference
  >;
  assertCompleteAgentReferenceSet(owned);
  return Object.freeze(owned);
}

function ownedPolicyScope(value: ModelTierScope): ModelTierScope {
  if (value?.type === "global") return Object.freeze({ type: "global" });
  if (
    value?.type === "project" &&
    typeof value.projectId === "string" &&
    value.projectId.length > 0 &&
    value.projectId.length <= 128 &&
    value.projectId === value.projectId.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value.projectId)
  ) {
    return Object.freeze({ type: "project", projectId: value.projectId });
  }
  throw invalidPolicyDerivation();
}

function ownedTierCandidate(value: unknown): Readonly<{
  providerId: string;
  modelId: string;
}> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !Object.prototype.hasOwnProperty.call(value, "providerId")
    || !Object.prototype.hasOwnProperty.call(value, "modelId")
  ) {
    throw invalidPolicyDerivation();
  }
  const providerId = (value as { providerId?: unknown }).providerId;
  const modelId = (value as { modelId?: unknown }).modelId;
  if (
    typeof providerId !== "string"
    || providerId.length < 1
    || providerId.length > 192
    || providerId !== providerId.trim()
    || /[\u0000-\u001f\u007f]/u.test(providerId)
    || typeof modelId !== "string"
    || modelId.length < 1
    || modelId.length > 256
    || modelId !== modelId.trim()
    || /[\u0000-\u001f\u007f]/u.test(modelId)
  ) {
    throw invalidPolicyDerivation();
  }
  return Object.freeze({ providerId, modelId });
}

function invalidPolicyDerivation(): ModelProviderRepositoryError {
  return new ModelProviderRepositoryError(
    "POLICY_DERIVATION_INVALID",
    "Policy derivation is invalid.",
  );
}

function assertModelsBelongToProvider(
  providerId: string,
  models: readonly StoredProviderModel[],
): void {
  if (models.some((model) => model.providerId !== providerId)) {
    throw new Error(
      `Provider ${providerId} cannot persist a model owned by another Provider.`,
    );
  }
}

function parseMetadata(
  providerId: string,
  metadataJson: string,
): Record<string, unknown> {
  const parsed = JSON.parse(metadataJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Persisted Provider ${providerId} metadata is not an object.`,
    );
  }
  return parsed as Record<string, unknown>;
}

export type { CredentialCleanupErrorType };
