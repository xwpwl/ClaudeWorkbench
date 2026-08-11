import { describe, expect, it } from 'vitest';
import {
  parseCoderStageOutput,
  parseExecutionPlan,
  parseReviewReport,
  parseTesterStageOutput,
  StructuredJsonParser,
  StructuredOutputError,
} from '../StructuredJsonParser';
import { clone, plan, report } from './helpers';

describe('StructuredJsonParser - planner output', () => {
  it('parses an ExecutionPlan object', () => {
    expect(parseExecutionPlan(plan())).toEqual(plan());
  });

  it('parses plain JSON text', () => {
    expect(parseExecutionPlan(JSON.stringify(plan()))).toEqual(plan());
  });

  it('parses a json fenced block', () => {
    expect(parseExecutionPlan(`\`\`\`json\n${JSON.stringify(plan())}\n\`\`\``)).toEqual(plan());
  });

  it('parses an unlabelled fenced block', () => {
    expect(parseExecutionPlan(`\`\`\`\n${JSON.stringify(plan())}\n\`\`\``)).toEqual(plan());
  });

  it('trims plan strings', () => {
    const parsed = parseExecutionPlan(plan({ title: '  Plan title  ', summary: '  Summary  ' }));
    expect(parsed.title).toBe('Plan title');
    expect(parsed.summary).toBe('Summary');
  });

  it('preserves optional structured step fields', () => {
    const parsed = parseExecutionPlan(plan({
      steps: [{
        id: 7,
        title: 'Step',
        risk: 'high',
        description: 'Details',
        status: 'in_progress',
        acceptanceCriteria: ['Pass tests'],
      }],
    }));
    expect(parsed.steps[0]).toMatchObject({ description: 'Details', status: 'in_progress' });
  });

  it('preserves structured constraints', () => {
    expect(parseExecutionPlan(plan({ constraints: ['No push'] })).constraints).toEqual(['No push']);
  });

  it('strips raw assistant data at the top level', () => {
    const parsed = parseExecutionPlan({ ...plan(), rawAssistant: 'SECRET TRANSCRIPT' });
    expect(parsed).not.toHaveProperty('rawAssistant');
  });

  it('strips system prompt data from a plan step', () => {
    const value = plan();
    value.steps = [{ ...value.steps[0], systemPrompt: 'SECRET' } as never];
    expect(parseExecutionPlan(value).steps[0]).not.toHaveProperty('systemPrompt');
  });

  it('returns fresh arrays rather than runner-owned arrays', () => {
    const value = plan();
    const parsed = parseExecutionPlan(value);
    expect(parsed.steps).not.toBe(value.steps);
    expect(parsed.filesExpected).not.toBe(value.filesExpected);
  });

  it('supports the parser class facade', () => {
    expect(new StructuredJsonParser().parsePlan(plan()).title).toBe(plan().title);
  });

  it('does not include raw invalid JSON in its error message', () => {
    const secret = 'TOP_SECRET_ASSISTANT_TRANSCRIPT';
    expect(() => parseExecutionPlan(`{${secret}`)).toThrow('Agent output is not valid JSON.');
    try {
      parseExecutionPlan(`{${secret}`);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  const invalidPlans: Array<[string, (value: Record<string, unknown>) => void]> = [
    ['missing title', (value) => { delete value.title; }],
    ['empty title', (value) => { value.title = ' '; }],
    ['missing summary', (value) => { delete value.summary; }],
    ['empty summary', (value) => { value.summary = ''; }],
    ['missing steps', (value) => { delete value.steps; }],
    ['empty steps', (value) => { value.steps = []; }],
    ['duplicate step ids', (value) => { value.steps = [plan().steps[0], plan().steps[0]]; }],
    ['negative step id', (value) => { value.steps = [{ id: -1, title: 'x', risk: 'low' }]; }],
    ['decimal step id', (value) => { value.steps = [{ id: 1.5, title: 'x', risk: 'low' }]; }],
    ['string step id', (value) => { value.steps = [{ id: '1', title: 'x', risk: 'low' }]; }],
    ['empty step title', (value) => { value.steps = [{ id: 1, title: '', risk: 'low' }]; }],
    ['invalid step risk', (value) => { value.steps = [{ id: 1, title: 'x', risk: 'extreme' }]; }],
    ['missing filesExpected', (value) => { delete value.filesExpected; }],
    ['non-array filesExpected', (value) => { value.filesExpected = 'src/app.ts'; }],
    ['empty file entry', (value) => { value.filesExpected = ['']; }],
    ['missing estimatedChanges', (value) => { delete value.estimatedChanges; }],
    ['empty estimatedChanges', (value) => { value.estimatedChanges = ' '; }],
    ['invalid plan risk', (value) => { value.riskLevel = 'extreme'; }],
    ['missing plan risk', (value) => { delete value.riskLevel; }],
    ['non-object plan', (value) => { Object.assign(value, { steps: 'bad' }); }],
  ];

  it.each(invalidPlans)('rejects %s', (_label, mutate) => {
    const value = clone(plan()) as unknown as Record<string, unknown>;
    mutate(value);
    expect(() => parseExecutionPlan(value)).toThrow(StructuredOutputError);
  });
});

describe('StructuredJsonParser - reviewer output', () => {
  it('parses a ReviewReport object', () => {
    expect(parseReviewReport(report(), 1)).toEqual(report());
  });

  it('parses fenced reviewer JSON', () => {
    expect(parseReviewReport(`\`\`\`json\n${JSON.stringify(report())}\n\`\`\``, 1)).toEqual(report());
  });

  it('overrides a model-provided review round', () => {
    expect(parseReviewReport(report({ round: 99 }), 2).round).toBe(2);
  });

  it('accepts score boundaries', () => {
    expect(parseReviewReport(report({ score: 0 }), 1).score).toBe(0);
    expect(parseReviewReport(report({ score: 10 }), 1).score).toBe(10);
  });

  it('accepts nullable file and line', () => {
    const parsed = parseReviewReport(report({
      issues: [{
        severity: 'high',
        file: null,
        line: null,
        title: 'Cross-file concern',
        recommendation: 'Inspect the full change',
      }],
    }), 1);
    expect(parsed.issues[0]).toMatchObject({ file: null, line: null });
  });

  it('accepts every supported severity', () => {
    const severities = ['critical', 'high', 'medium', 'low', 'suggestion'] as const;
    const parsed = parseReviewReport(report({
      issues: severities.map((severity) => ({
        severity,
        file: 'src/app.ts',
        line: 1,
        title: severity,
        recommendation: 'Fix it',
      })),
    }), 1);
    expect(parsed.issues.map((issue) => issue.severity)).toEqual(severities);
  });

  it('preserves optional skipped test count', () => {
    expect(parseReviewReport(report({ tests: { passed: 2, failed: 0, skipped: 3 } }), 1).tests.skipped)
      .toBe(3);
  });

  it('strips raw transcript and workflow identity supplied by the model', () => {
    const parsed = parseReviewReport({
      ...report(),
      workflowId: 'forged',
      rawAssistant: 'SECRET',
      transcript: ['SECRET'],
    }, 1);
    expect(parsed).not.toHaveProperty('workflowId');
    expect(parsed).not.toHaveProperty('rawAssistant');
    expect(parsed).not.toHaveProperty('transcript');
  });

  it('strips raw fields nested in issues', () => {
    const parsed = parseReviewReport(report({
      issues: [{
        severity: 'low',
        file: 'a.ts',
        line: 3,
        title: 'Issue',
        recommendation: 'Fix',
        system: 'SECRET',
      } as never],
    }), 1);
    expect(parsed.issues[0]).not.toHaveProperty('system');
  });

  it('supports the parser class facade', () => {
    expect(new StructuredJsonParser().parseReview(report(), 3).round).toBe(3);
  });

  const invalidReviews: Array<[string, (value: Record<string, unknown>) => void]> = [
    ['missing score', (value) => { delete value.score; }],
    ['score below zero', (value) => { value.score = -0.1; }],
    ['score above ten', (value) => { value.score = 10.1; }],
    ['string score', (value) => { value.score = '9'; }],
    ['missing summary', (value) => { delete value.summary; }],
    ['empty summary', (value) => { value.summary = ''; }],
    ['missing issues', (value) => { delete value.issues; }],
    ['non-array issues', (value) => { value.issues = {}; }],
    ['invalid issue severity', (value) => { value.issues = [{ severity: 'fatal', file: null, line: null, title: 'x', recommendation: 'x' }]; }],
    ['zero issue line', (value) => { value.issues = [{ severity: 'high', file: 'a', line: 0, title: 'x', recommendation: 'x' }]; }],
    ['decimal issue line', (value) => { value.issues = [{ severity: 'high', file: 'a', line: 1.5, title: 'x', recommendation: 'x' }]; }],
    ['empty issue title', (value) => { value.issues = [{ severity: 'high', file: 'a', line: 1, title: '', recommendation: 'x' }]; }],
    ['empty recommendation', (value) => { value.issues = [{ severity: 'high', file: 'a', line: 1, title: 'x', recommendation: '' }]; }],
    ['missing tests', (value) => { delete value.tests; }],
    ['negative tests passed', (value) => { value.tests = { passed: -1, failed: 0 }; }],
    ['negative tests failed', (value) => { value.tests = { passed: 1, failed: -1 }; }],
    ['decimal tests passed', (value) => { value.tests = { passed: 1.5, failed: 0 }; }],
    ['string tests failed', (value) => { value.tests = { passed: 1, failed: '0' }; }],
  ];

  it.each(invalidReviews)('rejects %s', (_label, mutate) => {
    const value = clone(report()) as unknown as Record<string, unknown>;
    mutate(value);
    expect(() => parseReviewReport(value, 1)).toThrow(StructuredOutputError);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid expected round %s', (round) => {
    expect(() => parseReviewReport(report(), round)).toThrow('Review round must be a positive integer.');
  });
});

describe('StructuredJsonParser - coder and tester outputs', () => {
  it('parses coder output', () => {
    expect(parseCoderStageOutput({ summary: 'Done', filesChanged: ['a.ts'], testsSuggested: ['npm test'] }))
      .toEqual({ summary: 'Done', filesChanged: ['a.ts'], testsSuggested: ['npm test'] });
  });

  it('defaults coder testsSuggested', () => {
    expect(parseCoderStageOutput({ summary: 'Done', filesChanged: [] }).testsSuggested).toEqual([]);
  });

  it('strips coder raw output', () => {
    expect(parseCoderStageOutput({ summary: 'Done', filesChanged: [], rawAssistant: 'SECRET' }))
      .not.toHaveProperty('rawAssistant');
  });

  it('rejects an empty coder summary', () => {
    expect(() => parseCoderStageOutput({ summary: '', filesChanged: [] })).toThrow(StructuredOutputError);
  });

  it('rejects invalid coder files', () => {
    expect(() => parseCoderStageOutput({ summary: 'Done', filesChanged: [1] })).toThrow(StructuredOutputError);
  });

  it('parses tester output', () => {
    expect(parseTesterStageOutput({
      summary: 'Passed', passed: 2, failed: 0, skipped: 1, commands: ['npm test'],
    })).toEqual({ summary: 'Passed', passed: 2, failed: 0, skipped: 1, commands: ['npm test'] });
  });

  it('defaults tester optional fields', () => {
    expect(parseTesterStageOutput({ summary: 'Passed', passed: 2, failed: 0 }))
      .toMatchObject({ skipped: 0, commands: [] });
  });

  it('strips tester system data', () => {
    expect(parseTesterStageOutput({ summary: 'Passed', passed: 2, failed: 0, systemPrompt: 'SECRET' }))
      .not.toHaveProperty('systemPrompt');
  });

  it('rejects negative tester counts', () => {
    expect(() => parseTesterStageOutput({ summary: 'Bad', passed: -1, failed: 0 }))
      .toThrow(StructuredOutputError);
  });

  it('supports coder and tester class facades', () => {
    const parser = new StructuredJsonParser();
    expect(parser.parseCoder({ summary: 'Done', filesChanged: [] }).summary).toBe('Done');
    expect(parser.parseTester({ summary: 'Done', passed: 1, failed: 0 }).passed).toBe(1);
  });
});
