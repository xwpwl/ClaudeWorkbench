import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { SafePathPolicy } from '../file-changes/SafePathPolicy';
import { canonicalizeProjectPath } from '../projects/ProjectService';

export type FileMutationKind =
  | 'claude_run'
  | 'workflow_fix'
  | 'apply_patch'
  | 'checkpoint_restore'
  | 'git_restore'
  | 'git_init'
  | 'git_commit'
  | 'first_run_project';

export type FileMutationStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rolled_back'
  | 'rollback_failed';

export type ExternalFileMutationOutcome = 'completed' | 'failed' | 'cancelled';

export interface FileFingerprintEntry {
  filePath: string;
  state: 'file' | 'missing';
  size: number;
  sha256: string | null;
}

export interface FileMutationFingerprint {
  algorithm: 'sha256';
  projectPath: string;
  digest: string;
  files: FileFingerprintEntry[];
}

export interface FileMutationRequest {
  mutationId?: string;
  kind: FileMutationKind;
  projectPath: string;
  projectId?: string;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  filePaths?: readonly string[];
  expectedFingerprint?: FileMutationFingerprint;
}

export interface FileMutationEvent {
  mutationId: string;
  ownerMutationId: string;
  kind: FileMutationKind;
  status: FileMutationStatus;
  projectPath: string;
  projectId?: string;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  filePaths: string[];
  reentrant: boolean;
  startedAt: string;
  completedAt: string;
  error?: string;
  rollbackError?: string;
}

export interface FileMutationContext {
  readonly mutationId: string;
  readonly ownerMutationId: string;
  readonly kind: FileMutationKind;
  readonly projectPath: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly filePaths: readonly string[];
  readonly reentrant: boolean;
  fingerprint(filePaths: readonly string[]): Promise<FileMutationFingerprint>;
  verifyFingerprint(expected: FileMutationFingerprint): Promise<void>;
  writeFile(filePath: string, content: string | Uint8Array): Promise<void>;
  writeFileExclusive(filePath: string, content: string | Uint8Array): Promise<void>;
  removeFile(filePath: string): Promise<void>;
}

export interface FileMutationLease {
  readonly mutationId: string;
  readonly ownerMutationId: string;
  readonly kind: FileMutationKind;
  readonly projectPath: string;
  readonly reentrant: boolean;
  readonly released: boolean;
  run<T>(operation: (context: FileMutationContext) => T | Promise<T>): Promise<T>;
  finalize(outcome: ExternalFileMutationOutcome, error?: unknown): Promise<void>;
  release(): void;
}

export interface FileMutationSteps<T> {
  verify?: (context: FileMutationContext) => void | Promise<void>;
  mutate: (context: FileMutationContext) => T | Promise<T>;
  record?: (context: FileMutationContext, result: T) => void | Promise<void>;
  rollback?: (context: FileMutationContext, error: unknown) => void | Promise<void>;
}

export interface FileMutationManagerOptions {
  paths?: SafePathPolicy;
  now?: () => Date;
  randomUUID?: () => string;
  recordEvent?: (event: FileMutationEvent) => void | Promise<void>;
}

interface LeaseState {
  ownerMutationId: string;
  canonicalProjectPath: string;
  projectPath: string;
  active: boolean;
}

interface MutationStore {
  state: LeaseState;
  request: NormalizedMutationRequest;
  startedAt: string;
  reentrant: boolean;
}

interface NormalizedMutationRequest {
  mutationId: string;
  kind: FileMutationKind;
  projectPath: string;
  canonicalProjectPath: string;
  projectId?: string;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  filePaths: string[];
  expectedFingerprint?: FileMutationFingerprint;
}

export class FileMutationConflictError extends Error {
  readonly code = 'TASK_PROJECT_BUSY';

  constructor(
    readonly conflictingMutationId: string,
    message = 'The project already has an active file mutation.',
  ) {
    super(message);
    this.name = 'FileMutationConflictError';
  }
}

export class FileFingerprintMismatchError extends Error {
  readonly code = 'FILE_FINGERPRINT_MISMATCH';

