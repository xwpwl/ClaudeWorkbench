import type {
  ClaudeInstallationInfo,
  ClaudeEventEnvelope,
  ClaudeRunDescriptor,
  ClaudeRunOptions,
  StartSessionOptions,
  UIPermissionMode,
} from './claude';
import type { Project, ProjectInspection, ProjectSettings } from './project';
import type {
  SessionSummary,
  SessionDetail,
  Message,
  HistoricalMessage,
  ForkOptions,
  ForkResult,
  SessionMetadataPatch,
} from './session';
import type { DiffResult, FileChange } from './fileChanges';
export type { DiffResult } from './fileChanges';
import type { DiffOptions, FileDiff, GitStatus, CommitPreview } from './git';
import type {
  AcceptChangesResult,
  Checkpoint,
  CheckpointChangedEvent,
  CheckpointType,
  CommitTaskResult,
  RestoreImpact,
  RestoreResult,
} from './checkpoint';
import type {
  McpDiscoveryResult,
  McpTestResult,
  SkillDiscoveryResult,
  SkillDocument,
  SkillIntegration,
} from './integrations';
import type {
  PageRequest,
  PageResult,
  PersistedTaskEvent,
  PersistedTaskSnapshot,
  TaskReport,
} from './workbench';
import type {
  PermissionAuditRecord,
  PermissionDecision,
  PermissionDecisionReceipt,
  ProjectPermissionRuleRecord,
  PermissionRequest,
  PermissionSettlement,
} from './permissionBroker';
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
} from './workflow';
import type { RecoveryCenterSnapshot, RecoveryItem } from './recovery';
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
  PublicProjectModelPolicy,
  ResolvedModelSelection,
  SetAgentModelPolicyRequest,
  SetProviderEnabledInput,
  SetProjectModelPolicyRequest,
  SetTaskModelOverrideRequest,
  TaskModelSwitchResult,
  UpdateProviderInput,
} from './modelProviders';
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
} from './modelTiers';
import type {
  GetProjectAiConfigurationSummaryRequest,
  ListTaskModelSwitchOptionsRequest,
  ProjectAiConfigurationSummaryPublic,
  TaskModelSwitchOptionPublic,
} from './projectAi';
import type { PublicIpcTransportEnvelope } from './publicIpc';
/** IPC channel names */
export const IPC_CHANNELS = {
  // Claude
  CLAUDE_CHECK_INSTALL: 'claude:check-install',
  CLAUDE_START_SESSION: 'claude:start-session',
  CLAUDE_SEND_MESSAGE: 'claude:send-message',
  CLAUDE_RESUME_SESSION: 'claude:resume-session',
  CLAUDE_STOP_SESSION: 'claude:stop-session',
  CLAUDE_EVENT: 'claude:event',
  CLAUDE_RESUME_SESSION_WITH_PROMPT: 'claude:resume-session-with-prompt',
  CLAUDE_RUN_PROMPT: 'claude:run-prompt',
  CLAUDE_STOP_RUN: 'claude:stop-run',
  PERMISSION_REQUEST: 'permission:request',
  PERMISSION_SETTLED: 'permission:settled',
  PERMISSION_DECIDE: 'permission:decide',
  PERMISSION_RULES_LIST: 'permission:rules:list',
  PERMISSION_RULE_SET_ENABLED: 'permission:rules:set-enabled',
  PERMISSION_RULE_DELETE: 'permission:rules:delete',
  PERMISSION_RULE_CLEAR: 'permission:rules:clear',
  PERMISSION_AUDIT_LIST: 'permission:audit:list',

  // Projects
  PROJECT_OPEN: 'project:open',
  PROJECT_LIST: 'project:list',
  PROJECT_DELETE: 'project:delete',
  PROJECT_GET_GIT_INFO: 'project:git-info',
  PROJECT_GET_SETTINGS: 'project:get-settings',
  PROJECT_SET_SETTINGS: 'project:set-settings',
  PROJECT_INSPECT: 'project:inspect',
  FIRST_RUN_CREATE_TEST_PROJECT: 'first-run:create-test-project',

  // Sessions
  SESSION_CREATE: 'session:create',
  SESSION_LIST: 'session:list',
  SESSION_LIST_PAGE: 'session:list-page',
  SESSION_GET: 'session:get',
  SESSION_UPDATE: 'session:update',
  SESSION_FORK: 'session:fork',
  SESSION_DELETE: 'session:delete',

  // Messages
  MESSAGE_LIST: 'message:list',
  MESSAGE_LIST_PAGE: 'message:list-page',
  MESSAGE_SAVE: 'message:save',

  // Agent tasks
  TASK_GET_SNAPSHOT: 'task:get-snapshot',
  TASK_LIST_EVENTS: 'task:list-events',
  TASK_GET_REPORT: 'task:get-report',
  TASK_EXPORT_REPORT: 'task:export-report',
  TASK_LIST_ACTIVE: 'task:list-active',

  // Persisted multi-agent workflows
  WORKFLOW_CREATE: 'workflow:create',
  WORKFLOW_GET: 'workflow:get',
  WORKFLOW_GET_BY_TASK: 'workflow:get-by-task',
  WORKFLOW_LIST_PAGE: 'workflow:list-page',
  WORKFLOW_LIST_STAGES: 'workflow:list-stages',
  WORKFLOW_GET_REVIEW: 'workflow:get-review',
  WORKFLOW_START_PLANNING: 'workflow:start-planning',
  WORKFLOW_UPDATE_PLAN: 'workflow:update-plan',
  WORKFLOW_START_EXECUTION: 'workflow:start-execution',
  WORKFLOW_PAUSE: 'workflow:pause',
  WORKFLOW_RESUME: 'workflow:resume',
  WORKFLOW_CANCEL: 'workflow:cancel',
  WORKFLOW_ACCEPT_REVIEW: 'workflow:accept-review',
  WORKFLOW_EXPORT_REVIEW: 'workflow:export-review',
  WORKFLOW_COMMIT_PREVIEW: 'workflow:commit-preview',
  WORKFLOW_CHANGED: 'workflow:changed',

  // Model Provider Center
  MODEL_PROVIDER_LIST: 'model-provider:list',
  MODEL_PROVIDER_GET: 'model-provider:get',
  MODEL_PROVIDER_LIST_MODELS: 'model-provider:list-models',
  MODEL_PROVIDER_VALIDATE_DRAFT: 'model-provider:validate-draft',
  MODEL_PROVIDER_CREATE: 'model-provider:create',
  MODEL_PROVIDER_UPDATE: 'model-provider:update',
  MODEL_PROVIDER_TEST_CONNECTION: 'model-provider:test-connection',
  MODEL_PROVIDER_SET_DEFAULT: 'model-provider:set-default',
  MODEL_PROVIDER_SET_ENABLED: 'model-provider:set-enabled',
  MODEL_PROVIDER_DELETE: 'model-provider:delete',
  MODEL_PROVIDER_CHANGED: 'model-provider:changed',
  MODEL_POLICY_LIST_AGENT: 'model-policy:list-agent',
  MODEL_POLICY_LIST_AGENT_REFERENCES: 'model-policy:list-agent-references',
  MODEL_POLICY_SET_AGENT: 'model-policy:set-agent',
  MODEL_POLICY_DELETE_AGENT: 'model-policy:delete-agent',
  MODEL_POLICY_LIST_PROJECT: 'model-policy:list-project',
  MODEL_POLICY_SET_PROJECT: 'model-policy:set-project',
  MODEL_POLICY_DELETE_PROJECT: 'model-policy:delete-project',
  MODEL_SELECTION_GET_EFFECTIVE: 'model-selection:get-effective',
  MODEL_SELECTION_LIST_TASK_SWITCH_OPTIONS: 'model-selection:list-task-switch-options',
  MODEL_SELECTION_SET_TASK_OVERRIDE: 'model-selection:set-task-override',
  MODEL_SELECTION_CLEAR_TASK_OVERRIDE: 'model-selection:clear-task-override',
  PROJECT_AI_GET_CONFIGURATION_SUMMARY: 'project-ai:get-configuration-summary',
  MODEL_TIER_LIST_CANDIDATES: 'model-tier:list-candidates',
  MODEL_TIER_LIST_BINDINGS: 'model-tier:list-bindings',
  MODEL_TIER_SET_BINDING: 'model-tier:set-binding',
  MODEL_TIER_BIND_ALL: 'model-tier:bind-all',
  MODEL_TIER_UPDATE_DISPLAY_METADATA: 'model-tier:update-display-metadata',
  MODEL_TIER_CLEAR_PROJECT_BINDING: 'model-tier:clear-project-binding',
  AGENT_PRESET_PREPARE: 'agent-preset:prepare',
  AGENT_PRESET_PREVIEW: 'agent-preset:preview',
  AGENT_PRESET_APPLY: 'agent-preset:apply',
  AGENT_PRESET_GET_STATUS: 'agent-preset:get-status',

  // File changes
  FILE_CHANGES_LIST: 'file-changes:list',
  FILE_DIFF: 'file-changes:diff',
  FILE_RESTORE: 'file-changes:restore',
  FILE_OPEN_IN_VSCODE: 'file-changes:open-vscode',

  // Git workspace and AI checkpoints
  GIT_WORKSPACE_STATUS: 'git-workspace:status',
  GIT_WORKSPACE_INIT: 'git-workspace:init',
  GIT_WORKSPACE_DIFF: 'git-workspace:diff',
  CHECKPOINT_LIST: 'checkpoint:list',
  CHECKPOINT_CREATE: 'checkpoint:create',
  CHECKPOINT_RESTORE_PREVIEW: 'checkpoint:restore-preview',
  CHECKPOINT_RESTORE: 'checkpoint:restore',
  CHECKPOINT_ACCEPT: 'checkpoint:accept',
  CHECKPOINT_COMMIT_PREVIEW: 'checkpoint:commit-preview',
  CHECKPOINT_COMMIT: 'checkpoint:commit',
  CHECKPOINT_CHANGED: 'checkpoint:changed',

  // Read-only integration discovery and project-local Workbench controls
  INTEGRATIONS_DISCOVER_MCP: 'integrations:discover-mcp',
  INTEGRATIONS_DISCOVER_SKILLS: 'integrations:discover-skills',
  INTEGRATIONS_READ_SKILL: 'integrations:read-skill',
  INTEGRATIONS_SET_MCP_ENABLED: 'integrations:set-mcp-enabled',
  INTEGRATIONS_TEST_MCP: 'integrations:test-mcp',

  // Terminal
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_CLOSE: 'terminal:close',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_EXIT: 'terminal:exit',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  FIRST_RUN_GET_COMPLETED_VERSION: 'first-run:get-completed-version',
  FIRST_RUN_SET_COMPLETED_VERSION: 'first-run:set-completed-version',
  FIRST_RUN_GET_RESUME_STEP: 'first-run:get-resume-step',
  FIRST_RUN_SET_RESUME_STEP: 'first-run:set-resume-step',

  // Release / updates
  RELEASE_GET_VERSION: 'release:get-version',
  RELEASE_GET_UPDATE_STATE: 'release:get-update-state',
  RELEASE_CHECK_UPDATE: 'release:check-update',
  RELEASE_DOWNLOAD_UPDATE: 'release:download-update',
  RELEASE_INSTALL_UPDATE: 'release:install-update',

  // System
  SYSTEM_CHECK_ENV: 'system:check-env',
  SYSTEM_OPEN_PATH: 'system:open-path',
  SYSTEM_SELECT_DIRECTORY: 'system:select-directory',
  SYSTEM_OPEN_VSCODE: 'system:open-vscode',
  SYSTEM_GET_CONNECTION_STATUS: 'system:get-connection-status',
  SYSTEM_TEST_CLAUDE: 'system:test-claude',
  SYSTEM_GET_DIAGNOSTICS: 'system:get-diagnostics',
  SYSTEM_EXPORT_DIAGNOSTICS: 'system:export-diagnostics',

  // Crash recovery (main-process authority only)
  RECOVERY_GET: 'recovery:get',
  RECOVERY_RESUME: 'recovery:resume',
  RECOVERY_ABANDON: 'recovery:abandon',
  RECOVERY_OPEN_LOGS: 'recovery:open-logs',

  // Dialog
  DIALOG_OPEN_DIRECTORY: 'dialog:open-directory',

  // History (local Claude Code sessions)
  HISTORY_LIST: 'history:list',
  HISTORY_GET_MESSAGES: 'history:get-messages',
  HISTORY_GET_MESSAGES_PAGE: 'history:get-messages-page',
  HISTORY_GET_INFO: 'history:get-info',
  HISTORY_RENAME: 'history:rename',
  HISTORY_ARCHIVE: 'history:archive',
  HISTORY_SET_ARCHIVED: 'history:set-archived',
  HISTORY_FORK: 'history:fork',
  HISTORY_DELETE: 'history:delete',

  // Native menu -> renderer command bridge
  MENU_COMMAND: 'menu:command',
} as const;

