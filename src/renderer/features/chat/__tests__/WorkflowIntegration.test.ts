import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CommitPreview } from '../../../../shared/types/git';
import type { PermissionRequest } from '../../../../shared/types/permissionBroker';
import type { Project } from '../../../../shared/types/project';
import type { Workflow, WorkflowChangedEvent, WorkflowStatus } from '../../../../shared/types/workflow';
import {
  WorkflowControls,
  abortableWorkflowRequest,
  cancelWorkflowPermissionRun,
  canCreateWorkflowCommitPreview,
  enqueueWorkflowPermissionRequest,
  findPermissionSwitchTarget,
  isWorkflowAgentRunId,
  matchesWorkflowChangedEvent,
  matchesWorkflowRecord,
  removeWorkflowPermissionRequest,
  sessionStatusForWorkflow,
  workflowIdFromAgentRunId,
} from '../../../App';
import {
  executionProjectMismatch,
  isWorkflowPlanMode,
  registeredPromptTargetProjects,
  submitWorkflowPlan,
  workflowPermissionMode,
  workflowSessionPatch,
  workflowUsesActiveAgent,
} from '../InputBar';
import type {
  WorkflowPlanSubmission,
  WorkflowPlanSubmissionDependencies,
} from '../InputBar';

const NOW = '2026-08-01T08:00:00.000Z';

function project(id: string, projectPath: string): Project {
  return { id, name: id, path: projectPath, createdAt: NOW, lastOpenedAt: NOW };
}

describe('canonical execution project binding', () => {
  it('accepts equivalent slash and case aliases but rejects a different runtime project', () => {
    expect(executionProjectMismatch(
      { id: 'project-1', path: 'C:\\Projects\\Fixture' },
      { projectId: 'project-1', projectPath: 'c:/projects/fixture' },
    )).toBeNull();
    expect(executionProjectMismatch(
      { id: 'project-1', path: 'C:\\Projects\\Fixture' },
      { projectId: 'project-2', projectPath: 'C:\\Projects\\Other' },
    )).toContain('当前选择项目与任务绑定项目不一致');
  });

  it('detects a literal registered target project before a task is spawned', () => {
    const selected = project('project-a', 'C:\\Projects\\Alpha');
    const target = project('project-b', 'C:\\Projects\\Beta');

    expect(registeredPromptTargetProjects(
      '请修改 c:/projects/beta/src/index.ts',
      selected,
      [selected, target],
    )).toEqual([target]);
    expect(registeredPromptTargetProjects(
      '只修改当前项目',
      selected,
      [selected, target],
    )).toEqual([]);
  });

  it('uses an absolute target path instead of cwd when offering a permission-time project switch', () => {
    const selected = project('project-a', 'C:\\Projects\\Alpha');
    const target = project('project-b', 'C:\\Projects\\Beta');
    const request = makePermission({
      outsideProject: true,
      projectPath: selected.path,
      canonicalProjectPath: 'c:\\projects\\alpha',
      effectiveCwd: selected.path,
      targetPaths: ['C:\\Projects\\Beta\\src\\index.ts'],
    });

    expect(findPermissionSwitchTarget(request, [selected, target])).toEqual(target);
  });

  it('does not offer an ambiguous switch when one request spans two registered projects', () => {
    const selected = project('project-a', 'C:\\Projects\\Alpha');
    const targetB = project('project-b', 'C:\\Projects\\Beta');
    const targetC = project('project-c', 'C:\\Projects\\Gamma');
    const request = makePermission({
      outsideProject: true,
      projectPath: selected.path,
      canonicalProjectPath: 'c:\\projects\\alpha',
      effectiveCwd: selected.path,
      targetPaths: [
        'C:\\Projects\\Beta\\src\\index.ts',
        'C:\\Projects\\Gamma\\src\\index.ts',
      ],
    });

    expect(findPermissionSwitchTarget(request, [selected, targetB, targetC])).toBeNull();
  });
});

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'workflow-1',
    taskId: 'task-1',
    projectId: 'project-1',
    projectPath: 'C:/project',
    prompt: 'Implement workflow integration',
    status: 'waiting_plan_confirmation',
    currentStage: 'planner',
    modelPolicy: {},
    plan: null,
    latestReview: null,
    reviewRound: 0,
    maxReviewRounds: 3,
    fixRound: 0,
    maxFixRounds: 3,
    revision: 1,
    pausedFrom: null,
    failure: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makePermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'permission-1',
    runId: 'workflow-1:1:coder:0:run-1',
    sessionKey: 'C:/project::task-1',
    projectPath: 'C:/project',
    toolName: 'Edit',
    input: { file_path: 'src/App.tsx' },
    risk: 'medium',
    createdAt: 1,
    ...overrides,
  };
}

