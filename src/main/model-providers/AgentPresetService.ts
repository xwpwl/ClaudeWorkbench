import { createHash } from "node:crypto";
import {
  AGENT_PRESET_IDS,
  AGENT_PRESETS,
  MODEL_TIERS,
} from "../../shared/types/modelTiers";
import type {
  AgentPresetApplyResult,
  AgentPresetId,
  AgentPresetPrepareResult,
  AgentPresetPreview,
  AgentPresetStatus,
  ModelTier,
  ModelTierResolutionPublic,
  ModelTierScope,
  PersistedModelPolicyReference,
} from "../../shared/types/modelTiers";
import {
  MODEL_POLICY_AGENT_TYPES,
  type ModelPolicyAgentType,
} from "../../shared/types/modelProviders";
import type {
  AgentPolicyReferenceSet,
  AgentModelPolicyReferenceRecord,
  ModelTierBindingRecord,
  ProjectModelPolicyReferenceRecord,
  ProjectModelTierBindingRecord,
} from "./ModelProviderRepository";
import type {
  StoredModelProvider,
  StoredProviderModel,
} from "./ModelProviderService";
import { ProviderCapabilityResolver } from "./ProviderCapabilityResolver";
import type {
  ModelTierService,
  PreparedModelTierTrust,
} from "./ModelTierService";

const REVISION_PREFIX = "agent-preset:v1:";
const REVISION_PATTERN = /^agent-preset:v1:[a-f0-9]{64}$/u;
const CODING_ROLES = new Set<ModelPolicyAgentType>([
  "coder",
  "tester",
  "fixer",
]);

export interface AgentPresetRepository {
  getProvider(providerId: string): StoredModelProvider | null;
  listModels(providerId: string): StoredProviderModel[];
  getModelTierBinding(tier: ModelTier): ModelTierBindingRecord | null;
  getProjectModelTierBinding(
    projectId: string,
    tier: ModelTier,
  ): ProjectModelTierBindingRecord | null;
  listAgentModelPolicyReferences(): AgentModelPolicyReferenceRecord[];
  listProjectModelPolicyReferences(
    projectId: string,
  ): ProjectModelPolicyReferenceRecord[];
  applyAgentPolicyReferencesAtomically(input: {
    scope: ModelTierScope;
    now: number;
    deriveReferencesInTransaction: () => AgentPolicyReferenceSet;
  }): void;
}

export type AgentPresetServiceErrorCode =
  | "INVALID_PRESET_REQUEST"
  | "PRESET_ROLE_UNAVAILABLE"
  | "PREVIEW_STALE"
  | "PREVIEW_CONFIRMATION_REQUIRED"
  | "OVERWRITE_CONFIRMATION_REQUIRED"
  | "PRESET_PREVIEW_FAILED"
  | "PRESET_APPLY_FAILED"
  | "PRESET_STATUS_FAILED";

export class AgentPresetServiceError extends Error {
  constructor(
    readonly code: AgentPresetServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentPresetServiceError";
  }
}

export interface AgentPresetServiceDependencies {
  repository: AgentPresetRepository;
  tierService: ModelTierService;
  now?: () => number;
}

export class AgentPresetService {
  private readonly repository: AgentPresetRepository;
  private readonly tierService: ModelTierService;
  private readonly now: () => number;
  private readonly capabilities = new ProviderCapabilityResolver();

  constructor(dependencies: AgentPresetServiceDependencies) {
    this.repository = dependencies.repository;
    this.tierService = dependencies.tierService;
    this.now = dependencies.now ?? Date.now;
  }

  async preparePreset(
    scope: ModelTierScope,
    presetId: AgentPresetId,
  ): Promise<AgentPresetPrepareResult> {
    return this.closedPublic("PRESET_PREVIEW_FAILED", async () => {
      const snapshot = await this.trustedSnapshot(scope, presetId);
      const missingTiers = MODEL_TIERS.filter((tier) =>
        MODEL_POLICY_AGENT_TYPES.some(
          (role) =>
            AGENT_PRESETS[presetId].roles[role] === tier &&
            snapshot.preview.roles[role].resolution.validity !== "valid",
        ),
      );
      return missingTiers.length > 0
        ? { step: "bind_tiers", missingTiers }
        : { step: "preview", preview: snapshot.preview };
    });
  }

  async previewPreset(
    scope: ModelTierScope,
    presetId: AgentPresetId,
  ): Promise<AgentPresetPreview> {
    return this.closedPublic(
      "PRESET_PREVIEW_FAILED",
      async () => (await this.trustedSnapshot(scope, presetId)).preview,
    );
  }