/** API exposed to renderer via contextBridge */
export type RendererClaudeRunOptions = Omit<
  ClaudeRunOptions,
  'modelProviderId' | 'resolvedModelSelection'
>;

export interface CreateSessionOptions {
  systemPrompt?: string;
  model?: string;
  permissionMode?: StartSessionOptions['permissionMode'];
}

export interface ClaudeWorkbenchAPI {
  // Claude
  checkInstallation(): Promise<ClaudeInstallationInfo>;
  runPrompt(options: RendererClaudeRunOptions): Promise<ClaudeRunDescriptor>;
  stopRun(runId: string): Promise<boolean>;
  onClaudeEvent(listener: (envelope: ClaudeEventEnvelope) => void): () => void;
  onPermissionRequest(listener: (request: PermissionRequest) => void): () => void;
  onPermissionSettled(listener: (settlement: PermissionSettlement) => void): () => void;
  decidePermission(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<PermissionDecisionReceipt>;
  listProjectPermissionRules(
    projectId: string,
    page?: PageRequest,
  ): Promise<PageResult<ProjectPermissionRuleRecord>>;
  setProjectPermissionRuleEnabled(
    projectId: string,
    ruleId: string,
    enabled: boolean,
  ): Promise<ProjectPermissionRuleRecord>;
  deleteProjectPermissionRule(projectId: string, ruleId: string): Promise<boolean>;
  clearProjectPermissionRules(projectId: string, confirmed: boolean): Promise<number>;
  listProjectPermissionAudit(
    projectId: string,
    page?: PageRequest,
  ): Promise<PageResult<PermissionAuditRecord>>;

  // Projects
  openProject(): Promise<Project | null>;
  listProjects(): Promise<Project[]>;
  deleteProject(projectId: string): Promise<void>;
  getGitInfo(projectPath: string): Promise<GitInfo>;
  getProjectSettings(projectId: string): Promise<ProjectSettings>;
  setProjectSettings(projectId: string, patch: Partial<ProjectSettings>): Promise<ProjectSettings>;
  inspectProject(projectPath: string): Promise<ProjectInspection>;
  createFirstRunTestProject(): Promise<Project>;

  // Sessions
  createSession(projectId: string, options?: CreateSessionOptions): Promise<string>;
  listSessions(projectId: string): Promise<SessionSummary[]>;
  listSessionPage(projectId: string, page?: PageRequest): Promise<PageResult<SessionSummary>>;
  getSession(sessionId: string): Promise<SessionDetail | null>;
  updateSession(sessionId: string, patch: SessionMetadataPatch): Promise<boolean>;
  forkSession(sessionId: string, options?: ForkOptions): Promise<ForkResult>;
  deleteSession(sessionId: string): Promise<void>;

  // Messages
  listMessages(sessionId: string): Promise<Message[]>;
  listMessagePage(sessionId: string, page?: PageRequest): Promise<PageResult<Message>>;
  saveMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    messageId?: string,
  ): Promise<string>;

