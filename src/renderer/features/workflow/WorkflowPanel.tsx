import React, {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Code2,
  Download,
  FileCode2,
  FlaskConical,
  LoaderCircle,
  Pencil,
  Play,
  RefreshCw,
  SearchCheck,
  ShieldAlert,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';
import type {
  AgentType,
  ExecutionPlan,
  ReviewIssue,
  ReviewReport,
  Workflow,
  WorkflowStageRecord,
} from '../../../shared/types/workflow';
import {
  AgentTimelineDetail,
  AgentTimelinePresentation,
  AgentTeamPresentation,
  DEFAULT_REVIEW_ISSUE_PREVIEW,
  WorkflowPanelPage,
  WorkflowPanelPageRequest,
  WorkflowPanelTab,
  WorkflowRequestGate,
  WorkflowSummary,
  buildAgentTeam,
  buildAgentTimeline,
  clampWorkflowPageSize,
  formatTimelineDuration,
  formatWorkflowTimestamp,
  normalizeWorkflowOffset,
  reviewExportFileName,
  reviewLocation,
  reviewScoreTone,
  reviewToMarkdown,
  riskLabel,
  severityLabel,
  shouldLoadWorkflowReview,
  unresolvedReviewIssues,
  visibleReviewIssues,
  workflowPageCount,
  workflowPageNumber,
  workflowReviewIdentity,
  workflowStatusLabel,
} from './workflowPresentation';

export interface WorkflowPanelProps {
  projectId: string | null;
  taskId?: string | null;
  selectedWorkflowId?: string | null;
  initialTab?: WorkflowPanelTab;
  pageSize?: number;
  refreshToken?: string | number;
  className?: string;
  loadWorkflowPage: (
    request: WorkflowPanelPageRequest,
    signal: AbortSignal,
  ) => Promise<WorkflowPanelPage>;
  loadWorkflow: (workflowId: string, signal: AbortSignal) => Promise<Workflow>;
  loadWorkflowStages: (
    workflowId: string,
    signal: AbortSignal,
  ) => Promise<readonly WorkflowStageRecord[]>;
  loadWorkflowReview: (
    workflowId: string,
    signal: AbortSignal,
  ) => Promise<ReviewReport | null>;
  onSelectWorkflow?: (workflowId: string) => void;
  onStartExecution?: (workflow: Workflow) => void | Promise<void>;
  onModifyPlan?: (workflow: Workflow, plan: ExecutionPlan) => void | Promise<void>;
  onCancelWorkflow?: (workflow: Workflow) => void | Promise<void>;
  onApplyReviewFix?: (
    workflow: Workflow,
    review: ReviewReport,
    issue?: ReviewIssue,
  ) => void | Promise<void>;
  onIgnoreReview?: (
    workflow: Workflow,
    review: ReviewReport,
    issue?: ReviewIssue,
  ) => void | Promise<void>;
  onExportReview?: (
    workflow: Workflow,
    review: ReviewReport,
    markdown: string,
    fileName: string,
  ) => void;
  onActionCompleted?: (workflowId: string, action: WorkflowAction) => void;
}

export type WorkflowAction =
  | 'start_execution'
  | 'modify_plan'
  | 'cancel'
  | 'apply_fix'
  | 'ignore_review';

export interface WorkflowListProps {
  items: readonly WorkflowSummary[];
  selectedId: string | null;
  total: number;
  offset: number;
  pageSize: number;
  loading: boolean;
  onSelect: (workflowId: string) => void;
  onPageChange: (offset: number) => void;
  onRefresh: () => void;
}

export interface PlanReviewProps {
  workflow: Workflow;
  pendingAction: WorkflowAction | null;
  onStartExecution?: () => void;
  onModifyPlan?: () => void;
  onCancel?: () => void;
}

export interface WorkflowReviewProps {
  workflow: Workflow;
  review: ReviewReport | null;
  loading: boolean;
  error: string | null;
  pendingAction: WorkflowAction | null;
  issuePreviewLimit?: number;
  onApplyFix?: (issue?: ReviewIssue) => void;
  onIgnore?: (issue?: ReviewIssue) => void;
  onExport?: () => void;
}

export interface AgentTeamProps {
  members: readonly AgentTeamPresentation[];
}

export interface WorkflowAgentTimelineProps {
  items: readonly AgentTimelinePresentation[];
  defaultExpandedIds?: readonly string[];
}

const EMPTY_PAGE: WorkflowPanelPage = {
  items: [],
  total: 0,
  limit: 50,
  offset: 0,
};

const TABS: readonly { id: WorkflowPanelTab; label: string }[] = [
  { id: 'plan', label: '计划' },
  { id: 'review', label: 'Review' },
  { id: 'team', label: 'Agent Team' },
  { id: 'timeline', label: 'Timeline' },
];

const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function statusColor(status: string): string {
  if (status === 'completed') return 'var(--success)';
  if (status === 'failed' || status === 'cancelled') return 'var(--error)';
  if (status === 'running' || status === 'executing' || status === 'testing' || status === 'reviewing' || status === 'planning') return 'var(--info)';
  if (status === 'paused' || status === 'waiting_plan_confirmation') return 'var(--warning)';
  return 'var(--text-tertiary)';
}

function riskColor(risk: string): string {
  if (risk === 'high') return 'var(--error)';
  if (risk === 'medium') return 'var(--warning)';
  return 'var(--success)';
}

function severityColor(severity: string): string {
  if (severity === 'critical' || severity === 'high') return 'var(--error)';
  if (severity === 'medium') return 'var(--warning)';
  if (severity === 'low') return 'var(--info)';
  return 'var(--text-tertiary)';
}

function agentIcon(agent: AgentType): React.ReactNode {
  if (agent === 'planner') return <Sparkles size={15} />;
  if (agent === 'coder') return <Code2 size={15} />;
  if (agent === 'tester') return <FlaskConical size={15} />;
  return <SearchCheck size={15} />;
}

function ActionSpinner({ active }: { active: boolean }) {
  return active ? <LoaderCircle aria-hidden size={12} className="animate-spin" /> : null;
}

export const WorkflowList = memo(function WorkflowList({
  items,
  selectedId,
  total,
  offset,
  pageSize,
  loading,
  onSelect,
  onPageChange,
  onRefresh,
}: WorkflowListProps) {
  const page = workflowPageNumber(offset, pageSize);
  const pageCount = workflowPageCount(total, pageSize);
  const lastOffset = Math.max(0, (pageCount - 1) * pageSize);
  return (
    <aside className="flex min-h-0 w-72 flex-shrink-0 flex-col border-r" style={{ borderColor: 'var(--border-primary)' }} data-testid="workflow-list-pane">
      <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--border-secondary)' }}>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold">Workflows</div>
          <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{total.toLocaleString()} 个工作流</div>
        </div>
        <button type="button" onClick={onRefresh} aria-label="刷新 Workflow 列表" className="rounded p-1" disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-hidden" data-testid="workflow-list">
        {items.map((item) => {
          const selected = selectedId === item.id;
          return (
            <button
              type="button"
              key={item.id}
              onClick={() => onSelect(item.id)}
              aria-current={selected ? 'true' : undefined}
              data-testid="workflow-list-item"
              data-workflow-id={item.id}
              className="mb-1.5 block w-full rounded-lg border px-3 py-2 text-left"
              style={{
                background: selected ? 'var(--bg-active)' : 'var(--bg-card)',
                borderColor: selected ? 'var(--accent)' : 'var(--border-secondary)',
                contentVisibility: 'auto',
                containIntrinsicSize: '0 82px',
              }}
            >
              <div className="flex items-center gap-2">
                <span className="status-dot" style={{ background: statusColor(item.status) }} />
                <span className="truncate text-xs font-medium">{item.prompt || '未命名 Workflow'}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                <span>{workflowStatusLabel(item.status)}</span>
                <span className="ml-auto">{formatWorkflowTimestamp(item.updatedAt)}</span>
              </div>
            </button>
          );
        })}
        {!loading && items.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs" style={{ color: 'var(--text-disabled)' }} data-testid="workflow-empty-list">
            当前范围没有 Workflow
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-center gap-1 border-t px-2 py-2" style={{ borderColor: 'var(--border-secondary)' }} data-testid="workflow-pagination">
        <button type="button" aria-label="第一页" onClick={() => onPageChange(0)} disabled={loading || offset === 0} className="rounded p-1 disabled:opacity-30"><ChevronsLeft size={12} /></button>
        <button type="button" aria-label="上一页" onClick={() => onPageChange(Math.max(0, offset - pageSize))} disabled={loading || offset === 0} className="rounded p-1 disabled:opacity-30"><ChevronLeft size={12} /></button>
        <span className="min-w-16 text-center text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{page} / {pageCount}</span>
        <button type="button" aria-label="下一页" onClick={() => onPageChange(Math.min(lastOffset, offset + pageSize))} disabled={loading || offset + pageSize >= total} className="rounded p-1 disabled:opacity-30"><ChevronRight size={12} /></button>
        <button type="button" aria-label="最后一页" onClick={() => onPageChange(lastOffset)} disabled={loading || offset + pageSize >= total} className="rounded p-1 disabled:opacity-30"><ChevronsRight size={12} /></button>
      </div>
    </aside>
  );
});

export const PlanReview = memo(function PlanReview({
  workflow,
  pendingAction,
  onStartExecution,
  onModifyPlan,
  onCancel,
}: PlanReviewProps) {
  const [showAllFiles, setShowAllFiles] = useState(false);
  const plan = workflow.plan;
  if (!plan) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center" data-testid="workflow-plan-empty">
        <div>
          <Sparkles size={24} className="mx-auto mb-3" style={{ color: 'var(--accent)' }} />
          <div className="text-sm font-medium">Planner 正在准备执行计划</div>
          <div className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>计划生成后可在这里确认、修改或取消。</div>
        </div>
      </div>
    );
  }
  const visibleFiles = showAllFiles ? plan.filesExpected : plan.filesExpected.slice(0, 6);
  const canStart = workflow.status === 'waiting_plan_confirmation';
  const canCancel = !TERMINAL_WORKFLOW_STATUSES.has(workflow.status);
  return (
    <section className="space-y-4 p-4" data-testid="workflow-plan-review">
      <header className="rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{plan.title}</h2>
            <p className="selectable mt-1 whitespace-pre-wrap text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{plan.summary}</p>
          </div>
          <span className="rounded-full px-2 py-1 text-[10px] font-medium" style={{ color: riskColor(plan.riskLevel), background: 'var(--bg-hover)' }} data-risk={plan.riskLevel}>
            {riskLabel(plan.riskLevel)}
          </span>
        </div>
        <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2">
          <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-hover)' }}><span style={{ color: 'var(--text-tertiary)' }}>预计改动</span><div className="mt-0.5">{plan.estimatedChanges}</div></div>
          <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-hover)' }}><span style={{ color: 'var(--text-tertiary)' }}>计划步骤</span><div className="mt-0.5">{plan.steps.length} 项</div></div>
        </div>
      </header>

      <div className="rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
        <h3 className="text-xs font-semibold">执行步骤</h3>
        <ol className="mt-3 space-y-2">
          {plan.steps.map((step) => (
            <li key={step.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--border-secondary)', contentVisibility: 'auto', containIntrinsicSize: '0 70px' }} data-testid="workflow-plan-step">
              <div className="flex items-start gap-2">
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full text-[10px] font-semibold" style={{ background: 'var(--accent-light)', color: 'var(--accent)' }}>{step.id}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium">{step.title}</span>
                    <span className="rounded px-1.5 py-0.5 text-[9px]" style={{ color: riskColor(step.risk), background: 'var(--bg-hover)' }}>{riskLabel(step.risk)}</span>
                  </div>
                  {step.description ? <p className="selectable mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{step.description}</p> : null}
                  {step.acceptanceCriteria && step.acceptanceCriteria.length > 0 ? (
                    <ul className="mt-1 list-disc pl-4 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                      {step.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}
                    </ul>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
        <div className="flex items-center gap-2">
          <FileCode2 size={14} style={{ color: 'var(--accent)' }} />
          <h3 className="text-xs font-semibold">预计文件</h3>
          <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{plan.filesExpected.length}</span>
        </div>
        {visibleFiles.length > 0 ? (
          <ul className="selectable mt-2 space-y-1 font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>
            {visibleFiles.map((file) => <li key={file} className="truncate">{file}</li>)}
          </ul>
        ) : <div className="mt-2 text-[11px]" style={{ color: 'var(--text-disabled)' }}>未预估具体文件</div>}
        {plan.filesExpected.length > 6 ? (
          <button type="button" className="mt-2 text-[10px]" style={{ color: 'var(--accent)' }} onClick={() => setShowAllFiles((value) => !value)}>
            {showAllFiles ? '收起文件' : `展开其余 ${plan.filesExpected.length - 6} 个文件`}
          </button>
        ) : null}
      </div>

      <footer className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 rounded-xl border p-3" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)', boxShadow: 'var(--shadow-sm)' }}>
        {onCancel && canCancel ? (
          <button type="button" onClick={onCancel} disabled={pendingAction !== null} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs disabled:opacity-40" style={{ color: 'var(--error)', background: 'var(--error-bg)' }} data-testid="workflow-cancel">
            <ActionSpinner active={pendingAction === 'cancel'} /><X size={12} />取消
          </button>
        ) : null}
        {onModifyPlan ? (
          <button type="button" onClick={onModifyPlan} disabled={pendingAction !== null} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs disabled:opacity-40" style={{ background: 'var(--bg-hover)' }} data-testid="workflow-modify-plan">
            <ActionSpinner active={pendingAction === 'modify_plan'} /><Pencil size={12} />修改计划
          </button>
        ) : null}
        {onStartExecution ? (
          <button type="button" onClick={onStartExecution} disabled={!canStart || pendingAction !== null} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-white disabled:opacity-40" style={{ background: 'var(--accent)' }} data-testid="workflow-start-execution">
            <ActionSpinner active={pendingAction === 'start_execution'} /><Play size={12} />开始执行
          </button>
        ) : null}
      </footer>
    </section>
  );
});

export const WorkflowReview = memo(function WorkflowReview({
  workflow,
  review,
  loading,
  error,
  pendingAction,
  issuePreviewLimit = DEFAULT_REVIEW_ISSUE_PREVIEW,
  onApplyFix: requestedApplyFix,
  onIgnore: requestedIgnore,
  onExport,
}: WorkflowReviewProps) {
  const [expanded, setExpanded] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  if (loading) {
    return <div className="flex h-full items-center justify-center gap-2 text-xs" data-testid="workflow-review-loading"><LoaderCircle size={14} className="animate-spin" />正在按需加载 Review…</div>;
  }
  if (error) {
    return <div className="m-4 rounded-lg px-3 py-3 text-xs" style={{ color: 'var(--error)', background: 'var(--error-bg)' }} data-testid="workflow-review-error"><AlertCircle size={13} className="mr-1 inline" />{error}</div>;
  }
  if (!review) {
    return <div className="flex h-full items-center justify-center p-8 text-center text-xs" style={{ color: 'var(--text-disabled)' }} data-testid="workflow-review-empty">Reviewer 尚未生成报告</div>;
  }
  const visible = visibleReviewIssues(review, expanded, issuePreviewLimit);
  const unresolved = unresolvedReviewIssues(review);
  const canResolvePausedReview = workflow.status === 'paused'
    && workflow.pausedFrom === 'reviewing'
    && workflow.reviewRound >= workflow.maxFixRounds
    && review.round === workflow.reviewRound
    && unresolved.length > 0;
  const onApplyFix = canResolvePausedReview ? requestedApplyFix : undefined;
  const onIgnore = canResolvePausedReview ? requestedIgnore : undefined;
  const scoreTone = reviewScoreTone(review.score);
  const scoreColor = scoreTone === 'success' ? 'var(--success)' : scoreTone === 'warning' ? 'var(--warning)' : 'var(--error)';
  const longSummary = review.summary.length > 600;
  const visibleSummary = longSummary && !summaryExpanded
    ? `${review.summary.slice(0, 600)}…`
    : review.summary;
  return (
    <section className="space-y-4 p-4" data-testid="workflow-review">
      <header className="rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
        <div className="flex items-center gap-3">
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full text-lg font-bold" style={{ color: scoreColor, background: 'var(--bg-hover)' }} data-testid="workflow-review-score">{review.score}</div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">Review · 第 {review.round} 轮</h2><span className="text-[10px]" style={{ color: scoreColor }}>{review.score}/10</span></div>
            <p className="selectable mt-1 whitespace-pre-wrap text-xs" style={{ color: 'var(--text-secondary)' }}>{visibleSummary}</p>
            {longSummary ? <button type="button" className="mt-1 text-[10px]" style={{ color: 'var(--accent)' }} onClick={() => setSummaryExpanded((value) => !value)}>{summaryExpanded ? '收起 Review 总结' : '展开完整 Review 总结'}</button> : null}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]" data-testid="workflow-review-tests">
          <div className="rounded-lg px-2 py-2" style={{ background: 'var(--bg-hover)' }}><div className="font-semibold" style={{ color: 'var(--success)' }}>{review.tests.passed}</div><div style={{ color: 'var(--text-tertiary)' }}>通过</div></div>
          <div className="rounded-lg px-2 py-2" style={{ background: 'var(--bg-hover)' }}><div className="font-semibold" style={{ color: 'var(--error)' }}>{review.tests.failed}</div><div style={{ color: 'var(--text-tertiary)' }}>失败</div></div>
          <div className="rounded-lg px-2 py-2" style={{ background: 'var(--bg-hover)' }}><div className="font-semibold">{review.tests.skipped ?? 0}</div><div style={{ color: 'var(--text-tertiary)' }}>跳过</div></div>
        </div>
      </header>

      <div className="rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
        <div className="flex items-center gap-2"><ShieldAlert size={14} /><h3 className="text-xs font-semibold">问题清单</h3><span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{unresolved.length} 待处理 / {review.issues.length} 总计</span></div>
        <div className="mt-3 space-y-2" data-testid="workflow-review-issues">
          {visible.map((issue, index) => (
            <article key={issue.id ?? `${issue.file ?? 'global'}:${issue.line ?? 0}:${issue.title}:${index}`} className="rounded-lg border p-3" style={{ borderColor: 'var(--border-secondary)', contentVisibility: 'auto', containIntrinsicSize: '0 116px' }} data-testid="workflow-review-issue" data-severity={issue.severity}>
              <div className="flex items-start gap-2">
                {issue.resolved ? <CheckCircle2 size={13} style={{ color: 'var(--success)' }} /> : <AlertCircle size={13} style={{ color: severityColor(issue.severity) }} />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="rounded px-1.5 py-0.5 text-[9px] font-medium" style={{ color: severityColor(issue.severity), background: 'var(--bg-hover)' }}>{severityLabel(issue.severity)}</span><span className="text-xs font-medium">{issue.title}</span>{issue.resolved ? <span className="text-[9px]" style={{ color: 'var(--success)' }}>已处理</span> : null}</div>
                  <div className="selectable mt-1 truncate font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{reviewLocation(issue)}</div>
                  <p className="selectable mt-2 whitespace-pre-wrap text-[11px] leading-5" style={{ color: 'var(--text-secondary)' }}><span className="font-medium">建议：</span>{issue.recommendation}</p>
                </div>
              </div>
            </article>
          ))}
          {review.issues.length === 0 ? <div className="py-6 text-center text-xs" style={{ color: 'var(--success)' }}><Check size={13} className="mr-1 inline" />未发现问题</div> : null}
        </div>
        {review.issues.length > issuePreviewLimit ? (
          <button type="button" className="mt-3 inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--accent)' }} onClick={() => setExpanded((value) => !value)} data-testid="workflow-review-expand">
            <ChevronDown size={12} style={{ transform: expanded ? 'rotate(180deg)' : undefined }} />{expanded ? '收起大 Review' : `展开其余 ${review.issues.length - issuePreviewLimit} 项`}
          </button>
        ) : null}
      </div>

      <footer className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 rounded-xl border p-3" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)', boxShadow: 'var(--shadow-sm)' }}>
        {onExport ? <button type="button" onClick={onExport} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs" style={{ background: 'var(--bg-hover)' }} data-testid="workflow-export-review"><Download size={12} />导出</button> : null}
        {onIgnore ? <button type="button" onClick={() => onIgnore()} disabled={pendingAction !== null} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs disabled:opacity-40" style={{ background: 'var(--bg-hover)' }} data-testid="workflow-ignore-review"><ActionSpinner active={pendingAction === 'ignore_review'} />接受风险并完成</button> : null}
        {onApplyFix && unresolved.length > 0 ? <button type="button" onClick={() => onApplyFix()} disabled={pendingAction !== null} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-white disabled:opacity-40" style={{ background: 'var(--accent)' }} data-testid="workflow-apply-review-fix"><ActionSpinner active={pendingAction === 'apply_fix'} /><Code2 size={12} />交给 Coder 应用修复</button> : null}
      </footer>
      <span className="sr-only">Workflow {workflow.id}</span>
    </section>
  );
});

export const AgentTeam = memo(function AgentTeam({ members }: AgentTeamProps) {
  return (
    <section className="grid gap-3 p-4 sm:grid-cols-2" data-testid="workflow-agent-team">
      {members.map((member) => (
        <article key={member.agent} className="rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }} data-testid="workflow-agent-card" data-agent={member.agent} data-status={member.status}>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ color: statusColor(member.status), background: 'var(--bg-hover)' }}>{agentIcon(member.agent)}</span>
            <div className="min-w-0 flex-1"><div className="text-xs font-semibold">{member.label}</div><div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{member.detail}</div></div>
            <span className="rounded-full px-2 py-1 text-[10px]" style={{ color: statusColor(member.status), background: 'var(--bg-hover)' }}>{member.statusLabel}</span>
          </div>
        </article>
      ))}
    </section>
  );
});

function TimelineDetailSection({
  title,
  details,
  testId,
}: {
  title: string;
  details: readonly AgentTimelineDetail[];
  testId: string;
}) {
  if (details.length === 0) return null;
  return (
    <section data-testid={testId}>
      <h4 className="mb-1 font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h4>
      <dl className="space-y-1">
        {details.map((detail, index) => (
          <div key={`${detail.label}:${index}`} className="grid grid-cols-[56px_1fr] gap-2">
            <dt style={{ color: 'var(--text-tertiary)' }}>{detail.label}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>{detail.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export const WorkflowAgentTimeline = memo(function WorkflowAgentTimeline({
  items,
  defaultExpandedIds = [],
}: WorkflowAgentTimelineProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultExpandedIds));
  if (items.length === 0) {
    return <div className="flex h-full items-center justify-center p-8 text-xs" style={{ color: 'var(--text-disabled)' }} data-testid="workflow-timeline-empty">Agent 尚未产生阶段记录</div>;
  }
  return (
    <ol className="m-4 ml-7 border-l pl-5" style={{ borderColor: 'var(--border-secondary)' }} data-testid="workflow-agent-timeline">
      {items.map((item) => {
        const isExpanded = expanded.has(item.id);
        const duration = formatTimelineDuration(item.durationMs);
        const hasDetails = item.inputDetails.length > 0
          || item.outputDetails.length > 0
          || item.errorDetails.length > 0
          || item.permissionCount > 0;
        return (
          <li key={item.id} className="relative pb-4" style={{ contentVisibility: 'auto', containIntrinsicSize: '0 84px' }} data-testid="workflow-timeline-item" data-agent={item.agent} data-status={item.status}>
            <span className="absolute -left-[29px] top-1 flex h-4 w-4 items-center justify-center rounded-full" style={{ color: statusColor(item.status), background: 'var(--bg-primary)' }}>{agentIcon(item.agent)}</span>
            <article className="rounded-lg border p-3" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-secondary)' }}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium">{item.title}</span><span className="rounded px-1.5 py-0.5 text-[9px]" style={{ color: statusColor(item.status), background: 'var(--bg-hover)' }}>{item.statusLabel}</span></div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-[10px]" style={{ color: 'var(--text-tertiary)' }}><time>{formatWorkflowTimestamp(item.startedAt)}</time>{duration ? <span>{duration}</span> : null}</div>
                  {item.summary ? <p className="selectable mt-1 line-clamp-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{item.summary}</p> : null}
                </div>
                {hasDetails ? (
                  <button type="button" onClick={() => setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(item.id)) next.delete(item.id);
                    else next.add(item.id);
                    return next;
                  })} className="rounded p-1" aria-label={isExpanded ? `收起 ${item.title}` : `展开 ${item.title}`}>
                    <ChevronDown size={13} style={{ transform: isExpanded ? 'rotate(180deg)' : undefined }} />
                  </button>
                ) : null}
              </div>
              {isExpanded && hasDetails ? (
                <div className="selectable mt-3 space-y-3 border-t pt-2 text-[10px]" style={{ borderColor: 'var(--border-secondary)' }} data-testid="workflow-timeline-details">
                  <TimelineDetailSection title="Input (safe summary)" details={item.inputDetails} testId="workflow-timeline-input" />
                  <TimelineDetailSection title="Output (safe summary)" details={item.outputDetails} testId="workflow-timeline-output" />
                  {item.permissionCount > 0 ? (
                    <section data-testid="workflow-timeline-permissions">
                      <h4 className="mb-1 font-semibold" style={{ color: 'var(--text-primary)' }}>Permissions ({item.permissionCount})</h4>
                      <ul className="space-y-1">
                        {item.permissions.map((permission, index) => (
                          <li key={`${permission.toolName}:${permission.createdAt}:${index}`} className="flex flex-wrap gap-x-2">
                            <span className="font-medium">{permission.toolName}</span>
                            <code style={{ color: 'var(--accent)' }}>{permission.decision}</code>
                            {permission.createdAt ? <time style={{ color: 'var(--text-tertiary)' }}>{formatWorkflowTimestamp(permission.createdAt)}</time> : null}
                          </li>
                        ))}
                        {item.permissionCount > item.permissions.length ? (
                          <li style={{ color: 'var(--text-tertiary)' }}>+{item.permissionCount - item.permissions.length} more</li>
                        ) : null}
                      </ul>
                    </section>
                  ) : null}
                  <TimelineDetailSection title="Error" details={item.errorDetails} testId="workflow-timeline-error" />
                </div>
              ) : null}
            </article>
          </li>
        );
      })}
    </ol>
  );
});

export function WorkflowPanel({
  projectId,
  taskId = null,
  selectedWorkflowId,
  initialTab = 'plan',
  pageSize,
  refreshToken = 0,
  className = '',
  loadWorkflowPage,
  loadWorkflow,
  loadWorkflowStages,
  loadWorkflowReview,
  onSelectWorkflow,
  onStartExecution,
  onModifyPlan,
  onCancelWorkflow,
  onApplyReviewFix,
  onIgnoreReview,
  onExportReview,
  onActionCompleted,
}: WorkflowPanelProps) {
  const safePageSize = clampWorkflowPageSize(pageSize);
  const refreshIdentity = String(refreshToken);
  const normalizedTaskId = taskId || null;
  const controlledSelection = selectedWorkflowId !== undefined;
  const [tab, setTab] = useState<WorkflowPanelTab>(initialTab);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<WorkflowPanelPage>(() => ({ ...EMPTY_PAGE, limit: safePageSize }));
  const [pageScope, setPageScope] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageReload, setPageReload] = useState(0);
  const [internalSelection, setInternalSelection] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [stages, setStages] = useState<readonly WorkflowStageRecord[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [reviewState, setReviewState] = useState<{ identity: string | null; review: ReviewReport | null; loading: boolean; error: string | null }>({ identity: null, review: null, loading: false, error: null });
  const [pendingAction, setPendingAction] = useState<WorkflowAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pageGate = useRef(new WorkflowRequestGate());
  const detailGate = useRef(new WorkflowRequestGate());
  const reviewGate = useRef(new WorkflowRequestGate());
  const actionGeneration = useRef(0);

  const scopeIdentity = `${projectId ?? ''}\u0000${normalizedTaskId ?? ''}`;
  const visiblePage = pageScope === scopeIdentity
    ? page
    : { ...EMPTY_PAGE, limit: safePageSize };
  const effectiveSelection = controlledSelection ? selectedWorkflowId ?? null : internalSelection;
  const selectedSummary = useMemo(
    () => visiblePage.items.find((item) => item.id === effectiveSelection) ?? null,
    [effectiveSelection, visiblePage.items],
  );
  const visibleWorkflow = workflow?.id === effectiveSelection
    && workflow.projectId === projectId
    && (!normalizedTaskId || workflow.taskId === normalizedTaskId)
    && (!selectedSummary || workflow.revision >= selectedSummary.revision)
    ? workflow
    : null;
  const selectedRevision = selectedSummary?.revision ?? visibleWorkflow?.revision ?? 0;

  useEffect(() => {
    startTransition(() => setOffset(0));
    if (!controlledSelection) setInternalSelection(null);
  }, [controlledSelection, normalizedTaskId, projectId, safePageSize]);

  useEffect(() => {
    if (!projectId) {
      pageGate.current.cancel();
      setPage({ ...EMPTY_PAGE, limit: safePageSize });
      setPageScope(null);
      setPageLoading(false);
      setPageError(null);
      return;
    }
    const identity = `${projectId}\u0000${normalizedTaskId ?? ''}\u0000${safePageSize}\u0000${offset}\u0000${refreshIdentity}\u0000${pageReload}`;
    const token = pageGate.current.begin(identity);
    setPageLoading(true);
    setPageError(null);
    void loadWorkflowPage({
      projectId,
      taskId: normalizedTaskId ?? undefined,
      limit: safePageSize,
      offset,
    }, token.signal).then((loaded) => {
      if (!pageGate.current.isCurrent(token)) return;
      const total = Math.max(0, Math.trunc(loaded.total));
      const normalizedOffset = normalizeWorkflowOffset(loaded.offset, safePageSize, total);
      if (loaded.items.length === 0 && offset > normalizedOffset) {
        startTransition(() => setOffset(normalizedOffset));
        return;
      }
      const items = loaded.items.slice(0, safePageSize).filter((item) => (
        item.projectId === projectId && (!normalizedTaskId || item.taskId === normalizedTaskId)
      ));
      setPage({ items, total, limit: safePageSize, offset: normalizedOffset });
      setPageScope(scopeIdentity);
      if (!controlledSelection) {
        setInternalSelection((current) => (
          current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null
        ));
      }
    }).catch((error: unknown) => {
      if (!pageGate.current.isCurrent(token) || isAbortError(error)) return;
      setPageError(errorText(error, 'Workflow 列表加载失败'));
      setPage({ ...EMPTY_PAGE, limit: safePageSize, offset });
      setPageScope(scopeIdentity);
    }).finally(() => {
      if (pageGate.current.isCurrent(token)) setPageLoading(false);
    });
    return () => pageGate.current.cancel(token);
  }, [controlledSelection, loadWorkflowPage, normalizedTaskId, offset, pageReload, projectId, refreshIdentity, safePageSize, scopeIdentity]);

  useEffect(() => {
    if (!effectiveSelection) {
      detailGate.current.cancel();
      setWorkflow(null);
      setStages([]);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    const identity = `${effectiveSelection}\u0000${selectedSummary?.revision ?? 0}\u0000${refreshIdentity}`;
    const token = detailGate.current.begin(identity);
    setDetailLoading(true);
    setDetailError(null);
    setWorkflow(null);
    setStages([]);
    void Promise.all([
      loadWorkflow(effectiveSelection, token.signal),
      loadWorkflowStages(effectiveSelection, token.signal),
    ]).then(([loadedWorkflow, loadedStages]) => {
      if (!detailGate.current.isCurrent(token)) return;
      if (
        loadedWorkflow.id !== effectiveSelection
        || (projectId && loadedWorkflow.projectId !== projectId)
        || (normalizedTaskId && loadedWorkflow.taskId !== normalizedTaskId)
      ) throw new Error('Workflow 详情身份不匹配');
      setWorkflow(loadedWorkflow);
      setStages(loadedStages.filter((stage) => stage.workflowId === effectiveSelection));
    }).catch((error: unknown) => {
      if (!detailGate.current.isCurrent(token) || isAbortError(error)) return;
      setDetailError(errorText(error, 'Workflow 详情加载失败'));
    }).finally(() => {
      if (detailGate.current.isCurrent(token)) setDetailLoading(false);
    });
    return () => detailGate.current.cancel(token);
  }, [effectiveSelection, loadWorkflow, loadWorkflowStages, normalizedTaskId, projectId, refreshIdentity, selectedSummary?.revision]);

  useEffect(() => {
    const cachedIdentity = reviewState.identity;
    if (!shouldLoadWorkflowReview(tab, effectiveSelection, selectedRevision, cachedIdentity)) return;
    if (!effectiveSelection) return;
    const identity = workflowReviewIdentity(effectiveSelection, selectedRevision);
    const token = reviewGate.current.begin(identity);
    setReviewState({ identity, review: null, loading: true, error: null });
    void loadWorkflowReview(effectiveSelection, token.signal).then((loadedReview) => {
      if (!reviewGate.current.isCurrent(token)) return;
      if (loadedReview?.workflowId && loadedReview.workflowId !== effectiveSelection) {
        throw new Error('Workflow Review 身份不匹配');
      }
      setReviewState({ identity, review: loadedReview, loading: false, error: null });
    }).catch((error: unknown) => {
      if (!reviewGate.current.isCurrent(token) || isAbortError(error)) return;
      setReviewState({ identity, review: null, loading: false, error: errorText(error, 'Review 加载失败') });
    });
    return () => reviewGate.current.cancel(token);
  }, [effectiveSelection, loadWorkflowReview, selectedRevision, tab]);

  useEffect(() => {
    actionGeneration.current += 1;
    setPendingAction(null);
    setActionError(null);
  }, [effectiveSelection]);

  const selectWorkflow = useCallback((workflowId: string) => {
    if (!controlledSelection) setInternalSelection(workflowId);
    onSelectWorkflow?.(workflowId);
  }, [controlledSelection, onSelectWorkflow]);

  const changePage = useCallback((nextOffset: number) => {
    startTransition(() => setOffset(normalizeWorkflowOffset(nextOffset, safePageSize, visiblePage.total)));
  }, [safePageSize, visiblePage.total]);

  const refreshPage = useCallback(() => setPageReload((value) => value + 1), []);

  const runAction = useCallback(async (
    action: WorkflowAction,
    selected: Workflow,
    callback: () => void | Promise<void>,
  ) => {
    const generation = ++actionGeneration.current;
    setPendingAction(action);
    setActionError(null);
    try {
      await callback();
      if (actionGeneration.current !== generation || effectiveSelection !== selected.id) return;
      onActionCompleted?.(selected.id, action);
    } catch (error) {
      if (actionGeneration.current === generation && effectiveSelection === selected.id) {
        setActionError(errorText(error, 'Workflow 操作失败'));
      }
    } finally {
      if (actionGeneration.current === generation && effectiveSelection === selected.id) setPendingAction(null);
    }
  }, [effectiveSelection, onActionCompleted]);

  const startExecution = useCallback(() => {
    if (visibleWorkflow && onStartExecution) void runAction('start_execution', visibleWorkflow, () => onStartExecution(visibleWorkflow));
  }, [onStartExecution, runAction, visibleWorkflow]);
  const modifyPlan = useCallback(() => {
    if (visibleWorkflow?.plan && onModifyPlan) void runAction('modify_plan', visibleWorkflow, () => onModifyPlan(visibleWorkflow, visibleWorkflow.plan as ExecutionPlan));
  }, [onModifyPlan, runAction, visibleWorkflow]);
  const cancelWorkflow = useCallback(() => {
    if (visibleWorkflow && onCancelWorkflow) void runAction('cancel', visibleWorkflow, () => onCancelWorkflow(visibleWorkflow));
  }, [onCancelWorkflow, runAction, visibleWorkflow]);
  const applyFix = useCallback((issue?: ReviewIssue) => {
    if (visibleWorkflow && reviewState.review && onApplyReviewFix) {
      const review = reviewState.review;
      void runAction('apply_fix', visibleWorkflow, () => onApplyReviewFix(visibleWorkflow, review, issue));
    }
  }, [onApplyReviewFix, reviewState.review, runAction, visibleWorkflow]);
  const ignoreReview = useCallback((issue?: ReviewIssue) => {
    if (visibleWorkflow && reviewState.review && onIgnoreReview) {
      const review = reviewState.review;
      void runAction('ignore_review', visibleWorkflow, () => onIgnoreReview(visibleWorkflow, review, issue));
    }
  }, [onIgnoreReview, reviewState.review, runAction, visibleWorkflow]);
  const exportReview = useCallback(() => {
    if (!visibleWorkflow || !reviewState.review || !onExportReview) return;
    const review = reviewState.review;
    onExportReview(visibleWorkflow, review, reviewToMarkdown(review, visibleWorkflow), reviewExportFileName(visibleWorkflow.id, review));
  }, [onExportReview, reviewState.review, visibleWorkflow]);

  const team = useMemo(() => visibleWorkflow ? buildAgentTeam(visibleWorkflow, stages) : [], [stages, visibleWorkflow]);
  const timeline = useMemo(() => buildAgentTimeline(stages), [stages]);
  const activeReviewIdentity = effectiveSelection ? workflowReviewIdentity(effectiveSelection, selectedRevision) : null;
  const visibleReviewState = reviewState.identity === activeReviewIdentity
    ? reviewState
    : { identity: activeReviewIdentity, review: null, loading: tab === 'review', error: null };

  if (!projectId) {
    return <div className={`flex h-full items-center justify-center text-sm ${className}`} style={{ color: 'var(--text-disabled)' }} data-testid="workflow-no-project">请先打开项目</div>;
  }

  return (
    <div className={`flex h-full min-h-0 overflow-hidden ${className}`} data-testid="workflow-panel">
      <WorkflowList
        items={visiblePage.items}
        selectedId={effectiveSelection}
        total={visiblePage.total}
        offset={visiblePage.offset}
        pageSize={safePageSize}
        loading={pageLoading}
        onSelect={selectWorkflow}
        onPageChange={changePage}
        onRefresh={refreshPage}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-1 border-b px-3 py-2" style={{ borderColor: 'var(--border-primary)' }}>
          {TABS.map((item) => (
            <button key={item.id} type="button" onClick={() => setTab(item.id)} aria-selected={tab === item.id} data-testid="workflow-tab" data-tab={item.id} className="rounded-md px-2.5 py-1.5 text-xs" style={{ background: tab === item.id ? 'var(--bg-active)' : 'transparent', color: tab === item.id ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{item.label}</button>
          ))}
          {visibleWorkflow ? <div className="ml-auto flex min-w-0 items-center gap-2 text-[10px]" style={{ color: 'var(--text-tertiary)' }}><span className="status-dot" style={{ background: statusColor(visibleWorkflow.status) }} /><span>{workflowStatusLabel(visibleWorkflow.status)}</span><span className="hidden max-w-40 truncate sm:inline">{visibleWorkflow.id}</span></div> : null}
        </header>
        {pageError ? <div className="m-3 rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--error)', background: 'var(--error-bg)' }}>{pageError}</div> : null}
        {actionError ? <div className="mx-3 mt-3 rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--error)', background: 'var(--error-bg)' }}>{actionError}</div> : null}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hidden">
          {!effectiveSelection ? (
            <div className="flex h-full items-center justify-center text-xs" style={{ color: 'var(--text-disabled)' }}>{pageLoading ? <><LoaderCircle size={13} className="mr-2 animate-spin" />正在加载 Workflow…</> : '请选择 Workflow'}</div>
          ) : detailLoading && !visibleWorkflow ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs"><LoaderCircle size={14} className="animate-spin" />并行加载详情与 Agent 阶段…</div>
          ) : detailError || !visibleWorkflow ? (
            <div className="m-4 rounded-lg px-3 py-3 text-xs" style={{ color: 'var(--error)', background: 'var(--error-bg)' }}><XCircle size={13} className="mr-1 inline" />{detailError ?? 'Workflow 不可用'}</div>
          ) : tab === 'plan' ? (
            <PlanReview
              key={`plan:${visibleWorkflow.id}:${visibleWorkflow.revision}`}
              workflow={visibleWorkflow}
              pendingAction={pendingAction}
              onStartExecution={onStartExecution ? startExecution : undefined}
              onModifyPlan={onModifyPlan ? modifyPlan : undefined}
              onCancel={onCancelWorkflow ? cancelWorkflow : undefined}
            />
          ) : tab === 'review' ? (
            <WorkflowReview
              key={`review:${activeReviewIdentity}`}
              workflow={visibleWorkflow}
              review={visibleReviewState.review}
              loading={visibleReviewState.loading}
              error={visibleReviewState.error}
              pendingAction={pendingAction}
              onApplyFix={onApplyReviewFix ? applyFix : undefined}
              onIgnore={onIgnoreReview ? ignoreReview : undefined}
              onExport={onExportReview ? exportReview : undefined}
            />
          ) : tab === 'team' ? (
            <AgentTeam members={team} />
          ) : (
            <WorkflowAgentTimeline key={`timeline:${visibleWorkflow.id}`} items={timeline} />
          )}
        </div>
      </main>
    </div>
  );
}
