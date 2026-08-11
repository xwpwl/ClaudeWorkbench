import type { ClaudeLocalSessionAdapter } from '../claude/ClaudeLocalSessionAdapter';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { ForkOptions, HistoricalMessage } from '../../shared/types/session';
import type { PageRequest, PageResult } from '../../shared/types/workbench';
import type { PublicIpcRegistrar } from './public-invoke-boundary';

const DEFAULT_HISTORY_PAGE_LIMIT = 100;
const MAX_HISTORY_PAGE_LIMIT = 500;

export function paginateHistoryMessages(
  messages: HistoricalMessage[],
  request?: PageRequest | null,
): PageResult<HistoricalMessage> {
  const page = request ?? {};
  const requestedLimit = Number.isFinite(page.limit)
    ? Math.trunc(page.limit as number)
    : DEFAULT_HISTORY_PAGE_LIMIT;
  const limit = Math.min(MAX_HISTORY_PAGE_LIMIT, Math.max(1, requestedLimit));
  const hasExplicitOffset = Number.isFinite(page.offset);
  const requestedOffset = hasExplicitOffset ? Math.trunc(page.offset as number) : 0;
  const offset = hasExplicitOffset
    ? Math.min(messages.length, Math.max(0, requestedOffset))
    : Math.max(0, messages.length - limit);

  return {
    items: messages.slice(offset, offset + limit),
    total: messages.length,
    limit,
    offset,
  };
}

export function registerHistoryIPC(
  ipcMain: PublicIpcRegistrar,
  historyAdapter: ClaudeLocalSessionAdapter,
): void {
  ipcMain.handle(
    IPC_CHANNELS.HISTORY_LIST,
    async (_event, projectPath: string) => {
      return historyAdapter.listSessions(projectPath);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HISTORY_GET_MESSAGES,
    async (_event, projectPath: string, sessionId: string) => {
      return historyAdapter.getMessages(projectPath, sessionId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HISTORY_GET_MESSAGES_PAGE,
    async (
      _event,
      projectPath: string,
      sessionId: string,
      request?: PageRequest,
    ) => {
      const messages = await historyAdapter.getMessages(projectPath, sessionId);
      return paginateHistoryMessages(messages, request);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HISTORY_GET_INFO,
    async (_event, projectPath: string, sessionId: string) => {
      return historyAdapter.getSessionInfo(projectPath, sessionId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HISTORY_RENAME,
    async (_event, projectPath: string, sessionId: string, title: string) => {
      await historyAdapter.renameSession(projectPath, sessionId, title);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HISTORY_ARCHIVE,
    async (_event, projectPath: string, sessionId: string) => {
      await historyAdapter.archiveSession(projectPath, sessionId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HISTORY_SET_ARCHIVED,
    async (
      _event,
      projectPath: string,
      sessionId: string,
      archived: boolean,
    ) => {
      await historyAdapter.setArchived(projectPath, sessionId, archived);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HISTORY_FORK,
    async (_event, projectPath: string, sessionId: string, options?: ForkOptions) => {
      return historyAdapter.forkSession(projectPath, sessionId, options);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HISTORY_DELETE,
    async (_event, projectPath: string, sessionId: string) => {
      await historyAdapter.deleteSession(projectPath, sessionId);
    },
  );
}