  // Agent tasks
  getTaskSnapshot(sessionId: string, page?: PageRequest): Promise<PersistedTaskSnapshot | null>;
  listTaskEvents(sessionId: string, page?: PageRequest): Promise<PageResult<PersistedTaskEvent>>;
  getTaskReport(sessionId: string): Promise<TaskReport | null>;
  exportTaskReport(sessionId: string): Promise<string | null>;
  listActiveTasks(): Promise<ActiveTaskSummary[]>;

  // Persisted multi-agent workflows
  createWorkflow(input: CreateWorkflowRequest): Promise<Workflow>;
  getWorkflow(workflowId: string): Promise<Workflow | null>;
  getWorkflowByTask(taskId: string): Promise<Workflow | null>;
  listWorkflowPage(request: WorkflowPageRequest): Promise<WorkflowPage<WorkflowSummary>>;
  listWorkflowStages(
    workflowId: string,
    page?: WorkflowListRequest,
  ): Promise<WorkflowPage<WorkflowStageRecord>>;
  getWorkflowReview(workflowId: string, round?: number): Promise<ReviewReport | null>;
  startWorkflowPlanning(workflowId: string, feedback?: string): Promise<Workflow>;
  updateWorkflowPlan(workflowId: string, plan: ExecutionPlan): Promise<Workflow>;
  startWorkflowExecution(workflowId: string): Promise<Workflow>;
  pauseWorkflow(workflowId: string): Promise<Workflow>;
  resumeWorkflow(workflowId: string, allowAfterFixLimit?: boolean): Promise<Workflow>;
  cancelWorkflow(workflowId: string): Promise<Workflow>;
  acceptWorkflowReview(workflowId: string): Promise<Workflow>;
  exportWorkflowReview(workflowId: string): Promise<string | null>;
  createWorkflowCommitPreview(workflowId: string): Promise<CommitPreview>;
  onWorkflowChanged(listener: (event: WorkflowChangedEvent) => void): () => void;

