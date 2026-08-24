import { z } from 'zod';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { ReleaseVersionInfo, UpdateSnapshot } from '../../shared/types/ipc';
import type { PublicIpcRegistrar } from './public-invoke-boundary';
import { assertTrustedMainFrame, type TrustedRendererIPCDependencies } from './trusted-frame';

export interface ReleaseIPCDependencies extends TrustedRendererIPCDependencies {
  getVersionInfo(): ReleaseVersionInfo | Promise<ReleaseVersionInfo>;
  updates: {
    getState(): UpdateSnapshot;
    checkForUpdates(): Promise<UpdateSnapshot>;
    downloadUpdate(): Promise<UpdateSnapshot>;
    installDownloadedUpdate(confirmed: boolean): boolean;
  };
}

const emptyTuple = z.tuple([]);
const installTuple = z.tuple([
  z.object({ confirmed: z.literal(true) }).strict(),
]);

function assertReleaseRequest(
  event: IpcMainInvokeEvent,
  args: unknown[],
  schema: typeof emptyTuple | typeof installTuple,
  dependencies: ReleaseIPCDependencies,
): void {
  assertTrustedMainFrame(event, dependencies, 'Release IPC requires the trusted main frame.');
  if (!schema.safeParse(args).success) throw new Error('Invalid release request.');
}

/** Registers the renderer-facing release API without granting updater authority. */
export function registerReleaseIPC(
  ipcMain: PublicIpcRegistrar,
  dependencies: ReleaseIPCDependencies,
): () => void {
  const channels = [
    IPC_CHANNELS.RELEASE_GET_VERSION,
    IPC_CHANNELS.RELEASE_GET_UPDATE_STATE,
    IPC_CHANNELS.RELEASE_CHECK_UPDATE,
    IPC_CHANNELS.RELEASE_DOWNLOAD_UPDATE,
    IPC_CHANNELS.RELEASE_INSTALL_UPDATE,
  ] as const;

  ipcMain.handle(IPC_CHANNELS.RELEASE_GET_VERSION, async (event, ...args) => {
    assertReleaseRequest(event, args, emptyTuple, dependencies);
    return dependencies.getVersionInfo();
  });
  ipcMain.handle(IPC_CHANNELS.RELEASE_GET_UPDATE_STATE, async (event, ...args) => {
    assertReleaseRequest(event, args, emptyTuple, dependencies);
    return dependencies.updates.getState();
  });
  ipcMain.handle(IPC_CHANNELS.RELEASE_CHECK_UPDATE, async (event, ...args) => {
    assertReleaseRequest(event, args, emptyTuple, dependencies);
    return dependencies.updates.checkForUpdates();
  });
  ipcMain.handle(IPC_CHANNELS.RELEASE_DOWNLOAD_UPDATE, async (event, ...args) => {
    assertReleaseRequest(event, args, emptyTuple, dependencies);
    return dependencies.updates.downloadUpdate();
  });
  ipcMain.handle(
    IPC_CHANNELS.RELEASE_INSTALL_UPDATE,
    async (event, ...args) => {
      assertReleaseRequest(event, args, installTuple, dependencies);
      return dependencies.updates.installDownloadedUpdate(true);
    },
  );

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
