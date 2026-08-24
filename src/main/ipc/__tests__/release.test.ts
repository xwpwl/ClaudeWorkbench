import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import type { ReleaseVersionInfo } from '../../../shared/types/ipc';
import { registerReleaseIPC } from '../release';
import { publicIpcMainForTest } from './public-invoke-test-helper';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const RENDERER_URL = 'file:///C:/ClaudeWorkbench/dist/renderer/index.html';

function harness(publicEnvelope = false) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  } as unknown as IpcMain;
  const version: ReleaseVersionInfo = {
    version: '1.0.1-rc.1',
    channel: 'rc',
    buildId: '1.0.1-rc.1+0123456789ab.20260813T000000Z',
    commit: '0123456789abcdef0123456789abcdef01234567',
    electronVersion: '35.6.0',
    nodeVersion: '22.14.0',
    sqliteSchemaVersion: 7,
    agentRuntime: 'claude-code',
    packaged: true,
    signatureStatus: 'NotSigned',
    productionFeedConfigured: false,
    licenseStatus: 'decision_required',
    privacyStatus: 'draft',
    releaseNotesSha256: 'a'.repeat(64),
  };
  const idle = { status: 'idle', version: null, reason: null, message: null } as const;
  const available = { status: 'available', version: '1.1.0', reason: null, message: null } as const;
  const downloaded = { status: 'downloaded', version: '1.1.0', reason: null, message: null } as const;
  const mainFrame = { url: RENDERER_URL };
  const trustedWebContents = {
    id: 42,
    mainFrame,
    getURL: vi.fn(() => RENDERER_URL),
    isDestroyed: vi.fn(() => false),
  } as unknown as WebContents;
  const dependencies = {
    getVersionInfo: vi.fn(async () => version),
    updates: {
      getState: vi.fn(() => idle),
      checkForUpdates: vi.fn(async () => available),
      downloadUpdate: vi.fn(async () => downloaded),
      installDownloadedUpdate: vi.fn(() => true),
    },
    getTrustedWebContents: () => trustedWebContents,
    getTrustedFrameUrl: () => RENDERER_URL,
  };
  const dispose = registerReleaseIPC(
    publicEnvelope ? publicIpcMainForTest(ipcMain) : ipcMain as never,
    dependencies,
  );
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
    version,
  };
}

