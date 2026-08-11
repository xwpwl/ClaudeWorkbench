import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, FileDiff } from 'lucide-react';
import type { DiffResult, FileChange } from '../../../shared/types/fileChanges';
import { DiffResultView } from './DiffResultView';
import { runBoundedBatch } from './diffBatch';

const INITIAL_BATCH_SIZE = 3;
const MAX_CONCURRENT_DIFFS = 2;

interface DiffLoadState {
  loading: boolean;
  diff: DiffResult | null;
  error: string | null;
}

interface AllFileChangesViewProps {
  files: readonly FileChange[];
  projectPath: string;
  mode: 'unified' | 'split';
  theme: 'light' | 'dark';
  onSelectFile: (filePath: string) => void;
}

export function AllFileChangesView({
  files,
  projectPath,
  mode,
  theme,
  onSelectFile,
}: AllFileChangesViewProps) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_BATCH_SIZE);
  const [loads, setLoads] = useState<Record<string, DiffLoadState>>({});
  const generationRef = useRef(0);
  const scheduledRef = useRef(new Set<string>());
  const visibleFiles = useMemo(() => files.slice(0, visibleCount), [files, visibleCount]);
  const currentBatchLoading = visibleFiles.some((file) => loads[file.filePath]?.loading ?? true);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const pending = visibleFiles.filter((file) => !scheduledRef.current.has(file.filePath));
    if (pending.length === 0) return;
    const generation = generationRef.current;
    for (const file of pending) scheduledRef.current.add(file.filePath);
    setLoads((current) => {
      const next = { ...current };
      for (const file of pending) next[file.filePath] = { loading: true, diff: null, error: null };
      return next;
    });

    void runBoundedBatch(
      pending,
      MAX_CONCURRENT_DIFFS,
      (file) => window.api.getFileDiff(file.filePath, projectPath),
      (settlement) => {
        const { item: file } = settlement;
        if (settlement.status === 'fulfilled') {
          setLoads((current) => ({
            ...current,
            [file.filePath]: { loading: false, diff: settlement.value, error: null },
          }));
        } else {
          setLoads((current) => ({
            ...current,
            [file.filePath]: {
              loading: false,
              diff: null,
              error: settlement.reason instanceof Error
                ? settlement.reason.message
                : '无法读取文件差异。',
            },
          }));
        }
      },
      () => generation === generationRef.current,
    );
  }, [projectPath, visibleFiles]);

  if (files.length === 0) return null;

  return (
    <div className="space-y-3 p-3">
      <div className="rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--text-tertiary)', background: 'var(--bg-tertiary)' }}>
        全部修改按批次加载，每批 {INITIAL_BATCH_SIZE} 个文件、最多 {MAX_CONCURRENT_DIFFS} 个并发；二进制及超限正文不会进入渲染器。
      </div>

      {visibleFiles.map((file) => {
        const state = loads[file.filePath] ?? { loading: true, diff: null, error: null };
        return (
          <section key={file.filePath} className="overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border-secondary)' }}>
            <div className="flex items-center gap-2 px-3 py-2" style={{ background: 'var(--bg-hover)' }}>
              <FileDiff size={13} style={{ color: 'var(--accent)' }} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.filePath}</span>
              {file.statsAvailable && (
                <span className="text-[10px]">
                  <span style={{ color: 'var(--success)' }}>+{file.additions}</span>{' '}
                  <span style={{ color: 'var(--error)' }}>-{file.deletions}</span>
                </span>
              )}
              <button
                onClick={() => onSelectFile(file.filePath)}
                className="rounded px-2 py-1 text-[10px]"
                style={{ color: 'var(--text-tertiary)' }}
              >
                单文件操作
              </button>
            </div>
            <DiffResultView
              projectPath={projectPath}
              filePath={file.filePath}
              diff={state.diff}
              loading={state.loading}
              error={state.error}
              mode={mode}
              theme={theme}
            />
          </section>
        );
      })}

      {visibleCount < files.length && (
        <button
          onClick={() => setVisibleCount((count) => Math.min(files.length, count + INITIAL_BATCH_SIZE))}
          disabled={currentBatchLoading}
          className="flex w-full items-center justify-center gap-1 rounded-lg px-3 py-2 text-xs disabled:cursor-wait disabled:opacity-50"
          style={{ color: 'var(--text-secondary)', background: 'var(--bg-hover)' }}
        >
          <ChevronDown size={13} />
          {currentBatchLoading
            ? '当前批次加载中…'
            : `加载下一批（剩余 ${files.length - visibleCount} 个）`}
        </button>
      )}
    </div>
  );
}
