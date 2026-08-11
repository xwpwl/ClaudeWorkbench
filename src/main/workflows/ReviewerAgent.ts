import type { ReviewIssue, ReviewReport } from '../../shared/types/workflow';
import type { ResolvedModelSelection } from '../../shared/types/modelProviders';
import { resolveAgentModel } from './AgentModelPolicy';
import type {
  AgentStageRunner,
  CoderStageOutput,
  PersistedWorkflowSnapshot,
  TesterStageOutput,
  WorkflowGitContext,
} from './contracts';
import { StructuredJsonParser } from './StructuredJsonParser';

export interface ReviewerAgentRequest {
  workflow: PersistedWorkflowSnapshot;
  git: WorkflowGitContext;
  coder: CoderStageOutput;
  tests: TesterStageOutput;
  operationId: string;
  reviewRound: number;
  modelSelection?: ResolvedModelSelection;
}

export function isActionableReviewIssue(issue: ReviewIssue): boolean {
  return !issue.resolved && issue.severity !== 'suggestion';
}

export function reviewRequiresFix(report: ReviewReport): boolean {
  return report.score < 8
    || report.tests.failed > 0
    || report.issues.some(isActionableReviewIssue);
}

export class ReviewerAgent {
  constructor(
    private readonly runner: AgentStageRunner,
    private readonly parser = new StructuredJsonParser(),
  ) {}

  /** Reviewer is permanently constrained to review mode; the runner denies mutating tools. */
  async run(request: ReviewerAgentRequest): Promise<ReviewReport> {
    const { workflow } = request;
    if (!workflow.plan) throw new Error('Reviewer requires a confirmed execution plan.');
    const result = await this.runner.runStage({
      operationId: request.operationId,
      workflowId: workflow.id,
      taskId: workflow.taskId,
      projectId: workflow.projectId,
      projectPath: workflow.projectPath,
      projectKey: workflow.projectKey,
      sessionKey: workflow.sessionKey,
      ...(workflow.resumeSessionId && !workflow.modelSelectionPolicy
        ? { resumeSessionId: workflow.resumeSessionId }
        : {}),
      stage: 'reviewer',
      agentType: 'reviewer',
      agentMode: 'review',
      permissionMode: 'plan',
      model: request.modelSelection?.modelId
        ?? resolveAgentModel(workflow.modelPolicy, 'reviewer', workflow.currentModel),
      ...(request.modelSelection ? { modelSelection: request.modelSelection } : {}),
      prompt: workflow.prompt,
      systemPrompt: 'Review the implemented changes without modifying files. Return only ReviewReport JSON.',
      reviewRound: request.reviewRound,
      workflowContext: {
        workflowId: workflow.id,
        stage: 'reviewer',
        reviewRound: request.reviewRound,
      },
      input: {
        kind: 'reviewer',
        goal: workflow.prompt,
        projectPath: workflow.projectPath,
        plan: workflow.plan,
        coder: request.coder,
        tests: request.tests,
        git: request.git,
        reviewRound: request.reviewRound,
      },
    });
    const report = this.parser.parseReview(result.output, request.reviewRound);
    // Actual tester counts are authoritative; the reviewer cannot rewrite them.
    return {
      ...report,
      tests: {
        passed: request.tests.passed,
        failed: request.tests.failed,
        ...(request.tests.skipped > 0 ? { skipped: request.tests.skipped } : {}),
      },
    };
  }
}

export const reviewerAgentInternals = { isActionableReviewIssue };
