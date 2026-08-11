import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../Database';

const PREFIX = 'claude-workbench-release-migration-';

describe('v0.9/v3 to v1.0/v4 release migration', () => {
  let root: string;
  let databasePath: string;
  let database: AppDatabase | null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
    databasePath = path.join(root, 'workbench.db');
    database = null;
  });

  afterEach(() => {
    database?.close();
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) {
      throw new Error(`Refusing to remove unexpected fixture: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  function createVersionThreeFixture(): void {
    const current = new AppDatabase(databasePath);
    current.createProject('project', 'Preserved project', root);
    current.createSession('task', 'project', 'Preserved task');
    current.createMessage('message', 'task', 'user', 'preserved request');
    current.createWorkflow({
      id: 'workflow', task_id: 'task', status: 'completed', current_stage: null,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:01:00.000Z',
      metadata_json: JSON.stringify({
        version: 1, projectId: 'project', projectPath: root, projectKey: root,
        sessionKey: `${root}::task`, resumeSessionId: null, prompt: 'preserved request',
        modelPolicy: {}, plan: null, latestReview: null, reviewRound: 1,
        maxReviewRounds: 3, fixRound: 1, maxFixRounds: 3, revision: 2,
        activeStage: null, pausedFrom: null, failure: null, currentModel: null,
        currentPermissionMode: 'default', executionCycle: 1, reviewAccepted: false,
        pauseReason: null,
      }),
    });
    current.createWorkflowStep({
      id: 'step', workflow_id: 'workflow', agent_type: 'coder', review_round: 1,
      status: 'completed', input: '{}', output: '{}', error: null,
      started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:01:00.000Z',
    });
    current.close();
    const raw = new BetterSqlite3(databasePath);
    raw.exec(`
      DROP TABLE recovery_items;
      DROP TABLE permission_requests;
      DROP TABLE mutation_operations;
      DROP TABLE managed_processes;
      DROP TABLE app_runs;
      PRAGMA user_version = 3;
    `);
    raw.close();
  }

  it('advances the fixed v0.9 fixture to the current schema v7', () => {
    createVersionThreeFixture();
    database = new AppDatabase(databasePath);
    expect(database.getMigrationInfo().schemaVersion).toBe(7);
  });

  it('preserves projects, sessions, messages, tasks and workflow stages byte-for-byte', () => {
    createVersionThreeFixture();
    database = new AppDatabase(databasePath);
    expect(database.getProject('project')?.name).toBe('Preserved project');
    expect(database.getSession('task')?.title).toBe('Preserved task');
    expect(database.listMessages('task')[0]?.content).toBe('preserved request');
    expect(database.getTask('task')?.project_id).toBe('project');
    expect(database.getWorkflowStep('step')).toMatchObject({ status: 'completed', output: '{}' });
  });

  it('creates every production recovery journal table', () => {
    createVersionThreeFixture();
    database = new AppDatabase(databasePath);
    const raw = new BetterSqlite3(databasePath, { readonly: true });
    const tables = raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
        ('app_runs', 'managed_processes', 'mutation_operations', 'permission_requests', 'recovery_items')
      ORDER BY name
    `).all() as Array<{ name: string }>;
    raw.close();
    expect(tables.map((row) => row.name)).toEqual([
      'app_runs', 'managed_processes', 'mutation_operations', 'permission_requests', 'recovery_items',
    ]);
  });

  it('accepts the interrupted workflow step status after migration', () => {
    createVersionThreeFixture();
    database = new AppDatabase(databasePath);
    database.upsertWorkflowStep({
      ...database.getWorkflowStep('step')!, status: 'interrupted', error: 'APP_CRASH',
    });
    expect(database.getWorkflowStep('step')?.status).toBe('interrupted');
  });

  it('passes integrity and foreign-key validation after migration', () => {
    createVersionThreeFixture();
    database = new AppDatabase(databasePath);
    const raw = new BetterSqlite3(databasePath, { readonly: true });
    expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(raw.pragma('foreign_key_check')).toEqual([]);
    raw.close();
  });

  it('rolls back the complete v4 step when a late release table is incompatible', () => {
    createVersionThreeFixture();
    const raw = new BetterSqlite3(databasePath);
    raw.exec('CREATE TABLE app_runs (id TEXT PRIMARY KEY)');
    raw.close();
    expect(() => new AppDatabase(databasePath)).toThrow();
    const inspected = new BetterSqlite3(databasePath, { readonly: true });
    expect(inspected.pragma('user_version', { simple: true })).toBe(3);
    expect(inspected.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('recovery_items')).toBeUndefined();
    expect(inspected.prepare('SELECT title FROM sessions WHERE id = ?').get('task')).toEqual({ title: 'Preserved task' });
    inspected.close();
  });

  it('is idempotent on repeated v1.0 launches', () => {
    createVersionThreeFixture();
    const first = new AppDatabase(databasePath);
    first.close();
    database = new AppDatabase(databasePath);
    expect(database.getMigrationInfo().schemaVersion).toBe(7);
    expect(database.countWorkflowSteps('workflow')).toBe(1);
  });

  it('returns summary counts without exposing database contents', () => {
    createVersionThreeFixture();
    database = new AppDatabase(databasePath);
    const summary = database.getDiagnosticsSummary();
    expect(summary).toMatchObject({ schemaVersion: 7, integrity: 'ok', counts: { projects: 1, sessions: 1, messages: 1 } });
    expect(JSON.stringify(summary)).not.toContain('preserved request');
  });

  it('rejects a schema newer than the v1.0 client', () => {
    createVersionThreeFixture();
    const raw = new BetterSqlite3(databasePath);
    raw.pragma('user_version = 8');
    raw.close();
    expect(() => new AppDatabase(databasePath)).toThrow(/newer than supported/i);
  });
});
