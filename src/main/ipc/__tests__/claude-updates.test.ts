import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import type { ClaudeCodeUpdateSnapshot } from '../../../shared/types/ipc';
import { registerClaudeUpdatesIPC } from '../claude-updates';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const RENDERER_URL = 'file:///C:/ClaudeWorkbench/dist/renderer/index.html';

const IDLE: ClaudeCodeUpdateSnapshot = Object.freeze({
  status: 'idle',
  reason: null,
  beforeVersion: null,
  afterVersion: null,
});

const UPDATED: ClaudeCodeUpdateSnapshot = Object.freeze({
  status: 'updated',
  reason: null,
  beforeVersion: '1.0.0',
  afterVersion: '1.1.0',
});

function ipcHarness(options: { trusted?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  } as unknown as IpcMain;
  const mainFrame = { url: RENDERER_URL };
  const trustedWebContents = {
    id: 42,
    mainFrame,
    getURL: vi.fn(() => RENDERER_URL),
    isDestroyed: vi.fn(() => false),
  } as unknown as WebContents;
  const exposedIdle = {
    ...IDLE,
    executable: 'C:\\private\\claude.exe',
    args: ['update'],
    env: { TOKEN: 'secret' },
    url: 'https://evil.invalid/update',
  };
  const exposedUpdated = {
    ...UPDATED,
    executable: 'C:\\private\\claude.exe',
    stdout: 'private output',
    packageManager: 'private manager',
  };
  const updates = {
    getSnapshot: vi.fn(() => exposedIdle),
    updateNow: vi.fn(async () => exposedUpdated),
  };
  const dependencies = {
    updates,
    getTrustedWebContents: () => options.trusted === false ? null : trustedWebContents,
    getTrustedFrameUrl: () => RENDERER_URL,
  };
  const dispose = registerClaudeUpdatesIPC(ipcMain as never, dependencies);
  const event = { sender: trustedWebContents, senderFrame: mainFrame } as IpcMainInvokeEvent;
  const invokeFrom = (
    invokeEvent: IpcMainInvokeEvent,
    channel: string,
    ...args: unknown[]
  ) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    return handler(invokeEvent, ...args);
  };
  const invoke = (channel: string, ...args: unknown[]) => invokeFrom(event, channel, ...args);

  return {
    dependencies,
    dispose,
    event,
    handlers,
    invoke,
    invokeFrom,
    ipcMain,
    mainFrame,
    trustedWebContents,
    updates,
  };
}

describe('Claude update IPC', () => {
  it('authenticates before parsing or manager access', async () => {
    const test = ipcHarness({ trusted: false });

    await expect(test.invoke(
      IPC_CHANNELS.CLAUDE_CODE_UPDATE_NOW,
      { executable: 'evil', args: ['update'], env: { TOKEN: 'secret' } },
    )).rejects.toThrow(/trusted main frame/iu);
    expect(test.updates.getSnapshot).not.toHaveBeenCalled();
    expect(test.updates.updateNow).not.toHaveBeenCalled();
  });

  it('maps one zero-argument state request to a bounded snapshot', async () => {
    const test = ipcHarness();

    const result = await test.invoke(IPC_CHANNELS.CLAUDE_CODE_UPDATE_GET_STATE);

    expect(result).toStrictEqual(IDLE);
    expect(Reflect.ownKeys(result as object)).toStrictEqual([
      'status',
      'reason',
      'beforeVersion',
      'afterVersion',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(test.updates.getSnapshot).toHaveBeenCalledOnce();
    expect(test.updates.updateNow).not.toHaveBeenCalled();
  });

  it('maps one zero-argument update request to a bounded snapshot', async () => {
    const test = ipcHarness();

    const result = await test.invoke(IPC_CHANNELS.CLAUDE_CODE_UPDATE_NOW);

    expect(result).toStrictEqual(UPDATED);
    expect(Reflect.ownKeys(result as object)).toStrictEqual([
      'status',
      'reason',
      'beforeVersion',
      'afterVersion',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(test.updates.updateNow).toHaveBeenCalledOnce();
    expect(test.updates.getSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['subframe', (test: ReturnType<typeof ipcHarness>) => ({
      sender: test.trustedWebContents,
      senderFrame: { url: RENDERER_URL },
    })],
    ['foreign', (test: ReturnType<typeof ipcHarness>) => ({
      sender: { ...test.trustedWebContents, id: 99 },
      senderFrame: test.mainFrame,
    })],
    ['destroyed', (test: ReturnType<typeof ipcHarness>) => {
      vi.mocked(test.trustedWebContents.isDestroyed).mockReturnValue(true);
      return test.event;
    }],
  ] as const)(
    'rejects a %s sender before accessing either manager method',
    async (_kind, makeEvent) => {
      for (const channel of [
        IPC_CHANNELS.CLAUDE_CODE_UPDATE_GET_STATE,
        IPC_CHANNELS.CLAUDE_CODE_UPDATE_NOW,
      ] as const) {
        const test = ipcHarness();
        const event = makeEvent(test) as IpcMainInvokeEvent;

        await expect(test.invokeFrom(event, channel, { path: 'C:\\private\\claude.exe' }))
          .rejects.toThrow(/trusted main frame/iu);
        expect(test.updates.getSnapshot).not.toHaveBeenCalled();
        expect(test.updates.updateNow).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [undefined],
    [null],
    [false],
    [0],
    [''],
    [{ executable: 'claude', args: ['update'], env: { TOKEN: 'secret' } }],
    [{ path: 'C:\\private\\claude.exe' }],
    [{ version: '9.9.9', url: 'https://evil.invalid' }],
    [[]],
    ['first', 'second'],
  ])('rejects every extra or forged argument tuple %#', async (...args) => {
    for (const channel of [
      IPC_CHANNELS.CLAUDE_CODE_UPDATE_GET_STATE,
      IPC_CHANNELS.CLAUDE_CODE_UPDATE_NOW,
    ] as const) {
      const test = ipcHarness();

      await expect(test.invoke(channel, ...args)).rejects.toThrow('Invalid Claude update request.');
      expect(test.updates.getSnapshot).not.toHaveBeenCalled();
      expect(test.updates.updateNow).not.toHaveBeenCalled();
    }
  });

  it('registers and disposes exactly the two Claude update handlers', () => {
    const test = ipcHarness();

    expect([...test.handlers.keys()]).toStrictEqual([
      'claude-code-update:get-state',
      'claude-code-update:update-now',
    ]);

    test.dispose();

    expect(test.handlers.size).toBe(0);
    expect(test.ipcMain.removeHandler).toHaveBeenCalledTimes(2);
    expect(test.ipcMain.removeHandler).toHaveBeenNthCalledWith(
      1,
      IPC_CHANNELS.CLAUDE_CODE_UPDATE_GET_STATE,
    );
    expect(test.ipcMain.removeHandler).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.CLAUDE_CODE_UPDATE_NOW,
    );
  });
});
