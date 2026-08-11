import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import type { ManagedProcessHandle, ProcessSupervisor } from '../../processes/ProcessSupervisor';
import { registerTerminalIPC, terminalEnvironment } from '../terminal';

type Handler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown;

class FakeChild extends EventEmitter {
  readonly pid = 1234;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { destroyed: false, end: vi.fn(), write: vi.fn() };
  readonly kill = vi.fn(() => true);
}

class FakeWebContents extends EventEmitter {
  readonly id: number;
  readonly send = vi.fn();
  private destroyed = false;

  constructor(id: number) {
    super();
    this.id = id;
  }

  isDestroyed(): boolean { return this.destroyed; }
}

function harness() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  } as unknown as IpcMain;
  const child = new FakeChild();
  const terminate = vi.fn(async () => ({
    id: 'terminal', pid: child.pid, kind: 'terminal' as const,
    startedAt: new Date(0).toISOString(), endedAt: new Date(1).toISOString(),
    exitCode: 0, signal: null, durationMs: 1,
  }));
  const handle: ManagedProcessHandle = {
    id: 'terminal', pid: child.pid, child: child as unknown as ChildProcess,
    startedAt: new Date(0).toISOString(),
    waitForExit: vi.fn(),
    terminate,
  };
  const spawn = vi.fn(async () => handle);
  const supervisor = { spawn } as unknown as ProcessSupervisor;
  const owner = new FakeWebContents(1);
  const other = new FakeWebContents(2);
  const event = (sender: FakeWebContents) => ({ sender }) as unknown as IpcMainInvokeEvent;
  return { handlers, ipcMain, child, terminate, spawn, supervisor, owner, other, event };
}

describe('terminal IPC process boundary', () => {
  it('allowlists terminal environment without Anthropic or Workbench credentials', () => {
    const safe = terminalEnvironment({
      PATH: 'safe-path',
      USERPROFILE: 'profile',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      ANTHROPIC_AUTH_TOKEN: 'auth-secret',
      CLAUDE_WORKBENCH_PERMISSION_TOKEN: 'broker-secret',
      NODE_OPTIONS: '--require malicious.js',
    });

    expect(safe).toEqual({ PATH: 'safe-path', USERPROFILE: 'profile' });
    expect(JSON.stringify(safe)).not.toContain('secret');
  });

  it('fails closed when the supervisor and registered-project resolver are not wired', async () => {
    const test = harness();
    registerTerminalIPC(test.ipcMain);
    const create = test.handlers.get(IPC_CHANNELS.TERMINAL_CREATE) as Handler;

    await expect(create(test.event(test.owner), 'C:\\unregistered'))
      .rejects.toThrow(/supervisor is unavailable/i);
  });

  it('resolves a registered project before spawning and scopes IO to the owning renderer', async () => {
    const test = harness();
    const resolveProjectPath = vi.fn(async () => 'C:\\registered-project');
    const dispose = registerTerminalIPC(test.ipcMain, {
      supervisor: test.supervisor,
      resolveProjectPath,
      environment: {
        COMSPEC: 'powershell.exe', PATH: 'safe-path', ANTHROPIC_API_KEY: 'secret',
      },
    });
    const create = test.handlers.get(IPC_CHANNELS.TERMINAL_CREATE) as Handler;
    const terminalId = await create(test.event(test.owner), 'C:\\requested') as string;

    expect(resolveProjectPath).toHaveBeenCalledWith('C:\\requested');
    expect(test.spawn).toHaveBeenCalledWith(expect.objectContaining({
      id: terminalId,
      kind: 'terminal',
      command: 'powershell.exe',
      options: expect.objectContaining({
        cwd: 'C:\\registered-project',
        env: { COMSPEC: 'powershell.exe', PATH: 'safe-path' },
      }),
    }));

    const write = test.handlers.get(IPC_CHANNELS.TERMINAL_WRITE) as Handler;
    await write(test.event(test.other), terminalId, 'untrusted');
    expect(test.child.stdin.write).not.toHaveBeenCalled();
    await write(test.event(test.owner), terminalId, 'dir');
    expect(test.child.stdin.write).toHaveBeenCalledWith('dir');

    test.child.stdout.emit('data', Buffer.from('output'));
    expect(test.owner.send).toHaveBeenCalledWith(
      `${IPC_CHANNELS.TERMINAL_OUTPUT}:${terminalId}`,
      'output',
    );
    await dispose();
    expect(test.terminate).toHaveBeenCalledOnce();
    expect(test.ipcMain.removeHandler).toHaveBeenCalledTimes(4);
  });
});
