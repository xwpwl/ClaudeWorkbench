import fs from 'node:fs';
import path from 'node:path';
import { diffLines } from 'diff';
import type { ClaudeEvent, ClaudeEventEnvelope, ClaudeRunOptions } from '../../shared/types/claude';
import type { PermissionSettlement } from '../../shared/types/permissionBroker';
import type { AppDatabase, SessionModelBinding } from '../database/Database';
import { safePathPolicy, type ResolvedProjectFile, UnsafePathError } from '../file-changes/SafePathPolicy';

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_LINES = 5_000;
const MAX_EVENT_TEXT = 20_000;

interface PendingFileSnapshot {
  sessionId: string;
  projectPath: string;
  relativePath: string;
  oldContent: string | null;
  isBinary: boolean;
}

function sessionIdFromKey(sessionKey: string): string {
  const separator = sessionKey.lastIndexOf('::');
  return separator >= 0 ? sessionKey.slice(separator + 2) : sessionKey;
}

function safeProjectFile(projectPath: string, requestedPath: string): ResolvedProjectFile | null {
  try {
    return safePathPolicy.resolveFileSync(projectPath, requestedPath);
  } catch (error) {
    if (error instanceof UnsafePathError) return null;
    throw error;
  }
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000));
  return sample.includes(0);
}

function readSnapshot(filePath: string): { content: string | null; isBinary: boolean } {
  if (!fs.existsSync(filePath)) return { content: null, isBinary: false };
  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size > MAX_SNAPSHOT_BYTES) return { content: null, isBinary: true };
  const buffer = fs.readFileSync(filePath);
  if (isProbablyBinary(buffer)) return { content: null, isBinary: true };
  const content = buffer.toString('utf8');
  if (content.split(/\r?\n/, MAX_SNAPSHOT_LINES + 1).length > MAX_SNAPSHOT_LINES) {
    return { content: null, isBinary: true };
  }
  return { content, isBinary: false };
}

function filePathFromEvent(event: ClaudeEvent): string | null {
  if (event.type === 'file_changed' || event.type === 'file_read') return event.filePath;
  if (event.type !== 'tool_started') return null;
  const input = event.input;
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'notebook_path']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key] as string;
  }
  return null;
}

