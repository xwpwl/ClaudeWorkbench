import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type ManagedProcessKind = 'claude' | 'mcp' | 'terminal';
export type ManagedProcessSettlement = 'error-or-close' | 'close-only';

export interface ManagedProcessRequest {
  id?: string;
  kind: ManagedProcessKind;
  command: string;
  args?: readonly string[];
  options?: SpawnOptions;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  settlement?: ManagedProcessSettlement;
  closeTimeoutMs?: number;
}

export interface ProcessStartRecord {
  id: string;
  pid: number;
  kind: ManagedProcessKind;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  startedAt: string;
}

export interface ProcessExitRecord extends ProcessStartRecord {
  endedAt: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  error?: string;
}

export interface ProcessJournalStore {
  recordStarted(record: ProcessStartRecord): void | Promise<void>;
  recordExited(record: ProcessExitRecord): void | Promise<void>;
}

export interface PersistedProcessRecord extends ProcessStartRecord {
  /** Opaque identity captured by a platform-specific journal implementation. */
  identity?: Readonly<Record<string, unknown>>;
}

export interface PersistedTerminationResult {
  id: string;
  pid: number;
  status: 'terminated' | 'identity_rejected' | 'not_found';
}

export interface ProcessTerminationOptions {
  graceMs?: number;
  forceMs?: number;
}

export interface ManagedProcessCleanupCapability {
  retryCleanup(options?: ProcessTerminationOptions): Promise<void>;
}

export type ManagedProcessLaunchFailureReason =
  | 'permission_denied'
  | 'launch_failed';

export class ManagedProcessLaunchError extends Error {
  readonly reason: ManagedProcessLaunchFailureReason;

  constructor(reason: ManagedProcessLaunchFailureReason) {
    super('Managed process launch failed.');
    Object.defineProperty(this, 'name', {
      value: 'ManagedProcessLaunchError',
      configurable: true,
    });
    this.reason = reason;
  }
}

export class ManagedProcessCleanupUnconfirmedError extends Error {
  readonly code = 'MANAGED_PROCESS_CLEANUP_UNCONFIRMED';
  readonly cleanup: ManagedProcessCleanupCapability;

  constructor(cleanup: ManagedProcessCleanupCapability) {
    super('Managed process cleanup could not be confirmed.');
    this.name = 'ManagedProcessCleanupUnconfirmedError';
    this.cleanup = cleanup;
  }
}

export interface ManagedProcessHandle {
  readonly id: string;
  readonly pid: number;
  readonly child: ChildProcess;
  readonly startedAt: string;
  waitForExit(): Promise<ProcessExitRecord>;
  terminate(options?: ProcessTerminationOptions): Promise<ProcessExitRecord>;
}

export interface ProcessSupervisorOptions {
  journal?: ProcessJournalStore;
  spawnProcess?: typeof spawn;
  now?: () => Date;
  randomUUID?: () => string;
  platform?: NodeJS.Platform;
  defaultGraceMs?: number;
  defaultForceMs?: number;
  /**
   * Persisted PIDs are never trusted by default. A platform implementation must
   * compare immutable process identity (for example creation time and exe path).
   */
  verifyPersistedIdentity?: (record: PersistedProcessRecord) => boolean | Promise<boolean>;
  taskkill?: (pid: number, force: boolean, timeoutMs: number) => Promise<'terminated' | 'not_found'>;
}

interface ActiveProcess {
  start: ProcessStartRecord;
  child: ChildProcess;
  exit: Promise<ProcessExitRecord>;
  resolveExit: (record: ProcessExitRecord) => void;
  rejectExit: (error: unknown) => void;
  terminal: ProcessExitRecord | null;
  startJournal: Promise<void>;
  pendingError: unknown | undefined;
  settlement: ManagedProcessSettlement;
}

interface RawCloseConfirmation {
  isClosed(): boolean;
  wait(timeoutMs: number): Promise<boolean>;
  launchFailureReason(): ManagedProcessLaunchFailureReason;
}

const NULL_JOURNAL: ProcessJournalStore = {
  recordStarted: () => undefined,
  recordExited: () => undefined,
};

