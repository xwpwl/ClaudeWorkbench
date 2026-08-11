import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileMutationContext, FileMutationEvent, FileMutationFingerprint, FileMutationRequest, FileMutationSteps } from '../../file-mutations/FileMutationManager';
import { FileMutationManager } from '../../file-mutations/FileMutationManager';
import { AppDatabase } from '../../database/Database';
import {
  FirstRunProjectError,
  FirstRunService,
} from '../FirstRunService';

const TEMP_PREFIX = 'claude-workbench-first-run-test-';
const UUID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-08-09T12:00:00.000Z');
const PROJECT_NAME = 'Claude Workbench Test Project';
const EXPECTED_FILES: Record<string, string> = {
  'package.json': `${JSON.stringify({
    name: 'claude-workbench-test-project',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2)}\n`,
  'math.js': 'export function add(left, right) {\n  return left + right;\n}\n',
  'math.test.js': [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { add } from './math.js';",
    '',
    "test('add(2, 3) equals 5', () => {",
    '  assert.equal(add(2, 3), 5);',
    '});',
    '',
  ].join('\n'),
};

function safeRemove(directory: string): void {
  const target = path.resolve(directory);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir())
    || !path.basename(target).startsWith(TEMP_PREFIX)
  ) throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

function projectRoot(dataRoot: string): string {
  return path.join(dataRoot, 'first-run-projects', UUID);
}

class TrackingMutationManager extends FileMutationManager {
  readonly fingerprints: FileMutationFingerprint[] = [];

  override async fingerprint(
    projectPath: string,
    filePaths: readonly string[],
  ): Promise<FileMutationFingerprint> {
    const result = await super.fingerprint(projectPath, filePaths);
    this.fingerprints.push(result);
    return result;
  }
}

class SecondWriteFailureManager extends FileMutationManager {
  override runMutation<T>(
    request: FileMutationRequest,
    steps: FileMutationSteps<T>,
  ): Promise<T> {
    return super.runMutation(request, {
      ...steps,
      mutate: (context) => {
        const original = context as FileMutationContext & {
          writeFileExclusive(filePath: string, content: string | Uint8Array): Promise<void>;
        };
        let writes = 0;
        const wrapped = Object.freeze({
          ...context,
          writeFileExclusive: async (filePath: string, content: string | Uint8Array) => {
            writes += 1;
            if (writes === 2) throw new Error('C:\\private\\raw-write-error');
            return original.writeFileExclusive(filePath, content);
          },
        }) as FileMutationContext;
        return steps.mutate(wrapped);
      },
    });
  }
}

class MissingFingerprintFailureManager extends FileMutationManager {
  override async fingerprint(): Promise<FileMutationFingerprint> {
    throw new Error('C:\\private\\missing-fingerprint-error');
  }
}

