import type {
  ClaudeAdapter,
  ClaudeEventEnvelope,
  ClaudeInstallationInfo,
  ClaudeRunDescriptor,
  ClaudeRunOptions,
} from '../../shared/types/claude';
import {
  FileMutationConflictError,
  FileMutationManager,
  type FileMutationKind,
  type FileMutationLease,
} from '../file-mutations/FileMutationManager';
import { canonicalizeProjectPath } from '../projects/ProjectService';

interface ActiveTask {
  options: ClaudeRunOptions;
  writable: boolean;
  projectLockKey: string;
  sessionLockKey: string;
  mutationLease: FileMutationLease | null;
  cancelRequested: boolean;
  finishing: boolean;
}

export interface DangerousRunAuthorizer {
  authorizeBypass(request: {
    runId: string;
    sessionKey: string;
    projectPath: string;
  }): Promise<void>;
}

export interface TaskManagerOptions {
  fileMutations?: FileMutationManager;
  dangerousRunAuthorizer?: DangerousRunAuthorizer;
}

export interface ProjectMutationOptions {
  mutationId?: string;
  kind?: Exclude<
    FileMutationKind,
    'claude_run' | 'workflow_fix' | 'apply_patch' | 'first_run_project'
  >;
  projectId?: string;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  filePaths?: readonly string[];
  verify?: () => void | Promise<void>;
  record?: () => void | Promise<void>;
  rollback?: (error: unknown) => void | Promise<void>;
}

export class TaskConflictError extends Error {
  readonly code: 'TASK_SESSION_BUSY' | 'TASK_PROJECT_BUSY';
  readonly conflictingRunId: string;

  constructor(
    code: 'TASK_SESSION_BUSY' | 'TASK_PROJECT_BUSY',
    conflictingRunId: string,
    message: string,
  ) {
    super(message);
    this.name = 'TaskConflictError';
    this.code = code;
    this.conflictingRunId = conflictingRunId;
  }
}

function isWritableRun(options: ClaudeRunOptions): boolean {
  // Only the CLI-enforced permission mode is a trustworthy write boundary.
  // The IPC layer forces plan/review agent modes to this value as well.
  return options.permissionMode !== 'plan';
}

function sessionLockKey(sessionKey: string): string {
  const separator = sessionKey.lastIndexOf('::');
  const sessionId = separator >= 0 ? sessionKey.slice(separator + 2) : sessionKey;
  return sessionId.trim() || sessionKey;
}

function projectLockKey(projectPath: string): string {
  return canonicalizeProjectPath(projectPath).canonicalPath;
}

function trustedEnvelope(
  task: ActiveTask,
  event: ClaudeEventEnvelope['event'],
): ClaudeEventEnvelope {
  const taskId = task.options.taskId?.trim() || task.sessionLockKey;
  const projectId = task.options.projectId?.trim();
  const workflowId = task.options.workflowContext?.workflowId.trim();
  return {
    runId: task.options.runId,
    projectKey: task.options.projectKey,
    sessionKey: task.options.sessionKey,
    ...(projectId ? { projectId } : {}),
    projectPath: task.options.projectPath,
    taskId,
    ...(workflowId ? { workflowId } : {}),
    event,
  };
}

export class TaskManager implements ClaudeAdapter {
  private readonly adapter: ClaudeAdapter;
  private readonly active = new Map<string, ActiveTask>();
  private readonly sessionLocks = new Map<string, string>();
  private readonly listeners = new Set<(envelope: ClaudeEventEnvelope) => void>();
  private readonly beforeRunListeners = new Set<(options: ClaudeRunOptions) => Promise<void>>();
  private readonly startListeners = new Set<(options: ClaudeRunOptions) => void>();
  private readonly terminalFinalizers = new Set<(envelope: ClaudeEventEnvelope) => Promise<void>>();
  private readonly fileMutations: FileMutationManager;
  private readonly dangerousRunAuthorizer?: DangerousRunAuthorizer;
  private readonly terminalWork = new Map<string, Promise<void>>();
  private readonly completionWaiters = new Map<string, Set<() => void>>();
  private readonly unsubscribeAdapter: () => void;

