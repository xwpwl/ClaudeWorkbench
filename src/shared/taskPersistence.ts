import {
  createTaskRecord,
  isTaskTerminal,
  reduceTaskEvent,
} from './taskState';
import type { TaskRecord, TaskStatus, TaskTimelineEntry, TaskTimelineEvent } from './types/task';
import type { PersistedTaskEvent, PersistedTaskSnapshot } from './types/workbench';

export interface HydratedTaskState {
  tasksById: Record<string, TaskRecord>;
  taskOrder: string[];
  timeline: TaskTimelineEntry[];
}

const TASK_EVENT_TYPES = new Set<TaskTimelineEvent['type']>([
  'session_started',
  'system_init',
  'assistant_text',
  'thinking_content',
  'stderr',
  'tool_started',
  'tool_completed',
  'tool_failed',
  'command_started',
  'command_output',
  'file_read',
  'file_changed',
  'permission_requested',
  'usage_updated',
  'session_completed',
  'session_failed',
  'git_checkpoint_created',
  'git_restore_completed',
  'git_changes_accepted',
  'git_commit_created',
  'workflow_progress',
]);

function timestamp(value: unknown, fallback: string): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : Date.parse(fallback) || Date.now();
}

function runIdFor(event: PersistedTaskEvent): string {
  const runId = event.payload.runId;
  if (typeof runId === 'string' && runId.trim()) return runId;
  const separator = event.id.lastIndexOf(':');
  return separator > 0 ? event.id.slice(0, separator) : `persisted:${event.id}`;
}

function timelineEvent(event: PersistedTaskEvent): TaskTimelineEvent | null {
  const type = event.payload.type ?? event.type;
  if (typeof type !== 'string' || !TASK_EVENT_TYPES.has(type as TaskTimelineEvent['type'])) {
    return null;
  }
  return {
    ...event.payload,
    type,
    timestamp: timestamp(event.payload.timestamp, event.createdAt),
  } as TaskTimelineEvent;
}

function persistedStatus(status: string): TaskStatus {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
  if (status === 'running' || status === 'waiting_permission') return 'running';
  return 'starting';
}

function snapshotResult(snapshot: PersistedTaskSnapshot): TaskRecord['result'] {
  if (snapshot.status === 'completed') {
    const test = snapshot.test.command
      ? `\n\n测试：${snapshot.test.command}\n${snapshot.test.output ?? snapshot.test.status ?? ''}`
      : '';
    return {
      kind: 'completed',
      markdown: `已修改 ${snapshot.fileChanges.length} 个文件（+${snapshot.totalAdditions} / -${snapshot.totalDeletions}）。${test}`,
      permissionDenials: [],
    };
  }
  if (snapshot.status === 'failed') {
    return { kind: 'failed', error: '任务失败（已从本地记录恢复）', permissionDenials: [] };
  }
  if (snapshot.status === 'cancelled') {
    return { kind: 'cancelled', reason: '任务已停止', permissionDenials: [] };
  }
  return null;
}

function taskFromSnapshot(snapshot: PersistedTaskSnapshot, runId: string): TaskRecord {
  const startedAt = Date.parse(snapshot.startedAt ?? '') || Date.now();
  const completedAt = snapshot.completedAt ? Date.parse(snapshot.completedAt) || undefined : undefined;
  return {
    ...createTaskRecord({
      runId,
      projectKey: snapshot.projectId,
      sessionKey: snapshot.sessionId,
      prompt: snapshot.title,
      agentMode: snapshot.agentMode,
      model: snapshot.model ?? undefined,
      startedAt,
    }),
    status: persistedStatus(snapshot.status),
    updatedAt: completedAt ?? startedAt,
    completedAt,
    durationMs: snapshot.durationMs || undefined,
    usage: snapshot.usage.totalTokens > 0 ? { ...snapshot.usage } : null,
    result: snapshotResult(snapshot),
  };
}

export function hydratePersistedTasks(snapshot: PersistedTaskSnapshot): HydratedTaskState {
  const state: HydratedTaskState = { tasksById: {}, taskOrder: [], timeline: [] };
  const containsLatest = (snapshot.eventOffset ?? 0) + snapshot.events.length >= snapshot.eventTotal;

  for (const event of snapshot.events) {
    const runId = runIdFor(event);
    if (event.type === 'task_started') {
      if (!state.tasksById[runId]) {
        state.tasksById[runId] = createTaskRecord({
          runId,
          projectKey: snapshot.projectId,
          sessionKey: snapshot.sessionId,
          prompt: typeof event.payload.prompt === 'string' ? event.payload.prompt : snapshot.title,
          agentMode: typeof event.payload.agentMode === 'string'
            ? event.payload.agentMode
            : snapshot.agentMode,
          model: typeof event.payload.model === 'string' ? event.payload.model : snapshot.model ?? undefined,
          startedAt: timestamp(event.payload.timestamp, event.createdAt),
        });
        state.taskOrder.push(runId);
      }
      continue;
    }
    const projected = timelineEvent(event);
    if (!projected) continue;
    const task = state.tasksById[runId] ?? createTaskRecord({
      runId,
      projectKey: snapshot.projectId,
      sessionKey: snapshot.sessionId,
      prompt: snapshot.title,
      agentMode: snapshot.agentMode,
      model: snapshot.model ?? undefined,
      startedAt: timestamp(projected.timestamp, event.createdAt),
    });
    if (!state.tasksById[runId]) state.taskOrder.push(runId);
    const parsedSequence = Number(event.id.slice(event.id.lastIndexOf(':') + 1));
    const sequence = Number.isFinite(parsedSequence) ? parsedSequence : state.timeline.length + 1;
    state.timeline.push({
      id: event.id,
      taskId: task.id,
      runId,
      projectKey: task.projectKey,
      sessionKey: task.sessionKey,
      sequence,
      timestamp: projected.timestamp,
      event: projected,
    });
    state.tasksById[runId] = reduceTaskEvent(task, projected);
  }

  if (state.taskOrder.length === 0 && snapshot.status !== 'idle' && containsLatest) {
    const runId = `persisted:${snapshot.sessionId}`;
    state.taskOrder.push(runId);
    state.tasksById[runId] = taskFromSnapshot(snapshot, runId);
    return state;
  }

  const latestRunId = state.taskOrder.at(-1);
  if (latestRunId) {
    const latest = state.tasksById[latestRunId];
    if (
      containsLatest
      && !isTaskTerminal(latest.status)
      && ['completed', 'failed', 'cancelled'].includes(snapshot.status)
    ) {
      state.tasksById[latestRunId] = taskFromSnapshot(snapshot, latestRunId);
    } else {
      state.tasksById[latestRunId] = {
        ...latest,
        usage: latest.usage ?? (snapshot.usage.totalTokens > 0 ? { ...snapshot.usage } : null),
        model: latest.model ?? snapshot.model ?? undefined,
      };
    }
  }
  return state;
}

export const taskPersistenceInternals = {
  persistedStatus,
  runIdFor,
  snapshotResult,
  taskFromSnapshot,
  timelineEvent,
};
