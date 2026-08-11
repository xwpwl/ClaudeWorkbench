import { describe, expect, it } from 'vitest';
import type { WorkflowStatus } from '../../../../shared/types/workflow';
import {
  MAX_TIMELINE_JSON_LENGTH,
  MAX_TIMELINE_TEXT_LENGTH,
  WorkflowRequestGate,
  agentLabel,
  agentStatusLabel,
  buildAgentTeam,
  buildAgentTimeline,
  clampWorkflowPageSize,
  formatTimelineDuration,
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
} from '../workflowPresentation';
import { NOW, makeIssue, makeReview, makeStage, makeWorkflow } from './fixtures';

describe('workflow pagination model', () => {
  it('uses a bounded default page size', () => {
    expect(clampWorkflowPageSize()).toBe(50);
  });

  it('raises a zero page size to one', () => {
    expect(clampWorkflowPageSize(0)).toBe(1);
  });

  it('raises a negative page size to one', () => {
    expect(clampWorkflowPageSize(-20)).toBe(1);
  });

  it('truncates a fractional page size', () => {
    expect(clampWorkflowPageSize(20.9)).toBe(20);
  });

  it('caps a page at the DB maximum instead of loading 1000 workflows', () => {
    expect(clampWorkflowPageSize(1_000)).toBe(100);
  });

  it('falls back safely for a non-finite page size', () => {
    expect(clampWorkflowPageSize(Number.POSITIVE_INFINITY)).toBe(50);
  });

  it('normalizes a negative offset to zero', () => {
    expect(normalizeWorkflowOffset(-10, 50)).toBe(0);
  });

  it('aligns an offset to a page boundary', () => {
    expect(normalizeWorkflowOffset(77, 25)).toBe(75);
  });

  it('clamps an offset to the last populated page', () => {
    expect(normalizeWorkflowOffset(500, 50, 126)).toBe(100);
  });

  it('normalizes an empty collection to offset zero', () => {
    expect(normalizeWorkflowOffset(500, 50, 0)).toBe(0);
  });

  it('reports one page for an empty collection', () => {
    expect(workflowPageCount(0, 50)).toBe(1);
  });

  it('computes multiple pages without rounding down', () => {
    expect(workflowPageCount(101, 50)).toBe(3);
  });

  it('computes a one-based page number from the offset', () => {
    expect(workflowPageNumber(100, 50)).toBe(3);
  });
});

describe('workflow labels', () => {
  it.each<[WorkflowStatus, string]>([
    ['idle', '等待开始'],
    ['planning', '规划中'],
    ['waiting_plan_confirmation', '等待确认计划'],
    ['executing', '执行中'],
    ['testing', '测试中'],
    ['reviewing', '审查中'],
    ['paused', '已暂停'],
    ['completed', '已完成'],
    ['failed', '失败'],
    ['cancelled', '已取消'],
  ])('maps workflow status %s to a user-facing label', (status, label) => {
    expect(workflowStatusLabel(status)).toBe(label);
  });

  it.each([
    ['planner', 'Planner'],
    ['coder', 'Coder'],
    ['tester', 'Tester'],
    ['reviewer', 'Reviewer'],
  ] as const)('keeps the agent identity %s stable', (agent, label) => {
    expect(agentLabel(agent)).toBe(label);
  });

  it.each([
    ['low', '低风险'],
    ['medium', '中风险'],
    ['high', '高风险'],
  ] as const)('maps risk %s', (risk, label) => {
    expect(riskLabel(risk)).toBe(label);
  });

  it.each([
    ['critical', '严重'],
    ['high', '高'],
    ['medium', '中'],
    ['low', '低'],
    ['suggestion', '建议'],
  ] as const)('maps review severity %s', (severity, label) => {
    expect(severityLabel(severity)).toBe(label);
  });

  it('labels a paused agent independently from workflow status', () => {
    expect(agentStatusLabel('paused')).toBe('已暂停');
  });
});

