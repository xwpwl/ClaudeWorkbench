import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import path from 'node:path';
import type { Project } from '../../shared/types/project';
import type { AppDatabase, ProjectRow } from '../database/Database';
import {
  FileMutationConflictError,
  FileMutationManager,
  FileMutationPathError,
  FileMutationRollbackError,
  type FileMutationContext,
  type FileMutationFingerprint,
} from '../file-mutations/FileMutationManager';

export type FirstRunProjectErrorCode =
  | 'FIRST_RUN_PROJECT_BUSY'
  | 'FIRST_RUN_PROJECT_UNSAFE'
  | 'FIRST_RUN_PROJECT_CREATE_FAILED'
  | 'FIRST_RUN_PROJECT_ROLLBACK_FAILED';

const ERROR_MESSAGES: Record<FirstRunProjectErrorCode, string> = {
  FIRST_RUN_PROJECT_BUSY: 'First-run test project creation is already in progress.',
  FIRST_RUN_PROJECT_UNSAFE: 'The first-run test project location is unsafe.',
  FIRST_RUN_PROJECT_CREATE_FAILED: 'Unable to create the first-run test project.',
  FIRST_RUN_PROJECT_ROLLBACK_FAILED: 'Unable to safely roll back first-run test project creation.',
};

const PROJECT_NAME = 'Claude Workbench Test Project';
const FIRST_RUN_PARENT = 'first-run-projects';
const PROJECT_FILES: Readonly<Record<string, string>> = Object.freeze({
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
});
const FILE_NAMES = Object.freeze(Object.keys(PROJECT_FILES).sort());
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

interface ParentOwnership {
  path: string;
  realPath: string;
  identity: FileIdentity;
}

interface RootOwnership {
  path: string;
  realPath: string;
  identity: FileIdentity;
}

