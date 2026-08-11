import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import {
  ProcessSupervisor,
  type ManagedProcessHandle,
} from '../processes/ProcessSupervisor';
import type { PublicIpcRegistrar } from './public-invoke-boundary';

interface TerminalSession {
  id: string;
  process: ManagedProcessHandle;
  owner: WebContents;
  ownerDestroyed: () => void;
}

export interface TerminalIPCDependencies {
  supervisor: ProcessSupervisor;
  /** Must resolve only database-registered projects and reject every other path. */
  resolveProjectPath(projectPath: string): string | Promise<string>;
  environment?: NodeJS.ProcessEnv;
}

const SAFE_ENVIRONMENT_KEYS = new Set([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SHELL',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]);

export function terminalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key.toLocaleUpperCase('en-US'))) {
      safe[key] = value;
    }
  }
  return safe;
}

function send(owner: WebContents, channel: string, ...args: unknown[]): void {
  if (!owner.isDestroyed()) owner.send(channel, ...args);
}

/**
 * Registers supervised terminals. Missing security dependencies fail closed at
 * terminal creation while keeping the old one-argument registration call valid
 * until the main entrypoint is wired.
 */
export function registerTerminalIPC(
  ipcMain: PublicIpcRegistrar,
  dependencies?: TerminalIPCDependencies,
): () => Promise<void> {
  const terminals = new Map<string, TerminalSession>();

  const requireDependencies = (): TerminalIPCDependencies => {
    if (!dependencies) throw new Error('Terminal process supervisor is unavailable.');
    return dependencies;
  };

  const closeTerminal = async (terminalId: string): Promise<void> => {
    const terminal = terminals.get(terminalId);
    if (!terminal) return;
    terminals.delete(terminalId);
    terminal.owner.removeListener('destroyed', terminal.ownerDestroyed);
    const stdin = terminal.process.child.stdin;
    if (stdin && !stdin.destroyed) stdin.end();
    await terminal.process.terminate();
  };

  const create = async (event: IpcMainInvokeEvent, projectPath: string): Promise<string> => {
    const secured = requireDependencies();
    const cwd = await secured.resolveProjectPath(projectPath);
    const id = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const shell = secured.environment?.COMSPEC ?? process.env.COMSPEC ?? 'powershell.exe';
    const managed = await secured.supervisor.spawn({
      id,
      kind: 'terminal',
      command: shell,
      args: [],
      options: {
        cwd,
        env: terminalEnvironment(secured.environment ?? process.env),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    });
    const ownerDestroyed = (): void => { void closeTerminal(id).catch(() => undefined); };
    const terminal: TerminalSession = {
      id,
      process: managed,
      owner: event.sender,
      ownerDestroyed,
    };
    terminals.set(id, terminal);

    managed.child.stdout?.on('data', (data: Buffer) => {
      send(event.sender, `${IPC_CHANNELS.TERMINAL_OUTPUT}:${id}`, data.toString('utf8'));
    });
    managed.child.stderr?.on('data', (data: Buffer) => {
      send(event.sender, `${IPC_CHANNELS.TERMINAL_OUTPUT}:${id}`, data.toString('utf8'));
    });
    managed.child.once('close', (code) => {
      terminals.delete(id);
      event.sender.removeListener('destroyed', ownerDestroyed);
      send(event.sender, `${IPC_CHANNELS.TERMINAL_EXIT}:${id}`, code ?? 0);
    });
    managed.child.once('error', (error) => {
      terminals.delete(id);
      event.sender.removeListener('destroyed', ownerDestroyed);
      send(
        event.sender,
        `${IPC_CHANNELS.TERMINAL_OUTPUT}:${id}`,
        `\x1b[31mError: ${error.message}\x1b[0m\r\n`,
      );
    });
    event.sender.once('destroyed', ownerDestroyed);
    return id;
  };

  ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, create);
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_WRITE,
    async (event, terminalId: string, data: string) => {
      const terminal = terminals.get(terminalId);
      if (!terminal || terminal.owner.id !== event.sender.id) return;
      const stdin = terminal.process.child.stdin;
      if (stdin && !stdin.destroyed) stdin.write(data);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_RESIZE,
    async (event, terminalId: string, _cols: number, _rows: number) => {
      const terminal = terminals.get(terminalId);
      if (!terminal || terminal.owner.id !== event.sender.id) return;
      // ChildProcess pipes are intentionally not presented as a resizable PTY.
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_CLOSE,
    async (event, terminalId: string) => {
      const terminal = terminals.get(terminalId);
      if (!terminal || terminal.owner.id !== event.sender.id) return;
      await closeTerminal(terminalId);
    },
  );

  return async () => {
    ipcMain.removeHandler(IPC_CHANNELS.TERMINAL_CREATE);
    ipcMain.removeHandler(IPC_CHANNELS.TERMINAL_WRITE);
    ipcMain.removeHandler(IPC_CHANNELS.TERMINAL_RESIZE);
    ipcMain.removeHandler(IPC_CHANNELS.TERMINAL_CLOSE);
    const stopped = await Promise.allSettled([...terminals.keys()].map(closeTerminal));
    terminals.clear();
    const failures = stopped.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(failures.map((item) => item.reason), 'One or more terminals did not stop.');
    }
  };
}
