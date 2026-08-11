import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppDatabase,
  type CheckpointFileRow,
  type CheckpointRow,
  type ReviewIssueRow,
  type ReviewRow,
  type WorkflowRow,
  type WorkflowStepRow,
} from '../Database';

const TEMP_PREFIX = 'claude-workbench-workflow-migration-test-';
const PROJECT_ID = 'workflow-project';
const PROJECT_PATH = 'C:\\projects\\workflow-migration';
const TASK_ID = 'workflow-task';
const CREATED_AT = '2026-07-01T00:00:00.000Z';
const UPDATED_AT = '2026-07-01T00:01:00.000Z';

function removeTestDirectory(directory: string): void {
  const target = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function checkpoint(): CheckpointRow {
  return {
    id: 'checkpoint-v2',
    task_id: TASK_ID,
    project_path: PROJECT_PATH,
    type: 'before_task',
    created_at: CREATED_AT,
    git_commit: '0123456789abcdef',
    snapshot_path: 'C:\\snapshots\\checkpoint-v2',
    metadata_json: '{"source":"v2"}',
  };
}

function checkpointFile(): CheckpointFileRow {
  return {
    checkpoint_id: 'checkpoint-v2',
    file_path: 'src/preserved.ts',
    hash: 'sha256:preserved',
    size: 42,
    modified_at: CREATED_AT,
  };
}

function workflow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    id: 'workflow-1',
    task_id: TASK_ID,
    status: 'planning',
    current_stage: 'planner',
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    metadata_json: '{"revision":1}',
    ...overrides,
  };
}

function workflowStep(overrides: Partial<WorkflowStepRow> = {}): WorkflowStepRow {
  return {
    id: 'step-1',
    workflow_id: 'workflow-1',
    agent_type: 'planner',
    review_round: 0,
    status: 'completed',
    input: '{"prompt":"Plan the change"}',
    output: '{"summary":"Plan ready"}',
    error: null,
    started_at: CREATED_AT,
    completed_at: UPDATED_AT,
    ...overrides,
  };
}

function review(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: 'review-1',
    workflow_id: 'workflow-1',
    step_id: 'step-1',
    review_round: 1,
    score: 8.5,
    summary: 'One issue remains',
    tests_passed: 7,
    tests_failed: 1,
    tests_skipped: 2,
    created_at: UPDATED_AT,
    ...overrides,
  };
}

function reviewIssue(overrides: Partial<ReviewIssueRow> = {}): ReviewIssueRow {
  return {
    id: 'issue-1',
    review_id: 'review-1',
    severity: 'high',
    file_path: 'src/workflow.ts',
    line: 27,
    title: 'Handle the failed transition',
    recommendation: 'Keep the previous durable state.',
    resolved: false,
    created_at: UPDATED_AT,
    ...overrides,
  };
}

