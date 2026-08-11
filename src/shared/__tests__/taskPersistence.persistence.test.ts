import { describe, expect, it } from 'vitest';
import { hydratePersistedTasks } from '../taskPersistence';
import type { PersistedTaskEvent, PersistedTaskSnapshot } from '../types/workbench';

const BASE_TIME = '2025-01-01T00:00:00.000Z';

function event(
  id: string,
  type: string,
  payload: Record<string, unknown>,
  createdAt = BASE_TIME,
): PersistedTaskEvent {
  return { id, type, payload, createdAt };
}

function snapshot(overrides: Partial<PersistedTaskSnapshot> = {}): PersistedTaskSnapshot {
  return {
    sessionId: 'session-a',
    projectId: 'project-a',
    title: 'Persisted task',
    status: 'running',
    model: 'claude-test',
    permissionMode: 'default',
    agentMode: 'normal',
    startedAt: BASE_TIME,
    completedAt: null,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    permissionCount: 0,
    test: { status: null, command: null, output: null },
    fileChanges: [],
    totalAdditions: 0,
    totalDeletions: 0,
    events: [],
    eventTotal: 0,
    ...overrides,
  };
}

describe('hydratePersistedTasks persistence boundaries', () => {
  it('hydrates multiple runs independently without overwriting terminal results', () => {
    const state = hydratePersistedTasks(snapshot({
      status: 'failed',
      events: [
        event('run-a:000000', 'task_started', {
          type: 'task_started', runId: 'run-a', prompt: 'first prompt', agentMode: 'plan', timestamp: 100,
        }),
        event('run-a:000001', 'usage_updated', {
          type: 'usage_updated', runId: 'run-a', inputTokens: 7, outputTokens: 3, totalTokens: 10, timestamp: 110,
        }),
        event('run-a:000002', 'session_completed', {
          type: 'session_completed', runId: 'run-a', sessionId: 'claude-a', duration: 20, result: 'first done', timestamp: 120,
        }),
        event('run-b:000000', 'task_started', {
          type: 'task_started', runId: 'run-b', prompt: 'second prompt', agentMode: 'develop', timestamp: 200,
        }),
        event('run-b:000001', 'session_started', {
          type: 'session_started', runId: 'run-b', sessionId: 'claude-b', timestamp: 210,
        }),
        event('run-b:000002', 'session_failed', {
          type: 'session_failed', runId: 'run-b', sessionId: 'claude-b', error: 'second failed', duration: 15, timestamp: 225,
        }),
      ],
      eventTotal: 6,
    }));

    expect(state.taskOrder).toEqual(['run-a', 'run-b']);
    expect(state.tasksById['run-a']).toMatchObject({
      prompt: 'first prompt', agentMode: 'plan', status: 'completed', durationMs: 20,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      result: { kind: 'completed', markdown: 'first done' },
    });
    expect(state.tasksById['run-b']).toMatchObject({
      prompt: 'second prompt', agentMode: 'develop', status: 'failed', durationMs: 15,
      result: { kind: 'failed', error: 'second failed' },
    });
    expect(state.timeline.map((entry) => [entry.runId, entry.sequence])).toEqual([
      ['run-a', 1],
      ['run-a', 2],
      ['run-b', 1],
      ['run-b', 2],
    ]);
  });

  it('hydrates a paginated fragment that does not include task_started', () => {
    const state = hydratePersistedTasks(snapshot({
      events: [event('run-fragment:000042', 'tool_started', {
        type: 'tool_started', runId: 'run-fragment', toolName: 'Read', toolUseId: 'tool-1', timestamp: 420,
      })],
      eventTotal: 100,
    }));

    expect(state.taskOrder).toEqual(['run-fragment']);
    expect(state.tasksById['run-fragment']).toMatchObject({
      prompt: 'Persisted task', status: 'running', startedAt: 420,
    });
    expect(state.timeline[0]).toMatchObject({ runId: 'run-fragment', sequence: 42 });
  });

  it('derives a run id containing colons from the persisted event id', () => {
    const state = hydratePersistedTasks(snapshot({
      events: [event('project:session:run:000007', 'usage_updated', {
        type: 'usage_updated', inputTokens: 2, outputTokens: 1, totalTokens: 3, timestamp: 700,
      })],
      eventTotal: 1,
    }));

    expect(state.taskOrder).toEqual(['project:session:run']);
    expect(state.tasksById['project:session:run'].usage).toEqual({
      inputTokens: 2, outputTokens: 1, totalTokens: 3,
    });
    expect(state.timeline[0].sequence).toBe(7);
  });

  it('uses a stable persisted fallback id when an event id has no sequence separator', () => {
    const state = hydratePersistedTasks(snapshot({
      events: [event('orphan-event', 'session_started', {
        type: 'session_started', sessionId: 'claude-orphan', timestamp: 10,
      })],
      eventTotal: 1,
    }));

    expect(state.taskOrder).toEqual(['persisted:orphan-event']);
    expect(state.tasksById['persisted:orphan-event'].claudeSessionId).toBe('claude-orphan');
  });

  it('ignores unknown persisted event types without creating phantom tasks', () => {
    const state = hydratePersistedTasks(snapshot({
      eventOffset: 0,
      events: [event('run-a:000001', 'provider_private_event', {
        type: 'provider_private_event', runId: 'run-a', secret: 'opaque',
      })],
      eventTotal: 20,
    }));

    expect(state).toEqual({ tasksById: {}, taskOrder: [], timeline: [] });
  });

  it('falls back to createdAt when a persisted event timestamp is invalid', () => {
    const createdAt = '2025-02-03T04:05:06.000Z';
    const state = hydratePersistedTasks(snapshot({
      events: [event('run-a:000001', 'session_started', {
        type: 'session_started', runId: 'run-a', sessionId: 'claude-a', timestamp: null,
      }, createdAt)],
      eventTotal: 1,
    }));

    expect(state.timeline[0].timestamp).toBe(Date.parse(createdAt));
    expect(state.tasksById['run-a'].startedAt).toBe(Date.parse(createdAt));
  });

  it('retains usage and permission denials on a completed terminal event', () => {
    const state = hydratePersistedTasks(snapshot({
      status: 'completed',
      events: [
        event('run-a:000001', 'usage_updated', {
          type: 'usage_updated', runId: 'run-a', inputTokens: 11, outputTokens: 4, totalTokens: 15, timestamp: 100,
        }),
        event('run-a:000002', 'session_completed', {
          type: 'session_completed', runId: 'run-a', sessionId: 'claude-a', duration: 90,
          result: '# Finished', permissionDenials: [{ toolName: 'WebFetch', reason: 'denied' }], timestamp: 190,
        }),
      ],
      eventTotal: 2,
    }));

    expect(state.tasksById['run-a']).toMatchObject({
      status: 'completed', durationMs: 90,
      usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
      result: {
        kind: 'completed', markdown: '# Finished',
        permissionDenials: [{ toolName: 'WebFetch', reason: 'denied' }],
      },
    });
  });

  it('does not let a late usage event resurrect or replace a terminal run', () => {
    const state = hydratePersistedTasks(snapshot({
      status: 'completed',
      events: [
        event('run-a:000001', 'session_completed', {
          type: 'session_completed', runId: 'run-a', sessionId: 'claude-a', duration: 5, result: 'done', timestamp: 105,
        }),
        event('run-a:000002', 'usage_updated', {
          type: 'usage_updated', runId: 'run-a', inputTokens: 99, outputTokens: 1, totalTokens: 100, timestamp: 110,
        }),
      ],
      eventTotal: 2,
    }));

    expect(state.tasksById['run-a']).toMatchObject({
      status: 'completed', result: { kind: 'completed', markdown: 'done' }, usage: null,
    });
    expect(state.timeline).toHaveLength(2);
  });

  it('builds a fixed completed fallback from snapshot statistics when no events exist', () => {
    const state = hydratePersistedTasks(snapshot({
      status: 'completed',
      completedAt: '2025-01-01T00:01:00.000Z',
      durationMs: 60_000,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      test: { status: 'passed', command: 'npm test', output: '47 passed' },
      fileChanges: [
        { id: 'f1', filePath: 'a.ts', changeType: 'modified', additions: 3, deletions: 1, oldContent: null, newContent: null, isBinary: false, createdAt: BASE_TIME },
        { id: 'f2', filePath: 'b.ts', changeType: 'added', additions: 2, deletions: 2, oldContent: null, newContent: null, isBinary: false, createdAt: BASE_TIME },
      ],
      totalAdditions: 5,
      totalDeletions: 3,
    }));

    expect(state.taskOrder).toEqual(['persisted:session-a']);
    expect(state.tasksById['persisted:session-a']).toMatchObject({
      status: 'completed', durationMs: 60_000,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      result: { kind: 'completed' },
    });
    expect(state.tasksById['persisted:session-a'].result).toMatchObject({
      markdown: expect.stringContaining('已修改 2 个文件（+5 / -3）'),
    });
    expect(state.tasksById['persisted:session-a'].result).toMatchObject({
      markdown: expect.stringContaining('测试：npm test\n47 passed'),
    });
  });

  it.each([
    ['failed', 'failed', '任务失败（已从本地记录恢复）'],
    ['cancelled', 'cancelled', '任务已停止'],
  ] as const)('maps an eventless %s snapshot to a terminal fallback', (snapshotStatus, taskStatus, message) => {
    const state = hydratePersistedTasks(snapshot({ status: snapshotStatus }));
    const task = state.tasksById['persisted:session-a'];

    expect(task.status).toBe(taskStatus);
    expect(JSON.stringify(task.result)).toContain(message);
  });

  it('reconciles a latest nonterminal run from terminal snapshot metadata', () => {
    const state = hydratePersistedTasks(snapshot({
      status: 'completed',
      completedAt: '2025-01-01T00:00:30.000Z',
      durationMs: 30_000,
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      totalAdditions: 4,
      totalDeletions: 1,
      events: [event('run-a:000000', 'task_started', {
        type: 'task_started', runId: 'run-a', prompt: 'started but terminal event missing', timestamp: 100,
      })],
      eventTotal: 1,
    }));

    expect(state.tasksById['run-a']).toMatchObject({
      status: 'completed', completedAt: Date.parse('2025-01-01T00:00:30.000Z'), durationMs: 30_000,
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    });
  });

  it('does not apply session terminal fallback to an older pagination fragment', () => {
    const state = hydratePersistedTasks(snapshot({
      status: 'completed',
      completedAt: '2025-01-01T00:10:00.000Z',
      durationMs: 600_000,
      eventOffset: 0,
      events: [
        event('old-run:000000', 'task_started', {
          type: 'task_started', runId: 'old-run', prompt: 'older run', timestamp: 100,
        }),
        event('old-run:000001', 'session_started', {
          type: 'session_started', runId: 'old-run', sessionId: 'claude-old', timestamp: 110,
        }),
      ],
      eventTotal: 50,
    }));

    const task = state.tasksById['old-run'];
    expect(task).toMatchObject({ status: 'running', prompt: 'older run', result: null });
    expect(task.completedAt).toBeUndefined();
  });

  it('does not invent a task for an idle snapshot with no events', () => {
    expect(hydratePersistedTasks(snapshot({ status: 'idle' }))).toEqual({
      tasksById: {}, taskOrder: [], timeline: [],
    });
  });
});
