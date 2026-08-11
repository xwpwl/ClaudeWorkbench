import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../../database/Database';
import { CrashRecoveryManager } from '../CrashRecoveryManager';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-recovery-'));
  roots.push(root);
  const database = new AppDatabase(path.join(root, 'workbench.db'));
  database.createProject('project', 'Project', root);
  database.createSession('task', 'project', 'Task');
  return { root, database };
}

function workflowMetadata(root: string) {
  return JSON.stringify({
    version: 1,
    projectId: 'project',
    projectPath: root,
    projectKey: root,
    sessionKey: `${root}::task`,
    resumeSessionId: null,
    prompt: 'request',
    modelPolicy: {},
    plan: null,
    latestReview: null,
    reviewRound: 1,
    maxReviewRounds: 3,
    fixRound: 1,
    maxFixRounds: 3,
    revision: 1,
    activeStage: 'coder',
    pausedFrom: null,
    failure: null,
    currentModel: null,
    currentPermissionMode: 'default',
    executionCycle: 1,
    reviewAccepted: false,
    pauseReason: null,
  });
}

function createActiveWorkflow(database: AppDatabase, root: string, id = 'workflow') {
  database.updateTask('task', { status: 'running' });
  database.updateSessionMetadata('task', { status: 'running' });
  database.createWorkflow({
    id, task_id: 'task', status: 'executing', current_stage: 'coder',
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    metadata_json: workflowMetadata(root),
  });
}