  async applyPreset(
    scope: ModelTierScope,
    presetId: AgentPresetId,
    expectedRevision: string,
    previewConfirmed: boolean,
    overwriteConfirmed: boolean,
  ): Promise<AgentPresetApplyResult> {
    return this.closedPublic("PRESET_APPLY_FAILED", async () => {
      const safeScope = closedScope(scope);
      assertPresetId(presetId);
      assertExpectedRevision(expectedRevision);
      if (
        typeof previewConfirmed !== "boolean" ||
        typeof overwriteConfirmed !== "boolean"
      ) {
        throw invalidRequest();
      }
      if (!previewConfirmed) {
        throw new AgentPresetServiceError(
          "PREVIEW_CONFIRMATION_REQUIRED",
          "Applying this template requires preview confirmation.",
        );
      }

      // The CLI installation fact is awaited once. Both preflight and transaction-terminal
      // resolution use the opaque token and synchronously re-read every mutable trusted fact.
      const prepared = await this.tierService.prepareTrustedSnapshot(safeScope);
      const beforeTransaction = this.snapshotFromPrepared(
        safeScope,
        presetId,
        prepared,
      );
      this.assertSnapshotCanApply(
        beforeTransaction,
        expectedRevision,
        overwriteConfirmed,
      );
      const appliedAt = this.now();
      if (!Number.isSafeInteger(appliedAt) || appliedAt < 0) {
        throw new AgentPresetServiceError(
          "PRESET_APPLY_FAILED",
          "The Agent template could not be applied.",
        );
      }

      this.repository.applyAgentPolicyReferencesAtomically({
        scope: safeScope,
        now: appliedAt,
        deriveReferencesInTransaction: () => {
          const insideTransaction = this.snapshotFromPrepared(
            safeScope,
            presetId,
            prepared,
          );
          this.assertSnapshotCanApply(
            insideTransaction,
            expectedRevision,
            overwriteConfirmed,
          );
          return presetReferences(presetId);
        },
      });
      return { presetId, appliedAt };
    });
  }

  async getPresetStatus(scope: ModelTierScope): Promise<AgentPresetStatus> {
    return this.closedPublic("PRESET_STATUS_FAILED", async () => {
      const safeScope = closedScope(scope);
      this.tierService.assertScopeExists(safeScope);
      const policies = this.currentPolicies(safeScope);
      for (const presetId of AGENT_PRESET_IDS) {
        if (
          MODEL_POLICY_AGENT_TYPES.every((role) => {
            const policy = policies.get(role);
            const expectedTier = AGENT_PRESETS[presetId].roles[role];
            return (
              policy?.reference.kind === "tier" &&
              policy.reference.tier === expectedTier
            );
          })
        ) {
          return { kind: "preset", presetId };
        }
      }
      return { kind: "custom" };
    });
  }

  private async trustedSnapshot(
    scope: ModelTierScope,
    presetId: AgentPresetId,
  ): Promise<PresetSnapshot> {
    const safeScope = closedScope(scope);
    assertPresetId(presetId);
    const prepared = await this.tierService.prepareTrustedSnapshot(safeScope);
    return this.snapshotFromPrepared(safeScope, presetId, prepared);
  }

  private snapshotFromPrepared(
    scope: ModelTierScope,
    presetId: AgentPresetId,
    prepared: PreparedModelTierTrust,
  ): PresetSnapshot {
    return this.buildSnapshot(
      scope,
      presetId,
      this.tierService.resolvePreparedBindings(scope, prepared),
    );
  }

  /** Synchronous by design so the repository can invoke it inside its SQLite transaction. */
  private buildSnapshot(
    scope: ModelTierScope,
    presetId: AgentPresetId,
    resolutions: readonly ModelTierResolutionPublic[],
  ): PresetSnapshot {
    const resolutionMap = exactResolutionMap(scope, resolutions);
    const roles = Object.fromEntries(
      MODEL_POLICY_AGENT_TYPES.map((role) => {
        const tier = AGENT_PRESETS[presetId].roles[role];
        const resolution = this.roleResolution(
          role,
          resolutionMap.get(tier) as ModelTierResolutionPublic,
        );
        return [role, { role, tier, resolution }];
      }),
    ) as unknown as AgentPresetPreview["roles"];
    const policies = this.currentPolicies(scope);
    const canonical = {
      version: 1,
      scope,
      presetId,
      tiers: MODEL_TIERS.map((tier) =>
        this.canonicalTierFact(
          scope,
          tier,
          resolutionMap.get(tier) as ModelTierResolutionPublic,
        ),
      ),
      providers: this.canonicalProviderFacts(scope, resolutionMap),
      policies: MODEL_POLICY_AGENT_TYPES.map((role) =>
        canonicalPolicy(policies.get(role) ?? null),
      ),
    };
    const revision =
      REVISION_PREFIX +
      createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
    return {
      policies,
      preview: { scope, presetId, revision, roles },
    };
  }

