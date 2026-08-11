import type {
  ExecutionPlan,
  ReviewIssue,
  ReviewReport,
  Workflow,
  WorkflowStageRecord,
} from '../../../../shared/types/workflow';
import type { WorkflowSummary } from '../workflowPresentation';

export const NOW = '2026-08-01T08:00:00.000Z';

export function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    title: '实现 Workflow 面板',
    summary: '先规划，再编码、测试和审查。',
    steps: [
      { id: 1, title: '设计契约', risk: 'low', description: '定义可嵌入 props。' },
      { id: 2, title: '实现组件', risk: 'medium', acceptanceCriteria: ['Review 按需加载'] },
    ],
    filesExpected: ['src/one.ts', 'src/two.ts'],
    estimatedChanges: '2 个文件，约 200 行',
    riskLevel: 'medium',
    constraints: ['不读取 raw JSON'],
    ...overrides,
  };
}

export function makeIssue(index = 0, overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    id: `issue-${index}`,
    severity: 'medium',
    file: `src/file-${index}.ts`,
    line: index + 1,
    title: `问题 ${index}`,
    recommendation: `建议修复 ${index}`,
    resolved: false,
    ...overrides,
  };
}

export function makeReview(
  issueCount = 2,
  overrides: Partial<ReviewReport> = {},
): ReviewReport {
  return {
    id: 'review-1',
    workflowId: 'workflow-1',
    round: 1,
    score: 7.5,
    summary: '整体可用，但仍需修复边界条件。',
    issues: Array.from({ length: issueCount }, (_, index) => makeIssue(index)),
    tests: { passed: 18, failed: 2, skipped: 1 },
    ...overrides,
  };
}

export function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'workflow-1',
    taskId: 'task-1',
    projectId: 'project-1',
    projectPath: 'C:/project',
    prompt: '完成 Phase 6 Workflow UI',
    status: 'waiting_plan_confirmation',
    currentStage: 'planner',
    modelPolicy: {},
    plan: makePlan(),
    latestReview: null,
    reviewRound: 1,
    maxReviewRounds: 3,
    fixRound: 0,
    maxFixRounds: 3,
    revision: 4,
    pausedFrom: null,
    failure: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeSummary(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  const workflow = makeWorkflow(overrides as Partial<Workflow>);
  return {
    id: workflow.id,
    taskId: workflow.taskId,
    projectId: workflow.projectId,
    projectPath: workflow.projectPath,
    prompt: workflow.prompt,
    status: workflow.status,
    currentStage: workflow.currentStage,
    reviewRound: workflow.reviewRound,
    maxReviewRounds: workflow.maxReviewRounds,
    fixRound: workflow.fixRound,
    maxFixRounds: workflow.maxFixRounds,
    revision: workflow.revision,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

export function makeStage(overrides: Partial<WorkflowStageRecord> = {}): WorkflowStageRecord {
  return {
    id: 'stage-1',
    workflowId: 'workflow-1',
    stage: 'planner',
    round: 1,
    status: 'completed',
    inputJson: '{}',
    outputJson: JSON.stringify({ title: '计划', summary: '完成计划', steps: [{ id: 1 }] }),
    error: null,
    startedAt: '2026-08-01T08:00:00.000Z',
    completedAt: '2026-08-01T08:00:02.500Z',
    ...overrides,
  };
}
