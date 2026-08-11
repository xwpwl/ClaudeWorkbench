import { describe, expect, it } from 'vitest';
import type { ReviewIssue } from '../../../shared/types/workflow';
import {
  isActionableReviewIssue,
  ReviewerAgent,
  reviewRequiresFix,
} from '../ReviewerAgent';
import { StructuredOutputError } from '../StructuredJsonParser';
import { persistedWorkflow, plan, report, ScriptedRunner } from './helpers';

const git = {
  kind: 'repository' as const,
  head: 'a'.repeat(40),
  branch: 'main',
  files: [{ filePath: 'src/app.ts', changeType: 'modified', staged: false }],
};
const coder = { summary: 'Implemented', filesChanged: ['src/app.ts'], testsSuggested: ['npm test'] };
const tests = { summary: 'Passed', passed: 12, failed: 0, skipped: 0, commands: ['npm test'] };

function issue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    severity: 'medium',
    file: 'src/app.ts',
    line: 10,
    title: 'Potential bug',
    recommendation: 'Fix the branch',
    ...overrides,
  };
}

describe('review decision policy', () => {
  it('approves a high score with no issues and passing tests', () => {
    expect(reviewRequiresFix(report())).toBe(false);
  });

  it('requests fixes below score eight', () => {
    expect(reviewRequiresFix(report({ score: 7.99 }))).toBe(true);
  });

  it('accepts the score-eight boundary', () => {
    expect(reviewRequiresFix(report({ score: 8 }))).toBe(false);
  });

  it('requests fixes when tests failed', () => {
    expect(reviewRequiresFix(report({ tests: { passed: 10, failed: 1 } }))).toBe(true);
  });

  it('allows skipped tests when no failures exist', () => {
    expect(reviewRequiresFix(report({ tests: { passed: 10, failed: 0, skipped: 2 } }))).toBe(false);
  });

  const severities = ['critical', 'high', 'medium', 'low'] as const;
  it.each(severities)('treats unresolved %s issues as actionable', (severity) => {
    expect(reviewRequiresFix(report({ issues: [issue({ severity })] }))).toBe(true);
  });

  it.each(severities)('ignores resolved %s issues', (severity) => {
    expect(reviewRequiresFix(report({ issues: [issue({ severity, resolved: true })] }))).toBe(false);
  });

  it('does not make a suggestion blocking', () => {
    expect(reviewRequiresFix(report({ issues: [issue({ severity: 'suggestion' })] }))).toBe(false);
  });

  it('does not make an unresolved suggestion actionable', () => {
    expect(isActionableReviewIssue(issue({ severity: 'suggestion', resolved: false }))).toBe(false);
  });

  it('makes an unresolved low issue actionable', () => {
    expect(isActionableReviewIssue(issue({ severity: 'low', resolved: false }))).toBe(true);
  });

  it('does not make a resolved critical issue actionable', () => {
    expect(isActionableReviewIssue(issue({ severity: 'critical', resolved: true }))).toBe(false);
  });

  it('still requests fixes for a low score with only suggestions', () => {
    expect(reviewRequiresFix(report({ score: 5, issues: [issue({ severity: 'suggestion' })] }))).toBe(true);
  });
});

