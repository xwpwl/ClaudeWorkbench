import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'fs';
import os from 'node:os';
import { createHmac, randomBytes } from 'node:crypto';
import path from 'path';
import { pathToFileURL } from 'node:url';
import { AppDatabase } from './database/Database';
import { ClaudeCliAdapter, selectStartupClaudeAdapter } from './claude/ClaudeCliAdapter';
import { ClaudeLocalSessionAdapter } from './claude/ClaudeLocalSessionAdapter';
import { FakeClaudeAdapter } from './claude/FakeClaudeAdapter';
import { registerClaudeIPC } from './ipc/claude';
import { registerFileChangesIPC } from './ipc/file-changes';
import { registerHistoryIPC } from './ipc/history';
import { registerProjectIPC } from './ipc/projects';
import { registerSessionIPC } from './ipc/sessions';
import { registerSettingsIPC } from './ipc/settings';
import { registerSystemIPC } from './ipc/system';
import { registerTerminalIPC } from './ipc/terminal';
import { registerPermissionIPC } from './ipc/permissions';
import { registerIntegrationsIPC } from './ipc/integrations';
import { registerTaskIPC } from './ipc/tasks';
import { registerGitWorkspaceIPC } from './ipc/git-workspace';
import { registerWorkflowIPC } from './ipc/workflows';
import { registerDiagnosticsExportIPC } from './ipc/diagnostics';
import { registerRecoveryIPC } from './ipc/recovery';
import { registerReleaseIPC } from './ipc/release';
import { registerModelProviderIPC } from './ipc/model-providers';
import { createPublicIpcMain } from './ipc/public-invoke-boundary';
import { PermissionBroker } from './permissions/PermissionBroker';
import { DatabasePermissionRuleStore } from './permissions/DatabasePermissionRuleStore';
import {
  PermissionAudit,
} from './permissions/PermissionAudit';
import { createNativeBypassConfirmation } from './permissions/NativeBypassConfirmation';
import { FileMutationManager } from './file-mutations/FileMutationManager';
import { TaskEventRecorder } from './tasks/TaskEventRecorder';
import { TaskManager } from './tasks/TaskManager';
import { finalizeStandalonePermissions } from './tasks/StandalonePermissionLifecycle';
import { CheckpointLifecycleCoordinator, CheckpointManager } from './checkpoints/CheckpointManager';
import { GitWorkspaceError } from './git/GitWorkspaceService';
import type { ClaudeAdapter } from '../shared/types/claude';
import { IPC_CHANNELS } from '../shared/types/ipc';
import { AgentWorkflowManager } from './workflows/AgentWorkflowManager';
import { TaskManagerAgentStageRunner } from './workflows/TaskManagerAgentStageRunner';
import {
  WorkflowInfrastructure,
  type WorkflowNotification,
} from './workflows/WorkflowInfrastructure';
import { installSingleInstanceGuard } from './lifecycle/SingleInstanceGuard';
import { ShutdownCoordinator } from './lifecycle/ShutdownCoordinator';
import { StructuredLogger } from './logging/StructuredLogger';
import { DiagnosticsExporter } from './diagnostics/DiagnosticsExporter';
import { CrashRecoveryManager, type RecoveryReport } from './recovery/CrashRecoveryManager';
import { ProcessSupervisor } from './processes/ProcessSupervisor';
import { DatabaseProcessJournal } from './processes/DatabaseProcessJournal';
import { buildVersionInfo } from './release/VersionInfo';
import {
  detectPackagedUpdateSource,
  UpdateManager,
  type UpdateClient,
} from './release/UpdateManager';
import { canonicalizeProjectPath } from './projects/ProjectService';
import { AgentModelPolicyService } from './model-providers/AgentModelPolicyService';
import { AgentRuntimeRegistry } from './model-providers/AgentRuntimeRegistry';
import { ClaudeCodeAgentRuntime } from './model-providers/ClaudeCodeAgentRuntime';
import { CredentialStore } from './model-providers/CredentialStore';
import { ModelProviderRepository } from './model-providers/ModelProviderRepository';
import { ModelProviderService } from './model-providers/ModelProviderService';
import { ModelRunOptionsResolver } from './model-providers/ModelRunOptionsResolver';
import { ModelSelectionResolver } from './model-providers/ModelSelectionResolver';
import { ModelTierService } from './model-providers/ModelTierService';
import { AgentPresetService } from './model-providers/AgentPresetService';
import { ProjectAiConfigurationService } from './model-providers/ProjectAiConfigurationService';
import { FirstRunService } from './first-run/FirstRunService';
import { ProviderConnectionTester } from './model-providers/ProviderConnectionTester';
import { ProviderEnvironmentResolver } from './model-providers/ProviderEnvironmentResolver';
import {
  ProviderExecutionEnvironmentService,
} from './model-providers/ProviderExecutionEnvironmentService';

