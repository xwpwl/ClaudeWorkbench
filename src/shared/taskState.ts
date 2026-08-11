import type { ClaudeEvent } from './types/claude';
import {
  DEFAULT_TASK_AGENT_MODE,
  type TaskRecord,
  type TaskResult,
  type TaskStartInput,
  type TaskStatus,
  type TaskTimelineEntry,
  type TaskTimelineEvent,
  type TimelinePresentation,
} from './types/task';

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

const SPECIALIZED_TOOL_STARTS: ReadonlySet<string> = new Set([
  'command_started',
  'file_read',
  'file_changed',
]);

function elapsed(task: TaskRecord, timestamp: number): number {
  return Math.max(0, timestamp - task.startedAt);
}

function permissionDenials(event: ClaudeEvent): TaskResult['permissionDenials'] {
  if (event.type !== 'session_completed' && event.type !== 'session_failed') return [];
  return event.permissionDenials ? [...event.permissionDenials] : [];
}

export function createTaskRecord(input: TaskStartInput): TaskRecord {
  const startedAt = input.startedAt ?? Date.now();
  return {
    id: input.runId,
    runId: input.runId,
    projectKey: input.projectKey,
    sessionKey: input.sessionKey,
    prompt: input.prompt,
    agentMode: input.agentMode?.trim() || DEFAULT_TASK_AGENT_MODE,
    userMessageId: input.userMessageId,
    model: input.model,
    status: 'starting',
    createdAt: startedAt,
    startedAt,
    updatedAt: startedAt,
    usage: null,
    result: null,
  };
}

export function isTaskTerminal(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function reduceTaskEvent(task: TaskRecord, event: TaskTimelineEvent): TaskRecord {
  if (isTaskTerminal(task.status)) return task;

  const base: TaskRecord = { ...task, updatedAt: event.timestamp };
  switch (event.type) {
    case 'session_started':
      return {
        ...base,
        status: 'running',
        claudeSessionId: event.sessionId || base.claudeSessionId,
      };
    case 'system_init':
      return {
        ...base,
        status: 'running',
        claudeSessionId: event.sessionId || base.claudeSessionId,
        model: event.model || base.model,
      };
    case 'assistant_text':
    case 'thinking_content':
    case 'stderr':
    case 'tool_started':
    case 'tool_completed':
    case 'tool_failed':
    case 'command_started':
    case 'command_output':
    case 'file_read':
    case 'file_changed':
    case 'permission_requested':
    case 'permission_waiting':
    case 'permission_settled':
      return { ...base, status: 'running' };
    case 'git_checkpoint_created':
    case 'git_restore_completed':
    case 'git_changes_accepted':
    case 'git_commit_created':
      return base;
    case 'workflow_progress':
      if (event.status === 'completed') {
        return {
          ...base,
          status: 'completed',
          completedAt: event.timestamp,
          durationMs: elapsed(base, event.timestamp),
          result: { kind: 'completed', markdown: null, permissionDenials: [] },
        };
      }
      if (event.status === 'failed') {
        return {
          ...base,
          status: 'failed',
          completedAt: event.timestamp,
          durationMs: elapsed(base, event.timestamp),
          result: {
            kind: 'failed',
            error: event.summary.detail ?? event.summary.title,
            permissionDenials: [],
          },
        };
      }
      if (event.status === 'cancelled') {
        return {
          ...base,
          status: 'cancelled',
          completedAt: event.timestamp,
          durationMs: elapsed(base, event.timestamp),
          result: {
            kind: 'cancelled',
            reason: event.summary.detail ?? event.summary.title,
            permissionDenials: [],
          },
        };
      }
      return ['planning', 'executing', 'testing', 'reviewing'].includes(event.status)
        ? { ...base, status: 'running' }
        : base;
    case 'usage_updated':
      return {
        ...base,
        status: 'running',
        usage: {
          inputTokens: event.inputTokens ?? 0,
          outputTokens: event.outputTokens ?? 0,
          totalTokens: event.totalTokens ?? 0,
        },
      };
    case 'session_completed':
      return {
        ...base,
        status: 'completed',
        claudeSessionId: event.sessionId || base.claudeSessionId,
        completedAt: event.timestamp,
        durationMs: event.duration,
        result: {
          kind: 'completed',
          markdown: event.result ?? null,
          permissionDenials: permissionDenials(event),
        },
      };
    case 'session_failed':
      return {
        ...base,
        status: 'failed',
        claudeSessionId: event.sessionId || base.claudeSessionId,
        completedAt: event.timestamp,
        durationMs: event.duration ?? elapsed(base, event.timestamp),
        result: {
          kind: 'failed',
          error: event.error,
          permissionDenials: permissionDenials(event),
        },
      };
    case 'task_start_failed':
      return {
        ...base,
        status: 'failed',
        completedAt: event.timestamp,
        durationMs: elapsed(base, event.timestamp),
        result: {
          kind: 'failed',
          error: event.error,
          permissionDenials: [],
        },
      };
    case 'task_cancelled':
      return {
        ...base,
        status: 'cancelled',
        completedAt: event.timestamp,
        durationMs: elapsed(base, event.timestamp),
        result: {
          kind: 'cancelled',
          reason: event.reason,
          permissionDenials: [],
        },
      };
  }
}

export function appendTimelineEntry(
  timeline: readonly TaskTimelineEntry[],
  task: TaskRecord,
  event: TaskTimelineEvent,
): TaskTimelineEntry[] {
  let sequence = 1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index].runId === task.runId) {
      sequence = timeline[index].sequence + 1;
      break;
    }
  }
  const entry: TaskTimelineEntry = {
    id: `${task.runId}:${sequence}`,
    taskId: task.id,
    runId: task.runId,
    projectKey: task.projectKey,
    sessionKey: task.sessionKey,
    sequence,
    timestamp: event.timestamp,
    event,
  };
  return [...timeline, entry];
}

