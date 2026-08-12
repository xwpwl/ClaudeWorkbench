import type { CliPermissionMode } from '../../shared/types/claude';
import type {
  ModelPolicyAgentType,
  ResolvedModelSelection,
  WorkflowModelPolicySnapshotRequest,
  WorkflowModelSelectionPolicy,
} from '../../shared/types/modelProviders';
import type {
  AgentModelPolicy,
  AgentType,
  ExecutionPlan,
  ReviewReport,
  WorkflowSnapshot,
  WorkflowStageRecord,
  WorkflowStatus,
} from '../../shared/types/workflow';

export type MaybePromise<T> = T | Promise<T>;

export interface PersistedWorkflowSnapshot extends WorkflowSnapshot {
  /** The task model inherited by empty AgentModelPolicy fields. */
  currentModel: string | null;
  currentPermissionMode: CliPermissionMode;
  projectKey: string;
  sessionKey: string;
  resumeSessionId: string | null;
  /** Null only for workflows created before Provider policy snapshots were introduced. */
  modelSelectionPolicy: WorkflowModelSelectionPolicy | null;
  /** Separates deterministic stage ids across user-authorized execution cycles. */
  executionCycle: number;
  /** Records explicit user acceptance of unresolved review findings. */
  reviewAccepted: boolean;
  /** Machine-readable pause context, kept out of renderer-facing DTOs. */
  pauseReason: string | null;
}

export interface WorkflowPersistenceExpectation {
  expectedRevision: number;
  expectedUpdatedAt: string;
}

/**
 * Storage boundary used by AgentWorkflowManager. A Database adapter may remain
 * synchronous; Promise support keeps the orchestration layer storage-agnostic.
 */
export interface WorkflowPersistence {
  getWorkflow(workflowId: string): MaybePromise<PersistedWorkflowSnapshot | null>;
  createWorkflow(workflow: PersistedWorkflowSnapshot): MaybePromise<void>;
  saveWorkflow(
    workflow: PersistedWorkflowSnapshot,
    expectation: WorkflowPersistenceExpectation,
  ): MaybePromise<void>;
  /** Optional DB adapter hook for atomically saving snapshot + review + issues. */
  saveWorkflowWithReview?(
    workflow: PersistedWorkflowSnapshot,
    review: ReviewReport,
    expectation: WorkflowPersistenceExpectation,
  ): MaybePromise<void>;
  listStageRecords(workflowId: string): MaybePromise<readonly WorkflowStageRecord[]>;
  upsertStageRecord(record: WorkflowStageRecord): MaybePromise<void>;
}

export interface WorkflowGitFile {
  filePath: string;
  changeType: string;
  staged: boolean;
}

export interface WorkflowGitContext {
  /** Distinguishes a real clean repository from an intentionally Git-less project. */
  kind: 'repository' | 'not_repository' | 'unavailable';
  head: string | null;
  branch: string | null;
  files: WorkflowGitFile[];
}

export interface WorkflowGitGateway {
  readContext(projectPath: string): MaybePromise<WorkflowGitContext>;
}

export type WorkflowCheckpointBoundary =
  | 'before_plan'
  | 'after_plan'
  | 'before_execute'
  | 'after_execute'
  | 'before_fix'
  | 'after_fix'
  | 'before_review'
  | 'terminal';

export interface WorkflowCheckpointRequest {
  workflowId: string;
  taskId: string;
  projectPath: string;
  stage: AgentType | null;
  round: number;
  boundary: WorkflowCheckpointBoundary;
  idempotencyKey: string;
}

export interface WorkflowCheckpointGateway {
  createCheckpoint(request: WorkflowCheckpointRequest): MaybePromise<void>;
}

export type WorkflowEventType =
  | 'workflow_created'
  | 'workflow_status_changed'
  | 'workflow_plan_ready'
  | 'workflow_plan_updated'
  | 'workflow_stage_started'
  | 'workflow_stage_completed'
  | 'workflow_fix_loop_started'
  | 'workflow_review_accepted'
  | 'workflow_user_action_required'
  | 'workflow_terminal';

