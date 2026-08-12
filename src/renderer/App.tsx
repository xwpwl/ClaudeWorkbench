import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClaudeEventEnvelope } from '../shared/types/claude';
import type { PersistedTaskSnapshot } from '../shared/types/workbench';
import type { Project } from '../shared/types/project';
import type { CommitPreview } from '../shared/types/git';
import type { PermissionRequest } from '../shared/types/permissionBroker';
import type { SessionStatus, SessionSummary } from '../shared/types/session';
import type { RecoveryCenterSnapshot, RecoveryItem } from '../shared/types/recovery';
import type {
  ExecutionPlan,
  Workflow,
  WorkflowChangedEvent,
  WorkflowStatus,
} from '../shared/types/workflow';
import { hydratePersistedTasks } from '../shared/taskPersistence';
import { canonicalProjectKey } from '../shared/sessionIdentity';
import { setLocale, t } from './i18n';
import { TopToolbar } from './components/TopToolbar';
import { ChatTimeline } from './features/chat/ChatTimeline';
import { InputBar } from './features/chat/InputBar';
import { useModelProviderToolbar } from './features/models/useModelProviderToolbar';
import type { GitActionRequest } from './features/git/WorkspaceRightDrawer';
import { PermissionDialog } from './features/permissions/PermissionDialog';
import { ProjectSidebar } from './features/projects/ProjectSidebar';
import { EnvironmentCheck } from './features/settings/EnvironmentCheck';
import { SettingsDialog, type SettingsCategory } from './features/settings/SettingsDialog';
import { TerminalPanel } from './features/terminal/TerminalPanel';
import { IntegrationsDialog } from './features/integrations/IntegrationsDialog';
import { ProjectSettingsDialog } from './features/projects/ProjectSettingsDialog';
import { CommandPalette } from './features/commands/CommandPalette';
import { CommandRegistry } from './commands/CommandRegistry';
import { useWorkspaceController } from './hooks/useWorkspaceController';
import { useAppStore } from './stores/appStore';
import { useWorkspaceStore, type SessionRuntime } from './stores/workspaceStore';
import {
  FirstRunWizard,
  startFirstRunPlanner,
} from './features/first-run/FirstRunWizard';
import {
  loadFirstRunGate,
  shouldShowLegacyEnvironmentCheck,
  type FirstRunGate,
} from './firstRunGate';
import type { FirstRunResumeStep } from '../shared/types/ipc';

const WorkspaceRightDrawer = React.lazy(async () => {
  const module = await import('./features/git/WorkspaceRightDrawer');
  return { default: module.WorkspaceRightDrawer };
});

const WorkflowPanel = React.lazy(async () => {
  const module = await import('./features/workflow/WorkflowPanel');
  return { default: module.WorkflowPanel };
});

const RecoveryCenter = React.lazy(async () => {
  const module = await import('./features/recovery/RecoveryCenter');
  return { default: module.RecoveryCenter };
});

export interface WorkflowTaskIdentity {
  taskId: string | null;
  projectId: string | null;
}

export function matchesWorkflowChangedEvent(
  event: WorkflowChangedEvent,
  identity: WorkflowTaskIdentity,
): boolean {
  return Boolean(
    identity.taskId
    && identity.projectId
    && event.taskId === identity.taskId
    && event.projectId === identity.projectId,
  );
}

export function matchesWorkflowRecord(
  workflow: Workflow | null,
  identity: WorkflowTaskIdentity,
): workflow is Workflow {
  return Boolean(
    workflow
    && identity.taskId
    && identity.projectId
    && workflow.taskId === identity.taskId
    && workflow.projectId === identity.projectId,
  );
}

export interface FirstRunPendingWorkflowIdentity {
  taskId: string;
  projectId: string;
  projectPath: string;
  selectionIncarnation: number;
}

export interface FirstRunWorkflowIsolationToken extends FirstRunPendingWorkflowIdentity {
  token: number;
}

export interface FirstRunWorkflowIsolationContext {
  firstRunActive: boolean;
  activeIdentity: FirstRunPendingWorkflowIdentity | null;
}

interface FirstRunWorkflowIsolationState {
  phase: 'pending' | 'rejected';
  token: FirstRunWorkflowIsolationToken;
}

/** Keeps App-wide Workflow notifications from adopting an unvalidated first-run plan. */
export class FirstRunWorkflowIsolation {
  private sequence = 0;

  private state: FirstRunWorkflowIsolationState | null = null;

  begin(identity: FirstRunPendingWorkflowIdentity): FirstRunWorkflowIsolationToken {
    const token = { ...identity, token: ++this.sequence };
    this.state = { phase: 'pending', token };
    return token;
  }

  blocks(identity: WorkflowTaskIdentity): boolean {
    return Boolean(
      this.state
      && identity.taskId === this.state.token.taskId
      && identity.projectId === this.state.token.projectId,
    );
  }

  commit(token: FirstRunWorkflowIsolationToken, adopt: () => boolean): boolean {
    if (this.state?.phase !== 'pending' || this.state.token.token !== token.token) return false;
    if (!adopt()) return false;
    this.state = null;
    return true;
  }

  reject(token: FirstRunWorkflowIsolationToken): void {
    if (this.state?.phase === 'pending' && this.state.token.token === token.token) {
      this.state = { phase: 'rejected', token: this.state.token };
    }
  }

  releaseRejected(context: FirstRunWorkflowIsolationContext): boolean {
    if (this.state?.phase !== 'rejected') return false;
    const rejected = this.state.token;
    const active = context.activeIdentity;
    const sameIdentity = Boolean(
      active
      && active.taskId === rejected.taskId
      && active.projectId === rejected.projectId
      && active.selectionIncarnation === rejected.selectionIncarnation
      && canonicalProjectKey(active.projectPath) === canonicalProjectKey(rejected.projectPath),
    );
    if (context.firstRunActive && sameIdentity) return false;
    this.state = null;
    return true;
  }
}

export async function runIsolatedFirstRunWorkflow<T>(
  isolation: FirstRunWorkflowIsolation,
  identity: FirstRunPendingWorkflowIdentity,
  run: () => Promise<T>,
  adopt: (value: T) => boolean,
  onBegin: () => void,
  onRejected?: () => void,
): Promise<T> {
  const token = isolation.begin(identity);
  try {
    onBegin();
    const result = await run();
    if (!isolation.commit(token, () => adopt(result))) {
      throw new Error('FIRST_RUN_WORKFLOW_IDENTITY');
    }
    return result;
  } catch (error) {
    isolation.reject(token);
    onRejected?.();
    throw error;
  }
}

export interface FirstRunProjectSelectionSnapshot {
  currentProject: Project | null;
  currentSessionKey: string | null;
  currentRuntime: SessionRuntime | null;
  projectRequestId: string | null;
  selectionIncarnation: number;
  projectLoading: boolean;
  projectError: string | null;
}

export interface FirstRunProjectSelectionDependencies {
  getSnapshot(): FirstRunProjectSelectionSnapshot;
  selectProject(project: Project): Promise<void>;
  waitForSettled(project: Project, selectionIncarnation: number): Promise<void>;
}

function isSelectedFirstRunProject(
  snapshot: FirstRunProjectSelectionSnapshot,
  project: Project,
): boolean {
  return snapshot.currentProject?.id === project.id
    && canonicalProjectKey(snapshot.currentProject.path) === canonicalProjectKey(project.path);
}

export type FirstRunTaskSelection = 'reusable' | 'needs_new_task';
type FirstRunSelectionState = 'pending' | 'unsafe' | FirstRunTaskSelection;

function inspectFirstRunProjectSelection(
  snapshot: FirstRunProjectSelectionSnapshot,
  project: Project,
  expectedIncarnation: number,
  allowTransitionalMissingSession = false,
): FirstRunSelectionState {
  if (
    !isSelectedFirstRunProject(snapshot, project)
    || !snapshot.projectRequestId
    || snapshot.selectionIncarnation !== expectedIncarnation
    || snapshot.projectError
  ) return 'unsafe';
  if (snapshot.projectLoading) return 'pending';
  if (!snapshot.currentSessionKey || !snapshot.currentRuntime) {
    return allowTransitionalMissingSession ? 'pending' : 'unsafe';
  }

  const runtime = snapshot.currentRuntime;
  if (
    runtime.key !== snapshot.currentSessionKey
    || runtime.summary.projectId !== project.id
    || canonicalProjectKey(runtime.projectPath) !== canonicalProjectKey(project.path)
    || !runtime.summary.projectPath
    || canonicalProjectKey(runtime.summary.projectPath) !== canonicalProjectKey(project.path)
    || runtime.error
  ) return 'unsafe';
  if (
    !runtime.hydrated
    || runtime.loadRequestId !== null
    || runtime.summary.status === 'loading_history'
  ) return 'pending';
  if (runtime.summary.status === 'running' || runtime.summary.status === 'waiting_permission') {
    return 'unsafe';
  }
  if (runtime.summary.source === 'claude-code') return 'needs_new_task';
  if (runtime.summary.status === 'idle' && !runtime.summary.error) return 'reusable';
  return ['idle', 'completed', 'cancelled', 'failed'].includes(runtime.summary.status)
    ? 'needs_new_task'
    : 'unsafe';
}

