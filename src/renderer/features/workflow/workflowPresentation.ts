import type {
  AgentType,
  ExecutionPlan,
  ReviewIssue,
  ReviewReport,
  ReviewSeverity,
  RiskLevel,
  Workflow,
  WorkflowPage,
  WorkflowStageRecord,
  WorkflowStageStatus,
  WorkflowStatus,
} from '../../../shared/types/workflow';

export const DEFAULT_WORKFLOW_PAGE_SIZE = 50;
export const MAX_WORKFLOW_PAGE_SIZE = 100;
export const DEFAULT_REVIEW_ISSUE_PREVIEW = 8;
export const MAX_TIMELINE_TEXT_LENGTH = 500;
export const MAX_TIMELINE_JSON_LENGTH = 256_000;

export type WorkflowPanelTab = 'plan' | 'review' | 'team' | 'timeline';

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

export interface WorkflowPanelPageRequest {
  projectId: string;
  taskId?: string;
  limit: number;
  offset: number;
}

export type WorkflowPanelPage = WorkflowPage<WorkflowSummary>;

export type AgentPresentationStatus = WorkflowStageStatus | 'paused';

export interface AgentTeamPresentation {
  agent: AgentType;
  label: string;
  status: AgentPresentationStatus;
  statusLabel: string;
  round: number | null;
  detail: string;
}

export interface AgentTimelineDetail {
  label: string;
  value: string;
}

export interface AgentTimelinePermissionPresentation {
  toolName: string;
  decision: string;
  createdAt: string;
}

export interface AgentTimelinePresentation {
  id: string;
  agent: AgentType;
  agentLabel: string;
  title: string;
  status: AgentPresentationStatus;
  statusLabel: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'error';
  round: number;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  summary: string | null;
  details: AgentTimelineDetail[];
  inputDetails: AgentTimelineDetail[];
  outputDetails: AgentTimelineDetail[];
  errorDetails: AgentTimelineDetail[];
  permissionCount: number;
  permissions: AgentTimelinePermissionPresentation[];
}

export interface WorkflowRequestToken {
  readonly identity: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}

const AGENT_ORDER: readonly AgentType[] = ['planner', 'coder', 'tester', 'reviewer'];
const UNSAFE_EVENT_TYPES = new Set(['assistant_text', 'system_init']);
const MAX_TIMELINE_PERMISSION_PREVIEW = 20;

const STATUS_LABELS: Readonly<Record<WorkflowStatus, string>> = {
  idle: '等待开始',
  planning: '规划中',
  waiting_plan_confirmation: '等待确认计划',
  executing: '执行中',
  testing: '测试中',
  reviewing: '审查中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const STAGE_LABELS: Readonly<Record<AgentType, string>> = {
  planner: 'Planner',
  coder: 'Coder',
  tester: 'Tester',
  reviewer: 'Reviewer',
};

const STAGE_STATUS_LABELS: Readonly<Record<AgentPresentationStatus, string>> = {
  pending: '等待',
  running: '进行中',
  interrupted: '异常中断',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过',
  paused: '已暂停',
};

const RISK_LABELS: Readonly<Record<RiskLevel, string>> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

const SEVERITY_LABELS: Readonly<Record<ReviewSeverity, string>> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  suggestion: '建议',
};

function finiteInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.trunc(value);
}

export function clampWorkflowPageSize(value?: number): number {
  const normalized = finiteInteger(value ?? DEFAULT_WORKFLOW_PAGE_SIZE, DEFAULT_WORKFLOW_PAGE_SIZE);
  return Math.min(MAX_WORKFLOW_PAGE_SIZE, Math.max(1, normalized));
}

export function normalizeWorkflowOffset(
  offset: number,
  pageSize: number,
  total?: number,
): number {
  const size = clampWorkflowPageSize(pageSize);
  let normalized = Math.floor(Math.max(0, finiteInteger(offset, 0)) / size) * size;
  if (total !== undefined && Number.isFinite(total)) {
    const count = Math.max(0, Math.trunc(total));
    const last = count === 0 ? 0 : Math.floor((count - 1) / size) * size;
    normalized = Math.min(normalized, last);
  }
  return normalized;
}

export function workflowPageCount(total: number, pageSize: number): number {
  const count = Math.max(0, finiteInteger(total, 0));
  return Math.max(1, Math.ceil(count / clampWorkflowPageSize(pageSize)));
}

export function workflowPageNumber(offset: number, pageSize: number): number {
  const size = clampWorkflowPageSize(pageSize);
  return Math.floor(Math.max(0, finiteInteger(offset, 0)) / size) + 1;
}

