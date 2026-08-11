import type {
  ModelPolicyAgentType,
  ModelSelectionSource,
  ResolvedModelSelection,
  WorkflowModelPolicySnapshotRequest,
  WorkflowModelSelectionPolicy,
} from '../../shared/types/modelProviders';
import {
  MODEL_POLICY_AGENT_TYPES,
  UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE,
} from '../../shared/types/modelProviders';
import type {
  ModelTier,
  ModelTierCandidatePublic,
  ModelTierInvalidReason,
  ModelTierResolutionPublic,
  ModelTierScope,
  PersistedModelPolicyReference,
} from '../../shared/types/modelTiers';
import type { AgentRuntimeUse, RuntimeProviderDescriptor } from './AgentRuntime';
import { ProviderCapabilityResolver } from './ProviderCapabilityResolver';
import type { StoredModelProvider, StoredProviderModel } from './ModelProviderService';
import type { PreparedModelTierTrust } from './ModelTierService';
import type {
  ProjectAiUnavailableReason,
  TaskModelSwitchOptionPublic,
} from '../../shared/types/projectAi';

export type ProjectModelPolicyAgentType = ModelPolicyAgentType | 'default';

export interface PersistedModelSelection {
  providerId: string;
  modelId: string;
}

export interface ModelSelectionStore {
  getTaskModelOverride(taskId: string): PersistedModelSelection | null;
  setTaskModelOverride(value: PersistedModelSelection & {
    taskId: string;
    createdAt: number;
    updatedAt: number;
  }): void;
  deleteTaskModelOverride(taskId: string): void;
  getProjectModelPolicy(
    projectId: string,
    agentType: ProjectModelPolicyAgentType,
  ): PersistedModelSelection | null;
  getAgentModelPolicy(agentType: ModelPolicyAgentType): PersistedModelSelection | null;
  getProjectModelPolicyReference?(
    projectId: string,
    agentType: ProjectModelPolicyAgentType,
  ): { reference: PersistedModelPolicyReference } | null;
  getAgentModelPolicyReference?(
    agentType: ModelPolicyAgentType,
  ): { reference: PersistedModelPolicyReference } | null;
  getDefaultProvider(): StoredModelProvider | null;
  getProvider(providerId: string): StoredModelProvider | null;
  listModels(providerId: string): StoredProviderModel[];
  listProviders(input: { limit: number; offset: number; enabled?: boolean }): {
    items: StoredModelProvider[];
    total: number;
    limit: number;
    offset: number;
  };
}

export interface ModelTierResolverPort {
  resolveTier(scope: ModelTierScope, tier: ModelTier):
    Promise<ModelTierResolutionPublic>;
  listCandidates(scope: ModelTierScope): Promise<ModelTierCandidatePublic[]>;
  prepareTrustedSnapshot?(scope: ModelTierScope): Promise<PreparedModelTierTrust>;
  resolvePreparedBindings?(
    scope: ModelTierScope,
    prepared: PreparedModelTierTrust,
  ): ModelTierResolutionPublic[];
}

export interface RuntimeGate {
  assertRunnable(provider: RuntimeProviderDescriptor, use: AgentRuntimeUse): unknown;
}

export interface ModelSelectionRequest {
  taskId?: string;
  projectId?: string;
  agentType?: ModelPolicyAgentType;
  fallbackModelId?: string | null;
  use: AgentRuntimeUse;
}

export interface SetTaskModelOverrideInput extends PersistedModelSelection {
  taskId: string;
  status: string;
}

export class ModelSwitchError extends Error {
  constructor(
    readonly code: 'TASK_ACTIVE' | 'INVALID_SELECTION',
    message: string,
  ) {
    super(message);
    this.name = 'ModelSwitchError';
  }
}

export const MODEL_SELECTION_FAILURE_CODES = [
  'TIER_UNBOUND',
  'PROVIDER_DELETED',
  'PROVIDER_DISABLED',
  'PROVIDER_UNCONFIGURED',
  'CONNECTION_UNAVAILABLE',
  'MODEL_MISSING',
  'RUNTIME_INCOMPATIBLE',
  'WORKFLOW_CAPABILITY_MISSING',
  'SOURCE_CHANGED',
  'CLAUDE_CLI_UNAVAILABLE',
  'SELECTION_UNAVAILABLE',
] as const;

export type ModelSelectionFailureCode = (typeof MODEL_SELECTION_FAILURE_CODES)[number];

