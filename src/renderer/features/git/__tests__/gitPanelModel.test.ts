import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Checkpoint, RestoreImpact } from '../../../../shared/types/checkpoint';
import type { GitChangeType, GitStatus, GitStatusFile } from '../../../../shared/types/git';
import {
  canConfirmRestore,
  checkpointLabel,
  classifyChangeOwnership,
  findTaskBaseline,
  gitChangeCode,
  gitPanelState,
  gitMutationsAvailable,
  gitStatusOutcome,
  groupGitFiles,
  relativeCheckpointTime,
  restoreImpactSummary,
} from '../gitPanelModel';
import {
  CheckpointRestoreDialog,
  GitBackedCheckpointUnavailable,
  NonRepositoryGitCard,
  findGitActionBaseline,
  matchesCheckpointRestoreContext,
  matchesGitActionContext,
  type GitActionRequest,
} from '../WorkspaceRightDrawer';

function file(changeType: GitChangeType, filePath = `${changeType}.ts`): GitStatusFile {
  return {
    filePath,
    changeType,
    statusCode: changeType === 'untracked' ? '??' : ' M',
    staged: false,
    unstaged: true,
    untracked: changeType === 'untracked',
    additions: 1,
    deletions: 0,
    statsAvailable: true,
    isBinary: false,
  };
}

function gitStatus(patch: Partial<GitStatus> = {}): GitStatus {
  return {
    projectPath: 'C:\\Project',
    branch: 'main',
    detached: false,
    head: 'abc1234',
    upstream: null,
    ahead: 0,
    behind: 0,
    clean: true,
    files: [],
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    additions: 0,
    deletions: 0,
    ...patch,
  };
}

function checkpoint(type: Checkpoint['type'], id = type): Checkpoint {
  return {
    id,
    taskId: 'task-a',
    projectPath: 'C:\\Project',
    type,
    createdAt: '2026-08-01T00:00:00.000Z',
    gitCommit: 'abc1234',
    metadata: { branch: 'main', baselineFiles: [], touchedFiles: [] },
    files: [],
  };
}

function impact(patch: Partial<RestoreImpact> = {}): RestoreImpact {
  return {
    checkpointId: 'checkpoint-a',
    taskId: 'task-a',
    restoreFiles: ['src/App.tsx'],
    deleteFiles: [],
    preservedUserFiles: [],
    blockedFiles: [],
    confirmationToken: 'token-a',
    expiresAt: '2026-08-01T00:05:00.000Z',
    ...patch,
  };
}

function actionRequest(patch: Partial<GitActionRequest> = {}): GitActionRequest {
  return {
    id: 1,
    kind: 'restore',
    projectId: 'project-a',
    projectPath: 'C:\\Project-A',
    taskId: 'task-a',
    ...patch,
  };
}

