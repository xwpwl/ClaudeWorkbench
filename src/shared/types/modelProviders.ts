import type {
  ModelExecutionSource,
  ModelTier,
  ModelTierScope,
  ModelTierResolutionSource,
  PersistedModelPolicyReference,
} from './modelTiers';

export const MODEL_PROVIDER_TYPES = [
  'anthropic',
  'anthropic-compatible',
  'openai-compatible',
  'custom',
] as const;

export type ModelProviderType = (typeof MODEL_PROVIDER_TYPES)[number];

export const MODEL_API_FORMATS = ['anthropic-messages', 'openai-chat-completions'] as const;

export type ModelApiFormat = (typeof MODEL_API_FORMATS)[number];

/** `openai-agent` is reserved for a future runtime and is not implemented in this phase. */
export const AGENT_RUNTIME_TYPES = ['claude-code', 'none', 'openai-agent'] as const;

export type AgentRuntimeType = (typeof AGENT_RUNTIME_TYPES)[number];

/** Claude Code remains the only implemented Agent Runtime. */
export const IMPLEMENTED_AGENT_RUNTIME_TYPES = ['claude-code'] as const;

export type ImplementedAgentRuntimeType = (typeof IMPLEMENTED_AGENT_RUNTIME_TYPES)[number];

export const UNSUPPORTED_CLAUDE_CODE_RUNTIME_MESSAGE =
  '当前 Provider 不支持 Claude Code Agent Runtime';

export interface ProviderCapabilities {
  supportsClaudeCode: boolean;
  supportsAgentWorkflow: boolean;
  supportsTools: boolean;
  supportsMCP: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
}

export const PROVIDER_CAPABILITY_KEYS = [
  'supportsClaudeCode',
  'supportsAgentWorkflow',
  'supportsTools',
  'supportsMCP',
  'supportsStreaming',
  'supportsVision',
] as const satisfies readonly (keyof ProviderCapabilities)[];

export const PROVIDER_SUPPORTED_USES = [
  'chat',
  'agent_task',
  'claude_code',
  'mcp_tools',
  'vision',
] as const;

export type ProviderSupportedUse = (typeof PROVIDER_SUPPORTED_USES)[number];

export const PROVIDER_SUPPORTED_USE_LABELS_ZH_CN: Readonly<Record<ProviderSupportedUse, string>> =
  Object.freeze({
    chat: '普通聊天',
    agent_task: 'Agent任务',
    claude_code: 'Claude Code',
    mcp_tools: 'MCP工具',
    vision: '视觉任务',
  });

/**
 * Converts trusted main-process capability facts to the uses shown in the Renderer.
 * Until another runtime exists, ordinary application chat is a Claude Code use too.
 */
export function supportedUsesForCapabilities(
  capabilities: ProviderCapabilities,
): ProviderSupportedUse[] {
  const uses: ProviderSupportedUse[] = [];

  if (capabilities.supportsClaudeCode) uses.push('chat');
  if (capabilities.supportsAgentWorkflow) uses.push('agent_task');
  if (capabilities.supportsClaudeCode) uses.push('claude_code');
  if (capabilities.supportsMCP) uses.push('mcp_tools');
  if (capabilities.supportsVision) uses.push('vision');

  return uses;
}

export const PROVIDER_HEALTH_STATES = [
  'not_configured',
  'configured',
  'connected',
  'error',
] as const;

export type ProviderHealthState = (typeof PROVIDER_HEALTH_STATES)[number];

export const PROVIDER_CONNECTION_ERROR_TYPES = [
  'invalid_key',
  'forbidden',
  'not_found',
  'rate_limited',
  'timeout',
  'network',
  'invalid_response',
  'unknown',
] as const;

export type ProviderConnectionErrorType = (typeof PROVIDER_CONNECTION_ERROR_TYPES)[number];

export interface ProviderHealth {
  state: ProviderHealthState;
  lastTestedAt: number | null;
  lastErrorType: ProviderConnectionErrorType | null;
  latencyMs: number | null;
}

export const POLICY_RATINGS = ['low', 'medium', 'high'] as const;

export type PolicyRating = (typeof POLICY_RATINGS)[number];

/** Informational only; these values never select or route a model. */
export interface AgentModelPolicyNotes {
  quality: PolicyRating | null;
  speed: PolicyRating | null;
  cost: PolicyRating | null;
}

export const PROVIDER_CREDENTIAL_SOURCES = [
  'credential_store',
  'environment',
  'claude_code',
  'none',
] as const;

export type ProviderCredentialSource = (typeof PROVIDER_CREDENTIAL_SOURCES)[number];

export interface ProviderModelRef {
  providerId: string;
  modelId: string;
}

export const PROVIDER_MODEL_SOURCES = ['manual', 'discovered'] as const;

export type ProviderModelSource = (typeof PROVIDER_MODEL_SOURCES)[number];

