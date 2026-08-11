import type { IpcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitPreview } from '../../../shared/types/git';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import type {
  ExecutionPlan,
  ReviewReport,
  Workflow,
  WorkflowPage,
  WorkflowStageRecord,
} from '../../../shared/types/workflow';
import { ModelSelectionFailure } from '../../model-providers/ModelSelectionResolver';

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
}));

import { registerWorkflowIPC } from '../workflows';
import { publicIpcMainForTest } from './public-invoke-test-helper';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const PROJECT_ID = 'project-alpha';
const OTHER_PROJECT_ID = 'project-beta';
const TASK_ID = 'task-alpha';
const OTHER_TASK_ID = 'task-beta';
const MISMATCH_TASK_ID = 'task-mismatch';
const ORPHAN_TASK_ID = 'task-orphan';
const WORKFLOW_ID = 'workflow-alpha';
const PROJECT_PATH = 'C:\\Projects\\Alpha';
const PROJECT_KEY = 'c:/projects/alpha';
const NOW = '2026-08-01T12:00:00.000Z';

const PLAN: ExecutionPlan = {
  title: 'Implement workflow IPC',
  summary: 'Route the workflow lifecycle through validated main-process handlers.',
  steps: [{
    id: 0,
    title: 'Add handlers',
    risk: 'medium',
    description: 'Register and validate the workflow IPC surface.',
    status: 'pending',
    acceptanceCriteria: ['Every channel is covered'],
  }],
  filesExpected: ['src/main/ipc/workflows.ts'],
  estimatedChanges: 'One focused IPC module',
  riskLevel: 'medium',
  constraints: ['Do not trust renderer identity'],
};

const REVIEW: ReviewReport = {
  round: 2,
  score: 8,
  summary: 'The workflow is ready after one focused correction.',
  issues: [{
    severity: 'high',
    file: 'src/main/ipc/workflows.ts',
    line: 42,
    title: 'Validate renderer identity',
    recommendation: 'Resolve project and session identity from the database.',
    resolved: false,
  }],
  tests: { passed: 41, failed: 0, skipped: 1 },
};

