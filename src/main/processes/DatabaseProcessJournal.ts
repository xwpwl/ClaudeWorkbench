import type { AppDatabase, ManagedProcessRow } from '../database/Database';
import type { StructuredLogger } from '../logging/StructuredLogger';
import type { ProcessExitRecord, ProcessJournalStore, ProcessStartRecord } from './ProcessSupervisor';

export class DatabaseProcessJournal implements ProcessJournalStore {
  constructor(
    private readonly database: AppDatabase,
    private readonly appRunId: () => string | null,
    private readonly logger?: StructuredLogger,
  ) {}

  recordStarted(record: ProcessStartRecord): void {
    const appRunId = this.appRunId();
    if (!appRunId) throw new Error('An application run must exist before spawning child processes.');
    const task = record.taskId ? this.database.getTask(record.taskId) : null;
    this.database.recordManagedProcess({
      id: record.id,
      app_run_id: appRunId,
      kind: record.kind,
      pid: record.pid,
      parent_pid: process.pid,
      creation_time: record.startedAt,
      executable_path: null,
      launch_nonce: record.id,
      project_id: task?.project_id ?? null,
      session_id: record.sessionId ?? null,
      task_id: record.taskId ?? null,
      run_id: record.runId ?? null,
      state: 'running',
      started_at: record.startedAt,
      stop_requested_at: null,
      exited_at: null,
      exit_code: null,
      signal: null,
      error_code: null,
    });
    void this.logger?.info('agent', 'process.started', {
      processId: record.id,
      pid: record.pid,
      kind: record.kind,
      sessionId: record.sessionId,
      taskId: record.taskId,
      runId: record.runId,
    });
  }

  recordExited(record: ProcessExitRecord): void {
    this.database.updateManagedProcess(record.id, {
      state: record.error ? 'failed' : 'exited',
      exited_at: record.endedAt,
      exit_code: record.exitCode,
      signal: record.signal,
      error_code: record.error ? 'PROCESS_ERROR' : null,
    });
    void this.logger?.info('agent', 'process.exited', {
      processId: record.id,
      pid: record.pid,
      kind: record.kind,
      sessionId: record.sessionId,
      taskId: record.taskId,
      runId: record.runId,
      exitCode: record.exitCode,
      signal: record.signal,
      durationMs: record.durationMs,
      ...(record.error ? { error: record.error } : {}),
    });
  }

  activeFromPreviousRun(appRunId: string): ManagedProcessRow[] {
    return this.database.listManagedProcesses(appRunId, true);
  }
}
