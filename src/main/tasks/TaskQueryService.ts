import type { AppDatabase, EventRow, PermissionRow } from '../database/Database';
import type {
  PageRequest,
  PageResult,
  PersistedTaskEvent,
  PersistedTaskFileChange,
  PersistedTaskSnapshot,
  PermissionStats,
  TaskReport,
} from '../../shared/types/workbench';

const DEFAULT_EVENT_PAGE_SIZE = 200;
const MAX_EVENT_PAGE_SIZE = 500;

function normalizePage(request: PageRequest = {}): Required<PageRequest> {
  const requestedLimit = Number.isFinite(request.limit)
    ? Math.trunc(request.limit as number)
    : DEFAULT_EVENT_PAGE_SIZE;
  const requestedOffset = Number.isFinite(request.offset)
    ? Math.trunc(request.offset as number)
    : 0;
  const limit = Math.min(
    MAX_EVENT_PAGE_SIZE,
    Math.max(1, requestedLimit),
  );
  const offset = Math.max(0, requestedOffset);
  return { limit, offset };
}

function safePayload(row: EventRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { invalidPayload: true };
  }
}

function eventView(row: EventRow): PersistedTaskEvent {
  return {
    id: row.id,
    type: row.event_type,
    payload: safePayload(row),
    createdAt: row.created_at,
  };
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function reportStatus(status: string): string {
  if (status === 'completed') return '任务完成';
  if (status === 'failed') return '任务失败';
  if (status === 'cancelled') return '任务已停止';
  if (status === 'running' || status === 'waiting_permission') return '任务运行中';
  return '任务等待中';
}

function permissionStats(rows: Pick<PermissionRow, 'decision'>[]): PermissionStats {
  const stats: PermissionStats = {
    total: rows.length,
    userAllowed: 0,
    autoAllowed: 0,
    denied: 0,
    timedOut: 0,
    unsupported: 0,
    policyBlocked: 0,
    lifecycleCancelled: 0,
    other: 0,
  };
  for (const row of rows) {
    if (['allow_once', 'allow_for_task', 'allow_for_project', 'allow_for_session'].includes(row.decision)) {
      stats.userAllowed += 1;
    } else if (row.decision === 'permission_auto_allowed') {
      stats.autoAllowed += 1;
    } else if (row.decision === 'deny') {
      stats.denied += 1;
    } else if (row.decision === 'timeout') {
      stats.timedOut += 1;
    } else if (row.decision === 'invalid_decision') {
      stats.unsupported += 1;
    } else if ([
      'run_inactive',
      'run_cancelled',
      'run_completed',
      'requester_disconnected',
      'broker_closed',
    ].includes(row.decision)) {
      stats.lifecycleCancelled += 1;
    } else if ([
      'policy_blocked',
      'native_confirmation_error',
      'broker_error',
      'trusted_decision_rejected',
    ].includes(row.decision)) {
      stats.policyBlocked += 1;
    } else {
      stats.other += 1;
    }
  }
  return stats;
}

export class TaskQueryService {
  constructor(private readonly database: AppDatabase) {}

  listEvents(
    sessionId: string,
    request: PageRequest = {},
  ): PageResult<PersistedTaskEvent> {
    const page = normalizePage(request);
    return {
      items: this.database.listEvents(sessionId, page).map(eventView),
      total: this.database.countEvents(sessionId),
      ...page,
    };
  }

  getSnapshot(sessionId: string, request: PageRequest = {}): PersistedTaskSnapshot | null {
    const session = this.database.getSession(sessionId);
    if (!session) return null;
    const task = this.database.getTask(sessionId);
    const permissions = this.database.listPermissions(sessionId);
    const permissionsSummary = permissionStats(permissions);
    const fileChanges: PersistedTaskFileChange[] = this.database
      .listFileChanges(sessionId, { limit: 5_000, offset: 0 })
      .map((change) => ({
        id: change.id,
        filePath: change.file_path,
        changeType: change.change_type,
        additions: change.additions,
        deletions: change.deletions,
        oldContent: change.old_content,
        newContent: change.new_content,
        isBinary: change.is_binary,
        createdAt: change.created_at,
      }));
    const events = this.listEvents(sessionId, request);
    return {
      sessionId,
      projectId: session.project_id,
      title: session.title,
      status: task?.status ?? session.status,
      model: session.model,
      permissionMode: session.permission_mode,
      agentMode: task?.agent_mode ?? 'normal',
      startedAt: task?.started_at ?? session.created_at,
      completedAt: task?.completed_at ?? session.completed_at,
      durationMs: task?.duration_ms ?? 0,
      usage: {
        inputTokens: task?.input_tokens ?? 0,
        outputTokens: task?.output_tokens ?? 0,
        totalTokens: task?.total_tokens ?? 0,
      },
      permissionCount: permissionsSummary.total,
      permissionStats: permissionsSummary,
      permissionRecords: permissions.map((permission) => ({
        id: permission.id,
        runId: permission.run_id,
        toolName: permission.tool_name,
        decision: permission.decision,
        createdAt: permission.created_at,
        resolvedAt: permission.resolved_at,
      })),
      test: {
        status: task?.test_status ?? null,
        command: task?.test_command ?? null,
        output: task?.test_output ?? null,
      },
      fileChanges,
      totalAdditions: fileChanges.reduce((sum, change) => sum + change.additions, 0),
      totalDeletions: fileChanges.reduce((sum, change) => sum + change.deletions, 0),
      events: events.items,
      eventOffset: events.offset,
      eventTotal: events.total,
    };
  }

  buildReport(sessionId: string): TaskReport | null {
    const snapshot = this.getSnapshot(sessionId, { limit: 1 });
    if (!snapshot) return null;
    const testSummary = snapshot.test.command
      ? [snapshot.test.command, snapshot.test.output].filter(Boolean).join('\n\n')
      : '未记录测试命令';
    const markdown = [
      `# ${reportStatus(snapshot.status)}`,
      '',
      `- 任务：${snapshot.title}`,
      `- 修改：${snapshot.fileChanges.length} 个文件`,
      `- 新增：${snapshot.totalAdditions} 行`,
      `- 删除：${snapshot.totalDeletions} 行`,
      `- 耗时：${formatDuration(snapshot.durationMs)}`,
      `- 模型：${snapshot.model || 'Claude Code 默认'}`,
      `- Agent 模式：${snapshot.agentMode}`,
      `- Token：${snapshot.usage.totalTokens}`,
      `- 权限：${snapshot.permissionStats.total} 次请求（用户允许 ${snapshot.permissionStats.userAllowed}，自动允许 ${snapshot.permissionStats.autoAllowed}，拒绝 ${snapshot.permissionStats.denied}）`,
      '',
      '## 测试',
      '',
      '```text',
      testSummary,
      '```',
      '',
      '## 修改文件',
      '',
      ...(snapshot.fileChanges.length
        ? snapshot.fileChanges.map((change) => (
          `- ${change.filePath} (+${change.additions} / -${change.deletions})`
        ))
        : ['- 无已记录的文件修改']),
      '',
    ].join('\n');
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'task';
    return { fileName: `task-${safeSessionId}.md`, markdown };
  }
}

export const taskQueryInternals = { eventView, formatDuration, normalizePage, reportStatus };
