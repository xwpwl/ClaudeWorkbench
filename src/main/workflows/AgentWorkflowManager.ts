import crypto from 'node:crypto';
import type {
  AgentModelPolicy,
  AgentType,
  ExecutionPlan,
  WorkflowSnapshot,
  WorkflowStageRecord,
  WorkflowStatus,
} from '../../shared/types/workflow';
import type { ResolvedModelSelection } from '../../shared/types/modelProviders';
import { AGENT_MODEL_RECONFIGURATION_MESSAGE } from '../../shared/types/modelProviders';
import { MAX_WORKFLOW_REVIEW_ROUNDS } from '../../shared/types/workflow';
import { normalizeAgentModelPolicy, resolveAgentModel } from './AgentModelPolicy';
import type {
  AgentStageInput,
  CoderStageInput,
  CreateWorkflowInput,
  PersistedWorkflowSnapshot,
  ResumeWorkflowOptions,
  TesterStageInput,
  WorkflowDependencies,
  WorkflowCheckpointBoundary,
  WorkflowEvent,
  WorkflowGitContext,
  WorkflowStatusChange,
} from './contracts';
import {
  NOOP_CHECKPOINT_GATEWAY,
  NOOP_EVENT_GATEWAY,
  NOOP_GIT_GATEWAY,
} from './contracts';
import { PlannerAgent } from './PlannerAgent';
import { ReviewerAgent, reviewRequiresFix } from './ReviewerAgent';
import {
  parseCoderStageOutput,
  parseExecutionPlan,
  parseReviewReport,
  parseTesterStageOutput,
  StructuredOutputError,
} from './StructuredJsonParser';

const TERMINAL_STATUSES = new Set<WorkflowStatus>(['completed', 'failed', 'cancelled']);
const RESERVED_RAW_KEYS = new Set([
  'raw',
  'rawAssistant',
  'raw_assistant',
  'system',
  'systemPrompt',
  'system_prompt',
  'transcript',
  'messages',
]);
const CLI_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);

export const WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
  idle: ['planning', 'paused', 'cancelled', 'failed'],
  planning: ['waiting_plan_confirmation', 'paused', 'failed', 'cancelled'],
  waiting_plan_confirmation: ['planning', 'executing', 'paused', 'failed', 'cancelled'],
  executing: ['testing', 'paused', 'failed', 'cancelled'],
  testing: ['reviewing', 'paused', 'failed', 'cancelled'],
  reviewing: ['executing', 'completed', 'paused', 'failed', 'cancelled'],
  paused: [
    'idle',
    'planning',
    'waiting_plan_confirmation',
    'executing',
    'testing',
    'reviewing',
    'completed',
    'failed',
    'cancelled',
  ],
  completed: [],
  failed: [],
  cancelled: [],
};

export type WorkflowErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_TRANSITION'
  | 'PLAN_REQUIRED'
  | 'READ_ONLY_PERMISSION'
  | 'PERSISTENCE_CONFLICT'
  | 'USER_ACTION_REQUIRED';

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly code: WorkflowErrorCode,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

class WorkflowGitContextError extends Error {
  constructor() {
    super('Workflow Git context is unavailable.');
    this.name = 'WorkflowGitContextError';
  }
}

class WorkflowCheckpointError extends Error {
  constructor() {
    super('Workflow checkpoint is unavailable.');
    this.name = 'WorkflowCheckpointError';
  }
}

function isTerminal(status: WorkflowStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}

function assertText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new WorkflowError(`${label} is required.`, 'INVALID_INPUT');
  return normalized;
}

function sanitizeJson(_key: string, value: unknown): unknown {
  if (RESERVED_RAW_KEYS.has(_key)) return undefined;
  return value;
}

function structuredJson(value: unknown): string {
  const json = JSON.stringify(value, sanitizeJson);
  if (json === undefined) throw new WorkflowError('Structured stage data is required.', 'INVALID_INPUT');
  return json;
}

function cloneStructured<T>(value: T): T {
  return JSON.parse(structuredJson(value)) as T;
}

function monotonicTimestamp(now: Date, previous?: string): string {
  const candidate = now.toISOString();
  if (!previous || candidate > previous) return candidate;
  return new Date(new Date(previous).getTime() + 1).toISOString();
}

function stageRecordId(
  workflowId: string,
  executionCycle: number,
  stage: AgentType,
  round: number,
): string {
  return `${workflowId}:${executionCycle}:${stage}:${round}`;
}

function stageFailure(error: unknown): { code: string; message: string } {
  if (error instanceof StructuredOutputError) {
    return { code: error.code, message: 'Agent returned invalid structured output.' };
  }
  if (error instanceof WorkflowError) return { code: error.code, message: error.message };
  if (isRuntimePreflightFailure(error)) {
    return {
      code: (error as { code: string }).code,
      message: AGENT_MODEL_RECONFIGURATION_MESSAGE,
    };
  }
  return { code: 'AGENT_STAGE_FAILED', message: 'Agent stage failed.' };
}

function isRuntimePreflightFailure(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : null;
  return code === 'RUNTIME_INCOMPATIBLE'
    || code === 'WORKFLOW_CAPABILITY_MISSING'
    || code === 'PROVIDER_DELETED'
    || code === 'PROVIDER_DISABLED'
    || code === 'PROVIDER_UNCONFIGURED'
    || code === 'CONNECTION_UNAVAILABLE'
    || code === 'MODEL_MISSING'
    || code === 'SOURCE_CHANGED'
    || code === 'CLAUDE_CLI_UNAVAILABLE'
    || code === 'SELECTION_UNAVAILABLE';
}

