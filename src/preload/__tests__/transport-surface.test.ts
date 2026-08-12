import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_WORKBENCH_API_METHODS,
  CLAUDE_WORKBENCH_EVENT_METHODS,
  IPC_CHANNELS,
} from '../../shared/types/ipc';

const EVENT_METHODS = CLAUDE_WORKBENCH_EVENT_METHODS;

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
    send: electronMocks.send,
  },
}));

await import('../index');

function exposedTransport(): Record<string, (...args: unknown[]) => unknown> {
  const call = electronMocks.exposeInMainWorld.mock.calls
    .find(([name]) => name === '__claudeWorkbenchIpcTransport');
  if (!call) throw new Error('Named fulfilled IPC transport was not exposed.');
  return call[1] as Record<string, (...args: unknown[]) => unknown>;
}

beforeEach(() => {
  electronMocks.invoke.mockReset().mockResolvedValue({
    schemaVersion: 1,
    ok: true,
    value: undefined,
  });
  electronMocks.on.mockClear();
  electronMocks.removeListener.mockClear();
});

describe('preload exact named transport surface', () => {
  it('exposes exactly 134 Promise methods and nine synchronous subscriptions with no raw IPC API', () => {
    const transport = exposedTransport();
    expect(electronMocks.exposeInMainWorld.mock.calls.map(([name]) => name)).toStrictEqual([
      '__claudeWorkbenchIpcTransport',
    ]);
    expect(electronMocks.exposeInMainWorld.mock.calls.some(([name]) => name === 'api')).toBe(false);
    const keys = Reflect.ownKeys(transport);
    const stringKeys = keys.filter((key): key is string => typeof key === 'string');
    const eventKeys = stringKeys.filter((key) => EVENT_METHODS.includes(key));
    const promiseKeys = stringKeys.filter((key) => !EVENT_METHODS.includes(key));

    expect(stringKeys).toStrictEqual(CLAUDE_WORKBENCH_API_METHODS);
    expect(keys).toHaveLength(CLAUDE_WORKBENCH_API_METHODS.length);
    expect(eventKeys).toStrictEqual(EVENT_METHODS);
    expect(promiseKeys).toHaveLength(134);
    expect(stringKeys).not.toEqual(expect.arrayContaining([
      'invoke', 'on', 'send', 'removeListener', 'channel', 'then',
    ]));
    for (const key of stringKeys) expect(typeof transport[key]).toBe('function');
  });

  it('keeps event unsubscribe synchronous while Promise methods return fulfilled envelopes', async () => {
    const transport = exposedTransport();
    const unsubscribe = transport.onClaudeEvent(() => undefined);
    expect(typeof unsubscribe).toBe('function');
    expect(unsubscribe).not.toBeInstanceOf(Promise);
    (unsubscribe as () => void)();
    expect(electronMocks.removeListener).toHaveBeenCalledTimes(1);

    const pending = transport.getFirstRunCompletedVersion();
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toStrictEqual({
      schemaVersion: 1,
      ok: true,
      value: undefined,
    });
  });

  it('settles the composed openProject flow without treating envelopes as directory values', async () => {
    const transport = exposedTransport();
    electronMocks.invoke.mockResolvedValueOnce({ schemaVersion: 1, ok: true, value: null });

    await expect(transport.openProject()).resolves.toStrictEqual({
      schemaVersion: 1,
      ok: true,
      value: null,
    });
    expect(electronMocks.invoke).toHaveBeenCalledTimes(1);
    expect(electronMocks.invoke).toHaveBeenCalledWith(IPC_CHANNELS.DIALOG_OPEN_DIRECTORY);

    electronMocks.invoke.mockReset()
      .mockResolvedValueOnce({ schemaVersion: 1, ok: true, value: 'C:\\fixed-project' })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        ok: true,
        value: { id: 'project-fixed', path: 'C:\\fixed-project' },
      });
    await expect(transport.openProject()).resolves.toStrictEqual({
      schemaVersion: 1,
      ok: true,
      value: { id: 'project-fixed', path: 'C:\\fixed-project' },
    });
    expect(electronMocks.invoke.mock.calls).toStrictEqual([
      [IPC_CHANNELS.DIALOG_OPEN_DIRECTORY],
      [IPC_CHANNELS.PROJECT_OPEN, 'C:\\fixed-project'],
    ]);
  });

  it('keeps explicit runPrompt argument ownership while settling its named result', async () => {
    const transport = exposedTransport();
    electronMocks.invoke.mockResolvedValueOnce({
      schemaVersion: 1,
      ok: true,
      value: { runId: 'run-fixed', sessionId: 'session-fixed' },
    });
    const input = {
      prompt: 'fixed prompt',
      cwd: 'C:\\fixed-project',
      modelProviderId: 'private-provider-ref',
      resolvedModelSelection: { providerId: 'private-provider-ref' },
    };

    await expect(transport.runPrompt(input)).resolves.toStrictEqual({
      schemaVersion: 1,
      ok: true,
      value: { runId: 'run-fixed', sessionId: 'session-fixed' },
    });
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      { prompt: 'fixed prompt', cwd: 'C:\\fixed-project' },
    );
  });
});
