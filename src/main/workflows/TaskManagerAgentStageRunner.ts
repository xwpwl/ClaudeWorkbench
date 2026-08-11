import crypto from 'node:crypto';
import type { ClaudeEventEnvelope, ClaudeRunOptions } from '../../shared/types/claude';
import type { TaskManager } from '../tasks/TaskManager';
import type { AgentStageRequest, AgentStageResult, AgentStageRunner } from './contracts';
import { structuredOutputSchemaForStage } from './AgentStructuredOutputSchemas';

const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_STAGE_INPUT_BYTES = 256 * 1024;
const READ_ONLY_DISALLOWED_TOOLS = Object.freeze([
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'Task',
  'Agent',
  'mcp__*',
]);

type WorkflowTaskManager = Pick<
  TaskManager,
  'runPrompt' | 'stopRun' | 'subscribe' | 'waitForRunCompletion'
>;

export interface TaskManagerAgentStageRunnerOptions {
  timeoutMs?: number;
  randomUUID?: () => string;
  resolveDisallowedTools?: (request: AgentStageRequest) => readonly string[];
  resolveRunOptions?: (
    options: ClaudeRunOptions,
  ) => ClaudeRunOptions | Promise<ClaudeRunOptions>;
  resolvePinnedRunOptions?: (
    options: ClaudeRunOptions,
    selection: NonNullable<AgentStageRequest['modelSelection']>,
  ) => ClaudeRunOptions | Promise<ClaudeRunOptions>;
}

function stagePrompt(request: AgentStageRequest): string {
  const input = JSON.stringify({ ...request.input, projectPath: '.' }, null, 2);
  if (Buffer.byteLength(input, 'utf8') > MAX_STAGE_INPUT_BYTES) {
    throw new Error('Workflow stage input exceeds the 256 KiB safety limit.');
  }
  return [
    `User goal:\n${request.prompt}`,
    'Structured workflow stage input:',
    input,
    'Return only the structured JSON requested by the system instruction; do not wrap it in Markdown.',
  ].join('\n\n');
}

function safeSystemPrompt(request: AgentStageRequest): string {
  const readOnly = request.stage === 'planner' || request.stage === 'reviewer';
  return [
    request.systemPrompt,
    `You are the ${request.agentType} agent in a persisted Workbench workflow.`,
    readOnly
      ? 'This stage is read-only. Do not modify files or run commands that change project state.'
      : 'All tools remain subject to the existing Claude Code permission policy.',
  ].join('\n');
}

function outputText(
  blocks: ReadonlyMap<string, string>,
  terminalResult: string | undefined,
): string {
  const result = terminalResult?.trim();
  if (result) return result;
  return [...blocks.values()].join('\n').trim();
}

/** Drives one workflow role through the existing TaskManager/Claude adapter stack. */
export class TaskManagerAgentStageRunner implements AgentStageRunner {
  private readonly timeoutMs: number;
  private readonly randomUUID: () => string;
  private readonly resolveDisallowedTools?: (request: AgentStageRequest) => readonly string[];
  private readonly resolveRunOptions?: TaskManagerAgentStageRunnerOptions['resolveRunOptions'];
  private readonly resolvePinnedRunOptions?:
    TaskManagerAgentStageRunnerOptions['resolvePinnedRunOptions'];

