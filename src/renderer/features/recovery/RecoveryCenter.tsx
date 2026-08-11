import { useState } from 'react';
import { AlertTriangle, FileText, Play, Trash2, X } from 'lucide-react';
import type { RecoveryItem } from '../../../shared/types/recovery';

export interface RecoveryCenterProps {
  items: RecoveryItem[];
  onResume(item: RecoveryItem): Promise<void>;
  onAbandon(item: RecoveryItem): Promise<void>;
  onViewLogs(): Promise<void> | void;
  onDismiss(): void;
}

const KIND_LABELS: Readonly<Record<RecoveryItem['kind'], string>> = {
  task: '任务',
  workflow: 'Agent Workflow',
  process: '子进程',
  permission: '权限请求',
  mutation: '文件修改',
};

export function RecoveryCenter({
  items,
  onResume,
  onAbandon,
  onViewLogs,
  onDismiss,
}: RecoveryCenterProps) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (item: RecoveryItem, action: 'resume' | 'abandon') => {
    setPendingId(item.id);
    setError(null);
    try {
      if (action === 'resume') await onResume(item);
      else await onAbandon(item);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-5" role="dialog" aria-modal="true" aria-label="恢复中心">
      <div className="w-full max-w-2xl overflow-hidden rounded-xl" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
        <header className="flex items-start justify-between gap-4 px-5 py-4" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          <div className="flex gap-3">
            <AlertTriangle size={22} style={{ color: 'var(--warning)' }} />
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>检测到异常退出</h2>
              <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                Workbench 已停止未完成的写入并清除待处理权限。不会自动继续修改项目，请检查后显式恢复。
              </p>
            </div>
          </div>
          <button onClick={onDismiss} aria-label="关闭恢复中心" className="rounded p-1" style={{ color: 'var(--text-secondary)' }}><X size={17} /></button>
        </header>

        <div className="max-h-[55vh] space-y-3 overflow-y-auto p-5">
          {items.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>没有待处理的恢复项。</p>
          ) : items.map((item) => {
            const busy = pendingId === item.id;
            const resumable = item.kind === 'workflow' || item.kind === 'task';
            return (
              <article key={item.id} className="rounded-lg p-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-secondary)' }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{KIND_LABELS[item.kind]}</div>
                    <div className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      中断状态：{item.lastState} · {new Date(item.detectedAt).toLocaleString()}
                    </div>
                    <div className="mt-1 max-w-lg truncate font-mono text-[11px]" title={item.resourceId} style={{ color: 'var(--text-tertiary)' }}>{item.resourceId}</div>
                  </div>
                  <div className="flex gap-2">
                    {resumable && (
                      <button disabled={busy || pendingId !== null} onClick={() => void act(item, 'resume')} className="flex items-center gap-1 rounded px-2.5 py-1.5 text-xs" style={{ color: 'var(--accent-text)', background: 'var(--accent)', opacity: busy ? 0.5 : 1 }}>
                        <Play size={12} />恢复任务
                      </button>
                    )}
                    <button disabled={busy || pendingId !== null} onClick={() => void act(item, 'abandon')} className="flex items-center gap-1 rounded px-2.5 py-1.5 text-xs" style={{ color: 'var(--error)', background: 'var(--bg-hover)', opacity: busy ? 0.5 : 1 }}>
                      <Trash2 size={12} />放弃任务
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
          {error && <p role="alert" className="rounded p-2 text-xs" style={{ color: 'var(--error)', background: 'var(--error-light)' }}>{error}</p>}
        </div>

        <footer className="flex justify-between px-5 py-3" style={{ borderTop: '1px solid var(--border-primary)' }}>
          <button onClick={() => void onViewLogs()} className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs" style={{ color: 'var(--text-secondary)', background: 'var(--bg-hover)' }}><FileText size={13} />查看日志</button>
          <button onClick={onDismiss} className="rounded px-3 py-1.5 text-xs" style={{ color: 'var(--text-secondary)', background: 'var(--bg-hover)' }}>稍后处理</button>
        </footer>
      </div>
    </div>
  );
}
