import { describe, expect, it, vi } from 'vitest';
import type {
  ClaudeAdapter,
  ClaudeEventEnvelope,
  ClaudeRunOptions,
} from '../../../shared/types/claude';
import {
  FileMutationManager,
  type FileMutationEvent,
} from '../../file-mutations/FileMutationManager';
import { TaskConflictError, TaskManager } from '../TaskManager';

function options(patch: Partial<ClaudeRunOptions> = {}): ClaudeRunOptions {
  return {
    runId: 'run-1',
    projectId: 'project-a',
    taskId: 'task-1',
    projectKey: 'C:\\project-a',
    sessionKey: 'C:\\project-a::session-1',
    projectPath: 'C:\\project-a',
    prompt: 'test',
    permissionMode: 'default',
    ...patch,
  };
}

class AdapterStub implements ClaudeAdapter {
  listeners = new Set<(envelope: ClaudeEventEnvelope) => void>();
  runPrompt = vi.fn(async (value: ClaudeRunOptions) => ({ runId: value.runId, pid: 10 }));
  stopRun = vi.fn(async () => true);
  stopAll = vi.fn(async () => undefined);
  checkInstallation = vi.fn(async () => ({ installed: true, path: 'claude', version: '2.1.218' }));

  subscribe(listener: (envelope: ClaudeEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(envelope: ClaudeEventEnvelope): void {
    for (const listener of this.listeners) listener(envelope);
  }
}

function terminal(runOptions: ClaudeRunOptions): ClaudeEventEnvelope {
  return {
    runId: runOptions.runId,
    projectKey: runOptions.projectKey,
    sessionKey: runOptions.sessionKey,
    event: {
      type: 'session_completed',
      sessionId: 'claude-session',
      duration: 20,
      timestamp: Date.now(),
    },
  };
}

describe('TaskManager', () => {
  it('fails closed before spawning when bypassPermissions has no main-process authorizer', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);

    await expect(manager.runPrompt(options({ permissionMode: 'bypassPermissions' })))
      .rejects.toThrow(/bypass permissions.*authorization/i);
    expect(adapter.runPrompt).not.toHaveBeenCalled();
    expect(manager.getActiveTasks()).toEqual([]);
  });

  it('spawns an explicitly authorized bypass run exactly once', async () => {
    const adapter = new AdapterStub();
    const dangerousRunAuthorizer = {
      authorizeBypass: vi.fn(async () => undefined),
    };
    const manager = new TaskManager(adapter, { dangerousRunAuthorizer });
    const bypass = options({ permissionMode: 'bypassPermissions' });

    await expect(manager.runPrompt(bypass)).resolves.toEqual({ runId: bypass.runId, pid: 10 });
    expect(dangerousRunAuthorizer.authorizeBypass).toHaveBeenCalledOnce();
    expect(dangerousRunAuthorizer.authorizeBypass).toHaveBeenCalledWith({
      runId: bypass.runId,
      sessionKey: bypass.sessionKey,
      projectPath: bypass.projectPath,
    });
    expect(adapter.runPrompt).toHaveBeenCalledOnce();
  });

  it('does not spawn and releases every lock when bypass authorization is denied', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter, {
      dangerousRunAuthorizer: {
        authorizeBypass: vi.fn(async () => {
          throw new Error('user denied bypass');
        }),
      },
    });

    await expect(manager.runPrompt(options({ permissionMode: 'bypassPermissions' })))
      .rejects.toThrow('user denied bypass');
    expect(adapter.runPrompt).not.toHaveBeenCalled();
    expect(manager.getActiveTasks()).toEqual([]);
    await expect(manager.runPrompt(options({ runId: 'run-2' })))
      .resolves.toMatchObject({ runId: 'run-2' });
  });

  it('holds the project mutation lease while dangerous authorization is pending', async () => {
    const adapter = new AdapterStub();
    let allow!: () => void;
    const authorization = new Promise<void>((resolve) => { allow = resolve; });
    const dangerousRunAuthorizer = {
      authorizeBypass: vi.fn(() => authorization),
    };
    const manager = new TaskManager(adapter, { dangerousRunAuthorizer });
    const pending = manager.runPrompt(options({ permissionMode: 'bypassPermissions' }));
    await vi.waitFor(() => expect(dangerousRunAuthorizer.authorizeBypass).toHaveBeenCalledOnce());

    await expect(manager.runProjectMutation('C:\\project-a', async () => undefined))
      .rejects.toMatchObject({ code: 'TASK_PROJECT_BUSY' });
    expect(adapter.runPrompt).not.toHaveBeenCalled();

    allow();
    await expect(pending).resolves.toMatchObject({ runId: 'run-1' });
  });

  it('does not invoke the dangerous authorizer for ordinary permission modes', async () => {
    const dangerousRunAuthorizer = { authorizeBypass: vi.fn(async () => undefined) };
    const manager = new TaskManager(new AdapterStub(), { dangerousRunAuthorizer });

    await manager.runPrompt(options({ permissionMode: 'acceptEdits' }));
    expect(dangerousRunAuthorizer.authorizeBypass).not.toHaveBeenCalled();
  });

  it('records writable Claude mutation start and completion around terminal finalizers', async () => {
    const adapter = new AdapterStub();
    const events: FileMutationEvent[] = [];
    const manager = new TaskManager(adapter, {
      fileMutations: new FileMutationManager({
        recordEvent: (event) => { events.push(event); },
      }),
    });
    const run = options();
    let finishFinalizer!: () => void;
    const finalizer = new Promise<void>((resolve) => { finishFinalizer = resolve; });
    manager.subscribeTerminalFinalizers(async () => finalizer);

    await manager.runPrompt(run);
    expect(events.map((event) => event.status)).toEqual(['started']);
    adapter.emit(terminal(run));
    await vi.waitFor(() => expect(manager.getActiveTasks()).toHaveLength(1));
    expect(events.map((event) => event.status)).toEqual(['started']);
    finishFinalizer();
    await manager.waitForRunCompletion(run.runId);

    expect(events.map((event) => event.status)).toEqual(['started', 'completed']);
    expect(events[1]).toMatchObject({
      kind: 'claude_run',
      taskId: 'session-1',
      sessionId: 'session-1',
      runId: 'run-1',
    });
  });

  it('records a failed external mutation and releases its lease when spawn fails', async () => {
    const adapter = new AdapterStub();
    adapter.runPrompt.mockRejectedValueOnce(new Error('spawn failed'));
    const events: FileMutationEvent[] = [];
    const manager = new TaskManager(adapter, {
      fileMutations: new FileMutationManager({
        recordEvent: (event) => { events.push(event); },
      }),
    });

    await expect(manager.runPrompt(options())).rejects.toThrow('spawn failed');
    expect(events.map((event) => event.status)).toEqual(['started', 'failed']);
    expect(events[1].error).toBe('spawn failed');
    await expect(manager.runProjectMutation('C:\\project-a', async () => 'restored'))
      .resolves.toBe('restored');
  });

  it('records explicit stops as cancelled external mutations', async () => {
    const adapter = new AdapterStub();
    const events: FileMutationEvent[] = [];
    const manager = new TaskManager(adapter, {
      fileMutations: new FileMutationManager({
        recordEvent: (event) => { events.push(event); },
      }),
    });
    const run = options();

    await manager.runPrompt(run);
    await expect(manager.stopRun(run.runId)).resolves.toBe(true);

    expect(events.map((event) => event.status)).toEqual(['started', 'cancelled']);
    expect(manager.getActiveTasks()).toEqual([]);
  });

  it('gives explicit-stop finalizers the trusted standalone permission identity', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    const finalizer = vi.fn(async () => undefined);
    manager.subscribeTerminalFinalizers(finalizer);
    const run = options();

    await manager.runPrompt(run);
    await manager.stopRun(run.runId);

    expect(finalizer).toHaveBeenCalledOnce();
    expect(finalizer).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.runId,
      projectId: 'project-a',
      projectPath: 'C:\\project-a',
      taskId: 'task-1',
    }));
    expect(finalizer.mock.calls[0][0]).not.toHaveProperty('workflowId');
  });

  it('runs trusted standalone finalizers when all active runs are abandoned', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    const finalized: ClaudeEventEnvelope[] = [];
    manager.subscribeTerminalFinalizers(async (envelope) => { finalized.push(envelope); });
    const first = options({ permissionMode: 'plan' });
    const second = options({
      runId: 'run-2',
      projectId: 'project-b',
      taskId: 'task-2',
      projectKey: 'C:\\project-b',
      sessionKey: 'C:\\project-b::session-2',
      projectPath: 'C:\\project-b',
      permissionMode: 'plan',
    });

    await manager.runPrompt(first);
    await manager.runPrompt(second);
    await manager.stopAll();

    expect(finalized).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: 'project-a', taskId: 'task-1', projectPath: 'C:\\project-a' }),
      expect.objectContaining({ projectId: 'project-b', taskId: 'task-2', projectPath: 'C:\\project-b' }),
    ]));
    expect(manager.getActiveTasks()).toEqual([]);
  });

  it('overwrites adapter-supplied terminal identity before grant cleanup finalizers run', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    const finalizer = vi.fn(async () => undefined);
    manager.subscribeTerminalFinalizers(finalizer);
    const run = options();
    await manager.runPrompt(run);

    adapter.emit({
      ...terminal(run),
      projectId: 'victim-project',
      projectPath: 'C:\\victim-project',
      taskId: 'victim-task',
      workflowId: 'victim-workflow',
    });
    await manager.waitForRunCompletion(run.runId);

    expect(finalizer).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a',
      projectPath: 'C:\\project-a',
      taskId: 'task-1',
    }));
    expect(finalizer.mock.calls[0][0]).not.toHaveProperty('workflowId');
  });

  it('delegates installation checks', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    await expect(manager.checkInstallation()).resolves.toMatchObject({ installed: true });
  });

  it('registers an active task before delegating the spawn', async () => {
    const adapter = new AdapterStub();
    adapter.runPrompt.mockImplementation(async (value) => {
      expect(new TaskManagerProbe(manager).activeRunIds()).toEqual(['run-1']);
      return { runId: value.runId, pid: 10 };
    });
    const manager = new TaskManager(adapter);
    await manager.runPrompt(options());
    expect(manager.getActiveTasks()).toHaveLength(1);
  });

  it('exposes the trusted Provider identity while a task is active', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);

    await manager.runPrompt(options({ modelProviderId: 'provider-mimo' }));

    expect(manager.getActiveTasks()).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        taskId: 'task-1',
        modelProviderId: 'provider-mimo',
      }),
    ]);
  });

  it('holds project and session locks while asynchronous preflight work runs', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    let releasePreflight!: () => void;
    const preflight = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const beforeRun = vi.fn(() => preflight);
    manager.subscribeBeforeRuns(beforeRun);

    const firstRun = manager.runPrompt(options());
    await vi.waitFor(() => expect(beforeRun).toHaveBeenCalledOnce());
    expect(manager.getActiveTasks().map((task) => task.runId)).toEqual(['run-1']);
    expect(adapter.runPrompt).not.toHaveBeenCalled();
    await expect(manager.runPrompt(options({
      runId: 'run-2',
      sessionKey: 'C:\\project-a::session-2',
    }))).rejects.toMatchObject({ code: 'TASK_PROJECT_BUSY' });

    releasePreflight();
    await expect(firstRun).resolves.toMatchObject({ runId: 'run-1' });
    expect(adapter.runPrompt).toHaveBeenCalledOnce();
  });

  it('releases locks and skips the adapter when preflight fails', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    const unsubscribe = manager.subscribeBeforeRuns(vi.fn(async () => {
      throw new Error('checkpoint failed');
    }));

    await expect(manager.runPrompt(options())).rejects.toThrow('checkpoint failed');
    expect(adapter.runPrompt).not.toHaveBeenCalled();
    expect(manager.getActiveTasks()).toEqual([]);

    unsubscribe();
    await expect(manager.runPrompt(options({ runId: 'run-2' }))).resolves.toMatchObject({ runId: 'run-2' });
  });

  it('runs preflight listeners before synchronous start listeners', async () => {
    const manager = new TaskManager(new AdapterStub());
    const order: string[] = [];
    manager.subscribeBeforeRuns(async () => { order.push('checkpoint'); });
    manager.subscribeStarts(() => { order.push('record-start'); });
    await manager.runPrompt(options());
    expect(order).toEqual(['checkpoint', 'record-start']);
  });

  it('rejects a second run for the same session', async () => {
    const manager = new TaskManager(new AdapterStub());
    await manager.runPrompt(options());
    await expect(manager.runPrompt(options({ runId: 'run-2' }))).rejects.toMatchObject({
      code: 'TASK_SESSION_BUSY',
    });
  });

  it('locks a session by its registered id even when the renderer forges the key prefix', async () => {
    const manager = new TaskManager(new AdapterStub());
    await manager.runPrompt(options({ permissionMode: 'plan' }));
    await expect(manager.runPrompt(options({
      runId: 'run-2',
      sessionKey: 'C:\\forged-prefix::session-1',
      permissionMode: 'plan',
    }))).rejects.toMatchObject({ code: 'TASK_SESSION_BUSY' });
  });

  it('rejects a duplicate run id before it can replace active routing state', async () => {
    const manager = new TaskManager(new AdapterStub());
    await manager.runPrompt(options({ permissionMode: 'plan' }));
    await expect(manager.runPrompt(options({
      sessionKey: 'C:\\project-a::session-2',
      permissionMode: 'plan',
    }))).rejects.toMatchObject({ code: 'TASK_SESSION_BUSY', conflictingRunId: 'run-1' });
    expect(manager.getActiveTasks()).toHaveLength(1);
  });

  it('rejects two writable tasks in the same project', async () => {
    const manager = new TaskManager(new AdapterStub());
    await manager.runPrompt(options());
    await expect(manager.runPrompt(options({
      runId: 'run-2',
      sessionKey: 'C:\\project-a::session-2',
    }))).rejects.toBeInstanceOf(TaskConflictError);
  });

  it('locks writable tasks by canonical projectPath instead of a renderer-supplied projectKey', async () => {
    const manager = new TaskManager(new AdapterStub());
    await manager.runPrompt(options());
    await expect(manager.runPrompt(options({
      runId: 'run-2',
      projectKey: 'C:\\forged-project-key',
      sessionKey: 'C:\\forged-project-key::session-2',
    }))).rejects.toMatchObject({ code: 'TASK_PROJECT_BUSY' });
  });

  it('allows writable tasks in different projects', async () => {
    const manager = new TaskManager(new AdapterStub());
    await manager.runPrompt(options());
    await manager.runPrompt(options({
      runId: 'run-2',
      projectKey: 'C:\\project-b',
      projectPath: 'C:\\project-b',
      sessionKey: 'C:\\project-b::session-2',
    }));
    expect(manager.getActiveTasks()).toHaveLength(2);
  });

  it('allows two read-only plan tasks in one project', async () => {
    const manager = new TaskManager(new AdapterStub());
    await manager.runPrompt(options({ permissionMode: 'plan' }));
    await manager.runPrompt(options({
      runId: 'run-2',
      sessionKey: 'C:\\project-a::session-2',
      permissionMode: 'plan',
    }));
    expect(manager.getActiveTasks().every((task) => !task.writable)).toBe(true);
  });

  it('does not trust an agentMode label without the CLI plan permission boundary', async () => {
    const manager = new TaskManager(new AdapterStub());
    await manager.runPrompt(options({ agentMode: 'review', permissionMode: 'default' }));
    expect(manager.getActiveTasks()[0]?.writable).toBe(true);
  });

  it('does not run a read-only task while a writable task owns the project', async () => {
    const manager = new TaskManager(new AdapterStub());
    await manager.runPrompt(options());
    await expect(manager.runPrompt(options({
      runId: 'run-2',
      sessionKey: 'C:\\project-a::session-2',
      permissionMode: 'plan',
    }))).rejects.toMatchObject({ code: 'TASK_PROJECT_BUSY' });
  });

  it('releases locks after a terminal event', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    const first = options();
    await manager.runPrompt(first);
    adapter.emit(terminal(first));
    await vi.waitFor(() => expect(manager.getActiveTasks()).toEqual([]));
    await expect(manager.runPrompt(options({ runId: 'run-2' }))).resolves.toMatchObject({ runId: 'run-2' });
  });

  it('keeps project and session locks until asynchronous terminal finalizers finish', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    let releaseFinalizer!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFinalizer = resolve; });
    const finalizer = vi.fn(() => gate);
    manager.subscribeTerminalFinalizers(finalizer);
    const first = options();
    await manager.runPrompt(first);

    adapter.emit(terminal(first));
    await vi.waitFor(() => expect(finalizer).toHaveBeenCalledOnce());
    await expect(manager.runPrompt(options({ runId: 'run-2' })))
      .rejects.toMatchObject({ code: 'TASK_SESSION_BUSY' });

    releaseFinalizer();
    await vi.waitFor(() => expect(manager.getActiveTasks()).toEqual([]));
    await expect(manager.runPrompt(options({ runId: 'run-3' }))).resolves.toMatchObject({ runId: 'run-3' });
  });

  it('runs terminal finalization once when a duplicate terminal event arrives', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    let releaseFinalizer!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFinalizer = resolve; });
    const finalizer = vi.fn(() => gate);
    manager.subscribeTerminalFinalizers(finalizer);
    const first = options();
    await manager.runPrompt(first);

    adapter.emit(terminal(first));
    adapter.emit(terminal(first));
    await vi.waitFor(() => expect(finalizer).toHaveBeenCalledOnce());
    releaseFinalizer();
    await vi.waitFor(() => expect(manager.getActiveTasks()).toEqual([]));
  });

  it('releases locks after a terminal finalizer fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    manager.subscribeTerminalFinalizers(async () => { throw new Error('persistence failed'); });
    const first = options();
    await manager.runPrompt(first);
    adapter.emit(terminal(first));

    await vi.waitFor(() => expect(manager.getActiveTasks()).toEqual([]));
    expect(errorSpy).toHaveBeenCalledWith(
      '[TaskManager] terminal finalizer failed:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('holds an exclusive mutation lease against new writable runs in the same canonical project', async () => {
    const manager = new TaskManager(new AdapterStub());
    let releaseMutation!: () => void;
    let entered = false;
    const gate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutation = manager.runProjectMutation('C:\\project-a', async () => {
      entered = true;
      await gate;
      return 'restored';
    });
    await vi.waitFor(() => expect(entered).toBe(true));

    await expect(manager.runPrompt(options({ projectKey: 'forged' })))
      .rejects.toMatchObject({ code: 'TASK_PROJECT_BUSY' });
    await expect(manager.runPrompt(options({
      runId: 'run-other',
      projectKey: 'C:\\project-b',
      projectPath: 'C:\\project-b',
      sessionKey: 'C:\\project-b::session-other',
    }))).resolves.toMatchObject({ runId: 'run-other' });

    releaseMutation();
    await expect(mutation).resolves.toBe('restored');
  });

  it('blocks a project mutation while a writable run is active', async () => {
    const manager = new TaskManager(new AdapterStub());
    await manager.runPrompt(options());
    const operation = vi.fn(async () => undefined);

    await expect(manager.runProjectMutation('C:\\project-a\\.', operation))
      .rejects.toMatchObject({ code: 'TASK_PROJECT_BUSY', conflictingRunId: 'run-1' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('releases a project mutation lease when the operation throws', async () => {
    const manager = new TaskManager(new AdapterStub());
    await expect(manager.runProjectMutation('C:\\project-a', async () => {
      throw new Error('restore failed');
    })).rejects.toThrow('restore failed');

    await expect(manager.runPrompt(options())).resolves.toMatchObject({ runId: 'run-1' });
  });

  it('ignores an event whose project or session routing does not match', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    const first = options();
    await manager.runPrompt(first);
    adapter.emit({ ...terminal(first), sessionKey: 'C:\\project-a::wrong' });
    expect(manager.getActiveTasks()).toHaveLength(1);
  });

  it('releases locks when spawn fails', async () => {
    const adapter = new AdapterStub();
    adapter.runPrompt.mockRejectedValueOnce(new Error('spawn failed'));
    const manager = new TaskManager(adapter);
    await expect(manager.runPrompt(options())).rejects.toThrow('spawn failed');
    await expect(manager.runPrompt(options({ runId: 'run-2' }))).resolves.toBeTruthy();
  });

  it('releases only a successfully stopped run', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    await manager.runPrompt(options());
    await expect(manager.stopRun('run-1')).resolves.toBe(true);
    expect(manager.getActiveTasks()).toHaveLength(0);
  });

  it('routes an explicit stop through terminal listeners and waits for finalizers', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    const listener = vi.fn();
    manager.subscribe(listener);
    let releaseFinalizer!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFinalizer = resolve; });
    const finalizer = vi.fn(() => gate);
    manager.subscribeTerminalFinalizers(finalizer);
    await manager.runPrompt(options());

    const stop = manager.stopRun('run-1');
    await vi.waitFor(() => expect(finalizer).toHaveBeenCalledOnce());
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      event: expect.objectContaining({ type: 'session_failed', error: '任务已由用户停止' }),
    }));
    expect(manager.getActiveTasks()).toHaveLength(1);
    await expect(manager.runPrompt(options({ runId: 'run-2' })))
      .rejects.toMatchObject({ code: 'TASK_SESSION_BUSY' });

    releaseFinalizer();
    await expect(stop).resolves.toBe(true);
    expect(manager.getActiveTasks()).toEqual([]);
  });

  it('does not synthesize a duplicate terminal when the adapter emits one during stop', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    const listener = vi.fn();
    manager.subscribe(listener);
    const first = options();
    adapter.stopRun.mockImplementationOnce(async () => {
      adapter.emit(terminal(first));
      return true;
    });
    await manager.runPrompt(first);

    await expect(manager.stopRun(first.runId)).resolves.toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].event.type).toBe('session_completed');
  });

  it('waitForRunCompletion resolves immediately for an inactive run', async () => {
    const manager = new TaskManager(new AdapterStub());
    await expect(manager.waitForRunCompletion('missing-run')).resolves.toBeUndefined();
  });

  it('waitForRunCompletion stays pending until terminal finalizers release the run', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    let releaseFinalizer!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFinalizer = resolve; });
    manager.subscribeTerminalFinalizers(() => gate);
    const first = options();
    await manager.runPrompt(first);
    let completed = false;
    const waiting = manager.waitForRunCompletion(first.runId).then(() => { completed = true; });

    adapter.emit(terminal(first));
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(manager.getActiveTasks()).toHaveLength(1);

    releaseFinalizer();
    await waiting;
    expect(completed).toBe(true);
    expect(manager.getActiveTasks()).toEqual([]);
  });

  it('resolves every waiter registered for the same run', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    const first = options();
    await manager.runPrompt(first);
    const completed: number[] = [];
    const firstWaiter = manager.waitForRunCompletion(first.runId).then(() => completed.push(1));
    const secondWaiter = manager.waitForRunCompletion(first.runId).then(() => completed.push(2));

    adapter.emit(terminal(first));
    await Promise.all([firstWaiter, secondWaiter]);
    expect(completed.sort()).toEqual([1, 2]);
  });

  it('stopAll releases completion waiters for adapters without terminal envelopes', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    await manager.runPrompt(options());
    const waiting = manager.waitForRunCompletion('run-1');

    await manager.stopAll();
    await expect(waiting).resolves.toBeUndefined();
  });

  it('dispose releases completion waiters', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    await manager.runPrompt(options());
    const waiting = manager.waitForRunCompletion('run-1');

    manager.dispose();
    await expect(waiting).resolves.toBeUndefined();
  });

  it('keeps a run locked when the adapter did not stop it', async () => {
    const adapter = new AdapterStub();
    adapter.stopRun.mockResolvedValue(false);
    const manager = new TaskManager(adapter);
    await manager.runPrompt(options());
    await expect(manager.stopRun('run-1')).resolves.toBe(false);
    expect(manager.getActiveTasks()).toHaveLength(1);
  });

  it('forwards validated events to subscribers exactly once', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    const listener = vi.fn();
    manager.subscribe(listener);
    const first = options();
    await manager.runPrompt(first);
    adapter.emit(terminal(first));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops all tasks and disposes the adapter subscription', async () => {
    const adapter = new AdapterStub();
    const manager = new TaskManager(adapter);
    await manager.runPrompt(options());
    await manager.stopAll();
    expect(adapter.stopAll).toHaveBeenCalledOnce();
    expect(manager.getActiveTasks()).toEqual([]);
    manager.dispose();
    expect(adapter.listeners.size).toBe(0);
  });
});

class TaskManagerProbe {
  constructor(private readonly manager: TaskManager) {}
  activeRunIds(): string[] {
    return this.manager.getActiveTasks().map((task) => task.runId);
  }
}
