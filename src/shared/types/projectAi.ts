import type {
  ImplementedAgentRuntimeType,
  ModelPolicyAgentType,
  ModelSelectionSource,
} from './modelProviders';
import type {
  AgentPresetStatus,
  ModelTier,
  ModelTierDisplayMetadata,
  ModelTierInvalidReason,
  ModelTierResolutionSource,
  ModelTierValidity,
} from './modelTiers';

export interface GetProjectAiConfigurationSummaryRequest {
  projectId: string;
}

export const PROJECT_AI_UNAVAILABLE_REASONS = [
  'tier_unbound',
  'provider_deleted',
  'provider_disabled',
  'provider_unconfigured',
  'connection_unavailable',
  'model_missing',
  'runtime_incompatible',
  'workflow_capability_missing',
  'source_changed',
  'claude_cli_unavailable',
  'selection_unavailable',
] as const;

export type ProjectAiUnavailableReason =
  | ModelTierInvalidReason
  | 'selection_unavailable';

export const PROJECT_AI_BASELINE_SELECTION_SOURCES = [
  'project_policy',
  'global_agent_policy',
  'global_default',
  'environment',
  'claude_code',
] as const satisfies readonly Exclude<ModelSelectionSource, 'task_override'>[];

export type ProjectAiBaselineSelectionSource =
  (typeof PROJECT_AI_BASELINE_SELECTION_SOURCES)[number];

export interface ProjectAiTierSummaryPublic {
  tier: ModelTier;
  display: ModelTierDisplayMetadata;
  source: ModelTierResolutionSource;
  validity: ModelTierValidity;
  invalidReason: ModelTierInvalidReason | null;
  candidate: null | {
    providerName: string;
    modelId: string;
    modelDisplayName: string | null;
    runtimeType: ImplementedAgentRuntimeType;
    health: {
      state: 'not_configured' | 'configured' | 'connected' | 'error';
      lastTestedAt: number | null;
    };
  };
}

export type ProjectAiRoleOutcomePublic =
  | {
      status: 'resolved';
      role: ModelPolicyAgentType;
      providerName: string;
      modelId: string;
      runtimeType: ImplementedAgentRuntimeType;
      source: ProjectAiBaselineSelectionSource;
      tier?: ModelTier;
      tierSource?: Exclude<ModelTierResolutionSource, 'none'>;
    }
  | {
      status: 'unavailable';
      role: ModelPolicyAgentType;
      reason: ProjectAiUnavailableReason;
    };

export interface ProjectAiConfigurationSummaryPublic {
  includesTaskOverride: false;
  presetStatus: AgentPresetStatus;
  tiers: ProjectAiTierSummaryPublic[];
  roles: ProjectAiRoleOutcomePublic[];
}

/** Main-projected task switch option. Provider internals and capability blobs stay private. */
export interface TaskModelSwitchOptionPublic {
  providerId: string;
  providerName: string;
  modelId: string;
  modelDisplayName: string | null;
  runtimeType: ImplementedAgentRuntimeType;
  purpose?: 'task_agent_override';
  source?: 'configured_provider';
}

export interface ListTaskModelSwitchOptionsRequest {
  taskId: string;
}