  // Model Provider Center
  listModelProviders(request?: ModelProviderListRequest): Promise<ModelProviderPage>;
  getModelProvider(providerId: string): Promise<PublicModelProvider>;
  listModelProviderModels(providerId: string): Promise<ProviderModel[]>;
  validateModelProviderDraft(input: ProviderDraftInput): Promise<ProviderValidationResult>;
  createModelProvider(input: CreateProviderInput): Promise<PublicModelProvider>;
  updateModelProvider(input: UpdateProviderInput): Promise<PublicModelProvider>;
  testModelProviderConnection(providerId: string): Promise<ProviderConnectionResult>;
  setDefaultModelProvider(providerId: string): Promise<PublicModelProvider>;
  setModelProviderEnabled(input: SetProviderEnabledInput): Promise<PublicModelProvider>;
  deleteModelProvider(input: DeleteProviderInput): Promise<void>;
  onModelProviderChanged(listener: (event: ModelProviderChangedEvent) => void): () => void;
  listAgentModelPolicies(): Promise<PublicAgentModelPolicy[]>;
  listAgentModelPolicyReferences(
    input: ListAgentModelPolicyReferencesRequest,
  ): Promise<PublicAgentModelPolicyReference[]>;
  setAgentModelPolicy(input: SetAgentModelPolicyRequest): Promise<PublicAgentModelPolicy>;
  deleteAgentModelPolicy(input: DeleteAgentModelPolicyRequest): Promise<boolean>;
  listProjectModelPolicies(
    input: ProjectModelPolicyListRequest,
  ): Promise<PublicProjectModelPolicy[]>;
  setProjectModelPolicy(input: SetProjectModelPolicyRequest): Promise<PublicProjectModelPolicy>;
  deleteProjectModelPolicy(input: DeleteProjectModelPolicyRequest): Promise<boolean>;
  getEffectiveModelSelection(input: EffectiveModelSelectionRequest): Promise<ResolvedModelSelection>;
  getProjectAiConfigurationSummary(
    input: GetProjectAiConfigurationSummaryRequest,
  ): Promise<ProjectAiConfigurationSummaryPublic>;
  listTaskModelSwitchOptions(
    input: ListTaskModelSwitchOptionsRequest,
  ): Promise<TaskModelSwitchOptionPublic[]>;
  setTaskModelOverride(input: SetTaskModelOverrideRequest): Promise<TaskModelSwitchResult>;
  clearTaskModelOverride(input: ClearTaskModelOverrideRequest): Promise<TaskModelSwitchResult>;
  listModelTierCandidates(
    input: ListModelTierCandidatesRequest,
  ): Promise<ModelTierCandidatePublic[]>;
  listModelTierBindings(
    input: GetModelTierBindingsRequest,
  ): Promise<ModelTierResolutionPublic[]>;
  setModelTierBinding(
    input: SetModelTierBindingRequest,
  ): Promise<ModelTierResolutionPublic>;
  bindAllModelTiers(
    input: BindAllModelTiersRequest,
  ): Promise<ModelTierResolutionPublic[]>;
  updateModelTierDisplayMetadata(
    input: UpdateModelTierDisplayMetadataRequest,
  ): Promise<ModelTierResolutionPublic>;
  clearProjectModelTierBinding(
    input: ClearProjectModelTierBindingRequest,
  ): Promise<boolean>;
  prepareAgentPreset(input: PrepareAgentPresetRequest): Promise<AgentPresetPrepareResult>;
  previewAgentPreset(input: PreviewAgentPresetRequest): Promise<AgentPresetPreview>;
  applyAgentPreset(input: ApplyAgentPresetRequest): Promise<AgentPresetApplyResult>;
  getAgentPresetStatus(input: GetAgentPresetStatusRequest): Promise<AgentPresetStatus>;

