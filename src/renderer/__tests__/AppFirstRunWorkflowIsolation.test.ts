// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import * as AppModule from '../App';

interface PendingWorkflowIdentity {
  taskId: string;
  projectId: string;
  projectPath: string;
  selectionIncarnation: number;
}

interface IsolationToken extends PendingWorkflowIdentity {
  token: number;
}

interface IsolationContext {
  firstRunActive: boolean;
  activeIdentity: PendingWorkflowIdentity | null;
}

interface WorkflowIsolation {
  begin(identity: PendingWorkflowIdentity): IsolationToken;
  blocks(identity: { taskId: string | null; projectId: string | null }): boolean;
  commit(token: IsolationToken, adopt: () => boolean): boolean;
  reject(token: IsolationToken): void;
  releaseRejected(context: IsolationContext): boolean;
}

type WorkflowIsolationConstructor = new () => WorkflowIsolation;
type IsolatedRunner = <T>(
  isolation: WorkflowIsolation,
  identity: PendingWorkflowIdentity,
  run: () => Promise<T>,
  adopt: (value: T) => boolean,
  onBegin: () => void,
) => Promise<T>;

function productionIsolation(): WorkflowIsolation {
  const Candidate = (AppModule as unknown as {
    FirstRunWorkflowIsolation?: WorkflowIsolationConstructor;
  }).FirstRunWorkflowIsolation;
  expect(Candidate).toBeTypeOf('function');
  return new Candidate!();
}

function productionRunner(): IsolatedRunner {
  const candidate = (AppModule as unknown as {
    runIsolatedFirstRunWorkflow?: IsolatedRunner;
  }).runIsolatedFirstRunWorkflow;
  expect(candidate).toBeTypeOf('function');
  return candidate!;
}

const pendingIdentity: PendingWorkflowIdentity = {
  taskId: 'task-a',
  projectId: 'project-a',
  projectPath: 'C:\\Projects\\A',
  selectionIncarnation: 7,
};

function connectedWorkflowHarness(isolation: WorkflowIsolation) {
  let revision = 0;
  let currentWorkflowId: string | null = 'workflow-before';
  const getWorkflowByTask = vi.fn((workflowId: string) => {
    currentWorkflowId = workflowId;
  });
  const adopt = vi.fn((workflowId: string) => {
    currentWorkflowId = workflowId;
    return true;
  });
  const notify = (workflowId: string, identity = pendingIdentity) => {
    if (isolation.blocks(identity)) return;
    revision += 1;
    getWorkflowByTask(workflowId);
  };
  const lookup = (workflowId: string, identity = pendingIdentity) => {
    if (isolation.blocks(identity)) return;
    getWorkflowByTask(workflowId);
  };
  return {
    adopt,
    getWorkflowByTask,
    get revision() { return revision; },
    get currentWorkflowId() { return currentWorkflowId; },
    notify,
    lookup,
  };
}

