import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../database/Database';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { registerSettingsIPC } from '../settings';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const RENDERER_URL = 'file:///C:/ClaudeWorkbench/dist/renderer/index.html';

function harness(stored: Record<string, string> = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  } as unknown as IpcMain;
  const database = {
    getAllSettings: vi.fn(() => stored),
    getSetting: vi.fn((key: string) => stored[key]),
    setSetting: vi.fn(),
  } as unknown as AppDatabase;
  const mainFrame = { url: RENDERER_URL };
  const trustedWebContents = {
    id: 42,
    mainFrame,
    getURL: vi.fn(() => RENDERER_URL),
    isDestroyed: vi.fn(() => false),
  } as unknown as WebContents;
  registerSettingsIPC(ipcMain, database, {
    getTrustedWebContents: () => trustedWebContents,
    getTrustedFrameUrl: () => RENDERER_URL,
  });
  const event = { sender: trustedWebContents, senderFrame: mainFrame } as IpcMainInvokeEvent;
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    return handler(event, ...args);
  };
  const invokeWithEvent = (eventOverride: IpcMainInvokeEvent, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    return handler(eventOverride, ...args);
  };
  return { database, invoke, invokeWithEvent, mainFrame, trustedWebContents };
}

describe('first-run completion version IPC', () => {
  it.each([
    ['welcome', 'welcome'],
    ['environment', 'environment'],
    ['provider', 'provider'],
    ['project', 'project'],
    ['first_task', 'first_task'],
  ] as const)('round-trips the closed resume step %s without a draft payload', async (step, expected) => {
    const test = harness({ firstRunResumeStep: step });
    await expect(test.invoke(IPC_CHANNELS.FIRST_RUN_GET_RESUME_STEP)).resolves.toBe(expected);
    await expect(test.invoke(IPC_CHANNELS.FIRST_RUN_SET_RESUME_STEP, step)).resolves.toBeUndefined();
    expect(test.database.setSetting).toHaveBeenCalledWith('firstRunResumeStep', step);
  });

  it.each([undefined, '', 'api-key-draft', 'completing', 'done'])('%s fails closed to welcome', async (step) => {
    const stored = step === undefined ? {} : { firstRunResumeStep: step };
    await expect(harness(stored).invoke(IPC_CHANNELS.FIRST_RUN_GET_RESUME_STEP)).resolves.toBe('welcome');
  });

  it.each([undefined, null, {}, 'done', 'provider\u0000secret'])('rejects invalid resume step %#', async (step) => {
    const test = harness();
    await expect(
      step === undefined
        ? test.invoke(IPC_CHANNELS.FIRST_RUN_SET_RESUME_STEP)
        : test.invoke(IPC_CHANNELS.FIRST_RUN_SET_RESUME_STEP, step),
    ).rejects.toThrow('Invalid first-run resume step.');
    expect(test.database.setSetting).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'malformed', '-1', '1.5'])('normalizes %s to version zero', async (value) => {
    const test = harness(value === undefined ? {} : { firstRunCompletedVersion: value });
    await expect(test.invoke(IPC_CHANNELS.FIRST_RUN_GET_COMPLETED_VERSION)).resolves.toBe(0);
  });

  it('preserves a valid future nonnegative integer', async () => {
    await expect(harness({ firstRunCompletedVersion: '42' }).invoke(
      IPC_CHANNELS.FIRST_RUN_GET_COMPLETED_VERSION,
    )).resolves.toBe(42);
  });

  it('writes only the literal supported completion version', async () => {
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.FIRST_RUN_SET_COMPLETED_VERSION, 1)).resolves.toBeUndefined();
    expect(test.database.setSetting).toHaveBeenCalledWith('firstRunCompletedVersion', '1');
  });

  it.each([undefined, 0, 2, -1, 1.5, '1', null, {}])(
    'rejects unsupported completion version %#',
    async (version) => {
      const test = harness();
      await expect(
        version === undefined
          ? test.invoke(IPC_CHANNELS.FIRST_RUN_SET_COMPLETED_VERSION)
          : test.invoke(IPC_CHANNELS.FIRST_RUN_SET_COMPLETED_VERSION, version),
      ).rejects.toThrow('Invalid first-run completion version.');
      expect(test.database.setSetting).not.toHaveBeenCalled();
    },
  );

  it('rejects extra arguments before reading or writing settings', async () => {
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.FIRST_RUN_GET_COMPLETED_VERSION, 'extra'))
      .rejects.toThrow('Invalid first-run completion request.');
    await expect(test.invoke(IPC_CHANNELS.FIRST_RUN_SET_COMPLETED_VERSION, 1, 'extra'))
      .rejects.toThrow('Invalid first-run completion version.');
    expect(test.database.getSetting).not.toHaveBeenCalled();
    expect(test.database.setSetting).not.toHaveBeenCalled();
  });

  it.each(['foreign', 'iframe', 'url-drift', 'stable-url-drift'])(
    'rejects an untrusted %s invocation before database access',
    async (kind) => {
      const test = harness();
      let event = {
        sender: test.trustedWebContents,
        senderFrame: test.mainFrame,
      } as unknown as IpcMainInvokeEvent;
      if (kind === 'foreign') {
        event = { sender: { ...test.trustedWebContents, id: 99 }, senderFrame: test.mainFrame } as unknown as IpcMainInvokeEvent;
      } else if (kind === 'iframe') {
        event = { sender: test.trustedWebContents, senderFrame: { url: RENDERER_URL } } as unknown as IpcMainInvokeEvent;
      } else if (kind === 'url-drift') {
        vi.mocked(test.trustedWebContents.getURL).mockReturnValue('file:///unexpected.html');
      } else {
        test.mainFrame.url = 'file:///attacker.html';
        vi.mocked(test.trustedWebContents.getURL).mockReturnValue('file:///attacker.html');
      }
      await expect(test.invokeWithEvent(event, IPC_CHANNELS.FIRST_RUN_GET_COMPLETED_VERSION))
        .rejects.toThrow(/trusted main frame/i);
      expect(test.database.getSetting).not.toHaveBeenCalled();
    },
  );

  it('keeps the generic settings surface closed to completion ownership state', async () => {
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.SETTINGS_SET, { firstRunCompletedVersion: 1 }))
      .rejects.toThrow(/unsupported|unknown/iu);
    await expect(test.invoke(IPC_CHANNELS.SETTINGS_SET, { firstRunResumeStep: 'provider' }))
      .rejects.toThrow(/unsupported|unknown/iu);
    expect(test.database.setSetting).not.toHaveBeenCalled();
  });
});

