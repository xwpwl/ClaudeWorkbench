import { z } from 'zod';
import type { ExecutionPlan, ReviewReport } from '../../shared/types/workflow';
import type { CoderStageOutput, TesterStageOutput } from './contracts';

const MAX_TEXT = 20_000;
const MAX_ITEMS = 500;

export class StructuredOutputError extends Error {
  readonly code = 'INVALID_STRUCTURED_OUTPUT';
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = 'StructuredOutputError';
    this.issues = [...issues];
  }
}

const text = (max = MAX_TEXT) => z.string().trim().min(1).max(max);
const stringList = z.array(text(2_000)).max(MAX_ITEMS).transform((items) => [...items]);

const planStepSchema = z.object({
  id: z.number().int().nonnegative(),
  title: text(500),
  risk: z.enum(['low', 'medium', 'high']),
  description: text().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'skipped', 'cancelled']).optional(),
  acceptanceCriteria: stringList.optional(),
});

const executionPlanSchema = z.object({
  title: text(500),
  summary: text(),
  steps: z.array(planStepSchema).min(1).max(200),
  filesExpected: stringList,
  estimatedChanges: text(2_000),
  riskLevel: z.enum(['low', 'medium', 'high']),
  constraints: stringList.optional(),
}).superRefine((plan, context) => {
  const ids = new Set<number>();
  for (let index = 0; index < plan.steps.length; index += 1) {
    const id = plan.steps[index].id;
    if (ids.has(id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps', index, 'id'],
        message: 'step ids must be unique',
      });
    }
    ids.add(id);
  }
});

const reviewIssueSchema = z.object({
  id: text(500).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'suggestion']),
  file: z.union([text(4_000), z.null()]),
  line: z.union([z.number().int().positive(), z.null()]),
  title: text(1_000),
  recommendation: text(),
  resolved: z.boolean().optional(),
});

const reviewSchema = z.object({
  round: z.number().int().positive().optional(),
  score: z.number().min(0).max(10),
  summary: text(),
  issues: z.array(reviewIssueSchema).max(MAX_ITEMS),
  tests: z.object({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative().optional(),
  }),
});

const coderSchema = z.object({
  summary: text(),
  filesChanged: stringList,
  testsSuggested: stringList.default([]),
});

const testerSchema = z.object({
  summary: text(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative().default(0),
  commands: stringList.default([]),
});

function unwrapFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function decode(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const candidate = unwrapFence(value);
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    throw new StructuredOutputError('Agent output is not valid JSON.');
  }
}

function issuePath(path: PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join('.') : '<root>';
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(decode(value));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issuePath(issue.path)}: ${issue.message}`);
    throw new StructuredOutputError(`${label} does not match the required structure.`, issues);
  }
  return parsed.data;
}

/** Parses only allowlisted plan fields; transcript/system metadata is discarded. */
export function parseExecutionPlan(value: unknown): ExecutionPlan {
  return parseWith(executionPlanSchema, value, 'Execution plan');
}

/** The expected round is authoritative and cannot be overridden by model output. */
export function parseReviewReport(value: unknown, expectedRound: number): ReviewReport {
  if (!Number.isInteger(expectedRound) || expectedRound < 1) {
    throw new StructuredOutputError('Review round must be a positive integer.');
  }
  const report = parseWith(reviewSchema, value, 'Review report');
  return { ...report, round: expectedRound };
}

export function parseCoderStageOutput(value: unknown): CoderStageOutput {
  const parsed = parseWith(coderSchema, value, 'Coder result');
  return {
    summary: parsed.summary,
    filesChanged: parsed.filesChanged,
    testsSuggested: parsed.testsSuggested ?? [],
  };
}

export function parseTesterStageOutput(value: unknown): TesterStageOutput {
  const parsed = parseWith(testerSchema, value, 'Tester result');
  return {
    summary: parsed.summary,
    passed: parsed.passed,
    failed: parsed.failed,
    skipped: parsed.skipped ?? 0,
    commands: parsed.commands ?? [],
  };
}

export class StructuredJsonParser {
  parsePlan(value: unknown): ExecutionPlan {
    return parseExecutionPlan(value);
  }

  parseReview(value: unknown, expectedRound: number): ReviewReport {
    return parseReviewReport(value, expectedRound);
  }

  parseCoder(value: unknown): CoderStageOutput {
    return parseCoderStageOutput(value);
  }

  parseTester(value: unknown): TesterStageOutput {
    return parseTesterStageOutput(value);
  }
}
