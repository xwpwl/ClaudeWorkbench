import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentTeam,
  PlanReview,
  WorkflowAgentTimeline,
  WorkflowList,
  WorkflowPanel,
  WorkflowReview,
} from '../WorkflowPanel';
import { buildAgentTeam, buildAgentTimeline } from '../workflowPresentation';
import { makeIssue, makePlan, makeReview, makeStage, makeSummary, makeWorkflow } from './fixtures';

function markup(component: React.ReactElement): string {
  return renderToStaticMarkup(component);
}

const noop = () => undefined;

describe('PlanReview UI', () => {
  it('renders the required plan title and summary', () => {
    const html = markup(React.createElement(PlanReview, { workflow: makeWorkflow(), pendingAction: null }));
    expect(html).toContain('实现 Workflow 面板');
    expect(html).toContain('先规划，再编码、测试和审查。');
  });

  it('renders every plan step with its stable id', () => {
    const html = markup(React.createElement(PlanReview, { workflow: makeWorkflow(), pendingAction: null }));
    expect((html.match(/data-testid="workflow-plan-step"/g) ?? [])).toHaveLength(2);
    expect(html).toContain('设计契约');
    expect(html).toContain('实现组件');
  });

  it('renders plan and step risk levels', () => {
    const html = markup(React.createElement(PlanReview, { workflow: makeWorkflow(), pendingAction: null }));
    expect(html).toContain('data-risk="medium"');
    expect(html).toContain('低风险');
    expect(html).toContain('中风险');
  });

  it('renders estimated changes and expected files', () => {
    const html = markup(React.createElement(PlanReview, { workflow: makeWorkflow(), pendingAction: null }));
    expect(html).toContain('2 个文件，约 200 行');
    expect(html).toContain('src/one.ts');
    expect(html).toContain('src/two.ts');
  });

  it('renders acceptance criteria without raw JSON', () => {
    const html = markup(React.createElement(PlanReview, { workflow: makeWorkflow(), pendingAction: null }));
    expect(html).toContain('Review 按需加载');
    expect(html).not.toContain('&quot;acceptanceCriteria&quot;');
  });

  it('renders start, modify, and cancel callbacks as external actions', () => {
    const html = markup(React.createElement(PlanReview, {
      workflow: makeWorkflow(),
      pendingAction: null,
      onStartExecution: noop,
      onModifyPlan: noop,
      onCancel: noop,
    }));
    expect(html).toContain('data-testid="workflow-start-execution"');
    expect(html).toContain('data-testid="workflow-modify-plan"');
    expect(html).toContain('data-testid="workflow-cancel"');
  });

  it('disables start until the plan is confirmable', () => {
    const html = markup(React.createElement(PlanReview, {
      workflow: makeWorkflow({ status: 'planning' }),
      pendingAction: null,
      onStartExecution: noop,
    }));
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="workflow-start-execution"/);
  });

  it('keeps start disabled while paused so App resume handles the state transition', () => {
    const html = markup(React.createElement(PlanReview, {
      workflow: makeWorkflow({ status: 'paused' }),
      pendingAction: null,
      onStartExecution: noop,
    }));
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="workflow-start-execution"/);
  });

  it('hides cancellation for terminal workflows', () => {
    const html = markup(React.createElement(PlanReview, {
      workflow: makeWorkflow({ status: 'completed' }),
      pendingAction: null,
      onCancel: noop,
    }));
    expect(html).not.toContain('data-testid="workflow-cancel"');
  });

  it('renders a useful empty state before Planner produces a plan', () => {
    const html = markup(React.createElement(PlanReview, {
      workflow: makeWorkflow({ plan: null }),
      pendingAction: null,
    }));
    expect(html).toContain('data-testid="workflow-plan-empty"');
    expect(html).toContain('Planner 正在准备执行计划');
  });

  it('collapses a long expected-file list by default', () => {
    const files = Array.from({ length: 9 }, (_, index) => `src/file-${index}.ts`);
    const html = markup(React.createElement(PlanReview, {
      workflow: makeWorkflow({ plan: makePlan({ filesExpected: files }) }),
      pendingAction: null,
    }));
    expect(html).toContain('src/file-5.ts');
    expect(html).not.toContain('src/file-6.ts');
    expect(html).toContain('展开其余 3 个文件');
  });
});

