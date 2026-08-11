import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { paginateHistoryMessages, registerHistoryIPC } from '../history';

function historyMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `message-${index}`,
    uuid: `message-${index}`,
  }));
}

describe('history message paging', () => {
  it('returns the newest page when no offset is supplied', () => {
    const result = paginateHistoryMessages(historyMessages(250), { limit: 100 });

    expect(result).toMatchObject({ total: 250, limit: 100, offset: 150 });
    expect(result.items[0]?.content).toBe('message-150');
    expect(result.items.at(-1)?.content).toBe('message-249');
  });

  it('supports explicit older pages and clamps unsafe page values', () => {
    const older = paginateHistoryMessages(historyMessages(250), { limit: 100, offset: 50 });
    const clamped = paginateHistoryMessages(historyMessages(2), {
      limit: Number.POSITIVE_INFINITY,
      offset: Number.NEGATIVE_INFINITY,
    });

    expect(older.items).toHaveLength(100);
    expect(older.items[0]?.content).toBe('message-50');
    expect(clamped).toMatchObject({ total: 2, limit: 100, offset: 0 });
    expect(paginateHistoryMessages(historyMessages(2), null))
      .toMatchObject({ total: 2, limit: 100, offset: 0 });
  });

  it('exposes paged history through IPC without removing the full-history API', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const historyAdapter = {
      getMessages: vi.fn(async () => historyMessages(125)),
    };
    registerHistoryIPC(ipcMain as never, historyAdapter as never);

    const result = await handlers.get(IPC_CHANNELS.HISTORY_GET_MESSAGES_PAGE)?.(
      {},
      'C:\\Projects\\Alpha',
      'session-a',
      { limit: 25 },
    ) as ReturnType<typeof paginateHistoryMessages>;

    expect(result).toMatchObject({ total: 125, limit: 25, offset: 100 });
    expect(historyAdapter.getMessages).toHaveBeenCalledWith(
      'C:\\Projects\\Alpha',
      'session-a',
    );
    expect(handlers.has(IPC_CHANNELS.HISTORY_GET_MESSAGES)).toBe(true);
  });
});
