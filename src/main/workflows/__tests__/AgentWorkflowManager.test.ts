import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStatus, WorkflowStageRecord } from '../../../shared/types/workflow';
import {
  AgentWorkflowManager,
  agentWorkflowInternals,
  WORKFLOW_TRANSITIONS,
} from '../AgentWorkflowManager';
import { GitWorkspaceError } from '../../git/GitWorkspaceService';
import type { AgentStageRequest } from '../contracts';
import { GitWorkspaceWorkflowGateway } from '../WorkflowInfrastructure';
import {
  clone,
  createIdle,
  createWaiting,
  managerFixture,
  MemoryWorkflowPersistence,
  modelSelectionPolicy,
  persistedWorkflow,
  plan,
  report,
  ScriptedRunner,
} from './helpers';

describe('AgentWorkflowManager transition graph', () => {
  const allowed = Object.entries(WORKFLOW_TRANSITIONS)
    .flatMap(([from, targets]) => targets.map((to) => [from, to] as [WorkflowStatus, WorkflowStatus]));

  it.each(allowed)('allows %s -> %s', (from, to) => {
    expect(agentWorkflowInternals.canTransition(from, to)).toBe(true);
  });

  const forbidden: Array<[WorkflowStatus, WorkflowStatus]> = [
    ['idle', 'executing'],
    ['idle', 'reviewing'],
    ['planning', 'executing'],
    ['planning', 'completed'],
    ['waiting_plan_confirmation', 'testing'],
    ['waiting_plan_confirmation', 'reviewing'],
    ['executing', 'planning'],
    ['executing', 'completed'],
    ['testing', 'executing'],
    ['testing', 'completed'],
    ['reviewing', 'testing'],
    ['completed', 'idle'],
    ['completed', 'cancelled'],
    ['failed', 'planning'],
    ['failed', 'cancelled'],
    ['cancelled', 'planning'],
    ['cancelled', 'completed'],
  ];

  it.each(forbidden)('forbids %s -> %s', (from, to) => {
    expect(agentWorkflowInternals.canTransition(from, to)).toBe(false);
  });
});

