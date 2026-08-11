import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../../database/Database';
import { DatabaseProcessJournal } from '../DatabaseProcessJournal';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('DatabaseProcessJournal', () => {
  it('persists start and terminal metadata without commands, args, or environment', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-process-journal-'));
    roots.push(root);
    const database = new AppDatabase(path.join(root, 'db.sqlite'));
    database.createAppRun({
      id: 'app-run', pid: 1, build_id: 'build', started_at: '2026-08-01T00:00:00.000Z',
      heartbeat_at: '2026-08-01T00:00:00.000Z', shutdown_started_at: null,
      clean_shutdown_at: null, status: 'running',
    });
    const journal = new DatabaseProcessJournal(database, () => 'app-run');
    journal.recordStarted({ id: 'child', pid: 22, kind: 'claude', runId: 'run', startedAt: '2026-08-01T00:00:01.000Z' });
    journal.recordExited({
      id: 'child', pid: 22, kind: 'claude', runId: 'run', startedAt: '2026-08-01T00:00:01.000Z',
      endedAt: '2026-08-01T00:00:03.000Z', exitCode: 0, signal: null, durationMs: 2_000,
    });
    const persisted = database.listManagedProcesses('app-run')[0];
    expect(persisted).toMatchObject({ id: 'child', state: 'exited', exit_code: 0, run_id: 'run' });
    expect(JSON.stringify(persisted)).not.toContain('command');
    expect(JSON.stringify(persisted)).not.toContain('args');
    expect(JSON.stringify(persisted)).not.toContain('environment');
    database.close();
  });

  it('fails closed when child launch occurs before app-run journaling', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-process-journal-'));
    roots.push(root);
    const database = new AppDatabase(path.join(root, 'db.sqlite'));
    const journal = new DatabaseProcessJournal(database, () => null);
    expect(() => journal.recordStarted({
      id: 'child', pid: 22, kind: 'terminal', startedAt: '2026-08-01T00:00:01.000Z',
    })).toThrow(/application run/i);
    database.close();
  });
});
