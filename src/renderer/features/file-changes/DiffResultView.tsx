import React, { Suspense, lazy } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { DiffResult } from '../../../shared/types/fileChanges';

const MonacoDiffViewer = lazy(() => import('./MonacoDiffViewer'));

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface DiffResultViewProps {
  projectPath: string;
  filePath: string;
  diff: DiffResult | null;
  loading: boolean;
  error: string | null;
  mode: 'unified' | 'split';
  theme: 'light' | 'dark';
}

export function DiffResultView({
  projectPath,
  filePath,
  diff,
  loading,
  error,
  mode,
  theme,
}: DiffResultViewProps) {
  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-xs" style={{ color: 'var(--text-disabled)' }}>
        正在读取 HEAD → 工作区差异…
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-3 rounded-lg px-3 py-4 text-xs" style={{ color: 'var(--error)', background: 'var(--error-bg)' }}>
        {error}
      </div>
    );
  }

  if (!diff) return null;

  if (diff.isBinary) {
    return (
      <div className="m-3 rounded-lg px-3 py-5 text-center text-xs" style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}>
        这是二进制或非 UTF-8 文件。为避免损坏和高内存占用，不加载文件正文。
      </div>
    );
  }

  if (diff.tooLarge && diff.limit) {
    return (
      <div className="m-3 rounded-lg px-3 py-5 text-center text-xs" style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}>
        <AlertTriangle size={18} className="mx-auto mb-2" style={{ color: 'var(--warning)' }} />
        {diff.limit.reason === 'bytes'
          ? `文件超过 ${formatBytes(diff.limit.maxBytes)} 安全上限（HEAD ${formatBytes(diff.limit.oldBytes)} / 工作区 ${formatBytes(diff.limit.newBytes)}）。`
          : `文件超过 ${diff.limit.maxLines.toLocaleString()} 行安全上限（HEAD ${diff.limit.oldLines?.toLocaleString() ?? '未知'} / 工作区 ${diff.limit.newLines?.toLocaleString() ?? '未知'}）。`}
        <div className="mt-1" style={{ color: 'var(--text-disabled)' }}>可在外部编辑器中查看完整文件。</div>
      </div>
    );
  }

  return (
    <Suspense fallback={(
      <div className="flex h-[360px] items-center justify-center text-xs" style={{ color: 'var(--text-disabled)' }}>
        正在加载 Monaco…
      </div>
    )}>
      <MonacoDiffViewer
        projectPath={projectPath}
        filePath={filePath}
        oldContent={diff.oldContent}
        newContent={diff.newContent}
        mode={mode}
        theme={theme}
      />
    </Suspense>
  );
}
