import type { AgentStage } from '../../shared/types/workflow';

type JsonSchema = Readonly<Record<string, unknown>>;

const nonEmptyText = (maxLength: number): JsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength,
});

const textList = (maxItems = 500): JsonSchema => ({
  type: 'array',
  maxItems,
  items: nonEmptyText(2_000),
});

const plan: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'steps', 'filesExpected', 'estimatedChanges', 'riskLevel'],
  properties: {
    title: nonEmptyText(500),
    summary: nonEmptyText(20_000),
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'risk'],
        properties: {
          id: { type: 'integer', minimum: 0 },
          title: nonEmptyText(500),
          risk: { enum: ['low', 'medium', 'high'] },
          description: nonEmptyText(20_000),
          status: { enum: ['pending', 'in_progress', 'completed', 'failed', 'skipped', 'cancelled'] },
          acceptanceCriteria: textList(),
        },
      },
    },
    filesExpected: textList(),
    estimatedChanges: nonEmptyText(2_000),
    riskLevel: { enum: ['low', 'medium', 'high'] },
    constraints: textList(),
  },
};

const coder: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'filesChanged', 'testsSuggested'],
  properties: {
    summary: nonEmptyText(20_000),
    filesChanged: textList(),
    testsSuggested: textList(),
  },
};

const tester: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'passed', 'failed', 'skipped', 'commands'],
  properties: {
    summary: nonEmptyText(20_000),
    passed: { type: 'integer', minimum: 0 },
    failed: { type: 'integer', minimum: 0 },
    skipped: { type: 'integer', minimum: 0 },
    commands: textList(),
  },
};

const reviewIssue: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'file', 'line', 'title', 'recommendation'],
  properties: {
    id: nonEmptyText(500),
    severity: { enum: ['critical', 'high', 'medium', 'low', 'suggestion'] },
    file: { anyOf: [nonEmptyText(4_000), { type: 'null' }] },
    line: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    title: nonEmptyText(1_000),
    recommendation: nonEmptyText(20_000),
    resolved: { type: 'boolean' },
  },
};

const reviewer: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['round', 'score', 'summary', 'issues', 'tests'],
  properties: {
    round: { type: 'integer', minimum: 1 },
    score: { type: 'number', minimum: 0, maximum: 10 },
    summary: nonEmptyText(20_000),
    issues: { type: 'array', maxItems: 500, items: reviewIssue },
    tests: {
      type: 'object',
      additionalProperties: false,
      required: ['passed', 'failed', 'skipped'],
      properties: {
        passed: { type: 'integer', minimum: 0 },
        failed: { type: 'integer', minimum: 0 },
        skipped: { type: 'integer', minimum: 0 },
      },
    },
  },
};

const byStage: Readonly<Record<AgentStage, JsonSchema>> = Object.freeze({
  planner: plan,
  coder,
  tester,
  reviewer,
});

/** JSON Schema sent to Claude Code's native structured-output boundary. */
export function structuredOutputSchemaForStage(stage: AgentStage): JsonSchema {
  return byStage[stage];
}

export const agentStructuredOutputSchemas = Object.freeze({ plan, coder, tester, reviewer });
