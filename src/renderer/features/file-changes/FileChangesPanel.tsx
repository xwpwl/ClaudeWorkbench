import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileDiff,
  FileText,
  Files,
  GitCompareArrows,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import type { DiffResult, FileChange, FileChangeType } from '../../../shared/types/fileChanges';
import { t } from '../../i18n';
import { useAppStore } from '../../stores/appStore';
import { AllFileChangesView } from './AllFileChangesView';
import { DiffResultView } from './DiffResultView';

interface FileChangesPanelProps {
  projectPath?: string;
  embedded?: boolean;
  requestedFile?: string | null;
  refreshToken?: number;
}

interface Stats {
  additions: number;
  deletions: number;
  excluded: number;
}

function summarize(files: readonly FileChange[]): Stats {
  return files.reduce<Stats>((total, file) => ({
    additions: total.additions + (file.statsAvailable ? file.additions : 0),
    deletions: total.deletions + (file.statsAvailable ? file.deletions : 0),
    excluded: total.excluded + (file.statsAvailable ? 0 : 1),
  }), { additions: 0, deletions: 0, excluded: 0 });
}

function changeTypeLabel(type: FileChangeType): string {
  switch (type) {
    case 'added': return t('files.added');
    case 'deleted': return t('files.deleted');
    case 'renamed': return '重命名';
    case 'copied': return '复制';
    case 'unmerged': return '冲突';
    default: return t('files.modified');
  }
}

function ChangeIcon({ type }: { type: FileChangeType }) {
  if (type === 'added') return <Plus size={12} style={{ color: 'var(--success)' }} />;
  if (type === 'deleted') return <Trash2 size={12} style={{ color: 'var(--error)' }} />;
  if (type === 'renamed' || type === 'copied') {
    return <GitCompareArrows size={12} style={{ color: 'var(--info)' }} />;
  }
  if (type === 'unmerged') return <AlertTriangle size={12} style={{ color: 'var(--warning)' }} />;
  return <FileText size={12} style={{ color: 'var(--warning)' }} />;
}

