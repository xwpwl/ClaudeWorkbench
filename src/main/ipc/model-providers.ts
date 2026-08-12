import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { z } from 'zod';
import { assertTrustedMainFrame } from './trusted-frame';
import {
  MODEL_API_FORMATS,
  PROVIDER_HEALTH_STATES,
  MODEL_POLICY_AGENT_TYPES,
  MODEL_PROVIDER_TYPES,
  POLICY_RATINGS,
  PROJECT_MODEL_POLICY_AGENT_TYPES,
  type AgentModelPolicyNotes,
  type CreateProviderInput,
  type DeleteProviderInput,
  type ListAgentModelPolicyReferencesRequest,
  type ModelPolicyAgentType,
  type ModelProviderListRequest,
  type ModelProviderPage,
  type ProjectModelPolicyAgentType,
  type ProviderConnectionErrorType,
  type ProviderConnectionResult,
  type ProviderDraftInput,
  type ProviderCapabilities,
  type ProviderModel,
  type ProviderValidationResult,
  type PublicAgentModelPolicy,
  type PublicAgentModelPolicyReference,
  type PublicModelProvider,
  type PublicProjectModelPolicy,
  type ResolvedModelSelection,
  type SetAgentModelPolicyRequest,
  type SetProjectModelPolicyRequest,
  type SetProviderEnabledInput,
  type TaskModelSwitchResult,
  type UpdateProviderInput,
  toPublicModelProvider,
} from '../../shared/types/modelProviders';
import {
  AGENT_PRESET_IDS,
  MODEL_EXECUTION_SOURCES,
  MODEL_TIER_INVALID_REASONS,
  MODEL_TIERS,
  type AgentPresetApplyResult,
  type AgentPresetId,
  type AgentPresetPrepareResult,
  type AgentPresetPreview,
  type AgentPresetStatus,
  type BindAllModelTiersRequest,
  type ClearProjectModelTierBindingRequest,
  type GetAgentPresetStatusRequest,
  type GetModelTierBindingsRequest,
  type ListModelTierCandidatesRequest,
  type ModelTier,
  type ModelTierCandidatePublic,
  type ModelTierResolutionPublic,
  type ModelTierScope,
  type PrepareAgentPresetRequest,
  type PreviewAgentPresetRequest,
  type ApplyAgentPresetRequest,
  type SetModelTierBindingRequest,
  type UpdateModelTierDisplayMetadataRequest,
} from '../../shared/types/modelTiers';
import {
  PROJECT_AI_BASELINE_SELECTION_SOURCES,
  PROJECT_AI_UNAVAILABLE_REASONS,
  type ProjectAiConfigurationSummaryPublic,
  type TaskModelSwitchOptionPublic,
} from '../../shared/types/projectAi';
import {
  IPC_CHANNELS,
  type ModelProviderChangedEvent,
} from '../../shared/types/ipc';
import {
  PublicIpcError,
  publicIpcFailureMessage,
  type PublicIpcFailureCode,
} from '../../shared/types/publicIpc';
import type { PublicIpcRegistrar } from './public-invoke-boundary';
import { AgentModelPolicyServiceError } from '../model-providers/AgentModelPolicyService';
import { AgentPresetServiceError } from '../model-providers/AgentPresetService';
import { ModelProviderServiceError } from '../model-providers/ModelProviderService';
import {
  ModelSelectionFailure,
  ModelSwitchError,
} from '../model-providers/ModelSelectionResolver';
import { ModelTierServiceError } from '../model-providers/ModelTierService';

type Awaitable<T> = T | Promise<T>;

/** Minimal main-process contract; credentials never cross this boundary on reads. */
export interface ModelProviderServicePort {
  listProviders(input?: ModelProviderListRequest): Awaitable<ModelProviderPage>;
  getProvider(providerId: string): Awaitable<PublicModelProvider>;
  listModels(providerId: string): Awaitable<ProviderModel[]>;
  validateDraft(input: ProviderDraftInput): Promise<ProviderValidationResult>;
  createProvider(input: CreateProviderInput): Promise<PublicModelProvider>;
  updateProvider(input: UpdateProviderInput): Promise<PublicModelProvider>;
  testConnection(providerId: string): Promise<ProviderConnectionResult>;
  setDefaultProvider(providerId: string): Awaitable<PublicModelProvider>;
  setProviderEnabled(input: SetProviderEnabledInput): Awaitable<PublicModelProvider>;
  deleteProvider(input: DeleteProviderInput): Promise<void>;
}

interface AgentModelPolicyRecordPort {
  agentType: ModelPolicyAgentType;
  providerId: string;
  modelId: string;
  quality: AgentModelPolicyNotes['quality'];
  speed: AgentModelPolicyNotes['speed'];
  cost: AgentModelPolicyNotes['cost'];
  createdAt: number;
  updatedAt: number;
}

interface AgentModelPolicyReferenceRecordPort {
  scope: ModelTierScope;
  agentType: ModelPolicyAgentType;
  reference:
    | { kind: 'model'; providerId: string; modelId: string }
    | { kind: 'tier'; tier: ModelTier };
  providerName: string | null;
  notes: AgentModelPolicyNotes;
  createdAt: number;
  updatedAt: number;
}

