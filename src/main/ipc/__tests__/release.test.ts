import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { registerReleaseIPC } from '../release';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function harness() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  } as unknown as IpcMain;
  const version = {
    version: '1.0.0', buildId: 'build-7', commit: '0123456', channel: 'stable',
    electronVersion: '35.6.0', nodeVersion: '24.1.0', sqliteSchemaVersion: 7,
    agentRuntime: 'claude-code' as const, packaged: true,
  };
  const idle = { status: 'idle', version: null, reason: null, message: null } as const;
  const available = { status: 'available', version: '1.1.0', reason: null, message: null } as const;
  const downloaded = { status: 'downloaded', version: '1.1.0', reason: null, message: null } as const;
  const dependencies = {
    getVersionInfo: vi.fn(async () => version),
    updates: {
      getState: vi.fn(() => idle),
      checkForUpdates: vi.fn(async () => available),
      downloadUpdate: vi.fn(async () => downloaded),
      installDownloadedUpdate: vi.fn(() => true),
    },
  };
  const dispose = registerReleaseIPC(ipcMain, dependencies);
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    return handler({}, ...args);
  };
  return { dependencies, dispose, handlers, invoke, ipcMain, version };
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

  it.each([undefined, null, false, 1, 'true', {}, []])(
    'rejects non-literal install confirmation %#',
    async (confirmed) => {
      const test = harness();
      await expect(test.invoke(IPC_CHANNELS.RELEASE_INSTALL_UPDATE, confirmed)).resolves.toBe(false);
      expect(test.dependencies.updates.installDownloadedUpdate).not.toHaveBeenCalled();
    },
  );

  it('forwards only literal true installation confirmation', async () => {
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.RELEASE_INSTALL_UPDATE, true)).resolves.toBe(true);
    expect(test.dependencies.updates.installDownloadedUpdate).toHaveBeenCalledWith(true);
  });

  it('removes every release handler on dispose', () => {
    const test = harness();
    expect(test.handlers.size).toBe(5);
    test.dispose();
    expect(test.handlers.size).toBe(0);
    expect(test.ipcMain.removeHandler).toHaveBeenCalledTimes(5);
  });
});