/** Main-process-only typed resolution failure. Human text is never parsed for authority. */
export class ModelSelectionFailure extends Error {
  constructor(
    readonly code: ModelSelectionFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelSelectionFailure';
  }
}

export interface ModelSelectionResolverDependencies {
  store: ModelSelectionStore;
  runtimeGate: RuntimeGate;
  credentialExists(reference: string): boolean;
  resolveEnvironmentSelection?: (fallbackModelId: string) => ResolvedModelSelection | null;
  tierResolver?: ModelTierResolverPort;
  now?: () => number;
}

export type ProjectPolicyInspection =
  | {
      available: true;
      selection: ResolvedModelSelection & {
        source: Exclude<ModelSelectionSource, 'task_override'>;
      };
    }
  | { available: false; reason: ProjectAiUnavailableReason };

const FUTURE_CALLS_WARNING = '模型改变只影响后续 Agent 调用。';
const ACTIVE_SWITCH_STATUSES = new Set(['starting', 'running', 'waiting_permission']);

export class ModelSelectionResolver {
  private readonly store: ModelSelectionStore;
  private readonly runtimeGate: RuntimeGate;
  private readonly credentialExists: (reference: string) => boolean;
  private readonly resolveEnvironmentSelection: (
    fallbackModelId: string,
  ) => ResolvedModelSelection | null;
  private readonly now: () => number;
  private readonly tierResolver?: ModelTierResolverPort;
  private readonly capabilities = new ProviderCapabilityResolver();

  constructor(dependencies: ModelSelectionResolverDependencies) {
    this.store = dependencies.store;
    this.runtimeGate = dependencies.runtimeGate;
    this.credentialExists = dependencies.credentialExists;
    this.resolveEnvironmentSelection = dependencies.resolveEnvironmentSelection ?? (() => null);
    this.tierResolver = dependencies.tierResolver;
    this.now = dependencies.now ?? Date.now;
  }

  async resolve(request: ModelSelectionRequest): Promise<ResolvedModelSelection> {
    return this.resolveRequest(request);
  }

  /**
   * Resolves a project's baseline role policy without accepting or consulting a task ID.
   * The caller supplies one main-prepared tier snapshot shared by all inspected roles.
   */
  async inspectProjectPolicy(
    request: {
      projectId: string;
      agentType: ModelPolicyAgentType;
      fallbackModelId: string | null;
      includesTaskOverride: false;
    },
    tierResolutions: ReadonlyMap<ModelTier, ModelTierResolutionPublic>,
  ): Promise<ProjectPolicyInspection> {
    try {
      const selection = await this.resolveRequest({
          projectId: request.projectId,
          agentType: request.agentType,
          fallbackModelId: request.fallbackModelId,
          use: 'agent-workflow',
        }, tierResolutions);
      if (!isProjectBaselineSelection(selection)) {
        return { available: false, reason: 'selection_unavailable' };
      }
      return { available: true, selection };
    } catch (error) {
      return { available: false, reason: projectInspectionReason(error) };
    }
  }

  /** Lists only trusted database-backed models runnable by the current Agent Runtime. */
  listTaskModelSwitchOptions(): TaskModelSwitchOptionPublic[] {
    const result: TaskModelSwitchOptionPublic[] = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const page = this.store.listProviders({ limit, offset, enabled: true });
      for (const provider of page.items) {
        try {
          this.assertTaskSwitchProvider(provider);
        } catch {
          continue;
        }
        for (const model of this.store.listModels(provider.id)) {
          if (!this.providerOwnsModel(provider.id, model.modelId, model)) continue;
          result.push({
            providerId: provider.id,
            providerName: provider.name,
            modelId: model.modelId,
            modelDisplayName: model.displayName,
            runtimeType: 'claude-code',
          });
        }
      }
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
    return result;
  }

