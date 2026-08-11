import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { diagnosticsIpcInternals, registerDiagnosticsExportIPC } from '../diagnostics';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const RENDERER_URL = 'file:///C:/ClaudeWorkbench/dist/renderer/index.html';
const aggregate = {
  operations: {
    direct: { total: 7, completed: 3, failed: 1, cancelled: 1, interrupted: 1 },
    orchestrated: { total: 5, completed: 2, failed: 1, cancelled: 1, interrupted: 0 },
  },
  durationBuckets: {
    underOneSecond: 1,
    oneToTenSeconds: 2,
    tenToSixtySeconds: 3,
    oneToTenMinutes: 4,
    tenMinutesOrMore: 5,
  },
};

function harness(selected: string | null = 'C:\\safe\\diagnostics') {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: vi.fn((channel: string, value: Handler) => handlers.set(channel, value)),
    removeHandler: vi.fn(),
  };
  const exporter = { export: vi.fn().mockResolvedValue('C:\\safe\\diagnostics.zip') };
  const anonymousPerformance = vi.fn(() => aggregate);
  const chooseDestination = vi.fn().mockResolvedValue(selected);
  const mainFrame = { url: RENDERER_URL };
  const trustedWebContents = {
    id: 42,
    mainFrame,
    getURL: vi.fn(() => RENDERER_URL),
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as WebContents;
  registerDiagnosticsExportIPC(ipc as never, {
    exporter: exporter as never,
    chooseDestination,
    version: () => ({ version: '1.0.0' }),
    system: () => ({ platform: 'win32' }),
    database: () => ({ schemaVersion: 7, sizeBytes: 1, journalMode: 'wal', integrity: 'ok', counts: {} }),
    anonymousPerformance,
    getTrustedWebContents: () => trustedWebContents,
    getTrustedFrameUrl: () => RENDERER_URL,
    now: () => new Date('2026-08-01T00:00:00.000Z'),
  });
  const event = { sender: trustedWebContents, senderFrame: mainFrame } as IpcMainInvokeEvent;
  const invoke = (args: unknown[] = [], invokeEvent: IpcMainInvokeEvent = event) => {
    const handler = handlers.get(IPC_CHANNELS.SYSTEM_EXPORT_DIAGNOSTICS);
    if (!handler) throw new Error('Missing diagnostics handler.');
    return handler(invokeEvent, ...args);
  };
  return {
    anonymousPerformance,
    chooseDestination,
    event,
    exporter,
    invoke,
    mainFrame,
    trustedWebContents,
  };
}

describe('diagnostics export IPC', () => {
  it('uses a deterministic privacy-safe filename', () => {
    expect(diagnosticsIpcInternals.fileName(new Date('2026-08-01T01:02:03.004Z')))
      .toBe('ClaudeWorkbench-diagnostics-2026-08-01T01-02-03-004Z.zip');
  });

  it('does not collect or export anything after user cancels', async () => {
    const test = harness(null);
    await expect(test.invoke([{ includeAnonymousPerformanceData: true }])).resolves.toBeNull();
    expect(test.exporter.export).not.toHaveBeenCalled();
    expect(test.anonymousPerformance).not.toHaveBeenCalled();
  });

  it('keeps anonymous collection disabled and returns no destination path by default intent', async () => {
    const test = harness();
    await expect(test.invoke([{ includeAnonymousPerformanceData: false }])).resolves.toBe(true);

    expect(test.anonymousPerformance).not.toHaveBeenCalled();
    expect(test.exporter.export).toHaveBeenCalledWith(expect.objectContaining({
      destinationPath: 'C:\\safe\\diagnostics.zip',
      includeAnonymousPerformanceData: false,
      database: expect.not.objectContaining({ path: expect.anything() }),
    }));
    expect(JSON.stringify(await test.invoke([{ includeAnonymousPerformanceData: false }]))).not.toContain(
      'C:\\safe',
    );
  });

  it('collects the trusted main-owned aggregate only for an explicit enabled intent', async () => {
    const test = harness();
    await expect(test.invoke([{ includeAnonymousPerformanceData: true }])).resolves.toBe(true);

    expect(test.anonymousPerformance).toHaveBeenCalledOnce();
    expect(test.exporter.export).toHaveBeenCalledWith(expect.objectContaining({
      includeAnonymousPerformanceData: true,
      anonymousPerformanceData: aggregate,
    }));
    expect(test.trustedWebContents.send).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [true],
    [{ includeAnonymousPerformanceData: false, aggregate }],
    [{ includeAnonymousPerformanceData: 'false' }],
    [{ includeAnonymousPerformanceData: false }, 'extra'],
  ])('rejects a malformed or extended intent tuple before opening native save %#', async (...args) => {
    const test = harness();
    await expect(test.invoke(args)).rejects.toThrow('Invalid diagnostics export request.');
    expect(test.exporter.export).not.toHaveBeenCalled();
    expect(test.anonymousPerformance).not.toHaveBeenCalled();
  });

  it.each(['foreign', 'iframe', 'url-drift', 'stable-url-drift'])(
    'rejects an untrusted %s invocation before any collection',
    async (kind) => {
      const test = harness();
      let event = test.event;
      if (kind === 'foreign') {
        event = {
          sender: { ...test.trustedWebContents, id: 99 },
          senderFrame: test.mainFrame,
        } as unknown as IpcMainInvokeEvent;
      } else if (kind === 'iframe') {
        event = {
          sender: test.trustedWebContents,
          senderFrame: { url: RENDERER_URL },
        } as unknown as IpcMainInvokeEvent;
      } else if (kind === 'url-drift') {
        vi.mocked(test.trustedWebContents.getURL).mockReturnValue('file:///unexpected.html');
      } else {
        test.mainFrame.url = 'file:///attacker.html';
        vi.mocked(test.trustedWebContents.getURL).mockReturnValue('file:///attacker.html');
      }

      await expect(test.invoke([{ includeAnonymousPerformanceData: false }], event))
        .rejects.toThrow(/trusted main frame/i);
      expect(test.exporter.export).not.toHaveBeenCalled();
      expect(test.anonymousPerformance).not.toHaveBeenCalled();
    },
  );

  it('does not use a network API or expose raw export failures', async () => {
    const test = harness();
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    test.exporter.export.mockRejectedValueOnce(
      new Error('C:\\private\\vault-path credential-ref provider-id prompt-sentinel'),
    );

    try {
      await expect(test.invoke([{ includeAnonymousPerformanceData: true }]))
        .rejects.toThrow('Unable to export diagnostics.');
      expect(network).not.toHaveBeenCalled();
      expect(JSON.stringify(test.trustedWebContents.send.mock?.calls ?? [])).not.toMatch(
        /vault-path|credential-ref|provider-id|prompt-sentinel/iu,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps a native save failure to the same closed public error', async () => {
    const test = harness();
    test.chooseDestination.mockRejectedValueOnce(
      new Error('C:\\private\\owner provider-id credential-ref'),
    );

    await expect(test.invoke([{ includeAnonymousPerformanceData: false }]))
      .rejects.toThrow('Unable to export diagnostics.');
    expect(test.exporter.export).not.toHaveBeenCalled();
  });
});
