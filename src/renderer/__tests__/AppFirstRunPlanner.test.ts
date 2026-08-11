// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../shared/types/project';
import type { SessionSummary } from '../../shared/types/session';
import * as AppModule from '../App';
import { useWorkspaceStore, type SessionRuntime } from '../stores/workspaceStore';

const project: Project = {
  id: 'project-1',
  name: 'Fixture',
  path: 'C:\\Projects\\Fixture',
  createdAt: '2026-08-09T08:00:00.000Z',
  lastOpenedAt: '2026-08-09T08:00:00.000Z',
};

function session(
  id: string,
  source: SessionSummary['source'] = 'workbench',
): SessionSummary {
  return {
    id,
    projectId: project.id,
    projectPath: project.path,
    claudeSessionId: source === 'claude-code' ? id : null,
    title: 'New Task',
    titleSource: 'default',
    status: 'idle',
    model: null,
    permissionMode: null,
    createdAt: '2026-08-09T08:00:00.000Z',
    updatedAt: '2026-08-09T08:00:00.000Z',
    completedAt: null,
    messageCount: 0,
    source,
    archived: false,
    tags: [],
  };
}

interface SelectionSnapshot {
  currentProject: Project | null;
  currentSessionKey: string | null;
  currentRuntime: SessionRuntime | null;
  projectRequestId: string | null;
  selectionIncarnation: number;
  projectLoading: boolean;
  projectError: string | null;
}

interface SelectionDependencies {
  getSnapshot(): SelectionSnapshot;
  selectProject(project: Project): Promise<void>;
  waitForSettled(project: Project, selectionIncarnation: number): Promise<void>;
}

type FirstRunTaskSelection = 'reusable' | 'needs_new_task';

type RunAfterSettled = <T>(
  project: Project,
  dependencies: SelectionDependencies,
  action: (selection: FirstRunTaskSelection) => Promise<T>,
) => Promise<T>;

interface PrepareDependencies {
  getSnapshot(): SelectionSnapshot;
  createTask(project: Project): Promise<SessionSummary | null>;
  workflowAlreadyExists(taskId: string, projectId: string): boolean;
}

interface PreparedTask {
  sessionKey: string;
  runtime: SessionRuntime;
  selectionIncarnation: number;
}

type PrepareFirstRunTask = (
  project: Project,
  selection: FirstRunTaskSelection,
  dependencies: PrepareDependencies,
) => Promise<PreparedTask>;

function productionGate(): RunAfterSettled {
  const candidate = (AppModule as unknown as { runAfterSettledFirstRunProject?: RunAfterSettled })
    .runAfterSettledFirstRunProject;
  expect(candidate).toBeTypeOf('function');
  return candidate!;
}

function productionTaskPreparation(): PrepareFirstRunTask {
  const candidate = (AppModule as unknown as {
    prepareFirstRunPlannerTask?: PrepareFirstRunTask;
  }).prepareFirstRunPlannerTask;
  expect(candidate).toBeTypeOf('function');
  return candidate!;
}

function storeSnapshot(selectionIncarnation: number): SelectionSnapshot {
  const state = useWorkspaceStore.getState();
  return {
    currentProject: state.currentProject,
    currentSessionKey: state.currentSessionKey,
    currentRuntime: state.currentSessionKey ? state.runtimes[state.currentSessionKey] ?? null : null,
    projectRequestId: state.projectRequestId,
    selectionIncarnation,
    projectLoading: state.projectLoading,
    projectError: state.projectError,
  };
}

function beginSessionLoad(summary: SessionSummary, requestId = `load-${summary.id}`): string {
  const store = useWorkspaceStore.getState();
  store.beginProjectSelection(project, 'project-request-1');
  expect(store.commitProjectSessions(project, 'project-request-1', [summary])).toBe(true);
  return useWorkspaceStore.getState().beginSessionSelection(project, summary, requestId);
}

function settleSession(key: string, requestId: string): void {
  expect(useWorkspaceStore.getState().hydrateSession(key, requestId, [])).toBe(true);
}

function plannerWrites() {
  const createSession = vi.fn();
  const createTask = vi.fn();
  const createWorkflow = vi.fn();
  return {
    createSession,
    createTask,
    createWorkflow,
    action: vi.fn(async (_selection?: FirstRunTaskSelection) => {
      createSession();
      createTask();
      createWorkflow();
      return 'planned';
    }),
  };
}