  constructor(adapter: ClaudeAdapter, options: TaskManagerOptions = {}) {
    this.adapter = adapter;
    this.fileMutations = options.fileMutations ?? new FileMutationManager();
    this.dangerousRunAuthorizer = options.dangerousRunAuthorizer;
    this.unsubscribeAdapter = adapter.subscribe((envelope) => this.handleEvent(envelope));
  }

  checkInstallation(): Promise<ClaudeInstallationInfo> {
    return this.adapter.checkInstallation();
  }

  async runPrompt(options: ClaudeRunOptions): Promise<ClaudeRunDescriptor> {
    if (this.active.has(options.runId)) {
      throw new TaskConflictError(
        'TASK_SESSION_BUSY',
        options.runId,
        '该运行标识已被占用',
      );
    }
    const canonicalProject = projectLockKey(options.projectPath);
    const canonicalSession = sessionLockKey(options.sessionKey);
    const sameSession = this.sessionLocks.get(canonicalSession);
    if (sameSession) {
      throw new TaskConflictError(
        'TASK_SESSION_BUSY',
        sameSession,
        '该任务已有 Claude 运行正在执行',
      );
    }

    const writable = isWritableRun(options);
    for (const [runId, task] of this.active) {
      if (
        task.projectLockKey === canonicalProject
        && (writable || task.writable)
      ) {
        throw new TaskConflictError(
          'TASK_PROJECT_BUSY',
          runId,
          '该项目已有任务正在修改文件，请等待完成或切换到其他项目',
        );
      }
    }

    this.active.set(options.runId, {
      options,
      writable,
      projectLockKey: canonicalProject,
      sessionLockKey: canonicalSession,
      mutationLease: null,
      cancelRequested: false,
      finishing: false,
    });
    this.sessionLocks.set(canonicalSession, options.runId);
    try {
      if (writable) {
        const lease = await this.fileMutations.acquireExternalProcessLease({
          mutationId: options.runId,
          kind: options.workflowContext?.stage === 'coder' && options.workflowContext.reviewRound > 1
            ? 'workflow_fix'
            : 'claude_run',
          projectPath: options.projectPath,
          taskId: canonicalSession,
          sessionId: canonicalSession,
          runId: options.runId,
        });
        const activeTask = this.active.get(options.runId);
        if (!activeTask) {
          lease.release();
          throw new Error('Task was released before its mutation lease was acquired.');
        }
        activeTask.mutationLease = lease;
      }
      for (const listener of this.beforeRunListeners) {
        await listener(options);
      }
      if (options.permissionMode === 'bypassPermissions') {
        if (!this.dangerousRunAuthorizer) {
          throw new Error('Bypass permissions requires explicit main-process authorization.');
        }
        await this.dangerousRunAuthorizer.authorizeBypass({
          runId: options.runId,
          sessionKey: options.sessionKey,
          projectPath: options.projectPath,
        });
      }
      for (const listener of this.startListeners) {
        try {
          listener(options);
        } catch (error) {
          console.error('[TaskManager] start listener failed:', error);
        }
      }
      return await this.adapter.runPrompt(options);
    } catch (error) {
      await this.finalizeAndRelease(options.runId, 'failed', error);
      if (error instanceof FileMutationConflictError) {
        throw new TaskConflictError(
          'TASK_PROJECT_BUSY',
          error.conflictingMutationId,
          'The project already has a running task or file mutation.',
        );
      }
      throw error;
    }
  }