describe('review presentation model', () => {
  it('uses a global location when no file is present', () => {
    expect(reviewLocation(makeIssue(1, { file: null, line: null }))).toBe('全局');
  });

  it('uses a file-only location when no line is present', () => {
    expect(reviewLocation(makeIssue(1, { file: 'src/app.ts', line: null }))).toBe('src/app.ts');
  });

  it('includes an exact line when available', () => {
    expect(reviewLocation(makeIssue(1, { file: 'src/app.ts', line: 42 }))).toBe('src/app.ts:42');
  });

  it.each([
    [0, 'error'],
    [5.99, 'error'],
    [6, 'warning'],
    [7.99, 'warning'],
    [8, 'success'],
    [10, 'success'],
  ] as const)('maps score %s to %s', (score, tone) => {
    expect(reviewScoreTone(score)).toBe(tone);
  });

  it('treats a non-finite score as an error', () => {
    expect(reviewScoreTone(Number.NaN)).toBe('error');
  });

  it('returns only unresolved issues', () => {
    const review = makeReview(3, { issues: [makeIssue(0), makeIssue(1, { resolved: true }), makeIssue(2)] });
    expect(unresolvedReviewIssues(review).map((issue) => issue.id)).toEqual(['issue-0', 'issue-2']);
  });

  it('collapses a large review to the requested preview size', () => {
    expect(visibleReviewIssues(makeReview(30), false, 8)).toHaveLength(8);
  });

  it('returns every issue after expansion', () => {
    expect(visibleReviewIssues(makeReview(30), true, 8)).toHaveLength(30);
  });

  it('never collapses a review to zero visible issues', () => {
    expect(visibleReviewIssues(makeReview(3), false, 0)).toHaveLength(1);
  });

  it('sanitizes the workflow id in an export filename', () => {
    expect(reviewExportFileName('project / workflow #1', makeReview())).toBe('project-workflow-1-review-round-1.md');
  });

  it('exports score, tests, issue severity, location, and recommendation', () => {
    const markdown = reviewToMarkdown(makeReview(1), makeWorkflow());
    expect(markdown).toContain('评分：7.5/10');
    expect(markdown).toContain('18 通过 / 2 失败 / 1 跳过');
    expect(markdown).toContain('[中] 问题 0');
    expect(markdown).toContain('src/file-0.ts:1');
    expect(markdown).toContain('建议修复 0');
  });

  it('exports an explicit no-issues result', () => {
    expect(reviewToMarkdown(makeReview(0))).toContain('未发现问题。');
  });

  it('does not invent a skipped count when it was omitted', () => {
    const markdown = reviewToMarkdown(makeReview(0, { tests: { passed: 2, failed: 0 } }));
    expect(markdown).not.toContain('跳过');
  });

  it('flattens prompt newlines in markdown metadata', () => {
    const markdown = reviewToMarkdown(makeReview(0), makeWorkflow({ prompt: 'line one\nline two' }));
    expect(markdown).toContain('> line one line two');
  });
});

describe('review lazy-load identity', () => {
  it('does not load review data while the plan tab is active', () => {
    expect(shouldLoadWorkflowReview('plan', 'workflow-1', 1, null)).toBe(false);
  });

  it('does not load without a selected workflow', () => {
    expect(shouldLoadWorkflowReview('review', null, 1, null)).toBe(false);
  });

  it('loads when Review is first activated', () => {
    expect(shouldLoadWorkflowReview('review', 'workflow-1', 1, null)).toBe(true);
  });

  it('reuses the cached review for the same revision', () => {
    const identity = workflowReviewIdentity('workflow-1', 2);
    expect(shouldLoadWorkflowReview('review', 'workflow-1', 2, identity)).toBe(false);
  });

  it('reloads a review after workflow revision changes', () => {
    const oldIdentity = workflowReviewIdentity('workflow-1', 2);
    expect(shouldLoadWorkflowReview('review', 'workflow-1', 3, oldIdentity)).toBe(true);
  });

  it('reloads a review after workflow selection changes', () => {
    const oldIdentity = workflowReviewIdentity('workflow-1', 2);
    expect(shouldLoadWorkflowReview('review', 'workflow-2', 2, oldIdentity)).toBe(true);
  });

  it('normalizes a fractional revision in the identity', () => {
    expect(workflowReviewIdentity('workflow-1', 4.9)).toBe('workflow-1:4');
  });
});