describe('FirstRunService', () => {
  let dataRoot: string;
  let database: AppDatabase;
  const extraRoots = new Set<string>();

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    database = new AppDatabase(path.join(dataRoot, 'workbench.db'));
  });

  afterEach(() => {
    database.close();
    safeRemove(dataRoot);
    for (const root of extraRoots) safeRemove(root);
    extraRoots.clear();
  });

  function service(
    mutations: FileMutationManager = new FileMutationManager(),
    options: Record<string, unknown> = {},
  ): FirstRunService {
    return new FirstRunService({
      dataRoot,
      database,
      fileMutations: mutations,
      randomUUID: () => UUID,
      now: () => NOW,
      ...options,
    });
  }

  it('creates one UUID project with only the fixed three root-level UTF-8 files', async () => {
    const events: FileMutationEvent[] = [];
    const mutations = new TrackingMutationManager({
      recordEvent: (event) => { events.push(event); },
    });

    const project = await service(mutations).createTestProject();

    expect(project).toEqual({
      id: UUID,
      name: PROJECT_NAME,
      path: fs.realpathSync.native(projectRoot(dataRoot)),
      createdAt: NOW.toISOString(),
      lastOpenedAt: NOW.toISOString(),
    });
    expect(fs.readdirSync(project.path).sort()).toEqual(Object.keys(EXPECTED_FILES).sort());
    for (const [fileName, content] of Object.entries(EXPECTED_FILES)) {
      expect(fs.readFileSync(path.join(project.path, fileName), 'utf8')).toBe(content);
    }
    expect(database.getProject(UUID)).toEqual({
      id: UUID,
      name: PROJECT_NAME,
      path: project.path,
      created_at: NOW.toISOString(),
      last_opened_at: NOW.toISOString(),
    });
    expect(mutations.fingerprints.some((fingerprint) => (
      fingerprint.files.length === 3
      && fingerprint.files.every((file) => file.state === 'missing')
    ))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'first_run_project',
      status: 'completed',
      projectId: UUID,
      filePaths: Object.keys(EXPECTED_FILES).sort(),
    }));
  });

  it('reserves the shared mutation lease before creating the UUID directory', async () => {
    fs.mkdirSync(path.join(dataRoot, 'first-run-projects'));
    const mutations = new FileMutationManager();
    const blocker = await mutations.acquireExternalLease({
      mutationId: 'block-first-run',
      kind: 'apply_patch',
      projectPath: projectRoot(dataRoot),
    });

    await expect(service(mutations).createTestProject()).rejects.toMatchObject({
      code: 'FIRST_RUN_PROJECT_BUSY',
      message: 'First-run test project creation is already in progress.',
    });
    expect(fs.existsSync(projectRoot(dataRoot))).toBe(false);
    blocker.release();
  });

  it('cleans an owned empty root under the outer lease when missing fingerprint capture fails', async () => {
    const mutations = new MissingFingerprintFailureManager();
    const fileSystem = {
      rmdir: async (target: string) => {
        expect(mutations.getActiveMutationCount()).toBe(1);
        await fs.promises.rmdir(target);
      },
    };

    await expect(service(mutations, { fileSystem }).createTestProject()).rejects.toMatchObject({
      code: 'FIRST_RUN_PROJECT_CREATE_FAILED',
    });
    expect(fs.existsSync(projectRoot(dataRoot))).toBe(false);
    expect(mutations.getActiveMutationCount()).toBe(0);
  });

  it('allows only one concurrent owner for the same UUID root', async () => {
    const mutations = new FileMutationManager();
    const create = service(mutations);

    const results = await Promise.allSettled([
      create.createTestProject(),
      create.createTestProject(),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => (
      result.status === 'rejected'
      && result.reason instanceof FirstRunProjectError
      && result.reason.code === 'FIRST_RUN_PROJECT_BUSY'
    ))).toHaveLength(1);
    expect(fs.readdirSync(path.join(dataRoot, 'first-run-projects'))).toEqual([UUID]);
  });

  it('rejects a first-run parent junction without touching its target', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    extraRoots.add(outside);
    fs.symlinkSync(
      outside,
      path.join(dataRoot, 'first-run-projects'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(service().createTestProject()).rejects.toMatchObject({
      code: 'FIRST_RUN_PROJECT_UNSAFE',
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects a pre-existing UUID project junction and preserves its target', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    extraRoots.add(outside);
    fs.mkdirSync(path.join(dataRoot, 'first-run-projects'));
    fs.symlinkSync(
      outside,
      projectRoot(dataRoot),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(service().createTestProject()).rejects.toMatchObject({
      code: 'FIRST_RUN_PROJECT_UNSAFE',
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('fails closed when the parent identity changes after root creation', async () => {
    const parent = path.join(dataRoot, 'first-run-projects');
    let parentStats = 0;
    const realLstat = (target: string) => fs.promises.lstat(target, { bigint: true });
    const fileSystem = {
      lstat: async (target: string) => {
        const stats = await realLstat(target);
        if (
          path.resolve(target).toLocaleLowerCase()
          !== path.resolve(parent).toLocaleLowerCase()
        ) return stats;
        parentStats += 1;
        if (parentStats === 1) return stats;
        return new Proxy(stats, {
          get(value, property, receiver) {
            if (property === 'dev') return value.dev + 1n;
            return Reflect.get(value, property, receiver);
          },
        });
      },
    };

    await expect(service(undefined, { fileSystem }).createTestProject()).rejects.toMatchObject({
      code: 'FIRST_RUN_PROJECT_UNSAFE',
    });
    expect(fs.existsSync(projectRoot(dataRoot))).toBe(true);
  });

  it('never overwrites or removes a colliding non-empty UUID root', async () => {
    fs.mkdirSync(projectRoot(dataRoot), { recursive: true });
    fs.writeFileSync(path.join(projectRoot(dataRoot), 'foreign.txt'), 'keep me', 'utf8');

    await expect(service().createTestProject()).rejects.toMatchObject({
      code: 'FIRST_RUN_PROJECT_CREATE_FAILED',
    });
    expect(fs.readFileSync(path.join(projectRoot(dataRoot), 'foreign.txt'), 'utf8')).toBe('keep me');
  });

  it('rolls a partial exclusive-write failure back while the owner lease is held', async () => {
    const statuses: string[] = [];
    let mutations!: SecondWriteFailureManager;
    mutations = new SecondWriteFailureManager({
      recordEvent: (event) => {
        statuses.push(event.status);
        if (event.status === 'rolled_back') expect(mutations.getActiveMutationCount()).toBe(1);
      },
    });

    await expect(service(mutations).createTestProject()).rejects.toEqual(expect.objectContaining({
      code: 'FIRST_RUN_PROJECT_CREATE_FAILED',
      message: 'Unable to create the first-run test project.',
    }));
    expect(fs.existsSync(projectRoot(dataRoot))).toBe(false);
    expect(database.getProject(UUID)).toBeNull();
    expect(statuses).toContain('rolled_back');
  });

  it('rolls all fixed files back when insert-only registration collides', async () => {
    database.createProject(UUID, 'Existing project', path.join(dataRoot, 'existing-project'), {
      createdAt: '2025-01-01T00:00:00.000Z',
      lastOpenedAt: '2025-01-01T00:00:00.000Z',
    });

    await expect(service().createTestProject()).rejects.toMatchObject({
      code: 'FIRST_RUN_PROJECT_CREATE_FAILED',
    });
    expect(fs.existsSync(projectRoot(dataRoot))).toBe(false);
    expect(database.getProject(UUID)?.name).toBe('Existing project');
  });

  it('rolls project registration and files back when the terminal event fails', async () => {
    const statuses: string[] = [];
    const mutations = new FileMutationManager({
      recordEvent: (event) => {
        statuses.push(event.status);
        if (event.status === 'completed') throw new Error('C:\\private\\event-database-error');
      },
    });

    await expect(service(mutations).createTestProject()).rejects.toEqual(expect.objectContaining({
      code: 'FIRST_RUN_PROJECT_CREATE_FAILED',
      message: 'Unable to create the first-run test project.',
    }));
    expect(database.getProject(UUID)).toBeNull();
    expect(fs.existsSync(projectRoot(dataRoot))).toBe(false);
    expect(statuses).toEqual(['completed', 'rolled_back']);
  });

  it('refuses rollback after the exact registered row is mutated', async () => {
    const mutations = new FileMutationManager({
      recordEvent: (event) => {
        if (event.status !== 'completed') return;
        database.updateProjectName(UUID, 'Replacement project');
        throw new Error('force rollback');
      },
    });

    await expect(service(mutations).createTestProject()).rejects.toMatchObject({
      code: 'FIRST_RUN_PROJECT_ROLLBACK_FAILED',
      message: 'Unable to safely roll back first-run test project creation.',
    });
    expect(database.getProject(UUID)?.name).toBe('Replacement project');
    expect(fs.existsSync(projectRoot(dataRoot))).toBe(true);
  });

  it('refuses rollback when a Session has claimed the registered project', async () => {
    const mutations = new FileMutationManager({
      recordEvent: (event) => {
        if (event.status !== 'completed') return;
        database.createSession('claimed-session', UUID, 'Claimed');
        throw new Error('force rollback');
      },
    });

    await expect(service(mutations).createTestProject()).rejects.toMatchObject({
      code: 'FIRST_RUN_PROJECT_ROLLBACK_FAILED',
    });
    expect(database.getProject(UUID)).not.toBeNull();
    expect(database.getSession('claimed-session')).not.toBeNull();
    expect(fs.existsSync(projectRoot(dataRoot))).toBe(true);
  });

  it.each([
    ['modified file', (root: string) => fs.writeFileSync(path.join(root, 'math.js'), 'modified', 'utf8')],
    ['unknown file', (root: string) => fs.writeFileSync(path.join(root, 'unknown.txt'), 'unknown', 'utf8')],
    ['symlink file', (root: string, outside: string) => {
      fs.unlinkSync(path.join(root, 'math.js'));
      fs.writeFileSync(path.join(outside, 'outside.js'), 'outside', 'utf8');
      fs.symlinkSync(path.join(outside, 'outside.js'), path.join(root, 'math.js'), 'file');
    }],
    ['hardlink file', (root: string, outside: string) => {
      fs.linkSync(path.join(root, 'math.js'), path.join(outside, 'math-copy.js'));
    }],
  ])('preserves the project when rollback sees a %s', async (_label, corrupt) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    extraRoots.add(outside);
    const mutations = new FileMutationManager({
      recordEvent: (event) => {
        if (event.status !== 'completed') return;
        corrupt(event.projectPath, outside);
        throw new Error(`force rollback from ${event.projectPath}`);
      },
    });

    await expect(service(mutations).createTestProject()).rejects.toEqual(expect.objectContaining({
      code: 'FIRST_RUN_PROJECT_ROLLBACK_FAILED',
      message: 'Unable to safely roll back first-run test project creation.',
    }));
    expect(database.getProject(UUID)).not.toBeNull();
    expect(fs.existsSync(projectRoot(dataRoot))).toBe(true);
  });
});
