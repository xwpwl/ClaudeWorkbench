import type { IpcMain } from 'electron';
import {
  createPublicIpcMain,
  type PublicIpcRegistrar,
} from '../public-invoke-boundary';

export function publicIpcMainForTest(ipcMain: IpcMain): PublicIpcRegistrar {
  return createPublicIpcMain(ipcMain);
}