export async function runAfterSettledFirstRunProject<T>(
  project: Project,
  dependencies: FirstRunProjectSelectionDependencies,
  action: (selection: FirstRunTaskSelection) => Promise<T>,
): Promise<T> {
  let snapshot = dependencies.getSnapshot();
  if (!isSelectedFirstRunProject(snapshot, project)) {
    await dependencies.selectProject(project);
    snapshot = dependencies.getSnapshot();
  }
  const selectionIncarnation = snapshot.selectionIncarnation;
  let selectionState = inspectFirstRunProjectSelection(
    snapshot,
    project,
    selectionIncarnation,
  );
  if (selectionState === 'pending') {
    await dependencies.waitForSettled(project, selectionIncarnation);
    snapshot = dependencies.getSnapshot();
    selectionState = inspectFirstRunProjectSelection(
      snapshot,
      project,
      selectionIncarnation,
    );
  }
  if (selectionState !== 'reusable' && selectionState !== 'needs_new_task') {
    throw new Error('FIRST_RUN_PROJECT_SELECTION');
  }
  return action(selectionState);
}

export interface FirstRunPlannerTaskDependencies {
  getSnapshot(): FirstRunProjectSelectionSnapshot;
  createTask(project: Project): Promise<SessionSummary | null>;
  workflowAlreadyExists(taskId: string, projectId: string): boolean;
}

export interface PreparedFirstRunPlannerTask {
  sessionKey: string;
  runtime: SessionRuntime;
  selectionIncarnation: number;
}

export async function prepareFirstRunPlannerTask(
  project: Project,
  selection: FirstRunTaskSelection,
  dependencies: FirstRunPlannerTaskDependencies,
): Promise<PreparedFirstRunPlannerTask> {
  const initial = dependencies.getSnapshot();
  if (inspectFirstRunProjectSelection(
    initial,
    project,
    initial.selectionIncarnation,
  ) !== selection || !initial.currentSessionKey || !initial.currentRuntime) {
    throw new Error('FIRST_RUN_PROJECT_SELECTION');
  }

  const initialSessionKey = initial.currentSessionKey;
  const initialTaskId = initial.currentRuntime.summary.id;
  const initialProjectRequestId = initial.projectRequestId;
  const workflowExists = initial.currentRuntime.summary.source === 'workbench'
    && dependencies.workflowAlreadyExists(initialTaskId, project.id);
  const freshTask = selection === 'reusable'
    && initial.currentRuntime.summary.source === 'workbench'
    && initial.currentRuntime.summary.status === 'idle'
    && initial.currentRuntime.summary.messageCount === 0
    && initial.currentRuntime.messages.length === 0
    && initial.currentRuntime.summary.titleSource === 'default'
    && !workflowExists;

  let createdTaskId: string | null = null;
  if (!freshTask) {
    const created = await dependencies.createTask(project);
    if (!created) throw new Error('FIRST_RUN_TASK_UNAVAILABLE');
    createdTaskId = created.id;
  }

  const selected = dependencies.getSnapshot();
  const selectedState = inspectFirstRunProjectSelection(
    selected,
    project,
    selected.selectionIncarnation,
  );
  if (
    selectedState !== 'reusable'
    || !selected.currentSessionKey
    || !selected.currentRuntime
    || selected.projectRequestId !== initialProjectRequestId
    || (createdTaskId
      ? selected.selectionIncarnation <= initial.selectionIncarnation
        || selected.currentRuntime.summary.id !== createdTaskId
      : selected.selectionIncarnation !== initial.selectionIncarnation
        || selected.currentSessionKey !== initialSessionKey
        || selected.currentRuntime.summary.id !== initialTaskId)
  ) {
    throw new Error('FIRST_RUN_TASK_IDENTITY');
  }

  return {
    sessionKey: selected.currentSessionKey,
    runtime: selected.currentRuntime,
    selectionIncarnation: selected.selectionIncarnation,
  };
}

function waitForFirstRunProjectSelection(
  project: Project,
  selectionIncarnation: number,
  getSnapshot: () => FirstRunProjectSelectionSnapshot,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const inspect = () => {
      const state = inspectFirstRunProjectSelection(
        getSnapshot(),
        project,
        selectionIncarnation,
        true,
      );
      if (state === 'unsafe') {
        unsubscribe();
        reject(new Error('FIRST_RUN_PROJECT_SELECTION'));
      } else if (state === 'reusable' || state === 'needs_new_task') {
        unsubscribe();
        resolve();
      }
    };
    unsubscribe = useWorkspaceStore.subscribe(inspect);
    inspect();
  });
}

export function isWorkflowAgentRunId(runId: string, workflowId: string | null): boolean {
  return Boolean(workflowId && workflowIdFromAgentRunId(runId) === workflowId);
}

/** Extracts a workflow id from the main-process stage run descriptor. */
export function workflowIdFromAgentRunId(runId: string): string | null {
  const match = /^([^:]+):\d+:(planner|coder|tester|reviewer):\d+:[^:]+$/.exec(runId);
  return match?.[1] ?? null;
}

export function enqueueWorkflowPermissionRequest(
  requests: readonly PermissionRequest[],
  request: PermissionRequest,
): PermissionRequest[] {
  return requests.some((candidate) => candidate.requestId === request.requestId)
    ? [...requests]
    : [...requests, request];
}

export function removeWorkflowPermissionRequest(
  requests: readonly PermissionRequest[],
  requestId: string,
): PermissionRequest[] {
  return requests.filter((request) => request.requestId !== requestId);
}

