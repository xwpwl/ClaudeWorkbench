import fs from 'node:fs/promises';
import { BrowserWindow, dialog } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { PageRequest } from '../../shared/types/workbench';
import type { AppDatabase } from '../database/Database';
import type { TaskManager } from '../tasks/TaskManager';
import { TaskQueryService } from '../tasks/TaskQueryService';
import type { PublicIpcRegistrar } from './public-invoke-boundary';

export function registerTaskIPC(
  ipcMain: PublicIpcRegistrar,
  database: AppDatabase,
  taskManager: TaskManager,
): void {
  const tasks = new TaskQueryService(database);

  ipcMain.handle(
    IPC_CHANNELS.TASK_GET_SNAPSHOT,
    (_event, sessionId: string, page?: PageRequest) => tasks.getSnapshot(sessionId, page),
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_LIST_EVENTS,
    (_event, sessionId: string, page?: PageRequest) => tasks.listEvents(sessionId, page),
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_GET_REPORT,
    (_event, sessionId: string) => tasks.buildReport(sessionId),
  );

  ipcMain.handle(IPC_CHANNELS.TASK_EXPORT_REPORT, async (_event, sessionId: string) => {
    const report = tasks.buildReport(sessionId);
    if (!report) return null;
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = owner
      ? await dialog.showSaveDialog(owner, {
        title: '导出任务报告',
        defaultPath: report.fileName,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      : await dialog.showSaveDialog({
        title: '导出任务报告',
        defaultPath: report.fileName,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, report.markdown, 'utf8');
    return result.filePath;
  });

  ipcMain.handle(IPC_CHANNELS.TASK_LIST_ACTIVE, () => taskManager.getActiveTasks());
}
