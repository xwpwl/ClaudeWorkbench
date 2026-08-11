import crypto from 'node:crypto';
import type { AppDatabase, AppRunRow, RecoveryItemRow } from '../database/Database';

export interface RecoveryReport {
  appRunId: string;
  abnormalExitDetected: boolean;
  previousRunIds: string[];
  items: RecoveryItemRow[];
}

export interface CrashRecoveryLogger {
  info(category: 'app' | 'error', event: string, data?: unknown): Promise<void> | void;
  warn(category: 'app' | 'error', event: string, data?: unknown): Promise<void> | void;
  error(category: 'app' | 'error', event: string, data?: unknown): Promise<void> | void;
}

export interface CrashRecoveryManagerOptions {
  buildId: string;
  pid?: number;
  now?: () => Date;
  randomUUID?: () => string;
  logger?: CrashRecoveryLogger;
  validateResume?: (item: RecoveryItemRow) => void | Promise<void>;
  resumeWorkflow?: (workflowId: string) => void | Promise<void>;
}

export class CrashRecoveryError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_FOUND'
      | 'NOT_PENDING'
      | 'VALIDATION_UNAVAILABLE'
      | 'RESUME_UNAVAILABLE'
      | 'PREPARATION_FAILED',
  ) {
    super(message);
    this.name = 'CrashRecoveryError';
  }
}

