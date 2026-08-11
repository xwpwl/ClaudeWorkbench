import { describe, expect, it } from 'vitest';
import {
  appendTimelineEntry,
  createTaskRecord,
  formatTaskDuration,
  presentTimelineEntry,
  selectTaskTimeline,
  selectTimelinePresentations,
  taskResultFileName,
  taskResultToMarkdown,
  taskToolKey,
} from '../taskState';
import type { TaskRecord, TaskTimelineEntry, TaskTimelineEvent } from '../types/task';

function task(runId = 'run-a', overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTaskRecord({
      runId,
      projectKey: 'c:/project',
      sessionKey: 'c:/project::session-a',
      prompt: 'Do work',
      agentMode: 'normal',
      startedAt: 100,
    }),
    ...overrides,
  };
}

function entry(event: TaskTimelineEvent, runId = 'run-a'): TaskTimelineEntry {
  return appendTimelineEntry([], task(runId), event)[0];
}

describe('task timeline and result selectors', () => {
  it('creates a stable first timeline id', () => {
    expect(entry({ type: 'session_started', sessionId: '', timestamp: 1 }).id).toBe('run-a:1');
  });

  it('increments sequence monotonically within a run', () => {
    const first = appendTimelineEntry([], task(), { type: 'session_started', sessionId: '', timestamp: 1 });
    const second = appendTimelineEntry(first, task(), { type: 'assistant_text', text: 'x', timestamp: 2 });
    expect(second.map((item) => item.sequence)).toEqual([1, 2]);
  });

  it('keeps distinct events that share a timestamp', () => {
    const first = appendTimelineEntry([], task(), { type: 'session_started', sessionId: '', timestamp: 1 });
    const second = appendTimelineEntry(first, task(), { type: 'system_init', sessionId: 's', model: 'm', timestamp: 1 });
    expect(second.map((item) => item.id)).toEqual(['run-a:1', 'run-a:2']);
  });

  it('maintains independent sequences for concurrent runs', () => {
    let timeline = appendTimelineEntry([], task('run-a'), { type: 'session_started', sessionId: '', timestamp: 1 });
    timeline = appendTimelineEntry(timeline, task('run-b'), { type: 'session_started', sessionId: '', timestamp: 2 });
    timeline = appendTimelineEntry(timeline, task('run-a'), { type: 'assistant_text', text: 'a', timestamp: 3 });
    expect(timeline.map((item) => item.id)).toEqual(['run-a:1', 'run-b:1', 'run-a:2']);
  });

  it('does not mutate the prior timeline array', () => {
    const timeline = appendTimelineEntry([], task(), { type: 'session_started', sessionId: '', timestamp: 1 });
    appendTimelineEntry(timeline, task(), { type: 'assistant_text', text: 'a', timestamp: 2 });
    expect(timeline).toHaveLength(1);
  });

  it('filters timeline entries by run id', () => {
    let timeline = appendTimelineEntry([], task('run-a'), { type: 'session_started', sessionId: '', timestamp: 1 });
    timeline = appendTimelineEntry(timeline, task('run-b'), { type: 'session_started', sessionId: '', timestamp: 2 });
    expect(selectTaskTimeline(timeline, 'run-b').map((item) => item.runId)).toEqual(['run-b']);
  });

  it('builds composite tool keys from run and tool identity', () => {
    expect(taskToolKey('run-a', 'tool-1')).toBe('run-a:tool-1');
    expect(taskToolKey('run-b', 'tool-1')).not.toBe(taskToolKey('run-a', 'tool-1'));
  });

  it('hides assistant text from the work timeline', () => {
    expect(presentTimelineEntry(entry({ type: 'assistant_text', text: 'answer', timestamp: 1 }))).toBeNull();
  });

  it('hides thinking content from the work timeline', () => {
    expect(presentTimelineEntry(entry({ type: 'thinking_content', text: 'private', timestamp: 1 }))).toBeNull();
  });

  it('hides usage snapshots because the task header presents them', () => {
    expect(presentTimelineEntry(entry({ type: 'usage_updated', totalTokens: 10, timestamp: 1 }))).toBeNull();
  });

  it('hides informational stderr noise', () => {
    expect(presentTimelineEntry(entry({ type: 'stderr', text: 'note', level: 'info', timestamp: 1 }))).toBeNull();
  });

  it('presents warning diagnostics with warning tone', () => {
    expect(presentTimelineEntry(entry({ type: 'stderr', text: 'careful', level: 'warning', timestamp: 1 })))
      .toMatchObject({ title: '运行诊断警告', detail: 'careful', tone: 'warning' });
  });

  it('presents error diagnostics with error tone', () => {
    expect(presentTimelineEntry(entry({ type: 'stderr', text: 'broken', level: 'error', timestamp: 1 })))
      .toMatchObject({ title: '运行诊断错误', detail: 'broken', tone: 'error' });
  });

  it('presents session startup as a lifecycle item', () => {
    expect(presentTimelineEntry(entry({ type: 'session_started', sessionId: '', timestamp: 1 })))
      .toMatchObject({ title: '任务已启动', tone: 'info' });
  });

  it('presents system initialization with the detected model', () => {
    expect(presentTimelineEntry(entry({ type: 'system_init', sessionId: 's', model: 'opus', timestamp: 1 })))
      .toMatchObject({ title: 'Claude 已连接', detail: 'opus' });
  });

  it('uses a human label for a Read tool start', () => {
    expect(presentTimelineEntry(entry({
      type: 'tool_started', toolName: 'Read', toolUseId: 'tool-a', input: { file_path: 'a.ts' }, timestamp: 1,
    }))).toMatchObject({ title: '读取文件开始', tone: 'info', toolUseId: 'tool-a' });
  });

  it('presents tool completion as success', () => {
    expect(presentTimelineEntry(entry({
      type: 'tool_completed', toolName: 'WebSearch', toolUseId: 'tool-a', output: 'found', timestamp: 1,
    }))).toMatchObject({ title: '联网搜索完成', detail: 'found', tone: 'success' });
  });

  it('presents tool failure with its actionable error', () => {
    expect(presentTimelineEntry(entry({
      type: 'tool_failed', toolName: 'Write', toolUseId: 'tool-a', error: 'denied', timestamp: 1,
    }))).toMatchObject({ title: '写入文件失败', detail: 'denied', tone: 'error' });
  });

  it('presents a command without dumping a generic tool title', () => {
    expect(presentTimelineEntry(entry({
      type: 'command_started', command: 'npm test', toolUseId: 'tool-a', timestamp: 1,
    }))).toMatchObject({ title: '运行命令', detail: 'npm test' });
  });

  it('presents a changed file path', () => {
    expect(presentTimelineEntry(entry({
      type: 'file_changed', filePath: 'src/a.ts', toolUseId: 'tool-a', timestamp: 1,
    }))).toMatchObject({ title: '修改文件', detail: 'src/a.ts', tone: 'warning' });
  });

  it('presents permission waiting with risk', () => {
    expect(presentTimelineEntry(entry({
      type: 'permission_waiting', requestId: 'r', toolName: 'Bash', risk: 'high', timestamp: 1,
    }))).toMatchObject({ title: '等待授权：运行命令', detail: '风险等级：high', tone: 'warning' });
  });

  it('presents permission settlement without claiming allow or deny', () => {
    expect(presentTimelineEntry(entry({
      type: 'permission_settled', requestId: 'r', toolName: 'Bash', timestamp: 1,
    }))).toMatchObject({ title: '授权请求已处理：运行命令', tone: 'neutral' });
  });

  it('presents successful terminal state', () => {
    expect(presentTimelineEntry(entry({
      type: 'session_completed', sessionId: 's', duration: 1, timestamp: 1,
    }))).toMatchObject({ title: '任务已完成', tone: 'success' });
  });

  it('presents failed terminal state with its error', () => {
    expect(presentTimelineEntry(entry({
      type: 'session_failed', error: 'boom', timestamp: 1,
    }))).toMatchObject({ title: '任务运行失败', detail: 'boom', tone: 'error' });
  });

  it('presents renderer startup failure separately', () => {
    expect(presentTimelineEntry(entry({
      type: 'task_start_failed', error: 'no cli', timestamp: 1,
    }))).toMatchObject({ title: '任务启动失败', detail: 'no cli' });
  });

  it('presents explicit cancellation separately', () => {
    expect(presentTimelineEntry(entry({
      type: 'task_cancelled', reason: 'stop', timestamp: 1,
    }))).toMatchObject({ title: '任务已停止', detail: 'stop' });
  });

  it('suppresses a generic tool start when a specialized event represents it', () => {
    let timeline = appendTimelineEntry([], task(), {
      type: 'tool_started', toolName: 'Bash', toolUseId: 'tool-a', input: { command: 'pwd' }, timestamp: 1,
    });
    timeline = appendTimelineEntry(timeline, task(), {
      type: 'command_started', command: 'pwd', toolUseId: 'tool-a', timestamp: 1,
    });
    expect(selectTimelinePresentations(timeline).map((item) => item.title)).toEqual(['运行命令']);
  });

  it('retains a generic tool start when no specialized event exists', () => {
    const timeline = appendTimelineEntry([], task(), {
      type: 'tool_started', toolName: 'WebSearch', toolUseId: 'tool-a', timestamp: 1,
    });
    expect(selectTimelinePresentations(timeline).map((item) => item.title)).toEqual(['联网搜索开始']);
  });

  it('formats millisecond durations', () => {
    expect(formatTaskDuration(240)).toBe('240 ms');
  });

  it('formats second durations', () => {
    expect(formatTaskDuration(1_500)).toBe('2 秒');
  });

  it('formats minute durations', () => {
    expect(formatTaskDuration(62_000)).toBe('1 分 02 秒');
  });

  it('returns a placeholder for unknown duration', () => {
    expect(formatTaskDuration()).toBe('—');
  });

  it('keeps successful provider markdown at the top of an export', () => {
    const completed = task('run-a', {
      status: 'completed', durationMs: 50, result: { kind: 'completed', markdown: '# Done', permissionDenials: [] },
    });
    expect(taskResultToMarkdown(completed).startsWith('# Done')).toBe(true);
  });

  it('creates explicit markdown when success has no text', () => {
    const completed = task('run-a', {
      status: 'completed', result: { kind: 'completed', markdown: null, permissionDenials: [] },
    });
    expect(taskResultToMarkdown(completed)).toContain('Claude 未返回额外结果文本');
  });

  it('creates failure markdown from the error', () => {
    const failed = task('run-a', {
      status: 'failed', result: { kind: 'failed', error: 'broken', permissionDenials: [] },
    });
    expect(taskResultToMarkdown(failed)).toContain('# 任务失败\n\nbroken');
  });

  it('creates cancellation markdown from the reason', () => {
    const cancelled = task('run-a', {
      status: 'cancelled', result: { kind: 'cancelled', reason: 'user stop', permissionDenials: [] },
    });
    expect(taskResultToMarkdown(cancelled)).toContain('user stop');
  });

  it('includes usage in result markdown', () => {
    const completed = task('run-a', {
      status: 'completed',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      result: { kind: 'completed', markdown: 'done', permissionDenials: [] },
    });
    expect(taskResultToMarkdown(completed)).toContain('10 输入 / 5 输出 / 15 总计');
  });

  it('includes permission denials in result markdown', () => {
    const completed = task('run-a', {
      status: 'completed',
      result: {
        kind: 'completed', markdown: 'done', permissionDenials: [{ toolName: 'WebSearch', reason: 'disabled' }],
      },
    });
    expect(taskResultToMarkdown(completed)).toContain('WebSearch：disabled');
  });

  it('returns empty markdown for a non-terminal task', () => {
    expect(taskResultToMarkdown(task())).toBe('');
  });

  it('sanitizes a run id for Markdown export', () => {
    expect(taskResultFileName(task('run:a / b'))).toBe('task-run-a-b.md');
  });
});