interface FirstRunFileSystem {
  lstat(target: string): Promise<Stats | BigIntStats>;
  realpath(target: string): Promise<string>;
  mkdir(target: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  readdir(target: string): Promise<string[]>;
  readFile(target: string): Promise<Buffer>;
  rmdir(target: string): Promise<void>;
}

export interface FirstRunServiceOptions {
  dataRoot: string;
  database: AppDatabase;
  fileMutations: FileMutationManager;
  randomUUID?: () => string;
  now?: () => Date;
  fileSystem?: Partial<FirstRunFileSystem>;
}

interface CreationOwnership {
  rootCreated: boolean;
  root: RootOwnership | null;
  row: ProjectRow | null;
  written: Set<string>;
  fingerprint: FileMutationFingerprint | null;
}

export class FirstRunProjectError extends Error {
  constructor(readonly code: FirstRunProjectErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'FirstRunProjectError';
  }
}

function canonicalKey(target: string): string {
  const normalized = path.normalize(path.resolve(target));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return canonicalKey(left) === canonicalKey(right);
}

function identity(stats: Stats | BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function identityMatches(expected: FileIdentity, actual: Stats | BigIntStats): boolean {
  const comparable = expected.dev !== 0 || expected.ino !== 0 || actual.dev !== 0 || actual.ino !== 0;
  return !comparable || (expected.dev === actual.dev && expected.ino === actual.ino);
}

function errno(error: unknown): string | undefined {
  return error && typeof error === 'object'
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function exactStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function isSingleLink(value: number | bigint): boolean {
  return value === 1 || value === 1n;
}

export class FirstRunService {
  private readonly dataRoot: string;
  private readonly database: AppDatabase;
  private readonly fileMutations: FileMutationManager;
  private readonly randomUUID: () => string;
  private readonly now: () => Date;
  private readonly fileSystem: FirstRunFileSystem;

  constructor(options: FirstRunServiceOptions) {
    this.dataRoot = path.resolve(options.dataRoot);
    this.database = options.database;
    this.fileMutations = options.fileMutations;
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date());
    this.fileSystem = {
      lstat: options.fileSystem?.lstat ?? ((target) => fs.lstat(target, { bigint: true })),
      realpath: options.fileSystem?.realpath ?? ((target) => fs.realpath(target)),
      mkdir: options.fileSystem?.mkdir ?? ((target, mkdirOptions) => fs.mkdir(target, mkdirOptions)),
      readdir: options.fileSystem?.readdir ?? ((target) => fs.readdir(target)),
      readFile: options.fileSystem?.readFile ?? ((target) => fs.readFile(target)),
      rmdir: options.fileSystem?.rmdir ?? ((target) => fs.rmdir(target)),
    };
  }

  async createTestProject(): Promise<Project> {
    try {
      const parent = await this.prepareParent();
      const projectId = this.randomUUID();
      if (!UUID_PATTERN.test(projectId)) {
        throw new FirstRunProjectError('FIRST_RUN_PROJECT_CREATE_FAILED');
      }
      const candidate = path.join(parent.realPath, projectId);
      if (!samePath(path.dirname(candidate), parent.realPath)) {
        throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
      }

      const lease = await this.fileMutations.acquireExternalLease({
        mutationId: `first-run-project:${projectId}`,
        kind: 'first_run_project',
        projectId,
        projectPath: candidate,
        filePaths: FILE_NAMES,
      });
      const ownership: CreationOwnership = {
        rootCreated: false,
        root: null,
        row: null,
        written: new Set(),
        fingerprint: null,
      };
      try {
        return await lease.run(async () => {
          await this.createOwnedRoot(parent, candidate, ownership);
          let missing: FileMutationFingerprint;
          try {
            missing = await this.fileMutations.fingerprint(candidate, FILE_NAMES);
          } catch (error) {
            await this.cleanupEmptyOwnedRoot(parent, ownership);
            throw error;
          }
          let mutationEntered = false;
          try {
            return await this.fileMutations.runMutation({
              mutationId: `first-run-project:${projectId}`,
              kind: 'first_run_project',
              projectId,
              projectPath: candidate,
              filePaths: FILE_NAMES,
              expectedFingerprint: missing,
            }, {
              mutate: async (context) => {
                mutationEntered = true;
                for (const fileName of FILE_NAMES) {
                  await context.writeFileExclusive(fileName, PROJECT_FILES[fileName]);
                  ownership.written.add(fileName);
                }
                await this.assertOwnedRoot(parent, ownership.root);
                ownership.fingerprint = await context.fingerprint(FILE_NAMES);
                await this.assertOwnedFiles(context, ownership);
                const timestamp = this.now().toISOString();
                const row: ProjectRow = {
                  id: projectId,
                  name: PROJECT_NAME,
                  path: ownership.root!.realPath,
                  created_at: timestamp,
                  last_opened_at: timestamp,
                };
                if (!this.database.insertProjectIfAbsent(row)) {
                  throw new FirstRunProjectError('FIRST_RUN_PROJECT_CREATE_FAILED');
                }
                ownership.row = row;
                return {
                  id: row.id,
                  name: row.name,
                  path: row.path,
                  createdAt: row.created_at,
                  lastOpenedAt: row.last_opened_at,
                } satisfies Project;
              },
              rollback: async (context) => {
                await this.rollbackOwnedProject(parent, context, ownership);
              },
            });
          } catch (error) {
            if (!mutationEntered && ownership.rootCreated) {
              await this.cleanupEmptyOwnedRoot(parent, ownership);
            }
            throw error;
          }
        });
      } finally {
        lease.release();
      }
    } catch (error) {
      throw this.publicError(error);
    }
  }

  private async prepareParent(): Promise<ParentOwnership> {
    let dataStats: Stats | BigIntStats;
    let realDataRoot: string;
    try {
      dataStats = await this.fileSystem.lstat(this.dataRoot);
      realDataRoot = await this.fileSystem.realpath(this.dataRoot);
    } catch {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
    if (!dataStats.isDirectory() || dataStats.isSymbolicLink()) {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
    const parentPath = path.join(realDataRoot, FIRST_RUN_PARENT);
    if (!samePath(path.dirname(parentPath), realDataRoot)) {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
    try {
      await this.fileSystem.mkdir(parentPath, { recursive: false });
    } catch (error) {
      if (errno(error) !== 'EEXIST') {
        throw new FirstRunProjectError('FIRST_RUN_PROJECT_CREATE_FAILED');
      }
    }
    const parentStats = await this.safeLstat(parentPath);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
    const realParent = await this.safeRealpath(parentPath);
    if (!samePath(realParent, parentPath) || !samePath(path.dirname(realParent), realDataRoot)) {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
    return { path: parentPath, realPath: realParent, identity: identity(parentStats) };
  }

  private async createOwnedRoot(
    parent: ParentOwnership,
    candidate: string,
    ownership: CreationOwnership,
  ): Promise<void> {
    try {
      await this.fileSystem.mkdir(candidate, { recursive: false });
      ownership.rootCreated = true;
    } catch (error) {
      if (errno(error) === 'EEXIST') {
        const collision = await this.safeLstat(candidate);
        if (collision.isSymbolicLink()) {
          throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
        }
      }
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_CREATE_FAILED');
    }
    const rootStats = await this.safeLstat(candidate);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
    const realRoot = await this.safeRealpath(candidate);
    ownership.root = { path: candidate, realPath: realRoot, identity: identity(rootStats) };
    await this.assertOwnedRoot(parent, ownership.root);
    if ((await this.fileSystem.readdir(realRoot)).length !== 0) {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
  }

  private async assertParent(parent: ParentOwnership): Promise<void> {
    const current = await this.safeLstat(parent.path);
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || !identityMatches(parent.identity, current)
      || !samePath(await this.safeRealpath(parent.path), parent.realPath)
    ) {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
  }

  private async assertOwnedRoot(
    parent: ParentOwnership,
    root: RootOwnership | null,
  ): Promise<void> {
    if (!root) throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    await this.assertParent(parent);
    const current = await this.safeLstat(root.path);
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || !identityMatches(root.identity, current)
      || !samePath(await this.safeRealpath(root.path), root.realPath)
      || !samePath(path.dirname(root.realPath), parent.realPath)
    ) {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
  }

  private async assertOwnedFiles(
    context: FileMutationContext,
    ownership: CreationOwnership,
  ): Promise<void> {
    const written = [...ownership.written].sort();
    const entries = await this.fileSystem.readdir(ownership.root!.realPath);
    if (!exactStringSet(entries, written)) {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
    const currentFingerprint = await context.fingerprint(written);
    if (
      ownership.fingerprint
      && written.length === FILE_NAMES.length
      && currentFingerprint.digest !== ownership.fingerprint.digest
    ) {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
    for (const fileName of written) {
      const target = path.join(ownership.root!.realPath, fileName);
      const stats = await this.safeLstat(target);
      if (!stats.isFile() || stats.isSymbolicLink() || !isSingleLink(stats.nlink)) {
        throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
      }
      const actual = await this.fileSystem.readFile(target);
      if (!actual.equals(Buffer.from(PROJECT_FILES[fileName], 'utf8'))) {
        throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
      }
    }
  }

  private async rollbackOwnedProject(
    parent: ParentOwnership,
    context: FileMutationContext,
    ownership: CreationOwnership,
  ): Promise<void> {
    await this.assertOwnedRoot(parent, ownership.root);
    await this.assertOwnedFiles(context, ownership);
    if (ownership.row && !this.database.deleteProjectIfExactOwner(ownership.row)) {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
    for (const fileName of [...ownership.written].sort()) {
      await context.removeFile(fileName);
    }
    await this.assertOwnedRoot(parent, ownership.root);
    if ((await this.fileSystem.readdir(ownership.root!.realPath)).length !== 0) {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
    await this.fileSystem.rmdir(ownership.root!.realPath);
    ownership.rootCreated = false;
  }

  private async cleanupEmptyOwnedRoot(
    parent: ParentOwnership,
    ownership: CreationOwnership,
  ): Promise<void> {
    try {
      await this.assertOwnedRoot(parent, ownership.root);
      if ((await this.fileSystem.readdir(ownership.root!.realPath)).length !== 0) {
        throw new Error('Owned root is no longer empty.');
      }
      await this.fileSystem.rmdir(ownership.root!.realPath);
      ownership.rootCreated = false;
    } catch {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_ROLLBACK_FAILED');
    }
  }

  private async safeLstat(target: string): Promise<Stats | BigIntStats> {
    try {
      return await this.fileSystem.lstat(target);
    } catch {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
  }

  private async safeRealpath(target: string): Promise<string> {
    try {
      return await this.fileSystem.realpath(target);
    } catch {
      throw new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
  }

  private publicError(error: unknown): FirstRunProjectError {
    if (error instanceof FirstRunProjectError) return new FirstRunProjectError(error.code);
    if (error instanceof FileMutationConflictError) {
      return new FirstRunProjectError('FIRST_RUN_PROJECT_BUSY');
    }
    if (error instanceof FileMutationRollbackError) {
      return new FirstRunProjectError('FIRST_RUN_PROJECT_ROLLBACK_FAILED');
    }
    if (error instanceof FileMutationPathError) {
      return new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE');
    }
    return new FirstRunProjectError('FIRST_RUN_PROJECT_CREATE_FAILED');
  }
}
