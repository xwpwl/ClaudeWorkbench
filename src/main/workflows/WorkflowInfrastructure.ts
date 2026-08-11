import crypto from 'node:crypto';
import path from 'node:path';
import type { Checkpoint, CheckpointType } from '../../shared/types/checkpoint';
import type { CliPermissionMode } from '../../shared/types/claude';
import type { CommitPreview, GitStatus } from '../../shared/types/git';
import {
  MODEL_POLICY_AGENT_TYPES,
  MODEL_SELECTION_SOURCES,
  type ProviderCapabilities,
  type ResolvedModelSelection,
  type WorkflowModelSelectionPolicy,
} from '../../shared/types/modelProviders';
import { MODEL_EXECUTION_SOURCES, MODEL_TIERS } from '../../shared/types/modelTiers';
import type {
  AgentModelPolicy,
  AgentType,
  ExecutionPlan,
  ReviewIssue,
  ReviewReport,
  ReviewSeverity,
  Workflow,
  WorkflowChangedEvent,
  WorkflowFailure,
  WorkflowListRequest,
  WorkflowPage,
  WorkflowStagePermission,
  WorkflowStageRecord,
  WorkflowStageStatus,
  WorkflowStatus,
} from '../../shared/types/workflow';
import type { CheckpointManager } from '../checkpoints/CheckpointManager';
import {
  type AppDatabase,
  type PermissionRow,
  type ReviewIssueRow,
  type ReviewRow,
  type WorkflowRow,
  type WorkflowStepRow,
} from '../database/Database';
import { GitWorkspaceError, GitWorkspaceService } from '../git/GitWorkspaceService';
import { normalizeAgentModelPolicy } from './AgentModelPolicy';
import type {
  AgentStageRunner,
  PersistedWorkflowSnapshot,
  WorkflowCheckpointBoundary,
  WorkflowCheckpointGateway,
  WorkflowCheckpointRequest,
  WorkflowDependencies,
  WorkflowEvent,
  WorkflowEventGateway,
  WorkflowGitContext,
  WorkflowGitGateway,
  WorkflowPersistence,
  WorkflowPersistenceExpectation,
} from './contracts';
import { parseExecutionPlan, parseReviewReport } from './StructuredJsonParser';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const METADATA_VERSION = 1;

const WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  'idle',
  'planning',
  'waiting_plan_confirmation',
  'executing',
  'testing',
  'reviewing',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

const AGENT_TYPES = new Set<AgentType>(['planner', 'coder', 'tester', 'reviewer']);
const STAGE_STATUSES = new Set<WorkflowStageStatus>([
  'pending',
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);
const PERMISSION_MODES = new Set<CliPermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);

export type WorkflowInfrastructureErrorCode =
  | 'CAS_CONFLICT'
  | 'CORRUPT_DATA'
  | 'NOT_FOUND'
  | 'PROJECT_MISMATCH';

export class WorkflowInfrastructureError extends Error {
  constructor(
    message: string,
    readonly code: WorkflowInfrastructureErrorCode,
  ) {
    super(message);
    this.name = 'WorkflowInfrastructureError';
  }
}

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

export interface WorkflowPersistencePageRequest extends WorkflowListRequest {
  projectId?: string;
  taskId?: string;
  status?: WorkflowStatus;
}

export type WorkflowStagePageRequest = WorkflowListRequest;

export interface WorkflowNotificationSummary {
  title: string;
  detail: string | null;
  tone: 'info' | 'success' | 'warning' | 'error' | 'neutral';
}

export interface WorkflowNotification extends WorkflowChangedEvent {
  eventType: WorkflowEvent['type'];
  round: number;
  summary: WorkflowNotificationSummary;
  timestamp: string;
}

export type WorkflowNotificationSink = (
  notification: WorkflowNotification,
) => void | Promise<void>;

interface WorkflowCheckpointStore {
  listCheckpoints(taskId: string): Checkpoint[];
  beginWorkflow(taskId: string, workflowId: string): Promise<Checkpoint>;
  createTaskCheckpoint(
    taskId: string,
    type: CheckpointType,
    context?: {
      runId?: string;
      title?: string;
      touchedFiles?: readonly string[];
      reason?: string;
    },
  ): Promise<Checkpoint>;
  createCommitPreview(taskId: string): Promise<CommitPreview>;
}

interface WorkflowGitStatusReader {
  getStatus(projectPath: string): Promise<GitStatus>;
}

export interface WorkflowInfrastructureOptions {
  notification?: WorkflowNotificationSink;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowInfrastructureError(`${label} must be an object.`, 'CORRUPT_DATA');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkflowInfrastructureError(`${label} must be a non-empty string.`, 'CORRUPT_DATA');
  }
  return value;
}

function boundedText(value: unknown, label: string, maximumLength: number): string {
  const result = text(value, label);
  if (result !== result.trim() || result.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new WorkflowInfrastructureError(`${label} is invalid.`, 'CORRUPT_DATA');
  }
  return result;
}

function assertClosedKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(source).some((key) => !allowedSet.has(key))) {
    throw new WorkflowInfrastructureError(`${label} contains unknown fields.`, 'CORRUPT_DATA');
  }
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, label);
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new WorkflowInfrastructureError(
      `${label} must be an integer from ${minimum} to ${maximum}.`,
      'CORRUPT_DATA',
    );
  }
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new WorkflowInfrastructureError(`${label} must be a boolean.`, 'CORRUPT_DATA');
  }
  return value;
}