describe('agent team presentation', () => {
  it('always returns Planner, Coder, Tester, and Reviewer in workflow order', () => {
    expect(buildAgentTeam(makeWorkflow(), []).map((member) => member.agent)).toEqual(['planner', 'coder', 'tester', 'reviewer']);
  });

  it('shows Planner running while planning', () => {
    const team = buildAgentTeam(makeWorkflow({ status: 'planning', currentStage: 'planner' }), []);
    expect(team[0]?.status).toBe('running');
  });

  it('shows Planner completed while waiting for plan confirmation', () => {
    const team = buildAgentTeam(makeWorkflow({ status: 'waiting_plan_confirmation', currentStage: 'planner' }), []);
    expect(team[0]?.status).toBe('completed');
    expect(team[1]?.status).toBe('pending');
  });

  it('infers Planner completed and Coder running during execution', () => {
    const team = buildAgentTeam(makeWorkflow({ status: 'executing', currentStage: 'coder' }), []);
    expect(team.map((member) => member.status)).toEqual(['completed', 'running', 'pending', 'pending']);
  });

  it('infers prior agents completed while testing', () => {
    const team = buildAgentTeam(makeWorkflow({ status: 'testing', currentStage: 'tester' }), []);
    expect(team.map((member) => member.status)).toEqual(['completed', 'completed', 'running', 'pending']);
  });

  it('infers prior agents completed while reviewing', () => {
    const team = buildAgentTeam(makeWorkflow({ status: 'reviewing', currentStage: 'reviewer' }), []);
    expect(team.map((member) => member.status)).toEqual(['completed', 'completed', 'completed', 'running']);
  });

  it('shows a paused current agent', () => {
    const team = buildAgentTeam(makeWorkflow({ status: 'paused', currentStage: 'tester', pausedFrom: 'testing' }), []);
    expect(team.find((member) => member.agent === 'tester')?.status).toBe('paused');
  });

  it('shows the failure stage as failed', () => {
    const team = buildAgentTeam(makeWorkflow({ status: 'failed', currentStage: null, failure: { message: 'tests failed', stage: 'tester' } }), []);
    expect(team.find((member) => member.agent === 'tester')?.status).toBe('failed');
  });

  it('shows every agent completed for a completed workflow', () => {
    expect(buildAgentTeam(makeWorkflow({ status: 'completed', currentStage: null }), []).every((member) => member.status === 'completed')).toBe(true);
  });

  it('prefers a persisted stage status over an inferred status', () => {
    const team = buildAgentTeam(makeWorkflow({ status: 'executing', currentStage: 'coder' }), [makeStage({ stage: 'coder', status: 'failed' })]);
    expect(team.find((member) => member.agent === 'coder')?.status).toBe('failed');
  });

  it('uses the highest round for a repeated agent stage', () => {
    const team = buildAgentTeam(makeWorkflow(), [
      makeStage({ id: 'coder-1', stage: 'coder', round: 1, status: 'failed' }),
      makeStage({ id: 'coder-2', stage: 'coder', round: 2, status: 'completed' }),
    ]);
    expect(team.find((member) => member.agent === 'coder')).toMatchObject({ round: 2, status: 'completed' });
  });

  it('keeps a review fix pass under Coder identity', () => {
    const coder = buildAgentTeam(makeWorkflow({ fixRound: 2, maxFixRounds: 3, currentStage: 'coder', status: 'executing' }), [])
      .find((member) => member.agent === 'coder');
    expect(coder).toMatchObject({ label: 'Coder', detail: '修复轮次 2/3' });
  });
});

