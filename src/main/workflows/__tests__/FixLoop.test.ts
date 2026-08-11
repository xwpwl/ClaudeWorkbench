import { describe, expect, it } from 'vitest';
import type { ReviewIssue } from '../../../shared/types/workflow';
import { createWaiting, managerFixture, plan, report } from './helpers';

function issue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    severity: 'high',
    file: 'src/app.ts',
    line: 10,
    title: 'Bug remains',
    recommendation: 'Fix it',
    ...overrides,
  };
}

function changesRequested(round: number, overrides = {}) {
  return report({
    round,
    score: 6,
    summary: `Round ${round} needs changes`,
    issues: [issue()],
    ...overrides,
  });
}

describe('AgentWorkflowManager Fix Loop', () => {
  it('runs coder -> tester -> reviewer in every round', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), report({ round: 2 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.runner.requests.map((request) => request.stage)).toEqual([
      'planner', 'coder', 'tester', 'reviewer', 'coder', 'tester', 'reviewer',
    ]);
  });

  it('distinguishes fix passes with reviewRound', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), report({ round: 2 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.runner.requests.filter((request) => request.stage === 'coder').map((request) => request.reviewRound))
      .toEqual([1, 2]);
  });

  it('keeps fix passes as agentType coder', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), report({ round: 2 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    const fix = fixture.runner.requests.filter((request) => request.stage === 'coder')[1];
    expect(fix).toMatchObject({ stage: 'coder', agentType: 'coder' });
  });

  it('uses deterministic stage ids per review round', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), report({ round: 2 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.runner.requests.filter((request) => request.stage === 'coder').map((request) => request.operationId))
      .toEqual(['workflow-1:1:coder:1', 'workflow-1:1:coder:2']);
  });

  it('uses fixerModel after the first round', async () => {
    const fixture = managerFixture();
    await fixture.manager.createWorkflow({
      id: 'workflow-1', taskId: 'task-1', projectId: 'project-1', projectPath: 'C:/repo',
      prompt: 'Fix safely', currentPermissionMode: 'default',
      modelPolicy: { coderModel: 'coder-model', fixerModel: 'fixer-model' },
    });
    fixture.runner.push('reviewer', changesRequested(1), report({ round: 2 }));
    await fixture.manager.startPlanning('workflow-1');
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.runner.requests.filter((request) => request.stage === 'coder').map((request) => request.model))
      .toEqual(['coder-model', 'fixer-model']);
  });

  it('falls back to coderModel for a fix round', async () => {
    const fixture = managerFixture();
    await fixture.manager.createWorkflow({
      id: 'workflow-1', taskId: 'task-1', projectId: 'project-1', projectPath: 'C:/repo',
      prompt: 'Fix safely', currentPermissionMode: 'default', modelPolicy: { coderModel: 'coder-model' },
    });
    fixture.runner.push('reviewer', changesRequested(1), report({ round: 2 }));
    await fixture.manager.startPlanning('workflow-1');
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.runner.requests.filter((request) => request.stage === 'coder')[1].model).toBe('coder-model');
  });

  it.each(['default', 'acceptEdits', 'bypassPermissions'] as const)(
    'preserves user %s permission in every fix coder/tester stage',
    async (currentPermissionMode) => {
      const fixture = managerFixture();
      await fixture.manager.createWorkflow({
        id: 'workflow-1', taskId: 'task-1', projectId: 'project-1', projectPath: 'C:/repo',
        prompt: 'Fix safely', currentPermissionMode,
      });
      fixture.runner.push('reviewer', changesRequested(1), report({ round: 2 }));
      await fixture.manager.startPlanning('workflow-1');
      await fixture.manager.confirmPlan('workflow-1');
      const writable = fixture.runner.requests.filter((request) => ['coder', 'tester'].includes(request.stage));
      expect(writable.every((request) => request.permissionMode === currentPermissionMode)).toBe(true);
    },
  );

  it('keeps every reviewer pass read-only', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), report({ round: 2 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    for (const request of fixture.runner.requests.filter((item) => item.stage === 'reviewer')) {
      expect(request).toMatchObject({ agentMode: 'review', permissionMode: 'plan' });
    }
  });

  it('completes immediately when review is approved', async () => {
    const fixture = managerFixture();
    await createWaiting(fixture);
    const result = await fixture.manager.confirmPlan('workflow-1');
    expect(result).toMatchObject({ status: 'completed', reviewRound: 1, fixRound: 1 });
  });

  it('starts a second round for a high issue', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', report({ issues: [issue({ severity: 'high' })] }), report({ round: 2 }));
    await createWaiting(fixture);
    const result = await fixture.manager.confirmPlan('workflow-1');
    expect(result.status).toBe('completed');
    expect(fixture.runner.requests.filter((request) => request.stage === 'coder')).toHaveLength(2);
  });

  it('starts a second round for a low issue', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', report({ issues: [issue({ severity: 'low' })] }), report({ round: 2 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.runner.requests.filter((request) => request.stage === 'coder')).toHaveLength(2);
  });

  it('does not loop for a suggestion-only report', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', report({ issues: [issue({ severity: 'suggestion' })] }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.runner.requests.filter((request) => request.stage === 'coder')).toHaveLength(1);
  });

  it('does not loop for a resolved issue', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', report({ issues: [issue({ resolved: true })] }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.runner.requests.filter((request) => request.stage === 'coder')).toHaveLength(1);
  });

  it('loops for a low score without issues', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', report({ score: 7, issues: [] }), report({ round: 2 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.runner.requests.filter((request) => request.stage === 'coder')).toHaveLength(2);
  });

  it('loops when authoritative tester results fail', async () => {
    const fixture = managerFixture();
    fixture.runner.push(
      'tester',
      { summary: 'Failed', passed: 1, failed: 1, skipped: 0, commands: ['npm test'] },
      { summary: 'Passed', passed: 2, failed: 0, skipped: 0, commands: ['npm test'] },
    );
    fixture.runner.push('reviewer', report({ score: 10, issues: [] }), report({ round: 2 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.runner.requests.filter((request) => request.stage === 'coder')).toHaveLength(2);
  });

  it('persists each ReviewReport through the atomic review hook', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), report({ round: 2 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.persistence.reviewSaves.map((entry) => entry.review.round)).toEqual([1, 2]);
  });

  it('stores the latest approved review in the workflow snapshot', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), report({ round: 2, score: 10, summary: 'Approved' }));
    await createWaiting(fixture);
    const result = await fixture.manager.confirmPlan('workflow-1');
    expect(result.latestReview).toMatchObject({ round: 2, score: 10, summary: 'Approved' });
  });

  it('publishes one fix-loop event per extra round', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), report({ round: 3 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.events.filter((event) => event.type === 'workflow_fix_loop_started').map((event) => event.round))
      .toEqual([2, 3]);
  });

  it('creates before/after checkpoints for every coder round', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), report({ round: 3 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.checkpoints.filter((checkpoint) => checkpoint.stage === 'coder')).toHaveLength(6);
  });

  it('uses execute boundaries only for the first coder round', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), report({ round: 2 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.checkpoints.filter((checkpoint) => checkpoint.stage === 'coder')
      .map((checkpoint) => checkpoint.boundary)).toEqual([
      'before_execute', 'after_execute', 'before_fix', 'after_fix',
    ]);
  });

  it('creates before_review for every review round', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), report({ round: 3 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.checkpoints.filter((checkpoint) => checkpoint.boundary === 'before_review')
      .map((checkpoint) => checkpoint.round)).toEqual([1, 2, 3]);
  });

  it('creates before_plan and after_plan exactly once for an ordinary run', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), report({ round: 2 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.checkpoints.filter((checkpoint) => checkpoint.stage === 'planner')
      .map((checkpoint) => checkpoint.boundary)).toEqual(['before_plan', 'after_plan']);
  });

  it('pauses after the third changes-requested review', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), changesRequested(3));
    await createWaiting(fixture);
    const result = await fixture.manager.confirmPlan('workflow-1');
    expect(result).toMatchObject({ status: 'paused', pausedFrom: 'reviewing', reviewRound: 3, fixRound: 3 });
  });

  it('never starts a fourth coder round automatically', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), changesRequested(3));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.runner.requests.filter((request) => request.stage === 'coder').map((request) => request.reviewRound))
      .toEqual([1, 2, 3]);
  });

  it('prompts the user with a user-action-required event at the cap', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), changesRequested(3));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.events.filter((event) => event.type === 'workflow_user_action_required')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ reason: 'fix_loop_limit', rounds: 3 }) }),
    ]);
  });

  it('does not create a terminal checkpoint when waiting for user action', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), changesRequested(3));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.checkpoints.some((checkpoint) => checkpoint.boundary === 'terminal')).toBe(false);
  });

  it('resume without explicit authority leaves the capped workflow paused', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), changesRequested(3));
    await createWaiting(fixture);
    const paused = await fixture.manager.confirmPlan('workflow-1');
    const resumed = await fixture.manager.resume('workflow-1');
    expect(resumed.status).toBe('paused');
    expect(resumed.revision).toBe(paused.revision);
  });

  it('explicit authority returns capped workflow to plan confirmation', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), changesRequested(3));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    const resumed = await fixture.manager.resume('workflow-1', { allowAfterFixLimit: true });
    expect(resumed).toMatchObject({
      status: 'waiting_plan_confirmation', reviewRound: 0, fixRound: 0,
    });
  });

  it('a user-authorized new execution cycle gets fresh stage ids', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), changesRequested(3));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    await fixture.manager.resume('workflow-1', { allowAfterFixLimit: true });
    await fixture.manager.updatePlan('workflow-1', plan({ title: 'User revised after cap' }));
    const completed = await fixture.manager.confirmPlan('workflow-1');
    expect(completed.status).toBe('completed');
    const coderIds = fixture.runner.requests.filter((request) => request.stage === 'coder')
      .map((request) => request.operationId);
    expect(coderIds).toContain('workflow-1:1:coder:1');
    expect(coderIds).toContain('workflow-1:2:coder:1');
  });

  it('maxFixRounds one pauses after the first requested fix', async () => {
    const fixture = managerFixture();
    await fixture.manager.createWorkflow({
      id: 'one', taskId: 'task', projectId: 'project', projectPath: 'C:/repo', prompt: 'Goal',
      currentPermissionMode: 'default', maxFixRounds: 1,
    });
    fixture.runner.push('reviewer', changesRequested(1));
    await fixture.manager.startPlanning('one');
    const result = await fixture.manager.confirmPlan('one');
    expect(result).toMatchObject({ status: 'paused', reviewRound: 1 });
    expect(fixture.runner.requests.filter((request) => request.stage === 'coder')).toHaveLength(1);
  });

  it('maxFixRounds two permits exactly two rounds', async () => {
    const fixture = managerFixture();
    await fixture.manager.createWorkflow({
      id: 'two', taskId: 'task', projectId: 'project', projectPath: 'C:/repo', prompt: 'Goal',
      currentPermissionMode: 'default', maxFixRounds: 2,
    });
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2));
    await fixture.manager.startPlanning('two');
    const result = await fixture.manager.confirmPlan('two');
    expect(result).toMatchObject({ status: 'paused', reviewRound: 2 });
    expect(fixture.runner.requests.filter((request) => request.stage === 'coder')).toHaveLength(2);
  });

  it('forces persisted reviewer round to the manager round', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(99), report({ round: 99 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.persistence.reviewSaves.map((entry) => entry.review.round)).toEqual([1, 2]);
  });

  it('does not persist raw reviewer data across fix rounds', async () => {
    const fixture = managerFixture();
    fixture.runner.push(
      'reviewer',
      { ...changesRequested(1), rawAssistant: 'SECRET REVIEW TRANSCRIPT' },
      report({ round: 2 }),
    );
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(JSON.stringify([...fixture.persistence.stages.values()])).not.toContain('SECRET REVIEW TRANSCRIPT');
  });

  it('completed stage records retain round-specific structured outputs', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), report({ round: 2 }));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    expect(fixture.persistence.stages.get('workflow-1:1:reviewer:1')?.status).toBe('completed');
    expect(fixture.persistence.stages.get('workflow-1:1:reviewer:2')?.status).toBe('completed');
  });

  it('explicitly accepts unresolved review findings only at the fix cap', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), changesRequested(3));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    const accepted = await fixture.manager.acceptReview('workflow-1');
    expect(accepted.status).toBe('completed');
    expect(accepted.latestReview).toMatchObject({ round: 3, score: 6 });
  });

  it('acceptReview creates terminal checkpoint and events', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), changesRequested(3));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    await fixture.manager.acceptReview('workflow-1');
    expect(fixture.checkpoints.at(-1)).toMatchObject({ boundary: 'terminal' });
    expect(fixture.events.some((event) => event.type === 'workflow_review_accepted')).toBe(true);
    expect(fixture.events.some((event) => event.type === 'workflow_terminal')).toBe(true);
  });

  it('acceptReview is idempotent after explicit acceptance', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), changesRequested(3));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    const first = await fixture.manager.acceptReview('workflow-1');
    const second = await fixture.manager.acceptReview('workflow-1');
    expect(second.status).toBe('completed');
    expect(second.revision).toBe(first.revision);
    expect(new Set(fixture.checkpoints.filter((item) => item.boundary === 'terminal')
      .map((item) => item.idempotencyKey)).size).toBe(1);
  });

  it.each(['idle', 'waiting_plan_confirmation', 'completed'] as const)(
    'rejects acceptReview from %s without prior explicit acceptance',
    async (status) => {
      const fixture = managerFixture();
      if (status === 'idle') await createIdleForReview(fixture);
      else if (status === 'waiting_plan_confirmation') await createWaiting(fixture);
      else {
        await createWaiting(fixture);
        await fixture.manager.confirmPlan('workflow-1');
      }
      await expect(fixture.manager.acceptReview('workflow-1'))
        .rejects.toMatchObject({ code: 'USER_ACTION_REQUIRED' });
    },
  );

  it('rejects acceptReview for an ordinary user pause', async () => {
    const fixture = managerFixture();
    await createIdleForReview(fixture);
    await fixture.manager.pause('workflow-1');
    await expect(fixture.manager.acceptReview('workflow-1'))
      .rejects.toMatchObject({ code: 'USER_ACTION_REQUIRED' });
  });

  it('does not expose the internal reviewAccepted marker', async () => {
    const fixture = managerFixture();
    fixture.runner.push('reviewer', changesRequested(1), changesRequested(2), changesRequested(3));
    await createWaiting(fixture);
    await fixture.manager.confirmPlan('workflow-1');
    const accepted = await fixture.manager.acceptReview('workflow-1') as unknown as Record<string, unknown>;
    expect(accepted).not.toHaveProperty('reviewAccepted');
  });
});

async function createIdleForReview(fixture: ReturnType<typeof managerFixture>) {
  return fixture.manager.createWorkflow({
    id: 'workflow-1', taskId: 'task-1', projectId: 'project-1', projectPath: 'C:/repo',
    prompt: 'Review safely', currentPermissionMode: 'default',
  });
}
