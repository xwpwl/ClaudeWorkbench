import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  ManagedProcessCleanupUnconfirmedError,
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
  synchronousJournalStart?: boolean;
  journalExit?: (record: ProcessExitRecord) => void | Promise<void>;
  platform?: NodeJS.Platform;
  pid?: number;
  taskkill?: (pid: number, force: boolean, timeoutMs: number) => Promise<'terminated' | 'not_found'>;
  verify?: () => boolean | Promise<boolean>;
} = {}) {
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const starts: ProcessStartRecord[] = [];
  const exits: ProcessExitRecord[] = [];
  const spawnProcess = vi.fn((command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
    const child = new FakeChild(options.pid ?? 1000 + children.length);
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
      recordStarted: options.synchronousJournalStart
        ? (record) => {
          starts.push(record);
          options.journalStart?.(record);
        }
        : async (record) => {
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

  it('keeps close-only ownership after error until close', async () => {
    const test = harness();
    const handle = await test.supervisor.spawn({
      id: 'update',
      kind: 'claude',
      command: 'claude-test',
      settlement: 'close-only',
      closeTimeoutMs: 50,
    });
    const child = test.children[0];
    child.emit('error', new Error('spawn-sentinel'));

    expect(test.supervisor.getActiveProcesses()).toHaveLength(1);
    let settled = false;
    void handle.waitForExit().finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('close', null, null);
    await expect(handle.waitForExit()).resolves.toMatchObject({
      error: 'spawn-sentinel',
    });
    expect(test.supervisor.getActiveProcesses()).toEqual([]);
  });

  it('observes repeated close-only errors until close and records the first error', async () => {
    const test = harness();
    const handle = await test.supervisor.spawn({
      id: 'repeated-errors', kind: 'claude', command: 'claude-test', settlement: 'close-only',
    });
    const child = test.children[0];

    child.emit('error', new Error('first-error'));
    expect(child.listenerCount('error')).toBe(1);
    expect(() => child.emit('error', new Error('second-error'))).not.toThrow();
    expect(test.supervisor.getActiveProcesses()).toHaveLength(1);

    child.emit('close', null, null);
    await expect(handle.waitForExit()).resolves.toMatchObject({ error: 'first-error' });
    expect(child.listenerCount('error')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('keeps error-or-close settlement as the default', async () => {
    const test = harness();
    const handle = await test.supervisor.spawn({
      id: 'default-settlement', kind: 'claude', command: 'claude-test',
    });

    test.children[0].emit('error', new Error('default-error'));

    await expect(handle.waitForExit()).resolves.toMatchObject({ error: 'default-error' });
    expect(test.supervisor.getActiveProcesses()).toEqual([]);
  });

  it('waits for raw close before rejecting a close-only launch without a PID', async () => {
    vi.useFakeTimers();
    try {
      const test = harness({ pid: 0 });
      const spawning = test.supervisor.spawn({
        kind: 'claude', command: 'missing-pid-secret', args: ['secret-argv'],
        options: { env: { SECRET_ENV: 'secret-env' }, cwd: 'C:\\secret-path' },
        settlement: 'close-only', closeTimeoutMs: 50,
      });
      let settled = false;
      void spawning.finally(() => { settled = true; }).catch(() => undefined);
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(test.children[0].kill).toHaveBeenCalledWith('SIGKILL');
      expect(test.children[0].listenerCount('close')).toBe(1);
      test.children[0].emit('close', null, 'SIGKILL');

      await expect(spawning).rejects.toThrow(/did not provide a PID/i);
      expect(test.children[0].listenerCount('close')).toBe(0);
      expect(test.children[0].listenerCount('error')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes repeated missing-PID errors until raw close', async () => {
    vi.useFakeTimers();
    try {
      const test = harness({ pid: 0 });
      const spawning = test.supervisor.spawn({
        kind: 'claude', command: 'claude-test', settlement: 'close-only', closeTimeoutMs: 50,
      });
      void spawning.catch(() => undefined);
      await Promise.resolve();

      test.children[0].emit('error', new Error('first-missing-pid-error'));
      expect(test.children[0].listenerCount('error')).toBe(1);
      expect(() => test.children[0].emit('error', new Error('second-missing-pid-error'))).not.toThrow();
      test.children[0].emit('close', null, 'SIGKILL');

      await expect(spawning).rejects.toThrow(/did not provide a PID/i);
      expect(test.children[0].listenerCount('error')).toBe(0);
      expect(test.children[0].listenerCount('close')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for raw close before rejecting a close-only launch whose start journal fails', async () => {
    vi.useFakeTimers();
    try {
      const test = harness({ journalStart: () => { throw new Error('database closed'); } });
      const spawning = test.supervisor.spawn({
        id: 'journal-failure', kind: 'claude', command: 'claude-test',
        settlement: 'close-only', closeTimeoutMs: 50,
      });
      let settled = false;
      void spawning.finally(() => { settled = true; }).catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(test.children[0].kill).toHaveBeenCalledWith('SIGKILL');
      test.children[0].emit('close', null, 'SIGKILL');

      await expect(spawning).rejects.toThrow(/journal rejected launch/i);
      expect(test.children[0].listenerCount('close')).toBe(0);
      expect(test.children[0].listenerCount('error')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('transfers missing-PID cleanup through one opaque idempotent capability', async () => {
    vi.useFakeTimers();
    try {
      const test = harness({ pid: 0 });
      const spawning = test.supervisor.spawn({
        kind: 'claude', command: 'missing-pid-secret', args: ['secret-argv'],
        options: { env: { SECRET_ENV: 'secret-env' }, cwd: 'C:\\secret-path' },
        settlement: 'close-only', closeTimeoutMs: 25,
      });
      const captured = spawning.catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(25);

      const error = await captured as Error & {
        code?: string;
        cleanup?: { retryCleanup(options?: { forceMs?: number }): Promise<void> };
      };
      expect(error).toBeInstanceOf(ManagedProcessCleanupUnconfirmedError);
      expect(error.code).toBe('MANAGED_PROCESS_CLEANUP_UNCONFIRMED');
      expect(Reflect.ownKeys(error.cleanup ?? {})).toEqual(['retryCleanup']);
      for (const forbidden of ['child', 'pid', 'kill', 'terminate', 'command', 'args', 'argv', 'env', 'environment', 'cwd', 'path']) {
        expect(error).not.toHaveProperty(forbidden);
        expect(error.cleanup).not.toHaveProperty(forbidden);
      }

      const firstRetry = error.cleanup!.retryCleanup({ forceMs: 40 });
      const concurrentRetry = error.cleanup!.retryCleanup({ forceMs: 40 });
      expect(test.children[0].kill).toHaveBeenCalledTimes(2);
      test.children[0].emit('close', null, 'SIGKILL');
      await expect(Promise.all([firstRetry, concurrentRetry])).resolves.toEqual([undefined, undefined]);

      await expect(error.cleanup!.retryCleanup({ forceMs: 40 })).resolves.toBeUndefined();
      expect(test.children[0].kill).toHaveBeenCalledTimes(2);
      expect(test.children[0].listenerCount('close')).toBe(0);
      expect(test.children[0].listenerCount('error')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('transfers failed-journal cleanup through one opaque idempotent capability', async () => {
    vi.useFakeTimers();
    try {
      const test = harness({ journalStart: () => { throw new Error('journal-secret'); } });
      const spawning = test.supervisor.spawn({
        id: 'journal-cleanup', kind: 'claude', command: 'command-secret', args: ['argv-secret'],
        options: { env: { TOKEN: 'env-secret' }, cwd: 'C:\\path-secret' },
        settlement: 'close-only', closeTimeoutMs: 25,
      });
      const captured = spawning.catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(25);

      const error = await captured as Error & {
        code?: string;
        cleanup?: { retryCleanup(options?: { forceMs?: number }): Promise<void> };
      };
      expect(error).toBeInstanceOf(ManagedProcessCleanupUnconfirmedError);
      expect(error.code).toBe('MANAGED_PROCESS_CLEANUP_UNCONFIRMED');
      expect(Reflect.ownKeys(error.cleanup ?? {})).toEqual(['retryCleanup']);
      for (const forbidden of ['child', 'pid', 'kill', 'terminate', 'command', 'args', 'argv', 'env', 'environment', 'cwd', 'path']) {
        expect(error).not.toHaveProperty(forbidden);
        expect(error.cleanup).not.toHaveProperty(forbidden);
      }

      const retry = error.cleanup!.retryCleanup({ forceMs: 40 });
      expect(test.children[0].kill).toHaveBeenCalledTimes(2);
      test.children[0].emit('close', null, 'SIGKILL');
      await expect(retry).resolves.toBeUndefined();
      await expect(error.cleanup!.retryCleanup()).resolves.toBeUndefined();
      expect(test.children[0].kill).toHaveBeenCalledTimes(2);
      expect(test.children[0].listenerCount('close')).toBe(0);
      expect(test.children[0].listenerCount('error')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('transfers synchronous start-journal failure cleanup without losing child ownership', async () => {
    vi.useFakeTimers();
    try {
      const test = harness({
        synchronousJournalStart: true,
        journalStart: () => { throw new Error('synchronous-journal-secret'); },
      });
      const spawning = test.supervisor.spawn({
        id: 'synchronous-journal-cleanup',
        kind: 'claude',
        command: 'command-secret',
        args: ['argv-secret'],
        options: { env: { TOKEN: 'env-secret' }, cwd: 'C:\\path-secret' },
        settlement: 'close-only',
        closeTimeoutMs: 25,
      });
      const captured = spawning.catch((caught: unknown) => caught);
      await Promise.resolve();

      expect(test.children[0].kill).toHaveBeenCalledWith('SIGKILL');
      await vi.advanceTimersByTimeAsync(24);
      let settled = false;
      void captured.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const error = await captured as Error & {
        code?: string;
        cleanup?: { retryCleanup(options?: { forceMs?: number }): Promise<void> };
      };
      expect(error).toBeInstanceOf(ManagedProcessCleanupUnconfirmedError);
      expect(error.code).toBe('MANAGED_PROCESS_CLEANUP_UNCONFIRMED');
      expect(Reflect.ownKeys(error.cleanup ?? {})).toEqual(['retryCleanup']);
      for (const forbidden of ['child', 'pid', 'kill', 'terminate', 'command', 'args', 'argv', 'env', 'environment', 'cwd', 'path']) {
        expect(error).not.toHaveProperty(forbidden);
        expect(error.cleanup).not.toHaveProperty(forbidden);
      }

      const firstRetry = error.cleanup!.retryCleanup({ forceMs: 40 });
      const concurrentRetry = error.cleanup!.retryCleanup({ forceMs: 40 });
      expect(test.children[0].kill).toHaveBeenCalledTimes(2);
      test.children[0].emit('close', null, 'SIGKILL');
      await expect(Promise.all([firstRetry, concurrentRetry])).resolves.toEqual([undefined, undefined]);
      await expect(error.cleanup!.retryCleanup()).resolves.toBeUndefined();
      expect(test.children[0].kill).toHaveBeenCalledTimes(2);
      expect(test.children[0].listenerCount('error')).toBe(0);
      expect(test.children[0].listenerCount('close')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['the default', undefined, 5_000],
    ['a non-finite value', Number.POSITIVE_INFINITY, 5_000],
    ['a negative value', -10, 0],
    ['a fractional value', 10.9, 10],
    ['an oversized value', 60_001, 60_000],
  ] as const)('bounds %s close-only cleanup delay', async (_label, closeTimeoutMs, expectedDelay) => {
    vi.useFakeTimers();
    try {
      const test = harness({ pid: 0 });
      const spawning = test.supervisor.spawn({
        kind: 'claude', command: 'claude-test', settlement: 'close-only', closeTimeoutMs,
      });
      const captured = spawning.catch((caught: unknown) => caught);

      if (expectedDelay > 0) {
        let settled = false;
        void captured.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(expectedDelay - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      } else {
        await vi.advanceTimersByTimeAsync(0);
      }

      await expect(captured).resolves.toMatchObject({
        code: 'MANAGED_PROCESS_CLEANUP_UNCONFIRMED',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a returned close-only handle reusable after termination cannot confirm close', async () => {
    vi.useFakeTimers();
    try {
      const test = harness();
      const handle = await test.supervisor.spawn({
        id: 'reusable-update', kind: 'claude', command: 'claude-test', settlement: 'close-only',
      });
      const firstTermination = handle.terminate({ graceMs: 0, forceMs: 25 });
      const firstTerminationAssertion = expect(firstTermination)
        .rejects.toThrow(/did not exit after force termination/i);
      await vi.advanceTimersByTimeAsync(25);

      await firstTerminationAssertion;
      expect(test.supervisor.getActiveProcesses()).toHaveLength(1);

      test.children[0].kill.mockImplementationOnce(() => {
        queueMicrotask(() => test.children[0].emit('close', null, 'SIGTERM'));
        return true;
      });
      await expect(handle.terminate({ graceMs: 25, forceMs: 25 })).resolves.toMatchObject({
        signal: 'SIGTERM',
      });
      expect(test.supervisor.getActiveProcesses()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
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