  // File changes
  listFileChanges(projectPath: string): Promise<FileChange[]>;
  getFileDiff(filePath: string, projectPath: string): Promise<DiffResult>;
  restoreFile(filePath: string, projectPath: string): Promise<void>;
  openFileInVSCode(filePath: string, projectPath: string): Promise<void>;

  // Git workspace and AI checkpoints
  getGitWorkspaceStatus(projectId: string, projectPath: string): Promise<GitStatus>;
  initializeGitWorkspace(projectId: string, projectPath: string): Promise<GitStatus>;
  getGitWorkspaceDiff(
    projectId: string,
    projectPath: string,
    options?: DiffOptions,
  ): Promise<FileDiff[]>;
  listCheckpoints(taskId: string): Promise<Checkpoint[]>;
  createCheckpoint(taskId: string, type?: CheckpointType): Promise<Checkpoint>;
  previewCheckpointRestore(checkpointId: string): Promise<RestoreImpact>;
  restoreCheckpoint(checkpointId: string, confirmationToken: string): Promise<RestoreResult>;
  acceptTaskChanges(taskId: string): Promise<AcceptChangesResult>;
  createCommitPreview(taskId: string): Promise<CommitPreview>;
  commitTaskChanges(
    taskId: string,
    subject: string,
    confirmed: boolean,
  ): Promise<CommitTaskResult>;
  onCheckpointChanged(listener: (event: CheckpointChangedEvent) => void): () => void;

  // Integrations
  discoverMcp(projectId: string, projectPath: string): Promise<McpDiscoveryResult>;
  discoverSkills(projectId: string, projectPath: string): Promise<SkillDiscoveryResult>;
  readSkill(projectId: string, projectPath: string, skill: SkillIntegration): Promise<SkillDocument>;
  setMcpEnabled(projectId: string, serverName: string, enabled: boolean): Promise<ProjectSettings>;
  testMcp(projectId: string, projectPath: string, serverId: string): Promise<McpTestResult>;

  // Terminal
  createTerminal(projectPath: string): Promise<string>;
  writeToTerminal(terminalId: string, data: string): Promise<void>;
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
  closeTerminal(terminalId: string): Promise<void>;
  onTerminalOutput(terminalId: string, listener: (data: string) => void): () => void;
  onTerminalExit(terminalId: string, listener: (code: number) => void): () => void;

