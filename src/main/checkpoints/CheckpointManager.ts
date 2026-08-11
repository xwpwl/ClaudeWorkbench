import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AcceptChangesResult,
  Checkpoint,
  CheckpointChangedEvent,
  CheckpointFile,
  CheckpointMetadata,
  CheckpointType,
  CommitTaskResult,
  RestoreImpact,
  RestoreResult,
} from '../../shared/types/checkpoint';
import type { ClaudeEventEnvelope, ClaudeRunOptions } from '../../shared/types/claude';
import type { CommitPreview, GitStatus, GitStatusFile } from '../../shared/types/git';
import type {
  AppDatabase,
  CheckpointFileRow,
  CheckpointRow,
} from '../database/Database';
import { GitRunner } from '../file-changes/GitRunner';
import { SafePathPolicy } from '../file-changes/SafePathPolicy';
import {
  FileMutationManager,
  FileMutationRollbackError,
  type FileMutationContext,
} from '../file-mutations/FileMutationManager';
import { CommitPreviewService } from '../git/CommitPreviewService';
import { GitWorkspaceService } from '../git/GitWorkspaceService';

const ABSENT_HASH = 'absent';
const UNKNOWN_BASELINE_MODIFIED_AT = '0001-01-01T00:00:00.000Z';
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_TOTAL_BYTES = 256 * 1024 * 1024;
const MUTATION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const TEST_COMMAND = /(^|\s)(npm\s+(run\s+)?test|npx\s+vitest|vitest|jest|pytest|cargo\s+test|go\s+test)(\s|$)/i;

interface CreateContext {
  runId?: string;
  title?: string;
  touchedFiles?: readonly string[];
  reason?: string;
}

interface RestoreGrant {
  checkpointId: string;
  expiresAt: number;
  fingerprint: string;
  repository: RepositoryIdentity;
  impact: Omit<RestoreImpact, 'confirmationToken' | 'expiresAt'>;
}

interface CommitGrant {
  preview: CommitPreview;
  fingerprint: string;
  repository: RepositoryIdentity;
}

interface RepositoryIdentity {
  head: string | null;
  branch: string | null;
  detached: boolean;
}

interface CommitPreviewSnapshot {
  preview: CommitPreview;
  repository: RepositoryIdentity;
}

interface CheckpointManagerOptions {
  git?: GitWorkspaceService;
  runner?: GitRunner;
  paths?: SafePathPolicy;
  mutations?: FileMutationManager;
  preview?: CommitPreviewService;
  now?: () => Date;
  randomUUID?: () => string;
  tokenTtlMs?: number;
  maxSnapshotFileBytes?: number;
  maxSnapshotTotalBytes?: number;
}

interface StoredCheckpointFile extends CheckpointFile {
  snapshotFile: string | null;
}

interface StoredCheckpoint extends Omit<Checkpoint, 'files'> {
  snapshotPath: string;
  files: StoredCheckpointFile[];
}

export class CheckpointError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_FOUND'
      | 'PROJECT_MISMATCH'
      | 'SNAPSHOT_LIMIT'
      | 'UNSAFE_FILE'
      | 'RESTORE_BLOCKED'
      | 'CONFIRMATION_REQUIRED'
      | 'STALE_CONFIRMATION'
      | 'TASK_ACTIVE'
      | 'COMMIT_FAILED',
  ) {
    super(message);
    this.name = 'CheckpointError';
  }
}

function sessionIdFromKey(sessionKey: string): string {
  const separator = sessionKey.lastIndexOf('::');
  return separator >= 0 ? sessionKey.slice(separator + 2) : sessionKey;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function syntheticStatus(filePath: string): GitStatusFile {
  return {
    filePath,
    changeType: 'modified',
    statusCode: '  ',
    staged: false,
    unstaged: false,
    untracked: false,
    additions: 0,
    deletions: 0,
    statsAvailable: false,
    isBinary: false,
  };
}

function isGitIgnorePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/').toLocaleLowerCase();
  return normalized === '.gitignore' || normalized.endsWith('/.gitignore');
}

function hasGitIgnoreChange(files: readonly GitStatusFile[]): boolean {
  return files.some((file) => (
    isGitIgnorePath(file.filePath)
    || Boolean(file.originalPath && isGitIgnorePath(file.originalPath))
  ));
}

const WORKFLOW_RESTORE_BOUNDARIES = new Set<CheckpointType>([
  'before_task',
  'before_plan',
  'before_execute',
  'before_review',
  'before_fix',
]);

function usesDynamicRestoreScope(type: CheckpointType): boolean {
  return WORKFLOW_RESTORE_BOUNDARIES.has(type);
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

function repositoryIdentity(status: GitStatus): RepositoryIdentity {
  return {
    head: status.head,
    branch: status.branch,
    detached: status.detached,
  };
}

function sameRepositoryIdentity(
  left: RepositoryIdentity,
  right: RepositoryIdentity,
): boolean {
  return left.head === right.head
    && left.branch === right.branch
    && left.detached === right.detached;
}

function snapshotName(filePath: string): string {
  return crypto.createHash('sha256').update(filePath).digest('hex');
}

function metadataFromJson(value: string): CheckpointMetadata {
  try {
    const parsed = JSON.parse(value) as Partial<CheckpointMetadata>;
    return {
      runId: typeof parsed.runId === 'string' ? parsed.runId : undefined,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      branch: typeof parsed.branch === 'string' ? parsed.branch : null,
      baselineFiles: Array.isArray(parsed.baselineFiles) ? parsed.baselineFiles : [],
      touchedFiles: Array.isArray(parsed.touchedFiles)
        ? parsed.touchedFiles.filter((item): item is string => typeof item === 'string')
        : [],
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch {
    return { branch: null, baselineFiles: [], touchedFiles: [] };
  }
}

function toolFilePath(event: ClaudeEventEnvelope['event']): string | null {
  if (event.type === 'file_changed') return event.filePath;
  if (event.type !== 'tool_started' || !MUTATION_TOOLS.has(event.toolName)) return null;
  if (!event.input || typeof event.input !== 'object') return null;
  const input = event.input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'notebook_path']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key] as string;
  }
  return null;
}

function testCommand(event: ClaudeEventEnvelope['event']): string | null {
  if (event.type === 'command_started') return TEST_COMMAND.test(event.command) ? event.command : null;
  if (event.type !== 'tool_started' || event.toolName !== 'Bash') return null;
  if (!event.input || typeof event.input !== 'object') return null;
  const command = (event.input as Record<string, unknown>).command;
  return typeof command === 'string' && TEST_COMMAND.test(command) ? command : null;
}

export class CheckpointManager {
  private readonly git: GitWorkspaceService;
  private readonly runner: GitRunner;
  private readonly paths: SafePathPolicy;
  private readonly mutations: FileMutationManager;
  private readonly preview: CommitPreviewService;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly tokenTtlMs: number;
  private readonly maxSnapshotFileBytes: number;
  private readonly maxSnapshotTotalBytes: number;
  private readonly snapshotRoot: string;
  private readonly touchedByTask = new Map<string, Set<string>>();
  private readonly baselineObservationQueues = new Map<string, Promise<void>>();
  private readonly latestRunByTask = new Map<string, string>();
  private readonly restoreGrants = new Map<string, RestoreGrant>();
  private readonly commitGrants = new Map<string, CommitGrant>();
  private readonly listeners = new Set<(event: CheckpointChangedEvent) => void>();