interface ProjectModelPolicyRecordPort {
  projectId: string;
  agentType: ProjectModelPolicyAgentType;
  providerId: string;
  modelId: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentModelPolicyServicePort {
  listAgentPolicies(): Awaitable<AgentModelPolicyRecordPort[]>;
  listAgentPolicyReferences(scope: ModelTierScope): Awaitable<AgentModelPolicyReferenceRecordPort[]>;
  setAgentPolicy(input: SetAgentModelPolicyRequest): Awaitable<AgentModelPolicyRecordPort>;
  deleteAgentPolicy(agentType: ModelPolicyAgentType): Awaitable<boolean>;
  listProjectPolicies(projectId: string): Awaitable<ProjectModelPolicyRecordPort[]>;
  setProjectPolicy(input: SetProjectModelPolicyRequest): Awaitable<ProjectModelPolicyRecordPort>;
  deleteProjectPolicy(
    projectId: string,
    agentType: ProjectModelPolicyAgentType,
  ): Awaitable<boolean>;
}

interface ModelSelectionRequestPort {
  taskId: string;
  projectId: string;
  agentType?: ModelPolicyAgentType;
  fallbackModelId?: string | null;
  use: 'chat' | 'agent-workflow';
}

interface SetTaskModelOverridePort {
  taskId: string;
  providerId: string;
  modelId: string;
  status: string;
}

export interface ModelSelectionServicePort {
  resolve(input: ModelSelectionRequestPort): Awaitable<ResolvedModelSelection>;
  listTaskModelSwitchOptions(): Awaitable<TaskModelSwitchOptionPublic[]>;
  setTaskOverride(input: SetTaskModelOverridePort): Awaitable<unknown>;
  clearTaskOverride(taskId: string, status: string): Awaitable<unknown>;
}

export interface ProjectAiConfigurationServicePort {
  getSummary(input: { projectId: string }): Promise<ProjectAiConfigurationSummaryPublic>;
}

export interface ModelTierServicePort {
  listCandidates(scope: ModelTierScope): Promise<ModelTierCandidatePublic[]>;
  getBindings(scope: ModelTierScope): Promise<ModelTierResolutionPublic[]>;
  setBinding(input: SetModelTierBindingRequest): Promise<ModelTierResolutionPublic>;
  bindAllTiers(input: BindAllModelTiersRequest): Promise<ModelTierResolutionPublic[]>;
  updateDisplayMetadata(
    input: UpdateModelTierDisplayMetadataRequest,
  ): Promise<ModelTierResolutionPublic>;
  clearProjectBinding(projectId: string, tier: ModelTier): Promise<boolean>;
}

export interface AgentPresetServicePort {
  preparePreset(scope: ModelTierScope, presetId: AgentPresetId): Promise<AgentPresetPrepareResult>;
  previewPreset(scope: ModelTierScope, presetId: AgentPresetId): Promise<AgentPresetPreview>;
  applyPreset(
    scope: ModelTierScope,
    presetId: AgentPresetId,
    expectedRevision: string,
    previewConfirmed: boolean,
    overwriteConfirmed: boolean,
  ): Promise<AgentPresetApplyResult>;
  getPresetStatus(scope: ModelTierScope): Promise<AgentPresetStatus>;
}

export interface ModelSelectionTaskContext {
  projectId: string;
  status: string;
  fallbackModelId?: string | null;
}

export interface ModelProviderIPCDependencies {
  service: ModelProviderServicePort;
  policyService: AgentModelPolicyServicePort;
  selectionService: ModelSelectionServicePort;
  tierService: ModelTierServicePort;
  presetService: AgentPresetServicePort;
  projectAiConfigurationService: ProjectAiConfigurationServicePort;
  /** Main-process lookup: Renderer must never author project identity or task status. */
  getTaskContext(taskId: string): Awaitable<ModelSelectionTaskContext | null>;
  /** TaskManager live state closes the window before persisted task status is updated. */
  isTaskActive(taskId: string): boolean;
  /** Resolve lazily because IPC registration happens before the BrowserWindow is created. */
  getTrustedWebContents(): WebContents | null;
  /** Stable application entry URL; unlike WebContents.getURL(), this must not follow navigation. */
  getTrustedFrameUrl(): string | null;
  now?: () => number;
}

const controlFree = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const idInput = controlFree(256);
const providerIdInput = controlFree(192);
const applicationProviderIdInput = providerIdInput.refine(
  (value) => !value.toLowerCase().startsWith('synthetic:'),
);
const taskSwitchProviderIdInput = applicationProviderIdInput;
const tokenInput = z.string().trim().min(1).max(512).refine((value) => !value.includes('\0'));
const nullableTrimmed = (maximum: number) => z.string().trim().min(1).max(maximum).nullable();
const capabilitiesInput = z.object({
  supportsClaudeCode: z.boolean().optional(),
  supportsAgentWorkflow: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsMCP: z.boolean().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
}).strict();

const listInput = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  enabled: z.boolean().optional(),
}).strict();

const draftCommonInput = {
  providerId: applicationProviderIdInput.optional(),
  name: z.string().trim().min(1).max(80).refine((value) => !value.includes('\0')),
  type: z.enum(MODEL_PROVIDER_TYPES),
  apiFormat: z.enum(MODEL_API_FORMATS),
  credential: z.string().min(1).max(8_192).nullable(),
  defaultModelId: nullableTrimmed(256),
  capabilities: capabilitiesInput.optional(),
} as const;
const draftInput = z.union([
  z.object({
    ...draftCommonInput,
    baseUrlIntent: z.object({
      mode: z.literal('replace'),
      value: nullableTrimmed(2_048),
    }).strict(),
  }).strict(),
  z.object({
    ...draftCommonInput,
    providerId: applicationProviderIdInput,
    baseUrlIntent: z.object({ mode: z.literal('preserve_existing') }).strict(),
  }).strict(),
]);

