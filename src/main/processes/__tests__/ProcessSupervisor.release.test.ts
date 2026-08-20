import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  ProcessSupervisor,
  type PersistedProcessRecord,
  type ProcessExitRecord,
  type ProcessStartRecord,
} from '../ProcessSupervisor';

class ReleaseFakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { destroyed: false, end: vi.fn(), write: vi.fn() };
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);

  constructor(readonly pid: number) {
    super();
  }
}

interface HarnessOptions {
  platform?: NodeJS.Platform;
  pid?: number;
  now?: () => Date;
  verify?: (record: PersistedProcessRecord) => boolean | Promise<boolean>;
  taskkill?: (pid: number, force: boolean, timeoutMs: number) => Promise<'terminated' | 'not_found'>;
}

function releaseHarness(options: HarnessOptions = {}) {
  const children: ReleaseFakeChild[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const starts: ProcessStartRecord[] = [];
  const exits: ProcessExitRecord[] = [];
  const spawnProcess = vi.fn((command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
    const child = new ReleaseFakeChild(options.pid ?? 4_000 + children.length);
    children.push(child);
    spawnCalls.push({ command, args: [...args], options: spawnOptions });
    return child as unknown as ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
  const supervisor = new ProcessSupervisor({
    spawnProcess,
    platform: options.platform ?? 'linux',
    defaultGraceMs: 0,
    defaultForceMs: 25,
    now: options.now,
    verifyPersistedIdentity: options.verify,
    taskkill: options.taskkill,
    journal: {
      recordStarted: (record) => { starts.push(record); },
      recordExited: (record) => { exits.push(record); },
    },
  });
  return { supervisor, children, spawnCalls, starts, exits };
}

const kinds = ['claude', 'mcp', 'terminal'] as const;

describe('ProcessSupervisor release boundaries', () => {
  it.each(kinds)('journals %s ownership metadata without launch secrets', async (kind) => {
    const test = releaseHarness();
    const secret = `SENTINEL-${kind}-DO-NOT-JOURNAL`;
    const handle = await test.supervisor.spawn({
      id: `owned-${kind}`,
      kind,
      command: `secret-command-${secret}`,
      args: ['--token', secret],
      options: { env: { RELEASE_SECRET: secret }, cwd: 'C:\\safe-workspace' },
      sessionId: 'session-release',
      taskId: 'task-release',
      runId: 'run-release',
    });

    const journalJson = JSON.stringify(test.starts);
    expect(test.starts[0]).toMatchObject({
      id: `owned-${kind}`,
      kind,
      sessionId: 'session-release',
      taskId: 'task-release',
      runId: 'run-release',
    });
    expect(journalJson).not.toContain(secret);
    expect(journalJson).not.toContain('command');
    expect(journalJson).not.toContain('args');
    expect(journalJson).not.toContain('env');

    test.children[0].emit('close', 0, null);
    await handle.waitForExit();
  });

  it('always disables shell interpretation while preserving explicit spawn options', async () => {
    const test = releaseHarness();
    const handle = await test.supervisor.spawn({
      kind: 'terminal',
      command: 'powershell.exe',
      args: ['-NoProfile'],
      options: { shell: true, windowsHide: true, cwd: 'C:\\workspace' },
    });

    expect(test.spawnCalls[0]).toEqual({
      command: 'powershell.exe',
      args: ['-NoProfile'],
      options: expect.objectContaining({ shell: false, windowsHide: true, cwd: 'C:\\workspace' }),
    });
    test.children[0].emit('close', 0, null);
    await handle.waitForExit();
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['claude\0.exe', 'NUL-containing'],
  ])('rejects a %s command before spawning (%s)', async (command) => {
    const test = releaseHarness();
    await expect(test.supervisor.spawn({ kind: 'claude', command })).rejects.toThrow(/command is invalid/i);
    expect(test.children).toHaveLength(0);
  });

  it.each([
    ['unsafe\0id', 'NUL-containing'],
    ['x'.repeat(513), 'oversized'],
  ])('rejects a %s managed id before spawning (%s)', async (id) => {
    const test = releaseHarness();
    await expect(test.supervisor.spawn({ id, kind: 'mcp', command: 'server.exe' })).rejects.toThrow(/invalid managed process id/i);
    expect(test.children).toHaveLength(0);
  });

  it('rejects duplicate live process ids without launching a second child', async () => {
    const test = releaseHarness();
    const first = await test.supervisor.spawn({ id: 'stable-id', kind: 'mcp', command: 'server.exe' });

    await expect(test.supervisor.spawn({ id: 'stable-id', kind: 'terminal', command: 'pwsh.exe' }))
      .rejects.toThrow(/already active/i);
    expect(test.children).toHaveLength(1);

    test.children[0].emit('close', 0, null);
    await first.waitForExit();
  });

  it('kills and rejects a spawn result that has no usable PID', async () => {
    const test = releaseHarness({ pid: 0 });

    await expect(test.supervisor.spawn({ kind: 'claude', command: 'claude.exe' }))
      .rejects.toThrow(/did not provide a PID/i);
    expect(test.children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(test.starts).toEqual([]);
  });

  it.each([
    [0, null],
    [2, null],
    [null, 'SIGTERM'],
  ] as const)('records one terminal state for close(%s, %s)', async (exitCode, signal) => {
    const test = releaseHarness();
    const handle = await test.supervisor.spawn({ kind: 'claude', command: 'claude.exe' });
    test.children[0].emit('close', exitCode, signal);

    await expect(handle.waitForExit()).resolves.toMatchObject({ exitCode, signal });
    expect(test.exits).toHaveLength(1);
    expect(test.supervisor.getActiveProcesses()).toEqual([]);
  });

  it('turns a child error into one failed terminal record without leaking duplicate close events', async () => {
    const test = releaseHarness();
    const handle = await test.supervisor.spawn({ kind: 'mcp', command: 'server.exe' });
    test.children[0].emit('error', new Error('spawn EACCES'));
    test.children[0].emit('close', 1, null);

    await expect(handle.waitForExit()).resolves.toMatchObject({
      exitCode: null,
      signal: null,
      error: 'spawn EACCES',
    });
    expect(test.exits).toHaveLength(1);
  });

  it('computes a non-negative lifecycle duration from the injected clock', async () => {
    const times = [
      new Date('2026-08-01T00:00:10.000Z'),
      new Date('2026-08-01T00:00:12.250Z'),
    ];
    const test = releaseHarness({ now: () => times.shift() ?? new Date('2026-08-01T00:00:12.250Z') });
    const handle = await test.supervisor.spawn({ kind: 'terminal', command: 'pwsh.exe' });
    test.children[0].emit('close', 0, null);

    await expect(handle.waitForExit()).resolves.toMatchObject({ durationMs: 2_250 });
  });

  it('force-kills a still-running owned child on non-Windows after the grace phase', async () => {
    const test = releaseHarness({ platform: 'linux' });
    const handle = await test.supervisor.spawn({ kind: 'terminal', command: 'sh' });
    test.children[0].kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') queueMicrotask(() => test.children[0].emit('close', null, 'SIGKILL'));
      return true;
    });

    await expect(handle.terminate({ graceMs: 0, forceMs: 25 })).resolves.toMatchObject({ signal: 'SIGKILL' });
    expect(test.children[0].kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('preserves Windows tree termination for close-only ownership', async () => {
    let child: ReleaseFakeChild;
    const taskkill = vi.fn(async () => {
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      return 'terminated' as const;
    });
    const test = releaseHarness({ platform: 'win32', taskkill });
    child = test.children[0] as ReleaseFakeChild;
    const handle = await test.supervisor.spawn({
      kind: 'claude', command: 'claude.exe', settlement: 'close-only',
    });
    child = test.children[0];

    await expect(handle.terminate({ graceMs: 0, forceMs: 25 })).resolves.toMatchObject({
      signal: 'SIGKILL',
    });
    expect(taskkill).toHaveBeenCalledWith(child.pid, true, 25);
  });

  it('terminates all Claude, MCP, and Terminal children and empties the active registry', async () => {
    const test = releaseHarness();
    await Promise.all(kinds.map((kind) => test.supervisor.spawn({ id: kind, kind, command: `${kind}.exe` })));
    for (const child of test.children) {
      child.kill.mockImplementationOnce(() => {
        queueMicrotask(() => child.emit('close', 0, 'SIGTERM'));
        return true;
      });
    }

    const results = await test.supervisor.terminateAll({ graceMs: 25 });

    expect(results).toHaveLength(3);
    expect(test.exits).toHaveLength(3);
    expect(test.supervisor.getActiveProcesses()).toEqual([]);
  });

  it('refuses to terminate an id outside its live ownership registry', async () => {
    const test = releaseHarness();
    await expect(test.supervisor.terminate('not-owned')).rejects.toThrow(/not active/i);
  });

  it.each([-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe persisted PID %s before identity verification',
    async (pid) => {
      const verify = vi.fn(() => true);
      const taskkill = vi.fn(async () => 'terminated' as const);
      const test = releaseHarness({ platform: 'win32', verify, taskkill });

      await expect(test.supervisor.terminatePersisted({
        id: 'old-child',
        pid,
        kind: 'claude',
        startedAt: '2026-08-01T00:00:00.000Z',
        identity: { creationTime: 'exact' },
      })).resolves.toMatchObject({ status: 'identity_rejected' });
      expect(verify).not.toHaveBeenCalled();
      expect(taskkill).not.toHaveBeenCalled();
    },
  );

  it('rejects a persisted PID when no platform identity verifier is installed', async () => {
    const taskkill = vi.fn(async () => 'terminated' as const);
    const test = releaseHarness({ platform: 'win32', taskkill });

    await expect(test.supervisor.terminatePersisted({
      id: 'unverifiable',
      pid: 912,
      kind: 'terminal',
      startedAt: '2026-08-01T00:00:00.000Z',
      identity: { creationTime: 'exact', executablePath: 'pwsh.exe' },
    })).resolves.toMatchObject({ status: 'identity_rejected' });
    expect(taskkill).not.toHaveBeenCalled();
  });

  it.each(['terminated', 'not_found'] as const)(
    'returns the verified Windows orphan cleanup result: %s',
    async (status) => {
      const taskkill = vi.fn(async () => status);
      const verify = vi.fn(async () => true);
      const test = releaseHarness({ platform: 'win32', verify, taskkill });
      const record: PersistedProcessRecord = {
        id: `orphan-${status}`,
        pid: 913,
        kind: 'mcp',
        startedAt: '2026-08-01T00:00:00.000Z',
        identity: { creationTime: 'exact', executablePath: 'server.exe' },
      };

      await expect(test.supervisor.terminatePersisted(record, { forceMs: 50 }))
        .resolves.toEqual({ id: record.id, pid: record.pid, status });
      expect(verify).toHaveBeenCalledOnce();
      expect(taskkill).toHaveBeenCalledWith(913, true, 50);
    },
  );

  it('propagates identity-verifier errors without reaching the destructive PID sink', async () => {
    const taskkill = vi.fn(async () => 'terminated' as const);
    const test = releaseHarness({
      platform: 'win32',
      verify: () => { throw new Error('identity service unavailable'); },
      taskkill,
    });

    await expect(test.supervisor.terminatePersisted({
      id: 'orphan-error',
      pid: 914,
      kind: 'claude',
      startedAt: '2026-08-01T00:00:00.000Z',
      identity: { creationTime: 'exact' },
    })).rejects.toThrow(/identity service unavailable/i);
    expect(taskkill).not.toHaveBeenCalled();
  });
});
