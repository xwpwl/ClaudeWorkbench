import fs from 'node:fs';
import path from 'node:path';
import { dialog, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { canonicalProjectKey } from '../../shared/sessionIdentity';
import type { CommitPreview } from '../../shared/types/git';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type {
  CreateWorkflowRequest,
  ExecutionPlan,
  ReviewReport,
  Workflow,
  WorkflowListRequest,
  WorkflowPage,
  WorkflowPageRequest,
  WorkflowStageRecord,
} from '../../shared/types/workflow';
import type { AppDatabase } from '../database/Database';
import type { AgentWorkflowManager } from '../workflows/AgentWorkflowManager';
import type { WorkflowInfrastructure } from '../workflows/WorkflowInfrastructure';
import type { PublicIpcRegistrar } from './public-invoke-boundary';

const idInput = z.string().trim().min(1).max(512).refine((value) => !value.includes('\0'));
const promptInput = z.string().trim().min(1).max(200_000).refine((value) => !value.includes('\0'));
const feedbackInput = z.string().trim().min(1).max(50_000).refine((value) => !value.includes('\0'));
const pageInput = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
const modelPolicyInput = z.object({
  plannerModel: z.string().trim().max(500).optional(),
  coderModel: z.string().trim().max(500).optional(),
  testerModel: z.string().trim().max(500).optional(),
  reviewerModel: z.string().trim().max(500).optional(),
  fixerModel: z.string().trim().max(500).optional(),
}).strict();
const createInput = z.object({
  taskId: idInput,
  prompt: promptInput,
  currentModel: z.string().trim().max(500).optional(),
  // Phase 6 workflows always retain the PermissionBroker. Renderer-created
  // workflows cannot opt into the CLI bypass mode.
  currentPermissionMode: z.enum(['default', 'acceptEdits', 'plan']),
  modelPolicy: modelPolicyInput.optional(),
}).strict();
const planStepInput = z.object({
  id: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(500),
  risk: z.enum(['low', 'medium', 'high']),
  description: z.string().trim().min(1).max(20_000).optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'skipped', 'cancelled']).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(500).optional(),
}).strict();
const executionPlanInput = z.object({
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(20_000),
  steps: z.array(planStepInput).min(1).max(200),
  filesExpected: z.array(z.string().trim().min(1).max(4_000)).max(500),
  estimatedChanges: z.string().trim().min(1).max(2_000),
  riskLevel: z.enum(['low', 'medium', 'high']),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(500).optional(),
}).strict();

export interface WorkflowIPCDependencies {
  database: AppDatabase;
  manager: AgentWorkflowManager;
  infrastructure: WorkflowInfrastructure;
  saveReview?: (defaultFileName: string, markdown: string) => Promise<string | null>;
}