function isFileMutation(event: ClaudeEvent): boolean {
  if (event.type === 'file_changed') return true;
  return event.type === 'tool_started'
    && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(event.toolName);
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]';
  if (typeof value === 'string') {
    return value.length > MAX_EVENT_TEXT ? `${value.slice(0, MAX_EVENT_TEXT)}\n[TRUNCATED]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    output[key] = /(token|secret|password|authorization|cookie|api.?key)/i.test(key)
      ? '[REDACTED]'
      : redact(nested, depth + 1);
  }
  return output;
}

function serializableEvent(event: ClaudeEvent | Record<string, unknown>, runId: string): string {
  return JSON.stringify(redact({ runId, ...event }));
}

function safeModelSelection(options: ClaudeRunOptions): Record<string, unknown> | null {
  const selection = options.resolvedModelSelection;
  if (!selection) return null;
  return {
    providerId: selection.providerId,
    providerName: selection.providerName,
    modelId: selection.modelId,
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
}

function lineStats(oldContent: string | null, newContent: string | null): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(oldContent ?? '', newContent ?? '')) {
    const lineCount = part.count ?? part.value.split(/\r?\n/).filter(Boolean).length;
    if (part.added) additions += lineCount;
    if (part.removed) deletions += lineCount;
  }
  return { additions, deletions };
}

function commandFromEvent(event: ClaudeEvent): string | null {
  if (event.type === 'command_started') return event.command;
  if (event.type !== 'tool_started' || event.toolName !== 'Bash') return null;
  if (!event.input || typeof event.input !== 'object') return null;
  const command = (event.input as Record<string, unknown>).command;
  return typeof command === 'string' ? command : null;
}

function isTestCommand(command: string): boolean {
  return /(^|\s)(npm\s+(run\s+)?test|npx\s+vitest|vitest|jest|pytest|cargo\s+test|go\s+test)(\s|$)/i.test(command);
}

export class TaskEventRecorder {
  private readonly database: AppDatabase;
  private readonly sequences = new Map<string, number>();
  private readonly fileSnapshots = new Map<string, PendingFileSnapshot>();
  private readonly testCommands = new Map<string, string>();
  private readonly workflowRuns = new Map<
    string,
    NonNullable<ClaudeRunOptions['workflowContext']>
  >();
  private readonly runModelBindings = new Map<
    string,
    Omit<SessionModelBinding, 'claudeSessionId'>
  >();

  constructor(database: AppDatabase) {
    this.database = database;
  }

  recordStart(options: ClaudeRunOptions): void {
    const sessionId = sessionIdFromKey(options.sessionKey);
    const session = this.database.getSession(sessionId);
    if (!session) return;
    const agentMode = typeof options.agentMode === 'string' ? options.agentMode : 'normal';
    const startedAt = new Date().toISOString();
    if (options.workflowContext) {
      // The workflow layer persists the structured Agent timeline. Do not copy
      // its transport prompt (which contains JSON stage input) into the legacy
      // task timeline or treat one Agent process as the whole task.
      this.workflowRuns.set(options.runId, options.workflowContext);
      if (options.resolvedModelSelection) {
        const separator = options.runId.lastIndexOf(':');
        const stageId = separator > 0 ? options.runId.slice(0, separator) : options.runId;
        this.database.attachWorkflowStepModelSelection(
          stageId,
          options.resolvedModelSelection,
        );
      }
      const task = this.database.getTask(sessionId);
      this.database.ensureTask(sessionId, session.project_id, 'running', agentMode);
      this.database.updateTask(sessionId, {
        status: 'running',
        agent_mode: agentMode,
        started_at: task?.started_at ?? startedAt,
        completed_at: null,
      });
      this.database.updateSessionMetadata(sessionId, { status: 'running' });
      return;
    }
    const selection = options.resolvedModelSelection;
    if (selection) {
      this.runModelBindings.set(options.runId, {
        providerId: selection.providerId,
        modelId: selection.modelId,
        runtimeType: selection.runtimeType,
        executionSource: selection.executionSource,
      });
    }
    this.sequences.set(options.runId, 0);
    this.database.createEvent(
      `${options.runId}:000000`,
      sessionId,
      'task_started',
      JSON.stringify(redact({
        type: 'task_started',
        runId: options.runId,
        prompt: options.prompt,
        agentMode,
        model: options.model ?? null,
        ...(options.resolvedModelSelection
          ? { modelSelection: safeModelSelection(options) }
          : {}),
        timestamp: Date.parse(startedAt),
      })),
      startedAt,
    );
    this.database.ensureTask(sessionId, session.project_id, 'starting', agentMode);
    this.database.updateTask(sessionId, {
      status: 'starting',
      agent_mode: agentMode,
      started_at: startedAt,
      completed_at: null,
      duration_ms: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      permission_count: 0,
      test_status: null,
      test_command: null,
      test_output: null,
    });
  }

  recordEvent(envelope: ClaudeEventEnvelope): void {
    const sessionId = sessionIdFromKey(envelope.sessionKey);
    const session = this.database.getSession(sessionId);
    if (!session) return;
    if (this.workflowRuns.has(envelope.runId)) {
      this.recordWorkflowTransportEvent(envelope, sessionId);
      return;
    }
    const event = envelope.event;
    const sequence = (this.sequences.get(envelope.runId) ?? 0) + 1;
    this.sequences.set(envelope.runId, sequence);
    const eventId = `${envelope.runId}:${String(sequence).padStart(6, '0')}`;

    if (!['assistant_text', 'thinking_content', 'stderr'].includes(event.type)) {
      const runBinding = event.type === 'system_init'
        ? this.runModelBindings.get(envelope.runId)
        : null;
      const persistedEvent = runBinding
        ? {
          ...event,
          modelSessionBinding: {
            claudeSessionId: event.type === 'system_init' ? event.sessionId : '',
            ...runBinding,
          } satisfies SessionModelBinding,
        }
        : event;
      this.database.createEvent(
        eventId,
        sessionId,
        event.type,
        serializableEvent(persistedEvent, envelope.runId),
        new Date(event.timestamp).toISOString(),
      );
    }

    this.captureFileLifecycle(envelope, sessionId);
    this.captureTestLifecycle(envelope, sessionId);

    if (event.type === 'session_started') {
      this.database.ensureTask(sessionId, session.project_id, 'running');
      this.database.updateTask(sessionId, {
        status: 'running',
        started_at: new Date(event.timestamp).toISOString(),
        completed_at: null,
      });
      this.database.updateSessionStatus(sessionId, 'running');
    } else if (event.type === 'system_init') {
      this.database.updateSessionMetadata(sessionId, {
        claudeSessionId: event.sessionId,
        model: event.model,
        status: 'running',
      });
    } else if (event.type === 'usage_updated') {
      this.database.updateTask(sessionId, {
        input_tokens: event.inputTokens ?? 0,
        output_tokens: event.outputTokens ?? 0,
        total_tokens: event.totalTokens ?? 0,
      });
    } else if (event.type === 'session_completed') {
      const completedAt = new Date(event.timestamp).toISOString();
      this.database.updateTask(sessionId, {
        status: 'completed',
        completed_at: completedAt,
        duration_ms: event.duration,
      });
      this.database.updateSessionMetadata(sessionId, {
        status: 'completed',
        completedAt,
      });
      this.releaseRun(envelope.runId);
    } else if (event.type === 'session_failed') {
      this.database.updateTask(sessionId, {
        status: 'failed',
        completed_at: new Date(event.timestamp).toISOString(),
        duration_ms: event.duration ?? 0,
      });
      this.database.updateSessionMetadata(sessionId, { status: 'failed' });
      this.releaseRun(envelope.runId);
    }
  }

  recordPermission(settlement: PermissionSettlement): void {
    const sessionId = sessionIdFromKey(settlement.sessionKey);
    if (!this.database.getSession(sessionId)) return;
    this.database.createPermission({
      id: settlement.requestId,
      session_id: sessionId,
      run_id: settlement.runId,
      tool_name: settlement.toolName,
      decision: settlement.cause,
      created_at: new Date(settlement.settledAt).toISOString(),
      resolved_at: new Date(settlement.settledAt).toISOString(),
    });
  }

  private captureFileLifecycle(envelope: ClaudeEventEnvelope, sessionId: string): void {
    const event = envelope.event;
    if (isFileMutation(event)) {
      const requested = filePathFromEvent(event);
      const resolved = requested ? safeProjectFile(envelope.projectKey, requested) : null;
      if (!requested || !resolved) return;
      const toolUseId = 'toolUseId' in event && typeof event.toolUseId === 'string'
        ? event.toolUseId
        : requested;
      const snapshotKey = `${envelope.runId}:${toolUseId}`;
      if (this.fileSnapshots.has(snapshotKey)) return;
      const snapshot = readSnapshot(resolved.absolutePath);
      this.fileSnapshots.set(snapshotKey, {
        sessionId,
        projectPath: resolved.projectRoot,
        relativePath: path.relative(resolved.projectRoot, resolved.absolutePath),
        oldContent: snapshot.content,
        isBinary: snapshot.isBinary,
      });
      return;
    }

    if (event.type !== 'tool_completed' && event.type !== 'tool_failed') return;
    const key = `${envelope.runId}:${event.toolUseId}`;
    const pending = this.fileSnapshots.get(key);
    if (!pending) return;
    this.fileSnapshots.delete(key);
    const resolved = safeProjectFile(pending.projectPath, pending.relativePath);
    if (!resolved) return;
    const after = readSnapshot(resolved.absolutePath);
    const existing = this.database.listFileChanges(pending.sessionId, { limit: 5_000, offset: 0 })
      .find((change) => change.file_path === pending.relativePath);
    const baseline = existing ? existing.old_content : pending.oldContent;
    const isBinary = Boolean(existing?.is_binary) || pending.isBinary || after.isBinary;
    const stats = isBinary ? { additions: 0, deletions: 0 } : lineStats(baseline, after.content);
    const changeType = baseline === null
      ? 'added'
      : after.content === null
        ? 'deleted'
        : 'modified';
    this.database.createFileChange(
      `${pending.sessionId}:${envelope.runId}:${pending.relativePath}`,
      pending.sessionId,
      pending.relativePath,
      changeType,
      stats.additions,
      stats.deletions,
      {
        oldContent: isBinary ? null : baseline,
        newContent: isBinary ? null : after.content,
        isBinary,
      },
    );
  }

  private captureTestLifecycle(envelope: ClaudeEventEnvelope, sessionId: string): void {
    const event = envelope.event;
    const command = commandFromEvent(event);
    if (command && isTestCommand(command)) {
      const toolUseId = 'toolUseId' in event ? event.toolUseId : envelope.runId;
      this.testCommands.set(`${envelope.runId}:${toolUseId}`, command);
      this.database.updateTask(sessionId, {
        test_status: 'running',
        test_command: command.slice(0, 2_000),
        test_output: null,
      });
      return;
    }
    if (event.type !== 'tool_completed' && event.type !== 'tool_failed') return;
    const key = `${envelope.runId}:${event.toolUseId}`;
    const testCommand = this.testCommands.get(key);
    if (!testCommand) return;
    this.testCommands.delete(key);
    const output = event.type === 'tool_completed'
      ? JSON.stringify(redact(event.output)).slice(0, 5_000)
      : event.error.slice(0, 5_000);
    this.database.updateTask(sessionId, {
      test_status: event.type === 'tool_completed' ? 'passed' : 'failed',
      test_command: testCommand.slice(0, 2_000),
      test_output: output,
    });
  }

  private releaseRun(runId: string): void {
    this.sequences.delete(runId);
    this.workflowRuns.delete(runId);
    this.runModelBindings.delete(runId);
    for (const key of this.fileSnapshots.keys()) {
      if (key.startsWith(`${runId}:`)) this.fileSnapshots.delete(key);
    }
    for (const key of this.testCommands.keys()) {
      if (key.startsWith(`${runId}:`)) this.testCommands.delete(key);
    }
  }

  private recordWorkflowTransportEvent(
    envelope: ClaudeEventEnvelope,
    sessionId: string,
  ): void {
    const event = envelope.event;
    this.captureFileLifecycle(envelope, sessionId);
    this.captureTestLifecycle(envelope, sessionId);
    if (event.type === 'session_started') {
      this.database.updateSessionMetadata(sessionId, { status: 'running' });
    } else if (event.type === 'system_init') {
      this.database.updateSessionMetadata(sessionId, {
        claudeSessionId: event.sessionId,
        model: event.model,
        status: 'running',
      });
    } else if (event.type === 'usage_updated') {
      const task = this.database.getTask(sessionId);
      this.database.updateTask(sessionId, {
        input_tokens: (task?.input_tokens ?? 0) + (event.inputTokens ?? 0),
        output_tokens: (task?.output_tokens ?? 0) + (event.outputTokens ?? 0),
        total_tokens: (task?.total_tokens ?? 0) + (event.totalTokens ?? 0),
      });
    } else if (event.type === 'session_completed' || event.type === 'session_failed') {
      // AgentWorkflowManager owns the workflow/task terminal state. A Planner,
      // Tester, or Reviewer process completing is only a stage boundary.
      this.releaseRun(envelope.runId);
    }
  }
}

export const taskRecorderInternals = {
  filePathFromEvent,
  isFileMutation,
  isTestCommand,
  lineStats,
  redact,
  safeProjectFile,
  sessionIdFromKey,
};