  private async resolveRequest(
    request: ModelSelectionRequest,
    tierResolutions?: ReadonlyMap<ModelTier, ModelTierResolutionPublic>,
  ): Promise<ResolvedModelSelection> {
    if (request.taskId) {
      const task = this.store.getTaskModelOverride(request.taskId);
      if (task) return this.resolveReference(task, 'task_override', request);
    }

    const roleCandidates = agentRoleCandidates(request.agentType);
    if (request.projectId) {
      for (const role of roleCandidates) {
        const policy = this.projectPolicyReference(request.projectId, role);
        if (policy) {
          return this.resolvePolicyReference(policy, 'project_policy', request, tierResolutions);
        }
      }
      const projectDefault = this.projectPolicyReference(request.projectId, 'default');
      if (projectDefault) {
        if (projectDefault.kind !== 'model') {
          throw new ModelSelectionFailure(
            'SELECTION_UNAVAILABLE',
            'Project default model cannot reference a tier.',
          );
        }
        return this.resolveReference(projectDefault, 'project_policy', request);
      }
    }

    for (const role of roleCandidates) {
      const policy = this.agentPolicyReference(role);
      if (policy) {
        return this.resolvePolicyReference(policy, 'global_agent_policy', request, tierResolutions);
      }
    }

    const globalDefault = this.store.getDefaultProvider();
    if (globalDefault) {
      if (!globalDefault.defaultModelId) {
        throw new ModelSelectionFailure(
          'MODEL_MISSING',
          'Global default Provider has no default model.',
        );
      }
      return this.resolveReference(
        { providerId: globalDefault.id, modelId: globalDefault.defaultModelId },
        'global_default',
        request,
      );
    }

    const fallbackModelId = request.fallbackModelId?.trim() || 'default';
    const environment = this.resolveEnvironmentSelection(fallbackModelId);
    if (environment) return this.validateSyntheticSelection(environment, request);
    return this.claudeCodeFallback(fallbackModelId, request);
  }

  /** Captures every role once; later policy edits cannot change this Workflow. */
  async snapshotWorkflowPolicy(
    request: WorkflowModelPolicySnapshotRequest,
  ): Promise<WorkflowModelSelectionPolicy> {
    let tierResolutions: ReadonlyMap<ModelTier, ModelTierResolutionPublic> | undefined;
    if (this.tierResolver?.prepareTrustedSnapshot && this.tierResolver.resolvePreparedBindings) {
      const scope = tierScope(request);
      const prepared = await this.tierResolver.prepareTrustedSnapshot(scope);
      tierResolutions = new Map(
        this.tierResolver.resolvePreparedBindings(scope, prepared)
          .map((resolution) => [resolution.tier, resolution]),
      );
    }
    const entries = await Promise.all(MODEL_POLICY_AGENT_TYPES.map(async (agentType) => [
      agentType,
      await this.resolveRequest({
        taskId: request.taskId,
        projectId: request.projectId,
        agentType,
        fallbackModelId: request.fallbackModelIds[agentType],
        use: 'agent-workflow',
      }, tierResolutions),
    ] as const));
    const snapshot = Object.fromEntries(entries) as Record<ModelPolicyAgentType, ResolvedModelSelection>;
    return Object.freeze(snapshot);
  }

  /**
   * Rechecks the current Provider/model/runtime facts without consulting any
   * mutable task, project, global, or role policy.
   */
  async revalidatePinnedSelection(
    pinned: ResolvedModelSelection,
    request: ModelSelectionRequest,
  ): Promise<ResolvedModelSelection> {
    let current: ResolvedModelSelection;
    if (pinned.tier) {
      if (!this.tierResolver) throw new Error('Pinned tier resolver is unavailable.');
      const candidate = (await this.tierResolver.listCandidates(tierScope(request)))
        .find((item) => item.providerId === pinned.providerId
          && item.modelId === pinned.modelId
          && item.runtimeType === pinned.runtimeType
          && item.executionSource === pinned.executionSource);
      if (!candidate) throw new Error('Pinned Workflow execution identity changed.');
      current = candidate.executionSource === 'database_provider'
        ? this.resolveReference(candidate, pinned.source, request)
        : this.resolveSyntheticTierCandidate(
            candidate,
            pinned.source,
            pinned.tier,
            pinned.tierSource,
            request,
          );
    } else if (pinned.executionSource === 'database_provider') {
      current = this.resolveReference(
        { providerId: pinned.providerId, modelId: pinned.modelId },
        pinned.source,
        request,
      );
    } else if (pinned.executionSource === 'environment') {
      const environment = this.resolveEnvironmentSelection(pinned.modelId);
      if (!environment
        || environment.providerId !== pinned.providerId
        || environment.executionSource !== 'environment') {
        throw new Error('Pinned environment Provider is no longer configured.');
      }
      current = this.validateSyntheticSelection(environment, request);
    } else if (pinned.executionSource === 'claude_code') {
      if (pinned.providerId !== 'claude-code:default') {
        throw new Error('Pinned Claude Code Provider identity is invalid.');
      }
      current = this.claudeCodeFallback(pinned.modelId, request);
    } else {
      throw new Error('Pinned Workflow execution source is invalid.');
    }
    if (
      current.providerId !== pinned.providerId
      || current.modelId !== pinned.modelId
      || current.runtimeType !== pinned.runtimeType
      || current.executionSource !== pinned.executionSource
    ) {
      throw new Error('Pinned Workflow Provider identity or runtime changed.');
    }
    return pinned.tier
      ? immutableSelection({
          ...current,
          source: pinned.source,
          tier: pinned.tier,
          tierSource: pinned.tierSource,
        })
      : immutableSelection({ ...current, source: pinned.source });
  }