describe('release IPC', () => {
  it('returns injected public version metadata', async () => {
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.RELEASE_GET_VERSION)).resolves.toEqual(test.version);
  });

  it('returns update state without starting a check', async () => {
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.RELEASE_GET_UPDATE_STATE)).resolves.toMatchObject({ status: 'idle' });
    expect(test.dependencies.updates.checkForUpdates).not.toHaveBeenCalled();
  });

  it('maps explicit check and download actions', async () => {
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.RELEASE_CHECK_UPDATE)).resolves.toMatchObject({ status: 'available' });
    await expect(test.invoke(IPC_CHANNELS.RELEASE_DOWNLOAD_UPDATE)).resolves.toMatchObject({ status: 'downloaded' });
    expect(test.dependencies.updates.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(test.dependencies.updates.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('authenticates the sender before parsing or invoking every release action', async () => {
    const cases = [
      [IPC_CHANNELS.RELEASE_GET_VERSION, 'forged-extra'],
      [IPC_CHANNELS.RELEASE_GET_UPDATE_STATE, 'forged-extra'],
      [IPC_CHANNELS.RELEASE_CHECK_UPDATE, 'forged-extra'],
      [IPC_CHANNELS.RELEASE_DOWNLOAD_UPDATE, 'forged-extra'],
      [IPC_CHANNELS.RELEASE_INSTALL_UPDATE, { confirmed: true, url: 'https://evil.invalid' }],
    ] as const;

    for (const [channel, ...args] of cases) {
      const test = harness();
      const subframe = {
        sender: test.trustedWebContents,
        senderFrame: { url: RENDERER_URL },
      } as unknown as IpcMainInvokeEvent;

      await expect(test.invokeFrom(subframe, channel, ...args))
        .rejects.toThrow(/trusted main frame/iu);
      expect(test.dependencies.getVersionInfo).not.toHaveBeenCalled();
      expect(test.dependencies.updates.getState).not.toHaveBeenCalled();
      expect(test.dependencies.updates.checkForUpdates).not.toHaveBeenCalled();
      expect(test.dependencies.updates.downloadUpdate).not.toHaveBeenCalled();
      expect(test.dependencies.updates.installDownloadedUpdate).not.toHaveBeenCalled();
    }
  });

  it.each(['foreign', 'destroyed'] as const)(
    'rejects a %s main-frame invocation before reading release state',
    async (kind) => {
      const test = harness();
      let event = test.event;
      if (kind === 'foreign') {
        event = {
          sender: { ...test.trustedWebContents, id: 99 },
          senderFrame: test.mainFrame,
        } as unknown as IpcMainInvokeEvent;
      } else {
        vi.mocked(test.trustedWebContents.isDestroyed).mockReturnValue(true);
      }

      await expect(test.invokeFrom(event, IPC_CHANNELS.RELEASE_GET_VERSION))
        .rejects.toThrow(/trusted main frame/iu);
      expect(test.dependencies.getVersionInfo).not.toHaveBeenCalled();
    },
  );

  it('rejects extra arguments for every read, check, and download action', async () => {
    const channels = [
      IPC_CHANNELS.RELEASE_GET_VERSION,
      IPC_CHANNELS.RELEASE_GET_UPDATE_STATE,
      IPC_CHANNELS.RELEASE_CHECK_UPDATE,
      IPC_CHANNELS.RELEASE_DOWNLOAD_UPDATE,
    ] as const;

    for (const channel of channels) {
      const test = harness();
      await expect(test.invoke(channel, 'extra')).rejects.toThrow('Invalid release request.');
      expect(test.dependencies.getVersionInfo).not.toHaveBeenCalled();
      expect(test.dependencies.updates.getState).not.toHaveBeenCalled();
      expect(test.dependencies.updates.checkForUpdates).not.toHaveBeenCalled();
      expect(test.dependencies.updates.downloadUpdate).not.toHaveBeenCalled();
      expect(test.dependencies.updates.installDownloadedUpdate).not.toHaveBeenCalled();
    }
  });

  it.each([
    [],
    [true],
    [{ confirmed: false }],
    [{ confirmed: true, url: 'https://evil.invalid' }],
    [{ confirmed: true, path: 'C:\\private\\update.exe' }],
    [{ confirmed: true }, 'extra'],
  ])('rejects a malformed or extended install intent tuple %#', async (...args) => {
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.RELEASE_INSTALL_UPDATE, ...args))
      .rejects.toThrow('Invalid release request.');
    expect(test.dependencies.updates.installDownloadedUpdate).not.toHaveBeenCalled();
  });

  it('forwards only the exact literal install confirmation object', async () => {
    const test = harness();
    await expect(test.invoke(
      IPC_CHANNELS.RELEASE_INSTALL_UPDATE,
      { confirmed: true },
    )).resolves.toBe(true);
    expect(test.dependencies.updates.installDownloadedUpdate).toHaveBeenCalledWith(true);
  });

  it('returns exact public envelopes without exposing validation errors', async () => {
    const test = harness(true);

    const success = await test.invoke(IPC_CHANNELS.RELEASE_GET_VERSION);
    const failure = await test.invoke(IPC_CHANNELS.RELEASE_GET_VERSION, 'extra');

    expect(success).toStrictEqual({ schemaVersion: 1, ok: true, value: test.version });
    expect(failure).toStrictEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'IPC_OPERATION_FAILED',
        message: 'The requested operation failed.',
      },
    });
    expect(Reflect.ownKeys(success as object)).toStrictEqual(['schemaVersion', 'ok', 'value']);
    expect(Reflect.ownKeys(failure as object)).toStrictEqual(['schemaVersion', 'ok', 'error']);
    expect(JSON.stringify(failure)).not.toContain('Invalid release request.');
  });

  it('removes every release handler on dispose', () => {
    const test = harness();
    expect(test.handlers.size).toBe(5);
    test.dispose();
    expect(test.handlers.size).toBe(0);
    expect(test.ipcMain.removeHandler).toHaveBeenCalledTimes(5);
  });
});
