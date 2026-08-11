import {
  MODEL_TIERS,
  type BindAllModelTiersRequest,
  type BoundModelTierBinding,
  type ModelTier,
  type ModelTierCandidatePublic,
  type ModelTierInvalidReason,
  type ModelTierResolutionPublic,
  type ModelTierScope,
  type SetModelTierBindingRequest,
  type UpdateModelTierDisplayMetadataRequest,
} from "../../shared/types/modelTiers";
import type {
  ModelApiFormat,
  ModelProviderType,
} from "../../shared/types/modelProviders";
import type { RuntimeProviderDescriptor } from "./AgentRuntime";
import { AgentRuntimeRegistry } from "./AgentRuntimeRegistry";
import type {
  ModelTierBindingRecord,
  ProjectModelTierBindingRecord,
} from "./ModelProviderRepository";
import type {
  StoredModelProvider,
  StoredProviderModel,
} from "./ModelProviderService";
import { ProviderCapabilityResolver } from "./ProviderCapabilityResolver";
import { normalizeProviderBaseUrl } from "./ProviderConnectionTester";

const PROVIDER_PAGE_SIZE = 100;
const PROVIDER_ID_MAX_LENGTH = 192;
const MODEL_ID_MAX_LENGTH = 256;
const SOURCE_IDENTITY_MAX_LENGTH = 512;
const SYNTHETIC_PROVIDER_ID =
  /^synthetic:v1:(environment|claude_code):[a-f0-9]{64}$/u;

export type EffectiveSyntheticTierSelection =
  | {
      kind: "environment";
      providerName: string;
      modelId: string;
      baseUrl: string | null;
      authenticationMode: "api_key" | "auth_token";
    }
  | {
      kind: "claude_code";
      providerName: string;
      modelId: string;
    };

/** Main-process-only keyed fingerprint provider. The key never enters this service. */
export interface SyntheticIdentityHmacPort {
  digestSha256(canonicalIdentity: string): string;
}

export interface ModelTierRepository {
  listProviders(input: { limit: number; offset: number; enabled?: boolean }): {
    items: StoredModelProvider[];
    total: number;
    limit: number;
    offset: number;
  };
  getProvider(providerId: string): StoredModelProvider | null;
  listModels(providerId: string): StoredProviderModel[];
  upsertModelTierBinding(binding: ModelTierBindingRecord): void;
  getModelTierBinding(tier: ModelTier): ModelTierBindingRecord | null;
  listModelTierBindings(): ModelTierBindingRecord[];
  deleteModelTierBinding(tier: ModelTier): boolean;
  upsertProjectModelTierBinding(binding: ProjectModelTierBindingRecord): void;
  getProjectModelTierBinding(
    projectId: string,
    tier: ModelTier,
  ): ProjectModelTierBindingRecord | null;
  listProjectModelTierBindings(
    projectId: string,
  ): ProjectModelTierBindingRecord[];
  deleteProjectModelTierBinding(projectId: string, tier: ModelTier): boolean;
  bindAllModelTiersAtomically(input: {
    scope: ModelTierScope;
    now: number;
    deriveCandidateInTransaction: () => { providerId: string; modelId: string };
  }): Array<ModelTierBindingRecord | ProjectModelTierBindingRecord>;
}

export interface ModelTierServiceDependencies {
  repository: ModelTierRepository;
  runtimeRegistry: AgentRuntimeRegistry;
  syntheticIdentityHmac: SyntheticIdentityHmacPort;
  /** Trusted existence/readability check only; this port must never return the credential. */
  credentialExists: (reference: string) => boolean;
  projectExists: (projectId: string) => boolean;
  resolveEffectiveSyntheticSelection?: (
    scope: ModelTierScope,
  ) => EffectiveSyntheticTierSelection | null;
  now?: () => number;
}

export type ModelTierServiceErrorCode =
  | "TIER_CANDIDATE_INVALID"
  | "PROJECT_NOT_FOUND"
  | "TIER_BINDING_WRITE_FAILED"
  | "TIER_BINDING_CLEAR_FAILED";

export class ModelTierServiceError extends Error {
  constructor(
    readonly code: ModelTierServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelTierServiceError";
  }
}

type SyntheticInvalidReason = Extract<
  ModelTierInvalidReason,
  "source_changed" | "claude_cli_unavailable" | "runtime_incompatible"
>;

interface PreparedSyntheticCandidate {
  candidate: ModelTierCandidatePublic | null;
  providerId: string | null;
  invalidReason: SyntheticInvalidReason;
}