  constructor(
    readonly expectedDigest: string,
    readonly actualDigest: string,
    message = 'Project files changed after their fingerprint was captured.',
  ) {
    super(message);
    this.name = 'FileFingerprintMismatchError';
  }
}

export class FileMutationContextError extends Error {
  readonly code = 'FILE_MUTATION_CONTEXT_REQUIRED';

  constructor(message = 'Project file writes require an active file mutation context.') {
    super(message);
    this.name = 'FileMutationContextError';
  }
}

export class FileMutationPathError extends Error {
  readonly code = 'FILE_MUTATION_PATH_UNSAFE';

  constructor(message: string) {
    super(message);
    this.name = 'FileMutationPathError';
  }
}

export class FileMutationRollbackError extends Error {
  readonly code = 'FILE_MUTATION_ROLLBACK_FAILED';

  constructor(
    readonly mutationError: unknown,
    readonly rollbackError: unknown,
  ) {
    super(
      `File mutation failed and rollback also failed: ${errorMessage(rollbackError)}`,
    );
    this.name = 'FileMutationRollbackError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fingerprintDigest(entries: readonly FileFingerprintEntry[]): string {
  const hash = crypto.createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.filePath);
    hash.update('\0');
    hash.update(entry.state);
    hash.update('\0');
    hash.update(String(entry.size));
    hash.update('\0');
    hash.update(entry.sha256 ?? '');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function validMutationId(value: string): boolean {
  return Boolean(value.trim()) && value.length <= 512 && !value.includes('\0');
}

/**
 * Owns the process-local project mutation boundary.
 *
 * Direct project writes are intentionally exposed only through an active
 * AsyncLocalStorage context. Long-lived external writers (Claude or Git) can
 * hold an explicit lease and enter that context for Workbench-controlled work.
 */
export class FileMutationManager {
  private readonly paths: SafePathPolicy;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly recordEvent?: (event: FileMutationEvent) => void | Promise<void>;
  private readonly activeByProject = new Map<string, LeaseState>();
  private readonly contextStorage = new AsyncLocalStorage<MutationStore>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: FileMutationManagerOptions = {}) {
    this.paths = options.paths ?? new SafePathPolicy();
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.recordEvent = options.recordEvent;
  }

  async fingerprint(
    projectPath: string,
    filePaths: readonly string[],
  ): Promise<FileMutationFingerprint> {
    const root = await this.safeProjectRoot(projectPath);
    const normalizedPaths = await this.safeRelativePaths(root, filePaths);
    const files: FileFingerprintEntry[] = [];
    for (const filePath of normalizedPaths) {
      files.push(await this.fingerprintFile(root, filePath));
    }
    return {
      algorithm: 'sha256',
      projectPath: canonicalizeProjectPath(root).canonicalPath,
      digest: fingerprintDigest(files),
      files,
    };
  }

  async verifyFingerprint(
    projectPath: string,
    expected: FileMutationFingerprint,
  ): Promise<void> {
    if (expected.algorithm !== 'sha256') {
      throw new FileFingerprintMismatchError(expected.digest, 'unsupported-algorithm');
    }
    const actual = await this.fingerprint(
      projectPath,
      expected.files.map((file) => file.filePath),
    );
    if (
      actual.projectPath !== expected.projectPath
      || actual.digest !== expected.digest
    ) {
      throw new FileFingerprintMismatchError(expected.digest, actual.digest);
    }
  }

  async acquireExternalLease(request: FileMutationRequest): Promise<FileMutationLease> {
    const normalized = await this.normalizeRequest(request);
    const inherited = this.contextStorage.getStore();
    if (
      inherited?.state.active
      && inherited.state.canonicalProjectPath === normalized.canonicalProjectPath
    ) {
      return this.createLease(inherited.state, normalized, true, false);
    }

    const conflicting = this.activeByProject.get(normalized.canonicalProjectPath);
    if (conflicting?.active) {
      throw new FileMutationConflictError(conflicting.ownerMutationId);
    }

    const state: LeaseState = {
      ownerMutationId: normalized.mutationId,
      canonicalProjectPath: normalized.canonicalProjectPath,
      projectPath: normalized.projectPath,
      active: true,
    };
    this.activeByProject.set(normalized.canonicalProjectPath, state);
    return this.createLease(state, normalized, false, true);
  }

