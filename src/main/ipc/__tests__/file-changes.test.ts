import path from 'node:path';
import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeRunOptions } from '../../../shared/types/claude';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { WorkingTreeError } from '../../file-changes/WorkingTreeService';
import { TaskManager } from '../../tasks/TaskManager';
import { registerFileChangesIPC } from '../file-changes';
import { publicIpcMainForTest } from './public-invoke-test-helper';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const PROJECT_PATH = path.resolve('fixtures', 'file-restore-project');

function harness(options: {
  includeTasks?: boolean;
  listChangesError?: unknown;
  mutationError?: Error;
  publicTransport?: boolean;
  tasksOverride?: { runProjectMutation: TaskManager['runProjectMutation'] };
} = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  } as unknown as IpcMain;
  const service = {
    listChanges: vi.fn(async () => {
      if (options.listChangesError !== undefined) throw options.listChangesError;
      return [];
    }),
    getDiff: vi.fn(async () => ({
      filePath: 'src/app.ts',
      oldContent: 'old',
      newContent: 'new',
      additions: 1,
      deletions: 1,
      isBinary: false,
      tooLarge: false,
      limit: null,
    })),
    prepareRestore: vi.fn(async () => ({
      projectPath: PROJECT_PATH,
      filePath: 'src/app.ts',
      paths: ['src/app.ts'],
      fingerprint: 'fingerprint-1',
    })),
    verifyRestoreFingerprint: vi.fn(async () => ({
      projectPath: PROJECT_PATH,
      filePath: 'src/app.ts',
      paths: ['src/app.ts'],
      fingerprint: 'fingerprint-1',
    })),
    restore: vi.fn(async () => undefined),
    resolveFileForOpen: vi.fn(async () => path.join(PROJECT_PATH, 'src', 'app.ts')),
  };
  const database = {
    listProjects: vi.fn(() => [{ id: 'project-1', path: PROJECT_PATH }]),
  };
  const tasks = {
    runProjectMutation: vi.fn(async <T>(
      _projectPath: string,
      operation: () => Promise<T>,
      mutationOptions?: { verify?: () => void | Promise<void> },
    ) => {
      if (options.mutationError) throw options.mutationError;
      await mutationOptions?.verify?.();
      return operation();
    }),
  };
  registerFileChangesIPC(options.publicTransport ? publicIpcMainForTest(ipcMain) : ipcMain, {
    service: service as never,
    database: database as never,
    ...(options.includeTasks === false
      ? {}
      : { tasks: (options.tasksOverride ?? tasks) as never }),
  });
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    return await handler({}, ...args) as T;
  };
  return { invoke, service, tasks };
}

describe('file changes mutation boundary', () => {
  it('returns a closed non-repository envelope through the production registrar', async () => {
    const test = harness({
      publicTransport: true,
      listChangesError: new WorkingTreeError(
        'private C:\\Users\\Profile project is not a Git working tree.',
        'NOT_A_REPOSITORY',
      ),
    });

    const result = await test.invoke(IPC_CHANNELS.FILE_CHANGES_LIST, PROJECT_PATH)
      .catch(() => ({ transportRejected: true }));
    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: 'NOT_A_REPOSITORY', message: 'Selected project is not a Git working tree.' },
    });
    expect(JSON.stringify(result)).not.toContain('Users');
  });

  it('fails closed when the legacy file restore has no project mutation coordinator', async () => {
    const test = harness({ includeTasks: false });

    await expect(test.invoke(
      IPC_CHANNELS.FILE_RESTORE,
      'src/app.ts',
      PROJECT_PATH,
    )).rejects.toThrow(/mutation coordinator/i);
    expect(test.service.restore).not.toHaveBeenCalled();
  });

  it('executes the Git restore only while the registered project mutation lease is held', async () => {
    const test = harness();

    await expect(test.invoke(
      IPC_CHANNELS.FILE_RESTORE,
      'src/app.ts',
      PROJECT_PATH,
    )).resolves.toBeUndefined();
    expect(test.tasks.runProjectMutation).toHaveBeenCalledWith(
      PROJECT_PATH,
      expect.any(Function),
      expect.objectContaining({
        kind: 'git_restore',
        filePaths: ['src/app.ts'],
        verify: expect.any(Function),
      }),
    );
    expect(test.service.restore).toHaveBeenCalledWith(
      PROJECT_PATH,
      'src/app.ts',
      'fingerprint-1',
    );
    expect(test.service.verifyRestoreFingerprint).toHaveBeenCalledBefore(
      test.service.restore,
    );
  });

  it('does not invoke Git restore when an active task owns the project mutation lease', async () => {
    const test = harness({ mutationError: new Error('TASK_PROJECT_BUSY') });

    await expect(test.invoke(
      IPC_CHANNELS.FILE_RESTORE,
      'src/app.ts',
      PROJECT_PATH,
    )).rejects.toThrow('TASK_PROJECT_BUSY');
    expect(test.service.restore).not.toHaveBeenCalled();
  });

  it('blocks the real legacy restore path while a writable Claude task owns the project', async () => {
    const adapter = {
      checkInstallation: vi.fn(async () => ({ installed: true, path: 'claude', version: 'test' })),
      runPrompt: vi.fn(async (options: ClaudeRunOptions) => ({ runId: options.runId, pid: 1 })),
      stopRun: vi.fn(async () => false),
      stopAll: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
    };
    const tasks = new TaskManager(adapter);
    await tasks.runPrompt({
      runId: 'active-run',
      projectKey: PROJECT_PATH,
      projectPath: PROJECT_PATH,
      sessionKey: `${PROJECT_PATH}::task-1`,
      prompt: 'modify files',
      permissionMode: 'default',
    });
    const test = harness({ tasksOverride: tasks });

    await expect(test.invoke(
      IPC_CHANNELS.FILE_RESTORE,
      'src/app.ts',
      PROJECT_PATH,
    )).rejects.toMatchObject({ code: 'TASK_PROJECT_BUSY' });
    expect(test.service.restore).not.toHaveBeenCalled();
  });
});