const createInput = z.object({ validationToken: tokenInput }).strict();
const updateInput = z.object({
  providerId: applicationProviderIdInput,
  validationToken: tokenInput,
}).strict();
const deleteInput = z.object({
  providerId: applicationProviderIdInput,
  confirmCredentialDeletion: z.boolean(),
}).strict();
const setEnabledInput = z.object({
  providerId: applicationProviderIdInput,
  enabled: z.boolean(),
}).strict();
const agentTypeInput = z.enum(MODEL_POLICY_AGENT_TYPES);
const projectAgentTypeInput = z.enum(PROJECT_MODEL_POLICY_AGENT_TYPES);
const ratingInput = z.enum(POLICY_RATINGS).nullable();
const agentPolicyInput = z.object({
  agentType: agentTypeInput,
  providerId: applicationProviderIdInput,
  modelId: idInput,
  quality: ratingInput,
  speed: ratingInput,
  cost: ratingInput,
}).strict();
const deleteAgentPolicyInput = z.object({ agentType: agentTypeInput }).strict();
const projectPolicyListInput = z.object({ projectId: idInput }).strict();
const projectPolicyInput = z.object({
  projectId: idInput,
  agentType: projectAgentTypeInput,
  providerId: applicationProviderIdInput,
  modelId: idInput,
}).strict();
const deleteProjectPolicyInput = z.object({
  projectId: idInput,
  agentType: projectAgentTypeInput,
}).strict();
const effectiveSelectionInput = z.object({
  taskId: idInput,
  agentType: agentTypeInput.optional(),
}).strict();
const projectAiSummaryInput = z.object({ projectId: idInput }).strict();
const taskSwitchOptionsInput = z.object({ taskId: idInput }).strict();
const setTaskOverrideInput = z.object({
  taskId: idInput,
  providerId: taskSwitchProviderIdInput,
  modelId: idInput,
}).strict();
const clearTaskOverrideInput = z.object({ taskId: idInput }).strict();
const scopeInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).strict(),
  z.object({ type: z.literal('project'), projectId: controlFree(128) }).strict(),
]);
const listAgentPolicyReferencesInput = z.object({ scope: scopeInput }).strict();
const tierInput = z.enum(MODEL_TIERS);
const listTierCandidatesInput = z.object({ scope: scopeInput }).strict();
const listTierBindingsInput = z.object({ scope: scopeInput }).strict();
const setTierBindingInput = z.object({
  scope: scopeInput,
  tier: tierInput,
  providerId: providerIdInput,
  modelId: idInput,
}).strict();
const bindAllTiersInput = z.object({
  scope: scopeInput,
  providerId: providerIdInput,
  modelId: idInput,
}).strict();
const displayMetadataInput = z.object({
  tier: tierInput,
  displayName: controlFree(80).nullable(),
  quality: z.enum(POLICY_RATINGS).nullable(),
  speed: z.enum(POLICY_RATINGS).nullable(),
  cost: z.enum(POLICY_RATINGS).nullable(),
}).strict();
const updateTierDisplayInput = z.object({
  scope: scopeInput,
  metadata: displayMetadataInput,
}).strict();
const clearProjectTierInput = z.object({
  projectId: controlFree(128),
  tier: tierInput,
}).strict();
const presetIdInput = z.enum(AGENT_PRESET_IDS);
const presetInput = z.object({ scope: scopeInput, presetId: presetIdInput }).strict();
const presetStatusInput = z.object({ scope: scopeInput }).strict();
const presetRevisionInput = z.string().regex(/^agent-preset:v1:[a-f0-9]{64}$/u);
const applyPresetInput = z.object({
  scope: scopeInput,
  presetId: presetIdInput,
  expectedRevision: presetRevisionInput,
  previewConfirmed: z.boolean(),
  overwriteConfirmed: z.boolean(),
}).strict();

