import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  FolderOpen,
  GitFork,
  MessageSquare,
  MoreHorizontal,
  LoaderCircle,
} from 'lucide-react';
import {
  selectActiveOrLatestTask,
  selectOrderedTasks,
  selectTaskTimeline,
  toolAction,
} from '../../../shared/taskState';
import type { TaskRecord } from '../../../shared/types/task';
import type { PersistedTaskSnapshot } from '../../../shared/types/workbench';
import { EmptyState } from '../../components/EmptyState';
import { t } from '../../i18n';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { AgentTimeline } from './AgentTimeline';
import { TaskHeader } from './TaskHeader';
import { TaskResultCard } from './TaskResultCard';

interface ChatTimelineProps {
  onOpenProject?: () => void;
  onCreateTask?: () => void;
  onForkMessage?: (messageId: string) => void;
  onExportTaskMarkdown?: (markdown: string, fileName: string, task: TaskRecord) => void;
  taskSnapshot?: PersistedTaskSnapshot | null;
  onLoadOlderMessages?: () => Promise<boolean>;
  onLoadOlderTaskEvents?: () => Promise<boolean>;
  onAcceptTaskChanges?: (task: TaskRecord) => void;
  onRestoreTaskChanges?: (task: TaskRecord) => void;
  onViewTaskDiff?: (task: TaskRecord) => void;
}

function statusText(status: string): string {
  switch (status) {
    case 'loading_history': return '正在加载历史';
    case 'running': return 'Claude 正在工作';
    case 'waiting_permission': return '等待你的授权';
    case 'completed': return '已完成';
    case 'failed': return '运行失败';
    case 'cancelled': return '已停止';
    default: return '空闲';
  }
}