  setTaskOverride(input: SetTaskModelOverrideInput): {
    providerId: string;
    modelId: string;
    warning: string;
  } {
    assertSwitchAllowed(input.status);
    const provider = this.store.getProvider(input.providerId);
    if (!provider) {
      throw new ModelSelectionFailure('PROVIDER_DELETED', 'Selected Provider was not found.');
    }
    const trusted = this.assertTaskSwitchProvider(provider);
    if (!this.providerOwnsModel(provider.id, input.modelId)) {
      throw new ModelSelectionFailure(
        'MODEL_MISSING',
        'Selected model does not belong to the Provider.',
      );
    }
    const resolved = immutableSelection({
      providerId: provider.id,
      providerName: provider.name,
      modelId: input.modelId,
      runtimeType: 'claude-code',
      capabilities: trusted.capabilities,
      source: 'task_override',
      executionSource: 'database_provider',
    });
    const now = this.now();
    this.store.setTaskModelOverride({
      taskId: input.taskId,
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      createdAt: now,
      updatedAt: now,
    });
    return {
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      warning: FUTURE_CALLS_WARNING,
    };
  }

  clearTaskOverride(taskId: string, status: string): { warning: string } {
    assertSwitchAllowed(status);
    this.store.deleteTaskModelOverride(taskId);
    return { warning: FUTURE_CALLS_WARNING };
  }

  private assertTaskSwitchProvider(
    provider: StoredModelProvider,
  ): ReturnType<ProviderCapabilityResolver['resolve']> & { runtimeType: 'claude-code' } {
    if (isReservedProviderId(provider.id)) {
      throw new ModelSelectionFailure(
        'SELECTION_UNAVAILABLE',
        'Reserved internal Provider identities cannot be selected.',
      );
    }
    if (!provider.enabled) {
      throw new ModelSelectionFailure(
        'PROVIDER_DISABLED',
        `Selected Provider is disabled: ${provider.name}`,
      );
    }
    if (!this.hasCredential(provider.credentialRef)) {
      throw new ModelSelectionFailure(
        'PROVIDER_UNCONFIGURED',
        `Selected Provider is not configured: ${provider.name}`,
      );
    }
    if (provider.health.state !== 'connected' || provider.health.lastTestedAt === null) {
      throw new ModelSelectionFailure(
        'CONNECTION_UNAVAILABLE',
        'Selected Provider does not have a current successful connection test.',
      );
    }
    const trusted = this.capabilities.resolve(
      provider.type,
      provider.apiFormat,
      provider.capabilities,
    );
    if (trusted.runtimeType !== 'claude-code' || !trusted.capabilities.supportsClaudeCode) {
      throw new ModelSelectionFailure(
        'RUNTIME_INCOMPATIBLE',
        UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE,
      );
    }
    if (!trusted.capabilities.supportsAgentWorkflow) {
      throw new ModelSelectionFailure(
        'WORKFLOW_CAPABILITY_MISSING',
        'Current Provider does not support Agent Workflow.',
      );
    }
    this.assertRuntimeRunnable({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      apiFormat: provider.apiFormat,
      runtimeType: trusted.runtimeType,
      enabled: true,
      configured: true,
      capabilities: { ...trusted.capabilities },
    }, 'agent-workflow');
    return trusted as ReturnType<ProviderCapabilityResolver['resolve']> & {
      runtimeType: 'claude-code';
    };
  }

  private providerOwnsModel(
    providerId: string,
    modelId: string,
    knownModel?: StoredProviderModel,
  ): boolean {
    if (knownModel) {
      return knownModel.providerId === providerId && knownModel.modelId === modelId;
    }
    return this.store.listModels(providerId)
      .some((model) => model.providerId === providerId && model.modelId === modelId);
  }

