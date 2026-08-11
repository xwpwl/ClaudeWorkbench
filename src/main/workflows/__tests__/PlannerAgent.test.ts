import { describe, expect, it } from 'vitest';
import type { AgentModelPolicy, AgentType } from '../../../shared/types/workflow';
import {
  agentModelPolicyInternals,
  normalizeAgentModelPolicy,
  resolveAgentModel,
} from '../AgentModelPolicy';
import { PlannerAgent } from '../PlannerAgent';
import { StructuredOutputError } from '../StructuredJsonParser';
import { persistedWorkflow, plan, ScriptedRunner } from './helpers';

const git = {
  kind: 'repository' as const,
  head: 'a'.repeat(40),
  branch: 'main',
  files: [{ filePath: 'src/app.ts', changeType: 'modified', staged: false }],
};

describe('AgentModelPolicy', () => {
  it('defaults to inheritance when policy is empty', () => {
    expect(resolveAgentModel({}, 'planner', 'current')).toBe('current');
  });

  it('returns undefined when neither override nor current model exists', () => {
    expect(resolveAgentModel({}, 'coder', null)).toBeUndefined();
  });

  it('trims the inherited current model', () => {
    expect(resolveAgentModel({}, 'reviewer', '  current  ')).toBe('current');
  });

  it('drops empty model policy values', () => {
    expect(normalizeAgentModelPolicy({ plannerModel: ' ', coderModel: '' })).toEqual({});
  });

  it('trims every supported override', () => {
    expect(normalizeAgentModelPolicy({
      plannerModel: ' p ', coderModel: ' c ', testerModel: ' t ', reviewerModel: ' r ', fixerModel: ' f ',
    })).toEqual({
      plannerModel: 'p', coderModel: 'c', testerModel: 't', reviewerModel: 'r', fixerModel: 'f',
    });
  });

  it('exposes only known policy keys', () => {
    expect(agentModelPolicyInternals.POLICY_KEYS).toEqual([
      'plannerModel', 'coderModel', 'testerModel', 'reviewerModel', 'fixerModel',
    ]);
  });

  const resolutions: Array<[
    string,
    AgentModelPolicy,
    AgentType,
    boolean,
    string | null,
    string | undefined,
  ]> = [
    ['planner override', { plannerModel: 'planner' }, 'planner', false, 'current', 'planner'],
    ['planner inheritance', { coderModel: 'coder' }, 'planner', false, 'current', 'current'],
    ['coder override', { coderModel: 'coder' }, 'coder', false, 'current', 'coder'],
    ['coder inheritance', { reviewerModel: 'reviewer' }, 'coder', false, 'current', 'current'],
    ['fixer override', { coderModel: 'coder', fixerModel: 'fixer' }, 'coder', true, 'current', 'fixer'],
    ['fixer coder fallback', { coderModel: 'coder' }, 'coder', true, 'current', 'coder'],
    ['fixer current fallback', {}, 'coder', true, 'current', 'current'],
    ['tester override', { testerModel: 'tester', coderModel: 'coder' }, 'tester', false, 'current', 'tester'],
    ['tester coder fallback', { coderModel: 'coder' }, 'tester', false, 'current', 'coder'],
    ['tester current fallback', {}, 'tester', false, 'current', 'current'],
    ['reviewer override', { reviewerModel: 'reviewer' }, 'reviewer', false, 'current', 'reviewer'],
    ['reviewer inheritance', { plannerModel: 'planner' }, 'reviewer', false, 'current', 'current'],
    ['blank planner inheritance', { plannerModel: '  ' }, 'planner', false, 'current', 'current'],
    ['blank tester coder fallback', { testerModel: '', coderModel: 'coder' }, 'tester', false, 'current', 'coder'],
    ['no current fallback', {}, 'reviewer', false, null, undefined],
  ];

  it.each(resolutions)('resolves %s', (_label, policy, stage, fix, current, expected) => {
    expect(resolveAgentModel(policy, stage, current, fix)).toBe(expected);
  });
});

