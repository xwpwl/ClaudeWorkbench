import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { ReleaseVersionInfo, UpdateSnapshot } from '../../shared/types/ipc';
import type { PublicIpcRegistrar } from './public-invoke-boundary';

export interface ReleaseIPCDependencies {
  getVersionInfo(): ReleaseVersionInfo | Promise<ReleaseVersionInfo>;
  updates: {
    getState(): UpdateSnapshot;
    checkForUpdates(): Promise<UpdateSnapshot>;
    downloadUpdate(): Promise<UpdateSnapshot>;
    installDownloadedUpdate(confirmed: boolean): boolean;
  };
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

  ipcMain.handle(IPC_CHANNELS.RELEASE_GET_VERSION, async () => dependencies.getVersionInfo());
  ipcMain.handle(IPC_CHANNELS.RELEASE_GET_UPDATE_STATE, async () => dependencies.updates.getState());
  ipcMain.handle(IPC_CHANNELS.RELEASE_CHECK_UPDATE, async () => dependencies.updates.checkForUpdates());
  ipcMain.handle(IPC_CHANNELS.RELEASE_DOWNLOAD_UPDATE, async () => dependencies.updates.downloadUpdate());
  ipcMain.handle(
    IPC_CHANNELS.RELEASE_INSTALL_UPDATE,
    async (_event, confirmed: unknown) => (
      confirmed === true ? dependencies.updates.installDownloadedUpdate(true) : false
    ),
  );

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