const MODEL_SELECTION_SOURCE_SET = new Set(MODEL_SELECTION_SOURCES);
const MODEL_EXECUTION_SOURCE_SET = new Set(MODEL_EXECUTION_SOURCES);
const MODEL_TIER_SET = new Set(MODEL_TIERS);

function providerCapabilities(value: unknown, label: string): ProviderCapabilities {
  const source = record(value, label);
  assertClosedKeys(source, [
    'supportsClaudeCode', 'supportsAgentWorkflow', 'supportsTools',
    'supportsMCP', 'supportsStreaming', 'supportsVision',
  ], label);
  const capabilities = {
    supportsClaudeCode: boolean(source.supportsClaudeCode, `${label}.supportsClaudeCode`),
    supportsAgentWorkflow: boolean(
      source.supportsAgentWorkflow,
      `${label}.supportsAgentWorkflow`,
    ),
    supportsTools: boolean(source.supportsTools, `${label}.supportsTools`),
    supportsMCP: boolean(source.supportsMCP, `${label}.supportsMCP`),
    supportsStreaming: boolean(source.supportsStreaming, `${label}.supportsStreaming`),
    supportsVision: boolean(source.supportsVision, `${label}.supportsVision`),
  };
  if (!capabilities.supportsClaudeCode || !capabilities.supportsAgentWorkflow) {
    throw new WorkflowInfrastructureError(
      `${label} is not runnable by Agent Workflow.`,
      'CORRUPT_DATA',
    );
  }
  return Object.freeze(capabilities);
}

function resolvedModelSelection(value: unknown, label: string): ResolvedModelSelection {
  const source = record(value, label);
  assertClosedKeys(source, [
    'providerId', 'providerName', 'modelId', 'runtimeType', 'source',
    'executionSource', 'capabilities', 'tier', 'tierSource',
  ], label);
  const selectionSource = text(source.source, `${label}.source`);
  if (!MODEL_SELECTION_SOURCE_SET.has(selectionSource as ResolvedModelSelection['source'])) {
    throw new WorkflowInfrastructureError(`${label}.source is invalid.`, 'CORRUPT_DATA');
  }
  if (source.runtimeType !== 'claude-code') {
    throw new WorkflowInfrastructureError(`${label}.runtimeType is invalid.`, 'CORRUPT_DATA');
  }
  const executionSource = text(source.executionSource, `${label}.executionSource`);
  if (!MODEL_EXECUTION_SOURCE_SET.has(executionSource as ResolvedModelSelection['executionSource'])) {
    throw new WorkflowInfrastructureError(`${label}.executionSource is invalid.`, 'CORRUPT_DATA');
  }
  const tier = source.tier;
  const tierSource = source.tierSource;
  const hasTier = tier !== undefined;
  if (hasTier !== (tierSource !== undefined)
    || (hasTier && !MODEL_TIER_SET.has(tier as never))
    || (hasTier && tierSource !== 'global' && tierSource !== 'project')) {
    throw new WorkflowInfrastructureError(`${label} tier provenance is invalid.`, 'CORRUPT_DATA');
  }
  const base = {
    providerId: boundedText(source.providerId, `${label}.providerId`, 192),
    providerName: boundedText(source.providerName, `${label}.providerName`, 256),
    modelId: boundedText(source.modelId, `${label}.modelId`, 256),
    runtimeType: 'claude-code',
    source: selectionSource as ResolvedModelSelection['source'],
    executionSource: executionSource as ResolvedModelSelection['executionSource'],
    capabilities: providerCapabilities(source.capabilities, `${label}.capabilities`),
  } as const;
  return Object.freeze(hasTier
    ? { ...base, tier: tier as NonNullable<ResolvedModelSelection['tier']>, tierSource: tierSource as 'global' | 'project' }
    : base);
}

function modelSelectionPolicy(value: unknown): WorkflowModelSelectionPolicy | null {
  if (value === null || value === undefined) return null;
  const source = record(value, 'Workflow model selection policy');
  assertClosedKeys(source, MODEL_POLICY_AGENT_TYPES, 'Workflow model selection policy');
  const selections = Object.fromEntries(MODEL_POLICY_AGENT_TYPES.map((role) => [
    role,
    resolvedModelSelection(source[role], `Workflow ${role} model selection`),
  ])) as Record<(typeof MODEL_POLICY_AGENT_TYPES)[number], ResolvedModelSelection>;
  return Object.freeze(selections);
}

function workflowStatus(value: unknown): WorkflowStatus {
  if (typeof value !== 'string' || !WORKFLOW_STATUSES.has(value as WorkflowStatus)) {
    throw new WorkflowInfrastructureError('Workflow status is invalid.', 'CORRUPT_DATA');
  }
  return value as WorkflowStatus;
}

function agentType(value: unknown, nullable = false): AgentType | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || !AGENT_TYPES.has(value as AgentType)) {
    throw new WorkflowInfrastructureError('Workflow agent type is invalid.', 'CORRUPT_DATA');
  }
  return value as AgentType;
}

function stageStatus(value: unknown): WorkflowStageStatus {
  if (typeof value !== 'string' || !STAGE_STATUSES.has(value as WorkflowStageStatus)) {
    throw new WorkflowInfrastructureError('Workflow stage status is invalid.', 'CORRUPT_DATA');
  }
  return value as WorkflowStageStatus;
}