describe('ReviewerAgent', () => {
  function workflow() {
    return persistedWorkflow({ plan: plan(), status: 'reviewing', reviewRound: 1 });
  }

  it('runs strictly in review mode with plan permission', async () => {
    const runner = new ScriptedRunner();
    await new ReviewerAgent(runner).run({ workflow: workflow(), git, coder, tests, operationId: 'review-1', reviewRound: 1 });
    expect(runner.requests[0]).toMatchObject({
      stage: 'reviewer', agentType: 'reviewer', agentMode: 'review', permissionMode: 'plan',
    });
  });

  it('never inherits a writable permission mode', async () => {
    const runner = new ScriptedRunner();
    await new ReviewerAgent(runner).run({
      workflow: persistedWorkflow({
        plan: plan(), status: 'reviewing', reviewRound: 1, currentPermissionMode: 'bypassPermissions',
      }),
      git, coder, tests, operationId: 'review-1', reviewRound: 1,
    });
    expect(runner.requests[0].permissionMode).toBe('plan');
  });

  it('uses the reviewer model override', async () => {
    const runner = new ScriptedRunner();
    await new ReviewerAgent(runner).run({
      workflow: persistedWorkflow({ plan: plan(), modelPolicy: { reviewerModel: 'review-model' } }),
      git, coder, tests, operationId: 'review-1', reviewRound: 1,
    });
    expect(runner.requests[0].model).toBe('review-model');
  });

  it('inherits the current task model', async () => {
    const runner = new ScriptedRunner();
    await new ReviewerAgent(runner).run({
      workflow: persistedWorkflow({ plan: plan(), currentModel: 'current-task-model' }),
      git, coder, tests, operationId: 'review-1', reviewRound: 1,
    });
    expect(runner.requests[0].model).toBe('current-task-model');
  });

  it('passes the deterministic operation id', async () => {
    const runner = new ScriptedRunner();
    await new ReviewerAgent(runner).run({ workflow: workflow(), git, coder, tests, operationId: 'stable', reviewRound: 1 });
    expect(runner.requests[0].operationId).toBe('stable');
  });

  it('passes workflow/task/project/session identity', async () => {
    const runner = new ScriptedRunner();
    await new ReviewerAgent(runner).run({ workflow: workflow(), git, coder, tests, operationId: 'id', reviewRound: 1 });
    expect(runner.requests[0]).toMatchObject({
      workflowId: 'workflow-1', taskId: 'task-1', projectId: 'project-1', projectKey: 'C:/repo',
      sessionKey: 'C:/repo::task-1',
    });
  });

  it('passes resume session identity', async () => {
    const runner = new ScriptedRunner();
    await new ReviewerAgent(runner).run({
      workflow: persistedWorkflow({ plan: plan(), resumeSessionId: 'resume-me' }),
      git, coder, tests, operationId: 'id', reviewRound: 1,
    });
    expect(runner.requests[0].resumeSessionId).toBe('resume-me');
  });

  it('passes structured workflow context', async () => {
    const runner = new ScriptedRunner();
    await new ReviewerAgent(runner).run({ workflow: workflow(), git, coder, tests, operationId: 'id', reviewRound: 2 });
    expect(runner.requests[0].workflowContext).toEqual({
      workflowId: 'workflow-1', stage: 'reviewer', reviewRound: 2,
    });
  });

  it('passes coder, tester, plan, and Git context', async () => {
    const runner = new ScriptedRunner();
    await new ReviewerAgent(runner).run({ workflow: workflow(), git, coder, tests, operationId: 'id', reviewRound: 1 });
    expect(runner.requests[0].input).toMatchObject({ kind: 'reviewer', coder, tests, git, plan: plan() });
  });

  it('passes the user goal as prompt and structured input', async () => {
    const runner = new ScriptedRunner();
    await new ReviewerAgent(runner).run({ workflow: workflow(), git, coder, tests, operationId: 'id', reviewRound: 1 });
    expect(runner.requests[0].prompt).toBe('Build the workflow');
    expect(runner.requests[0].input).toMatchObject({ goal: 'Build the workflow' });
  });

  it('uses a fixed non-writing system prompt', async () => {
    const runner = new ScriptedRunner();
    await new ReviewerAgent(runner).run({ workflow: workflow(), git, coder, tests, operationId: 'id', reviewRound: 1 });
    expect(runner.requests[0].systemPrompt).toContain('without modifying files');
  });

  it('does not persist system prompt in structured input', async () => {
    const runner = new ScriptedRunner();
    await new ReviewerAgent(runner).run({ workflow: workflow(), git, coder, tests, operationId: 'id', reviewRound: 1 });
    expect(runner.requests[0].input).not.toHaveProperty('systemPrompt');
  });

  it('overrides the model-provided round', async () => {
    const runner = new ScriptedRunner().push('reviewer', report({ round: 99 }));
    const result = await new ReviewerAgent(runner).run({
      workflow: workflow(), git, coder, tests, operationId: 'id', reviewRound: 2,
    });
    expect(result.round).toBe(2);
  });

  it('uses actual tester counts instead of reviewer claims', async () => {
    const runner = new ScriptedRunner().push('reviewer', report({ tests: { passed: 999, failed: 999 } }));
    const result = await new ReviewerAgent(runner).run({
      workflow: workflow(), git, coder,
      tests: { ...tests, passed: 7, failed: 2, skipped: 1 },
      operationId: 'id', reviewRound: 1,
    });
    expect(result.tests).toEqual({ passed: 7, failed: 2, skipped: 1 });
  });

  it('omits zero skipped count from the final report', async () => {
    const runner = new ScriptedRunner();
    const result = await new ReviewerAgent(runner).run({ workflow: workflow(), git, coder, tests, operationId: 'id', reviewRound: 1 });
    expect(result.tests).toEqual({ passed: 12, failed: 0 });
  });

  it('strips raw reviewer transport fields', async () => {
    const runner = new ScriptedRunner().push('reviewer', { ...report(), rawAssistant: 'SECRET' });
    const result = await new ReviewerAgent(runner).run({ workflow: workflow(), git, coder, tests, operationId: 'id', reviewRound: 1 });
    expect(result).not.toHaveProperty('rawAssistant');
  });

  it('requires a confirmed plan before calling the runner', async () => {
    const runner = new ScriptedRunner();
    await expect(new ReviewerAgent(runner).run({
      workflow: persistedWorkflow({ plan: null }), git, coder, tests, operationId: 'id', reviewRound: 1,
    })).rejects.toThrow('requires a confirmed execution plan');
    expect(runner.requests).toHaveLength(0);
  });

  it('propagates runner failures without a write fallback', async () => {
    const runner = new ScriptedRunner().push('reviewer', new Error('review failed'));
    await expect(new ReviewerAgent(runner).run({
      workflow: workflow(), git, coder, tests, operationId: 'id', reviewRound: 1,
    })).rejects.toThrow('review failed');
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0].permissionMode).toBe('plan');
  });

  const invalidReports: Array<[string, unknown]> = [
    ['null', null],
    ['prose', 'Looks good to me'],
    ['empty object', {}],
    ['missing score', { ...report(), score: undefined }],
    ['score above ten', { ...report(), score: 11 }],
    ['missing summary', { ...report(), summary: undefined }],
    ['bad issues', { ...report(), issues: 'none' }],
    ['bad severity', { ...report(), issues: [issue({ severity: 'fatal' as never })] }],
    ['bad tests', { ...report(), tests: { passed: -1, failed: 0 } }],
    ['bad line', { ...report(), issues: [issue({ line: 0 })] }],
  ];

  it.each(invalidReports)('rejects %s report', async (_label, output) => {
    const runner = new ScriptedRunner().push('reviewer', output);
    await expect(new ReviewerAgent(runner).run({
      workflow: workflow(), git, coder, tests, operationId: 'id', reviewRound: 1,
    })).rejects.toBeInstanceOf(StructuredOutputError);
  });
});