describe('Git panel model', () => {
  describe('mutually exclusive repository states', () => {
    const detachedStatus = gitStatus({ branch: null, detached: true });

    it('renders loading without reusing a detached status', () => {
      expect(gitPanelState({
        projectPath: 'C:\\Project',
        status: detachedStatus,
        loading: true,
        error: null,
        errorCode: null,
      })).toEqual({ kind: 'loading' });
    });

    it('renders a non-repository state without reusing a detached status', () => {
      expect(gitPanelState({
        projectPath: 'C:\\Project',
        status: detachedStatus,
        loading: false,
        error: 'Selected project is not a Git working tree.',
        errorCode: 'NOT_A_REPOSITORY',
      })).toEqual({ kind: 'not_repository' });
    });

    it('renders a generic error without reusing a detached status', () => {
      expect(gitPanelState({
        projectPath: 'C:\\Project',
        status: detachedStatus,
        loading: false,
        error: 'Git is unavailable',
        errorCode: 'INVALID_GIT_OUTPUT',
      })).toEqual({ kind: 'error', message: 'Git is unavailable' });
    });

    it('does not display status retained from the previously selected project', () => {
      expect(gitPanelState({
        projectPath: 'C:\\Project-B',
        status: gitStatus({ projectPath: 'C:\\Project-A', branch: 'feature-a' }),
        loading: false,
        error: null,
        errorCode: null,
      })).toEqual({ kind: 'loading' });
    });

    it('accepts the current status when only path case, separators, or trailing separators differ', () => {
      expect(gitPanelState({
        projectPath: 'C:\\WORK\\Project\\',
        status: gitStatus({ projectPath: 'c:/work/project' }),
        loading: false,
        error: null,
        errorCode: null,
      })).toMatchObject({ kind: 'repository', branchLabel: 'main' });
    });

    it('labels Detached HEAD only when a current repository status is explicitly detached', () => {
      expect(gitPanelState({
        projectPath: 'C:\\Project',
        status: detachedStatus,
        loading: false,
        error: null,
        errorCode: null,
      })).toMatchObject({ kind: 'repository', branchLabel: 'Detached HEAD' });
    });

    it('does not invent Detached HEAD for a repository without an initial commit', () => {
      expect(gitPanelState({
        projectPath: 'C:\\Project',
        status: gitStatus({ branch: null, detached: false, head: null }),
        loading: false,
        error: null,
        errorCode: null,
      })).toMatchObject({ kind: 'repository', branchLabel: '尚无提交' });
    });

    it('clears status and recognizes the serialized non-repository failure', () => {
      expect(gitStatusOutcome({
        status: 'rejected',
        reason: new Error(
          "Error invoking remote method 'git:workspace:status': Selected project is not a Git working tree.",
        ),
      })).toEqual({
        status: null,
        error: "Error invoking remote method 'git:workspace:status': Selected project is not a Git working tree.",
        errorCode: 'NOT_A_REPOSITORY',
      });
    });

    it('allows Git mutations only for a confirmed current repository', () => {
      expect(gitMutationsAvailable({ kind: 'not_repository' })).toBe(false);
      expect(gitMutationsAvailable({ kind: 'loading' })).toBe(false);
      expect(gitMutationsAvailable({ kind: 'error', message: 'offline' })).toBe(false);
      expect(gitMutationsAvailable({
        kind: 'repository',
        status: gitStatus(),
        branchLabel: 'main',
      })).toBe(true);
    });
  });

  describe('non-repository actions', () => {
    it('offers only initialization, Explorer, and close actions with Git-backed checkpoint guidance', () => {
      const html = renderToStaticMarkup(React.createElement(NonRepositoryGitCard, {
        busy: false,
        error: null,
        onInitialize: () => undefined,
        onOpenExplorer: () => undefined,
        onClose: () => undefined,
      }));

      expect(html).toContain('data-testid="git-initialize"');
      expect(html).toContain('初始化 Git');
      expect(html).toContain('在资源管理器中打开');
      expect(html).toContain('关闭面板');
      expect(html).toContain('Checkpoint 由 Git 支持，初始化前不可用');
      expect(html).not.toContain('checkpoint-accept');
      expect(html).not.toContain('commit-preview-create');
    });

    it('disables initialization while busy and keeps an initialization error visible', () => {
      const html = renderToStaticMarkup(React.createElement(NonRepositoryGitCard, {
        busy: true,
        error: 'Git executable is unavailable',
        onInitialize: () => undefined,
        onOpenExplorer: () => undefined,
        onClose: () => undefined,
      }));

      expect(html).toContain('data-testid="git-initialize"');
      expect(html).toContain('disabled=""');
      expect(html).toContain('Git executable is unavailable');
    });

    it('describes the checkpoint tab as unavailable instead of offering file checkpoints', () => {
      const html = renderToStaticMarkup(React.createElement(GitBackedCheckpointUnavailable));

      expect(html).toContain('Checkpoint 由 Git 支持');
      expect(html).toContain('初始化 Git 后可用');
      expect(html).not.toContain('checkpoint-create-manual');
    });
  });

  describe('bound Git action requests', () => {
    it.each(['accept', 'restore', 'diff'] as const)(
      'matches the exact initiating context for %s',
      (kind) => {
        expect(matchesGitActionContext(
          actionRequest({ kind }),
          { id: 'project-a', path: 'C:\\Project-A' },
          'task-a',
        )).toBe(true);
      },
    );

    it('drops a task A request after the active task switches to B', () => {
      const requestFromA = actionRequest();

      expect(matchesGitActionContext(
        requestFromA,
        { id: 'project-a', path: 'C:\\Project-A' },
        'task-b',
      )).toBe(false);
      expect(requestFromA.taskId).toBe('task-a');
    });

    it('drops a project A request after the active project switches to B', () => {
      expect(matchesGitActionContext(
        actionRequest(),
        { id: 'project-b', path: 'C:\\Project-B' },
        'task-b',
      )).toBe(false);
    });

    it('drops a request when the project id matches but its path changed', () => {
      expect(matchesGitActionContext(
        actionRequest(),
        { id: 'project-a', path: 'C:\\Moved-Project-A' },
        'task-a',
      )).toBe(false);
    });

    it('drops a request when no project is active', () => {
      expect(matchesGitActionContext(actionRequest(), null, 'task-a')).toBe(false);
    });

    it('drops a request when no workbench task is active', () => {
      expect(matchesGitActionContext(
        actionRequest(),
        { id: 'project-a', path: 'C:\\Project-A' },
        undefined,
      )).toBe(false);
    });

    it('keeps the initiating context snapshot stable across an A to B switch', () => {
      const initiating = { projectId: 'project-a', projectPath: 'C:\\Project-A', taskId: 'task-a' };
      const requestFromA = actionRequest(initiating);
      const current = { projectId: 'project-b', projectPath: 'C:\\Project-B', taskId: 'task-b' };

      expect(requestFromA).toMatchObject(initiating);
      expect(requestFromA).not.toMatchObject(current);
      expect(matchesGitActionContext(
        requestFromA,
        { id: current.projectId, path: current.projectPath },
        current.taskId,
      )).toBe(false);
    });

    it('restore-latest selects a before_task checkpoint only from the bound task', () => {
      const baselineA = checkpoint('before_task', 'baseline-a');
      const baselineB = checkpoint('before_task', 'baseline-b');
      baselineB.taskId = 'task-b';

      expect(findGitActionBaseline([baselineB, baselineA], actionRequest())?.id).toBe('baseline-a');
    });

    it('restore-latest returns null when only another task has a baseline', () => {
      const baselineB = checkpoint('before_task', 'baseline-b');
      baselineB.taskId = 'task-b';

      expect(findGitActionBaseline([baselineB, checkpoint('manual')], actionRequest())).toBeNull();
    });

    it('restore-latest uses the newest bound baseline from a descending response', () => {
      const newestA = checkpoint('before_task', 'newest-a');
      const olderA = checkpoint('before_task', 'older-a');
      const newestB = checkpoint('before_task', 'newest-b');
      newestB.taskId = 'task-b';

      expect(findGitActionBaseline([newestB, newestA, olderA], actionRequest())?.id).toBe('newest-a');
    });
  });

  describe('checkpoint restore target integrity', () => {
    it('accepts only a preview bound to the selected checkpoint and active context', () => {
      const selected = checkpoint('after_test', 'checkpoint-a');

      expect(matchesCheckpointRestoreContext(
        selected,
        impact(),
        { path: 'C:\\Project' },
        'task-a',
      )).toBe(true);
    });

    it.each([
      ['another checkpoint', impact({ checkpointId: 'checkpoint-b' }), { path: 'C:\\Project' }, 'task-a'],
      ['another task in the preview', impact({ taskId: 'task-b' }), { path: 'C:\\Project' }, 'task-a'],
      ['another active task', impact(), { path: 'C:\\Project' }, 'task-b'],
      ['another active project', impact(), { path: 'C:\\Other' }, 'task-a'],
    ] as const)('rejects a preview for %s', (_label, preview, project, activeTaskId) => {
      expect(matchesCheckpointRestoreContext(
        checkpoint('after_test', 'checkpoint-a'),
        preview,
        project,
        activeTaskId,
      )).toBe(false);
    });

    it('renders the exact selected checkpoint and the actual restore impact', () => {
      const selected = checkpoint('after_test', 'checkpoint-a');
      const preview = impact({ deleteFiles: ['src/generated.ts'] });
      const html = renderToStaticMarkup(React.createElement(CheckpointRestoreDialog, {
        checkpoint: selected,
        impact: preview,
        busy: false,
        onCancel: () => undefined,
        onConfirm: () => undefined,
      }));

      expect(html).toContain('恢复到「测试后」Checkpoint');
      expect(html).toContain('目标：checkpoint-a');
      expect(html).toContain('恢复  src/App.tsx');
      expect(html).toContain('删除  src/generated.ts');
      expect(html).toContain('恢复到此 Checkpoint');
      expect(html).not.toContain('恢复任务前状态');
    });
  });

  it.each([
    ['modified', 'modified'],
    ['added', 'added'],
    ['deleted', 'deleted'],
    ['untracked', 'untracked'],
  ] as const)('groups %s files', (type, group) => {
    const groups = groupGitFiles([file(type)]);
    expect(groups[group]).toHaveLength(1);
  });

  it.each(['renamed', 'copied', 'unmerged'] as const)('groups %s as other', (type) => {
    expect(groupGitFiles([file(type)]).other).toHaveLength(1);
  });

  it('does not mutate the source file array while grouping', () => {
    const files = [file('added'), file('modified')];
    groupGitFiles(files);
    expect(files.map((item) => item.changeType)).toEqual(['added', 'modified']);
  });

  it.each([
    ['modified', 'M'],
    ['added', 'A'],
    ['deleted', 'D'],
    ['untracked', '?'],
    ['renamed', 'R'],
    ['copied', 'C'],
    ['unmerged', '!'],
  ] as const)('maps %s to its compact Git code', (type, code) => {
    expect(gitChangeCode(type)).toBe(code);
  });

  it.each([
    ['before_task', '任务开始'],
    ['after_edit', '修改后'],
    ['after_test', '测试后'],
    ['task_completed', '任务完成'],
    ['accepted', '已接受修改'],
    ['manual', '手动检查点'],
  ] as const)('labels %s checkpoints', (type, label) => {
    expect(checkpointLabel(type)).toBe(label);
  });

  it('finds the first task baseline in a descending checkpoint list', () => {
    expect(findTaskBaseline([checkpoint('task_completed'), checkpoint('before_task', 'baseline')])?.id)
      .toBe('baseline');
  });

  it('returns null when a task baseline is absent', () => {
    expect(findTaskBaseline([checkpoint('manual')])).toBeNull();
  });

  it('distinguishes task changes from pre-task user changes for the same run', () => {
    const baseline = checkpoint('before_task');
    baseline.metadata = {
      runId: 'run-a',
      branch: 'main',
      baselineFiles: [file('modified', 'user.ts'), file('modified', 'shared.ts')],
      touchedFiles: [],
    };
    const completed = checkpoint('task_completed');
    completed.metadata = {
      runId: 'run-a',
      branch: 'main',
      baselineFiles: [],
      touchedFiles: ['shared.ts', 'task.ts'],
    };
    const ownership = classifyChangeOwnership(
      [file('modified', 'user.ts'), file('modified', 'shared.ts'), file('added', 'task.ts')],
      [completed, baseline],
    );
    expect(ownership.beforeTask.map((item) => item.filePath)).toEqual(['user.ts', 'shared.ts']);
    expect(ownership.taskChanges.map((item) => item.filePath)).toEqual(['shared.ts', 'task.ts']);
    expect(ownership.protectedUserChanges.map((item) => item.filePath)).toEqual(['user.ts']);
  });

  it('does not mix touched files from an older run into current ownership', () => {
    const baseline = checkpoint('before_task');
    baseline.metadata = { runId: 'run-new', branch: 'main', baselineFiles: [], touchedFiles: [] };
    const old = checkpoint('task_completed');
    old.metadata = { runId: 'run-old', branch: 'main', baselineFiles: [], touchedFiles: ['old.ts'] };
    expect(classifyChangeOwnership([file('modified', 'old.ts')], [old, baseline]).taskChanges)
      .toEqual([]);
  });

  it('returns empty ownership groups before a task baseline exists', () => {
    expect(classifyChangeOwnership([file('modified')], [checkpoint('manual')])).toEqual({
      beforeTask: [],
      taskChanges: [],
      protectedUserChanges: [],
    });
  });

  it('summarizes restore and delete counts', () => {
    expect(restoreImpactSummary(impact({ deleteFiles: ['new-a.ts', 'new-b.ts'] })))
      .toBe('将恢复 1 个文件，删除 2 个任务新增文件');
  });

  it('allows a non-empty unblocked restore', () => {
    expect(canConfirmRestore(impact())).toBe(true);
  });

  it('allows a delete-only restore', () => {
    expect(canConfirmRestore(impact({ restoreFiles: [], deleteFiles: ['new.ts'] }))).toBe(true);
  });

  it('blocks confirmation when the impact has unsafe files', () => {
    expect(canConfirmRestore(impact({ blockedFiles: [{ filePath: 'a.ts', reason: 'staged' }] })))
      .toBe(false);
  });

  it('blocks confirmation for an empty impact', () => {
    expect(canConfirmRestore(impact({ restoreFiles: [], deleteFiles: [] }))).toBe(false);
  });

  it('blocks confirmation before an impact preview exists', () => {
    expect(canConfirmRestore(null)).toBe(false);
  });

  it.each([
    [30_000, '刚刚'],
    [2 * 60_000, '2 分钟前'],
    [3 * 60 * 60_000, '3 小时前'],
  ] as const)('formats a checkpoint age of %i ms', (elapsed, expected) => {
    const now = Date.parse('2026-08-01T12:00:00.000Z');
    expect(relativeCheckpointTime(new Date(now - elapsed).toISOString(), now)).toBe(expected);
  });

  it('labels an invalid checkpoint timestamp instead of throwing', () => {
    expect(relativeCheckpointTime('invalid')).toBe('时间未知');
  });
});
