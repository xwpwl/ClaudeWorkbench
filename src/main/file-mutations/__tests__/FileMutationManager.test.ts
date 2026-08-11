import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileFingerprintMismatchError,
  FileMutationConflictError,
  FileMutationContextError,
  FileMutationManager,
  FileMutationPathError,
  FileMutationRollbackError,
  type FileMutationEvent,
} from '../FileMutationManager';

describe('FileMutationManager', () => {
  let projectPath: string;
  let outsidePath: string;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-file-mutation-project-'));
    outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-file-mutation-outside-'));
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'app.txt'), 'before', 'utf8');
  });

  afterEach(async () => {
    await Promise.all([
      fs.rm(projectPath, { recursive: true, force: true }),
      fs.rm(outsidePath, { recursive: true, force: true }),
    ]);
  });

  it('holds one canonical project lease and rejects a concurrent alias request', async () => {
    const manager = new FileMutationManager();
    const first = await manager.acquireExternalLease({
      mutationId: 'external-1',
      kind: 'claude_run',
      projectPath,
    });

    const competing = manager.acquireExternalLease({
      mutationId: 'external-2',
      kind: 'git_restore',
      projectPath: path.join(projectPath, '.'),
    });

    await expect(competing).rejects.toEqual(expect.objectContaining({
      code: 'TASK_PROJECT_BUSY',
      conflictingMutationId: 'external-1',
    }));
    await expect(competing).rejects.toBeInstanceOf(FileMutationConflictError);
    first.release();

    const next = await manager.acquireExternalLease({
      mutationId: 'external-3',
      kind: 'git_restore',
      projectPath,
    });
    next.release();
  });

  it('keeps an external-process lease until explicit release and exposes a bounded context', async () => {
    const manager = new FileMutationManager();
    const lease = await manager.acquireExternalLease({
      mutationId: 'claude-1',
      kind: 'claude_run',
      projectPath,
      runId: 'run-1',
    });

    await lease.run(async (context) => {
      expect(context.mutationId).toBe('claude-1');
      expect(context.runId).toBe('run-1');
      await context.writeFile('src/generated.txt', 'generated');
    });
    expect(await fs.readFile(path.join(projectPath, 'src', 'generated.txt'), 'utf8')).toBe('generated');

    await expect(manager.acquireExternalLease({
      mutationId: 'restore-1',
      kind: 'checkpoint_restore',
      projectPath,
    })).rejects.toMatchObject({ code: 'TASK_PROJECT_BUSY' });

    lease.release();
    await expect(manager.writeFile('src/late.txt', 'late')).rejects.toBeInstanceOf(
      FileMutationContextError,
    );
  });

  it('records an external writer from lease acquisition through its explicit outcome', async () => {
    const events: FileMutationEvent[] = [];
    const manager = new FileMutationManager({
      recordEvent: (event) => { events.push(event); },
    });
    const lease = await manager.acquireExternalProcessLease({
      mutationId: 'claude-lifecycle',
      kind: 'claude_run',
      projectPath,
      taskId: 'task-1',
      sessionId: 'session-1',
      runId: 'run-1',
    });

    expect(events).toEqual([
      expect.objectContaining({
        mutationId: 'claude-lifecycle',
        status: 'started',
        taskId: 'task-1',
        sessionId: 'session-1',
        runId: 'run-1',
      }),
    ]);
    await expect(manager.acquireExternalLease({
      mutationId: 'restore-while-running',
      kind: 'git_restore',
      projectPath,
    })).rejects.toMatchObject({ code: 'TASK_PROJECT_BUSY' });

    await lease.finalize('completed');
    expect(lease.released).toBe(true);
    expect(events.map((event) => event.status)).toEqual(['started', 'completed']);
    // A released capability cannot be reused to forge a later outcome.
    await expect(lease.finalize('failed', new Error('late failure')))
      .rejects.toBeInstanceOf(FileMutationContextError);

    const after = await manager.acquireExternalLease({
      mutationId: 'restore-after-completion',
      kind: 'git_restore',
      projectPath,
    });
    after.release();
  });

  it('fails lease acquisition closed when the started audit event cannot be recorded', async () => {
    const manager = new FileMutationManager({
      recordEvent: async () => { throw new Error('event database unavailable'); },
    });

    await expect(manager.acquireExternalProcessLease({
      mutationId: 'unrecorded-external-writer',
      kind: 'claude_run',
      projectPath,
    })).rejects.toThrow('event database unavailable');

    const after = await manager.acquireExternalLease({
      mutationId: 'after-audit-failure',
      kind: 'git_restore',
      projectPath,
    });
    after.release();
  });

  it('runs verify, mutate, and record in order after acquiring the lease', async () => {
    const events: FileMutationEvent[] = [];
    const order: string[] = [];
    const manager = new FileMutationManager({
      recordEvent: async (event) => { events.push(event); },
    });

    const result = await manager.runMutation({
      mutationId: 'mutation-success',
      kind: 'apply_patch',
      projectPath,
      taskId: 'task-1',
      filePaths: ['src/app.txt'],
    }, {
      verify: async () => { order.push('verify'); },
      mutate: async (context) => {
        order.push('mutate');
        await context.writeFile('src/app.txt', 'after');
        return 42;
      },
      record: async (_context, value) => {
        order.push(`record:${value}`);
      },
    });

    expect(result).toBe(42);
    expect(order).toEqual(['verify', 'mutate', 'record:42']);
    expect(await fs.readFile(path.join(projectPath, 'src', 'app.txt'), 'utf8')).toBe('after');
    expect(events).toEqual([
      expect.objectContaining({
        mutationId: 'mutation-success',
        kind: 'apply_patch',
        status: 'completed',
        taskId: 'task-1',
        filePaths: ['src/app.txt'],
      }),
    ]);
  });

  it('verifies an expected fingerprint only after the project lease is acquired', async () => {
    const manager = new FileMutationManager();
    const expected = await manager.fingerprint(projectPath, ['src/app.txt']);
    await fs.writeFile(path.join(projectPath, 'src', 'app.txt'), 'user edit', 'utf8');
    const mutate = vi.fn(async () => undefined);

    const operation = manager.runMutation({
      mutationId: 'stale-restore',
      kind: 'checkpoint_restore',
      projectPath,
      expectedFingerprint: expected,
    }, { mutate });

    await expect(operation).rejects.toEqual(expect.objectContaining({
      code: 'FILE_FINGERPRINT_MISMATCH',
      expectedDigest: expected.digest,
    }));
    await expect(operation).rejects.toBeInstanceOf(FileFingerprintMismatchError);
    expect(mutate).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(projectPath, 'src', 'app.txt'), 'utf8')).toBe('user edit');
  });

  it('rolls a partial mutation back before releasing the lease and records the outcome', async () => {
    const events: FileMutationEvent[] = [];
    const manager = new FileMutationManager({
      recordEvent: (event) => { events.push(event); },
    });
    let leaseWasStillHeld = false;

    const operation = manager.runMutation({
      mutationId: 'restore-with-rollback',
      kind: 'checkpoint_restore',
      projectPath,
      filePaths: ['src/app.txt'],
    }, {
      mutate: async (context) => {
        await context.writeFile('src/app.txt', 'partially restored');
        throw new Error('second file failed');
      },
      rollback: async (context, error) => {
        expect(error).toEqual(expect.objectContaining({ message: 'second file failed' }));
        await context.writeFile('src/app.txt', 'before');
        // A rollback executes inside the same still-active lease context.
        // Same-context same-project work is intentionally reentrant.
        leaseWasStillHeld = true;
      },
    });

    await expect(operation).rejects.toThrow('second file failed');
    expect(leaseWasStillHeld).toBe(true);
    expect(await fs.readFile(path.join(projectPath, 'src', 'app.txt'), 'utf8')).toBe('before');
    expect(events).toEqual([
      expect.objectContaining({
        mutationId: 'restore-with-rollback',
        status: 'rolled_back',
        error: 'second file failed',
      }),
    ]);

    const after = await manager.acquireExternalLease({
      mutationId: 'after-rollback',
      kind: 'git_restore',
      projectPath,
    });
    after.release();
  });

  it('reports both the mutation and rollback errors without leaking the lease', async () => {
    const manager = new FileMutationManager();
    const operation = manager.runMutation({
      mutationId: 'rollback-failure',
      kind: 'checkpoint_restore',
      projectPath,
    }, {
      mutate: async () => { throw new Error('mutation failed'); },
      rollback: async () => { throw new Error('rollback failed'); },
    });

    await expect(operation).rejects.toEqual(expect.objectContaining({
      code: 'FILE_MUTATION_ROLLBACK_FAILED',
      mutationError: expect.objectContaining({ message: 'mutation failed' }),
      rollbackError: expect.objectContaining({ message: 'rollback failed' }),
    }));
    await expect(operation).rejects.toBeInstanceOf(FileMutationRollbackError);

    const after = await manager.acquireExternalLease({
      mutationId: 'after-rollback-failure',
      kind: 'git_restore',
      projectPath,
    });
    after.release();
  });

  it('allows same-project reentry only through the inherited AsyncLocalStorage context', async () => {
    const manager = new FileMutationManager();
    const order: string[] = [];

    await manager.runMutation({
      mutationId: 'outer',
      kind: 'claude_run',
      projectPath,
    }, {
      mutate: async (outer) => {
        order.push(`outer:${outer.ownerMutationId}`);
        await manager.runMutation({
          mutationId: 'inner',
          kind: 'apply_patch',
          projectPath: path.join(projectPath, '.'),
        }, {
          mutate: async (inner) => {
            order.push(`inner:${inner.ownerMutationId}`);
            expect(inner.reentrant).toBe(true);
            await manager.writeFile('src/nested.txt', 'nested');
          },
        });
      },
    });

    expect(order).toEqual(['outer:outer', 'inner:outer']);
    expect(await fs.readFile(path.join(projectPath, 'src', 'nested.txt'), 'utf8')).toBe('nested');
  });

  it('restricts writeFile and removeFile to safe project-relative paths in an active context', async () => {
    const manager = new FileMutationManager();
    const outsideFile = path.join(outsidePath, 'outside.txt');
    await fs.writeFile(outsideFile, 'outside', 'utf8');

    await expect(manager.writeFile('src/no-context.txt', 'blocked')).rejects.toBeInstanceOf(
      FileMutationContextError,
    );
    await expect(manager.removeFile('src/no-context.txt')).rejects.toBeInstanceOf(
      FileMutationContextError,
    );

    await manager.runMutation({
      mutationId: 'path-policy',
      kind: 'apply_patch',
      projectPath,
    }, {
      mutate: async (context) => {
        await expect(context.writeFile('../escape.txt', 'escape')).rejects.toBeInstanceOf(
          FileMutationPathError,
        );
        await expect(context.writeFile(outsideFile, 'escape')).rejects.toBeInstanceOf(
          FileMutationPathError,
        );
        await expect(context.writeFile('.git/config', 'escape')).rejects.toBeInstanceOf(
          FileMutationPathError,
        );
        await context.writeFile('src/removable.txt', 'remove me');
        await context.removeFile('src/removable.txt');
      },
    });

    expect(await fs.readFile(outsideFile, 'utf8')).toBe('outside');
    await expect(fs.stat(path.join(projectPath, 'src', 'removable.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('creates an exclusive file once without changing ordinary overwrite behavior', async () => {
    const manager = new FileMutationManager();

    await manager.runMutation({
      mutationId: 'exclusive-write',
      kind: 'first_run_project',
      projectPath,
      filePaths: ['exclusive.txt', 'src/app.txt'],
    }, {
      mutate: async (context) => {
        await context.writeFileExclusive('exclusive.txt', 'owned');
        await expect(context.writeFileExclusive('exclusive.txt', 'overwrite'))
          .rejects.toMatchObject({ code: 'FILE_MUTATION_PATH_UNSAFE' });
        await context.writeFile('src/app.txt', 'ordinary overwrite');
      },
    });

    expect(await fs.readFile(path.join(projectPath, 'exclusive.txt'), 'utf8')).toBe('owned');
    expect(await fs.readFile(path.join(projectPath, 'src', 'app.txt'), 'utf8'))
      .toBe('ordinary overwrite');
  });

  it('records the first-run project kind through a reentrant owner mutation', async () => {
    const events: FileMutationEvent[] = [];
    const manager = new FileMutationManager({
      recordEvent: (event) => { events.push(event); },
    });
    const request = {
      mutationId: 'first-run-owner',
      kind: 'first_run_project' as const,
      projectPath,
      projectId: 'project-id',
      filePaths: ['sample.txt'],
    };
    const owner = await manager.acquireExternalLease(request);

    await owner.run(async () => {
      const missing = await manager.fingerprint(projectPath, ['sample.txt']);
      await manager.runMutation({ ...request, expectedFingerprint: missing }, {
        mutate: (context) => context.writeFileExclusive('sample.txt', 'sample'),
      });
    });
    owner.release();

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'first_run_project',
        status: 'completed',
        ownerMutationId: 'first-run-owner',
        reentrant: true,
      }),
    ]);
  });

  it('keeps first-run precreation lease normalization lexical for a colliding junction', async () => {
    const manager = new FileMutationManager();
    const junctionPath = path.join(projectPath, 'candidate-junction');
    await fs.symlink(outsidePath, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');

    const candidateLease = await manager.acquireExternalLease({
      mutationId: 'first-run-candidate',
      kind: 'first_run_project',
      projectPath: junctionPath,
    });
    const outsideLease = await manager.acquireExternalLease({
      mutationId: 'outside-project',
      kind: 'first_run_project',
      projectPath: outsidePath,
    });

    expect(candidateLease.reentrant).toBe(false);
    expect(outsideLease.reentrant).toBe(false);
    outsideLease.release();
    candidateLease.release();
  });
});