  private assertRuntimeRunnable(
    descriptor: RuntimeProviderDescriptor,
    use: AgentRuntimeUse,
  ): void {
    try {
      this.runtimeGate.assertRunnable(descriptor, use);
    } catch (error) {
      if (selectionFailureCode(error)) throw error;
      throw new ModelSelectionFailure(
        'RUNTIME_INCOMPATIBLE',
        'The selected Provider is unavailable to the current Agent Runtime.',
      );
    }
  }

  private resolveReference(
    reference: PersistedModelSelection,
    source: ModelSelectionSource,
    request: Pick<ModelSelectionRequest, 'agentType' | 'use'>,
  ): ResolvedModelSelection {
    const provider = this.store.getProvider(reference.providerId);
    if (!provider) {
      throw new ModelSelectionFailure('PROVIDER_DELETED', 'Selected Provider was not found.');
    }
    if (isReservedProviderId(provider.id)) {
      throw new ModelSelectionFailure(
        'SELECTION_UNAVAILABLE',
        'Reserved internal Provider identities cannot be selected.',
      );
    }
    if (!provider.enabled) {
      throw new ModelSelectionFailure(
        'PROVIDER_DISABLED',
        `Selected Provider is disabled: ${provider.name}`,
      );
    }
    if (!this.hasCredential(provider.credentialRef)) {
      throw new ModelSelectionFailure(
        'PROVIDER_UNCONFIGURED',
        `Selected Provider is not configured: ${provider.name}`,
      );
    }
    if (provider.health.state !== 'connected' || provider.health.lastTestedAt === null) {
      throw new ModelSelectionFailure(
        'CONNECTION_UNAVAILABLE',
        'Selected Provider does not have a current successful connection test.',
      );
    }
    if (!this.providerOwnsModel(provider.id, reference.modelId)) {
      throw new ModelSelectionFailure(
        'MODEL_MISSING',
        'Selected model does not belong to the Provider.',
      );
    }

    const trusted = this.capabilities.resolve(
      provider.type,
      provider.apiFormat,
      provider.capabilities,
    );
    if (trusted.runtimeType !== 'claude-code' || !trusted.capabilities.supportsClaudeCode) {
      throw new ModelSelectionFailure(
        'RUNTIME_INCOMPATIBLE',
        UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE,
      );
    }
    assertWorkflowCapabilities(trusted.capabilities, request);
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
    this.assertRuntimeRunnable(descriptor, request.use);
    return immutableSelection({
      providerId: provider.id,
      providerName: provider.name,
      modelId: reference.modelId,
      runtimeType: trusted.runtimeType,
      capabilities: trusted.capabilities,
      source,
      executionSource: 'database_provider',
    });
  }

  private async resolvePolicyReference(
    reference: PersistedModelPolicyReference,
    source: Extract<ModelSelectionSource, 'project_policy' | 'global_agent_policy'>,
    request: ModelSelectionRequest,
    tierResolutions?: ReadonlyMap<ModelTier, ModelTierResolutionPublic>,
  ): Promise<ResolvedModelSelection> {
    if (reference.kind === 'model') return this.resolveReference(reference, source, request);
    if (!this.tierResolver) {
      throw new ModelSelectionFailure(
        'SELECTION_UNAVAILABLE',
        'Selected model tier cannot be resolved.',
      );
    }
    const resolution = tierResolutions?.get(reference.tier)
      ?? await this.tierResolver.resolveTier(tierScope(request), reference.tier);
    if (resolution.validity !== 'valid') {
      throw new ModelSelectionFailure(
        tierFailureCode(resolution.invalidReason),
        'Selected model tier needs reconfiguration.',
      );
    }
    return this.resolveTierCandidate(resolution, source, request);
  }

  private hasCredential(reference: string | null): boolean {
    if (!reference) return false;
    try {
      return this.credentialExists(reference);
    } catch {
      return false;
    }
  }

  private resolveTierCandidate(
    resolution: ModelTierResolutionPublic & { validity: 'valid' },
    source: Extract<ModelSelectionSource, 'project_policy' | 'global_agent_policy'>,
    request: ModelSelectionRequest,
  ): ResolvedModelSelection {
    const candidate = resolution.candidate;
    if (candidate.executionSource === 'database_provider') {
      const resolved = this.resolveReference(candidate, source, request);
      return immutableSelection({
        ...resolved,
        tier: resolution.tier,
        tierSource: resolution.source,
      });
    }
    return this.resolveSyntheticTierCandidate(
      candidate,
      source,
      resolution.tier,
      resolution.source,
      request,
    );
  }