describe('WorkflowReview UI', () => {
  it('renders score, summary, and all test counters', () => {
    const html = markup(React.createElement(WorkflowReview, {
      workflow: makeWorkflow(),
      review: makeReview(),
      loading: false,
      error: null,
      pendingAction: null,
    }));
    expect(html).toContain('data-testid="workflow-review-score"');
    expect(html).toContain('整体可用，但仍需修复边界条件。');
    expect(html).toContain('18');
    expect(html).toContain('2');
    expect(html).toContain('1');
  });

  it('renders severity, file, line, title, and recommendation for an issue', () => {
    const review = makeReview(1, { issues: [makeIssue(0, { severity: 'critical', file: 'src/security.ts', line: 88, title: '权限绕过', recommendation: '绑定请求身份' })] });
    const html = markup(React.createElement(WorkflowReview, { workflow: makeWorkflow(), review, loading: false, error: null, pendingAction: null }));
    expect(html).toContain('data-severity="critical"');
    expect(html).toContain('严重');
    expect(html).toContain('src/security.ts:88');
    expect(html).toContain('权限绕过');
    expect(html).toContain('绑定请求身份');
  });

  it('marks a resolved issue and omits its action buttons', () => {
    const review = makeReview(1, { issues: [makeIssue(0, { resolved: true })] });
    const html = markup(React.createElement(WorkflowReview, { workflow: makeWorkflow(), review, loading: false, error: null, pendingAction: null, onApplyFix: noop, onIgnore: noop }));
    expect(html).toContain('已处理');
    expect(html).not.toContain('交给 Coder 修复');
    expect(html).not.toContain('忽略此项');
  });

  it('renders only eight issues from a large review before expansion', () => {
    const html = markup(React.createElement(WorkflowReview, { workflow: makeWorkflow(), review: makeReview(30), loading: false, error: null, pendingAction: null }));
    expect((html.match(/data-testid="workflow-review-issue"/g) ?? [])).toHaveLength(8);
    expect(html).toContain('展开其余 22 项');
    expect(html).not.toContain('问题 8');
  });

  it('collapses an oversized Review summary before user expansion', () => {
    const tail = 'SUMMARY-TAIL-MUST-BE-COLLAPSED';
    const review = makeReview(0, { summary: `${'a'.repeat(700)}${tail}` });
    const html = markup(React.createElement(WorkflowReview, { workflow: makeWorkflow(), review, loading: false, error: null, pendingAction: null }));
    expect(html).toContain('展开完整 Review 总结');
    expect(html).not.toContain(tail);
  });

  it('renders an explicit no-issues success state', () => {
    const html = markup(React.createElement(WorkflowReview, { workflow: makeWorkflow(), review: makeReview(0), loading: false, error: null, pendingAction: null }));
    expect(html).toContain('未发现问题');
  });

  it('renders the lazy Review loading state', () => {
    const html = markup(React.createElement(WorkflowReview, { workflow: makeWorkflow(), review: null, loading: true, error: null, pendingAction: null }));
    expect(html).toContain('data-testid="workflow-review-loading"');
    expect(html).toContain('按需加载');
  });

  it('renders Review request errors without falling back to raw data', () => {
    const html = markup(React.createElement(WorkflowReview, { workflow: makeWorkflow(), review: null, loading: false, error: 'review unavailable', pendingAction: null }));
    expect(html).toContain('data-testid="workflow-review-error"');
    expect(html).toContain('review unavailable');
  });

  it('renders an empty state when Reviewer has not run', () => {
    const html = markup(React.createElement(WorkflowReview, { workflow: makeWorkflow(), review: null, loading: false, error: null, pendingAction: null }));
    expect(html).toContain('Reviewer 尚未生成报告');
  });

  it('renders apply, ignore, and export callbacks', () => {
    const html = markup(React.createElement(WorkflowReview, {
      workflow: makeWorkflow({ status: 'paused', pausedFrom: 'reviewing', reviewRound: 3, maxFixRounds: 3 }),
      review: makeReview(2, { round: 3 }),
      loading: false,
      error: null,
      pendingAction: null,
      onApplyFix: noop,
      onIgnore: noop,
      onExport: noop,
    }));
    expect(html).toContain('data-testid="workflow-apply-review-fix"');
    expect(html).toContain('data-testid="workflow-ignore-review"');
    expect(html).toContain('data-testid="workflow-export-review"');
    expect(html).toContain('接受风险并完成');
    expect(html).not.toContain('忽略此项');
  });

  it('identifies a review fix as Coder work', () => {
    const html = markup(React.createElement(WorkflowReview, { workflow: makeWorkflow({ status: 'paused', pausedFrom: 'reviewing', reviewRound: 3, maxFixRounds: 3 }), review: makeReview(2, { round: 3 }), loading: false, error: null, pendingAction: null, onApplyFix: noop }));
    expect(html).toContain('交给 Coder 应用修复');
    expect(html).not.toContain('Fixer');
  });

  it('shows only export for a completed review even when mutation callbacks exist', () => {
    const html = markup(React.createElement(WorkflowReview, {
      workflow: makeWorkflow({ status: 'completed' }),
      review: makeReview(),
      loading: false,
      error: null,
      pendingAction: null,
      onApplyFix: noop,
      onIgnore: noop,
      onExport: noop,
    }));
    expect(html).toContain('data-testid="workflow-export-review"');
    expect(html).not.toContain('data-testid="workflow-apply-review-fix"');
    expect(html).not.toContain('data-testid="workflow-ignore-review"');
  });

  it('hides resolution actions for an ordinary user-paused review stage', () => {
    const html = markup(React.createElement(WorkflowReview, {
      workflow: makeWorkflow({ status: 'paused', pausedFrom: 'reviewing', reviewRound: 2, maxFixRounds: 3 }),
      review: makeReview(2, { round: 2 }),
      loading: false,
      error: null,
      pendingAction: null,
      onApplyFix: noop,
      onIgnore: noop,
    }));
    expect(html).not.toContain('data-testid="workflow-apply-review-fix"');
    expect(html).not.toContain('data-testid="workflow-ignore-review"');
  });

  it('hides whole-review resolution when a paused report has no unresolved issues', () => {
    const review = makeReview(1, { issues: [makeIssue(0, { resolved: true })] });
    const html = markup(React.createElement(WorkflowReview, {
      workflow: makeWorkflow({ status: 'paused', pausedFrom: 'reviewing', reviewRound: 3, maxFixRounds: 3 }),
      review: { ...review, round: 3 },
      loading: false,
      error: null,
      pendingAction: null,
      onApplyFix: noop,
      onIgnore: noop,
    }));
    expect(html).not.toContain('data-testid="workflow-apply-review-fix"');
    expect(html).not.toContain('data-testid="workflow-ignore-review"');
  });
});

