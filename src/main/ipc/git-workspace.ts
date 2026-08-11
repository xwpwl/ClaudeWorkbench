import { z } from 'zod';
import type { CheckpointChangedEvent, CheckpointType } from '../../shared/types/checkpoint';
import type { DiffOptions } from '../../shared/types/git';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { AppDatabase } from '../database/Database';
import type { CheckpointManager } from '../checkpoints/CheckpointManager';
import { GitWorkspaceService } from '../git/GitWorkspaceService';
import { canonicalizeProjectPath } from '../projects/ProjectService';
import type { ProjectMutationOptions, TaskManager } from '../tasks/TaskManager';
import type { PublicIpcRegistrar } from './public-invoke-boundary';

const idInput = z.string().trim().min(1).max(512).refine((value) => !value.includes('\0'));
const pathInput = z.string().trim().min(1).max(32_768).refine((value) => !value.includes('\0'));
const commitSubjectInput = z.string().trim().min(1).max(200).refine(
  (value) => !value.includes('\0') && !/[\r\n]/u.test(value),
  'Commit subject must be a single safe line.',
);

export interface GitWorkspaceIPCDependencies {
  git?: GitWorkspaceService;
  tasks?: Pick<TaskManager, 'runProjectMutation'>;
  send?: (event: CheckpointChangedEvent) => void;
}

export function registerGitWorkspaceIPC(
  ipcMain: PublicIpcRegistrar,
  database: AppDatabase,
  checkpoints: CheckpointManager,
  dependencies: GitWorkspaceIPCDependencies = {},
): () => void {
  const git = dependencies.git ?? new GitWorkspaceService();
  const registeredProject = (projectId: string, claimedPath: string) => {
    const parsedId = idInput.parse(projectId);
    const parsedPath = pathInput.parse(claimedPath);
    const project = database.getProject(parsedId);
    if (!project) throw new Error('Project is not registered in Workbench.');
    const registered = canonicalizeProjectPath(project.path).canonicalPath;
    const claimed = canonicalizeProjectPath(parsedPath).canonicalPath;
    if (registered !== claimed) throw new Error('Project path does not match the registered project.');
    return project;
  };
  const runProjectMutation = <T>(
    projectPath: string,
    operation: () => Promise<T>,
    options?: ProjectMutationOptions,
  ): Promise<T> => {
    if (!dependencies.tasks) {
      throw new Error('Project mutation coordinator is unavailable.');
    }
    return dependencies.tasks.runProjectMutation(projectPath, operation, options);
  };

  ipcMain.handle(
    IPC_CHANNELS.GIT_WORKSPACE_STATUS,
    (_event, projectId: string, projectPath: string) => {
      const project = registeredProject(projectId, projectPath);
      return git.getStatus(project.path);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_WORKSPACE_INIT,
    (_event, projectId: string, projectPath: string) => {
      const project = registeredProject(projectId, projectPath);
      return runProjectMutation(project.path, () => git.initialize(project.path), {
        kind: 'git_init',
        projectId: project.id,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_WORKSPACE_DIFF,
    (_event, projectId: string, projectPath: string, options?: DiffOptions) => {
      const project = registeredProject(projectId, projectPath);
      return git.getDiff(project.path, options ?? {});
    },
  );

  ipcMain.handle(IPC_CHANNELS.CHECKPOINT_LIST, (_event, taskId: string) => (
    checkpoints.listCheckpoints(idInput.parse(taskId))
  ));

  ipcMain.handle(
    IPC_CHANNELS.CHECKPOINT_CREATE,
    (_event, taskId: string, type?: CheckpointType) => {
      if (type !== undefined && type !== 'manual') {
        throw new Error('Renderer may only create manual checkpoints.');
      }
      return checkpoints.createTaskCheckpoint(idInput.parse(taskId), 'manual', {
        reason: 'user_created',
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CHECKPOINT_RESTORE_PREVIEW,
    (_event, checkpointId: string) => checkpoints.previewRestore(idInput.parse(checkpointId)),
  );

  ipcMain.handle(
    IPC_CHANNELS.CHECKPOINT_RESTORE,
    async (_event, checkpointId: string, confirmationToken: string) => {
      const checkpoint = checkpoints.getCheckpoint(idInput.parse(checkpointId));
      if (!checkpoint) throw new Error('Checkpoint was not found.');
      const token = idInput.parse(confirmationToken);
      return runProjectMutation(checkpoint.projectPath, () => (
        checkpoints.restoreCheckpoint(checkpoint.id, token)
      ), {
        kind: 'checkpoint_restore',
        taskId: checkpoint.taskId,
        sessionId: checkpoint.taskId,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CHECKPOINT_ACCEPT,
    (_event, taskId: string) => checkpoints.acceptTaskChanges(idInput.parse(taskId)),
  );

  ipcMain.handle(
    IPC_CHANNELS.CHECKPOINT_COMMIT_PREVIEW,
    (_event, taskId: string) => checkpoints.createCommitPreview(idInput.parse(taskId)),
  );

  ipcMain.handle(
    IPC_CHANNELS.CHECKPOINT_COMMIT,
    async (_event, taskId: string, subject: string, confirmed: boolean) => {
      const parsedTaskId = idInput.parse(taskId);
      const task = database.getTask(parsedTaskId);
      const project = task ? database.getProject(task.project_id) : null;
      if (!project) throw new Error('Task project was not found.');
      if (confirmed !== true) throw new Error('Commit requires explicit confirmation.');
      const parsedSubject = commitSubjectInput.parse(subject);
      return runProjectMutation(project.path, () => (
        checkpoints.commitTaskChanges(parsedTaskId, parsedSubject, true)
      ), {
        kind: 'git_commit',
        projectId: project.id,
        taskId: parsedTaskId,
        sessionId: parsedTaskId,
      });
    },
  );

  return checkpoints.subscribe((event) => dependencies.send?.(event));
}