describe('PlannerAgent', () => {
  it('runs in plan mode with CLI plan permission', async () => {
    const runner = new ScriptedRunner();
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow(), git, operationId: 'plan-op', feedback: null,
    });
    expect(runner.requests[0]).toMatchObject({
      stage: 'planner', agentType: 'planner', agentMode: 'plan', permissionMode: 'plan',
    });
  });

  it('passes the deterministic operation id', async () => {
    const runner = new ScriptedRunner();
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow(), git, operationId: 'stable-id',
    });
    expect(runner.requests[0].operationId).toBe('stable-id');
  });

  it('passes workflow/task/project identity', async () => {
    const runner = new ScriptedRunner();
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow(), git, operationId: 'id',
    });
    expect(runner.requests[0]).toMatchObject({
      workflowId: 'workflow-1', taskId: 'task-1', projectId: 'project-1',
      projectPath: 'C:/repo', projectKey: 'C:/repo', sessionKey: 'C:/repo::task-1',
    });
  });

  it('passes a resume session id when available', async () => {
    const runner = new ScriptedRunner();
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow({ resumeSessionId: 'claude-session' }), git, operationId: 'id',
    });
    expect(runner.requests[0].resumeSessionId).toBe('claude-session');
  });

  it('uses the planner model override', async () => {
    const runner = new ScriptedRunner();
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow({ modelPolicy: { plannerModel: 'planner-model' } }),
      git,
      operationId: 'id',
    });
    expect(runner.requests[0].model).toBe('planner-model');
  });

  it('inherits the current model by default', async () => {
    const runner = new ScriptedRunner();
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow({ currentModel: 'task-model' }), git, operationId: 'id',
    });
    expect(runner.requests[0].model).toBe('task-model');
  });

  it('passes a structured workflow context', async () => {
    const runner = new ScriptedRunner();
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow(), git, operationId: 'id',
    });
    expect(runner.requests[0].workflowContext).toEqual({
      workflowId: 'workflow-1', stage: 'planner', reviewRound: 0,
    });
  });

  it('passes the task prompt separately from the structured input', async () => {
    const runner = new ScriptedRunner();
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow({ prompt: 'User goal' }), git, operationId: 'id',
    });
    expect(runner.requests[0].prompt).toBe('User goal');
    expect(runner.requests[0].input).toMatchObject({ kind: 'planner', goal: 'User goal' });
  });

  it('uses a fixed read-only system instruction', async () => {
    const runner = new ScriptedRunner();
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow(), git, operationId: 'id',
    });
    expect(runner.requests[0].systemPrompt).toContain('Do not modify files');
  });

  it('does not put systemPrompt in structured stage input', async () => {
    const runner = new ScriptedRunner();
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow(), git, operationId: 'id',
    });
    expect(runner.requests[0].input).not.toHaveProperty('systemPrompt');
  });

  it('passes structured Git context', async () => {
    const runner = new ScriptedRunner();
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow(), git, operationId: 'id',
    });
    expect(runner.requests[0].input).toMatchObject({ git });
  });

  it('passes the previous plan for replanning', async () => {
    const runner = new ScriptedRunner();
    const previous = plan({ title: 'Previous' });
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow({ plan: previous }), git, operationId: 'id',
    });
    expect(runner.requests[0].input).toMatchObject({ previousPlan: previous });
  });

  it('trims user plan feedback', async () => {
    const runner = new ScriptedRunner();
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow(), git, operationId: 'id', feedback: '  add tests  ',
    });
    expect(runner.requests[0].input).toMatchObject({ feedback: 'add tests' });
  });

  it('normalizes blank feedback to null', async () => {
    const runner = new ScriptedRunner();
    await new PlannerAgent(runner).run({
      workflow: persistedWorkflow(), git, operationId: 'id', feedback: '   ',
    });
    expect(runner.requests[0].input).toMatchObject({ feedback: null });
  });

  it('returns only the parsed execution plan', async () => {
    const runner = new ScriptedRunner().push('planner', { ...plan(), rawAssistant: 'SECRET' });
    const result = await new PlannerAgent(runner).run({
      workflow: persistedWorkflow(), git, operationId: 'id',
    });
    expect(result).toEqual(plan());
    expect(result).not.toHaveProperty('rawAssistant');
  });

  it('accepts fenced JSON from the transport', async () => {
    const runner = new ScriptedRunner().push('planner', `\`\`\`json\n${JSON.stringify(plan())}\n\`\`\``);
    const result = await new PlannerAgent(runner).run({
      workflow: persistedWorkflow(), git, operationId: 'id',
    });
    expect(result.title).toBe(plan().title);
  });

  it('propagates runner failures', async () => {
    const runner = new ScriptedRunner().push('planner', new Error('runner unavailable'));
    await expect(new PlannerAgent(runner).run({
      workflow: persistedWorkflow(), git, operationId: 'id',
    })).rejects.toThrow('runner unavailable');
  });

  const invalidOutputs: Array<[string, unknown]> = [
    ['null', null],
    ['array', []],
    ['plain prose', 'I would edit three files'],
    ['empty object', {}],
    ['missing title', { ...plan(), title: undefined }],
    ['empty steps', { ...plan(), steps: [] }],
    ['duplicate steps', { ...plan(), steps: [plan().steps[0], plan().steps[0]] }],
    ['bad risk', { ...plan(), riskLevel: 'fatal' }],
    ['bad file list', { ...plan(), filesExpected: [7] }],
    ['bad estimate', { ...plan(), estimatedChanges: '' }],
  ];

  it.each(invalidOutputs)('rejects %s output', async (_label, output) => {
    const runner = new ScriptedRunner().push('planner', output);
    await expect(new PlannerAgent(runner).run({
      workflow: persistedWorkflow(), git, operationId: 'id',
    })).rejects.toBeInstanceOf(StructuredOutputError);
  });
});