const submission: WorkflowPlanSubmission = {
  taskId: 'task-1',
  prompt: 'Plan this change',
  userMessageId: 'message-1',
  currentModel: 'claude-sonnet',
  currentPermissionMode: 'bypassPermissions',
  sessionPatch: { title: 'Plan this change', titleSource: 'first_prompt', permissionMode: 'bypassPermissions' },
};

function submissionDependencies(overrides: Partial<WorkflowPlanSubmissionDependencies> = {}) {
  const created = makeWorkflow({ status: 'idle' });
  const planned = makeWorkflow({ status: 'planning', revision: 2 });
  const dependencies: WorkflowPlanSubmissionDependencies = {
    saveUserMessage: vi.fn(async () => undefined),
    updateSession: vi.fn(async () => undefined),
    createWorkflow: vi.fn(async () => created),
    startWorkflowPlanning: vi.fn(async () => planned),
    onWorkflowChanged: vi.fn(),
    ...overrides,
  };
  return { created, planned, dependencies };
}

describe('InputBar workflow mode and permission integration', () => {
  it.each([
    ['normal', false],
    ['plan', true],
    ['develop', false],
    ['review', false],
  ] as const)('recognizes %s as workflow plan mode=%s', (mode, expected) => {
    expect(isWorkflowPlanMode(mode)).toBe(expected);
  });

  it.each([
    ['standard', 'default'],
    ['accept-edits', 'acceptEdits'],
    ['plan', 'plan'],
    ['bypass', 'bypassPermissions'],
  ] as const)('preserves selected permission %s as %s', (mode, expected) => {
    expect(workflowPermissionMode(mode)).toBe(expected);
  });

  it.each([
    ['idle', true],
    ['planning', true],
    ['waiting_plan_confirmation', true],
    ['executing', true],
    ['testing', true],
    ['reviewing', true],
    ['paused', true],
    ['completed', false],
    ['failed', false],
    ['cancelled', false],
  ] as const)('blocks a second agent while workflow status is %s', (status, expected) => {
    expect(workflowUsesActiveAgent(status)).toBe(expected);
  });

  it('creates a first-prompt title and selected permission patch', () => {
    expect(workflowSessionPatch(
      { title: 'New Task', titleSource: 'default' },
      'Implement the workflow UI',
      'acceptEdits',
    )).toEqual({
      title: 'Implement the workflow UI',
      titleSource: 'first_prompt',
      permissionMode: 'acceptEdits',
    });
  });

  it('preserves a manual title', () => {
    expect(workflowSessionPatch(
      { title: 'My title', titleSource: 'manual' },
      'A replacement title',
      'default',
    )).toEqual({ permissionMode: 'default' });
  });

  it('limits generated titles to 40 characters', () => {
    const patch = workflowSessionPatch(
      { title: 'New Task', titleSource: 'default' },
      'x'.repeat(80),
      'plan',
    );
    expect(patch.title).toHaveLength(40);
  });

  it('does not mark the ordinary session running before main starts planning', () => {
    const patch = workflowSessionPatch(
      { title: 'New Task', titleSource: 'default' },
      'Plan',
      'bypassPermissions',
    );
    expect(patch).not.toHaveProperty('status');
  });
});