const projectAiTierOutput = z.object({
  tier: z.enum(MODEL_TIERS),
  display: z.object({
    tier: z.enum(MODEL_TIERS),
    displayName: controlFree(80).nullable(),
    quality: ratingInput,
    speed: ratingInput,
    cost: ratingInput,
  }),
  source: z.enum(['global', 'project', 'none']),
  validity: z.enum(['valid', 'needs_reconfiguration', 'unbound']),
  invalidReason: z.enum(MODEL_TIER_INVALID_REASONS).nullable(),
  candidate: z.object({
    providerName: controlFree(128),
    modelId: idInput,
    modelDisplayName: controlFree(256).nullable(),
    runtimeType: z.literal('claude-code'),
    health: z.object({
      state: z.enum(PROVIDER_HEALTH_STATES),
      lastTestedAt: z.number().finite().nullable(),
    }),
  }).nullable(),
});
const projectAiRoleOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('resolved'),
    role: agentTypeInput,
    providerName: controlFree(128),
    modelId: idInput,
    runtimeType: z.literal('claude-code'),
    source: z.enum(PROJECT_AI_BASELINE_SELECTION_SOURCES),
    tier: tierInput.optional(),
    tierSource: z.enum(['global', 'project']).optional(),
  }),
  z.object({
    status: z.literal('unavailable'),
    role: agentTypeInput,
    reason: z.enum(PROJECT_AI_UNAVAILABLE_REASONS),
  }),
]);
const projectAiSummaryOutput = z.object({
  includesTaskOverride: z.literal(false),
  presetStatus: z.union([
    z.object({ kind: z.literal('custom') }),
    z.object({ kind: z.literal('preset'), presetId: z.enum(AGENT_PRESET_IDS) }),
  ]),
  tiers: z.array(projectAiTierOutput).length(MODEL_TIERS.length).superRefine((values, context) => {
    if (values.some((value, index) => value.tier !== MODEL_TIERS[index])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Project AI tiers are not canonical.',
      });
    }
  }),
  roles: z.array(projectAiRoleOutput).length(MODEL_POLICY_AGENT_TYPES.length)
    .superRefine((values, context) => {
      if (values.some((value, index) => value.role !== MODEL_POLICY_AGENT_TYPES[index])) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Project AI roles are not canonical.',
        });
      }
    }),
});
const taskSwitchOptionOutput = z.object({
  providerId: taskSwitchProviderIdInput,
  providerName: controlFree(128),
  modelId: idInput,
  modelDisplayName: controlFree(256).nullable(),
  runtimeType: z.literal('claude-code'),
  purpose: z.literal('task_agent_override').default('task_agent_override'),
  source: z.literal('configured_provider').default('configured_provider'),
});

const MODEL_SWITCH_WARNING = '模型改变只影响后续 Agent 调用。';

const PUBLIC_CONNECTION_MESSAGES: Readonly<Record<ProviderConnectionErrorType, string>> = {
  invalid_key: 'API key is invalid.',
  forbidden: 'The Provider denied this request.',
  not_found: 'The Provider endpoint was not found.',
  rate_limited: 'The Provider rate limit was reached.',
  timeout: 'The Provider connection timed out.',
  network: 'The Provider could not be reached.',
  invalid_response: 'The Provider returned an invalid response.',
  unknown: 'The Provider connection test failed.',
};

const CONNECTION_ERROR_TYPES = new Set<ProviderConnectionErrorType>(
  Object.keys(PUBLIC_CONNECTION_MESSAGES) as ProviderConnectionErrorType[],
);

function publicBaseUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function publicProvider(value: PublicModelProvider): PublicModelProvider {
  const projected = toPublicModelProvider({
    ...value,
    capabilities: publicCapabilities(value.capabilities),
  });
  return {
    ...projected,
    baseUrl: publicBaseUrl(projected.baseUrl),
  };
}

function publicCapabilities(value: ProviderCapabilities): ProviderCapabilities {
  return {
    supportsClaudeCode: value.supportsClaudeCode,
    supportsAgentWorkflow: value.supportsAgentWorkflow,
    supportsTools: value.supportsTools,
    supportsMCP: value.supportsMCP,
    supportsStreaming: value.supportsStreaming,
    supportsVision: value.supportsVision,
  };
}