  // Settings
  getSettings(): Promise<AppSettings>;
  setSettings(settings: Partial<AppSettings>): Promise<void>;
  getFirstRunCompletedVersion(): Promise<number>;
  setFirstRunCompletedVersion(version: 1): Promise<void>;
  getFirstRunResumeStep(): Promise<FirstRunResumeStep>;
  setFirstRunResumeStep(step: FirstRunResumeStep): Promise<void>;

  // Release / updates
  getReleaseVersion(): Promise<ReleaseVersionInfo>;
  getUpdateState(): Promise<UpdateSnapshot>;
  checkForUpdates(): Promise<UpdateSnapshot>;
  downloadUpdate(): Promise<UpdateSnapshot>;
  installUpdate(confirmed: boolean): Promise<boolean>;

  // System
  checkEnvironment(): Promise<EnvironmentCheckResult>;
  openPath(path: string): Promise<void>;
  selectDirectory(): Promise<string | null>;
  openInVSCode(path: string): Promise<void>;
  getConnectionStatus(): Promise<ConnectionStatus>;
  testClaude(): Promise<ClaudeTestResult>;
  getDiagnostics(): Promise<DiagnosticsInfo>;
  exportDiagnostics(intent: DiagnosticsExportIntent): Promise<boolean | null>;

  // Crash recovery
  getRecoveryCenter(): Promise<RecoveryCenterSnapshot>;
  resumeRecoveryItem(itemId: string): Promise<RecoveryItem>;
  abandonRecoveryItem(itemId: string): Promise<RecoveryItem>;
  openRecoveryLogs(): Promise<void>;

  // History (local Claude Code sessions)
  listHistorySessions(projectPath: string): Promise<SessionSummary[]>;
  getHistoryMessages(projectPath: string, sessionId: string): Promise<HistoricalMessage[]>;
  getHistoryMessagePage(
    projectPath: string,
    sessionId: string,
    page?: PageRequest,
  ): Promise<PageResult<HistoricalMessage>>;
  getHistorySessionInfo(projectPath: string, sessionId: string): Promise<SessionSummary | null>;
  renameHistorySession(projectPath: string, sessionId: string, title: string): Promise<void>;
  archiveHistorySession(projectPath: string, sessionId: string): Promise<void>;
  setHistorySessionArchived(
    projectPath: string,
    sessionId: string,
    archived: boolean,
  ): Promise<void>;
  forkHistorySession(projectPath: string, sessionId: string, options?: ForkOptions): Promise<ForkResult>;
  deleteHistorySession(projectPath: string, sessionId: string): Promise<void>;

  onMenuCommand(listener: (command: string) => void): () => void;

}

type ClaudeWorkbenchApiMethodKindMap = {
  [Key in keyof ClaudeWorkbenchAPI]: ReturnType<ClaudeWorkbenchAPI[Key]> extends () => void
    ? 'subscription'
    : 'promise';
};

/**
 * Runtime mirror of the explicit preload API. The `satisfies` gate makes this
 * the single exhaustive name/kind manifest rather than a count-only contract.
 */