  constructor(
    private readonly database: AppDatabase,
    snapshotRoot: string,
    options: CheckpointManagerOptions = {},
  ) {
    this.snapshotRoot = path.resolve(snapshotRoot);
    this.git = options.git ?? new GitWorkspaceService();
    this.runner = options.runner ?? new GitRunner();
    this.paths = options.paths ?? new SafePathPolicy();
    this.mutations = options.mutations ?? new FileMutationManager({ paths: this.paths });
    this.preview = options.preview ?? new CommitPreviewService();
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.maxSnapshotFileBytes = options.maxSnapshotFileBytes ?? DEFAULT_MAX_SNAPSHOT_FILE_BYTES;
    this.maxSnapshotTotalBytes = options.maxSnapshotTotalBytes ?? DEFAULT_MAX_SNAPSHOT_TOTAL_BYTES;
  }

  subscribe(listener: (event: CheckpointChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startTask(options: ClaudeRunOptions): Promise<Checkpoint | null> {
    const taskId = sessionIdFromKey(options.sessionKey);
    const session = this.database.getSession(taskId);
    if (!session) throw new CheckpointError('Task session was not found.', 'NOT_FOUND');
    const project = this.database.getProject(session.project_id);
    if (!project) throw new CheckpointError('Task project was not found.', 'NOT_FOUND');
    const [registeredRoot, requestedRoot] = await Promise.all([
      this.paths.resolveProjectRoot(project.path),
      this.paths.resolveProjectRoot(options.projectPath),
    ]);
    if (registeredRoot !== requestedRoot) {
      throw new CheckpointError('Run project does not match the registered task project.', 'PROJECT_MISMATCH');
    }
    this.database.ensureTask(taskId, project.id, 'starting', options.agentMode ?? 'normal');
    this.touchedByTask.set(taskId, new Set());
    this.latestRunByTask.set(taskId, options.runId);
    this.commitGrants.delete(taskId);
    return this.createCheckpoint(registeredRoot, taskId, 'before_task', {
      runId: options.runId,
      title: session.title,
    });
  }

  async beginWorkflow(taskId: string, workflowId: string): Promise<Checkpoint> {
    const existing = this.listCheckpoints(taskId).find((checkpoint) => (
      checkpoint.type === 'before_task' && checkpoint.metadata.runId === workflowId
    ));
    if (existing) {
      this.latestRunByTask.set(taskId, workflowId);
      this.touchedByTask.set(taskId, new Set(
        this.listCheckpoints(taskId)
          .filter((checkpoint) => checkpoint.metadata.runId === workflowId)
          .flatMap((checkpoint) => checkpoint.metadata.touchedFiles),
      ));
      return existing;
    }
    const { projectPath, title } = this.taskProject(taskId);
    this.touchedByTask.set(taskId, new Set());
    this.latestRunByTask.set(taskId, workflowId);
    this.commitGrants.delete(taskId);
    return this.createCheckpoint(projectPath, taskId, 'before_task', {
      runId: workflowId,
      title,
      reason: 'workflow_baseline',
    });
  }

  async prepareWorkflowRun(options: ClaudeRunOptions): Promise<Checkpoint> {
    const workflowId = options.workflowContext?.workflowId;
    if (!workflowId) throw new CheckpointError('Workflow context is missing.', 'NOT_FOUND');
    const taskId = sessionIdFromKey(options.sessionKey);
    const session = this.database.getSession(taskId);
    const project = session ? this.database.getProject(session.project_id) : null;
    if (!session || !project) throw new CheckpointError('Task project was not found.', 'NOT_FOUND');
    const [registeredRoot, requestedRoot] = await Promise.all([
      this.paths.resolveProjectRoot(project.path),
      this.paths.resolveProjectRoot(options.projectPath),
    ]);
    if (registeredRoot !== requestedRoot) {
      throw new CheckpointError('Run project does not match the registered task project.', 'PROJECT_MISMATCH');
    }
    return this.beginWorkflow(taskId, workflowId);
  }

  async noteTaskFile(
    taskId: string,
    projectPath: string,
    requestedPath: string,
  ): Promise<string> {
    const resolved = await this.paths.resolveFile(projectPath, requestedPath);
    const touched = this.touchedByTask.get(taskId) ?? new Set<string>();
    touched.add(resolved.gitPath);
    this.touchedByTask.set(taskId, touched);
    await this.queueTaskStartObservation(
      taskId,
      resolved.projectRoot,
      resolved.gitPath,
    );
    return resolved.gitPath;
  }

  async createTaskCheckpoint(
    taskId: string,
    type: CheckpointType,
    context: CreateContext = {},
  ): Promise<Checkpoint> {
    const { projectPath, title } = this.taskProject(taskId);
    const runId = context.runId ?? this.latestRunId(taskId);
    if (runId) this.latestRunByTask.set(taskId, runId);
    return this.createCheckpoint(projectPath, taskId, type, {
      ...context,
      runId,
      title: context.title ?? title,
      touchedFiles: context.touchedFiles ?? [...(this.touchedByTask.get(taskId) ?? [])],
    });
  }

  async createCheckpoint(
    projectPath: string,
    taskId: string,
    type: CheckpointType,
    context: CreateContext = {},
  ): Promise<Checkpoint> {
    const root = await this.paths.resolveProjectRoot(projectPath);
    if (context.runId) this.latestRunByTask.set(taskId, context.runId);
    const status = await this.git.getStatus(root);
    const touchedSet = new Set(context.touchedFiles ?? []);
    if (type !== 'before_task') {
      const detectedPaths = await this.detectChangesSinceTaskStart(
        taskId,
        context.runId,
        root,
        status.files,
      );
      for (const filePath of detectedPaths) touchedSet.add(filePath);
    }
    const id = this.randomUUID();
    const createdAt = this.now().toISOString();
    const snapshotPath = path.resolve(this.snapshotRoot, id);
    if (!isContainedPath(this.snapshotRoot, snapshotPath) || samePath(snapshotPath, this.snapshotRoot)) {
      throw new CheckpointError('Checkpoint storage path is unsafe.', 'UNSAFE_FILE');
    }
    const filesPath = path.join(snapshotPath, 'files');
    await fs.mkdir(filesPath, { recursive: true });

    for (const file of status.files) {
      if (touchedSet.has(file.filePath) && file.originalPath) touchedSet.add(file.originalPath);
    }
    const touchedFiles = uniqueSorted([...touchedSet]);
    const captureByPath = new Map(status.files.map((file) => [file.filePath, file] as const));
    for (const filePath of type === 'before_task' ? [] : touchedFiles) {
      if (captureByPath.has(filePath)) continue;
      const trackedAtHead = status.head
        ? await this.runner.succeeds(root, [
          '--no-pager',
          'cat-file',
          '-e',
          `${status.head}:${filePath}`,
        ])
        : false;
      if (!trackedAtHead) captureByPath.set(filePath, syntheticStatus(filePath));
    }
    const captureFiles = [...captureByPath.values()]
      .sort((left, right) => left.filePath.localeCompare(right.filePath));
    const metadata: CheckpointMetadata = {
      runId: context.runId,
      title: context.title,
      branch: status.branch,
      baselineFiles: captureFiles,
      touchedFiles,
      reason: context.reason,
    };
    const fileRows: CheckpointFileRow[] = [];
    let totalBytes = 0;
    try {
      for (const file of captureFiles) {
        const captured = await this.captureFile(root, filesPath, id, file, createdAt);
        totalBytes += captured.size;
        if (totalBytes > this.maxSnapshotTotalBytes) {
          throw new CheckpointError('Checkpoint exceeds the total snapshot safety limit.', 'SNAPSHOT_LIMIT');
        }
        fileRows.push(captured);
      }
      const row: CheckpointRow = {
        id,
        task_id: taskId,
        project_path: root,
        type,
        created_at: createdAt,
        git_commit: status.head,
        snapshot_path: snapshotPath,
        metadata_json: JSON.stringify(metadata),
      };
      await fs.writeFile(
        path.join(snapshotPath, 'manifest.json'),
        `${JSON.stringify({ ...row, metadata, files: fileRows }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      this.database.createCheckpoint(row, fileRows);
    } catch (error) {
      await fs.rm(snapshotPath, { recursive: true, force: true });
      throw error;
    }

    const checkpoint = this.requireStoredCheckpoint(id);
    this.persistTimelineEvent(taskId, context.runId, 'git_checkpoint_created', {
      checkpointId: id,
      checkpointType: type,
      files: usesDynamicRestoreScope(type)
        ? checkpoint.metadata.baselineFiles.map((file) => file.filePath)
        : checkpoint.metadata.touchedFiles,
    });
    this.emit({
      taskId,
      projectPath: root,
      action: 'created',
      checkpointId: id,
      timestamp: this.now().getTime(),
    });
    return this.publicCheckpoint(checkpoint);
  }

  listCheckpoints(taskId: string): Checkpoint[] {
    return this.database.listCheckpoints(taskId)
      .map((row) => this.publicCheckpoint(this.checkpointFromRow(row)));
  }

  getCheckpoint(id: string): Checkpoint | null {
    const row = this.database.getCheckpoint(id);
    return row ? this.publicCheckpoint(this.checkpointFromRow(row)) : null;
  }

  async createCommitPreview(taskId: string): Promise<CommitPreview> {
    const snapshot = await this.buildCommitPreview(taskId);
    const { preview } = snapshot;
    const { projectPath } = this.taskProject(taskId);
    const fingerprint = await this.restoreFingerprint(projectPath, preview.files);
    this.commitGrants.set(taskId, {
      preview,
      fingerprint,
      repository: snapshot.repository,
    });
    return preview;
  }

  private async buildCommitPreview(taskId: string): Promise<CommitPreviewSnapshot> {
    const { projectPath, title } = this.taskProject(taskId);
    const runId = this.latestRunId(taskId);
    const [status, touchedFiles, events] = await Promise.all([
      this.git.getStatus(projectPath),
      this.collectTouchedFiles(taskId, projectPath, runId),
      Promise.resolve(this.database.listEvents(taskId, { limit: 5_000, offset: 0 })),
    ]);
    const touched = new Set(touchedFiles);
    return {
      preview: this.preview.createPreview({
        taskTitle: title,
        files: status.files.filter((file) => touched.has(file.filePath)),
        timeline: events.map((event) => ({ eventType: event.event_type })),
      }),
      repository: repositoryIdentity(status),
    };
  }

  async acceptTaskChanges(taskId: string): Promise<AcceptChangesResult> {
    const task = this.database.getTask(taskId);
    if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) {
      throw new CheckpointError('Task changes can only be accepted after the task stops.', 'TASK_ACTIVE');
    }
    const { projectPath } = this.taskProject(taskId);
    const touchedFiles = await this.collectTouchedFiles(taskId, projectPath, this.latestRunId(taskId));
    const checkpoint = await this.createTaskCheckpoint(taskId, 'accepted', {
      touchedFiles,
      reason: 'user_accepted',
    });
    const preview = await this.createCommitPreview(taskId);
    this.persistTimelineEvent(taskId, checkpoint.metadata.runId, 'git_changes_accepted', {
      checkpointId: checkpoint.id,
      files: preview.files,
    });
    this.emit({
      taskId,
      projectPath,
      action: 'accepted',
      checkpointId: checkpoint.id,
      timestamp: this.now().getTime(),
    });
    return { checkpoint, preview };
  }

  async previewRestore(checkpointId: string): Promise<RestoreImpact> {
    this.purgeExpiredGrants();
    const checkpoint = this.requireStoredCheckpoint(checkpointId);
    const touchedFiles = usesDynamicRestoreScope(checkpoint.type)
      ? await this.collectTouchedFiles(
        checkpoint.taskId,
        checkpoint.projectPath,
        checkpoint.metadata.runId,
      )
      : uniqueSorted(checkpoint.metadata.touchedFiles.length > 0
        ? checkpoint.metadata.touchedFiles
        : checkpoint.files.map((file) => file.filePath));
    const currentStatus = await this.git.getStatus(checkpoint.projectPath);
    const currentByPath = new Map<string, GitStatusFile>();
    for (const file of currentStatus.files) {
      currentByPath.set(file.filePath, file);
      if (file.originalPath) currentByPath.set(file.originalPath, file);
    }
    const restoreFiles: string[] = [];
    const deleteFiles: string[] = [];
    const blockedFiles: Array<{ filePath: string; reason: string }> = [];

    for (const filePath of touchedFiles) {
      try {
        await this.paths.resolveFile(checkpoint.projectPath, filePath);
      } catch {
        blockedFiles.push({ filePath, reason: '路径不在项目工作区内' });
        continue;
      }
      const current = currentByPath.get(filePath);
      if (current?.changeType === 'unmerged') {
        blockedFiles.push({ filePath, reason: '文件存在 Git 冲突' });
        continue;
      }
      if (current?.staged) {
        blockedFiles.push({ filePath, reason: '该文件位于暂存区，请先处理 staged 修改' });
        continue;
      }
      const target = await this.targetKind(checkpoint, filePath);
      if (target === 'unavailable') {
        blockedFiles.push({ filePath, reason: '检查点中没有可安全恢复的文件内容' });
      } else if (target === 'absent') {
        deleteFiles.push(filePath);
      } else {
        restoreFiles.push(filePath);
      }
    }

    const touched = new Set(touchedFiles);
    const preservedUserFiles = uniqueSorted(
      checkpoint.metadata.baselineFiles
        .map((file) => file.filePath)
        .filter((filePath) => !touched.has(filePath)),
    );
    const impactBase = {
      checkpointId,
      taskId: checkpoint.taskId,
      restoreFiles: uniqueSorted(restoreFiles),
      deleteFiles: uniqueSorted(deleteFiles),
      preservedUserFiles,
      blockedFiles,
    };
    const fingerprint = await this.restoreFingerprint(
      checkpoint.projectPath,
      [...impactBase.restoreFiles, ...impactBase.deleteFiles],
    );
    const token = this.randomUUID();
    const expiresAt = this.now().getTime() + this.tokenTtlMs;
    this.restoreGrants.set(token, {
      checkpointId,
      expiresAt,
      fingerprint,
      repository: repositoryIdentity(currentStatus),
      impact: impactBase,
    });
    return {
      ...impactBase,
      confirmationToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async restoreCheckpoint(checkpointId: string, confirmationToken: string): Promise<RestoreResult> {
    const checkpoint = this.requireStoredCheckpoint(checkpointId);
    const candidateGrant = this.restoreGrants.get(confirmationToken);
    const impacted = candidateGrant?.checkpointId === checkpointId
      ? [...candidateGrant.impact.restoreFiles, ...candidateGrant.impact.deleteFiles]
      : [];
    let verifiedGrant: RestoreGrant | null = null;
    let rollback: Checkpoint | null = null;
    let storedRollback: StoredCheckpoint | null = null;
    let rollbackPlan: { restoreFiles: string[]; deleteFiles: string[] } | null = null;

    try {
      return await this.mutations.runMutation({
        kind: 'checkpoint_restore',
        projectPath: checkpoint.projectPath,
        taskId: checkpoint.taskId,
        sessionId: checkpoint.taskId,
        ...(checkpoint.metadata.runId ? { runId: checkpoint.metadata.runId } : {}),
        filePaths: impacted,
      }, {
        verify: async () => {
          const grant = this.restoreGrants.get(confirmationToken);
          if (!grant || grant.checkpointId !== checkpointId) {
            this.restoreGrants.delete(confirmationToken);
            throw new CheckpointError(
              'Restore requires a valid confirmation preview.',
              'CONFIRMATION_REQUIRED',
            );
          }
          const task = this.database.getTask(checkpoint.taskId);
          if (
            task
            && ['starting', 'running', 'waiting_permission'].includes(task.status)
          ) {
            throw new CheckpointError(
              'An active task cannot be restored.',
              'TASK_ACTIVE',
            );
          }
          this.restoreGrants.delete(confirmationToken);
          if (grant.expiresAt < this.now().getTime()) {
            throw new CheckpointError('Restore confirmation has expired.', 'STALE_CONFIRMATION');
          }
          if (grant.impact.blockedFiles.length > 0) {
            throw new CheckpointError(
              'Restore is blocked until unsafe files are resolved.',
              'RESTORE_BLOCKED',
            );
          }
          verifiedGrant = grant;

          const currentRepository = repositoryIdentity(
            await this.git.getStatus(checkpoint.projectPath),
          );
          if (!sameRepositoryIdentity(currentRepository, grant.repository)) {
            throw new CheckpointError(
              'Git HEAD or branch changed after the restore preview. Review the impact again.',
              'STALE_CONFIRMATION',
            );
          }

          const fingerprint = await this.restoreFingerprint(checkpoint.projectPath, impacted);
          if (fingerprint !== grant.fingerprint) {
            throw new CheckpointError(
              'Files changed after the restore preview. Review the impact again.',
              'STALE_CONFIRMATION',
            );
          }

          rollback = await this.createTaskCheckpoint(checkpoint.taskId, 'manual', {
            touchedFiles: impacted,
            reason: 'before_restore',
          });
          storedRollback = this.requireStoredCheckpoint(rollback.id);
          rollbackPlan = await this.applicationPlan(storedRollback, impacted);
          const postSnapshotFingerprint = await this.restoreFingerprint(
            checkpoint.projectPath,
            impacted,
          );
          if (postSnapshotFingerprint !== grant.fingerprint) {
            throw new CheckpointError(
              'Files changed while the rollback checkpoint was created. Review the impact again.',
              'STALE_CONFIRMATION',
            );
          }
          const postSnapshotRepository = repositoryIdentity(
            await this.git.getStatus(checkpoint.projectPath),
          );
          if (!sameRepositoryIdentity(postSnapshotRepository, grant.repository)) {
            throw new CheckpointError(
              'Git HEAD or branch changed while the rollback checkpoint was created.',
              'STALE_CONFIRMATION',
            );
          }
          await this.assertRestorePathsSafe(checkpoint.projectPath, impacted);
        },
        mutate: async (context) => {
          const grant = verifiedGrant;
          const rollbackCheckpoint = rollback;
          if (!grant || !rollbackCheckpoint) {
            throw new CheckpointError('Restore verification did not complete.', 'RESTORE_BLOCKED');
          }
          await this.applyCheckpoint(
            context,
            checkpoint,
            grant.impact.restoreFiles,
            grant.impact.deleteFiles,
          );
          return {
            checkpointId,
            restoredFiles: grant.impact.restoreFiles,
            deletedFiles: grant.impact.deleteFiles,
            preservedUserFiles: grant.impact.preservedUserFiles,
            rollbackCheckpointId: rollbackCheckpoint.id,
          } satisfies RestoreResult;
        },
        rollback: async (context) => {
          const rollbackCheckpoint = storedRollback;
          const plan = rollbackPlan;
          if (!rollbackCheckpoint || !plan) {
            throw new CheckpointError('Restore rollback state is unavailable.', 'RESTORE_BLOCKED');
          }
          await this.applyCheckpoint(
            context,
            rollbackCheckpoint,
            plan.restoreFiles,
            plan.deleteFiles,
          );
        },
        record: (_context, result) => {
          this.persistTimelineEvent(
            checkpoint.taskId,
            checkpoint.metadata.runId,
            'git_restore_completed',
            {
              checkpointId,
              files: result.restoredFiles,
              deletedFiles: result.deletedFiles,
            },
          );
          this.emit({
            taskId: checkpoint.taskId,
            projectPath: checkpoint.projectPath,
            action: 'restored',
            checkpointId,
            timestamp: this.now().getTime(),
          });
        },
      });
    } catch (error) {
      if (error instanceof FileMutationRollbackError) {
        throw new CheckpointError(
          `Restore failed and rollback could not be applied: ${error.rollbackError instanceof Error ? error.rollbackError.message : String(error.rollbackError)}`,
          'RESTORE_BLOCKED',
        );
      }
      throw error;
    }
  }

  async commitTaskChanges(taskId: string, subject: string, confirmed: boolean): Promise<CommitTaskResult> {
    if (!confirmed) throw new CheckpointError('Commit requires explicit user confirmation.', 'CONFIRMATION_REQUIRED');
    const { projectPath } = this.taskProject(taskId);
    const grantedFiles = this.commitGrants.get(taskId)?.preview.files ?? [];
    return this.mutations.runMutation({
      kind: 'git_commit',
      projectPath,
      taskId,
      sessionId: taskId,
      filePaths: grantedFiles,
    }, {
      mutate: () => this.commitTaskChangesWithLease(taskId, subject, projectPath),
    });
  }

  private async commitTaskChangesWithLease(
    taskId: string,
    subject: string,
    projectPath: string,
  ): Promise<CommitTaskResult> {
    const task = this.database.getTask(taskId);
    if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) {
      throw new CheckpointError('An active task cannot be committed.', 'TASK_ACTIVE');
    }
    const grant = this.commitGrants.get(taskId);
    this.commitGrants.delete(taskId);
    if (!grant) {
      throw new CheckpointError('Commit preview is missing or expired. Generate it again.', 'STALE_CONFIRMATION');
    }
    const snapshot = await this.buildCommitPreview(taskId);
    const { preview } = snapshot;
    if (
      subject !== grant.preview.subject
      || subject !== preview.subject
      || JSON.stringify(preview.files) !== JSON.stringify(grant.preview.files)
    ) {
      throw new CheckpointError('Commit preview is stale. Generate it again.', 'STALE_CONFIRMATION');
    }
    if (preview.files.length === 0) throw new CheckpointError('There are no task files to commit.', 'COMMIT_FAILED');
    if (!sameRepositoryIdentity(snapshot.repository, grant.repository)) {
      throw new CheckpointError(
        'Git HEAD or branch changed after the commit preview.',
        'STALE_CONFIRMATION',
      );
    }
    for (const filePath of preview.files) await this.paths.resolveFile(projectPath, filePath);
    const currentFingerprint = await this.restoreFingerprint(projectPath, preview.files);
    if (currentFingerprint !== grant.fingerprint) {
      throw new CheckpointError('Task files changed after the commit preview.', 'STALE_CONFIRMATION');
    }
    const indexText = (await this.runner.runText(projectPath, [
      '--no-pager',
      'rev-parse',
      '--git-path',
      'index',
    ])).trim();
    if (!indexText || indexText.includes('\0')) {
      throw new CheckpointError('Git returned an unsafe index path.', 'COMMIT_FAILED');
    }
    const indexPath = path.isAbsolute(indexText) ? path.resolve(indexText) : path.resolve(projectPath, indexText);
    const gitDirText = (await this.runner.runText(projectPath, [
      '--no-pager',
      'rev-parse',
      '--absolute-git-dir',
    ])).trim();
    if (!gitDirText || gitDirText.includes('\0') || !path.isAbsolute(gitDirText)) {
      throw new CheckpointError('Git returned an unsafe metadata path.', 'COMMIT_FAILED');
    }
    const gitDir = await fs.realpath(path.resolve(gitDirText));
    if (
      path.basename(indexPath).toLocaleLowerCase() !== 'index'
      || !isContainedPath(gitDir, indexPath)
      || samePath(gitDir, indexPath)
    ) {
      throw new CheckpointError('Git returned an unexpected index path.', 'COMMIT_FAILED');
    }
    const indexBackupDir = path.join(this.snapshotRoot, 'commit-index-backups', this.randomUUID());
    const indexBackupPath = path.join(indexBackupDir, 'index');
    await fs.mkdir(indexBackupDir, { recursive: true });
    let indexExisted = true;
    try {
      const indexStat = await fs.lstat(indexPath);
      if (!indexStat.isFile() || indexStat.isSymbolicLink()) {
        throw new CheckpointError('Git index is not a safe regular file.', 'COMMIT_FAILED');
      }
      await fs.copyFile(indexPath, indexBackupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      indexExisted = false;
    }
    try {
      const preStageRepository = repositoryIdentity(await this.git.getStatus(projectPath));
      const preStageFingerprint = await this.restoreFingerprint(projectPath, preview.files);
      if (
        !sameRepositoryIdentity(preStageRepository, grant.repository)
        || preStageFingerprint !== grant.fingerprint
      ) {
        throw new CheckpointError(
          'Task files, Git HEAD, or branch changed before staging.',
          'STALE_CONFIRMATION',
        );
      }
      await this.runner.run(projectPath, [
        '--no-pager',
        '--literal-pathspecs',
        'add',
        '--all',
        '--',
        ...preview.files,
      ]);
      const postStageRepository = repositoryIdentity(await this.git.getStatus(projectPath));
      const postStageFingerprint = await this.restoreFingerprint(projectPath, preview.files);
      if (
        !sameRepositoryIdentity(postStageRepository, grant.repository)
        || postStageFingerprint !== grant.fingerprint
      ) {
        throw new CheckpointError(
          'Task files, Git HEAD, or branch changed while staging.',
          'STALE_CONFIRMATION',
        );
      }
      await this.runner.run(projectPath, [
        '--no-pager',
        '--literal-pathspecs',
        'commit',
        '--only',
        '-m',
        preview.subject,
        '--',
        ...preview.files,
      ]);
    } catch (error) {
      try {
        if (indexExisted) await fs.copyFile(indexBackupPath, indexPath);
        else await fs.unlink(indexPath).catch((restoreError: NodeJS.ErrnoException) => {
          if (restoreError.code !== 'ENOENT') throw restoreError;
        });
      } catch (restoreError) {
        throw new CheckpointError(
          `Commit failed and the Git index backup could not be restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          'COMMIT_FAILED',
        );
      }
      if (error instanceof CheckpointError) throw error;
      throw new CheckpointError(
        error instanceof Error ? error.message : 'Unable to create Git commit.',
        'COMMIT_FAILED',
      );
    } finally {
      await fs.rm(indexBackupDir, { recursive: true, force: true }).catch((error) => {
        console.error('[CheckpointManager] unable to remove Git index backup:', error);
      });
    }

    let commit: string;
    try {
      commit = (await this.runner.runText(projectPath, [
        '--no-pager',
        'rev-parse',
        'HEAD',
      ])).trim();
      if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('Git returned an invalid commit id.');
      const committedLine = (await this.runner.runText(projectPath, [
        '--no-pager',
        'rev-list',
        '--parents',
        '-n',
        '1',
        commit,
      ])).trim().split(/\s+/u);
      const expectedParents = grant.repository.head ? [grant.repository.head] : [];
      if (
        committedLine[0] !== commit
        || JSON.stringify(committedLine.slice(1)) !== JSON.stringify(expectedParents)
      ) {
        throw new Error('The created commit is not based on the previewed HEAD.');
      }
      const postCommitStatus = await this.git.getStatus(projectPath);
      if (
        postCommitStatus.head !== commit
        || postCommitStatus.branch !== grant.repository.branch
        || postCommitStatus.detached !== grant.repository.detached
      ) {
        throw new Error('Git branch identity changed while the commit was created.');
      }
    } catch (error) {
      throw new CheckpointError(
        `Commit was created, but its id could not be verified. Inspect Git history before retrying: ${error instanceof Error ? error.message : String(error)}`,
        'COMMIT_FAILED',
      );
    }
    try {
      this.persistTimelineEvent(taskId, undefined, 'git_commit_created', {
        commit,
        subject: preview.subject,
        files: preview.files,
      });
    } catch (error) {
      console.error('[CheckpointManager] unable to persist commit timeline event:', error);
    }
    this.emit({
      taskId,
      projectPath,
      action: 'committed',
      timestamp: this.now().getTime(),
    });
    return { commit, subject: preview.subject, files: preview.files };
  }

  private taskProject(taskId: string): { projectPath: string; title: string } {
    const task = this.database.getTask(taskId);
    const session = this.database.getSession(taskId);
    if (!task || !session) throw new CheckpointError('Task was not found.', 'NOT_FOUND');
    const project = this.database.getProject(task.project_id);
    if (!project || session.project_id !== project.id) {
      throw new CheckpointError('Task project was not found.', 'NOT_FOUND');
    }
    return { projectPath: project.path, title: session.title };
  }

  private async captureFile(
    root: string,
    filesPath: string,
    checkpointId: string,
    file: GitStatusFile,
    createdAt: string,
  ): Promise<CheckpointFileRow> {
    const resolved = await this.paths.resolveFile(root, file.filePath);
    try {
      const stat = await fs.lstat(resolved.absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new CheckpointError(`Cannot snapshot non-regular file: ${file.filePath}`, 'UNSAFE_FILE');
      }
      if (stat.size > this.maxSnapshotFileBytes) {
        throw new CheckpointError(`Snapshot file is too large: ${file.filePath}`, 'SNAPSHOT_LIMIT');
      }
      const destination = path.join(filesPath, snapshotName(file.filePath));
      await fs.copyFile(resolved.absolutePath, destination);
      const copiedStat = await fs.lstat(destination);
      if (!copiedStat.isFile() || copiedStat.isSymbolicLink()) {
        throw new CheckpointError(`Snapshot copy is unsafe: ${file.filePath}`, 'UNSAFE_FILE');
      }
      if (copiedStat.size > this.maxSnapshotFileBytes) {
        throw new CheckpointError(`Snapshot file is too large: ${file.filePath}`, 'SNAPSHOT_LIMIT');
      }
      const hash = await this.hashFile(destination);
      return {
        checkpoint_id: checkpointId,
        file_path: file.filePath,
        hash,
        size: copiedStat.size,
        modified_at: stat.mtime.toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        checkpoint_id: checkpointId,
        file_path: file.filePath,
        hash: ABSENT_HASH,
        size: 0,
        modified_at: createdAt,
      };
    }
  }

  private checkpointFromRow(row: CheckpointRow): StoredCheckpoint {
    const metadata = metadataFromJson(row.metadata_json);
    const statusByPath = new Map(metadata.baselineFiles.map((file) => [file.filePath, file]));
    const snapshotPath = this.safeSnapshotPath(row);
    const files = this.database.listCheckpointFiles(row.id).map<StoredCheckpointFile>((file) => {
      const status = statusByPath.get(file.file_path);
      const unknownBaseline = file.modified_at === UNKNOWN_BASELINE_MODIFIED_AT;
      const exists = file.hash !== ABSENT_HASH && !unknownBaseline;
      return {
        checkpointId: row.id,
        filePath: file.file_path,
        hash: file.hash,
        size: file.size,
        modifiedAt: file.modified_at,
        exists,
        snapshotFile: exists && snapshotPath
          ? path.join(snapshotPath, 'files', snapshotName(file.file_path))
          : null,
        status: status?.changeType ?? 'modified',
        staged: status?.staged ?? false,
        unstaged: status?.unstaged ?? false,
      };
    });
    return {
      id: row.id,
      taskId: row.task_id,
      projectPath: row.project_path,
      type: row.type as CheckpointType,
      createdAt: row.created_at,
      gitCommit: row.git_commit,
      snapshotPath,
      metadata,
      files,
    };
  }

  private publicCheckpoint(checkpoint: StoredCheckpoint): Checkpoint {
    return {
      id: checkpoint.id,
      taskId: checkpoint.taskId,
      projectPath: checkpoint.projectPath,
      type: checkpoint.type,
      createdAt: checkpoint.createdAt,
      gitCommit: checkpoint.gitCommit,
      metadata: checkpoint.metadata,
      files: checkpoint.files.map(({ snapshotFile: _snapshotFile, ...file }) => file),
    };
  }

  private requireStoredCheckpoint(id: string): StoredCheckpoint {
    const row = this.database.getCheckpoint(id);
    if (!row) throw new CheckpointError('Checkpoint was not found.', 'NOT_FOUND');
    return this.checkpointFromRow(row);
  }

  private safeSnapshotPath(row: CheckpointRow): string {
    if (!row.snapshot_path) return '';
    const candidate = path.resolve(row.snapshot_path);
    const expected = path.resolve(this.snapshotRoot, row.id);
    if (
      !isContainedPath(this.snapshotRoot, candidate)
      || samePath(candidate, this.snapshotRoot)
      || !samePath(candidate, expected)
    ) return '';
    return candidate;
  }

  private async queueTaskStartObservation(
    taskId: string,
    projectPath: string,
    filePath: string,
  ): Promise<void> {
    // Serialize by task because every observation rewrites the same manifest.
    const key = taskId;
    const previous = this.baselineObservationQueues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.recordTaskStartObservation(taskId, projectPath, filePath));
    this.baselineObservationQueues.set(key, next);
    try {
      await next;
    } finally {
      if (this.baselineObservationQueues.get(key) === next) {
        this.baselineObservationQueues.delete(key);
      }
    }
  }

