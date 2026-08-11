import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeProjectPath } from '../../projects/ProjectService';
import { AppDatabase } from '../Database';

const TEMP_PREFIX = 'claude-workbench-permission-rule-migration-test-';
const PROJECT_ID = 'project-1';

function removeTestDirectory(directory: string): void {
  const target = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

describe('project permission rule SQLite schema v5 migration', () => {
  let directory: string;
  let databasePath: string;
  let projectPath: string;
  let canonicalProjectPath: string;
  let database: AppDatabase | null;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    databasePath = path.join(directory, 'workbench.sqlite');
    projectPath = path.join(directory, 'project');
    fs.mkdirSync(projectPath);
    canonicalProjectPath = canonicalizeProjectPath(projectPath).canonicalPath;
    database = null;
  });

  afterEach(() => {
    database?.close();
    removeTestDirectory(directory);
  });

  function rawDatabase(): BetterSqlite3.Database {
    return new BetterSqlite3(databasePath);
  }

  function createVersionFourDatabase(): void {
    const seed = new AppDatabase(databasePath);
    seed.createProject(PROJECT_ID, 'Permission rule project', projectPath);
    seed.setSetting('theme', 'dark');
    seed.close();

    const raw = rawDatabase();
    raw.exec(`
      DROP TABLE IF EXISTS project_permission_rules;
      PRAGMA user_version = 4;
    `);
    raw.close();
  }

  function insertRule(
    raw: BetterSqlite3.Database,
    overrides: Partial<Record<string, unknown>> = {},
  ): void {
    const row: Record<string, unknown> = {
      id: 'rule-1',
      project_id: PROJECT_ID,
      scope: 'project',
      canonical_project_path: canonicalProjectPath,
      tool_name: 'bash',
      capability: 'shell.test',
      command_pattern: null,
      risk_ceiling: 'medium',
      enabled: 1,
      source: 'user',
      created_at: 100,
      updated_at: 100,
      last_hit_at: null,
      hit_count: 0,
      ...overrides,
    };
    raw.prepare(`
      INSERT INTO project_permission_rules
        (id, project_id, scope, canonical_project_path, tool_name, capability,
         command_pattern, risk_ceiling, enabled, source, created_at, updated_at,
         last_hit_at, hit_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.project_id,
      row.scope,
      row.canonical_project_path,
      row.tool_name,
      row.capability,
      row.command_pattern,
      row.risk_ceiling,
      row.enabled,
      row.source,
      row.created_at,
      row.updated_at,
      row.last_hit_at,
      row.hit_count,
    );
  }

  it('creates a fresh profile at schema version 7 with the complete v5 rule contract', () => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    const columns = raw.pragma('table_info(project_permission_rules)') as Array<{ name: string }>;
    const indexes = raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'project_permission_rules' AND sql IS NOT NULL
      ORDER BY name
    `).all() as Array<{ name: string }>;
    raw.close();

    expect(database.getMigrationInfo().schemaVersion).toBe(7);
    expect(columns.map((column) => column.name)).toEqual([
      'id', 'project_id', 'scope', 'canonical_project_path', 'tool_name',
      'capability', 'command_pattern', 'risk_ceiling', 'enabled', 'source',
      'created_at', 'updated_at', 'last_hit_at', 'hit_count',
    ]);
    expect(indexes.map((index) => index.name)).toEqual([
      'project_permission_rules_project_enabled_idx',
      'project_permission_rules_project_match_idx',
    ]);
  });

  it('advances a v4 database transactionally while preserving existing data', () => {
    createVersionFourDatabase();

    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(7);
      expect(raw.prepare('SELECT value FROM settings WHERE key = ?').get('theme')).toEqual({ value: 'dark' });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM project_permission_rules').get()).toEqual({ count: 0 });
    } finally {
      raw.close();
    }
  });

  it('binds rules to projects with cascading deletion', () => {
    database = new AppDatabase(databasePath);
    database.createProject(PROJECT_ID, 'Permission rule project', projectPath);
    const raw = rawDatabase();

    try {
      insertRule(raw);
      expect(() => insertRule(raw, { id: 'unknown-project-rule', project_id: 'missing-project' }))
        .toThrow(/foreign key/i);
    } finally {
      raw.close();
    }

    database.deleteProject(PROJECT_ID);
    const inspected = rawDatabase();
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM project_permission_rules').get())
      .toEqual({ count: 0 });
    inspected.close();
  });

  it.each([
    ['task scope', { scope: 'task' }],
    ['high risk', { risk_ceiling: 'high' }],
    ['destructive capability', { capability: 'shell.destructive', risk_ceiling: 'medium' }],
    ['unknown capability', { capability: 'shell.unknown', risk_ceiling: 'medium' }],
    ['package install capability', { capability: 'shell.package_install', risk_ceiling: 'medium' }],
    ['tool and capability mismatch', { tool_name: 'read', capability: 'shell.test' }],
    ['invalid enabled state', { enabled: 2 }],
    ['unknown source', { source: 'renderer' }],
    ['negative hit count', { hit_count: -1 }],
    ['hit count without last-hit timestamp', { hit_count: 1 }],
  ])('rejects unsafe direct rows: %s', (_label, overrides) => {
    database = new AppDatabase(databasePath);
    database.createProject(PROJECT_ID, 'Permission rule project', projectPath);
    const raw = rawDatabase();
    try {
      expect(() => insertRule(raw, overrides)).toThrow(/constraint/i);
    } finally {
      raw.close();
    }
  });

  it('rolls back DDL and user_version when the v5 table is incompatible', () => {
    createVersionFourDatabase();
    const raw = rawDatabase();
    raw.exec('CREATE TABLE project_permission_rules (id TEXT PRIMARY KEY)');
    raw.close();

    expect(() => new AppDatabase(databasePath)).toThrow();

    const inspected = rawDatabase();
    try {
      expect(inspected.pragma('user_version', { simple: true })).toBe(4);
      expect(inspected.pragma('table_info(project_permission_rules)')).toEqual([
        expect.objectContaining({ name: 'id' }),
      ]);
      expect(inspected.prepare('SELECT value FROM settings WHERE key = ?').get('theme'))
        .toEqual({ value: 'dark' });
    } finally {
      inspected.close();
    }
  });

  it('rejects a pre-existing full-column table that omits safety constraints', () => {
    createVersionFourDatabase();
    const raw = rawDatabase();
    raw.exec(`
      CREATE TABLE project_permission_rules (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        canonical_project_path TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        capability TEXT NOT NULL,
        command_pattern TEXT,
        risk_ceiling TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_hit_at INTEGER,
        hit_count INTEGER NOT NULL
      );
    `);
    raw.close();

    let opened: AppDatabase | null = null;
    let migrationError: unknown = null;
    try {
      opened = new AppDatabase(databasePath);
    } catch (error) {
      migrationError = error;
    } finally {
      opened?.close();
    }
    expect(migrationError).toBeInstanceOf(Error);

    const inspected = rawDatabase();
    try {
      expect(inspected.pragma('user_version', { simple: true })).toBe(4);
      expect(inspected.pragma('foreign_key_list(project_permission_rules)')).toEqual([]);
    } finally {
      inspected.close();
    }
  });
});
