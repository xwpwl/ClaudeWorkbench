import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase, type PermissionRow, type SessionRow } from '../../database/Database';
import { TaskQueryService } from '../TaskQueryService';

const TEMP_PREFIX = 'claude-workbench-task-query-test-';
const SESSION_ID = 'session-a';
const PROJECT_ID = 'project-a';

function safelyRemoveTestDirectory(directory: string): void {
  const tempRoot = path.resolve(os.tmpdir());
  const target = path.resolve(directory);
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

describe('TaskQueryService persisted projections', () => {
  let tempDirectory: string;
  let database: AppDatabase;
  let service: TaskQueryService;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    database = new AppDatabase(path.join(tempDirectory, 'workbench.sqlite'));
    database.createProject(PROJECT_ID, 'Project A', 'C:\\projects\\a');
    database.createSession(SESSION_ID, PROJECT_ID, 'Persisted task', 'mimo-test', 'plan');
    service = new TaskQueryService(database);
  });

  afterEach(() => {
    database.close();
    safelyRemoveTestDirectory(tempDirectory);
  });

  it('returns a stable event page fragment together with the unpaged total', () => {
    for (let index = 0; index < 5; index += 1) {
      database.createEvent(
        `run-a:${String(index).padStart(6, '0')}`,
        SESSION_ID,
        'usage_updated',
        JSON.stringify({ type: 'usage_updated', runId: 'run-a', totalTokens: index }),
        `2025-01-01T00:00:0${index}.000Z`,
      );
    }

    const page = service.listEvents(SESSION_ID, { limit: 2, offset: 1 });

    expect(page).toMatchObject({ total: 5, limit: 2, offset: 1 });
    expect(page.items.map((item) => item.id)).toEqual(['run-a:000001', 'run-a:000002']);
  });

  it.each([
    [{}, 200, 0],
    [{ limit: 0, offset: -10 }, 1, 0],
    [{ limit: 9.9, offset: 3.8 }, 9, 3],
    [{ limit: 50_000, offset: 2 }, 500, 2],
    [{ limit: Number.NaN, offset: Number.POSITIVE_INFINITY }, 200, 0],
  ] as const)('normalizes page request %o to limit %i and offset %i', (request, limit, offset) => {
    expect(service.listEvents(SESSION_ID, request)).toMatchObject({ limit, offset });
  });

  it('enforces the 500-event page ceiling while retaining the true count', () => {
    for (let index = 0; index < 501; index += 1) {
      database.createEvent(
        `run-page:${String(index).padStart(6, '0')}`,
        SESSION_ID,
        'usage_updated',
        JSON.stringify({ type: 'usage_updated', runId: 'run-page', totalTokens: index }),
        '2025-01-01T00:00:00.000Z',
      );
    }

    const page = service.listEvents(SESSION_ID, { limit: 10_000, offset: 0 });

    expect(page).toMatchObject({ total: 501, limit: 500, offset: 0 });
    expect(page.items).toHaveLength(500);
    expect(page.items.at(-1)?.id).toBe('run-page:000499');
  });

  it('contains malformed and non-object JSON payloads instead of throwing', () => {
    database.createEvent('event-1', SESSION_ID, 'valid', '{"ok":true}', '2025-01-01T00:00:01.000Z');
    database.createEvent('event-2', SESSION_ID, 'primitive', '42', '2025-01-01T00:00:02.000Z');
    database.createEvent('event-3', SESSION_ID, 'array', '[1,2]', '2025-01-01T00:00:03.000Z');
    database.createEvent('event-4', SESSION_ID, 'invalid', '{broken', '2025-01-01T00:00:04.000Z');

    expect(service.listEvents(SESSION_ID).items.map((item) => item.payload)).toEqual([
      { ok: true },
      { value: 42 },
      { value: [1, 2] },
      { invalidPayload: true },
    ]);
  });

  it('returns null snapshot and report for an unknown session', () => {
    expect(service.getSnapshot('missing-session')).toBeNull();
    expect(service.buildReport('missing-session')).toBeNull();
  });

  it('projects terminal metadata, usage, tests, permissions, files, and a paged event slice', () => {
    database.updateSessionMetadata(SESSION_ID, {
      status: 'completed',
      model: 'mimo-v2.5-pro',
      permissionMode: 'default',
      completedAt: '2025-02-01T01:01:01.000Z',
    });
    database.updateTask(SESSION_ID, {
      status: 'completed',
      agent_mode: 'develop',
      started_at: '2025-02-01T00:00:00.000Z',
      completed_at: '2025-02-01T01:01:01.000Z',
      duration_ms: 3_661_000,
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      test_status: 'passed',
      test_command: 'npm test',
      test_output: 'all passed',
    });
    const permissions: PermissionRow[] = [
      { id: 'permission-1', session_id: SESSION_ID, run_id: 'run-a', tool_name: 'Write', decision: 'allow_once', created_at: '2025-02-01T00:10:00.000Z', resolved_at: '2025-02-01T00:10:01.000Z' },
      { id: 'permission-2', session_id: SESSION_ID, run_id: 'run-a', tool_name: 'Bash', decision: 'deny', created_at: '2025-02-01T00:20:00.000Z', resolved_at: '2025-02-01T00:20:01.000Z' },
    ];
    for (const permission of permissions) database.createPermission(permission);
    database.createFileChange('change-1', SESSION_ID, 'src/a.ts', 'modified', 7, 2, {
      oldContent: 'old', newContent: 'new', isBinary: false,
    });
    database.createFileChange('change-2', SESSION_ID, 'image.bin', 'modified', 0, 0, {
      oldContent: null, newContent: null, isBinary: true,
    });
    database.createEvent('run-a:000001', SESSION_ID, 'usage_updated', '{"totalTokens":100}', '2025-02-01T00:30:00.000Z');
    database.createEvent('run-a:000002', SESSION_ID, 'session_completed', '{"result":"done"}', '2025-02-01T01:01:01.000Z');

    const result = service.getSnapshot(SESSION_ID, { limit: 1, offset: 1 });

    expect(result).toMatchObject({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      title: 'Persisted task',
      status: 'completed',
      model: 'mimo-v2.5-pro',
      permissionMode: 'default',
      agentMode: 'develop',
      startedAt: '2025-02-01T00:00:00.000Z',
      completedAt: '2025-02-01T01:01:01.000Z',
      durationMs: 3_661_000,
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      permissionCount: 2,
      test: { status: 'passed', command: 'npm test', output: 'all passed' },
      totalAdditions: 7,
      totalDeletions: 2,
      eventOffset: 1,
      eventTotal: 2,
    });
    expect(result?.events).toEqual([
      expect.objectContaining({ id: 'run-a:000002', type: 'session_completed' }),
    ]);
    expect(result?.fileChanges).toEqual([
      expect.objectContaining({ filePath: 'src/a.ts', oldContent: 'old', newContent: 'new', isBinary: false }),
      expect.objectContaining({ filePath: 'image.bin', oldContent: null, newContent: null, isBinary: true }),
    ]);
  });

  it('falls back to session fields and permission rows when no task row exists', () => {
    const session: SessionRow = {
      id: 'fallback-session',
      project_id: 'fallback-project',
      claude_session_id: null,
      title: 'Fallback task',
      status: 'failed',
      model: null,
      permission_mode: null,
      created_at: '2025-03-01T00:00:00.000Z',
      updated_at: '2025-03-01T00:01:00.000Z',
      completed_at: '2025-03-01T00:01:00.000Z',
      archived: false,
      tags: [],
      title_source: 'default',
    };
    const fallbackDatabase = {
      getSession: vi.fn(() => session),
      getTask: vi.fn(() => null),
      listFileChanges: vi.fn(() => []),
      listEvents: vi.fn(() => []),
      countEvents: vi.fn(() => 0),
      listPermissions: vi.fn(() => [{ id: 'p1' }, { id: 'p2' }]),
    } as unknown as AppDatabase;

    const result = new TaskQueryService(fallbackDatabase).getSnapshot(session.id);

    expect(result).toMatchObject({
      status: 'failed',
      agentMode: 'normal',
      startedAt: '2025-03-01T00:00:00.000Z',
      completedAt: '2025-03-01T00:01:00.000Z',
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      permissionCount: 2,
    });
  });

  it('separates user, automatic, denied, timeout, unsupported, policy, and lifecycle outcomes', () => {
    const session = database.getSession(SESSION_ID)!;
    const decisions = [
      'allow_once',
      'allow_for_task',
      'permission_auto_allowed',
      'deny',
      'timeout',
      'invalid_decision',
      'run_inactive',
      'policy_blocked',
      'future_unknown_cause',
    ];
    const statsDatabase = {
      getSession: vi.fn(() => session),
      getTask: vi.fn(() => null),
      listFileChanges: vi.fn(() => []),
      listEvents: vi.fn(() => []),
      countEvents: vi.fn(() => 0),
      listPermissions: vi.fn(() => decisions.map((decision, index) => ({
        id: `permission-${index}`,
        decision,
      }))),
    } as unknown as AppDatabase;

    const result = new TaskQueryService(statsDatabase).getSnapshot(SESSION_ID);

    expect(result?.permissionStats).toEqual({
      total: 9,
      userAllowed: 2,
      autoAllowed: 1,
      denied: 1,
      timedOut: 1,
      unsupported: 1,
      policyBlocked: 1,
      lifecycleCancelled: 1,
      other: 1,
    });
    expect(result?.permissionCount).toBe(9);
  });

  it('builds a deterministic report from complete statistics rather than its one-event page', () => {
    database.updateTask(SESSION_ID, {
      status: 'completed',
      agent_mode: 'review',
      duration_ms: 3_661_000,
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
      permission_count: 3,
      test_status: 'passed',
      test_command: 'npx vitest run',
      test_output: '17 passed',
    });
    database.createFileChange('change-a', SESSION_ID, 'src/a.ts', 'modified', 10, 2);
    database.createFileChange('change-b', SESSION_ID, 'src/b.ts', 'added', 5, 0);
    database.createPermission({ id: 'report-p1', session_id: SESSION_ID, run_id: 'run-report', tool_name: 'Write', decision: 'allow_once', created_at: '2025-02-01T00:00:00.000Z', resolved_at: '2025-02-01T00:00:01.000Z' });
    database.createPermission({ id: 'report-p2', session_id: SESSION_ID, run_id: 'run-report', tool_name: 'Bash', decision: 'permission_auto_allowed', created_at: '2025-02-01T00:00:02.000Z', resolved_at: '2025-02-01T00:00:03.000Z' });
    database.createPermission({ id: 'report-p3', session_id: SESSION_ID, run_id: 'run-report', tool_name: 'Bash', decision: 'deny', created_at: '2025-02-01T00:00:04.000Z', resolved_at: '2025-02-01T00:00:05.000Z' });
    for (let index = 0; index < 3; index += 1) {
      database.createEvent(`run-report:00000${index}`, SESSION_ID, 'usage_updated', '{}');
    }

    const report = service.buildReport(SESSION_ID);

    expect(report?.fileName).toBe('task-session-a.md');
    expect(report?.markdown).toContain('# 任务完成');
    expect(report?.markdown).toContain('- 修改：2 个文件');
    expect(report?.markdown).toContain('- 新增：15 行');
    expect(report?.markdown).toContain('- 删除：2 行');
    expect(report?.markdown).toContain('- 耗时：1h 1m');
    expect(report?.markdown).toContain('- Token：16');
    expect(report?.markdown).toContain('- 权限：3 次请求（用户允许 1，自动允许 1，拒绝 1）');
    expect(report?.markdown).toContain('npx vitest run\n\n17 passed');
    expect(report?.markdown).toContain('- src/a.ts (+10 / -2)');
    expect(report?.markdown).toContain('- src/b.ts (+5 / -0)');
  });

  it('uses report fallbacks and sanitizes an unsafe session id', () => {
    const unsafeSessionId = 'session:/?* with spaces';
    database.createSession(unsafeSessionId, PROJECT_ID, 'No artifacts');

    const report = service.buildReport(unsafeSessionId);

    expect(report?.fileName).toMatch(/^task-[a-zA-Z0-9_-]+\.md$/);
    expect(report?.fileName).not.toContain(':');
    expect(report?.markdown).toContain('- 模型：Claude Code 默认');
    expect(report?.markdown).toContain('未记录测试命令');
    expect(report?.markdown).toContain('- 无已记录的文件修改');
  });
});
