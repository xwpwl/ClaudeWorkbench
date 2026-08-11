import { UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE } from '../../shared/types/modelProviders';
import type { PolicyRating, PublicAgentModelPolicyReference } from '../../shared/types/modelProviders';
import type { ModelTierScope } from '../../shared/types/modelTiers';
import type { RuntimeGate } from './ModelSelectionResolver';
import type {
  AgentModelPolicyRecord,
  AgentModelPolicyReferenceRecord,
  ProjectModelPolicyRecord,
  ProjectModelPolicyReferenceRecord,
} from './ModelProviderRepository';
import type { StoredModelProvider, StoredProviderModel } from './ModelProviderService';
import { ProviderCapabilityResolver } from './ProviderCapabilityResolver';

const AGENT_ROLE_ORDER = ['planner', 'coder', 'tester', 'reviewer', 'fixer'] as const;
const PROJECT_ROLE_ORDER = ['default', ...AGENT_ROLE_ORDER] as const;
const POLICY_RATINGS = new Set<PolicyRating>(['low', 'medium', 'high']);

export interface AgentModelPolicyStore {
  getProvider(providerId: string): StoredModelProvider | null;
  listModels(providerId: string): StoredProviderModel[];
  setAgentModelPolicy(policy: AgentModelPolicyRecord): void;
  getAgentModelPolicy(agentType: AgentModelPolicyRecord['agentType']): AgentModelPolicyRecord | null;
  listAgentModelPolicies(): AgentModelPolicyRecord[];
  deleteAgentModelPolicy(agentType: AgentModelPolicyRecord['agentType']): boolean;
  setAgentModelPolicyReference(policy: AgentModelPolicyReferenceRecord): void;
  getAgentModelPolicyReference(
    agentType: AgentModelPolicyRecord['agentType'],
  ): AgentModelPolicyReferenceRecord | null;
  listAgentModelPolicyReferences(): AgentModelPolicyReferenceRecord[];
  setProjectModelPolicy(policy: ProjectModelPolicyRecord): void;
  getProjectModelPolicy(
    projectId: string,
    agentType: ProjectModelPolicyRecord['agentType'],
  ): ProjectModelPolicyRecord | null;
  listProjectModelPolicies(projectId: string): ProjectModelPolicyRecord[];
  listProjectModelPolicyReferences(projectId: string): ProjectModelPolicyReferenceRecord[];
  deleteProjectModelPolicy(
    projectId: string,
    agentType: ProjectModelPolicyRecord['agentType'],
  ): boolean;
}

export interface SetAgentModelPolicyInput {
  agentType: AgentModelPolicyRecord['agentType'];
  providerId: string;
  modelId: string;
  quality: PolicyRating | null;
  speed: PolicyRating | null;
  cost: PolicyRating | null;
}

export interface SetProjectModelPolicyInput {
  projectId: string;
  agentType: ProjectModelPolicyRecord['agentType'];
  providerId: string;
  modelId: string;
}

export interface UpdateAgentPolicyNotesInput {
  agentType: AgentModelPolicyRecord['agentType'];
  quality: PolicyRating | null;
  speed: PolicyRating | null;
  cost: PolicyRating | null;
}

export class AgentModelPolicyServiceError extends Error {
  constructor(
    readonly code: 'INVALID_POLICY' | 'PROVIDER_NOT_FOUND' | 'PROJECT_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'AgentModelPolicyServiceError';
  }
}

export interface AgentModelPolicyServiceDependencies {
  store: AgentModelPolicyStore;
  runtimeGate: RuntimeGate;
  now?: () => number;
  projectExists?: (projectId: string) => boolean;
}

export class AgentModelPolicyService {
  private readonly store: AgentModelPolicyStore;
  private readonly runtimeGate: RuntimeGate;
  private readonly now: () => number;
  private readonly projectExists: (projectId: string) => boolean;
  private readonly capabilities = new ProviderCapabilityResolver();

  constructor(dependencies: AgentModelPolicyServiceDependencies) {
    this.store = dependencies.store;
    this.runtimeGate = dependencies.runtimeGate;
    this.now = dependencies.now ?? Date.now;
    this.projectExists = dependencies.projectExists ?? (() => true);
  }