function permissionPathInsideProject(projectPath: string, candidatePath: string): boolean {
  const root = canonicalProjectKey(projectPath);
  const candidate = canonicalProjectKey(candidatePath);
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function findPermissionSwitchTarget(
  request: Pick<
    PermissionRequest,
    'outsideProject' | 'projectPath' | 'canonicalProjectPath' | 'effectiveCwd' | 'targetPaths'
  >,
  projects: readonly Project[],
): Project | null {
  if (!request.outsideProject) return null;
  const currentRoot = canonicalProjectKey(request.canonicalProjectPath || request.projectPath);
  const candidates = [
    ...(request.targetPaths ?? []),
    request.effectiveCwd,
  ].filter((candidate): candidate is string => Boolean(candidate)).filter((candidate) => (
    canonicalProjectKey(candidate) !== currentRoot
    && !canonicalProjectKey(candidate).startsWith(`${currentRoot}/`)
  ));
  const matches = new Map<string, Project>();
  for (const candidate of candidates) {
    const project = [...projects]
      .sort((left, right) => right.path.length - left.path.length)
      .find((item) => permissionPathInsideProject(item.path, candidate));
    if (project && canonicalProjectKey(project.path) !== currentRoot) matches.set(project.id, project);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

export interface WorkflowPermissionStopApi {
  cancelWorkflow: (workflowId: string) => Promise<Workflow>;
  stopRun: (runId: string) => Promise<boolean>;
}

/** Starts the cancel intent first, stops the permission-blocked child, then awaits persistence. */
export async function cancelWorkflowPermissionRun(
  api: WorkflowPermissionStopApi,
  workflowId: string,
  runId: string,
): Promise<Workflow> {
  const cancellation = api.cancelWorkflow(workflowId).then(
    (workflow) => ({ workflow, error: null as unknown }),
    (error: unknown) => ({ workflow: null, error }),
  );
  let stopError: unknown = null;
  try {
    await api.stopRun(runId);
  } catch (error) {
    stopError = error;
  }
  const result = await cancellation;
  if (result.error) throw result.error;
  if (stopError) throw stopError;
  return result.workflow as Workflow;
}

export function canCreateWorkflowCommitPreview(status: WorkflowStatus): boolean {
  return status === 'completed';
}

export function sessionStatusForWorkflow(status: WorkflowStatus): SessionStatus {
  if (['planning', 'executing', 'testing', 'reviewing'].includes(status)) return 'running';
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
  return 'idle';
}

export async function abortableWorkflowRequest<T>(
  signal: AbortSignal,
  request: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new DOMException('Workflow request aborted', 'AbortError');
  const result = await request();
  if (signal.aborted) throw new DOMException('Workflow request aborted', 'AbortError');
  return result;
}

interface WorkflowControlsProps {
  workflow: Workflow;
  preview: CommitPreview | null;
  previewLoading: boolean;
  pendingAction: 'pause' | 'resume' | 'cancel' | null;
  error: string | null;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onCreatePreview: () => void;
}

const PAUSABLE_WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  'planning',
  'executing',
  'testing',
  'reviewing',
]);
const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatus>(['completed', 'failed', 'cancelled']);

export const WorkflowControls = React.memo(function WorkflowControls({
  workflow,
  preview,
  previewLoading,
  pendingAction,
  error,
  onPause,
  onResume,
  onCancel,
  onCreatePreview,
}: WorkflowControlsProps) {
  const terminal = TERMINAL_WORKFLOW_STATUSES.has(workflow.status);
  return (
    <section className="flex flex-wrap items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-card)' }} data-testid="workflow-controls">
      <span className="text-xs font-semibold">Workflow</span>
      <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ color: 'var(--accent)', background: 'var(--accent-light)' }}>{workflow.status}</span>
      {PAUSABLE_WORKFLOW_STATUSES.has(workflow.status) ? (
        <button type="button" onClick={onPause} disabled={pendingAction !== null} className="rounded px-2 py-1 text-[10px] disabled:opacity-40" style={{ background: 'var(--bg-hover)' }} data-testid="workflow-pause">{pendingAction === 'pause' ? '暂停中…' : '暂停'}</button>
      ) : null}
      {workflow.status === 'paused' ? (
        <button type="button" onClick={onResume} disabled={pendingAction !== null} className="rounded px-2 py-1 text-[10px] disabled:opacity-40" style={{ background: 'var(--accent-light)', color: 'var(--accent)' }} data-testid="workflow-resume">{pendingAction === 'resume' ? '继续中…' : '继续'}</button>
      ) : null}
      {!terminal ? (
        <button type="button" onClick={onCancel} disabled={pendingAction !== null} className="rounded px-2 py-1 text-[10px] disabled:opacity-40" style={{ background: 'var(--error-bg)', color: 'var(--error)' }} data-testid="workflow-cancel-control">{pendingAction === 'cancel' ? '取消中…' : '取消'}</button>
      ) : null}
      {canCreateWorkflowCommitPreview(workflow.status) ? (
        <button type="button" onClick={onCreatePreview} disabled={previewLoading} className="rounded px-2 py-1 text-[10px] disabled:opacity-40" style={{ background: 'var(--bg-hover)' }} data-testid="workflow-create-commit-preview">{previewLoading ? '生成中…' : '生成 Commit Preview'}</button>
      ) : null}
      {preview ? (
        <div className="min-w-0 flex-1 text-[10px]" data-testid="workflow-commit-preview">
          <code className="selectable block truncate" title={preview.subject}>{preview.subject}</code>
          <details className="mt-1" data-testid="workflow-commit-preview-details">
            <summary className="cursor-pointer select-none">Commit preview details</summary>
            <pre className="selectable mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded p-2" style={{ background: 'var(--bg-secondary)' }}>{preview.message}</pre>
          </details>
          <span className="block" style={{ color: 'var(--warning)' }}>Preview only — no commit will be created automatically.</span>
          <span style={{ color: 'var(--text-tertiary)' }}>{preview.fileCount} files · +{preview.additions} / -{preview.deletions} · 仅预览，未创建 Commit</span>
        </div>
      ) : null}
      {error ? <span className="w-full text-[10px]" style={{ color: 'var(--error)' }} data-testid="workflow-control-error">{error}</span> : null}
    </section>
  );
});