interface ApplicationProviderFact {
  provider: StoredModelProvider;
  modelIds: Set<string>;
  stateReason: Extract<
    ModelTierInvalidReason,
    "provider_disabled" | "provider_unconfigured" | "connection_unavailable"
  > | null;
  runtimeReason: Extract<
    ModelTierInvalidReason,
    "runtime_incompatible" | "workflow_capability_missing"
  > | null;
}

type SelectedBinding =
  | {
      source: "global" | "project";
      binding: ModelTierBindingRecord | ProjectModelTierBindingRecord;
    }
  | {
      source: "none";
      binding: null;
    };

interface FinalSnapshot {
  candidates: ModelTierCandidatePublic[];
  applicationProviders: Map<string, ApplicationProviderFact>;
  bindings: Map<ModelTier, SelectedBinding>;
  syntheticProviderId: string | null;
  syntheticInvalidReason: SyntheticInvalidReason;
}

interface CanonicalSyntheticIdentity {
  canonical: string;
  kind: EffectiveSyntheticTierSelection["kind"];
  providerName: string;
  providerType: ModelProviderType;
  apiFormat: ModelApiFormat;
  modelId: string;
}

declare const preparedModelTierTrustBrand: unique symbol;

/**
 * Main-process-only authority prepared before entering a synchronous database transaction.
 * The value is intentionally opaque and is authenticated by the service instance that made it.
 */
export interface PreparedModelTierTrust {
  readonly [preparedModelTierTrustBrand]: true;
}

interface PreparedModelTierTrustFacts {
  scopeKey: string;
  initialIdentity: CanonicalSyntheticIdentity | null;
  initialDigest: string | null;
  claudeInstalled: boolean;
}

export class ModelTierService {
  private readonly repository: ModelTierRepository;
  private readonly runtimeRegistry: AgentRuntimeRegistry;
  private readonly capabilityResolver: ProviderCapabilityResolver;
  private readonly syntheticIdentityHmac: SyntheticIdentityHmacPort;
  private readonly credentialExists: (reference: string) => boolean;
  private readonly projectExists: (projectId: string) => boolean;
  private readonly resolveEffectiveSyntheticSelection: (
    scope: ModelTierScope,
  ) => EffectiveSyntheticTierSelection | null;
  private readonly now: () => number;
  private readonly preparedTrust = new WeakMap<
    object,
    PreparedModelTierTrustFacts
  >();

  constructor(dependencies: ModelTierServiceDependencies) {
    if (
      !dependencies.syntheticIdentityHmac ||
      typeof dependencies.syntheticIdentityHmac.digestSha256 !== "function"
    ) {
      throw new Error(
        "A trusted stable synthetic identity HMAC provider is required.",
      );
    }
    if (typeof dependencies.credentialExists !== "function") {
      throw new Error("A trusted credential-existence provider is required.");
    }
    if (typeof dependencies.projectExists !== "function") {
      throw new Error("A trusted project-existence provider is required.");
    }

    this.repository = dependencies.repository;
    this.runtimeRegistry = dependencies.runtimeRegistry;
    this.capabilityResolver = new ProviderCapabilityResolver();
    this.syntheticIdentityHmac = dependencies.syntheticIdentityHmac;
    this.credentialExists = dependencies.credentialExists;
    this.projectExists = dependencies.projectExists;
    this.resolveEffectiveSyntheticSelection =
      dependencies.resolveEffectiveSyntheticSelection ?? (() => null);
    this.now = dependencies.now ?? Date.now;
  }

  async listCandidates(
    scope: ModelTierScope = { type: "global" },
  ): Promise<ModelTierCandidatePublic[]> {
    const safeScope = closedScope(scope);
    this.assertProjectExists(safeScope);
    return this.withFinalSnapshot(safeScope, (snapshot) => snapshot.candidates);
  }

  async getBindings(
    scope: ModelTierScope,
  ): Promise<ModelTierResolutionPublic[]> {
    const safeScope = closedScope(scope);
    this.assertProjectExists(safeScope);
    return this.withFinalSnapshot(safeScope, (snapshot) =>
      MODEL_TIERS.map((tier) =>
        this.resolveFromSnapshot(safeScope, tier, snapshot),
      ),
    );
  }

