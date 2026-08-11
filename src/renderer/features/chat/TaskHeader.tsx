import React, { useEffect, useState } from 'react';
import { Bot, CheckCircle, CircleStop, Clock, LoaderCircle, ShieldAlert, XCircle, Zap } from 'lucide-react';
import { formatTaskDuration } from '../../../shared/taskState';
import type { TaskRecord } from '../../../shared/types/task';
import type { PersistedTaskSnapshot } from '../../../shared/types/workbench';

interface TaskHeaderProps {
  task: TaskRecord;
  waitingPermissionCount?: number;
  snapshot?: PersistedTaskSnapshot | null;
}

function taskStatusLabel(task: TaskRecord, waitingPermissionCount: number): string {
  if (waitingPermissionCount > 0 && (task.status === 'starting' || task.status === 'running')) {
    return `等待授权（${waitingPermissionCount}）`;
  }
  switch (task.status) {
    case 'starting': return '正在启动';
    case 'running': return '正在执行';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'cancelled': return '已停止';
  }
}

function StatusIcon({ task, waiting }: { task: TaskRecord; waiting: boolean }) {
  if (waiting) return <ShieldAlert size={15} style={{ color: 'var(--warning)' }} />;
  if (task.status === 'completed') return <CheckCircle size={15} style={{ color: 'var(--success)' }} />;
  if (task.status === 'failed') return <XCircle size={15} style={{ color: 'var(--error)' }} />;
  if (task.status === 'cancelled') return <CircleStop size={15} style={{ color: 'var(--text-tertiary)' }} />;
  return <LoaderCircle size={15} className="animate-spin" style={{ color: 'var(--info)' }} />;
}

export function TaskHeader({ task, waitingPermissionCount = 0, snapshot }: TaskHeaderProps) {
  const live = task.status === 'starting' || task.status === 'running';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const duration = task.durationMs ?? (live ? Math.max(0, now - task.startedAt) : undefined);
  const waiting = waitingPermissionCount > 0 && live;

  return (
    <header
      className="rounded-xl border px-4 py-3"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}
      data-task-id={task.id}
      data-task-status={task.status}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--accent-light)' }}>
          <Bot size={15} style={{ color: 'var(--accent)' }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium text-sm">{task.prompt || '未命名任务'}</span>
            <span className="inline-flex items-center gap-1 text-xs" style={{ color: waiting ? 'var(--warning)' : 'var(--text-secondary)' }}>
              <StatusIcon task={task} waiting={waiting} />
              {taskStatusLabel(task, waitingPermissionCount)}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            <span className="rounded-full px-2 py-0.5" style={{ background: 'var(--bg-hover)' }}>
              Agent · {task.agentMode}
            </span>
            <span className="inline-flex items-center gap-1"><Clock size={11} />{formatTaskDuration(duration)}</span>
            {task.usage ? (
              <span className="inline-flex items-center gap-1"><Zap size={11} />{task.usage.totalTokens.toLocaleString()} tokens</span>
            ) : null}
            {task.model || snapshot?.model ? <span>{task.model || snapshot?.model}</span> : null}
            {snapshot ? <span>修改 {snapshot.fileChanges.length} 个文件</span> : null}
            {snapshot?.test.status ? <span>测试 {snapshot.test.status === 'passed' ? '通过' : snapshot.test.status}</span> : null}
            <span title={task.runId}>Run {task.runId.slice(0, 8)}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