describe('agent timeline presentation', () => {
  it('sorts stage records without mutating the caller array', () => {
    const later = makeStage({ id: 'later', startedAt: '2026-08-01T09:00:00.000Z' });
    const earlier = makeStage({ id: 'earlier', startedAt: '2026-08-01T08:00:00.000Z' });
    const stages = [later, earlier];
    expect(buildAgentTimeline(stages).map((item) => item.id)).toEqual(['earlier', 'later']);
    expect(stages.map((item) => item.id)).toEqual(['later', 'earlier']);
  });

  it('extracts whitelisted title and summary fields', () => {
    const [item] = buildAgentTimeline([makeStage({ outputJson: JSON.stringify({ title: 'Safe title', summary: 'Safe summary' }) })]);
    expect(item?.details).toEqual(expect.arrayContaining([
      { label: '标题', value: 'Safe title' },
      { label: '摘要', value: 'Safe summary' },
    ]));
  });

  it('does not expose raw JSON keys or values', () => {
    const [item] = buildAgentTimeline([makeStage({ outputJson: JSON.stringify({ raw: 'TOP-SECRET-RAW', summary: 'safe' }) })]);
    expect(JSON.stringify(item)).not.toContain('TOP-SECRET-RAW');
  });

  it('drops an assistant_text payload completely', () => {
    const [item] = buildAgentTimeline([makeStage({ outputJson: JSON.stringify({ type: 'assistant_text', summary: 'PRIVATE ASSISTANT TEXT' }), inputJson: '{}' })]);
    expect(JSON.stringify(item)).not.toContain('PRIVATE ASSISTANT TEXT');
  });

  it('drops a system_init payload completely', () => {
    const [item] = buildAgentTimeline([makeStage({ outputJson: JSON.stringify({ eventType: 'system_init', summary: 'PRIVATE SYSTEM INIT' }), inputJson: '{}' })]);
    expect(JSON.stringify(item)).not.toContain('PRIVATE SYSTEM INIT');
  });

  it('ignores malformed JSON instead of showing it', () => {
    const [item] = buildAgentTimeline([makeStage({ outputJson: '{bad-json', inputJson: 'also bad' })]);
    expect(item?.details).toEqual([]);
  });

  it('does not parse an oversized JSON payload', () => {
    const secret = 'S'.repeat(MAX_TIMELINE_JSON_LENGTH + 1);
    const [item] = buildAgentTimeline([makeStage({ outputJson: secret, inputJson: '{}' })]);
    expect(item?.details).toEqual([]);
  });

  it('truncates long presentation text', () => {
    const [item] = buildAgentTimeline([makeStage({ outputJson: JSON.stringify({ summary: 'a'.repeat(MAX_TIMELINE_TEXT_LENGTH + 20) }) })]);
    const summary = item?.details.find((detail) => detail.label === '摘要')?.value;
    expect(summary).toHaveLength(MAX_TIMELINE_TEXT_LENGTH + 1);
    expect(summary?.endsWith('…')).toBe(true);
  });

  it('summarizes files without exposing an unbounded list', () => {
    const [item] = buildAgentTimeline([makeStage({ outputJson: JSON.stringify({ filesChanged: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }) })]);
    expect(item?.details).toContainEqual({ label: '文件', value: '4 个 · a.ts、b.ts、c.ts' });
    expect(JSON.stringify(item)).not.toContain('d.ts');
  });

  it('summarizes test counts', () => {
    const [item] = buildAgentTimeline([makeStage({ stage: 'tester', outputJson: JSON.stringify({ tests: { passed: 12, failed: 1, skipped: 2 } }) })]);
    expect(item?.details).toContainEqual({ label: '测试', value: '12 通过 / 1 失败 / 2 跳过' });
  });

  it('summarizes decimal review score and issue count without truncating it', () => {
    const [item] = buildAgentTimeline([makeStage({ stage: 'reviewer', outputJson: JSON.stringify({ score: 8.5, issues: [{}, {}] }) })]);
    expect(item?.details).toEqual(expect.arrayContaining([
      { label: '评分', value: '8.5/10' },
      { label: '问题', value: '2 项' },
    ]));
  });

  it('shows a bounded stage error as a presentation detail', () => {
    const [item] = buildAgentTimeline([makeStage({ status: 'failed', error: 'test process failed' })]);
    expect(item?.details).toContainEqual({ label: '错误', value: 'test process failed' });
  });

  it('computes duration from valid timestamps', () => {
    const [item] = buildAgentTimeline([makeStage()]);
    expect(item?.durationMs).toBe(2_500);
  });

  it('clamps a reversed timestamp duration to zero', () => {
    const [item] = buildAgentTimeline([makeStage({ startedAt: '2026-08-01T08:00:03Z', completedAt: '2026-08-01T08:00:01Z' })]);
    expect(item?.durationMs).toBe(0);
  });

  it('uses null duration for an invalid timestamp', () => {
    const [item] = buildAgentTimeline([makeStage({ startedAt: 'invalid', completedAt: NOW })]);
    expect(item?.durationMs).toBeNull();
  });

  it('can extract safe model metadata from input', () => {
    const [item] = buildAgentTimeline([makeStage({ outputJson: '{}', inputJson: JSON.stringify({ model: 'claude-sonnet' }) })]);
    expect(item?.inputDetails).toContainEqual({ label: 'Model', value: 'claude-sonnet' });
  });

  it('separates a narrow safe input summary from output details', () => {
    const [item] = buildAgentTimeline([makeStage({
      inputJson: JSON.stringify({
        kind: 'coder',
        goal: 'Implement the confirmed plan',
        plan: { title: 'Safe plan', summary: 'do not echo this nested body' },
        projectPath: 'C:/private/project',
        git: { branch: 'secret-branch' },
        raw: 'RAW-INPUT-SECRET',
      }),
      outputJson: JSON.stringify({ summary: 'Safe output', filesChanged: ['src/a.ts'] }),
    })]);
    expect(item?.inputDetails).toEqual([
      { label: 'Kind', value: 'coder' },
      { label: 'Goal', value: 'Implement the confirmed plan' },
      { label: 'Plan', value: 'Safe plan' },
    ]);
    expect(item?.outputDetails).toEqual(expect.arrayContaining([
      { label: '摘要', value: 'Safe output' },
      { label: '文件', value: '1 个 · src/a.ts' },
    ]));
    expect(JSON.stringify(item)).not.toContain('RAW-INPUT-SECRET');
    expect(JSON.stringify(item)).not.toContain('secret-branch');
    expect(JSON.stringify(item)).not.toContain('do not echo this nested body');
  });

  it('summarizes the real top-level tester result shape', () => {
    const [item] = buildAgentTimeline([makeStage({
      stage: 'tester',
      outputJson: JSON.stringify({ summary: 'tests ran', passed: 24, failed: 1, skipped: 2, commands: ['secret command'] }),
    })]);
    expect(item?.outputDetails).toContainEqual({ label: '测试', value: '24 通过 / 1 失败 / 2 跳过' });
    expect(JSON.stringify(item)).not.toContain('secret command');
  });

  it('projects permission count, tool, decision, and time without tool input', () => {
    const [item] = buildAgentTimeline([makeStage({
      inputJson: JSON.stringify({ raw: 'stage input must stay hidden' }),
      permissions: [
        { toolName: 'Edit', decision: 'allow_once', createdAt: NOW },
        { toolName: 'Bash', decision: 'deny', createdAt: '2026-08-01T08:00:01.000Z' },
      ],
    })]);
    expect(item?.permissionCount).toBe(2);
    expect(item?.permissions).toEqual([
      { toolName: 'Edit', decision: 'allow_once', createdAt: NOW },
      { toolName: 'Bash', decision: 'deny', createdAt: '2026-08-01T08:00:01.000Z' },
    ]);
    expect(JSON.stringify(item)).not.toContain('stage input must stay hidden');
  });

  it('bounds the rendered permission preview while preserving the total count', () => {
    const permissions = Array.from({ length: 25 }, (_, index) => ({
      toolName: `Tool-${index}`,
      decision: 'allow_once',
      createdAt: NOW,
    }));
    const [item] = buildAgentTimeline([makeStage({ permissions })]);
    expect(item?.permissionCount).toBe(25);
    expect(item?.permissions).toHaveLength(20);
    expect(JSON.stringify(item)).not.toContain('Tool-24');
  });

  it('filters non-string file entries', () => {
    const [item] = buildAgentTimeline([makeStage({ outputJson: JSON.stringify({ files: ['safe.ts', 42, null, { path: 'hidden.ts' }] }) })]);
    expect(item?.details).toContainEqual({ label: '文件', value: '1 个 · safe.ts' });
    expect(JSON.stringify(item)).not.toContain('hidden.ts');
  });

  it('uses a safe message only when summary is absent', () => {
    const [item] = buildAgentTimeline([makeStage({ outputJson: JSON.stringify({ message: 'stage finished' }) })]);
    expect(item?.summary).toBe('stage finished');
  });

  it('formats short durations in milliseconds', () => {
    expect(formatTimelineDuration(950)).toBe('950ms');
  });

  it('formats longer durations in seconds', () => {
    expect(formatTimelineDuration(2_550)).toBe('2.6s');
  });
});