function boundedDelay(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(60_000, Math.floor(value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
}

function observeRawClose(child: ChildProcess, observeError: boolean): RawCloseConfirmation {
  let closed = false;
  let launchFailureReason: ManagedProcessLaunchFailureReason = 'launch_failed';
  const waiters = new Set<(confirmed: boolean) => void>();
  const onError = (error: unknown): void => {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && ((error as { code?: unknown }).code === 'EACCES'
        || (error as { code?: unknown }).code === 'EPERM')
    ) {
      launchFailureReason = 'permission_denied';
    }
  };
  const onClose = (): void => {
    closed = true;
    child.removeListener('close', onClose);
    if (observeError) child.removeListener('error', onError);
    for (const finish of waiters) finish(true);
    waiters.clear();
  };
  child.once('close', onClose);
  if (observeError) child.on('error', onError);

  return {
    isClosed: () => closed,
    launchFailureReason: () => launchFailureReason,
    wait: (timeoutMs) => {
      if (closed) return Promise.resolve(true);
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = (confirmed: boolean): void => {
          waiters.delete(finish);
          clearTimeout(timer);
          resolve(confirmed);
        };
        waiters.add(finish);
        timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        if (closed) finish(true);
      });
    },
  };
}

/**
 * Owns every Workbench-managed long-lived child process.
 *
 * Live ChildProcess objects may be terminated in two phases. PIDs loaded from
 * storage are a different trust domain: they are rejected unless an injected
 * platform verifier proves that the PID still denotes the recorded process.
 */
export class ProcessSupervisor {
  private readonly journal: ProcessJournalStore;
  private readonly spawnProcess: typeof spawn;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly platform: NodeJS.Platform;
  private readonly defaultGraceMs: number;
  private readonly defaultForceMs: number;
  private readonly verifyPersistedIdentity?: ProcessSupervisorOptions['verifyPersistedIdentity'];
  private readonly taskkill: NonNullable<ProcessSupervisorOptions['taskkill']>;
  private readonly active = new Map<string, ActiveProcess>();

  constructor(options: ProcessSupervisorOptions = {}) {
    this.journal = options.journal ?? NULL_JOURNAL;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomUUID ?? randomUUID;
    this.platform = options.platform ?? process.platform;
    this.defaultGraceMs = boundedDelay(options.defaultGraceMs, 1_500);
    this.defaultForceMs = boundedDelay(options.defaultForceMs, 5_000);
    this.verifyPersistedIdentity = options.verifyPersistedIdentity;
    this.taskkill = options.taskkill ?? ((pid, force, timeoutMs) => (
      this.runWindowsTaskkill(pid, force, timeoutMs)
    ));
  }

  async spawn(request: ManagedProcessRequest): Promise<ManagedProcessHandle> {
    const id = request.id?.trim() || this.randomId();
    if (!id || id.length > 512 || id.includes('\0')) throw new Error('Invalid managed process id.');
    if (this.active.has(id)) throw new Error(`Managed process is already active: ${id}`);
    if (!request.command.trim() || request.command.includes('\0')) {
      throw new Error('Managed process command is invalid.');
    }

    const settlement = request.settlement ?? 'error-or-close';
    const closeTimeoutMs = boundedDelay(request.closeTimeoutMs, 5_000);
    const child = this.spawnProcess(request.command, [...(request.args ?? [])], {
      ...request.options,
      shell: false,
    });
    const rawClose = settlement === 'close-only'
      ? observeRawClose(child, !child.pid)
      : undefined;
    if (!child.pid) {
      // Node reports asynchronous spawn failures through `error`; keep that
      // event observed even though the missing PID already fails this launch.
      if (!rawClose) child.once('error', () => undefined);
      child.kill('SIGKILL');
      if (rawClose && !await rawClose.wait(closeTimeoutMs)) {
        throw new ManagedProcessCleanupUnconfirmedError(
          this.cleanupCapability(child, rawClose, closeTimeoutMs),
        );
      }
      if (rawClose) {
        throw new ManagedProcessLaunchError(rawClose.launchFailureReason());
      }
      throw new Error('Managed process did not provide a PID.');
    }

    const start: ProcessStartRecord = {
      id,
      pid: child.pid,
      kind: request.kind,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.runId ? { runId: request.runId } : {}),
      startedAt: this.now().toISOString(),
    };
    let resolveExit: (record: ProcessExitRecord) => void = () => undefined;
    let rejectExit: (error: unknown) => void = () => undefined;
    const exit = new Promise<ProcessExitRecord>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    // The supervisor owns the promise lifecycle. Mark a journal rejection as
    // observed even when nobody is currently awaiting this process.
    void exit.catch(() => undefined);
    const active: ActiveProcess = {
      start,
      child,
      exit,
      resolveExit,
      rejectExit,
      terminal: null,
      startJournal: Promise.resolve(),
      pendingError: undefined,
      settlement,
    };
    this.active.set(id, active);