describe('workflow SQLite schema v3 migration', () => {
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

  function rawDatabase(): BetterSqlite3.Database {
    const raw = new BetterSqlite3(databasePath);
    raw.pragma('foreign_keys = ON');
    return raw;
  }

  function createVersionTwoDatabase(): void {
    const seed = new AppDatabase(databasePath);
    seed.createProject(PROJECT_ID, 'Workflow migration', PROJECT_PATH, {
      createdAt: CREATED_AT,
      lastOpenedAt: UPDATED_AT,
    });
    seed.createSession(TASK_ID, PROJECT_ID, 'Preserve the v2 task');
    seed.createMessage('message-v2', TASK_ID, 'user', 'Keep this message');
    seed.createEvent('event-v2', TASK_ID, 'task_started', '{"source":"v2"}', CREATED_AT);
    seed.createFileChange('change-v2', TASK_ID, 'src/preserved.ts', 'modified', 4, 2);
    seed.setSetting('workflow-test-setting', 'preserve-me');
    seed.setProjectSettings(PROJECT_ID, { favorite: true, disabled_mcp_servers: ['legacy-server'] });
    seed.createPermission({
      id: 'permission-v2',
      session_id: TASK_ID,
      run_id: 'run-v2',
      tool_name: 'Write',
      decision: 'allow_once',
      created_at: CREATED_AT,
      resolved_at: UPDATED_AT,
    });
    seed.createCheckpoint(checkpoint(), [checkpointFile()]);
    seed.close();

    const raw = rawDatabase();
    // A fixture produced by the current AppDatabase must be downgraded in
    // dependency order. Merely changing user_version would leave a fake v2 DB.
    raw.exec(`
      DROP TABLE review_issues;
      DROP TABLE reviews;
      DROP TABLE workflow_steps;
      DROP TABLE workflows;
      PRAGMA user_version = 2;
    `);
    raw.close();
  }

  function openMigratedVersionTwo(): AppDatabase {
    createVersionTwoDatabase();
    database = new AppDatabase(databasePath);
    return database;
  }

  function columnNames(table: string): string[] {
    const raw = rawDatabase();
    const columns = raw.pragma(`table_info(${table})`) as Array<{ name: string }>;
    raw.close();
    return columns.map((column) => column.name);
  }

  function createWorkflowGraph(db: AppDatabase): void {
    db.createWorkflow(workflow());
    db.createWorkflowStep(workflowStep());
    db.createReview(review(), [reviewIssue()]);
  }

  it('creates a fresh profile at schema version 7', () => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    expect(database.getMigrationInfo().schemaVersion).toBe(7);
    expect(raw.pragma('user_version', { simple: true })).toBe(7);
    raw.close();
  });

  it('automatically advances an actual v2 database to v7', () => {
    openMigratedVersionTwo();
    const raw = rawDatabase();
    expect(raw.pragma('user_version', { simple: true })).toBe(7);
    raw.close();
  });

  it('creates all four workflow and review tables during v2 migration', () => {
    openMigratedVersionTwo();
    const raw = rawDatabase();
    const tables = raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('workflows', 'workflow_steps', 'reviews', 'review_issues')
      ORDER BY name
    `).all() as Array<{ name: string }>;
    raw.close();
    expect(tables.map((row) => row.name)).toEqual([
      'review_issues', 'reviews', 'workflow_steps', 'workflows',
    ]);
  });

  it('creates the complete column contracts for all four new tables', () => {
    database = new AppDatabase(databasePath);
    expect(columnNames('workflows')).toEqual([
      'id', 'task_id', 'status', 'current_stage', 'created_at', 'updated_at', 'metadata_json',
    ]);
    expect(columnNames('workflow_steps')).toEqual([
      'id', 'workflow_id', 'agent_type', 'review_round', 'status', 'input', 'output', 'error',
      'started_at', 'completed_at',
    ]);
    expect(columnNames('reviews')).toEqual([
      'id', 'workflow_id', 'step_id', 'review_round', 'score', 'summary',
      'tests_passed', 'tests_failed', 'tests_skipped', 'created_at',
    ]);
    expect(columnNames('review_issues')).toEqual([
      'id', 'review_id', 'severity', 'file_path', 'line', 'title',
      'recommendation', 'resolved', 'created_at',
    ]);
  });

  it('applies stable JSON, test-count, and resolution defaults', () => {
    const db = openMigratedVersionTwo();
    const raw = rawDatabase();
    raw.prepare(`
      INSERT INTO workflows (id, task_id, status, current_stage, created_at, updated_at)
      VALUES ('workflow-defaults', ?, 'idle', NULL, ?, ?)
    `).run(TASK_ID, CREATED_AT, UPDATED_AT);
    raw.prepare(`
      INSERT INTO workflow_steps
        (id, workflow_id, agent_type, status, input, output, started_at, completed_at)
      VALUES ('step-defaults', 'workflow-defaults', 'planner', 'pending', '{}', NULL, NULL, NULL)
    `).run();
    raw.prepare(`
      INSERT INTO reviews (id, workflow_id, step_id, review_round, score, summary, created_at)
      VALUES ('review-defaults', 'workflow-defaults', NULL, 1, 10, 'clean', ?)
    `).run(UPDATED_AT);
    raw.prepare(`
      INSERT INTO review_issues
        (id, review_id, severity, file_path, line, title, recommendation, created_at)
      VALUES ('issue-defaults', 'review-defaults', 'low', NULL, NULL, 'note', 'keep it', ?)
    `).run(UPDATED_AT);

    expect(db.getWorkflow('workflow-defaults')?.metadata_json).toBe('{}');
    expect(db.getWorkflowStep('step-defaults')).toMatchObject({
      review_round: 0,
      error: null,
    });
    expect(db.getReview('review-defaults')).toMatchObject({
      tests_passed: 0,
      tests_failed: 0,
      tests_skipped: 0,
    });
    expect(db.getReviewIssue('issue-defaults')?.resolved).toBe(false);
    raw.close();
  });

  it('adds the complete foreign-key contract and delete actions', () => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    const workflowKeys = raw.pragma('foreign_key_list(workflows)') as Array<Record<string, unknown>>;
    const stepKeys = raw.pragma('foreign_key_list(workflow_steps)') as Array<Record<string, unknown>>;
    const reviewKeys = raw.pragma('foreign_key_list(reviews)') as Array<Record<string, unknown>>;
    const issueKeys = raw.pragma('foreign_key_list(review_issues)') as Array<Record<string, unknown>>;
    raw.close();

    expect(workflowKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'tasks', from: 'task_id', to: 'id', on_delete: 'CASCADE' }),
    ]));
    expect(stepKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'workflows', from: 'workflow_id', to: 'id', on_delete: 'CASCADE' }),
    ]));
    expect(reviewKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'workflows', from: 'workflow_id', to: 'id', on_delete: 'CASCADE' }),
      expect.objectContaining({ table: 'workflow_steps', from: 'step_id', to: 'id', on_delete: 'SET NULL' }),
    ]));
    expect(issueKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'reviews', from: 'review_id', to: 'id', on_delete: 'CASCADE' }),
    ]));
  });

  it('creates every explicit workflow and review lookup index', () => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    const indexes = raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND sql IS NOT NULL
        AND (name GLOB 'workflow*' OR name GLOB 'review*')
      ORDER BY name
    `).all() as Array<{ name: string }>;
    raw.close();
    expect(indexes.map((row) => row.name)).toEqual([
      'review_issues_review_created_idx',
      'review_issues_review_severity_idx',
      'reviews_step_idx',
      'reviews_workflow_round_idx',
      'workflow_steps_workflow_round_idx',
      'workflow_steps_workflow_started_idx',
      'workflow_steps_workflow_status_idx',
      'workflows_status_updated_idx',
      'workflows_task_updated_idx',
    ]);
  });

  it('preserves normalized v2 data across every pre-existing domain', () => {
    const db = openMigratedVersionTwo();
    expect(db.getProject(PROJECT_ID)?.path).toBe(PROJECT_PATH);
    expect(db.getSession(TASK_ID)?.title).toBe('Preserve the v2 task');
    expect(db.getTask(TASK_ID)).toMatchObject({ project_id: PROJECT_ID, permission_count: 1 });
    expect(db.listMessages(TASK_ID)[0]?.content).toBe('Keep this message');
    expect(db.listEvents(TASK_ID)[0]?.id).toBe('event-v2');
    expect(db.listFileChanges(TASK_ID)[0]?.file_path).toBe('src/preserved.ts');
    expect(db.listPermissions(TASK_ID)[0]?.id).toBe('permission-v2');
    expect(db.getProjectSettings(PROJECT_ID)).toMatchObject({
      favorite: true,
      disabled_mcp_servers: ['legacy-server'],
    });
    expect(db.getSetting('workflow-test-setting')).toBe('preserve-me');
    expect(db.getCheckpoint('checkpoint-v2')).toEqual(checkpoint());
    expect(db.listCheckpointFiles('checkpoint-v2')).toEqual([checkpointFile()]);
  });

  it('leaves the migrated database free of foreign-key violations', () => {
    openMigratedVersionTwo();
    const raw = rawDatabase();
    expect(raw.pragma('foreign_key_check')).toEqual([]);
    raw.close();
  });

  it('passes SQLite integrity checking after migrating and persisting a workflow graph', () => {
    const db = openMigratedVersionTwo();
    createWorkflowGraph(db);
    const raw = rawDatabase();
    expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    raw.close();
  });

  it('is idempotent on reopen and preserves a complete workflow graph', () => {
    const db = openMigratedVersionTwo();
    createWorkflowGraph(db);
    db.close();
    database = new AppDatabase(databasePath);

    expect(database.getWorkflow('workflow-1')).toEqual(workflow());
    expect(database.listWorkflowSteps('workflow-1')).toEqual([workflowStep()]);
    expect(database.getReviewWithIssues('review-1')).toEqual({
      review: review(),
      issues: [reviewIssue()],
    });
    expect(database.getMigrationInfo().schemaVersion).toBe(7);
  });

  it('completes a compatible partially present v3 schema without losing its workflow', () => {
    createVersionTwoDatabase();
    const raw = rawDatabase();
    raw.exec(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN (
          'idle', 'planning', 'waiting_plan_confirmation', 'executing',
          'testing', 'reviewing', 'paused', 'completed', 'failed', 'cancelled'
        )),
        current_stage TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
    `);
    raw.prepare(`
      INSERT INTO workflows
        (id, task_id, status, current_stage, created_at, updated_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(...Object.values(workflow({ id: 'partial-workflow' })));
    raw.close();

    database = new AppDatabase(databasePath);
    expect(database.getWorkflow('partial-workflow')).toEqual(workflow({ id: 'partial-workflow' }));
    expect(columnNames('review_issues')).toHaveLength(9);
  });

  it('rolls back all v3 DDL and user_version after a late schema failure', () => {
    createVersionTwoDatabase();
    const raw = rawDatabase();
    raw.exec('CREATE TABLE review_issues (review_id TEXT NOT NULL)');
    raw.close();

    expect(() => new AppDatabase(databasePath)).toThrow();

    const inspected = rawDatabase();
    expect(inspected.pragma('user_version', { simple: true })).toBe(2);
    const tables = inspected.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('workflows', 'workflow_steps', 'reviews', 'review_issues')
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const indexes = inspected.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND (name GLOB 'workflow*' OR name GLOB 'review*')
    `).all();
    expect(tables.map((row) => row.name)).toEqual(['review_issues']);
    expect(indexes).toEqual([]);
    inspected.close();
  });

  it('keeps an existing v2 file and its data in place after failed migration', () => {
    createVersionTwoDatabase();
    const raw = rawDatabase();
    raw.exec('CREATE TABLE review_issues (review_id TEXT NOT NULL)');
    raw.close();

    expect(() => new AppDatabase(databasePath)).toThrow();
    expect(fs.existsSync(databasePath)).toBe(true);
    expect(fs.readdirSync(directory).filter((name) => name.includes('startup-failed'))).toEqual([]);

    const inspected = rawDatabase();
    expect(inspected.prepare('SELECT content FROM messages WHERE id = ?').get('message-v2')).toEqual({
      content: 'Keep this message',
    });
    expect(inspected.prepare('SELECT value FROM settings WHERE key = ?')
      .get('workflow-test-setting')).toEqual({ value: 'preserve-me' });
    inspected.close();
  });

  it('rejects a newer schema without downgrading or deleting its data', () => {
    createVersionTwoDatabase();
    const raw = rawDatabase();
    raw.exec(`
      CREATE TABLE future_workflow_data (value TEXT NOT NULL);
      INSERT INTO future_workflow_data (value) VALUES ('keep-v5');
      PRAGMA user_version = 8;
    `);
    raw.close();

    expect(() => new AppDatabase(databasePath)).toThrow(/newer than supported/);
    const inspected = rawDatabase();
    expect(inspected.pragma('user_version', { simple: true })).toBe(8);
    expect(inspected.prepare('SELECT value FROM future_workflow_data').get()).toEqual({ value: 'keep-v5' });
    inspected.close();
  });

  it('enforces the workflow status constraint', () => {
    const db = openMigratedVersionTwo();
    expect(() => db.createWorkflow(workflow({ status: 'unknown-status' }))).toThrow();
    expect(db.getWorkflow('workflow-1')).toBeNull();
  });

  it('enforces the one-workflow-per-task invariant without replacing the first row', () => {
    const db = openMigratedVersionTwo();
    db.createWorkflow(workflow());
    expect(() => db.createWorkflow(workflow({ id: 'workflow-2', status: 'testing' }))).toThrow();
    expect(db.getWorkflow('workflow-1')).toEqual(workflow());
    expect(db.getWorkflow('workflow-2')).toBeNull();
  });

  it('rejects review rounds and scores outside their persisted bounds', () => {
    const db = openMigratedVersionTwo();
    db.createWorkflow(workflow());
    const invalidRows: Array<Partial<ReviewRow>> = [
      { id: 'round-zero', review_round: 0 },
      { id: 'round-above-three', review_round: 4 },
      { id: 'score-below-zero', score: -0.01 },
      { id: 'score-above-ten', score: 10.01 },
    ];
    for (const invalid of invalidRows) {
      expect(() => db.createReview(review({ step_id: null, ...invalid }))).toThrow();
    }
    expect(db.countReviews('workflow-1')).toBe(0);
  });

  it('accepts review boundary values but rejects negative test totals', () => {
    const db = openMigratedVersionTwo();
    db.createWorkflow(workflow());
    db.createReview(review({ id: 'review-min', step_id: null, review_round: 1, score: 0 }));
    db.createReview(review({ id: 'review-max', step_id: null, review_round: 3, score: 10 }));
    expect(() => db.createReview(review({
      id: 'review-negative-tests',
      step_id: null,
      tests_failed: -1,
    }))).toThrow();
    expect(db.listReviews('workflow-1')).toHaveLength(2);
  });

  it('enforces review issue severity and persisted boolean constraints', () => {
    const db = openMigratedVersionTwo();
    db.createWorkflow(workflow());
    db.createReview(review({ step_id: null }));
    expect(() => db.createReviewIssue(reviewIssue({ severity: 'urgent' }))).toThrow();

    const raw = rawDatabase();
    expect(() => raw.prepare(`
      INSERT INTO review_issues
        (id, review_id, severity, title, recommendation, resolved, created_at)
      VALUES ('invalid-bool', 'review-1', 'low', 'bad flag', 'fix it', 2, ?)
    `).run(UPDATED_AT)).toThrow();
    raw.close();
    expect(db.countReviewIssues('review-1')).toBe(0);
  });

  it('rejects orphan workflows, steps, reviews, and issues', () => {
    const db = openMigratedVersionTwo();
    expect(() => db.createWorkflow(workflow({ task_id: 'missing-task' }))).toThrow();
    expect(() => db.createWorkflowStep(workflowStep())).toThrow();

    db.createWorkflow(workflow());
    expect(() => db.createReview(review({ workflow_id: 'missing-workflow', step_id: null }))).toThrow();
    expect(() => db.createReview(review({ step_id: 'missing-step' }))).toThrow();
    expect(() => db.createReviewIssue(reviewIssue({ review_id: 'missing-review' }))).toThrow();
  });

  it('cascades the complete workflow graph when its task is deleted', () => {
    const db = openMigratedVersionTwo();
    createWorkflowGraph(db);

    db.deleteSession(TASK_ID);

    expect(db.getWorkflow('workflow-1')).toBeNull();
    expect(db.listWorkflowSteps('workflow-1')).toEqual([]);
    expect(db.listReviews('workflow-1')).toEqual([]);
    expect(db.getReviewIssue('issue-1')).toBeNull();
  });

  it('sets a deleted review step to null while preserving its review and issues', () => {
    const db = openMigratedVersionTwo();
    createWorkflowGraph(db);

    expect(db.deleteWorkflowStep('step-1')).toBe(true);

    expect(db.getReview('review-1')?.step_id).toBeNull();
    expect(db.getReviewIssue('issue-1')).toEqual(reviewIssue());
  });

  it('cascades steps, reviews, and issues when a workflow is deleted', () => {
    const db = openMigratedVersionTwo();
    createWorkflowGraph(db);

    expect(db.deleteWorkflow('workflow-1')).toBe(true);

    expect(db.getWorkflowStep('step-1')).toBeNull();
    expect(db.getReview('review-1')).toBeNull();
    expect(db.getReviewIssue('issue-1')).toBeNull();
    expect(db.getTask(TASK_ID)).not.toBeNull();
  });
});