export function workflowReviewIdentity(workflowId: string, revision: number): string {
  return `${workflowId}:${finiteInteger(revision, 0)}`;
}

export function shouldLoadWorkflowReview(
  tab: WorkflowPanelTab,
  workflowId: string | null,
  revision: number,
  cachedIdentity: string | null,
): boolean {
  if (tab !== 'review' || !workflowId) return false;
  return workflowReviewIdentity(workflowId, revision) !== cachedIdentity;
}

export function workflowStatusLabel(status: WorkflowStatus): string {
  return STATUS_LABELS[status];
}

export function agentLabel(agent: AgentType): string {
  return STAGE_LABELS[agent];
}

export function agentStatusLabel(status: AgentPresentationStatus): string {
  return STAGE_STATUS_LABELS[status];
}

export function riskLabel(risk: RiskLevel): string {
  return RISK_LABELS[risk];
}

export function severityLabel(severity: ReviewSeverity): string {
  return SEVERITY_LABELS[severity];
}

export function reviewLocation(issue: ReviewIssue): string {
  if (!issue.file) return '全局';
  return issue.line === null ? issue.file : `${issue.file}:${issue.line}`;
}

export function reviewScoreTone(score: number): 'success' | 'warning' | 'error' {
  if (!Number.isFinite(score) || score < 6) return 'error';
  if (score < 8) return 'warning';
  return 'success';
}

export function unresolvedReviewIssues(review: ReviewReport): ReviewIssue[] {
  return review.issues.filter((issue) => !issue.resolved);
}

export function visibleReviewIssues(
  review: ReviewReport,
  expanded: boolean,
  limit = DEFAULT_REVIEW_ISSUE_PREVIEW,
): ReviewIssue[] {
  if (expanded) return review.issues;
  return review.issues.slice(0, Math.max(1, finiteInteger(limit, DEFAULT_REVIEW_ISSUE_PREVIEW)));
}

export function reviewExportFileName(workflowId: string, review: ReviewReport): string {
  const safeId = workflowId.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'workflow';
  return `${safeId}-review-round-${Math.max(0, finiteInteger(review.round, 0))}.md`;
}

