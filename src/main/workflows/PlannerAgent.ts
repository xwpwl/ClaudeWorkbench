import type { ExecutionPlan } from '../../shared/types/workflow';
import type { ResolvedModelSelection } from '../../shared/types/modelProviders';
import { resolveAgentModel } from './AgentModelPolicy';
import type {
  AgentStageRunner,
  PersistedWorkflowSnapshot,
  WorkflowGitContext,
} from './contracts';
import { StructuredJsonParser } from './StructuredJsonParser';

export interface PlannerAgentRequest {
  workflow: PersistedWorkflowSnapshot;
  git: WorkflowGitContext;
  operationId: string;
  feedback?: string | null;
  modelSelection?: ResolvedModelSelection;
}

export class PlannerAgent {
  constructor(
    private readonly runner: AgentStageRunner,
    private readonly parser = new StructuredJsonParser(),
  ) {}

  async run(request: PlannerAgentRequest): Promise<ExecutionPlan> {
    const { workflow } = request;
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
      stage: 'planner',
      agentType: 'planner',
      agentMode: 'plan',
      permissionMode: 'plan',
      model: request.modelSelection?.modelId
        ?? resolveAgentModel(workflow.modelPolicy, 'planner', workflow.currentModel),
      ...(request.modelSelection ? { modelSelection: request.modelSelection } : {}),
      prompt: workflow.prompt,
      systemPrompt: 'Create a structured execution plan. Do not modify files. Return only ExecutionPlan JSON.',
      reviewRound: 0,
      workflowContext: { workflowId: workflow.id, stage: 'planner', reviewRound: 0 },
      input: {
        kind: 'planner',
        goal: workflow.prompt,
        projectPath: workflow.projectPath,
        git: request.git,
        previousPlan: workflow.plan,
        feedback: request.feedback?.trim() || null,
      },
    });
    return this.parser.parsePlan(result.output);
  }
}
