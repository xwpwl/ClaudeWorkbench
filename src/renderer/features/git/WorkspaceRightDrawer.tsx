import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clipboard,
  Code2,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { Project } from '../../../shared/types/project';
import type {
  Checkpoint,
  CommitTaskResult,
  RestoreImpact,
} from '../../../shared/types/checkpoint';
import type { CommitPreview, GitStatus, GitStatusFile } from '../../../shared/types/git';
import { useAppStore } from '../../stores/appStore';
import { FileChangesPanel } from '../file-changes/FileChangesPanel';
import {
  canConfirmRestore,
  checkpointLabel,
  classifyChangeOwnership,
  findTaskBaseline,
  gitChangeCode,
  gitMutationsAvailable,
  gitPanelState,
  gitStatusOutcome,
  groupGitFiles,
  relativeCheckpointTime,
  restoreImpactSummary,
} from './gitPanelModel';

export type GitDrawerTab = 'files' | 'git' | 'checkpoints';
export interface GitActionRequest {
  id: number;
  kind: 'accept' | 'restore' | 'diff';
  projectId: string;
  projectPath: string;
  taskId: string;
}

export function matchesGitActionContext(
  request: GitActionRequest,
  project: Pick<Project, 'id' | 'path'> | null,
  taskId?: string,
): boolean {
  return Boolean(
    project
    && taskId
    && request.projectId === project.id
    && request.projectPath === project.path
    && request.taskId === taskId,
  );
}

export function findGitActionBaseline(
  checkpoints: readonly Checkpoint[],
  request: GitActionRequest,
): Checkpoint | null {
  return checkpoints.find((checkpoint) => (
    checkpoint.taskId === request.taskId && checkpoint.type === 'before_task'
  )) ?? null;
}

export function matchesCheckpointRestoreContext(
  checkpoint: Checkpoint,
  impact: RestoreImpact,
  project: Pick<Project, 'path'> | null,
  taskId?: string,
): boolean {
  return Boolean(
    project
    && taskId
    && checkpoint.projectPath === project.path
    && checkpoint.taskId === taskId
    && impact.checkpointId === checkpoint.id
    && impact.taskId === checkpoint.taskId,
  );
}

interface WorkspaceRightDrawerProps {
  project: Project | null;
  taskId?: string;
  actionRequest?: GitActionRequest | null;
  refreshToken?: number;
  onActionHandled?: (id: number) => void;
  onTaskDataChanged?: () => void;
}

const GROUP_LABELS = [
  ['modified', 'Modified'],
  ['added', 'Added'],
  ['deleted', 'Deleted'],
  ['untracked', 'Untracked'],
  ['other', 'Other'],
] as const;