  /** Prepare the sole asynchronous CLI trust fact before a synchronous terminal snapshot. */
  async prepareTrustedSnapshot(
    scope: ModelTierScope,
  ): Promise<PreparedModelTierTrust> {
    const safeScope = closedScope(scope);
    this.assertProjectExists(safeScope);
    const initialIdentity = canonicalSyntheticIdentity(
      this.safeEffectiveSelection(safeScope),
    );
    const initialDigest = initialIdentity
      ? this.safeSyntheticDigest(initialIdentity.canonical)
      : null;
    let claudeInstalled = false;
    try {
      claudeInstalled = (
        await this.runtimeRegistry.checkInstallation("claude-code")
      ).installed;
    } catch {
      claudeInstalled = false;
    }
    const token = Object.freeze({}) as PreparedModelTierTrust;
    this.preparedTrust.set(token, {
      scopeKey: canonicalScopeKey(safeScope),
      initialIdentity,
      initialDigest,
      claudeInstalled,
    });
    return token;
  }

  /**
   * Synchronously re-reads every database and trusted runtime fact. This is the terminal seam
   * used from inside a repository transaction; it must never await.
   */
  resolvePreparedBindings(
    scope: ModelTierScope,
    prepared: PreparedModelTierTrust,
  ): ModelTierResolutionPublic[] {
    const safeScope = closedScope(scope);
    const snapshot = this.resolvePreparedSnapshot(safeScope, prepared);
    return MODEL_TIERS.map((tier) =>
      this.resolveFromSnapshot(safeScope, tier, snapshot),
    );
  }

  /** Main-process-only project authority check used by preset status reads. */
  assertScopeExists(scope: ModelTierScope): void {
    this.assertProjectExists(closedScope(scope));
  }

  async setBinding(
    input: SetModelTierBindingRequest,
  ): Promise<ModelTierResolutionPublic> {
    const safeScope = closedScope(input.scope);
    assertTier(input.tier);
    assertIdentity(input.providerId, "Provider");
    assertIdentity(input.modelId, "Model");
    this.assertProjectExists(safeScope);

    return this.withFinalSnapshot(safeScope, (snapshot) => {
      const candidate = snapshot.candidates.find(
        (item) =>
          item.providerId === input.providerId &&
          item.modelId === input.modelId,
      );
      if (!candidate) {
        throw new ModelTierServiceError(
          "TIER_CANDIDATE_INVALID",
          "The selected model is no longer a runnable Agent candidate.",
        );
      }

      const previous = snapshot.bindings.get(input.tier)?.binding;
      const updatedAt = this.now();
      try {
        if (safeScope.type === "global") {
          const record: ModelTierBindingRecord = {
            tier: input.tier,
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            ...displayFields(previous),
            updatedAt,
          };
          this.repository.upsertModelTierBinding(record);
          return validResolution(
            safeScope,
            input.tier,
            "global",
            record,
            candidate,
          );
        }

        const record: ProjectModelTierBindingRecord = {
          projectId: safeScope.projectId,
          tier: input.tier,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          ...displayFields(previous),
          updatedAt,
        };
        this.repository.upsertProjectModelTierBinding(record);
        return validResolution(
          safeScope,
          input.tier,
          "project",
          record,
          candidate,
        );
      } catch {
        if (
          safeScope.type === "project" &&
          !this.safeProjectExists(safeScope.projectId)
        ) {
          throw projectNotFoundError();
        }
        throw new ModelTierServiceError(
          "TIER_BINDING_WRITE_FAILED",
          "The model tier binding could not be saved.",
        );
      }
    });
  }

  async clearProjectBinding(
    projectId: string,
    tier: ModelTier,
  ): Promise<boolean> {
    const safeScope = closedScope({ type: "project", projectId });
    if (safeScope.type !== "project") {
      throw new ModelTierServiceError(
        "TIER_CANDIDATE_INVALID",
        "Model tier scope is invalid.",
      );
    }
    assertTier(tier);
    this.assertProjectExists(safeScope);
    try {
      return this.repository.deleteProjectModelTierBinding(
        safeScope.projectId,
        tier,
      );
    } catch {
      if (!this.safeProjectExists(safeScope.projectId))
        throw projectNotFoundError();
      throw new ModelTierServiceError(
        "TIER_BINDING_CLEAR_FAILED",
        "The project model tier binding could not be cleared.",
      );
    }
  }