describe('CrashRecoveryManager', () => {
  it('records a clean first app run without inventing recovery work', async () => {
    const { database } = fixture();
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run-1', pid: 10,
    });
    const report = await manager.beginAppRun();
    expect(report).toMatchObject({ appRunId: 'run-1', abnormalExitDetected: false, items: [] });
    manager.beginShutdown();
    await manager.markCleanShutdown();
    expect(database.listUncleanAppRuns()).toEqual([]);
    database.close();
  });

  it('turns active task, session, workflow and stage into fail-closed interrupted state', async () => {
    const { database, root } = fixture();
    database.updateTask('task', { status: 'running', started_at: '2026-08-01T00:00:00.000Z' });
    database.updateSessionMetadata('task', { status: 'running' });
    database.createWorkflow({
      id: 'workflow', task_id: 'task', status: 'executing', current_stage: 'coder',
      created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
      metadata_json: workflowMetadata(root),
    });
    database.createWorkflowStep({
      id: 'stage', workflow_id: 'workflow', agent_type: 'coder', review_round: 1,
      status: 'running', input: '{}', output: null, error: null,
      started_at: '2026-08-01T00:00:00.000Z', completed_at: null,
    });
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run-1', pid: 10,
      now: () => new Date('2026-08-01T00:01:00.000Z'),
    });
    const report = await manager.beginAppRun();
    expect(report.items.map((item) => item.kind)).toEqual(expect.arrayContaining(['task', 'workflow']));
    expect(database.getTask('task')?.status).toBe('interrupted');
    expect(database.getSession('task')?.status).toBe('interrupted');
    expect(database.getWorkflow('workflow')).toMatchObject({ status: 'paused', current_stage: null });
    expect(JSON.parse(database.getWorkflow('workflow')!.metadata_json)).toMatchObject({
      pausedFrom: 'executing', pauseReason: 'app_crash', activeStage: null,
    });
    expect(database.getWorkflowStep('stage')).toMatchObject({ status: 'interrupted', error: 'APP_CRASH' });
    database.close();
  });

  it('never resumes a workflow without a recovery validator', async () => {
    const { database, root } = fixture();
    database.updateTask('task', { status: 'running' });
    database.createWorkflow({
      id: 'workflow', task_id: 'task', status: 'executing', current_stage: 'coder',
      created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
      metadata_json: workflowMetadata(root),
    });
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run-1', pid: 10,
      resumeWorkflow: vi.fn(),
    });
    const report = await manager.beginAppRun();
    const item = report.items.find((candidate) => candidate.kind === 'workflow')!;
    await expect(manager.resume(item.id)).rejects.toMatchObject({ code: 'VALIDATION_UNAVAILABLE' });
    expect(database.getRecoveryItem(item.id)?.status).toBe('pending');
    database.close();
  });

  it('validates, starts a fresh execution cycle and resumes only after explicit user action', async () => {
    const { database, root } = fixture();
    database.updateTask('task', { status: 'running' });
    database.createWorkflow({
      id: 'workflow', task_id: 'task', status: 'executing', current_stage: 'coder',
      created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
      metadata_json: workflowMetadata(root),
    });
    const validateResume = vi.fn();
    const resumeWorkflow = vi.fn();
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run-1', pid: 10,
      validateResume, resumeWorkflow,
    });
    const item = (await manager.beginAppRun()).items.find((candidate) => candidate.kind === 'workflow')!;
    const resolved = await manager.resume(item.id);
    expect(validateResume).toHaveBeenCalledWith(expect.objectContaining({ id: item.id }));
    expect(resumeWorkflow).toHaveBeenCalledWith('workflow');
    expect(resolved.status).toBe('resumed');
    expect(JSON.parse(database.getWorkflow('workflow')!.metadata_json)).toMatchObject({ executionCycle: 2 });
    database.close();
  });

  it('does not resolve recovery when explicit resume fails', async () => {
    const { database, root } = fixture();
    database.updateTask('task', { status: 'running' });
    database.createWorkflow({
      id: 'workflow', task_id: 'task', status: 'executing', current_stage: 'coder',
      created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
      metadata_json: workflowMetadata(root),
    });
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run-1', pid: 10,
      validateResume: vi.fn(),
      resumeWorkflow: vi.fn().mockRejectedValue(new Error('runner failed')),
    });
    const item = (await manager.beginAppRun()).items.find((candidate) => candidate.kind === 'workflow')!;
    await expect(manager.resume(item.id)).rejects.toThrow('runner failed');
    expect(database.getRecoveryItem(item.id)?.status).toBe('pending');
    database.close();
  });

  it('abandons without touching project files and is idempotently terminal', async () => {
    const { database, root } = fixture();
    const sentinel = path.join(root, 'sentinel.ts');
    fs.writeFileSync(sentinel, 'unchanged');
    database.updateTask('task', { status: 'running' });
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run-1', pid: 10,
    });
    const item = (await manager.beginAppRun()).items.find((candidate) => candidate.kind === 'task')!;
    expect((await manager.abandon(item.id)).status).toBe('abandoned');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
    await expect(manager.abandon(item.id)).rejects.toMatchObject({ code: 'NOT_PENDING' });
    database.close();
  });

  it('starts at most one app-run journal when beginAppRun is called repeatedly', async () => {
    const { database } = fixture();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run-once', pid: 42, logger,
    });

    const first = await manager.beginAppRun();
    const second = await manager.beginAppRun();

    expect(second).toEqual({ ...first, abnormalExitDetected: false, previousRunIds: [] });
    expect(database.listUncleanAppRuns()).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    database.close();
  });

  it('reports every previous unclean run in stable start order and marks each crashed', async () => {
    const { database } = fixture();
    database.createAppRun({
      id: 'older', pid: 1, build_id: 'old', started_at: '2026-07-31T23:00:00.000Z',
      heartbeat_at: '2026-07-31T23:01:00.000Z', shutdown_started_at: null,
      clean_shutdown_at: null, status: 'running',
    });
    database.createAppRun({
      id: 'newer', pid: 2, build_id: 'old', started_at: '2026-07-31T23:30:00.000Z',
      heartbeat_at: '2026-07-31T23:31:00.000Z', shutdown_started_at: '2026-07-31T23:32:00.000Z',
      clean_shutdown_at: null, status: 'shutting_down',
    });
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'current', pid: 3,
      now: () => new Date('2026-08-01T00:00:00.000Z'),
    });

    const report = await manager.beginAppRun();

    expect(report).toMatchObject({
      appRunId: 'current', abnormalExitDetected: true, previousRunIds: ['older', 'newer'],
    });
    expect(database.listUncleanAppRuns().map((run) => run.id)).toEqual(['current']);
    database.close();
  });

  it('persists heartbeat, shutdown, and clean timestamps without acting before beginAppRun', async () => {
    const { database } = fixture();
    const timestamps = [
      '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:10.000Z',
      '2026-08-01T00:00:20.000Z',
      '2026-08-01T00:00:30.000Z',
    ];
    let index = 0;
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run', pid: 10,
      now: () => new Date(timestamps[index++] ?? timestamps.at(-1)!),
    });

    manager.heartbeat();
    manager.beginShutdown();
    await manager.markCleanShutdown();
    expect(database.listUncleanAppRuns()).toEqual([]);

    await manager.beginAppRun();
    manager.heartbeat();
    expect(database.listUncleanAppRuns()[0]).toMatchObject({
      id: 'run', status: 'running', heartbeat_at: timestamps[1],
    });
    manager.beginShutdown();
    expect(database.listUncleanAppRuns()[0]).toMatchObject({
      status: 'shutting_down', shutdown_started_at: timestamps[2], heartbeat_at: timestamps[2],
    });
    await manager.markCleanShutdown();
    expect(database.listUncleanAppRuns()).toEqual([]);
    database.close();
  });

  it('resumes a plain task by making its existing task and session idle without replaying a workflow', async () => {
    const { database } = fixture();
    database.updateTask('task', { status: 'running', started_at: '2026-08-01T00:00:00.000Z' });
    database.updateSessionMetadata('task', { status: 'running' });
    const resumeWorkflow = vi.fn();
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run', pid: 10, resumeWorkflow,
    });
    const item = (await manager.beginAppRun()).items.find((candidate) => candidate.kind === 'task')!;

    const resolved = await manager.resume(item.id);

    expect(resolved.status).toBe('resumed');
    expect(database.getTask('task')).toMatchObject({ status: 'idle', completed_at: null });
    expect(database.getSession('task')).toMatchObject({ status: 'idle', completed_at: null });
    expect(resumeWorkflow).not.toHaveBeenCalled();
    database.close();
  });

  it('requires validation before resolving an interrupted mutation and never invokes workflow execution', async () => {
    const { database, root } = fixture();
    database.recordMutationOperation({
      id: 'mutation', projectId: 'project', projectPath: root, sessionId: 'task', taskId: 'task',
      kind: 'apply_patch', status: 'running', filePaths: ['sentinel.ts'],
      startedAt: '2026-08-01T00:00:00.000Z',
    });
    const validateResume = vi.fn();
    const resumeWorkflow = vi.fn();
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run', pid: 10, validateResume, resumeWorkflow,
    });
    const item = (await manager.beginAppRun()).items.find((candidate) => candidate.kind === 'mutation')!;

    expect((await manager.resume(item.id)).status).toBe('resumed');
    expect(validateResume).toHaveBeenCalledOnce();
    expect(validateResume).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mutation', resource_id: 'mutation', last_state: 'running',
    }));
    expect(resumeWorkflow).not.toHaveBeenCalled();
    database.close();
  });

  it('fails closed when mutation validation rejects and leaves the item pending', async () => {
    const { database, root } = fixture();
    database.recordMutationOperation({
      id: 'mutation', projectId: 'project', projectPath: root,
      kind: 'checkpoint_restore', status: 'started', filePaths: ['sentinel.ts'],
      startedAt: '2026-08-01T00:00:00.000Z',
    });
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run', pid: 10,
      validateResume: vi.fn().mockRejectedValue(new Error('fingerprint changed')),
    });
    const item = (await manager.beginAppRun()).items.find((candidate) => candidate.kind === 'mutation')!;

    await expect(manager.resume(item.id)).rejects.toThrow('fingerprint changed');
    expect(database.getRecoveryItem(item.id)).toMatchObject({ status: 'pending', resolved_at: null });
    database.close();
  });

  it('keeps a workflow pending when no workflow resumer is available', async () => {
    const { database, root } = fixture();
    createActiveWorkflow(database, root);
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run', pid: 10, validateResume: vi.fn(),
    });
    const item = (await manager.beginAppRun()).items.find((candidate) => candidate.kind === 'workflow')!;

    await expect(manager.resume(item.id)).rejects.toMatchObject({ code: 'RESUME_UNAVAILABLE' });
    expect(database.getRecoveryItem(item.id)?.status).toBe('pending');
    database.close();
  });

  it('does not call the workflow runner when persisted recovery preparation fails', async () => {
    const { database, root } = fixture();
    createActiveWorkflow(database, root);
    const resumeWorkflow = vi.fn();
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run', pid: 10,
      validateResume: vi.fn(), resumeWorkflow,
    });
    const item = (await manager.beginAppRun()).items.find((candidate) => candidate.kind === 'workflow')!;
    const workflow = database.getWorkflow('workflow')!;
    database.saveWorkflow({ ...workflow, status: 'completed', current_stage: null });

    await expect(manager.resume(item.id)).rejects.toMatchObject({ code: 'PREPARATION_FAILED' });
    expect(resumeWorkflow).not.toHaveBeenCalled();
    expect(database.getRecoveryItem(item.id)?.status).toBe('pending');
    database.close();
  });

  it('rejects unknown recovery ids without running validation or recovery callbacks', async () => {
    const { database } = fixture();
    const validateResume = vi.fn();
    const resumeWorkflow = vi.fn();
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run', pid: 10, validateResume, resumeWorkflow,
    });
    await manager.beginAppRun();

    await expect(manager.resume('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(validateResume).not.toHaveBeenCalled();
    expect(resumeWorkflow).not.toHaveBeenCalled();
    database.close();
  });

  it('resolves every recovery item for one task together when the task is abandoned', async () => {
    const { database, root } = fixture();
    createActiveWorkflow(database, root);
    database.recordPendingPermissionRequest({
      id: 'permission', projectId: 'project', sessionId: 'task', taskId: 'task',
      runId: 'claude-run', toolName: 'Write', requestedAt: '2026-08-01T00:00:00.000Z',
    });
    const manager = new CrashRecoveryManager(database, {
      buildId: 'build', randomUUID: () => 'run', pid: 10,
      now: () => new Date('2026-08-01T00:01:00.000Z'),
    });
    const items = (await manager.beginAppRun()).items.filter((item) => item.task_id === 'task');
    const taskItem = items.find((item) => item.kind === 'task')!;

    await manager.abandon(taskItem.id);

    expect(items).toHaveLength(3);
    expect(items.map((item) => database.getRecoveryItem(item.id)?.status)).toEqual([
      'abandoned', 'abandoned', 'abandoned',
    ]);
    expect(database.getTask('task')?.status).toBe('cancelled');
    expect(database.getSession('task')?.status).toBe('cancelled');
    expect(database.getWorkflow('workflow')?.status).toBe('cancelled');
    database.close();
  });
});
