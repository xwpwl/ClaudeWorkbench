import { shell } from 'electron';
import { z } from 'zod';
import type { DiffResult, FileChange } from '../../shared/types/fileChanges';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { WorkingTreeService } from '../file-changes/WorkingTreeService';
import type { AppDatabase } from '../database/Database';
import { canonicalizeProjectPath } from '../projects/ProjectService';
import type { TaskManager } from '../tasks/TaskManager';
import type { PublicIpcRegistrar } from './public-invoke-boundary';

const pathInput = z.string()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes('\0'), 'Path contains an invalid null byte.');

export interface FileChangesIPCDependencies {
  service?: WorkingTreeService;
  openPath?: (absolutePath: string) => Promise<string>;
  database?: Pick<AppDatabase, 'listProjects'>;
  tasks?: Pick<TaskManager, 'runProjectMutation'>;
}

/** Thin, validated IPC boundary around the safe working-tree service. */
export function registerFileChangesIPC(
  ipcMain: PublicIpcRegistrar,
  dependencies: FileChangesIPCDependencies = {},
): void {
  const service = dependencies.service ?? new WorkingTreeService();
  const openPath = dependencies.openPath ?? ((absolutePath: string) => shell.openPath(absolutePath));
  const registeredProjectPath = (claimedPath: string): string => {
    const parsed = pathInput.parse(claimedPath);
    if (!dependencies.database) return parsed;
    const canonical = canonicalizeProjectPath(parsed).canonicalPath;
    const project = dependencies.database.listProjects().find((candidate) => (
      canonicalizeProjectPath(candidate.path).canonicalPath === canonical
    ));
    if (!project) throw new Error('Project is not registered in Workbench.');
    return project.path;
  };

  ipcMain.handle(
    IPC_CHANNELS.FILE_CHANGES_LIST,
    async (_event, projectPath: string): Promise<FileChange[]> => {
      return service.listChanges(registeredProjectPath(projectPath));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_DIFF,
    async (_event, filePath: string, projectPath: string): Promise<DiffResult> => {
      return service.getDiff(registeredProjectPath(projectPath), pathInput.parse(filePath));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_RESTORE,
    async (_event, filePath: string, projectPath: string): Promise<void> => {
      if (!dependencies.tasks) {
        throw new Error('Project mutation coordinator is unavailable.');
      }
      const registeredPath = registeredProjectPath(projectPath);
      const parsedFilePath = pathInput.parse(filePath);
      const preparation = await service.prepareRestore(registeredPath, parsedFilePath);
      await dependencies.tasks.runProjectMutation(registeredPath, () => (
        service.restore(registeredPath, parsedFilePath, preparation.fingerprint)
      ), {
        kind: 'git_restore',
        filePaths: preparation.paths,
        verify: () => service.verifyRestoreFingerprint(
          registeredPath,
          parsedFilePath,
          preparation.fingerprint,
        ).then(() => undefined),
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_OPEN_IN_VSCODE,
    async (_event, filePath: string, projectPath: string): Promise<void> => {
      const absolutePath = await service.resolveFileForOpen(
        registeredProjectPath(projectPath),
        pathInput.parse(filePath),
      );
      const error = await openPath(absolutePath);
      if (error) throw new Error(`Unable to open file: ${error}`);
    },
  );
}