export const CLAUDE_WORKBENCH_API_METHOD_KINDS = Object.freeze({
  checkInstallation: 'promise',
  runPrompt: 'promise',
  stopRun: 'promise',
  onClaudeEvent: 'subscription',
  onPermissionRequest: 'subscription',
  onPermissionSettled: 'subscription',
  decidePermission: 'promise',
  listProjectPermissionRules: 'promise',
  setProjectPermissionRuleEnabled: 'promise',
  deleteProjectPermissionRule: 'promise',
  clearProjectPermissionRules: 'promise',
  listProjectPermissionAudit: 'promise',
  openProject: 'promise',
  listProjects: 'promise',
  deleteProject: 'promise',
  getGitInfo: 'promise',
  getProjectSettings: 'promise',
  setProjectSettings: 'promise',
  inspectProject: 'promise',
  createFirstRunTestProject: 'promise',
  createSession: 'promise',
  listSessions: 'promise',
  listSessionPage: 'promise',
  getSession: 'promise',
  updateSession: 'promise',
  forkSession: 'promise',
  deleteSession: 'promise',
  listMessages: 'promise',
  listMessagePage: 'promise',
  saveMessage: 'promise',
  getTaskSnapshot: 'promise',
  listTaskEvents: 'promise',
  getTaskReport: 'promise',
  exportTaskReport: 'promise',
  listActiveTasks: 'promise',
  createWorkflow: 'promise',
  getWorkflow: 'promise',
  getWorkflowByTask: 'promise',
  listWorkflowPage: 'promise',
  listWorkflowStages: 'promise',
  getWorkflowReview: 'promise',
  startWorkflowPlanning: 'promise',
  updateWorkflowPlan: 'promise',
  startWorkflowExecution: 'promise',
  pauseWorkflow: 'promise',
  resumeWorkflow: 'promise',
  cancelWorkflow: 'promise',
  acceptWorkflowReview: 'promise',
  exportWorkflowReview: 'promise',
  createWorkflowCommitPreview: 'promise',
  onWorkflowChanged: 'subscription',
  listModelProviders: 'promise',
  getModelProvider: 'promise',
  listModelProviderModels: 'promise',
  validateModelProviderDraft: 'promise',
  createModelProvider: 'promise',
  updateModelProvider: 'promise',
  testModelProviderConnection: 'promise',
  setDefaultModelProvider: 'promise',
  setModelProviderEnabled: 'promise',
  deleteModelProvider: 'promise',
  onModelProviderChanged: 'subscription',
  listAgentModelPolicies: 'promise',
  listAgentModelPolicyReferences: 'promise',
  setAgentModelPolicy: 'promise',
  deleteAgentModelPolicy: 'promise',
  listProjectModelPolicies: 'promise',
  setProjectModelPolicy: 'promise',
  deleteProjectModelPolicy: 'promise',
  getEffectiveModelSelection: 'promise',
  getProjectAiConfigurationSummary: 'promise',
  listTaskModelSwitchOptions: 'promise',
  setTaskModelOverride: 'promise',
  clearTaskModelOverride: 'promise',
  listModelTierCandidates: 'promise',
  listModelTierBindings: 'promise',
  setModelTierBinding: 'promise',
  bindAllModelTiers: 'promise',
  updateModelTierDisplayMetadata: 'promise',
  clearProjectModelTierBinding: 'promise',
  prepareAgentPreset: 'promise',
  previewAgentPreset: 'promise',
  applyAgentPreset: 'promise',
  getAgentPresetStatus: 'promise',
  listFileChanges: 'promise',
  getFileDiff: 'promise',
  restoreFile: 'promise',
  openFileInVSCode: 'promise',
  getGitWorkspaceStatus: 'promise',
  initializeGitWorkspace: 'promise',
  getGitWorkspaceDiff: 'promise',
  listCheckpoints: 'promise',
  createCheckpoint: 'promise',
  previewCheckpointRestore: 'promise',
  restoreCheckpoint: 'promise',
  acceptTaskChanges: 'promise',
  createCommitPreview: 'promise',
  commitTaskChanges: 'promise',
  onCheckpointChanged: 'subscription',
  discoverMcp: 'promise',
  discoverSkills: 'promise',
  readSkill: 'promise',
  setMcpEnabled: 'promise',
  testMcp: 'promise',
  createTerminal: 'promise',
  writeToTerminal: 'promise',
  resizeTerminal: 'promise',
  closeTerminal: 'promise',
  onTerminalOutput: 'subscription',
  onTerminalExit: 'subscription',
  getSettings: 'promise',
  setSettings: 'promise',
  getFirstRunCompletedVersion: 'promise',
  setFirstRunCompletedVersion: 'promise',
  getFirstRunResumeStep: 'promise',
  setFirstRunResumeStep: 'promise',
  getReleaseVersion: 'promise',
  getUpdateState: 'promise',
  checkForUpdates: 'promise',
  downloadUpdate: 'promise',
  installUpdate: 'promise',
  checkEnvironment: 'promise',
  openPath: 'promise',
  selectDirectory: 'promise',
  openInVSCode: 'promise',
  getConnectionStatus: 'promise',
  testClaude: 'promise',
  getDiagnostics: 'promise',
  exportDiagnostics: 'promise',
  getRecoveryCenter: 'promise',
  resumeRecoveryItem: 'promise',
  abandonRecoveryItem: 'promise',
  openRecoveryLogs: 'promise',
  listHistorySessions: 'promise',
  getHistoryMessages: 'promise',
  getHistoryMessagePage: 'promise',
  getHistorySessionInfo: 'promise',
  renameHistorySession: 'promise',
  archiveHistorySession: 'promise',
  setHistorySessionArchived: 'promise',
  forkHistorySession: 'promise',
  deleteHistorySession: 'promise',
  onMenuCommand: 'subscription',
} satisfies ClaudeWorkbenchApiMethodKindMap);

export type ClaudeWorkbenchEventMethod = {
  [Key in keyof ClaudeWorkbenchAPI]:
    (typeof CLAUDE_WORKBENCH_API_METHOD_KINDS)[Key] extends 'subscription' ? Key : never;
}[keyof ClaudeWorkbenchAPI];

export const CLAUDE_WORKBENCH_API_METHODS = Object.freeze(
  Object.keys(CLAUDE_WORKBENCH_API_METHOD_KINDS) as Array<keyof ClaudeWorkbenchAPI>,
);

