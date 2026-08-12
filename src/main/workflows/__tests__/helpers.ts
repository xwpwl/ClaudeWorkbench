import type {
  AgentType,
  ExecutionPlan,
  ReviewReport,
  WorkflowSnapshot,
  WorkflowStageRecord,
} from '../../../shared/types/workflow';
import type {
  ModelPolicyAgentType,
  ResolvedModelSelection,
  WorkflowModelSelectionPolicy,
} from '../../../shared/types/modelProviders';
import { AgentWorkflowManager } from '../AgentWorkflowManager';
import type {
  AgentStageRequest,
  AgentStageResult,
  AgentStageRunner,
  PersistedWorkflowSnapshot,
  WorkflowCheckpointRequest,
  WorkflowEvent,
  WorkflowPersistence,
  WorkflowPersistenceExpectation,
  WorkflowDependencies,
} from '../contracts';

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    title: 'Implement workflow orchestration',
    summary: 'Add a safe persisted multi-agent workflow.',
    steps: [
      { id: 1, title: 'Implement core', risk: 'medium' },
      { id: 2, title: 'Run tests', risk: 'low' },
    ],
    filesExpected: ['src/main/workflows/AgentWorkflowManager.ts'],
    estimatedChanges: 'About 300 lines and tests',
    riskLevel: 'medium',
    ...overrides,
  };
}

export function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    round: 1,
    score: 9,
    summary: 'Implementation is safe and tests pass.',
    issues: [],
    tests: { passed: 12, failed: 0 },
    ...overrides,
  };
}

export function resolvedSelection(
  role: ModelPolicyAgentType,
  overrides: Partial<ResolvedModelSelection> = {},
): ResolvedModelSelection {
  const value = {
    providerId: `provider-${role}`,
    providerName: `Provider ${role}`,
    modelId: `model-${role}`,
    runtimeType: 'claude-code',
    source: 'global_agent_policy',
    executionSource: 'database_provider',
    capabilities: {
      supportsClaudeCode: true,
      supportsAgentWorkflow: true,
      supportsTools: true,
      supportsMCP: true,
      supportsStreaming: true,
      supportsVision: false,
    },
    ...overrides,
  };
  if (overrides.tier) {
    return {
      ...value,
      runtimeType: 'claude-code',
      tier: overrides.tier,
      tierSource: overrides.tierSource as 'global' | 'project',
    } as ResolvedModelSelection;
  }
  const { tier: _tier, tierSource: _tierSource, ...direct } = value;
  return { ...direct, runtimeType: 'claude-code' } as ResolvedModelSelection;
}

export function modelSelectionPolicy(): WorkflowModelSelectionPolicy {
  return {
    planner: resolvedSelection('planner'),
    coder: resolvedSelection('coder'),
    tester: resolvedSelection('tester'),
    reviewer: resolvedSelection('reviewer'),
    fixer: resolvedSelection('fixer'),
  };
}

