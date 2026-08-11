/** Maximum number of reviewer-requested coder fix rounds. */
export const MAX_WORKFLOW_REVIEW_ROUNDS = 3;

export type WorkflowStatus =
  | 'idle'
  | 'planning'
  | 'waiting_plan_confirmation'
  | 'executing'
  | 'testing'
  | 'reviewing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentType = 'planner' | 'coder' | 'tester' | 'reviewer';
export type AgentStage = AgentType;

export type WorkflowStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface ExecutionPlanStep {
  id: number;
  title: string;
  risk: RiskLevel;
  description?: string;
  status?: WorkflowStepStatus;
  acceptanceCriteria?: string[];
}

export interface ExecutionPlan {
  title: string;
  summary: string;
  steps: ExecutionPlanStep[];
  filesExpected: string[];
  estimatedChanges: string;
  riskLevel: RiskLevel;
  constraints?: string[];
}

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | 'suggestion';

export interface ReviewIssue {
  id?: string;
  severity: ReviewSeverity;
  file: string | null;
  line: number | null;
  title: string;
  recommendation: string;
  resolved?: boolean;
}

export interface ReviewTestSummary {
  passed: number;
  failed: number;
  skipped?: number;
}

export interface ReviewReport {
  id?: string;
  workflowId?: string;
  round: number;
  /** Reviewer score on a 0-10 scale. */
  score: number;
  summary: string;
  issues: ReviewIssue[];
  tests: ReviewTestSummary;
}

/**
 * Empty or omitted model names inherit the model selected for the current task.
 * A fix pass is still a coder pass; fixerModel is an optional policy override.
 */
export interface AgentModelPolicy {
  plannerModel?: string;
  coderModel?: string;
  testerModel?: string;
  reviewerModel?: string;
  fixerModel?: string;
}

export const DEFAULT_AGENT_MODEL_POLICY: Readonly<AgentModelPolicy> = Object.freeze({});

export interface WorkflowFailure {
  message: string;
  stage: AgentType | null;
  code?: string;
}

export interface Workflow {
  id: string;
  taskId: string;
  projectId: string;
  projectPath: string;
  prompt: string;
  status: WorkflowStatus;
  currentStage: AgentType | null;
  modelPolicy: AgentModelPolicy;
  plan: ExecutionPlan | null;
  latestReview: ReviewReport | null;
  reviewRound: number;
  maxReviewRounds: number;
  fixRound: number;
  maxFixRounds: number;
  revision: number;
  pausedFrom: Exclude<WorkflowStatus, 'paused'> | null;
  failure: WorkflowFailure | null;
  createdAt: string;
  updatedAt: string;
}

/** Persisted workflow snapshot used by the orchestration service. */
export interface WorkflowSnapshot extends Workflow {
  activeStage: AgentType | null;
}

/** Compact list projection; plans and reviews are loaded only for the selected workflow. */
export type WorkflowSummary = Pick<
  Workflow,
  | 'id'
  | 'taskId'
  | 'projectId'
  | 'projectPath'
  | 'prompt'
  | 'status'
  | 'currentStage'
  | 'reviewRound'
  | 'maxReviewRounds'
  | 'fixRound'
  | 'maxFixRounds'
  | 'revision'
  | 'createdAt'
  | 'updatedAt'
>;

export type WorkflowStageStatus =
  | 'pending'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

/** Renderer-safe projection of a permission decision made during one agent stage run. */
export interface WorkflowStagePermission {
  toolName: string;
  decision: string;
  createdAt: string;
}

export interface WorkflowStageRecord {
  id: string;
  workflowId: string;
  stage: AgentType;
  round: number;
  status: WorkflowStageStatus;
  inputJson: string;
  outputJson: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  permissions?: WorkflowStagePermission[];
}

export interface WorkflowListRequest {
  limit?: number;
  offset?: number;
}

export interface WorkflowPage<T = Workflow> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Renderer-to-main creation input. Project/session identity is derived from taskId in main. */
export interface CreateWorkflowRequest {
  taskId: string;
  prompt: string;
  currentModel?: string;
  currentPermissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  modelPolicy?: AgentModelPolicy;
}

export interface WorkflowPageRequest extends WorkflowListRequest {
  projectId: string;
  taskId?: string;
}

export interface WorkflowChangedEvent {
  workflowId: string;
  taskId: string;
  projectId: string;
  status: WorkflowStatus;
  currentStage: AgentType | null;
  revision: number;
}

// Concise aliases retained for IPC consumers that use the domain nouns.
export type Plan = ExecutionPlan;
export type Review = ReviewReport;