  private resolveSyntheticTierCandidate(
    candidate: ModelTierCandidatePublic,
    source: ModelSelectionSource,
    tier: NonNullable<ResolvedModelSelection['tier']>,
    tierSource: NonNullable<ResolvedModelSelection['tierSource']>,
    request: ModelSelectionRequest,
  ): ResolvedModelSelection {
    let base: ResolvedModelSelection;
    if (candidate.executionSource === 'environment') {
      const environment = this.resolveEnvironmentSelection(candidate.modelId);
      if (!environment || environment.executionSource !== 'environment') {
        throw new ModelSelectionFailure(
          'SOURCE_CHANGED',
          'Selected environment tier source is no longer configured.',
        );
      }
      base = this.validateSyntheticSelection({
        ...environment,
        providerId: candidate.providerId,
        providerName: candidate.providerName,
        modelId: candidate.modelId,
        source,
        executionSource: 'environment',
      }, request);
    } else if (candidate.executionSource === 'claude_code') {
      base = immutableSelection({
        ...this.claudeCodeFallback(candidate.modelId, request),
        providerId: candidate.providerId,
        providerName: candidate.providerName,
        source,
        executionSource: 'claude_code',
      });
    } else {
      throw new ModelSelectionFailure(
        'SOURCE_CHANGED',
        'Selected synthetic tier execution source is invalid.',
      );
    }
    return immutableSelection({ ...base, tier, tierSource });
  }

  private projectPolicyReference(
    projectId: string,
    agentType: ProjectModelPolicyAgentType,
  ): PersistedModelPolicyReference | null {
    const record = this.store.getProjectModelPolicyReference?.(projectId, agentType);
    if (record) return record.reference;
    const direct = this.store.getProjectModelPolicy(projectId, agentType);
    return direct ? { kind: 'model', ...direct } : null;
  }

  private agentPolicyReference(agentType: ModelPolicyAgentType): PersistedModelPolicyReference | null {
    const record = this.store.getAgentModelPolicyReference?.(agentType);
    if (record) return record.reference;
    const direct = this.store.getAgentModelPolicy(agentType);
    return direct ? { kind: 'model', ...direct } : null;
  }

  private validateSyntheticSelection(
    selection: ResolvedModelSelection,
    request: ModelSelectionRequest,
  ): ResolvedModelSelection {
    if (selection.runtimeType !== 'claude-code' || !selection.capabilities.supportsClaudeCode) {
      throw new ModelSelectionFailure(
        'RUNTIME_INCOMPATIBLE',
        UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE,
      );
    }
    assertWorkflowCapabilities(selection.capabilities, request);
    this.assertRuntimeRunnable({
      id: selection.providerId,
      name: selection.providerName,
      type: 'anthropic',
      apiFormat: 'anthropic-messages',
      runtimeType: selection.runtimeType,
      enabled: true,
      configured: true,
      capabilities: selection.capabilities,
    }, request.use);
    return immutableSelection(selection);
  }

  private claudeCodeFallback(
    modelId: string,
    request: ModelSelectionRequest,
  ): ResolvedModelSelection {
    const trusted = this.capabilities.resolve('anthropic', 'anthropic-messages');
    assertWorkflowCapabilities(trusted.capabilities, request);
    const descriptor: RuntimeProviderDescriptor = {
      id: 'claude-code:default',
      name: 'Claude Code',
      type: 'anthropic',
      apiFormat: 'anthropic-messages',
      runtimeType: 'claude-code',
      enabled: true,
      configured: true,
      capabilities: trusted.capabilities,
    };
    this.assertRuntimeRunnable(descriptor, request.use);
    return immutableSelection({
      providerId: descriptor.id,
      providerName: descriptor.name,
      modelId,
      runtimeType: 'claude-code',
      capabilities: trusted.capabilities,
      source: 'claude_code',
      executionSource: 'claude_code',
    });
  }
}

const PROJECT_REASON_BY_FAILURE_CODE: Readonly<
  Record<ModelSelectionFailureCode, ProjectAiUnavailableReason>
