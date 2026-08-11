import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../Database';

const TEMP_PREFIX = 'claude-workbench-model-tier-migration-';
const PROJECT_ID = 'project-1';
const CREDENTIAL_REF = 'safe-storage://v1/11111111-1111-4111-8111-111111111111';

function removeTestDirectory(directory: string): void {
  const target = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function insertProviderAndModel(raw: BetterSqlite3.Database): void {
  raw.prepare(`
    INSERT INTO model_providers (
      id, name, type, base_url, api_format, runtime_type, credential_ref,
      default_model_id, enabled, is_default, supports_claude_code,
      supports_agent_workflow, supports_tools, supports_mcp,
      supports_streaming, supports_vision, metadata_json, health_state,
      last_tested_at, last_error_type, latency_ms, created_at, updated_at
    ) VALUES (
      'provider-1', 'MiMo', 'anthropic-compatible', 'https://example.invalid',
      'anthropic-messages', 'claude-code', ?, NULL, 1, 0, 1, 1, 1, 1, 1, 0,
      '{}', 'connected', 100, NULL, 25, 100, 100
    )
  `).run(CREDENTIAL_REF);
  raw.prepare(`
    INSERT INTO model_provider_models
      (provider_id, model_id, display_name, source, created_at, updated_at)
    VALUES ('provider-1', 'model-1', 'Model One', 'manual', 100, 100)
  `).run();
}

describe('model tier SQLite schema v7 migration', () => {
  let directory: string;
  let databasePath: string;
  let projectPath: string;
  let database: AppDatabase | null;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    databasePath = path.join(directory, 'workbench.sqlite');
    projectPath = path.join(directory, 'project');
    fs.mkdirSync(projectPath);
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

  function createVersionSixDatabase(): void {
    const seed = new AppDatabase(databasePath);
    seed.createProject(PROJECT_ID, 'Preserved project', projectPath);
    seed.close();

    const raw = new BetterSqlite3(databasePath);
    raw.pragma('foreign_keys = OFF');
    const agentColumns = raw.pragma('table_info(agent_model_policy)') as Array<{ name: string }>;
    if (agentColumns.some(({ name }) => name === 'tier')) {
      raw.exec(`
        ALTER TABLE agent_model_policy RENAME TO agent_model_policy_v7;
        CREATE TABLE agent_model_policy (
          agent_type TEXT PRIMARY KEY CHECK (
            agent_type IN ('planner', 'coder', 'tester', 'reviewer', 'fixer')
          ),
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          quality TEXT CHECK (quality IS NULL OR quality IN ('low', 'medium', 'high')),
          speed TEXT CHECK (speed IS NULL OR speed IN ('low', 'medium', 'high')),
          cost TEXT CHECK (cost IS NULL OR cost IN ('low', 'medium', 'high')),
          created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          updated_at INTEGER NOT NULL CHECK (
            typeof(updated_at) = 'integer' AND updated_at >= created_at
          ),
          FOREIGN KEY (provider_id, model_id)
            REFERENCES model_provider_models(provider_id, model_id) ON DELETE CASCADE
        );
        INSERT INTO agent_model_policy
          (agent_type, provider_id, model_id, quality, speed, cost, created_at, updated_at)
        SELECT agent_type, provider_id, model_id, quality, speed, cost, created_at, updated_at
        FROM agent_model_policy_v7 WHERE tier IS NULL;
        DROP TABLE agent_model_policy_v7;
        CREATE INDEX agent_model_policy_provider_model_idx
          ON agent_model_policy(provider_id, model_id);

        ALTER TABLE project_model_policy RENAME TO project_model_policy_v7;
        CREATE TABLE project_model_policy (
          project_id TEXT NOT NULL,
          agent_type TEXT NOT NULL CHECK (
            agent_type IN ('default', 'planner', 'coder', 'tester', 'reviewer', 'fixer')
          ),
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          updated_at INTEGER NOT NULL CHECK (
            typeof(updated_at) = 'integer' AND updated_at >= created_at
          ),
          PRIMARY KEY (project_id, agent_type),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (provider_id, model_id)
            REFERENCES model_provider_models(provider_id, model_id) ON DELETE CASCADE
        );
        INSERT INTO project_model_policy
          (project_id, agent_type, provider_id, model_id, created_at, updated_at)
        SELECT project_id, agent_type, provider_id, model_id, created_at, updated_at
        FROM project_model_policy_v7 WHERE tier IS NULL;
        DROP TABLE project_model_policy_v7;
        CREATE INDEX project_model_policy_provider_model_idx
          ON project_model_policy(provider_id, model_id);

        DROP TABLE IF EXISTS project_model_tier_bindings;
        DROP TABLE IF EXISTS model_tier_bindings;
      `);
    }
    raw.pragma('user_version = 6');
    raw.close();
  }

  it('creates the exact v7 tier and policy column contract on a fresh profile', () => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(7);
      expect(raw.pragma('table_info(model_tier_bindings)')
        .map((column: { name: string }) => column.name)).toEqual([
        'tier', 'provider_id', 'model_id', 'display_name', 'quality', 'speed', 'cost',
        'updated_at',
      ]);
      expect(raw.pragma('table_info(project_model_tier_bindings)')
        .map((column: { name: string }) => column.name)).toEqual([
        'project_id', 'tier', 'provider_id', 'model_id', 'display_name', 'quality', 'speed',
        'cost', 'updated_at',
      ]);
      expect(raw.pragma('table_info(agent_model_policy)')
        .map((column: { name: string }) => column.name)).toEqual([
        'agent_type', 'provider_id', 'model_id', 'tier', 'quality', 'speed', 'cost',
        'created_at', 'updated_at',
      ]);
      expect(raw.pragma('table_info(project_model_policy)')
        .map((column: { name: string }) => column.name)).toEqual([
        'project_id', 'agent_type', 'provider_id', 'model_id', 'tier', 'created_at',
        'updated_at',
      ]);
    } finally {
      raw.close();
    }
  });

  it('restores the policy indexes and every nullable composite foreign key', () => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      const indexes = raw.prepare(`
        SELECT name, tbl_name FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'agent_model_policy_provider_model_idx',
          'project_model_policy_provider_model_idx'
        ) ORDER BY name
      `).all();
      expect(indexes).toEqual([
        { name: 'agent_model_policy_provider_model_idx', tbl_name: 'agent_model_policy' },
        { name: 'project_model_policy_provider_model_idx', tbl_name: 'project_model_policy' },
      ]);

      const agentForeignKeys = raw.pragma('foreign_key_list(agent_model_policy)') as Array<{
        table: string; from: string; to: string; on_delete: string;
      }>;
      expect(agentForeignKeys.map(({ table, from, to, on_delete }) => ({
        table, from, to, on_delete,
      }))).toEqual([
        { table: 'model_provider_models', from: 'provider_id', to: 'provider_id', on_delete: 'CASCADE' },
        { table: 'model_provider_models', from: 'model_id', to: 'model_id', on_delete: 'CASCADE' },
      ]);

      const projectForeignKeys = raw.pragma('foreign_key_list(project_model_policy)') as Array<{
        table: string; from: string; to: string; on_delete: string;
      }>;
      expect(projectForeignKeys.map(({ table, from, to, on_delete }) => ({
        table, from, to, on_delete,
      })).sort((left, right) => left.from.localeCompare(right.from))).toEqual([
        { table: 'model_provider_models', from: 'model_id', to: 'model_id', on_delete: 'CASCADE' },
        { table: 'projects', from: 'project_id', to: 'id', on_delete: 'CASCADE' },
        { table: 'model_provider_models', from: 'provider_id', to: 'provider_id', on_delete: 'CASCADE' },
      ]);
    } finally {
      raw.close();
    }
  });

  it.each([
    ['NULL tier key', { tier: null }],
    ['unknown tier', { tier: 'premium' }],
    ['only provider identity', { provider_id: 'provider-1', model_id: null }],
    ['only model identity', { provider_id: null, model_id: 'model-1' }],
    ['blank provider identity', { provider_id: '', model_id: 'model-1' }],
    ['untrimmed provider identity', { provider_id: ' provider-1', model_id: 'model-1' }],
    ['NUL provider identity', { provider_id: 'bad\0id', model_id: 'model-1' }],
    ['oversized provider identity', { provider_id: 'p'.repeat(193), model_id: 'model-1' }],
    ['untrimmed model identity', { provider_id: 'provider-1', model_id: ' model-1' }],
    ['NUL model identity', { provider_id: 'provider-1', model_id: 'bad\0id' }],
    ['oversized model identity', { provider_id: 'provider-1', model_id: 'm'.repeat(257) }],
    ['blank display name', { display_name: '' }],
    ['NUL display name', { display_name: 'bad\0name' }],
    ['oversized display name', { display_name: 'd'.repeat(81) }],
    ['negative timestamp', { updated_at: -1 }],
    ['fractional timestamp', { updated_at: 1.5 }],
  ])('rejects malformed tier binding data: %s', (_label, overrides) => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      const row = {
        tier: 'balanced',
        provider_id: null,
        model_id: null,
        display_name: null,
        quality: null,
        speed: null,
        cost: null,
        updated_at: 100,
        ...overrides,
      };
      expect(() => raw.prepare(`
        INSERT INTO model_tier_bindings
          (tier, provider_id, model_id, display_name, quality, speed, cost, updated_at)
        VALUES (@tier, @provider_id, @model_id, @display_name, @quality, @speed, @cost, @updated_at)
      `).run(row)).toThrow(/constraint/i);
    } finally {
      raw.close();
    }
  });

  it('enforces exactly one policy reference form and keeps project default direct-only', () => {
    database = new AppDatabase(databasePath);
    database.createProject(PROJECT_ID, 'Project', projectPath);
    const raw = rawDatabase();
    try {
      insertProviderAndModel(raw);
      expect(() => raw.prepare(`
        INSERT INTO agent_model_policy
          (agent_type, provider_id, model_id, tier, created_at, updated_at)
        VALUES ('planner', NULL, NULL, 'high_quality', 100, 100)
      `).run()).not.toThrow();
      expect(() => raw.prepare(`
        INSERT INTO agent_model_policy
          (agent_type, provider_id, model_id, tier, created_at, updated_at)
        VALUES ('coder', 'provider-1', 'model-1', 'balanced', 100, 100)
      `).run()).toThrow(/constraint/i);
      expect(() => raw.prepare(`
        INSERT INTO agent_model_policy
          (agent_type, provider_id, model_id, tier, created_at, updated_at)
        VALUES ('tester', NULL, NULL, NULL, 100, 100)
      `).run()).toThrow(/constraint/i);
      expect(() => raw.prepare(`
        INSERT INTO project_model_policy
          (project_id, agent_type, provider_id, model_id, tier, created_at, updated_at)
        VALUES (?, 'default', NULL, NULL, 'fast', 100, 100)
      `).run(PROJECT_ID)).toThrow(/constraint/i);
      expect(() => raw.prepare(`
        INSERT INTO project_model_policy
          (project_id, agent_type, provider_id, model_id, tier, created_at, updated_at)
        VALUES (?, 'reviewer', NULL, NULL, 'fast', 100, 100)
      `).run(PROJECT_ID)).not.toThrow();
      expect(() => raw.prepare(`
        INSERT INTO agent_model_policy
          (agent_type, provider_id, model_id, tier, created_at, updated_at)
        VALUES (NULL, 'provider-1', 'model-1', NULL, 100, 100)
      `).run()).toThrow(/constraint/i);
      expect(() => raw.prepare(`
        INSERT INTO project_model_policy
          (project_id, agent_type, provider_id, model_id, tier, created_at, updated_at)
        VALUES (?, 'fixer', 'missing', 'missing', NULL, 100, 100)
      `).run(PROJECT_ID)).toThrow(/foreign key/i);
    } finally {
      raw.close();
    }
  });

  it('upgrades v6 direct policies without changing any value', () => {
    createVersionSixDatabase();
    let raw = rawDatabase();
    insertProviderAndModel(raw);
    raw.prepare(`
      INSERT INTO agent_model_policy
        (agent_type, provider_id, model_id, quality, speed, cost, created_at, updated_at)
      VALUES ('planner', 'provider-1', 'model-1', 'high', 'medium', 'low', 101, 102)
    `).run();
    raw.prepare(`
      INSERT INTO project_model_policy
        (project_id, agent_type, provider_id, model_id, created_at, updated_at)
      VALUES (?, 'default', 'provider-1', 'model-1', 103, 104)
    `).run(PROJECT_ID);
    raw.close();

    database = new AppDatabase(databasePath);
    raw = rawDatabase();
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(7);
      expect(raw.prepare('SELECT * FROM agent_model_policy').get()).toEqual({
        agent_type: 'planner', provider_id: 'provider-1', model_id: 'model-1', tier: null,
        quality: 'high', speed: 'medium', cost: 'low', created_at: 101, updated_at: 102,
      });
      expect(raw.prepare('SELECT * FROM project_model_policy').get()).toEqual({
        project_id: PROJECT_ID, agent_type: 'default', provider_id: 'provider-1',
        model_id: 'model-1', tier: null, created_at: 103, updated_at: 104,
      });
      expect(raw.pragma('foreign_key_check')).toEqual([]);
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    } finally {
      raw.close();
    }
  });

  it('leaves existing v7 rows byte-for-byte intact when validating a downgraded version marker', () => {
    database = new AppDatabase(databasePath);
    let raw = rawDatabase();
    raw.prepare(`
      INSERT INTO model_tier_bindings
        (tier, provider_id, model_id, display_name, quality, speed, cost, updated_at)
      VALUES ('balanced', 'provider:tombstone', 'model:tombstone', 'Balanced',
        'medium', 'medium', 'low', 321)
    `).run();
    raw.prepare(`
      INSERT INTO agent_model_policy
        (agent_type, provider_id, model_id, tier, quality, speed, cost, created_at, updated_at)
      VALUES ('reviewer', NULL, NULL, 'balanced', 'high', 'low', 'medium', 123, 321)
    `).run();
    raw.pragma('user_version = 6');
    raw.close();
    database.close();
    database = null;

    database = new AppDatabase(databasePath);
    raw = rawDatabase();
    try {
      expect(raw.prepare('SELECT * FROM model_tier_bindings').get()).toEqual({
        tier: 'balanced', provider_id: 'provider:tombstone', model_id: 'model:tombstone',
        display_name: 'Balanced', quality: 'medium', speed: 'medium', cost: 'low',
        updated_at: 321,
      });
      expect(raw.prepare('SELECT * FROM agent_model_policy').get()).toEqual({
        agent_type: 'reviewer', provider_id: null, model_id: null, tier: 'balanced',
        quality: 'high', speed: 'low', cost: 'medium', created_at: 123, updated_at: 321,
      });
      expect(raw.pragma('user_version', { simple: true })).toBe(7);
    } finally {
      raw.close();
    }
  });

  it('rolls back policy rebuilds and user_version after a late v7 schema conflict', () => {
    createVersionSixDatabase();
    let raw = rawDatabase();
    insertProviderAndModel(raw);
    raw.prepare(`
      INSERT INTO agent_model_policy
        (agent_type, provider_id, model_id, quality, created_at, updated_at)
      VALUES ('planner', 'provider-1', 'model-1', 'high', 101, 102)
    `).run();
    raw.exec(`
      CREATE TABLE project_model_tier_bindings (
        project_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        display_name TEXT,
        quality TEXT,
        speed TEXT,
        cost TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, tier),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
    raw.close();

    expect(() => new AppDatabase(databasePath)).toThrow(/version 7|incompatible/i);

    raw = rawDatabase();
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(6);
      expect(raw.pragma('table_info(agent_model_policy)')
        .map((column: { name: string }) => column.name)).toEqual([
        'agent_type', 'provider_id', 'model_id', 'quality', 'speed', 'cost',
        'created_at', 'updated_at',
      ]);
      expect(raw.prepare('SELECT quality, created_at, updated_at FROM agent_model_policy').get())
        .toEqual({ quality: 'high', created_at: 101, updated_at: 102 });
      expect(raw.pragma('foreign_key_check')).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it('rejects a full-column project tier table that omits its composite primary key', () => {
    createVersionSixDatabase();
    const raw = rawDatabase();
    insertProviderAndModel(raw);
    raw.prepare(`
      INSERT INTO agent_model_policy
        (agent_type, provider_id, model_id, quality, speed, cost, created_at, updated_at)
      VALUES ('planner', 'provider-1', 'model-1', 'high', 'medium', 'low', 101, 102)
    `).run();
    raw.exec(`
      CREATE TABLE project_model_tier_bindings (
        project_id TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('high_quality', 'balanced', 'fast')),
        provider_id TEXT,
        model_id TEXT,
        display_name TEXT,
        quality TEXT CHECK (quality IS NULL OR quality IN ('low', 'medium', 'high')),
        speed TEXT CHECK (speed IS NULL OR speed IN ('low', 'medium', 'high')),
        cost TEXT CHECK (cost IS NULL OR cost IN ('low', 'medium', 'high')),
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CHECK ((provider_id IS NULL) = (model_id IS NULL)),
        CHECK (provider_id IS NULL OR (
          length(provider_id) BETWEEN 1 AND 192
          AND provider_id = trim(provider_id)
          AND instr(provider_id, char(0)) = 0
        )),
        CHECK (model_id IS NULL OR (
          length(model_id) BETWEEN 1 AND 256
          AND model_id = trim(model_id)
          AND instr(model_id, char(0)) = 0
        )),
        CHECK (display_name IS NULL OR (
          length(display_name) BETWEEN 1 AND 80
          AND display_name = trim(display_name)
          AND instr(display_name, char(0)) = 0
        )),
        CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
      )
    `);
    raw.close();

    expectVersionSevenMigrationRollback();
  });

  it('rejects a full-column global tier table whose primary key is not explicitly NOT NULL', () => {
    createVersionSixDatabase();
    const raw = rawDatabase();
    insertProviderAndModel(raw);
    raw.prepare(`
      INSERT INTO agent_model_policy
        (agent_type, provider_id, model_id, quality, speed, cost, created_at, updated_at)
      VALUES ('planner', 'provider-1', 'model-1', 'high', 'medium', 'low', 101, 102)
    `).run();
    raw.exec(`
      CREATE TABLE model_tier_bindings (
        tier TEXT PRIMARY KEY CHECK (tier IN ('high_quality', 'balanced', 'fast')),
        provider_id TEXT,
        model_id TEXT,
        display_name TEXT,
        quality TEXT CHECK (quality IS NULL OR quality IN ('low', 'medium', 'high')),
        speed TEXT CHECK (speed IS NULL OR speed IN ('low', 'medium', 'high')),
        cost TEXT CHECK (cost IS NULL OR cost IN ('low', 'medium', 'high')),
        updated_at INTEGER NOT NULL,
        CHECK ((provider_id IS NULL) = (model_id IS NULL)),
        CHECK (provider_id IS NULL OR (
          length(provider_id) BETWEEN 1 AND 192
          AND provider_id = trim(provider_id)
          AND instr(provider_id, char(0)) = 0
        )),
        CHECK (model_id IS NULL OR (
          length(model_id) BETWEEN 1 AND 256
          AND model_id = trim(model_id)
          AND instr(model_id, char(0)) = 0
        )),
        CHECK (display_name IS NULL OR (
          length(display_name) BETWEEN 1 AND 80
          AND display_name = trim(display_name)
          AND instr(display_name, char(0)) = 0
        )),
        CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
      )
    `);
    raw.close();

    expectVersionSevenMigrationRollback();
  });

  it('rejects a key-correct project tier table with tautological CHECK expressions', () => {
    createVersionSixDatabase();
    const raw = rawDatabase();
    insertProviderAndModel(raw);
    raw.prepare(`
      INSERT INTO agent_model_policy
        (agent_type, provider_id, model_id, quality, speed, cost, created_at, updated_at)
      VALUES ('planner', 'provider-1', 'model-1', 'high', 'medium', 'low', 101, 102)
    `).run();
    raw.exec(`
      CREATE TABLE project_model_tier_bindings (
        project_id TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (1 OR tier IN ('high_quality', 'balanced', 'fast')),
        provider_id TEXT,
        model_id TEXT,
        display_name TEXT,
        quality TEXT CHECK (1 OR quality IS NULL OR quality IN ('low', 'medium', 'high')),
        speed TEXT CHECK (1 OR speed IS NULL OR speed IN ('low', 'medium', 'high')),
        cost TEXT CHECK (1 OR cost IS NULL OR cost IN ('low', 'medium', 'high')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, tier),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CHECK (1 OR (provider_id IS NULL) = (model_id IS NULL)),
        CHECK (1 OR provider_id IS NULL OR (
          length(provider_id) BETWEEN 1 AND 192
          AND provider_id = trim(provider_id)
          AND instr(provider_id, char(0)) = 0
        )),
        CHECK (1 OR model_id IS NULL OR (
          length(model_id) BETWEEN 1 AND 256
          AND model_id = trim(model_id)
          AND instr(model_id, char(0)) = 0
        )),
        CHECK (1 OR display_name IS NULL OR (
          length(display_name) BETWEEN 1 AND 80
          AND display_name = trim(display_name)
          AND instr(display_name, char(0)) = 0
        )),
        CHECK (1 OR typeof(updated_at) = 'integer' AND updated_at >= 0)
      )
    `);
    raw.close();

    expectVersionSevenMigrationRollback();
  });

  it('rejects a key-correct global tier table whose speed CHECK alone is tautological', () => {
    createVersionSixDatabase();
    const raw = rawDatabase();
    insertProviderAndModel(raw);
    raw.prepare(`
      INSERT INTO agent_model_policy
        (agent_type, provider_id, model_id, quality, speed, cost, created_at, updated_at)
      VALUES ('planner', 'provider-1', 'model-1', 'high', 'medium', 'low', 101, 102)
    `).run();
    raw.exec(`
      CREATE TABLE model_tier_bindings (
        tier TEXT NOT NULL PRIMARY KEY CHECK (tier IN ('high_quality', 'balanced', 'fast')),
        provider_id TEXT,
        model_id TEXT,
        display_name TEXT,
        quality TEXT CHECK (quality IS NULL OR quality IN ('low', 'medium', 'high')),
        speed TEXT CHECK (1 OR speed IS NULL OR speed IN ('low', 'medium', 'high')),
        cost TEXT CHECK (cost IS NULL OR cost IN ('low', 'medium', 'high')),
        updated_at INTEGER NOT NULL,
        CHECK ((provider_id IS NULL) = (model_id IS NULL)),
        CHECK (provider_id IS NULL OR (
          length(provider_id) BETWEEN 1 AND 192
          AND provider_id = trim(provider_id)
          AND instr(provider_id, char(0)) = 0
        )),
        CHECK (model_id IS NULL OR (
          length(model_id) BETWEEN 1 AND 256
          AND model_id = trim(model_id)
          AND instr(model_id, char(0)) = 0
        )),
        CHECK (display_name IS NULL OR (
          length(display_name) BETWEEN 1 AND 80
          AND display_name = trim(display_name)
          AND instr(display_name, char(0)) = 0
        )),
        CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
      )
    `);
    raw.close();

    expectVersionSevenMigrationRollback();
  });

  it('rejects a downgraded v7 policy schema whose named lookup index is partial', () => {
    database = new AppDatabase(databasePath);
    let raw = rawDatabase();
    raw.prepare(`
      INSERT INTO agent_model_policy
        (agent_type, provider_id, model_id, tier, quality, speed, cost, created_at, updated_at)
      VALUES ('reviewer', NULL, NULL, 'balanced', 'high', 'low', 'medium', 123, 321)
    `).run();
    raw.exec(`
      DROP INDEX agent_model_policy_provider_model_idx;
      CREATE INDEX agent_model_policy_provider_model_idx
        ON agent_model_policy(provider_id, model_id)
        WHERE provider_id IS NOT NULL;
      PRAGMA user_version = 6;
    `);
    raw.close();
    database.close();
    database = null;

    expect(() => new AppDatabase(databasePath)).toThrow(/version 7|incompatible/i);

    raw = rawDatabase();
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(6);
      expect(raw.prepare('SELECT * FROM agent_model_policy').get()).toEqual({
        agent_type: 'reviewer', provider_id: null, model_id: null, tier: 'balanced',
        quality: 'high', speed: 'low', cost: 'medium', created_at: 123, updated_at: 321,
      });
      expect((raw.pragma('index_list(agent_model_policy)') as Array<{
        name: string; partial: number;
      }>).find(({ name }) => name === 'agent_model_policy_provider_model_idx')?.partial)
        .toBe(1);
    } finally {
      raw.close();
    }
  });

  it('persists tier rows across restart and retains deleted Provider identities as tombstones', () => {
    database = new AppDatabase(databasePath);
    database.createProject(PROJECT_ID, 'Project', projectPath);
    let raw = rawDatabase();
    insertProviderAndModel(raw);
    raw.prepare(`
      INSERT INTO model_tier_bindings
        (tier, provider_id, model_id, display_name, quality, speed, cost, updated_at)
      VALUES ('fast', 'provider-1', 'model-1', 'Fast', 'medium', 'high', 'low', 100)
    `).run();
    raw.prepare(`
      INSERT INTO project_model_tier_bindings
        (project_id, tier, provider_id, model_id, display_name, updated_at)
      VALUES (?, 'balanced', NULL, NULL, 'Balanced', 101)
    `).run(PROJECT_ID);
    raw.prepare("DELETE FROM model_providers WHERE id = 'provider-1'").run();
    raw.close();
    database.close();
    database = null;

    database = new AppDatabase(databasePath);
    raw = rawDatabase();
    try {
      expect(raw.prepare(`
        SELECT provider_id, model_id, display_name FROM model_tier_bindings WHERE tier = 'fast'
      `).get()).toEqual({ provider_id: 'provider-1', model_id: 'model-1', display_name: 'Fast' });
      expect(raw.prepare(`
        SELECT provider_id, model_id, display_name FROM project_model_tier_bindings
        WHERE project_id = ? AND tier = 'balanced'
      `).get(PROJECT_ID)).toEqual({ provider_id: null, model_id: null, display_name: 'Balanced' });
      database.deleteProject(PROJECT_ID);
      expect(raw.prepare('SELECT COUNT(*) AS count FROM project_model_tier_bindings').get())
        .toEqual({ count: 0 });
      expect(raw.pragma('foreign_key_check')).toEqual([]);
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    } finally {
      raw.close();
    }
  });

  function expectVersionSevenMigrationRollback(): void {
    let opened: AppDatabase | null = null;
    try {
      expect(() => {
        opened = new AppDatabase(databasePath);
      }).toThrow(/version 7|incompatible/i);
    } finally {
      opened?.close();
    }

    const inspected = rawDatabase();
    try {
      expect(inspected.pragma('user_version', { simple: true })).toBe(6);
      expect(inspected.pragma('table_info(agent_model_policy)')
        .map((column: { name: string }) => column.name)).toEqual([
        'agent_type', 'provider_id', 'model_id', 'quality', 'speed', 'cost',
        'created_at', 'updated_at',
      ]);
      expect(inspected.prepare('SELECT * FROM agent_model_policy').get()).toEqual({
        agent_type: 'planner', provider_id: 'provider-1', model_id: 'model-1',
        quality: 'high', speed: 'medium', cost: 'low', created_at: 101, updated_at: 102,
      });
      expect(inspected.pragma('foreign_key_check')).toEqual([]);
    } finally {
      inspected.close();
    }
  }
});