describe('update settings persistence', () => {
  it('defaults automatic update checks to false for old profiles', async () => {
    await expect(harness().invoke(IPC_CHANNELS.SETTINGS_GET)).resolves.toMatchObject({
      autoCheckUpdates: false,
    });
  });

  it('loads the persisted boolean setting', async () => {
    await expect(harness({ autoCheckUpdates: 'true' }).invoke(IPC_CHANNELS.SETTINGS_GET))
      .resolves.toMatchObject({ autoCheckUpdates: true });
  });

  it('persists an explicit boolean setting', async () => {
    const test = harness();
    await test.invoke(IPC_CHANNELS.SETTINGS_SET, { autoCheckUpdates: true });
    expect(test.database.setSetting).toHaveBeenCalledWith('autoCheckUpdates', 'true');
  });

  it.each([1, 'true', null, {}, []])('rejects a non-boolean auto-check setting %#', async (value) => {
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.SETTINGS_SET, { autoCheckUpdates: value }))
      .rejects.toThrow('autoCheckUpdates must be a boolean');
    expect(test.database.setSetting).not.toHaveBeenCalled();
  });

  it.each(['apiKey', 'api_key', 'credential', 'credentialRef', 'providerSecret'])(
    'never persists secret-shaped unknown setting %s',
    async (key) => {
      const test = harness();
      await expect(test.invoke(IPC_CHANNELS.SETTINGS_SET, { [key]: 'secret-sentinel' }))
        .rejects.toThrow(/unknown|unsupported/iu);
      expect(test.database.setSetting).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown ordinary settings instead of silently creating database fields', async () => {
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.SETTINGS_SET, { futureFlag: true }))
      .rejects.toThrow(/unknown|unsupported/iu);
    expect(test.database.setSetting).not.toHaveBeenCalled();
  });

  it.each([
    ['fontSize', '14'],
    ['theme', 'blue'],
    ['terminalShell', 'bash'],
    ['defaultPermissionMode', 'bypassPermissions'],
  ])('rejects invalid value for %s', async (key, value) => {
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.SETTINGS_SET, { [key]: value }))
      .rejects.toThrow();
    expect(test.database.setSetting).not.toHaveBeenCalled();
  });
});