export interface WorkflowEvent {
  idempotencyKey: string;
  workflowId: string;
  taskId: string;
  type: WorkflowEventType;
  status: WorkflowStatus;
  stage: AgentType | null;
  round: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface WorkflowEventGateway {
  publish(event: WorkflowEvent): MaybePromise<void>;
}

export interface PlannerStageInput {
  kind: 'planner';
  goal: string;
  projectPath: string;
  git: WorkflowGitContext;
  previousPlan: ExecutionPlan | null;
  feedback: string | null;
}

export interface CoderStageInput {
  kind: 'coder';
  goal: string;
  projectPath: string;
  plan: ExecutionPlan;
  review: ReviewReport | null;
  git: WorkflowGitContext;
  fixRound: number;
}

export interface TesterStageInput {
  kind: 'tester';
  goal: string;
  projectPath: string;
  plan: ExecutionPlan;
  coder: CoderStageOutput;
  git: WorkflowGitContext;
  fixRound: number;
}

export interface ReviewerStageInput {
  kind: 'reviewer';
  goal: string;
  projectPath: string;
  plan: ExecutionPlan;
  coder: CoderStageOutput;
  tests: TesterStageOutput;
  git: WorkflowGitContext;
  reviewRound: number;
}

export type AgentStageInput =
  | PlannerStageInput
  | CoderStageInput
  | TesterStageInput
  | ReviewerStageInput;

export interface CoderStageOutput {
  summary: string;
  filesChanged: string[];
  testsSuggested: string[];
}

export interface TesterStageOutput {
  summary: string;
  passed: number;
  failed: number;
  skipped: number;
  commands: string[];
}

export interface AgentStageRequest {
  operationId: string;
  workflowId: string;
  taskId: string;
  projectId: string;
  projectPath: string;
  projectKey: string;
  sessionKey: string;
  resumeSessionId?: string;
  stage: AgentType;
  agentType: AgentType;
  agentMode: 'normal' | 'plan' | 'review';
  permissionMode: CliPermissionMode;
  model?: string;
  /** Trusted Workflow-creation snapshot; revalidated immediately before process spawn. */
  modelSelection?: ResolvedModelSelection;
  prompt: string;
  /** Core-generated stage instruction; never persisted as stage input/output. */
  systemPrompt: string;
  reviewRound: number;
  workflowContext: {
    workflowId: string;
    stage: AgentType;
    reviewRound: number;
  };
  input: AgentStageInput;
}

export interface AgentStageResult {
  /** Raw transport output. Callers must parse and allowlist it before persistence. */
  output: unknown;
  runId: string;
  modelSelection?: ResolvedModelSelection;
  modifiedFiles?: string[];
  tests?: {
    passed: number;
    failed: number;
    skipped?: number;
  };
}

/** The integration adapter drives TaskManager/Claude and returns one structured result. */
export interface AgentStageRunner {
  runStage(request: AgentStageRequest): Promise<AgentStageResult>;
}

export interface WorkflowModelSelectionGateway {
  snapshotWorkflowPolicy(
    request: WorkflowModelPolicySnapshotRequest,
  ): MaybePromise<WorkflowModelSelectionPolicy>;
  resolve?(request: {
    taskId: string;
    projectId: string;
    agentType: ModelPolicyAgentType;
    fallbackModelId: string | null;
    use: 'agent-workflow';
  }): MaybePromise<ResolvedModelSelection>;
  revalidatePinnedSelection?(
    selection: ResolvedModelSelection,
    request: {
      taskId: string;
      projectId: string;
      agentType: ModelPolicyAgentType;
      use: 'agent-workflow';
    },
  ): MaybePromise<ResolvedModelSelection>;
}

export interface WorkflowDependencies {
  persistence: WorkflowPersistence;
  runner: AgentStageRunner;
  /** Optional only so persisted pre-snapshot workflows remain recoverable. */
  modelSelections?: WorkflowModelSelectionGateway;
  checkpoints?: WorkflowCheckpointGateway;
  git?: WorkflowGitGateway;
  events?: WorkflowEventGateway;
  permissionLifecycle?: {
    completeTask(identity: {
      taskId: string;
      workflowId?: string;
      projectPath: string;
    }): void;
  };
  now?: () => Date;
  randomUUID?: () => string;
}

export interface CreateWorkflowInput {
  id?: string;
  taskId: string;
  projectId: string;
  projectPath: string;
  projectKey?: string;
  sessionKey?: string;
  resumeSessionId?: string;
  prompt: string;
  currentModel?: string;
  currentPermissionMode: CliPermissionMode;
  modelPolicy?: AgentModelPolicy;
  maxFixRounds?: number;
}

export interface ResumeWorkflowOptions {
  /** Explicit user authority is required to continue after the fix-loop cap. */
  allowAfterFixLimit?: boolean;
}

export interface WorkflowStatusChange {
  from: WorkflowStatus;
  to: WorkflowStatus;
}

export const EMPTY_GIT_CONTEXT: Readonly<WorkflowGitContext> = Object.freeze({
  kind: 'unavailable',
  head: null,
  branch: null,
  files: Object.freeze([]) as unknown as WorkflowGitFile[],
});

export const NOOP_CHECKPOINT_GATEWAY: WorkflowCheckpointGateway = {
  createCheckpoint: () => undefined,
};

export const NOOP_EVENT_GATEWAY: WorkflowEventGateway = {
  publish: () => undefined,
};

export const NOOP_GIT_GATEWAY: WorkflowGitGateway = {
  readContext: () => ({ kind: 'unavailable', head: null, branch: null, files: [] }),
};
