import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydratePersistedTasks } from '../../../shared/taskPersistence';
import { selectTimelinePresentations } from '../../../shared/taskState';
import type { Checkpoint, CheckpointType } from '../../../shared/types/checkpoint';
import type { CommitPreview, GitStatus } from '../../../shared/types/git';
import type { ReviewReport, Workflow } from '../../../shared/types/workflow';
import { CheckpointManager } from '../../checkpoints/CheckpointManager';
import { AppDatabase, type WorkflowRow } from '../../database/Database';
import { GitWorkspaceError, GitWorkspaceService } from '../../git/GitWorkspaceService';
import { TaskQueryService } from '../../tasks/TaskQueryService';
import { AgentWorkflowManager } from '../AgentWorkflowManager';
import type { PersistedWorkflowSnapshot, WorkflowEvent } from '../contracts';
import { MemoryWorkflowPersistence, modelSelectionPolicy, ScriptedRunner } from './helpers';
import {
  AppDatabaseWorkflowPersistence,
  buildWorkflowCommitPreviewBody,
  CheckpointWorkflowGateway,
  DatabaseWorkflowEventGateway,
  GitWorkspaceWorkflowGateway,
  WorkflowInfrastructure,
  WorkflowInfrastructureError,
  type WorkflowNotification,
  workflowInfrastructureInternals,
} from '../WorkflowInfrastructure';

const TEMP_PREFIX = 'claude-workbench-workflow-infrastructure-test-';
const PROJECT_ID = 'project-1';
const PROJECT_PATH = 'C:\projects\workflow-infrastructure';
const TASK_ID = 'task-1';
const WORKFLOW_ID = 'workflow-1';
const CREATED_AT = '2026-08-01T00:00:00.000Z';

function removeTestDirectory(directory: string): void {
  const target = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function executionPlan() {
  return {
    title: 'Implement workflow infrastructure',
    summary: 'Connect durable workflow services without committing changes.',
    steps: [{ id: 1, title: 'Add adapters', risk: 'medium' as const }],
    filesExpected: ['src/main/workflows/WorkflowInfrastructure.ts'],
    estimatedChanges: 'One adapter module and tests',
    riskLevel: 'medium' as const,
  };
}

function reviewReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    round: 1,
    score: 8.5,
    summary: 'The structured implementation is safe to integrate.',
    issues: [{
      id: 'model-generated-id-must-not-be-used',
      severity: 'medium',
      file: 'src/main/workflows/WorkflowInfrastructure.ts',
      line: 42,
      title: 'Add one more boundary test',
      recommendation: 'Exercise idempotent checkpoint recovery.',
      resolved: false,
    }],
    tests: { passed: 20, failed: 0, skipped: 1 },
    ...overrides,
  };
}

function snapshot(overrides: Partial<PersistedWorkflowSnapshot> = {}): PersistedWorkflowSnapshot {
  return {
    id: WORKFLOW_ID,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    projectPath: PROJECT_PATH,
    projectKey: PROJECT_PATH,
    sessionKey: `${PROJECT_PATH}::${TASK_ID}`,
    resumeSessionId: null,
    modelSelectionPolicy: null,
    prompt: 'Wire the workflow adapters without exposing raw output.',
    status: 'idle',
    currentStage: null,
    activeStage: null,
    modelPolicy: { plannerModel: 'planner-model' },
    plan: null,
    latestReview: null,
    reviewRound: 0,
    maxReviewRounds: 3,
    fixRound: 0,
    maxFixRounds: 3,
    revision: 0,
    pausedFrom: null,
    failure: null,
    currentModel: 'current-model',
    currentPermissionMode: 'default',
    executionCycle: 0,
    reviewAccepted: false,
    pauseReason: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function gitStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    projectPath: PROJECT_PATH,
    branch: 'main',
    detached: false,
    head: 'abc123',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    clean: false,
    files: [{
      filePath: 'src/App.tsx',
      changeType: 'modified',
      statusCode: ' M',
      staged: false,
      unstaged: true,
      untracked: false,
      additions: 4,
      deletions: 1,
      statsAvailable: true,
      isBinary: false,
    }],
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    additions: 4,
    deletions: 1,
    ...overrides,
  };
}

function commitPreview(): CommitPreview {
  return {
    type: 'feat',
    scope: 'workflow',
    description: 'add workflow infrastructure',
    subject: 'feat(workflow): add workflow infrastructure',
    message: 'feat(workflow): add workflow infrastructure',
    files: ['src/main/workflows/WorkflowInfrastructure.ts'],
    fileCount: 1,
    additions: 100,
    deletions: 0,
  };
}

class CheckpointStoreStub {
  checkpoints: Checkpoint[] = [];
  createCalls: Array<{ taskId: string; type: CheckpointType; context: Record<string, unknown> }> = [];
  operationCalls: string[] = [];
  previewCalls: string[] = [];
  commitCalls = 0;

  listCheckpoints(taskId: string): Checkpoint[] {
    return this.checkpoints.filter((checkpoint) => checkpoint.taskId === taskId);
  }

  async beginWorkflow(taskId: string, workflowId: string): Promise<Checkpoint> {
    this.operationCalls.push('begin:before_task');
    const existing = this.checkpoints.find((checkpoint) => (
      checkpoint.taskId === taskId
      && checkpoint.type === 'before_task'
      && checkpoint.metadata.runId === workflowId
    ));
    if (existing) return existing;
    const checkpoint: Checkpoint = {
      id: `checkpoint-${this.checkpoints.length + 1}`,
      taskId,
      projectPath: PROJECT_PATH,
      type: 'before_task',
      createdAt: CREATED_AT,
      gitCommit: 'abc123',
      metadata: {
        runId: workflowId,
        branch: 'main',
        baselineFiles: [],
        touchedFiles: [],
        reason: 'workflow_baseline',
      },
      files: [],
    };
    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  async createTaskCheckpoint(
    taskId: string,
    type: CheckpointType,
    context: { runId?: string; reason?: string } = {},
  ): Promise<Checkpoint> {
    this.operationCalls.push(`create:${type}`);
    this.createCalls.push({ taskId, type, context: { ...context } });
    const checkpoint: Checkpoint = {
      id: `checkpoint-${this.checkpoints.length + 1}`,
      taskId,
      projectPath: PROJECT_PATH,
      type,
      createdAt: CREATED_AT,
      gitCommit: 'abc123',
      metadata: {
        runId: context.runId,
        branch: 'main',
        baselineFiles: [],
        touchedFiles: [],
        reason: context.reason,
      },
      files: [],
    };
    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  async createCommitPreview(taskId: string): Promise<CommitPreview> {
    this.previewCalls.push(taskId);
    return commitPreview();
  }

  async commitTaskChanges(): Promise<void> {
    this.commitCalls += 1;
  }
}

function workflowEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    idempotencyKey: `${WORKFLOW_ID}:status:1`,
    workflowId: WORKFLOW_ID,
    taskId: TASK_ID,
    type: 'workflow_status_changed',
    status: 'planning',
    stage: 'planner',
    round: 0,
    timestamp: '2026-08-01T00:01:00.000Z',
    payload: { rawAssistant: 'DO NOT PERSIST', systemPrompt: 'SECRET SYSTEM CONTENT' },
    ...overrides,
  };
}