export function ChatTimeline({
  onOpenProject,
  onCreateTask,
  onForkMessage,
  onExportTaskMarkdown,
  taskSnapshot,
  onLoadOlderMessages,
  onLoadOlderTaskEvents,
  onAcceptTaskChanges,
  onRestoreTaskChanges,
  onViewTaskDiff,
}: ChatTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [messageMenu, setMessageMenu] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingOlderWork, setLoadingOlderWork] = useState(false);
  const currentProject = useWorkspaceStore((state) => state.currentProject);
  const projectLoading = useWorkspaceStore((state) => state.projectLoading);
  const runtime = useWorkspaceStore((state) =>
    state.currentSessionKey ? state.runtimes[state.currentSessionKey] : undefined,
  );
  const activeTab = useWorkspaceStore((state) => state.activeTab);
  const setActiveTab = useWorkspaceStore((state) => state.setActiveTab);
  const permissionRequests = useWorkspaceStore((state) => state.permissionRequests);

  const tasks = useMemo(
    () => runtime ? selectOrderedTasks(runtime.tasksById, runtime.taskOrder) : [],
    [runtime?.taskOrder, runtime?.tasksById],
  );
  const activeOrLatestTask = useMemo(
    () => runtime
      ? selectActiveOrLatestTask(runtime.tasksById, runtime.taskOrder, runtime.activeRunId)
      : null,
    [runtime?.activeRunId, runtime?.taskOrder, runtime?.tasksById],
  );
  const permissionRequest = useMemo(
    () => permissionRequests.find((request) => request.sessionKey === runtime?.key) ?? null,
    [permissionRequests, runtime?.key],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [runtime?.messages, runtime?.timeline, runtime?.tasksById]);

  if (!currentProject) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={FolderOpen}
          title={t('chat.welcome')}
          description={t('chat.welcomeDesc')}
          action={onOpenProject ? { label: t('chat.openProject'), onClick: onOpenProject } : undefined}
        />
      </div>
    );
  }

  if (!runtime) {
    if (!projectLoading) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={MessageSquare}
            title={t('task.noTasks')}
            description={t('chat.createTask')}
            action={onCreateTask ? { label: t('task.new'), onClick: onCreateTask } : undefined}
          />
        </div>
      );
    }
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>正在选择 {currentProject.name} 的最近任务…</div>
      </div>
    );
  }

  if (runtime.summary.status === 'loading_history') {
    return (
      <div className="flex-1 px-6 py-8">
        <div className="max-w-[850px] mx-auto animate-pulse space-y-5" data-testid="history-loading">
          <div className="h-6 w-52 rounded" style={{ background: 'var(--bg-hover)' }} />
          <div className="h-20 w-2/3 ml-auto rounded-xl" style={{ background: 'var(--bg-hover)' }} />
          <div className="h-28 w-4/5 rounded-xl" style={{ background: 'var(--bg-hover)' }} />
          <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>正在读取该会话，不会显示上一项目的内容…</div>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 scrollbar-hidden">
      <div className="max-w-[850px] mx-auto">
        <header className="flex items-center justify-between pb-3 mb-4" style={{ borderBottom: '1px solid var(--border-secondary)' }}>
          <div className="min-w-0 flex items-center gap-2">
            <span className={`status-dot ${runtime.summary.status}`} />
            <span className="truncate text-sm font-medium">{runtime.summary.title}</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-hover)', color: 'var(--text-tertiary)' }}>
              {runtime.summary.source === 'claude-code' ? 'Claude Code 历史' : 'Workbench'}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
            <span>{statusText(runtime.summary.status)}</span>
            {activeOrLatestTask?.usage ? <span>{activeOrLatestTask.usage.totalTokens.toLocaleString()} tokens</span> : null}
          </div>
        </header>

        {runtime.error ? (
          <div className="mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--error)', background: 'var(--error-bg)' }}>
            <AlertCircle size={14} className="mt-0.5" />
            <span className="selectable">{runtime.error}</span>
          </div>
        ) : null}

        <div className="flex gap-1 mb-5 p-0.5 rounded-lg" style={{ background: 'var(--bg-hover)' }}>
          <button type="button" onClick={() => setActiveTab('conversation')} className="flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs" style={{ background: activeTab === 'conversation' ? 'var(--bg-card)' : 'transparent' }}>
            <MessageSquare size={13} /> 对话
          </button>
          <button type="button" onClick={() => setActiveTab('work')} className="flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs" style={{ background: activeTab === 'work' ? 'var(--bg-card)' : 'transparent' }}>
            <Activity size={13} /> 工作记录
          </button>
        </div>

        {activeTab === 'conversation' ? (
          <div className="space-y-5">
            {runtime.messageOffset > 0 && onLoadOlderMessages ? (
              <div className="flex justify-center">
                <button
                  type="button"
                  disabled={loadingOlder}
                  onClick={() => {
                    const viewport = scrollRef.current;
                    const previousHeight = viewport?.scrollHeight ?? 0;
                    const previousTop = viewport?.scrollTop ?? 0;
                    setLoadingOlder(true);
                    void onLoadOlderMessages().finally(() => {
                      setLoadingOlder(false);
                      requestAnimationFrame(() => {
                        if (viewport) viewport.scrollTop = previousTop + viewport.scrollHeight - previousHeight;
                      });
                    });
                  }}
                  className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[11px] disabled:opacity-50"
                  style={{ borderColor: 'var(--border-secondary)', color: 'var(--text-secondary)' }}
                >
                  {loadingOlder ? <LoaderCircle size={11} className="animate-spin" /> : null}
                  加载更早消息（尚有 {runtime.messageOffset} 条）
                </button>
              </div>
            ) : null}
            {runtime.messages.map((message) => (
              <div key={message.runId ? `${message.runId}:${message.id}` : message.id} className={`group flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`relative max-w-[85%] ${message.role === 'user' ? 'rounded-2xl rounded-br-md px-4 py-2.5' : ''}`} style={{ background: message.role === 'user' ? 'var(--accent-light)' : 'transparent' }}>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed selectable">{message.content}</div>
                  {onForkMessage ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (message.forkable !== false) setMessageMenu(messageMenu === message.id ? null : message.id);
                      }}
                      disabled={message.forkable === false}
                      className="absolute -right-7 top-0 p-1 rounded opacity-0 group-hover:opacity-100"
                      style={{ color: 'var(--text-tertiary)' }}
                      title={message.forkable === false ? message.forkReason : '消息操作'}
                    >
                      <MoreHorizontal size={13} />
                    </button>
                  ) : null}
                  {message.forkable !== false && messageMenu === message.id ? (
                    <button
                      type="button"
                      onClick={() => {
                        setMessageMenu(null);
                        onForkMessage?.(message.forkMessageId || message.id);
                      }}
                      className="absolute z-10 right-0 top-7 whitespace-nowrap flex items-center gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg"
                      style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}
                    >
                      <GitFork size={13} /> 从此消息分叉
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {permissionRequest ? (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--warning)', background: 'var(--warning-bg)' }}>
                <AlertCircle size={14} /> 正在等待你确认“{toolAction(permissionRequest.toolName)}”
              </div>
            ) : null}
            {runtime.messages.length === 0 ? (
              <div className="py-12 text-center text-sm" style={{ color: 'var(--text-disabled)' }}>输入任务开始对话</div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-7">
            {runtime.taskEventOffset > 0 && onLoadOlderTaskEvents ? (
              <div className="flex justify-center">
                <button
                  type="button"
                  disabled={loadingOlderWork}
                  onClick={() => {
                    setLoadingOlderWork(true);
                    void onLoadOlderTaskEvents().finally(() => setLoadingOlderWork(false));
                  }}
                  className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[11px] disabled:opacity-50"
                  style={{ borderColor: 'var(--border-secondary)', color: 'var(--text-secondary)' }}
                >
                  {loadingOlderWork ? <LoaderCircle size={11} className="animate-spin" /> : null}
                  加载更早工作记录（尚有 {runtime.taskEventOffset} 条）
                </button>
              </div>
            ) : null}
            {tasks.map((task) => {
              const entries = selectTaskTimeline(runtime.timeline, task.runId);
              const tools = runtime.toolCalls.filter((tool) => tool.runId === task.runId);
              const waitingPermissionCount = permissionRequests.filter(
                (request) => request.sessionKey === runtime.key && request.runId === task.runId,
              ).length;
              return (
                <section key={task.id} className="space-y-3" data-run-id={task.runId}>
                  <TaskHeader
                    task={task}
                    waitingPermissionCount={waitingPermissionCount}
                    snapshot={activeOrLatestTask?.id === task.id ? taskSnapshot : null}
                  />
                  <AgentTimeline entries={entries} tools={tools} />
                  <TaskResultCard
                    task={task}
                    snapshot={activeOrLatestTask?.id === task.id ? taskSnapshot : null}
                    onExportMarkdown={onExportTaskMarkdown}
                    onAcceptChanges={activeOrLatestTask?.id === task.id ? onAcceptTaskChanges : undefined}
                    onRestoreChanges={activeOrLatestTask?.id === task.id ? onRestoreTaskChanges : undefined}
                    onViewDiff={activeOrLatestTask?.id === task.id ? onViewTaskDiff : undefined}
                  />
                </section>
              );
            })}
            {tasks.length === 0 ? (
              <EmptyState
                icon={MessageSquare}
                title={t('task.noTasks')}
                description={t('chat.createTask')}
                action={onCreateTask ? { label: t('task.new'), onClick: onCreateTask } : undefined}
                compact
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