export function selectOrderedTasks(
  tasksById: Readonly<Record<string, TaskRecord>>,
  taskOrder: readonly string[],
): TaskRecord[] {
  return taskOrder.flatMap((id) => tasksById[id] ? [tasksById[id]] : []);
}

export function selectLatestTask(
  tasksById: Readonly<Record<string, TaskRecord>>,
  taskOrder: readonly string[],
): TaskRecord | null {
  for (let index = taskOrder.length - 1; index >= 0; index -= 1) {
    const task = tasksById[taskOrder[index]];
    if (task) return task;
  }
  return null;
}

export function selectActiveOrLatestTask(
  tasksById: Readonly<Record<string, TaskRecord>>,
  taskOrder: readonly string[],
  activeRunId: string | null,
): TaskRecord | null {
  return (activeRunId ? tasksById[activeRunId] : undefined)
    ?? selectLatestTask(tasksById, taskOrder);
}

export function selectTaskTimeline(
  timeline: readonly TaskTimelineEntry[],
  runId: string,
): TaskTimelineEntry[] {
  return timeline.filter((entry) => entry.runId === runId);
}

export function taskToolKey(runId: string, toolUseId: string): string {
  return `${runId}:${toolUseId}`;
}

export function toolAction(toolName: string): string {
  switch (toolName) {
    case 'WebSearch': return '联网搜索';
    case 'WebFetch': return '读取网页';
    case 'Bash': return '运行命令';
    case 'Read': return '读取文件';
    case 'Edit': return '修改文件';
    case 'Write': return '写入文件';
    case 'Glob': return '查找文件';
    case 'Grep': return '搜索代码';
    default: return `使用 ${toolName}`;
  }
}

function valueSummary(value: unknown, limit = 320): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function presentTimelineEntry(
  entry: TaskTimelineEntry,
): TimelinePresentation | null {
  const event = entry.event;
  const common = {
    id: entry.id,
    runId: entry.runId,
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    event,
  };
  switch (event.type) {
    case 'workflow_progress':
      return {
        ...common,
        title: event.summary.title,
        detail: event.summary.detail ?? undefined,
        tone: event.summary.tone,
      };
    case 'git_checkpoint_created':
      return {
        ...common,
        title: event.checkpointType === 'before_task'
          ? '创建任务检查点'
          : event.checkpointType === 'after_test'
            ? '保存测试后检查点'
            : event.checkpointType === 'task_completed'
              ? '保存完成状态'
              : '保存代码检查点',
        detail: event.files.length > 0 ? `记录 ${event.files.length} 个文件` : '工作区状态已记录',
        tone: 'success',
      };
    case 'git_restore_completed':
      return {
        ...common,
        title: '已恢复检查点',
        detail: `恢复 ${event.files.length} 个文件，删除 ${event.deletedFiles.length} 个任务新增文件`,
        tone: 'success',
      };
    case 'git_changes_accepted':
      return {
        ...common,
        title: '已接受任务修改',
        detail: `保存 ${event.files.length} 个文件的当前状态`,
        tone: 'success',
      };
    case 'git_commit_created':
      return {
        ...common,
        title: '已创建 Git Commit',
        detail: `${event.subject}\n${event.commit}`,
        tone: 'success',
      };
    case 'assistant_text':
    case 'thinking_content':
    case 'usage_updated':
      return null;
    case 'session_started':
      return { ...common, title: '任务已启动', tone: 'info' };
    case 'system_init':
      return {
        ...common,
        title: 'Claude 已连接',
        detail: event.model || undefined,
        tone: 'info',
      };
    case 'stderr':
      if (event.level === 'info') return null;
      return {
        ...common,
        title: event.level === 'error' ? '运行诊断错误' : '运行诊断警告',
        detail: event.text,
        tone: event.level === 'error' ? 'error' : 'warning',
      };
    case 'tool_started':
      return {
        ...common,
        title: `${toolAction(event.toolName)}开始`,
        detail: valueSummary(event.input),
        tone: 'info',
        toolUseId: event.toolUseId,
      };
    case 'tool_completed':
      return {
        ...common,
        title: `${toolAction(event.toolName)}完成`,
        detail: valueSummary(event.output),
        tone: 'success',
        toolUseId: event.toolUseId,
      };
    case 'tool_failed':
      return {
        ...common,
        title: `${toolAction(event.toolName)}失败`,
        detail: event.error,
        tone: 'error',
        toolUseId: event.toolUseId,
      };
    case 'command_started':
      return {
        ...common,
        title: '运行命令',
        detail: event.command,
        tone: 'info',
        toolUseId: event.toolUseId,
      };
    case 'command_output':
      return {
        ...common,
        title: '命令产生输出',
        detail: valueSummary(event.output),
        tone: 'neutral',
        toolUseId: event.toolUseId,
      };
    case 'file_read':
      return {
        ...common,
        title: '读取文件',
        detail: event.filePath,
        tone: 'info',
        toolUseId: event.toolUseId,
      };
    case 'file_changed':
      return {
        ...common,
        title: '修改文件',
        detail: event.filePath,
        tone: 'warning',
        toolUseId: event.toolUseId,
      };
    case 'permission_requested':
      return {
        ...common,
        title: `等待授权：${toolAction(event.toolName)}`,
        detail: event.description,
        tone: 'warning',
        toolUseId: event.toolUseId,
      };
    case 'permission_waiting':
      return {
        ...common,
        title: `等待授权：${toolAction(event.toolName)}`,
        detail: `风险等级：${event.risk}`,
        tone: 'warning',
        toolUseId: event.toolUseId,
      };
    case 'permission_settled':
      return {
        ...common,
        title: `授权请求已处理：${toolAction(event.toolName)}`,
        tone: 'neutral',
        toolUseId: event.toolUseId,
      };
    case 'session_completed':
      return { ...common, title: '任务已完成', tone: 'success' };
    case 'session_failed':
      return { ...common, title: '任务运行失败', detail: event.error, tone: 'error' };
    case 'task_start_failed':
      return { ...common, title: '任务启动失败', detail: event.error, tone: 'error' };
    case 'task_cancelled':
      return { ...common, title: '任务已停止', detail: event.reason, tone: 'neutral' };
  }
}

