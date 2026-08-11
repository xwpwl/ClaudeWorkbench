import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../Database';

const TEMP_PREFIX = 'claude-workbench-model-provider-migration-';
const PROJECT_ID = 'project-1';
const TASK_ID = 'task-1';
const CREDENTIAL_REF = 'safe-storage://v1/11111111-1111-4111-8111-111111111111';

const TABLES = [
  'agent_model_policy',
  'credential_cleanup_jobs',
  'model_provider_models',
  'model_providers',
  'project_model_policy',
  'task_model_overrides',
] as const;

function removeTestDirectory(directory: string): void {
  const target = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

describe('Model Provider Center SQLite schema v6 migration', () => {
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

  function createVersionFiveDatabase(): void {
    const seed = new AppDatabase(databasePath);
    seed.createProject(PROJECT_ID, 'Preserved project', projectPath);
    seed.createSession(TASK_ID, PROJECT_ID, 'Preserved task');
    seed.setSetting('theme', 'dark');
    seed.close();

    const raw = new BetterSqlite3(databasePath);
    raw.pragma('foreign_keys = OFF');
    raw.exec(`
      DROP TABLE IF EXISTS agent_model_policy;
      DROP TABLE IF EXISTS project_model_policy;
      DROP TABLE IF EXISTS task_model_overrides;
      DROP TABLE IF EXISTS credential_cleanup_jobs;
      DROP TABLE IF EXISTS model_provider_models;
      DROP TABLE IF EXISTS model_providers;
      PRAGMA user_version = 5;
    `);
    raw.close();
  }

  function insertProvider(
    raw: BetterSqlite3.Database,
    overrides: Partial<Record<string, unknown>> = {},
  ): void {
    const row: Record<string, unknown> = {
      id: 'provider-1',
      name: 'MiMo',
      type: 'anthropic-compatible',
      base_url: 'https://example.invalid',
      api_format: 'anthropic-messages',
      runtime_type: 'claude-code',
      credential_ref: CREDENTIAL_REF,
      default_model_id: null,
      enabled: 1,
      is_default: 0,
      supports_claude_code: 1,
      supports_agent_workflow: 1,
      supports_tools: 1,
      supports_mcp: 1,
      supports_streaming: 1,
      supports_vision: 0,
      metadata_json: '{}',
      health_state: 'connected',
      last_tested_at: 100,
      last_error_type: null,
      latency_ms: 25,
      created_at: 100,
      updated_at: 100,
      ...overrides,
    };
    raw.prepare(`
      INSERT INTO model_providers (
        id, name, type, base_url, api_format, runtime_type, credential_ref,
        default_model_id, enabled, is_default, supports_claude_code,
        supports_agent_workflow, supports_tools, supports_mcp,
        supports_streaming, supports_vision, metadata_json, health_state,
        last_tested_at, last_error_type, latency_ms, created_at, updated_at
      ) VALUES (
        @id, @name, @type, @base_url, @api_format, @runtime_type, @credential_ref,
        @default_model_id, @enabled, @is_default, @supports_claude_code,
        @supports_agent_workflow, @supports_tools, @supports_mcp,
        @supports_streaming, @supports_vision, @metadata_json, @health_state,
        @last_tested_at, @last_error_type, @latency_ms, @created_at, @updated_at
      )
    `).run(row);
  }

  function insertModel(
    raw: BetterSqlite3.Database,
    providerId = 'provider-1',
    modelId = 'mimo-v2.5-pro',
  ): void {
    raw.prepare(`
      INSERT INTO model_provider_models
        (provider_id, model_id, display_name, source, created_at, updated_at)
      VALUES (?, ?, ?, 'manual', 100, 100)
    `).run(providerId, modelId, modelId);
  }

  it('creates a fresh profile at schema version 7 with every provider table', () => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    const tables = raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(', ')})
      ORDER BY name
    `).all(...TABLES) as Array<{ name: string }>;
    raw.close();

    expect(database.getMigrationInfo().schemaVersion).toBe(7);
    expect(tables.map(({ name }) => name)).toEqual([...TABLES]);
  });

  it('creates the complete provider capability and health column contract', () => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    const columns = raw.pragma('table_info(model_providers)') as Array<{ name: string }>;
    raw.close();

    expect(columns.map(({ name }) => name)).toEqual([
      'id', 'name', 'type', 'base_url', 'api_format', 'runtime_type',
      'credential_ref', 'default_model_id', 'enabled', 'is_default',
      'supports_claude_code', 'supports_agent_workflow', 'supports_tools',
      'supports_mcp', 'supports_streaming', 'supports_vision', 'metadata_json',
      'health_state', 'last_tested_at', 'last_error_type', 'latency_ms',
      'created_at', 'updated_at',
    ]);
  });

  it('advances v5 transactionally while preserving existing user data', () => {
    createVersionFiveDatabase();
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(7);
      expect(raw.prepare('SELECT value FROM settings WHERE key = ?').get('theme'))
        .toEqual({ value: 'dark' });
      expect(raw.prepare('SELECT title FROM sessions WHERE id = ?').get(TASK_ID))
        .toEqual({ title: 'Preserved task' });
    } finally {
      raw.close();
    }
  });

  it.each([
    ['unknown provider type', { type: 'deepseek' }],
    ['OpenAI provider using the Claude runtime', {
      type: 'openai-compatible', api_format: 'openai-chat-completions', runtime_type: 'claude-code',
    }],
    ['Anthropic provider using OpenAI format', {
      type: 'anthropic', api_format: 'openai-chat-completions', runtime_type: 'claude-code',
    }],
    ['OpenAI provider claiming Claude Code', {
      type: 'openai-compatible', api_format: 'openai-chat-completions', runtime_type: 'none',
      supports_claude_code: 1,
    }],
    ['workflow support without Claude Code', {
      supports_claude_code: 0, supports_agent_workflow: 1,
    }],
    ['MCP support without tools', { supports_tools: 0, supports_mcp: 1 }],
  ])('rejects an inconsistent Provider row: %s', (_label, overrides) => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      expect(() => insertProvider(raw, overrides)).toThrow(/constraint/i);
    } finally {
      raw.close();
    }
  });

  it.each([
    ['supports_claude_code', 2],
    ['supports_agent_workflow', -1],
    ['supports_tools', 3],
    ['supports_mcp', 2],
    ['supports_streaming', -1],
    ['supports_vision', 2],
  ])('constrains %s to a SQLite boolean', (column, value) => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      expect(() => insertProvider(raw, { [column]: value })).toThrow(/constraint/i);
    } finally {
      raw.close();
    }
  });

  it.each([
    ['plaintext credential', 'sk-secret'],
    ['wrong credential scheme', 'wincred://claude-workbench/provider-1'],
    ['path traversal', 'safe-storage://v1/../../secret'],
    ['non UUID reference', 'safe-storage://v1/not-a-uuid'],
  ])('rejects an unsafe credential reference: %s', (_label, credentialRef) => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      expect(() => insertProvider(raw, { credential_ref: credentialRef })).toThrow(/constraint/i);
    } finally {
      raw.close();
    }
  });

  it.each([
    ['invalid metadata JSON', { metadata_json: '{broken' }],
    ['unknown health state', { health_state: 'healthy' }],
    ['unknown error category', { health_state: 'error', last_error_type: 'raw upstream body' }],
    ['negative latency', { latency_ms: -1 }],
    ['negative last-tested timestamp', { last_tested_at: -1 }],
  ])('rejects unsafe persisted Provider state: %s', (_label, overrides) => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      expect(() => insertProvider(raw, overrides)).toThrow(/constraint/i);
    } finally {
      raw.close();
    }
  });

  it('allows only one enabled global default Provider', () => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      insertProvider(raw, { id: 'provider-default-1', is_default: 1 });
      expect(() => insertProvider(raw, {
        id: 'provider-default-2',
        credential_ref: 'safe-storage://v1/22222222-2222-4222-8222-222222222222',
        is_default: 1,
      })).toThrow(/unique/i);
      expect(() => insertProvider(raw, {
        id: 'provider-disabled-default',
        credential_ref: 'safe-storage://v1/33333333-3333-4333-8333-333333333333',
        enabled: 0,
        is_default: 1,
      })).not.toThrow();
    } finally {
      raw.close();
    }
  });

  it('binds cached models and the default model to their Provider', () => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      insertProvider(raw);
      insertProvider(raw, {
        id: 'provider-2',
        credential_ref: 'safe-storage://v1/22222222-2222-4222-8222-222222222222',
      });
      insertModel(raw);
      insertModel(raw, 'provider-2', 'other-model');
      raw.prepare('UPDATE model_providers SET default_model_id = ? WHERE id = ?')
        .run('mimo-v2.5-pro', 'provider-1');
      expect(() => raw.prepare(
        'UPDATE model_providers SET default_model_id = ? WHERE id = ?',
      ).run('other-model', 'provider-1')).toThrow(/foreign key/i);
      expect(() => insertModel(raw, 'missing-provider', 'orphan-model')).toThrow(/foreign key/i);
    } finally {
      raw.close();
    }
  });

  it('cascades Provider deletion to its discovered model cache', () => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      insertProvider(raw);
      insertModel(raw);
      raw.prepare('DELETE FROM model_providers WHERE id = ?').run('provider-1');
      expect(raw.prepare('SELECT COUNT(*) AS count FROM model_provider_models').get())
        .toEqual({ count: 0 });
    } finally {
      raw.close();
    }
  });

  it.each([
    ['unknown role', 'architect', {}],
    ['invalid quality note', 'planner', { quality: 'best' }],
    ['invalid speed note', 'coder', { speed: 'instant' }],
    ['invalid cost note', 'reviewer', { cost: 'free' }],
  ])('rejects an unsafe global Agent policy: %s', (_label, agentType, noteOverrides) => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      insertProvider(raw);
      insertModel(raw);
      expect(() => raw.prepare(`
        INSERT INTO agent_model_policy
          (agent_type, provider_id, model_id, quality, speed, cost, created_at, updated_at)
        VALUES (@agent_type, 'provider-1', 'mimo-v2.5-pro', @quality, @speed, @cost, 100, 100)
      `).run({
        agent_type: agentType,
        quality: 'high',
        speed: 'medium',
        cost: 'low',
        ...noteOverrides,
      })).toThrow(/constraint/i);
    } finally {
      raw.close();
    }
  });

  it('prevents every policy scope from referencing a model owned by another Provider', () => {
    database = new AppDatabase(databasePath);
    database.createProject(PROJECT_ID, 'Policy project', projectPath);
    database.createSession(TASK_ID, PROJECT_ID, 'Policy task');
    const raw = rawDatabase();
    try {
      insertProvider(raw);
      insertProvider(raw, {
        id: 'provider-2',
        credential_ref: 'safe-storage://v1/22222222-2222-4222-8222-222222222222',
      });
      insertModel(raw, 'provider-2', 'other-model');

      const policyRows = [
        [
          `INSERT INTO agent_model_policy
            (agent_type, provider_id, model_id, created_at, updated_at)
           VALUES ('planner', 'provider-1', 'other-model', 100, 100)`,
        ],
        [
          `INSERT INTO project_model_policy
            (project_id, agent_type, provider_id, model_id, created_at, updated_at)
           VALUES ('${PROJECT_ID}', 'default', 'provider-1', 'other-model', 100, 100)`,
        ],
        [
          `INSERT INTO task_model_overrides
            (task_id, provider_id, model_id, created_at, updated_at)
           VALUES ('${TASK_ID}', 'provider-1', 'other-model', 100, 100)`,
        ],
      ];
      for (const [sql] of policyRows) {
        expect(() => raw.exec(sql)).toThrow(/foreign key/i);
      }
    } finally {
      raw.close();
    }
  });

  it('supports project default and per-role policies while cascading project and task deletion', () => {
    database = new AppDatabase(databasePath);
    database.createProject(PROJECT_ID, 'Policy project', projectPath);
    database.createSession(TASK_ID, PROJECT_ID, 'Policy task');
    const raw = rawDatabase();
    try {
      insertProvider(raw);
      insertModel(raw);
      raw.prepare(`
        INSERT INTO project_model_policy
          (project_id, agent_type, provider_id, model_id, created_at, updated_at)
        VALUES (?, ?, 'provider-1', 'mimo-v2.5-pro', 100, 100)
      `).run(PROJECT_ID, 'default');
      raw.prepare(`
        INSERT INTO project_model_policy
          (project_id, agent_type, provider_id, model_id, created_at, updated_at)
        VALUES (?, ?, 'provider-1', 'mimo-v2.5-pro', 100, 100)
      `).run(PROJECT_ID, 'reviewer');
      raw.prepare(`
        INSERT INTO task_model_overrides
          (task_id, provider_id, model_id, created_at, updated_at)
        VALUES (?, 'provider-1', 'mimo-v2.5-pro', 100, 100)
      `).run(TASK_ID);

      database.deleteProject(PROJECT_ID);
      expect(raw.prepare('SELECT COUNT(*) AS count FROM project_model_policy').get())
        .toEqual({ count: 0 });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM task_model_overrides').get())
        .toEqual({ count: 0 });
    } finally {
      raw.close();
    }
  });

  it('keeps cleanup tombstones independent from Provider deletion and validates their opaque ref', () => {
    database = new AppDatabase(databasePath);
    const raw = rawDatabase();
    try {
      insertProvider(raw);
      raw.prepare(`
        INSERT INTO credential_cleanup_jobs
          (id, provider_id, credential_ref, attempts, next_attempt_at,
           last_attempt_at, last_error_type, created_at, updated_at)
        VALUES ('cleanup-1', 'provider-1', ?, 1, 200, 100, 'io', 100, 100)
      `).run(CREDENTIAL_REF);
      raw.prepare('DELETE FROM model_providers WHERE id = ?').run('provider-1');
      expect(raw.prepare('SELECT provider_id, credential_ref FROM credential_cleanup_jobs').get())
        .toEqual({ provider_id: 'provider-1', credential_ref: CREDENTIAL_REF });
      expect(() => raw.prepare(`
        INSERT INTO credential_cleanup_jobs
          (id, credential_ref, attempts, created_at, updated_at)
        VALUES ('cleanup-unsafe', 'plaintext-key', 0, 100, 100)
      `).run()).toThrow(/constraint/i);
    } finally {
      raw.close();
    }
  });

  it('rolls back every v6 table and user_version after a late DDL conflict', () => {
    createVersionFiveDatabase();
    const raw = rawDatabase();
    raw.exec('CREATE TABLE credential_cleanup_jobs (id TEXT PRIMARY KEY)');
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
      expect(inspected.pragma('user_version', { simple: true })).toBe(5);
      expect(inspected.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_providers'",
      ).get()).toBeUndefined();
      expect(inspected.pragma('table_info(credential_cleanup_jobs)')).toEqual([
        expect.objectContaining({ name: 'id' }),
      ]);
      expect(inspected.prepare('SELECT value FROM settings WHERE key = ?').get('theme'))
        .toEqual({ value: 'dark' });
    } finally {
      inspected.close();
    }
  });

  it('passes integrity checks and persists Provider state across restart', () => {
    database = new AppDatabase(databasePath);
    let raw = rawDatabase();
    try {
      insertProvider(raw);
      insertModel(raw);
    } finally {
      raw.close();
    }
    database.close();
    database = null;

    database = new AppDatabase(databasePath);
    raw = rawDatabase();
    try {
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(raw.pragma('foreign_key_check')).toEqual([]);
      expect(raw.prepare(`
        SELECT name, health_state, latency_ms FROM model_providers WHERE id = 'provider-1'
      `).get()).toEqual({ name: 'MiMo', health_state: 'connected', latency_ms: 25 });
    } finally {
      raw.close();
    }
  });
});