  async bindAllTiers(
    input: BindAllModelTiersRequest,
  ): Promise<ModelTierResolutionPublic[]> {
    const safeScope = closedScope(input.scope);
    assertIdentity(input.providerId, "Provider");
    assertIdentity(input.modelId, "Model");
    this.assertProjectExists(safeScope);
    const prepared = await this.prepareTrustedSnapshot(safeScope);
    const updatedAt = this.now();
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
      throw new ModelTierServiceError(
        "TIER_BINDING_WRITE_FAILED",
        "The model tier bindings could not be saved.",
      );
    }
    let trustedCandidate: ModelTierCandidatePublic | null = null;
    try {
      const rows = this.repository.bindAllModelTiersAtomically({
        scope: safeScope,
        now: updatedAt,
        deriveCandidateInTransaction: () => {
          const snapshot = this.resolvePreparedSnapshot(safeScope, prepared);
          const candidate = snapshot.candidates.find(
            (item) => item.providerId === input.providerId && item.modelId === input.modelId,
          );
          if (!candidate) {
            throw new ModelTierServiceError(
              "TIER_CANDIDATE_INVALID",
              "The selected model is no longer a runnable Agent candidate.",
            );
          }
          trustedCandidate = candidate;
          return { providerId: candidate.providerId, modelId: candidate.modelId };
        },
      });
      if (!trustedCandidate || rows.length !== MODEL_TIERS.length) {
        throw new Error("Atomic tier binding result is invalid.");
      }
      return MODEL_TIERS.map((tier) => {
        const row = rows.find((item) => item.tier === tier);
        if (!row) throw new Error("Atomic tier binding result is incomplete.");
        return validResolution(
          safeScope,
          tier,
          safeScope.type === "global" ? "global" : "project",
          row,
          trustedCandidate as ModelTierCandidatePublic,
        );
      });
    } catch (error) {
      if (error instanceof ModelTierServiceError) throw error;
      if (safeScope.type === "project" && !this.safeProjectExists(safeScope.projectId)) {
        throw projectNotFoundError();
      }
      throw new ModelTierServiceError(
        "TIER_BINDING_WRITE_FAILED",
        "The model tier bindings could not be saved.",
      );
    }
  }

  async updateDisplayMetadata(
    input: UpdateModelTierDisplayMetadataRequest,
  ): Promise<ModelTierResolutionPublic> {
    const safeScope = closedScope(input.scope);
    const metadata = closedDisplayMetadata(input.metadata);
    this.assertProjectExists(safeScope);
    return this.withFinalSnapshot(safeScope, (snapshot) => {
      const selected = safeScope.type === "global"
        ? this.repository.getModelTierBinding(metadata.tier)
        : this.repository.getProjectModelTierBinding(safeScope.projectId, metadata.tier);
      const updatedAt = this.now();
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
        throw new ModelTierServiceError(
          "TIER_BINDING_WRITE_FAILED",
          "The model tier binding could not be saved.",
        );
      }
      const base = {
        tier: metadata.tier,
        providerId: selected?.providerId ?? null,
        modelId: selected?.modelId ?? null,
        displayName: metadata.displayName,
        quality: metadata.quality,
        speed: metadata.speed,
        cost: metadata.cost,
        updatedAt,
      } as ModelTierBindingRecord;
      try {
        if (safeScope.type === "global") {
          this.repository.upsertModelTierBinding(base);
          snapshot.bindings.set(metadata.tier, { source: "global", binding: base });
        } else {
          const row: ProjectModelTierBindingRecord = {
            projectId: safeScope.projectId,
            ...base,
          };
          this.repository.upsertProjectModelTierBinding(row);
          snapshot.bindings.set(metadata.tier, { source: "project", binding: row });
        }
        return this.resolveFromSnapshot(safeScope, metadata.tier, snapshot);
      } catch (error) {
        if (error instanceof ModelTierServiceError) throw error;
        if (safeScope.type === "project" && !this.safeProjectExists(safeScope.projectId)) {
          throw projectNotFoundError();
        }
        throw new ModelTierServiceError(
          "TIER_BINDING_WRITE_FAILED",
          "The model tier binding could not be saved.",
        );
      }
    });
  }

  async resolveTier(
    scope: ModelTierScope,
    tier: ModelTier,
  ): Promise<ModelTierResolutionPublic> {
    const safeScope = closedScope(scope);
    assertTier(tier);
    this.assertProjectExists(safeScope);
    return this.withFinalSnapshot(safeScope, (snapshot) =>
      this.resolveFromSnapshot(safeScope, tier, snapshot),
    );
  }

  private resolveFromSnapshot(
    scope: ModelTierScope,
    tier: ModelTier,
    snapshot: FinalSnapshot,
  ): ModelTierResolutionPublic {
    const selected = snapshot.bindings.get(tier) ?? {
      source: "none",
      binding: null,
    };
    if (!selected.binding) {
      return {
        scope,
        tier,
        display: emptyDisplay(tier),
        source: "none",
        binding: null,
        candidate: null,
        validity: "unbound",
        invalidReason: "tier_unbound",
      };
    }

    const display = { tier, ...displayFields(selected.binding) };
    const publicBinding = bindingFields(selected.binding);
    if (publicBinding.providerId === null) {
      return {
        scope,
        tier,
        display,
        source: selected.source,
        binding: publicBinding,
        candidate: null,
        validity: "unbound",
        invalidReason: "tier_unbound",
      };
    }

    const candidate = snapshot.candidates.find(
      (item) =>
        item.providerId === publicBinding.providerId &&
        item.modelId === publicBinding.modelId,
    );
    if (candidate) {
      return {
        scope,
        tier,
        display,
        source: selected.source,
        binding: publicBinding,
        candidate,
        validity: "valid",
        invalidReason: null,
      };
    }

    return {
      scope,
      tier,
      display,
      source: selected.source,
      binding: publicBinding,
      candidate: null,
      validity: "needs_reconfiguration",
      invalidReason: this.invalidReason(publicBinding, snapshot),
    };
  }

  private async withFinalSnapshot<T>(
    scope: ModelTierScope,
    consume: (snapshot: FinalSnapshot) => T,
  ): Promise<T> {
    const prepared = await this.prepareTrustedSnapshot(scope);
    // From this point through consume/write, every terminal fact is read synchronously.
    return consume(this.resolvePreparedSnapshot(scope, prepared));
  }

  private resolvePreparedSnapshot(
    scope: ModelTierScope,
    prepared: PreparedModelTierTrust,
  ): FinalSnapshot {
    if (!prepared || typeof prepared !== "object")
      throw invalidPreparedTrustError();
    const facts = this.preparedTrust.get(prepared as object);
    if (!facts || facts.scopeKey !== canonicalScopeKey(scope))
      throw invalidPreparedTrustError();
    this.assertProjectExists(scope);

    const currentIdentity = canonicalSyntheticIdentity(
      this.safeEffectiveSelection(scope),
    );
    let synthetic = invalidSynthetic(null, "source_changed");
    if (
      facts.initialIdentity &&
      currentIdentity &&
      facts.initialIdentity.canonical === currentIdentity.canonical &&
      facts.initialDigest
    ) {
      const providerId = `synthetic:v1:${currentIdentity.kind}:${facts.initialDigest}`;
      let runtimeReason: SyntheticInvalidReason | null = null;
      try {
        this.runtimeRegistry.assertRunnable(
          this.syntheticRuntimeDescriptor(currentIdentity),
          "agent-workflow",
        );
      } catch {
        runtimeReason = "runtime_incompatible";
      }
      if (runtimeReason) {
        synthetic = invalidSynthetic(providerId, runtimeReason);
      } else if (!facts.claudeInstalled) {
        synthetic = invalidSynthetic(providerId, "claude_cli_unavailable");
      } else {
        synthetic = {
          providerId,
          invalidReason: "source_changed",
          candidate: {
            providerId,
            providerName: currentIdentity.providerName,
            modelId: currentIdentity.modelId,
            modelDisplayName: null,
            runtimeType: "claude-code",
            executionSource:
              currentIdentity.kind === "environment"
                ? "environment"
                : "claude_code",
            health: { state: "connected", lastTestedAt: null },
          },
        };
      }
    } else if (facts.initialIdentity && facts.initialDigest === null) {
      synthetic = invalidSynthetic(null, "runtime_incompatible");
    }

    return this.buildFinalSnapshot(scope, synthetic, facts.claudeInstalled);
  }

  private safeSyntheticDigest(canonicalIdentity: string): string | null {
    try {
      const value = this.syntheticIdentityHmac.digestSha256(canonicalIdentity);
      return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
        ? value
        : null;
    } catch {
      return null;
    }
  }

  private safeEffectiveSelection(
    scope: ModelTierScope,
  ): EffectiveSyntheticTierSelection | null {
    try {
      return this.resolveEffectiveSyntheticSelection(scope);
    } catch {
      return null;
    }
  }

  private syntheticRuntimeDescriptor(
    identity: CanonicalSyntheticIdentity,
  ): RuntimeProviderDescriptor {
    const trusted = this.capabilityResolver.resolve(
      identity.providerType,
      identity.apiFormat,
    );
    return {
      id: `synthetic-current:${identity.kind}`,
      name: identity.providerName,
      type: identity.providerType,
      apiFormat: identity.apiFormat,
      runtimeType: trusted.runtimeType,
      enabled: true,
      configured: true,
      capabilities: { ...trusted.capabilities },
    };
  }

  private buildFinalSnapshot(
    scope: ModelTierScope,
    preparedSynthetic: PreparedSyntheticCandidate,
    claudeInstalled: boolean,
  ): FinalSnapshot {
    this.assertProjectExists(scope);

    const candidates: ModelTierCandidatePublic[] = [];
    const applicationProviders = new Map<string, ApplicationProviderFact>();
    const providers = this.listAllProviders();
    const occupiedProviderIds = new Set(providers.map(({ id }) => id));

    for (const provider of providers) {
      if (provider.id.startsWith("synthetic:")) continue;
      if (!normalizedIdentity(provider.id, PROVIDER_ID_MAX_LENGTH)) continue;

      const models = this.repository
        .listModels(provider.id)
        .filter((item) => item.providerId === provider.id);
      const persistableModels = models.filter(
        (item) =>
          normalizedIdentity(item.modelId, MODEL_ID_MAX_LENGTH) !== null,
      );
      const stateReason = this.providerStateReason(provider);
      const runtimeReason = this.applicationRuntimeReason(
        provider,
        claudeInstalled,
      );
      applicationProviders.set(provider.id, {
        provider,
        modelIds: new Set(models.map(({ modelId }) => modelId)),
        stateReason,
        runtimeReason,
      });
      if (stateReason || runtimeReason) continue;
      for (const model of persistableModels)
        candidates.push(applicationCandidate(provider, model));
    }

    let syntheticInvalidReason = preparedSynthetic.invalidReason;
    const syntheticCollision =
      preparedSynthetic.providerId !== null &&
      occupiedProviderIds.has(preparedSynthetic.providerId);
    if (preparedSynthetic.candidate && !syntheticCollision) {
      candidates.push(preparedSynthetic.candidate);
    } else if (syntheticCollision) {
      syntheticInvalidReason = "source_changed";
    }

    const bindings = new Map<ModelTier, SelectedBinding>();
    for (const tier of MODEL_TIERS)
      bindings.set(tier, this.selectBinding(scope, tier));
    return {
      candidates,
      applicationProviders,
      bindings,
      syntheticProviderId: preparedSynthetic.providerId,
      syntheticInvalidReason,
    };
  }

  private listAllProviders(): StoredModelProvider[] {
    const providers: StoredModelProvider[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const page = this.repository.listProviders({
        limit: PROVIDER_PAGE_SIZE,
        offset,
      });
      providers.push(...page.items);
      total = page.total;
      if (page.items.length === 0) break;
      offset += page.items.length;
    }
    return providers;
  }

  private selectBinding(
    scope: ModelTierScope,
    tier: ModelTier,
  ): SelectedBinding {
    if (scope.type === "project") {
      const project = this.repository.getProjectModelTierBinding(
        scope.projectId,
        tier,
      );
      if (project) return { source: "project", binding: project };
    }
    const global = this.repository.getModelTierBinding(tier);
    return global
      ? { source: "global", binding: global }
      : { source: "none", binding: null };
  }

  private providerStateReason(
    provider: StoredModelProvider,
  ): ApplicationProviderFact["stateReason"] {
    if (!provider.enabled) return "provider_disabled";
    if (!usableCredentialReference(provider.credentialRef))
      return "provider_unconfigured";
    try {
      if (this.credentialExists(provider.credentialRef) !== true)
        return "provider_unconfigured";
    } catch {
      return "provider_unconfigured";
    }
    if (
      provider.health.state !== "connected" ||
      provider.health.lastTestedAt === null
    ) {
      return "connection_unavailable";
    }
    return null;
  }

  private applicationRuntimeReason(
    provider: StoredModelProvider,
    claudeInstalled: boolean,
  ): ApplicationProviderFact["runtimeReason"] {
    const trusted = this.capabilityResolver.resolve(
      provider.type,
      provider.apiFormat,
      provider.capabilities,
    );
    if (
      provider.runtimeType !== trusted.runtimeType ||
      trusted.runtimeType !== "claude-code" ||
      !trusted.capabilities.supportsClaudeCode
    ) {
      return "runtime_incompatible";
    }
    if (!trusted.capabilities.supportsAgentWorkflow)
      return "workflow_capability_missing";
    if (!claudeInstalled) return "runtime_incompatible";

    const descriptor: RuntimeProviderDescriptor = {
      id: provider.id,
      name: provider.name,
      type: provider.type,
      apiFormat: provider.apiFormat,
      runtimeType: trusted.runtimeType,
      enabled: provider.enabled,
      configured: true,
      capabilities: { ...trusted.capabilities },
    };
    try {
      this.runtimeRegistry.assertRunnable(descriptor, "agent-workflow");
      return null;
    } catch {
      return "runtime_incompatible";
    }
  }

  private invalidReason(
    binding: BoundModelTierBinding,
    snapshot: FinalSnapshot,
  ): Exclude<ModelTierInvalidReason, "tier_unbound"> {
    if (binding.providerId.startsWith("synthetic:")) {
      if (
        !SYNTHETIC_PROVIDER_ID.test(binding.providerId) ||
        binding.providerId !== snapshot.syntheticProviderId
      ) {
        return "source_changed";
      }
      return snapshot.syntheticInvalidReason;
    }

    const fact = snapshot.applicationProviders.get(binding.providerId);
    if (!fact) return "provider_deleted";
    if (fact.stateReason) return fact.stateReason;
    if (!fact.modelIds.has(binding.modelId)) return "model_missing";
    if (fact.runtimeReason) return fact.runtimeReason;
    return "runtime_incompatible";
  }

  private assertProjectExists(scope: ModelTierScope): void {
    if (scope.type === "project" && !this.safeProjectExists(scope.projectId)) {
      throw projectNotFoundError();
    }
  }

  private safeProjectExists(projectId: string): boolean {
    try {
      return this.projectExists(projectId) === true;
    } catch {
      return false;
    }
  }
}

