import { contextBridge } from 'electron';
import {
  createPublicIpcTransport,
  publicIpcRenderer as ipcRenderer,
} from './public-ipc-renderer';
import type {
  ClaudeWorkbenchAPI,
  GitInfo,
  DiffResult,
  AppSettings,
  EnvironmentCheckResult,
  ConnectionStatus,
  ClaudeTestResult,
  DiagnosticsInfo,
  ModelProviderChangedEvent,
  RendererClaudeRunOptions,
  CreateSessionOptions,
} from '../shared/types/ipc';
import type { FileChange } from '../shared/types/fileChanges';
import type { DiffOptions, FileDiff, GitStatus, CommitPreview } from '../shared/types/git';
import type {
  AcceptChangesResult,
  Checkpoint,
  CheckpointChangedEvent,
  CheckpointType,
  CommitTaskResult,
  RestoreImpact,
  RestoreResult,
} from '../shared/types/checkpoint';
import type { ProjectInspection, ProjectSettings } from '../shared/types/project';
import type {
  McpDiscoveryResult,
  McpTestResult,
  SkillDiscoveryResult,
  SkillDocument,
  SkillIntegration,
} from '../shared/types/integrations';
import type {
  PageRequest,
  PageResult,
  PersistedTaskEvent,
  PersistedTaskSnapshot,
  TaskReport,
} from '../shared/types/workbench';
import type { ActiveTaskSummary } from '../shared/types/ipc';
import type {
  ClaudeEventEnvelope,
  ClaudeInstallationInfo,
  ClaudeRunDescriptor,
} from '../shared/types/claude';
import type { Project } from '../shared/types/project';
import type {
  SessionSummary,
  SessionDetail,
  Message,
  HistoricalMessage,
  ForkOptions,
  ForkResult,
  SessionMetadataPatch,
} from '../shared/types/session';
import { IPC_CHANNELS } from '../shared/types/ipc';
import type {
  PermissionAuditRecord,
  PermissionDecision,
  PermissionDecisionReceipt,
  ProjectPermissionRuleRecord,
  PermissionRequest,
  PermissionSettlement,
} from '../shared/types/permissionBroker';
import type {
  CreateWorkflowRequest,
  ExecutionPlan,
  ReviewReport,
  Workflow,
  WorkflowChangedEvent,
  WorkflowListRequest,
  WorkflowPage,
  WorkflowPageRequest,
  WorkflowStageRecord,
  WorkflowSummary,
} from '../shared/types/workflow';
import type { RecoveryCenterSnapshot, RecoveryItem } from '../shared/types/recovery';
import type {
  ClearTaskModelOverrideRequest,
  CreateProviderInput,
  DeleteAgentModelPolicyRequest,
  DeleteProviderInput,
  DeleteProjectModelPolicyRequest,
  EffectiveModelSelectionRequest,
  ModelProviderListRequest,
  ModelProviderPage,
  ListAgentModelPolicyReferencesRequest,
  ProjectModelPolicyListRequest,
  ProviderConnectionResult,
  ProviderDraftInput,
  ProviderModel,
  ProviderValidationResult,
  PublicAgentModelPolicy,
  PublicAgentModelPolicyReference,
  PublicModelProvider,
  SetProviderEnabledInput,
  PublicProjectModelPolicy,
  ResolvedModelSelection,
  SetAgentModelPolicyRequest,
  SetProjectModelPolicyRequest,
  SetTaskModelOverrideRequest,
  TaskModelSwitchResult,
  UpdateProviderInput,
} from '../shared/types/modelProviders';
import type {
  AgentPresetApplyResult,
  AgentPresetPrepareResult,
  AgentPresetPreview,
  AgentPresetStatus,
  ApplyAgentPresetRequest,
  BindAllModelTiersRequest,
  ClearProjectModelTierBindingRequest,
  GetAgentPresetStatusRequest,
  GetModelTierBindingsRequest,
  ListModelTierCandidatesRequest,
  ModelTierCandidatePublic,
  ModelTierResolutionPublic,
  PrepareAgentPresetRequest,
  PreviewAgentPresetRequest,
  SetModelTierBindingRequest,
  UpdateModelTierDisplayMetadataRequest,
} from '../shared/types/modelTiers';
import type {
  GetProjectAiConfigurationSummaryRequest,
  ListTaskModelSwitchOptionsRequest,
  ProjectAiConfigurationSummaryPublic,
  TaskModelSwitchOptionPublic,
} from '../shared/types/projectAi';