function publicAgentPolicy(value: AgentModelPolicyRecordPort): PublicAgentModelPolicy {
  return {
    agentType: value.agentType,
    providerId: value.providerId,
    modelId: value.modelId,
    notes: {
      quality: value.quality,
      speed: value.speed,
      cost: value.cost,
    },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function publicAgentPolicyReference(
  value: AgentModelPolicyReferenceRecordPort,
): PublicAgentModelPolicyReference {
  return {
    scope: value.scope.type === 'global'
      ? { type: 'global' }
      : { type: 'project', projectId: value.scope.projectId },
    agentType: value.agentType,
    reference: value.reference.kind === 'tier'
      ? { kind: 'tier', tier: value.reference.tier }
      : {
          kind: 'model',
          providerId: value.reference.providerId,
          modelId: value.reference.modelId,
        },
    providerName: typeof value.providerName === 'string'
      && value.providerName.length > 0
      && value.providerName.length <= 128
      && !/[\u0000-\u001f\u007f]/u.test(value.providerName)
      ? value.providerName
      : null,
    notes: {
      quality: value.notes.quality,
      speed: value.notes.speed,
      cost: value.notes.cost,
    },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function publicProjectPolicy(value: ProjectModelPolicyRecordPort): PublicProjectModelPolicy {
  return {
    projectId: value.projectId,
    agentType: value.agentType,
    providerId: value.providerId,
    modelId: value.modelId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function publicSelection(value: ResolvedModelSelection): ResolvedModelSelection {
  const selection = {
    providerId: value.providerId,
    providerName: value.providerName,
    modelId: value.modelId,
    runtimeType: value.runtimeType,
    capabilities: publicCapabilities(value.capabilities),
    source: value.source,
    executionSource: value.executionSource,
  };
  return value.tier
    ? { ...selection, tier: value.tier, tierSource: value.tierSource }
    : selection;
}

function publicModel(value: ProviderModel): ProviderModel {
  return {
    providerId: value.providerId,
    modelId: value.modelId,
    displayName: value.displayName,
    source: value.source,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function publicConnection(value: ProviderConnectionResult): ProviderConnectionResult {
  const discoveredModelIds = value.discoveredModelIds
    .filter((modelId) => typeof modelId === 'string'
      && modelId.length > 0
      && modelId.length <= 256
      && !/[\u0000-\u001f\u007f]/u.test(modelId))
    .slice(0, 1_000);
  if (value.ok) {
    return {
      ok: true,
      testedAt: value.testedAt,
      latencyMs: value.latencyMs,
      discoveredModelIds,
    };
  }
  const type = CONNECTION_ERROR_TYPES.has(value.error.type) ? value.error.type : 'unknown';
  const statusCode = Number.isInteger(value.error.statusCode)
    && (value.error.statusCode as number) >= 100
    && (value.error.statusCode as number) <= 599
    ? value.error.statusCode
    : null;
  return {
    ok: false,
    testedAt: value.testedAt,
    latencyMs: value.latencyMs,
    discoveredModelIds,
    error: {
      type,
      statusCode,
      message: PUBLIC_CONNECTION_MESSAGES[type],
    },
  };
}

function publicTierScope(scope: ModelTierScope): ModelTierScope {
  return scope.type === 'global'
    ? { type: 'global' }
    : { type: 'project', projectId: scope.projectId };
}

function publicTierCandidate(value: ModelTierCandidatePublic): ModelTierCandidatePublic {
  if (
    !(MODEL_EXECUTION_SOURCES as readonly string[]).includes(value.executionSource)
    || !(PROVIDER_HEALTH_STATES as readonly string[]).includes(value.health.state)
    || value.runtimeType !== 'claude-code'
  ) {
    throw new Error('Unsafe model tier candidate.');
  }
  return {
    providerId: value.providerId,
    providerName: value.providerName,
    modelId: value.modelId,
    modelDisplayName: value.modelDisplayName,
    runtimeType: 'claude-code',
    executionSource: value.executionSource,
    health: {
      state: value.health.state,
      lastTestedAt: value.health.lastTestedAt,
    },
  };
}

function publicTierResolution(value: ModelTierResolutionPublic): ModelTierResolutionPublic {
  const base = {
    scope: publicTierScope(value.scope),
    tier: value.tier,
    display: {
      tier: value.display.tier,
      displayName: value.display.displayName,
      quality: value.display.quality,
      speed: value.display.speed,
      cost: value.display.cost,
    },
  };
  if (value.validity === 'valid') {
    return {
      ...base,
      source: value.source,
      binding: {
        tier: value.binding.tier,
        providerId: value.binding.providerId,
        modelId: value.binding.modelId,
        updatedAt: value.binding.updatedAt,
      },
      candidate: publicTierCandidate(value.candidate),
      validity: 'valid',
      invalidReason: null,
    };
  }
  if (value.validity === 'needs_reconfiguration') {
    if (!(MODEL_TIER_INVALID_REASONS as readonly string[]).includes(value.invalidReason)) {
      throw new Error('Unsafe model tier invalid reason.');
    }
    return {
      ...base,
      source: value.source,
      binding: {
        tier: value.binding.tier,
        providerId: value.binding.providerId,
        modelId: value.binding.modelId,
        updatedAt: value.binding.updatedAt,
      },
      candidate: null,
      validity: 'needs_reconfiguration',
      invalidReason: value.invalidReason,
    };
  }
  if (value.source === 'none' || value.binding === null) {
    return {
      ...base,
      source: 'none',
      binding: null,
      candidate: null,
      validity: 'unbound',
      invalidReason: 'tier_unbound',
    };
  }
  return {
    ...base,
    source: value.source,
    binding: {
      tier: value.binding.tier,
      providerId: null,
      modelId: null,
      updatedAt: value.binding.updatedAt,
    },
    candidate: null,
    validity: 'unbound',
    invalidReason: 'tier_unbound',
  };
}

function publicPresetPreview(value: AgentPresetPreview): AgentPresetPreview {
  const roles = Object.fromEntries(MODEL_POLICY_AGENT_TYPES.map((role) => {
    const preview = value.roles[role];
    return [role, {
      role,
      tier: preview.tier,
      resolution: publicTierResolution(preview.resolution),
    }];
  })) as unknown as AgentPresetPreview['roles'];
  return {
    scope: publicTierScope(value.scope),
    presetId: value.presetId,
    revision: value.revision,
    roles,
  };
}

function publicPrepareResult(value: AgentPresetPrepareResult): AgentPresetPrepareResult {
  return value.step === 'preview'
    ? { step: 'preview', preview: publicPresetPreview(value.preview) }
    : { step: 'bind_tiers', missingTiers: MODEL_TIERS.filter((tier) => (
        value.missingTiers.includes(tier)
      )) };
}

function parseConfiguration<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new PublicIpcError('INVALID_MODEL_CONFIGURATION_REQUEST');
  return result.data;
}

function typedPublicModelErrorCode(error: unknown): PublicIpcFailureCode | null {
  if (error instanceof PublicIpcError) return error.code;
  if (
    error instanceof AgentModelPolicyServiceError
    || error instanceof AgentPresetServiceError
    || error instanceof ModelProviderServiceError
    || error instanceof ModelSwitchError
    || error instanceof ModelTierServiceError
  ) {
    return publicIpcFailureMessage(error.code) === null
      ? null
      : error.code as PublicIpcFailureCode;
  }
  if (error instanceof ModelSelectionFailure) {
    return publicIpcFailureMessage(error.code) === null
      ? null
      : error.code as PublicIpcFailureCode;
  }
  return null;
}

async function safeConfigurationOperation<T>(
  fallbackCode: PublicIpcFailureCode,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = typedPublicModelErrorCode(error);
    if (code) throw new PublicIpcError(code);
    if (error instanceof z.ZodError) throw new PublicIpcError(fallbackCode);
    throw error;
  }
}

async function safeProjectAiConfigurationOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = typedPublicModelErrorCode(error);
    throw new PublicIpcError(code ?? 'PROJECT_AI_CONFIGURATION_FAILED');
  }
}

function publicModelProviderError(error: unknown): Error {
  if (error instanceof ModelSelectionFailure) {
    const fixedMessage = publicIpcFailureMessage(error.code);
    if (fixedMessage) return new ModelSelectionFailure(error.code, fixedMessage);
  }
  const code = typedPublicModelErrorCode(error);
  if (code) return new PublicIpcError(code);
  return new PublicIpcError('MODEL_PROVIDER_OPERATION_FAILED');
}

function publicValidation(value: ProviderValidationResult): ProviderValidationResult {
  return {
    validationToken: value.validationToken,
    connection: publicConnection(value.connection),
  };
}

function sendChange(
  target: WebContents,
  event: ModelProviderChangedEvent,
): void {
  if (!target.isDestroyed()) target.send(IPC_CHANNELS.MODEL_PROVIDER_CHANGED, event);
}

export function registerModelProviderIPC(
  ipcMain: PublicIpcRegistrar,
  dependencies: ModelProviderIPCDependencies,
): () => void {
  const channels: string[] = [];
  const now = dependencies.now ?? Date.now;
  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedMainFrame(
        event,
        dependencies,
        'Model Provider IPC requires the trusted main frame.',
      );
      try {
        return await listener(event, ...args);
      } catch (error) {
        throw publicModelProviderError(error);
      }
    });
  };
  const changed = (
    event: IpcMainInvokeEvent,
    type: ModelProviderChangedEvent['type'],
    providerId: string | null,
  ): void => sendChange(event.sender, { type, providerId, changedAt: now() });

  handle(IPC_CHANNELS.MODEL_PROVIDER_LIST, async (_event, raw = {}) => {
    const request = listInput.parse(raw);
    const page = await dependencies.service.listProviders(request);
    return {
      items: page.items.map(publicProvider),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    } satisfies ModelProviderPage;
  });

  handle(IPC_CHANNELS.MODEL_PROVIDER_GET, async (_event, rawProviderId) => (
    publicProvider(await dependencies.service.getProvider(applicationProviderIdInput.parse(rawProviderId)))
  ));

  handle(IPC_CHANNELS.MODEL_PROVIDER_LIST_MODELS, async (_event, rawProviderId) => (
    (await dependencies.service.listModels(applicationProviderIdInput.parse(rawProviderId)))
      .map(publicModel)
  ));

  handle(IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT, async (_event, raw) => {
    const input = draftInput.parse(raw);
    return publicValidation(await dependencies.service.validateDraft(input));
  });

  handle(IPC_CHANNELS.MODEL_PROVIDER_CREATE, async (event, raw) => {
    const result = publicProvider(await dependencies.service.createProvider(createInput.parse(raw)));
    changed(event, 'created', result.id);
    return result;
  });

  handle(IPC_CHANNELS.MODEL_PROVIDER_UPDATE, async (event, raw) => {
    const input = updateInput.parse(raw);
    const result = publicProvider(await dependencies.service.updateProvider(input));
    changed(event, 'updated', result.id);
    return result;
  });

  handle(IPC_CHANNELS.MODEL_PROVIDER_TEST_CONNECTION, async (event, rawProviderId) => {
    const providerId = applicationProviderIdInput.parse(rawProviderId);
    const result = publicConnection(await dependencies.service.testConnection(providerId));
    changed(event, 'tested', providerId);
    return result;
  });

  handle(IPC_CHANNELS.MODEL_PROVIDER_SET_DEFAULT, async (event, rawProviderId) => {
    const result = publicProvider(
      await dependencies.service.setDefaultProvider(applicationProviderIdInput.parse(rawProviderId)),
    );
    changed(event, 'default_changed', result.id);
    return result;
  });

  handle(IPC_CHANNELS.MODEL_PROVIDER_SET_ENABLED, async (event, raw) => {
    const input = setEnabledInput.parse(raw);
    const result = publicProvider(await dependencies.service.setProviderEnabled(input));
    changed(event, 'enabled_changed', result.id);
    return result;
  });

  handle(IPC_CHANNELS.MODEL_PROVIDER_DELETE, async (event, raw) => {
    const input = deleteInput.parse(raw);
    if (!input.confirmCredentialDeletion) {
      throw new PublicIpcError('DELETE_CONFIRMATION_REQUIRED');
    }
    await dependencies.service.deleteProvider(input);
    changed(event, 'deleted', input.providerId);
  });

  handle(IPC_CHANNELS.MODEL_POLICY_LIST_AGENT, async () => (
    (await dependencies.policyService.listAgentPolicies()).map(publicAgentPolicy)
  ));

  handle(IPC_CHANNELS.MODEL_POLICY_LIST_AGENT_REFERENCES, async (_event, raw) => (
    safeConfigurationOperation(
      'MODEL_POLICY_REFERENCES_FAILED',
      async () => {
        const input: ListAgentModelPolicyReferencesRequest = parseConfiguration(
          listAgentPolicyReferencesInput,
          raw,
        );
        return (await dependencies.policyService.listAgentPolicyReferences(input.scope))
          .map(publicAgentPolicyReference);
      },
    )
  ));

  handle(IPC_CHANNELS.MODEL_POLICY_SET_AGENT, async (event, raw) => {
    const input = agentPolicyInput.parse(raw);
    const result = publicAgentPolicy(await dependencies.policyService.setAgentPolicy(input));
    changed(event, 'policy_changed', input.providerId);
    return result;
  });

  handle(IPC_CHANNELS.MODEL_POLICY_DELETE_AGENT, async (event, raw) => {
    const input = deleteAgentPolicyInput.parse(raw);
    const deleted = await dependencies.policyService.deleteAgentPolicy(input.agentType);
    if (deleted) changed(event, 'policy_changed', null);
    return deleted;
  });

  handle(IPC_CHANNELS.MODEL_POLICY_LIST_PROJECT, async (_event, raw) => {
    const input = projectPolicyListInput.parse(raw);
    return (await dependencies.policyService.listProjectPolicies(input.projectId))
      .map(publicProjectPolicy);
  });

  handle(IPC_CHANNELS.MODEL_POLICY_SET_PROJECT, async (event, raw) => {
    const input = projectPolicyInput.parse(raw);
    const result = publicProjectPolicy(await dependencies.policyService.setProjectPolicy(input));
    changed(event, 'policy_changed', input.providerId);
    return result;
  });

  handle(IPC_CHANNELS.MODEL_POLICY_DELETE_PROJECT, async (event, raw) => {
    const input = deleteProjectPolicyInput.parse(raw);
    const deleted = await dependencies.policyService.deleteProjectPolicy(
      input.projectId,
      input.agentType,
    );
    if (deleted) changed(event, 'policy_changed', null);
    return deleted;
  });

  handle(IPC_CHANNELS.MODEL_TIER_LIST_CANDIDATES, async (_event, raw) => (
    safeConfigurationOperation(
      'MODEL_PROVIDER_OPERATION_FAILED',
      async () => {
        const input: ListModelTierCandidatesRequest = parseConfiguration(
          listTierCandidatesInput,
          raw,
        );
        return (await dependencies.tierService.listCandidates(input.scope))
          .map(publicTierCandidate);
      },
    )
  ));

  handle(IPC_CHANNELS.MODEL_TIER_LIST_BINDINGS, async (_event, raw) => (
    safeConfigurationOperation(
      'MODEL_PROVIDER_OPERATION_FAILED',
      async () => {
        const input: GetModelTierBindingsRequest = parseConfiguration(
          listTierBindingsInput,
          raw,
        );
        return (await dependencies.tierService.getBindings(input.scope))
          .map(publicTierResolution);
      },
    )
  ));

  handle(IPC_CHANNELS.MODEL_TIER_SET_BINDING, async (event, raw) => (
    safeConfigurationOperation(
      'TIER_BINDING_WRITE_FAILED',
      async () => {
        const input: SetModelTierBindingRequest = parseConfiguration(
          setTierBindingInput,
          raw,
        );
        const result = publicTierResolution(
          await dependencies.tierService.setBinding(input),
        );
        changed(event, 'tier_changed', null);
        return result;
      },
    )
  ));

  handle(IPC_CHANNELS.MODEL_TIER_BIND_ALL, async (event, raw) => (
    safeConfigurationOperation(
      'TIER_BINDING_WRITE_FAILED',
      async () => {
        const input: BindAllModelTiersRequest = parseConfiguration(
          bindAllTiersInput,
          raw,
        );
        const result = (await dependencies.tierService.bindAllTiers(input))
          .map(publicTierResolution);
        changed(event, 'tier_changed', null);
        return result;
      },
    )
  ));

  handle(IPC_CHANNELS.MODEL_TIER_UPDATE_DISPLAY_METADATA, async (event, raw) => (
    safeConfigurationOperation(
      'MODEL_PROVIDER_OPERATION_FAILED',
      async () => {
        const input: UpdateModelTierDisplayMetadataRequest = parseConfiguration(
          updateTierDisplayInput,
          raw,
        );
        const result = publicTierResolution(
          await dependencies.tierService.updateDisplayMetadata(input),
        );
        changed(event, 'tier_changed', null);
        return result;
      },
    )
  ));

  handle(IPC_CHANNELS.MODEL_TIER_CLEAR_PROJECT_BINDING, async (event, raw) => (
    safeConfigurationOperation(
      'TIER_BINDING_CLEAR_FAILED',
      async () => {
        const input: ClearProjectModelTierBindingRequest = parseConfiguration(
          clearProjectTierInput,
          raw,
        );
        const result = await dependencies.tierService.clearProjectBinding(
          input.projectId,
          input.tier,
        );
        if (result) changed(event, 'tier_changed', null);
        return result;
      },
    )
  ));

  handle(IPC_CHANNELS.AGENT_PRESET_PREPARE, async (_event, raw) => (
    safeConfigurationOperation(
      'PRESET_PREVIEW_FAILED',
      async () => {
        const input: PrepareAgentPresetRequest = parseConfiguration(presetInput, raw);
        return publicPrepareResult(
          await dependencies.presetService.preparePreset(input.scope, input.presetId),
        );
      },
    )
  ));

  handle(IPC_CHANNELS.AGENT_PRESET_PREVIEW, async (_event, raw) => (
    safeConfigurationOperation(
      'PRESET_PREVIEW_FAILED',
      async () => {
        const input: PreviewAgentPresetRequest = parseConfiguration(presetInput, raw);
        return publicPresetPreview(
          await dependencies.presetService.previewPreset(input.scope, input.presetId),
        );
      },
    )
  ));

  handle(IPC_CHANNELS.AGENT_PRESET_APPLY, async (event, raw) => (
    safeConfigurationOperation(
      'PRESET_APPLY_FAILED',
      async () => {
        const input: ApplyAgentPresetRequest = parseConfiguration(applyPresetInput, raw);
        const result = await dependencies.presetService.applyPreset(
          input.scope,
          input.presetId,
          input.expectedRevision,
          input.previewConfirmed,
          input.overwriteConfirmed,
        );
        const projected: AgentPresetApplyResult = {
          presetId: result.presetId,
          appliedAt: result.appliedAt,
        };
        changed(event, 'preset_applied', null);
        return projected;
      },
    )
  ));

  handle(IPC_CHANNELS.AGENT_PRESET_GET_STATUS, async (_event, raw) => (
    safeConfigurationOperation(
      'PRESET_STATUS_FAILED',
      async () => {
        const input: GetAgentPresetStatusRequest = parseConfiguration(presetStatusInput, raw);
        const status = await dependencies.presetService.getPresetStatus(input.scope);
        return status.kind === 'preset'
          ? { kind: 'preset', presetId: status.presetId } as const
          : { kind: 'custom' } as const;
      },
    )
  ));

  handle(IPC_CHANNELS.PROJECT_AI_GET_CONFIGURATION_SUMMARY, async (_event, raw) => (
    safeProjectAiConfigurationOperation(
      async () => projectAiSummaryOutput.parse(
        await dependencies.projectAiConfigurationService.getSummary(
          parseConfiguration(projectAiSummaryInput, raw),
        ),
      ) as ProjectAiConfigurationSummaryPublic,
    )
  ));

  const taskContext = async (taskId: string): Promise<ModelSelectionTaskContext> => {
    const context = await dependencies.getTaskContext(taskId);
    if (!context) throw new PublicIpcError('TASK_NOT_FOUND');
    return {
      projectId: idInput.parse(context.projectId),
      status: idInput.parse(context.status),
      ...(context.fallbackModelId === undefined
        ? {}
        : { fallbackModelId: nullableTrimmed(256).parse(context.fallbackModelId) }),
    };
  };

  const resolveTaskSelection = async (
    input: z.infer<typeof effectiveSelectionInput>,
    context?: ModelSelectionTaskContext,
  ): Promise<ResolvedModelSelection> => {
    const trusted = context ?? await taskContext(input.taskId);
    return publicSelection(await dependencies.selectionService.resolve({
      taskId: input.taskId,
      projectId: trusted.projectId,
      ...(input.agentType ? { agentType: input.agentType } : {}),
      ...(trusted.fallbackModelId === undefined
        ? {}
        : { fallbackModelId: trusted.fallbackModelId }),
      use: input.agentType ? 'agent-workflow' : 'chat',
    }));
  };

  handle(IPC_CHANNELS.MODEL_SELECTION_GET_EFFECTIVE, async (_event, raw) => (
    resolveTaskSelection(effectiveSelectionInput.parse(raw))
  ));

  handle(IPC_CHANNELS.MODEL_SELECTION_LIST_TASK_SWITCH_OPTIONS, async (_event, raw) => {
    const input = taskSwitchOptionsInput.parse(raw);
    await taskContext(input.taskId);
    const values = await dependencies.selectionService.listTaskModelSwitchOptions();
    return values.map((value) => taskSwitchOptionOutput.parse(value)) as TaskModelSwitchOptionPublic[];
  });

  handle(IPC_CHANNELS.MODEL_SELECTION_SET_TASK_OVERRIDE, async (event, raw) => {
    const input = setTaskOverrideInput.parse(raw);
    const context = await taskContext(input.taskId);
    if (dependencies.isTaskActive(input.taskId)) {
      throw new PublicIpcError('TASK_ACTIVE');
    }
    await dependencies.selectionService.setTaskOverride({
      ...input,
      status: context.status,
    });
    changed(event, 'selection_changed', input.providerId);
    return {
      selection: await resolveTaskSelection({ taskId: input.taskId }, context),
      warning: MODEL_SWITCH_WARNING,
    } satisfies TaskModelSwitchResult;
  });

  handle(IPC_CHANNELS.MODEL_SELECTION_CLEAR_TASK_OVERRIDE, async (event, raw) => {
    const input = clearTaskOverrideInput.parse(raw);
    const context = await taskContext(input.taskId);
    if (dependencies.isTaskActive(input.taskId)) {
      throw new PublicIpcError('TASK_ACTIVE');
    }
    await dependencies.selectionService.clearTaskOverride(input.taskId, context.status);
    changed(event, 'selection_changed', null);
    return {
      selection: await resolveTaskSelection({ taskId: input.taskId }, context),
      warning: MODEL_SWITCH_WARNING,
    } satisfies TaskModelSwitchResult;
  });

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

export const modelProviderIpcInternals = {
  assertTrustedMainFrame,
  createInput,
  deleteInput,
  draftInput,
  effectiveSelectionInput,
  listInput,
  publicAgentPolicy,
  publicConnection,
  publicProvider,
  publicProjectPolicy,
  publicSelection,
  setTaskOverrideInput,
  updateInput,
};