beforeEach(() => useWorkspaceStore.getState().reset());

describe('App first-run Planner project and Session gate', () => {
  it('waits for the exact loading Session incarnation to hydrate before allowing writes', async () => {
    const key = beginSessionLoad(session('task-a'));
    const order: string[] = [];
    const waitForSettled = vi.fn(async () => {
      order.push('wait');
      settleSession(key, 'load-task-a');
    });
    const action = vi.fn(async (selection: FirstRunTaskSelection) => {
      expect(selection).toBe('reusable');
      order.push('action');
      return 'planned';
    });

    await expect(productionGate()(project, {
      getSnapshot: () => storeSnapshot(1),
      selectProject: vi.fn(async () => undefined),
      waitForSettled,
    }, action)).resolves.toBe('planned');

    expect(waitForSettled).toHaveBeenCalledWith(project, 1);
    expect(order).toEqual(['wait', 'action']);
  });

  it('rejects loading_history before any Session, Task, or Workflow write', async () => {
    beginSessionLoad(session('task-a'));
    const writes = plannerWrites();

    await expect(productionGate()(project, {
      getSnapshot: () => storeSnapshot(1),
      selectProject: vi.fn(async () => undefined),
      waitForSettled: vi.fn(async () => undefined),
    }, writes.action)).rejects.toThrow('FIRST_RUN_PROJECT_SELECTION');

    expect(writes.action).not.toHaveBeenCalled();
    expect(writes.createSession).not.toHaveBeenCalled();
    expect(writes.createTask).not.toHaveBeenCalled();
    expect(writes.createWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a current project error before any Session, Task, or Workflow write', async () => {
    const key = beginSessionLoad(session('task-a'));
    settleSession(key, 'load-task-a');
    useWorkspaceStore.setState({ projectError: 'project load failed' });
    const writes = plannerWrites();

    await expect(productionGate()(project, {
      getSnapshot: () => storeSnapshot(1),
      selectProject: vi.fn(async () => undefined),
      waitForSettled: vi.fn(async () => undefined),
    }, writes.action)).rejects.toThrow('FIRST_RUN_PROJECT_SELECTION');

    expect(writes.action).not.toHaveBeenCalled();
    expect(writes.createSession).not.toHaveBeenCalled();
    expect(writes.createTask).not.toHaveBeenCalled();
    expect(writes.createWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a settled project without a bound Session instead of waiting indefinitely', async () => {
    const store = useWorkspaceStore.getState();
    store.beginProjectSelection(project, 'project-request-1');
    expect(store.commitProjectSessions(project, 'project-request-1', [])).toBe(true);
    const writes = plannerWrites();
    const waitForSettled = vi.fn(async () => undefined);

    await expect(productionGate()(project, {
      getSnapshot: () => storeSnapshot(1),
      selectProject: vi.fn(async () => undefined),
      waitForSettled,
    }, writes.action)).rejects.toThrow('FIRST_RUN_PROJECT_SELECTION');

    expect(waitForSettled).not.toHaveBeenCalled();
    expect(writes.action).not.toHaveBeenCalled();
    expect(writes.createSession).not.toHaveBeenCalled();
    expect(writes.createTask).not.toHaveBeenCalled();
    expect(writes.createWorkflow).not.toHaveBeenCalled();
  });

  it('revalidates a failed requested-project selection before any write', async () => {
    let selectionIncarnation = 0;
    const writes = plannerWrites();
    const selectProject = vi.fn(async (selected: Project) => {
      useWorkspaceStore.getState().beginProjectSelection(selected, 'failed-project-request');
      selectionIncarnation = 1;
      useWorkspaceStore.getState().failProjectSelection(
        selected,
        'failed-project-request',
        'project load failed',
      );
    });

    await expect(productionGate()(project, {
      getSnapshot: () => storeSnapshot(selectionIncarnation),
      selectProject,
      waitForSettled: vi.fn(async () => undefined),
    }, writes.action)).rejects.toThrow('FIRST_RUN_PROJECT_SELECTION');

    expect(selectProject).toHaveBeenCalledOnce();
    expect(writes.action).not.toHaveBeenCalled();
    expect(writes.createSession).not.toHaveBeenCalled();
    expect(writes.createTask).not.toHaveBeenCalled();
    expect(writes.createWorkflow).not.toHaveBeenCalled();
  });

  it('rejects failed Claude history hydration before any Session, Task, or Workflow write', async () => {
    const key = beginSessionLoad(session('history-a', 'claude-code'));
    expect(useWorkspaceStore.getState().failSessionLoad(key, 'load-history-a', 'history failed')).toBe(true);
    const writes = plannerWrites();

    await expect(productionGate()(project, {
      getSnapshot: () => storeSnapshot(1),
      selectProject: vi.fn(async () => undefined),
      waitForSettled: vi.fn(async () => undefined),
    }, writes.action)).rejects.toThrow('FIRST_RUN_PROJECT_SELECTION');

    expect(writes.action).not.toHaveBeenCalled();
    expect(writes.createSession).not.toHaveBeenCalled();
    expect(writes.createTask).not.toHaveBeenCalled();
    expect(writes.createWorkflow).not.toHaveBeenCalled();
  });

  it('creates exactly one fresh Workbench task for a hydrated Claude history Session', async () => {
    const key = beginSessionLoad(session('history-a', 'claude-code'));
    settleSession(key, 'load-history-a');
    let selectionIncarnation = 1;
    const createTask = vi.fn(async () => {
      const created = session('task-fresh');
      useWorkspaceStore.getState().addSession(project, created, true);
      selectionIncarnation = 2;
      return created;
    });
    const persistPlanner = vi.fn();

    const prepared = await productionGate()(project, {
      getSnapshot: () => storeSnapshot(selectionIncarnation),
      selectProject: vi.fn(async () => undefined),
      waitForSettled: vi.fn(async () => undefined),
    }, async (selection) => {
      const result = await productionTaskPreparation()(project, selection, {
        getSnapshot: () => storeSnapshot(selectionIncarnation),
        createTask,
        workflowAlreadyExists: () => false,
      });
      persistPlanner();
      return result;
    });

    expect(prepared.runtime.summary).toMatchObject({
      id: 'task-fresh',
      source: 'workbench',
      status: 'idle',
    });
    expect(prepared.selectionIncarnation).toBe(2);
    expect(createTask).toHaveBeenCalledOnce();
    expect(persistPlanner).toHaveBeenCalledOnce();
  });

  it('creates exactly one fresh task for a legitimate persisted failed Workbench task', async () => {
    const failed = {
      ...session('task-failed'),
      status: 'failed' as const,
      error: 'prior task failed',
    };
    const key = beginSessionLoad(failed, 'load-task-failed');
    settleSession(key, 'load-task-failed');
    expect(useWorkspaceStore.getState().runtimes[key]).toMatchObject({
      hydrated: true,
      loadRequestId: null,
      error: null,
      summary: { status: 'failed', error: 'prior task failed' },
    });
    let selectionIncarnation = 1;
    const createTask = vi.fn(async () => {
      const created = session('task-retry');
      useWorkspaceStore.getState().addSession(project, created, true);
      selectionIncarnation = 2;
      return created;
    });

    const prepared = await productionGate()(project, {
      getSnapshot: () => storeSnapshot(selectionIncarnation),
      selectProject: vi.fn(async () => undefined),
      waitForSettled: vi.fn(async () => undefined),
    }, (selection) => productionTaskPreparation()(project, selection, {
      getSnapshot: () => storeSnapshot(selectionIncarnation),
      createTask,
      workflowAlreadyExists: () => false,
    }));

    expect(prepared.runtime.summary).toMatchObject({
      id: 'task-retry',
      source: 'workbench',
      status: 'idle',
    });
    expect(createTask).toHaveBeenCalledOnce();
  });

  it('rejects a created task that is not selected and performs no Planner persistence', async () => {
    const key = beginSessionLoad(session('history-a', 'claude-code'));
    settleSession(key, 'load-history-a');
    const persistPlanner = vi.fn();
    const operation = async () => {
      const prepared = await productionTaskPreparation()(project, 'needs_new_task', {
        getSnapshot: () => storeSnapshot(1),
        createTask: vi.fn(async () => session('task-unselected')),
        workflowAlreadyExists: () => false,
      });
      persistPlanner();
      return prepared;
    };

    await expect(operation()).rejects.toThrow('FIRST_RUN_TASK_IDENTITY');
    expect(useWorkspaceStore.getState().currentSessionKey).toBe(key);
    expect(persistPlanner).not.toHaveBeenCalled();
  });

  it('rejects a runtime whose bound project path is not the selected project', async () => {
    const key = beginSessionLoad(session('task-a'));
    settleSession(key, 'load-task-a');
    useWorkspaceStore.setState((state) => ({
      runtimes: {
        ...state.runtimes,
        [key]: { ...state.runtimes[key], projectPath: 'C:\\Projects\\Other' },
      },
    }));
    const writes = plannerWrites();

    await expect(productionGate()(project, {
      getSnapshot: () => storeSnapshot(1),
      selectProject: vi.fn(async () => undefined),
      waitForSettled: vi.fn(async () => undefined),
    }, writes.action)).rejects.toThrow('FIRST_RUN_PROJECT_SELECTION');

    expect(writes.action).not.toHaveBeenCalled();
    expect(writes.createSession).not.toHaveBeenCalled();
    expect(writes.createTask).not.toHaveBeenCalled();
    expect(writes.createWorkflow).not.toHaveBeenCalled();
  });

  it.each(['running', 'waiting_permission'] as const)(
    'rejects an active %s Workbench task before creating or persisting',
    async (status) => {
      const active = { ...session(`task-${status}`), status };
      const key = beginSessionLoad(active, `load-${status}`);
      settleSession(key, `load-${status}`);
      const writes = plannerWrites();

      await expect(productionGate()(project, {
        getSnapshot: () => storeSnapshot(1),
        selectProject: vi.fn(async () => undefined),
        waitForSettled: vi.fn(async () => undefined),
      }, writes.action)).rejects.toThrow('FIRST_RUN_PROJECT_SELECTION');

      expect(writes.action).not.toHaveBeenCalled();
      expect(writes.createSession).not.toHaveBeenCalled();
      expect(writes.createTask).not.toHaveBeenCalled();
      expect(writes.createWorkflow).not.toHaveBeenCalled();
    },
  );

  it('fails closed when a pending Session selection changes A -> B -> A', async () => {
    const summaryA = session('task-a');
    const summaryB = session('task-b');
    beginSessionLoad(summaryA, 'load-a-1');
    let selectionIncarnation = 1;
    const writes = plannerWrites();
    const waitForSettled = vi.fn(async () => {
      useWorkspaceStore.getState().beginSessionSelection(project, summaryB, 'load-b');
      selectionIncarnation = 2;
      useWorkspaceStore.getState().beginSessionSelection(project, summaryA, 'load-a-2');
      selectionIncarnation = 3;
      const key = useWorkspaceStore.getState().currentSessionKey!;
      settleSession(key, 'load-a-2');
    });

    await expect(productionGate()(project, {
      getSnapshot: () => storeSnapshot(selectionIncarnation),
      selectProject: vi.fn(async () => undefined),
      waitForSettled,
    }, writes.action)).rejects.toThrow('FIRST_RUN_PROJECT_SELECTION');

    expect(waitForSettled).toHaveBeenCalledWith(project, 1);
    expect(writes.action).not.toHaveBeenCalled();
    expect(writes.createSession).not.toHaveBeenCalled();
    expect(writes.createTask).not.toHaveBeenCalled();
    expect(writes.createWorkflow).not.toHaveBeenCalled();
  });

  it('allows an exact hydrated idle Workbench runtime', async () => {
    const key = beginSessionLoad(session('task-a'));
    settleSession(key, 'load-task-a');
    const action = vi.fn(async (selection: FirstRunTaskSelection) => {
      expect(selection).toBe('reusable');
      return 'planned';
    });

    await expect(productionGate()(project, {
      getSnapshot: () => storeSnapshot(1),
      selectProject: vi.fn(async () => undefined),
      waitForSettled: vi.fn(async () => undefined),
    }, action)).resolves.toBe('planned');

    expect(action).toHaveBeenCalledOnce();
  });
});