  /**
   * Git status intentionally omits ignored paths. Tool events are asynchronous
   * and cannot pause Claude's write, so neither tool_started nor file_changed can
   * prove task-start bytes. Ignore identity is safe to query without reading the
   * file: ignored paths (and paths observed while ignore rules changed) receive
   * an unavailable marker; ordinary paths retain the pre-existing absent fallback.
   */
  private async recordTaskStartObservation(
    taskId: string,
    projectPath: string,
    filePath: string,
  ): Promise<void> {
    const runId = this.latestRunId(taskId);
    if (!runId) return;
    const baselineRow = this.database.listCheckpoints(taskId)
      .find((row) => (
        row.type === 'before_task'
        && metadataFromJson(row.metadata_json).runId === runId
      ));
    if (!baselineRow || !samePath(baselineRow.project_path, projectPath)) return;

    const baseline = this.checkpointFromRow(baselineRow);
    if (baseline.files.some((file) => file.filePath === filePath)) return;
    if (
      baseline.gitCommit
      && /^[a-f0-9]{7,64}$/i.test(baseline.gitCommit)
      && await this.runner.succeeds(projectPath, [
        '--no-pager',
        'cat-file',
        '-e',
        `${baseline.gitCommit}:${filePath}`,
      ])
    ) return;
    if (!await this.uncapturedBaselineRequiresUnknown(
      projectPath,
      filePath,
      baseline.gitCommit,
      baseline.metadata.baselineFiles,
    )) return;

    const unknownRow: CheckpointFileRow = {
      checkpoint_id: baseline.id,
      file_path: filePath,
      hash: ABSENT_HASH,
      size: 0,
      modified_at: UNKNOWN_BASELINE_MODIFIED_AT,
    };
    await this.persistObservedBaseline(baseline, unknownRow);
  }