describe('workflow request generation guard', () => {
  it('marks a new token current', () => {
    const gate = new WorkflowRequestGate();
    expect(gate.isCurrent(gate.begin('project-a'))).toBe(true);
  });

  it('exposes the current primitive identity', () => {
    const gate = new WorkflowRequestGate();
    gate.begin('project-a:page-1');
    expect(gate.activeIdentity()).toBe('project-a:page-1');
  });

  it('aborts the prior request when a new identity starts', () => {
    const gate = new WorkflowRequestGate();
    const old = gate.begin('workflow-a');
    gate.begin('workflow-b');
    expect(old.signal.aborted).toBe(true);
  });

  it('rejects a stale generation even when identities repeat', () => {
    const gate = new WorkflowRequestGate();
    const old = gate.begin('same');
    const current = gate.begin('same');
    expect(gate.isCurrent(old)).toBe(false);
    expect(gate.isCurrent(current)).toBe(true);
  });

  it('cancels the active request', () => {
    const gate = new WorkflowRequestGate();
    const token = gate.begin('workflow-a');
    gate.cancel(token);
    expect(token.signal.aborted).toBe(true);
    expect(gate.activeIdentity()).toBeNull();
  });

  it('does not let stale cleanup cancel a newer request', () => {
    const gate = new WorkflowRequestGate();
    const old = gate.begin('workflow-a');
    const current = gate.begin('workflow-b');
    gate.cancel(old);
    expect(gate.isCurrent(current)).toBe(true);
  });

  it('cancel without a token invalidates whichever request is active', () => {
    const gate = new WorkflowRequestGate();
    const token = gate.begin('workflow-a');
    gate.cancel();
    expect(token.signal.aborted).toBe(true);
  });
});