  async stopRun(runId: string): Promise<boolean> {
    const task = this.active.get(runId);
    if (task) task.cancelRequested = true;
    const stopped = await this.adapter.stopRun(runId);
    if (!stopped || !task) {
      if (task) task.cancelRequested = false;
      return stopped;
    }

    // Some adapters intentionally suppress their close-event terminal envelope
    // after an explicit stop. Route a synthetic terminal through the ordinary
    // listeners so checkpoint/event persistence finishes before locks release.
    if (!this.terminalWork.has(runId) && this.active.get(runId) === task) {
      this.handleEvent({
        runId,
        projectKey: task.options.projectKey,
        sessionKey: task.options.sessionKey,
        ...(task.options.projectId ? { projectId: task.options.projectId } : {}),
        projectPath: task.options.projectPath,
        taskId: task.options.taskId?.trim() || task.sessionLockKey,
        ...(task.options.workflowContext?.workflowId
          ? { workflowId: task.options.workflowContext.workflowId }
          : {}),
        event: {
          type: 'session_failed',
          error: '任务已由用户停止',
          timestamp: Date.now(),
        },
      });
    }
    const finalization = this.terminalWork.get(runId);
    if (finalization) await finalization;
    else await this.finalizeAndRelease(runId, 'cancelled');
    return stopped;
  }

  async stopAll(): Promise<void> {
    await this.adapter.stopAll();
    for (const task of [...this.active.values()]) {
      if (task.finishing) continue;
      task.cancelRequested = true;
      this.handleEvent(trustedEnvelope(task, {
        type: 'session_failed',
        error: 'Task was abandoned while Workbench stopped active runs.',
        timestamp: Date.now(),
      }));
    }
    await Promise.allSettled([...this.terminalWork.values()]);
    await Promise.allSettled(
      [...this.active.keys()].map((runId) => this.finalizeAndRelease(runId, 'cancelled')),
    );
    this.sessionLocks.clear();
  }

  /** Resolves only after a run and every registered terminal finalizer release its locks. */
  async waitForRunCompletion(runId: string): Promise<void> {
    if (!this.active.has(runId)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.completionWaiters.get(runId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.completionWaiters.set(runId, waiters);
      // Keep the check next to registration so future refactors cannot introduce
      // a lost wake-up between the fast path and waiter insertion.
      if (!this.active.has(runId)) {
        waiters.delete(resolve);
        if (waiters.size === 0) this.completionWaiters.delete(runId);
        resolve();
      }
    });
  }