  /**
   * Acquires a long-lived Claude/Git process lease and durably records that the
   * mutation boundary is active before the external writer can be spawned.
   */
  async acquireExternalProcessLease(request: FileMutationRequest): Promise<FileMutationLease> {
    const lease = await this.acquireExternalLease(request);
    try {
      await lease.run((context) => this.emitEvent(context, 'started'));
      return lease;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async runMutation<T>(
    request: FileMutationRequest,
    steps: FileMutationSteps<T>,
  ): Promise<T> {
    const lease = await this.acquireExternalLease(request);
    try {
      return await lease.run(async (context) => {
        let mutationStarted = false;
        try {
          if (request.expectedFingerprint) {
            await context.verifyFingerprint(request.expectedFingerprint);
          }
          await steps.verify?.(context);
          mutationStarted = true;
          const result = await steps.mutate(context);
          await steps.record?.(context, result);
          await this.emitEvent(context, 'completed');
          return result;
        } catch (error) {
          if (mutationStarted && steps.rollback) {
            try {
              await steps.rollback(context, error);
              await this.emitEventSafely(context, 'rolled_back', error);
            } catch (rollbackError) {
              await this.emitEventSafely(context, 'rollback_failed', error, rollbackError);
              throw new FileMutationRollbackError(error, rollbackError);
            }
          } else {
            await this.emitEventSafely(context, 'failed', error);
          }
          throw error;
        }
      });
    } finally {
      lease.release();
    }
  }

  getActiveMutationCount(): number {
    return this.activeByProject.size;
  }

  waitForIdle(): Promise<void> {
    if (this.activeByProject.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  async writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
    const store = this.requireActiveStore();
    await this.writeFileInStore(store, filePath, content);
  }

  async writeFileExclusive(filePath: string, content: string | Uint8Array): Promise<void> {
    const store = this.requireActiveStore();
    await this.writeFileExclusiveInStore(store, filePath, content);
  }

  async removeFile(filePath: string): Promise<void> {
    const store = this.requireActiveStore();
    await this.removeFileInStore(store, filePath);
  }

  private createLease(
    state: LeaseState,
    request: NormalizedMutationRequest,
    reentrant: boolean,
    ownsState: boolean,
  ): FileMutationLease {
    const store: MutationStore = {
      state,
      request,
      startedAt: this.now().toISOString(),
      reentrant,
    };
    const leaseState = { released: false, finalized: false };
    return {
      mutationId: request.mutationId,
      ownerMutationId: state.ownerMutationId,
      kind: request.kind,
      projectPath: state.projectPath,
      reentrant,
      get released() { return leaseState.released || !state.active; },
      run: async <T>(operation: (context: FileMutationContext) => T | Promise<T>): Promise<T> => {
        if (leaseState.released || !state.active) {
          throw new FileMutationContextError('The file mutation lease is no longer active.');
        }
        return this.contextStorage.run(store, async () => operation(this.contextFor(store)));
      },
      finalize: async (outcome: ExternalFileMutationOutcome, error?: unknown): Promise<void> => {
        if (leaseState.released || !state.active) {
          throw new FileMutationContextError('The file mutation lease is no longer active.');
        }
        if (leaseState.finalized) return;
        leaseState.finalized = true;
        try {
          await this.contextStorage.run(store, async () => {
            await this.emitEvent(this.contextFor(store), outcome, error);
          });
        } finally {
          if (ownsState) {
            if (this.activeByProject.get(state.canonicalProjectPath) === state) {
              this.activeByProject.delete(state.canonicalProjectPath);
            }
            state.active = false;
            this.notifyIdle();
          }
          leaseState.released = true;
        }
      },
      release: (): void => {
        if (leaseState.released) return;
        leaseState.released = true;
        if (!ownsState) return;
        if (this.activeByProject.get(state.canonicalProjectPath) === state) {
          this.activeByProject.delete(state.canonicalProjectPath);
        }
        state.active = false;
        this.notifyIdle();
      },
    };
  }

  private notifyIdle(): void {
    if (this.activeByProject.size > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private contextFor(store: MutationStore): FileMutationContext {
    const { request, state } = store;
    return Object.freeze({
      mutationId: request.mutationId,
      ownerMutationId: state.ownerMutationId,
      kind: request.kind,
      projectPath: state.projectPath,
      projectId: request.projectId,
      taskId: request.taskId,
      sessionId: request.sessionId,
      runId: request.runId,
      filePaths: [...request.filePaths],
      reentrant: store.reentrant,
      fingerprint: (filePaths: readonly string[]) => this.fingerprint(state.projectPath, filePaths),
      verifyFingerprint: (expected: FileMutationFingerprint) => (
        this.verifyFingerprint(state.projectPath, expected)
      ),
      writeFile: (filePath: string, content: string | Uint8Array) => (
        this.writeFileInStore(store, filePath, content)
      ),
      writeFileExclusive: (filePath: string, content: string | Uint8Array) => (
        this.writeFileExclusiveInStore(store, filePath, content)
      ),
      removeFile: (filePath: string) => this.removeFileInStore(store, filePath),
    });
  }

  private requireActiveStore(): MutationStore {
    const store = this.contextStorage.getStore();
    if (!store?.state.active) throw new FileMutationContextError();
    if (this.activeByProject.get(store.state.canonicalProjectPath) !== store.state) {
      throw new FileMutationContextError('The file mutation context no longer owns its project lease.');
    }
    return store;
  }

  private assertStoreActive(store: MutationStore): void {
    if (
      !store.state.active
      || this.activeByProject.get(store.state.canonicalProjectPath) !== store.state
    ) {
      throw new FileMutationContextError('The file mutation context no longer owns its project lease.');
    }
  }

  private async writeFileInStore(
    store: MutationStore,
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    this.assertStoreActive(store);
    const resolved = await this.safeProjectFile(store.state.projectPath, filePath);
    this.assertStoreActive(store);
    await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    try {
      const current = await fs.lstat(resolved.absolutePath);
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new FileMutationPathError(`Refusing to overwrite a non-regular project file: ${resolved.gitPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.assertStoreActive(store);
    await fs.writeFile(resolved.absolutePath, content);
  }

  private async removeFileInStore(store: MutationStore, filePath: string): Promise<void> {
    this.assertStoreActive(store);
    const resolved = await this.safeProjectFile(store.state.projectPath, filePath);
    this.assertStoreActive(store);
    try {
      const current = await fs.lstat(resolved.absolutePath);
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new FileMutationPathError(`Refusing to remove a non-regular project file: ${resolved.gitPath}`);
      }
      this.assertStoreActive(store);
      await fs.unlink(resolved.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async writeFileExclusiveInStore(
    store: MutationStore,
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    this.assertStoreActive(store);
    const resolved = await this.safeProjectFile(store.state.projectPath, filePath);
    this.assertStoreActive(store);
    await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    this.assertStoreActive(store);
    try {
      await fs.writeFile(resolved.absolutePath, content, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new FileMutationPathError(
          `Refusing to overwrite an existing project file: ${resolved.gitPath}`,
        );
      }
      throw error;
    }
  }

  private async normalizeRequest(request: FileMutationRequest): Promise<NormalizedMutationRequest> {
    const mutationId = request.mutationId ?? this.randomUUID();
    if (!validMutationId(mutationId)) throw new Error('Mutation id must be a non-empty safe identifier.');
    if (!request.projectPath.trim() || request.projectPath.includes('\0')) {
      throw new FileMutationPathError('Project path must be a non-empty safe path.');
    }
    const projectPath = path.resolve(request.projectPath);
    // The first-run candidate does not exist yet. Its outer lease must be
    // established lexically before any realpath/reparse-point inspection.
    // Existing-project mutation kinds retain realpath-based alias exclusion.
    const canonicalProjectPath = request.kind === 'first_run_project'
      ? (process.platform === 'win32'
        ? path.normalize(projectPath).toLocaleLowerCase('en-US')
        : path.normalize(projectPath))
      : canonicalizeProjectPath(projectPath).canonicalPath;
    const filePaths = this.lexicalRelativePaths(projectPath, request.filePaths ?? []);
    return {
      mutationId,
      kind: request.kind,
      projectPath,
      canonicalProjectPath,
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.runId ? { runId: request.runId } : {}),
      filePaths,
      ...(request.expectedFingerprint ? { expectedFingerprint: request.expectedFingerprint } : {}),
    };
  }

  private async safeProjectRoot(projectPath: string): Promise<string> {
    try {
      return await this.paths.resolveProjectRoot(projectPath);
    } catch (error) {
      throw new FileMutationPathError(errorMessage(error));
    }
  }

  private async safeRelativePaths(root: string, filePaths: readonly string[]): Promise<string[]> {
    const normalized: string[] = [];
    for (const filePath of filePaths) {
      normalized.push((await this.safeProjectFile(root, filePath)).gitPath);
    }
    return uniqueSorted(normalized);
  }

  private lexicalRelativePaths(root: string, filePaths: readonly string[]): string[] {
    const normalized: string[] = [];
    for (const filePath of filePaths) {
      if (!filePath.trim() || filePath.includes('\0') || path.isAbsolute(filePath)) {
        throw new FileMutationPathError('Project mutation paths must be safe relative paths.');
      }
      const candidate = path.resolve(root, filePath);
      const relative = path.relative(root, candidate);
      if (
        !relative
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
      ) {
        throw new FileMutationPathError('Project mutation path escapes the project root.');
      }
      const gitPath = relative.split(path.sep).join('/');
      if (gitPath === '.git' || gitPath.startsWith('.git/')) {
        throw new FileMutationPathError('Project mutation paths cannot target Git metadata.');
      }
      normalized.push(gitPath);
    }
    return uniqueSorted(normalized);
  }

  private async safeProjectFile(root: string, filePath: string) {
    try {
      return await this.paths.resolveFile(root, filePath);
    } catch (error) {
      throw new FileMutationPathError(errorMessage(error));
    }
  }

  private async fingerprintFile(root: string, filePath: string): Promise<FileFingerprintEntry> {
    const resolved = await this.safeProjectFile(root, filePath);
    try {
      const before = await fs.lstat(resolved.absolutePath);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new FileMutationPathError(`Cannot fingerprint a non-regular project file: ${filePath}`);
      }
      const sha256 = await this.hashFile(resolved.absolutePath);
      const after = await fs.lstat(resolved.absolutePath);
      if (
        !after.isFile()
        || after.isSymbolicLink()
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
      ) {
        throw new FileMutationPathError(`Project file changed while it was fingerprinted: ${filePath}`);
      }
      return { filePath, state: 'file', size: after.size, sha256 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { filePath, state: 'missing', size: 0, sha256: null };
      }
      throw error;
    }
  }

  private hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  private async emitEvent(
    context: FileMutationContext,
    status: FileMutationStatus,
    error?: unknown,
    rollbackError?: unknown,
  ): Promise<void> {
    if (!this.recordEvent) return;
    const store = this.requireActiveStore();
    await this.recordEvent({
      mutationId: context.mutationId,
      ownerMutationId: context.ownerMutationId,
      kind: context.kind,
      status,
      projectPath: context.projectPath,
      ...(context.projectId ? { projectId: context.projectId } : {}),
      ...(context.taskId ? { taskId: context.taskId } : {}),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.runId ? { runId: context.runId } : {}),
      filePaths: [...context.filePaths],
      reentrant: context.reentrant,
      startedAt: store.startedAt,
      completedAt: this.now().toISOString(),
      ...(error === undefined ? {} : { error: errorMessage(error) }),
      ...(rollbackError === undefined ? {} : { rollbackError: errorMessage(rollbackError) }),
    });
  }

  private async emitEventSafely(
    context: FileMutationContext,
    status: FileMutationStatus,
    error?: unknown,
    rollbackError?: unknown,
  ): Promise<void> {
    try {
      await this.emitEvent(context, status, error, rollbackError);
    } catch (recordError) {
      console.error('[FileMutationManager] unable to record mutation outcome:', recordError);
    }
  }
}
