import type { Checkpoint, RestoreImpact } from '../../../shared/types/checkpoint';
import type { GitChangeType, GitStatus, GitStatusFile } from '../../../shared/types/git';
import { canonicalProjectKey } from '../../../shared/sessionIdentity';

export type GitPanelState =
  | { kind: 'loading' }
  | { kind: 'not_repository' }
  | { kind: 'error'; message: string }
  | { kind: 'repository'; status: GitStatus; branchLabel: string };

export interface GitPanelStateInput {
  projectPath: string;
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  errorCode: string | null;
}

export interface GitStatusOutcome {
  status: GitStatus | null;
  error: string | null;
  errorCode: string | null;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function errorCode(reason: unknown, message: string): string | null {
  if (reason && typeof reason === 'object' && 'code' in reason) {
    const code = (reason as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return /NOT_A_REPOSITORY|not a Git (?:working tree|repository)/iu.test(message)
    ? 'NOT_A_REPOSITORY'
    : null;
}

export function gitStatusOutcome(result: PromiseSettledResult<GitStatus>): GitStatusOutcome {
  if (result.status === 'fulfilled') {
    return { status: result.value, error: null, errorCode: null };
  }
  const message = errorMessage(result.reason);
  return { status: null, error: message, errorCode: errorCode(result.reason, message) };
}

export function gitPanelState(input: GitPanelStateInput): GitPanelState {
  if (input.loading) return { kind: 'loading' };
  if (input.errorCode === 'NOT_A_REPOSITORY') return { kind: 'not_repository' };
  if (input.error) return { kind: 'error', message: input.error };
  if (!input.status
    || canonicalProjectKey(input.status.projectPath) !== canonicalProjectKey(input.projectPath)) {
    return { kind: 'loading' };
  }
  return {
    kind: 'repository',
    status: input.status,
    branchLabel: input.status.detached === true
      ? 'Detached HEAD'
      : input.status.branch ?? '尚无提交',
  };
}

export function gitMutationsAvailable(state: GitPanelState): boolean {
  return state.kind === 'repository';
}

export interface GitFileGroups {
  modified: GitStatusFile[];
  added: GitStatusFile[];
  deleted: GitStatusFile[];
  untracked: GitStatusFile[];
  other: GitStatusFile[];
}

export function groupGitFiles(files: readonly GitStatusFile[]): GitFileGroups {
  const groups: GitFileGroups = { modified: [], added: [], deleted: [], untracked: [], other: [] };
  for (const file of files) {
    if (file.changeType === 'modified') groups.modified.push(file);
    else if (file.changeType === 'added') groups.added.push(file);
    else if (file.changeType === 'deleted') groups.deleted.push(file);
    else if (file.changeType === 'untracked') groups.untracked.push(file);
    else groups.other.push(file);
  }
  return groups;
}

export function gitChangeCode(type: GitChangeType): string {
  if (type === 'added') return 'A';
  if (type === 'deleted') return 'D';
  if (type === 'untracked') return '?';
  if (type === 'renamed') return 'R';
  if (type === 'copied') return 'C';
  if (type === 'unmerged') return '!';
  return 'M';
}

export function checkpointLabel(type: Checkpoint['type']): string {
  if (type === 'before_plan') return '计划前';
  if (type === 'after_plan') return '计划完成';
  if (type === 'before_execute') return '执行前';
  if (type === 'after_execute') return '执行完成';
  if (type === 'before_review') return '审查前';
  if (type === 'before_fix') return '修复前';
  if (type === 'after_fix') return '修复完成';
  if (type === 'before_task') return '任务开始';
  if (type === 'after_edit') return '修改后';
  if (type === 'after_test') return '测试后';
  if (type === 'task_completed') return '任务完成';
  if (type === 'accepted') return '已接受修改';
  return '手动检查点';
}

export function findTaskBaseline(checkpoints: readonly Checkpoint[]): Checkpoint | null {
  return checkpoints.find((checkpoint) => checkpoint.type === 'before_task') ?? null;
}

export interface GitChangeOwnership {
  beforeTask: GitStatusFile[];
  taskChanges: GitStatusFile[];
  protectedUserChanges: GitStatusFile[];
}

export function classifyChangeOwnership(
  files: readonly GitStatusFile[],
  checkpoints: readonly Checkpoint[],
): GitChangeOwnership {
  const baseline = findTaskBaseline(checkpoints);
  if (!baseline) return { beforeTask: [], taskChanges: [], protectedUserChanges: [] };
  const runId = baseline.metadata.runId;
  const beforePaths = new Set(baseline.metadata.baselineFiles.map((file) => file.filePath));
  const touchedPaths = new Set(
    checkpoints
      .filter((checkpoint) => !runId || checkpoint.metadata.runId === runId)
      .flatMap((checkpoint) => checkpoint.metadata.touchedFiles),
  );
  const beforeTask = files.filter((file) => beforePaths.has(file.filePath));
  const taskChanges = files.filter((file) => touchedPaths.has(file.filePath));
  return {
    beforeTask,
    taskChanges,
    protectedUserChanges: beforeTask.filter((file) => !touchedPaths.has(file.filePath)),
  };
}

export function restoreImpactSummary(impact: RestoreImpact): string {
  return `将恢复 ${impact.restoreFiles.length} 个文件，删除 ${impact.deleteFiles.length} 个任务新增文件`;
}

export function canConfirmRestore(impact: RestoreImpact | null): boolean {
  return Boolean(impact && impact.blockedFiles.length === 0
    && (impact.restoreFiles.length > 0 || impact.deleteFiles.length > 0));
}

export function relativeCheckpointTime(createdAt: string, now = Date.now()): string {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return '时间未知';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} 小时前`;
  return new Date(timestamp).toLocaleDateString();
}
