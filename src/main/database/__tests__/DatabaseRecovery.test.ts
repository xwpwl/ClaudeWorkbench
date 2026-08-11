import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../Database';

const TEMP_PREFIX = 'claude-workbench-recovery-test-';
const PROJECT_ID = 'project-recovery';

function safelyRemoveTestDirectory(directory: string): void {
  const tempRoot = path.resolve(os.tmpdir());
  const target = path.resolve(directory);
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

describe('AppDatabase.recoverInterruptedTasks', () => {
  let tempDirectory: string;
  let databasePath: string;
  let database: AppDatabase;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    databasePath = path.join(tempDirectory, 'workbench.sqlite');
    database = new AppDatabase(databasePath);
    database.createProject(PROJECT_ID, 'Recovery project', 'C:\\projects\\recovery');
  });

  afterEach(() => {
    database.close();
    safelyRemoveTestDirectory(tempDirectory);
  });

  function createTask(
    sessionId: string,
    taskStatus: string,
    startedAt: string | null,
    sessionStatus = taskStatus,
  ): void {
    database.createSession(sessionId, PROJECT_ID, sessionId);
    database.updateSessionMetadata(sessionId, { status: sessionStatus });
    database.updateTask(sessionId, { status: taskStatus, started_at: startedAt });
  }

  function createWorkflow(taskId: string, status: string, metadata?: string): void {
    database.createWorkflow({
      id: `workflow-${taskId}`,
      task_id: taskId,
      status: status as never,
      current_stage: status === 'planning' ? 'planner' : 'coder',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      metadata_json: metadata ?? JSON.stringify({
        revision: 3,
        executionCycle: 1,
        activeStage: status === 'planning' ? 'planner' : 'coder',
        pauseReason: null,
      }),
    });
  }

  it('interrupts exactly starting, running, and waiting_permission tasks with their sessions', () => {
    createTask('starting-task', 'starting', '2025-01-01T00:00:00.000Z');
    createTask('running-task', 'running', '2025-01-01T00:00:10.000Z');
    createTask('permission-task', 'waiting_permission', '2025-01-01T00:00:20.000Z');
    for (const status of ['idle', 'completed', 'failed', 'cancelled']) {
      createTask(`${status}-task`, status, '2025-01-01T00:00:00.000Z');
    }

    const recovered = database.recoverInterruptedTasks('2025-01-01T00:01:00.000Z');

    expect(recovered).toBe(3);
    for (const sessionId of ['starting-task', 'running-task', 'permission-task']) {
      expect(database.getTask(sessionId)).toMatchObject({
        status: 'interrupted', completed_at: null,
      });
      expect(database.getSession(sessionId)).toMatchObject({
        status: 'interrupted', completed_at: null,
        updated_at: '2025-01-01T00:01:00.000Z',
      });
    }
    for (const status of ['idle', 'completed', 'failed', 'cancelled']) {
      expect(database.getTask(`${status}-task`)?.status).toBe(status);
      expect(database.getSession(`${status}-task`)?.status).toBe(status);
    }
  });

  it('computes each recovered duration from its own start timestamp', () => {
    createTask('one-minute', 'running', '2025-01-01T00:00:00.000Z');
    createTask('thirty-seconds', 'starting', '2025-01-01T00:00:30.000Z');
    createTask('ten-seconds', 'waiting_permission', '2025-01-01T00:00:50.000Z');

    database.recoverInterruptedTasks('2025-01-01T00:01:00.000Z');

    expect(database.getTask('one-minute')?.duration_ms).toBe(60_000);
    expect(database.getTask('thirty-seconds')?.duration_ms).toBe(30_000);
    expect(database.getTask('ten-seconds')?.duration_ms).toBe(10_000);
  });

  it('clamps a clock-skewed negative duration to zero', () => {
    createTask('future-start', 'running', '2025-01-01T00:02:00.000Z');

    database.recoverInterruptedTasks('2025-01-01T00:01:00.000Z');

    expect(database.getTask('future-start')).toMatchObject({
      status: 'interrupted', duration_ms: 0,
    });
  });

  it.each([
    ['a missing start timestamp', null],
    ['an invalid start timestamp', 'not-a-date'],
  ])('uses zero duration for %s', (_label, startedAt) => {
    createTask('invalid-start', 'running', startedAt);

    database.recoverInterruptedTasks('2025-01-01T00:01:00.000Z');

    expect(database.getTask('invalid-start')?.duration_ms).toBe(0);
  });

  it('is idempotent after the first recovery pass', () => {
    createTask('interrupted', 'running', '2025-01-01T00:00:00.000Z');

    expect(database.recoverInterruptedTasks('2025-01-01T00:01:00.000Z')).toBe(1);
    const first = database.getTask('interrupted');
    expect(database.recoverInterruptedTasks('2025-01-01T00:02:00.000Z')).toBe(0);

    expect(database.getTask('interrupted')).toEqual(first);
    expect(database.getSession('interrupted')?.completed_at).toBeNull();
  });

  it('persists recovered task and session state across a database restart', () => {
    createTask('persisted-interruption', 'waiting_permission', '2025-01-01T00:00:15.000Z');
    database.recoverInterruptedTasks('2025-01-01T00:01:00.000Z');
    database.close();

    database = new AppDatabase(databasePath);

    expect(database.getTask('persisted-interruption')).toMatchObject({
      status: 'interrupted',
      completed_at: null,
      duration_ms: 45_000,
    });
    expect(database.getSession('persisted-interruption')).toMatchObject({
      status: 'interrupted', completed_at: null,
    });
  });

  it.each(['planning', 'executing', 'testing', 'reviewing'])(
    'pauses an active %s workflow and records its exact pre-crash state',
    (status) => {
      createTask(`task-${status}`, 'idle', null);
      createWorkflow(`task-${status}`, status);

      const items = database.reconcileCrashState(null, '2025-01-01T00:01:00.000Z');

      expect(items).toContainEqual(expect.objectContaining({
        id: `recovery:workflow:workflow-task-${status}`,
        kind: 'workflow',
        resource_id: `workflow-task-${status}`,
        last_state: status,
        reason: 'unclean_shutdown',
        status: 'pending',
      }));
      const workflow = database.getWorkflow(`workflow-task-${status}`)!;
      expect(workflow).toMatchObject({ status: 'paused', current_stage: null });
      expect(JSON.parse(workflow.metadata_json)).toMatchObject({
        pausedFrom: status,
        pauseReason: 'app_crash',
        interruptedAt: '2025-01-01T00:01:00.000Z',
        activeStage: null,
        revision: 4,
      });
    },
  );

  it('leaves every terminal or user-gated workflow state untouched', () => {
    const terminalStatuses = [
      'idle', 'waiting_plan_confirmation', 'paused', 'completed', 'failed', 'cancelled',
    ];
    for (const status of terminalStatuses) {
      createTask(`terminal-${status}`, 'idle', null);
      createWorkflow(`terminal-${status}`, status);
    }

    const items = database.reconcileCrashState(null, '2025-01-01T00:01:00.000Z');

    expect(items.filter((item) => item.kind === 'workflow')).toEqual([]);
    for (const status of terminalStatuses) {
      expect(database.getWorkflow(`workflow-terminal-${status}`)?.status).toBe(status);
    }
  });

  it('maps active process, permission, and mutation journals to pending recovery items', () => {
    database.createAppRun({
      id: 'crashed-run', pid: 10, build_id: 'build', status: 'running',
      started_at: '2025-01-01T00:00:00.000Z', heartbeat_at: '2025-01-01T00:00:10.000Z',
      shutdown_started_at: null, clean_shutdown_at: null,
    });
    database.recordManagedProcess({
      id: 'claude-process', app_run_id: 'crashed-run', kind: 'claude', pid: 100,
      parent_pid: 10, creation_time: '1000', executable_path: 'claude.exe', launch_nonce: 'nonce',
      project_id: PROJECT_ID, session_id: null, task_id: null, run_id: 'run', state: 'running',
      started_at: '2025-01-01T00:00:20.000Z', stop_requested_at: null, exited_at: null,
      exit_code: null, signal: null, error_code: null,
    });
    database.recordPendingPermissionRequest({
      id: 'permission', projectId: PROJECT_ID, runId: 'run', toolName: 'Write',
      requestedAt: '2025-01-01T00:00:30.000Z',
    });
    database.recordMutationOperation({
      id: 'mutation', projectId: PROJECT_ID, projectPath: 'C:\\projects\\recovery',
      kind: 'checkpoint_restore', status: 'started', filePaths: ['src/a.ts'],
      startedAt: '2025-01-01T00:00:40.000Z',
    });

    const items = database.reconcileCrashState('crashed-run', '2025-01-01T00:01:00.000Z');

    expect(items.map((item) => [item.kind, item.resource_id, item.last_state])).toEqual(
      expect.arrayContaining([
        ['process', 'claude-process', 'running'],
        ['permission', 'permission', 'pending'],
        ['mutation', 'mutation', 'started'],
      ]),
    );
    expect(database.listManagedProcesses('crashed-run')).toContainEqual(expect.objectContaining({
      id: 'claude-process', state: 'orphaned_unverified', error_code: 'APP_CRASH',
    }));
    expect(database.listUncleanAppRuns()).toEqual([]);
  });

  it('only marks active processes belonging to the crashed app run', () => {
    for (const appRunId of ['source-run', 'current-run']) {
      database.createAppRun({
        id: appRunId, pid: appRunId === 'source-run' ? 10 : 20, build_id: 'build', status: 'running',
        started_at: '2025-01-01T00:00:00.000Z', heartbeat_at: '2025-01-01T00:00:10.000Z',
        shutdown_started_at: null, clean_shutdown_at: null,
      });
      database.recordManagedProcess({
        id: `process-${appRunId}`, app_run_id: appRunId, kind: 'claude', pid: 100,
        parent_pid: 10, creation_time: null, executable_path: null, launch_nonce: appRunId,
        project_id: PROJECT_ID, session_id: null, task_id: null, run_id: null, state: 'running',
        started_at: '2025-01-01T00:00:20.000Z', stop_requested_at: null, exited_at: null,
        exit_code: null, signal: null, error_code: null,
      });
    }

    const items = database.reconcileCrashState('source-run', '2025-01-01T00:01:00.000Z');

    expect(items.filter((item) => item.kind === 'process').map((item) => item.resource_id))
      .toEqual(['process-source-run']);
    expect(database.listManagedProcesses('source-run')[0].state).toBe('orphaned_unverified');
    expect(database.listManagedProcesses('current-run')[0].state).toBe('running');
  });

  it('deduplicates recovery journals across repeated reconciliation passes', () => {
    createTask('deduplicated', 'running', '2025-01-01T00:00:00.000Z');

    const first = database.reconcileCrashState(null, '2025-01-01T00:01:00.000Z');
    const second = database.reconcileCrashState(null, '2025-01-01T00:02:00.000Z');

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(database.listRecoveryItems()).toHaveLength(1);
    expect(database.getRecoveryItem('recovery:task:deduplicated')?.detected_at)
      .toBe('2025-01-01T00:01:00.000Z');
  });

  it('rolls back every state transition when resource reconciliation fails midway', () => {
    createTask('atomic-task', 'running', '2025-01-01T00:00:00.000Z');
    database.createAppRun({
      id: 'atomic-run', pid: 10, build_id: 'build', status: 'running',
      started_at: '2025-01-01T00:00:00.000Z', heartbeat_at: '2025-01-01T00:00:10.000Z',
      shutdown_started_at: null, clean_shutdown_at: null,
    });
    database.recordManagedProcess({
      id: 'atomic-process', app_run_id: 'atomic-run', kind: 'claude', pid: 100,
      parent_pid: 10, creation_time: null, executable_path: null, launch_nonce: 'atomic',
      project_id: PROJECT_ID, session_id: 'atomic-task', task_id: 'atomic-task', run_id: null,
      state: 'running', started_at: '2025-01-01T00:00:20.000Z', stop_requested_at: null,
      exited_at: null, exit_code: null, signal: null, error_code: null,
    });
    const updateProcess = database.updateManagedProcess.bind(database);
    database.updateManagedProcess = () => { throw new Error('journal unavailable'); };

    expect(() => database.reconcileCrashState('atomic-run', '2025-01-01T00:01:00.000Z'))
      .toThrow('journal unavailable');

    expect(database.getTask('atomic-task')?.status).toBe('running');
    expect(database.getSession('atomic-task')?.status).toBe('running');
    expect(database.listRecoveryItems()).toEqual([]);
    database.updateManagedProcess = updateProcess;
    expect(database.listManagedProcesses('atomic-run')[0].state).toBe('running');
    expect(database.listUncleanAppRuns()[0].status).toBe('running');
  });

  it('interrupts only running workflow steps and preserves terminal step results', () => {
    createTask('steps', 'idle', null);
    createWorkflow('steps', 'completed');
    for (const status of ['running', 'completed', 'failed', 'interrupted']) {
      database.createWorkflowStep({
        id: `step-${status}`, workflow_id: 'workflow-steps', agent_type: 'coder', review_round: 1,
        status: status as never, input: '{}', output: status === 'completed' ? '{}' : null,
        error: status === 'failed' ? 'FAILED' : null, started_at: '2025-01-01T00:00:00.000Z',
        completed_at: status === 'running' ? null : '2025-01-01T00:00:30.000Z',
      });
    }

    database.reconcileCrashState(null, '2025-01-01T00:01:00.000Z');

    expect(database.getWorkflowStep('step-running')).toMatchObject({
      status: 'interrupted', error: 'APP_CRASH', completed_at: '2025-01-01T00:01:00.000Z',
    });
    for (const status of ['completed', 'failed', 'interrupted']) {
      expect(database.getWorkflowStep(`step-${status}`)?.status).toBe(status);
    }
  });

  it('sorts pending recovery work newest first with a deterministic id tie-breaker', () => {
    createTask('older', 'running', '2025-01-01T00:00:00.000Z');
    database.reconcileCrashState(null, '2025-01-01T00:01:00.000Z');
    createTask('alpha', 'running', '2025-01-01T00:01:00.000Z');
    createTask('zulu', 'waiting_permission', '2025-01-01T00:01:00.000Z');

    database.reconcileCrashState(null, '2025-01-01T00:02:00.000Z');

    expect(database.listRecoveryItems().map((item) => item.resource_id))
      .toEqual(['zulu', 'alpha', 'older']);
  });

  it('does not recover already settled permissions or terminal mutations', () => {
    database.recordPendingPermissionRequest({
      id: 'allowed-permission', projectId: PROJECT_ID, runId: 'run', toolName: 'Read',
      requestedAt: '2025-01-01T00:00:00.000Z',
    });
    database.settlePermissionRequest('allowed-permission', 'allowed', '2025-01-01T00:00:10.000Z');
    for (const status of ['completed', 'failed', 'interrupted']) {
      database.recordMutationOperation({
        id: `mutation-${status}`, projectId: PROJECT_ID, projectPath: 'C:\\projects\\recovery',
        kind: 'apply_patch', status, startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:00:10.000Z',
      });
    }

    const items = database.reconcileCrashState(null, '2025-01-01T00:01:00.000Z');

    expect(items.filter((item) => item.kind === 'permission' || item.kind === 'mutation')).toEqual([]);
  });
});