function applicationCandidate(
  provider: StoredModelProvider,
  item: StoredProviderModel,
): ModelTierCandidatePublic {
  return {
    providerId: provider.id,
    providerName: provider.name,
    modelId: item.modelId,
    modelDisplayName: item.displayName,
    runtimeType: "claude-code",
    executionSource: "database_provider",
    health: {
      state: "connected",
      lastTestedAt: provider.health.lastTestedAt,
    },
  };
}

function canonicalSyntheticIdentity(
  selection: EffectiveSyntheticTierSelection | null,
): CanonicalSyntheticIdentity | null {
  if (
    !selection ||
    (selection.kind !== "environment" && selection.kind !== "claude_code")
  ) {
    return null;
  }
  const modelId = normalizedIdentity(selection.modelId, MODEL_ID_MAX_LENGTH);
  if (!modelId) return null;

  if (selection.kind === "claude_code") {
    return {
      canonical: JSON.stringify({
        version: 1,
        sourceKind: "claude_code",
        sourceIdentity: "claude-code:default",
        model: modelId,
        authenticationMode: "claude_code",
      }),
      kind: "claude_code",
      providerName: normalizedDisplayName(
        selection.providerName,
        "Claude Code",
      ),
      providerType: "anthropic",
      apiFormat: "anthropic-messages",
      modelId,
    };
  }

  if (
    selection.authenticationMode !== "api_key" &&
    selection.authenticationMode !== "auth_token"
  ) {
    return null;
  }

  let sourceIdentity = "anthropic:default";
  let providerType: ModelProviderType = "anthropic";
  if (selection.baseUrl !== null) {
    if (
      typeof selection.baseUrl !== "string" ||
      selection.baseUrl.length > SOURCE_IDENTITY_MAX_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(selection.baseUrl)
    ) {
      return null;
    }
    try {
      sourceIdentity = normalizeProviderBaseUrl(selection.baseUrl);
      if (sourceIdentity.length > SOURCE_IDENTITY_MAX_LENGTH) return null;
      providerType = "anthropic-compatible";
    } catch {
      return null;
    }
  }

  return {
    canonical: JSON.stringify({
      version: 1,
      sourceKind: "environment",
      sourceIdentity,
      model: modelId,
      authenticationMode: selection.authenticationMode,
    }),
    kind: "environment",
    providerName: normalizedDisplayName(selection.providerName, "Environment"),
    providerType,
    apiFormat: "anthropic-messages",
    modelId,
  };
}