    const finalize = (exitCode: number | null, signal: string | null, error?: unknown): void => {
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      void this.finalize(active, exitCode, signal, error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finalize(code, signal, active.pendingError);
    };
    const onError = (error: Error): void => {
      if (active.settlement === 'close-only') {
        active.pendingError ??= error;
        return;
      }
      finalize(null, null, error);
    };
    child.once('close', onClose);
    if (settlement === 'close-only') child.on('error', onError);
    else child.once('error', onError);

    let startJournalAssigned = false;
    try {
      active.startJournal = Promise.resolve(this.journal.recordStarted({ ...start }));
      startJournalAssigned = true;
      await active.startJournal;
    } catch (error) {
      if (!startJournalAssigned) {
        active.startJournal = Promise.reject(error);
        void active.startJournal.catch(() => undefined);
      }
      this.active.delete(id);
      child.kill('SIGKILL');
      if (rawClose && !await rawClose.wait(closeTimeoutMs)) {
        throw new ManagedProcessCleanupUnconfirmedError(
          this.cleanupCapability(child, rawClose, closeTimeoutMs),
        );
      }
      throw new Error(`Managed process journal rejected launch: ${errorMessage(error)}`);
    }

    return this.handleFor(active);
  }

  getActiveProcesses(): ProcessStartRecord[] {
    return [...this.active.values()].map((item) => ({ ...item.start }));
  }

  async terminate(id: string, options: ProcessTerminationOptions = {}): Promise<ProcessExitRecord> {
    const active = this.active.get(id);
    if (!active) throw new Error(`Managed process is not active: ${id}`);
    return this.terminateActive(active, options);
  }

  private async terminateActive(
    active: ActiveProcess,
    options: ProcessTerminationOptions,
  ): Promise<ProcessExitRecord> {
    if (active.terminal) return active.terminal;

    const graceMs = boundedDelay(options.graceMs, this.defaultGraceMs);
    const forceMs = boundedDelay(options.forceMs, this.defaultForceMs);
    const signalled = active.child.kill('SIGTERM');
    const graceful = await Promise.race([active.exit, wait(graceMs)]);
    if (graceful !== 'timeout') return graceful;
    if (!signalled) {
      // A failed signal means the live ChildProcess ownership proof is gone.
      // Never turn that ambiguous state into a PID-based tree kill.
      throw new Error(`Managed process could not be signalled safely: ${active.start.id}`);
    }

    // This is an in-memory ChildProcess owned by this supervisor, not an old
    // journal PID. Windows uses taskkill /T only after the graceful deadline.
    if (this.platform === 'win32') {
      await this.taskkill(active.start.pid, true, forceMs);
    } else {
      active.child.kill('SIGKILL');
    }
    const forced = await Promise.race([active.exit, wait(forceMs)]);
    if (forced === 'timeout') {
      throw new Error(`Managed process did not exit after force termination: ${active.start.id}`);
    }
    return forced;
  }