  subscribe(listener: (envelope: ClaudeEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeStarts(listener: (options: ClaudeRunOptions) => void): () => void {
    this.startListeners.add(listener);
    return () => this.startListeners.delete(listener);
  }

  /** Runs asynchronous preflight work after project/session locks are held, but before spawning Claude. */
  subscribeBeforeRuns(listener: (options: ClaudeRunOptions) => Promise<void>): () => void {
    this.beforeRunListeners.add(listener);
    return () => this.beforeRunListeners.delete(listener);
  }

  /** Keeps project/session locks held until terminal persistence and checkpoints finish. */
  subscribeTerminalFinalizers(
    listener: (envelope: ClaudeEventEnvelope) => Promise<void>,
  ): () => void {
    this.terminalFinalizers.add(listener);
    return () => this.terminalFinalizers.delete(listener);
  }

  /**
   * Atomically excludes writable Claude runs for the complete restore/commit operation.
   * Read-only plan/review runs may continue because they cannot mutate the worktree.
   */
  async runProjectMutation<T>(
    projectPath: string,
    operation: () => Promise<T>,
    options: ProjectMutationOptions = {},
  ): Promise<T> {
    try {
      return await this.fileMutations.runMutation({
        mutationId: options.mutationId,
        kind: options.kind ?? 'git_restore',
        projectPath,
        projectId: options.projectId,
        taskId: options.taskId,
        sessionId: options.sessionId,
        runId: options.runId,
        filePaths: options.filePaths,
      }, {
        verify: options.verify ? async () => options.verify?.() : undefined,
        mutate: operation,
        record: options.record ? async () => options.record?.() : undefined,
        rollback: options.rollback
          ? async (_context, error) => options.rollback?.(error)
          : undefined,
      });
    } catch (error) {
      if (error instanceof FileMutationConflictError) {
        throw new TaskConflictError(
          'TASK_PROJECT_BUSY',
          error.conflictingMutationId,
          'The project already has a running task or file mutation.',
        );
      }
      throw error;
    }
  }

  getActiveTasks(): Array<{
    runId: string;
    taskId?: string;
    sessionKey: string;
    projectKey: string;
    projectPath: string;
    modelProviderId?: string;
    writable: boolean;
  }> {
    return [...this.active.entries()].map(([runId, task]) => ({
      runId,
      ...(task.options.taskId ? { taskId: task.options.taskId } : {}),
      sessionKey: task.options.sessionKey,
      projectKey: task.options.projectKey,
      projectPath: task.options.projectPath,
      ...(task.options.modelProviderId
        ? { modelProviderId: task.options.modelProviderId }
        : {}),
      writable: task.writable,
    }));
  }

  dispose(): void {
    this.unsubscribeAdapter();
    this.listeners.clear();
    this.beforeRunListeners.clear();
    this.startListeners.clear();
    this.terminalFinalizers.clear();
    for (const runId of [...this.active.keys()]) this.release(runId);
    this.sessionLocks.clear();
    this.terminalWork.clear();
  }

  private handleEvent(envelope: ClaudeEventEnvelope): void {
    const task = this.active.get(envelope.runId);
    if (!task) return;
    if (
      task.options.sessionKey !== envelope.sessionKey
      || task.options.projectKey !== envelope.projectKey
    ) return;
    const normalizedEnvelope = trustedEnvelope(task, envelope.event);

    const terminal = normalizedEnvelope.event.type === 'session_completed'
      || normalizedEnvelope.event.type === 'session_failed';
    if (terminal && task.finishing) return;

    for (const listener of this.listeners) {
      try {
        listener(normalizedEnvelope);
      } catch (error) {
        console.error('[TaskManager] event listener failed:', error);
      }
    }
    if (terminal) {
      task.finishing = true;
      let tracked: Promise<void>;
      tracked = Promise.resolve()
        .then(async () => {
          for (const finalizer of this.terminalFinalizers) {
            try {
              await finalizer(normalizedEnvelope);
            } catch (error) {
              console.error('[TaskManager] terminal finalizer failed:', error);
            }
          }
        });
      const completed = tracked
        .then(async () => {
          const latest = this.active.get(normalizedEnvelope.runId);
          await this.finalizeAndRelease(
            normalizedEnvelope.runId,
            latest?.cancelRequested
              ? 'cancelled'
              : normalizedEnvelope.event.type === 'session_completed' ? 'completed' : 'failed',
            normalizedEnvelope.event.type === 'session_failed'
              ? normalizedEnvelope.event.error
              : undefined,
          );
        })
        .finally(() => {
          if (this.terminalWork.get(normalizedEnvelope.runId) === completed) {
            this.terminalWork.delete(normalizedEnvelope.runId);
          }
        });
      this.terminalWork.set(normalizedEnvelope.runId, completed);
    }
  }

  private release(runId: string): void {
    const task = this.active.get(runId);
    if (task) {
      this.active.delete(runId);
      task.mutationLease?.release();
      if (this.sessionLocks.get(task.sessionLockKey) === runId) {
        this.sessionLocks.delete(task.sessionLockKey);
      }
    }
    const waiters = this.completionWaiters.get(runId);
    this.completionWaiters.delete(runId);
    for (const resolve of waiters ?? []) resolve();
  }

  private async finalizeAndRelease(
    runId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    error?: unknown,
  ): Promise<void> {
    const task = this.active.get(runId);
    if (!task) return;
    if (task.mutationLease) {
      try {
        await task.mutationLease.finalize(outcome, error);
      } catch (recordError) {
        console.error('[TaskManager] file mutation outcome could not be recorded:', recordError);
      }
    }
    this.release(runId);
  }
}

export const taskManagerInternals = { isWritableRun, projectLockKey, sessionLockKey };
