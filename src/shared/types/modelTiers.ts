import type {
  ImplementedAgentRuntimeType,
  ModelPolicyAgentType,
  PolicyRating,
  ProviderHealthState,
} from "./modelProviders";

/** Immutable product tier keys. Display metadata never affects model selection. */
export const MODEL_TIERS = ["high_quality", "balanced", "fast"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

/** A persisted binding always contains both model identities or neither one. */
export interface BoundModelTierBinding {
  tier: ModelTier;
  providerId: string;
  modelId: string;
  updatedAt: number;
}

/** An explicit unbound row blocks fallback until the user follows the other scope. */
export interface UnboundModelTierBinding {
  tier: ModelTier;
  providerId: null;
  modelId: null;
  updatedAt: number;
}

export type ModelTierBinding = BoundModelTierBinding | UnboundModelTierBinding;

/** Localized, user-facing tier metadata. These ratings are informational only. */
export interface ModelTierDisplayMetadata {
  tier: ModelTier;
  displayName: string | null;
  quality: PolicyRating | null;
  speed: PolicyRating | null;
  cost: PolicyRating | null;
}

export type ModelTierScope =
  { type: "global" } | { type: "project"; projectId: string };

/** A role policy is either a concrete model or a logical tier, never both. */
export type PersistedModelPolicyReference =
  | { kind: "model"; providerId: string; modelId: string }
  | { kind: "tier"; tier: ModelTier };

/**
 * Trusted execution identity. This is deliberately independent from the policy
 * source so a global/project policy can still resolve to an inherited source.
 */
export const MODEL_EXECUTION_SOURCES = [
  "database_provider",
  "environment",
  "claude_code",
] as const;

export type ModelExecutionSource = (typeof MODEL_EXECUTION_SOURCES)[number];

export type ModelTierResolutionSource = "global" | "project" | "none";

export const MODEL_TIER_INVALID_REASONS = [
  "tier_unbound",
  "provider_deleted",
  "provider_disabled",
  "provider_unconfigured",
  "connection_unavailable",
  "model_missing",
  "runtime_incompatible",
  "workflow_capability_missing",
  "source_changed",
  "claude_cli_unavailable",
] as const;

/** Safe, actionable invalidation categories; raw runtime errors never cross IPC. */
export type ModelTierInvalidReason =
  (typeof MODEL_TIER_INVALID_REASONS)[number];

export type ModelTierValidity = "valid" | "needs_reconfiguration" | "unbound";

/** Renderer-safe candidate computed by the main process from trusted facts. */
export interface ModelTierCandidatePublic {
  providerId: string;
  providerName: string;
  modelId: string;
  modelDisplayName: string | null;
  runtimeType: ImplementedAgentRuntimeType;
  executionSource: ModelExecutionSource;
  health: {
    state: ProviderHealthState;
    lastTestedAt: number | null;
  };
}

interface ModelTierResolutionPublicBase {
  scope: ModelTierScope;
  tier: ModelTier;
  display: ModelTierDisplayMetadata;
}

/** Renderer-safe outcome for one logical tier in a scope. */
export type ModelTierResolutionPublic =
  | (ModelTierResolutionPublicBase & {
      source: Exclude<ModelTierResolutionSource, "none">;
      binding: BoundModelTierBinding;
      candidate: ModelTierCandidatePublic;
      validity: "valid";
      invalidReason: null;
    })
  | (ModelTierResolutionPublicBase & {
      source: Exclude<ModelTierResolutionSource, "none">;
      binding: BoundModelTierBinding;
      candidate: null;
      validity: "needs_reconfiguration";
      invalidReason: Exclude<ModelTierInvalidReason, "tier_unbound">;
    })
  | (ModelTierResolutionPublicBase & {
      source: "none";
      binding: null;
      candidate: null;
      validity: "unbound";
      invalidReason: "tier_unbound";
    })
  | (ModelTierResolutionPublicBase & {
      source: Exclude<ModelTierResolutionSource, "none">;
      binding: UnboundModelTierBinding;
      candidate: null;
      validity: "unbound";
      invalidReason: "tier_unbound";
    });

export const AGENT_PRESET_IDS = [
  "software_development",
  "quick_change",
  "high_quality_review",
] as const;

export type AgentPresetId = (typeof AGENT_PRESET_IDS)[number];

export interface AgentPresetDefinition {
  roles: Readonly<Record<ModelPolicyAgentType, ModelTier>>;
}

/** Built-in mappings are immutable product behavior and contain no model identities. */
export const AGENT_PRESETS = {
  software_development: {
    roles: {
      planner: "high_quality",
      coder: "balanced",
      tester: "fast",
      reviewer: "high_quality",
      fixer: "balanced",
    },
  },
  quick_change: {
    roles: {
      planner: "fast",
      coder: "fast",
      tester: "fast",
      reviewer: "balanced",
      fixer: "fast",
    },
  },
  high_quality_review: {
    roles: {
      planner: "high_quality",
      coder: "balanced",
      tester: "balanced",
      reviewer: "high_quality",
      fixer: "high_quality",
    },
  },
} as const satisfies Readonly<Record<AgentPresetId, AgentPresetDefinition>>;

export interface AgentPresetRolePreview {
  role: ModelPolicyAgentType;
  tier: ModelTier;
  resolution: ModelTierResolutionPublic;
}

/** Safe snapshot used for review before the main process atomically applies a preset. */
export interface AgentPresetPreview {
  scope: ModelTierScope;
  presetId: AgentPresetId;
  revision: string;
  roles: Readonly<Record<ModelPolicyAgentType, AgentPresetRolePreview>>;
}

export type AgentPresetPrepareResult =
  | { step: "bind_tiers"; missingTiers: ModelTier[] }
  | { step: "preview"; preview: AgentPresetPreview };

export type AgentPresetStatus =
  { kind: "preset"; presetId: AgentPresetId } | { kind: "custom" };

export interface ListModelTierCandidatesRequest {
  scope: ModelTierScope;
}

export interface GetModelTierBindingsRequest {
  scope: ModelTierScope;
}

/** Renderer intent only; the main process resolves candidate capabilities and ownership. */
export interface SetModelTierBindingRequest {
  scope: ModelTierScope;
  tier: ModelTier;
  providerId: string;
  modelId: string;
}

/** One trusted candidate intent applied to every immutable tier key atomically. */
export interface BindAllModelTiersRequest {
  scope: ModelTierScope;
  providerId: string;
  modelId: string;
}

export interface UpdateModelTierDisplayMetadataRequest {
  scope: ModelTierScope;
  metadata: ModelTierDisplayMetadata;
}

export interface ClearProjectModelTierBindingRequest {
  projectId: string;
  tier: ModelTier;
}

export interface PrepareAgentPresetRequest {
  scope: ModelTierScope;
  presetId: AgentPresetId;
}

export interface PreviewAgentPresetRequest {
  scope: ModelTierScope;
  presetId: AgentPresetId;
}

export interface ApplyAgentPresetRequest extends PreviewAgentPresetRequest {
  expectedRevision: string;
  previewConfirmed: boolean;
  overwriteConfirmed: boolean;
}

export interface AgentPresetApplyResult {
  presetId: AgentPresetId;
  appliedAt: number;
}

export interface GetAgentPresetStatusRequest {
  scope: ModelTierScope;
}