let mainWindow: BrowserWindow | null = null;
let db: AppDatabase | null = null;
let claudeAdapter: ClaudeAdapter | null = null;
let unsubscribeClaudeEvents: (() => void) | null = null;
let unsubscribePermissionRequests: (() => void) | null = null;
let unsubscribeTaskEvents: (() => void) | null = null;
let unsubscribeTaskPermissions: (() => void) | null = null;
let unsubscribeTaskStarts: (() => void) | null = null;
let unsubscribeCheckpointStarts: (() => void) | null = null;
let unsubscribeCheckpointEvents: (() => void) | null = null;
let unsubscribeCheckpointFinalizers: (() => void) | null = null;
let unsubscribeCheckpointChanges: (() => void) | null = null;
let unsubscribeWorkflowIPC: (() => void) | null = null;
let unsubscribeRecoveryIPC: (() => void) | null = null;
let unsubscribeReleaseIPC: (() => void) | null = null;
let unsubscribeDiagnosticsIPC: (() => void) | null = null;
let unsubscribeModelProviderIPC: (() => void) | null = null;
let permissionBroker: PermissionBroker | null = null;
let taskManager: TaskManager | null = null;
let checkpointManager: CheckpointManager | null = null;
let workflowManager: AgentWorkflowManager | null = null;
let workflowInfrastructure: WorkflowInfrastructure | null = null;
let processSupervisor: ProcessSupervisor | null = null;
let crashRecovery: CrashRecoveryManager | null = null;
let structuredLogger: StructuredLogger | null = null;
let shutdownCoordinator: ShutdownCoordinator | null = null;
let disposeTerminals: (() => Promise<void>) | null = null;
let fileMutations: FileMutationManager | null = null;
let rendererEntry: { target: string; url: string } | null = null;
let shutdownFinished = false;
const confirmBypassPermissions = createNativeBypassConfirmation(dialog, () => mainWindow);

const isPrimaryInstance = installSingleInstanceGuard(
  app,
  () => mainWindow,
  { allowMissingApi: process.env.NODE_ENV === 'test' },
);

function sendWorkflowNotification(notification: WorkflowNotification): void {
  void structuredLogger?.info('agent', 'workflow.notification', {
    workflowId: notification.workflowId,
    taskId: notification.taskId,
    projectId: notification.projectId,
    status: notification.status,
    currentStage: notification.currentStage,
    eventType: notification.eventType,
    revision: notification.revision,
  });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.WORKFLOW_CHANGED, notification);
  }
}

function disabledMcpTools(database: AppDatabase, projectId: string): string[] {
  return (database.getProjectSettings(projectId)?.disabled_mcp_servers ?? [])
    .map((name) => name.replace(/[^a-zA-Z0-9_-]/gu, ''))
    .filter(Boolean)
    .map((name) => `mcp__${name}__*`);
}

function preloadPath(): string {
  const development = path.join(__dirname, '../preload/index.js');
  const packaged = path.join(process.resourcesPath, 'dist/preload/index.js');
  if (fs.existsSync(development)) return development;
  if (fs.existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'dist/preload/index.js');
}