function toolIdentity(entry: TaskTimelineEntry): string | null {
  const event = entry.event;
  if (!('toolUseId' in event) || !event.toolUseId) return null;
  return `${entry.runId}:${event.toolUseId}:${entry.timestamp}`;
}

export function selectTimelinePresentations(
  timeline: readonly TaskTimelineEntry[],
  runId?: string,
): TimelinePresentation[] {
  const candidates = runId ? selectTaskTimeline(timeline, runId) : [...timeline];
  const specializedStarts = new Set(
    candidates.flatMap((entry) => SPECIALIZED_TOOL_STARTS.has(entry.event.type)
      ? [toolIdentity(entry)]
      : []).filter((identity): identity is string => Boolean(identity)),
  );
  return candidates.flatMap((entry) => {
    if (entry.event.type === 'tool_started') {
      const identity = toolIdentity(entry);
      if (identity && specializedStarts.has(identity)) return [];
    }
    const presentation = presentTimelineEntry(entry);
    return presentation ? [presentation] : [];
  });
}

export function formatTaskDuration(durationMs?: number): string {
  if (durationMs === undefined) return '—';
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))} ms`;
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  return `${Math.floor(totalSeconds / 60)} 分 ${String(totalSeconds % 60).padStart(2, '0')} 秒`;
}

export function taskResultToMarkdown(task: TaskRecord): string {
  if (!task.result) return '';
  const lines: string[] = [];
  if (task.result.kind === 'completed') {
    lines.push(task.result.markdown?.trim() || '# 任务已完成\n\nClaude 未返回额外结果文本。');
  } else if (task.result.kind === 'failed') {
    lines.push(`# 任务失败\n\n${task.result.error}`);
  } else {
    lines.push(`# 任务已停止\n\n${task.result.reason}`);
  }

  lines.push('## 运行信息');
  lines.push(`- 运行 ID：${task.runId}`);
  lines.push(`- Agent 模式：${task.agentMode}`);
  lines.push(`- 耗时：${formatTaskDuration(task.durationMs)}`);
  if (task.usage) {
    lines.push(`- Token：${task.usage.inputTokens} 输入 / ${task.usage.outputTokens} 输出 / ${task.usage.totalTokens} 总计`);
  }
  if (task.result.permissionDenials.length > 0) {
    lines.push('## 权限拒绝');
    for (const denial of task.result.permissionDenials) {
      lines.push(`- ${denial.toolName}${denial.reason ? `：${denial.reason}` : ''}`);
    }
  }
  return lines.join('\n\n');
}

export function taskResultFileName(task: TaskRecord): string {
  const safeRunId = task.runId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `task-${safeRunId || 'result'}.md`;
}
