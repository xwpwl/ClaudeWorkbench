import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaudeEventEnvelope,
  ClaudeRunOptions,
} from '../../../shared/types/claude';
import {
  parseCoderStageOutput,
  parseExecutionPlan,
  parseReviewReport,
  parseTesterStageOutput,
} from '../../workflows/StructuredJsonParser';
import { reviewRequiresFix } from '../../workflows/ReviewerAgent';
import {
  buildFakeWorkflowStageResponse,
  FAKE_WORKFLOW_TARGET_PATH,
  FakeClaudeAdapter,
} from '../FakeClaudeAdapter';

afterEach(() => {
  vi.useRealTimers();
});

function runOptions(overrides: Partial<ClaudeRunOptions> = {}): ClaudeRunOptions {
  return {
    runId: 'run-1',
    projectKey: 'C:/repo',
    sessionKey: 'C:/repo::task-1',
    projectPath: 'C:/repo',
    prompt: 'Build the Phase 6 workflow',
    permissionMode: 'default',
    ...overrides,
  };
}

async function collectRun(options: ClaudeRunOptions): Promise<ClaudeEventEnvelope[]> {
  vi.useFakeTimers();
  const adapter = new FakeClaudeAdapter();
  const events: ClaudeEventEnvelope[] = [];
  adapter.subscribe((event) => events.push(event));
  await adapter.runPrompt(options);
  await vi.runAllTimersAsync();
  return events;
}

describe('buildFakeWorkflowStageResponse', () => {
  it('returns a valid planner ExecutionPlan', () => {
    const response = buildFakeWorkflowStageResponse({
      workflowId: 'workflow-1', stage: 'planner', reviewRound: 0,
    });
    const parsed = parseExecutionPlan(response.result);
    expect(parsed).toMatchObject({
      title: expect.any(String), riskLevel: 'medium', filesExpected: [FAKE_WORKFLOW_TARGET_PATH],
    });
    expect(parsed.steps).toHaveLength(2);
  });

  it('does not claim a planner file change', () => {
    expect(buildFakeWorkflowStageResponse({
      workflowId: 'workflow-1', stage: 'planner', reviewRound: 0,
    }).fileChangedPath).toBeNull();
  });

  it('returns valid coder output', () => {
    const parsed = parseCoderStageOutput(buildFakeWorkflowStageResponse({
      workflowId: 'workflow-1', stage: 'coder', reviewRound: 1,
    }).result);
    expect(parsed).toEqual({
      summary: 'Completed workflow coder round 1.',
      filesChanged: [FAKE_WORKFLOW_TARGET_PATH],
      testsSuggested: ['npm test'],
    });
  });

  it('reports the fixed safe relative path only for coder', () => {
    const response = buildFakeWorkflowStageResponse({
      workflowId: 'workflow-1', stage: 'coder', reviewRound: 1,
    });
    expect(response.fileChangedPath).toBe(FAKE_WORKFLOW_TARGET_PATH);
    expect(path.isAbsolute(response.fileChangedPath!)).toBe(false);
    expect(response.fileChangedPath!.split('/')).not.toContain('..');
  });

  it('uses the requested coder fix round in its summary', () => {
    const parsed = parseCoderStageOutput(buildFakeWorkflowStageResponse({
      workflowId: 'workflow-1', stage: 'coder', reviewRound: 2,
    }).result);
    expect(parsed.summary).toContain('round 2');
  });

  it('normalizes a zero coder round to one', () => {
    const parsed = parseCoderStageOutput(buildFakeWorkflowStageResponse({
      workflowId: 'workflow-1', stage: 'coder', reviewRound: 0,
    }).result);
    expect(parsed.summary).toContain('round 1');
  });

  it('returns valid passing tester output', () => {
    const response = buildFakeWorkflowStageResponse({
      workflowId: 'workflow-1', stage: 'tester', reviewRound: 1,
    });
    expect(parseTesterStageOutput(response.result)).toEqual({
      summary: 'Deterministic fake tests passed.',
      passed: 1,
      failed: 0,
      skipped: 0,
      commands: ['npm test'],
    });
    expect(response.fileChangedPath).toBeNull();
  });

  it('returns one high issue in first reviewer round', () => {
    const parsed = parseReviewReport(buildFakeWorkflowStageResponse({
      workflowId: 'workflow-1', stage: 'reviewer', reviewRound: 1,
    }).result, 1);
    expect(parsed.issues).toEqual([
      expect.objectContaining({ severity: 'high', file: FAKE_WORKFLOW_TARGET_PATH }),
    ]);
    expect(reviewRequiresFix(parsed)).toBe(true);
  });

  it('returns a clean second reviewer round', () => {
    const parsed = parseReviewReport(buildFakeWorkflowStageResponse({
      workflowId: 'workflow-1', stage: 'reviewer', reviewRound: 2,
    }).result, 2);
    expect(parsed).toMatchObject({ round: 2, score: 10, issues: [], tests: { failed: 0 } });
    expect(reviewRequiresFix(parsed)).toBe(false);
  });

  it('keeps later reviewer rounds clean', () => {
    const parsed = parseReviewReport(buildFakeWorkflowStageResponse({
      workflowId: 'workflow-1', stage: 'reviewer', reviewRound: 3,
    }).result, 3);
    expect(parsed.issues).toEqual([]);
    expect(reviewRequiresFix(parsed)).toBe(false);
  });

  it('normalizes a zero reviewer round to one', () => {
    const value = JSON.parse(buildFakeWorkflowStageResponse({
      workflowId: 'workflow-1', stage: 'reviewer', reviewRound: 0,
    }).result) as { round: number; issues: unknown[] };
    expect(value.round).toBe(1);
    expect(value.issues).toHaveLength(1);
  });

  it.each(['planner', 'coder', 'tester', 'reviewer'] as const)(
    'is deterministic for %s',
    (stage) => {
      const context = { workflowId: 'workflow-1', stage, reviewRound: 1 };
      expect(buildFakeWorkflowStageResponse(context)).toEqual(buildFakeWorkflowStageResponse(context));
    },
  );

  it.each(['planner', 'coder', 'tester', 'reviewer'] as const)(
    'returns JSON without Markdown for %s',
    (stage) => {
      const result = buildFakeWorkflowStageResponse({
        workflowId: 'workflow-1', stage, reviewRound: 1,
      }).result;
      expect(() => JSON.parse(result)).not.toThrow();
      expect(result).not.toContain('```');
    },
  );
});