export function persistedWorkflow(
  overrides: Partial<PersistedWorkflowSnapshot> = {},
): PersistedWorkflowSnapshot {
  return {
    id: 'workflow-1',
    taskId: 'task-1',
    projectId: 'project-1',
    projectPath: 'C:/repo',
    projectKey: 'C:/repo',
    sessionKey: 'C:/repo::task-1',
    resumeSessionId: null,
    modelSelectionPolicy: null,
    executionCycle: 0,
    reviewAccepted: false,
    prompt: 'Build the workflow',
    status: 'idle',
    currentStage: null,
    activeStage: null,
    modelPolicy: {},
    currentModel: 'current-model',
    currentPermissionMode: 'default',
    plan: null,
    latestReview: null,
    reviewRound: 0,
    maxReviewRounds: 3,
    fixRound: 0,
    maxFixRounds: 3,
    revision: 0,
    pausedFrom: null,
    pauseReason: null,
    failure: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

export class MemoryWorkflowPersistence implements WorkflowPersistence {
  readonly workflows = new Map<string, PersistedWorkflowSnapshot>();
  readonly stages = new Map<string, WorkflowStageRecord>();
  readonly saves: Array<{
    workflow: PersistedWorkflowSnapshot;
    expectation: WorkflowPersistenceExpectation;
  }> = [];
  readonly reviewSaves: Array<{ workflowId: string; review: ReviewReport }> = [];
  creates = 0;
  failCreate: Error | null = null;
  failSave: Error | null = null;
  failUpsert: Error | null = null;

  getWorkflow(id: string): PersistedWorkflowSnapshot | null {
    const workflow = this.workflows.get(id);
    return workflow ? clone(workflow) : null;
  }

  createWorkflow(workflow: PersistedWorkflowSnapshot): void {
    if (this.failCreate) throw this.failCreate;
    if (this.workflows.has(workflow.id)) throw new Error('duplicate workflow');
    this.creates += 1;
    this.workflows.set(workflow.id, clone(workflow));
  }

  saveWorkflow(
    workflow: PersistedWorkflowSnapshot,
    expectation: WorkflowPersistenceExpectation,
  ): void {
    if (this.failSave) {
      const error = this.failSave;
      this.failSave = null;
      throw error;
    }
    const current = this.workflows.get(workflow.id);
    if (!current
      || current.revision !== expectation.expectedRevision
      || current.updatedAt !== expectation.expectedUpdatedAt) {
      throw new Error('CAS conflict');
    }
    this.saves.push({ workflow: clone(workflow), expectation: { ...expectation } });
    this.workflows.set(workflow.id, clone(workflow));
  }

  saveWorkflowWithReview(
    workflow: PersistedWorkflowSnapshot,
    review: ReviewReport,
    expectation: WorkflowPersistenceExpectation,
  ): void {
    this.reviewSaves.push({ workflowId: workflow.id, review: clone(review) });
    this.saveWorkflow(workflow, expectation);
  }

  listStageRecords(workflowId: string): readonly WorkflowStageRecord[] {
    return [...this.stages.values()]
      .filter((stage) => stage.workflowId === workflowId)
      .map(clone);
  }

  upsertStageRecord(record: WorkflowStageRecord): void {
    if (this.failUpsert) {
      const error = this.failUpsert;
      this.failUpsert = null;
      throw error;
    }
    this.stages.set(record.id, clone(record));
  }
}

type ScriptValue = unknown | Error | ((request: AgentStageRequest) => unknown | Promise<unknown>);

export class ScriptedRunner implements AgentStageRunner {
  readonly requests: AgentStageRequest[] = [];
  readonly scripts: Record<AgentType, ScriptValue[]> = {
    planner: [],
    coder: [],
    tester: [],
    reviewer: [],
  };

  push(stage: AgentType, ...values: ScriptValue[]): this {
    this.scripts[stage].push(...values);
    return this;
  }

  async runStage(request: AgentStageRequest): Promise<AgentStageResult> {
    this.requests.push(clone(request));
    const scripted = this.scripts[request.stage].shift();
    if (scripted instanceof Error) throw scripted;
    let value = typeof scripted === 'function' ? await scripted(request) : scripted;
    if (value === undefined) value = this.defaultOutput(request.stage, request.reviewRound);
    if (value && typeof value === 'object' && 'output' in value && 'runId' in value) {
      return value as AgentStageResult;
    }
    return { output: value, runId: `${request.operationId}:run` };
  }

  private defaultOutput(stage: AgentType, round: number): unknown {
    if (stage === 'planner') return plan();
    if (stage === 'coder') {
      return { summary: 'Implemented the plan', filesChanged: ['src/app.ts'], testsSuggested: ['npm test'] };
    }
    if (stage === 'tester') {
      return { summary: 'Tests passed', passed: 12, failed: 0, skipped: 0, commands: ['npm test'] };
    }
    return report({ round });
  }
}

export interface ManagerFixture {
  manager: AgentWorkflowManager;
  persistence: MemoryWorkflowPersistence;
  runner: ScriptedRunner;
  checkpoints: WorkflowCheckpointRequest[];
  events: WorkflowEvent[];
  permissionCompletions: Array<{
    taskId: string;
    workflowId?: string;
    projectPath: string;
  }>;
}

export function managerFixture(options: {
  failCheckpointAt?: WorkflowCheckpointRequest['boundary'];
  modelSelections?: WorkflowDependencies['modelSelections'];
} = {}): ManagerFixture {
  const persistence = new MemoryWorkflowPersistence();
  const runner = new ScriptedRunner();
  const checkpoints: WorkflowCheckpointRequest[] = [];
  const events: WorkflowEvent[] = [];
  const permissionCompletions: ManagerFixture['permissionCompletions'] = [];
  let uuid = 0;
  const manager = new AgentWorkflowManager({
    persistence,
    runner,
    git: {
      readContext: () => ({
        kind: 'repository',
        head: 'a'.repeat(40),
        branch: 'main',
        files: [{ filePath: 'src/app.ts', changeType: 'modified', staged: false }],
      }),
    },
    checkpoints: {
      createCheckpoint: (request) => {
        checkpoints.push(clone(request));
        if (request.boundary === options.failCheckpointAt) {
          throw new Error(`checkpoint failed at ${request.boundary}`);
        }
      },
    },
    events: { publish: (event) => { events.push(clone(event)); } },
    permissionLifecycle: {
      completeTask: (identity) => { permissionCompletions.push(clone(identity)); },
    },
    ...(options.modelSelections ? { modelSelections: options.modelSelections } : {}),
    now: () => new Date('2026-08-01T00:00:00.000Z'),
    randomUUID: () => `workflow-${++uuid}`,
  });
  return { manager, persistence, runner, checkpoints, events, permissionCompletions };
}

export async function createIdle(fixture: ManagerFixture, id = 'workflow-1'): Promise<WorkflowSnapshot> {
  return fixture.manager.createWorkflow({
    id,
    taskId: 'task-1',
    projectId: 'project-1',
    projectPath: 'C:/repo',
    prompt: 'Build a safe multi-agent workflow',
    currentModel: 'current-model',
    currentPermissionMode: 'default',
  });
}

export async function createWaiting(fixture: ManagerFixture, id = 'workflow-1'): Promise<WorkflowSnapshot> {
  await createIdle(fixture, id);
  return fixture.manager.startPlanning(id);
}