export class CrashRecoveryManager {
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly pid: number;
  private currentRun: AppRunRow | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly options: CrashRecoveryManagerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.pid = options.pid ?? process.pid;
  }

  async beginAppRun(): Promise<RecoveryReport> {
    if (this.currentRun) {
      return {
        appRunId: this.currentRun.id,
        abnormalExitDetected: false,
        previousRunIds: [],
        items: this.database.listRecoveryItems(),
      };
    }
    const detectedAt = this.now().toISOString();
    const previousRuns = this.database.listUncleanAppRuns();
    let items: RecoveryItemRow[] = [];
    if (previousRuns.length > 0) {
      for (const previous of previousRuns) {
        items = this.database.reconcileCrashState(previous.id, detectedAt);
      }
    } else {
      // A v0.9/v1-v3 profile has no app-run journal. Reconcile any active rows
      // once during its first v1.0 startup, without inventing a previous run.
      items = this.database.reconcileCrashState(null, detectedAt);
    }
    const run: AppRunRow = {
      id: this.randomUUID(),
      pid: this.pid,
      build_id: this.options.buildId,
      started_at: detectedAt,
      heartbeat_at: detectedAt,
      shutdown_started_at: null,
      clean_shutdown_at: null,
      status: 'running',
    };
    this.database.createAppRun(run);
    this.currentRun = run;
    await this.options.logger?.info('app', 'recovery.app_run_started', {
      appRunId: run.id,
      abnormalExitDetected: previousRuns.length > 0,
      previousRunCount: previousRuns.length,
      recoveryItemCount: items.length,
    });
    return {
      appRunId: run.id,
      abnormalExitDetected: previousRuns.length > 0,
      previousRunIds: previousRuns.map((previous) => previous.id),
      items,
    };
  }

  get appRunId(): string | null {
    return this.currentRun?.id ?? null;
  }

  heartbeat(): void {
    if (!this.currentRun) return;
    const timestamp = this.now().toISOString();
    this.database.updateAppRun(this.currentRun.id, { heartbeat_at: timestamp });
    this.currentRun = { ...this.currentRun, heartbeat_at: timestamp };
  }

  listRecoveryItems(): RecoveryItemRow[] {
    return this.database.listRecoveryItems();
  }

  async resume(itemId: string): Promise<RecoveryItemRow> {
    const item = this.requirePending(itemId);
    if ((item.kind === 'workflow' || item.kind === 'mutation') && !this.options.validateResume) {
      throw new CrashRecoveryError(
        'Recovery resume requires checkpoint and fingerprint validation.',
        'VALIDATION_UNAVAILABLE',
      );
    }
    await this.options.validateResume?.(item);
    if (item.kind === 'workflow') {
      if (!this.options.resumeWorkflow) {
        throw new CrashRecoveryError('Workflow resume is unavailable.', 'RESUME_UNAVAILABLE');
      }
      const prepared = this.database.prepareWorkflowRecoveryResume(item.id, this.now().toISOString());
      if (!prepared) {
        throw new CrashRecoveryError('Workflow recovery could not be prepared safely.', 'PREPARATION_FAILED');
      }
      await this.options.resumeWorkflow(item.resource_id);
    } else if (item.kind === 'task' && item.task_id) {
      // Resuming a plain task only makes the persisted session available for a
      // new user prompt. It never replays the previous Claude invocation.
      this.database.updateTask(item.task_id, { status: 'idle', completed_at: null });
      this.database.updateSessionMetadata(item.session_id ?? item.task_id, {
        status: 'idle',
        completedAt: null,
      });
    }
    const resolved = this.database.resolveRecoveryItem(
      item.id,
      'resumed',
      { explicitUserAction: true, resourceId: item.resource_id },
      this.now().toISOString(),
    );
    if (!resolved) throw new CrashRecoveryError('Recovery item disappeared.', 'NOT_FOUND');
    if (item.task_id) this.resolveRelatedTaskItems(item.task_id, item.id, 'resumed');
    await this.options.logger?.info('app', 'recovery.item_resumed', {
      itemId: item.id,
      kind: item.kind,
      resourceId: item.resource_id,
    });
    return resolved;
  }

  async abandon(itemId: string): Promise<RecoveryItemRow> {
    const item = this.requirePending(itemId);
    const resolved = this.database.abandonRecoveryItem(item.id, this.now().toISOString());
    if (!resolved) throw new CrashRecoveryError('Recovery item disappeared.', 'NOT_FOUND');
    if (item.task_id) this.resolveRelatedTaskItems(item.task_id, item.id, 'abandoned');
    await this.options.logger?.info('app', 'recovery.item_abandoned', {
      itemId: item.id,
      kind: item.kind,
      resourceId: item.resource_id,
    });
    return resolved;
  }

  beginShutdown(): void {
    if (!this.currentRun) return;
    const timestamp = this.now().toISOString();
    this.database.updateAppRun(this.currentRun.id, {
      status: 'shutting_down',
      shutdown_started_at: timestamp,
      heartbeat_at: timestamp,
    });
    this.currentRun = {
      ...this.currentRun,
      status: 'shutting_down',
      shutdown_started_at: timestamp,
      heartbeat_at: timestamp,
    };
  }

  async markCleanShutdown(): Promise<void> {
    if (!this.currentRun) return;
    const timestamp = this.now().toISOString();
    this.database.checkpointWal();
    this.database.updateAppRun(this.currentRun.id, {
      status: 'clean',
      clean_shutdown_at: timestamp,
      heartbeat_at: timestamp,
    });
    this.currentRun = {
      ...this.currentRun,
      status: 'clean',
      clean_shutdown_at: timestamp,
      heartbeat_at: timestamp,
    };
    await this.options.logger?.info('app', 'recovery.clean_shutdown', { appRunId: this.currentRun.id });
  }

  private requirePending(itemId: string): RecoveryItemRow {
    const item = this.database.getRecoveryItem(itemId);
    if (!item) throw new CrashRecoveryError('Recovery item was not found.', 'NOT_FOUND');
    if (item.status !== 'pending') {
      throw new CrashRecoveryError('Recovery item is already resolved.', 'NOT_PENDING');
    }
    return item;
  }

  private resolveRelatedTaskItems(
    taskId: string,
    exceptId: string,
    status: 'resumed' | 'abandoned',
  ): void {
    for (const related of this.database.listRecoveryItems()) {
      if (related.id === exceptId || related.task_id !== taskId) continue;
      this.database.resolveRecoveryItem(
        related.id,
        status,
        { relatedRecoveryItem: exceptId, explicitUserAction: true },
        this.now().toISOString(),
      );
    }
  }
}
