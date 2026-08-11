import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { normalizeForkMessageId, registerSessionIPC } from '../sessions';
import { publicIpcMainForTest } from './public-invoke-test-helper';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function createSessionHarness(
  project: Record<string, unknown> | null,
  options: { publicTransport?: boolean } = {},
) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  };
  const db = {
    getProject: vi.fn(() => project),
    createSession: vi.fn(),
  };
  registerSessionIPC(
    (options.publicTransport ? publicIpcMainForTest(ipcMain as never) : ipcMain) as never,
    db as never,
    { forkSession: vi.fn() } as never,
  );
  const create = (...args: unknown[]) => {
    const handler = handlers.get(IPC_CHANNELS.SESSION_CREATE);
    if (!handler) throw new Error('Missing Session create handler');
    return handler({}, ...args);
  };
  return { create, db };
}

describe('session create IPC', () => {
  it('rejects a forged project before generating or writing Session and Task rows', async () => {
    const test = createSessionHarness(null);

    await expect(test.create('forged-project')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      message: 'The selected project was not found.',
    });
    expect(test.db.getProject).toHaveBeenCalledWith('forged-project');
    expect(test.db.createSession).not.toHaveBeenCalled();
  });

  it('returns closed missing-project and invalid-request envelopes without writing', async () => {
    const missing = createSessionHarness(null, { publicTransport: true });
    const invalid = createSessionHarness({ id: 'project-a' }, { publicTransport: true });

    await expect(missing.create('forged-project')).resolves.toStrictEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: 'PROJECT_NOT_FOUND', message: 'The selected project was not found.' },
    });
    await expect(invalid.create('', { projectPath: 'C:\\private' })).resolves.toStrictEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: 'SESSION_CREATE_INVALID', message: 'Invalid Session create request.' },
    });
    expect(missing.db.createSession).not.toHaveBeenCalled();
    expect(invalid.db.createSession).not.toHaveBeenCalled();
  });

  it('creates a Session only for a main-process-confirmed project', async () => {
    const test = createSessionHarness({
      id: 'project-a',
      name: 'Project A',
      path: 'C:\\Projects\\A',
      created_at: '2026-08-09T12:00:00.000Z',
      last_opened_at: '2026-08-09T12:00:00.000Z',
    });

    const id = await test.create('project-a', {
      systemPrompt: 'Analyze this project structure without modifying files',
      model: 'model-a',
      permissionMode: 'plan',
    });

    expect(id).toEqual(expect.any(String));
    expect(test.db.createSession).toHaveBeenCalledWith(
      id,
      'project-a',
      'Analyze this project structure without m',
      'model-a',
      'plan',
    );
  });

  it.each([
    ['', undefined],
    [' '.repeat(3), undefined],
    ['p'.repeat(257), undefined],
    ['project-a', { projectPath: 'C:\\forged' }],
    ['project-a', { systemPrompt: 'x'.repeat(8_193) }],
    ['project-a', { model: 'x'.repeat(257) }],
    ['project-a', { permissionMode: 'bypass' }],
    ['project-a', {}, 'extra'],
  ])('rejects malformed Session create arguments %#', async (projectId, options, extra) => {
    const test = createSessionHarness({ id: 'project-a' });

    await expect(
      extra === undefined
        ? options === undefined ? test.create(projectId) : test.create(projectId, options)
        : test.create(projectId, options, extra),
    ).rejects.toThrow('Invalid Session create request.');
    expect(test.db.createSession).not.toHaveBeenCalled();
  });
});

describe('session fork IPC', () => {
  it('normalizes nested Workbench copy ids to the Claude transcript message id', () => {
    expect(normalizeForkMessageId('branch-a:branch-b:msg_123')).toBe('msg_123');
    expect(normalizeForkMessageId('msg_123')).toBe('msg_123');
    expect(normalizeForkMessageId()).toBeUndefined();
  });

  it('forks the underlying Claude history before creating a resumable Workbench branch', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const db = {
      getSession: vi.fn(() => ({
        id: 'workbench-source',
        project_id: 'project-a',
        claude_session_id: 'claude-source',
        title: 'Source',
        model: 'model-a',
        permission_mode: 'default',
      })),
      getProject: vi.fn(() => ({ id: 'project-a', path: 'C:\\Projects\\Alpha' })),
      listMessages: vi.fn(() => [{ id: 'msg_123' }]),
      createSession: vi.fn(),
      updateSessionMetadata: vi.fn(),
      copyMessages: vi.fn(),
    };
    const historyAdapter = {
      forkSession: vi.fn(async () => ({ sessionId: 'claude-branch' })),
    };
    registerSessionIPC(ipcMain as never, db as never, historyAdapter as never);

    const result = await handlers.get(IPC_CHANNELS.SESSION_FORK)?.(
      {},
      'workbench-source',
      { upToMessageId: 'workbench-branch:msg_123' },
    ) as { sessionId: string };

    expect(historyAdapter.forkSession).toHaveBeenCalledWith(
      'C:\\Projects\\Alpha',
      'claude-source',
      expect.objectContaining({ upToMessageId: 'msg_123' }),
    );
    expect(db.updateSessionMetadata).toHaveBeenCalledWith(
      result.sessionId,
      expect.objectContaining({ claudeSessionId: 'claude-branch' }),
    );
    expect(db.copyMessages).toHaveBeenCalledWith(
      'workbench-source',
      result.sessionId,
      'workbench-branch:msg_123',
    );
  });

  it('refuses to fake a continuable branch when messages have no Claude session id', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    };
    const db = {
      getSession: () => ({
        id: 'workbench-source',
        project_id: 'project-a',
        claude_session_id: null,
        title: 'Source',
        model: null,
        permission_mode: null,
      }),
      listMessages: () => [{ id: 'local-only-message' }],
      createSession: vi.fn(),
      updateSessionMetadata: vi.fn(),
      copyMessages: vi.fn(),
    };
    registerSessionIPC(
      ipcMain as never,
      db as never,
      { forkSession: vi.fn() } as never,
    );

    await expect(
      handlers.get(IPC_CHANNELS.SESSION_FORK)?.({}, 'workbench-source'),
    ).rejects.toThrow('不能伪造可继续的分支');
    expect(db.createSession).not.toHaveBeenCalled();
  });
});
