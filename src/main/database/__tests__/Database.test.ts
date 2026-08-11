import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../Database';

const TEMP_PREFIX = 'claude-workbench-database-test-';

function emptyDatabaseData() {
  return {
    projects: {},
    sessions: {},
    messages: {},
    events: {},
    fileChanges: {},
    settings: {},
  };
}

function safelyRemoveTestDirectory(directory: string): void {
  const tempRoot = path.resolve(os.tmpdir());
  const target = path.resolve(directory);
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

describe('AppDatabase', () => {
  let tempDirectory: string;
  let databasePath: string;
  let database: AppDatabase;

  beforeEach(() => {
    vi.useRealTimers();
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    databasePath = path.join(tempDirectory, 'database.json');
    // Give every test fresh nested records instead of sharing module defaults.
    fs.writeFileSync(databasePath, JSON.stringify(emptyDatabaseData()), 'utf8');
    database = new AppDatabase(databasePath);
  });

  afterEach(() => {
    database.close();
    vi.useRealTimers();
    safelyRemoveTestDirectory(tempDirectory);
  });

  it('loads legacy JSON without new session fields or newer top-level collections', () => {
    database.close();
    fs.writeFileSync(databasePath, JSON.stringify({
      projects: {
        legacyProject: {
          id: 'legacyProject',
          name: 'Legacy project',
          path: 'C:\\legacy',
          created_at: '2024-01-01T00:00:00.000Z',
          last_opened_at: '2024-01-01T00:00:00.000Z',
        },
      },
      sessions: {
        legacySession: {
          id: 'legacySession',
          project_id: 'legacyProject',
          claude_session_id: null,
          title: 'Legacy task',
          status: 'idle',
          model: null,
          permission_mode: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
          completed_at: null,
        },
      },
      messages: {},
      settings: {},
    }), 'utf8');

    database = new AppDatabase(databasePath);

    expect(database.getProject('legacyProject')?.name).toBe('Legacy project');
    expect(database.getSession('legacySession')).toMatchObject({
      id: 'legacySession',
      title: 'Legacy task',
      status: 'idle',
    });
    expect(database.listEvents('legacySession')).toEqual([]);
    expect(database.listFileChanges('legacySession')).toEqual([]);
  });

  it('creates and lists a session with stable defaults', () => {
    database.createProject('project-1', 'Project 1', 'C:\\project-1');
    database.createSession('session-1', 'project-1', 'New Task', 'mimo', 'plan');

    expect(database.listSessions('project-1')).toEqual([
      expect.objectContaining({
        id: 'session-1',
        project_id: 'project-1',
        title: 'New Task',
        title_source: 'default',
        status: 'idle',
        model: 'mimo',
        permission_mode: 'plan',
        claude_session_id: null,
        archived: false,
        tags: [],
      }),
    ]);
  });

  it('builds a closed anonymous performance source from trusted aggregate queries', () => {
    database.createProject('aggregate-project', 'Private name', 'C:\\private\\source');
    const rows = [
      ['direct-complete', 'completed', 500],
      ['direct-failed', 'failed', 5_000],
      ['direct-cancelled', 'cancelled', 30_000],
      ['direct-interrupted', 'interrupted', 300_000],
      ['direct-running', 'running', 700_000],
    ] as const;
    for (const [id, status, duration_ms] of rows) {
      database.createSession(id, 'aggregate-project', `Private ${id}`);
      database.updateTask(id, { status, duration_ms });
    }
    for (const [id, task_id, status] of [
      ['orchestrated-complete', 'direct-complete', 'completed'],
      ['orchestrated-failed', 'direct-failed', 'failed'],
      ['orchestrated-cancelled', 'direct-cancelled', 'cancelled'],
      ['orchestrated-paused', 'direct-interrupted', 'paused'],
    ] as const) {
      database.createWorkflow({
        id,
        task_id,
        status,
        current_stage: null,
        created_at: '2026-08-09T00:00:00.000Z',
        updated_at: '2026-08-09T00:00:00.000Z',
        metadata_json: '{}',
      });
    }

    const source = database.getAnonymousPerformanceSource();

    expect(source).toEqual({
      operations: {
        direct: { total: 5, completed: 1, failed: 1, cancelled: 1, interrupted: 1 },
        orchestrated: { total: 4, completed: 1, failed: 1, cancelled: 1, interrupted: 0 },
      },
      durationBuckets: {
        underOneSecond: 1,
        oneToTenSeconds: 1,
        tenToSixtySeconds: 1,
        oneToTenMinutes: 1,
        tenMinutesOrMore: 1,
      },
    });
    expect(JSON.stringify(source)).not.toMatch(
      /aggregate-project|private|id|name|path|prompt|message|url|provider|model|task|session|project|permission|git|checkpoint|mcp|tool|credential|ref|vault|blob|env/iu,
    );
  });

  it('returns a closed all-zero source when there is no performance history', () => {
    expect(database.getAnonymousPerformanceSource()).toEqual({
      operations: {
        direct: { total: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 },
        orchestrated: { total: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 },
      },
      durationBuckets: {
        underOneSecond: 0,
        oneToTenSeconds: 0,
        tenToSixtySeconds: 0,
        oneToTenMinutes: 0,
        tenMinutesOrMore: 0,
      },
    });
  });

  it('fails the anonymous source closed when storage contains an unknown status', () => {
    database.createProject('aggregate-project', 'Private name', 'C:\\private\\source');
    database.createSession('unknown-status', 'aggregate-project', 'Private title');
    database.updateTask('unknown-status', { status: 'future-status' });

    expect(() => database.getAnonymousPerformanceSource()).toThrow(
      'Anonymous performance data is unavailable.',
    );
  });

  it('creates Session and Task atomically and preserves a conflicting Task owner', () => {
    database.createProject('project-a', 'A', 'C:\\a');
    database.createProject('project-b', 'B', 'C:\\b');
    database.ensureTask('session-conflict', 'project-b');

    expect(() => database.createSession(
      'session-conflict',
      'project-a',
      'Must roll back',
    )).toThrow('Session Task identity is already owned.');

    expect(database.getSession('session-conflict')).toBeNull();
    expect(database.getTask('session-conflict')).toMatchObject({
      id: 'session-conflict',
      session_id: 'session-conflict',
      project_id: 'project-b',
    });
  });

  it('lists sessions by most recently updated first', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    database.createSession('session-old', 'project-1', 'Old');
    vi.setSystemTime(new Date('2025-01-01T00:01:00.000Z'));
    database.createSession('session-new', 'project-1', 'New');
    vi.setSystemTime(new Date('2025-01-01T00:02:00.000Z'));
    database.updateSessionMetadata('session-old', { status: 'running' });

    expect(database.listSessions('project-1').map((session) => session.id)).toEqual([
      'session-old',
      'session-new',
    ]);
  });

  it('updates a session title together with its title source', () => {
    database.createSession('session-1', 'project-1', 'New Task');

    database.updateSessionMetadata('session-1', {
      title: 'User supplied title',
      titleSource: 'manual',
    });

    expect(database.getSession('session-1')).toMatchObject({
      title: 'User supplied title',
      title_source: 'manual',
    });
  });

  it('updates status and Claude session id atomically', () => {
    database.createSession('session-1', 'project-1', 'Task');

    database.updateSessionStatus('session-1', 'running', 'claude-session-1');

    expect(database.getSession('session-1')).toMatchObject({
      status: 'running',
      claude_session_id: 'claude-session-1',
    });
  });

  it('reads only the latest trusted model binding for a Session transcript', () => {
    database.createSession('session-1', 'project-1', 'Task');
    database.createEvent('init-old', 'session-1', 'system_init', JSON.stringify({
      sessionId: 'claude-old',
      modelSessionBinding: {
        claudeSessionId: 'claude-old', providerId: 'provider-old',
        modelId: 'old-model', runtimeType: 'claude-code', executionSource: 'database_provider',
      },
    }), '2026-08-09T00:00:00.000Z');
    database.createEvent('noise-newer', 'session-1', 'tool_completed', '{}', '2026-08-09T00:02:00.000Z');
    database.createEvent('init-new', 'session-1', 'system_init', JSON.stringify({
      sessionId: 'claude-new',
      modelSessionBinding: {
        claudeSessionId: 'claude-new', providerId: 'provider-mimo',
        modelId: 'mimo-v2.5-pro', runtimeType: 'claude-code', executionSource: 'environment',
      },
    }), '2026-08-09T00:01:00.000Z');

    const binding = database.getSessionModelBinding('session-1');

    expect(binding).toEqual({
      claudeSessionId: 'claude-new', providerId: 'provider-mimo',
      modelId: 'mimo-v2.5-pro', runtimeType: 'claude-code', executionSource: 'environment',
    });
  });

  it('rejects a persisted binding whose transcript id disagrees with system_init', () => {
    database.createSession('session-1', 'project-1', 'Task');
    database.createEvent('init-mismatch', 'session-1', 'system_init', JSON.stringify({
      sessionId: 'claude-outer',
      modelSessionBinding: {
        claudeSessionId: 'claude-inner', providerId: 'provider-mimo',
        modelId: 'mimo-v2.5-pro', runtimeType: 'claude-code', executionSource: 'database_provider',
      },
    }));

    expect(database.getSessionModelBinding('session-1')).toBeNull();
  });

  it.each([
    { label: 'legacy missing provenance', executionSource: undefined },
    { label: 'corrupt non-string provenance', executionSource: 42 },
    { label: 'unknown future provenance', executionSource: 'renderer_claim' },
    { label: 'control-character provenance', executionSource: 'environment\0' },
  ])('rejects a $label in a persisted Session model binding', ({ executionSource }) => {
    database.createSession('session-1', 'project-1', 'Task');
    database.createEvent('init-invalid-source', 'session-1', 'system_init', JSON.stringify({
      sessionId: 'claude-session-1',
      modelSessionBinding: {
        claudeSessionId: 'claude-session-1', providerId: 'provider-mimo',
        modelId: 'mimo-v2.5-pro', runtimeType: 'claude-code',
        ...(executionSource === undefined ? {} : { executionSource }),
      },
    }));

    expect(database.getSessionModelBinding('session-1')).toBeNull();
  });

  it('rejects unknown binding fields instead of accepting persisted secret references', () => {
    database.createSession('session-1', 'project-1', 'Task');
    database.createEvent('init-extra-field', 'session-1', 'system_init', JSON.stringify({
      sessionId: 'claude-session-1',
      modelSessionBinding: {
        claudeSessionId: 'claude-session-1', providerId: 'provider-mimo',
        modelId: 'mimo-v2.5-pro', runtimeType: 'claude-code',
        executionSource: 'database_provider', credentialRef: 'must-not-be-trusted',
      },
    }));

    expect(database.getSessionModelBinding('session-1')).toBeNull();
  });

  it('marks a session completed with a completion timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-03T04:05:06.000Z'));
    database.createSession('session-1', 'project-1', 'Task');

    database.completeSession('session-1');

    expect(database.getSession('session-1')).toMatchObject({
      status: 'completed',
      completed_at: '2025-02-03T04:05:06.000Z',
      updated_at: '2025-02-03T04:05:06.000Z',
    });
  });

  it('updates archived state and stores a defensive copy of tags', () => {
    database.createSession('session-1', 'project-1', 'Task');
    const tags = ['archived', 'important'];

    database.updateSessionMetadata('session-1', { archived: true, tags });
    tags.push('mutated-after-update');

    expect(database.getSession('session-1')).toMatchObject({
      archived: true,
      tags: ['archived', 'important'],
    });
  });

  it('upserts a message by stable id without changing its creation time', () => {
    vi.useFakeTimers();
    database.createSession('session-1', 'project-1', 'Task');
    vi.setSystemTime(new Date('2025-03-01T00:00:00.000Z'));
    database.createMessage('message-1', 'session-1', 'assistant', 'draft');
    vi.setSystemTime(new Date('2025-03-01T00:05:00.000Z'));
    database.createMessage('message-1', 'session-1', 'assistant', 'final');

    expect(database.listMessages('session-1')).toEqual([
      expect.objectContaining({
        id: 'message-1',
        content: 'final',
        created_at: '2025-03-01T00:00:00.000Z',
      }),
    ]);
  });

  it('touches session updated_at when a message is created', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-04-01T00:00:00.000Z'));
    database.createSession('session-1', 'project-1', 'Task');
    const before = database.getSession('session-1')?.updated_at;
    vi.setSystemTime(new Date('2025-04-01T00:10:00.000Z'));

    database.createMessage('message-1', 'session-1', 'user', 'Hello');

    expect(before).toBe('2025-04-01T00:00:00.000Z');
    expect(database.getSession('session-1')?.updated_at).toBe('2025-04-01T00:10:00.000Z');
  });

  it('lists messages in creation order regardless of insertion order', () => {
    vi.useFakeTimers();
    database.createSession('session-1', 'project-1', 'Task');
    vi.setSystemTime(new Date('2025-05-01T00:03:00.000Z'));
    database.createMessage('message-3', 'session-1', 'assistant', 'third');
    vi.setSystemTime(new Date('2025-05-01T00:01:00.000Z'));
    database.createMessage('message-1', 'session-1', 'user', 'first');
    vi.setSystemTime(new Date('2025-05-01T00:02:00.000Z'));
    database.createMessage('message-2', 'session-1', 'assistant', 'second');

    expect(database.listMessages('session-1').map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
    ]);
  });

  it('copies source messages through the requested message into the target session', () => {
    vi.useFakeTimers();
    database.createSession('source', 'project-1', 'Source');
    database.createSession('target', 'project-1', 'Target');
    vi.setSystemTime(new Date('2025-06-01T00:01:00.000Z'));
    database.createMessage('message-1', 'source', 'user', 'first');
    vi.setSystemTime(new Date('2025-06-01T00:02:00.000Z'));
    database.createMessage('message-2', 'source', 'assistant', 'second');
    vi.setSystemTime(new Date('2025-06-01T00:03:00.000Z'));
    database.createMessage('message-3', 'source', 'user', 'third');

    database.copyMessages('source', 'target', 'message-2');

    expect(database.listMessages('target')).toEqual([
      expect.objectContaining({ id: 'target:message-1', session_id: 'target', content: 'first' }),
      expect.objectContaining({ id: 'target:message-2', session_id: 'target', content: 'second' }),
    ]);
    expect(database.listMessages('source')).toHaveLength(3);
  });

  it('isolates sessions by project id', () => {
    database.createProject('project-a', 'A', 'C:\\a');
    database.createProject('project-b', 'B', 'C:\\b');
    database.createSession('session-a', 'project-a', 'A task');
    database.createSession('session-b', 'project-b', 'B task');

    expect(database.listSessions('project-a').map((session) => session.id)).toEqual(['session-a']);
    expect(database.listSessions('project-b').map((session) => session.id)).toEqual(['session-b']);
  });

  it('inserts a first-run project only when both its id and path are unclaimed', () => {
    const owned = {
      id: 'first-run-project',
      name: 'Claude Workbench Test Project',
      path: 'C:\\first-run-projects\\first-run-project',
      created_at: '2026-08-09T12:00:00.000Z',
      last_opened_at: '2026-08-09T12:00:00.000Z',
    };

    expect(database.insertProjectIfAbsent(owned)).toBe(true);
    expect(database.insertProjectIfAbsent({ ...owned, path: 'C:\\different' })).toBe(false);
    expect(database.insertProjectIfAbsent({ ...owned, id: 'different-id' })).toBe(false);
    expect(database.getProject(owned.id)).toEqual(owned);
    expect(database.getProject('different-id')).toBeNull();
  });

  it('conditionally removes only the exact unclaimed first-run row', () => {
    const owned = {
      id: 'first-run-owned',
      name: 'Claude Workbench Test Project',
      path: 'C:\\first-run-projects\\first-run-owned',
      created_at: '2026-08-09T12:00:00.000Z',
      last_opened_at: '2026-08-09T12:00:00.000Z',
    };
    const other = {
      id: 'other-project',
      name: 'Other',
      path: 'C:\\other-project',
      created_at: '2026-08-09T12:00:00.000Z',
      last_opened_at: '2026-08-09T12:00:00.000Z',
    };
    expect(database.insertProjectIfAbsent(owned)).toBe(true);
    expect(database.insertProjectIfAbsent(other)).toBe(true);

    expect(database.deleteProjectIfExactOwner({ ...owned, name: 'Replacement' })).toBe(false);
    expect(database.getProject(owned.id)).toEqual(owned);

    database.updateProjectName(owned.id, 'Mutated');
    expect(database.deleteProjectIfExactOwner(owned)).toBe(false);
    expect(database.getProject(owned.id)?.name).toBe('Mutated');
    expect(database.getProject(other.id)).toEqual(other);
  });

  it('refuses exact-owned rollback when the project has a Session', () => {
    const owned = {
      id: 'first-run-claimed',
      name: 'Claude Workbench Test Project',
      path: 'C:\\first-run-projects\\first-run-claimed',
      created_at: '2026-08-09T12:00:00.000Z',
      last_opened_at: '2026-08-09T12:00:00.000Z',
    };
    expect(database.insertProjectIfAbsent(owned)).toBe(true);
    database.createSession('claiming-session', owned.id, 'Claiming task');

    expect(database.deleteProjectIfExactOwner(owned)).toBe(false);
    expect(database.getProject(owned.id)).toEqual(owned);
    expect(database.getSession('claiming-session')).not.toBeNull();
  });

  it('deletes an exact unclaimed owner row without collateral project deletion', () => {
    const owned = {
      id: 'first-run-delete',
      name: 'Claude Workbench Test Project',
      path: 'C:\\first-run-projects\\first-run-delete',
      created_at: '2026-08-09T12:00:00.000Z',
      last_opened_at: '2026-08-09T12:00:00.000Z',
    };
    database.createProject('project-keep', 'Keep', 'C:\\keep');
    database.createSession('session-keep', 'project-keep', 'Keep task');
    expect(database.insertProjectIfAbsent(owned)).toBe(true);

    expect(database.deleteProjectIfExactOwner(owned)).toBe(true);
    expect(database.getProject(owned.id)).toBeNull();
    expect(database.getProject('project-keep')?.name).toBe('Keep');
    expect(database.getSession('session-keep')?.title).toBe('Keep task');
  });

  it('persists projects, session metadata, messages, and settings across restart', () => {
    database.createProject('project-1', 'Project', 'C:\\project');
    database.createSession('session-1', 'project-1', 'New Task');
    database.updateSessionMetadata('session-1', {
      title: 'Persisted title',
      titleSource: 'first_prompt',
      claudeSessionId: 'claude-persisted',
      archived: true,
      tags: ['persisted'],
    });
    database.createMessage('message-1', 'session-1', 'user', 'Persist me');
    database.setSetting('theme', 'dark');
    database.close();

    database = new AppDatabase(databasePath);

    expect(database.getProject('project-1')?.name).toBe('Project');
    expect(database.getSession('session-1')).toMatchObject({
      title: 'Persisted title',
      title_source: 'first_prompt',
      claude_session_id: 'claude-persisted',
      archived: true,
      tags: ['persisted'],
    });
    expect(database.listMessages('session-1')[0].content).toBe('Persist me');
    expect(database.getSetting('theme')).toBe('dark');
  });

  it('deletes one session and its children without affecting another session', () => {
    database.createSession('session-delete', 'project-1', 'Delete');
    database.createSession('session-keep', 'project-1', 'Keep');
    database.createMessage('message-delete', 'session-delete', 'user', 'delete');
    database.createMessage('message-keep', 'session-keep', 'user', 'keep');
    database.createEvent('event-delete', 'session-delete', 'test', '{}');
    database.createEvent('event-keep', 'session-keep', 'test', '{}');
    database.createFileChange('file-delete', 'session-delete', 'delete.ts', 'deleted', 0, 1);
    database.createFileChange('file-keep', 'session-keep', 'keep.ts', 'modified', 1, 0);

    database.deleteSession('session-delete');

    expect(database.getSession('session-delete')).toBeNull();
    expect(database.listMessages('session-delete')).toEqual([]);
    expect(database.listEvents('session-delete')).toEqual([]);
    expect(database.listFileChanges('session-delete')).toEqual([]);
    expect(database.getSession('session-keep')?.title).toBe('Keep');
    expect(database.listMessages('session-keep')[0].content).toBe('keep');
    expect(database.listEvents('session-keep')).toHaveLength(1);
    expect(database.listFileChanges('session-keep')).toHaveLength(1);
  });
});