describe('AgentWorkflowManager creation and plan confirmation', () => {
  function nonRepositoryFixture() {
    const persistence = new MemoryWorkflowPersistence();
    const runner = new ScriptedRunner();
    const checkpoints: string[] = [];
    const events: string[] = [];
    const permissionCompletions: string[] = [];
    const manager = new AgentWorkflowManager({
      persistence,
      runner,
      git: new GitWorkspaceWorkflowGateway({
        getStatus: async () => {
          throw new GitWorkspaceError(
            'Selected project is not a Git working tree.',
            'NOT_A_REPOSITORY',
          );
        },
      }),
      checkpoints: {
        createCheckpoint: (request) => {
          checkpoints.push(request.boundary);
          if (request.boundary === 'terminal') {
            throw new Error('Git checkpoint cannot run outside a repository.');
          }
        },
      },
      events: { publish: (event) => { events.push(event.type); } },
      permissionLifecycle: {
        completeTask: ({ workflowId }) => { permissionCompletions.push(workflowId ?? ''); },
      },
      now: () => new Date('2026-08-01T00:00:00.000Z'),
    });
    return {
      manager,
      persistence,
      runner,
      checkpoints,
      events,
      permissionCompletions,
    };
  }

  it('plans a non-Git first-run project without requesting Git checkpoints', async () => {
    const fixture = nonRepositoryFixture();
    await fixture.manager.createWorkflow({
      id: 'first-run',
      taskId: 'first-run-task',
      projectId: 'first-run-project',
      projectPath: 'C:/first-run-project',
      prompt: 'Create a read-only plan',
      currentPermissionMode: 'plan',
    });

    const workflow = await fixture.manager.startPlanning('first-run');

    expect(workflow.status).toBe('waiting_plan_confirmation');
    expect(workflow.failure).toBeNull();
    expect(fixture.checkpoints).toEqual([]);
    expect(fixture.runner.requests).toHaveLength(1);
    expect(fixture.runner.requests[0]).toMatchObject({
      stage: 'planner',
      agentMode: 'plan',
      permissionMode: 'plan',
      input: {
        kind: 'planner',
        git: { kind: 'not_repository', head: null, branch: null, files: [] },
      },
    });
    const stage = fixture.persistence.listStageRecords('first-run')[0];
    expect(JSON.parse(stage.inputJson)).toMatchObject({
      kind: 'planner',
      git: { kind: 'not_repository', head: null, branch: null, files: [] },
    });
  });

  it('returns a stable failed snapshot when non-Git execution reaches a writable stage', async () => {
    const fixture = nonRepositoryFixture();
    await fixture.manager.createWorkflow({
      id: 'write-blocked',
      taskId: 'write-task',
      projectId: 'first-run-project',
      projectPath: 'C:/first-run-project',
      prompt: 'Implement the plan',
      currentPermissionMode: 'default',
    });
    await fixture.manager.startPlanning('write-blocked');

    const workflow = await fixture.manager.confirmPlan('write-blocked');

    expect(workflow).toMatchObject({
      status: 'failed',
      failure: { stage: 'coder', code: 'AGENT_STAGE_FAILED', message: 'Agent stage failed.' },
    });
    expect(fixture.runner.requests.map((request) => request.stage)).toEqual(['planner']);
    expect(fixture.checkpoints).not.toContain('before_execute');
    expect(fixture.checkpoints).not.toContain('after_execute');
    expect(fixture.checkpoints).not.toContain('terminal');
    expect(fixture.events.filter((type) => type === 'workflow_terminal')).toHaveLength(1);
    expect(fixture.permissionCompletions).toEqual(['write-blocked']);
  });

  it('keeps repeated confirmation of a failed non-Git workflow idempotent', async () => {
    const fixture = nonRepositoryFixture();
    await fixture.manager.createWorkflow({
      id: 'repeat-write-blocked',
      taskId: 'repeat-write-task',
      projectId: 'first-run-project',
      projectPath: 'C:/first-run-project',
      prompt: 'Implement the plan',
      currentPermissionMode: 'default',
    });
    await fixture.manager.startPlanning('repeat-write-blocked');

    const first = await fixture.manager.confirmPlan('repeat-write-blocked');
    const second = await fixture.manager.confirmPlan('repeat-write-blocked');
    const cancelled = await fixture.manager.cancelWorkflow('repeat-write-blocked');
    const paused = await fixture.manager.pauseWorkflow('repeat-write-blocked');

    expect(second).toEqual(first);
    expect(cancelled).toEqual(first);
    expect(paused).toEqual(first);
    expect(fixture.events.filter((type) => type === 'workflow_terminal')).toHaveLength(1);
    expect(fixture.permissionCompletions).toEqual(['repeat-write-blocked']);
    expect(fixture.checkpoints).not.toContain('terminal');
  });

  it('fails planning closed when no Git gateway is configured', async () => {
    const persistence = new MemoryWorkflowPersistence();
    const runner = new ScriptedRunner();
    const manager = new AgentWorkflowManager({ persistence, runner });
    await manager.createWorkflow({
      id: 'missing-git-planner',
      taskId: 'missing-git-task',
      projectId: 'project',
      projectPath: 'C:/project',
      prompt: 'Create a plan',
      currentPermissionMode: 'plan',
    });

    const workflow = await manager.startPlanning('missing-git-planner');

    expect(workflow).toMatchObject({
      status: 'failed',
      failure: { stage: 'planner', code: 'AGENT_STAGE_FAILED', message: 'Agent stage failed.' },
    });
    expect(runner.requests).toEqual([]);
  });

  it('fails a writable stage closed if its Git gateway becomes unavailable', async () => {
    const persistence = new MemoryWorkflowPersistence();
    const runner = new ScriptedRunner();
    const planningManager = new AgentWorkflowManager({
      persistence,
      runner,
      git: {
        readContext: () => ({
          kind: 'repository',
          head: 'a'.repeat(40),
          branch: 'main',
          files: [],
        }),
      },
    });
    await planningManager.createWorkflow({
      id: 'missing-git-coder',
      taskId: 'missing-git-task',
      projectId: 'project',
      projectPath: 'C:/project',
      prompt: 'Implement a plan',
      currentPermissionMode: 'default',
    });
    await planningManager.startPlanning('missing-git-coder');
    const requestsBeforeExecution = runner.requests.length;
    const executionManager = new AgentWorkflowManager({ persistence, runner });

    const workflow = await executionManager.confirmPlan('missing-git-coder');

    expect(workflow).toMatchObject({
      status: 'failed',
      failure: { stage: 'coder', code: 'AGENT_STAGE_FAILED', message: 'Agent stage failed.' },
    });
    expect(runner.requests).toHaveLength(requestsBeforeExecution);
  });

  it.each([
    ['missing', { head: null, branch: null, files: [], rawDetail: 'C:\\private\\missing-kind' }],
    ['unknown', {
      kind: 'future_repository_state',
      head: null,
      branch: null,
      files: [],
      rawDetail: 'C:\\private\\unknown-kind',
    }],
  ])('rejects a %s Git context kind with a fixed public failure', async (_label, context) => {
    const persistence = new MemoryWorkflowPersistence();
    const runner = new ScriptedRunner();
    const manager = new AgentWorkflowManager({
      persistence,
      runner,
      git: { readContext: () => context as never },
    });
    await manager.createWorkflow({
      id: `bad-git-${_label}`,
      taskId: `bad-git-task-${_label}`,
      projectId: 'project',
      projectPath: 'C:/public-project',
      prompt: 'Create a plan',
      currentPermissionMode: 'plan',
    });

    const workflow = await manager.startPlanning(`bad-git-${_label}`);

    expect(workflow).toMatchObject({
      status: 'failed',
      failure: { stage: 'planner', code: 'AGENT_STAGE_FAILED', message: 'Agent stage failed.' },
    });
    expect(runner.requests).toEqual([]);
    expect(JSON.stringify({ workflow, persisted: persistence.getWorkflow(`bad-git-${_label}`) }))
      .not.toContain(context.rawDetail);
  });

  it('keeps unexpected Git failures closed without persisting their project path', async () => {
    const rawPath = 'C:\\private\\unexpected-repository';
    const persistence = new MemoryWorkflowPersistence();
    const runner = new ScriptedRunner();
    const manager = new AgentWorkflowManager({
      persistence,
      runner,
      git: new GitWorkspaceWorkflowGateway({
        getStatus: async () => {
          throw new GitWorkspaceError(
            `Unable to inspect ${rawPath}.`,
            'INVALID_GIT_OUTPUT',
          );
        },
      }),
      now: () => new Date('2026-08-01T00:00:00.000Z'),
    });
    await manager.createWorkflow({
      id: 'git-error',
      taskId: 'git-error-task',
      projectId: 'git-error-project',
      projectPath: 'C:/public-project',
      prompt: 'Create a plan',
      currentPermissionMode: 'plan',
    });

    const workflow = await manager.startPlanning('git-error');

    expect(workflow).toMatchObject({
      status: 'failed',
      failure: { stage: 'planner', code: 'AGENT_STAGE_FAILED', message: 'Agent stage failed.' },
    });
    expect(runner.requests).toEqual([]);
    expect(persistence.listStageRecords('git-error')).toEqual([]);
    expect(JSON.stringify({ workflow, persisted: persistence.getWorkflow('git-error') }))
      .not.toContain(rawPath);
  });

  it('creates a persisted idle workflow', async () => {
    const fixture = managerFixture();
    const workflow = await createIdle(fixture);
    expect(workflow).toMatchObject({
      id: 'workflow-1', status: 'idle', currentStage: null, activeStage: null,
      revision: 0, reviewRound: 0, fixRound: 0,
    });
    expect(fixture.persistence.creates).toBe(1);
  });

  it('generates an id when omitted', async () => {
    const fixture = managerFixture();
    const workflow = await fixture.manager.createWorkflow({
      taskId: 'task', projectId: 'project', projectPath: 'C:/repo', prompt: 'Goal',
      currentPermissionMode: 'default',
    });
    expect(workflow.id).toBe('workflow-1');
  });

  it('persists explicit project/session/resume identity internally', async () => {
    const fixture = managerFixture();
    await fixture.manager.createWorkflow({
      id: 'identity', taskId: 'task', projectId: 'project', projectPath: 'C:/repo', prompt: 'Goal',
      projectKey: 'project-key', sessionKey: 'session-key', resumeSessionId: 'resume-id',
      currentPermissionMode: 'default',
    });
    expect(fixture.persistence.getWorkflow('identity')).toMatchObject({
      projectKey: 'project-key', sessionKey: 'session-key', resumeSessionId: 'resume-id',
    });
  });

  it('snapshots one immutable Provider selection per workflow role at creation', async () => {
    const policy = modelSelectionPolicy();
    const snapshotWorkflowPolicy = vi.fn(() => policy);
    const fixture = managerFixture({ modelSelections: { snapshotWorkflowPolicy } });

    const workflow = await fixture.manager.createWorkflow({
      id: 'pinned', taskId: 'task', projectId: 'project', projectPath: 'C:/repo', prompt: 'Goal',
      resumeSessionId: 'unbound-claude-session', currentModel: 'current-model',
      currentPermissionMode: 'default',
      modelPolicy: { plannerModel: 'planner-fallback', coderModel: 'coder-fallback' },
    });

    expect(snapshotWorkflowPolicy).toHaveBeenCalledWith({
      taskId: 'task',
      projectId: 'project',
      fallbackModelIds: {
        planner: 'planner-fallback',
        coder: 'coder-fallback',
        tester: 'coder-fallback',
        reviewer: 'current-model',
        fixer: 'coder-fallback',
      },
    });
    expect(fixture.persistence.getWorkflow('pinned')).toMatchObject({
      modelSelectionPolicy: policy,
      resumeSessionId: null,
    });
    expect(workflow).not.toHaveProperty('modelSelectionPolicy');
  });

  it('creates no Workflow when the main-process model snapshot rejects the runtime', async () => {
    const snapshotWorkflowPolicy = vi.fn(() => {
      throw Object.assign(new Error('runtime incompatible'), { code: 'RUNTIME_INCOMPATIBLE' });
    });
    const fixture = managerFixture({ modelSelections: { snapshotWorkflowPolicy } });

    await expect(fixture.manager.createWorkflow({
      id: 'deepseek-workflow', taskId: 'task', projectId: 'project',
      projectPath: 'C:/repo', prompt: 'Goal', currentPermissionMode: 'default',
    })).rejects.toMatchObject({ code: 'RUNTIME_INCOMPATIBLE' });
    expect(fixture.persistence.creates).toBe(0);
    expect(fixture.persistence.listStageRecords('deepseek-workflow')).toEqual([]);
    expect(fixture.checkpoints).toEqual([]);
    expect(fixture.runner.requests).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it('revalidates a frozen Provider before writing a Stage or Checkpoint', async () => {
    const policy = modelSelectionPolicy();
    const revalidatePinnedSelection = vi.fn(() => {
      throw Object.assign(new Error('runtime incompatible'), { code: 'RUNTIME_INCOMPATIBLE' });
    });
    const fixture = managerFixture({
      modelSelections: {
        snapshotWorkflowPolicy: () => policy,
        revalidatePinnedSelection,
      },
    });
    await fixture.manager.createWorkflow({
      id: 'stale-provider', taskId: 'task', projectId: 'project',
      projectPath: 'C:/repo', prompt: 'Goal', currentPermissionMode: 'default',
    });

    const result = await fixture.manager.startPlanning('stale-provider');

    expect(result).toMatchObject({
      status: 'failed',
      failure: {
        stage: 'planner',
        code: 'RUNTIME_INCOMPATIBLE',
        message: '该模型当前不能用于 Agent，请重新选择。',
      },
    });
    expect(revalidatePinnedSelection).toHaveBeenCalledWith(
      policy.planner,
      expect.objectContaining({ agentType: 'planner', use: 'agent-workflow' }),
    );
    expect(fixture.persistence.listStageRecords('stale-provider')).toEqual([]);
    expect(fixture.checkpoints).toEqual([]);
    expect(fixture.runner.requests).toEqual([]);
    expect(fixture.events.map((event) => event.type)).not.toContain('workflow_stage_started');
  });

  it('keeps legacy workflow creation compatible when no snapshot resolver is wired', async () => {
    const fixture = managerFixture();
    await fixture.manager.createWorkflow({
      id: 'legacy', taskId: 'task', projectId: 'project', projectPath: 'C:/repo', prompt: 'Goal',
      resumeSessionId: 'legacy-session', currentPermissionMode: 'default',
    });
    expect(fixture.persistence.getWorkflow('legacy')).toMatchObject({
      modelSelectionPolicy: null,
      resumeSessionId: 'legacy-session',
    });
  });

  it('derives safe project/session identity defaults', async () => {
    const fixture = managerFixture();
    await createIdle(fixture);
    expect(fixture.persistence.getWorkflow('workflow-1')).toMatchObject({
      projectKey: 'C:/repo', sessionKey: 'C:/repo::task-1', resumeSessionId: null,
    });
  });

  it('does not expose internal runner identity or permission fields', async () => {
    const fixture = managerFixture();
    const workflow = await createIdle(fixture) as unknown as Record<string, unknown>;
    for (const key of ['projectKey', 'sessionKey', 'resumeSessionId', 'currentModel', 'currentPermissionMode', 'pauseReason']) {
      expect(workflow).not.toHaveProperty(key);
    }
  });

  it('normalizes model policy on creation', async () => {
    const fixture = managerFixture();
    const workflow = await fixture.manager.createWorkflow({
      id: 'policy', taskId: 'task', projectId: 'project', projectPath: 'C:/repo', prompt: 'Goal',
      currentPermissionMode: 'default', modelPolicy: { plannerModel: ' p ', coderModel: ' ' },
    });
    expect(workflow.modelPolicy).toEqual({ plannerModel: 'p' });
  });

  it.each([0, -1, 4, 1.5, Number.NaN])('rejects invalid maxFixRounds %s', async (maxFixRounds) => {
    const fixture = managerFixture();
    await expect(fixture.manager.createWorkflow({
      id: `invalid-${String(maxFixRounds)}`, taskId: 'task', projectId: 'project',
      projectPath: 'C:/repo', prompt: 'Goal', currentPermissionMode: 'default', maxFixRounds,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each(['taskId', 'projectId', 'projectPath', 'prompt'] as const)('rejects blank %s', async (field) => {
    const fixture = managerFixture();
    const input = {
      id: `blank-${field}`, taskId: 'task', projectId: 'project', projectPath: 'C:/repo',
      prompt: 'Goal', currentPermissionMode: 'default' as const,
    };
    input[field] = ' ';
    await expect(fixture.manager.createWorkflow(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects an invalid runtime permission mode', async () => {
    const fixture = managerFixture();
    await expect(fixture.manager.createWorkflow({
      id: 'bad-permission', taskId: 'task', projectId: 'project', projectPath: 'C:/repo',
      prompt: 'Goal', currentPermissionMode: 'superuser' as never,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('is idempotent for a repeated create id', async () => {
    const fixture = managerFixture();
    const first = await createIdle(fixture);
    const second = await createIdle(fixture);
    expect(second).toEqual(first);
    expect(fixture.persistence.creates).toBe(1);
  });

  it('does not publish creation when persistence fails', async () => {
    const fixture = managerFixture();
    fixture.persistence.failCreate = new Error('disk unavailable');
    await expect(createIdle(fixture)).rejects.toThrow('disk unavailable');
    expect(fixture.events).toEqual([]);
  });

  it('plans from idle and waits for confirmation', async () => {
    const fixture = managerFixture();
    const workflow = await createWaiting(fixture);
    expect(workflow.status).toBe('waiting_plan_confirmation');
    expect(workflow.plan).toEqual(plan());
    expect(fixture.runner.requests.map((request) => request.stage)).toEqual(['planner']);
  });

  it('uses the pinned role selections without reusing an unbound Claude session', async () => {
    const policy = modelSelectionPolicy();
    const fixture = managerFixture({
      modelSelections: { snapshotWorkflowPolicy: () => policy },
    });
    fixture.runner.push('reviewer', report({
      round: 1,
      score: 7,
      issues: [{
        severity: 'high', file: 'src/app.ts', line: 1, title: 'Fix it',
        recommendation: 'Apply the safe fix.',
      }],
    }));
    fixture.runner.push('reviewer', report({ round: 2, score: 9, issues: [] }));
    await fixture.manager.createWorkflow({
      id: 'roles', taskId: 'task', projectId: 'project', projectPath: 'C:/repo', prompt: 'Goal',
      resumeSessionId: 'unbound-session', currentPermissionMode: 'default',
    });
    await fixture.manager.startPlanning('roles');
    await fixture.manager.startExecution('roles');

    expect(fixture.runner.requests.map((request) => ({
      stage: request.stage,
      round: request.reviewRound,
      providerId: request.modelSelection?.providerId,
      model: request.model,
      resumeSessionId: request.resumeSessionId,
    }))).toEqual([
      { stage: 'planner', round: 0, providerId: 'provider-planner', model: 'model-planner', resumeSessionId: undefined },
      { stage: 'coder', round: 1, providerId: 'provider-coder', model: 'model-coder', resumeSessionId: undefined },
      { stage: 'tester', round: 1, providerId: 'provider-tester', model: 'model-tester', resumeSessionId: undefined },
      { stage: 'reviewer', round: 1, providerId: 'provider-reviewer', model: 'model-reviewer', resumeSessionId: undefined },
      { stage: 'coder', round: 2, providerId: 'provider-fixer', model: 'model-fixer', resumeSessionId: undefined },
      { stage: 'tester', round: 2, providerId: 'provider-tester', model: 'model-tester', resumeSessionId: undefined },
      { stage: 'reviewer', round: 2, providerId: 'provider-reviewer', model: 'model-reviewer', resumeSessionId: undefined },
    ]);
  });

  it('records safe frozen model provenance on each stage-start event', async () => {
    const basePolicy = modelSelectionPolicy();
    const policy = {
      ...basePolicy,
      planner: {
        ...basePolicy.planner,
        source: 'project_policy' as const,
        executionSource: 'environment' as const,
        tier: 'high_quality' as const,
        tierSource: 'project' as const,
      },
    };
    const fixture = managerFixture({
      modelSelections: { snapshotWorkflowPolicy: () => policy },
    });

    await fixture.manager.createWorkflow({
      id: 'provenance', taskId: 'task', projectId: 'project', projectPath: 'C:/repo',
      prompt: 'Goal', currentPermissionMode: 'default',
    });
    await fixture.manager.startPlanning('provenance');

    const started = fixture.events.find((event) => event.type === 'workflow_stage_started');
    expect(started?.payload.modelSelection).toEqual({
      providerId: 'provider-planner',
      providerName: 'Provider planner',
      modelId: 'model-planner',
      runtimeType: 'claude-code',
      source: 'project_policy',
      executionSource: 'environment',
      tier: 'high_quality',
      tierSource: 'project',
    });
    expect(JSON.stringify(started)).not.toMatch(/credential_ref|baseUrl|vault|api.?key|secret/iu);
  });

  it('persists planner stage input/output as structured JSON', async () => {
    const fixture = managerFixture();
    await createWaiting(fixture);
    const record = [...fixture.persistence.stages.values()][0];
    expect(record.status).toBe('completed');
    expect(record.round).toBe(0);
    expect(JSON.parse(record.inputJson)).toMatchObject({ kind: 'planner', goal: expect.any(String) });
    expect(JSON.parse(record.outputJson!)).toEqual(plan());
  });

  it('does not persist runner raw transcript data', async () => {
    const fixture = managerFixture();
    fixture.runner.push('planner', { ...plan(), rawAssistant: 'SECRET', systemPrompt: 'SECRET' });
    await createWaiting(fixture);
    const serialized = JSON.stringify([...fixture.persistence.stages.values()]);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('rawAssistant');
  });

  it('does not rerun planning when already waiting', async () => {
    const fixture = managerFixture();
    await createWaiting(fixture);
    await fixture.manager.startPlanning('workflow-1');
    expect(fixture.runner.requests).toHaveLength(1);
  });

  it('replans with feedback using a new deterministic stage id', async () => {
    const fixture = managerFixture();
    fixture.runner.push('planner', plan({ title: 'First' }), plan({ title: 'Revised' }));
    await createWaiting(fixture);
    const revised = await fixture.manager.startPlanning('workflow-1', 'add rollback');
    expect(revised.plan?.title).toBe('Revised');
    expect(fixture.runner.requests[1].input).toMatchObject({ feedback: 'add rollback' });
    expect(new Set(fixture.runner.requests.map((request) => request.operationId)).size).toBe(2);
    expect([...fixture.persistence.stages.values()]
      .filter((record) => record.stage === 'planner')
      .map((record) => record.round)).toEqual([0, 0]);
  });

  it('updates a plan only while waiting for confirmation', async () => {
    const fixture = managerFixture();
    await createWaiting(fixture);
    const updated = await fixture.manager.updatePlan('workflow-1', plan({ title: 'User revised' }));
    expect(updated.plan?.title).toBe('User revised');
    expect(updated.status).toBe('waiting_plan_confirmation');
  });

  it('strips raw fields from a user-updated plan', async () => {
    const fixture = managerFixture();
    await createWaiting(fixture);
    const updated = await fixture.manager.updatePlan('workflow-1', {
      ...plan(), rawAssistant: 'SECRET',
    } as never);
    expect(updated.plan).not.toHaveProperty('rawAssistant');
  });

  it('rejects plan update while idle', async () => {
    const fixture = managerFixture();
    await createIdle(fixture);
    await expect(fixture.manager.updatePlan('workflow-1', plan()))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('rejects confirmation while idle', async () => {
    const fixture = managerFixture();
    await createIdle(fixture);
    await expect(fixture.manager.confirmPlan('workflow-1'))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('rejects writable execution when current permission is plan', async () => {
    const fixture = managerFixture();
    await fixture.manager.createWorkflow({
      id: 'readonly', taskId: 'task', projectId: 'project', projectPath: 'C:/repo', prompt: 'Goal',
      currentPermissionMode: 'plan',
    });
    await fixture.manager.startPlanning('readonly');
    await expect(fixture.manager.startExecution('readonly'))
      .rejects.toMatchObject({ code: 'READ_ONLY_PERMISSION' });
    expect(fixture.runner.requests.map((request) => request.stage)).toEqual(['planner']);
  });

  it('runs coder, tester, reviewer and completes after confirmation', async () => {
    const fixture = managerFixture();
    await createWaiting(fixture);
    const completed = await fixture.manager.startExecution('workflow-1');
    expect(completed.status).toBe('completed');
    expect(fixture.runner.requests.map((request) => request.stage))
      .toEqual(['planner', 'coder', 'tester', 'reviewer']);
  });

  it.each(['default', 'acceptEdits', 'bypassPermissions'] as const)(
    'preserves %s permission for coder and tester',
    async (currentPermissionMode) => {
      const fixture = managerFixture();
      await fixture.manager.createWorkflow({
        id: 'permission', taskId: 'task', projectId: 'project', projectPath: 'C:/repo', prompt: 'Goal',
        currentPermissionMode,
      });
      await fixture.manager.startPlanning('permission');
      await fixture.manager.confirmPlan('permission');
      const requests = fixture.runner.requests.filter((request) => ['coder', 'tester'].includes(request.stage));
      expect(requests.map((request) => request.permissionMode)).toEqual([
        currentPermissionMode, currentPermissionMode,
      ]);
    },
  );

  it('always constrains planner and reviewer to plan permission', async () => {
    const fixture = managerFixture();
    await fixture.manager.createWorkflow({
      id: 'bypass', taskId: 'task', projectId: 'project', projectPath: 'C:/repo', prompt: 'Goal',
      currentPermissionMode: 'bypassPermissions',
    });
    await fixture.manager.startPlanning('bypass');
    await fixture.manager.confirmPlan('bypass');
    const byStage = new Map(fixture.runner.requests.map((request) => [request.stage, request]));
    expect(byStage.get('planner')?.permissionMode).toBe('plan');
    expect(byStage.get('reviewer')?.permissionMode).toBe('plan');
  });

  it('uses TaskManager workflowContext on every stage', async () => {
    const fixture = managerFixture();
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    for (const request of fixture.runner.requests) {
      expect(request.workflowContext).toEqual({
        workflowId: 'workflow-1', stage: request.stage, reviewRound: request.reviewRound,
      });
    }
  });

  it('uses runner-modifiedFiles as authoritative coder output', async () => {
    const fixture = managerFixture();
    fixture.runner.push('coder', {
      output: { summary: 'Done', filesChanged: ['forged.ts'], testsSuggested: [] },
      runId: 'coder-run',
      modifiedFiles: [' z.ts ', 'a.ts', 'a.ts'],
    });
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    const coderRecord = fixture.persistence.stages.get('workflow-1:1:coder:1')!;
    expect(JSON.parse(coderRecord.outputJson!).filesChanged).toEqual(['a.ts', 'z.ts']);
  });

  it('uses runner test counts as authoritative tester output', async () => {
    const fixture = managerFixture();
    fixture.runner.push('tester', {
      output: { summary: 'Claimed', passed: 999, failed: 0 },
      runId: 'test-run',
      tests: { passed: 3, failed: 1, skipped: 2 },
    });
    fixture.runner.push('reviewer', report({ score: 9, issues: [] }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    const testerRecord = fixture.persistence.stages.get('workflow-1:1:tester:1')!;
    expect(JSON.parse(testerRecord.outputJson!)).toMatchObject({ passed: 3, failed: 1, skipped: 2 });
  });

  it('creates the required planner, execute, reviewer, and terminal checkpoints', async () => {
    const fixture = managerFixture();
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.checkpoints.map((checkpoint) => checkpoint.boundary))
      .toEqual([
        'before_plan',
        'after_plan',
        'before_execute',
        'after_execute',
        'before_review',
        'terminal',
      ]);
    expect(new Set(fixture.checkpoints.map((checkpoint) => checkpoint.idempotencyKey)).size).toBe(6);
  });

  it('publishes status changes only after they are persisted', async () => {
    const fixture = managerFixture();
    await createWaiting(fixture);
    for (const event of fixture.events.filter((item) => item.type === 'workflow_status_changed')) {
      const saved = fixture.persistence.saves.find((entry) => entry.workflow.revision === Number(
        event.idempotencyKey.split(':').at(-1),
      ));
      expect(saved).toBeDefined();
    }
  });
});

describe('AgentWorkflowManager permission lifecycle', () => {
  const expectedIdentity = {
    taskId: 'task-1',
    workflowId: 'workflow-1',
    projectPath: 'C:/repo',
  };

  it('completes the task permission scope after a successful workflow', async () => {
    const fixture = managerFixture();
    await createWaiting(fixture);

    const result = await fixture.manager.confirmPlan('workflow-1');

    expect(result.status).toBe('completed');
    expect(fixture.permissionCompletions).toEqual([expectedIdentity]);
  });

  it('clears the task permission scope even when terminal checkpoint persistence fails', async () => {
    const fixture = managerFixture({ failCheckpointAt: 'terminal' });
    await createWaiting(fixture);

    await expect(fixture.manager.confirmPlan('workflow-1'))
      .rejects.toThrow('Workflow checkpoint is unavailable.');

    expect(fixture.permissionCompletions).toContainEqual(expectedIdentity);
  });

  it('completes the task permission scope after a failed workflow', async () => {
    const fixture = managerFixture();
    fixture.runner.push('planner', new Error('planner failed'));

    const result = await createWaiting(fixture);

    expect(result.status).toBe('failed');
    expect(fixture.checkpoints.map((checkpoint) => checkpoint.boundary))
      .toEqual(['before_plan', 'terminal']);
    expect(fixture.permissionCompletions).toEqual([expectedIdentity]);
  });

  it('completes the task permission scope after a cancelled workflow', async () => {
    const fixture = managerFixture();
    await createIdle(fixture);

    const result = await fixture.manager.cancel('workflow-1');

    expect(result.status).toBe('cancelled');
    expect(fixture.permissionCompletions).toEqual([expectedIdentity]);
  });
});

describe('AgentWorkflowManager recovery, concurrency, and terminal idempotence', () => {
  it('does not call a runner when planning transition persistence fails', async () => {
    const fixture = managerFixture();
    await createIdle(fixture);
    fixture.persistence.failSave = new Error('CAS failed');
    await expect(fixture.manager.startPlanning('workflow-1'))
      .rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    expect(fixture.runner.requests).toEqual([]);
    expect(fixture.persistence.getWorkflow('workflow-1')?.status).toBe('idle');
  });

  it('serializes concurrent planning operations', async () => {
    const fixture = managerFixture();
    await createIdle(fixture);
    const [first, second] = await Promise.all([
      fixture.manager.startPlanning('workflow-1'),
      fixture.manager.startPlanning('workflow-1'),
    ]);
    expect(first.status).toBe('waiting_plan_confirmation');
    expect(second.status).toBe('waiting_plan_confirmation');
    expect(fixture.runner.requests).toHaveLength(1);
  });

  it('honors a concurrent pause before starting the next stage', async () => {
    const fixture = managerFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fixture.runner.push('coder', async () => {
      await gate;
      return { summary: 'Coder done', filesChanged: ['a.ts'], testsSuggested: [] };
    });
    await createWaiting(fixture);
    const execution = fixture.manager.confirmPlan('workflow-1');
    await vi.waitFor(() => expect(fixture.runner.requests.some((request) => request.stage === 'coder')).toBe(true));
    const pausing = fixture.manager.pause('workflow-1', 'inspect changes');
    release();
    const [executionResult, pauseResult] = await Promise.all([execution, pausing]);
    expect(executionResult).toMatchObject({ status: 'paused', pausedFrom: 'testing' });
    expect(pauseResult.status).toBe('paused');
    expect(fixture.runner.requests.some((request) => request.stage === 'tester')).toBe(false);
  });

  it('honors a concurrent cancel before starting the next stage', async () => {
    const fixture = managerFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fixture.runner.push('coder', async () => {
      await gate;
      return { summary: 'Coder done', filesChanged: ['a.ts'], testsSuggested: [] };
    });
    await createWaiting(fixture);
    const execution = fixture.manager.confirmPlan('workflow-1');
    await vi.waitFor(() => expect(fixture.runner.requests.some((request) => request.stage === 'coder')).toBe(true));
    const cancelling = fixture.manager.cancel('workflow-1');
    release();
    const [executionResult, cancelResult] = await Promise.all([execution, cancelling]);
    expect(executionResult.status).toBe('cancelled');
    expect(cancelResult.status).toBe('cancelled');
    expect(fixture.runner.requests.some((request) => request.stage === 'tester')).toBe(false);
  });

  it('gives concurrent cancel precedence over pause', async () => {
    const fixture = managerFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fixture.runner.push('coder', async () => {
      await gate;
      return { summary: 'Coder done', filesChanged: [], testsSuggested: [] };
    });
    await createWaiting(fixture);
    const execution = fixture.manager.confirmPlan('workflow-1');
    await vi.waitFor(() => expect(fixture.runner.requests.some((request) => request.stage === 'coder')).toBe(true));
    const pausing = fixture.manager.pause('workflow-1');
    const cancelling = fixture.manager.cancel('workflow-1');
    release();
    const results = await Promise.all([execution, pausing, cancelling]);
    expect(results.map((result) => result.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });

  it('recovers a completed coder stage without rerunning coder', async () => {
    const fixture = managerFixture();
    const workflow = persistedWorkflow({
      status: 'executing', currentStage: 'coder', activeStage: 'coder', plan: plan(),
      reviewRound: 1, fixRound: 1, revision: 3, executionCycle: 1,
    });
    fixture.persistence.workflows.set(workflow.id, clone(workflow));
    fixture.persistence.stages.set('workflow-1:1:coder:1', {
      id: 'workflow-1:1:coder:1', workflowId: 'workflow-1', stage: 'coder', round: 1,
      status: 'completed', inputJson: '{}',
      outputJson: JSON.stringify({ summary: 'Recovered', filesChanged: ['a.ts'], testsSuggested: [] }),
      error: null, startedAt: workflow.updatedAt, completedAt: workflow.updatedAt,
    });
    const result = await fixture.manager.recoverWorkflow('workflow-1');
    expect(result.status).toBe('completed');
    expect(fixture.runner.requests.map((request) => request.stage)).toEqual(['tester', 'reviewer']);
  });

  it('reuses the same operation id for a persisted running stage', async () => {
    const fixture = managerFixture();
    const workflow = persistedWorkflow({
      status: 'executing', currentStage: 'coder', activeStage: 'coder', plan: plan(),
      reviewRound: 1, fixRound: 1, executionCycle: 1,
    });
    fixture.persistence.workflows.set(workflow.id, clone(workflow));
    fixture.persistence.stages.set('workflow-1:1:coder:1', {
      id: 'workflow-1:1:coder:1', workflowId: 'workflow-1', stage: 'coder', round: 1,
      status: 'running', inputJson: '{}', outputJson: null, error: null,
      startedAt: workflow.updatedAt, completedAt: null,
    });
    await fixture.manager.recoverWorkflow('workflow-1');
    expect(fixture.runner.requests[0].operationId).toBe('workflow-1:1:coder:1');
  });

  it('fails safely when a persisted completed output is corrupt', async () => {
    const fixture = managerFixture();
    const workflow = persistedWorkflow({
      status: 'executing', currentStage: 'coder', activeStage: 'coder', plan: plan(),
      reviewRound: 1, fixRound: 1, executionCycle: 1,
    });
    fixture.persistence.workflows.set(workflow.id, clone(workflow));
    fixture.persistence.stages.set('workflow-1:1:coder:1', {
      id: 'workflow-1:1:coder:1', workflowId: 'workflow-1', stage: 'coder', round: 1,
      status: 'completed', inputJson: '{}', outputJson: '{bad json', error: null,
      startedAt: workflow.updatedAt, completedAt: workflow.updatedAt,
    });
    const result = await fixture.manager.recoverWorkflow('workflow-1');
    expect(result.status).toBe('failed');
    expect(result.failure).toMatchObject({ code: 'AGENT_STAGE_FAILED', stage: 'coder' });
  });

  it('sanitizes runner failure before persistence', async () => {
    const fixture = managerFixture();
    fixture.runner.push('planner', new Error('SECRET RAW ASSISTANT CONTENT'));
    const result = await createWaiting(fixture);
    expect(result.status).toBe('failed');
    const serialized = JSON.stringify(fixture.persistence.getWorkflow('workflow-1'));
    expect(serialized).not.toContain('SECRET RAW ASSISTANT CONTENT');
    expect(result.failure).toMatchObject({ code: 'AGENT_STAGE_FAILED', stage: 'planner' });
  });

  it('marks invalid structured output with a stable failure code', async () => {
    const fixture = managerFixture();
    fixture.runner.push('planner', 'not json');
    const result = await createWaiting(fixture);
    expect(result).toMatchObject({
      status: 'failed', failure: { code: 'INVALID_STRUCTURED_OUTPUT', stage: 'planner' },
    });
  });

  it('returns not-found for unknown workflows', async () => {
    const fixture = managerFixture();
    await expect(fixture.manager.startPlanning('missing'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('pauses and resumes the previous planning stage', async () => {
    const fixture = managerFixture();
    const workflow = persistedWorkflow({ status: 'planning', currentStage: 'planner', activeStage: 'planner' });
    fixture.persistence.workflows.set(workflow.id, clone(workflow));
    const paused = await fixture.manager.pause('workflow-1', 'user requested');
    expect(paused).toMatchObject({ status: 'paused', pausedFrom: 'planning' });
    const resumed = await fixture.manager.resume('workflow-1');
    expect(resumed.status).toBe('waiting_plan_confirmation');
  });

  it('pause is idempotent', async () => {
    const fixture = managerFixture();
    await createIdle(fixture);
    const first = await fixture.manager.pause('workflow-1');
    const second = await fixture.manager.pause('workflow-1');
    expect(second.revision).toBe(first.revision);
  });

  it('rejects recovery when pausedFrom is missing', async () => {
    const fixture = managerFixture();
    const workflow = persistedWorkflow({ status: 'paused', pausedFrom: null });
    fixture.persistence.workflows.set(workflow.id, clone(workflow));
    await expect(fixture.manager.resume('workflow-1'))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('cancel is idempotent and first terminal state wins', async () => {
    const fixture = managerFixture();
    await createIdle(fixture);
    const first = await fixture.manager.cancel('workflow-1');
    const second = await fixture.manager.cancel('workflow-1');
    expect(first.status).toBe('cancelled');
    expect(second.status).toBe('cancelled');
    expect(second.revision).toBe(first.revision);
    expect(new Set(fixture.checkpoints.map((item) => item.idempotencyKey)).size).toBe(1);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'cancel does not replace existing %s terminal state',
    async (status) => {
      const fixture = managerFixture();
      const workflow = persistedWorkflow({ status });
      fixture.persistence.workflows.set(workflow.id, clone(workflow));
      const result = await fixture.manager.cancel('workflow-1');
      expect(result.status).toBe(status);
      expect(result.revision).toBe(workflow.revision);
    },
  );

  it('startReview rejects a non-reviewing workflow', async () => {
    const fixture = managerFixture();
    await createWaiting(fixture);
    await expect(fixture.manager.startReview('workflow-1'))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('startReview resumes a persisted reviewing stage', async () => {
    const fixture = managerFixture();
    const workflow = persistedWorkflow({
      status: 'reviewing', currentStage: 'reviewer', activeStage: 'reviewer', plan: plan(),
      reviewRound: 1, fixRound: 1, executionCycle: 1,
    });
    fixture.persistence.workflows.set(workflow.id, clone(workflow));
    const completedRecords: WorkflowStageRecord[] = [
      {
        id: 'workflow-1:1:coder:1', workflowId: 'workflow-1', stage: 'coder', round: 1,
        status: 'completed', inputJson: '{}',
        outputJson: JSON.stringify({ summary: 'Done', filesChanged: [], testsSuggested: [] }),
        error: null, startedAt: workflow.updatedAt, completedAt: workflow.updatedAt,
      },
      {
        id: 'workflow-1:1:tester:1', workflowId: 'workflow-1', stage: 'tester', round: 1,
        status: 'completed', inputJson: '{}',
        outputJson: JSON.stringify({ summary: 'Passed', passed: 1, failed: 0, skipped: 0, commands: [] }),
        error: null, startedAt: workflow.updatedAt, completedAt: workflow.updatedAt,
      },
    ];
    for (const record of completedRecords) fixture.persistence.stages.set(record.id, record);
    const result = await fixture.manager.startReview('workflow-1');
    expect(result.status).toBe('completed');
    expect(fixture.runner.requests.map((request) => request.stage)).toEqual(['reviewer']);
  });

  it('uses monotonically increasing timestamps under a fixed clock', () => {
    expect(agentWorkflowInternals.monotonicTimestamp(
      new Date('2026-08-01T00:00:00.000Z'),
      '2026-08-01T00:00:00.000Z',
    )).toBe('2026-08-01T00:00:00.001Z');
  });

  it('removes reserved raw keys from any structured JSON boundary', () => {
    const value = agentWorkflowInternals.cloneStructured({
      safe: 1,
      rawAssistant: 'SECRET',
      nested: { systemPrompt: 'SECRET', safe: 2 },
    });
    expect(value).toEqual({ safe: 1, nested: { safe: 2 } });
  });

  it('records a CAS expectation for every save', async () => {
    const fixture = managerFixture();
    await createWaiting(fixture);
    for (const save of fixture.persistence.saves) {
      expect(save.expectation.expectedRevision).toBe(save.workflow.revision - 1);
      expect(save.expectation.expectedUpdatedAt < save.workflow.updatedAt).toBe(true);
    }
  });

  it('keeps event failures from corrupting durable state', async () => {
    const fixture = managerFixture();
    const manager = new AgentWorkflowManager({
      persistence: fixture.persistence,
      runner: new ScriptedRunner(),
      git: {
        readContext: () => ({
          kind: 'repository',
          head: 'a'.repeat(40),
          branch: 'main',
          files: [],
        }),
      },
      events: { publish: () => { throw new Error('timeline unavailable'); } },
      now: () => new Date('2026-08-01T00:00:00.000Z'),
    });
    await manager.createWorkflow({
      id: 'event-failure', taskId: 'task', projectId: 'project', projectPath: 'C:/repo', prompt: 'Goal',
      currentPermissionMode: 'default',
    });
    const result = await manager.startPlanning('event-failure');
    expect(result.status).toBe('waiting_plan_confirmation');
    expect(fixture.persistence.getWorkflow('event-failure')?.status).toBe('waiting_plan_confirmation');
  });

  it('all runner requests carry a non-empty generated system prompt but stage records do not', async () => {
    const fixture = managerFixture();
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.runner.requests.every((request: AgentStageRequest) => request.systemPrompt.length > 0)).toBe(true);
    expect(JSON.stringify([...fixture.persistence.stages.values()])).not.toContain('systemPrompt');
  });
});