export function reviewToMarkdown(review: ReviewReport, workflow?: Pick<Workflow, 'id' | 'prompt'>): string {
  const lines = [
    `# Workflow Review${workflow ? ` · ${workflow.id}` : ''}`,
    '',
    `- 评分：${review.score}/10`,
    `- 轮次：${review.round}`,
    `- 测试：${review.tests.passed} 通过 / ${review.tests.failed} 失败${review.tests.skipped === undefined ? '' : ` / ${review.tests.skipped} 跳过`}`,
    '',
  ];
  if (workflow?.prompt) lines.push(`> ${workflow.prompt.replaceAll('\n', ' ')}`, '');
  lines.push('## 总结', '', review.summary || '无总结', '', '## 问题', '');
  if (review.issues.length === 0) {
    lines.push('未发现问题。', '');
  } else {
    for (const issue of review.issues) {
      lines.push(
        `### [${severityLabel(issue.severity)}] ${issue.title}`,
        '',
        `- 位置：${reviewLocation(issue)}`,
        `- 状态：${issue.resolved ? '已处理' : '待处理'}`,
        `- 建议：${issue.recommendation}`,
        '',
      );
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function latestRecordByAgent(stages: readonly WorkflowStageRecord[]): Map<AgentType, WorkflowStageRecord> {
  const latest = new Map<AgentType, WorkflowStageRecord>();
  for (const stage of stages) {
    const previous = latest.get(stage.stage);
    if (!previous) {
      latest.set(stage.stage, stage);
      continue;
    }
    const stageTime = stage.startedAt ?? stage.completedAt ?? '';
    const previousTime = previous.startedAt ?? previous.completedAt ?? '';
    if (
      stage.round > previous.round
      || (stage.round === previous.round && stageTime > previousTime)
      || (stage.round === previous.round && stageTime === previousTime && stage.id > previous.id)
    ) latest.set(stage.stage, stage);
  }
  return latest;
}

function inferredActiveAgent(workflow: Workflow): AgentType | null {
  if (workflow.currentStage) return workflow.currentStage;
  if (workflow.status === 'planning' || workflow.status === 'waiting_plan_confirmation') return 'planner';
  if (workflow.status === 'executing') return 'coder';
  if (workflow.status === 'testing') return 'tester';
  if (workflow.status === 'reviewing') return 'reviewer';
  return null;
}

function inferredAgentStatus(workflow: Workflow, agent: AgentType): AgentPresentationStatus {
  if (workflow.status === 'completed') return 'completed';
  const activeAgent = inferredActiveAgent(workflow);
  const activeIndex = activeAgent ? AGENT_ORDER.indexOf(activeAgent) : -1;
  const agentIndex = AGENT_ORDER.indexOf(agent);
  if (workflow.status === 'paused' && activeAgent === agent) return 'paused';
  if (workflow.status === 'failed' && (workflow.failure?.stage ?? activeAgent) === agent) return 'failed';
  if (workflow.status === 'cancelled' && activeAgent === agent) return 'cancelled';
  if (activeAgent === agent) {
    return workflow.status === 'waiting_plan_confirmation' ? 'completed' : 'running';
  }
  if (activeIndex > agentIndex) return 'completed';
  return 'pending';
}

export function buildAgentTeam(
  workflow: Workflow,
  stages: readonly WorkflowStageRecord[],
): AgentTeamPresentation[] {
  const latest = latestRecordByAgent(stages);
  return AGENT_ORDER.map((agent) => {
    const record = latest.get(agent);
    let status: AgentPresentationStatus = record?.status ?? inferredAgentStatus(workflow, agent);
    if (workflow.status === 'paused' && inferredActiveAgent(workflow) === agent) status = 'paused';
    const fixDetail = agent === 'coder' && workflow.fixRound > 0
      ? `修复轮次 ${workflow.fixRound}/${workflow.maxFixRounds}`
      : null;
    const round = record?.round ?? null;
    const detail = fixDetail ?? (round === null ? '尚未启动' : `第 ${round} 轮`);
    return {
      agent,
      label: STAGE_LABELS[agent],
      status,
      statusLabel: STAGE_STATUS_LABELS[status],
      round,
      detail,
    };
  });
}

function safeRecord(json: string | null): Record<string, unknown> | null {
  if (!json || json.length > MAX_TIMELINE_JSON_LENGTH) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === 'string'
      ? record.type
      : typeof record.eventType === 'string' ? record.eventType : null;
    return type && UNSAFE_EVENT_TYPES.has(type) ? null : record;
  } catch {
    return null;
  }
}

function safeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.length <= MAX_TIMELINE_TEXT_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_TIMELINE_TEXT_LENGTH)}…`;
}

function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function arrayStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = safeText(item);
    return text ? [text] : [];
  });
}

function testSummary(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const tests = value as Record<string, unknown>;
  const passed = finiteCount(tests.passed);
  const failed = finiteCount(tests.failed);
  const skipped = finiteCount(tests.skipped);
  if (passed === null && failed === null && skipped === null) return null;
  return `${passed ?? 0} 通过 / ${failed ?? 0} 失败${skipped === null ? '' : ` / ${skipped} 跳过`}`;
}

function outputDetailsFromRecord(record: Record<string, unknown> | null): AgentTimelineDetail[] {
  if (!record) return [];
  const details: AgentTimelineDetail[] = [];
  const title = safeText(record.title);
  const summary = safeText(record.summary);
  const message = safeText(record.message);
  const model = safeText(record.model);
  if (title) details.push({ label: '标题', value: title });
  if (summary) details.push({ label: '摘要', value: summary });
  if (!summary && message) details.push({ label: '说明', value: message });
  if (model) details.push({ label: '模型', value: model });

  const files = arrayStrings(record.filesChanged ?? record.files ?? record.filesExpected);
  if (files.length > 0) {
    const preview = files.slice(0, 3).join('、');
    details.push({ label: '文件', value: `${files.length} 个${preview ? ` · ${preview}` : ''}` });
  }
  const steps = Array.isArray(record.steps) ? record.steps.length : null;
  if (steps !== null) details.push({ label: '步骤', value: `${steps} 项` });
  const tests = testSummary(record.tests) ?? testSummary(record);
  if (tests) details.push({ label: '测试', value: tests });
  const score = typeof record.score === 'number'
    && Number.isFinite(record.score)
    && record.score >= 0
    && record.score <= 10
    ? record.score
    : null;
  if (score !== null) details.push({ label: '评分', value: `${score}/10` });
  if (Array.isArray(record.issues)) details.push({ label: '问题', value: `${record.issues.length} 项` });
  return details;
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Input is deliberately narrower than output: never surface the persisted JSON object itself. */
function inputDetailsFromRecord(record: Record<string, unknown> | null): AgentTimelineDetail[] {
  if (!record) return [];
  const details: AgentTimelineDetail[] = [];
  const kind = safeText(record.kind);
  const goal = safeText(record.goal);
  const model = safeText(record.model);
  const plan = nestedRecord(record.plan) ?? nestedRecord(record.previousPlan);
  const planTitle = safeText(plan?.title);
  if (kind) details.push({ label: 'Kind', value: kind });
  if (goal) details.push({ label: 'Goal', value: goal });
  if (planTitle) details.push({ label: 'Plan', value: planTitle });
  if (model) details.push({ label: 'Model', value: model });
  return details;
}

function permissionPresentation(
  stage: WorkflowStageRecord,
): AgentTimelinePermissionPresentation[] {
  return (stage.permissions ?? [])
    .slice(0, MAX_TIMELINE_PERMISSION_PREVIEW)
    .flatMap((permission) => {
      const toolName = safeText(permission.toolName);
      const decision = safeText(permission.decision);
      const createdAt = safeText(permission.createdAt);
      return toolName && decision
        ? [{ toolName, decision, createdAt: createdAt ?? '' }]
        : [];
    });
}

function timelineTone(status: AgentPresentationStatus): AgentTimelinePresentation['tone'] {
  if (status === 'completed') return 'success';
  if (status === 'running') return 'info';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'paused') return 'warning';
  if (status === 'interrupted') return 'warning';
  return 'neutral';
}

function parsedTime(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function buildAgentTimeline(
  stages: readonly WorkflowStageRecord[],
): AgentTimelinePresentation[] {
  return [...stages]
    .sort((left, right) => {
      const leftTime = parsedTime(left.startedAt) ?? parsedTime(left.completedAt) ?? 0;
      const rightTime = parsedTime(right.startedAt) ?? parsedTime(right.completedAt) ?? 0;
      return leftTime - rightTime || left.round - right.round || left.id.localeCompare(right.id);
    })
    .map((stage) => {
      const output = safeRecord(stage.outputJson);
      const input = safeRecord(stage.inputJson);
      const outputDetails = outputDetailsFromRecord(output);
      const inputDetails = inputDetailsFromRecord(input);
      const errorDetails: AgentTimelineDetail[] = [];
      const details = [...outputDetails, ...inputDetails];
      const error = safeText(stage.error);
      if (error) details.push({ label: '错误', value: error });
      if (error) errorDetails.push({ label: 'Error', value: error });
      const permissions = permissionPresentation(stage);
      const started = parsedTime(stage.startedAt);
      const completed = parsedTime(stage.completedAt);
      const durationMs = started !== null && completed !== null
        ? Math.max(0, completed - started)
        : null;
      const summary = details.find((detail) => detail.label === '摘要' || detail.label === '说明')?.value ?? null;
      return {
        id: stage.id,
        agent: stage.stage,
        agentLabel: STAGE_LABELS[stage.stage],
        title: `${STAGE_LABELS[stage.stage]} · 第 ${stage.round} 轮`,
        status: stage.status,
        statusLabel: STAGE_STATUS_LABELS[stage.status],
        tone: timelineTone(stage.status),
        round: stage.round,
        startedAt: stage.startedAt,
        completedAt: stage.completedAt,
        durationMs,
        summary,
        details,
        inputDetails,
        outputDetails,
        errorDetails,
        permissionCount: stage.permissions?.length ?? 0,
        permissions,
      };
    });
}

export function formatWorkflowTimestamp(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTimelineDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  if (durationMs < 1_000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 100) / 10;
  return `${seconds}s`;
}

export function planStepCount(plan: ExecutionPlan | null): number {
  return plan?.steps.length ?? 0;
}

export class WorkflowRequestGate {
  private generation = 0;
  private current: { token: WorkflowRequestToken; controller: AbortController } | null = null;

  begin(identity: string): WorkflowRequestToken {
    this.current?.controller.abort();
    const controller = new AbortController();
    const token: WorkflowRequestToken = {
      identity,
      generation: ++this.generation,
      signal: controller.signal,
    };
    this.current = { token, controller };
    return token;
  }

  isCurrent(token: WorkflowRequestToken): boolean {
    return Boolean(
      this.current
      && this.current.token.generation === token.generation
      && this.current.token.identity === token.identity
      && !token.signal.aborted,
    );
  }

  cancel(token?: WorkflowRequestToken): void {
    if (token && !this.isCurrent(token)) return;
    this.current?.controller.abort();
    this.current = null;
    this.generation += 1;
  }

  activeIdentity(): string | null {
    return this.current?.token.identity ?? null;
  }
}