function permissionMode(value: unknown): CliPermissionMode {
  // Missing/corrupt permission data always fails closed to read-only plan mode.
  return typeof value === 'string' && PERMISSION_MODES.has(value as CliPermissionMode)
    ? value as CliPermissionMode
    : 'plan';
}

function failure(value: unknown): WorkflowFailure | null {
  if (value === null || value === undefined) return null;
  const source = record(value, 'Workflow failure');
  return {
    message: text(source.message, 'Workflow failure message'),
    stage: agentType(source.stage, true),
    ...(typeof source.code === 'string' && source.code.trim() ? { code: source.code } : {}),
  };
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value) as unknown, 'Workflow metadata');
  } catch (error) {
    if (error instanceof WorkflowInfrastructureError) throw error;
    throw new WorkflowInfrastructureError('Workflow metadata is not valid JSON.', 'CORRUPT_DATA');
  }
}

function plan(value: unknown): ExecutionPlan | null {
  if (value === null || value === undefined) return null;
  try {
    return parseExecutionPlan(value);
  } catch {
    throw new WorkflowInfrastructureError('Persisted workflow plan is invalid.', 'CORRUPT_DATA');
  }
}

function review(value: unknown, currentRound: number): ReviewReport | null {
  if (value === null || value === undefined) return null;
  if (currentRound < 1) {
    throw new WorkflowInfrastructureError('A persisted review requires a positive round.', 'CORRUPT_DATA');
  }
  try {
    const source = record(value, 'Workflow review');
    const persistedRound = integer(source.round, 'Workflow review round', 1, 3);
    // While Coder/Tester execute a requested fix, reviewRound already points at
    // the new cycle and latestReview is intentionally the prior round's input.
    if (persistedRound > currentRound || currentRound - persistedRound > 1) {
      throw new WorkflowInfrastructureError(
        'Persisted workflow review is not current or immediately previous.',
        'CORRUPT_DATA',
      );
    }
    return parseReviewReport(value, persistedRound);
  } catch {
    throw new WorkflowInfrastructureError('Persisted workflow review is invalid.', 'CORRUPT_DATA');
  }
}

function publicWorkflow(snapshot: PersistedWorkflowSnapshot): Workflow {
  const {
    activeStage: _activeStage,
    currentModel: _currentModel,
    currentPermissionMode: _currentPermissionMode,
    projectKey: _projectKey,
    sessionKey: _sessionKey,
    resumeSessionId: _resumeSessionId,
    modelSelectionPolicy: _modelSelectionPolicy,
    executionCycle: _executionCycle,
    reviewAccepted: _reviewAccepted,
    pauseReason: _pauseReason,
    ...workflow
  } = snapshot;
  return workflow;
}

