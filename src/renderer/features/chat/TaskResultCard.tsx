import React, { useState } from 'react';
import {
  Check,
  CheckCheck,
  CheckCircle,
  Clipboard,
  Download,
  FileDiff,
  RotateCcw,
  ShieldX,
  Square,
  XCircle,
  Zap,
} from 'lucide-react';
import { formatTaskDuration, taskResultFileName, taskResultToMarkdown } from '../../../shared/taskState';
import type { TaskRecord } from '../../../shared/types/task';
import type { PersistedTaskSnapshot } from '../../../shared/types/workbench';

interface TaskResultCardProps {
  task: TaskRecord;
  snapshot?: PersistedTaskSnapshot | null;
  onExportMarkdown?: (markdown: string, fileName: string, task: TaskRecord) => void;
  onAcceptChanges?: (task: TaskRecord) => void;
  onRestoreChanges?: (task: TaskRecord) => void;
  onViewDiff?: (task: TaskRecord) => void;
}

function resultText(task: TaskRecord): string {
  if (!task.result) return '';
  if (task.result.kind === 'completed') {
    return task.result.markdown?.trim() || '任务已完成，Claude 未返回额外结果文本。';
  }
  if (task.result.kind === 'failed') return task.result.error;
  return task.result.reason;
}

function defaultExport(markdown: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function snapshotMarkdown(snapshot: PersistedTaskSnapshot): string {
  return [
    `# ${snapshot.status === 'completed' ? '任务完成' : snapshot.status === 'failed' ? '任务失败' : '任务已停止'}`,
    '',
    `- 任务：${snapshot.title}`,
    `- 修改：${snapshot.fileChanges.length} 个文件`,
    `- 新增：${snapshot.totalAdditions} 行`,
    `- 删除：${snapshot.totalDeletions} 行`,
    `- 耗时：${formatTaskDuration(snapshot.durationMs)}`,
    `- 模型：${snapshot.model || 'Claude Code 默认'}`,
    `- Token：${snapshot.usage.totalTokens}`,
    `- 权限：${snapshot.permissionStats.total} 次请求（用户允许 ${snapshot.permissionStats.userAllowed}，自动允许 ${snapshot.permissionStats.autoAllowed}，拒绝 ${snapshot.permissionStats.denied}）`,
    '',
    '## 测试',
    '',
    '```text',
    snapshot.test.command || '未记录测试命令',
    snapshot.test.output || snapshot.test.status || '',
    '```',
    '',
  ].join('\n');
}

export function TaskResultCard({
  task,
  snapshot,
  onExportMarkdown,
  onAcceptChanges,
  onRestoreChanges,
  onViewDiff,
}: TaskResultCardProps) {
  const [copied, setCopied] = useState(false);
  if (!task.result) return null;

  const markdown = snapshot ? snapshotMarkdown(snapshot) : taskResultToMarkdown(task);
  const fileName = taskResultFileName(task);
  const success = task.result.kind === 'completed';
  const failed = task.result.kind === 'failed';
  const accent = success ? 'var(--success)' : failed ? 'var(--error)' : 'var(--text-tertiary)';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }} data-testid="task-result-card">
      <div className="flex flex-wrap items-center gap-2">
        {success ? <CheckCircle size={16} style={{ color: accent }} /> : failed ? <XCircle size={16} style={{ color: accent }} /> : <Square size={14} style={{ color: accent }} />}
        <h3 className="text-sm font-semibold" style={{ color: accent }}>
          {success ? '任务结果' : failed ? '任务失败' : '任务已停止'}
        </h3>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px]" style={{ color: 'var(--text-secondary)', background: 'var(--bg-hover)' }}>
            {copied ? <Check size={12} /> : <Clipboard size={12} />}{copied ? '已复制' : '复制'}
          </button>
          <button
            type="button"
            onClick={() => onExportMarkdown ? onExportMarkdown(markdown, fileName, task) : defaultExport(markdown, fileName)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px]"
            style={{ color: 'var(--text-secondary)', background: 'var(--bg-hover)' }}
          >
            <Download size={12} />导出 Markdown
          </button>
        </div>
      </div>

      <pre className="selectable mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-3 font-sans text-xs leading-6" style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)' }}>
        {resultText(task)}
      </pre>

      {snapshot ? (
        <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border p-3 text-[11px] sm:grid-cols-4" style={{ borderColor: 'var(--border-secondary)' }} data-testid="task-result-metrics">
          <div><span style={{ color: 'var(--text-tertiary)' }}>修改</span><div>{snapshot.fileChanges.length} 个文件</div></div>
          <div><span style={{ color: 'var(--text-tertiary)' }}>行数</span><div><span style={{ color: 'var(--success)' }}>+{snapshot.totalAdditions}</span> / <span style={{ color: 'var(--error)' }}>-{snapshot.totalDeletions}</span></div></div>
          <div><span style={{ color: 'var(--text-tertiary)' }}>测试</span><div>{snapshot.test.status || '未记录'}</div></div>
          <div data-testid="task-permission-stats">
            <span style={{ color: 'var(--text-tertiary)' }}>权限</span>
            <div>{snapshot.permissionStats.total} 次请求</div>
            <details className="mt-1">
              <summary className="cursor-pointer" style={{ color: 'var(--text-tertiary)' }}>查看分类</summary>
              <div className="mt-1 space-y-0.5">
                <div>{snapshot.permissionStats.userAllowed} 次用户允许</div>
                <div>{snapshot.permissionStats.autoAllowed} 次规则自动允许</div>
                <div>{snapshot.permissionStats.denied} 次拒绝</div>
                <div>{snapshot.permissionStats.timedOut} 次超时</div>
                <div>{snapshot.permissionStats.unsupported} 次不支持</div>
                <div>{snapshot.permissionStats.policyBlocked} 次配置禁止</div>
                <div>{snapshot.permissionStats.lifecycleCancelled} 次因任务/连接结束取消</div>
                <div>{snapshot.permissionStats.other} 次其他结果</div>
                <div className="mt-2 space-y-1 border-t pt-2" style={{ borderColor: 'var(--border-secondary)' }} data-testid="task-permission-records">
                  {snapshot.permissionRecords.map((permission) => (
                    <div key={permission.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                      <span className="truncate" title={`${permission.toolName} · ${permission.runId}`}>{permission.toolName}</span>
                      <span title={permission.createdAt}>{permission.decision}</span>
                    </div>
                  ))}
                  {snapshot.permissionRecords.length === 0 ? <div>暂无权限记录</div> : null}
                </div>
              </div>
            </details>
          </div>
          <div className="col-span-2"><span style={{ color: 'var(--text-tertiary)' }}>模型</span><div className="truncate">{snapshot.model || 'Claude Code 默认'}</div></div>
          <div className="col-span-2"><span style={{ color: 'var(--text-tertiary)' }}>测试命令</span><div className="truncate font-mono">{snapshot.test.command || '—'}</div></div>
        </div>
      ) : null}

      {onAcceptChanges || onRestoreChanges || onViewDiff ? (
        <div className="mt-3 flex flex-wrap gap-2 border-t pt-3" style={{ borderColor: 'var(--border-secondary)' }} data-testid="task-git-actions">
          {onAcceptChanges ? (
            <button type="button" onClick={() => onAcceptChanges(task)} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-white" style={{ background: 'var(--success)' }}>
              <CheckCheck size={12} />接受全部修改
            </button>
          ) : null}
          {onRestoreChanges ? (
            <button type="button" onClick={() => onRestoreChanges(task)} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs" style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}>
              <RotateCcw size={12} />恢复任务前状态
            </button>
          ) : null}
          {onViewDiff ? (
            <button type="button" onClick={() => onViewDiff(task)} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs" style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
              <FileDiff size={12} />查看 Diff
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        <span>耗时 {formatTaskDuration(task.durationMs)}</span>
        {task.usage ? (
          <span className="inline-flex items-center gap-1"><Zap size={11} />{task.usage.inputTokens.toLocaleString()} 输入 / {task.usage.outputTokens.toLocaleString()} 输出</span>
        ) : null}
      </div>

      {task.result.permissionDenials.length > 0 ? (
        <div className="mt-3 rounded-lg px-3 py-2" style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}>
          <div className="flex items-center gap-1.5 text-xs font-medium"><ShieldX size={13} />权限未授予</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px]">
            {task.result.permissionDenials.map((denial, index) => (
              <li key={`${denial.toolUseId || denial.toolName}:${index}`}>
                {denial.toolName}{denial.reason ? `：${denial.reason}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