export function FileChangesPanel({
  projectPath,
  embedded = false,
  requestedFile,
  refreshToken = 0,
}: FileChangesPanelProps) {
  const [files, setFiles] = useState<FileChange[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState<string | null>(null);
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>('split');
  const [viewScope, setViewScope] = useState<'selected' | 'all'>('selected');
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [fileRevision, setFileRevision] = useState(0);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const currentProjectRef = useRef(projectPath);
  currentProjectRef.current = projectPath;

  const toggleFileDrawer = useAppStore((state) => state.toggleFileDrawer);
  const theme = useAppStore((state) => state.theme);
  const editorTheme: 'light' | 'dark' = theme === 'dark'
    || (theme === 'system' && document.documentElement.classList.contains('dark'))
    ? 'dark'
    : 'light';

  const selectedChange = useMemo(
    () => files.find((file) => file.filePath === selectedFile) ?? null,
    [files, selectedFile],
  );
  const totalStats = useMemo(() => summarize(files), [files]);
  const selectedStats = selectedChange
    ? {
        additions: diff?.filePath === selectedChange.filePath ? diff.additions : selectedChange.additions,
        deletions: diff?.filePath === selectedChange.filePath ? diff.deletions : selectedChange.deletions,
        excluded: selectedChange.statsAvailable ? 0 : 1,
      }
    : null;
  const visibleStats = viewScope === 'selected' && selectedStats ? selectedStats : totalStats;

  const loadFiles = useCallback(async (root: string) => {
    const requestId = ++listRequestRef.current;
    setLoadingFiles(true);
    setPanelError(null);
    try {
      const changes = await window.api.listFileChanges(root);
      if (requestId !== listRequestRef.current || currentProjectRef.current !== root) return;
      setFiles(changes);
      setFileRevision((revision) => revision + 1);
      setSelectedFile((current) => current && changes.some((file) => file.filePath === current)
        ? current
        : null);
    } catch (error) {
      if (requestId !== listRequestRef.current || currentProjectRef.current !== root) return;
      setFiles([]);
      setPanelError(error instanceof Error ? error.message : '无法读取 Git 工作区。');
    } finally {
      if (requestId === listRequestRef.current) setLoadingFiles(false);
    }
  }, []);

  useEffect(() => {
    listRequestRef.current += 1;
    diffRequestRef.current += 1;
    setFiles([]);
    setSelectedFile(null);
    setDiff(null);
    setPanelError(null);
    setDiffError(null);
    if (projectPath) void loadFiles(projectPath);
  }, [loadFiles, projectPath, refreshToken]);

  useEffect(() => {
    if (requestedFile && files.some((file) => file.filePath === requestedFile)) {
      setSelectedFile(requestedFile);
      setViewScope('selected');
    }
  }, [files, requestedFile]);

  useEffect(() => {
    const requestId = ++diffRequestRef.current;
    setDiff(null);
    setDiffError(null);
    if (!selectedFile || !projectPath) {
      setLoadingDiff(false);
      return;
    }

    setLoadingDiff(true);
    void window.api.getFileDiff(selectedFile, projectPath)
      .then((result) => {
        if (requestId !== diffRequestRef.current || currentProjectRef.current !== projectPath) return;
        setDiff(result);
      })
      .catch((error: unknown) => {
        if (requestId !== diffRequestRef.current || currentProjectRef.current !== projectPath) return;
        setDiffError(error instanceof Error ? error.message : '无法读取文件差异。');
      })
      .finally(() => {
        if (requestId === diffRequestRef.current) setLoadingDiff(false);
      });
  }, [fileRevision, projectPath, selectedFile]);

  const handleRestore = useCallback(async (filePath: string) => {
    if (!projectPath) return;
    const root = projectPath;
    try {
      await window.api.restoreFile(filePath, root);
      if (currentProjectRef.current !== root) return;
      setSelectedFile(null);
      setDiff(null);
      await loadFiles(root);
    } catch (error) {
      if (currentProjectRef.current === root) {
        setPanelError(error instanceof Error ? error.message : '无法还原文件。');
      }
    } finally {
      if (currentProjectRef.current === root) setShowRestoreConfirm(null);
    }
  }, [loadFiles, projectPath]);

  const handleOpen = useCallback(async (filePath: string) => {
    if (!projectPath) return;
    try {
      await window.api.openFileInVSCode(filePath, projectPath);
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : '无法打开文件。');
    }
  }, [projectPath]);

  if (!projectPath) {
    return (
      <div className="h-full flex items-center justify-center text-sm" style={{ color: 'var(--text-disabled)' }}>
        {t('files.openToView')}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 flex-shrink-0" style={{ borderBottom: '1px solid var(--border-primary)' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('files.title')}</h2>
            <span className="text-xs px-1.5 py-0.5 rounded" style={{ color: 'var(--text-tertiary)', backgroundColor: 'var(--bg-hover)' }}>
              {files.length} {t('files.count')}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void loadFiles(projectPath)}
              disabled={loadingFiles}
              className="p-1 rounded-md disabled:opacity-40"
              style={{ color: 'var(--text-tertiary)' }}
              title="刷新工作区"
            >
              <RefreshCw size={14} className={loadingFiles ? 'animate-spin' : ''} />
            </button>
            {!embedded ? (
              <button onClick={toggleFileDrawer} className="p-1 rounded-md" style={{ color: 'var(--text-tertiary)' }} title="关闭文件变更">
                <X size={16} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-2 flex items-center gap-1 text-[11px]">
          <button
            onClick={() => setViewScope('selected')}
            className="flex items-center gap-1 rounded px-2 py-1"
            style={{ background: viewScope === 'selected' ? 'var(--bg-active)' : 'transparent' }}
          >
            <FileDiff size={11} /> 单文件查看
          </button>
          <button
            onClick={() => setViewScope('all')}
            className="flex items-center gap-1 rounded px-2 py-1"
            style={{ background: viewScope === 'all' ? 'var(--bg-active)' : 'transparent' }}
          >
            <Files size={11} /> 全部修改
          </button>
          <span className="ml-auto" style={{ color: 'var(--success)' }}>+{visibleStats.additions}</span>
          <span style={{ color: 'var(--error)' }}>-{visibleStats.deletions}</span>
          {visibleStats.excluded > 0 && (
            <span title="二进制或过大文件未计入文本行统计" style={{ color: 'var(--text-disabled)' }}>
              · {visibleStats.excluded} 未统计
            </span>
          )}
          <span className="mx-1 h-3 w-px" style={{ background: 'var(--border-secondary)' }} />
          <button
            onClick={() => setDiffViewMode('unified')}
            className="rounded px-1.5 py-1"
            style={{ background: diffViewMode === 'unified' ? 'var(--bg-active)' : 'transparent' }}
          >
            Unified
          </button>
          <button
            onClick={() => setDiffViewMode('split')}
            className="rounded px-1.5 py-1"
            style={{ background: diffViewMode === 'split' ? 'var(--bg-active)' : 'transparent' }}
          >
            Split
          </button>
        </div>
      </div>

      {panelError && (
        <div className="mx-3 mt-3 rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--error)', background: 'var(--error-bg)' }}>
          {panelError}
        </div>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-hidden">
        {loadingFiles && files.length === 0 ? (
          <div className="py-8 text-center text-sm" style={{ color: 'var(--text-disabled)' }}>正在读取 Git 工作区…</div>
        ) : files.length === 0 ? (
          <div className="text-center py-8 text-sm" style={{ color: 'var(--text-disabled)' }}>{t('files.noChanges')}</div>
        ) : viewScope === 'all' ? (
          <AllFileChangesView
            key={`${projectPath}:${fileRevision}`}
            files={files}
            projectPath={projectPath}
            mode={diffViewMode}
            theme={editorTheme}
            onSelectFile={(filePath) => {
              setSelectedFile(filePath);
              setViewScope('selected');
            }}
          />
        ) : files.map((file) => {
          const selected = selectedFile === file.filePath;
          return (
            <div key={file.filePath}>
              <button
                onClick={() => {
                  const next = selected ? null : file.filePath;
                  setSelectedFile(next);
                  if (next) setViewScope('selected');
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm"
                style={{
                  color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
                  backgroundColor: selected ? 'var(--bg-hover)' : 'transparent',
                }}
              >
                {selected ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <ChangeIcon type={file.changeType} />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate font-mono text-xs">{file.filePath}</span>
                  {file.originalPath && (
                    <span className="block truncate text-[10px]" style={{ color: 'var(--text-disabled)' }}>
                      原路径：{file.originalPath}
                    </span>
                  )}
                </span>
                {file.statsAvailable ? (
                  <span className="text-[10px] whitespace-nowrap">
                    <span style={{ color: 'var(--success)' }}>+{file.additions}</span>{' '}
                    <span style={{ color: 'var(--error)' }}>-{file.deletions}</span>
                  </span>
                ) : (
                  <span className="text-[10px]" style={{ color: 'var(--text-disabled)' }}>{file.isBinary ? '二进制' : '未统计'}</span>
                )}
                <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{changeTypeLabel(file.changeType)}</span>
              </button>

              {selected && (
                <div className="mx-3 mb-3 rounded-lg border" style={{ borderColor: 'var(--border-secondary)' }}>
                  <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderBottom: '1px solid var(--border-secondary)' }}>
                    <button
                      onClick={() => void navigator.clipboard.writeText(file.filePath)}
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      <Copy size={11} /> {t('common.copy')}
                    </button>
                    <button
                      onClick={() => void handleOpen(file.filePath)}
                      disabled={file.changeType === 'deleted'}
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs disabled:opacity-40"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      <ExternalLink size={11} /> 打开
                    </button>
                    <button
                      onClick={() => setShowRestoreConfirm(file.filePath)}
                      disabled={!file.canRestore}
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs disabled:opacity-40"
                      style={{ color: 'var(--text-tertiary)' }}
                      title={file.canRestore ? '恢复到 HEAD' : '为安全起见，不自动删除新增或未跟踪文件'}
                    >
                      <RotateCcw size={11} /> {t('common.restore')}
                    </button>
                  </div>
                  <DiffResultView
                    projectPath={projectPath}
                    filePath={file.filePath}
                    diff={diff}
                    loading={loadingDiff}
                    error={diffError}
                    mode={diffViewMode}
                    theme={editorTheme}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showRestoreConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'var(--bg-overlay)' }}>
          <div className="rounded-xl p-4 max-w-sm" style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)', boxShadow: 'var(--shadow-lg)' }}>
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle size={18} style={{ color: 'var(--warning)' }} />
              <h3 className="text-sm font-semibold">{t('files.restoreTitle')}</h3>
            </div>
            <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>{t('files.restoreConfirm')}</p>
            <p className="mb-4 break-all font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>{showRestoreConfirm}</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowRestoreConfirm(null)} className="px-3 py-1.5 text-sm rounded-lg" style={{ backgroundColor: 'var(--bg-hover)' }}>{t('common.cancel')}</button>
              <button onClick={() => void handleRestore(showRestoreConfirm)} className="px-3 py-1.5 text-sm rounded-lg font-medium" style={{ color: 'white', backgroundColor: 'var(--error)' }}>{t('common.restore')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