export const CLAUDE_WORKBENCH_EVENT_METHODS = Object.freeze(
  CLAUDE_WORKBENCH_API_METHODS.filter(
    (method): method is ClaudeWorkbenchEventMethod =>
      CLAUDE_WORKBENCH_API_METHOD_KINDS[method] === 'subscription',
  ),
);

export type ClaudeWorkbenchIpcTransport = {
  [Key in keyof ClaudeWorkbenchAPI]: ClaudeWorkbenchAPI[Key] extends (
    ...args: infer Arguments
  ) => Promise<infer Value>
    ? (...args: Arguments) => Promise<PublicIpcTransportEnvelope<Value>>
    : ClaudeWorkbenchAPI[Key];
};

export type ModelProviderChangeType =
  | 'created'
  | 'updated'
  | 'tested'
  | 'default_changed'
  | 'enabled_changed'
  | 'deleted'
  | 'policy_changed'
  | 'selection_changed'
  | 'tier_changed'
  | 'preset_applied';

export interface ModelProviderChangedEvent {
  type: ModelProviderChangeType;
  providerId: string | null;
  changedAt: number;
}

export interface ActiveTaskSummary {
  runId: string;
  sessionKey: string;
  projectKey: string;
  writable: boolean;
}

export interface GitInfo {
  branch: string | null;
  hasChanges: boolean;
  isRepo: boolean;
  ahead: number;
  behind: number;
}

export interface AppSettings {
  // Claude Code
  claudePath: string;
  autoDetectClaude: boolean;
  claudeGitBashPath: string;

  // Model
  defaultModel: string;
  detectedModel: string;
  modelSource: 'claude-default' | 'environment' | 'custom' | 'session';

  // Permissions
  defaultPermissionMode: UIPermissionMode;
  showDangerousPermissions: boolean;

  // Tools
  gitPath: string;
  vscodePath: string;

  // Terminal
  terminalShell: 'powershell' | 'powershell7' | 'cmd' | 'git-bash' | 'wsl';

  // Appearance
  theme: 'dark' | 'light' | 'system';
  fontSize: number;
  language: 'zh-CN' | 'en-US';

  // Data
  dataPath: string;

  // Updates
  autoCheckUpdates: boolean;
}

export const FIRST_RUN_RESUME_STEPS = [
  'welcome',
  'environment',
  'provider',
  'project',
  'first_task',
] as const;

export type FirstRunResumeStep = (typeof FIRST_RUN_RESUME_STEPS)[number];

export interface ReleaseVersionInfo {
  version: string;
  buildId: string;
  commit: string;
  channel: string;
  electronVersion: string;
  nodeVersion: string;
  sqliteSchemaVersion: number;
  agentRuntime: 'claude-code';
  packaged: boolean;
}

export type UpdateStatus =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'available'
  | 'not_available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateSnapshot {
  status: UpdateStatus;
  version: string | null;
  reason: 'development' | 'not_configured' | null;
  message: string | null;
}

export interface EnvironmentCheckResult {
  node: { ok: boolean; version: string | null; path: string | null };
  claude: { ok: boolean; version: string | null; path: string | null; installType: string | null };
  git: { ok: boolean; version: string | null; path: string | null };
  gitBash: { ok: boolean; path: string | null; configured: boolean };
  shell: { ok: boolean; name: string | null; path: string | null };
  projectDir: { ok: boolean; readable: boolean; writable: boolean };
  claudeConfiguration: { ok: boolean; source: 'environment' | 'claude_cli' | null };
  buildTools: { required: boolean; ok: boolean | null };
  providers: { runnable: number };
  dataDirectory: { ok: boolean; writable: boolean };
  sqlite: { ok: boolean; schemaVersion: number | null };
}

/** Connection status — NO secrets exposed to renderer */
export interface ConnectionStatus {
  connectionMethod: 'claude-environment' | 'custom-cli';
  baseUrl: string | null;
  baseUrlDetected: boolean;
  authToken: { configured: boolean; source: string | null };
  apiKey: { configured: boolean; source: string | null };
  loginStatus: 'available' | 'not-detected' | 'unknown';
}

/** Result of testing Claude Code */
export interface ClaudeTestResult {
  claudePath: string;
  claudeVersion: string | null;
  detectedModel: string | null;
  baseUrlStatus: string;
  success: boolean;
  durationMs: number;
  error: string | null;
}

/** Diagnostic info — all secrets redacted */
export interface DiagnosticsInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  electronVersion: string;
  appVersion: string;
  claude: {
    path: string | null;
    version: string | null;
    installType: string | null;
  };
  git: {
    path: string | null;
    version: string | null;
  };
  gitBash: {
    path: string | null;
    configured: boolean;
  };
  environment: {
    hasBaseUrl: boolean;
    hasAuthToken: boolean;
    hasApiKey: boolean;
    shellType: string;
  };
}

export interface DiagnosticsExportIntent {
  includeAnonymousPerformanceData: boolean;
}