> = Object.freeze({
  TIER_UNBOUND: 'tier_unbound',
  PROVIDER_DELETED: 'provider_deleted',
  PROVIDER_DISABLED: 'provider_disabled',
  PROVIDER_UNCONFIGURED: 'provider_unconfigured',
  CONNECTION_UNAVAILABLE: 'connection_unavailable',
  MODEL_MISSING: 'model_missing',
  RUNTIME_INCOMPATIBLE: 'runtime_incompatible',
  WORKFLOW_CAPABILITY_MISSING: 'workflow_capability_missing',
  SOURCE_CHANGED: 'source_changed',
  CLAUDE_CLI_UNAVAILABLE: 'claude_cli_unavailable',
  SELECTION_UNAVAILABLE: 'selection_unavailable',
});

const MODEL_SELECTION_FAILURE_CODE_SET = new Set<string>(MODEL_SELECTION_FAILURE_CODES);

function selectionFailureCode(error: unknown): ModelSelectionFailureCode | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && MODEL_SELECTION_FAILURE_CODE_SET.has(code)
    ? code as ModelSelectionFailureCode
    : null;
}

function projectInspectionReason(error: unknown): ProjectAiUnavailableReason {
  const code = selectionFailureCode(error);
  return code ? PROJECT_REASON_BY_FAILURE_CODE[code] : 'selection_unavailable';
}

function tierFailureCode(reason: ModelTierInvalidReason | null): ModelSelectionFailureCode {
  const byReason: Readonly<Record<ModelTierInvalidReason, ModelSelectionFailureCode>> = {
    tier_unbound: 'TIER_UNBOUND',
    provider_deleted: 'PROVIDER_DELETED',
    provider_disabled: 'PROVIDER_DISABLED',
    provider_unconfigured: 'PROVIDER_UNCONFIGURED',
    connection_unavailable: 'CONNECTION_UNAVAILABLE',
    model_missing: 'MODEL_MISSING',
    runtime_incompatible: 'RUNTIME_INCOMPATIBLE',
    workflow_capability_missing: 'WORKFLOW_CAPABILITY_MISSING',
    source_changed: 'SOURCE_CHANGED',
    claude_cli_unavailable: 'CLAUDE_CLI_UNAVAILABLE',
  };
  return reason ? byReason[reason] : 'SELECTION_UNAVAILABLE';
}

function isReservedProviderId(providerId: string): boolean {
  return providerId.toLowerCase().startsWith('synthetic:');
}

function isProjectBaselineSelection(
  selection: ResolvedModelSelection,
): selection is ResolvedModelSelection & {
  source: Exclude<ModelSelectionSource, 'task_override'>;
} {
  return selection.source !== 'task_override';
}

function agentRoleCandidates(agentType?: ModelPolicyAgentType): ModelPolicyAgentType[] {
  if (!agentType) return [];
  if (agentType === 'tester' || agentType === 'fixer') return [agentType, 'coder'];
  return [agentType];
}

function tierScope(request: Pick<ModelSelectionRequest, 'projectId'>): ModelTierScope {
  return request.projectId
    ? { type: 'project', projectId: request.projectId }
    : { type: 'global' };
}

function assertWorkflowCapabilities(
  capabilities: StoredModelProvider['capabilities'],
  request: Pick<ModelSelectionRequest, 'agentType' | 'use'>,
): void {
  if (request.use !== 'agent-workflow') return;
  if (!capabilities.supportsAgentWorkflow) {
    throw new ModelSelectionFailure(
      'WORKFLOW_CAPABILITY_MISSING',
      'Current Provider does not support Agent Workflow.',
    );
  }
  if (request.agentType === 'coder'
    || request.agentType === 'tester'
    || request.agentType === 'fixer') {
    if (!capabilities.supportsTools || !capabilities.supportsMCP) {
      throw new ModelSelectionFailure(
        'WORKFLOW_CAPABILITY_MISSING',
        'Current Agent role requires Provider tools and MCP capabilities.',
      );
    }
  }
}

function immutableSelection(selection: ResolvedModelSelection): ResolvedModelSelection {
  return Object.freeze({
    ...selection,
    capabilities: Object.freeze({ ...selection.capabilities }),
  });
}

function assertSwitchAllowed(status: string): void {
  if (ACTIVE_SWITCH_STATUSES.has(status)) {
    throw new ModelSwitchError('TASK_ACTIVE', '正在运行任务时禁止切换模型。');
  }
}

export const modelSelectionInternals = {
  ACTIVE_SWITCH_STATUSES,
  FUTURE_CALLS_WARNING,
};