function rendererPath(): string {
  if (process.env.VITE_DEV_SERVER_URL) return process.env.VITE_DEV_SERVER_URL;
  return path.join(__dirname, '../renderer/index.html');
}

function stableRendererEntry(): { target: string; url: string } {
  if (!rendererEntry) {
    const target = rendererPath();
    rendererEntry = {
      target,
      url: target.startsWith('http')
        ? new URL(target).toString()
        : pathToFileURL(target).toString(),
    };
  }
  return rendererEntry;
}

function trustedRendererUrl(): string {
  return stableRendererEntry().url;
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开项目',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:command', 'project.open'),
        },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', role: 'zoomIn' },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  installMenu();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Claude Workbench',
    backgroundColor: '#f8f7f4',
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.VITE_DEV_SERVER_URL
      ? url.startsWith(process.env.VITE_DEV_SERVER_URL)
      : url.startsWith('file:');
    if (!allowed) event.preventDefault();
  });

  const target = stableRendererEntry().target;
  if (target.startsWith('http')) void mainWindow.loadURL(target);
  else void mainWindow.loadFile(target);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  if (process.env.WORKBENCH_OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function initializeServices(): Promise<void> {
  const publicIpcMain = createPublicIpcMain(ipcMain);
  const dataRoot = process.env.WORKBENCH_DATA_DIR
    ? path.resolve(process.env.WORKBENCH_DATA_DIR)
    : app.getPath('userData');
  const logsDirectory = path.join(dataRoot, 'logs');
  structuredLogger = new StructuredLogger(logsDirectory);
  db = new AppDatabase(path.join(dataRoot, 'claude-workbench.db'));
  await db.ready();
  if (!db.getSetting('dataPath')) db.setSetting('dataPath', dataRoot);

  const releaseVersion = buildVersionInfo({
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    packaged: app.isPackaged,
  });
  let recoveryReport: RecoveryReport;
  crashRecovery = new CrashRecoveryManager(db, {
    buildId: releaseVersion.buildId,
    logger: structuredLogger,
    validateResume: async (item) => {
      if (!item.project_id || !item.task_id) {
        throw new Error('Recovery item is missing registered project/task identity.');
      }
      const project = db?.getProject(item.project_id);
      const task = db?.getTask(item.task_id);
      if (!project || !task || task.project_id !== project.id || !fs.existsSync(project.path)) {
        throw new Error('Recovery project is unavailable or no longer matches the task.');
      }
      const projectKey = canonicalizeProjectPath(project.path).canonicalPath;
      const busy = taskManager?.getActiveTasks().some((active) => (
        canonicalizeProjectPath(active.projectKey).canonicalPath === projectKey
      ));
      if (busy) throw new Error('The project already has an active task or mutation.');
      if (item.kind === 'workflow') {
        if (!checkpointManager) throw new Error('Checkpoint validation is unavailable.');
        await checkpointManager.createTaskCheckpoint(item.task_id, 'manual', {
          reason: `crash-recovery-validation:${item.id}`,
        });
      }
    },
    resumeWorkflow: async (workflowId) => {
      if (!workflowManager) throw new Error('Workflow recovery is not ready.');
      await workflowManager.resume(workflowId);
    },
  });
  recoveryReport = await crashRecovery.beginAppRun();
  await structuredLogger.info('database', 'database.ready', db.getDiagnosticsSummary());

  const processJournal = new DatabaseProcessJournal(
    db,
    () => crashRecovery?.appRunId ?? null,
    structuredLogger,
  );
  processSupervisor = new ProcessSupervisor({ journal: processJournal });
  for (const previousRunId of recoveryReport.previousRunIds) {
    for (const orphan of db.listManagedProcesses(previousRunId)) {
      if (orphan.state !== 'orphaned_unverified') continue;
      // v1 journals deliberately lack enough OS identity to trust a recycled
      // PID. Keep the item visible for manual diagnosis instead of guessing.
      const outcome = await processSupervisor.terminatePersisted({
        id: orphan.id,
        pid: orphan.pid,
        kind: ['claude', 'mcp', 'terminal'].includes(orphan.kind)
          ? orphan.kind as 'claude' | 'mcp' | 'terminal'
          : 'claude',
        ...(orphan.session_id ? { sessionId: orphan.session_id } : {}),
        ...(orphan.task_id ? { taskId: orphan.task_id } : {}),
        ...(orphan.run_id ? { runId: orphan.run_id } : {}),
        startedAt: orphan.started_at,
      });
      await structuredLogger.warn('app', 'process.orphan_reconciliation', {
        processId: orphan.id,
        pid: orphan.pid,
        outcome: outcome.status,
      });
    }
  }

  permissionBroker = new PermissionBroker({
    projectRuleStore: new DatabasePermissionRuleStore(db),
  });
  await permissionBroker.start();
  const permissionAudit = new PermissionAudit(db, permissionBroker, {
    confirmExplicitHighRisk: confirmBypassPermissions,
  });
  fileMutations = new FileMutationManager({
    recordEvent: (event) => {
      if (event.sessionId && db?.getSession(event.sessionId)) {
        db.createEventIfAbsent(
          `file-mutation:${event.mutationId}:${event.status}`,
          event.sessionId,
          'file_mutation',
          JSON.stringify(event),
          event.completedAt,
        );
      }
      db?.recordMutationOperation({
        id: event.mutationId,
        appRunId: crashRecovery?.appRunId,
        projectId: event.projectId,
        projectPath: event.projectPath,
        sessionId: event.sessionId,
        taskId: event.taskId,
        runId: event.runId,
        kind: event.kind,
        status: event.status,
        filePaths: event.filePaths,
        startedAt: event.startedAt,
        completedAt: event.status === 'started' ? null : event.completedAt,
        error: event.error ?? null,
      });
      void structuredLogger?.info('agent', 'file_mutation.state', {
        mutationId: event.mutationId,
        kind: event.kind,
        status: event.status,
        projectId: event.projectId,
        taskId: event.taskId,
        runId: event.runId,
      });
    },
  });

  const providerRepository = new ModelProviderRepository(db);
  const credentialStore = new CredentialStore(
    path.join(dataRoot, 'model-credentials'),
    safeStorage,
  );
  const providerConnectionTester = new ProviderConnectionTester();
  const providerEnvironmentResolver = new ProviderEnvironmentResolver();
  const providerExecutionEnvironment = new ProviderExecutionEnvironmentService(
    providerRepository,
    credentialStore,
    providerEnvironmentResolver,
  );
  const realAdapter = new ClaudeCliAdapter({
    permissionBroker,
    permissionMcpPath: path.join(__dirname, 'permission-mcp.js'),
    processSupervisor,
    providerEnvironment: providerExecutionEnvironment,
  });
  const baseAdapter: ClaudeAdapter = await selectStartupClaudeAdapter({
    forceFake: process.env.FORCE_FAKE === '1',
    realAdapter,
    createFakeAdapter: () => new FakeClaudeAdapter(),
  });
  const runtimeRegistry = new AgentRuntimeRegistry([
    new ClaudeCodeAgentRuntime(baseAdapter),
  ]);
  const syntheticHmacKey = credentialStore.getOrCreateInternalSecret(
    'model-tier-synthetic-hmac-v1',
    () => randomBytes(32).toString('base64url'),
  );
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(syntheticHmacKey)
    || Buffer.from(syntheticHmacKey, 'base64url').length !== 32
  ) {
    throw new Error('Internal model identity key is unavailable or invalid.');
  }
  const modelTierService = new ModelTierService({
    repository: providerRepository,
    runtimeRegistry,
    syntheticIdentityHmac: {
      digestSha256: (canonicalIdentity) => createHmac(
        'sha256',
        Buffer.from(syntheticHmacKey, 'base64url'),
      ).update(canonicalIdentity).digest('hex'),
    },
    credentialExists: (reference) => credentialStore.exists(reference),
    projectExists: (projectId) => Boolean(db?.getProject(projectId)),
    resolveEffectiveSyntheticSelection: (scope) => {
      if (
        (scope.type === 'project'
          && providerRepository.getProjectModelPolicy(scope.projectId, 'default'))
        || providerRepository.getDefaultProvider()
      ) {
        return null;
      }
      const fallbackModelId = db?.getSetting('defaultModel')?.trim() || 'default';
      const inherited = providerEnvironmentResolver.describeInheritedEnvironment(
        process.env,
        fallbackModelId,
      );
      if (inherited) {
        return {
          kind: 'environment',
          providerName: inherited.providerName,
          modelId: inherited.modelId,
          baseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || null,
          authenticationMode: process.env.ANTHROPIC_API_KEY
            ? 'api_key'
            : 'auth_token',
        };
      }
      return {
        kind: 'claude_code',
        providerName: 'Claude Code',
        modelId: fallbackModelId,
      };
    },
  });
  const modelSelectionResolver = new ModelSelectionResolver({
    store: providerRepository,
    runtimeGate: runtimeRegistry,
    credentialExists: (reference) => credentialStore.exists(reference),
    resolveEnvironmentSelection: (fallbackModelId) => (
      providerEnvironmentResolver.describeInheritedEnvironment(process.env, fallbackModelId)
    ),
    tierResolver: modelTierService,
  });
  const modelProviderService = new ModelProviderService({
    persistence: providerRepository,
    credentialStore,
    connectionTester: providerConnectionTester,
    isProviderInUse: (providerId) => taskManager?.getActiveTasks()
      .some((active) => active.modelProviderId === providerId) ?? false,
    validateAgentDefault: (providerId, modelId) => {
      modelSelectionResolver.assertProviderModelRunnable(providerId, modelId, 'coder');
    },
  });
  await modelProviderService.retryCredentialCleanup();
  const modelRunOptionsResolver = new ModelRunOptionsResolver(modelSelectionResolver, db);
  const agentModelPolicyService = new AgentModelPolicyService({
    store: providerRepository,
    runtimeGate: runtimeRegistry,
    projectExists: (projectId) => Boolean(db?.getProject(projectId)),
  });
  const agentPresetService = new AgentPresetService({
    repository: providerRepository,
    tierService: modelTierService,
  });
  const projectAiConfigurationService = new ProjectAiConfigurationService({
    projectExists: (projectId) => Boolean(db?.getProject(projectId)),
    projectFallbackModelId: (projectId) => (
      db?.getProjectSettings(projectId)?.default_model?.trim()
      || db?.getSetting('defaultModel')?.trim()
      || 'default'
    ),
    tierService: modelTierService,
    presetService: agentPresetService,
    selectionInspector: modelSelectionResolver,
  });
  taskManager = new TaskManager(baseAdapter, {
    fileMutations,
    dangerousRunAuthorizer: permissionAudit,
    prepareRun: (options) => modelRunOptionsResolver.revalidateResolved(options),
  });
  claudeAdapter = taskManager;
  checkpointManager = new CheckpointManager(db, path.join(dataRoot, 'checkpoints'), {
    mutations: fileMutations,
  });
  const checkpointLifecycle = new CheckpointLifecycleCoordinator(checkpointManager);
  workflowInfrastructure = new WorkflowInfrastructure(db, checkpointManager, undefined, {
    notification: sendWorkflowNotification,
  });
  const workflowRunner = new TaskManagerAgentStageRunner(taskManager, {
    resolveDisallowedTools: (request) => disabledMcpTools(db as AppDatabase, request.projectId),
    resolveRunOptions: (options) => modelRunOptionsResolver.resolve(options),
    resolvePinnedRunOptions: (options, selection) => (
      modelRunOptionsResolver.resolvePinned(options, selection)
    ),
  });
  workflowManager = new AgentWorkflowManager({
    ...workflowInfrastructure.dependencies(workflowRunner),
    modelSelections: modelSelectionResolver,
    permissionLifecycle: permissionBroker,
  });

  const historyAdapter = new ClaudeLocalSessionAdapter();
  unsubscribeCheckpointStarts = taskManager.subscribeBeforeRuns(async (options) => {
      try {
        await checkpointLifecycle.beforeRun(options);
      } catch (error) {
        if (error instanceof GitWorkspaceError && error.code === 'NOT_A_REPOSITORY') return;
        throw error;
      }
  });
  unsubscribeClaudeEvents = registerClaudeIPC(publicIpcMain, claudeAdapter, {
    database: db,
    resolveDisallowedTools: (projectId) => disabledMcpTools(db as AppDatabase, projectId),
    resolveRunOptions: (options) => modelRunOptionsResolver.resolve(options),
  });
  unsubscribePermissionRequests = registerPermissionIPC(publicIpcMain, permissionBroker, db);
  const taskRecorder = new TaskEventRecorder(db);
  unsubscribeTaskStarts = taskManager.subscribeStarts((options) => {
    taskRecorder.recordStart(options);
  });
  unsubscribeTaskEvents = claudeAdapter.subscribe((envelope) => {
    taskRecorder.recordEvent(envelope);
  });
  unsubscribeCheckpointEvents = claudeAdapter.subscribe((envelope) => {
    checkpointLifecycle.handleEvent(envelope);
  });
  unsubscribeCheckpointFinalizers = taskManager.subscribeTerminalFinalizers(async (envelope) => {
    if (!permissionBroker) return checkpointLifecycle.waitForIdle(envelope.runId);
    await finalizeStandalonePermissions(
      envelope,
      () => checkpointLifecycle.waitForIdle(envelope.runId),
      permissionBroker,
    );
  });
  unsubscribeTaskPermissions = permissionBroker.subscribeSettlements((settlement) => {
    if (settlement.cause === 'permission_auto_allowed') {
      try {
        permissionAudit.recordAutoAllowed(settlement);
      } catch (error) {
        void structuredLogger?.error('permission', 'permission.auto_allow_audit_failed', {
          requestId: settlement.requestId,
          runId: settlement.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    taskRecorder.recordPermission(settlement);
    db?.settlePermissionRequest(
      settlement.requestId,
      settlement.behavior === 'allow' ? 'allowed' : 'denied',
      new Date(settlement.settledAt).toISOString(),
    );
    void structuredLogger?.info('permission', 'permission.settled', {
      requestId: settlement.requestId,
      runId: settlement.runId,
      toolName: settlement.toolName,
      behavior: settlement.behavior,
      cause: settlement.cause,
      settledAt: settlement.settledAt,
    });
  });
  const unsubscribePermissionJournal = permissionBroker.subscribe((request) => {
    const separator = request.sessionKey.lastIndexOf('::');
    const sessionId = separator >= 0 ? request.sessionKey.slice(separator + 2) : null;
    const task = sessionId ? db?.getTask(sessionId) : null;
    db?.recordPendingPermissionRequest({
      id: request.requestId,
      appRunId: crashRecovery?.appRunId,
      projectId: task?.project_id,
      sessionId,
      taskId: task?.id,
      runId: request.runId,
      toolName: request.toolName,
      requestedAt: new Date(request.createdAt).toISOString(),
    });
    void structuredLogger?.info('permission', 'permission.requested', {
      requestId: request.requestId,
      runId: request.runId,
      projectId: task?.project_id,
      sessionId,
      taskId: task?.id,
      toolName: request.toolName,
      risk: request.risk,
      kind: request.kind,
    });
  });
  const firstRunService = new FirstRunService({
    dataRoot,
    database: db,
    fileMutations,
  });
  const trustedRenderer = {
    getTrustedWebContents: () => mainWindow?.webContents ?? null,
    getTrustedFrameUrl: trustedRendererUrl,
  };
  registerProjectIPC(publicIpcMain, db, { firstRunService, ...trustedRenderer });
  registerSessionIPC(publicIpcMain, db, historyAdapter, {
    validateExecutableModel: async ({ projectId, fallbackModelId }) => {
      await modelSelectionResolver.resolve({ projectId, fallbackModelId, use: 'chat' });
    },
  });
  disposeTerminals = registerTerminalIPC(publicIpcMain, {
    supervisor: processSupervisor,
    resolveProjectPath: (requestedPath) => {
      const canonical = canonicalizeProjectPath(requestedPath).canonicalPath;
      const registered = db?.listProjects().find((project) => (
        canonicalizeProjectPath(project.path).canonicalPath === canonical
      ));
      if (!registered) throw new Error('Terminal project is not registered in Workbench.');
      return registered.path;
    },
    environment: process.env,
  });
  registerSettingsIPC(publicIpcMain, db, trustedRenderer);
  unsubscribeModelProviderIPC = registerModelProviderIPC(publicIpcMain, {
    service: modelProviderService,
    policyService: agentModelPolicyService,
    selectionService: modelSelectionResolver,
    tierService: modelTierService,
    presetService: agentPresetService,
    projectAiConfigurationService,
    getTaskContext: (taskId) => {
      const task = db?.getTask(taskId);
      if (!task) return null;
      const session = db?.getSession(task.session_id);
      const active = taskManager?.getActiveTasks().some((item) => item.taskId === task.id) ?? false;
      const workflowActive = workflowInfrastructure?.isWorkflowActive(task.id) ?? false;
      return {
        projectId: task.project_id,
        status: active || workflowActive ? 'running' : task.status,
        fallbackModelId: session?.model ?? null,
      };
    },
    isTaskActive: (taskId) => taskManager?.getActiveTasks()
      .some((active) => active.taskId === taskId) ?? false,
    getTrustedWebContents: () => mainWindow?.webContents ?? null,
    getTrustedFrameUrl: trustedRendererUrl,
  });
  registerSystemIPC(publicIpcMain, {
    allowedPaths: () => [
      dataRoot,
      ...(db?.listProjects().map((project) => project.path) ?? []),
    ],
  });
  registerFileChangesIPC(publicIpcMain, { database: db, tasks: taskManager });
  registerHistoryIPC(publicIpcMain, historyAdapter);
  registerTaskIPC(publicIpcMain, db, taskManager);
  unsubscribeWorkflowIPC = registerWorkflowIPC(publicIpcMain, {
    database: db,
    manager: workflowManager,
    infrastructure: workflowInfrastructure,
  });
  registerIntegrationsIPC(publicIpcMain, db);
  unsubscribeCheckpointChanges = registerGitWorkspaceIPC(
    publicIpcMain,
    db,
    checkpointManager,
    {
      tasks: taskManager,
      send: (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('checkpoint:changed', event);
        }
      },
    },
  );

  const updateManager = new UpdateManager(autoUpdater as unknown as UpdateClient, {
    isPackaged: app.isPackaged,
    sourceConfigured: detectPackagedUpdateSource(path.join(process.resourcesPath, 'app-update.yml')),
  });
  unsubscribeReleaseIPC = registerReleaseIPC(publicIpcMain, {
    getVersionInfo: () => releaseVersion,
    updates: updateManager,
  });
  unsubscribeRecoveryIPC = registerRecoveryIPC(publicIpcMain, {
    manager: crashRecovery,
    abnormalExitDetected: recoveryReport.abnormalExitDetected,
    openLogs: async () => {
      const error = await shell.openPath(logsDirectory);
      if (error) throw new Error('Unable to open the logs directory.');
    },
  });
  const diagnosticsExporter = new DiagnosticsExporter(logsDirectory);
  unsubscribeDiagnosticsIPC = registerDiagnosticsExportIPC(publicIpcMain, {
    exporter: diagnosticsExporter,
    chooseDestination: async (defaultName) => {
      const options: Electron.SaveDialogOptions = {
        title: 'Export Claude Workbench diagnostics',
        defaultPath: path.join(app.getPath('documents'), defaultName),
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
      };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      return result.canceled ? null : result.filePath ?? null;
    },
    version: () => ({ ...releaseVersion }),
    system: () => ({
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
    }),
    database: () => db!.getDiagnosticsSummary(),
    anonymousPerformance: () => db!.getAnonymousPerformanceSource(),
    ...trustedRenderer,
  });

  shutdownCoordinator = new ShutdownCoordinator({
    stopAcceptingWork: () => {
      for (const channel of Object.values(IPC_CHANNELS)) ipcMain.removeHandler(channel);
      unsubscribeClaudeEvents?.();
      unsubscribeClaudeEvents = null;
      unsubscribePermissionRequests?.();
      unsubscribePermissionRequests = null;
      unsubscribeWorkflowIPC?.();
      unsubscribeWorkflowIPC = null;
      unsubscribeCheckpointChanges?.();
      unsubscribeCheckpointChanges = null;
      unsubscribeRecoveryIPC?.();
      unsubscribeRecoveryIPC = null;
      unsubscribeReleaseIPC?.();
      unsubscribeReleaseIPC = null;
      unsubscribeDiagnosticsIPC?.();
      unsubscribeDiagnosticsIPC = null;
      unsubscribeModelProviderIPC?.();
      unsubscribeModelProviderIPC = null;
    },
    closePermissions: async () => permissionBroker?.close(),
    stopTasks: async () => {
      await taskManager?.stopAll();
      unsubscribeTaskEvents?.();
      unsubscribeTaskEvents = null;
      unsubscribeTaskPermissions?.();
      unsubscribeTaskPermissions = null;
      unsubscribePermissionJournal();
      unsubscribeTaskStarts?.();
      unsubscribeTaskStarts = null;
      unsubscribeCheckpointStarts?.();
      unsubscribeCheckpointStarts = null;
      unsubscribeCheckpointEvents?.();
      unsubscribeCheckpointEvents = null;
      unsubscribeCheckpointFinalizers?.();
      unsubscribeCheckpointFinalizers = null;
      taskManager?.dispose();
    },
    stopTerminals: async () => disposeTerminals?.(),
    stopProcesses: async () => { await processSupervisor?.terminateAll(); },
    waitForMutations: async () => fileMutations?.waitForIdle(),
    markCleanShutdown: async () => crashRecovery?.markCleanShutdown(),
    closeDatabase: () => db?.close(),
  }, { stepTimeoutMs: 15_000 });

  await structuredLogger.info('app', 'application.services_ready', {
    version: releaseVersion.version,
    buildId: releaseVersion.buildId,
    packaged: releaseVersion.packaged,
    recoveryItemCount: recoveryReport.items.length,
  });
  if (db.getSetting('autoCheckUpdates') === 'true') {
    void updateManager.checkForUpdates().then((state) => (
      structuredLogger?.info('app', 'update.auto_check', state)
    ));
  }
}

if (isPrimaryInstance) {
  app.whenReady().then(async () => {
    try {
      await initializeServices();
      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    } catch (error) {
      await structuredLogger?.error('error', 'application.initialization_failed', { error });
      await structuredLogger?.close();
      dialog.showErrorBox(
        'Claude Workbench failed to start',
        error instanceof Error ? error.message : 'Unknown startup error.',
      );
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let shutdownStarted = false;
  app.on('before-quit', (event) => {
    if (shutdownFinished || !shutdownCoordinator) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    crashRecovery?.beginShutdown();
    void shutdownCoordinator.shutdown('user').then(async (result) => {
      await structuredLogger?.info('app', 'application.shutdown', result);
      await structuredLogger?.close();
      shutdownFinished = true;
      app.quit();
    }).catch(async (error) => {
      await structuredLogger?.error('error', 'application.shutdown_failed', { error });
      await structuredLogger?.close();
      shutdownFinished = true;
      app.exit(1);
    });
  });
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function getDatabase(): AppDatabase | null {
  return db;
}

export function getClaudeAdapter(): ClaudeAdapter | null {
  return claudeAdapter;
}