function reviewMarkdown(workflow: Workflow, review: ReviewReport): string {
  const lines = [
    `# Workflow Review - ${workflow.plan?.title ?? workflow.prompt.slice(0, 120)}`,
    '',
    `- Workflow: ${workflow.id}`,
    `- Round: ${review.round}`,
    `- Score: ${review.score}/10`,
    `- Tests: ${review.tests.passed} passed, ${review.tests.failed} failed, ${review.tests.skipped ?? 0} skipped`,
    '',
    '## Summary',
    '',
    review.summary,
    '',
    '## Issues',
    '',
  ];
  if (review.issues.length === 0) lines.push('No issues found.');
  for (const issue of review.issues) {
    const location = issue.file
      ? `${issue.file}${issue.line === null ? '' : `:${issue.line}`}`
      : 'global';
    lines.push(
      `### [${issue.severity.toUpperCase()}] ${issue.title}`,
      '',
      `- Location: ${location}`,
      `- Status: ${issue.resolved ? 'resolved' : 'open'}`,
      `- Recommendation: ${issue.recommendation}`,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function safeReviewFileName(workflowId: string, round: number): string {
  const safeId = workflowId.replace(/[^a-z0-9_-]+/giu, '-').replace(/^-+|-+$/gu, '') || 'workflow';
  return `${safeId}-review-round-${round}.md`;
}

async function saveReviewWithDialog(defaultFileName: string, markdown: string): Promise<string | null> {
  const selection = await dialog.showSaveDialog({
    title: 'Export workflow review',
    defaultPath: defaultFileName,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (selection.canceled || !selection.filePath) return null;
  const target = path.resolve(selection.filePath);
  await fs.promises.writeFile(target, markdown, 'utf8');
  return target;
}

function workflowIdentity(database: AppDatabase, taskId: string) {
  const session = database.getSession(taskId);
  const task = database.getTask(taskId);
  const project = session ? database.getProject(session.project_id) : null;
  if (!session || !task || !project || task.project_id !== session.project_id) {
    throw new Error('Workflow task is not registered in Workbench.');
  }
  const projectKey = canonicalProjectKey(project.path);
  return {
    session,
    task,
    project,
    projectKey,
    sessionKey: `${projectKey}::${session.id}`,
  };
}

function assertWorkflowExecutionIdentity(
  database: AppDatabase,
  infrastructure: WorkflowInfrastructure,
  workflowId: string,
): void {
  const workflow = infrastructure.persistence.getPublic(workflowId);
  if (!workflow) throw new Error('Workflow was not found.');
  const identity = workflowIdentity(database, workflow.taskId);
  if (
    workflow.projectId !== identity.project.id
    || canonicalProjectKey(workflow.projectPath) !== identity.projectKey
  ) {
    throw new Error('Workflow project binding no longer matches its registered task project.');
  }
}

export function registerWorkflowIPC(
  ipcMain: PublicIpcRegistrar,
  dependencies: WorkflowIPCDependencies,
): () => void {
  const { database, manager, infrastructure } = dependencies;
  const channels: string[] = [];
  const handle = (
    channel: string,
    listener: Parameters<PublicIpcRegistrar['handle']>[1],
  ): void => {
    ipcMain.handle(channel, listener);
    channels.push(channel);
  };

  handle(IPC_CHANNELS.WORKFLOW_CREATE, async (_event: IpcMainInvokeEvent, raw: CreateWorkflowRequest) => {
    const input = createInput.parse(raw);
    const identity = workflowIdentity(database, input.taskId);
    const existing = infrastructure.persistence.getByTask(input.taskId);
    if (existing) {
      if (existing.prompt !== input.prompt) {
        throw new Error('This task already owns a different workflow. Create a new task to start again.');
      }
      const found = await manager.getWorkflow(existing.id);
      if (!found) throw new Error('Workflow persistence is inconsistent.');
      return found;
    }
    return manager.createWorkflow({
      taskId: input.taskId,
      projectId: identity.project.id,
      projectPath: identity.project.path,
      projectKey: identity.projectKey,
      sessionKey: identity.sessionKey,
      ...(identity.session.claude_session_id
        ? { resumeSessionId: identity.session.claude_session_id }
        : {}),
      prompt: input.prompt,
      currentModel: input.currentModel || identity.session.model || undefined,
      currentPermissionMode: input.currentPermissionMode,
      modelPolicy: input.modelPolicy,
    });
  });

  handle(IPC_CHANNELS.WORKFLOW_GET, (_event: IpcMainInvokeEvent, workflowId: string) => (
    manager.getWorkflow(idInput.parse(workflowId))
  ));

  handle(IPC_CHANNELS.WORKFLOW_GET_BY_TASK, async (_event: IpcMainInvokeEvent, taskId: string) => {
    const parsedTaskId = idInput.parse(taskId);
    workflowIdentity(database, parsedTaskId);
    const persisted = infrastructure.persistence.getByTask(parsedTaskId);
    return persisted ? manager.getWorkflow(persisted.id) : null;
  });

  handle(IPC_CHANNELS.WORKFLOW_LIST_PAGE, (_event: IpcMainInvokeEvent, raw: WorkflowPageRequest): WorkflowPage<Workflow> => {
    const parsed = z.object({
      projectId: idInput,
      taskId: idInput.optional(),
      limit: pageInput.shape.limit,
      offset: pageInput.shape.offset,
    }).strict().parse(raw);
    if (!database.getProject(parsed.projectId)) throw new Error('Workflow project was not found.');
    if (parsed.taskId) {
      const identity = workflowIdentity(database, parsed.taskId);
      if (identity.project.id !== parsed.projectId) throw new Error('Workflow task belongs to another project.');
    }
    return infrastructure.persistence.listPage(parsed);
  });

  handle(
    IPC_CHANNELS.WORKFLOW_LIST_STAGES,
    (_event: IpcMainInvokeEvent, workflowId: string, raw: WorkflowListRequest = {}): WorkflowPage<WorkflowStageRecord> => {
      const parsedId = idInput.parse(workflowId);
      if (!infrastructure.persistence.getPublic(parsedId)) throw new Error('Workflow was not found.');
      return infrastructure.persistence.listStagePage(parsedId, pageInput.parse(raw));
    },
  );

  handle(IPC_CHANNELS.WORKFLOW_GET_REVIEW, (_event: IpcMainInvokeEvent, workflowId: string, round?: number) => {
    const parsedId = idInput.parse(workflowId);
    if (!infrastructure.persistence.getPublic(parsedId)) throw new Error('Workflow was not found.');
    const parsedRound = round === undefined ? undefined : z.number().int().min(1).max(3).parse(round);
    return infrastructure.persistence.getReview(parsedId, parsedRound);
  });

  handle(IPC_CHANNELS.WORKFLOW_START_PLANNING, (
    _event: IpcMainInvokeEvent,
    workflowId: string,
    feedback?: string,
  ) => {
    const parsedId = idInput.parse(workflowId);
    const parsedFeedback = feedback === undefined || feedback === ''
      ? null
      : feedbackInput.parse(feedback);
    assertWorkflowExecutionIdentity(database, infrastructure, parsedId);
    return manager.startPlanning(parsedId, parsedFeedback);
  });
  handle(IPC_CHANNELS.WORKFLOW_UPDATE_PLAN, (_event: IpcMainInvokeEvent, workflowId: string, plan: ExecutionPlan) => (
    manager.updatePlan(idInput.parse(workflowId), executionPlanInput.parse(plan))
  ));
  handle(IPC_CHANNELS.WORKFLOW_START_EXECUTION, (_event: IpcMainInvokeEvent, workflowId: string) => {
    const parsedId = idInput.parse(workflowId);
    assertWorkflowExecutionIdentity(database, infrastructure, parsedId);
    return manager.startExecution(parsedId);
  });
  handle(IPC_CHANNELS.WORKFLOW_PAUSE, (_event: IpcMainInvokeEvent, workflowId: string) => (
    manager.pause(idInput.parse(workflowId))
  ));
  handle(IPC_CHANNELS.WORKFLOW_RESUME, (_event: IpcMainInvokeEvent, workflowId: string, allow?: boolean) => {
    const parsedId = idInput.parse(workflowId);
    const parsedAllow = allow === undefined ? false : z.boolean().parse(allow);
    assertWorkflowExecutionIdentity(database, infrastructure, parsedId);
    return manager.resume(parsedId, { allowAfterFixLimit: parsedAllow });
  });
  handle(IPC_CHANNELS.WORKFLOW_CANCEL, (_event: IpcMainInvokeEvent, workflowId: string) => (
    manager.cancel(idInput.parse(workflowId))
  ));
  handle(IPC_CHANNELS.WORKFLOW_ACCEPT_REVIEW, (_event: IpcMainInvokeEvent, workflowId: string) => (
    manager.acceptReview(idInput.parse(workflowId))
  ));

  handle(IPC_CHANNELS.WORKFLOW_EXPORT_REVIEW, async (_event: IpcMainInvokeEvent, workflowId: string) => {
    const parsedId = idInput.parse(workflowId);
    const workflow = infrastructure.persistence.getPublic(parsedId);
    const review = infrastructure.persistence.getReview(parsedId);
    if (!workflow || !review) throw new Error('Workflow review was not found.');
    return (dependencies.saveReview ?? saveReviewWithDialog)(
      safeReviewFileName(parsedId, review.round),
      reviewMarkdown(workflow, review),
    );
  });
  handle(IPC_CHANNELS.WORKFLOW_COMMIT_PREVIEW, (_event: IpcMainInvokeEvent, workflowId: string): Promise<CommitPreview> => (
    infrastructure.createCommitPreview(idInput.parse(workflowId))
  ));

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

export const workflowIpcInternals = {
  createInput,
  executionPlanInput,
  pageInput,
  reviewMarkdown,
  safeReviewFileName,
  workflowIdentity,
};