  private roleResolution(
    role: ModelPolicyAgentType,
    resolution: ModelTierResolutionPublic,
  ): ModelTierResolutionPublic {
    if (!CODING_ROLES.has(role) || resolution.validity !== "valid")
      return resolution;
    const candidate = resolution.candidate;
    let supportsRequiredCapabilities = false;
    if (candidate.executionSource === "database_provider") {
      const provider = this.repository.getProvider(candidate.providerId);
      if (provider) {
        const trusted = this.capabilities.resolve(
          provider.type,
          provider.apiFormat,
          provider.capabilities,
        );
        supportsRequiredCapabilities =
          trusted.capabilities.supportsTools &&
          trusted.capabilities.supportsMCP;
      }
    } else {
      // ModelTierService only produces these identities from the trusted Anthropic envelopes.
      supportsRequiredCapabilities =
        candidate.runtimeType === "claude-code" &&
        (candidate.executionSource === "environment" ||
          candidate.executionSource === "claude_code");
    }
    if (supportsRequiredCapabilities) return resolution;
    return {
      scope: resolution.scope,
      tier: resolution.tier,
      display: resolution.display,
      source: resolution.source,
      binding: resolution.binding,
      candidate: null,
      validity: "needs_reconfiguration",
      invalidReason: "workflow_capability_missing",
    };
  }

  private canonicalTierFact(
    scope: ModelTierScope,
    tier: ModelTier,
    resolution: ModelTierResolutionPublic,
  ): unknown {
    const selected = this.currentTierBinding(scope, tier);
    return {
      tier,
      selectedSource: selected.source,
      row: selected.binding ? canonicalBinding(selected.binding) : null,
      resolution: canonicalResolution(resolution),
    };
  }

  private canonicalProviderFacts(
    scope: ModelTierScope,
    resolutions: ReadonlyMap<ModelTier, ModelTierResolutionPublic>,
  ): unknown[] {
    const identities = new Map<
      string,
      { providerId: string; modelId: string }
    >();
    for (const tier of MODEL_TIERS) {
      const selected = this.currentTierBinding(scope, tier).binding;
      if (selected?.providerId !== null && selected?.providerId !== undefined) {
        identities.set(`${selected.providerId}\0${selected.modelId}`, {
          providerId: selected.providerId,
          modelId: selected.modelId,
        });
      }
    }
    return [...identities.values()]
      .sort(
        (left, right) =>
          compareCodeUnits(left.providerId, right.providerId) ||
          compareCodeUnits(left.modelId, right.modelId),
      )
      .map(({ providerId, modelId }) => {
        if (providerId.startsWith("synthetic:")) {
          const candidate =
            MODEL_TIERS.map(
              (tier) => resolutions.get(tier)?.candidate ?? null,
            ).find(
              (item) =>
                item?.providerId === providerId && item.modelId === modelId,
            ) ?? null;
          return { providerId, modelId, synthetic: candidate };
        }
        const provider = this.repository.getProvider(providerId);
        if (!provider) return { providerId, modelId, missing: true };
        const trusted = this.capabilities.resolve(
          provider.type,
          provider.apiFormat,
          provider.capabilities,
        );
        const selectedModel =
          this.repository
            .listModels(providerId)
            .find(
              (item) =>
                item.providerId === providerId && item.modelId === modelId,
            ) ?? null;
        return {
          providerId,
          modelId,
          providerName: provider.name,
          providerType: provider.type,
          apiFormat: provider.apiFormat,
          storedRuntimeType: provider.runtimeType,
          providerCreatedAt: provider.createdAt,
          providerUpdatedAt: provider.updatedAt,
          enabled: provider.enabled,
          configured: provider.credentialRef !== null,
          health: {
            state: provider.health.state,
            lastTestedAt: provider.health.lastTestedAt,
            lastErrorType: provider.health.lastErrorType,
            latencyMs: provider.health.latencyMs,
          },
          trustedRuntimeType: trusted.runtimeType,
          trustedCapabilities: trusted.capabilities,
          model: selectedModel
            ? {
                modelId: selectedModel.modelId,
                displayName: selectedModel.displayName,
                source: selectedModel.source,
                createdAt: selectedModel.createdAt,
                updatedAt: selectedModel.updatedAt,
              }
            : null,
        };
      });
  }