  constructor(
    private readonly tasks: WorkflowTaskManager,
    options: TaskManagerAgentStageRunnerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.resolveDisallowedTools = options.resolveDisallowedTools;
    this.resolveRunOptions = options.resolveRunOptions;
    this.resolvePinnedRunOptions = options.resolvePinnedRunOptions;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1_000) {
      throw new Error('Workflow stage timeout must be at least one second.');
    }
  }

  async runStage(request: AgentStageRequest): Promise<AgentStageResult> {
    const runId = `${request.operationId}:${this.randomUUID()}`;
    const blocks = new Map<string, string>();
    const modifiedFiles = new Set<string>();
    let terminal: ClaudeEventEnvelope['event'] | null = null;
    let settleTerminal!: (event: ClaudeEventEnvelope['event']) => void;
    const terminalEvent = new Promise<ClaudeEventEnvelope['event']>((resolve) => {
      settleTerminal = resolve;
    });
    const unsubscribe = this.tasks.subscribe((envelope) => {
      if (envelope.runId !== runId) return;
      const event = envelope.event;
      if (event.type === 'assistant_text') {
        const key = `${event.messageId ?? 'assistant'}:${event.blockIndex ?? 0}`;
        blocks.set(key, event.isSnapshot ? event.text : `${blocks.get(key) ?? ''}${event.text}`);
      } else if (event.type === 'file_changed') {
        modifiedFiles.add(event.filePath);
      } else if (event.type === 'session_completed' || event.type === 'session_failed') {
        terminal = event;
        settleTerminal(event);
      }
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Workflow ${request.stage} stage timed out.`)), this.timeoutMs);
    });
    // runPrompt may still be settling when a short test/diagnostic timeout fires.
    // Mark the timer promise as observed immediately; Promise.race below still
    // receives and propagates the same rejection once the run has started.
    void timedOut.catch(() => undefined);
    const readOnly = request.stage === 'planner' || request.stage === 'reviewer';
    const disallowedTools = [...new Set(
      [
        ...(this.resolveDisallowedTools?.(request) ?? []),
        ...(readOnly ? READ_ONLY_DISALLOWED_TOOLS : []),
      ]
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0 && tool.length <= 500 && !tool.includes('\0')),
    )].slice(0, 500);
    const unresolvedOptions: ClaudeRunOptions = {
      runId,
      taskId: request.taskId,
      projectId: request.projectId,
      projectKey: request.projectKey,
      sessionKey: request.sessionKey,
      projectPath: request.projectPath,
      prompt: stagePrompt(request),
      ...(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}),
      ...(request.model ? { model: request.model } : {}),
      // Claude CLI's `plan` permission mode returns Claude's own `{ plan: ... }`
      // envelope, which conflicts with Workbench's persisted ExecutionPlan schema.
      // Read-only stages use default permission plus an explicit mutating-tool deny
      // list, while Claude's native JSON Schema boundary controls the output shape.
      permissionMode: readOnly ? 'default' : request.permissionMode,
      agentMode: readOnly ? (request.stage === 'planner' ? 'plan' : 'review') : 'develop',
      systemPrompt: safeSystemPrompt(request),
      structuredOutputSchema: structuredOutputSchemaForStage(request.stage),
      workflowContext: request.workflowContext,
      ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    };

    try {
      let options: ClaudeRunOptions;
      if (request.modelSelection) {
        if (!this.resolvePinnedRunOptions) {
          throw new Error('A pinned Provider resolver is required for this Workflow stage.');
        }
        options = await this.resolvePinnedRunOptions(unresolvedOptions, request.modelSelection);
      } else {
        options = this.resolveRunOptions
          ? await this.resolveRunOptions(unresolvedOptions)
          : unresolvedOptions;
      }
      await this.tasks.runPrompt(options);
      const event = await Promise.race([terminalEvent, timedOut]);
      await this.tasks.waitForRunCompletion(runId);
      if (event.type === 'session_failed') throw new Error(event.error || `Workflow ${request.stage} failed.`);
      if (event.type !== 'session_completed') {
        throw new Error(`Workflow ${request.stage} ended without a terminal result.`);
      }
      const output = outputText(blocks, event.result);
      if (!output) throw new Error(`Workflow ${request.stage} returned no structured output.`);
      return {
        output,
        runId,
        modifiedFiles: [...modifiedFiles].sort(),
        ...(options.resolvedModelSelection
          ? { modelSelection: options.resolvedModelSelection }
          : {}),
      };
    } catch (error) {
      if (!terminal) {
        await this.tasks.stopRun(runId).catch(() => false);
        await this.tasks.waitForRunCompletion(runId).catch(() => undefined);
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    }
  }
}

export const taskManagerStageRunnerInternals = {
  MAX_STAGE_INPUT_BYTES,
  outputText,
  safeSystemPrompt,
  stagePrompt,
};
