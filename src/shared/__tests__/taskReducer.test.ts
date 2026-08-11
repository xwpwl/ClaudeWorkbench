import { describe, expect, it } from 'vitest';
import {
  createTaskRecord,
  isTaskTerminal,
  reduceTaskEvent,
  selectActiveOrLatestTask,
  selectLatestTask,
  selectOrderedTasks,
} from '../taskState';
import type { TaskRecord } from '../types/task';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTaskRecord({
      runId: 'run-a',
      projectKey: 'c:/project',
      sessionKey: 'c:/project::session-a',
      prompt: 'Build the feature',
      agentMode: 'normal',
      userMessageId: 'message-a',
      model: 'claude-test',
      startedAt: 100,
    }),
    ...overrides,
  };
}

describe('task state reducer', () => {
  it('creates a starting task whose id is the run id', () => {
    const task = makeTask();
    expect(task).toMatchObject({ id: 'run-a', runId: 'run-a', status: 'starting' });
  });

  it('records immutable project and session routing identity', () => {
    const task = makeTask();
    expect(task.projectKey).toBe('c:/project');
    expect(task.sessionKey).toBe('c:/project::session-a');
  });

  it('records prompt and user message identity', () => {
    expect(makeTask()).toMatchObject({ prompt: 'Build the feature', userMessageId: 'message-a' });
  });

  it('defaults an empty agent mode to normal', () => {
    const task = createTaskRecord({
      runId: 'run-a', projectKey: 'p', sessionKey: 's', prompt: 'x', agentMode: '   ', startedAt: 1,
    });
    expect(task.agentMode).toBe('normal');
  });

  it('preserves a non-default agent mode', () => {
    const task = createTaskRecord({
      runId: 'run-a', projectKey: 'p', sessionKey: 's', prompt: 'x', agentMode: 'plan', startedAt: 1,
    });
    expect(task.agentMode).toBe('plan');
  });

  it('uses the supplied start time for all initial timestamps', () => {
    const task = makeTask();
    expect([task.createdAt, task.startedAt, task.updatedAt]).toEqual([100, 100, 100]);
  });

  it('moves from starting to running on session_started', () => {
    const task = reduceTaskEvent(makeTask(), {
      type: 'session_started', sessionId: 'claude-a', timestamp: 110,
    });
    expect(task).toMatchObject({ status: 'running', claudeSessionId: 'claude-a', updatedAt: 110 });
  });

  it('does not replace a known Claude session id with an empty start id', () => {
    const task = reduceTaskEvent(makeTask({ claudeSessionId: 'known' }), {
      type: 'session_started', sessionId: '', timestamp: 110,
    });
    expect(task.claudeSessionId).toBe('known');
  });

  it('captures model and Claude session identity from system_init', () => {
    const task = reduceTaskEvent(makeTask(), {
      type: 'system_init', sessionId: 'claude-b', model: 'opus', timestamp: 120,
    });
    expect(task).toMatchObject({ status: 'running', claudeSessionId: 'claude-b', model: 'opus' });
  });

  it('treats assistant activity as evidence that the task is running', () => {
    const task = reduceTaskEvent(makeTask(), {
      type: 'assistant_text', text: 'working', timestamp: 120,
    });
    expect(task.status).toBe('running');
  });

  it('treats tool activity as evidence that the task is running', () => {
    const task = reduceTaskEvent(makeTask(), {
      type: 'tool_started', toolName: 'Read', toolUseId: 'tool-a', timestamp: 120,
    });
    expect(task.status).toBe('running');
  });

  it('keeps permission waiting as a running task state', () => {
    const task = reduceTaskEvent(makeTask(), {
      type: 'permission_waiting', requestId: 'request-a', toolName: 'Write', risk: 'high', timestamp: 120,
    });
    expect(task.status).toBe('running');
  });

  it('normalizes absent usage fields to zero', () => {
    const task = reduceTaskEvent(makeTask(), { type: 'usage_updated', timestamp: 120 });
    expect(task.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('replaces usage with the latest provider snapshot', () => {
    const prior = makeTask({ usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } });
    const task = reduceTaskEvent(prior, {
      type: 'usage_updated', inputTokens: 10, outputTokens: 4, totalTokens: 14, timestamp: 130,
    });
    expect(task.usage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  });

  it('maps a successful terminal event to a completed result', () => {
    const task = reduceTaskEvent(makeTask(), {
      type: 'session_completed', sessionId: 'claude-a', duration: 250, result: '# Done', timestamp: 350,
    });
    expect(task).toMatchObject({ status: 'completed', completedAt: 350, durationMs: 250 });
    expect(task.result).toEqual({ kind: 'completed', markdown: '# Done', permissionDenials: [] });
  });

  it('retains an explicitly empty successful result as empty markdown', () => {
    const task = reduceTaskEvent(makeTask(), {
      type: 'session_completed', sessionId: 'claude-a', duration: 1, result: '', timestamp: 101,
    });
    expect(task.result).toMatchObject({ kind: 'completed', markdown: '' });
  });

  it('uses null when a successful terminal event has no result text', () => {
    const task = reduceTaskEvent(makeTask(), {
      type: 'session_completed', sessionId: 'claude-a', duration: 1, timestamp: 101,
    });
    expect(task.result).toMatchObject({ kind: 'completed', markdown: null });
  });

  it('copies permission denials onto a completed result', () => {
    const denials = [{ toolName: 'WebSearch', reason: 'not allowed' }];
    const task = reduceTaskEvent(makeTask(), {
      type: 'session_completed', sessionId: 'claude-a', duration: 1, permissionDenials: denials, timestamp: 101,
    });
    expect(task.result?.permissionDenials).toEqual(denials);
    expect(task.result?.permissionDenials).not.toBe(denials);
  });

  it('maps a failed terminal event to a failed result', () => {
    const task = reduceTaskEvent(makeTask(), {
      type: 'session_failed', error: 'boom', duration: 44, timestamp: 144,
    });
    expect(task).toMatchObject({ status: 'failed', durationMs: 44, completedAt: 144 });
    expect(task.result).toEqual({ kind: 'failed', error: 'boom', permissionDenials: [] });
  });

  it('derives failed duration when the provider omits it', () => {
    const task = reduceTaskEvent(makeTask(), {
      type: 'session_failed', error: 'boom', timestamp: 275,
    });
    expect(task.durationMs).toBe(175);
  });

  it('maps a renderer startup failure to a failed result', () => {
    const task = reduceTaskEvent(makeTask(), {
      type: 'task_start_failed', error: 'spawn rejected', timestamp: 140,
    });
    expect(task).toMatchObject({ status: 'failed', durationMs: 40 });
    expect(task.result).toMatchObject({ kind: 'failed', error: 'spawn rejected' });
  });

  it('maps a successful stop to a cancelled result', () => {
    const task = reduceTaskEvent(makeTask({ status: 'running' }), {
      type: 'task_cancelled', reason: '用户停止了任务', timestamp: 180,
    });
    expect(task).toMatchObject({ status: 'cancelled', durationMs: 80 });
    expect(task.result).toMatchObject({ kind: 'cancelled', reason: '用户停止了任务' });
  });

  it('does not overwrite a completed task with a late failure', () => {
    const completed = reduceTaskEvent(makeTask(), {
      type: 'session_completed', sessionId: 'claude-a', duration: 10, result: 'done', timestamp: 110,
    });
    expect(reduceTaskEvent(completed, {
      type: 'session_failed', error: 'late', timestamp: 120,
    })).toBe(completed);
  });

  it('does not overwrite a failed task with a late completion', () => {
    const failed = reduceTaskEvent(makeTask(), {
      type: 'session_failed', error: 'first', timestamp: 110,
    });
    expect(reduceTaskEvent(failed, {
      type: 'session_completed', sessionId: 'claude-a', duration: 20, timestamp: 120,
    })).toBe(failed);
  });

  it('does not resurrect a cancelled task on a late Claude event', () => {
    const cancelled = reduceTaskEvent(makeTask(), {
      type: 'task_cancelled', reason: 'stop', timestamp: 110,
    });
    expect(reduceTaskEvent(cancelled, {
      type: 'assistant_text', text: 'late', timestamp: 120,
    })).toBe(cancelled);
  });

  it('recognizes exactly the three terminal task statuses', () => {
    expect(['completed', 'failed', 'cancelled'].map((status) => isTaskTerminal(status as TaskRecord['status'])))
      .toEqual([true, true, true]);
    expect(['starting', 'running'].map((status) => isTaskTerminal(status as TaskRecord['status'])))
      .toEqual([false, false]);
  });

  it('selects tasks in explicit order and skips missing ids', () => {
    const first = makeTask({ id: 'run-a', runId: 'run-a' });
    const second = makeTask({ id: 'run-b', runId: 'run-b' });
    expect(selectOrderedTasks({ 'run-a': first, 'run-b': second }, ['run-b', 'missing', 'run-a']))
      .toEqual([second, first]);
  });

  it('selects the latest existing task', () => {
    const first = makeTask({ id: 'run-a', runId: 'run-a' });
    const second = makeTask({ id: 'run-b', runId: 'run-b' });
    expect(selectLatestTask({ 'run-a': first, 'run-b': second }, ['run-a', 'missing', 'run-b']))
      .toBe(second);
  });

  it('prefers an active task over the latest terminal task', () => {
    const first = makeTask({ id: 'run-a', runId: 'run-a', status: 'completed' });
    const second = makeTask({ id: 'run-b', runId: 'run-b' });
    expect(selectActiveOrLatestTask({ 'run-a': first, 'run-b': second }, ['run-b', 'run-a'], 'run-b'))
      .toBe(second);
  });
});
