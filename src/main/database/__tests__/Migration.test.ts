import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../Database';

const TEMP_PREFIX = 'claude-workbench-migration-test-';

function legacyFixture() {
  return {
    projects: {
      project: {
        id: 'project',
        name: 'Legacy project',
        path: 'C:\\legacy-project',
        created_at: '2025-01-01T00:00:00.000Z',
        last_opened_at: '2025-01-02T00:00:00.000Z',
      },
    },
    sessions: {
      session: {
        id: 'session',
        project_id: 'project',
        claude_session_id: 'claude-session',
        title: 'Legacy task',
        status: 'completed',
        model: 'mimo-v2.5-pro',
        permission_mode: 'default',
        created_at: '2025-01-01T01:00:00.000Z',
        updated_at: '2025-01-01T02:00:00.000Z',
        completed_at: '2025-01-01T02:00:00.000Z',
      },
    },
    messages: {
      message: {
        id: 'message',
        session_id: 'session',
        role: 'user',
        content: 'legacy message',
        created_at: '2025-01-01T01:01:00.000Z',
      },
    },
    events: {
      event: {
        id: 'event',
        session_id: 'session',
        event_type: 'session_completed',
        payload_json: '{"type":"session_completed"}',
        created_at: '2025-01-01T02:00:00.000Z',
      },
    },
    fileChanges: {
      change: {
        id: 'change',
        session_id: 'session',
        file_path: 'src/index.ts',
        change_type: 'modified',
        additions: 3,
        deletions: 1,
        created_at: '2025-01-01T01:30:00.000Z',
      },
    },
    settings: { theme: 'dark' },
  };
}

function removeTemp(directory: string): void {
  const target = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

describe('SQLite migration', () => {
  let directory: string;
  let databasePath: string;
  let database: AppDatabase | null;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    databasePath = path.join(directory, 'claude-workbench.db');
    database = null;
  });

  afterEach(() => {
    database?.close();
    removeTemp(directory);
  });

  function openLegacy(): AppDatabase {
    fs.writeFileSync(databasePath, JSON.stringify(legacyFixture()), 'utf8');
    database = new AppDatabase(databasePath);
    return database;
  }

  it('creates a real SQLite database for a new profile', () => {
    database = new AppDatabase(databasePath);
    database.close();
    expect(fs.readFileSync(databasePath).subarray(0, 15).toString()).toBe('SQLite format 3');
  });

  it('backs up the legacy JSON before importing it', () => {
    const db = openLegacy();
    const info = db.getMigrationInfo();
    expect(info.backupPath).toBeTruthy();
    expect(fs.existsSync(info.backupPath as string)).toBe(true);
    expect(JSON.parse(fs.readFileSync(info.backupPath as string, 'utf8')).projects.project.id).toBe('project');
  });

  it('reports the migration and schema version', () => {
    expect(openLegacy().getMigrationInfo()).toMatchObject({
      migratedLegacyJson: true,
      schemaVersion: 7,
    });
  });

  it('imports legacy projects', () => {
    expect(openLegacy().getProject('project')).toMatchObject({
      name: 'Legacy project',
      path: 'C:\\legacy-project',
    });
  });

  it('imports legacy sessions with stable defaults', () => {
    expect(openLegacy().getSession('session')).toMatchObject({
      claude_session_id: 'claude-session',
      title: 'Legacy task',
      archived: false,
      tags: [],
      title_source: 'default',
    });
  });

  it('imports legacy messages', () => {
    expect(openLegacy().listMessages('session')).toEqual([
      expect.objectContaining({ id: 'message', content: 'legacy message' }),
    ]);
  });

  it('imports legacy events', () => {
    expect(openLegacy().listEvents('session')).toEqual([
      expect.objectContaining({ id: 'event', event_type: 'session_completed' }),
    ]);
  });

  it('imports legacy file changes with nullable snapshots', () => {
    expect(openLegacy().listFileChanges('session')).toEqual([
      expect.objectContaining({
        id: 'change',
        additions: 3,
        deletions: 1,
        old_content: null,
        new_content: null,
        is_binary: false,
      }),
    ]);
  });

  it('imports legacy settings', () => {
    expect(openLegacy().getSetting('theme')).toBe('dark');
  });

  it('creates a task record for each imported session', () => {
    expect(openLegacy().getTask('session')).toMatchObject({
      session_id: 'session',
      project_id: 'project',
      status: 'completed',
      agent_mode: 'normal',
    });
  });

  it('does not import an existing SQLite database a second time', () => {
    const first = openLegacy();
    const backup = first.getMigrationInfo().backupPath;
    first.close();
    database = new AppDatabase(databasePath);
    expect(database.getMigrationInfo()).toMatchObject({
      migratedLegacyJson: false,
      backupPath: null,
    });
    expect(fs.existsSync(backup as string)).toBe(true);
    expect(database.getSession('session')?.title).toBe('Legacy task');
  });

  it('fails closed on malformed legacy content without replacing user data', () => {
    const malformed = '{not valid json';
    fs.writeFileSync(databasePath, malformed, 'utf8');
    expect(() => new AppDatabase(databasePath)).toThrow(/neither valid SQLite nor valid legacy/i);
    expect(fs.readFileSync(databasePath, 'utf8')).toBe(malformed);
    expect(fs.readdirSync(directory)).toEqual(['claude-workbench.db']);
  });

  it('persists imported data across restart', () => {
    const first = openLegacy();
    first.close();
    database = new AppDatabase(databasePath);
    expect(database.getProject('project')?.name).toBe('Legacy project');
    expect(database.listMessages('session')[0]?.content).toBe('legacy message');
  });

  it('supports paginated message reads after migration', () => {
    const db = openLegacy();
    db.createMessage('message-2', 'session', 'assistant', 'second');
    db.createMessage('message-3', 'session', 'user', 'third');
    expect(db.listMessages('session', { limit: 1, offset: 1 })).toHaveLength(1);
    expect(db.countMessages('session')).toBe(3);
  });

  it('persists project settings and permission metrics in normalized tables', () => {
    const db = openLegacy();
    db.setProjectSettings('project', {
      default_model: 'mimo-v2.5-pro',
      favorite: true,
      disabled_mcp_servers: ['browser'],
    });
    db.createPermission({
      id: 'permission',
      session_id: 'session',
      run_id: 'run',
      tool_name: 'Write',
      decision: 'allow_once',
      created_at: '2025-01-01T01:15:00.000Z',
      resolved_at: '2025-01-01T01:16:00.000Z',
    });
    expect(db.getProjectSettings('project')).toMatchObject({
      favorite: true,
      disabled_mcp_servers: ['browser'],
    });
    expect(db.getTask('session')?.permission_count).toBe(1);
  });
});