const WORKFLOW: Workflow = {
  id: WORKFLOW_ID,
  taskId: TASK_ID,
  projectId: PROJECT_ID,
  projectPath: PROJECT_PATH,
  prompt: 'Build the workflow feature',
  status: 'waiting_plan_confirmation',
  currentStage: null,
  modelPolicy: {},
  plan: PLAN,
  latestReview: REVIEW,
  reviewRound: 2,
  maxReviewRounds: 3,
  fixRound: 1,
  maxFixRounds: 3,
  revision: 7,
  pausedFrom: null,
  failure: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const STAGE: WorkflowStageRecord = {
  id: 'stage-alpha',
  workflowId: WORKFLOW_ID,
  stage: 'planner',
  round: 0,
  status: 'completed',
  inputJson: '{}',
  outputJson: JSON.stringify(PLAN),
  error: null,
  startedAt: NOW,
  completedAt: NOW,
};

const WORKFLOW_PAGE: WorkflowPage<Workflow> = {
  items: [WORKFLOW],
  total: 1,
  limit: 25,
  offset: 0,
};

const STAGE_PAGE: WorkflowPage<WorkflowStageRecord> = {
  items: [STAGE],
  total: 1,
  limit: 50,
  offset: 0,
};

const COMMIT_PREVIEW: CommitPreview = {
  subject: 'feat(workflow): add IPC lifecycle',
  files: ['src/main/ipc/workflows.ts'],
  message: 'feat(workflow): add IPC lifecycle\n\nWorkflow details',
};

const WORKFLOW_INVOKE_CHANNELS = [
  IPC_CHANNELS.WORKFLOW_CREATE,
  IPC_CHANNELS.WORKFLOW_GET,
  IPC_CHANNELS.WORKFLOW_GET_BY_TASK,
  IPC_CHANNELS.WORKFLOW_LIST_PAGE,
  IPC_CHANNELS.WORKFLOW_LIST_STAGES,
  IPC_CHANNELS.WORKFLOW_GET_REVIEW,
  IPC_CHANNELS.WORKFLOW_START_PLANNING,
  IPC_CHANNELS.WORKFLOW_UPDATE_PLAN,
  IPC_CHANNELS.WORKFLOW_START_EXECUTION,
  IPC_CHANNELS.WORKFLOW_PAUSE,
  IPC_CHANNELS.WORKFLOW_RESUME,
  IPC_CHANNELS.WORKFLOW_CANCEL,
  IPC_CHANNELS.WORKFLOW_ACCEPT_REVIEW,
  IPC_CHANNELS.WORKFLOW_EXPORT_REVIEW,
  IPC_CHANNELS.WORKFLOW_COMMIT_PREVIEW,
] as const;

interface HarnessOptions {
  existingWorkflow?: { id: string; prompt: string } | null;
  managedWorkflow?: Workflow | null;
  publicWorkflow?: Workflow | null;
  review?: ReviewReport | null;
  saveResult?: string | null;
  publicTransport?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  } as unknown as IpcMain;

  const database = {
    getSession: vi.fn((id: string) => {
      if (id === TASK_ID) {
        return {
          id: TASK_ID,
          project_id: PROJECT_ID,
          claude_session_id: 'claude-session-alpha',
          model: 'database-model',
        };
      }
      if (id === OTHER_TASK_ID) {
        return {
          id: OTHER_TASK_ID,
          project_id: OTHER_PROJECT_ID,
          claude_session_id: null,
          model: null,
        };
      }
      if (id === MISMATCH_TASK_ID) {
        return {
          id: MISMATCH_TASK_ID,
          project_id: PROJECT_ID,
          claude_session_id: null,
          model: null,
        };
      }
      if (id === ORPHAN_TASK_ID) {
        return {
          id: ORPHAN_TASK_ID,
          project_id: 'missing-project',
          claude_session_id: null,
          model: null,
        };
      }
      return null;
    }),
    getTask: vi.fn((id: string) => {
      if (id === TASK_ID) return { id: TASK_ID, project_id: PROJECT_ID };
      if (id === OTHER_TASK_ID) return { id: OTHER_TASK_ID, project_id: OTHER_PROJECT_ID };
      if (id === MISMATCH_TASK_ID) {
        return { id: MISMATCH_TASK_ID, project_id: OTHER_PROJECT_ID };
      }
      if (id === ORPHAN_TASK_ID) {
        return { id: ORPHAN_TASK_ID, project_id: 'missing-project' };
      }
      return null;
    }),
    getProject: vi.fn((id: string) => {
      if (id === PROJECT_ID) return { id: PROJECT_ID, path: PROJECT_PATH };
      if (id === OTHER_PROJECT_ID) {
        return { id: OTHER_PROJECT_ID, path: 'C:\\Projects\\Beta' };
      }
      return null;
    }),
  };

  const managedWorkflow = options.managedWorkflow === undefined
    ? WORKFLOW
    : options.managedWorkflow;
  const publicWorkflow = options.publicWorkflow === undefined
    ? WORKFLOW
    : options.publicWorkflow;
  const review = options.review === undefined ? REVIEW : options.review;
  const persistence = {
    getByTask: vi.fn((taskId: string) => (
      taskId === TASK_ID ? options.existingWorkflow ?? null : null
    )),
    getPublic: vi.fn(() => publicWorkflow),
    listPage: vi.fn(() => WORKFLOW_PAGE),
    listStagePage: vi.fn(() => STAGE_PAGE),
    getReview: vi.fn(() => review),
  };
  const manager = {
    createWorkflow: vi.fn(async () => WORKFLOW),
    getWorkflow: vi.fn(async () => managedWorkflow),
    startPlanning: vi.fn(async () => WORKFLOW),
    updatePlan: vi.fn(async () => WORKFLOW),
    startExecution: vi.fn(async () => WORKFLOW),
    pause: vi.fn(async () => WORKFLOW),
    resume: vi.fn(async () => WORKFLOW),
    cancel: vi.fn(async () => WORKFLOW),
    acceptReview: vi.fn(async () => WORKFLOW),
  };
  const infrastructure = {
    persistence,
    createCommitPreview: vi.fn(async () => COMMIT_PREVIEW),
  };
  const saveReview = vi.fn(async () => (
    options.saveResult === undefined ? 'C:\\Exports\\review.md' : options.saveResult
  ));

  const cleanup = registerWorkflowIPC(
    options.publicTransport ? publicIpcMainForTest(ipcMain) : ipcMain,
    {
    database: database as never,
    manager: manager as never,
    infrastructure: infrastructure as never,
    saveReview,
    },
  );

  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC handler for ${channel}`);
    return await handler({}, ...args) as T;
  };

  return {
    cleanup,
    database,
    handlers,
    infrastructure,
    invoke,
    ipcMain,
    manager,
    persistence,
    saveReview,
  };
}

function createRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    prompt: WORKFLOW.prompt,
    currentPermissionMode: 'default',
    ...overrides,
  };
}

describe('registerWorkflowIPC registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers every workflow invoke handler exactly once', () => {
    const harness = createHarness();

    expect([...harness.handlers.keys()]).toEqual(WORKFLOW_INVOKE_CHANNELS);
    expect(harness.ipcMain.handle).toHaveBeenCalledTimes(15);
    expect(harness.handlers.has(IPC_CHANNELS.WORKFLOW_CHANGED)).toBe(false);
  });

  it('removes every workflow invoke handler during cleanup', () => {
    const harness = createHarness();

    harness.cleanup();

    expect(harness.ipcMain.removeHandler).toHaveBeenCalledTimes(15);
    for (const channel of WORKFLOW_INVOKE_CHANNELS) {
      expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith(channel);
    }
    expect(harness.handlers).toHaveLength(0);
  });
});

describe('workflow create identity and idempotency', () => {
  it('returns a fixed disabled-provider envelope without persisting a workflow', async () => {
    const harness = createHarness({ publicTransport: true });
    harness.manager.createWorkflow.mockRejectedValueOnce(new ModelSelectionFailure(
      'PROVIDER_DISABLED',
      'private C:\\Users\\Profile Provider is disabled.',
    ));

    const result = await harness.invoke(IPC_CHANNELS.WORKFLOW_CREATE, createRequest())
      .catch(() => ({ transportRejected: true }));
    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: 'PROVIDER_DISABLED', message: 'Provider is disabled.' },
    });
    expect(JSON.stringify(result)).not.toContain('Users');
    expect(harness.persistence.getByTask).toHaveBeenCalledTimes(1);
  });

  it('derives project, session, model, and resume identity from the database', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_CREATE,
      createRequest(),
    )).resolves.toBe(WORKFLOW);

    expect(harness.database.getSession).toHaveBeenCalledWith(TASK_ID);
    expect(harness.database.getTask).toHaveBeenCalledWith(TASK_ID);
    expect(harness.database.getProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(harness.manager.createWorkflow).toHaveBeenCalledWith({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      projectKey: PROJECT_KEY,
      sessionKey: `${PROJECT_KEY}::${TASK_ID}`,
      resumeSessionId: 'claude-session-alpha',
      prompt: WORKFLOW.prompt,
      currentModel: 'database-model',
      currentPermissionMode: 'default',
      modelPolicy: undefined,
    });
  });

  it('forwards a validated model override and model policy', async () => {
    const harness = createHarness();
    const modelPolicy = {
      plannerModel: 'planner-model',
      coderModel: 'coder-model',
      testerModel: 'tester-model',
      reviewerModel: 'reviewer-model',
      fixerModel: 'fixer-model',
    };

    await harness.invoke(IPC_CHANNELS.WORKFLOW_CREATE, createRequest({
      currentModel: 'selected-model',
      currentPermissionMode: 'acceptEdits',
      modelPolicy,
    }));

    expect(harness.manager.createWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      currentModel: 'selected-model',
      currentPermissionMode: 'acceptEdits',
      modelPolicy,
    }));
  });

  it('trims create strings before routing to the manager', async () => {
    const harness = createHarness();

    await harness.invoke(IPC_CHANNELS.WORKFLOW_CREATE, createRequest({
      taskId: `  ${TASK_ID}  `,
      prompt: `  ${WORKFLOW.prompt}  `,
      currentModel: '  selected-model  ',
      modelPolicy: { plannerModel: '  planner-model  ' },
    }));

    expect(harness.manager.createWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      taskId: TASK_ID,
      prompt: WORKFLOW.prompt,
      currentModel: 'selected-model',
      modelPolicy: { plannerModel: 'planner-model' },
    }));
  });

  it.each([
    ['projectId', OTHER_PROJECT_ID],
    ['projectPath', 'C:\\Renderer\\Escape'],
    ['projectKey', 'renderer-key'],
    ['sessionKey', 'renderer::session'],
    ['resumeSessionId', 'renderer-claude-session'],
  ])('strictly rejects renderer-supplied %s identity', async (field, value) => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_CREATE,
      createRequest({ [field]: value }),
    )).rejects.toThrow();
    expect(harness.manager.createWorkflow).not.toHaveBeenCalled();
  });

  it('rejects renderer requests for bypassPermissions mode', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_CREATE,
      createRequest({ currentPermissionMode: 'bypassPermissions' }),
    )).rejects.toThrow();
    expect(harness.manager.createWorkflow).not.toHaveBeenCalled();
  });

  it('returns the existing workflow idempotently for the same task and prompt', async () => {
    const harness = createHarness({
      existingWorkflow: { id: WORKFLOW_ID, prompt: WORKFLOW.prompt },
    });

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_CREATE,
      createRequest(),
    )).resolves.toBe(WORKFLOW);
    expect(harness.manager.getWorkflow).toHaveBeenCalledWith(WORKFLOW_ID);
    expect(harness.manager.createWorkflow).not.toHaveBeenCalled();
  });

  it('rejects reusing a task with a different workflow prompt', async () => {
    const harness = createHarness({
      existingWorkflow: { id: WORKFLOW_ID, prompt: 'A different prompt' },
    });

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_CREATE,
      createRequest(),
    )).rejects.toThrow('This task already owns a different workflow');
    expect(harness.manager.getWorkflow).not.toHaveBeenCalled();
    expect(harness.manager.createWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an idempotent create when manager state is inconsistent', async () => {
    const harness = createHarness({
      existingWorkflow: { id: WORKFLOW_ID, prompt: WORKFLOW.prompt },
      managedWorkflow: null,
    });

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_CREATE,
      createRequest(),
    )).rejects.toThrow('Workflow persistence is inconsistent.');
  });

  it.each([
    ['missing-task', 'missing task'],
    [MISMATCH_TASK_ID, 'session/task project mismatch'],
    [ORPHAN_TASK_ID, 'missing project'],
  ])('rejects create for %s (%s)', async (taskId) => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_CREATE,
      createRequest({ taskId }),
    )).rejects.toThrow('Workflow task is not registered in Workbench.');
    expect(harness.manager.createWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '   ',
    'prompt\0escape',
    'x'.repeat(200_001),
  ])('rejects an invalid workflow prompt %#', async (prompt) => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_CREATE,
      createRequest({ prompt }),
    )).rejects.toThrow();
    expect(harness.manager.createWorkflow).not.toHaveBeenCalled();
  });

  it('accepts the maximum prompt length', async () => {
    const harness = createHarness();
    const prompt = 'x'.repeat(200_000);

    await harness.invoke(IPC_CHANNELS.WORKFLOW_CREATE, createRequest({ prompt }));

    expect(harness.manager.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ prompt }),
    );
  });

  it('rejects a model name beyond its limit', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_CREATE,
      createRequest({ currentModel: 'm'.repeat(501) }),
    )).rejects.toThrow();
    expect(harness.manager.createWorkflow).not.toHaveBeenCalled();
  });
});

describe('workflow lookup and lazy pages', () => {
  it('routes workflow get with a trimmed id', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_GET,
      `  ${WORKFLOW_ID}  `,
    )).resolves.toBe(WORKFLOW);
    expect(harness.manager.getWorkflow).toHaveBeenCalledWith(WORKFLOW_ID);
  });

  it('accepts the maximum workflow id length', async () => {
    const harness = createHarness();
    const id = 'w'.repeat(512);

    await harness.invoke(IPC_CHANNELS.WORKFLOW_GET, id);

    expect(harness.manager.getWorkflow).toHaveBeenCalledWith(id);
  });

  it.each([
    '',
    '   ',
    'workflow\0escape',
    'w'.repeat(513),
    42,
  ])('rejects invalid workflow id input %#', async (id) => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_GET,
      id,
    )).rejects.toThrow();
    expect(harness.manager.getWorkflow).not.toHaveBeenCalled();
  });

  it('returns the persisted workflow for a registered task', async () => {
    const harness = createHarness({
      existingWorkflow: { id: WORKFLOW_ID, prompt: WORKFLOW.prompt },
    });

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_GET_BY_TASK,
      TASK_ID,
    )).resolves.toBe(WORKFLOW);
    expect(harness.manager.getWorkflow).toHaveBeenCalledWith(WORKFLOW_ID);
  });

  it('returns null when a registered task has no workflow', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_GET_BY_TASK,
      TASK_ID,
    )).resolves.toBeNull();
    expect(harness.manager.getWorkflow).not.toHaveBeenCalled();
  });

  it('rejects get-by-task before persistence access when task identity is unknown', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_GET_BY_TASK,
      'missing-task',
    )).rejects.toThrow('Workflow task is not registered in Workbench.');
    expect(harness.persistence.getByTask).not.toHaveBeenCalled();
  });

  it('routes a validated workflow summary page without eager stage or review loads', async () => {
    const harness = createHarness();
    const request = { projectId: PROJECT_ID, taskId: TASK_ID, limit: 25, offset: 0 };

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_LIST_PAGE,
      request,
    )).resolves.toBe(WORKFLOW_PAGE);
    expect(harness.persistence.listPage).toHaveBeenCalledWith(request);
    expect(harness.persistence.listStagePage).not.toHaveBeenCalled();
    expect(harness.persistence.getReview).not.toHaveBeenCalled();
    expect(harness.manager.getWorkflow).not.toHaveBeenCalled();
  });

  it('accepts page boundary values', async () => {
    const harness = createHarness();
    const request = {
      projectId: PROJECT_ID,
      limit: 100,
      offset: Number.MAX_SAFE_INTEGER,
    };

    await harness.invoke(IPC_CHANNELS.WORKFLOW_LIST_PAGE, request);

    expect(harness.persistence.listPage).toHaveBeenCalledWith(request);
  });

  it('rejects listing an unknown project', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_LIST_PAGE,
      { projectId: 'missing-project' },
    )).rejects.toThrow('Workflow project was not found.');
    expect(harness.persistence.listPage).not.toHaveBeenCalled();
  });

  it('rejects a task filter belonging to another project', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_LIST_PAGE,
      { projectId: PROJECT_ID, taskId: OTHER_TASK_ID },
    )).rejects.toThrow('Workflow task belongs to another project.');
    expect(harness.persistence.listPage).not.toHaveBeenCalled();
  });

  it.each([0, 101, 1.5])('rejects invalid page limit %s', async (limit) => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_LIST_PAGE,
      { projectId: PROJECT_ID, limit },
    )).rejects.toThrow();
    expect(harness.persistence.listPage).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid page offset %s',
    async (offset) => {
      const harness = createHarness();

      await expect(harness.invoke(
        IPC_CHANNELS.WORKFLOW_LIST_PAGE,
        { projectId: PROJECT_ID, offset },
      )).rejects.toThrow();
      expect(harness.persistence.listPage).not.toHaveBeenCalled();
    },
  );

  it('strictly rejects extra workflow page fields', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_LIST_PAGE,
      { projectId: PROJECT_ID, status: 'completed' },
    )).rejects.toThrow();
    expect(harness.persistence.listPage).not.toHaveBeenCalled();
  });

  it('loads stage history lazily with default pagination', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_LIST_STAGES,
      WORKFLOW_ID,
    )).resolves.toBe(STAGE_PAGE);
    expect(harness.persistence.getPublic).toHaveBeenCalledWith(WORKFLOW_ID);
    expect(harness.persistence.listStagePage).toHaveBeenCalledWith(WORKFLOW_ID, {});
  });

  it('forwards validated stage pagination', async () => {
    const harness = createHarness();

    await harness.invoke(
      IPC_CHANNELS.WORKFLOW_LIST_STAGES,
      WORKFLOW_ID,
      { limit: 1, offset: 7 },
    );

    expect(harness.persistence.listStagePage).toHaveBeenCalledWith(
      WORKFLOW_ID,
      { limit: 1, offset: 7 },
    );
  });

  it('rejects stage history for a missing workflow', async () => {
    const harness = createHarness({ publicWorkflow: null });

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_LIST_STAGES,
      WORKFLOW_ID,
    )).rejects.toThrow('Workflow was not found.');
    expect(harness.persistence.listStagePage).not.toHaveBeenCalled();
  });

  it('rejects invalid stage page input', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_LIST_STAGES,
      WORKFLOW_ID,
      { limit: 100, offset: 0, extra: true },
    )).rejects.toThrow();
    expect(harness.persistence.listStagePage).not.toHaveBeenCalled();
  });

  it('loads the latest review lazily when round is omitted', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_GET_REVIEW,
      WORKFLOW_ID,
    )).resolves.toBe(REVIEW);
    expect(harness.persistence.getReview).toHaveBeenCalledWith(WORKFLOW_ID, undefined);
    expect(harness.persistence.listStagePage).not.toHaveBeenCalled();
  });

  it.each([1, 3])('loads valid review boundary round %s', async (round) => {
    const harness = createHarness();

    await harness.invoke(IPC_CHANNELS.WORKFLOW_GET_REVIEW, WORKFLOW_ID, round);

    expect(harness.persistence.getReview).toHaveBeenCalledWith(WORKFLOW_ID, round);
  });

  it.each([0, 4, 1.5, '2'])('rejects invalid review round %#', async (round) => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_GET_REVIEW,
      WORKFLOW_ID,
      round,
    )).rejects.toThrow();
    expect(harness.persistence.getReview).not.toHaveBeenCalled();
  });

  it('rejects review lookup for a missing workflow', async () => {
    const harness = createHarness({ publicWorkflow: null });

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_GET_REVIEW,
      WORKFLOW_ID,
    )).rejects.toThrow('Workflow was not found.');
    expect(harness.persistence.getReview).not.toHaveBeenCalled();
  });
});

describe('workflow manager command routing', () => {
  it.each([
    [IPC_CHANNELS.WORKFLOW_START_PLANNING, [WORKFLOW_ID]],
    [IPC_CHANNELS.WORKFLOW_START_EXECUTION, [WORKFLOW_ID]],
    [IPC_CHANNELS.WORKFLOW_RESUME, [WORKFLOW_ID, false]],
  ] as const)('rejects %s before spawning when the registered project path drifted', async (channel, args) => {
    const harness = createHarness();
    harness.database.getProject.mockReturnValue({
      id: PROJECT_ID,
      path: 'C:\\Projects\\Moved-After-Workflow-Creation',
    });

    await expect(harness.invoke(channel, ...args)).rejects.toThrow(/workflow project binding/i);
    expect(harness.manager.startPlanning).not.toHaveBeenCalled();
    expect(harness.manager.startExecution).not.toHaveBeenCalled();
    expect(harness.manager.resume).not.toHaveBeenCalled();
  });

  it('rejects execution when the persisted workflow project id differs from its task', async () => {
    const harness = createHarness({
      publicWorkflow: { ...WORKFLOW, projectId: OTHER_PROJECT_ID },
    });

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_START_EXECUTION,
      WORKFLOW_ID,
    )).rejects.toThrow(/workflow project binding/i);
    expect(harness.manager.startExecution).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('maps omitted or empty planning feedback (%s) to null', async (feedback) => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_START_PLANNING,
      WORKFLOW_ID,
      feedback,
    )).resolves.toBe(WORKFLOW);
    expect(harness.manager.startPlanning).toHaveBeenCalledWith(WORKFLOW_ID, null);
  });

  it('trims and forwards planning feedback', async () => {
    const harness = createHarness();

    await harness.invoke(
      IPC_CHANNELS.WORKFLOW_START_PLANNING,
      WORKFLOW_ID,
      '  Focus on validation  ',
    );

    expect(harness.manager.startPlanning).toHaveBeenCalledWith(
      WORKFLOW_ID,
      'Focus on validation',
    );
  });

  it('accepts feedback at the maximum length', async () => {
    const harness = createHarness();
    const feedback = 'f'.repeat(50_000);

    await harness.invoke(
      IPC_CHANNELS.WORKFLOW_START_PLANNING,
      WORKFLOW_ID,
      feedback,
    );

    expect(harness.manager.startPlanning).toHaveBeenCalledWith(WORKFLOW_ID, feedback);
  });

  it.each(['   ', 'feedback\0escape', 'f'.repeat(50_001)])(
    'rejects invalid planning feedback %#',
    async (feedback) => {
      const harness = createHarness();

      await expect(harness.invoke(
        IPC_CHANNELS.WORKFLOW_START_PLANNING,
        WORKFLOW_ID,
        feedback,
      )).rejects.toThrow();
      expect(harness.manager.startPlanning).not.toHaveBeenCalled();
    },
  );

  it('validates, trims, and routes a complete execution plan', async () => {
    const harness = createHarness();
    const rawPlan = {
      ...PLAN,
      title: `  ${PLAN.title}  `,
      summary: `  ${PLAN.summary}  `,
      filesExpected: ['  src/main/ipc/workflows.ts  '],
      estimatedChanges: `  ${PLAN.estimatedChanges}  `,
      constraints: ['  Keep identity in main  '],
      steps: [{
        ...PLAN.steps[0],
        title: '  Add handlers  ',
        description: '  Register validated handlers  ',
        acceptanceCriteria: ['  All handlers pass  '],
      }],
    };

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_UPDATE_PLAN,
      `  ${WORKFLOW_ID}  `,
      rawPlan,
    )).resolves.toBe(WORKFLOW);
    expect(harness.manager.updatePlan).toHaveBeenCalledWith(WORKFLOW_ID, {
      ...PLAN,
      title: PLAN.title,
      summary: PLAN.summary,
      filesExpected: ['src/main/ipc/workflows.ts'],
      estimatedChanges: PLAN.estimatedChanges,
      constraints: ['Keep identity in main'],
      steps: [{
        ...PLAN.steps[0],
        title: 'Add handlers',
        description: 'Register validated handlers',
        acceptanceCriteria: ['All handlers pass'],
      }],
    });
  });

  it.each([
    ['empty steps', { ...PLAN, steps: [] }],
    ['too many steps', { ...PLAN, steps: Array.from({ length: 201 }, (_, id) => ({ id, title: `Step ${id}`, risk: 'low' })) }],
    ['negative step id', { ...PLAN, steps: [{ id: -1, title: 'Step', risk: 'low' }] }],
    ['fractional step id', { ...PLAN, steps: [{ id: 1.5, title: 'Step', risk: 'low' }] }],
    ['invalid step risk', { ...PLAN, steps: [{ id: 1, title: 'Step', risk: 'critical' }] }],
    ['empty step title', { ...PLAN, steps: [{ id: 1, title: '   ', risk: 'low' }] }],
    ['invalid step status', { ...PLAN, steps: [{ id: 1, title: 'Step', risk: 'low', status: 'done' }] }],
    ['extra step field', { ...PLAN, steps: [{ id: 1, title: 'Step', risk: 'low', command: 'rm -rf' }] }],
    ['empty filesExpected entry', { ...PLAN, filesExpected: ['   '] }],
    ['invalid risk level', { ...PLAN, riskLevel: 'critical' }],
    ['extra plan field', { ...PLAN, projectPath: 'C:\\Renderer\\Escape' }],
  ])('rejects plan schema violation: %s', async (_label, plan) => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_UPDATE_PLAN,
      WORKFLOW_ID,
      plan,
    )).rejects.toThrow();
    expect(harness.manager.updatePlan).not.toHaveBeenCalled();
  });

  it('routes start execution', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_START_EXECUTION,
      WORKFLOW_ID,
    )).resolves.toBe(WORKFLOW);
    expect(harness.manager.startExecution).toHaveBeenCalledWith(WORKFLOW_ID);
  });

  it('routes pause', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_PAUSE,
      WORKFLOW_ID,
    )).resolves.toBe(WORKFLOW);
    expect(harness.manager.pause).toHaveBeenCalledWith(WORKFLOW_ID);
  });

  it('defaults resume fix-limit permission to false', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_RESUME,
      WORKFLOW_ID,
    )).resolves.toBe(WORKFLOW);
    expect(harness.manager.resume).toHaveBeenCalledWith(WORKFLOW_ID, {
      allowAfterFixLimit: false,
    });
  });

  it('forwards explicit resume fix-limit permission', async () => {
    const harness = createHarness();

    await harness.invoke(IPC_CHANNELS.WORKFLOW_RESUME, WORKFLOW_ID, true);

    expect(harness.manager.resume).toHaveBeenCalledWith(WORKFLOW_ID, {
      allowAfterFixLimit: true,
    });
  });

  it('rejects a non-boolean resume override', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_RESUME,
      WORKFLOW_ID,
      'true',
    )).rejects.toThrow();
    expect(harness.manager.resume).not.toHaveBeenCalled();
  });

  it('routes cancel', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_CANCEL,
      WORKFLOW_ID,
    )).resolves.toBe(WORKFLOW);
    expect(harness.manager.cancel).toHaveBeenCalledWith(WORKFLOW_ID);
  });

  it('routes explicit review acceptance', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_ACCEPT_REVIEW,
      WORKFLOW_ID,
    )).resolves.toBe(WORKFLOW);
    expect(harness.manager.acceptReview).toHaveBeenCalledWith(WORKFLOW_ID);
  });
});

describe('workflow review export and commit preview', () => {
  it('exports the latest review with a safe name and complete Markdown content', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_EXPORT_REVIEW,
      WORKFLOW_ID,
    )).resolves.toBe('C:\\Exports\\review.md');

    expect(harness.persistence.getPublic).toHaveBeenCalledWith(WORKFLOW_ID);
    expect(harness.persistence.getReview).toHaveBeenCalledWith(WORKFLOW_ID);
    expect(harness.saveReview).toHaveBeenCalledOnce();
    const [fileName, markdown] = harness.saveReview.mock.calls[0];
    expect(fileName).toBe('workflow-alpha-review-round-2.md');
    expect(markdown).toContain('# Workflow Review - Implement workflow IPC');
    expect(markdown).toContain('- Workflow: workflow-alpha');
    expect(markdown).toContain('- Round: 2');
    expect(markdown).toContain('- Score: 8/10');
    expect(markdown).toContain('- Tests: 41 passed, 0 failed, 1 skipped');
    expect(markdown).toContain('### [HIGH] Validate renderer identity');
    expect(markdown).toContain('- Location: src/main/ipc/workflows.ts:42');
    expect(markdown).toContain('- Status: open');
    expect(markdown).toContain(`- Recommendation: ${REVIEW.issues[0].recommendation}`);
  });

  it('reports a clean exported review without fabricating issues', async () => {
    const harness = createHarness({ review: { ...REVIEW, issues: [] } });

    await harness.invoke(IPC_CHANNELS.WORKFLOW_EXPORT_REVIEW, WORKFLOW_ID);

    expect(harness.saveReview.mock.calls[0][1]).toContain('No issues found.');
  });

  it('sanitizes the workflow id used in the default export file name', async () => {
    const harness = createHarness();

    await harness.invoke(
      IPC_CHANNELS.WORKFLOW_EXPORT_REVIEW,
      '  workflow / unsafe id  ',
    );

    expect(harness.saveReview.mock.calls[0][0]).toBe(
      'workflow-unsafe-id-review-round-2.md',
    );
  });

  it('returns null when review export is cancelled', async () => {
    const harness = createHarness({ saveResult: null });

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_EXPORT_REVIEW,
      WORKFLOW_ID,
    )).resolves.toBeNull();
    expect(harness.saveReview).toHaveBeenCalledOnce();
  });

  it.each([
    ['workflow', { publicWorkflow: null }],
    ['review', { review: null }],
  ])('rejects export when the %s is missing', async (_label, options) => {
    const harness = createHarness(options);

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_EXPORT_REVIEW,
      WORKFLOW_ID,
    )).rejects.toThrow('Workflow review was not found.');
    expect(harness.saveReview).not.toHaveBeenCalled();
  });

  it('routes commit preview creation with a validated id', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_COMMIT_PREVIEW,
      `  ${WORKFLOW_ID}  `,
    )).resolves.toBe(COMMIT_PREVIEW);
    expect(harness.infrastructure.createCommitPreview).toHaveBeenCalledWith(WORKFLOW_ID);
  });

  it('rejects an unsafe commit preview workflow id', async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.WORKFLOW_COMMIT_PREVIEW,
      'workflow\0escape',
    )).rejects.toThrow();
    expect(harness.infrastructure.createCommitPreview).not.toHaveBeenCalled();
  });
});