export interface ProviderModel extends ProviderModelRef {
  displayName: string | null;
  source: ProviderModelSource;
  createdAt: number;
  updatedAt: number;
}

export interface PublicModelProvider {
  id: string;
  name: string;
  type: ModelProviderType;
  apiFormat: ModelApiFormat;
  runtimeType: AgentRuntimeType;
  baseUrl: string | null;
  /** True when the stored endpoint has a main-process-only non-root pathname. */
  baseUrlPathRedacted: boolean;
  enabled: boolean;
  isDefault: boolean;
  configured: boolean;
  credentialSource: ProviderCredentialSource;
  capabilities: ProviderCapabilities;
  supportedUses: ProviderSupportedUse[];
  health: ProviderHealth;
  defaultModelId: string | null;
  createdAt: number;
  updatedAt: number;
}

type PublicModelProviderProjectionInput = Omit<
  PublicModelProvider,
  'supportedUses' | 'baseUrlPathRedacted'
> & {
  supportedUses?: readonly ProviderSupportedUse[];
  baseUrlPathRedacted?: boolean;
};

/**
 * Builds a Renderer-safe provider DTO by explicitly selecting public fields.
 * Runtime extra properties (for example a repository credential reference) are discarded.
 */
export function toPublicModelProvider(
  provider: PublicModelProviderProjectionInput,
): PublicModelProvider {
  const publicBaseUrl = projectPublicProviderBaseUrl(provider.baseUrl);
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    apiFormat: provider.apiFormat,
    runtimeType: provider.runtimeType,
    baseUrl: publicBaseUrl.value,
    baseUrlPathRedacted: provider.baseUrlPathRedacted === true || publicBaseUrl.pathRedacted,
    enabled: provider.enabled,
    isDefault: provider.isDefault,
    configured: provider.configured,
    credentialSource: provider.credentialSource,
    capabilities: { ...provider.capabilities },
    supportedUses: supportedUsesForCapabilities(provider.capabilities),
    health: { ...provider.health },
    defaultModelId: provider.defaultModelId,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

function projectPublicProviderBaseUrl(value: string | null): {
  value: string | null;
  pathRedacted: boolean;
} {
  if (value === null) return { value: null, pathRedacted: false };
  try {
    const parsed = new URL(value);
    const pathRedacted = parsed.pathname !== '' && parsed.pathname !== '/';
    return { value: parsed.origin, pathRedacted };
  } catch {
    return { value: null, pathRedacted: true };
  }
}

export const MODEL_SELECTION_SOURCES = [
  'task_override',
  'project_policy',
  'global_agent_policy',
  'global_default',
  'environment',
  'claude_code',
] as const;

export type ModelSelectionSource = (typeof MODEL_SELECTION_SOURCES)[number];

export const MODEL_SELECTION_SOURCE_LABELS_ZH_CN: Readonly<
  Record<ModelSelectionSource, string>
> = Object.freeze({
  task_override: '任务覆盖',
  project_policy: '项目策略',
  global_agent_policy: '全局默认',
  global_default: '全局默认',
  environment: '环境变量',
  claude_code: 'Claude Code',
});

export function effectiveSourceLabel(source: ModelSelectionSource): string {
  return MODEL_SELECTION_SOURCE_LABELS_ZH_CN[source];
}

interface ResolvedModelSelectionBase extends ProviderModelRef {
  providerName: string;
  runtimeType: ImplementedAgentRuntimeType;
  capabilities: ProviderCapabilities;
  source: ModelSelectionSource;
  /** Main-process execution authority, intentionally independent from policy provenance. */
  executionSource: ModelExecutionSource;
}

/** A concrete main-process-verified selection, optionally carrying tier provenance. */
export type ResolvedModelSelection =
  | (ResolvedModelSelectionBase & {
      tier: ModelTier;
      tierSource: Exclude<ModelTierResolutionSource, 'none'>;
    })
  | (ResolvedModelSelectionBase & {
      tier?: never;
      tierSource?: never;
    });

/** Compatibility name for callers that emphasize the trust boundary. */
export type TrustedResolvedModelSelection = ResolvedModelSelection;

export interface AgentModelPolicyAssignment extends ProviderModelRef {
  agentType: ModelPolicyAgentType;
  notes: AgentModelPolicyNotes;
}

export const MODEL_POLICY_AGENT_TYPES = [
  'planner',
  'coder',
  'tester',
  'reviewer',
  'fixer',
] as const;

export type ModelPolicyAgentType = (typeof MODEL_POLICY_AGENT_TYPES)[number];

/**
 * Immutable Provider/model/source identities captured when a Workflow is created.
 * Capabilities are creation-time facts and are re-derived before every stage spawn.
 */
export type WorkflowModelSelectionPolicy = Readonly<
  Record<ModelPolicyAgentType, ResolvedModelSelection>
>;

export interface WorkflowModelPolicySnapshotRequest {
  taskId: string;
  projectId: string;
  fallbackModelIds: Partial<Record<ModelPolicyAgentType, string | null | undefined>>;
}

export const PROJECT_MODEL_POLICY_AGENT_TYPES = [
  'default',
  ...MODEL_POLICY_AGENT_TYPES,
] as const;

export type ProjectModelPolicyAgentType = (typeof PROJECT_MODEL_POLICY_AGENT_TYPES)[number];

/** Renderer-safe global Agent policy. Cost/speed/quality are display notes only. */
export interface PublicAgentModelPolicy extends ProviderModelRef {
  agentType: ModelPolicyAgentType;
  notes: AgentModelPolicyNotes;
  createdAt: number;
  updatedAt: number;
}

/** Renderer-safe persisted Agent role reference; execution/security facts stay in main. */
export interface PublicAgentModelPolicyReference {
  scope: ModelTierScope;
  agentType: ModelPolicyAgentType;
  reference: PersistedModelPolicyReference;
  /** Main-resolved display fact for direct references; null means unavailable or not applicable. */
  providerName: string | null;
  notes: AgentModelPolicyNotes;
  createdAt: number;
  updatedAt: number;
}

export interface ListAgentModelPolicyReferencesRequest {
  scope: ModelTierScope;
}

export interface PublicProjectModelPolicy extends ProviderModelRef {
  projectId: string;
  agentType: ProjectModelPolicyAgentType;
  createdAt: number;
  updatedAt: number;
}

export interface SetAgentModelPolicyRequest extends ProviderModelRef, AgentModelPolicyNotes {
  agentType: ModelPolicyAgentType;
}

export interface DeleteAgentModelPolicyRequest {
  agentType: ModelPolicyAgentType;
}

export interface ProjectModelPolicyListRequest {
  projectId: string;
}

export interface SetProjectModelPolicyRequest extends ProviderModelRef {
  projectId: string;
  agentType: ProjectModelPolicyAgentType;
}

export interface DeleteProjectModelPolicyRequest {
  projectId: string;
  agentType: ProjectModelPolicyAgentType;
}

export interface EffectiveModelSelectionRequest {
  taskId: string;
  agentType?: ModelPolicyAgentType;
}

/** Renderer cannot supply project identity, task status, or runtime use. */
export interface SetTaskModelOverrideRequest extends ProviderModelRef {
  taskId: string;
}

export interface ClearTaskModelOverrideRequest {
  taskId: string;
}

export interface TaskModelSwitchResult {
  selection: ResolvedModelSelection;
  warning: string;
}

export interface ModelProviderListRequest {
  limit?: number;
  offset?: number;
  enabled?: boolean;
}

export interface ModelProviderPage {
  items: PublicModelProvider[];
  total: number;
  limit: number;
  offset: number;
}

export interface ProviderConnectionError {
  type: ProviderConnectionErrorType;
  statusCode: number | null;
  message: string;
}

export type ProviderConnectionResult =
  | {
      ok: true;
      testedAt: number;
      latencyMs: number;
      discoveredModelIds: string[];
    }
  | {
      ok: false;
      testedAt: number;
      latencyMs: number | null;
      discoveredModelIds: string[];
      error: ProviderConnectionError;
    };

export type ProviderBaseUrlIntent =
  | { mode: 'replace'; value: string | null }
  | { mode: 'preserve_existing' };

interface ProviderDraftCommon {
  providerId?: string;
  name: string;
  type: ModelProviderType;
  apiFormat: ModelApiFormat;
  credential: string | null;
  defaultModelId: string | null;
  capabilities?: Partial<ProviderCapabilities>;
}

/** Renderer-to-main draft. Credentials and replacement URLs are transient and never echoed. */
export type ProviderDraftInput = ProviderDraftCommon & (
  | {
      providerId?: string;
      baseUrlIntent: Extract<ProviderBaseUrlIntent, { mode: 'replace' }>;
    }
  | {
      providerId: string;
      baseUrlIntent: Extract<ProviderBaseUrlIntent, { mode: 'preserve_existing' }>;
    }
);

export interface ProviderValidationResult {
  validationToken: string | null;
  connection: ProviderConnectionResult;
}

/** A validated, single-use token is the only input accepted by provider creation. */
export interface CreateProviderInput {
  validationToken: string;
}

/** Updating origin or credentials also requires a fresh validated, single-use token. */
export interface UpdateProviderInput {
  providerId: string;
  validationToken: string;
}

export interface SetProviderEnabledInput {
  providerId: string;
  enabled: boolean;
}

export interface DeleteProviderInput {
  providerId: string;
  confirmCredentialDeletion: boolean;
}

export interface TestProviderConnectionInput {
  providerId: string;
}