describe('workflow plan submission ordering', () => {
  it('persists the message and session before creating the workflow', async () => {
    let releaseMessage!: () => void;
    let releaseSession!: () => void;
    const message = new Promise<void>((resolve) => { releaseMessage = resolve; });
    const session = new Promise<void>((resolve) => { releaseSession = resolve; });
    const { dependencies } = submissionDependencies({
      saveUserMessage: vi.fn(() => message),
      updateSession: vi.fn(() => session),
    });
    const result = submitWorkflowPlan(submission, dependencies);
    await Promise.resolve();
    expect(dependencies.saveUserMessage).toHaveBeenCalledOnce();
    expect(dependencies.updateSession).toHaveBeenCalledOnce();
    expect(dependencies.createWorkflow).not.toHaveBeenCalled();
    releaseMessage();
    releaseSession();
    await result;
  });

  it('sends the selected bypass permission and model to createWorkflow', async () => {
    const { dependencies } = submissionDependencies();
    await submitWorkflowPlan(submission, dependencies);
    expect(dependencies.createWorkflow).toHaveBeenCalledWith({
      taskId: 'task-1',
      prompt: 'Plan this change',
      currentModel: 'claude-sonnet',
      currentPermissionMode: 'bypassPermissions',
    });
  });

  it('does not force plan permission mode', async () => {
    const { dependencies } = submissionDependencies();
    await submitWorkflowPlan({ ...submission, currentPermissionMode: 'acceptEdits' }, dependencies);
    expect(dependencies.createWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      currentPermissionMode: 'acceptEdits',
    }));
  });

  it('omits an empty model', async () => {
    const { dependencies } = submissionDependencies();
    await submitWorkflowPlan({ ...submission, currentModel: undefined }, dependencies);
    expect(dependencies.createWorkflow).toHaveBeenCalledWith(expect.not.objectContaining({
      currentModel: expect.anything(),
    }));
  });

  it('starts planning with the id returned by createWorkflow', async () => {
    const { dependencies } = submissionDependencies();
    await submitWorkflowPlan(submission, dependencies);
    expect(dependencies.startWorkflowPlanning).toHaveBeenCalledWith('workflow-1');
  });

  it('publishes created then planning workflow snapshots', async () => {
    const { created, planned, dependencies } = submissionDependencies();
    await expect(submitWorkflowPlan(submission, dependencies)).resolves.toBe(planned);
    expect(dependencies.onWorkflowChanged).toHaveBeenNthCalledWith(1, created);
    expect(dependencies.onWorkflowChanged).toHaveBeenNthCalledWith(2, planned);
  });

  it('does not create a workflow if persistence fails', async () => {
    const { dependencies } = submissionDependencies({
      saveUserMessage: vi.fn(async () => { throw new Error('disk failed'); }),
    });
    await expect(submitWorkflowPlan(submission, dependencies)).rejects.toThrow('disk failed');
    expect(dependencies.createWorkflow).not.toHaveBeenCalled();
  });

  it('does not start planning if creation fails', async () => {
    const { dependencies } = submissionDependencies({
      createWorkflow: vi.fn(async () => { throw new Error('create failed'); }),
    });
    await expect(submitWorkflowPlan(submission, dependencies)).rejects.toThrow('create failed');
    expect(dependencies.startWorkflowPlanning).not.toHaveBeenCalled();
  });
});

describe('App workflow task identity guards', () => {
  const event: WorkflowChangedEvent = {
    workflowId: 'workflow-1',
    taskId: 'task-1',
    projectId: 'project-1',
    status: 'planning',
    currentStage: 'planner',
    revision: 2,
  };

  it.each([
    [{ taskId: 'task-1', projectId: 'project-1' }, true],
    [{ taskId: 'task-2', projectId: 'project-1' }, false],
    [{ taskId: 'task-1', projectId: 'project-2' }, false],
    [{ taskId: null, projectId: 'project-1' }, false],
    [{ taskId: 'task-1', projectId: null }, false],
  ] as const)('matches workflow events only for the exact current identity', (identity, expected) => {
    expect(matchesWorkflowChangedEvent(event, identity)).toBe(expected);
  });

  it.each([
    [makeWorkflow(), { taskId: 'task-1', projectId: 'project-1' }, true],
    [makeWorkflow(), { taskId: 'task-2', projectId: 'project-1' }, false],
    [makeWorkflow(), { taskId: 'task-1', projectId: 'project-2' }, false],
    [null, { taskId: 'task-1', projectId: 'project-1' }, false],
  ] as const)('matches loaded records only for the exact current identity', (workflow, identity, expected) => {
    expect(matchesWorkflowRecord(workflow, identity)).toBe(expected);
  });
});