describe('AgentTeam UI', () => {
  it('renders exactly four stable agent cards', () => {
    const members = buildAgentTeam(makeWorkflow({ status: 'reviewing', currentStage: 'reviewer' }), []);
    const html = markup(React.createElement(AgentTeam, { members }));
    expect((html.match(/data-testid="workflow-agent-card"/g) ?? [])).toHaveLength(4);
    expect(html).toContain('Planner');
    expect(html).toContain('Coder');
    expect(html).toContain('Tester');
    expect(html).toContain('Reviewer');
  });

  it('exposes agent identity and status for accessible integration tests', () => {
    const members = buildAgentTeam(makeWorkflow({ status: 'testing', currentStage: 'tester' }), []);
    const html = markup(React.createElement(AgentTeam, { members }));
    expect(html).toContain('data-agent="tester"');
    expect(html).toContain('data-status="running"');
  });

  it('shows review remediation as a Coder round', () => {
    const members = buildAgentTeam(makeWorkflow({ status: 'executing', currentStage: 'coder', fixRound: 2 }), []);
    const html = markup(React.createElement(AgentTeam, { members }));
    expect(html).toContain('修复轮次 2/3');
  });
});

describe('WorkflowAgentTimeline UI', () => {
  it('renders a timeline empty state', () => {
    const html = markup(React.createElement(WorkflowAgentTimeline, { items: [] }));
    expect(html).toContain('data-testid="workflow-timeline-empty"');
  });

  it('renders safe stage title, status, and duration', () => {
    const items = buildAgentTimeline([makeStage()]);
    const html = markup(React.createElement(WorkflowAgentTimeline, { items }));
    expect(html).toContain('Planner · 第 1 轮');
    expect(html).toContain('完成');
    expect(html).toContain('2.5s');
  });

  it('keeps structured timeline details collapsed by default', () => {
    const items = buildAgentTimeline([makeStage()]);
    const html = markup(React.createElement(WorkflowAgentTimeline, { items }));
    expect(html).not.toContain('data-testid="workflow-timeline-details"');
    expect(html).not.toContain('完成计划</dd>');
  });

  it('renders whitelisted presentation details when explicitly expanded', () => {
    const items = buildAgentTimeline([makeStage()]);
    const html = markup(React.createElement(WorkflowAgentTimeline, { items, defaultExpandedIds: ['stage-1'] }));
    expect(html).toContain('data-testid="workflow-timeline-details"');
    expect(html).toContain('完成计划');
    expect(html).toContain('步骤');
  });

  it('separates safe input, output, and permission decisions in the collapsed details panel', () => {
    const items = buildAgentTimeline([makeStage({
      inputJson: JSON.stringify({ kind: 'coder', goal: 'Safe goal', plan: { title: 'Safe plan' }, raw: 'RAW-STAGE-INPUT' }),
      outputJson: JSON.stringify({ summary: 'Safe output', filesChanged: ['src/a.ts'] }),
      permissions: [{ toolName: 'Edit', decision: 'allow_once', createdAt: '2026-08-01T08:00:01.000Z' }],
    })]);
    const collapsed = markup(React.createElement(WorkflowAgentTimeline, { items }));
    expect(collapsed).not.toContain('data-testid="workflow-timeline-input"');
    expect(collapsed).not.toContain('allow_once');

    const expanded = markup(React.createElement(WorkflowAgentTimeline, { items, defaultExpandedIds: ['stage-1'] }));
    expect(expanded).toContain('data-testid="workflow-timeline-input"');
    expect(expanded).toContain('Input (safe summary)');
    expect(expanded).toContain('data-testid="workflow-timeline-output"');
    expect(expanded).toContain('Output (safe summary)');
    expect(expanded).toContain('data-testid="workflow-timeline-permissions"');
    expect(expanded).toContain('Permissions (1)');
    expect(expanded).toContain('Edit');
    expect(expanded).toContain('allow_once');
    expect(expanded).not.toContain('RAW-STAGE-INPUT');
  });

  it('never renders raw JSON, assistant_text, or system_init payloads', () => {
    const items = buildAgentTimeline([
      makeStage({ id: 'raw', outputJson: JSON.stringify({ raw: 'RAW-SECRET', summary: 'safe' }) }),
      makeStage({ id: 'assistant', outputJson: JSON.stringify({ type: 'assistant_text', summary: 'ASSISTANT-SECRET' }) }),
      makeStage({ id: 'system', outputJson: JSON.stringify({ type: 'system_init', summary: 'SYSTEM-SECRET' }) }),
    ]);
    const html = markup(React.createElement(WorkflowAgentTimeline, { items, defaultExpandedIds: ['raw', 'assistant', 'system'] }));
    expect(html).not.toContain('RAW-SECRET');
    expect(html).not.toContain('ASSISTANT-SECRET');
    expect(html).not.toContain('SYSTEM-SECRET');
    expect(html).not.toContain('{&quot;');
  });

  it('uses content visibility for off-screen timeline rows', () => {
    const html = markup(React.createElement(WorkflowAgentTimeline, { items: buildAgentTimeline([makeStage()]) }));
    expect(html).toContain('content-visibility:auto');
    expect(html).toContain('contain-intrinsic-size:0 84px');
  });
});

