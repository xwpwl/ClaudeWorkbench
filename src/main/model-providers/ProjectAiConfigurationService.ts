import {
  MODEL_POLICY_AGENT_TYPES,
  type ModelPolicyAgentType,
  type ResolvedModelSelection,
} from '../../shared/types/modelProviders';
import type {
  AgentPresetStatus,
  ModelTier,
  ModelTierResolutionPublic,
  ModelTierScope,
} from '../../shared/types/modelTiers';
import { MODEL_TIERS } from '../../shared/types/modelTiers';
import type {
  GetProjectAiConfigurationSummaryRequest,
  ProjectAiBaselineSelectionSource,
  ProjectAiConfigurationSummaryPublic,
  ProjectAiRoleOutcomePublic,
  ProjectAiTierSummaryPublic,
  ProjectAiUnavailableReason,
} from '../../shared/types/projectAi';
import type { PreparedModelTierTrust } from './ModelTierService';

interface TierSummaryPort {
  prepareTrustedSnapshot(scope: ModelTierScope): Promise<PreparedModelTierTrust>;
  resolvePreparedBindings(
    scope: ModelTierScope,
    prepared: PreparedModelTierTrust,
  ): ModelTierResolutionPublic[];
}

interface PresetSummaryPort {
  getPresetStatus(scope: ModelTierScope): Promise<AgentPresetStatus>;
}

interface SelectionInspectionPort {
  inspectProjectPolicy(
    request: {
      projectId: string;
      agentType: ModelPolicyAgentType;
      fallbackModelId: string | null;
      includesTaskOverride: false;
    },
    tierResolutions: ReadonlyMap<ModelTier, ModelTierResolutionPublic>,
  ): Promise<
    | { available: true; selection: ResolvedModelSelection }
    | { available: false; reason: ProjectAiUnavailableReason }
  >;
}

export interface ProjectAiConfigurationServiceDependencies {
  projectExists(projectId: string): boolean;
  projectFallbackModelId(projectId: string): string | null;
  tierService: TierSummaryPort;
  presetService: PresetSummaryPort;
  selectionInspector: SelectionInspectionPort;
}

export class ProjectAiConfigurationService {
  constructor(private readonly dependencies: ProjectAiConfigurationServiceDependencies) {}

  async getSummary(
    request: GetProjectAiConfigurationSummaryRequest,
  ): Promise<ProjectAiConfigurationSummaryPublic> {
    if (!this.dependencies.projectExists(request.projectId)) {
      throw new Error('The selected project was not found.');
    }
    const scope = { type: 'project', projectId: request.projectId } as const;
    const prepared = await this.dependencies.tierService.prepareTrustedSnapshot(scope);
    const trustedTiers = this.dependencies.tierService.resolvePreparedBindings(scope, prepared);
    assertCanonicalOrder(trustedTiers, MODEL_TIERS, ({ tier }) => tier, 'model tiers');
    const tierMap = new Map(trustedTiers.map((resolution) => [resolution.tier, resolution]));
    const fallbackModelId = this.dependencies.projectFallbackModelId(request.projectId);
    const [presetStatus, roles] = await Promise.all([
      this.dependencies.presetService.getPresetStatus(scope),
      Promise.all(MODEL_POLICY_AGENT_TYPES.map(async (role) => {
        const inspected = await this.dependencies.selectionInspector.inspectProjectPolicy({
          projectId: request.projectId,
          agentType: role,
          fallbackModelId,
          includesTaskOverride: false,
        }, tierMap);
        if (!inspected.available) {
          return { status: 'unavailable', role, reason: inspected.reason } as const;
        }
        if (inspected.selection.source === 'task_override') {
          return { status: 'unavailable', role, reason: 'selection_unavailable' } as const;
        }
        return publicRole(role, inspected.selection);
      })),
    ]);
    assertCanonicalOrder(roles, MODEL_POLICY_AGENT_TYPES, ({ role }) => role, 'Agent roles');
    return {
      includesTaskOverride: false,
      presetStatus,
      tiers: trustedTiers.map(publicTier),
      roles,
    };
  }
}

function publicTier(value: ModelTierResolutionPublic): ProjectAiTierSummaryPublic {
  return {
    tier: value.tier,
    display: {
      tier: value.display.tier,
      displayName: value.display.displayName,
      quality: value.display.quality,
      speed: value.display.speed,
      cost: value.display.cost,
    },
    source: value.source,
    validity: value.validity,
    invalidReason: value.invalidReason,
    candidate: value.candidate ? {
      providerName: value.candidate.providerName,
      modelId: value.candidate.modelId,
      modelDisplayName: value.candidate.modelDisplayName,
      runtimeType: value.candidate.runtimeType,
      health: {
        state: value.candidate.health.state,
        lastTestedAt: value.candidate.health.lastTestedAt,
      },
    } : null,
  };
}

function publicRole(
  role: ModelPolicyAgentType,
  selection: ResolvedModelSelection,
): ProjectAiRoleOutcomePublic {
  const source = selection.source as ProjectAiBaselineSelectionSource;
  const common = {
    status: 'resolved' as const,
    role,
    providerName: selection.providerName,
    modelId: selection.modelId,
    runtimeType: selection.runtimeType,
    source,
  };
  return selection.tier
    ? { ...common, tier: selection.tier, tierSource: selection.tierSource }
    : common;
}

function assertCanonicalOrder<T, K extends string>(
  values: readonly T[],
  canonical: readonly K[],
  keyOf: (value: T) => K,
  label: string,
): void {
  if (values.length !== canonical.length
    || values.some((value, index) => keyOf(value) !== canonical[index])) {
    throw new Error(`Project AI ${label} are not canonical.`);
  }
}