function publicSnapshot(workflow: PersistedWorkflowSnapshot): WorkflowSnapshot {
  const {
    currentModel: _currentModel,
    currentPermissionMode: _currentPermissionMode,
    projectKey: _projectKey,
    sessionKey: _sessionKey,
    resumeSessionId: _resumeSessionId,
    modelSelectionPolicy: _modelSelectionPolicy,
    executionCycle: _executionCycle,
    reviewAccepted: _reviewAccepted,
    pauseReason: _pauseReason,
    ...snapshot
  } = workflow;
  return cloneStructured(snapshot);
}

function safeModelSelectionEvent(
  selection: ResolvedModelSelection | undefined,
): Record<string, unknown> | undefined {
  if (!selection) return undefined;
  return {
    providerId: selection.providerId,
    providerName: selection.providerName,
    modelId: selection.modelId,
    runtimeType: selection.runtimeType,
    source: selection.source,
    executionSource: selection.executionSource,
    ...(selection.tier ? { tier: selection.tier, tierSource: selection.tierSource } : {}),
  };
}

export class AgentWorkflowManager {
  private readonly planner: PlannerAgent;
  private readonly reviewer: ReviewerAgent;
  private readonly checkpoints;
  private readonly git;
  private readonly events;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly controlIntents = new Map<string, {
    type: 'pause' | 'cancel';
    reason: string | null;
  }>();

  constructor(private readonly dependencies: WorkflowDependencies) {
    this.planner = new PlannerAgent(dependencies.runner);
    this.reviewer = new ReviewerAgent(dependencies.runner);
    this.checkpoints = dependencies.checkpoints ?? NOOP_CHECKPOINT_GATEWAY;
    this.git = dependencies.git ?? NOOP_GIT_GATEWAY;
    this.events = dependencies.events ?? NOOP_EVENT_GATEWAY;
    this.now = dependencies.now ?? (() => new Date());
    this.randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  }

  async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowSnapshot> {
    const id = input.id?.trim() || this.randomUUID();
    return this.enqueue(id, async () => {
      const existing = await this.dependencies.persistence.getWorkflow(id);
      if (existing) return publicSnapshot(existing);
      const createdAt = this.now().toISOString();
      const maxFixRounds = input.maxFixRounds ?? MAX_WORKFLOW_REVIEW_ROUNDS;
      if (!Number.isInteger(maxFixRounds) || maxFixRounds < 1 || maxFixRounds > 3) {
        throw new WorkflowError('maxFixRounds must be an integer from 1 to 3.', 'INVALID_INPUT');
      }
      if (!CLI_PERMISSION_MODES.has(input.currentPermissionMode)) {
        throw new WorkflowError('A valid currentPermissionMode is required.', 'INVALID_INPUT');
      }
      const taskId = assertText(input.taskId, 'taskId');
      const projectId = assertText(input.projectId, 'projectId');
      const projectPath = assertText(input.projectPath, 'projectPath');
      const modelPolicy = normalizeAgentModelPolicy(input.modelPolicy);
      const currentModel = input.currentModel?.trim() || null;
      const modelSelectionPolicy = await this.dependencies.modelSelections
        ?.snapshotWorkflowPolicy({
          taskId,
          projectId,
          fallbackModelIds: {
            planner: resolveAgentModel(modelPolicy, 'planner', currentModel),
            coder: resolveAgentModel(modelPolicy, 'coder', currentModel),
            tester: resolveAgentModel(modelPolicy, 'tester', currentModel),
            reviewer: resolveAgentModel(modelPolicy, 'reviewer', currentModel),
            fixer: resolveAgentModel(modelPolicy, 'coder', currentModel, true),
          },
        }) ?? null;
      const workflow: PersistedWorkflowSnapshot = {
        id,
        taskId,
        projectId,
        projectPath,
        projectKey: input.projectKey?.trim() || projectPath,
        sessionKey: input.sessionKey?.trim()
          || `${projectPath}::${taskId}`,
        // A pre-existing Claude session has no persisted Provider binding. New
        // pinned workflows therefore start fresh and carry context structurally.
        resumeSessionId: modelSelectionPolicy ? null : input.resumeSessionId?.trim() || null,
        modelSelectionPolicy,
        executionCycle: 0,
        reviewAccepted: false,
        prompt: assertText(input.prompt, 'prompt'),
        status: 'idle',
        currentStage: null,
        activeStage: null,
        modelPolicy,
        plan: null,
        latestReview: null,
        reviewRound: 0,
        maxReviewRounds: maxFixRounds,
        fixRound: 0,
        maxFixRounds,
        revision: 0,
        pausedFrom: null,
        pauseReason: null,
        failure: null,
        currentModel,
        currentPermissionMode: input.currentPermissionMode,
        createdAt,
        updatedAt: createdAt,
      };
      await this.dependencies.persistence.createWorkflow(workflow);
      await this.publish(workflow, 'workflow_created', 'create', {});
      return publicSnapshot(workflow);
    });
  }

  async getWorkflow(workflowId: string): Promise<WorkflowSnapshot | null> {
    const workflow = await this.dependencies.persistence.getWorkflow(workflowId);
    return workflow ? publicSnapshot(workflow) : null;
  }

