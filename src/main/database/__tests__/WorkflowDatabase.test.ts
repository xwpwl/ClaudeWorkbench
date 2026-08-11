import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppDatabase,
  type ReviewIssueRow,
  type ReviewRow,
  type WorkflowRow,
  type WorkflowStepRow,
} from '../Database';

const TEMP_PREFIX = 'claude-workbench-workflow-db-test-';
const PROJECT_ID = 'project-1';
const TASK_ID = 'task-1';
const WORKFLOW_ID = 'workflow-1';
const CREATED_AT = '2026-01-01T00:00:00.000Z';

function removeTestDirectory(directory: string): void {
  const target = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function workflow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    id: WORKFLOW_ID,
    task_id: TASK_ID,
    status: 'idle',
    current_stage: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    metadata_json: '{"revision":0,"prompt":"实现工作流"}',
    ...overrides,
  };
}

function step(overrides: Partial<WorkflowStepRow> = {}): WorkflowStepRow {
  return {
    id: 'step-1',
    workflow_id: WORKFLOW_ID,
    agent_type: 'planner',
    review_round: 0,
    status: 'pending',
    input: '{"prompt":"plan"}',
    output: null,
    error: null,
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function trustedModelSelection() {
  return {
    providerId: 'provider-mimo',
    providerName: 'MiMo',
    modelId: 'mimo-v2.5-pro',
    runtimeType: 'claude-code' as const,
    source: 'global_agent_policy' as const,
    executionSource: 'environment' as const,
    tier: 'balanced' as const,
    tierSource: 'project' as const,
    capabilities: {
      supportsClaudeCode: true,
      supportsAgentWorkflow: true,
      supportsTools: true,
      supportsMCP: true,
      supportsStreaming: true,
      supportsVision: false,
    },
  };
}

function forgedModelSelection() {
  return {
    ...trustedModelSelection(),
    providerId: 'renderer-forged-provider',
    providerName: 'Renderer forged provider',
    modelId: 'renderer-forged-model',
    source: 'task_override' as const,
  };
}

function review(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: 'review-1',
    workflow_id: WORKFLOW_ID,
    step_id: null,
    review_round: 1,
    score: 8.5,
    summary: 'Looks good overall',
    tests_passed: 12,
    tests_failed: 0,
    tests_skipped: 1,
    created_at: '2026-01-01T01:00:00.000Z',
    ...overrides,
  };
}

function issue(overrides: Partial<ReviewIssueRow> = {}): ReviewIssueRow {
  return {
    id: 'issue-1',
    review_id: 'review-1',
    severity: 'medium',
    file_path: 'src/App.tsx',
    line: 42,
    title: 'Missing guard',
    recommendation: 'Add a null guard before reading the value.',
    resolved: false,
    created_at: '2026-01-01T01:01:00.000Z',
    ...overrides,
  };
}

describe('workflow SQLite persistence', () => {
  let directory: string;
  let databasePath: string;
  let database: AppDatabase;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    databasePath = path.join(directory, 'workbench.sqlite');
    database = new AppDatabase(databasePath);
    database.ensureTask(TASK_ID, PROJECT_ID);
    database.createWorkflow(workflow());
  });

  afterEach(() => {
    database.close();
    removeTestDirectory(directory);
  });

  function seedWorkflow(id: string, taskId: string, overrides: Partial<WorkflowRow> = {}): WorkflowRow {
    database.ensureTask(taskId, PROJECT_ID);
    const row = workflow({ id, task_id: taskId, ...overrides });
    database.createWorkflow(row);
    return row;
  }

  describe('workflow rows', () => {
    it('round-trips every workflow column without interpreting metadata JSON', () => {
      expect(database.getWorkflow(WORKFLOW_ID)).toEqual(workflow());
    });

    it('returns null for an unknown workflow and task lookup', () => {
      expect(database.getWorkflow('missing')).toBeNull();
      expect(database.getWorkflowByTaskId('missing')).toBeNull();
    });

    it('looks up the workflow associated with a task', () => {
      expect(database.getWorkflowByTaskId(TASK_ID)?.id).toBe(WORKFLOW_ID);
    });

    it('enforces one workflow per task', () => {
      expect(() => database.createWorkflow(workflow({ id: 'workflow-duplicate' }))).toThrow();
      expect(database.countWorkflows()).toBe(1);
    });

    it('rejects a workflow whose task does not exist', () => {
      expect(() => database.createWorkflow(workflow({
        id: 'workflow-orphan',
        task_id: 'task-missing',
      }))).toThrow(/FOREIGN KEY/i);
      expect(database.getWorkflow('workflow-orphan')).toBeNull();
    });

    it('rejects a workflow status outside the public state machine', () => {
      expect(() => seedWorkflow('workflow-invalid', 'task-invalid', {
        status: 'developing',
      })).toThrow(/CHECK constraint/i);
      expect(database.getWorkflow('workflow-invalid')).toBeNull();
    });

    it('rejects an unknown active agent stage', () => {
      expect(() => seedWorkflow('workflow-invalid-stage', 'task-invalid-stage', {
        current_stage: 'maintainer',
      })).toThrow(/CHECK constraint/i);
      expect(database.getWorkflow('workflow-invalid-stage')).toBeNull();
    });

    it('requires metadata_json to contain valid JSON', () => {
      expect(() => seedWorkflow('workflow-invalid-json', 'task-invalid-json', {
        metadata_json: '{broken',
      })).toThrow(/CHECK constraint/i);
      expect(database.getWorkflow('workflow-invalid-json')).toBeNull();
    });

    it('requires workflow metadata to be a structured JSON object', () => {
      expect(() => seedWorkflow('workflow-scalar-json', 'task-scalar-json', {
        metadata_json: '"raw assistant transcript"',
      })).toThrow(/CHECK constraint/i);
      expect(database.getWorkflow('workflow-scalar-json')).toBeNull();
    });

    it('saves status, stage, timestamp, and metadata together', () => {
      const next = workflow({
        status: 'planning',
        current_stage: 'planner',
        updated_at: '2026-01-01T00:01:00.000Z',
        metadata_json: '{"revision":1,"plan":null}',
      });
      expect(database.saveWorkflow(next)).toBe(true);
      expect(database.getWorkflow(WORKFLOW_ID)).toEqual(next);
    });

    it('supports compare-and-swap using expectedUpdatedAt', () => {
      const next = workflow({
        status: 'executing',
        current_stage: 'coder',
        updated_at: '2026-01-01T00:02:00.000Z',
      });
      expect(database.saveWorkflow(next, { expectedUpdatedAt: CREATED_AT })).toBe(true);
      expect(database.getWorkflow(WORKFLOW_ID)?.status).toBe('executing');
    });

    it('rejects a stale compare-and-swap without overwriting the winner', () => {
      const winner = workflow({
        status: 'testing',
        current_stage: 'tester',
        updated_at: '2026-01-01T00:03:00.000Z',
      });
      expect(database.saveWorkflow(winner, { expectedUpdatedAt: CREATED_AT })).toBe(true);
      const stale = workflow({
        status: 'failed',
        updated_at: '2026-01-01T00:04:00.000Z',
      });
      expect(database.saveWorkflow(stale, { expectedUpdatedAt: CREATED_AT })).toBe(false);
      expect(database.getWorkflow(WORKFLOW_ID)).toEqual(winner);
    });

    it('reports false when saving or deleting an unknown workflow', () => {
      expect(database.saveWorkflow(workflow({ id: 'missing' }))).toBe(false);
      expect(database.deleteWorkflow('missing')).toBe(false);
    });

    it('orders workflow pages deterministically and filters status', () => {
      seedWorkflow('workflow-2', 'task-2', {
        status: 'paused',
        updated_at: '2026-01-01T00:05:00.000Z',
      });
      seedWorkflow('workflow-3', 'task-3', {
        status: 'paused',
        updated_at: '2026-01-01T00:05:00.000Z',
      });
      expect(database.listWorkflows().map((row) => row.id)).toEqual([
        'workflow-3', 'workflow-2', WORKFLOW_ID,
      ]);
      expect(database.listWorkflowsByStatus('paused').map((row) => row.id)).toEqual([
        'workflow-3', 'workflow-2',
      ]);
      expect(database.countWorkflows('paused')).toBe(2);
      expect(database.countWorkflows()).toBe(3);
    });

    it('uses a default workflow page size of 50', () => {
      database.runInTransaction(() => {
        for (let index = 0; index < 60; index += 1) {
          seedWorkflow(`workflow-page-${index}`, `task-page-${index}`, {
            updated_at: new Date(Date.UTC(2027, 0, 1, 0, 0, index)).toISOString(),
          });
        }
      });
      expect(database.listWorkflows()).toHaveLength(50);
    });

    it('caps pages at 100 and can continue past one thousand rows', () => {
      database.runInTransaction(() => {
        for (let index = 0; index < 1_005; index += 1) {
          seedWorkflow(`workflow-bulk-${index.toString().padStart(4, '0')}`, `task-bulk-${index}`, {
            updated_at: new Date(Date.UTC(2027, 0, 1, 0, 0, index)).toISOString(),
          });
        }
      });
      expect(database.listWorkflows({ limit: 10_000 })).toHaveLength(100);
      const tail = database.listWorkflows({ limit: 100, offset: 1_000 });
      expect(tail).toHaveLength(6);
      expect(new Set(tail.map((row) => row.id)).size).toBe(6);
    });

    it('normalizes non-positive limits and offsets', () => {
      seedWorkflow('workflow-2', 'task-2');
      expect(database.listWorkflows({ limit: 0, offset: -20 })).toHaveLength(1);
      expect(database.listWorkflows({ limit: Number.NaN })).toHaveLength(2);
    });

    it('rolls back workflow creation with its surrounding transaction', () => {
      expect(() => database.runInTransaction(() => {
        seedWorkflow('workflow-rollback', 'task-rollback');
        throw new Error('abort');
      })).toThrow('abort');
      expect(database.getWorkflow('workflow-rollback')).toBeNull();
      expect(database.getTask('task-rollback')).toBeNull();
    });

    it('preserves workflow data across database restarts', () => {
      const next = workflow({
        status: 'paused',
        current_stage: 'coder',
        metadata_json: '{"pausedFrom":"executing","revision":7,"currentPermissionMode":"default"}',
      });
      expect(database.saveWorkflow(next)).toBe(true);
      database.close();
      database = new AppDatabase(databasePath);
      expect(database.getWorkflow(WORKFLOW_ID)).toEqual(next);
    });
  });

  describe('workflow step rows', () => {
    it('creates and reads a step with nullable lifecycle fields', () => {
      database.createWorkflowStep(step());
      expect(database.getWorkflowStep('step-1')).toEqual(step());
    });

    it('rejects a step for an unknown workflow', () => {
      expect(() => database.createWorkflowStep(step({
        id: 'step-orphan',
        workflow_id: 'workflow-missing',
      }))).toThrow(/FOREIGN KEY/i);
      expect(database.getWorkflowStep('step-orphan')).toBeNull();
    });

    it('rejects unknown agent types and stage statuses', () => {
      expect(() => database.createWorkflowStep(step({ id: 'bad-agent', agent_type: 'fixer' })))
        .toThrow(/CHECK/i);
      expect(() => database.createWorkflowStep(step({ id: 'bad-status', status: 'in_progress' })))
        .toThrow(/CHECK/i);
      expect(database.countWorkflowSteps(WORKFLOW_ID)).toBe(0);
    });

    it('uses round zero only for planning and rounds one through three for execution stages', () => {
      expect(() => database.createWorkflowStep(step({
        id: 'planner-round-one',
        review_round: 1,
      }))).toThrow(/CHECK/i);
      expect(() => database.createWorkflowStep(step({
        id: 'coder-round-zero',
        agent_type: 'coder',
      }))).toThrow(/CHECK/i);
      expect(() => database.createWorkflowStep(step({
        id: 'reviewer-round-four',
        agent_type: 'reviewer',
        review_round: 4,
      }))).toThrow(/CHECK/i);
      database.createWorkflowStep(step({
        id: 'coder-round-one',
        agent_type: 'coder',
        review_round: 1,
      }));
      expect(database.getWorkflowStep('coder-round-one')?.review_round).toBe(1);
    });

    it('requires structured JSON step input and output', () => {
      expect(() => database.createWorkflowStep(step({ id: 'bad-input', input: 'raw transcript' })))
        .toThrow(/CHECK/i);
      expect(() => database.createWorkflowStep(step({ id: 'bad-output', output: 'raw transcript' })))
        .toThrow(/CHECK/i);
      expect(database.countWorkflowSteps(WORKFLOW_ID)).toBe(0);
    });

    it('rejects JSON string payloads that could contain raw agent transcripts', () => {
      expect(() => database.createWorkflowStep(step({
        id: 'raw-json-input',
        input: '"raw user and system transcript"',
      }))).toThrow(/CHECK/i);
      expect(() => database.createWorkflowStep(step({
        id: 'raw-json-output',
        output: '"raw assistant transcript"',
      }))).toThrow(/CHECK/i);
      expect(database.countWorkflowSteps(WORKFLOW_ID)).toBe(0);
    });

    it('does not replace a duplicate step during create', () => {
      database.createWorkflowStep(step());
      expect(() => database.createWorkflowStep(step({ status: 'completed' }))).toThrow();
      expect(database.getWorkflowStep('step-1')?.status).toBe('pending');
    });

    it('upserts an idempotent deterministic stage record', () => {
      database.upsertWorkflowStep(step());
      const completed = step({
        status: 'completed',
        output: '{"title":"Plan"}',
        started_at: '2026-01-01T00:01:00.000Z',
        completed_at: '2026-01-01T00:02:00.000Z',
      });
      database.upsertWorkflowStep(completed);
      expect(database.getWorkflowStep('step-1')).toEqual(completed);
      expect(database.countWorkflowSteps(WORKFLOW_ID)).toBe(1);
    });

    it('does not accept model provenance embedded in an ordinary stage upsert', () => {
      database.upsertWorkflowStep(step({
        status: 'running',
        input: JSON.stringify({
          prompt: 'plan',
          modelSelection: forgedModelSelection(),
          __modelSelectionAttachedByMain: true,
        }),
        started_at: '2026-01-01T00:01:00.000Z',
      }));

      const input = JSON.parse(database.getWorkflowStep('step-1')?.input ?? '{}') as Record<string, unknown>;
      expect(input).toEqual({ prompt: 'plan' });
      expect(input.modelSelection).toBeUndefined();
    });

    it('preserves only attached model provenance across terminal replay and restart', () => {
      database.upsertWorkflowStep(step({
        status: 'running',
        input: '{"prompt":"running input"}',
        started_at: '2026-01-01T00:01:00.000Z',
      }));
      expect(database.attachWorkflowStepModelSelection('step-1', trustedModelSelection())).toBe(true);
      const completed = step({
        status: 'completed',
        input: JSON.stringify({
          prompt: 'completed input',
          modelSelection: forgedModelSelection(),
        }),
        output: '{"title":"Plan"}',
        started_at: '2026-01-01T00:01:00.000Z',
        completed_at: '2026-01-01T00:02:00.000Z',
      });

      database.upsertWorkflowStep(completed);
      database.upsertWorkflowStep(completed);

      const persisted = database.getWorkflowStep('step-1');
      expect(persisted).toMatchObject({
        status: 'completed',
        output: '{"title":"Plan"}',
        error: null,
        completed_at: '2026-01-01T00:02:00.000Z',
      });
      expect(JSON.parse(persisted?.input ?? '{}')).toEqual({
        prompt: 'completed input',
        modelSelection: trustedModelSelection(),
      });
      expect(database.listWorkflowSteps(WORKFLOW_ID)[0]?.input)
        .not.toContain('__modelSelectionAttachedByMain');

      database.close();
      database = new AppDatabase(databasePath);
      expect(JSON.parse(database.getWorkflowStep('step-1')?.input ?? '{}')).toEqual({
        prompt: 'completed input',
        modelSelection: trustedModelSelection(),
      });
    });

    it('does not grandfather an unmarked v7 model selection as trusted provenance', () => {
      database.upsertWorkflowStep(step({
        status: 'running',
        input: '{"prompt":"legacy running input"}',
        started_at: '2026-01-01T00:01:00.000Z',
      }));
      database.close();
      const legacy = new BetterSqlite3(databasePath);
      legacy.prepare('UPDATE workflow_steps SET input = ? WHERE id = ?').run(
        JSON.stringify({
          prompt: 'legacy running input',
          modelSelection: forgedModelSelection(),
        }),
        'step-1',
      );
      legacy.close();
      database = new AppDatabase(databasePath);

      database.upsertWorkflowStep(step({
        status: 'completed',
        input: '{"prompt":"completed after upgrade"}',
        output: '{"title":"Plan"}',
        started_at: '2026-01-01T00:01:00.000Z',
        completed_at: '2026-01-01T00:02:00.000Z',
      }));

      expect(JSON.parse(database.getWorkflowStep('step-1')?.input ?? '{}')).toEqual({
        prompt: 'completed after upgrade',
      });
    });

    it('refuses to reparent an existing deterministic step id', () => {
      database.createWorkflowStep(step());
      seedWorkflow('workflow-2', 'task-2');
      expect(() => database.upsertWorkflowStep(step({
        workflow_id: 'workflow-2',
        status: 'completed',
      }))).toThrow(/another workflow/i);
      expect(database.getWorkflowStep('step-1')?.workflow_id).toBe(WORKFLOW_ID);
    });

    it('scopes and orders workflow steps by start time then id', () => {
      seedWorkflow('workflow-2', 'task-2');
      database.createWorkflowStep(step({ id: 'step-b', started_at: '2026-01-01T00:02:00.000Z' }));
      database.createWorkflowStep(step({ id: 'step-a', started_at: '2026-01-01T00:01:00.000Z' }));
      database.createWorkflowStep(step({ id: 'other', workflow_id: 'workflow-2' }));
      expect(database.listWorkflowSteps(WORKFLOW_ID).map((row) => row.id)).toEqual(['step-a', 'step-b']);
      expect(database.countWorkflowSteps(WORKFLOW_ID)).toBe(2);
      expect(database.countWorkflowSteps('workflow-2')).toBe(1);
    });

    it('caps step pages at 100 and paginates beyond one thousand', () => {
      database.runInTransaction(() => {
        for (let index = 0; index < 1_005; index += 1) {
          database.createWorkflowStep(step({
            id: `step-${index.toString().padStart(4, '0')}`,
            started_at: new Date(Date.UTC(2027, 0, 1, 0, 0, index)).toISOString(),
          }));
        }
      });
      expect(database.listWorkflowSteps(WORKFLOW_ID)).toHaveLength(50);
      expect(database.listWorkflowSteps(WORKFLOW_ID, { limit: 999 })).toHaveLength(100);
      expect(database.listWorkflowSteps(WORKFLOW_ID, { limit: 100, offset: 1_000 })).toHaveLength(5);
    });

    it('sets a linked review step to null when the step is deleted', () => {
      database.createWorkflowStep(step({ agent_type: 'reviewer', review_round: 1 }));
      database.createReview(review({ step_id: 'step-1' }));
      expect(database.deleteWorkflowStep('step-1')).toBe(true);
      expect(database.getReview('review-1')?.step_id).toBeNull();
      expect(database.deleteWorkflowStep('step-1')).toBe(false);
    });

    it('cascades steps when their workflow is deleted', () => {
      database.createWorkflowStep(step());
      expect(database.deleteWorkflow(WORKFLOW_ID)).toBe(true);
      expect(database.getWorkflowStep('step-1')).toBeNull();
    });

    it('stores fix passes as coder steps without a special agent type', () => {
      const fix = step({
        id: `${WORKFLOW_ID}:coder:2`,
        agent_type: 'coder',
        review_round: 2,
        input: '{"reviewRound":2,"kind":"fix"}',
      });
      database.createWorkflowStep(fix);
      expect(database.getWorkflowStep(fix.id)).toEqual(fix);
    });

    it('round-trips a failed stage error without polluting structured output', () => {
      const failed = step({
        id: `${WORKFLOW_ID}:tester:2`,
        agent_type: 'tester',
        review_round: 2,
        status: 'failed',
        output: null,
        error: 'Test command exited with code 1',
      });
      database.createWorkflowStep(failed);
      expect(database.getWorkflowStep(failed.id)).toEqual(failed);
    });

    it('preserves stage rounds and errors across database restarts', () => {
      const failed = step({
        id: `${WORKFLOW_ID}:coder:3`,
        agent_type: 'coder',
        review_round: 3,
        status: 'failed',
        error: 'Fix runner interrupted',
      });
      database.createWorkflowStep(failed);
      database.close();
      database = new AppDatabase(databasePath);
      expect(database.getWorkflowStep(failed.id)).toEqual(failed);
    });
  });

  describe('review and issue rows', () => {
    it('atomically creates a review and all of its issues', () => {
      database.createReview(review(), [
        issue(),
        issue({ id: 'issue-2', severity: 'suggestion', resolved: true }),
      ]);
      expect(database.getReview('review-1')).toEqual(review());
      expect(database.listReviewIssues('review-1')).toEqual([
        issue(),
        issue({ id: 'issue-2', severity: 'suggestion', resolved: true }),
      ]);
    });

    it('atomically saves a CAS workflow snapshot with its latest review graph', () => {
      const next = workflow({
        status: 'reviewing',
        current_stage: 'reviewer',
        updated_at: '2026-01-01T01:02:00.000Z',
        metadata_json: '{"revision":1,"reviewRound":1,"currentPermissionMode":"default"}',
      });
      expect(database.saveWorkflowWithReview(
        next,
        review(),
        [issue()],
        { expectedUpdatedAt: CREATED_AT },
      )).toBe(true);
      expect(database.getWorkflow(WORKFLOW_ID)).toEqual(next);
      expect(database.getReviewWithIssues('review-1')).toEqual({
        review: review(),
        issues: [issue()],
      });
    });

    it('returns false on stale review CAS without inserting review data', () => {
      const winner = workflow({
        status: 'testing',
        current_stage: 'tester',
        updated_at: '2026-01-01T01:02:00.000Z',
      });
      expect(database.saveWorkflow(winner, { expectedUpdatedAt: CREATED_AT })).toBe(true);
      const stale = workflow({
        status: 'reviewing',
        current_stage: 'reviewer',
        updated_at: '2026-01-01T01:03:00.000Z',
      });
      expect(database.saveWorkflowWithReview(
        stale,
        review(),
        [issue()],
        { expectedUpdatedAt: CREATED_AT },
      )).toBe(false);
      expect(database.getWorkflow(WORKFLOW_ID)).toEqual(winner);
      expect(database.getReview('review-1')).toBeNull();
      expect(database.getReviewIssue('issue-1')).toBeNull();
    });

    it('rolls back the workflow CAS when review issue persistence fails', () => {
      const next = workflow({
        status: 'reviewing',
        current_stage: 'reviewer',
        updated_at: '2026-01-01T01:02:00.000Z',
      });
      expect(() => database.saveWorkflowWithReview(
        next,
        review(),
        [issue({ severity: 'blocker' })],
        { expectedUpdatedAt: CREATED_AT },
      )).toThrow(/CHECK/i);
      expect(database.getWorkflow(WORKFLOW_ID)).toEqual(workflow());
      expect(database.getReview('review-1')).toBeNull();
      expect(database.getReviewIssue('issue-1')).toBeNull();
    });

    it('idempotently retries the same deterministic review and issue ids', () => {
      const next = workflow({
        status: 'reviewing',
        current_stage: 'reviewer',
        updated_at: '2026-01-01T01:02:00.000Z',
      });
      expect(database.saveWorkflowWithReview(next, review(), [issue()])).toBe(true);
      expect(database.saveWorkflowWithReview(next, review(), [issue()])).toBe(true);
      expect(database.countReviews(WORKFLOW_ID)).toBe(1);
      expect(database.countReviewIssues('review-1')).toBe(1);
    });

    it('rejects conflicting content for a deterministic review id and rolls back the snapshot', () => {
      database.createReview(review());
      const next = workflow({
        status: 'reviewing',
        current_stage: 'reviewer',
        updated_at: '2026-01-01T01:02:00.000Z',
      });
      expect(() => database.saveWorkflowWithReview(
        next,
        review({ summary: 'Conflicting retry content' }),
        [],
        { expectedUpdatedAt: CREATED_AT },
      )).toThrow(/conflicts with an existing persisted review/i);
      expect(database.getWorkflow(WORKFLOW_ID)).toEqual(workflow());
      expect(database.getReview('review-1')).toEqual(review());
    });

    it('rejects conflicting content for a deterministic issue id and rolls back the snapshot', () => {
      const first = workflow({
        status: 'reviewing',
        current_stage: 'reviewer',
        updated_at: '2026-01-01T01:02:00.000Z',
      });
      expect(database.saveWorkflowWithReview(first, review(), [issue()])).toBe(true);
      const second = workflow({
        ...first,
        status: 'paused',
        updated_at: '2026-01-01T01:03:00.000Z',
      });
      expect(() => database.saveWorkflowWithReview(
        second,
        review(),
        [issue({ recommendation: 'Different retry content' })],
        { expectedUpdatedAt: first.updated_at },
      )).toThrow(/conflicts with an existing persisted issue/i);
      expect(database.getWorkflow(WORKFLOW_ID)).toEqual(first);
      expect(database.getReviewIssue('issue-1')).toEqual(issue());
    });

    it('rejects a review for another workflow before changing the snapshot', () => {
      const next = workflow({
        status: 'reviewing',
        current_stage: 'reviewer',
        updated_at: '2026-01-01T01:02:00.000Z',
      });
      expect(() => database.saveWorkflowWithReview(
        next,
        review({ workflow_id: 'workflow-other' }),
        [],
        { expectedUpdatedAt: CREATED_AT },
      )).toThrow(/expected workflow-1/i);
      expect(database.getWorkflow(WORKFLOW_ID)).toEqual(workflow());
      expect(database.getReview('review-1')).toBeNull();
    });

    it('supports a review with no issues', () => {
      database.createReview(review());
      expect(database.getReviewWithIssues('review-1')).toEqual({ review: review(), issues: [] });
      expect(database.getReviewWithIssues('missing')).toBeNull();
    });

    it('rejects mismatched issue ownership before writing the review', () => {
      expect(() => database.createReview(review(), [issue({ review_id: 'review-other' })]))
        .toThrow(/expected review-1/i);
      expect(database.getReview('review-1')).toBeNull();
      expect(database.getReviewIssue('issue-1')).toBeNull();
    });

    it('rolls back a review when its workflow foreign key is invalid', () => {
      expect(() => database.createReview(review({ workflow_id: 'workflow-missing' }), [issue()]))
        .toThrow(/FOREIGN KEY/i);
      expect(database.getReview('review-1')).toBeNull();
      expect(database.getReviewIssue('issue-1')).toBeNull();
    });

    it('rolls back a review when a linked step belongs to another workflow', () => {
      seedWorkflow('workflow-2', 'task-2');
      database.createWorkflowStep(step({ id: 'step-other', workflow_id: 'workflow-2' }));
      expect(() => database.createReview(review({ step_id: 'step-other' }), [issue()]))
        .toThrow(/belongs to workflow-2/i);
      expect(database.getReview('review-1')).toBeNull();
    });

    it('rolls back a review when its linked step does not exist', () => {
      expect(() => database.createReview(review({ step_id: 'step-missing' }), [issue()]))
        .toThrow(/FOREIGN KEY/i);
      expect(database.getReview('review-1')).toBeNull();
      expect(database.getReviewIssue('issue-1')).toBeNull();
    });

    it('rolls back the review if any issue insert fails', () => {
      database.createReview(review({ id: 'review-existing' }), [issue({
        review_id: 'review-existing',
      })]);
      expect(() => database.createReview(review(), [issue()])).toThrow();
      expect(database.getReview('review-1')).toBeNull();
      expect(database.getReview('review-existing')).not.toBeNull();
      expect(database.getReviewIssue('issue-1')?.review_id).toBe('review-existing');
    });

    it('enforces reviewer scores between zero and ten', () => {
      expect(() => database.createReview(review({ id: 'review-high', score: 10.1 }))).toThrow(/CHECK/i);
      expect(() => database.createReview(review({ id: 'review-low', score: -0.1 }))).toThrow(/CHECK/i);
      expect(database.countReviews(WORKFLOW_ID)).toBe(0);
    });

    it('enforces the maximum review/fix round of three', () => {
      expect(() => database.createReview(review({ id: 'review-zero', review_round: 0 }))).toThrow(/CHECK/i);
      expect(() => database.createReview(review({ review_round: 4 }))).toThrow(/CHECK/i);
      database.createReview(review({ review_round: 3 }));
      expect(database.getReview('review-1')?.review_round).toBe(3);
    });

    it('rejects issue severities outside the shared contract atomically', () => {
      expect(() => database.createReview(review(), [issue({ severity: 'blocker' })]))
        .toThrow(/CHECK/i);
      expect(database.getReview('review-1')).toBeNull();
      expect(database.getReviewIssue('issue-1')).toBeNull();
    });

    it('orders reviews by round then creation and keeps workflows isolated', () => {
      seedWorkflow('workflow-2', 'task-2');
      database.createReview(review({ id: 'review-round-1' }));
      database.createReview(review({
        id: 'review-round-2-old',
        review_round: 2,
        created_at: '2026-01-01T02:00:00.000Z',
      }));
      database.createReview(review({
        id: 'review-round-2-new',
        review_round: 2,
        created_at: '2026-01-01T03:00:00.000Z',
      }));
      database.createReview(review({ id: 'review-other', workflow_id: 'workflow-2' }));
      expect(database.listReviews(WORKFLOW_ID).map((row) => row.id)).toEqual([
        'review-round-2-new', 'review-round-2-old', 'review-round-1',
      ]);
      expect(database.countReviews(WORKFLOW_ID)).toBe(3);
      expect(database.countReviews('workflow-2')).toBe(1);
    });

    it('applies the 50/100 pagination policy to reviews', () => {
      database.runInTransaction(() => {
        for (let index = 0; index < 120; index += 1) {
          database.createReview(review({
            id: `review-${index.toString().padStart(3, '0')}`,
            review_round: (index % 3) + 1,
            created_at: new Date(Date.UTC(2027, 0, 1, 0, 0, index)).toISOString(),
          }));
        }
      });
      expect(database.listReviews(WORKFLOW_ID)).toHaveLength(50);
      expect(database.listReviews(WORKFLOW_ID, { limit: 999 })).toHaveLength(100);
      expect(database.listReviews(WORKFLOW_ID, { limit: 20, offset: 110 })).toHaveLength(10);
    });

    it('paginates more than one thousand review issues and returns booleans', () => {
      database.createReview(review());
      database.runInTransaction(() => {
        for (let index = 0; index < 1_005; index += 1) {
          database.createReviewIssue(issue({
            id: `issue-${index.toString().padStart(4, '0')}`,
            resolved: index % 2 === 0,
            created_at: new Date(Date.UTC(2027, 0, 1, 0, 0, index)).toISOString(),
          }));
        }
      });
      expect(database.listReviewIssues('review-1')).toHaveLength(50);
      expect(database.listReviewIssues('review-1', { limit: 999 })).toHaveLength(100);
      const tail = database.listReviewIssues('review-1', { limit: 100, offset: 1_000 });
      expect(tail).toHaveLength(5);
      expect(tail.every((row) => typeof row.resolved === 'boolean')).toBe(true);
      expect(database.countReviewIssues('review-1')).toBe(1_005);
      expect(database.getReviewWithIssues('review-1')?.issues).toHaveLength(1_005);
    });

    it('round-trips nullable review issue locations', () => {
      database.createReview(review(), [issue({ file_path: null, line: null })]);
      expect(database.getReviewIssue('issue-1')).toEqual(issue({ file_path: null, line: null }));
    });

    it('deleting a review cascades all of its issues', () => {
      database.createReview(review(), [issue()]);
      expect(database.deleteReview('review-1')).toBe(true);
      expect(database.getReview('review-1')).toBeNull();
      expect(database.getReviewIssue('issue-1')).toBeNull();
      expect(database.deleteReview('review-1')).toBe(false);
    });

    it('deleting a task cascades its workflow, steps, reviews, and issues', () => {
      database.createWorkflowStep(step({
        id: 'step-review',
        agent_type: 'reviewer',
        review_round: 1,
      }));
      database.createReview(review({ step_id: 'step-review' }), [issue()]);
      database.deleteSession(TASK_ID);
      expect(database.getWorkflow(WORKFLOW_ID)).toBeNull();
      expect(database.getWorkflowStep('step-review')).toBeNull();
      expect(database.getReview('review-1')).toBeNull();
      expect(database.getReviewIssue('issue-1')).toBeNull();
    });

    it('participates atomically in an outer transaction', () => {
      expect(() => database.runInTransaction(() => {
        database.createReview(review(), [issue()]);
        throw new Error('outer abort');
      })).toThrow('outer abort');
      expect(database.getReview('review-1')).toBeNull();
      expect(database.getReviewIssue('issue-1')).toBeNull();
    });
  });
});