describe('FakeClaudeAdapter workflow events', () => {
  it.each([
    ['planner', 0],
    ['coder', 1],
    ['tester', 1],
    ['reviewer', 1],
    ['reviewer', 2],
  ] as const)('keeps assistant snapshot and terminal result identical for %s round %s', async (stage, reviewRound) => {
    const events = await collectRun(runOptions({
      workflowContext: { workflowId: 'workflow-1', stage, reviewRound },
    }));
    const assistant = events.find((item) => item.event.type === 'assistant_text')?.event;
    const terminal = events.find((item) => item.event.type === 'session_completed')?.event;
    expect(assistant).toMatchObject({ type: 'assistant_text', isSnapshot: true });
    expect(terminal).toMatchObject({ type: 'session_completed' });
    if (assistant?.type !== 'assistant_text' || terminal?.type !== 'session_completed') throw new Error('missing events');
    expect(terminal.result).toBe(assistant.text);
  });

  it('emits file_changed once for coder', async () => {
    const events = await collectRun(runOptions({
      workflowContext: { workflowId: 'workflow-1', stage: 'coder', reviewRound: 1 },
    }));
    expect(events.filter((item) => item.event.type === 'file_changed').map((item) => item.event))
      .toEqual([expect.objectContaining({
        type: 'file_changed',
        filePath: FAKE_WORKFLOW_TARGET_PATH,
        toolUseId: 'fake-workflow:run-1:coder',
      })]);
  });

  it.each(['planner', 'tester', 'reviewer'] as const)('does not emit file_changed for %s', async (stage) => {
    const events = await collectRun(runOptions({
      workflowContext: { workflowId: 'workflow-1', stage, reviewRound: 1 },
    }));
    expect(events.some((item) => item.event.type === 'file_changed')).toBe(false);
  });

  it('emits coder file_changed before its assistant snapshot and terminal', async () => {
    const events = await collectRun(runOptions({
      workflowContext: { workflowId: 'workflow-1', stage: 'coder', reviewRound: 1 },
    }));
    expect(events.map((item) => item.event.type)).toEqual([
      'session_started', 'system_init', 'file_changed', 'assistant_text', 'usage_updated', 'session_completed',
    ]);
  });

  it('preserves the provided resume session id', async () => {
    const events = await collectRun(runOptions({
      resumeSessionId: 'resume-session',
      workflowContext: { workflowId: 'workflow-1', stage: 'planner', reviewRound: 0 },
    }));
    expect(events.find((item) => item.event.type === 'session_started')?.event)
      .toMatchObject({ sessionId: 'resume-session' });
    expect(events.find((item) => item.event.type === 'session_completed')?.event)
      .toMatchObject({ sessionId: 'resume-session' });
  });

  it('preserves envelope project and session keys', async () => {
    const events = await collectRun(runOptions({
      projectKey: 'project-key', sessionKey: 'session-key',
      workflowContext: { workflowId: 'workflow-1', stage: 'tester', reviewRound: 1 },
    }));
    expect(events.every((item) => item.projectKey === 'project-key' && item.sessionKey === 'session-key')).toBe(true);
  });

  it('reports the selected model in system_init', async () => {
    const events = await collectRun(runOptions({
      model: 'fake-selected-model',
      workflowContext: { workflowId: 'workflow-1', stage: 'planner', reviewRound: 0 },
    }));
    expect(events.find((item) => item.event.type === 'system_init')?.event)
      .toMatchObject({ model: 'fake-selected-model' });
  });
});