describe('WorkflowInfrastructure adapters', () => {
  let directory: string;
  let databasePath: string;
  let database: AppDatabase;
  let persistence: AppDatabaseWorkflowPersistence;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    databasePath = path.join(directory, 'workbench.sqlite');
    database = new AppDatabase(databasePath);
    database.createProject(PROJECT_ID, 'Workflow project', PROJECT_PATH);
    database.createSession(TASK_ID, PROJECT_ID, 'Workflow task', 'current-model', 'default');
    persistence = new AppDatabaseWorkflowPersistence(database);
  });

  afterEach(() => {
    database.close();
    removeTestDirectory(directory);
  });

  describe('AppDatabaseWorkflowPersistence', () => {
    it('round-trips every private workflow metadata field', () => {
      const selections = modelSelectionPolicy();
      const created = snapshot({
        status: 'paused',
        pausedFrom: 'executing',
        pauseReason: 'user_requested',
        executionCycle: 2,
        reviewAccepted: true,
        currentPermissionMode: 'acceptEdits',
        plan: executionPlan(),
        modelSelectionPolicy: {
          ...selections,
          planner: {
            ...selections.planner,
            source: 'project_policy',
            executionSource: 'environment',
            tier: 'high_quality',
            tierSource: 'project',
          },
        },
      });
      persistence.createWorkflow(created);
      expect(persistence.getWorkflow(WORKFLOW_ID)).toEqual(created);
    });

    it('loads legacy workflow metadata without a Provider selection snapshot', () => {
      const row = workflowInfrastructureInternals.workflowRow(snapshot());
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      delete metadata.modelSelectionPolicy;
      database.createWorkflow({ ...row, metadata_json: JSON.stringify(metadata) });

      expect(persistence.getWorkflow(WORKFLOW_ID)?.modelSelectionPolicy).toBeNull();
    });

    it('rejects a corrupt persisted Provider capability snapshot', () => {
      const row = workflowInfrastructureInternals.workflowRow(snapshot({
        modelSelectionPolicy: modelSelectionPolicy(),
      }));
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const policy = metadata.modelSelectionPolicy as Record<string, Record<string, unknown>>;
      const planner = policy.planner;
      (planner.capabilities as Record<string, unknown>).supportsClaudeCode = 'yes';
      database.createWorkflow({ ...row, metadata_json: JSON.stringify(metadata) });

      expect(() => persistence.getWorkflow(WORKFLOW_ID)).toThrowError(
        expect.objectContaining({ code: 'CORRUPT_DATA' }),
      );
    });

    it.each([
      ['missing executionSource', (planner: Record<string, unknown>) => { delete planner.executionSource; }],
      ['unknown future selection field', (planner: Record<string, unknown>) => { planner.futureIdentity = 'unsafe'; }],
      ['tier without tierSource', (planner: Record<string, unknown>) => {
        planner.tier = 'fast';
        delete planner.tierSource;
      }],
    ])('fails closed for %s in a persisted model snapshot', (_label, corrupt) => {
      const row = workflowInfrastructureInternals.workflowRow(snapshot({
        modelSelectionPolicy: modelSelectionPolicy(),
      }));
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const policy = metadata.modelSelectionPolicy as Record<string, Record<string, unknown>>;
      corrupt(policy.planner);
      database.createWorkflow({ ...row, metadata_json: JSON.stringify(metadata) });

      expect(() => persistence.getWorkflow(WORKFLOW_ID)).toThrowError(
        expect.objectContaining({ code: 'CORRUPT_DATA' }),
      );
    });

    it('fails closed for a future workflow metadata version', () => {
      const row = workflowInfrastructureInternals.workflowRow(snapshot({
        modelSelectionPolicy: modelSelectionPolicy(),
      }));
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      metadata.version = 2;
      database.createWorkflow({ ...row, metadata_json: JSON.stringify(metadata) });

      expect(() => persistence.getWorkflow(WORKFLOW_ID)).toThrowError(
        expect.objectContaining({ code: 'CORRUPT_DATA' }),
      );
    });

    it('allowlists metadata instead of persisting unknown raw transport fields', () => {
      const contaminated = {
        ...snapshot(),
        rawAssistant: 'secret assistant transcript',
        systemPrompt: 'secret system prompt',
      } as PersistedWorkflowSnapshot;
      persistence.createWorkflow(contaminated);
      const row = database.getWorkflow(WORKFLOW_ID) as WorkflowRow;
      expect(row.metadata_json).not.toContain('secret assistant transcript');
      expect(row.metadata_json).not.toContain('secret system prompt');
      expect(persistence.getWorkflow(WORKFLOW_ID)).not.toHaveProperty('rawAssistant');
    });

    it('returns a renderer-safe public DTO without execution-only metadata', () => {
      persistence.createWorkflow(snapshot());
      const workflow = persistence.getPublic(WORKFLOW_ID);
      expect(workflow).toMatchObject({ id: WORKFLOW_ID, taskId: TASK_ID, status: 'idle' });
      expect(workflow).not.toHaveProperty('currentPermissionMode');
      expect(workflow).not.toHaveProperty('currentModel');
      expect(workflow).not.toHaveProperty('sessionKey');
      expect(workflow).not.toHaveProperty('activeStage');
      expect(workflow).not.toHaveProperty('modelSelectionPolicy');
    });

    it('fails closed to plan mode when persisted permission metadata is absent', () => {
      const row = workflowInfrastructureInternals.workflowRow(snapshot());
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      delete metadata.currentPermissionMode;
      database.createWorkflow({ ...row, metadata_json: JSON.stringify(metadata) });
      expect(persistence.getWorkflow(WORKFLOW_ID)?.currentPermissionMode).toBe('plan');
    });

    it('rejects corrupt structured plan metadata', () => {
      const row = workflowInfrastructureInternals.workflowRow(snapshot());
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      metadata.plan = { summary: 'raw but incomplete' };
      database.createWorkflow({ ...row, metadata_json: JSON.stringify(metadata) });
      expect(() => persistence.getWorkflow(WORKFLOW_ID)).toThrowError(
        expect.objectContaining({ code: 'CORRUPT_DATA' }),
      );
    });

    it('saves a workflow with timestamp and revision CAS', () => {
      persistence.createWorkflow(snapshot());
      const next = snapshot({
        status: 'planning',
        currentStage: 'planner',
        activeStage: 'planner',
        revision: 1,
        updatedAt: '2026-08-01T00:01:00.000Z',
      });
      persistence.saveWorkflow(next, { expectedRevision: 0, expectedUpdatedAt: CREATED_AT });
      expect(persistence.getWorkflow(WORKFLOW_ID)).toEqual(next);
    });

    it('persists the previous review while its requested fix round is executing', () => {
      const previousReview = reviewReport({ round: 1 });
      const fixing = snapshot({
        status: 'executing',
        currentStage: 'coder',
        activeStage: 'coder',
        latestReview: previousReview,
        reviewRound: 2,
        fixRound: 2,
      });
      persistence.createWorkflow(fixing);
      expect(persistence.getWorkflow(WORKFLOW_ID)).toEqual(fixing);
    });

    it('rejects a review older than the immediately previous fix round', () => {
      expect(() => persistence.createWorkflow(snapshot({
        status: 'executing',
        currentStage: 'coder',
        activeStage: 'coder',
        latestReview: reviewReport({ round: 1 }),
        reviewRound: 3,
        fixRound: 3,
      }))).toThrowError(expect.objectContaining({ code: 'CORRUPT_DATA' }));
    });

    it('raises CAS_CONFLICT for a stale timestamp', () => {
      persistence.createWorkflow(snapshot());
      const winner = snapshot({ revision: 1, updatedAt: '2026-08-01T00:01:00.000Z' });
      persistence.saveWorkflow(winner, { expectedRevision: 0, expectedUpdatedAt: CREATED_AT });
      expect(() => persistence.saveWorkflow(
        snapshot({ revision: 2, updatedAt: '2026-08-01T00:02:00.000Z' }),
        { expectedRevision: 0, expectedUpdatedAt: CREATED_AT },
      )).toThrowError(expect.objectContaining({ code: 'CAS_CONFLICT' }));
    });

    it('raises CAS_CONFLICT when the timestamp matches but revision changed', () => {
      const original = snapshot();
      persistence.createWorkflow(original);
      const raw = database.getWorkflow(WORKFLOW_ID) as WorkflowRow;
      const metadata = JSON.parse(raw.metadata_json) as Record<string, unknown>;
      metadata.revision = 2;
      expect(database.saveWorkflow(
        { ...raw, metadata_json: JSON.stringify(metadata) },
        { expectedRevision: 0, expectedUpdatedAt: CREATED_AT },
      )).toBe(true);
      expect(() => persistence.saveWorkflow(
        snapshot({ revision: 1, updatedAt: '2026-08-01T00:01:00.000Z' }),
        { expectedRevision: 0, expectedUpdatedAt: CREATED_AT },
      )).toThrowError(expect.objectContaining({ code: 'CAS_CONFLICT' }));
    });

    it('gets a persisted workflow by its unique task id', () => {
      persistence.createWorkflow(snapshot());
      expect(persistence.getByTask(TASK_ID)?.id).toBe(WORKFLOW_ID);
      expect(persistence.getByTask('missing')).toBeNull();
    });

    it('filters projects in SQL before applying pagination and count', () => {
      database.createProject('project-2', 'Other project', 'C:\projects\other');
      for (let index = 0; index < 105; index += 1) {
        const taskId = `other-task-${index}`;
        database.createSession(taskId, 'project-2', `Other ${index}`);
        persistence.createWorkflow(snapshot({
          id: `other-workflow-${index}`,
          taskId,
          projectId: 'project-2',
          projectPath: 'C:\projects\other',
          projectKey: 'C:\projects\other',
          sessionKey: `C:\projects\other::${taskId}`,
          updatedAt: new Date(Date.UTC(2027, 0, 1, 0, 0, index)).toISOString(),
        }));
      }
      persistence.createWorkflow(snapshot());
      const page = persistence.listPage({ projectId: PROJECT_ID, limit: 50, offset: 0 });
      expect(page.total).toBe(1);
      expect(page.items.map((item) => item.id)).toEqual([WORKFLOW_ID]);
    });

    it('supports task and status filters with normalized page bounds', () => {
      persistence.createWorkflow(snapshot({ status: 'paused' }));
      expect(persistence.listPage({
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        status: 'paused',
        limit: 999,
        offset: -1,
      })).toMatchObject({ total: 1, limit: 100, offset: 0 });
      expect(persistence.listPage({ taskId: TASK_ID, status: 'completed' }).total).toBe(0);
    });

    it('returns full public workflow fields in list pages while hiding private metadata', () => {
      persistence.createWorkflow(snapshot({ plan: executionPlan() }));
      const item = persistence.listPage({ projectId: PROJECT_ID }).items[0];
      expect(item?.plan).toEqual(executionPlan());
      expect(item?.latestReview).toBeNull();
      expect(item).not.toHaveProperty('currentPermissionMode');
      expect(item).not.toHaveProperty('sessionKey');
    });

    it('upserts and reloads direct round/error stage columns', () => {
      persistence.createWorkflow(snapshot());
      persistence.upsertStageRecord({
        id: `${WORKFLOW_ID}:0:planner:0`,
        workflowId: WORKFLOW_ID,
        stage: 'planner',
        round: 0,
        status: 'failed',
        inputJson: '{"kind":"planner"}',
        outputJson: null,
        error: 'INVALID_STRUCTURED_OUTPUT',
        startedAt: CREATED_AT,
        completedAt: '2026-08-01T00:01:00.000Z',
      });
      expect(persistence.listStageRecords(WORKFLOW_ID)[0]).toMatchObject({
        round: 0,
        error: 'INVALID_STRUCTURED_OUTPUT',
      });
    });

    it('rejects raw scalar stage transcript payloads before persistence', () => {
      persistence.createWorkflow(snapshot());
      expect(() => persistence.upsertStageRecord({
        id: 'raw-stage',
        workflowId: WORKFLOW_ID,
        stage: 'planner',
        round: 0,
        status: 'running',
        inputJson: '"raw user transcript"',
        outputJson: null,
        error: null,
        startedAt: CREATED_AT,
        completedAt: null,
      })).toThrowError(expect.objectContaining({ code: 'CORRUPT_DATA' }));
    });

    it('returns all stage records while keeping stage pages capped at 100', () => {
      persistence.createWorkflow(snapshot());
      for (let index = 0; index < 105; index += 1) {
        persistence.upsertStageRecord({
          id: `${WORKFLOW_ID}:planner:${index}`,
          workflowId: WORKFLOW_ID,
          stage: 'planner',
          round: 0,
          status: 'completed',
          inputJson: `{"index":${index}}`,
          outputJson: '{}',
          error: null,
          startedAt: new Date(Date.UTC(2027, 0, 1, 0, 0, index)).toISOString(),
          completedAt: new Date(Date.UTC(2027, 0, 1, 0, 1, index)).toISOString(),
        });
      }
      expect(persistence.listStageRecords(WORKFLOW_ID)).toHaveLength(105);
      expect(persistence.listStagePage(WORKFLOW_ID, { limit: 999 })).toMatchObject({
        total: 105,
        limit: 100,
      });
    });

    it('groups renderer-safe permission decisions by exact stage run prefix', () => {
      persistence.createWorkflow(snapshot());
      const plannerId = `${WORKFLOW_ID}:0:planner:0`;
      const coderId = `${WORKFLOW_ID}:0:coder:1`;
      for (const [id, stage, startedAt] of [
        [plannerId, 'planner', CREATED_AT],
        [coderId, 'coder', '2026-08-01T00:02:00.000Z'],
      ] as const) {
        persistence.upsertStageRecord({
          id,
          workflowId: WORKFLOW_ID,
          stage,
          round: stage === 'planner' ? 0 : 1,
          status: 'completed',
          inputJson: '{"raw":"stage input must not leak through permissions"}',
          outputJson: '{}',
          error: null,
          startedAt,
          completedAt: startedAt,
        });
      }
      database.createPermission({
        id: 'permission-planner-read',
        session_id: TASK_ID,
        run_id: `${plannerId}:run-uuid-1`,
        tool_name: 'Read',
        decision: 'allow_once',
        created_at: '2026-08-01T00:00:10.000Z',
        resolved_at: '2026-08-01T00:00:11.000Z',
      });
      database.createPermission({
        id: 'permission-planner-bash',
        session_id: TASK_ID,
        run_id: `${plannerId}:run-uuid-2`,
        tool_name: 'Bash',
        decision: 'deny',
        created_at: '2026-08-01T00:00:20.000Z',
        resolved_at: '2026-08-01T00:00:21.000Z',
      });
      database.createPermission({
        id: 'permission-coder-write',
        session_id: TASK_ID,
        run_id: `${coderId}:run-uuid-3`,
        tool_name: 'Write',
        decision: 'allow_for_session',
        created_at: '2026-08-01T00:02:10.000Z',
        resolved_at: '2026-08-01T00:02:11.000Z',
      });
      const listPermissions = vi.spyOn(database, 'listPermissions');
      const records = persistence.listStageRecords(WORKFLOW_ID);
      expect(listPermissions).toHaveBeenCalledTimes(1);
      expect(records.find((record) => record.id === plannerId)?.permissions).toEqual([
        { toolName: 'Read', decision: 'allow_once', createdAt: '2026-08-01T00:00:10.000Z' },
        { toolName: 'Bash', decision: 'deny', createdAt: '2026-08-01T00:00:20.000Z' },
      ]);
      expect(records.find((record) => record.id === coderId)?.permissions).toEqual([
        { toolName: 'Write', decision: 'allow_for_session', createdAt: '2026-08-01T00:02:10.000Z' },
      ]);
      const permissionsJson = JSON.stringify(records.map((record) => record.permissions));
      expect(permissionsJson).not.toContain('run-uuid');
      expect(permissionsJson).not.toContain('resolved_at');
      expect(permissionsJson).not.toContain('permission-planner');
      expect(permissionsJson).not.toContain('stage input');
    });

    it('loads task permissions once for a stage page and excludes similar non-prefix runs', () => {
      persistence.createWorkflow(snapshot());
      const stageId = `${WORKFLOW_ID}:0:coder:1`;
      persistence.upsertStageRecord({
        id: stageId,
        workflowId: WORKFLOW_ID,
        stage: 'coder',
        round: 1,
        status: 'running',
        inputJson: '{}',
        outputJson: null,
        error: null,
        startedAt: CREATED_AT,
        completedAt: null,
      });
      database.createPermission({
        id: 'permission-exact-prefix',
        session_id: TASK_ID,
        run_id: `${stageId}:actual-run`,
        tool_name: 'Edit',
        decision: 'allow_once',
        created_at: '2026-08-01T00:00:10.000Z',
        resolved_at: '2026-08-01T00:00:11.000Z',
      });
      database.createPermission({
        id: 'permission-similar-prefix',
        session_id: TASK_ID,
        run_id: `${stageId}-other:actual-run`,
        tool_name: 'Bash',
        decision: 'deny',
        created_at: '2026-08-01T00:00:20.000Z',
        resolved_at: '2026-08-01T00:00:21.000Z',
      });
      const listPermissions = vi.spyOn(database, 'listPermissions');
      const page = persistence.listStagePage(WORKFLOW_ID, { limit: 50, offset: 0 });
      expect(listPermissions).toHaveBeenCalledOnce();
      expect(page.items[0]?.permissions).toEqual([
        { toolName: 'Edit', decision: 'allow_once', createdAt: '2026-08-01T00:00:10.000Z' },
      ]);
    });

    it('does not query task permissions for an unknown workflow page', () => {
      const listPermissions = vi.spyOn(database, 'listPermissions');
      expect(persistence.listStagePage('missing-workflow')).toMatchObject({ items: [], total: 0 });
      expect(listPermissions).not.toHaveBeenCalled();
    });

    it('atomically persists the reviewed snapshot, report, and deterministic issues', () => {
      persistence.createWorkflow(snapshot());
      persistence.upsertStageRecord({
        id: `${WORKFLOW_ID}:0:reviewer:1`,
        workflowId: WORKFLOW_ID,
        stage: 'reviewer',
        round: 1,
        status: 'completed',
        inputJson: '{}',
        outputJson: '{"score":8.5}',
        error: null,
        startedAt: CREATED_AT,
        completedAt: '2026-08-01T00:01:00.000Z',
      });
      const report = reviewReport();
      const reviewed = snapshot({
        status: 'reviewing',
        currentStage: 'reviewer',
        activeStage: 'reviewer',
        latestReview: report,
        reviewRound: 1,
        revision: 1,
        updatedAt: '2026-08-01T00:02:00.000Z',
      });
      persistence.saveWorkflowWithReview(
        reviewed,
        report,
        { expectedRevision: 0, expectedUpdatedAt: CREATED_AT },
      );
      expect(database.getReview(`review:${WORKFLOW_ID}:1`)).toMatchObject({
        workflow_id: WORKFLOW_ID,
        review_round: 1,
        step_id: `${WORKFLOW_ID}:0:reviewer:1`,
      });
      expect(database.getReviewIssue(`review:${WORKFLOW_ID}:1:issue:0`)).toMatchObject({
        title: report.issues[0].title,
      });
      expect(database.getReviewIssue('model-generated-id-must-not-be-used')).toBeNull();
      expect(persistence.getWorkflow(WORKFLOW_ID)?.latestReview).toEqual(report);
    });

    it('rolls back a review snapshot when issue persistence fails', () => {
      persistence.createWorkflow(snapshot());
      persistence.upsertStageRecord({
        id: `${WORKFLOW_ID}:0:reviewer:1`,
        workflowId: WORKFLOW_ID,
        stage: 'reviewer',
        round: 1,
        status: 'completed',
        inputJson: '{}',
        outputJson: '{}',
        error: null,
        startedAt: CREATED_AT,
        completedAt: CREATED_AT,
      });
      const invalid = reviewReport({
        issues: [{
          severity: 'blocker' as never,
          file: null,
          line: null,
          title: 'Invalid severity',
          recommendation: 'Reject it',
        }],
      });
      const next = snapshot({
        latestReview: invalid,
        reviewRound: 1,
        revision: 1,
        updatedAt: '2026-08-01T00:02:00.000Z',
      });
      expect(() => persistence.saveWorkflowWithReview(
        next,
        invalid,
        { expectedRevision: 0, expectedUpdatedAt: CREATED_AT },
      )).toThrow();
      expect(persistence.getWorkflow(WORKFLOW_ID)).toEqual(snapshot());
      expect(database.countReviews(WORKFLOW_ID)).toBe(0);
    });

    it('raises CAS_CONFLICT before inserting a stale review graph', () => {
      persistence.createWorkflow(snapshot());
      const winner = snapshot({ revision: 1, updatedAt: '2026-08-01T00:01:00.000Z' });
      persistence.saveWorkflow(winner, { expectedRevision: 0, expectedUpdatedAt: CREATED_AT });
      const staleReport = reviewReport();
      expect(() => persistence.saveWorkflowWithReview(
        snapshot({
          latestReview: staleReport,
          reviewRound: 1,
          revision: 1,
          updatedAt: '2026-08-01T00:02:00.000Z',
        }),
        staleReport,
        { expectedRevision: 0, expectedUpdatedAt: CREATED_AT },
      )).toThrowError(expect.objectContaining({ code: 'CAS_CONFLICT' }));
      expect(database.countReviews(WORKFLOW_ID)).toBe(0);
      expect(persistence.getWorkflow(WORKFLOW_ID)).toEqual(winner);
    });

    it('lazy-loads latest and selected review rounds with all issues', () => {
      persistence.createWorkflow(snapshot());
      for (const round of [1, 2]) {
        database.createWorkflowStep({
          id: `${WORKFLOW_ID}:0:reviewer:${round}`,
          workflow_id: WORKFLOW_ID,
          agent_type: 'reviewer',
          review_round: round,
          status: 'completed',
          input: '{}',
          output: '{}',
          error: null,
          started_at: CREATED_AT,
          completed_at: CREATED_AT,
        });
        const report = reviewReport({ round, summary: `Round ${round}` });
        const rows = workflowInfrastructureInternals.reviewRows(snapshot({
          reviewRound: round,
          executionCycle: 0,
          updatedAt: `2026-08-01T00:0${round}:00.000Z`,
        }), report);
        database.createReview(rows.review, rows.issues);
      }
      expect(persistence.getReview(WORKFLOW_ID)?.round).toBe(2);
      expect(persistence.getReview(WORKFLOW_ID, 1)?.summary).toBe('Round 1');
      expect(persistence.getReview(WORKFLOW_ID, 3)).toBeNull();
    });
  });

  describe('task model-switch boundary', () => {
    it.each([
      'idle',
      'planning',
      'waiting_plan_confirmation',
      'executing',
      'testing',
      'reviewing',
      'paused',
    ] as const)('treats a %s Workflow as active for its owning task', (status) => {
      const infrastructure = new WorkflowInfrastructure(database, {} as never);
      infrastructure.persistence.createWorkflow(snapshot({ status }));
      expect(infrastructure.isWorkflowActive(TASK_ID)).toBe(true);
    });

    it.each(['completed', 'failed', 'cancelled'] as const)(
      'allows future task model changes after a %s Workflow',
      (status) => {
        const infrastructure = new WorkflowInfrastructure(database, {} as never);
        infrastructure.persistence.createWorkflow(snapshot({ status }));
        expect(infrastructure.isWorkflowActive(TASK_ID)).toBe(false);
      },
    );
  });

  describe('GitWorkspaceWorkflowGateway', () => {
    it('uses only getStatus and returns the allowlisted read-only context', async () => {
      const reader = { getStatus: vi.fn(async () => gitStatus()) };
      const gateway = new GitWorkspaceWorkflowGateway(reader);
      await expect(gateway.readContext(PROJECT_PATH)).resolves.toEqual({
        kind: 'repository',
        head: 'abc123',
        branch: 'main',
        files: [{ filePath: 'src/App.tsx', changeType: 'modified', staged: false }],
      });
      expect(reader.getStatus).toHaveBeenCalledWith(PROJECT_PATH);
    });

    it('classifies only an explicit non-repository failure as read-only context', async () => {
      const rawPath = 'C:\\private\\first-run-project';
      const gateway = new GitWorkspaceWorkflowGateway({
        getStatus: async () => {
          throw new GitWorkspaceError(`Selected ${rawPath} is not a repository.`, 'NOT_A_REPOSITORY');
        },
      });

      const context = await gateway.readContext(PROJECT_PATH);

      expect(context).toEqual({
        kind: 'not_repository',
        head: null,
        branch: null,
        files: [],
      });
      expect(JSON.stringify(context)).not.toContain(rawPath);
    });

    it('does not disguise an unexpected Git inspection error as a clean repository', async () => {
      const failure = new GitWorkspaceError(
        'C:\\private\\repository has dubious ownership.',
        'INVALID_GIT_OUTPUT',
      );
      const gateway = new GitWorkspaceWorkflowGateway({
        getStatus: async () => { throw failure; },
      });

      await expect(gateway.readContext(PROJECT_PATH)).rejects.toBe(failure);
    });

    it('keeps terminal controls stable after an unknown Git failure in the real checkpoint stack', async () => {
      const rawPath = 'C:\\private\\unknown-git-owner';
      class UnknownGitWorkspace extends GitWorkspaceService {
        calls = 0;

        override async getStatus(_projectPath: string): Promise<GitStatus> {
          this.calls += 1;
          throw new GitWorkspaceError(
            `Unable to inspect ${rawPath}.`,
            'INVALID_GIT_OUTPUT',
          );
        }
      }

      const projectId = 'unknown-git-project';
      const taskId = 'unknown-git-task';
      const workflowId = 'unknown-git-workflow';
      const projectPath = path.join(directory, 'unknown-git-project');
      fs.mkdirSync(projectPath);
      database.createProject(projectId, 'Unknown Git project', projectPath);
      database.createSession(taskId, projectId, 'Unknown Git task', null, 'plan');
      database.ensureTask(taskId, projectId, 'idle', 'plan');
      const git = new UnknownGitWorkspace();
      const checkpointManager = new CheckpointManager(
        database,
        path.join(directory, 'unknown-git-checkpoints'),
        { git },
      );
      const workflowEvents: WorkflowEvent[] = [];
      const permissionCompletions: string[] = [];
      const runner = new ScriptedRunner();
      const manager = new AgentWorkflowManager({
        persistence,
        runner,
        git: new GitWorkspaceWorkflowGateway(git),
        checkpoints: new CheckpointWorkflowGateway(database, checkpointManager),
        events: { publish: (event) => { workflowEvents.push(event); } },
        permissionLifecycle: {
          completeTask: ({ workflowId: completedId }) => {
            permissionCompletions.push(completedId ?? '');
          },
        },
      });
      await manager.createWorkflow({
        id: workflowId,
        taskId,
        projectId,
        projectPath,
        prompt: 'Create a read-only plan',
        currentPermissionMode: 'plan',
      });

      const failed = await manager.startPlanning(workflowId);
      const repeated = await manager.confirmPlan(workflowId);
      const cancelled = await manager.cancelWorkflow(workflowId);
      const paused = await manager.pauseWorkflow(workflowId);

      expect(failed).toMatchObject({
        status: 'failed',
        failure: {
          stage: 'planner',
          code: 'AGENT_STAGE_FAILED',
          message: 'Agent stage failed.',
        },
      });
      expect(repeated).toEqual(failed);
      expect(cancelled).toEqual(failed);
      expect(paused).toEqual(failed);
      expect(persistence.getWorkflow(workflowId)?.failure).toEqual({
        stage: 'planner',
        code: 'AGENT_STAGE_FAILED',
        message: 'Agent stage failed.',
      });
      expect(runner.requests).toEqual([]);
      expect(git.calls).toBe(1);
      expect(database.listCheckpoints(taskId)).toEqual([]);
      expect(workflowEvents.filter((event) => event.type === 'workflow_terminal')).toHaveLength(1);
      expect(permissionCompletions).toEqual([workflowId]);
      expect(JSON.stringify({
        failed,
        repeated,
        cancelled,
        paused,
        persisted: persistence.getWorkflow(workflowId),
      }))
        .not.toContain(rawPath);
    });

    it('sanitizes a before-plan checkpoint Git failure without retrying a terminal checkpoint', async () => {
      const rawPath = 'C:\\private\\checkpoint-owner';
      class FailingCheckpointGitWorkspace extends GitWorkspaceService {
        calls = 0;

        override async getStatus(projectPath: string): Promise<GitStatus> {
          this.calls += 1;
          if (this.calls === 1) {
            return gitStatus({
              projectPath,
              clean: true,
              files: [],
              stagedFiles: [],
              unstagedFiles: [],
              untrackedFiles: [],
              additions: 0,
              deletions: 0,
            });
          }
          throw new GitWorkspaceError(
            `Unable to checkpoint ${rawPath}.`,
            'INVALID_GIT_OUTPUT',
          );
        }
      }

      const projectId = 'checkpoint-failure-project';
      const taskId = 'checkpoint-failure-task';
      const workflowId = 'checkpoint-failure-workflow';
      const projectPath = path.join(directory, 'checkpoint-failure-project');
      fs.mkdirSync(projectPath);
      database.createProject(projectId, 'Checkpoint failure project', projectPath);
      database.createSession(taskId, projectId, 'Checkpoint failure task', null, 'plan');
      database.ensureTask(taskId, projectId, 'idle', 'plan');
      const git = new FailingCheckpointGitWorkspace();
      const checkpointManager = new CheckpointManager(
        database,
        path.join(directory, 'checkpoint-failure-snapshots'),
        { git },
      );
      const workflowEvents: WorkflowEvent[] = [];
      const permissionCompletions: string[] = [];
      const runner = new ScriptedRunner();
      const manager = new AgentWorkflowManager({
        persistence,
        runner,
        git: new GitWorkspaceWorkflowGateway(git),
        checkpoints: new CheckpointWorkflowGateway(database, checkpointManager),
        events: { publish: (event) => { workflowEvents.push(event); } },
        permissionLifecycle: {
          completeTask: ({ workflowId: completedId }) => {
            permissionCompletions.push(completedId ?? '');
          },
        },
      });
      await manager.createWorkflow({
        id: workflowId,
        taskId,
        projectId,
        projectPath,
        prompt: 'Create a repository plan',
        currentPermissionMode: 'plan',
      });

      const failed = await manager.startPlanning(workflowId);

      expect(failed).toMatchObject({
        status: 'failed',
        failure: {
          stage: 'planner',
          code: 'AGENT_STAGE_FAILED',
          message: 'Agent stage failed.',
        },
      });
      expect(persistence.getWorkflow(workflowId)?.failure).toEqual({
        stage: 'planner',
        code: 'AGENT_STAGE_FAILED',
        message: 'Agent stage failed.',
      });
      expect(runner.requests).toEqual([]);
      expect(git.calls).toBe(2);
      expect(database.listCheckpoints(taskId)).toEqual([]);
      expect(workflowEvents.filter((event) => event.type === 'workflow_terminal')).toHaveLength(1);
      expect(permissionCompletions).toEqual([workflowId]);
      expect(JSON.stringify({
        failed,
        persisted: persistence.getWorkflow(workflowId),
        workflowEvents,
      })).not.toContain(rawPath);
    });

    it('rejects a terminal checkpoint Git failure with only the fixed workflow error', async () => {
      const rawPath = 'C:\\private\\terminal-checkpoint-owner';
      class TerminalCheckpointGitWorkspace extends GitWorkspaceService {
        calls = 0;
        failCheckpoint = false;

        override async getStatus(projectPath: string): Promise<GitStatus> {
          this.calls += 1;
          if (this.failCheckpoint) {
            throw new GitWorkspaceError(
              `Unable to checkpoint ${rawPath}.`,
              'INVALID_GIT_OUTPUT',
            );
          }
          return gitStatus({
            projectPath,
            clean: true,
            files: [],
            stagedFiles: [],
            unstagedFiles: [],
            untrackedFiles: [],
            additions: 0,
            deletions: 0,
          });
        }
      }

      const projectId = 'terminal-checkpoint-project';
      const taskId = 'terminal-checkpoint-task';
      const workflowId = 'terminal-checkpoint-workflow';
      const projectPath = path.join(directory, 'terminal-checkpoint-project');
      fs.mkdirSync(projectPath);
      database.createProject(projectId, 'Terminal checkpoint project', projectPath);
      database.createSession(taskId, projectId, 'Terminal checkpoint task', null, 'default');
      database.ensureTask(taskId, projectId, 'idle', 'default');
      const git = new TerminalCheckpointGitWorkspace();
      const checkpointManager = new CheckpointManager(
        database,
        path.join(directory, 'terminal-checkpoint-snapshots'),
        { git },
      );
      const checkpointGateway = new CheckpointWorkflowGateway(database, checkpointManager);
      const workflowEvents: WorkflowEvent[] = [];
      const permissionCompletions: string[] = [];
      const workflowPersistence = new MemoryWorkflowPersistence();
      const manager = new AgentWorkflowManager({
        persistence: workflowPersistence,
        runner: new ScriptedRunner(),
        git: new GitWorkspaceWorkflowGateway(git),
        checkpoints: {
          createCheckpoint: async (request) => {
            if (request.boundary === 'terminal') git.failCheckpoint = true;
            await checkpointGateway.createCheckpoint(request);
          },
        },
        events: { publish: (event) => { workflowEvents.push(event); } },
        permissionLifecycle: {
          completeTask: ({ workflowId: completedId }) => {
            permissionCompletions.push(completedId ?? '');
          },
        },
      });
      await manager.createWorkflow({
        id: workflowId,
        taskId,
        projectId,
        projectPath,
        prompt: 'Complete a repository workflow',
        currentPermissionMode: 'default',
      });
      await manager.startPlanning(workflowId);

      const rejection = await manager.confirmPlan(workflowId).then(
        () => null,
        (error: unknown) => error,
      );

      expect(rejection).toMatchObject({
        name: 'WorkflowCheckpointError',
        message: 'Workflow checkpoint is unavailable.',
      });
      expect(rejection instanceof Error ? rejection.message : JSON.stringify(rejection))
        .not.toContain(rawPath);
      expect(workflowPersistence.getWorkflow(workflowId)).toMatchObject({
        status: 'completed',
        failure: null,
      });
      expect(workflowEvents.filter((event) => event.type === 'workflow_terminal')).toHaveLength(0);
      expect(permissionCompletions).toEqual([workflowId]);
    });

    it('does not expose diff content, upstream data, or line statistics', async () => {
      const gateway = new GitWorkspaceWorkflowGateway({ getStatus: async () => gitStatus() });
      const context = await gateway.readContext(PROJECT_PATH);
      expect(context).not.toHaveProperty('upstream');
      expect(context.files[0]).not.toHaveProperty('additions');
      expect(context.files[0]).not.toHaveProperty('patch');
    });
  });

  describe('CheckpointWorkflowGateway', () => {
    const cases: Array<[string, CheckpointType]> = [
      ['before_plan', 'before_plan'],
      ['after_plan', 'after_plan'],
      ['before_execute', 'before_execute'],
      ['after_execute', 'after_execute'],
      ['before_fix', 'before_fix'],
      ['after_fix', 'after_fix'],
      ['before_review', 'before_review'],
      ['terminal', 'task_completed'],
    ];

    it.each(cases)('maps %s to checkpoint type %s', async (boundary, expectedType) => {
      const store = new CheckpointStoreStub();
      const gateway = new CheckpointWorkflowGateway(database, store as never);
      await gateway.createCheckpoint({
        workflowId: WORKFLOW_ID,
        taskId: TASK_ID,
        projectPath: PROJECT_PATH,
        stage: boundary === 'terminal' ? null : 'coder',
        round: 1,
        boundary: boundary as never,
        idempotencyKey: `key:${boundary}`,
      });
      expect(store.createCalls[0]?.type).toBe(expectedType);
      expect(store.operationCalls[0]).toBe('begin:before_task');
      expect(store.createCalls[0]?.context).toMatchObject({ runId: WORKFLOW_ID });
      expect(JSON.stringify(store.createCalls[0]?.context)).not.toContain(`key:${boundary}`);
    });

    it('creates the workflow baseline before the first planning boundary', async () => {
      const store = new CheckpointStoreStub();
      const gateway = new CheckpointWorkflowGateway(database, store as never);
      await gateway.createCheckpoint({
        workflowId: WORKFLOW_ID,
        taskId: TASK_ID,
        projectPath: PROJECT_PATH,
        stage: 'planner',
        round: 0,
        boundary: 'before_plan',
        idempotencyKey: 'before-plan-order',
      });
      expect(store.operationCalls).toEqual(['begin:before_task', 'create:before_plan']);
      expect(store.checkpoints.map((checkpoint) => checkpoint.type)).toEqual([
        'before_task',
        'before_plan',
      ]);
    });

    it('coalesces duplicate calls and remains idempotent after gateway restart', async () => {
      const store = new CheckpointStoreStub();
      const request = {
        workflowId: WORKFLOW_ID,
        taskId: TASK_ID,
        projectPath: PROJECT_PATH,
        stage: 'planner' as const,
        round: 0,
        boundary: 'before_plan' as const,
        idempotencyKey: 'same-key',
      };
      const first = new CheckpointWorkflowGateway(database, store as never);
      await Promise.all([first.createCheckpoint(request), first.createCheckpoint(request)]);
      const restarted = new CheckpointWorkflowGateway(database, store as never);
      await restarted.createCheckpoint(request);
      expect(store.createCalls).toHaveLength(1);
    });

    it('calls the baseline initializer again after restart before accepting an existing boundary', async () => {
      const store = new CheckpointStoreStub();
      const request = {
        workflowId: WORKFLOW_ID,
        taskId: TASK_ID,
        projectPath: PROJECT_PATH,
        stage: 'planner' as const,
        round: 0,
        boundary: 'before_plan' as const,
        idempotencyKey: 'restart-baseline',
      };
      await new CheckpointWorkflowGateway(database, store as never).createCheckpoint(request);
      store.operationCalls = [];
      await new CheckpointWorkflowGateway(database, store as never).createCheckpoint(request);
      expect(store.operationCalls).toEqual(['begin:before_task']);
      expect(store.createCalls).toHaveLength(1);
    });

    it('coalesces the baseline across concurrent distinct boundaries', async () => {
      const store = new CheckpointStoreStub();
      const originalBegin = store.beginWorkflow.bind(store);
      let releaseBaseline: (() => void) | undefined;
      const baselineGate = new Promise<void>((resolve) => { releaseBaseline = resolve; });
      const begin = vi.spyOn(store, 'beginWorkflow').mockImplementation(async (...args) => {
        await baselineGate;
        return originalBegin(...args);
      });
      const gateway = new CheckpointWorkflowGateway(database, store as never);
      const base = {
        workflowId: WORKFLOW_ID,
        taskId: TASK_ID,
        projectPath: PROJECT_PATH,
        stage: 'planner' as const,
        round: 0,
      };
      const before = gateway.createCheckpoint({
        ...base,
        boundary: 'before_plan',
        idempotencyKey: 'concurrent-before',
      });
      const after = gateway.createCheckpoint({
        ...base,
        boundary: 'after_plan',
        idempotencyKey: 'concurrent-after',
      });
      expect(begin).toHaveBeenCalledTimes(1);
      releaseBaseline?.();
      await Promise.all([before, after]);
      expect(store.checkpoints.filter((checkpoint) => checkpoint.type === 'before_task')).toHaveLength(1);
      expect(store.createCalls.map((call) => call.type)).toEqual(['before_plan', 'after_plan']);
    });

    it('creates distinct checkpoints for distinct idempotency keys', async () => {
      const store = new CheckpointStoreStub();
      const gateway = new CheckpointWorkflowGateway(database, store as never);
      const base = {
        workflowId: WORKFLOW_ID,
        taskId: TASK_ID,
        projectPath: PROJECT_PATH,
        stage: 'coder' as const,
        round: 1,
        boundary: 'before_execute' as const,
      };
      await gateway.createCheckpoint({ ...base, idempotencyKey: 'execute-attempt-1' });
      await gateway.createCheckpoint({ ...base, idempotencyKey: 'execute-attempt-2' });
      expect(store.createCalls.map((call) => call.type)).toEqual(['before_execute', 'before_execute']);
      expect(store.createCalls[0]?.context.reason).not.toBe(store.createCalls[1]?.context.reason);
    });

    it('uses a deterministic digest in the persisted boundary reason', async () => {
      const store = new CheckpointStoreStub();
      const gateway = new CheckpointWorkflowGateway(database, store as never);
      const request = {
        workflowId: WORKFLOW_ID,
        taskId: TASK_ID,
        projectPath: PROJECT_PATH,
        stage: 'tester' as const,
        round: 1,
        boundary: 'after_execute' as const,
        idempotencyKey: 'raw-secret-idempotency-key',
      };
      await gateway.createCheckpoint(request);
      const firstReason = String(store.createCalls[0]?.context.reason);
      await new CheckpointWorkflowGateway(database, store as never).createCheckpoint(request);
      expect(firstReason).toMatch(/^workflow-boundary:boundary:[^:]+:[^:]+:[a-f0-9]{64}$/);
      expect(firstReason).not.toContain(request.idempotencyKey);
      expect(store.createCalls).toHaveLength(1);
    });

    it('isolates the same idempotency key between workflow runs', async () => {
      const store = new CheckpointStoreStub();
      const gateway = new CheckpointWorkflowGateway(database, store as never);
      const base = {
        taskId: TASK_ID,
        projectPath: PROJECT_PATH,
        stage: 'reviewer' as const,
        round: 1,
        boundary: 'before_review' as const,
        idempotencyKey: 'review-round-1',
      };
      await gateway.createCheckpoint({ ...base, workflowId: WORKFLOW_ID });
      await gateway.createCheckpoint({ ...base, workflowId: 'workflow-2' });
      expect(store.createCalls).toHaveLength(2);
      expect(store.createCalls.map((call) => call.context.runId)).toEqual([
        WORKFLOW_ID,
        'workflow-2',
      ]);
    });

    it('records fix boundaries in restore-list order and scope', async () => {
      const store = new CheckpointStoreStub();
      const gateway = new CheckpointWorkflowGateway(database, store as never);
      for (const boundary of ['before_fix', 'after_fix'] as const) {
        await gateway.createCheckpoint({
          workflowId: WORKFLOW_ID,
          taskId: TASK_ID,
          projectPath: PROJECT_PATH,
          stage: 'coder',
          round: 2,
          boundary,
          idempotencyKey: `fix-round-2:${boundary}`,
        });
      }
      expect(store.checkpoints.map((checkpoint) => checkpoint.type)).toEqual([
        'before_task',
        'before_fix',
        'after_fix',
      ]);
      expect(store.listCheckpoints(TASK_ID).every((checkpoint) => (
        checkpoint.metadata.runId === WORKFLOW_ID
      ))).toBe(true);
    });

    it('creates terminal only after the workflow baseline', async () => {
      const store = new CheckpointStoreStub();
      const gateway = new CheckpointWorkflowGateway(database, store as never);
      await gateway.createCheckpoint({
        workflowId: WORKFLOW_ID,
        taskId: TASK_ID,
        projectPath: PROJECT_PATH,
        stage: null,
        round: 1,
        boundary: 'terminal',
        idempotencyKey: 'terminal-order',
      });
      expect(store.operationCalls).toEqual(['begin:before_task', 'create:task_completed']);
    });

    it('does not create a boundary when baseline initialization fails', async () => {
      const store = new CheckpointStoreStub();
      vi.spyOn(store, 'beginWorkflow').mockRejectedValueOnce(new Error('baseline failed'));
      const gateway = new CheckpointWorkflowGateway(database, store as never);
      await expect(gateway.createCheckpoint({
        workflowId: WORKFLOW_ID,
        taskId: TASK_ID,
        projectPath: PROJECT_PATH,
        stage: 'planner',
        round: 0,
        boundary: 'before_plan',
        idempotencyKey: 'failed-baseline',
      })).rejects.toThrow('baseline failed');
      expect(store.createCalls).toHaveLength(0);
    });

    it('clears failed boundary operations so the same request can be retried', async () => {
      const store = new CheckpointStoreStub();
      const originalCreate = store.createTaskCheckpoint.bind(store);
      vi.spyOn(store, 'createTaskCheckpoint')
        .mockRejectedValueOnce(new Error('snapshot failed'))
        .mockImplementation(originalCreate);
      const gateway = new CheckpointWorkflowGateway(database, store as never);
      const request = {
        workflowId: WORKFLOW_ID,
        taskId: TASK_ID,
        projectPath: PROJECT_PATH,
        stage: 'coder' as const,
        round: 1,
        boundary: 'before_execute' as const,
        idempotencyKey: 'retry-boundary',
      };
      await expect(gateway.createCheckpoint(request)).rejects.toThrow('snapshot failed');
      await expect(gateway.createCheckpoint(request)).resolves.toBeUndefined();
      expect(store.createCalls).toHaveLength(1);
      expect(store.createCalls[0]?.type).toBe('before_execute');
    });

    it('rejects an unknown task before baseline initialization', async () => {
      const store = new CheckpointStoreStub();
      const gateway = new CheckpointWorkflowGateway(database, store as never);
      await expect(gateway.createCheckpoint({
        workflowId: WORKFLOW_ID,
        taskId: 'missing-task',
        projectPath: PROJECT_PATH,
        stage: 'planner',
        round: 0,
        boundary: 'before_plan',
        idempotencyKey: 'missing-task',
      })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(store.operationCalls).toEqual([]);
      expect(store.createCalls).toEqual([]);
    });

    it('rejects a checkpoint request for another registered project', async () => {
      const gateway = new CheckpointWorkflowGateway(database, new CheckpointStoreStub() as never);
      await expect(gateway.createCheckpoint({
        workflowId: WORKFLOW_ID,
        taskId: TASK_ID,
        projectPath: 'C:\projects\wrong',
        stage: 'planner',
        round: 0,
        boundary: 'before_plan',
        idempotencyKey: 'wrong-project',
      })).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
    });
  });

  describe('DatabaseWorkflowEventGateway', () => {
    beforeEach(() => persistence.createWorkflow(snapshot()));

    it('persists only a structured summary and strips raw workflow payload', async () => {
      const gateway = new DatabaseWorkflowEventGateway(database, persistence);
      await gateway.publish(workflowEvent());
      const event = database.listEvents(TASK_ID).find((row) => row.event_type === 'workflow_progress');
      expect(event).toBeDefined();
      expect(event?.payload_json).not.toContain('DO NOT PERSIST');
      expect(event?.payload_json).not.toContain('SECRET SYSTEM CONTENT');
      expect(JSON.parse(event?.payload_json ?? '{}')).toMatchObject({
        type: 'workflow_progress',
        workflowId: WORKFLOW_ID,
        status: 'planning',
        currentStage: 'planner',
      });
    });

    it('emits a shared WorkflowChangedEvent-compatible notification', async () => {
      const notifications: WorkflowNotification[] = [];
      const gateway = new DatabaseWorkflowEventGateway(
        database,
        persistence,
        (notification) => notifications.push(notification),
      );
      await gateway.publish(workflowEvent());
      expect(notifications).toEqual([expect.objectContaining({
        workflowId: WORKFLOW_ID,
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        status: 'planning',
        currentStage: 'planner',
        revision: 0,
        eventType: 'workflow_status_changed',
      })]);
    });

    it('uses deterministic event ids to avoid duplicate events and notifications', async () => {
      const notify = vi.fn();
      const gateway = new DatabaseWorkflowEventGateway(database, persistence, notify);
      await gateway.publish(workflowEvent());
      await gateway.publish(workflowEvent());
      expect(database.listEvents(TASK_ID).filter((row) => row.event_type === 'workflow_progress'))
        .toHaveLength(1);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('rejects conflicting content that reuses an event idempotency key', async () => {
      const gateway = new DatabaseWorkflowEventGateway(database, persistence);
      await gateway.publish(workflowEvent());
      await expect(gateway.publish(workflowEvent({ status: 'failed', stage: null })))
        .rejects.toMatchObject({ code: 'CORRUPT_DATA' });
      const rows = database.listEvents(TASK_ID).filter((row) => row.event_type === 'workflow_progress');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload_json).toContain('"status":"planning"');
      expect(database.getTask(TASK_ID)?.status).toBe('running');
    });

    it('keeps the durable event when renderer notification fails', async () => {
      const gateway = new DatabaseWorkflowEventGateway(database, persistence, async () => {
        throw new Error('renderer closed');
      });
      await expect(gateway.publish(workflowEvent())).resolves.toBeUndefined();
      expect(database.listEvents(TASK_ID).some((row) => row.event_type === 'workflow_progress')).toBe(true);
    });

    it('hydrates workflow progress through the existing task timeline', async () => {
      const gateway = new DatabaseWorkflowEventGateway(database, persistence);
      await gateway.publish(workflowEvent());
      const persisted = new TaskQueryService(database).getSnapshot(TASK_ID, { limit: 100 });
      expect(persisted).not.toBeNull();
      const hydrated = hydratePersistedTasks(persisted as NonNullable<typeof persisted>);
      expect(hydrated.timeline[0]?.event.type).toBe('workflow_progress');
      expect(selectTimelinePresentations(hydrated.timeline)[0]).toMatchObject({
        title: 'Workflow status changed',
        tone: 'info',
      });
    });

    it('maps paused workflow status to idle task/session rows while preserving workflow state', async () => {
      const gateway = new DatabaseWorkflowEventGateway(database, persistence);
      await gateway.publish(workflowEvent());
      expect(database.getTask(TASK_ID)?.status).toBe('running');
      expect(database.getSession(TASK_ID)?.status).toBe('running');

      persistence.saveWorkflow(
        snapshot({
          status: 'paused',
          pausedFrom: 'executing',
          revision: 1,
          updatedAt: '2026-08-01T00:01:30.000Z',
        }),
        { expectedRevision: 0, expectedUpdatedAt: CREATED_AT },
      );
      await gateway.publish(workflowEvent({
        idempotencyKey: 'paused',
        status: 'paused',
        stage: null,
        timestamp: '2026-08-01T00:02:00.000Z',
      }));
      expect(database.getTask(TASK_ID)?.status).toBe('idle');
      expect(database.getSession(TASK_ID)?.status).toBe('idle');
      expect(persistence.getWorkflow(WORKFLOW_ID)?.status).toBe('paused');

      await gateway.publish(workflowEvent({
        idempotencyKey: 'terminal',
        type: 'workflow_terminal',
        status: 'completed',
        stage: null,
        timestamp: '2026-08-01T00:03:00.000Z',
      }));
      expect(database.getTask(TASK_ID)).toMatchObject({
        status: 'completed',
        completed_at: '2026-08-01T00:03:00.000Z',
      });
      expect(database.getSession(TASK_ID)).toMatchObject({
        status: 'completed',
        completed_at: '2026-08-01T00:03:00.000Z',
      });
    });
  });

  describe('commit preview helpers and aggregate', () => {
    it('builds a structured body without copying the user prompt', () => {
      const workflow = {
        ...snapshot({ plan: executionPlan(), latestReview: reviewReport(), reviewRound: 1 }),
      } as Workflow;
      const body = buildWorkflowCommitPreviewBody(workflow, commitPreview(), reviewReport());
      expect(body).toContain('## Plan');
      expect(body).toContain('## Review');
      expect(body).toContain('## Files');
      expect(body).not.toContain(workflow.prompt);
    });

    it('returns a standard CommitPreview with an enriched message and never commits', async () => {
      persistence.createWorkflow(snapshot({ plan: executionPlan() }));
      const store = new CheckpointStoreStub();
      const infrastructure = new WorkflowInfrastructure(
        database,
        store as never,
        { getStatus: async () => gitStatus() } as never,
      );
      const preview = await infrastructure.createCommitPreview(WORKFLOW_ID);
      expect(preview).toMatchObject({
        subject: 'feat(workflow): add workflow infrastructure',
        files: ['src/main/workflows/WorkflowInfrastructure.ts'],
      });
      expect(preview.message).toContain('feat(workflow): add workflow infrastructure\n\n## Workflow');
      expect(store.previewCalls).toEqual([TASK_ID]);
      expect(store.commitCalls).toBe(0);
    });

    it('assembles workflow dependencies from the concrete adapters', () => {
      const store = new CheckpointStoreStub();
      const infrastructure = new WorkflowInfrastructure(
        database,
        store as never,
        { getStatus: async () => gitStatus() } as never,
      );
      const runner = { runStage: vi.fn() } as never;
      expect(infrastructure.dependencies(runner)).toEqual({
        persistence: infrastructure.persistence,
        runner,
        checkpoints: infrastructure.checkpoints,
        git: infrastructure.git,
        events: infrastructure.events,
      });
    });

    it('throws NOT_FOUND instead of creating a preview for an unknown workflow', async () => {
      const infrastructure = new WorkflowInfrastructure(
        database,
        new CheckpointStoreStub() as never,
        { getStatus: async () => gitStatus() } as never,
      );
      await expect(infrastructure.createCommitPreview('missing')).rejects.toBeInstanceOf(
        WorkflowInfrastructureError,
      );
    });
  });
});
