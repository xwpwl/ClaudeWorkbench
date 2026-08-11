import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { ProjectSettings } from '../../shared/types/project';
import type { AppDatabase } from '../database/Database';
import {
  canonicalizeProjectPath,
  getProjectGitInfo,
  inspectProject,
  projectIdForPath,
} from '../projects/ProjectService';
import { ensureProjectSettings, projectSettingsView } from '../projects/ProjectSettingsService';
import type { PublicIpcRegistrar } from './public-invoke-boundary';
import { z } from 'zod';
import type { FirstRunService } from '../first-run/FirstRunService';
import { FirstRunProjectError } from '../first-run/FirstRunService';
import { assertTrustedMainFrame, type TrustedRendererIPCDependencies } from './trusted-frame';

interface ProjectIPCDependencies extends TrustedRendererIPCDependencies {
  firstRunService: Pick<FirstRunService, 'createTestProject'>;
}

function projectView(project: {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_opened_at: string;
}) {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    createdAt: project.created_at,
    lastOpenedAt: project.last_opened_at,
  };
}

function findProjectByCanonicalPath(database: AppDatabase, projectPath: string) {
  const canonical = canonicalizeProjectPath(projectPath).canonicalPath;
  return database.listProjects().find((project) => (
    canonicalizeProjectPath(project.path).canonicalPath === canonical
  )) ?? null;
}

function validatedSettingsPatch(
  patch: Partial<ProjectSettings>,
): Parameters<AppDatabase['setProjectSettings']>[1] {
  const result: Parameters<AppDatabase['setProjectSettings']>[1] = {};
  if (patch.displayName !== undefined) {
    const displayName = patch.displayName?.trim() || null;
    if (displayName && displayName.length > 120) throw new Error('项目名称过长');
    result.display_name = displayName;
  }
  if (patch.defaultModel !== undefined) {
    const model = patch.defaultModel?.trim() || null;
    if (model && model.length > 160) throw new Error('模型名称过长');
    result.default_model = model;
  }
  if (patch.defaultPermission !== undefined) {
    const permission = patch.defaultPermission?.trim() || null;
    if (permission && !['standard', 'accept-edits', 'plan', 'bypass'].includes(permission)) {
      throw new Error('项目默认权限无效');
    }
    result.default_permission = permission;
  }
  if (patch.agentMode !== undefined) {
    if (!['normal', 'plan', 'develop', 'review'].includes(patch.agentMode)) {
      throw new Error('Agent 模式无效');
    }
    result.agent_mode = patch.agentMode;
  }
  if (patch.favorite !== undefined) result.favorite = Boolean(patch.favorite);
  if (patch.disabledMcpServers !== undefined) {
    result.disabled_mcp_servers = [...new Set(
      patch.disabledMcpServers
        .map((name) => name.trim())
        .filter(Boolean)
        .slice(0, 200),
    )];
  }
  return result;
}

export function registerProjectIPC(
  ipcMain: PublicIpcRegistrar,
  database: AppDatabase,
  dependencies: ProjectIPCDependencies,
): void {
  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_DIRECTORY, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: '选择项目目录',
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_OPEN, (_event, selectedPath: string) => {
    const { displayPath } = canonicalizeProjectPath(selectedPath);
    const stats = fs.statSync(displayPath);
    if (!stats.isDirectory()) throw new Error('所选路径不是目录');
    const existing = findProjectByCanonicalPath(database, displayPath);
    if (existing) {
      database.updateProjectLastOpened(existing.id);
      return projectView(database.getProject(existing.id) ?? existing);
    }
    const id = projectIdForPath(displayPath);
    database.createProject(id, path.basename(displayPath), displayPath);
    return projectView(database.getProject(id)!);
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, () => database.listProjects().map(projectView));

  ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, (_event, projectId: string) => {
    database.deleteProject(projectId);
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_GET_GIT_INFO, (_event, projectPath: string) => (
    getProjectGitInfo(projectPath)
  ));

  ipcMain.handle(IPC_CHANNELS.PROJECT_GET_SETTINGS, (_event, projectId: string) => {
    if (!database.getProject(projectId)) throw new Error('项目索引不存在');
    return projectSettingsView(ensureProjectSettings(database, projectId));
  });

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SET_SETTINGS,
    (_event, projectId: string, patch: Partial<ProjectSettings>) => {
      if (!database.getProject(projectId)) throw new Error('项目索引不存在');
      return projectSettingsView(
        database.setProjectSettings(projectId, validatedSettingsPatch(patch)),
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.PROJECT_INSPECT, (_event, projectPath: string) => {
    const indexed = findProjectByCanonicalPath(database, projectPath);
    if (!indexed) throw new Error('项目索引不存在');
    return inspectProject(indexed.path);
  });

  ipcMain.handle(IPC_CHANNELS.FIRST_RUN_CREATE_TEST_PROJECT, async (event, ...args) => {
    assertTrustedMainFrame(event, dependencies);
    if (!z.tuple([]).safeParse(args).success) {
      throw new Error('Invalid first-run project request.');
    }
    try {
      return await dependencies.firstRunService.createTestProject();
    } catch (error) {
      if (error instanceof FirstRunProjectError) {
        throw new FirstRunProjectError(error.code);
      }
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_CREATE_FAILED');
    }
  });
}

export const projectIpcInternals = {
  findProjectByCanonicalPath,
  projectView,
  validatedSettingsPatch,
};