const api: ClaudeWorkbenchAPI = {
  // Claude
  checkInstallation: (): Promise<ClaudeInstallationInfo> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CHECK_INSTALL),

  runPrompt: (options: RendererClaudeRunOptions): Promise<ClaudeRunDescriptor> => {
    const untrusted = options as RendererClaudeRunOptions & {
      modelProviderId?: unknown;
      resolvedModelSelection?: unknown;
    };
    const {
      modelProviderId: _modelProviderId,
      resolvedModelSelection: _resolvedModelSelection,
      ...rendererOptions
    } = untrusted;
    return ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_RUN_PROMPT, rendererOptions);
  },

  stopRun: (runId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_STOP_RUN, runId),

  onClaudeEvent: (listener: (envelope: ClaudeEventEnvelope) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, envelope: ClaudeEventEnvelope) => {
      listener(envelope);
    };
    ipcRenderer.on(IPC_CHANNELS.CLAUDE_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_EVENT, handler);
    };
  },

  onPermissionRequest: (listener: (request: PermissionRequest) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: PermissionRequest) => {
      listener(request);
    };
    ipcRenderer.on(IPC_CHANNELS.PERMISSION_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PERMISSION_REQUEST, handler);
  },

  onPermissionSettled: (
    listener: (settlement: PermissionSettlement) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      settlement: PermissionSettlement,
    ) => {
      listener(settlement);
    };
    ipcRenderer.on(IPC_CHANNELS.PERMISSION_SETTLED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PERMISSION_SETTLED, handler);
  },

  decidePermission: (
    requestId: string,
    decision: PermissionDecision,
  ): Promise<PermissionDecisionReceipt> =>
    ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_DECIDE, requestId, decision),

  listProjectPermissionRules: (
    projectId: string,
    page?: PageRequest,
  ): Promise<PageResult<ProjectPermissionRuleRecord>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_RULES_LIST, projectId, page),

  setProjectPermissionRuleEnabled: (
    projectId: string,
    ruleId: string,
    enabled: boolean,
  ): Promise<ProjectPermissionRuleRecord> =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PERMISSION_RULE_SET_ENABLED,
      projectId,
      ruleId,
      enabled,
    ),

  deleteProjectPermissionRule: (projectId: string, ruleId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_RULE_DELETE, projectId, ruleId),

  clearProjectPermissionRules: (projectId: string, confirmed: boolean): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_RULE_CLEAR, projectId, confirmed),

  listProjectPermissionAudit: (
    projectId: string,
    page?: PageRequest,
  ): Promise<PageResult<PermissionAuditRecord>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_AUDIT_LIST, projectId, page),

  // Projects
  openProject: (): Promise<Project | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_DIRECTORY).then((dir: string | null) => {
      if (!dir) return null;
      return ipcRenderer.invoke(IPC_CHANNELS.PROJECT_OPEN, dir);
    }),

  listProjects: (): Promise<Project[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST),

  deleteProject: (projectId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DELETE, projectId),

  getGitInfo: (projectPath: string): Promise<GitInfo> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_GET_GIT_INFO, projectPath),

  getProjectSettings: (projectId: string): Promise<ProjectSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_GET_SETTINGS, projectId),

  setProjectSettings: (
    projectId: string,
    patch: Partial<ProjectSettings>,
  ): Promise<ProjectSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SET_SETTINGS, projectId, patch),

  inspectProject: (projectPath: string): Promise<ProjectInspection> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_INSPECT, projectPath),

  createFirstRunTestProject: (): Promise<Project> =>
    ipcRenderer.invoke(IPC_CHANNELS.FIRST_RUN_CREATE_TEST_PROJECT),

  // Sessions
  createSession: (
    projectId: string,
    options?: CreateSessionOptions,
  ): Promise<string> =>
    options === undefined
      ? ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, projectId)
      : ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, projectId, options),

  listSessions: (projectId: string): Promise<SessionSummary[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST, projectId),

  listSessionPage: (
    projectId: string,
    page?: PageRequest,
  ): Promise<PageResult<SessionSummary>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST_PAGE, projectId, page),

  getSession: (sessionId: string): Promise<SessionDetail | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET, sessionId),

  updateSession: (sessionId: string, patch: SessionMetadataPatch): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_UPDATE, sessionId, patch),

  forkSession: (sessionId: string, options?: ForkOptions): Promise<ForkResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_FORK, sessionId, options),

  deleteSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, sessionId),

  // Messages
  listMessages: (sessionId: string): Promise<Message[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MESSAGE_LIST, sessionId),

  listMessagePage: (
    sessionId: string,
    page?: PageRequest,
  ): Promise<PageResult<Message>> =>
    ipcRenderer.invoke(IPC_CHANNELS.MESSAGE_LIST_PAGE, sessionId, page),

  saveMessage: (
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    messageId?: string,
  ): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.MESSAGE_SAVE, sessionId, role, content, messageId),

  // Agent tasks
  getTaskSnapshot: (
    sessionId: string,
    page?: PageRequest,
  ): Promise<PersistedTaskSnapshot | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_GET_SNAPSHOT, sessionId, page),

  listTaskEvents: (
    sessionId: string,
    page?: PageRequest,
  ): Promise<PageResult<PersistedTaskEvent>> =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST_EVENTS, sessionId, page),

  getTaskReport: (sessionId: string): Promise<TaskReport | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_GET_REPORT, sessionId),

  exportTaskReport: (sessionId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_EXPORT_REPORT, sessionId),

  listActiveTasks: (): Promise<ActiveTaskSummary[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST_ACTIVE),

  // Persisted multi-agent workflows
  createWorkflow: (input: CreateWorkflowRequest): Promise<Workflow> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_CREATE, input),

  getWorkflow: (workflowId: string): Promise<Workflow | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_GET, workflowId),

  getWorkflowByTask: (taskId: string): Promise<Workflow | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_GET_BY_TASK, taskId),

  listWorkflowPage: (request: WorkflowPageRequest): Promise<WorkflowPage<WorkflowSummary>> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_LIST_PAGE, request),

  listWorkflowStages: (
    workflowId: string,
    page?: WorkflowListRequest,
  ): Promise<WorkflowPage<WorkflowStageRecord>> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_LIST_STAGES, workflowId, page),

  getWorkflowReview: (workflowId: string, round?: number): Promise<ReviewReport | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_GET_REVIEW, workflowId, round),

  startWorkflowPlanning: (workflowId: string, feedback?: string): Promise<Workflow> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_START_PLANNING, workflowId, feedback),

  updateWorkflowPlan: (workflowId: string, plan: ExecutionPlan): Promise<Workflow> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_UPDATE_PLAN, workflowId, plan),

  startWorkflowExecution: (workflowId: string): Promise<Workflow> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_START_EXECUTION, workflowId),

  pauseWorkflow: (workflowId: string): Promise<Workflow> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_PAUSE, workflowId),

  resumeWorkflow: (workflowId: string, allowAfterFixLimit?: boolean): Promise<Workflow> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_RESUME, workflowId, allowAfterFixLimit),

  cancelWorkflow: (workflowId: string): Promise<Workflow> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_CANCEL, workflowId),

  acceptWorkflowReview: (workflowId: string): Promise<Workflow> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_ACCEPT_REVIEW, workflowId),

  exportWorkflowReview: (workflowId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_EXPORT_REVIEW, workflowId),

  createWorkflowCommitPreview: (workflowId: string): Promise<CommitPreview> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_COMMIT_PREVIEW, workflowId),

  onWorkflowChanged: (listener: (event: WorkflowChangedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, workflowEvent: WorkflowChangedEvent) => {
      listener(workflowEvent);
    };
    ipcRenderer.on(IPC_CHANNELS.WORKFLOW_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKFLOW_CHANGED, handler);
  },

  // Model Provider Center
  listModelProviders: (request?: ModelProviderListRequest): Promise<ModelProviderPage> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_LIST, request ?? {}),

  getModelProvider: (providerId: string): Promise<PublicModelProvider> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_GET, providerId),

  listModelProviderModels: (providerId: string): Promise<ProviderModel[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_LIST_MODELS, providerId),

  validateModelProviderDraft: (
    input: ProviderDraftInput,
  ): Promise<ProviderValidationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_VALIDATE_DRAFT, input),

  createModelProvider: (input: CreateProviderInput): Promise<PublicModelProvider> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_CREATE, input),

  updateModelProvider: (input: UpdateProviderInput): Promise<PublicModelProvider> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_UPDATE, input),

  testModelProviderConnection: (providerId: string): Promise<ProviderConnectionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_TEST_CONNECTION, providerId),

  setDefaultModelProvider: (providerId: string): Promise<PublicModelProvider> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_SET_DEFAULT, providerId),

  setModelProviderEnabled: (input: SetProviderEnabledInput): Promise<PublicModelProvider> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_SET_ENABLED, input),

  deleteModelProvider: (input: DeleteProviderInput): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_DELETE, input),

  listAgentModelPolicies: (): Promise<PublicAgentModelPolicy[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_POLICY_LIST_AGENT),

  listAgentModelPolicyReferences: (
    input: ListAgentModelPolicyReferencesRequest,
  ): Promise<PublicAgentModelPolicyReference[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_POLICY_LIST_AGENT_REFERENCES, input),

  setAgentModelPolicy: (
    input: SetAgentModelPolicyRequest,
  ): Promise<PublicAgentModelPolicy> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_POLICY_SET_AGENT, input),

  deleteAgentModelPolicy: (
    input: DeleteAgentModelPolicyRequest,
  ): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_POLICY_DELETE_AGENT, input),

  listProjectModelPolicies: (
    input: ProjectModelPolicyListRequest,
  ): Promise<PublicProjectModelPolicy[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_POLICY_LIST_PROJECT, input),

  setProjectModelPolicy: (
    input: SetProjectModelPolicyRequest,
  ): Promise<PublicProjectModelPolicy> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_POLICY_SET_PROJECT, input),

  deleteProjectModelPolicy: (
    input: DeleteProjectModelPolicyRequest,
  ): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_POLICY_DELETE_PROJECT, input),

  getEffectiveModelSelection: (
    input: EffectiveModelSelectionRequest,
  ): Promise<ResolvedModelSelection> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_SELECTION_GET_EFFECTIVE, input),

  getProjectAiConfigurationSummary: (
    input: GetProjectAiConfigurationSummaryRequest,
  ): Promise<ProjectAiConfigurationSummaryPublic> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_AI_GET_CONFIGURATION_SUMMARY, input),

  listTaskModelSwitchOptions: (
    input: ListTaskModelSwitchOptionsRequest,
  ): Promise<TaskModelSwitchOptionPublic[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_SELECTION_LIST_TASK_SWITCH_OPTIONS, input),

  setTaskModelOverride: (
    input: SetTaskModelOverrideRequest,
  ): Promise<TaskModelSwitchResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_SELECTION_SET_TASK_OVERRIDE, input),

  clearTaskModelOverride: (
    input: ClearTaskModelOverrideRequest,
  ): Promise<TaskModelSwitchResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_SELECTION_CLEAR_TASK_OVERRIDE, input),

  listModelTierCandidates: (
    input: ListModelTierCandidatesRequest,
  ): Promise<ModelTierCandidatePublic[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_TIER_LIST_CANDIDATES, input),

  listModelTierBindings: (
    input: GetModelTierBindingsRequest,
  ): Promise<ModelTierResolutionPublic[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_TIER_LIST_BINDINGS, input),

  setModelTierBinding: (
    input: SetModelTierBindingRequest,
  ): Promise<ModelTierResolutionPublic> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_TIER_SET_BINDING, input),

  bindAllModelTiers: (
    input: BindAllModelTiersRequest,
  ): Promise<ModelTierResolutionPublic[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_TIER_BIND_ALL, input),

  updateModelTierDisplayMetadata: (
    input: UpdateModelTierDisplayMetadataRequest,
  ): Promise<ModelTierResolutionPublic> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_TIER_UPDATE_DISPLAY_METADATA, input),

  clearProjectModelTierBinding: (
    input: ClearProjectModelTierBindingRequest,
  ): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_TIER_CLEAR_PROJECT_BINDING, input),

  prepareAgentPreset: (
    input: PrepareAgentPresetRequest,
  ): Promise<AgentPresetPrepareResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_PRESET_PREPARE, input),

  previewAgentPreset: (
    input: PreviewAgentPresetRequest,
  ): Promise<AgentPresetPreview> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_PRESET_PREVIEW, input),

  applyAgentPreset: (
    input: ApplyAgentPresetRequest,
  ): Promise<AgentPresetApplyResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_PRESET_APPLY, input),

  getAgentPresetStatus: (
    input: GetAgentPresetStatusRequest,
  ): Promise<AgentPresetStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_PRESET_GET_STATUS, input),

  onModelProviderChanged: (
    listener: (event: ModelProviderChangedEvent) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      providerEvent: ModelProviderChangedEvent,
    ) => listener(providerEvent);
    ipcRenderer.on(IPC_CHANNELS.MODEL_PROVIDER_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MODEL_PROVIDER_CHANGED, handler);
  },

  // File changes
  listFileChanges: (projectPath: string): Promise<FileChange[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_CHANGES_LIST, projectPath),

  getFileDiff: (filePath: string, projectPath: string): Promise<DiffResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_DIFF, filePath, projectPath),

  restoreFile: (filePath: string, projectPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_RESTORE, filePath, projectPath),

  openFileInVSCode: (filePath: string, projectPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_OPEN_IN_VSCODE, filePath, projectPath),

  // Git workspace and AI checkpoints
  getGitWorkspaceStatus: (projectId: string, projectPath: string): Promise<GitStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_WORKSPACE_STATUS, projectId, projectPath),

  initializeGitWorkspace: (projectId: string, projectPath: string): Promise<GitStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_WORKSPACE_INIT, projectId, projectPath),

  getGitWorkspaceDiff: (
    projectId: string,
    projectPath: string,
    options?: DiffOptions,
  ): Promise<FileDiff[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_WORKSPACE_DIFF, projectId, projectPath, options),

  listCheckpoints: (taskId: string): Promise<Checkpoint[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_LIST, taskId),

  createCheckpoint: (taskId: string, type?: CheckpointType): Promise<Checkpoint> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_CREATE, taskId, type),

  previewCheckpointRestore: (checkpointId: string): Promise<RestoreImpact> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_RESTORE_PREVIEW, checkpointId),

  restoreCheckpoint: (
    checkpointId: string,
    confirmationToken: string,
  ): Promise<RestoreResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_RESTORE, checkpointId, confirmationToken),

  acceptTaskChanges: (taskId: string): Promise<AcceptChangesResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_ACCEPT, taskId),

  createCommitPreview: (taskId: string): Promise<CommitPreview> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_COMMIT_PREVIEW, taskId),

  commitTaskChanges: (
    taskId: string,
    subject: string,
    confirmed: boolean,
  ): Promise<CommitTaskResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_COMMIT, taskId, subject, confirmed),

  onCheckpointChanged: (listener: (event: CheckpointChangedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, checkpointEvent: CheckpointChangedEvent) => {
      listener(checkpointEvent);
    };
    ipcRenderer.on(IPC_CHANNELS.CHECKPOINT_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHECKPOINT_CHANGED, handler);
  },

  // Integrations
  discoverMcp: (projectId: string, projectPath: string): Promise<McpDiscoveryResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.INTEGRATIONS_DISCOVER_MCP, projectId, projectPath),

  discoverSkills: (projectId: string, projectPath: string): Promise<SkillDiscoveryResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.INTEGRATIONS_DISCOVER_SKILLS, projectId, projectPath),

  readSkill: (
    projectId: string,
    projectPath: string,
    skill: SkillIntegration,
  ): Promise<SkillDocument> =>
    ipcRenderer.invoke(IPC_CHANNELS.INTEGRATIONS_READ_SKILL, projectId, projectPath, skill),

  setMcpEnabled: (
    projectId: string,
    serverName: string,
    enabled: boolean,
  ): Promise<ProjectSettings> =>
    ipcRenderer.invoke(
      IPC_CHANNELS.INTEGRATIONS_SET_MCP_ENABLED,
      projectId,
      serverName,
      enabled,
    ),

  testMcp: (
    projectId: string,
    projectPath: string,
    serverId: string,
  ): Promise<McpTestResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.INTEGRATIONS_TEST_MCP, projectId, projectPath, serverId),

  // Terminal
  createTerminal: (projectPath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, projectPath),

  writeToTerminal: (terminalId: string, data: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WRITE, terminalId, data),

  resizeTerminal: (
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, terminalId, cols, rows),

  closeTerminal: (terminalId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CLOSE, terminalId),

  onTerminalOutput: (
    terminalId: string,
    listener: (data: string) => void,
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: string) => {
      listener(data);
    };
    ipcRenderer.on(`${IPC_CHANNELS.TERMINAL_OUTPUT}:${terminalId}`, handler);
    return () => {
      ipcRenderer.removeListener(
        `${IPC_CHANNELS.TERMINAL_OUTPUT}:${terminalId}`,
        handler,
      );
    };
  },

  onTerminalExit: (
    terminalId: string,
    listener: (code: number) => void,
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, code: number) => {
      listener(code);
    };
    ipcRenderer.on(`${IPC_CHANNELS.TERMINAL_EXIT}:${terminalId}`, handler);
    return () => {
      ipcRenderer.removeListener(`${IPC_CHANNELS.TERMINAL_EXIT}:${terminalId}`, handler);
    };
  },

  // Settings
  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),

  setSettings: (settings: Partial<AppSettings>): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings),

  getFirstRunCompletedVersion: (): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.FIRST_RUN_GET_COMPLETED_VERSION),

  setFirstRunCompletedVersion: (version: 1): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.FIRST_RUN_SET_COMPLETED_VERSION, version),

  getFirstRunResumeStep: () =>
    ipcRenderer.invoke(IPC_CHANNELS.FIRST_RUN_GET_RESUME_STEP),

  setFirstRunResumeStep: (step) =>
    ipcRenderer.invoke(IPC_CHANNELS.FIRST_RUN_SET_RESUME_STEP, step),

  // Release / updates
  getReleaseVersion: () => ipcRenderer.invoke(IPC_CHANNELS.RELEASE_GET_VERSION),
  getUpdateState: () => ipcRenderer.invoke(IPC_CHANNELS.RELEASE_GET_UPDATE_STATE),
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.RELEASE_CHECK_UPDATE),
  downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.RELEASE_DOWNLOAD_UPDATE),
  installUpdate: (confirmed: boolean) => confirmed
    ? ipcRenderer.invoke(IPC_CHANNELS.RELEASE_INSTALL_UPDATE, { confirmed: true })
    : Promise.resolve(false),

  // System
  checkEnvironment: (): Promise<EnvironmentCheckResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_CHECK_ENV),

  openPath: (targetPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, targetPath),

  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_DIRECTORY),

  openInVSCode: (targetPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_VSCODE, targetPath),

  getConnectionStatus: (): Promise<ConnectionStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_CONNECTION_STATUS),

  testClaude: (): Promise<ClaudeTestResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_TEST_CLAUDE),

  getDiagnostics: (): Promise<DiagnosticsInfo> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_DIAGNOSTICS),

  exportDiagnostics: (intent): Promise<boolean | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_EXPORT_DIAGNOSTICS, intent),

  getRecoveryCenter: (): Promise<RecoveryCenterSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.RECOVERY_GET),

  resumeRecoveryItem: (itemId: string): Promise<RecoveryItem> =>
    ipcRenderer.invoke(IPC_CHANNELS.RECOVERY_RESUME, itemId),

  abandonRecoveryItem: (itemId: string): Promise<RecoveryItem> =>
    ipcRenderer.invoke(IPC_CHANNELS.RECOVERY_ABANDON, itemId),

  openRecoveryLogs: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.RECOVERY_OPEN_LOGS),

  // History (local Claude Code sessions)
  listHistorySessions: (projectPath: string): Promise<SessionSummary[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.HISTORY_LIST, projectPath),

  getHistoryMessages: (projectPath: string, sessionId: string): Promise<HistoricalMessage[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.HISTORY_GET_MESSAGES, projectPath, sessionId),

  getHistoryMessagePage: (
    projectPath: string,
    sessionId: string,
    page?: PageRequest,
  ): Promise<PageResult<HistoricalMessage>> =>
    ipcRenderer.invoke(IPC_CHANNELS.HISTORY_GET_MESSAGES_PAGE, projectPath, sessionId, page),

  getHistorySessionInfo: (projectPath: string, sessionId: string): Promise<SessionSummary | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.HISTORY_GET_INFO, projectPath, sessionId),

  renameHistorySession: (projectPath: string, sessionId: string, title: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.HISTORY_RENAME, projectPath, sessionId, title),

  archiveHistorySession: (projectPath: string, sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.HISTORY_ARCHIVE, projectPath, sessionId),

  setHistorySessionArchived: (
    projectPath: string,
    sessionId: string,
    archived: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke(
      IPC_CHANNELS.HISTORY_SET_ARCHIVED,
      projectPath,
      sessionId,
      archived,
    ),

  forkHistorySession: (projectPath: string, sessionId: string, options?: ForkOptions): Promise<ForkResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.HISTORY_FORK, projectPath, sessionId, options),

  deleteHistorySession: (projectPath: string, sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.HISTORY_DELETE, projectPath, sessionId),

  onMenuCommand: (listener: (command: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, command: string) => listener(command);
    ipcRenderer.on(IPC_CHANNELS.MENU_COMMAND, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_COMMAND, handler);
  },

};

contextBridge.exposeInMainWorld(
  '__claudeWorkbenchIpcTransport',
  createPublicIpcTransport(api),
);