describe('WorkflowList UI', () => {
  it('renders only the supplied page even when total is over 1000', () => {
    const items = Array.from({ length: 50 }, (_, index) => makeSummary({ id: `workflow-${index}` }));
    const html = markup(React.createElement(WorkflowList, { items, selectedId: null, total: 1_250, offset: 0, pageSize: 50, loading: false, onSelect: noop, onPageChange: noop, onRefresh: noop }));
    expect((html.match(/data-testid="workflow-list-item"/g) ?? [])).toHaveLength(50);
    expect(html).toContain('1,250 个工作流');
  });

  it('renders a one-based bounded pagination summary', () => {
    const html = markup(React.createElement(WorkflowList, { items: [makeSummary()], selectedId: null, total: 1_250, offset: 100, pageSize: 50, loading: false, onSelect: noop, onPageChange: noop, onRefresh: noop }));
    expect(html).toContain('3 / 25');
  });

  it('marks the selected workflow without relying on a store', () => {
    const html = markup(React.createElement(WorkflowList, { items: [makeSummary()], selectedId: 'workflow-1', total: 1, offset: 0, pageSize: 50, loading: false, onSelect: noop, onPageChange: noop, onRefresh: noop }));
    expect(html).toContain('aria-current="true"');
  });

  it('renders workflow status and prompt', () => {
    const html = markup(React.createElement(WorkflowList, { items: [makeSummary({ status: 'reviewing', prompt: '安全审查' })], selectedId: null, total: 1, offset: 0, pageSize: 50, loading: false, onSelect: noop, onPageChange: noop, onRefresh: noop }));
    expect(html).toContain('安全审查');
    expect(html).toContain('审查中');
  });

  it('renders an explicit empty-page state', () => {
    const html = markup(React.createElement(WorkflowList, { items: [], selectedId: null, total: 0, offset: 0, pageSize: 50, loading: false, onSelect: noop, onPageChange: noop, onRefresh: noop }));
    expect(html).toContain('data-testid="workflow-empty-list"');
  });

  it('uses content visibility for each workflow row', () => {
    const html = markup(React.createElement(WorkflowList, { items: [makeSummary()], selectedId: null, total: 1, offset: 0, pageSize: 50, loading: false, onSelect: noop, onPageChange: noop, onRefresh: noop }));
    expect(html).toContain('content-visibility:auto');
    expect(html).toContain('contain-intrinsic-size:0 82px');
  });
});

describe('WorkflowPanel embedding shell', () => {
  const loaders = {
    loadWorkflowPage: vi.fn(async () => ({ items: [], total: 0, limit: 50, offset: 0 })),
    loadWorkflow: vi.fn(async () => makeWorkflow()),
    loadWorkflowStages: vi.fn(async () => []),
    loadWorkflowReview: vi.fn(async () => null),
  };

  it('renders a no-project state without assuming App stores or window.api', () => {
    const html = markup(React.createElement(WorkflowPanel, { projectId: null, ...loaders }));
    expect(html).toContain('data-testid="workflow-no-project"');
    expect(html).toContain('请先打开项目');
  });

  it('renders all four tabs as an embeddable project panel', () => {
    const html = markup(React.createElement(WorkflowPanel, { projectId: 'project-1', ...loaders }));
    expect((html.match(/data-testid="workflow-tab"/g) ?? [])).toHaveLength(4);
    expect(html).toContain('计划');
    expect(html).toContain('Review');
    expect(html).toContain('Agent Team');
    expect(html).toContain('Timeline');
  });
});
