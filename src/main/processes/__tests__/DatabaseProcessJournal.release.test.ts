import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../../database/Database';
import type { StructuredLogger } from '../../logging/StructuredLogger';
import { DatabaseProcessJournal } from '../DatabaseProcessJournal';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function journalHarness() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-process-release-'));
  temporaryRoots.push(temporaryRoot);
  const database = new AppDatabase(path.join(temporaryRoot, 'journal.sqlite'));
  database.createAppRun({
    id: 'run-current',
    pid: 100,
    build_id: 'release-test',
    started_at: '2026-08-01T00:00:00.000Z',
    heartbeat_at: '2026-08-01T00:00:00.000Z',
    shutdown_started_at: null,
    clean_shutdown_at: null,
    status: 'running',
  });
  const info = vi.fn(async () => undefined);
  const logger = { info } as unknown as StructuredLogger;
  const journal = new DatabaseProcessJournal(database, () => 'run-current', logger);
  return { database, info, journal };
}

describe('DatabaseProcessJournal release states', () => {
  it.each(['claude', 'mcp', 'terminal'] as const)('persists a minimal running row for %s', (kind) => {
    const test = journalHarness();
    test.journal.recordStarted({
      id: `child-${kind}`,
      pid: 101,
      kind,
      sessionId: 'session-safe',
      taskId: 'missing-task-does-not-fail',
      runId: 'agent-run-safe',
      startedAt: '2026-08-01T00:00:01.000Z',
    });

    const row = test.database.listManagedProcesses('run-current')[0];
    expect(row).toMatchObject({
      id: `child-${kind}`,
      kind,
      state: 'running',
      session_id: 'session-safe',
      task_id: 'missing-task-does-not-fail',
      run_id: 'agent-run-safe',
      executable_path: null,
      launch_nonce: `child-${kind}`,
    });
    expect(JSON.stringify(row)).not.toMatch(/command|args|environment/iu);
    expect(test.info).toHaveBeenCalledWith('agent', 'process.started', expect.objectContaining({ kind }));
    test.database.close();
  });

  it.each([
    { exitCode: 0, signal: null, error: undefined, state: 'exited', errorCode: null },
    { exitCode: null, signal: 'SIGTERM', error: undefined, state: 'exited', errorCode: null },
    { exitCode: null, signal: null, error: 'spawn EACCES', state: 'failed', errorCode: 'PROCESS_ERROR' },
  ] as const)('persists the terminal journal state $state', (terminal) => {
    const test = journalHarness();
    test.journal.recordStarted({
      id: 'child-terminal-state',
      pid: 102,
      kind: 'claude',
      startedAt: '2026-08-01T00:00:01.000Z',
    });
    test.journal.recordExited({
      id: 'child-terminal-state',
      pid: 102,
      kind: 'claude',
      startedAt: '2026-08-01T00:00:01.000Z',
      endedAt: '2026-08-01T00:00:03.000Z',
      exitCode: terminal.exitCode,
      signal: terminal.signal,
      durationMs: 2_000,
      ...(terminal.error ? { error: terminal.error } : {}),
    });

    const row = test.database.listManagedProcesses('run-current')[0];
    expect(row).toMatchObject({
      state: terminal.state,
      exit_code: terminal.exitCode,
      signal: terminal.signal,
      error_code: terminal.errorCode,
      exited_at: '2026-08-01T00:00:03.000Z',
    });
    expect(test.info).toHaveBeenLastCalledWith(
      'agent',
      'process.exited',
      expect.objectContaining({ durationMs: 2_000 }),
    );
    test.database.close();
  });

  it('returns only non-terminal rows when scanning a previous run for orphans', () => {
    const test = journalHarness();
    for (const [id, state] of [
      ['starting', 'starting'],
      ['running', 'running'],
      ['stopping', 'stopping'],
      ['exited', 'exited'],
      ['failed', 'failed'],
    ] as const) {
      test.database.recordManagedProcess({
        id,
        app_run_id: 'run-current',
        kind: 'mcp',
        pid: 200,
        parent_pid: 100,
        creation_time: '2026-08-01T00:00:00.000Z',
        executable_path: null,
        launch_nonce: id,
        project_id: null,
        session_id: null,
        task_id: null,
        run_id: null,
        state,
        started_at: '2026-08-01T00:00:00.000Z',
        stop_requested_at: null,
        exited_at: state === 'exited' || state === 'failed' ? '2026-08-01T00:00:01.000Z' : null,
        exit_code: null,
        signal: null,
        error_code: state === 'failed' ? 'PROCESS_ERROR' : null,
      });
    }

    expect(test.journal.activeFromPreviousRun('run-current').map((row) => row.id))
      .toEqual(['running', 'starting', 'stopping']);
    test.database.close();
  });
});