export default function App() {
  const [terminalHeight, setTerminalHeight] = useState(250);
  const [isDraggingTerminal, setIsDraggingTerminal] = useState(false);
  const [integrationsProject, setIntegrationsProject] = useState<Project | null>(null);
  const [integrationsInitialTab, setIntegrationsInitialTab] = useState<'mcp' | 'skills'>('mcp');
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [settingsInitialCategory, setSettingsInitialCategory] = useState<SettingsCategory>('general');
  const [firstRunGate, setFirstRunGate] = useState<FirstRunGate>('booting');
  const [firstRunResumeStep, setFirstRunResumeStep] = useState<FirstRunResumeStep>('welcome');
  const [firstRunProjectIncarnation, setFirstRunProjectIncarnation] = useState(0);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [taskSnapshot, setTaskSnapshot] = useState<PersistedTaskSnapshot | null>(null);
  const [checkpointRevision, setCheckpointRevision] = useState(0);
  const [gitActionRequest, setGitActionRequest] = useState<GitActionRequest | null>(null);
  const [currentWorkflow, setCurrentWorkflow] = useState<Workflow | null>(null);
  const [workflowLookupPending, setWorkflowLookupPending] = useState(false);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const [workflowControlPending, setWorkflowControlPending] = useState<'pause' | 'resume' | 'cancel' | null>(null);
  const [workflowControlError, setWorkflowControlError] = useState<string | null>(null);
  const [workflowCommitPreview, setWorkflowCommitPreview] = useState<CommitPreview | null>(null);
  const [workflowPreviewLoading, setWorkflowPreviewLoading] = useState(false);
  const [workflowPermissionRequests, setWorkflowPermissionRequests] = useState<PermissionRequest[]>([]);
  const [recoveryCenter, setRecoveryCenter] = useState<RecoveryCenterSnapshot | null>(null);
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  const commandRegistry = useMemo(() => new CommandRegistry(undefined, {
    onError: (error, commandId) => console.error(`Command ${commandId} failed:`, error),
  }), []);
  const firstRunWizardApi = useMemo(() => ({
    checkEnvironment: () => window.api.checkEnvironment(),
    listModelProviders: () => window.api.listModelProviders(),
    onModelProviderChanged: (listener: () => void) => window.api.onModelProviderChanged(() => listener()),
    createFirstRunTestProject: () => window.api.createFirstRunTestProject(),
    setFirstRunResumeStep: async (step: FirstRunResumeStep) => {
      await window.api.setFirstRunResumeStep(step);
      setFirstRunResumeStep(step);
    },
    setFirstRunCompletedVersion: (version: 1) => window.api.setFirstRunCompletedVersion(version),
  }), []);
  const dragStartRef = useRef({ y: 0, size: 0 });
  const initializedRef = useRef(false);
  const gitActionIdRef = useRef(0);
  const workflowLookupGenerationRef = useRef(0);
  const workflowMutationGenerationRef = useRef(0);
  const workflowPreviewGenerationRef = useRef(0);
  const currentWorkflowRef = useRef<Workflow | null>(null);
  const firstRunGateRef = useRef(firstRunGate);
  const firstRunWorkflowIsolationRef = useRef(new FirstRunWorkflowIsolation());
  const firstRunSelectionRef = useRef({
    signature: '',
    loadRequestId: null as string | null,
    incarnation: 0,
  });
  firstRunGateRef.current = firstRunGate;
  const {
    theme,
    locale,
    showSidebar,
    showTerminal,
    showFileDrawer,
    showSettings,
    showEnvCheck,
    setShowSettings,
    setShowEnvCheck,
    setClaudeInstalled,
  } = useAppStore();
  const currentProject = useWorkspaceStore((state) => state.currentProject);
  const projects = useWorkspaceStore((state) => state.projects);
  const currentSessionKey = useWorkspaceStore((state) => state.currentSessionKey);
  const currentRuntime = useWorkspaceStore((state) =>
    state.currentSessionKey ? state.runtimes[state.currentSessionKey] : undefined,
  );
  const currentTaskProjectId = currentProject
    && currentRuntime?.summary.source === 'workbench'
    && currentRuntime.summary.projectId === currentProject.id
    ? currentProject.id
    : null;
  const currentTaskId = currentTaskProjectId ? currentRuntime?.summary.id ?? null : null;
  const modelProviderToolbar = useModelProviderToolbar(currentTaskId);
  const currentWorkflowIdentity: WorkflowTaskIdentity = {
    taskId: currentTaskId,
    projectId: currentTaskProjectId,
  };
  const visibleWorkflow = matchesWorkflowRecord(currentWorkflow, currentWorkflowIdentity)
    ? currentWorkflow
    : null;
  currentWorkflowRef.current = visibleWorkflow;
  const sessionPermissionRequest = useWorkspaceStore((state) =>
    state.permissionRequests.find(
      (request) => request.sessionKey === state.currentSessionKey,
    ) ?? state.permissionRequests[0] ?? null,
  );
  const permissionRequest = sessionPermissionRequest ?? workflowPermissionRequests[0] ?? null;
  const permissionRequestWorkflowId = permissionRequest
    ? workflowIdFromAgentRunId(permissionRequest.runId)
    : null;
  const permissionSwitchTarget = useMemo(() => {
    return permissionRequest ? findPermissionSwitchTarget(permissionRequest, projects) : null;
  }, [permissionRequest, projects]);

  const refreshRecoveryCenter = useCallback(async () => {
    const snapshot = await window.api.getRecoveryCenter();
    setRecoveryCenter(snapshot);
    return snapshot;
  }, []);

  useEffect(() => {
    let current = true;
    window.api.getRecoveryCenter()
      .then((snapshot) => { if (current) setRecoveryCenter(snapshot); })
      .catch((error) => console.error('Failed to load recovery center:', error));
    return () => { current = false; };
  }, []);

  const resumeRecoveryItem = useCallback(async (item: RecoveryItem) => {
    await window.api.resumeRecoveryItem(item.id);
    await refreshRecoveryCenter();
  }, [refreshRecoveryCenter]);

  const abandonRecoveryItem = useCallback(async (item: RecoveryItem) => {
    await window.api.abandonRecoveryItem(item.id);
    await refreshRecoveryCenter();
  }, [refreshRecoveryCenter]);
  const {
    loadProjects,
    openProject,
    selectProject,
    createTask,
    loadOlderMessages,
    loadOlderTaskEvents,
    fork,
  } = useWorkspaceController();

  const getFirstRunProjectSelectionSnapshot = useCallback((): FirstRunProjectSelectionSnapshot => {
    const workspace = useWorkspaceStore.getState();
    return {
      currentProject: workspace.currentProject,
      currentSessionKey: workspace.currentSessionKey,
      currentRuntime: workspace.currentSessionKey
        ? workspace.runtimes[workspace.currentSessionKey] ?? null
        : null,
      projectRequestId: workspace.projectRequestId,
      selectionIncarnation: firstRunSelectionRef.current.incarnation,
      projectLoading: workspace.projectLoading,
      projectError: workspace.projectError,
    };
  }, []);

  useEffect(() => {
    const updateIncarnation = (workspace: ReturnType<typeof useWorkspaceStore.getState>) => {
      const projectIdentity = workspace.currentProject
        ? `${workspace.currentProject.id}\u0000${canonicalProjectKey(workspace.currentProject.path)}`
        : '';
      const signature = `${workspace.projectRequestId ?? ''}\u0000${projectIdentity}\u0000${workspace.currentSessionKey ?? ''}`;
      const runtime = workspace.currentSessionKey
        ? workspace.runtimes[workspace.currentSessionKey]
        : undefined;
      const loadRequestId = runtime?.loadRequestId ?? null;
      const selectionChanged = firstRunSelectionRef.current.signature !== signature;
      const loadIncarnationChanged = !selectionChanged
        && loadRequestId !== null
        && loadRequestId !== firstRunSelectionRef.current.loadRequestId;
      if (!selectionChanged && !loadIncarnationChanged) return;
      const incarnation = firstRunSelectionRef.current.incarnation + 1;
      firstRunSelectionRef.current = { signature, loadRequestId, incarnation };
      setFirstRunProjectIncarnation(incarnation);
    };
    updateIncarnation(useWorkspaceStore.getState());
    return useWorkspaceStore.subscribe(updateIncarnation);
  }, []);

  const switchProjectForPrompt = useCallback(async (project: Project, prompt: string) => {
    await selectProject(project);
    let workspace = useWorkspaceStore.getState();
    if (workspace.currentProject?.id !== project.id) {
      throw new Error('目标项目切换失败，任务未启动。');
    }
    let key = workspace.currentSessionKey;
    let runtime = key ? workspace.runtimes[key] : undefined;
    const isFreshTask = runtime?.summary.source === 'workbench'
      && runtime.summary.projectId === project.id
      && runtime.summary.status === 'idle'
      && runtime.summary.messageCount === 0
      && runtime.summary.titleSource === 'default';
    if (!isFreshTask) {
      await createTask(project);
      workspace = useWorkspaceStore.getState();
      key = workspace.currentSessionKey;
      runtime = key ? workspace.runtimes[key] : undefined;
    }
    if (!key || runtime?.summary.projectId !== project.id) {
      throw new Error('无法为目标项目创建安全绑定的任务。');
    }
    workspace.setDraft(key, prompt);
  }, [createTask, selectProject]);

  const getActiveWorkflowIdentity = useCallback((): WorkflowTaskIdentity => {
    const workspace = useWorkspaceStore.getState();
    const project = workspace.currentProject;
    const runtime = workspace.currentSessionKey
      ? workspace.runtimes[workspace.currentSessionKey]
      : undefined;
    if (
      !project
      || runtime?.summary.source !== 'workbench'
      || runtime.summary.projectId !== project.id
    ) {
      return { taskId: null, projectId: null };
    }
    return { taskId: runtime.summary.id, projectId: project.id };
  }, []);

  const getActiveFirstRunWorkflowIdentity = useCallback((): FirstRunPendingWorkflowIdentity | null => {
    const workspace = useWorkspaceStore.getState();
    const project = workspace.currentProject;
    const runtime = workspace.currentSessionKey
      ? workspace.runtimes[workspace.currentSessionKey]
      : undefined;
    if (
      !project
      || runtime?.summary.source !== 'workbench'
      || runtime.summary.projectId !== project.id
      || canonicalProjectKey(runtime.projectPath) !== canonicalProjectKey(project.path)
    ) return null;
    return {
      taskId: runtime.summary.id,
      projectId: project.id,
      projectPath: runtime.projectPath,
      selectionIncarnation: firstRunSelectionRef.current.incarnation,
    };
  }, []);

  const reconcileFirstRunWorkflowIsolation = useCallback((): boolean => {
    const released = firstRunWorkflowIsolationRef.current.releaseRejected({
      firstRunActive: firstRunGateRef.current !== 'done',
      activeIdentity: getActiveFirstRunWorkflowIdentity(),
    });
    if (released) setWorkflowRevision((revision) => revision + 1);
    return released;
  }, [getActiveFirstRunWorkflowIdentity]);

  useEffect(() => {
    reconcileFirstRunWorkflowIsolation();
  }, [
    currentTaskId,
    currentTaskProjectId,
    firstRunGate,
    firstRunProjectIncarnation,
    reconcileFirstRunWorkflowIsolation,
  ]);

  const adoptWorkflow = useCallback((workflow: Workflow): boolean => {
    const identity = getActiveWorkflowIdentity();
    if (!matchesWorkflowRecord(workflow, identity)) return false;
    currentWorkflowRef.current = workflow;
    setCurrentWorkflow(workflow);
    if (!canCreateWorkflowCommitPreview(workflow.status)) {
      setWorkflowCommitPreview(null);
    }
    setWorkflowRevision((revision) => revision + 1);
    return true;
  }, [getActiveWorkflowIdentity]);

  useEffect(() => {
    workflowMutationGenerationRef.current += 1;
    workflowPreviewGenerationRef.current += 1;
    setWorkflowControlPending(null);
    setWorkflowControlError(null);
    setWorkflowCommitPreview(null);
    setWorkflowPreviewLoading(false);
  }, [currentTaskId, currentTaskProjectId]);

  useEffect(() => {
    const generation = workflowLookupGenerationRef.current + 1;
    workflowLookupGenerationRef.current = generation;
    const identity = { taskId: currentTaskId, projectId: currentTaskProjectId };

    if (!identity.taskId || !identity.projectId) {
      currentWorkflowRef.current = null;
      setCurrentWorkflow(null);
      setWorkflowLookupPending(false);
      return undefined;
    }

    if (firstRunWorkflowIsolationRef.current.blocks(identity)) {
      setWorkflowLookupPending(false);
      return undefined;
    }

    setCurrentWorkflow((workflow) => {
      const next = matchesWorkflowRecord(workflow, identity) ? workflow : null;
      currentWorkflowRef.current = next;
      return next;
    });
    setWorkflowLookupPending(true);

    void window.api.getWorkflowByTask(identity.taskId)
      .then((workflow) => {
        if (workflowLookupGenerationRef.current !== generation) return;
        const liveIdentity = getActiveWorkflowIdentity();
        if (
          liveIdentity.taskId !== identity.taskId
          || liveIdentity.projectId !== identity.projectId
          || firstRunWorkflowIsolationRef.current.blocks(identity)
        ) return;
        const next = matchesWorkflowRecord(workflow, identity) ? workflow : null;
        currentWorkflowRef.current = next;
        setCurrentWorkflow(next);
      })
      .catch((error) => {
        if (workflowLookupGenerationRef.current === generation) {
          console.error('Unable to load workflow:', error);
        }
      })
      .finally(() => {
        if (workflowLookupGenerationRef.current === generation) {
          setWorkflowLookupPending(false);
        }
      });

    return () => {
      if (workflowLookupGenerationRef.current === generation) {
        workflowLookupGenerationRef.current += 1;
      }
    };
  }, [currentTaskId, currentTaskProjectId, getActiveWorkflowIdentity, workflowRevision]);

  useEffect(() => window.api.onWorkflowChanged((event) => {
    const identity = getActiveWorkflowIdentity();
    if (!matchesWorkflowChangedEvent(event, identity)) return;
    if (firstRunWorkflowIsolationRef.current.blocks(identity)) return;
    const workspace = useWorkspaceStore.getState();
    const sessionKey = workspace.currentSessionKey;
    const runtime = sessionKey ? workspace.runtimes[sessionKey] : undefined;
    const sessionStatus = sessionStatusForWorkflow(event.status);
    if (
      sessionKey
      && runtime?.summary.source === 'workbench'
      && runtime.summary.id === event.taskId
      && runtime.summary.projectId === event.projectId
    ) {
      workspace.updateSessionSummary(sessionKey, { status: sessionStatus });
      void window.api.updateSession(event.taskId, { status: sessionStatus });
    }
    const workflow = currentWorkflowRef.current;
    if (workflow?.id === event.workflowId && matchesWorkflowRecord(workflow, identity)) {
      const next: Workflow = {
        ...workflow,
        status: event.status,
        currentStage: event.currentStage,
        revision: event.revision,
      };
      currentWorkflowRef.current = next;
      setCurrentWorkflow(next);
      if (!canCreateWorkflowCommitPreview(next.status)) setWorkflowCommitPreview(null);
    }
    setWorkflowRevision((revision) => revision + 1);
  }), [getActiveWorkflowIdentity]);

  useEffect(() => {
    const root = document.documentElement;
    const dark = theme === 'dark'
      || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.classList.toggle('dark', dark);
    document.body.style.backgroundColor = dark ? '#141413' : '#f8f7f4';
  }, [theme]);

  useEffect(() => {
    setLocale(locale);
  }, [locale]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void (async () => {
      const [installation, settings, gate, resumeStep] = await Promise.all([
        window.api.checkInstallation().catch(() => null),
        window.api.getSettings().catch(() => null),
        loadFirstRunGate(() => window.api.getFirstRunCompletedVersion()),
        window.api.getFirstRunResumeStep().catch(() => 'welcome' as const),
      ]);
      setFirstRunGate(gate);
      setFirstRunResumeStep(resumeStep);
      if (installation) {
        setClaudeInstalled(installation.installed);
        setShowEnvCheck(shouldShowLegacyEnvironmentCheck(installation.installed, gate));
      } else if (gate !== 'done') {
        setShowEnvCheck(false);
      }
      if (settings) {
        const app = useAppStore.getState();
        if (settings.theme) app.setTheme(settings.theme);
        if (settings.language) app.setLocale(settings.language);
        if (settings.defaultModel) app.setCurrentModel(settings.defaultModel);
        if (settings.defaultPermissionMode) app.setPermissionMode(settings.defaultPermissionMode);
        if (settings.detectedModel) app.setDetectedModel(settings.detectedModel);
        if (settings.modelSource) app.setModelSource(settings.modelSource);
        app.setShowDangerousPermissions(Boolean(settings.showDangerousPermissions));
      }
      try {
        await loadProjects(true);
      } catch (error) {
        console.error('Workbench initialization failed:', error);
      }
    })();
  }, [loadProjects, setClaudeInstalled, setShowEnvCheck]);

  useEffect(() => {
    const unsubscribe = window.api.onClaudeEvent((envelope: ClaudeEventEnvelope) => {
      if (workflowIdFromAgentRunId(envelope.runId)) {
        return;
      }
      const workspace = useWorkspaceStore.getState();
      const runtimeBefore = workspace.runtimes[envelope.sessionKey];
      const activeRunEvent = runtimeBefore?.activeRunId === envelope.runId;
      if (!workspace.applyClaudeEvent(envelope.sessionKey, envelope.runId, envelope.event)) return;
      const runtime = useWorkspaceStore.getState().runtimes[envelope.sessionKey];
      if (!runtime) return;
      const event = envelope.event;

      if (event.type === 'session_completed' || event.type === 'session_failed') {
        useWorkspaceStore.getState().clearPermissionRequestsForRun(envelope.runId);
      }

      if (event.type === 'system_init') {
        const app = useAppStore.getState();
        if (activeRunEvent && event.model && workspace.currentSessionKey === envelope.sessionKey) {
          app.setDetectedModel(event.model);
          app.setModelSource('session');
        }
        if (activeRunEvent && runtime.summary.source === 'workbench') {
          void window.api.updateSession(runtime.summary.id, {
            claudeSessionId: event.sessionId,
            model: event.model || null,
            status: 'running',
          });
        }
      }

      if (event.type === 'assistant_text' && runtime.summary.source === 'workbench') {
        const messageId = event.messageId || `assistant:${envelope.runId}`;
        const message = runtime.messages.find(
          (candidate) => candidate.id === messageId && candidate.runId === envelope.runId,
        );
        if (message) {
          void window.api.saveMessage(
            runtime.summary.id,
            'assistant',
            message.content,
            messageId,
          );
        }
      }

      if (event.type === 'session_completed' && activeRunEvent) {
        useWorkspaceStore.getState().updateSessionSummary(envelope.sessionKey, {
          status: 'completed',
          durationMs: event.duration,
          completedAt: new Date().toISOString(),
          error: undefined,
        });
        if (runtime.summary.source === 'workbench') {
          void window.api.updateSession(runtime.summary.id, {
            status: 'completed',
            completedAt: new Date().toISOString(),
          });
        }
      }

      if (event.type === 'session_failed' && activeRunEvent) {
        useWorkspaceStore.getState().updateSessionSummary(envelope.sessionKey, {
          status: runtime.summary.status === 'cancelled' ? 'cancelled' : 'failed',
          durationMs: event.duration,
          error: event.error,
        });
        if (runtime.summary.source === 'workbench') {
          void window.api.updateSession(runtime.summary.id, {
            status: runtime.summary.status === 'cancelled' ? 'cancelled' : 'failed',
          });
        }
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.api.onPermissionRequest((request) => {
      if (workflowIdFromAgentRunId(request.runId)) {
        setWorkflowPermissionRequests((requests) => (
          enqueueWorkflowPermissionRequest(requests, request)
        ));
        return;
      }
      useWorkspaceStore.getState().enqueuePermissionRequest(request);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.api.onPermissionSettled((settlement) => {
      setWorkflowPermissionRequests((requests) => (
        removeWorkflowPermissionRequest(requests, settlement.requestId)
      ));
      useWorkspaceStore.getState().settlePermissionRequest(settlement.requestId);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    setTaskSnapshot(null);
    if (!currentSessionKey || !currentRuntime || currentRuntime.summary.source !== 'workbench') {
      return undefined;
    }
    let active = true;
    const sessionKey = currentSessionKey;
    const taskId = currentRuntime.summary.id;
    const delay = ['completed', 'failed', 'cancelled'].includes(currentRuntime.summary.status) ? 50 : 0;
    const timer = window.setTimeout(() => {
      void window.api.getTaskSnapshot(taskId, { limit: 500, offset: 0 })
        .then(async (firstSnapshot) => {
          if (!firstSnapshot) return null;
          if (firstSnapshot.eventTotal <= firstSnapshot.events.length) return firstSnapshot;
          const offset = Math.max(0, firstSnapshot.eventTotal - 500);
          return window.api.getTaskSnapshot(taskId, { limit: 500, offset });
        })
        .then((snapshot) => {
          if (
            !active
            || !snapshot
            || useWorkspaceStore.getState().currentSessionKey !== sessionKey
          ) return;
          setTaskSnapshot(snapshot);
          useWorkspaceStore.getState().prependTaskState(
            sessionKey,
            hydratePersistedTasks(snapshot),
            {
              offset: snapshot.eventOffset
                ?? Math.max(0, snapshot.eventTotal - snapshot.events.length),
              total: snapshot.eventTotal,
            },
          );
        })
        .catch((error) => console.error('Unable to load task snapshot:', error));
    }, delay);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    checkpointRevision,
    currentRuntime?.summary.id,
    currentRuntime?.summary.source,
    currentRuntime?.summary.status,
    currentSessionKey,
  ]);

  useEffect(() => window.api.onCheckpointChanged((event) => {
    const state = useWorkspaceStore.getState();
    const runtime = state.currentSessionKey ? state.runtimes[state.currentSessionKey] : undefined;
    if (runtime?.summary.id === event.taskId) {
      setCheckpointRevision((revision) => revision + 1);
    }
  }), []);

  const handleOpenProject = useCallback(() => {
    void openProject();
  }, [openProject]);

  const assertFirstRunProjectSelected = useCallback((project: Project) => {
    const workspace = useWorkspaceStore.getState();
    if (
      workspace.projectLoading
      || workspace.projectError
      || workspace.currentProject?.id !== project.id
      || canonicalProjectKey(workspace.currentProject.path) !== canonicalProjectKey(project.path)
    ) throw new Error('FIRST_RUN_PROJECT_SELECTION');
  }, []);

  const openFirstRunProject = useCallback(async () => {
    const project = await openProject();
    if (!project) return null;
    assertFirstRunProjectSelected(project);
    return project;
  }, [assertFirstRunProjectSelected, openProject]);

  const selectFirstRunProject = useCallback(async (project: Project) => {
    await selectProject(project);
    assertFirstRunProjectSelected(project);
  }, [assertFirstRunProjectSelected, selectProject]);

  const openSettingsCategory = useCallback((category: SettingsCategory) => {
    setSettingsInitialCategory(category);
    setShowSettings(true);
  }, [setShowSettings]);

  const startFirstRunPlannerInWorkspace = useCallback((project: Project) => (
    runAfterSettledFirstRunProject(project, {
      getSnapshot: getFirstRunProjectSelectionSnapshot,
      selectProject,
      waitForSettled: (selectedProject, selectionIncarnation) => (
        waitForFirstRunProjectSelection(
          selectedProject,
          selectionIncarnation,
          getFirstRunProjectSelectionSnapshot,
        )
      ),
    }, async (selection) => {
    const prepared = await prepareFirstRunPlannerTask(project, selection, {
      getSnapshot: getFirstRunProjectSelectionSnapshot,
      createTask,
      workflowAlreadyExists: (taskId, projectId) => Boolean(
        currentWorkflowRef.current?.taskId === taskId
        && currentWorkflowRef.current.projectId === projectId,
      ),
    });
    const capturedSessionKey = prepared.sessionKey;
    const capturedSelectionIncarnation = prepared.selectionIncarnation;
    const runtime = prepared.runtime;
    const capturedTask = {
      id: runtime.summary.id,
      projectId: runtime.summary.projectId,
      projectPath: runtime.projectPath,
      title: runtime.summary.title,
      titleSource: runtime.summary.titleSource,
    };
    const app = useAppStore.getState();
    app.setAgentMode('plan');
    app.setPermissionMode('plan');

    const pendingWorkflowIdentity = {
      taskId: capturedTask.id,
      projectId: capturedTask.projectId,
      projectPath: capturedTask.projectPath,
      selectionIncarnation: capturedSelectionIncarnation,
    };

    return runIsolatedFirstRunWorkflow(
      firstRunWorkflowIsolationRef.current,
      pendingWorkflowIdentity,
      () => startFirstRunPlanner({
        project,
        task: capturedTask,
        selectionIncarnation: capturedSelectionIncarnation,
        ...(app.currentModel ? { currentModel: app.currentModel } : {}),
      }, {
        currentIdentity: () => {
          const live = useWorkspaceStore.getState();
          const liveRuntime = live.currentSessionKey ? live.runtimes[live.currentSessionKey] : undefined;
          if (!liveRuntime || liveRuntime.summary.source !== 'workbench') return null;
          return {
            taskId: liveRuntime.summary.id,
            projectId: liveRuntime.summary.projectId,
            projectPath: liveRuntime.projectPath,
            selectionIncarnation: firstRunSelectionRef.current.incarnation,
          };
        },
        randomUUID: () => crypto.randomUUID(),
        saveUserMessage: async (taskId, content, messageId) => {
          await window.api.saveMessage(taskId, 'user', content, messageId);
          const live = useWorkspaceStore.getState();
          if (
            live.currentSessionKey === capturedSessionKey
            && firstRunSelectionRef.current.incarnation === capturedSelectionIncarnation
          ) {
            live.appendUserMessage(capturedSessionKey, messageId, content, `workflow:${messageId}`);
          }
        },
        updateSession: async (taskId, patch) => {
          await window.api.updateSession(taskId, patch);
          const live = useWorkspaceStore.getState();
          if (
            live.currentSessionKey === capturedSessionKey
            && firstRunSelectionRef.current.incarnation === capturedSelectionIncarnation
          ) live.updateSessionSummary(capturedSessionKey, patch);
        },
        createWorkflow: (input) => window.api.createWorkflow(input),
        startWorkflowPlanning: (workflowId) => window.api.startWorkflowPlanning(workflowId),
      }),
      adoptWorkflow,
      () => {
        workflowLookupGenerationRef.current += 1;
        setWorkflowLookupPending(false);
      },
      reconcileFirstRunWorkflowIsolation,
    );
    })
  ), [
    adoptWorkflow,
    createTask,
    getFirstRunProjectSelectionSnapshot,
    reconcileFirstRunWorkflowIsolation,
    selectProject,
  ]);

  const openGitAction = useCallback((kind: GitActionRequest['kind']) => {
    const workspace = useWorkspaceStore.getState();
    const project = workspace.currentProject;
    const runtime = workspace.currentSessionKey
      ? workspace.runtimes[workspace.currentSessionKey]
      : undefined;
    if (
      !project
      || runtime?.summary.source !== 'workbench'
      || runtime.summary.projectId !== project.id
    ) return;
    if (!useAppStore.getState().showFileDrawer) useAppStore.getState().toggleFileDrawer();
    gitActionIdRef.current += 1;
    setGitActionRequest({
      id: gitActionIdRef.current,
      kind,
      projectId: project.id,
      projectPath: project.path,
      taskId: runtime.summary.id,
    });
  }, []);

  useEffect(() => {
    const taskId = currentRuntime?.summary.source === 'workbench'
      ? currentRuntime.summary.id
      : undefined;
    setGitActionRequest((request) => {
      if (!request) return null;
      return currentProject
        && taskId
        && request.projectId === currentProject.id
        && request.projectPath === currentProject.path
        && request.taskId === taskId
        ? request
        : null;
    });
  }, [currentProject?.id, currentProject?.path, currentRuntime?.summary.id, currentRuntime?.summary.source]);

  useEffect(() => {
    const registrations = [
      commandRegistry.register('project.open', () => handleOpenProject()),
      commandRegistry.register('project.search', () => {
        (document.querySelector('[data-project-search]') as HTMLInputElement | null)?.focus();
      }),
      commandRegistry.register('task.new', async () => { await createTask(); }),
      commandRegistry.register('task.search', () => {
        (document.querySelector('[data-task-search]') as HTMLInputElement | null)?.focus();
      }),
      commandRegistry.register('task.switch', () => {
        (document.querySelector('[data-task-search]') as HTMLInputElement | null)?.focus();
      }),
      commandRegistry.register('task.send', () => {
        window.dispatchEvent(new CustomEvent('workbench:send-task'));
      }),
      commandRegistry.register('task.send-plan', () => {
        window.dispatchEvent(new CustomEvent('workbench:send-task', { detail: { plan: true } }));
      }),
      commandRegistry.register('history.refresh', () => {
        const project = useWorkspaceStore.getState().currentProject;
        if (project) return selectProject(project);
      }),
      commandRegistry.register('settings.open', () => useAppStore.getState().setShowSettings(true)),
      commandRegistry.register('model.switch', () => {
        (document.querySelector('[data-model-selector]') as HTMLButtonElement | null)?.click();
      }),
      commandRegistry.register('permission.switch', () => {
        (document.querySelector('[data-permission-selector]') as HTMLButtonElement | null)?.click();
      }),
      commandRegistry.register('terminal.open', () => {
        if (!useAppStore.getState().showTerminal) useAppStore.getState().toggleTerminal();
      }),
      commandRegistry.register('diff.open', () => {
        if (!useAppStore.getState().showFileDrawer) useAppStore.getState().toggleFileDrawer();
      }),
      commandRegistry.register('command-palette.open', () => setCommandPaletteOpen(true)),
    ];
    const detach = commandRegistry.attach(window, () => ({
      source: 'shortcut',
      modalOpen: commandPaletteOpen || Boolean(integrationsProject) || Boolean(settingsProject),
    }));
    return () => {
      detach();
      registrations.forEach((unregister) => unregister());
    };
  }, [commandPaletteOpen, commandRegistry, createTask, handleOpenProject, integrationsProject, selectProject, settingsProject]);

  useEffect(() => window.api.onMenuCommand((command) => {
    if (command === 'project.open') void commandRegistry.execute('project.open');
  }), [commandRegistry]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key === 'o') {
        event.preventDefault();
        handleOpenProject();
      } else if (event.key === 'j') {
        event.preventDefault();
        useAppStore.getState().toggleTerminal();
      } else if (event.key === 'b') {
        event.preventDefault();
        useAppStore.getState().toggleSidebar();
      } else if (event.key === ',') {
        event.preventDefault();
        setShowSettings(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleOpenProject, setShowSettings]);

  const startTerminalDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setIsDraggingTerminal(true);
    dragStartRef.current = { y: event.clientY, size: terminalHeight };
  }, [terminalHeight]);

  useEffect(() => {
    if (!isDraggingTerminal) return;
    const move = (event: MouseEvent) => {
      setTerminalHeight(Math.max(100, Math.min(500, dragStartRef.current.size - (event.clientY - dragStartRef.current.y))));
    };
    const stop = () => setIsDraggingTerminal(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
  }, [isDraggingTerminal]);

  const loadWorkflowPage = useCallback((
    request: Parameters<typeof window.api.listWorkflowPage>[0],
    signal: AbortSignal,
  ) => abortableWorkflowRequest(signal, () => window.api.listWorkflowPage(request)), []);

  const loadWorkflow = useCallback(async (workflowId: string, signal: AbortSignal) => {
    const workflow = await abortableWorkflowRequest(
      signal,
      () => window.api.getWorkflow(workflowId),
    );
    if (!workflow) throw new Error('Workflow not found');
    return workflow;
  }, []);

  const loadWorkflowStages = useCallback(async (workflowId: string, signal: AbortSignal) => {
    const page = await abortableWorkflowRequest(
      signal,
      () => window.api.listWorkflowStages(workflowId, { limit: 100, offset: 0 }),
    );
    return page.items;
  }, []);

  const loadWorkflowReview = useCallback((workflowId: string, signal: AbortSignal) => (
    abortableWorkflowRequest(signal, () => window.api.getWorkflowReview(workflowId))
  ), []);

  const mutateWorkflow = useCallback(async (
    workflowId: string,
    request: () => Promise<Workflow>,
    pendingAction: 'pause' | 'resume' | 'cancel' | null = null,
  ): Promise<Workflow> => {
    const identity = getActiveWorkflowIdentity();
    const selected = currentWorkflowRef.current;
    if (selected?.id !== workflowId || !matchesWorkflowRecord(selected, identity)) {
      throw new Error('Workflow is no longer selected');
    }
    const generation = workflowMutationGenerationRef.current + 1;
    workflowMutationGenerationRef.current = generation;
    if (pendingAction) setWorkflowControlPending(pendingAction);
    setWorkflowControlError(null);
    try {
      const next = await request();
      const liveIdentity = getActiveWorkflowIdentity();
      if (
        workflowMutationGenerationRef.current === generation
        && next.id === workflowId
        && matchesWorkflowRecord(next, liveIdentity)
      ) {
        adoptWorkflow(next);
      }
      return next;
    } catch (error) {
      if (workflowMutationGenerationRef.current === generation) {
        setWorkflowControlError(error instanceof Error ? error.message : 'Workflow action failed');
      }
      throw error;
    } finally {
      if (pendingAction && workflowMutationGenerationRef.current === generation) {
        setWorkflowControlPending(null);
      }
    }
  }, [adoptWorkflow, getActiveWorkflowIdentity]);

  const selectWorkflow = useCallback((workflowId: string) => {
    if (currentWorkflowRef.current?.id === workflowId) {
      setWorkflowRevision((revision) => revision + 1);
      return;
    }
    const identity = getActiveWorkflowIdentity();
    if (!identity.taskId || !identity.projectId) return;
    const generation = workflowLookupGenerationRef.current + 1;
    workflowLookupGenerationRef.current = generation;
    setWorkflowLookupPending(true);
    void window.api.getWorkflow(workflowId)
      .then((workflow) => {
        if (
          workflowLookupGenerationRef.current === generation
          && matchesWorkflowRecord(workflow, getActiveWorkflowIdentity())
        ) {
          currentWorkflowRef.current = workflow;
          setCurrentWorkflow(workflow);
        }
      })
      .catch((error) => {
        if (workflowLookupGenerationRef.current === generation) {
          setWorkflowControlError(error instanceof Error ? error.message : 'Unable to select workflow');
        }
      })
      .finally(() => {
        if (workflowLookupGenerationRef.current === generation) {
          setWorkflowLookupPending(false);
        }
      });
  }, [getActiveWorkflowIdentity]);

  const startWorkflowExecution = useCallback(async (workflow: Workflow) => {
    await mutateWorkflow(workflow.id, () => window.api.startWorkflowExecution(workflow.id));
  }, [mutateWorkflow]);

  const modifyWorkflowPlan = useCallback(async (workflow: Workflow, plan: ExecutionPlan) => {
    await mutateWorkflow(workflow.id, () => window.api.updateWorkflowPlan(workflow.id, plan));
  }, [mutateWorkflow]);

  const cancelSelectedWorkflow = useCallback(async (workflow: Workflow) => {
    await mutateWorkflow(workflow.id, () => window.api.cancelWorkflow(workflow.id));
  }, [mutateWorkflow]);

  const applyWorkflowReviewFix = useCallback(async (workflow: Workflow) => {
    await mutateWorkflow(workflow.id, () => window.api.resumeWorkflow(workflow.id, true));
  }, [mutateWorkflow]);

  const ignoreWorkflowReview = useCallback(async (workflow: Workflow) => {
    await mutateWorkflow(workflow.id, () => window.api.acceptWorkflowReview(workflow.id));
  }, [mutateWorkflow]);

  const exportWorkflowReview = useCallback((workflow: Workflow) => {
    const identity = getActiveWorkflowIdentity();
    if (
      currentWorkflowRef.current?.id !== workflow.id
      || !matchesWorkflowRecord(workflow, identity)
    ) return;
    void window.api.exportWorkflowReview(workflow.id).catch((error) => {
      if (currentWorkflowRef.current?.id === workflow.id) {
        setWorkflowControlError(error instanceof Error ? error.message : 'Unable to export review');
      }
    });
  }, [getActiveWorkflowIdentity]);

  const refreshWorkflow = useCallback((workflowId: string) => {
    if (currentWorkflowRef.current?.id === workflowId) {
      setWorkflowRevision((revision) => revision + 1);
    }
  }, []);

  const pauseWorkflow = useCallback(() => {
    const workflow = currentWorkflowRef.current;
    if (!workflow) return;
    void mutateWorkflow(
      workflow.id,
      () => window.api.pauseWorkflow(workflow.id),
      'pause',
    ).catch(() => undefined);
  }, [mutateWorkflow]);

  const resumeWorkflow = useCallback(() => {
    const workflow = currentWorkflowRef.current;
    if (!workflow) return;
    void mutateWorkflow(
      workflow.id,
      () => window.api.resumeWorkflow(workflow.id),
      'resume',
    ).catch(() => undefined);
  }, [mutateWorkflow]);

  const cancelWorkflow = useCallback(() => {
    const workflow = currentWorkflowRef.current;
    if (!workflow) return;
    void mutateWorkflow(
      workflow.id,
      () => window.api.cancelWorkflow(workflow.id),
      'cancel',
    ).catch(() => undefined);
  }, [mutateWorkflow]);

  const createWorkflowCommitPreview = useCallback(() => {
    const workflow = currentWorkflowRef.current;
    const identity = getActiveWorkflowIdentity();
    if (
      !workflow
      || !matchesWorkflowRecord(workflow, identity)
      || !canCreateWorkflowCommitPreview(workflow.status)
    ) return;
    const generation = workflowPreviewGenerationRef.current + 1;
    workflowPreviewGenerationRef.current = generation;
    setWorkflowPreviewLoading(true);
    setWorkflowControlError(null);
    void window.api.createWorkflowCommitPreview(workflow.id)
      .then((preview) => {
        if (
          workflowPreviewGenerationRef.current === generation
          && currentWorkflowRef.current?.id === workflow.id
          && canCreateWorkflowCommitPreview(currentWorkflowRef.current.status)
        ) {
          setWorkflowCommitPreview(preview);
        }
      })
      .catch((error) => {
        if (workflowPreviewGenerationRef.current === generation) {
          setWorkflowControlError(error instanceof Error ? error.message : 'Unable to create commit preview');
        }
      })
      .finally(() => {
        if (workflowPreviewGenerationRef.current === generation) {
          setWorkflowPreviewLoading(false);
        }
      });
  }, [getActiveWorkflowIdentity]);

  const stopPermissionRequest = async (): Promise<void> => {
    if (!permissionRequest) return;
    if (permissionRequestWorkflowId) {
      const workflowId = permissionRequestWorkflowId;
      const controlsCurrentWorkflow = currentWorkflowRef.current?.id === workflowId;
      if (controlsCurrentWorkflow) {
        setWorkflowControlPending('cancel');
        setWorkflowControlError(null);
      }
      try {
        const cancelled = await cancelWorkflowPermissionRun(
          window.api,
          workflowId,
          permissionRequest.runId,
        );
        if (controlsCurrentWorkflow) adoptWorkflow(cancelled);
      } catch (error) {
        if (controlsCurrentWorkflow) {
          setWorkflowControlError(error instanceof Error ? error.message : 'Unable to cancel workflow');
        }
        throw error;
      } finally {
        setWorkflowPermissionRequests((requests) => (
          requests.filter((request) => request.runId !== permissionRequest.runId)
        ));
        if (controlsCurrentWorkflow && currentWorkflowRef.current?.id === workflowId) {
          setWorkflowControlPending(null);
        }
      }
      return;
    }
    const stopped = await window.api.stopRun(permissionRequest.runId);
    const workspace = useWorkspaceStore.getState();
    if (stopped) {
      workspace.setSessionStatus(permissionRequest.sessionKey, 'cancelled');
      const runtime = useWorkspaceStore.getState().runtimes[permissionRequest.sessionKey];
      if (runtime?.summary.source === 'workbench') {
        await window.api.updateSession(runtime.summary.id, { status: 'cancelled' });
      }
    }
    useWorkspaceStore.getState().clearPermissionRequestsForRun(permissionRequest.runId);
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <TopToolbar
        onOpenProject={handleOpenProject}
        modelProviderState={modelProviderToolbar}
        modelSwitchBlocked={Boolean(
          visibleWorkflow && !TERMINAL_WORKFLOW_STATUSES.has(visibleWorkflow.status)
        )}
      />
      <div className="flex-1 flex min-h-0">
        {showSidebar && (
          <div className="flex-shrink-0 overflow-hidden" style={{ width: 270, borderRight: '1px solid var(--border-primary)' }}>
            <ProjectSidebar
              onOpenProject={handleOpenProject}
              onProjectSettings={setSettingsProject}
              onOpenIntegrations={(project) => {
                setIntegrationsInitialTab('mcp');
                setIntegrationsProject(project);
              }}
            />
          </div>
        )}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 flex flex-col min-h-0 relative">
            {visibleWorkflow ? (
              <div className="flex min-h-0 flex-1 flex-col" data-testid="current-workflow">
                <WorkflowControls
                  workflow={visibleWorkflow}
                  preview={workflowCommitPreview}
                  previewLoading={workflowPreviewLoading}
                  pendingAction={workflowControlPending}
                  error={workflowControlError}
                  onPause={pauseWorkflow}
                  onResume={resumeWorkflow}
                  onCancel={cancelWorkflow}
                  onCreatePreview={createWorkflowCommitPreview}
                />
                <React.Suspense fallback={<div className="flex-1 p-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>Loading workflow...</div>}>
                  <WorkflowPanel
                    className="min-h-0 flex-1"
                    projectId={currentTaskProjectId}
                    taskId={currentTaskId}
                    selectedWorkflowId={visibleWorkflow.id}
                    refreshToken={`${workflowRevision}:${visibleWorkflow.revision}`}
                    loadWorkflowPage={loadWorkflowPage}
                    loadWorkflow={loadWorkflow}
                    loadWorkflowStages={loadWorkflowStages}
                    loadWorkflowReview={loadWorkflowReview}
                    onSelectWorkflow={selectWorkflow}
                    onStartExecution={startWorkflowExecution}
                    onModifyPlan={modifyWorkflowPlan}
                    onCancelWorkflow={cancelSelectedWorkflow}
                    onApplyReviewFix={applyWorkflowReviewFix}
                    onIgnoreReview={ignoreWorkflowReview}
                    onExportReview={exportWorkflowReview}
                    onActionCompleted={refreshWorkflow}
                  />
                </React.Suspense>
              </div>
            ) : (
              <ChatTimeline
                onOpenProject={handleOpenProject}
                onCreateTask={() => { void createTask(); }}
                taskSnapshot={taskSnapshot}
                onLoadOlderMessages={loadOlderMessages}
                onLoadOlderTaskEvents={loadOlderTaskEvents}
                onAcceptTaskChanges={() => openGitAction('accept')}
                onRestoreTaskChanges={() => openGitAction('restore')}
                onViewTaskDiff={() => openGitAction('diff')}
                onExportTaskMarkdown={currentRuntime?.summary.source === 'workbench'
                  ? () => { void window.api.exportTaskReport(currentRuntime.summary.id); }
                  : undefined}
                onForkMessage={
                  currentRuntime
                    ? (messageId) => void fork(currentRuntime.summary, { upToMessageId: messageId })
                    : undefined
                }
              />
            )}
            <InputBar
              onOpenProject={handleOpenProject}
              onSwitchProjectForPrompt={switchProjectForPrompt}
              workflowStatus={visibleWorkflow?.status ?? null}
              workflowLookupPending={workflowLookupPending}
              onWorkflowChanged={adoptWorkflow}
              modelProviderState={modelProviderToolbar}
            />
          </div>
          {showTerminal && (
            <>
              <div className="h-1 cursor-row-resize flex-shrink-0" style={{ background: 'var(--accent)' }} onMouseDown={startTerminalDrag} />
              <div style={{ height: terminalHeight }} className="flex-shrink-0">
                <TerminalPanel projectPath={currentProject?.path} onClose={() => useAppStore.getState().toggleTerminal()} />
              </div>
            </>
          )}
        </div>
        {showFileDrawer && (
          <div className="flex-shrink-0 overflow-hidden animate-slide-right" style={{ width: 420, borderLeft: '1px solid var(--border-primary)' }}>
            <React.Suspense fallback={<div className="p-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>正在加载工作区面板…</div>}>
              <WorkspaceRightDrawer
                project={currentProject}
                taskId={currentRuntime?.summary.source === 'workbench'
                  ? currentRuntime.summary.id
                  : undefined}
                actionRequest={gitActionRequest}
                refreshToken={checkpointRevision}
                onActionHandled={(id) => {
                  setGitActionRequest((current) => current?.id === id ? null : current);
                }}
                onTaskDataChanged={() => setCheckpointRevision((revision) => revision + 1)}
              />
            </React.Suspense>
          </div>
        )}
      </div>

      {firstRunGate === 'booting' ? (
        <div className="fixed inset-0 z-[45] flex items-center justify-center" style={{ background: 'var(--bg-overlay)' }} role="status" aria-live="polite">
          <span className="rounded-lg px-4 py-3 text-sm" style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>{t('common.loading')}</span>
        </div>
      ) : null}
      {firstRunGate === 'required' || firstRunGate === 'read_failed' ? (
        <FirstRunWizard
          api={firstRunWizardApi}
          completionReadFailed={firstRunGate === 'read_failed'}
          initialStep={firstRunResumeStep}
          initialProject={currentProject}
          projectIncarnation={firstRunProjectIncarnation}
          onOpenProviderCenter={() => openSettingsCategory('models')}
          onOpenEnvironmentSettings={() => openSettingsCategory('terminal_tools')}
          onOpenProject={openFirstRunProject}
          onSelectProject={selectFirstRunProject}
          onStartPlanner={startFirstRunPlannerInWorkspace}
          onDone={() => setFirstRunGate('done')}
        />
      ) : null}
      {showSettings && (
        <SettingsDialog
          initialCategory={settingsInitialCategory}
          onClose={() => {
            setShowSettings(false);
            setSettingsInitialCategory('general');
          }}
          onOpenProject={handleOpenProject}
          onOpenProjectSettings={(project) => setSettingsProject(project)}
          onRerunFirstRun={() => {
            setFirstRunResumeStep('welcome');
            setFirstRunGate('required');
          }}
          onOpenIntegrations={(project, initialTab) => {
            setIntegrationsInitialTab(initialTab);
            setIntegrationsProject(project);
          }}
        />
      )}
      {showEnvCheck && firstRunGate === 'done' ? <EnvironmentCheck onClose={() => setShowEnvCheck(false)} /> : null}
      {integrationsProject ? (
        <IntegrationsDialog
          project={integrationsProject}
          initialTab={integrationsInitialTab}
          onClose={() => {
            setIntegrationsProject(null);
            setIntegrationsInitialTab('mcp');
          }}
        />
      ) : null}
      {settingsProject ? (
        <ProjectSettingsDialog
          project={settingsProject}
          onClose={() => setSettingsProject(null)}
        />
      ) : null}
      <CommandPalette
        open={commandPaletteOpen}
        registry={commandRegistry}
        onClose={() => setCommandPaletteOpen(false)}
      />
      {permissionRequest && (
        <PermissionDialog
          key={permissionRequest.requestId}
          request={permissionRequest}
          onResolved={(requestId) => {
            setWorkflowPermissionRequests((requests) => (
              removeWorkflowPermissionRequest(requests, requestId)
            ));
            useWorkspaceStore.getState().settlePermissionRequest(requestId);
          }}
          onStop={stopPermissionRequest}
          onSwitchTargetProject={permissionSwitchTarget ? async () => {
            await stopPermissionRequest();
            await selectProject(permissionSwitchTarget);
          } : undefined}
        />
      )}
      {!recoveryDismissed
        && recoveryCenter?.abnormalExitDetected
        && recoveryCenter.items.length > 0
        && (
          <React.Suspense fallback={null}>
            <RecoveryCenter
              items={recoveryCenter.items}
              onResume={resumeRecoveryItem}
              onAbandon={abandonRecoveryItem}
              onViewLogs={() => window.api.openRecoveryLogs()}
              onDismiss={() => setRecoveryDismissed(true)}
            />
          </React.Suspense>
        )}
      {isDraggingTerminal && <div className="fixed inset-0 z-50 cursor-row-resize" />}
    </div>
  );
}
