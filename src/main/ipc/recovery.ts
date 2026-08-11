import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { RecoveryCenterSnapshot, RecoveryItem } from '../../shared/types/recovery';
import type { RecoveryItemRow } from '../database/Database';
import type { CrashRecoveryManager } from '../recovery/CrashRecoveryManager';
import type { PublicIpcRegistrar } from './public-invoke-boundary';

export interface RecoveryIPCDependencies {
  manager: CrashRecoveryManager;
  abnormalExitDetected: boolean;
  openLogs(): void | Promise<void>;
}

function validId(value: unknown): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 512
    || value.includes('\0')
  ) {
    throw new Error('Recovery item id is invalid.');
  }
  return value;
}

function view(row: RecoveryItemRow): RecoveryItem {
  return {
    id: row.id,
    kind: row.kind,
    resourceId: row.resource_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    lastState: row.last_state,
    reason: row.reason,
    status: row.status,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
  };
}

export function registerRecoveryIPC(
  ipcMain: PublicIpcRegistrar,
  dependencies: RecoveryIPCDependencies,
): () => void {
  ipcMain.handle(IPC_CHANNELS.RECOVERY_GET, async (): Promise<RecoveryCenterSnapshot> => ({
    abnormalExitDetected: dependencies.abnormalExitDetected,
    appRunId: dependencies.manager.appRunId ?? '',
    items: dependencies.manager.listRecoveryItems().map(view),
  }));
  ipcMain.handle(IPC_CHANNELS.RECOVERY_RESUME, async (_event, itemId: unknown) => (
    view(await dependencies.manager.resume(validId(itemId)))
  ));
  ipcMain.handle(IPC_CHANNELS.RECOVERY_ABANDON, async (_event, itemId: unknown) => (
    view(await dependencies.manager.abandon(validId(itemId)))
  ));
  ipcMain.handle(IPC_CHANNELS.RECOVERY_OPEN_LOGS, async () => dependencies.openLogs());
  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.RECOVERY_GET);
    ipcMain.removeHandler(IPC_CHANNELS.RECOVERY_RESUME);
    ipcMain.removeHandler(IPC_CHANNELS.RECOVERY_ABANDON);
    ipcMain.removeHandler(IPC_CHANNELS.RECOVERY_OPEN_LOGS);
  };
}

export const recoveryIpcInternals = { validId, view };
