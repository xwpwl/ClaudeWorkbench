import type { IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { ClaudeCodeUpdateManager } from '../claude/ClaudeCodeUpdateManager';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { ClaudeCodeUpdateSnapshot } from '../../shared/types/ipc';
import type { PublicIpcRegistrar } from './public-invoke-boundary';
import { assertTrustedMainFrame, type TrustedRendererIPCDependencies } from './trusted-frame';

export interface ClaudeUpdatesIPCDependencies extends TrustedRendererIPCDependencies {
  updates: Pick<ClaudeCodeUpdateManager, 'getSnapshot' | 'updateNow'>;
}

const emptyTuple = z.tuple([]);

function assertClaudeUpdateRequest(
  event: IpcMainInvokeEvent,
  args: unknown[],
  dependencies: ClaudeUpdatesIPCDependencies,
): void {
  assertTrustedMainFrame(
    event,
    dependencies,
    'Claude update IPC requires the trusted main frame.',
  );
  if (!emptyTuple.safeParse(args).success) {
    throw new Error('Invalid Claude update request.');
  }
}

function projectSnapshot(snapshot: ClaudeCodeUpdateSnapshot): ClaudeCodeUpdateSnapshot {
  return Object.freeze({
    status: snapshot.status,
    reason: snapshot.reason,
    beforeVersion: snapshot.beforeVersion,
    afterVersion: snapshot.afterVersion,
  });
}

export function registerClaudeUpdatesIPC(
  ipcMain: PublicIpcRegistrar,
  dependencies: ClaudeUpdatesIPCDependencies,
): () => void {
  const channels = [
    IPC_CHANNELS.CLAUDE_CODE_UPDATE_GET_STATE,
    IPC_CHANNELS.CLAUDE_CODE_UPDATE_NOW,
  ] as const;

  ipcMain.handle(IPC_CHANNELS.CLAUDE_CODE_UPDATE_GET_STATE, async (event, ...args) => {
    assertClaudeUpdateRequest(event, args, dependencies);
    return projectSnapshot(dependencies.updates.getSnapshot());
  });
  ipcMain.handle(IPC_CHANNELS.CLAUDE_CODE_UPDATE_NOW, async (event, ...args) => {
    assertClaudeUpdateRequest(event, args, dependencies);
    return projectSnapshot(await dependencies.updates.updateNow());
  });

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
