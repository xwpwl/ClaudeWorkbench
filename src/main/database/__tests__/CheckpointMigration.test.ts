import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppDatabase,
  type CheckpointFileRow,
  type CheckpointRow,
} from '../Database';

const TEMP_PREFIX = 'claude-workbench-checkpoint-db-test-';
const PROJECT_ID = 'project-1';
const PROJECT_PATH = 'C:\\projects\\checkpoint-test';
const TASK_ID = 'task-1';

function removeTestDirectory(directory: string): void {
  const target = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function checkpoint(overrides: Partial<CheckpointRow> = {}): CheckpointRow {
  return {
    id: 'checkpoint-1',
    task_id: TASK_ID,
    project_path: PROJECT_PATH,
    type: 'before_task',
    created_at: '2026-01-01T00:00:00.000Z',
    git_commit: '0123456789abcdef',
    snapshot_path: 'C:\\snapshots\\checkpoint-1',
    metadata_json: '{"branch":"main"}',
    ...overrides,
  };
}

function checkpointFile(overrides: Partial<CheckpointFileRow> = {}): CheckpointFileRow {
  return {
    checkpoint_id: 'checkpoint-1',
    file_path: 'src/App.tsx',
    hash: 'sha256:abc',
    size: 123,
    modified_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('checkpoint SQLite schema v2 migration', () => {
  let directory: string;
  let databasePath: string;
  let database: AppDatabase | null;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    databasePath = path.join(directory, 'workbench.sqlite');
    database = null;
  });

  afterEach(() => {
    database?.close();
    removeTestDirectory(directory);
  });

  function createVersionOneDatabase(): void {
    const seed = new AppDatabase(databasePath);
    seed.createProject(PROJECT_ID, 'Checkpoint project', PROJECT_PATH);
    seed.createSession(TASK_ID, PROJECT_ID, 'Existing task');
    seed.createMessage('message-1', TASK_ID, 'user', 'Keep this message');
    seed.setSetting('theme', 'dark');
    seed.close();

    const raw = new BetterSqlite3(databasePath);
    raw.exec(`
      DROP TABLE review_issues;
      DROP TABLE reviews;
      DROP TABLE workflow_steps;
      DROP TABLE workflows;
      DROP TABLE checkpoint_files;
      DROP TABLE checkpoints;
      PRAGMA user_version = 1;
    `);
    raw.close();
  }

  function rawDatabase(): BetterSqlite3.Database {
    return new BetterSqlite3(databasePath);
  }

  it('reports schema version 7 for a fresh profile', () => {
    database = new AppDatabase(databasePath);
    expect(database.getMigrationInfo().schemaVersion).toBe(7);
  });

  it('automatically advances a v1 user_version to v7', () => {
    createVersionOneDatabase();
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    expect(raw.pragma('user_version', { simple: true })).toBe(7);
    raw.close();
  });

  it('creates both checkpoint tables during v1 migration', () => {
    createVersionOneDatabase();
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    const tables = raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('checkpoints', 'checkpoint_files')
      ORDER BY name
    `).all() as Array<{ name: string }>;
    raw.close();
    expect(tables.map((row) => row.name)).toEqual(['checkpoint_files', 'checkpoints']);
  });

  it('creates the complete checkpoints column contract', () => {
    createVersionOneDatabase();
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    const columns = raw.pragma('table_info(checkpoints)') as Array<{ name: string }>;
    raw.close();
    expect(columns.map((column) => column.name)).toEqual([
      'id', 'task_id', 'project_path', 'type', 'created_at',
      'git_commit', 'snapshot_path', 'metadata_json',
    ]);
  });

  it('creates the complete checkpoint_files column contract', () => {
    createVersionOneDatabase();
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    const columns = raw.pragma('table_info(checkpoint_files)') as Array<{ name: string }>;
    raw.close();
    expect(columns.map((column) => column.name)).toEqual([
      'checkpoint_id', 'file_path', 'hash', 'size', 'modified_at',
    ]);
  });

  it('adds task and checkpoint cascading foreign keys', () => {
    createVersionOneDatabase();
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    const checkpointForeignKeys = raw.pragma('foreign_key_list(checkpoints)') as Array<Record<string, unknown>>;
    const fileForeignKeys = raw.pragma('foreign_key_list(checkpoint_files)') as Array<Record<string, unknown>>;
    raw.close();
    expect(checkpointForeignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'tasks', from: 'task_id', to: 'id', on_delete: 'CASCADE' }),
    ]));
    expect(fileForeignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'checkpoints', from: 'checkpoint_id', to: 'id', on_delete: 'CASCADE' }),
    ]));
  });

  it('creates task, project, and file-path lookup indexes', () => {
    createVersionOneDatabase();
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    const indexes = raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'checkpoint%_idx'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    raw.close();
    expect(indexes.map((row) => row.name)).toEqual([
      'checkpoint_files_path_idx',
      'checkpoints_project_created_idx',
      'checkpoints_task_created_idx',
    ]);
  });

  it('preserves pre-migration projects, sessions, tasks, messages, and settings', () => {
    createVersionOneDatabase();
    database = new AppDatabase(databasePath);
    expect(database.getProject(PROJECT_ID)?.path).toBe(PROJECT_PATH);
    expect(database.getSession(TASK_ID)?.title).toBe('Existing task');
    expect(database.getTask(TASK_ID)?.project_id).toBe(PROJECT_ID);
    expect(database.listMessages(TASK_ID)[0]?.content).toBe('Keep this message');
    expect(database.getSetting('theme')).toBe('dark');
  });

  it('is idempotent when reopening an already migrated database', () => {
    createVersionOneDatabase();
    database = new AppDatabase(databasePath);
    database.createCheckpoint(checkpoint());
    database.close();
    database = new AppDatabase(databasePath);
    expect(database.getMigrationInfo().schemaVersion).toBe(7);
    expect(database.getCheckpoint('checkpoint-1')).toEqual(checkpoint());
  });

  it('completes a partially present v2 schema without losing checkpoints', () => {
    createVersionOneDatabase();
    const raw = rawDatabase();
    raw.exec(`
      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        git_commit TEXT,
        snapshot_path TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
    `);
    raw.prepare(`
      INSERT INTO checkpoints
        (id, task_id, project_path, type, created_at, git_commit, snapshot_path, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...Object.values(checkpoint()));
    raw.close();

    database = new AppDatabase(databasePath);
    expect(database.getCheckpoint('checkpoint-1')).toEqual(checkpoint());
    expect(database.listCheckpointFiles('checkpoint-1')).toEqual([]);
  });

  it('rolls back all v2 DDL and user_version when migration fails', () => {
    createVersionOneDatabase();
    const raw = rawDatabase();
    raw.exec(`
      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        git_commit TEXT,
        snapshot_path TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE checkpoint_files (checkpoint_id TEXT NOT NULL);
    `);
    raw.close();

    expect(() => new AppDatabase(databasePath)).toThrow();

    const inspected = rawDatabase();
    expect(inspected.pragma('user_version', { simple: true })).toBe(1);
    const indexes = inspected.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'checkpoints_%_idx'
    `).all();
    expect(indexes).toEqual([]);
    inspected.close();
  });

  it('keeps the original v1 file and data in place after a failed migration', () => {
    createVersionOneDatabase();
    const raw = rawDatabase();
    raw.exec('CREATE TABLE checkpoint_files (checkpoint_id TEXT NOT NULL)');
    raw.close();

    expect(() => new AppDatabase(databasePath)).toThrow();
    expect(fs.existsSync(databasePath)).toBe(true);

    const inspected = rawDatabase();
    expect(inspected.prepare('SELECT content FROM messages WHERE id = ?').get('message-1')).toEqual({
      content: 'Keep this message',
    });
    expect(inspected.prepare('SELECT value FROM settings WHERE key = ?').get('theme')).toEqual({ value: 'dark' });
    inspected.close();
  });

  it('rejects a newer schema without downgrading or deleting its data', () => {
    createVersionOneDatabase();
    const raw = rawDatabase();
    raw.exec(`
      CREATE TABLE future_data (value TEXT NOT NULL);
      INSERT INTO future_data (value) VALUES ('keep-me');
      PRAGMA user_version = 8;
    `);
    raw.close();

    expect(() => new AppDatabase(databasePath)).toThrow(/newer than supported/);
    const inspected = rawDatabase();
    expect(inspected.pragma('user_version', { simple: true })).toBe(8);
    expect(inspected.prepare('SELECT value FROM future_data').get()).toEqual({ value: 'keep-me' });
    inspected.close();
  });
});

describe('checkpoint persistence API', () => {
  let directory: string;
  let databasePath: string;
  let database: AppDatabase;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    databasePath = path.join(directory, 'workbench.sqlite');
    database = new AppDatabase(databasePath);
    database.createProject(PROJECT_ID, 'Checkpoint project', PROJECT_PATH);
    database.createSession(TASK_ID, PROJECT_ID, 'Checkpoint task');
  });

  afterEach(() => {
    database.close();
    removeTestDirectory(directory);
  });

  it('creates and reads a checkpoint without transforming its fields', () => {
    database.createCheckpoint(checkpoint());
    expect(database.getCheckpoint('checkpoint-1')).toEqual(checkpoint());
  });

  it('round-trips nullable Git and snapshot references', () => {
    const row = checkpoint({ git_commit: null, snapshot_path: null });
    database.createCheckpoint(row);
    expect(database.getCheckpoint(row.id)).toEqual(row);
  });

  it('returns null for an unknown checkpoint', () => {
    expect(database.getCheckpoint('missing')).toBeNull();
  });

  it('isolates checkpoint lists by task id', () => {
    database.createSession('task-2', PROJECT_ID, 'Other task');
    database.createCheckpoint(checkpoint());
    database.createCheckpoint(checkpoint({ id: 'checkpoint-2', task_id: 'task-2' }));
    expect(database.listCheckpoints(TASK_ID).map((row) => row.id)).toEqual(['checkpoint-1']);
    expect(database.listCheckpoints('task-2').map((row) => row.id)).toEqual(['checkpoint-2']);
  });

  it('optionally filters a task checkpoint list by project path', () => {
    database.createCheckpoint(checkpoint());
    database.createCheckpoint(checkpoint({ id: 'checkpoint-2', project_path: 'C:\\projects\\other' }));
    expect(database.listCheckpoints(TASK_ID, PROJECT_PATH).map((row) => row.id)).toEqual(['checkpoint-1']);
    expect(database.listCheckpoints(TASK_ID, 'C:\\projects\\other').map((row) => row.id)).toEqual(['checkpoint-2']);
  });

  it('orders checkpoints newest first with a stable id tie-breaker', () => {
    database.createCheckpoint(checkpoint({ id: 'a', created_at: '2026-01-01T00:00:00.000Z' }));
    database.createCheckpoint(checkpoint({ id: 'b', created_at: '2026-01-02T00:00:00.000Z' }));
    database.createCheckpoint(checkpoint({ id: 'c', created_at: '2026-01-02T00:00:00.000Z' }));
    expect(database.listCheckpoints(TASK_ID).map((row) => row.id)).toEqual(['c', 'b', 'a']);
  });

  it('supports bounded checkpoint pagination', () => {
    for (let index = 0; index < 4; index += 1) {
      database.createCheckpoint(checkpoint({
        id: `checkpoint-${index}`,
        created_at: `2026-01-0${index + 1}T00:00:00.000Z`,
      }));
    }
    expect(database.listCheckpoints(TASK_ID, undefined, { limit: 2, offset: 1 })
      .map((row) => row.id)).toEqual(['checkpoint-2', 'checkpoint-1']);
  });

  it('atomically creates a checkpoint together with its file index', () => {
    const files = [
      checkpointFile(),
      checkpointFile({ file_path: 'src/main.ts', hash: 'sha256:def', size: 456 }),
    ];
    database.createCheckpoint(checkpoint(), files);
    expect(database.getCheckpoint('checkpoint-1')).toEqual(checkpoint());
    expect(database.listCheckpointFiles('checkpoint-1')).toEqual([
      checkpointFile(),
      checkpointFile({ file_path: 'src/main.ts', hash: 'sha256:def', size: 456 }),
    ]);
  });

  it('adds a file index to an existing checkpoint', () => {
    database.createCheckpoint(checkpoint());
    database.createCheckpointFile(checkpointFile());
    expect(database.listCheckpointFiles('checkpoint-1')).toEqual([checkpointFile()]);
  });

  it('lists checkpoint files in deterministic path order', () => {
    database.createCheckpoint(checkpoint());
    database.createCheckpointFile(checkpointFile({ file_path: 'z-last.ts' }));
    database.createCheckpointFile(checkpointFile({ file_path: 'a-first.ts' }));
    expect(database.listCheckpointFiles('checkpoint-1').map((row) => row.file_path)).toEqual([
      'a-first.ts', 'z-last.ts',
    ]);
  });

  it('upserts a file index by checkpoint and path', () => {
    database.createCheckpoint(checkpoint());
    database.createCheckpointFile(checkpointFile());
    database.createCheckpointFile(checkpointFile({ hash: 'sha256:updated', size: 999 }));
    expect(database.listCheckpointFiles('checkpoint-1')).toEqual([
      checkpointFile({ hash: 'sha256:updated', size: 999 }),
    ]);
  });

  it('allows the same file path in different checkpoints', () => {
    database.createCheckpoint(checkpoint());
    database.createCheckpoint(checkpoint({ id: 'checkpoint-2' }));
    database.createCheckpointFile(checkpointFile());
    database.createCheckpointFile(checkpointFile({ checkpoint_id: 'checkpoint-2', hash: 'sha256:second' }));
    expect(database.listCheckpointFiles('checkpoint-1')).toHaveLength(1);
    expect(database.listCheckpointFiles('checkpoint-2')[0]?.hash).toBe('sha256:second');
  });

  it('rejects a checkpoint whose task does not exist', () => {
    expect(() => database.createCheckpoint(checkpoint({ task_id: 'missing-task' }))).toThrow();
    expect(database.getCheckpoint('checkpoint-1')).toBeNull();
  });

  it('rejects a checkpoint file whose checkpoint does not exist', () => {
    expect(() => database.createCheckpointFile(checkpointFile())).toThrow();
    expect(database.listCheckpointFiles('checkpoint-1')).toEqual([]);
  });

  it('rolls back the checkpoint when a batch contains a mismatched file owner', () => {
    expect(() => database.createCheckpoint(checkpoint(), [
      checkpointFile(),
      checkpointFile({ checkpoint_id: 'different-checkpoint', file_path: 'src/bad.ts' }),
    ])).toThrow(/belongs to different-checkpoint/);
    expect(database.getCheckpoint('checkpoint-1')).toBeNull();
    expect(database.listCheckpointFiles('checkpoint-1')).toEqual([]);
  });

  it('deletes a checkpoint and cascades to all indexed files', () => {
    database.createCheckpoint(checkpoint(), [checkpointFile()]);
    expect(database.deleteCheckpoint('checkpoint-1')).toBe(true);
    expect(database.getCheckpoint('checkpoint-1')).toBeNull();
    expect(database.listCheckpointFiles('checkpoint-1')).toEqual([]);
  });

  it('returns false when deleting an unknown checkpoint', () => {
    expect(database.deleteCheckpoint('missing')).toBe(false);
  });

  it('cascades checkpoints and files when their task session is deleted', () => {
    database.createCheckpoint(checkpoint(), [checkpointFile()]);
    database.deleteSession(TASK_ID);
    expect(database.getCheckpoint('checkpoint-1')).toBeNull();
    expect(database.listCheckpointFiles('checkpoint-1')).toEqual([]);
  });

  it('persists checkpoints and files across a database restart', () => {
    database.createCheckpoint(checkpoint(), [checkpointFile()]);
    database.close();
    database = new AppDatabase(databasePath);
    expect(database.getCheckpoint('checkpoint-1')).toEqual(checkpoint());
    expect(database.listCheckpointFiles('checkpoint-1')).toEqual([checkpointFile()]);
  });

  it('participates in an outer database transaction rollback', () => {
    expect(() => database.runInTransaction(() => {
      database.createCheckpoint(checkpoint(), [checkpointFile()]);
      throw new Error('abort test transaction');
    })).toThrow('abort test transaction');
    expect(database.getCheckpoint('checkpoint-1')).toBeNull();
  });

  it('does not replace an existing checkpoint or discard its files on duplicate id', () => {
    database.createCheckpoint(checkpoint(), [checkpointFile()]);
    expect(() => database.createCheckpoint(checkpoint({ type: 'task_completed' }))).toThrow();
    expect(database.getCheckpoint('checkpoint-1')?.type).toBe('before_task');
    expect(database.listCheckpointFiles('checkpoint-1')).toEqual([checkpointFile()]);
  });

  it('preserves Unicode metadata JSON as an opaque deterministic payload', () => {
    const metadata = JSON.stringify({ branch: '功能/检查点', status: ['M src/应用.tsx'] });
    database.createCheckpoint(checkpoint({ metadata_json: metadata }));
    expect(database.getCheckpoint('checkpoint-1')?.metadata_json).toBe(metadata);
  });
});