export function NonRepositoryGitCard({
  busy,
  error,
  onInitialize,
  onOpenExplorer,
  onClose,
}: {
  busy: boolean;
  error: string | null;
  onInitialize: () => void;
  onOpenExplorer: () => void;
  onClose: () => void;
}) {
  return (
    <div className="mx-3 rounded-lg border p-4" style={{ borderColor: 'var(--border-secondary)' }} data-testid="git-state-not-repository">
      <div className="flex items-center gap-2 text-sm font-medium"><AlertTriangle size={15} />当前项目不是 Git 仓库</div>
      <p className="mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>Checkpoint 由 Git 支持，初始化前不可用。</p>
      {error ? <p className="mt-2 break-words text-xs" style={{ color: 'var(--error)' }} data-testid="git-initialize-error">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" data-testid="git-initialize" onClick={onInitialize} disabled={busy} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-white disabled:opacity-40" style={{ background: 'var(--accent)' }}>
          {busy ? <LoaderCircle size={12} className="animate-spin" /> : <GitBranch size={12} />}初始化 Git
        </button>
        <button type="button" data-testid="git-open-explorer" onClick={onOpenExplorer} disabled={busy} className="rounded-lg px-3 py-1.5 text-xs disabled:opacity-40" style={{ background: 'var(--bg-hover)' }}>在资源管理器中打开</button>
        <button type="button" data-testid="git-close" onClick={onClose} disabled={busy} className="rounded-lg px-3 py-1.5 text-xs disabled:opacity-40" style={{ background: 'var(--bg-hover)' }}>关闭面板</button>
      </div>
    </div>
  );
}

export function GitBackedCheckpointUnavailable() {
  return (
    <div className="rounded-lg border p-4 text-sm" style={{ borderColor: 'var(--border-secondary)' }} data-testid="checkpoint-git-unavailable">
      <div className="font-medium">Checkpoint 由 Git 支持</div>
      <p className="mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>当前项目还不是 Git 仓库；初始化 Git 后可用。Workbench 不会创建替代的文件 Checkpoint。</p>
    </div>
  );
}

export function CheckpointRestoreDialog({
  checkpoint,
  impact,
  busy,
  onCancel,
  onConfirm,
}: {
  checkpoint: Checkpoint;
  impact: RestoreImpact;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmable = canConfirmRestore(impact);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" style={{ background: 'var(--bg-overlay)' }} data-testid="checkpoint-restore-dialog" data-checkpoint-id={checkpoint.id}>
      <div className="w-[460px] max-w-[calc(100vw-32px)] rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="mb-3 flex items-center gap-2">
          <AlertTriangle size={18} style={{ color: 'var(--warning)' }} />
          <h3 className="text-sm font-semibold">恢复到「{checkpointLabel(checkpoint.type)}」Checkpoint</h3>
        </div>
        <div className="mb-2 break-all font-mono text-[10px]" style={{ color: 'var(--text-disabled)' }} data-testid="checkpoint-restore-target">目标：{checkpoint.id}</div>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{restoreImpactSummary(impact)}</p>
        {impact.preservedUserFiles.length > 0 ? (
          <div className="mt-3 rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--success-bg)', color: 'var(--success)' }}>
            <div className="flex items-center gap-1 font-medium"><ShieldCheck size={13} />不会修改任务开始前的用户文件</div>
            <div className="mt-1 break-all">{impact.preservedUserFiles.join('\n')}</div>
          </div>
        ) : null}
        {impact.blockedFiles.length > 0 ? (
          <div className="mt-3 rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}>
            {impact.blockedFiles.map((file) => <div key={file.filePath}>{file.filePath}：{file.reason}</div>)}
          </div>
        ) : null}
        <details className="mt-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          <summary className="cursor-pointer">查看影响文件</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded p-2" style={{ background: 'var(--bg-hover)' }}>
            {[...impact.restoreFiles.map((file) => `恢复  ${file}`), ...impact.deleteFiles.map((file) => `删除  ${file}`)].join('\n') || '没有可恢复的任务文件'}
          </pre>
        </details>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" data-testid="checkpoint-restore-cancel" onClick={onCancel} disabled={busy} className="rounded-lg px-3 py-1.5 text-sm" style={{ background: 'var(--bg-hover)' }}>取消</button>
          <button type="button" data-testid="checkpoint-restore-confirm" onClick={onConfirm} disabled={!confirmable || busy} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-white disabled:opacity-40" style={{ background: 'var(--error)' }}>
            {busy ? <LoaderCircle size={13} className="animate-spin" /> : <RotateCcw size={13} />}恢复到此 Checkpoint
          </button>
        </div>
      </div>
    </div>
  );
}

const GitFileList = memo(function GitFileList({
  files,
  onOpen,
}: {
  files: readonly GitStatusFile[];
  onOpen: (filePath: string) => void;
}) {
  const groups = useMemo(() => groupGitFiles(files), [files]);
  if (files.length === 0) return <div className="py-10 text-center text-sm" style={{ color: 'var(--text-disabled)' }}>工作区没有修改</div>;
  return (
    <div className="space-y-3" data-testid="git-change-list">
      {GROUP_LABELS.map(([key, label]) => groups[key].length > 0 ? (
        <section key={key}>
          <h4 className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{label} · {groups[key].length}</h4>
          {groups[key].map((file) => (
            <button key={file.filePath} type="button" data-testid="git-file-row" data-file-path={file.filePath} onClick={() => onOpen(file.filePath)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-hover)]">
              <span className="w-4 text-center font-mono text-xs" style={{ color: file.changeType === 'deleted' ? 'var(--error)' : file.changeType === 'modified' ? 'var(--warning)' : 'var(--success)' }}>{gitChangeCode(file.changeType)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.filePath}</span>
              {file.statsAvailable ? <span className="text-[10px]"><span style={{ color: 'var(--success)' }}>+{file.additions}</span> <span style={{ color: 'var(--error)' }}>-{file.deletions}</span></span> : null}
            </button>
          ))}
        </section>
      ) : null)}
    </div>
  );
});