  private async persistObservedBaseline(
    baseline: StoredCheckpoint,
    file: CheckpointFileRow,
  ): Promise<void> {
    if (!baseline.snapshotPath) {
      this.database.createCheckpointFile(file);
      return;
    }
    const manifestPath = path.join(baseline.snapshotPath, 'manifest.json');
    const previous = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(previous) as { files?: CheckpointFileRow[] };
    const currentFiles = Array.isArray(parsed.files) ? parsed.files : [];
    const files = [
      ...currentFiles.filter((item) => item.file_path !== file.file_path),
      file,
    ].sort((left, right) => left.file_path.localeCompare(right.file_path));
    const next = `${JSON.stringify({ ...parsed, files }, null, 2)}\n`;
    const writeManifest = async (content: string): Promise<void> => {
      const temporaryPath = path.join(
        baseline.snapshotPath,
        `.manifest-${this.randomUUID()}.tmp`,
      );
      await fs.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
      try {
        await fs.rename(temporaryPath, manifestPath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true });
        throw error;
      }
    };

    await writeManifest(next);
    try {
      this.database.createCheckpointFile(file);
    } catch (error) {
      await writeManifest(previous);
      throw error;
    }
  }

  private async collectTouchedFiles(
    taskId: string,
    projectPath: string,
    runId?: string,
  ): Promise<string[]> {
    const activeRunId = this.latestRunByTask.get(taskId);
    const touched = new Set(
      !runId || activeRunId === runId ? (this.touchedByTask.get(taskId) ?? []) : [],
    );
    for (const change of this.database.listFileChanges(taskId, { limit: 5_000, offset: 0 })) {
      if (runId && !change.id.startsWith(`${taskId}:${runId}:`)) continue;
      try {
        touched.add((await this.paths.resolveFile(projectPath, change.file_path)).gitPath);
      } catch {
        // Unsafe legacy paths are never restored.
      }
    }
    for (const checkpoint of this.listCheckpoints(taskId)) {
      if (runId && checkpoint.metadata.runId !== runId) continue;
      for (const filePath of checkpoint.metadata.touchedFiles) {
        try {
          touched.add((await this.paths.resolveFile(projectPath, filePath)).gitPath);
        } catch {
          // Unsafe checkpoint metadata is ignored.
        }
      }
      if (checkpoint.type === 'before_task') {
        const statusPaths = new Set(checkpoint.metadata.baselineFiles.map((file) => file.filePath));
        for (const file of checkpoint.files) {
          if (statusPaths.has(file.filePath)) continue;
          try {
            touched.add((await this.paths.resolveFile(projectPath, file.filePath)).gitPath);
          } catch {
            // Unsafe persisted paths are never restored.
          }
        }
      }
    }
    return uniqueSorted([...touched]);
  }

  /**
   * Reconciles the current worktree with before_task so changes made by Bash,
   * scripts, or tools without a structured file_changed event still belong to
   * the current run. Pre-existing dirty/untracked files are only included when
   * their bytes actually differ from the captured user baseline.
   */
  private async detectChangesSinceTaskStart(
    taskId: string,
    runId: string | undefined,
    projectPath: string,
    currentFiles: readonly GitStatusFile[],
  ): Promise<string[]> {
    if (!runId) return [];
    const baselineRow = this.database.listCheckpoints(taskId)
      .find((row) => {
        if (row.type !== 'before_task') return false;
        return metadataFromJson(row.metadata_json).runId === runId;
      });
    if (!baselineRow) return [];

    const baseline = this.checkpointFromRow(baselineRow);
    const baselineStatus = new Map(
      baseline.metadata.baselineFiles.map((file) => [file.filePath, file] as const),
    );
    const baselineFiles = new Map(baseline.files.map((file) => [file.filePath, file] as const));
    const currentStatus = new Map(currentFiles.map((file) => [file.filePath, file] as const));
    const candidates = uniqueSorted([
      ...baselineStatus.keys(),
      ...baselineFiles.keys(),
      ...currentStatus.keys(),
    ]);
    const changed = new Set<string>();

    for (const filePath of candidates) {
      const beforeStatus = baselineStatus.get(filePath);
      const current = currentStatus.get(filePath);
      const captured = baselineFiles.get(filePath);
      if (captured) {
        if (captured.modifiedAt === UNKNOWN_BASELINE_MODIFIED_AT) {
          changed.add(filePath);
          continue;
        }
        const currentHash = await this.currentFileHash(projectPath, filePath);
        if (currentHash !== captured.hash) changed.add(filePath);
        continue;
      }
      if (!beforeStatus) {
        if (current) changed.add(filePath);
      } else {
        changed.add(filePath);
      }
    }

    for (const file of currentFiles) {
      if (changed.has(file.filePath) && file.originalPath) changed.add(file.originalPath);
    }
    return uniqueSorted([...changed]);
  }

  private async currentFileHash(projectPath: string, filePath: string): Promise<string> {
    const resolved = await this.paths.resolveFile(projectPath, filePath);
    try {
      const stat = await fs.lstat(resolved.absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return 'unsafe';
      return this.hashFile(resolved.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ABSENT_HASH;
      throw error;
    }
  }

  private async uncapturedBaselineRequiresUnknown(
    projectPath: string,
    filePath: string,
    baselineCommit: string | null,
    baselineFiles: readonly GitStatusFile[],
  ): Promise<boolean> {
    // A task may restore a user-dirty ignore file back to HEAD before the
    // ignored user file becomes visible. Current status alone would then lose
    // the only evidence that the path may have existed before the task.
    if (hasGitIgnoreChange(baselineFiles)) return true;
    try {
      const [status, ignored] = await Promise.all([
        this.git.getStatus(projectPath),
        this.runner.succeeds(projectPath, [
          '--no-pager',
          'check-ignore',
          '--quiet',
          '--no-index',
          '--',
          filePath,
        ]),
      ]);
      if (ignored) return true;
      if (status.head !== baselineCommit) return true;
      return hasGitIgnoreChange(status.files);
    } catch {
      // Failure to prove the path is ordinary must never become permission to delete it.
      return true;
    }
  }

  private async targetKind(
    checkpoint: StoredCheckpoint,
    filePath: string,
  ): Promise<'snapshot' | 'git' | 'absent' | 'unavailable'> {
    const captured = checkpoint.files.find((file) => file.filePath === filePath);
    if (captured) {
      if (captured.modifiedAt === UNKNOWN_BASELINE_MODIFIED_AT) return 'unavailable';
      if (!captured.exists) return 'absent';
      if (!captured.snapshotFile) return 'unavailable';
      try {
        const stat = await fs.lstat(captured.snapshotFile);
        return stat.isFile() && !stat.isSymbolicLink() ? 'snapshot' : 'unavailable';
      } catch {
        return 'unavailable';
      }
    }
    if (checkpoint.gitCommit !== null && !/^[a-f0-9]{7,64}$/i.test(checkpoint.gitCommit)) {
      return 'unavailable';
    }
    if (checkpoint.gitCommit) {
      const exists = await this.runner.succeeds(checkpoint.projectPath, [
        '--no-pager',
        'cat-file',
        '-e',
        `${checkpoint.gitCommit}:${filePath}`,
      ]);
      if (exists) return 'git';
    }
    if (!usesDynamicRestoreScope(checkpoint.type)) return 'absent';
    return await this.uncapturedBaselineRequiresUnknown(
      checkpoint.projectPath,
      filePath,
      checkpoint.gitCommit,
      checkpoint.metadata.baselineFiles,
    ) ? 'unavailable' : 'absent';
  }

  private async targetContent(checkpoint: StoredCheckpoint, filePath: string): Promise<Buffer | null> {
    const kind = await this.targetKind(checkpoint, filePath);
    if (kind === 'absent') return null;
    if (kind === 'unavailable') {
      throw new CheckpointError(`Checkpoint content is unavailable: ${filePath}`, 'RESTORE_BLOCKED');
    }
    if (kind === 'git') {
      const result = await this.runner.run(checkpoint.projectPath, [
        '--no-pager',
        'show',
        `${checkpoint.gitCommit}:${filePath}`,
      ], { maxOutputBytes: this.maxSnapshotFileBytes + 64 * 1024 });
      return result.stdout;
    }
    const captured = checkpoint.files.find((file) => file.filePath === filePath);
    if (!captured?.snapshotFile) return null;
    const content = await fs.readFile(captured.snapshotFile);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    if (hash !== captured.hash) {
      throw new CheckpointError(`Checkpoint snapshot hash mismatch: ${filePath}`, 'RESTORE_BLOCKED');
    }
    return content;
  }

  private async applyCheckpoint(
    context: FileMutationContext,
    checkpoint: StoredCheckpoint,
    restoreFiles: readonly string[],
    deleteFiles: readonly string[],
  ): Promise<void> {
    const prepared = await Promise.all(restoreFiles.map(async (filePath) => ({
      filePath,
      content: await this.targetContent(checkpoint, filePath),
      resolved: await this.paths.resolveFile(checkpoint.projectPath, filePath),
    })));
    const deletions = await Promise.all(deleteFiles.map(async (filePath) => ({
      filePath,
      resolved: await this.paths.resolveFile(checkpoint.projectPath, filePath),
    })));
    for (const item of prepared) {
      if (item.content === null) continue;
      try {
        const current = await fs.lstat(item.resolved.absolutePath);
        if (!current.isFile() || current.isSymbolicLink()) {
          throw new CheckpointError(`Refusing to overwrite non-regular file: ${item.filePath}`, 'UNSAFE_FILE');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await context.writeFile(item.filePath, item.content);
    }
    for (const item of deletions) {
      try {
        const current = await fs.lstat(item.resolved.absolutePath);
        if (!current.isFile() || current.isSymbolicLink()) {
          throw new CheckpointError(`Refusing to delete non-regular file: ${item.filePath}`, 'UNSAFE_FILE');
        }
        await context.removeFile(item.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private async applicationPlan(
    checkpoint: StoredCheckpoint,
    filePaths: readonly string[],
  ): Promise<{ restoreFiles: string[]; deleteFiles: string[] }> {
    const restoreFiles: string[] = [];
    const deleteFiles: string[] = [];
    for (const filePath of uniqueSorted(filePaths)) {
      const kind = await this.targetKind(checkpoint, filePath);
      if (kind === 'absent') deleteFiles.push(filePath);
      else if (kind === 'snapshot' || kind === 'git') restoreFiles.push(filePath);
      else {
        throw new CheckpointError(`Checkpoint content is unavailable: ${filePath}`, 'RESTORE_BLOCKED');
      }
    }
    return { restoreFiles, deleteFiles };
  }

  private async assertRestorePathsSafe(projectPath: string, filePaths: readonly string[]): Promise<void> {
    const status = await this.git.getStatus(projectPath);
    const impacted = new Set(filePaths);
    const blocker = status.files.find((file) => (
      (impacted.has(file.filePath) || Boolean(file.originalPath && impacted.has(file.originalPath)))
      && (file.staged || file.changeType === 'unmerged')
    ));
    if (blocker) {
      throw new CheckpointError(
        `Restore target became staged or conflicted: ${blocker.filePath}`,
        'RESTORE_BLOCKED',
      );
    }
  }

  private async restoreFingerprint(projectPath: string, filePaths: readonly string[]): Promise<string> {
    const parts: string[] = [];
    for (const filePath of uniqueSorted(filePaths)) {
      const resolved = await this.paths.resolveFile(projectPath, filePath);
      try {
        const stat = await fs.lstat(resolved.absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          parts.push(`${filePath}:unsafe`);
        } else {
          parts.push(`${filePath}:${stat.size}:${await this.hashFile(resolved.absolutePath)}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        parts.push(`${filePath}:${ABSENT_HASH}`);
      }
    }
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
  }

  private hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  private persistTimelineEvent(
    taskId: string,
    runId: string | undefined,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.database.getSession(taskId)) return;
    const createdAt = this.now();
    const effectiveRunId = runId ?? this.latestRunId(taskId) ?? `persisted:${taskId}`;
    this.database.createEvent(
      `checkpoint:${createdAt.getTime()}:${this.randomUUID()}`,
      taskId,
      type,
      JSON.stringify({ type, runId: effectiveRunId, ...payload, timestamp: createdAt.getTime() }),
      createdAt.toISOString(),
    );
  }

  private emit(event: CheckpointChangedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[CheckpointManager] checkpoint listener failed:', error);
      }
    }
  }

  private latestRunId(taskId: string): string | undefined {
    const cached = this.latestRunByTask.get(taskId);
    if (cached) return cached;
    const persisted = this.database.listCheckpoints(taskId)
      .map((row) => metadataFromJson(row.metadata_json).runId)
      .find((runId): runId is string => Boolean(runId));
    if (persisted) this.latestRunByTask.set(taskId, persisted);
    return persisted;
  }

  private purgeExpiredGrants(): void {
    const now = this.now().getTime();
    for (const [token, grant] of this.restoreGrants) {
      if (grant.expiresAt < now) this.restoreGrants.delete(token);
    }
  }
}

export class CheckpointLifecycleCoordinator {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly enabledRuns = new Set<string>();
  private readonly editTools = new Map<string, Set<string>>();
  private readonly checkpointedEditTools = new Map<string, Set<string>>();
  private readonly testTools = new Map<string, Set<string>>();
  private readonly workflowScopes = new Map<string, string>();

  constructor(private readonly checkpoints: CheckpointManager) {}

  async beforeRun(options: ClaudeRunOptions): Promise<Checkpoint | null> {
    this.editTools.set(options.runId, new Set());
    this.checkpointedEditTools.set(options.runId, new Set());
    this.testTools.set(options.runId, new Set());
    try {
      const checkpoint = options.workflowContext
        ? await this.checkpoints.prepareWorkflowRun(options)
        : await this.checkpoints.startTask(options);
      if (options.workflowContext) {
        this.workflowScopes.set(options.runId, options.workflowContext.workflowId);
      }
      this.enabledRuns.add(options.runId);
      return checkpoint;
    } catch (error) {
      this.cleanupRun(options.runId);
      throw error;
    }
  }

  handleEvent(envelope: ClaudeEventEnvelope): void {
    if (!this.enabledRuns.has(envelope.runId)) return;
    const taskId = sessionIdFromKey(envelope.sessionKey);
    const checkpointRunId = this.workflowScopes.get(envelope.runId) ?? envelope.runId;
    const event = envelope.event;
    if (event.type === 'tool_started' && MUTATION_TOOLS.has(event.toolName)) {
      this.editTools.get(envelope.runId)?.add(event.toolUseId);
    }
    if (event.type === 'tool_started' && testCommand(event)) {
      this.testTools.get(envelope.runId)?.add(event.toolUseId);
    }
    if (event.type === 'command_started' && testCommand(event)) {
      this.testTools.get(envelope.runId)?.add(event.toolUseId);
    }

    const requestedPath = toolFilePath(event);
    if (requestedPath) {
      // Mark the edit before queueing any async work. Claude can emit tool_completed
      // immediately after file_changed; deferring this marker would enqueue a second
      // after_edit checkpoint for the same tool use.
      if (event.type === 'file_changed') {
        this.checkpointedEditTools.get(envelope.runId)?.add(event.toolUseId);
      }
      this.enqueue(envelope.runId, async () => {
        await this.checkpoints.noteTaskFile(taskId, envelope.projectKey, requestedPath);
        if (event.type === 'file_changed') {
          await this.checkpoints.createTaskCheckpoint(taskId, 'after_edit', {
            runId: checkpointRunId,
          });
        }
      });
    }

    if (event.type === 'tool_completed' || event.type === 'tool_failed') {
      const edit = this.editTools.get(envelope.runId)?.delete(event.toolUseId) ?? false;
      const alreadyCheckpointed = this.checkpointedEditTools.get(envelope.runId)?.has(event.toolUseId) ?? false;
      if (edit && !alreadyCheckpointed) {
        this.enqueue(envelope.runId, async () => {
          await this.checkpoints.createTaskCheckpoint(taskId, 'after_edit', {
            runId: checkpointRunId,
          });
        });
      }
      if (this.testTools.get(envelope.runId)?.delete(event.toolUseId)) {
        this.enqueue(envelope.runId, async () => {
          await this.checkpoints.createTaskCheckpoint(taskId, 'after_test', {
            runId: checkpointRunId,
            reason: event.type === 'tool_completed' ? 'test_passed' : 'test_failed',
          });
        });
      }
    }

    if (
      (event.type === 'session_completed' || event.type === 'session_failed')
      && !this.workflowScopes.has(envelope.runId)
    ) {
      this.enqueue(envelope.runId, async () => {
        try {
          await this.checkpoints.createTaskCheckpoint(taskId, 'task_completed', {
            runId: envelope.runId,
            reason: event.type === 'session_completed' ? 'completed' : 'failed',
          });
        } finally {
          this.cleanupRun(envelope.runId);
        }
      });
    } else if (event.type === 'session_completed' || event.type === 'session_failed') {
      this.enqueue(envelope.runId, async () => this.cleanupRun(envelope.runId));
    }
  }

  async waitForIdle(runId: string): Promise<void> {
    await this.queues.get(runId);
  }

  private enqueue(runId: string, work: () => Promise<void>): void {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous.then(work).catch((error) => {
      console.error('[CheckpointLifecycleCoordinator] checkpoint failed:', error);
    });
    let tracked: Promise<void>;
    tracked = next.finally(() => {
      if (this.queues.get(runId) === tracked) this.queues.delete(runId);
    });
    this.queues.set(runId, tracked);
  }

  private cleanupRun(runId: string): void {
    this.enabledRuns.delete(runId);
    this.editTools.delete(runId);
    this.checkpointedEditTools.delete(runId);
    this.testTools.delete(runId);
    this.workflowScopes.delete(runId);
  }
}

export const checkpointInternals = {
  ABSENT_HASH,
  metadataFromJson,
  sessionIdFromKey,
  snapshotName,
  testCommand,
  toolFilePath,
  uniqueSorted,
};