  private currentTierBinding(
    scope: ModelTierScope,
    tier: ModelTier,
  ): {
    source: "global" | "project" | "none";
    binding: ModelTierBindingRecord | ProjectModelTierBindingRecord | null;
  } {
    if (scope.type === "project") {
      const projectBinding = this.repository.getProjectModelTierBinding(
        scope.projectId,
        tier,
      );
      if (projectBinding) return { source: "project", binding: projectBinding };
    }
    const globalBinding = this.repository.getModelTierBinding(tier);
    return globalBinding
      ? { source: "global", binding: globalBinding }
      : { source: "none", binding: null };
  }

  private currentPolicies(
    scope: ModelTierScope,
  ): Map<
    ModelPolicyAgentType,
    AgentModelPolicyReferenceRecord | ProjectModelPolicyReferenceRecord
  > {
    const rows =
      scope.type === "global"
        ? this.repository.listAgentModelPolicyReferences()
        : this.repository.listProjectModelPolicyReferences(scope.projectId);
    const roles = new Set<ModelPolicyAgentType>(MODEL_POLICY_AGENT_TYPES);
    const policies = new Map<
      ModelPolicyAgentType,
      AgentModelPolicyReferenceRecord | ProjectModelPolicyReferenceRecord
    >();
    let projectDefaultSeen = false;
    for (const row of rows) {
      if (scope.type === "project" && row.agentType === "default") {
        if (projectDefaultSeen)
          throw new Error("Inconsistent project default policy rows.");
        projectDefaultSeen = true;
        continue;
      }
      if (!roles.has(row.agentType as ModelPolicyAgentType)) {
        throw new Error("Unknown Agent policy role.");
      }
      const role = row.agentType as ModelPolicyAgentType;
      if (policies.has(role)) throw new Error("Duplicate Agent policy role.");
      assertExactPolicyReference(row.reference);
      policies.set(
        role,
        row as
          AgentModelPolicyReferenceRecord | ProjectModelPolicyReferenceRecord,
      );
    }
    return policies;
  }

  private assertSnapshotCanApply(
    snapshot: PresetSnapshot,
    expectedRevision: string,
    overwriteConfirmed: boolean,
  ): void {
    if (snapshot.preview.revision !== expectedRevision) {
      throw new AgentPresetServiceError(
        "PREVIEW_STALE",
        "The Agent template preview is out of date.",
      );
    }
    this.assertSnapshotReady(snapshot, overwriteConfirmed);
  }

  private assertSnapshotReady(
    snapshot: PresetSnapshot,
    overwriteConfirmed: boolean,
  ): void {
    if (
      MODEL_POLICY_AGENT_TYPES.some(
        (role) => snapshot.preview.roles[role].resolution.validity !== "valid",
      )
    ) {
      throw new AgentPresetServiceError(
        "PRESET_ROLE_UNAVAILABLE",
        "One or more Agent roles need a valid model tier binding.",
      );
    }
    if (snapshot.policies.size > 0 && overwriteConfirmed !== true) {
      throw new AgentPresetServiceError(
        "OVERWRITE_CONFIRMATION_REQUIRED",
        "Reapplying this template requires confirmation.",
      );
    }
  }

  private async closedPublic<T>(
    fallbackCode: Extract<
      AgentPresetServiceErrorCode,
      "PRESET_PREVIEW_FAILED" | "PRESET_APPLY_FAILED" | "PRESET_STATUS_FAILED"
    >,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AgentPresetServiceError) throw error;
      throw new AgentPresetServiceError(
        fallbackCode,
        fallbackMessage(fallbackCode),
      );
    }
  }
}

interface PresetSnapshot {
  preview: AgentPresetPreview;
  policies: Map<
    ModelPolicyAgentType,
    AgentModelPolicyReferenceRecord | ProjectModelPolicyReferenceRecord
  >;
}

function presetReferences(
  presetId: AgentPresetId,
): Readonly<Record<ModelPolicyAgentType, PersistedModelPolicyReference>> {
  const references = Object.fromEntries(
    MODEL_POLICY_AGENT_TYPES.map((role) => [
      role,
      Object.freeze({
        kind: "tier",
        tier: AGENT_PRESETS[presetId].roles[role],
      }),
    ]),
  ) as Record<ModelPolicyAgentType, PersistedModelPolicyReference>;
  return Object.freeze(references);
}