  async startPlanning(workflowId: string, feedback: string | null = null): Promise<WorkflowSnapshot> {
    return this.enqueue(workflowId, async () => {
      let workflow = await this.requireWorkflow(workflowId);
      if (workflow.status === 'waiting_plan_confirmation' && feedback?.trim()) {
        workflow = await this.transition(workflow, 'planning', {
          currentStage: 'planner',
          activeStage: 'planner',
          failure: null,
        });
      } else if (workflow.status === 'idle') {
        workflow = await this.transition(workflow, 'planning', {
          currentStage: 'planner',
          activeStage: 'planner',
          failure: null,
        });
      } else if (workflow.status === 'waiting_plan_confirmation' && !feedback?.trim()) {
        return publicSnapshot(workflow);
      } else if (workflow.status !== 'planning') {
        throw this.invalidTransition(workflow.status, 'planning');
      }
      workflow = await this.runPlanning(workflow, feedback);
      return publicSnapshot(workflow);
    });
  }

  async updatePlan(workflowId: string, plan: ExecutionPlan): Promise<WorkflowSnapshot> {
    return this.enqueue(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      if (workflow.status !== 'waiting_plan_confirmation') {
        throw new WorkflowError('Plans can only be modified while awaiting confirmation.', 'INVALID_TRANSITION');
      }
      const next = await this.save(workflow, { plan: parseExecutionPlan(plan), failure: null });
      await this.publish(next, 'workflow_plan_updated', `plan:${next.revision}`, {
        title: next.plan?.title,
        stepCount: next.plan?.steps.length,
      });
      return publicSnapshot(next);
    });
  }

  async updateModelPolicy(
    workflowId: string,
    policy: AgentModelPolicy,
  ): Promise<WorkflowSnapshot> {
    return this.enqueue(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      if (!['idle', 'waiting_plan_confirmation', 'paused'].includes(workflow.status)) {
        throw new WorkflowError('Model policy cannot change while an agent stage is running.', 'INVALID_TRANSITION');
      }
      return publicSnapshot(await this.save(workflow, {
        modelPolicy: normalizeAgentModelPolicy(policy),
      }));
    });
  }

  async confirmPlan(workflowId: string): Promise<WorkflowSnapshot> {
    return this.enqueue(workflowId, async () => {
      let workflow = await this.requireWorkflow(workflowId);
      if (isTerminal(workflow.status)) return publicSnapshot(workflow);
      if (workflow.status !== 'waiting_plan_confirmation') {
        throw new WorkflowError('Workflow is not waiting for plan confirmation.', 'INVALID_TRANSITION');
      }
      if (!workflow.plan) throw new WorkflowError('A valid plan is required.', 'PLAN_REQUIRED');
      if (workflow.currentPermissionMode === 'plan') {
        throw new WorkflowError(
          'Execution is disabled while the task permission mode is plan.',
          'READ_ONLY_PERMISSION',
        );
      }
      workflow = await this.transition(workflow, 'executing', {
        currentStage: 'coder',
        activeStage: 'coder',
        reviewRound: 1,
        fixRound: 1,
        latestReview: null,
        executionCycle: workflow.executionCycle + 1,
        reviewAccepted: false,
        pausedFrom: null,
        pauseReason: null,
        failure: null,
      });
      workflow = await this.drive(workflow);
      return publicSnapshot(workflow);
    });
  }

  /** Original Phase 6 API name: confirmation is the only safe execution entrypoint. */
  startExecution(workflowId: string): Promise<WorkflowSnapshot> {
    return this.confirmPlan(workflowId);
  }

  /** Explicitly accepts unresolved findings after the three-round safety cap. */
  async acceptReview(workflowId: string): Promise<WorkflowSnapshot> {
    return this.enqueue(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      if (workflow.status === 'completed' && workflow.reviewAccepted) {
        await this.finalizeTerminal(workflow);
        return publicSnapshot(workflow);
      }
      if (
        workflow.status !== 'paused'
        || workflow.pauseReason !== 'fix_loop_limit'
        || !workflow.latestReview
      ) {
        throw new WorkflowError(
          'Only a fix-limit review can be explicitly accepted.',
          'USER_ACTION_REQUIRED',
        );
      }
      const terminal = await this.transition(workflow, 'completed', {
        currentStage: null,
        activeStage: null,
        pausedFrom: null,
        pauseReason: null,
        reviewAccepted: true,
        failure: null,
      });
      await this.publish(terminal, 'workflow_review_accepted', 'review-accepted', {
        reviewRound: terminal.reviewRound,
        score: terminal.latestReview?.score,
        issueCount: terminal.latestReview?.issues.length,
      });
      await this.finalizeTerminal(terminal);
      return publicSnapshot(terminal);
    });
  }

  /** Continues a persisted reviewing stage without permitting the test stage to be skipped. */
  async startReview(workflowId: string): Promise<WorkflowSnapshot> {
    return this.enqueue(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      if (isTerminal(workflow.status)) return publicSnapshot(workflow);
      if (workflow.status !== 'reviewing') {
        throw new WorkflowError('Workflow is not ready for review.', 'INVALID_TRANSITION');
      }
      return publicSnapshot(await this.drive(workflow));
    });
  }

  async resumeWorkflow(
    workflowId: string,
    options: ResumeWorkflowOptions = {},
  ): Promise<WorkflowSnapshot> {
    return this.enqueue(workflowId, async () => {
      let workflow = await this.requireWorkflow(workflowId);
      if (isTerminal(workflow.status) || workflow.status === 'waiting_plan_confirmation') {
        return publicSnapshot(workflow);
      }
      if (workflow.status === 'idle') {
        workflow = await this.transition(workflow, 'planning', {
          currentStage: 'planner',
          activeStage: 'planner',
        });
      } else if (workflow.status === 'paused') {
        if (workflow.pauseReason === 'fix_loop_limit') {
          if (!options.allowAfterFixLimit) return publicSnapshot(workflow);
          workflow = await this.transition(workflow, 'waiting_plan_confirmation', {
            currentStage: null,
            activeStage: null,
            pausedFrom: null,
            pauseReason: null,
            reviewRound: 0,
            fixRound: 0,
          });
          return publicSnapshot(workflow);
        }
        const resumeStatus = workflow.pausedFrom;
        if (!resumeStatus || isTerminal(resumeStatus)) {
          throw new WorkflowError('Paused workflow has no recoverable stage.', 'INVALID_TRANSITION');
        }
        workflow = await this.transition(workflow, resumeStatus, {
          currentStage: this.stageForStatus(resumeStatus),
          activeStage: this.stageForStatus(resumeStatus),
          pausedFrom: null,
          pauseReason: null,
        });
      }
      if (workflow.status === 'planning') workflow = await this.runPlanning(workflow, null);
      else workflow = await this.drive(workflow);
      return publicSnapshot(workflow);
    });
  }

  async pauseWorkflow(workflowId: string, reason = 'user_paused'): Promise<WorkflowSnapshot> {
    const existing = this.controlIntents.get(workflowId);
    if (existing?.type !== 'cancel') {
      this.controlIntents.set(workflowId, {
        type: 'pause',
        reason: reason.trim() || 'user_paused',
      });
    }
    return this.enqueue(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      return publicSnapshot(await this.applyControlIntent(workflow));
    });
  }

  pause(workflowId: string, reason?: string): Promise<WorkflowSnapshot> {
    return this.pauseWorkflow(workflowId, reason);
  }

  async cancelWorkflow(workflowId: string): Promise<WorkflowSnapshot> {
    this.controlIntents.set(workflowId, { type: 'cancel', reason: null });
    return this.enqueue(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      return publicSnapshot(await this.applyControlIntent(workflow));
    });
  }

  resume(workflowId: string, options?: ResumeWorkflowOptions): Promise<WorkflowSnapshot> {
    return this.resumeWorkflow(workflowId, options);
  }

  cancel(workflowId: string): Promise<WorkflowSnapshot> {
    return this.cancelWorkflow(workflowId);
  }

  /** Resumes any persisted in-flight stage, reusing its deterministic operation id. */
  async recoverWorkflow(workflowId: string): Promise<WorkflowSnapshot> {
    return this.resumeWorkflow(workflowId);
  }

  private async runPlanning(
    workflow: PersistedWorkflowSnapshot,
    feedback: string | null,
  ): Promise<PersistedWorkflowSnapshot> {
    // SQLite reserves review_round=0 for Planner records. Use the persisted
    // workflow revision as the stage-id cycle so feedback-driven replans stay
    // idempotent without violating that invariant.
    const round = 0;
    const stageWorkflow: PersistedWorkflowSnapshot = {
      ...workflow,
      executionCycle: workflow.revision,
    };
    let planningGitKind: WorkflowGitContext['kind'] | null = null;
    try {
      const git = await this.readGit(workflow.projectPath, true);
      planningGitKind = git.kind;
      const input: AgentStageInput = {
        kind: 'planner',
        goal: workflow.prompt,
        projectPath: workflow.projectPath,
        git,
        previousPlan: workflow.plan,
        feedback: feedback?.trim() || null,
      };
      const plan = await this.runStage(
        stageWorkflow,
        'planner',
        round,
        input,
        (operationId) => this.planner.run({
          workflow: stageWorkflow,
          git,
          operationId,
          feedback,
          modelSelection: this.pinnedSelection(stageWorkflow, 'planner'),
        }),
        parseExecutionPlan,
        git.kind === 'not_repository'
          ? {}
          : { before: 'before_plan', after: 'after_plan' },
      );
      let next = await this.save(workflow, { plan, failure: null });
      await this.publish(next, 'workflow_plan_ready', `plan-ready:${round}`, {
        title: plan.title,
        stepCount: plan.steps.length,
        riskLevel: plan.riskLevel,
      });
      next = await this.applyControlIntent(next);
      if (next.status !== 'planning') return next;
      next = await this.transition(next, 'waiting_plan_confirmation', {
        currentStage: null,
        activeStage: null,
      });
      return next;
    } catch (error) {
      return this.failWorkflowStage(
        workflow,
        'planner',
        error,
        planningGitKind === 'not_repository' || isRuntimePreflightFailure(error),
      );
    }
  }

  private async drive(initial: PersistedWorkflowSnapshot): Promise<PersistedWorkflowSnapshot> {
    let workflow = initial;
    while (['executing', 'testing', 'reviewing'].includes(workflow.status)) {
      try {
        workflow = await this.applyControlIntent(workflow);
        if (!['executing', 'testing', 'reviewing'].includes(workflow.status)) break;
        if (workflow.status === 'executing') workflow = await this.runCoder(workflow);
        else if (workflow.status === 'testing') workflow = await this.runTester(workflow);
        else workflow = await this.runReviewer(workflow);
      } catch (error) {
        if (error instanceof WorkflowCheckpointError) {
          const persisted = await this.requireWorkflow(workflow.id);
          if (isTerminal(persisted.status)) throw error;
        }
        const stage = this.stageForStatus(workflow.status);
        workflow = await this.failWorkflowStage(
          workflow,
          stage,
          error,
          isRuntimePreflightFailure(error),
        );
      }
    }
    return workflow;
  }

  private async runCoder(workflow: PersistedWorkflowSnapshot): Promise<PersistedWorkflowSnapshot> {
    if (!workflow.plan) throw new WorkflowError('Coder requires a confirmed plan.', 'PLAN_REQUIRED');
    const git = await this.readGit(workflow.projectPath);
    const input: CoderStageInput = {
      kind: 'coder',
      goal: workflow.prompt,
      projectPath: workflow.projectPath,
      plan: workflow.plan,
      review: workflow.latestReview,
      git,
      fixRound: workflow.fixRound,
    };
    await this.runStage(
      workflow,
      'coder',
      workflow.reviewRound,
      input,
      async (operationId) => {
        const modelSelection = this.pinnedSelection(workflow, 'coder');
        const result = await this.dependencies.runner.runStage({
          operationId,
          workflowId: workflow.id,
          taskId: workflow.taskId,
          projectId: workflow.projectId,
          projectPath: workflow.projectPath,
          projectKey: workflow.projectKey,
          sessionKey: workflow.sessionKey,
          ...(workflow.resumeSessionId && !workflow.modelSelectionPolicy
            ? { resumeSessionId: workflow.resumeSessionId }
            : {}),
          stage: 'coder',
          agentType: 'coder',
          agentMode: 'normal',
          permissionMode: workflow.currentPermissionMode,
          model: modelSelection?.modelId ?? resolveAgentModel(
            workflow.modelPolicy, 'coder', workflow.currentModel, workflow.fixRound > 1,
          ),
          ...(modelSelection ? { modelSelection } : {}),
          prompt: workflow.prompt,
          systemPrompt: 'Implement the confirmed ExecutionPlan. Return only structured coder-result JSON.',
          reviewRound: workflow.reviewRound,
          workflowContext: {
            workflowId: workflow.id,
            stage: 'coder',
            reviewRound: workflow.reviewRound,
          },
          input,
        });
        const parsed = parseCoderStageOutput(result.output);
        return {
          ...parsed,
          filesChanged: result.modifiedFiles
            ? [...new Set(result.modifiedFiles.map((file) => file.trim()).filter(Boolean))].sort()
            : parsed.filesChanged,
        };
      },
      parseCoderStageOutput,
      workflow.fixRound > 1
        ? { before: 'before_fix', after: 'after_fix' }
        : { before: 'before_execute', after: 'after_execute' },
    );
    return this.transition(workflow, 'testing', {
      currentStage: 'tester',
      activeStage: 'tester',
    });
  }

  private async runTester(workflow: PersistedWorkflowSnapshot): Promise<PersistedWorkflowSnapshot> {
    if (!workflow.plan) throw new WorkflowError('Tester requires a confirmed plan.', 'PLAN_REQUIRED');
    const coder = await this.completedStageOutput(
      workflow,
      'coder',
      workflow.reviewRound,
      parseCoderStageOutput,
    );
    const git = await this.readGit(workflow.projectPath);
    const input: TesterStageInput = {
      kind: 'tester',
      goal: workflow.prompt,
      projectPath: workflow.projectPath,
      plan: workflow.plan,
      coder,
      git,
      fixRound: workflow.fixRound,
    };
    await this.runStage(
      workflow,
      'tester',
      workflow.reviewRound,
      input,
      async (operationId) => {
        const modelSelection = this.pinnedSelection(workflow, 'tester');
        const result = await this.dependencies.runner.runStage({
          operationId,
          workflowId: workflow.id,
          taskId: workflow.taskId,
          projectId: workflow.projectId,
          projectPath: workflow.projectPath,
          projectKey: workflow.projectKey,
          sessionKey: workflow.sessionKey,
          ...(workflow.resumeSessionId && !workflow.modelSelectionPolicy
            ? { resumeSessionId: workflow.resumeSessionId }
            : {}),
          stage: 'tester',
          agentType: 'tester',
          agentMode: 'normal',
          permissionMode: workflow.currentPermissionMode,
          model: modelSelection?.modelId
            ?? resolveAgentModel(workflow.modelPolicy, 'tester', workflow.currentModel),
          ...(modelSelection ? { modelSelection } : {}),
          prompt: workflow.prompt,
          systemPrompt: 'Run the relevant tests and report results. Return only structured tester-result JSON.',
          reviewRound: workflow.reviewRound,
          workflowContext: {
            workflowId: workflow.id,
            stage: 'tester',
            reviewRound: workflow.reviewRound,
          },
          input,
        });
        const parsed = parseTesterStageOutput(result.output);
        return result.tests ? {
          ...parsed,
          passed: result.tests.passed,
          failed: result.tests.failed,
          skipped: result.tests.skipped ?? 0,
        } : parsed;
      },
      parseTesterStageOutput,
      {},
    );
    return this.transition(workflow, 'reviewing', {
      currentStage: 'reviewer',
      activeStage: 'reviewer',
    });
  }

  private async runReviewer(workflow: PersistedWorkflowSnapshot): Promise<PersistedWorkflowSnapshot> {
    const [coder, tests, git] = await Promise.all([
      this.completedStageOutput(workflow, 'coder', workflow.reviewRound, parseCoderStageOutput),
      this.completedStageOutput(workflow, 'tester', workflow.reviewRound, parseTesterStageOutput),
      this.readGit(workflow.projectPath),
    ]);
    if (!workflow.plan) throw new WorkflowError('Reviewer requires a confirmed plan.', 'PLAN_REQUIRED');
    const input: AgentStageInput = {
      kind: 'reviewer',
      goal: workflow.prompt,
      projectPath: workflow.projectPath,
      plan: workflow.plan,
      coder,
      tests,
      git,
      reviewRound: workflow.reviewRound,
    };
    const report = await this.runStage(
      workflow,
      'reviewer',
      workflow.reviewRound,
      input,
      (operationId) => this.reviewer.run({
        workflow,
        git,
        coder,
        tests,
        operationId,
        reviewRound: workflow.reviewRound,
        modelSelection: this.pinnedSelection(workflow, 'reviewer'),
      }),
      (value) => parseReviewReport(value, workflow.reviewRound),
      { before: 'before_review' },
    );
    workflow = await this.save(workflow, { latestReview: report });
    workflow = await this.applyControlIntent(workflow);
    if (workflow.status !== 'reviewing') return workflow;

    if (!reviewRequiresFix(report)) {
      const terminal = await this.transition(workflow, 'completed', {
        currentStage: null,
        activeStage: null,
        failure: null,
      });
      await this.finalizeTerminal(terminal);
      return terminal;
    }
    if (workflow.reviewRound >= workflow.maxFixRounds) {
      const paused = await this.transition(workflow, 'paused', {
        currentStage: null,
        activeStage: null,
        pausedFrom: 'reviewing',
        pauseReason: 'fix_loop_limit',
      });
      await this.publish(paused, 'workflow_user_action_required', 'fix-limit', {
        reason: 'fix_loop_limit',
        rounds: workflow.reviewRound,
        score: report.score,
        issueCount: report.issues.length,
      });
      return paused;
    }

    const next = await this.transition(workflow, 'executing', {
      currentStage: 'coder',
      activeStage: 'coder',
      reviewRound: workflow.reviewRound + 1,
      fixRound: workflow.fixRound + 1,
    });
    await this.publish(next, 'workflow_fix_loop_started', `fix:${next.reviewRound}`, {
      reviewRound: next.reviewRound,
      issueCount: report.issues.length,
      score: report.score,
    });
    return next;
  }

  private async runStage<T>(
    workflow: PersistedWorkflowSnapshot,
    stage: AgentType,
    round: number,
    input: AgentStageInput,
    invoke: (operationId: string) => Promise<T>,
    parsePersisted: (value: unknown) => T,
    checkpointBoundaries: {
      before?: WorkflowCheckpointBoundary;
      after?: WorkflowCheckpointBoundary;
    },
  ): Promise<T> {
    const id = stageRecordId(workflow.id, workflow.executionCycle, stage, round);
    const existing = (await this.dependencies.persistence.listStageRecords(workflow.id))
      .find((record) => record.id === id);
    if (existing?.status === 'completed' && existing.outputJson !== null) {
      const value = parsePersisted(JSON.parse(existing.outputJson) as unknown);
      if (checkpointBoundaries.after) {
        await this.checkpoint(
          workflow,
          stage,
          round,
          checkpointBoundaries.after,
          `${id}:${checkpointBoundaries.after}`,
        );
      }
      return value;
    }

    await this.revalidateStageModel(workflow, stage);
    const startedAt = existing?.startedAt ?? this.now().toISOString();
    const running: WorkflowStageRecord = {
      id,
      workflowId: workflow.id,
      stage,
      round,
      status: 'running',
      inputJson: structuredJson(input),
      outputJson: null,
      error: null,
      startedAt,
      completedAt: null,
    };
    await this.dependencies.persistence.upsertStageRecord(running);
    const modelSelection = safeModelSelectionEvent(this.pinnedSelection(workflow, stage));
    await this.publish(workflow, 'workflow_stage_started', `stage-start:${id}`, {
      stage,
      round,
      ...(modelSelection ? { modelSelection } : {}),
    });
    if (checkpointBoundaries.before) {
      await this.checkpoint(
        workflow,
        stage,
        round,
        checkpointBoundaries.before,
        `${id}:${checkpointBoundaries.before}`,
      );
    }

    let completedPersisted = false;
    try {
      const output = parsePersisted(await invoke(id));
      const completed: WorkflowStageRecord = {
        ...running,
        status: 'completed',
        outputJson: structuredJson(output),
        completedAt: this.now().toISOString(),
      };
      await this.dependencies.persistence.upsertStageRecord(completed);
      completedPersisted = true;
      await this.publish(workflow, 'workflow_stage_completed', `stage-complete:${id}`, {
        stage,
        round,
      });
      if (checkpointBoundaries.after) {
        await this.checkpoint(
          workflow,
          stage,
          round,
          checkpointBoundaries.after,
          `${id}:${checkpointBoundaries.after}`,
        );
      }
      return output;
    } catch (error) {
      if (!completedPersisted) {
        const failure = stageFailure(error);
        await this.dependencies.persistence.upsertStageRecord({
          ...running,
          status: 'failed',
          error: failure.code,
          completedAt: this.now().toISOString(),
        });
      }
      throw error;
    }
  }

  private async completedStageOutput<T>(
    workflow: PersistedWorkflowSnapshot,
    stage: AgentType,
    round: number,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const id = stageRecordId(workflow.id, workflow.executionCycle, stage, round);
    const record = (await this.dependencies.persistence.listStageRecords(workflow.id))
      .find((candidate) => candidate.id === id);
    if (!record || record.status !== 'completed' || record.outputJson === null) {
      throw new WorkflowError(`Completed ${stage} stage is missing.`, 'INVALID_TRANSITION');
    }
    return parse(JSON.parse(record.outputJson) as unknown);
  }

  private async failWorkflowStage(
    workflow: PersistedWorkflowSnapshot,
    stage: AgentType | null,
    error: unknown,
    skipTerminalCheckpoint = false,
  ): Promise<PersistedWorkflowSnapshot> {
    if (isTerminal(workflow.status)) return workflow;
    const failure = stageFailure(error);
    const terminal = await this.transition(workflow, 'failed', {
      currentStage: null,
      activeStage: null,
      pausedFrom: null,
      pauseReason: null,
      failure: { message: failure.message, stage, code: failure.code },
    });
    await this.finalizeTerminal(
      terminal,
      skipTerminalCheckpoint
        || error instanceof WorkflowGitContextError
        || error instanceof WorkflowCheckpointError,
    );
    return terminal;
  }

  private async finalizeTerminal(
    workflow: PersistedWorkflowSnapshot,
    skipCheckpoint = false,
  ): Promise<void> {
    if (!isTerminal(workflow.status)) return;
    try {
      if (!skipCheckpoint) {
        await this.checkpoint(
          workflow,
          null,
          workflow.reviewRound,
          'terminal',
          `${workflow.id}:terminal:${workflow.status}`,
        );
      }
      await this.publish(workflow, 'workflow_terminal', `terminal:${workflow.status}`, {
        result: workflow.status,
        failureCode: workflow.failure?.code,
      });
    } finally {
      // Temporary task grants are a security boundary, not a best-effort
      // terminal side effect. Always clear them even if checkpoint/event
      // persistence fails after the workflow reached a terminal state.
      this.dependencies.permissionLifecycle?.completeTask({
        taskId: workflow.taskId,
        workflowId: workflow.id,
        projectPath: workflow.projectPath,
      });
    }
  }

  private async applyControlIntent(
    workflow: PersistedWorkflowSnapshot,
  ): Promise<PersistedWorkflowSnapshot> {
    const intent = this.controlIntents.get(workflow.id);
    if (!intent) return workflow;
    this.controlIntents.delete(workflow.id);
    if (isTerminal(workflow.status)) return workflow;
    try {
      if (intent.type === 'cancel') {
        const terminal = await this.transition(workflow, 'cancelled', {
          currentStage: null,
          activeStage: null,
          pausedFrom: null,
          pauseReason: null,
          failure: null,
        });
        await this.finalizeTerminal(terminal);
        return terminal;
      }
      if (workflow.status === 'paused') return workflow;
      return await this.transition(workflow, 'paused', {
        currentStage: null,
        activeStage: null,
        pausedFrom: workflow.status,
        pauseReason: intent.reason ?? 'user_paused',
      });
    } catch (error) {
      if (!this.controlIntents.has(workflow.id)) this.controlIntents.set(workflow.id, intent);
      throw error;
    }
  }

  private async transition(
    workflow: PersistedWorkflowSnapshot,
    status: WorkflowStatus,
    patch: Partial<PersistedWorkflowSnapshot> = {},
  ): Promise<PersistedWorkflowSnapshot> {
    if (workflow.status === status) return workflow;
    if (!canTransition(workflow.status, status)) throw this.invalidTransition(workflow.status, status);
    const change: WorkflowStatusChange = { from: workflow.status, to: status };
    const next = await this.save(workflow, { ...patch, status });
    await this.publish(next, 'workflow_status_changed', `transition:${next.revision}`, { ...change });
    return next;
  }

  private async save(
    workflow: PersistedWorkflowSnapshot,
    patch: Partial<PersistedWorkflowSnapshot>,
  ): Promise<PersistedWorkflowSnapshot> {
    const next: PersistedWorkflowSnapshot = {
      ...workflow,
      ...cloneStructured(patch),
      id: workflow.id,
      taskId: workflow.taskId,
      projectId: workflow.projectId,
      projectPath: workflow.projectPath,
      revision: workflow.revision + 1,
      updatedAt: monotonicTimestamp(this.now(), workflow.updatedAt),
    };
    try {
      const expectation = {
        expectedRevision: workflow.revision,
        expectedUpdatedAt: workflow.updatedAt,
      };
      if (patch.latestReview && this.dependencies.persistence.saveWorkflowWithReview) {
        await this.dependencies.persistence.saveWorkflowWithReview(next, patch.latestReview, expectation);
      } else {
        await this.dependencies.persistence.saveWorkflow(next, expectation);
      }
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError('Workflow changed in another operation.', 'PERSISTENCE_CONFLICT');
    }
    return next;
  }

  private async readGit(
    projectPath: string,
    allowNonRepository = false,
  ): Promise<WorkflowGitContext> {
    let context: WorkflowGitContext;
    try {
      context = await this.git.readContext(projectPath);
    } catch {
      // The Git adapter may include local paths or command details. Workflow
      // failures cross persistence/IPC boundaries, so replace them here with
      // one fixed internal classification and never retry through checkpointing.
      throw new WorkflowGitContextError();
    }
    if (
      context.kind !== 'repository'
      && !(allowNonRepository && context.kind === 'not_repository')
    ) {
      throw new WorkflowGitContextError();
    }
    return cloneStructured({
      kind: context.kind,
      head: context.head,
      branch: context.branch,
      files: context.files.map((file) => ({
        filePath: file.filePath,
        changeType: file.changeType,
        staged: Boolean(file.staged),
      })),
    });
  }

  private async checkpoint(
    workflow: PersistedWorkflowSnapshot,
    stage: AgentType | null,
    round: number,
    boundary: WorkflowCheckpointBoundary,
    idempotencyKey: string,
  ): Promise<void> {
    try {
      await this.checkpoints.createCheckpoint({
        workflowId: workflow.id,
        taskId: workflow.taskId,
        projectPath: workflow.projectPath,
        stage,
        round,
        boundary,
        idempotencyKey,
      });
    } catch {
      // Checkpoint adapters may include local paths, Git command details, or
      // snapshot locations. Nothing from that trust boundary crosses IPC.
      throw new WorkflowCheckpointError();
    }
  }

  private async publish(
    workflow: PersistedWorkflowSnapshot,
    type: WorkflowEvent['type'],
    suffix: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.events.publish({
        idempotencyKey: `${workflow.id}:${suffix}`,
        workflowId: workflow.id,
        taskId: workflow.taskId,
        type,
        status: workflow.status,
        stage: workflow.currentStage,
        round: workflow.reviewRound,
        timestamp: workflow.updatedAt,
        payload: cloneStructured(payload),
      });
    } catch {
      // Timeline delivery is best effort; durable state/stage rows remain authoritative.
    }
  }

  private async requireWorkflow(workflowId: string): Promise<PersistedWorkflowSnapshot> {
    const workflow = await this.dependencies.persistence.getWorkflow(workflowId);
    if (!workflow) throw new WorkflowError('Workflow was not found.', 'NOT_FOUND');
    return {
      ...workflow,
      currentModel: workflow.currentModel?.trim() || null,
      currentPermissionMode: CLI_PERMISSION_MODES.has(workflow.currentPermissionMode)
        ? workflow.currentPermissionMode
        : 'plan',
      executionCycle: Number.isInteger(workflow.executionCycle) && workflow.executionCycle >= 0
        ? workflow.executionCycle
        : workflow.reviewRound > 0 ? 1 : 0,
      reviewAccepted: workflow.reviewAccepted === true,
      pauseReason: workflow.pauseReason ?? null,
      modelSelectionPolicy: workflow.modelSelectionPolicy ?? null,
      modelPolicy: normalizeAgentModelPolicy(workflow.modelPolicy),
    };
  }

  private stageForStatus(status: WorkflowStatus): AgentType | null {
    if (status === 'planning') return 'planner';
    if (status === 'executing') return 'coder';
    if (status === 'testing') return 'tester';
    if (status === 'reviewing') return 'reviewer';
    return null;
  }

  private pinnedSelection(
    workflow: PersistedWorkflowSnapshot,
    stage: AgentType,
  ): ResolvedModelSelection | undefined {
    const policy = workflow.modelSelectionPolicy;
    if (!policy) return undefined;
    if (stage === 'coder' && workflow.reviewRound > 1) return policy.fixer;
    return policy[stage];
  }

  private async revalidateStageModel(
    workflow: PersistedWorkflowSnapshot,
    stage: AgentType,
  ): Promise<void> {
    const selections = this.dependencies.modelSelections;
    if (!selections) return;
    const agentType = stage === 'coder' && workflow.reviewRound > 1 ? 'fixer' : stage;
    const pinned = this.pinnedSelection(workflow, stage);
    if (pinned) {
      // Production always supplies this method; optional test/legacy gateways remain compatible.
      if (!selections.revalidatePinnedSelection) return;
      await selections.revalidatePinnedSelection(pinned, {
        taskId: workflow.taskId,
        projectId: workflow.projectId,
        agentType,
        use: 'agent-workflow',
      });
      return;
    }
    if (selections.resolve) {
      await selections.resolve({
        taskId: workflow.taskId,
        projectId: workflow.projectId,
        agentType,
        fallbackModelId: resolveAgentModel(workflow.modelPolicy, stage, workflow.currentModel) ?? null,
        use: 'agent-workflow',
      });
    }
  }

  private invalidTransition(from: WorkflowStatus, to: WorkflowStatus): WorkflowError {
    return new WorkflowError(`Illegal workflow transition: ${from} -> ${to}.`, 'INVALID_TRANSITION');
  }

  private enqueue<T>(workflowId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(workflowId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    let tracked: Promise<T>;
    tracked = next.finally(() => {
      if (this.queues.get(workflowId) === tracked) this.queues.delete(workflowId);
    });
    this.queues.set(workflowId, tracked);
    return tracked;
  }
}

export const agentWorkflowInternals = {
  canTransition,
  cloneStructured,
  isTerminal,
  monotonicTimestamp,
  stageFailure,
  stageRecordId,
  structuredJson,
};