describe('workflow Agent run routing and permission queue', () => {
  it.each(['planner', 'coder', 'tester', 'reviewer'] as const)(
    'extracts workflow id for %s stage runs',
    (role) => {
      expect(workflowIdFromAgentRunId(`workflow-1:2:${role}:3:run-uuid`)).toBe('workflow-1');
    },
  );

  it.each([
    'ordinary-run-id',
    'workflow-1:coder:0:run',
    'workflow-1:1:unknown:0:run',
    'workflow-1:1:coder:0:run:extra',
    'workflow:with:colon:1:coder:0:run',
  ])('rejects malformed workflow run id %s', (runId) => {
    expect(workflowIdFromAgentRunId(runId)).toBeNull();
  });

  it('matches a workflow stage run to only its workflow', () => {
    const runId = 'workflow-1:1:coder:0:run-1';
    expect(isWorkflowAgentRunId(runId, 'workflow-1')).toBe(true);
    expect(isWorkflowAgentRunId(runId, 'workflow-2')).toBe(false);
  });

  it('queues a workflow permission independently of session identity', () => {
    const request = makePermission({ sessionKey: 'another-project::another-task' });
    expect(enqueueWorkflowPermissionRequest([], request)).toEqual([request]);
  });

  it('deduplicates repeated workflow permission events', () => {
    const request = makePermission();
    expect(enqueueWorkflowPermissionRequest([request], request)).toHaveLength(1);
  });

  it('retains other workflow permissions when one settles', () => {
    const first = makePermission();
    const second = makePermission({ requestId: 'permission-2', runId: 'workflow-2:1:tester:0:run-2' });
    expect(removeWorkflowPermissionRequest([first, second], first.requestId)).toEqual([second]);
  });

  it('leaves the queue unchanged for an unknown settlement', () => {
    const request = makePermission();
    expect(removeWorkflowPermissionRequest([request], 'missing')).toEqual([request]);
  });

  it('records workflow cancellation before stopping its permission run', async () => {
    const calls: string[] = [];
    const cancelled = makeWorkflow({ status: 'cancelled' });
    await expect(cancelWorkflowPermissionRun({
      cancelWorkflow: vi.fn(async (workflowId) => {
        calls.push(`cancel:${workflowId}`);
        return cancelled;
      }),
      stopRun: vi.fn(async (runId) => {
        calls.push(`stop:${runId}`);
        return true;
      }),
    }, 'workflow-1', 'workflow-1:1:coder:0:run-1')).resolves.toBe(cancelled);
    expect(calls).toEqual([
      'cancel:workflow-1',
      'stop:workflow-1:1:coder:0:run-1',
    ]);
  });

  it('does not wait for queued cancellation before stopping the blocked child', async () => {
    let releaseCancellation!: (workflow: Workflow) => void;
    const cancellation = new Promise<Workflow>((resolve) => { releaseCancellation = resolve; });
    const stopRun = vi.fn(async () => true);
    const result = cancelWorkflowPermissionRun({
      cancelWorkflow: vi.fn(() => cancellation),
      stopRun,
    }, 'workflow-1', 'workflow-1:1:coder:0:run-1');
    await Promise.resolve();
    expect(stopRun).toHaveBeenCalledWith('workflow-1:1:coder:0:run-1');
    const cancelled = makeWorkflow({ status: 'cancelled' });
    releaseCancellation(cancelled);
    await expect(result).resolves.toBe(cancelled);
  });

  it('still stops the workflow child when recording cancellation fails', async () => {
    const stopRun = vi.fn(async () => true);
    await expect(cancelWorkflowPermissionRun({
      cancelWorkflow: vi.fn(async () => { throw new Error('cancel failed'); }),
      stopRun,
    }, 'workflow-1', 'workflow-1:1:coder:0:run-1')).rejects.toThrow('cancel failed');
    expect(stopRun).toHaveBeenCalledWith('workflow-1:1:coder:0:run-1');
  });
});

