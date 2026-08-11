import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { registerProjectIPC } from '../projects';

const electronMocks = vi.hoisted(() => ({
  getFocusedWindow: vi.fn(() => null),
  getAllWindows: vi.fn(() => []),
  showOpenDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: electronMocks.getFocusedWindow,
    getAllWindows: electronMocks.getAllWindows,
  },
  dialog: { showOpenDialog: electronMocks.showOpenDialog },
}));

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const RENDERER_URL = 'file:///C:/ClaudeWorkbench/dist/renderer/index.html';
const PUBLIC_PROJECT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Claude Workbench Test Project',
  path: 'C:\\private-data\\first-run-projects\\11111111-1111-4111-8111-111111111111',
  createdAt: '2026-08-09T12:00:00.000Z',
  lastOpenedAt: '2026-08-09T12:00:00.000Z',
};

function harness() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  } as unknown as IpcMain;
  const database = {
    listProjects: vi.fn(() => []),
  };
  const firstRunService = {
    createTestProject: vi.fn(async () => PUBLIC_PROJECT),
  };
  const mainFrame = { url: RENDERER_URL };
  const trustedWebContents = {
    id: 42,
    mainFrame,
    getURL: vi.fn(() => RENDERER_URL),
    isDestroyed: vi.fn(() => false),
  } as unknown as WebContents;
  registerProjectIPC(ipcMain, database as never, {
    firstRunService,
    getTrustedWebContents: () => trustedWebContents,
    getTrustedFrameUrl: () => RENDERER_URL,
  });
  const event = { sender: trustedWebContents, senderFrame: mainFrame } as IpcMainInvokeEvent;
  const invoke = (invokeEvent: IpcMainInvokeEvent = event, ...args: unknown[]) => {
    const handler = handlers.get(IPC_CHANNELS.FIRST_RUN_CREATE_TEST_PROJECT);
    if (!handler) throw new Error('Missing first-run project handler.');
    return handler(invokeEvent, ...args);
  };
  return { database, firstRunService, invoke, mainFrame, trustedWebContents };
}

describe('first-run project IPC', () => {
  it('creates through the named zero-argument channel and returns only the public Project view', async () => {
    const test = harness();
    await expect(test.invoke()).resolves.toEqual(PUBLIC_PROJECT);
    expect(test.firstRunService.createTestProject).toHaveBeenCalledOnce();
    expect(JSON.stringify(await test.invoke())).not.toMatch(
      /mutation|fingerprint|ownership|rollback|device|inode/iu,
    );
  });

  it.each([
    ['C:\\renderer-controlled'],
    [{ path: 'C:\\renderer-controlled', content: 'forged' }],
    ['package.json', 'forged'],
  ])('rejects extra renderer arguments before service dispatch %#', async (...args) => {
    const test = harness();
    await expect(test.invoke(undefined, ...args)).rejects.toThrow(
      'Invalid first-run project request.',
    );
    expect(test.firstRunService.createTestProject).not.toHaveBeenCalled();
  });

  it.each(['foreign', 'iframe', 'url-drift', 'stable-url-drift'])(
    'rejects an untrusted %s invocation before service dispatch',
    async (kind) => {
      const test = harness();
      let event = {
        sender: test.trustedWebContents,
        senderFrame: test.mainFrame,
      } as unknown as IpcMainInvokeEvent;
      if (kind === 'foreign') {
        event = { sender: { ...test.trustedWebContents, id: 99 }, senderFrame: test.mainFrame } as unknown as IpcMainInvokeEvent;
      } else if (kind === 'iframe') {
        event = { sender: test.trustedWebContents, senderFrame: { url: RENDERER_URL } } as unknown as IpcMainInvokeEvent;
      } else if (kind === 'url-drift') {
        vi.mocked(test.trustedWebContents.getURL).mockReturnValue('file:///unexpected.html');
      } else {
        test.mainFrame.url = 'file:///attacker.html';
        vi.mocked(test.trustedWebContents.getURL).mockReturnValue('file:///attacker.html');
      }

      await expect(test.invoke(event)).rejects.toThrow(/trusted main frame/i);
      expect(test.firstRunService.createTestProject).not.toHaveBeenCalled();
    },
  );

  it('maps unknown service failures to a fixed public error without raw details', async () => {
    const test = harness();
    test.firstRunService.createTestProject.mockRejectedValueOnce(
      new Error('C:\\secret\\path EACCES mutation-id=secret'),
    );
    await expect(test.invoke()).rejects.toMatchObject({
      code: 'FIRST_RUN_PROJECT_CREATE_FAILED',
      message: 'Unable to create the first-run test project.',
    });
    await expect(test.invoke()).resolves.toEqual(PUBLIC_PROJECT);
  });
});
