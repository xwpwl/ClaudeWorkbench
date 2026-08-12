import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { PermissionCapability, PermissionRisk } from '../../shared/types/permissionBroker';
import type { PageResult } from '../../shared/types/workbench';
import releaseContract from '../../shared/release-contract.json';
import {
  AGENT_RUNTIME_TYPES,
  MODEL_SELECTION_SOURCES,
  type ModelPolicyAgentType,
  type ProjectModelPolicyAgentType,
  type AgentRuntimeType,
  type ResolvedModelSelection,
} from '../../shared/types/modelProviders';
import {
  MODEL_EXECUTION_SOURCES,
  MODEL_TIERS,
  type ModelExecutionSource,
  type ModelTier,
} from '../../shared/types/modelTiers';

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_opened_at: string;
}

export interface SessionRow {
  id: string;
  project_id: string;
  claude_session_id: string | null;
  title: string;
  status: string;
  model: string | null;
  permission_mode: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived: boolean;
  tags: string[];
  title_source: 'default' | 'first_prompt' | 'manual' | 'custom' | 'summary';
  message_count?: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface EventRow {
  id: string;
  session_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

/** Trusted main-process binding between one Claude transcript and its resolved model runtime. */
export interface SessionModelBinding {
  claudeSessionId: string;
  providerId: string;
  modelId: string;
  runtimeType: AgentRuntimeType;
  executionSource: ModelExecutionSource;
}

export interface FileChangeRow {
  id: string;
  session_id: string;
  file_path: string;
  change_type: string;
  additions: number;
  deletions: number;
  old_content: string | null;
  new_content: string | null;
  is_binary: boolean;
  created_at: string;
}

export interface TaskRow {
  id: string;
  session_id: string;
  project_id: string;
  status: string;
  agent_mode: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  permission_count: number;
  test_status: string | null;
  test_command: string | null;
  test_output: string | null;
  created_at: string;
  updated_at: string;
}

export interface PermissionRow {
  id: string;
  session_id: string;
  run_id: string;
  tool_name: string;
  decision: string;
  created_at: string;
  resolved_at: string;
}

export interface ProjectSettingsRow {
  project_id: string;
  display_name: string | null;
  default_model: string | null;
  default_permission: string | null;
  agent_mode: string;
  favorite: boolean;
  disabled_mcp_servers: string[];
  updated_at: string;
}

export type ProjectPermissionRuleCapability = Extract<PermissionCapability,
  | 'shell.read_only'
  | 'shell.build'
  | 'shell.test'
  | 'shell.run_project'
  | 'shell.git_read'
  | 'tool.read'>;

export interface ProjectPermissionRuleRow {
  id: string;
  project_id: string;
  scope: 'project';
  canonical_project_path: string;
  tool_name: string;
  capability: ProjectPermissionRuleCapability;
  command_pattern: string | null;
  risk_ceiling: Exclude<PermissionRisk, 'high'>;
  enabled: boolean;
  source: 'user';
  created_at: number;
  updated_at: number;
  last_hit_at: number | null;
  hit_count: number;
}

export interface CheckpointRow {
  id: string;
  task_id: string;
  project_path: string;
  type: string;
  created_at: string;
  git_commit: string | null;
  snapshot_path: string | null;
  metadata_json: string;
}

export interface CheckpointFileRow {
  checkpoint_id: string;
  file_path: string;
  hash: string;
  size: number;
  modified_at: string;
}

export interface WorkflowRow {
  id: string;
  task_id: string;
  status: string;
  current_stage: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface WorkflowStepRow {
  id: string;
  workflow_id: string;
  agent_type: string;
  review_round: number;
  status: string;
  input: string;
  output: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface ReviewRow {
  id: string;
  workflow_id: string;
  step_id: string | null;
  review_round: number;
  score: number;
  summary: string;
  tests_passed: number;
  tests_failed: number;
  tests_skipped: number;
  created_at: string;
}

export interface ReviewIssueRow {
  id: string;
  review_id: string;
  severity: string;
  file_path: string | null;
  line: number | null;
  title: string;
  recommendation: string;
  resolved: boolean;
  created_at: string;
}

export interface WorkflowSaveOptions {
  expectedUpdatedAt?: string;
  expectedRevision?: number;
}

interface LegacyDBData {
  projects?: Record<string, ProjectRow>;
  sessions?: Record<string, Partial<SessionRow> & Pick<SessionRow, 'id' | 'project_id' | 'title' | 'status' | 'created_at' | 'updated_at'>>;
  messages?: Record<string, MessageRow>;
  events?: Record<string, EventRow>;
  fileChanges?: Record<string, Partial<FileChangeRow> & Pick<FileChangeRow, 'id' | 'session_id' | 'file_path' | 'change_type' | 'additions' | 'deletions' | 'created_at'>>;
  settings?: Record<string, string>;
}

export interface PageOptions {
  limit?: number;
  offset?: number;
}

export interface MigrationInfo {
  migratedLegacyJson: boolean;
  backupPath: string | null;
  schemaVersion: number;
}

export interface AppRunRow {
  id: string;
  pid: number;
  build_id: string;
  started_at: string;
  heartbeat_at: string;
  shutdown_started_at: string | null;
  clean_shutdown_at: string | null;
  status: 'running' | 'shutting_down' | 'clean' | 'crashed';
}

export interface ManagedProcessRow {
  id: string;
  app_run_id: string;
  kind: string;
  pid: number;
  parent_pid: number | null;
  creation_time: string | null;
  executable_path: string | null;
  launch_nonce: string;
  project_id: string | null;
  session_id: string | null;
  task_id: string | null;
  run_id: string | null;
  state: string;
  started_at: string;
  stop_requested_at: string | null;
  exited_at: string | null;
  exit_code: number | null;
  signal: string | null;
  error_code: string | null;
}

export interface RecoveryItemRow {
  id: string;
  app_run_id: string | null;
  kind: 'task' | 'workflow' | 'process' | 'permission' | 'mutation';
  resource_id: string;
  project_id: string | null;
  session_id: string | null;
  task_id: string | null;
  last_state: string;
  reason: string;
  status: 'pending' | 'resumed' | 'abandoned' | 'resolved';
  detected_at: string;
  resolved_at: string | null;
  resolution_json: string | null;
}

export interface DatabaseDiagnosticsSummary {
  schemaVersion: number;
  sizeBytes: number;
  journalMode: string;
  integrity: 'ok' | 'failed';
  counts: Record<string, number>;
}

export interface AnonymousPerformanceSource {
  operations: {
    direct: AggregateOperationCounts;
    orchestrated: AggregateOperationCounts;
  };
  durationBuckets: {
    underOneSecond: number;
    oneToTenSeconds: number;
    tenToSixtySeconds: number;
    oneToTenMinutes: number;
    tenMinutesOrMore: number;
  };
}

interface AggregateOperationCounts {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
}

const MAX_ANONYMOUS_AGGREGATE_COUNT = 2_147_483_647;
const KNOWN_DIRECT_STATUSES = new Set([
  'idle', 'starting', 'running', 'waiting_permission',
  'completed', 'failed', 'cancelled', 'interrupted',
]);
const KNOWN_ORCHESTRATED_STATUSES = new Set([
  'idle', 'planning', 'waiting_plan_confirmation', 'executing',
  'testing', 'reviewing', 'paused', 'completed', 'failed', 'cancelled',
]);

function anonymousAggregateCount(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 0
    || value > MAX_ANONYMOUS_AGGREGATE_COUNT
  ) {
    throw new Error('Anonymous performance data is unavailable.');
  }
  return value;
}

export interface ModelProviderDatabaseRow {
  id: string;
  name: string;
  type: 'anthropic' | 'anthropic-compatible' | 'openai-compatible' | 'custom';
  base_url: string | null;
  api_format: 'anthropic-messages' | 'openai-chat-completions';
  runtime_type: 'claude-code' | 'none';
  credential_ref: string | null;
  default_model_id: string | null;
  enabled: number;
  is_default: number;
  supports_claude_code: number;
  supports_agent_workflow: number;
  supports_tools: number;
  supports_mcp: number;
  supports_streaming: number;
  supports_vision: number;
  metadata_json: string;
  health_state: 'not_configured' | 'configured' | 'connected' | 'error';
  last_tested_at: number | null;
  last_error_type:
    | 'invalid_key'
    | 'forbidden'
    | 'not_found'
    | 'rate_limited'
    | 'timeout'
    | 'network'
    | 'invalid_response'
    | 'unknown'
    | null;
  latency_ms: number | null;
  created_at: number;
  updated_at: number;
}

export interface ModelProviderModelDatabaseRow {
  provider_id: string;
  model_id: string;
  display_name: string | null;
  source: 'manual' | 'discovered';
  created_at: number;
  updated_at: number;
}

export type CredentialCleanupErrorType =
  | 'not_found'
  | 'io'
  | 'permission'
  | 'invalid_ref'
  | 'unknown';

export interface CredentialCleanupDatabaseRow {
  id: string;
  provider_id: string | null;
  credential_ref: string;
  attempts: number;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  last_error_type: CredentialCleanupErrorType | null;
  created_at: number;
  updated_at: number;
}

export type ModelPolicyRating = 'low' | 'medium' | 'high';

export interface AgentModelPolicyDatabaseRow {
  agent_type: ModelPolicyAgentType;
  provider_id: string | null;
  model_id: string | null;
  tier: ModelTier | null;
  quality: ModelPolicyRating | null;
  speed: ModelPolicyRating | null;
  cost: ModelPolicyRating | null;
  created_at: number;
  updated_at: number;
}

export interface ProjectModelPolicyDatabaseRow {
  project_id: string;
  agent_type: ProjectModelPolicyAgentType;
  provider_id: string | null;
  model_id: string | null;
  tier: ModelTier | null;
  created_at: number;
  updated_at: number;
}

export interface ModelTierBindingDatabaseRow {
  tier: ModelTier;
  provider_id: string | null;
  model_id: string | null;
  display_name: string | null;
  quality: ModelPolicyRating | null;
  speed: ModelPolicyRating | null;
  cost: ModelPolicyRating | null;
  updated_at: number;
}

export interface ProjectModelTierBindingDatabaseRow extends ModelTierBindingDatabaseRow {
  project_id: string;
}

export interface TaskModelOverrideDatabaseRow {
  task_id: string;
  provider_id: string;
  model_id: string;
  created_at: number;
  updated_at: number;
}

const SCHEMA_VERSION = releaseContract.sqliteSchemaVersion;
const DEFAULT_PAGE_LIMIT = 10_000;
const MAX_PAGE_LIMIT = 10_000;
const DEFAULT_WORKFLOW_PAGE_LIMIT = 50;
const MAX_WORKFLOW_PAGE_LIMIT = 100;
const WORKFLOW_MODEL_SELECTION_TRUST_KEY = '__modelSelectionAttachedByMain';

function nowIso(): string {
  return new Date().toISOString();
}

function safeBindingText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_048 || normalized.includes('\0')) return null;
  return normalized;
}

function workflowSelectionText(value: unknown, maximumLength: number, label: string): string {
  if (typeof value !== 'string'
    || value !== value.trim()
    || !value
    || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Workflow model selection ${label} is invalid.`);
  }
  return value;
}

function withoutUntrustedWorkflowModelSelection(input: string): string {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return input;
    const safeInput = { ...(parsed as Record<string, unknown>) };
    const hasSelection = Object.prototype.hasOwnProperty.call(safeInput, 'modelSelection');
    const hasTrustMarker = Object.prototype.hasOwnProperty.call(
      safeInput,
      WORKFLOW_MODEL_SELECTION_TRUST_KEY,
    );
    if (!hasSelection && !hasTrustMarker) return input;
    delete safeInput.modelSelection;
    delete safeInput[WORKFLOW_MODEL_SELECTION_TRUST_KEY];
    return JSON.stringify(safeInput);
  } catch {
    // Let the workflow_steps JSON constraints retain ownership of malformed input.
    return input;
  }
}

function withoutWorkflowModelSelectionTrustMarker(input: string): string {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return input;
    const safeInput = { ...(parsed as Record<string, unknown>) };
    if (!Object.prototype.hasOwnProperty.call(safeInput, WORKFLOW_MODEL_SELECTION_TRUST_KEY)) {
      return input;
    }
    delete safeInput[WORKFLOW_MODEL_SELECTION_TRUST_KEY];
    return JSON.stringify(safeInput);
  } catch {
    return input;
  }
}

function withoutWorkflowStepTrustMetadata(step: WorkflowStepRow): WorkflowStepRow {
  return {
    ...step,
    input: withoutWorkflowModelSelectionTrustMarker(step.input),
  };
}

function page(options?: PageOptions): { limit: number; offset: number } {
  const requestedLimit = Number.isFinite(options?.limit)
    ? Math.floor(options!.limit as number)
    : DEFAULT_PAGE_LIMIT;
  const requestedOffset = Number.isFinite(options?.offset)
    ? Math.floor(options!.offset as number)
    : 0;
  return {
    limit: Math.max(1, Math.min(MAX_PAGE_LIMIT, requestedLimit)),
    offset: Math.max(0, requestedOffset),
  };
}

function workflowPage(options?: PageOptions): { limit: number; offset: number } {
  const requestedLimit = Number.isFinite(options?.limit)
    ? Math.floor(options!.limit as number)
    : DEFAULT_WORKFLOW_PAGE_LIMIT;
  const requestedOffset = Number.isFinite(options?.offset)
    ? Math.floor(options!.offset as number)
    : 0;
  return {
    limit: Math.max(1, Math.min(MAX_WORKFLOW_PAGE_LIMIT, requestedLimit)),
    offset: Math.max(0, requestedOffset),
  };
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupPathFor(databasePath: string, reason: 'legacy' | 'startup-failed'): string {
  return `${databasePath}.${reason}-${timestampForPath()}.backup`;
}

function moveDatabaseFamily(databasePath: string, backupPath: string): void {
  if (fs.existsSync(databasePath)) fs.renameSync(databasePath, backupPath);
  for (const suffix of ['-wal', '-shm']) {
    const source = `${databasePath}${suffix}`;
    if (fs.existsSync(source)) fs.renameSync(source, `${backupPath}${suffix}`);
  }
}

function prepareLegacySource(databasePath: string): {
  data: LegacyDBData | null;
  backupPath: string | null;
} {
  if (!fs.existsSync(databasePath)) return { data: null, backupPath: null };
  const header = fs.readFileSync(databasePath).subarray(0, 32).toString('utf8');
  if (header.startsWith('SQLite format 3')) return { data: null, backupPath: null };

  const backupPath = backupPathFor(databasePath, 'legacy');
  let data: LegacyDBData;
  try {
    const parsed = JSON.parse(fs.readFileSync(databasePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Legacy database root must be a JSON object.');
    }
    data = parsed as LegacyDBData;
  } catch (error) {
    // Fail closed: a damaged SQLite header and malformed legacy JSON are both
    // user data. Never replace either with a silently empty database.
    throw new Error(
      `Existing database is neither valid SQLite nor valid legacy Workbench JSON: ${databasePath}`,
      { cause: error },
    );
  }
  moveDatabaseFamily(databasePath, backupPath);
  return { data, backupPath };
}

function tagsFromJson(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function projectPermissionRuleFromSql(
  row: Record<string, unknown> | undefined,
): ProjectPermissionRuleRow | null {
  if (!row) return null;
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    scope: row.scope as ProjectPermissionRuleRow['scope'],
    canonical_project_path: String(row.canonical_project_path),
    tool_name: String(row.tool_name),
    capability: row.capability as ProjectPermissionRuleCapability,
    command_pattern: row.command_pattern === null ? null : String(row.command_pattern),
    risk_ceiling: row.risk_ceiling as ProjectPermissionRuleRow['risk_ceiling'],
    enabled: Boolean(row.enabled),
    source: row.source as ProjectPermissionRuleRow['source'],
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_hit_at: row.last_hit_at === null ? null : Number(row.last_hit_at),
    hit_count: Number(row.hit_count),
  };
}

function sessionFromSql(row: Record<string, unknown> | undefined): SessionRow | null {
  if (!row) return null;
  return {
    ...(row as unknown as Omit<SessionRow, 'archived' | 'tags'>),
    archived: Boolean(row.archived),
    tags: tagsFromJson(row.tags_json),
  };
}

function fileChangeFromSql(row: Record<string, unknown>): FileChangeRow {
  return {
    ...(row as unknown as Omit<FileChangeRow, 'is_binary'>),
    is_binary: Boolean(row.is_binary),
  };
}

function projectSettingsFromSql(row: Record<string, unknown> | undefined): ProjectSettingsRow | null {
  if (!row) return null;
  return {
    ...(row as unknown as Omit<ProjectSettingsRow, 'favorite' | 'disabled_mcp_servers'>),
    favorite: Boolean(row.favorite),
    disabled_mcp_servers: tagsFromJson(row.disabled_mcp_json),
  };
}

function reviewIssueFromSql(row: Record<string, unknown>): ReviewIssueRow {
  return {
    ...(row as unknown as Omit<ReviewIssueRow, 'resolved'>),
    resolved: Boolean(row.resolved),
  };
}

function reviewRowsEqual(left: ReviewRow, right: ReviewRow): boolean {
  return left.id === right.id
    && left.workflow_id === right.workflow_id
    && left.step_id === right.step_id
    && left.review_round === right.review_round
    && left.score === right.score
    && left.summary === right.summary
    && left.tests_passed === right.tests_passed
    && left.tests_failed === right.tests_failed
    && left.tests_skipped === right.tests_skipped
    && left.created_at === right.created_at;
}

function reviewIssueRowsEqual(left: ReviewIssueRow, right: ReviewIssueRow): boolean {
  return left.id === right.id
    && left.review_id === right.review_id
    && left.severity === right.severity
    && left.file_path === right.file_path
    && left.line === right.line
    && left.title === right.title
    && left.recommendation === right.recommendation
    && left.resolved === right.resolved
    && left.created_at === right.created_at;
}

export class AppDatabase {
  private database!: BetterSqlite3.Database;
  private readonly dbPath: string;
  private migrationInfo: MigrationInfo;

  constructor(dbPath: string) {
    this.dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const sourceExisted = fs.existsSync(this.dbPath);
    const legacy = prepareLegacySource(this.dbPath);
    const existingSqlite = sourceExisted && legacy.backupPath === null;

    try {
      this.database = new BetterSqlite3(this.dbPath);
      this.initializeSchema();
      if (legacy.data) this.importLegacyData(legacy.data);
    } catch (error) {
      try {
        this.database?.close();
      } catch {
        // Ignore a secondary close error while preserving the original failure.
      }
      // A schema migration is transactional. Keep an existing SQLite file in
      // place so its rolled-back schema and data remain immediately usable for
      // diagnosis or a later fixed migration attempt.
      if (!existingSqlite && fs.existsSync(this.dbPath)) {
        const failedBackup = backupPathFor(this.dbPath, 'startup-failed');
        moveDatabaseFamily(this.dbPath, failedBackup);
      }
      if (legacy.backupPath && !fs.existsSync(this.dbPath)) {
        fs.renameSync(legacy.backupPath, this.dbPath);
      }
      throw error;
    }

    this.migrationInfo = {
      migratedLegacyJson: Boolean(legacy.data),
      backupPath: legacy.backupPath,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  async ready(): Promise<void> {
    this.database.prepare('SELECT 1').get();
  }

  getMigrationInfo(): MigrationInfo {
    return { ...this.migrationInfo };
  }

  runInTransaction<T>(work: () => T): T {
    return this.database.transaction(work)();
  }

  private initializeSchema(): void {
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = NORMAL');
    this.database.pragma('foreign_keys = ON');

    const currentVersion = this.database.pragma('user_version', { simple: true }) as number;
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}`,
      );
    }
    this.database.transaction(() => {
      if (currentVersion < 1) this.migrateToVersion1();
      if (currentVersion < 2) this.migrateToVersion2();
      if (currentVersion < 3) this.migrateToVersion3();
      if (currentVersion < 4) this.migrateToVersion4();
      if (currentVersion < 5) this.migrateToVersion5();
      if (currentVersion < 6) this.migrateToVersion6();
      if (currentVersion < 7) this.migrateToVersion7();
      const foreignKeys = this.database.pragma('foreign_key_check') as unknown[];
      const integrity = this.database.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (foreignKeys.length > 0 || integrity.some((row) => row.integrity_check !== 'ok')) {
        throw new Error('Database integrity validation failed after migration.');
      }
    })();
  }

  private migrateToVersion1(): void {
    this.database.transaction(() => {
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        claude_session_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        permission_mode TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT NOT NULL DEFAULT '[]',
        title_source TEXT NOT NULL DEFAULT 'default'
      );
      CREATE INDEX IF NOT EXISTS sessions_project_updated_idx
        ON sessions(project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_session_created_idx
        ON messages(session_id, created_at ASC);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session_created_idx
        ON events(session_id, created_at ASC);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        agent_mode TEXT NOT NULL DEFAULT 'normal',
        started_at TEXT,
        completed_at TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        permission_count INTEGER NOT NULL DEFAULT 0,
        test_status TEXT,
        test_command TEXT,
        test_output TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_project_status_idx
        ON tasks(project_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS file_changes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        change_type TEXT NOT NULL,
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        old_content TEXT,
        new_content TEXT,
        is_binary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS file_changes_session_created_idx
        ON file_changes(session_id, created_at ASC);
      CREATE TABLE IF NOT EXISTS permissions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        decision TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS permissions_session_created_idx
        ON permissions(session_id, created_at ASC);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_settings (
        project_id TEXT PRIMARY KEY,
        display_name TEXT,
        default_model TEXT,
        default_permission TEXT,
        agent_mode TEXT NOT NULL DEFAULT 'normal',
        favorite INTEGER NOT NULL DEFAULT 0,
        disabled_mcp_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
      `);
      this.database.pragma('user_version = 1');
    })();
  }

  private migrateToVersion2(): void {
    this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          project_path TEXT NOT NULL,
          type TEXT NOT NULL,
          created_at TEXT NOT NULL,
          git_commit TEXT,
          snapshot_path TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS checkpoints_task_created_idx
          ON checkpoints(task_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS checkpoints_project_created_idx
          ON checkpoints(project_path, created_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS checkpoint_files (
          checkpoint_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          hash TEXT NOT NULL,
          size INTEGER NOT NULL,
          modified_at TEXT NOT NULL,
          PRIMARY KEY (checkpoint_id, file_path),
          FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS checkpoint_files_path_idx
          ON checkpoint_files(file_path);
      `);
      this.database.pragma('user_version = 2');
    })();
  }

  private migrateToVersion3(): void {
    this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS workflows (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK (status IN (
            'idle', 'planning', 'waiting_plan_confirmation', 'executing',
            'testing', 'reviewing', 'paused', 'completed', 'failed', 'cancelled'
          )),
          current_stage TEXT CHECK (
            current_stage IS NULL OR current_stage IN ('planner', 'coder', 'tester', 'reviewer')
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
            json_valid(metadata_json) AND json_type(metadata_json) = 'object'
          ),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS workflows_task_updated_idx
          ON workflows(task_id, updated_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS workflows_status_updated_idx
          ON workflows(status, updated_at DESC, id DESC);

        CREATE TABLE IF NOT EXISTS workflow_steps (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          agent_type TEXT NOT NULL CHECK (agent_type IN ('planner', 'coder', 'tester', 'reviewer')),
          review_round INTEGER NOT NULL DEFAULT 0 CHECK (review_round BETWEEN 0 AND 3),
          status TEXT NOT NULL CHECK (status IN (
            'pending', 'running', 'completed', 'failed', 'cancelled', 'skipped'
          )),
          input TEXT NOT NULL CHECK (json_valid(input) AND json_type(input) = 'object'),
          output TEXT CHECK (
            output IS NULL OR (json_valid(output) AND json_type(output) = 'object')
          ),
          error TEXT,
          started_at TEXT,
          completed_at TEXT,
          CHECK (
            (agent_type = 'planner' AND review_round = 0)
            OR (agent_type IN ('coder', 'tester', 'reviewer') AND review_round BETWEEN 1 AND 3)
          ),
          FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS workflow_steps_workflow_started_idx
          ON workflow_steps(workflow_id, started_at ASC, id ASC);
        CREATE INDEX IF NOT EXISTS workflow_steps_workflow_status_idx
          ON workflow_steps(workflow_id, status, started_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS workflow_steps_workflow_round_idx
          ON workflow_steps(workflow_id, review_round ASC, agent_type, id ASC);

        CREATE TABLE IF NOT EXISTS reviews (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          step_id TEXT,
          review_round INTEGER NOT NULL CHECK (review_round BETWEEN 1 AND 3),
          score REAL NOT NULL CHECK (score >= 0 AND score <= 10),
          summary TEXT NOT NULL,
          tests_passed INTEGER NOT NULL DEFAULT 0 CHECK (tests_passed >= 0),
          tests_failed INTEGER NOT NULL DEFAULT 0 CHECK (tests_failed >= 0),
          tests_skipped INTEGER NOT NULL DEFAULT 0 CHECK (tests_skipped >= 0),
          created_at TEXT NOT NULL,
          FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
          FOREIGN KEY (step_id) REFERENCES workflow_steps(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS reviews_workflow_round_idx
          ON reviews(workflow_id, review_round DESC, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS reviews_step_idx
          ON reviews(step_id);

        CREATE TABLE IF NOT EXISTS review_issues (
          id TEXT PRIMARY KEY,
          review_id TEXT NOT NULL,
          severity TEXT NOT NULL CHECK (severity IN (
            'critical', 'high', 'medium', 'low', 'suggestion'
          )),
          file_path TEXT,
          line INTEGER,
          title TEXT NOT NULL,
          recommendation TEXT NOT NULL,
          resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
          created_at TEXT NOT NULL,
          FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS review_issues_review_severity_idx
          ON review_issues(review_id, severity, id);
        CREATE INDEX IF NOT EXISTS review_issues_review_created_idx
          ON review_issues(review_id, created_at ASC, id ASC);
      `);
      this.database.pragma('user_version = 3');
    })();
  }

  private migrateToVersion4(): void {
    this.database.transaction(() => {
      // workflow_steps needs an explicit interrupted state. Rebuild the small
      // review graph as one transaction so every foreign key remains valid.
      this.database.exec(`
        CREATE TABLE workflow_steps_v4 (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          agent_type TEXT NOT NULL CHECK (agent_type IN ('planner', 'coder', 'tester', 'reviewer')),
          review_round INTEGER NOT NULL DEFAULT 0 CHECK (review_round BETWEEN 0 AND 3),
          status TEXT NOT NULL CHECK (status IN (
            'pending', 'running', 'interrupted', 'completed', 'failed', 'cancelled', 'skipped'
          )),
          input TEXT NOT NULL CHECK (json_valid(input) AND json_type(input) = 'object'),
          output TEXT CHECK (
            output IS NULL OR (json_valid(output) AND json_type(output) = 'object')
          ),
          error TEXT,
          started_at TEXT,
          completed_at TEXT,
          CHECK (
            (agent_type = 'planner' AND review_round = 0)
            OR (agent_type IN ('coder', 'tester', 'reviewer') AND review_round BETWEEN 1 AND 3)
          ),
          FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
        );
        INSERT INTO workflow_steps_v4 SELECT * FROM workflow_steps;

        CREATE TABLE reviews_v4 (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          step_id TEXT,
          review_round INTEGER NOT NULL CHECK (review_round BETWEEN 1 AND 3),
          score REAL NOT NULL CHECK (score >= 0 AND score <= 10),
          summary TEXT NOT NULL,
          tests_passed INTEGER NOT NULL DEFAULT 0 CHECK (tests_passed >= 0),
          tests_failed INTEGER NOT NULL DEFAULT 0 CHECK (tests_failed >= 0),
          tests_skipped INTEGER NOT NULL DEFAULT 0 CHECK (tests_skipped >= 0),
          created_at TEXT NOT NULL,
          FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
          FOREIGN KEY (step_id) REFERENCES workflow_steps_v4(id) ON DELETE SET NULL
        );
        INSERT INTO reviews_v4 SELECT * FROM reviews;

        CREATE TABLE review_issues_v4 (
          id TEXT PRIMARY KEY,
          review_id TEXT NOT NULL,
          severity TEXT NOT NULL CHECK (severity IN (
            'critical', 'high', 'medium', 'low', 'suggestion'
          )),
          file_path TEXT,
          line INTEGER,
          title TEXT NOT NULL,
          recommendation TEXT NOT NULL,
          resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
          created_at TEXT NOT NULL,
          FOREIGN KEY (review_id) REFERENCES reviews_v4(id) ON DELETE CASCADE
        );
        INSERT INTO review_issues_v4 SELECT * FROM review_issues;

        DROP TABLE review_issues;
        DROP TABLE reviews;
        DROP TABLE workflow_steps;
        ALTER TABLE workflow_steps_v4 RENAME TO workflow_steps;
        ALTER TABLE reviews_v4 RENAME TO reviews;
        ALTER TABLE review_issues_v4 RENAME TO review_issues;

        CREATE INDEX workflow_steps_workflow_started_idx
          ON workflow_steps(workflow_id, started_at ASC, id ASC);
        CREATE INDEX workflow_steps_workflow_status_idx
          ON workflow_steps(workflow_id, status, started_at DESC, id DESC);
        CREATE INDEX workflow_steps_workflow_round_idx
          ON workflow_steps(workflow_id, review_round ASC, agent_type, id ASC);
        CREATE INDEX reviews_workflow_round_idx
          ON reviews(workflow_id, review_round DESC, created_at DESC, id DESC);
        CREATE INDEX reviews_step_idx ON reviews(step_id);
        CREATE INDEX review_issues_review_severity_idx
          ON review_issues(review_id, severity, id);
        CREATE INDEX review_issues_review_created_idx
          ON review_issues(review_id, created_at ASC, id ASC);

        CREATE TABLE IF NOT EXISTS app_runs (
          id TEXT PRIMARY KEY,
          pid INTEGER NOT NULL,
          build_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          shutdown_started_at TEXT,
          clean_shutdown_at TEXT,
          status TEXT NOT NULL CHECK (status IN ('running', 'shutting_down', 'clean', 'crashed'))
        );
        CREATE INDEX IF NOT EXISTS app_runs_status_started_idx ON app_runs(status, started_at DESC);

        CREATE TABLE IF NOT EXISTS managed_processes (
          id TEXT PRIMARY KEY,
          app_run_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          pid INTEGER NOT NULL,
          parent_pid INTEGER,
          creation_time TEXT,
          executable_path TEXT,
          launch_nonce TEXT NOT NULL,
          project_id TEXT,
          session_id TEXT,
          task_id TEXT,
          run_id TEXT,
          state TEXT NOT NULL,
          started_at TEXT NOT NULL,
          stop_requested_at TEXT,
          exited_at TEXT,
          exit_code INTEGER,
          signal TEXT,
          error_code TEXT,
          FOREIGN KEY (app_run_id) REFERENCES app_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS managed_processes_app_state_idx
          ON managed_processes(app_run_id, state, started_at DESC);
        CREATE INDEX IF NOT EXISTS managed_processes_run_idx ON managed_processes(run_id, started_at DESC);

        CREATE TABLE IF NOT EXISTS mutation_operations (
          id TEXT PRIMARY KEY,
          app_run_id TEXT,
          project_id TEXT,
          project_path TEXT NOT NULL,
          session_id TEXT,
          task_id TEXT,
          run_id TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          file_paths_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(file_paths_json)),
          fingerprint_json TEXT CHECK (fingerprint_json IS NULL OR json_valid(fingerprint_json)),
          started_at TEXT NOT NULL,
          completed_at TEXT,
          error TEXT,
          FOREIGN KEY (app_run_id) REFERENCES app_runs(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS mutation_operations_status_started_idx
          ON mutation_operations(status, started_at DESC);

        CREATE TABLE IF NOT EXISTS permission_requests (
          id TEXT PRIMARY KEY,
          app_run_id TEXT,
          project_id TEXT,
          session_id TEXT,
          task_id TEXT,
          run_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'interrupted')),
          requested_at TEXT NOT NULL,
          resolved_at TEXT,
          FOREIGN KEY (app_run_id) REFERENCES app_runs(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS permission_requests_status_requested_idx
          ON permission_requests(status, requested_at DESC);

        CREATE TABLE IF NOT EXISTS recovery_items (
          id TEXT PRIMARY KEY,
          app_run_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('task', 'workflow', 'process', 'permission', 'mutation')),
          resource_id TEXT NOT NULL,
          project_id TEXT,
          session_id TEXT,
          task_id TEXT,
          last_state TEXT NOT NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resumed', 'abandoned', 'resolved')),
          detected_at TEXT NOT NULL,
          resolved_at TEXT,
          resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
          FOREIGN KEY (app_run_id) REFERENCES app_runs(id) ON DELETE SET NULL,
          UNIQUE(kind, resource_id, reason)
        );
        CREATE INDEX IF NOT EXISTS recovery_items_status_detected_idx
          ON recovery_items(status, detected_at DESC, id DESC);
      `);
      this.database.pragma('user_version = 4');
    })();
  }

  private migrateToVersion5(): void {
    this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS project_permission_rules (
          id TEXT PRIMARY KEY CHECK (
            length(trim(id)) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0
          ),
          project_id TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope = 'project'),
          canonical_project_path TEXT NOT NULL CHECK (
            length(trim(canonical_project_path)) > 0
            AND instr(canonical_project_path, char(0)) = 0
          ),
          tool_name TEXT NOT NULL CHECK (
            length(trim(tool_name)) BETWEEN 1 AND 128
            AND tool_name = lower(trim(tool_name))
            AND instr(tool_name, char(0)) = 0
          ),
          capability TEXT NOT NULL,
          command_pattern TEXT CHECK (
            command_pattern IS NULL OR (
              typeof(command_pattern) = 'text'
              AND length(trim(command_pattern)) BETWEEN 1 AND 4096
              AND instr(command_pattern, char(0)) = 0
            )
          ),
          risk_ceiling TEXT NOT NULL CHECK (risk_ceiling IN ('low', 'medium')),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          source TEXT NOT NULL DEFAULT 'user' CHECK (source = 'user'),
          created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          updated_at INTEGER NOT NULL CHECK (
            typeof(updated_at) = 'integer' AND updated_at >= created_at
          ),
          last_hit_at INTEGER CHECK (
            last_hit_at IS NULL OR (typeof(last_hit_at) = 'integer' AND last_hit_at >= 0)
          ),
          hit_count INTEGER NOT NULL DEFAULT 0 CHECK (
            typeof(hit_count) = 'integer' AND hit_count >= 0
          ),
          CHECK (
            (hit_count = 0 AND last_hit_at IS NULL)
            OR (hit_count > 0 AND last_hit_at IS NOT NULL)
          ),
          CHECK (
            (tool_name IN ('bash', 'shell', 'powershell', 'cmd') AND capability IN (
              'shell.read_only', 'shell.build', 'shell.test',
              'shell.run_project', 'shell.git_read'
            ))
            OR (tool_name IN ('read', 'glob', 'grep', 'ls') AND capability = 'tool.read')
          ),
          CHECK (
            (capability IN ('shell.read_only', 'shell.git_read', 'tool.read')
              AND risk_ceiling = 'low')
            OR (capability IN ('shell.build', 'shell.test', 'shell.run_project')
              AND risk_ceiling = 'medium')
          ),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS project_permission_rules_project_enabled_idx
          ON project_permission_rules(project_id, enabled, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS project_permission_rules_project_match_idx
          ON project_permission_rules(
            project_id, canonical_project_path, tool_name, capability,
            command_pattern, risk_ceiling, enabled
          );
      `);
      this.validateVersion5PermissionRuleSchema();
      this.database.pragma('user_version = 5');
    })();
  }

  private validateVersion5PermissionRuleSchema(): void {
    const expectedColumns = [
      'id', 'project_id', 'scope', 'canonical_project_path', 'tool_name',
      'capability', 'command_pattern', 'risk_ceiling', 'enabled', 'source',
      'created_at', 'updated_at', 'last_hit_at', 'hit_count',
    ];
    const columns = this.database.pragma('table_info(project_permission_rules)') as Array<{
      name: string;
    }>;
    if (columns.map((column) => column.name).join('\0') !== expectedColumns.join('\0')) {
      throw new Error('Existing project_permission_rules schema is incompatible with version 5.');
    }

    const foreignKeys = this.database.pragma(
      'foreign_key_list(project_permission_rules)',
    ) as Array<Record<string, unknown>>;
    if (foreignKeys.length !== 1
      || foreignKeys[0].table !== 'projects'
      || foreignKeys[0].from !== 'project_id'
      || foreignKeys[0].to !== 'id'
      || foreignKeys[0].on_delete !== 'CASCADE') {
      throw new Error('Existing project_permission_rules foreign key is incompatible with version 5.');
    }

    const expectedIndexes: Record<string, string[]> = {
      project_permission_rules_project_enabled_idx: [
        'project_id', 'enabled', 'created_at', 'id',
      ],
      project_permission_rules_project_match_idx: [
        'project_id', 'canonical_project_path', 'tool_name', 'capability',
        'command_pattern', 'risk_ceiling', 'enabled',
      ],
    };
    for (const [indexName, expected] of Object.entries(expectedIndexes)) {
      const indexColumns = this.database.pragma(`index_info(${indexName})`) as Array<{ name: string }>;
      if (indexColumns.map((column) => column.name).join('\0') !== expected.join('\0')) {
        throw new Error(`Existing ${indexName} schema is incompatible with version 5.`);
      }
    }

    const probeSuffix = `${Date.now()}:${process.pid}`;
    const projectId = `__permission_rule_schema_probe_project__:${probeSuffix}`;
    const projectPath = `__permission_rule_schema_probe_path__:${probeSuffix}`;
    const insert = this.database.prepare(`
      INSERT INTO project_permission_rules
        (id, project_id, scope, canonical_project_path, tool_name, capability,
         command_pattern, risk_ceiling, enabled, source, created_at, updated_at,
         last_hit_at, hit_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const base: Record<string, unknown> = {
      id: `__permission_rule_schema_probe_rule__:${probeSuffix}`,
      project_id: projectId,
      scope: 'project',
      canonical_project_path: projectPath,
      tool_name: 'bash',
      capability: 'shell.test',
      command_pattern: null,
      risk_ceiling: 'medium',
      enabled: 1,
      source: 'user',
      created_at: 1,
      updated_at: 1,
      last_hit_at: null,
      hit_count: 0,
    };
    const values = (row: Record<string, unknown>): unknown[] => [
      row.id,
      row.project_id,
      row.scope,
      row.canonical_project_path,
      row.tool_name,
      row.capability,
      row.command_pattern,
      row.risk_ceiling,
      row.enabled,
      row.source,
      row.created_at,
      row.updated_at,
      row.last_hit_at,
      row.hit_count,
    ];
    const rejected = (overrides: Record<string, unknown>): boolean => {
      const row = {
        ...base,
        id: `${base.id}:${String(overrides.id ?? Object.keys(overrides)[0])}`,
        ...overrides,
      };
      try {
        insert.run(...values(row));
        this.database.prepare('DELETE FROM project_permission_rules WHERE id = ?').run(row.id);
        return false;
      } catch {
        return true;
      }
    };

    this.database.prepare(`
      INSERT INTO projects (id, name, path, created_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(projectId, 'Permission rule schema probe', projectPath, nowIso(), nowIso());
    try {
      insert.run(...values(base));
      this.database.prepare('DELETE FROM project_permission_rules WHERE id = ?').run(base.id);

      const unsafeRows: Array<Record<string, unknown>> = [
        { scope: 'task' },
        { risk_ceiling: 'high' },
        { capability: 'shell.destructive' },
        { capability: 'shell.unknown' },
        { capability: 'shell.package_install' },
        { tool_name: 'read', capability: 'shell.test' },
        { enabled: 2 },
        { source: 'renderer' },
        { hit_count: -1 },
        { hit_count: 1, last_hit_at: null },
      ];
      if (unsafeRows.some((row) => !rejected(row))) {
        throw new Error('Existing project_permission_rules safety checks are incompatible with version 5.');
      }
      if (!rejected({ id: `${base.id}:foreign-key`, project_id: `${projectId}:missing` })) {
        throw new Error('Existing project_permission_rules foreign-key enforcement is incompatible with version 5.');
      }
    } finally {
      this.database.prepare('DELETE FROM project_permission_rules WHERE project_id = ?').run(projectId);
      this.database.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    }
  }

  private migrateToVersion6(): void {
    this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS model_providers (
          id TEXT PRIMARY KEY CHECK (
            length(trim(id)) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0
          ),
          name TEXT NOT NULL CHECK (
            length(trim(name)) BETWEEN 1 AND 128 AND instr(name, char(0)) = 0
          ),
          type TEXT NOT NULL CHECK (
            type IN ('anthropic', 'anthropic-compatible', 'openai-compatible', 'custom')
          ),
          base_url TEXT CHECK (
            base_url IS NULL OR (
              length(trim(base_url)) BETWEEN 1 AND 2048 AND instr(base_url, char(0)) = 0
            )
          ),
          api_format TEXT NOT NULL CHECK (
            api_format IN ('anthropic-messages', 'openai-chat-completions')
          ),
          runtime_type TEXT NOT NULL CHECK (runtime_type IN ('claude-code', 'none')),
          credential_ref TEXT CHECK (
            credential_ref IS NULL OR (
              typeof(credential_ref) = 'text'
              AND length(credential_ref) = 54
              AND substr(credential_ref, 1, 18) = 'safe-storage://v1/'
              AND substr(credential_ref, 27, 1) = '-'
              AND substr(credential_ref, 32, 1) = '-'
              AND substr(credential_ref, 37, 1) = '-'
              AND substr(credential_ref, 42, 1) = '-'
              AND replace(substr(credential_ref, 19), '-', '') NOT GLOB '*[^0-9a-f]*'
            )
          ),
          default_model_id TEXT CHECK (
            default_model_id IS NULL OR (
              length(trim(default_model_id)) BETWEEN 1 AND 512
              AND instr(default_model_id, char(0)) = 0
            )
          ),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
          supports_claude_code INTEGER NOT NULL DEFAULT 0
            CHECK (supports_claude_code IN (0, 1)),
          supports_agent_workflow INTEGER NOT NULL DEFAULT 0
            CHECK (supports_agent_workflow IN (0, 1)),
          supports_tools INTEGER NOT NULL DEFAULT 0 CHECK (supports_tools IN (0, 1)),
          supports_mcp INTEGER NOT NULL DEFAULT 0 CHECK (supports_mcp IN (0, 1)),
          supports_streaming INTEGER NOT NULL DEFAULT 0 CHECK (supports_streaming IN (0, 1)),
          supports_vision INTEGER NOT NULL DEFAULT 0 CHECK (supports_vision IN (0, 1)),
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
          health_state TEXT NOT NULL DEFAULT 'not_configured' CHECK (
            health_state IN ('not_configured', 'configured', 'connected', 'error')
          ),
          last_tested_at INTEGER CHECK (
            last_tested_at IS NULL OR (
              typeof(last_tested_at) = 'integer' AND last_tested_at >= 0
            )
          ),
          last_error_type TEXT CHECK (
            last_error_type IS NULL OR last_error_type IN (
              'invalid_key', 'forbidden', 'not_found', 'rate_limited',
              'timeout', 'network', 'invalid_response', 'unknown'
            )
          ),
          latency_ms INTEGER CHECK (
            latency_ms IS NULL OR (typeof(latency_ms) = 'integer' AND latency_ms >= 0)
          ),
          created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          updated_at INTEGER NOT NULL CHECK (
            typeof(updated_at) = 'integer' AND updated_at >= created_at
          ),
          CHECK (
            (type IN ('anthropic', 'anthropic-compatible')
              AND api_format = 'anthropic-messages' AND runtime_type = 'claude-code')
            OR (type = 'openai-compatible'
              AND api_format = 'openai-chat-completions' AND runtime_type = 'none')
            OR (type = 'custom' AND (
              (api_format = 'anthropic-messages' AND runtime_type = 'claude-code')
              OR (api_format = 'openai-chat-completions' AND runtime_type = 'none')
            ))
          ),
          CHECK (runtime_type = 'claude-code' OR supports_claude_code = 0),
          CHECK (supports_agent_workflow <= supports_claude_code),
          CHECK (supports_mcp <= supports_tools),
          CHECK (api_format = 'anthropic-messages' OR supports_mcp = 0),
          FOREIGN KEY (id, default_model_id)
            REFERENCES model_provider_models(provider_id, model_id)
            DEFERRABLE INITIALLY DEFERRED
        );

        CREATE UNIQUE INDEX IF NOT EXISTS model_providers_one_enabled_default_idx
          ON model_providers(is_default)
          WHERE enabled = 1 AND is_default = 1;
        CREATE INDEX IF NOT EXISTS model_providers_list_idx
          ON model_providers(enabled DESC, updated_at DESC, id DESC);

        CREATE TABLE IF NOT EXISTS model_provider_models (
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL CHECK (
            length(trim(model_id)) BETWEEN 1 AND 512 AND instr(model_id, char(0)) = 0
          ),
          display_name TEXT CHECK (
            display_name IS NULL OR (
              length(trim(display_name)) BETWEEN 1 AND 512
              AND instr(display_name, char(0)) = 0
            )
          ),
          source TEXT NOT NULL CHECK (source IN ('manual', 'discovered')),
          created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          updated_at INTEGER NOT NULL CHECK (
            typeof(updated_at) = 'integer' AND updated_at >= created_at
          ),
          PRIMARY KEY (provider_id, model_id),
          FOREIGN KEY (provider_id) REFERENCES model_providers(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS model_provider_models_provider_source_idx
          ON model_provider_models(provider_id, source, updated_at DESC, model_id);

        CREATE TABLE IF NOT EXISTS agent_model_policy (
          agent_type TEXT PRIMARY KEY CHECK (
            agent_type IN ('planner', 'coder', 'tester', 'reviewer', 'fixer')
          ),
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          quality TEXT CHECK (quality IS NULL OR quality IN ('low', 'medium', 'high')),
          speed TEXT CHECK (speed IS NULL OR speed IN ('low', 'medium', 'high')),
          cost TEXT CHECK (cost IS NULL OR cost IN ('low', 'medium', 'high')),
          created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          updated_at INTEGER NOT NULL CHECK (
            typeof(updated_at) = 'integer' AND updated_at >= created_at
          ),
          FOREIGN KEY (provider_id, model_id)
            REFERENCES model_provider_models(provider_id, model_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS agent_model_policy_provider_model_idx
          ON agent_model_policy(provider_id, model_id);

        CREATE TABLE IF NOT EXISTS project_model_policy (
          project_id TEXT NOT NULL,
          agent_type TEXT NOT NULL CHECK (
            agent_type IN ('default', 'planner', 'coder', 'tester', 'reviewer', 'fixer')
          ),
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          updated_at INTEGER NOT NULL CHECK (
            typeof(updated_at) = 'integer' AND updated_at >= created_at
          ),
          PRIMARY KEY (project_id, agent_type),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (provider_id, model_id)
            REFERENCES model_provider_models(provider_id, model_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS project_model_policy_provider_model_idx
          ON project_model_policy(provider_id, model_id);

        CREATE TABLE IF NOT EXISTS task_model_overrides (
          task_id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          updated_at INTEGER NOT NULL CHECK (
            typeof(updated_at) = 'integer' AND updated_at >= created_at
          ),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (provider_id, model_id)
            REFERENCES model_provider_models(provider_id, model_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS task_model_overrides_provider_model_idx
          ON task_model_overrides(provider_id, model_id);

        CREATE TABLE IF NOT EXISTS credential_cleanup_jobs (
          id TEXT PRIMARY KEY CHECK (
            length(trim(id)) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0
          ),
          provider_id TEXT CHECK (
            provider_id IS NULL OR (
              length(trim(provider_id)) BETWEEN 1 AND 256 AND instr(provider_id, char(0)) = 0
            )
          ),
          credential_ref TEXT NOT NULL UNIQUE CHECK (
            typeof(credential_ref) = 'text'
            AND length(credential_ref) = 54
            AND substr(credential_ref, 1, 18) = 'safe-storage://v1/'
            AND substr(credential_ref, 27, 1) = '-'
            AND substr(credential_ref, 32, 1) = '-'
            AND substr(credential_ref, 37, 1) = '-'
            AND substr(credential_ref, 42, 1) = '-'
            AND replace(substr(credential_ref, 19), '-', '') NOT GLOB '*[^0-9a-f]*'
          ),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (
            typeof(attempts) = 'integer' AND attempts >= 0
          ),
          next_attempt_at INTEGER CHECK (
            next_attempt_at IS NULL OR (
              typeof(next_attempt_at) = 'integer' AND next_attempt_at >= 0
            )
          ),
          last_attempt_at INTEGER CHECK (
            last_attempt_at IS NULL OR (
              typeof(last_attempt_at) = 'integer' AND last_attempt_at >= 0
            )
          ),
          last_error_type TEXT CHECK (
            last_error_type IS NULL OR last_error_type IN (
              'not_found', 'io', 'permission', 'invalid_ref', 'unknown'
            )
          ),
          created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          updated_at INTEGER NOT NULL CHECK (
            typeof(updated_at) = 'integer' AND updated_at >= created_at
          )
        );
        CREATE INDEX IF NOT EXISTS credential_cleanup_jobs_due_idx
          ON credential_cleanup_jobs(next_attempt_at, attempts, created_at, id);
      `);
      this.validateVersion6ModelProviderSchema();
      this.database.pragma('user_version = 6');
    })();
  }

  private validateVersion6ModelProviderSchema(): void {
    const expectedColumns: Record<string, string[]> = {
      model_providers: [
        'id', 'name', 'type', 'base_url', 'api_format', 'runtime_type',
        'credential_ref', 'default_model_id', 'enabled', 'is_default',
        'supports_claude_code', 'supports_agent_workflow', 'supports_tools',
        'supports_mcp', 'supports_streaming', 'supports_vision', 'metadata_json',
        'health_state', 'last_tested_at', 'last_error_type', 'latency_ms',
        'created_at', 'updated_at',
      ],
      model_provider_models: [
        'provider_id', 'model_id', 'display_name', 'source', 'created_at', 'updated_at',
      ],
      agent_model_policy: [
        'agent_type', 'provider_id', 'model_id', 'quality', 'speed', 'cost',
        'created_at', 'updated_at',
      ],
      project_model_policy: [
        'project_id', 'agent_type', 'provider_id', 'model_id', 'created_at', 'updated_at',
      ],
      task_model_overrides: [
        'task_id', 'provider_id', 'model_id', 'created_at', 'updated_at',
      ],
      credential_cleanup_jobs: [
        'id', 'provider_id', 'credential_ref', 'attempts', 'next_attempt_at',
        'last_attempt_at', 'last_error_type', 'created_at', 'updated_at',
      ],
    };
    for (const [table, expected] of Object.entries(expectedColumns)) {
      const columns = this.database.pragma(`table_info(${table})`) as Array<{ name: string }>;
      const actual = columns.map(({ name }) => name);
      const compatibleVersion7Policy = table === 'agent_model_policy'
        ? [
            'agent_type', 'provider_id', 'model_id', 'tier', 'quality', 'speed', 'cost',
            'created_at', 'updated_at',
          ]
        : table === 'project_model_policy'
          ? [
              'project_id', 'agent_type', 'provider_id', 'model_id', 'tier', 'created_at',
              'updated_at',
            ]
          : null;
      if (
        actual.join('\0') !== expected.join('\0')
        && actual.join('\0') !== compatibleVersion7Policy?.join('\0')
      ) {
        throw new Error(`Existing ${table} schema is incompatible with version 6.`);
      }
    }
  }

  private migrateToVersion7(): void {
    this.database.transaction(() => {
      const agentPolicyColumns = this.database.pragma('table_info(agent_model_policy)') as Array<{
        name: string;
      }>;
      const projectPolicyColumns = this.database.pragma('table_info(project_model_policy)') as Array<{
        name: string;
      }>;
      const policyTablesAlreadyVersion7 = agentPolicyColumns.some(({ name }) => name === 'tier')
        || projectPolicyColumns.some(({ name }) => name === 'tier');
      if (policyTablesAlreadyVersion7) {
        this.validateVersion7ModelTierSchema();
        this.database.pragma('user_version = 7');
        return;
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS model_tier_bindings (
          tier TEXT NOT NULL PRIMARY KEY CHECK (tier IN ('high_quality', 'balanced', 'fast')),
          provider_id TEXT,
          model_id TEXT,
          display_name TEXT,
          quality TEXT CHECK (quality IS NULL OR quality IN ('low', 'medium', 'high')),
          speed TEXT CHECK (speed IS NULL OR speed IN ('low', 'medium', 'high')),
          cost TEXT CHECK (cost IS NULL OR cost IN ('low', 'medium', 'high')),
          updated_at INTEGER NOT NULL,
          CHECK ((provider_id IS NULL) = (model_id IS NULL)),
          CHECK (provider_id IS NULL OR (
            length(provider_id) BETWEEN 1 AND 192
            AND provider_id = trim(provider_id)
            AND instr(provider_id, char(0)) = 0
          )),
          CHECK (model_id IS NULL OR (
            length(model_id) BETWEEN 1 AND 256
            AND model_id = trim(model_id)
            AND instr(model_id, char(0)) = 0
          )),
          CHECK (display_name IS NULL OR (
            length(display_name) BETWEEN 1 AND 80
            AND display_name = trim(display_name)
            AND instr(display_name, char(0)) = 0
          )),
          CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
        );

        CREATE TABLE IF NOT EXISTS project_model_tier_bindings (
          project_id TEXT NOT NULL,
          tier TEXT NOT NULL CHECK (tier IN ('high_quality', 'balanced', 'fast')),
          provider_id TEXT,
          model_id TEXT,
          display_name TEXT,
          quality TEXT CHECK (quality IS NULL OR quality IN ('low', 'medium', 'high')),
          speed TEXT CHECK (speed IS NULL OR speed IN ('low', 'medium', 'high')),
          cost TEXT CHECK (cost IS NULL OR cost IN ('low', 'medium', 'high')),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (project_id, tier),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          CHECK ((provider_id IS NULL) = (model_id IS NULL)),
          CHECK (provider_id IS NULL OR (
            length(provider_id) BETWEEN 1 AND 192
            AND provider_id = trim(provider_id)
            AND instr(provider_id, char(0)) = 0
          )),
          CHECK (model_id IS NULL OR (
            length(model_id) BETWEEN 1 AND 256
            AND model_id = trim(model_id)
            AND instr(model_id, char(0)) = 0
          )),
          CHECK (display_name IS NULL OR (
            length(display_name) BETWEEN 1 AND 80
            AND display_name = trim(display_name)
            AND instr(display_name, char(0)) = 0
          )),
          CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
        );

        ALTER TABLE agent_model_policy RENAME TO agent_model_policy_v6;
        CREATE TABLE agent_model_policy (
          agent_type TEXT NOT NULL PRIMARY KEY CHECK (
            agent_type IN ('planner', 'coder', 'tester', 'reviewer', 'fixer')
          ),
          provider_id TEXT,
          model_id TEXT,
          tier TEXT CHECK (tier IS NULL OR tier IN ('high_quality', 'balanced', 'fast')),
          quality TEXT CHECK (quality IS NULL OR quality IN ('low', 'medium', 'high')),
          speed TEXT CHECK (speed IS NULL OR speed IN ('low', 'medium', 'high')),
          cost TEXT CHECK (cost IS NULL OR cost IN ('low', 'medium', 'high')),
          created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          updated_at INTEGER NOT NULL CHECK (
            typeof(updated_at) = 'integer' AND updated_at >= created_at
          ),
          CHECK (
            (tier IS NOT NULL AND provider_id IS NULL AND model_id IS NULL)
            OR
            (tier IS NULL AND provider_id IS NOT NULL AND model_id IS NOT NULL)
          ),
          FOREIGN KEY (provider_id, model_id)
            REFERENCES model_provider_models(provider_id, model_id) ON DELETE CASCADE
        );
        INSERT INTO agent_model_policy (
          agent_type, provider_id, model_id, tier, quality, speed, cost, created_at, updated_at
        )
        SELECT agent_type, provider_id, model_id, NULL, quality, speed, cost, created_at, updated_at
        FROM agent_model_policy_v6;
        DROP TABLE agent_model_policy_v6;
        CREATE INDEX agent_model_policy_provider_model_idx
          ON agent_model_policy(provider_id, model_id);

        ALTER TABLE project_model_policy RENAME TO project_model_policy_v6;
        CREATE TABLE project_model_policy (
          project_id TEXT NOT NULL,
          agent_type TEXT NOT NULL CHECK (
            agent_type IN ('default', 'planner', 'coder', 'tester', 'reviewer', 'fixer')
          ),
          provider_id TEXT,
          model_id TEXT,
          tier TEXT CHECK (tier IS NULL OR tier IN ('high_quality', 'balanced', 'fast')),
          created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          updated_at INTEGER NOT NULL CHECK (
            typeof(updated_at) = 'integer' AND updated_at >= created_at
          ),
          PRIMARY KEY (project_id, agent_type),
          CHECK (
            (tier IS NOT NULL AND provider_id IS NULL AND model_id IS NULL)
            OR
            (tier IS NULL AND provider_id IS NOT NULL AND model_id IS NOT NULL)
          ),
          CHECK (agent_type <> 'default' OR tier IS NULL),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (provider_id, model_id)
            REFERENCES model_provider_models(provider_id, model_id) ON DELETE CASCADE
        );
        INSERT INTO project_model_policy (
          project_id, agent_type, provider_id, model_id, tier, created_at, updated_at
        )
        SELECT project_id, agent_type, provider_id, model_id, NULL, created_at, updated_at
        FROM project_model_policy_v6;
        DROP TABLE project_model_policy_v6;
        CREATE INDEX project_model_policy_provider_model_idx
          ON project_model_policy(provider_id, model_id);
      `);
      this.validateVersion7ModelTierSchema();
      this.database.pragma('user_version = 7');
    })();
  }

  private validateVersion7ModelTierSchema(): void {
    type TableColumn = {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    };
    const expectedColumns: Readonly<Record<string, readonly TableColumn[]>> = {
      model_tier_bindings: [
        { name: 'tier', type: 'TEXT', notnull: 1, pk: 1 },
        { name: 'provider_id', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'model_id', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'display_name', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'quality', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'speed', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'cost', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
      ],
      project_model_tier_bindings: [
        { name: 'project_id', type: 'TEXT', notnull: 1, pk: 1 },
        { name: 'tier', type: 'TEXT', notnull: 1, pk: 2 },
        { name: 'provider_id', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'model_id', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'display_name', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'quality', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'speed', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'cost', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
      ],
      agent_model_policy: [
        { name: 'agent_type', type: 'TEXT', notnull: 1, pk: 1 },
        { name: 'provider_id', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'model_id', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'tier', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'quality', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'speed', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'cost', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
      ],
      project_model_policy: [
        { name: 'project_id', type: 'TEXT', notnull: 1, pk: 1 },
        { name: 'agent_type', type: 'TEXT', notnull: 1, pk: 2 },
        { name: 'provider_id', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'model_id', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'tier', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
      ],
    };
    for (const [table, expected] of Object.entries(expectedColumns)) {
      const columns = this.database.pragma(`table_info(${table})`) as TableColumn[];
      const actual = columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Existing ${table} schema is incompatible with version 7.`);
      }
    }

    const expectedPrimaryKeys: Readonly<Record<string, readonly string[]>> = {
      model_tier_bindings: ['tier'],
      project_model_tier_bindings: ['project_id', 'tier'],
      agent_model_policy: ['agent_type'],
      project_model_policy: ['project_id', 'agent_type'],
    };
    for (const [table, expected] of Object.entries(expectedPrimaryKeys)) {
      const indexes = this.database.pragma(`index_list(${table})`) as Array<{
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>;
      const primaryIndexes = indexes.filter(({ origin }) => origin === 'pk');
      if (
        primaryIndexes.length !== 1
        || primaryIndexes[0].unique !== 1
        || primaryIndexes[0].partial !== 0
      ) {
        throw new Error(`Existing ${table} primary key is incompatible with version 7.`);
      }
      const columns = this.database.pragma(
        `index_info(${primaryIndexes[0].name})`,
      ) as Array<{ name: string }>;
      if (columns.map(({ name }) => name).join('\0') !== expected.join('\0')) {
        throw new Error(`Existing ${table} primary key columns are incompatible with version 7.`);
      }
      const unexpectedUnique = indexes.filter(({ unique, origin }) => unique === 1 && origin !== 'pk');
      if (unexpectedUnique.length > 0) {
        throw new Error(`Existing ${table} unique indexes are incompatible with version 7.`);
      }
    }

    const expectedIndexes: Readonly<Record<string, {
      table: string;
      columns: readonly string[];
    }>> = {
      agent_model_policy_provider_model_idx: {
        table: 'agent_model_policy',
        columns: ['provider_id', 'model_id'],
      },
      project_model_policy_provider_model_idx: {
        table: 'project_model_policy',
        columns: ['provider_id', 'model_id'],
      },
    };
    for (const [index, expected] of Object.entries(expectedIndexes)) {
      const metadata = (this.database.pragma(`index_list(${expected.table})`) as Array<{
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>).find(({ name }) => name === index);
      if (
        !metadata
        || metadata.unique !== 0
        || metadata.origin !== 'c'
        || metadata.partial !== 0
      ) {
        throw new Error(`Existing ${index} index properties are incompatible with version 7.`);
      }
      const columns = this.database.pragma(`index_info(${index})`) as Array<{ name: string }>;
      if (columns.map(({ name }) => name).join('\0') !== expected.columns.join('\0')) {
        throw new Error(`Existing ${index} index is incompatible with version 7.`);
      }
    }
    const expectedExplicitIndexes: Readonly<Record<string, readonly string[]>> = {
      model_tier_bindings: [],
      project_model_tier_bindings: [],
      agent_model_policy: ['agent_model_policy_provider_model_idx'],
      project_model_policy: ['project_model_policy_provider_model_idx'],
    };
    for (const [table, expected] of Object.entries(expectedExplicitIndexes)) {
      const indexes = this.database.pragma(`index_list(${table})`) as Array<{
        name: string;
        origin: string;
      }>;
      const actual = indexes
        .filter(({ origin }) => origin === 'c')
        .map(({ name }) => name)
        .sort();
      if (actual.join('\0') !== [...expected].sort().join('\0')) {
        throw new Error(`Existing ${table} indexes are incompatible with version 7.`);
      }
    }

    type ForeignKeyRow = {
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    };
    const foreignKeySignature = (row: ForeignKeyRow): string => [
      row.id, row.seq, row.table, row.from, row.to, row.on_update, row.on_delete, row.match,
    ].join('|');
    const expectedForeignKeys: Readonly<Record<string, readonly string[]>> = {
      model_tier_bindings: [],
      project_model_tier_bindings: ['0|0|projects|project_id|id|NO ACTION|CASCADE|NONE'],
      agent_model_policy: [
        '0|0|model_provider_models|provider_id|provider_id|NO ACTION|CASCADE|NONE',
        '0|1|model_provider_models|model_id|model_id|NO ACTION|CASCADE|NONE',
      ],
      project_model_policy: [
        '0|0|model_provider_models|provider_id|provider_id|NO ACTION|CASCADE|NONE',
        '0|1|model_provider_models|model_id|model_id|NO ACTION|CASCADE|NONE',
        '1|0|projects|project_id|id|NO ACTION|CASCADE|NONE',
      ],
    };
    for (const [table, expected] of Object.entries(expectedForeignKeys)) {
      const actual = (this.database.pragma(`foreign_key_list(${table})`) as ForeignKeyRow[])
        .map(foreignKeySignature);
      if (actual.join('\0') !== expected.join('\0')) {
        throw new Error(`Existing ${table} foreign keys are incompatible with version 7.`);
      }
    }

    const requiredChecks: Readonly<Record<string, readonly string[]>> = {
      model_tier_bindings: [
        "tier in ('high_quality', 'balanced', 'fast')",
        '(provider_id is null) = (model_id is null)',
        'length(provider_id) between 1 and 192',
        'provider_id = trim(provider_id)',
        'instr(provider_id, char(0)) = 0',
        'length(model_id) between 1 and 256',
        'model_id = trim(model_id)',
        'instr(model_id, char(0)) = 0',
        'length(display_name) between 1 and 80',
        'display_name = trim(display_name)',
        'instr(display_name, char(0)) = 0',
        "quality is null or quality in ('low', 'medium', 'high')",
        "speed is null or speed in ('low', 'medium', 'high')",
        "cost is null or cost in ('low', 'medium', 'high')",
        "typeof(updated_at) = 'integer' and updated_at >= 0",
      ],
      project_model_tier_bindings: [
        "tier in ('high_quality', 'balanced', 'fast')",
        '(provider_id is null) = (model_id is null)',
        'length(provider_id) between 1 and 192',
        'provider_id = trim(provider_id)',
        'instr(provider_id, char(0)) = 0',
        'length(model_id) between 1 and 256',
        'model_id = trim(model_id)',
        'instr(model_id, char(0)) = 0',
        'length(display_name) between 1 and 80',
        'display_name = trim(display_name)',
        'instr(display_name, char(0)) = 0',
        "quality is null or quality in ('low', 'medium', 'high')",
        "speed is null or speed in ('low', 'medium', 'high')",
        "cost is null or cost in ('low', 'medium', 'high')",
        "typeof(updated_at) = 'integer' and updated_at >= 0",
      ],
      agent_model_policy: [
        "agent_type in ('planner', 'coder', 'tester', 'reviewer', 'fixer')",
        "tier is null or tier in ('high_quality', 'balanced', 'fast')",
        "quality is null or quality in ('low', 'medium', 'high')",
        "speed is null or speed in ('low', 'medium', 'high')",
        "cost is null or cost in ('low', 'medium', 'high')",
        "typeof(created_at) = 'integer' and created_at >= 0",
        "typeof(updated_at) = 'integer' and updated_at >= created_at",
        '(tier is not null and provider_id is null and model_id is null)',
        '(tier is null and provider_id is not null and model_id is not null)',
      ],
      project_model_policy: [
        "agent_type in ('default', 'planner', 'coder', 'tester', 'reviewer', 'fixer')",
        "tier is null or tier in ('high_quality', 'balanced', 'fast')",
        "typeof(created_at) = 'integer' and created_at >= 0",
        "typeof(updated_at) = 'integer' and updated_at >= created_at",
        '(tier is not null and provider_id is null and model_id is null)',
        '(tier is null and provider_id is not null and model_id is not null)',
        "agent_type <> 'default' or tier is null",
      ],
    };
    for (const [table, checks] of Object.entries(requiredChecks)) {
      const schema = this.database.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table) as { sql: string | null } | undefined;
      const normalized = (schema?.sql ?? '').replace(/\s+/g, ' ').toLowerCase();
      if (checks.some((check) => !normalized.includes(check))) {
        throw new Error(`Existing ${table} checks are incompatible with version 7.`);
      }
    }
    this.probeVersion7ModelTierConstraints();
  }

  private probeVersion7ModelTierConstraints(): void {
    const savepoint = 'validate_version_7_model_tier_constraints';
    this.database.exec(`SAVEPOINT ${savepoint}`);
    try {
      this.database.exec(`
        DELETE FROM project_model_policy;
        DELETE FROM agent_model_policy;
        DELETE FROM project_model_tier_bindings;
        DELETE FROM model_tier_bindings;
      `);

      const suffix = `${Date.now()}:${process.pid}`;
      const projectId = `__v7_tier_probe_project__:${suffix}`;
      const providerId = `__v7_tier_probe_provider__:${suffix}`;
      const modelId = `__v7_tier_probe_model__:${suffix}`;
      this.database.prepare(`
        INSERT INTO projects (id, name, path, created_at, last_opened_at)
        VALUES (?, 'v7 tier schema probe', ?, '1970-01-01T00:00:00.000Z',
          '1970-01-01T00:00:00.000Z')
      `).run(projectId, `__v7_tier_probe_path__:${suffix}`);
      this.database.prepare(`
        INSERT INTO model_providers (
          id, name, type, base_url, api_format, runtime_type, created_at, updated_at
        ) VALUES (?, 'v7 tier schema probe', 'anthropic', NULL,
          'anthropic-messages', 'claude-code', 1, 1)
      `).run(providerId);
      this.database.prepare(`
        INSERT INTO model_provider_models (
          provider_id, model_id, display_name, source, created_at, updated_at
        ) VALUES (?, ?, NULL, 'manual', 1, 1)
      `).run(providerId, modelId);

      const accepted = (label: string, work: () => void): void => {
        try {
          work();
        } catch {
          throw new Error(`Existing version 7 schema rejected valid ${label}.`);
        }
      };
      const rejected = (label: string, work: () => void): void => {
        try {
          work();
        } catch {
          return;
        }
        throw new Error(`Existing version 7 schema accepted invalid ${label}.`);
      };

      const probeTierTable = (table: 'model_tier_bindings' | 'project_model_tier_bindings') => {
        const projectColumn = table === 'project_model_tier_bindings' ? 'project_id, ' : '';
        const projectValue = table === 'project_model_tier_bindings' ? '@project_id, ' : '';
        const insert = this.database.prepare(`
          INSERT INTO ${table} (
            ${projectColumn}tier, provider_id, model_id, display_name,
            quality, speed, cost, updated_at
          ) VALUES (
            ${projectValue}@tier, @provider_id, @model_id, @display_name,
            @quality, @speed, @cost, @updated_at
          )
        `);
        const base: Record<string, unknown> = {
          project_id: projectId,
          tier: 'fast',
          provider_id: null,
          model_id: null,
          display_name: 'Fast',
          quality: 'medium',
          speed: 'high',
          cost: 'low',
          updated_at: 1,
        };
        accepted(`${table} unbound row`, () => insert.run({ ...base, tier: 'balanced' }));
        accepted(`${table} bound row`, () => insert.run({
          ...base,
          tier: 'high_quality',
          provider_id: providerId,
          model_id: modelId,
        }));
        const invalidRows: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
          ['NULL tier', { tier: null }],
          ['tier enum', { tier: 'premium' }],
          ['provider-only pair', { provider_id: providerId }],
          ['model-only pair', { model_id: modelId }],
          ['blank provider ID', { provider_id: '', model_id: modelId }],
          ['untrimmed provider ID', { provider_id: ' provider', model_id: modelId }],
          ['NUL provider ID', { provider_id: 'bad\0provider', model_id: modelId }],
          ['long provider ID', { provider_id: 'p'.repeat(193), model_id: modelId }],
          ['blank model ID', { provider_id: providerId, model_id: '' }],
          ['untrimmed model ID', { provider_id: providerId, model_id: ' model' }],
          ['NUL model ID', { provider_id: providerId, model_id: 'bad\0model' }],
          ['long model ID', { provider_id: providerId, model_id: 'm'.repeat(257) }],
          ['blank display name', { display_name: '' }],
          ['NUL display name', { display_name: 'bad\0display' }],
          ['long display name', { display_name: 'd'.repeat(81) }],
          ['quality enum', { quality: 'best' }],
          ['speed enum', { speed: 'best' }],
          ['cost enum', { cost: 'best' }],
          ['negative timestamp', { updated_at: -1 }],
          ['fractional timestamp', { updated_at: 1.5 }],
        ];
        for (const [label, overrides] of invalidRows) {
          rejected(`${table} ${label}`, () => insert.run({ ...base, ...overrides }));
        }
      };
      probeTierTable('model_tier_bindings');
      probeTierTable('project_model_tier_bindings');

      const insertAgentPolicy = this.database.prepare(`
        INSERT INTO agent_model_policy (
          agent_type, provider_id, model_id, tier, quality, speed, cost, created_at, updated_at
        ) VALUES (
          @agent_type, @provider_id, @model_id, @tier,
          @quality, @speed, @cost, @created_at, @updated_at
        )
      `);
      const agentBase: Record<string, unknown> = {
        agent_type: 'tester',
        provider_id: null,
        model_id: null,
        tier: 'fast',
        quality: 'medium',
        speed: 'medium',
        cost: 'medium',
        created_at: 1,
        updated_at: 1,
      };
      accepted('global tier policy', () => insertAgentPolicy.run({
        ...agentBase, agent_type: 'planner', tier: 'balanced',
      }));
      accepted('global direct policy', () => insertAgentPolicy.run({
        ...agentBase,
        agent_type: 'coder',
        provider_id: providerId,
        model_id: modelId,
        tier: null,
      }));
      const invalidAgentPolicies: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ['NULL role', { agent_type: null }],
        ['role enum', { agent_type: 'architect' }],
        ['tier enum', { tier: 'premium' }],
        ['missing reference', { tier: null }],
        ['both reference forms', { provider_id: providerId, model_id: modelId }],
        ['provider-only direct reference', { provider_id: providerId, tier: null }],
        ['model-only direct reference', { model_id: modelId, tier: null }],
        ['quality enum', { quality: 'best' }],
        ['speed enum', { speed: 'best' }],
        ['cost enum', { cost: 'best' }],
        ['negative created timestamp', { created_at: -1 }],
        ['fractional created timestamp', { created_at: 1.5 }],
        ['negative updated timestamp', { updated_at: -1 }],
        ['fractional updated timestamp', { updated_at: 1.5 }],
        ['updated timestamp before creation', { created_at: 2, updated_at: 1 }],
      ];
      for (const [label, overrides] of invalidAgentPolicies) {
        rejected(`global policy ${label}`, () => insertAgentPolicy.run({
          ...agentBase, ...overrides,
        }));
      }

      const insertProjectPolicy = this.database.prepare(`
        INSERT INTO project_model_policy (
          project_id, agent_type, provider_id, model_id, tier, created_at, updated_at
        ) VALUES (
          @project_id, @agent_type, @provider_id, @model_id, @tier, @created_at, @updated_at
        )
      `);
      const projectPolicyBase: Record<string, unknown> = {
        project_id: projectId,
        agent_type: 'tester',
        provider_id: null,
        model_id: null,
        tier: 'fast',
        created_at: 1,
        updated_at: 1,
      };
      accepted('project tier policy', () => insertProjectPolicy.run({
        ...projectPolicyBase, agent_type: 'planner', tier: 'balanced',
      }));
      accepted('project direct default policy', () => insertProjectPolicy.run({
        ...projectPolicyBase,
        agent_type: 'default',
        provider_id: providerId,
        model_id: modelId,
        tier: null,
      }));
      this.database.prepare(`
        DELETE FROM project_model_policy WHERE project_id = ? AND agent_type = 'default'
      `).run(projectId);
      const invalidProjectPolicies: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ['NULL role', { agent_type: null }],
        ['role enum', { agent_type: 'architect' }],
        ['tier enum', { tier: 'premium' }],
        ['missing reference', { tier: null }],
        ['both reference forms', { provider_id: providerId, model_id: modelId }],
        ['provider-only direct reference', { provider_id: providerId, tier: null }],
        ['model-only direct reference', { model_id: modelId, tier: null }],
        ['tier project default', { agent_type: 'default' }],
        ['negative created timestamp', { created_at: -1 }],
        ['fractional created timestamp', { created_at: 1.5 }],
        ['negative updated timestamp', { updated_at: -1 }],
        ['fractional updated timestamp', { updated_at: 1.5 }],
        ['updated timestamp before creation', { created_at: 2, updated_at: 1 }],
      ];
      for (const [label, overrides] of invalidProjectPolicies) {
        rejected(`project policy ${label}`, () => insertProjectPolicy.run({
          ...projectPolicyBase, ...overrides,
        }));
      }
    } finally {
      this.database.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    }
  }

  private importLegacyData(data: LegacyDBData): void {
    const migrate = this.database.transaction(() => {
      for (const project of Object.values(data.projects ?? {})) {
        this.createProject(project.id, project.name, project.path, {
          createdAt: project.created_at,
          lastOpenedAt: project.last_opened_at,
        });
      }
      for (const session of Object.values(data.sessions ?? {})) {
        this.insertSessionRow({
          id: session.id,
          project_id: session.project_id,
          claude_session_id: session.claude_session_id ?? null,
          title: session.title,
          status: session.status,
          model: session.model ?? null,
          permission_mode: session.permission_mode ?? null,
          created_at: session.created_at,
          updated_at: session.updated_at,
          completed_at: session.completed_at ?? null,
          archived: session.archived ?? false,
          tags: session.tags ?? [],
          title_source: session.title_source ?? 'default',
        });
      }
      for (const message of Object.values(data.messages ?? {})) {
        this.database.prepare(`
          INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(message.id, message.session_id, message.role, message.content, message.created_at);
      }
      for (const event of Object.values(data.events ?? {})) {
        this.database.prepare(`
          INSERT OR REPLACE INTO events (id, session_id, event_type, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(event.id, event.session_id, event.event_type, event.payload_json, event.created_at);
      }
      for (const change of Object.values(data.fileChanges ?? {})) {
        this.database.prepare(`
          INSERT OR REPLACE INTO file_changes
            (id, session_id, file_path, change_type, additions, deletions, old_content, new_content, is_binary, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          change.id,
          change.session_id,
          change.file_path,
          change.change_type,
          change.additions,
          change.deletions,
          change.old_content ?? null,
          change.new_content ?? null,
          change.is_binary ? 1 : 0,
          change.created_at,
        );
      }
      for (const [key, value] of Object.entries(data.settings ?? {})) {
        this.setSetting(key, value);
      }
    });
    migrate();
  }

  private insertSessionRow(
    session: SessionRow,
    options: { ensureTask?: boolean } = {},
  ): void {
    this.database.prepare(`
      INSERT OR REPLACE INTO sessions
        (id, project_id, claude_session_id, title, status, model, permission_mode,
         created_at, updated_at, completed_at, archived, tags_json, title_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.project_id,
      session.claude_session_id,
      session.title,
      session.status,
      session.model,
      session.permission_mode,
      session.created_at,
      session.updated_at,
      session.completed_at,
      session.archived ? 1 : 0,
      JSON.stringify(session.tags),
      session.title_source,
    );
    if (options.ensureTask !== false) {
      this.ensureTask(session.id, session.project_id, session.status);
    }
  }

  createProject(
    id: string,
    name: string,
    projectPath: string,
    timestamps?: { createdAt?: string; lastOpenedAt?: string },
  ): void {
    const createdAt = timestamps?.createdAt ?? nowIso();
    const lastOpenedAt = timestamps?.lastOpenedAt ?? createdAt;
    this.database.prepare(`
      INSERT INTO projects (id, name, path, created_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        last_opened_at = excluded.last_opened_at
    `).run(id, name, projectPath, createdAt, lastOpenedAt);
  }

  insertProjectIfAbsent(project: ProjectRow): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO projects (id, name, path, created_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      project.id,
      project.name,
      project.path,
      project.created_at,
      project.last_opened_at,
    );
    return result.changes === 1;
  }

  deleteProjectIfExactOwner(project: ProjectRow): boolean {
    const result = this.database.prepare(`
      DELETE FROM projects
      WHERE id = ?
        AND name = ?
        AND path = ?
        AND created_at = ?
        AND last_opened_at = ?
        AND NOT EXISTS (
          SELECT 1 FROM sessions WHERE sessions.project_id = projects.id
        )
    `).run(
      project.id,
      project.name,
      project.path,
      project.created_at,
      project.last_opened_at,
    );
    return result.changes === 1;
  }

  listProjects(): ProjectRow[] {
    return this.database.prepare(
      'SELECT * FROM projects ORDER BY last_opened_at DESC',
    ).all() as ProjectRow[];
  }

  getProject(id: string): ProjectRow | null {
    return (this.database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined) ?? null;
  }

  getProjectByPath(projectPath: string): ProjectRow | null {
    return (this.database.prepare('SELECT * FROM projects WHERE path = ?').get(projectPath) as ProjectRow | undefined) ?? null;
  }

  deleteProject(id: string): void {
    const remove = this.database.transaction(() => {
      const sessionIds = this.database.prepare(
        'SELECT id FROM sessions WHERE project_id = ?',
      ).all(id) as Array<{ id: string }>;
      for (const session of sessionIds) this.deleteSession(session.id);
      this.database.prepare('DELETE FROM project_settings WHERE project_id = ?').run(id);
      this.database.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
    remove();
  }

  updateProjectLastOpened(id: string): void {
    this.database.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(nowIso(), id);
  }

  updateProjectName(id: string, name: string): void {
    this.database.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id);
  }

  createSession(
    id: string,
    projectId: string,
    title: string,
    model?: string,
    permissionMode?: string,
  ): void {
    const now = nowIso();
    const session: SessionRow = {
      id,
      project_id: projectId,
      claude_session_id: null,
      title,
      status: 'idle',
      model: model ?? null,
      permission_mode: permissionMode ?? null,
      created_at: now,
      updated_at: now,
      completed_at: null,
      archived: false,
      tags: [],
      title_source: 'default',
    };
    const create = this.database.transaction(() => {
      this.insertSessionRow(session, { ensureTask: false });
      try {
        this.database.prepare(`
          INSERT INTO tasks
            (id, session_id, project_id, status, agent_mode, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, id, projectId, 'idle', 'normal', now, now);
      } catch {
        throw new Error('Session Task identity is already owned.');
      }
      const task = this.database.prepare(`
        SELECT id, session_id, project_id FROM tasks WHERE session_id = ?
      `).get(id) as Pick<TaskRow, 'id' | 'session_id' | 'project_id'> | undefined;
      if (!task || task.id !== id || task.session_id !== id || task.project_id !== projectId) {
        throw new Error('Session Task identity is already owned.');
      }
    });
    create();
  }

  listSessions(projectId: string, options?: PageOptions): SessionRow[] {
    const { limit, offset } = page(options);
    const rows = this.database.prepare(`
      SELECT sessions.*,
        (SELECT COUNT(*) FROM messages WHERE messages.session_id = sessions.id) AS message_count
      FROM sessions WHERE project_id = ?
      ORDER BY updated_at DESC LIMIT ? OFFSET ?
    `).all(projectId, limit, offset) as Array<Record<string, unknown>>;
    return rows.map((row) => sessionFromSql(row) as SessionRow);
  }

  countSessions(projectId: string): number {
    const row = this.database.prepare(
      'SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?',
    ).get(projectId) as { count: number };
    return row.count;
  }

  getSession(id: string): SessionRow | null {
    return sessionFromSql(
      this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined,
    );
  }

  updateSessionStatus(id: string, status: string, claudeSessionId?: string): void {
    const now = nowIso();
    if (claudeSessionId) {
      this.database.prepare(`
        UPDATE sessions SET status = ?, claude_session_id = ?, updated_at = ? WHERE id = ?
      `).run(status, claudeSessionId, now, id);
    } else {
      this.database.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, now, id);
    }
    this.database.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE session_id = ?')
      .run(status, now, id);
  }

  updateSessionMetadata(
    id: string,
    patch: {
      title?: string;
      titleSource?: 'default' | 'first_prompt' | 'manual' | 'custom' | 'summary';
      status?: string;
      claudeSessionId?: string | null;
      model?: string | null;
      permissionMode?: string | null;
      archived?: boolean;
      tags?: string[];
      completedAt?: string | null;
    },
  ): void {
    const current = this.getSession(id);
    if (!current) return;
    const next: SessionRow = {
      ...current,
      title: patch.title ?? current.title,
      title_source: patch.titleSource ?? current.title_source,
      status: patch.status ?? current.status,
      claude_session_id: patch.claudeSessionId !== undefined ? patch.claudeSessionId : current.claude_session_id,
      model: patch.model !== undefined ? patch.model : current.model,
      permission_mode: patch.permissionMode !== undefined ? patch.permissionMode : current.permission_mode,
      archived: patch.archived ?? current.archived,
      tags: patch.tags ? [...patch.tags] : current.tags,
      completed_at: patch.completedAt !== undefined ? patch.completedAt : current.completed_at,
      updated_at: nowIso(),
    };
    this.insertSessionRow(next);
  }

  completeSession(id: string): void {
    const now = nowIso();
    this.database.prepare(`
      UPDATE sessions SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, id);
    this.database.prepare(`
      UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE session_id = ?
    `).run(now, now, id);
  }

  deleteSession(id: string): void {
    const remove = this.database.transaction(() => {
      for (const table of ['messages', 'events', 'file_changes', 'permissions', 'tasks']) {
        this.database.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id);
      }
      this.database.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    });
    remove();
  }

  createMessage(id: string, sessionId: string, role: string, content: string): void {
    const createdAt = (this.database.prepare(
      'SELECT created_at FROM messages WHERE id = ?',
    ).get(id) as { created_at: string } | undefined)?.created_at ?? nowIso();
    this.database.prepare(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        role = excluded.role,
        content = excluded.content
    `).run(id, sessionId, role, content, createdAt);
    this.database.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(nowIso(), sessionId);
  }

  copyMessages(sourceSessionId: string, targetSessionId: string, upToMessageId?: string): void {
    const copy = this.database.transaction(() => {
      for (const message of this.listMessages(sourceSessionId)) {
        this.database.prepare(`
          INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          `${targetSessionId}:${message.id}`,
          targetSessionId,
          message.role,
          message.content,
          message.created_at,
        );
        if (upToMessageId && message.id === upToMessageId) break;
      }
    });
    copy();
  }

  listMessages(sessionId: string, options?: PageOptions): MessageRow[] {
    const { limit, offset } = page(options);
    return this.database.prepare(`
      SELECT * FROM messages WHERE session_id = ?
      ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset) as MessageRow[];
  }

  countMessages(sessionId: string): number {
    return (this.database.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?',
    ).get(sessionId) as { count: number }).count;
  }

  createEvent(
    id: string,
    sessionId: string,
    eventType: string,
    payloadJson: string,
    createdAt = nowIso(),
  ): void {
    this.database.prepare(`
      INSERT OR REPLACE INTO events (id, session_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, sessionId, eventType, payloadJson, createdAt);
  }

  createEventIfAbsent(
    id: string,
    sessionId: string,
    eventType: string,
    payloadJson: string,
    createdAt = nowIso(),
  ): boolean {
    return this.database.prepare(`
      INSERT OR IGNORE INTO events (id, session_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, sessionId, eventType, payloadJson, createdAt).changes > 0;
  }

  getEvent(id: string): EventRow | null {
    return (this.database.prepare(
      'SELECT * FROM events WHERE id = ?',
    ).get(id) as EventRow | undefined) ?? null;
  }

  listEvents(sessionId: string, options?: PageOptions): EventRow[] {
    const { limit, offset } = page(options);
    return this.database.prepare(`
      SELECT * FROM events WHERE session_id = ?
      ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset) as EventRow[];
  }

  getSessionModelBinding(sessionId: string): SessionModelBinding | null {
    const row = this.database.prepare(`
      SELECT payload_json
      FROM events
      WHERE session_id = ? AND event_type = 'system_init'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(sessionId) as Pick<EventRow, 'payload_json'> | undefined;
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload_json) as unknown;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
      const eventPayload = payload as Record<string, unknown>;
      const eventSessionId = safeBindingText(eventPayload.sessionId);
      const candidate = eventPayload.modelSessionBinding;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
      const binding = candidate as Record<string, unknown>;
      const bindingKeys = [
        'claudeSessionId', 'providerId', 'modelId', 'runtimeType', 'executionSource',
      ];
      if (Object.keys(binding).some((key) => !bindingKeys.includes(key))) return null;
      const claudeSessionId = safeBindingText(binding.claudeSessionId);
      const providerId = safeBindingText(binding.providerId);
      const modelId = safeBindingText(binding.modelId);
      const runtimeType = binding.runtimeType;
      const executionSource = binding.executionSource;
      if (
        !eventSessionId
        || !claudeSessionId
        || eventSessionId !== claudeSessionId
        || !providerId
        || !modelId
        || typeof runtimeType !== 'string'
        || !AGENT_RUNTIME_TYPES.includes(runtimeType as AgentRuntimeType)
        || typeof executionSource !== 'string'
        || !MODEL_EXECUTION_SOURCES.includes(executionSource as ModelExecutionSource)
      ) return null;
      return {
        claudeSessionId,
        providerId,
        modelId,
        runtimeType: runtimeType as AgentRuntimeType,
        executionSource: executionSource as ModelExecutionSource,
      };
    } catch {
      return null;
    }
  }

  listProjectPermissionAuditEvents(
    projectId: string,
    options?: PageOptions,
  ): PageResult<EventRow> {
    const { limit, offset } = page(options);
    const eventTypes = [
      'permission_audit_requested',
      'permission_audit_decided',
      'permission_auto_allowed',
    ] as const;
    const rows = this.database.prepare(`
      SELECT events.*
      FROM events
      INNER JOIN sessions ON sessions.id = events.session_id
      WHERE sessions.project_id = ?
        AND events.event_type IN (?, ?, ?)
      ORDER BY events.created_at DESC, events.id DESC
      LIMIT ? OFFSET ?
    `).all(projectId, ...eventTypes, limit, offset) as EventRow[];
    const total = (this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM events
      INNER JOIN sessions ON sessions.id = events.session_id
      WHERE sessions.project_id = ?
        AND events.event_type IN (?, ?, ?)
    `).get(projectId, ...eventTypes) as { count: number }).count;
    return { items: rows, total, limit, offset };
  }

  countEvents(sessionId: string): number {
    return (this.database.prepare(
      'SELECT COUNT(*) AS count FROM events WHERE session_id = ?',
    ).get(sessionId) as { count: number }).count;
  }

  createFileChange(
    id: string,
    sessionId: string,
    filePath: string,
    changeType: string,
    additions: number,
    deletions: number,
    content?: { oldContent?: string | null; newContent?: string | null; isBinary?: boolean },
  ): void {
    this.database.prepare(`
      INSERT INTO file_changes
        (id, session_id, file_path, change_type, additions, deletions, old_content, new_content, is_binary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        change_type = excluded.change_type,
        additions = excluded.additions,
        deletions = excluded.deletions,
        old_content = excluded.old_content,
        new_content = excluded.new_content,
        is_binary = excluded.is_binary
    `).run(
      id,
      sessionId,
      filePath,
      changeType,
      additions,
      deletions,
      content?.oldContent ?? null,
      content?.newContent ?? null,
      content?.isBinary ? 1 : 0,
      nowIso(),
    );
  }

  listFileChanges(sessionId: string, options?: PageOptions): FileChangeRow[] {
    const { limit, offset } = page(options);
    const rows = this.database.prepare(`
      SELECT * FROM file_changes WHERE session_id = ?
      ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset) as Array<Record<string, unknown>>;
    return rows.map(fileChangeFromSql);
  }

  ensureTask(sessionId: string, projectId: string, status = 'idle', agentMode = 'normal'): void {
    const now = nowIso();
    this.database.prepare(`
      INSERT OR IGNORE INTO tasks
        (id, session_id, project_id, status, agent_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, sessionId, projectId, status, agentMode, now, now);
  }

  getTask(sessionId: string): TaskRow | null {
    return (this.database.prepare(
      'SELECT * FROM tasks WHERE session_id = ?',
    ).get(sessionId) as TaskRow | undefined) ?? null;
  }

  updateTask(
    sessionId: string,
    patch: Partial<Pick<TaskRow,
      'status' | 'agent_mode' | 'started_at' | 'completed_at' | 'duration_ms' |
      'input_tokens' | 'output_tokens' | 'total_tokens' | 'permission_count' |
      'test_status' | 'test_command' | 'test_output'>>,
  ): void {
    const current = this.getTask(sessionId);
    if (!current) return;
    const next = { ...current, ...patch, updated_at: nowIso() };
    this.database.prepare(`
      UPDATE tasks SET
        status = ?, agent_mode = ?, started_at = ?, completed_at = ?, duration_ms = ?,
        input_tokens = ?, output_tokens = ?, total_tokens = ?, permission_count = ?,
        test_status = ?, test_command = ?, test_output = ?, updated_at = ?
      WHERE session_id = ?
    `).run(
      next.status,
      next.agent_mode,
      next.started_at,
      next.completed_at,
      next.duration_ms,
      next.input_tokens,
      next.output_tokens,
      next.total_tokens,
      next.permission_count,
      next.test_status,
      next.test_command,
      next.test_output,
      next.updated_at,
      sessionId,
    );
  }

  listTasks(projectId: string, options?: PageOptions): TaskRow[] {
    const { limit, offset } = page(options);
    return this.database.prepare(`
      SELECT * FROM tasks WHERE project_id = ?
      ORDER BY updated_at DESC LIMIT ? OFFSET ?
    `).all(projectId, limit, offset) as TaskRow[];
  }

  createCheckpoint(checkpoint: CheckpointRow, files: CheckpointFileRow[] = []): void {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO checkpoints
          (id, task_id, project_path, type, created_at, git_commit, snapshot_path, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpoint.id,
        checkpoint.task_id,
        checkpoint.project_path,
        checkpoint.type,
        checkpoint.created_at,
        checkpoint.git_commit,
        checkpoint.snapshot_path,
        checkpoint.metadata_json,
      );

      for (const file of files) {
        if (file.checkpoint_id !== checkpoint.id) {
          throw new Error(
            `Checkpoint file ${file.file_path} belongs to ${file.checkpoint_id}, expected ${checkpoint.id}`,
          );
        }
        this.upsertCheckpointFile(file);
      }
    })();
  }

  getCheckpoint(id: string): CheckpointRow | null {
    return (this.database.prepare(
      'SELECT * FROM checkpoints WHERE id = ?',
    ).get(id) as CheckpointRow | undefined) ?? null;
  }

  listCheckpoints(taskId: string, projectPath?: string, options?: PageOptions): CheckpointRow[] {
    const { limit, offset } = page(options);
    if (projectPath !== undefined) {
      return this.database.prepare(`
        SELECT * FROM checkpoints
        WHERE task_id = ? AND project_path = ?
        ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
      `).all(taskId, projectPath, limit, offset) as CheckpointRow[];
    }
    return this.database.prepare(`
      SELECT * FROM checkpoints WHERE task_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(taskId, limit, offset) as CheckpointRow[];
  }

  createCheckpointFile(file: CheckpointFileRow): void {
    this.database.transaction(() => this.upsertCheckpointFile(file))();
  }

  private upsertCheckpointFile(file: CheckpointFileRow): void {
    this.database.prepare(`
      INSERT INTO checkpoint_files (checkpoint_id, file_path, hash, size, modified_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(checkpoint_id, file_path) DO UPDATE SET
        hash = excluded.hash,
        size = excluded.size,
        modified_at = excluded.modified_at
    `).run(file.checkpoint_id, file.file_path, file.hash, file.size, file.modified_at);
  }

  listCheckpointFiles(checkpointId: string): CheckpointFileRow[] {
    return this.database.prepare(`
      SELECT * FROM checkpoint_files WHERE checkpoint_id = ?
      ORDER BY file_path ASC
    `).all(checkpointId) as CheckpointFileRow[];
  }

  deleteCheckpoint(id: string): boolean {
    return this.database.transaction(() => (
      this.database.prepare('DELETE FROM checkpoints WHERE id = ?').run(id).changes > 0
    ))();
  }

  createWorkflow(workflow: WorkflowRow): void {
    this.database.prepare(`
      INSERT INTO workflows
        (id, task_id, status, current_stage, created_at, updated_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      workflow.id,
      workflow.task_id,
      workflow.status,
      workflow.current_stage,
      workflow.created_at,
      workflow.updated_at,
      workflow.metadata_json,
    );
  }

  getWorkflow(id: string): WorkflowRow | null {
    return (this.database.prepare(
      'SELECT * FROM workflows WHERE id = ?',
    ).get(id) as WorkflowRow | undefined) ?? null;
  }

  getWorkflowByTaskId(taskId: string): WorkflowRow | null {
    return (this.database.prepare(
      'SELECT * FROM workflows WHERE task_id = ?',
    ).get(taskId) as WorkflowRow | undefined) ?? null;
  }

  saveWorkflow(workflow: WorkflowRow, options: WorkflowSaveOptions = {}): boolean {
    const parameters = [
      workflow.task_id,
      workflow.status,
      workflow.current_stage,
      workflow.created_at,
      workflow.updated_at,
      workflow.metadata_json,
      workflow.id,
    ];
    return this.database.prepare(`
      UPDATE workflows SET
        task_id = ?, status = ?, current_stage = ?, created_at = ?, updated_at = ?, metadata_json = ?
      WHERE id = ?
        AND (? IS NULL OR updated_at = ?)
        AND (? IS NULL OR CAST(json_extract(metadata_json, '$.revision') AS INTEGER) = ?)
    `).run(
      ...parameters,
      options.expectedUpdatedAt ?? null,
      options.expectedUpdatedAt ?? null,
      options.expectedRevision ?? null,
      options.expectedRevision ?? null,
    ).changes > 0;
  }

  listWorkflows(options?: PageOptions): WorkflowRow[] {
    const { limit, offset } = workflowPage(options);
    return this.database.prepare(`
      SELECT * FROM workflows
      ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(limit, offset) as WorkflowRow[];
  }

  listWorkflowsByStatus(status: string, options?: PageOptions): WorkflowRow[] {
    const { limit, offset } = workflowPage(options);
    return this.database.prepare(`
      SELECT * FROM workflows WHERE status = ?
      ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(status, limit, offset) as WorkflowRow[];
  }

  listWorkflowsForProject(
    projectId: string,
    options?: PageOptions,
    status?: string,
  ): WorkflowRow[] {
    const { limit, offset } = workflowPage(options);
    if (status !== undefined) {
      return this.database.prepare(`
        SELECT workflows.* FROM workflows
        INNER JOIN tasks ON tasks.id = workflows.task_id
        WHERE tasks.project_id = ? AND workflows.status = ?
        ORDER BY workflows.updated_at DESC, workflows.id DESC LIMIT ? OFFSET ?
      `).all(projectId, status, limit, offset) as WorkflowRow[];
    }
    return this.database.prepare(`
      SELECT workflows.* FROM workflows
      INNER JOIN tasks ON tasks.id = workflows.task_id
      WHERE tasks.project_id = ?
      ORDER BY workflows.updated_at DESC, workflows.id DESC LIMIT ? OFFSET ?
    `).all(projectId, limit, offset) as WorkflowRow[];
  }

  countWorkflowsForProject(projectId: string, status?: string): number {
    if (status !== undefined) {
      return (this.database.prepare(`
        SELECT COUNT(*) AS count FROM workflows
        INNER JOIN tasks ON tasks.id = workflows.task_id
        WHERE tasks.project_id = ? AND workflows.status = ?
      `).get(projectId, status) as { count: number }).count;
    }
    return (this.database.prepare(`
      SELECT COUNT(*) AS count FROM workflows
      INNER JOIN tasks ON tasks.id = workflows.task_id
      WHERE tasks.project_id = ?
    `).get(projectId) as { count: number }).count;
  }

  countWorkflows(status?: string): number {
    const row = status === undefined
      ? this.database.prepare('SELECT COUNT(*) AS count FROM workflows').get()
      : this.database.prepare(
        'SELECT COUNT(*) AS count FROM workflows WHERE status = ?',
      ).get(status);
    return (row as { count: number }).count;
  }

  deleteWorkflow(id: string): boolean {
    return this.database.prepare('DELETE FROM workflows WHERE id = ?').run(id).changes > 0;
  }

  createWorkflowStep(step: WorkflowStepRow): void {
    const safeInput = withoutUntrustedWorkflowModelSelection(step.input);
    this.database.prepare(`
      INSERT INTO workflow_steps
        (id, workflow_id, agent_type, review_round, status, input, output, error,
         started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      step.id,
      step.workflow_id,
      step.agent_type,
      step.review_round,
      step.status,
      safeInput,
      step.output,
      step.error,
      step.started_at,
      step.completed_at,
    );
  }

  upsertWorkflowStep(step: WorkflowStepRow): void {
    const safeInput = withoutUntrustedWorkflowModelSelection(step.input);
    const result = this.database.prepare(`
      INSERT INTO workflow_steps
        (id, workflow_id, agent_type, review_round, status, input, output, error,
         started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent_type = excluded.agent_type,
        review_round = excluded.review_round,
        status = excluded.status,
        input = CASE
          WHEN excluded.status IN ('completed', 'failed')
            AND json_type(workflow_steps.input, '$.modelSelection') = 'object'
            AND json_type(
              workflow_steps.input,
              '$.${WORKFLOW_MODEL_SELECTION_TRUST_KEY}'
            ) = 'true'
          THEN json_set(
            excluded.input,
            '$.modelSelection',
            json_extract(workflow_steps.input, '$.modelSelection'),
            '$.${WORKFLOW_MODEL_SELECTION_TRUST_KEY}',
            json('true')
          )
          ELSE excluded.input
        END,
        output = excluded.output,
        error = excluded.error,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
      WHERE workflow_steps.workflow_id = excluded.workflow_id
    `).run(
      step.id,
      step.workflow_id,
      step.agent_type,
      step.review_round,
      step.status,
      safeInput,
      step.output,
      step.error,
      step.started_at,
      step.completed_at,
    );
    if (result.changes === 0) {
      throw new Error(`Workflow step ${step.id} already belongs to another workflow`);
    }
  }

  getWorkflowStep(id: string): WorkflowStepRow | null {
    const step = this.database.prepare(
      'SELECT * FROM workflow_steps WHERE id = ?',
    ).get(id) as WorkflowStepRow | undefined;
    return step ? withoutWorkflowStepTrustMetadata(step) : null;
  }

  attachWorkflowStepModelSelection(
    stepId: string,
    selection: ResolvedModelSelection,
  ): boolean {
    const step = this.getWorkflowStep(stepId);
    if (!step || step.status !== 'running') return false;
    const input = JSON.parse(step.input) as unknown;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Workflow step input is not a structured object.');
    }
    if (!(MODEL_SELECTION_SOURCES as readonly string[]).includes(selection.source)
      || !(MODEL_EXECUTION_SOURCES as readonly string[]).includes(selection.executionSource)
      || selection.runtimeType !== 'claude-code') {
      throw new Error('Workflow model selection provenance is invalid.');
    }
    const hasTier = selection.tier !== undefined;
    if (hasTier !== (selection.tierSource !== undefined)
      || (hasTier && !(MODEL_TIERS as readonly string[]).includes(selection.tier as string))
      || (hasTier && selection.tierSource !== 'global' && selection.tierSource !== 'project')) {
      throw new Error('Workflow model selection tier provenance is invalid.');
    }
    const safeSelection = {
      providerId: workflowSelectionText(selection.providerId, 192, 'Provider identity'),
      providerName: workflowSelectionText(selection.providerName, 256, 'Provider name'),
      modelId: workflowSelectionText(selection.modelId, 256, 'model identity'),
      runtimeType: selection.runtimeType,
      source: selection.source,
      executionSource: selection.executionSource,
      ...(selection.tier ? { tier: selection.tier, tierSource: selection.tierSource } : {}),
      capabilities: {
        supportsClaudeCode: selection.capabilities.supportsClaudeCode,
        supportsAgentWorkflow: selection.capabilities.supportsAgentWorkflow,
        supportsTools: selection.capabilities.supportsTools,
        supportsMCP: selection.capabilities.supportsMCP,
        supportsStreaming: selection.capabilities.supportsStreaming,
        supportsVision: selection.capabilities.supportsVision,
      },
    };
    const result = this.database.prepare(`
      UPDATE workflow_steps SET input = ?
      WHERE id = ? AND status = 'running'
    `).run(JSON.stringify({
      ...(input as Record<string, unknown>),
      modelSelection: safeSelection,
      [WORKFLOW_MODEL_SELECTION_TRUST_KEY]: true,
    }), stepId);
    return result.changes === 1;
  }

  listWorkflowSteps(workflowId: string, options?: PageOptions): WorkflowStepRow[] {
    const { limit, offset } = workflowPage(options);
    const steps = this.database.prepare(`
      SELECT * FROM workflow_steps WHERE workflow_id = ?
      ORDER BY started_at ASC, id ASC LIMIT ? OFFSET ?
    `).all(workflowId, limit, offset) as WorkflowStepRow[];
    return steps.map(withoutWorkflowStepTrustMetadata);
  }

  countWorkflowSteps(workflowId: string): number {
    return (this.database.prepare(`
      SELECT COUNT(*) AS count FROM workflow_steps WHERE workflow_id = ?
    `).get(workflowId) as { count: number }).count;
  }

  deleteWorkflowStep(id: string): boolean {
    return this.database.prepare('DELETE FROM workflow_steps WHERE id = ?').run(id).changes > 0;
  }

  createReview(review: ReviewRow, issues: ReviewIssueRow[] = []): void {
    this.assertReviewIssueOwners(review, issues);
    this.database.transaction(() => {
      this.assertReviewStepOwner(review);
      this.insertReview(review);
      for (const issue of issues) this.insertReviewIssue(issue);
    })();
  }

  saveWorkflowWithReview(
    workflow: WorkflowRow,
    review: ReviewRow,
    issues: ReviewIssueRow[] = [],
    options: WorkflowSaveOptions = {},
  ): boolean {
    if (review.workflow_id !== workflow.id) {
      throw new Error(
        `Review ${review.id} belongs to ${review.workflow_id}, expected ${workflow.id}`,
      );
    }
    this.assertReviewIssueOwners(review, issues);
    return this.database.transaction(() => {
      if (!this.saveWorkflow(workflow, options)) return false;
      this.assertReviewStepOwner(review);
      this.insertReviewIdempotently(review);
      for (const issue of issues) this.insertReviewIssueIdempotently(issue);
      return true;
    })();
  }

  private assertReviewIssueOwners(review: ReviewRow, issues: ReviewIssueRow[]): void {
    for (const issue of issues) {
      if (issue.review_id !== review.id) {
        throw new Error(
          `Review issue ${issue.id} belongs to ${issue.review_id}, expected ${review.id}`,
        );
      }
    }
  }

  private assertReviewStepOwner(review: ReviewRow): void {
    if (review.step_id !== null) {
      const owner = this.database.prepare(
        'SELECT workflow_id FROM workflow_steps WHERE id = ?',
      ).get(review.step_id) as { workflow_id: string } | undefined;
      if (owner && owner.workflow_id !== review.workflow_id) {
        throw new Error(
          `Review step ${review.step_id} belongs to ${owner.workflow_id}, expected ${review.workflow_id}`,
        );
      }
    }
  }

  private insertReview(review: ReviewRow, ignoreConflict = false): BetterSqlite3.RunResult {
    return this.database.prepare(`
      INSERT INTO reviews
        (id, workflow_id, step_id, review_round, score, summary,
         tests_passed, tests_failed, tests_skipped, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${ignoreConflict ? 'ON CONFLICT(id) DO NOTHING' : ''}
    `).run(
      review.id,
      review.workflow_id,
      review.step_id,
      review.review_round,
      review.score,
      review.summary,
      review.tests_passed,
      review.tests_failed,
      review.tests_skipped,
      review.created_at,
    );
  }

  private insertReviewIdempotently(review: ReviewRow): void {
    const result = this.insertReview(review, true);
    if (result.changes > 0) return;
    const existing = this.getReview(review.id);
    if (!existing || !reviewRowsEqual(existing, review)) {
      throw new Error(`Review ${review.id} conflicts with an existing persisted review`);
    }
  }

  getReview(id: string): ReviewRow | null {
    return (this.database.prepare(
      'SELECT * FROM reviews WHERE id = ?',
    ).get(id) as ReviewRow | undefined) ?? null;
  }

  listReviews(workflowId: string, options?: PageOptions): ReviewRow[] {
    const { limit, offset } = workflowPage(options);
    return this.database.prepare(`
      SELECT * FROM reviews WHERE workflow_id = ?
      ORDER BY review_round DESC, created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(workflowId, limit, offset) as ReviewRow[];
  }

  countReviews(workflowId: string): number {
    return (this.database.prepare(`
      SELECT COUNT(*) AS count FROM reviews WHERE workflow_id = ?
    `).get(workflowId) as { count: number }).count;
  }

  createReviewIssue(issue: ReviewIssueRow): void {
    this.insertReviewIssue(issue);
  }

  private insertReviewIssue(issue: ReviewIssueRow): void {
    this.insertReviewIssueRow(issue);
  }

  private insertReviewIssueRow(
    issue: ReviewIssueRow,
    ignoreConflict = false,
  ): BetterSqlite3.RunResult {
    return this.database.prepare(`
      INSERT INTO review_issues
        (id, review_id, severity, file_path, line, title, recommendation, resolved, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${ignoreConflict ? 'ON CONFLICT(id) DO NOTHING' : ''}
    `).run(
      issue.id,
      issue.review_id,
      issue.severity,
      issue.file_path,
      issue.line,
      issue.title,
      issue.recommendation,
      issue.resolved ? 1 : 0,
      issue.created_at,
    );
  }

  private insertReviewIssueIdempotently(issue: ReviewIssueRow): void {
    const result = this.insertReviewIssueRow(issue, true);
    if (result.changes > 0) return;
    const existing = this.getReviewIssue(issue.id);
    if (!existing || !reviewIssueRowsEqual(existing, issue)) {
      throw new Error(`Review issue ${issue.id} conflicts with an existing persisted issue`);
    }
  }

  getReviewIssue(id: string): ReviewIssueRow | null {
    const row = this.database.prepare(
      'SELECT * FROM review_issues WHERE id = ?',
    ).get(id) as Record<string, unknown> | undefined;
    return row ? reviewIssueFromSql(row) : null;
  }

  listReviewIssues(reviewId: string, options?: PageOptions): ReviewIssueRow[] {
    const { limit, offset } = workflowPage(options);
    const rows = this.database.prepare(`
      SELECT * FROM review_issues WHERE review_id = ?
      ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?
    `).all(reviewId, limit, offset) as Array<Record<string, unknown>>;
    return rows.map(reviewIssueFromSql);
  }

  countReviewIssues(reviewId: string): number {
    return (this.database.prepare(`
      SELECT COUNT(*) AS count FROM review_issues WHERE review_id = ?
    `).get(reviewId) as { count: number }).count;
  }

  getReviewWithIssues(id: string): { review: ReviewRow; issues: ReviewIssueRow[] } | null {
    const review = this.getReview(id);
    if (!review) return null;
    const rows = this.database.prepare(`
      SELECT * FROM review_issues WHERE review_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(id) as Array<Record<string, unknown>>;
    return { review, issues: rows.map(reviewIssueFromSql) };
  }

  deleteReview(id: string): boolean {
    return this.database.prepare('DELETE FROM reviews WHERE id = ?').run(id).changes > 0;
  }

  recoverInterruptedTasks(completedAt = nowIso()): number {
    return this.database.transaction(() => {
      const sessions = this.database.prepare(`
        SELECT session_id, started_at FROM tasks
        WHERE status IN ('starting', 'running', 'waiting_permission')
      `).all() as Array<{ session_id: string; started_at: string | null }>;
      const updateTask = this.database.prepare(`
        UPDATE tasks SET status = 'interrupted', completed_at = NULL, duration_ms = ?, updated_at = ?
        WHERE session_id = ?
      `);
      const updateSession = this.database.prepare(`
        UPDATE sessions SET status = 'interrupted', completed_at = NULL, updated_at = ?
        WHERE id = ?
      `);
      const completedTime = Date.parse(completedAt);
      for (const session of sessions) {
        const startedTime = Date.parse(session.started_at ?? '');
        const duration = Number.isFinite(completedTime) && Number.isFinite(startedTime)
          ? Math.max(0, completedTime - startedTime)
          : 0;
        updateTask.run(duration, completedAt, session.session_id);
        updateSession.run(completedAt, session.session_id);
      }
      return sessions.length;
    })();
  }

  createAppRun(row: AppRunRow): void {
    this.database.prepare(`
      INSERT INTO app_runs
        (id, pid, build_id, started_at, heartbeat_at, shutdown_started_at, clean_shutdown_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.pid,
      row.build_id,
      row.started_at,
      row.heartbeat_at,
      row.shutdown_started_at,
      row.clean_shutdown_at,
      row.status,
    );
  }

  listUncleanAppRuns(): AppRunRow[] {
    return this.database.prepare(`
      SELECT * FROM app_runs WHERE status IN ('running', 'shutting_down')
      ORDER BY started_at ASC
    `).all() as AppRunRow[];
  }

  updateAppRun(
    id: string,
    patch: Partial<Pick<AppRunRow,
      'heartbeat_at' | 'shutdown_started_at' | 'clean_shutdown_at' | 'status'>>,
  ): void {
    const current = this.database.prepare('SELECT * FROM app_runs WHERE id = ?')
      .get(id) as AppRunRow | undefined;
    if (!current) return;
    const next = { ...current, ...patch };
    this.database.prepare(`
      UPDATE app_runs SET heartbeat_at = ?, shutdown_started_at = ?, clean_shutdown_at = ?, status = ?
      WHERE id = ?
    `).run(
      next.heartbeat_at,
      next.shutdown_started_at,
      next.clean_shutdown_at,
      next.status,
      id,
    );
  }

  recordManagedProcess(row: ManagedProcessRow): void {
    this.database.prepare(`
      INSERT INTO managed_processes
        (id, app_run_id, kind, pid, parent_pid, creation_time, executable_path, launch_nonce,
         project_id, session_id, task_id, run_id, state, started_at, stop_requested_at,
         exited_at, exit_code, signal, error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        stop_requested_at = excluded.stop_requested_at,
        exited_at = excluded.exited_at,
        exit_code = excluded.exit_code,
        signal = excluded.signal,
        error_code = excluded.error_code
    `).run(
      row.id,
      row.app_run_id,
      row.kind,
      row.pid,
      row.parent_pid,
      row.creation_time,
      row.executable_path,
      row.launch_nonce,
      row.project_id,
      row.session_id,
      row.task_id,
      row.run_id,
      row.state,
      row.started_at,
      row.stop_requested_at,
      row.exited_at,
      row.exit_code,
      row.signal,
      row.error_code,
    );
  }

  updateManagedProcess(
    id: string,
    patch: Partial<Pick<ManagedProcessRow,
      'state' | 'stop_requested_at' | 'exited_at' | 'exit_code' | 'signal' | 'error_code'>>,
  ): void {
    const current = this.database.prepare('SELECT * FROM managed_processes WHERE id = ?')
      .get(id) as ManagedProcessRow | undefined;
    if (!current) return;
    this.recordManagedProcess({ ...current, ...patch });
  }

  listManagedProcesses(appRunId?: string, activeOnly = false): ManagedProcessRow[] {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (appRunId) {
      conditions.push('app_run_id = ?');
      parameters.push(appRunId);
    }
    if (activeOnly) conditions.push("state IN ('starting', 'running', 'stopping')");
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.database.prepare(`
      SELECT * FROM managed_processes ${where} ORDER BY started_at ASC, id ASC
    `).all(...parameters) as ManagedProcessRow[];
  }

  recordMutationOperation(row: {
    id: string;
    appRunId?: string | null;
    projectId?: string | null;
    projectPath: string;
    sessionId?: string | null;
    taskId?: string | null;
    runId?: string | null;
    kind: string;
    status: string;
    filePaths?: readonly string[];
    fingerprint?: unknown;
    startedAt: string;
    completedAt?: string | null;
    error?: string | null;
  }): void {
    this.database.prepare(`
      INSERT INTO mutation_operations
        (id, app_run_id, project_id, project_path, session_id, task_id, run_id, kind,
         status, file_paths_json, fingerprint_json, started_at, completed_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        completed_at = excluded.completed_at,
        error = excluded.error
    `).run(
      row.id,
      row.appRunId ?? null,
      row.projectId ?? null,
      row.projectPath,
      row.sessionId ?? null,
      row.taskId ?? null,
      row.runId ?? null,
      row.kind,
      row.status,
      JSON.stringify(row.filePaths ?? []),
      row.fingerprint === undefined ? null : JSON.stringify(row.fingerprint),
      row.startedAt,
      row.completedAt ?? null,
      row.error ?? null,
    );
  }

  recordPendingPermissionRequest(row: {
    id: string;
    appRunId?: string | null;
    projectId?: string | null;
    sessionId?: string | null;
    taskId?: string | null;
    runId: string;
    toolName: string;
    requestedAt: string;
  }): void {
    this.database.prepare(`
      INSERT INTO permission_requests
        (id, app_run_id, project_id, session_id, task_id, run_id, tool_name,
         status, requested_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
      ON CONFLICT(id) DO NOTHING
    `).run(
      row.id,
      row.appRunId ?? null,
      row.projectId ?? null,
      row.sessionId ?? null,
      row.taskId ?? null,
      row.runId,
      row.toolName,
      row.requestedAt,
    );
  }

  settlePermissionRequest(
    id: string,
    status: 'allowed' | 'denied' | 'interrupted',
    resolvedAt = nowIso(),
  ): void {
    this.database.prepare(`
      UPDATE permission_requests SET status = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, resolvedAt, id);
  }

  listRecoveryItems(status: RecoveryItemRow['status'] = 'pending'): RecoveryItemRow[] {
    return this.database.prepare(`
      SELECT * FROM recovery_items WHERE status = ? ORDER BY detected_at DESC, id DESC
    `).all(status) as RecoveryItemRow[];
  }

  getRecoveryItem(id: string): RecoveryItemRow | null {
    return (this.database.prepare('SELECT * FROM recovery_items WHERE id = ?')
      .get(id) as RecoveryItemRow | undefined) ?? null;
  }

  reconcileCrashState(sourceAppRunId: string | null, detectedAt = nowIso()): RecoveryItemRow[] {
    return this.database.transaction(() => {
      const insert = this.database.prepare(`
        INSERT OR IGNORE INTO recovery_items
          (id, app_run_id, kind, resource_id, project_id, session_id, task_id,
           last_state, reason, status, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unclean_shutdown', 'pending', ?)
      `);
      const activeTasks = this.database.prepare(`
        SELECT id, session_id, project_id, status, started_at FROM tasks
        WHERE status IN ('starting', 'running', 'waiting_permission')
      `).all() as Array<{
        id: string;
        session_id: string;
        project_id: string;
        status: string;
        started_at: string | null;
      }>;
      for (const task of activeTasks) {
        insert.run(
          `recovery:task:${task.id}`,
          sourceAppRunId,
          'task',
          task.id,
          task.project_id,
          task.session_id,
          task.id,
          task.status,
          detectedAt,
        );
        const startedTime = Date.parse(task.started_at ?? '');
        const duration = Number.isFinite(startedTime)
          ? Math.max(0, Date.parse(detectedAt) - startedTime)
          : 0;
        this.database.prepare(`
          UPDATE tasks SET status = 'interrupted', duration_ms = ?, completed_at = NULL, updated_at = ?
          WHERE id = ?
        `).run(duration, detectedAt, task.id);
        this.database.prepare(`
          UPDATE sessions SET status = 'interrupted', completed_at = NULL, updated_at = ? WHERE id = ?
        `).run(detectedAt, task.session_id);
      }

      const activeWorkflows = this.database.prepare(`
        SELECT workflows.*, tasks.project_id, tasks.session_id
        FROM workflows INNER JOIN tasks ON tasks.id = workflows.task_id
        WHERE workflows.status IN ('planning', 'executing', 'testing', 'reviewing')
      `).all() as Array<WorkflowRow & { project_id: string; session_id: string }>;
      for (const workflow of activeWorkflows) {
        insert.run(
          `recovery:workflow:${workflow.id}`,
          sourceAppRunId,
          'workflow',
          workflow.id,
          workflow.project_id,
          workflow.session_id,
          workflow.task_id,
          workflow.status,
          detectedAt,
        );
        const metadata = JSON.parse(workflow.metadata_json) as Record<string, unknown>;
        metadata.pausedFrom = workflow.status;
        metadata.pauseReason = 'app_crash';
        metadata.interruptedAt = detectedAt;
        metadata.activeStage = null;
        metadata.revision = Number.isInteger(metadata.revision)
          ? Number(metadata.revision) + 1
          : 1;
        this.database.prepare(`
          UPDATE workflows SET status = 'paused', current_stage = NULL, updated_at = ?, metadata_json = ?
          WHERE id = ?
        `).run(detectedAt, JSON.stringify(metadata), workflow.id);
      }
      this.database.prepare(`
        UPDATE workflow_steps SET status = 'interrupted', error = 'APP_CRASH', completed_at = ?
        WHERE status = 'running'
      `).run(detectedAt);

      const activeProcesses = sourceAppRunId
        ? this.listManagedProcesses(sourceAppRunId, true)
        : [];
      for (const processRow of activeProcesses) {
        insert.run(
          `recovery:process:${processRow.id}`,
          sourceAppRunId,
          'process',
          processRow.id,
          processRow.project_id,
          processRow.session_id,
          processRow.task_id,
          processRow.state,
          detectedAt,
        );
        this.updateManagedProcess(processRow.id, {
          state: 'orphaned_unverified',
          error_code: 'APP_CRASH',
        });
      }

      const pendingPermissions = this.database.prepare(`
        SELECT * FROM permission_requests WHERE status = 'pending'
      `).all() as Array<Record<string, string | null>>;
      for (const permission of pendingPermissions) {
        insert.run(
          `recovery:permission:${permission.id}`,
          sourceAppRunId,
          'permission',
          permission.id,
          permission.project_id,
          permission.session_id,
          permission.task_id,
          'pending',
          detectedAt,
        );
      }
      this.database.prepare(`
        UPDATE permission_requests SET status = 'interrupted', resolved_at = ? WHERE status = 'pending'
      `).run(detectedAt);

      const mutations = this.database.prepare(`
        SELECT * FROM mutation_operations WHERE status IN ('started', 'running')
      `).all() as Array<Record<string, string | null>>;
      for (const mutation of mutations) {
        insert.run(
          `recovery:mutation:${mutation.id}`,
          sourceAppRunId,
          'mutation',
          mutation.id,
          mutation.project_id,
          mutation.session_id,
          mutation.task_id,
          mutation.status,
          detectedAt,
        );
      }
      this.database.prepare(`
        UPDATE mutation_operations SET status = 'interrupted', completed_at = ?
        WHERE status IN ('started', 'running')
      `).run(detectedAt);

      if (sourceAppRunId) {
        this.updateAppRun(sourceAppRunId, { status: 'crashed', heartbeat_at: detectedAt });
      }
      return this.listRecoveryItems('pending');
    })();
  }

  resolveRecoveryItem(
    id: string,
    status: Extract<RecoveryItemRow['status'], 'resumed' | 'abandoned' | 'resolved'>,
    resolution: Record<string, unknown>,
    resolvedAt = nowIso(),
  ): RecoveryItemRow | null {
    this.database.prepare(`
      UPDATE recovery_items SET status = ?, resolved_at = ?, resolution_json = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, resolvedAt, JSON.stringify(resolution), id);
    return this.getRecoveryItem(id);
  }

  prepareWorkflowRecoveryResume(id: string, resolvedAt = nowIso()): RecoveryItemRow | null {
    return this.database.transaction(() => {
      const item = this.getRecoveryItem(id);
      if (!item || item.status !== 'pending' || item.kind !== 'workflow') return item;
      const workflow = this.getWorkflow(item.resource_id);
      if (!workflow || workflow.status !== 'paused') return null;
      const metadata = JSON.parse(workflow.metadata_json) as Record<string, unknown>;
      if (metadata.pauseReason !== 'app_crash') return null;
      if (metadata.recoveryPreparedItemId !== id) {
        metadata.executionCycle = Number.isInteger(metadata.executionCycle)
          ? Number(metadata.executionCycle) + 1
          : 1;
        metadata.revision = Number.isInteger(metadata.revision)
          ? Number(metadata.revision) + 1
          : 1;
        metadata.recoveryPreparedAt = resolvedAt;
        metadata.recoveryPreparedItemId = id;
        this.database.prepare(`
          UPDATE workflows SET updated_at = ?, metadata_json = ? WHERE id = ?
        `).run(resolvedAt, JSON.stringify(metadata), workflow.id);
      }
      return item;
    })();
  }

  abandonRecoveryItem(id: string, resolvedAt = nowIso()): RecoveryItemRow | null {
    return this.database.transaction(() => {
      const item = this.getRecoveryItem(id);
      if (!item || item.status !== 'pending') return item;
      const taskId = item.task_id;
      if (taskId) {
        this.database.prepare(`
          UPDATE tasks SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?
        `).run(resolvedAt, resolvedAt, taskId);
        this.database.prepare(`
          UPDATE sessions SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?
        `).run(resolvedAt, resolvedAt, item.session_id ?? taskId);
        this.database.prepare(`
          UPDATE workflows SET status = 'cancelled', current_stage = NULL, updated_at = ?
          WHERE task_id = ? AND status = 'paused'
        `).run(resolvedAt, taskId);
      }
      return this.resolveRecoveryItem(id, 'abandoned', { noProjectWrites: true }, resolvedAt);
    })();
  }

  getDiagnosticsSummary(): DatabaseDiagnosticsSummary {
    const tables = [
      'projects', 'sessions', 'messages', 'events', 'tasks', 'permissions',
      'checkpoints', 'workflows', 'reviews', 'recovery_items', 'managed_processes',
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      counts[table] = (this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count: number }).count;
    }
    const integrityRows = this.database.pragma('integrity_check') as Array<{ integrity_check: string }>;
    return {
      schemaVersion: this.database.pragma('user_version', { simple: true }) as number,
      sizeBytes: fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0,
      journalMode: String(this.database.pragma('journal_mode', { simple: true })),
      integrity: integrityRows.every((row) => row.integrity_check === 'ok') ? 'ok' : 'failed',
      counts,
    };
  }

  getAnonymousPerformanceSource(): AnonymousPerformanceSource {
    const groupedCounts = (
      table: 'tasks' | 'workflows',
      knownStatuses: ReadonlySet<string>,
    ): AggregateOperationCounts => {
      const rows = this.database.prepare(`
        SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status
      `).all() as Array<{ status: unknown; count: unknown }>;
      const result: AggregateOperationCounts = {
        total: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        interrupted: 0,
      };
      for (const row of rows) {
        if (typeof row.status !== 'string' || !knownStatuses.has(row.status)) {
          throw new Error('Anonymous performance data is unavailable.');
        }
        const count = anonymousAggregateCount(row.count);
        result.total = anonymousAggregateCount(result.total + count);
        if (
          row.status === 'completed'
          || row.status === 'failed'
          || row.status === 'cancelled'
          || row.status === 'interrupted'
        ) {
          result[row.status] = count;
        }
      }
      return result;
    };
    const rawBuckets = this.database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN duration_ms < 1000 THEN 1 ELSE 0 END), 0) AS underOneSecond,
        COALESCE(SUM(CASE WHEN duration_ms >= 1000 AND duration_ms < 10000 THEN 1 ELSE 0 END), 0) AS oneToTenSeconds,
        COALESCE(SUM(CASE WHEN duration_ms >= 10000 AND duration_ms < 60000 THEN 1 ELSE 0 END), 0) AS tenToSixtySeconds,
        COALESCE(SUM(CASE WHEN duration_ms >= 60000 AND duration_ms < 600000 THEN 1 ELSE 0 END), 0) AS oneToTenMinutes,
        COALESCE(SUM(CASE WHEN duration_ms >= 600000 THEN 1 ELSE 0 END), 0) AS tenMinutesOrMore,
        COALESCE(SUM(CASE WHEN typeof(duration_ms) != 'integer' OR duration_ms < 0 THEN 1 ELSE 0 END), 0) AS invalid
      FROM tasks
    `).get() as Record<string, unknown>;
    if (anonymousAggregateCount(rawBuckets.invalid) !== 0) {
      throw new Error('Anonymous performance data is unavailable.');
    }
    const durationBuckets = {
      underOneSecond: anonymousAggregateCount(rawBuckets.underOneSecond),
      oneToTenSeconds: anonymousAggregateCount(rawBuckets.oneToTenSeconds),
      tenToSixtySeconds: anonymousAggregateCount(rawBuckets.tenToSixtySeconds),
      oneToTenMinutes: anonymousAggregateCount(rawBuckets.oneToTenMinutes),
      tenMinutesOrMore: anonymousAggregateCount(rawBuckets.tenMinutesOrMore),
    };
    return {
      operations: {
        direct: groupedCounts('tasks', KNOWN_DIRECT_STATUSES),
        orchestrated: groupedCounts('workflows', KNOWN_ORCHESTRATED_STATUSES),
      },
      durationBuckets,
    };
  }

  checkpointWal(): void {
    this.database.pragma('wal_checkpoint(PASSIVE)');
  }

  createPermission(row: PermissionRow): void {
    this.database.prepare(`
      INSERT OR REPLACE INTO permissions
        (id, session_id, run_id, tool_name, decision, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.session_id,
      row.run_id,
      row.tool_name,
      row.decision,
      row.created_at,
      row.resolved_at,
    );
    this.database.prepare(`
      UPDATE tasks SET permission_count = permission_count + 1, updated_at = ?
      WHERE session_id = ?
    `).run(nowIso(), row.session_id);
  }

  listPermissions(sessionId: string): PermissionRow[] {
    return this.database.prepare(`
      SELECT * FROM permissions WHERE session_id = ? ORDER BY created_at ASC
    `).all(sessionId) as PermissionRow[];
  }

  createProjectPermissionRule(row: ProjectPermissionRuleRow): ProjectPermissionRuleRow {
    this.database.prepare(`
      INSERT INTO project_permission_rules
        (id, project_id, scope, canonical_project_path, tool_name, capability,
         command_pattern, risk_ceiling, enabled, source, created_at, updated_at,
         last_hit_at, hit_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.project_id,
      row.scope,
      row.canonical_project_path,
      row.tool_name,
      row.capability,
      row.command_pattern,
      row.risk_ceiling,
      row.enabled ? 1 : 0,
      row.source,
      row.created_at,
      row.updated_at,
      row.last_hit_at,
      row.hit_count,
    );
    return this.getProjectPermissionRule(row.id)!;
  }

  getProjectPermissionRule(id: string): ProjectPermissionRuleRow | null {
    return projectPermissionRuleFromSql(
      this.database.prepare('SELECT * FROM project_permission_rules WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined,
    );
  }

  listProjectPermissionRules(
    projectId: string,
    options?: PageOptions,
  ): PageResult<ProjectPermissionRuleRow> {
    const { limit, offset } = page(options);
    const rows = this.database.prepare(`
      SELECT * FROM project_permission_rules
      WHERE project_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(projectId, limit, offset) as Array<Record<string, unknown>>;
    const total = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM project_permission_rules WHERE project_id = ?
    `).get(projectId) as { count: number }).count;
    return {
      items: rows.map((row) => projectPermissionRuleFromSql(row)!),
      total,
      limit,
      offset,
    };
  }

  listEnabledProjectPermissionRules(projectId: string): ProjectPermissionRuleRow[] {
    const rows = this.database.prepare(`
      SELECT * FROM project_permission_rules
      WHERE project_id = ? AND enabled = 1
      ORDER BY created_at DESC, id DESC
    `).all(projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => projectPermissionRuleFromSql(row)!);
  }

  setProjectPermissionRuleEnabled(
    projectId: string,
    ruleId: string,
    enabled: boolean,
    updatedAt: number,
  ): ProjectPermissionRuleRow | null {
    const result = this.database.prepare(`
      UPDATE project_permission_rules
      SET enabled = ?, updated_at = ?
      WHERE project_id = ? AND id = ?
    `).run(enabled ? 1 : 0, updatedAt, projectId, ruleId);
    return result.changes === 0 ? null : this.getProjectPermissionRule(ruleId);
  }

  deleteProjectPermissionRule(projectId: string, ruleId: string): boolean {
    return this.database.prepare(`
      DELETE FROM project_permission_rules WHERE project_id = ? AND id = ?
    `).run(projectId, ruleId).changes > 0;
  }

  clearProjectPermissionRules(projectId: string): number {
    return this.database.prepare(`
      DELETE FROM project_permission_rules WHERE project_id = ?
    `).run(projectId).changes;
  }

  listModelProviderRows(input: {
    limit: number;
    offset: number;
    enabled?: boolean;
  }): {
    items: ModelProviderDatabaseRow[];
    total: number;
  } {
    const filter = input.enabled === undefined ? '' : 'WHERE enabled = ?';
    const parameters = input.enabled === undefined ? [] : [input.enabled ? 1 : 0];
    const items = this.database.prepare(`
      SELECT * FROM model_providers
      ${filter}
      ORDER BY enabled DESC, updated_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, input.limit, input.offset) as ModelProviderDatabaseRow[];
    const total = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM model_providers ${filter}
    `).get(...parameters) as { count: number }).count;
    return { items, total };
  }

  getModelProviderRow(providerId: string): ModelProviderDatabaseRow | null {
    return (this.database.prepare(`
      SELECT * FROM model_providers WHERE id = ?
    `).get(providerId) as ModelProviderDatabaseRow | undefined) ?? null;
  }

  getEnabledDefaultModelProviderRow(): ModelProviderDatabaseRow | null {
    return (this.database.prepare(`
      SELECT * FROM model_providers
      WHERE enabled = 1 AND is_default = 1
      LIMIT 1
    `).get() as ModelProviderDatabaseRow | undefined) ?? null;
  }

  insertModelProviderRow(row: ModelProviderDatabaseRow): void {
    this.database.prepare(`
      INSERT INTO model_providers (
        id, name, type, base_url, api_format, runtime_type, credential_ref,
        default_model_id, enabled, is_default, supports_claude_code,
        supports_agent_workflow, supports_tools, supports_mcp,
        supports_streaming, supports_vision, metadata_json, health_state,
        last_tested_at, last_error_type, latency_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.name,
      row.type,
      row.base_url,
      row.api_format,
      row.runtime_type,
      row.credential_ref,
      row.default_model_id,
      row.enabled,
      row.is_default,
      row.supports_claude_code,
      row.supports_agent_workflow,
      row.supports_tools,
      row.supports_mcp,
      row.supports_streaming,
      row.supports_vision,
      row.metadata_json,
      row.health_state,
      row.last_tested_at,
      row.last_error_type,
      row.latency_ms,
      row.created_at,
      row.updated_at,
    );
  }

  updateModelProviderRow(row: ModelProviderDatabaseRow): boolean {
    return this.database.prepare(`
      UPDATE model_providers SET
        name = ?, type = ?, base_url = ?, api_format = ?, runtime_type = ?,
        credential_ref = ?, default_model_id = ?, enabled = ?, is_default = ?,
        supports_claude_code = ?, supports_agent_workflow = ?, supports_tools = ?,
        supports_mcp = ?, supports_streaming = ?, supports_vision = ?,
        metadata_json = ?, health_state = ?, last_tested_at = ?,
        last_error_type = ?, latency_ms = ?, created_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      row.name,
      row.type,
      row.base_url,
      row.api_format,
      row.runtime_type,
      row.credential_ref,
      row.default_model_id,
      row.enabled,
      row.is_default,
      row.supports_claude_code,
      row.supports_agent_workflow,
      row.supports_tools,
      row.supports_mcp,
      row.supports_streaming,
      row.supports_vision,
      row.metadata_json,
      row.health_state,
      row.last_tested_at,
      row.last_error_type,
      row.latency_ms,
      row.created_at,
      row.updated_at,
      row.id,
    ).changes > 0;
  }

  updateModelProviderRowIfCurrent(
    row: ModelProviderDatabaseRow,
    expected: ModelProviderDatabaseRow,
  ): boolean {
    return this.database.prepare(`
      UPDATE model_providers SET
        name = ?, type = ?, base_url = ?, api_format = ?, runtime_type = ?,
        credential_ref = ?, default_model_id = ?, enabled = ?, is_default = ?,
        supports_claude_code = ?, supports_agent_workflow = ?, supports_tools = ?,
        supports_mcp = ?, supports_streaming = ?, supports_vision = ?,
        metadata_json = ?, health_state = ?, last_tested_at = ?,
        last_error_type = ?, latency_ms = ?, created_at = ?, updated_at = ?
      WHERE id IS ?
        AND name IS ? AND type IS ? AND base_url IS ? AND api_format IS ?
        AND runtime_type IS ? AND credential_ref IS ? AND default_model_id IS ?
        AND enabled IS ? AND is_default IS ? AND supports_claude_code IS ?
        AND supports_agent_workflow IS ? AND supports_tools IS ?
        AND supports_mcp IS ? AND supports_streaming IS ? AND supports_vision IS ?
        AND metadata_json IS ? AND health_state IS ? AND last_tested_at IS ?
        AND last_error_type IS ? AND latency_ms IS ? AND created_at IS ?
        AND updated_at IS ?
    `).run(
      row.name,
      row.type,
      row.base_url,
      row.api_format,
      row.runtime_type,
      row.credential_ref,
      row.default_model_id,
      row.enabled,
      row.is_default,
      row.supports_claude_code,
      row.supports_agent_workflow,
      row.supports_tools,
      row.supports_mcp,
      row.supports_streaming,
      row.supports_vision,
      row.metadata_json,
      row.health_state,
      row.last_tested_at,
      row.last_error_type,
      row.latency_ms,
      row.created_at,
      row.updated_at,
      expected.id,
      expected.name,
      expected.type,
      expected.base_url,
      expected.api_format,
      expected.runtime_type,
      expected.credential_ref,
      expected.default_model_id,
      expected.enabled,
      expected.is_default,
      expected.supports_claude_code,
      expected.supports_agent_workflow,
      expected.supports_tools,
      expected.supports_mcp,
      expected.supports_streaming,
      expected.supports_vision,
      expected.metadata_json,
      expected.health_state,
      expected.last_tested_at,
      expected.last_error_type,
      expected.latency_ms,
      expected.created_at,
      expected.updated_at,
    ).changes > 0;
  }

  updateModelProviderHealthRow(
    providerId: string,
    health: Pick<ModelProviderDatabaseRow,
      'health_state' | 'last_tested_at' | 'last_error_type' | 'latency_ms'>,
  ): boolean {
    return this.database.prepare(`
      UPDATE model_providers SET
        health_state = ?, last_tested_at = ?, last_error_type = ?, latency_ms = ?
      WHERE id = ?
    `).run(
      health.health_state,
      health.last_tested_at,
      health.last_error_type,
      health.latency_ms,
      providerId,
    ).changes > 0;
  }

  clearDefaultModelProviderRows(exceptProviderId: string): void {
    this.database.prepare(`
      UPDATE model_providers SET is_default = 0
      WHERE is_default = 1 AND id <> ?
    `).run(exceptProviderId);
  }

  setModelProviderDefaultRow(providerId: string, updatedAt: number): boolean {
    return this.database.prepare(`
      UPDATE model_providers SET is_default = 1, updated_at = ?
      WHERE id = ? AND enabled = 1
    `).run(updatedAt, providerId).changes > 0;
  }

  disableModelProviderForDeletion(providerId: string, updatedAt: number): boolean {
    return this.database.prepare(`
      UPDATE model_providers
      SET enabled = 0, is_default = 0, updated_at = MAX(updated_at, ?)
      WHERE id = ?
    `).run(updatedAt, providerId).changes > 0;
  }

  deleteModelProviderRow(providerId: string): boolean {
    return this.database.prepare(`
      DELETE FROM model_providers WHERE id = ?
    `).run(providerId).changes > 0;
  }

  listModelProviderModelRows(providerId: string): ModelProviderModelDatabaseRow[] {
    return this.database.prepare(`
      SELECT * FROM model_provider_models
      WHERE provider_id = ?
      ORDER BY source ASC, model_id ASC
    `).all(providerId) as ModelProviderModelDatabaseRow[];
  }

  upsertModelProviderModelRow(row: ModelProviderModelDatabaseRow): void {
    this.database.prepare(`
      INSERT INTO model_provider_models
        (provider_id, model_id, display_name, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, model_id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, model_provider_models.display_name),
        source = CASE
          WHEN model_provider_models.source = 'manual' THEN 'manual'
          ELSE excluded.source
        END,
        updated_at = MAX(model_provider_models.updated_at, excluded.updated_at)
    `).run(
      row.provider_id,
      row.model_id,
      row.display_name,
      row.source,
      row.created_at,
      row.updated_at,
    );
  }

  deleteModelProviderModelsExcept(providerId: string, modelIds: readonly string[]): void {
    if (modelIds.length === 0) {
      this.database.prepare(`
        DELETE FROM model_provider_models WHERE provider_id = ?
      `).run(providerId);
      return;
    }
    const placeholders = modelIds.map(() => '?').join(', ');
    this.database.prepare(`
      DELETE FROM model_provider_models
      WHERE provider_id = ? AND model_id NOT IN (${placeholders})
    `).run(providerId, ...modelIds);
  }

  deleteUnreferencedDiscoveredModelProviderModelRow(
    providerId: string,
    modelId: string,
  ): boolean {
    return this.database.prepare(`
      DELETE FROM model_provider_models
      WHERE provider_id = ?
        AND model_id = ?
        AND source = 'discovered'
        AND NOT EXISTS (
          SELECT 1 FROM model_providers
          WHERE id = model_provider_models.provider_id
            AND default_model_id = model_provider_models.model_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM agent_model_policy
          WHERE provider_id = model_provider_models.provider_id
            AND model_id = model_provider_models.model_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM project_model_policy
          WHERE provider_id = model_provider_models.provider_id
            AND model_id = model_provider_models.model_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_model_overrides
          WHERE provider_id = model_provider_models.provider_id
            AND model_id = model_provider_models.model_id
        )
    `).run(providerId, modelId).changes > 0;
  }

  getCredentialCleanupRow(jobId: string): CredentialCleanupDatabaseRow | null {
    return (this.database.prepare(`
      SELECT * FROM credential_cleanup_jobs WHERE id = ?
    `).get(jobId) as CredentialCleanupDatabaseRow | undefined) ?? null;
  }

  listCredentialCleanupRows(): CredentialCleanupDatabaseRow[] {
    return this.database.prepare(`
      SELECT * FROM credential_cleanup_jobs
      ORDER BY created_at ASC, id ASC
    `).all() as CredentialCleanupDatabaseRow[];
  }

  insertCredentialCleanupRow(row: CredentialCleanupDatabaseRow): void {
    this.database.prepare(`
      INSERT INTO credential_cleanup_jobs (
        id, provider_id, credential_ref, attempts, next_attempt_at,
        last_attempt_at, last_error_type, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.provider_id,
      row.credential_ref,
      row.attempts,
      row.next_attempt_at,
      row.last_attempt_at,
      row.last_error_type,
      row.created_at,
      row.updated_at,
    );
  }

  updateCredentialCleanupFailureRow(input: {
    jobId: string;
    attempts: number;
    nextAttemptAt: number;
    lastAttemptAt: number;
    lastErrorType: CredentialCleanupErrorType;
    updatedAt: number;
  }): boolean {
    return this.database.prepare(`
      UPDATE credential_cleanup_jobs SET
        attempts = ?, next_attempt_at = ?, last_attempt_at = ?,
        last_error_type = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.attempts,
      input.nextAttemptAt,
      input.lastAttemptAt,
      input.lastErrorType,
      input.updatedAt,
      input.jobId,
    ).changes > 0;
  }

  deleteCredentialCleanupRow(jobId: string): boolean {
    return this.database.prepare(`
      DELETE FROM credential_cleanup_jobs WHERE id = ?
    `).run(jobId).changes > 0;
  }

  upsertModelTierBindingRow(row: ModelTierBindingDatabaseRow): void {
    this.database.prepare(`
      INSERT INTO model_tier_bindings (
        tier, provider_id, model_id, display_name, quality, speed, cost, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tier) DO UPDATE SET
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        display_name = excluded.display_name,
        quality = excluded.quality,
        speed = excluded.speed,
        cost = excluded.cost,
        updated_at = excluded.updated_at
    `).run(
      row.tier,
      row.provider_id,
      row.model_id,
      row.display_name,
      row.quality,
      row.speed,
      row.cost,
      row.updated_at,
    );
  }

  getModelTierBindingRow(tier: ModelTier): ModelTierBindingDatabaseRow | null {
    return (this.database.prepare(`
      SELECT * FROM model_tier_bindings WHERE tier = ?
    `).get(tier) as ModelTierBindingDatabaseRow | undefined) ?? null;
  }

  listModelTierBindingRows(): ModelTierBindingDatabaseRow[] {
    return this.database.prepare(`
      SELECT * FROM model_tier_bindings ORDER BY tier ASC
    `).all() as ModelTierBindingDatabaseRow[];
  }

  deleteModelTierBindingRow(tier: ModelTier): boolean {
    return this.database.prepare(`
      DELETE FROM model_tier_bindings WHERE tier = ?
    `).run(tier).changes > 0;
  }

  upsertProjectModelTierBindingRow(row: ProjectModelTierBindingDatabaseRow): void {
    this.database.prepare(`
      INSERT INTO project_model_tier_bindings (
        project_id, tier, provider_id, model_id, display_name, quality, speed, cost, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, tier) DO UPDATE SET
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        display_name = excluded.display_name,
        quality = excluded.quality,
        speed = excluded.speed,
        cost = excluded.cost,
        updated_at = excluded.updated_at
    `).run(
      row.project_id,
      row.tier,
      row.provider_id,
      row.model_id,
      row.display_name,
      row.quality,
      row.speed,
      row.cost,
      row.updated_at,
    );
  }

  getProjectModelTierBindingRow(
    projectId: string,
    tier: ModelTier,
  ): ProjectModelTierBindingDatabaseRow | null {
    return (this.database.prepare(`
      SELECT * FROM project_model_tier_bindings WHERE project_id = ? AND tier = ?
    `).get(projectId, tier) as ProjectModelTierBindingDatabaseRow | undefined) ?? null;
  }

  listProjectModelTierBindingRows(projectId: string): ProjectModelTierBindingDatabaseRow[] {
    return this.database.prepare(`
      SELECT * FROM project_model_tier_bindings
      WHERE project_id = ?
      ORDER BY tier ASC
    `).all(projectId) as ProjectModelTierBindingDatabaseRow[];
  }

  deleteProjectModelTierBindingRow(projectId: string, tier: ModelTier): boolean {
    return this.database.prepare(`
      DELETE FROM project_model_tier_bindings WHERE project_id = ? AND tier = ?
    `).run(projectId, tier).changes > 0;
  }

  setAgentModelPolicyRow(row: AgentModelPolicyDatabaseRow): void {
    this.database.prepare(`
      INSERT INTO agent_model_policy (
        agent_type, provider_id, model_id, tier, quality, speed, cost, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_type) DO UPDATE SET
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        tier = excluded.tier,
        quality = excluded.quality,
        speed = excluded.speed,
        cost = excluded.cost,
        updated_at = excluded.updated_at
    `).run(
      row.agent_type,
      row.provider_id,
      row.model_id,
      row.tier,
      row.quality,
      row.speed,
      row.cost,
      row.created_at,
      row.updated_at,
    );
  }

  getAgentModelPolicyRow(agentType: ModelPolicyAgentType): AgentModelPolicyDatabaseRow | null {
    return (this.database.prepare(`
      SELECT * FROM agent_model_policy WHERE agent_type = ?
    `).get(agentType) as AgentModelPolicyDatabaseRow | undefined) ?? null;
  }

  listAgentModelPolicyRows(): AgentModelPolicyDatabaseRow[] {
    return this.database.prepare(`
      SELECT * FROM agent_model_policy ORDER BY agent_type ASC
    `).all() as AgentModelPolicyDatabaseRow[];
  }

  deleteAgentModelPolicyRow(agentType: ModelPolicyAgentType): boolean {
    return this.database.prepare(`
      DELETE FROM agent_model_policy WHERE agent_type = ?
    `).run(agentType).changes > 0;
  }

  setProjectModelPolicyRow(row: ProjectModelPolicyDatabaseRow): void {
    this.database.prepare(`
      INSERT INTO project_model_policy (
        project_id, agent_type, provider_id, model_id, tier, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, agent_type) DO UPDATE SET
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        tier = excluded.tier,
        updated_at = excluded.updated_at
    `).run(
      row.project_id,
      row.agent_type,
      row.provider_id,
      row.model_id,
      row.tier,
      row.created_at,
      row.updated_at,
    );
  }

  getProjectModelPolicyRow(
    projectId: string,
    agentType: ProjectModelPolicyAgentType,
  ): ProjectModelPolicyDatabaseRow | null {
    return (this.database.prepare(`
      SELECT * FROM project_model_policy WHERE project_id = ? AND agent_type = ?
    `).get(projectId, agentType) as ProjectModelPolicyDatabaseRow | undefined) ?? null;
  }

  listProjectModelPolicyRows(projectId: string): ProjectModelPolicyDatabaseRow[] {
    return this.database.prepare(`
      SELECT * FROM project_model_policy
      WHERE project_id = ?
      ORDER BY agent_type ASC
    `).all(projectId) as ProjectModelPolicyDatabaseRow[];
  }

  deleteProjectModelPolicyRow(projectId: string, agentType: ProjectModelPolicyAgentType): boolean {
    return this.database.prepare(`
      DELETE FROM project_model_policy WHERE project_id = ? AND agent_type = ?
    `).run(projectId, agentType).changes > 0;
  }

  setTaskModelOverrideRow(row: TaskModelOverrideDatabaseRow): void {
    this.database.prepare(`
      INSERT INTO task_model_overrides
        (task_id, provider_id, model_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        updated_at = excluded.updated_at
    `).run(
      row.task_id,
      row.provider_id,
      row.model_id,
      row.created_at,
      row.updated_at,
    );
  }

  getTaskModelOverrideRow(taskId: string): TaskModelOverrideDatabaseRow | null {
    return (this.database.prepare(`
      SELECT * FROM task_model_overrides WHERE task_id = ?
    `).get(taskId) as TaskModelOverrideDatabaseRow | undefined) ?? null;
  }

  deleteTaskModelOverrideRow(taskId: string): boolean {
    return this.database.prepare(`
      DELETE FROM task_model_overrides WHERE task_id = ?
    `).run(taskId).changes > 0;
  }

  recordProjectPermissionRuleHit(
    ruleId: string,
    hitAt: number,
  ): ProjectPermissionRuleRow | null {
    const result = this.database.prepare(`
      UPDATE project_permission_rules
      SET last_hit_at = ?, hit_count = hit_count + 1
      WHERE id = ?
    `).run(hitAt, ruleId);
    return result.changes === 0 ? null : this.getProjectPermissionRule(ruleId);
  }

  getProjectSettings(projectId: string): ProjectSettingsRow | null {
    return projectSettingsFromSql(
      this.database.prepare('SELECT * FROM project_settings WHERE project_id = ?')
        .get(projectId) as Record<string, unknown> | undefined,
    );
  }

  setProjectSettings(
    projectId: string,
    patch: Partial<Omit<ProjectSettingsRow, 'project_id' | 'updated_at'>>,
  ): ProjectSettingsRow {
    const current = this.getProjectSettings(projectId) ?? {
      project_id: projectId,
      display_name: null,
      default_model: null,
      default_permission: null,
      agent_mode: 'normal',
      favorite: false,
      disabled_mcp_servers: [],
      updated_at: nowIso(),
    };
    const next = { ...current, ...patch, project_id: projectId, updated_at: nowIso() };
    this.database.prepare(`
      INSERT INTO project_settings
        (project_id, display_name, default_model, default_permission, agent_mode, favorite, disabled_mcp_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        display_name = excluded.display_name,
        default_model = excluded.default_model,
        default_permission = excluded.default_permission,
        agent_mode = excluded.agent_mode,
        favorite = excluded.favorite,
        disabled_mcp_json = excluded.disabled_mcp_json,
        updated_at = excluded.updated_at
    `).run(
      projectId,
      next.display_name,
      next.default_model,
      next.default_permission,
      next.agent_mode,
      next.favorite ? 1 : 0,
      JSON.stringify(next.disabled_mcp_servers),
      next.updated_at,
    );
    if (next.display_name?.trim()) this.updateProjectName(projectId, next.display_name.trim());
    return next;
  }

  getSetting(key: string): string | null {
    return (this.database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  getAllSettings(): Record<string, string> {
    const rows = this.database.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  close(): void {
    if (this.database.open) this.database.close();
  }
}