function invalidSynthetic(
  providerId: string | null,
  invalidReason: SyntheticInvalidReason,
): PreparedSyntheticCandidate {
  return { candidate: null, providerId, invalidReason };
}

function usableCredentialReference(value: string | null): value is string {
  return (
    value !== null &&
    value.length <= 512 &&
    value === value.trim() &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function bindingFields(binding: ModelTierBindingRecord) {
  return binding.providerId === null
    ? ({
        tier: binding.tier,
        providerId: null,
        modelId: null,
        updatedAt: binding.updatedAt,
      } as const)
    : {
        tier: binding.tier,
        providerId: binding.providerId,
        modelId: binding.modelId,
        updatedAt: binding.updatedAt,
      };
}

function displayFields(binding: ModelTierBindingRecord | null | undefined) {
  return {
    displayName: binding?.displayName ?? null,
    quality: binding?.quality ?? null,
    speed: binding?.speed ?? null,
    cost: binding?.cost ?? null,
  };
}

function emptyDisplay(tier: ModelTier) {
  return {
    tier,
    displayName: null,
    quality: null,
    speed: null,
    cost: null,
  };
}

function validResolution(
  scope: ModelTierScope,
  tier: ModelTier,
  source: "global" | "project",
  binding: ModelTierBindingRecord,
  candidate: ModelTierCandidatePublic,
): ModelTierResolutionPublic {
  const publicBinding = bindingFields(binding);
  if (publicBinding.providerId === null) {
    throw new ModelTierServiceError(
      "TIER_CANDIDATE_INVALID",
      "The selected model binding is inconsistent.",
    );
  }
  return {
    scope,
    tier,
    display: { tier, ...displayFields(binding) },
    source,
    binding: publicBinding,
    candidate,
    validity: "valid",
    invalidReason: null,
  };
}

function normalizedIdentity(
  value: string,
  maximumLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized !== value ||
    normalized.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizedDisplayName(value: string, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized &&
    normalized.length <= 80 &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : fallback;
}

function closedScope(scope: ModelTierScope): ModelTierScope {
  if (!scope || scope.type === "global") {
    if (scope?.type === "global") return { type: "global" };
    throw new ModelTierServiceError(
      "TIER_CANDIDATE_INVALID",
      "Model tier scope is invalid.",
    );
  }
  if (scope.type !== "project" || !normalizedIdentity(scope.projectId, 128)) {
    throw new ModelTierServiceError(
      "TIER_CANDIDATE_INVALID",
      "Model tier scope is invalid.",
    );
  }
  return { type: "project", projectId: scope.projectId };
}

function canonicalScopeKey(scope: ModelTierScope): string {
  return scope.type === "global" ? "global" : `project:${scope.projectId}`;
}

function invalidPreparedTrustError(): ModelTierServiceError {
  return new ModelTierServiceError(
    "TIER_CANDIDATE_INVALID",
    "Prepared model tier trust is invalid.",
  );
}

function assertTier(tier: ModelTier): void {
  if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
    throw new ModelTierServiceError(
      "TIER_CANDIDATE_INVALID",
      "Model tier is invalid.",
    );
  }
}

function assertIdentity(value: string, label: string): void {
  const maximumLength =
    label === "Provider" ? PROVIDER_ID_MAX_LENGTH : MODEL_ID_MAX_LENGTH;
  if (!normalizedIdentity(value, maximumLength)) {
    throw new ModelTierServiceError(
      "TIER_CANDIDATE_INVALID",
      `${label} identity is invalid.`,
    );
  }
}

function projectNotFoundError(): ModelTierServiceError {
  return new ModelTierServiceError(
    "PROJECT_NOT_FOUND",
    "The selected project no longer exists.",
  );
}

function closedDisplayMetadata(
  value: UpdateModelTierDisplayMetadataRequest["metadata"],
): UpdateModelTierDisplayMetadataRequest["metadata"] {
  assertTier(value?.tier);
  const displayName = value.displayName;
  if (
    displayName !== null
    && (
      typeof displayName !== "string"
      || displayName.length < 1
      || displayName.length > 80
      || displayName !== displayName.trim()
      || /[\u0000-\u001f\u007f]/u.test(displayName)
    )
  ) {
    throw new ModelTierServiceError(
      "TIER_CANDIDATE_INVALID",
      "Model tier display metadata is invalid.",
    );
  }
  const ratings = [value.quality, value.speed, value.cost];
  if (ratings.some((rating) => rating !== null && !["low", "medium", "high"].includes(rating))) {
    throw new ModelTierServiceError(
      "TIER_CANDIDATE_INVALID",
      "Model tier display metadata is invalid.",
    );
  }
  return {
    tier: value.tier,
    displayName,
    quality: value.quality,
    speed: value.speed,
    cost: value.cost,
  };
}