describe('workflow status integration', () => {
  it.each([
    ['idle', 'idle'],
    ['planning', 'running'],
    ['waiting_plan_confirmation', 'idle'],
    ['executing', 'running'],
    ['testing', 'running'],
    ['reviewing', 'running'],
    ['paused', 'idle'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)('maps workflow %s to session %s', (workflow, session) => {
    expect(sessionStatusForWorkflow(workflow)).toBe(session);
  });

  it.each([
    ['idle', false],
    ['planning', false],
    ['waiting_plan_confirmation', false],
    ['executing', false],
    ['testing', false],
    ['reviewing', false],
    ['paused', false],
    ['completed', true],
    ['failed', false],
    ['cancelled', false],
  ] as const)('allows commit preview for %s only when completed', (status, expected) => {
    expect(canCreateWorkflowCommitPreview(status)).toBe(expected);
  });
});

describe('abort-aware workflow loaders', () => {
  it('does not start an already-aborted request', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => 1);
    controller.abort();
    await expect(abortableWorkflowRequest(controller.signal, request)).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
  });

  it('drops a response aborted while in flight', async () => {
    const controller = new AbortController();
    let release!: (value: number) => void;
    const response = new Promise<number>((resolve) => { release = resolve; });
    const result = abortableWorkflowRequest(controller.signal, () => response);
    controller.abort();
    release(2);
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns a response when its signal remains active', async () => {
    const controller = new AbortController();
    await expect(abortableWorkflowRequest(controller.signal, async () => 3)).resolves.toBe(3);
  });
});

describe('WorkflowControls integration UI', () => {
  const noop = () => undefined;
  const preview: CommitPreview = {
    type: 'feat',
    scope: 'workflow',
    description: 'integrate workflow UI',
    subject: 'feat(workflow): integrate workflow UI',
    message: 'feat(workflow): integrate workflow UI\n\nPlan summary\nTests: 42 passed\nReview score: 9',
    files: ['src/renderer/App.tsx'],
    fileCount: 1,
    additions: 20,
    deletions: 3,
  };

  function controls(status: WorkflowStatus, overrides: { preview?: CommitPreview | null; pending?: 'pause' | 'resume' | 'cancel' | null } = {}) {
    return renderToStaticMarkup(React.createElement(WorkflowControls, {
      workflow: makeWorkflow({ status }),
      preview: overrides.preview ?? null,
      previewLoading: false,
      pendingAction: overrides.pending ?? null,
      error: null,
      onPause: noop,
      onResume: noop,
      onCancel: noop,
      onCreatePreview: noop,
    }));
  }

  it('shows pause and cancel while planning', () => {
    const html = controls('planning');
    expect(html).toContain('data-testid="workflow-pause"');
    expect(html).toContain('data-testid="workflow-cancel-control"');
    expect(html).not.toContain('data-testid="workflow-resume"');
  });

  it('shows resume and cancel while paused', () => {
    const html = controls('paused');
    expect(html).toContain('data-testid="workflow-resume"');
    expect(html).toContain('data-testid="workflow-cancel-control"');
    expect(html).not.toContain('data-testid="workflow-pause"');
  });

  it('shows only commit preview action when completed', () => {
    const html = controls('completed');
    expect(html).toContain('data-testid="workflow-create-commit-preview"');
    expect(html).not.toContain('data-testid="workflow-cancel-control"');
    expect((html.match(/<button/g) ?? [])).toHaveLength(1);
  });

  it('renders the complete preview message and an explicit no-auto-commit notice', () => {
    const html = controls('completed', { preview });
    expect(html).toContain('data-testid="workflow-commit-preview-details"');
    expect(html).toContain('Plan summary');
    expect(html).toContain('Tests: 42 passed');
    expect(html).toContain('Review score: 9');
    expect(html).toContain('no commit will be created automatically');
  });

  it('disables controls while an action is pending', () => {
    expect(controls('planning', { pending: 'pause' })).toMatch(/<button[^>]*disabled[^>]*data-testid="workflow-pause"/);
  });

  it('renders no mutation action for failed workflows', () => {
    expect(controls('failed')).not.toContain('<button');
  });
});