  async terminateAll(options: ProcessTerminationOptions = {}): Promise<ProcessExitRecord[]> {
    const results = await Promise.allSettled(
      [...this.active.values()].map((active) => this.terminateActive(active, options)),
    );
    const failures = results.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(failures.map((item) => item.reason), 'One or more managed processes did not stop.');
    }
    return results.map((item) => (item as PromiseFulfilledResult<ProcessExitRecord>).value);
  }

  async terminatePersisted(
    record: PersistedProcessRecord,
    options: Pick<ProcessTerminationOptions, 'forceMs'> = {},
  ): Promise<PersistedTerminationResult> {
    if (
      !Number.isSafeInteger(record.pid)
      || record.pid <= 0
      || !record.identity
      || !this.verifyPersistedIdentity
    ) {
      return { id: record.id, pid: record.pid, status: 'identity_rejected' };
    }
    const verified = await this.verifyPersistedIdentity({ ...record, identity: { ...record.identity } });
    if (!verified) return { id: record.id, pid: record.pid, status: 'identity_rejected' };

    const timeoutMs = boundedDelay(options.forceMs, this.defaultForceMs);
    if (this.platform === 'win32') {
      const result = await this.taskkill(record.pid, true, timeoutMs);
      return { id: record.id, pid: record.pid, status: result };
    }
    try {
      process.kill(record.pid, 'SIGKILL');
      return { id: record.id, pid: record.pid, status: 'terminated' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return { id: record.id, pid: record.pid, status: 'not_found' };
      }
      throw error;
    }
  }

  private handleFor(active: ActiveProcess): ManagedProcessHandle {
    return Object.freeze({
      id: active.start.id,
      pid: active.start.pid,
      child: active.child,
      startedAt: active.start.startedAt,
      waitForExit: () => active.exit,
      terminate: (options: ProcessTerminationOptions = {}) => this.terminateActive(active, options),
    });
  }

  private cleanupCapability(
    child: ChildProcess,
    rawClose: RawCloseConfirmation,
    closeTimeoutMs: number,
  ): ManagedProcessCleanupCapability {
    let inFlight: Promise<void> | null = null;
    const retryCleanup = (options: ProcessTerminationOptions = {}): Promise<void> => {
      if (rawClose.isClosed()) return Promise.resolve();
      if (inFlight) return inFlight;
      const attempt = (async () => {
        child.kill('SIGKILL');
        const timeoutMs = boundedDelay(options.forceMs, closeTimeoutMs);
        if (!await rawClose.wait(timeoutMs)) {
          throw new Error('Managed process cleanup could not be confirmed.');
        }
      })();
      inFlight = attempt;
      void attempt.then(
        () => { if (inFlight === attempt) inFlight = null; },
        () => { if (inFlight === attempt) inFlight = null; },
      );
      return attempt;
    };
    return Object.freeze({ retryCleanup });
  }

  private async finalize(
    active: ActiveProcess,
    exitCode: number | null,
    signal: string | null,
    error?: unknown,
  ): Promise<void> {
    if (active.terminal) return;
    const endedAt = this.now().toISOString();
    const record: ProcessExitRecord = {
      ...active.start,
      endedAt,
      exitCode,
      signal,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(active.start.startedAt)),
      ...(error === undefined ? {} : { error: errorMessage(error) }),
    };
    active.terminal = record;
    if (this.active.get(active.start.id) === active) this.active.delete(active.start.id);
    try {
      await active.startJournal;
      await this.journal.recordExited({ ...record });
      active.resolveExit(record);
    } catch (journalError) {
      active.rejectExit(journalError);
    }
  }

  private runWindowsTaskkill(
    pid: number,
    force: boolean,
    timeoutMs: number,
  ): Promise<'terminated' | 'not_found'> {
    return new Promise((resolve, reject) => {
      const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
      const killer = this.spawnProcess('taskkill', args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        operation();
      };
      killer.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-1_000);
      });
      killer.once('error', (error) => finish(() => reject(error)));
      killer.once('close', (code) => finish(() => {
        if (code === 0) resolve('terminated');
        else if (/not found|no running instance|没有找到/iu.test(stderr)) resolve('not_found');
        else reject(new Error(`taskkill failed with exit code ${code ?? 'null'}.`));
      }));
      const timer = setTimeout(() => finish(() => {
        killer.kill('SIGKILL');
        reject(new Error('taskkill timed out.'));
      }), timeoutMs);
      timer.unref?.();
    });
  }
}