describe('FakeClaudeAdapter ordinary compatibility and lifecycle', () => {
  it('keeps the ordinary non-workflow assistant text', async () => {
    const events = await collectRun(runOptions({ prompt: 'ordinary prompt' }));
    expect(events.find((item) => item.event.type === 'assistant_text')?.event)
      .toMatchObject({ text: '已收到任务：ordinary prompt', isSnapshot: true });
  });

  it('keeps ordinary terminal result absent', async () => {
    const events = await collectRun(runOptions());
    expect(events.find((item) => item.event.type === 'session_completed')?.event)
      .not.toHaveProperty('result');
  });

  it('does not emit file_changed for an ordinary fake run', async () => {
    const events = await collectRun(runOptions());
    expect(events.some((item) => item.event.type === 'file_changed')).toBe(false);
  });

  it('returns the ordinary fake run descriptor', async () => {
    vi.useFakeTimers();
    const adapter = new FakeClaudeAdapter();
    await expect(adapter.runPrompt(runOptions())).resolves.toEqual({ runId: 'run-1', pid: null });
    await adapter.stopAll();
  });

  it('rejects duplicate active run ids', async () => {
    vi.useFakeTimers();
    const adapter = new FakeClaudeAdapter();
    await adapter.runPrompt(runOptions());
    await expect(adapter.runPrompt(runOptions())).rejects.toThrow('Duplicate run id');
    await adapter.stopAll();
  });

  it('stopRun suppresses scheduled events', async () => {
    vi.useFakeTimers();
    const adapter = new FakeClaudeAdapter();
    const events: ClaudeEventEnvelope[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.runPrompt(runOptions());
    expect(await adapter.stopRun('run-1')).toBe(true);
    await vi.runAllTimersAsync();
    expect(events).toEqual([]);
  });

  it('stopRun returns false for an unknown run', async () => {
    expect(await new FakeClaudeAdapter().stopRun('missing')).toBe(false);
  });

  it('stopAll stops every active run', async () => {
    vi.useFakeTimers();
    const adapter = new FakeClaudeAdapter();
    const events: ClaudeEventEnvelope[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.runPrompt(runOptions({ runId: 'run-1' }));
    await adapter.runPrompt(runOptions({ runId: 'run-2' }));
    await adapter.stopAll();
    await vi.runAllTimersAsync();
    expect(events).toEqual([]);
    expect(await adapter.stopRun('run-1')).toBe(false);
    expect(await adapter.stopRun('run-2')).toBe(false);
  });

  it('unsubscribe stops event delivery', async () => {
    vi.useFakeTimers();
    const adapter = new FakeClaudeAdapter();
    const events: ClaudeEventEnvelope[] = [];
    const unsubscribe = adapter.subscribe((event) => events.push(event));
    await adapter.runPrompt(runOptions());
    unsubscribe();
    await vi.runAllTimersAsync();
    expect(events).toEqual([]);
  });

  it('allows a run id to be reused after terminal completion', async () => {
    vi.useFakeTimers();
    const adapter = new FakeClaudeAdapter();
    await adapter.runPrompt(runOptions());
    await vi.runAllTimersAsync();
    await expect(adapter.runPrompt(runOptions())).resolves.toEqual({ runId: 'run-1', pid: null });
    await adapter.stopAll();
  });
});