  setAgentPolicy(input: SetAgentModelPolicyInput): AgentModelPolicyRecord {
    assertAgentRole(input.agentType);
    assertRating(input.quality, 'quality');
    assertRating(input.speed, 'speed');
    assertRating(input.cost, 'cost');
    this.assertRunnableSelection(input.providerId, input.modelId, input.agentType);
    const existing = this.store.getAgentModelPolicyReference(input.agentType)
      ?? this.store.getAgentModelPolicy(input.agentType);
    const now = this.now();
    const policy: AgentModelPolicyRecord = {
      agentType: input.agentType,
      providerId: input.providerId,
      modelId: input.modelId,
      quality: input.quality,
      speed: input.speed,
      cost: input.cost,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.setAgentModelPolicyReference({
      agentType: input.agentType,
      reference: { kind: 'model', providerId: input.providerId, modelId: input.modelId },
      quality: input.quality,
      speed: input.speed,
      cost: input.cost,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { ...policy };
  }

  updateAgentPolicyNotes(input: UpdateAgentPolicyNotesInput): AgentModelPolicyReferenceRecord {
    assertAgentRole(input.agentType);
    assertRating(input.quality, 'quality');
    assertRating(input.speed, 'speed');
    assertRating(input.cost, 'cost');
    const existing = this.store.getAgentModelPolicyReference(input.agentType);
    if (!existing) {
      throw new AgentModelPolicyServiceError(
        'INVALID_POLICY',
        'Agent role model configuration was not found.',
      );
    }
    const policy: AgentModelPolicyReferenceRecord = {
      agentType: existing.agentType,
      reference: existing.reference.kind === 'tier'
        ? { kind: 'tier', tier: existing.reference.tier }
        : {
            kind: 'model',
            providerId: existing.reference.providerId,
            modelId: existing.reference.modelId,
          },
      quality: input.quality,
      speed: input.speed,
      cost: input.cost,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
    };
    this.store.setAgentModelPolicyReference(policy);
    return { ...policy, reference: { ...policy.reference } };
  }

  getAgentPolicy(agentType: AgentModelPolicyRecord['agentType']): AgentModelPolicyRecord | null {
    assertAgentRole(agentType);
    const policy = this.store.getAgentModelPolicyReference(agentType);
    return policy?.reference.kind === 'model' ? directPolicy(policy) : null;
  }

  listAgentPolicies(): AgentModelPolicyRecord[] {
    const order = new Map(AGENT_ROLE_ORDER.map((role, index) => [role, index]));
    return this.store.listAgentModelPolicyReferences()
      .filter((policy) => policy.reference.kind === 'model')
      .map(directPolicy)
      .sort((left, right) => (order.get(left.agentType) ?? 99) - (order.get(right.agentType) ?? 99));
  }

  listAgentPolicyReferences(scope: ModelTierScope): PublicAgentModelPolicyReference[] {
    if (scope.type === 'project' && !this.projectExists(scope.projectId)) {
      throw new AgentModelPolicyServiceError('PROJECT_NOT_FOUND', 'Project was not found.');
    }
    const rows = scope.type === 'global'
      ? this.store.listAgentModelPolicyReferences()
      : this.store.listProjectModelPolicyReferences(scope.projectId)
        .filter((row) => AGENT_ROLE_ORDER.includes(row.agentType as AgentModelPolicyRecord['agentType']));
    const order = new Map(AGENT_ROLE_ORDER.map((role, index) => [role, index]));
    return rows.map((row): PublicAgentModelPolicyReference => ({
      scope: scope.type === 'global' ? { type: 'global' } : { type: 'project', projectId: scope.projectId },
      agentType: row.agentType as AgentModelPolicyRecord['agentType'],
      reference: row.reference.kind === 'tier'
        ? { kind: 'tier', tier: row.reference.tier }
        : { kind: 'model', providerId: row.reference.providerId, modelId: row.reference.modelId },
      providerName: row.reference.kind === 'model'
        ? this.store.getProvider(row.reference.providerId)?.name ?? null
        : null,
      notes: 'quality' in row
        ? { quality: row.quality, speed: row.speed, cost: row.cost }
        : { quality: null, speed: null, cost: null },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })).sort((left, right) => (order.get(left.agentType) ?? 99) - (order.get(right.agentType) ?? 99));
  }

  deleteAgentPolicy(agentType: AgentModelPolicyRecord['agentType']): boolean {
    assertAgentRole(agentType);
    return this.store.deleteAgentModelPolicy(agentType);
  }

  setProjectPolicy(input: SetProjectModelPolicyInput): ProjectModelPolicyRecord {
    assertProjectRole(input.agentType);
    if (!this.projectExists(input.projectId)) {
      throw new AgentModelPolicyServiceError('PROJECT_NOT_FOUND', 'Project was not found.');
    }
    this.assertRunnableSelection(input.providerId, input.modelId, input.agentType);
    const existing = this.store.getProjectModelPolicy(input.projectId, input.agentType);
    const now = this.now();
    const policy: ProjectModelPolicyRecord = {
      projectId: input.projectId,
      agentType: input.agentType,
      providerId: input.providerId,
      modelId: input.modelId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.setProjectModelPolicy(policy);
    return { ...policy };
  }

  getProjectPolicy(
    projectId: string,
    agentType: ProjectModelPolicyRecord['agentType'],
  ): ProjectModelPolicyRecord | null {
    assertProjectRole(agentType);
    const policy = this.store.getProjectModelPolicy(projectId, agentType);
    return policy ? { ...policy } : null;
  }

  listProjectPolicies(projectId: string): ProjectModelPolicyRecord[] {
    const order = new Map(PROJECT_ROLE_ORDER.map((role, index) => [role, index]));
    return this.store.listProjectModelPolicies(projectId)
      .map((policy) => ({ ...policy }))
      .sort((left, right) => (order.get(left.agentType) ?? 99) - (order.get(right.agentType) ?? 99));
  }

  deleteProjectPolicy(
    projectId: string,
    agentType: ProjectModelPolicyRecord['agentType'],
  ): boolean {
    assertProjectRole(agentType);
    return this.store.deleteProjectModelPolicy(projectId, agentType);
  }

  private assertRunnableSelection(
    providerId: string,
    modelId: string,
    role: ProjectModelPolicyRecord['agentType'],
  ): void {
    const provider = this.store.getProvider(providerId);
    if (!provider) {
      throw new AgentModelPolicyServiceError('PROVIDER_NOT_FOUND', 'Provider was not found.');
    }
    if (!provider.enabled) throw new Error(`Provider is disabled: ${provider.name}`);
    if (!provider.credentialRef) throw new Error(`Provider is not configured: ${provider.name}`);
    if (!this.store.listModels(provider.id).some((model) => model.modelId === modelId)) {
      throw new AgentModelPolicyServiceError(
        'INVALID_POLICY',
        'Selected model does not belong to the Provider.',
      );
    }
    const trusted = this.capabilities.resolve(
      provider.type,
      provider.apiFormat,
      provider.capabilities,
    );
    if (trusted.runtimeType !== 'claude-code' || !trusted.capabilities.supportsClaudeCode) {
      throw new Error(UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE);
    }
    if (!trusted.capabilities.supportsAgentWorkflow) {
      throw new Error('Current Provider does not support Agent Workflow.');
    }
    if (role === 'default' || role === 'coder' || role === 'tester' || role === 'fixer') {
      if (!trusted.capabilities.supportsTools || !trusted.capabilities.supportsMCP) {
        throw new Error('Current Agent role requires Provider tools and MCP capabilities.');
      }
    }
    this.runtimeGate.assertRunnable({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      apiFormat: provider.apiFormat,
      runtimeType: trusted.runtimeType,
      enabled: true,
      configured: true,
      capabilities: trusted.capabilities,
    }, 'agent-workflow');
  }
}

function directPolicy(policy: AgentModelPolicyReferenceRecord): AgentModelPolicyRecord {
  if (policy.reference.kind !== 'model') {
    throw new AgentModelPolicyServiceError('INVALID_POLICY', 'Agent policy is not a direct model.');
  }
  return {
    agentType: policy.agentType,
    providerId: policy.reference.providerId,
    modelId: policy.reference.modelId,
    quality: policy.quality,
    speed: policy.speed,
    cost: policy.cost,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

function assertAgentRole(value: unknown): asserts value is AgentModelPolicyRecord['agentType'] {
  if (!AGENT_ROLE_ORDER.includes(value as AgentModelPolicyRecord['agentType'])) {
    throw new AgentModelPolicyServiceError('INVALID_POLICY', 'Agent role is invalid.');
  }
}

function assertProjectRole(value: unknown): asserts value is ProjectModelPolicyRecord['agentType'] {
  if (!PROJECT_ROLE_ORDER.includes(value as ProjectModelPolicyRecord['agentType'])) {
    throw new AgentModelPolicyServiceError('INVALID_POLICY', 'Project policy role is invalid.');
  }
}

function assertRating(value: unknown, field: string): asserts value is PolicyRating | null {
  if (value !== null && !POLICY_RATINGS.has(value as PolicyRating)) {
    throw new AgentModelPolicyServiceError('INVALID_POLICY', `${field} rating is invalid.`);
  }
}