function assertExactPolicyReference(
  reference: PersistedModelPolicyReference,
): void {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new Error("Inconsistent Agent policy reference.");
  }
  const actualKeys = Object.keys(reference).sort(compareCodeUnits);
  if (reference.kind === "tier") {
    const expectedKeys = ["kind", "tier"].sort(compareCodeUnits);
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index]) ||
      !MODEL_TIERS.includes(reference.tier)
    ) {
      throw new Error("Inconsistent Agent tier reference.");
    }
    return;
  }
  if (reference.kind === "model") {
    const expectedKeys = ["kind", "modelId", "providerId"].sort(
      compareCodeUnits,
    );
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index]) ||
      !validReferenceIdentity(reference.providerId) ||
      !validReferenceIdentity(reference.modelId)
    ) {
      throw new Error("Inconsistent Agent model reference.");
    }
    return;
  }
  throw new Error("Inconsistent Agent policy reference kind.");
}

function validReferenceIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fallbackMessage(
  code:
    "PRESET_PREVIEW_FAILED" | "PRESET_APPLY_FAILED" | "PRESET_STATUS_FAILED",
): string {
  if (code === "PRESET_PREVIEW_FAILED") {
    return "The Agent template preview could not be prepared.";
  }
  if (code === "PRESET_STATUS_FAILED") {
    return "The Agent template status could not be read.";
  }
  return "The Agent template could not be applied.";
}

function closedScope(scope: ModelTierScope): ModelTierScope {
  if (scope?.type === "global") return { type: "global" };
  if (
    scope?.type === "project" &&
    typeof scope.projectId === "string" &&
    scope.projectId.length > 0 &&
    scope.projectId.length <= 128 &&
    scope.projectId === scope.projectId.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(scope.projectId)
  ) {
    return { type: "project", projectId: scope.projectId };
  }
  throw invalidRequest();
}

function assertPresetId(value: unknown): asserts value is AgentPresetId {
  if (!AGENT_PRESET_IDS.includes(value as AgentPresetId))
    throw invalidRequest();
}

function assertExpectedRevision(value: unknown): asserts value is string {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value))
    throw invalidRequest();
}

function invalidRequest(): AgentPresetServiceError {
  return new AgentPresetServiceError(
    "INVALID_PRESET_REQUEST",
    "Agent template request is invalid.",
  );
}

function exactResolutionMap(
  scope: ModelTierScope,
  resolutions: readonly ModelTierResolutionPublic[],
): Map<ModelTier, ModelTierResolutionPublic> {
  if (resolutions.length !== MODEL_TIERS.length) throw invalidRequest();
  const result = new Map<ModelTier, ModelTierResolutionPublic>();
  for (const resolution of resolutions) {
    if (
      !MODEL_TIERS.includes(resolution.tier) ||
      result.has(resolution.tier) ||
      resolution.scope.type !== scope.type ||
      (scope.type === "project" &&
        (resolution.scope.type !== "project" ||
          resolution.scope.projectId !== scope.projectId))
    ) {
      throw invalidRequest();
    }
    result.set(resolution.tier, resolution);
  }
  return result;
}

function canonicalBinding(
  binding: ModelTierBindingRecord | ProjectModelTierBindingRecord,
): unknown {
  return {
    providerId: binding.providerId,
    modelId: binding.modelId,
    displayName: binding.displayName,
    quality: binding.quality,
    speed: binding.speed,
    cost: binding.cost,
    updatedAt: binding.updatedAt,
  };
}

function canonicalResolution(resolution: ModelTierResolutionPublic): unknown {
  return {
    source: resolution.source,
    binding: resolution.binding,
    display: resolution.display,
    validity: resolution.validity,
    invalidReason: resolution.invalidReason,
    candidate: resolution.candidate,
  };
}

function canonicalPolicy(
  policy:
    AgentModelPolicyReferenceRecord | ProjectModelPolicyReferenceRecord | null,
): unknown {
  if (!policy) return null;
  return {
    agentType: policy.agentType,
    reference:
      policy.reference.kind === "tier"
        ? { kind: "tier", tier: policy.reference.tier }
        : {
            kind: "model",
            providerId: policy.reference.providerId,
            modelId: policy.reference.modelId,
          },
    quality: "quality" in policy ? policy.quality : null,
    speed: "speed" in policy ? policy.speed : null,
    cost: "cost" in policy ? policy.cost : null,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}