export function workflowSummary(snapshot: Workflow): WorkflowSummary {
  return {
    id: snapshot.id,
    taskId: snapshot.taskId,
    projectId: snapshot.projectId,
    projectPath: snapshot.projectPath,
    prompt: snapshot.prompt,
    status: snapshot.status,
    currentStage: snapshot.currentStage,
    reviewRound: snapshot.reviewRound,
    maxReviewRounds: snapshot.maxReviewRounds,
    fixRound: snapshot.fixRound,
    maxFixRounds: snapshot.maxFixRounds,
    revision: snapshot.revision,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

function persistedWorkflow(row: WorkflowRow): PersistedWorkflowSnapshot {
  const metadata = parseMetadata(row.metadata_json);
  if (metadata.version !== undefined && metadata.version !== METADATA_VERSION) {
    throw new WorkflowInfrastructureError('Workflow metadata version is unsupported.', 'CORRUPT_DATA');
  }
  const reviewRound = integer(metadata.reviewRound, 'Workflow reviewRound', 0, 3);
  const currentStage = agentType(row.current_stage, true);
  const maxReviewRounds = integer(
    metadata.maxReviewRounds ?? metadata.maxFixRounds,
    'Workflow maxReviewRounds',
    1,
    3,
  );
  const maxFixRounds = integer(
    metadata.maxFixRounds ?? maxReviewRounds,
    'Workflow maxFixRounds',
    1,
    3,
  );
  const projectPath = text(metadata.projectPath, 'Workflow projectPath');
  const projectKey = typeof metadata.projectKey === 'string' && metadata.projectKey.trim()
    ? metadata.projectKey
    : projectPath;
  const sessionKey = typeof metadata.sessionKey === 'string' && metadata.sessionKey.trim()
    ? metadata.sessionKey
    : `${projectPath}::${row.task_id}`;
  const pausedFromValue = metadata.pausedFrom === null || metadata.pausedFrom === undefined
    ? null
    : workflowStatus(metadata.pausedFrom);
  if (pausedFromValue === 'paused') {
    throw new WorkflowInfrastructureError('pausedFrom cannot itself be paused.', 'CORRUPT_DATA');
  }
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: text(metadata.projectId, 'Workflow projectId'),
    projectPath,
    projectKey,
    sessionKey,
    resumeSessionId: nullableText(metadata.resumeSessionId, 'Workflow resumeSessionId'),
    modelSelectionPolicy: modelSelectionPolicy(metadata.modelSelectionPolicy),
    prompt: text(metadata.prompt, 'Workflow prompt'),
    status: workflowStatus(row.status),
    currentStage,
    activeStage: currentStage,
    modelPolicy: normalizeAgentModelPolicy(
      metadata.modelPolicy && typeof metadata.modelPolicy === 'object'
        ? metadata.modelPolicy as AgentModelPolicy
        : undefined,
    ),
    plan: plan(metadata.plan),
    latestReview: review(metadata.latestReview, reviewRound),
    reviewRound,
    maxReviewRounds,
    fixRound: integer(metadata.fixRound, 'Workflow fixRound', 0, 3),
    maxFixRounds,
    revision: integer(metadata.revision, 'Workflow revision'),
    pausedFrom: pausedFromValue,
    failure: failure(metadata.failure),
    currentModel: nullableText(metadata.currentModel, 'Workflow currentModel'),
    currentPermissionMode: permissionMode(metadata.currentPermissionMode),
    executionCycle: integer(metadata.executionCycle ?? 0, 'Workflow executionCycle'),
    reviewAccepted: metadata.reviewAccepted === true,
    pauseReason: nullableText(metadata.pauseReason, 'Workflow pauseReason'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workflowMetadata(snapshot: PersistedWorkflowSnapshot): string {
  text(snapshot.projectId, 'Workflow projectId');
  text(snapshot.projectPath, 'Workflow projectPath');
  text(snapshot.projectKey, 'Workflow projectKey');
  text(snapshot.sessionKey, 'Workflow sessionKey');
  text(snapshot.prompt, 'Workflow prompt');
  const reviewRound = integer(snapshot.reviewRound, 'Workflow reviewRound', 0, 3);
  const maxReviewRounds = integer(snapshot.maxReviewRounds, 'Workflow maxReviewRounds', 1, 3);
  const maxFixRounds = integer(snapshot.maxFixRounds, 'Workflow maxFixRounds', 1, 3);
  integer(snapshot.fixRound, 'Workflow fixRound', 0, 3);
  integer(snapshot.revision, 'Workflow revision');
  integer(snapshot.executionCycle, 'Workflow executionCycle');
  if (reviewRound > maxReviewRounds || reviewRound > maxFixRounds) {
    throw new WorkflowInfrastructureError('Workflow review round exceeds its configured limit.', 'CORRUPT_DATA');
  }
  if (String(snapshot.pausedFrom) === 'paused') {
    throw new WorkflowInfrastructureError('pausedFrom cannot itself be paused.', 'CORRUPT_DATA');
  }
  if (
    snapshot.latestReview
    && (
      snapshot.latestReview.round > reviewRound
      || reviewRound - snapshot.latestReview.round > 1
    )
  ) {
    throw new WorkflowInfrastructureError(
      'Workflow latest review is not current or immediately previous.',
      'CORRUPT_DATA',
    );
  }
  const normalizedPlan = snapshot.plan === null ? null : plan(snapshot.plan);
  const normalizedReview = snapshot.latestReview === null
    ? null
    : review(snapshot.latestReview, snapshot.latestReview.round);
  if (!WORKFLOW_STATUSES.has(snapshot.status)) {
    throw new WorkflowInfrastructureError('Workflow status is invalid.', 'CORRUPT_DATA');
  }
  if (snapshot.currentStage !== null && !AGENT_TYPES.has(snapshot.currentStage)) {
    throw new WorkflowInfrastructureError('Workflow stage is invalid.', 'CORRUPT_DATA');
  }
  if (!PERMISSION_MODES.has(snapshot.currentPermissionMode)) {
    throw new WorkflowInfrastructureError('Workflow permission mode is invalid.', 'CORRUPT_DATA');
  }
  const metadata = {
    version: METADATA_VERSION,
    projectId: snapshot.projectId,
    projectPath: snapshot.projectPath,
    projectKey: snapshot.projectKey,
    sessionKey: snapshot.sessionKey,
    resumeSessionId: snapshot.resumeSessionId,
    modelSelectionPolicy: modelSelectionPolicy(snapshot.modelSelectionPolicy),
    prompt: snapshot.prompt,
    modelPolicy: normalizeAgentModelPolicy(snapshot.modelPolicy),
    plan: normalizedPlan,
    latestReview: normalizedReview,
    reviewRound: snapshot.reviewRound,
    maxReviewRounds: snapshot.maxReviewRounds,
    fixRound: snapshot.fixRound,
    maxFixRounds: snapshot.maxFixRounds,
    revision: snapshot.revision,
    activeStage: snapshot.currentStage,
    pausedFrom: snapshot.pausedFrom,
    failure: snapshot.failure === null ? null : {
      message: snapshot.failure.message,
      stage: snapshot.failure.stage,
      ...(snapshot.failure.code ? { code: snapshot.failure.code } : {}),
    },
    currentModel: snapshot.currentModel,
    currentPermissionMode: snapshot.currentPermissionMode,
    executionCycle: snapshot.executionCycle,
    reviewAccepted: snapshot.reviewAccepted,
    pauseReason: snapshot.pauseReason,
  };
  return JSON.stringify(metadata);
}

function workflowRow(snapshot: PersistedWorkflowSnapshot): WorkflowRow {
  return {
    id: snapshot.id,
    task_id: snapshot.taskId,
    status: snapshot.status,
    current_stage: snapshot.currentStage,
    created_at: snapshot.createdAt,
    updated_at: snapshot.updatedAt,
    metadata_json: workflowMetadata(snapshot),
  };
}

function ensureStructuredObjectJson(value: string, label: string): string {
  try {
    record(JSON.parse(value) as unknown, label);
    return value;
  } catch (error) {
    if (error instanceof WorkflowInfrastructureError) throw error;
    throw new WorkflowInfrastructureError(`${label} must be valid object JSON.`, 'CORRUPT_DATA');
  }
}

function workflowStepRow(stage: WorkflowStageRecord): WorkflowStepRow {
  return {
    id: stage.id,
    workflow_id: stage.workflowId,
    agent_type: stage.stage,
    review_round: stage.round,
    status: stage.status,
    input: ensureStructuredObjectJson(stage.inputJson, 'Workflow stage input'),
    output: stage.outputJson === null
      ? null
      : ensureStructuredObjectJson(stage.outputJson, 'Workflow stage output'),
    error: stage.error,
    started_at: stage.startedAt,
    completed_at: stage.completedAt,
  };
}

function stageRecord(
  row: WorkflowStepRow,
  permissions: WorkflowStagePermission[] = [],
): WorkflowStageRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    stage: agentType(row.agent_type) as AgentType,
    round: integer(row.review_round, 'Workflow stage round', 0, 3),
    status: stageStatus(row.status),
    inputJson: ensureStructuredObjectJson(row.input, 'Workflow stage input'),
    outputJson: row.output === null
      ? null
      : ensureStructuredObjectJson(row.output, 'Workflow stage output'),
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    permissions,
  };
}

function stageRecordsWithPermissions(
  rows: WorkflowStepRow[],
  permissions: PermissionRow[],
): WorkflowStageRecord[] {
  const byStage = new Map(rows.map((row) => [row.id, [] as WorkflowStagePermission[]]));
  const stagePrefixes = [...byStage.keys()]
    .sort((left, right) => right.length - left.length)
    .map((stageId) => ({ stageId, prefix: `${stageId}:` }));
  for (const permission of permissions) {
    const match = stagePrefixes.find(({ prefix }) => permission.run_id.startsWith(prefix));
    if (!match) continue;
    byStage.get(match.stageId)?.push({
      toolName: permission.tool_name,
      decision: permission.decision,
      createdAt: permission.created_at,
    });
  }
  return rows.map((row) => stageRecord(row, byStage.get(row.id)));
}

function reviewId(workflowId: string, round: number): string {
  return `review:${workflowId}:${round}`;
}

function reviewStepId(workflow: PersistedWorkflowSnapshot, round: number): string {
  return `${workflow.id}:${workflow.executionCycle}:reviewer:${round}`;
}

function reviewRows(
  workflow: PersistedWorkflowSnapshot,
  report: ReviewReport,
): { review: ReviewRow; issues: ReviewIssueRow[] } {
  const normalized = review(report, report.round);
  if (!normalized) {
    throw new WorkflowInfrastructureError('Review is required.', 'CORRUPT_DATA');
  }
  const id = reviewId(workflow.id, normalized.round);
  return {
    review: {
      id,
      workflow_id: workflow.id,
      step_id: reviewStepId(workflow, normalized.round),
      review_round: normalized.round,
      score: normalized.score,
      summary: normalized.summary,
      tests_passed: normalized.tests.passed,
      tests_failed: normalized.tests.failed,
      tests_skipped: normalized.tests.skipped ?? 0,
      created_at: workflow.updatedAt,
    },
    issues: normalized.issues.map((issue, index) => ({
      id: `${id}:issue:${index}`,
      review_id: id,
      severity: issue.severity,
      file_path: issue.file,
      line: issue.line,
      title: issue.title,
      recommendation: issue.recommendation,
      resolved: issue.resolved ?? false,
      created_at: workflow.updatedAt,
    })),
  };
}

function reportFromRows(reviewRow: ReviewRow, issueRows: ReviewIssueRow[]): ReviewReport {
  return {
    id: reviewRow.id,
    workflowId: reviewRow.workflow_id,
    round: reviewRow.review_round,
    score: reviewRow.score,
    summary: reviewRow.summary,
    tests: {
      passed: reviewRow.tests_passed,
      failed: reviewRow.tests_failed,
      skipped: reviewRow.tests_skipped,
    },
    issues: issueRows.map((issue): ReviewIssue => ({
      id: issue.id,
      severity: issue.severity as ReviewSeverity,
      file: issue.file_path,
      line: issue.line,
      title: issue.title,
      recommendation: issue.recommendation,
      resolved: issue.resolved,
    })),
  };
}

function normalizedPage(request: WorkflowListRequest = {}): { limit: number; offset: number } {
  const requestedLimit = Number.isFinite(request.limit)
    ? Math.trunc(request.limit as number)
    : DEFAULT_PAGE_LIMIT;
  const requestedOffset = Number.isFinite(request.offset)
    ? Math.trunc(request.offset as number)
    : 0;
  return {
    limit: Math.min(MAX_PAGE_LIMIT, Math.max(1, requestedLimit)),
    offset: Math.max(0, requestedOffset),
  };
}

export class AppDatabaseWorkflowPersistence implements WorkflowPersistence {
  constructor(private readonly database: AppDatabase) {}

  getWorkflow(workflowId: string): PersistedWorkflowSnapshot | null {
    const row = this.database.getWorkflow(workflowId);
    return row ? persistedWorkflow(row) : null;
  }

  getPublic(workflowId: string): Workflow | null {
    const snapshot = this.getWorkflow(workflowId);
    return snapshot ? publicWorkflow(snapshot) : null;
  }

  getByTask(taskId: string): PersistedWorkflowSnapshot | null {
    const row = this.database.getWorkflowByTaskId(taskId);
    return row ? persistedWorkflow(row) : null;
  }

  createWorkflow(workflow: PersistedWorkflowSnapshot): void {
    this.database.createWorkflow(workflowRow(workflow));
  }

  saveWorkflow(
    workflow: PersistedWorkflowSnapshot,
    expectation: WorkflowPersistenceExpectation,
  ): void {
    const saved = this.database.saveWorkflow(workflowRow(workflow), {
      expectedRevision: expectation.expectedRevision,
      expectedUpdatedAt: expectation.expectedUpdatedAt,
    });
    if (!saved) {
      throw new WorkflowInfrastructureError(
        `Workflow ${workflow.id} changed before it could be saved.`,
        'CAS_CONFLICT',
      );
    }
  }

  saveWorkflowWithReview(
    workflow: PersistedWorkflowSnapshot,
    reviewReport: ReviewReport,
    expectation: WorkflowPersistenceExpectation,
  ): void {
    const rows = reviewRows(workflow, reviewReport);
    const saved = this.database.saveWorkflowWithReview(
      workflowRow(workflow),
      rows.review,
      rows.issues,
      {
        expectedRevision: expectation.expectedRevision,
        expectedUpdatedAt: expectation.expectedUpdatedAt,
      },
    );
    if (!saved) {
      throw new WorkflowInfrastructureError(
        `Workflow ${workflow.id} changed before its review could be saved.`,
        'CAS_CONFLICT',
      );
    }
  }

  listStageRecords(workflowId: string): WorkflowStageRecord[] {
    const total = this.database.countWorkflowSteps(workflowId);
    const rows: WorkflowStepRow[] = [];
    for (let offset = 0; offset < total; offset += MAX_PAGE_LIMIT) {
      rows.push(...this.database.listWorkflowSteps(workflowId, {
        limit: MAX_PAGE_LIMIT,
        offset,
      }));
    }
    return this.withStagePermissions(workflowId, rows);
  }

  listStagePage(
    workflowId: string,
    request: WorkflowStagePageRequest = {},
  ): WorkflowPage<WorkflowStageRecord> {
    const page = normalizedPage(request);
    const rows = this.database.listWorkflowSteps(workflowId, page);
    return {
      items: this.withStagePermissions(workflowId, rows),
      total: this.database.countWorkflowSteps(workflowId),
      ...page,
    };
  }

  upsertStageRecord(stage: WorkflowStageRecord): void {
    this.database.upsertWorkflowStep(workflowStepRow(stage));
  }

  private withStagePermissions(
    workflowId: string,
    rows: WorkflowStepRow[],
  ): WorkflowStageRecord[] {
    const workflow = this.database.getWorkflow(workflowId);
    const permissions = workflow ? this.database.listPermissions(workflow.task_id) : [];
    return stageRecordsWithPermissions(rows, permissions);
  }

  listPage(request: WorkflowPersistencePageRequest = {}): WorkflowPage<Workflow> {
    const page = normalizedPage(request);
    if (request.taskId) {
      const snapshot = this.getByTask(request.taskId);
      const matches = snapshot
        && (request.projectId === undefined || snapshot.projectId === request.projectId)
        && (request.status === undefined || snapshot.status === request.status);
      return {
        items: matches && page.offset === 0 ? [publicWorkflow(snapshot)] : [],
        total: matches ? 1 : 0,
        ...page,
      };
    }
    const rows = request.projectId === undefined
      ? request.status === undefined
        ? this.database.listWorkflows(page)
        : this.database.listWorkflowsByStatus(request.status, page)
      : this.database.listWorkflowsForProject(request.projectId, page, request.status);
    const total = request.projectId === undefined
      ? this.database.countWorkflows(request.status)
      : this.database.countWorkflowsForProject(request.projectId, request.status);
    return { items: rows.map((row) => publicWorkflow(persistedWorkflow(row))), total, ...page };
  }

  getReview(workflowId: string, round?: number): ReviewReport | null {
    const rows = this.database.listReviews(workflowId, { limit: MAX_PAGE_LIMIT, offset: 0 });
    const selected = round === undefined
      ? rows[0]
      : rows.find((candidate) => candidate.review_round === round);
    if (!selected) return null;
    const aggregate = this.database.getReviewWithIssues(selected.id);
    return aggregate ? reportFromRows(aggregate.review, aggregate.issues) : null;
  }
}

export class GitWorkspaceWorkflowGateway implements WorkflowGitGateway {
  constructor(private readonly git: WorkflowGitStatusReader) {}

  async readContext(projectPath: string): Promise<WorkflowGitContext> {
    try {
      const status = await this.git.getStatus(projectPath);
      return {
        kind: 'repository',
        head: status.head,
        branch: status.branch,
        files: status.files.map((file) => ({
          filePath: file.filePath,
          changeType: file.changeType,
          staged: file.staged,
        })),
      };
    } catch (error) {
      if (error instanceof GitWorkspaceError && error.code === 'NOT_A_REPOSITORY') {
        return { kind: 'not_repository', head: null, branch: null, files: [] };
      }
      throw error;
    }
  }
}

const CHECKPOINT_TYPES: Readonly<Record<WorkflowCheckpointBoundary, CheckpointType>> = {
  before_plan: 'before_plan',
  after_plan: 'after_plan',
  before_execute: 'before_execute',
  after_execute: 'after_execute',
  before_fix: 'before_fix',
  after_fix: 'after_fix',
  before_review: 'before_review',
  terminal: 'task_completed',
};

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const checkpointOperations = new WeakMap<AppDatabase, Map<string, Promise<void>>>();

export class CheckpointWorkflowGateway implements WorkflowCheckpointGateway {
  private readonly inFlight: Map<string, Promise<void>>;

  constructor(
    private readonly database: AppDatabase,
    private readonly checkpoints: WorkflowCheckpointStore,
  ) {
    const shared = checkpointOperations.get(database) ?? new Map<string, Promise<void>>();
    checkpointOperations.set(database, shared);
    this.inFlight = shared;
  }

  createCheckpoint(request: WorkflowCheckpointRequest): Promise<void> {
    const identity = `boundary:${request.taskId}:${request.workflowId}:${digest(request.idempotencyKey)}`;
    const running = this.inFlight.get(identity);
    if (running) return running;
    const operation = this.persist(request, identity).finally(() => {
      if (this.inFlight.get(identity) === operation) this.inFlight.delete(identity);
    });
    this.inFlight.set(identity, operation);
    return operation;
  }

  private async persist(request: WorkflowCheckpointRequest, identity: string): Promise<void> {
    const session = this.database.getSession(request.taskId);
    const project = session ? this.database.getProject(session.project_id) : null;
    if (!session || !project) {
      throw new WorkflowInfrastructureError('Workflow checkpoint task was not found.', 'NOT_FOUND');
    }
    if (!samePath(project.path, request.projectPath)) {
      throw new WorkflowInfrastructureError(
        'Workflow checkpoint project does not match the registered task project.',
        'PROJECT_MISMATCH',
      );
    }
    await this.ensureBaseline(request.taskId, request.workflowId);
    const reason = `workflow-boundary:${identity}`;
    const existing = this.checkpoints.listCheckpoints(request.taskId).some((checkpoint) => (
      checkpoint.metadata.runId === request.workflowId
      && checkpoint.metadata.reason === reason
    ));
    if (existing) return;
    await this.checkpoints.createTaskCheckpoint(
      request.taskId,
      CHECKPOINT_TYPES[request.boundary],
      { runId: request.workflowId, reason },
    );
  }

  private ensureBaseline(taskId: string, workflowId: string): Promise<void> {
    const identity = `baseline:${taskId}:${workflowId}`;
    const running = this.inFlight.get(identity);
    if (running) return running;
    const operation = this.checkpoints.beginWorkflow(taskId, workflowId)
      .then(() => undefined)
      .finally(() => {
        if (this.inFlight.get(identity) === operation) this.inFlight.delete(identity);
      });
    this.inFlight.set(identity, operation);
    return operation;
  }
}

function eventSummary(event: WorkflowEvent): WorkflowNotificationSummary {
  const title: Readonly<Record<WorkflowEvent['type'], string>> = {
    workflow_created: 'Workflow created',
    workflow_status_changed: 'Workflow status changed',
    workflow_plan_ready: 'Workflow plan ready',
    workflow_plan_updated: 'Workflow plan updated',
    workflow_stage_started: 'Workflow stage started',
    workflow_stage_completed: 'Workflow stage completed',
    workflow_fix_loop_started: 'Workflow fix loop started',
    workflow_review_accepted: 'Workflow review accepted',
    workflow_user_action_required: 'Workflow needs user action',
    workflow_terminal: 'Workflow finished',
  };
  const tone: WorkflowNotificationSummary['tone'] = event.status === 'failed'
    ? 'error'
    : event.status === 'paused'
      ? 'warning'
      : event.status === 'completed'
        ? 'success'
        : event.status === 'cancelled'
          ? 'neutral'
          : 'info';
  return {
    title: title[event.type],
    detail: [
      `status=${event.status}`,
      event.stage ? `stage=${event.stage}` : null,
      `round=${event.round}`,
    ].filter((item): item is string => item !== null).join('; '),
    tone,
  };
}

export class DatabaseWorkflowEventGateway implements WorkflowEventGateway {
  constructor(
    private readonly database: AppDatabase,
    private readonly persistence: AppDatabaseWorkflowPersistence,
    private readonly notification?: WorkflowNotificationSink,
  ) {}

  async publish(event: WorkflowEvent): Promise<void> {
    if (!this.database.getSession(event.taskId)) return;
    const workflow = this.persistence.getWorkflow(event.workflowId);
    if (!workflow || workflow.taskId !== event.taskId) return;
    const summary = eventSummary(event);
    const timestamp = Number.isFinite(Date.parse(event.timestamp))
      ? new Date(event.timestamp).toISOString()
      : workflow.updatedAt;
    const notification: WorkflowNotification = {
      workflowId: event.workflowId,
      taskId: event.taskId,
      projectId: workflow.projectId,
      status: event.status,
      currentStage: event.stage,
      revision: workflow.revision,
      eventType: event.type,
      round: event.round,
      summary,
      timestamp,
    };
    const eventId = `workflow:${digest(`${event.workflowId}:${event.idempotencyKey}`)}`;
    const payloadJson = JSON.stringify({
      type: 'workflow_progress',
      runId: `workflow:${event.workflowId}`,
      ...notification,
      timestamp: Date.parse(timestamp),
    });
    const inserted = this.database.createEventIfAbsent(
      eventId,
      event.taskId,
      'workflow_progress',
      payloadJson,
      timestamp,
    );
    if (!inserted) {
      const existing = this.database.getEvent(eventId);
      if (
        !existing
        || existing.session_id !== event.taskId
        || existing.event_type !== 'workflow_progress'
        || existing.payload_json !== payloadJson
        || existing.created_at !== timestamp
      ) {
        throw new WorkflowInfrastructureError(
          'Workflow event idempotency key conflicts with persisted content.',
          'CORRUPT_DATA',
        );
      }
      return;
    }
    if (event.type === 'workflow_status_changed' || event.type === 'workflow_terminal') {
      this.synchronizeTaskStatus(event, timestamp);
    }
    if (!this.notification) return;
    try {
      await this.notification(notification);
    } catch {
      // Renderer delivery is best effort; the deterministic task event is durable.
    }
  }

  private synchronizeTaskStatus(event: WorkflowEvent, timestamp: string): void {
    const terminal = event.status === 'completed'
      || event.status === 'failed'
      || event.status === 'cancelled';
    const overallStatus = terminal
      ? event.status
      : event.status === 'paused'
        || event.status === 'idle'
        || event.status === 'waiting_plan_confirmation'
        ? 'idle'
        : 'running';
    this.database.updateTask(event.taskId, {
      status: overallStatus,
      completed_at: terminal ? timestamp : null,
    });
    this.database.updateSessionMetadata(event.taskId, {
      status: overallStatus,
      completedAt: terminal ? timestamp : null,
    });
  }
}

function compact(value: string, maximum = 500): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum)}…` : normalized;
}

export function buildWorkflowCommitPreviewBody(
  workflow: Workflow,
  preview: CommitPreview,
  reviewReport: ReviewReport | null = workflow.latestReview,
): string {
  const lines = [
    '## Workflow',
    '',
    `- ID: ${compact(workflow.id, 200)}`,
    `- Status: ${workflow.status}`,
    `- Review round: ${workflow.reviewRound}/${workflow.maxReviewRounds}`,
  ];
  if (workflow.plan) {
    lines.push('', '## Plan', '', `**${compact(workflow.plan.title)}**`, '', compact(workflow.plan.summary));
  }
  if (reviewReport) {
    lines.push(
      '',
      '## Review',
      '',
      `- Score: ${reviewReport.score}/10`,
      `- Tests: ${reviewReport.tests.passed} passed, ${reviewReport.tests.failed} failed, ${reviewReport.tests.skipped ?? 0} skipped`,
      `- Open issues: ${reviewReport.issues.filter((issue) => !issue.resolved).length}`,
      '',
      compact(reviewReport.summary),
    );
  }
  lines.push('', '## Files', '');
  lines.push(...(preview.files.length > 0
    ? preview.files.map((file) => `- ${compact(file, 500)}`)
    : ['- No files in preview']));
  return `${lines.join('\n')}\n`;
}

export class WorkflowInfrastructure {
  readonly persistence: AppDatabaseWorkflowPersistence;
  readonly git: GitWorkspaceWorkflowGateway;
  readonly checkpoints: CheckpointWorkflowGateway;
  readonly events: DatabaseWorkflowEventGateway;

  constructor(
    database: AppDatabase,
    private readonly checkpointManager: CheckpointManager,
    gitWorkspace: GitWorkspaceService = new GitWorkspaceService(),
    options: WorkflowInfrastructureOptions = {},
  ) {
    this.persistence = new AppDatabaseWorkflowPersistence(database);
    this.git = new GitWorkspaceWorkflowGateway(gitWorkspace);
    this.checkpoints = new CheckpointWorkflowGateway(database, checkpointManager);
    this.events = new DatabaseWorkflowEventGateway(
      database,
      this.persistence,
      options.notification,
    );
  }

  dependencies(runner: AgentStageRunner): WorkflowDependencies {
    return {
      persistence: this.persistence,
      runner,
      checkpoints: this.checkpoints,
      git: this.git,
      events: this.events,
    };
  }

  /** Blocks task-level model switches while an immutable Workflow snapshot still owns the task. */
  isWorkflowActive(taskId: string): boolean {
    const workflow = this.persistence.getByTask(taskId);
    return Boolean(workflow && !['completed', 'failed', 'cancelled'].includes(workflow.status));
  }

  async createCommitPreview(workflowId: string): Promise<CommitPreview> {
    const workflow = this.persistence.getPublic(workflowId);
    if (!workflow) {
      throw new WorkflowInfrastructureError('Workflow was not found.', 'NOT_FOUND');
    }
    const preview = await this.checkpointManager.createCommitPreview(workflow.taskId);
    const latestReview = this.persistence.getReview(workflowId);
    const body = buildWorkflowCommitPreviewBody(workflow, preview, latestReview).trimEnd();
    return { ...preview, message: `${preview.subject}\n\n${body}` };
  }
}

export const workflowInfrastructureInternals = {
  CHECKPOINT_TYPES,
  eventSummary,
  persistedWorkflow,
  publicWorkflow,
  reportFromRows,
  reviewId,
  reviewRows,
  reviewStepId,
  workflowMetadata,
  workflowRow,
};
