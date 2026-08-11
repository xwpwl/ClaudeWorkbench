import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  ProcessSupervisor,
  type ProcessExitRecord,
  type ProcessStartRecord,
} from '../ProcessSupervisor';

class FakeChild extends EventEmitter {
  readonly pid: number;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { destroyed: false, end: vi.fn(), write: vi.fn() };
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

function harness(options: {
  journalStart?: (record: ProcessStartRecord) => void | Promise<void>;
  journalExit?: (record: ProcessExitRecord) => void | Promise<void>;
  platform?: NodeJS.Platform;
  taskkill?: (pid: number, force: boolean, timeoutMs: number) => Promise<'terminated' | 'not_found'>;
  verify?: () => boolean | Promise<boolean>;
} = {}) {
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const starts: ProcessStartRecord[] = [];
  const exits: ProcessExitRecord[] = [];
  const spawnProcess = vi.fn((command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
    const child = new FakeChild(1000 + children.length);
    children.push(child);
    calls.push({ command, args: [...args], options: spawnOptions });
    return child as unknown as ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
  const supervisor = new ProcessSupervisor({
    spawnProcess,
    platform: options.platform ?? 'linux',
    defaultGraceMs: 0,
    defaultForceMs: 25,
    journal: {
      recordStarted: async (record) => {
        starts.push(record);
        await options.journalStart?.(record);
      },
      recordExited: async (record) => {
        exits.push(record);
        await options.journalExit?.(record);
      },
    },
    taskkill: options.taskkill,
    verifyPersistedIdentity: options.verify,
  });
  return { supervisor, children, calls, starts, exits };
}

describe('ProcessSupervisor', () => {
  it('records start and one terminal record with process ownership metadata', async () => {
    const test = harness();
    const handle = await test.supervisor.spawn({
      id: 'claude-run', kind: 'claude', command: 'claude', args: ['-p', 'redacted'],
      sessionId: 'session-1', taskId: 'task-1', runId: 'run-1',
    });

    test.children[0].emit('close', 7, 'SIGTERM');
    const exit = await handle.waitForExit();

    expect(test.starts[0]).toMatchObject({
      id: 'claude-run', pid: 1000, kind: 'claude', sessionId: 'session-1', taskId: 'task-1',
    });
    expect(exit).toMatchObject({ exitCode: 7, signal: 'SIGTERM' });
    expect(test.exits).toHaveLength(1);
    expect(test.supervisor.getActiveProcesses()).toEqual([]);
    expect(test.starts[0]).not.toHaveProperty('command');
  });

  it('uses TERM and does not force a child that exits during grace', async () => {
    const taskkill = vi.fn(async () => 'terminated' as const);
    const test = harness({ platform: 'win32', taskkill });
    const handle = await test.supervisor.spawn({ kind: 'terminal', command: 'powershell.exe' });
    test.children[0].kill.mockImplementationOnce(() => {
      queueMicrotask(() => test.children[0].emit('close', 0, 'SIGTERM'));
      return true;
    });

    const result = await handle.terminate({ graceMs: 20 });

    expect(result.signal).toBe('SIGTERM');
    expect(test.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(taskkill).not.toHaveBeenCalled();
  });

  it('forces an owned Windows child tree only after the grace deadline', async () => {
    let child: FakeChild;
    const taskkill = vi.fn(async () => {
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      return 'terminated' as const;
    });
    const test = harness({ platform: 'win32', taskkill });
    child = test.children[0] as FakeChild;
    const handle = await test.supervisor.spawn({ kind: 'claude', command: 'claude' });
    child = test.children[0];

    const result = await handle.terminate({ graceMs: 0, forceMs: 25 });

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(taskkill).toHaveBeenCalledWith(child.pid, true, 25);
    expect(result.signal).toBe('SIGKILL');
  });

  it('does not turn a failed live-child signal into a PID-based taskkill', async () => {
    const taskkill = vi.fn(async () => 'terminated' as const);
    const test = harness({ platform: 'win32', taskkill });
    const handle = await test.supervisor.spawn({ kind: 'claude', command: 'claude' });
    test.children[0].kill.mockReturnValueOnce(false);

    await expect(handle.terminate({ graceMs: 0, forceMs: 5 }))
      .rejects.toThrow(/could not be signalled safely/i);
    expect(taskkill).not.toHaveBeenCalled();
  });

  it('fails closed for an old PID without persisted identity', async () => {
    const taskkill = vi.fn(async () => 'terminated' as const);
    const test = harness({ platform: 'win32', taskkill, verify: () => true });

    const result = await test.supervisor.terminatePersisted({
      id: 'old', pid: 55, kind: 'claude', startedAt: new Date().toISOString(),
    });

    expect(result.status).toBe('identity_rejected');
    expect(taskkill).not.toHaveBeenCalled();
  });

  it('does not taskkill an old PID when identity verification fails', async () => {
    const taskkill = vi.fn(async () => 'terminated' as const);
    const test = harness({ platform: 'win32', taskkill, verify: () => false });

    const result = await test.supervisor.terminatePersisted({
      id: 'reused', pid: 66, kind: 'claude', startedAt: new Date().toISOString(),
      identity: { creationTime: 'old-process' },
    });

    expect(result.status).toBe('identity_rejected');
    expect(taskkill).not.toHaveBeenCalled();
  });

  it('allows a verified persisted process to enter the destructive boundary', async () => {
    const taskkill = vi.fn(async () => 'terminated' as const);
    const verify = vi.fn(async () => true);
    const test = harness({ platform: 'win32', taskkill, verify });
    const record = {
      id: 'verified', pid: 77, kind: 'mcp' as const, startedAt: new Date().toISOString(),
      identity: { creationTime: 'exact', executablePath: 'server.exe' },
    };

    await expect(test.supervisor.terminatePersisted(record)).resolves.toMatchObject({
      status: 'terminated',
    });
    expect(verify).toHaveBeenCalledWith(record);
    expect(taskkill).toHaveBeenCalledWith(77, true, 25);
  });

  it('kills and rejects a launch when durable start journaling fails', async () => {
    const test = harness({ journalStart: () => { throw new Error('database closed'); } });

    await expect(test.supervisor.spawn({ kind: 'claude', command: 'claude' }))
      .rejects.toThrow(/journal rejected launch/i);
    expect(test.children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(test.supervisor.getActiveProcesses()).toEqual([]);
  });

  it('keeps command arguments and environment out of journal records', async () => {
    const test = harness();
    await test.supervisor.spawn({
      kind: 'terminal', command: 'powershell.exe', args: ['secret'],
      options: { env: { ANTHROPIC_API_KEY: 'secret' } },
    });

    expect(JSON.stringify(test.starts)).not.toContain('secret');
    expect(JSON.stringify(test.starts)).not.toContain('ANTHROPIC');
  });
});