export function WorkspaceRightDrawer({
  project,
  taskId,
  actionRequest,
  refreshToken = 0,
  onActionHandled,
  onTaskDataChanged,
}: WorkspaceRightDrawerProps) {
  const [tab, setTab] = useState<GitDrawerTab>('files');
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [restorePreview, setRestorePreview] = useState<{
    checkpoint: Checkpoint;
    impact: RestoreImpact;
    contextIdentity: string;
  } | null>(null);
  const [commitPreview, setCommitPreview] = useState<CommitPreview | null>(null);
  const [commitResult, setCommitResult] = useState<CommitTaskResult | null>(null);
  const [confirmCommit, setConfirmCommit] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gitErrorCode, setGitErrorCode] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const requestRef = useRef(0);
  const mutationRef = useRef(0);
  const handledActionRef = useRef(0);
  const dataIdentityRef = useRef('');
  const toggleFileDrawer = useAppStore((state) => state.toggleFileDrawer);
  const ownership = useMemo(
    () => classifyChangeOwnership(status?.files ?? [], checkpoints),
    [checkpoints, status?.files],
  );
  const panelState = useMemo(() => gitPanelState({
    projectPath: project?.path ?? '',
    status,
    loading,
    error,
    errorCode: gitErrorCode,
  }), [error, gitErrorCode, loading, project?.path, status]);

  const refresh = useCallback(async () => {
    if (!project) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    setGitErrorCode(null);
    try {
      const [statusResult, checkpointResult] = await Promise.allSettled([
        window.api.getGitWorkspaceStatus(project.id, project.path),
        taskId ? window.api.listCheckpoints(taskId) : Promise.resolve([]),
      ]);
      if (requestId !== requestRef.current) return;
      const statusOutcome = gitStatusOutcome(statusResult);
      setStatus(statusOutcome.status);
      if (statusOutcome.errorCode === 'NOT_A_REPOSITORY') {
        setCheckpoints([]);
        setCommitPreview(null);
        setCommitResult(null);
        setConfirmCommit(false);
        setRestorePreview(null);
      } else if (checkpointResult.status === 'fulfilled') {
        setCheckpoints(checkpointResult.value);
      }
      const failures = [
        statusOutcome.error,
        statusOutcome.errorCode !== 'NOT_A_REPOSITORY' && checkpointResult.status === 'rejected'
          ? checkpointResult.reason instanceof Error
            ? checkpointResult.reason.message
            : String(checkpointResult.reason)
          : null,
      ].filter((message): message is string => message !== null);
      setGitErrorCode(statusOutcome.errorCode);
      if (failures.length > 0) setError(failures.join('；'));
      setRevision((value) => value + 1);
    } catch (nextError) {
      if (requestId === requestRef.current) {
        const failed = gitStatusOutcome({ status: 'rejected', reason: nextError });
        setStatus(null);
        setError(failed.error ?? '无法读取 Git 工作区');
        setGitErrorCode(failed.errorCode);
      }
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [project, taskId]);

  useEffect(() => {
    const dataIdentity = `${project?.id ?? ''}\0${project?.path ?? ''}\0${taskId ?? ''}`;
    if (dataIdentityRef.current !== dataIdentity) {
      dataIdentityRef.current = dataIdentity;
      mutationRef.current += 1;
      setBusy(false);
      setInitializationError(null);
      setError(null);
      setGitErrorCode(null);
      setStatus(null);
      setCheckpoints([]);
      setCommitPreview(null);
      setCommitResult(null);
      setRestorePreview(null);
    }
    void refresh();
    return () => { requestRef.current += 1; };
  }, [project?.id, project?.path, refresh, refreshToken, taskId]);

  const initializeGit = useCallback(async () => {
    if (!project || panelState.kind !== 'not_repository') return;
    const contextIdentity = dataIdentityRef.current;
    const operationId = ++mutationRef.current;
    setBusy(true);
    setInitializationError(null);
    try {
      await window.api.initializeGitWorkspace(project.id, project.path);
      if (mutationRef.current !== operationId || dataIdentityRef.current !== contextIdentity) return;
      await refresh();
      if (mutationRef.current === operationId && dataIdentityRef.current === contextIdentity) {
        onTaskDataChanged?.();
      }
    } catch (nextError) {
      if (mutationRef.current === operationId && dataIdentityRef.current === contextIdentity) {
        setInitializationError(nextError instanceof Error ? nextError.message : '初始化 Git 失败');
      }
    } finally {
      if (mutationRef.current === operationId) setBusy(false);
    }
  }, [onTaskDataChanged, panelState.kind, project, refresh]);

  const beginRestore = useCallback(async (checkpoint: Checkpoint) => {
    if (!project || !taskId
      || checkpoint.projectPath !== project.path
      || checkpoint.taskId !== taskId) {
      setError('Checkpoint 不属于当前项目和任务');
      return;
    }
    const contextIdentity = dataIdentityRef.current;
    const operationId = ++mutationRef.current;
    setBusy(true);
    setError(null);
    try {
      const impact = await window.api.previewCheckpointRestore(checkpoint.id);
      if (mutationRef.current !== operationId || dataIdentityRef.current !== contextIdentity) return;
      if (!matchesCheckpointRestoreContext(checkpoint, impact, project, taskId)) {
        throw new Error('Checkpoint 恢复预览与当前目标不一致');
      }
      setRestorePreview({ checkpoint, impact, contextIdentity });
    } catch (nextError) {
      if (mutationRef.current === operationId) {
        setError(nextError instanceof Error ? nextError.message : '无法生成恢复预览');
      }
    } finally {
      if (mutationRef.current === operationId) setBusy(false);
    }
  }, [project, taskId]);

  const acceptChanges = useCallback(async (requestedTaskId = taskId) => {
    if (!requestedTaskId || requestedTaskId !== taskId) return;
    const operationId = ++mutationRef.current;
    setBusy(true);
    setError(null);
    try {
      const result = await window.api.acceptTaskChanges(requestedTaskId);
      if (mutationRef.current !== operationId) return;
      setCommitPreview(result.preview);
      setCommitResult(null);
      await refresh();
      if (mutationRef.current === operationId) onTaskDataChanged?.();
    } catch (nextError) {
      if (mutationRef.current === operationId) {
        setError(nextError instanceof Error ? nextError.message : '接受任务修改失败');
      }
    } finally {
      if (mutationRef.current === operationId) setBusy(false);
    }
  }, [onTaskDataChanged, refresh, taskId]);

  const generateCommitPreview = useCallback(async () => {
    if (!taskId) return;
    const operationId = ++mutationRef.current;
    setBusy(true);
    setError(null);
    try {
      const preview = await window.api.createCommitPreview(taskId);
      if (mutationRef.current !== operationId) return;
      setCommitPreview(preview);
      setCommitResult(null);
    } catch (nextError) {
      if (mutationRef.current === operationId) {
        setError(nextError instanceof Error ? nextError.message : '生成 Commit Preview 失败');
      }
    } finally {
      if (mutationRef.current === operationId) setBusy(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (!actionRequest || handledActionRef.current === actionRequest.id) return;
    if (!matchesGitActionContext(actionRequest, project, taskId)) {
      handledActionRef.current = actionRequest.id;
      onActionHandled?.(actionRequest.id);
      return;
    }
    if (actionRequest.kind === 'diff') {
      handledActionRef.current = actionRequest.id;
      setTab('files');
      onActionHandled?.(actionRequest.id);
      return;
    }
    setTab(actionRequest.kind === 'restore' ? 'checkpoints' : 'git');
    if (panelState.kind === 'loading') return;
    if (!gitMutationsAvailable(panelState)) {
      handledActionRef.current = actionRequest.id;
      onActionHandled?.(actionRequest.id);
      return;
    }
    handledActionRef.current = actionRequest.id;
    void (async () => {
      const actionIdentity = dataIdentityRef.current;
      try {
        if (actionRequest.kind === 'accept') {
          await acceptChanges(actionRequest.taskId);
        } else {
          const dataIdentity = dataIdentityRef.current;
          const fresh = await window.api.listCheckpoints(actionRequest.taskId);
          if (dataIdentityRef.current !== dataIdentity) return;
          setCheckpoints(fresh);
          const baseline = findGitActionBaseline(fresh, actionRequest);
          if (!baseline) throw new Error('没有找到任务开始检查点');
          await beginRestore(baseline);
        }
      } catch (nextError) {
        if (dataIdentityRef.current === actionIdentity) {
          setError(nextError instanceof Error ? nextError.message : 'Git 操作失败');
        }
      } finally {
        onActionHandled?.(actionRequest.id);
      }
    })();
  }, [acceptChanges, actionRequest, beginRestore, onActionHandled, panelState, project, taskId]);

  const createManualCheckpoint = useCallback(async () => {
    if (!taskId) return;
    const operationId = ++mutationRef.current;
    setBusy(true);
    setError(null);
    try {
      await window.api.createCheckpoint(taskId, 'manual');
      if (mutationRef.current !== operationId) return;
      await refresh();
    } catch (nextError) {
      if (mutationRef.current === operationId) {
        setError(nextError instanceof Error ? nextError.message : '创建检查点失败');
      }
    } finally {
      if (mutationRef.current === operationId) setBusy(false);
    }
  }, [refresh, taskId]);

  const confirmRestore = useCallback(async () => {
    if (!restorePreview) return;
    const { checkpoint, impact, contextIdentity } = restorePreview;
    if (dataIdentityRef.current !== contextIdentity
      || !matchesCheckpointRestoreContext(checkpoint, impact, project, taskId)) {
      setRestorePreview(null);
      setError('项目或任务已切换，请重新预览恢复影响');
      return;
    }
    const operationId = ++mutationRef.current;
    setBusy(true);
    try {
      await window.api.restoreCheckpoint(checkpoint.id, impact.confirmationToken);
      if (mutationRef.current !== operationId) return;
      setRestorePreview(null);
      await refresh();
      if (mutationRef.current === operationId) onTaskDataChanged?.();
    } catch (nextError) {
      if (mutationRef.current === operationId) {
        setError(nextError instanceof Error ? nextError.message : '恢复检查点失败');
        // Restore grants are single-use, including stale/blocked attempts. Close the
        // old impact so the next click must obtain a fresh fingerprint and token.
        setRestorePreview(null);
      }
    } finally {
      if (mutationRef.current === operationId) setBusy(false);
    }
  }, [onTaskDataChanged, project, refresh, restorePreview, taskId]);

  const commit = useCallback(async () => {
    if (!taskId || !commitPreview) return;
    const operationId = ++mutationRef.current;
    setBusy(true);
    try {
      const result = await window.api.commitTaskChanges(taskId, commitPreview.subject, true);
      if (mutationRef.current !== operationId) return;
      setCommitResult(result);
      setConfirmCommit(false);
      await refresh();
      if (mutationRef.current === operationId) onTaskDataChanged?.();
    } catch (nextError) {
      if (mutationRef.current === operationId) {
        setError(nextError instanceof Error ? nextError.message : '创建 Commit 失败');
      }
    } finally {
      if (mutationRef.current === operationId) setBusy(false);
    }
  }, [commitPreview, onTaskDataChanged, refresh, taskId]);

  if (!project) return <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--text-disabled)' }}>请先打开项目</div>;

  return (
    <div className="flex h-full flex-col" data-testid="workspace-right-drawer">
      <header className="flex items-center gap-1 border-b px-2 py-2" style={{ borderColor: 'var(--border-primary)' }}>
        {([['files', '文件', FileDiff], ['git', 'Git', GitBranch], ['checkpoints', 'Checkpoint', History]] as const).map(([value, label, Icon]) => (
          <button key={value} type="button" data-testid="right-drawer-tab" data-tab={value} onClick={() => setTab(value)} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs" style={{ background: tab === value ? 'var(--bg-active)' : 'transparent', color: tab === value ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
            <Icon size={12} />{label}
          </button>
        ))}
        <button type="button" onClick={() => void refresh()} disabled={loading || busy} className="ml-auto rounded p-1" title="刷新"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button>
        <button type="button" onClick={toggleFileDrawer} className="rounded p-1" title="关闭"><X size={15} /></button>
      </header>

      {error && tab !== 'git' ? <div className="mx-3 mt-3 rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--error-bg)', color: 'var(--error)' }}>{error}</div> : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'files' ? (
          <FileChangesPanel
            projectPath={project.path}
            embedded
            requestedFile={selectedFile}
            refreshToken={revision}
          />
        ) : tab === 'git' ? (
          <div className="h-full overflow-y-auto py-3 scrollbar-hidden">
            {panelState.kind === 'loading' ? (
              <div className="mx-3 flex items-center gap-2 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--border-secondary)', color: 'var(--text-tertiary)' }} data-testid="git-state-loading">
                <LoaderCircle size={14} className="animate-spin" />正在读取 Git 状态
              </div>
            ) : panelState.kind === 'not_repository' ? (
              <NonRepositoryGitCard
                busy={busy}
                error={initializationError}
                onInitialize={() => void initializeGit()}
                onOpenExplorer={() => void window.api.openPath(project.path)}
                onClose={toggleFileDrawer}
              />
            ) : panelState.kind === 'error' ? (
              <div className="mx-3 rounded-lg border p-4" style={{ borderColor: 'var(--border-secondary)' }} data-testid="git-state-error">
                <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--error)' }}><AlertTriangle size={15} />无法读取 Git 状态</div>
                <p className="mt-2 break-words text-xs" style={{ color: 'var(--text-tertiary)' }}>{panelState.message}</p>
                <button type="button" onClick={() => void refresh()} className="mt-3 inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs" style={{ background: 'var(--bg-hover)' }}><RefreshCw size={12} />重试</button>
              </div>
            ) : (
              <>
                <div className="mx-3 mb-3 rounded-lg border p-3" style={{ borderColor: 'var(--border-secondary)' }} data-testid="git-status-summary">
                  <div className="flex items-center gap-2 text-sm font-medium"><GitBranch size={14} />{panelState.branchLabel}</div>
                  <div className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {`${panelState.status.files.length} files changed · +${panelState.status.additions} / -${panelState.status.deletions}`}
                  </div>
                </div>
                {findTaskBaseline(checkpoints) ? (
                  <div className="mx-3 mb-3 grid grid-cols-2 gap-2 text-[11px]" data-testid="git-change-ownership">
                    <div className="rounded-lg px-3 py-2" style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}>
                      <div className="font-medium">任务前已有修改</div>
                      <div className="mt-0.5">{ownership.beforeTask.length} 个文件</div>
                    </div>
                    <div className="rounded-lg px-3 py-2" style={{ background: 'var(--accent-light)', color: 'var(--accent)' }}>
                      <div className="font-medium">Claude 本任务修改</div>
                      <div className="mt-0.5">{ownership.taskChanges.length} 个文件</div>
                    </div>
                    {ownership.protectedUserChanges.length > 0 ? (
                      <div className="col-span-2 truncate" title={ownership.protectedUserChanges.map((file) => file.filePath).join('\n')} style={{ color: 'var(--success)' }}>
                        <ShieldCheck size={11} className="mr-1 inline" />{ownership.protectedUserChanges.length} 个仅用户修改文件受保护
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="mx-3 mb-3 flex flex-wrap gap-2">
                  <button type="button" data-testid="checkpoint-accept" onClick={() => void acceptChanges()} disabled={!taskId || busy} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-white disabled:opacity-40" style={{ background: 'var(--success)' }}><CheckCircle2 size={12} />接受全部修改</button>
                  <button type="button" data-testid="commit-preview-create" onClick={() => void generateCommitPreview()} disabled={!taskId || busy} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs disabled:opacity-40" style={{ background: 'var(--bg-hover)' }}><GitCommitHorizontal size={12} />生成 Commit Preview</button>
                </div>
                <GitFileList files={panelState.status.files} onOpen={(filePath) => { setSelectedFile(filePath); setTab('files'); }} />
                {commitPreview ? (
                  <div className="mx-3 mt-4 rounded-lg border p-3" style={{ borderColor: 'var(--border-secondary)' }} data-testid="commit-preview">
                    <div className="flex items-center gap-2 text-xs font-semibold"><GitCommitHorizontal size={14} />Commit Preview</div>
                    <code className="mt-2 block break-words rounded px-2 py-2 text-xs" style={{ background: 'var(--bg-hover)' }}>{commitPreview.subject}</code>
                    <div className="mt-2 flex gap-2">
                      <button type="button" onClick={() => void navigator.clipboard.writeText(commitPreview.subject)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs" style={{ background: 'var(--bg-hover)' }}><Clipboard size={11} />复制</button>
                      <button type="button" onClick={() => setConfirmCommit(true)} disabled={commitPreview.fileCount === 0 || busy} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-white disabled:opacity-40" style={{ background: 'var(--accent)' }}><GitCommitHorizontal size={11} />创建 Commit</button>
                    </div>
                    {commitResult ? <div className="mt-2 flex items-center gap-1 text-xs" style={{ color: 'var(--success)' }}><CheckCircle2 size={12} />{commitResult.commit.slice(0, 12)}</div> : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <div className="h-full overflow-y-auto p-3 scrollbar-hidden">
            {panelState.kind === 'not_repository' ? <GitBackedCheckpointUnavailable /> : <>
              <button type="button" data-testid="checkpoint-create-manual" onClick={() => void createManualCheckpoint()} disabled={!taskId || busy || !gitMutationsAvailable(panelState)} className="mb-3 inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs disabled:opacity-40" style={{ background: 'var(--accent-light)', color: 'var(--accent)' }}><Plus size={12} />创建检查点</button>
              <div className="space-y-2" data-testid="checkpoint-list">
              {checkpoints.map((checkpoint) => (
                <article key={checkpoint.id} data-testid="checkpoint-row" data-checkpoint-id={checkpoint.id} data-checkpoint-type={checkpoint.type} className="rounded-lg border p-3" style={{ borderColor: 'var(--border-secondary)', contentVisibility: 'auto', containIntrinsicSize: '0 84px' }}>
                  <div className="flex items-center gap-2">
                    <Check size={13} style={{ color: 'var(--success)' }} />
                    <span className="text-xs font-medium">{checkpointLabel(checkpoint.type)}</span>
                    <span className="ml-auto text-[10px]" style={{ color: 'var(--text-disabled)' }}>{relativeCheckpointTime(checkpoint.createdAt)}</span>
                  </div>
                  <div className="mt-1 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{checkpoint.files.length} files · {checkpoint.gitCommit?.slice(0, 10) ?? 'no HEAD'}</div>
                  <div className="mt-2 flex gap-2">
                    <button type="button" data-testid="checkpoint-restore-open" onClick={() => void beginRestore(checkpoint)} disabled={busy} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px]" style={{ background: 'var(--bg-hover)' }}><RotateCcw size={10} />恢复</button>
                    <button type="button" data-testid="checkpoint-preview-impact" onClick={() => void beginRestore(checkpoint)} disabled={busy} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px]" style={{ background: 'var(--bg-hover)' }}><Code2 size={10} />查看恢复影响</button>
                  </div>
                </article>
              ))}
              {!loading && checkpoints.length === 0 ? <div className="py-10 text-center text-sm" style={{ color: 'var(--text-disabled)' }}>当前任务还没有 Checkpoint</div> : null}
              </div>
            </>}
          </div>
        )}
      </div>

      {restorePreview ? <CheckpointRestoreDialog checkpoint={restorePreview.checkpoint} impact={restorePreview.impact} busy={busy} onCancel={() => setRestorePreview(null)} onConfirm={() => void confirmRestore()} /> : null}
      {confirmCommit && commitPreview ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center" style={{ background: 'var(--bg-overlay)' }} data-testid="commit-confirm-dialog">
          <div className="w-[420px] max-w-[calc(100vw-32px)] rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
            <h3 className="text-sm font-semibold">确认创建 Commit</h3>
            <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>只会提交该任务记录的 {commitPreview.fileCount} 个文件，不会自动推送。</p>
            <code className="mt-3 block rounded p-2 text-xs" style={{ background: 'var(--bg-hover)' }}>{commitPreview.subject}</code>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmCommit(false)} disabled={busy} className="rounded px-3 py-1.5 text-sm" style={{ background: 'var(--bg-hover)' }}>取消</button>
              <button type="button" data-testid="commit-confirm" onClick={() => void commit()} disabled={busy} className="inline-flex items-center gap-1 rounded px-3 py-1.5 text-sm text-white" style={{ background: 'var(--accent)' }}>{busy ? <LoaderCircle size={13} className="animate-spin" /> : <GitCommitHorizontal size={13} />}创建</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