describe('App first-run Workflow isolation', () => {
  it.each(['invalid final response', 'planning rejection'])(
    'quarantines late event/revision/lookup adoption after %s',
    async () => {
      const isolation = productionIsolation();
      const app = connectedWorkflowHarness(isolation);

      await expect(productionRunner()(
        isolation,
        pendingIdentity,
        async () => {
          app.notify('workflow-created');
          app.lookup('workflow-planning');
          throw new Error('rejected final');
        },
        app.adopt,
        vi.fn(),
      )).rejects.toThrow('rejected final');

      expect(app.currentWorkflowId).toBe('workflow-before');
      expect(app.revision).toBe(0);
      expect(app.adopt).not.toHaveBeenCalled();
      expect(app.getWorkflowByTask).not.toHaveBeenCalled();
      expect(isolation.blocks(pendingIdentity)).toBe(true);
      expect(isolation.releaseRejected({
        firstRunActive: true,
        activeIdentity: pendingIdentity,
      })).toBe(false);

      app.notify('workflow-late-notification');
      app.lookup('workflow-late-settlement');

      expect(app.currentWorkflowId).toBe('workflow-before');
      expect(app.revision).toBe(0);
      expect(app.getWorkflowByTask).not.toHaveBeenCalled();
    },
  );

  it('releases rejected quarantine after the captured identity is no longer active', async () => {
    const isolation = productionIsolation();
    const app = connectedWorkflowHarness(isolation);
    await expect(productionRunner()(
      isolation,
      pendingIdentity,
      async () => { throw new Error('rejected final'); },
      app.adopt,
      vi.fn(),
    )).rejects.toThrow('rejected final');

    expect(isolation.releaseRejected({
      firstRunActive: true,
      activeIdentity: { ...pendingIdentity, selectionIncarnation: 8 },
    })).toBe(true);
    app.lookup('workflow-after-identity-change');

    expect(app.currentWorkflowId).toBe('workflow-after-identity-change');
    expect(app.getWorkflowByTask).toHaveBeenCalledOnce();
  });

  it('releases rejected quarantine when the explicit first-run gate ends', async () => {
    const isolation = productionIsolation();
    const app = connectedWorkflowHarness(isolation);
    await expect(productionRunner()(
      isolation,
      pendingIdentity,
      async () => { throw new Error('rejected final'); },
      app.adopt,
      vi.fn(),
    )).rejects.toThrow('rejected final');

    expect(isolation.releaseRejected({
      firstRunActive: false,
      activeIdentity: pendingIdentity,
    })).toBe(true);
    app.lookup('workflow-after-first-run');

    expect(app.currentWorkflowId).toBe('workflow-after-first-run');
    expect(app.getWorkflowByTask).toHaveBeenCalledOnce();
  });

  it('releases only the exact pending operation and adopts the validated final Workflow once', async () => {
    const isolation = productionIsolation();
    const app = connectedWorkflowHarness(isolation);

    await expect(productionRunner()(
      isolation,
      pendingIdentity,
      async () => {
        app.notify('workflow-created');
        app.notify('workflow-planning');
        return 'workflow-final';
      },
      app.adopt,
      vi.fn(),
    )).resolves.toBe('workflow-final');

    expect(app.currentWorkflowId).toBe('workflow-final');
    expect(app.revision).toBe(0);
    expect(app.adopt).toHaveBeenCalledOnce();
    expect(app.adopt).toHaveBeenCalledWith('workflow-final');
    expect(app.getWorkflowByTask).not.toHaveBeenCalled();
  });

  it('does not suppress ordinary Workflow notifications', () => {
    const isolation = productionIsolation();
    isolation.begin(pendingIdentity);
    const app = connectedWorkflowHarness(isolation);

    app.notify('workflow-other', {
      ...pendingIdentity,
      taskId: 'task-other',
    });

    expect(app.currentWorkflowId).toBe('workflow-other');
    expect(app.revision).toBe(1);
    expect(app.getWorkflowByTask).toHaveBeenCalledOnce();
  });

  it('does not let a stale operation commit or reject a newer pending incarnation', () => {
    const isolation = productionIsolation();
    const first = isolation.begin(pendingIdentity);
    isolation.reject(first);
    const second = isolation.begin({ ...pendingIdentity, selectionIncarnation: 8 });
    const staleAdopt = vi.fn(() => true);

    expect(isolation.commit(first, staleAdopt)).toBe(false);
    isolation.reject(first);
    expect(staleAdopt).not.toHaveBeenCalled();
    expect(isolation.blocks(pendingIdentity)).toBe(true);
    expect(isolation.commit(second, () => true)).toBe(true);
    expect(isolation.blocks(pendingIdentity)).toBe(false);
  });

  it('quarantines when final adoption is rejected instead of releasing first', async () => {
    const isolation = productionIsolation();

    await expect(productionRunner()(
      isolation,
      pendingIdentity,
      async () => 'workflow-final',
      () => false,
      vi.fn(),
    )).rejects.toThrow('FIRST_RUN_WORKFLOW_IDENTITY');

    expect(isolation.blocks(pendingIdentity)).toBe(true);
  });
});
